// Part of the extension's service worker (background.ts): the AI step for fields the profile rules left open.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, type Field, type Profile, type FieldFallbackProblem, activeStatuses, type GenerationJob, normalize, type Proposal, type Observation, hasLegalDetails } from "../../shared/model";
import { proposals, listAnswered, draftOnlySite, DRAFT_ONLY_NOTE } from "../../shared/matching";
import { structuredFallbackField, leftReason, legalQuestion } from "../../shared/questions";
import { releaseTrustedInput } from "../trusted-input";
import { bg } from "./state";
import { alive, answerFills, api, fieldFallbackFills, fieldFallbackRequests, frameCall, optionReads, persist, withPageTimers } from "./core";
import { applicationForTab, draftOnlyTab, inspectTab } from "./tabs";
import { forApplication, touch } from "./queue";
import { broadcast } from "./badges";
import { questionFields } from "./documents";
import { draftAnswers } from "./answers";


export async function clearFieldFallback(app: Application) {
  fieldFallbackRequests.delete(app.id);
  const id = app.fieldFallbackSession?.jobId;
  app.fieldFallbackSession = undefined;
  if (id) await api(`/v1/jobs/${id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
}
// A field of one row of a repeated section (a school, a job) carries what
// the rest of its row holds, for the model to tell which entry it is.
export function withRows(fields: Field[]): Field[] {
  return fields.map((field) => {
    if (!field.section || field.index === undefined) return field;
    const row = fields
      .filter((other) => other !== field && other.section === field.section && other.index === field.index && other.value && !/^(file|password|hidden)$/.test(other.kind))
      .map((other) => `${other.label.replace(/^\W+/, "").slice(0, 60)}: ${other.value.slice(0, 80)}`)
      .join("; ");
    return row ? { ...field, row: `Entry ${field.index + 1} of "${field.section.slice(0, 80)}": ${row}`.slice(0, 1000) } : field;
  });
}
export function fallbackProblems(
  captured: Awaited<ReturnType<typeof inspectTab>>,
  profile: Profile,
) {
  const problems: FieldFallbackProblem[] = [];
  const frames: { frameId: number; documentId: string; fields: Field[] }[] = [];
  // Open legal or eligibility questions the model is not to answer.
  const legalLeft: string[] = [];
  const legalToo = legalAsked(profile);
  for (const frame of captured.frames) {
    const planned = new Set(
      proposals(frame.observation.fields, profile).map(
        (proposal) => proposal.fieldId,
      ),
    );
    // A list the fill answered (one box of it ticked) is not left: the
    // sanctions list given "None of the above" was still listed. Nor one
    // with a box ticked already (JazzHR's clearance list on a refill, "No
    // Current Clearance" ticked).
    const answeredLists = new Set(
      frame.observation.fields
        .filter((field) => field.question && (planned.has(field.id) || listAnswered(field, profile) ||
          (field.kind === "checkbox" && /^(yes|true|on)$/i.test(field.value))))
        .map((field) => field.question),
    );
    if (!legalToo)
      legalLeft.push(
        ...frame.observation.fields
          .filter((field) => !planned.has(field.id) && !(field.question && answeredLists.has(field.question)) &&
            structuredFallbackField(field, true) && !structuredFallbackField(field))
          .map((field) => field.label),
      );
    const fields = withRows(frame.observation.fields)
      .filter((field) => structuredFallbackField(field, legalToo) && !(field.question && answeredLists.has(field.question)))
      .slice(0, Math.max(0, 100 - problems.length));
    if (!fields.length) continue;
    frames.push({
      frameId: frame.frameId,
      documentId: frame.observation.documentId,
      fields,
    });
    problems.push(
      ...fields.map((field) => ({
        fieldId: `${frame.frameId}|${field.id}`,
        label: field.label,
        question: field.question,
        section: field.section,
        kind: field.kind,
        required: field.required,
        options: field.options,
        reason: planned.has(field.id)
          ? "Normal fill found a saved value, but the field remained empty."
          : leftReason(field.question || field.label) || "Normal fill could not match this field to saved profile information or its available choices.",
      })),
    );
    if (problems.length >= 100) break;
  }
  return { problems, frames, legalLeft: [...new Set(legalLeft)] };
}
export async function unresolvedFields(
  app: Application,
  tabId: number,
  captured?: Awaited<ReturnType<typeof inspectTab>>,
  profile?: Profile,
) {
  // A draft-only site never has a fill behind it: every open field is one
  // to suggest a value for.
  const attempted =
    (await draftOnlyTab(tabId)) ||
    app.attempts.some((attempt) => attempt.tabId === tabId && Boolean(attempt.completedAt));
  if (
    applicationForTab(tabId)?.id !== app.id ||
    app.tabId !== tabId ||
    !attempted ||
    // Paused by the applicant's own click (Amazon): the fill is
    // over, and what it left is still theirs to review.
    !["awaiting-user", "ready", "paused"].includes(app.status)
  )
    return {
      available: false,
      problems: [] as FieldFallbackProblem[],
      frames: [] as {
        frameId: number;
        documentId: string;
        fields: Field[];
      }[],
      inaccessible: [] as string[],
      legalLeft: [] as string[],
    };
  const currentProfile: Profile = profile || (await api("/v1/profile"));
  const current = captured || (await inspectTab(tabId));
  return {
    available: true,
    ...fallbackProblems(current, currentProfile),
    inaccessible: current.inaccessible,
  };
}
export async function draftFieldFallback(
  app: Application,
  tabId: number,
  ids?: string[],
) {
  if (app.explicitFill || activeStatuses.includes(app.status))
    throw new Error("Wait for the current fill to finish.");
  if (answerFills.has(app.id) || fieldFallbackFills.has(app.id))
    throw new Error("Wait for the current reviewed fill to finish.");
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string"))
  )
    throw new Error("Choose valid unresolved fields to review.");
  // As Fill read it, so both agree on what is left (graduation by role).
  const profile: Profile = forApplication(await api(`/v1/profile/application?title=${encodeURIComponent(app.title)}`).catch(() => api("/v1/profile")), app);
  const captured = await inspectTab(tabId);
  const scanned = await unresolvedFields(app, tabId, captured, profile);
  if (!scanned.available)
    throw new Error("Choose Fill this step before asking AI to review what remains.");
  const selected = scanned.problems.filter(
    (problem) => !ids || ids.includes(problem.fieldId),
  );
  if (!selected.length)
    throw new Error("No empty structured fields are eligible for AI review.");
  if (ids && selected.length !== new Set(ids).size)
    throw new Error("A field changed or was filled. Scan the remaining fields again.");
  await clearFieldFallback(app);
  const stamp = crypto.randomUUID();
  fieldFallbackRequests.set(app.id, stamp);
  const operation = app.operation;
  const selectedIds = new Set(selected.map((problem) => problem.fieldId));
  // Dropdowns that list their options only once opened have none yet. Read
  // them now (nothing is chosen): a suggestion must be one of them.
  for (const frame of captured.frames) {
    const unread = frame.observation.fields.filter(
      (field) => selectedIds.has(`${frame.frameId}|${field.id}`) && !field.options.length && /combobox|listbox|select/.test(field.kind),
    );
    // Reading them means opening the dropdown, which a draft-only site is spared.
    if (!unread.length || draftOnlySite(frame.observation.url)) continue;
    optionReads.add(app.id);
    const read: { id: string; options: string[] }[] = await frameCall(app, frame.frameId, {
      type: "BIND",
      documentId: frame.observation.documentId,
      locks: bg.locks[app.id] || [],
      replaceSiteValues: false,
    })
      .then(() => frameCall(app, frame.frameId, { type: "OPTIONS", documentId: frame.observation.documentId, fieldIds: unread.map((field) => field.id) }))
      .catch(() => [])
      .finally(() => optionReads.delete(app.id));
    for (const { id, options } of read) {
      const field = frame.observation.fields.find((candidate) => candidate.id === id);
      if (field) field.options = options;
      for (const listed of [...selected, ...scanned.frames.flatMap((snapshot) => (snapshot.frameId === frame.frameId ? snapshot.fields : []))])
        if (("fieldId" in listed ? listed.fieldId : `${frame.frameId}|${listed.id}`) === `${frame.frameId}|${id}`) listed.options = options;
    }
  }
  if (app.operation !== operation || fieldFallbackRequests.get(app.id) !== stamp)
    throw new Error("The page changed while preparing the review. Scan again.");
  const fields = captured.frames
    .flatMap((frame) =>
      withRows(frame.observation.fields).map((field) => ({
        ...field,
        id: `${frame.frameId}|${field.id}`,
      })),
    )
    .filter((field) => selectedIds.has(field.id));
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "field-fallback",
    applicationId: app.id,
    operation: Date.now(),
    profileRevision: profile.revision,
    url: captured.tab.url || app.url,
    title: app.title,
    company: app.company,
    description: "",
    fields,
    questionIds: selected.map((problem) => problem.fieldId),
    fallbackReasons: selected.map((problem) => ({
      fieldId: problem.fieldId,
      reason: problem.reason,
    })),
    legalAnswers: bg.state.settings.legalQuestions === "model" ? "any" : "details",
  });
  if (
    app.operation !== operation ||
    fieldFallbackRequests.get(app.id) !== stamp
  ) {
    await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
    throw new Error("The page changed while preparing the review. Scan again.");
  }
  app.fieldFallbackSession = {
    jobId: job.id,
    tabId,
    operation,
    profileRevision: profile.revision,
    problems: selected,
    frames: scanned.frames
      .map((frame) => ({
        ...frame,
        fields: frame.fields.filter((field) =>
          selectedIds.has(`${frame.frameId}|${field.id}`),
        ),
      }))
      .filter((frame) => frame.fields.length),
  };
  await persist();
  return bg.state;
}
export async function fillFieldFallback(app: Application, message: any) {
  if (await draftOnlyTab(message.tabId, app.url)) throw new Error(DRAFT_ONLY_NOTE);
  const session = app.fieldFallbackSession;
  if (
    !session ||
    !session.jobId ||
    session.jobId !== message.jobId ||
    session.tabId !== message.tabId ||
    app.operation !== session.operation
  )
    throw new Error("These suggestions are stale. Review the current fields again.");
  if (
    app.explicitFill ||
    activeStatuses.includes(app.status) ||
    answerFills.has(app.id) ||
    fieldFallbackFills.has(app.id)
  )
    throw new Error("Wait for the current fill to finish.");
  const selected = message.answers as { fieldId: string; value: string }[];
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 100 ||
    selected.some(
      (answer) =>
        !answer ||
        typeof answer.fieldId !== "string" ||
        typeof answer.value !== "string" ||
        !answer.value.trim() ||
        answer.value.length > 4000,
    ) ||
    new Set(selected.map((answer) => answer.fieldId)).size !== selected.length
  )
    throw new Error("Choose valid reviewed suggestions to fill.");
  fieldFallbackFills.add(app.id);
  let fillOperation: number | undefined;
  const results: { fieldId: string; ok: boolean; reason?: string }[] = [];
  try {
    const [profile, job, captured]: [
      Profile,
      GenerationJob,
      Awaited<ReturnType<typeof inspectTab>>,
    ] = await Promise.all([
      api("/v1/profile"),
      api(`/v1/jobs/${session.jobId}`),
      inspectTab(session.tabId),
    ]);
    if (
      profile.revision !== session.profileRevision ||
      app.operation !== session.operation ||
      app.fieldFallbackSession !== session ||
      job.status !== "complete"
    )
      throw new Error("The profile or page changed. Ask AI to review the fields again.");
    for (const answer of selected) {
      const frame = session.frames.find((candidate) =>
        candidate.fields.some(
          (field) => `${candidate.frameId}|${field.id}` === answer.fieldId,
        ),
      );
      const field = frame?.fields.find(
        (candidate) => `${frame.frameId}|${candidate.id}` === answer.fieldId,
      );
      const draft = job.fieldDrafts?.find(
        (candidate) => candidate.fieldId === answer.fieldId,
      );
      if (!frame || !field || !draft)
        throw new Error("This suggestion is not part of the current review.");
      if (
        field.options.length &&
        !field.options.some(
          (option) => normalize(option) === normalize(answer.value),
        )
      )
        throw new Error(`${field.label.slice(0, 80)}: choose an available option.`);
      if (field.maxLength && answer.value.length > field.maxLength)
        throw new Error(
          `${field.label.slice(0, 80)}: use at most ${field.maxLength} characters.`,
        );
    }
    if (session.tabId !== app.tabId)
      throw new Error("Make this tab the application's fill target, then review again.");
    app.operation++;
    fillOperation = app.operation;
    touch(app, "filling", "Filling reviewed AI suggestions…");
    await persist();
    for (const snapshot of session.frames) {
      const answers = selected.filter((answer) =>
        snapshot.fields.some(
          (field) => `${snapshot.frameId}|${field.id}` === answer.fieldId,
        ),
      );
      if (!answers.length) continue;
      const frame = captured.frames.find(
        (candidate) => candidate.frameId === snapshot.frameId,
      );
      if (!alive(app, fillOperation))
        throw new Error("The reviewed fill was paused or superseded.");
      if (!frame || frame.observation.documentId !== snapshot.documentId) {
        results.push(
          ...answers.map((answer) => ({
            fieldId: answer.fieldId,
            ok: false,
            reason: "The page navigated or reloaded. Review the current fields again.",
          })),
        );
        continue;
      }
      const pending: Proposal[] = [];
      for (const answer of answers) {
        const original = snapshot.fields.find(
          (field) => `${snapshot.frameId}|${field.id}` === answer.fieldId,
        )!;
        const current = frame.observation.fields.find(
          (field) => field.id === original.id,
        );
        if (
          !current ||
          !structuredFallbackField(current, legalAsked(profile)) ||
          current.revision !== original.revision ||
          current.label !== original.label ||
          current.value !== original.value
        ) {
          results.push({
            fieldId: answer.fieldId,
            ok: false,
            reason: "This field changed, was filled, or is protected. Its current value was kept.",
          });
          continue;
        }
        pending.push({
          fieldId: original.id,
          value: answer.value,
          expectedValue: original.value,
          revision: original.revision,
          source: "reviewed-field-fallback",
        });
      }
      if (!pending.length) continue;
      try {
        await frameCall(app, frame.frameId, {
          type: "BIND",
          documentId: snapshot.documentId,
          locks: bg.locks[app.id] || [],
          replaceSiteValues: false,
        });
        if (!alive(app, fillOperation))
          throw new Error("Fill was paused or superseded.");
        await frameCall(app, frame.frameId, {
          type: "RESUME",
          documentId: snapshot.documentId,
        });
        const applied = await frameCall(app, frame.frameId, {
          type: "APPLY",
          documentId: snapshot.documentId,
          proposals: pending,
        });
        frame.observation = applied.observation;
        results.push(
          ...applied.results.map(
            (result: { id: string; ok: boolean; reason?: string }) => ({
              fieldId: `${frame.frameId}|${result.id}`,
              ok: result.ok,
              reason: result.reason,
            }),
          ),
        );
      } catch (error) {
        results.push(
          ...pending.map((proposal) => ({
            fieldId: `${snapshot.frameId}|${proposal.fieldId}`,
            ok: false,
            reason: (error as Error).message,
          })),
        );
      }
    }
    if (alive(app, fillOperation)) {
      session.operation = fillOperation;
      const filled = new Set(
        results.filter((result) => result.ok).map((result) => result.fieldId),
      );
      session.problems = session.problems.filter(
        (problem) => !filled.has(problem.fieldId),
      );
      for (const frame of session.frames)
        frame.fields = frame.fields.filter(
          (field) => !filled.has(`${frame.frameId}|${field.id}`),
        );
      const count = filled.size;
      app.filled += count;
      touch(
        app,
        "awaiting-user",
        `${count} reviewed AI suggestion${count === 1 ? "" : "s"} filled. Review the form before continuing.`,
      );
      await persist();
    }
    return { state: bg.state, results };
  } finally {
    if (fillOperation !== undefined && app.operation === fillOperation) {
      if (app.status === "filling")
        touch(app, "awaiting-user", "Reviewed fill stopped. Review the form before continuing.");
      await broadcast(app, "PAUSE");
      await releaseTrustedInput(session.tabId);
      await persist();
    }
    fieldFallbackFills.delete(app.id);
  }
}
// The options of a step's empty dropdowns that show none until opened (see
// OPTIONS in content.ts: Workday's from its questionnaire where it lists
// them, else opened and closed with nothing chosen). A draft-only site is
// spared the opening.
export async function readListOptions(app: Application, frame: { frameId: number; observation: Observation }) {
  if (draftOnlySite(frame.observation.url)) return;
  const unread = frame.observation.fields.filter(
    (field) => !field.value && !field.protected && !field.options.length && /combobox|listbox/.test(field.kind),
  );
  if (!unread.length) return;
  const read: { id: string; options: string[] }[] = await frameCall(app, frame.frameId, {
    type: "OPTIONS",
    documentId: frame.observation.documentId,
    fieldIds: unread.map((field) => field.id),
    // Only list buttons (Workday's) during a fill: opening a SuccessFactors
    // or react-select list then got in the way of its own fill, which picks
    // from the open list anyway (suite). A SuccessFactors list
    // is still read, from its own model without opening it.
    listButtonsOnly: true,
  }).catch(() => []);
  for (const { id, options } of Array.isArray(read) ? read : []) {
    const field = frame.observation.fields.find((candidate) => candidate.id === id);
    if (field && Array.isArray(options)) field.options = options.filter((option) => typeof option === "string").slice(0, 300);
  }
}
// What the applicant's setting lets the model do in a fill (model.ts).
export function modelFills() {
  const mode = bg.state.settings.modelFill || "auto";
  return {
    mode,
    // Its written answers go into the page as part of the fill.
    written: mode === "auto" || mode === "written",
    // After the fill it suggests values for what the rules left open.
    assist: mode === "auto" || mode === "review",
  };
}
export const leftAsLegal = (label: string) => bg.state.settings.legalQuestions !== "model" && legalQuestion(label);
// Whether legal and eligibility questions go to the model at all: when the
// applicant lets it answer them, or has saved legal details to answer from.
export const legalAsked = (profile: Profile) => bg.state.settings.legalQuestions === "model" || hasLegalDetails(profile);
export function noteAiFilled(app: Application, label: string, value: string, caution?: string) {
  const entry = { label: label.slice(0, 200), value: value.replace(/\s+/g, " ").slice(0, 120), ...(caution ? { caution: caution.slice(0, 200) } : {}) };
  app.aiFilled = [...(app.aiFilled || []).filter((other) => other.label !== entry.label), entry].slice(-60);
}
// After a fill: the fields the profile rules left open are suggested values
// from the applicant's saved facts. "auto" fills what is suggested and lists
// it for checking; "review" leaves the drafts in the panel for approval,
// with the written answers drafted beside them.
export const assisting = new Set<string>();
export async function assist(app: Application, tabId: number) {
  if (assisting.has(app.id)) return;
  assisting.add(app.id);
  if (await draftOnlyTab(tabId)) {
    assisting.delete(app.id);
    app.assisting = false;
    await persist();
    return;
  }
  const { mode } = modelFills();
  const tried = new Set<string>();
  // In automatic mode every suggestion is filled, identity, eligibility and
  // pay questions included: nothing holds the form back, and what the model
  // filled is listed for the applicant to check.
  let filled = 0;
  let finished = false;
  const idle = () => !app.explicitFill && !activeStatuses.includes(app.status) && app.tabId === tabId;
  const profileRevision: number | undefined = (await api("/v1/profile").catch(() => undefined))?.revision;
  try {
    for (let round = 0; round < (mode === "auto" ? 2 : 1) && idle(); round++) {
      const scanned = await unresolvedFields(app, tabId);
      if (!scanned.available) break;
      for (const label of scanned.legalLeft) {
        const note = `Legal or eligibility question left for you: ${label}`.slice(0, 350);
        if (!app.missing.includes(note)) app.missing.push(note);
      }
      const ids = scanned.problems
        .filter((problem) => !tried.has(problem.fieldId))
        .map((problem) => problem.fieldId)
        .slice(0, 100);
      if (!ids.length) break;
      for (const id of ids) tried.add(id);
      await draftFieldFallback(app, tabId, ids);
      if (mode !== "auto") break;
      const session = app.fieldFallbackSession;
      if (!session?.jobId) break;
      let job: GenerationJob = await api(`/v1/jobs/${session.jobId}`);
      for (let waited = 0; waited < 120 && ["queued", "running"].includes(job.status); waited++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (app.fieldFallbackSession !== session || !idle()) return;
        job = await api(`/v1/jobs/${session.jobId}`);
      }
      if (job.status !== "complete" || app.fieldFallbackSession !== session || !idle()) break;
      const listed = session.frames.flatMap((frame) => frame.fields.map((field) => ({ ...field, id: `${frame.frameId}|${field.id}` })));
      // A box left clear in a list another box answers is not a question
      // left: JazzHR's clearance list, "No Current Clearance" ticked, listed
      // "Top Secret" and every other box as left for the applicant.
      const answeredQuestions = new Set((job.fieldDrafts || []).filter((draft) => draft.question && draft.value?.trim()).map((draft) => draft.question));
      for (const draft of (job.fieldDrafts || []).filter((candidate) => !candidate.value?.trim() && !(candidate.question && answeredQuestions.has(candidate.question)) &&
          legalQuestion(`${candidate.question || ""} ${candidate.label}`))) {
        const note = `Legal or eligibility question left for you: ${draft.label}`.slice(0, 350);
        if (!app.missing.includes(note)) app.missing.push(note);
      }
      const answers = (job.fieldDrafts || [])
        .filter((draft) => draft.value?.trim())
        .filter((draft) => {
          const field = listed.find((candidate) => candidate.id === draft.fieldId);
          return (
            field &&
            (!field.options.length || field.options.some((option) => normalize(option) === normalize(draft.value))) &&
            (!field.maxLength || draft.value.length <= field.maxLength)
          );
        })
        .map((draft) => ({ fieldId: draft.fieldId, value: draft.value, caution: draft.caution }));
      if (!answers.length) break;
      const { results } = await withPageTimers(app, tabId, () => fillFieldFallback(app, { jobId: session.jobId, tabId, answers }));
      for (const result of results.filter((candidate) => candidate.ok)) {
        const field = listed.find((candidate) => candidate.id === result.fieldId);
        const answer = answers.find((candidate) => candidate.fieldId === result.fieldId);
        if (!field || !answer) continue;
        filled++;
        noteAiFilled(app, field.label, answer.value, answer.caution);
        app.missing = app.missing.filter((item) => item !== `Required: ${field.label}` && !item.startsWith(`Required: ${field.label}:`) && item !== `Optional unanswered: ${field.label}`);
      }
    }
    if (mode === "auto") {
      // What was filled is listed for checking.
      if (idle()) await clearFieldFallback(app);
      if (filled && idle()) app.note = `${filled} more field${filled === 1 ? "" : "s"} filled by AI from your saved details. Check the ones listed.`;
    } else if (idle()) {
      const questions = (await questionFields(tabId)).fields.filter((field) => !field.value && !field.protected && !leftAsLegal(field.label));
      if (questions.length) await draftAnswers(app, tabId, questions.map((field) => field.id).slice(0, 250)).catch((error: Error) => {
          // Said on the card: the drafts were what this step was waiting for.
          if (idle()) app.note = `AI could not draft the written questions (${error.message.slice(0, 160)}). Draft them from the panel.`;
        });
    }
    finished = idle();
  } catch (error) {
    // A suggestion step that cannot run leaves the fill as it finished, and
    // says why. Workable's Yes/No questions:
    // the model answered both from the profile, nothing was filled, and
    // nothing said what stopped it.
    const note = `AI suggestions were not filled automatically: ${((error as Error)?.message || String(error)).slice(0, 200)} Review them in the panel.`.slice(0, 350);
    if (!app.missing.includes(note)) app.missing.push(note);
  } finally {
    app.aiPass = { tabId, profileRevision, fieldIds: [...tried], finished };
    assisting.delete(app.id);
    app.assisting = false;
    await persist();
  }
}
