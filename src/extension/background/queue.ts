// Part of the extension's service worker (background.ts): scheduling fills, and starting, resuming and tracking applications.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, type Observation, activeStatuses, type GenerationJob, type Profile, forRole, withPermissions } from "../../shared/model";
import { transitionTiming } from "../../shared/timing";
import { releaseTrustedInput } from "../trusted-input";
import { locationCountry, type Geography } from "../../shared/geography";
import globals from "../../engine/config/globals.json" with { type: "json" };
import { DRAFT_ONLY_NOTE, canonicalURL, sameOpening, postingGuess, publicPostingUrl } from "../../shared/matching";
import { companyFor, relatedTab } from "../workspace";
import { bg } from "./state";
import { Frame, alive, api, backoff, initial, loadingSince, pageTimers, persist, runners } from "./core";
import { syncSubmissions } from "./submissions";
import { pollDocumentDrafts } from "./documents";
import { run } from "./run";
import { recordings, saveRecording, scheduleFillCapture, startEvidence } from "./evidence";
import { applicationForTab, attachTab, draftOnlyTab, guessedAgain, leadingPage, namedByPage, tabContext, updateRelatedTab } from "./tabs";
import { clearFieldFallback } from "./field-fallback";
import { broadcast } from "./badges";

export function schedule(delay = 100) {
  clearTimeout(bg.kickTimer);
  bg.kickTimer = setTimeout(() => {
    void pump();
  }, delay);
}
export function touch(app: Application, status: Application["status"], note: string) {
  transitionTiming(app, status, Date.now());
  // Nothing is being written once a fill settles: what was current is history.
  if (!["inspecting", "preparing", "filling"].includes(status) && app.progress?.current) {
    if (app.progress.answered.at(-1) !== app.progress.current)
      app.progress.answered = [...app.progress.answered, app.progress.current].slice(-300);
    app.progress.current = undefined;
  }
  app.status = status;
  app.note = note;
  app.updatedAt = Date.now();
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    if (["inspecting", "preparing", "filling"].includes(status))
      attempt.status = "filling";
    else if (status === "queued") attempt.status = "queued";
    attempt.note = note;
    if (["awaiting-user", "ready", "failed", "paused", "cancelled"].includes(status)) {
      attempt.completedAt = Date.now();
      attempt.status =
        status === "ready"
          ? "filled"
          : status === "failed"
            ? "error"
            : status === "paused" || status === "cancelled"
              ? "paused"
              : "needs-review";
      attempt.filled = app.filled;
      app.explicitFill = false;
    }
  }
}
// Fields to fill, plus sections the site config can add rows to: a step
// holding only Add buttons (Oracle's Education) is still fillable.
export function fillable(observation: Observation) {
  return observation.fields.length + (observation.addable?.length || 0);
}
export function operationKey(frames: Frame[], profileRevision: number) {
  return JSON.stringify([
    profileRevision,
    ...frames.map((f) => [
      f.frameId,
      f.observation.documentId,
      f.observation.atReview,
      f.observation.fields.map((field) => [field.id, field.label]),
    ]),
  ]);
}
export async function pump() {
  await initial;
  // A history the backend missed (it was down when an application went in).
  if (!bg.submissionsSynced) void syncSubmissions().catch(() => { /* best effort: the history syncs again on the next pump */ });
  if (bg.pumping) return;
  bg.pumping = true;
  try {
    await pollFitChecks();
    await pollDocumentDrafts();
    for (const app of [...bg.state.applications].sort(
      (a, b) => a.updatedAt - b.updatedAt,
    )) {
      if (runners.has(app.id)) continue;
      if (app.status !== "queued" && !activeStatuses.includes(app.status))
        continue;
      if (!app.explicitFill) continue;
      if (runners.size >= bg.state.settings.concurrency) break;
      if (
        app.status === "queued" &&
        bg.state.applications.filter((a) => activeStatuses.includes(a.status))
          .length >= bg.state.settings.concurrency
      )
        continue;
      const origin = new URL(app.url).origin;
      if ((backoff.get(origin) || 0) > Date.now()) continue;
      // At most two application mutations on a single site at once.
      if (
        app.status === "queued" &&
        bg.state.applications.filter(
          (a) =>
            activeStatuses.includes(a.status) &&
            new URL(a.url).origin === origin,
        ).length >= 2
      )
        continue;
      const operation = app.operation;
      runners.set(app.id, operation);
      void run(app, operation)
        .catch(async (error) => {
          if (alive(app, operation)) {
            touch(app, "failed", (error as Error).message);
            app.explicitFill = false;
            app.continueAfterSiteFill = false;
            const attempt = app.attempts.at(-1);
            if (attempt && !attempt.completedAt) {
              attempt.completedAt = Date.now();
              attempt.status = "error";
              attempt.note = (error as Error).message.slice(0, 350);
              attempt.filled = app.filled;
            }
            backoff.set(origin, Date.now() + 3000);
            await persist();
          }
        })
        .finally(async () => {
          runners.delete(app.id);
          if (app.tabId !== undefined && !activeStatuses.includes(app.status))
            await pageTimers(app.tabId, false);
          // Save the fill, and keep observing the applicant's next interaction.
          const recording = app.tabId !== undefined ? recordings.get(app.tabId) : undefined;
          if (recording?.auto && !activeStatuses.includes(app.status) && app.status !== "queued")
            await saveRecording(recording.tabId)
              .then(async (result) => {
                if (result.saved) {
                  app.lastRecordingId = result.recording.id;
                  await persist();
                }
              })
              .catch(() => { /* best effort: the next pump tries again */ });
          if (app.tabId !== undefined && !activeStatuses.includes(app.status) && app.status !== "queued")
            scheduleFillCapture(app);
          // Release the input claim; passive report capture keeps its own.
          if (app.tabId !== undefined) await releaseTrustedInput(app.tabId);
          schedule(500);
        });
    }
  } finally {
    bg.pumping = false;
  }
}
export async function pollFitChecks() {
  const checking = bg.state.applications.filter((app) => app.fitJobId);
  await Promise.allSettled(checking.map(async (app) => {
    const id = app.fitJobId!;
    try {
      const job: GenerationJob = await api(`/v1/jobs/${id}`);
      if (app.fitJobId !== id) return;
      if (["queued", "running"].includes(job.status)) return;
      app.fitJobId = undefined;
      if (job.status === "complete" && job.fit) {
        app.fit = job.fit;
        app.fitError = undefined;
      } else {
        app.fitError = job.error || "The fit check was interrupted. Check fit again.";
      }
      await persist();
    } catch (error) {
      // Keep the queued check so a short backend outage can recover.
      if ((error as Error).message === "Job not found." && app.fitJobId === id) {
        app.fitJobId = undefined;
        app.fitError = "This fit check is no longer available. Check fit again.";
        await persist();
      }
    }
  }));
  if (bg.state.applications.some((app) => app.fitJobId)) schedule(1500);
}
export async function clearFit(app: Application) {
  const id = app.fitJobId;
  app.fitJobId = undefined;
  app.fit = undefined;
  app.fitError = undefined;
  if (id) await api(`/v1/jobs/${id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
}
// The profile as one application should be answered from: with the job's
// country (from the posting's location) and employer, so authorization,
// sponsorship and "worked here before" questions are asked of this job.
export function forApplication(profile: Profile, app: Application): Profile {
  const country = locationCountry(globals as Geography, app.posting?.location);
  // An internship is answered with the internship end date where one is
  // saved (Tesla's anticipated graduation date).
  const title = app.posting?.title || app.title;
  // Its tabs' titles too: Tesla's application was saved as "Tesla
  // homepageCareers…" while its tab said "Internship, Software Engineer…".
  const named = [app.posting?.title, app.title, ...app.tabs.map((tab) => tab.title)].filter(Boolean).join(" | ");
  // What the fill may agree to and sign comes from Settings.
  return { ...withPermissions(forRole(profile, named), bg.state.settings), applyingTo: { ...(country ? { country } : {}), ...(app.posting?.location ? { location: app.posting.location } : {}), ...(app.company ? { company: app.company } : {}), ...(title ? { title } : {}) } };
}
// An automatic carry-on (after the site filled the form from the resume, or
// after the posting's Apply button) that could not start: said on the card,
// which otherwise kept "Correcting and completing it…" for good.
export async function carryOnFailed(app: Application, error: unknown) {
  if (app.status !== "awaiting-user") return;
  app.note = `Could not carry on with this step automatically (${String((error as Error)?.message || error).slice(0, 160)}). Choose Fill this step.`;
  await persist();
}
export async function resume(app: Application, continuation?: { operation: number; tabId: number }) {
  if (await draftOnlyTab(app.tabId, app.url)) throw new Error(DRAFT_ONLY_NOTE);
  await clearFieldFallback(app);
  // A delayed resume-upload continuation belongs to one request and one
  // tab. A pause, new request or changed target cancels it, including while
  // the asynchronous cleanup above was running.
  if (continuation && (
    !app.continueAfterSiteFill || app.operation !== continuation.operation ||
    app.tabId !== continuation.tabId || app.status !== "awaiting-user"
  )) return;
  loadingSince.delete(app.id);
  app.aiFilled = undefined;
  app.preparationMs = 0;
  app.activeSince = undefined;
  app.startedAt = undefined;
  app.completedAt = undefined;
  app.operation++;
  const operation = app.operation;
  app.profileRevision = 0;
  app.jobId = undefined;
  app.artifacts = [];
  app.narrative = undefined;
  app.unchecked = undefined;
  app.generationKey = undefined;
  app.missing = [];
  // A new request supersedes the previous attempt; close it in the history.
  const previous = app.attempts.at(-1);
  if (previous && !previous.completedAt) {
    previous.completedAt = Date.now();
    previous.status = "paused";
    previous.note = "Superseded by a new Fill this step request.";
    previous.filled = app.filled;
  }
  if (
    !app.tabId ||
    !(await chrome.tabs.get(app.tabId).catch(() => undefined))
  ) {
    const tab = await chrome.tabs.create({ url: app.url, active: false });
    app.tabId = tab.id;
    updateRelatedTab(app, tab, undefined);
  }
  if (!app.tabId) throw new Error("Choose a current fill tab first.");
  if (continuation && (!alive(app, operation) || app.tabId !== continuation.tabId)) return;
  app.explicitFill = true;
  app.attempts.push({
    id: crypto.randomUUID(),
    tabId: app.tabId,
    startedAt: Date.now(),
    status: "queued",
    filled: 0,
    note: "Waiting for an available fill slot.",
  });
  app.attempts = app.attempts.slice(-20);
  await broadcast(app, "RESUME");
  if (continuation && (!alive(app, operation) || app.tabId !== continuation.tabId)) return;
  touch(
    app,
    "queued",
    "Queued for a fresh inspection; protected edits will be preserved.",
  );
  // Keep the continuation pending through every await. Clearing it before
  // the next fill was queued exposed an interim awaiting-user state as a
  // finished fill to the panel and eval adapter.
  app.continueAfterSiteFill = false;
  await persist();
  schedule();
}
export async function enqueue(
  items: { url: string; tabId?: number }[],
  allowDuplicate = false,
) {
  if (items.length > 100)
    throw new Error("Queue up to 100 applications at a time.");
  for (const item of items) {
    // A tab already open keeps its address; a link opened here goes to the
    // job's public page when its own leads to a sign-in.
    const url = item.tabId ? canonicalURL(item.url) : publicPostingUrl(canonicalURL(item.url));
    if (
      !(await chrome.permissions.contains({
        origins: [`${new URL(url).origin}/*`],
      }))
    )
      throw new Error(`Grant site access for ${new URL(url).origin}.`);
    if (
      !allowDuplicate &&
      bg.state.applications.some(
        (a) => a.status !== "cancelled" && [a.url, a.sourceUrl].some((known) => known && sameOpening(known, url)),
      )
    )
      continue;
    const tab = item.tabId
      ? await chrome.tabs.get(item.tabId)
      : await chrome.tabs.create({ url, active: false });
    if (item.tabId && canonicalURL(tab.url || "") !== url)
      throw new Error("Tab changed before it was queued. Select it again.");
    const app: Application = {
      id: crypto.randomUUID(),
      tabId: tab.id,
      url,
      sourceUrl: url,
      title: tab.title || new URL(url).hostname,
      company: companyFor(url, tab.title),
      status: "awaiting-user",
      workflowStage: "applying",
      stageUpdatedAt: Date.now(),
      tabs: [relatedTab(tab, 0)],
      attempts: [],
      issueCount: 0,
      explicitFill: false,
      operation: 0,
      profileRevision: 0,
      artifacts: [],
      missing: [],
      note: "Tracked. Open a form and choose Fill this step.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      filled: 0,
      steps: 0,
    };
    bg.state.applications.push(app);
    await persist();
    if (tab.id !== undefined) await startEvidence(tab.id);
  }
  schedule();
  return bg.state;
}

export async function trackTab(tabId: number) {
  const existing = applicationForTab(tabId);
  if (existing) return bg.state;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Open an HTTP(S) job or application page first.");
  // The same opening reached by another address (a Workday requisition on
  // another career site) whose own tab is gone takes this tab instead of
  // becoming a second application.
  const twin = bg.state.applications.find(
    (app) =>
      app.status !== "cancelled" &&
      !app.submittedAt &&
      [app.url, app.sourceUrl].some((known) => known && sameOpening(known, tab.url!)),
  );
  if (twin && (twin.tabId === undefined || !(await chrome.tabs.get(twin.tabId).catch(() => undefined)))) {
    await attachTab(twin, tabId);
    return bg.state;
  }
  await enqueue([{ url: tab.url, tabId }], true);
  const app = applicationForTab(tabId)!;
  const context = await tabContext(tabId);
  if (context.observation) {
    app.title = context.observation.title || app.title;
    namedByPage(app, context.observation);
    app.sourceDescription = context.observation.description.slice(0, 12500);
    app.ats = context.observation.ats;
    updateRelatedTab(app, tab, context.observation.fields.length);
    app.note = context.observation.fields.length
      ? `${context.observation.fields.length} fields detected. Ready when you are.`
      : "Tracked. Open the application form when you are ready.";
  }
  // A page with a job's description and no form is the posting itself: what
  // opened it is a list of jobs (Simplify's on GitHub opened Amazon's posting,
  // tracked there, and the list was read as the posting).
  if (!app.postingUrl && !app.postingText && !app.postingSought && context.observation &&
      !context.observation.fields.length && (context.observation.description.match(/\S+/g)?.length || 0) >= 40) {
    app.postingSought = true;
    app.postingUrl = tab.url;
  }
  if (!app.postingUrl && !app.postingText && !app.postingSought) {
    app.postingSought = true;
    const led = await leadingPage(tab, context.observation, app).catch(() => undefined);
    if (led) {
      app.postingUrl = led.url;
      if (led.description) app.sourceDescription = `${led.description.slice(0, 12500)}\n${app.sourceDescription || ""}`;
    } else if (!app.postingText && guessedAgain(app)) app.postingUrl = postingGuess(app.url);
  }
  await persist();
  return bg.state;
}
