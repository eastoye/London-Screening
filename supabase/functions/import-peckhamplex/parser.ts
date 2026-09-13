import { londonToUtc, type ScreeningRecord } from "../_shared/importSafety.ts";
import {
  accessibilityForSpecialKinds,
  cleanText,
  labelsForSpecialKinds,
  parseFilmDetail,
  programmeLabel,
  programmesForSpecialKinds,
  projectionFormats,
  safeFilmTitleHint,
  screeningTags,
  type FilmMetadata,
  type SpecialKind,
} from "./metadata.ts";

export const CINEMA_NAME = "Peckhamplex";
const BASE_URL = "https://www.peckhamplex.london";
const DAY_URL = `${BASE_URL}/api/v1/films/listings/days`;
const SPECIAL_URLS: Record<SpecialKind, string> = {
  hard_of_hearing: `${BASE_URL}/films/hard-of-hearing`,
  autism_friendly: `${BASE_URL}/films/autism-friendly`,
  watch_with_baby: `${BASE_URL}/films/watch-with-baby`,
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

interface SourceScreening {
  title: string;
  startTime: string;
  performanceId: string;
  bookingUrl: string | null;
  eventUrl: string;
  soldOut: boolean;
  kinds: Set<SpecialKind>;
}

export interface ParseResult {
  records: ScreeningRecord[];
  scheduleScreenings: number;
  supplementalScreenings: number;
  detailPagesRequested: number;
  detailPagesLoaded: number;
  detailPageFailures: string[];
  pastSkipped: number;
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = cleanText(value).match(/^[A-Za-z]+\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return { day: Number(match[1]), month, year: Number(match[3]) };
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = cleanText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function officialEventUrl(value: string): string | null {
  try {
    const url = new URL(value, BASE_URL);
    return url.protocol === "https:" && url.hostname === "www.peckhamplex.london" && /^\/film\/[^/]+\/?$/i.test(url.pathname)
      ? url.toString().replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
}

function bookingParts(anchor: string): { id: string; url: string; time: string; soldOut: boolean } | null {
  const href = anchor.match(/href=["'](https:\/\/ticketing\.eu\.veezi\.com\/purchase\/(\d+)[^"']*)["']/i);
  if (!href) return null;
  const time = cleanText(anchor).match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? "";
  const soldOut = /\bsold\s*out\b/i.test(cleanText(anchor)) || /\bsold\s*out\b/i.test(anchor.match(/title=["']([^"']*)["']/i)?.[1] ?? "");
  return { id: href[2], url: cleanText(href[1]), time, soldOut };
}

function parseAnchors(body: string): ReturnType<typeof bookingParts>[] {
  return [...body.matchAll(/<a\b[^>]*href=["']https:\/\/ticketing\.eu\.veezi\.com\/purchase\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)]
    .map((match) => bookingParts(match[0]));
}

export function parseMainSchedule(html: string): SourceScreening[] {
  if (html.length < 20_000) throw new Error(`Peckhamplex schedule was unexpectedly short (${html.length} bytes)`);
  const results: SourceScreening[] = [];
  const errors: string[] = [];
  const dayMatches = [...html.matchAll(/<h3>([^<]+)<\/h3>([\s\S]*?)(?=<h3>|$)/gi)];
  if (!dayMatches.length) throw new Error("Peckhamplex schedule contained no dated sections");
  for (const dayMatch of dayMatches) {
    const date = parseDate(dayMatch[1]);
    if (!date) { errors.push(`Unparseable date: ${cleanText(dayMatch[1])}`); continue; }
    const filmBlocks = dayMatch[2].split(/<!--\s*film-title-wrapper\s*-->/i).slice(1);
    for (const block of filmBlocks) {
      const title = cleanText(block.match(/<div\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      const eventUrl = officialEventUrl(block.match(/<div\b[^>]*class=["']details["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "");
      const anchors = parseAnchors(block).filter((value): value is NonNullable<typeof value> => value !== null);
      if (!title || !eventUrl || !anchors.length) {
        errors.push(`Incomplete film block: ${title || "untitled"}`);
        continue;
      }
      for (const anchor of anchors) {
        const time = parseTime(anchor.time);
        if (!time) { errors.push(`Unparseable time for ${title}: ${anchor.time}`); continue; }
        const utc = londonToUtc(date.year, date.month, date.day, time.hour, time.minute);
        results.push({
          title,
          startTime: utc.toISOString(),
          performanceId: anchor.id,
          bookingUrl: anchor.soldOut ? null : anchor.url,
          eventUrl,
          soldOut: anchor.soldOut,
          kinds: new Set(),
        });
      }
    }
  }
  const rawPerformanceCount = (html.match(/ticketing\.eu\.veezi\.com\/purchase\/\d+/gi) ?? []).length;
  if (errors.length || results.length !== rawPerformanceCount) {
    throw new Error(`Incomplete Peckhamplex schedule parse (${results.length}/${rawPerformanceCount}): ${errors.slice(0, 5).join("; ")}`);
  }
  return results;
}

export function parseSpecialPage(html: string, kind: SpecialKind): SourceScreening[] {
  const rawPerformanceCount = (html.match(/ticketing\.eu\.veezi\.com\/purchase\/\d+/gi) ?? []).length;
  if (!rawPerformanceCount) {
    if (!/currently no[\s\S]{0,80}screenings available/i.test(html)) {
      throw new Error(`${kind} page returned neither performances nor an explicit empty message`);
    }
    return [];
  }
  const results: SourceScreening[] = [];
  const blocks = html.split(/<div\b[^>]*class=["'][^"']*specific-wrapper[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const title = cleanText(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1]?.replace(/<span[\s\S]*$/i, ""));
    const eventUrl = officialEventUrl(block.match(/For more details[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "");
    const dateBlocks = [...block.matchAll(/<p\b[^>]*class=["']date["'][^>]*>([\s\S]*?)<\/p>([\s\S]*?)(?=<p\b[^>]*class=["']date["']|For more details|$)/gi)];
    for (const dateBlock of dateBlocks) {
      const date = parseDate(dateBlock[1]);
      const anchors = parseAnchors(dateBlock[2]).filter((value): value is NonNullable<typeof value> => value !== null);
      if (!title || !eventUrl || !date) continue;
      for (const anchor of anchors) {
        const time = parseTime(anchor.time);
        if (!time) continue;
        results.push({
          title,
          startTime: londonToUtc(date.year, date.month, date.day, time.hour, time.minute).toISOString(),
          performanceId: anchor.id,
          bookingUrl: anchor.soldOut ? null : anchor.url,
          eventUrl,
          soldOut: anchor.soldOut,
          kinds: new Set([kind]),
        });
      }
    }
  }
  if (results.length !== rawPerformanceCount) {
    throw new Error(`Incomplete ${kind} parse (${results.length}/${rawPerformanceCount})`);
  }
  return results;
}

async function fetchRequired(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)", Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchOptionalDetails(urls: string[]): Promise<{ pages: Map<string, string>; failures: string[] }> {
  const pages = new Map<string, string>();
  const finalFailures: string[] = [];
  const batchSize = 6;
  const load = async (batch: string[]): Promise<string[]> => {
    const failed: string[] = [];
    const settled = await Promise.allSettled(batch.map(async (url) => {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)", Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (html.length < 20_000 || !/itemtype=["']http:\/\/schema\.org\/Movie["']/i.test(html)) throw new Error("incomplete film page");
      return { url, html };
    }));
    settled.forEach((result, offset) => {
      const url = batch[offset];
      if (result.status === "fulfilled") pages.set(url, result.value.html);
      else failed.push(url);
    });
    return failed;
  };
  let failedUrls: string[] = [];
  for (let index = 0; index < urls.length; index += batchSize) {
    failedUrls.push(...await load(urls.slice(index, index + batchSize)));
  }
  // One restrained retry improves metadata coverage without making detail
  // pages a condition of retaining the authoritative schedule.
  const retryUrls = failedUrls;
  failedUrls = [];
  for (let index = 0; index < retryUrls.length; index += batchSize) {
    failedUrls.push(...await load(retryUrls.slice(index, index + batchSize)));
  }
  for (const url of failedUrls) finalFailures.push(`${new URL(url).pathname}: unavailable after retry`);
  return { pages, failures: finalFailures };
}

export async function parsePeckhamplex(now: Date): Promise<ParseResult> {
  const [scheduleHtml, ...specialHtml] = await Promise.all([
    fetchRequired(DAY_URL),
    ...Object.values(SPECIAL_URLS).map(fetchRequired),
  ]);
  const schedule = parseMainSchedule(scheduleHtml);
  const merged = new Map<string, SourceScreening>();
  for (const screening of schedule) merged.set(screening.performanceId, screening);
  let supplementalScreenings = 0;
  (Object.keys(SPECIAL_URLS) as SpecialKind[]).forEach((kind, index) => {
    for (const special of parseSpecialPage(specialHtml[index], kind)) {
      const existing = merged.get(special.performanceId);
      if (existing) {
        existing.kinds.add(kind);
        if (existing.title !== special.title || existing.startTime !== special.startTime || existing.eventUrl !== special.eventUrl) {
          throw new Error(`Conflicting ${kind} data for performance ${special.performanceId}`);
        }
      } else {
        merged.set(special.performanceId, special);
        supplementalScreenings++;
      }
    }
  });

  const future: SourceScreening[] = [];
  let pastSkipped = 0;
  for (const screening of merged.values()) {
    if (new Date(screening.startTime) <= now) pastSkipped++;
    else future.push(screening);
  }
  if (future.length < 5) throw new Error(`Unusually low future Peckhamplex count (${future.length})`);

  const detailUrls = [...new Set(future.map((screening) => screening.eventUrl))];
  const detailResult = await fetchOptionalDetails(detailUrls);
  const metadata = new Map<string, FilmMetadata>();
  for (const screening of future) {
    if (metadata.has(screening.eventUrl)) continue;
    const html = detailResult.pages.get(screening.eventUrl);
    if (html) metadata.set(screening.eventUrl, parseFilmDetail(html, screening.eventUrl, screening.title));
  }

  const records: ScreeningRecord[] = future.map((screening) => {
    const film = metadata.get(screening.eventUrl);
    const specialLabels = labelsForSpecialKinds(screening.kinds);
    const label = [programmeLabel(screening.title), ...specialLabels].filter(Boolean).join("; ") || null;
    const formatLabel = film?.formatLabel ?? null;
    return {
      cinema_name: CINEMA_NAME,
      movie_title: screening.title,
      start_time: screening.startTime,
      booking_url: screening.bookingUrl,
      format: formatLabel,
      sold_out: screening.soldOut,
      projection_formats: projectionFormats(formatLabel),
      accessibility_features: accessibilityForSpecialKinds(screening.kinds),
      programme_types: programmesForSpecialKinds(screening.kinds),
      availability_status: screening.soldOut ? "sold_out" : screening.bookingUrl ? "available" : "unknown",
      film_title_hint: film?.filmTitleHint ?? safeFilmTitleHint(screening.title, null),
      source_release_year: null,
      source_runtime_minutes: film?.runtimeMinutes ?? null,
      source_directors: film?.directors ?? [],
      source_countries: [],
      source_event_url: screening.eventUrl,
      screen_name: null,
      screening_label: label,
      screening_tags: screeningTags(screening.title, specialLabels),
      verified_artwork_url: film?.artworkUrl ?? null,
      source_reference: `peckhamplex:${screening.performanceId}`,
      last_seen_at: now.toISOString(),
    };
  }).sort((a, b) => a.start_time.localeCompare(b.start_time));

  return {
    records,
    scheduleScreenings: schedule.length,
    supplementalScreenings,
    detailPagesRequested: detailUrls.length,
    detailPagesLoaded: detailResult.pages.size,
    detailPageFailures: detailResult.failures,
    pastSkipped,
  };
}
