import { useId, useMemo, useState } from "react";
import { londonDateHeading, londonTime, isToday } from "./time.js";
import { posterUrl } from "./posterUrl.js";
import { groupScreeningsByMovie } from "./movieGrouping.js";

function Poster({ movie }) {
  const posterPath =
    movie && movie.match_status === "matched" ? movie.poster_path : null;
  const url = posterUrl(posterPath);

  if (url) {
    return (
      <img
        className="poster movie-summary-poster"
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className="poster poster-placeholder movie-summary-poster"
      aria-hidden="true"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    </div>
  );
}

function ExpandIcon({ expanded }) {
  return (
    <svg
      className={`movie-summary-chevron${expanded ? " expanded" : ""}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function formatLabels(screening) {
  const labels = screening.format
    ? screening.format
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  for (const value of screening.projection_formats ?? []) {
    const label = value === "imax" ? "IMAX" : value;
    if (!labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
      labels.push(label);
    }
  }

  return labels;
}

function ExpandedScreening({ screening }) {
  const soldOut =
    screening.sold_out === true ||
    screening.availability_status === "sold_out";
  const bookable = Boolean(screening.booking_url) && !soldOut;
  const formats = formatLabels(screening);

  const content = (
    <>
      <span className="movie-screening-time">
        {londonTime(screening.start_time)}
      </span>

      <span className="movie-screening-body">
        <span className="movie-screening-cinema">{screening.cinema_name}</span>

        {(formats.length > 0 || soldOut) && (
          <span className="s-meta">
            {formats.map((format) => (
              <span key={format} className="chip">
                {format}
              </span>
            ))}
            {soldOut && <span className="sold-badge">Sold out</span>}
          </span>
        )}
      </span>

      <span className="movie-screening-cta">
        {bookable ? (
          <>
            <span>Book</span>
            <BookIcon />
          </>
        ) : soldOut ? (
          <span>—</span>
        ) : null}
      </span>
    </>
  );

  if (bookable) {
    return (
      <a
        className="movie-screening"
        href={screening.booking_url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <div className={`movie-screening${soldOut ? " sold-out" : ""}`}>
      {content}
    </div>
  );
}

function MovieGroup({ group, ratingsByTmdbId }) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  const tmdbId = Number(group.movie?.tmdb_id);
  const userRating =
    Number.isInteger(tmdbId) && tmdbId > 0
      ? ratingsByTmdbId?.get(tmdbId)
      : undefined;
  const screeningCount = group.screenings.length;

  return (
    <div className="movie-group">
      <button
        className="movie-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((current) => !current)}
      >
        <Poster movie={group.movie} />

        <span className="movie-summary-body">
          <span className="movie-summary-title">{group.title}</span>

          <span className="movie-summary-meta">
            {Number.isInteger(userRating) && (
              <span className="rating-badge" title="Your Trakt rating">
                ★ {userRating}/10
              </span>
            )}

            <span>
              {screeningCount} screening{screeningCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {group.cinemaCount} cinema{group.cinemaCount === 1 ? "" : "s"}
            </span>
          </span>
        </span>

        <ExpandIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="movie-screenings" id={regionId}>
          {group.screenings.map((screening) => (
            <ExpandedScreening key={screening.id} screening={screening} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function MovieDayGroup({
  dateKey,
  screenings,
  ratingsByTmdbId,
}) {
  const groups = useMemo(
    () => groupScreeningsByMovie(screenings),
    [screenings]
  );
  const heading = londonDateHeading(screenings[0].start_time);
  const today = isToday(screenings[0].start_time);

  return (
    <section className="day-group" data-date={dateKey}>
      <h2 className={`day-heading${today ? " today" : ""}`}>{heading}</h2>

      {groups.map((group) => (
        <MovieGroup
          key={group.key}
          group={group}
          ratingsByTmdbId={ratingsByTmdbId}
        />
      ))}
    </section>
  );
}
