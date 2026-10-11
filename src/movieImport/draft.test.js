import assert from "node:assert/strict";
import test from "node:test";
import { saveImportDraft, loadImportDraft, clearImportDraft } from "./draft.js";
const storage = () => { const map = new Map(); return { getItem: (k) => map.get(k), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }; };
const draft = { destination: "native", records: [{ title: "Alien", nativeSelectedTmdbId: 348 }], text: "Alien", nativeOwnerId: null, traktOwnerId: null };
test("preserves review selections through login without storing tokens", () => {
  const s = storage(); assert.equal(saveImportDraft(draft, s), true);
  assert.equal(loadImportDraft({ nativeUserId: "a" }, s).records[0].nativeSelectedTmdbId, 348);
  clearImportDraft(s); assert.equal(loadImportDraft({}, s), null);
});
test("never restores an account-bound draft for a different account or after logout", () => {
  for (const nativeUserId of [null, "b"]) {
    const s = storage(); saveImportDraft({ ...draft, nativeOwnerId: "a" }, s);
    assert.equal(loadImportDraft({ nativeUserId }, s), null);
    assert.equal(loadImportDraft({ nativeUserId: "a" }, s), null);
  }
});
test("Trakt draft ownership survives refresh but excludes a new connection", () => {
  const s = storage(); saveImportDraft({ ...draft, destination: "trakt", traktOwnerId: "connection-a" }, s);
  assert.ok(loadImportDraft({ traktAccountKey: "connection-a" }, s));
  assert.equal(loadImportDraft({ traktAccountKey: "connection-b" }, s), null);
});
test("expires old drafts and tolerates blocked storage", () => {
  const s = storage(); saveImportDraft(draft, s);
  const original = Date.now; Date.now = () => original() + 31 * 60 * 1000;
  try { assert.equal(loadImportDraft({}, s), null); } finally { Date.now = original; }
  assert.equal(saveImportDraft(draft, { setItem() { throw new Error("blocked"); } }), false);
});
