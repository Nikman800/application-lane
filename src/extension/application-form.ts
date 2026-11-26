import type { Observation } from "../shared/model";
import { sameOpening } from "../shared/matching";

const oracleHost = /(^|\.)oraclecloud\.com$/i;
const oracleJob = /\/sites\/[^/]+\/job\/([^/]+)(?:\/|$)/i;

// The posting an address names on its site (Oracle's /job/<id>, a jobId
// parameter), when it names one.
function postingJob(url: URL): string | undefined {
  return oracleHost.test(url.hostname)
    ? url.pathname.match(oracleJob)?.[1]
    : ["jobId", "job_id", "requisitionId", "opportunityId", "gh_jid"]
      .map((key) => url.searchParams.get(key)).find(Boolean) || undefined;
}

// Both addresses name the same posting on the same site.
export function samePosting(page: string, posting?: string): boolean {
  if (!posting) return false;
  try {
    const [a, b] = [new URL(page), new URL(posting)];
    const job = postingJob(a);
    return a.origin === b.origin && Boolean(job) && job === postingJob(b);
  } catch { return false; }
}

export function postingMismatch(page: string, posting?: string): boolean {
  if (!posting) return false;
  let actual: URL;
  let expected: URL;
  try { actual = new URL(page); expected = new URL(posting); } catch { return false; }
  if (actual.origin !== expected.origin) return false;
  const actualJob = postingJob(actual);
  const expectedJob = postingJob(expected);
  if (actualJob && expectedJob) return actualJob !== expectedJob;
  return /\.(myworkdayjobs|myworkdaysite)\.com$/i.test(actual.hostname) &&
    [actual, expected].every((url) => /\/(job|details)\/.*_[\w-]+/i.test(url.pathname)) &&
    !sameOpening(page, posting);
}

export function knownNonApplication(raw: string): boolean {
  const url = new URL(raw);
  // Oracle's listings can contain a résumé uploader and an Apply button.
  return oracleHost.test(url.hostname) && /\/sites\/[^/]+\/(?:jobs\b|job\/[^/]+(?:\/|$)|my-(?:profile|applications)\b)/i.test(url.pathname) &&
    !/\/job\/[^/]+\/apply(?:\/|$)/i.test(url.pathname);
}

export function differentApplicationStep(expected: string, current: string): boolean {
  const identity = (raw: string) => {
    const url = new URL(raw);
    const path = url.pathname.match(/^.*\/(?:apply|application)\/(?:section|step)\/[^/]+/i)?.[0];
    return path && url.origin + path;
  };
  try {
    const step = identity(expected);
    return Boolean(step && step !== identity(current));
  } catch {
    return false;
  }
}

export function applicationForm(page: Observation, { allowNamedUpload = false } = {}): boolean {
  const url = new URL(page.url);
  if (knownNonApplication(page.url)) return false;
  const applicationPath = /\/(apply|application|applications)(\/|$)/i.test(url.pathname);
  // Some application forms also let applicants create a password. Their
  // application controls are fillable while sign-in and submission stay manual.
  if (page.blockers.some((blocker) => /^Sign in or create/.test(blocker)) && !page.applicationContainer) return false;
  return Boolean(page.canAdvance || page.atReview || page.addable?.length || page.foldedSections ||
    page.documentSlots?.length || page.uploadSlots?.length ||
    page.pendingFields?.length ||
    page.fields.some((field) => field.kind === "file"
      ? Boolean(page.applicationContainer || applicationPath || (allowNamedUpload && field.documentKind))
      : !/^(search|filter|keyword|job alert)(s| jobs)?$/i.test(field.label.trim())));
}
