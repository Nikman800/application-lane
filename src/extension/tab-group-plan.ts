// Which Chrome tab group each application tab belongs in, and what to change
// to get there: the plan background/tab-groups.ts carries out. Kept apart
// from the service worker so it can be tested without Chrome.
import { type Application } from "../shared/model";
import { laneGroup, type LaneGroup } from "../shared/lane-groups";

export type Color = `${chrome.tabGroups.Color}`;
export const stageGroups: Partial<Record<LaneGroup, { title: string; color: Color }>> = {
  "needs you": { title: "Needs you", color: "orange" },
  "needs fixing": { title: "Needs fixing", color: "yellow" },
  "being fixed": { title: "Being fixed", color: "cyan" },
  "in progress": { title: "In progress", color: "blue" },
  failed: { title: "Failed", color: "red" },
  "ready to review": { title: "Ready to review", color: "green" },
};
const byTitle = new Map(Object.entries(stageGroups).map(([group, { title }]) => [title, group as LaneGroup]));
// "Needs you · 3", or the bare title: one of this extension's groups.
export function ownGroup(title: string | undefined): LaneGroup | undefined {
  const match = /^(.+?)(?: · \d+)?$/.exec(title || "");
  return match ? byTitle.get(match[1]) : undefined;
}

// The group each application's tabs belong in. A tab two applications share
// (one sign-in page) goes with the first that claims it: form tabs before
// related ones, then in the order of the groups.
export function wantedGroups(applications: Application[], repairs: Record<string, "needs fixing" | "being fixed" | undefined>) {
  const order = Object.keys(stageGroups);
  const placed = applications
    .filter((app) => !app.archivedAt)
    .map((app) => {
      const last = app.attempts.at(-1);
      const group = laneGroup(
        {
          status: app.status,
          stage: app.workflowStage,
          ...(last ? { lastFill: { status: last.status } } : {}),
          assisting: Boolean(app.assisting && (app.status === "awaiting-user" || app.status === "ready")),
        },
        repairs[app.id],
      );
      return { app, group };
    })
    .filter(({ group }) => stageGroups[group])
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const tabs = new Map<number, { group: LaneGroup; app: string }>();
  for (const { app, group } of placed) if (app.tabId !== undefined && !tabs.has(app.tabId)) tabs.set(app.tabId, { group, app: app.id });
  for (const { app, group } of placed)
    for (const related of app.tabs || [])
      if (related.tabId !== undefined && related.state !== "closed" && !tabs.has(related.tabId)) tabs.set(related.tabId, { group, app: app.id });
  return tabs;
}

export type TabFacts = { id: number; windowId: number; groupId: number; pinned: boolean };
export type GroupFacts = { id: number; windowId: number; title?: string; color: string };
export type GroupStep =
  | { kind: "ungroup"; tabIds: number[] }
  | { kind: "group"; windowId: number; group: LaneGroup; groupId?: number; tabIds: number[]; title: string; color: Color; retitle: boolean };

// What to change, from the tabs and groups as they are.
export function planTabGroups(tabs: TabFacts[], groups: GroupFacts[], wanted: Map<number, { group: LaneGroup; app: string }>): GroupStep[] {
  const ours = new Map<number, { group: LaneGroup; facts: GroupFacts }>();
  for (const facts of groups) {
    const group = ownGroup(facts.title);
    if (group) ours.set(facts.id, { group, facts });
  }
  const ungroup: number[] = [];
  const members = new Map<string, { windowId: number; group: LaneGroup; tabs: TabFacts[]; apps: Set<string> }>();
  for (const tab of tabs) {
    const want = wanted.get(tab.id);
    const inOurs = ours.has(tab.groupId);
    if (!want || tab.pinned) {
      if (inOurs) ungroup.push(tab.id);
      continue;
    }
    // The applicant's own group.
    if (tab.groupId !== -1 && !inOurs) continue;
    const key = `${tab.windowId}|${want.group}`;
    const entry = members.get(key) || { windowId: tab.windowId, group: want.group, tabs: [], apps: new Set<string>() };
    entry.tabs.push(tab);
    entry.apps.add(want.app);
    members.set(key, entry);
  }
  const steps: GroupStep[] = ungroup.length ? [{ kind: "ungroup", tabIds: ungroup }] : [];
  for (const { windowId, group, tabs: members_, apps } of members.values()) {
    const { title: name, color } = stageGroups[group]!;
    // The window's group for this stage: the one most of these tabs are in
    // already, else any.
    const candidates = [...ours.entries()].filter(([, own]) => own.group === group && own.facts.windowId === windowId).map(([id]) => id);
    const groupId = candidates.sort((a, b) => members_.filter((tab) => tab.groupId === b).length - members_.filter((tab) => tab.groupId === a).length)[0];
    const title = `${name} · ${apps.size}`;
    const existing = groupId === undefined ? undefined : ours.get(groupId)!.facts;
    const tabIds = members_.filter((tab) => tab.groupId !== groupId || groupId === undefined).map((tab) => tab.id);
    const retitle = !existing || existing.title !== title || existing.color !== color;
    if (tabIds.length || retitle) steps.push({ kind: "group", windowId, group, ...(groupId !== undefined ? { groupId } : {}), tabIds, title, color, retitle });
  }
  return steps;
}
