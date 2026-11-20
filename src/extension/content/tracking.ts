// Part of the content script (content.ts): the page's tracked fields, edit locks, and what the applicant and the fill are doing.
// Split out of content.ts as it was; see content.ts for how it starts.
import { type Control, fieldLabel as nativeFieldLabel, ownLabel as nativeOwnLabel, documentKind, fileKind as nativeFileKind } from "../semantics";
import { cs } from "./state";
import { RecordEntry, pause } from "./core";

export const documentId = crypto.randomUUID();
export const records = new Map<string, RecordEntry>();
export const semanticIds = new Map<string, string>();
export const nodeRecords = new WeakMap<HTMLElement, RecordEntry>();
export const ownedAutocompleteSearches = new WeakMap<HTMLInputElement, string>();
export const fieldLabel = (element: Control) => cs.fileControls.get(element)?.label || cs.radioControls.get(element)?.label || nativeFieldLabel(element);
export const ownLabel = (element: Control) => cs.radioControls.get(element)?.option || nativeOwnLabel(element);
export const fileKind = (element: Control) => cs.fileControls.has(element) ? documentKind(fieldLabel(element)) : nativeFileKind(element);
export const lockedLabels = new Set<string>();
// What created each lock, so a protected field can say why.
export const lockOrigins = new Map<string, string>();
export const addLock = (key: string, origin: string) => {
  // No label, no field: such a lock held every field (see elementLockKeys).
  if (/:$/.test(key)) return;
  lockedLabels.add(key);
  if (!lockOrigins.has(key)) lockOrigins.set(key, origin);
};
// The applicant is using the page while their last click or key on it is
// recent, or from when they touch a form control until they click away
// from the form or leave the page; the fill moving focus off their control
// does not end it. A tab merely in front is not that: it was refused real
// keys, so Workday's dates were assigned and dropped in a focused tab and
// typed in a background one. Focus Chrome hands the page when the debugger
// types counts for nothing.
export const attentionSpan = 3000;
export const userAttention = () =>
  document.hasFocus() &&
  (performance.now() - cs.applicantGesture < attentionSpan || !!cs.applicantControl?.isConnected);
export const trustedKeyEvents = ["keydown", "beforeinput", "input", "change"];
export const ownClickEvent = (event: Event) =>
  !!cs.ownClickAt &&
  event.isTrusted &&
  performance.now() < cs.ownClickAt.until &&
  /^(pointer|mouse)(down|up)$|^click$/.test(event.type) &&
  Math.abs((event as MouseEvent).clientX - cs.ownClickAt.x) <= 2 &&
  Math.abs((event as MouseEvent).clientY - cs.ownClickAt.y) <= 2;
// Ashby saves each answer to its server as it is entered, one request per
// field (ApiSetFormValue), and overlapping saves lose each other: the page
// shows the answer while Submit reports it missing. On such a site every
// write waits for the save it started before the next write. Completed
// requests are read from resource timing; the page's code is not touched.
export const pacesSaves = /(^|\.)ashbyhq\.com$/.test(location.hostname);
export const awaitSiteSave = async (before: number) => {
  if (!pacesSaves) return;
  // Bounded: a write the site does not save (an unchanged value, a click
  // that only opens a list) costs at most this long.
  const deadline = performance.now() + 1000;
  while (cs.savesFinished <= before && performance.now() < deadline)
    await pause(40);
};
export const trackedControlSelector =
  'input,textarea,select,button[aria-haspopup="listbox"],button.fab-SelectToggle[data-menu-id],button[aria-pressed],[role="checkbox"],[role="radio"],[role="combobox"]';
