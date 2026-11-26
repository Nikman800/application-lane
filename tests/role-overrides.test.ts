import { test } from "node:test";
import assert from "node:assert/strict";
import { forRole, overrideFor, profileSchema } from "../src/shared/model";
import { proposals } from "../src/shared/matching";

// Different values for some kinds of job: an applicant who stays
// enrolled a term longer for internships gives those a later graduation date
// ("If you are a current university student, please provide your anticipated
// graduation date?" was given the full-time date on an internship).
const applicant = profileSchema.parse({
  confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", facts: [],
  education: [
    { organization: "Michigan State University", title: "Master of Science", startDate: "2025-08", endDate: "2099-05-10", location: "", details: "" },
    { organization: "Penn State", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06-15", location: "", details: "" },
  ],
  roleOverrides: [{ name: "Internships & co-ops", titleWords: ["intern", "internship", "co-op"], education: [{ index: 0, endDate: "2099-12-13" }] }],
});

test("a job's title selects its type's values, by whole words", () => {
  assert.equal(overrideFor(applicant.roleOverrides, "Software Engineer Intern - Summer 2027")?.name, "Internships & co-ops");
  assert.equal(overrideFor(applicant.roleOverrides, "Co-op, Data Science")?.name, "Internships & co-ops");
  // A plural title is the same kind of job.
  assert.equal(overrideFor(applicant.roleOverrides, "Software Engineering Internships – Summer 2027")?.name, "Internships & co-ops");
  assert.equal(overrideFor(applicant.roleOverrides, "International Sales Engineer"), undefined);
  assert.equal(overrideFor(applicant.roleOverrides, "Software Engineer, New Grad"), undefined);
});

test("an internship's graduation questions take its type's end date, other jobs the profile's", () => {
  const question = { id: "x", label: "If you are a current university student, please provide your anticipated graduation date?", kind: "datepicker", required: false, value: "", options: [], revision: 1, protected: false };
  const intern = forRole(applicant, "Data Science Intern");
  assert.equal(intern.education[0].endDate, "2099-12-13");
  assert.equal(intern.education[1].endDate, "2024-06-15");
  assert.equal(proposals([question], intern)[0]?.value, "2099-12-13");
  const fullTime = forRole(applicant, "Data Scientist I");
  assert.equal(fullTime.education[0].endDate, "2099-05-10");
  assert.equal(proposals([question], fullTime)[0]?.value, "2099-05-10");
});

test("a job-type hours override can apply by itself and keeps other roles at the default", () => {
  const saved = profileSchema.parse({
    ...applicant,
    availableFullTime: false,
    roleOverrides: [{ name: "Internships", titleWords: ["summer analyst", "summer associate"], availableFullTime: true }],
  });
  const question = { id: "hours", label: "Are you available to work full-time?", kind: "select", required: false, value: "", options: ["Yes", "No"], revision: 1, protected: false };
  const intern = forRole(saved, "Technology Summer Analyst");
  assert.equal(proposals([question], intern)[0]?.value, "Yes");
  assert.equal(proposals([question], forRole(saved, "Technology Engineer"))[0]?.value, "No");
  assert.equal(intern.education[0].endDate, saved.education[0].endDate);
  assert.equal(saved.availableFullTime, false);
});
