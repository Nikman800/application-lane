import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardTabs, noteLifetimeMs, tabsToReopen } from "../src/extension/dashboard-reopen";

const base = "chrome-extension://abc/dashboard.html";
const tab = (url: string, over = {}) => ({ windowId: 1, index: 0, url, active: false, pinned: false, groupId: -1, ...over });

test("only the dashboard's tabs are noted, with the page each shows", () => {
  const noted = dashboardTabs([
    tab("https://jobs.example.com/apply"),
    tab(`${base}#issues`, { index: 4, active: true }),
    tab("chrome-extension://abc/panel.html"),
    tab(`${base}#settings`, { windowId: 2, index: 1, groupId: 7 }),
    tab(`${base}#<script>`, { index: 2 }),
  ], base);
  assert.deepEqual(noted.map((t) => [t.windowId, t.index, t.hash, t.groupId]), [[1, 2, "", -1], [1, 4, "issues", -1], [2, 1, "settings", 7]]);
});

test("a reload opens the noted tabs not already open, and an old note opens none", () => {
  const now = 1_000_000_000;
  const note = { savedAt: now - 1000, tabs: dashboardTabs([tab(`${base}#profile`), tab(`${base}#issues`, { index: 3 })], base) };
  assert.deepEqual(tabsToReopen(note, 0, now).map((t) => t.hash), ["profile", "issues"]);
  assert.deepEqual(tabsToReopen(note, 1, now).map((t) => t.hash), ["issues"]);
  assert.deepEqual(tabsToReopen(note, 2, now), []);
  assert.deepEqual(tabsToReopen({ ...note, savedAt: now - noteLifetimeMs - 1 }, 0, now), []);
  assert.deepEqual(tabsToReopen(undefined, 0, now), []);
});
