// Part of the content script (content.ts): choosing from lists, react-select and custom dropdowns, and typing with real keys.
// Split out of content.ts as it was; see content.ts for how it starts.
import { requestMainWorld } from "../../engine/page/bridge";
import { nameVariants } from "../../shared/matching";
import { type Proposal, normalize } from "../../shared/model";
import { controlledList, fabricToggle, fabricMenu, fabricOptions, fabricDrawn, pressFabric, ashbyToggle, successFactorsPicklist, ripplingSelect, shadowedOptions, deepOption, pressOutside, splChosen, picksOf, closeSuccessFactorsList, menuEntries } from "../content-dom";
import { writable, rendered, wfnDropdown } from "../semantics";
import { pickOption } from "../../shared/answers";
import { searchSiteList } from "../../engine/runtime";
import { fillClick } from "../../engine/page/click-gate";
import { cs } from "./state";
import { attentionSpan, documentId, fieldLabel, ownedAutocompleteSearches, records, userAttention } from "./tracking";
import { Command, RecordEntry, legacyReactSelect, listButton, pause, requestTrustedType } from "./core";
import { changed, invalidCommandReason, valid } from "./guards";
import { expectOwnedActivation, valueOf } from "./controls";

// react-select widgets (Greenhouse and many others) ignore synthetic events,
// so they are driven through their component API in the page: list the
// options, let the caller choose one, then select exactly that option.
// Typing into their search box never counts as an answer.
export async function reactSelect(
  element: Element,
  choose: (labels: string[]) => string | undefined,
  searches: string[],
  safe: () => boolean,
  signal?: AbortSignal,
): Promise<"selected" | "unsupported" | "no-match"> {
  const guard = { applicationId: cs.applicationId, operation: cs.operation, documentId };
  const call = (method: string, values: string[]) =>
    requestMainWorld(element, guard, { method, values }, signal, safe);
  const componentDeadline = Date.now() + 5000;
  let listed = await call("reactSelectOptions", []);
  if (!listed.ok && listed.reason === "not-react-select" &&
      element.closest(".select__container, .select-shell, .select__control")) {
    // Server-rendered select inputs can precede their component handlers.
    // This exact failure guarantees no component API was invoked, so only
    // these read-only probes may repeat. Never replay an opening or choice.
    while (!listed.ok && listed.reason === "not-react-select" && Date.now() < componentDeadline) {
      if (!safe()) throw new Error("Custom control changed while waiting for its component.");
      await pause(50);
      listed = await call("reactSelectOptions", []);
    }
    if (!listed.ok && listed.reason === "not-react-select")
      throw new Error("Dropdown component was not ready within 5 seconds. Select manually.");
  }
  if (!listed.ok) {
    if (listed.reason === "not-react-select") {
      // This search input is not the selected value. Native click/type
      // fallbacks on Paylocity reset the captured form; an unsupported
      // component must stay manual, not be treated as an ordinary input.
      return element.closest(".pcty-input-select__input") ? "no-match" : "unsupported";
    }
    throw new Error(listed.reason || "Dropdown options could not be read.");
  }
  let pick = choose(JSON.parse(listed.value || "[]"));
  // Long names search poorly; their shorter forms come after them.
  for (const search of [
    ...new Set(
      searches
        .flatMap((term) => [term, ...nameVariants(term)])
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ].slice(0, 5)) {
    if (pick) break;
    listed = await call("reactSelectOptions", [search]);
    if (listed.ok) pick = choose(JSON.parse(listed.value || "[]"));
  }
  // Choosing nothing clears any search text we typed.
  const chosen = await call("reactSelectChoose", pick ? [pick] : []);
  if (!pick) return "no-match";
  if (!chosen.ok)
    throw new Error(
      chosen.reason || "The dropdown did not keep the selection.",
    );
  return "selected";
}
export const reactSelectInput = (element: Element) =>
  element.matches(`input[role="combobox"][aria-autocomplete="list"],.pcty-input-select__input input[aria-autocomplete="list"],${legacyReactSelect}`)
    ? element
    : (element.querySelector(`input[role="combobox"][aria-autocomplete="list"],.pcty-input-select__input input[aria-autocomplete="list"],${legacyReactSelect}`) ??
      element
        .closest(".select__container, .select-shell, .select__control")
        ?.querySelector('input[role="combobox"][aria-autocomplete="list"]') ??
      undefined);

export async function selectCustom(
  command: Command,
  proposal: Proposal,
  record: RecordEntry,
) {
  const element = record.element;
  cs.writing = false; // Never suppress trusted edits while awaiting site options.
  // A link with no address goes nowhere: iCIMS draws every list as an
  // <a role="combobox"> without one, and each job's Country and State were
  // refused as able to navigate.
  // A button with no form to submit that opens the list it names is a
  // list: SmartRecruiters' phone Country code is a <button role="combobox">
  // of no type inside its spl-select's shadow root, where no form reaches,
  // and was refused as able to submit. One in a form,
  // or naming no list in the page, is still refused.
  const formlessList =
    element instanceof HTMLButtonElement &&
    !element.form &&
    element.matches('[role="combobox"][aria-haspopup="listbox"]') &&
    controlledList(element)?.getAttribute("role") === "listbox";
  if (
    (element instanceof HTMLButtonElement && element.type !== "button" && !formlessList) ||
    element.closest("a[href]")
  )
    throw new Error(
      "This custom control could navigate or submit; select it manually.",
    );
  let ownsFocus = false;
  const ashbyLocation = element instanceof HTMLInputElement &&
    element.matches('.ashby-application-form-input-autocomplete[role="combobox"]') &&
    (element.closest('[data-field-path="_systemfield_location"]') ||
      (proposal.source === "confirmed-profile" &&
        ["current location", "where are you located"].includes(normalize(record.label)) &&
        element.closest('.ashby-application-form-field-entry[data-field-path]'))) &&
    proposal.expectedValue === "" ? element : undefined;
  // A combobox that says typing filters its list (aria-autocomplete="list")
  // may hold the answer only behind a search: C3's school list asks its
  // server for what is typed. Searched once, and only after the open list
  // had no exact option. An empty box, or one the site filled in itself and
  // is to be replaced (Higher's address, "22 Mustang Dr").
  let typeahead = !ashbyLocation && element instanceof HTMLInputElement &&
    element.getAttribute("role") === "combobox" &&
    element.getAttribute("aria-autocomplete") === "list" &&
    (element.getAttribute("aria-controls") || ashbyToggle(element)) &&
    (proposal.expectedValue === "" || record.siteValue) ? element : undefined;
  let searchInput: HTMLInputElement | undefined = ashbyLocation;
  let searchValue: string | undefined;
  let searchWritten = false;
  let searchCleared = false;
  const changedReason = (): string | undefined => {
    const invalid = invalidCommandReason(command);
    if (invalid) return invalid;
    if (record.element !== element) return "The field element changed.";
    if (!element.isConnected) return "The field was detached from the page.";
    if (!writable(element)) return "The field is no longer writable.";
    if (fieldLabel(element) !== record.label) return "The field label changed.";
    if (record.protected) return "The field is protected from automatic changes.";
    if (record.revision !== proposal.revision) return "The field revision changed since inspection.";
    if (valueOf(element) !== proposal.expectedValue) return "The field value changed since inspection.";
    if (searchWritten && searchInput?.value !== searchValue) return "The autocomplete search changed during selection.";
  };
  const unsafeReason = () => changedReason() ||
    // Only while the applicant is there: a box that kept the focus of an old
    // click is not in use (Meta's Current location).
    (document.activeElement === element && !ownsFocus && performance.now() - cs.lastApplicantInput < 10_000
      ? "The field has focus outside this selection."
      : undefined);
  const safe = () => !unsafeReason();
  const assertSafe = (message: string) => {
    const reason = unsafeReason();
    if (reason) throw new Error(`${message} ${reason}`);
  };
  assertSafe("Custom control changed before selection.");
  if (reactSelectInput(element) === element) {
    cs.writing = true;
    try {
      record.writePendingAt = performance.now();
      const outcome = await reactSelect(
        element,
        (labels) => pickOption(proposal, labels, (label) => label),
        [proposal.value, ...(proposal.choices || [])],
        safe,
      );
      if (outcome === "selected") {
        if (!valid(command) || record.protected || !element.isConnected)
          throw new Error("Custom selection was superseded.");
        record.last = valueOf(element);
        record.revision++;
        record.automationWritten = true;
        return;
      }
      if (outcome === "no-match")
        throw new Error(
          `No dropdown option matches "${proposal.value}". Choose it manually.`,
        );
    } finally {
      cs.writing = false;
    }
  }
  // A react-select this page's component API did not give up (Pinpoint's
  // State, Country and start lists) opens its menu from the box's focus
  // event after a press on its control. A tab out of view sends no focus
  // event, so a script's mousedown never opened it and nothing was typed.
  // It is driven with real input, as the applicant would: a press on the
  // control, the search typed, the exact option clicked, nothing left open.
  if (element instanceof HTMLInputElement && window === window.top && element.closest(".react-select__control") &&
      !userAttention() && (await fillReactSelectTrusted(command, proposal, record, element, {
        assertSafe, safe, takeFocus: () => { ownsFocus = true; },
      })))
    return;
  // An iCIMS list shows a first page until searched: India was not on it,
  // and a job's Country stayed empty. Its own search box
  // is used, as its site rule does for schools.
  if (element.matches('a[id$="_icimsDropdown"]')) {
    cs.writing = true;
    try {
      record.writePendingAt = performance.now();
      const outcome = await searchSiteList(element, [proposal.value, ...(proposal.choices || [])].filter(Boolean));
      if (outcome === "selected") {
        if (!valid(command) || record.protected || !element.isConnected) throw new Error("Custom selection was superseded.");
        record.last = valueOf(element);
        record.revision++;
        record.automationWritten = true;
        return;
      }
      // Nothing found by searching, or no search box to search with: the
      // list is still picked from as drawn, below.
    } finally {
      cs.writing = false;
    }
  }
  let openingRequested = false;
  // An option of this selection was clicked (its list then closes itself).
  let picked = false;
  let openingInterrupted = false;
  const interruptOpeningFocus = (event: Event) => {
    // Not the keys this fill types itself (a search typed with real keys).
    if (event.isTrusted && !(cs.trustedWrite && event.composedPath().includes(cs.trustedWrite))) {
      openingInterrupted = true;
      ownsFocus = false;
    }
  };
  const acquireOpenedFocus = () => {
    if (openingRequested && !openingInterrupted && !changedReason() &&
      document.activeElement === element) ownsFocus = true;
  };
  const attentionEvents = ["pointerdown", "keydown", "touchstart"];
  element.addEventListener("focus", acquireOpenedFocus);
  for (const type of attentionEvents)
    document.addEventListener(type, interruptOpeningFocus, true);
  // A SuccessFactors picklist can say it is open with no list drawn (one
  // opened and closed earlier, or before a refresh): taken at its word,
  // its list was waited on for 15 s and never came. It is opened as a closed one.
  const staleOpen = () => {
    if (!successFactorsPicklist(element) || element.getAttribute("aria-expanded") !== "true") return false;
    const owned = document.getElementById((element.getAttribute("aria-owns") || "").split(/\s+/)[0]);
    return !owned || !rendered(owned);
  };
  try {
    if (element.getAttribute("aria-expanded") !== "true" || staleOpen()) {
      cs.writing = true;
      try {
        record.writePendingAt = performance.now();
        // React-style selects open on mousedown; do not type search text,
        // press Enter, or activate another tab.
        openingRequested = true;
        const toggle = ashbyLocation ? undefined : ashbyToggle(element);
        // Ashby's dropdowns list their options only from their arrow.
        if (toggle) fillClick(toggle);
        // Clicked, then focused, as its site rule does: a click alone
        // marks it open and loads nothing.
        else if (successFactorsPicklist(element)) {
          fillClick(element);
          element.focus({ preventScroll: true });
        }
        // An iCIMS list opens on a mousedown; a click alone does nothing,
        // and each job's Country waited 5 s on a list never opened.
        else if (element instanceof HTMLInputElement || element.matches('a[id$="_icimsDropdown"]'))
          element.dispatchEvent(
            new MouseEvent("mousedown", {
              bubbles: true,
              button: 0,
              view: window,
            }),
          );
        else {
          // A BambooHR menu still drawn is used as it is: a press would
          // shut it. A closed one stays in the page hidden (display: none on
          // its vessel), and counted as drawn it was never opened (State and
          // Highest Education waited 5 s each and were left).
          if (fabricToggle(element)) {
            if (!fabricOptions(fabricMenu(element)).some(fabricDrawn)) pressFabric(element);
          } else fillClick(element);
        }
        // The opening handler can focus asynchronously. The scoped focus
        // listener attributes that focus only while this command and field
        // remain unchanged and no trusted pointer/key/touch has occurred.
        acquireOpenedFocus();
      } finally {
        cs.writing = false;
      }
    }
    // Some comboboxes list their options when focused, not on a press
    // (C3's own form over Greenhouse). Focus is taken as this selection's
    // own, under the same checks, and released when the selection ends.
    if (element instanceof HTMLInputElement && ripplingSelect(element) && element.getAttribute("aria-expanded") !== "true") {
      assertSafe("Custom selection paused or superseded.");
      cs.writing = true;
      try {
        record.writePendingAt = performance.now();
        fillClick(element);
      } finally {
        cs.writing = false;
      }
    }
    if (
      !ashbyLocation &&
      element instanceof HTMLInputElement &&
      element.getAttribute("role") === "combobox" &&
      element.getAttribute("aria-controls")
    ) {
      await pause(200);
      acquireOpenedFocus();
      assertSafe("Custom selection paused or superseded.");
      // Oracle's lists open from their own arrow button, not a press on
      // the box (one employer's graduation date). A click opens
      // them in a page out of view too, where focus comes with no event.
      const listId = element.getAttribute("aria-controls")!;
      const arrow = element.getAttribute("aria-expanded") !== "true"
        ? [...(element.getRootNode() as Document | ShadowRoot).querySelectorAll<HTMLElement>("button[aria-controls]")]
          .find((button) => button.getAttribute("aria-controls") === listId && button !== element)
        : undefined;
      if (arrow) {
        cs.writing = true;
        try {
          record.writePendingAt = performance.now();
          fillClick(arrow);
        } finally {
          cs.writing = false;
        }
        await pause(200);
        acquireOpenedFocus();
        assertSafe("Custom selection paused or superseded.");
      }
      if (element.getAttribute("aria-expanded") !== "true" && document.activeElement !== element) {
        openingRequested = true;
        element.focus({ preventScroll: true });
        // Its own focus, though a page out of view sends no focus event.
        acquireOpenedFocus();
        assertSafe("Custom selection paused or superseded.");
      }
      // Still closed: a whole click on the box, then the arrow drawn beside
      // it (hidden from assistive tech, naming no list). Microsoft's
      // careers form opens neither on a press nor on focus. Only a list that stayed shut gets these.
      for (const press of [
        () => element,
        () => element.parentElement?.querySelector<HTMLButtonElement>('button[aria-hidden="true"][tabindex="-1"]:not([aria-label*="clear" i])') || undefined,
      ]) {
        await pause(150);
        if (element.getAttribute("aria-expanded") === "true") break;
        const target = press();
        if (!target) continue;
        assertSafe("Custom selection paused or superseded.");
        cs.writing = true;
        try {
          record.writePendingAt = performance.now();
          fillClick(target);
        } finally {
          cs.writing = false;
        }
        acquireOpenedFocus();
      }
    }
    // A SuccessFactors list comes from the site's server, 2.5 to 3 seconds
    // on one employer's: it gets 15.
    const deadline = Date.now() + (successFactorsPicklist(element) ? 15000 : 5000);
    if (ashbyLocation && proposal.value.trim()) {
      assertSafe("Custom selection paused or superseded.");
      openingRequested = true;
      ashbyLocation.focus({ preventScroll: true });
      // Its own focus, though a tab out of view sends no focus event: the
      // applicant's earlier keys then read as theirs here, and Ashby's
      // Location was refused before anything was typed.
      acquireOpenedFocus();
      assertSafe("Custom selection paused or superseded.");
      searchValue = proposal.value.trim();
      ownedAutocompleteSearches.set(ashbyLocation, searchValue);
      cs.writing = true;
      try {
        record.writePendingAt = performance.now();
        const searched = await requestMainWorld(ashbyLocation,
          { applicationId: cs.applicationId, operation: cs.operation, documentId },
          { method: "defaultWithoutBlur", values: [searchValue] }, undefined, safe);
        if (!searched.ok) throw new Error(searched.reason || "The autocomplete search could not be written.");
        searchWritten = true;
        assertSafe("Custom selection paused or superseded.");
      } finally {
        cs.writing = false;
      }
    }
    const searchAfter = Date.now() + 1200;
    // What the list held when the search was typed, and when: the same
    // list just afterwards is still the unsearched one.
    let unsearched = "";
    let searchedAt = 0;
    const canSearch = () => Boolean(typeahead && !searchWritten && proposal.value.trim() &&
      document.activeElement === typeahead && ownsFocus);
    const search = async (listed: string) => {
      searchInput = typeahead!;
      searchValue = proposal.value.trim();
      ownedAutocompleteSearches.set(typeahead!, searchValue);
      cs.writing = true;
      try {
        record.writePendingAt = performance.now();
        // Oracle's lists (cx-select) take a search only from keys: an
        // assigned value is read back empty and the list stays unloaded
        // (Higher's School). Typed with real keys, the box kept
        // focused for the pick; assigned only where keys cannot be sent.
        const typed = typeahead!.matches("input.cx-select-input") &&
          await typeTrusted(command, typeahead!, searchValue, safe, new AbortController().signal, true, false, true);
        assertSafe("Custom selection paused or superseded.");
        if (!typed) {
          const searched = await requestMainWorld(typeahead!,
            { applicationId: cs.applicationId, operation: cs.operation, documentId },
            { method: "defaultWithoutBlur", values: [searchValue] }, undefined, safe);
          if (!searched.ok) throw new Error(searched.reason || "The autocomplete search could not be written.");
        }
        searchWritten = true;
        unsearched = listed;
        searchedAt = Date.now();
        assertSafe("Custom selection paused or superseded.");
      } finally {
        cs.writing = false;
      }
    };
    while (Date.now() < deadline) {
      acquireOpenedFocus();
      assertSafe("Custom selection paused or superseded.");
      // A list that never showed anything may also only answer a search.
      if (canSearch() && Date.now() > searchAfter) await search("");
      const root = element.getRootNode() as Document | ShadowRoot;
      const listId =
        element.getAttribute("aria-controls") ||
        element.getAttribute("aria-owns");
      // A list button that names no list (Workday's) has the one list open
      // on the page; while another question's list is still closing, two
      // are, and neither is taken.
      const openLists = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(rendered);
      // iCIMS' lists name none: theirs is in the "_ctnr" box drawn beside
      // the link (each job's Country on one employer's form).
      const icimsList = () => element.matches('a[id$="_icimsDropdown"]')
        ? document.getElementById(`${element.id}_ctnr`)?.querySelector<HTMLElement>('[role="listbox"]') || null
        : null;
      // ADP's list is drawn in the shadow roots of the select around its button.
      const wfnList = () => {
        const visit = (scope: ShadowRoot | null, depth: number): HTMLElement | null => {
          if (!scope || depth > 3) return null;
          const own = [...scope.querySelectorAll<HTMLElement>('[role="listbox"]')].find(rendered);
          if (own) return own;
          for (const node of scope.querySelectorAll("*")) {
            const found = visit(node.shadowRoot, depth + 1);
            if (found) return found;
          }
          return null;
        };
        // A portal-enabled list is drawn in a portal in the page itself.
        return visit(element.getRootNode() as ShadowRoot, 0) ||
          [...document.querySelectorAll<HTMLElement>('sdf-floating-pane-portal [role="listbox"]')].find(rendered) || null;
      };
      const list =
        wfnDropdown(element)
          ? wfnList()
          : fabricToggle(element)
          ? fabricMenu(element)
          : listId && !/\s/.test(listId)
          ? root.querySelector(`#${CSS.escape(listId)}`) || controlledList(element)
          : listButton(element) && openLists().length === 1 ? openLists()[0] : icimsList();
      if (
        list &&
        (fabricToggle(element) ? fabricDrawn(list) : rendered(list)) &&
        element.getAttribute("aria-expanded") === "true" &&
        list.getAttribute("aria-busy") !== "true"
      ) {
        // Oracle's lists are grids of one cell per choice (one employer's
        // graduation date).
        const grid = list.matches('[role="grid"]') || element.getAttribute("aria-haspopup") === "grid";
        const roled = fabricToggle(element)
          ? fabricOptions(list)
          : [...list.querySelectorAll<HTMLElement>(grid ? '[role="option"],[role="gridcell"]' : '[role="option"]')];
        const shadowed = roled.length ? [] : shadowedOptions(list);
        const options = (roled.length ? roled : shadowed).filter(
          (o) => (fabricToggle(element) ? fabricDrawn(o) : rendered(o)) && o.getAttribute("aria-disabled") !== "true" && (!shadowed.length || deepOption(o)?.getAttribute("aria-disabled") !== "true"),
        );
        // An Ashby school result is a name with its country and web domain
        // beside it; the name alone is the option.
        const optionText = (o: HTMLElement) => {
          const names = o.querySelectorAll('[class*="canonicalSchoolResultName_"]');
          return (names.length === 1 ? names[0].textContent : o.textContent) || "";
        };
        // A list showing only its placeholder is still loading: Workday
        // opens with "Select One" and adds its answers a moment later, and
        // a pick read at once found nothing.
        if (options.length && options.every((o) => /^\s*(select one|select|select\.\.\.|choose one|please select|no selection)\s*$/i.test(optionText(o)))) {
          await pause(50);
          continue;
        }
        // "Select "Other" if it is not in list": the question's own rule,
        // for an answer the list does not hold; its follow-up asks for the
        // name (one employer's school).
        const otherAsked = /\bselect\s*["“']?other["”']?\s*if\b[^.?]*\bnot\b[^.?]*\blist/i.test(record.label);
        const option = pickOption(proposal, options, optionText) ||
          (otherAsked ? options.find((candidate) => /^other\b/i.test(optionText(candidate).trim())) : undefined);
        if (option) {
          const expected = optionText(option);
          // An option component (SmartRecruiters' spl-select-option)
          // ignores a script's click, as its location menu did: the box is
          // focused and real Down keys reach the option, then Enter takes it
          // (one employer's screening lists).
          // Microsoft's careers lists: a click on an option only lights it
          // (aria-activedescendant), the list stays open and nothing is
          // kept, and the applicant's next click on the box emptied it
          //. Real Down keys until the box names the option as
          // its active one, then Enter, as the applicant would.
          if (!shadowed.length && element.matches('input[class*="select-module_select-input"]') && option.id && !userAttention()) {
            const keys = new AbortController();
            const allowed = () => !changedReason() && !userAttention();
            const active = () => element.getAttribute("aria-activedescendant") || "";
            const at = (id: string) => options.findIndex((candidate) => candidate.id === id);
            // A Down can move focus out of the box onto the option itself:
            // the page focuses it a moment after the key, and the next key
            // (the Enter that takes it) lands on the option. Held to the
            // box alone, that Enter was stopped as a stray key and work
            // authorization stayed empty (Microsoft's careers form). The keys are this write's anywhere in its list
            // too: the box's wrapper where it holds the list, else the
            // list while focus is in it.
            const list = () => document.getElementById(option.id)?.closest('[role="listbox"]') || option.closest('[role="listbox"]');
            let holder: Element | null = element.parentElement;
            while (holder && holder !== document.body && !holder.contains(list())) holder = holder.parentElement;
            const keysTo = (): Element => {
              const shown = list();
              if (holder && holder !== document.body && shown && holder.contains(shown)) return holder;
              return shown && shown.contains(document.activeElement) ? shown : element;
            };
            // The page moves focus some 300 ms after the key: the light is
            // read once it has moved, or the next Down went past the option.
            const settle = async (before: string) => {
              for (let waited = 0; waited < 600 && active() === before; waited += 60) await pause(60);
            };
            cs.writing = true;
            cs.trustedWrite = keysTo();
            try {
              record.writePendingAt = performance.now();
              openingRequested = true;
              (element as HTMLElement).focus({ preventScroll: true });
              acquireOpenedFocus();
              const target = at(option.id);
              for (let steps = 0; steps <= options.length + 1 && active() !== option.id && allowed(); steps++) {
                const before = active();
                cs.trustedWrite = keysTo();
                await requestTrustedType(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, keys.signal, allowed, false, at(before) > target ? -1 : 1, true);
                await pause(120);
                await settle(before);
              }
              cs.trustedWrite = keysTo();
              if (active() === option.id)
                await requestTrustedType(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, keys.signal, allowed, true, 0);
              else if (window === window.top && allowed()) {
                // Down moved nothing on the live list: a real click on the
                // option, as the applicant would. The list is
                // drawn again as it opens: the option shown now is clicked.
                const shown = (document.getElementById(option.id) as HTMLElement | null) || option;
                shown.scrollIntoView({ block: "nearest" });
                await pause(100);
                const box = shown.getBoundingClientRect();
                if (!box.width || !box.height) throw new Error("The dropdown did not highlight the option. Choose it manually.");
                // Its list is drawn elsewhere on the page: the click there is
                // this write's, not the applicant's.
                cs.trustedWrite = shown.closest('[role="listbox"]') || shown.parentElement || element;
                await requestTrustedType(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, keys.signal, allowed, false, 0, false,
                  { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
              } else throw new Error("The dropdown did not highlight the option. Choose it manually.");
              picked = true;
            } finally {
              cs.trustedWrite = undefined;
              cs.writing = false;
            }
            for (let waited = 0; waited < 1500 && normalize(valueOf(element)) !== normalize(expected); waited += 100) await pause(100);
            if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
            if (!valid(command) || record.protected || !element.isConnected) throw new Error("Custom selection was superseded.");
            if (normalize(valueOf(element)) !== normalize(expected)) throw new Error("The dropdown did not confirm the exact selection. Verify it manually.");
            record.last = valueOf(element);
            record.revision++;
            record.automationWritten = true;
            return;
          }
          if (shadowed.length) {
            const position = shadowed.indexOf(option) + 1;
            let component: Element = element;
            for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++) {
              component = host;
              if (host.matches("spl-autocomplete,spl-multiselect-autocomplete,[role='combobox']")) break;
            }
            assertSafe("Custom selection paused or superseded.");
            if (userAttention()) throw new Error("The applicant is using the page; choose it manually.");
            const keys = new AbortController();
            cs.writing = true;
            cs.trustedWrite = component;
            try {
              record.writePendingAt = performance.now();
              openingRequested = true;
              (element as HTMLElement).focus({ preventScroll: true });
              acquireOpenedFocus();
              // One Down at a time, reading which entry is lit, and Enter
              // once it is the one: one employer's lists open with their first
              // entry lit, so a count of Downs from the box overshot by one
              // (Graduation Year 2028 for 2027).
              const lit = () => shadowed.findIndex((candidate) => {
                const inner = deepOption(candidate);
                return Boolean(inner && (inner.classList.contains("active") || (inner.getRootNode() as ShadowRoot).activeElement === inner));
              });
              const allowed = () => !changedReason() && !userAttention();
              const target = position - 1;
              // Already chosen: Enter on it would take it away again.
              const already = () => splChosen(element).includes(shadowed[target].getAttribute("value") || "\u0000") ||
                deepOption(shadowed[target])?.getAttribute("aria-selected") === "true";
              if (already()) {
                if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
                record.last = valueOf(element);
                record.automationWritten = true;
                return;
              }
              const step = (count: number) => requestTrustedType(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, keys.signal, allowed, false, count, true).then(() => pause(80));
              let moved = false;
              for (let steps = 0; steps <= shadowed.length && lit() !== target; steps++) {
                if (lit() > target) break;
                // A menu that let a Down pass lets them all: on to the click.
                if (moved && lit() < 0) break;
                await step(1);
                moved = true;
              }
              // The entry lit as the list opened was never reached by a key:
              // an Enter then took nothing, in the box (it closed a
              // multiselect) or on the entry focused by a script (the list
              // kept its own place), and one employer's "Not Applicable", first
              // in its lists, stayed empty.
              // Down and back Up reach it as the applicant would.
              if (!moved && lit() === target && shadowed.length > 1) {
                await step(1);
                await step(-1);
              }
              if (lit() === target)
                await requestTrustedType(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, keys.signal, allowed, true, 0);
              else {
                // Down lit nothing (one employer's screening Gender and Race): a real click on the entry instead.
                const entry = deepOption(shadowed[target]) || shadowed[target];
                entry.scrollIntoView({ block: "nearest" });
                await pause(100);
                const box = entry.getBoundingClientRect();
                if (window !== window.top || !box.width || !box.height || !allowed())
                  throw new Error("The dropdown did not highlight the option. Choose it manually.");
                await requestTrustedType(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, keys.signal, allowed, false, 0, false,
                  { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
              }
              picked = true;
            } catch (error) {
              // Never left open: a list the pick could not finish is closed.
              if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
              throw error;
            } finally {
              cs.trustedWrite = undefined;
              cs.writing = false;
            }
            const chosenValue = option.getAttribute("value");
            const chosen = () => Boolean(chosenValue && splChosen(element).includes(chosenValue)) || [valueOf(element), picksOf(element), component.getAttribute("value") || "",
              // A multiselect shows each pick as a tag named by its label
              // attribute (SmartRecruiters' spl-tag), in its shadow root.
              // (in spl-tags-list's own shadow root, a level further in).
              ...(() => {
                const all: Element[] = [];
                const visit = (root: ParentNode, depth: number) => {
                  for (const node of root.querySelectorAll("*")) {
                    all.push(node);
                    if (node.shadowRoot && depth < 4) visit(node.shadowRoot, depth + 1);
                  }
                };
                visit(component, 0);
                if (component.shadowRoot) visit(component.shadowRoot, 1);
                return all;
              })()
                .filter((node) => /tag|chip|pill/i.test(node.tagName + " " + (node.getAttribute("class") || "")))
                .map((node) => `${node.getAttribute("label") || ""} ${node.textContent || ""}`)]
              .some((text) => normalize(text).includes(normalize(expected)));
            for (let waited = 0; waited < 1500 && !chosen(); waited += 100) await pause(100);
            if (!valid(command) || record.protected || !element.isConnected)
              throw new Error("Custom selection was superseded.");
            if (!chosen()) {
              if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
              throw new Error("The dropdown did not confirm the exact selection. Verify it manually.");
            }
            // A list that stays open for more picks is closed.
            if (element.getAttribute("aria-expanded") === "true") (element as HTMLElement).blur();
            record.last = valueOf(element);
            record.revision++;
            record.automationWritten = true;
            return;
          }
          // An option drawn as a plain button (type="button", so it can
          // never submit) is still just the option.
          const plainButton = option.matches('button[type="button"]') && !option.parentElement?.closest("a,button,input");
          // A SuccessFactors option is its one menu item link.
          const menuItem = successFactorsPicklist(element) && option.querySelectorAll("a,button,input").length === 1
            ? option.querySelector<HTMLAnchorElement>(':scope > a[role="menuitem"]')
            : null;
          if (
            (!plainButton && option.closest("a,button,input")) ||
            (!menuItem && option.querySelector("a,button,input"))
          )
            throw new Error(
              "Dropdown option contains an action control; choose manually.",
            );
          // All revision/value/connection checks are synchronous immediately
          // before this one click. No click is retried after dispatch.
          assertSafe("Custom selection paused or superseded.");
          if (!option.isConnected || !list.contains(option))
            throw new Error("Custom selection paused or superseded. The option was detached or left its menu.");
          cs.writing = true;
          try {
            record.writePendingAt = performance.now();
            fillClick(menuItem || option);
            picked = true;
            // A SuccessFactors list still loading its next page when the
            // pick was made opens itself again once the page arrives (a
            // Country list of 100, an employer): it is
            // waited for and closed.
            if (successFactorsPicklist(element)) {
              const listId = element.getAttribute("aria-owns") || "";
              for (let waited = 0; waited < 900; waited += 150) {
                await pause(150);
                const reopened = listId ? document.getElementById(listId) : null;
                if ((reopened && rendered(reopened)) || element.getAttribute("aria-expanded") === "true")
                  closeSuccessFactorsList(element);
              }
            }
            if (searchInput) {
              await pause(0);
              ownedAutocompleteSearches.delete(searchInput);
              searchValue = undefined;
              searchWritten = false;
            }
            // Ashby closes its list and shows the choice a moment after the click.
            if (ashbyToggle(element) || ripplingSelect(element))
              for (let waited = 0; waited < 600 && element.getAttribute("aria-expanded") === "true"; waited += 30)
                await pause(30);
          } finally {
            cs.writing = false;
          }
          if (!valid(command) || record.protected || !element.isConnected)
            throw new Error("Custom selection was superseded.");
          // Oracle's lists keep only the first part of the entry they take:
          // "100 EAST MILL WAY" for "100 EAST MILL WAY, FLAGSTAFF,
          // ARIZONA", "+1" for "+1 (United States)".
          const keptWhole = normalize(valueOf(element)) === normalize(expected) ||
            (element.matches("input.cx-select-input") && Boolean(valueOf(element).trim()) &&
              normalize(valueOf(element)) === normalize(expected.split(/[,(]/)[0])) ||
            // A multiselect keeps its box empty and shows the pick as a tag.
            (element.matches("input.cx-multi-select-input") && picksOf(element).split("; ").some((pick) => normalize(pick) === normalize(expected)));
          if (!keptWhole ||
            (ashbyLocation && element.getAttribute("aria-expanded") === "true"))
            throw new Error(
              "The dropdown did not confirm the exact selection. Verify it manually.",
            );
          // The widget already dispatched its own change events. Replaying
          // input/change on its search box can clear a confirmed selection.
          record.last = valueOf(element);
          record.revision++;
          record.automationWritten = true;
          return;
        }
        const listed = options.map((o) => o.textContent || "").join("\n");
        // A list button that opens a popover with its own search box and
        // moves focus into it: Meta's Current location lists its offices
        // first and any other city only once searched. The box this opening focused is searched as a
        // typeahead's own.
        if (!typeahead && !ashbyLocation && options.length && element instanceof HTMLButtonElement &&
            element.getAttribute("role") === "combobox" && openingRequested && !openingInterrupted) {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active !== element && /^(text|search)$/.test(active.type) &&
              list.contains(active) && rendered(active) && !active.value) {
            typeahead = active;
            ownsFocus = true;
          }
        }
        if (options.length && canSearch()) {
          await search(listed);
          continue;
        }
        // A search that left "No results were found." (Oracle's Desired
        // Salary Range lists ranges, and "$100,000" is in none of their
        // words): the text is taken out again, and the whole
        // list is read and chosen from by what each entry covers.
        if (!options.length && typeahead && searchWritten && !searchCleared && Date.now() - searchedAt > 1200 &&
            list.querySelector('[class*="no-results"]')) {
          searchCleared = true;
          cs.writing = true;
          try {
            record.writePendingAt = performance.now();
            const cleared = await requestMainWorld(typeahead,
              { applicationId: cs.applicationId, operation: cs.operation, documentId },
              { method: "defaultWithoutBlur", values: [""] }, undefined, safe);
            if (!cleared.ok) throw new Error(cleared.reason || "The autocomplete search could not be cleared.");
            searchValue = "";
            ownedAutocompleteSearches.set(typeahead, "");
            assertSafe("Custom selection paused or superseded.");
          } finally {
            cs.writing = false;
          }
          continue;
        }
        if (options.length && !(typeahead && searchWritten && listed === unsearched && Date.now() - searchedAt < 2500))
          throw new Error(
            "No exact dropdown option. Search or select manually.",
          );
      }
      await pause(50);
    }
    // Whether the street was ever typed, and if not, why: Higher's address
    // box was clicked and then failed five seconds later with no search in
    // its trace.
    const searchNote = !typeahead
      ? " (no search box found)"
      : searchWritten
        ? ""
        : ` (the search was never typed: focus was on ${document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? `#${document.activeElement.id}` : ""}` : "nothing"}${ownsFocus ? "" : ", and the fill did not hold focus"})`;
    throw new Error(
      `Dropdown options were not available within ${successFactorsPicklist(element) ? 15 : 5} seconds${searchNote}. Search or select manually.`,
    );
  } finally {
    if (searchInput && searchValue !== undefined) {
      // Clear only our unchanged query, never an applicant edit. A failed
      // search must not leave city text pretending to be a selected option.
      if (safe()) {
        cs.writing = true;
        try {
          await requestMainWorld(searchInput,
            { applicationId: cs.applicationId, operation: cs.operation, documentId },
            { method: "defaultWithoutBlur", values: [""] }, undefined, safe);
        } catch {
          // A newly paused/stale command cannot clean up by writing.
        }
      }
      ownedAutocompleteSearches.delete(searchInput);
    }
    // A SuccessFactors picklist this selection opened stays over the form
    // when nothing in it was picked (no option matched, or none came): its
    // own Escape and a press elsewhere close it (one employer's profile, lists stacked open after a fill).
    // Its page may still arrive after that (2.5 to 3 seconds on one employer's
    // server) and open it again; it is watched for a moment and closed
    // again (lists left open over the form).
    if (successFactorsPicklist(element) && openingRequested && !picked && !openingInterrupted && element.isConnected) {
      const listId = element.getAttribute("aria-owns") || "";
      for (let waited = 0; waited <= 3000; waited += 250) {
        const shown = listId ? document.getElementById(listId) : null;
        if (element.getAttribute("aria-expanded") === "true" || (shown && rendered(shown)))
          closeSuccessFactorsList(element);
        if (waited < 3000) await pause(250);
      }
    }
    // An Ashby list left open hides every other question from assistive
    // technology (aria-hidden), and so from the next inspection. Close the
    // one this selection opened, from its own arrow, when nothing was chosen.
    const arrow = ashbyToggle(element);
    if (arrow && openingRequested && !openingInterrupted && valid(command) && element.isConnected &&
        element.getAttribute("aria-expanded") === "true" && !(element as HTMLInputElement).value) {
      cs.writing = true;
      fillClick(arrow);
      // The arrow hands focus to the input, sometimes a moment later.
      await pause(150);
      if (!openingInterrupted && document.activeElement === element) ownsFocus = true;
    }
    if (ripplingSelect(element) && openingRequested && !openingInterrupted && valid(command) && element.isConnected &&
        element.getAttribute("aria-expanded") === "true") pressOutside();
    // An Oracle list this selection opened and picked nothing from is
    // closed, not left over the form (Country code, Address Line 1 and
    // Desired Salary Range): a press on the
    // page, as the applicant's own click elsewhere, takes it away.
    if (element.matches("input.cx-select-input") && openingRequested && !picked && !openingInterrupted && valid(command) && element.isConnected &&
        element.getAttribute("aria-expanded") === "true") {
      pressOutside();
      element.blur();
    }
    // A Workday list this selection opened and picked nothing from is
    // closed, not left over the form: its own Escape, then a press on the
    // page as the site's rules make (one employer's Phone Device Type, with no exact option to pick).
    if (listButton(element) && openingRequested && !picked && !openingInterrupted && valid(command) && element.isConnected) {
      const shownLists = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(rendered);
      if (shownLists().length) {
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        await pause(150);
      }
      if (shownLists().length) {
        cs.writing = true;
        fillClick(document.querySelector<HTMLElement>('[data-automation-id="mainContent"]') || document.body);
        await pause(150);
      }
    }
    cs.writing = false;
    element.removeEventListener("focus", acquireOpenedFocus);
    for (const type of attentionEvents)
      document.removeEventListener(type, interruptOpeningFocus, true);
    // Only release focus this selection took; never focus the user moved.
    if (ownsFocus && document.activeElement === element) element.blur();
  }
}
// Checks a native checkbox or radio with a click, as a person does: React
// forms keep their own state and learn of a choice only from its click.
// Workday leaves an assigned "checked" in place while its own state stays
// empty (the box shows selected, the form reports it unanswered), and
// Ashby puts it back. A page that ignores the click gets the assignment.
// The click's trusted input/change are claimed as the engine's so they
// aren't taken for the applicant's edit.
// A box ticked or cleared with a real click, as the applicant would: a
// script's click changed Greenhouse's box on screen but not its own
// state, which drew "U.S. citizen" ticked again.
// A script's click where real ones cannot be made (an embedded frame, no
// debugger permission).
export async function clickBox(control: HTMLInputElement, checked: boolean, command: Command): Promise<boolean> {
  if (control.checked === checked) return true;
  if (window === window.top) {
    const target = (control.getClientRects().length ? control : control.labels?.[0]) as HTMLElement | undefined;
    target?.scrollIntoView({ block: "nearest" });
    await pause(80);
    let box = target?.getBoundingClientRect();
    const wrapper = control.closest(".checkbox__wrapper,label,li,div") || control;
    // A sticky header or a cookie banner over the box's centre (Lever's)
    // would take the real click: its pointer events, outside the fill's
    // own write, read as the applicant's and paused the fill. The box is
    // scrolled toward the middle of the view and tested once more; still
    // covered, the real click is skipped for a script's.
    const covered = (rect: DOMRect) => {
      const root = control.getRootNode() as Document | ShadowRoot;
      const hit = (root || document).elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      return !(hit && (hit === control || control.contains(hit) || control.labels?.[0]?.contains(hit) || wrapper.contains(hit)));
    };
    if (target && box && box.width > 0 && box.height > 0 && covered(box)) {
      target.scrollIntoView({ block: "center" });
      await pause(80);
      box = target.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && covered(box)) box = undefined;
    }
    if (box && box.width > 0 && box.height > 0) {
      cs.trustedWrite = wrapper;
      // The click is the fill's own at this point, whoever last touched the
      // page: an applicant's click moments before (or a text box of theirs
      // still in use) made the guard read it, and the input and change it
      // causes, as theirs, and paused the fill on its own click.
      const point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      const click = (cs.ownClickAt = { ...point, target: wrapper, until: Infinity, missed: false });
      expectOwnedActivation(control, "click");
      try {
        await requestTrustedType(control, { applicationId: cs.applicationId, operation: cs.operation, documentId }, "", 0, undefined, () => valid(command), false, 0, false, point);
      } catch {
        // Falls back to a script's click below.
      } finally {
        click.until = performance.now() + 400;
        cs.trustedWrite = undefined;
      }
      await pause(120);
      if (control.checked === checked) return true;
    }
  }
  return checkControl(control, checked);
}
export async function checkControl(control: HTMLInputElement, checked: boolean): Promise<boolean> {
  if (control.checked === checked) return true;
  expectOwnedActivation(control, "click");
  fillClick(control);
  await pause(0);
  if (control.checked === checked) return true;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!.set!.call(control, checked);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  await pause(0);
  return control.checked === checked;
}
export async function listedPosition(element: Element, values: string[], signal: AbortSignal): Promise<number> {
  const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = values.map(plain).filter(Boolean);
  const options = () => menuEntries(element);
  // An entry drawn in its option component's shadow root shows the label
  // slotted into that component: the text is the component's.
  const label = (option: Element) => {
    let node: Element | undefined = option;
    for (let depth = 0; node && depth < 3; depth++) {
      const text = (node.textContent || "").trim();
      if (text) return text;
      node = ((node.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
    }
    return "";
  };
  // The list for the text as finally typed, not an earlier one: a site
  // that searches on a debounce answers the first letters' query while the
  // keys are still going and the whole text's a second or so after them.
  // Down and Enter on the early list were lost when the late answer
  // replaced it, and the box dropped what was typed (Tailspin's SmartRecruiters
  // City, Title and Institution). The menu is
  // waited on until it has been quiet for 0.6 s, and for at least
  // 1.5 s after the typing.
  const signature = () => options().map(label).join("|");
  const began = performance.now();
  let seen = signature();
  let changed = began;
  while (!signal.aborted && performance.now() - began < 4_000 && (performance.now() - began < 1_500 || performance.now() - changed < 600)) {
    await pause(100);
    const now = signature();
    if (now !== seen) {
      seen = now;
      changed = performance.now();
    }
  }
  for (let waited = 0; waited < 2_500 && !signal.aborted; waited += 150) {
    const listed = options();
    const names = listed.map((option) => (/\bmanual/i.test(label(option)) ? "" : plain(label(option))));
    let index = names.findIndex((name) => name && wanted.includes(name));
    if (index < 0) index = names.findIndex((name) => name && wanted.some((value) => name.startsWith(`${value},`) || name.startsWith(`${value} (`)));
    if (index >= 0) return index + 1;
    if (listed.length && names.some(Boolean)) return 0;
    await pause(150);
  }
  return 0;
}

// Opens, searches and picks from a react-select with real mouse and key
// input (see the call). Returns false, having sent nothing, when real input
// cannot be sent; throws when the list holds no exact option or the pick
// was not kept. The menu it opened is closed and the search it typed taken
// out again.
export async function fillReactSelectTrusted(
  command: Command,
  proposal: Proposal,
  record: RecordEntry,
  input: HTMLInputElement,
  own: { safe: () => boolean; assertSafe: (message: string) => void; takeFocus: () => void },
): Promise<boolean> {
  const control = input.closest<HTMLElement>(".react-select__control")!;
  const prefix = "react-select";
  const root = control.parentElement!;
  const guard = { applicationId: cs.applicationId, operation: cs.operation, documentId };
  const terms = [...new Set([proposal.value, ...(proposal.choices || [])]
    .flatMap((term) => [term, ...nameVariants(term)]).map((term) => term.trim()).filter(Boolean))].slice(0, 5);
  if (!terms.length) return false;
  let interrupted = false;
  const interrupt = (event: Event) => {
    if (event.isTrusted && !(cs.trustedWrite && event.composedPath().includes(cs.trustedWrite))) interrupted = true;
  };
  const attention = ["pointerdown", "keydown", "touchstart"];
  for (const type of attention) document.addEventListener(type, interrupt, true);
  const allowed = () => valid(command) && !interrupted && !userAttention() && own.safe() && input.isConnected;
  const menu = () => [...root.querySelectorAll<HTMLElement>(`.${prefix}__menu`)].find(rendered);
  const optionsOf = () => [...(menu()?.querySelectorAll<HTMLElement>(`.${prefix}__option`) || [])].filter(rendered);
  const label = (option: HTMLElement) => (option.textContent || "").replace(/\s+/g, " ").trim();
  const shown = () => root.querySelector(`.${prefix}__single-value`)?.textContent?.replace(/\s+/g, " ").trim() || "";
  const point = (target: HTMLElement, fraction = 0.5) => {
    target.scrollIntoView({ block: "nearest" });
    const box = target.getBoundingClientRect();
    return box.width > 0 && box.height > 0
      ? { x: Math.round(box.left + box.width * fraction), y: Math.round(box.top + box.height / 2) }
      : undefined;
  };
  const send = async (within: Element, text: string, clear: number, at?: { x: number; y: number }) => {
    if (!allowed()) throw new Error("Custom selection paused or superseded.");
    cs.trustedWrite = within;
    record.writePendingAt = performance.now();
    try {
      await requestTrustedType(input, guard, text, clear, undefined, allowed, false, 0, false, at);
    } finally {
      cs.trustedWrite = undefined;
    }
  };
  const closeMenu = async () => {
    if (!menu() || !input.isConnected || !valid(command)) return;
    if (document.activeElement === input) input.blur();
    await pause(150);
    // A tab out of view sends no blur event: a real press on the control's
    // own arrow (not its search box) closes an open menu.
    const arrow = menu() && !userAttention() && !interrupted ? point(control, 0.97) : undefined;
    if (arrow) await send(root, "", 0, arrow).catch(() => undefined);
    await pause(150);
  };
  const takeOutSearch = async () => {
    if (!input.value || !allowed()) return;
    input.select();
    await send(root, "", 1).catch(() => undefined);
    await pause(100);
  };
  let pickedLabel = "";
  try {
    own.assertSafe("Custom control changed before selection.");
    const opening = point(control, 0.5);
    if (!opening) return false;
    try {
      await send(root, "", 0, opening);
    } catch (error) {
      if (!valid(command)) throw error;
      return false;
    }
    // The press focused the box and opened the menu: the focus is this
    // selection's own.
    if (!interrupted && document.activeElement === input) own.takeFocus();
    const wait = async (settled: () => boolean, ms: number) => {
      for (let waited = 0; waited < ms && !settled(); waited += 100) {
        await pause(100);
        if (!allowed()) throw new Error("Custom selection paused or superseded.");
      }
    };
    await wait(() => Boolean(menu()), 2000);
    if (!menu()) throw new Error("Dropdown options were not available within 2 seconds of a real press on the control. Search or select manually.");
    const choose = () => {
      const options = optionsOf();
      return options.length ? pickOption(proposal, options, label) : undefined;
    };
    await wait(() => optionsOf().length > 0 || Boolean(menu()?.textContent?.trim()), 1500);
    let option = choose();
    for (const term of terms) {
      if (option) break;
      if (input.value) input.select();
      ownedAutocompleteSearches.set(input, term);
      await send(root, term, 0);
      // Its answer comes a moment after the keys: the list the term gave,
      // or its "No options" notice.
      await pause(250);
      await wait(() => Boolean(choose()) || (!optionsOf().length && /no options/i.test(menu()?.textContent || "")), 1500);
      option = choose();
    }
    own.assertSafe("Custom selection paused or superseded.");
    if (!option) throw new Error(`No exact dropdown option for "${proposal.value}". Search or select manually.`);
    pickedLabel = label(option);
    await pause(80);
    // The option shown now, at its point: the list moves as it filters.
    const current = optionsOf().find((candidate) => label(candidate) === pickedLabel);
    const at = current ? point(current) : undefined;
    if (!current || !at) throw new Error("The dropdown option moved before it was picked. Choose it manually.");
    await send(current.closest<HTMLElement>(`.${prefix}__menu`) || current, "", 0, at);
    await wait(() => shown() === pickedLabel || !menu(), 1500);
    await pause(150);
    if (!valid(command) || record.protected || !input.isConnected) throw new Error("Custom selection was superseded.");
    if (shown() !== pickedLabel)
      throw new Error("The dropdown did not confirm the exact selection. Verify it manually.");
    record.last = valueOf(input);
    record.revision++;
    record.automationWritten = true;
    return true;
  } finally {
    for (const type of attention) document.removeEventListener(type, interrupt, true);
    cs.trustedWrite = undefined;
    if (valid(command) && input.isConnected) {
      // Never left open, and no query left behind.
      if (!interrupted && !userAttention() && shown() !== pickedLabel) await takeOutSearch();
      ownedAutocompleteSearches.delete(input);
      if (!interrupted && !userAttention()) await closeMenu();
    } else ownedAutocompleteSearches.delete(input);
  }
}

export async function typeTrusted(
  command: Command,
  element: Element,
  text: string,
  safe: () => boolean,
  signal: AbortSignal,
  retry = true,
  enter = false,
  choose = false,
  insert = false,
): Promise<boolean> {
  // A click of the applicant's moments ago (Save and Continue, which loads
  // the step this fill is for) holds keys back for its few seconds only:
  // they are waited out, and one employer's signing date, refused at once, was
  // left empty. One in a field of theirs still refuses.
  if (text && userAttention() && !cs.applicantControl?.isConnected)
    for (let waited = 0; userAttention() && !cs.applicantControl?.isConnected && waited < attentionSpan + 500 && !signal.aborted; waited += 150)
      await pause(150);
  if (!text || userAttention()) return false;
  const focusable = element as HTMLElement;
  if (typeof focusable.focus !== "function") return false;
  const focused = () =>
    (element.getRootNode() as Document | ShadowRoot).activeElement ===
    element;
  focusable.focus();
  // Some sites move focus on their own a moment later (Workday sends an
  // empty date's Year back to Month). Keys follow focus, so a field that
  // lost it is never typed into.
  await pause(150);
  if (!focused() || !safe()) return false;
  cs.trustedWrite = element;
  cs.misdirected = false;
  // A longer value than the Backspaces would reach is selected, and the
  // keys typed replace it: sixteen Backspaces left the start of an earlier
  // address in front of the new one (Microsoft).
  const held = ((element as HTMLInputElement).value || "").length;
  const selectAll = held > 16 && element instanceof HTMLInputElement && /^(text|search|email|tel|url)$/.test(element.type);
  if (selectAll) (element as HTMLInputElement).select();
  try {
    const result = await requestTrustedType(
      element,
      { applicationId: cs.applicationId, operation: cs.operation, documentId },
      text,
      // Only what this field actually holds: one Backspace too many
      // steps into the neighbouring date section and clears that. A
      // Workday date section empties on a single Backspace, and its "2005"
      // took two: the second sent focus back to the Day, and the year was
      // never typed.
      selectAll ? 0 : element.matches('input[role="spinbutton"][data-automation-id^="dateSection"]') ? Math.min(1, held) : Math.min(16, held),
      signal,
      () => safe() && !userAttention() && focused(),
      enter,
      false,
      false,
      undefined,
      insert,
    );
    if (!result.ok) return false;
  } catch (error) {
    if (!valid(command)) throw error;
    return false;
  } finally {
    // Workday commits a date section when focus leaves it, and that blur
    // fires a trusted change event of our own making, so the exemption
    // has to outlive it.
    // A search box keeps focus: its results list closes when it blurs,
    // and the pick that follows is made from that list.
    if (!enter && !choose && !userAttention() && focused()) focusable.blur();
    if (enter || choose) cs.searchSettle = { element, until: performance.now() + 4000 };
    cs.trustedWrite = undefined;
  }
  // The page has focus now, so where it settles after focusing the field
  // again is what the check before typing sees.
  if (cs.misdirected)
    return retry && typeTrusted(command, element, text, safe, signal, false, enter, choose);
  // A site whose state follows the keys a moment late validated the box on
  // that blur while its state was still blank, and shows "cannot be left
  // blank" over the value (Microsoft's Address and Postal Code). Entered
  // and left once more, it validates the state it now holds.
  if (!enter && !choose && element instanceof HTMLInputElement && !element.matches('input[role="spinbutton"]') && !userAttention()) {
    await pause(300);
    if (element.getAttribute("aria-invalid") === "true" && element.value && safe() && !userAttention() &&
        (element.getRootNode() as Document | ShadowRoot).activeElement !== element) {
      cs.trustedWrite = element;
      try {
        element.focus();
        await pause(50);
        if (focused()) element.blur();
      } finally {
        cs.trustedWrite = undefined;
      }
    }
  }
  return true;
}

// Paylocity's address line (paylocityAddressBox): the line is typed as the
// applicant types it, and the site's suggestion that is this address (its
// street, and the city or ZIP this fill gives the same address) is picked,
// which fills the address's City, County, State and ZIP the site's way.
// With none, the typed line stays: the box keeps free text when it loses
// focus, and the other parts are filled as the text boxes they are.
// Returns the fields of the same address the pick left holding this
// fill's own answers, done with it.
export async function fillPaylocityAddress(command: Command, proposal: Proposal, record: RecordEntry): Promise<string[]> {
  const element = record.element as HTMLInputElement;
  const wanted = proposal.value.trim();
  const words: Record<string, string> = {
    street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", place: "pl",
    highway: "hwy", parkway: "pkwy", circle: "cir", terrace: "ter", suite: "ste", apartment: "apt",
    north: "n", south: "s", east: "e", west: "w",
  };
  const plain = (text: string) => normalize(text).replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean)
    .map((word) => words[word] || word).join(" ");
  const safe = () => valid(command) && !record.protected && element.isConnected;
  // The same address's other parts this fill answers: City and ZIP (or
  // Postal Code) say which suggestion is this address.
  const base = element.id.replace(/-(address-1|postal-code)$/, "");
  const siblings = (command.proposals || []).flatMap((other) => {
    const entry = records.get(other.fieldId);
    return entry && entry.element !== element && entry.element.id.startsWith(`${base}-`) ? [{ proposal: other, record: entry }] : [];
  });
  const partOf = (pattern: RegExp) => siblings.find((sibling) => pattern.test(sibling.record.element.id))?.proposal.value.trim() || "";
  const places = [partOf(/-(city|locality)$/), partOf(/-(zip|postal-code)$/)].filter(Boolean).map(plain);
  if (plain(element.value) !== plain(wanted)) {
    const typed = await typeTrusted(command, element, wanted, safe, new AbortController().signal, true, false, true, true);
    if (!safe()) throw new Error("Custom selection was superseded.");
    if (!typed || plain(element.value) !== plain(wanted)) {
      // Keys could not be sent (the page out of view): written as text.
      element.focus({ preventScroll: true });
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, wanted);
      changed(record);
    }
  }
  record.writePendingAt = performance.now();
  const street = plain(wanted);
  const listed = () => {
    const list = document.getElementById(element.getAttribute("aria-controls") || "");
    return list && rendered(list) ? [...list.querySelectorAll<HTMLElement>('[role="option"]')].filter(rendered) : [];
  };
  const matches = (option: HTMLElement) => {
    const text = plain(option.textContent || "");
    return (text === street || text.startsWith(`${street} `)) && (!places.length || places.some((place) => text.includes(place)));
  };
  let choice: HTMLElement | undefined;
  let seenSince = 0;
  // The site asks for suggestions a moment after the keys (300 ms) and
  // waits on its address service: up to 4 s, and 1.5 s once a list that
  // holds none of this address is shown.
  for (let waited = 0; waited < 4_000 && safe(); waited += 150) {
    const options = listed();
    choice = options.find(matches);
    if (choice) break;
    if (options.length && !seenSince) seenSince = waited || 1;
    if (seenSince && waited - seenSince >= 1_500) break;
    await pause(150);
  }
  // The site sets the box back to the text of each search it answers, and
  // an answer arriving after later keys drops them: "100 E. Mill Way"
  // was left as "100 E. Mill " (Enovation). Typed again,
  // twice at most, once the answers have come in.
  for (let attempt = 0; !choice && attempt < 2 && safe() && plain(element.value) !== plain(wanted); attempt++) {
    await typeTrusted(command, element, wanted, safe, new AbortController().signal, true, false, true, true);
    for (let waited = 0; waited < 1_500 && safe(); waited += 150) {
      await pause(150);
      choice = listed().find(matches);
      if (choice) break;
    }
  }
  if (!safe()) throw new Error("Custom selection was superseded.");
  const before = new Map(siblings.map((sibling) => [sibling.record, valueOf(sibling.record.element)]));
  if (choice) {
    fillClick(choice);
    for (let waited = 0; waited < 1_500 && listed().length; waited += 100) await pause(100);
    // The site fills the address's other parts from the suggestion.
    await pause(300);
  }
  // Leaving the box commits it with a trusted change of our own making: the
  // wait for suggestions above outlasts the typing's own allowance, and that
  // change paused the fill as the applicant's edit (Enovation's work row).
  cs.searchSettle = { element, until: performance.now() + 1000 };
  if (document.activeElement === element) element.blur();
  await pause(0);
  if (!safe()) throw new Error("Custom selection was superseded.");
  if (!element.value.trim())
    throw new Error("The address line was not kept. Type it, or pick it from the site's suggestions.");
  record.last = valueOf(element);
  record.revision++;
  record.automationWritten = true;
  // Parts the pick changed are the site's doing, not the applicant's; those
  // that now hold this fill's answer need no write of their own.
  const settled: string[] = [];
  for (const sibling of siblings) {
    const now = valueOf(sibling.record.element);
    if (now === before.get(sibling.record)) continue;
    sibling.record.last = now;
    sibling.record.revision++;
    sibling.record.automationWritten = true;
    sibling.record.writePendingAt = performance.now();
    if (plain(now) === plain(sibling.proposal.value)) settled.push(sibling.proposal.fieldId);
  }
  return settled;
}

// Rippling's Location (ripplingLocation): typed as an applicant types it,
// then the suggestion that starts with the saved place is picked. With none,
// the list is closed and the typed text stays for the site to keep or drop.
export async function fillRipplingLocation(command: Command, proposal: Proposal, record: RecordEntry) {
  const element = record.element as HTMLInputElement;
  const wanted = proposal.value.trim();
  const plain = (text: string) => normalize(text).replace(/[.,]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const safe = () => valid(command) && !record.protected && element.isConnected;
  if (element.value !== wanted) {
    const typed = await typeTrusted(command, element, wanted, safe, new AbortController().signal, true, false, true, true);
    if (!safe()) throw new Error("Custom selection was superseded.");
    if (!typed || element.value !== wanted) {
      element.focus({ preventScroll: true });
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, wanted);
      changed(record);
    }
  }
  record.writePendingAt = performance.now();
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((dialog) => rendered(dialog) && !dialog.contains(element));
  // The entry itself: the innermost element of a dialog that begins with the place.
  const entries = () => dialogs().flatMap((dialog) => [...dialog.querySelectorAll<HTMLElement>("*")]
    .filter((node) => rendered(node) && plain(node.textContent || "").startsWith(plain(wanted)) &&
      ![...node.children].some((child) => plain(child.textContent || "").startsWith(plain(wanted)))));
  let choice: HTMLElement | undefined;
  let seenSince = 0;
  // Google answers a moment after the keys (the site's list was drawn 1 s
  // later in the capture): up to 6 s, and 1.5 s once a list that holds
  // nothing of this place is shown.
  for (let waited = 0; waited < 6_000 && safe(); waited += 150) {
    choice = entries()[0];
    if (choice) break;
    if (dialogs().length && !seenSince) seenSince = waited || 1;
    if (seenSince && waited - seenSince >= 1_500) break;
    await pause(150);
  }
  if (!safe()) throw new Error("Custom selection was superseded.");
  cs.searchSettle = { element, until: performance.now() + 2000 };
  if (choice) {
    for (const type of ["mousedown", "mouseup", "click"])
      choice.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    for (let waited = 0; waited < 1_500 && dialogs().length; waited += 100) await pause(100);
    await pause(200);
  } else if (dialogs().length) {
    // Nothing fits: closed as a person closes it, never left hanging.
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
    pressOutside();
    await pause(200);
  }
  if (document.activeElement === element) element.blur();
  await pause(0);
  if (!safe()) throw new Error("Custom selection was superseded.");
  if (choice && !plain(element.value).startsWith(plain(wanted)))
    throw new Error("The location was not kept. Pick it from the site's suggestions.");
  if (!choice) throw new Error("No suggestion matched the location. Pick it from the site's suggestions.");
  record.last = valueOf(element);
  record.revision++;
  record.automationWritten = true;
}
