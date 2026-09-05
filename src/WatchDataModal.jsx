import { useEffect, useId, useRef, useState } from "react";
import "./WatchDataModal.css";

const TRAKT_JOIN_URL = "https://trakt.tv/auth/join";
const TRAKT_SIGN_IN_URL = "https://trakt.tv/auth/signin";
const IMDB_RATINGS_URL = "https://www.imdb.com/list/ratings/";
const IMDB_WATCHLIST_URL = "https://www.imdb.com/list/watchlist/";
const LETTERBOXD_EXPORT_URL = "https://letterboxd.com/settings/data/";

const SERVICES = [
  {
    id: "imdb",
    name: "IMDb",
  },
  {
    id: "letterboxd",
    name: "Letterboxd",
  },
  {
    id: "other",
    name: "Other",
  },
];

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function ExternalLink({ href, children, className = "" }) {
  return (
    <a
      className={`watch-data-link${className ? ` ${className}` : ""}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span>{children}</span>
      <ArrowIcon />
    </a>
  );
}

function ImdbInstructions() {
  return (
    <div className="watch-data-service-copy">
      <p>
        IMDb stores ratings and watchlist entries separately, so export both
        files if you use both.
      </p>

      <ol>
        <li>
          Open your ratings, select the three-dot <strong>Actions</strong>{" "}
          menu, then select <strong>Export</strong>.
        </li>
        <li>
          Open your watchlist and export it separately.
        </li>
        <li>Keep both downloaded CSV files.</li>
      </ol>

      <div className="watch-data-link-row">
        <ExternalLink href={IMDB_RATINGS_URL}>Open IMDb ratings</ExternalLink>
        <ExternalLink href={IMDB_WATCHLIST_URL}>
          Open IMDb watchlist
        </ExternalLink>
      </div>
    </div>
  );
}

function LetterboxdInstructions() {
  return (
    <div className="watch-data-service-copy">
      <ol>
        <li>Sign in to Letterboxd and open its data settings.</li>
        <li>
          Select <strong>Export Data</strong>.
        </li>
        <li>Download the export when it is ready.</li>
      </ol>

      <ExternalLink href={LETTERBOXD_EXPORT_URL}>
        Open Letterboxd data settings
      </ExternalLink>
    </div>
  );
}

function OtherInstructions() {
  return (
    <div className="watch-data-service-copy">
      <h3>Other services or lists</h3>
      <p>
        You can also import from other movie websites and lists. Copy the films
        — or simply copy the contents of a watchlist page — then paste the text
        into <strong>Import movies</strong>. London Screenings will try to
        identify possible movie titles and let you review the matches before
        importing them to Trakt.
      </p>
      <p style={{ marginTop: 10 }}>
        This can work with pages from sites such as Rotten Tomatoes, even when
        they do not provide a dedicated export. Results vary by page, and
        unrelated page text may be left unmatched. Review the matches carefully
        before importing.
      </p>
    </div>
  );
}

export default function WatchDataModal({
  isOpen,
  onClose,
  onConnectTrakt,
  isConnecting = false,
}) {
  const [view, setView] = useState("choice");
  const [service, setService] = useState("imdb");

  const dialogRef = useRef(null);
  const firstActionRef = useRef(null);
  const importHeadingRef = useRef(null);
  const previousFocusRef = useRef(null);

  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!isOpen) return undefined;

    previousFocusRef.current = document.activeElement;
    setView("choice");
    setService("imdb");

    const focusTimer = window.setTimeout(() => {
      firstActionRef.current?.focus();
    }, 0);

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

  useEffect(() => {
    if (isOpen && view === "import") {
      importHeadingRef.current?.focus();
    }
  }, [isOpen, view]);

  if (!isOpen) return null;

  const handleConnect = () => {
    onClose();
    onConnectTrakt();
  };

  const handleBackdropPointerDown = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  let serviceInstructions;

  if (service === "letterboxd") {
    serviceInstructions = <LetterboxdInstructions />;
  } else if (service === "other") {
    serviceInstructions = <OtherInstructions />;
  } else {
    serviceInstructions = <ImdbInstructions />;
  }

  return (
    <div
      className="watch-data-backdrop"
      onPointerDown={handleBackdropPointerDown}
    >
      <section
        ref={dialogRef}
        className="watch-data-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="watch-data-topbar">
          {view === "import" ? (
            <button
              className="watch-data-icon-button"
              type="button"
              onClick={() => setView("choice")}
              aria-label="Back to connection choices"
            >
              <BackIcon />
            </button>
          ) : (
            <span aria-hidden="true" />
          )}

          <button
            className="watch-data-icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close connect watch data"
          >
            <CloseIcon />
          </button>
        </div>

        {view === "choice" ? (
          <div className="watch-data-choice">
            <div className="watch-data-intro">
              <span className="watch-data-eyebrow">Optional</span>
              <h2 id={titleId}>Connect your watch data</h2>
              <p id={descriptionId}>
                Use your personal ratings and watchlist to filter London
                screenings.
              </p>
            </div>

            <div className="watch-data-choice-list">
              <button
                ref={firstActionRef}
                className="watch-data-choice-button primary"
                type="button"
                onClick={handleConnect}
                disabled={isConnecting}
              >
                <span>
                  <strong>
                    {isConnecting ? "Connecting…" : "Connect Trakt"}
                  </strong>
                  <small>I already have a Trakt account.</small>
                </span>
                <ArrowIcon />
              </button>

              <button
                className="watch-data-choice-button"
                type="button"
                onClick={() => setView("import")}
              >
                <span>
                  <strong>Import from another service</strong>
                  <small>Prepare an IMDb or Letterboxd export.</small>
                </span>
                <ArrowIcon />
              </button>
            </div>

            <p className="watch-data-privacy">
              Trakt is optional. Public cinema listings remain available
              without connecting.
            </p>
          </div>
        ) : (
          <div className="watch-data-import">
            <div className="watch-data-intro">
              <span className="watch-data-eyebrow">Import guide</span>
              <h2 id={titleId} ref={importHeadingRef} tabIndex="-1">
                Move your data to Trakt
              </h2>
              <p id={descriptionId}>
                {service === "other" ? (
                  "Copy your movie list, connect Trakt, then review and import the movies directly in London Screenings."
                ) : (
                  <>
                    Export your existing data, connect Trakt, then review and
                    import the movies directly in London Screenings.
                  </>
                )}
              </p>
            </div>

            <div className="watch-data-step">
              <span className="watch-data-step-number">1</span>
              <div className="watch-data-step-content">
                <h3>Create or sign in to Trakt</h3>
                <div className="watch-data-link-row">
                  <ExternalLink href={TRAKT_JOIN_URL}>
                    Create Trakt account
                  </ExternalLink>
                  <ExternalLink href={TRAKT_SIGN_IN_URL}>
                    Sign in to Trakt
                  </ExternalLink>
                </div>
              </div>
            </div>

            <div className="watch-data-step">
              <span className="watch-data-step-number">2</span>
              <div className="watch-data-step-content">
                <h3>
                  {service === "other"
                    ? "Copy your movie list"
                    : "Export your existing data"}
                </h3>

                <div
                  className="watch-data-service-tabs"
                  role="tablist"
                  aria-label="Choose your previous watch service"
                >
                  {SERVICES.map((item) => (
                    <button
                      key={item.id}
                      id={`watch-data-tab-${item.id}`}
                      className={
                        service === item.id ? "is-selected" : undefined
                      }
                      type="button"
                      role="tab"
                      aria-selected={service === item.id}
                      aria-controls="watch-data-service-panel"
                      onClick={() => setService(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>

                <div
                  id="watch-data-service-panel"
                  className="watch-data-service-panel"
                  role="tabpanel"
                  aria-labelledby={`watch-data-tab-${service}`}
                >
                  {serviceInstructions}
                </div>
              </div>
            </div>

            <div className="watch-data-step">
              <span className="watch-data-step-number">3</span>
              <div className="watch-data-step-content">
                <h3>Connect Trakt</h3>
                <p>
                  London Screenings needs your permission before it can add a
                  watchlist or ratings to your Trakt account.
                </p>
              </div>
            </div>

            <div className="watch-data-step">
              <span className="watch-data-step-number">4</span>
              <div className="watch-data-step-content">
                <h3>Import and review</h3>
                <p>
                  {service === "other" ? (
                    <>
                      After connecting, select <strong>Import movies</strong>,
                      paste your copied text into the text input, review the
                      matches, skip unrelated or incorrect results, and confirm
                      the changes.
                    </>
                  ) : (
                    <>
                      After connecting, select <strong>Import movies</strong>, upload
                      the export, resolve uncertain matches, and confirm the changes.
                    </>
                  )}
                </p>
              </div>
            </div>

            <button
              className="watch-data-connect-final"
              type="button"
              onClick={handleConnect}
              disabled={isConnecting}
            >
              {isConnecting
                ? "Connecting…"
                : "Connect Trakt to continue"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
