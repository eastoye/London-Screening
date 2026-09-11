import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  buildSourceMetadata,
  type ElectricFilm,
  type ElectricScreening,
  type ElectricScreeningType,
} from "./metadata.ts";

const DATA_URL = "https://www.electriccinema.co.uk/data/data.json";
const BASE_URL = "https://www.electriccinema.co.uk";
const LOCK_NAME = "Electric Cinemas";
const MIN_SCREENINGS = 3;
const MAX_COUNT_DROP_RATIO = 0.5;
const REQUEST_TIMEOUT_MS = 15_000;

const CINEMA_MAP: Record<string, string> = {
  "603": "Electric Cinema Portobello",
  "602": "Electric Cinema White City",
};

const SOURCE_PREFIX_MAP: Record<string, string> = {
  "603": "electric:portobello",
  "602": "electric:white-city",
};

interface ElectricData {
  films: Record<string, ElectricFilm>;
  screenings: Record<string, ElectricScreening>;
  screeningTypes: Record<string, ElectricScreeningType>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateData(value: unknown): ElectricData {
  if (!isRecord(value) || !isRecord(value.films) || !isRecord(value.screenings) || !isRecord(value.screeningTypes)) {
    throw new Error("Official JSON feed is missing films, screenings or screeningTypes.");
  }
  return value as unknown as ElectricData;
}

async function fetchData(): Promise<ElectricData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DATA_URL}?a=${Date.now()}`, {
      headers: {
        "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
        Accept: "application/json",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Official JSON feed returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) throw new Error(`Official feed returned ${contentType || "an unknown content type"}, not JSON.`);
    return validateData(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function parseStart(screening: ElectricScreening): Date | null {
  const date = screening.d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = screening.t.match(/^(\d{1,2}):(\d{2})$/);
  if (!date || !time) return null;
  const values = [...date.slice(1), ...time.slice(1)].map(Number);
  if (values.some((value) => !Number.isInteger(value))) return null;
  const [year, month, day, hour, minute] = values;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return londonToUtc(year, month, day, hour, minute);
}

function validateUnique(records: ScreeningRecord[]): string | null {
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const record of records) {
    if (references.has(record.source_reference)) return `Duplicate source reference: ${record.source_reference}`;
    references.add(record.source_reference);
    const titleTime = `${record.cinema_name}|${record.movie_title.toLowerCase()}|${record.start_time}`;
    if (titleTimes.has(titleTime)) return `Duplicate title/time: ${record.movie_title} at ${record.start_time}`;
    titleTimes.add(titleTime);
  }
  return null;
}

async function enforceCountDrop(
  supabase: ReturnType<typeof createClient>,
  cinemaName: string,
  parsedCount: number,
  nowUtc: Date
): Promise<void> {
  const { count, error } = await supabase
    .from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", cinemaName)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not check ${cinemaName} coverage: ${error.message}`);
  if ((count ?? 0) >= 10 && parsedCount < Math.ceil((count ?? 0) * MAX_COUNT_DROP_RATIO)) {
    throw new Error(`${cinemaName} count-drop safeguard: parsed ${parsedCount} versus ${count} existing future screenings.`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const lockCtx: ImportRunContext = { supabase, cinemaName: LOCK_NAME, minScreenings: MIN_SCREENINGS, startedAt };
  const runStart = await startRun(lockCtx);
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Another Electric Cinemas import is already running." }, 409);
  if (runStart.error || !runStart.runId) return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  const runId = runStart.runId;

  let found = 0;
  try {
    const data = await fetchData();
    const nowUtc = new Date();
    const recordsByVenue: Record<string, ScreeningRecord[]> = Object.fromEntries(
      Object.values(CINEMA_MAP).map((cinemaName) => [cinemaName, []])
    );
    const parseErrors: string[] = [];
    const unknownTypes = new Set<string>();

    for (const [feedKey, screening] of Object.entries(data.screenings)) {
      const cinemaName = CINEMA_MAP[String(screening.cinema)];
      if (!cinemaName) continue;
      found += 1;
      if (String(screening.id) !== feedKey) {
        parseErrors.push(`Screening key ${feedKey} does not match id ${screening.id}.`);
        continue;
      }
      const film = data.films[String(screening.film)];
      if (!film?.title?.trim()) {
        parseErrors.push(`Screening ${screening.id} has no matching titled film.`);
        continue;
      }
      const start = parseStart(screening);
      if (!start) {
        parseErrors.push(`Screening ${screening.id} has invalid date/time ${screening.d} ${screening.t}.`);
        continue;
      }
      if (start.getTime() <= nowUtc.getTime()) continue;

      const typeCode = screening.st?.trim() ?? "";
      const typeInfo = typeCode ? data.screeningTypes[typeCode] : undefined;
      if (typeCode && !typeInfo) unknownTypes.add(typeCode);
      const metadata = buildSourceMetadata(film, screening, typeInfo);
      const projectionLabel = metadata.projectionFormats.length ? metadata.projectionFormats.join(", ") : null;
      recordsByVenue[cinemaName].push({
        cinema_name: cinemaName,
        movie_title: film.title.trim(),
        film_title_hint: metadata.filmTitleHint,
        start_time: start.toISOString(),
        booking_url: metadata.bookingUrl,
        format: projectionLabel,
        sold_out: metadata.soldOut,
        projection_formats: metadata.projectionFormats,
        accessibility_features: metadata.accessibilityFeatures,
        programme_types: metadata.programmeTypes,
        availability_status: metadata.availabilityStatus,
        source_release_year: metadata.releaseYear,
        source_runtime_minutes: null,
        source_directors: metadata.directors,
        source_countries: [],
        source_event_url: metadata.eventUrl,
        screen_name: metadata.screenName,
        screening_label: metadata.screeningLabel,
        screening_tags: metadata.screeningTags,
        verified_artwork_url: metadata.artworkUrl,
        source_reference: `${SOURCE_PREFIX_MAP[String(screening.cinema)]}:${screening.id}`,
        last_seen_at: startedAt.toISOString(),
      });
    }

    if (parseErrors.length) throw new Error(`Feed parsing was incomplete: ${parseErrors.slice(0, 5).join("; ")}`);
    const allRecords = Object.values(recordsByVenue).flat();
    const duplicateError = validateUnique(allRecords);
    if (duplicateError) throw new Error(duplicateError);

    for (const [cinemaName, records] of Object.entries(recordsByVenue)) {
      if (records.length < MIN_SCREENINGS) throw new Error(`${cinemaName} screening count too low (${records.length}); database left untouched.`);
      await enforceCountDrop(supabase, cinemaName, records.length, nowUtc);
    }

    let saved = 0;
    const venues = [];
    for (const [cinemaName, records] of Object.entries(recordsByVenue)) {
      const venueCtx: ImportRunContext = { supabase, cinemaName, minScreenings: MIN_SCREENINGS, startedAt };
      const result = await commitImport(venueCtx, records, nowUtc);
      if (result.errors.length) throw new Error(`${cinemaName}: ${result.errors.join("; ")}`);
      saved += result.saved;
      venues.push({ cinema_name: cinemaName, screenings_found: records.length, screenings_saved: result.saved });
    }

    await endRun(lockCtx, runId, "success", found, saved);
    return jsonResponse({
      success: true,
      venues,
      total_feed_screenings: found,
      total_screenings_saved: saved,
      unknown_screening_types: Array.from(unknownTypes),
      examples: Object.fromEntries(Object.entries(recordsByVenue).map(([name, records]) => [name, records.slice(0, 4)])),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(lockCtx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
