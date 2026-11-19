import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repairCommands, type RepairContext } from "../scripts/lane-repairs";
import { defectId, type Repair } from "../src/shared/repairs";
import type { QueueSnapshot, QueueSummaryItem } from "../src/shared/model";

const app = (id: string, company: string) => ({ id, company, title: "Engineer", url: `https://${company}.example/apply` }) as QueueSummaryItem;
const apps = [app("aaaaaa00-0000-4000-8000-000000000001", "acme"), app("bbbbbb00-0000-4000-8000-000000000002", "globex")];
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

async function harness(words: string[], store: Record<string, Repair>, dataDirectory: string) {
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
