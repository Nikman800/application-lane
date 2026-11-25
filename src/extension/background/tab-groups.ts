// Part of the extension's service worker (background.ts): Chrome tab groups
// by stage. An application's tabs (its form, and the posting or sign-in tabs
// that go with it) sit in a group named for where it stands ("Needs you · 3",
// "In progress · 1"), the same groups the command line's tabs show
// (src/shared/lane-groups.ts), and move as it moves along. A submitted or
// closed application's tabs leave their group and stay open.
//
// Only groups this extension made are touched, known by their titles: a tab
// the applicant put in a group of their own stays there, and a pinned tab
// is left pinned. Groups live inside one window, so each window's
// application tabs are grouped there. Settings → Processing turns it off,
// which takes the tabs out of these groups.
import { planTabGroups, wantedGroups } from "../tab-group-plan";
import { bg } from "./state";
import { repairState } from "./badges";

export function tabGroupsSoon() {
  clearTimeout(bg.tabGroupTimer);
  bg.tabGroupTimer = setTimeout(() => void syncTabGroups(), 400);
}
let running: Promise<void> | undefined;
let again = false;
async function syncTabGroups() {
  if (running) {
    again = true;
    return;
  }
  running = applyTabGroups().catch(() => {
    /* A tab being dragged, or closed meanwhile: the next change tries again. */
  });
  await running;
  running = undefined;
  if (again) {
    again = false;
    tabGroupsSoon();
  }
}
async function applyTabGroups() {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  const on = bg.state.settings.tabGroups !== "off";
  if (on) await repairState();
  const wanted = on ? wantedGroups(bg.state.applications, bg.repairSections) : new Map();
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowType: "normal" }), chrome.tabGroups.query({})]);
  const steps = planTabGroups(
    tabs.filter((tab) => tab.id !== undefined).map((tab) => ({ id: tab.id!, windowId: tab.windowId, groupId: tab.groupId ?? -1, pinned: tab.pinned })),
    groups.map((group) => ({ id: group.id, windowId: group.windowId, title: group.title, color: group.color })),
    wanted,
  );
  for (const step of steps) {
    if (step.kind === "ungroup") {
      await chrome.tabs.ungroup(step.tabIds);
      continue;
    }
    let groupId = step.groupId;
    if (step.tabIds.length)
      groupId = await chrome.tabs.group(
        groupId !== undefined ? { groupId, tabIds: step.tabIds } : { tabIds: step.tabIds, createProperties: { windowId: step.windowId } },
      );
    if (groupId !== undefined && (step.retitle || step.groupId === undefined))
      await chrome.tabGroups.update(groupId, { title: step.title, color: step.color as chrome.tabGroups.Color });
  }
}
