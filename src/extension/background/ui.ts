// Part of the extension's service worker (background.ts): messages from the side panel and the dashboard.
// Split out of background.ts as it was; see background.ts for how it starts.
import { BACKEND, type QueueState, type Profile, type SignaturePolicy, activeStatuses } from "../../shared/model";
import { capturing, startCapture } from "../network-capture";
import { trustedInputTabs, releaseTrustedInput } from "../trusted-input";
import { bg } from "./state";
import { BACKEND_DOWN, adoptToken, answerFills, answerRequests, api, fieldFallbackFills, hello, persist, runners, withPageTimers } from "./core";
import { clearFit, enqueue, forApplication, resume, schedule, touch, trackTab } from "./queue";
import { checkFit, clearAnswerDrafts, draftDocuments, questionFields } from "./documents";
import { clearFieldFallback, draftFieldFallback, fillFieldFallback, modelFills, unresolvedFields } from "./field-fallback";
import { finishedStages, setStage } from "./submissions";
import { invalidate } from "./run";
import { applicationForTab, attachTab, detachTab, tabContext } from "./tabs";
import { recordingState, recordings, reportIssue, startRecording, stopRecording } from "./evidence";
import { dismissRecurringAnswer, draftAnswers, fillReviewedAnswers, recurringAnswers, saveAnswers, suggestAnswers } from "./answers";
import { pickUpInbox, unlockEmpty } from "./live";
import { checkSteps, pressStepFor } from "./steps";


export async function uiMessage(message: any) {
  if (message.type === "STATE") return bg.state;
  if (message.type === "HELLO") return { ...(await hello()), hasToken: Boolean(bg.token) };
  // One-click pairing: the six-digit code the backend shows in its terminal.
  if (message.type === "PAIR_CODE") {
    const code = String(message.code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) throw new Error("Type the six digits shown where Application Lane is running.");
    let response: Response;
    try {
      response = await fetch(`${BACKEND}/v1/pair/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extensionId: chrome.runtime.id, code }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(BACKEND_DOWN);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== "string")
      throw new Error(data.error || `Pairing failed (HTTP ${response.status}).`);
    await adoptToken(data.token);
    return { paired: true };
  }
  if (message.type === "PAIR") {
    const pairingToken = String(message.token || "").trim();
    if (/^[a-p]{32}$/.test(pairingToken))
      throw new Error(
        "That is a Chrome extension ID, not the pairing token. Paste the 64-character token from config.json in the backend's data folder.",
      );
    if (
      pairingToken.length < 32 ||
      pairingToken.length > 256
    )
      throw new Error("Paste the 64-character pairing token from config.json in the backend's data folder.");
    const old = bg.token;
    bg.token = pairingToken;
    try {
      await api("/v1/pair", "POST", { extensionId: chrome.runtime.id });
      await adoptToken(pairingToken);
    } catch (error) {
      bg.token = old;
      throw error;
    }
    return { paired: true };
  }
  if (message.type === "API") {
    const allowed =
      /^(\/v1\/(status|profile|profile\/conflicts|profile\/bundle|import|settings|config|transcript|data|issues|recordings|submissions|fixer|fixer\/settings|fixer\/health|search|search\/settings)|\/v1\/(artifacts|jobs|issues|recordings)\/[a-f0-9-]{36})$/;
    // A report cleaned for sharing is only read.
    if (/^\/v1\/issues\/[a-f0-9-]{36}\/share$/.test(message.path)) {
      if ((message.method || "GET") !== "GET") throw new Error("Unsupported backend operation.");
      return api(message.path);
    }
    // The panel reads the history of submissions and the fixer's work;
    // the background and the fixer write them.
    if (["/v1/submissions", "/v1/fixer"].includes(message.path) && (message.method || "GET") !== "GET")
      throw new Error("This is read-only here.");
    // Where a job's documents are as files, and showing their folder.
    const files = /^\/v1\/jobs\/[a-f0-9-]{36}\/files(\/open)?$/.exec(message.path);
    if (files) {
      if ((message.method || "GET") !== (files[1] ? "POST" : "GET"))
        throw new Error("Unsupported backend operation.");
      // Asked with the application's names, so documents drafted before
      // files were written are saved on first use.
      const job = message.path.split("/")[3];
      const owner = bg.state.applications.find((app) => (app.documentJobId || app.jobId) === job);
      const saved = await api(`/v1/jobs/${job}/files`, "POST", {
        sent: owner?.workflowStage === "submitted",
        ...(owner ? { company: owner.company, title: owner.title } : {}),
      });
      return files[1] ? api(message.path, "POST") : saved;
    }
    if (!allowed.test(message.path))
      throw new Error("Unsupported backend operation.");
    // The transcript is only ever uploaded: nothing reads it back.
    if (message.path === "/v1/transcript" && message.method !== "PUT")
      throw new Error("Unsupported backend operation.");
    if (message.path === "/v1/profile/conflicts" && message.method && message.method !== "GET")
      throw new Error("Profile disagreements are read-only.");
    if (
      /^\/v1\/(jobs|artifacts)\//.test(message.path) &&
      message.method &&
      message.method !== "GET"
    )
      throw new Error("Document inspection is read-only.");
    if (
      (/^\/v1\/profile(\/bundle)?$/.test(message.path) && message.method === "PUT") ||
      (message.path === "/v1/data" && message.method === "DELETE")
    ) {
      for (const app of bg.state.applications) {
        await clearFit(app);
        await clearAnswerDrafts(app);
        await clearFieldFallback(app);
        // A finished application is not asked to be filled again.
        if (!["cancelled"].includes(app.status) && !finishedStages.includes(app.workflowStage))
          await invalidate(
            app,
            "paused",
            "Profile data changed. Choose Fill this step to use the current profile.",
          );
      }
      await persist();
    }
    const result = await api(message.path, message.method, message.body);
    if (message.path === "/v1/data" && message.method === "DELETE") {
      bg.state.applications = [];
      bg.locks = {};
      await persist();
    }
    return result;
  }
  if (message.type === "ENQUEUE" || message.type === "TRACK_ITEMS")
    return enqueue(message.items);
  if (message.type === "ACTIVE_TAB") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
      throw new Error("Open a job or application tab to inspect it.");
    return tabContext(tab.id);
  }
  if (message.type === "SCAN_TAB") return tabContext(message.tabId);
  if (message.type === "QUESTION_FIELDS") return questionFields(message.tabId);
  if (message.type === "START_RECORDING") return startRecording(message.tabId);
  if (message.type === "SUGGEST_ANSWERS") return suggestAnswers(message.tabId);
  if (message.type === "RECURRING_ANSWERS") return recurringAnswers();
  if (message.type === "PICK_UP_INBOX") return pickUpInbox().then(() => bg.state);
  if (message.type === "DISMISS_RECURRING_ANSWER") return dismissRecurringAnswer(message.key);
  if (message.type === "SAVE_ANSWERS") return saveAnswers(message.answers);
  // The side panel's report dialog is open (its beat, every few seconds).
  if (message.type === "REPORT_OPEN") {
    bg.reportBeat = message.open ? Date.now() : 0;
    return true;
  }
  if (message.type === "STOP_RECORDING") return stopRecording(message.tabId);
  if (message.type === "RECORDING_STATE") return recordingState();
  if (message.type === "TRACK_TAB") return trackTab(message.tabId);
  if (message.type === "REPORT_ISSUE")
    return reportIssue(message.tabId, message.category, message.note || "", Array.isArray(message.images) ? message.images : []);
  if (message.type === "DELETE_ISSUE") {
    if (typeof message.reportId !== "string" || !/^[a-f0-9-]{36}$/.test(message.reportId))
      throw new Error("Invalid issue report ID.");
    const report = await api(`/v1/issues/${message.reportId}`);
    await api(`/v1/issues/${message.reportId}`, "DELETE");
    const linked = bg.state.applications.find((app) => app.id === report.applicationId);
    if (linked) {
      linked.issueCount = Math.max(0, linked.issueCount - 1);
      await persist();
    }
    return bg.state;
  }
  if (message.type === "SETTINGS") {
    const { concurrency, generationConcurrency } = message.settings;
    const checking = message.settings.checking === "fast" ? "fast" : "thorough";
    const prefilled = message.settings.prefilled === "keep" ? "keep" : "replace";
    const networkCapture = message.settings.networkCapture === "on" ? "on" : "off";
    const tabGroups = ["on", "off"].includes(message.settings.tabGroups) ? (message.settings.tabGroups as "on" | "off") : bg.state.settings.tabGroups;
    // A caller that says nothing about these (an older panel, a test's own
    // setting) leaves them as they are.
    const modelFill = ["auto", "review", "off", "written"].includes(message.settings.modelFill)
      ? (message.settings.modelFill as NonNullable<QueueState["settings"]["modelFill"]>)
      : bg.state.settings.modelFill;
    const legalQuestions = ["manual", "model"].includes(message.settings.legalQuestions)
      ? (message.settings.legalQuestions as "manual" | "model")
      : bg.state.settings.legalQuestions;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 8 ||
      !Number.isInteger(generationConcurrency) ||
      generationConcurrency < 1 ||
      generationConcurrency > 4
    )
      throw new Error("Invalid concurrency settings.");
    const nextButton = ["on", "off"].includes(message.settings.nextButton) ? (message.settings.nextButton as "on" | "off") : bg.state.settings.nextButton;
    const submitButton = ["on", "off"].includes(message.settings.submitButton) ? (message.settings.submitButton as "on" | "off") : bg.state.settings.submitButton;
    const agreeToTerms = ["on", "off"].includes(message.settings.agreeToTerms) ? (message.settings.agreeToTerms as "on" | "off") : bg.state.settings.agreeToTerms;
    const signatures = ["never", "self-id", "all"].includes(message.settings.signatures) ? (message.settings.signatures as SignaturePolicy) : bg.state.settings.signatures;
    await api("/v1/settings", "PUT", { generationConcurrency, checking });
    bg.state.settings = {
      concurrency, generationConcurrency, checking, prefilled, networkCapture,
      ...(tabGroups ? { tabGroups } : {}),
      ...(modelFill ? { modelFill } : {}),
      ...(legalQuestions ? { legalQuestions } : {}),
      ...(nextButton ? { nextButton } : {}),
      ...(submitButton ? { submitButton } : {}),
      ...(agreeToTerms ? { agreeToTerms } : {}),
      ...(signatures ? { signatures } : {}),
    };
    await persist();
    schedule();
    return bg.state;
  }
  const app = bg.state.applications.find((a) => a.id === message.id);
  if (!app) throw new Error("Application not found.");
  if (message.type === "STEP_CHECK") return (await checkSteps(app)).check;
  if (message.type === "PRESS_STEP") {
    await pressStepFor(app, message.step === "submit" ? "submit" : "next", typeof message.label === "string" ? message.label : undefined);
    return bg.state;
  }
  if (message.type === "CHECK_FIT") return checkFit(app);
  if (message.type === "DRAFT_DOCUMENTS") return draftDocuments(app);
  if (message.type === "UNRESOLVED_FIELDS") {
    const profile: Profile = forApplication(await api("/v1/profile"), app);
    const scanned = await unresolvedFields(app, message.tabId, undefined, profile);
    // With suggestions filled automatically, asking again only helps when
    // that step was cut short, ran on another page or profile, or new
    // fields have appeared since. In review mode asking is the way in.
    const pass = app.aiPass;
    const askAgain = modelFills().mode !== "auto" || !pass || !pass.finished || pass.tabId !== message.tabId ||
      pass.profileRevision !== profile.revision ||
      scanned.problems.some((problem) => !pass.fieldIds.includes(problem.fieldId));
    return { ...scanned, autoFill: modelFills().mode === "auto", askAgain: askAgain && !app.assisting };
  }
  if (message.type === "DRAFT_FIELD_FALLBACK")
    return draftFieldFallback(app, message.tabId, message.fieldIds);
  if (message.type === "FILL_FIELD_FALLBACK")
    return withPageTimers(app, message.tabId ?? app.tabId, () => fillFieldFallback(app, message));
  if (message.type === "CANCEL_FIELD_FALLBACK") {
    await clearFieldFallback(app);
    await persist();
    return bg.state;
  }
  if (message.type === "DRAFT_ANSWERS") return draftAnswers(app, message.tabId, message.questionIds);
  if (message.type === "FILL_ANSWERS") return withPageTimers(app, message.tabId ?? app.tabId, () => fillReviewedAnswers(app, message));
  if (message.type === "CANCEL_ANSWERS") { await clearAnswerDrafts(app); await persist(); return bg.state; }
  if (message.type === "ATTACH_TAB") return attachTab(app, message.tabId);
  if (message.type === "SET_TARGET") return attachTab(app, message.tabId);
  if (message.type === "DETACH_TAB") return detachTab(app, message.tabId);
  if (message.type === "OPEN_TAB") {
    const related = app.tabs.find((tab) => tab.tabId === message.tabId);
    if (!related?.tabId) throw new Error("Related tab not found.");
    const tab = await chrome.tabs.update(related.tabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    return bg.state;
  }
  if (message.type === "REPLACE_DOCUMENTS") {
    if (answerFills.has(app.id) || fieldFallbackFills.has(app.id) || activeStatuses.includes(app.status))
      throw new Error("Wait for the current fill to finish.");
    app.replaceDocuments = true;
    await resume(app);
    return bg.state;
  }
  if (message.type === "UNLOCK_APP") return unlockEmpty(app);
  // Start this application over on a fresh copy of its page: every lock and
  // note from earlier attempts is dropped and the tab is reloaded, so the
  // next Fill this step behaves as it would the first time. The tailored
  // documents are kept (the backend hands them back; nothing is written again).
  if (message.type === "RESTART_APP") {
    if (answerFills.has(app.id) || fieldFallbackFills.has(app.id))
      throw new Error("Wait for the reviewed values to finish filling.");
    await invalidate(app, "paused", "Starting over…");
    delete bg.locks[app.id];
    app.progress = undefined;
    app.formFrames = undefined;
    app.confirmedBySite = undefined;
    app.uploadedDocuments = undefined;
    app.siteFillPending = false;
    app.continueAfterSiteFill = false;
    app.siteFillTried = false;
    app.configNotes = [];
    app.missing = [];
    app.filled = 0;
    app.steps = 0;
    app.explicitFill = false;
    app.completedAt = undefined;
    app.workflowStage = "applying";
    app.stageUpdatedAt = Date.now();
    touch(app, "awaiting-user", "Started over. When the page has loaded, choose Fill this step.");
    await persist();
    if (app.tabId) await chrome.tabs.reload(app.tabId).catch(() => { /* the tab may already be closed: nothing to reload */ });
    return bg.state;
  }
  if (message.type === "FILL_STEP") {
    if (answerFills.has(app.id) || fieldFallbackFills.has(app.id))
      throw new Error("Wait for the reviewed values to finish filling.");
    // The side panel fills the tab you are looking at. If that is a related
    // tab other than the current target, it becomes the target first.
    if (typeof message.tabId === "number" && message.tabId !== app.tabId) {
      if (applicationForTab(message.tabId)?.id !== app.id)
        throw new Error("This tab belongs to a different application.");
      await attachTab(app, message.tabId);
    }
    // A second click while this step is still filling must not restart it.
    if (
      app.explicitFill &&
      (app.status === "queued" || activeStatuses.includes(app.status))
    )
      return bg.state;
    if (app.tabId !== undefined) {
      // The page was loaded before its tab joined an application: the
      // capture starts now, and the report says it missed the load.
      if (bg.state.settings.networkCapture === "on" && !capturing(app.tabId))
        await startCapture(app.tabId, false).catch(() => { /* best effort: a report then has no network log */ });
      // Every fill records itself, so a report has what happened.
      if (!recordings.has(app.tabId)) await startRecording(app.tabId, true).catch(() => { /* best effort: a report then has no recording */ });
    }
    answerRequests.delete(app.id);
    if (app.answerSession)
      await api(`/v1/jobs/${app.answerSession.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
    await resume(app);
    return bg.state;
  }
  if (message.type === "SET_WORKFLOW") {
    if (
      !["applying", "review", "submitted", "blocked", "abandoned"].includes(
        message.stage,
      )
    )
      throw new Error("Unknown application stage.");
    await setStage(app, message.stage, message.reason);
    return bg.state;
  }
  if (message.type === "ARCHIVE_APP") {
    if (
      message.archived &&
      (app.explicitFill || activeStatuses.includes(app.status))
    )
      await invalidate(
        app,
        "paused",
        "Fill paused because this application was archived.",
      );
    app.archivedAt = message.archived ? Date.now() : undefined;
    await persist();
    return bg.state;
  }
  if (message.type === "UPDATE_APP") {
    const previous = JSON.stringify([app.title, app.company, app.postingUrl, app.postingText]);
    app.title = String(message.title || app.title).trim().slice(0, 1000) || app.title;
    app.company = String(message.company || app.company).trim().slice(0, 300) || app.company;
    // The posting as the applicant gives it; an empty value clears it.
    if (typeof message.postingUrl === "string") {
      const link = message.postingUrl.trim();
      if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw new Error("A posting link starts with https://.");
      app.postingUrl = link.slice(0, 3000) || undefined;
    }
    if (typeof message.postingText === "string") app.postingText = message.postingText.trim().slice(0, 25000) || undefined;
    if (previous !== JSON.stringify([app.title, app.company, app.postingUrl, app.postingText])) {
      await clearFit(app);
      await clearAnswerDrafts(app);
      await clearFieldFallback(app);
      if (app.explicitFill || activeStatuses.includes(app.status))
        await invalidate(app, "paused", "The job details changed. Check fit or fill again using the updated posting.");
    }
    await persist();
    return bg.state;
  }
  if (message.type === "PAUSE_APP")
    await invalidate(
      app,
      "paused",
      "Paused by you. Other applications continue.",
    );
  else if (message.type === "CANCEL_APP") {
    app.workflowStage = "abandoned";
    app.stageUpdatedAt = Date.now();
    await invalidate(
      app,
      "cancelled",
      "Cancelled. Existing values remain on the page.",
    );
  }
  else if (message.type === "RESUME_APP") await resume(app);
  else if (message.type === "OPEN_APP") {
    if (
      app.tabId &&
      (await chrome.tabs.get(app.tabId).catch(() => undefined))
    ) {
      const tab = await chrome.tabs.update(app.tabId, { active: true });
      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    } else await chrome.tabs.create({ url: app.sourceUrl });
  } else throw new Error("Unknown operation.");
  return bg.state;
}
// Nothing stays attached to a tab with no running lane.
export async function sweepTrustedInput() {
  for (const tabId of trustedInputTabs())
    if (
      !bg.state.applications.some(
        (app) =>
          app.tabId === tabId &&
          runners.has(app.id) &&
          activeStatuses.includes(app.status),
      )
    )
      await releaseTrustedInput(tabId);
}
