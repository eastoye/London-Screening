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
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  parseRuntimeMinutes,
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
const DETAIL_CONCURRENCY = 6;
const MAX_SOURCE_AGE_HOURS = 48;

interface EventLink {
  url: string;
  slug: string;
  title: string;
  image: string | null;
  eventType: string | null;
  performanceDays: Record<string, ListingPerformance[]>;
}

interface ListingPerformance {
  time?: unknown;
  booking_link?: unknown;
  sold_out?: unknown;
  status?: unknown;
}

interface ListingPayload {
  generated_at?: unknown;
  events?: unknown;
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
  film_title_hint: string | null;
  source_release_year: number | null;
  source_runtime_minutes: number | null;
  source_directors: string[];
  source_countries: string[];
  source_event_url: string;
  screen_name: string | null;
  screening_label: string | null;
  screening_tags: ReturnType<typeof normaliseScreeningTags>;
  verified_artwork_url: string | null;
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

function safeArtworkUrl(href: string): string | null {
  try {
    const url = new URL(decodeMore(href), WHATSON_URL);
    if (url.protocol !== "https:") return null;
    if (
      url.hostname !== "dochouse.org" &&
      url.hostname !== "www.dochouse.org" &&
      !url.hostname.endsWith(".exactdn.com")
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchHtmlWithRetry(url: string, label: string): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(15000) });
      if (response.ok) return await response.text();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(`${label} failed after 3 attempts: ${lastError}`);
}

function parseListingPayload(html: string, nowUtc: Date): EventLink[] {
  const raw = html.match(
    /<script\b[^>]*id=["']whats-on-listing-json["'][^>]*>([\s\S]*?)<\/script>/i,
  )?.[1];
  if (!raw) throw new Error("DocHouse page has no structured programme payload.");

  let payload: ListingPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("DocHouse structured programme is invalid JSON.");
  }

  const generatedAt = typeof payload.generated_at === "string"
    ? new Date(payload.generated_at)
    : null;
  if (!generatedAt || Number.isNaN(generatedAt.getTime())) {
    throw new Error("DocHouse programme has no valid generation timestamp.");
  }
  const ageHours = (nowUtc.getTime() - generatedAt.getTime()) / 3_600_000;
  if (ageHours > MAX_SOURCE_AGE_HOURS || ageHours < -1) {
    throw new Error(`DocHouse programme timestamp is implausible (${ageHours.toFixed(1)} hours old).`);
  }
  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    throw new Error("DocHouse structured programme contains no events.");
  }

  const events: EventLink[] = [];
  const seen = new Set<string>();
  for (const value of payload.events) {
    if (!value || typeof value !== "object") throw new Error("Malformed DocHouse programme event.");
    const row = value as Record<string, unknown>;
    const slug = typeof row.id === "string" ? row.id.trim().toLowerCase() : "";
    const title = typeof row.title === "string" ? textFromHtml(row.title) : "";
    const url = typeof row.link === "string" ? absoluteDochouseUrl(row.link) : null;
    const performanceDays = row.performance_day;
    if (!slug || !title || !url || !performanceDays || typeof performanceDays !== "object" || Array.isArray(performanceDays)) {
      throw new Error(`Malformed DocHouse programme event: ${slug || title || "unknown"}`);
    }
    if (seen.has(slug)) throw new Error(`Duplicate DocHouse event ID: ${slug}`);
    seen.add(slug);
    events.push({
      url,
      slug,
      title,
      image: typeof row.image === "string" ? safeArtworkUrl(row.image) : null,
      eventType: typeof row.event_type === "string"
        ? textFromHtml(row.event_type) || null
        : null,
      performanceDays: performanceDays as Record<string, ListingPerformance[]>,
    });
  }
  return events;
}

async function collectEvents(nowUtc: Date): Promise<EventLink[]> {
  return parseListingPayload(
    await fetchHtmlWithRetry(WHATSON_URL, "DocHouse programme"),
    nowUtc,
  );
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

type OpenCaptionScope = "all" | "single" | null;

function explicitOpenCaptionScope(html: string): OpenCaptionScope {
  const text = textFromHtml(html);
  if (/\bthese screenings\s+(?:will be|are|were)\s+open captioned\b/i.test(text)) {
    return "all";
  }
  if (/\b(?:this|the) screening\s+(?:will be|is|was)\s+open captioned\b/i.test(text)) {
    return "single";
  }
  return null;
}

function performanceCount(event: EventLink): number {
  return Object.values(event.performanceDays).reduce(
    (count, performances) => count + (Array.isArray(performances) ? performances.length : 0),
    0,
  );
}

function strongValueForClass(html: string, className: string): string | null {
  const match = html.match(new RegExp(
    `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>[\\s\\S]*?<strong[^>]*>([\\s\\S]*?)<\\/strong>`,
    "i",
  ));
  return match ? textFromHtml(match[1]) || null : null;
}

function safeFilmTitleHint(title: string): string | null {
  if (/\bdouble[ -]bill\b|^DocHouse Shorts\s*:/i.test(title)) return null;
  if (/\s\+\s/.test(title)) return null;
  const cleaned = title
    .replace(/^LDNDOCS\s*:\s*/i, "")
    .replace(/^Sheffield DocFest Spotlights\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function splitExplicitValues(value: string | null): string[] {
  if (!value) return [];
  return compactStrings(value.split(/\s*(?:,|\/|;|\s+(?:and|&)\s+)\s*/i));
}

function sourceMetadata(
  html: string,
  eventUrl: string,
  title: string,
  listingArtwork: string | null,
) {
  const director = strongValueForClass(html, "director");
  const runtime = strongValueForClass(html, "runtime");
  const artwork = html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
  const year = strongValueForClass(html, "year") ?? strongValueForClass(html, "release-year");
  const country = strongValueForClass(html, "country") ?? strongValueForClass(html, "countries");
  return {
    film_title_hint: safeFilmTitleHint(title),
    source_release_year: parseExplicitYear(year),
    source_runtime_minutes: parseRuntimeMinutes(runtime?.replace(/(\d)h\b/gi, "$1 hr")),
    source_directors: splitExplicitValues(director),
    source_countries: /^Various$/i.test(country || "") ? [] : splitExplicitValues(country),
    source_event_url: eventUrl,
    screen_name: null,
    screening_label: null as string | null,
    screening_tags: normaliseScreeningTags([]),
    verified_artwork_url: safeArtworkUrl(artwork || "") || listingArtwork,
  };
}

function performanceLabels(html: string): Map<string, string | null> {
  const labels = new Map<string, string | null>();
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']([^"']*curzon\.com\/ticketing\/seats\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    let code: string | null = null;
    try {
      code = new URL(decodeMore(match[1])).pathname.match(/\/ticketing\/seats\/([^/]+)\/?$/i)?.[1] || null;
    } catch {
      continue;
    }
    if (!code) continue;
    const labelHtml = match[2].match(
      /<div\b[^>]*class=["'][^"']*\bevent-type\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    )?.[1];
    const label = labelHtml ? textFromHtml(labelHtml) || null : null;
    const previous = labels.get(code);
    if (previous !== undefined && previous !== label) {
      throw new Error(`Conflicting labels for Curzon performance ${code}`);
    }
    labels.set(code, label);
  }
  return labels;
}

function parseListingTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2})[.:](\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? { hour, minute }
    : null;
}

function explicitSoldOut(performance: ListingPerformance): boolean {
  return performance.sold_out === true ||
    (typeof performance.status === "string" && /\bsold\s*out\b/i.test(performance.status));
}

function parseBookingUrl(value: unknown): { url: string; code: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(decodeMore(value));
    if (url.protocol !== "https:" || !/(?:^|\.)curzon\.com$/i.test(url.hostname)) return null;
    const code = url.pathname.match(/^\/ticketing\/seats\/([A-Za-z0-9-]+)\/?$/i)?.[1];
    return code ? { url: url.toString(), code } : null;
  } catch {
    return null;
  }
}

function parseStructuredScreenings(
  event: EventLink,
  source: ReturnType<typeof sourceMetadata>,
  labelsByCode: Map<string, string | null>,
  openCaptionScope: OpenCaptionScope,
): ParsedScreening[] {
  const screenings: ParsedScreening[] = [];
  const eventOpenCaptioned =
    openCaptionScope === "all" ||
    (openCaptionScope === "single" && performanceCount(event) === 1);
  for (const [isoDate, performances] of Object.entries(event.performanceDays)) {
    const dateMatch = isoDate.match(/^((?:19|20|21)\d{2})-(\d{2})-(\d{2})$/);
    if (!dateMatch || !Array.isArray(performances)) {
      throw new Error(`Malformed performance day for ${event.slug}: ${isoDate}`);
    }
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);

    for (const performance of performances) {
      if (!performance || typeof performance !== "object") {
        throw new Error(`Malformed performance for ${event.slug} on ${isoDate}`);
      }
      const time = parseListingTime(performance.time);
      if (!time) throw new Error(`Unparseable time for ${event.slug} on ${isoDate}`);
      const booking = parseBookingUrl(performance.booking_link);
      const soldOut = explicitSoldOut(performance);
      if (!booking && !soldOut) {
        throw new Error(`Performance has neither a Curzon link nor an explicit sold-out state: ${event.slug} ${isoDate}`);
      }

      const label = booking && labelsByCode.has(booking.code)
        ? labelsByCode.get(booking.code) || null
        : event.eventType;
      const metadata = explicitMetadata(label || "");
      const accessibilityFeatures = new Set(metadata.accessibility_features);
      if (eventOpenCaptioned) accessibilityFeatures.add("captioned");
      const start = londonToUtc(year, month, day, time.hour, time.minute).toISOString();
      screenings.push({
        movie_title: event.title,
        start_time_iso: start,
        booking_url: soldOut ? null : booking?.url || null,
        source_reference: booking
          ? `${SOURCE_PREFIX}:curzon:${booking.code}`
          : `${SOURCE_PREFIX}:event:${event.slug}:${isoDate}:${String(time.hour).padStart(2, "0")}${String(time.minute).padStart(2, "0")}`,
        sold_out: soldOut,
        projection_formats: metadata.projection_formats,
        accessibility_features: Array.from(accessibilityFeatures),
        programme_types: metadata.programme_types,
        availability_status: soldOut ? "sold_out" : "available",
        ...source,
        screening_label: label,
        screening_tags: normaliseScreeningTags([label]),
      });
    }
  }
  return screenings;
}

async function parseEventPage(event: EventLink): Promise<EventParseResult> {
  const html = await fetchHtmlWithRetry(event.url, `DocHouse event ${event.slug}`);
  const detailTitle = extractTitle(html);
  if (!detailTitle) throw new Error(`Event ${event.slug} has no parseable title`);
  if (detailTitle !== event.title) {
    throw new Error(`Title mismatch for ${event.slug}: listing "${event.title}" vs detail "${detailTitle}"`);
  }
  const source = sourceMetadata(html, event.url, event.title, event.image);
  return {
    screenings: parseStructuredScreenings(
      event,
      source,
      performanceLabels(html),
      explicitOpenCaptionScope(html),
    ),
    eventUrl: event.url,
    title: event.title,
  };
}

async function parseAllEvents(events: EventLink[]): Promise<{
  screenings: ParsedScreening[];
  failedEvents: string[];
  eventsWithNoScreenings: string[];
}> {
  const screenings: ParsedScreening[] = [];
  const failedEvents: string[] = [];
  const eventsWithNoScreenings: string[] = [];

  for (let i = 0; i < events.length; i += DETAIL_CONCURRENCY) {
    const batch = events.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((event) => parseEventPage(event)));

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

async function preserveExistingReferences(
  ctx: ImportRunContext,
  screenings: ParsedScreening[],
  nowUtc: Date,
): Promise<number> {
  const { data, error } = await ctx.supabase
    .from("screenings")
    .select("source_reference,start_time,source_event_url")
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not read existing screening identities: ${error.message}`);

  const existing = new Map<string, string>();
  for (const row of data || []) {
    if (!row.source_reference || !row.start_time || !row.source_event_url) continue;
    existing.set(
      `${row.source_event_url}\u0000${new Date(row.start_time).toISOString()}`,
      row.source_reference,
    );
  }

  let preserved = 0;
  for (const screening of screenings) {
    const previous = existing.get(`${screening.source_event_url}\u0000${screening.start_time_iso}`);
    if (previous && previous !== screening.source_reference) {
      screening.source_reference = previous;
      preserved += 1;
    }
  }
  return preserved;
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
    const events = await collectEvents(nowUtc);

    const parsed = await parseAllEvents(events);
    if (parsed.failedEvents.length > 0) {
      throw new Error(`DocHouse event pages failed (${parsed.failedEvents.length}/${events.length}): ${parsed.failedEvents.slice(0, 5).join(" | ")}`);
    }

    const future = parsed.screenings
      .filter((screening) => new Date(screening.start_time_iso) > nowUtc)
      .sort((a, b) => a.start_time_iso.localeCompare(b.start_time_iso));

    const existingReferencesPreserved = await preserveExistingReferences(ctx, future, nowUtc);
    const references = new Set<string>();
    const titleTimes = new Set<string>();
    for (const screening of future) {
      if (references.has(screening.source_reference)) {
        throw new Error(`Duplicate source reference: ${screening.source_reference}`);
      }
      references.add(screening.source_reference);
      const titleTime = `${screening.movie_title.toLocaleLowerCase("en-GB")}\u0000${screening.start_time_iso}`;
      if (titleTimes.has(titleTime)) {
        throw new Error(`Duplicate title/time: ${screening.movie_title} at ${screening.start_time_iso}`);
      }
      titleTimes.add(titleTime);
    }

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
      film_title_hint: screening.film_title_hint,
      source_release_year: screening.source_release_year,
      source_runtime_minutes: screening.source_runtime_minutes,
      source_directors: screening.source_directors,
      source_countries: screening.source_countries,
      source_event_url: screening.source_event_url,
      screen_name: screening.screen_name,
      screening_label: screening.screening_label,
      screening_tags: screening.screening_tags,
      verified_artwork_url: screening.verified_artwork_url,
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
      existing_references_preserved: existingReferencesPreserved,
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
