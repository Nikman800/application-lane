// A command the service worker sends a frame (content/commands.ts): writing proposals and attaching documents.
// Split out of executeCommand as it was.
import { apply } from "../apply";
import { Command, pause } from "../core";
import { records, nodeRecords, fieldLabel, documentId, lockedLabels, lockOrigins } from "../tracking";
import { cs } from "../state";
import { guardedRecord, valid, guard, changed } from "../guards";
import { replacesForm, currentFileName, listedFileName, uploadError } from "../../semantics";
import { valueOf, hasEditLock, markEngineWrite, elementLockKeys, applicantLock } from "../controls";
import { inspect } from "../inspect";
import { checkControl } from "../choose";
import { configEngineEnabled } from "../../../engine/mode";
import { requestMainWorld } from "../../../engine/page/bridge";
import { executeCommand } from "../commands";

  export async function handleApply(command: Command): Promise<unknown> {
  return apply(command);
}

  export async function handleAttach(command: Command): Promise<unknown> {
// A document the site held before this extension (Amazon's stored
// resume), when the applicant asked for it to be replaced. One they
// chose themselves stays theirs.
const held = records.get(command.fieldId!);
// A site that shows its own file again after a fill (iCIMS reloading the
// account's resume) changed the value outside a fill, and that is locked
// under the field's name: a file shown that way is the site's too, not one
// the applicant chose.
if (command.replaceExisting && held?.protected && !listedFileName(held.element)) {
  const keys = held.element instanceof HTMLInputElement && held.element.type === "file" ? elementLockKeys(held.element, held.label) : [];
  const siteLocked = keys.filter((key) => lockedLabels.has(key) && !applicantLock(key));
  if (held.protectedBy === "existing value" ||
    (siteLocked.length && /^(value changed outside a fill|edit lock)/.test(held.protectedBy || "") &&
      !keys.some((key) => lockedLabels.has(key) && applicantLock(key)))) {
    for (const key of siteLocked) { lockedLabels.delete(key); lockOrigins.delete(key); }
    held.protected = false;
    held.protectedBy = undefined;
    held.siteValue = true;
  }
}
// Focus an upload of ours left on a configured slot is no applicant's:
// the résumé's upload in Workday's shared uploader ends on its "Select
// files" button, which is the cover letter's slot, and the cover letter
// was refused as a field in use.
const slot = records.get(command.fieldId!);
if (slot && cs.fileControls.has(slot.element) && document.activeElement === slot.element &&
    performance.now() - cs.lastApplicantInput > 2000)
  (slot.element as HTMLElement).blur();
const guarded = guardedRecord(command, {
  fieldId: command.fieldId!,
  revision: command.revision!,
  expectedValue: command.expectedValue!,
});
const record = guarded.record;
if (record?.element instanceof HTMLInputElement && replacesForm(record.element)) cs.siteFillUntil = performance.now() + 60_000;
const artifact = command.artifact;
const configured = record && cs.fileControls.get(record.element);
if (record && configured && artifact && artifact.applicationId === cs.applicationId && artifact.operation === cs.operation) {
  const result = await executeCommand({
    ...command,
    type: "CONFIG_FILL",
    uploads: { [artifact.kind]: artifact },
  }) as { statuses?: { status: string }[] };
  const filled = result.statuses?.some((status) => status.status === "filled");
  // SmartRecruiters' spl-dropzone lists the file only once its own
  // upload is done, a few seconds on.
  const holds = () => valueOf(record.element) === artifact.name || currentFileName(record.element).split(", ").includes(artifact.name);
  if (filled && (record.element.getRootNode() as ShadowRoot).host?.localName === "spl-dropzone")
    for (let waited = 0; !holds() && waited < 8_000; waited += 250) await pause(250);
  const attached = filled && holds();
  if (attached) record.attachmentId = artifact.id;
  return { attached: Boolean(attached), observation: inspect() };
}
if (
  !record ||
  !(record.element instanceof HTMLInputElement) ||
  record.element.type !== "file" ||
  !artifact ||
  artifact.applicationId !== cs.applicationId ||
  artifact.operation !== cs.operation
)
  throw new Error(`Stale or mismatched document attachment${guarded.reason ? ` (${guarded.reason} DBG ${JSON.stringify([command.replaceExisting, held?.protected, held?.protectedBy, record?.protectedBy])})` : ""}.`);
// Paylocity exposes a separate "Apply with resume" shortcut and a
// parsing checkbox beside the ordinary uploader. Use the ordinary
// upload without letting the parser discard fields already filled.
if (record.element.id === "btn-resume" && /(^|\.)paylocity\.com$/i.test(location.hostname)) {
  const parser = document.getElementById("useAttachedResumeToFillOutApplication");
  if (parser instanceof HTMLInputElement && parser.checked) {
    const parserRecord = nodeRecords.get(parser);
    if (!valid(command) || hasEditLock(parser, fieldLabel(parser)) || (parserRecord?.protected && parserRecord.protectedBy !== "existing value"))
      throw new Error("Resume parsing is locked. Upload the resume manually.");
    markEngineWrite(parser);
    cs.writing = true;
    try { await checkControl(parser, false); } finally { cs.writing = false; }
    if (parser.checked || !valid(command)) throw new Error("Turn off resume parsing before uploading manually.");
    if (parserRecord) {
      parserRecord.last = valueOf(parser);
      parserRecord.revision++;
      parserRecord.automationWritten = true;
      parserRecord.protected = false;
      parserRecord.protectedBy = undefined;
    }
  }
}
const raw = atob(artifact.data);
const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
const file = new File([bytes], artifact.name, { type: artifact.mime });
const accept = record.element.accept.toLowerCase();
if (
  accept &&
  !accept
    .split(",")
    .some(
      (a) =>
        a.trim() === `.${artifact.format}` ||
        a.trim() === artifact.mime ||
        a.trim() === "*/*" ||
        a.trim() === "application/*",
    )
)
  throw new Error("Site does not accept this document format.");
if (
  !guard(command, {
    fieldId: command.fieldId!,
    revision: command.revision!,
    expectedValue: command.expectedValue!,
  })
)
  throw new Error("Attachment was superseded.");
const errorBefore = uploadError(record.element);
// Where the site shows an accepted file: some (Greenhouse's job boards)
// empty or replace the input and show the file's name beside it.
const uploadGroup = record.element.closest(
  '[role="group"], .file-upload, .field-wrapper, .application-question, fieldset, .field',
);
const transfer = new DataTransfer();
transfer.items.add(file);
cs.writing = true;
try {
  record.writePendingAt = performance.now();
  if (configEngineEnabled) {
    const result = await requestMainWorld(
      record.element,
      { applicationId: cs.applicationId, operation: cs.operation, documentId },
      {
        method:
          artifact.kind === "resume"
            ? "uploadResume"
            : "uploadCoverLetter",
        values: [],
        file: artifact,
      },
      cs.configController.signal,
      () =>
        Boolean(
          guard(command, {
            fieldId: command.fieldId!,
            revision: command.revision!,
            expectedValue: command.expectedValue!,
          }),
        ),
    );
    if (!result.ok)
      throw new Error(result.reason || "Attachment failed.");
    record.last = valueOf(record.element);
    record.revision++;
    record.automationWritten = true;
  } else {
    record.element.files = transfer.files;
    changed(record);
  }
  record.attachmentId = artifact.id;
} finally {
  cs.writing = false;
}
// Some sites fail the upload in their own handler and say so beside the
// field; the file input alone would still look attached.
let siteError = "";
for (let waited = 0; waited < 2000 && !siteError; waited += 250) {
  await pause(250);
  const shown = uploadError(record.element);
  if (shown !== errorBefore) siteError = shown;
}
const shownName = Boolean(uploadGroup?.isConnected && uploadGroup.textContent?.includes(artifact.name));
// SmartRecruiters' spl-dropzone empties its input and lists the file
// in its files attribute once its own upload is done, a few seconds
// on: read as not attached, the resume was "Verify upload"
// (one employer's SmartRecruiters form).
const listed = () => currentFileName(record.element).split(", ").includes(artifact.name);
let listedName = listed();
const dropzone = (record.element.getRootNode() as ShadowRoot).host?.localName === "spl-dropzone";
for (let waited = 0; dropzone && !listedName && !siteError && record.element.files?.[0]?.name !== artifact.name && waited < 8_000; waited += 250) {
  await pause(250);
  listedName = listed();
}
return {
  attached: (record.element.files?.[0]?.name === artifact.name || shownName || listedName) && !siteError,
  siteError,
  observation: inspect(),
};
}
