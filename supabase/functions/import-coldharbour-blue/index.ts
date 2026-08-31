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
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
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

interface TribeTerm {
  id?: number;
  name?: string;
  slug?: string;
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
  source_kind: "tribe-api" | "special-screening";
}

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
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
  return /^(?:NT\s*Live|National Theatre Live|Royal Ballet|Royal Opera|ROH Live|Met Opera)\b/i.test(title);
}

function metadataFromLabels(event: TribeEvent) {
  const labels = eventLabels(event);
  const projection_formats = normaliseProjectionFormats(labels);
  const accessibility_features: AccessibilityFeature[] = [];
  const programme_types: ProgrammeType[] = [];

  if (hasLabel(labels, /\b(?:captioned|subtitled|hoh|hard of hearing)\b/i)) {
    accessibility_features.push("captioned");
  }
  if (hasLabel(labels, /\baudio[\s_-]*describ(?:ed|tion)\b/i)) {
    accessibility_features.push("audio_described");
  }
  if (hasLabel(labels, /\b(?:relaxed|autism[\s_-]*friendly)\b/i)) {
    accessibility_features.push("relaxed");
  }
  if (hasLabel(labels, /\bmembers?[\s_-]*only\b/i)) {
    programme_types.push("members_only");
  }
  if (hasLabel(labels, /\b(?:parent[\s_-]*(?:and|&)[\s_-]*baby|baby[\s_-]*club)\b/i)) {
    programme_types.push("parent_and_baby");
  }
  if (hasLabel(labels, /\b(?:child[\s_-]*required|kids?[\s_-]*club)\b/i)) {
    programme_types.push("child_required");
  }
  if (hasLabel(labels, /\bseniors?\b/i)) {
    programme_types.push("seniors");
  }

  const sold_out = hasLabel(labels, /\bsold[\s_-]*out\b/i);

  return {
    projection_formats,
    accessibility_features,
    programme_types,
    sold_out,
    availability_status: (sold_out ? "sold_out" : "unknown") as AvailabilityStatus,
  };
}

function parseUtcStart(event: TribeEvent): string | null {
  if (event.utc_start_date) {
    const m = event.utc_start_date.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
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

function specialFilmInfo(event: TribeEvent): { title: string; start_time_iso: string } | null {
  const rawTitle = cleanTitle(event.title ?? "");
  const description = textFromHtml(event.description ?? event.excerpt ?? "");

  if (!rawTitle || !description || !event.start_date) return null;

  let movieTitle: string | null = null;
  let m = rawTitle.match(/^Crafty Movie Night\s*[-–—:]\s*(.+)$/i);
  if (m) movieTitle = m[1].trim();

  if (!movieTitle) {
    m = rawTitle.match(/[‘'“"]([^’'”"]+)[’'”"]\s+screening\b/i);
    if (m) movieTitle = m[1].trim();
  }

  if (!movieTitle) {
    m = rawTitle.match(/Film Festival\s*[-–—:]\s*[‘'“"]([^’'”"]+)[’'”"]/i);
    if (m) movieTitle = m[1].trim();
  }

  if (!movieTitle) {
    m = description.match(/\bscreening of\s+[‘'“"]([^’'”"]+)[’'”"]/i);
    if (m) movieTitle = m[1].trim();
  }

  if (!movieTitle) return null;

  const explicitTime = description.match(
    /\b(?:film|screening)\s+(?:starts?|begins?|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
  );
  if (!explicitTime) return null;

  const clock = parseClockTime(explicitTime[1]);
  if (!clock) return null;

  const date = event.start_date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!date) return null;

  return {
    title: movieTitle,
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
  const preferred = (event.website ?? "").trim();
  if (/^https?:\/\//i.test(preferred)) return preferred;

  const eventUrl = (event.url ?? "").trim();
  if (/^https?:\/\//i.test(eventUrl)) return eventUrl;

  return SITE_URL;
}

function screeningFromTribeEvent(event: TribeEvent): ParsedScreening | null {
  if (!event.id) return null;

  const title = cleanTitle(event.title ?? "");
  if (!title || isExplicitNonFilmScreening(title)) return null;

  const start = parseUtcStart(event);
  if (!start) return null;

  const metadata = metadataFromLabels(event);

  return {
    movie_title: title,
    start_time_iso: start,
    booking_url: eventBookingUrl(event),
    source_reference: `${SOURCE_PREFIX}:event:${event.id}`,
    sold_out: metadata.sold_out,
    projection_formats: metadata.projection_formats,
    accessibility_features: metadata.accessibility_features,
    programme_types: metadata.programme_types,
    availability_status: metadata.availability_status,
    source_kind: "tribe-api",
  };
}

function specialScreeningFromTribeEvent(event: TribeEvent): ParsedScreening | null {
  if (!event.id) return null;

  const info = specialFilmInfo(event);
  if (!info || isExplicitNonFilmScreening(info.title)) return null;

  const metadata = metadataFromLabels(event);

  return {
    movie_title: info.title,
    start_time_iso: info.start_time_iso,
    booking_url: eventBookingUrl(event),
    source_reference: `${SOURCE_PREFIX}:event:${event.id}`,
    sold_out: metadata.sold_out,
    projection_formats: metadata.projection_formats,
    accessibility_features: metadata.accessibility_features,
    programme_types: metadata.programme_types,
    availability_status: metadata.availability_status,
    source_kind: "special-screening",
  };
}

async function fetchTribeEvents(nowUtc: Date): Promise<{
  screenings: ParsedScreening[];
  excluded_non_film_events: number;
  excluded_uncertain_special_screenings: number;
}> {
  const all: TribeEvent[] = [];
  let totalPages: number | null = null;

  for (let page = 1; page <= MAX_API_PAGES; page++) {
    const url = new URL(EVENTS_API_URL);
    url.searchParams.set("per_page", String(API_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("start_date", nowUtc.toISOString());

    const response = await fetch(url.toString(), fetchOpts);
    if (!response.ok) {
      throw new Error(`Coldharbour Tribe Events API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      events?: TribeEvent[];
      total_pages?: number;
    };

    if (!Array.isArray(payload.events)) {
      throw new Error("Coldharbour Tribe Events API response has no events array.");
    }

    all.push(...payload.events);

    if (Number.isFinite(payload.total_pages)) {
      totalPages = Number(payload.total_pages);
    }

    if (
      payload.events.length < API_PAGE_SIZE ||
      (totalPages !== null && page >= totalPages)
    ) {
      break;
    }
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
        if (/\b(?:film|movie|cinema|screening)\b/i.test(text)) {
          excludedUncertainSpecial++;
        } else {
          excludedNonFilm++;
        }
      }
    }

    if (!parsed || seen.has(parsed.source_reference)) continue;
    seen.add(parsed.source_reference);
    screenings.push(parsed);
  }

  return {
    screenings,
    excluded_non_film_events: excludedNonFilm,
    excluded_uncertain_special_screenings: excludedUncertainSpecial,
  };
}

async function getPreviousActiveCount(
  ctx: ImportRunContext,
  nowUtc: Date,
): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());

  if (error) {
    throw new Error(`Could not read previous screening count: ${error.message}`);
  }

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

    const records = future.map((screening) => ({
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
      source_reference: screening.source_reference,
      sold_out: screening.sold_out,
      last_seen_at: new Date().toISOString(),
      projection_formats: screening.projection_formats,
      accessibility_features: screening.accessibility_features,
      programme_types: screening.programme_types,
      availability_status: screening.availability_status,
    })) as ScreeningRecord[];

    const { saved, errors } = await commitImport(ctx, records, nowUtc);

    if (errors.length > 0) {
      throw new Error(`Import errors: ${errors.join("; ")}`);
    }

    await endRun(ctx, runId, "success", future.length, saved);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      source: "tribe-api",
      screenings_found: future.length,
      screenings_saved: saved,
      excluded_non_film_events: parsed.excluded_non_film_events,
      excluded_uncertain_special_screenings:
        parsed.excluded_uncertain_special_screenings,
      special_screenings_included: future.filter(
        (screening) => screening.source_kind === "special-screening",
      ).length,
      previous_active: previousCount,
      screenings: future.map((screening) => ({
        title: screening.movie_title,
        start_time: screening.start_time_iso,
        booking_url: screening.booking_url,
        source_reference: screening.source_reference,
        source_kind: screening.source_kind,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
