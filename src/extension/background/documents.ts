// Part of the extension's service worker (background.ts): fit checks and drafted documents.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, type Profile, type GenerationJob, activeStatuses } from "../../shared/model";
import { applicationQuestion } from "../../shared/questions";
import { bg } from "./state";
import { answerRequests, api, persist } from "./core";
import { inspectTab, namedByPage, postingFromOwnTab, wordCount } from "./tabs";
import { applicationRoleTitle, schedule } from "./queue";

export async function checkFit(app: Application) {
  if (app.fitJobId) return bg.state;
  const details = () => JSON.stringify([app.title, app.company, app.sourceUrl, app.postingUrl, app.postingText]);
  const original = details();
  const profile: Profile = await api("/v1/profile");
  const captured = app.tabId !== undefined ? await inspectTab(app.tabId).catch(() => undefined) : undefined;
  const frames = captured?.frames || [];
  // A posting the backend is refused (Tesla's), open in a tab: its words
  // from there (: the fit had nothing to go on, link or not).
  // Also whenever the backend has read no posting for it, whatever the page
  // gave: Tesla's apply page read as enough for a "partial" fit, and its
  // posting was never looked for.
  if ((wordCount(app.sourceDescription) < 80 || !app.posting) && !app.postingText) {
    const reread = await postingFromOwnTab(app, frames[0]?.observation, true).catch(() => undefined);
    // Its words only: a changed link would make this check stale (below).
    if (reread) app.sourceDescription = reread.description.slice(0, 12500);
  }
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "fit", applicationId: app.id, operation: Date.now(),
    profileRevision: profile.revision, url: app.sourceUrl || app.url,
    title: app.title, roleTitle: applicationRoleTitle(app), company: app.company,
    description: [app.sourceDescription || "", ...frames.map((frame) => frame.observation.description)].join("\n").slice(0, 25000),
    fields: frames.flatMap((frame) => frame.observation.fields).slice(0, 250),
    postingUrl: app.postingUrl, postingText: app.postingText,
    pageUrls: [...new Set([app.url, ...app.tabs.map((tab) => tab.url)])].slice(0, 10),
  });
  if (details() !== original) {
    await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
    return bg.state;
  }
  app.fit = undefined;
  app.fitError = undefined;
  app.fitJobId = job.id;
  await persist();
  schedule();
  return bg.state;
}
// The resume and cover letter for this application, drafted and saved as
// files without anything being written to the page: for a site whose form the
// applicant fills and uploads to by hand.
export async function draftDocuments(app: Application) {
  if (app.draftJobId) return bg.state;
  if (app.explicitFill || activeStatuses.includes(app.status))
    throw new Error("Wait for the current fill to finish; it drafts the documents too.");
  const profile: Profile = await api("/v1/profile");
  const captured = app.tabId !== undefined ? await inspectTab(app.tabId).catch(() => undefined) : undefined;
  const frames = captured?.frames || [];
  if (frames[0]) namedByPage(app, (frames.find((frame) => frame.observation.fields.length) || frames[0]).observation);
  // Redrafted for want of the posting: its own tab may show it by now.
  if ((wordCount(app.sourceDescription) < 80 || !app.posting) && !app.postingText) {
    const reread = await postingFromOwnTab(app, frames[0]?.observation, true).catch(() => undefined);
    if (reread) {
      app.sourceDescription = reread.description.slice(0, 12500);
      app.postingUrl ||= reread.url;
    }
  }
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "application", applicationId: app.id, operation: Date.now(),
    profileRevision: profile.revision, url: app.sourceUrl || app.url,
    title: app.title, roleTitle: applicationRoleTitle(app), company: app.company || undefined,
    description: [app.sourceDescription || "", ...frames.map((frame) => frame.observation.description)].join("\n").slice(0, 25000),
    // No question of the page's is answered; the letter is asked for by name.
    fields: [{ id: "documents|cover", label: "Cover letter", kind: "file", required: false, value: "", options: [], revision: 0, protected: false, documentKind: "cover" }],
    postingUrl: app.postingUrl, postingText: app.postingText,
    pageUrls: [...new Set([app.url, ...app.tabs.map((tab) => tab.url)])].filter((url) => /^https:/.test(url) && url.length <= 3000).slice(0, 10),
    redraft: true,
  });
  app.draftJobId = job.id;
  app.draftError = undefined;
  await persist();
  schedule();
  return bg.state;
}
// What a job is still preparing, item by item, for the panel's bars.
export function tailoringOf(job: GenerationJob) {
  return ["queued", "running"].includes(job.status) && job.progress?.length ? job.progress : undefined;
}
export async function pollDocumentDrafts() {
  const drafting = bg.state.applications.filter((app) => app.draftJobId);
  await Promise.allSettled(drafting.map(async (app) => {
    const id = app.draftJobId!;
    try {
      const job: GenerationJob = await api(`/v1/jobs/${id}`);
      if (app.draftJobId !== id) return;
      if (["queued", "running"].includes(job.status)) {
        if (JSON.stringify(app.tailoring) !== JSON.stringify(tailoringOf(job))) {
          app.tailoring = tailoringOf(job);
          await persist();
        }
        return;
      }
      app.draftJobId = undefined;
      app.tailoring = undefined;
      if (job.status === "complete" && job.artifacts.length) {
        app.artifacts = job.artifacts;
        app.documentJobId = job.id;
        app.posting = job.posting;
        if (job.posting) app.title = job.posting.title;
      } else app.draftError = job.error || "The documents were not drafted. Draft them again.";
      await persist();
    } catch (error) {
      if ((error as Error).message === "Job not found." && app.draftJobId === id) {
        app.draftJobId = undefined;
        app.draftError = "This draft is no longer available. Draft the documents again.";
        await persist();
      }
    }
  }));
  if (bg.state.applications.some((app) => app.draftJobId)) schedule(1500);
}
export async function questionFields(tabId: number) {
  const captured = await inspectTab(tabId);
  return {
    fields: captured.frames.flatMap((frame) => frame.observation.fields.filter(applicationQuestion).map((field) => ({ ...field, id: `${frame.frameId}|${field.id}` }))),
    inaccessible: captured.inaccessible,
  };
}
export async function clearAnswerDrafts(app: Application) {
  answerRequests.delete(app.id);
  const id = app.answerSession?.jobId;
  app.answerSession = undefined;
  if (id) await api(`/v1/jobs/${id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
}
