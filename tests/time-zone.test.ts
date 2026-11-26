import { test } from "node:test";
import assert from "node:assert/strict";
import { profileSchema, type Field } from "../src/shared/model";
import { proposals } from "../src/shared/matching";

const check = (kind: "equal" | "deepEqual", actual: unknown, expected: unknown) => assert[kind](actual, expected, "time zone answer");
const base = { firstName: "Alex", lastName: "Rivera", email: "alex@example.test", facts: [], confirmed: true };
const phoenix = profileSchema.parse({ ...base, timeZone: "America/Phoenix" });
const newYork = profileSchema.parse({ ...base, timeZone: "America/New_York" });
const field = (label: string, options: string[], kind: Field["kind"] = "select"): Field => ({
  id: label, label, kind, required: true, value: "", options, revision: 1, protected: false, section: "Preferences",
});
const ask = (options: string[], who = phoenix, label = "Time Zone", kind: Field["kind"] = "select") => proposals([field(label, options, kind)], who)[0];

test("the saved zone round-trips through the profile schema", () => {
  check("equal", profileSchema.parse(base).timeZone, "");
  check("equal", phoenix.timeZone, "America/Phoenix");
});

test("America/Phoenix picks its option in every wording", () => {
  const wanted = [
    "America/Phoenix", "-07:00 (Etc/GMT+7)", "−07:00", "GMT-7", "GMT-07:00", "UTC-7", "UTC−07:00", "-0700",
    "(GMT-07:00) Arizona", "Mountain Standard Time (MST)", "Arizona", "Phoenix", "Etc/GMT+7",
  ];
  const others = ["+07:00 (Etc/GMT-7)", "(GMT-08:00) Pacific Time", "Eastern Time (ET)", "UTC+7", "Etc/GMT-7", "America/New_York"];
  for (const option of wanted)
    check("equal", ask([...others, option])?.value, option);
});

test("a weaker region name is chosen only when nothing stronger is listed", () => {
  check("equal", ask(["Eastern", "Pacific Time (PT)", "Mountain Time"])?.value, "Mountain Time");
  check("equal", ask(["Mountain Time", "Mountain Standard Time (MST)"])?.value, "Mountain Standard Time (MST)");
  check("equal", ask(["Pacific Time (PT)", "Eastern"]), undefined);
});

test("the opposite-sign option is never chosen for America/Phoenix", () => {
  check("equal", ask(["+07:00 (Etc/GMT-7)", "-07:00 (Etc/GMT+7)"])?.value, "-07:00 (Etc/GMT+7)");
  check("equal", ask(["+07:00 (Etc/GMT-7)", "+07:00", "UTC+7", "GMT+7"]), undefined);
  check("equal", ask(["Mountain Time (GMT-06:00)"]), undefined);
});

test("an Eastern zone picks an Eastern option by name and by its current offset", () => {
  check("equal", ask(["Pacific Time (PT)", "Eastern Time (ET)", "Central"], newYork)?.value, "Eastern Time (ET)");
  check("equal", ask(["Eastern"], newYork)?.value, "Eastern");
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).format(new Date()).match(/GMT([+\-−]\d\d:\d\d)/)![1];
  check("equal", ask(["-07:00", offset], newYork)?.value, offset);
});

test("a search list without listed options gets candidates to search with", () => {
  const phoenixAnswer = ask([], phoenix, "Time Zone", "combobox");
  check("equal", phoenixAnswer?.value, "America/Phoenix");
  check("deepEqual", phoenixAnswer?.choices, ["-07:00", "Arizona", "Mountain"]);
  check("equal", ask([], newYork, "Time Zone", "combobox").choices?.[0], new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
    .format(new Date()).match(/GMT([+\-−]\d\d:\d\d)/)![1].replace("−", "-"));
});

test("time zone question wordings are recognised", () => {
  for (const label of ["Time Zone", "What time zone are you in?", "Your timezone", "Which time zone do you work in?", "Time zone *"])
    check("equal", ask(["-07:00 (Etc/GMT+7)"], phoenix, label)?.value, "-07:00 (Etc/GMT+7)");
  check("equal", ask(["-07:00"], phoenix, "Are you comfortable working in a different time zone from the team?"), undefined);
});

test("no saved zone proposes nothing", () => {
  const none = profileSchema.parse(base);
  check("equal", ask(["-07:00 (Etc/GMT+7)"], none), undefined);
  check("equal", ask([], none, "Time Zone", "combobox"), undefined);
});
