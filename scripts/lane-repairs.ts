// The fixer's repair records from the command line (src/shared/repairs.ts
// says what they hold and why):
//
//   lane repair <app> [--report <id>] [--capture <id>] [--defect "<what>"]…
//                         what a report or capture shows: its defects open a
//                         repair (needs fixing); what only the applicant can
//                         do is listed for them, never as a defect
//   lane fixing <app> [next action]
//                         the fixer owns it now (being fixed); again to say
//                         it is still at work. Alone: every open repair
//   lane retry <app> --reason repair|profile|page
//                         refill it, only with a reason to expect progress,
//                         on the newest build and recognized application form
//   lane refill <app> --reason repair|profile|page [--reload] [--persist]
//                         refill once, then verify that attempt's capture
//   lane check <app> [--confirm <n>]…
//                         a capture of the page once settled: resolved,
//                         still open and newly found defects. Every one gone
//                         releases it (verified live); --confirm marks a
//                         defect described in words as seen fixed there
//   lane fixed <app>      the same check; it never releases an open defect
//   lane release <app> "<why>" [--blocked]
//                         hand back the corrected page, or identify the
//                         access step that requires the applicant
//   lane cause <app> "<why>"
//                         why it broke, once found: kept on the record (the
//                         note is overwritten as work goes on), shown with it,
//                         and required before the repair is published
//   lane repairs [--json] every record not yet published
//   lane published <commit>
//                         the batch is pushed: its repairs' regressions are
//                         published, and .local/fixer/<report>.json written

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findDefects, persistedFieldChanges, summarizeEvidence, type Evidence } from "./repair-evidence";
import {
  SETTLE_MS,
  claim,
  defectId,
  explain,
  heartbeat,
  buildKey,
  mayRetry,
  openRepair,
  outcome,
  published,
  recordCleanup,
  release,
  section,
  verifyLive,
  type Attempt,
  type Defect,
  type Repair,
} from "../src/shared/repairs";
import type { BuildStamp } from "../src/shared/build";
import type { FillAttempt, QueueSnapshot, QueueSummaryItem } from "../src/shared/model";

export type RepairContext = {
  words: string[];
  json: boolean;
  dataDirectory: string;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  snapshot: () => Promise<QueueSnapshot>;
  find: (queue: QueueSnapshot, wanted: string) => QueueSummaryItem;
  send: (action: string, applicationId?: string, data?: string) => Promise<{ ok: boolean; detail?: string; error?: string }>;
  name: (app: QueueSummaryItem) => string;
  short: (app: QueueSummaryItem) => string;
  distBuild: () => Promise<BuildStamp | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
};

type About = {
  build?: BuildStamp;
  contentVersion: string;
  tab: { open: boolean; url?: string; loading?: boolean; discarded?: boolean };
  page?: { contentVersion?: string; documentId?: string };
  status: string;
  busy: boolean;
  attempt?: FillAttempt;
};

const flagValues = (words: string[], flag: string) => words.flatMap((word, index) => (words[index - 1] === flag ? [word] : []));
const positional = (words: string[]) => words.filter((word, index) => !word.startsWith("--") && !words[index - 1]?.startsWith("--"));
const describe = (defect: Defect) => `${defect.field ? `${defect.field}: ` : ""}${defect.detail}`;
const refillId = (attempt?: { id?: string; repairRootId?: string }) => attempt?.repairRootId || attempt?.id;

export function repairCommands(ctx: RepairContext) {
  const print = ctx.print || ((line: string) => console.log(line));
  const now = ctx.now || Date.now;
  const sleep = ctx.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const all = () => ctx.api<Record<string, Repair>>("/v1/repairs");
  const save = (repair: Repair, expectedUpdatedAt?: number) =>
    ctx.api<Repair>(`/v1/repairs/${encodeURIComponent(repair.applicationId)}`, "PUT", { ...repair, expectedUpdatedAt });
  const target = async () => {
    const [wanted] = positional(ctx.words);
    if (!wanted) throw new Error("Name the application: its short id, or part of its company or title.");
    return ctx.find(await ctx.snapshot(), wanted);
  };
  const about = async (app: QueueSummaryItem): Promise<About> => {
    const reply = await ctx.send("about", app.id);
    if (!reply.ok) throw new Error(reply.error || "The extension did not answer.");
    return JSON.parse(reply.detail || "{}") as About;
  };
  const send = async (action: string, app?: QueueSummaryItem, data?: string) => {
    const reply = await ctx.send(action, app?.id, data);
    if (!reply.ok) throw new Error(reply.error || `${action} failed.`);
    return reply.detail;
  };
  const waitForPage = async (app: QueueSummaryItem, matches: (state: About) => boolean, why: string) => {
    let lastError = "";
    const deadline = now() + 30_000;
    for (let tried = 0; tried < 25 && now() < deadline; tried++) {
      let state: About | undefined;
      try { state = await about(app); } catch (error) { lastError = (error as Error).message; }
      if (state && matches(state)) return state;
      await sleep(1000);
    }
    throw new Error(lastError ? `${why} ${lastError}` : why);
  };
  const readEvidence = async (kind: "issues" | "captures", id: string): Promise<Evidence> => {
    if (!/^[\w-]+$/.test(id)) throw new Error("Give a report or capture ID.");
    const file = join(ctx.dataDirectory, kind, `${id}.json`);
    if (!existsSync(file)) throw new Error(`No ${kind === "issues" ? "report" : "capture"} ${id} in ${join(ctx.dataDirectory, kind)}.`);
    return JSON.parse(await readFile(file, "utf8")) as Evidence;
  };
  const list = (repair: Repair) => {
    repair.defects.forEach((defect, index) =>
      print(`  ${String(index + 1).padStart(2)}. ${defect.status === "open" ? "open    " : "resolved"} ${defect.kind.padEnd(16)} ${describe(defect).slice(0, 140)}${defect.cleanedIn && defect.status === "open" ? "  (page corrected, automation proof pending)" : defect.manual && defect.status === "open" ? "  (confirm with --confirm)" : ""}`),
    );
    for (const action of repair.userActions) print(`   - for the applicant: ${action}`);
    if (repair.blocker) print(`   blocked: ${repair.blocker}`);
  };
  const pick = (repair: Repair, wanted: string[]) =>
    wanted.map((value) => {
      const byNumber = /^\d+$/.test(value) ? repair.defects[Number(value) - 1] : undefined;
      const defect = byNumber || repair.defects.find((other) => other.id === value);
      if (!defect) throw new Error(`No defect ${value} on this repair (lane repairs lists them).`);
      return defect.id;
    });

  // lane repair <app> --report <id> | --capture <id> | --defect "…"
  async function open() {
    const app = await target();
    const repairs = await all();
    const reports = flagValues(ctx.words, "--report");
    const captures = flagValues(ctx.words, "--capture");
    const described = flagValues(ctx.words, "--defect");
    if (!reports.length && !captures.length && !described.length) throw new Error("Give what shows the problem: --report <id>, --capture <id>, or --defect \"<what is wrong>\".");
    let repair = repairs[app.id];
    const sources = [...reports.map((id) => ["issues", id] as const), ...captures.map((id) => ["captures", id] as const)];
    for (const [kind, id] of sources) {
      const evidence = await readEvidence(kind, id);
      if (evidence.applicationId && evidence.applicationId !== app.id) throw new Error(`${id} is from another application.`);
      repair = openRepair(repair, { applicationId: app.id, step: evidence.tab?.url, evidence: { kind: kind === "issues" ? "report" : "capture", id }, ...findDefects(evidence) }, now());
    }
    if (described.length) {
      const defects: Defect[] = described.map((text) => ({ id: defectId("other", undefined, text), kind: "other", detail: text.slice(0, 600), status: "open", manual: true }));
      repair = openRepair(repair, { applicationId: app.id, defects, userActions: [] }, now());
    }
    if (!repair!.defects.length) {
      print(`${ctx.name(app)}: nothing the software can fix.`);
      for (const action of repair!.userActions) print(`  - for the applicant: ${action}`);
      return;
    }
    await save(repair!, repairs[app.id]?.updatedAt);
    print(`${ctx.name(app)}: ${section(repair) || "released"}.`);
    list(repair!);
  }

  // lane fixing <app> [next action]: the fixer owns it.
  async function own() {
    if (!positional(ctx.words).length) return show(false);
    const app = await target();
    const repairs = await all();
    const owner = flagValues(ctx.words, "--owner")[0] || "fixer";
    const next = positional(ctx.words).slice(1).join(" ");
    let repair = repairs[app.id];
    if (!repair?.defects.some((defect) => defect.status === "open")) {
      // Marked the moment a report arrives, before it is read: what the
      // applicant said is the defect until the report is classified.
      if (!next) throw new Error("Nothing open on it. Say what is wrong (lane fixing <app> \"<what>\"), or open it from the report: lane repair <app> --report <id>.");
      repair = openRepair(repair, { applicationId: app.id, defects: [{ id: defectId("other", undefined, next), kind: "other", detail: next, status: "open", manual: true }], userActions: [] }, now());
    }
    repair = repair.owner?.name === owner && repair.state === "being-fixed" ? heartbeat(repair, now(), next || undefined) : claim(repair, owner, now(), next || undefined);
    await save(repair, repairs[app.id]?.updatedAt);
    print(`${ctx.name(app)}: being fixed by ${owner}${repair.nextAction ? `; next: ${repair.nextAction}` : ""}.`);
  }

  // lane retry <app> --reason repair|profile|page
  async function startRefill(reload: boolean) {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair. Open one from what shows the problem: lane repair <app> --report <id>.`);
    const reason = flagValues(ctx.words, "--reason")[0] as Attempt["reason"] | undefined;
    if (reason && !["repair", "profile", "page"].includes(reason)) throw new Error("--reason is repair, profile or page.");
    // Without a reason the refill is refused before the extension is asked
    // for its build: the refusal must not depend on Chrome being open.
    if (!reason) throw new Error("Not refilled. Say why a refill should go differently now with --reason repair|profile|page.");
    const newest = await ctx.distBuild();
    let state = await about(app);
    if (newest && buildKey(newest) !== buildKey(state.build)) {
      if (!reload) throw new Error("The extension is on a different build from dist/extension. Run lane refill with --reload.");
      const deadline = now() + 120_000;
      for (let tried = 0; ; tried++) {
        const reply = await ctx.send("reload", app.id);
        if (reply.ok) break;
        if (!/^Not reloaded:/.test(reply.error || "") || now() >= deadline || tried >= 30)
          throw new Error(reply.error || "The extension could not reload.");
        await sleep(4000);
      }
      state = await waitForPage(app, (next) => buildKey(next.build) === buildKey(newest), "The expected extension build did not reconnect.");
    }
    const allowed = mayRetry(repair, reason, buildKey(state.build));
    if (!allowed.ok) throw new Error(`Not refilled. ${allowed.why}`);
    if (!state.tab.open) throw new Error("Its tab is closed: lane switch opens it again (a sign-in may be needed first).");
    if (state.tab.loading || state.tab.discarded) throw new Error("Its page is still loading or was put to sleep by Chrome: switch to it, then try again.");
    if (state.busy) throw new Error("It is being filled now. Try again when it finishes.");
    if (state.page?.contentVersion !== state.contentVersion) {
      if (!reload) throw new Error(`The page needs the current content script: lane refresh ${ctx.short(app)} first.`);
      await send("refresh", app);
      state = await waitForPage(app, (next) => next.page?.contentVersion === next.contentVersion, "The application page did not load the expected content script.");
    }
    const reply = await send("repair-fill", app, JSON.stringify({ build: buildKey(state.build), ...(reason === "page" ? {} : { step: repair.step }) }));
    const started = JSON.parse(reply || "{}") as { attemptId?: string; tabId?: number };
    if (!started.attemptId || started.tabId === undefined) throw new Error("The extension did not return a refill attempt ID.");
    const current = (await all())[app.id];
    if (!current) throw new Error(`Refill ${started.attemptId} started, but its repair record was removed.`);
    const refill = { at: now(), reason, build: buildKey(state.build), attemptId: started.attemptId, tabId: started.tabId };
    const updated = await save({ ...heartbeat(current, now()), refill }, current.updatedAt);
    return { app, repair: { ...updated, refill } };
  }

  async function retry() {
    const { app, repair } = await startRefill(false);
    if (ctx.json) print(JSON.stringify(repair.refill));
    else print(`${ctx.name(app)}: refilling (${repair.refill.attemptId}). Then: lane check ${ctx.short(app)}.`);
  }

  async function refill() {
    const { app, repair } = await startRefill(ctx.words.includes("--reload"));
    return checkPage(app, repair);
  }

  async function inspect() {
    const app = await target();
    const result = JSON.parse(await send("inspect", app) || "{}") as { form: boolean; url: string; fields: { label: string; value: string }[]; blockers: string[]; inaccessible: string[] };
    if (ctx.json) print(JSON.stringify(result, null, 2));
    else {
      print(`${ctx.name(app)} — ${result.form ? "Application form" : "No recognized application form"} (${result.url})`);
      for (const blocker of result.blockers) print(`  ${blocker}`);
      for (const error of result.inaccessible) print(`  Unreadable: ${error}`);
      for (const field of result.fields) print(`  ${field.label}: ${field.value || "(empty)"}`);
    }
  }

  async function evidence() {
    const app = await target();
    const [id] = flagValues(ctx.words, "--capture");
    const [beforeId] = flagValues(ctx.words, "--before");
    const [field] = flagValues(ctx.words, "--field");
    if (!id) throw new Error("Give the capture ID with --capture.");
    const capture = await readEvidence("captures", id);
    const before = beforeId ? await readEvidence("captures", beforeId) : undefined;
    if (capture.applicationId !== app.id || (before && before.applicationId !== app.id)) throw new Error("A capture belongs to another application.");
    const optional = async (path: string) => {
      const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      return raw === undefined ? undefined : JSON.parse(raw);
    };
    const [recording, har] = await Promise.all([
      capture.recordingId && /^[\w-]+$/.test(capture.recordingId) ? optional(join(ctx.dataDirectory, "recordings", `${capture.recordingId}.json`)) : undefined,
      optional(join(ctx.dataDirectory, "captures", `${capture.id}.har.json`)),
    ]);
    print(JSON.stringify(summarizeEvidence(capture, recording?.events || [], har?.log?.entries || [], field, before), null, 2));
  }

  async function capture() {
    const app = await target();
    const page = await takeCapture(app);
    print(ctx.json ? JSON.stringify({ captureId: page.id, applicationId: page.applicationId }) : page.id);
  }

  // lane check <app> [--confirm <n>]…: the settled page against the record.
  async function check() {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair to check.`);
    return checkPage(app, repair);
  }

  async function checkPage(app: QueueSummaryItem, repair: Repair) {
    const confirmed = pick(repair, flagValues(ctx.words, "--confirm"));
    const proven = pick(repair, flagValues(ctx.words, "--prove"));
    const manual = ctx.words.includes("--cleanup");
    const expected = manual ? undefined : repair.refill?.attemptId;
    if (manual && !confirmed.length) throw new Error("Name the corrections recorded by --cleanup with --confirm.");
    if (proven.length && !expected) throw new Error("A code proof requires a tracked refill starting with the defect present.");
    let baseline: Evidence | undefined;
    if (proven.length) {
      const [baselineId] = flagValues(ctx.words, "--before");
      if (!baselineId) throw new Error("Give the capture taken before the refill with --before.");
      baseline = await readEvidence("captures", baselineId);
      if (baseline.applicationId !== app.id || baseline.tab?.tabId !== repair.refill?.tabId ||
          baseline.createdAt === undefined || baseline.createdAt >= repair.refill!.at ||
          refillId(baseline.application?.attempts?.at(-1)) === expected)
        throw new Error("The baseline capture must be from the same application and tab before this refill started.");
    }
    // The fill finished, and the site had time for its own late changes.
    let state = await about(app);
    const deadline = now() + 10 * 60_000;
    for (let tried = 0; state.busy && now() < deadline && tried < 600; tried++) {
      if (expected && refillId(state.attempt) !== expected) throw new Error("Another fill replaced this repair attempt.");
      await sleep(1000);
      state = await about(app);
    }
    if (state.busy) throw new Error("It is still being filled after ten minutes.");
    if (expected && (refillId(state.attempt) !== expected || !state.attempt?.completedAt || buildKey(state.build) !== repair.refill?.build))
      throw new Error("This page is no longer on the tracked refill and build.");
    if (expected && ["error", "paused"].includes(state.attempt!.status))
      throw new Error(`The repair refill ended as ${state.attempt!.status}. ${state.attempt!.note}`);
    const waited = state.attempt?.completedAt === undefined ? SETTLE_MS : now() - state.attempt.completedAt;
    if (!manual && waited < SETTLE_MS) await sleep(SETTLE_MS - waited);
    let before: Evidence | undefined;
    if (ctx.words.includes("--persist")) {
      const oldDocument = state.page?.documentId;
      if (!oldDocument) throw new Error("Cannot identify the document before checking persistence.");
      before = await takeCapture(app);
      if (before.form === false) throw new Error("The pre-reload capture is outside the application form.");
      if (expected && (refillId(before.application?.attempts?.at(-1)) !== expected || before.tab?.tabId !== repair.refill?.tabId))
        throw new Error("The pre-reload capture belongs to another refill or tab.");
      await send("reload-page", app);
      state = await waitForPage(app, (next) =>
        !next.tab.loading && Boolean(next.page?.documentId && next.page.documentId !== oldDocument && next.page.contentVersion === next.contentVersion),
      "The application page did not reload for the persistence check.");
    }
    const capture = await takeCapture(app);
    if (expected && (refillId(capture.application?.attempts?.at(-1)) !== expected || capture.tab?.tabId !== repair.refill?.tabId))
      throw new Error("The captured page belongs to another refill or tab.");
    if (capture.form === false) throw new Error(`Capture ${capture.id} is outside the tracked application form.`);
    if (before && (buildKey(state.build) !== repair.refill?.build && expected))
      throw new Error("The extension build changed during the persistence check.");
    const settled = settledFor(capture);
    const found = findDefects(capture);
    for (const change of before ? persistedFieldChanges(before, capture) : []) {
      if (!change.before || (!change.required && !repair.defects.some(({ field }) => field === change.label))) continue;
      const id = defectId("lost-value", change.label, "Answer changed after reloading.");
      if (!found.defects.some((defect) => defect.id === id)) found.defects.push({ id, kind: "lost-value", field: change.label, detail: "Answer changed after reloading.", status: "open", seenIn: capture.id });
    }
    if (baseline) {
      const beforeIds = new Set(findDefects(baseline).defects.map(({ id }) => id));
      const changes = persistedFieldChanges(baseline, capture);
      const [describedField] = flagValues(ctx.words, "--field");
      for (const id of proven) {
        const label = repair.defects.find((defect) => defect.id === id)?.field || describedField;
        if (!beforeIds.has(id) && (!label || !changes.some((change) => change.label.toLowerCase().includes(label.toLowerCase()))))
          throw new Error("The before and after captures do not show the claimed correction. For a described defect, name its changed field with --field.");
      }
    }
    if (manual) {
      if (found.defects.some(({ id }) => confirmed.includes(id))) throw new Error("The capture still shows a defect marked for cleanup.");
      await save(recordCleanup(repair, confirmed, capture.id, now()), repair.updatedAt);
      print(ctx.json ? JSON.stringify({ captureId: capture.id, cleaned: confirmed }) : `Live cleanup recorded in capture ${capture.id}. Automation proof remains open.`);
      return;
    }
    const result = verifyLive(repair, { capture: capture.id, build: buildKey(state.build), settledMs: settled, found,
      codeChanged: Boolean(expected && repair.refill?.reason === "repair"), confirmed, proven }, now());
    await save(result.repair, repair.updatedAt);
    if (ctx.json) print(JSON.stringify({ ok: result.ok, captureId: capture.id, attemptId: expected, build: buildKey(state.build),
      ...(result.ok ? {} : { why: result.why }), repair: result.repair }, null, 2));
    else if (result.ok) print(`${ctx.name(app)}: verified live in capture ${capture.id}. Released to the applicant${result.repair.regression === "pending" ? " with regression pending publication" : ""}.`);
    else print(`${ctx.name(app)}: not verified. ${result.why}`);
    if (!ctx.json) list(result.repair);
    if (!result.ok) process.exitCode = 1;
  }
  async function takeCapture(app: QueueSummaryItem) {
    const reply = await ctx.send("capture", app.id);
    if (!reply.ok || !reply.detail) throw new Error(reply.error || "No capture was taken.");
    if (!/^[\w-]+$/.test(reply.detail)) throw new Error("The extension returned an invalid capture ID.");
    const file = join(ctx.dataDirectory, "captures", `${reply.detail}.json`);
    for (let tries = 0; !existsSync(file) && tries < 20; tries++) await sleep(500);
    const capture = JSON.parse(await readFile(file, "utf8")) as Evidence & { createdAt: number };
    if (capture.applicationId !== app.id || capture.id !== reply.detail) throw new Error("The captured page does not match this application.");
    return capture;
  }
  const settledFor = (capture: Evidence & { createdAt: number }) => {
    const finished = capture.application?.attempts?.at(-1)?.completedAt;
    return finished ? capture.createdAt - finished : SETTLE_MS;
  };

  // lane release <app> "<why>"
  async function giveBack() {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair.`);
    const why = positional(ctx.words).slice(1).join(" ");
    if (!why) throw new Error("Say why it goes back with defects open (what the applicant has to do, or what blocks the repair).");
    if (repair.defects.some((defect) => defect.status === "open" && !defect.cleanedIn) && !ctx.words.includes("--blocked"))
      throw new Error("This repair has live defects. Correct them first, or use --blocked for a step only the applicant can take.");
    await save(release(repair, now(), why), repair.updatedAt);
    print(`${ctx.name(app)}: back with the applicant; ${repair.defects.filter((defect) => defect.status === "open").length} defect(s) stay open on the record.`);
  }

  // lane cause <app> "<why>": why it broke, found from the evidence.
  async function cause() {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair. Open one first (lane repair or lane fixing).`);
    const why = positional(ctx.words).slice(1).join(" ");
    await save(explain(repair, why, now()), repair.updatedAt);
    print(`${ctx.name(app)}: cause recorded.`);
  }

  async function show(everything: boolean) {
    const repairs = Object.values(await all()).filter((repair) => everything || repair.state !== "released" || repair.regression === "pending");
    if (ctx.json) return print(JSON.stringify(repairs, null, 2));
    if (!repairs.length) return print("No repairs open or awaiting publication.");
    const queue = await ctx.snapshot().catch(() => undefined);
    const label = (id: string) => {
      const app = queue?.applications.find((candidate) => candidate.id === id);
      return app ? `[${ctx.short(app)}] ${ctx.name(app)}` : `[${id.slice(0, 6)}]`;
    };
    for (const repair of repairs.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const where = section(repair) || "released";
      print(`${label(repair.applicationId)}  ${where}, ${outcome(repair)}${repair.owner ? `, ${repair.owner.name}` : ""}${repair.regression !== "none" ? `, regression ${repair.regression}` : ""}`);
      if (repair.cause) print(`   cause: ${repair.cause}`);
      if (repair.nextAction) print(`   next: ${repair.nextAction}`);
      if (repair.note) print(`   ${repair.note}`);
      list(repair);
    }
  }

  // lane published <commit>: the batch is on main.
  async function publish() {
    const [commit] = positional(ctx.words);
    if (!commit) throw new Error("Give the commit that was pushed.");
    const repairs = await all();
    let count = 0;
    const unexplained: string[] = [];
    for (const repair of Object.values(repairs)) {
      if (repair.regression !== "pending" && repair.regression !== "passed") continue;
      // The rest of the batch is published; these wait for their cause.
      if (!repair.cause) {
        unexplained.push(repair.applicationId);
        continue;
      }
      const done = published(repair, commit, now());
      await save(done, repair.updatedAt);
      count++;
      for (const evidence of done.evidence.filter((item) => item.kind === "report")) await writeRecord(evidence.id, done, commit);
    }
    print(`${count} repair${count === 1 ? "" : "s"} marked published in ${commit}.`);
    if (unexplained.length) {
      const queue = await ctx.snapshot().catch(() => undefined);
      const names = unexplained.map((id) => {
        const app = queue?.applications.find((candidate) => candidate.id === id);
        return app ? `[${ctx.short(app)}] ${ctx.name(app)}` : `[${id.slice(0, 6)}]`;
      });
      throw new Error(`Not marked published, no cause on the record: ${names.join("; ")}. Run lane cause <app> "<why>" for each, then lane published ${commit} again.`);
    }
  }
  // .local/fixer/<report>.json, its status taken from the record: "fixed"
  // only when it was seen working live with nothing open.
  async function writeRecord(reportId: string, repair: Repair, commit: string) {
    const dir = join(ctx.dataDirectory, "fixer");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${reportId}.json`);
    const previous = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as { summary?: string; startedAt?: number };
    const open = repair.defects.filter((defect) => defect.status === "open");
    const status = outcome(repair);
    const summary = `${status === "fixed" ? "Confirmed live" : status === "needs-live-check" ? "Not yet confirmed live" : status === "partial" ? "Partly confirmed live" : "Not confirmed live"}: ${repair.defects.filter((defect) => defect.status === "resolved").map(describe).join("; ") || "nothing resolved yet"}.`;
    await writeFile(file, JSON.stringify({ status, summary: previous.summary && status === "fixed" ? previous.summary : summary, ...(repair.cause ? { cause: repair.cause } : {}), problems: open.map((defect) => `${describe(defect)}${defect.cleanedIn ? " (live page corrected; automation proof pending)" : ""}`), commit, startedAt: previous.startedAt || repair.createdAt, finishedAt: now() }, null, 2));
  }

  return { open, own, retry, refill, inspect, capture, evidence, check, fixed: check, release: giveBack, cause, list: () => show(ctx.words.includes("--all")), publish };
}
