import { test } from "node:test";
import assert from "node:assert/strict";
import { laneGroup } from "../src/shared/lane-groups";
import { ownGroup, planTabGroups, wantedGroups, type GroupFacts, type TabFacts } from "../src/extension/tab-group-plan";
import type { Application } from "../src/shared/model";

const app = (id: string, over: Partial<Application> = {}) =>
  ({ id, status: "awaiting-user", workflowStage: "applying", attempts: [], tabs: [], ...over }) as unknown as Application;
const tab = (id: number, over: Partial<TabFacts> = {}): TabFacts => ({ id, windowId: 1, groupId: -1, pinned: false, ...over });

test("an application's group is the command line's", () => {
  assert.equal(laneGroup({ status: "awaiting-user", stage: "applying" }), "needs you");
  assert.equal(laneGroup({ status: "filling", stage: "applying" }), "in progress");
  assert.equal(laneGroup({ status: "ready", stage: "review" }), "ready to review");
  assert.equal(laneGroup({ status: "ready", stage: "review", assisting: true }), "in progress");
  assert.equal(laneGroup({ status: "paused", stage: "applying", lastFill: { status: "error" } }), "failed");
  assert.equal(laneGroup({ status: "failed", stage: "applying" }, "being fixed"), "being fixed");
  assert.equal(laneGroup({ status: "ready", stage: "submitted" }, "needs fixing"), "submitted");
  assert.equal(laneGroup({ status: "cancelled", stage: "abandoned" }), "closed");
});

test("only this extension's own group titles are recognised", () => {
  assert.equal(ownGroup("Needs you · 3"), "needs you");
  assert.equal(ownGroup("Ready to review"), "ready to review");
  assert.equal(ownGroup("Jobs I like"), undefined);
  assert.equal(ownGroup(undefined), undefined);
});

test("form tabs and their related tabs are wanted in the stage's group; submitted, closed and archived ones are not", () => {
  const wanted = wantedGroups(
    [
      app("a", { tabId: 1, tabs: [{ tabId: 2, state: "form" }, { tabId: 3, state: "closed" }] as Application["tabs"] }),
      app("b", { tabId: 4, status: "filling" }),
      app("c", { tabId: 5, workflowStage: "submitted" }),
      app("d", { tabId: 6, archivedAt: 1 }),
      app("e", { tabId: 7, status: "failed" }),
    ],
    { e: "being fixed" },
  );
  assert.deepEqual([...wanted.entries()].sort(([x], [y]) => x - y), [
    [1, { group: "needs you", app: "a" }],
    [2, { group: "needs you", app: "a" }],
    [4, { group: "in progress", app: "b" }],
    [7, { group: "being fixed", app: "e" }],
  ]);
});

test("new groups are made per window and stage, titled with how many applications are in them", () => {
  const wanted = new Map([
    [1, { group: "needs you" as const, app: "a" }],
    [2, { group: "needs you" as const, app: "a" }],
    [3, { group: "needs you" as const, app: "b" }],
    [4, { group: "in progress" as const, app: "c" }],
  ]);
  const steps = planTabGroups([tab(1), tab(2), tab(3, { windowId: 2 }), tab(4)], [], wanted);
  assert.deepEqual(steps, [
    { kind: "group", windowId: 1, group: "needs you", tabIds: [1, 2], title: "Needs you · 1", color: "orange", retitle: true },
    { kind: "group", windowId: 2, group: "needs you", tabIds: [3], title: "Needs you · 1", color: "orange", retitle: true },
    { kind: "group", windowId: 1, group: "in progress", tabIds: [4], title: "In progress · 1", color: "blue", retitle: true },
  ]);
});

test("a tab moves between this extension's groups, leaves them when done, and is otherwise left alone", () => {
  const groups: GroupFacts[] = [
    { id: 10, windowId: 1, title: "In progress · 1", color: "blue" },
    { id: 11, windowId: 1, title: "Needs you · 1", color: "orange" },
    { id: 12, windowId: 1, title: "My shortlist", color: "purple" },
  ];
  const wanted = new Map([
    [1, { group: "needs you" as const, app: "a" }],
    [2, { group: "needs you" as const, app: "b" }],
    [5, { group: "ready to review" as const, app: "e" }],
    [6, { group: "needs you" as const, app: "f" }],
  ]);
  const steps = planTabGroups(
    [
      tab(1, { groupId: 10 }), // was in progress, now needs you
      tab(2, { groupId: 11 }), // already there
      tab(3, { groupId: 10 }), // submitted: out of the group
      tab(5, { groupId: 12 }), // in the applicant's own group: stays
      tab(6, { pinned: true }), // pinned: stays pinned and ungrouped
      tab(7), // not an application's
    ],
    groups,
    wanted,
  );
  assert.deepEqual(steps, [
    { kind: "ungroup", tabIds: [3] },
    { kind: "group", windowId: 1, group: "needs you", groupId: 11, tabIds: [1], title: "Needs you · 2", color: "orange", retitle: true },
  ]);
});

test("nothing changes when every tab is already where it belongs", () => {
  const steps = planTabGroups(
    [tab(1, { groupId: 11 })],
    [{ id: 11, windowId: 1, title: "Needs you · 1", color: "orange" }],
    new Map([[1, { group: "needs you" as const, app: "a" }]]),
  );
  assert.deepEqual(steps, []);
});

test("turned off, every tab leaves this extension's groups", () => {
  const steps = planTabGroups(
    [tab(1, { groupId: 11 }), tab(2, { groupId: 12 })],
    [
      { id: 11, windowId: 1, title: "Needs you · 1", color: "orange" },
      { id: 12, windowId: 1, title: "My shortlist", color: "purple" },
    ],
    new Map(),
  );
  assert.deepEqual(steps, [{ kind: "ungroup", tabIds: [1] }]);
});
