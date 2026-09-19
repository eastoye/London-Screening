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
import {
  availabilityFromSignals,
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  type AccessibilityFeature,
  type ProgrammeType,
} from "../_shared/screeningMetadata.ts";
import {
  fetchAllScreenings,
  type SpektrixConfig,
  type SpektrixEvent,
} from "./spektrixParser.ts";

const CINEMA_NAME = "Riverside Studios";
const MIN_SCREENINGS = 3;

const config: SpektrixConfig = {
  client: "riversidestudios",
  baseUrl: "https://spektrix.riversidestudios.co.uk",
  sourcePrefix: "riverside",
};

// Riverside classifies film screenings via attribute_EventType.
// Accept "Cinema" and "Event Cinema" types.
// Exclude Theatre, Television, Talks & Events, Comedy, Music, etc.
const CINEMA_EVENT_TYPES = new Set([
  "Cinema",
  "Event Cinema",
]);

function isCinemaEvent(event: SpektrixEvent): boolean {
  const eventType = (event.attributes.attribute_EventType as string) || "";
  if (!CINEMA_EVENT_TYPES.has(eventType)) return false;

  // Riverside currently exposes one internal test record as Cinema.
  // Exclude only this exact proven test signature; preserve all other Cinema/Event Cinema coverage.
  if (
    /^Web Test$/i.test(event.name.trim()) &&
    /^TEST$/i.test(event.description.trim()) &&
    event.duration === 0
  ) {
    return false;
  }

  return true;
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function explicitEventLabels(title: string): string[] {
  const labels: string[] = [];
  if (/\bQ\s*(?:&|\+)\s*A\b/i.test(title)) labels.push("Q&A");
  if (/\bDirector\s+Intro(?:duction)?\b|\bIntro(?:duction)?\b/i.test(title)) labels.push("Introduction");
  if (/\bPremiere\b/i.test(title)) labels.push("Premiere");
  if (/\bPreview\b/i.test(title)) labels.push("Preview");
  if (/\bAnniversary\b/i.test(title)) labels.push("Anniversary");
  if (/\bDouble[ -]Bill\b/i.test(title)) labels.push("Double Bill");
  if (/\bLive Music\b|\bLive Score\b|\bLive Accompaniment\b/i.test(title)) labels.push("Live Music");
  if (/\bSing[ -]?along\b/i.test(title)) labels.push("Singalong");
  if (/\bNo (?:Ads|Adverts|Trailers)\b/i.test(title)) labels.push("No Adverts");
  if (/\bFamily Friendly\b/i.test(title)) labels.push("Family Friendly");
  if (/\bSEND Friendly\b/i.test(title)) labels.push("SEND Friendly");
  if (/\bRestoration\b|\bRestored\b/i.test(title)) labels.push("Restoration");
  if (/\bRe-?release\b/i.test(title)) labels.push("Rerelease");
  return compactStrings(labels);
}

function projectionMetadata(
  title: string,
  sourceFormat: unknown,
): { legacy: string | null; structured: ("35mm" | "70mm" | "imax")[] } {
  const evidence = compactStrings([
    clean(sourceFormat) || null,
    ...(title.match(/\b(?:35\s*mm|70\s*mm|IMAX)\b/gi) ?? []),
  ]);
  const structured = normaliseProjectionFormats(evidence);
  return {
    structured,
    legacy: structured.map((value) => value === "imax" ? "IMAX" : value).join(", ") || null,
  };
}

function structuredMetadata(s: {
  movie_title: string;
  booking_url: string;
  labels: string[];
  event_attributes: Record<string, unknown>;
  instance_attributes: Record<string, unknown>;
  instance_is_on_sale: boolean;
}) {
  const access = clean(s.instance_attributes.attribute_Access);
  const accessibility: AccessibilityFeature[] = [];
  if (
    s.instance_attributes.attribute_Captioned === true ||
    /^(?:Captioned|Captioned Screening|Captioned Performance)$/i.test(access)
  ) accessibility.push("captioned");
  if (
    s.instance_attributes.attribute_AudioDescribed === true ||
    /^(?:AD|Audio[ -]?Described|Audio[ -]?Described Screening|Audio[ -]?Described Performance)$/i.test(access)
  ) accessibility.push("audio_described");
  if (
    s.instance_attributes.attribute_Relaxed === true ||
    /^(?:Relaxed|Relaxed Screening|Relaxed Performance)$/i.test(access)
  ) accessibility.push("relaxed");

  const programmes: ProgrammeType[] = [];
  if (/\bMembers?(?:'|’)?(?: Only)? Screening\b/i.test(s.movie_title)) programmes.push("members_only");
  if (/\bParents?\s*(?:&|and)\s*Baby\b/i.test(s.movie_title)) programmes.push("parent_and_baby");
  if (/\bChild Required\b/i.test(s.movie_title)) programmes.push("child_required");
  if (/\bSeniors?(?:'|’)?(?: Only)? Screening\b/i.test(s.movie_title)) programmes.push("seniors");

  const eventLabels = explicitEventLabels(s.movie_title);
  const tagEvidence = [
    ...eventLabels,
    s.instance_attributes.attribute_SubtitledInEnglish === true ? "Subtitled" : null,
  ];
  const label = compactStrings([access || null, ...eventLabels]).join("; ") || null;

  // Riverside exposes on-sale state but no reliable explicit sold-out flag.
  const soldOut = false;
  return {
    accessibility,
    programmes,
    eventLabels,
    screeningTags: normaliseScreeningTags(tagEvidence),
    screeningLabel: label,
    soldOut,
    availability: availabilityFromSignals({
      soldOut,
      openForSale: s.instance_is_on_sale,
      hasBookingUrl: Boolean(s.booking_url),
    }),
  };
}

function sourceArtwork(s: { event_image_url: string; event_thumbnail_url: string }): string | null {
  const value = s.event_image_url.trim() || s.event_thumbnail_url.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceDirectors(attributes: Record<string, unknown>): string[] {
  const value = clean(attributes.attribute_Director);
  return value ? compactStrings(value.split(/\s*(?:,|\band\b|&)\s*/i)) : [];
}

function screenName(value: string | null): string | null {
  const match = clean(value).match(/^Screen\s+(\d+)(?:\s*-\s*GA)?$/i);
  return match ? `Screen ${match[1]}` : null;
}

async function fetchProgramme(nowUtc: Date) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchAllScreenings(config, isCinemaEvent, { fromDate: nowUtc });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function duplicates(records: ScreeningRecord[], key: (record: ScreeningRecord) => string): string[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-riverside] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Riverside Studios.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const nowUtc = new Date();
    const result = await fetchProgramme(nowUtc);

    console.log(
      `[import-riverside] events=${result.eventsCount} cinemaEvents=${result.cinemaEventsCount} instances=${result.instancesFetched} screenings=${result.screenings.length}`
    );

    if (result.screenings.length < MIN_SCREENINGS) {
      const msg = `Unusually low screening count (${result.screenings.length}). Database left untouched.`;
      await endRun(ctx, runId, "failed", result.screenings.length, 0, msg);
      return jsonResponse(
        { success: false, error: msg, screenings_found: result.screenings.length },
        500
      );
    }

    const records: ScreeningRecord[] = result.screenings.map((s) => {
      const projection = projectionMetadata(s.movie_title, s.event_attributes.attribute_Format);
      const metadata = structuredMetadata(s);
      return {
        cinema_name: CINEMA_NAME,
        movie_title: s.movie_title,
        start_time: s.start_time_iso,
        booking_url: s.booking_url,
        format: projection.legacy,
        sold_out: metadata.soldOut,
        projection_formats: projection.structured,
        accessibility_features: metadata.accessibility,
        programme_types: metadata.programmes,
        availability_status: metadata.availability,
        film_title_hint: null,
        source_release_year: parseExplicitYear(s.event_attributes.attribute_YearOfRelease as string | number | null | undefined),
        source_runtime_minutes:
          Number.isInteger(s.event_duration) && s.event_duration > 0 && s.event_duration <= 1440
            ? s.event_duration
            : null,
        source_directors: sourceDirectors(s.event_attributes),
        source_countries: [],
        source_event_url: null,
        screen_name: screenName(s.screen_name),
        screening_label: metadata.screeningLabel,
        screening_tags: metadata.screeningTags,
        verified_artwork_url: sourceArtwork(s),
        source_reference: s.source_reference,
        last_seen_at: nowUtc.toISOString(),
      };
    });

    const duplicateReferences = duplicates(records, (record) => record.source_reference);
    if (duplicateReferences.length) {
      throw new Error(`Duplicate Riverside references: ${duplicateReferences.slice(0, 5).join(", ")}`);
    }
    const duplicateTitleTimes = duplicates(records, (record) => `${record.movie_title}\u0000${record.start_time}`);
    if (duplicateTitleTimes.length) {
      throw new Error(`Duplicate Riverside title/time rows (${duplicateTitleTimes.length})`);
    }

    const { count: previous, error: countError } = await ctx.supabase
      .from("screenings")
      .select("id", { count: "exact", head: true })
      .eq("cinema_name", CINEMA_NAME)
      .eq("active", true)
      .gt("start_time", nowUtc.toISOString());
    if (countError) throw new Error(`Could not read previous Riverside count: ${countError.message}`);
    if ((previous ?? 0) >= 10 && records.length < Math.ceil((previous ?? 0) * 0.5)) {
      throw new Error(`Suspicious Riverside count drop from ${previous} to ${records.length}`);
    }

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) {
      const msg = `Import errors: ${errors.join("; ")}`;
      await endRun(ctx, runId, "failed", result.screenings.length, saved, msg);
      return jsonResponse(
        { success: false, error: msg, screenings_found: result.screenings.length, screenings_saved: saved },
        500
      );
    }

    await endRun(ctx, runId, "success", result.screenings.length, saved);
    console.log(`[import-riverside] done: found=${result.screenings.length} saved=${saved}`);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: result.screenings.length,
      screenings_saved: saved,
      previous_active: previous ?? 0,
      events_total: result.eventsCount,
      cinema_events: result.cinemaEventsCount,
      instances_fetched: result.instancesFetched,
      fetch_errors: result.errors.slice(0, 10),
      metadata_population: {
        release_years: records.filter((record) => record.source_release_year).length,
        runtimes: records.filter((record) => record.source_runtime_minutes).length,
        directors: records.filter((record) => record.source_directors?.length).length,
        artwork: records.filter((record) => record.verified_artwork_url).length,
        screens: records.filter((record) => record.screen_name).length,
        projection_formats: records.filter((record) => record.projection_formats?.length).length,
        accessibility: records.filter((record) => record.accessibility_features?.length).length,
        programme_types: records.filter((record) => record.programme_types?.length).length,
        screening_labels: records.filter((record) => record.screening_label).length,
        screening_tags: records.filter((record) => record.screening_tags?.length).length,
        known_availability: records.filter((record) => record.availability_status !== "unknown").length,
        sold_out: records.filter((record) => record.sold_out).length,
      },
      import_started_at: startedIso,
      import_completed_at: new Date().toISOString(),
      examples: result.screenings.slice(0, 5).map((s) => ({
        movie_title: s.movie_title,
        start_time: s.start_time_iso,
        source_reference: s.source_reference,
        booking_url: s.booking_url,
        screen: s.screen_name,
        venue: s.venue_name,
        format: s.format,
        labels: s.labels,
        sold_out: s.sold_out,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }
});
