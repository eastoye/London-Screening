import { useModalViewport } from "./useModalViewport.js";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deduplicateBeforeMatching } from "./movieImport/model.js";
import { parseTextInput } from "./movieImport/textParser.js";
import { parseImportFile } from "./movieImport/fileParser.js";
import { matchImportRecords } from "./movieImport/matcherApi.js";
import { confirmedForDestination, initialiseDestinationSelections, recordSelection } from "./movieImport/destinations.js";
import { clearImportDraft, loadImportDraft, saveImportDraft } from "./movieImport/draft.js";
import "./MovieImportModal.css";

const MAX_IMPORT_RECORDS = 5000;
const destinationLabel = (destination) => destination === "native" ? "London Screening Watchlist" : "Trakt";

function CloseIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>;
}

function sourceLabel(source) {
  return { letterboxd: "Letterboxd", imdb: "IMDb", csv: "CSV" }[source] || "Text";
}

function intentLabel(record, destination) {
  if (destination === "native") return record.watchlist ? "Watchlist film" : "Rated-only film · optional";
  const converted = record.rating && record.originalRating !== null && (record.ratingScale !== 10 || record.originalRating !== record.rating)
    ? `${record.originalRating}/${record.ratingScale} → ${record.rating}/10`
    : record.rating ? `${record.rating}/10` : "";
  if (record.watchlist && record.rating) return `Watchlist · Rate ${converted} · Watched`;
  if (record.rating) return `Rate ${converted} · Watched`;
  return record.ratingInvalidReason ? "Invalid rating · skipped in Trakt" : "Watchlist";
}

function ReviewRow({ record, destination, disabled, onSelectionChange }) {
  const matched = record.status === "matched" && record.match;
  const ambiguous = record.status === "ambiguous";
  const selected = recordSelection(record, destination);
  return (
    <li className={`movie-import-row is-${record.status}`}>
      <div className="movie-import-row-source">
        <div><strong>{record.title || "Untitled row"}</strong>{record.year && <span> ({record.year})</span>}</div>
        <div className="movie-import-row-meta">
          <span>{sourceLabel(record.source)}</span><span>{intentLabel(record, destination)}</span>
          {record.duplicateCount > 1 && <span>{record.duplicateCount} duplicate rows merged</span>}
        </div>
      </div>
      {matched && <label className="movie-import-match-choice">
        <input type="checkbox" disabled={disabled} checked={Boolean(selected)} onChange={(event) => onSelectionChange(record.clientId, event.target.checked ? record.match.tmdbId : null)} />
        <span><strong>{record.match.title}</strong>{record.match.year && ` (${record.match.year})`}<small>{record.reason}</small></span>
      </label>}
      {ambiguous && <label className="movie-import-candidate-select">
        <span>Choose the correct film or skip it</span>
        <select disabled={disabled} value={selected || ""} onChange={(event) => onSelectionChange(record.clientId, event.target.value ? Number(event.target.value) : null)}>
          <option value="">Skip — no film selected</option>
          {(record.candidates || []).map((candidate) => <option key={candidate.tmdbId} value={candidate.tmdbId}>{candidate.title}{candidate.year ? ` (${candidate.year})` : " (year unknown)"}</option>)}
        </select><small>{record.reason}</small>
      </label>}
      {(record.status === "unmatched" || record.status === "invalid") && <div className="movie-import-unresolved"><strong>{record.status === "invalid" ? "Invalid row" : "No match found"}</strong><span>{record.invalidReason || record.reason}</span></div>}
    </li>
  );
}

function ResultSummary({ result }) {
  const native = result.destination === "native";
  const sections = native ? [["London Screening Watchlist", result.watchlist]] : [["Trakt watchlist", result.watchlist], ["Trakt ratings", result.ratings], ["Trakt watched history", result.history]];
  return <div className="movie-import-result">
    {sections.filter(([, summary]) => summary).map(([label, summary]) => <div className="movie-import-result-card" key={label}>
      <strong>{label}</strong><span>{summary.added} added</span>
      {Boolean(summary.updated) && <span>{summary.updated} updated</span>}
      <span>{summary.existing} already saved / unchanged</span><span>{summary.failed} failed</span>
    </div>)}
    <div className="movie-import-result-card"><strong>Review</strong><span>{result.skipped} source rows skipped</span><span>Duplicate selections are merged by TMDB ID.</span></div>
    {result.failures?.length > 0 && <div className="movie-import-failures"><strong>Individual failures</strong><ul>{result.failures.map((item, index) => <li key={`${item.tmdbId}-${index}`}><strong>{item.title}</strong> (TMDB {item.tmdbId}){item.operation && ` · ${item.operation}`}<span>{item.error}</span></li>)}</ul><p>Successful changes were kept. You can repeat the import safely.</p></div>}
    {result.interrupted && <p className="movie-import-result-warning">Your connection expired. Remaining films were not attempted. Reconnect, then review and confirm again.</p>}
    {result.refreshWarning && <p className="movie-import-result-warning">{result.refreshWarning}</p>}
  </div>;
}

export default function MovieImportModal({ isOpen, onClose, initialDestination = "trakt", resumeDraft = false,
  nativeUserId, nativeUserLabel, authLoading = false, traktAccountKey, traktConnected, traktConnecting,
  onRequireNativeAuth, onConnectTrakt, onNativeImport, onTraktImport, suspended = false }) {
  const viewportStyle = useModalViewport(isOpen);
  const [destination, setDestination] = useState(initialDestination);
  const [phase, setPhase] = useState("input");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [records, setRecords] = useState([]);
  const [reviewPage, setReviewPage] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  const previousFocusRef = useRef(null);
  const phaseRef = useRef("input");
  const operationRef = useRef(0);
  const ownersRef = useRef({ native: null, trakt: null });
  const titleId = useId();
  const descriptionId = useId();
  const changePhase = (next) => { phaseRef.current = next; setPhase(next); };

  useLayoutEffect(() => {
    if (!isOpen || authLoading) return;
    operationRef.current += 1;
    const draft = resumeDraft ? loadImportDraft({ nativeUserId, traktAccountKey }) : null;
    ownersRef.current = { native: nativeUserId || null, trakt: traktAccountKey || null };
    if (draft) saveImportDraft({ ...draft, nativeOwnerId: nativeUserId || null, traktOwnerId: traktAccountKey || null });
    setDestination(draft?.destination || initialDestination);
    setText(draft?.text || "");
    setFile(null);
    setRecords(draft?.records || []); setReviewPage(0);
    setResult(null);
    setError(draft ? `Your import was restored. Review the destination and confirm when ready. No films have been saved automatically.${draft.hadUnmatchedFile ? " Select the file again to match its films." : ""}` : "");
    changePhase(draft?.records?.length ? "review" : "input");
    return () => { operationRef.current += 1; };
    // Opening and auth initialization define the session. Account changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authLoading]);

  useLayoutEffect(() => {
    if (!isOpen || authLoading) return;
    const previous = ownersRef.current;
    if ((previous.native && previous.native !== nativeUserId) || (previous.trakt && previous.trakt !== traktAccountKey)) {
      operationRef.current += 1;
      clearImportDraft();
      setRecords([]); setText(""); setFile(null); setResult(null);
      changePhase("input");
      setError("The account changed. The import was cleared to protect your data. Any completed saves remain in the original account.");
    } else if ((!previous.native && nativeUserId) || (!previous.trakt && traktAccountKey)) {
      const draft = loadImportDraft({ nativeUserId, traktAccountKey });
      if (draft) saveImportDraft({ ...draft, nativeOwnerId: nativeUserId || null, traktOwnerId: traktAccountKey || null });
    }
    ownersRef.current = { native: nativeUserId || null, trakt: traktAccountKey || null };
  }, [isOpen, nativeUserId, traktAccountKey, authLoading]);

  useEffect(() => {
    if (!isOpen || suspended || authLoading) return undefined;
    previousFocusRef.current = document.activeElement;
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !["matching", "writing"].includes(phaseRef.current)) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const fields = dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!fields?.length) return;
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); document.body.style.overflow = overflow; document.removeEventListener("keydown", onKeyDown); previousFocusRef.current?.focus?.(); };
  }, [isOpen, suspended, authLoading, onClose]);

  const sortedRecords = useMemo(() => {
    const priority = { ambiguous: 0, unmatched: 1, invalid: 2, matched: 3 };
    return [...records].sort((a, b) => (priority[a.status] ?? 99) - (priority[b.status] ?? 99));
  }, [records]);
  const counts = useMemo(() => {
    const values = { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
    for (const record of records) if (values[record.status] !== undefined) values[record.status] += 1;
    return values;
  }, [records]);
  const confirmed = useMemo(() => confirmedForDestination(records, destination), [records, destination]);
  const ratingConflictCount = records.filter((record) => record.ratingConflict || record.ratingInvalidReason).length;
  const skipped = records.filter((record) => !recordSelection(record, destination) || !["matched", "ambiguous"].includes(record.status) || (destination === "trakt" && (record.ratingConflict || record.ratingInvalidReason))).length;
  const busy = phase === "matching" || phase === "writing";
  const ready = destination === "native" ? Boolean(nativeUserId) : Boolean(traktConnected);

  const preserveForAuthentication = () => {
    const stored = saveImportDraft({ destination, text, records, hadUnmatchedFile: Boolean(file) && !records.length, nativeOwnerId: nativeUserId || null, traktOwnerId: traktAccountKey || null });
    if (!stored) setError("This browser cannot preserve the import across a page reload. Keep this tab open while connecting.");
    if (destination === "native") onRequireNativeAuth();
    else onConnectTrakt();
  };
  const processInput = async () => {
    if (["matching", "writing"].includes(phaseRef.current)) return;
    const operation = ++operationRef.current;
    const isActive = () => operationRef.current === operation;
    setError(""); setProgress({ completed: 0, total: 0 }); changePhase("matching");
    try {
      const parsed = [...parseTextInput(text)];
      if (file) parsed.push(...await parseImportFile(file));
      if (!isActive()) return;
      if (!parsed.length) throw new Error("Enter at least one movie or choose an import file.");
      const deduplicated = deduplicateBeforeMatching(parsed);
      if (deduplicated.length > MAX_IMPORT_RECORDS) throw new Error(`Import no more than ${MAX_IMPORT_RECORDS} unique movies at once.`);
      const matched = await matchImportRecords(deduplicated, { isActive, onProgress: setProgress });
      if (!isActive()) return;
      setRecords(initialiseDestinationSelections(matched)); setReviewPage(0); changePhase("review");
    } catch (processingError) {
      if (!isActive()) return;
      setError(processingError.message || "The import could not be processed."); changePhase("input");
    }
  };
  const updateSelection = (clientId, selectedTmdbId) => {
    if (phaseRef.current === "writing") return;
    setRecords((current) => current.map((record) => record.clientId !== clientId ? record : destination === "native"
      ? { ...record, nativeIncluded: Boolean(selectedTmdbId), nativeSelectedTmdbId: selectedTmdbId }
      : { ...record, selectedTmdbId }));
  };
  const writeImport = async () => {
    if (phaseRef.current !== "review") return;
    if (!ready) { preserveForAuthentication(); return; }
    const operation = ++operationRef.current;
    const isActive = () => operationRef.current === operation;
    setError(""); setProgress({ completed: 0, total: confirmed.length }); changePhase("writing");
    // A reload can resume review, but never automatically resume writing.
    saveImportDraft({ destination, text, records, hadUnmatchedFile: Boolean(file) && !records.length, nativeOwnerId: nativeUserId || null, traktOwnerId: traktAccountKey || null });
    try {
      const importResult = await (destination === "native" ? onNativeImport : onTraktImport)(confirmed, {
        isActive, onProgress: (value) => { if (isActive()) setProgress(value); },
      });
      if (!isActive()) return;
      const failures = destination === "native" ? importResult.watchlist.failures : ["watchlist", "ratings", "history"].flatMap((operationName) => {
        const summary = importResult[operationName];
        return (summary?.failedTmdbIds || []).map((tmdbId) => ({ tmdbId, operation: operationName,
          title: confirmed.find((record) => record.selectedTmdbId === tmdbId)?.title || `TMDB ${tmdbId}`,
          error: summary.errors?.join(" ") || "Trakt could not save this film.",
        }));
      });
      const { token: unusedToken, ...safeResult } = importResult;
      setResult({ ...safeResult, destination, skipped, failures }); clearImportDraft(); changePhase("result");
    } catch (writeError) {
      if (!isActive()) return;
      setError(`${writeError.message || "The import could not be saved."} Completed saves were kept; retrying is safe.`); changePhase("review");
    }
  };

  if (!isOpen || suspended || authLoading) return null;
  return <div className="movie-import-backdrop" style={viewportStyle} onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section ref={dialogRef} className="movie-import-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="movie-import-topbar"><div><h2 id={titleId}>Import movies</h2><p id={descriptionId}>Match films, review your selections, then choose where to save them.</p></div><button type="button" className="watch-data-icon-button" onClick={onClose} disabled={busy} aria-label="Close movie import"><CloseIcon /></button></div>
      <div className="movie-import-destination">
        <label htmlFor={`${titleId}-destination`}>Destination</label>
        <select ref={firstFieldRef} id={`${titleId}-destination`} value={destination} disabled={busy || phase === "result"} onChange={(event) => { setDestination(event.target.value); setError(""); }}>
          <option value="native">London Screening Watchlist</option><option value="trakt">Trakt</option>
        </select>
        <p>{destination === "native" ? "Add selected films to your London Screening Watchlist. Ratings and watched history are not imported. No Trakt account is needed." : "Import watchlist films, ratings and watched history to your connected Trakt account. Rated films are marked watched, as in the existing importer."}</p>
        {destination === "native" && nativeUserId && <p className="movie-import-account">Saving to: {nativeUserLabel || "your London Screening account"}</p>}
        {!ready && <button type="button" className="movie-import-secondary" disabled={busy || (destination === "trakt" && traktConnecting)} onClick={preserveForAuthentication}>{destination === "native" ? "Log in / Sign up" : traktConnecting ? "Connecting…" : "Connect Trakt"}</button>}
      </div>
      {error && <div className="movie-import-error" role="alert">{error}</div>}
      {phase === "input" && <div className="movie-import-input">
        <label><span>Paste one movie per line</span><textarea value={text} onChange={(event) => setText(event.target.value)} rows="9" placeholder={"Alien\nHeat (1995)\nDune: Part Two, 8/10"} /></label>
        <div className="movie-import-divider"><span>or upload</span></div>
        <label className="movie-import-file"><span>CSV, TSV, text, IMDb CSV, or Letterboxd ZIP</span><input type="file" accept=".csv,.tsv,.txt,.zip,text/csv,text/tab-separated-values,application/zip" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
        <p className="movie-import-help">Optional years and ratings are supported. {destination === "native" ? "Rated-only films start unselected; you can deliberately add them during review." : "Ratings are converted to Trakt’s 1–10 scale."}</p>
        <div className="movie-import-actions"><button type="button" className="movie-import-secondary" onClick={onClose}>Cancel</button><button type="button" className="movie-import-primary" onClick={processInput}>Match movies</button></div>
      </div>}
      {phase === "matching" && <div className="movie-import-progress" role="status"><div className="spinner" />Matching movies…{progress.total > 0 && ` ${progress.completed} / ${progress.total}`}</div>}
      {(phase === "review" || phase === "writing") && <div className="movie-import-review">
        <div className="movie-import-counts" aria-label="Import match summary">{Object.entries(counts).map(([label, count]) => <span key={label}><strong>{count}</strong>{label === "ambiguous" ? "need review" : label}</span>)}</div>
        <p className="movie-import-review-note">{confirmed.length} unique films selected for {destinationLabel(destination)} · {skipped} source rows skipped. {destination === "native" && "Select rated-only films individually if you want them on your watchlist."}</p>
        {destination === "trakt" && ratingConflictCount > 0 && <div className="movie-import-error" role="alert">{ratingConflictCount} row(s) have invalid or conflicting ratings and will be skipped in Trakt.</div>}
        <ul className="movie-import-list">{sortedRecords.slice(reviewPage * 100, (reviewPage + 1) * 100).map((record) => <ReviewRow key={record.clientId} record={record} destination={destination} disabled={phase === "writing"} onSelectionChange={updateSelection} />)}</ul>
        {sortedRecords.length > 100 && <div className="movie-import-pagination">
          <button type="button" className="movie-import-secondary" disabled={busy || reviewPage === 0} onClick={() => setReviewPage((page) => page - 1)}>Previous films</button>
          <span>Showing {reviewPage * 100 + 1}–{Math.min((reviewPage + 1) * 100, sortedRecords.length)} of {sortedRecords.length}</span>
          <button type="button" className="movie-import-secondary" disabled={busy || (reviewPage + 1) * 100 >= sortedRecords.length} onClick={() => setReviewPage((page) => page + 1)}>Next films</button>
        </div>}
        {phase === "writing" && <div className="movie-import-saving" role="status"><progress max={Math.max(1, progress.total)} value={progress.completed} />Saving to {destinationLabel(destination)}: {progress.completed} / {progress.total}</div>}
        <div className="movie-import-actions sticky"><button type="button" className="movie-import-secondary" onClick={() => changePhase("input")} disabled={phase === "writing"}>Back</button><button type="button" className="movie-import-primary" onClick={writeImport} disabled={!confirmed.length || phase === "writing" || (destination === "trakt" && traktConnecting)}>{phase === "writing" ? "Saving…" : !ready ? destination === "native" ? "Log in to continue" : "Connect Trakt to continue" : `Confirm ${confirmed.length} film${confirmed.length === 1 ? "" : "s"} to ${destinationLabel(destination)}`}</button></div>
      </div>}
      {phase === "result" && result && <div className="movie-import-complete"><h3>Import results</h3><ResultSummary result={result} /><div className="movie-import-actions"><button type="button" className="movie-import-secondary" onClick={() => { setResult(null); changePhase("review"); }}>Review / retry</button><button type="button" className="movie-import-secondary" onClick={() => { setResult(null); setRecords([]); setText(""); setFile(null); changePhase("input"); }}>Import more</button><button type="button" className="movie-import-primary" onClick={onClose}>Done</button></div></div>}
    </section>
  </div>;
}
