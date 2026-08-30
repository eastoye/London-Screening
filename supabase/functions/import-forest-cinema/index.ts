import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const CINEMA_NAME = "Forest Cinema Walthamstow";
const LISTINGS_URL = "https://www.forestcinema.co.uk/whatson";
const SOURCE_PREFIX = "forest-walthamstow";
const MIN_SCREENINGS = 5;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;

type AvailabilityStatus = "available" | "sold_out" | "unknown";

interface StructuredPerformance {
  code: string;
  eventCode: string;
  performanceType: string;
  timestamp: number;
  soldOut: boolean;
  subtitled: boolean;
  audioDescription: boolean;
  hardOfHearing: boolean;
  autismFriendly: boolean;
  memberOnly: boolean;
  tags: string;
  suffix: string;
  bookingUrl: string;
}

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string;
  booking_url: string;
  source_reference: string;
  sold_out: boolean;
  projection_formats: string[];
  accessibility_features: string[];
  programme_types: string[];
  availability_status: AvailabilityStatus;
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

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractString(block: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`\\["${escaped}"\\]=>\\s*string\\(\\d+\\) "([^"]*)"`))?.[1] || "";
}

function extractInt(block: string, key: string): number | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = block.match(new RegExp(`\\["${escaped}"\\]=>\\s*int\\((\\d+)\\)`))?.[1];
  return value ? Number(value) : null;
}

function extractBool(block: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`\\["${escaped}"\\]=>\\s*bool\\((true|false)\\)`))?.[1] === "true";
}

function parseTitleMap(html: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const match of html.matchAll(/<a[^>]+href=["'](?:https?:\/\/www\.forestcinema\.co\.uk)?\/event\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = textFromHtml(match[2]);
    if (title && !/^(details|show more)$/i.test(title)) titles.set(match[1], title);
  }
  return titles;
}

function parsePerformance(block: string): StructuredPerformance | null {
  const code = extractString(block, "code");
  const eventCode = extractString(block, "eventcode");
  const timestamp = extractInt(block, "time");
  const bookingUrl = decodeEntities(extractString(block, "link"));
  if (!code || !eventCode || !timestamp || !bookingUrl) return null;
  return {
    code,
    eventCode,
    performanceType: extractString(block, "perftype"),
    timestamp,
    soldOut: extractBool(block, "soldout"),
    subtitled: extractBool(block, "subtitled"),
    audioDescription: extractBool(block, "audiodescription"),
    hardOfHearing: extractBool(block, "hoh"),
    autismFriendly: extractBool(block, "autismfriendly"),
    memberOnly: extractBool(block, "memberonly"),
    tags: extractString(block, "performancetags"),
    suffix: extractString(block, "suffix"),
    bookingUrl,
  };
}

function structuredMetadata(performance: StructuredPerformance) {
  const explicit = `${performance.tags} ${performance.suffix}`;
  const projection_formats: string[] = [];
  if (/\b35mm\b/i.test(explicit)) projection_formats.push("35mm");
  if (/\b70mm\b/i.test(explicit)) projection_formats.push("70mm");
  if (/\bimax\b/i.test(explicit)) projection_formats.push("imax");

  const accessibility_features: string[] = [];
  if (performance.subtitled || performance.hardOfHearing || /\b(?:subtitled|captioned|hoh)\b/i.test(explicit)) {
    accessibility_features.push("captioned");
  }
  if (performance.audioDescription || /\baudio\s*describ(?:ed|tion)\b/i.test(explicit)) {
    accessibility_features.push("audio_described");
  }
  if (performance.autismFriendly || /\b(?:autism\s*friendly|relaxed)\b/i.test(explicit)) {
    accessibility_features.push("relaxed");
  }

  const programme_types: string[] = [];
  if (performance.memberOnly || /\bmembers?\s*only\b/i.test(explicit)) programme_types.push("members_only");
  if (/\b(?:parent\s*(?:and|&)\s*baby|baby\s*club)\b/i.test(explicit)) programme_types.push("parent_and_baby");
  if (/\b(?:forest\s*juniors?|child\s*required)\b/i.test(explicit)) programme_types.push("child_required");
  if (/\b(?:forest\s*seniors?|seniors?)\b/i.test(explicit)) programme_types.push("seniors");
  return { projection_formats, accessibility_features, programme_types };
}

function parseListings(html: string): { screenings: ParsedScreening[]; excludedEvents: number; errors: string[] } {
  const titles = parseTitleMap(html);
  const screenings: ParsedScreening[] = [];
  const errors: string[] = [];
  let excludedEvents = 0;
  const seen = new Set<string>();

  for (const match of html.matchAll(/<!--([\s\S]*?object\(web_performance\)[\s\S]*?)-->/gi)) {
    const performance = parsePerformance(match[1]);
    if (!performance) {
      errors.push("Found an Admit One performance object without its stable ID, timestamp or booking URL.");
      continue;
    }
    if (performance.performanceType.toUpperCase() === "EVENT") {
      excludedEvents++;
      continue;
    }
    const title = titles.get(performance.eventCode);
    if (!title) {
      errors.push(`Performance ${performance.code} refers to event ${performance.eventCode} with no title.`);
      continue;
    }
    const source_reference = `${SOURCE_PREFIX}:performance:${performance.code}`;
    if (seen.has(source_reference)) continue;
    seen.add(source_reference);
    const metadata = structuredMetadata(performance);
    screenings.push({
      movie_title: title,
      start_time_iso: new Date(performance.timestamp * 1000).toISOString(),
      booking_url: performance.bookingUrl,
      source_reference,
      sold_out: performance.soldOut,
      projection_formats: metadata.projection_formats,
      accessibility_features: metadata.accessibility_features,
      programme_types: metadata.programme_types,
      availability_status: performance.soldOut ? "sold_out" : "available",
    });
  }
  return { screenings, excludedEvents, errors };
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
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const response = await fetch(LISTINGS_URL, fetchOpts);
    if (!response.ok) throw new Error(`Forest listings returned HTTP ${response.status}`);
    const html = await response.text();
    if (!html.includes("object(web_performance)")) throw new Error("Official listings page no longer contains Admit One performance objects.");

    const parsed = parseListings(html);
    if (parsed.errors.length) throw new Error(`Structured source parse failed: ${parsed.errors.slice(0, 5).join(" | ")}`);
    const nowUtc = new Date();
    const future = parsed.screenings.filter((s) => new Date(s.start_time_iso) > nowUtc);
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
    })) as Array<ScreeningRecord & {
      projection_formats: string[];
      accessibility_features: string[];
      programme_types: string[];
      availability_status: AvailabilityStatus;
    }>;

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);
    await endRun(ctx, runId, "success", future.length, saved);
    return jsonResponse({ success: true, cinema: CINEMA_NAME, screenings_found: future.length, screenings_saved: saved, excluded_non_film_events: parsed.excludedEvents, previous_active: previousCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});

