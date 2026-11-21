// Part of the content script (content.ts): writing a fill's proposals into the page.
// Split out of content.ts as it was; see content.ts for how it starts.
import { signatureField, signingAllowed, signatureLeftReason } from "../../engine/page/signatures";
import { tell, paylocityAddressBox, ripplingLocation, radioGroup, associatedNativeChoice } from "../content-dom";
import { tdsDateBox, pickTdsDate } from "../../engine/page/tds-date-picker";
import { pickOption } from "../../shared/answers";
import { writable, isToggleChoice, toggleGroup } from "../semantics";
import { fillClick } from "../../engine/page/click-gate";
import { type Proposal, normalize } from "../../shared/model";
import { cs } from "./state";
import { Command, calendarBox, legacyReactSelect, listButton, pause } from "./core";
import { changed, guardedRecord, valid } from "./guards";
import { awaitSiteSave, documentId, nodeRecords, ownLabel, records } from "./tracking";
import { checkControl, clickBox, fillPaylocityAddress, fillRipplingLocation, selectCustom, typeTrusted } from "./choose";
import { valueOf } from "./controls";
import { inspect } from "./inspect";

export async function apply(command: Command) {
  const results: { id: string; ok: boolean; reason?: string }[] = [];
  // Date parts typed with their Month (see the Workday date below), and
  // the dates already tried so.
  const typedWhole = new Set<string>();
  const datesTried = new Set<Element>();
  // Boxes ticked or cleared in this fill, read again at the end of each
  // batch: the click that redraws one may come in a later batch.
  if (cs.boxesWanted.operation !== cs.operation) cs.boxesWanted = { operation: cs.operation, boxes: new Map() };
  const boxesSet = cs.boxesWanted.boxes;
  for (const proposal of command.proposals || []) {
    if (typedWhole.has(proposal.fieldId)) {
      results.push({ id: proposal.fieldId, ok: true });
      continue;
    }
    const guarded = guardedRecord(command, proposal);
    const record = guarded.record;
    // A report then says which answer the fill meant for a field and where
    // it came from: a clearance question was answered "No" in report after
    // report, and nothing showed whether this extension or the site did it.
    cs.stopRecording?.note({
      label: (record?.label || proposal.fieldId).slice(0, 80),
      value: proposal.value.slice(0, 80),
      source: proposal.source,
      skipped: record ? undefined : guarded.reason,
    });
    if (!record) {
      results.push({
        id: proposal.fieldId,
        ok: false,
        reason: `Paused, protected, stale, or focused field. ${guarded.reason}`,
      });
      continue;
    }
    const element = record.element;
    // A signature, or its date, only as the applicant's settings allow
    // (signatures.ts).
    const signs = signatureField(element);
    if (signs && !signingAllowed(command.signatures, signs)) {
      results.push({ id: proposal.fieldId, ok: false, reason: signatureLeftReason(signs) });
      continue;
    }
    let selectedLabel = proposal.value;
    let typedDate = false;
    const savesBefore = cs.savesFinished;
    tell({ type: "FILL_PROGRESS", applicationId: cs.applicationId, operation: cs.operation, documentId, label: record.label });
    cs.writing = true;
    try {
      record.writePendingAt = performance.now();
      if (
        element instanceof HTMLInputElement &&
        ["file", "password", "hidden"].includes(element.type)
      )
        throw new Error("Requires manual input.");
      // Text typed in a list of picks' search box is a search the site
      // drops: typed there, one employer's Field of Study was empty again at each
      // look and typed again every two seconds. Its
      // site rule picks from it; what that leaves is the applicant's.
      if (element.matches('[data-automation-id="multiSelectContainer"] input[data-uxi-widget-type="selectinput"]'))
        throw new Error("Pick it from the site's list; typed text there is only a search.");
      // A Workday list is a button that opens it (button[aria-haspopup]):
      // an answer no site rule wrote is picked from it like any other list.
      // It failed as "a custom control" instead (one employer's KPMG question).
      // Not a native list given the role (one employer's iCIMS screening questions):
      // it is set as a select.
      if (paylocityAddressBox(element)) {
        for (const settled of await fillPaylocityAddress(command, proposal, record)) typedWhole.add(settled);
        await awaitSiteSave(savesBefore);
        record.fillWarning = undefined;
        results.push({ id: proposal.fieldId, ok: true });
        continue;
      }
      if (ripplingLocation(element)) {
        await fillRipplingLocation(command, proposal, record);
        await awaitSiteSave(savesBefore);
        record.fillWarning = undefined;
        results.push({ id: proposal.fieldId, ok: true });
        continue;
      }
      if ((element.getAttribute("role") === "combobox" && !(element instanceof HTMLSelectElement) && !calendarBox(element)) || element.closest(".pcty-input-select__input") || element.matches(legacyReactSelect) || listButton(element)) {
        await selectCustom(command, proposal, record);
        recheckPhoneBeside(element, record.label);
        await awaitSiteSave(savesBefore);
        record.fillWarning = undefined;
        results.push({ id: proposal.fieldId, ok: true });
        continue;
      } else if (tdsDateBox(element)) {
        // A date set from its calendar (Tesla's): the month found, the day
        // clicked.
        if (!(await pickTdsDate(element as HTMLInputElement, proposal.value)))
          throw new Error("The calendar did not take the date. Pick it there.");
        record.last = valueOf(element);
        record.revision++;
        record.automationWritten = true;
        await awaitSiteSave(savesBefore);
        record.fillWarning = undefined;
        results.push({ id: proposal.fieldId, ok: true });
        continue;
      } else if (
        element instanceof HTMLInputElement &&
        element.type === "checkbox"
      ) {
        if (!["Yes", "No"].includes(proposal.value))
          throw new Error("Unknown checkbox value.");
        if (!(await clickBox(element, proposal.value === "Yes", command)))
          throw new Error("Site did not retain the value.");
        boxesSet.set(element, { element, wanted: proposal.value === "Yes", fieldId: proposal.fieldId });
      } else if (
        element instanceof HTMLInputElement &&
        element.type === "radio"
      ) {
        const selected = pickOption(
          proposal,
          radioGroup(element).filter(
            (c): c is HTMLInputElement =>
              c instanceof HTMLInputElement && c.type === "radio",
          ),
          (c) => ownLabel(c),
        );
        if (!selected) throw new Error("No exact radio option.");
        if (!(await checkControl(selected, true)))
          throw new Error("Site did not retain the value.");
      } else if (element.getAttribute("role") === "radio") {
        const selected = pickOption(proposal, radioGroup(element).filter(writable), (option) => ownLabel(option));
        cs.stopRecording?.note({ label: record.label.slice(0, 80), chose: selected ? ownLabel(selected) : undefined, id: selected?.id });
        if (!selected) throw new Error("No exact radio option.");
        if (selected instanceof HTMLButtonElement && selected.type === "submit" && selected.form)
          throw new Error("This choice is a submit button inside the form; select it manually.");
        if (selected.getAttribute("aria-checked") !== "true") {
          const native = associatedNativeChoice(selected, "radio");
          if (native) {
            if (!(await checkControl(native, true))) throw new Error("Site did not retain the native choice.");
          } else fillClick(selected);
        }
        await pause(0);
      } else if (element.getAttribute("role") === "checkbox") {
        if (!["Yes", "No"].includes(proposal.value)) throw new Error("Unknown checkbox value.");
        const wanted = proposal.value === "Yes";
        const native = associatedNativeChoice(element, "checkbox");
        if (native) {
          if (!(await checkControl(native, wanted))) throw new Error("Site did not retain the native choice.");
        } else if ((element.getAttribute("aria-checked") === "true") !== wanted) {
          if (element instanceof HTMLButtonElement && element.type === "submit" && element.form)
            throw new Error("This choice is a submit button inside the form; select it manually.");
          fillClick(element);
        }
        await pause(0);
      } else if (isToggleChoice(element)) {
        const selected = pickOption(proposal, toggleGroup(element), (b) => ownLabel(b));
        if (!selected) throw new Error("No exact option.");
        // Ashby's toggles are type=submit outside any form. Inside a form,
        // clicking one could submit the application, which is never ours to do.
        if (selected instanceof HTMLButtonElement && selected.type === "submit" && selected.form)
          throw new Error("This choice is a submit button inside the form; select it manually.");
        // A click is how the site's own handler records the choice; the
        // pressed state follows its re-render.
        if (selected.getAttribute("aria-pressed") !== "true") fillClick(selected);
        await pause(0);
      } else if (element instanceof HTMLSelectElement) {
        const option = pickOption(
          proposal,
          [...element.options].filter((o) => !o.disabled),
          (o) => o.label,
        );
        if (!option) throw new Error("No exact select option.");
        selectedLabel = option.label;
        Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value",
        )!.set!.call(element, option.value);
      } else if (element instanceof HTMLInputElement && element.matches('input[role="spinbutton"][data-automation-id^="dateSection"]')) {
        // A Workday date's Month, Day or Year keeps only what is typed:
        // set, one employer's graduation Month and Day read back empty. Typed as the site's rules type them.
        cs.writing = true;
        try {
          // Its sections take numbers: December is typed as 12.
          const digits = (wanted: Proposal) => /^\d+$/.test(wanted.value.trim())
            ? wanted.value.trim()
            : (wanted.choices || []).find((choice) => /^\d+$/.test(choice.trim()))?.trim() || wanted.value;
          const typed = digits(proposal);
          // The whole date from its Month, as a person types it: Workday
          // moves focus on to the Day and the Year as each is typed, and a
          // Day or Year typed on its own after that had focus taken back to
          // the Month, the date left half typed and its year made 2005
          //. Parts this fill does not answer keep what
          // they hold.
          const wrapper = element.closest('[data-automation-id="dateInputWrapper"],[role="group"]');
          const part = (name: string) => wrapper?.querySelector<HTMLInputElement>(`input[data-automation-id="dateSection${name}-input"]`) || undefined;
          const wantedFor = (input?: HTMLInputElement) =>
            input ? (command.proposals || []).find((other) => records.get(other.fieldId)?.element === input) : undefined;
          const month = part("Month");
          const day = part("Day");
          const year = part("Year");
          const two = (text: string) => (/^\d$/.test(text) ? `0${text}` : text);
          const textOf = (input: HTMLInputElement | undefined, digitsOf: (input: HTMLInputElement) => string) =>
            input ? (input === element ? typed : wantedFor(input) ? digits(wantedFor(input)!) : digitsOf(input)) : "";
          const monthText = two(textOf(month, (input) => input.value));
          const dayText = two(textOf(day, (input) => input.value));
          const yearText = textOf(year, (input) => input.value);
          // Once per date in a fill: a site that does not move on gets
          // each part typed on its own.
          const whole = month && year && wrapper && !datesTried.has(wrapper) &&
            /^\d{2}$/.test(monthText) && /^\d{4}$/.test(yearText) && (!day || /^\d{2}$/.test(dayText));
          let advanced = false;
          let monthTyped = false;
          if (whole) {
            datesTried.add(wrapper!);
            monthTyped = true;
            // The Month first: a site that moves on by itself takes the rest
            // where focus goes; one that does not gets each part below.
            await typeTrusted(command, month!, monthText, () => valid(command), new AbortController().signal);
            await pause(200);
            const next = day || year!;
            advanced = month!.getRootNode() instanceof Document && (month!.ownerDocument.activeElement === next);
            if (advanced) {
              // Each part where focus has gone, at once: typing stops when
              // focus leaves the box it began in (typeTrusted).
              if (day) {
                await typeTrusted(command, day, dayText, () => valid(command), new AbortController().signal);
                await pause(200);
              }
              await typeTrusted(command, year!, yearText, () => valid(command), new AbortController().signal);
              await pause(300);
              const same = (input: HTMLInputElement | undefined, text: string) => !input || Number(input.value) === Number(text);
              if (!same(month, monthText) || !same(day, dayText) || !same(year, yearText))
                throw new Error("Site did not retain the value.");
              // Every part typed is this fill's at once: the Year's change,
              // seen before its own proposal came up, was taken for the
              // applicant's edit and locked.
              for (const input of [month, day, year]) {
                if (!input) continue;
                const typedRecord = nodeRecords.get(input);
                if (typedRecord && typedRecord !== record) {
                  typedRecord.last = valueOf(input);
                  typedRecord.revision++;
                  typedRecord.automationWritten = true;
                  typedRecord.writePendingAt = performance.now();
                }
                const done = wantedFor(input);
                if (done && done.fieldId !== proposal.fieldId) typedWhole.add(done.fieldId);
              }
            }
          }
          if (!advanced && !(monthTyped && element === month) &&
              !(await typeTrusted(command, element, typed, () => valid(command), new AbortController().signal)))
            throw new Error("Site did not retain the value.");
        } finally {
          cs.writing = false;
          // Its keys may move focus to the next part (see guardedRecord).
          cs.lastEngineWrite = performance.now();
        }
        typedDate = true;
      } else if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        if (element.getAttribute("role") === "combobox" && !calendarBox(element))
          throw new Error("Custom autocomplete requires review.");
        Object.getOwnPropertyDescriptor(
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(element, proposal.value);
      } else throw new Error("Custom control requires manual selection.");
      if (typedDate) {
        // Its keys were the site's own events: only the record follows.
        record.writePendingAt = performance.now();
        record.last = valueOf(record.element);
        record.revision++;
        record.automationWritten = true;
      } else changed(record);
      // Left as when typed into: Amazon's text questions keep their answer
      // only on blur, and showed it while Continue still called it required.
      if (
        !typedDate && (
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement && !["checkbox", "radio"].includes(element.type)))
      ) {
        element.dispatchEvent(new FocusEvent("blur"));
        element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
      }
      await awaitSiteSave(savesBefore);
      const accepted =
        element instanceof HTMLSelectElement
          ? normalize(element.selectedOptions[0]?.label || "") ===
            normalize(selectedLabel)
          : element instanceof HTMLInputElement && element.type === "checkbox"
            ? element.checked === (proposal.value === "Yes")
            : element.getAttribute("role") === "checkbox"
              ? (element.getAttribute("aria-checked") === "true") === (proposal.value === "Yes")
            : valueOf(element) === proposal.value;
      if (accepted) record.fillWarning = undefined;
      results.push({
        id: proposal.fieldId,
        ok: accepted,
        reason: accepted ? undefined : "Site did not retain the value.",
      });
    } catch (error) {
      // Skipped for the rest of this fill only; the next request retries.
      // A field refused only for focus is tried again: the focus may be
      // this fill's own, or the applicant's may have moved on.
      if (!/has focus outside this selection\.?$/.test((error as Error).message)) {
        record.failedOperation = cs.operation;
        record.failedValue = proposal.value;
      }
      record.fillWarning = (error as Error).message.slice(0, 350);
      results.push({
        id: proposal.fieldId,
        ok: false,
        reason: (error as Error).message,
      });
    } finally {
      cs.writing = false;
    }
  }
  // Boxes a site's own list redraws: Greenhouse's put "U.S. citizen" back
  // when the next box of its list was ticked, after it had been unticked
  //. Each box this batch set is read again once
  // the page has redrawn, and set again where it drifted; one still wrong
  // is reported, never left as done.
  const drifted = () => [...boxesSet.values()].some((box) => box.element.isConnected && box.element.checked !== box.wanted);
  if (boxesSet.size) await pause(400);
  for (let round = 0; round < 2 && drifted(); round++) {
    for (const box of boxesSet.values()) {
      if (!box.element.isConnected || box.element.checked === box.wanted || !valid(command)) continue;
      const record = nodeRecords.get(box.element);
      cs.writing = true;
      try {
        await clickBox(box.element, box.wanted, command);
        if (record) {
          record.last = valueOf(box.element);
          record.revision++;
          record.automationWritten = true;
        }
      } finally {
        cs.writing = false;
      }
    }
    await pause(400);
  }
  for (const box of boxesSet.values())
    if (box.element.isConnected && box.element.checked !== box.wanted) {
      const result = results.find((entry) => entry.id === box.fieldId);
      if (result) Object.assign(result, { ok: false, reason: "The site set this box back after it was changed. Check it." });
    }
  // A phone number the site still calls invalid, its country code already
  // right and so never written, is checked again once the batch is done
  // (an Oracle form: "Enter a valid number." under a good number).
  if (results.some((entry) => entry.ok) && valid(command)) recheckInvalidPhones();
  return { results, observation: inspect() };
}

function recheckInvalidPhones() {
  for (const phone of document.querySelectorAll<HTMLInputElement>('input[type="tel"][aria-invalid="true"]')) {
    if (!phone.value.trim()) continue;
    phone.dispatchEvent(new Event("input", { bubbles: true }));
    phone.dispatchEvent(new Event("change", { bubbles: true }));
    phone.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    phone.dispatchEvent(new FocusEvent("blur"));
  }
}

// A phone number already on the page is checked against the country code
// only when it is edited: Oracle kept "Enter a valid number." under a number
// it had checked before the code was +1, once the fill had chosen +1. After
// a code is chosen, the number beside it is checked again.
function recheckPhoneBeside(element: Element, label: string | undefined) {
  if (!/\b(country|dial|calling)( phone)? code\b|\bphone (prefix|country)\b/i.test(`${label || ""} ${element.getAttribute("aria-label") || ""} ${element.id}`.replace(/-/g, " "))) return;
  let box: Element | null = element.parentElement;
  for (let level = 0; box && level < 6; level++, box = box.parentElement) {
    const phone = [...box.querySelectorAll<HTMLInputElement>('input[type="tel"]')].find((input) => input !== element && input.value.trim());
    if (!phone) continue;
    phone.dispatchEvent(new Event("input", { bubbles: true }));
    phone.dispatchEvent(new Event("change", { bubbles: true }));
    phone.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    phone.dispatchEvent(new FocusEvent("blur"));
    return;
  }
}
