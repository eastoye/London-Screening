import CryptoJS from "npm:crypto-js@4.2.0";
import { londonToUtc } from "../_shared/importSafety.ts";

export const CINEMA_NAME = "Metro Cinema";
export const SITE_ORIGIN = "https://www.metrocinema.co.uk";
const LOCATION_ID = "4";
const LOCATION_SLUG = "metro-cinema";
const WIDGET_ID = "movie_calendar";
const EXTERNAL_URL = `${SITE_ORIGIN}/api/external`;
const CINESYNC_PASSPHRASE = "ascvdWD34_GKIbnDVBONKE23GZLpMgA34567890";

export interface CineSyncTag {
  id?: string | number;
  name?: string | null;
  short_name?: string | null;
  description?: string | null;
  type?: string | null;
}

export interface NamedValue {
  name?: string | null;
}

export interface CineSyncShowtime {
  show_time_id?: string | number | null;
  show_time_uuid?: string | null;
  page_link?: string | null;
  session_start_date?: string | null;
  show_time_hours?: string | null;
  time_sorting?: number | string | null;
  sold_out?: boolean | null;
  sold_out_text?: string | null;
  screen_name?: string | null;
  screen_tags?: CineSyncTag[] | null;
  show_times_tags?: CineSyncTag[] | null;
  member_only?: boolean | null;
  subscriber_only?: boolean | null;
  seat_plan_status?: string | null;
  theater_experience_name?: string | null;
  is_this_sold_by_third_party_system?: string | null;
  third_party_system_url?: string | null;
}

export interface CineSyncMovie {
  movie_id?: string | number | null;
  type?: string | null;
  movie_name?: string | null;
  url_key?: string | null;
  movie_year?: string | number | null;
  date_release_date?: string | null;
  duration?: string | number | null;
  directed_by?: NamedValue[] | null;
  movie_countries?: string | null;
  page_link?: string | null;
  portrait_image?: string | null;
  landscape_image?: string | null;
  is_booking_open?: boolean | null;
  movie_tags?: CineSyncTag[] | null;
  show_times?: CineSyncShowtime[] | null;
}

export interface ProgrammeResult {
  dates: string[];
  movies: CineSyncMovie[];
}

function encryptPayload(data: unknown): string {
  return CryptoJS.AES.encrypt(JSON.stringify({
    endpoint: "cms_widget/index",
    method: "POST",
    data,
    headers: {},
    langId: "",
  }), CINESYNC_PASSPHRASE).toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cineSyncRequest(data: unknown): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(EXTERNAL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)",
        },
        body: JSON.stringify({ payload: encryptPayload(data) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Metro CineSync HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.status !== true || !payload?.data || typeof payload.data !== "object") {
        throw new Error(`Metro CineSync returned an invalid response: ${JSON.stringify(payload).slice(0, 500)}`);
      }
      return payload.data as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const commonRequest = {
  sales_channel_id: 1,
  cinema_location_id: LOCATION_ID,
  widget_id: WIDGET_ID,
};

async function moviesForDate(sessionDate: string): Promise<CineSyncMovie[]> {
  const movies: CineSyncMovie[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await cineSyncRequest({
      ...commonRequest,
      api: "list",
      session_date: sessionDate,
      has_limit: 0,
      per_page: 100,
      page_number: page,
      url_key: "",
      theater_experiance: "",
      group_to_theater_experiance: false,
      sort_by: "showtime",
    });
    if (!Array.isArray(data.movies)) {
      throw new Error(`Metro CineSync list was incomplete for ${sessionDate}`);
    }
    movies.push(...data.movies as CineSyncMovie[]);
    const reportedPages = Number(data.total_pages ?? 1);
    totalPages = Number.isInteger(reportedPages) && reportedPages > 0 ? reportedPages : 1;
    if (totalPages > 10) throw new Error(`Unexpected Metro pagination (${totalPages} pages)`);
    page++;
  } while (page <= totalPages);
  if (movies.length === 0) throw new Error(`Metro CineSync returned no films for ${sessionDate}`);
  return movies;
}

export async function fetchProgramme(): Promise<ProgrammeResult> {
  const dateData = await cineSyncRequest({
    ...commonRequest,
    api: "dates",
    page_number: "1",
    url_key: "",
    calendar_date_picker_option: "1",
  });
  const dates = [...new Set((Array.isArray(dateData.dates) ? dateData.dates : [])
    .map((item: unknown) => (item as { session_start_date?: unknown })?.session_start_date)
    .filter((value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)))];
  if (dates.length === 0 || dates.length > 45) {
    throw new Error(`Unexpected Metro programme date count (${dates.length})`);
  }

  const movies: CineSyncMovie[] = [];
  for (let index = 0; index < dates.length; index += 6) {
    const batch = await Promise.all(dates.slice(index, index + 6).map(moviesForDate));
    for (const result of batch) movies.push(...result);
  }
  return { dates, movies };
}

export function startTime(show: CineSyncShowtime): string | null {
  const epoch = Number(show.time_sorting);
  if (Number.isFinite(epoch) && epoch > 1_000_000_000) {
    const date = new Date(epoch * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = show.session_start_date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = show.show_time_hours?.match(/^(\d{1,2})[.:](\d{2})$/);
  if (!date || !time) return null;
  return londonToUtc(Number(date[1]), Number(date[2]), Number(date[3]), Number(time[1]), Number(time[2])).toISOString();
}

export function absoluteUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, SITE_ORIGIN);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function eventUrl(movie: CineSyncMovie): string | null {
  return absoluteUrl(movie.page_link)
    ?? (movie.url_key ? `${SITE_ORIGIN}/movies/${encodeURIComponent(movie.url_key)}` : null);
}

export function bookingUrl(movie: CineSyncMovie, show: CineSyncShowtime): string | null {
  if (show.is_this_sold_by_third_party_system === "1") {
    return absoluteUrl(show.third_party_system_url);
  }
  const direct = absoluteUrl(show.page_link);
  if (direct) return direct;
  if (!show.show_time_uuid || !movie.url_key || !show.session_start_date) return null;
  const step = show.seat_plan_status === "1" ? "seat-plan" : "select-tickets";
  return `${SITE_ORIGIN}/movies/${encodeURIComponent(movie.url_key)}/showtimes/${show.session_start_date}/${LOCATION_SLUG}/${step}?showtime=${encodeURIComponent(show.show_time_uuid)}`;
}

export function artworkUrl(movie: CineSyncMovie): string | null {
  return absoluteUrl(movie.portrait_image) ?? absoluteUrl(movie.landscape_image);
}
