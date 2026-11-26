// Part of the extension's service worker (background.ts): the dashboard tab
// opened again where it was after the extension reloads (dashboard-reopen.ts).
import { dashboardTabs, tabsToReopen, type DashboardNote } from "../dashboard-reopen";

const key = "dashboardTabs";
const dashboardURL = () => chrome.runtime.getURL("dashboard.html");
let timer: ReturnType<typeof setTimeout> | undefined;
let reopening: Promise<void> | undefined;

async function openDashboards() {
  return dashboardTabs(await chrome.tabs.query({}), dashboardURL());
}
// Where the dashboard tabs are now. Written half a second after a change, so a
// tab the applicant closes drops from the note, while the tabs Chrome closes
// on a reload do not: the service worker has stopped before the note is due.
export async function noteDashboards() {
  await reopening;
  const note: DashboardNote = { savedAt: Date.now(), tabs: await openDashboards() };
  await chrome.storage.local.set({ [key]: note });
}
export function dashboardsSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => void noteDashboards().catch(() => { /* best effort: the dashboard is then not reopened */ }), 500);
}
// Before the extension reloads itself (lane reload): the note as it is now,
// whatever the timer would have written.
export async function noteDashboardsNow() {
  clearTimeout(timer);
  await noteDashboards();
}

async function reopen() {
  const note = (await chrome.storage.local.get(key))[key] as DashboardNote | undefined;
  const open = await openDashboards();
  const windows = new Set((await chrome.windows.getAll({ windowTypes: ["normal"] })).map((window) => window.id));
  const groups = new Set((await chrome.tabGroups.query({}).catch(() => [])).map((group) => group.id));
  for (const tab of tabsToReopen(note, open.length, Date.now())) {
    // A window closed since opens the dashboard in the one in front.
    const windowId = windows.has(tab.windowId) ? tab.windowId : undefined;
    const created = await chrome.tabs.create({
      url: `${dashboardURL()}${tab.hash ? `#${tab.hash}` : ""}`,
      ...(windowId !== undefined ? { windowId, index: tab.index } : {}),
      active: tab.active,
      pinned: tab.pinned,
    });
    if (windowId !== undefined && tab.groupId >= 0 && groups.has(tab.groupId) && created.id !== undefined)
      await chrome.tabs.group({ groupId: tab.groupId, tabIds: [created.id] }).catch(() => { /* the group closed meanwhile */ });
  }
}

// Registered when the worker starts, as Chrome requires. A reload is an
// "update"; a browser restart is not, and Chrome restores its own tabs then.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== "update") return;
  reopening = reopen().catch(() => { /* best effort */ });
  void reopening.then(() => noteDashboards()).catch(() => { /* best effort */ });
});
chrome.tabs.onCreated.addListener(dashboardsSoon);
chrome.tabs.onRemoved.addListener(dashboardsSoon);
chrome.tabs.onMoved.addListener(dashboardsSoon);
chrome.tabs.onAttached.addListener(dashboardsSoon);
chrome.tabs.onActivated.addListener(dashboardsSoon);
// A dashboard tab moved to another page (or to another site) changes the note too.
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.pinned !== undefined || change.groupId !== undefined) dashboardsSoon();
});
