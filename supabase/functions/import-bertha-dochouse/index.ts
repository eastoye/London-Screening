import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  startRun,
  endRun,
  commitImport,
  decodeEntities,
  londonToUtc,
  inferYear,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  normaliseProjectionFormats,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
} from "../_shared/screeningMetadata.ts";

const CINEMA_NAME = "Bertha DocHouse";
const WHATSON_URL = "https://dochouse.org/whats-on/";
const SOURCE_PREFIX = "bertha-dochouse";
const MIN_SCREENINGS = 5;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const MAX_LISTING_PAGES = 8;
const DETAIL_CONCURRENCY = 6;

interface EventLink {
  url: string;
  slug: string;
}

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string;
  booking_url: string | null;
  source_reference: string;
  sold_out: boolean;
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: AvailabilityStatus;
}

interface EventParseResult {
  screenings: ParsedScreening[];
  eventUrl: string;
  title: string;
}

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow",
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function decodeMore(value: string): string {
  return decodeEntities(value)
    .replace(/&rsquo;|&#8217;/gi, "’")
    .replace(/&lsquo;|&#8216;/gi, "‘")
    .replace(/&rdquo;|&#8221;/gi, "”")
    .replace(/&ldquo;|&#8220;/gi, "“")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&#038;/gi, "&");
}

function textFromHtml(value: string): string {
  return decodeMore(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteDochouseUrl(href: string): string | null {
  try {
    const url = new URL(decodeMore(href), WHATSON_URL);
    if (url.hostname !== "dochouse.org" && url.hostname !== "www.dochouse.org") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractEventLinks(html: string): EventLink[] {
  const found = new Map<string, EventLink>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const url = absoluteDochouseUrl(match[1]);
    if (!url) continue;
    const parsed = new URL(url);
    const slugMatch = parsed.pathname.match(/^\/event\/([^/]+)\/?$/i);
    if (!slugMatch) continue;
    const slug = slugMatch[1].toLowerCase();
    if (!found.has(slug)) found.set(slug, { url, slug });
  }
  return [...found.values()];
}

function hasNextListingsPage(html: string, currentPage: number): boolean {
  const expected = `/whats-on/page/${currentPage + 1}/`;
  return html.includes(expected) || /\bSee more\b/i.test(textFromHtml(html));
}

async function collectEventLinks(): Promise<EventLink[]> {
  const found = new Map<string, EventLink>();

  for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
    const url = page === 1 ? WHATSON_URL : `${WHATSON_URL}page/${page}/`;
    const response = await fetch(url, fetchOpts);
    if (!response.ok) {
      if (page > 1 && response.status === 404) break;
      throw new Error(`DocHouse listings page ${page} returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const links = extractEventLinks(html);
    for (const link of links) found.set(link.slug, link);

    if (!hasNextListingsPage(html, page)) break;
  }

  return [...found.values()];
}

function extractTitle(html: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) {
    const title = textFromHtml(h1);
    if (title) return title;
  }

  const og = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]
    ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)?.[1];
  if (og) return decodeMore(og).replace(/\s*[-|]\s*Bertha DocHouse\s*$/i, "").trim();

  return "";
}

function explicitMetadata(html: string): {
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
} {
  const text = textFromHtml(html);
  const labels: string[] = [];

  for (const match of text.matchAll(/\b(?:35\s*mm|70\s*mm|IMAX)\b/gi)) labels.push(match[0]);

  const projection_formats = normaliseProjectionFormats(labels);
  const accessibility_features: AccessibilityFeature[] = [];
  const programme_types: ProgrammeType[] = [];

  if (/\b(?:relaxed screening|relaxed performance)\b/i.test(text)) accessibility_features.push("relaxed");
  if (/\b(?:captioned screening|subtitled screening|hard of hearing)\b/i.test(text)) accessibility_features.push("captioned");
  if (/\baudio described screening\b/i.test(text)) accessibility_features.push("audio_described");
  if (/\bmembers? only\b/i.test(text)) programme_types.push("members_only");
  if (/\b(?:parent and baby|parent & baby|baby club)\b/i.test(text)) programme_types.push("parent_and_baby");
  if (/\bchild required\b/i.test(text)) programme_types.push("child_required");
  if (/\bseniors? screening\b/i.test(text)) programme_types.push("seniors");

  return { projection_formats, accessibility_features, programme_types };
}

function parseDateTimeLabel(label: string, nowLondon: Date): string | null {
  const clean = textFromHtml(label);
  const match = clean.match(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?\s+(\d{1,2}):(\d{2})\b/i,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const year = match[3] ? Number(match[3]) : inferYear(day, month, nowLondon);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  return londonToUtc(year, month, day, hour, minute).toISOString();
}

function screeningSection(html: string): string {
  const marker = html.search(/Screening\s+times\s+and\s+booking/i);
  if (marker < 0) return html;
  const after = html.slice(marker);
  const end = after.search(/<h[1-4]\b[^>]*>\s*(?:Prices|Stay up to date|Find us)/i);
  return end > 0 ? after.slice(0, end) : after;
}

function parseBookableScreenings(
  section: string,
  title: string,
  metadata: ReturnType<typeof explicitMetadata>,
  nowLondon: Date,
): ParsedScreening[] {
  const screenings: ParsedScreening[] = [];
  const seen = new Set<string>();

  for (const match of section.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeMore(match[1]);
    if (!/https?:\/\/(?:www\.)?curzon\.com\/ticketing\/seats\//i.test(href)) continue;

    const start = parseDateTimeLabel(match[2], nowLondon);
    if (!start) continue;

    let bookingUrl: string;
    try {
      bookingUrl = new URL(href).toString();
    } catch {
      continue;
    }

    const seatCode = new URL(bookingUrl).pathname.split("/").filter(Boolean).pop();
    if (!seatCode) continue;
    const source_reference = `${SOURCE_PREFIX}:curzon:${seatCode}`;
    if (seen.has(source_reference)) continue;
    seen.add(source_reference);

    screenings.push({
      movie_title: title,
      start_time_iso: start,
      booking_url: bookingUrl,
      source_reference,
      sold_out: false,
      projection_formats: metadata.projection_formats,
      accessibility_features: metadata.accessibility_features,
      programme_types: metadata.programme_types,
      availability_status: "available",
    });
  }

  return screenings;
}

function parseSoldOutScreenings(
  section: string,
  title: string,
  metadata: ReturnType<typeof explicitMetadata>,
  nowLondon: Date,
  existing: ParsedScreening[],
  eventSlug: string,
): ParsedScreening[] {
  const text = textFromHtml(section);
  const candidates: ParsedScreening[] = [];
  const existingTimes = new Set(existing.map((s) => s.start_time_iso));

  const regex = /((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{4})?\s+\d{1,2}:\d{2})\s*(?:[-–—|:]\s*)?(?:Sold\s*Out|Soldout)/gi;

  for (const match of text.matchAll(regex)) {
    const start = parseDateTimeLabel(match[1], nowLondon);
    if (!start || existingTimes.has(start)) continue;
    existingTimes.add(start);
    const compact = start.replace(/[-:.TZ]/g, "");
    candidates.push({
      movie_title: title,
      start_time_iso: start,
      booking_url: null,
      source_reference: `${SOURCE_PREFIX}:event:${eventSlug}:soldout:${compact}`,
      sold_out: true,
      projection_formats: metadata.projection_formats,
      accessibility_features: metadata.accessibility_features,
      programme_types: metadata.programme_types,
      availability_status: "sold_out",
    });
  }

  return candidates;
}

async function parseEventPage(event: EventLink, nowLondon: Date): Promise<EventParseResult> {
  const response = await fetch(event.url, fetchOpts);
  if (!response.ok) throw new Error(`Event ${event.slug} returned HTTP ${response.status}`);
  const html = await response.text();
  const title = extractTitle(html);
  if (!title) throw new Error(`Event ${event.slug} has no parseable title`);

  const section = screeningSection(html);
  const metadata = explicitMetadata(section);
  const bookable = parseBookableScreenings(section, title, metadata, nowLondon);
  const soldOut = parseSoldOutScreenings(section, title, metadata, nowLondon, bookable, event.slug);

  return { screenings: [...bookable, ...soldOut], eventUrl: event.url, title };
}

async function parseAllEvents(events: EventLink[], nowLondon: Date): Promise<{
  screenings: ParsedScreening[];
  failedEvents: string[];
  eventsWithNoScreenings: string[];
}> {
  const screenings: ParsedScreening[] = [];
  const failedEvents: string[] = [];
  const eventsWithNoScreenings: string[] = [];

  for (let i = 0; i < events.length; i += DETAIL_CONCURRENCY) {
    const batch = events.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((event) => parseEventPage(event, nowLondon)));

    results.forEach((result, idx) => {
      const event = batch[idx];
      if (result.status === "rejected") {
        failedEvents.push(`${event.slug}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        return;
      }
      if (result.value.screenings.length === 0) {
        eventsWithNoScreenings.push(result.value.title || event.slug);
        return;
      }
      screenings.push(...result.value.screenings);
    });
  }

  const deduped = new Map<string, ParsedScreening>();
  for (const screening of screenings) {
    const existing = deduped.get(screening.source_reference);
    if (!existing || (existing.booking_url === null && screening.booking_url !== null)) {
      deduped.set(screening.source_reference, screening);
    }
  }

  return { screenings: [...deduped.values()], failedEvents, eventsWithNoScreenings };
}

async function getPreviousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());

  if (error) throw new Error(`Could not read previous screening count: ${error.message}`);
  return count ?? 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ctx: ImportRunContext = {
    supabase,
    cinemaName: CINEMA_NAME,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };

  const runStart = await startRun(ctx);
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const nowUtc = new Date();
    const nowLondon = new Date(
      nowUtc.toLocaleString("en-US", { timeZone: "Europe/London" })
    );

    const events = await collectEventLinks();
    if (events.length === 0) throw new Error("DocHouse listings contained no event detail links.");

    const parsed = await parseAllEvents(events, nowLondon);
    if (parsed.failedEvents.length > Math.max(2, Math.floor(events.length * 0.2))) {
      throw new Error(`Too many DocHouse event pages failed (${parsed.failedEvents.length}/${events.length}): ${parsed.failedEvents.slice(0, 5).join(" | ")}`);
    }

    const future = parsed.screenings
      .filter((screening) => new Date(screening.start_time_iso) > nowUtc)
      .sort((a, b) => a.start_time_iso.localeCompare(b.start_time_iso));

    const previousCount = await getPreviousActiveCount(ctx, nowUtc);
    if (previousCount >= RATIO_GUARD_MIN_EXISTING && future.length < Math.ceil(previousCount * MIN_EXPECTED_RATIO)) {
      throw new Error(`Count-drop guard blocked import: ${future.length} new future screenings vs ${previousCount} currently active.`);
    }
    if (future.length < MIN_SCREENINGS) {
      throw new Error(`Unusually low screening count (${future.length}); database left untouched.`);
    }

    const records = future.map((screening) => ({
      cinema_name: CINEMA_NAME,
      movie_title: screening.movie_title,
      start_time: screening.start_time_iso,
      booking_url: screening.booking_url,
      format: screening.projection_formats.length > 0
        ? screening.projection_formats.map((value) => value === "imax" ? "IMAX" : value).join(", ")
        : null,
      source_reference: screening.source_reference,
      sold_out: screening.sold_out,
      last_seen_at: new Date().toISOString(),
      projection_formats: screening.projection_formats,
      accessibility_features: screening.accessibility_features,
      programme_types: screening.programme_types,
      availability_status: screening.availability_status,
    })) as ScreeningRecord[];

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);

    await endRun(ctx, runId, "success", future.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      listing_events_found: events.length,
      screenings_found: future.length,
      screenings_saved: saved,
      failed_event_pages: parsed.failedEvents,
      events_without_current_screenings: parsed.eventsWithNoScreenings,
      previous_active: previousCount,
      screenings: future.map((screening) => ({
        title: screening.movie_title,
        start_time: screening.start_time_iso,
        booking_url: screening.booking_url,
        sold_out: screening.sold_out,
        source_reference: screening.source_reference,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
