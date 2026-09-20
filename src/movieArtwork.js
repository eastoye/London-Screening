function titleKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanUrl(value) {
  const url = String(value ?? "").trim();
  return url || null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// Add client-side fallback artwork from other screenings that are linked to
// the same movie record. Exact public-title matches are preferred before other
// screenings of the same movie.
export function addSharedMovieArtwork(screenings) {
  const artworkByMovieId = new Map();

  for (const screening of screenings) {
    const movieId = String(screening.movie_id ?? "").trim();
    const artworkUrl = cleanUrl(screening.verified_artwork_url);

    if (!movieId || !artworkUrl) continue;

    const entries = artworkByMovieId.get(movieId) ?? [];
    entries.push({
      url: artworkUrl,
      titleKey: titleKey(screening.movie_title),
    });
    artworkByMovieId.set(movieId, entries);
  }

  return screenings.map((screening) => {
    const movieId = String(screening.movie_id ?? "").trim();
    if (!movieId) {
      return { ...screening, peer_verified_artwork_urls: [] };
    }

    const ownUrl = cleanUrl(screening.verified_artwork_url);
    const ownTitleKey = titleKey(screening.movie_title);
    const entries = artworkByMovieId.get(movieId) ?? [];

    const exactTitleUrls = entries
      .filter((entry) => entry.titleKey === ownTitleKey && entry.url !== ownUrl)
      .map((entry) => entry.url);

    const otherMovieUrls = entries
      .filter((entry) => entry.titleKey !== ownTitleKey && entry.url !== ownUrl)
      .map((entry) => entry.url);

    return {
      ...screening,
      peer_verified_artwork_urls: unique([
        ...exactTitleUrls,
        ...otherMovieUrls,
      ]),
    };
  });
}
