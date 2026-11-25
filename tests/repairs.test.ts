import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findDefects, summarizeEvidence, type Evidence } from "../scripts/repair-evidence";
import {
  NO_PROGRESS_LIMIT,
  OWNER_LAPSE_MS,
  SETTLE_MS,
  claim,
  defectId,
  explain,
  fromFixingFlag,
  lapse,
  buildKey,
  mayRetry,
  openRepair,
  outcome,
  published,
  recordAttempt,
  recordCleanup,
  release,
  section,
  verifyLive,
  type Defect,
  type Found,
} from "../src/shared/repairs";
import { readRepairs } from "../src/server/app";

const APP = "f00dcafe-0000-4000-8000-000000000001";
const defect = (kind: Defect["kind"], field: string, detail = "x"): Defect => ({ id: defectId(kind, field, detail), kind, field, detail, status: "open" });
const found = (...defects: Defect[]): Found => ({ defects, userActions: [] });
const city = defect("lost-value", "City");
const degree = defect("widget", "Degree");

test("repair evidence ties changes and loading controls to the capture without dumping request data", () => {
  const capture: Evidence = { id: "check", applicationId: APP, frames: [{ observation: { pendingFields: ["Clearance"],
    fields: [{ label: "Major", kind: "select", required: true, value: "Data Science" }] } }] };
  const before: Evidence = { id: "before", applicationId: APP, frames: [{ observation: { fields: [{ label: "Major", kind: "select", required: true, value: "" }] } }] };
  const summary = summarizeEvidence(capture, [], [
    { request: { method: "GET", url: "https://careers.example/ExtraInformationDictionary?limit=1&secret=test-secret" }, response: { status: 400 } },
    { request: { method: "POST", url: "https://careers.example/education" }, response: { status: 400, content: { text: "Validation Successful" } } },
  ], "Major", before);
  assert.equal(summary.captureId, "check");
  assert.deepEqual(summary.loading, ["Clearance"]);
  assert.equal(summary.changedAfterReload?.[0].after, "Data Science");
  assert.equal(summary.requests[0].kind, "saved option lookup");
  assert.equal(summary.requests[1].validation, "response says validation successful");
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
  assert.equal(findDefects(capture).defects.find((item) => item.field === "Clearance")?.kind, "widget");
});

test("a manual cleanup stays open until a verified refill reproduces the fix", () => {
  const open = claim(openRepair(undefined, { applicationId: APP, ...found(degree) }, 1), "fixer", 2, "fixing Degree");
  const cleaned = recordCleanup(open, [degree.id], "manual", 3);
  const check = { capture: "unchanged", settledMs: SETTLE_MS, codeChanged: true, found: found(), confirmed: [degree.id] };
  const unchanged = verifyLive(cleaned, check, 4);
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.repair.defects[0].cleanedIn, "manual");
  const handoff = release(cleaned, 4, "The repaired page is ready");
  assert.equal(handoff.nextAction, undefined);
  assert.equal(handoff.defects[0].status, "open");
  const verified = verifyLive(handoff, { ...check, proven: [degree.id] }, 5);
  assert.equal(verified.ok, true);
  const repeated = verifyLive(verified.repair, { ...check, found: found(degree) }, 6);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.repair.state, "needs-fixing");
  assert.equal(repeated.repair.verification, undefined);
  assert.equal(repeated.repair.defects[0].cleanedIn, undefined);
});

// What a fill's capture or a report shows, read the way the repair records
// need it: a blank required field alone is no defect; the fill
// saying it had the answer and failed makes it one; what only the applicant
// can do is listed for them.
test("a capture's defects are what the software can fix, apart from what the applicant must do", () => {
  const evidence: Evidence = {
    id: "capture-1",
    tab: { ats: "Workday" },
    application: {
      missing: [
        "Degree: not filled (the list did not open).",
        'Left "Signature" for you: type your full name to sign.',
        "Required: Middle name (left alone: your edit lock holds it)",
        "Please complete the CAPTCHA before continuing.",
      ],
      attempts: [{ status: "needs-review", note: "Review the items below.", completedAt: 1 }],
    },
    frames: [{ observation: { fields: [
      { label: "Degree", kind: "select", required: true, value: "", options: ["Bachelor's", "Master's"] },
      { label: "Phone extension", kind: "text", required: true, value: "" },
      { label: "Postal code", kind: "text", required: true, value: "ABCDE", invalid: true },
      { label: "City", kind: "text", required: true, value: "", fillWarning: "The site cleared the value after it was filled." },
    ] } }],
  };
  const result = findDefects(evidence);
  const byField = Object.fromEntries(result.defects.map((item) => [item.field, item.kind]));
  assert.equal(byField.Degree, "widget");
  assert.equal(byField["Postal code"], "rejected");
  assert.equal(byField.City, "lost-value");
  // Empty and required, with nothing saying an answer existed: not a defect.
  assert.equal(byField["Phone extension"], undefined);
  assert.ok(result.userActions.some((action) => /Signature/.test(action)));
  assert.ok(result.userActions.some((action) => /Middle name.*Unlock empty fields/.test(action)));
  assert.ok(result.userActions.some((action) => /CAPTCHA/.test(action)));
  assert.ok(!result.defects.some((item) => /Signature|Middle name|CAPTCHA/i.test(`${item.field} ${item.detail}`)));
});

test("a repair is needed, owned, and released only when every targeted defect is gone on a settled page", () => {
  let repair = openRepair(undefined, { applicationId: APP, evidence: { kind: "report", id: "r1" }, ...found(city, degree) }, 1000);
  assert.equal(section(repair), "needs fixing");
  repair = claim(repair, "fixer", 2000, "port the address fix");
  assert.equal(section(repair), "being fixed");
  // Too soon after the fill: the site's late changes could still undo it.
  const early = verifyLive(repair, { capture: "c0", settledMs: SETTLE_MS - 1, found: found(), codeChanged: true }, 3000);
  assert.equal(early.ok, false);
  assert.match((early as { why: string }).why, /settled/);
  // One of two fixed: progress, not a verified repair.
  const half = verifyLive(repair, { capture: "c1", build: "abc", settledMs: SETTLE_MS, found: found(degree), codeChanged: true }, 4000);
  assert.equal(half.ok, false);
  assert.equal(section(half.repair), "being fixed");
  assert.equal(outcome(half.repair), "partial");
  assert.deepEqual(half.repair.attempts.at(-1)!.resolved, [city.id]);
  // Both gone, but a new problem appeared: still not released.
  const newly = defect("rejected", "Email");
  const worse = verifyLive(half.repair, { capture: "c2", settledMs: SETTLE_MS, found: found(newly), codeChanged: true }, 5000);
  assert.equal(worse.ok, false);
  assert.match((worse as { why: string }).why, /1 newly found/);
  // Everything gone: released, verified live, its regression pending.
  const done = verifyLive(worse.repair, { capture: "c3", build: "abd", settledMs: SETTLE_MS + 5000, found: found(), codeChanged: true }, 6000);
  assert.equal(done.ok, true);
  assert.equal(section(done.repair), undefined);
  assert.equal(done.repair.verification?.capture, "c3");
  assert.equal(done.repair.regression, "pending");
  assert.equal(outcome(done.repair), "fixed");
  // Published only once the cause is on the record, which outlasts the note.
  assert.throws(() => published(done.repair, "1234567", 7000), /No cause on the record/);
  const explained = explain(done.repair, "  The City list loads its options only once opened,\n so the fill read it as empty. ", 6500);
  assert.equal(explained.cause, "The City list loads its options only once opened, so the fill read it as empty.");
  assert.throws(() => explain(done.repair, "   ", 6500), /Say why/);
  assert.equal(release(explained, 6600, "the rest is theirs").cause, explained.cause, "a later note leaves the cause");
  assert.equal(published(explained, "1234567", 7000).regression, "published");
  // Seen again later: back in the queue.
  const again = openRepair(done.repair, { applicationId: APP, evidence: { kind: "capture", id: "c4" }, ...found(city) }, 8000);
  assert.equal(section(again), "needs fixing");
  assert.equal(again.verification, undefined);
});

test("a defect described in words is resolved only when the fixer confirms it", () => {
  const words: Defect = { ...defect("other", "", "Languages were left empty"), manual: true };
  const repair = claim(openRepair(undefined, { applicationId: APP, ...found(words) }, 1), "fixer", 2);
  // A capture that does not mention it proves nothing.
  const silent = verifyLive(repair, { capture: "c1", settledMs: SETTLE_MS, found: found(), codeChanged: true }, 3);
  assert.equal(silent.ok, false);
  const confirmed = verifyLive(repair, { capture: "c2", settledMs: SETTLE_MS, found: found(), codeChanged: true, confirmed: [words.id] }, 4);
  assert.equal(confirmed.ok, true);
  // The old being-fixed flag carries over the same way.
  const carried = fromFixingFlag(APP, { since: 10, note: "Litware: address and languages" }, 20);
  assert.equal(section(carried), "being fixed");
  assert.equal(carried.defects[0].manual, true);
});

test("a new build loaded starts the count of refills that changed nothing again", () => {
  let repair = claim(openRepair(undefined, { applicationId: APP, ...found(city) }, 1), "fixer", 2);
  const old = buildKey({ commit: "abc123+changes", builtAt: 1000 });
  const loaded = buildKey({ commit: "abc123+changes", builtAt: 900_000 });
  for (let n = 0; n < NO_PROGRESS_LIMIT; n++) repair = recordAttempt(repair, { reason: "repair", build: old, capture: `c${n}`, found: found(city) }, 10 + n);
  assert.match(repair.blocker || "", /changed nothing/);
  assert.equal(mayRetry(repair, "repair", old).ok, false);
  // The same commit rebuilt is another build: the refill may run.
  assert.equal(mayRetry(repair, "repair", loaded).ok, true);
  // A check on it that changes nothing does not block at once.
  repair = recordAttempt(repair, { reason: "repair", build: loaded, capture: "c7", found: found(city) }, 30);
  assert.equal(repair.blocker, undefined);
  assert.equal(mayRetry(repair, "repair", loaded).ok, true);
  for (let n = 0; n < NO_PROGRESS_LIMIT - 1; n++) repair = recordAttempt(repair, { reason: "repair", build: loaded, capture: `d${n}`, found: found(city) }, 40 + n);
  assert.equal(mayRetry(repair, "repair", loaded).ok, false);
});

test("refills need a reason, and stop after refills that change nothing", () => {
  let repair = claim(openRepair(undefined, { applicationId: APP, ...found(city) }, 1), "fixer", 2);
  assert.equal(mayRetry(repair, undefined).ok, false);
  assert.equal(mayRetry(repair, "repair").ok, true);
  for (let n = 0; n < NO_PROGRESS_LIMIT; n++) repair = recordAttempt(repair, { reason: "page", capture: `c${n}`, found: found(city) }, 10 + n);
  assert.match(repair.blocker || "", /changed nothing/);
  assert.equal(mayRetry(repair, "profile").ok, false);
  // A check after a fix that resolves a defect lifts the block.
  const town = defect("lost-value", "Town");
  const twice = recordAttempt(repair, { reason: "repair", capture: "c8", found: found(city, town) }, 20);
  const fixed = recordAttempt(twice, { reason: "repair", capture: "c9", found: found(town) }, 21);
  assert.equal(fixed.blocker, undefined);
  assert.equal(mayRetry(fixed, "repair").ok, true);
  // Given back with its defect open, saying why: the record keeps it open.
  const back = release(repair, 100, "The site refuses the city list; the applicant picks it.");
  assert.equal(section(back), undefined);
  assert.equal(back.defects[0].status, "open");
  assert.equal(outcome(back), "blocked");
  // A repair with a regression and no live check is not "fixed".
  assert.equal(outcome({ ...repair, blocker: undefined, regression: "pending" }), "needs-live-check");
});

test("an owner gone quiet gives the repair back with its defects open, and the old flags carry over", async () => {
  const repair = claim(openRepair(undefined, { applicationId: APP, ...found(city) }, 1), "subagent-3", 1000);
  assert.equal(lapse(repair, 1000 + OWNER_LAPSE_MS - 1), repair);
  const lapsed = lapse(repair, 1000 + OWNER_LAPSE_MS);
  assert.equal(section(lapsed), "needs fixing");
  assert.equal(lapsed.owner, undefined);
  assert.equal(lapsed.defects[0].status, "open");
  assert.match(lapsed.note || "", /subagent-3 stopped/);

  const directory = await mkdtemp(join(tmpdir(), "lane-repairs-"));
  await writeFile(join(directory, "fixing.json"), JSON.stringify({ [APP]: { since: 5, note: "Acme: education entries" } }));
  const now = 5 + OWNER_LAPSE_MS + 1;
  const repairs = await readRepairs(directory, now);
  assert.equal(existsSync(join(directory, "fixing.json")), false);
  // Carried over, and its owner has been quiet since: back in the queue.
  assert.equal(section(repairs[APP]), "needs fixing");
  assert.match(repairs[APP].defects[0].detail, /education entries/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "repairs.json"), "utf8"))[APP].state, "needs-fixing");
});

// A file the lane has no document for (a photo) is the applicant's to
// attach; an unattached résumé is the fill's (Bask Health's Workable form).
test("only an unattached document the lane makes is an upload defect", async () => {
  const { findDefects } = await import("../scripts/repair-evidence");
  const found = findDefects({ id: "c1", application: { missing: ["Choose a file manually: Photo Choose file", "Choose a file manually: Resume"] } });
  assert.deepEqual(found.defects.map((defect) => [defect.kind, defect.field]), [["upload", "Resume"]]);
  assert.match(found.userActions.join(" "), /Photo/);
});

test("a list that holds an option's code is no wrong value when the option's text is among its options", () => {
  // An Avature page's selects hold codes ("233") for options shown as text.
  const found = findDefects({ id: "c2", frames: [{ observation: { fields: [
    { label: "Country", kind: "select", value: "233", valueText: "United States", options: ["Mexico", "United States"] },
    { label: "Region", kind: "select", value: "4802", valueText: "Atlantis", options: ["Ohio", "Texas"] },
  ] } }] });
  assert.deepEqual(found.defects.map((defect) => defect.field), ["Region"]);
});
