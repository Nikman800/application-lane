// Part of the content script: Oracle Recruiting's candidate pages keep each
// list they load in sessionStorage, keyed by its REST path. On a reload, a
// list question with a saved answer (security clearance, veteran status: the
// "ExtraInformationDictionary" lists) asks the server for that one answer
// (`limit=1&q=LookupCode='…'`), and the server answers 400: the question
// stays a loading skeleton for good and the page cannot be submitted. The
// whole list (`limit=500`) loads fine and is cached, so each of its codes is
// put in the cache under the key the one-answer lookup reads; the page then
// finds the answer without asking the server.
const FULL = /ExtraInformationDictionary\?.*&limit=500(#ceCacheLang=.*)$/;

export function seedLookupCache(storage?: Storage): number {
  let seeded = 0;
  try {
    storage ??= globalThis.sessionStorage;
    if (!storage) return 0;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !FULL.test(key)) continue;
      let full: { items?: Array<{ listOfValues?: Array<{ lookupCode?: string }> }> };
      try {
        full = JSON.parse(storage.getItem(key) || "");
      } catch {
        continue;
      }
      const item = full?.items?.[0];
      for (const value of item?.listOfValues || []) {
        if (typeof value?.lookupCode !== "string") continue;
        const one = key.replace(/&limit=500(?=#)/, `&limit=1&q=LookupCode%3D%27${encodeURIComponent(value.lookupCode)}%27`);
        if (storage.getItem(one) !== null) continue;
        storage.setItem(one, JSON.stringify({ ...full, items: [{ ...item, listOfValues: [value] }], count: 1 }));
        seeded++;
      }
    }
  } catch {
    // Storage blocked or full: the page loads as it would without this.
  }
  return seeded;
}
