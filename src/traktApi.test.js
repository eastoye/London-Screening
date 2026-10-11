import assert from "node:assert/strict";
import test from "node:test";
import { syncTraktImport } from "./traktApi.js";
const token = { access_token: "trakt-a", refresh_token: "refresh-a", created_at: Math.floor(Date.now() / 1000), expires_in: 86400 };
function mockFetch(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const call = { url, body, token: options.headers.Authorization }; calls.push(call);
    return respond ? respond(call) : new Response(JSON.stringify({ added: { movies: body.movies.length }, existing: { movies: 0 }, not_found: { movies: [] } }));
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
test("Trakt preserves watchlist, rating and watched-history operations", async (t) => {
  const calls = mockFetch(t), progress = [];
  const result = await syncTraktImport(token, [
    { selectedTmdbId: 348, watchlist: true, rating: null },
    { selectedTmdbId: 949, watchlist: false, rating: 9 },
  ], {}, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ["/sync/watchlist", "/sync/history", "/sync/ratings"]);
  assert.deepEqual(calls[0].body.movies, [{ ids: { tmdb: 348 } }]);
  assert.deepEqual(calls[1].body.movies, [{ ids: { tmdb: 949 } }]);
  assert.deepEqual(calls[2].body.movies, [{ rating: 9, ids: { tmdb: 949 } }]);
  assert.equal(result.watchlist.added, 1); assert.equal(result.ratings.added, 1); assert.equal(result.history.added, 1);
  assert.deepEqual(progress.map((p) => p.completed), [0, 1, 2, 3]);
  assert.ok(calls.every((c) => c.token === "Bearer trakt-a"));
});
test("already saved watchlist entries and unchanged ratings are preserved", async (t) => {
  const calls = mockFetch(t);
  const result = await syncTraktImport(token, [{ selectedTmdbId: 348, watchlist: true, rating: 9 }], {
    watchlistTmdbIds: [348], ratings: [{ tmdbId: 348, rating: 9 }],
  });
  assert.equal(calls.length, 1); assert.match(calls[0].url, /history/);
  assert.equal(result.watchlist.existing, 1); assert.equal(result.ratings.existing, 1);
});
test("Trakt individual failures are reported while the next batch proceeds", async (t) => {
  const calls = mockFetch(t, (call) => new Response(JSON.stringify({ added: { movies: call.body.movies.length - 1 }, not_found: { movies: [{ ids: { tmdb: call.body.movies[0].ids.tmdb } }] } })));
  const result = await syncTraktImport(token, Array.from({ length: 201 }, (_, i) => ({ selectedTmdbId: i + 1, watchlist: true })));
  assert.equal(calls.length, 2); assert.equal(result.watchlist.failed, 2);
  assert.deepEqual(result.watchlist.failedTmdbIds, [1, 201]);
});
test("account changes stop further Trakt batches and destination operations", async (t) => {
  let active = true;
  const calls = mockFetch(t, () => { active = false; return new Response(JSON.stringify({ added: { movies: 1 } })); });
  await assert.rejects(syncTraktImport(token, [{ selectedTmdbId: 348, watchlist: true, rating: 9 }], {}, {
    assertActive() { if (!active) throw new Error("Account changed"); },
  }), /Account changed/);
  assert.equal(calls.length, 1);
});
test("a failed Trakt batch retains its failure details and does not suppress another lane", async (t) => {
  const calls = mockFetch(t, (call) => new URL(call.url).pathname.endsWith("watchlist")
    ? new Response(JSON.stringify({ error: "busy" }), { status: 429 })
    : new Response(JSON.stringify({ added: { movies: call.body.movies.length }, not_found: { movies: [] } })));
  const result = await syncTraktImport(token, [{ selectedTmdbId: 348, watchlist: true, rating: 9 }]);
  assert.equal(calls.length, 3); assert.equal(result.watchlist.failed, 1); assert.equal(result.ratings.added, 1);
  assert.match(result.watchlist.errors[0], /429/);
});
