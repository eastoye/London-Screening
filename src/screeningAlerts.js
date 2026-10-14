const PENDING_KEY = "london_screenings_pending_alert_action";
const PENDING_TTL = 24 * 60 * 60 * 1000;

export class ScreeningAlertsError extends Error {
  constructor(message, code = "alerts_unavailable") {
    super(message);
    this.name = "ScreeningAlertsError";
    this.code = code;
  }
}

export function alertTmdbId(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function confirmedAlertTmdbId(movie) {
  return movie?.match_status === "matched" ? alertTmdbId(movie.tmdb_id) : null;
}

function pendingStorage() {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}

function pendingAction(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "manage") return { kind: "manage" };
  if (value.kind === "follow") {
    const tmdbId = alertTmdbId(value.tmdbId);
    return tmdbId ? { kind: "follow", tmdbId, title: String(value.title ?? "").trim().slice(0, 500) } : null;
  }
  if (value.kind === "search") {
    const query = String(value.query ?? "").trim().slice(0, 200);
    return query ? { kind: "search", query } : null;
  }
  return null;
}

export function loadPendingAlertAction(storage = pendingStorage(), now = Date.now()) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(PENDING_KEY) || "null");
    if (!Number.isSafeInteger(value?.createdAt) || value.createdAt > now + 60000 || now - value.createdAt > PENDING_TTL) {
      storage.removeItem(PENDING_KEY);
      return null;
    }
    const action = pendingAction(value);
    if (!action) storage.removeItem(PENDING_KEY);
    return action;
  } catch { return null; }
}

export function savePendingAlertAction(action, storage = pendingStorage(), now = Date.now()) {
  const value = pendingAction(action);
  if (!value) return null;
  try { storage?.setItem(PENDING_KEY, JSON.stringify({ ...value, createdAt: now })); }
  catch { /* The current tab can still preserve the action in React state. */ }
  return value;
}

export function clearPendingAlertAction(storage = pendingStorage()) {
  try { storage?.removeItem(PENDING_KEY); } catch { /* Storage may be blocked. */ }
}

function invalidResponse() {
  return new ScreeningAlertsError("The alerts service returned an unexpected response. Please refresh and try again.", "invalid_response");
}

function optionalYear(value) {
  return Number.isInteger(value) && value >= 1870 && value <= 2200 ? value : null;
}

function posterPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 500 ? value : null;
}

function filmSnapshot(data, userId) {
  if (data?.stage !== 1 || !Array.isArray(data.films)) throw invalidResponse();
  if (data.preferences && (data.preferences.user_id !== userId || typeof data.preferences.paused !== "boolean")) throw invalidResponse();
  const films = new Map();
  for (const row of data.films) {
    const tmdbId = alertTmdbId(row?.tmdb_id);
    if (!tmdbId || row.user_id !== userId || row.active !== true || typeof row.display_title !== "string" || !row.display_title.trim()) throw invalidResponse();
    films.set(tmdbId, {
      tmdbId, displayTitle: row.display_title.trim().slice(0, 500),
      releaseYear: optionalYear(row.release_year), posterPath: posterPath(row.poster_path),
    });
  }
  return { films: [...films.values()], paused: data.preferences?.paused ?? false };
}

function emailSnapshot(data) {
  if (data?.stage !== 2 || !["disabled", "pilot"].includes(data.mode) || !["unverified", "active", "unsubscribed", "suppressed"].includes(data.email_state)) throw invalidResponse();
  if (data.email_permission !== (data.email_state === "active")) throw invalidResponse();
  return { mode: data.mode, state: data.email_state, permission: data.email_state === "active" && data.email_permission === true };
}

const errorMessages = {
  login_required: "Log in again to manage your screening alerts.",
  invalid_session: "Log in again to manage your screening alerts.",
  account_unavailable: "Log in again to manage your screening alerts.",
  follow_limit: "You have reached the film-follow limit. Remove a film before following another.",
  rate_limited: "Please wait a minute before trying again. Verification requests may need a longer wait.",
  email_disabled: "Email alerts aren't available yet. Your followed films stay saved.",
  email_unavailable: "Email alerts aren't available for this account yet. Your followed films stay saved.",
  baseline_required: "Screening alerts aren't available yet. Please try again later.",
  not_configured: "Email alerts aren't available yet. Your followed films stay saved.",
  film_not_found: "This film is no longer available. Please search for it again.",
};

export function createScreeningAlertsApi(client) {
  if (!client?.auth?.getSession || !client?.functions?.invoke) throw new TypeError("A configured Supabase client is required.");

  async function sessionFor(userId) {
    if (!userId) throw new ScreeningAlertsError("Log in to manage screening alerts.", "login_required");
    let value;
    try { value = await client.auth.getSession(); }
    catch { throw new ScreeningAlertsError("Log in again to manage screening alerts.", "login_required"); }
    const { data, error } = value;
    const session = data?.session;
    if (error || typeof session?.access_token !== "string" || !session.access_token || session.access_token.length > 16384) throw new ScreeningAlertsError("Log in again to manage screening alerts.", "login_required");
    if (session.user?.id !== userId || session.user?.is_anonymous === true) throw new ScreeningAlertsError("The account changed. Please try again with your current account.", "account_changed");
    return session;
  }

  async function invoke(userId, endpoint, body) {
    const session = await sessionFor(userId);
    let result;
    try {
      result = await client.functions.invoke(endpoint, { body, headers: { Authorization: `Bearer ${session.access_token}` } });
    } catch {
      await sessionFor(userId);
      throw new ScreeningAlertsError("Screening alerts couldn't be reached. Please try again.");
    }
    // Never display another account's response, even if a request completed during an account switch.
    await sessionFor(userId);
    if (result.error) {
      let code;
      try { const response = result.error.context; const value = await (response?.clone?.() ?? response)?.json?.(); code = value?.code; } catch { /* Use a safe fallback. */ }
      if (result.error.context?.status === 401 && !errorMessages[code]) code = "login_required";
      throw new ScreeningAlertsError(errorMessages[code] ?? "Screening alerts couldn't complete this request. Please try again.", code ?? "alerts_unavailable");
    }
    return result.data;
  }

  async function filmsAction(userId, action, tmdbId) {
    const body = { action };
    if (tmdbId !== undefined) {
      body.tmdbId = alertTmdbId(tmdbId);
      if (!body.tmdbId) throw new ScreeningAlertsError("Select an exact film before following it.", "invalid_tmdb_id");
    }
    return filmSnapshot(await invoke(userId, "screening-alerts", body), userId);
  }

  return {
    read: (userId) => filmsAction(userId, "read"),
    follow: (userId, id) => filmsAction(userId, "follow", id),
    remove: (userId, id) => filmsAction(userId, "remove", id),
    setPaused: (userId, paused) => filmsAction(userId, paused ? "pause" : "resume"),
    async search(userId, query) {
      const text = String(query ?? "").trim();
      if (text.length < 2 || text.length > 200) throw new ScreeningAlertsError("Enter 2–200 characters to find a film.", "invalid_query");
      const value = await invoke(userId, "screening-alerts", { action: "search", query: text });
      if (!Array.isArray(value?.candidates)) throw invalidResponse();
      const candidates = new Map();
      for (const candidate of value.candidates) {
        const tmdbId = alertTmdbId(candidate?.tmdbId);
        if (!tmdbId || typeof candidate.title !== "string" || !candidate.title.trim()) continue;
        candidates.set(tmdbId, { tmdbId, title: candidate.title.trim().slice(0, 500), releaseYear: optionalYear(candidate.releaseYear), posterPath: posterPath(candidate.posterPath), overview: typeof candidate.overview === "string" ? candidate.overview.slice(0, 2000) : "" });
      }
      return [...candidates.values()];
    },
    async emailStatus(userId) {
      return emailSnapshot(await invoke(userId, "screening-alerts-email", { action: "status" }));
    },
    async requestVerification(userId, consent) {
      if (consent !== true) throw new ScreeningAlertsError("Tick the email permission box before requesting verification.", "consent_required");
      const result = await invoke(userId, "screening-alerts-email", { action: "request_verification", consent: true });
      if (result?.verification_queued !== true) throw invalidResponse();
      return { verificationQueued: true };
    },
    async disableEmail(userId) {
      return emailSnapshot(await invoke(userId, "screening-alerts-email", { action: "disable" }));
    },
  };
}

export function emptyAlertsState(userId = null, accountEmail = "") {
  return {
    userId, accountEmail, films: [], paused: false, filmsLoaded: false,
    filmsStatus: userId ? "loading" : "idle", emailStatus: userId ? "loading" : "idle",
    email: null, emailPending: false, verificationRequestedAt: null, error: "", emailError: "",
    busyIds: new Set(), preferenceBusy: false, emailBusy: false,
  };
}

export function createScreeningAlertsStore(api) {
  let state = emptyAlertsState();
  let generation = 0;
  let accountEmail = "";
  let filmVersion = 0;
  let emailVersion = 0;
  let flight = null;
  let queue = Promise.resolve();
  let pending = new Map();
  const listeners = new Set();

  function update(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function busyPatch() {
    const keys = [...pending.keys()];
    return { busyIds: new Set(keys.filter(key => key.startsWith("film:")).map(key => Number(key.split(":")[1]))), preferenceBusy: keys.some(key => key.startsWith("preference:")), emailBusy: keys.some(key => key.startsWith("email:")) };
  }

  function sameAccount(owner, version) { return state.userId === owner && generation === version; }

  async function refresh() {
    if (!state.userId) return state;
    if (flight) return flight;
    const owner = state.userId, version = generation, filmsAt = filmVersion, emailAt = emailVersion;
    update({ filmsStatus: "loading", emailStatus: "loading", error: "", emailError: "" });
    const task = Promise.allSettled([api.read(owner), api.emailStatus(owner)]).then(([films, email]) => {
      if (!sameAccount(owner, version)) return state;
      const patch = {};
      if (filmsAt === filmVersion) {
        if (films.status === "fulfilled") Object.assign(patch, films.value, { filmsLoaded: true, filmsStatus: "ready", error: "" });
        else Object.assign(patch, { filmsStatus: "error", error: films.reason.message || "Your followed films couldn't be loaded." });
      }
      if (emailAt === emailVersion) {
        if (email.status === "fulfilled") Object.assign(patch, { email: email.value, emailStatus: "ready", emailError: "", ...(email.value.state === "active" || email.value.state === "unsubscribed" || email.value.state === "suppressed" ? { emailPending: false } : {}) });
        else Object.assign(patch, { emailStatus: "error", emailError: email.reason.message || "Email preferences couldn't be loaded." });
      }
      update(patch);
      return state;
    }).finally(() => { if (flight === task) flight = null; });
    flight = task;
    return task;
  }

  function mutate(key, group, producer, commit) {
    if (!state.userId) return Promise.reject(new ScreeningAlertsError("Log in to manage screening alerts.", "login_required"));
    if (pending.has(key)) return pending.get(key);
    const owner = state.userId, version = generation;
    if (group === "films") filmVersion++;
    else emailVersion++;
    const task = queue.catch(() => {}).then(async () => {
      if (!sameAccount(owner, version)) throw new ScreeningAlertsError("The account changed. Please try again.", "account_changed");
      const result = await producer(owner);
      if (!sameAccount(owner, version)) throw new ScreeningAlertsError("The account changed. Please try again.", "account_changed");
      if (group === "films") filmVersion++;
      else emailVersion++;
      update(commit(result));
      return result;
    }).catch((error) => {
      if (sameAccount(owner, version)) update(group === "films" ? { error: error.message, filmsStatus: state.filmsLoaded ? "ready" : "error" } : { emailError: error.message, emailStatus: state.email ? "ready" : "error" });
      throw error;
    }).finally(() => {
      if (sameAccount(owner, version)) { pending.delete(key); update(busyPatch()); }
    });
    pending.set(key, task);
    queue = task;
    update({ ...busyPatch(), ...(group === "films" ? { error: "" } : { emailError: "" }) });
    return task;
  }

  function filmAction(action, value) {
    const id = alertTmdbId(value);
    if (!id) return Promise.reject(new ScreeningAlertsError("Select an exact film first.", "invalid_tmdb_id"));
    return mutate(`film:${id}:${action}`, "films", (owner) => api[action](owner, id), (value) => ({ ...value, filmsStatus: "ready", filmsLoaded: true, error: "" }));
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setAccount(userId, email = "") {
      if (state.userId === (userId || null) && accountEmail === email) return;
      generation++;
      accountEmail = email;
      filmVersion = emailVersion = 0;
      flight = null;
      queue = Promise.resolve();
      pending = new Map();
      state = emptyAlertsState(userId || null, email);
      for (const listener of listeners) listener();
    },
    refresh,
    clearError: () => update({ error: "", emailError: "" }),
    follow: (id) => filmAction("follow", id),
    remove: (id) => filmAction("remove", id),
    setPaused(paused) {
      return mutate(`preference:${Boolean(paused)}`, "films", (owner) => api.setPaused(owner, Boolean(paused)), (value) => ({ ...value, filmsStatus: "ready", filmsLoaded: true, error: "" }));
    },
    search(query) {
      const owner = state.userId, version = generation;
      if (!owner) return Promise.reject(new ScreeningAlertsError("Log in to find films for alerts.", "login_required"));
      return api.search(owner, query).then(result => {
        if (!sameAccount(owner, version)) throw new ScreeningAlertsError("The account changed. Search again with your current account.", "account_changed");
        return result;
      });
    },
    requestVerification(consent) {
      if (consent !== true) return Promise.reject(new ScreeningAlertsError("Tick the email permission box first.", "consent_required"));
      if (state.emailStatus !== "ready" || state.email?.mode !== "pilot" || !["unverified", "unsubscribed"].includes(state.email?.state)) {
        return Promise.reject(new ScreeningAlertsError("Email alerts aren't available yet. Your followed films stay saved.", "email_disabled"));
      }
      return mutate("email:verify", "email", (owner) => api.requestVerification(owner, true), () => ({ emailPending: true, verificationRequestedAt: Date.now(), emailError: "" }));
    },
    disableEmail() {
      return mutate("email:disable", "email", (owner) => api.disableEmail(owner), (email) => ({ email, emailPending: false, emailStatus: "ready", emailError: "" }));
    },
  };
}
