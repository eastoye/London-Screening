import { useEffect, useId, useMemo, useRef, useState } from "react";
import { deduplicateBeforeMatching, deduplicateConfirmed } from "./movieImport/model.js";
import { parseTextInput } from "./movieImport/textParser.js";
import { parseImportFile } from "./movieImport/fileParser.js";
import { matchImportRecords } from "./movieImport/matcherApi.js";
import "./MovieImportModal.css";

const MAX_IMPORT_RECORDS = 3000;

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function sourceLabel(source) {
  if (source === "letterboxd") return "Letterboxd";
  if (source === "imdb") return "IMDb";
  if (source === "csv") return "CSV";
  return "Text";
}

function intentLabel(record) {
  const converted =
    record.rating &&
    record.originalRating !== null &&
    (record.ratingScale !== 10 || record.originalRating !== record.rating)
      ? `${record.originalRating}/${record.ratingScale} → ${record.rating}/10`
      : record.rating
        ? `${record.rating}/10`
        : "";

  if (record.watchlist && record.rating) return `Watchlist · Rate ${converted}`;
  if (record.rating) return `Rate ${converted}`;
  return "Watchlist";
}

function ReviewRow({ record, onSelectionChange }) {
  const matched = record.status === "matched" && record.match;
  const ambiguous = record.status === "ambiguous";

  return (
    <li className={`movie-import-row is-${record.status}`}>
      <div className="movie-import-row-source">
        <div>
          <strong>{record.title || "Untitled row"}</strong>
          {record.year && <span> ({record.year})</span>}
        </div>
        <div className="movie-import-row-meta">
          <span>{sourceLabel(record.source)}</span>
          <span>{intentLabel(record)}</span>
          {record.duplicateCount > 1 && <span>{record.duplicateCount} duplicate rows merged</span>}
        </div>
      </div>

      {matched && (
        <label className="movie-import-match-choice">
          <input
            type="checkbox"
            checked={Boolean(record.selectedTmdbId)}
            onChange={(event) =>
              onSelectionChange(record.clientId, event.target.checked ? record.match.tmdbId : null)
            }
          />
          <span>
            <strong>{record.match.title}</strong>
            {record.match.year && ` (${record.match.year})`}
            <small>{record.reason}</small>
          </span>
        </label>
      )}

      {ambiguous && (
        <label className="movie-import-candidate-select">
          <span>Choose the correct film or skip it</span>
          <select
            value={record.selectedTmdbId || ""}
            onChange={(event) =>
              onSelectionChange(record.clientId, event.target.value ? Number(event.target.value) : null)
            }
          >
            <option value="">Skip — no film selected</option>
            {(record.candidates || []).map((candidate) => (
              <option key={candidate.tmdbId} value={candidate.tmdbId}>
                {candidate.title}{candidate.year ? ` (${candidate.year})` : " (year unknown)"}
              </option>
            ))}
          </select>
          <small>{record.reason}</small>
        </label>
      )}

      {(record.status === "unmatched" || record.status === "invalid") && (
        <div className="movie-import-unresolved">
          <strong>{record.status === "invalid" ? "Invalid row" : "No match found"}</strong>
          <span>{record.invalidReason || record.reason}</span>
        </div>
      )}
    </li>
  );
}

function ResultSummary({ result }) {
  const totalFailed = result.watchlist.failed + result.ratings.failed;

  return (
    <div className="movie-import-result">
      <div className="movie-import-result-card">
        <strong>Watchlist</strong>
        <span>{result.watchlist.added} added</span>
        <span>{result.watchlist.existing} already present</span>
        <span>{result.watchlist.failed} failed</span>
      </div>
      <div className="movie-import-result-card">
        <strong>Ratings</strong>
        <span>{result.ratings.added} added</span>
        <span>{result.ratings.updated} updated</span>
        <span>{result.ratings.existing} already unchanged</span>
        <span>{result.ratings.failed} failed</span>
      </div>
      {totalFailed > 0 && (
        <p className="movie-import-result-warning">
          Successful changes were kept. Failed records can be imported again safely.
        </p>
      )}
    </div>
  );
}

export default function MovieImportModal({ isOpen, onClose, onImport }) {
  const [phase, setPhase] = useState("input");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [records, setRecords] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  const previousFocusRef = useRef(null);
  const phaseRef = useRef("input");
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (!isOpen) return undefined;

    previousFocusRef.current = document.activeElement;
    setPhase("input");
    setText("");
    setFile(null);
    setRecords([]);
    setResult(null);
    setError("");

    const focusTimer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (
        event.key === "Escape" &&
        phaseRef.current !== "matching" &&
        phaseRef.current !== "writing"
      ) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen, onClose]);

  const counts = useMemo(() => {
    const values = { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
    for (const record of records) {
      if (values[record.status] !== undefined) values[record.status] += 1;
    }
    return values;
  }, [records]);

  const confirmedWithConflicts = useMemo(
    () => deduplicateConfirmed(records.filter((record) => record.selectedTmdbId)),
    [records]
  );
  const ratingConflictCount = confirmedWithConflicts.filter(
    (record) => record.ratingConflict
  ).length;
  const confirmed = confirmedWithConflicts.filter((record) => !record.ratingConflict);

  if (!isOpen) return null;

  const processInput = async () => {
    setError("");
    setPhase("matching");

    try {
      const parsed = [...parseTextInput(text)];
      if (file) parsed.push(...(await parseImportFile(file)));
      if (!parsed.length) throw new Error("Enter at least one movie or choose an import file.");

      const deduplicated = deduplicateBeforeMatching(parsed);
      if (deduplicated.length > MAX_IMPORT_RECORDS) {
        throw new Error(`Import no more than ${MAX_IMPORT_RECORDS} unique movies at once.`);
      }

      setRecords(await matchImportRecords(deduplicated));
      setPhase("review");
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : "The import could not be processed.");
      setPhase("input");
    }
  };

  const updateSelection = (clientId, selectedTmdbId) => {
    setRecords((current) =>
      current.map((record) =>
        record.clientId === clientId ? { ...record, selectedTmdbId } : record
      )
    );
  };

  const writeToTrakt = async () => {
    setError("");
    setPhase("writing");

    try {
      const importResult = await onImport(confirmed);
      setResult(importResult);
      setPhase("result");
    } catch (writeError) {
      setError(writeError instanceof Error ? writeError.message : "Trakt could not save the import.");
      setPhase("review");
    }
  };

  const busy = phase === "matching" || phase === "writing";

  return (
    <div
      className="movie-import-backdrop"
      onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        ref={dialogRef}
        className="movie-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="movie-import-topbar">
          <div>
            <h2 id={titleId}>Import movies to Trakt</h2>
            <p id={descriptionId}>Review every match before your watchlist or ratings change.</p>
          </div>
          <button type="button" className="watch-data-icon-button" onClick={onClose} disabled={busy} aria-label="Close movie import">
            <CloseIcon />
          </button>
        </div>

        {error && <div className="movie-import-error" role="alert">{error}</div>}

        {phase === "input" && (
          <div className="movie-import-input">
            <label>
              <span>Paste one movie per line</span>
              <textarea
                ref={firstFieldRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows="9"
                placeholder={"Alien\nHeat (1995)\nDune: Part Two, 8/10"}
              />
            </label>

            <div className="movie-import-divider"><span>or upload</span></div>

            <label className="movie-import-file">
              <span>CSV, TSV, text, IMDb CSV, or Letterboxd ZIP</span>
              <input
                type="file"
                accept=".csv,.tsv,.txt,.zip,text/csv,text/tab-separated-values,application/zip"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </label>

            <p className="movie-import-help">
              Optional years and ratings are supported. Ratings are converted to Trakt’s 1–10 scale.
            </p>

            <div className="movie-import-actions">
              <button type="button" className="movie-import-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="movie-import-primary" onClick={processInput}>Match movies</button>
            </div>
          </div>
        )}

        {phase === "matching" && (
          <div className="movie-import-progress" role="status">
            <div className="spinner" />
            Matching movies without writing to Trakt…
          </div>
        )}

        {(phase === "review" || phase === "writing") && (
          <div className="movie-import-review">
            <div className="movie-import-counts" aria-label="Import match summary">
              <span><strong>{counts.matched}</strong> matched</span>
              <span><strong>{counts.ambiguous}</strong> need review</span>
              <span><strong>{counts.unmatched}</strong> unmatched</span>
              <span><strong>{counts.invalid}</strong> invalid</span>
            </div>

            {ratingConflictCount > 0 && (
              <div className="movie-import-error" role="alert">
                {ratingConflictCount} duplicate movie{ratingConflictCount === 1 ? " has" : "s have"} conflicting ratings and will be skipped.
              </div>
            )}

            <ul className="movie-import-list">
              {records.map((record) => (
                <ReviewRow key={record.clientId} record={record} onSelectionChange={updateSelection} />
              ))}
            </ul>

            <div className="movie-import-actions sticky">
              <button type="button" className="movie-import-secondary" onClick={() => setPhase("input")} disabled={phase === "writing"}>Back</button>
              <button type="button" className="movie-import-primary" onClick={writeToTrakt} disabled={!confirmed.length || phase === "writing"}>
                {phase === "writing" ? "Saving to Trakt…" : `Confirm ${confirmed.length} movie${confirmed.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}

        {phase === "result" && result && (
          <div className="movie-import-complete">
            <h3>Import complete</h3>
            <ResultSummary result={result} />
            <div className="movie-import-actions">
              <button type="button" className="movie-import-secondary" onClick={() => setPhase("input")}>Import more</button>
              <button type="button" className="movie-import-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
