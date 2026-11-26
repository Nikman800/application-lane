import { type Field } from "../shared/model";
import { siteInvalid } from "../engine/page/invalid";
import { tdsDateBox } from "../engine/page/tds-date-picker";
import { wordLimit } from "../shared/questions";
import { askedLevel } from "../shared/transcripts";
import { cleanLabel, labelText } from "../engine/page/labels";
// Read by the engine as well, so they live there; named here as before.
export { cleanLabel, labelText };

export function fieldWordLimit(element: Element, label: string): number | undefined {
  const texts = [label];
  const root = element.getRootNode() as Document | ShadowRoot;
  for (const id of (element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean))
    texts.push(root.querySelector(`#${CSS.escape(id)}`)?.textContent || "");
  for (const attr of ["data-max-words", "data-word-limit"]) {
    const value = Number(element.getAttribute(attr));
    if (value > 0 && Number.isInteger(value) && value <= 10000) texts.push(`maximum ${value} words`);
  }
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
    if (parent.querySelectorAll('input:not([type="hidden"]),textarea,select').length !== 1) break;
    texts.push(labelText(parent));
  }
  return wordLimit(texts.join(" "));
}

// A Google place picker (<gmpx-place-picker>): its visible box lives in the
// component's open shadow root and is named by a label before the component
// whose "for" points at a hidden input (the answer's stored field).
export const placePickerBox = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement && element.classList.contains("pac-target-input") &&
  (element.getRootNode() as ShadowRoot).host?.localName === "gmpx-place-picker";
function placePickerLabel(element: HTMLInputElement): string {
  const host = (element.getRootNode() as ShadowRoot).host;
  const scope = host?.parentElement;
  if (!host || !scope) return "";
  for (const label of scope.querySelectorAll<HTMLLabelElement>("label[for]")) {
    if (!(label.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const target = (host.getRootNode() as Document | ShadowRoot).getElementById(label.htmlFor);
    if (target instanceof HTMLInputElement && target.type === "hidden") return label.textContent || "";
  }
  return "";
}

export type Control =
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
const controlSelector =
  'input:not([type="hidden"]), textarea, select, button[aria-haspopup="listbox"], button.fab-SelectToggle[data-menu-id], [role="checkbox"], [role="radio"], [role="combobox"]';


export function questionLabel(element: Element): string {
  const question = element.closest(".application-question");
  if (question) return labelText(question.querySelector(".application-label"));
  // Breezy heads each of the employer's questions with an <h3> and binds no
  // label, so its inputs read as their names ("section_…_question_0").
  const breezy = element.closest("li.question");
  return labelText(breezy?.querySelector("h3") || null);
}

// A choice drawn as two or more toggle buttons side by side (Ashby's yes/no
// questions): the pressed button is the answer. A lone toggle (an editor's
// Bold button) is not a form choice.
export function toggleGroup(element: Element): HTMLElement[] {
  if (!element.matches("button[aria-pressed]") || !element.parentElement) return [];
  const group = [
    ...element.parentElement.querySelectorAll<HTMLElement>(":scope > button[aria-pressed]"),
  ];
  return group.length >= 2 ? group : [];
}
export const isToggleChoice = (element: Element) => toggleGroup(element).length > 0;

// The question a toggle group answers: the nearest label or legend around
// the group, never one of the buttons' own texts.
function toggleQuestion(element: Element): Element | null {
  const group = element.parentElement!;
  const labelled = group.getAttribute("aria-labelledby");
  if (labelled) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const node = root.querySelector(`#${CSS.escape(labelled.split(/\s+/)[0])}`);
    if (node) return node;
  }
  let node: Element | null = group.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const label = [...node.querySelectorAll("label, legend")].find((l) => !group.contains(l));
    if (label && labelText(label)) return label;
  }
  return null;
}

// The question a group of same-named radios or checkboxes answers when the
// page marks it up as plain text above them (Paylocity's screener questions:
// a paragraph, then one row per option). It is whatever precedes the first
// option inside the smallest block holding the whole group; the text as
// written is returned too, since "(required)" is often part of it.
export function groupQuestion(element: Element): { text: string; raw: string } | undefined {
  // An ARIA checkbox icon in the label of a native checkbox (Jobvite's) is
  // that checkbox: the question is the one its group asks.
  if (element.getAttribute("role") === "checkbox") element = iconRadioLabel(element)?.control || element;
  if (!(element instanceof HTMLInputElement) || !/^(radio|checkbox)$/.test(element.type) || !element.name) return;
  const root = element.form || (element.getRootNode() as Document | ShadowRoot);
  const members = [...root.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(element.name)}"]`)].filter((input) => input.type === element.type);
  if (members.length < 2) return;
  let block: Element | null = element.parentElement;
  for (let depth = 0; block && depth < 5 && !members.every((member) => block!.contains(member)); depth++) block = block.parentElement;
  if (!block || !members.every((member) => block!.contains(member))) return;
  // Another group's controls in the same block mean it is a whole form
  // section, not one question. A box to write one's own answer in, under
  // the group's name or an unnamed box beside it ("Custom" and its text
  // field, Lever's pronouns), is part of the group.
  const ownControl = (control: Element) =>
    members.includes(control as HTMLInputElement) ||
    (control as HTMLInputElement).type === "hidden" ||
    (control as HTMLInputElement).name === element.name ||
    (control instanceof HTMLInputElement && control.type === element.type && !control.name);
  const lone = (candidate: Element) => [...candidate.querySelectorAll("input,textarea,select")].every(ownControl);
  if (!lone(block)) return;
  const textBefore = (holder: Element) => {
    const before: string[] = [];
    const raw: string[] = [];
    for (const child of holder.children) {
      if (members.some((member) => child.contains(member))) break;
      raw.push(child.textContent || "");
      before.push(labelText(child));
    }
    return { text: cleanLabel(before.filter(Boolean).join(" ")), raw: raw.join(" ") };
  };
  let found = textBefore(block);
  // The question can sit a level or two further out, beside the list that
  // holds the options (Lever's "Pronouns": a label, then a field holding
  // the list).
  for (let climb = 0; !found.text && climb < 2 && block.parentElement && lone(block.parentElement); climb++) {
    block = block.parentElement;
    found = textBefore(block);
  }
  return found.text ? found : undefined;
}

// Ashby names each box of a checkbox question after its own option
// ("Veteran", "Master's"); the question is the title of the entry they sit
// in. Without it a box reads as a question of its own.
export function checkboxEntryTitle(element: Element): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") return "";
  // An Oracle Cloud Recruiting checkbox question ("Select the races you
  // identify with."): a row whose label names it, its boxes unnamed.
  const row = element.closest(".input-row");
  const rowLabel = row?.querySelector(":scope > form-element-label label .input-row__linebreak, :scope > label .input-row__linebreak");
  if (row && rowLabel && row.querySelectorAll('input[type="checkbox"]').length > 1) return cleanLabel(labelText(rowLabel));
  const entry = element.closest('.ashby-application-form-field-entry,fieldset[class*="_fieldEntry_"]');
  const title = entry?.querySelector(":scope > .ashby-application-form-question-title, :scope > legend");
  return entry && title && entry.querySelectorAll('input[type="checkbox"]').length > 1 ? cleanLabel(labelText(title)) : "";
}

// JazzHR names each box of a checkbox question on its own
// (resumator-checkbox-<question>-<n>) and binds the question's <label> to the
// hidden input that collects the ticked boxes, which no label can name.
export function hiddenAnswerQuestion(element: Element): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") return "";
  let block = element.parentElement;
  for (let depth = 0; block && depth < 3; depth++, block = block.parentElement) {
    // A label with an empty "for" names nothing: searching for it built
    // 'input[type="hidden"]#', which the browser rejects, and the whole
    // fill stopped with no field filled.
    const label = [...block.querySelectorAll<HTMLLabelElement>(":scope > label[for]")].find((candidate) =>
      Boolean(candidate.htmlFor) && block!.querySelector(`input[type="hidden"]#${CSS.escape(candidate.htmlFor)}`),
    );
    if (!label) continue;
    const controls = [...block.querySelectorAll<HTMLInputElement>("input,select,textarea")].filter((control) => control.type !== "hidden");
    return controls.length > 1 && controls.every((control) => control.type === "checkbox") ? cleanLabel(labelText(label)) : "";
  }
  return "";
}

// an employer names every radio of a group with the question itself and leaves
// each one's label empty; the option is the text drawn beside the radio.
function sameNamedRadios(element: Element): HTMLInputElement[] {
  if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return [];
  const root = element.form || (element.getRootNode() as Document | ShadowRoot);
  return [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(element.name)}"]`)];
}
export function sharedRadioQuestion(element: Element): string {
  const members = sameNamedRadios(element);
  const asked = cleanLabel(element.getAttribute("aria-label") || "");
  return asked && members.length > 1 && members.every((member) => cleanLabel(member.getAttribute("aria-label") || "") === asked) ? asked : "";
}
function radioOptionBeside(element: Element): string {
  const members = sameNamedRadios(element);
  let block: Element = element;
  for (let depth = 0; depth < 5; depth++) {
    const parent = block.parentElement;
    if (!parent || members.some((member) => member !== element && parent.contains(member))) break;
    block = parent;
  }
  return block === element ? "" : cleanLabel(labelText(block));
}

// iCIMS's EEO forms draw a radio inside a span of its own, its option as
// bare text after it up to a line break, and the question as the text
// before the first of them ("…please indicate by checking the appropriate
// box below", one employer's veteran question).
function bareWrapper(element: Element): Element {
  const parent = element.parentElement;
  return parent && parent.tagName === "SPAN" && parent.childElementCount === 1 && !(parent.textContent || "").trim() ? parent : element;
}
function textAfterRadio(element: Element): string {
  let text = "";
  for (let node = bareWrapper(element).nextSibling; node; node = node.nextSibling) {
    if (node instanceof HTMLBRElement) { if (text.trim()) break; continue; }
    if (node instanceof Element && node.querySelector("input,select,textarea")) break;
    text += node.textContent || "";
    if (text.length > 300) break;
  }
  return cleanLabel(text);
}
function textBeforeRadios(element: Element): string {
  const members = sameNamedRadios(element);
  const first = members[0] && bareWrapper(members[0]);
  if (!first || members.length < 2 || members.some((member) => member.labels?.length)) return "";
  const parts: string[] = [];
  for (let node = first.previousSibling; node; node = node.previousSibling) {
    if (node instanceof Element && node.querySelector("input,select,textarea")) break;
    const text = (node.textContent || "").trim();
    if (text) parts.unshift(text);
    if (parts.join(" ").length > 400) break;
  }
  // The last sentences: the ask comes just before the boxes.
  const text = cleanLabel(parts.join(" "));
  return text.length > 300 ? cleanLabel(text.slice(-300).replace(/^\S*\s/, "")) : text;
}

// A skill-proficiency gauge (Apple's "Provide your proficiency level for the
// skills on your profile"): a radiogroup labelled "<Skill> Skill Proficiency
// Levels" of five empty buttons named only by aria-label ("<Skill> 3-Proficient").
// The question is the skill's; each option is its level's own words.
export function proficiencyGauge(element: Element): { skill: string; option: string } | undefined {
  if (element.getAttribute("role") !== "radio") return undefined;
  const skill = element.closest('[role="radiogroup"]')?.getAttribute("aria-label")?.match(/^(.+?)\s+Skill Proficiency Levels?$/i)?.[1]?.trim();
  if (!skill) return undefined;
  const named = (element.getAttribute("aria-label") || "").trim();
  const option = named.startsWith(`${skill} `) ? named.slice(skill.length + 1).trim() : "";
  return /^[1-5]\b/.test(option) ? { skill, option } : undefined;
}

export function fieldLabel(element: Control): string {
  const gauge = proficiencyGauge(element);
  if (gauge) return gauge.skill;
  if (isToggleChoice(element))
    return cleanLabel(labelText(toggleQuestion(element)) || element.parentElement!.getAttribute("aria-label") || "") || "Unlabelled field";
  if (
    (element instanceof HTMLInputElement && element.type === "radio") ||
    element.getAttribute("role") === "radio"
  ) {
    // Or the group a component draws around it in its own shadow root
    // (SmartRecruiters' spl-radio-group).
    const group = element.closest('fieldset,[role="radiogroup"]') ||
      element.parentElement?.shadowRoot?.querySelector('fieldset[role="radiogroup"],[role="radiogroup"]') || null;
    const root = (group || element).getRootNode() as Document | ShadowRoot;
    const labelled = (group?.getAttribute("aria-labelledby") || "").split(/\s+/)
      .filter(Boolean).map((id) => labelText(root.querySelector(`#${CSS.escape(id)}`))).filter(Boolean).join(" ");
    // Ashby titles a fieldset with a <label> (not a <legend>) whose "for"
    // names no element; option labels are the ones bound to a radio. Of
    // several, the radio's own: the one whose "for" begins its id (Tesla's
    // "<id>" question over "<id>_yes" and "<id>_no"), else the nearest before
    // it. Tesla puts every question in one fieldset, and each was read as the
    // first.
    const titles = [...(group?.querySelectorAll("label") || [])].filter(
      (label) => !label.control && !label.querySelector("input"),
    );
    const title =
      titles.find((label) => label.htmlFor && element.id.startsWith(`${label.htmlFor}_`)) ||
      titles.filter((label) => label.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ||
      titles[0];
    const name = element instanceof HTMLInputElement ? element.name : "";
    // A fieldset that holds several questions is titled for the section
    // ("3. Questions"), not for this one: a radio's own title (its "for" begins
    // its id) names the question there (Pinpoint's Yes/No cards).
    const sectionFieldset = group?.matches("fieldset") &&
      new Set([...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => radio.name || radio.id)).size > 1;
    const ownTitle = sectionFieldset
      ? titles.find((label) => label.htmlFor && element.id.startsWith(`${label.htmlFor}_`))
      : undefined;
    return (
      cleanLabel(
        wfnRadioQuestion(element) ||
        labelText(ownTitle || null) ||
        labelText(group?.querySelector("legend") || null) ||
          group?.getAttribute("aria-label") ||
          labelled ||
          sharedRadioQuestion(element) ||
          labelText(title || null) ||
          ripplingQuestion(element) ||
          questionLabel(element) ||
          groupQuestion(element)?.text ||
          textBeforeRadios(element) ||
          // Generated names (Ashby's form and field UUIDs) are not labels.
          (/[a-f0-9]{8}-[a-f0-9-]{20,}|cards\[/i.test(name) ? "" : name) ||
          ownLabel(element),
      ) || "Unlabelled field"
    );
  }
  // One option of a checkbox question reads as nothing on its own ("C#",
  // "I am comfortable with both"): it carries its question.
  const asked = element instanceof HTMLInputElement && element.type === "checkbox" ? groupQuestion(element)?.text : undefined;
  const own = ownLabel(element);
  const root = element.getRootNode() as Document | ShadowRoot;
  const description = (element.getAttribute("aria-describedby") || "").split(/\s+/)
    .filter(Boolean).map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent || "").join(" ");
  if (/^Address$/i.test(own) && /\binclude your city, region, and country\b/i.test(description))
    return "Address (city, region, country)";
  if (asked && own) return cleanLabel(`${asked}: ${own}`);
  // A lone box named only by its answer ("Yes") whose question is the
  // group's, named by aria-labelledby: Microsoft's three acknowledgments
  // each read "Yes", and as one label repeated all three were left alone.
  if (element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type) && /^(yes|no|i agree|agree|i accept|accept|i acknowledge|acknowledge)$/i.test(own.trim())) {
    for (let box = element.parentElement, depth = 0; box && depth < 4; box = box.parentElement, depth++) {
      const ids = (box.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      if (!ids.length || box === element) continue;
      const question = cleanLabel(ids.map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent || "").join(" "));
      if (question && question.toLowerCase() !== own.trim().toLowerCase()) return cleanLabel(`${question}: ${own}`);
    }
  }
  // A Workday date's Month, Day and Year are named only so: the question is
  // its field's legend ("What is your first available start date?", an employer).
  if (/^(month|day|year)$/i.test(own) && element.matches('[data-automation-id^="dateSection"]')) {
    const legend = labelText(element.closest('[data-automation-id^="formField-"]')?.querySelector("legend") || null);
    if (legend) return cleanLabel(`${legend}: ${own}`);
  }
  // Apple's Start Date and End Date are fieldsets of a Month list and a Year
  // list named only so; the legend is the question.
  if (/^(month|year)$/i.test(own) && element instanceof HTMLSelectElement) {
    const dates = element.closest("fieldset");
    const legend = cleanLabel(dates?.querySelector(":scope > legend")?.textContent || "");
    if (/^(start|end) date$/i.test(legend) && dates?.parentElement?.closest("fieldset")?.querySelector(":scope > legend.a11y"))
      return `${legend} ${own}`;
  }
  // iCIMS draws a date as Month, Day and Year boxes, and a salary as Currency,
  // Amount and Rate, under one line of text in the cell around them ("Date
  // Available to Start", "Desired Salary"): each box read only as its part
  // ("Month", "Amount (Numbers only)"), so no question was answered
  // (Wingtip).
  const icimsGroup = element.closest(".iCIMS_Forms_DateOnlyField,.iCIMS_Forms_SalaryField");
  if (icimsGroup && /^(month|day|year|amount\b.*)$/i.test(own)) {
    const question = textBeforeGroup(icimsGroup);
    if (question) return cleanLabel(`${question}: ${own}`);
  }
  // iCIMS' phone pair (".country-phone-group"): the number's box is named
  // only "Number", and the country list's anchor by its aria-label, which
  // carries the placeholder ("Country Code — Make a Selection —"). Each
  // takes the group's phone wording.
  const phoneGroup = element.closest(".country-phone-group");
  if (phoneGroup) {
    if (/^number$/i.test(own.trim()) && element.closest(".phone-number")) return "Phone number";
    if (element.matches("a.dropdown-select")) {
      const shown = labelText(phoneGroup.querySelector(".country-code > label"));
      if (/country code/i.test(shown)) return cleanLabel(shown);
    }
  }
  if (promptOnly.test(own)) {
    const question = questionAbove(element);
    if (question) return cleanLabel(question);
  }
  return own || "Unlabelled field";
}

// The text just before a group of boxes in the same table cell: siblings
// back from the group, then from the span or paragraph holding it. Another
// control in the way ends the search.
function textBeforeGroup(group: Element): string {
  for (let node: Element | null = group, depth = 0; node && depth < 3 && !/^(TD|TH|TR|TABLE|FORM)$/.test(node.tagName); node = node.parentElement, depth++) {
    for (let before = node.previousSibling, steps = 0; before && steps < 6; before = before.previousSibling, steps++) {
      if (before instanceof Element && before.querySelector(controlSelector)) return "";
      const text = (before.textContent || "").replace(/\s+/g, " ").trim().replace(/\s*\*$/, "");
      if (text) return text.slice(0, 200);
    }
  }
  return "";
}

// A label that only says to pick ("Make Selection Here") carries no question:
// one employer's SuccessFactors asks "Are you one of the following? U.S.
// Citizen or National…" in a note above the list.
const promptOnly = /^\W*(please )?(make (a )?selection( here)?|select( one| an option)?( here)?|choose( one| an option)?( here)?)\W*$/i;
function questionAbove(element: Element): string {
  for (let node: Element | null = element, depth = 0; node && depth < 8; node = node.parentElement, depth++)
    for (let before = node.previousElementSibling, steps = 0; before && steps < 4; before = before.previousElementSibling, steps++) {
      // Another field between them asks something else.
      if (before.querySelector("input:not([type=hidden]),select,textarea,[role=combobox]")) return "";
      // Its pieces spaced apart: the list's items ran together ("following?U.S.").
      const pieces: string[] = [];
      const walker = before.ownerDocument.createTreeWalker(before, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) pieces.push(walker.currentNode.textContent || "");
      const text = pieces.join(" ").replace(/\s+/g, " ").trim();
      if (text.includes("?") && text.length <= 1500) return text.replace(/^\d+\.\s*/, "");
    }
  return "";
}

// Keep legacy locks effective when improved detection replaces opaque names.
export function legacyLabels(element: Control): string[] {
  // A radio's own label is its option ("Yes"), which names no question: a
  // lock under ":0:yes" from one answer held every Yes/No question of the
  // step (Tesla).
  const option = element.matches('input[type="radio"],[role="radio"]');
  const labels =
    !option && "labels" in element && element.labels
      ? [...(element.labels as NodeListOf<HTMLLabelElement>)]
          .map((label) => {
            const copy = label.cloneNode(true) as Element;
            copy
              .querySelectorAll(
                'input,textarea,select,button,[role="checkbox"],[role="radio"],[role="combobox"],[role="button"]',
              )
              .forEach((e) => e.remove());
            return copy.textContent || "";
          })
          .join(" ")
      : "";
  return [
    labels,
    option ? "" : element.getAttribute("aria-label") || "",
    element.getAttribute("placeholder") || "",
    element.getAttribute("name") || "",
    element.id,
  ].filter(Boolean);
}

// ADP Workforce Now's dropdown (<wfn-dropdown-list>) draws an sdf-select-simple
// in its shadow root, whose own root holds the button that opens the list
// (div.trigger-button, role="button"). The button is the control; the host
// carries the question (label-text, required).
export function wfnDropdown(element: Element): Element | undefined {
  if (!element.matches('.trigger-button[role="button"][aria-expanded]')) return undefined;
  let host = (element.getRootNode() as ShadowRoot).host as Element | undefined;
  for (let depth = 0; host && depth < 3; depth++) {
    if (host.localName === "wfn-dropdown-list") return host;
    // ADP's recruitment questions draw a bare sdf-select-simple (the salary's
    // "Select currency type") in their own additional-info block.
    if (depth === 0 && host.localName === "sdf-select-simple" && host.closest('[class*="additional-info"]')) return host;
    host = (host.getRootNode() as ShadowRoot).host as Element | undefined;
  }
  return undefined;
}

// ADP's recruitment questions draw each Yes and No of one question as a
// <wfn-radio-button> holding an sdf-radio-button in its shadow root. The
// option is the host's own text; the question is the label of the block
// around them ("Did any of our employees inform you about this position?").
export function wfnRadioHost(element: Element): Element | undefined {
  const root = element.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : undefined;
  return host?.localName === "wfn-radio-button" ? host : undefined;
}
function wfnRadioQuestion(element: Element): string {
  const host = wfnRadioHost(element);
  const block = host?.closest(".additional-question,.qMainDiv");
  return block ? cleanLabel(labelText(block.querySelector(".qLabel"))) : "";
}

// A text box that takes digits alone: ADP's desired salary ("Invalid salary
// range. Accepts up to 7 digits."), or any box whose description or alert
// says it takes only digits (Avature's "Enter numerals only").
export function digitsOnlyBox(element: HTMLInputElement): boolean {
  if (element.type !== "text") return false;
  if (element.matches("input.additional-info-salary-textBox")) return true;
  const root = element.getRootNode() as Document | ShadowRoot;
  const told = (element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)
    .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent || "").join(" ");
  return /\b(digits only|only digits|(numbers?|numerals?) only|accepts (up to )?\d+ digits)\b/i.test(told);
}

// The text ids name in a root: ADP repeats an id (a title-only span before
// the label), so the first one with text counts.
function textOfIds(root: ParentNode, ids: string[]): string {
  return ids.map((id) => {
    for (const node of root.querySelectorAll(`[id="${CSS.escape(id)}"]`)) {
      const text = labelText(node);
      if (text) return text;
    }
    return "";
  }).filter(Boolean).join(" ");
}

function associatedLabel(element: Control): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const dropdown = wfnDropdown(element);
  if (dropdown) {
    const hostRoot = dropdown.getRootNode() as Document | ShadowRoot;
    return cleanLabel(
      dropdown.getAttribute("label-text") || dropdown.getAttribute("aria-label") ||
      textOfIds(hostRoot, (dropdown.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)),
    );
  }
  // ADP's phone input (rrui PhoneInput) is named only "Phone Number"; the
  // group around it is labelled "Home Phone Number" or "Mobile Number".
  if (element instanceof HTMLInputElement && element.type === "tel") {
    const group = element.closest('[role="group"][aria-labelledby]');
    const named = group ? textOfIds(root, group.getAttribute("aria-labelledby")!.split(/\s+/).filter(Boolean)) : "";
    if (/^(home|mobile|cell|cellular|work|office|primary|other|alternate|secondary)\b.*\b(phone|number|telephone)\b/i.test(named)) return named;
  }
  // BambooHR's fabric select: its label is for the hidden select drawn
  // beside the toggle, and the toggle's own name is "State –Select–".
  if (element.matches("button.fab-SelectToggle[data-menu-id]")) {
    const hidden = element.closest(".fab-Select")?.querySelector("select[id]");
    const named = hidden?.id ? labelText(root.querySelector(`label[for="${CSS.escape(hidden.id)}"]`)) : "";
    if (named) return named;
  }
  if (element.matches('button[aria-haspopup="listbox"]')) {
    const workdayField = element.closest(
      '[data-automation-id^="formField-"]',
    );
    const workdayLabel =
      workdayField?.querySelector(
        element.id ? `label[for="${CSS.escape(element.id)}"]` : "label",
      ) || workdayField?.querySelector("legend, label");
    const stable = labelText(workdayLabel || null);
    if (stable) return stable;
  }
  // A radio's name is its option alone: PageUp also lists the group's
  // question in each option's aria-labelledby.
  const question = element.matches('input[type="radio"],[role="radio"]')
    ? element.closest("fieldset")?.querySelector("legend")
    : null;
  const group = element.matches('input[type="radio"],[role="radio"]') ? element.closest('fieldset,[role="radiogroup"]') : null;
  const questionIds = new Set((group?.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean));
  const labelled = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((id) => !questionIds.has(id))
    .map((id) => root.querySelector(`#${CSS.escape(id)}`))
    .filter((node) => node !== question)
    .map(labelText)
    .filter(Boolean)
    .join(" ");
  const labels =
    "labels" in element && element.labels
      ? [...(element.labels as NodeListOf<HTMLLabelElement>)]
          .map(labelText)
          .filter(Boolean)
          .join(" ")
      : "";
  // A web component's own label attribute names it (SmartRecruiters'
  // <spl-radio label="Yes">).
  const component = element.localName.includes("-") ? element.getAttribute("label") || "" : "";
  // A radio read through an aria-labelledby that adds its question to the
  // option ("Are you eligible? yes") is the option its own label says ("Yes").
  if (labels && labelled && element.matches('input[type="radio"],[role="radio"]') && labelled.length > labels.length &&
      labelled.toLowerCase().endsWith(labels.toLowerCase()))
    return cleanLabel(labels);
  return cleanLabel(labelled || element.getAttribute("aria-label") || labels || component);
}

export type DocumentKind = "resume" | "cover" | "transcript";
// What an uploader asks for, when its words name exactly one document.
export const documentKind = (text: string): DocumentKind | undefined => {
  const named = (
    [
      ["cover", /cover[\s_-]*letter/i],
      ["resume", /resume|curriculum|\bcv\b/i],
      ["transcript", /transcript/i],
    ] as const
  ).filter(([, pattern]) => pattern.test(text));
  return named.length === 1 ? named[0][0] : undefined;
};

// An uploader that imports the applicant's profile from a resume and
// rewrites the form with it (Oracle's "Import your profile from resume"), as
// opposed to the application's own resume slot. It is never filled: the
// profile fills the form directly, and it would share the slot's "Resume".
export function profileImport(element: Control): boolean {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") return false;
  const text = [
    element.name,
    element.id,
    element.className,
    element.getAttribute("aria-label"),
    associatedLabel(element),
  ].join(" ");
  if (/\bimport\b.{0,30}\bprofile\b|\bprofile[\s_-]*import/i.test(text)) return true;
  // A site widget that matches jobs to a resume (Oracle's recommended-jobs
  // box on its job pages): the site uploads, parses and leaves the
  // application for its job search. Never part of an application.
  return /recommended[\s_-]*jobs|jobs?[\s_-]*(?:match|recommend)/i.test(text) ||
    Boolean(element.closest('[class*="recommended-jobs"],[class*="job-recommend"],[class*="jobs-recommend"]'));
}

export function fileKind(element: Control): DocumentKind | undefined {
  return fileQuestion(element)?.kind;
}

// What a file field is for, and the words that say so ("Please provide a
// recent transcript of your undergraduate studies"): the degree a transcript
// field asks for is read from them (shared/transcripts.ts).
export function fileQuestion(element: Control): { kind: DocumentKind; text: string } | undefined {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") return;
  const named = (text: string) => {
    const kind = documentKind(text);
    return kind ? { kind, text } : undefined;
  };
  const direct = named(
    [
      element.name,
      element.id,
      element.getAttribute("data-automation-id"),
      associatedLabel(element),
    ].join(" "),
  );
  if (direct) return direct;
  // BambooHR's upload names itself only "file-input": its heading is the
  // paragraph just before the upload ("Resume*"), and the hidden input that
  // keeps the uploaded file's id beside it is named for it ("resumeFileId").
  const fabric = element.closest('[data-fabric-component="FileUpload"]');
  if (fabric) {
    const before = fabric.previousElementSibling;
    const heading = before?.matches('[data-fabric-component="BodyText"]') ? labelText(before) : "";
    const hiddenNames = [...(fabric.parentElement?.querySelectorAll<HTMLInputElement>('input[type="hidden"][name]') || [])]
      .map((input) => input.name.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const found = named(heading) || named(hiddenNames.join(" "));
    if (found) return found;
  }
  // Bounded, single-file containers only. Never infer one file's purpose from
  // a neighboring uploader or the document title.
  let parent = element.parentElement;
  for (
    let depth = 0;
    parent && depth < 7;
    depth++, parent = parent.parentElement
  ) {
    if (
      parent.matches("body,html") ||
      parent.querySelectorAll('input[type="file"]').length !== 1
    )
      break;
    const labels = [
      ...parent.querySelectorAll(
        'label,legend,h2,h3,h4,[role="heading"],.application-label,[data-automation-id="file-upload-drop-zone"]',
      ),
    ];
    // Some uploaders (Workday) label the area only through the section's
    // identity: id="Resume/CV-section", data-fkit-id="resumeAttachments--…".
    const section = parent;
    const identity = [
      section.id,
      section.getAttribute("data-automation-id"),
      section.getAttribute("data-fkit-id"),
      ...(section.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => (id ? section.ownerDocument.getElementById(id) : null))
        .map((label) => (label ? labelText(label) : "")),
    ].join(" ");
    const found = named([labels.map(labelText).join(" "), identity].join(" "));
    if (found) return found;
  }
  // SmartRecruiters asks for the document in an info block of its own just
  // before a plain "Additional attachments" uploader, its words in that
  // block's shadow root: "Please submit a school transcript (official or
  // unofficial)…".
  const host = (node: Node) => ((node.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
  let question: Element | undefined = element;
  for (let depth = 0; question && depth < 16 && !question.matches('[data-test="question-container"]'); depth++)
    question = question.parentElement || host(question);
  const previous = question?.matches('[data-test="question-container"]') ? question.previousElementSibling : null;
  if (previous?.matches('[data-test="question-container"]') && previous.querySelector("sr-question-field-info") && !previous.querySelector("input,select,textarea")) {
    const deepText = (root: Element | ShadowRoot): string =>
      [root.textContent || "", ...[...root.querySelectorAll("*")].flatMap((child) => (child.shadowRoot ? [deepText(child.shadowRoot)] : []))].join(" ");
    const asked = named(deepText(previous).replace(/\s+/g, " ").trim().slice(0, 600));
    if (asked) return asked;
  }
  // Oracle's block names what goes in its one uploader, nine levels up, in
  // its title and instructions: "Additional Documents. Add any additional
  // documents. E.g.: Cover Letter, Certificate, Reference letter.".
  const block = element.closest(".apply-flow-block");
  if (block && block.querySelectorAll('input[type="file"]').length === 1)
    return named(
      [...block.querySelectorAll(".apply-flow-block__title,.apply-flow-block__instructions")].map(labelText).join(" "),
    );
  // ADP's Attachments area has no label: its words offer "documents, such as
  // a cover letter, work samples, transcripts, and certifications", which name
  // several kinds, and the first example is the one it takes. Only the
  // uploader's own words (its single-input scope, never a section that holds
  // another uploader), and only when the cover letter is the first example.
  const words = (uploaderScope(element).textContent || "").replace(/\s+/g, " ").trim();
  if (words.length < 600 && /\b(?:add|attach|upload)\b[^.]{0,40}\bdocuments?,?\s+(?:such as|like|including|e\.?g\.?:?)\s+(?:an?\s+)?cover[\s_-]*letters?\b/i.test(words))
    return { kind: "cover", text: words };
}

// The single-uploader container of a file input, up to a few levels out.
function uploaderScope(element: HTMLInputElement) {
  let scope: Element = element;
  for (
    let parent = element.parentElement, depth = 0;
    parent && depth < 9 && !parent.matches("body,html,form");
    parent = parent.parentElement, depth++
  ) {
    if (parent.querySelectorAll('input[type="file"]').length !== 1) break;
    scope = parent;
  }
  return scope;
}

// Sites that keep an uploaded document server-side show its name beside an
// empty file input (iCIMS "current file"). That is an existing document.
export function currentFileName(element: Control): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    return "";
  // SmartRecruiters' spl-dropzone clears its input once a file is taken and
  // lists the upload in its own files attribute (JSON): a finished resume
  // read as missing (one employer's SmartRecruiters form).
  const dropzone = (element.getRootNode() as ShadowRoot).host;
  if (dropzone?.localName === "spl-dropzone") {
    try {
      const files: unknown = JSON.parse(dropzone.getAttribute("files") || "[]");
      const names = Array.isArray(files)
        ? files.map((file) => String((file as { fileName?: unknown; name?: unknown })?.fileName || (file as { name?: unknown })?.name || "").trim()).filter(Boolean)
        : [];
      if (names.length) return names.join(", ").slice(0, 300);
    } catch {
      /* Not a list: read as the page draws it, below. */
    }
  }
  // Only the uploader's own few levels: once a site swaps another uploader's
  // input for a filename chip, a wider single-input scope reaches that chip.
  let scope: Element = element;
  for (
    let parent = element.parentElement, depth = 0;
    parent && depth < 4 && !parent.matches("body,html,form");
    parent = parent.parentElement, depth++
  ) {
    if (parent.querySelectorAll('input[type="file"]').length !== 1) break;
    scope = parent;
  }
  const purpose = fileKind(element);
  for (const candidate of scope.querySelectorAll<HTMLElement>(
    // Amazon's saved resume: "Download Name.pdf" beside its Replace input,
    // which Fill had used to upload the same resume again.
    '[class*="CurrentFile" i],[class*="current-file" i],[class*="uploaded-file" i],[id$="_FileNameLabel"],[class*="file-name" i],[class*="filename" i],.document-block-title',
  )) {
    if (/NoDisplay|hidden/i.test(candidate.className)) continue;
    // Earlier uploads offered to pick from ("Use"), as Oracle lists them,
    // are not this uploader's file.
    if (candidate.closest('attachment-preuploaded, [class*="preupload" i]')) continue;
    const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate);
    if (style && (style.display === "none" || style.visibility === "hidden"))
      continue;
    const name = (candidate.textContent || "").replace(/\s+/g, " ").trim().replace(/^download /i, "");
    // A resume's file name never stands in for a cover letter, or vice versa.
    const named = documentKind(name);
    if (purpose && named && named !== purpose) continue;
    if (/\.(pdf|docx?|rtf|txt|odt)\b/i.test(name)) return name.slice(0, 300);
  }
  return listedFileName(element, scope);
}

// Apple lists each uploaded file as a row of its own: a disabled "File" box
// holding the name, a Category select and a Remove button, the uploader
// staying empty. A row of this uploader's kind (by its Category, else its
// name) is the file already there; another kind's (a cover letter) is not.
// The list only grows: such a file is never replaced by an upload.
export function listedFileName(element: Control, scope?: Element): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") return "";
  const purpose = fileKind(element);
  scope ||= uploaderScope(element);
  for (const box of scope.querySelectorAll<HTMLInputElement>(
    'li input[type="text"][disabled],li input[type="text"][readonly]',
  )) {
    const name = box.value.replace(/\s+/g, " ").trim();
    if (!/\.(pdf|docx?|rtf|txt|odt)$/i.test(name)) continue;
    const row = box.closest("li");
    if (!row || row.querySelector('input[type="file"]')) continue;
    const chosen = row.querySelector("select")?.selectedOptions[0]?.textContent || "";
    const named = documentKind(chosen) || documentKind(name);
    if (purpose && named && named !== purpose) continue;
    return name.slice(0, 300);
  }
  return "";
}

// An error the site shows beside this uploader after an upload attempt.
export function uploadError(element: Control): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    return "";
  for (const candidate of uploaderScope(element).querySelectorAll<HTMLElement>(
    '[role="alert"],[class*="error" i],[class*="invalid" i]',
  )) {
    if (candidate.querySelector("input,button,select,textarea")) continue;
    const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate);
    if (style && (style.display === "none" || style.visibility === "hidden"))
      continue;
    const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
    // An alert can announce success or progress too: Workday's "Resume.pdf
    // successfully uploaded" and "Resume.pdf loading" read as failed uploads.
    if (/\bsuccess(ful(ly)?)?\b|\b(has been|was) uploaded\b|\bupload(ed)? complete\b|\b(loading|uploading|processing|scanning)\b/i.test(text) &&
        !/\b(fail\w*|error|invalid|too (large|big)|not (allowed|supported|accepted)|unsupported|could not|couldn t|unable)\b/i.test(text.replace(/[’']/g, " ")))
      continue;
    if (text && text.length < 300) return text;
  }
  return "";
}

// A resume uploader that parses the file and overwrites the form with it.
// An uploader that rewrites the form from the resume, beside an ordinary
// uploader for the same document (Ashby's "Autofill from resume" pane next
// to its Resume field). The ordinary field is the application's; the
// autofill pane is an optional shortcut and is left to the applicant.
// Paylocity opens an application under an "Apply with resume" dialog and
// also has an ordinary resume field in the form. While the dialog is showing
// its upload is the one the site wants first (it fills the form from it), so
// it is the resume field and the ordinary one waits; once the dialog is gone
// the ordinary field is the application's. The dialog keeps aria-hidden="true"
// even while shown, so its wrapper's display says whether it is up.
export function paylocityForcedResume(doc: Document): HTMLInputElement | undefined {
  if (!/(^|\.)paylocity\.com$/i.test(location.hostname)) return;
  const input = doc.querySelector<HTMLInputElement>('#forceUploadResumeModal input[type="file"]#btn-forceResume');
  const shell = input?.closest<HTMLElement>('[id$="citrus-modal-wrapper"]') || doc.getElementById("forceUploadResumeModal");
  if (!input || !shell) return;
  return getComputedStyle(shell).display !== "none" && shell.getClientRects().length > 0 ? input : undefined;
}

export function redundantAutofill(element: Control): boolean {
  if (element instanceof HTMLInputElement && /(^|\.)paylocity\.com$/i.test(location.hostname)) {
    const forced = paylocityForcedResume(element.ownerDocument);
    if (element.id === "btn-resume" && forced) return true;
    if (element.id === "btn-forceResume") return !forced && Boolean(element.ownerDocument.querySelector('input[type="file"][id="btn-resume"]'));
  }
  const kind = fileKind(element);
  if (!kind || !replacesForm(element)) return false;
  const root = element.getRootNode() as Document | ShadowRoot;
  return [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(
    (other) => other !== element && fileKind(other) === kind && !replacesForm(other),
  );
}

export function replacesForm(element: Control): boolean {
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    return false;
  if (element === paylocityForcedResume(element.ownerDocument)) return true;
  const scope = uploaderScope(element);
  // The nearest notice beside this uploader, never a whole page section.
  for (let node: Element | null = element; node; node = node.parentElement) {
    const text = node.textContent || "";
    if (text.length > 3000) return false;
    if (
      // (Paylocity's forced dialog: "Upload your resume and we'll
      // automatically fill out your application".)
      /pre-?fill|auto-?fill|automatically fill|fill (out|in) (your|the) application|populate|parse|existing data in the form will be replaced/i.test(
        text,
      )
    )
      return true;
    if (node === scope) return false;
  }
  return false;
}

// Rippling writes a custom question above its field, outside it; a dropdown's
// own name is only its placeholder ("Select"), and a radio group has none.
function ripplingQuestion(element: Element): string {
  const field = element.closest('[data-testid^="customQuestions."]')?.closest('[data-testid="field"]');
  if (!field || field.querySelector('[id$="-label"]:not([id^="label-customQuestions."])')) return "";
  const above = field.previousElementSibling;
  return above && !above.querySelector(controlSelector) ? labelText(above) : "";
}

// iCIMS draws a form's own box with the question as text in its table cell
// above it ("School/Institution Name") and names the box by its field id
// ("icims_0_SchoolName") or a short code in aria-label ("sync", "Graduate"):
// read so, no school box of an education block was known as one. Its date parts (Month/Day/Year) keep their own labels.
function icimsCellQuestion(element: Control): string {
  if (!/^icims_(?:\d+_|f_)/.test(element.id) || element.closest(".iCIMS_Table,.iCIMS_DateField-Month,.iCIMS_DateField-Day,.iCIMS_DateField-Year")) return "";
  if (!(element instanceof HTMLInputElement && /^(text|)$/.test(element.type)) && !(element instanceof HTMLSelectElement)) return "";
  const coded = (element.getAttribute("aria-label") || "").trim();
  if (!element.closest(".icims_group_loop") && !(element.getAttribute("data-label") && coded && !/\s/.test(coded))) return "";
  const cell = element.closest("td");
  if (!cell) return "";
  const range = element.ownerDocument.createRange();
  range.setStart(cell, 0);
  range.setEndBefore(element);
  const text = cleanLabel(range.toString().replace(/\s+/g, " ").trim());
  return text && text.length <= 120 ? text : "";
}

// An ARIA radio drawn as an icon inside the label of a native radio that the
// page keeps out of sight (Jobvite's <i role="radio"> in a label for its
// input): the label's text is the option, the native input holds the state.
export function iconRadioLabel(element: Element): HTMLLabelElement | undefined {
  const role = element.getAttribute("role");
  if (element instanceof HTMLInputElement || (role !== "radio" && role !== "checkbox")) return undefined;
  const label = element.closest("label");
  const control = label?.control;
  return label && control instanceof HTMLInputElement && control.type === role && !element.contains(control) ? label : undefined;
}

// ADP rewrites a field's label in its error state ("City" becomes "City is
// required") and names the suffix in the input's own validationmessage.
function withoutValidationMessage(element: Control, text: string): string {
  const message = (element.getAttribute("validationmessage") || "").trim();
  if (!message || text.length <= message.length || !text.toLowerCase().endsWith(message.toLowerCase())) return text;
  return text.slice(0, text.length - message.length).trim() || text;
}

export function ownLabel(element: Control): string {
  return withoutValidationMessage(element, ownLabelRaw(element));
}

function ownLabelRaw(element: Control): string {
  const gauge = proficiencyGauge(element);
  if (gauge) return gauge.option;
  const iconLabel = iconRadioLabel(element);
  if (iconLabel) return cleanLabel(iconLabel.textContent || "");
  // A toggle choice's option is its own text ("Yes", "No").
  if (isToggleChoice(element)) return cleanLabel(element.textContent || "");
  const wfnOption = wfnRadioHost(element);
  if (wfnOption && element.getAttribute("role") === "radio") return cleanLabel(wfnOption.textContent || "");
  const question = fileQuestion(element);
  const purpose = question?.kind;
  // A transcript for one degree says which: "Undergraduate transcript".
  if (purpose === "transcript") {
    const level = askedLevel(question!.text);
    return level ? `${level === "undergraduate" ? "Undergraduate" : "Graduate"} transcript` : "Transcript";
  }
  if (purpose) return { resume: "Resume", cover: "Cover letter", transcript: "Transcript" }[purpose];
  // An ARIA radio or checkbox drawn around a native input is named by that
  // input's label (Rippling), or by its own text.
  if (element.matches('[role="radio"],[role="checkbox"]') && !(element instanceof HTMLInputElement) && !associatedLabel(element)) {
    const native = element.querySelector('input[type="radio"],input[type="checkbox"]');
    const root = element.getRootNode() as Document | ShadowRoot;
    const named = (native?.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => labelText(root.querySelector(`#${CSS.escape(id)}`))).filter(Boolean).join(" ");
    if (named || (native && labelText(element))) return named || labelText(element);
    // A button drawn as a radio holds its option as its own text: Oracle's
    // cx-select-pills (<button role="radio"><span> Yes</span></button>) read
    // as empty options, and no Yes/No question was answered.
    if (!native && element instanceof HTMLButtonElement && element.getAttribute("role") === "radio") {
      const own = labelText(element);
      if (own) return own;
    }
  }
  if (sharedRadioQuestion(element)) {
    const option = radioOptionBeside(element);
    if (option) return option;
  }
  // (A radio's or checkbox's own label is its option, not the question.)
  if (!element.matches('[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]')) {
    const asked = ripplingQuestion(element);
    if (asked) return asked;
  }
  // An Ashby dropdown's title is the label just before its input container;
  // its "for" names no element (a custom question, or School in an
  // education row).
  if (element.matches("input.ashby-application-form-input-autocomplete")) {
    const title = element.parentElement?.previousElementSibling;
    if (title?.matches("label.ashby-application-form-question-title") && labelText(title)) return labelText(title);
  }
  // A react-select drawn under a plain <label> with no "for" (Pinpoint's
  // Country and State), its input's id only the field's name: the label just
  // before the component names it.
  if (element.matches('input[role="combobox"]') && !(element as HTMLInputElement).labels?.length) {
    const shell = element.closest(".react-select");
    const title = shell?.previousElementSibling;
    if (title?.matches("label") && !(title as HTMLLabelElement).htmlFor && labelText(title)) return labelText(title);
  }
  if (placePickerBox(element)) {
    const asked = cleanLabel(placePickerLabel(element));
    if (asked) return asked;
  }
  const cellAsked = icimsCellQuestion(element);
  if (cellAsked) return cellAsked;
  const explicit = associatedLabel(element);
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement && /^(radio|checkbox)$/.test(element.type)) {
    const after = textAfterRadio(element);
    if (after) return after;
  }
  // Lever's question first: its school picker is a Select2 whose visible
  // selection reads only its placeholder ("Select a university or college",
  // an employer), and the school was not matched.
  const lever = questionLabel(element);
  if (lever) return lever;
  // Select2's hidden select is named by its visible selection (Amazon's,
  // whose only name is the selection's aria-labelledby).
  const selection = select2Selection(element);
  const shown = selection && ownLabel(selection as unknown as Control);
  if (shown) return shown;
  // A nearby standalone label is useful only in a single-control field, not
  // across an entire form or a repeated row.
  const wrapper = element.closest(
    '.field-wrapper,.form-field,.field,.form-group,.iCIMS_FieldRow,.ashby-application-form-field-entry,fieldset[class*="_fieldEntry_"],[data-automation-id^="formField-"]',
  );
  if (wrapper && wrapper.querySelectorAll(controlSelector).length === 1) {
    const labels = [
      ...wrapper.querySelectorAll(
        'label,.field-label,[data-automation-id="formLabel"]',
      ),
    ];
    if (labels.length === 1 && labelText(labels[0]))
      return labelText(labels[0]);
    // A Workday questionnaire's text answer is titled only by its fieldset's
    // legend; read as its id, the draft took it for no question.
    const legend = wrapper.matches('[data-automation-id^="formField-"]') && !labels.length
      ? labelText(wrapper.querySelector("legend"))
      : "";
    if (legend) return legend;
  }
  // A label whose "for" names no element (one employer's Greenhouse form:
  // <label for="First Name">, its input with no id) belongs to the one
  // control beside it: the nearest block holding only that label and it.
  // (A dropdown's input sits several blocks below its label.)
  for (let block = element.parentElement, depth = 0; block && depth < 10; block = block.parentElement, depth++) {
    if (block.querySelectorAll(controlSelector).length > 1) break;
    const labels = [...block.querySelectorAll("label")].filter((label) => !label.control);
    if (labels.length > 1) break;
    if (labels.length === 1 && labelText(labels[0])) return labelText(labels[0]);
  }
  const fallback =
    element.getAttribute("placeholder") ||
    element.getAttribute("name") ||
    element.id;
  return /cards\[|[a-f0-9]{8}-[a-f0-9-]{20,}|^react-select-|^question_\d+$/i.test(
    fallback,
  )
    ? ""
    : cleanLabel(fallback);
}

// Meta's careers site marks the whole page's scroll container aria-hidden
// (id="scrollview", a full-width wrapper a few levels under <body>) while the
// form inside it is drawn and in use: read as hidden, all 25 of its fields
// were missed and Fill reported "No fields were detected". An aria-hidden element that is the page itself, drawn over the
// viewport, hides nothing from the applicant.
function pageShell(node: Element): boolean {
  const body = node.ownerDocument.body;
  let depth = 0;
  let parent = node.parentElement;
  for (; parent && parent !== body; parent = parent.parentElement) depth++;
  if (!parent || depth > 4 || node.closest("[hidden],[inert]")) return false;
  const view = node.ownerDocument.defaultView;
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return Boolean(view) && style.display !== "none" && style.visibility !== "hidden" &&
    box.width >= view!.innerWidth * 0.8 && box.height > 0 && box.right > 0 && box.left < view!.innerWidth;
}

function hiddenFromView(element: Element): boolean {
  for (let node = element.closest('[aria-hidden="true"]'); node; node = node.parentElement?.closest('[aria-hidden="true"]') ?? null)
    if (!pageShell(node)) return true;
  return false;
}

export function rendered(element: Element): boolean {
  if (element.closest("[hidden],[inert]") || hiddenFromView(element)) return false;
  const style = getComputedStyle(element);
  return (
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    element.getClientRects().length > 0
  );
}

// Select2 keeps the options and submitted value on an inaccessible native
// select. Its adjacent selection is the visible control, not another field.
export function select2Selection(element: Element): HTMLElement | undefined {
  if (!element.matches("select.select2-hidden-accessible")) return;
  const container = element.nextElementSibling;
  if (!container?.matches(".select2-container")) return;
  return container.querySelector<HTMLElement>(".select2-selection") || undefined;
}

// A honeypot: a box a person never sees, there to catch a bot that fills
// everything. Filling it can mark the application as spam. It is a typed
// box (a hidden checkbox, radio or file input is usually the real control
// behind a drawn one) that is moved off the page, named as a trap, or
// labelled to be left blank ("Leave this field blank", "If you are human,
// do not fill this in"); "Phone (leave blank if none)" asks to be filled.
const honeypotName = /honeypot|bot[-_]?field|_gotcha|(?:^|[-_])hp[-_]/i;
const honeypotLabel = /\bleave (?:this|it)(?: field| box)? (?:blank|empty)\b(?! if| unless)|\b(?:do not|don't|dont) (?:fill|complete|enter|type)\b.{0,20}\b(?:this|it|here|out)\b|\bif you are (?:a )?human\b|\bfor (?:bots|robots) only\b/i;
export function honeypot(element: Control): boolean {
  if (!(element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && /^(text|email|tel|url|number|search|)$/.test(element.type))))
    return false;
  if (element.getAttribute("role") === "combobox" || element.hasAttribute("aria-autocomplete")) return false;
  if ([element.getAttribute("name"), element.id, element.getAttribute("class")].some((value) => value && honeypotName.test(value))) return true;
  const root = element.getRootNode() as Document | ShadowRoot;
  const labels = [
    ...[...(element.labels || [])].map((label) => label.textContent || ""),
    element.getAttribute("aria-label") || "",
    element.getAttribute("placeholder") || "",
    ...(element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent || ""),
  ].join(" ");
  if (honeypotLabel.test(labels)) return true;
  // Wholly left of or above the page, where no one can scroll to it.
  const box = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  // The page can scroll in its body or an inner block (UKG Pro's long
  // application, window.scrollY 0): a box scrolled up past the top of that
  // scroller is above the viewport but reachable, so what the ancestors are
  // scrolled by counts as well. Only a box above the scroller's own origin
  // is out of reach. The scroller can sit in a component's shadow root with
  // the form slotted into it (UKG Pro's ukg-layout-container), so the walk
  // follows the rendered tree: slot, parent, shadow host.
  let scrolledX = view?.scrollX || 0;
  let scrolledY = view?.scrollY || 0;
  const up = (node: Element): Element | null =>
    node.assignedSlot || node.parentElement || ((node.parentNode as ShadowRoot | null)?.host ?? null);
  for (let parent = up(element); parent && parent !== element.ownerDocument.documentElement; parent = up(parent)) {
    scrolledX += parent.scrollLeft;
    scrolledY += parent.scrollTop;
  }
  return Boolean(view) && (box.right + scrolledX < 0 || box.bottom + scrolledY < 0);
}

export function controlVisible(element: Control): boolean {
  if (honeypot(element)) return false;
  if (rendered(element)) return true;
  // A gauge's buttons are drawn over the page's own bar and may have no box
  // of their own; the group they sit in is what shows.
  if (proficiencyGauge(element)) return rendered(element.closest('[role="radiogroup"]')!);
  if (element instanceof HTMLInputElement && element === paylocityForcedResume(element.ownerDocument)) return true;
  const selection = select2Selection(element);
  if (selection) return rendered(selection);
  if (
    !(element instanceof HTMLInputElement) ||
    element.type !== "file" ||
    element.closest("[hidden],[inert]")
  )
    return false;
  let parent = element.parentElement;
  for (let i = 0; parent && i < 7; i++, parent = parent.parentElement) {
    if (parent.matches("body,html")) break;
    if (rendered(parent) && (fileKind(element) || associatedLabel(element)))
      return true;
  }
  return false;
}

export function placeholderOption(option: HTMLOptionElement): boolean {
  if (option.value === "") return true;
  // A blank choice ("<option value='0'></option>") selects nothing.
  if (!option.label.trim() && !option.text.trim()) return true;
  // JazzHR's empty choice ("-- No answer --", an employer) has a value
  // of its own; the dashes set it apart from a choice that answers "none".
  if (/^\s*[-—–]+\s*no (?:answer|selection)\s*[-—–]+\s*$/i.test(option.label)) return true;
  // Without the dashes as a list's first choice (one employer's citizenship list,
  // "No answer" with a value of 0, read as answered and left so).
  if (/^\s*no (?:answer|selection)\s*$/i.test(option.label) && option.index === 0) return true;
  const label = option.label
    .replace(/[—–….-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(month|day|year)$/i.test(label) &&
    option.parentElement instanceof HTMLSelectElement &&
    /\b(start|end|date|birth|from|to)\b/i.test(ownLabel(option.parentElement))
  )
    return true;
  return /^(?:please )?(?:select(?: (?:an? |your )?[\w ]{1,35})?|choose(?: (?:an? |your )?[\w ]{1,35})?|make (?:a )?selection)$/i.test(
    label,
  );
}

export function writable(element: Control): boolean {
  // A read-only combobox naming its list is chosen from, not typed into:
  // Microsoft's careers form draws every list so, and its sponsorship
  // question was refused as "no longer writable".
  const chosenFrom = (element.getAttribute("role") === "combobox" && Boolean(element.getAttribute("aria-controls"))) ||
    // Or a date box set from its calendar (Tesla's).
    Boolean(tdsDateBox(element));
  return (
    controlVisible(element) &&
    !(element as HTMLInputElement).disabled &&
    // A radio or checkbox ignores readonly, and Microsoft's careers form
    // marks its Yes/No radios so: its three "Job specific questions" were
    // never seen.
    (!(element as HTMLInputElement).readOnly || chosenFrom || /^(radio|checkbox)$/.test((element as HTMLInputElement).type)) &&
    element.getAttribute("aria-disabled") !== "true" &&
    element.getAttribute("aria-readonly") !== "true"
  );
}

export function sectionFor(element: Control): {
  section: string;
  index: number;
} {
  // An entry form a site rule opened for one profile row (Oracle's) says
  // whose it is, so the page-wide fill maps its Degree, Major and School to
  // that row and not to row 0 (Higher: row 1's form held row 0's
  // school and major). The page's own section name stays where it has one
  // (SuccessFactors' "Work Experiences").
  const found = pageSectionFor(element);
  const ruled = element.closest("[data-lane-entry]")?.getAttribute("data-lane-entry")?.match(/^(education|experience):(\d+)$/);
  if (!ruled) return found;
  return { section: found.section || (ruled[1] === "education" ? "Education" : "Experience"), index: Number(ruled[2]) };
}

// The words a Jobvite prescreen field asks (its label, its legend, or the
// text of a plain paragraph), lowercased without the required star.
const jobviteAsked = (holder: Element | null | undefined) =>
  cleanLabel(holder?.querySelector("label.jv-form-field-label,legend,p")?.textContent || "").replace(/[*?]/g, "").trim().toLowerCase();

// Jobvite's prescreen repeats labels without a row to tell them apart. One
// table element holds each job as a group of fields that starts with a
// paragraph "Employer 1", "Employer 2" (the job of that number, in the
// profile's order). Separate elements ask a school's University, Degree,
// Years Attended and Graduated? one after another, then the same for a
// Graduate School: the first group is the undergraduate school and the second
// the graduate one, told apart by the level of each degree.
function jobvitePrescreenRow(holder: Element, element: Control): { section: string; index: number } | undefined {
  if (holder.classList.contains("jv-prescreen-element-table")) {
    const fields = [...holder.querySelectorAll(".jv-form-field")];
    const own = fields.indexOf(element.closest(".jv-form-field") as Element);
    for (let at = own - 1; at >= 0; at--) {
      const group = jobviteAsked(fields[at]).match(/^employer (\d{1,2})$/);
      if (group) return { section: "Work History", index: Number(group[1]) - 1 };
    }
    return;
  }
  const school = /^(university|college)$/;
  const graduate = /^graduate (school|university)$/;
  const asked = /^(university|college|degree|(number of )?years attended|graduated|graduate (school|university))$/;
  const elements = [...(holder.parentElement?.children || [])].filter((child) => child.classList.contains("jv-prescreen-element"));
  const labels = elements.map(jobviteAsked);
  const at = elements.indexOf(holder);
  if (!asked.test(labels[at] || "") || !labels.some((label) => graduate.test(label)) || !labels.some((label) => school.test(label))) return;
  for (let back = at; back >= 0; back--) {
    if (graduate.test(labels[back])) return { section: "Graduate Education", index: 0 };
    if (school.test(labels[back])) return { section: "Undergraduate Education", index: 0 };
  }
}

function pageSectionFor(element: Control): {
  section: string;
  index: number;
} {
  // Apple's parsed-résumé review: each job, school and language is a
  // <fieldset> whose hidden legend names it and its number ("Edit Employment
  // 3"); its Current Employer and Graduated radios and its Start and End Date
  // groups are fieldsets of their own inside it. Without the number every row
  // after the first was row 0 (the same job written into four rows), and
  // the inner groups were sections of their own, never a job's.
  for (let fieldset = element.closest("fieldset"); fieldset; fieldset = fieldset.parentElement?.closest("fieldset") || null) {
    const numbered = cleanLabel(fieldset.querySelector(":scope > legend.a11y")?.textContent || "").match(/^(Edit .*\S)\s+(\d{1,3})$/);
    if (numbered) return { section: numbered[1].slice(0, 500), index: Number(numbered[2]) - 1 };
  }
  // Its Additional Files & Links rows are list items of one group: a file's
  // Category and a link's are both "Category".
  const supportRow = element.closest('li[role="listitem"]');
  const supportGroup = supportRow?.closest('[role="group"][aria-label^="Edit "]');
  if (supportRow && supportGroup && supportRow.querySelector(".supportingfile-widget-section"))
    return {
      section: cleanLabel(supportGroup.getAttribute("aria-label") || "").slice(0, 500),
      index: Math.max(0, [...supportGroup.querySelectorAll('li[role="listitem"]')].indexOf(supportRow)),
    };
  // Jobvite's prescreen questions are elements of jv-form-field children.
  const jobvite = element.closest(".jv-prescreen-element");
  const jobviteRow = jobvite && jobvitePrescreenRow(jobvite, element);
  if (jobviteRow) return jobviteRow;
  // iCIMS's own education and work blocks: "icims_1_SchoolName" is the second
  // block, and the page's heading above the group ("EDUCATION (COMPLETED)")
  // is its section, which tells a finished degree's blocks from the "currently
  // enrolled" part.
  const loop = element.closest(".icims_group_loop[data-group-loop-name]");
  const loopRow = element.id.match(/^icims_(\d+)_/);
  if (loop && loopRow) {
    const name = (loop.getAttribute("data-group-loop-name") || "").toLowerCase();
    const heading = [...(element.getRootNode() as Document | ShadowRoot).querySelectorAll("strong,b,h1,h2,h3,h4")]
      .filter((node) => Boolean(node.compareDocumentPosition(loop) & Node.DOCUMENT_POSITION_FOLLOWING) && !node.closest(".icims_group_loop"))
      .map((node) => cleanLabel(node.textContent || ""))
      .filter((text) => text.length <= 80 && text.toLowerCase().includes(name))
      .at(-1);
    return { section: (heading || name).slice(0, 500), index: Number(loopRow[1]) };
  }
  const known = element.closest(
    '.education--form,[data-automation-id="educationSection"],[data-automation-id^="education-"]',
  );
  if (known) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const rows = [
      ...root.querySelectorAll(
        '.education--form,[data-automation-id="educationSection"],[data-automation-id^="education-"]',
      ),
    ];
    return { section: "Education", index: Math.max(0, rows.indexOf(known)) };
  }
  // Greenhouse's employment rows, as its education rows: without them each
  // job's "Current role" and end date were the same field asked three
  // times, and all were left.
  const job = element.closest(".employment--form,.employment-form");
  if (job) {
    const root = element.getRootNode() as Document | ShadowRoot;
    return { section: "Experience", index: Math.max(0, [...root.querySelectorAll(".employment--form,.employment-form")].indexOf(job)) };
  }
  // SuccessFactors: each row is an .rcmSectionComponent inside the section
  // whose top bar names it ("Work Experiences"). Without this every row's
  // "Country" is the same field, and one row's edit locks them all.
  // A date's input is inside its UI5 picker's shadow root: the row is
  // found from the picker (an employer: every "From Date" was
  // one field, and the site's own dates were never corrected).
  let sfRow: Element | null = null;
  for (let node: Element | null = element; node && !sfRow; ) {
    sfRow = node.closest(".rcmSectionComponent");
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  const sfSection = sfRow?.closest(".rcmFormSection");
  if (sfRow && sfSection) {
    const title = cleanLabel(
      sfSection.querySelector(
        '.rcmFormSectionTopBar span:not([aria-hidden="true"]):not(.hiddenAriaContent):not([role])',
      )?.textContent || "",
    );
    if (title)
      return {
        section: title.slice(0, 500),
        index: Math.max(0, [...sfSection.querySelectorAll(".rcmSectionComponent")].indexOf(sfRow)),
      };
  }
  // Paylocity: each job and each school is a block ("Work History 2",
  // "Education History 1") whose fields repeat the same labels, and its
  // address parts repeat the applicant's own. Without a row they are all one
  // ambiguous field, refused as "another field has the same label", and every
  // school was answered from the first one.
  // Greenhouse's own form on an employer's site:
  // each school is an .education-form-fields block repeating School, Degree
  // and the date boxes.
  const educationBlock = element.closest(".education-form-fields");
  if (educationBlock) {
    const root = element.getRootNode() as Document | ShadowRoot;
    return { section: "Education", index: Math.max(0, [...root.querySelectorAll(".education-form-fields")].indexOf(educationBlock)) };
  }
  const paylocityRow = element.closest(".work-history-group,.education-history-group");
  if (paylocityRow) {
    const work = paylocityRow.classList.contains("work-history-group");
    const root = element.getRootNode() as Document | ShadowRoot;
    const rows = [...root.querySelectorAll(work ? ".work-history-group" : ".education-history-group")];
    return { section: work ? "Work History" : "Education History", index: Math.max(0, rows.indexOf(paylocityRow)) };
  }
  // Avature: each job and school is a datasetField__row fieldset in a group
  // named by the section's title ("Work experience"). Read as one section,
  // every row's End date and "Did you graduate?" was refused as "another
  // field has the same label", and one row's school locked the next's
  //. Its hidden sample row is not a row.
  const avatureRow = element.closest("fieldset.datasetField__row");
  const avatureGroup = avatureRow?.closest('[role="group"][aria-labelledby]');
  if (avatureRow && avatureGroup) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const id = avatureGroup.getAttribute("aria-labelledby") || "";
    const title = cleanLabel(labelText(/\s/.test(id) ? null : root.querySelector(`#${CSS.escape(id)}`)));
    const rows = [...avatureGroup.querySelectorAll("fieldset.datasetField__row:not(.datasetField__row--sample)")];
    if (title) return { section: title.slice(0, 500), index: Math.max(0, rows.indexOf(avatureRow)) };
  }
  // UKG Pro: each job or school is a role="form" panel-list-item named by its
  // panel and number ("Education 1"). Its From and To month/year had no
  // section, so a school's From was told from nothing and stayed empty.
  const ukgItem = element.closest('[role="form"][data-automation="panel-list-item"][aria-label]');
  const ukgTitled = cleanLabel(ukgItem?.getAttribute("aria-label") || "").match(/^(.*\S)\s+(\d{1,3})$/);
  if (ukgTitled) return { section: ukgTitled[1].slice(0, 500), index: Number(ukgTitled[2]) - 1 };
  // Workday: each job or school is a group labelled by its panel's heading
  // ("Work or Other Experience 2", an h5), and the first legend inside it is
  // a date's ("From"). Read as the section, every job's Location was one
  // field, answered with the applicant's home.
  const root = element.getRootNode() as Document | ShadowRoot;
  for (let panel = element.closest('[role="group"][aria-labelledby$="-panel"]'); panel; panel = panel.parentElement?.closest('[role="group"][aria-labelledby$="-panel"]') || null) {
    const id = panel.getAttribute("aria-labelledby") || "";
    const titled = cleanLabel(labelText(/\s/.test(id) ? null : root.querySelector(`#${CSS.escape(id)}`))).match(/^(.*\S)\s+(\d{1,3})$/);
    if (titled) return { section: titled[1].slice(0, 500), index: Number(titled[2]) - 1 };
  }
  const selector =
    'fieldset,[role="group"],[data-automation-id*="workExperience"],[data-automation-id*="education"]';
  const heading = (r: Element) =>
    labelText(r.querySelector('legend,h2,h3,h4,[role="heading"]')) ||
    r.getAttribute("aria-label") ||
    r.getAttribute("data-automation-id") ||
    "";
  // An untitled inner group (iCIMS's "Start Date (Month / Day / Year)")
  // belongs to the titled row around it.
  let row = element.closest(selector);
  while (row && !cleanLabel(heading(row)) && row.parentElement?.closest(selector))
    row = row.parentElement.closest(selector);
  const title = row ? cleanLabel(heading(row)).slice(0, 500) : "";
  // Numbered row titles ("Education (2)", "Addresses (1)* required.") name
  // the section and the row: section Education, second row.
  const numbered = title.match(/^(.*?)\s*\((\d{1,3})\)/);
  if (numbered && numbered[1].trim())
    return { section: numbered[1].trim(), index: Number(numbered[2]) - 1 };
  const section = title;
  const same = [...root.querySelectorAll(selector)].filter(
    (r) => cleanLabel(heading(r)).slice(0, 500) === section,
  );
  return { section, index: Math.max(0, same.indexOf(row!)) };
}

// A radiogroup carries no aria-required; its question is a paragraph above it
// whose trailing element draws the star (Rippling: an empty div whose ::after
// is "*"), or whose text ends in one.
function radiogroupQuestionStarred(group: Element): boolean {
  const solo = (node: Element) => !node.matches('[role="radiogroup"],input,textarea,select') && !node.querySelector('[role="radiogroup"],input,textarea,select');
  const marked = (paragraph: Element) => {
    if (/[*✱]\s*$/.test((paragraph.textContent || "").trim())) return true;
    const last = paragraph.lastElementChild;
    return !!last && ["::after", "::before"].some((pseudo) => /["']\s*[*✱]\s*["']/.test(getComputedStyle(last, pseudo).content) || /[*✱]/.test(last.textContent || ""));
  };
  let node: Element | null = group;
  for (let up = 0; node && up < 5; up++, node = node.parentElement) {
    for (let before = node.previousElementSibling, n = 0; before && n < 3; before = before.previousElementSibling, n++) {
      if (!solo(before)) break;
      const paragraphs = [...before.querySelectorAll("p")].filter((p) => (p.textContent || "").trim() && !p.closest(".ATS_htmlPreview"));
      if (paragraphs.length && marked(paragraphs[0])) return true;
    }
  }
  return false;
}

export function isRequired(element: Control): boolean {
  if (
    (element as HTMLInputElement).required ||
    element.getAttribute("aria-required") === "true" ||
    // Select2 marks its visible selection (Amazon's), not the hidden select.
    select2Selection(element)?.getAttribute("aria-required") === "true"
  )
    return true;
  // A choice of a required group: the group says so, not each choice. A
  // group drawn in its component's shadow root, the choices slotted into it
  // (SmartRecruiters' spl-radio-group, its fieldset aria-required="true"),
  // is found through the slot: four starred Yes/No questions read as
  // optional.
  if (element.getAttribute("role") === "radio") {
    const group = element.closest('[role="radiogroup"]') || element.assignedSlot?.closest('[role="radiogroup"]');
    if (group?.getAttribute("aria-required") === "true") return true;
    if (group && radiogroupQuestionStarred(group)) return true;
  }
  // BambooHR's fabric select: required on the hidden select beside it.
  if (element.matches("button.fab-SelectToggle[data-menu-id]") && element.closest(".fab-Select")?.querySelector("select[required]")) return true;
  if (wfnDropdown(element)?.getAttribute("required") === "true") return true;
  // ADP's recruitment questions star a question in its label's own text
  // (<wfn-text html="…<span class='mdf-required-indicator'>*</span>">), not on
  // the control: its Yes/No groups and lists read as optional.
  if (element.closest(".qMainDiv")?.querySelector(":scope > .question-label-container .mdf-required-indicator")) return true;
  if (element.getAttribute("role") === "combobox") {
    const shell = element.closest(".select__container");
    if (shell?.querySelector('input[required][aria-hidden="true"]'))
      return true;
  }
  // Toggle questions mark required on the question label (Ashby's _required_).
  if (isToggleChoice(element))
    return /required/i.test(String(toggleQuestion(element)?.className || ""));
  if (element.closest(".required-field")) return true;
  // An Oracle Cloud Recruiting question (a row of a knockout form): its label
  // carries the star span and the --required class, whatever the control
  // (a cx-select, a pills radiogroup, a plain input). Required questions,
  // legal ones included, were listed as optional.
  const oracleRow = element.closest(".input-row");
  if (oracleRow?.querySelector(":scope label.input-row__label--required, :scope label > .input-row__label--required-star")) return true;
  // Workday's question dropdowns: the button's own name ends "Required"
  // (" Select One Required"), and the question's legend carries the
  // asterisk. one employer's OPT questions were listed as optional.
  if (/\brequired\s*$/i.test(element.getAttribute("aria-label") || "")) return true;
  const fieldset = element.closest("fieldset");
  const legend = fieldset?.querySelector(":scope > legend");
  if (legend && fieldset!.querySelectorAll(controlSelector).length <= 2 &&
      (legend.querySelector('abbr[title="required"], abbr.requiredAsterisk') || /[*✱]\s*$/.test((legend.textContent || "").trim())))
    return true;
  const ashbyTitle = element.matches("input.ashby-application-form-input-autocomplete") ? element.parentElement?.previousElementSibling : null;
  if (ashbyTitle?.matches("label.ashby-application-form-question-title")) return /required/i.test(String(ashbyTitle.className));
  // (A custom Ashby dropdown's entry is a fieldset without the public class.)
  const ashby = element.closest('.ashby-application-form-field-entry,fieldset[class*="_fieldEntry_"]');
  const title = ashby?.querySelector(":scope > .ashby-application-form-question-title");
  // Each box of a checkbox question is as required as the question: its
  // title carries the mark, and one employer's "locations you would relocate to"
  // read as two optional boxes.
  const entryTitle = ashby?.querySelector(":scope > .ashby-application-form-question-title, :scope > legend");
  // So is each radio of a radio question (its own fieldset, the title marked
  // _required_): one employer's required verification read as optional.
  if (entryTitle && element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio") && ashby!.querySelectorAll(`input[type="${element.type}"]`).length > 1)
    return /required/i.test(String(entryTitle.className)) || /[*✱]|\(required\)/i.test(entryTitle.textContent || "");
  if (title && ashby?.querySelectorAll(controlSelector).length === 1)
    return /required/i.test(String(title.className)) || /[*✱]|\(required\)/i.test(title.textContent || "");
  // A label of its own that ends in the mark (JazzHR's <i class="asterisk">,
  // an employer: its required questions were listed as optional).
  const own = ("labels" in element && element.labels?.[0]?.textContent) || "";
  if (/(?:[*✱]|\(required\))\s*$/i.test(own.trim())) return true;
  // A question written as text above its options says so in that text.
  return /\(required\)\s*$|\*\s*$/i.test((groupQuestion(element)?.raw || "").trim());
}

const patterns = new Map<string, boolean>();
export function validationState(
  element: Control,
  current: string,
): Pick<Field, "invalid" | "validationWarning"> {
  const ariaInvalid = siteInvalid(element);
  const pattern = element.getAttribute("pattern");
  if (pattern !== null) {
    if (!patterns.has(pattern)) {
      if (patterns.size > 500) patterns.clear();
      try {
        new RegExp(pattern, "v");
        patterns.set(pattern, true);
      } catch {
        patterns.set(pattern, false);
      }
    }
    if (!patterns.get(pattern))
      return {
        invalid: ariaInvalid,
        validationWarning:
          "The site has an invalid validation pattern; check this field manually.",
      };
  }
  try {
    const validity = "validity" in element ? (element as HTMLInputElement).validity : undefined;
    // A picker shows its answer beside its own input, which stays empty and
    // "required": missing a value it never holds is not a rejected answer
    // (Paylocity's Country and State).
    const pickerOnly = Boolean(validity?.valueMissing) && !(element as HTMLInputElement).value &&
      !(["badInput", "customError", "patternMismatch", "rangeOverflow", "rangeUnderflow", "stepMismatch", "tooLong", "tooShort", "typeMismatch"] as const)
        .some((fault) => validity![fault]);
    return {
      invalid:
        ariaInvalid ||
        Boolean(current && validity && !validity.valid && !pickerOnly),
    };
  } catch {
    return {
      invalid: ariaInvalid,
      validationWarning:
        "The site's validation check failed; check this field manually.",
    };
  }
}

export function selectedCustomValue(element: Control): string | undefined {
  // ADP's dropdown shows its choice in the button's "selected-label"; until
  // one is made it shows only "Select one...".
  if (wfnDropdown(element)) return (element.getRootNode() as ShadowRoot).querySelector('[id="selected-label"]')?.textContent?.replace(/\s+/g, " ").trim() || "";
  const paylocity = element.closest(".pcty-input-select__input");
  if (paylocity) {
    const value = paylocity.parentElement?.querySelector(".input-select-input-single-value")?.textContent?.trim() || "";
    return /^(select|choose|--)/i.test(value) ? "" : value;
  }
  // An older react-select (no combobox role; one employer's form) shows its
  // choice as a "…-singleValue" block in its container. A flag drawn there
  // has a title, which is no part of the choice.
  // So does Pinpoint's, whose input has its own id: read as its empty search
  // box, its filled Country and State were called unanswered (report 25a9fc1b).
  if (element.matches('input[id^="react-select-"][aria-autocomplete="list"],.dropdown-autocomplete input[aria-autocomplete="list"],input.react-select__input[aria-autocomplete="list"],input.MDFSelectBox__input[aria-autocomplete="list"]')) {
    const container = element.closest('.dropdown-autocomplete,.react-select,[class*="-container"]:not([class*="input-container"])');
    const single = container?.querySelector('[class*="singleValue"],[class*="single-value"]');
    // A multi-select shows each pick as a chip (ADP's "Where did you learn…").
    if (!single) {
      const chips = [...(container?.querySelectorAll('[class*="multi-value__label"]') || [])];
      return chips.map((chip) => (chip.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(", ");
    }
    const copy = single.cloneNode(true) as Element;
    copy.querySelectorAll("svg,title").forEach((node) => node.remove());
    return (copy.textContent || "").replace(/\s+/g, " ").trim();
  }
  if (element.getAttribute("role") !== "combobox") return;
  // SmartRecruiters' spl-select keeps its choice as the host's value, and its
  // button shows only a flag: the chosen spl-select-option's text ("United
  // States +1") is the answer. Read as empty, the phone's Country code was
  // chosen fifteen times over in one fill.
  if (element instanceof HTMLButtonElement) {
    let host = (element.getRootNode() as ShadowRoot).host as Element | undefined;
    for (let depth = 0; host && depth < 4 && !host.matches("spl-select"); depth++) host = (host.getRootNode() as ShadowRoot).host;
    if (host?.matches("spl-select")) {
      const value = host.getAttribute("value") || "";
      const option = value ? [...host.querySelectorAll("spl-select-option")].find((candidate) => candidate.getAttribute("value") === value) : undefined;
      return option ? (option.textContent || option.getAttribute("label") || value).replace(/\s+/g, " ").replace(/\+\s+/g, "+").trim() : value;
    }
  }
  // A react-widgets dropdown draws its open list inside itself, and the list
  // stays there once opened: read as the box's whole text, Paylocity's "Have
  // you worked with us before?" went from "--" to "----YesNo" as it opened,
  // and the pick was given up as a value changed since inspection
  //. Its choice is the one in its "rw-input"; "--" is none.
  if (element.matches(".rw-dropdownlist")) {
    const shown = element.querySelector(":scope > .rw-input");
    if (shown) {
      const text = (shown.textContent || "").trim();
      return /^-+$/.test(text) ? "" : text;
    }
  }
  // iCIMS search dropdowns show their placeholder as the anchor's text.
  if (
    element.matches('a[id$="_icimsDropdown"],a.dropdown-select[role="combobox"]') &&
    /^[\s\u2014-]*(make a selection|please select|select one|loading\.*)[\s\u2014-]*$/i.test(
      element.textContent || "",
    )
  )
    return "";
  const shell = element.closest(".select__container");
  const selected = shell?.querySelector(".select__single-value");
  if (selected) return selected.textContent?.trim() || "";
  const chosen = [...(shell?.querySelectorAll(".select__multi-value__label") || [])];
  if (chosen.length)
    return chosen.map((item) => item.textContent?.trim() || "").join(", ");
  // Text in a react-select's search box is a query, not an answer: the site
  // discards it on blur. With no selected value the field is empty.
  if (shell) return "";
  return element.getAttribute("aria-valuetext") ?? undefined;
}
