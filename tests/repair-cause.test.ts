import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repairCommands, type RepairContext } from "../scripts/lane-repairs";
import { LIVE_REVIEW_MS, claim, defectId, heartbeat, liveReview, openRepair, queueReport, type Repair } from "../src/shared/repairs";
import { laneGroup } from "../src/shared/lane-groups";
import type { QueueSnapshot, QueueSummaryItem } from "../src/shared/model";

const app = (id: string, company: string) => ({ id, company, title: "Engineer", url: `https://${company}.example/apply`, stage: "applying", status: "awaiting-user" }) as QueueSummaryItem;
const apps = [app("aaaaaa00-0000-4000-8000-000000000001", "acme"), app("bbbbbb00-0000-4000-8000-000000000002", "globex"), app("cccccc00-0000-4000-8000-000000000003", "initech")];
const repair = (applicationId: string): Repair => ({
  applicationId,
  state: "released",
  defects: [{ id: defectId("empty-answerable", "City", "x"), kind: "empty-answerable", field: "City", detail: "x", status: "resolved" }],
  evidence: [{ kind: "report", id: `${applicationId.slice(0, 8)}-report`, at: 1 }],
  userActions: [],
  attempts: [],
  regression: "pending",
  createdAt: 1,
  updatedAt: 1,
});

async function harness(words: string[], store: Record<string, Repair>, dataDirectory: string, live?: Partial<RepairContext>) {
  const printed: string[] = [];
  const ctx: RepairContext = {
    words,
    json: false,
    dataDirectory,
    api: async <T,>(path: string, method = "GET", body?: unknown) => {
      if (method === "PUT") store[(body as Repair).applicationId] = body as Repair;
      return (method === "PUT" ? body : store) as T;
    },
    snapshot: async () => ({ applications: apps }) as unknown as QueueSnapshot,
    find: (queue, wanted) => queue.applications.find((candidate) => candidate.company === wanted)!,
    send: async () => ({ ok: true }),
    name: (item) => item.company || "",
    short: (item) => item.id.slice(0, 6),
    distBuild: async () => undefined,
    now: () => 5000,
    print: (line) => printed.push(line),
    ...live,
  };
  return { commands: repairCommands(ctx), printed };
}

test("lane cause keeps why it broke, and published waits for it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lane-cause-"));
  const store: Record<string, Repair> = { [apps[0].id]: repair(apps[0].id), [apps[1].id]: repair(apps[1].id) };

  await (await harness(["acme", "The City list loads its options only once opened."], store, dir)).commands.cause();
  assert.equal(store[apps[0].id].cause, "The City list loads its options only once opened.");

  const { commands, printed } = await harness(["--all"], store, dir);
  await commands.list();
  assert.ok(printed.some((line) => line.includes("cause: The City list loads")), printed.join("\n"));

  // The explained one is published; the other waits, by name.
  const publish = await harness(["abc1234"], store, dir);
  await assert.rejects(publish.commands.publish(), /no cause on the record: \[bbbbbb\] globex/);
  assert.equal(store[apps[0].id].regression, "published");
  assert.equal(store[apps[1].id].regression, "pending");
  // The report's record says why too (the Issues page shows it).
  const record = JSON.parse(await readFile(join(dir, "fixer", `${apps[0].id.slice(0, 8)}-report.json`), "utf8"));
  assert.equal(record.cause, "The City list loads its options only once opened.");

  await assert.rejects((await harness(["globex", "  "], store, dir)).commands.cause(), /Say why/);
});

test("repair refill waits for the exact build and uses its attempt's capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lane-refill-"));
  await mkdir(join(dir, "captures"));
  const id = apps[0].id;
  const record = repair(id);
  record.defects[0].status = "open";
  const store = { [id]: record };
  const build = { commit: "abc1234", builtAt: 1234 };
  let loaded = false;
  let started = false;
  let readyReads = 0;
  let captures = 0;
  const actions: string[] = [];
  const { commands, printed } = await harness(["acme", "--reason", "repair", "--reload"], store, dir, {
    json: true,
    distBuild: async () => build,
    now: () => 50_000,
    sleep: async () => {},
    send: async (action, applicationId, data) => {
      actions.push(action);
      assert.equal(applicationId, id);
      if (action === "reload") { loaded = true; return { ok: true }; }
      if (action === "about") {
        if (loaded && readyReads++ === 0) return { ok: false, error: "The extension is not connected." };
        return { ok: true, detail: JSON.stringify({ build: loaded ? build : { ...build, builtAt: 1000 }, contentVersion: "loaded",
          tab: { open: true }, page: { contentVersion: "loaded" }, busy: false,
          ...(started ? { attempt: { id: "attempt", status: "filled", completedAt: 2000 } } : {}) }) };
      }
      if (action === "repair-fill") {
        assert.deepEqual(JSON.parse(data!), { build: "abc1234@1234" });
        started = true;
        return { ok: true, detail: JSON.stringify({ attemptId: "attempt", tabId: 2 }) };
      }
      assert.equal(action, "capture");
      const capture = ++captures === 1 ? "early" : "exact";
      await writeFile(join(dir, "captures", `${capture}.json`), JSON.stringify({ id: capture, applicationId: id, form: true,
        createdAt: capture === "early" ? 16_999 : 20_000, tab: { tabId: 2 }, application: { attempts: [{ id: "attempt", completedAt: 2000 }] } }));
      return { ok: true, detail: capture };
    },
  });
  await commands.refill();
  assert.equal(JSON.parse(printed[0]).captureId, "exact");
  assert.equal(store[id].verification?.capture, "exact");
  assert.equal(actions.filter((action) => action === "repair-fill").length, 1);
  assert.equal(captures, 2, "an early capture is repeated without restarting the fill");
});

test("new live reviews take precedence over active code checks and manual verification hands back the form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lane-live-review-"));
  await mkdir(join(dir, "issues"));
  await mkdir(join(dir, "captures"));
  let now = 10_000;
  const [first, second, third] = apps;
  const reportId = "new-report";
  const store = Object.fromEntries([first, second].map(({ id }) => {
    const active = claim(openRepair(undefined, { applicationId: id, defects: [{ ...repair(id).defects[0], status: "open" }], userActions: [] }, now), "fixer", now, "Running regression tests");
    return [id, { ...active, live: { queuedAt: now, inspectedAt: now + LIVE_REVIEW_MS - 10 } }];
  }));
  store[third.id] = queueReport(undefined, third.id, reportId, now + 100);
  assert.equal(store[third.id].state, "needs-fixing");
  const deadline = liveReview(store[third.id], now)!.dueAt;
  now = deadline - 1;
  const noteUpdated = heartbeat(claim(store[third.id], "fixer", now - 10), now, "Still triaging");
  assert.equal(liveReview(noteUpdated, deadline)?.overdue, true);
  assert.equal(liveReview(noteUpdated, deadline)?.dueAt, deadline);
  const live = {
    now: () => now,
    json: true,
    send: async (action: string, id?: string) => {
      assert.equal(id, third.id);
      if (action === "inspect") return { ok: true, detail: JSON.stringify({ form: true, url: third.url, fields: [], blockers: [], inaccessible: [] }) };
      if (action === "about") return { ok: true, detail: JSON.stringify({ busy: false }) };
      assert.equal(action, "capture");
      return { ok: true, detail: "clean" };
    },
  };
  const next = await harness([], store, dir, live);
  await next.commands.next();
  assert.deepEqual(JSON.parse(next.printed[0]).pendingReports, [reportId]);
  assert.equal(store[third.id].state, "being-fixed");
  assert.equal(store[third.id].live?.inspectedAt, now);
  await writeFile(join(dir, "issues", `${reportId}.json`), JSON.stringify({ id: reportId, applicationId: third.id }));
  await (await harness(["initech", "--report", reportId, "--defect", "City needs correction"], store, dir, live)).commands.open();
  assert.equal(store[third.id].defects.length, 1);
  assert.equal(store[third.id].evidence.length, 1);
  await writeFile(join(dir, "captures", "clean.json"), JSON.stringify({ id: "clean", applicationId: third.id, form: true, createdAt: ++now }));
  const handoff = await harness(["initech", "--cleanup", "--confirm", "1", "--release"], store, dir, live);
  await handoff.commands.check();
  assert.equal(JSON.parse(handoff.printed[0]).released, true);
  assert.equal(laneGroup(third, undefined), "needs you");
  assert.equal(store[third.id].state, "released");
  assert.equal(store[third.id].defects[0].status, "open");
  const list = await harness([], store, dir);
  await list.commands.list();
  assert.ok(list.printed.some((line) => line.includes("City needs correction") && line.includes("automation proof pending")));
});
