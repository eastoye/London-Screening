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

const CINEMA_NAME = "The Arzner";
const LISTINGS_URL = "https://thearzner.com/TheArzner.dll/WhatsOn";
const BOOKING_BASE = "https://thearzner.com/TheArzner.dll/";
const SOURCE_PREFIX = "arzner";
const MIN_SCREENINGS = 10;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;

type AvailabilityStatus = "available" | "sold_out" | "unknown";

interface SavoyPerformance {
  ID: number;
  IsSoldOut?: string;
  CC?: string;
  StartDate: string;
  StartTime: string;
  StartTimeAndNotes?: string;
  Notes?: string;
  URL?: string;
  IsOpenForSale?: boolean;
}

interface SavoyEvent {
  ID: number;
  Title: string;
  TypeDescription?: string;
  Tags?: Array<{ Format?: string }>;
  Performances?: SavoyPerformance[];
}

interface SavoyPayload {
  Events?: SavoyEvent[];
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

function extractEventsPayload(html: string): SavoyPayload {
  const marker = html.search(/\bvar\s+Events\s*=/);
  if (marker < 0) throw new Error("Official programme no longer exposes the Savoy Events JSON payload.");
  const start = html.indexOf("{", marker);
  if (start < 0) throw new Error("Savoy Events payload has no JSON object.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as SavoyPayload;
        } catch (error) {
          throw new Error(`Savoy Events JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  throw new Error("Savoy Events JSON object is truncated.");
}

function projectionFormats(event: SavoyEvent): string[] {
  const explicit = (event.Tags || []).map((tag) => tag.Format || "").join(" ");
  const formats: string[] = [];
  if (/\b35mm\b/i.test(explicit)) formats.push("35mm");
  if (/\b70mm\b/i.test(explicit)) formats.push("70mm");
  if (/\bimax\b/i.test(explicit)) formats.push("imax");
  return formats;
}

function cleanTitle(title: string): string {
  return title.replace(/\s*\(CC\)\s*$/i, "").replace(/\s+/g, " ").trim();
}

function isNonFilmEvent(event: SavoyEvent): boolean {
  return /^test\s*screening\s*$/i.test(event.TypeDescription || "") || /^test\s*screening\s*$/i.test(event.Title);
}

function performanceToRecord(event: SavoyEvent, performance: SavoyPerformance) {
  const date = performance.StartDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = performance.StartTime.match(/^(\d{2})(\d{2})$/);
  if (!date || !time || !performance.ID) return null;
  const soldOut = performance.IsSoldOut === "Y";
  const openForSale = performance.IsOpenForSale === true;
  const projection_formats = projectionFormats(event);
  const accessibility_features: string[] = [];
  if (performance.CC === "Y") accessibility_features.push("captioned");
  const url = performance.URL
    ? new URL(performance.URL, BOOKING_BASE).toString()
    : `https://thearzner.com/TheArzner.dll/WhatsOn?f=${event.ID}`;
  return {
    cinema_name: CINEMA_NAME,
    movie_title: cleanTitle(event.Title),
    start_time: londonToUtc(Number(date[1]), Number(date[2]), Number(date[3]), Number(time[1]), Number(time[2])).toISOString(),
    booking_url: url,
    format: projection_formats.length > 0
      ? projection_formats.map((value) => value === "imax" ? "IMAX" : value).join(", ")
      : null,
    sold_out: soldOut,
    projection_formats,
    accessibility_features,
    programme_types: [] as string[],
    availability_status: (soldOut ? "sold_out" : openForSale ? "available" : "unknown") as AvailabilityStatus,
    source_reference: `${SOURCE_PREFIX}:performance:${performance.ID}`,
    last_seen_at: new Date().toISOString(),
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
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ctx: ImportRunContext = { supabase, cinemaName: CINEMA_NAME, minScreenings: MIN_SCREENINGS, startedAt };
  const runStart = await startRun(ctx);
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  if (runStart.error || !runStart.runId) return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  const runId = runStart.runId;

  try {
    const response = await fetch(LISTINGS_URL, fetchOpts);
    if (!response.ok) throw new Error(`Arzner listings returned HTTP ${response.status}`);
    const payload = extractEventsPayload(await response.text());
    const events = payload.Events;
    if (!events || events.length === 0) throw new Error("Savoy Events payload is empty.");

    const excludedNonFilm: string[] = [];
    const records: Array<ScreeningRecord & {
      projection_formats: string[];
      accessibility_features: string[];
      programme_types: string[];
      availability_status: AvailabilityStatus;
    }> = [];
    const parseErrors: string[] = [];
    const references = new Set<string>();

    for (const event of events) {
      if (isNonFilmEvent(event)) {
        excludedNonFilm.push(event.Title.trim());
        continue;
      }
      for (const performance of event.Performances || []) {
        const record = performanceToRecord(event, performance);
        if (!record) {
          parseErrors.push(`${event.Title}: performance ${performance.ID || "unknown"} has invalid date/time/ID.`);
          continue;
        }
        if (references.has(record.source_reference)) {
          parseErrors.push(`${record.source_reference}: duplicate performance ID in official payload.`);
          continue;
        }
        references.add(record.source_reference);
        records.push(record as typeof records[number]);
      }
    }
    if (parseErrors.length > 0) throw new Error(`Structured source parse failed: ${parseErrors.slice(0, 5).join(" | ")}`);

    const nowUtc = new Date();
    const upcoming = records.filter((record) => new Date(record.start_time).getTime() > nowUtc.getTime());
    if (upcoming.length < MIN_SCREENINGS) throw new Error(`Unusually low screening count (${upcoming.length}); database left untouched.`);
    const previousActive = await getPreviousActiveCount(ctx, nowUtc);
    if (previousActive >= RATIO_GUARD_MIN_EXISTING && upcoming.length < Math.ceil(previousActive * MIN_EXPECTED_RATIO)) {
      throw new Error(`Suspicious count drop from ${previousActive} to ${upcoming.length}; database left untouched.`);
    }

    const { saved, errors } = await commitImport(ctx, upcoming, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);
    await endRun(ctx, runId, "success", upcoming.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: upcoming.length,
      screenings_saved: saved,
      previous_active: previousActive,
      excluded_non_film: excludedNonFilm,
      captioned: upcoming.filter((record) => record.accessibility_features.includes("captioned")).length,
      sold_out: upcoming.filter((record) => record.sold_out).length,
      examples: upcoming.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
