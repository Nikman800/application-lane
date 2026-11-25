// What a report or settled capture shows: the defects the software can fix,
// and what only the applicant can do (src/shared/repairs.ts says why the two
// are kept apart). Two sources, read together:
//
// - the form checks of eval/invariants.ts on the page's fields as the
//   extension read them (rejected, wrong-shape and placeholder values, values
//   the site cleared, rows short, uploads missing, fields skipped for a
//   shared label);
// - the fill's own account of what it could not do (application.missing):
//   "<field>: not filled (…)", "Answer not filled: …", an upload that did
//   not finish, a site rule that failed, and what it left for the applicant.
//
// A required field that is only empty (invariants' required-empty) is not a
// defect here: the checks cannot tell whether the profile has an answer. It
// is one when the fill's notes say it had a value and failed to write it.
// Both upload-missing and same-label-skipped, which eval/fix-tasks.ts leaves
// out of its automatic tasks, are defects here: on a live page they are the
// fill's to do.

import { checkForm, labelKey, type CheckField, type Rule } from "../eval/invariants";
import { defectId, type Defect, type DefectKind, type Found } from "../src/shared/repairs";

type SavedField = {
  label: string;
  kind: string;
  required?: boolean;
  value?: string;
  valueText?: string;
  options?: string[];
  invalid?: boolean;
  fillWarning?: string;
  protected?: boolean;
  protectedReason?: string;
  section?: string;
  index?: number;
};
export type Evidence = {
  id: string;
  applicationId?: string;
  form?: boolean;
  createdAt?: number;
  tab?: { url?: string; ats?: string; tabId?: number };
  recordingId?: string;
  application?: { missing?: string[]; attempts?: { id?: string; repairRootId?: string; status?: string; note?: string; completedAt?: number }[] };
  frames?: { observation?: { fields?: SavedField[]; pendingFields?: string[] } }[];
};

export function persistedFieldChanges(before: Evidence, after: Evidence) {
  const collect = (evidence: Evidence) => (evidence.frames || []).flatMap(({ observation }, frame) =>
    (observation?.fields || []).filter((field) => field.kind !== "file" && !/password/i.test(field.kind))
      .map((field) => ({
        key: JSON.stringify([frame, field.section, field.index, labelKey(field.label)]),
        label: field.label,
        required: Boolean(field.required),
        value: field.valueText || field.value || "",
      })));
  const next = collect(after);
  const seen = collect(before);
  return seen.flatMap((field) => {
    const matches = next.filter(({ key }) => key === field.key);
    if (!matches.length && field.required && before.tab?.url && before.tab.url === after.tab?.url &&
        seen.filter(({ key }) => key === field.key).length === 1)
      return [{ label: field.label, required: true, before: field.value, after: "" }];
    if (matches.length !== 1 || seen.filter(({ key }) => key === field.key).length !== 1) return [];
    const actual = matches[0];
    return field.value === actual.value ? [] : [{ label: field.label, required: field.required, before: field.value, after: actual.value }];
  });
}

type TraceEvent = { t?: number; kind?: string; data?: Record<string, unknown> };
type HarEntry = {
  startedDateTime?: string;
  request?: { method?: string; url?: string };
  response?: { status?: number; content?: { text?: string } };
};

export function summarizeEvidence(capture: Evidence, events: TraceEvent[], entries: HarEntry[], field = "", before?: Evidence) {
  const reads = (capture.frames || []).flatMap(({ observation }) => observation?.fields || []);
  const match = (text: string) => !field || text.toLowerCase().includes(field.toLowerCase());
  return {
    captureId: capture.id,
    applicationId: capture.applicationId,
    tab: capture.tab?.tabId,
    attempt: capture.application?.attempts?.at(-1)?.id,
    recordingId: capture.recordingId,
    fields: reads.filter(({ label }) => match(label)).slice(0, 80)
      .map(({ label, section, index, value, valueText, invalid }) => ({ label, section, index, value: (valueText || value)?.slice(0, 300), invalid })),
    loading: (capture.frames || []).flatMap(({ observation }) => observation?.pendingFields || []),
    changedAfterReload: before ? persistedFieldChanges(before, capture).filter(({ label }) => match(label)) : undefined,
    changes: events.flatMap(({ t, kind, data }) => {
      if (!kind || !["value", "write", "navigation"].includes(kind) || !data) return [];
      const label = String(data.label || data.id || "");
      if (!match(label)) return [];
      const info = (key: string) => typeof data[key] === "string" ? data[key].slice(0, 180) : undefined;
      return [{ ms: t, kind, label, from: info("before") || info("from"), to: info("value") || info("after") || info("to"), cause: info("cause") || info("source") }];
    }).slice(-40),
    requests: entries.flatMap(({ request, response, startedDateTime }) => {
      if (!request?.url || !response?.status || response.status < 400) return [];
      let url: URL;
      try { url = new URL(request.url); } catch { return []; }
      const text = (response.content?.text || "").slice(0, 10000);
      const validation = /validation successful/i.test(text) ? "response says validation successful" :
        /both end date and projected comp date are present/i.test(text) ? "response mentions both end and projected completion dates" : undefined;
      const kind = /ExtraInformationDictionary/i.test(url.pathname) && url.searchParams.get("limit") === "1"
        ? "saved option lookup" : undefined;
      return [{ at: startedDateTime, method: request.method, path: url.pathname, status: response.status, kind, validation }];
    }).slice(-35),
  };
}

const ruleKind: Partial<Record<Rule, DefectKind>> = {
  "fill-error": "fill-failed",
  "write-failed": "widget",
  "lost-value": "lost-value",
  "placeholder-value": "wrong-value",
  "wrong-shape": "wrong-value",
  "not-an-option": "wrong-value",
  "site-rejected": "rejected",
  "rows-short": "wrong-value",
  "menu-open": "widget",
  "upload-missing": "upload",
  "same-label-skipped": "empty-answerable",
};

const strip = (text: string) => text.replace(/\s+/g, " ").trim();

export function findDefects(evidence: Evidence): Found {
  const defects = new Map<string, Defect>();
  const userActions = new Set<string>();
  const add = (kind: DefectKind, field: string | undefined, detail: string) => {
    const id = defectId(kind, field ? labelKey(field) : undefined, detail);
    if (!defects.has(id)) defects.set(id, { id, kind, ...(field ? { field: strip(field).slice(0, 300) } : {}), detail: strip(detail).slice(0, 600), status: "open", seenIn: evidence.id });
  };
  const missing = evidence.application?.missing || [];
  for (const { observation } of evidence.frames || [])
    for (const label of observation?.pendingFields || []) add("widget", label, "The site's control is still loading.");
  // Fields the fill said it had an answer for and could not write.
  const failedLabels = new Set<string>();

  for (const raw of missing) {
    const line = strip(raw);
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^Left "(.+?)" for you: (.+)$/))) userActions.add(`Answer "${match[1].slice(0, 120)}": ${match[2].slice(0, 200)}`);
    else if (/captcha|verify you are human|sign in again|log in again|session (has )?expired|signed out/i.test(line)) userActions.add(line.slice(0, 300));
    else if ((match = line.match(/^Required: (.+?) \(left alone: (.+)\)/))) {
      // The applicant's own edit holds it: theirs to clear or fill. A site
      // rule that was to fill it and did not is the fill's.
      if (/edit lock|your edit|you (typed|changed|cleared)|existing value/i.test(match[2])) userActions.add(`"${match[1].slice(0, 120)}" holds your earlier edit: fill it, or choose Unlock empty fields.`);
      else { add("empty-answerable", match[1], `Left empty: ${match[2]}`); failedLabels.add(labelKey(match[1])); }
    } else if ((match = line.match(/^(.+?): not filled \((.+?)\)\.?$/))) {
      if (!/paused by you|you interacted/i.test(match[2])) { add("widget", match[1], `Not filled: ${match[2]}`); failedLabels.add(labelKey(match[1])); }
    } else if ((match = line.match(/^Answer not filled: (.+?)\. (.+)$/))) { add("widget", match[1], match[2]); failedLabels.add(labelKey(match[1])); }
    else if ((match = line.match(/^(.+?): Dropdown options were not available/))) { add("widget", match[1], line); failedLabels.add(labelKey(match[1])); }
    else if ((match = line.match(/^Site validation failed: (.+)$/))) add("rejected", match[1], "The site marks the value invalid.");
    else if ((match = line.match(/^(Resume|Cover letter|.+?) upload did not finish/))) add("upload", match[1], line);
    else if ((match = line.match(/^Verify upload: (.+)$/))) add("upload", match[1], "The upload was not confirmed on the page.");
    else if ((match = line.match(/^Choose a file manually: (.+)$/))) {
      // A document the lane makes (résumé, cover letter, transcript) left
      // unattached is the fill's; any other file (a photo) is the applicant's.
      if (/resume|résumé|\bcv\b|cover letter|transcript|choose a file or drop it here/i.test(match[1])) add("upload", match[1], "No document was attached.");
      else userActions.add(`Attach "${match[1].slice(0, 120)}" yourself if you want to.`);
    }
    else if (/^AI suggestions were not filled automatically/.test(line)) add("widget", undefined, line);
    else if ((match = line.match(/^(.+?): "(.+?)" was filled in by the site from your resume and not corrected/))) add("wrong-value", match[1], line);
    else if (/^The job posting could not be read/.test(line)) userActions.add("Add the posting's link or text to the application, then fill again.");
  }

  const fields: CheckField[] = (evidence.frames || []).flatMap((frame) =>
    (frame.observation?.fields || []).map((field) => ({
      label: field.label,
      kind: field.kind,
      required: Boolean(field.required),
      value: field.value || "",
      ...(field.valueText ? { valueText: field.valueText } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.invalid ? { invalid: true } : {}),
      ...(field.fillWarning ? { warning: field.fillWarning } : {}),
      ...(field.protected ? { protected: true } : {}),
      ...(field.protected && /edit lock/i.test(field.protectedReason || "") ? { lock: field.protectedReason } : {}),
    })),
  );
  const last = evidence.application?.attempts?.at(-1);
  for (const violation of checkForm(fields, { site: evidence.tab?.ats || "", fillStatus: last?.status, fillNote: last?.note })) {
    if (violation.rule === "required-left-for-you") userActions.add(`Answer "${violation.label.slice(0, 120)}" yourself (consent, signature or self-identification).`);
    else if (violation.rule === "locked-empty") userActions.add(`"${violation.label.slice(0, 120)}" is kept empty by your earlier edit: fill it, or choose Unlock empty fields.`);
    else if (violation.rule === "required-empty") {
      // Only with the fill's word that it had an answer (above).
      if (failedLabels.has(labelKey(violation.label))) continue;
    } else if (violation.rule === "fill-warning") add(/cleared/i.test(violation.detail) ? "lost-value" : /replaced/i.test(violation.detail) ? "wrong-value" : "widget", violation.label, violation.detail);
    else if (ruleKind[violation.rule]) add(ruleKind[violation.rule]!, violation.label || undefined, violation.detail);
  }
  return { defects: [...defects.values()], userActions: [...userActions] };
}
