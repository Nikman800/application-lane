// The content script's readers of the page (content.ts): functions that
// find and read controls, lists and menus, and touch none of a fill's state.
// Split out of content.ts as they were.
import { iconRadioLabel, profileImport, select2Selection, toggleGroup, isToggleChoice, redundantAutofill, type Control } from "./semantics";
import { normalize, type Field } from "../shared/model";
import { adapterFor } from "./adapters";

// A real click the fill itself made on a menu's entry (see trustedChoose),
// inside the component being written: no sign of the applicant.
export const ourClick = (event: Event) => /^(pointer|mouse)(down|up)$|^click$/.test(event.type);

export const clip = (s: string, max = 1000) =>
  s.replace(/\s+/g, " ").trim().slice(0, max);

// The words a block holds, without its scripts and styles: SuccessFactors
// keeps inline scripts inside its content region, and their code filled
// the whole page description.
export const readableText = (root: Element | null) => {
  if (!root) return "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("script,style,noscript,template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.textContent;
  return text;
};

export const tell = (message: unknown) => {
  try {
    void chrome.runtime.sendMessage(message).catch(() => { /* the background worker may be asleep or gone: nobody to tell */ });
  } catch {
    /* Extension may have been reloaded. */
  }
};

// The hidden checkbox Ashby keeps beside a yes/no toggle pair; the pair is
// the control.
export const behindToggle = (element: Control) => {
  const first = element.parentElement?.querySelector(":scope > button[aria-pressed]");
  return element instanceof HTMLInputElement && Boolean(first && isToggleChoice(first));
};

// The site's own job search and language menu, in the header of a posting
// (Amazon's: the posting read as a form of three fields, its
// search boxes listed as optional questions, and Fill filled nothing).
export const siteChrome = (element: Control) => {
  if (element.closest('[role="search"],search') || element.matches('[role="combobox"][aria-haspopup="menu"]')) return true;
  const form = element.closest("form");
  if (!form || (form.getAttribute("method") || "get").toLowerCase() !== "get") return false;
  try {
    return /\/search\/?$/i.test(new URL(form.action, location.href).pathname);
  } catch {
    return false;
  }
};

export const isTrackableControl = (element: Control) =>
  (!element.matches("button[aria-pressed]") || isToggleChoice(element)) &&
  !siteChrome(element) &&
  !redundantAutofill(element) &&
  !behindToggle(element) &&
  !profileImport(element) &&
  // Select2's visible selection: the hidden select beside it is the field,
  // with the options and the submitted value (Amazon listed each question
  // twice, once unlabelled and once without options).
  !(element.matches(".select2-selection") &&
    select2Selection(element.closest(".select2-container")?.previousElementSibling || element) === element) &&
  // A native radio or checkbox drawn inside an ARIA one is that control's
  // own input (Rippling); counted as well, every option appears twice.
  // One inside a list option only marks that option chosen (Workday's
  // multiselect lists): the dropdown is the field, not its options.
  !(element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type) &&
    element.parentElement?.closest(`[role="${element.type}"],[role="option"]`)) &&
  (element.getAttribute("aria-hidden") !== "true" ||
    Boolean(select2Selection(element)) ||
    (element instanceof HTMLInputElement && element.type === "file")) &&
  (!(element instanceof HTMLInputElement) ||
    !["hidden", "password", "submit", "reset", "button"].includes(
      element.type,
    ));

export function openModal(tracked: Control[]): Element | undefined {
  const holds = (dialog: Element) => tracked.some((element) => dialog.contains(element));
  // A cookie notice calls itself a modal dialog too (Pinpoint's, and its
  // preferences box, which stays in the page drawn but invisible): it is
  // not the form, and the form behind it can be reached.
  const consent = (dialog: Element) =>
    /\bcookies?\b|\bconsent\b/i.test(dialog.textContent || "") &&
    tracked.every(
      (element) => !dialog.contains(element) || (element instanceof HTMLInputElement && element.type === "checkbox") || element instanceof HTMLButtonElement,
    );
  const open = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')].filter(
    (dialog) =>
      dialog.getClientRects().length &&
      dialog.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      holds(dialog) &&
      !consent(dialog),
  );
  return open.reverse().find(
    (dialog) =>
      dialog.matches('[aria-modal="true"]') ||
      (dialog instanceof HTMLDialogElement && dialog.matches(":modal")) ||
      // Opened without showModal, yet drawn over the page as one.
      (getComputedStyle(dialog).position === "fixed" &&
        tracked.some((element) => dialog.contains(element) && element.matches("[required],[aria-required='true']"))),
  );
}

export const radioGroup = (element: Control): Control[] => {
  if (isToggleChoice(element)) return toggleGroup(element);
  const role = element.getAttribute("role");
  if (element instanceof HTMLInputElement && element.type === "checkbox") {
    const group = element.closest(
      'fieldset[data-automation-id$="-CheckboxGroup"]',
    );
    if (group)
      return [...group.querySelectorAll<Control>('input[type="checkbox"]')].filter(
        isTrackableControl,
      );
  }
  if (element instanceof HTMLInputElement && element.type === "radio") {
    const root = element.getRootNode() as Document | ShadowRoot;
    if (element.name)
      return [
        ...root.querySelectorAll<Control>(
          `input[type="radio"][name="${CSS.escape(element.name)}"]`,
        ),
      ].filter(
        (candidate) =>
          candidate instanceof HTMLInputElement &&
          candidate.form === element.form &&
          isTrackableControl(candidate),
      );
    const group = element.closest(
      'fieldset,[role="radiogroup"],.application-question',
    );
    return group
      ? [
          ...group.querySelectorAll<Control>(
            'input[type="radio"]:not([name]),input[type="radio"][name=""]',
          ),
        ]
      : [element];
  }
  if (role === "radio") {
    const group = element.closest('[role="radiogroup"]');
    if (group) return [...group.querySelectorAll<Control>('[role="radio"]')];
    // A group drawn in its component's own shadow root with the choices
    // slotted into it (SmartRecruiters' spl-radio-group): each Yes and No
    // read as a question of its own, both refused as "another field has
    // the same label" (one employer's screening questions).
    // Icons drawn in the labels of native radios (Jobvite): the icons of the
    // question's fieldset are its options.
    const fieldset = iconRadioLabel(element) && element.closest("fieldset");
    if (fieldset) return [...fieldset.querySelectorAll<Control>('[role="radio"]')].filter((icon) => iconRadioLabel(icon));
    const parent = element.parentElement;
    if (parent && element.assignedSlot?.closest('[role="radiogroup"]'))
      return [...parent.children].filter((child): child is Control => child.getAttribute("role") === "radio");
    return [element];
  }
  return [element];
};

export const lockKey = (field: Pick<Field, "label" | "section" | "index">) =>
  `${normalize(field.section || "")}:${field.index || 0}:${normalize(field.label)}`;

// A lock from the site's behaviour guards the value it saw; once the field
// is empty again there is nothing left to guard.
// The search box of a list of picks (Workday's Field of Study, Skills):
// what is typed there is a search, and the site drops it unless something
// is picked. The answer is the pick. With none, an applicant's typing
// protects nothing, and a lock from it kept both fields empty in every
// later fill (an employer: "python" and "Data Science" typed to show
// the site's search, then cleared by it).
export const searchWithoutPick = (element: Element) => {
  const box = element.matches('input[data-uxi-widget-type="selectinput"]')
    ? element.closest('[data-automation-id="multiSelectContainer"]')
    : null;
  return Boolean(box) && !box!.querySelector('[data-automation-id="selectedItem"]');
};

// What a list of picks holds is its picks, not its search box: Workday
// picks a phone code itself once the country is set, and an empty box
// reported it as a required field left empty (GE Vernova, an employer). Only for what is reported: the record, and what it
// protects, still go by the box.
export const picksOf = (element: Element) => {
  const box = element.matches('input[data-uxi-widget-type="selectinput"]')
    ? element.closest('[data-automation-id="multiSelectContainer"]')
    : null;
  // Microsoft's careers form shows a multiselect's picks as pills beside
  // its read-only box ("United States, Washington, Redmond"): read as
  // empty, a chosen location was reported as missing.
  const pills = element.matches('input[class*="select-module_select-input"]')
    ? [...(element.closest('[class*="select-module_select-wrapper"]')?.querySelectorAll('[class*="select-module_multi-select-pill"] [class*="pills-module_label"]') || [])]
    : [];
  // Oracle's cx-multi-select shows each pick as a pill in a list beside its
  // box (ul.cx-multi-select-pill__values, outside .cx-multi-select-container),
  // and the box itself stays empty (live).
  const tags = element.matches("input.cx-multi-select-input")
    ? [...(element.closest(".cx-multi-select, .input-row__control-container")?.querySelectorAll(".cx-multi-select-pill__value-text") || [])]
    : [];
  return [...[...(box?.querySelectorAll('[data-automation-id="selectedItem"]') || [])]
    .map((item) => clip(item.getAttribute("title") || item.textContent || "")), ...splPicks(element),
    ...pills.map((pill) => clip(pill.textContent || "")), ...tags.map((tag) => clip(tag.textContent || ""))]
    .filter(Boolean)
    .join("; ");
};

// Whether a list takes several picks: Oracle's cx-multi-select, an
// aria-multiselectable list, or one worded "choose all that apply".
export function takesSeveralPicks(element: Element, label: string): boolean {
  return element.matches(".cx-multi-select-input,[aria-multiselectable='true']") ||
    Boolean(element.closest(".cx-multi-select-container,[aria-multiselectable='true']")) ||
    /\b(choose|select|check|pick) all that apply\b/i.test(label);
}

// A SmartRecruiters multiselect keeps its picks as its own value, the ids
// of the entries chosen; its box stays empty. Read as empty, a list already
// holding "Not Applicable" was picked again, and the second pick undid
// the first.
export const splChosen = (element: Element): string[] => {
  let host = (element.getRootNode() as ShadowRoot).host as Element | undefined;
  for (let depth = 0; host && depth < 4 && !host.matches("spl-multiselect-autocomplete"); depth++)
    host = ((host.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
  if (!host?.matches("spl-multiselect-autocomplete")) return [];
  return (host.getAttribute("value") || "").split(/[\s,;]+/).filter(Boolean);
};

export const splPicks = (element: Element): string[] => {
  const chosen = splChosen(element);
  if (!chosen.length) return [];
  const named = [...(controlledList(element)?.children || [])]
    .filter((option) => chosen.includes(option.getAttribute("value") || ""))
    .map((option) => clip(option.textContent || ""))
    .filter(Boolean);
  return named.length ? named : [`${chosen.length} selected`];
};

// A placeholder a site writes where its resume parser found nothing
// ("UNSPECIFIED" as a company, an employer) is no answer to
// keep, whatever the setting for site values.
export const placeholder = (value: string) =>
  /^\s*(unspecified|not specified|unknown|n\/?a|none|null|undefined|-+|\.+)\s*$/i.test(value);

export const nativeActivationControl = (element: Element) => {
  const candidate =
    element instanceof HTMLInputElement
      ? element
      : (element instanceof HTMLLabelElement
          ? element
          : element.closest("label"))?.control;
  return candidate instanceof HTMLInputElement &&
    ["checkbox", "radio"].includes(candidate.type)
    ? candidate
    : undefined;
};

// The date beside a signature is today's date, a fact and not the
// applicant's mark (Lever's eeo[disabilitySignatureDate], Workday's
// dateSignedOn): it is filled like any other date.
export const manualSigningControl = (element: Element) =>
  [element.id, element.getAttribute("name") || ""].some(identity => {
    const words = identity.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    return (
      !/(?:signature|sign(?:ed)?)[_-]?(?:date|on)\b|date[_-]?signed/i.test(words) &&
      /(?:^|[_-])(?:cust_?sign(?:ature)?|e_?sign(?:ature)?|signature|initials)(?:$|[_-])/i.test(words)
    );
  });

export function nextButton(): HTMLButtonElement | undefined {
  const ats = adapterFor(location.href);
  if (!ats.next) return;
  const button = document.querySelector<HTMLButtonElement>(ats.next);
  if (
    !button ||
    button.disabled ||
    button.type !== "button" ||
    !button.getClientRects().length
  )
    return;
  const label = clip(
    button.textContent || button.getAttribute("aria-label") || "",
  );
  if (
    !/^(next|continue|save and continue)$/i.test(label) ||
    ats.final.test(label)
  )
    return;
  return button;
}

// The arrow beside an Ashby dropdown's input opens its whole list (a press
// or focus on the input does not). It only ever opens or closes that list;
// outside a form it cannot submit anything.
export const ashbyToggle = (element: Element): HTMLButtonElement | undefined => {
  if (!element.matches('input.ashby-application-form-input-autocomplete[role="combobox"]')) return;
  const buttons = element.parentElement?.querySelectorAll<HTMLButtonElement>(":scope > button") || [];
  return buttons.length === 1 && !buttons[0].form && !buttons[0].closest("a,form") ? buttons[0] : undefined;
};

// BambooHR's "fabric" selects: a button (aria-haspopup="true", no listbox
// role) that opens a menu drawn elsewhere in the page under the id its
// data-menu-id names; the select beside it is hidden, empty and unusable.
export const fabricToggle = (element: Element): element is HTMLButtonElement =>
  element instanceof HTMLButtonElement && element.matches("button.fab-SelectToggle[data-menu-id]");
// Opened only by a whole press (live, a BambooHR State list): a click
// alone, or a focus and click, leaves it shut.
// The click too is a mouse's (detail 1): element.click() says 0, which reads
// as a keyboard's, and the live State menu stayed shut after the whole press
// with it.
export function pressFabric(element: HTMLElement) {
  const init = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0 };
  element.dispatchEvent(new PointerEvent("pointerdown", init));
  element.dispatchEvent(new MouseEvent("mousedown", init));
  element.dispatchEvent(new PointerEvent("pointerup", init));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.dispatchEvent(new MouseEvent("click", init));
}
export const fabricMenu = (element: Element): HTMLElement | null => {
  const id = element.getAttribute("data-menu-id") || "";
  return id ? (element.getRootNode() as Document | ShadowRoot).querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) : null;
};
// A BambooHR menu is drawn hidden (visibility: hidden) and shown once the
// page has placed it, on an animation frame; in a tab out of view that frame
// never comes, and the menu, open and taking clicks, stays hidden. It is
// drawn when it takes up room (display: none, when closed, takes none).
export const fabricDrawn = (element: Element) =>
  !element.closest("[hidden],[inert]") && element.getClientRects().length > 0;
// The menu's choices: its option rows, else its option or menuitem roles.
export function fabricOptions(menu: ParentNode | null): HTMLElement[] {
  if (!menu) return [];
  const rows = [...menu.querySelectorAll<HTMLElement>(".fab-MenuOption")];
  return rows.length ? rows : [...menu.querySelectorAll<HTMLElement>('[role="option"],[role="menuitem"],[role="menuitemradio"]')];
}

// Rippling's dropdowns (a div, or a search input) open on a click and close
// on a press anywhere outside them; neither chooses anything.
export const ripplingSelect = (element: Element) =>
  element.matches('[role="combobox"][aria-haspopup="listbox"]') && Boolean(element.closest('[data-testid="select-controller"]'));

// Paylocity's address lines (Address Line 1, and Postal Code outside the
// US) are text boxes that suggest addresses as they are typed, not lists:
// a combobox naming its "-autocomplete-list". Opened as a list, nothing was
// typed (or the box already held the city a résumé parse put there), no
// suggestion came, and the line was left empty or holding the city
// (Paylocity's address).
export const paylocityAddressBox = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement && element.getAttribute("role") === "combobox" && Boolean(element.id) &&
  element.getAttribute("aria-controls") === `${element.id}-autocomplete-list` &&
  element.getAttribute("data-automation-id") === element.id;

// Rippling's Location is a text box that asks Google Maps for places as it
// is typed (no combobox role: aria-autocomplete="list" and
// aria-haspopup="listbox" inside data-testid="location"). Its suggestions are
// drawn a second after the text, in a dialog outside the form; the text
// alone left that list open and the box unpicked (Rippling's Location).
export const ripplingLocation = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement && element.getAttribute("role") !== "combobox" &&
  element.getAttribute("aria-autocomplete") === "list" && element.getAttribute("aria-haspopup") === "listbox" &&
  Boolean(element.closest('[data-testid="location"]'));

// SuccessFactors' picklists open on a click, not on a press, and draw each
// option as one menu item link inside it.
export const successFactorsPicklist = (element: Element) =>
  element.matches('input.rcmpaginatedselectinput[role="combobox"]');

export const pressOutside = () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, view: window }));

export const closeSuccessFactorsList = (element: Element) => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  pressOutside();
};

// The nearest ancestor matching a selector, looked for past the shadow
// roots a control sits in: SuccessFactors' UI5 date picker's input is two
// shadow roots inside its RCMFormField, and closest alone never found it.
// A date its resume parser rewrote then read as the applicant's edit and
// was kept, while the same row's company and title were corrected (Fabrikam).
export function closestAcrossShadows(element: Element, selector: string): Element | null {
  for (let node: Element | undefined = element, depth = 0; node && depth < 8; depth++) {
    const found = node.closest(selector);
    if (found) return found;
    node = ((node.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
  }
  return null;
}

export function inEntryEditor(element: Element): boolean {
  for (let node: Element | undefined = element, depth = 0; node && depth < 8; depth++) {
    if (node.closest("oc-education-entry, oc-experience-entry, [data-lane-entry-busy]")) return true;
    node = ((node.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
  }
  return false;
}

// The list a combobox names, found in its own root or in the roots of the
// components around it: SmartRecruiters' box sits in an spl-input inside
// the spl-autocomplete whose shadow root holds the menu.
export function controlledList(element: Element): HTMLElement | null {
  const id = element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || "";
  if (!id || /\s/.test(id)) return null;
  for (let root: Node = element.getRootNode(), depth = 0; depth < 4; depth++) {
    const found = (root as Document | ShadowRoot).querySelector?.<HTMLElement>(`#${CSS.escape(id)}`);
    if (found) return found;
    const host = (root as ShadowRoot).host;
    if (!host) break;
    root = host.getRootNode();
  }
  return null;
}

// An option component whose role="option" is drawn in its own shadow root
// (SmartRecruiters' spl-select-option), its text slotted from outside.
// Entries a list only slots in from the component around it count as its
// own: SmartRecruiters' phone Country code list is a <slot> drawing the
// spl-select-options of its spl-select.
export function shadowedOptions(list: Element): HTMLElement[] {
  const children = [...list.children].flatMap((child) => child instanceof HTMLSlotElement ? child.assignedElements({ flatten: true }) : [child]);
  return children.filter((child): child is HTMLElement =>
    child instanceof HTMLElement && !child.matches('[role="option"]') && Boolean(deepOption(child)));
}

export function deepOption(host: Element): HTMLElement | null {
  const visit = (root: ShadowRoot | null, depth: number): HTMLElement | null => {
    if (!root || depth > 3) return null;
    const own = root.querySelector<HTMLElement>('[role="option"]');
    if (own) return own;
    for (const node of root.querySelectorAll("*")) {
      const found = visit(node.shadowRoot, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(host.shadowRoot, 0);
}

// Its options already in the page, closed (SmartRecruiters keeps them
// drawn): read without opening, so the answer is one of them.
export function drawnOptions(element: Element): string[] {
  if (element.getAttribute("role") !== "combobox") return [];
  const list = controlledList(element);
  if (!list) return [];
  const own = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  // An option component draws its role="option" only once its list has
  // been opened: SmartRecruiters' Gender, Race and Veteran lists, never
  // opened, read as none, and Veteran went unanswered. Its own element, named for an option, is one.
  const drawn = own.length ? own : shadowedOptions(list);
  const options = drawn.length ? drawn : [...list.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && /-option$/i.test(child.tagName) && !child.matches("[hidden]"));
  return [...new Set(options
    .filter((option) => option.getAttribute("aria-disabled") !== "true" && deepOption(option)?.getAttribute("aria-disabled") !== "true")
    .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))];
}

export const associatedNativeChoice = (element: Control, type: "radio" | "checkbox"): HTMLInputElement | undefined => {
  const nested = [...element.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)];
  const label = element.closest("label");
  const labelled = label?.control;
  const candidates = [...new Set([...nested, ...(labelled instanceof HTMLInputElement && labelled.type === type ? [labelled] : [])])];
  if (candidates.length > 1) throw new Error("The native choice association is ambiguous.");
  if (candidates.length && (!candidates[0].isConnected || candidates[0].disabled)) throw new Error("The associated native choice is unavailable.");
  return candidates[0];
};

// Widgets that keep their own state ignore assigned values and synthetic
// keys alike; Workday's date sections are the reason this path exists.
// Where in the menu a typed box opened the entry naming a value sits,
// counted from 1, not the box's own "fill manually" entry: SmartRecruiters'
// "Lansing, MI, US" for "Lansing, MI". A script's click on it was
// ignored, so it is reached with the keys the applicant uses. Its menu may
// sit in the component's nested shadow roots. 0: none listed (after up to
// 2.5 s for the menu).
// The entries a component's menu lists, its role="option" elements in any
// of its shadow roots, in order.
export function menuEntries(element: Element): HTMLElement[] {
  // The component around the box, not the box: an input that is itself a
  // combobox naming its list matched at once, and its menu (in the
  // component's shadow root) was never searched.
  let host: Element | undefined = ((element.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
  for (let depth = 0; host && depth < 4 && !host.matches("spl-autocomplete,spl-multiselect-autocomplete"); depth++)
    host = ((host.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
  if (!host) {
    const list = controlledList(element);
    return list ? [...list.querySelectorAll<HTMLElement>('[role="option"]')].filter((option) => option.getAttribute("aria-disabled") !== "true") : [];
  }
  const found: HTMLElement[] = [];
  const visit = (root: ParentNode) => {
    for (const node of root.querySelectorAll<HTMLElement>("*")) {
      if (node.getAttribute("role") === "option") found.push(node);
      if (node.shadowRoot) visit(node.shadowRoot);
    }
  };
  visit(host);
  if (host.shadowRoot) visit(host.shadowRoot);
  return found.filter((option) => option.getAttribute("aria-disabled") !== "true");
}

// The middle of a menu entry where a click there reaches it: the topmost
// element drawn at that point, followed down through the shadow roots it
// hosts, is the entry or inside it. Anything else (a header drawn over
// the menu) would take the click instead.
export function entryPoint(entry: HTMLElement): { x: number; y: number } | undefined {
  const box = entry.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return;
  const x = Math.round(box.left + box.width / 2);
  const y = Math.round(box.top + box.height / 2);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
  let hit: Element | null = document.elementFromPoint(x, y);
  for (let depth = 0; hit?.shadowRoot && depth < 8; depth++) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return;
  // The entry, or an element inside it: inside its shadow roots, or
  // slotted into it from the option component around it.
  for (let node: Node | null = hit, depth = 0; node && depth < 40; depth++) {
    if (node === entry) return { x, y };
    node = (node as Element).assignedSlot || node.parentNode || ((node as ShadowRoot).host ?? null);
  }
  const around = (entry.getRootNode() as ShadowRoot).host;
  for (let node: Node | null = hit, depth = 0; around && node && depth < 40; depth++) {
    if (node === around) return { x, y };
    node = (node as Element).assignedSlot || node.parentNode || ((node as ShadowRoot).host ?? null);
  }
  return;
}
