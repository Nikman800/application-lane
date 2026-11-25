// Part of the extension's service worker (background.ts): fill captures, page recordings and issue reports.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, activeStatuses, CONTENT_VERSION, type IssueReport, type IssueImage, ISSUE_IMAGE_LIMIT, type Recording } from "../../shared/model";
import { captureHar, capturing, startCapture } from "../network-capture";
import { redactURL } from "../workspace";
import { usableImages } from "../../shared/issue-images";
import { installMonitor, removeMonitor } from "../../engine/page/monitor";
import { bg } from "./state";
import { applicationForTab, networkSummary, pageEvidence } from "./tabs";
import { applicationForm, knownNonApplication, postingMismatch } from "../application-form";
import { BACKEND_DOWN, allFrames, api, persist } from "./core";
import { invalidate } from "./run";


// Every fill leaves a capture of the page as the fill left it, with its
// network traffic, like an issue report the applicant did not have to file.
// The eval replays them offline and checks them for problems on every form
// (eval/check.ts), so a bug shows up from the fills already made instead of
// waiting for a report. Kept locally; the backend keeps only the newest.
export const captureTimers = new Map<number, ReturnType<typeof setTimeout>>();
export const capturesInFlight = new Set<number>();
export function scheduleFillCapture(app: Application, delayMs = 4000, tries = 0) {
  const tabId = app.tabId;
  if (tabId === undefined || bg.state.settings.networkCapture !== "on") return;
  clearTimeout(captureTimers.get(tabId));
  captureTimers.set(tabId, setTimeout(() => {
    captureTimers.delete(tabId);
    // Wait out the rest of the fill: a continuation after the site rewrote
    // the form, and the model's suggestions, both still write to the page.
    if (app.tabId !== tabId) return;
    if (activeStatuses.includes(app.status) || app.status === "queued" || app.explicitFill || app.continueAfterSiteFill || app.assisting) {
      if (tries < 30) scheduleFillCapture(app, 4000, tries + 1);
      return;
    }
    if (capturesInFlight.has(tabId)) return;
    capturesInFlight.add(tabId);
    void captureFill(app, tabId).catch(() => { /* evidence is best effort: a failed capture must not stop the fill */ }).finally(() => capturesInFlight.delete(tabId));
  }, delayMs));
}
export async function captureFill(app: Application, tabId: number, trigger: "fill" | "check" = "fill"): Promise<string | undefined> {
  const { tab, frames } = await pageEvidence(tabId);
  if (!frames.some(({ observation }) => observation &&
    (observation.fields.length || observation.pendingFields?.length || observation.atReview || observation.canAdvance))) return;
  // The recording as of now, not as of its last checkpoint: a capture named a
  // recording that ended before the pause it was taken after, and the cause
  // could not be read (Woodgrove's Workday).
  const active = recordings.get(tabId);
  if (active) {
    const saved = await saveRecording(tabId).catch(() => undefined);
    if (saved?.saved) app.lastRecordingId = saved.recording.id;
  }
  const network = await captureHar(tabId);
  const capture = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    trigger,
    form: !knownNonApplication(tab.url) && !postingMismatch(tab.url, app.postingUrl || app.sourceUrl) &&
      frames.some(({ observation }) => observation && applicationForm(observation) &&
        !postingMismatch(observation.url, app.postingUrl || app.sourceUrl)),
    applicationId: app.id,
    application: {
      title: app.title,
      company: app.company,
      workflowStage: app.workflowStage,
      status: app.status,
      operation: app.operation,
      missing: app.missing,
      attempts: app.attempts.slice(-5),
      configNotes: app.configNotes || [],
    },
    tab: {
      tabId,
      url: redactURL(tab.url),
      title: tab.title || new URL(tab.url).hostname,
      ats: frames.find((frame) => frame.observation)?.observation?.ats,
    },
    extension: { version: chrome.runtime.getManifest().version, contentVersion: CONTENT_VERSION },
    ...(app.lastRecordingId ? { recordingId: app.lastRecordingId } : {}),
    ...(network ? { network: networkSummary(network) } : {}),
    frames,
  };
  await api("/v1/captures", "POST", { ...capture, ...(network ? { har: network.har } : {}) });
  return capture.id;
}

export async function reportIssue(
  tabId: number,
  category: IssueReport["category"],
  note: string,
  images: IssueImage[] = [],
) {
  const app = applicationForTab(tabId);
  if (app && (app.explicitFill || activeStatuses.includes(app.status)))
    await invalidate(
      app,
      "paused",
      "Paused to capture a consistent issue report.",
    );
  // Keep recording if saving fails or the applicant continues on this page.
  const recorded = recordings.has(tabId) ? await saveRecording(tabId).catch(() => undefined) : undefined;
  // Reports name an immutable snapshot, never the ongoing recording file.
  if (recorded) recorded.recording = { ...recorded.recording, id: crypto.randomUUID(), auto: false };
  if (recorded && app) app.lastRecordingId = recorded.recording.id;
  const { tab, frames } = await pageEvidence(tabId);
  const report: IssueReport = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    category,
    note: note.slice(0, 4000),
    applicationId: app?.id,
    application: app
      ? {
          title: app.title,
          company: app.company,
          workflowStage: app.workflowStage,
          status: app.status,
          operation: app.operation,
          missing: app.missing,
          attempts: app.attempts,
          // Which site-config steps failed and why: what a fix needs.
          configNotes: app.configNotes || [],
        }
      : undefined,
    tab: {
      tabId,
      url: redactURL(tab.url),
      title: tab.title || new URL(tab.url).hostname,
      ats: frames.find((frame) => frame.observation)?.observation?.ats,
    },
    extension: {
      version: chrome.runtime.getManifest().version,
      contentVersion: CONTENT_VERSION,
    },
    // What happened: the applicant's own recording if one is running, else
    // the last fill's, which every fill makes.
    ...((recorded?.recording.id || app?.lastRecordingId)
      ? { recordingId: recorded?.recording.id || app?.lastRecordingId }
      : {}),
    frames,
  };
  const network = bg.state.settings.networkCapture === "on" ? await captureHar(tabId) : undefined;
  if (network) report.network = networkSummary(network);
  const bundle = { ...report, ...(network ? { har: network.har } : {}),
    ...(recorded ? { recording: recorded.recording } : {}),
    ...(usableImages(images).length ? { images: usableImages(images).slice(0, ISSUE_IMAGE_LIMIT.count) } : {}) };
  let saved = true;
  let saveError = "";
  try {
    // The backend publishes the report only after all evidence is on disk.
    // A backend restarting for a few seconds must not turn a report into a
    // download that never reaches the fixer: asked again for twelve seconds.
    for (let attempt = 0; ; attempt++)
      try {
        await api("/v1/issues", "POST", bundle);
        break;
      } catch (down) {
        if ((down as Error).message !== BACKEND_DOWN || attempt >= 3) throw down;
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
  } catch (error) {
    // A report is worth more than its screenshots: one refused for an image is
    // sent again without them.
    if (/images/.test((error as Error).message) && "images" in bundle) {
      const { images: _dropped, ...without } = bundle as typeof bundle & { images?: unknown };
      try {
        await api("/v1/issues", "POST", without);
      } catch (again) {
        saved = false;
        saveError = (again as Error).message;
      }
    } else {
      saved = false;
      saveError = (error as Error).message;
    }
  }
  if (app && saved) {
    app.issueCount++;
    await persist();
  }
  // A download after a backend failure must keep the evidence too.
  return { report: saved ? report : bundle, saved, saveError };
}

export type ActiveRecording = {
  id: string;
  // Started by a fill rather than by the applicant.
  auto?: boolean;
  tabId: number;
  startedAt: number;
  url: string;
  title: string;
  pages: string[];
  events: NonNullable<Recording["events"]>;
  saving?: Promise<unknown>;
};
export const recordings = new Map<number, ActiveRecording>();
export const maxRecordedEvents = 30_000;

export async function startEvidence(tabId: number) {
  if (bg.state.settings.networkCapture === "on" && !capturing(tabId))
    await startCapture(tabId, false).catch(() => { /* best effort: a report then has no network log */ });
  if (!recordings.has(tabId)) await startRecording(tabId, true).catch(() => { /* best effort: a report then has no recording */ });
}

// Starts (or re-starts after a reload) the recorder in every frame we may
// read. Frames without site access are noted rather than skipped silently.
export async function attachRecorder(recording: ActiveRecording) {
  // Frames attach independently, so stalled ones cost one wait, not one each.
  await Promise.all((await allFrames(recording.tabId)).map(async (frame) => {
    if (!/^https?:/.test(frame.url)) return;
    const origin = new URL(frame.url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      recording.events.push({
        t: Date.now() - recording.startedAt,
        kind: "navigation",
        frameId: frame.frameId,
        data: { note: `No site access; frame not recorded: ${origin}` },
      });
      return;
    }
    // A frame that never finishes loading (a stalled third-party embed) keeps
    // executeScript pending for good. Tracking a tab must not wait on it.
    let slow: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<void>((resolve) => {
      slow = setTimeout(() => {
        recording.events.push({
          t: Date.now() - recording.startedAt,
          kind: "navigation",
          frameId: frame.frameId,
          data: { note: `Frame did not load in time; not recorded: ${origin}` },
        });
        resolve();
      }, 8000);
    });
    const attached = chrome.scripting
      .executeScript({
        target: { tabId: recording.tabId, frameIds: [frame.frameId] },
        files: ["content.js"],
      })
      .then(() =>
        chrome.tabs.sendMessage(
          recording.tabId,
          {
            type: "RECORD_START",
            session: recording.id,
            startedAt: recording.startedAt,
          },
          { frameId: frame.frameId },
        ),
      )
      // The page-world monitor reports calls into the page's own functions.
      .then(() =>
        chrome.scripting.executeScript({
          target: { tabId: recording.tabId, frameIds: [frame.frameId] },
          world: "MAIN",
          func: installMonitor,
          args: [recording.id, chrome.runtime.id],
        }),
      )
      .catch(() => { /* the tab may be gone or not scriptable: nothing to attach to */ });
    await Promise.race([attached, stalled]);
    clearTimeout(slow);
  }));
}

export async function startRecording(tabId: number, auto = false) {
  const existing = recordings.get(tabId);
  if (existing?.auto) {
    if (!auto) existing.auto = false;
    return recordingState();
  }
  if (existing) throw new Error("This tab is already recording.");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Open the application page you want to record.");
  const recording: ActiveRecording = {
    id: crypto.randomUUID(),
    ...(auto ? { auto } : {}),
    tabId,
    startedAt: Date.now(),
    url: redactURL(tab.url),
    title: tab.title || new URL(tab.url).hostname,
    pages: [redactURL(tab.url)],
    events: [],
  };
  recordings.set(tabId, recording);
  await attachRecorder(recording);
  return recordingState();
}

export async function stopRecording(tabId: number) {
  return saveRecording(tabId, true);
}

export function saveRecording(tabId: number, stop = false) {
  const recording = recordings.get(tabId);
  if (!recording) throw new Error("This tab is not recording.");
  // A fill checkpoint and a report may arrive together. Never let an older
  // save finish after the newer snapshot and erase its events.
  const task = (recording.saving || Promise.resolve()).catch(() => { /* an earlier save's failure was already reported to its own caller */ }).then(() => writeRecording(recording, stop));
  recording.saving = task;
  return task;
}

export async function writeRecording(recording: ActiveRecording, stop: boolean) {
  const tabId = recording.tabId;
  if (stop) await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: removeMonitor,
    })
    .catch(() => { /* the tab may be gone: nothing left to remove */ });
  for (const frame of await allFrames(tabId).catch(() => [])) {
    const result = await chrome.tabs
      .sendMessage(tabId, { type: stop ? "RECORD_STOP" : "RECORD_CHECKPOINT" }, { frameId: frame.frameId })
      .catch(() => undefined);
    for (const event of result?.data?.events || [])
      if (recording.events.length < maxRecordedEvents) recording.events.push({ ...event, frameId: frame.frameId });
  }
  if (stop) recordings.delete(tabId);
  const events = recording.events
    .slice(0, maxRecordedEvents)
    .sort((a, b) => a.t - b.t);
  const callsBySource: Record<string, number> = {};
  let pageCalls = 0;
  for (const event of events) {
    if (event.kind === "call") {
      const source = String(event.data.source || "unknown");
      callsBySource[source] = (callsBySource[source] || 0) + 1;
    }
    if (event.kind === "page-calls")
      for (const count of Object.values(event.data.counts || {}))
        pageCalls += Number(count) || 0;
  }
  const changes = events.filter((event) => event.kind === "value");
  const report: Recording = {
    id: recording.id,
    ...(recording.auto ? { auto: true } : {}),
    createdAt: recording.startedAt,
    durationMs: Date.now() - recording.startedAt,
    tab: { url: recording.url, title: recording.title },
    pages: recording.pages.slice(-200),
    eventCount: events.length,
    summary: {
      valueChanges: changes.length,
      directChanges: changes.filter((event) => event.data.direct).length,
      callsBySource,
      pageCalls,
    },
    events,
  };
  let saved = true;
  let saveError = "";
  try {
    await api("/v1/recordings", "POST", report);
  } catch (error) {
    saved = false;
    saveError = (error as Error).message;
  }
  return { recording: report, saved, saveError };
}

export function recordingState() {
  return [...recordings.values()].map((recording) => ({
    id: recording.id,
    tabId: recording.tabId,
    startedAt: recording.startedAt,
    eventCount: recording.events.length,
  }));
}
