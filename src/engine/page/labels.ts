// The text a page shows as a control's label, cleaned of what is no part of
// its name. Used by field discovery (src/extension/semantics.ts) and by the
// engine's own rules (src/engine/runtime.ts), so it lives in the engine.

export const cleanLabel = (text: string) =>
  text
    // Markup a site escaped into its text (PageUp's hidden option names:
    // "<b>White</b><br> A person having origins\, …").
    .replace(/<\/?[a-z][a-z0-9]*\s*\/?>/gi, " ")
    .replace(/\\,/g, ",")
    // Invisible joiners around a required mark ("First Name\u2060*\u2060:",
    // one employer's Greenhouse form) and a closing colon are no part of a name.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // A question typed with its mark twice ("…on-site location??").
    .replace(/([?!])\1+/g, "$1")
    .replace(/(\s*[*✱✳✴:])+\s*$/, "")
    .replace(/\s*\(required\)\s*$/i, "")
    .trim()
    .slice(0, 1000);
// Labels must not absorb option lists, validation messages, or uploaded names.
const notLabelText =
  'input,textarea,select,button,script,style,svg,iframe,[role="checkbox"],[role="radio"],[role="combobox"],[role="button"],[role="listbox"],[role="option"],[role="status"],[role="alert"],[aria-live],[hidden],.application-field,.select__menu,.select__value-container,.input-select-input-single-value';
// The text a label shows, with what its <slot>s show in their place: a web
// component's label inside its shadow root is only slots, and SmartRecruiters'
// questions are the page's own text slotted in.
function shownText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.matches(notLabelText)) return "";
  if (element.localName === "slot") {
    const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
    return (assigned.length ? assigned : [...element.childNodes]).map(shownText).join("");
  }
  return [...element.childNodes].map(shownText).join(element.localName === "br" ? " " : "");
}
export function labelText(node: Element | null): string {
  if (!node) return "";
  if (node.querySelector("slot")) return cleanLabel(shownText(node));
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll(notLabelText).forEach((e) => e.remove());
  return cleanLabel(copy.textContent || "");
}
