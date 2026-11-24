
import { type Observation, CONTENT_VERSION } from "../shared/model";
import { showBadge } from "./badge";
import { type BadgeInfo } from "./badge-info";
import { setEngineWait } from "../engine/config/interpreter";
import { setMonthPickerWait } from "../engine/page/month-picker";
import { tell } from "./content-dom";
import { cs } from "./content/state";
import { documentId, ownClickEvent, pacesSaves, userAttention } from "./content/tracking";
import { human } from "./content/guards";
import { Command, pause } from "./content/core";
import { executeCommand } from "./content/commands";
import { checkSession, checkSubmitted, closeUnaskedLists, notePicklistUse, successFactorsSite } from "./content/watch";
import { inspect } from "./content/inspect";
declare global {
  interface Window {
    __applicationLane?: { inspect: () => Observation; version?: string };
  }
}

// A copy left by an earlier build (the extension reloaded since, its own
// line to the extension cut) gives way to this one, so a page need not be
// reloaded to take the new build: reloading lost unsaved entries, and on
// one employer's SuccessFactors its one-time address showed only an error.
if (window.__applicationLane && window.__applicationLane.version !== CONTENT_VERSION) window.__applicationLane = undefined;
// Required questions the page drew after the fill, from the applicant's own
// pick (Microsoft's location list draws its Work Authorization section):
// told to the extension once the applicant has stopped, for it to fill them
// as if Fill this step were chosen again. Never while they are still at it.
async function announceFresh(key: string) {
  for (let waited = 0; userAttention() && waited < 30000; waited += 300) await pause(300);
  if (userAttention() || !cs.applicationId) return;
  const ids = new Set(key.split("|"));
  const still = inspect().fields.some((f) => ids.has(f.id) && !f.value);
  if (still) tell({ type: "FORM_CHANGED", applicationId: cs.applicationId, operation: cs.operation, documentId, fresh: key });
}
if (!window.__applicationLane) {
  // Leaving the page ends their last click or key too: kept, a key of theirs
  // before they switched away came back to life when the debugger's first
  // key handed the page focus again, within its few seconds, and that key
  // (the job's From Month) paused the fill as theirs (Woodgrove's Workday).
  window.addEventListener("blur", () => {
    cs.applicantControl = undefined;
    cs.applicantGesture = -Infinity;
  });
  for (const type of ["keydown", "keypress", "beforeinput"])
    window.addEventListener(
      type,
      (event) => {
        if (
          !cs.trustedWrite ||
          !event.isTrusted ||
          userAttention() ||
          event.composedPath().includes(cs.trustedWrite)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cs.misdirected = true;
      },
      true,
    );
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
    window.addEventListener(
      type,
      (event) => {
        if (!ownClickEvent(event) || event.composedPath().includes(cs.ownClickAt!.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cs.ownClickAt!.missed = true;
      },
      true,
    );
  if (pacesSaves)
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (/[?&]op=ApiSetFormValue/.test(entry.name)) cs.savesFinished++;
      }).observe({ type: "resource" });
    } catch {
      /* Without resource timing, writes are not paced. */
    }
  for (const type of [
    "pointerdown",
    "keydown",
    "beforeinput",
    "input",
    "change",
    "compositionstart",
    "compositionend",
    "touchstart",
  ])
    document.addEventListener(type, human, { capture: true, passive: true });
  chrome.runtime.onMessage.addListener((message: Command, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    // The page's own progress badge (badge.ts), in the top frame only.
    if ((message as unknown as { type: string }).type === "LANE_BADGE") {
      showBadge((message as unknown as { info: BadgeInfo | null }).info);
      respond({ ok: true });
      return;
    }
    void executeCommand(message).then(
      (data) => respond({ ok: true, data }),
      (error) => respond({ ok: false, error: error.message }),
    );
    return true;
  });
  document.addEventListener("click", notePicklistUse, true);
  document.addEventListener("keydown", notePicklistUse, true);
  new MutationObserver((mutations) => {
    if (cs.unaskedCheck || !mutations.some((mutation) => [...mutation.addedNodes].some((node) =>
      node instanceof Element && (node.matches("ul.sf-list-select") || node.querySelector("ul.sf-list-select")))))
      return;
    cs.unaskedCheck = true;
    void pause(100).then(() => {
      cs.unaskedCheck = false;
      closeUnaskedLists();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (successFactorsSite)
    new MutationObserver(() => {
      if (cs.sessionCheck || !cs.applicationId) return;
      cs.sessionCheck = true;
      void pause(300).then(() => {
        cs.sessionCheck = false;
        checkSession();
      });
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden", "open"],
    });
  window.__applicationLane = { inspect, version: CONTENT_VERSION };
  setEngineWait(pause);
  setMonthPickerWait(pause);
  checkSubmitted();
  new MutationObserver(() => {
    if (!cs.toldSubmitted) {
      clearTimeout(cs.submittedTimer);
      cs.submittedTimer = setTimeout(checkSubmitted, 400);
    }
    if (cs.writing || cs.autoDocumentMutation || !cs.applicationId) return;
    clearTimeout(cs.timer);
    cs.timer = setTimeout(() => {
      cs.autoDocumentMutation = true;
      try {
        const known = new Set(cs.seenFields);
        const observation = inspect();
        const fresh = known.size
          ? observation.fields.filter((f) => !known.has(f.id) && f.required && !f.value && !f.protected).map((f) => f.id).sort().join("|")
          : "";
        if (fresh && fresh !== cs.announcedFresh) {
          cs.announcedFresh = fresh;
          void announceFresh(fresh);
        }
        const fingerprint = JSON.stringify(
          observation.fields.map((f) => [f.id, f.value, f.protected]),
        );
        if (fingerprint !== cs.lastFingerprint) {
          cs.lastFingerprint = fingerprint;
          tell({ type: "FORM_CHANGED", applicationId: cs.applicationId, operation: cs.operation, documentId });
        }
      } finally {
        cs.autoDocumentMutation = false;
      }
    }, 200);
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "disabled", "required", "value"],
  });
}
