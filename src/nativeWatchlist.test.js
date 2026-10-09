import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUpcomingScreeningsByTmdbId,
  clearPendingWatchlistAction,
  confirmedMovieTmdbId,
  loadPendingWatchlistAction,
  savePendingWatchlistAction,
  screeningMatchesPersonalFilters,
  sortWatchlistItems,
} from "./nativeWatchlist.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("only confirmed movie rows expose a native watchlist identity", () => {
  assert.equal(
    confirmedMovieTmdbId({ match_status: "matched", tmdb_id: 348 }),
    348
  );
  assert.equal(
    confirmedMovieTmdbId({ match_status: "needs_review", tmdb_id: 348 }),
    null
  );
  assert.equal(
    confirmedMovieTmdbId({ match_status: "matched", tmdb_id: null }),
    null
  );
});

test("native filtering uses exact TMDB IDs and never title equality", () => {
  const filters = {
    nativeWatchlistOnly: true,
    nativeWatchlistTmdbIds: new Set([949]),
  };

  assert.equal(
    screeningMatchesPersonalFilters(
      { movie_title: "The Killer", movies: { match_status: "matched", tmdb_id: 949 } },
      filters
    ),
    true
  );
  assert.equal(
    screeningMatchesPersonalFilters(
      { movie_title: "The Killer", movies: { match_status: "matched", tmdb_id: 800158 } },
      filters
    ),
    false
  );
  assert.equal(
    screeningMatchesPersonalFilters(
      { movie_title: "The Killer", movies: { match_status: "needs_review", tmdb_id: 949 } },
      filters
    ),
    false
  );
});

test("native watchlist, Trakt watchlist and Trakt ratings retain OR behaviour", () => {
  const screening = {
    movies: { match_status: "matched", tmdb_id: 348 },
  };

  assert.equal(
    screeningMatchesPersonalFilters(screening, {
      minRating: 9,
      ratingsByTmdbId: new Map([[348, 7]]),
      nativeWatchlistOnly: true,
      nativeWatchlistTmdbIds: new Set([348]),
      traktWatchlistOnly: true,
      traktWatchlistTmdbIds: new Set(),
    }),
    true
  );

  assert.equal(
    screeningMatchesPersonalFilters(screening, {
      minRating: 9,
      ratingsByTmdbId: new Map([[348, 7]]),
      nativeWatchlistOnly: true,
      nativeWatchlistTmdbIds: new Set(),
      traktWatchlistOnly: true,
      traktWatchlistTmdbIds: new Set(),
    }),
    false
  );
});

test("upcoming screening summaries exclude uncertain identities", () => {
  const grouped = buildUpcomingScreeningsByTmdbId([
    {
      id: "later",
      start_time: "2026-12-02T20:00:00Z",
      movies: { match_status: "matched", tmdb_id: 348 },
    },
    {
      id: "earlier",
      start_time: "2026-12-01T20:00:00Z",
      movies: { match_status: "matched", tmdb_id: 348 },
    },
    {
      id: "uncertain",
      start_time: "2026-12-01T18:00:00Z",
      movies: { match_status: "needs_review", tmdb_id: 348 },
    },
  ]);

  assert.deepEqual(
    grouped.get(348).map((screening) => screening.id),
    ["earlier", "later"]
  );
});

test("pending logged-out actions survive until success or cancellation", () => {
  const storage = memoryStorage();
  const saved = savePendingWatchlistAction(
    { kind: "add", tmdbId: 348, title: "Alien" },
    storage
  );

  assert.deepEqual(saved, { kind: "add", tmdbId: 348, title: "Alien" });
  assert.deepEqual(loadPendingWatchlistAction(storage), saved);

  clearPendingWatchlistAction(storage);
  assert.equal(loadPendingWatchlistAction(storage), null);
});

test("saved films are ordered newest first without merging identical titles", () => {
  const sorted = sortWatchlistItems([
    { tmdbId: 949, displayTitle: "The Killer", addedAt: "2026-10-01T10:00:00Z" },
    { tmdbId: 800158, displayTitle: "The Killer", addedAt: "2026-10-02T10:00:00Z" },
  ]);

  assert.deepEqual(sorted.map((item) => item.tmdbId), [800158, 949]);
});
