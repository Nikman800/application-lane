// Part of the extension's service worker (background.ts): one fill of an application's current step.
// Split out of background.ts as it was; see background.ts for how it starts.
import { bg } from "./state";
import { type Application, type Profile, type GenerationJob, type Observation, type Proposal, normalize, type Field, type Artifact } from "../../shared/model";
import { genericTitle, singlePostingUrl } from "../../shared/titles";
import { canonicalURL, postingGuess, proposals, historyRowMap } from "../../shared/matching";
import { configEngineEnabled } from "../../engine/mode";
import { documentKind, type DocumentKind } from "../semantics";
import { pickTranscript } from "../../shared/transcripts";
import { storeBuild } from "../../shared/store-build";
import { trustedTypingAvailable, releaseTrustedInput } from "../trusted-input";
import { rowHolds } from "../row-holds";
import { carryOnFailed, clearFit, fillable, forApplication, operationKey, resume, schedule, touch } from "./queue";
import { type Frame, alive, answerRequests, api, applyFrame, configUploads, dirty, emptyFields, fieldFallbackRequests, frameCall, frameDeadline, loadingSince, pageTimers, persist, endOnStepChange, reinspectNavigation, reviewInterruptedWrite, signingPolicies } from "./core";
import { guessedAgain, inspectTab, leadingPage, namedByPage, observations, postingFromOwnTab, useApply, wordCount } from "./tabs";
import { interactedNote } from "./submissions";
import { assist, leftAsLegal, modelFills, noteAiFilled, readListOptions } from "./field-fallback";
import { tailoringOf } from "./documents";
import { broadcast, digest } from "./badges";


// A step with nothing for its documents, filled again until two passes
// 1.5 s apart find its form the same (at most ten): what the site does in
// answer to the fill (a value it cleared, a row its parser rewrote, a
// confirmation it drew) lands within those passes, as it did within the
// wait for the documents, and the step ends then instead of half a minute
// later.
export const settling = new Map<string, { operation: number; form: string; passes: number; at: number }>();
export async function run(app: Application, operation: number) {
  if (!app.startedAt) app.startedAt = Date.now();
  // Each look at whether its documents are ready runs this again: one still
  // tailoring stays "Tailoring" rather than flicking to "Reading form" and
  // back every few seconds.
  // Each of those looks also set "filling" before it read the form again,
  // and "preparing" after: the status alternated every second or so for the
  // whole 40 s a step's answers took, saying "Filling confirmed profile
  // fields…" while nothing was written (Proseware).
  const waitingOnJob = app.status === "preparing";
  if (!waitingOnJob) {
    touch(app, "inspecting", "Reading application fields…");
    await persist();
  }
  const tab =
    app.tabId && (await chrome.tabs.get(app.tabId).catch(() => undefined));
  if (!tab)
    throw new Error(
      "Application tab is closed. Reopen or queue its URL again.",
    );
  await pageTimers(tab.id!, true);
  if (tab.status === "loading") {
    // A stalled third-party resource (an ad pixel, an embed) can keep a tab
    // loading for good after its own document is ready. Give the page time,
    // then go on once the document itself has been parsed.
    const since = loadingSince.get(app.id) ?? Date.now();
    loadingSince.set(app.id, since);
    const parsed =
      Date.now() - since >= 10_000 &&
      (await frameDeadline(
        chrome.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [0] },
          injectImmediately: true,
          func: () => document.readyState !== "loading",
        }),
        3_000,
      ).then(
        (results) => results[0]?.result === true,
        () => false,
      ));
    if (!alive(app, operation)) return;
    if (!parsed) {
      touch(app, "queued", "Waiting for the application page to load…");
      await persist();
      schedule(2_000);
      return;
    }
  }
  // Server-rendered select inputs can precede React's handlers. Do not write
  // the other fields during that gap: mounting can discard those writes.
  // Share the existing page-readiness budget and inspect without opening or
  // mutating a control. A component that never attaches remains manual.
  const componentsReady = await frameDeadline(
    chrome.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: () => {
        const inputs = document.querySelectorAll<HTMLInputElement>(
          '.select__container input[role="combobox"][aria-autocomplete="list"], ' +
          '.select-shell input[role="combobox"][aria-autocomplete="list"], ' +
          '.select__control input[role="combobox"][aria-autocomplete="list"]',
        );
        return Array.from(inputs).every(input => {
          const key = Object.getOwnPropertyNames(input).find(key =>
            key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"),
          );
          let fiber = key ? (input as any)[key] : undefined;
          let instance: any;
          let committedRoot: any;
          // A host fiber alone does not establish the select's readiness.
          // Require the same API and option storage that the writer uses.
          for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
            if (typeof fiber.stateNode?.selectOption === "function" &&
                Array.isArray(fiber.stateNode.props?.options)) instance ??= fiber.stateNode;
            if (fiber.tag === 3) committedRoot = fiber.stateNode?.current;
          }
          if (!instance) return false;
          if (!committedRoot) return true;
          // Hydration can attach a host fiber and construct the select before
          // committing it. Calling that instance can discard the SSR form.
          const stack = [committedRoot];
          for (let visited = 0; stack.length && visited < 10_000; visited++) {
            const current = stack.pop()!;
            if (current.stateNode === instance) return true;
            if (current.child) stack.push(current.child);
            if (current.sibling) stack.push(current.sibling);
          }
          return false;
        });
      },
    }),
    3_000,
  ).then(results => results[0]?.result === true, () => true);
  if (!alive(app, operation)) return;
  if (!componentsReady) {
    const since = loadingSince.get(app.id) ?? Date.now();
    loadingSince.set(app.id, since);
    if (Date.now() - since < 10_000) {
      touch(app, "queued", "Waiting for the application controls to load…");
      await persist();
      schedule(2_000);
      return;
    }
  }
  // Keep an exhausted budget through generation/polling of this same fill.
  // Otherwise a permanently absent handler would start a new wait each pass.
  // A parsed form may still be loading an unrelated resource. Its next pass
  // after document generation must reuse that wait, rather than start another
  // ten-second loading budget. A new fill/navigation resets it separately.
  if (componentsReady && tab.status !== "loading") loadingSince.delete(app.id);
  // As this application should state it: an internship and a full-time role
  // can name different graduation dates (preferences.md, graduation by role).
  const profile: Profile = forApplication(
    await api(`/v1/profile/application?title=${encodeURIComponent(app.title)}`).catch(() => api("/v1/profile")),
    app,
  );
  if (!alive(app, operation)) return;
  if (!profile.confirmed || !profile.facts.length)
    throw new Error(
      "Save and confirm your profile before preparing applications.",
    );
  if (app.profileRevision && app.profileRevision !== profile.revision)
    throw new Error("Profile changed. Choose Fill this step with the updated profile.");
  app.profileRevision = profile.revision;
  signingPolicies.set(app.id, profile.signatures ?? "never");
  const { frames, inaccessible, accessOrigins, frameUrls } = await observations(
    app,
    operation,
  );
  if (!alive(app, operation)) return;
  app.accessOrigins = accessOrigins;
  if (frames.some((f) => f.observation.paused)) {
    touch(
      app,
      "paused",
      interactedNote(frames.find((f) => f.observation.paused)?.observation.pausedBy),
    );
    await persist();
    return;
  }
  if (!frames.length) {
    app.missing = inaccessible;
    touch(
      app,
      "awaiting-user",
      inaccessible.join(" ") || "No accessible form found.",
    );
    await persist();
    return;
  }
  const primary =
    frames.find((f) => f.observation.fields.length > 0) || frames[0];
  // The posting's own title, once found, outranks the page's heading. A
  // heading names the application only while it has no real name: a sign-in
  // or profile page reached later is not the job (Fabrikam's became "Your
  // session has expired." and then "Candidate Profile", and its documents
  // were drafted for a job of that name).
  const heading = primary.observation.title || "";
  app.title = app.posting?.title || (genericTitle(app.title, app.url) && heading && !genericTitle(heading, app.url) ? heading : app.title);
  namedByPage(app, primary.observation);
  app.ats = primary.observation.ats;
  // A SuccessFactors page showing only folded sections and upload slots has
  // its whole form behind them: the fill goes on and opens them (the
  // full-page SuccessFactors test, filled nothing).
  // A site rule's upload slot counts too: Apple's Add Resume step shows the
  // saved resume with a Remove button and no input until it is pressed.
  const totalFields = frames.reduce(
    (n, f) => n + fillable(f.observation) + (f.observation.foldedSections || 0) + (f.observation.documentSlots?.length || 0) + (f.observation.uploadSlots?.length || 0),
    0,
  );
  if (!totalFields) {
    // A posting with no form: its Apply leads to the form, and this request
    // carries on there (Amazon's posting). Used once per
    // posting, so a page that leads back here is never pressed again.
    if (!accessOrigins.length && (primary.observation.description.match(/\S+/g)?.length || 0) >= 40 &&
        app.tabId !== undefined && !app.applyUsed?.from.includes(canonicalURL(app.url)) && (app.applyUsed?.from.length || 0) < 3) {
      const from = app.url;
      const used = await useApply(app, app.tabId, operation).catch(() => undefined);
      if (used) {
        // The page it was pressed on is the posting, for tailoring.
        if (!app.postingUrl && !app.postingText) {
          app.postingUrl = from;
          app.postingSought = true;
          app.sourceDescription ||= primary.observation.description.slice(0, 12500);
        }
        touch(app, "awaiting-user", `Pressed "${used}" on the posting. Filling the form it opens…`);
        await persist();
        return;
      }
    }
    // The page itself can be the unreadable one while frames inside it are
    // read (Amazon's apply page on account.amazon.jobs, access given on
    // amazon.jobs, with only ad frames readable): ask for that access.
    if (accessOrigins.length) app.missing = inaccessible;
    touch(
      app,
      "awaiting-user",
      accessOrigins.length
        ? inaccessible.join(" ")
        : "Open the application form or sign in, then choose Fill this step.",
    );
    await persist();
    return;
  }
  dirty.delete(app.id);

  // Some uploaders parse the resume and rewrite the whole form with it (iCIMS
  // reloads the page). Anything filled before that upload is lost, so the
  // resume goes first and alone; the next request fills what is left.
  // SuccessFactors does it in place: its parser wrote "UNSPECIFIED" as a
  // company, its own job titles and dates over the profile's when the resume
  // went up with or after the fill (Fabrikam's SuccessFactors). An
  // empty resume slot there (its rule's resumeFirstPaths) is uploaded to
  // first, through the rule's dialog, and the form is filled once it settles.
  const configResumeFirst = !app.siteFillTried && configEngineEnabled &&
    frames.some((frame) => frame.observation.resumeSlotOpen);
  const resumeFirst = configResumeFirst || (!app.siteFillTried && frames.some((frame) =>
    frame.observation.fields.some(
      (field) =>
        field.kind === "file" &&
        field.replacesForm &&
        !field.value &&
        !field.protected,
    ),
  ));
  // The documents (and this step's drafted answers) are asked for: the
  // posting looked for first if it never was. Started before the
  // deterministic fill on an application's first step, so its tailoring runs
  // while the fill types; one employer's was asked for only after its skills were
  // typed, and the fill then waited for it.
  const startDocuments = async (key?: string): Promise<boolean> => {
    // Tracked before the page that led here was looked for (an application
    // from before this was added): it is looked for once, before drafting.
    if (!app.jobId && !app.postingUrl && !app.postingText && !app.postingSought && app.tabId !== undefined) {
      app.postingSought = true;
      const tab = await chrome.tabs.get(app.tabId).catch(() => undefined);
      const led = tab && (await leadingPage(tab, frames[0]?.observation, app).catch(() => undefined));
      if (!alive(app, operation)) return false;
      if (led) {
        app.postingUrl = led.url;
        if (led.description) app.sourceDescription = `${led.description.slice(0, 12500)}\n${app.sourceDescription || ""}`;
        await persist();
      } else if (!app.postingText && guessedAgain(app)) {
        app.postingUrl = postingGuess(app.url);
        if (app.postingUrl) await persist();
      }
    }
    // Looked for before its site's posting address could be guessed (Paylocity's
    // Apply/<id> to Details/<id>): the guess now made, and what
    // was drafted without a posting drafted again from it on this fill.
    if (!app.postingUrl && !app.postingText && app.postingSought && postingGuess(app.url)) {
      app.postingUrl = postingGuess(app.url);
      await clearFit(app);
      if (app.jobId) {
        app.jobId = undefined;
        app.artifacts = [];
        app.narrative = undefined;
        app.generationKey = undefined;
      }
      await persist();
    }
    // Tracked from a posting its site draws by script, read before it was
    // drawn, and filled in the tab its Apply opened: the posting's own tab,
    // still open, is read again for its words (Tesla: the backend
    // is refused the page, and the letter said nothing about the job).
    if (!app.jobId && wordCount(app.sourceDescription) < 80) {
      const reread = await postingFromOwnTab(app, frames[0]?.observation).catch(() => undefined);
      if (!alive(app, operation)) return false;
      if (reread) {
        app.sourceDescription = reread.description.slice(0, 12500);
        app.postingUrl ||= reread.url;
        await persist();
      }
    }
    if (!app.jobId) {
      const job: GenerationJob = await api("/v1/jobs", "POST", {
        applicationId: app.id,
        operation,
        profileRevision: profile.revision,
        url: app.url,
        title: app.title,
        company: app.company || undefined,
        description: [
          app.sourceDescription || "",
          ...frames.map((f) => f.observation.description),
        ]
          .join("\n")
          .slice(0, 25000),
        fields: [
          ...frames.flatMap((f) =>
            f.observation.fields.map((field) => ({
              ...field,
              id: `${f.frameId}|${field.id}`,
            })),
          ),
          // A cover letter slot drawn without a file box (SuccessFactors'
          // attachment widget) still takes a letter: asked for by name, as
          // draftDocuments does.
          ...(frames.some((f) => f.observation.documentSlots?.includes("cover")) &&
            !frames.some((f) => f.observation.fields.some((field) => field.documentKind === "cover"))
            ? [{ id: "documents|cover", label: "Cover letter", kind: "file", required: false, value: "", options: [], revision: 0, protected: false, documentKind: "cover" as const }]
            : []),
        ].slice(0, 250),
        // The pages being filled: one may lead to the posting when the
        // tracked URL does not (Intel's was its account page).
        // The listing it was tracked from, where none was given: Fabrikam's own
      // job page holds the posting the backend can read, and the form's
      // pages never do. Only when it is one job's own page: the
      // check was genericTitle("", url), true of any address, so the posting
      // was never sent (Optimum's).
      ...(app.postingUrl || (app.sourceUrl && app.sourceUrl !== app.url && singlePostingUrl(app.sourceUrl))
        ? { postingUrl: app.postingUrl || app.sourceUrl }
        : {}),
        ...(app.postingText ? { postingText: app.postingText } : {}),
        pageUrls: [
          ...new Set([
            ...frames.map((f) => f.observation.url),
            ...frameUrls,
            ...app.tabs.map((tab) => tab.url),
          ]),
        ]
          .filter((url) => /^https:/.test(url) && url !== app.url && url.length <= 3000)
          .slice(0, 10),
      });
      if (!alive(app, operation)) {
        await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
        return false;
      }
      app.jobId = job.id;
      if (key) app.generationKey = key;
      await persist();
    }
    return true;
  };
  // First step: no documents yet, and none being made.
  // Not while an earlier step's documents are still being tailored (they
  // went on in the background when that step had no place for them): a second
  // job would tailor them all again alongside.
  const startedEarly = !app.jobId && !app.documentJobId && !app.draftJobId && !resumeFirst;
  if (startedEarly && !(await startDocuments())) return;
  // Fill deterministic fields while document generation runs independently.
  if (!waitingOnJob) {
    touch(
      app,
      "filling",
      resumeFirst
        ? "Uploading your resume first; this site fills the form from it…"
        : "Filling confirmed profile fields…",
    );
    await persist();
  }
  const writeFailures: string[] = [];
  for (const frame of resumeFirst ? [] : frames) {
    if (!alive(app, operation)) return;
    if (configEngineEnabled) {
      const result = await frameCall(app, frame.frameId, {
        type: "CONFIG_FILL",
        documentId: frame.observation.documentId,
        documentURL: frame.observation.url,
        profile,
      }).catch(async (error: Error) => {
        // The page moved to another step while this fill was on the last
        // (the page script answers a command of the old document with
        // "The page document changed."): this fill is over, quietly. The new
        // step is the applicant's to fill; nothing of the old one is resumed on it.
        if (/The page document changed/i.test(error.message)) return undefined;
        // A navigation can destroy a config response after its click already
        // happened. Rebind a fresh document on the same application URL, never
        // resend that config command (it might contain a click or upload).
        const fresh = await reinspectNavigation(app, frame.frameId, frame.observation.documentId, operation, error, frame.observation.url);
        if (!fresh) return { statuses: [], observation: frame.observation };
        frame.frameId = fresh.frameId;
        writeFailures.push("The site reloaded during a configured step. Remaining fields were re-inspected; review the interrupted step manually.");
        return { statuses: [{ key: "navigation", status: "skipped", reason: "Document changed; the interrupted command was not retried." }], observation: fresh.observation, ats: fresh.observation.ats };
      });
      if (!alive(app, operation)) return;
      if (!result) return endOnStepChange(app);
      app.filled += result.statuses.filter(
        (status: { status: string }) => status.status === "filled",
      ).length;
      // A search that was typed but never picked looks filled on the page.
      for (const status of result.statuses as { caution?: string }[])
        if (status.caution) writeFailures.push(status.caution);
      // The config steps that failed, kept with the application so an issue
      // report says which step stopped and why. The card shows those that
      // found their field and still failed (siteRuleProblems, model.ts).
      app.configNotes = (result.statuses as { key: string; status: string; reason?: string }[])
        .filter((status) => status.status === "failed")
        .map((status) => `${status.key}: ${status.reason || "failed"}`.slice(0, 200))
        .slice(0, 60);
      frame.observation = result.observation;
      if (result.ats) app.ats = result.ats;
    }
    // Dropdowns that list their answers only once opened are read first, so
    // an answer is chosen from the site's own list rather than guessed:
    // one employer's "…in that country?" was held back for want of one, and its
    // phone type was guessed as "Mobile" against "Home Cellular".
    await readListOptions(app, frame);
    if (!alive(app, operation)) return;
    const plan = proposals(frame.observation.fields, profile);
    if (plan.length) {
      const result = await applyFrame(app, frame, plan, operation);
      if (result.navigationInterrupted) {
        await reviewInterruptedWrite(app, result.observation);
        return;
      }
      if (!alive(app, operation)) return;
      app.filled += result.results.filter((r: { ok: boolean }) => r.ok).length;
      // A refused write is otherwise invisible: say which field and why.
      for (const refused of result.results as {
        id: string;
        ok: boolean;
        reason?: string;
      }[])
        if (!refused.ok) {
          const field = (result.observation as Observation).fields.find(
            (f) => f.id === refused.id,
          );
          if (field && !field.value)
            writeFailures.push(
              `${field.label}: not filled (${refused.reason || "refused"}).`,
            );
        }
      frame.observation = result.observation;
      // A value the site refused as written ("Invalid number." for "USD
      // 100,000") is answered again at once, in the form it takes: the retry
      // came only from a later pass, and a later step, its documents made,
      // has none (Fabrikam's salary).
      const refusedNow = frame.observation.fields.filter((field) => field.invalid && field.value);
      const again = refusedNow.length
        ? proposals(frame.observation.fields, profile).filter((proposal) => refusedNow.some((field) => field.id === proposal.fieldId))
        : [];
      if (again.length) {
        const retried = await applyFrame(app, frame, again, operation);
        if (retried.navigationInterrupted) {
          await reviewInterruptedWrite(app, retried.observation);
          return;
        }
        if (!alive(app, operation)) return;
        frame.observation = retried.observation;
      }
    }
  }
  if (!alive(app, operation)) return;
  const key = operationKey(frames, profile.revision);
  // The form changing (a site filling it from the resume, a row added) is no
  // reason to tailor the documents again: they are written for the posting,
  // once. Finished documents are kept; only unfinished work starts over.
  if (app.generationKey && app.generationKey !== key && app.jobId) {
    const finished: GenerationJob | undefined = await api(`/v1/jobs/${app.jobId}`).catch(() => undefined);
    if (finished?.status === "complete" && finished.artifacts.length > 0 && finished.profileRevision === profile.revision)
      app.generationKey = key;
  }
  if (app.generationKey && app.generationKey !== key && app.jobId) {
    await api(`/v1/jobs/${app.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
    app.operation++;
    app.jobId = undefined;
    app.artifacts = [];
    app.narrative = undefined;
    app.generationKey = undefined;
    touch(
      app,
      "queued",
      "The form changed. Re-inspecting before generating new answers.",
    );
    await persist();
    return;
  }
  // Whether this step has anything for the tailored documents and drafted
  // answers to do, now that the profile's answers are in: a file box or an
  // upload its site config can make, or a field left empty. A sign-in step
  // with its email and phone filled (iCIMS) has none, and waited
  // half a minute for documents it had nowhere to put.
  const takesDocuments = frames.some(
    ({ observation }) =>
      Boolean(observation.documentSlots?.length || observation.resumeSlotOpen || observation.uploadSlots?.length) ||
      observation.fields.some((field) => field.kind === "file" || (!field.value && !field.protected)),
  );
  // Documents an earlier step left tailoring in the background: a step that
  // takes them waits for those (pollDocumentDrafts keeps them when done)
  // rather than asking for them again.
  if (!app.jobId && app.draftJobId && takesDocuments) {
    touch(app, "preparing", "Tailoring documents while other applications continue…");
    await persist();
    return;
  }
  if (!(await startDocuments(key))) return;
  // A job begun before the fill is known by the form as the fill left it.
  if (app.jobId && !app.generationKey) app.generationKey = key;
  let job: GenerationJob = await api(`/v1/jobs/${app.jobId}`);
  if (!alive(app, operation)) return;
  app.tailoring = tailoringOf(job);
  if (
    job.operation !== operation ||
    job.applicationId !== app.id ||
    job.profileRevision !== profile.revision
  )
    throw new Error("Generation belongs to a superseded application revision.");
  // A backend restart (npm run dev reloads on every source edit) fails jobs
  // it was still running; nothing was wrong with them, so ask again.
  if (job.status === "failed" && /^Backend restarted/.test(job.error || "")) {
    app.operation++;
    app.jobId = undefined;
    app.artifacts = [];
    app.narrative = undefined;
    app.generationKey = undefined;
    touch(app, "queued", "The backend restarted while tailoring. Starting the documents again…");
    await persist();
    return;
  }
  if (["failed", "cancelled"].includes(job.status))
    throw new Error(
      job.error || "Generation was cancelled. Retry this application.",
    );
  // A job begun before this pass's fill waits for the next pass even when it
  // is already done: that pass fills the step again, and a value the site
  // refused is retried in its accepted form (a salary of "USD 100,000"
  // answered "Invalid number." is given as 100000). Applying the documents
  // now would end the fill with the refused value left in place.
  if ((job.status !== "complete" || startedEarly) && takesDocuments) {
    // The last field written is no longer what is being worked on: the
    // panel said "Answering: What are your salary expectations?" for the
    // whole minute and a half the drafts took (Fabrikam).
    // It joins those worked on, as the next label would have put it.
    if (app.progress?.current)
      app.progress = {
        answered: app.progress.answered.at(-1) === app.progress.current ? app.progress.answered : [...app.progress.answered, app.progress.current].slice(-300),
        current: undefined,
      };
    // The written answers need no document: put them on the page as soon as
    // the job has drafted and checked them, once, while the documents go on.
    // The pass that attaches the documents finds those fields filled.
    if (job.status === "running" && job.earlyAnswers?.answers.length && modelFills().written && app.earlyAnswered !== job.id) {
      app.earlyAnswered = job.id;
      for (const frame of frames) {
        if (!alive(app, operation)) return;
        const early: Proposal[] = [];
        for (const answer of job.earlyAnswers.answers) {
          const prefix = `${frame.frameId}|`;
          if (!answer.fieldId.startsWith(prefix)) continue;
          const field = frame.observation.fields.find((f) => f.id === answer.fieldId.slice(prefix.length));
          if (!field || field.protected || field.value || leftAsLegal(field.label)) continue;
          noteAiFilled(app, field.label, answer.value);
          early.push({ fieldId: field.id, value: answer.value, expectedValue: field.value, revision: field.revision, source: "confirmed-facts" });
        }
        if (!early.length) continue;
        touch(app, "filling", "Writing the answers while the documents are tailored…");
        await persist();
        const result = await applyFrame(app, frame, early, operation);
        if (result.navigationInterrupted) {
          await reviewInterruptedWrite(app, result.observation);
          return;
        }
        if (!alive(app, operation)) return;
        frame.observation = result.observation;
        app.filled += result.results.filter((r: { ok: boolean }) => r.ok).length;
      }
    }
    touch(
      app,
      "preparing",
      app.documentJobId
        ? "Getting this step's answers ready while other applications continue…"
        : "Tailoring documents while other applications continue…",
    );
    await persist();
    return;
  }
  if (!takesDocuments) {
    const form = JSON.stringify(frames.map(({ frameId, observation }) => [frameId, observation.documentId, observation.fields.map((field) => [field.id, field.value, field.protected])]));
    const before = settling.get(app.id);
    // Woken sooner by something else: the page is given its 1.5 s first.
    if (before?.operation === operation && Date.now() - before.at < 1500) {
      schedule(1500 - (Date.now() - before.at));
      return;
    }
    const passes = before?.operation === operation ? before.passes + 1 : 1;
    if ((before?.operation !== operation || before.form !== form) && passes <= 10) {
      settling.set(app.id, { operation, form, passes, at: Date.now() });
      touch(app, "filling", "Checking the page has settled…");
      await persist();
      schedule(1500);
      return;
    }
    settling.delete(app.id);
  }
  if (job.status !== "complete") {
    // Nothing on this step for them: the step ends now, and the documents go
    // on being tailored in the background for the step that takes them
    // (pollDocumentDrafts keeps them when done, and the card says so).
    app.draftJobId ||= job.id;
    app.jobId = undefined;
    app.generationKey = undefined;
    job = { ...job, artifacts: [], narrative: undefined };
    schedule(1500);
  } else {
    app.tailoring = undefined;
    app.artifacts = job.artifacts;
    app.documentJobId = job.id;
    app.posting = job.posting;
    // A fit check is independent of a fill; its verdict remains on the tracker.
    if (!app.fitJobId) app.fit = job.fit;
    // The posting's own title replaces a page's guess ("Work Summary").
    if (job.posting) app.title = job.posting.title;
  }

  touch(app, "filling", "Applying supported answers and attaching documents…");
  await persist();
  // Drafts no second model checked: a line on the card, not a warning (a
  // warning would hold every application for review).
  app.unchecked = job.narrative?.unchecked;
  const generationWarnings = job.narrative?.warnings || [];
  const issues = [...generationWarnings, ...inaccessible, ...writeFailures];
  if (!resumeFirst) {
    // Rows the site added from the resume that match no profile school.
    const allFields = frames.flatMap((frame) => frame.observation.fields);
    // A form's "Education (Completed)" part takes only the highest finished
    // degree and says to remove all others (iCIMS): the blocks
    // after the first, the site's duplicates from the resume, are removed
    // with the site's own remove control, last block first.
    const removedFields = new Set<Observation["fields"][number]>();
    for (const frame of frames) {
      const blocks = new Map<string, Map<number, Observation["fields"]>>();
      for (const field of frame.observation.fields) {
        const place = normalize(field.section || "");
        if (!/education/.test(place) || !/\bcompleted\b/.test(place) || !(field.index || 0)) continue;
        const rows = blocks.get(field.section!) || new Map<number, Observation["fields"]>();
        rows.set(field.index!, [...(rows.get(field.index!) || []), field]);
        blocks.set(field.section!, rows);
      }
      for (const [section, rows] of blocks)
        for (const [page, rowFields] of [...rows].sort((a, b) => b[0] - a[0])) {
          const removed = await frameCall(app, frame.frameId, { type: "REMOVE_ROW", section, index: page, groupLoop: true })
            .then((result: { removed?: boolean }) => Boolean(result?.removed))
            .catch(() => false);
          if (!removed) break;
          for (const field of rowFields) removedFields.add(field);
          issues.push(`Education row ${page + 1} was added by the site and is not the highest completed degree, so it was removed.`);
        }
    }
    // Education rows, then job rows, the site added from the resume.
    for (const [collection, held, pattern] of [
      ["education", profile.education, /education/],
      ["work", profile.work, /work|experience|employment/],
    ] as const) {
    const educationRows = new Map<number, Observation["fields"]>();
    for (const field of allFields)
      if (pattern.test(normalize(field.section || "")) && !removedFields.has(field))
        educationRows.set(field.index || 0, [
          ...(educationRows.get(field.index || 0) || []),
          field,
        ]);
    if (educationRows.size > held.length) {
      const paired = historyRowMap(allFields, profile);
      // Highest first, so removing one row does not renumber the next.
      for (const [page, rowFields] of [...educationRows].sort((a, b) => b[0] - a[0])) {
        const kept = [...paired.keys()].some((key) => key.startsWith(`${collection}:`))
          ? paired.has(`${collection}:${page}`)
          : page < held.length;
        if (kept || !rowFields.some((field) => field.value)) continue;
        const school = rowFields.find((field) => (collection === "education" ? /school|university|institution/i : /employer|company|organization/i).test(field.label) && field.value);
        const described = `${collection === "education" ? "Education" : "Employment"} row ${page + 1}${school ? ` ("${school.value.slice(0, 60)}")` : ""}`;
        const section = rowFields.find((field) => field.section)?.section || (collection === "education" ? "Education" : "Employment");
        // Only a row that holds nothing but the site's own guesses, made
        // from a resume this extension uploaded (or, on Apple's review of
        // the parsed resume, read before this fill), is removed.
        const siteMade =
          (app.siteFillPending || /^Edit /.test(section)) &&
          rowFields.every((field) => !field.value || field.siteValue);
        const frame = frames.find((candidate) =>
          candidate.observation.fields.some((field) => rowFields.includes(field)),
        );
        const removed =
          siteMade && frame
            ? await frameCall(app, frame.frameId, { type: "REMOVE_ROW", section, index: page })
                .then((result: { removed?: boolean }) => Boolean(result?.removed))
                .catch(() => false)
            : false;
        issues.push(
          removed
            ? `${described} was added by the site from your resume and is not in your profile, so it was removed.`
            : `${described} is not in your profile; the site probably added it from your resume. Remove it if it is a duplicate.`,
        );
      }
    }
    }
  }
  for (const frame of frames) {
    if (!alive(app, operation)) return;
    const pending: Proposal[] = [];
    // Written answers are the model's: filled only where the applicant's
    // setting lets the model fill, and never for a legal question it is not
    // to answer.
    for (const answer of modelFills().written ? job.narrative?.answers || [] : []) {
      const prefix = `${frame.frameId}|`;
      if (!answer.fieldId.startsWith(prefix)) continue;
      const field = frame.observation.fields.find(
        (f) => f.id === answer.fieldId.slice(prefix.length),
      );
      if (field && !field.protected && !field.value && leftAsLegal(field.label)) {
        issues.push(`Legal or eligibility question left for you: ${field.label}`);
        continue;
      }
      if (field && !field.protected && !field.value) noteAiFilled(app, field.label, answer.value);
      if (field && !field.protected && !field.value)
        pending.push({
          fieldId: field.id,
          value: answer.value,
          expectedValue: field.value,
          revision: field.revision,
          source: "confirmed-facts",
        });
    }
    // Cover-letter text boxes use the same reviewed, fact-grounded document text.
    for (const field of frame.observation.fields)
      if (
        /cover.?letter/i.test(field.label) &&
        field.kind === "textarea" &&
        !field.value &&
        !field.protected
      )
        pending.push({
          fieldId: field.id,
          value: [...job.narrative!.coverLetter.map((p) => p.text), `Sincerely,\n${`${profile.firstName} ${profile.lastName}`.trim()}`].join("\n\n"),
          expectedValue: "",
          revision: field.revision,
          source: "cover-letter",
        });
    // The resume goes alone; the site is about to rewrite these fields.
    if (resumeFirst) pending.length = 0;
    if (pending.length) {
      const result = await applyFrame(app, frame, pending, operation);
      if (result.navigationInterrupted) {
        await reviewInterruptedWrite(app, result.observation);
        return;
      }
      if (!alive(app, operation)) return;
      frame.observation = result.observation;
      app.filled += result.results.filter((r: { ok: boolean }) => r.ok).length;
      for (const refused of result.results.filter((r: { ok: boolean }) => !r.ok))
        issues.push(`Answer not filled: ${frame.observation.fields.find((field) => field.id === refused.id)?.label.slice(0, 80) || "a question"}. ${refused.reason || "The field changed."}`);
    }
    // The document kinds this page has a file field for, as the step began:
    // a site that swaps an uploaded file's input for its name (Greenhouse's
    // job boards) has none afterwards, and the dialog upload below must not
    // then remove that upload to make its own (issue report).
    const fileKind = (f: Field) => f.documentKind || documentKind(f.label);
    const fieldKinds = new Set(frame.observation.fields.filter((f) => f.kind === "file").map(fileKind));
    // A resume the site held before this extension (Amazon keeps the
    // account's) gives way to this application's own, as answers
    // the site filled in do, or when the applicant asks for it. Never one
    // this application uploaded: a site that rewrites the form from it
    // (iCIMS) reloads before the upload is confirmed, and shows it as its own.
    // The answers on the page before a resume goes up, by field: a site that
    // parses the upload in place can empty them (Microsoft's careers form
    // blanked the typed address and zip 1.5 s after its resume_upload
    // returned). Those are answered again below.
    const resume: { filledBeforeResume?: Map<string, string>; fieldsBeforeResume?: Set<string> } = {};
    // Replace with tailored resume, asked for on the card, replaces whatever
    // the slot shows, a resume this application sent before included.
    const heldBySite = (f: Field) => fileKind(f) === "resume" && Boolean(f.value) && !f.attachmentId && !app.siteFillPending &&
      (Boolean(app.replaceDocuments) ||
        (!app.uploadedDocuments?.resume && !app.resumeSent &&
          (f.siteValue || (bg.state.settings.existingResume !== "keep" && f.protectedReason === "existing value"))));
    if ((await fillByProfile(resume, { app, fileKind, frame, heldBySite, issues, job, operation, profile, resumeFirst })) === "stop") return;
    if (!alive(app, operation)) return;
    if ((await fillByConfig({ app, configResumeFirst, fieldKinds, fileKind, frame, issues, job, operation, profile, resumeFirst })) === "stop") return;
    // The site is now parsing the resume and may reload; nothing else here
    // is worth reading until it settles.
    if (resumeFirst) {
      // Not read again, but what was left empty is still the applicant's to
      // know: the resume slot itself is filled by now, the rest is listed as
      // a normal ending lists it. The next fill step rebuilds this list.
      const left = emptyFields(frame.observation.fields).filter((f) => f.kind !== "file");
      issues.push(
        ...left.filter((f) => f.required).map((f) => `Required: ${f.label}`),
        ...left.filter((f) => !f.required && f.protected).map((f) => `Protected: ${f.label} (${f.protectedReason || "left alone"})`),
        ...left.filter((f) => !f.required && !f.protected).map((f) => `Optional unanswered: ${f.label}`),
      );
      continue;
    }
    // Allow reactive validators and upload parsers to settle before inspecting.
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!alive(app, operation)) return;
    const beforeUploadInspection = frame.observation.documentId;
    let resetAfterUpload = false;
    frame.observation = await frameCall(app, frame.frameId, {
      type: "INSPECT",
      documentId: frame.observation.documentId,
    }).catch(async (error: Error) => {
      // An embedded frame with nothing to fill that the page has since
      // removed (Microsoft's sign-in helpers come and go) is no part of the
      // form: it ended the whole fill with "Receiving end does not exist".
      if (frame.frameId !== 0 && !frame.observation.fields.length && /receiving end does not exist|no frame with id \d+/i.test(error.message))
        return frame.observation;
      const fresh = await reinspectNavigation(app, frame.frameId, frame.observation.documentId, operation, error, frame.observation.url);
      if (!fresh) return frame.observation;
      frame.frameId = fresh.frameId;
      resetAfterUpload = true;
      return fresh.observation;
    });
    if (!alive(app, operation)) return;
    if (!resetAfterUpload && frame.observation.documentId !== beforeUploadInspection) {
      // A fresh content script can answer INSPECT successfully after a fast
      // reload. Detect the changed document even when no port error occurred.
      const tab = app.tabId && await chrome.tabs.get(app.tabId).catch(() => undefined);
      if (!tab || canonicalURL(tab.url || "") !== canonicalURL(app.url) || frame.observation.paused) return;
      const fresh = (await observations(app, operation)).frames.find((candidate) => candidate.frameId === frame.frameId);
      if (!alive(app, operation) || !fresh || fresh.observation.paused) return;
      frame.observation = fresh.observation;
      dirty.delete(app.id);
      resetAfterUpload = true;
    }
    if (resetAfterUpload) {
      // An upload may already have reached the site. Refill only confirmed
      // scalar answers in the fresh document; never repeat uploads or config
      // actions, and require the applicant to review the interrupted upload.
      issues.push("The site reloaded during upload. Confirm the uploaded documents manually; the upload was not repeated.");
      const plan = proposals(frame.observation.fields, profile);
      if (plan.length) {
        const applied = await applyFrame(app, frame, plan, operation);
        if (applied.navigationInterrupted) {
          await reviewInterruptedWrite(app, applied.observation);
          return;
        }
        if (!alive(app, operation)) return;
        app.filled += applied.results.filter((result: { ok: boolean }) => result.ok).length;
        frame.observation = applied.observation;
      }
    }
    // Answers the site emptied after the resume went up: watched until the
    // form has held still for two reads a second apart (or 15 seconds),
    // then answered again once. A site that reloaded is handled above.
    if (resume.filledBeforeResume && !resetAfterUpload && frame.observation.documentId === beforeUploadInspection) {
      const emptied = (fields: Field[]) => fields.filter((f) => f.kind !== "file" && !f.value && resume.filledBeforeResume!.has(f.id) && !f.protected);
      let previous = "";
      let steady = 0;
      // Not settled until the site's own upload request has answered (Microsoft's
      // resume_upload took eleven seconds, and the form was blanked after the
      // form had held still), or 20 seconds when none is seen on a site whose
      // config marks its parse slow; elsewhere the form holding still is enough.
      const requestsBefore = frame.observation.uploadRequests || 0;
      let answered = false;
      for (let waited = 0; waited < 30 && steady < 2; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!alive(app, operation)) return;
        const now: Observation | undefined = await frameCall(app, frame.frameId, { type: "INSPECT", documentId: frame.observation.documentId }).catch(() => undefined);
        if (!now) break;
        frame.observation = now;
        if ((now.uploadRequests || 0) > requestsBefore && !answered) {
          answered = true;
          previous = "";
          steady = 0;
          waited = Math.max(waited, 2);
        }
        const form = JSON.stringify(now.fields.map((field) => [field.id, field.value]));
        steady = form === previous && waited >= 3 && (answered || !now.slowResumeParse || waited >= 20) ? steady + 1 : 0;
        previous = form;
      }
      // A part of the form the site drew only once it had parsed the resume
      // (UKG Pro's Contact Information, with its Country list): fields the
      // page did not have when the resume went up, answered as the rest, and
      // what an answer there opens in turn (the address pane Country
      // reveals), each round looking again for what the last one opened.
      for (let round = 0; round < 4; round++) {
        const lost = [
          ...(round ? [] : emptied(frame.observation.fields)),
          ...frame.observation.fields.filter((f) => f.kind !== "file" && !f.value && !f.protected && !resume.fieldsBeforeResume?.has(f.id)),
        ];
        const again = lost.length ? proposals(frame.observation.fields, profile).filter((proposal) => lost.some((field) => field.id === proposal.fieldId)) : [];
        if (!again.length) break;
        for (const field of frame.observation.fields) resume.fieldsBeforeResume?.add(field.id);
        const applied = await applyFrame(app, frame, again, operation);
        if (applied.navigationInterrupted) {
          await reviewInterruptedWrite(app, applied.observation);
          return;
        }
        if (!alive(app, operation)) return;
        frame.observation = applied.observation;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!alive(app, operation)) return;
        const next: Observation | undefined = await frameCall(app, frame.frameId, { type: "INSPECT", documentId: frame.observation.documentId }).catch(() => undefined);
        if (next) frame.observation = next;
      }
    }
    issues.push(...frame.observation.blockers);
    issues.push(
      ...emptyFields(frame.observation.fields)
        .filter((f) => f.required)
        .map((f) =>
          f.protected
            ? `Required: ${f.label} (left alone: ${f.protectedReason || "protected"})${
                // A lock from an earlier edit on a field that is empty again
                // (the page was reloaded) keeps the field empty until released.
                /edit lock/.test(f.protectedReason || "")
                  ? " Choose Unlock empty fields to have it filled."
                  : ""
              }`
            : `Required: ${f.label}`,
        ),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.invalid)
        .map((f) => `Site validation failed: ${f.label}`),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.validationWarning)
        .map((f) => `${f.label}: ${f.validationWarning}`),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.fillWarning && !f.value)
        .map((f) => `${f.label}: ${f.fillWarning}`),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.conflict)
        .map(
          (f) =>
            `Site changed an autofilled value: ${f.label}. Please verify it.`,
        ),
    );
    issues.push(
      ...frame.observation.fields
        .filter(
          (f) =>
            f.kind === "file" &&
            f.value &&
            (!f.attachmentId ||
              !job.artifacts.some((a) => a.id === f.attachmentId)) &&
            // What this application uploaded, shown again on a later page
            // (Amazon's next step), is its own document.
            !(Object.keys(app.uploadedDocuments || {}).some((key) => key.split(":")[0] === (f.documentKind || documentKind(f.label) || "resume")) &&
              job.artifacts.some((a) => a.kind === (f.documentKind || documentKind(f.label)) && a.name === f.value)),
        )
        .map(
          (f) =>
            `Review existing document: ${f.label}. It was preserved and may differ from the newly generated version.`,
        ),
    );
    issues.push(
      ...emptyFields(frame.observation.fields)
        .filter((f) => f.protected && !f.required)
        .map((f) => `Protected: ${f.label} (${f.protectedReason || "left alone"})`),
    );
    issues.push(
      ...emptyFields(frame.observation.fields)
        .filter((f) => !f.protected && !f.required)
        .map((f) => `Optional unanswered: ${f.label}`),
    );
  }
  if (!alive(app, operation)) return;
  const unresolved = resumeFirst
    ? [
        "Resume uploaded first: this site fills the form from it and may reload the page. When it settles, choose Fill this step to fill what it left empty.",
        ...new Set(issues.filter((issue) => /upload|document|file|access|^(?:Required|Protected|Optional unanswered):/i.test(issue))),
      ]
    : [...new Set(issues)];
  // Whole questions: a long one's ask comes last ("If you qualify, please
  // select yes."), and cut at 350 it was gone, as was
  // the match that clears it once answered. Labels are already clipped at
  // 1000 where they are read.
  app.missing = unresolved.slice(0, 60).map((issue) => issue.slice(0, 1100));
  app.replaceDocuments = false;
  if (unresolved.length > 60)
    app.missing.push(
      "Additional unresolved fields remain. Review the full application.",
    );
  // Without the debugger permission (the Chrome Web Store build) Workday's
  // date boxes, which take only real keystrokes, may not keep what was set.
  if (storeBuild && !trustedTypingAvailable() && /workday/i.test(app.url || ""))
    app.missing.push(
      "Check each date on this page (Month, Day, Year): this version of the extension cannot type into Workday's date boxes, so type any date that is empty or wrong yourself.",
    );
  if (!resumeFirst) {
    // A value in a job's or school's row that the profile's own row holds,
    // though no rule answers it: a Workday job's Month and Year, its
    // description, whether it is current. The site's
    // reading of the resume got it right.
    // Pre-filled education or work details the profile could not correct.
    for (const frame of frames)
      for (const field of frame.observation.fields)
        if (
          field.siteValue &&
          /education|experience|employment|work/.test(normalize(field.section || "")) &&
          // A list showing its prompt holds nothing the site parsed (Avature's
          // University/School, "Select an option").
          !/^(?:please )?(?:select|choose)(?: an?| one)?(?: option)?\.{0,3}$/i.test(field.value.trim()) &&
          !rowHolds(field, frame.observation.fields, profile) &&
          // What the site parsed is already the profile's answer (a GPA of
          // 3.84 with the profile's 3.84, an employer): confirmed, so
          // nothing was written and nothing needs checking.
          !proposals([{ ...field, value: "", siteValue: false, protected: false }], profile).some(
            (answer) => normalize(answer.value) === normalize(field.value) ||
              (answer.choices || []).some((choice) => normalize(choice) === normalize(field.value)),
          )
        )
          app.missing.push(
            `${field.label}: "${(field.valueText || field.value).slice(0, 80)}" was filled in by the site from your resume and not corrected. Check it.`,
          );
    app.siteFillPending = false;
  }
  if (!resumeFirst && !frames.some((f) => f.observation.atReview))
    app.missing.push(
      "Verify any remaining steps; no recognized final review screen was detected.",
    );
  if (app.steps >= 12)
    app.missing.push("Step limit reached. Continue manually.");
  // The model's part comes next: marked as running before the status reads
  // as finished, so nothing shows "needs you" in between.
  const assisted = !resumeFirst && app.tabId !== undefined && modelFills().assist;
  if (assisted) app.assisting = true;
  touch(
    app,
    app.missing.length ? "awaiting-user" : "ready",
    generationWarnings.length
      ? "Drafts prepared with recovery warnings. Review documents before continuing."
      : app.missing.length
        ? "Your attention is needed. Review the items below."
        : "Prepared. Review your documents and answers, then submit manually.",
  );
  app.completedAt = Date.now();
  app.explicitFill = false;
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    attempt.completedAt = Date.now();
    attempt.status = app.missing.length ? "needs-review" : "filled";
    attempt.note = app.note;
    attempt.filled = app.filled;
  }
  if (app.tabId !== undefined) await releaseTrustedInput(app.tabId);
  // The model's part, once the profile's is done: suggestions for fields
  // the rules did not recognise, filled or drafted as the setting says. It
  // is marked as running before the fill reads as finished.
  await persist();
  if (assisted) void assist(app, app.tabId!);
  // A site that reloads after the resume upload carries the fill on from the
  // tab's "complete" event (below). One that rewrites the form in place
  // (Paylocity closes its dialog and fills the page) fires no such event, so
  // the same requested fill carries on here once the form stops changing.
  if (resumeFirst && app.continueAfterSiteFill && app.tabId !== undefined) {
    const tabId = app.tabId;
    const request = app.operation;
    void (async () => {
      let previous = -1;
      let steady = 0;
      for (let waited = 0; waited < 20 && steady < 2; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!app.continueAfterSiteFill || app.operation !== request || app.tabId !== tabId) return;
        const count = (await inspectTab(tabId).catch(() => undefined))?.frames.reduce((total, frame) => total + frame.observation.fields.length, 0) ?? -1;
        steady = count >= 0 && count === previous && waited >= 3 ? steady + 1 : 0;
        previous = count;
      }
      if (!app.continueAfterSiteFill || app.operation !== request || app.tabId !== tabId || app.status !== "awaiting-user") return;
      app.note = "The site filled the form from your resume. Correcting and completing it…";
      await persist();
      await resume(app, { operation: request, tabId }).catch((error) => carryOnFailed(app, error));
    })();
  }
}


// Part of run(), for one frame: each field the profile answers, filled by the extension's own rules.
// "stop" when the run is over (the application moved on or was stopped).
async function fillByProfile(
  resume: { filledBeforeResume?: Map<string, string>; fieldsBeforeResume?: Set<string> },
  { app, fileKind, frame, heldBySite, issues, job, operation, profile, resumeFirst }: {
  app: Application;
  fileKind: (f: Field) => DocumentKind | undefined;
  frame: Frame;
  heldBySite: (f: Field) => boolean;
  issues: string[];
  job: GenerationJob;
  operation: number;
  profile: Profile;
  resumeFirst: boolean;
  },
): Promise<"stop" | undefined> {
  for (const field of frame.observation.fields.filter(
    (f) =>
      f.kind === "file" &&
      (!f.value || f.attachmentId || heldBySite(f)) &&
      (!f.protected || heldBySite(f)) &&
      (!resumeFirst || f.replacesForm),
  )) {
    if (!alive(app, operation)) return "stop";
    const kind = fileKind(field);
    const held = heldBySite(field);
    if (!kind) {
      issues.push(`Choose a file manually: ${field.label}`);
      continue;
    }
    const accepts = (artifact: Artifact) =>
      !field.accept ||
      field.accept
        .split(",")
        .some((a) =>
          [
            `.${artifact.format}`,
            artifact.mime,
            "*/*",
            "application/*",
          ].includes(a.trim().toLowerCase()),
        );
    // A transcript is one degree's: a field naming a level gets that
    // level's or none (see shared/transcripts.ts).
    const picked = kind === "transcript" ? pickTranscript(field.label, job.artifacts.filter(accepts), profile) : undefined;
    if (picked?.missing) {
      issues.push(`Upload your ${picked.missing} transcript yourself for "${field.label}", or attach it to its school under Education in the dashboard. Another degree's was not used.`.slice(0, 350));
      continue;
    }
    const artifact = picked ? picked.artifact : job.artifacts.find((a) => a.kind === kind && accepts(a));
    if (!artifact && kind === "transcript" && !job.artifacts.some((a) => a.kind === "transcript")) {
      issues.push(`No transcript to upload for ${field.label}: add yours under Settings, in the dashboard.`);
      continue;
    }
    if (!artifact) {
      issues.push(`No supported document format: ${field.label}`);
      continue;
    }
    if (field.attachmentId === artifact.id) continue;
    const bytes = await api(`/v1/artifacts/${artifact.id}`);
    if (!alive(app, operation)) return "stop";
    // A continuation reuses the document under a fresh operation's ID.
    // An upload already confirmed by this extension, still retained under
    // the exact filename and containing identical bytes, is not sent again.
    const fingerprint = await digest(bytes.data);
    const memo = artifact.education !== undefined ? `${kind}:${artifact.education}` : kind;
    if ((field.attachmentId || held) && field.value === artifact.name &&
      app.uploadedDocuments?.[memo] === fingerprint) continue;
    // Workday empties its file input once the upload is done and lists the
    // file beside it: the same document already shown there is not sent
    // again on a second fill.
    if (app.uploadedDocuments?.[memo] === fingerprint &&
      (await frameCall(app, frame.frameId, { type: "ATTACHED", name: artifact.name }).catch(() => undefined))?.attached) continue;
    if (!alive(app, operation)) return "stop";
    // The site rewrites the form from this upload, often reloading before
    // the upload can be confirmed; what it parses may be replaced later.
    if (resumeFirst && field.replacesForm) {
      app.siteFillPending = true;
      app.continueAfterSiteFill = true;
      app.siteFillTried = true;
      await persist();
    }
    // The field as the page now reads, not as the step began: an upload
    // before it redraws its group (Workday's shared uploader, where the
    // resume goes first), and the cover letter sent with the revision read
    // before that was refused as stale and never uploaded.
    const now = frame.observation.fields.find((f) => f.id === field.id) ||
      frame.observation.fields.find((f) => f.kind === "file" && fileKind(f) === kind && f.label === field.label);
    if (!now) {
      issues.push(`Verify upload: ${field.label}`);
      continue;
    }
    if (kind === "resume" && !resume.filledBeforeResume) {
      resume.filledBeforeResume = new Map(frame.observation.fields.filter((f) => f.kind !== "file" && f.value).map((f) => [f.id, f.value]));
      resume.fieldsBeforeResume = new Set(frame.observation.fields.map((f) => f.id));
    }
    if (kind === "resume" && !app.resumeSent) {
      app.resumeSent = true;
      await persist();
    }
    try {
      const result = await frameCall(app, frame.frameId, {
        type: "ATTACH",
        documentId: frame.observation.documentId,
        fieldId: now.id,
        expectedValue: now.value,
        revision: now.revision,
        artifact: bytes,
        profile,
        replaceExisting: held,
      });
      if (!alive(app, operation)) return "stop";
      frame.observation = result.observation;
      // Workday empties the input once the upload is done and lists the
      // file elsewhere on the page: the name shown there confirms it.
      const shown = !result.siteError && !result.attached &&
        (await frameCall(app, frame.frameId, { type: "ATTACHED", name: artifact.name }).catch(() => undefined))?.attached;
      if (!alive(app, operation)) return "stop";
      if (result.siteError)
        issues.push(
          `${field.label} upload failed on the site: "${result.siteError}". Reload the page, then choose Fill this step.`,
        );
      else if (!result.attached && !shown) issues.push(`Verify upload: ${field.label}`);
      else {
        app.uploadedDocuments = { ...app.uploadedDocuments, [memo]: fingerprint };
        if (held) {
          const note = `Replaced the ${field.label} the site already had with this application's tailored one.`;
          if (!app.configNotes?.includes(note)) app.configNotes = [...(app.configNotes || []), note];
        }
        await persist();
      }
    } catch (error) {
      if (!alive(app, operation)) return "stop";
      issues.push((error as Error).message);
    }
  }
}

// Part of run(), for one frame: the site rules (the config engine) run in the frame.
// Sites that upload through a dialog (SuccessFactors' "Upload a Resume")
// show no file field until it opens. A document with no file field of its
// kind on the page goes through the site config's upload steps instead.
// Not in an embedded frame with nothing in it: Microsoft's near-empty
// profile export frame, gone by then, turned the rule's uploads into a
// résumé and cover letter reported as failed while the résumé was in.
// "stop" when the run is over (the application moved on or was stopped).
async function fillByConfig(
  { app, configResumeFirst, fieldKinds, fileKind, frame, issues, job, operation, profile, resumeFirst }: {
  app: Application;
  configResumeFirst: boolean;
  fieldKinds: Set<DocumentKind | undefined>;
  fileKind: (f: Field) => DocumentKind | undefined;
  frame: Frame;
  issues: string[];
  job: GenerationJob;
  operation: number;
  profile: Profile;
  resumeFirst: boolean;
  },
): Promise<"stop" | undefined> {
  if (configEngineEnabled && (!resumeFirst || frame.observation.resumeSlotOpen) && (frame.frameId === 0 || frame.observation.fields.length)) {
    for (const field of frame.observation.fields.filter((f) => f.kind === "file")) fieldKinds.add(fileKind(field));
    // One document at a time: SuccessFactors saves an upload and then
    // reloads the whole form from its server (recording),
    // dropping whatever was filled and not yet saved, and an upload still
    // under way when that happens is lost.
    let uploaded = false;
    // Whatever the site writes from here is its parse, for the next pass
    // to correct; and that pass does not upload first again.
    if (resumeFirst) {
      app.siteFillPending = true;
      app.siteFillTried = true;
      await persist();
    }
    // The resume alone when the site fills the form from it.
    for (const kind of resumeFirst ? (["resume"] as const) : (["resume", "cover"] as const)) {
      const artifact =
        job.artifacts.find((a) => a.kind === kind && a.format === "pdf") ||
        job.artifacts.find((a) => a.kind === kind);
      const key = `${frame.observation.documentId}|${kind}`;
      if (!artifact || fieldKinds.has(kind) || configUploads.has(key)) continue;
      const bytes = await api(`/v1/artifacts/${artifact.id}`);
      if (!alive(app, operation)) return "stop";
      // Already attached by this application: its config steps would
      // remove it to upload it again. A file of the same name is not
      // enough (an earlier application's "Alex_Rivera_Cover_Letter.pdf"),
      // so it must be the very document this application uploaded.
      const fingerprint = await digest(bytes.data);
      const attached = await frameCall(app, frame.frameId, { type: "ATTACHED", name: artifact.name }).catch(() => undefined);
      if (attached?.attached && app.uploadedDocuments?.[kind] === fingerprint) continue;
      const before = frame.observation.fields.length;
      const markedSent = kind === "resume" && !app.resumeSent;
      if (markedSent) {
        app.resumeSent = true;
        await persist();
      }
      let answered = true;
      const result = await frameCall(app, frame.frameId, {
        type: "CONFIG_FILL",
        documentId: frame.observation.documentId,
        documentURL: frame.observation.url,
        profile,
        onlyKeys: [kind === "cover" ? "coverLetter" : "resume"],
        uploads: { [kind]: bytes },
      }).catch((error: Error) => {
        answered = false;
        return { statuses: [{ key: kind, status: "failed", reason: error.message }] };
      });
      if (!alive(app, operation)) return "stop";
      const statuses = (result.statuses || []) as { key: string; status: string; reason?: string }[];
      // The page answered and took no file (a frame with no upload of its
      // own, or its slot locked): nothing was sent, so a resume the site
      // holds in another frame (iCIMS keeps the account's in the form's
      // iframe) is still this application's to replace.
      if (markedSent && answered && !statuses.some((status) => status.status === "filled")) {
        app.resumeSent = false;
        await persist();
      }
      app.configNotes = [
        ...(app.configNotes || []),
        ...statuses
          .filter((status) => status.status !== "filled")
          .map((status) => `upload ${status.key}: ${status.reason || status.status}`.slice(0, 200)),
      ].slice(0, 80);
      if (statuses.some((status) => status.status === "filled")) {
        configUploads.add(key);
        app.uploadedDocuments = { ...app.uploadedDocuments, [kind]: fingerprint };
        await persist();
        uploaded = true;
        // Uploaded first: until the slot shows the file and the site's
        // parse has stopped changing the form (the same values on two
        // reads a second apart, from the fourth second), or 30 seconds.
        // The fill that follows then writes the profile's values last.
        if (resumeFirst) {
          let previous = "";
          let steady = 0;
          for (let waited = 0; waited < 30 && steady < 2; waited++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (!alive(app, operation)) return "stop";
            const now: Observation | undefined = await frameCall(app, frame.frameId, { type: "INSPECT", documentId: frame.observation.documentId }).catch(() => undefined);
            const form = now && !now.resumeSlotOpen ? JSON.stringify(now.fields.map((field) => [field.id, field.value])) : "";
            steady = form && form === previous && waited >= 3 ? steady + 1 : 0;
            previous = form;
          }
          continue;
        }
        // Until the site has reloaded the form (it loses fields), or for
        // ten seconds when it does not.
        for (let waited = 0; waited < 10; waited++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!alive(app, operation)) return "stop";
          const now: Observation | undefined = await frameCall(app, frame.frameId, { type: "INSPECT", documentId: frame.observation.documentId }).catch(() => undefined);
          if (now && now.fields.length < before) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            break;
          }
        }
      } else
        for (const status of statuses)
          // A page with no upload of this kind is not a failed upload.
          if (status.status === "failed" && !/No configured selector matched/i.test(status.reason || ""))
            issues.push(
              `${kind === "cover" ? "Cover letter" : "Resume"} upload did not finish${status.reason ? ` (${status.reason})` : ""}. Upload it yourself.`.slice(0, 350),
            );
    }
    if (!alive(app, operation)) return "stop";
    // The form may have been reset by the uploads: fill it again from the
    // start. The documents are not uploaded twice. A resume sent first is
    // followed by the fill whether or not it went up; that pass reports a
    // failed upload as any other.
    if (uploaded || configResumeFirst) {
      // A new generation request follows (its answers are for the form as
      // it now is); the backend hands back this application's finished
      // documents instead of tailoring them again.
      app.operation++;
      app.jobId = undefined;
      app.artifacts = [];
      app.narrative = undefined;
      app.generationKey = undefined;
      touch(
        app,
        "queued",
        configResumeFirst
          ? "Resume uploaded first; the site filled the form from it. Filling the form…"
          : "Documents uploaded; the site reloaded the form. Filling it again…",
      );
      await persist();
      return "stop";
    }
  }
}

export async function invalidate(
  app: Application,
  status: "paused" | "cancelled",
  note: string,
) {
  answerRequests.delete(app.id);
  if (app.answerSession) void api(`/v1/jobs/${app.answerSession.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
  fieldFallbackRequests.delete(app.id);
  if (app.fieldFallbackSession?.jobId)
    void api(`/v1/jobs/${app.fieldFallbackSession.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
  app.fieldFallbackSession = undefined;
  app.operation++;
  app.explicitFill = false;
  app.continueAfterSiteFill = false;
  app.replaceDocuments = false;
  touch(app, status, note);
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    attempt.completedAt = Date.now();
    attempt.status = "paused";
    attempt.note = note;
    attempt.filled = app.filled;
  }
  if (app.tabId !== undefined) await releaseTrustedInput(app.tabId);
  await persist();
  await broadcast(app, "PAUSE");
  if (app.jobId) await api(`/v1/jobs/${app.jobId}`, "DELETE").catch(() => { /* the backend job is only cleanup: it expires on its own */ });
  app.jobId = undefined;
  app.generationKey = undefined;
  await persist();
  schedule();
}
