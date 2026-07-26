import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PCC_URL = "https://princecharlescinema.com/whats-on/";
const CINEMA_NAME = "Prince Charles Cinema";
const SOURCE_PREFIX = "pcc";

// Europe/London offset in minutes for a given UTC instant.
// DST is applied: BST = +60 (last Sun Mar → last Sun Oct), GMT = +0.
function londonOffsetMinutes(dateUtc: Date): number {
  // Compute using Intl to get the Europe/London zone offset at this instant.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  });
  const parts = dtf.formatToParts(dateUtc);
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  if (!tzPart || !tzPart.value) return 0;
  // value like "GMT" or "GMT+1" or "+01:00"
  const v = tzPart.value;
  const m = v.match(/([+-]?)(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = parseInt(m[2] || "0", 10);
  const minutes = parseInt(m[3] || "0", 10);
  return sign * (hours * 60 + minutes);
}

// Convert a wall-clock time in Europe/London to a UTC Date.
function londonToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Build a UTC Date for the wall-clock time, then subtract the offset.
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offsetMin = londonOffsetMinutes(utcGuess);
  // wall = utc + offset  =>  utc = wall - offset
  return new Date(utcGuess.getTime() - offsetMin * 60 * 1000);
}

// Parse a 12-hour time string like "5:35 pm" → { hour, minute } 24h.
function parse12hTime(t: string): { hour: number; minute: number } | null {
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

// Parse a date heading like "Sunday 19th July" → { day, month }.
// Year is inferred separately. Returns null if not parseable.
function parseDateHeading(heading: string): { day: number; month: number } | null {
  const months: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const m = heading.trim().toLowerCase().match(/(\d+)(?:st|nd|rd|th)?\s+([a-z]+)/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2];
  const month = months[monthName];
  if (!month) return null;
  return { day, month };
}

// Infer the year for a (day, month) given the current Europe/London date.
// Cinema programmes can span December → January, so a date in Jan/Feb is
// treated as next year if we're currently in Nov/Dec.
function inferYear(day: number, month: number, nowLondon: Date): number {
  let year = nowLondon.getFullYear();
  const currentMonth = nowLondon.getMonth() + 1; // 1-12
  // If the screening month is early in the year (Jan/Feb) but we're late in
  // the year (Nov/Dec), it belongs to next year.
  if (month <= 3 && currentMonth >= 10) {
    year += 1;
  }
  // If the screening month is late in the year (Oct-Dec) but we're early in
  // the year (Jan-Mar), it belonged to last year (rare, but handle it).
  if (month >= 10 && currentMonth <= 3) {
    year -= 1;
  }
  return year;
}

// Normalise a movie title for use in fallback source_reference.
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Extract the performance id from a booking URL.
// e.g. /prince-charles-cinema/booknow/31627072 → "31627072"
function extractPerformanceId(url: string): string | null {
  const m = url.match(/booknow\/(\d+)/);
  return m ? m[1] : null;
}

// Map a tag span text to a canonical modifier label.
function canonicalTag(raw: string): string {
  const t = raw.trim();
  // Normalise a few known variants.
  const map: Record<string, string> = {
    "35mm": "35mm",
    "70mm": "70mm",
    "4k": "4K",
    "sub": "SUB",
    "hoh": "HOH",
    "q&a": "Q&A",
    "intro": "Intro",
    "vid intro": "Vid Intro",
    "ukpremiere": "UKPremiere",
    "premiere": "Premiere",
    "preview": "Preview",
    "live score": "LIVE SCORE",
    "w/ short": "w/ Short",
    "£1 mem": "£1 MEM",
  };
  return map[t.toLowerCase()] ?? t;
}

interface Screening {
  cinema_name: string;
  movie_title: string;
  start_time: string; // ISO UTC
  booking_url: string | null;
  format: string | null;
  sold_out: boolean;
  source_reference: string;
  last_seen_at: string;
}

interface ParsedScreening {
  movie_title: string;
  date_heading: string;
  time_text: string;
  booking_url: string | null;
  sold_out: boolean;
  tags: string[];
  source_reference: string;
  start_time_utc: Date | null;
  parse_error?: string;
}

// Minimal HTML entity decoder for text we care about.
function decodeEntities(s: string): string {
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

// Extract text content of an HTML fragment (strip tags).
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// Split HTML by a regex that captures a delimiter, returning [pre, delim, body, delim, body, ...]
// like String.prototype.split with a capturing group.
function splitCapture(html: string, re: RegExp): string[] {
  return html.split(re);
}

// Parse the whole programme HTML into per-screening records.
function parseProgramme(html: string, nowLondon: Date): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  // Split into film event blocks. Each event starts with
  // <div class="jacro-event movie-tabs row ..."> and ends before the next one.
  const eventDelim = /(<div class="jacro-event movie-tabs row)/;
  const parts = splitCapture(html, eventDelim);
  const events: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (i + 1 < parts.length) {
      events.push(parts[i] + parts[i + 1]);
    }
  }

  for (const evt of events) {
    // Title
    const titleMatch = evt.match(
      /<a class="liveeventtitle" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!titleMatch) continue;
    const movieTitle = stripTags(titleMatch[2]);
    if (!movieTitle) continue;

    // Performance list
    const perfMatch = evt.match(
      /<ul class="performance-list-items">([\s\S]*?)<\/ul>/
    );
    if (!perfMatch) continue;
    const perf = perfMatch[1];

    // Split by heading divs.
    const headingDelim = /<div class="heading">([^<]+)<\/div>/;
    const chunks = splitCapture(perf, headingDelim);
    // chunks[0] is preamble, then alternating [date, itemsHtml, date, itemsHtml, ...]
    for (let i = 1; i < chunks.length; i += 2) {
      const dateHeading = chunks[i].trim();
      const itemsHtml = i + 1 < chunks.length ? chunks[i + 1] : "";

      const dateParts = parseDateHeading(dateHeading);
      if (!dateParts) {
        results.push({
          movie_title: movieTitle,
          date_heading: dateHeading,
          time_text: "",
          booking_url: null,
          sold_out: false,
          tags: [],
          source_reference: "",
          start_time_utc: null,
          parse_error: `Unparseable date heading: ${dateHeading}`,
        });
        continue;
      }
      const year = inferYear(dateParts.day, dateParts.month, nowLondon);

      // Each <li ...>...</li>
      const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
      let liMatch: RegExpExecArray | null;
      while ((liMatch = liRegex.exec(itemsHtml)) !== null) {
        const liBody = liMatch[1];

        // Time
        const timeMatch = liBody.match(/<span class="time">([^<]+)<\/span>/);
        if (!timeMatch) {
          results.push({
            movie_title: movieTitle,
            date_heading: dateHeading,
            time_text: "",
            booking_url: null,
            sold_out: false,
            tags: [],
            source_reference: "",
            start_time_utc: null,
            parse_error: `No time in li for ${movieTitle} on ${dateHeading}`,
          });
          continue;
        }
        const timeText = timeMatch[1].trim();
        const timeParts = parse12hTime(timeText);
        if (!timeParts) {
          results.push({
            movie_title: movieTitle,
            date_heading: dateHeading,
            time_text: timeText,
            booking_url: null,
            sold_out: false,
            tags: [],
            source_reference: "",
            start_time_utc: null,
            parse_error: `Unparseable time "${timeText}" for ${movieTitle} on ${dateHeading}`,
          });
          continue;
        }

        // Booking URL / sold out
        const soldOut = /class="soldfilm_book_button"/.test(liBody);
        let bookingUrl: string | null = null;
        const hrefMatch = liBody.match(
          /<a[^>]*href="([^"]*)"[^>]*class="film_book_button"/
        );
        if (hrefMatch) {
          bookingUrl = hrefMatch[1];
        }

        // Tags
        const tagMatches = liBody.matchAll(
          /<span class="tag[^"]*">([^<]+)<\/span>/g
        );
        const tags: string[] = [];
        for (const tm of tagMatches) {
          const label = canonicalTag(tm[1]);
          if (label && !tags.includes(label)) tags.push(label);
        }

        // Compute UTC datetime
        const utcDate = londonToUtc(
          year,
          dateParts.month,
          dateParts.day,
          timeParts.hour,
          timeParts.minute
        );

        // Source reference
        let sourceRef = "";
        if (bookingUrl) {
          const pid = extractPerformanceId(bookingUrl);
          if (pid) sourceRef = `${SOURCE_PREFIX}:${pid}`;
        }
        if (!sourceRef) {
          // Fallback: pcc:{normalisedTitle}:{YYYY-MM-DD}:{HH:mm}
          const yyyy = utcDate.getUTCFullYear();
          const mm = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
          const dd = String(utcDate.getUTCDate()).padStart(2, "0");
          const hh = String(utcDate.getUTCHours()).padStart(2, "0");
          const mi = String(utcDate.getUTCMinutes()).padStart(2, "0");
          sourceRef = `${SOURCE_PREFIX}:${normaliseTitle(movieTitle)}:${yyyy}-${mm}-${dd}:${hh}:${mi}`;
        }

        results.push({
          movie_title: movieTitle,
          date_heading: dateHeading,
          time_text: timeText,
          booking_url: bookingUrl,
          sold_out: soldOut,
          tags,
          source_reference: sourceRef,
          start_time_utc: utcDate,
        });
      }
    }
  }

  return results;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const importStartedAt = new Date();
  const importStartedIso = importStartedAt.toISOString();

  console.log(`[import-prince-charles] starting import at ${importStartedIso}`);

  // Supabase client with service role (bypasses RLS) for writes.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[import-prince-charles] missing Supabase env vars");
    return jsonResponse(
      {
        success: false,
        error: "Server is missing Supabase credentials.",
        import_started_at: importStartedIso,
        import_completed_at: new Date().toISOString(),
      },
      500
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Current Europe/London "now" for year inference and past-filtering.
  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  let html: string;
  try {
    const resp = await fetch(PCC_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      console.error(
        `[import-prince-charles] fetch failed: HTTP ${resp.status} ${resp.statusText}`
      );
      return jsonResponse(
        {
          success: false,
          error: `Failed to fetch programme page: HTTP ${resp.status} ${resp.statusText}`,
          screenings_found: 0,
          screenings_saved: 0,
          sold_out_screenings: 0,
          parsing_errors: [],
          import_started_at: importStartedIso,
          import_completed_at: new Date().toISOString(),
        },
        502
      );
    }
    html = await resp.text();
    console.log(`[import-prince-charles] fetched ${html.length} bytes`);
  } catch (err) {
    console.error("[import-prince-charles] fetch error:", err);
    return jsonResponse(
      {
        success: false,
        error: `Network error fetching programme page: ${err instanceof Error ? err.message : String(err)}`,
        screenings_found: 0,
        screenings_saved: 0,
        sold_out_screenings: 0,
        parsing_errors: [],
        import_started_at: importStartedIso,
        import_completed_at: new Date().toISOString(),
      },
      502
    );
  }

  let parsed: ParsedScreening[] = [];
  let parsingErrors: string[] = [];
  try {
    parsed = parseProgramme(html, nowLondon);
    parsingErrors = parsed
      .filter((p) => p.parse_error)
      .map((p) => p.parse_error as string);
    console.log(
      `[import-prince-charles] parsed ${parsed.length} screenings, ${parsingErrors.length} parse errors`
    );
  } catch (err) {
    console.error("[import-prince-charles] parse error:", err);
    return jsonResponse(
      {
        success: false,
        error: `Failed to parse programme HTML: ${err instanceof Error ? err.message : String(err)}`,
        screenings_found: 0,
        screenings_saved: 0,
        sold_out_screenings: 0,
        parsing_errors: [],
        import_started_at: importStartedIso,
        import_completed_at: new Date().toISOString(),
      },
      500
    );
  }

  // Safety: an unusually low number of screenings suggests a broken parse or
  // a changed page structure. Do not touch the DB in that case.
  const MIN_SCREENINGS_THRESHOLD = 5;
  if (parsed.length < MIN_SCREENINGS_THRESHOLD) {
    console.error(
      `[import-prince-charles] unusually low screening count: ${parsed.length}`
    );
    return jsonResponse(
      {
        success: false,
        error: `Unusually low screening count (${parsed.length}). Database left untouched.`,
        screenings_found: parsed.length,
        screenings_saved: 0,
        sold_out_screenings: 0,
        parsing_errors: parsingErrors,
        import_started_at: importStartedIso,
        import_completed_at: new Date().toISOString(),
      },
      500
    );
  }

  // Filter out screenings whose start time has already passed.
  const upcoming = parsed.filter(
    (p) => p.start_time_utc !== null && p.start_time_utc.getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  if (skippedPast > 0) {
    console.log(
      `[import-prince-charles] skipping ${skippedPast} past screenings`
    );
  }

  // Build records to upsert.
  const lastSeenAt = new Date().toISOString();
  const records: Screening[] = upcoming
    .filter((p) => p.start_time_utc !== null)
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: (p.start_time_utc as Date).toISOString(),
      booking_url: p.booking_url,
      format: p.tags.length > 0 ? p.tags.join(", ") : null,
      sold_out: p.sold_out,
      source_reference: p.source_reference,
      last_seen_at: lastSeenAt,
    }));

  const soldOutCount = records.filter((r) => r.sold_out).length;

  // Upsert in batches.
  let savedCount = 0;
  const upsertErrors: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase
      .from("screenings")
      .upsert(batch, {
        onConflict: "source_reference",
        ignoreDuplicates: false,
      })
      .select("id");
    if (error) {
      console.error(`[import-prince-charles] upsert batch ${i} error:`, error);
      upsertErrors.push(error.message);
    } else {
      savedCount += batch.length;
    }
  }

  if (upsertErrors.length > 0) {
    console.error(
      `[import-prince-charles] ${upsertErrors.length} upsert batches failed`
    );
    return jsonResponse(
      {
        success: false,
        error: `Upsert errors: ${upsertErrors.join("; ")}`,
        screenings_found: parsed.length,
        screenings_saved: savedCount,
        sold_out_screenings: soldOutCount,
        parsing_errors: parsingErrors,
        import_started_at: importStartedIso,
        import_completed_at: new Date().toISOString(),
      },
      500
    );
  }

  // Safe update: only now that the page was fetched + parsed + upserted
  // successfully, mark missing future screenings inactive.
  // 1. Mark any PCC screening whose start_time is in the past as inactive.
  // 2. Mark any PCC screening not seen in this import (last_seen_at != now) and
  //    still in the future as inactive (it dropped off the programme).
  try {
    const { error: pastErr } = await supabase
      .from("screenings")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("cinema_name", CINEMA_NAME)
      .lt("start_time", nowUtc.toISOString())
      .eq("active", true);
    if (pastErr) {
      console.error("[import-prince-charles] deactivate-past error:", pastErr);
      upsertErrors.push(`deactivate past: ${pastErr.message}`);
    }

    const { error: missingErr } = await supabase
      .from("screenings")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("cinema_name", CINEMA_NAME)
      .neq("last_seen_at", lastSeenAt)
      .gt("start_time", nowUtc.toISOString())
      .eq("active", true);
    if (missingErr) {
      console.error("[import-prince-charles] deactivate-missing error:", missingErr);
      upsertErrors.push(`deactivate missing: ${missingErr.message}`);
    }
  } catch (err) {
    console.error("[import-prince-charles] deactivate error:", err);
    upsertErrors.push(
      `deactivate exception: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const importCompletedIso = new Date().toISOString();
  console.log(
    `[import-prince-charles] done: found=${parsed.length} saved=${savedCount} sold_out=${soldOutCount} parse_errors=${parsingErrors.length}`
  );

  return jsonResponse({
    success: upsertErrors.length === 0,
    screenings_found: parsed.length,
    screenings_saved: savedCount,
    sold_out_screenings: soldOutCount,
    parsing_errors: parsingErrors,
    import_started_at: importStartedIso,
    import_completed_at: importCompletedIso,
  });
});
