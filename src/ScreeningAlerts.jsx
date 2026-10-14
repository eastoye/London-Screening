import { useEffect, useId, useRef, useState } from "react";
import ScreeningPoster from "./ScreeningPoster.jsx";
import { confirmedAlertTmdbId } from "./screeningAlerts.js";
import "./ScreeningAlerts.css";

function BellIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

export function ScreeningFollowButton({ movie, title, followedTmdbIds, busyTmdbIds, loading, onToggleFollow, onFindAlertFilm }) {
  if (!onToggleFollow || !onFindAlertFilm) return null;
  const id = confirmedAlertTmdbId(movie);
  const following = Boolean(id && followedTmdbIds?.has(id));
  const busy = Boolean(id && busyTmdbIds?.has(id));
  const label = id ? following ? "Notified" : "Notify Me" : "Find film";
  const description = id ? following ? `Stop notifications for ${title}` : `Notify me about newly added screenings for ${title}` : `Find the exact version of ${title} for screening alerts`;
  return <button type="button" className={`screening-follow-button${following ? " is-following" : ""}`} disabled={Boolean(id && (busy || loading))} aria-pressed={id ? following : undefined} aria-label={description} title={description} onClick={() => id ? onToggleFollow({ tmdbId: id, title, following }) : onFindAlertFilm(title)}><BellIcon /><span>{busy ? "Working…" : label}</span></button>;
}

function Film({ film, followed, busy, onFollow, onRemove, candidate = false }) {
  const title = candidate ? film.title : film.displayTitle;
  return <article className="screening-alert-film">
    <ScreeningPoster movie={{ match_status: "matched", poster_path: film.posterPath }} className="screening-alert-poster" />
    <div className="screening-alert-film-body"><h4>{title}{film.releaseYear ? ` (${film.releaseYear})` : ""}</h4>{candidate && film.overview && <p className="screening-alert-overview">{film.overview}</p>}</div>
    <button type="button" className="screening-alert-secondary" disabled={busy || (candidate && followed)} onClick={() => candidate ? onFollow(film.tmdbId, title) : onRemove(film.tmdbId, title)} aria-label={candidate ? followed ? `Already notified about ${title}` : `Notify me about newly added screenings for ${title}` : `Stop notifications for ${title}`}>{busy ? "Working…" : candidate ? followed ? "Notified" : "Notify Me" : "Remove"}</button>
  </article>;
}

export default function ScreeningAlertsModal({ isOpen, onClose, user, authLoading = false, alerts, onLogin, initialQuery = "", onInitialQueryConsumed }) {
  const [view, setView] = useState("followed");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const searchRef = useRef(null);
  const cycleRef = useRef(0);
  const searchVersionRef = useRef(0);
  const titleId = useId();
  const descriptionId = useId();
  const emailDescriptionId = useId();
  const accountId = user?.id ?? null;
  const accountEmail = user?.email ?? "";

  useEffect(() => {
    cycleRef.current++;
    searchVersionRef.current++;
    setCandidates([]);
    setSearching(false);
    setSearched(false);
    setSearchError("");
    setConsent(false);
    setNotice("");
    setNow(Date.now());
    if (!isOpen) return undefined;
    const requested = String(initialQuery ?? "").trim().slice(0, 200);
    setQuery(requested);
    setView(requested ? "search" : "followed");
    onInitialQueryConsumed?.();
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => (requested && accountId ? searchRef.current : closeRef.current)?.focus(), 0);
    const onKeyDown = event => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const targets = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])].filter(element => element.getClientRects().length > 0);
      if (!targets.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    let lastRefresh = 0;
    const onFocus = () => { if (accountId && Date.now() - lastRefresh >= 30000) { lastRefresh = Date.now(); void alerts.refresh(); } };
    window.addEventListener("focus", onFocus);
    return () => {
      cycleRef.current++;
      searchVersionRef.current++;
      window.clearTimeout(focusTimer);
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("focus", onFocus);
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
    // Consuming an initial query must not reset an already open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, accountId, accountEmail, onClose, onInitialQueryConsumed, alerts.refresh]);

  useEffect(() => {
    if (!isOpen || view !== "search" || !accountId) return undefined;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, view, accountId]);

  useEffect(() => {
    if (!isOpen || !alerts.emailPending) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [isOpen, alerts.emailPending]);

  if (!isOpen) return null;

  const email = alerts.email;
  const emailAvailable = alerts.emailStatus === "ready" && email?.mode === "pilot";
  const canVerify = emailAvailable && ["unverified", "unsubscribed"].includes(email.state);
  const cooldown = alerts.emailPending && now - (alerts.verificationRequestedAt ?? now) < 10 * 60 * 1000;
  const filmsBusy = !alerts.filmsLoaded;

  async function search(event) {
    event.preventDefault();
    if (searching) return;
    const cycle = cycleRef.current, version = ++searchVersionRef.current;
    setSearching(true); setSearchError(""); setCandidates([]); setSearched(false);
    try {
      const results = await alerts.search(query);
      if (cycle === cycleRef.current && version === searchVersionRef.current) { setCandidates(results); setSearched(true); }
    } catch (error) { if (cycle === cycleRef.current && version === searchVersionRef.current) setSearchError(error.message); }
    finally { if (cycle === cycleRef.current && version === searchVersionRef.current) setSearching(false); }
  }

  async function filmAction(id, title, remove = false) {
    const cycle = cycleRef.current;
    setNotice("");
    try {
      await (remove ? alerts.remove(id) : alerts.follow(id));
      if (cycle === cycleRef.current) {
        setNotice(remove ? `Stopped notifications for ${title}.` : `You’ll be notified about ${title}. This doesn't turn on email alerts.`);
        if (!document.activeElement?.isConnected || document.activeElement === document.body) closeRef.current?.focus();
      }
    } catch { /* The account-scoped store exposes the request error. */ }
  }

  async function emailAction(disable = false) {
    const cycle = cycleRef.current;
    setNotice("");
    try {
      if (disable) await alerts.disableEmail();
      else await alerts.requestVerification(consent);
      if (cycle === cycleRef.current) setNotice(disable ? "Email alerts are off. Your film list stays saved." : "Verification requested. Check your inbox and confirm the link before email alerts can start.");
    } catch (error) { if (cycle === cycleRef.current) setNotice(error.message); }
    finally { if (cycle === cycleRef.current) setConsent(false); }
  }

  return <div className="screening-alert-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="screening-alert-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} ref={dialogRef}>
      <header className="screening-alert-header"><div><h2 id={titleId}>Screening alerts</h2><p id={descriptionId}>Follow films for one morning email when new London screenings are added.</p></div><button type="button" className="screening-alert-close" ref={closeRef} aria-label="Close screening alerts" onClick={onClose}>×</button></header>
      <div className="screening-alert-content">
        {!user ? <div className="screening-alert-intro"><p>Log in to choose films and manage screening alerts. Your watchlist stays separate.</p><p>Email alerts aren't available yet. Choosing films won't send any emails.</p><button type="button" className="screening-alert-primary" disabled={authLoading} onClick={onLogin}>{authLoading ? "Checking account…" : "Log in"}</button></div> : <>
          <section className="screening-alert-email"><h3>Email alerts</h3><p className="screening-alert-address">{accountEmail}</p>
            {alerts.emailStatus === "loading" && <p role="status">Checking email preferences…</p>}
            {alerts.emailError && <p className="screening-alert-error" role="alert">{alerts.emailError}</p>}
            {alerts.emailStatus === "error" && <button type="button" className="screening-alert-secondary" onClick={() => void alerts.refresh()}>Try again</button>}
            {email && <>
              <p id={emailDescriptionId}>{!emailAvailable ? "Email alerts aren't available yet. You can choose films now; emails remain off." : email.state === "suppressed" ? "Email delivery is blocked for this address. Following films won't restart it." : email.permission ? "Your email address is confirmed for screening alerts." : "Confirm your account email to receive one morning digest for newly added screenings of the films you follow."}</p>
              {alerts.emailPending && <p role="status">Verification requested. Check your inbox. You can request another email after 10 minutes.</p>}
              {canVerify && <div className="screening-alert-opt-in"><label><input type="checkbox" checked={consent} disabled={alerts.emailBusy || cooldown} onChange={event => setConsent(event.target.checked)} aria-describedby={emailDescriptionId} /><span>Email me one morning digest when new London screenings are added for films I follow. I can unsubscribe at any time.</span></label><button type="button" className="screening-alert-primary" disabled={!consent || alerts.emailBusy || cooldown} onClick={() => void emailAction()}>{alerts.emailBusy ? "Working…" : "Send verification email"}</button></div>}
              {!["unsubscribed", "suppressed"].includes(email.state) && <button type="button" className="screening-alert-secondary" disabled={alerts.emailBusy} onClick={() => void emailAction(true)}>{alerts.emailBusy ? "Working…" : "Turn off email alerts"}</button>}
              {email.state === "unsubscribed" && <p>You've turned email alerts off.</p>}
            </>}
          </section>
          {notice && notice !== alerts.emailError && notice !== alerts.error && <p className="screening-alert-notice" role="status">{notice}</p>}
          {alerts.error && <p className="screening-alert-error" role="alert">{alerts.error}</p>}
          <div className="screening-alert-film-heading"><h3>Films you follow{alerts.filmsLoaded ? ` (${alerts.films.length})` : ""}</h3><button type="button" className="screening-alert-secondary" disabled={filmsBusy || alerts.preferenceBusy} aria-pressed={alerts.paused} onClick={() => { setNotice(""); void alerts.setPaused(!alerts.paused).catch(() => {}); }}>{alerts.preferenceBusy ? "Working…" : alerts.paused ? "Resume alerts" : "Pause alerts"}</button></div>
          {alerts.paused && <p className="screening-alert-notice" role="status">Alerts are paused. Your film list stays saved.</p>}
          <div className="screening-alert-views" role="group" aria-label="Choose a film list"><button type="button" aria-pressed={view === "followed"} onClick={() => setView("followed")}>Followed films</button><button type="button" aria-pressed={view === "search"} onClick={() => setView("search")}>Find a film</button></div>
          {alerts.filmsStatus === "loading" && <p role="status">Loading followed films…</p>}
          {alerts.filmsStatus === "error" && <button type="button" className="screening-alert-secondary" onClick={() => void alerts.refresh()}>Reload followed films</button>}
          {view === "followed" ? <div className="screening-alert-films">
            {alerts.filmsLoaded && alerts.films.length === 0 && <p>No films followed yet. Choose “Find a film” to start.</p>}
            {alerts.films.map(film => <Film key={film.tmdbId} film={film} busy={alerts.busyIds.has(film.tmdbId)} onRemove={(id, title) => void filmAction(id, title, true)} />)}
          </div> : <div className="screening-alert-search">
            <form onSubmit={search}><label htmlFor={`${titleId}-search`}>Find an exact film</label><div className="screening-alert-search-row"><input id={`${titleId}-search`} ref={searchRef} type="search" value={query} maxLength={200} placeholder="Title, e.g. Alien" onChange={event => { setQuery(event.target.value); searchVersionRef.current++; setSearching(false); setCandidates([]); setSearched(false); setSearchError(""); }} /><button type="submit" className="screening-alert-primary" disabled={searching || query.trim().length < 2}>{searching ? "Searching…" : "Search"}</button></div></form>
            <p>Check the title, year and poster before following a film.</p>
            {searchError && <p className="screening-alert-error" role="alert">{searchError}</p>}
            {searched && candidates.length === 0 && <p role="status">No films found. Try a different title.</p>}
            {candidates.map(film => <Film key={film.tmdbId} film={film} candidate followed={alerts.tmdbIds.has(film.tmdbId)} busy={filmsBusy || alerts.busyIds.has(film.tmdbId)} onFollow={(id, title) => void filmAction(id, title)} />)}
          </div>}
          <p className="screening-alert-footnote">Following a film doesn't add it to your watchlist or turn on emails. Alerts cover newly added screenings, rather than dates already listed.</p>
          <button type="button" className="screening-alert-secondary" disabled={alerts.filmsStatus === "loading" || alerts.emailStatus === "loading"} onClick={() => { setNotice(""); void alerts.refresh(); }}>Refresh preferences</button>
        </>}
      </div>
    </section>
  </div>;
}
