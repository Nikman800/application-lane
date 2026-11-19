// Part of the content script (content.ts): watching the page: lists opened unasked, sessions about to end, and a submission.
// Split out of content.ts as it was; see content.ts for how it starts.
import { rendered } from "../semantics";
import { successFactorsPicklist, closeSuccessFactorsList, tell } from "../content-dom";
import { noteSession } from "../badge";
import { submittedOnPage, confirmationInPlace } from "../../engine/runtime";
import { cs } from "./state";
import { pause } from "./core";

// A SuccessFactors list that arrives long after its click, its fill having
// given up on it, opens over the form, and a slow site left a stack of them
// open. A list is closed when it
// opens unasked: not within 20 seconds of a click this extension made on
// its dropdown (a fill may still be waiting for it), nor within a minute
// of the applicant's own.
export const picklistClicks = new WeakMap<Element, { lane: number; applicant: number }>();
export const notePicklistUse = (event: Event) => {
  const input = (event.target as Element | null)?.closest?.(".sfCascadingPicklist, .fieldComponentInput")
    ?.querySelector('input.rcmpaginatedselectinput[role="combobox"]');
  if (!input) return;
  // The applicant also opens one from the keyboard; a script's keys are
  // not a request to open it.
  if (event.type === "keydown" && !event.isTrusted) return;
  const seen = picklistClicks.get(input) || { lane: 0, applicant: 0 };
  seen[event.isTrusted ? "applicant" : "lane"] = Date.now();
  if (event.isTrusted) cs.lastApplicantPicklistUse = Date.now();
  else cs.lastLanePicklistClick = Date.now();
  picklistClicks.set(input, seen);
};
export const closeUnaskedLists = (): void => {
  if (!cs.applicationId) return;
  for (const list of document.querySelectorAll<HTMLElement>('ul.sf-list-select[role="listbox"][id]')) {
    if (!rendered(list)) continue;
    const owner = document.querySelector(`[aria-owns="${CSS.escape(list.id)}"]`);
    if (!owner || !successFactorsPicklist(owner)) continue;
    const seen = picklistClicks.get(owner) || { lane: 0, applicant: 0 };
    // Nor while the applicant is choosing in one of their own.
    if (Date.now() - seen.applicant < 60_000 || Date.now() - cs.lastApplicantPicklistUse < 60_000) continue;
    // One still open when the fill's wait for it is over is looked at
    // again. The press that closes it closes every list on the page, so
    // nor while the fill may be waiting for another's.
    const since = Date.now() - Math.max(seen.lane, cs.lastLanePicklistClick);
    if (since < 20_000) {
      void pause(20_000 - since + 100).then(closeUnaskedLists);
      return;
    }
    closeSuccessFactorsList(owner);
  }
};
// SuccessFactors ends an idle session, first asking "Your session is about
// to time out.", and an expired one signs the applicant in again onto their
// Candidate Profile, away from the application (Fabrikam's SuccessFactors). On a page bound to an application, the site's own
// keep-working button is pressed: only a button of a dialog that says the
// session is about to end, never one that signs out, and not while the
// applicant is typing in a field. An expired session is said on the badge.
export const successFactorsSite = /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu)|ns2cloud\.com)$/i.test(location.hostname);
export const sessionEnding = /session (is |will be )?(about to|going to|soon) (time ?out|expire|end)|session will (time ?out|expire|end) (in|soon)/i;
export const sessionEnded = /session (has )?(expired|timed out|ended)/i;
export const keepWorking = /^(continue( working| session)?|extend( my)?( session)?|keep (working|me signed in|my session)|stay (signed|logged) in|i'?m still here|yes|ok)$/i;
export const signOff = /sign ?out|log ?out|log ?off|end session|exit/i;
export const checkSession = (): void => {
  if (!successFactorsSite || !cs.applicationId) return;
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .sfDialog')]
    .filter((dialog) => rendered(dialog));
  for (const dialog of dialogs) {
    const text = (dialog.innerText || dialog.textContent || "").replace(/\s+/g, " ");
    if (!sessionEnding.test(text)) continue;
    const button = [...dialog.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], input[type="submit"]')]
      .filter((candidate) => rendered(candidate) && !(candidate as HTMLButtonElement).disabled)
      .find((candidate) => {
        const name = (candidate instanceof HTMLInputElement ? candidate.value : candidate.innerText || candidate.textContent || candidate.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim();
        return keepWorking.test(name) && !signOff.test(name);
      });
    if (!button) continue;
    // A key of theirs may still be landing in their field; looked at again
    // when they pause.
    if (cs.applicantControl?.isConnected && performance.now() - cs.applicantGesture < 2000) {
      void pause(2100).then(checkSession);
      return;
    }
    button.click();
    cs.sessionToldExpired = false;
    noteSession("extended");
    return;
  }
  if (!cs.sessionToldExpired && (sessionEnded.test(document.title) ||
    dialogs.some((dialog) => sessionEnded.test(dialog.innerText || dialog.textContent || "")))) {
    cs.sessionToldExpired = true;
    noteSession("expired");
  }
};
export const checkSubmitted = () => {
  // In any frame: an employer's careers page shows the Greenhouse form,
  // and its "thank you", in a frame of its own. The site rules for the frame's own address decide.
  if (cs.toldSubmitted) return;
  if (submittedOnPage()) {
    cs.toldSubmitted = true;
    tell({ type: "SUBMITTED_PAGE", generic: false });
    return;
  }
  // A message read from the page's words, not a site rule: the
  // background takes it only from a frame it filled, so it may be
  // dropped, and a site rule matching later is still told.
  if (cs.toldByWords || !confirmationInPlace()) return;
  cs.toldByWords = true;
  tell({ type: "SUBMITTED_PAGE", generic: true });
};
