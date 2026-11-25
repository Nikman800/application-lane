// Part of the extension's service worker (background.ts): the command line's live line, the inbox of queued links, and the queue sent to the backend.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type QueueSummaryItem, BACKEND, type Application, CONTENT_VERSION } from "../../shared/model";
import { reportOpen } from "../../shared/reload-gate";
import { extensionBuild } from "../../shared/build";
import { redactURL } from "../workspace";
import { canonicalURL, sameOpening } from "../../shared/matching";
import { bg } from "./state";
import { allFrames, api, frameCall, frameDeadline, initial, persist } from "./core";
import { captchaFrame } from "./badges";
import { clearFieldFallback } from "./field-fallback";
import { captureFill, recordings, saveRecording } from "./evidence";
import { attachTab, inspectTab } from "./tabs";
import { uiMessage } from "./ui";
import { checkSteps, pressStepFor } from "./steps";
import { enqueue } from "./queue";
import { applicationForm, differentApplicationStep, knownNonApplication, postingMismatch } from "../application-form";
import { buildKey } from "../../shared/repairs";

const repairStarts = new Set<string>();
const fillBusy = (app: Application) => ["queued", "inspecting", "preparing", "filling"].includes(app.status) ||
  Boolean(app.assisting || app.explicitFill || app.continueAfterSiteFill);

async function inspectApplication(app: Application) {
  if (app.tabId === undefined) throw new Error("The application tab is closed.");
  const page = await frameDeadline(inspectTab(app.tabId, false, true), 6_000);
  const posting = app.postingUrl || app.sourceUrl;
  const documents = page.frames.map(({ observation }) => observation);
  const form = knownNonApplication(page.tab.url || app.url) ||
    postingMismatch(page.tab.url || app.url, posting) || documents.some((document) => postingMismatch(document.url, posting))
    ? undefined : documents.find(applicationForm);
  return { page, documents, form };
}

export function syncQueueSoon() {
  if (bg.syncTimer) {
    bg.syncAgain = true;
    return;
  }
  // After this turn, so the changes made with this one go with it.
  bg.syncTimer = setTimeout(() => {
    sendQueue();
    const settle = () => {
      if (!bg.syncAgain) return void (bg.syncTimer = undefined);
      bg.syncAgain = false;
      sendQueue();
      bg.syncTimer = setTimeout(settle, 2000);
    };
    bg.syncTimer = setTimeout(settle, 2000);
  }, 0);
}
export function sendQueue() {
  if (!bg.token) return;
  const applications: QueueSummaryItem[] = bg.state.applications.map((app) => {
    const last = app.attempts.at(-1);
    return {
      id: app.id,
      url: app.url,
      ...(app.sourceUrl && app.sourceUrl !== app.url ? { sourceUrl: app.sourceUrl.slice(0, 2000) } : {}),
      ...(app.postingUrl ? { postingUrl: app.postingUrl.slice(0, 2000) } : {}),
      company: app.company.slice(0, 300),
      title: app.title.slice(0, 500),
      status: app.status,
      stage: app.workflowStage,
      note: (app.note || "").slice(0, 1000),
      needs: app.missing.filter((item) => /^Required:/.test(item)).map((item) => item.replace(/^Required:\s*/, "").slice(0, 300)).slice(0, 10),
      optional: app.missing.filter((item) => /^Optional unanswered:/.test(item)).map((item) => item.replace(/^Optional unanswered:\s*/, "").slice(0, 300)).slice(0, 10),
      updatedAt: app.updatedAt,
      ...(last ? { lastFill: { status: last.status, note: (last.note || "").slice(0, 1000), completedAt: last.completedAt, filled: last.filled } } : {}),
      reports: app.issueCount || 0,
      // AI is still filling what the profile left: not yet the applicant's.
      ...(app.assisting && (app.status === "awaiting-user" || app.status === "ready") ? { assisting: true } : {}),
    };
  });
  const snapshot = { at: Date.now(), applications };
  void api("/v1/queue", "PUT", snapshot).catch(() => { /* best effort: the next change sends the queue again */ });
  sendLive({ type: "queue", snapshot });
}
export function sendLive(message: unknown) {
  if (bg.live?.readyState === WebSocket.OPEN) bg.live.send(JSON.stringify(message));
}
export function connectLive() {
  if (!bg.token || (bg.live && bg.live.readyState <= WebSocket.OPEN)) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${BACKEND.replace(/^http/, "ws")}/v1/live`);
  } catch {
    return;
  }
  bg.live = socket;
  socket.onopen = () => {
    bg.liveRetry = 1000;
    socket.send(JSON.stringify({ type: "auth", token: bg.token }));
    syncQueueSoon();
    clearInterval(bg.liveBeat);
    // Chrome keeps the worker awake while the socket is in use.
    bg.liveBeat = setInterval(() => sendLive({ type: "ping" }), 20_000);
  };
  socket.onmessage = (event) => {
    let message: { type?: string; id?: string; action?: string; applicationId?: string; data?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === "command" && typeof message.id === "string")
      void initial.then(() => liveCommand(message)).then(
        (detail) => sendLive({ type: "result", id: message.id, ok: true, ...(detail ? { detail } : {}) }),
        (error: Error) => sendLive({ type: "result", id: message.id, ok: false, error: error.message }),
      );
  };
  socket.onclose = () => {
    if (bg.live === socket) bg.live = undefined;
    clearInterval(bg.liveBeat);
    setTimeout(connectLive, bg.liveRetry);
    bg.liveRetry = Math.min(bg.liveRetry * 2, 60_000);
  };
  socket.onerror = () => {};
}
// The extension's current build in a page opened before it was reloaded:
// injected again into each of its frames, where it takes over from the old
// copy. Nothing is reloaded, so nothing entered is lost; reloading a page a
// form posted to asked "Confirm Form Resubmission", and opening its address
// again showed one employer's SuccessFactors only an error.
export async function refreshPast(tabId: number) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => undefined)) || [{ frameId: 0, url: "" }];
  for (const frame of frames) {
    if (frame.frameId !== 0 && captchaFrame(frame.url)) continue;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: ["content.js"], injectImmediately: true }).catch(() => { /* the frame may be gone or not scriptable: skip it */ });
  }
}

// A command from the command line, as the side panel would carry it out:
// fill is Fill this step (it never presses Next or Submit), switch brings the
// application's tab and its window to the front.
// Unlock empty fields (the panel's button, and the fixer's "lane unlock"
// for a lock the fill caused itself: Woodgrove's From Month, locked by the
// fill's own keys read as the applicant's).
export async function unlockEmpty(app: Application) {
    await clearFieldFallback(app);
    delete bg.locks[app.id];
    await persist();
    if (app.tabId) {
      await Promise.allSettled(
        (await allFrames(app.tabId)).map((frame) =>
          chrome.tabs.sendMessage(
            app.tabId!,
            { type: "UNLOCK", applicationId: app.id, operation: app.operation },
            { frameId: frame.frameId },
          ),
        ),
      );
    }
    app.missing = app.missing.filter((item) => !/edit lock/.test(item));
    app.note = "Empty fields are unlocked. Choose Fill this step to fill them.";
    await persist();
    return bg.state;
}
export async function liveCommand(message: { action?: string; applicationId?: string; data?: string }): Promise<string | undefined> {
  // The fixer's "lane own": values on the application's pages that this
  // extension wrote before it kept a record of its writes (ownWrites), so a
  // later fill corrects them. Enovation's start dates, written as 11/2026 by
  // an earlier build, were otherwise the applicant's to keep.
  if (message.action === "unlock") {
    const app = bg.state.applications.find((candidate) => candidate.id === message.applicationId);
    if (!app) throw new Error("No such application.");
    await unlockEmpty(app);
    return "Empty fields unlocked.";
  }
  if (message.action === "own") {
    const app = bg.state.applications.find((candidate) => candidate.id === message.applicationId);
    if (!app) throw new Error("No such application.");
    const entries = (JSON.parse(message.data || "[]") as unknown[]).flatMap((entry) => {
      const { label, value } = (entry || {}) as { label?: unknown; value?: unknown };
      return typeof label === "string" && typeof value === "string" && label && value ? [{ label: label.slice(0, 300), value: value.slice(0, 1000) }] : [];
    });
    app.ownWrites = [...(app.ownWrites || []).filter((own) => !entries.some((entry) => entry.label === own.label && entry.value === own.value)), ...entries].slice(-300);
    await persist();
    return `${entries.length} value${entries.length === 1 ? "" : "s"} marked as this extension's own.`;
  }
  if (message.action === "pick-up") {
    await pickUpInbox();
    return;
  }
  // The fixer's reload (lane reload): a new build without a trip
  // to chrome://extensions. Never under a fill, which it would cut off.
  if (message.action === "reload") {
    // Nor while AI is still filling what a fill left: a reload then lost the
    // two Yes/No answers it had drafted for Bask Health's Workable form, and
    // nothing said so.
    // Nor while the applicant is writing a report: the reload closes it.
    if (reportOpen(bg.reportBeat, Date.now())) throw new Error("Not reloaded: the applicant is writing a report. Try again when it is sent.");
    const busy = bg.state.applications.filter((candidate) => ["inspecting", "preparing", "filling"].includes(candidate.status) || candidate.assisting);
    if (busy.length)
      throw new Error(`Not reloaded: ${busy.map((candidate) => candidate.company || candidate.title).slice(0, 3).join(", ")} ${busy.length === 1 ? "is" : "are"} being filled. Try again when ${busy.length === 1 ? "it finishes" : "they finish"}.`);
    // What each tab has recorded is saved first: a reload drops it from
    // memory, and a fill's recording was left with its first 9 events
    // (Enovation's Paylocity rows).
    await Promise.allSettled([...recordings.keys()].map((tabId) => saveRecording(tabId)));
    setTimeout(() => chrome.runtime.reload(), 300);
    return "Reloading the extension. A page open before it is on the old build until refreshed.";
  }
  const app = bg.state.applications.find((candidate) => candidate.id === message.applicationId);
  if (!app) throw new Error("No such application. It may have been removed.");
  if (message.action === "inspect") {
    const { page, documents, form } = await inspectApplication(app);
    return JSON.stringify({
      applicationId: app.id,
      tabId: page.tab.id,
      url: redactURL(page.tab.url || app.url),
      form: Boolean(form),
      inaccessible: page.inaccessible,
      fields: documents.flatMap((document) => document.fields).slice(0, 300)
        .map(({ label, kind, value, valueText, required, invalid, section, index }) =>
          ({ label, kind, value: (valueText || value).slice(0, 500), required, invalid, section, index })),
      blockers: [...new Set(documents.flatMap((document) => [...document.blockers,
        ...(document.pendingFields || []).map((label) => `${label}: still loading on the site.`)]))],
    });
  }
  if (message.action === "repair-fill") {
    if (repairStarts.has(app.id) || fillBusy(app)) throw new Error("This application is already being filled.");
    if (app.archivedAt || app.workflowStage === "submitted" || app.workflowStage === "abandoned" || app.status === "cancelled")
      throw new Error("This application is closed.");
    const expected = JSON.parse(message.data || "{}") as { build?: string; step?: string };
    if (expected.build && expected.build !== buildKey(extensionBuild)) throw new Error("The extension build changed before refilling.");
    repairStarts.add(app.id);
    try {
      const { page, form } = await inspectApplication(app);
      if (!form || page.tab.id !== app.tabId) throw new Error("Open the tracked application's form before refilling.");
      if (expected.step && differentApplicationStep(expected.step, page.tab.url || form.url))
        throw new Error("The repair is on another application step. Open that step, or use --reason page if the target changed.");
      if (fillBusy(app)) throw new Error("This application is already being filled.");
      await uiMessage({ type: "FILL_STEP", id: app.id, repair: true, repairDocument: form.documentId });
      const attempt = app.attempts.at(-1);
      if (!attempt?.repair) throw new Error("The repair fill did not start.");
      return JSON.stringify({ attemptId: attempt.repairRootId || attempt.id, tabId: attempt.tabId });
    } finally {
      repairStarts.delete(app.id);
    }
  }
  if (message.action === "switch") {
    const tab = app.tabId !== undefined ? await chrome.tabs.get(app.tabId).catch(() => undefined) : undefined;
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return "Switched to its tab.";
    }
    const opened = await chrome.tabs.create({ url: app.url, active: true });
    if (opened.windowId !== undefined) await chrome.windows.update(opened.windowId, { focused: true });
    if (opened.id !== undefined) await attachTab(app, opened.id);
    return "Its tab was closed, so it was opened again.";
  }
  // As the panel's Mark submitted (the TUI's m).
  if (message.action === "submitted") {
    await uiMessage({ type: "SET_WORKFLOW", id: app.id, stage: "submitted", reason: "" });
    return "Marked submitted. Change its stage in the panel to undo.";
  }
  // As the panel's Abandon: any fill stops, and it leaves the open list.
  if (message.action === "abandon") {
    await uiMessage({ type: "CANCEL_APP", id: app.id });
    return "Abandoned. Change its stage in the panel to undo.";
  }
  // Its page loaded again, on the extension's current build (after a
  // reload, a page keeps the old one until refreshed). Never under a fill.
  if (message.action === "refresh") {
    if (fillBusy(app)) throw new Error("It is being filled. Try again when it finishes.");
    if (app.tabId === undefined) throw new Error("Its tab is closed. Switch to it first.");
    await refreshPast(app.tabId);
    return "Its page now runs the current build.";
  }
  if (message.action === "reload-page") {
    if (fillBusy(app)) throw new Error("Wait until the fill finishes before checking persistence.");
    if (reportOpen(bg.reportBeat, Date.now())) throw new Error("The applicant is writing a report. Check persistence after it is sent.");
    const { page, form } = await inspectApplication(app);
    if (!form || app.tabId !== page.tab.id) throw new Error("Open the tracked application's form before checking persistence.");
    await chrome.tabs.reload(page.tab.id!);
    return "Reloading the application page.";
  }
  // The fixer's checks before and after a refill (lane retry, lane check): which build runs, whether the page can be reached and on
  // which build, and a capture of the page as it stands, apart from a fill.
  if (message.action === "about") {
    const tab = app.tabId !== undefined ? await chrome.tabs.get(app.tabId).catch(() => undefined) : undefined;
    const page = tab?.id !== undefined && message.data !== "brief"
      ? await frameDeadline(frameCall(app, 0, { type: "ENGINE_INFO" }), 2_000).then((reply: { version?: string; documentId?: string } | undefined) => reply, () => undefined)
      : undefined;
    return JSON.stringify({
      build: extensionBuild,
      contentVersion: CONTENT_VERSION,
      tab: tab ? { open: true, url: redactURL(tab.url || ""), loading: tab.status === "loading", discarded: Boolean(tab.discarded) } : { open: false },
      // The page's own content script: absent on a page the extension cannot
      // reach (closed, signed out to another site, no access).
      page: page ? { contentVersion: page.version, documentId: page.documentId } : undefined,
      status: app.status,
      busy: fillBusy(app),
      attempt: app.attempts.at(-1),
    });
  }
  if (message.action === "capture") {
    if (app.tabId === undefined) throw new Error("Its tab is closed.");
    if (fillBusy(app)) throw new Error("It is being filled. Check again when it finishes.");
    const id = await captureFill(app, app.tabId, "check");
    if (!id) throw new Error("The page shows no form fields to capture.");
    return id;
  }
  // lane next / lane submit: the step's own buttons, as the panel's Next
  // step and Submit. "steps" is what lane submit shows before asking.
  if (message.action === "steps") return JSON.stringify((await checkSteps(app)).check);
  if (message.action === "next") return pressStepFor(app, "next");
  if (message.action === "submit") {
    if (!message.data) throw new Error("Confirm the Submit button first: lane submit shows it.");
    return pressStepFor(app, "submit", message.data);
  }
  if (message.action === "fill") {
    if (app.tabId === undefined) throw new Error("Its tab is closed. Switch to it first, then fill.");
    await uiMessage({ type: "FILL_STEP", id: app.id });
    return "Filling this step.";
  }
  throw new Error("Unknown command.");
}
export function pickUpInbox(): Promise<void> {
  if (!bg.token) return Promise.resolve();
  bg.pickingUp ||= pickUpOnce().finally(() => {
    bg.pickingUp = undefined;
  });
  return bg.pickingUp;
}
export async function pickUpOnce() {
  const inbox: { url: string }[] = await api("/v1/inbox").catch(() => []);
  if (!inbox.length) {
    if (bg.state.inboxWaiting?.length) {
      bg.state.inboxWaiting = [];
      await persist();
    }
    return;
  }
  const taken: string[] = [];
  const waiting: string[] = [];
  let opened = 0;
  for (const { url } of inbox) {
    let canonical: string;
    try {
      canonical = canonicalURL(url);
    } catch {
      taken.push(url);
      continue;
    }
    if (bg.state.applications.some((app) => app.status !== "cancelled" && [app.url, app.sourceUrl].some((known) => known && sameOpening(known, canonical)))) {
      taken.push(url);
      continue;
    }
    if (!(await chrome.permissions.contains({ origins: [`${new URL(canonical).origin}/*`] }))) {
      waiting.push(url);
      continue;
    }
    if (opened >= 10) continue;
    await enqueue([{ url }]).then(() => {
      taken.push(url);
      opened++;
    }, () => {});
  }
  if (taken.length) await api("/v1/inbox", "DELETE", { urls: taken }).catch(() => { /* a tab that did not open is not worth stopping the rest for */ });
  bg.state.inboxWaiting = waiting.slice(0, 500);
  await persist();
}
