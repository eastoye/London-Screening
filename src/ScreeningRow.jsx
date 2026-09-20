import { londonTime, londonDateHeading, isToday } from "./time.js";
import ScreeningPoster from "./ScreeningPoster.jsx";
import { getScreeningDisplayChips } from "./screeningPresentation.js";

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

export default function ScreeningRow({ screening, userRating }) {
  const soldOut =
    screening.sold_out === true || screening.availability_status === "sold_out";
  const bookable = Boolean(screening.booking_url) && !soldOut;
  const movie = screening.movies;
  const chips = getScreeningDisplayChips(screening);
  const hasMeta = Number.isInteger(userRating) || chips.length > 0 || soldOut;

  const content = (
    <>
      <ScreeningPoster
        movie={movie}
        verifiedArtworkUrl={screening.verified_artwork_url}
        peerVerifiedArtworkUrls={screening.peer_verified_artwork_urls}
      />
      <span className="s-time">{londonTime(screening.start_time)}</span>

      <span className="s-body">
        <span className="s-title">{screening.movie_title}</span>
        <span className="s-cinema">{screening.cinema_name}</span>

        {hasMeta && (
          <span className="s-meta">
            {Number.isInteger(userRating) && (
              <span className="rating-badge" title="Your Trakt rating">
                ★ {userRating}/10
              </span>
            )}

            {chips.map((chip) => (
              <span key={chip.key} className="chip">
                {chip.label}
              </span>
            ))}

            {soldOut && <span className="sold-badge">Sold out</span>}
          </span>
        )}
      </span>

      <span className="s-cta">
        {bookable ? (
          <>
            <span className="s-cta-text">Book</span>
            <ChevronIcon />
          </>
        ) : soldOut ? (
          <span className="s-cta-text">—</span>
        ) : null}
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
    <div
      className={`screening${soldOut ? " sold-out" : " unavailable"}`}
      aria-disabled="true"
    >
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
