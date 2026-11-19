// Part of the content script (content.ts): the command a frame is sent, and helpers that run outside any one page's state.
// Split out of content.ts as it was; see content.ts for how it starts.
import { requestTrustedType as sendTrustedKeys } from "../../engine/page/bridge";
import { type Control } from "../semantics";
import { type Proposal, type Artifact, type Profile, type SignaturePolicy } from "../../shared/model";
import { cs } from "./state";

export const ownKeysNow = () => cs.keysInFlight > 0 || performance.now() < cs.keysSettleUntil;
// Whether an event could be one of the extension's own real keystrokes: while
// they are being sent (and briefly after), and only on the element they are
// sent to. The same keys anywhere else are the applicant's.
export const ownKeysOn = (event: Event) => ownKeysNow() && Boolean(cs.keysTarget) && event.composedPath().includes(cs.keysTarget!);
export const requestTrustedType: typeof sendTrustedKeys = async (...args) => {
  cs.keysInFlight++;
  cs.keysTarget = args[0];
  try {
    return await sendTrustedKeys(...args);
  } finally {
    cs.keysInFlight--;
    cs.keysSettleUntil = performance.now() + 400;
  }
};

// Chrome runs a hidden tab's chained timers about once a minute after five
// minutes out of sight, so a fill left in a background tab took a minute for
// each wait inside a dropdown or an upload (a 25-minute Greenhouse fill). A wait is also ended by the extension's background, whose
// timers are not the page's: whichever comes first.
// An older react-select's input has no combobox role: its own id, or the
// container class a site gives it (one employer's "dropdown-autocomplete").
// A read-only box whose value comes from a picker opened by the button
// beside it (a calendar).
export const pickerBox = (element: Element) =>
  element instanceof HTMLInputElement && element.readOnly && Boolean(element.parentElement?.querySelector('button[type="button"]'));
export const listButton = (element: Element) => element.matches('button[type="button"][aria-haspopup="listbox"]');
export const legacyReactSelect ='input[id^="react-select-"][aria-autocomplete="list"],.dropdown-autocomplete input[aria-autocomplete="list"]';
// A text box that calls itself a combobox for the calendar it opens (Amazon's
// "YYYY-MM-DD"): it is typed into, not picked from.
export const calendarBox = (element: Element) =>
  element instanceof HTMLInputElement && element.type === "text" &&
  element.getAttribute("aria-haspopup") === "dialog" && /\b(yyyy|mm|dd)\b/i.test(element.placeholder);
export const wakes = new Map<number, () => void>();
// A date format the control shows: its placeholder, pattern, title or the
// text it is described by ("DD/MM/YYYY", "yyyy-mm-dd", "JJ/MM/AAAA").
export function dateFormatHint(element: Element): string | undefined {
  const own = ["placeholder", "pattern", "title", "aria-placeholder", "data-date-format"].map((name) => element.getAttribute(name) || "");
  const described = (element.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || "");
  const hint = [...own, ...described].find((text) => /\b(dd|jj|tt|mm|yyyy|aaaa|jjjj)\b[\s./-]+\b(dd|jj|tt|mm|yyyy|yy|aaaa|jjjj)\b/i.test(text));
  return hint ? hint.trim().slice(0, 100) : undefined;
}

export function wakeChannel(): chrome.runtime.Port | undefined {
  if (cs.wakePort) return cs.wakePort;
  try {
    const port = chrome.runtime.connect({ name: "lane-wake" });
    port.onMessage.addListener((message: { id?: number }) => {
      const done = typeof message?.id === "number" ? wakes.get(message.id) : undefined;
      done?.();
    });
    port.onDisconnect.addListener(() => {
      if (cs.wakePort === port) cs.wakePort = undefined;
      for (const done of [...wakes.values()]) done();
    });
    cs.wakePort = port;
  } catch {
    cs.wakePort = undefined;
  }
  return cs.wakePort;
}
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = ++cs.wakeCount;
    const done = () => {
      wakes.delete(id);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (document.visibilityState !== "hidden") return;
    const port = wakeChannel();
    if (!port) return;
    wakes.set(id, done);
    try {
      port.postMessage({ id, ms });
    } catch {
      wakes.delete(id);
    }
  });
}

export type RecordEntry = {
  element: Control;
  id: string;
  last: string;
  revision: number;
  protected: boolean;
  label: string;
  attachmentId?: string;
  automationWritten?: boolean;
  // When the engine last wrote this field. Site-driven follow-ups (framework
  // re-renders, dependent fields) arriving within writeGrace are attributed to
  // that write instead of to the user; after that the attribution expires.
  writePendingAt?: number;
  conflict?: boolean;
  fillWarning?: string;
  // Why this field is protected, so a skipped field can be explained.
  protectedBy?: string;
  // The fill operation in which writing this field failed.
  failedOperation?: number;
  // The answer that failed: another one is still tried in the same fill.
  failedValue?: string;
  // Put there by the site from a parsed resume, so the profile may replace it.
  siteValue?: boolean;
  // A site value a site rule found already right (see onConfirmed).
  confirmed?: boolean;
};
export type Command = {
  type: string;
  applicationId: string;
  operation: number;
  documentId?: string;
  proposals?: Proposal[];
  fieldId?: string;
  expectedValue?: string;
  revision?: number;
  artifact?: Artifact & { data: string };
  locks?: string[];
  // OPTIONS: the fields whose option lists to read.
  fieldIds?: string[];
  listButtonsOnly?: boolean;
  profile?: Profile;
  // What the applicant lets a fill sign (Settings → Signatures, through the fill's profile), on commands
  // that write proposals without the whole profile.
  signatures?: SignaturePolicy;
  // PRESS_STEP: which control, and its label as the applicant confirmed it.
  step?: "next" | "submit";
  label?: string;
  token?: string;
  session?: string;
  startedAt?: number;
  replaceSiteValues?: boolean;
  ownWrites?: { label: string; value: string }[];
  section?: string;
  index?: number;
  groupLoop?: boolean;
  // A config pass limited to these keys, with the documents its upload
  // steps hand to the site (uploads made through a dialog, SuccessFactors).
  onlyKeys?: string[];
  uploads?: Partial<Record<Artifact["kind"], Artifact & { data: string }>>;
  // ATTACHED: the document file name to look for.
  name?: string;
  // ATTACH: the applicant asked to replace a document the site already held.
  replaceExisting?: boolean;
  // PAGE_TIMERS: whether the page's own timers are kept on time while hidden.
  on?: boolean;
};

export const INVISIBLE_CAPTCHA =
  "The site verifies submissions with a CAPTCHA you cannot see. If it reports a verification error, reload the page and submit again.";
