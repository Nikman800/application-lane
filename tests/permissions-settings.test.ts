import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProfile, profileSchema, withPermissions } from "../src/shared/model";

const saved = (fields: Record<string, unknown>) => profileSchema.parse({ ...emptyProfile, ...fields });

test("what a fill may sign and agree to comes from Settings once set there", () => {
  const profile = saved({ signatures: "never", acknowledgeTerms: false });
  assert.deepEqual(
    (({ signatures, acknowledgeTerms }) => ({ signatures, acknowledgeTerms }))(withPermissions(profile, { signatures: "self-id", agreeToTerms: "on" })),
    { signatures: "self-id", acknowledgeTerms: true },
  );
  // Settings saying no wins over a profile that allowed it.
  const allowed = saved({ signatures: "all", acknowledgeTerms: true });
  const off = withPermissions(allowed, { signatures: "never", agreeToTerms: "off" });
  assert.equal(off.signatures, "never");
  assert.equal(off.acknowledgeTerms, false);
});

test("until Settings sets them, what the profile saved before still counts", () => {
  const kept = withPermissions(saved({ signatures: "self-id", acknowledgeTerms: true }), {});
  assert.equal(kept.signatures, "self-id");
  assert.equal(kept.acknowledgeTerms, true);
  const nothing = withPermissions(saved({}), {});
  assert.equal(nothing.signatures, "never");
  assert.equal(nothing.acknowledgeTerms, false);
});
