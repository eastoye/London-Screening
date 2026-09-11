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
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";

const CINEMA_NAME = "Coldharbour Blue";
const SITE_URL = "https://www.coldharbourblue.com/";
const EVENTS_API_URL = "https://www.coldharbourblue.com/wp-json/tribe/events/v1/events";
const SOURCE_PREFIX = "coldharbour-blue";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 8;
const MIN_EXPECTED_RATIO = 0.5;
const MAX_API_PAGES = 10;
const API_PAGE_SIZE = 50;
const DETAIL_CONCURRENCY = 4;

interface TribeTerm {
  id?: number;
  name?: string;
  slug?: string;
}

interface TribeImage {
  url?: string;
}

interface TribeEvent {
  id?: number;
  title?: string;
  description?: string;
  excerpt?: string;
  url?: string;
  website?: string;
  start_date?: string;
  utc_start_date?: string;
  timezone?: string;
  categories?: TribeTerm[];
  tags?: TribeTerm[];
  image?: TribeImage | false | null;
}

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string;
  booking_url: string;
  source_reference: string;
  sold_out: boolean;
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: AvailabilityStatus;
  film_title_hint: string | null;
  source_release_year: number | null;
  source_event_url: string | null;
  screening_label: string | null;
  screening_tags: ScreeningTag[];
  verified_artwork_url: string | null;
  source_kind: "tribe-api" | "special-screening";
  event_id: number;
}

interface DetailMetadata {
  fetched: boolean;
  sold_out: boolean | null;
  availability_status: AvailabilityStatus | null;
  artwork_url: string | null;
}

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "application/json,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
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
  return decodeMore(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function cleanTitle(value: string): string {
  return textFromHtml(value).trim();
}

function eventLabels(event: TribeEvent): string[] {
  return [...(event.categories ?? []), ...(event.tags ?? [])]
    .flatMap((term) => [term.name, term.slug])
    .filter((value): value is string => Boolean(value));
}

function hasLabel(labels: string[], pattern: RegExp): boolean {
  return labels.some((label) => pattern.test(label));
}

function isScreeningCategory(event: TribeEvent): boolean {
  return (event.categories ?? []).some(
    (term) =>
      term.slug?.toLowerCase() === "screenings" ||
      term.name?.trim().toLowerCase() === "screenings",
  );
}

function isExplicitNonFilmScreening(title: string): boolean {
  return /^(?:NT\s*Live|National Theatre Live|Royal Ballet|Royal Opera|ROH Live|Met Opera)\b/i.test(
    title,
  );
}

function validHttpUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function verifiedColdharbourArtwork(value: string | null | undefined): string | null {
  const candidate = validHttpUrl(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "coldharbourblue.com" && url.hostname !== "www.coldharbourblue.com") {
      return null;
    }
    if (!url.pathname.startsWith("/wp-content/uploads/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const KNOWN_FILM_STRAND_PREFIXES = ["Weird Wednesday"] as const;

function titleMetadata(filmTitle: string): {
  film_title_hint: string | null;
  source_release_year: number | null;
} {
  const title = cleanTitle(filmTitle);
  const suffix = title.match(/\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
  const source_release_year = suffix ? parseExplicitYear(suffix[1]) : null;
  let film_title_hint = title.replace(/\s*\((?:18|19|20|21)\d{2}\)\s*$/, "").trim();

  for (const prefix of KNOWN_FILM_STRAND_PREFIXES) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    film_title_hint = film_title_hint.replace(
      new RegExp(`^${escapedPrefix}\\s*[-–—:]\\s*`, "i"),
      "",
    );
  }

  return { film_title_hint: film_title_hint || null, source_release_year };
}

function explicitScreeningMetadata(event: TribeEvent, displayTitle: string) {
  const labels = eventLabels(event);
  const description = textFromHtml(event.description ?? event.excerpt ?? "");
  const explicitPhrases: string[] = [];

  const titleSignals = [
    /\b(?:35|70)\s*mm\b/i,
    /\bIMAX\b/i,
    /\bQ\s*(?:&|\+)\s*A\b/i,
    /\bintro(?:duction)?\b/i,
    /\brelaxed(?: screening)?\b/i,
    /\bcaptioned\b/i,
    /\baudio described\b/i,
    /\bdouble[ -]bill\b/i,
    /\bpremiere\b/i,
    /\bpreview\b/i,
  ];
  for (const pattern of titleSignals) {
    const match = displayTitle.match(pattern);
    if (match) explicitPhrases.push(match[0]);
  }

  // The site sometimes states a compilation only in its event synopsis.
  // Require the exact programme phrase rather than interpreting general prose.
  const descriptionDoubleBill = description.match(/\bdouble[ -]bill\b/i);
  if (descriptionDoubleBill) explicitPhrases.push(descriptionDoubleBill[0]);

  const titleMetadataLabels = [
    displayTitle.match(/\b(?:HOH|hard[\s_-]*of[\s_-]*hearing)\b/i)?.[0],
    displayTitle.match(/\bsubtit(?:led|les)\b/i)?.[0],
  ].filter((value): value is string => Boolean(value));

  const allExplicitLabels = [...labels, ...explicitPhrases, ...titleMetadataLabels];
  const projection_formats = normaliseProjectionFormats(allExplicitLabels);
  const accessibility_features: AccessibilityFeature[] = [];
  const programme_types: ProgrammeType[] = [];

  if (hasLabel(allExplicitLabels, /\b(?:captioned|hoh|hard[\s_-]*of[\s_-]*hearing)\b/i)) {
    accessibility_features.push("captioned");
  }
  if (hasLabel(allExplicitLabels, /\baudio[\s_-]*describ(?:ed|tion)\b/i)) {
    accessibility_features.push("audio_described");
  }
  if (hasLabel(allExplicitLabels, /\b(?:relaxed|autism[\s_-]*friendly)\b/i)) {
    accessibility_features.push("relaxed");
  }
  if (hasLabel(labels, /\bmembers?[\s_-]*only\b/i)) programme_types.push("members_only");
  if (hasLabel(labels, /\b(?:parent[\s_-]*(?:and|&)[\s_-]*baby|baby[\s_-]*club)\b/i)) {
    programme_types.push("parent_and_baby");
  }
  if (hasLabel(labels, /\b(?:child[\s_-]*required|kids?[\s_-]*club)\b/i)) {
    programme_types.push("child_required");
  }
  if (hasLabel(labels, /\bseniors?\b/i)) programme_types.push("seniors");

  const sold_out = hasLabel(labels, /\bsold[\s_-]*out\b/i);
  const screening_tags = normaliseScreeningTags(allExplicitLabels);
  const usefulLabels = Array.from(
    new Set(
      explicitPhrases
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  );

  return {
    projection_formats,
    accessibility_features,
    programme_types,
    sold_out,
    availability_status: (sold_out ? "sold_out" : "unknown") as AvailabilityStatus,
    screening_label: usefulLabels.length > 0 ? usefulLabels.join(" · ") : null,
    screening_tags,
    is_compilation: screening_tags.includes("double_bill"),
  };
}

function parseUtcStart(event: TribeEvent): string | null {
  // Coldharbour's public programme is in Europe/London, but its WordPress
  // utc_start_date currently mirrors the wall-clock value during BST. Prefer
  // start_date and perform the timezone conversion ourselves.
  if (event.start_date) {
    const m = event.start_date.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) {
      return londonToUtc(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
      ).toISOString();
    }
  }

  if (event.utc_start_date) {
    const m = event.utc_start_date.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
    );
    if (m) {
      return new Date(
        Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6] ?? 0),
        ),
      ).toISOString();
    }
  }

  return null;
}

function parseClockTime(value: string): { hour: number; minute: number } | null {
  const m = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (ampm === "am" && hour === 12) hour = 0;
  if (ampm === "pm" && hour !== 12) hour += 12;
  return { hour, minute };
}

function specialFilmInfo(event: TribeEvent): {
  film_title: string;
  start_time_iso: string;
} | null {
  const rawTitle = cleanTitle(event.title ?? "");
  const description = textFromHtml(event.description ?? event.excerpt ?? "");
  if (!rawTitle || !description || !event.start_date) return null;

  let filmTitle: string | null = null;
  let match = rawTitle.match(/^Crafty Movie Night\s*[-–—:]\s*(.+)$/i);
  if (match) filmTitle = match[1].trim();
  if (!filmTitle) {
    match = rawTitle.match(/[‘'“"]([^’'”"]+)[’'”"]\s+screening\b/i);
    if (match) filmTitle = match[1].trim();
  }
  if (!filmTitle) {
    match = rawTitle.match(/Film Festival\s*[-–—:]\s*[‘'“"]([^’'”"]+)[’'”"]/i);
    if (match) filmTitle = match[1].trim();
  }
  if (!filmTitle) {
    match = description.match(/\bscreening of\s+[‘'“"]([^’'”"]+)[’'”"]/i);
    if (match) filmTitle = match[1].trim();
  }
  if (!filmTitle) return null;

  const explicitTime = description.match(
    /\b(?:film|screening)\s+(?:starts?|begins?|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
  );
  if (!explicitTime) return null;

  const clock = parseClockTime(explicitTime[1]);
  const date = event.start_date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!clock || !date) return null;

  return {
    film_title: filmTitle,
    start_time_iso: londonToUtc(
      Number(date[1]),
      Number(date[2]),
      Number(date[3]),
      clock.hour,
      clock.minute,
    ).toISOString(),
  };
}

function eventBookingUrl(event: TribeEvent): string {
  return validHttpUrl(event.website) ?? validHttpUrl(event.url) ?? SITE_URL;
}

function baseScreening(
  event: TribeEvent,
  startTime: string,
  filmTitleForHint: string,
  sourceKind: ParsedScreening["source_kind"],
): ParsedScreening | null {
  if (!event.id) return null;
  const displayTitle = cleanTitle(event.title ?? "");
  if (!displayTitle || isExplicitNonFilmScreening(displayTitle)) return null;

  const metadata = explicitScreeningMetadata(event, displayTitle);
  const title = titleMetadata(filmTitleForHint);

  return {
    movie_title: displayTitle,
    start_time_iso: startTime,
    booking_url: eventBookingUrl(event),
    source_reference: `${SOURCE_PREFIX}:event:${event.id}`,
    sold_out: metadata.sold_out,
    projection_formats: metadata.projection_formats,
    accessibility_features: metadata.accessibility_features,
    programme_types: metadata.programme_types,
    availability_status: metadata.availability_status,
    film_title_hint: metadata.is_compilation ? null : title.film_title_hint,
    source_release_year: metadata.is_compilation ? null : title.source_release_year,
    source_event_url: validHttpUrl(event.url),
    screening_label: metadata.screening_label,
    screening_tags: metadata.screening_tags,
    verified_artwork_url: verifiedColdharbourArtwork(
      event.image && typeof event.image === "object" ? event.image.url : null,
    ),
    source_kind: sourceKind,
    event_id: event.id,
  };
}

function screeningFromTribeEvent(event: TribeEvent): ParsedScreening | null {
  const start = parseUtcStart(event);
  if (!start) return null;
  return baseScreening(event, start, cleanTitle(event.title ?? ""), "tribe-api");
}

function specialScreeningFromTribeEvent(event: TribeEvent): ParsedScreening | null {
  const info = specialFilmInfo(event);
  if (!info || isExplicitNonFilmScreening(info.film_title)) return null;
  return baseScreening(event, info.start_time_iso, info.film_title, "special-screening");
}

function findObjects(value: unknown, results: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) findObjects(item, results);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    results.push(object);
    for (const child of Object.values(object)) findObjects(child, results);
  }
  return results;
}

function parseDetailMetadata(html: string): DetailMetadata {
  const objects: Record<string, unknown>[] = [];
  const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      findObjects(JSON.parse(match[1]), objects);
    } catch {
      // Ignore malformed unrelated JSON-LD blocks.
    }
  }

  let sawSoldOutOffer = false;
  let sawAvailableOffer = false;
  let artworkUrl: string | null = null;

  for (const object of objects) {
    const sourceType = Array.isArray(object["@type"])
      ? object["@type"].map(String)
      : [String(object["@type"] ?? "")];
    const availability = typeof object.availability === "string" ? object.availability : "";
    if (sourceType.includes("Offer")) {
      if (/\b(?:OutOfStock|SoldOut)\b/i.test(availability)) sawSoldOutOffer = true;
      if (/\bInStock\b/i.test(availability)) sawAvailableOffer = true;
    }

    const imageValue = object.thumbnailUrl ?? object.contentUrl ?? object.url;
    if (!artworkUrl && typeof imageValue === "string") {
      artworkUrl = verifiedColdharbourArtwork(imageValue);
    }
  }

  return {
    fetched: true,
    // With multiple ticket types the event remains available if any offer is in stock.
    sold_out: sawAvailableOffer ? false : sawSoldOutOffer ? true : null,
    availability_status: sawAvailableOffer
      ? "available"
      : sawSoldOutOffer
        ? "sold_out"
        : null,
    artwork_url: artworkUrl,
  };
}

async function fetchDetailMetadata(eventUrl: string | null): Promise<DetailMetadata> {
  if (!eventUrl) {
    return { fetched: false, sold_out: null, availability_status: null, artwork_url: null };
  }
  try {
    const response = await fetch(eventUrl, {
      ...fetchOpts,
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    if (!response.ok) {
      return { fetched: false, sold_out: null, availability_status: null, artwork_url: null };
    }
    return parseDetailMetadata(await response.text());
  } catch {
    return { fetched: false, sold_out: null, availability_status: null, artwork_url: null };
  }
}

async function enrichDetails(screenings: ParsedScreening[]): Promise<{
  fetched: number;
  failed: number;
}> {
  let nextIndex = 0;
  let fetched = 0;
  let failed = 0;

  async function worker() {
    while (nextIndex < screenings.length) {
      const screening = screenings[nextIndex++];
      const detail = await fetchDetailMetadata(screening.source_event_url);
      if (!detail.fetched) {
        failed++;
        continue;
      }
      fetched++;
      if (detail.sold_out !== null) screening.sold_out = detail.sold_out;
      if (detail.availability_status) {
        screening.availability_status = detail.availability_status;
      }
      if (!screening.verified_artwork_url && detail.artwork_url) {
        screening.verified_artwork_url = detail.artwork_url;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, screenings.length) }, () => worker()),
  );
  return { fetched, failed };
}

async function fetchTribeEvents(nowUtc: Date): Promise<{
  screenings: ParsedScreening[];
  excluded_non_film_events: number;
  excluded_uncertain_special_screenings: number;
  detail_pages_fetched: number;
  detail_pages_failed: number;
}> {
  const all: TribeEvent[] = [];
  let totalPages: number | null = null;

  for (let page = 1; page <= MAX_API_PAGES; page++) {
    const url = new URL(EVENTS_API_URL);
    url.searchParams.set("per_page", String(API_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("start_date", nowUtc.toISOString());

    const response = await fetch(url.toString(), {
      ...fetchOpts,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`Coldharbour Tribe Events API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { events?: TribeEvent[]; total_pages?: number };
    if (!Array.isArray(payload.events)) {
      throw new Error("Coldharbour Tribe Events API response has no events array.");
    }
    all.push(...payload.events);
    if (Number.isFinite(payload.total_pages)) totalPages = Number(payload.total_pages);
    if (
      payload.events.length < API_PAGE_SIZE ||
      (totalPages !== null && page >= totalPages)
    ) break;
  }

  const screenings: ParsedScreening[] = [];
  let excludedNonFilm = 0;
  let excludedUncertainSpecial = 0;
  const seen = new Set<string>();

  for (const event of all) {
    let parsed: ParsedScreening | null = null;
    if (isScreeningCategory(event)) {
      parsed = screeningFromTribeEvent(event);
      if (!parsed) excludedNonFilm++;
    } else {
      parsed = specialScreeningFromTribeEvent(event);
      if (!parsed) {
        const title = cleanTitle(event.title ?? "");
        const text = `${title} ${textFromHtml(event.description ?? event.excerpt ?? "")}`;
        if (/\b(?:film|movie|cinema|screening)\b/i.test(text)) excludedUncertainSpecial++;
        else excludedNonFilm++;
      }
    }

    if (!parsed || seen.has(parsed.source_reference)) continue;
    seen.add(parsed.source_reference);
    screenings.push(parsed);
  }

  const detailCounts = await enrichDetails(screenings);
  return {
    screenings,
    excluded_non_film_events: excludedNonFilm,
    excluded_uncertain_special_screenings: excludedUncertainSpecial,
    detail_pages_fetched: detailCounts.fetched,
    detail_pages_failed: detailCounts.failed,
  };
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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

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
  if (runStart.blocked) {
    return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const nowUtc = new Date();
    const parsed = await fetchTribeEvents(nowUtc);
    const future = parsed.screenings
      .filter((screening) => new Date(screening.start_time_iso) > nowUtc)
      .sort((a, b) => a.start_time_iso.localeCompare(b.start_time_iso));
    const previousCount = await getPreviousActiveCount(ctx, nowUtc);

    if (
      previousCount >= RATIO_GUARD_MIN_EXISTING &&
      future.length < Math.ceil(previousCount * MIN_EXPECTED_RATIO)
    ) {
      throw new Error(
        `Count-drop guard blocked import: ${future.length} new future screenings vs ${previousCount} currently active.`,
      );
    }
    if (future.length < MIN_SCREENINGS) {
      throw new Error(`Unusually low screening count (${future.length}); database left untouched.`);
    }
    if (new Set(future.map((screening) => screening.source_reference)).size !== future.length) {
      throw new Error("Duplicate source references detected; database left untouched.");
    }

    const records: ScreeningRecord[] = future.map((screening) => ({
      cinema_name: CINEMA_NAME,
      movie_title: screening.movie_title,
      start_time: screening.start_time_iso,
      booking_url: screening.booking_url,
      format:
        screening.projection_formats.length > 0
          ? screening.projection_formats
              .map((value) => (value === "imax" ? "IMAX" : value))
              .join(", ")
          : null,
      sold_out: screening.sold_out,
      projection_formats: screening.projection_formats,
      accessibility_features: screening.accessibility_features,
      programme_types: screening.programme_types,
      availability_status: screening.availability_status,
      film_title_hint: screening.film_title_hint,
      source_release_year: screening.source_release_year,
      source_runtime_minutes: null,
      source_directors: [],
      source_countries: [],
      source_event_url: screening.source_event_url,
      screen_name: null,
      screening_label: screening.screening_label,
      screening_tags: screening.screening_tags,
      verified_artwork_url: screening.verified_artwork_url,
      source_reference: screening.source_reference,
      last_seen_at: new Date().toISOString(),
    }));

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);

    await endRun(ctx, runId, "success", future.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      source: "tribe-api-with-event-page-enrichment",
      screenings_found: future.length,
      screenings_saved: saved,
      excluded_non_film_events: parsed.excluded_non_film_events,
      excluded_uncertain_special_screenings: parsed.excluded_uncertain_special_screenings,
      special_screenings_included: future.filter(
        (screening) => screening.source_kind === "special-screening"
      ).length,
      detail_pages_fetched: parsed.detail_pages_fetched,
      detail_pages_failed: parsed.detail_pages_failed,
      previous_active: previousCount,
      screenings: future.map((screening) => ({
        title: screening.movie_title,
        film_title_hint: screening.film_title_hint,
        release_year: screening.source_release_year,
        start_time: screening.start_time_iso,
        booking_url: screening.booking_url,
        source_event_url: screening.source_event_url,
        source_reference: screening.source_reference,
        source_kind: screening.source_kind,
        availability: screening.availability_status,
        labels: screening.screening_label,
        tags: screening.screening_tags,
        artwork: screening.verified_artwork_url,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
