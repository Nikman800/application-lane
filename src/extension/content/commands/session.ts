// A command the service worker sends a frame (content/commands.ts): binding a page to an application, pausing and resuming, unlocking, and authorizing a page-world write.
// Split out of executeCommand as it was.
import { lockedLabels, lockOrigins, records, addLock, documentId } from "../tracking";
import { valueOf, clearPendingWrites, adoptSiteValue, hasEditLock, lockReason } from "../controls";
import { inspect } from "../inspect";
import { Command } from "../core";
import { cs } from "../state";
import { authorizeMainWorld } from "../../../engine/page/bridge";

  export async function handleUnlock(command: Command): Promise<unknown> {
// Forget edit locks on this page. Fields with a value stay protected
// (they are never overwritten); empty ones may be filled again.
lockedLabels.clear();
lockOrigins.clear();
for (const record of records.values()) {
  record.failedOperation = undefined;
  if (!valueOf(record.element)) {
    record.protected = false;
    record.protectedBy = undefined;
  }
}
return inspect();
}

  export async function handleBind(command: Command): Promise<unknown> {
if (cs.applicationId && command.applicationId !== cs.applicationId && !cs.paused)
  throw new Error("This tab belongs to another active application.");
// The tab went to another application after the extension paused the old
// one (its tab went on to another posting): that pause was the old
// application's, not the applicant's (an edit names what paused it).
if (cs.applicationId && command.applicationId !== cs.applicationId && !cs.pausedBy) cs.paused = false;
if (
  command.applicationId === cs.applicationId &&
  command.operation < cs.operation
)
  throw new Error("Stale operation.");
cs.applicationId = command.applicationId;
// Dependent fields can appear after binding; their defaults follow the
// same prefilled-value policy as the fields already visible.
cs.replaceSiteValues = Boolean(command.replaceSiteValues);
cs.ownWrites = Array.isArray(command.ownWrites) ? command.ownWrites.slice(0, 300) : [];
clearPendingWrites();
if (cs.operation !== command.operation) {
  cs.configController.abort();
  cs.configController = new AbortController();
}
cs.operation = command.operation;
for (const key of command.locks || [])
  addLock(key, "an edit saved with this application earlier");
inspect();
// What was on the page before this extension wrote anything is the
// site's (a saved profile, an earlier application, a parsed resume),
// not an edit of the applicant's, which edit locks protect: the profile
// may replace it.
for (const record of records.values()) adoptSiteValue(record);
for (const record of records.values())
  if (hasEditLock(record.element, record.label)) {
    record.protected = true;
    record.protectedBy = lockReason(record.element, record.label);
  }
// Binding never silently resumes a human pause.
return inspect();
}

  export async function handlePause(command: Command): Promise<unknown> {
cs.paused = true;
cs.configController.abort();
return { paused: cs.paused };
}

  export async function handleResume(command: Command): Promise<unknown> {
cs.operation = command.operation;
cs.paused = false;
cs.pausedBy = "";
clearPendingWrites();
cs.configController.abort();
cs.configController = new AbortController();
return inspect();
}

  export async function handleAuthorizeMain(command: Command): Promise<unknown> {
  return {
  authorized: authorizeMainWorld(
    { applicationId: cs.applicationId, documentId, operation: cs.operation },
    command.token || "",
  ),
};
}
