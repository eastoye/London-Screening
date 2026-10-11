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
    range(start, end) {
      calls.push(["range", start, end]);
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

test("batch import binds its Authorization header to the expected current user", async () => {
  const calls = [];
  const mock = client({ invoke: async (name, options) => { calls.push(options); return { data: { userId: "user-a", results: [] } }; } });
  mock.value.auth = { getSession: async () => ({ data: { session: { user: { id: "user-a" }, access_token: "token-a" } } }) };
  await createNativeWatchlistApi(mock.value).importBatch("user-a", [348]);
  assert.deepEqual(calls, [{ headers: { Authorization: "Bearer token-a" }, body: { action: "import", tmdbIds: [348] } }]);
});
test("account switching prevents a batch request from being sent under the new session", async () => {
  let calls = 0;
  const mock = client({ invoke: async () => { calls++; } });
  mock.value.auth = { getSession: async () => ({ data: { session: { user: { id: "user-b" }, access_token: "token-b" } } }) };
  await assert.rejects(createNativeWatchlistApi(mock.value).importBatch("user-a", [348]), (e) => e.code === "account_changed");
  assert.equal(calls, 0);
});
test("missing sessions and unauthorised responses stop the import", async () => {
  const mock = client(); mock.value.auth = { getSession: async () => ({ data: { session: null } }) };
  await assert.rejects(createNativeWatchlistApi(mock.value).importBatch("user-a", [348]), (e) => e.code === "authentication_required");
});
test("rejects an import response attributed to a different account", async () => {
  const mock = client({ invoke: async () => ({ data: { userId: "user-b", results: [] } }) });
  mock.value.auth = { getSession: async () => ({ data: { session: { user: { id: "user-a" }, access_token: "token-a" } } }) };
  await assert.rejects(createNativeWatchlistApi(mock.value).importBatch("user-a", [348]), (e) => e.code === "invalid_response");
});


test("loads all watchlist pages beyond the Supabase per-request limit", async () => {
  let page = 0;
  const rows = Array.from({ length: 1201 }, (_, i) => ({ tmdb_id: i + 1, display_title: `Film ${i + 1}` }));
  const ranges = [];
  const value = {
    functions: { invoke() {} },
    from() {
      const builder = { select() { return builder; }, eq() { return builder; }, order() { return builder; },
        range(start, end) { ranges.push([start, end]); return Promise.resolve({ data: rows.slice(start, end + 1) }); } };
      page++; return builder;
    },
  };
  const result = await createNativeWatchlistApi(value).list("user-a");
  assert.equal(result.length, 1201); assert.equal(page, 3);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
});
