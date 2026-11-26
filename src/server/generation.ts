import { type GenerationJob, type GenerationRequest, type Profile, type JobFit, type Narrative, type Field, type Artifact, type Unchecked, forRole } from "../shared/model";
import { publicPostingUrl } from "../shared/matching";
import { AsyncLocalStorage } from "node:async_hooks";
import { type Posting, fetchPosting, fetchPostingPage } from "./posting";
import { type Store, type Config } from "./store";
import { type Tailor, type TailoringPlan, type TailoredDocuments, buildTailored } from "./job-apply";
import { type AnswerWriter, type WrittenAnswers, shortLabel, skillContext, applicationQuestion, writerQuestions } from "./answers";
import { type Verifier, verifier, type Draft, checkers, withoutSpans, sentences } from "./verify";
import { type FitAssessor, assessJobFit, unknownFit } from "./job-fit";
import { type FieldFallbackWriter, writeFieldFallback } from "./field-fallback";
import { randomUUID, createHash } from "node:crypto";
import { transcriptArtifacts, transcriptsFolder, renderArtifacts } from "./documents";
import { TailoringProgress } from "./tailoring-progress";
import { expectedGraduation } from "../shared/education";
import { join, resolve } from "node:path";
import { copyFile } from "node:fs/promises";
import { exportDocuments } from "./export";
import { CHECKING_BUDGET_MS, Generate, callBudget, remember } from "./completion";
import { defaultAnswer, defaultTailor, provider } from "./draft-letter";
import { DraftRequest, UNRANKED, answeredRecord, distinctWarnings, documentsKey, foundInProfile, leansOnCutText, namesNoDuration, narrativeField, postingReadable, questionKey, wantsLetter } from "./draft-checks";
export * from "./draft-checks";
export * from "./draft-letter";
export * from "./completion";

// The drafts of the job in hand no second model checked, and why: kept by
// checkDrafts across all its calls (a draft checked later is taken off), and
// read when the job's narrative is written.
type CheckReason = Unchecked["reason"];
const draftChecks = new AsyncLocalStorage<Map<string, CheckReason>>();
const noteUnchecked = (ids: string[], reason: CheckReason) => {
  const record = draftChecks.getStore();
  for (const id of ids) record?.set(id, reason);
};
const noteChecked = (ids: string[]) => {
  const record = draftChecks.getStore();
  for (const id of ids) record?.delete(id);
};
// The worst reason first: a failed check, then none to check with, then the
// applicant's own Fast setting.
export function uncheckedSummary(record = draftChecks.getStore()): Unchecked | undefined {
  if (!record?.size) return undefined;
  const reasons = new Set(record.values());
  const reason: CheckReason = reasons.has("failed") ? "failed" : reasons.has("no-second-model") ? "no-second-model" : "fast";
  return { reason, drafts: [...record.keys()].slice(0, 80) };
}

export class GenerationQueue {
  private pending: {
    job: GenerationJob;
    request: GenerationRequest;
    profile: Profile;
  }[] = [];
  private running = new Map<string, AbortController>();
  // The postings read and fits checked, for the applications worked on
  // lately: the oldest go once there are CACHE_LIMIT, as the backend may run
  // for weeks. A posting or fit no longer here is read or checked again.
  private postings = new Map<string, Posting>();
  private fits = new Map<string, JobFit>();
  private tasks = new Map<string, Promise<void>>();
  constructor(
    private store: Store,
    private config: Config,
    private generate: Generate = provider(config),
    private tailor: Tailor = defaultTailor(config),
    // Application questions answered the way /job-apply answers them.
    private answer: AnswerWriter = defaultAnswer(config),
    // The job posting behind the application's URLs (posting.ts).
    private lookupPosting: (urls: string[], signal: AbortSignal) => Promise<Posting | undefined> = (
      urls,
      signal,
    ) => (config.postingLookup ? fetchPosting(urls, { signal }) : Promise.resolve(undefined)),
    // A second model's reading of the drafts (verify.ts). Unset: whatever
    // the settings provide when the drafts are checked, so a checker added
    // in Settings works from the next draft, without a restart.
    private verify?: Verifier,
    // A posting page the applicant linked that no ATS endpoint covers.
    private readPostingPage: (url: string, signal: AbortSignal) => Promise<Posting | undefined> = (url, signal) =>
      fetchPostingPage(url, { signal }),
    private assessFit: FitAssessor = assessJobFit(config),
    private fieldFallback: FieldFallbackWriter = (request, profile, signal) =>
      writeFieldFallback(config, request, profile, signal),
  ) {}
  async enqueue(request: GenerationRequest) {
    const profile = this.store.data.profile;
    if (!profile.confirmed || !profile.facts.length)
      throw new Error("Confirm a profile with at least one fact first.");
    if (request.profileRevision !== profile.revision)
      throw new Error("Profile changed. Retry this application.");
    const existing = this.store.data.jobs.find(
      (j) =>
        j.applicationId === request.applicationId &&
        j.operation === request.operation &&
        (j.purpose || "application") === (request.purpose || "application"),
    );
    if (existing) return existing;
    const job: GenerationJob = {
      id: randomUUID(),
      purpose: request.purpose || "application",
      applicationId: request.applicationId,
      operation: request.operation,
      profileRevision: profile.revision,
      documentsKey: documentsKey(profile),
      status: "queued",
      artifacts: [],
      createdAt: Date.now(),
    };
    this.store.data.jobs.push(job);
    await this.store.save();
    this.pending.push({ job, request, profile: structuredClone(profile) });
    this.pump();
    return job;
  }
  async cancel(id: string) {
    const job = this.store.data.jobs.find((j) => j.id === id);
    if (!job) return;
    this.running.get(id)?.abort();
    if (job.status !== "complete") {
      job.status = "cancelled";
      await this.store.save();
    }
    this.pending = this.pending.filter((p) => p.job.id !== id);
  }
  async cancelAll() {
    for (const job of this.store.data.jobs)
      if (["queued", "running"].includes(job.status)) await this.cancel(job.id);
    await Promise.allSettled([...this.tasks.values()]);
  }
  configure(concurrency: number) {
    this.config.generationConcurrency = concurrency;
    this.pump();
  }
  private pump() {
    while (
      this.running.size < this.config.generationConcurrency &&
      this.pending.length
    ) {
      const task = this.pending.shift()!;
      if (task.job.status !== "queued") continue;
      const controller = new AbortController();
      this.running.set(task.job.id, controller);
      // Its model requests counted against the limit, wherever they are made.
      const completion = draftChecks.run(new Map(), () => callBudget.run({ used: 0, limit: this.config.draftCallLimit }, () => this.execute(task, controller))).finally(() => {
        this.running.delete(task.job.id);
        this.tasks.delete(task.job.id);
        this.pump();
      });
      this.tasks.set(task.job.id, completion);
      void completion.catch(() => { /* the failure is reported by the job itself: this only stops an unhandled rejection */ });
    }
  }
  // The posting the applicant gave for this application, if any: pasted
  // text, or a link an ATS publishes the posting at. A link to any other page
  // is read as a page only after the form's own ATS (below).
  private async givenPosting(request: GenerationRequest, signal: AbortSignal): Promise<Posting | undefined> {
    const text = request.postingText?.trim();
    if (text && text.length >= 100)
      return { source: "Pasted", title: request.title, company: request.company, description: text.slice(0, 25_000) };
    if (!request.postingUrl) return;
    return fetchPosting([publicPostingUrl(request.postingUrl)], { signal }).catch(() => undefined);
  }
  private async jobFit(request: GenerationRequest, profile: Profile, signal: AbortSignal, graduation?: string): Promise<JobFit> {
    const key = createHash("sha256").update(JSON.stringify([
      request.applicationId, request.title, request.company, request.description, profile.revision, graduation,
    ])).digest("hex");
    const cached = this.fits.get(key);
    if (cached && request.purpose !== "fit") return cached;
    const fit = await this.assessFit(request, profile, signal, { graduation }).catch(() =>
      unknownFit(profile, "Job fit could not be assessed right now. Check fit again when the AI service is available."),
    );
    if (!signal.aborted && fit.verdict !== "unknown") remember(this.fits, key, fit);
    return fit;
  }
  // The answers a check threw out, by field, with why: the writer's own
  // claim check ("mentioned X, which your profile…") and the second model's
  // faults. A question the writer chose to skip is not among them.
  private rejectedAnswers(
    request: GenerationRequest,
    written: WrittenAnswers,
    kept: Narrative["answers"],
    warnings: string[],
  ): Record<string, string> {
    const rejected: Record<string, string> = {};
    const why = (fieldId: string) => {
      const field = request.fields.find((candidate) => candidate.id === fieldId);
      const left = field && warnings.find((warning) => warning.startsWith(`Left "${shortLabel(field.label)}" for you: `));
      return left?.slice(left.indexOf(" for you: ") + 10);
    };
    for (const id of written.withheld)
      if (/^the drafted answer mentioned /u.test(written.reasons?.[id] || "")) rejected[id] = written.reasons![id];
    for (const answer of written.answers)
      if (!kept.some((other) => other.fieldId === answer.fieldId))
        rejected[answer.fieldId] = why(answer.fieldId) || "a claim in it is not in the profile";
    return rejected;
  }
  // One more attempt at those answers, the writer told why each was not
  // used. Without it the applicant found empty boxes, chose Fill this step
  // again, and got the answers the second time: that click was this retry.
  // What still fails is left for them, with the second attempt's reason.
  // How long a generation may spend checking drafts, both rounds together
  //: the checking model slowed to its per-draft limit,
  // the fill showed nothing for five minutes, and the applicant gave up.
  // Past it, what is unchecked stays unchecked and the card says so.
  private checkingDeadlines = new WeakMap<AbortSignal, AbortSignal>();
  private checkingDeadline(signal: AbortSignal) {
    let deadline = this.checkingDeadlines.get(signal);
    if (!deadline) this.checkingDeadlines.set(signal, (deadline = AbortSignal.timeout(CHECKING_BUDGET_MS)));
    return deadline;
  }
  private async secondAttempt(
    request: GenerationRequest,
    profile: Profile,
    rejected: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ written: WrittenAnswers; answers: Narrative["answers"]; warnings: string[]; fields: Field[] } | undefined> {
    const ids = Object.keys(rejected);
    if (!ids.length || signal.aborted || this.checkingDeadline(signal).aborted) return;
    try {
      const again = await this.answer({ ...request, questionIds: ids }, profile, signal, rejected);
      const checked = await this.checkDrafts(request, profile, { written: again }, signal);
      return {
        written: again,
        answers: checked.written?.answers || [],
        warnings: [...again.warnings, ...checked.warnings],
        fields: request.fields.filter((field) => ids.includes(field.id)),
      };
    } catch {
      signal.throwIfAborted();
      // The first attempt's reasons stand.
    }
  }
  // The answers the check rejected, drafted once more with its reasons, and
  // added to those that stood; the warnings say what is still left.
  private async retryRejected(
    request: GenerationRequest,
    profile: Profile,
    written: WrittenAnswers,
    answers: Narrative["answers"],
    warnings: string[],
    signal: AbortSignal,
  ) {
    const retried = await this.secondAttempt(request, profile, this.rejectedAnswers(request, written, answers, warnings), signal);
    return retried
      ? { answers: [...answers, ...retried.answers], warnings: [...this.withoutRetried(warnings, retried.fields), ...retried.warnings] }
      : { answers, warnings };
  }
  // Warnings without the first attempt's "Left …" lines for the questions
  // tried again; the second attempt's own lines say what is still left.
  private withoutRetried(warnings: string[], fields: Field[]) {
    const labels = fields.map((field) => `Left "${shortLabel(field.label)}" for you: `);
    return warnings.filter((warning) => !labels.some((label) => warning.startsWith(label)));
  }
  // The applicant's transcript goes with every application's documents, for
  // a form that asks for one.
  private transcripts(request: Pick<GenerationRequest, "applicationId" | "operation">) {
    return transcriptArtifacts(
      this.store.directory,
      [transcriptsFolder(this.config.transcriptsDir, this.store.directory)],
      request,
      this.store.data.profile,
    ).catch(() => [] as Artifact[]);
  }
  // The verifier's reading applied: an answer with an unsupported claim, or
  // one that talks to the applicant, is left for them; a letter or answer
  // sentence holding an unsupported claim or saying nothing is taken out; a
  // summary with an unsupported claim gives way to the resume's own. When
  // the verifier cannot answer, the drafts stand and the card says so.
  private async checkDrafts(
    request: GenerationRequest,
    profile: Profile,
    drafts: { narrative?: Narrative; plan?: TailoringPlan; written?: WrittenAnswers },
    signal: AbortSignal,
  ): Promise<{ narrative?: Narrative; written?: WrittenAnswers; warnings: string[] }> {
    const { narrative, plan, written } = drafts;
    const warnings: string[] = [];
    const verify = this.config.checking === "fast" ? undefined : this.verify ?? verifier(this.config);
    const asked = (fieldId: string) => request.fields.find((field) => field.id === fieldId)?.label;
    const label = (fieldId: string) => shortLabel(asked(fieldId) || "a question");
    const items: Draft[] = [
      ...(narrative?.answers || written?.answers || []).map((answer) => ({
        id: `answer:${answer.fieldId}`,
        kind: "answer" as const,
        // Whole: cut at 80 characters, "…please briefly describe your C++
        // experience" reached the verifier without what it asks about.
        question: (asked(answer.fieldId) || "a question").slice(0, 600),
        ...(written?.sources[answer.fieldId] ? { source: written.sources[answer.fieldId] } : {}),
        draftedWith: written?.providers?.[answer.fieldId] || narrative?.draftedWith,
        text: answer.value,
      })),
      // The first paragraph is the greeting, which is ours.
      ...(narrative?.coverLetter.slice(1) || []).map((paragraph, i) => ({
        id: `letter:${i + 1}`,
        kind: "letter" as const,
        draftedWith: narrative?.draftedWith,
        text: paragraph.text,
      })),
      ...(plan?.brief.summary_line
        ? [{ id: "summary", kind: "summary" as const, draftedWith: plan.draftedWith, text: plan.brief.summary_line }]
        : []),
    ];
    // Fast checking, or no model but the one that wrote them. Not a warning
    // on every application (Settings → Drafting → Checking says so while it
    // lasts, secondCheckAvailable in verify.ts): the drafts are marked
    // unchecked, which the card and the answers show.
    if (!verify) {
      noteUnchecked(items.map((item) => item.id), this.config.checking === "fast" ? "fast" : "no-second-model");
      return { narrative, written, warnings };
    }
    const independent = items.filter((item) => checkers(this.config, item.draftedWith).length);
    noteUnchecked(items.filter((item) => !independent.includes(item)).map((item) => item.id), "no-second-model");
    if (independent.length < items.length) warnings.push("No other model in your Drafting order could check some drafts, so they need your review without a second model check.");
    items.splice(0, items.length, ...independent);
    if (!items.length) return { narrative, written, warnings };
    const graduation = expectedGraduation(profile.education)?.slice(0, 7);
    let profileText = [
      ...profile.facts.map((fact) => `- ${fact.text}`),
      ...(graduation ? [`- Expected graduation for this application: ${graduation}.`] : []),
    ].join("\n");
    if (this.config.tailorDir) {
      const context = await skillContext(this.config.tailorDir).catch(() => undefined);
      // The facts under their own heading: after profile.md's last section
      // they read as part of it, and a profile ending in "## Known gaps"
      // made every fact a gap (evidenceEntries, verify.ts).
      if (context) {
        const preferences = items.some((item) => item.kind === "answer") ? context.preferences : "";
        profileText = [context.profile, preferences, `## Confirmed facts\n${profileText}`].filter(Boolean).join("\n\n");
      }
    }
    let verdicts;
    try {
      // The job applied for is the posting's too: one employer's "What full
      // time job(s) are you applying for?" lost its own answer, the job's
      // title, as found nowhere in the profile.
      const posting = [request.title ? `Job title: ${request.title}` : "", request.description].filter(Boolean).join("\n");
      verdicts = await verify(items, { profile: profileText, posting }, signal, this.checkingDeadline(signal));
    } catch (error) {
      signal.throwIfAborted();
      noteUnchecked(items.map((item) => item.id), "failed");
      warnings.push(
        `A second model could not check these drafts against your profile (${(error as Error).message}), so read the answers and letter before submitting.`.slice(0, 350),
      );
      return { narrative, written, warnings };
    }
    noteUnchecked(items.filter((item) => !verdicts.has(item.id)).map((item) => item.id), "failed");
    noteChecked(items.filter((item) => verdicts.has(item.id)).map((item) => item.id));
    const unchecked = items.filter((item) => !verdicts.has(item.id)).length;
    if (unchecked)
      warnings.push(
        `A second model could not check ${unchecked === 1 ? "one draft" : `${unchecked} drafts`} against your profile, so read the answers and letter before submitting.`,
      );
    // Answers, once. A sentence the verifier faults comes out, as in the
    // letter; an answer that loses more than half of itself that way, or
    // talks to the applicant, is left for them.
    const answerList = narrative?.answers || written?.answers || [];
    // The literal profile text outranks the checking model, within limits: a
    // claim whose every named tool or product one profile entry names, with
    // nothing added that only the entry's words could vouch for, is not an
    // invention (namedInOneEntry, verify.ts).
    for (const answer of answerList) {
      const id = `answer:${answer.fieldId}`;
      const verdict = verdicts.get(id);
      if (!verdict?.unsupported.length) continue;
      const stands = verdict.unsupported.filter((span) => !foundInProfile(span, profileText));
      if (stands.length !== verdict.unsupported.length) verdicts.set(id, { ...verdict, unsupported: stands });
    }
    const faults = new Map<string, string>();
    for (const answer of answerList) {
      const verdict = verdicts.get(`answer:${answer.fieldId}`);
      if (!verdict) continue;
      if (verdict.addressesReader)
        faults.set(answer.fieldId, "the draft talked about what your profile or the posting covers instead of answering, so it is yours to write");
      else if (verdict.unsupported.length)
        faults.set(
          answer.fieldId,
          // What happened first, then the evidence: the line is cut to
          // fit the card, and a list of quotes alone read as no reason.
          `the checking model did not find in your profile what the draft said: ${verdict.unsupported.slice(0, 2).map((span) => `"${span.length > 55 ? `${span.slice(0, 55).replace(/\s+\S*$/u, "")}…` : span}"`).join(", ")}${verdict.unsupported.length > 2 ? ` and ${verdict.unsupported.length - 2} more` : ""}`,
        );
    }
    // A verifier that faults every answer is telling about itself, not the
    // drafts: they stand, and the card says to read them. Two or three
    // answers all faulted is no such sign (a form with one essay and one
    // short question had its essay filled unchecked or left empty by whether
    // the short one was drafted).
    const massAnswers = answerList.length >= 4 && faults.size === answerList.length;
    if (massAnswers) {
      faults.clear();
      warnings.push("A second model questioned every answer, which points at the check rather than the answers. Read them before submitting.");
    }
    const answers: Narrative["answers"] = [];
    for (const answer of answerList) {
      const fault = faults.get(answer.fieldId);
      const verdict = verdicts.get(`answer:${answer.fieldId}`);
      const filler = verdict?.filler || [];
      let leaning = "";
      let value = fault ? "" : filler.length ? withoutSpans(answer.value, filler).text : answer.value;
      if (fault && verdict && !verdict.addressesReader) {
        // Every faulted claim has to be in a sentence that came out: what
        // stays holds only what the check accepted.
        const total = sentences(answer.value).length;
        const trimmed = withoutSpans(answer.value, [...verdict.unsupported, ...filler]);
        const gone = withoutSpans(answer.value, verdict.unsupported).removed;
        const allOut = verdict.unsupported.every((span) => withoutSpans(answer.value, [span]).removed.length > 0);
        if (trimmed.text && gone.length && allOut && trimmed.removed.length * 2 <= total && leansOnCutText(trimmed.text)) {
          // What is left would read as a continuation of what came out.
          leaning = `taking out what the checking model did not find in your profile left a sentence that leans on the cut text ("${gone[0].slice(0, 60)}")`;
        } else if (trimmed.text && gone.length && allOut && trimmed.removed.length * 2 <= total) {
          value = trimmed.text;
          warnings.push(
            `Took ${gone.length === 1 ? "a sentence" : `${gone.length} sentences`} out of your answer to "${label(answer.fieldId)}" that the checking model did not find in your profile: "${gone[0].slice(0, 110)}"${gone.length > 1 ? " and more" : ""}. Add it back in your own words if it is true.`.slice(0, 350),
          );
        }
      }
      const countless = Boolean(value) && namesNoDuration(asked(answer.fieldId) || "", value);
      if (value && !countless) answers.push({ ...answer, value });
      else if (countless) warnings.push(`Left "${label(answer.fieldId)}" for you: the answer gave no number of years, so it is yours to say.`.slice(0, 350));
      else warnings.push(`Left "${label(answer.fieldId)}" for you: ${leaning || fault || "the draft said nothing on its own"}.`.slice(0, 350));
    }
    let checkedNarrative = narrative && { ...narrative, answers };
    if (narrative && checkedNarrative) {
      const removed: string[] = [];
      // Opening sentences kept for the applicant to check: taken out, the
      // rest of the paragraph began mid-thought ("Delivery is hybrid
      // push/pull, …" without the project it was about, Tesla).
      const held: string[] = [];
      // Every sentence the check faulted, taken out or not.
      let faulted = 0;
      const body = narrative.coverLetter.slice(1);
      const total = body.reduce((count, paragraph) => count + sentences(paragraph.text).length, 0);
      const checkedBody = body.flatMap((paragraph, i) => {
        const verdict = verdicts.get(`letter:${i + 1}`);
        if (!verdict) return [paragraph];
        const opening = sentences(paragraph.text)[0];
        // Saying which role this is for is the letter's purpose, not a claim
        // the profile could hold, whichever way the check faulted it ("I am
        // applying for the Data Analyst Intern role at …" was held for the
        // applicant to check on every letter).
        const namesRole = Boolean(opening) && /^\s*(?:i am|i'm)\s+(?:applying|writing to apply)\s+(?:for|to)\b/iu.test(opening);
        const faults = [...verdict.unsupported, ...verdict.filler].filter((span) => !namesRole || !(opening.includes(span) || span.includes(opening)));
        const result = withoutSpans(paragraph.text, faults);
        faulted += result.removed.length;
        if (result.text && opening && result.removed.includes(opening)) {
          held.push(opening);
          return [paragraph];
        }
        removed.push(...result.removed);
        return result.text ? [{ ...paragraph, text: result.text }] : [];
      });
      const questioned = faulted;
      if (total && questioned * 3 > total)
        // Over a third of a letter is the check's doing, not the letter's.
        warnings.push(
          `A second model questioned ${questioned} of the cover letter's ${total} sentences, which points at the check rather than the letter, so it was kept as written. Read it before submitting.`,
        );
      else if (held.length)
        warnings.push(
          `Kept ${held.length === 1 ? "a paragraph" : `${held.length} paragraphs`} of the cover letter whole whose opening the checking model did not find in your profile: "${held[0].slice(0, 120)}"${held.length > 1 ? " and more" : ""}. Taking it out would have left the rest without its subject. Check it before submitting.`.slice(0, 350),
        );
      if (total && questioned * 3 > total) {
        // Kept as written (above).
      } else if (removed.length) {
        warnings.push(
          `Took ${removed.length === 1 ? "a sentence" : `${removed.length} sentences`} out of the cover letter that your profile does not support: "${removed[0].slice(0, 120)}"${removed.length > 1 ? " and more" : ""}.`.slice(0, 350),
        );
        // A greeting alone is no letter: none goes out.
        checkedNarrative.coverLetter = checkedBody.length ? [narrative.coverLetter[0], ...checkedBody] : [];
        if (!checkedBody.length) warnings.push("No cover letter was attached: nothing in the draft held up against your profile.");
      }
    }
    const summary = verdicts.get("summary");
    if (plan && summary?.unsupported.length) {
      delete plan.brief.summary_line;
      warnings.push(
        `Kept your resume's own summary: the tailored one claimed ${summary.unsupported.map((span) => `"${span.slice(0, 60)}"`).join(", ")}, which your profile does not say.`.slice(0, 350),
      );
    }
    return {
      narrative: checkedNarrative,
      written: written && { ...written, answers: narrative ? written.answers : answers },
      warnings,
    };
  }
  private async execute(
    {
      job,
      request,
      profile,
    }: { job: GenerationJob; request: GenerationRequest; profile: Profile },
    controller: AbortController,
  ) {
    const started = Date.now();
    // Milliseconds each stage took, logged once per job (no applicant data).
    const stages: Record<string, number> = {};
    let mark = started;
    const lap = (stage: string) => {
      stages[stage] = Date.now() - mark;
      mark = Date.now();
    };
    job.status = "running";
    let progress: TailoringProgress | undefined;
    try {
      await this.store.save();
      if (request.purpose === "field-fallback") {
        // Use the saved override selected by the same titles as Fill.
        const result = await this.fieldFallback(
          request,
          forRole(profile, request.roleTitle || request.title),
          controller.signal,
        );
        job.fieldDrafts = result.drafts;
        job.warnings = [...new Set(result.warnings)].slice(0, 10);
        controller.signal.throwIfAborted();
        if (this.store.data.profile.revision !== profile.revision)
          throw new Error("Profile changed. Ask AI to review the fields again.");
        job.status = "complete";
        return;
      }
      // A slot already holding a file (Oracle's "Remove Cover Letter") has
      // no file field, but the page still names it.
      const letter = wantsLetter(request.fields) || /\bcover.?letter\b/i.test(request.description);
      // The job posting itself, when its ATS publishes it: documents and
      // answers are tailored from it, not from an application form's text.
      // Read once per application; every later step uses the same posting.
      // The applicant's own copy of the posting comes first: pasted text,
      // then their link (through its ATS's endpoint, else the page itself).
      // The form's own ATS posting comes before a linked page read as HTML:
      // the page an application was opened from can be a list of hundreds
      // of jobs (Simplify's internships on GitHub), and read as the posting
      // it titled the job "GitHub - SimplifyJobs/Summer2027-Internships" and
      // left the letter nothing to answer (Oracle).
      const given = await this.givenPosting(request, controller.signal);
      const posting =
        given ??
        (!request.postingUrl && !request.postingText ? this.postings.get(request.applicationId) : undefined) ??
        (await this.lookupPosting(
          [request.url, ...(request.pageUrls || [])],
          controller.signal,
        ).catch(() => undefined)) ??
        (request.postingUrl ? await this.readPostingPage(publicPostingUrl(request.postingUrl), controller.signal).catch(() => undefined) : undefined);
      if (posting) {
        remember(this.postings, request.applicationId, posting);
        job.posting = { source: posting.source, title: posting.title, ...(posting.location ? { location: posting.location.slice(0, 300) } : {}) };
        request = {
          ...request,
          title: posting.title,
          company: posting.company || request.company,
          description: [posting.title, posting.company, posting.location, "", posting.description]
            .filter((line) => line !== undefined)
            .join("\n")
            .slice(0, 25000),
        };
      }
      lap("posting");
      // A page whose text is only its form has no posting to tailor from:
      // the resume goes out as it is, and nothing says why this company.
      const pageText = !posting && !postingReadable(request) ? request.description : undefined;
      if (pageText !== undefined) request = { ...request, description: "" };
      job.postingKey = createHash("sha256").update(JSON.stringify([
        request.title, request.company, request.description,
      ])).digest("hex");
      // Without a posting of its own, the description is the page's text, and
      // a form the site rewrites (it fills it from the uploaded resume) reads
      // differently each time. That must not tailor the documents again: the
      // same role at the same company is the same application. A real
      // posting's text is stable, and a change to it still starts over.
      if (!posting) job.postingRole = createHash("sha256").update(JSON.stringify([request.title, request.company])).digest("hex");
      // The profile as this kind of job is answered from (its overrides by
      // job title), as the extension fills it.
      profile = forRole(profile, [request.title, request.roleTitle].filter(Boolean).join(" | "));
      const graduation = expectedGraduation(profile.education)?.slice(0, 7);
      if (request.purpose === "answers") {
        progress = new TailoringProgress(job);
        for (const field of request.fields.filter(applicationQuestion))
          if (!request.questionIds || request.questionIds.includes(field.id))
            progress.add(`question:${field.id}`, shortLabel(field.label), "question", ["Drafting", "Checking"]);
        progress.begin(...job.progress!.map((item) => item.id));
        const written = await this.answer(request, profile, controller.signal);
        progress.finish(...job.progress!.map((item) => item.id));
        progress.begin(...job.progress!.map((item) => item.id));
        const checked = await this.checkDrafts(request, profile, { written }, controller.signal);
        let answers = checked.written?.answers || [];
        const retried = await this.secondAttempt(request, profile, this.rejectedAnswers(request, written, answers, [...written.warnings, ...checked.warnings]), controller.signal);
        progress.finish(...job.progress!.map((item) => item.id));
        if (retried) {
          answers = [...answers, ...retried.answers];
          written.warnings = [...this.withoutRetried(written.warnings, retried.fields), ...retried.warnings];
          checked.warnings = this.withoutRetried(checked.warnings, retried.fields);
          Object.assign(written.sources, retried.written.sources);
          Object.assign((written.providers ||= {}), retried.written.providers);
          Object.assign((written.reasons ||= {}), retried.written.reasons);
          for (const answer of retried.answers) delete written.reasons[answer.fieldId];
        }
        job.answerDrafts = request.fields
          .filter(applicationQuestion)
          .filter((field) => !request.questionIds || request.questionIds.includes(field.id))
          .map((field) => {
            const value = answers.find((answer) => answer.fieldId === field.id)?.value || "";
            return {
              fieldId: field.id, label: field.label, required: field.required, value,
              maxLength: field.maxLength, maxWords: field.maxWords,
              source: written.sources[field.id], draftedWith: written.providers?.[field.id],
              ...(!value ? { skipReason: written.reasons?.[field.id] || "The draft was withheld during review. Try drafting it separately or write your answer." } : {}),
              ...(value && draftChecks.getStore()?.has(`answer:${field.id}`) ? { unchecked: true } : {}),
            };
          });
        job.warnings = [...new Set([...written.warnings, ...checked.warnings])];
        controller.signal.throwIfAborted();
        if (this.store.data.profile.revision !== profile.revision)
          throw new Error("Profile changed. Draft the questions again.");
        job.status = "complete";
        return;
      }
      const fitting = this.jobFit(request, profile, controller.signal, graduation);
      if (request.purpose === "fit") {
        job.fit = await fitting;
        controller.signal.throwIfAborted();
        if (this.store.data.profile.revision !== profile.revision)
          throw new Error("Profile changed. Check fit again.");
        job.status = "complete";
        return;
      }
      // A later step of the same application keeps its documents: the resume
      // and cover letter come from the posting and the profile, not from the
      // step. Only the step's own written questions are answered, and a step
      // with none (demographics, a review page) needs no model at all.
      const sameApplication = (candidate: GenerationJob, documentsOnly = false) =>
        candidate.id !== job.id &&
        candidate.applicationId === job.applicationId &&
        candidate.status === "complete" &&
        // The documents survive a saved answer: the profile's revision rose
        // when one was saved, and the next step then drafted and checked
        // everything again, 43 s, where reuse takes half a second
        // (Proseware). Written answers still follow the revision.
        (candidate.profileRevision === job.profileRevision ||
          (documentsOnly && Boolean(job.documentsKey) && candidate.documentsKey === job.documentsKey)) &&
        (candidate.postingKey === job.postingKey || (Boolean(job.postingRole) && candidate.postingRole === job.postingRole));
      const previous = request.redraft ? undefined : this.store.data.jobs
        .filter(
          (candidate) =>
            sameApplication(candidate, true) &&
            candidate.narrative &&
            candidate.artifacts.length > 0 &&
            // A step that takes a cover letter after one that did not.
            (!letter || candidate.artifacts.some((artifact) => artifact.kind === "cover")),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const questions = request.fields.filter(narrativeField);
      progress = new TailoringProgress(job);
      const questionItems = () => {
        for (const field of questions) progress!.add(`question:${field.id}`, shortLabel(field.label), "question", ["Drafting", "Checking"]);
      };
      if (previous && (!questions.length || this.config.tailorDir)) {
        // The documents are kept from the earlier step; only questions not
        // answered before are drafted here.
        progress.add("resume", "Tailored resume", "document", ["Reuse"]);
        if (letter) progress.add("letter", "Cover letter", "document", ["Reuse"]);
        progress.complete("resume", "letter");
        questionItems();
        // Warnings about the earlier step's answers do not carry over, nor
        // does which provider failed back then: nothing is drafted by a
        // provider here, and "Codex could not draft this" on a reused
        // document read as a new failure after the model had been changed.
        // Nor that the earlier step's drafts could not be checked: a later
        // step with no written questions checks nothing, and one employer's
        // questions page said so after its documents page had.
        const warnings = (previous.narrative!.warnings || []).filter(
          (warning) => !/^(Left "|Application answers could not)|^(Claude|Codex) could not draft this\b|^A second model could not check\b/.test(warning),
        );
        let answers: Narrative["answers"] = [];
        // Nor are the same questions drafted again: a later step's answers
        // were drafted again on each fill of it, 49 s, 88 s and 102 s, with
        // nothing changed. An answer this application already
        // delivered for the same question, profile revision and posting is
        // given again, with what was said about it; a question asked in other
        // words, or left for the applicant, is drafted.
        const asked = request.fields
          .filter(applicationQuestion)
          .filter((field) => !request.questionIds || request.questionIds.includes(field.id));
        const delivered = new Map<string, NonNullable<GenerationJob["answered"]>[number]>();
        for (const earlier of this.store.data.jobs.filter((candidate) => sameApplication(candidate)).sort((a, b) => b.createdAt - a.createdAt))
          for (const answer of earlier.answered || [])
            if (!delivered.has(answer.question)) delivered.set(answer.question, answer);
        const fresh: string[] = [];
        for (const field of questions.length ? asked : []) {
          const before = delivered.get(questionKey(field));
          if (!before) fresh.push(field.id);
          else {
            answers.push({ fieldId: field.id, value: before.value, factIds: before.factIds });
            warnings.push(...before.warnings);
            (job.answered ||= []).push(before);
          }
        }
        progress.complete(...questions.filter((field) => !fresh.includes(field.id)).map((field) => `question:${field.id}`));
        const freshItems = fresh.map((id) => `question:${id}`);
        if (fresh.length) {
          progress.begin(...freshItems);
          const written = await this.answer({ ...request, questionIds: fresh }, profile, controller.signal).catch(
            (error: Error) => error,
          );
          if (written instanceof Error) {
            for (const id of freshItems) progress.fail(id, written.message);
            controller.signal.throwIfAborted();
            warnings.push(
              `Application answers could not be written from your tailoring notes. ${written.message}`.slice(0, 350),
            );
          } else {
            progress.finish(...freshItems);
            progress.begin(...freshItems);
            const checked = await this.checkDrafts(request, profile, { written }, controller.signal);
            const { answers: drafted, warnings: said } = await this.retryRejected(
              request, profile, written, checked.written?.answers || [], [...written.warnings, ...checked.warnings], controller.signal,
            );
            progress.finish(...freshItems);
            warnings.push(...said);
            answers.push(...drafted);
            job.answered = [...(job.answered || []), ...(answeredRecord(request.fields, drafted, said) || [])];
          }
        }
        if (
          controller.signal.aborted ||
          this.store.data.profile.revision !== profile.revision
        )
          throw new Error("Generation cancelled or profile changed.");
        // The transcript is the applicant's file as it is now, not the copy
        // (or the absence) the earlier step had: one uploaded since the
        // documents were drafted reached no form until they were redrafted.
        const transcripts = await this.transcripts(request);
        // Copied under this run's own ids: the page attaches only documents
        // made for the operation it is filling.
        job.artifacts = await Promise.all(
          previous.artifacts.filter((artifact) => !transcripts.length || artifact.kind !== "transcript").map(async (artifact) => {
            const id = randomUUID();
            const file = (name: string) =>
              join(this.store.directory, "artifacts", `${name}.${artifact.format}`);
            await copyFile(file(artifact.id), file(id));
            return { ...artifact, id, operation: job.operation };
          }),
        );
        job.artifacts.push(...transcripts);
        // The earlier step's documents keep their own record.
        const earlier = previous.narrative!.unchecked?.drafts.filter((id) => !id.startsWith("answer:")) || [];
        const record = new Map<string, CheckReason>(earlier.map((id) => [id, previous.narrative!.unchecked!.reason]));
        for (const [id, reason] of draftChecks.getStore() || []) record.set(id, reason);
        job.narrative = { ...previous.narrative!, answers, warnings: distinctWarnings(warnings) || [], unchecked: uncheckedSummary(record) };
        job.fit = await fitting;
        job.status = "complete";
        return;
      }
      const tailorDir = Boolean(this.config.tailorDir);
      progress.add("resume", "Tailored resume", "document", tailorDir ? ["Choosing what to include", "Checking", "Building"] : ["Building"]);
      if (letter) progress.add("letter", "Cover letter", "document", ["Writing", "Checking", "Building"]);
      questionItems();
      const questionIds = questions.map((field) => `question:${field.id}`);
      progress.begin(...(tailorDir ? ["resume"] : []), ...(letter ? ["letter"] : []), ...questionIds);
      // The resume brief is its own request, made alongside the narrative.
      const planning = this.config.tailorDir
        ? this.tailor(request, profile, controller.signal, { graduation }).catch(
            (error: Error) => error,
          ).then((result) => {
            if (result instanceof Error) progress!.fail("resume", result.message);
            else progress!.finish("resume");
            return result;
          })
        : undefined;
      // So are the application answers, from the job-applier profile.
      let early: { written: WrittenAnswers; answers: Narrative["answers"]; warnings: string[] } | undefined;
      const answering = this.config.tailorDir
        ? this.answer(request, profile, controller.signal).catch(
            (error: Error) => error,
          ).then(async (result) => {
            if (result instanceof Error) for (const id of questionIds) progress!.fail(id, result.message);
            else {
              progress!.finish(...questionIds);
              // The answers need neither plan nor letter: check them now and
              // put them on the running job, so the page has them while the
              // documents are still tailoring.
              try {
                progress!.begin(...questionIds);
                const first = await this.checkDrafts(request, profile, { written: result }, controller.signal);
                const { answers: kept, warnings } = await this.retryRejected(
                  request, profile, result, first.written?.answers || [], [...result.warnings, ...first.warnings], controller.signal,
                );
                early = { written: result, answers: kept, warnings: warnings.map((warning) => warning.slice(0, 350)) };
                job.earlyAnswers = { answers: kept, warnings: early.warnings };
                progress!.finish(...questionIds);
              } catch (error) {
                controller.signal.throwIfAborted();
                // Checked with the rest, as without this.
                console.warn("[generation] early answers not published:", (error as Error).message);
              }
            }
            return result;
          })
        : undefined;
      // The questions the answer writer takes are not also asked of the
      // letter request: each was drafted twice, and one draft thrown away.
      // Should the writer fail or leave one out, the letter request is asked
      // for those alone, below.
      const writerIds = new Set(tailorDir ? writerQuestions(request, profile).map((field) => field.id) : []);
      const drafting: DraftRequest = { ...request, letter, ...(pageText ? { pageText } : {}) };
      let narrative = await this.generate(
        writerIds.size ? { ...drafting, fields: request.fields.filter((field) => !writerIds.has(field.id)) } : drafting,
        profile,
        controller.signal,
      ).finally(async () => { await planning; await fitting; });
      progress.finish("letter", ...(tailorDir ? [] : questionIds));
      const plan = await planning;
      const written = await answering;
      job.fit = await fitting;
      // The writer's questions it neither answered nor left for the
      // applicant: drafted by the letter request after all.
      const unanswered = [...writerIds].filter(
        (id) => !written || written instanceof Error || !(written.answers.some((answer) => answer.fieldId === id) || written.withheld.includes(id)),
      );
      if (unanswered.length) {
        const backup = await this.generate(
          { ...drafting, letter: false, fields: request.fields.filter((field) => unanswered.includes(field.id)) } as DraftRequest,
          profile,
          controller.signal,
        ).catch((error: Error) => {
          controller.signal.throwIfAborted();
          console.warn("[generation] backup answers failed:", error.message);
          return undefined;
        });
        if (backup) narrative.answers = [...narrative.answers.filter((answer) => !unanswered.includes(answer.fieldId)), ...backup.answers.filter((answer) => unanswered.includes(answer.fieldId))];
      }
      lap("drafting");
      // With job-applier the resume comes from its brief, not this ranking.
      if (this.config.tailorDir)
        narrative.warnings = (narrative.warnings || []).filter((warning) => warning !== UNRANKED);
      // Not when the page's own text is a posting: the extension read it
      // where the backend was refused (Tesla's, in a tab of its own), and
      // the letter was written from it.
      if (!posting && request.postingUrl && pageText !== undefined)
        narrative.warnings = [
          ...(narrative.warnings || []),
          "The job posting could not be read from the link you added (the page may build it with script), so your resume went out unchanged and nothing says why this company. Paste the posting's text instead, then fill again.",
        ];
      else if (!posting && !request.description && this.config.postingLookup)
        narrative.warnings = [
          ...(narrative.warnings || []),
          "The job posting could not be read from this site, so your resume went out unchanged, and the letter and answers say nothing about why this company. Add the posting's link or text to this application, then fill again.",
        ];
      if (written instanceof Error) {
        controller.signal.throwIfAborted();
        narrative.warnings = [
          ...(narrative.warnings || []),
          `Application answers could not be written from your tailoring notes, so shorter ones were used. ${written.message}`.slice(0, 350),
        ];
      } else if (written) {
        // Its answers take the place of the letter request's for the same
        // question; questions it left out keep what that request wrote,
        // unless it left them for the applicant.
        const covered = new Set([
          ...written.answers.map((answer) => answer.fieldId),
          ...written.withheld,
        ]);
        narrative.answers = [
          ...written.answers,
          ...narrative.answers.filter((answer) => !covered.has(answer.fieldId)),
        ];
        // What the letter request said about those questions no longer
        // applies: this writer's reason (a skip's) is the one shown.
        const coveredLabels = request.fields
          .filter((field) => covered.has(field.id))
          .map((field) => `Left "${shortLabel(field.label)}"`);
        narrative.warnings = [
          ...(narrative.warnings || []).filter(
            (warning) => !coveredLabels.some((label) => warning.startsWith(label)),
          ),
          ...written.warnings,
        ];
      }
      // A second model reads every answer, letter paragraph and the resume
      // summary against the profile before anything is built or filled.
      // Answers already checked and retried (early) are not checked again.
      const alreadyChecked = early && written && !(written instanceof Error) ? early : undefined;
      if (alreadyChecked) {
        const done = new Set([...alreadyChecked.written.answers.map((a) => a.fieldId), ...alreadyChecked.written.withheld]);
        narrative = { ...narrative, answers: narrative.answers.filter((answer) => !done.has(answer.fieldId)) };
        // Their warnings were already given by the early check.
        narrative.warnings = (narrative.warnings || []).filter((warning) => !alreadyChecked.written.warnings.includes(warning));
      }
      progress.begin("resume", "letter", ...(alreadyChecked ? [] : questionIds));
      const checked = await this.checkDrafts(
        request,
        profile,
        {
          narrative,
          plan: plan instanceof Error ? undefined : plan,
          written: written instanceof Error || alreadyChecked ? undefined : written,
        },
        controller.signal,
      );
      narrative = checked.narrative || narrative;
      if (checked.warnings.length)
        narrative.warnings = [...(narrative.warnings || []), ...checked.warnings];
      if (alreadyChecked)
        narrative = {
          ...narrative,
          answers: [...alreadyChecked.answers, ...narrative.answers],
          warnings: [...(narrative.warnings || []), ...alreadyChecked.warnings],
        };
      else if (written && !(written instanceof Error)) {
        const { answers, warnings } = await this.retryRejected(request, profile, written, narrative.answers, narrative.warnings || [], controller.signal);
        narrative = { ...narrative, answers, warnings };
      }
      job.answered = answeredRecord(request.fields, narrative.answers, narrative.warnings || []);
      progress.finish(...(tailorDir ? ["resume"] : []), "letter", ...questionIds);
      lap("verifying");
      // A requirement the applicant does not meet leads the card.
      const eligibility = plan && !(plan instanceof Error) ? plan.eligibility : [];
      if (eligibility.length)
        narrative.warnings = [
          ...eligibility.map((line) => `Eligibility: ${line}`.slice(0, 350)),
          ...(narrative.warnings || []),
        ];
      if (
        controller.signal.aborted ||
        this.store.data.profile.revision !== profile.revision
      )
        throw new Error("Generation cancelled or profile changed.");
      // A job-applier problem is reported on the card and the laid-out
      // documents go instead: a plain resume beats no resume.
      let tailored: TailoredDocuments | undefined;
      progress.begin("resume", "letter");
      if (plan)
        tailored = await (
          plan instanceof Error
            ? Promise.reject(plan)
            : buildTailored(plan, profile, narrative, controller.signal, {
                graduation,
              })
        ).catch((error: Error) => {
          controller.signal.throwIfAborted();
          return {
            warnings: [
              `Your LaTeX resume could not be built, so a plain one was used instead. ${error.message}`.slice(
                0,
                350,
              ),
            ],
          };
        });
      lap("building");
      if (tailored?.tailoring) narrative.tailoring = tailored.tailoring;
      const { artifacts, warnings } = await renderArtifacts(
        this.store.directory,
        profile,
        request,
        narrative,
        {
          fontPath: this.config.fontPath,
          resumeLatexDir: this.config.tailorDir
            ? undefined
            : this.config.resumeLatexDir,
          tailored,
        },
      );
      progress.finish("resume", "letter");
      // A rendering problem belongs on the application card, next to whatever
      // the draft itself had to say.
      warnings.unshift(...(tailored?.warnings || []));
      if (warnings.length)
        narrative.warnings = [...(narrative.warnings || []), ...warnings];
      if (
        controller.signal.aborted ||
        this.store.data.profile.revision !== profile.revision
      )
        throw new Error("Generation cancelled or profile changed.");
      const transcripts = await this.transcripts(request);
      job.artifacts = [...artifacts, ...transcripts];
      job.narrative = { ...narrative, warnings: distinctWarnings(narrative.warnings), unchecked: uncheckedSummary() };
      if (!job.narrative.warnings) delete job.narrative.warnings;
      job.status = "complete";
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      progress?.failUnfinished(error instanceof Error ? error.message : "Generation failed.");
      job.error =
        error instanceof Error
          ? error.message.slice(0, 400)
          : "Generation failed.";
    } finally {
      if (job.status === "complete" && job.artifacts.length && this.config.documentsDir)
        // A folder that cannot be written costs the files, never the draft.
        await exportDocuments(
          resolve(this.config.documentsDir),
          this.store.directory,
          job,
          profile,
          request,
          this.store.data.jobs.filter((other) => other.id !== job.id && other.applicationId === job.applicationId),
        ).catch((error: Error) => {
          const warning = `Documents were not saved to your documents folder. ${error.message}`.slice(0, 350);
          if (job.narrative) job.narrative.warnings = [...(job.narrative.warnings || []), warning];
          else job.warnings = [...(job.warnings || []), warning];
        });
      job.durationMs = Date.now() - started;
      console.info("[generation-timing]", JSON.stringify({ job: job.id, ...stages, totalMs: job.durationMs }));
      await this.store.save();
    }
  }
}
