// Part of the extension's service worker (background.ts): the page badge and the toolbar badge.
// Split out of background.ts as it was; see background.ts for how it starts.
import { badgeInfo } from "../badge-info";
import { applicationWarning } from "../../shared/duplicates";
import { type Application } from "../../shared/model";
import { draftOnlySite } from "../../shared/matching";
import { bg } from "./state";
import { section, type Repair } from "../../shared/repairs";
import { allFrames, api, frameCall } from "./core";

// Each application page's badge (badge.ts): sent when what it says changes,
// to the top frame of the application's tab.
export const badgeSent = new Map<number, string>();
export function badgesSoon() {
  clearTimeout(bg.badgeTimer);
  bg.badgeTimer = setTimeout(() => void sendBadges().catch(() => { /* badges are cosmetic: the next change sends them again */ }), 200);
}
export async function repairState(): Promise<Record<string, string>> {
  if (Date.now() - bg.repairsAsked < 10_000) return bg.repairStates;
  bg.repairsAsked = Date.now();
  try {
    const repairs: Record<string, Repair> = await api("/v1/repairs");
    bg.repairStates = Object.fromEntries(Object.entries(repairs).map(([id, repair]) => [id, repair.state || ""]));
    bg.repairSections = Object.fromEntries(Object.entries(repairs).map(([id, repair]) => [id, section({ ...repair, defects: repair.defects || [] })]));
  } catch {
    /* The last answer stands. */
  }
  return bg.repairStates;
}
export async function sendBadges() {
  const shortcut = (await chrome.commands.getAll()).find((command) => command.name === "fill-step")?.shortcut || "";
  const repairs = await repairState();
  for (const app of bg.state.applications) {
    if (app.tabId === undefined || app.status === "cancelled") continue;
    const info = badgeInfo(app, shortcut, applicationWarning(app, bg.state.applications, repairs[app.id] as "needs-fixing" | "being-fixed" | "released" | undefined));
    const key = JSON.stringify(info);
    if (badgeSent.get(app.tabId) === key) continue;
    badgeSent.set(app.tabId, key);
    const tabId = app.tabId;
    chrome.tabs.sendMessage(tabId, { type: "LANE_BADGE", info }, { frameId: 0 }).catch(() => badgeSent.delete(tabId));
  }
}
export async function broadcast(app: Application, type: string) {
  if (!app.tabId) return;
  await Promise.allSettled(
    (await allFrames(app.tabId)).map((frame) =>
      frameCall(app, frame.frameId, { type }),
    ),
  );
}
// A document's SHA-256, as hex.
export async function digest(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
// Frames that verify the visitor or report to the site's own analytics. None
// holds a form, and a bot check is not the extension's to read: access to
// them is never asked for (one employer's li.protechts.net).
export function captchaFrame(url: string) {
  const { hostname, pathname } = new URL(url);
  return (
    pathname.startsWith("/recaptcha/") ||
    /(^|\.)hcaptcha\.com$|^challenges\.cloudflare\.com$/.test(hostname) ||
    /(^|\.)(protechts\.net|perimeterx\.net|px-cdn\.net|px-cloud\.net|datadome\.co|arkoselabs\.com|funcaptcha\.com)$/.test(hostname) ||
    // A tag manager's service-worker frame (sgtm.indeed.com).
    /\/service_worker\/[^/]+\/sw_iframe\.html$/.test(pathname) ||
    // A draft-only site's widget inside another site's form ("Apply with
    // an employer" on Lever): never a fill target, and it must not stop the
    // fill of the page around it.
    draftOnlySite(url)
  );
}
// Whether every embedded frame of this origin is hidden or zero-size (a
// cookie manager): it holds no application, so it is no reason to ask for
// access. Unknown when the top page cannot be read: then nothing is skipped.
export async function hiddenFrames(tabId: number): Promise<(origin: string) => boolean> {
  const shown = await chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      func: () =>
        [...document.querySelectorAll("iframe")].map((frame) => {
          const box = frame.getBoundingClientRect();
          const style = getComputedStyle(frame);
          let origin = "";
          try {
            origin = new URL(frame.src, location.href).origin;
          } catch {
            /* No address. */
          }
          return { origin, shown: box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none" };
        }),
    })
    .then(([result]) => result?.result as { origin: string; shown: boolean }[] | undefined)
    .catch(() => undefined);
  return (origin) =>
    Boolean(shown?.some((frame) => frame.origin === origin)) &&
    !shown?.some((frame) => frame.origin === origin && frame.shown);
}
