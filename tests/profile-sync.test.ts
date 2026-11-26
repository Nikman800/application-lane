import { test } from "node:test";
import assert from "node:assert/strict";
import { profileSchema } from "../src/shared/model";
import {
  conflictWarning,
  graduationFor,
  graduationRule,
  internshipRole,
  markdownEntries,
  profileConflicts,
  profileFingerprint,
} from "../src/server/profile-sync";

// preferences.md and profile.md as the job-applier checkout writes them.
const preferences = `## Education timeline (confirmed)
- **Graduation:** December 13, 2027 (end of Fall 2027, he stays enrolled through the Fall
  term).
## Logistics (confirmed)
- **Work authorization:** U.S. citizen. No visa sponsorship needed, now or ever.
- **Requires visa sponsorship (now or in future)?** No.
- **Relocation:** Yes, open to relocating anywhere.
- **Veteran / military status:** No (not a veteran, reservist, or military spouse).
- **Home base:** Tucson, AZ.`;
const masterProfile = "## Education\n- **Michigan State University** — M.S., expected December 13, 2027. GPA 3.84.";

const profile = (overrides: object = {}) =>
  profileSchema.parse({
    firstName: "Alex",
    lastName: "Fixture",
    email: "t@example.test",
    confirmed: true,
    facts: [],
    city: "Tucson",
    state: "Arizona",
    gpa: "3.84",
    workAuthorization: "Yes",
    sponsorship: "No",
    willingToRelocate: "Yes",
    veteranStatus: "I am not a protected veteran",
    education: [
      { organization: "Penn State", title: "B.S.", startDate: "2020-09", endDate: "2024-06" },
      { organization: "Michigan State University", title: "M.S.", startDate: "2025-08", endDate: "2027-12" },
    ],
    ...overrides,
  });

test("markdown entries read bold labels, question labels and wrapped lines", () => {
  const entries = markdownEntries(preferences);
  assert.equal(entries.get("requires visa sponsorship (now or in future)"), "No.");
  assert.match(entries.get("graduation")!, /December 13, 2027 .*term\)\.$/);
});

test("matching answers written differently are not disagreements", () => {
  // "U.S. citizen" reads as authorized, "No (not a veteran…)" as No.
  assert.deepEqual(profileConflicts(profile(), { preferences, profile: masterProfile }), []);
  // An answer missing on one side is not a contradiction either.
  assert.deepEqual(profileConflicts(profile({ sponsorship: "", gpa: "" }), { preferences, profile: masterProfile }), []);
});

test("each real disagreement is named with both values and the file", () => {
  const conflicts = profileConflicts(
    profile({
      sponsorship: "Yes",
      willingToRelocate: "No",
      city: "Seattle",
      gpa: "3.6",
      education: [{ organization: "Michigan State University", title: "M.S.", startDate: "2025-08", endDate: "2027-05" }],
    }),
    { preferences, profile: masterProfile },
  );
  assert.deepEqual(
    conflicts.map((c) => [c.field, c.extension, c.file]),
    [
      ["Visa sponsorship", "Yes", "preferences.md"],
      ["Relocation", "No", "preferences.md"],
      ["Home city", "Seattle, Arizona", "preferences.md"],
      ["Graduation", "2027-05", "preferences.md"],
      ["GPA", "3.6", "profile.md"],
    ],
  );
  assert.match(conflictWarning(conflicts)[0], /disagree.*Visa sponsorship \(extension: Yes; preferences.md: No\.\)/);
  assert.deepEqual(conflictWarning([]), []);
});

test("the written-answer graduation rule recognizes internships and full-time jobs", () => {
  const rule = graduationRule(
    "## Education timeline\n- **Graduation by role:** internships and co-ops: December 13, 2027. Full-time and new-grad roles: May 10, 2027.",
  );
  assert.deepEqual(rule, { internship: "2027-12", fullTime: "2027-05" });
  assert.equal(internshipRole("Software Engineer Intern (Summer 2027)"), true);
  assert.equal(internshipRole("Co-op, Data Engineering"), true);
  assert.equal(internshipRole("Internal Tools Engineer"), false);
  // Banks name internships after the season (Bank of America).
  assert.equal(graduationFor(rule, "Global Technology Summer Analyst 2027 - Software Engineer and Mainframe Analyst"), "2027-12");
  assert.equal(internshipRole("Investment Banking Summer Associate"), true);
  assert.equal(internshipRole("Analyst, Summer Reading Program Technology"), false);
  assert.equal(graduationFor(rule, "Software Engineer, New Grad"), "2027-05");
});

test("either graduation month in the written-answer rule agrees with the profile", () => {
  const base = profile({ education: [
    { organization: "MSU", title: "M.S.", startDate: "2025-08", endDate: "2027-05-10" },
  ] });
  // Either of the rule's dates agrees with the extension profile.
  const both = "- **Graduation:** December 13, 2027.\n- **Graduation by role:** internships: December 13, 2027. Full-time: May 10, 2027.";
  assert.deepEqual(profileConflicts(base, { preferences: both, profile: masterProfile }), []);
  assert.equal(profileConflicts(base, { preferences: "- **Graduation:** December 13, 2027.", profile: masterProfile })[0].field, "Graduation");
});

test("the profile fingerprint is stable, follows answers, and ignores revision and timestamps", () => {
  const base = () => profileSchema.parse({ firstName: "Alex", lastName: "Rivera", email: "alex.rivera@example.com", confirmed: true, facts: [], answers: [{ question: "Pronouns?", answer: "they/them" }] });
  const a = base();
  assert.match(profileFingerprint(a), /^[0-9a-f]{64}$/);
  assert.equal(profileFingerprint(a), profileFingerprint(base()));
  assert.equal(profileFingerprint({ ...a, revision: 9, updatedAt: 5 } as any), profileFingerprint(a));
  assert.notEqual(profileFingerprint({ ...a, answers: [{ question: "Pronouns?", answer: "she/her" }] }), profileFingerprint(a));
  assert.notEqual(profileFingerprint({ ...a, city: "Acme City" }), profileFingerprint(a));
});

// "(ex. Contoso, Northwind, etc.)" is an abbreviation, not the end of a
// sentence: split there, the question kept only "or who have pending
// offers?", lost its "relatives" and was not read as a relatives question.
test("a question with an \"(ex. …)\" list is asked as a whole", async () => {
  const { askedPart } = await import("../src/shared/standing");
  const question = "Do you have relatives who are currently employed by an Acme affiliated company (ex. Contoso, Northwind, etc.), or who have pending offers?";
  assert.equal(askedPart(question), question);
});
