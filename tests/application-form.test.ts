import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationForm } from "../src/extension/application-form";
import type { Field, Observation } from "../src/shared/model";

const field = (kind: string, label: string, extra: Partial<Field> = {}): Field => ({
  id: "field", kind, label, value: "", required: true, protected: false, options: [], revision: 1, ...extra,
});
const page = (changes: Partial<Observation>): Observation => ({
  documentId: "document", url: "https://careers.example.test/documents", title: "Documents", description: "", ats: "generic",
  fields: [], paused: false, blockers: [], canAdvance: false, atReview: false, ...changes,
});

test("a requested fill may attach a named document without using it as proof for a repair", () => {
  const documents = page({ fields: [field("file", "Cover Letter", { documentKind: "cover" })] });
  assert.equal(applicationForm(documents, { allowNamedUpload: true }), true);
  assert.equal(applicationForm(documents), false);
  assert.equal(applicationForm({ ...documents, applicationContainer: true }), true);
  assert.equal(applicationForm(page({ fields: [field("file", "Choose a file")] }), { allowNamedUpload: true }), false);

  const listing = { ...documents, url: "https://example.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs" };
  assert.equal(applicationForm(listing, { allowNamedUpload: true }), false);
});

test("a password prompt still blocks a bare sign-in page but allows a recognized application", () => {
  const signIn = page({
    fields: [field("email", "Email")], atReview: true, blockers: ["Sign in or create your account manually."],
  });
  assert.equal(applicationForm(signIn, { allowNamedUpload: true }), false);
  assert.equal(applicationForm({ ...signIn, applicationContainer: true }), true);
});
