import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeWatchlistError,
  createNativeWatchlistApi,
} from "./nativeWatchlistApi.js";

function queryBuilder(result, calls) {
  const builder = {
    select(columns) {
      calls.push(["select", columns]);
      return builder;
    },
    delete() {
      calls.push(["delete"]);
      return builder;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return builder;
    },
    order(column, options) {
      calls.push(["order", column, options]);
      return builder;
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return builder;
}

function client({ queryResult = { data: [], error: null }, invoke } = {}) {
  const calls = [];

  return {
    calls,
    value: {
      from(table) {
        calls.push(["from", table]);
        return queryBuilder(queryResult, calls);
      },
      functions: {
        invoke:
          invoke ??
          (async () => ({ data: { candidates: [] }, error: null })),
      },
    },
  };
}

test("loads only the authenticated user's rows and maps database fields", async () => {
  const mock = client({
    queryResult: {
      data: [
        {
          tmdb_id: 348,
          display_title: "Alien",
          release_year: 1979,
          poster_path: "/poster.jpg",
          added_at: "2026-10-08T20:00:00Z",
          metadata_updated_at: "2026-10-08T20:00:00Z",
        },
      ],
      error: null,
    },
  });
  const api = createNativeWatchlistApi(mock.value);

  assert.deepEqual(await api.list("user-a"), [
    {
      tmdbId: 348,
      displayTitle: "Alien",
      releaseYear: 1979,
      posterPath: "/poster.jpg",
      addedAt: "2026-10-08T20:00:00Z",
      metadataUpdatedAt: "2026-10-08T20:00:00Z",
    },
  ]);
  assert.deepEqual(
    mock.calls.filter((call) => call[0] === "eq"),
    [["eq", "user_id", "user-a"]]
  );
});

test("adds by exact TMDB ID and trusts only the server-verified response", async () => {
  const invocations = [];
  const mock = client({
    invoke: async (name, options) => {
      invocations.push([name, options]);
      return {
        data: {
          created: true,
          item: {
            tmdbId: 348,
            displayTitle: "Alien",
            releaseYear: 1979,
            posterPath: "/poster.jpg",
            addedAt: "2026-10-08T20:00:00Z",
            metadataUpdatedAt: "2026-10-08T20:00:00Z",
          },
        },
        error: null,
      };
    },
  });
  const api = createNativeWatchlistApi(mock.value);

  const item = await api.add(348);

  assert.equal(item.tmdbId, 348);
  assert.equal(item.displayTitle, "Alien");
  assert.deepEqual(invocations, [
    ["native-watchlist-movies", { body: { action: "add", tmdbId: 348 } }],
  ]);
});

test("removal is scoped by both user ID and TMDB ID", async () => {
  const mock = client();
  const api = createNativeWatchlistApi(mock.value);

  await api.remove("user-b", 348);

  assert.deepEqual(
    mock.calls.filter((call) => call[0] === "eq"),
    [
      ["eq", "user_id", "user-b"],
      ["eq", "tmdb_id", 348],
    ]
  );
});

test("search returns separate candidates with identical titles", async () => {
  const mock = client({
    invoke: async () => ({
      data: {
        candidates: [
          { tmdbId: 949, title: "The Killer", releaseYear: 1989 },
          { tmdbId: 800158, title: "The Killer", releaseYear: 2023 },
        ],
      },
      error: null,
    }),
  });
  const api = createNativeWatchlistApi(mock.value);

  const results = await api.search("The Killer");

  assert.deepEqual(
    results.map((candidate) => [candidate.tmdbId, candidate.releaseYear]),
    [
      [949, 1989],
      [800158, 2023],
    ]
  );
});

test("function failures expose only the server's user-facing error", async () => {
  const mock = client({
    invoke: async () => ({
      data: null,
      error: {
        message: "internal transport detail",
        context: {
          async json() {
            return { error: "Your login has expired. Log in again." };
          },
        },
      },
    }),
  });
  const api = createNativeWatchlistApi(mock.value);

  await assert.rejects(
    api.add(348),
    (error) =>
      error instanceof NativeWatchlistError &&
      error.message === "Your login has expired. Log in again." &&
      !error.message.includes("transport")
  );
});
