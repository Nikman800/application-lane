// Chrome closes every page of an extension when the extension reloads (a new
// build, the fixer's "lane reload", the reload button in chrome://extensions),
// the dashboard tab among them. The service worker keeps a note of where each
// dashboard tab was, and the reloaded extension opens them again there. Kept
// apart from the service worker so it can be tested without Chrome.

export type DashboardTab = {
  windowId: number;
  index: number;
  // The page it showed: dashboard.html#settings.
  hash: string;
  active: boolean;
  pinned: boolean;
  groupId: number;
};
export type DashboardNote = { savedAt: number; tabs: DashboardTab[] };

// A note older than this is from an earlier session of the browser, not from
// the reload just now; the tabs it names were closed long ago or are restored
// by Chrome itself.
export const noteLifetimeMs = 7 * 24 * 60 * 60_000;

export function dashboardTabs(
  tabs: { windowId: number; index: number; url?: string; pendingUrl?: string; active: boolean; pinned: boolean; groupId?: number }[],
  dashboardURL: string,
): DashboardTab[] {
  return tabs
    .flatMap((tab) => {
      const url = tab.url || tab.pendingUrl || "";
      if (url.split("#")[0] !== dashboardURL) return [];
      const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
      return [{ windowId: tab.windowId, index: tab.index, hash: /^[a-z-]{0,40}$/.test(hash) ? hash : "", active: tab.active, pinned: tab.pinned, groupId: tab.groupId ?? -1 }];
    })
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}

// The tabs to open again after a reload: those the note names, less any
// dashboard already open (a second reload, or one Chrome kept), in their
// order so each index is right when the next is opened.
export function tabsToReopen(note: DashboardNote | undefined, openDashboards: number, now: number): DashboardTab[] {
  if (!note || now - note.savedAt > noteLifetimeMs || openDashboards >= note.tabs.length) return [];
  return note.tabs.slice(openDashboards).slice(0, 5);
}
