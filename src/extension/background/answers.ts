// Part of the extension's service worker (background.ts): written answers: drafted, reviewed, filled, and saved for next time.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, activeStatuses, type Profile, type GenerationJob, type Proposal, type Observation, normalize, type RecurringAnswer, type Field } from "../../shared/model";
import { applicationQuestion, answerLimitError } from "../../shared/questions";
import { DRAFT_ONLY_NOTE, proposals } from "../../shared/matching";
import { releaseTrustedInput } from "../trusted-input";
import { keptHandAnswer } from "../../shared/hand-answers";
import { questionTopic } from "../../shared/standing";
import { bg } from "./state";
import { applicationForTab, attachTab, draftOnlyTab, inspectTab } from "./tabs";
import { alive, allFrames, answerFills, answerRequests, api, fieldFallbackFills, frameCall, persist } from "./core";
import { clearAnswerDrafts } from "./documents";
import { applicationRoleTitle, forApplication, touch } from "./queue";
import { broadcast } from "./badges";
import { uiMessage } from "./ui";

export async function draftAnswers(app: Application, tabId: number, ids?: string[]) {
  if (applicationForTab(tabId)?.id !== app.id) throw new Error("This tab belongs to a different application.");
  if (app.explicitFill || activeStatuses.includes(app.status) || answerFills.has(app.id) || fieldFallbackFills.has(app.id)) throw new Error("Wait for the current fill to finish before drafting questions.");
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 250 || ids.some((id) => typeof id !== "string"))) throw new Error("Choose valid questions to draft.");
  if (app.tabId !== tabId) await attachTab(app, tabId);
  await clearAnswerDrafts(app);
  const stamp = crypto.randomUUID();
  answerRequests.set(app.id, stamp);
  const operation = app.operation;
  const profile: Profile = forApplication(await api("/v1/profile"), app);
  const captured = await inspectTab(tabId);
  const fields = captured.frames.flatMap((frame) => frame.observation.fields.map((field) => ({ ...field, id: `${frame.frameId}|${field.id}` }))).slice(0, 250);
  const selected = fields.filter(applicationQuestion).filter((field) => !ids || ids.includes(field.id));
  if (!selected.length) throw new Error("No eligible empty questions were found. Existing answers and protected fields are left for you.");
  if (ids && selected.length !== new Set(ids).size) throw new Error("A question changed or was answered. Scan the page again.");
  if (app.operation !== operation || answerRequests.get(app.id) !== stamp) throw new Error("The page changed. Scan and draft again.");
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "answers", applicationId: app.id, operation: Date.now(),
    profileRevision: profile.revision, url: app.sourceUrl || app.url,
    title: app.title, roleTitle: applicationRoleTitle(app), company: app.company,
    description: [app.sourceDescription || "", ...captured.frames.map((frame) => frame.observation.description)].join("\n").slice(0, 25000),
    fields, questionIds: selected.map((field) => field.id),
    postingUrl: app.postingUrl, postingText: app.postingText,
    pageUrls: [...new Set([captured.tab.url || app.url, ...app.tabs.map((tab) => tab.url)])].slice(0, 10),
  });
  if (app.operation !== operation || answerRequests.get(app.id) !== stamp) {
    await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
    throw new Error("The page changed while drafting. Scan and draft again.");
  }
  app.answerSession = {
    jobId: job.id, tabId, operation, profileRevision: profile.revision,
    frames: captured.frames.map((frame) => ({ frameId: frame.frameId, documentId: frame.observation.documentId,
      fields: frame.observation.fields.filter((field) => selected.some((selectedField) => selectedField.id === `${frame.frameId}|${field.id}`)),
    })).filter((frame) => frame.fields.length),
  };
  await persist();
  return bg.state;
}
export async function fillReviewedAnswers(app: Application, message: any) {
  if (await draftOnlyTab(message.tabId, app.url)) throw new Error(DRAFT_ONLY_NOTE);
  const session = app.answerSession;
  if (!session || session.jobId !== message.jobId || session.tabId !== message.tabId || app.operation !== session.operation) throw new Error("These drafts are stale. Scan and draft the current page again.");
  if (app.explicitFill || activeStatuses.includes(app.status) || answerFills.has(app.id) || fieldFallbackFills.has(app.id)) throw new Error("Wait for the current fill to finish.");
  const selected = message.answers as { fieldId: string; value: string }[];
  if (!Array.isArray(selected) || !selected.length || selected.length > 250 || selected.some((answer) => !answer || typeof answer.fieldId !== "string" || typeof answer.value !== "string" || !answer.value.trim() || answer.value.length > 4000) || new Set(selected.map((answer) => answer.fieldId)).size !== selected.length) throw new Error("Choose valid reviewed answers to fill.");
  answerFills.add(app.id);
  let fillOperation: number | undefined;
  const results: { fieldId: string; ok: boolean; reason?: string }[] = [];
  try {
    const [profile, job, captured]: [Profile, GenerationJob, Awaited<ReturnType<typeof inspectTab>>] = await Promise.all([
      api("/v1/profile"), api(`/v1/jobs/${session.jobId}`), inspectTab(session.tabId),
    ]);
    if (profile.revision !== session.profileRevision || app.operation !== session.operation || app.answerSession !== session || job.status !== "complete") throw new Error("The profile or page changed. Draft these questions again.");
    for (const answer of selected) {
      const frame = session.frames.find((frame) => frame.fields.some((field) => `${frame.frameId}|${field.id}` === answer.fieldId));
      const field = frame?.fields.find((field) => `${frame.frameId}|${field.id}` === answer.fieldId);
      if (!frame || !field || !job.answerDrafts?.some((draft) => draft.fieldId === answer.fieldId)) throw new Error("This answer is not part of the current review.");
      const limit = answerLimitError(answer.value, field);
      if (limit) throw new Error(`${field.label.slice(0, 80)}: ${limit}`);
    }
    if (session.tabId !== app.tabId) throw new Error("Make this tab the application's fill target, then draft again.");
    app.operation++;
    fillOperation = app.operation;
    touch(app, "filling", "Filling reviewed answers…");
    await persist();
    for (const snapshot of session.frames) {
      const answers = selected.filter((answer) => snapshot.fields.some((field) => `${snapshot.frameId}|${field.id}` === answer.fieldId));
      if (!answers.length) continue;
      const frame = captured.frames.find((frame) => frame.frameId === snapshot.frameId);
      if (!alive(app, fillOperation)) throw new Error("The reviewed fill was paused or superseded.");
      if (!frame || frame.observation.documentId !== snapshot.documentId) {
        results.push(...answers.map((answer) => ({ fieldId: answer.fieldId, ok: false, reason: "The page navigated or reloaded. Draft again." })));
        continue;
      }
      const proposals: Proposal[] = [];
      for (const answer of answers) {
        const original = snapshot.fields.find((field) => `${snapshot.frameId}|${field.id}` === answer.fieldId)!;
        const current = frame.observation.fields.find((field) => field.id === original.id);
        if (!current || !applicationQuestion(current) || current.revision !== original.revision || current.label !== original.label || current.value !== original.value) {
          results.push({ fieldId: answer.fieldId, ok: false, reason: "This field changed, was answered, or is protected. Your edits were kept." });
          continue;
        }
        const limit = answerLimitError(answer.value, current);
        if (limit) { results.push({ fieldId: answer.fieldId, ok: false, reason: limit }); continue; }
        proposals.push({ fieldId: original.id, value: answer.value, expectedValue: original.value, revision: original.revision, source: "reviewed-answer" });
      }
      if (!proposals.length) continue;
      try {
        await frameCall(app, frame.frameId, { type: "BIND", documentId: snapshot.documentId, locks: bg.locks[app.id] || [], replaceSiteValues: false });
        if (!alive(app, fillOperation)) throw new Error("Fill was paused or superseded.");
        await frameCall(app, frame.frameId, { type: "RESUME", documentId: snapshot.documentId });
        if (!alive(app, fillOperation)) throw new Error("Fill was paused or superseded.");
        const result = await frameCall(app, frame.frameId, { type: "APPLY", documentId: snapshot.documentId, proposals });
        results.push(...result.results.map((result: { id: string; ok: boolean; reason?: string }) => ({ fieldId: `${frame.frameId}|${result.id}`, ok: result.ok, reason: result.reason })));
      } catch (error) {
        results.push(...proposals.map((proposal) => ({ fieldId: `${snapshot.frameId}|${proposal.fieldId}`, ok: false, reason: (error as Error).message })));
      }
    }
    if (alive(app, fillOperation)) {
      session.operation = fillOperation;
      const count = results.filter((result) => result.ok).length;
      app.filled += count;
      touch(app, "awaiting-user", `${count} reviewed answer${count === 1 ? "" : "s"} filled. Review the form before continuing.`);
      await persist();
    }
    return { state: bg.state, results };
  } finally {
    if (fillOperation !== undefined && app.operation === fillOperation) {
      if (app.status === "filling") touch(app, "awaiting-user", "Reviewed fill stopped. Review the form and draft again if needed.");
      await broadcast(app, "PAUSE");
      await releaseTrustedInput(session.tabId);
      await persist();
    }
    answerFills.delete(app.id);
  }
}

// Answers the applicant entered on this page that the profile cannot give
// yet: candidates for the saved-answer bank, reused for identical questions.
// The fields the applicant answered by hand on a tab, with what they hold.
export async function editedAnswers(tabId: number): Promise<Observation["fields"]> {
  const fields: Observation["fields"] = [];
  for (const frame of await allFrames(tabId)) {
    if (!/^https?:/.test(frame.url)) continue;
    const result = await chrome.tabs
      .sendMessage(tabId, { type: "EDITED_ANSWERS" }, { frameId: frame.frameId })
      .catch(() => undefined);
    if (result?.ok) fields.push(...result.data);
  }
  return fields;
}
export async function suggestAnswers(tabId: number) {
  const savedProfile: Profile = await api("/v1/profile");
  const app = applicationForTab(tabId);
  const profile = app ? forApplication(savedProfile, app) : savedProfile;
  const fields = await editedAnswers(tabId);
  const saved = new Map(
    profile.answers.map((answer) => [normalize(answer.question), answer.answer]),
  );
  const seen = new Set<string>();
  return fields
    .filter((field) => {
      const question = normalize(field.label);
      if (!question || seen.has(question)) return false;
      seen.add(question);
      // Row fields (a school, an employer) belong to the profile's history.
      if (/education|experience|employment|work/.test(normalize(field.section || "")))
        return false;
      if (saved.get(question) === field.value) return false;
      // Anything the profile already answers needs no saved answer.
      return !proposals([{ ...field, value: "", protected: false }], profile).length;
    })
    .map((field) => ({
      question: field.label.slice(0, 1000),
      answer: field.value.slice(0, 4000),
      replaces: saved.get(normalize(field.label)),
    }));
}

// The answers the applicant gives by hand, kept with each application a
// moment after they edit: one given the same way on several applications is
// offered to save (recurringAnswers), so they need not add it themselves.
// Not a school's or job's row (the profile's history), a written answer, or
// a signature.
export const handAnswerTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function recordHandAnswersSoon(app: Application) {
  clearTimeout(handAnswerTimers.get(app.id));
  handAnswerTimers.set(app.id, setTimeout(() => {
    handAnswerTimers.delete(app.id);
    void recordHandAnswers(app).catch(() => { /* best effort: the hand answers are saved again on the next edit */ });
  }, 4000));
}
export async function recordHandAnswers(app: Application) {
  if (app.tabId === undefined) return;
  const fields = await editedAnswers(app.tabId);
  // (Entries kept before keptHandAnswer's later checks are dropped here.)
  const kept = new Map((app.handAnswers || [])
    .filter((entry) => keptHandAnswer({ label: entry.question, value: entry.answer }))
    .map((entry) => [normalize(entry.question), entry]));
  for (const field of fields) {
    if (!keptHandAnswer(field)) continue;
    // Their own edit, not a value the site put there (a parsed resume).
    if (!/^a real|from (a real|an edit saved)/.test(field.protectedReason || "")) continue;
    kept.set(normalize(field.label),{ question: field.label.slice(0, 300), answer: field.value.slice(0, 200), at: Date.now() });
  }
  if (!kept.size) return;
  app.handAnswers = [...kept.values()].sort((a, b) => a.at - b.at).slice(-80);
  await persist();
}
// Answers given by hand the same way on at least two applications, grouped
// by the question as the fill reads it (its standing topic, else its exact
// wording), that the profile does not already give and were not dismissed.
export async function recurringAnswers(): Promise<RecurringAnswer[]> {
  const profile: Profile = await api("/v1/profile");
  const groups = new Map<string, RecurringAnswer & { seen: Set<string> }>();
  const field = (label: string): Field => ({ id: "recurring", label, kind: "text", required: false, value: "", options: [], revision: 1, protected: false });
  for (const app of bg.state.applications) {
    const effective = forApplication(profile, app);
    for (const entry of app.handAnswers || []) {
      // One kept before keptHandAnswer's later checks (a list's hidden value).
      if (!keptHandAnswer({ label: entry.question, value: entry.answer })) continue;
      if (proposals([field(entry.question)], effective).length) continue;
      const asked = questionTopic(entry.question) || normalize(entry.question);
      const key = `${asked}=${normalize(entry.answer)}`;
      const group = groups.get(key) || { key, question: entry.question, answer: entry.answer, applications: 0, seen: new Set<string>() };
      group.seen.add(app.id);
      group.applications = group.seen.size;
      groups.set(key, group);
    }
  }
  const saved = new Set(profile.answers.flatMap((answer) => [normalize(answer.question), questionTopic(answer.question) || ""]).filter(Boolean));
  const dismissed = new Set(bg.state.settings.dismissedAnswers || []);
  return [...groups.values()]
    .filter((group) => group.applications >= 2 && !dismissed.has(group.key))
    .filter((group) => !saved.has(questionTopic(group.question) || normalize(group.question)))
    .sort((a, b) => b.applications - a.applications)
    .slice(0, 20)
    .map(({ seen: _seen, ...group }) => group);
}
export async function dismissRecurringAnswer(key: unknown) {
  if (typeof key !== "string" || !key || key.length > 600) throw new Error("Choose an answer to dismiss.");
  bg.state.settings.dismissedAnswers = [...new Set([...(bg.state.settings.dismissedAnswers || []), key])].slice(-300);
  await persist();
  return recurringAnswers();
}

export async function saveAnswers(
  answers: { question: string; answer: string }[],
): Promise<Profile> {
  if (!Array.isArray(answers) || !answers.length)
    throw new Error("Choose at least one answer to save.");
  const profile: Profile = await api("/v1/profile");
  const merged = [...profile.answers];
  for (const { question, answer } of answers) {
    const key = normalize(String(question));
    if (!key || typeof answer !== "string") continue;
    const existing = merged.findIndex((item) => normalize(item.question) === key);
    const entry = { question: String(question).slice(0, 1000), answer: answer.slice(0, 4000) };
    if (existing >= 0) merged[existing] = entry;
    else merged.push(entry);
  }
  // Through the ordinary profile save, which also pauses active fills.
  return uiMessage({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, answers: merged.slice(0, 300) },
  });
}
