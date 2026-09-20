import { useId, useMemo, useState } from "react";
import { londonDateHeading, londonTime, isToday } from "./time.js";
import ScreeningPoster from "./ScreeningPoster.jsx";
import { groupScreeningsByMovie } from "./movieGrouping.js";
import { getScreeningDisplayChips } from "./screeningPresentation.js";
import { formatRuntime, resolveMovieDetails } from "./movieDetails.js";
import { getMovieTrailerUrl } from "./movieTrailer.js";

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

function ExpandedScreening({ screening }) {
  const soldOut =
    screening.sold_out === true ||
    screening.availability_status === "sold_out";
  const bookable = Boolean(screening.booking_url) && !soldOut;
  const chips = getScreeningDisplayChips(screening);

  const content = (
    <>
      <span className="movie-screening-time">
        {londonTime(screening.start_time)}
      </span>

      <span className="movie-screening-body">
        <span className="movie-screening-cinema">{screening.cinema_name}</span>

        {(chips.length > 0 || soldOut) && (
          <span className="s-meta">
            {chips.map((chip) => (
              <span key={chip.key} className="chip">
                {chip.label}
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
    <div
      className={`movie-screening${soldOut ? " sold-out" : " unavailable"}`}
    >
      {content}
    </div>
  );
}

function MovieDetailSummary({ details, trailerUrl }) {
  const primary = [];
  const runtime = formatRuntime(details.runtimeMinutes);

  if (details.releaseYear) primary.push(String(details.releaseYear));
  if (runtime) primary.push(runtime);
  if (details.genres.length > 0) primary.push(details.genres.join(", "));

  const hasPrimary = primary.length > 0;
  const hasDirectors = details.directors.length > 0;
  const hasCertification = Boolean(details.ukCertification);

  if (!hasPrimary && !hasDirectors && !hasCertification && !trailerUrl) return null;

  return (
    <div className="movie-detail-summary">
      {(hasPrimary || hasCertification) && (
        <div className="movie-detail-primary">
          {hasPrimary && <span>{primary.join(" · ")}</span>}
          {hasCertification && (
            <span
              className="movie-certification-badge"
              title="UK theatrical certification"
            >
              {details.ukCertification}
            </span>
          )}
        </div>
      )}

      {hasDirectors && (
        <div className="movie-detail-directors">
          {details.directors.length === 1 ? "Director" : "Directors"}:{" "}
          {details.directors.join(", ")}
        </div>
      )}
      {trailerUrl && (
        <a
          className="movie-trailer-link"
          href={trailerUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Watch trailer on YouTube (opens in a new tab)"
        >
          Trailer <span aria-hidden="true">↗</span>
        </a>
      )}
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
  const artworkScreening = group.screenings.find(
    (screening) => screening.verified_artwork_url
  );
  const verifiedArtworkUrl = artworkScreening?.verified_artwork_url ?? null;
  const peerVerifiedArtworkUrls = [
    ...new Set(
      group.screenings.flatMap(
        (screening) => screening.peer_verified_artwork_urls ?? []
      )
    ),
  ];

  const details =
    group.screenings.find((screening) => screening.shared_movie_details)
      ?.shared_movie_details ??
    resolveMovieDetails(group.movie, group.screenings);

  return (
    <div className="movie-group">
      <button
        className="movie-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((current) => !current)}
      >
        <ScreeningPoster
          movie={group.movie}
          verifiedArtworkUrl={verifiedArtworkUrl}
          peerVerifiedArtworkUrls={peerVerifiedArtworkUrls}
          className="movie-summary-poster"
        />

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
        <div className="movie-expanded" id={regionId}>
          <MovieDetailSummary
            details={details}
            trailerUrl={getMovieTrailerUrl(group.movie)}
          />

          <div className="movie-screenings">
            {group.screenings.map((screening) => (
              <ExpandedScreening key={screening.id} screening={screening} />
            ))}
          </div>
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
