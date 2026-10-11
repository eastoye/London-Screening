import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
const source = await readFile(new URL("../supabase/functions/_shared/nativeWatchlistBatch.ts", import.meta.url), "utf8");
const compiled = await transformWithEsbuild(source, "nativeWatchlistBatch.ts", { loader: "ts" });
const { validateImportIds, importWatchlistBatch } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
const movie = (tmdbId) => ({ tmdbId, title: `Verified ${tmdbId}`, releaseYear: 1979, posterPath: "/verified.jpg" });
function database() {
  const rows = new Map();
  return {
    rows,
    deps: {
      existing: async (userId, ids) => ids.filter((id) => rows.has(`${userId}:${id}`)),
      movie: async (id) => movie(id),
      insert: async (incoming) => {
        const inserted = [];
        for (const row of incoming) if (!rows.has(`${row.user_id}:${row.tmdb_id}`)) {
          rows.set(`${row.user_id}:${row.tmdb_id}`, row); inserted.push(row.tmdb_id);
        }
        return inserted;
      },
    },
  };
}
test("enforces batch boundaries and strict numeric IDs", () => {
  for (const value of [[], null, ["348"], [0], [-1], [1.1], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array(21).fill(348)]) {
    assert.throws(() => validateImportIds(value));
  }
  assert.deepEqual(validateImportIds([348, 348]), [348]);
  assert.equal(validateImportIds(Array.from({ length: 20 }, (_, i) => i + 1)).length, 20);
});
test("uses verified metadata and the authenticated owner, ignoring user-supplied titles and ratings", async () => {
  const { rows, deps } = database();
  const result = await importWatchlistBatch("a", [348], deps);
  assert.equal(result.userId, "a"); assert.equal(result.results[0].status, "added");
  const row = rows.get("a:348");
  assert.equal(row.display_title, "Verified 348"); assert.equal(row.rating, undefined); assert.equal(row.watched_at, undefined);
  assert.equal(row.user_id, "a");
});
test("repeat imports keep original rows and avoid unnecessary TMDB calls", async () => {
  const { rows, deps } = database();
  await importWatchlistBatch("a", [348], deps);
  const original = rows.get("a:348");
  deps.movie = async () => { throw new Error("must not reverify unchanged saves"); };
  const result = await importWatchlistBatch("a", [348], deps);
  assert.equal(result.results[0].status, "already_saved"); assert.equal(rows.get("a:348"), original);
});
test("the same film belongs independently to two accounts", async () => {
  const { rows, deps } = database();
  await importWatchlistBatch("a", [348], deps);
  const b = await importWatchlistBatch("b", [348], deps);
  assert.equal(b.results[0].status, "added"); assert.equal(rows.size, 2);
});
test("partial verification failures do not prevent other verified films saving", async () => {
  const { rows, deps } = database();
  deps.movie = async (id) => { if (id === 2) throw new Error("TMDB temporarily unavailable"); return movie(id); };
  const result = await importWatchlistBatch("a", [1, 2, 3], deps);
  assert.deepEqual(result.results.map((r) => r.status), ["added", "failed", "added"]);
  assert.equal(rows.size, 2); assert.equal(rows.has("a:2"), false);
});
test("mismatched server identity is never saved", async () => {
  const { rows, deps } = database(); deps.movie = async () => movie(999);
  const result = await importWatchlistBatch("a", [348], deps);
  assert.equal(rows.size, 0); assert.equal(result.results[0].status, "failed");
});
test("TMDB concurrency is bounded to four lookups", async () => {
  const { deps } = database(); let active = 0, peak = 0;
  deps.movie = async (id) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; return movie(id); };
  await importWatchlistBatch("a", Array.from({ length: 20 }, (_, i) => i + 1), deps);
  assert.equal(peak, 4);
});
test("overlapping imports use conflict-safe insertion without duplicate rows", async () => {
  const { rows, deps } = database(); let waiting = 0, release;
  const barrier = new Promise((r) => { release = r; });
  deps.existing = async () => { if (++waiting === 2) release(); await barrier; return []; };
  const [a, b] = await Promise.all([importWatchlistBatch("a", [348], deps), importWatchlistBatch("a", [348], deps)]);
  assert.equal(rows.size, 1);
  assert.deepEqual([a.results[0].status, b.results[0].status].sort(), ["added", "already_saved"]);
});
test("uncertain insert responses report failure and subsequent retries remain safe", async () => {
  const { rows, deps } = database(); const insert = deps.insert;
  deps.insert = async (r) => { await insert(r); throw new Error("Lost response"); };
  const first = await importWatchlistBatch("a", [348], deps);
  assert.equal(first.results[0].status, "failed"); assert.equal(rows.size, 1);
  const second = await importWatchlistBatch("a", [348], deps);
  assert.equal(second.results[0].status, "already_saved"); assert.equal(rows.size, 1);
});
test("missing authentication fails before reading or writing", async () => {
  await assert.rejects(importWatchlistBatch("", [348], {}), /Authentication/);
});
