import { usableImages } from "../shared/issue-images";
import { answerChoices, canonicalAnswer, choiceLabels, leftReasons, type ChoiceField } from "../shared/answers";
import { leftReason } from "../shared/questions";
import { DRAFT_ONLY_NOTE, draftOnlySite } from "../shared/matching";
import React, { useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { profileEditorReducer, resumeFacts } from "./profile-state";
import { JobFitAssessment } from "./job-fit";
import { QuestionAnswers } from "./question-answers";
import { RecurringAnswers } from "./recurring-answers";
import { FindJobs } from "./find-jobs";
import { CareerEditor, LocaleEditor, SalaryEditor, WorkAuthorizationEditor } from "./profile-fields";
import { FieldFallback } from "./field-fallback";
import { DraftingSettings } from "./drafting-settings";
import { BrandMark } from "./brand";
import { FillLane } from "./fill-lane";
import { Momentum } from "./momentum";
import { ProgressBoard } from "./progress-board";
import { Appearance } from "./appearance";
import { isGoal, useStoredValue } from "./prefs";
import { ConnectCard, OnboardingChecklist } from "./onboarding";
import { computeProgress, DEFAULT_DAILY_GOAL } from "../shared/progress";
import { ATTACHMENT_LIMIT, issueSummary, newIssueLink, replacedSummary, sharedFileName, type SharedReport } from "../shared/share";
import {

  emptyProfile,
  type Application,
  type TailoringItem,
  type Artifact,
  type Profile,
  type QueueState,
  type TabContext,
  type IssueReport,
  type IssueImage,
  type RoleOverride,
  ISSUE_IMAGE_LIMIT,
  type SubmissionRecord,
  type FixerOverview,
  type FixerResult,
  type IssueCategory,
  type Recording,
  type WorkflowStage,
  legalDetailChoices,
  legalDetailLabels,
  type LegalDetailKey,
  uncheckedText,
  siteRuleProblems,
} from "../shared/model";

// An education entry's own transcript: uploaded to the
// transcripts folder, and its name kept on the entry, so a form asking for
// one degree's transcript gets that degree's (shared/transcripts.ts).
export function TranscriptPicker({ value, onChange }: { value?: string; onChange: (name: string | undefined) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem("");
    if (!/\.(pdf|docx)$/i.test(file.name)) return setProblem("A transcript must be a PDF or a Word (.docx) file.");
    if (file.size > 8 * 1024 * 1024) return setProblem("The transcript is larger than 8 MB.");
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      await command({ type: "API", path: "/v1/transcript", method: "PUT", body: { name: file.name, data: btoa(binary) } });
      onChange(file.name);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="transcript-picker">
      <label>
        Transcript for this school (optional)
        <input type="file" accept=".pdf,.docx" disabled={busy} onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {value && (
        <small>
          {value}{" "}
          <button className="text-button muted" type="button" onClick={() => onChange(undefined)}>
            Remove
          </button>
        </small>
      )}
      {busy && <small>Saving…</small>}
      {problem && <small className="fill-blocker">{problem}</small>}
    </div>
  );
}

export async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}
export const api = <T,>(path: string, method = "GET", body?: unknown) =>
  command<T>({ type: "API", path, method, body });
import { codexEfforts, fixerAgents, type FixerAgent, type FixerSettings } from "../shared/fixer-settings";
import { devToolsBuild } from "../shared/dev-tools";
import { storeBuild } from "../shared/store-build";
import { StepButtons } from "./step-buttons";
import { describeBuild, extensionBuild, newerBuild, type BuildStamp } from "../shared/build";
import { QueuePage } from "./panel/queue-page";
import { SubmittedPage } from "./panel/submitted-page";
import { FixerPage } from "./panel/fixer-page";
import { IssuesPage } from "./panel/issues-page";
import { ProfilePage } from "./panel/profile-page";
import { SettingsPage } from "./panel/settings-page";

// A report being written, kept across reloads of the panel.
const ISSUE_DRAFT_KEY = "issueDraft";
type IssueDraft = { category: IssueCategory; note: string; images: IssueImage[] };
export const agentNames: Record<FixerAgent, string> = { claude: "Claude", claude2: "Claude (separate login)", codex: "Codex", endpoint: "OpenAI-compatible endpoint" };
// Suggestions only: any model name the agent's CLI takes is accepted.
// "default" is the Codex CLI's own configured model; an empty endpoint model
// is the backend's endpoint model.
export const modelSuggestions: Record<"claude" | "codex" | "endpoint", string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["default"],
  endpoint: [],
};
// One bundle, two pages: the side panel (panel.html) is the applications
// being worked on; the profile, issue reports and settings are a full browser
// tab (dashboard.html), whose address names the page after a "#".
type Page = "queue" | "profile" | "jobs" | "submitted" | "fixer" | "issues" | "settings";
// The Fixer page is the owner's development tool, only in a build that has it.
const dashboardPages = (["profile", "jobs", "submitted", "fixer", "issues", "settings"] as const).filter((item) => item !== "fixer" || devToolsBuild);
// An application that went in, was given up on, or cannot go on: nothing in
// it needs the applicant, whatever its last fill left as its status.
export const finished = (app: { workflowStage: string }) => ["submitted", "blocked", "abandoned"].includes(app.workflowStage);
const isDashboard = location.pathname.endsWith("/dashboard.html");
const dashboardPage = (): Page =>
  dashboardPages.find((item) => item === location.hash.slice(1)) || "profile";
export async function openDashboard(page: Page = "profile") {
  const url = chrome.runtime.getURL("dashboard.html");
  const open = (await chrome.tabs.query({})).find((tab) => tab.url?.split("#")[0] === url);
  if (!open?.id) return void (await chrome.tabs.create({ url: `${url}#${page}` }));
  await chrome.tabs.update(open.id, { active: true, url: `${url}#${page}` });
  await chrome.windows.update(open.windowId, { focused: true });
}
// Examples only: nothing here is saved unless the applicant types it.
const legalDetailHints: Record<LegalDetailKey, string> = {
  criminal: "e.g. No convictions and no pending charges",
  clearance: "e.g. None; never held one",
  exportControl: "e.g. U.S. citizen (a U.S. person under ITAR and EAR)",
  agreements: "e.g. Not bound by any non-compete or non-solicitation agreement",
  terminations: "e.g. Never dismissed or asked to resign",
  government: "e.g. Never a government employee or public official",
  relatives: "e.g. No relatives at any company I apply to",
  screening: "e.g. Willing to complete a background check and drug screening",
  other: "Anything else an application may ask about your eligibility",
};
// What a fill is writing right now, and what it has worked on so far.
// One bar per document and written question being prepared. A bar moves only
// when the server reports a step ended; a step in progress with nothing
// finished yet is an indeterminate bar.
function tailoringText(item: TailoringItem) {
  if (item.state === "done") return "Done";
  if (item.state === "failed") return item.error ? `Failed: ${item.error}` : "Failed";
  const count = item.total > 1 ? ` (${item.done} of ${item.total})` : "";
  if (item.state === "waiting") return item.done ? `Next: ${item.step || "waiting"}${count}` : "Waiting";
  return `${item.step || "Working"}…${count}`;
}
export function TailoringBars({ app }: { app: { status: string; draftJobId?: string; tailoring?: TailoringItem[] } }) {
  const items = app.tailoring;
  if (!items?.length || (app.status !== "preparing" && !app.draftJobId)) return null;
  return (
    <ul className="tailoring-bars" aria-label="Tailoring progress">
      {items.map((item) => {
        const indeterminate = item.state === "running" && item.done === 0;
        return (
          <li className={`tailoring-bar is-${item.state}`} key={item.id}>
            <div className="tailoring-bar-head">
              <strong>{item.name}</strong>
              <small>{tailoringText(item)}</small>
            </div>
            <div
              className={`tailoring-track${indeterminate ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-label={`${item.name}: ${tailoringText(item)}`}
              aria-valuemin={0}
              aria-valuemax={item.total}
              aria-valuenow={indeterminate ? undefined : item.done}
              aria-valuetext={tailoringText(item)}
            >
              <span style={indeterminate ? undefined : { width: `${(item.done / item.total) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
export function FillProgress({ app }: { app: { progress?: { current?: string; answered: string[] } } }) {
  const progress = app.progress;
  if (!progress || (!progress.current && !progress.answered.length)) return null;
  return (
    <>
      {progress.current && (
        <p className="app-note" role="status">
          Answering: {progress.current}
        </p>
      )}
      {progress.answered.length > 0 && (
        <details className="attempt-history">
          <summary>Worked on so far ({progress.answered.length})</summary>
          <ol>
            {progress.answered.map((label, index) => (
              <li key={`${index}-${label}`}>{label}</li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
// One legal or eligibility detail: a standard statement chosen from a list,
// the applicant's own sentence, or nothing (they answer that kind by hand).
// What is saved is always the sentence itself.
// An answer-bank choice, with text typed before choices existed kept visible.
export function ChoiceSelect({ field, value, onChange }: { field: ChoiceField; value: string; onChange: (value: string) => void }) {
  const current = canonicalAnswer(field, value);
  return (
    <select value={current} onChange={(e) => onChange(e.target.value)}>
      <option value="">Leave for me to answer</option>
      {answerChoices[field].map((choice) => (
        <option key={choice} value={choice}>
          {choiceLabels[field]?.[choice] || choice}
        </option>
      ))}
      {current && !(answerChoices[field] as readonly string[]).includes(current) && (
        <option value={current}>{`${current} (unrecognized; choose an option)`}</option>
      )}
    </select>
  );
}
export function LegalDetail({ topic, value, onChange }: { topic: LegalDetailKey; value: string; onChange: (value: string) => void }) {
  const choices = legalDetailChoices[topic];
  const [writing, setWriting] = useState(false);
  // A saved sentence that is none of the choices is the applicant's own.
  const own = writing || Boolean(value && !choices.includes(value)) || !choices.length;
  return (
    <label>
      {legalDetailLabels[topic]}
      {choices.length > 0 && (
        <select
          aria-label={legalDetailLabels[topic]}
          value={own ? "\__own__" : value}
          onChange={(e) => {
            const chosen = e.target.value;
            setWriting(chosen === "\__own__");
            onChange(chosen === "\__own__" ? (choices.includes(value) ? "" : value) : chosen);
          }}
        >
          <option value="">Leave for me to answer</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
          <option value={"\__own__"}>Something else (write it)</option>
        </select>
      )}
      {own && (
        <input
          aria-label={`${legalDetailLabels[topic]}, in your own words`}
          maxLength={600}
          placeholder={legalDetailHints[topic]}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
// A fill that has finished its own part while the model is still suggesting
// values for the rest is not yet "Needs attention": more is about to be filled.
export const suggesting = (app: { status: string; assisting?: boolean }) =>
  Boolean(app.assisting) && (app.status === "awaiting-user" || app.status === "ready");
export const labels: Record<string, string> = {
  queued: "Queued",
  inspecting: "Reading form",
  preparing: "Tailoring",
  filling: "Filling",
  "awaiting-user": "Needs attention",
  paused: "Paused for you",
  ready: "Ready to review",
  failed: "Couldn’t complete",
  cancelled: "Cancelled",
};
export const active = ["queued", "inspecting", "preparing", "filling"];
// The report fixer's outcome for a report (scripts/fixer.ts).
export const fixerLabels: Record<string, string> = {
  queued: "Waiting for the fixer",
  working: "The fixer is working on it",
  fixed: "Fixed",
  "needs-live-check": "Fixed, needs a live check",
  "partly-fixed": "Partly fixed",
  "not-a-bug": "Not a bug",
  "could-not-fix": "The fixer could not fix it",
  failed: "The fixer failed",
};
// Each problem the note named, and what the fixer made of it.
const problemLabels: Record<string, string> = {
  fixed: "Fixed",
  "needs-live-check": "Fixed, check live",
  "not-a-bug": "Not a bug",
  "could-not-fix": "Not fixed",
  left: "Not reached",
};
export function FixerProblems({ result }: { result: FixerResult }) {
  if (!result.problems?.length) return null;
  return (
    <ul className="fixer-problems">
      {result.problems.map((problem, index) => (
        <li key={index}>
          <strong>{problemLabels[problem.status]}</strong>: {problem.problem}
          {problem.summary ? ` (${problem.summary})` : ""}
        </li>
      ))}
    </ul>
  );
}
export const matchesQuery = (app: Application, query: string) =>
  !query.trim() ||
  `${app.company} ${app.title} ${app.url}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
export const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "Loading tab";
  }
};
// What an application still needs, split in two: problems only the
// applicant can resolve, listed openly wherever the application shows, and
// notes worth a look (optional questions left empty, protected fields).
const noteItem =
  /^(Optional unanswered:|Protected:|Verify any remaining steps|Additional unresolved fields|The job posting could not be read|Resume uploaded first)/;
export const postingSource = (source: string) =>
  source === "Pasted"
    ? "the posting you pasted"
    : source === "Posting page"
      ? "the posting page you linked"
      : `the ${source} job posting`;
// The fill could not read the posting (the card says so): ask for it.
export const postingMissing = (app: Application) =>
  app.fit?.needsPosting || app.missing.some((item) => /job posting could not be read/i.test(item));

// Where the applicant gives the posting the fill could not read. Defined
// here, not inside App, so a re-render keeps what was typed.
export function PostingPrompt({
  app,
  onSave,
}: {
  app: Application;
  onSave: (app: Application, posting: { postingUrl: string; postingText: string }) => void;
}) {
  return (
    <form
      className="posting-prompt"
      aria-label="Add the job posting"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onSave(app, {
          postingUrl: String(values.get("postingUrl") || ""),
          postingText: String(values.get("postingText") || ""),
        });
      }}
    >
      <strong>Add the job posting</strong>
      <label>
        Its link
        <input name="postingUrl" type="url" placeholder="https://…" defaultValue={app.postingUrl || ""} />
      </label>
      <details>
        <summary>Or paste its text</summary>
        <textarea name="postingText" rows={4} aria-label="Posting text" defaultValue={app.postingText || ""} />
      </details>
      <button className="secondary small" type="submit">Save posting</button>
    </form>
  );
}

// A question left for the applicant, marked as one the application needs or
// one it can go without; anything else reads as it is.
function IssueText({ item }: { item: string }) {
  const [, mark, question] = item.match(/^(Required|Optional unanswered): ([\s\S]*)$/) || [];
  if (!mark) return <>{item}</>;
  return (
    <>
      <span className={`question-mark ${mark === "Required" ? "required" : "optional"}`}>{mark === "Required" ? "Required" : "Optional"}</span>{" "}
      {question}
    </>
  );
}

// What the applicant has to do on an application, grouped by what it is and
// said briefly: the questions it needs from them (each with why the fill
// left it), values to check, notes about the documents, and anything else.
// One flat list of every note, questions at full length with no reason,
// told them nothing about what to do.
const shortQuestion = (text: string) => {
  const plain = text.replace(/\s+/g, " ").trim();
  // The question itself where a preamble comes first ("…if you are hired.Are you…").
  const asked = plain.match(/(?:^|[.!?]\s*)((?:are|do|did|have|has|will|would|can|could|is|what|which|how|when|where|who|please|i |if )[^?]*\??)\s*$/i)?.[1] || plain;
  return asked.length > 120 ? `${asked.slice(0, 117).trimEnd()}…` : asked;
};
type Issue = { text: string; full: string; why?: string };
function issueGroups(app: Application) {
  const { reasons, used } = leftReasons(app.missing);
  const answer: Issue[] = [];
  const check: Issue[] = [];
  const documents: Issue[] = [];
  const other: Issue[] = [];
  // "Legal or eligibility question left for you: <question>" says why a
  // required question was left: shown as its reason, not a second entry.
  const legal = app.missing.flatMap((item) => item.match(/^Legal or eligibility question left for you: ([\s\S]*)$/)?.[1] ?? []);
  for (const item of app.missing) {
    if (noteItem.test(item) || used.has(item) || /^Legal or eligibility question left for you: /.test(item)) continue;
    const required = item.match(/^Required: ([\s\S]*)$/)?.[1];
    if (required !== undefined) {
      const question = required.replace(/\s*\(left alone: [^)]*\)[\s\S]*$/, "");
      const lock = required.match(/\(left alone: ([^)]*)\)/)?.[1];
      answer.push({
        text: shortQuestion(question),
        full: question,
        why: reasons.get(item) || (lock ? `Kept empty by ${lock}. Choose Unlock empty fields to have it filled.` : leftReason(question)) ||
          (legal.some((asked) => asked.startsWith(question.slice(0, 60)) || question.startsWith(asked.slice(0, 60))) ? "A legal or eligibility question: Application Lane leaves these to you. Save an answer in your profile to reuse it." : undefined) ||
          "Your profile has no answer for it yet. Answer it here, or save an answer in your profile to reuse it.",
      });
      continue;
    }
    const sited = item.match(/^([\s\S]*?): "([\s\S]*?)" was filled in by the site from your resume and not corrected/);
    if (sited) {
      check.push({ text: shortQuestion(sited[1]), full: sited[1], why: `The site put "${sited[2].slice(0, 80)}" here from your resume. Check it.` });
      continue;
    }
    if (/^(Kept a paragraph|Took a sentence|Kept your resume|The cover letter|Drafts)\b/i.test(item)) {
      documents.push({ text: item.length > 160 ? `${item.slice(0, 157).trimEnd()}…` : item, full: item });
      continue;
    }
    other.push({ text: item.length > 200 ? `${item.slice(0, 197).trimEnd()}…` : item, full: item });
  }
  return { answer, check, documents, other };
}

function IssueList({ items, mark }: { items: Issue[]; mark?: string }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i} title={item.full}>
          {mark && <><span className="question-mark required">{mark}</span>{" "}</>}
          {item.text}
          {item.why && <p className="app-note">{item.why}</p>}
        </li>
      ))}
    </ul>
  );
}

export function AppIssues({ app }: { app: Application }) {
  const { answer, check, documents, other } = issueGroups(app);
  const notes = app.missing.filter((item) => noteItem.test(item));
  const ruleProblems = siteRuleProblems(app.configNotes);
  const count = answer.length + check.length + documents.length + other.length;
  const parts = [
    answer.length && `${answer.length} to answer`,
    check.length && `${check.length} to check`,
    documents.length && `${documents.length} about your documents`,
    other.length && `${other.length} other`,
  ].filter(Boolean).join(" · ");
  return (
    <>
      {count > 0 && (
        // Folded by default: a list of varying length above the buttons moved
        // Fill this step about as it grew.
        <details className="app-problems" aria-label="Problems to resolve">
          <summary>
            <strong>Needs you: {parts}</strong>
          </summary>
          {answer.length > 0 && <><h4>Questions to answer before submitting</h4><IssueList items={answer} mark="Required" /></>}
          {check.length > 0 && <><h4>Values to check</h4><IssueList items={check} /></>}
          {documents.length > 0 && <><h4>Your documents</h4><IssueList items={documents} /></>}
          {other.length > 0 && <><h4>Other</h4><IssueList items={other} /></>}
        </details>
      )}
      {ruleProblems.length > 0 && (
        // Folded, and not counted as needing the applicant: the general fill
        // often filled the same field after the rule's step failed.
        <details className="app-notes">
          <summary>
            {ruleProblems.length} site-rule step{ruleProblems.length === 1 ? "" : "s"} did not work
          </summary>
          <p className="app-note">The site's own rules could not complete these. The general fill may have filled the same fields afterwards: check them on the page.</p>
          <ul>
            {ruleProblems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      {notes.length > 0 && (
        <details className="app-notes">
          <summary>
            {notes.length} note{notes.length === 1 ? "" : "s"} to review
          </summary>
          <ul>
            {notes.map((item, i) => (
              <li key={i}>
                <IssueText item={item} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

// Where a "drafting is not set up" note leads: the dashboard's Settings.
export function DraftingLink() {
  return (
    <button className="text-button" onClick={() => void (isDashboard ? (location.hash = "settings") : openDashboard("settings"))}>
      Open Settings → Drafting
    </button>
  );
}

export function Icon({
  type,
}: {
  type: "arrow" | "plus" | "check" | "layers" | "pause" | "external";
}) {
  const paths = {
    arrow: "M4 12h15m-6-6 6 6-6 6",
    plus: "M12 5v14M5 12h14",
    check: "m5 12 4 4L19 6",
    layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
    pause: "M9 5v14M15 5v14",
    external: "M14 4h6v6m0-6L10 14M10 4H4v16h16v-6",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[type]} />
    </svg>
  );
}
// The panel's state and what it does (App's, as it was): one hook, its
// result handed to each page.
function usePanel() {
  const [page, showPage] = useState<Page>(isDashboard ? dashboardPage() : "queue");
  const setPage = (next: Page) => {
    if (!isDashboard) return void openDashboard(next);
    location.hash = next;
    showPage(next);
  };
  const [queue, setQueue] = useState<QueueState>({
    applications: [],
    settings: { concurrency: 4, generationConcurrency: 2 },
  });
  const [{ profile, imports }, dispatchProfile] = useReducer(
    profileEditorReducer,
    { profile: structuredClone(emptyProfile), imports: [] },
  );
  // Answers the extension profile and the job-applier files disagree on.
  const [conflicts, setConflicts] = useState<
    { field: string; extension: string; markdown: string; file: string }[]
  >([]);
  const setProfile = (update: Profile | ((profile: Profile) => Profile)) =>
    dispatchProfile({ type: "edit", update });
  const [connected, setConnected] = useState(false);
  // Whether any drafting provider is set (Settings → Drafting).
  const [draftingReady, setDraftingReady] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairToken, setPairToken] = useState("");
  const [urls, setURLs] = useState("");
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [showTabs, setShowTabs] = useState(false);
  const [review, setReview] = useState<Application>();
  // Submitted, blocked and abandoned applications are kept under their own
  // choices and the Submitted page, not in the list of ones still to do.
  const [filter, setFilter] = useState("open");
  const [showArchived, setShowArchived] = useState(false);
  const [tabContext, setTabContext] = useState<TabContext>();
  const [scanError, setScanError] = useState("");
  const [attachChoice, setAttachChoice] = useState("");
  const [pickerQuery, setPickerQuery] = useState("");
  const [search, setSearch] = useState("");
  const [issueTarget, setIssueTarget] = useState<{ tabId: number; applicationId?: string }>();
  // A saved report, cleaned for sharing on GitHub, while its preview is open.
  const [sharing, setSharing] = useState<SharedReport>();
  const [issueCategory, setIssueCategory] = useState<IssueCategory>("fill-failure");
  const [issueNote, setIssueNote] = useState("");
  const [issueConsent, setIssueConsent] = useState(false);
  // Screenshots pasted into the report (Ctrl+V) or attached.
  const [issueImages, setIssueImages] = useState<(IssueImage & { url: string })[]>([]);
  const [issueImageError, setIssueImageError] = useState("");
  // While the report dialog is up the background knows it, so a reload waits.
  useEffect(() => {
    if (!issueTarget) return;
    const beat = () => void chrome.runtime.sendMessage({ type: "REPORT_OPEN", open: true }).catch(() => { /* the background may be asleep: the next beat tells it */ });
    beat();
    const timer = setInterval(beat, 5000);
    return () => {
      clearInterval(timer);
      void chrome.runtime.sendMessage({ type: "REPORT_OPEN", open: false }).catch(() => { /* the background may be gone: nothing to tell */ });
    };
  }, [issueTarget]);
  // The report being written is kept in the extension's storage, so a reload
  // (which reopens the panel) or closing the dialog does not lose it: the
  // applicant lost a typed note to a reload once. Cleared when captured.
  const draftLoaded = useRef(false);
  useEffect(() => {
    void chrome.storage.local.get(ISSUE_DRAFT_KEY).then((stored) => {
      const draft = stored[ISSUE_DRAFT_KEY] as IssueDraft | undefined;
      if (draft) {
        if (draft.category) setIssueCategory(draft.category);
        if (draft.note) setIssueNote((current) => current || draft.note);
        if (draft.images?.length)
          setIssueImages((current) => current.length ? current : draft.images.map((image) => ({ ...image, url: `data:${image.mime};base64,${image.data}` })));
      }
    }).catch(() => { /* no draft to restore */ }).finally(() => { draftLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!draftLoaded.current) return;
    const timer = setTimeout(() => {
      if (!issueNote.trim() && !issueImages.length) return void chrome.storage.local.remove(ISSUE_DRAFT_KEY).catch(() => undefined);
      const draft: IssueDraft = { category: issueCategory, note: issueNote, images: issueImages.map(({ mime, data }) => ({ mime, data })) };
      // Screenshots past the storage quota are dropped from the draft; the note is kept.
      void chrome.storage.local.set({ [ISSUE_DRAFT_KEY]: draft })
        .catch(() => chrome.storage.local.set({ [ISSUE_DRAFT_KEY]: { ...draft, images: [] } }))
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [issueCategory, issueNote, issueImages]);
  const addIssueImages = async (files: File[]) => {
    const images = files.filter((file) => /^image\/(png|jpeg|webp|gif)$/.test(file.type));
    if (!images.length) return false;
    const added: (IssueImage & { url: string })[] = [];
    let error = "";
    for (const file of images) {
      if (file.size === 0) {
        error = `${file.name || "An image"} was empty and was not added. Use Paste image, or copy the screenshot again.`;
        continue;
      }
      if (file.size > ISSUE_IMAGE_LIMIT.bytes) {
        error = `${file.name || "An image"} is over ${ISSUE_IMAGE_LIMIT.bytes / 1024 / 1024} MB and was not added.`;
        continue;
      }
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const data = url.slice(url.indexOf(",") + 1);
      if (!data) {
        error = `${file.name || "An image"} was empty and was not added. Copy the screenshot again.`;
        continue;
      }
      added.push({ mime: file.type as IssueImage["mime"], data, url });
    }
    setIssueImages((current) => {
      const next = [...current, ...added];
      if (next.length > ISSUE_IMAGE_LIMIT.count) error = `A report holds up to ${ISSUE_IMAGE_LIMIT.count} images.`;
      return next.slice(0, ISSUE_IMAGE_LIMIT.count);
    });
    setIssueImageError(error);
    return true;
  };
  // Images on a clipboard: as files, and as items (some copies carry only
  // the latter).
  const clipboardImages = (data: DataTransfer | null) => {
    if (!data) return [];
    const files = [...data.files].filter((file) => file.type.startsWith("image/"));
    if (files.length) return files;
    return [...data.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  };
  // A screenshot pasted anywhere while the report dialog is open, not only
  // in its note (: pasting did nothing).
  useEffect(() => {
    if (!issueTarget) return;
    const onPaste = (event: ClipboardEvent) => {
      const images = clipboardImages(event.clipboardData);
      if (!images.length) return;
      event.preventDefault();
      // A screenshot some tools copy arrives through a paste as an empty file
      // (the clipboard renders it only when asked): read it from the
      // clipboard itself, as the Paste image button does.
      if (images.every((file) => file.size === 0)) void pasteIssueImage();
      else void addIssueImages(images);
    };
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
  }, [issueTarget]);
  // The "Paste image" button: the clipboard read directly.
  const pasteIssueImage = async () => {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items)
        for (const type of item.types.filter((type) => type.startsWith("image/"))) {
          const blob = await item.getType(type);
          // A clipboard image is a PNG whatever it was copied from.
          files.push(new File([blob], `pasted.${type.split("/")[1]}`, { type }));
        }
      if (!files.length) return setIssueImageError("The clipboard holds no image. Copy a screenshot first.");
      await addIssueImages(files);
    } catch (error) {
      setIssueImageError(`The clipboard could not be read: ${(error as Error).message}`);
    }
  };
  const [issues, setIssues] = useState<Array<Omit<IssueReport, "frames">>>([]);
  const [submissions, setSubmissions] = useState<SubmissionRecord[] | undefined>();
  const [fixer, setFixer] = useState<FixerOverview | undefined>();
  // A build in dist/ newer than the one loaded: the extension needs a reload.
  const [waitingBuild, setWaitingBuild] = useState<BuildStamp | undefined>();
  // The fixer's agents and models as edited on its page, before saving.
  const [fixerSettings, setFixerSettings] = useState<FixerSettings | undefined>();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [activeRecordings, setActiveRecordings] = useState<
    { id: string; tabId: number; startedAt: number; eventCount: number }[]
  >([]);
  const [clock, setClock] = useState(Date.now());
  const [answerSuggestions, setAnswerSuggestions] = useState<
    { question: string; answer: string; replaces?: string; keep: boolean }[]
  >();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteDocuments, setDeleteDocuments] = useState(false);
  const [dailyGoal] = useStoredValue<number>("dailyGoal", DEFAULT_DAILY_GOAL, isGoal);
  // The applicant as one file, for another installation: the profile, the
  // tailoring folder's files and this browser's settings. No pairing token,
  // API key or application history is in it.
  async function exportProfile() {
    const bundle = await api<Record<string, unknown>>("/v1/profile/bundle");
    saveBlob(
      `application-lane-profile-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ ...bundle, settings: queue.settings }, null, 2),
      "application/json",
    );
  }
  async function importProfile(file: File) {
    if (file.size > 12 * 1024 * 1024) throw new Error("That file is too large to be a profile export.");
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      throw new Error("That file is not a profile export.");
    }
    if ((bundle as { format?: string })?.format !== "application-lane-profile")
      throw new Error("That file is not a profile export.");
    const imported = await api<{ profile: Profile; tailoring: string[]; settings?: Partial<QueueState["settings"]> }>(
      "/v1/profile/bundle",
      "PUT",
      bundle,
    );
    setProfile(imported.profile);
    // This browser's own choices come with the profile; its concurrency stays.
    if (imported.settings)
      setQueue(
        await command({
          type: "SETTINGS",
          settings: { ...queue.settings, ...imported.settings, concurrency: queue.settings.concurrency, generationConcurrency: queue.settings.generationConcurrency },
        }),
      );
    return imported.tailoring.length;
  }
  async function loadBackend() {
    const [p, status, savedIssues, savedRecordings] = await Promise.all([
      api<Profile>("/v1/profile"),
      api<any>("/v1/status"),
      api<Array<Omit<IssueReport, "frames">>>("/v1/issues"),
      api<Recording[]>("/v1/recordings"),
    ]);
    setProfile(p);
    setWaitingBuild(newerBuild(extensionBuild, status?.extensionBuild));
    setDraftingReady(Boolean(status?.configured));
    setIssues(savedIssues);
    setRecordings(savedRecordings);
    setConnected(true);
  }
  // Single-page apps (Ashby, Workday) report a finished load before they
  // draw the form, so a scan that finds nothing looks again for a while
  // before "No form" stands. A new tab or navigation starts over.
  const rescan = useRef<number | undefined>(undefined);
  // Scans answer in their own time: only the newest one may set the card, or
  // a slow read of the tab just left would replace the tab now in front.
  const scanned = useRef(0);
  // The tab just brought to the front, named at once while its page is read:
  // a read takes seconds while a fill runs, and the card meanwhile showed
  // the tab left behind, its buttons acting on that application.
  const [switching, setSwitching] = useState<{ title: string; url: string } | undefined>();
  const scanActive = (attempt = 0) => {
    window.clearTimeout(rescan.current);
    const turn = ++scanned.current;
    return command<TabContext>({ type: "ACTIVE_TAB" })
      .then((value) => {
        if (turn !== scanned.current) return;
        setSwitching(undefined);
        setTabContext(value);
        setScanError("");
        if (!attempt) setAttachChoice(value.suggestions[0]?.applicationId || "");
        const found = value.fieldCount ?? value.observation?.fields.length ?? 0;
        if (value.accessible && value.observation && !found && attempt < 5)
          rescan.current = window.setTimeout(() => void scanActive(attempt + 1), 1500 * (attempt + 1));
      })
      .catch((error) => {
        if (turn !== scanned.current) return;
        setSwitching(undefined);
        // Keep the tab actions reachable; a failed scan must not hide them.
        setTabContext(undefined);
        setScanError((error as Error).message);
      });
  };
  useEffect(() => {
    void command<QueueState>({ type: "STATE" })
      .then(setQueue)
      .catch((e) => setError(e.message));
    void loadBackend().catch(() => setConnected(false));
    void scanActive();
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      if (changes.queue) setQueue(changes.queue.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    const activated = (info: chrome.tabs.TabActiveInfo) => {
      void chrome.tabs.get(info.tabId).then((tab) => {
        setTabContext((shown) => {
          if (shown?.tabId === info.tabId) return shown;
          setSwitching({ title: tab.title || "This tab", url: tab.url || "" });
          return undefined;
        });
      }, () => {});
      void scanActive();
    };
    const updated = (_tabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (change.status === "complete" || change.url) void scanActive();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    const hashed = () => showPage(dashboardPage());
    // The profile is edited in the dashboard: the panel reads it again on
    // return. The dashboard does not, or it would drop unsaved edits.
    const returned = () => void loadBackend().catch(() => setConnected(false));
    if (isDashboard) window.addEventListener("hashchange", hashed);
    else window.addEventListener("focus", returned);
    return () => {
      window.removeEventListener("hashchange", hashed);
      window.removeEventListener("focus", returned);
      window.clearTimeout(rescan.current);
      chrome.storage.onChanged.removeListener(listener);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
    };
  }, []);
  // The card reads the tab when it comes to the front or loads; a tab tracked
  // or attached after that (Choose open tabs, Track links with the tab open)
  // left the card offering "Attach current tab" for a tab its application
  // already held, until another tab was chosen. Whenever the queue says the
  // tab belongs elsewhere than the card shows, the tab is read again.
  const shownTab = tabContext?.tabId;
  const holder =
    shownTab === undefined
      ? undefined
      : queue.applications.find((app) => app.tabs.some((tab) => tab.tabId === shownTab && !tab.closedAt) || app.tabId === shownTab)?.id;
  useEffect(() => {
    if (shownTab !== undefined && holder !== tabContext?.applicationId) void scanActive();
  }, [shownTab, holder, tabContext?.applicationId]);
  // The history of submissions, read again whenever one more goes in.
  const submittedNow = queue.applications.filter((app) => app.workflowStage === "submitted").length;
  useEffect(() => {
    if (!connected) return;
    // The history is written a moment after the list shows the stage: read
    // too soon, it lacks the newest one, so read it again until it has it.
    let timer: number | undefined;
    let tries = 0;
    const read = () =>
      void api<SubmissionRecord[]>("/v1/submissions").then((records) => {
        setSubmissions(records);
        if (records.length < submittedNow && ++tries < 10) timer = window.setTimeout(read, 1000);
      }, () => setSubmissions(undefined));
    read();
    return () => window.clearTimeout(timer);
  }, [connected, submittedNow, page]);
  // The fixer's work, read again every half minute while the page is open.
  useEffect(() => {
    if (page !== "fixer" || !devToolsBuild || !connected) return;
    const read = () => void api<FixerOverview>("/v1/fixer").then(setFixer, () => setFixer(undefined));
    read();
    void api<{ settings: FixerSettings }>("/v1/fixer/settings").then((result) => setFixerSettings(result.settings), () => setFixerSettings(undefined));
    const timer = setInterval(read, 30_000);
    return () => clearInterval(timer);
  }, [page, connected]);
  useEffect(() => {
    if (page !== "issues" || !connected) return;
    void Promise.all([
      api<Array<Omit<IssueReport, "frames">>>("/v1/issues").then(setIssues),
      api<Recording[]>("/v1/recordings").then(setRecordings),
    ]).catch(() => { /* best effort: the lists stay as they were */ });
  }, [page, connected]);
  useEffect(() => {
    if (page !== "profile" || !connected) return;
    // An older backend without the route simply shows nothing.
    void api<typeof conflicts>("/v1/profile/conflicts").then(setConflicts, () => setConflicts([]));
  }, [page, connected, profile?.revision]);
  const refreshRecordings = () =>
    command<typeof activeRecordings>({ type: "RECORDING_STATE" })
      .then(setActiveRecordings)
      .catch(() => { /* best effort: the list stays as it was */ });
  useEffect(() => {
    void refreshRecordings();
  }, [tabContext?.tabId]);
  useEffect(() => {
    if (!activeRecordings.length) return;
    const timer = setInterval(() => {
      setClock(Date.now());
      void refreshRecordings();
    }, 1000);
    return () => clearInterval(timer);
  }, [activeRecordings.length]);
  // Submission can't be detected reliably on every site, so the applicant
  // marks it; the Stage menu changes it back.
  const markSubmitted = (id: string) =>
    void action(
      async () => setQueue(await command({ type: "SET_WORKFLOW", id, stage: "submitted", reason: "" })),
      "Marked submitted. Change the stage to undo.",
    );
  // Not applying after all: any fill stops, and the application leaves the
  // open list as Abandoned (the applicant).
  const abandon = (app: { id: string; title: string }) => {
    if (!window.confirm(`Abandon "${app.title}"? Any fill stops; what is on the page stays.`)) return;
    void action(
      async () => setQueue(await command({ type: "CANCEL_APP", id: app.id })),
      "Abandoned. Change the stage to undo.",
    );
  };
  async function action(work: () => Promise<unknown>, success?: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await work();
      if (success) setNotice(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const edit = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({
      ...p,
      [key]: value,
      confirmed: key === "confirmed" ? (value as boolean) : false,
    }));
  const cleanLines = (values: string[]) =>
    values.map((value) => value.trim()).filter(Boolean);
  async function importResumes(files: File[]) {
    if (files.length > 10)
      throw new Error(
        "Select up to 10 resumes at a time. You can add more in another batch.",
      );
    dispatchProfile({ type: "start-import" });
    // Individual requests retain the existing 10 MB backend limit and avoid
    // holding a whole batch of base64-encoded resumes in memory.
    for (const file of files) {
      try {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("Choose a file smaller than 10 MB.");
        const extension = file.name.toLowerCase().match(/\.(pdf|docx)$/)?.[1];
        if (!extension) throw new Error("Choose a PDF or DOCX resume.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const result = await api<{ text: string }>("/v1/import", "POST", {
          format: extension,
          data: btoa(binary),
        });
        dispatchProfile({
          type: "import",
          name: file.name,
          facts: resumeFacts(result.text),
        });
      } catch (error) {
        dispatchProfile({
          type: "import",
          name: file.name,
          facts: [],
          error: (error as Error).message,
        });
      }
    }
  }
  async function add(items: { url: string; tabId?: number }[]) {
    if (!items.length)
      throw new Error("Select application tabs or paste at least one URL.");
    const origins = [
      ...new Set(
        items.map((item) => {
          const u = new URL(item.url);
          if (!["https:", "http:"].includes(u.protocol))
            throw new Error("Only HTTP(S) application URLs are supported.");
          return `${u.origin}/*`;
        }),
      ),
    ];
    if (!(await chrome.permissions.request({ origins })))
      throw new Error("Site access was not granted.");
    setQueue(await command({ type: "TRACK_ITEMS", items }));
    setURLs("");
    setShowTabs(false);
    setSelected([]);
  }
  const saveBlob = (name: string, value: string, type: string) => {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  async function exportIssue(id: string) {
    const report = await api<IssueReport>(`/v1/issues/${id}`);
    saveBlob(
      `application-lane-issue-${id}.json`,
      JSON.stringify(report, null, 2),
      "application/json",
    );
  }
  // Cleaned on the backend; the preview shows what would be shared.
  async function shareIssue(id: string) {
    setSharing(await api<SharedReport>(`/v1/issues/${id}/share`));
  }
  // The cleaned file is saved for the applicant to attach (a whole report is
  // far too long for a link), and the issue form opens filled in.
  function openSharedIssue(shared: SharedReport) {
    saveBlob(sharedFileName(shared.report), JSON.stringify(shared.report, null, 2), "application/json");
    window.open(newIssueLink(shared), "_blank", "noopener");
  }
  async function copyIssue(id: string) {
    const report = await api<IssueReport>(`/v1/issues/${id}`);
    await navigator.clipboard.writeText(
      `## Application Lane issue\n\n- Category: ${report.category}\n- Page: ${report.tab.title}\n- URL: ${report.tab.url}\n- Captured: ${new Date(report.createdAt).toISOString()}\n- Status: ${report.application?.status || "untracked"}\n\n${report.note || "No note supplied."}`,
    );
  }
  // Tracking a tab needs access to its site (and to a form framed inside
  // it): asked first, inside the click, as Chrome grants it only to a user
  // gesture. Reading the page needs none (the panel's own click lets it), so
  // a page the card had scanned still failed with "Grant site access for…"
  // and no prompt. An origin already granted asks nothing.
  async function siteAccess(url: string | undefined, frames: string[] = []) {
    if (!url || !/^https?:/.test(url)) return;
    const origins = [...new Set([`${new URL(url).origin}/*`, ...frames])];
    if (!(await chrome.permissions.request({ origins })))
      throw new Error("Site access was not granted, so this tab cannot be tracked.");
  }
  async function access(app: Application) {
    if (!app.tabId) return;
    // Request inside the original click gesture; frame discovery happened
    // during inspection, so no asynchronous work precedes this permission call.
    const origins = app.accessOrigins?.length
      ? app.accessOrigins
      : [`${new URL(app.url).origin}/*`];
    if (origins.length && !(await chrome.permissions.request({ origins })))
      throw new Error("Embedded site access was not granted.");
    // The application's own tab is read again with the new access. The card
    // above stays on the tab in front, which may be a different one.
    await command<TabContext>({ type: "SCAN_TAB", tabId: app.tabId });
    await scanActive();
  }
  const savePosting = (app: Application, posting: { postingUrl: string; postingText: string }) =>
    void action(
      async () => setQueue(await command({ type: "UPDATE_APP", id: app.id, ...posting })),
      "Posting saved. Check fit or fill this step using the updated posting.",
    );
  const checkFit = (app: Application) =>
    void action(async () => setQueue(await command({ type: "CHECK_FIT", id: app.id })));
  async function documents(app: Application) {
    const job = await api<{ narrative: Application["narrative"] }>(
      `/v1/jobs/${app.documentJobId || app.jobId}`,
    );
    setReview({ ...app, narrative: job.narrative });
  }
  // A PDF opens in a tab to be read; saving is the separate, explicit action.
  // Other formats have no viewer in the browser and are always saved.
  async function download(artifact: Artifact, save = false) {
    const data = await api<Artifact & { data: string }>(
      `/v1/artifacts/${artifact.id}`,
    );
    const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
    if (!save && artifact.format === "pdf") {
      await chrome.tabs.create({ url });
      // The tab reads the document from this address for as long as it is open.
      setTimeout(() => URL.revokeObjectURL(url), 600000);
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = data.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // The drafted documents as files on this machine, for a site whose upload
  // the applicant does by hand: the path goes into its file chooser.
  const documentLabel = (artifact: Artifact) =>
    artifact.kind === "resume" ? "resume" : artifact.kind === "transcript" ? "transcript" : "cover letter";
  async function copyPath(app: Application, artifact: Artifact) {
    const saved = await api<{ files: { artifactId: string; path: string }[] }>(
      `/v1/jobs/${app.documentJobId || app.jobId}/files`,
    );
    const file = saved.files.find((candidate) => candidate.artifactId === artifact.id);
    if (!file) throw new Error("This document was not saved as a file. Draft it again.");
    await navigator.clipboard.writeText(file.path);
  }
  const uploadFiles = (app: Application) =>
    app.artifacts.length > 0 && (
      <div className="upload-files" role="group" aria-label="Files to upload yourself">
        <span>Upload yourself:</span>
        {app.artifacts.map((artifact) => (
          <button
            key={artifact.id}
            className="text-button"
            title="Copies where this file is saved. Paste it into the site’s file chooser."
            onClick={() =>
              void action(
                () => copyPath(app, artifact),
                "Path copied. Paste it into the site’s file chooser.",
              )
            }
          >
            Copy {documentLabel(artifact)}
            {app.artifacts.filter((other) => other.kind === artifact.kind).length > 1 ? ` ${artifact.format.toUpperCase()}` : ""} path
          </button>
        ))}
        <button
          className="text-button"
          onClick={() =>
            void action(() => api(`/v1/jobs/${app.documentJobId || app.jobId}/files/open`, "POST"))
          }
        >
          Open folder
        </button>
      </div>
    );
  const listed = queue.applications.filter(
    (a) =>
      (showArchived ? Boolean(a.archivedAt) : !a.archivedAt) &&
      matchesQuery(a, search) &&
      (filter === "all" ||
        (filter === "open" && !finished(a)) ||
        (filter === "active" && active.includes(a.status)) ||
        (filter === "attention" && !finished(a) &&
          ["paused", "awaiting-user", "failed"].includes(a.status)) ||
        (filter === "ready" && a.status === "ready") ||
        a.workflowStage === filter),
  );
  // An application AI is still filling is in progress, not waiting on you.
  const progressing = queue.applications.filter((a) =>
    active.includes(a.status) || suggesting(a),
  ).length;
  const ready = queue.applications.filter((a) => a.status === "ready" && !suggesting(a)).length;
  const attention = queue.applications.filter((a) =>
    !finished(a) && !suggesting(a) && ["paused", "awaiting-user", "failed"].includes(a.status),
  ).length;
  // From the history, which keeps removed applications too, and
  // never fewer than the list shows submitted now.
  const submittedCount = Math.max(submissions?.length ?? 0, submittedNow);
  const linkedApplication = queue.applications.find(
    (app) => app.id === tabContext?.applicationId,
  );
  const linkedFilling = Boolean(
    linkedApplication?.explicitFill &&
      active.includes(linkedApplication.status),
  );
  const recordingHere = activeRecordings.find(
    (recording) => recording.tabId === tabContext?.tabId,
  );
  // Streak, goal and level for the momentum card and the Progress board.
  const progress = computeProgress({ submissions, applications: queue.applications, goal: dailyGoal });
  const fillRunning = queue.applications.some((app) => active.includes(app.status) && app.status !== "queued");
  // The first-run checklist (onboarding.tsx), on the side panel and the dashboard.
  const onboardingSteps = [
    { label: "Connect the backend", done: connected, detail: "" },
    {
      label: "Choose how drafts are written",
      done: draftingReady,
      detail: "Pick Claude Code, Codex or an API for résumés, letters and answers. Filling works without one.",
      action: { label: "Open Settings → Drafting", run: () => setPage("settings") },
    },
    {
      label: "Import your résumé",
      done: profile.facts.length > 0 || profile.work.length > 0,
      detail: "Import a PDF or Word résumé to start your profile.",
      action: { label: "Import résumé", run: () => setPage("profile") },
    },
    {
      label: "Review and confirm your profile",
      done: profile.confirmed,
      detail: "Check each detail; only confirmed facts are used.",
      action: { label: "Review profile", run: () => setPage("profile") },
    },
    {
      label: "Track your first application",
      done: queue.applications.length > 0 || Boolean(submissions?.length),
      detail: "Open a job application in a tab and track it from the side panel, or paste links under Track application links.",
    },
  ];
  const fillPrerequisite = !connected
    ? "Connect the local backend before filling."
    : !profile.confirmed
      ? "Confirm your profile before filling."
      : "";
  return { page, showPage, setPage, queue, setQueue, profile, imports, dispatchProfile, conflicts, setConflicts, setProfile, connected, setConnected, draftingReady, setDraftingReady, error, setError, notice, setNotice, busy, setBusy, pairToken, setPairToken, urls, setURLs, tabs, setTabs, selected, setSelected, showTabs, setShowTabs, review, setReview, filter, setFilter, showArchived, setShowArchived, tabContext, setTabContext, scanError, setScanError, attachChoice, setAttachChoice, pickerQuery, setPickerQuery, search, setSearch, issueTarget, setIssueTarget, sharing, setSharing, issueCategory, setIssueCategory, issueNote, setIssueNote, issueConsent, setIssueConsent, issueImages, setIssueImages, issueImageError, setIssueImageError, addIssueImages, clipboardImages, pasteIssueImage, issues, setIssues, submissions, setSubmissions, fixer, setFixer, waitingBuild, setWaitingBuild, fixerSettings, setFixerSettings, recordings, setRecordings, activeRecordings, setActiveRecordings, clock, setClock, answerSuggestions, setAnswerSuggestions, deleteConfirm, setDeleteConfirm, deleteDocuments, setDeleteDocuments, dailyGoal, exportProfile, importProfile, loadBackend, rescan, scanned, switching, setSwitching, scanActive, shownTab, holder, submittedNow, refreshRecordings, markSubmitted, abandon, action, edit, cleanLines, importResumes, add, saveBlob, exportIssue, shareIssue, openSharedIssue, copyIssue, siteAccess, access, savePosting, checkFit, documents, download, documentLabel, copyPath, uploadFiles, listed, progressing, ready, attention, submittedCount, linkedApplication, linkedFilling, recordingHere, progress, fillRunning, onboardingSteps, fillPrerequisite };
}
export type PanelState = ReturnType<typeof usePanel>;

function App() {
  const panel = usePanel();
  const { action, addIssueImages, answerSuggestions, busy, connected, dispatchProfile, download, error, fillRunning, issueCategory, issueConsent, issueImageError, issueImages, issueNote, issueTarget, notice, openSharedIssue, page, pasteIssueImage, profile, review, saveBlob, setAnswerSuggestions, setError, setIssueCategory, setIssueConsent, setIssueImageError, setIssueImages, setIssueNote, setIssueTarget, setIssues, setNotice, setPage, setQueue, setReview, setSharing, sharing, uploadFiles, waitingBuild } = panel;
  return (
    <div className="shell">
      <header>
        <BrandMark running={fillRunning} />
        <div className="brand">
          application<span>lane</span>
        </div>
        {!isDashboard && (
          <button
            className="text-button expand"
            title="Your profile, issue reports and settings open in a browser tab"
            onClick={() => void openDashboard()}
          >
            Dashboard <Icon type="external" />
          </button>
        )}
      </header>
      {isDashboard && (
        <nav aria-label="Main navigation">
          {dashboardPages.map((item) => (
            <button
              key={item}
              className={page === item ? "selected" : ""}
              onClick={() => setPage(item)}
            >
              {item === "profile" ? "Your profile" : item === "jobs" ? "Find jobs" : item === "submitted" ? "Submitted" : item === "fixer" ? "Fixer" : item === "issues" ? "Issues" : "Settings"}
            </button>
          ))}
        </nav>
      )}
      <main>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {waitingBuild && (
          <div className="notice" role="status">
            A newer build is ready ({describeBuild(waitingBuild)}). Reload Application Lane at chrome://extensions
            to use it; this one is {extensionBuild ? describeBuild(extensionBuild) : "older"}.
          </div>
        )}
        {notice && (
          <div className="notice success" role="status">
            {notice}
          </div>
        )}
        {page === "queue" && <QueuePage panel={panel} />}
        {page === "jobs" && <FindJobs onState={setQueue} />}
        {page === "submitted" && <SubmittedPage panel={panel} />}
        {page === "fixer" && devToolsBuild && <FixerPage panel={panel} />}
        {page === "issues" && <IssuesPage panel={panel} />}
        {page === "profile" && <ProfilePage panel={panel} />}
        {page === "settings" && <SettingsPage panel={panel} />}
      </main>
      <footer>
        <span className={`dot ${connected ? "" : "offline"}`} />
        {connected
          ? "Connected to your local backend"
          : "Local backend not connected"}
        <span>Review before submitting</span>
      </footer>
      {issueTarget && (
        <div className="modal-backdrop" onClick={() => setIssueTarget(undefined)}>
          <section
            className="modal issue-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Report an extension issue"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <h2>Report an issue</h2>
              <button className="icon-button" aria-label="Close issue report" onClick={() => setIssueTarget(undefined)}>×</button>
            </div>
            <p className="help">
              If this application is filling, it will pause while the report is captured. Other applications continue.
            </p>
            <label>
              What went wrong?
              <select value={issueCategory} onChange={(event) => setIssueCategory(event.target.value as IssueCategory)}>
                <option value="wrong-value">Wrong value</option>
                <option value="field-not-detected">Field not detected</option>
                <option value="fill-failure">Could not fill</option>
                <option value="upload">Document upload</option>
                <option value="tab-matching">Tab matching</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              What were you doing?
              <textarea
                rows={4}
                value={issueNote}
                onChange={(event) => setIssueNote(event.target.value)}
                placeholder="A short note helps reproduce the problem. Paste screenshots here (Ctrl+V)."
              />
            </label>
            <div className="issue-images">
              {issueImages.map((image, index) => (
                <figure key={index}>
                  <img src={image.url} alt={`Screenshot ${index + 1}`} />
                  <button className="icon-button" aria-label={`Remove screenshot ${index + 1}`} onClick={() => setIssueImages((current) => current.filter((_, at) => at !== index))}>×</button>
                </figure>
              ))}
              {issueImages.length < ISSUE_IMAGE_LIMIT.count && (
                <button type="button" className="secondary attach-image" onClick={() => void pasteIssueImage()}>
                  Paste image
                </button>
              )}
              {issueImages.length < ISSUE_IMAGE_LIMIT.count && (
                <label className="secondary attach-image">
                  Attach image
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    onChange={(event) => {
                      void addIssueImages([...(event.target.files || [])]);
                      event.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            {issueImageError && <p className="help error">{issueImageError}</p>}
            <label className="snapshot-consent">
              <input type="checkbox" checked={issueConsent} onChange={(event) => setIssueConsent(event.target.checked)} />
              Include this page’s rendered markup and entered form values. Passwords and recognized security tokens are redacted.
            </label>
            <div className="row">
              <button className="secondary" onClick={() => setIssueTarget(undefined)}>Cancel</button>
              <button
                className="primary"
                disabled={!issueConsent || busy}
                onClick={() => {
                  // The form closes now: capturing (pausing the fill, saving the
                  // recording, reading every frame, the network log and the
                  // upload) took seconds with the menu left open. What it was
                  // given is kept, and the outcome is said when it is saved.
                  const given = {
                    tabId: issueTarget.tabId,
                    category: issueCategory,
                    note: issueNote,
                    images: usableImages(issueImages).map(({ mime, data }) => ({ mime, data })),
                  };
                  setIssueTarget(undefined);
                  setIssueNote("");
                  setIssueImages([]);
                  setIssueImageError("");
                  setIssueConsent(false);
                  setNotice("Saving the report…");
                  void action(async () => {
                    const result = await command<{ report: IssueReport; saved: boolean; saveError: string }>({
                      type: "REPORT_ISSUE",
                      ...given,
                    });
                    if (result.saved)
                      setIssues((current) => [{ ...result.report, frames: undefined } as Omit<IssueReport, "frames">, ...current]);
                    else
                      saveBlob(
                        `application-lane-issue-${result.report.id}.json`,
                        JSON.stringify(result.report, null, 2),
                        "application/json",
                      );
                    setQueue(await command({ type: "STATE" }));
                    setNotice(result.saved ? "Issue saved locally." : `Backend unavailable; report downloaded instead. ${result.saveError}`);
                  });
                }}
              >
                Capture report
              </button>
            </div>
          </section>
        </div>
      )}
      {answerSuggestions && (
        <div className="modal-backdrop" onClick={() => setAnswerSuggestions(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Save your answers"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <h2>Save your answers</h2>
              <button className="icon-button" aria-label="Close saved answers" onClick={() => setAnswerSuggestions(undefined)}>×</button>
            </div>
            <p className="help">
              Saved answers fill the exact same question on future applications.
              You can edit or remove them under Your profile.
            </p>
            <div className="answer-choices">
              {answerSuggestions.map((item, index) => (
                <label key={item.question} className="answer-choice">
                  <input
                    type="checkbox"
                    checked={item.keep}
                    onChange={(event) =>
                      setAnswerSuggestions((current) =>
                        current?.map((choice, i) => (i === index ? { ...choice, keep: event.target.checked } : choice)),
                      )
                    }
                  />
                  <span>
                    <strong>{item.question}</strong>
                    <span className="answer-value">{item.answer}</span>
                    {item.replaces !== undefined && (
                      <small>Replaces your saved answer: {item.replaces}</small>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div className="row">
              <button className="secondary" onClick={() => setAnswerSuggestions(undefined)}>Cancel</button>
              <button
                className="primary"
                disabled={busy || !answerSuggestions.some((item) => item.keep)}
                onClick={() =>
                  void action(async () => {
                    const chosen = answerSuggestions.filter((item) => item.keep);
                    const saved = await command<Profile>({
                      type: "SAVE_ANSWERS",
                      answers: chosen.map(({ question, answer }) => ({ question, answer })),
                    });
                    dispatchProfile({ type: "edit", update: saved });
                    setAnswerSuggestions(undefined);
                    setNotice(`Saved ${chosen.length} answer${chosen.length === 1 ? "" : "s"}. They fill the same questions next time.`);
                  })
                }
              >
                Save selected
              </button>
            </div>
          </section>
        </div>
      )}
      {sharing && (() => {
        const file = JSON.stringify(sharing.report, null, 2);
        const size = new Blob([file]).size;
        const tooLarge = size > ATTACHMENT_LIMIT;
        return (
          <div className="modal-backdrop" onClick={() => setSharing(undefined)}>
            <section
              className="modal share-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Share report on GitHub"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="section-title">
                <h2>Share on GitHub</h2>
                <button className="icon-button" aria-label="Close share preview" onClick={() => setSharing(undefined)}>×</button>
              </div>
              <p className="help">
                GitHub issues are public. Your details in this report were replaced with made-up ones
                {Object.keys(sharing.replaced).length ? `: ${replacedSummary(sharing.replaced)}` : " (none were found)"}.
                {sharing.removed.length ? ` Left out: ${sharing.removed.join(", ")}.` : ""} The company and site of
                this application stay, so the problem can be reproduced. Look the preview over before you share it.
              </p>
              <h3>Summary for the issue</h3>
              <pre className="share-preview" aria-label="Issue summary">{issueSummary(sharing)}</pre>
              <details>
                <summary>Cleaned report ({(size / 1024 / 1024).toFixed(size < 1024 * 1024 ? 2 : 1)} MB)</summary>
                <pre className="share-preview" aria-label="Cleaned report">{file.length > 200_000 ? `${file.slice(0, 200_000)}\n…` : file}</pre>
              </details>
              {tooLarge && (
                <p role="alert" className="notice">
                  The cleaned report is larger than the 25 MB GitHub takes as an attachment.
                </p>
              )}
              <p className="help">
                The cleaned report is saved to your downloads as {sharedFileName(sharing.report)}. Drag it into the
                issue's Cleaned report box on GitHub, then submit the issue there.
              </p>
              <div className="actions">
                <button
                  disabled={tooLarge}
                  onClick={() => {
                    openSharedIssue(sharing);
                    setSharing(undefined);
                  }}
                >
                  Save report and open GitHub
                </button>
                <button className="secondary" onClick={() => setSharing(undefined)}>Cancel</button>
              </div>
            </section>
          </div>
        );
      })()}
      {review && (
        <div className="modal-backdrop" onClick={() => setReview(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Application documents"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-title">
              <h2>Documents for this application</h2>
              <button
                className="icon-button"
                aria-label="Close documents"
                onClick={() => setReview(undefined)}
              >
                ×
              </button>
            </div>
            <p>{review.title}</p>
            {review.fit && <JobFitAssessment app={review} profileRevision={profile.revision} />}
            {review.narrative?.unchecked && (
              <p role="status" className="notice">{uncheckedText(review.narrative.unchecked)}</p>
            )}
            {review.narrative?.warnings?.map((warning, i) => (
              <p role="status" className="notice" key={i}>
                {warning}
              </p>
            ))}
            <div className="downloads">
              {review.artifacts.map((a) => {
                const label = a.kind === "resume" ? "Resume" : a.kind === "transcript" ? "Transcript" : "Cover letter";
                return (
                  <span className="document" key={a.id}>
                    <button
                      className="secondary"
                      onClick={() => void action(() => download(a))}
                    >
                      {label} · {a.format.toUpperCase()}
                    </button>
                    {a.format === "pdf" && (
                      <button
                        className="text-button"
                        aria-label={`Save ${label} ${a.format.toUpperCase()}`}
                        onClick={() => void action(() => download(a, true))}
                      >
                        Save
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {uploadFiles(review)}
            {review.narrative?.tailoring && (
              <>
                <h3>Tailored resume</h3>
                <p className="help">
                  Built from your {review.narrative.tailoring.source}.{" "}
                  {review.narrative.tailoring.summaryReplaced
                    ? "Reordered for this posting, with the summary rewritten. No new claim was added."
                    : review.narrative.tailoring.changes.length
                      ? "Reordered for this posting; the summary is your own. No new claim was added."
                      : "Used unchanged."}
                </p>
                <p className="fact-preview">
                  {review.narrative.tailoring.summary}
                  <small>Summary</small>
                </p>
                {review.narrative.tailoring.changes.map((change, i) => (
                  <p className="fact-preview" key={i}>
                    {change}
                  </p>
                ))}
                {review.narrative.tailoring.cautions.map((caution, i) => (
                  <p className="fact-preview" key={i}>
                    {caution}
                    <small>Check before sending</small>
                  </p>
                ))}
              </>
            )}
            <h3>Selected resume facts</h3>
            <p className="help">
              Tailoring selects and orders your confirmed wording. Compare these
              selections with your profile before submitting.
            </p>
            {review.narrative?.resume.map((f, i) => (
              <p className="fact-preview" key={i}>
                {f.text}
                <small>Source: confirmed profile fact</small>
              </p>
            ))}
            <h3>Cover letter</h3>
            {Boolean(review.narrative?.coverLetter.length) && (
              <button
                className="text-button"
                onClick={() =>
                  void action(
                    () =>
                      navigator.clipboard.writeText(
                        review.narrative!.coverLetter.map((p) => p.text.trim()).join("\n\n"),
                      ),
                    "Letter text copied.",
                  )
                }
              >
                Copy letter text
              </button>
            )}
            {review.narrative?.coverLetter.map((p, i) => (
              <p className="letter" key={i}>
                {p.text}
              </p>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
class PanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="shell">
        <main>
          <div className="notice error" role="alert">
            Application Lane hit an unexpected error: {this.state.error.message}
          </div>
          <button className="primary" onClick={() => location.reload()}>
            Reload panel
          </button>
        </main>
      </div>
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <PanelErrorBoundary>
    <App />
  </PanelErrorBoundary>,
);
