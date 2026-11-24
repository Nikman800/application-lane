// A command the service worker sends a frame (content/commands.ts): attached files, rows removed with the site's own control, and answers edited by hand.
// Split out of executeCommand as it was.
import { currentFileName, sectionFor } from "../../semantics";
import { Command, pause } from "../core";
import { records, ownLabel } from "../tracking";
import { cs } from "../state";
import { fillClick } from "../../../engine/page/click-gate";
import { inspect } from "../inspect";
import { type Observation } from "../../../shared/model";
import { clip, radioGroup } from "../../content-dom";
import { secretName } from "../../workspace";

  // Whether a file of this name is attached in an upload slot: its name
  // shown beside a control that removes it (Greenhouse's "Remove file",
  // Oracle's "Remove Resume"). A list of earlier uploads to pick from
  // ("Use") names files that are not attached.
  export async function handleAttached(command: Command): Promise<unknown> {
const name = (command.name || "").trim();
const removes = (element: Element) =>
  [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].some((text) =>
    // Workday's is "Delete".
    /^\s*(remove|delete)\b/i.test(text || ""),
  );
// Only a file the applicant can see is attached: one employer's Oracle keeps
// the cover letter and its "Remove Cover Letter" button in a part of
// the page that is not shown, and it was taken for the one in
// Additional Documents, which stayed empty.
const shown = (element: Element) =>
  (element as HTMLElement).getClientRects().length > 0 &&
  (element as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true });
const named = name
  ? [...document.querySelectorAll("body *")].filter(
      (element) => !element.childElementCount && (element.textContent || "").trim() === name && shown(element),
    )
  : [];
// A site that takes the file into a list of its own names it as that
// list's choice: Microsoft's "Upload your resume" box held the name,
// and the résumé was sent again on each fill, its parse emptying the
// address typed before it.
const chosen = Boolean(name) && [...document.querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
  .some((box) => box.value.trim() === name && shown(box));
// SmartRecruiters' dropzone lists its upload in its files attribute,
// the name drawn in its shadow root.
const dropped = Boolean(name) && [...document.querySelectorAll("spl-dropzone")].some((zone) => {
  const input = zone.shadowRoot?.querySelector('input[type="file"]');
  return shown(zone) && Boolean(input) && currentFileName(input as HTMLInputElement).split(", ").includes(name);
});
return {
  attached: chosen || dropped || named.some((element) => {
    let scope: Element | null = element;
    for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement)
      if ([...scope.querySelectorAll('button, a, [role="button"]')].some((control) => control !== element && removes(control)))
        return true;
    return false;
  }),
};
}

  export async function handleRemoveRow(command: Command): Promise<unknown> {
// A row the site added from a parsed resume, removed with the site's
// own "Delete Education (3)" control. Nothing else is ever clicked.
const section = String(command.section || "");
// iCIMS' group loop: its own "Remove Additional" button takes the last
// block off in the page's script and never posts the form, and is used
// only where the page says to keep the highest degree alone.
if (command.groupLoop) {
  const member = [...records.values()].find((record) => {
    const place = sectionFor(record.element);
    return place.section === section && place.index === Number(command.index);
  })?.element;
  const loop = member?.closest<HTMLElement>(".icims_group_loop[data-group-loop-name]");
  const name = loop?.getAttribute("data-group-loop-name") || "";
  const same = [...document.querySelectorAll(".icims_group_loop[data-group-loop-name]")]
    .filter((other) => other.getAttribute("data-group-loop-name") === name);
  const remover = [...document.querySelectorAll<HTMLInputElement>("input.group-loop-remove[data-group-loop]")]
    .find((input) => input.getAttribute("data-group-loop") === name);
  const form = loop?.closest("form");
  const saysSo = same.some((other) => /\bremove all others\b/i.test(other.textContent || ""));
  if (!loop || !remover || !form || same.length < 2 || same.at(-1) !== loop || !saysSo ||
      remover.disabled || remover.getClientRects().length === 0)
    return { removed: false };
  // Whatever the page's script does, this click never posts the form.
  const hold = (event: Event) => event.preventDefault();
  form.addEventListener("submit", hold, true);
  cs.writing = true;
  try {
    // The one submit input a fill presses, and so not through
    // fillClick (click-gate.ts), which refuses every submit input:
    // iCIMS' own "Remove Additional", only where the page says to
    // remove the others, with the form's submission held above.
    remover.click();
  } finally {
    cs.writing = false;
    for (let waited = 0; waited < 1500 && loop.isConnected; waited += 100) await pause(100);
    form.removeEventListener("submit", hold, true);
  }
  return { removed: !loop.isConnected };
}
const number = Number(command.index) + 1;
// Apple's review of the parsed resume: "Remove Employment Summary 2" for the
// fieldset "Edit Employment 2".
const apple = section.match(/^Edit (Employment|Education)$/);
const wanted = apple
  ? new RegExp(`^remove\\s+${apple[1]}\\s+summary\\s+${number}$`, "i")
  : new RegExp(
      `^(delete|remove)\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(?${number}\\)?$`,
      "i",
    );
const control = [
  ...document.querySelectorAll<HTMLElement>("a[aria-label],button[aria-label],[role='button'][aria-label]"),
].find((element) => wanted.test((element.getAttribute("aria-label") || "").trim()));
if (!control) return { removed: false };
// A field of that row, to confirm the row is really gone afterwards.
const member = [...records.values()].find((record) => {
  const place = sectionFor(record.element);
  return place.section === section && place.index === Number(command.index);
})?.element;
cs.writing = true;
try {
  fillClick(control);
} finally {
  cs.writing = false;
}
for (let waited = 0; waited < 1500; waited += 100) {
  await pause(100);
  if (!member || !member.isConnected || member.getClientRects().length === 0)
    return { removed: Boolean(member) };
}
return { removed: false };
}

  export async function handleEditedAnswers(command: Command): Promise<unknown> {
// Answers the applicant (not this extension) put on the page, as
// candidates for the saved-answer bank.
const observation = inspect();
// A native list's value is its option's hidden value (one employer's location
// "65f5e6fd-…", Tesla's "7_months_or_more"); a saved answer is filled
// by the text the applicant picked. A radio with no label of its own
// reads as its hidden value too: that one has no text to keep.
const shown = (field: Observation["fields"][number]): Observation["fields"][number] => {
  const element = records.get(field.id)?.element;
  if (element instanceof HTMLSelectElement) {
    const option = element.selectedOptions[0];
    return { ...field, value: option ? clip(option.label || option.text) : "" };
  }
  if (element instanceof HTMLInputElement && element.type === "radio") {
    const selected = radioGroup(element).find((candidate) => candidate instanceof HTMLInputElement && candidate.checked);
    return { ...field, value: selected ? ownLabel(selected) : "" };
  }
  return field;
};
return observation.fields.map(shown).filter((field) => {
  const record = records.get(field.id);
  return (
    record &&
    !record.automationWritten &&
    field.value &&
    !["file", "password", "hidden"].includes(field.kind) &&
    field.label !== "Unlabelled field" &&
    !secretName.test(field.label) &&
    /^(a real|value changed outside a fill|existing value)/.test(
      record.protectedBy || "",
    )
  );
});
}
