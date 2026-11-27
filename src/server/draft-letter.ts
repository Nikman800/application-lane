// The drafting provider: the letter request (its plan, then the letter written from it) and reading what it chose.
// Split out of generation.ts as it was; generation.ts re-exports it.
import { type Profile, type GenerationRequest, type Narrative, narrativeSchema } from "../shared/model";
import { asksForToolList, TOOL_LIST_NOTE, skillContext, type AnswerWriter, writeAnswers } from "./answers";
import { fitAnswerLength, writerLabel } from "../shared/questions";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tailoringHome, type Tailor, planTailoring } from "./job-apply";
import { type Config } from "./store";
import { ANSWER_LIMIT, COVER_LIMIT, DraftRequest, LOCAL_DRAFT, RECOVERED, RESUME_LIMIT, UNRANKED, greetingCompany, groundNarrative, letterPenalty, localDraft, narrativeField, prose, rankedFacts, record, unsupportedClaims } from "./draft-checks";
import { Diagnostic, Exchange, Generate, LETTER_DRAFTS, LETTER_PROMPT, LetterPlan, PLAN_PROMPT, ProviderFailure, cliNotice, completeJSON, completionsURL, defaultBudget, draftProviderChain } from "./completion";
import { withinTime } from "./deadline";


function selectionContext(profile: Profile, request: GenerationRequest) {
  // Short per-request references reduce output tokens and do not alter saved IDs.
  // Avoid aliases that collide with existing IDs from older/manual profiles.
  const aliases = (ids: string[], prefix: string) =>
    ids.map((_, i) => {
      let alias = `${prefix}${i + 1}`;
      while (ids.includes(alias)) alias = `_${alias}`;
      return alias;
    });
  const factRefs = aliases(
    profile.facts.map((f) => f.id),
    "f",
  );
  const fields = request.fields.filter(narrativeField).slice(0, ANSWER_LIMIT);
  const fieldRefs = aliases(
    request.fields.map((f) => f.id),
    "q",
  );
  return {
    facts: profile.facts.map((f, i) => ({ id: factRefs[i], text: f.text })),
    fields: fields.map((f, i) => ({ id: fieldRefs[i], label: writerLabel(f), ...(asksForToolList(f.label) ? { note: TOOL_LIST_NOTE } : {}), ...(f.maxLength ? { maxLength: f.maxLength } : {}), ...(f.maxWords ? { maxWords: f.maxWords } : {}), ...(f.maxSentences ? { maxSentences: f.maxSentences } : {}) })),
    factsByRef: new Map(
      profile.facts.flatMap((f, i) => [
        [f.id, f.id],
        [factRefs[i], f.id],
      ]),
    ),
    fieldsByRef: new Map(
      fields.flatMap((f, i) => [
        [f.id, f.id],
        [fieldRefs[i], f.id],
      ]),
    ),
  };
}

function normalizeSelection(
  value: unknown,
  profile: Profile,
  request: DraftRequest,
  context: ReturnType<typeof selectionContext>,
): Narrative {
  const output = record(value);
  let repaired = false;
  const factId = (entry: unknown): string | undefined => {
    const item = record(entry);
    const ref = typeof entry === "string" ? entry : item.factId;
    const id =
      typeof ref === "string" ? context.factsByRef.get(ref) : undefined;
    if (id) return id;
    repaired = true;
    // Legacy responses sometimes omit factId. Only exact confirmed wording
    // can recover identity; paraphrases and fabricated claims cannot.
    if (typeof item.text === "string")
      return profile.facts.find((f) => f.text === item.text)?.id;
  };
  const select = (entries: unknown, limit: number) => {
    if (!Array.isArray(entries)) {
      repaired = true;
      return [];
    }
    const ids = entries.map(factId).filter((id): id is string => Boolean(id));
    return [...new Set(ids)].slice(0, limit);
  };
  // A model that returns nearly every fact has not ranked anything, and taking
  // the first N then yields whatever sits at the top of the resume. Rank those
  // facts here instead of pretending the order was meaningful.
  const offered = select(output.resume, Number.MAX_SAFE_INTEGER);
  const unranked = offered.length > RESUME_LIMIT;
  const resume = unranked
    ? rankedFacts(profile, request, new Set(offered)).map((f) => f.id)
    : offered;
  if (!resume.length)
    return localDraft(
      profile,
      request,
      "AI response did not contain usable resume fact selections.",
    );
  const paragraphs: Narrative["coverLetter"] = [];
  const coverIds: string[] = [];
  // The contract asks for three or four paragraphs; a model that runs on is
  // trimmed rather than allowed to turn the letter into an essay.
  for (const entry of Array.isArray(output.coverLetter)
    ? output.coverLetter.slice(0, 8)
    : []) {
    if (typeof entry === "string") {
      coverIds.push(entry);
      continue;
    }
    const item = record(entry);
    const ids = Array.isArray(item.factIds) ? select(item.factIds, 8) : [];
    const raw = typeof item.text === "string" ? item.text.trim() : "";
    const text = raw ? prose(raw) : "";
    if (text === undefined) {
      repaired = true;
      continue;
    }
    // A model that answers with one block of newline-separated paragraphs is
    // saying the same thing as a list of them.
    if (text)
      for (const part of text
        .split(/\n{2,}/u)
        .map((p) => p.trim())
        .filter(Boolean))
        paragraphs.push({ text: part, factIds: ids });
    else coverIds.push(...ids);
  }
  let cover = select(coverIds, COVER_LIMIT);
  if (request.letter !== false && !paragraphs.length && !cover.length) {
    repaired = true;
    // A ranked selection keeps its order; an unranked one would otherwise put
    // whatever sits at the top of the resume into the letter.
    cover = unranked
      ? rankedFacts(profile, request, new Set(resume))
          .slice(0, COVER_LIMIT)
          .map((f) => f.id)
      : resume.slice(0, COVER_LIMIT);
  }
  const answers: Narrative["answers"] = [];
  if (output.answers !== undefined && !Array.isArray(output.answers))
    repaired = true;
  for (const entry of Array.isArray(output.answers)
    ? output.answers.slice(0, ANSWER_LIMIT)
    : []) {
    const item = record(entry);
    const fieldId =
      typeof item.fieldId === "string"
        ? context.fieldsByRef.get(item.fieldId)
        : undefined;
    const factIds = select(item.factIds, 3);
    const raw = typeof item.text === "string" ? item.text.trim() : "";
    const text = raw ? prose(raw) : "";
    if (!fieldId || !factIds.length || text === undefined) {
      repaired = true;
      continue;
    }
    // A written answer travels as its value; grounding checks it below.
    const field = request.fields.find((field) => field.id === fieldId)!;
    const fitted = text ? fitAnswerLength(text, field) : text;
    // An empty text deliberately means "assemble this answer from factIds";
    // only an oversized written answer with no complete sentence is dropped.
    if (!text || fitted) answers.push({ fieldId, factIds, value: fitted });
  }
  const warnings = [
    ...(repaired ? [RECOVERED] : []),
    ...(unranked ? [UNRANKED] : []),
  ];
  return narrativeSchema.parse(
    groundNarrative(
      {
        resume: resume.map((factId) => ({ factId, text: "" })),
        coverLetter: paragraphs.length
          ? paragraphs
          : [{ text: "", factIds: cover }],
        answers,
        ...(warnings.length ? { warnings } : {}),
      },
      profile,
      request,
    ),
  );
}
// The plan as the writer reads it, with the request's short fact references.
function letterPlan(value: unknown, context: ReturnType<typeof selectionContext>): LetterPlan | undefined {
  const plan = record(value);
  const text = (entry: unknown) => (typeof entry === "string" ? entry.replace(/\s+/gu, " ").trim().slice(0, 400) : "");
  const refOf = new Map(context.facts.map((fact) => [context.factsByRef.get(fact.id), fact.id]));
  const points = (Array.isArray(plan.points) ? plan.points.slice(0, 3) : [])
    .map((entry) => {
      const point = record(entry);
      const refs = (Array.isArray(point.factIds) ? point.factIds : [])
        .map((ref) => (typeof ref === "string" ? refOf.get(context.factsByRef.get(ref)) : undefined))
        .filter((ref): ref is string => Boolean(ref));
      return { requirement: text(point.requirement), factIds: [...new Set(refs)].slice(0, 2), why: text(point.why) };
    })
    .filter((point) => point.requirement && point.factIds.length);
  return points.length ? { intro: text(plan.intro), points, company: text(plan.company) } : undefined;
}

// A letter the applicant likes, for its tone and structure:
// cover-letter-example.md in their tailoring folder. It is theirs, so it
// lives there and never in this repository.
async function letterExample(tailorDir: string): Promise<string> {
  return readFile(join(tailoringHome(tailorDir).notes, "cover-letter-example.md"), "utf8").then(
    (text) => text.trim().slice(0, 6000),
    () => "",
  );
}

// The letter, from the plan: a few drafts at once, and the best of them.
async function writeLetter(
  config: Config,
  { plan, profile, request, context, notes, signal, timeoutMs }: {
    plan: LetterPlan;
    profile: Profile;
    request: DraftRequest;
    context: ReturnType<typeof selectionContext>;
    notes: string[];
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<{ coverLetter?: unknown[]; reason: string; notices: string[] }> {
  const cited = new Set(plan.points.flatMap((point) => point.factIds));
  const example = config.tailorDir ? await letterExample(config.tailorDir) : "";
  const company = greetingCompany(request);
  const body = {
    model: config.model,
    // Drafts that differ are worth choosing between.
    temperature: 0.7,
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: LETTER_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          plan,
          facts: context.facts.filter((fact) => cited.has(fact.id)),
          applicant: {
            education: profile.education.map((row) => [row.title, row.fieldOfStudy, row.organization].filter(Boolean).join(", ")),
            work: profile.work.slice(0, 3).map((row) => [row.title, row.organization].filter(Boolean).join(", ")),
          },
          ...(request.background ? { background: request.background } : {}),
          job: { title: request.title, ...(company ? { company } : {}), description: request.description },
          ...(example ? { example } : {}),
          ...(notes.length ? { notes } : {}),
        }),
      },
    ],
  };
  const support = [
    ...profile.facts.map((fact) => fact.text),
    request.title,
    request.company || "",
    request.background || "",
  ];
  const posting = [request.description, request.pageText || ""];
  const drafts = await Promise.allSettled(
    Array.from({ length: LETTER_DRAFTS }, async () => {
      const exchange: Exchange = { attempts: 0 };
      const output = record(await completeJSON(config, body, withinTime(timeoutMs, signal), exchange));
      const entries = Array.isArray(output.coverLetter) ? output.coverLetter.slice(0, 8) : [];
      const paragraphs = entries.flatMap((entry) => {
        const raw = record(entry).text;
        const text = typeof raw === "string" && raw.trim() ? prose(raw.trim()) : undefined;
        return text ? text.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean) : [];
      });
      if (!paragraphs.length) throw new ProviderFailure("response", "no paragraphs came back");
      const unsupported = unsupportedClaims(paragraphs.join("\n"), support, profile, posting).length;
      return { entries, exchange, penalty: letterPenalty(paragraphs, unsupported) };
    }),
  );
  signal.throwIfAborted();
  const written = drafts.flatMap((draft) => (draft.status === "fulfilled" ? [draft.value] : []));
  if (!written.length) {
    const failure = drafts.find((draft): draft is PromiseRejectedResult => draft.status === "rejected")?.reason;
    const reason = failure instanceof Error && failure.name === "TimeoutError" ? "it took too long" : failure instanceof Error ? failure.message.slice(0, 160) : "it failed";
    return { reason, notices: [] };
  }
  const best = written.reduce((chosen, draft) => (draft.penalty < chosen.penalty ? draft : chosen));
  return { coverLetter: best.entries, reason: "", notices: cliNotice(config, best.exchange) };
}

// Filling works without any provider; drafting says where to choose one.
export const NO_DRAFTING_PROVIDER =
  "Drafting is not set up yet. Choose who writes your résumé, letters and answers (Claude Code, Codex or an API) in Settings → Drafting on the dashboard, then fill again.";

export function provider(
  config: Config,
  options: {
    timeoutMs?: number;
    diagnostic?: (event: Diagnostic) => void;
  } = {},
): Generate {
  return async (request, profile, signal) => {
    signal.throwIfAborted();
    const configured = draftProviderChain(config);
    if (!configured.length)
      throw new Error(NO_DRAFTING_PROVIDER);
    for (const step of configured.filter((candidate) => candidate.provider === "http"))
      completionsURL({ ...config, model: step.model });
    const context = selectionContext(profile, request);
    const draft = request as DraftRequest;
    // Said in the request, where the system prompt's general rules meet
    // this application's facts.
    const notes = [
      ...(draft.letter === false
        ? ['This form has no cover letter field: return "letterPlan": null and plan no letter.']
        : []),
      ...(!request.description.trim()
        ? [
            `The job posting could not be read, so job.description is empty: ${greetingCompany(draft) ? `name ${greetingCompany(draft)} with the role in the opening sentence, but ` : ""}write nothing about the company's product, team, mission or why this company, answer no why or motivation question, and close the letter on the role and the strongest evidence.`,
          ]
        : []),
    ];
    const body = {
      model: config.model,
      temperature: 0,
      // A full-page letter plus the ranking runs about 1000 tokens, and each
      // written answer about 100 more. The cap is headroom, not a target:
      // when the model runs away, salvage keeps whatever finished.
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            PLAN_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            facts: context.facts,
            job: {
              title: request.title,
              // The company the letter names: as the posting or the page
              // writes it, never a URL slug.
              ...(greetingCompany(draft) ? { company: greetingCompany(draft) } : {}),
              description: request.description,
            },
            fields: context.fields,
            ...(notes.length ? { notes } : {}),
          }),
        },
      ],
    };
    const started = Date.now();
    // Writing the letter costs far more than ranking did: the configured
    // model takes 15-20s for this contract, and 30s left no room for a
    // retry or a slow shared endpoint.
    const budget = withinTime(options.timeoutMs ?? defaultBudget(config), signal);
    const exchange: Exchange = { attempts: 0 };
    const report = (
      event: Diagnostic["event"],
      reason?: Diagnostic["reason"],
    ) => {
      const diagnostic: Diagnostic = {
        event,
        elapsedMs: Date.now() - started,
        ...exchange,
        reason,
      };
      // No prompts, model text, applicant IDs, URLs, or credentials in logs.
      if (options.diagnostic) options.diagnostic(diagnostic);
      else console.info("[generation]", JSON.stringify(diagnostic));
    };
    try {
      const parsed = record(await completeJSON(config, body, budget, exchange));
      // A plan is written into a letter by its own request; a model that
      // wrote the letter itself instead keeps it.
      const plan = draft.letter !== false ? letterPlan(parsed.letterPlan, context) : undefined;
      let drafting = draft;
      const letterWarnings: string[] = [];
      if (plan) {
        const background = config.tailorDir ? await skillContext(config.tailorDir).then((c) => c.profile.slice(0, 12_000), () => "") : "";
        if (background) drafting = { ...draft, background };
        const letter = await writeLetter(config, { plan, profile, request: drafting, context, notes, signal, timeoutMs: options.timeoutMs ?? defaultBudget(config) });
        if (letter.coverLetter) parsed.coverLetter = letter.coverLetter;
        else {
          // Assembled from the plan's facts, said why.
          parsed.coverLetter = plan.points.flatMap((point) => point.factIds);
          letterWarnings.push(`The cover letter could not be written (${letter.reason}), so it was put together from your facts. Read it before submitting.`.slice(0, 350));
        }
        letterWarnings.push(...letter.notices);
      }
      const narrative = normalizeSelection(parsed, profile, drafting, context);
      if (letterWarnings.length) narrative.warnings = [...letterWarnings, ...(narrative.warnings || [])].slice(0, 10);
      if (exchange.via && exchange.model) narrative.draftedWith = { provider: exchange.via, model: exchange.model, ...(exchange.viaName ? { name: exchange.viaName } : {}) };
      budget.throwIfAborted();
      const notice = cliNotice(config, exchange);
      if (notice.length)
        narrative.warnings = [...notice, ...(narrative.warnings || [])].slice(
          0,
          10,
        );
      report(
        narrative.warnings?.some((w) => w === LOCAL_DRAFT)
          ? "fallback"
          : narrative.warnings?.length
            ? "repaired"
            : "complete",
      );
      return narrative;
    } catch (error) {
      // A user cancellation or superseding revision NEVER becomes fallback work.
      if (signal.aborted) {
        report("cancelled");
        signal.throwIfAborted();
      }
      if (error instanceof ProviderFailure && error.kind === "configuration") {
        report("configuration-error");
        throw error;
      }
      const reason = budget.aborted
        ? "timeout"
        : error instanceof ProviderFailure && error.kind === "response"
          ? "response"
          : "unavailable";
      report("fallback", reason);
      const draft = localDraft(
        profile,
        request,
        reason === "timeout"
          ? "AI tailoring exceeded its time budget. It was stopped so other applications can continue."
          : reason === "response"
            ? "AI service returned an unusable document-selection response."
            : "AI service is temporarily unavailable or could not be reached.",
      );
      draft.warnings = [
        ...cliNotice(config, exchange),
        ...(draft.warnings || []),
      ].slice(0, 10);
      return draft;
    }
  };
}

// The resume brief and the written answers a queue uses unless given its
// own; a test that replaces one for a single case falls back to these.
export const defaultTailor = (config: Config): Tailor => (request, profile, signal, options) =>
  planTailoring({ ...config, tailorDir: config.tailorDir || "" }, request, profile, signal, options);
export const defaultAnswer = (config: Config): AnswerWriter => async (request, profile, signal, rejected) =>
  writeAnswers(
    config,
    request,
    profile,
    config.tailorDir ? await skillContext(config.tailorDir) : { profile: "", preferences: "", guidance: "", warnings: [] },
    signal,
    rejected ? { rejected } : {},
  );
