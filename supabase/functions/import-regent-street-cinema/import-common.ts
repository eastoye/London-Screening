export const BASE_URL = "https://www.regentstreetcinema.com";
export const GRAPHQL_URL = `${BASE_URL}/graphql`;
export const SITE_ID = "85";
export const IMGIX_URL = "https://indy-systems.imgix.net";
const NOW_PLAYING_URL = `${BASE_URL}/now-playing/`;
const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

export interface RegentBadge {
  id: string;
  displayName: string;
  title: string;
  description: string | null;
}

export interface RegentMovie {
  id: string;
  name: string;
  urlSlug: string | null;
  duration: number | null;
  directedBy: string | null;
  countryOfOrigin: string | null;
  releaseDate: string | null;
  posterImage: string | null;
  tmdbId: string | null;
  genre: string | null;
  rating: string | null;
  showingBadges: RegentBadge[];
}

export interface RegentScreen {
  id: string;
  name: string;
  reservedSeating: boolean;
  seatCount: number | null;
}

export interface RegentShowing {
  id: string;
  time: string;
  published: boolean;
  private: boolean;
  isPreview: boolean;
  seatsRemaining: number | null;
  showingBadges: RegentBadge[];
  additionalShowingBadges: RegentBadge[];
  screen: RegentScreen | null;
}

interface GraphqlPayload<T> {
  data?: T;
  error?: { message?: string };
  errors?: Array<{ message?: string }>;
}

interface MovieListResponse {
  currentAndUpcomingMovies: {
    count: number;
    data: RegentMovie[];
  };
}

type ShowingBatchResponse = Record<string, {
  count: number;
  data: RegentShowing[];
}>;

const MOVIES_QUERY = `query RegentMovies {
  currentAndUpcomingMovies {
    count
    data {
      id
      name
      urlSlug
      duration
      directedBy
      countryOfOrigin
      releaseDate
      posterImage
      tmdbId
      genre
      rating
      showingBadges { id displayName title description }
    }
  }
}`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function graphql<T>(query: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Client-Type": "consumer",
          "Site-Id": SITE_ID,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`Regent GraphQL HTTP ${response.status}`);
      const payload = await response.json() as GraphqlPayload<T>;
      const apiMessage = payload.error?.message
        ?? payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
      if (apiMessage) throw new Error(`Regent GraphQL: ${apiMessage}`);
      if (!payload.data) throw new Error("Regent GraphQL returned no data");
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}


async function publicHtml(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      const html = await response.text();
      if (html.length < 5_000) throw new Error(`${url} returned an unexpectedly small page (${html.length} bytes)`);
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function londonIso(year: number, month: number, day: number, hour: number, minute: number): string {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(probe);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(probe.getTime() - (represented - probe.getTime())).toISOString();
}

function parsePublicPageShowings(movie: RegentMovie, html: string, now: Date): RegentShowing[] {
  const rows: RegentShowing[] = [];
  const pattern = /href="https:\/\/www\.regentstreetcinema\.com\/checkout\/showing\/[^"/]+\/(\d+)"[^>]*>\s*([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/gi;
  for (const match of html.matchAll(pattern)) {
    const id = match[1];
    const month = MONTHS[match[2].slice(0, 3)];
    const day = Number(match[3]);
    if (!month || !Number.isInteger(day)) continue;
    let year = now.getUTCFullYear();
    if (month <= 2 && now.getUTCMonth() + 1 >= 11) year += 1;
    let hour = Number(match[4]);
    const minute = Number(match[5]);
    if (match[6].toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (match[6].toLowerCase() === "am" && hour === 12) hour = 0;
    rows.push({
      id,
      time: londonIso(year, month, day, hour, minute),
      published: true,
      private: false,
      isPreview: false,
      seatsRemaining: null,
      showingBadges: [],
      additionalShowingBadges: [],
      screen: null,
    });
  }
  return rows;
}

async function publicPageCoverage(movies: RegentMovie[]): Promise<Array<{ movie: RegentMovie; showing: RegentShowing }>> {
  const listHtml = await publicHtml(NOW_PLAYING_URL);
  const slugs = [...new Set(
    [...listHtml.matchAll(/href="https:\/\/www\.regentstreetcinema\.com\/movie\/([^"?#]+)"/gi)]
      .map((match) => match[1].replace(/\/$/, "")),
  )];
  if (slugs.length < 10) throw new Error(`Regent public programme discovery was unexpectedly small (${slugs.length} movie pages)`);

  const bySlug = new Map(
    movies
      .filter((movie) => movie.urlSlug?.trim())
      .map((movie) => [movie.urlSlug!.trim().replace(/\/$/, ""), movie] as const),
  );
  const targets = slugs
    .map((slug) => ({ slug, movie: bySlug.get(slug) }))
    .filter((item): item is { slug: string; movie: RegentMovie } => Boolean(item.movie));

  const rows: Array<{ movie: RegentMovie; showing: RegentShowing }> = [];
  const PAGE_BATCH_SIZE = 20;
  const now = new Date();
  for (let offset = 0; offset < targets.length; offset += PAGE_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + PAGE_BATCH_SIZE);
    const pages = await Promise.all(batch.map(async ({ slug, movie }) => ({
      movie,
      html: await publicHtml(`${BASE_URL}/movie/${encodeURIComponent(slug)}`),
    })));
    for (const page of pages) {
      for (const showing of parsePublicPageShowings(page.movie, page.html, now)) {
        rows.push({ movie: page.movie, showing });
      }
    }
  }
  return rows;
}

function showingBatchQuery(movies: RegentMovie[]): string {
  const selections = movies.map((movie, index) => {
    if (!/^\d+$/.test(movie.id)) throw new Error(`Invalid Regent movie ID: ${movie.id}`);
    return `m${index}: publicShowingsForMovie(movieId: ${movie.id}) {
      count
      data {
        id
        time
        published
        private
        isPreview
        seatsRemaining
        showingBadges { id displayName title description }
        additionalShowingBadges { id displayName title description }
        screen { id name reservedSeating seatCount }
      }
    }`;
  });
  return `query RegentShowings { ${selections.join("\n")} }`;
}

export async function fetchRegentProgramme(): Promise<Array<{
  movie: RegentMovie;
  showing: RegentShowing;
}>> {
  const movieResult = (await graphql<MovieListResponse>(MOVIES_QUERY)).currentAndUpcomingMovies;
  if (!movieResult || !Array.isArray(movieResult.data)) {
    throw new Error("Regent movie catalogue was missing");
  }
  if (movieResult.count !== movieResult.data.length) {
    throw new Error(`Incomplete Regent movie catalogue (${movieResult.data.length}/${movieResult.count})`);
  }
  if (movieResult.data.length < 10 || movieResult.data.length > 400) {
    throw new Error(`Unexpected Regent movie catalogue size (${movieResult.data.length})`);
  }

  const programme: Array<{ movie: RegentMovie; showing: RegentShowing }> = [];
  const BATCH_SIZE = 20;
  for (let offset = 0; offset < movieResult.data.length; offset += BATCH_SIZE) {
    const movies = movieResult.data.slice(offset, offset + BATCH_SIZE);
    const response = await graphql<ShowingBatchResponse>(showingBatchQuery(movies));
    for (let index = 0; index < movies.length; index++) {
      const list = response[`m${index}`];
      if (!list || !Array.isArray(list.data)) {
        throw new Error(`Missing showings for Regent movie ${movies[index].id}`);
      }
      if (list.count !== list.data.length) {
        throw new Error(`Incomplete showings for Regent movie ${movies[index].id} (${list.data.length}/${list.count})`);
      }
      for (const showing of list.data) programme.push({ movie: movies[index], showing });
    }
  }

  // GraphQL remains the primary structured source. Regent's public pages can
  // expose valid showings that publicShowingsForMovie temporarily omits, so
  // merge only missing performance IDs from the proven public-page source.
  const seenShowingIds = new Set(programme.map(({ showing }) => showing.id));
  const fallbackRows = await publicPageCoverage(movieResult.data);
  for (const row of fallbackRows) {
    if (seenShowingIds.has(row.showing.id)) continue;
    programme.push(row);
    seenShowingIds.add(row.showing.id);
  }

  return programme;
}

export function eventUrl(movie: RegentMovie): string {
  const identifier = movie.urlSlug?.trim() || movie.id;
  return `${BASE_URL}/movie/${encodeURIComponent(identifier)}`;
}

export function bookingUrl(movie: RegentMovie, showing: RegentShowing): string {
  const slug = movie.urlSlug?.trim();
  return slug
    ? `${BASE_URL}/checkout/showing/${encodeURIComponent(slug)}/${showing.id}`
    : `${BASE_URL}/checkout/showing/${showing.id}`;
}

export function artworkUrl(movie: RegentMovie): string | null {
  if (!movie.posterImage?.trim()) return null;
  return `${IMGIX_URL}/${encodeURIComponent(movie.posterImage.trim())}?fit=crop&w=1000&h=1500&fm=jpeg&auto=format,compress&cs=origin`;
}
