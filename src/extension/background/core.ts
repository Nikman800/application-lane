// Part of the extension's service worker (background.ts): its state on disk, the backend API, and messages to the page's frames.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Observation, activeStatuses, BACKEND, type Application, type SignaturePolicy, type Proposal, type Field } from "../../shared/model";
import { migrateQueue, migrateLocks, LOCKS_VERSION } from "../workspace";
import { type MainWorldRequest } from "../../engine/page/mainWorld";
import { installPageTimers, PAGE_TIMER_EVENT } from "../../engine/page/timers";
import { canonicalURL } from "../../shared/matching";
import { bg } from "./state";
import { connectLive, syncQueueSoon } from "./live";
import { badgesSoon, broadcast } from "./badges";
import { tabGroupsSoon } from "./tab-groups";
import { syncSubmissions, tidyFinishedNotes } from "./submissions";
import { observations, sameFormPage } from "./tabs";
import { touch } from "./queue";


export type Frame = { frameId: number; observation: Observation };
export const runners = new Map<string, number>();
export const dirty = new Set<string>();
// Documents handed to a page's configured upload dialog, per page and kind,
// so a later fill of the same page does not upload them again.
export const configUploads = new Set<string>();
export const answerRequests = new Map<string, string>();
export const answerFills = new Set<string>();
export const fieldFallbackRequests = new Map<string, string>();
export const fieldFallbackFills = new Set<string>();
export const backoff = new Map<string, number>();

export function persist() {
  syncQueueSoon();
  badgesSoon();
  tabGroupsSoon();
  const snapshot = structuredClone({ queue: bg.state, locks: bg.locks });
  // Document text lives in the backend; avoid repeatedly copying resumes into
  // Chrome's quota-limited queue storage for every status transition.
  for (const app of snapshot.queue.applications) delete app.narrative;
  bg.saving = bg.saving
    .catch(() => { /* an earlier save's failure was already reported to its own caller */ })
    .then(() => chrome.storage.local.set(snapshot));
  return bg.saving;
}
export const initial = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const data = await chrome.storage.local.get([
    "queue",
    "locks",
    "token",
    "locksVersion",
  ]);
  if (data.queue) bg.state = migrateQueue(data.queue);
  const migrated = migrateLocks(data.locks, data.locksVersion);
  bg.locks = migrated.locks;
  if (migrated.migrated)
    await chrome.storage.local.set({ locks: bg.locks, locksVersion: LOCKS_VERSION });
  bg.token = data.token || "";
  for (const app of bg.state.applications) {
    // A worker's unobserved downtime cannot be measured as active work.
    app.activeSince = undefined;
    // Nothing survives a restart, so no attempt can still be in progress.
    for (const attempt of app.attempts)
      if (!attempt.completedAt) {
        attempt.completedAt = attempt.startedAt;
        attempt.status = "paused";
        attempt.note ||= "Interrupted.";
      }
    // Nor can the suggestion step that follows a fill.
    app.assisting = false;
    if (
      activeStatuses.includes(app.status) ||
      (app.status === "queued" && app.explicitFill)
    ) {
      if (app.fieldFallbackSession?.jobId)
        void api(`/v1/jobs/${app.fieldFallbackSession.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
      app.fieldFallbackSession = undefined;
      app.operation++;
      app.explicitFill = false;
      app.status = "paused";
      app.note =
        "Background worker restarted. Choose Fill this step to re-inspect safely.";
      if (app.jobId)
        void api(`/v1/jobs/${app.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
      if (app.tabId) void broadcast(app, "PAUSE");
    }
  }
  tidyFinishedNotes();
  await persist();
  void syncSubmissions().catch(() => { /* best effort: the history syncs again on the next pump */ });
  await chrome.alarms.create("queue-recovery", { periodInMinutes: 0.5 });
  await chrome.alarms.create("inbox", { periodInMinutes: 1 });
  connectLive();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
})();

// Said wherever the backend cannot be reached.
export const BACKEND_DOWN =
  "Application Lane's backend is not running on this computer. Open a terminal in the Application Lane folder, run npm start (or application-lane if you installed it), keep that window open, and try again.";

// Whether a backend answers, and whether a pairing code can be typed now.
// Asked without the token: the handshake is the one unauthenticated route.
export async function hello(): Promise<{ running: boolean; paired?: boolean; pairedHere?: boolean; pairing?: string; version?: string }> {
  try {
    const response = await fetch(`${BACKEND}/v1/hello`, { method: "POST", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { running: true };
    const data = await response.json();
    return { running: true, paired: Boolean(data.paired), pairedHere: Boolean(data.pairedHere), pairing: String(data.pairing || ""), version: String(data.version || "") };
  } catch {
    return { running: false };
  }
}

// The token, once paired: kept, the live line restarted, submissions synced.
export async function adoptToken(next: string) {
  bg.token = next;
  await chrome.storage.local.set({ token: bg.token });
  bg.submissionsSynced = false;
  void syncSubmissions().catch(() => { /* best effort: the history syncs again on the next pump */ });
  // Paired again (perhaps with another token): the live line starts over.
  bg.live?.close();
  connectLive();
}

export async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  if (!bg.token) throw new Error("Pair with the local backend first.");
  let response: Response;
  try {
    response = await fetch(`${BACKEND}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bg.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(BACKEND_DOWN);
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Backend HTTP ${response.status}`);
  return data;
}
export const alive = (app: Application, operation: number) =>
  app.operation === operation &&
  !["paused", "cancelled", "failed"].includes(app.status);
// What each application's fill may sign (Settings → Signatures), as its last
// fill read the profile.
export const signingPolicies = new Map<string, SignaturePolicy>();
export async function frameCall(
  app: Application,
  frameId: number,
  message: Record<string, unknown>,
) {
  if (!app.tabId) throw new Error("Application tab is closed.");
  const operation = app.operation;
  // Writes carry what the applicant lets a fill sign, as this application's
  // fill read it from the profile; unknown (after a restart), nothing.
  const payload = {
    applicationId: app.id,
    operation,
    ...(message.type === "APPLY" ? { signatures: signingPolicies.get(app.id) ?? "never" } : {}),
    ...message,
  };
  let result;
  try {
    result = await chrome.tabs.sendMessage(app.tabId, payload, { frameId });
  } catch (error) {
    const original = new Error(
      `${(error as Error).message} [command ${String(message.type)}, tab ${app.tabId}, frame ${frameId}, document ${String(message.documentId || "unspecified")}, operation ${operation}${message.documentURL ? `, url ${String(message.documentURL).split(/[?#]/)[0]}` : ""}]`,
      { cause: error },
    );
    // Chrome can lose a read receiver when the page replaces its document.
    // Reinstall and retry one read only. Mutations keep their existing
    // navigation handling and are never replayed after an uncertain result.
    // The applicant's Next step and Submit check (STEP_CHECK) is a read too,
    // and theirs, made whatever the fill's state: a tab whose script an
    // extension reload left behind answered nothing, and its Submit
    // application was "not found".
    const own = message.type === "STEP_CHECK";
    const current = () => own || alive(app, operation);
    if (!["ENGINE_INFO", "BIND", "INSPECT", "STEP_CHECK"].includes(String(message.type)) ||
      !/receiving end does not exist/i.test(original.message) || !current()) throw original;
    try {
      await chrome.scripting.executeScript({ target: { tabId: app.tabId, frameIds: [frameId] }, files: ["content.js"], injectImmediately: true });
      if (!current()) throw new Error("Application operation is stale or paused.");
      result = await chrome.tabs.sendMessage(app.tabId, payload, { frameId });
    } catch (recoveryError) {
      // Re-injection can itself fail because Chrome has removed the frame.
      // Keep the original transport error so the caller can re-observe the
      // navigation, rather than replacing it with an unrelated new error.
      original.message += `; read recovery failed: ${(recoveryError as Error).message}`;
      throw original;
    }
  }
  if (!result?.ok)
    throw new Error(
      result?.error || "Application content script did not respond.",
    );
  return result.data;
}
// Applications whose dropdown option lists are being read for a review
// (draftFieldFallback). Outside a fill, the page-world bridge serves only
// those reads: listing a dropdown's options, and closing it choosing nothing.
export const optionReads = new Set<string>();
export const readingOptions = (app: Application, request: MainWorldRequest | undefined) =>
  optionReads.has(app.id) &&
  Boolean(request) &&
  !request!.file &&
  !request!.event &&
  !request!.values?.some(Boolean) &&
  (request!.method === "reactSelectOptions" || request!.method === "reactSelectChoose" || request!.method === "sfPicklistOptions");
// When each application was first seen waiting on a tab that is still loading.
export const loadingSince = new Map<string, number>();
export function frameDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Frame did not respond in time.")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
// A fill goes on in a minimized window or a background tab: while it runs,
// the page's own timers keep their delays (engine/page/timers.ts).
export async function pageTimers(tabId: number, on: boolean) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      injectImmediately: true,
      func: installPageTimers,
      args: [PAGE_TIMER_EVENT, on],
    })
    .catch(() => { /* the tab or frame may be gone: nothing to switch */ });
  for (const frame of await allFrames(tabId).catch(() => []))
    await chrome.tabs
      .sendMessage(tabId, { type: "PAGE_TIMERS", on }, { frameId: frame.frameId })
      .catch(() => { /* the frame may be gone: nothing to tell */ });
}

// The passes that fill answers after the main fill (the model's, the
// reviewed ones) also run in a hidden tab: a list one of them opened on
// one employer's form came 8.5 seconds late.
export async function withPageTimers<T>(app: Application, tabId: number | undefined, work: () => Promise<T>): Promise<T> {
  if (tabId !== undefined) await pageTimers(tabId, true);
  try {
    return await work();
  } finally {
    if (tabId !== undefined && !runners.has(app.id) && !activeStatuses.includes(app.status))
      await pageTimers(tabId, false);
  }
}

export async function allFrames(tabId: number) {
  return (await chrome.webNavigation.getAllFrames({ tabId })) || [];
}
export async function reinspectNavigation(app: Application, frameId: number, before: string, operation: number, error: Error, beforeURL?: string): Promise<Frame | undefined> {
  if (!/message (channel|port).*closed|receiving end does not exist|no frame with id \d+/i.test(error.message)) throw error;
  const deadline = Date.now() + 5_000;
  while (alive(app, operation) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const tab = app.tabId && await chrome.tabs.get(app.tabId).catch(() => undefined);
    // The same form at a new query (iCIMS reloads its form's frame with a new
    // csrf) is still this application's page.
    if (!tab || (canonicalURL(tab.url || "") !== canonicalURL(app.url) && !sameFormPage(tab.url || "", app.url))) throw error;
    if (tab.status !== "complete") continue;
    const read = (await observations(app, operation)).frames;
    const sameFrame = read.find((candidate) => candidate.frameId === frameId);
    // An iframe can be replaced entirely, giving the same application document
    // a new frame ID. Only one exact old-URL match is eligible; ambiguity stays
    // a failure, and the original write is never resent.
    const relocated = !sameFrame && beforeURL
      ? read.filter((candidate) => (candidate.observation.url === beforeURL || sameFormPage(candidate.observation.url, beforeURL)) && candidate.observation.documentId !== before) : [];
    const fresh = sameFrame || (relocated.length === 1 ? relocated[0] : undefined);
    if (!alive(app, operation)) return;
    if (!fresh || (beforeURL && fresh.observation.url !== beforeURL && !sameFormPage(fresh.observation.url, beforeURL)) || fresh.observation.documentId === before || fresh.observation.paused || fresh.observation.fields.length < 3) continue;
    dirty.delete(app.id);
    return fresh;
  }
  if (!alive(app, operation)) return;
  throw error;
}
// A document can disappear after a scalar write starts. Re-observe a fresh
// document on the same application URL, and leave the interrupted writes for
// review. Never replay the original APPLY or change missing-field scoring.
export async function applyFrame(app: Application, frame: Frame, proposed: Proposal[], operation: number) {
  const fields = new Map(frame.observation.fields.map((field) => [field.id, field.label]));
  return frameCall(app, frame.frameId, {
    type: "APPLY", documentId: frame.observation.documentId, proposals: proposed,
  // frameCall answers with whatever the page sent: typed loosely here as
  // before, and only its results read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }).then((result: any) => {
    // Each value written, kept with the application (see ownWrites).
    for (const written of (result?.results || []) as { id: string; ok: boolean }[]) {
      const proposal = proposed.find((candidate) => candidate.fieldId === written.id);
      const label = fields.get(written.id);
      if (!written.ok || !proposal || !label || !proposal.value) continue;
      // Rows share a label ("Start Date" in each job), so every value
      // written under it is kept.
      const entry = { label: label.slice(0, 300), value: proposal.value.slice(0, 1000) };
      app.ownWrites = [...(app.ownWrites || []).filter((other) => !(other.label === entry.label && other.value === entry.value)), entry].slice(-300);
    }
    return result;
  }).catch(async (error: Error) => {
    const fresh = await reinspectNavigation(app, frame.frameId, frame.observation.documentId, operation, error, frame.observation.url);
    if (fresh) frame.frameId = fresh.frameId;
    return { results: [], observation: fresh?.observation || frame.observation, navigationInterrupted: Boolean(fresh) };
  });
}
// The fields left empty, each checkbox question once: its boxes are one
// answer, given when any is ticked, and named by the question, not by a box
// ("New York, NY"). one employer's required "locations you would relocate to" was
// listed as two optional boxes.
export function emptyFields(fields: Field[]): Field[] {
  const questionOf = (field: Field) => (field.kind === "checkbox" && field.question ? `${field.section || ""}|${field.index ?? 0}|${field.question}` : "");
  const answered = new Set(fields.filter((field) => field.value && questionOf(field)).map(questionOf));
  const listed = new Set<string>();
  // A list's own search box (select2) is no question of its own: the list
  // beside it, under the same label, holds the answer.
  const place = (field: Field) => `${field.section || ""}|${field.index ?? 0}|${field.label}`;
  const chosen = new Set(fields.filter((field) => field.value && field.kind !== "searchbox").map(place));
  return fields.flatMap((field) => {
    if (field.value) return [];
    if (field.kind === "searchbox" && chosen.has(place(field))) return [];
    const question = questionOf(field);
    if (!question) return [field];
    if (answered.has(question) || listed.has(question)) return [];
    listed.add(question);
    return [{ ...field, label: field.question! }];
  });
}
// The page moved on to another step while a fill was working on the last:
// not a failure. The fill ends, and the new step waits for Fill this step.
export async function endOnStepChange(app: Application) {
  touch(app, "awaiting-user", "The page moved to another step. Choose Fill this step to fill it.");
  app.completedAt = Date.now();
  app.explicitFill = false;
  app.continueAfterSiteFill = false;
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    attempt.completedAt = Date.now();
    attempt.status = "paused";
    attempt.note = app.note?.slice(0, 350);
    attempt.filled = app.filled;
  }
  await persist();
}
export async function reviewInterruptedWrite(app: Application, observation: Observation) {
  app.missing = [
    "The site reloaded during a field write. The interrupted write was not retried; review the remaining fields manually.",
    ...emptyFields(observation.fields).filter((field) => field.required).map((field) => `Required: ${field.label}`),
  ].slice(0, 60);
  touch(app, "awaiting-user", "The application changed during a write. Review the remaining fields before filling again.");
  app.completedAt = Date.now();
  app.explicitFill = false;
  await persist();
}
