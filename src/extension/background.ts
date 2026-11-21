import { capturing, startCapture, forgetCapture } from "./network-capture";
import { activeStatuses } from "../shared/model";
import { type MainWorldRequest, applyMainWorld } from "../engine/page/mainWorld";
import { trustedTypingAvailable, typeTrusted, forgetTrustedInput } from "./trusted-input";
import { companyFor, redactURL } from "./workspace";
import { canonicalURL } from "../shared/matching";
import { bg } from "./background/state";
import { badgeSent, badgesSoon } from "./background/badges";
import { alive, dirty, initial, persist, readingOptions } from "./background/core";
import { applicationForTab, rememberVisit, sameFormPage, tabContext, updateRelatedTab } from "./background/tabs";
import { carryOnFailed, pump, resume, schedule, trackTab } from "./background/queue";
import { sweepTrustedInput, uiMessage } from "./background/ui";
import { attachRecorder, maxRecordedEvents, recordings, stopRecording } from "./background/evidence";
import { interactedNote, noteProgress, siteSubmitted, submittedNote } from "./background/submissions";
import { recordHandAnswersSoon } from "./background/answers";
import { assisting } from "./background/field-fallback";
import { invalidate } from "./background/run";
import { connectLive, pickUpInbox } from "./background/live";

// The fixer's records change on the backend, not in the extension: the badge
// asks again every fifteen seconds (sendBadges sends only what changed).
setInterval(() => badgesSoon(), 15_000);
// A page that loads again draws its badge again.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete" || !badgeSent.has(tabId)) return;
  badgeSent.delete(tabId);
  badgesSoon();
});
// Fill this step from the keyboard (manifest "fill-step"): the tab in view,
// tracked first if it is not an application yet. What happens shows on the
// page's badge; a step that cannot be filled says why there.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "fill-step") return;
  void initial.then(async () => {
    const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    if (tabId === undefined) return;
    try {
      if (!applicationForTab(tabId)) await trackTab(tabId);
      const app = applicationForTab(tabId);
      if (!app) return;
      await uiMessage({ type: "FILL_STEP", id: app.id, tabId });
    } catch (error) {
      await chrome.tabs.sendMessage(tabId, { type: "LANE_BADGE", info: { tone: "attention", title: "Could not fill", detail: (error as Error).message.slice(0, 140) } }, { frameId: 0 }).catch(() => { /* the tab may be gone: nobody left to tell */ });
      badgeSent.delete(tabId);
    }
  });
});
// A form framed in an employer's page (Greenhouse on one employer's and
// another employer's careers site) shows its confirmation as a new document in that
// frame, with no page script in it: one is put there, in an application's
// tab still being applied to, so it can say whether that is what it is.
// Frames without access are passed over.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) return;
  void initial.then(() => {
    const app = bg.state.applications.find((a) => a.tabId === tabId && a.status !== "cancelled");
    if (!app || app.confirmedBySite || !["applying", "review"].includes(app.workflowStage)) return;
    void chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] }).catch(() => { /* the tab may be gone or not scriptable: nothing to inject */ });
  });
});

// A wait in a page's fill, ended from here: a hidden tab's own timers run
// about once a minute (content.ts, pause). At most a minute each.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lane-wake") return;
  port.onMessage.addListener((message: { id?: unknown; ms?: unknown }) => {
    if (typeof message?.id !== "number") return;
    const ms = Math.min(Math.max(0, Number(message.ms) || 0), 60_000);
    setTimeout(() => {
      try {
        port.postMessage({ id: message.id });
      } catch {
        // The page went away.
      }
    }, ms);
  });
});
// Before the page's first request: a capture started here holds the page
// itself, which a replay of it needs (eval/check.ts).
chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || !/^https?:/.test(url)) return;
  void initial.then(() => {
    if (bg.state.settings.networkCapture === "on" && !capturing(tabId) && applicationForTab(tabId))
      return startCapture(tabId, false);
  }).catch(() => { /* best effort: a report then has no network log */ });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && /^https:/.test(change.url) && change.url.length <= 3000) rememberVisit(tabId, change.url);
});
chrome.tabs.onRemoved.addListener((tabId) => rememberVisit(tabId));

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  // The page badge's click: the side panel, for the tab it is on.
  if (sender.tab?.id !== undefined && message.type === "OPEN_PANEL") {
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(
      () => respond({ ok: true }),
      (error: Error) => respond({ ok: false, error: error.message }),
    );
    return true;
  }
  // A full dashboard is an extension page inside a tab; sender.tab is valid
  // there too. Trust the packaged page URL, not the absence of a tab.
  // The dashboard's address carries the page it shows after a "#".
  const isPanel = ["panel.html", "dashboard.html"].some(
    (page) => sender.url?.split("#")[0] === chrome.runtime.getURL(page),
  );
  if (isPanel) {
    void initial
      .then(() => uiMessage(message))
      .then(
        (data) => respond({ ok: true, data }),
        (error) => respond({ ok: false, error: error.message }),
      );
    return true;
  }
  if (sender.tab && message.type === "MAIN_WORLD_APPLY") {
    void initial
      .then(async () => {
        const app = bg.state.applications.find(
          (candidate) =>
            candidate.id === message.applicationId &&
            candidate.tabId === sender.tab!.id &&
            candidate.operation === message.operation &&
            (activeStatuses.includes(candidate.status) || readingOptions(candidate, message.request)),
        );
        if (!app) throw new Error("Application operation is stale or paused.");
        const operation = app.operation;
        const request = message.request as MainWorldRequest;
        if (
          !request ||
          !/^[a-f0-9-]{36}$/i.test(request.token) ||
          (request.file &&
            (request.file.applicationId !== app.id ||
              request.file.operation !== app.operation ||
              !app.artifacts.some(
                (artifact) =>
                  artifact.id === request.file?.id &&
                  artifact.name === request.file.name &&
                  artifact.mime === request.file.mime,
              )))
        )
          throw new Error(
            "MAIN-world request is not bound to this application.",
          );
        if (!sender.documentId)
          throw new Error("Missing sender document identity.");
        const authorized = await chrome.tabs.sendMessage(
          sender.tab!.id!,
          {
            type: "AUTHORIZE_MAIN",
            applicationId: app.id,
            operation,
            documentId: message.documentId,
            token: request.token,
          },
          { documentId: sender.documentId },
        );
        if (
          !authorized?.ok ||
          !authorized.data?.authorized ||
          !alive(app, operation) ||
          !(activeStatuses.includes(app.status) || readingOptions(app, request))
        )
          throw new Error("Field write was cancelled, locked, or superseded.");
        const [injection] = await chrome.scripting.executeScript({
          target: {
            tabId: sender.tab!.id!,
            documentIds: [sender.documentId],
          },
          world: "MAIN",
          func: applyMainWorld,
          args: [request],
          // The document/operation/field claim was just authorized. Waiting
          // for unrelated resources here can stall a usable form indefinitely.
          injectImmediately: true,
        });
        return injection.result;
      })
      .then(
        (data) => respond({ ok: true, data }),
        (error) => respond({ ok: false, error: error.message }),
      );
    return true;
  }
  if (sender.tab && message.type === "TRUSTED_TYPE") {
    void initial
      .then(async () => {
        const app = bg.state.applications.find(
          (candidate) =>
            candidate.id === message.applicationId &&
            candidate.tabId === sender.tab!.id &&
            candidate.operation === message.operation &&
            activeStatuses.includes(candidate.status),
        );
        if (!app) throw new Error("Application operation is stale or paused.");
        // Captured before the authorization round trip: a pause or cancel in
        // between bumps the operation, and then no key is sent.
        const operation = app.operation;
        const request = message.request as {
          clear?: unknown;
          enter?: unknown;
          choose?: unknown;
          hold?: unknown;
          click?: unknown;
          insert?: unknown;
          text?: unknown;
          token?: unknown;
        };
        if (
          !request ||
          typeof request.token !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(request.token) ||
          typeof request.text !== "string" ||
          typeof request.clear !== "number"
        )
          throw new Error(
            "Trusted typing request is not bound to this application.",
          );
        if (!sender.documentId)
          throw new Error("Missing sender document identity.");
        if (!trustedTypingAvailable())
          throw new Error("Real keystrokes need the debugger permission.");
        // The content script re-checks the token, the element, its focus and
        // the edit locks. Keys are dispatched only while it still agrees.
        const authorized = await chrome.tabs.sendMessage(
          sender.tab!.id!,
          {
            type: "AUTHORIZE_MAIN",
            applicationId: app.id,
            operation,
            documentId: message.documentId,
            token: request.token,
          },
          { documentId: sender.documentId },
        );
        if (
          !authorized?.ok ||
          !authorized.data?.authorized ||
          !alive(app, operation) ||
          !activeStatuses.includes(app.status)
        )
          throw new Error("Field write was cancelled, locked, or superseded.");
        await typeTrusted(sender.tab!.id!, request.text, request.clear, request.enter === true, request.choose === true || (typeof request.choose === "number" ? request.choose : false), request.hold === true,
          request.click && typeof request.click === "object" ? { x: Number((request.click as { x?: unknown }).x), y: Number((request.click as { y?: unknown }).y) } : undefined,
          request.insert === true);
        return { ok: true };
      })
      .then(
        (data) => respond({ ok: true, data }),
        (error) => respond({ ok: false, error: error.message }),
      );
    return true;
  }
  if (sender.tab && message.type === "RECORD_EVENTS") {
    const recording = recordings.get(sender.tab.id!);
    if (
      recording &&
      message.session === recording.id &&
      Array.isArray(message.events)
    )
      for (const event of message.events.slice(0, 2000))
        if (recording.events.length < maxRecordedEvents)
          recording.events.push({ ...event, frameId: sender.frameId });
    return;
  }
  if (!sender.tab || !["HUMAN_PAUSE", "FORM_CHANGED", "FILL_PROGRESS", "SUBMITTED_PAGE"].includes(message.type))
    return;
  void initial.then(async () => {
    if (message.type === "SUBMITTED_PAGE") {
      // From a page of the application's own tab, its top page or the frame
      // its form is in; the page script may not be bound to an application
      // yet (the site's page after Submit is a new document).
      const shown = bg.state.applications.find((a) => a.tabId === sender.tab!.id && a.status !== "cancelled");
      if (shown && message.generic === true && !(shown.formFrames || []).includes(sender.frameId ?? -1)) return;
      // A list of sent applications (Oracle's My Applications) is the site's
      // own record: every application on that site whose job it lists as
      // active went in, the tab's or not (two sent before this was read had
      // their tabs closed and stayed in "needs you"). One not listed is not
      // marked.
      if (Array.isArray(message.applied)) {
        const jobOf = (url: string | undefined) => url?.match(/\/job\/(\d+)(?:[/?#]|$)/)?.[1];
        const hostOf = (url: string | undefined) => { try { return url ? new URL(url).host : ""; } catch { return ""; } };
        const listed = new Set(message.applied.filter((link: unknown): link is string => typeof link === "string").map((link: string) => `${hostOf(link)}|${jobOf(link)}`));
        for (const app of bg.state.applications) {
          if (app.status === "cancelled") continue;
          if ([app.url, app.sourceUrl, app.postingUrl].some((url) => jobOf(url) && listed.has(`${hostOf(url)}|${jobOf(url)}`))) await siteSubmitted(app);
        }
        return;
      }
      if (shown) await siteSubmitted(shown);
      return;
    }
    const app = bg.state.applications.find(
      (a) => a.id === message.applicationId && a.tabId === sender.tab!.id,
    );
    if (!app) return;
    if (message.type === "FILL_PROGRESS") {
      if (typeof sender.frameId === "number" && !(app.formFrames || []).includes(sender.frameId))
        app.formFrames = [...(app.formFrames || []), sender.frameId].slice(-10);
      const label = typeof message.label === "string" ? message.label.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      if (label && message.operation === app.operation) noteProgress(app, label);
      return;
    }
    if (message.type === "HUMAN_PAUSE") {
      recordHandAnswersSoon(app);
      bg.locks[app.id] = [
        ...new Set([
          ...(bg.locks[app.id] || []),
          ...(Array.isArray(message.locks)
            ? message.locks
                .filter((v: unknown) => typeof v === "string")
                .slice(0, 1000)
            : []),
        ]),
      ];
      // A fill that reads as finished may still have the model suggesting
      // values for what the rules left open, and the applicant, seeing a
      // filled form, starts on the rest. That edit used to discard the
      // suggestions. They are kept: each is written only where its field is
      // as it was and unprotected (fillFieldFallback), so the applicant's own
      // answers stand, and an edit while they are being written still stops it.
      const suggesting = assisting.has(app.id) && !app.explicitFill && !activeStatuses.includes(app.status);
      if (!suggesting && app.status !== "cancelled" && app.status !== "paused")
        await invalidate(app, "paused", interactedNote(message.cause));
      else await persist();
    } else if (activeStatuses.includes(app.status)) {
      dirty.add(app.id);
      schedule(500);
    } else if (app.status === "ready" && message.operation === app.operation)
      await invalidate(
        app,
        "paused",
        "The site changed after preparation. Review it, then choose Fill this step.",
      );
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "queue-recovery")
    void pump().then(() => initial.then(sweepTrustedInput));
  if (alarm.name === "inbox") void initial.then(() => {
    connectLive();
    return pickUpInbox();
  });
});
// Chrome can end a debugger session on its own (DevTools opened on the tab,
// the tab navigated away, a crash). Forget it so the next write re-attaches.
chrome.debugger?.onDetach.addListener(({ tabId }) => {
  if (tabId === undefined) return;
  forgetTrustedInput(tabId);
  forgetCapture(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTrustedInput(tabId);
  forgetCapture(tabId);
  // A closed tab ends its recording; keep what was captured.
  if (recordings.has(tabId)) void stopRecording(tabId).catch(() => { /* best effort: a recording that cannot stop is simply left as it was */ });
  void initial.then(async () => {
    for (const app of bg.state.applications)
      if (app.tabs.some((tab) => tab.tabId === tabId)) {
        const related = app.tabs.find((tab) => tab.tabId === tabId)!;
        related.state = "closed";
        related.closedAt = Date.now();
        related.tabId = undefined;
        if (app.tabId === tabId && app.status !== "cancelled") {
          await invalidate(
            app,
            "paused",
            "Current fill tab closed. Choose another related tab.",
          );
          app.tabId = undefined;
        }
      }
    await persist();
  });
});
// A link tracked before its tab had loaded is named by its address
// ("jobs.ashbyhq.com"), from the command line most of all. The
// page's own title replaces that stand-in as soon as the tab has one, and
// names the employer when only the address did; a title the applicant or a
// fill gave is kept.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const title = change.title?.replace(/\s+/g, " ").trim();
  if (!title || /^https?:\/\//i.test(title)) return;
  void initial.then(async () => {
    const app = applicationForTab(tabId);
    if (!app) return;
    const host = (() => { try { return new URL(app.url).hostname; } catch { return ""; } })();
    if (title === host || !(app.title === host || /^https?:\/\//i.test(app.title) || !app.title)) return;
    app.title = title.slice(0, 300);
    if (app.company === companyFor(app.sourceUrl || app.url, "")) app.company = companyFor(app.sourceUrl || app.url, title);
    app.updatedAt = Date.now();
    await persist();
  }).catch(() => { /* the tab may be gone: the title is only a convenience */ });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // A same-URL reload has no change.url, so the URL-change path below cannot
  // invalidate drafts. A navigation with change.url is handled there once.
  if (change.status === "loading" && !change.url)
    void initial.then(async () => {
      const app = bg.state.applications.find(
        (app) =>
          app.answerSession?.tabId === tabId ||
          app.fieldFallbackSession?.tabId === tabId,
      );
      if (app)
        await invalidate(
          app,
          "paused",
          "The page reloaded. Review its current fields again before filling.",
        );
    }).catch(() => { /* best effort: the next page event handles it */ });
  // An application tab's traffic, for reports and fill captures. "loading"
  // comes after the page's own request has gone out, so the capture only
  // counts as holding the page once it sees that request (network-capture.ts);
  // onBeforeNavigate below usually starts it in time.
  if (change.status === "loading")
    void initial.then(() => {
      if (bg.state.settings.networkCapture === "on" && !capturing(tabId) && applicationForTab(tabId))
        return startCapture(tabId, false);
    }).catch(() => { /* best effort: a report then has no network log */ });
  const recording = recordings.get(tabId);
  if (recording && change.status === "complete")
    void chrome.tabs.get(tabId).then(async (tab) => {
      const url = redactURL(tab.url || "");
      recording.events.push({
        t: Date.now() - recording.startedAt,
        kind: "navigation",
        data: { url, title: tab.title || "" },
      });
      if (recording.pages.at(-1) !== url) recording.pages.push(url);
      await attachRecorder(recording);
    }).catch(() => { /* the tab may be gone: nothing to record */ });
  if (!change.url && change.status !== "complete") return;
  void initial
    .then(async () => {
      const app = bg.state.applications.find(
        (a) =>
          (a.tabId === tabId || a.tabs.some((tab) => tab.tabId === tabId)) &&
          a.status !== "cancelled",
      );
      if (!app) return;
      const browserTab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (browserTab) updateRelatedTab(app, browserTab, undefined);
      if (app.tabId !== tabId) {
        await persist();
        return;
      }
      // The page a site shows after Submit is a new document with no page
      // script in it. Put one there so it can say whether that is what this is.
      if (change.status === "complete" && !app.confirmedBySite && ["applying", "review"].includes(app.workflowStage))
        void chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }).catch(() => { /* the tab may be gone or not scriptable: nothing to inject */ });
      // A form in a frame of the page goes to its confirmation in that frame
      // alone: the frame listener above (webNavigation) puts a page script there.
      // The posting's Apply led here: the same request goes on with the form.
      const applied = app.applyUsed && app.applyUsed.tabId === tabId && app.applyUsed.operation === app.operation &&
        Date.now() - app.applyUsed.at < 60_000 ? app.applyUsed : undefined;
      if (applied) {
        if (change.url && canonicalURL(change.url) !== canonicalURL(app.url)) {
          app.url = canonicalURL(change.url);
          await persist();
        }
        if (change.status === "complete") {
          applied.operation = -1;
          setTimeout(() => {
            if (app.tabId === tabId && app.status === "awaiting-user") void resume(app).catch((error) => carryOnFailed(app, error));
          }, 1500);
        }
      } else if (change.url && app.continueAfterSiteFill && sameFormPage(change.url, app.url)) {
        // The site rebuilt the form from the resume uploaded first and opened
        // it at another address of the same page (Litware's iCIMS adds
        // "uploadResume=1"). Paused as a new
        // page, the rest was never filled; the same request carries on once
        // it has loaded (below).
        app.url = canonicalURL(change.url);
        await persist();
      } else if (change.url && canonicalURL(change.url) !== canonicalURL(app.url)) {
        // A new document invalidates outstanding generation; never reuse its answers.
        app.url = canonicalURL(change.url);
        await invalidate(
          app,
          "paused",
          "The page changed. Scan it, then choose Fill this step when ready.",
        );
        // The page it changed to was the site's confirmation, which may have
        // been reported while that pause was being written.
        if (app.confirmedBySite && app.workflowStage === "submitted") {
          app.note = submittedNote;
          await persist();
        }
      }
      if (change.status === "complete") await tabContext(tabId).catch(() => { /* the tab may be gone: no context to read */ });
      // The site finished rewriting the form from the uploaded resume: this
      // is still the same requested fill, so it carries on by itself.
      if (
        change.status === "complete" &&
        app.continueAfterSiteFill &&
        app.tabId === tabId
      ) {
        const request = app.operation;
        app.note = "The site filled the form from your resume. Correcting and completing it…";
        await persist();
        setTimeout(() => {
          if (app.tabId === tabId && app.operation === request && app.continueAfterSiteFill && app.status === "awaiting-user")
            void resume(app, { operation: request, tabId }).catch((error) => carryOnFailed(app, error));
        }, 2000);
      }
    })
    .catch(() => { /* best effort: the next page event tries again */ });
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void initial.then(() => tabContext(tabId)).catch(() => { /* the tab may be gone: no context to read */ });
});
void initial.then(() => schedule());
