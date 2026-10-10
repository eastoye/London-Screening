/** Temporary Stage 1 acceptance UI. No service key, worker key or email code. */
const PROJECT_URL = 'https://czsknzrtumbdweusfyhk.supabase.co';
const APP_ORIGIN = 'https://london-screenings-tq8c.bolt.host';
const PUBLIC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6c2tuenJ0dW1iZHdldXNmeWhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NjYwNzIsImV4cCI6MjEwMDA0MjA3Mn0.ULDi3OhKSXQNImh1KxYUIear7UrnLnnSKdIJW6lwbE8';
const TEST_FILMS = { a: 348, b: 550 };

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function disabledEmail(data) {
  requireThat(data?.sending_enabled === false, 'The server did not confirm email delivery is disabled.');
  if ('email_permission' in data) requireThat(data.email_permission === false, 'Unexpected email permission.');
  if (data.preferences) requireThat(data.preferences.email_enabled === false, 'Unexpected email consent.');
}
function film(data, id) { return data.films.find(item => item.tmdb_id === id); }
function sameBoundary(left, right) {
  return left.effective_at === right.effective_at && left.generation === right.generation;
}

export async function runAcceptance(accounts, call, onCheck = () => {}) {
  const { a, b } = accounts;
  requireThat(a?.userId && b?.userId && a.userId !== b.userId, 'Connect two different accounts.');
  const startedAt = new Date().toISOString();
  let checkCount = 0;
  const check = (condition, label) => { requireThat(condition, label); checkCount++; onCheck(label); };
  const api = async (account, action, extra = {}) => {
    const result = await call(account, '/functions/v1/screening-alerts', { method: 'POST', body: { action, ...extra } });
    requireThat(result.status === 200, `Alerts ${action} failed (HTTP ${result.status}).`);
    disabledEmail(result.data);
    if (action !== 'search') {
      requireThat(result.data.stage === 1 && Array.isArray(result.data.films), 'Invalid Stage 1 response.');
      requireThat(result.data.films.every(item => item.user_id === account.userId), 'Alerts API exposed another account.');
      if (result.data.preferences) requireThat(result.data.preferences.user_id === account.userId, 'Preferences belong to another account.');
    }
    return result.data;
  };
  const table = async (account, path) => {
    const result = await call(account, path);
    requireThat(result.status === 200 && Array.isArray(result.data), 'Owner-scoped table read failed.');
    return result.data;
  };
  const watchlistPath = '/rest/v1/user_watchlist?select=tmdb_id&order=tmdb_id';
  const beforeA = await api(a, 'read');
  const beforeB = await api(b, 'read');
  check(beforeA.films.length === 0 && beforeA.preferences === null && beforeB.films.length === 0 && beforeB.preferences === null,
    'Both accounts start with no alert preferences or active follows');
  const watchlists = [await table(a, watchlistPath), await table(b, watchlistPath)];
  const allFollowsPath = '/rest/v1/user_screening_alerts?select=tmdb_id';
  check((await table(a, allFollowsPath)).length === 0 && (await table(b, allFollowsPath)).length === 0,
    'Neither account has pre-existing inactive alert follows');
  const pendingCleanup = new Map();
  let pausedAttempt = false;
  let failure;
  try {
    const search = await api(a, 'search', { query: 'Alien' });
    check(Array.isArray(search.candidates) && search.candidates.some(item => item.tmdbId === TEST_FILMS.a && item.releaseYear === 1979),
      'Authenticated alerts search returns exact Alien (1979) identity');
    pendingCleanup.set(a, TEST_FILMS.a);
    const first = await api(a, 'follow', { tmdbId: TEST_FILMS.a });
    const initialFilm = film(first, TEST_FILMS.a);
    check(first.films.length === 1 && initialFilm?.release_year === 1979 && initialFilm.display_title === 'Alien',
      'Account A follows the exact TMDB film with email disabled');
    const duplicate = await api(a, 'follow', { tmdbId: TEST_FILMS.a });
    check(duplicate.films.length === 1 && sameBoundary(initialFilm, film(duplicate, TEST_FILMS.a)),
      'Duplicate follow preserves one film and its activation boundary');
    const bBefore = await api(b, 'read');
    check(bBefore.films.length === 0 && bBefore.preferences === null, 'Account B cannot see account A alerts or preferences');
    const foreignA = await table(b, `/rest/v1/user_screening_alerts?select=tmdb_id&user_id=eq.${encodeURIComponent(a.userId)}`);
    const foreignPrefs = await table(b, `/rest/v1/screening_alert_preferences?select=paused&user_id=eq.${encodeURIComponent(a.userId)}`);
    check(foreignA.length === 0 && foreignPrefs.length === 0, 'Real account B JWT cannot read account A rows through RLS');
    pendingCleanup.set(b, TEST_FILMS.b);
    const bFollowed = await api(b, 'follow', { tmdbId: TEST_FILMS.b });
    check(bFollowed.films.length === 1 && film(bFollowed, TEST_FILMS.b)?.release_year === 1999,
      'Account B can independently follow Fight Club (1999)');
    const aRead = await api(a, 'read');
    check(aRead.films.length === 1 && film(aRead, TEST_FILMS.a) && !film(aRead, TEST_FILMS.b),
      'Account A cannot see account B film');
    const foreignB = await table(a, `/rest/v1/user_screening_alerts?select=tmdb_id&user_id=eq.${encodeURIComponent(b.userId)}`);
    const foreignBPrefs = await table(a, `/rest/v1/screening_alert_preferences?select=paused&user_id=eq.${encodeURIComponent(b.userId)}`);
    check(foreignB.length === 0 && foreignBPrefs.length === 0, 'Real account A JWT cannot read account B rows through RLS');
    const spoof = await call(b, '/functions/v1/screening-alerts', { method: 'POST', body: { action: 'read', user_id: a.userId } });
    check(spoof.status === 400 && spoof.data?.code === 'invalid_request', 'Alerts API rejects forged account ownership');
    disabledEmail(spoof.data);
    const forbiddenWrite = await call(b, `/rest/v1/user_screening_alerts?user_id=eq.${encodeURIComponent(a.userId)}&tmdb_id=eq.${TEST_FILMS.a}`,
      { method: 'PATCH', body: { active: false }, headers: { Prefer: 'return=representation' } });
    check([401, 403].includes(forbiddenWrite.status) && forbiddenWrite.data?.code === '42501',
      'Browser roles cannot update alert rows directly');
    const forbiddenRpc = await call(b, '/rest/v1/rpc/screening_alerts_read', { method: 'POST', body: { p_user_id: a.userId } });
    check([401, 403, 404].includes(forbiddenRpc.status) && ['42501', 'PGRST202'].includes(forbiddenRpc.data?.code),
      'Browser JWT cannot call service-only alerts RPC');
    const bRemoveOther = await api(b, 'remove', { tmdbId: TEST_FILMS.a });
    const stillA = await api(a, 'read');
    check(bRemoveOther.films.length === 1 && film(bRemoveOther, TEST_FILMS.b) && sameBoundary(initialFilm, film(stillA, TEST_FILMS.a)),
      'Account B remove cannot alter account A follow');
    pausedAttempt = true;
    const paused = await api(a, 'pause');
    const pausedAgain = await api(a, 'pause');
    check(paused.preferences.paused === true && pausedAgain.preferences.generation === paused.preferences.generation,
      'Pause and repeated pause are idempotent');
    const unpausedB = await api(b, 'read');
    check(unpausedB.preferences.paused === false, 'Account A pause does not change account B preferences');
    const resumed = await api(a, 'resume');
    pausedAttempt = false;
    const resumedAgain = await api(a, 'resume');
    check(resumed.preferences.paused === false && resumed.preferences.generation !== paused.preferences.generation &&
      resumed.preferences.requested_at !== paused.preferences.requested_at &&
      resumedAgain.preferences.generation === resumed.preferences.generation && resumedAgain.preferences.requested_at === resumed.preferences.requested_at,
      'Resume creates one fresh activation boundary and repeated resume preserves it');
    const removed = await api(a, 'remove', { tmdbId: TEST_FILMS.a });
    check(removed.films.length === 0, 'Account A removes its own follow');
    const refollow = await api(a, 'follow', { tmdbId: TEST_FILMS.a });
    const refollowedFilm = film(refollow, TEST_FILMS.a);
    check(refollow.films.length === 1 && refollowedFilm.effective_at !== initialFilm.effective_at && refollowedFilm.generation !== initialFilm.generation,
      'Refollow gets a fresh film activation boundary');
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  if (pausedAttempt) {
    try { await api(a, 'resume'); } catch { cleanupErrors.push('Account A resume needs developer recovery.'); }
  }
  for (const [account, id] of pendingCleanup) {
    try {
      const result = await api(account, 'remove', { tmdbId: id });
      requireThat(!film(result, id), 'Test follow remained active.');
    } catch { cleanupErrors.push(`Account ${account === a ? 'A' : 'B'} test follow needs developer recovery.`); }
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join(' '));
  if (failure) throw failure;
  const finalA = await api(a, 'read');
  const finalB = await api(b, 'read');
  check(finalA.films.length === 0 && finalB.films.length === 0 && !finalA.preferences.paused && !finalB.preferences.paused,
    'Both accounts finish with no active test follows, unpaused and email disabled');
  check(JSON.stringify(watchlists[0]) === JSON.stringify(await table(a, watchlistPath)) &&
    JSON.stringify(watchlists[1]) === JSON.stringify(await table(b, watchlistPath)), 'Native watchlists remain unchanged');
  return { passed: true, checkCount, startedAt, finishedAt: new Date().toISOString(), sendingEnabled: false,
    cleanup: 'Test follows inactive. Test-only preferences and inactive follow rows await scoped developer cleanup.' };
}

async function boot() {
  const el = id => document.getElementById(id);
  const sessions = { a: null, b: null };
  let running = false, completed = false;
  const configured = location.origin === APP_ORIGIN && !PUBLIC_KEY.startsWith('__');
  el('configuration-status').textContent = configured ? 'Connected to the existing London Screenings backend. No email provider is used.' :
    'Open this page on the published London Screenings site. Tests are disabled here.';
  const update = () => {
    el('run').disabled = !configured || !sessions.a || !sessions.b || running || completed;
    el('disconnect').disabled = running || (!sessions.a && !sessions.b);
    for (const name of ['a', 'b']) el(`account-${name}`).querySelector('button').disabled = !configured || !!sessions[name] || running;
  };
  async function call(account, path, options = {}) {
    const response = await fetch(`${PROJECT_URL}${path}`, { method: options.method || 'GET', cache: 'no-store', credentials: 'omit',
      headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json', ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { throw new Error('Invalid server response.'); }
    return { status: response.status, data };
  }
  for (const name of ['a', 'b']) {
    el(`account-${name}`).addEventListener('submit', async event => {
      event.preventDefault();
      if (!configured || running || sessions[name]) return;
      const form = event.currentTarget;
      const values = new FormData(form);
      const loginBody = JSON.stringify({ email: String(values.get('email')).trim(), password: String(values.get('password')) });
      el(`${name}-password`).value = '';
      form.querySelector('button').disabled = true;
      el(`${name}-status`).textContent = 'Connecting…';
      try {
        const response = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, { method: 'POST', cache: 'no-store', credentials: 'omit',
          headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json' }, body: loginBody, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Sign-in failed. Check the account credentials.');
        const data = await response.json();
        requireThat(typeof data.access_token === 'string' && typeof data.user?.id === 'string', 'Invalid sign-in response.');
        requireThat(data.user.is_anonymous !== true && !!data.user.email_confirmed_at, 'Use a verified email account.');
        const other = sessions[name === 'a' ? 'b' : 'a'];
        const account = { userId: data.user.id, accessToken: data.access_token };
        if (other?.userId === account.userId) {
          await fetch(`${PROJECT_URL}/auth/v1/logout?scope=local`, { method: 'POST', credentials: 'omit', headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${account.accessToken}` } });
          throw new Error('Use a different account for A and B.');
        }
        sessions[name] = account;
        el(`${name}-email`).value = '';
        el(`${name}-status`).textContent = `Account ${name.toUpperCase()} connected`;
      } catch (error) { el(`${name}-status`).textContent = error.message === 'Failed to fetch' ? 'Sign-in could not reach the server.' : error.message; }
      finally { update(); }
    });
  }
  el('run').addEventListener('click', async () => {
    if (running || completed || !sessions.a || !sessions.b) return;
    running = true; update(); el('results').replaceChildren(); el('run-status').textContent = 'Running bounded Stage 1 tests…';
    try {
      const result = await runAcceptance(sessions, call, label => { const row = document.createElement('li'); row.className = 'success'; row.textContent = `Passed: ${label}`; el('results').append(row); });
      el('run-status').textContent = `Passed ${result.checkCount} checks. Email disabled. Test follows removed. Developer database readback and cleanup remain.`;
      completed = true;
    } catch (error) { el('run-status').textContent = `Stopped: ${error.message}`; el('run-status').className = 'failure'; completed = true; }
    finally { running = false; update(); }
  });
  el('disconnect').addEventListener('click', async () => {
    if (running) return;
    running = true; update();
    const failures = [];
    for (const name of ['a', 'b']) {
      if (!sessions[name]) continue;
      try {
        const response = await fetch(`${PROJECT_URL}/auth/v1/logout?scope=local`, { method: 'POST', credentials: 'omit',
          headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${sessions[name].accessToken}` }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) failures.push(name.toUpperCase());
      } catch { failures.push(name.toUpperCase()); }
      sessions[name] = null; el(`${name}-status`).textContent = 'Disconnected';
    }
    el('run-status').textContent = failures.length ? 'Test sessions cleared from memory; server logout could not be confirmed for ' + failures.join(', ') + '.' : 'Test sessions disconnected. Normal application sessions are unchanged.';
    running = false; update();
  });
  update();
}
if (typeof document !== 'undefined') boot();
