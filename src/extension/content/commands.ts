// Part of the content script (content.ts): the commands the service worker sends a frame.
// Split out of content.ts as it was; see content.ts for how it starts.
import { draftOnlySite, DRAFT_ONLY_NOTE } from "../../shared/matching";
import { configEngineEnabled } from "../../engine/mode";
import { cs } from "./state";
import { Command } from "./core";
import { invalidCommandReason, valid } from "./guards";
import { handleEngineInfo, handlePageTimers, handleInspect } from "./commands/page";
import { handleAttached, handleRemoveRow, handleEditedAnswers } from "./commands/rows";
import { handleUnlock, handleBind, handlePause, handleResume, handleAuthorizeMain } from "./commands/session";
import { handleRecordStart, handleRecordCheckpoint, handleRecordStop } from "./commands/recording";
import { handleSnapshot } from "./commands/snapshot";
import { handleStepCheck, handlePressStep } from "./commands/steps";
import { handleConfigFill } from "./commands/config-fill";
import { handleOptions } from "./commands/options";
import { handleApply, handleAttach } from "./commands/attach";
import { seedLookupCache } from "./lookup-cache";
import { applicationForm, knownNonApplication } from "../application-form";
import { inspect } from "./inspect";

export async function executeCommand(command: Command): Promise<unknown> {
  // The last line of defence for a draft-only site: whatever asked, this
  // page is not written to, opened or advanced.
  if (draftOnlySite(location.href) && /^(APPLY|ATTACH|CONFIG_FILL|PRESS_STEP|REMOVE_ROW|OPTIONS)$/.test(command.type))
    throw new Error(DRAFT_ONLY_NOTE);
  if (command.type === "ENGINE_INFO") return handleEngineInfo(command);
  if (command.type === "PAGE_TIMERS") return handlePageTimers(command);
  if (command.type === "INSPECT") return handleInspect(command);
  if (command.type === "ATTACHED") return handleAttached(command);
  if (command.type === "UNLOCK" &&
    command.applicationId === cs.applicationId) return handleUnlock(command);
  if (command.type === "REMOVE_ROW" &&
    command.applicationId === cs.applicationId) return handleRemoveRow(command);
  if (command.type === "EDITED_ANSWERS") return handleEditedAnswers(command);
  if (command.type === "RECORD_START") return handleRecordStart(command);
  if (command.type === "RECORD_CHECKPOINT") return handleRecordCheckpoint(command);
  if (command.type === "RECORD_STOP") return handleRecordStop(command);
  if (command.type === "SNAPSHOT") return handleSnapshot(command);
  if (command.type === "BIND") return handleBind(command);
  if (command.type === "PAUSE" &&
    command.applicationId === cs.applicationId &&
    command.operation >= cs.operation) return handlePause(command);
  if (command.type === "RESUME" &&
    command.applicationId === cs.applicationId &&
    command.operation >= cs.operation) return handleResume(command);
  if (command.type === "STEP_CHECK") return handleStepCheck(command);
  if (command.type === "PRESS_STEP") return handlePressStep(command);
  // Which command, and which check, failed: three Workday fills ended on
  // this with nothing to say why (report 83effc7c).
  if (!valid(command)) throw new Error(`Operation is paused or stale (${command.type}: ${invalidCommandReason(command) || "unknown"})`);
  if (["APPLY", "ATTACH", "CONFIG_FILL", "OPTIONS"].includes(command.type) && knownNonApplication(location.href))
    throw new Error("This page is outside the application form.");
  if ((command.type === "ATTACH" || (command.type === "CONFIG_FILL" && command.uploads)) &&
      !applicationForm(inspect(), { allowNamedUpload: true }))
    throw new Error("Document attachment requires a recognized application form.");
  if (command.type === "AUTHORIZE_MAIN") return handleAuthorizeMain(command);
  const write = command.type === "CONFIG_FILL" && configEngineEnabled ? handleConfigFill :
    command.type === "OPTIONS" ? handleOptions : command.type === "APPLY" ? handleApply : undefined;
  if (write) {
    try {
      return await write(command);
    } finally {
      // Prepare the next Oracle reload after the fill has had a chance to load lists.
      if (/(^|\.)oraclecloud\.com$/i.test(location.hostname)) seedLookupCache();
    }
  }
  if (command.type === "ATTACH") return handleAttach(command);
  throw new Error("Unknown content operation.");
}
