// A command the service worker sends a frame (content/commands.ts): reading dropdowns' options.
// Split out of executeCommand as it was.
import { cs } from "../state";
import { documentId, records } from "../tracking";
import { type QuestionnaireAnswers, loadQuestionnaires, questionnaireUrls } from "../../../engine/config/workday-questionnaire";
import { listButton, pause, Command } from "../core";
import { fillClick } from "../../../engine/page/click-gate";
import { controlledList, fabricToggle, fabricMenu, fabricOptions, fabricDrawn, pressFabric, drawnOptions, pressOutside, picksOf, ashbyToggle, ripplingSelect } from "../../content-dom";
import { valueOf } from "../controls";
import { requestMainWorld } from "../../../engine/page/bridge";
import { reactSelectInput } from "../choose";

  // Reads, without choosing anything, the options of dropdowns that only
  // list them once opened (react-select). A reviewed AI suggestion has to
  // name one of a field's real options, and nothing can be suggested for a
  // list nobody has read.
  export async function handleOptions(command: Command): Promise<unknown> {
// A read is allowed during a human pause; a stale page or operation is not.
const current = () => !cs.composing && command.applicationId === cs.applicationId && command.operation === cs.operation && command.documentId === documentId;
if (!current()) throw new Error("Stale operation.");
const read: { id: string; options: string[] }[] = [];
const guard = { applicationId: cs.applicationId, operation: cs.operation, documentId };
// Workday's questions, all answered by the questionnaire the page loaded
// (see workday-questionnaire.ts): read there, nothing is opened.
let questionnaire: QuestionnaireAnswers | undefined;
const questionnaires = async () =>
  (questionnaire ??= await loadQuestionnaires(
    questionnaireUrls(performance.getEntriesByType("resource").map((entry) => entry.name), location.origin),
  ).catch(() => new Map() as QuestionnaireAnswers));
for (const id of (command.fieldIds || []).slice(0, 40)) {
  const record = records.get(id);
  // A Workday list button: its question's answers from the
  // questionnaire, else opened, read and closed with nothing chosen
  // (one employer's Phone Device Type, "Home" and "Home Cellular", was
  // answered blind and missed).
  if (record && listButton(record.element) && !record.protected && record.element.isConnected &&
      record.element.getAttribute("aria-expanded") !== "true" && document.activeElement !== record.element) {
    const button = record.element as HTMLButtonElement;
    const listed = button.name ? (await questionnaires()).get(button.name) : undefined;
    if (listed?.length) {
      read.push({ id, options: listed });
      continue;
    }
    cs.writing = true;
    try {
      if (fabricToggle(button)) pressFabric(button);
      else fillClick(button);
      let options: string[] = [];
      let steady = 0;
      for (let attempt = 0; attempt < 40 && steady < 2 && current(); attempt++) {
        await pause(50);
        const listId = (button.getAttribute("aria-controls") || "").split(/\s+/)[0];
        const list = fabricToggle(button) ? fabricMenu(button) : listId ? document.getElementById(listId) : null;
        const shown = (fabricToggle(button) ? fabricOptions(list) : [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])])
          .filter((option) => option.getAttribute("aria-disabled") !== "true")
          .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
          .filter((option) => option && !/^select one$/i.test(option));
        // Workday fills the list a moment after it opens.
        steady = shown.length && shown.length === options.length ? steady + 1 : 0;
        options = shown;
      }
      // A BambooHR menu outlives Escape (its toggle says closed, the menu
      // stays drawn, and the next press shut it instead of opening it): it
      // is closed as it opened, by another whole press.
      if (fabricToggle(button) && fabricOptions(fabricMenu(button)).some(fabricDrawn)) {
        pressFabric(button);
        await pause(150);
      }
      if (button.getAttribute("aria-expanded") === "true") {
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        await pause(100);
      }
      if (button.getAttribute("aria-expanded") === "true") {
        fillClick(document.querySelector<HTMLElement>('[data-automation-id="mainContent"]') || document.body);
        await pause(100);
      }
      if (document.activeElement === button) button.blur();
      if (options.length) read.push({ id, options: options.slice(0, 300) });
    } finally {
      cs.writing = false;
    }
    continue;
  }
  // A SmartRecruiters list draws its options only once first opened:
  // Gender, Race and Veteran were never open before their answers were
  // planned, read as none, and Veteran went unanswered. Opened, read and closed with nothing chosen;
  // quick, so also before a fill's plan.
  const splHost = (element: Element) => {
    for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++)
      if (host.matches("spl-autocomplete,spl-multiselect-autocomplete")) return host;
    return undefined;
  };
  if (record && record.element instanceof HTMLInputElement && record.element.getAttribute("role") === "combobox" &&
      splHost(record.element) && controlledList(record.element) && !record.protected && record.element.isConnected &&
      !valueOf(record.element) && record.element.getAttribute("aria-expanded") !== "true") {
    const input = record.element;
    let options = drawnOptions(input);
    if (!options.length) {
      cs.writing = true;
      try {
        input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0, view: window }));
        fillClick(input);
        for (let waited = 0; waited < 1500 && !options.length && current(); waited += 100) {
          await pause(100);
          options = drawnOptions(input);
        }
        if (input.getAttribute("aria-expanded") === "true") pressOutside();
        input.blur();
        await pause(150);
      } finally {
        cs.writing = false;
      }
    }
    if (options.length) read.push({ id, options: options.slice(0, 300) });
    continue;
  }
  // Microsoft's careers form draws a list's options only once opened:
  // its sponsorship question, read with none, went unanswered
  //. Opened (a click on the box, else its arrow), read,
  // and closed with nothing chosen; quick, so also before a plan.
  if (record && record.element instanceof HTMLInputElement && record.element.matches('input[role="combobox"][class*="select-module_select-input"]') &&
      !record.protected && record.element.isConnected && !valueOf(record.element) && !picksOf(record.element) &&
      record.element.getAttribute("aria-expanded") !== "true" && document.activeElement !== record.element) {
    const input = record.element;
    const listed = () => {
      const list = controlledList(input);
      return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
        .filter((option) => option.getAttribute("aria-disabled") !== "true")
        .map((option) => (option.getAttribute("title") || option.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    };
    let options = listed();
    if (!options.length) {
      cs.writing = true;
      try {
        fillClick(input);
        for (let waited = 0; waited < 300 && input.getAttribute("aria-expanded") !== "true"; waited += 50) await pause(50);
        if (input.getAttribute("aria-expanded") !== "true")
          fillClick(input.parentElement?.querySelector<HTMLButtonElement>('button[aria-hidden="true"][tabindex="-1"]'));
        for (let waited = 0; waited < 1500 && !options.length && current(); waited += 100) {
          await pause(100);
          options = listed();
        }
        if (input.getAttribute("aria-expanded") === "true") {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          await pause(100);
        }
        if (input.getAttribute("aria-expanded") === "true") pressOutside();
        // The site hands focus back to the box as its list closes, and a
        // focused field is the applicant's: the answer was then skipped
        // as "The field currently has focus".
        for (let waited = 0; waited < 600; waited += 50) {
          if (document.activeElement === input || input.matches(":focus")) input.blur();
          await pause(50);
        }
      } finally {
        cs.writing = false;
      }
    }
    if (options.length) read.push({ id, options: options.slice(0, 300) });
    continue;
  }
  // A SuccessFactors pick list: its options asked of the list's own
  // model, as the page asks for them when it opens, so nothing is
  // opened, also during a fill (see sfPicklistOptions in mainWorld.ts).
  // Where there is no model, it is opened below for the AI pass.
  if (record && record.element instanceof HTMLInputElement && record.element.classList.contains("rcmpaginatedselectinput") &&
      !record.protected && record.element.isConnected && !valueOf(record.element)) {
    const input = record.element;
    cs.writing = true;
    try {
      const listed = await requestMainWorld(input, guard, { method: "sfPicklistOptions", values: [] }, undefined,
        () => current() && input.isConnected && !record.protected).catch(() => undefined);
      const options = listed?.ok
        ? (JSON.parse(listed.value || "[]") as unknown[])
          .filter((option): option is string => typeof option === "string" && !/^no selection$/i.test(option.trim()))
        : [];
      if (options.length) {
        read.push({ id, options: options.slice(0, 300) });
        continue;
      }
    } finally {
      cs.writing = false;
    }
  }
  if (command.listButtonsOnly) continue;
  const arrow = record && ashbyToggle(record.element);
  if (record && arrow && !record.protected && record.element.isConnected && !valueOf(record.element) &&
      document.activeElement !== record.element && record.element.getAttribute("aria-expanded") !== "true") {
    // Opened and closed again from its own arrow; nothing is chosen.
    const input = record.element as HTMLInputElement;
    cs.writing = true;
    try {
      fillClick(arrow);
      let options: string[] = [];
      for (let attempt = 0; attempt < 20 && !options.length && current(); attempt++) {
        await pause(50);
        const listId = input.getAttribute("aria-controls");
        const list = listId && !/\s/.test(listId) ? (input.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(listId)}`) : null;
        options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
          .map((option) => (option.textContent || "").trim()).filter(Boolean).slice(0, 100);
      }
      if (input.getAttribute("aria-expanded") === "true" && !input.value) fillClick(arrow);
      // The arrow hands focus to the input, sometimes a moment later.
      for (let waited = 0; waited < 600; waited += 50) {
        await pause(50);
        if (document.activeElement === input && !input.value) input.blur();
      }
      if (options.length) read.push({ id, options });
    } finally {
      cs.writing = false;
    }
    continue;
  }
  // A SuccessFactors list draws its options only once opened, a page at
  // a time as it is scrolled; the AI pass saw Status and Education Type
  // with none. Opened, scrolled while it
  // grows, read, and closed with nothing chosen.
  if (record && record.element instanceof HTMLInputElement && record.element.classList.contains("rcmpaginatedselectinput") &&
      !record.protected && record.element.isConnected && !valueOf(record.element) && document.activeElement !== record.element) {
    const input = record.element;
    cs.writing = true;
    try {
      fillClick(input);
      let options: string[] = [];
      let steady = 0;
      for (let attempt = 0; attempt < 60 && steady < 3 && options.length < 300 && current(); attempt++) {
        await pause(200);
        const listId = (input.getAttribute("aria-owns") || input.getAttribute("aria-controls") || "").split(/\s+/)[0];
        const list = listId ? document.getElementById(listId) : document.querySelector("ul.sf-list-select");
        const shown = [...new Set([...(list?.querySelectorAll<HTMLElement>('li[role="option"]') || [])]
          .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
          .filter((option) => option && !/^no selection$/i.test(option)))];
        steady = shown.length && shown.length === options.length ? steady + 1 : 0;
        options = shown;
        list?.querySelector(":scope > li:last-child")?.scrollIntoView({ block: "end" });
        for (let box: Element | null = list, up = 0; box && up < 5; box = box.parentElement, up++) {
          if (box.scrollHeight > box.clientHeight + 4) box.scrollTop = box.scrollHeight;
          box.dispatchEvent(new Event("scroll"));
        }
      }
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      pressOutside();
      await pause(150);
      if (document.activeElement === input) input.blur();
      if (options.length) read.push({ id, options: options.slice(0, 300) });
    } finally {
      cs.writing = false;
    }
    continue;
  }
  if (record && ripplingSelect(record.element) && !record.protected && record.element.isConnected && !valueOf(record.element) &&
      document.activeElement !== record.element && record.element.getAttribute("aria-expanded") !== "true") {
    const control = record.element;
    cs.writing = true;
    try {
      fillClick(control);
      let options: string[] = [];
      for (let attempt = 0; attempt < 20 && !options.length && current(); attempt++) {
        await pause(50);
        const listId = control.getAttribute("aria-controls");
        const list = listId && !/\s/.test(listId) ? (control.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(listId)}`) : null;
        if (list?.getAttribute("aria-busy") === "true") continue;
        options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
          .filter((option) => option.getAttribute("aria-disabled") !== "true")
          .map((option) => (option.textContent || "").trim()).filter(Boolean).slice(0, 100);
      }
      if (control.getAttribute("aria-expanded") === "true") pressOutside();
      // Closed and unfocused before the next list is opened.
      await pause(120);
      if (document.activeElement === control) (control as HTMLElement).blur();
      if (options.length) read.push({ id, options });
    } finally {
      cs.writing = false;
    }
    continue;
  }
  const element = record && reactSelectInput(record.element);
  if (!record || !element || record.protected || !record.element.isConnected || valueOf(record.element)) continue;
  const safe = () => current() && element.isConnected && !record.protected && document.activeElement !== element;
  const call = (method: string) => requestMainWorld(element, guard, { method, values: [] }, undefined, safe);
  cs.writing = true;
  try {
    const listed = await call("reactSelectOptions");
    // Choosing nothing closes the menu and clears any search state.
    await call("reactSelectChoose").catch(() => undefined);
    if (listed.ok) {
      const options = (JSON.parse(listed.value || "[]") as string[]).filter((option) => typeof option === "string" && option.trim()).slice(0, 100);
      if (options.length) read.push({ id, options });
    }
  } catch {
    /* Unreadable lists stay without options. */
  } finally {
    cs.writing = false;
  }
}
return read;
}
