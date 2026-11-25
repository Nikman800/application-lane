// A command the service worker sends a frame (content/commands.ts): a fill by the site's rules (the config engine).
// Split out of executeCommand as it was.
import { cs } from "../state";
import { inspect } from "../inspect";
import { pause, pickerBox, RecordEntry, requestTrustedType, Command } from "../core";
import { fillClick } from "../../../engine/page/click-gate";
import { configPassTimeout } from "../../../shared/timing";
import { valid } from "../guards";
import { controlsWithin, trackLocalControls, hasEditLock, valueOf, markEngineWrite, lockReason, expectOwnedActivation } from "../controls";
import { radioGroup, tell, menuEntries, entryPoint } from "../../content-dom";
import { nodeRecords, fieldLabel, documentId, userAttention, attentionSpan, awaitSiteSave, records } from "../tracking";
import { writable, type Control } from "../../semantics";
import { siteInvalid } from "../../../engine/page/invalid";
import { typeTrusted, reactSelectInput, reactSelect, listedPosition, checkControl } from "../choose";
import { signatureField, signingAllowed } from "../../../engine/page/signatures";
import { fillDocument } from "../../../engine/runtime";
import { fetchSiteOptions } from "../../../engine/config/options-source";
import { clicksAround } from "../../../engine/config/interpreter";
import { pickMonth } from "../../../engine/page/month-picker";
import { requestMainWorld } from "../../../engine/page/bridge";

  export async function handleConfigFill(command: Command): Promise<unknown> {
if (!command.profile?.confirmed)
  throw new Error("A confirmed profile is required.");
const pass = `${cs.operation}:${command.profile.revision}:${command.fieldId || ""}:${(command.onlyKeys || []).join(",")}`;
if (cs.configPass === pass) return { statuses: cs.configCautions, observation: inspect() };
cs.configPass = pass;
cs.configCautions = [];
// A SuccessFactors application folds its sections (Profile Information,
// Previous Employment, Education, Job-Specific Information) behind
// their title bars, and nothing inside a folded one is on the page:
// one employer's form was read as one Language field and nothing was filled
//. Each is opened, as the applicant would
// open it, before the pass reads the form.
// Sections drawn once those above them open (Fabrikam's Language Skills
// and Geographic Mobility) come folded after the first
// round: the applicant had to open them. Rounds go on until none is
// left folded, four at most.
for (let round = 0, waitedLate = false; round < 4 && !cs.paused; round++) {
  let folded = [...document.querySelectorAll<HTMLButtonElement>('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]')];
  // After opening some, a moment for those drawn late.
  if (!folded.length && round > 0 && !waitedLate) {
    waitedLate = true;
    await pause(1000);
    folded = [...document.querySelectorAll<HTMLButtonElement>('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]')];
  }
  if (!folded.length) break;
  cs.writing = true;
  try {
    for (const bar of folded) if (bar.isConnected && bar.getAttribute("aria-expanded") === "false") fillClick(bar);
  } finally {
    cs.writing = false;
  }
  for (let waited = 0; waited < 2_000 && folded.some((bar) => bar.isConnected && bar.getAttribute("aria-expanded") === "false"); waited += 100)
    await pause(100);
  await pause(300);
}
inspect();
// A pass that threw or ran out of time is not the step's answer: the next
// time this fill asks (the page changed, a later frame), it runs once more,
// rather than returning what it left. Once: a site slow enough to time out
// twice is left to the general fill.
const retryOnce = () => {
  if (cs.configRetried === pass) return;
  cs.configRetried = pass;
  cs.configPass = "";
};
const signal = AbortSignal.any([
  cs.configController.signal,
  // Long forms (iCIMS rows searched one dropdown at a time) need it.
  // Workday's My Experience searches its field of study and each
  // skill in turn, about 20 s for a search that finds nothing: at 60 s
  // the pass ended before Skills. SuccessFactors
  // waits out each of a place's wordings its list lacks, 5 s apiece:
  // with three jobs and two schools the pass ended a minute in, with
  // "Master" typed into Highest Degree Achieved and never picked.
  // (configPassTimeout: SmartRecruiters' real-key picks too.)
  AbortSignal.timeout(configPassTimeout(location.hostname, Boolean(document.querySelector("form.tpt_wizard")))),
]);
const locked = (element: Element) => {
  if (!valid(command)) return true;
  if (
    element.ownerDocument !== document ||
    !element.isConnected
  )
    return true;
  const candidates = controlsWithin(element);
  if (
    candidates.some((candidate) =>
      radioGroup(candidate).some(
        (member) => !nodeRecords.has(member as HTMLElement),
      ),
    )
  )
    trackLocalControls(candidates);
  if (!valid(command)) return true;
  const nodes = new Set(
    candidates.flatMap((candidate) => {
      const group = radioGroup(candidate);
      const writableMembers = group.filter(writable);
      return group.length > 1 && writableMembers.length
        ? [candidate, ...writableMembers]
        : group;
    }),
  );
  return [...nodes].some((node) => {
    const record = nodeRecords.get(node as HTMLElement);
    return (
      Boolean(
        record &&
        (record.protected || hasEditLock(record.element, record.label)),
      ) ||
      (node as HTMLInputElement).disabled ||
      // A read-only box with its own picker button is filled from that
      // picker, as Tesla's start date is: the site
      // writes it, never this.
      // Nor is TikTok's UD select box, read-only until its list is
      // opened: it is chosen from.
      ((node as HTMLInputElement).readOnly && !pickerBox(node) &&
        !(node as Element).matches?.("input.ud__select__selector__search__input")) ||
      node.getAttribute("aria-disabled") === "true" ||
      node.getAttribute("aria-readonly") === "true"
    );
  });
};
const reconcileAutomation = (...elements: (Element | undefined)[]) => {
  const touched = new Set<RecordEntry>();
  for (const element of elements) {
    if (!element) continue;
    for (const control of controlsWithin(element))
      for (const member of radioGroup(control)) {
        const record = nodeRecords.get(member as HTMLElement);
        if (record) touched.add(record);
      }
  }
  for (const record of touched) {
    if (record.protected || !record.element.isConnected) continue;
    const value = valueOf(record.element);
    if (value !== record.last) {
      record.last = value;
      record.revision++;
      record.automationWritten = true;
    }
  }
};
// Widgets that keep their own state ignore assigned values and synthetic
// keys alike; Workday's date sections are the reason this path exists.
// CDP types into whatever the page has focused, so focus must be ours and
// the page must not have the applicant's attention (see userAttention).
const trustedType = (element: Element, text: string, safe: () => boolean, signal: AbortSignal, retry = true, enter = false, choose = false) =>
  typeTrusted(command, element, text, safe, signal, retry, enter, choose);
// A signing date has one right answer: today. One the site or an earlier
// fill left behind (a reloaded page keeps it) is retyped, Month first;
// a date the applicant entered or locked is left alone.
const now = new Date();
const today = [
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
  String(now.getFullYear()),
];
for (const wrapper of document.querySelectorAll(
  '[data-automation-id="formField-todaysDate"],[data-automation-id="formField-dateSignedOn"],[data-automation-id="formField-currentDate"]',
)) {
  const sections = ["Month", "Day", "Year"].map((name) =>
    wrapper.querySelector<HTMLInputElement>(`input[role="spinbutton"][aria-label="${name}"]`),
  );
  if (sections.some((section) => !section)) continue;
  // Only where the applicant lets a fill sign (signatures.ts).
  const signs = signatureField(sections[0]!);
  if (!signs || !signingAllowed(command.profile?.signatures, signs)) continue;
  const values = sections.map((section) => section!.value);
  if (values.every((value) => !value)) continue;
  if (values.every((value, i) => Number(value) === Number(today[i]))) continue;
  const records = sections.map((section) => nodeRecords.get(section!));
  if (
    records.some(
      (record) =>
        !record ||
        hasEditLock(record.element, record.label) ||
        (record.protected && record.protectedBy !== "existing value"),
    )
  )
    continue;
  for (const [i, section] of sections.entries()) {
    const record = records[i]!;
    record.protected = false;
    record.protectedBy = undefined;
    cs.writing = true;
    try {
      await trustedType(section!, today[i], () => valid(command) && !locked(section!), signal);
    } finally {
      cs.writing = false;
    }
    reconcileAutomation(section!);
  }
}
const result = await fillDocument(command.profile, {
  signal,
  onlyKeys: command.onlyKeys,
  // Without documents yet, an upload step would only open its dialog.
  skipKeys: command.uploads ? undefined : ["resume", "coverLetter"],
  onField: (element, key) => {
    // A rule may name a wrapper; the question is its one control's.
    const control = element.matches("input,textarea,select,button,[role]")
      ? element
      : element.querySelector('input:not([type="hidden"]),textarea,select,button[aria-haspopup="listbox"],[role="combobox"]');
    const label = control ? fieldLabel(control as Control) : "";
    tell({ type: "FILL_PROGRESS", applicationId: cs.applicationId, operation: cs.operation, documentId, label: label && label !== "Unlabelled field" ? label : key.replace(/_/g, " ") });
    cs.stopRecording?.note({ config: key, label: label.slice(0, 80) });
  },
  isLocked: locked,
  note: (data) => cs.stopRecording?.note(data),
  isReplaceable: (element) => {
    // A value that changed since the page was last read is read now:
    // the site may have answered the write just made (see above).
    const record = nodeRecords.get(element as HTMLElement);
    if (record && record.last !== valueOf(record.element)) inspect();
    // A value the site itself calls invalid is no answer to keep:
    // Microsoft's form showed an address assigned earlier that its own
    // state never took, flagged it, and it was never typed again.
    if (siteInvalid(element) && !hasEditLock(element as Control, record?.label || "")) return true;
    return Boolean(nodeRecords.get(element as HTMLElement)?.siteValue);
  },
  onConfirmed: (element) => {
    const record = nodeRecords.get(element as HTMLElement);
    if (record) record.confirmed = true;
  },
  // The site's own list of answers, read from this page's origin.
  listOptions: (source, terms) => fetchSiteOptions(source, location.href, terms, signal),
  async reactSelect(element, choose, searches) {
    const input = reactSelectInput(element);
    if (!input) return "unsupported";
    const safe = () =>
      valid(command) && !locked(input) && !locked(element);
    if (!safe()) return "skipped";
    // An existing selection is the user's or the site's; keep it,
    // unless the site parsed it from a resume.
    if (
      valueOf(input as Control) &&
      !nodeRecords.get(input as HTMLElement)?.siteValue
    )
      return "skipped";
    markEngineWrite(input, element);
    cs.writing = true;
    try {
      return await reactSelect(input, choose, searches, safe, signal);
    } finally {
      cs.writing = false;
      reconcileAutomation(input, element);
    }
  },
  async execute({ action, element, guardElement, method, values, entrySave }) {
    cs.stopRecording?.note({ config: method, id: element.id || undefined, text: (element.textContent || "").trim().slice(0, 40) || undefined, values: values.slice(0, 3).map((value) => value.slice(0, 40)) });
    // A guard the step itself removed ("Remove Resume" before the
    // upload slot it reveals) guards nothing (see runAction).
    const guardGone = () =>
      Boolean(guardElement && guardElement !== element && !guardElement.isConnected && element.isConnected);
    // A click on the page around the field: see clicksAround.
    const around = clicksAround(element, guardElement, method, action?.event);
    const safe = () =>
      valid(command) &&
      (around ? element.isConnected : !locked(element)) &&
      (!guardElement || guardGone() || !locked(guardElement));
    if (!safe()) {
      // Why a write was refused, for the recording: a refusal otherwise
      // leaves only the write note, as a school's "Did You Graduate?" did on
      // an iCIMS form.
      const record = nodeRecords.get(element as HTMLElement);
      cs.stopRecording?.note({ refused: element.id || method, reason: !valid(command) ? "stale command" : record?.protected ? `protected: ${record.protectedBy || ""}` : record && hasEditLock(record.element, record.label) ? lockReason(record.element, record.label) : "locked" });
      return false;
    }
    expectOwnedActivation(element, method, action?.event);
    markEngineWrite(element, guardElement);
    const savesBefore = cs.savesFinished;
    cs.writing = true;
    try {
      // A month picked from its calendar, in this page's own DOM.
      if (method === "pickMonth") {
        const picked = element instanceof HTMLInputElement && (await pickMonth(element, values[0] ?? ""));
        reconcileAutomation(element, guardElement);
        return picked;
      }
      if (method === "trustedType" || method === "trustedSearch" || method === "trustedChoose") {
        const typed = await trustedType(
          element,
          values[0] ?? "",
          safe,
          signal,
          true,
          method === "trustedSearch",
          // Oracle's lists (cx-select) load results only while the box
          // keeps focus and close when it blurs: typed for a pick, not
          // committed (Higher's School).
          method === "trustedChoose" || element.matches("input.cx-select-input"),
        );
        // Oracle's searched lists (Major) fetch their matches from the
        // server, one to four seconds after the typing. The box has to keep
        // its focus until they are drawn: it was left 0.5 s after the typing,
        // before any list came, and the site then cleared what was typed.
        // Waited for here, ended by the options or by a "no results" state.
        if (typed && method === "trustedType" && element.matches("input.cx-select-input")) {
          const optionSelector = '[role="option"],[role="gridcell"].cx-select__list-item,[role="row"] .cx-select__list-item,.cx-select__list-item';
          const drawn = () => {
            const root = element.ownerDocument;
            if ([...root.querySelectorAll(optionSelector)].some((entry) => entry.getClientRects().length > 0)) return true;
            return [...root.querySelectorAll('[class*="cx-select"]')].some((box) =>
              box.children.length === 0 && /\b(no (matching |matches|results|items)|nothing found)/i.test(box.textContent || ""));
          };
          const waitDrawn = async () => {
            for (let waited = 0; !drawn() && waited < 6_000 && safe() && !userAttention() && !signal.aborted; waited += 100) {
              // The box lost its focus before any list came: Oracle's
              // Degree box, picked just before, takes the focus back
              // ~0.4 s after it is left, and the site clears the Major
              // typed meanwhile. Not waited out: typed again below.
              if (element.ownerDocument.activeElement !== element) return false;
              await pause(100);
            }
            return true;
          };
          if (!drawn() && !(await waitDrawn()) && safe() && !userAttention() && !signal.aborted) {
            // Nothing listed, or the focus was taken. Oracle loads a new
            // entry's Major list only once the box is opened (a click):
            // typing into it before finds nothing and no search is sent.
            // Opened, its list waited for, then typed again.
            await pause(1_500);
            if (!drawn()) {
              (element as HTMLInputElement).value = "";
              (element as HTMLElement).click();
              for (let waited = 0; !drawn() && waited < 8_000 && safe() && !userAttention() && !signal.aborted; waited += 100) await pause(100);
            }
            if (safe() && !userAttention() && !signal.aborted && (await trustedType(element, values[0] ?? "", safe, signal, true, false, true)))
              await waitDrawn();
          }
        }
        // The entry the menu lists for it: the site's own one where it
        // has it (SmartRecruiters' "Michigan State University" under its
        // "fill manually" one), else Down and Enter on the first, the
        // text as typed.
        if (typed && method === "trustedChoose") {
          // The site's own entry where it lists one, else the first
          // (the text as typed): Down to it, then Enter.
          const position = await listedPosition(element, values, signal);
          // A moment of the applicant's on the page (a click to watch
          // it) is waited out, as before typing: a pick skipped for it
          // left the typed city unchosen, and the box dropped it
          // (one employer's SmartRecruiters City).
          for (let waited = 0; safe() && userAttention() && !cs.applicantControl?.isConnected && waited < attentionSpan + 500 && !signal.aborted; waited += 150)
            await pause(150);
          // A box the site holds for a moment while it loads its
          // suggestions reads as locked: one employer's City was typed, then
          // refused "locked before the pick" 380 ms later and dropped
          //. Two seconds are waited out;
          // an edit lock of the applicant's stays one after them.
          for (let waited = 0; !safe() && valid(command) && !userAttention() && waited < 2000 && !signal.aborted; waited += 100)
            await pause(100);
          // Why nothing was picked, for the recording: that City's
          // trace showed only the typing and the Escape after it.
          if (!safe() || userAttention())
            cs.stopRecording?.note({ refused: element.id || method, reason: !valid(command) ? "stale command" : userAttention() ? "the applicant's attention" : `locked before the pick (${(() => {
                // Which hold it was: Tailspin's City was refused here with
                // none of them showing on the box afterwards.
                const record = nodeRecords.get(element as HTMLElement);
                const input = element as HTMLInputElement;
                return [
                  record?.protected ? "protected" : "",
                  record && hasEditLock(record.element, record.label) ? "edit lock" : "",
                  input.disabled ? "disabled" : "",
                  input.readOnly ? "readonly" : "",
                  element.getAttribute("aria-disabled") === "true" ? "aria-disabled" : "",
                  element.getAttribute("aria-readonly") === "true" ? "aria-readonly" : "",
                  !element.isConnected ? "detached" : "",
                ].filter(Boolean).join(", ") || "another control of the component";
              })()})` });
          if (safe() && !userAttention()) {
            // Down moves focus into the menu, so the Enter lands on its
            // entry, not the box: the whole component is the write's,
            // or that Enter was held back as a stray key and nothing
            // was chosen (SmartRecruiters' Office location).
            let component: Element = element;
            for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++) {
              component = host;
              if (host.matches("spl-autocomplete,[role='combobox']")) break;
            }
            cs.trustedWrite = component;
            try {
              // One Down at a time until focus is on the wanted entry,
              // then Enter there. A Down the menu let pass left focus in
              // the box, and the Enter after it cleared what was typed:
              // every Title, Company and School of a fill went empty
              //. No Enter reaches the box.
              const allowed = () => safe() && !userAttention();
              const guard = { applicationId: cs.applicationId, operation: cs.operation, documentId };
              const target = (position || 1) - 1;
              // The entry a key reached: focused, or lit by the menu
              // (its "active" mark; focus inside nested shadow roots
              // did not read as the entry's on the site). Only after a
              // key: the entry lit as the menu opens has no focus, and
              // an Enter then lands in the box.
              const reached = () => menuEntries(element).findIndex((entry) =>
                (entry.getRootNode() as Document | ShadowRoot).activeElement === entry || entry.classList.contains("active") ||
                entry.matches(":focus-within"));
              let moved = false;
              for (let tries = 0; tries < target + 4 && !(moved && reached() === target) && allowed(); tries++) {
                // A menu that let one Down pass lets them all: the click
                // below, at once, rather than seconds of keys.
                if (moved && reached() < 0) break;
                await requestTrustedType(element, guard, "", 0, signal, allowed, false, moved && reached() > target ? -1 : 1, true);
                moved = true;
                await pause(150);
              }
              if (moved && reached() === target && allowed())
                await requestTrustedType(element, guard, "", 0, signal, allowed, true, 0);
              // Every Down let pass (one employer's Company):
              // a real click on the entry, as the applicant would.
              else if (allowed() && window === window.top) {
                const entry = menuEntries(element)[target];
                if (entry) {
                  entry.scrollIntoView({ block: "nearest" });
                  await pause(100);
                  // The click lands on whatever is drawn at that point:
                  // a menu opened above its box sat under the page's
                  // sticky job header, and the click went to the header,
                  // not the school (one employer's SmartRecruiters
                  // Institution). Covered, the box is brought
                  // to the middle of the window so its menu has room,
                  // and a menu still covered is not clicked at all.
                  let point = entryPoint(entry);
                  if (!point && allowed()) {
                    (element as HTMLElement).scrollIntoView({ block: "center" });
                    await pause(300);
                    point = entryPoint(entry);
                  }
                  // A cover that passes is waited out while the menu
                  // still lists the entry: the toast the site shows on
                  // saving the entry before ("Experience saved") lay over
                  // the Institution's menu for three seconds, the pick
                  // was refused, and the school's Save failed for it
                  // (one employer's SmartRecruiters form).
                  for (let waited = 0; !point && waited < 6_000 && entry.isConnected && allowed() && !signal.aborted; waited += 250) {
                    await pause(250);
                    point = entryPoint(entry);
                  }
                  // A click that found another box at its point was
                  // kept from the page (see ownClickAt), and is made
                  // again once the entry is drawn there.
                  let clicked = false;
                  for (let attempt = 0; point && attempt < 3; attempt++) {
                    // Where entryPoint takes a hit as the entry's: in it, or in the
                    // option component drawing it.
                    const click = (cs.ownClickAt = { ...point, target: (entry.getRootNode() as ShadowRoot).host || entry, until: Infinity, missed: false });
                    clicked = true;
                    try {
                      await requestTrustedType(element, guard, "", 0, signal, allowed, false, 0, false, point);
                    } finally {
                      click.until = performance.now() + 400;
                    }
                    await pause(150);
                    if (!click.missed || !entry.isConnected || !allowed()) break;
                    cs.stopRecording?.note({ refused: element.id || method, reason: "the click on its menu entry reached another control; tried again" });
                    point = undefined;
                    for (let waited = 0; !point && waited < 3_000 && entry.isConnected && allowed() && !signal.aborted; waited += 250) {
                      await pause(250);
                      point = entryPoint(entry);
                    }
                  }
                  if (!clicked) {
                    // What lies over it, for the next capture (Tailspin's City).
                    const box = entry.getBoundingClientRect();
                    const over = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
                    const named = over ? `${over.tagName.toLowerCase()}${over.id ? `#${over.id}` : ""}${typeof over.className === "string" && over.className ? `.${over.className.split(/\s+/)[0]}` : ""}` : "nothing";
                    cs.stopRecording?.note({ refused: element.id || method, reason: `its menu entry is covered by ${named} (entry at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}, window ${innerWidth}x${innerHeight})` });
                  }
                }
              }
            } catch (error) {
              /* Left as typed: the check after says so. */
              cs.stopRecording?.note({ refused: element.id || method, reason: `pick: ${(error as Error)?.message || error}`.slice(0, 200) });
            } finally {
              cs.trustedWrite = undefined;
            }
            cs.searchSettle = { element, until: performance.now() + 4000 };
          }
          reconcileAutomation(element, guardElement);
          return true;
        }
        reconcileAutomation(element, guardElement);
        if (typed) return true;
        // Real keystrokes were refused (this tab has the user's
        // attention, or the debugger is unavailable). Assigning the
        // value is what the engine did before; some widgets accept it.
        // A Workday date section does not: given "11" as a value it kept
        // no Month and set its Year to 2011 (one employer's signing date). It is left for a fill that can type.
        if (element.matches('input[role="spinbutton"][data-automation-id^="dateSection"],input[role="spinbutton"][id*="dateSection"]')) return false;
      }
      // Saving one entry of the section being filled (see entrySave in
      // the interpreter). Its button can be a submit button of the whole
      // application form, so it is clicked only with every submission
      // stopped before any page code sees it: the page's click handler
      // saves the entry, and no form is submitted.
      if (entrySave && element instanceof HTMLButtonElement && ["click", "reactClick"].includes(method)) {
        const block = (event: Event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        window.addEventListener("submit", block, true);
        try {
          expectOwnedActivation(element, "click");
          fillClick(element);
        } finally {
          window.removeEventListener("submit", block, true);
        }
        await awaitSiteSave(savesBefore);
        return true;
      }
      // A configured option box is clicked, never assigned: see
      // checkControl.
      if (
        ["checkOption", "default", "defaultWithoutBlur"].includes(method) &&
        element instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(element.type)
      ) {
        // As the page-world writer reads a value for a box (Oracle's
        // "Current Job" gets "Yes").
        const wanted =
          method === "checkOption" ||
          element.type === "radio" ||
          !["", "false", "no", "0"].includes((values[0] ?? "").toLowerCase());
        const checked = (await checkControl(element, wanted)) && element.checked === wanted;
        reconcileAutomation(element, guardElement);
        await awaitSiteSave(savesBefore);
        return checked;
      }
      // An upload step gets the document this pass was given, or fails.
      const file =
        method === "uploadResume"
          ? command.uploads?.resume
          : method === "uploadCoverLetter"
            ? command.uploads?.cover
            : method === "uploadFile"
              ? command.artifact
              : undefined;
      if (/^upload(Resume|CoverLetter|File)$/.test(method) && !file) return false;
      // Clearing a search box that kept focus ends in a blur of our own:
      // the browser then fires a real change and focusout, which are
      // not the applicant's edit (Workday's How Did You Hear About Us?).
      if (method === "clearValue" && element === (element.getRootNode() as Document | ShadowRoot).activeElement)
        cs.searchSettle = { element, until: performance.now() + 1500 };
      const result = await requestMainWorld(
        element,
        { applicationId: cs.applicationId, operation: cs.operation, documentId },
        {
          ...(file ? { file } : {}),
          method: method === "trustedType" ? "default" : method === "trustedSearch" || method === "trustedChoose" ? "keyType" : method,
          values,
          event: action?.event,
          eventOptions: action?.eventOptions,
        },
        signal,
        safe,
      );
      // Without real keys a search box still gets its Enter, synthetic:
      // most Workday tenants search on it.
      // Without real keys, its menu's first entry chosen with synthetic
      // Down and Enter once the menu has had time to come.
      if (method === "trustedChoose" && result.ok) {
        await pause(1_500);
        for (const key of [{ key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 }, { key: "Enter", code: "Enter", keyCode: 13, which: 13 }])
          await requestMainWorld(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, { method: "event", values, event: "keydown", eventOptions: key }, signal, safe);
      }
      if (method === "trustedSearch" && result.ok)
        await requestMainWorld(
          element,
          { applicationId: cs.applicationId, operation: cs.operation, documentId },
          {
            method: "event",
            values,
            event: "keydown",
            eventOptions: { key: "Enter", code: "Enter", keyCode: 13, which: 13 },
          },
          signal,
          safe,
        );
      reconcileAutomation(element, guardElement);
      // Written with the profile's answer, even one equal to what the
      // site parsed (no change to see): checked, not the site's guess
      // (one employer's "Did You Graduate?").
      const written = nodeRecords.get(element as HTMLElement);
      if (written && result.ok) written.confirmed = true;
      await awaitSiteSave(savesBefore);
      return result.ok;
    } finally {
      cs.writing = false;
      cs.lastEngineWrite = performance.now();
    }
  },
}, command.fieldId ? records.get(command.fieldId)?.element : undefined).then((result) => {
  cs.configCautions = (result.statuses as { key: string; status: string; caution?: string }[]).flatMap((status) =>
    status.status === "filled" && status.caution ? [{ key: status.key, status: "filled" as const, caution: status.caution }] : []);
  // Out of time (not stopped by the applicant): tried again, once.
  if (signal.aborted && !cs.paused) retryOnce();
  return result;
}).catch((error) => {
  retryOnce();
  if (!valid(command)) throw error;
  return {
    statuses: [
      {
        key: "config",
        status: "failed",
        reason: (error as Error).message,
      },
    ],
  };
});
return { ...result, observation: inspect() };
}
