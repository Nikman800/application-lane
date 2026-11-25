// Whether the site itself calls a control's value invalid.
//
// ADP Workforce Now's question boxes (.vdl-textbox, .vdl-textarea) carry
// aria-invalid="true" from the start and keep it whatever they hold, even
// after the site accepts the answer; the box it rejects is the one it gives
// "question-error" (and a red border). Read the attribute there, and every
// filled required box looked rejected, and so replaceable on a refill.
export function siteInvalid(element: Element): boolean {
  if (element.getAttribute("aria-invalid") !== "true") return false;
  if (element.matches(".vdl-textbox, .vdl-textarea")) return element.classList.contains("question-error");
  return true;
}
