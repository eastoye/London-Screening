import test from "node:test";
import assert from "node:assert/strict";
import { alertTmdbId, confirmedAlertTmdbId, clearPendingAlertAction, loadPendingAlertAction, savePendingAlertAction, createScreeningAlertsApi, createScreeningAlertsStore } from "./screeningAlerts.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function row(id = 348, userId = A) { return { user_id: userId, tmdb_id: id, display_title: "Alien", release_year: 1979, poster_path: "/poster.jpg", active: true }; }
function payload(films = [], userId = A, paused = false) { return { stage: 1, films, preferences: { user_id: userId, paused } }; }
function emailPayload(mode = "disabled", state = "unverified") { return { stage: 2, mode, email_state: state, email_permission: state === "active", public_sending_enabled: false }; }
function clientFixture(handler = async () => ({ data: payload(), error: null })) {
  let owner = A;
  const calls = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: owner ? { access_token: `fixture-token-${owner}`, user: { id: owner } } : null }, error: null }) },
    functions: { invoke: async (name, options) => { calls.push({ name, ...options }); return handler(name, options); } },
  };
  return { api: createScreeningAlertsApi(client), client, calls, setOwner(value) { owner = value; } };
}
function films(ids = [], paused = false) { return { films: ids.map(tmdbId => ({ tmdbId, displayTitle: `Film ${tmdbId}`, releaseYear: null, posterPath: null })), paused }; }
function storeFixture(overrides = {}) {
  const api = {
    read: async () => films(), emailStatus: async () => ({ mode: "disabled", state: "unverified", permission: false }),
    follow: async (_, id) => films([id]), remove: async () => films(), setPaused: async (_, paused) => films([], paused),
    search: async () => [], requestVerification: async () => ({ verificationQueued: true }), disableEmail: async () => ({ mode: "disabled", state: "unsubscribed", permission: false }), ...overrides,
  };
  const store = createScreeningAlertsStore(api);
  store.setAccount(A, "viewer@example.test");
  return { api, store };
}

test("film actions require a positive exact identity and a confirmed catalogue match", () => {
  assert.equal(confirmedAlertTmdbId({ match_status: "matched", tmdb_id: "348" }), 348);
  for (const value of [true, false, null, "", "0x15", "1e3", "-1", "1.5", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(alertTmdbId(value), null);
  for (const match_status of ["unmatched", "pending", "ambiguous", null]) assert.equal(confirmedAlertTmdbId({ match_status, tmdb_id: 348 }), null);
});

test("login handoff stores only a deliberate film action, expires, and tolerates blocked storage", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const action = { kind: "follow", tmdbId: 348, title: "Alien", consent: true, token: "not-persisted", email: "not-persisted" };
  assert.deepEqual(savePendingAlertAction(action, storage, 100000), { kind: "follow", tmdbId: 348, title: "Alien" });
  assert.equal([...values.values()][0].includes("consent"), false);
  assert.equal([...values.values()][0].includes("not-persisted"), false);
  assert.equal(loadPendingAlertAction(storage, 100001).tmdbId, 348);
  assert.equal(loadPendingAlertAction(storage, 100000 + 86400001), null);
  assert.equal(values.size, 0);
  savePendingAlertAction({ kind: "manage" }, storage, 100000);
  clearPendingAlertAction(storage);
  assert.equal(values.size, 0);
  assert.deepEqual(savePendingAlertAction(action, { setItem() { throw Error("blocked"); } }), { kind: "follow", tmdbId: 348, title: "Alien" });
  assert.equal(savePendingAlertAction({ kind: "follow", tmdbId: true }, storage), null);
});

test("film follows use the captured session and cannot write to watchlists or send email", async () => {
  const f = clientFixture(async () => ({ data: payload([row()]), error: null }));
  const result = await f.api.follow(A, 348);
  assert.deepEqual(f.calls, [{ name: "screening-alerts", body: { action: "follow", tmdbId: 348 }, headers: { Authorization: `Bearer fixture-token-${A}` } }]);
  assert.equal(result.films[0].tmdbId, 348);
});

test("invalid film IDs and search queries never reach the backend", async () => {
  const f = clientFixture();
  for (const id of [true, "0x10", -1, 0]) await assert.rejects(f.api.follow(A, id), { code: "invalid_tmdb_id" });
  for (const query of ["a", " ", "x".repeat(201)]) await assert.rejects(f.api.search(A, query), { code: "invalid_query" });
  assert.equal(f.calls.length, 0);
});

test("foreign-owned or malformed film responses cannot be rendered as an empty successful list", async () => {
  const f = clientFixture(async () => ({ data: payload([row(348, B)]), error: null }));
  await assert.rejects(f.api.read(A), { code: "invalid_response" });
  const missing = clientFixture(async () => ({ data: { stage: 1 }, error: null }));
  await assert.rejects(missing.api.read(A), { code: "invalid_response" });
});

test("an account without preferences has an empty unpaused film list", async () => {
  const f = clientFixture(async () => ({ data: { stage: 1, films: [], preferences: null }, error: null }));
  assert.deepEqual(await f.api.read(A), films());
});

test("same-title search candidates keep distinct IDs and years without automatically following", async () => {
  const f = clientFixture(async () => ({ data: { candidates: [{ tmdbId: 1, title: "Solaris", releaseYear: 1972 }, { tmdbId: 2, title: "Solaris", releaseYear: 2002 }, { tmdbId: true, title: "Invalid" }] }, error: null }));
  assert.deepEqual((await f.api.search(A, " Solaris ")).map(value => [value.tmdbId, value.releaseYear]), [[1, 1972], [2, 2002]]);
  assert.deepEqual(f.calls.map(value => value.body), [{ action: "search", query: "Solaris" }]);
});

test("an already changed or missing account cannot initiate a request", async () => {
  const f = clientFixture();
  f.setOwner(B); await assert.rejects(f.api.read(A), { code: "account_changed" });
  f.setOwner(null); await assert.rejects(f.api.read(A), { code: "login_required" });
  assert.equal(f.calls.length, 0);
});

test("switching accounts during a request discards its response", async () => {
  let f;
  f = clientFixture(async () => { f.setOwner(B); return { data: payload([row()]), error: null }; });
  await assert.rejects(f.api.follow(A, 348), { code: "account_changed" });
  assert.equal(f.calls[0].headers.Authorization, `Bearer fixture-token-${A}`);
});

test("transport diagnostics are not exposed and server error codes have safe messages", async () => {
  const f = clientFixture(async () => ({ error: { context: new Response(JSON.stringify({ error: "private-diagnostic", code: "follow_limit" }), { status: 409 }) }, data: null }));
  await assert.rejects(f.api.follow(A, 348), error => error.code === "follow_limit" && !error.message.includes("private-diagnostic"));
});

test("verification requires fresh explicit consent and returns no token or recipient fields", async () => {
  const f = clientFixture(async () => ({ data: { verification_queued: true, token: "never-rendered", email: "never-rendered" }, error: null }));
  await assert.rejects(f.api.requestVerification(A, false), { code: "consent_required" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.api.requestVerification(A, true), { verificationQueued: true });
  assert.deepEqual(f.calls[0].body, { action: "request_verification", consent: true });
});

test("unknown email modes and contradictory verification state fail closed", async () => {
  const unknown = clientFixture(async () => ({ data: { ...emailPayload(), mode: "public" }, error: null }));
  await assert.rejects(unknown.api.emailStatus(A), { code: "invalid_response" });
  const invalid = clientFixture(async () => ({ data: { ...emailPayload(), email_permission: true }, error: null }));
  await assert.rejects(invalid.api.emailStatus(A), { code: "invalid_response" });
});

test("unsubscribing uses only the account session, without arbitrary destination fields", async () => {
  const f = clientFixture(async () => ({ data: emailPayload("disabled", "unsubscribed"), error: null }));
  assert.equal((await f.api.disableEmail(A)).state, "unsubscribed");
  assert.deepEqual(f.calls[0].body, { action: "disable" });
});

test("anonymous state performs no backend reads", async () => {
  let reads = 0;
  const store = createScreeningAlertsStore({ read: async () => { reads++; }, emailStatus: async () => { reads++; } });
  await store.refresh();
  await assert.rejects(store.follow(348), { code: "login_required" });
  assert.equal(reads, 0);
});

test("changing accounts immediately clears films, email state and in-flight activity", async () => {
  const { store } = storeFixture({ read: async () => films([348]), emailStatus: async () => ({ mode: "pilot", state: "active", permission: true }) });
  await store.refresh();
  store.setAccount(B, "other@example.test");
  assert.deepEqual(store.getSnapshot().films, []);
  assert.equal(store.getSnapshot().email, null);
  assert.equal(store.getSnapshot().userId, B);
});

test("an email change on the same account invalidates prior verification state", async () => {
  const { store } = storeFixture({ emailStatus: async () => ({ mode: "pilot", state: "active", permission: true }) });
  await store.refresh(); store.setAccount(A, "changed@example.test");
  assert.equal(store.getSnapshot().email, null);
  assert.equal(store.getSnapshot().accountEmail, "changed@example.test");
});

test("an old account's delayed list cannot replace the current account's list", async () => {
  const old = deferred();
  const { store } = storeFixture({ read: owner => owner === A ? old.promise : Promise.resolve(films([999])) });
  const first = store.refresh();
  store.setAccount(B, "other@example.test"); await store.refresh();
  old.resolve(films([348])); await first;
  assert.deepEqual(store.getSnapshot().films.map(value => value.tmdbId), [999]);
});

test("duplicate follow clicks share one request and one busy state", async () => {
  const write = deferred(); let calls = 0;
  const { store } = storeFixture({ follow: () => { calls++; return write.promise; } });
  await store.refresh();
  const first = store.follow(348), second = store.follow(348);
  assert.equal(first, second); await tick(); assert.equal(calls, 1);
  assert.equal(store.getSnapshot().busyIds.has(348), true);
  write.resolve(films([348])); await first;
  assert.equal(store.getSnapshot().busyIds.size, 0);
});

test("different film mutations are ordered so late snapshots cannot lose a follow", async () => {
  const first = deferred(), calls = [];
  const { store } = storeFixture({ follow: async (_, id) => { calls.push(id); return id === 1 ? first.promise : films([1, 2]); } });
  await store.refresh(); const one = store.follow(1), two = store.follow(2);
  await tick(); assert.deepEqual(calls, [1]);
  first.resolve(films([1])); await Promise.all([one, two]);
  assert.deepEqual(store.getSnapshot().films.map(value => value.tmdbId), [1, 2]);
});

test("a stale refresh cannot undo a completed follow", async () => {
  const read = deferred(); let calls = 0;
  const { store } = storeFixture({ read: () => ++calls === 1 ? Promise.resolve(films()) : read.promise });
  await store.refresh(); const refresh = store.refresh(); await store.follow(348);
  read.resolve(films()); await refresh;
  assert.deepEqual(store.getSnapshot().films.map(value => value.tmdbId), [348]);
  assert.equal(store.getSnapshot().filmsStatus, "ready");
});

test("failed mutations do not leave a concurrently refreshed list stuck loading", async () => {
  const read = deferred(); let calls = 0;
  const { store } = storeFixture({ read: () => ++calls === 1 ? Promise.resolve(films()) : read.promise, follow: async () => { throw Error("Please retry."); } });
  await store.refresh(); const refresh = store.refresh(); await assert.rejects(store.follow(348));
  read.resolve(films()); await refresh;
  assert.equal(store.getSnapshot().filmsStatus, "ready");
  assert.equal(store.getSnapshot().busyIds.size, 0);
});

test("queued operations for a previous account never start after an account switch", async () => {
  const write = deferred(), calls = [];
  const { store } = storeFixture({ follow: (owner, id) => { calls.push([owner, id]); return write.promise; } });
  await store.refresh(); const first = store.follow(1), second = store.follow(2);
  const completion = Promise.allSettled([first, second]);
  await tick(); store.setAccount(B, "other@example.test"); await store.refresh();
  write.resolve(films([1])); const result = await completion;
  assert.ok(result.every(value => value.status === "rejected" && value.reason.code === "account_changed"));
  assert.deepEqual(calls, [[A, 1]]);
  assert.equal(store.getSnapshot().error, "");
  assert.equal(store.getSnapshot().busyIds.size, 0);
});

test("email status failures don't prevent film follows", async () => {
  const { store } = storeFixture({ emailStatus: async () => { throw Error("Email unavailable."); } });
  await store.refresh(); await store.follow(348);
  assert.equal(store.getSnapshot().films.length, 1);
  assert.equal(store.getSnapshot().emailStatus, "error");
});

test("film read failures don't prevent an explicit unsubscribe", async () => {
  const { store } = storeFixture({ read: async () => { throw Error("Films unavailable."); } });
  await store.refresh(); await store.disableEmail();
  assert.equal(store.getSnapshot().email.state, "unsubscribed");
});

test("disabled delivery cannot request verification even when consent is supplied", async () => {
  let requests = 0;
  const { store } = storeFixture({ requestVerification: async () => { requests++; } });
  await store.refresh(); await assert.rejects(store.requestVerification(true), { code: "email_disabled" });
  assert.equal(requests, 0);
});

test("suppression cannot be cleared by requesting verification", async () => {
  let requests = 0;
  const { store } = storeFixture({ emailStatus: async () => ({ mode: "pilot", state: "suppressed", permission: false }), requestVerification: async () => { requests++; } });
  await store.refresh(); await assert.rejects(store.requestVerification(true), { code: "email_disabled" });
  assert.equal(requests, 0);
});

test("unchecked consent cannot start verification even when delivery is available", async () => {
  let requests = 0;
  const { store } = storeFixture({ emailStatus: async () => ({ mode: "pilot", state: "unverified", permission: false }), requestVerification: async () => { requests++; } });
  await store.refresh(); await assert.rejects(store.requestVerification(false), { code: "consent_required" });
  assert.equal(requests, 0);
});

test("unsubscribe is queued after verification rather than coalesced with it", async () => {
  const verify = deferred(), calls = [];
  const { store } = storeFixture({ emailStatus: async () => ({ mode: "pilot", state: "unverified", permission: false }), requestVerification: () => { calls.push("verify"); return verify.promise; }, disableEmail: async () => { calls.push("disable"); return { mode: "pilot", state: "unsubscribed", permission: false }; } });
  await store.refresh(); const request = store.requestVerification(true), disable = store.disableEmail();
  await tick(); assert.deepEqual(calls, ["verify"]);
  verify.resolve({ verificationQueued: true }); await Promise.all([request, disable]);
  assert.deepEqual(calls, ["verify", "disable"]);
  assert.equal(store.getSnapshot().emailPending, false);
  assert.equal(store.getSnapshot().email.state, "unsubscribed");
});

test("pause preserves the followed films without granting email permission", async () => {
  const { store } = storeFixture({ read: async () => films([348]), setPaused: async (_, paused) => films([348], paused) });
  await store.refresh(); await store.setPaused(true);
  assert.equal(store.getSnapshot().paused, true);
  assert.equal(store.getSnapshot().films[0].tmdbId, 348);
  assert.equal(store.getSnapshot().email.permission, false);
});

test("a failed write doesn't block subsequent retries or retain busy buttons", async () => {
  let attempts = 0;
  const { store } = storeFixture({ follow: async (_, id) => { if (++attempts === 1) throw Error("Retry safely."); return films([id]); } });
  await store.refresh(); await assert.rejects(store.follow(348)); await store.follow(348);
  assert.equal(attempts, 2); assert.equal(store.getSnapshot().error, ""); assert.equal(store.getSnapshot().busyIds.size, 0);
});
