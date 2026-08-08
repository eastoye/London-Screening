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

const CINEMA_NAME = "Barbican Cinema";
const CINEMA_URL = "https://www.barbican.org.uk/whats-on/cinema";
const BOOKING_BASE = "https://tickets.barbican.org.uk";
const SOURCE_PREFIX = "barbican";
const LOOKAHEAD_DAYS = 30;
const FETCH_BATCH_SIZE = 5;
const MIN_SCREENINGS = 10;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;

type AvailabilityStatus = "available" | "sold_out" | "unknown";

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string;
  booking_url: string | null;
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
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function londonCalendarDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Could not determine current London date");
  return `${year}-${month}-${day}`;
}

function parse12h(value: string): { hour: number; minute: number } | null {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})[.:](\d{2})\s*(am|pm)$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (match[3] === "am" && hour === 12) hour = 0;
  if (match[3] === "pm" && hour !== 12) hour += 12;
  return { hour, minute };
}

function normaliseTitleAndFormat(rawTitle: string): {
  title: string;
  projection_formats: string[];
} {
  const formats: string[] = [];
  if (/\[\s*35mm\s*\]/i.test(rawTitle)) formats.push("35mm");
  if (/\[\s*70mm\s*\]/i.test(rawTitle)) formats.push("70mm");
  if (/\[\s*imax\s*\]/i.test(rawTitle)) formats.push("imax");
  const title = rawTitle
    .replace(/\[\s*(?:35mm|70mm|imax)\s*\]/gi, "")
    .replace(/^parent\s*(?:&|and)\s*baby\s+screening\s*:\s*/i, "")
    .replace(/^relaxed\s+screening\s*:\s*/i, "")
    .replace(/^senior(?:s| community)?\s+(?:cinema|screening)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title, projection_formats: Array.from(new Set(formats)) };
}

function isClearlyNonFilm(title: string): boolean {
  if (/^panel\s*:/i.test(title) && !/\b(screening|film|cinema)\b|\+/i.test(title)) return true;
  if (/\bnetworking\b/i.test(title)) return true;
  if (/\bindustry session\b/i.test(title)) return true;
  if (/\bworkshop\b/i.test(title) && !/\b(screening|film|cinema)\b|\+/i.test(title)) return true;
  return false;
}

function normaliseMetadata(explicit: string, soldOut: boolean) {
  const accessibility_features: string[] = [];
  const programme_types: string[] = [];

  if (/\b(?:captioned|open captions?|hard of hearing|hoh)\b/i.test(explicit)) {
    accessibility_features.push("captioned");
  }
  if (/\b(?:audio described|audio description)\b/i.test(explicit)) {
    accessibility_features.push("audio_described");
  }
  if (/\brelaxed screening\b/i.test(explicit)) {
    accessibility_features.push("relaxed");
  }
  if (/\bparent\s*(?:&|and)\s*baby\b|\bparent and baby screening\b/i.test(explicit)) {
    programme_types.push("parent_and_baby");
  }
  if (/\bsenior(?:s| community)?\s+(?:cinema|screening)\b/i.test(explicit)) {
    programme_types.push("seniors");
  }
  if (/\bmembers?[- ]only\b/i.test(explicit)) {
    programme_types.push("members_only");
  }

  return {
    accessibility_features,
    programme_types,
    availability_status: (soldOut ? "sold_out" : "available") as AvailabilityStatus,
  };
}

function slugFromHref(href: string): string {
  const path = href.split("?")[0].replace(/\/$/, "");
  const slug = path.split("/").filter(Boolean).pop() || "event";
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("/")) return `https://www.barbican.org.uk${href}`;
  return `https://www.barbican.org.uk/${href}`;
}

function parseDayPage(html: string, isoDate: string): {
  screenings: ParsedScreening[];
  excluded: string[];
  errors: string[];
} {
  const [year, month, day] = isoDate.split("-").map(Number);
  const cardRegex = /<div\s+class="cinema-listing-card"[^>]*>/gi;
  const cardStarts: number[] = [];
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = cardRegex.exec(html)) !== null) cardStarts.push(cardMatch.index);

  const screenings: ParsedScreening[] = [];
  const excluded: string[] = [];
  const errors: string[] = [];

  for (let ci = 0; ci < cardStarts.length; ci++) {
    const card = html.slice(
      cardStarts[ci],
      ci + 1 < cardStarts.length ? cardStarts[ci + 1] : html.length,
    );
    const titleMatch = card.match(
      /<h2[^>]*class="cinema-listing-card__title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i,
    );
    if (!titleMatch) continue;
    const eventHref = absoluteUrl(decodeEntities(titleMatch[1]));
    const rawTitle = textFromHtml(titleMatch[2]);
    const titleData = normaliseTitleAndFormat(rawTitle);
    if (!titleData.title) continue;
    if (isClearlyNonFilm(titleData.title)) {
      excluded.push(titleData.title);
      continue;
    }

    const tagsMatch = card.match(
      /<div[^>]*class="cinema-listing-card__tags"[^>]*>([\s\S]*?)<\/div>/i,
    );
    const tagsText = tagsMatch ? textFromHtml(tagsMatch[1]) : "";
    const instanceRegex = /<div\s+class="cinema-instance-list__instance"[^>]*>/gi;
    const instanceStarts: number[] = [];
    let instanceMatch: RegExpExecArray | null;
    while ((instanceMatch = instanceRegex.exec(card)) !== null) {
      instanceStarts.push(instanceMatch.index);
    }

    for (let ii = 0; ii < instanceStarts.length; ii++) {
      const instance = card.slice(
        instanceStarts[ii],
        ii + 1 < instanceStarts.length ? instanceStarts[ii + 1] : card.length,
      );
      const timeText = textFromHtml(instance).match(/\b(\d{1,2}[.:]\d{2}\s*(?:am|pm))\b/i)?.[1];
      if (!timeText) continue;
      const time = parse12h(timeText);
      if (!time) {
        errors.push(`${titleData.title} ${isoDate}: unparseable time "${timeText}"`);
        continue;
      }

      const bookingMatch = instance.match(
        /href="(?:https:\/\/tickets\.barbican\.org\.uk)?\/choose-seats\/(\d+)"/i,
      );
      const soldOut = /\(\s*Sold\s*out\s*\)|\bSold\s*out\b/i.test(instance);
      const instanceId = bookingMatch?.[1] || null;
      const sourceReference = instanceId
        ? `${SOURCE_PREFIX}:spektrix:${instanceId}`
        : `${SOURCE_PREFIX}:soldout:${slugFromHref(eventHref)}:${isoDate}:${String(time.hour).padStart(2, "0")}${String(time.minute).padStart(2, "0")}`;

      if (!instanceId && !soldOut) {
        errors.push(`${titleData.title} ${isoDate} ${timeText}: no booking ID or sold-out marker`);
        continue;
      }

      const explicitMetadata = `${rawTitle} ${tagsText} ${textFromHtml(instance)}`;
      const metadata = normaliseMetadata(explicitMetadata, soldOut);
      const start = londonToUtc(year, month, day, time.hour, time.minute);
      screenings.push({
        movie_title: titleData.title,
        start_time_iso: start.toISOString(),
        booking_url: instanceId ? `${BOOKING_BASE}/choose-seats/${instanceId}` : eventHref,
        source_reference: sourceReference,
        sold_out: soldOut,
        projection_formats: titleData.projection_formats,
        accessibility_features: metadata.accessibility_features,
        programme_types: metadata.programme_types,
        availability_status: metadata.availability_status,
      });
    }
  }

  return { screenings, excluded, errors };
}

async function fetchDay(isoDate: string): Promise<string> {
  const response = await fetch(`${CINEMA_URL}?day=${isoDate}`, fetchOpts);
  if (!response.ok) {
    throw new Error(`Barbican ${isoDate} returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const hasListings = html.includes("cinema-listing-card");
  const isExplicitlyEmpty = /(?:there are\s+)?no\s+(?:cinema\s+listings|films|events|results)\b/i.test(html);
  if (!hasListings && !isExplicitlyEmpty) {
    throw new Error(`Barbican ${isoDate} did not contain the expected cinema listing structure`);
  }
  return html;
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
    const dates: string[] = [];
    const [todayYear, todayMonth, todayDay] = londonCalendarDate(startedAt).split("-").map(Number);
    const today = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay));
    for (let offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
      dates.push(formatDate(new Date(today.getTime() + offset * 86_400_000)));
    }

    const byReference = new Map<string, ParsedScreening>();
    const excluded = new Set<string>();
    const parseErrors: string[] = [];
    for (let i = 0; i < dates.length; i += FETCH_BATCH_SIZE) {
      const batchDates = dates.slice(i, i + FETCH_BATCH_SIZE);
      const pages = await Promise.all(batchDates.map(async (date) => ({ date, html: await fetchDay(date) })));
      for (const page of pages) {
        const parsed = parseDayPage(page.html, page.date);
        for (const title of parsed.excluded) excluded.add(title);
        parseErrors.push(...parsed.errors);
        for (const screening of parsed.screenings) {
          const existing = byReference.get(screening.source_reference);
          if (!existing) {
            byReference.set(screening.source_reference, screening);
          } else if (
            existing.movie_title !== screening.movie_title ||
            existing.start_time_iso !== screening.start_time_iso
          ) {
            parseErrors.push(`${screening.source_reference}: conflicting duplicate performance`);
          }
        }
      }
    }

    if (parseErrors.length > 0) {
      throw new Error(`Programme contained ${parseErrors.length} parse conflicts; database left untouched.`);
    }

    const nowUtc = new Date();
    const upcoming = Array.from(byReference.values()).filter(
      (screening) => new Date(screening.start_time_iso).getTime() > nowUtc.getTime(),
    );
    if (upcoming.length < MIN_SCREENINGS) {
      throw new Error(`Unusually low screening count (${upcoming.length}); database left untouched.`);
    }

    const previousActive = await getPreviousActiveCount(ctx, nowUtc);
    const ratioFloor = Math.ceil(previousActive * MIN_EXPECTED_RATIO);
    if (
      previousActive >= RATIO_GUARD_MIN_EXISTING &&
      upcoming.length < ratioFloor
    ) {
      throw new Error(
        `Suspicious count drop from ${previousActive} to ${upcoming.length}; database left untouched.`,
      );
    }

    const records = upcoming.map((screening) => ({
      cinema_name: CINEMA_NAME,
      movie_title: screening.movie_title,
      start_time: screening.start_time_iso,
      booking_url: screening.booking_url,
      format: screening.projection_formats.length > 0
        ? screening.projection_formats.map((value) => value === "imax" ? "IMAX" : value).join(", ")
        : null,
      sold_out: screening.sold_out,
      projection_formats: screening.projection_formats,
      accessibility_features: screening.accessibility_features,
      programme_types: screening.programme_types,
      availability_status: screening.availability_status,
      source_reference: screening.source_reference,
      last_seen_at: new Date().toISOString(),
    })) as Array<ScreeningRecord & {
      projection_formats: string[];
      accessibility_features: string[];
      programme_types: string[];
      availability_status: AvailabilityStatus;
    }>;

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);

    await endRun(ctx, runId, "success", upcoming.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      lookahead_days: LOOKAHEAD_DAYS,
      screenings_found: upcoming.length,
      screenings_saved: saved,
      previous_active: previousActive,
      excluded_non_film: Array.from(excluded).sort(),
      examples: upcoming.slice(0, 5),
      import_started_at: startedAt.toISOString(),
      import_completed_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
