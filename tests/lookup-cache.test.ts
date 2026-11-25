import { test } from "node:test";
import assert from "node:assert/strict";
import { seedLookupCache } from "../src/extension/content/lookup-cache";

class MemoryStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const base = "/recruitingCEExtraInformationDictionary?expand=all&finder=findByResourceName;ResourceName=oracle.apps.flex.hcm.recruiting.hiring.submissions.core.submissionExtraInfoEFF.contexts.view.SubmissionExtraInfoContextCANDIDATE_5FCLEARANCEVSO&onlyData=true";

test("an Oracle list's saved answer is found in the page's cache after a reload, not asked of the server that refuses it", () => {
  const storage = new MemoryStorage();
  const full = { items: [{ dictionaryId: 2, resourceName: "x", listOfValues: [
    { listId: 4, dictionaryId: 2, lookupCode: "None", meaning: "None" },
    { listId: 5, dictionaryId: 2, lookupCode: "Top Secret", meaning: "Top Secret" },
  ] }], count: 1 };
  storage.setItem(`${base}&limit=500#ceCacheLang=en`, JSON.stringify(full));
  storage.setItem("/recruitingCEDictionaries/1/lov/countries?limit=500#ceCacheLang=en", "{}");
  assert.equal(seedLookupCache(storage as unknown as Storage), 2);
  const one = JSON.parse(storage.getItem(`${base}&limit=1&q=LookupCode%3D%27None%27#ceCacheLang=en`)!);
  assert.deepEqual(one.items[0].listOfValues, [{ listId: 4, dictionaryId: 2, lookupCode: "None", meaning: "None" }]);
  assert.ok(storage.getItem(`${base}&limit=1&q=LookupCode%3D%27Top%20Secret%27#ceCacheLang=en`));
  // An entry the page cached itself is left as it is.
  assert.equal(seedLookupCache(storage as unknown as Storage), 0);
});
