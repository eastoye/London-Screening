import { londonTime, londonDateHeading, isToday } from "./time.js";
import { posterUrl } from "./posterUrl.js";

function ChevronIcon() {
  return (
    <svg
      className="s-cta-icon"
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

function Poster({ movie }) {
  const posterPath =
    movie && movie.match_status === "matched" ? movie.poster_path : null;
  const url = posterUrl(posterPath);

  if (url) {
    return (
      <img
        className="poster"
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div className="poster poster-placeholder" aria-hidden="true">
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

export default function ScreeningRow({ screening, userRating }) {
  const soldOut = screening.sold_out === true;
  const bookable = Boolean(screening.booking_url) && !soldOut;
  const movie = screening.movies;

  const formats = screening.format
    ? screening.format
        .split(",")
        .map((format) => format.trim())
        .filter(Boolean)
    : [];

  const content = (
    <>
      <Poster movie={movie} />
      <span className="s-time">{londonTime(screening.start_time)}</span>

      <span className="s-body">
        <span className="s-title">{screening.movie_title}</span>
        <span className="s-cinema">{screening.cinema_name}</span>

        <span className="s-meta">
          {Number.isInteger(userRating) && (
            <span className="rating-badge" title="Your Trakt rating">
              ★ {userRating}/10
            </span>
          )}

          {formats.map((format) => (
            <span key={format} className="chip">
              {format}
            </span>
          ))}

          {soldOut && <span className="sold-badge">Sold out</span>}
        </span>
      </span>

      <span className="s-cta">
        {bookable ? (
          <>
            <span className="s-cta-text">Book</span>
            <ChevronIcon />
          </>
        ) : soldOut ? (
          <span className="s-cta-text">—</span>
        ) : (
          ""
        )}
      </span>
    </>
  );

  if (bookable) {
    return (
      <a
        className="screening"
        href={screening.booking_url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="screening sold-out" aria-disabled="true">
      {content}
    </div>
  );
}

export function DayGroup({ dateKey, screenings, ratingsByTmdbId }) {
  const heading = londonDateHeading(screenings[0].start_time);
  const today = isToday(screenings[0].start_time);

  return (
    <section className="day-group" data-date={dateKey}>
      <h2 className={`day-heading${today ? " today" : ""}`}>{heading}</h2>

      {screenings.map((screening) => {
        const tmdbId = Number(screening.movies?.tmdb_id);
        const userRating =
          Number.isInteger(tmdbId) && tmdbId > 0
            ? ratingsByTmdbId?.get(tmdbId)
            : undefined;

        return (
          <ScreeningRow
            key={screening.id}
            screening={screening}
            userRating={userRating}
          />
        );
      })}
    </section>
  );
}