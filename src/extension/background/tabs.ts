// Part of the extension's service worker (background.ts): reading tabs, the application a tab belongs to, and tabs attached to an application.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, CONTENT_VERSION, type Observation, type TabContext, normalize, activeStatuses, type IssueReport } from "../../shared/model";
import { accessPattern, canonicalURL, draftOnlySite, postingGuess } from "../../shared/matching";
import { relatedTab, tabRole, companyFor, redactURL } from "../workspace";
import { capturing, startCapture, captureHar } from "../network-capture";
import { bg } from "./state";
import { Frame, alive, allFrames, frameCall, frameDeadline, persist } from "./core";
import { captchaFrame, hiddenFrames } from "./badges";
import { carryOnFailed, fillable, resume } from "./queue";
import { invalidate } from "./run";
import { clearFieldFallback } from "./field-fallback";
import { startEvidence } from "./evidence";

export async function observations(
  app: Application,
  operation: number,
): Promise<{
  frames: Frame[];
  inaccessible: string[];
  accessOrigins: string[];
  frameUrls: string[];
}> {
  const frames: Frame[] = [];
  const inaccessible: string[] = [];
  const accessOrigins: string[] = [];
  if (!app.tabId) throw new Error("Application tab is closed.");
  const descriptions = await allFrames(app.tabId);
  const hiddenOnly = await hiddenFrames(app.tabId);
  for (const frame of descriptions) {
    if (!alive(app, operation)) break;
    if (!/^https?:/.test(frame.url)) {
      if (frame.frameId === 0)
        inaccessible.push("Open a regular HTTP(S) application page.");
      continue;
    }
    // Captcha challenges remain manual even when broad host access has
    // already been granted. Their transient frames are never fill targets.
    if (frame.frameId !== 0 && captchaFrame(frame.url)) continue;
    const origin = new URL(frame.url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      if (frame.frameId !== 0 && hiddenOnly(origin)) continue;
      inaccessible.push(
        frame.frameId === 0 ? `Grant access to this site: ${origin}` : `Grant access to embedded site: ${origin}`,
      );
      accessOrigins.push(accessPattern(origin));
      continue;
    }
    try {
      // See inspectTab: a stalled embedded frame must not hold the whole read.
      await frameDeadline(
        chrome.scripting.executeScript({
          target: { tabId: app.tabId, frameIds: [frame.frameId] },
          files: ["content.js"],
          injectImmediately: true,
        }),
        frame.frameId === 0 ? 20_000 : 6_000,
      );
      if (!alive(app, operation)) break;
      const engine = await frameCall(app, frame.frameId, {
        type: "ENGINE_INFO",
      }).catch(() => undefined);
      if (engine?.version !== CONTENT_VERSION)
        throw new Error(
          // Chrome keeps this worker until the extension is reloaded but reads
          // content.js from disk for every page, so after a rebuild a freshly
          // loaded page can be the newer one; refreshing alone never fixes that.
          "This page and the extension are on different builds. Save any unsaved edits, reload Application Lane in chrome://extensions, refresh the application page, then choose Fill this step.",
        );
      const observation: Observation = await frameCall(app, frame.frameId, {
        type: "BIND",
        locks: bg.locks[app.id] || [],
        replaceSiteValues: Boolean(app.siteFillPending) || bg.state.settings.prefilled !== "keep",
        ownWrites: app.ownWrites || [],
      });
      if (!alive(app, operation)) break;
      frames.push({ frameId: frame.frameId, observation });
    } catch (error) {
      inaccessible.push(
        `Cannot inspect frame at ${origin}: ${(error as Error).message.slice(0, 180)}`,
      );
    }
  }
  return {
    frames,
    inaccessible: [...new Set(inaccessible)],
    accessOrigins: [...new Set(accessOrigins)],
    // Every embedded page's address, read or not: an embedded job board's
    // names its posting (job-boards.eu.greenhouse.io/embed/job_app?for=asm…).
    frameUrls: descriptions.map((frame) => frame.url).filter((url) => /^https:/.test(url) && !captchaFrame(url)),
  };
}

export async function inspectTab(
  tabId: number,
  snapshot = false,
  quick = false,
): Promise<{ tab: chrome.tabs.Tab; frames: Frame[]; inaccessible: string[]; frameOrigins: string[] }> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    return { tab, frames: [], inaccessible: ["Open an HTTP(S) page."], frameOrigins: [] };
  const frames: Frame[] = [];
  const inaccessible: string[] = [];
  // Embedded frames that may hold the form and are not readable yet (a
  // Greenhouse form inside an employer's careers page).
  const frameOrigins = new Set<string>();
  let hiddenOnly: ((origin: string) => boolean) | undefined;
  const inspect = async (frame: { frameId: number; url: string }) => {
    if (!/^https?:/.test(frame.url)) return;
    if (frame.frameId !== 0 && captchaFrame(frame.url)) return;
    const origin = new URL(frame.url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      inaccessible.push(origin);
      if (frame.frameId !== 0 && !captchaFrame(frame.url)) {
        hiddenOnly ??= await hiddenFrames(tabId);
        if (!hiddenOnly(origin)) frameOrigins.add(accessPattern(origin));
      }
      return;
    }
    try {
      // A frame that never finishes loading (a stalled third-party embed)
      // keeps executeScript pending for good; reading the form must not wait
      // on it. An embedded frame gets less time than the page itself.
      const result = await frameDeadline(
        chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            files: ["content.js"],
            ...(quick ? { injectImmediately: true } : {}),
          })
          .then(() =>
            chrome.tabs.sendMessage(
              tabId,
              { type: snapshot ? "SNAPSHOT" : "INSPECT" },
              { frameId: frame.frameId },
            ),
          ),
        quick ? 3_000 : frame.frameId === 0 ? 20_000 : 6_000,
      );
      if (!result?.ok) throw new Error(result?.error || "Inspection failed.");
      frames.push({
        frameId: frame.frameId,
        observation: snapshot ? result.data.observation : result.data,
        ...(snapshot ? { html: result.data.html } : {}),
      } as Frame & { html?: string });
    } catch (error) {
      inaccessible.push(`${origin}: ${(error as Error).message.slice(0, 180)}`);
    }
  };
  const descriptions = await allFrames(tabId);
  if (quick) await Promise.all(descriptions.map(inspect));
  else for (const frame of descriptions) await inspect(frame);
  if (quick) frames.sort((a, b) => a.frameId - b.frameId);
  return { tab, frames, inaccessible: [...new Set(inaccessible)], frameOrigins: [...frameOrigins] };
}

export function applicationForTab(tabId: number) {
  return bg.state.applications.find(
    (app) =>
      app.tabs.some((tab) => tab.tabId === tabId && !tab.closedAt) ||
      app.tabId === tabId,
  );
}

export function updateRelatedTab(
  app: Application,
  tab: chrome.tabs.Tab,
  fieldCount: number | undefined,
) {
  let related = app.tabs.find((candidate) => candidate.tabId === tab.id);
  if (!related) {
    related = relatedTab(tab, fieldCount);
    app.tabs.push(related);
  }
  related.url = tab.url || tab.pendingUrl || related.url;
  related.title = tab.title || related.title;
  related.fieldCount = fieldCount ?? 0;
  if (fieldCount !== undefined)
    related.role = tabRole(related.url, related.title, fieldCount);
  related.state =
    fieldCount === undefined ? "unscanned" : fieldCount ? "form" : "no-form";
  related.lastSeenAt = Date.now();
  related.closedAt = undefined;
}

export async function tabContext(tabId: number): Promise<TabContext> {
  const result = await inspectTab(tabId);
  const url = result.tab.url || "";
  const title = result.tab.title || (url ? new URL(url).hostname : "Tab");
  const primary =
    result.frames.find((frame) => frame.observation.fields.length) ||
    result.frames[0];
  const fieldCount = result.frames.reduce(
    (total, frame) => total + fillable(frame.observation),
    0,
  );
  const linked = applicationForTab(tabId);
  if (linked) {
    updateRelatedTab(linked, result.tab, fieldCount);
    await persist();
  }
  const suggestions: TabContext["suggestions"] = [];
  const seen = new Set<string>();
  const addSuggestion = (
    app: Application | undefined,
    confidence: "strong" | "possible",
    reason: string,
  ) => {
    if (!app || app.id === linked?.id || app.archivedAt || seen.has(app.id))
      return;
    seen.add(app.id);
    suggestions.push({ applicationId: app.id, confidence, reason });
  };
  if (result.tab.openerTabId)
    addSuggestion(
      applicationForTab(result.tab.openerTabId),
      "strong",
      "Opened from a tab in this application",
    );
  if (url) {
    for (const app of bg.state.applications) {
      if (
        [app.sourceUrl, app.url, ...app.tabs.map((tab) => tab.url)].some(
          (candidate) => candidate && canonicalURL(candidate) === canonicalURL(url),
        )
      )
        addSuggestion(app, "strong", "This URL was seen in the application");
      else if (
        new URL(app.sourceUrl).hostname === new URL(url).hostname &&
        normalize(app.title) &&
        normalize(title).includes(normalize(app.title).slice(0, 40))
      )
        addSuggestion(app, "possible", "Same site and a similar position title");
    }
  }
  // The page itself unread for want of access, though a frame inside it was
  // read: Amazon's apply page, where only an empty ad frame could be read, so
  // the panel offered no grant and Fill had no fields to start from.
  const pageDenied =
    /^https?:/.test(url) &&
    !result.frames.some((frame) => frame.frameId === 0) &&
    result.inaccessible.includes(new URL(url).origin);
  const readable = Boolean(result.frames.length) && !pageDenied;
  return {
    tabId,
    url,
    title,
    fieldCount,
    accessible: readable,
    permissionOrigin:
      !readable && /^https?:/.test(url)
        ? accessPattern(new URL(url).origin)
        : undefined,
    // A readable page whose form sits in a frame it may not read yet.
    ...(readable && result.frameOrigins.length ? { frameOrigins: result.frameOrigins } : {}),
    observation: primary?.observation,
    applicationId: linked?.id,
    suggestions,
    ...(draftOnlySite(url) ? { draftOnly: true } : {}),
  };
}
// A posting's own Apply link or button: "Apply", "Apply now", "Apply for
// this job", "Start application". One that applies through another site or
// a stored profile (an employer, Indeed, "Apply with…", Easy Apply) is not it.
// A link goes in this tab, never a new one, so the application keeps its
// tab; a button is clicked, and a form it shows in place is filled after.
export async function useApply(app: Application, tabId: number, operation: number): Promise<string | undefined> {
  const [found] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const own = /^(apply|apply now|apply online|apply here|apply today|apply for (this |the )?(job|position|role|opportunity)|apply to (this |the )?(job|position|role)|start (your |an |my )?application|begin (your |an )?application)$/i;
      const other = /linkedin|indeed|glassdoor|seek|\bwith\b|easy apply|quick apply|refer|save|share/i;
      const shown = (element: Element) => (element as HTMLElement).getClientRects().length > 0 && !element.closest("[hidden],[aria-hidden='true']");
      const candidates = [...document.querySelectorAll<HTMLElement>('a[href],button,[role="button"],input[type="submit"],input[type="button"]')]
        .filter((element) => !(element as HTMLButtonElement).disabled && shown(element))
        .map((element) => ({ element, label: (element instanceof HTMLInputElement ? element.value : element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim() }))
        .filter(({ label }) => own.test(label.replace(/[!.:›»→]+$/, "").trim()) && !other.test(label));
      const chosen = candidates[0];
      if (!chosen) return undefined;
      if (chosen.element instanceof HTMLAnchorElement && /^https?:/i.test(chosen.element.href))
        return { label: chosen.label, href: chosen.element.href };
      chosen.element.click();
      return { label: chosen.label };
    },
  });
  const result = found?.result as { label: string; href?: string } | undefined;
  if (!result || !alive(app, operation)) return undefined;
  app.applyUsed = { from: [...(app.applyUsed?.from || []), canonicalURL(app.url)], operation, tabId, at: Date.now() };
  if (result.href) await chrome.tabs.update(tabId, { url: result.href });
  // A form shown in place is read again in a moment; a new page carries on
  // when it loads instead (chrome.tabs.onUpdated), which cancels this.
  setTimeout(() => {
    if (app.applyUsed?.operation === operation && app.operation === operation && app.tabId === tabId && app.status === "awaiting-user") {
      app.applyUsed.operation = -1;
      void resume(app).catch((error) => carryOnFailed(app, error));
    }
  }, 2500);
  return result.label;
}
// The same page at another address: one origin and path, other parameters.
export function sameFormPage(next: string, previous: string) {
  try {
    const [a, b] = [new URL(next), new URL(previous)];
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}
// Whether the page a fill would write to is on a draft-only site.
export async function draftOnlyTab(tabId: number | undefined, fallback?: string) {
  const tab = tabId === undefined ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  return draftOnlySite(tab?.url || fallback);
}

// The page an application form was reached from, when it is tracked without
// a posting of its own: the tab that opened it (a careers site's form opened
// from its posting), else the page the browser says led to it (Paylocity's
// Apply after its Details). Its address becomes the application's posting
// link, which the card shows and the applicant can change, and its words
// are read when that tab is still open.
export async function leadingPage(tab: chrome.tabs.Tab, observation?: Observation, app?: Application): Promise<{ url: string; description?: string } | undefined> {
  // A page of the application itself (step 1 is the referrer of step 2) is
  // not where it was reached from.
  const own = new Set([tab.url, app?.url, app?.sourceUrl, ...(app?.tabs || []).map((related) => related.url)].filter(Boolean).map((url) => canonicalURL(url!)));
  const usable = (url?: string) => {
    if (!url || !/^https:/.test(url) || own.has(canonicalURL(url))) return false;
    const { hostname, pathname } = new URL(url);
    return pathname.length > 1 &&
      !/(^|\.)(google|bing|duckduckgo|yahoo)\.[a-z.]+$|^(login|accounts|auth|sso|signin)\.|(^|\.)(okta|auth0|microsoftonline)\.com$/.test(hostname) &&
      !/\b(log-?in|sign-?in|sso|oauth|authorize)\b/i.test(pathname);
  };
  // The tab that opened this one led to the tab's first page, not to a page
  // reached in it since: Simplify's list on GitHub opened Oracle's posting,
  // which led to its form, and the list was read as the posting.
  const before = tab.id !== undefined && tab.url ? (await visitedPages(tab.id)).filter((url) => canonicalURL(url) !== canonicalURL(tab.url!)) : [];
  if (tab.openerTabId !== undefined && !before.length) {
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
    if (opener?.id !== undefined && usable(opener.url) && !applicationForTab(opener.id)) {
      const read = await inspectTab(opener.id).catch(() => undefined);
      return { url: opener.url!, description: read?.frames[0]?.observation.description || undefined };
    }
  }
  // The same tab, before it reached this site: a cross-site referrer names
  // only the other site (one employer's posting on jobs.l3harris.com, its form
  // on ns2cloud.com), but the tab's own pages say which.
  if (tab.id !== undefined && tab.url) {
    const host = new URL(tab.url).hostname;
    const earlier = (await visitedPages(tab.id)).filter((url) => usable(url) && new URL(url).hostname !== host).at(-1);
    if (earlier) return { url: earlier };
  }
  if (usable(observation?.referrer)) return { url: observation!.referrer! };
}

// Each tab's recent pages, oldest first, for the browser session only
// (session storage): where an application form was reached from.
export const visitedKey = "visitedPages";
export async function visitedPages(tabId: number): Promise<string[]> {
  const stored = await chrome.storage.session.get(visitedKey).catch(() => ({}) as Record<string, unknown>);
  return ((stored[visitedKey] || {}) as Record<string, string[]>)[tabId] || [];
}
export function rememberVisit(tabId: number, url?: string) {
  bg.visiting = bg.visiting.then(async () => {
    const stored = await chrome.storage.session.get(visitedKey);
    const all = (stored[visitedKey] || {}) as Record<string, string[]>;
    if (url) all[tabId] = [...(all[tabId] || []).filter((seen) => seen !== url), url].slice(-8);
    else delete all[tabId];
    await chrome.storage.session.set({ [visitedKey]: all });
  }).catch(() => { /* best effort: the visited-pages list is only a convenience */ });
}

// The employer as the page names it replaces a name guessed from the
// address ("smartapply"), never one the applicant typed.
export const wordCount = (text?: string) => text?.match(/\S+/g)?.length || 0;

// The application's own posting page, open in another tab and now showing
// more of the posting than was read from it: its words and address.
// Whether the posting's address is to be guessed from the form's: none yet,
// or one an earlier guess made that the guess now makes better (Microsoft's
// form at /careers/apply?pid= was taken to post at /careers).
export function guessedAgain(app: Application): boolean {
  if (!app.postingUrl) return true;
  const guess = postingGuess(app.url);
  if (!guess || guess === app.postingUrl) return false;
  try {
    const url = new URL(app.url);
    url.pathname = url.pathname.replace(/\/(apply|application)\/?$/i, "");
    url.search = "";
    url.hash = "";
    return url.href === app.postingUrl;
  } catch {
    return false;
  }
}

export async function postingFromOwnTab(app: Application, filling?: Observation, open = false): Promise<{ url: string; description: string } | undefined> {
  const own = new Set([app.sourceUrl, app.postingUrl, ...app.tabs.map((related) => related.url)].filter(Boolean).map((url) => canonicalURL(url!)));
  const filled = new Set([app.url, filling?.url].filter(Boolean).map((url) => canonicalURL(url!)));
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || tab.id === app.tabId || !tab.url || !/^https?:/.test(tab.url)) continue;
    if (!own.has(canonicalURL(tab.url)) || filled.has(canonicalURL(tab.url))) continue;
    const page = (await inspectTab(tab.id).catch(() => undefined))?.frames.find((frame) => frame.frameId === 0)?.observation;
    if (page && wordCount(page.description) >= 80 && wordCount(page.description) > wordCount(app.sourceDescription))
      return { url: tab.url, description: page.description };
  }
  // The posting's link, given but not open: read in a tab of its own, out of
  // view, once its script has drawn it, then closed. Tesla refuses the
  // backend its pages, so a pasted link alone gave the fit nothing to go on.
  // Or the page it was tracked from, when the form is elsewhere.
  const link = app.postingUrl || (app.sourceUrl && canonicalURL(app.sourceUrl) !== canonicalURL(app.url) ? app.sourceUrl : undefined);
  if (!open || !link || !/^https?:/.test(link)) return;
  const reader = await chrome.tabs.create({ url: link, active: false }).catch(() => undefined);
  if (reader?.id === undefined) return;
  try {
    for (let waited = 0; waited < 20_000; waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const page = (await inspectTab(reader.id).catch(() => undefined))?.frames.find((frame) => frame.frameId === 0)?.observation;
      if (page && wordCount(page.description) >= 80 && wordCount(page.description) > wordCount(app.sourceDescription))
        return { url: link, description: page.description };
    }
  } finally {
    await chrome.tabs.remove(reader.id).catch(() => { /* the reader tab may already be closed */ });
  }
}

export function namedByPage(app: Application, observation: Observation) {
  if (observation.company && app.company === companyFor(app.sourceUrl || app.url, ""))
    app.company = observation.company.slice(0, 300);
}

export async function attachTab(app: Application, tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Only HTTP(S) tabs can be attached.");
  const owner = applicationForTab(tabId);
  if (owner && owner.id !== app.id) {
    if (owner.status !== "cancelled")
      await invalidate(owner, "paused", "The fill tab was moved to another application.");
    owner.tabs = owner.tabs.filter((related) => related.tabId !== tabId);
    if (owner.tabId === tabId) owner.tabId = undefined;
  }
  if (activeStatuses.includes(app.status))
    await invalidate(app, "paused", "The current fill tab changed.");
  if (app.tabId !== tabId) await clearFieldFallback(app);
  const context = await tabContext(tabId);
  const fieldCount = context.observation ? fillable(context.observation) : 0;
  updateRelatedTab(app, tab, fieldCount);
  app.tabId = tabId;
  app.url = tab.url;
  app.status = "awaiting-user";
  app.explicitFill = false;
  app.note = fieldCount
    ? `${fieldCount} fields detected. Choose Fill this step when ready.`
    : "Attached. Open a fillable application step in this tab.";
  app.updatedAt = Date.now();
  await persist();
  await startEvidence(tabId);
  return bg.state;
}

export async function detachTab(app: Application, tabId: number) {
  if (app.tabId === tabId && app.status !== "cancelled")
    await invalidate(app, "paused", "The current fill tab was detached.");
  app.tabs = app.tabs.filter((tab) => tab.tabId !== tabId);
  if (app.tabId === tabId) {
    app.tabId = undefined;
    app.status = "awaiting-user";
    app.note = "Choose a related tab as the current fill target.";
  }
  await persist();
  return bg.state;
}

// What the page holds now: every readable frame's fields and HTML, with
// unreadable frames noted. Shared by issue reports and fill captures.
export async function pageEvidence(tabId: number): Promise<{ tab: chrome.tabs.Tab & { url: string }; frames: IssueReport["frames"] }> {
  if (bg.state.settings.networkCapture === "on" && !capturing(tabId))
    await startCapture(tabId, false).catch(() => { /* best effort: a report then has no network log */ });
  const captured = await inspectTab(tabId, true);
  const tab = captured.tab;
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("This tab cannot be included in an issue report.");
  let remaining = 10_000_000;
  const frames: IssueReport["frames"] = captured.frames.map((frame) => {
    const html = String((frame as Frame & { html?: string }).html || "");
    const kept = html.slice(0, Math.max(0, remaining));
    remaining -= kept.length;
    return {
      url: redactURL(frame.observation.url),
      observation: frame.observation,
      html: kept,
    };
  });
  frames.push(
    ...captured.inaccessible.map((error) => ({ url: redactURL(tab.url!), error })),
  );
  return { tab: tab as chrome.tabs.Tab & { url: string }, frames };
}
export const networkSummary = (network: NonNullable<Awaited<ReturnType<typeof captureHar>>>) =>
  ({ entries: network.entries, fromLoad: network.fromLoad, recovered: network.recovered, missing: network.missing });
