import assert from "node:assert/strict";
import test from "node:test";
import { importNativeMovies } from "./nativeImport.js";
const records = (count) => Array.from({ length: count }, (_, i) => ({ selectedTmdbId: i + 1, title: `Film ${i + 1}`, rating: 9, watchlist: true }));
const options = (importBatch) => ({ importBatch, userId: "account-a", isCurrentAccount: () => true });
test("batches films, reports progress and only passes exact IDs to the native endpoint", async () => {
  const calls = [], progress = [];
  const result = await importNativeMovies(records(43), { ...options(async (userId, ids) => {
    calls.push({ userId, ids }); return { results: ids.map((tmdbId) => ({ tmdbId, status: "added" })) };
  }), onProgress: (value) => progress.push(value) });
  assert.deepEqual(calls.map((c) => c.ids.length), [20, 20, 3]);
  assert.ok(calls.every((c) => c.userId === "account-a"));
  assert.deepEqual(progress.map((p) => p.completed), [0, 20, 40, 43]);
  assert.equal(result.watchlist.added, 43);
  assert.equal(result.ratings, undefined); assert.equal(result.history, undefined);
});
test("reports existing and individual failures, including absent server outcomes", async () => {
  const result = await importNativeMovies(records(3), options(async () => ({ results: [{ tmdbId: 1, status: "already_saved" }, { tmdbId: 2, status: "failed", error: "Not found" }] })));
  assert.equal(result.watchlist.existing, 1); assert.equal(result.watchlist.failed, 2);
  assert.equal(result.watchlist.failures[0].error, "Not found");
});
test("lost batch responses keep successes and permit safe subsequent retry", async () => {
  let calls = 0;
  const result = await importNativeMovies(records(21), options(async (_, ids) => {
    if (++calls === 1) throw new Error("Connection lost");
    return { results: ids.map((tmdbId) => ({ tmdbId, status: "added" })) };
  }));
  assert.equal(result.watchlist.failed, 20); assert.equal(result.watchlist.added, 1);
});
test("logout or switching accounts stops the next batch and suppresses the old result", async () => {
  let active = true, calls = 0;
  await assert.rejects(importNativeMovies(records(40), { ...options(async () => { calls++; active = false; return { results: [] }; }), isCurrentAccount: () => active }), /account changed/i);
  assert.equal(calls, 1);
});
test("expired login stops further requests and reports unattempted films", async () => {
  let calls = 0;
  const result = await importNativeMovies(records(43), options(async () => { calls++; throw Object.assign(new Error("Login expired"), { code: "authentication_required" }); }));
  assert.equal(calls, 1); assert.equal(result.interrupted, true); assert.equal(result.watchlist.failed, 43);
  assert.match(result.watchlist.failures[42].error, /not attempted/i);
});
test("deduplicates IDs and rejects invalid IDs before any request", async () => {
  let called = 0;
  const opts = options(async (_, ids) => { called++; assert.equal(ids.length, 1); return { results: [] }; });
  await importNativeMovies([records(1)[0], records(1)[0]], opts);
  await assert.rejects(importNativeMovies([{ selectedTmdbId: "title" }], opts), /TMDB/);
  assert.equal(called, 1);
});
