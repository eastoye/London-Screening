import { londonToUtc, type ScreeningRecord } from "../_shared/importSafety.ts";
import {
  cleanText,
  displayTitle,
  explicitLabels,
  isClearlyNonFilm,
  parseEventMetadata,
  programmeTypes,
  projectionFormats,
  runtimeMinutes,
  safeFilmTitleHint,
  screeningTags,
  sourceReleaseYear,
  type EventMetadata,
} from "./metadata.ts";

export const CINEMA_NAME = "Genesis Cinema";
const BASE_URL = "https://www.genesiscinema.co.uk";
const PROGRAMME_URL = `${BASE_URL}/whatson/all`;
const SOURCE_PREFIX = "genesis";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

interface SourceEvent {
  eventId: string;
  sourceTitle: string;
  runtime: number | null;
  artworkUrl: string | null;
  eventUrl: string;
  performances: SourcePerformance[];
}

interface SourcePerformance {
  startTime: string;
  performanceId: string | null;
  bookingUrl: string | null;
  soldOut: boolean;
  labels: string[];
}

export interface GenesisParseResult {
  records: ScreeningRecord[];
  rawScreenings: number;
  nonFilmExcluded: number;
  pastSkipped: number;
  detailPagesRequested: number;
  detailPagesLoaded: number;
  detailPageFailures: string[];
}

function parseDate(text: string): { year: number; month: number; day: number } | null {
  const match = cleanText(text).match(/^[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  return month ? { day: Number(match[1]), month, year: Number(match[3]) } : null;
}

function parseTime(text: string): { hour: number; minute: number } | null {
  const match = cleanText(text).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function normaliseReferenceTitle(title: string): string {
  // Matches the V1 fallback-reference behaviour so a sold-out performance does
  // not change identity merely because V2 cleans its public title.
  const legacy = cleanText(title).replace(/^(?:35mm|Q&A|subtitled|studio screening|film festival|special event|TFFF)\s*[-:]\s*/i, "");
  return legacy.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function performanceLabels(anchor: string): string[] {
  return [...anchor.matchAll(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => cleanText(match[1]).replace(/\s+icon$/i, "").replace(/^Studo\b/i, "Studio"))
    .filter(Boolean);
}

function officialArtwork(eventId: string, value: string): string | null {
  try {
    const url = new URL(value, BASE_URL);
    return url.protocol === "https:" && url.hostname === "www.genesiscinema.co.uk" &&
        new RegExp(`^/customFilmImages/${eventId}_0\\.jpg$`, "i").test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseProgramme(html: string): SourceEvent[] {
  if (html.length < 100_000) throw new Error(`Genesis programme was unexpectedly short (${html.length} bytes)`);
  const events: SourceEvent[] = [];
  const errors: string[] = [];
  const eventRegex = /<h1 class=["']pb-2["']>\s*<a href=["']\/event\/(\d+)["'][^>]*>([\s\S]*?)<\/a><\/h1>([\s\S]*?)(?=<h1 class=["']pb-2["']>|<footer|$)/gi;
  for (const match of html.matchAll(eventRegex)) {
    const eventId = match[1];
    const sourceTitle = cleanText(match[2]);
    const body = match[3];
    const desktop = body.match(/<div class=["']hidden md:block["']>([\s\S]*?)<\/div>\s*<\/div>\s*<div class=["']col-span-10 block md:hidden["']>/i)?.[1] ?? body;
    const runtime = runtimeMinutes(body.match(/Running time:\s*<\/span><span[^>]*>([^<]+)/i)?.[1] ?? "");
    const image = html.match(new RegExp(`["'](/customFilmImages/${eventId}_0\\.jpg)["']`, "i"))?.[1] ?? "";
    const performances: SourcePerformance[] = [];
    const dateRegex = /<div>((?:Mon|Tues?|Wednes?|Thurs?|Fri|Satur?|Sun)day\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})<div[^>]*>([\s\S]*?)<\/div><\/div>/gi;
    for (const dateMatch of desktop.matchAll(dateRegex)) {
      const date = parseDate(dateMatch[1]);
      if (!date) { errors.push(`Unparseable date for ${sourceTitle}: ${cleanText(dateMatch[1])}`); continue; }
      const anchors = [...dateMatch[2].matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)];
      for (const anchorMatch of anchors) {
        const anchor = anchorMatch[0];
        const timeText = cleanText(anchor).match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? "";
        const time = parseTime(timeText);
        if (!time) { errors.push(`Unparseable time for ${sourceTitle}: ${timeText}`); continue; }
        const perfCode = anchor.match(/\bperfCode(?:=|%3D)(\d+)\b/i)?.[1] ?? null;
        const soldOut = /\bsoldOut\b/i.test(anchor);
        if (!perfCode && !soldOut) { errors.push(`Performance without code or sold-out state: ${sourceTitle}`); continue; }
        const startTime = londonToUtc(date.year, date.month, date.day, time.hour, time.minute).toISOString();
        performances.push({
          startTime,
          performanceId: perfCode,
          bookingUrl: perfCode && !soldOut ? `https://genesis.admit-one.co.uk/seats/?perfCode=${perfCode}` : null,
          soldOut,
          labels: performanceLabels(anchor),
        });
      }
    }
    if (!sourceTitle || !performances.length) errors.push(`Incomplete event block ${eventId}: ${sourceTitle || "untitled"}`);
    else events.push({
      eventId,
      sourceTitle,
      runtime,
      artworkUrl: officialArtwork(eventId, image),
      eventUrl: `${BASE_URL}/event/${eventId}`,
      performances,
    });
  }
  const rawCount = ((html.match(/genesis\.admit-one\.co\.uk\/seats\/\?perfCode=\d+/gi) ?? []).length / 2) +
    ((html.match(/class=["'][^"']*\bsoldOut\b[^"']*["']/gi) ?? []).length / 2);
  const parsedCount = events.reduce((sum, event) => sum + event.performances.length, 0);
  if (errors.length || !events.length || parsedCount !== rawCount) {
    throw new Error(`Incomplete Genesis programme parse (${parsedCount}/${rawCount}): ${errors.slice(0, 5).join("; ")}`);
  }
  return events;
}

async function fetchHtml(url: string, required: boolean): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)", Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(required ? 25_000 : 15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      return new TextDecoder("windows-1252").decode(bytes);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchDetails(urls: string[]): Promise<{ pages: Map<string, string>; failures: string[] }> {
  const pages = new Map<string, string>();
  let pending = [...urls];
  for (let attempt = 1; attempt <= 2 && pending.length; attempt++) {
    const failed: string[] = [];
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8);
      const settled = await Promise.allSettled(batch.map(async (url) => {
        const html = await fetchHtml(url, false);
        if (html.length < 60_000 || !/<b>\s*(?:Running time|Run Time):/i.test(html)) throw new Error("incomplete event page");
        return { url, html };
      }));
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") pages.set(result.value.url, result.value.html);
        else failed.push(batch[index]);
      });
    }
    pending = failed;
  }
  return { pages, failures: pending.map((url) => `${new URL(url).pathname}: unavailable after retry`) };
}

export async function parseGenesis(now: Date): Promise<GenesisParseResult> {
  const programme = parseProgramme(await fetchHtml(PROGRAMME_URL, true));
  const rawScreenings = programme.reduce((sum, event) => sum + event.performances.length, 0);
  let nonFilmExcluded = 0;
  let pastSkipped = 0;
  const eligible: SourceEvent[] = [];
  for (const event of programme) {
    const kept = event.performances.filter((performance) => {
      if (isClearlyNonFilm(event.sourceTitle, performance.labels)) { nonFilmExcluded++; return false; }
      if (new Date(performance.startTime) <= now) { pastSkipped++; return false; }
      return true;
    });
    if (kept.length) eligible.push({ ...event, performances: kept });
  }
  const detailUrls = [...new Set(eligible.map((event) => event.eventUrl))];
  const detailResult = await fetchDetails(detailUrls);
  const details = new Map<string, EventMetadata>();
  for (const event of eligible) {
    const html = detailResult.pages.get(event.eventUrl);
    if (html) details.set(event.eventUrl, parseEventMetadata(html));
  }
  const records: ScreeningRecord[] = [];
  for (const event of eligible) {
    const detail = details.get(event.eventUrl);
    for (const performance of event.performances) {
      const labels = explicitLabels(event.sourceTitle, performance.labels);
      const projection = projectionFormats(labels);
      const fallbackId = `${normaliseReferenceTitle(event.sourceTitle)}:${performance.startTime.slice(0, 10)}:${performance.startTime.slice(11, 16).replace(":", "")}`;
      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: displayTitle(event.sourceTitle),
        start_time: performance.startTime,
        booking_url: performance.soldOut ? null : performance.bookingUrl,
        format: projection.length ? projection.map((value) => value === "imax" ? "IMAX" : value).join(", ") : null,
        sold_out: performance.soldOut,
        projection_formats: projection,
        accessibility_features: [],
        programme_types: programmeTypes(labels),
        availability_status: performance.soldOut ? "sold_out" : performance.bookingUrl ? "available" : "unknown",
        film_title_hint: safeFilmTitleHint(event.sourceTitle),
        source_release_year: sourceReleaseYear(event.sourceTitle, detail?.releaseYear ?? null),
        source_runtime_minutes: event.runtime,
        source_directors: detail?.directors ?? [],
        source_countries: [],
        source_event_url: event.eventUrl,
        screen_name: null,
        screening_label: labels.join("; ") || null,
        screening_tags: screeningTags(labels),
        verified_artwork_url: event.artworkUrl,
        source_reference: `${SOURCE_PREFIX}:${performance.performanceId ?? fallbackId}`,
        last_seen_at: now.toISOString(),
      });
    }
  }
  records.sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (records.length < 5) throw new Error(`Unusually low future Genesis count (${records.length})`);
  return {
    records,
    rawScreenings,
    nonFilmExcluded,
    pastSkipped,
    detailPagesRequested: detailUrls.length,
    detailPagesLoaded: detailResult.pages.size,
    detailPageFailures: detailResult.failures,
  };
}
