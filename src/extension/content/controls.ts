// Part of the content script (content.ts): reading controls' values, and the marks the fill leaves on what it wrote.
// Split out of content.ts as it was; see content.ts for how it starts.
import { type Control, iconRadioLabel, currentFileName, listedFileName, isToggleChoice, toggleGroup, selectedCustomValue, wfnDropdown, placeholderOption, sectionFor, legacyLabels, writable } from "../semantics";
import { radioGroup, clip, isTrackableControl, openModal, lockKey, searchWithoutPick, placeholder, nativeActivationControl } from "../content-dom";
import { configEngineEnabled } from "../../engine/mode";
import { configuredFileControls, configuredRadioControls } from "../../engine/runtime";
import { normalize } from "../../shared/model";
import { cs } from "./state";
import { fieldLabel, lockOrigins, lockedLabels, nodeRecords, ownLabel, ownedAutocompleteSearches, records, trackedControlSelector } from "./tracking";
import { RecordEntry, calendarBox, legacyReactSelect } from "./core";

export const valueOf = (element: Control): string => {
  if (element.matches('.ashby-application-form-input-autocomplete[role="combobox"][aria-expanded="true"]')) return "";
  // A select2 search box holds a query, never a pick (the picks are its
  // select's): a skill an earlier fill typed and left there read as an
  // existing answer and kept Avature's skills from being chosen.
  if (element instanceof HTMLInputElement && element.classList.contains("select2-search__field")) return "";
  // Our own autocomplete query is not a selected application answer.
  if (element instanceof HTMLInputElement &&
    ownedAutocompleteSearches.has(element) &&
    element.value === ownedAutocompleteSearches.get(element)) return "";
  // A SuccessFactors list where "No Selection" was picked holds nothing:
  // read as an answer, it stayed locked as the applicant's, and Unlock
  // empty fields could not release it.
  if (element instanceof HTMLInputElement && element.classList.contains("rcmpaginatedselectinput") &&
    /^no selection$/i.test(element.value.trim())) return "";
  const file = cs.fileControls.get(element);
  // A tracked uploader that lists its file beside an emptied input
  // (SmartRecruiters' spl-dropzone).
  if (file) return file.value || currentFileName(element);
  if (isToggleChoice(element)) {
    const pressed = toggleGroup(element).find(
      (button) => button.getAttribute("aria-pressed") === "true",
    );
    return pressed ? ownLabel(pressed) : "";
  }
  const role = element.getAttribute("role");
  if (role === "radio" && !(element instanceof HTMLInputElement)) {
    const selected = radioGroup(element).find(
      (candidate) =>
        candidate.getAttribute("aria-checked") === "true" ||
        (iconRadioLabel(candidate)?.control as HTMLInputElement | null | undefined)?.checked === true,
    );
    return selected ? ownLabel(selected) : "";
  }
  // BambooHR's fabric select shows its choice in the toggle; until one is
  // made the toggle shows its placeholder ("–Select–") in a box of its own.
  if (element.matches("button.fab-SelectToggle[data-menu-id]")) {
    if (element.querySelector(".fab-SelectToggle__placeholder")) return "";
    return clip(element.querySelector(".fab-SelectToggle__guts")?.textContent || element.textContent || "");
  }
  if (wfnDropdown(element)) return selectedCustomValue(element) || "";
  if (element.matches('button[aria-haspopup="listbox"]')) {
    const chosen = selectedCustomValue(element);
    if (chosen !== undefined && element.matches('[role="combobox"]') && element.getRootNode() instanceof ShadowRoot &&
      (element.getRootNode() as ShadowRoot).host.closest("spl-select")) return clip(chosen);
    const value = clip(element.textContent || "");
    return /^(?:select(?: one)?|select[.…]*|choose|--)?$/i.test(value)
      ? ""
      : value;
  }
  if (role === "checkbox" && iconRadioLabel(element))
    return (iconRadioLabel(element)!.control as HTMLInputElement).checked ? "Yes" : "";
  if (
    ["checkbox", "radio"].includes(role || "") &&
    (!(element instanceof HTMLInputElement) ||
      !["checkbox", "radio"].includes(element.type))
  )
    return element.getAttribute("aria-checked") === "true"
      ? role === "checkbox" ? "Yes" : ownLabel(element) || element.getAttribute("value") || "true"
      : "";
  if (element instanceof HTMLSelectElement) {
    const option = element.selectedOptions[0];
    if (!option || placeholderOption(option)) return "";
    // Angular's ng-options give each option a value of its own ("string:AZ",
    // Jobvite's State): the option is read as what it shows.
    return /^(string|number|boolean|object):/.test(element.value) ? option.label || option.text.trim() : element.value;
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") {
      const group = radioGroup(element);
      if (group.length > 1) {
        const selected = group.find(
          (candidate) =>
            candidate instanceof HTMLInputElement && candidate.checked,
        );
        return selected ? ownLabel(selected) || "Yes" : "";
      }
      return element.checked ? "Yes" : "";
    }
    if (element.type === "radio") {
      const selected = radioGroup(element).find(
        (candidate) =>
          candidate instanceof HTMLInputElement && candidate.checked,
      );
      return selected
        ? ownLabel(selected) ||
            (selected instanceof HTMLInputElement ? selected.value : "")
        : "";
    }
    if (element.type === "file")
      return (
        [...(element.files || [])].map((f) => f.name).join(", ") ||
        currentFileName(element)
      );
  }
  // TikTok's UD select keeps its search box empty and draws the choice (or
  // a multiple one's tags) beside it. Read as the empty box, a question its
  // site rule answered looked unanswered, and a multiple list's choice was
  // clicked again, which takes it off.
  if (element instanceof HTMLInputElement && element.classList.contains("ud__select__selector__search__input")) {
    const selector = element.closest(".ud__select__selector");
    if (selector) {
      const chosen = [...selector.querySelectorAll(".ud__select__selector__selectItem, .ud__select__selector__tag")]
        .map((item) => clip(item.textContent || "")).filter(Boolean);
      return chosen.join(", ");
    }
  }
  if ((element.getAttribute("role") === "combobox" && !calendarBox(element)) || element.closest(".pcty-input-select__input") || element.matches(legacyReactSelect)) {
    const accessibleValue = selectedCustomValue(element);
    if (accessibleValue !== undefined) return accessibleValue;
    if (element instanceof HTMLInputElement) return element.value;
    const shown = element.textContent?.trim() || "";
    // Rippling shows its placeholder ("Select", "Select...") as the text,
    // and repeats it as the control's own name.
    if (shown === (element.getAttribute("aria-label") || "").trim() && /^select[.…]*$/i.test(shown) &&
        element.closest('[data-testid="select-controller"]')) return "";
    return element.getAttribute("data-placeholder") === "true"
      ? ""
      : shown;
  }
  return "value" in element
    ? String(element.value)
    : element.getAttribute("aria-valuetext") ||
        element.textContent?.trim() ||
        "";
};
export function controls(): Control[] {
  const result: Control[] = [];
  const visit = (root: Document | ShadowRoot) => {
    result.push(
      ...root.querySelectorAll<Control>(trackedControlSelector),
    );
    for (const element of root.querySelectorAll("*"))
      if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  cs.fileControls = new Map((configEngineEnabled ? configuredFileControls() : []).map((field) => [field.element, field]));
  cs.radioControls = new Map((configEngineEnabled ? configuredRadioControls() : []).map((field) => [field.element, field]));
  // A configured slot may be the native input found above (JazzHR's
  // resume): it is one field, not two of the same label.
  result.push(...[...cs.fileControls.keys()].filter((element) => !result.includes(element)));
  const tracked = result.filter(isTrackableControl);
  // A modal dialog is the whole form while it is open: what lies behind
  // it cannot be reached (one employer's search filters behind Easy Apply).
  const modal = openModal(tracked);
  return modal ? tracked.filter((element) => modal.contains(element)) : tracked;
}
export const controlsWithin = (element: Element): Control[] => {
  const candidates: Control[] = [];
  for (const control of cs.fileControls.keys())
    if (control === element || control.contains(element)) candidates.push(control);
  if (element.matches(trackedControlSelector))
    candidates.push(element as Control);
  candidates.push(
    ...element.querySelectorAll<Control>(trackedControlSelector),
  );
  const owner = element.closest<Control>(trackedControlSelector);
  if (owner) candidates.push(owner);
  return [...new Set(candidates)].filter(isTrackableControl);
};
export const writeGrace = 5000;
export const writePending = (record?: { writePendingAt?: number }) =>
  record?.writePendingAt !== undefined &&
  performance.now() - record.writePendingAt < writeGrace;
// The control is another part of the small group the fill just wrote in,
// as a date's Year is beside its Month: the smallest block holding both
// holds no more than three controls. A field elsewhere on the form the
// site fills after a write (its resume parser's output) is not.
export const besideLastWrite = (element: Element) => {
  if (!cs.lastWritten?.isConnected || cs.lastWritten.contains(element)) return false;
  let block = cs.lastWritten.parentElement;
  while (block && !block.contains(element)) block = block.parentElement;
  return Boolean(block) && block!.querySelectorAll(trackedControlSelector).length <= 3;
};
export const markEngineWrite = (...elements: (Element | undefined)[]) => {
  cs.lastEngineWrite = performance.now();
  cs.lastWritten = elements.find(Boolean) || cs.lastWritten;
  for (const element of elements) {
    if (!element) continue;
    // A click on a label's drawn box (Oracle's Graduated: a span inside the
    // label) changes the checkbox the label names: that change is ours, not
    // the applicant's edit to lock.
    const named = element.closest("label")?.control;
    for (const control of [...controlsWithin(element), ...(named ? controlsWithin(named) : [])])
      for (const member of radioGroup(control)) {
        const record = nodeRecords.get(member as HTMLElement);
        if (record) record.writePendingAt = performance.now();
      }
  }
};
export const clearPendingWrites = () => {
  for (const record of records.values()) record.writePendingAt = undefined;
};
export const listPlaceholder = /^(no selection|select( one| an option)?|please select( one)?|choose( one)?)$/;
export const elementLockKeys = (element: Control, label: string) => {
  const section = sectionFor(element);
  // A key with no label names no field: SmartRecruiters' <label>s hold
  // only whitespace around a slot, every field read ":0:" under its older
  // label, and one lock under it left a whole screening step unfilled.
  return keysFor(element, label, section).filter((key) => !/:$/.test(key));
};
export const keysFor = (element: Control, label: string, section: ReturnType<typeof sectionFor>) => {
  return [
    lockKey({ label, ...section }),
    // A lock saved before sections were told apart covers only a field
    // that still has none: in a section, it cannot say which row it was
    // (SuccessFactors' ":0:country" held every row's Country).
    // A list's placeholder, which every list of the row shows, names only
    // a list holding an answer: one lock under "No Selection" kept Expand
    // Energy's empty Education Type, Country, Degree and Status empty
    //, and without it the applicant's own picks there
    // (Brightline's "State of Andhra Pradesh") were filled over.
    ...legacyLabels(element).filter((legacy) => !listPlaceholder.test(normalize(legacy)) || Boolean(valueOf(element))).flatMap((legacy) => [
      lockKey({ label: legacy, ...section }),
      ...(section.section ? [] : [lockKey({ label: legacy, section: "", index: 0 })]),
    ]),
  ];
};
// The applicant's own edits: a real event on the page, or a lock saved
// with the application from one. Other locks record what the site did.
export const applicantLock = (key: string) =>
  /^(a real|an edit saved)/.test(lockOrigins.get(key) || "an edit saved");
export const hasEditLock = (element: Control, label: string) =>
  !searchWithoutPick(element) &&
  elementLockKeys(element, label).some(
    (key) => lockedLabels.has(key) && (applicantLock(key) || Boolean(valueOf(element))),
  );
export const lockReason = (element: Control, label: string) => {
  const key = elementLockKeys(element, label).find((candidate) =>
    lockedLabels.has(candidate),
  );
  return key
    ? `edit lock "${key}" from ${lockOrigins.get(key) || "an earlier fill of this application"}`
    : "edit lock";
};
export const adoptSiteValue = (record: RecordEntry) => {
  // A file Apple lists in the uploader's own list stays: the list only grows,
  // and replacing it would add the document a second time.
  if (listedFileName(record.element)) return;
  const { section, index } = sectionFor(record.element);
  const ownWritten = cs.ownWrites.some((entry) => entry.label === record.label && entry.value === record.last &&
    (entry.section === undefined || (entry.section === section && entry.index === index)));
  if ((cs.replaceSiteValues || placeholder(record.last) || ownWritten) && record.protectedBy === "existing value") {
    record.protected = false;
    record.protectedBy = undefined;
    record.siteValue = true;
    record.confirmed = false;
  }
};
export const trackLocalControls = (candidates: Control[]) => {
  for (const element of candidates) {
    const group = radioGroup(element);
    const representative = group.find(writable) || element;
    let record = nodeRecords.get(representative as HTMLElement);
    if (!record) {
      const label = fieldLabel(representative);
      const current = valueOf(representative);
      record = {
        element: representative,
        id: crypto.randomUUID(),
        last: current,
        revision: 1,
        protected:
          Boolean(current) || hasEditLock(representative, label),
        protectedBy: hasEditLock(representative, label)
          ? lockReason(representative, label)
          : current
            ? "existing value"
            : undefined,
        label,
      };
      adoptSiteValue(record);
      nodeRecords.set(representative as HTMLElement, record);
      records.set(record.id, record);
    }
    for (const member of group) nodeRecords.set(member as HTMLElement, record);
  }
};
export const expectOwnedActivation = (
  element: Element,
  method: string,
  event?: string,
) => {
  // A checkbox or radio a rule sets is clicked too (mainWorld.ts), and the
  // browser reports that click's input and change as trusted: unclaimed,
  // they read as the applicant's edit and paused every fill (Workday's
  // "I am fluent").
  const writesChoice =
    // (Every method that writes a value: Workday's default is "react".)
    ["selectCheckboxOrRadio", "checkOption", "default", "defaultWithoutBlur", "react", "dijit", "jQuery", "setValue", "setValueOnly"].includes(method) &&
    nativeActivationControl(element) === element;
  if (!(["click", "reactClick"].includes(method) || event === "click" || writesChoice))
    return;
  const control = nativeActivationControl(element);
  if (control)
    cs.ownedActivation = { control, events: new Set(["input", "change"]) };
};
