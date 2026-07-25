// Shared import-safety utilities used by cinema importer edge functions.
// Handles run locking, minimum-count checks, upsert, and deactivation.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Europe/London offset in minutes for a given UTC instant (DST-aware).
export function londonOffsetMinutes(dateUtc: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  });
  const parts = dtf.formatToParts(dateUtc);
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  if (!tzPart || !tzPart.value) return 0;
  const v = tzPart.value;
  const m = v.match(/([+-]?)(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = parseInt(m[2] || "0", 10);
  const minutes = parseInt(m[3] || "0", 10);
  return sign * (hours * 60 + minutes);
}

// Convert a wall-clock time in Europe/London to a UTC Date.
export function londonToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offsetMin = londonOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offsetMin * 60 * 1000);
}

// Parse a 12-hour time string like "5:35 pm" → { hour, minute } 24h.
export function parse12hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3];
  if (ampm === "am") {
    if (hour === 12) hour = 0;
  } else {
    if (hour !== 12) hour += 12;
  }
  return { hour, minute };
}

// Infer the year for a (day, month) given the current Europe/London date.
export function inferYear(day: number, month: number, nowLondon: Date): number {
  let year = nowLondon.getFullYear();
  const currentMonth = nowLondon.getMonth() + 1;
  if (month <= 3 && currentMonth >= 10) year += 1;
  if (month >= 10 && currentMonth <= 3) year -= 1;
  return year;
}

// Minimal HTML entity decoder.
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-");
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

export interface ScreeningRecord {
  cinema_name: string;
  movie_title: string;
  start_time: string;
  booking_url: string | null;
  format: string | null;
  sold_out: boolean;
  source_reference: string;
  last_seen_at: string;
  active?: boolean;
}

export interface ImportRunContext {
  supabase: ReturnType<typeof createClient>;
  cinemaName: string;
  minScreenings: number;
  startedAt: Date;
}

// Attempt to start a run. Returns the run id, or null if a run is already in
// progress for this cinema. The unique partial index on import_runs guarantees
// only one 'running' row per cinema — a second insert fails with a unique
// violation, which we catch.
export async function startRun(
  ctx: ImportRunContext
): Promise<{ runId: string | null; blocked: boolean; error?: string }> {
  const { supabase, cinemaName, startedAt } = ctx;
  const { data, error } = await supabase
    .from("import_runs")
    .insert({
      cinema_name: cinemaName,
      status: "running",
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // Unique violation on the partial index → another run is in progress.
    if (error.code === "23505") {
      return { runId: null, blocked: true };
    }
    return { runId: null, blocked: false, error: error.message };
  }
  return { runId: data.id as string, blocked: false };
}

// Mark a run as completed (success or failed) with counts and message.
export async function endRun(
  ctx: ImportRunContext,
  runId: string,
  status: "success" | "failed",
  found: number,
  saved: number,
  errorMessage?: string
): Promise<void> {
  const { supabase } = ctx;
  await supabase
    .from("import_runs")
    .update({
      status,
      completed_at: new Date().toISOString(),
      screenings_found: found,
      screenings_saved: saved,
      error_message: errorMessage ?? null,
    })
    .eq("id", runId);
}

// Upsert records in batches and deactivate missing past screenings.
// Returns { saved, errors }.
export async function commitImport(
  ctx: ImportRunContext,
  records: ScreeningRecord[],
  nowUtc: Date
): Promise<{ saved: number; errors: string[] }> {
  const { supabase, cinemaName } = ctx;
  const lastSeenAt = new Date().toISOString();
  for (const r of records) {
    r.last_seen_at = lastSeenAt;
    // Ensure reappeared screenings are marked active again.
    r.active = true;
  }

  let saved = 0;
  const errors: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase
      .from("screenings")
      .upsert(batch, { onConflict: "source_reference", ignoreDuplicates: false })
      .select("id");
    if (error) {
      console.error(`[import] upsert batch ${i} error:`, error);
      errors.push(error.message);
    } else {
      saved += batch.length;
    }
  }
  if (errors.length > 0) return { saved, errors };

  // Deactivate past screenings for this cinema.
  const { error: pastErr } = await supabase
    .from("screenings")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("cinema_name", cinemaName)
    .lt("start_time", nowUtc.toISOString())
    .eq("active", true);
  if (pastErr) errors.push(`deactivate past: ${pastErr.message}`);

  // Deactivate future screenings not seen in this import (dropped off programme).
  const { error: missingErr } = await supabase
    .from("screenings")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("cinema_name", cinemaName)
    .neq("last_seen_at", lastSeenAt)
    .gt("start_time", nowUtc.toISOString())
    .eq("active", true);
  if (missingErr) errors.push(`deactivate missing: ${missingErr.message}`);

  return { saved, errors };
}
