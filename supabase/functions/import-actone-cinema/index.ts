import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders, jsonResponse, londonToUtc, decodeEntities, startRun, endRun,
  commitImport, type ScreeningRecord, type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  availabilityFromSignals, compactStrings, normaliseProjectionFormats,
  normaliseScreeningTags, parseExplicitYear, parseRuntimeMinutes,
} from "../_shared/screeningMetadata.ts";

const CINEMA_NAME = "ActOne Cinema";
const SOURCE_PREFIX = "actone";
const HOME_URL = "https://actonecinema.co.uk/ActOneCinema.dll/Home";
const MIN_SCREENINGS = 5;
const MIN_EXPECTED_RATIO = 0.5;
const NON_SCREEN_TYPES = new Set(["Fun in the Lounge", "Live Music"]);

interface ActOneSection { IsOpenForSale?: "Y" | "N" | boolean }
interface ActOnePerformance {
  ID: number; IsSoldOut?: "Y" | "N"; CC?: "Y" | "N"; AD?: "Y" | "N";
  SF?: "Y" | "N"; C1?: "Y" | "N"; CB?: "Y" | "N"; SB?: "Y" | "N";
  DB?: "Y" | "N"; QA?: "Y" | "N"; ES?: "Y" | "N"; RR?: "Y" | "N";
  RS?: "Y" | "N"; FP?: "Y" | "N"; FF?: "Y" | "N"; NA?: "Y" | "N";
  StartDate: string; StartTime?: string; StartTimeAndNotes?: string; Notes?: string;
  AuditoriumName?: string; URL?: string; IsOpenForSale?: boolean;
  Sections?: ActOneSection[];
}
interface ActOneEvent {
  ID: number; Title: string; TypeDescription?: string; RunningTime?: number | string;
  ImageURL?: string; Director?: string; Year?: string | number; Country?: string;
  URL?: string; Tags?: Array<{ Format?: string }>; Performances?: ActOnePerformance[];
}

const fetchOptions: RequestInit = {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow",
};

function extractEvents(html: string): ActOneEvent[] {
  const marker = html.indexOf("var Events");
  if (marker < 0) throw new Error("ActOne page did not contain the structured Events feed");
  const start = html.indexOf("{", marker);
  const end = html.indexOf("</script>", start);
  if (start < 0 || end < 0) throw new Error("ActOne Events feed boundaries were not found");
  const parsed = JSON.parse(html.slice(start, end).trim().replace(/;$/, "")) as { Events?: ActOneEvent[] };
  if (!Array.isArray(parsed.Events)) throw new Error("ActOne Events feed had an unexpected shape");
  return parsed.Events;
}

function parseStart(performance: ActOnePerformance): Date | null {
  const date = performance.StartDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = (performance.StartTime || performance.StartTimeAndNotes || "").match(/^(\d{2}):?(\d{2})/);
  if (!date || !time) return null;
  const hour = Number(time[1]), minute = Number(time[2]);
  if (hour > 23 || minute > 59) return null;
  return londonToUtc(Number(date[1]), Number(date[2]), Number(date[3]), hour, minute);
}

function absoluteUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return new URL(decodeEntities(value.trim()), HOME_URL).href;
}

function cleanFilmTitleHint(title: string, type: string): string | null {
  if (type !== "Film" && type !== "Special Events") return null;
  const hint = title
    .replace(/^(?:SEND FRIENDLY|CARERS?\s*(?:&|AND)\s*BABIES|CLASSICONE CINEMA CLUB)\s*:\s*/i, "")
    .replace(/\s*\+\s*(?:LIVE\s+|DIRECTOR\s+)?Q\s*(?:&|\+)\s*A\s*$/i, "")
    .replace(/\s*\+\s*(?:PANEL\s+)?DISCUSSION\s*$/i, "")
    .trim();
  if (!hint || /^HKFFUK\b/i.test(hint) || /\bIN CONVERSATION\b/i.test(hint)) return null;
  return hint === title && type !== "Film" ? null : hint;
}

function yes(value: unknown): boolean { return value === "Y" || value === true }

function labelsFor(performance: ActOnePerformance): string[] {
  const labels: string[] = [];
  const mappings: Array<[keyof ActOnePerformance, string]> = [
    ["CC", "Captions"], ["AD", "Audio Described"], ["SF", "SEND Friendly"],
    ["C1", "ClassicOne Cinema"], ["CB", "Carers & Babies"], ["SB", "Subtitled"],
    ["DB", "Dubbed"], ["QA", "Q+A"], ["ES", "EOS"], ["RR", "Rerelease"],
    ["RS", "Restoration"], ["FP", "Footprints"], ["FF", "Family Friendly"],
    ["NA", "No Ads/Trailers"],
  ];
  for (const [key, label] of mappings) if (yes(performance[key])) labels.push(label);
  if (performance.Notes?.trim()) labels.push(decodeEntities(performance.Notes.trim()));
  return labels;
}

function buildRecords(events: ActOneEvent[], nowUtc: Date) {
  const records: ScreeningRecord[] = [], excludedEvents: string[] = [], parseErrors: string[] = [];
  for (const event of events) {
    const title = decodeEntities(event.Title || "").replace(/\s+/g, " ").trim();
    const type = decodeEntities(event.TypeDescription || "").trim();
    if (!title || NON_SCREEN_TYPES.has(type)) {
      if (title) excludedEvents.push(title);
      continue;
    }
    const eventUrl = absoluteUrl(event.URL);
    const artworkUrl = absoluteUrl(event.ImageURL);
    const explicitFormats = compactStrings((event.Tags || []).map((tag) => tag.Format));
    const sourceDirectors = compactStrings([event.Director]);
    const sourceCountries = compactStrings((event.Country || "").split(/\s*(?:,|\/|;)\s*/));

    for (const performance of event.Performances || []) {
      if (!Number.isSafeInteger(performance.ID) || performance.ID <= 0) {
        throw new Error('Missing or invalid performance ID; database left untouched');
      }
      const start = parseStart(performance);
      if (!start) {
        parseErrors.push(`${event.ID}/${performance.ID}: invalid date or time`);
        continue;
      }
      if (start.getTime() <= nowUtc.getTime()) continue;
      const soldOut = yes(performance.IsSoldOut);
      const bookingUrl = absoluteUrl(performance.URL);
      const openForSale = typeof performance.IsOpenForSale === "boolean"
        ? performance.IsOpenForSale
        : performance.Sections?.some((section) => yes(section.IsOpenForSale)) ?? null;
      const labels = labelsFor(performance);
      const projectionFormats = normaliseProjectionFormats([...explicitFormats, ...labels]);
      const accessibilityFeatures = [];
      if (yes(performance.CC)) accessibilityFeatures.push("captioned" as const);
      if (yes(performance.AD)) accessibilityFeatures.push("audio_described" as const);

      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: title,
        start_time: start.toISOString(),
        booking_url: bookingUrl || eventUrl,
        format: explicitFormats.length ? explicitFormats.join(", ") : null,
        sold_out: soldOut,
        projection_formats: projectionFormats,
        accessibility_features: accessibilityFeatures,
        programme_types: yes(performance.CB) ? ["parent_and_baby"] : [],
        availability_status: availabilityFromSignals({ soldOut, openForSale, hasBookingUrl: Boolean(bookingUrl) }),
        film_title_hint: cleanFilmTitleHint(title, type),
        source_release_year: parseExplicitYear(event.Year),
        source_runtime_minutes: parseRuntimeMinutes(event.RunningTime),
        source_directors: sourceDirectors,
        source_countries: sourceCountries,
        source_event_url: eventUrl,
        screen_name: performance.AuditoriumName?.trim() || null,
        screening_label: labels.length ? labels.join(", ") : null,
        screening_tags: normaliseScreeningTags(labels),
        verified_artwork_url: artworkUrl,
        source_reference: `${SOURCE_PREFIX}:${performance.ID}`,
        last_seen_at: nowUtc.toISOString(),
      });
    }
  }
  return { records, excludedEvents, parseErrors };
}

async function previousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
  const { count, error } = await ctx.supabase.from("screenings")
    .select("id", { count: "exact", head: true }).eq("cinema_name", CINEMA_NAME)
    .eq("active", true).gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not count existing ActOne rows: ${error.message}`);
  return count || 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ctx: ImportRunContext = { supabase, cinemaName: CINEMA_NAME, minScreenings: MIN_SCREENINGS, startedAt };
  const run = await startRun(ctx);
  if (run.blocked) return jsonResponse({ success: false, blocked: true, error: "Another ActOne import is running." }, 409);
  if (run.error || !run.runId) return jsonResponse({ success: false, error: run.error || "Could not start run." }, 500);

  try {
    const response = await fetch(HOME_URL, { ...fetchOptions, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`ActOne returned HTTP ${response.status}`);
    const events = extractEvents(await response.text());
    const nowUtc = new Date();
    const parsed = buildRecords(events, nowUtc);
    if (parsed.parseErrors.length) throw new Error(`Incomplete programme: ${parsed.parseErrors.join('; ')}`);
    const seen = new Map<string, ScreeningRecord>();
    for (const record of parsed.records) {
      const previous = seen.get(record.source_reference);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
        throw new Error(`Conflicting performance: ${record.source_reference}`);
      }
      seen.set(record.source_reference, record);
    }
    const records = Array.from(new Map(parsed.records.map((record) => [record.source_reference, record])).values());
    if (records.length < MIN_SCREENINGS) throw new Error(`Unusually low screening count (${records.length}); database left untouched`);
    const previous = await previousActiveCount(ctx, nowUtc);
    if (previous >= MIN_SCREENINGS && records.length < Math.floor(previous * MIN_EXPECTED_RATIO)) {
      throw new Error(`Screening count dropped from ${previous} to ${records.length}; database left untouched`);
    }
    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length) throw new Error(`Import errors: ${errors.join("; ")}`);
    await endRun(ctx, run.runId, "success", records.length, saved);
    return jsonResponse({
      success: true, cinema: CINEMA_NAME, events_found: events.length,
      screenings_found: records.length, screenings_saved: saved, previous_active: previous,
      excluded_non_screen_events: parsed.excludedEvents, parse_errors: parsed.parseErrors.slice(0, 10),
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, run.runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
