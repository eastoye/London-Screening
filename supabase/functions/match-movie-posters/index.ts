import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const PAGE_SIZE = 1000;
const MAX_TITLES_PER_RUN = 100;
const MIN_KNOWN_IDENTITY_CONFIDENCE = 0.95;
const DEFAULT_RETRY_AFTER_DAYS = 7;
const MAX_RETRY_AFTER_DAYS = 365;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

type MatchStatus = "matched" | "needs_review" | "unmatched";
type RunMode = "unlinked" | "retry" | "all";

interface ScreeningRow {
  id: string;
  movie_title: string;
  movie_id: string | null;
  start_time: string;
}

interface MovieRow {
  id: string;
  normalised_title: string;
  display_title: string;
  release_year: number | null;
  tmdb_id: number | null;
  poster_path: string | null;
  match_status: string;
  match_confidence: number | null;
  manually_confirmed: boolean;
  poster_override_url: string | null;
  candidate_tmdb_id: number | null;
  candidate_poster_path: string | null;
  match_reason: string | null;
  poster_match_last_attempted_at: string | null;
}

interface CleanedTitle {
  original: string;
  queryTitle: string;
  normalisedTitle: string;
  identityKey: string;
  yearHint: number | null;
  yearHintSource: "explicit" | "anniversary" | null;
  anniversaryYears: number | null;
  heavilyAltered: boolean;
  removedLabels: string[];
  fallbackCategory:
    | "Mystery Film"
    | "Double Bill"
    | "Short Film Programme"
    | "Live Event"
    | "General Screening";
  intentionallyUnmatchable: boolean;
}

type KnownIdentityIndex = Map<string, Map<number, MovieRow>>;

interface TitleGroup {
  cleaned: CleanedTitle;
  screenings: ScreeningRow[];
}

interface TmdbResult {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
}

interface ScoredCandidate {
  result: TmdbResult;
  similarity: number;
  matchedName: string;
  releaseYear: number | null;
  yearExact: boolean;
  yearCompatible: boolean;
  score: number;
}

interface MatchDecision {
  status: MatchStatus;
  confidence: number;
  tmdbId: number | null;
  posterPath: string | null;
  releaseYear: number | null;
  candidateTmdbId: number | null;
  candidatePosterPath: string | null;
  reason: string;
}

interface RunRequest {
  dry_run?: boolean;
  mode?: RunMode;
  max_titles?: number;
  offset?: number;
  after?: string;
  titles?: string[];
  retry_after_days?: number;
  retry_before?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function comparableTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleIdentity(queryTitle: string, year: number | null): string {
  const base = comparableTitle(queryTitle);
  return year ? `${base} ${year}` : base;
}

function fallbackCategory(title: string): CleanedTitle["fallbackCategory"] {
  if (
    /\b(mystery|secret|surprise)\s+(movie|film|screening|showing)\b/i.test(
      title,
    ) ||
    /\bundisclosed\s+(movie|film|title)\b/i.test(title) ||
    /^(?:.{2,50}\s*[-:]\s*)?mystery\b.{0,80}\b(?:cinema|matinees?|marathon)\b/i.test(
      title.trim(),
    )
  ) {
    return "Mystery Film";
  }
  if (
    /\b(double|triple)\s+(bill|feature)\b/i.test(title) ||
    /\ball[- ]?nighter\b/i.test(title) ||
    /\b(film|movie|season|series|trilogy|saga|franchise|mystery|horror|anime)\s+marathon\b/i.test(
      title,
    ) ||
    /\bmarathon\s*(?:screening|programme|program|:|-)/i.test(title) ||
    /-a-thon\b/i.test(title)
  ) {
    return "Double Bill";
  }
  if (
    /\b(shorts?|short films?)\s+(programme|program|selection|showcase|collection|night)\b/i.test(
      title,
    ) ||
    /\bprogramme\s+of\s+shorts?\b/i.test(title) ||
    /^shorts\b/i.test(title.trim())
  ) {
    return "Short Film Programme";
  }
  if (
    /^(?:nt live|national theatre live|met opera|royal ballet|royal opera|royal ballet\s*&\s*opera|rbo live|exhibition on screen)\b/i.test(
      title.trim(),
    ) ||
    /\b(event cinema|live broadcast|encore broadcast|in conversation)\b/i.test(
      title,
    ) ||
    /\bseason\s+\d+\s+marathon\b/i.test(title) ||
    /\bepisodes?\s+\d+(?:\s*[-\u2013\u2014]\s*\d+)?\b/i.test(title)
  ) {
    return "Live Event";
  }
  return "General Screening";
}

function cleanScreeningTitle(
  raw: string,
  referenceYear = new Date().getUTCFullYear(),
): CleanedTitle {
  const original = raw.trim().replace(/\s+/g, " ");
  let title = original;
  let yearHint: number | null = null;
  let yearHintSource: CleanedTitle["yearHintSource"] = null;
  let anniversaryYears: number | null = null;
  let heavilyAltered = false;
  const removedLabels: string[] = [];

  const replace = (
    pattern: RegExp,
    replacement: string,
    label: string,
    heavy = false,
  ) => {
    const next = title.replace(pattern, replacement).trim();
    if (next !== title) {
      title = next;
      removedLabels.push(label);
      heavilyAltered ||= heavy;
      return true;
    }
    return false;
  };

  // Screening-access labels can appear as a prefix.
  replace(
    /^(?:(?:send|sen|autism|sensory|dementia)\s*[- ]?\s*friendly|relaxed|accessible)\s+screenin(?:g)?s?\s*[:\-\u2013\u2014]\s*/i,
    "",
    "accessibility screening prefix",
  );
  replace(
    /^(?:(?:hoh|open captioned|captioned|parent\s*(?:and|&)\s*baby|baby cinema|members? screening)\s*[:\-\u2013\u2014]\s*)/i,
    "",
    "access/presentation prefix",
  );
  replace(
    /^(?:(?:uk|world|london)\s+(?:theatrical\s+)?(?:preview|premiere)\s*[:\-\u2013\u2014]?\s+)/i,
    "",
    "preview/premiere prefix",
    true,
  );
  replace(
    /^(?:preview|premiere)\s*!\s*/i,
    "",
    "preview/premiere prefix",
  );

  // These are known programme or event wrappers with one film title after
  // the delimiter. Keep this allowlist narrow so generic colon and plus signs
  // in film titles, double bills and mixed programmes are not split.
  replace(
    /^fighting spirit\s*:\s*/i,
    "",
    "known programme prefix",
    true,
  );
  replace(
    /^live folk music,\s*czech drinks\s*\+\s*/i,
    "",
    "known single-film event prefix",
  );

  // A numbered anniversary tied to the screening year is usable release-year
  // evidence. It is kept separate from the public title and remains subject to
  // the normal exact-title and year-compatibility checks.
  const anniversaryMatch = title.match(
    /\s*(?:[:+|\u2022]|[-\u2013\u2014]\s*)?\s*[\[(]?\s*(\d{1,3})(?:st|nd|rd|th)\s+anniversary(?:\s+screenings?)?\s*[\])]?\s*$/i,
  );
  if (anniversaryMatch) {
    const years = Number(anniversaryMatch[1]);
    const inferredYear = referenceYear - years;
    if (years >= 1 && years <= 150 && inferredYear >= 1870) {
      anniversaryYears = years;
      yearHint = inferredYear;
      yearHintSource = "anniversary";
      title = title.slice(0, anniversaryMatch.index).trim();
      removedLabels.push("anniversary-derived release year");
    }
  }

  // Curatorial wrappers are useful for discovery, but removing them is a
  // substantial change and therefore prevents automatic acceptance.
  replace(
    /^.{2,70}\b(?:presents?|introduces)\s*[:\-\u2013\u2014]?\s+(?=[A-Z0-9])/i,
    "",
    "curatorial presenter prefix",
    true,
  );

  replace(
    /\s*\[[^\]]*[A-Za-z\u00C0-\u00FF][^\]]*\]\s*$/,
    "",
    "translated/alternative title",
  );

  // Remove repeated, clearly delimited screening suffixes.
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    changed ||= replace(
      /\s*[\[(]\s*(?:35mm|70mm|4k(?:\s+(?:restoration|remaster))?|imax|hoh|subtitled|open captioned|captioned|parent\s*(?:and|&)\s*baby|members? screening|live score)\s*[\])]\s*$/i,
      "",
      "bracketed screening label",
    );
    changed ||= replace(
      /\s*[\[(]\s*(?:(?:uk|world|london)\s+)?(?:theatrical\s+)?(?:preview|premiere)(?:\s+screening)?\s*[\])]\s*$/i,
      "",
      "bracketed preview/premiere label",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022]|[-\u2013\u2014]\s+)\s*(?:q\s*&\s*a|qanda|introduction|intro|extended intro|35mm|70mm|4k(?:\s+(?:restoration|remaster))?|imax|hoh|subtitled|open captioned|captioned|parent\s*(?:and|&)\s*baby|members? screening|live score|with\s+(?:a\s+)?short|w\/?\s*short)\b(?:\s+(?:with|featuring|followed by)\s+.{2,100})?\s*$/i,
      "",
      "screening suffix",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022]|[-\u2013\u2014]\s+)\s*(?:director|cast|filmmaker|actor|crew|virtual)\s+q\s*&\s*a(?:\s+with\s+.{2,100})?\s*$/i,
      "",
      "appearance Q&A suffix",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022]|[-\u2013\u2014]\s+)\s*.{2,100}\s+(?:q\s*&\s*a|in person|live on stage)\s*$/i,
      "",
      "named appearance suffix",
      true,
    );
    changed ||= replace(
      /\s*[\[(]\s*\+?\s*shorts?\s*[\])]\s*$/i,
      "",
      "short-film accompaniment",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022]|[-\u2013\u2014]\s+)\s*(?:shorts?|with\s+(?:a\s+)?short|w\/?\s*short)(?:\s*(?:&|and|\+)\s*(?:introduction|intro))?\s*$/i,
      "",
      "short-film accompaniment",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022:]|[-\u2013\u2014]\s+)\s*(?:(?:uk|world|london)\s+)?(?:preview|premiere)\s*$/i,
      "",
      "preview/premiere suffix",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022:]|[-\u2013\u2014]\s+)\s*(?:(?:uk|world|london)\s+)?(?:preview|premiere)\s+screening\s*$/i,
      "",
      "preview/premiere screening suffix",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022:]|[-\u2013\u2014]\s+)\s*(?:(?:uk|world|london)\s+)?premiere\s+of\s+(?:a\s+)?(?:4k\s+)?restoration\s*$/i,
      "",
      "restoration premiere suffix",
    );
    changed ||= replace(
      /\s*(?:[-\u2013\u2014]\s*)?[\[(]?\s*\d{1,3}(?:st|nd|rd|th)\s+anniversary(?:\s+screenings?)?\s*[\])]?\s*$/i,
      "",
      "anniversary suffix",
    );
    changed ||= replace(
      /\s*[-\u2013\u2014]\s+\d{1,3}(?:st|nd|rd|th)\s+birthday\s+of\s+.{2,100}\s*$/i,
      "",
      "birthday event suffix",
    );
    changed ||= replace(
      /\s+(?:sing[\s-]?along)\s*$/i,
      "",
      "sing-along suffix",
    );
    changed ||= replace(
      /\s*(?:[+|\u2022]|[-\u2013\u2014:]\s+)\s*(?:director'?s|theatrical|extended|final|anniversary|restored)\s+(?:cut|edition|restoration)\s*$/i,
      "",
      "edition suffix",
    );
    changed ||= replace(
      /\s+(?:with|featuring)\s+.{2,100}\s+(?:in person|live on stage|for a q\s*&\s*a|for q\s*&\s*a)\s*$/i,
      "",
      "director/cast appearance",
    );
    changed ||= replace(
      /\s+(?:presented|introduced|hosted)\s+by\s+.{2,100}\s*$/i,
      "",
      "presenter suffix",
      true,
    );
    changed ||= replace(
      /\s+(?:q\s*&\s*a|qanda|introduction|intro|35mm|70mm|4k(?:\s+(?:restoration|remaster))?|imax|hoh|subtitled|open captioned|captioned|parent\s*(?:and|&)\s*baby|members? screening|live score)\s*$/i,
      "",
      "plain trailing screening label",
    );
    changed ||= replace(
      /\s+(?:(?:uk|world|london)\s+)?(?:preview|premiere)\s*$/i,
      "",
      "plain preview/premiere suffix",
      true,
    );
    if (!changed) break;
  }

  // A terminal bracketed year is identity metadata, not part of the query.
  const yearMatch = title.match(
    /\s*(?:\(|\[)\s*((?:18|19|20)\d{2})\s*(?:\)|\])\s*$/,
  );
  if (yearMatch) {
    const parsed = Number(yearMatch[1]);
    if (parsed >= 1870 && parsed <= referenceYear + 2) {
      yearHint = parsed;
      yearHintSource = "explicit";
      title = title.slice(0, yearMatch.index).trim();
      removedLabels.push("release year");
    }
  }

  title = title
    .replace(/\s*[|\u2022]\s*$/, "")
    .replace(/\s*[-\u2013\u2014:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) title = original;

  const category = fallbackCategory(original);
  const intentionallyUnmatchable = category !== "General Screening";
  const normalisedTitle = comparableTitle(title);

  return {
    original,
    queryTitle: title,
    normalisedTitle,
    identityKey: titleIdentity(title, yearHint),
    yearHint,
    yearHintSource,
    anniversaryYears,
    heavilyAltered,
    removedLabels,
    fallbackCategory: category,
    intentionallyUnmatchable,
  };
}

function levenshtein(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function titleSimilarity(a: string, b: string): number {
  const left = comparableTitle(a);
  const right = comparableTitle(b);
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  return maxLength ? 1 - levenshtein(left, right) / maxLength : 1;
}

function releaseYear(result: TmdbResult): number | null {
  if (!result.release_date || !/^\d{4}-\d{2}-\d{2}$/.test(result.release_date)) {
    return null;
  }
  return Number(result.release_date.slice(0, 4));
}

async function tmdbGet(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${TMDB_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TMDB HTTP ${response.status}: ${body.slice(0, 180)}`);
  }
  return await response.json();
}

async function refreshExistingTmdbMatch(
  token: string,
  movie: MovieRow,
): Promise<MatchDecision> {
  const result = (await tmdbGet(
    token,
    `/movie/${movie.tmdb_id}?language=en-GB`,
  )) as TmdbResult;
  const refreshedYear = releaseYear(result);
  const posterPath = result.poster_path ?? null;

  return {
    status: "matched",
    confidence: movie.match_confidence ?? 1,
    tmdbId: movie.tmdb_id,
    posterPath,
    releaseYear: movie.release_year ?? refreshedYear,
    candidateTmdbId: null,
    candidatePosterPath: null,
    reason: posterPath
      ? "poster refreshed from the existing TMDB match"
      : "existing TMDB match preserved; TMDB still has no poster",
  };
}

async function searchTmdb(
  token: string,
  query: string,
  yearHint: number | null,
): Promise<TmdbResult[]> {
  const params = new URLSearchParams({
    query,
    include_adult: "false",
    language: "en-GB",
    page: "1",
  });
  if (yearHint) params.set("primary_release_year", String(yearHint));
  const payload = (await tmdbGet(
    token,
    `/search/movie?${params.toString()}`,
  )) as { results?: TmdbResult[] };
  return payload.results ?? [];
}

async function alternativeTitles(
  token: string,
  movieId: number,
): Promise<string[]> {
  try {
    const payload = (await tmdbGet(
      token,
      `/movie/${movieId}/alternative_titles`,
    )) as { titles?: Array<{ title?: string }> };
    return (payload.titles ?? [])
      .map((item) => item.title?.trim() ?? "")
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `[match-movie-posters] alternative titles unavailable for ${movieId}:`,
      error,
    );
    return [];
  }
}

function scoreCandidates(
  query: string,
  yearHint: number | null,
  results: TmdbResult[],
  alternatives: Map<number, string[]>,
): ScoredCandidate[] {
  return results
    .map((result) => {
      const names = [
        result.title ?? "",
        result.original_title ?? "",
        ...(alternatives.get(result.id) ?? []),
      ].filter(Boolean);
      let similarity = 0;
      let matchedName = result.title ?? result.original_title ?? "";
      for (const name of names) {
        const candidateSimilarity = titleSimilarity(query, name);
        if (candidateSimilarity > similarity) {
          similarity = candidateSimilarity;
          matchedName = name;
        }
      }
      const candidateYear = releaseYear(result);
      const yearExact = Boolean(yearHint && candidateYear === yearHint);
      const yearCompatible = Boolean(
        yearHint &&
          candidateYear &&
          Math.abs(candidateYear - yearHint) <= 1,
      );
      const yearScore = yearHint
        ? yearExact
          ? 0.25
          : yearCompatible
            ? 0.2
            : 0
        : 0.1;
      const posterScore = result.poster_path ? 0.01 : 0;
      return {
        result,
        similarity,
        matchedName,
        releaseYear: candidateYear,
        yearExact,
        yearCompatible,
        score: similarity * 0.75 + yearScore + posterScore,
      };
    })
    .sort((a, b) => b.score - a.score || b.similarity - a.similarity);
}

function reviewDecision(best: ScoredCandidate, reason: string): MatchDecision {
  return {
    status: "needs_review",
    confidence: Math.round(best.score * 1000) / 1000,
    tmdbId: null,
    posterPath: null,
    releaseYear: best.releaseYear,
    candidateTmdbId: best.result.id,
    candidatePosterPath: best.result.poster_path ?? null,
    reason,
  };
}

function isEstablishedIdentity(movie: MovieRow): boolean {
  if (movie.tmdb_id === null) return false;
  if (movie.manually_confirmed) return true;
  return (
    movie.match_status === "matched" &&
    (movie.match_confidence ?? 0) >= MIN_KNOWN_IDENTITY_CONFIDENCE &&
    Boolean(movie.poster_path || movie.poster_override_url)
  );
}

function knownIdentityTitleKeys(movie: MovieRow): string[] {
  const keys = new Set<string>();
  const displayKey = comparableTitle(movie.display_title);
  if (displayKey) keys.add(displayKey);

  let normalisedKey = comparableTitle(movie.normalised_title);
  if (movie.release_year && normalisedKey.endsWith(` ${movie.release_year}`)) {
    normalisedKey = normalisedKey.slice(0, -String(movie.release_year).length - 1);
  }
  if (normalisedKey) keys.add(normalisedKey);
  return [...keys];
}

function buildKnownIdentityIndex(movies: MovieRow[]): KnownIdentityIndex {
  const index: KnownIdentityIndex = new Map();
  for (const movie of movies) {
    if (!isEstablishedIdentity(movie) || movie.tmdb_id === null) continue;
    for (const titleKey of knownIdentityTitleKeys(movie)) {
      const identities = index.get(titleKey) ?? new Map<number, MovieRow>();
      identities.set(movie.tmdb_id, movie);
      index.set(titleKey, identities);
    }
  }
  return index;
}

function compatibleKnownIdentity(
  cleaned: CleanedTitle,
  best: ScoredCandidate,
  knownIdentities: KnownIdentityIndex,
): MovieRow | null {
  if (
    cleaned.heavilyAltered ||
    best.similarity < 0.995 ||
    !best.result.poster_path
  ) {
    return null;
  }

  const identities = knownIdentities.get(cleaned.normalisedTitle);
  if (!identities || identities.size !== 1) return null;
  const known = identities.get(best.result.id);
  if (!known) return null;

  if (
    known.release_year &&
    best.releaseYear &&
    Math.abs(known.release_year - best.releaseYear) > 1
  ) {
    return null;
  }
  if (
    cleaned.yearHint &&
    best.releaseYear &&
    Math.abs(cleaned.yearHint - best.releaseYear) > 1
  ) {
    return null;
  }
  return known;
}

async function decideMatch(
  token: string,
  cleaned: CleanedTitle,
  knownIdentities: KnownIdentityIndex,
): Promise<MatchDecision> {
  if (cleaned.queryTitle.length > 500) {
    return {
      status: "unmatched",
      confidence: 0,
      tmdbId: null,
      posterPath: null,
      releaseYear: cleaned.yearHint,
      candidateTmdbId: null,
      candidatePosterPath: null,
      reason: "source title exceeds the TMDB query limit",
    };
  }

  if (cleaned.intentionallyUnmatchable) {
    return {
      status: "unmatched",
      confidence: 0,
      tmdbId: null,
      posterPath: null,
      releaseYear: cleaned.yearHint,
      candidateTmdbId: null,
      candidatePosterPath: null,
      reason: `intentional fallback: ${cleaned.fallbackCategory}`,
    };
  }

  const results = await searchTmdb(token, cleaned.queryTitle, cleaned.yearHint);
  if (!results.length) {
    return {
      status: "unmatched",
      confidence: 0,
      tmdbId: null,
      posterPath: null,
      releaseYear: cleaned.yearHint,
      candidateTmdbId: null,
      candidatePosterPath: null,
      reason: "no TMDB movie results",
    };
  }

  let scored = scoreCandidates(
    cleaned.queryTitle,
    cleaned.yearHint,
    results,
    new Map(),
  );

  // TMDB search already considers alternative titles, but the result payload
  // does not expose which title matched. Fetch alternatives only for the most
  // plausible candidates when the visible/original titles are not conclusive.
  if (scored[0].similarity < 1 || scored.filter((item) => item.similarity === 1).length > 1) {
    const alternatives = new Map<number, string[]>();
    for (const candidate of scored.slice(0, 3)) {
      alternatives.set(
        candidate.result.id,
        await alternativeTitles(token, candidate.result.id),
      );
    }
    scored = scoreCandidates(
      cleaned.queryTitle,
      cleaned.yearHint,
      results,
      alternatives,
    );
  }

  const best = scored[0];
  const second = scored[1];
  const margin = second ? best.score - second.score : 1;
  const exactCandidates = scored.filter((candidate) => candidate.similarity >= 0.995);
  const knownIdentity = compatibleKnownIdentity(
    cleaned,
    best,
    knownIdentities,
  );

  if (knownIdentity) {
    return {
      status: "matched",
      confidence: Math.min(
        1,
        Math.max(0.98, knownIdentity.match_confidence ?? 0),
      ),
      tmdbId: best.result.id,
      posterPath: best.result.poster_path ?? null,
      releaseYear: best.releaseYear ?? knownIdentity.release_year,
      candidateTmdbId: null,
      candidatePosterPath: null,
      reason: `exact title and unique established on-site identity TMDB ${best.result.id}`,
    };
  }

  if (cleaned.yearHint) {
    if (best.similarity >= 0.995 && best.yearCompatible) {
      if (!best.result.poster_path) {
        return reviewDecision(best, "exact title/year candidate has no poster");
      }
      if (cleaned.heavilyAltered) {
        return reviewDecision(best, "title required substantial cleaning");
      }
      return {
        status: "matched",
        confidence: 1,
        tmdbId: best.result.id,
        posterPath: best.result.poster_path,
        releaseYear: best.yearExact ? best.releaseYear : cleaned.yearHint,
        candidateTmdbId: null,
        candidatePosterPath: null,
        reason: best.yearExact
          ? cleaned.yearHintSource === "anniversary"
            ? `exact title and ${cleaned.anniversaryYears}-year anniversary implies ${cleaned.yearHint}`
            : `exact title and release year via "${best.matchedName}"`
          : cleaned.yearHintSource === "anniversary"
            ? `exact title; TMDB date is within one year of the anniversary-derived ${cleaned.yearHint} hint`
            : `exact title; TMDB date differs by one year from explicit screening year`,
      };
    }
    if (
      best.similarity >= 0.96 &&
      best.yearExact &&
      margin >= 0.06 &&
      best.result.poster_path
    ) {
      if (cleaned.heavilyAltered) {
        return reviewDecision(best, "title required substantial cleaning");
      }
      return {
        status: "matched",
        confidence: 0.96,
        tmdbId: best.result.id,
        posterPath: best.result.poster_path,
        releaseYear: best.releaseYear,
        candidateTmdbId: null,
        candidatePosterPath: null,
        reason: `strong title and exact release year via "${best.matchedName}"`,
      };
    }
    if (best.similarity >= 0.72) {
      const reason = !best.yearExact
        ? `candidate year ${best.releaseYear ?? "unknown"} conflicts with ${cleaned.yearHint}`
        : margin < 0.06
          ? "top candidates are too similar"
          : "title similarity is below the automatic threshold";
      return reviewDecision(best, reason);
    }
  } else {
    if (exactCandidates.length > 1) {
      return reviewDecision(
        best,
        `ambiguous exact title across ${exactCandidates.length} TMDB movies; release year required`,
      );
    }
    if (best.similarity >= 0.995) {
      if (!best.result.poster_path) {
        return reviewDecision(best, "exact title candidate has no poster");
      }
      if (cleaned.heavilyAltered) {
        return reviewDecision(best, "title required substantial cleaning");
      }
      return {
        status: "matched",
        confidence: 0.95,
        tmdbId: best.result.id,
        posterPath: best.result.poster_path,
        releaseYear: best.releaseYear,
        candidateTmdbId: null,
        candidatePosterPath: null,
        reason: `unique exact title via "${best.matchedName}"`,
      };
    }
    if (
      best.similarity >= 0.97 &&
      margin >= 0.1 &&
      best.result.poster_path &&
      !cleaned.heavilyAltered
    ) {
      return {
        status: "matched",
        confidence: 0.92,
        tmdbId: best.result.id,
        posterPath: best.result.poster_path,
        releaseYear: best.releaseYear,
        candidateTmdbId: null,
        candidatePosterPath: null,
        reason: `single strong title candidate via "${best.matchedName}"`,
      };
    }
    if (best.similarity >= 0.72) {
      const reason = !best.result.poster_path
        ? "best candidate has no poster"
        : margin < 0.1
          ? "top candidates are too similar"
          : cleaned.heavilyAltered
            ? "title required substantial cleaning"
            : "title similarity is below the automatic threshold";
      return reviewDecision(best, reason);
    }
  }

  return {
    status: "unmatched",
    confidence: Math.round(best.score * 1000) / 1000,
    tmdbId: null,
    posterPath: null,
    releaseYear: cleaned.yearHint,
    candidateTmdbId: null,
    candidatePosterPath: null,
    reason: "no sufficiently similar TMDB movie candidate",
  };
}

async function fetchAllFutureScreenings(
  supabase: SupabaseClient,
): Promise<ScreeningRow[]> {
  const rows: ScreeningRow[] = [];
  const nowIso = new Date().toISOString();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("screenings")
      .select("id, movie_title, movie_id, start_time")
      .eq("active", true)
      .gt("start_time", nowIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`screenings query failed: ${error.message}`);
    const page = (data ?? []) as ScreeningRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllMovies(
  supabase: SupabaseClient,
): Promise<MovieRow[]> {
  const rows: MovieRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("movies")
      .select(
        "id, normalised_title, display_title, release_year, tmdb_id, poster_path, match_status, match_confidence, manually_confirmed, poster_override_url, candidate_tmdb_id, candidate_poster_path, match_reason, poster_match_last_attempted_at",
      )
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`movies query failed: ${error.message}`);
    const page = (data ?? []) as MovieRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function linkScreenings(
  supabase: SupabaseClient,
  screeningIds: string[],
  movieId: string,
): Promise<void> {
  for (let index = 0; index < screeningIds.length; index += 100) {
    const chunk = screeningIds.slice(index, index + 100);
    const { error } = await supabase
      .from("screenings")
      .update({ movie_id: movieId })
      .in("id", chunk);
    if (error) throw new Error(`screening link failed: ${error.message}`);
  }
}

function retryable(movie: MovieRow | undefined, retryBefore: string): boolean {
  if (!movie || movie.manually_confirmed) return false;
  if (movie.poster_path || movie.poster_override_url) return false;
  if (!movie.poster_match_last_attempted_at) return true;
  const attemptedAt = Date.parse(movie.poster_match_last_attempted_at);
  return !Number.isFinite(attemptedAt) || attemptedAt <= Date.parse(retryBefore);
}

function groupScreenings(screenings: ScreeningRow[]): TitleGroup[] {
  const groups = new Map<string, TitleGroup>();
  for (const screening of screenings) {
    const screeningDate = new Date(screening.start_time);
    const referenceYear = Number.isFinite(screeningDate.getTime())
      ? screeningDate.getUTCFullYear()
      : new Date().getUTCFullYear();
    const cleaned = cleanScreeningTitle(screening.movie_title, referenceYear);
    if (!cleaned.identityKey) continue;
    const existing = groups.get(cleaned.identityKey);
    if (existing) existing.screenings.push(screening);
    else groups.set(cleaned.identityKey, { cleaned, screenings: [screening] });
  }
  return [...groups.values()].sort((a, b) =>
    a.cleaned.identityKey.localeCompare(b.cleaned.identityKey),
  );
}

function findManualMovie(
  group: TitleGroup,
  moviesById: Map<string, MovieRow>,
  moviesByNormalised: Map<string, MovieRow>,
): MovieRow | null {
  const byIdentity = moviesByNormalised.get(group.cleaned.identityKey);
  if (byIdentity?.manually_confirmed) return byIdentity;
  for (const screening of group.screenings) {
    const linked = screening.movie_id
      ? moviesById.get(screening.movie_id)
      : undefined;
    if (linked?.manually_confirmed) return linked;
  }
  return null;
}

function linkedMoviesForGroup(
  group: TitleGroup,
  moviesById: Map<string, MovieRow>,
): MovieRow[] {
  const linked = new Map<string, MovieRow>();
  for (const screening of group.screenings) {
    if (!screening.movie_id) continue;
    const movie = moviesById.get(screening.movie_id);
    if (movie) linked.set(movie.id, movie);
  }
  return [...linked.values()];
}

function findExistingMatchedMovie(
  group: TitleGroup,
  moviesById: Map<string, MovieRow>,
): MovieRow | null {
  const matches = linkedMoviesForGroup(group, moviesById).filter(
    (movie) =>
      movie.match_status === "matched" &&
      movie.tmdb_id !== null &&
      !movie.poster_path &&
      !movie.poster_override_url,
  );
  const tmdbIds = new Set(matches.map((movie) => movie.tmdb_id));
  return matches.length > 0 && tmdbIds.size === 1 ? matches[0] : null;
}

function groupRetrySortTime(
  group: TitleGroup,
  moviesById: Map<string, MovieRow>,
  retryBefore: string,
): number {
  const attempts = linkedMoviesForGroup(group, moviesById)
    .filter((movie) => retryable(movie, retryBefore))
    .map((movie) =>
      movie.poster_match_last_attempted_at
        ? Date.parse(movie.poster_match_last_attempted_at)
        : Number.NEGATIVE_INFINITY
    )
    .sort((left, right) => left - right);
  return attempts[0] ?? Number.POSITIVE_INFINITY;
}

async function markLinkedMoviesAttempted(
  supabase: SupabaseClient,
  group: TitleGroup,
  moviesById: Map<string, MovieRow>,
  attemptedAt: string,
): Promise<void> {
  const movies = linkedMoviesForGroup(group, moviesById).filter(
    (movie) => !movie.manually_confirmed,
  );
  const ids = movies.map((movie) => movie.id);
  for (let index = 0; index < ids.length; index += 100) {
    const { error } = await supabase
      .from("movies")
      .update({ poster_match_last_attempted_at: attemptedAt })
      .in("id", ids.slice(index, index + 100));
    if (error) {
      throw new Error(`poster attempt update failed: ${error.message}`);
    }
  }
  for (const movie of movies) {
    movie.poster_match_last_attempted_at = attemptedAt;
    moviesById.set(movie.id, movie);
  }
}

async function persistDecision(
  supabase: SupabaseClient,
  group: TitleGroup,
  decision: MatchDecision,
  moviesById: Map<string, MovieRow>,
  moviesByNormalised: Map<string, MovieRow>,
  moviesByTmdb: Map<number, MovieRow>,
  movieUsageKeys: Map<string, Set<string>>,
): Promise<{ movieId: string; action: "inserted" | "updated" | "reused_tmdb" }> {
  const linkedRows = group.screenings
    .map((screening) =>
      screening.movie_id ? moviesById.get(screening.movie_id) : undefined,
    )
    .filter((movie): movie is MovieRow => Boolean(movie));

  let target: MovieRow | undefined;
  let action: "inserted" | "updated" | "reused_tmdb" = "updated";

  if (decision.tmdbId) {
    target = moviesByTmdb.get(decision.tmdbId);
    if (target) action = "reused_tmdb";
  }
  target ??= moviesByNormalised.get(group.cleaned.identityKey);
  target ??= linkedRows.find(
    (movie) => (movieUsageKeys.get(movie.id)?.size ?? 0) <= 1,
  );

  const now = new Date().toISOString();
  const values = {
    display_title: group.cleaned.queryTitle,
    release_year: decision.releaseYear ?? group.cleaned.yearHint,
    tmdb_id: decision.tmdbId,
    poster_path: decision.posterPath,
    match_status: decision.status,
    match_confidence: decision.confidence,
    candidate_tmdb_id: decision.candidateTmdbId,
    candidate_poster_path: decision.candidatePosterPath,
    match_reason: decision.reason,
    poster_match_last_attempted_at: now,
    updated_at: now,
  };

  if (target) {
    if (target.manually_confirmed) {
      await linkScreenings(
        supabase,
        group.screenings.map((screening) => screening.id),
        target.id,
      );
      return { movieId: target.id, action: "reused_tmdb" };
    }
    const isTmdbCanonical =
      decision.tmdbId !== null && target.tmdb_id === decision.tmdbId;
    const updateValues = isTmdbCanonical
      ? values
      : { ...values, normalised_title: group.cleaned.identityKey };
    const { data, error } = await supabase
      .from("movies")
      .update(updateValues)
      .eq("id", target.id)
      .select(
        "id, normalised_title, display_title, release_year, tmdb_id, poster_path, match_status, match_confidence, manually_confirmed, poster_override_url, candidate_tmdb_id, candidate_poster_path, match_reason, poster_match_last_attempted_at",
      )
      .single();
    if (error || !data) {
      throw new Error(`movie update failed: ${error?.message ?? "no row returned"}`);
    }
    target = data as MovieRow;
  } else {
    const { data, error } = await supabase
      .from("movies")
      .insert({
        ...values,
        normalised_title: group.cleaned.identityKey,
      })
      .select(
        "id, normalised_title, display_title, release_year, tmdb_id, poster_path, match_status, match_confidence, manually_confirmed, poster_override_url, candidate_tmdb_id, candidate_poster_path, match_reason, poster_match_last_attempted_at",
      )
      .single();
    if (error || !data) {
      throw new Error(`movie insert failed: ${error?.message ?? "no row returned"}`);
    }
    target = data as MovieRow;
    action = "inserted";
  }

  moviesById.set(target.id, target);
  moviesByNormalised.set(target.normalised_title, target);
  if (target.tmdb_id) moviesByTmdb.set(target.tmdb_id, target);

  await linkScreenings(
    supabase,
    group.screenings.map((screening) => screening.id),
    target.id,
  );
  return { movieId: target.id, action };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Use POST." }, 405);
  }

  const runStartedAt = new Date().toISOString();
  let body: RunRequest = {};
  try {
    body = (await req.json()) as RunRequest;
  } catch {
    body = {};
  }

  const dryRun = body.dry_run === true;
  const mode: RunMode = ["unlinked", "retry", "all"].includes(body.mode ?? "")
    ? (body.mode as RunMode)
    : "retry";
  const maxTitles = Math.max(
    1,
    Math.min(MAX_TITLES_PER_RUN, Math.floor(body.max_titles ?? 50)),
  );
  const requestedOffset = Number(body.offset);
  const offset = dryRun && Number.isFinite(requestedOffset)
    ? Math.max(0, Math.min(10_000, Math.floor(requestedOffset)))
    : 0;
  const after = typeof body.after === "string" ? body.after : "";
  const requestedRetryAfterDays = Number(body.retry_after_days);
  const retryAfterDays = Number.isFinite(requestedRetryAfterDays)
    ? Math.max(
        1,
        Math.min(MAX_RETRY_AFTER_DAYS, Math.floor(requestedRetryAfterDays)),
      )
    : DEFAULT_RETRY_AFTER_DAYS;
  let retryBefore = new Date(
    Date.now() - retryAfterDays * DAY_IN_MILLISECONDS,
  ).toISOString();
  if (body.retry_before !== undefined) {
    if (
      typeof body.retry_before !== "string" ||
      !Number.isFinite(Date.parse(body.retry_before))
    ) {
      return jsonResponse(
        { success: false, error: "retry_before must be a valid ISO timestamp." },
        400,
      );
    }
    retryBefore = new Date(body.retry_before).toISOString();
  }
  const requestedTitles = new Set(
    Array.isArray(body.titles)
      ? body.titles
          .filter((title): title is string => typeof title === "string")
          .map((title) => comparableTitle(title))
      : [],
  );

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const tmdbToken = Deno.env.get("TMDB_READ_ACCESS_TOKEN");
  if (!supabaseUrl || !serviceRoleKey || !tmdbToken) {
    return jsonResponse(
      { success: false, error: "Required function secrets are missing." },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const [screenings, movies] = await Promise.all([
      fetchAllFutureScreenings(supabase),
      fetchAllMovies(supabase),
    ]);
    const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
    const moviesByNormalised = new Map(
      movies.map((movie) => [movie.normalised_title, movie]),
    );
    const moviesByTmdb = new Map(
      movies
        .filter((movie) => movie.tmdb_id !== null)
        .map((movie) => [movie.tmdb_id as number, movie]),
    );
    const knownIdentities = buildKnownIdentityIndex(movies);

    const allGroups = groupScreenings(screenings);
    const movieUsageKeys = new Map<string, Set<string>>();
    for (const group of allGroups) {
      for (const screening of group.screenings) {
        if (!screening.movie_id) continue;
        const keys = movieUsageKeys.get(screening.movie_id) ?? new Set<string>();
        keys.add(group.cleaned.identityKey);
        movieUsageKeys.set(screening.movie_id, keys);
      }
    }

    const eligible = allGroups.filter((group) => {
      if (group.cleaned.identityKey <= after) return false;
      if (
        requestedTitles.size > 0 &&
        !group.screenings.some((screening) =>
          requestedTitles.has(comparableTitle(screening.movie_title)),
        )
      ) {
        return false;
      }
      if (requestedTitles.size > 0 || mode === "all") return true;
      if (mode === "unlinked") {
        return group.screenings.some((screening) => !screening.movie_id);
      }
      return group.screenings.some((screening) =>
        screening.movie_id
          ? retryable(moviesById.get(screening.movie_id), retryBefore)
          : false,
      );
    });

    if (mode === "retry" && requestedTitles.size === 0) {
      eligible.sort((left, right) => {
        const leftAttempt = groupRetrySortTime(
          left,
          moviesById,
          retryBefore,
        );
        const rightAttempt = groupRetrySortTime(
          right,
          moviesById,
          retryBefore,
        );
        if (leftAttempt !== rightAttempt) {
          return leftAttempt < rightAttempt ? -1 : 1;
        }
        return left.cleaned.identityKey.localeCompare(
          right.cleaned.identityKey,
        );
      });
    }

    const batch = eligible.slice(offset, offset + maxTitles);
    const hasMore = eligible.length > offset + batch.length;
    const results: Array<Record<string, unknown>> = [];
    const stats = {
      matched: 0,
      needs_review: 0,
      unmatched: 0,
      manual_preserved: 0,
      inserted: 0,
      updated: 0,
      reused_tmdb: 0,
      errors: 0,
      screenings_linked: 0,
    };

    for (const group of batch) {
      const manualMovie = findManualMovie(
        group,
        moviesById,
        moviesByNormalised,
      );
      if (manualMovie) {
        if (!dryRun) {
          await linkScreenings(
            supabase,
            group.screenings.map((screening) => screening.id),
            manualMovie.id,
          );
          stats.screenings_linked += group.screenings.length;
        }
        stats.manual_preserved += 1;
        results.push({
          public_titles: [...new Set(group.screenings.map((s) => s.movie_title))],
          query_title: group.cleaned.queryTitle,
          year_hint: group.cleaned.yearHint,
          status: "manual_preserved",
          movie_id: manualMovie.id,
          tmdb_id: manualMovie.tmdb_id,
          reason: "manually confirmed row preserved without TMDB search",
        });
        continue;
      }

      try {
        const existingMatchedMovie = mode === "retry"
          ? findExistingMatchedMovie(group, moviesById)
          : null;
        const decision = existingMatchedMovie
          ? await refreshExistingTmdbMatch(tmdbToken, existingMatchedMovie)
          : await decideMatch(tmdbToken, group.cleaned, knownIdentities);
        stats[decision.status] += 1;
        let persistence: Record<string, unknown> = { action: "dry_run" };
        if (!dryRun) {
          const saved = await persistDecision(
            supabase,
            group,
            decision,
            moviesById,
            moviesByNormalised,
            moviesByTmdb,
            movieUsageKeys,
          );
          stats[saved.action] += 1;
          stats.screenings_linked += group.screenings.length;
          persistence = { action: saved.action, movie_id: saved.movieId };
        }
        results.push({
          public_titles: [...new Set(group.screenings.map((s) => s.movie_title))],
          cinemas_screenings: group.screenings.length,
          query_title: group.cleaned.queryTitle,
          normalised_title: group.cleaned.identityKey,
          year_hint: group.cleaned.yearHint,
          year_hint_source: group.cleaned.yearHintSource,
          anniversary_years: group.cleaned.anniversaryYears,
          removed_labels: group.cleaned.removedLabels,
          heavily_altered: group.cleaned.heavilyAltered,
          fallback_category: group.cleaned.fallbackCategory,
          status: decision.status,
          confidence: decision.confidence,
          tmdb_id: decision.tmdbId,
          poster_path: decision.posterPath,
          candidate_tmdb_id: decision.candidateTmdbId,
          candidate_poster_path: decision.candidatePosterPath,
          release_year: decision.releaseYear,
          reason: decision.reason,
          ...persistence,
        });
      } catch (error) {
        stats.errors += 1;
        if (!dryRun && mode === "retry") {
          try {
            await markLinkedMoviesAttempted(
              supabase,
              group,
              moviesById,
              new Date().toISOString(),
            );
          } catch (attemptError) {
            console.error(
              "[match-movie-posters] failed to record retry attempt:",
              attemptError,
            );
          }
        }
        results.push({
          public_titles: [...new Set(group.screenings.map((s) => s.movie_title))],
          query_title: group.cleaned.queryTitle,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const lastKey = batch.at(-1)?.cleaned.identityKey ?? null;
    console.log(
      `[match-movie-posters] ${dryRun ? "dry-run" : "write"} mode=${mode} ` +
        `processed=${batch.length} stats=${JSON.stringify(stats)}`,
    );
    return jsonResponse({
      success: stats.errors === 0,
      dry_run: dryRun,
      mode,
      offset,
      retry_before: mode === "retry" ? retryBefore : null,
      retry_after_days: mode === "retry" && body.retry_before === undefined
        ? retryAfterDays
        : null,
      run_started_at: runStartedAt,
      run_completed_at: new Date().toISOString(),
      active_future_screenings: screenings.length,
      active_future_unique_titles: allGroups.length,
      eligible_unique_titles: eligible.length,
      processed_unique_titles: batch.length,
      remaining_eligible_titles: Math.max(
        eligible.length - offset - batch.length,
        0,
      ),
      next_cursor: mode === "retry" ? null : hasMore ? lastKey : null,
      stats,
      results,
    });
  } catch (error) {
    console.error("[match-movie-posters] fatal error:", error);
    return jsonResponse(
      {
        success: false,
        dry_run: dryRun,
        mode,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});
