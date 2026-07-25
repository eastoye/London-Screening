import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const TMDB_SEARCH_URL = "https://api.themoviedb.org/3/search/movie";

// Cinema-specific noise to strip from a screening title before matching.
// Matches bracketed editions, format tags, and event suffixes.
const NOISE_PATTERNS: RegExp[] = [
  /\s*\[([^\]]*)\]/g, // [Director's Cut], [Extended Cut], [35mm], etc.
  /\s*\((35mm|70mm|4k|4k restoration)\s*\)/gi,
  /\s*[-–—]\s*(35mm|70mm|4k)\s*$/i,
  /\b(35mm|70mm|4k)\b/gi,
  /\b(q\s*&\s*a|q&a|intro|sub|hoh|live score|£1 mem|w\/\s*short|with short|preview|premiere|uk premiere)\b/gi,
  /\b\s+(with\s+intro|w\/\s*intro|w\/\s*short|w\/\s*q&a)\b/gi,
];

// Titles that should never be auto-matched (secret/mystery/non-film events).
const UNMATCHABLE_PATTERNS: RegExp[] = [
  /\bmystery (movie|film|screening)\b/i,
  /\bsecret (movie|film|screening|cinema)\b/i,
  /\b(secret|mystery) (screening|showing)\b/i,
  /\bmarathon\b/i,
  /\bdouble bill\b/i,
  /\btriple bill\b/i,
  /\ball[- ]?nighter\b/i,
  /\b(q&a|intro)\s+screening\b/i,
  /\blive on stage\b/i,
  /\b(night|evening) of\b/i,
  /\bpremiere\b/i,
  /\bpreview\b/i,
];

interface MovieRow {
  id: string;
  normalised_title: string;
  display_title: string;
  release_year: number | null;
  tmdb_id: number | null;
  poster_path: string | null;
  match_status: string;
  match_confidence: number | null;
}

function normaliseTitle(raw: string): { normalised: string; display: string } {
  let t = raw.trim();
  // Strip bracketed content first.
  let display = t.replace(/\s*\[[^\]]*\]/g, "").trim();
  // Strip trailing parenthesised format tags.
  display = display.replace(/\s*\((35mm|70mm|4k|4k restoration)\)/gi, "").trim();
  // Strip trailing " - 35mm" style suffixes.
  display = display.replace(/\s*[-–—]\s*(35mm|70mm|4k)\s*$/i, "").trim();
  // Strip format/event words from the display title.
  display = display
    .replace(/\b(35mm|70mm|4k)\b/gi, " ")
    .replace(
      /\b(q\s*&\s*a|q&a|intro|sub|hoh|live score|£1 mem|w\/\s*short|with short|preview|premiere|uk premiere)\b/gi,
      " "
    )
    .replace(/\b(with\s+intro|w\/\s*intro|w\/\s*short|w\/\s*q&a)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  display = display.replace(/\s*[-–—]\s*$/, "").trim();
  if (!display) display = t.replace(/\s*\[[^\]]*\]/g, "").trim() || t;

  // Normalised form for dedup: lowercase, strip accents, collapse non-alnum.
  const normalised = display
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return { normalised, display };
}

function extractYearFromTitle(raw: string): number | null {
  // Look for a 4-digit year in brackets or trailing parens, e.g. "Film (1995)".
  const m = raw.match(/\[(19|20)\d{2}\]|\((19|20)\d{2}\)/);
  if (m) {
    const y = parseInt(m[0].replace(/[^\d]/g, ""), 10);
    if (y >= 1900 && y <= 2100) return y;
  }
  return null;
}

function isUnmatchable(displayTitle: string): boolean {
  return UNMATCHABLE_PATTERNS.some((re) => re.test(displayTitle));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function titleSimilarity(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  const dist = levenshtein(la, lb);
  const maxLen = Math.max(la.length, lb.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

interface TmdbResult {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
  vote_count?: number;
  popularity?: number;
  overview?: string;
}

interface MatchDecision {
  tmdb_id: number | null;
  poster_path: string | null;
  release_year: number | null;
  match_status: "matched" | "needs_review" | "unmatched";
  confidence: number;
  reason?: string;
}

function pickBestMatch(
  query: string,
  yearHint: number | null,
  results: TmdbResult[]
): MatchDecision {
  if (!results || results.length === 0) {
    return {
      tmdb_id: null,
      poster_path: null,
      release_year: null,
      match_status: "unmatched",
      confidence: 0,
      reason: "no TMDB results",
    };
  }

  // Score each result.
  const scored = results.map((r) => {
    const titleSim = titleSimilarity(query, r.title || r.original_title || "");
    let yearScore = 0.5;
    let resultYear: number | null = null;
    if (r.release_date && /^\d{4}-\d{2}-\d{2}$/.test(r.release_date)) {
      resultYear = parseInt(r.release_date.slice(0, 4), 10);
      if (yearHint) {
        const diff = Math.abs(resultYear - yearHint);
        yearScore = diff === 0 ? 1 : diff === 1 ? 0.85 : diff <= 2 ? 0.6 : 0.2;
      } else {
        yearScore = 0.6; // neutral when we have no year hint
      }
    }
    const popularity = typeof r.popularity === "number" ? r.popularity : 0;
    const popScore = Math.min(0.1, popularity / 1000);
    const confidence = titleSim * 0.8 + yearScore * 0.15 + popScore * 0.05;
    return { r, titleSim, yearScore, resultYear, confidence };
  });

  scored.sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];

  // Decision thresholds.
  const exactTitle = best.titleSim >= 0.98;
  const strongTitle = best.titleSim >= 0.9;

  if (exactTitle && (yearHint ? best.yearScore >= 0.85 : true)) {
    return {
      tmdb_id: best.r.id,
      poster_path: best.r.poster_path ?? null,
      release_year: best.resultYear,
      match_status: "matched",
      confidence: Math.min(1, best.confidence),
    };
  }

  if (strongTitle && (!yearHint || best.yearScore >= 0.6)) {
    return {
      tmdb_id: best.r.id,
      poster_path: best.r.poster_path ?? null,
      release_year: best.resultYear,
      match_status: "matched",
      confidence: Math.min(1, best.confidence),
    };
  }

  // A plausible but ambiguous result — keep the candidate but flag for review.
  if (best.titleSim >= 0.75) {
    return {
      tmdb_id: best.r.id,
      poster_path: best.r.poster_path ?? null,
      release_year: best.resultYear,
      match_status: "needs_review",
      confidence: best.confidence,
      reason: `best candidate "${best.r.title}" sim=${best.titleSim.toFixed(2)}`,
    };
  }

  return {
    tmdb_id: null,
    poster_path: null,
    release_year: null,
    match_status: "unmatched",
    confidence: best.confidence,
    reason: "no confident candidate",
  };
}

async function searchTmdb(
  token: string,
  query: string,
  year: number | null
): Promise<TmdbResult[]> {
  const params = new URLSearchParams({ query, language: "en-GB", page: "1", include_adult: "false" });
  if (year) params.set("year", String(year));
  const url = `${TMDB_SEARCH_URL}?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`TMDB search failed: HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return (json.results ?? []) as TmdbResult[];
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

  const runStartedAt = new Date().toISOString();
  console.log(`[match-movie-posters] starting at ${runStartedAt}`);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const tmdbToken = Deno.env.get("TMDB_READ_ACCESS_TOKEN");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  }
  if (!tmdbToken) {
    return jsonResponse(
      { success: false, error: "Missing TMDB_READ_ACCESS_TOKEN secret." },
      500
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Find screenings without a linked movie.
  const { data: unmatchedScreenings, error: selErr } = await supabase
    .from("screenings")
    .select("id, movie_title")
    .is("movie_id", null)
    .order("movie_title", { ascending: true });

  if (selErr) {
    console.error("[match-movie-posters] select screenings error:", selErr);
    return jsonResponse({ success: false, error: selErr.message }, 500);
  }

  // Group by normalised title so we search TMDB once per unique title.
  const byNormalised = new Map<
    string,
    { normalised: string; display: string; raw: string; screeningIds: string[] }
  >();

  for (const s of unmatchedScreenings ?? []) {
    const raw = s.movie_title as string;
    const { normalised, display } = normaliseTitle(raw);
    if (!normalised) continue;
    const existing = byNormalised.get(normalised);
    if (existing) {
      existing.screeningIds.push(s.id);
    } else {
      byNormalised.set(normalised, {
        normalised,
        display,
        raw,
        screeningIds: [s.id],
      });
    }
  }

  const uniqueTitles = Array.from(byNormalised.values());
  console.log(
    `[match-movie-posters] ${unmatchedScreenings?.length ?? 0} screenings → ${uniqueTitles.length} unique titles`
  );

  const stats = {
    matched: 0,
    needs_review: 0,
    unmatched: 0,
    reused: 0,
  };
  const examples: Array<{
    raw_title: string;
    normalised_title: string;
    display_title: string;
    match_status: string;
    tmdb_id: number | null;
    poster_path: string | null;
    confidence: number;
    screenings_linked: number;
    reason?: string;
  }> = [];

  for (const entry of uniqueTitles) {
    const { normalised, display, raw, screeningIds } = entry;

    // 3. Reuse an existing movies row by normalised_title.
    const { data: existingMovie, error: existErr } = await supabase
      .from("movies")
      .select("id, normalised_title, display_title, match_status, tmdb_id, poster_path, match_confidence")
      .eq("normalised_title", normalised)
      .maybeSingle();

    if (existErr) {
      console.error("[match-movie-posters] lookup existing error:", existErr);
      continue;
    }

    let movieId: string | null = null;

    if (existingMovie) {
      // Reuse — link screenings and continue.
      movieId = existingMovie.id as string;
      stats.reused += 1;
      if (existingMovie.match_status === "matched") stats.matched += 1;
      else if (existingMovie.match_status === "needs_review") stats.needs_review += 1;
      else if (existingMovie.match_status === "unmatched") stats.unmatched += 1;

      const { error: linkErr } = await supabase
        .from("screenings")
        .update({ movie_id: movieId })
        .in("id", screeningIds);
      if (linkErr) {
        console.error("[match-movie-posters] reuse link error:", linkErr);
      }
      continue;
    }

    // 10. Mark mystery/secret/marathon/non-film events as unmatched without searching.
    if (isUnmatchable(display)) {
      const { data: inserted, error: insErr } = await supabase
        .from("movies")
        .insert({
          normalised_title: normalised,
          display_title: display,
          match_status: "unmatched",
          match_confidence: 0,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.error("[match-movie-posters] insert unmatched error:", insErr);
        continue;
      }
      movieId = inserted.id as string;
      stats.unmatched += 1;
      examples.push({
        raw_title: raw,
        normalised_title: normalised,
        display_title: display,
        match_status: "unmatched",
        tmdb_id: null,
        poster_path: null,
        confidence: 0,
        screenings_linked: screeningIds.length,
        reason: "unmatchable title pattern",
      });
      const { error: linkErr } = await supabase
        .from("screenings")
        .update({ movie_id: movieId })
        .in("id", screeningIds);
      if (linkErr) console.error("[match-movie-posters] link unmatched error:", linkErr);
      continue;
    }

    // 4-7. Search TMDB.
    const yearHint = extractYearFromTitle(raw);
    let decision: MatchDecision;
    try {
      const results = await searchTmdb(tmdbToken, display, yearHint);
      decision = pickBestMatch(display, yearHint, results);
    } catch (err) {
      console.error(`[match-movie-posters] TMDB error for "${display}":`, err);
      // Treat as needs_review rather than unmatched so it can be retried.
      const { data: inserted, error: insErr } = await supabase
        .from("movies")
        .insert({
          normalised_title: normalised,
          display_title: display,
          match_status: "needs_review",
          match_confidence: 0,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.error("[match-movie-posters] insert tmdb-error error:", insErr);
        continue;
      }
      movieId = inserted.id as string;
      stats.needs_review += 1;
      examples.push({
        raw_title: raw,
        normalised_title: normalised,
        display_title: display,
        match_status: "needs_review",
        tmdb_id: null,
        poster_path: null,
        confidence: 0,
        screenings_linked: screeningIds.length,
        reason: `TMDB error: ${err instanceof Error ? err.message : String(err)}`,
      });
      const { error: linkErr } = await supabase
        .from("screenings")
        .update({ movie_id: movieId })
        .in("id", screeningIds);
      if (linkErr) console.error("[match-movie-posters] link tmdb-error error:", linkErr);
      continue;
    }

    // 11. Save the TMDB id + poster_path.
    const { data: inserted, error: insErr } = await supabase
      .from("movies")
      .insert({
        normalised_title: normalised,
        display_title: display,
        release_year: decision.release_year,
        tmdb_id: decision.tmdb_id,
        poster_path: decision.poster_path,
        match_status: decision.match_status,
        match_confidence: Math.round(decision.confidence * 1000) / 1000,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("[match-movie-posters] insert movie error:", insErr);
      continue;
    }
    movieId = inserted.id as string;

    if (decision.match_status === "matched") stats.matched += 1;
    else if (decision.match_status === "needs_review") stats.needs_review += 1;
    else stats.unmatched += 1;

    examples.push({
      raw_title: raw,
      normalised_title: normalised,
      display_title: display,
      match_status: decision.match_status,
      tmdb_id: decision.tmdb_id,
      poster_path: decision.poster_path,
      confidence: Math.round(decision.confidence * 1000) / 1000,
      screenings_linked: screeningIds.length,
      reason: decision.reason,
    });

    // 12. Link all matching screenings.
    const { error: linkErr } = await supabase
      .from("screenings")
      .update({ movie_id: movieId })
      .in("id", screeningIds);
    if (linkErr) {
      console.error("[match-movie-posters] link error:", linkErr);
    }

    // Be gentle with the TMDB API.
    await new Promise((r) => setTimeout(r, 60));
  }

  const runCompletedAt = new Date().toISOString();
  console.log(`[match-movie-posters] done: ${JSON.stringify(stats)}`);

  return jsonResponse({
    success: true,
    run_started_at: runStartedAt,
    run_completed_at: runCompletedAt,
    unique_titles: uniqueTitles.length,
    screenings_without_movie: unmatchedScreenings?.length ?? 0,
    matched: stats.matched,
    needs_review: stats.needs_review,
    unmatched: stats.unmatched,
    reused_existing: stats.reused,
    examples,
  });
});
