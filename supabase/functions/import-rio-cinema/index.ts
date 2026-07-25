// Rio Cinema (Dalston) importer.
//
// Source: https://www.riocinema.org.uk/Rio.dll/WhatsOn
// Provider: Savoy Systems. The WhatsOn page embeds a JSON blob of the form
// {"Events":[{...,"Performances":[...]}]} — the same shape used by The Lexi
// Cinema and Phoenix Cinema. Each Performance carries an ID (used as the
// stable performance id), StartDate (YYYY-MM-DD), StartTimeAndNotes (HH:MM),
// AuditoriumName (Screen 1 / Screen 2 / Ludski), IsSoldOut ("Y"/"N") and a
// relative booking URL ending in TcsPerformance_{id}.
//
// The booking URL is relative to the Rio .dll path, so it is prefixed with
// the Savoy base. Performance ID is the stable source_reference.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  commitImport,
  corsHeaders,
  decodeEntities,
  endRun,
  jsonResponse,
  londonToUtc,
  startRun,
  type ImportRunContext,
  type ScreeningRecord,
} from "../_shared/importSafety.ts";

const PROGRAMME_URL =
  "https://riocinema.org.uk/Rio.dll/WhatsOn";
const CINEMA_NAME = "Rio Cinema";
const SOURCE_PREFIX = "rio";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;

interface SavoyPerformance {
  ID?: string | number;
  StartDate?: string;
  StartTime?: string | number;
  StartTimeAndNotes?: string;
  URL?: string;
  IsSoldOut?: string | boolean;
  [key: string]: unknown;
}

interface SavoyEvent {
  Title?: string;
  Tags?: Array<Record<string, unknown>>;
  Performances?: SavoyPerformance[];
}

interface SavoyPayload {
  Events?: SavoyEvent[];
}

const PERFORMANCE_LABELS: Record<string, string> = {
  PP: "Pink Palace",
  SP: "Special Event",
  CM: "Classic Matinee",
  QA: "Q&A / Discussion",
  FF: "Family Flicks",
  HoH: "Hard of Hearing",
  RS: "Relaxed Screening",
  CB: "Carers + Baby",
  NoAds: "No Ads or Trailers",
  RF: "Rio Forever",
};

const fetchOptions: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow",
};

function extractEventsPayload(html: string): SavoyPayload {
  const markerMatch = /\bvar\s+Events\s*=\s*/.exec(html);
  if (!markerMatch) throw new Error("Savoy Events payload was not found.");

  const start = html.indexOf("{", markerMatch.index + markerMatch[0].length);
  if (start < 0) throw new Error("Savoy Events payload has no opening brace.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) {
      return JSON.parse(html.slice(start, i + 1)) as SavoyPayload;
    }
  }
  throw new Error("Savoy Events payload is incomplete.");
}

function cleanText(value: unknown): string {
  return decodeEntities(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

function parseLocalStart(
  performance: SavoyPerformance
): { iso: string; error?: never } | { iso?: never; error: string } {
  const dateMatch = String(performance.StartDate ?? "").match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );
  const compactTime = String(performance.StartTime ?? "").trim();
  let timeMatch = compactTime.match(/^(\d{2})(\d{2})$/);
  if (!timeMatch) {
    timeMatch = String(performance.StartTimeAndNotes ?? "").match(
      /\b(\d{1,2}):(\d{2})\b/
    );
  }
  if (!dateMatch || !timeMatch) {
    return {
      error: `Invalid Savoy date/time for performance ${String(performance.ID ?? "unknown")}`,
    };
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    return {
      error: `Out-of-range Savoy date/time for performance ${String(performance.ID ?? "unknown")}`,
    };
  }

  return { iso: londonToUtc(year, month, day, hour, minute).toISOString() };
}

function buildFormat(event: SavoyEvent, performance: SavoyPerformance): string | null {
  const labels: string[] = [];
  for (const tag of event.Tags ?? []) {
    for (const value of Object.values(tag)) {
      const label = cleanText(value);
      if (label) labels.push(label);
    }
  }
  for (const [key, label] of Object.entries(PERFORMANCE_LABELS)) {
    if (performance[key] === "Y" || performance[key] === true) labels.push(label);
  }
  const unique = [...new Set(labels)];
  return unique.length > 0 ? unique.join(", ") : null;
}

function parseProgramme(
  html: string,
  nowUtc: Date
): { records: ScreeningRecord[]; errors: string[]; totalPerformances: number } {
  const payload = extractEventsPayload(html);
  if (!Array.isArray(payload.Events)) {
    throw new Error("Savoy Events payload has no Events array.");
  }

  const records: ScreeningRecord[] = [];
  const errors: string[] = [];
  let totalPerformances = 0;

  for (const event of payload.Events) {
    const title = cleanText(event.Title);
    const performances = Array.isArray(event.Performances) ? event.Performances : [];
    totalPerformances += performances.length;

    for (const performance of performances) {
      const performanceId = String(performance.ID ?? "").trim();
      const rawBookingUrl = String(performance.URL ?? "").trim();
      const parsedStart = parseLocalStart(performance);
      if (!title || !performanceId || !rawBookingUrl || parsedStart.error) {
        errors.push(
          parsedStart.error ??
            `Missing title, ID or booking URL for performance ${performanceId || "unknown"}`
        );
        continue;
      }
      if (new Date(parsedStart.iso).getTime() <= nowUtc.getTime()) continue;

      let bookingUrl: string;
      try {
        bookingUrl = new URL(rawBookingUrl, PROGRAMME_URL).toString();
      } catch {
        errors.push(`Invalid booking URL for performance ${performanceId}`);
        continue;
      }

      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: title,
        start_time: parsedStart.iso,
        booking_url: bookingUrl,
        format: buildFormat(event, performance),
        sold_out: performance.IsSoldOut === "Y" || performance.IsSoldOut === true,
        source_reference: `${SOURCE_PREFIX}:${performanceId}`,
        last_seen_at: nowUtc.toISOString(),
      });
    }
  }

  return { records, errors, totalPerformances };
}

async function getPreviousActiveCount(
  ctx: ImportRunContext,
  nowUtc: Date
): Promise<number> {
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
    const response = await fetch(PROGRAMME_URL, fetchOptions);
    if (!response.ok) throw new Error(`Programme fetch returned HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 10_000) throw new Error(`Programme response was too small (${html.length} bytes)`);

    const nowUtc = new Date();
    const parsed = parseProgramme(html, nowUtc);
    if (parsed.errors.length > 0) {
      throw new Error(`Programme parse was incomplete: ${parsed.errors.slice(0, 5).join("; ")}`);
    }

    const sourceRefs = new Set(parsed.records.map((record) => record.source_reference));
    if (sourceRefs.size !== parsed.records.length) {
      throw new Error("Duplicate performance IDs were returned; database left untouched.");
    }
    if (parsed.records.length < MIN_SCREENINGS) {
      throw new Error(
        `Unusually low screening count (${parsed.records.length}); database left untouched.`
      );
    }

    const previousActive = await getPreviousActiveCount(ctx, nowUtc);
    const ratioFloor = Math.ceil(previousActive * MIN_EXPECTED_RATIO);
    if (
      previousActive >= RATIO_GUARD_MIN_EXISTING &&
      parsed.records.length < ratioFloor
    ) {
      throw new Error(
        `Suspicious count drop from ${previousActive} to ${parsed.records.length}; database left untouched.`
      );
    }

    const { saved, errors } = await commitImport(ctx, parsed.records, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);

    await endRun(ctx, runId, "success", parsed.records.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: parsed.records.length,
      screenings_saved: saved,
      performances_in_source: parsed.totalPerformances,
      previous_active: previousActive,
      import_started_at: startedAt.toISOString(),
      import_completed_at: new Date().toISOString(),
      examples: parsed.records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});


