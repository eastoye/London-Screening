import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runAcceptance } from '../repository-files/public/screening-alerts-acceptance.mjs';

const accounts = { a: { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accessToken: 'test-a' },
  b: { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accessToken: 'test-b' } };
function backend(options = {}) {
  const state = new Map(Object.values(accounts).map(account => [account.userId, { preferences: null, films: [] }]));
  const requests = [];
  let generation = 0, failed = false;
  function next() { return String(++generation); }
  function view(user) {
    const own = state.get(user);
    const data = { stage: 1, sending_enabled: false, email_permission: false,
      preferences: own.preferences, films: own.films.filter(f => f.active), preview_counts: {}, latest_preview: null };
    return structuredClone(data);
  }
  const call = async (account, path, init = {}) => {
    requests.push({ user: account.userId, path, ...init });
    const own = state.get(account.userId), body = init.body || {};
    if (path.startsWith('/functions/')) {
      if (body.user_id) return { status: 400, data: { code: 'invalid_request', sending_enabled: false } };
      if (options.failAction === body.action && !failed) { failed = true; throw new Error('Simulated network failure.'); }
      if (body.action === 'search') return { status: 200, data: { sending_enabled: false, candidates: [{ tmdbId: 348, releaseYear: options.wrongFilm ? 1986 : 1979 }] } };
      if (body.action !== 'read' && !own.preferences) own.preferences = { user_id: account.userId, paused: false, email_enabled: false, generation: next(), requested_at: next() };
      if (body.action === 'follow') {
        let f = own.films.find(f => f.tmdb_id === body.tmdbId);
        if (!f) { f = { user_id: account.userId, tmdb_id: body.tmdbId, release_year: body.tmdbId === 348 ? 1979 : 1999, display_title: body.tmdbId === 348 ? 'Alien' : 'Fight Club', active: false }; own.films.push(f); }
        if (!f.active || options.badDuplicate) Object.assign(f, { effective_at: next(), generation: next() });
        f.active = true;
      }
      if (body.action === 'remove') own.films.filter(f => f.tmdb_id === body.tmdbId).forEach(f => { f.active = false; f.generation = next(); });
      if (body.action === 'pause' && !own.preferences.paused) Object.assign(own.preferences, { paused: true, generation: next() });
      if (body.action === 'resume' && own.preferences.paused) Object.assign(own.preferences, { paused: false, generation: next(), requested_at: next() });
      let data = view(account.userId);
      if (options.leakApi && account === accounts.b && state.get(accounts.a.userId).films.some(f => f.active)) data = view(accounts.a.userId);
      if (options.sendingEnabled) data.sending_enabled = true;
      return { status: 200, data };
    }
    if (path.includes('/rpc/')) return { status: 404, data: { code: 'PGRST202' } };
    if (init.method === 'PATCH') return { status: 403, data: { code: '42501' } };
    if (path.includes('user_watchlist')) return { status: 200, data: [] };
    const url = new URL('https://example.test' + path), target = url.searchParams.get('user_id')?.slice(3);
    if (target && target !== account.userId) return { status: 200, data: options.leakRls ? [{ tmdb_id: 348 }] : [] };
    return { status: 200, data: own.films.map(f => ({ tmdb_id: f.tmdb_id })) };
  };
  return { state, requests, call };
}

test('complete two-account flow passes 21 checks and removes both test follows', async () => {
  const mock = backend(), checks = [];
  const result = await runAcceptance(accounts, mock.call, label => checks.push(label));
  assert.equal(result.passed, true); assert.equal(result.checkCount, 21); assert.equal(checks.length, 21);
  for (const value of mock.state.values()) { assert.equal(value.films.filter(f => f.active).length, 0); assert.equal(value.preferences.paused, false); }
  assert.ok(mock.requests.filter(r => r.path.includes('/functions/')).length < 30);
});
test('same-account selection is rejected before any network request', async () => {
  let calls = 0;
  await assert.rejects(runAcceptance({ a: accounts.a, b: accounts.a }, async () => calls++), /different accounts/);
  assert.equal(calls, 0);
});
test('pre-existing preferences abort before writes', async () => {
  const mock = backend(); mock.state.get(accounts.a.userId).preferences = { user_id: accounts.a.userId, email_enabled: false, paused: false };
  await assert.rejects(runAcceptance(accounts, mock.call), /start with no alert preferences/);
  assert.ok(mock.requests.every(r => r.body?.action === 'read'));
});
test('pre-existing inactive follow aborts without reactivating or removing it', async () => {
  const mock = backend(); mock.state.get(accounts.a.userId).films.push({ tmdb_id: 348, active: false });
  await assert.rejects(runAcceptance(accounts, mock.call), /pre-existing inactive/);
  assert.ok(mock.requests.every(r => !r.body || r.body.action === 'read'));
});
test('email-enabled response stops before mutations', async () => {
  const mock = backend({ sendingEnabled: true });
  await assert.rejects(runAcceptance(accounts, mock.call), /email delivery is disabled/);
  assert.equal(mock.requests.length, 1);
});
test('wrong TMDB year fails without creating test follows', async () => {
  const mock = backend({ wrongFilm: true });
  await assert.rejects(runAcceptance(accounts, mock.call), /exact Alien/);
  assert.ok(mock.requests.every(r => !['follow','remove'].includes(r.body?.action)));
});
test('API account leak fails and cleans up the owned fixture', async () => {
  const mock = backend({ leakApi: true });
  await assert.rejects(runAcceptance(accounts, mock.call), /another account/);
  assert.equal(mock.state.get(accounts.a.userId).films.filter(f => f.active).length, 0);
});
test('RLS account leak fails and cleans up the owned fixture', async () => {
  const mock = backend({ leakRls: true });
  await assert.rejects(runAcceptance(accounts, mock.call), /cannot read account A rows/);
  assert.equal(mock.state.get(accounts.a.userId).films.filter(f => f.active).length, 0);
});
test('broken duplicate activation boundary fails and removes the fixture', async () => {
  const mock = backend({ badDuplicate: true });
  await assert.rejects(runAcceptance(accounts, mock.call), /Duplicate follow/);
  assert.equal(mock.state.get(accounts.a.userId).films.filter(f => f.active).length, 0);
});
test('network failure during resume triggers bounded recovery and owned cleanup', async () => {
  const mock = backend({ failAction: 'resume' });
  await assert.rejects(runAcceptance(accounts, mock.call), /Simulated network failure/);
  for (const value of mock.state.values()) { assert.equal(value.films.filter(f => f.active).length, 0); assert.equal(value.preferences.paused, false); }
});
test('package uses in-memory credentials, local logout and no provider or browser-storage API', async () => {
  const code = await readFile(new URL('../repository-files/public/screening-alerts-acceptance.mjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../repository-files/public/screening-alerts-acceptance.html', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie|service_role|WORKER_SECRET|resend\.com/);
  assert.match(code, /logout\?scope=local/); assert.match(code, /password'\)\) \}/);
  assert.match(html, /script-src 'self'/); assert.match(html, /type="password"/);
});
