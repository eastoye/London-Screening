import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  decodeEntities,
  stripTags,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const LEXI_URL = "https://thelexicinema.co.uk/TheLexiCinema.dll/WhatsOn";
const BOOKING_BASE = "https://thelexicinema.co.uk/TheLexiCinema.dll/";
const CINEMA_NAME = "The Lexi Cinema";
const SOURCE_PREFIX = "lexi";
const MIN_SCREENINGS = 3;

interface LexiPerformance {
  ID: number;
  IsSoldOut: string;
  BF: string; FF: string; AD: string; HOH: string; RS: string;
  QA: string; AS: string; BHS: string; TP: string; OC: string;
  SL: string; PR: string; LS: string; BR: string;
  StartDate: string;
  StartTimeAndNotes: string;
  Notes: string;
  StartTime: string;
  ReadableDate: string;
  AuditoriumName: string;
  URL: string;
  IsOpenForSale: boolean;
}

interface LexiEvent {
  ID: number;
  Title: string;
  Rating: string;
  TypeDescription: string;
  Tags: { Format: string }[];
  Performances: LexiPerformance[];
}

interface LexiData {
  Events: LexiEvent[];
}

// Build a human-readable format/label string from performance flags + notes.
function buildFormat(p: LexiPerformance): string {
  const labels: string[] = [];
  if (p.BF === "Y") labels.push("Baby-Friendly");
  if (p.FF === "Y") labels.push("Family Fun");
  if (p.AD === "Y") labels.push("Audio Described");
  if (p.HOH === "Y") labels.push("HOH Subtitled");
  if (p.RS === "Y") labels.push("Relaxed");
  if (p.QA === "Y") labels.push("Q&A");
  if (p.AS === "Y") labels.push("Autism-Friendly");
  if (p.BHS === "Y") labels.push("Black History Studies");
  if (p.TP === "Y") labels.push("Talking Pictures");
  if (p.OC === "Y") labels.push("Opening/Closing");
  if (p.SL === "Y") labels.push("Lexi Selects");
  if (p.PR === "Y") labels.push("Private");
  if (p.BR === "Y") labels.push("Brazilian");
  if (p.AuditoriumName) labels.push(p.AuditoriumName);
  if (p.Notes) labels.push(p.Notes);
  return labels.length > 0 ? labels.join(", ") : null;
}

function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

function parseLexi(html: string): ParsedScreening[] {
  const results: ParsedScreening[] = [];
  const startIdx = html.indexOf('{"Events":[');
  if (startIdx < 0) {
    throw new Error("Could not find Events JSON in Lexi page.");
  }
  let depth = 0;
  let i = startIdx;
  while (i < html.length) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  const jsonStr = html.slice(startIdx, i + 1);
  const data = JSON.parse(jsonStr) as LexiData;

  for (const ev of data.Events) {
    const title = decodeEntities(stripTags(ev.Title)).trim();
    if (!title) continue;
    for (const p of ev.Performances) {
      const timeParts = parse24hTime(p.StartTimeAndNotes);
      if (!timeParts) {
        results.push({
          movie_title: title,
          start_time_iso: null,
          booking_url: BOOKING_BASE + p.URL,
          performance_id: String(p.ID),
          format: buildFormat(p),
          sold_out: p.IsSoldOut === "Y",
          source_reference: `${SOURCE_PREFIX}:${p.ID}`,
          parse_error: `Unparseable time: "${p.StartTimeAndNotes}"`,
        });
        continue;
      }
      const dateParts = p.StartDate.split("-").map((n) => parseInt(n, 10));
      if (dateParts.length !== 3 || dateParts.some(isNaN)) {
        results.push({
          movie_title: title,
          start_time_iso: null,
          booking_url: BOOKING_BASE + p.URL,
          performance_id: String(p.ID),
          format: buildFormat(p),
          sold_out: p.IsSoldOut === "Y",
          source_reference: `${SOURCE_PREFIX}:${p.ID}`,
          parse_error: `Unparseable date: "${p.StartDate}"`,
        });
        continue;
      }
      const utc = londonToUtc(dateParts[0], dateParts[1], dateParts[2], timeParts.hour, timeParts.minute);
      results.push({
        movie_title: title,
        start_time_iso: utc.toISOString(),
        booking_url: BOOKING_BASE + p.URL,
        performance_id: String(p.ID),
        format: buildFormat(p),
        sold_out: p.IsSoldOut === "Y",
        source_reference: `${SOURCE_PREFIX}:${p.ID}`,
      });
    }
  }
  return results;
}

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string | null;
  booking_url: string;
  performance_id: string;
  format: string | null;
  sold_out: boolean;
  source_reference: string;
  parse_error?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-lexi-cinema] starting at ${startedIso}`);

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
    return jsonResponse(
      { success: false, error: "Another import is already running for The Lexi Cinema.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  let html: string;
  try {
    const resp = await fetch(LEXI_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      const msg = `Failed to fetch programme: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    html = await resp.text();
    console.log(`[import-lexi-cinema] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parseLexi(html);
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-lexi-cinema] parsed ${parsed.length} screenings, ${parseErrors.length} errors`);
  } catch (err) {
    const msg = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }

  if (parsed.length < MIN_SCREENINGS) {
    const msg = `Unusually low screening count (${parsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", parsed.length, 0, msg);
    return jsonResponse({ success: false, error: msg, screenings_found: parsed.length }, 500);
  }

  const nowUtc = new Date();
  const upcoming = parsed.filter(
    (p) => p.start_time_iso !== null && new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(`[import-lexi-cinema] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null && p.source_reference)
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: p.start_time_iso as string,
      booking_url: p.booking_url || null,
      format: p.format,
      sold_out: p.sold_out,
      source_reference: p.source_reference,
      last_seen_at: new Date().toISOString(),
    }));

  const { saved, errors } = await commitImport(ctx, records, nowUtc);
  if (errors.length > 0) {
    const msg = `Import errors: ${errors.join("; ")}`;
    await endRun(ctx, runId, "failed", parsed.length, saved, msg);
    return jsonResponse(
      { success: false, error: msg, screenings_found: parsed.length, screenings_saved: saved },
      500
    );
  }

  await endRun(ctx, runId, "success", parsed.length, saved);
  console.log(`[import-lexi-cinema] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    parse_errors: parseErrors.slice(0, 10),
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples: upcoming.slice(0, 5).map((p) => ({
      movie_title: p.movie_title,
      start_time: p.start_time_iso,
      source_reference: p.source_reference,
      booking_url: p.booking_url || null,
      format: p.format,
      sold_out: p.sold_out,
    })),
  });
});
