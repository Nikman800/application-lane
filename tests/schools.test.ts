import assert from "node:assert/strict";
import { test } from "node:test";
import { schoolNames } from "../src/shared/schools";

test("finds the formal name and short name for IIT Bombay in either direction", () => {
  assert.ok(
    schoolNames("IIT Bombay").includes("Indian Institute of Technology Bombay"),
  );
  assert.ok(
    schoolNames("Indian Institute of Technology Bombay").includes("IIT Bombay"),
  );
});

test("keeps IIT Delhi and IIT Madras distinct from IIT Bombay and from IIT on its own", () => {
  assert.ok(
    schoolNames("IIT Delhi").includes("Indian Institute of Technology Delhi"),
  );
  assert.ok(
    schoolNames("IIT Madras").includes("Indian Institute of Technology Madras"),
  );
  assert.ok(!schoolNames("IIT Delhi").includes("IIT Bombay"));
  assert.ok(!schoolNames("IIT Madras").includes("IIT Bombay"));
  assert.deepEqual(schoolNames("IIT"), []);
});
