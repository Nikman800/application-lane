// Part of the content script (content.ts): noticing the applicant's own input, and the checks every write passes.
// Split out of content.ts as it was; see content.ts for how it starts.
import { ourClick, tell, nativeActivationControl, lockKey, clip } from "../content-dom";
import { sectionFor, writable } from "../semantics";
import { type Proposal } from "../../shared/model";
import { cs } from "./state";
import { actingOn, actingSince } from "../../engine/page/bridge";
import { addLock, documentId, fieldLabel, lockOrigins, lockedLabels, nodeRecords, ownClickEvent, records, trustedKeyEvents, userAttention } from "./tracking";
import { Command, RecordEntry, ownKeysOn } from "./core";
import { inspect } from "./inspect";
import { clearPendingWrites, elementLockKeys, valueOf } from "./controls";

export const editingTarget = (entry: EventTarget) =>
  entry instanceof HTMLElement &&
  (nodeRecords.has(entry) ||
    entry.isContentEditable ||
    entry.matches(
      'input,textarea,select,button,label,.select2-selection,[role="combobox"],[role="listbox"],[role="option"],[role="radio"],[role="checkbox"],[role="switch"],[role="textbox"],[role="spinbutton"],[role="slider"]',
    ));
export function human(event: Event) {
  if (cs.writing && !event.isTrusted) return;
  if (event.isTrusted && ownKeysOn(event) && ["keydown", "keyup", "keypress", "beforeinput", "input", "change"].includes(event.type)) return;
  // Our own real keystrokes (CDP) are trusted, so this is the one case where
  // a trusted event is not the user's. Telling them apart is safe because we
  // only type while the page lacks the user's attention (no focus, or no
  // click or key of theirs lately and no control of theirs in use), and
  // only into the one element being typed into right now.
  if (
    cs.trustedWrite &&
    event.isTrusted &&
    !userAttention() &&
    (trustedKeyEvents.includes(event.type) || ourClick(event)) &&
    event.composedPath().includes(cs.trustedWrite)
  )
    return;
  // The fill's own click on the control it is writing (clickBox), at its point.
  if (cs.trustedWrite && ownClickEvent(event) && event.composedPath().includes(cs.trustedWrite)) return;
  // The fill moving focus to the control it writes commits a value left typed
  // in another (a select2 search box's "TypeScript"): the browser's change
  // there is the fill's doing unless the applicant touched the page since.
  const since = actingSince();
  if (event.isTrusted && event.type === "change" && since !== undefined && cs.applicantGesture < since && !actingOn(event.composedPath())) return;
  if (
    cs.searchSettle &&
    performance.now() < cs.searchSettle.until &&
    event.isTrusted &&
    !userAttention() &&
    ["input", "change"].includes(event.type) &&
    event.composedPath().includes(cs.searchSettle.element)
  )
    return;
  // A modifier pressed alone changes nothing on the page: the applicant's
  // Win+Shift+S for a screenshot, landing on the question the fill had
  // focused, paused a Workday fill as their edit (report 45c45d09).
  if (event.isTrusted && event.type === "keydown" && /^(Shift|Control|Alt|Meta|OS|AltGraph|CapsLock|Fn)$/.test((event as KeyboardEvent).key)) return;
  if (event.isTrusted && ["pointerdown", "keydown", "touchstart"].includes(event.type)) {
    cs.applicantGesture = performance.now();
    // Only a control that takes typing keeps their attention: a click on
    // Next starts the step the fill is about to type into.
    const touched = event.composedPath().find(editingTarget);
    const control = touched instanceof HTMLLabelElement ? touched.control : touched;
    cs.applicantControl =
      control instanceof HTMLElement &&
      (control.isContentEditable ||
        control.matches('textarea,[role="textbox"],[role="combobox"],[role="spinbutton"]') ||
        (control instanceof HTMLInputElement &&
          !["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color"].includes(control.type)))
        ? control
        : undefined;
  }
  if (event.isTrusted) cs.lastApplicantInput = performance.now();
  if (!event.isTrusted) {
    if (cs.applicationId && ["input", "change"].includes(event.type)) {
      inspect();
      tell({ type: "FORM_CHANGED", applicationId: cs.applicationId, operation: cs.operation, documentId });
    }
    return;
  }
  if (
    ["pointerdown", "keydown", "touchstart"].includes(event.type)
  ) {
    // The applicant watches the tab while it fills. Scrolling, reading and
    // clicking empty space are not edits; only touching a form control is.
    if (!event.composedPath().some(editingTarget)) return;
    cs.ownedActivation = undefined;
    clearPendingWrites();
  }
  if (
    ["input", "change"].includes(event.type) &&
    cs.ownedActivation &&
    event.composedPath().includes(cs.ownedActivation.control)
  ) {
    cs.ownedActivation.events.delete(event.type);
    if (!cs.ownedActivation.events.size) cs.ownedActivation = undefined;
    return;
  }
  if (event.type === "compositionstart") cs.composing = true;
  if (event.type === "compositionend") cs.composing = false;
  const path = event.composedPath();
  let target = path.find(
    (entry) => entry instanceof HTMLElement && nodeRecords.has(entry),
  ) as HTMLElement | undefined;
  if (!target) {
    const control = path
      .filter((entry): entry is Element => entry instanceof Element)
      .map(nativeActivationControl)
      .find((entry) => entry && nodeRecords.has(entry));
    target = control;
  }
  if (
    target &&
    ["input", "change"].includes(event.type)
  ) {
    const record = nodeRecords.get(target)!;
    const current = valueOf(record.element);
    if (current !== record.last) {
      record.protected = true;
      record.protectedBy = `a real ${event.type} on "${record.label.slice(0, 60)}"`;
      record.siteValue = false;
      record.revision++;
      record.last = current;
      record.automationWritten = false;
      record.conflict = false;
      addLock(
        lockKey({ label: record.label, ...sectionFor(record.element) }),
        record.protectedBy,
      );
      for (const key of elementLockKeys(record.element, record.label))
        addLock(key, record.protectedBy);
    }
  }
  if (!cs.applicationId) return;
  // Named even when the page is already paused: the extension pauses it
  // itself once a fill ends, and the applicant's next edit is the cause.
  if (!cs.pausedBy) {
    const touched = event.composedPath().find((entry): entry is HTMLElement => entry instanceof HTMLElement);
    const kind = event.type === "pointerdown" || event.type === "touchstart" ? "a click" : event.type === "keydown" ? "a key press" : event.type.startsWith("composition") ? "typing" : "an edit";
    const where = (target && nodeRecords.get(target)?.label) || touched?.getAttribute("aria-label") || touched?.textContent || touched?.tagName.toLowerCase() || "the page";
    cs.pausedBy = `${kind} on "${clip(where, 60)}"`;
  }
  cs.paused = true;
  cs.configController.abort();
  tell({
    type: "HUMAN_PAUSE",
    applicationId: cs.applicationId,
    operation: cs.operation,
    documentId,
    cause: cs.pausedBy,
    // Only the applicant's own edits are remembered with the application.
    // Locks from site behaviour stay with this page and end with it.
    locks: [...lockedLabels].filter(
      (key) =>
        /^(a real|an edit saved)/.test(lockOrigins.get(key) || "an edit saved"),
    ),
  });
}

export const valid = (command: Command) =>
  !cs.paused &&
  !cs.composing &&
  command.applicationId === cs.applicationId &&
  command.operation === cs.operation &&
  command.documentId === documentId &&
  (!command.documentURL || command.documentURL === location.href);
export function invalidCommandReason(command: Command): string | undefined {
  if (cs.paused) return "The application is paused.";
  if (cs.composing) return "Text composition is in progress.";
  if (command.applicationId !== cs.applicationId) return "The application binding changed.";
  if (command.operation !== cs.operation) return "The fill operation changed.";
  if (command.documentId !== documentId) return "The page document changed.";
  if (command.documentURL && command.documentURL !== location.href) return "The application URL changed.";
}
export function guardedRecord(
  command: Command,
  proposal: Pick<Proposal, "fieldId" | "revision" | "expectedValue">,
): { record: RecordEntry; reason?: never } | { record?: undefined; reason: string } {
  const record = records.get(proposal.fieldId);
  const invalid = invalidCommandReason(command);
  if (invalid) return { reason: invalid };
  if (!record) return { reason: "The field is no longer recorded." };
  if (!record.element.isConnected) return { reason: "The field was detached from the page." };
  if (!writable(record.element)) return { reason: "The field is no longer writable." };
  if (fieldLabel(record.element) !== record.label) return { reason: "The field label changed." };
  if (record.protected) return { reason: "The field is protected from automatic changes." };
  // Only the same answer: one planned before the list's options were read
  // ("No", "December 2027") failed, and its corrected one ("Not
  // Applicable", "December") was then never tried.
  if (record.failedOperation === cs.operation && (!("value" in proposal) || (proposal as { value?: string }).value === record.failedValue))
    return { reason: "The field already failed in this fill." };
  if (record.revision !== proposal.revision) return { reason: "The field revision changed since inspection." };
  if (valueOf(record.element) !== proposal.expectedValue) return { reason: "The field value changed since inspection." };
  // Focus our own typing moved there is not the applicant's: Workday moves
  // a date's focus from its Month to its Day as the Month is typed, and the
  // Day was refused, the date left half typed.
  const ourFocus = performance.now() - cs.lastEngineWrite < 3000 && performance.now() - cs.lastApplicantInput > 2000;
  // A box that only kept the focus of an earlier click is not in use: Meta's
  // Current location was refused for the focus of a click the applicant made
  // two minutes before. It is theirs while they
  // have touched the page within ten seconds.
  const applicantHere = performance.now() - cs.lastApplicantInput < 10_000;
  if (document.activeElement === record.element && !ourFocus && applicantHere) return { reason: "The field currently has focus." };
  return { record };
}
export function guard(
  command: Command,
  proposal: Pick<Proposal, "fieldId" | "revision" | "expectedValue">,
): RecordEntry | undefined {
  return guardedRecord(command, proposal).record;
}
export function changed(record: RecordEntry) {
  record.writePendingAt = performance.now();
  record.element.dispatchEvent(
    new Event("input", { bubbles: true, composed: true }),
  );
  record.element.dispatchEvent(
    new Event("change", { bubbles: true, composed: true }),
  );
  record.last = valueOf(record.element);
  record.revision++;
  record.automationWritten = true;
  // The write stays attributed for writeGrace: frameworks commonly rewrite
  // the field right after our events, and that is not a user edit.
}
