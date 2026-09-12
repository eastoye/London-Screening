export type ProjectionFormat = "35mm" | "70mm" | "imax";
export type AccessibilityFeature = "captioned" | "audio_described" | "relaxed";
export type ProgrammeType = "members_only" | "parent_and_baby" | "child_required" | "seniors";
export type AvailabilityStatus = "available" | "sold_out" | "unknown";
export type ScreeningTag =
  | "q_and_a" | "introduction" | "discussion" | "premiere" | "preview"
  | "anniversary" | "double_bill" | "live_music" | "singalong" | "no_adverts"
  | "family_friendly" | "send_friendly" | "subtitled" | "dubbed"
  | "rerelease" | "restoration";

export interface ParsedScreening {
  movieTitle: string;
  filmTitleHint: string | null;
  startTimeIso: string;
  bookingUrl: string;
  sourceReference: string;
  sourceReleaseYear: number | null;
  sourceRuntimeMinutes: number | null;
  sourceDirectors: string[];
  sourceCountries: string[];
  sourceEventUrl: string;
  artworkUrl: string | null;
  displayFormat: string | null;
  projectionFormats: ProjectionFormat[];
  accessibilityFeatures: AccessibilityFeature[];
  programmeTypes: ProgrammeType[];
  availabilityStatus: AvailabilityStatus;
  screeningLabel: string | null;
  screeningTags: ScreeningTag[];
  soldOut: boolean;
}

export interface ParseResult {
  screenings: ParsedScreening[];
  sourceCount: number;
  errors: string[];
}

interface SourceFilm {
  id?: unknown;
  title?: unknown;
  runtime?: unknown;
  year?: unknown;
  country?: unknown;
  director?: unknown;
  imageUrl?: unknown;
}

interface SourceScreening {
  id?: unknown;
  filmId?: unknown;
  screeningDate?: unknown;
  capacity?: unknown;
  ticketsSold?: unknown;
  format?: unknown;
  film?: SourceFilm;
}

const BASE_URL = "https://thenickel.co.uk";
const SOURCE_PREFIX = "nickel";

function unique<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\\u0026/gi, "&").replace(/\s+/g, " ").trim() : "";
}

function validInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function meaningfulValues(value: unknown): string[] {
  const text = cleanText(value);
  if (!text || /^(?:\?|unknown|n\/?a|not known|various)$/i.test(text)) return [];
  return unique(text.split(/\s*(?:,|\/|\band\b|&)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^(?:\?|unknown|n\/?a|not known|various)$/i.test(part)));
}

function safeArtworkUrl(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function londonOffsetMinutes(dateUtc: Date): number {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  }).formatToParts(dateUtc).find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/);
  if (!match || !match[1]) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function londonToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60_000);
}

function parseLondonDate(value: unknown): Date | null {
  const match = cleanText(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, min] = match.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;
  const utc = londonToUtc(y, m, d, h, min);
  const localParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(utc);
  const part = (type: string) => Number(localParts.find((item) => item.type === type)?.value);
  return part("year") === y && part("month") === m && part("day") === d
      && part("hour") === h && part("minute") === min ? utc : null;
}

function extractFlightData(html: string): string {
  let result = "";
  for (const match of html.matchAll(/<script>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g)) {
    try {
      const value = JSON.parse(match[1]);
      if (Array.isArray(value) && value[0] === 1 && typeof value[1] === "string") result += value[1];
    } catch {
      // Other Next.js bootstrap entries are not programme data.
    }
  }
  return result;
}

function extractJsonArray(source: string, marker: string): unknown[] {
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) throw new Error(`${marker} was not found in the Next.js payload`);
  const start = source.indexOf("[", markerAt + marker.length);
  if (start < 0) throw new Error(`${marker} did not contain an array`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth++;
    else if (character === "]" && --depth === 0) {
      const parsed = JSON.parse(source.slice(start, index + 1));
      if (!Array.isArray(parsed)) throw new Error(`${marker} was not an array`);
      return parsed;
    }
  }
  throw new Error(`${marker} array was incomplete`);
}

function displayTitleAndLabels(rawTitle: string): {
  title: string;
  labels: string[];
  tags: ScreeningTag[];
} {
  const labels: string[] = [];
  const tags: ScreeningTag[] = [];
  if (/^\s*TFFF:\s*/i.test(rawTitle)) {
    labels.push("TFFF");
  }
  if (/\s*\+\s*Q\s*(?:&|\+)\s*A(?:\s+with\b.+)?\s*$/i.test(rawTitle)) {
    labels.push("Q&A");
    tags.push("q_and_a");
  }
  if (/\s*\+\s*LIVE\s+SCORE\s*$/i.test(rawTitle)) {
    labels.push("Live Score");
    tags.push("live_music");
  }
  if (/\brelaxed screening\b/i.test(rawTitle)) {
    labels.push("Relaxed screening");
  }
  return { title: rawTitle, labels: unique(labels), tags: unique(tags) };
}

function projectionFormats(format: string | null): ProjectionFormat[] {
  if (!format) return [];
  const found: ProjectionFormat[] = [];
  if (/\b35\s*mm\b/i.test(format)) found.push("35mm");
  if (/\b70\s*mm\b/i.test(format)) found.push("70mm");
  if (/\bIMAX\b/i.test(format)) found.push("imax");
  return unique(found);
}

function filmTitleHint(
  title: string,
  year: number | null,
  runtime: number | null,
  directors: string[],
): string | null {
  // The source's year, runtime and director together are the evidence that this
  // is a single identified film rather than a mystery show, pass or compilation.
  if (!year || !runtime || directors.length === 0) return null;
  if (/\b(?:mystery|showcase|programme|program|marathon|weekend pass|day (?:one|two)|short films?)\b/i.test(title)) return null;
  let hint = title.replace(/^\s*TFFF:\s*/i, "").trim();
  hint = hint.replace(/^.{1,80}\bPRESENTS:\s*/i, "").trim();
  hint = hint.replace(/\s+\(ON VHS\)\s*$/i, "").trim();
  const additions = hint.match(/^(.+?)\s*\+\s*(.+)$/);
  if (additions) {
    if (/^(?:Q\s*(?:&|\+)\s*A(?:\s+with\b.*)?|intro(?:duction)?(?:\s+by\b.*)?|readings?|discussion(?:\s+with\b.*)?|LIVE\s+SCORE)$/i.test(additions[2].trim())) {
      hint = additions[1].trim();
    } else {
      return null;
    }
  }
  return hint || null;
}

function parseSourceScreening(value: unknown): { screening: ParsedScreening | null; error: string | null } {
  if (!value || typeof value !== "object") return { screening: null, error: "Screening entry was not an object" };
  const row = value as SourceScreening;
  const id = validInteger(row.id, 1, Number.MAX_SAFE_INTEGER);
  const filmId = validInteger(row.filmId, 1, Number.MAX_SAFE_INTEGER);
  const film = row.film;
  const rawTitle = cleanText(film?.title);
  const startTime = parseLondonDate(row.screeningDate);
  if (!id || !filmId || !film || !rawTitle || !startTime) {
    return { screening: null, error: `Incomplete screening ${String(row.id ?? "unknown")}` };
  }
  const nestedFilmId = validInteger(film.id, 1, Number.MAX_SAFE_INTEGER);
  if (nestedFilmId !== filmId) return { screening: null, error: `Film ID mismatch for screening ${id}` };

  const title = displayTitleAndLabels(rawTitle);
  if (!title.title) return { screening: null, error: `Empty display title for screening ${id}` };
  const releaseYear = validInteger(film.year, 1888, 2200);
  const runtime = validInteger(film.runtime, 1, 1440);
  const directors = meaningfulValues(film.director);
  const countries = meaningfulValues(film.country);
  const format = cleanText(row.format).slice(0, 80) || null;
  const capacity = validInteger(row.capacity, 0, 100_000);
  const ticketsSold = validInteger(row.ticketsSold, 0, 100_000);
  const hasCapacitySignal = capacity !== null && capacity > 0 && ticketsSold !== null;
  const soldOut = capacity !== null && capacity > 0 && ticketsSold !== null && ticketsSold >= capacity;
  const availabilityStatus: AvailabilityStatus = hasCapacitySignal
    ? (soldOut ? "sold_out" : "available")
    : "unknown";
  const accessibilityFeatures: AccessibilityFeature[] = [];
  if (title.labels.some((label) => /relaxed screening/i.test(label))) accessibilityFeatures.push("relaxed");
  const eventUrl = `${BASE_URL}/screening/${id}`;

  return {
    screening: {
      movieTitle: title.title,
      filmTitleHint: filmTitleHint(title.title, releaseYear, runtime, directors),
      startTimeIso: startTime.toISOString(),
      bookingUrl: eventUrl,
      sourceReference: `${SOURCE_PREFIX}:${id}`,
      sourceReleaseYear: releaseYear,
      sourceRuntimeMinutes: runtime,
      sourceDirectors: directors,
      sourceCountries: countries,
      sourceEventUrl: eventUrl,
      artworkUrl: safeArtworkUrl(film.imageUrl),
      displayFormat: format,
      projectionFormats: projectionFormats(format),
      accessibilityFeatures,
      programmeTypes: [],
      availabilityStatus,
      screeningLabel: title.labels.length ? title.labels.join(" · ") : null,
      screeningTags: title.tags,
      soldOut,
    },
    error: null,
  };
}

export function parseNickelPage(html: string, nowUtc: Date): ParseResult {
  const errors: string[] = [];
  let sourceRows: unknown[] = [];
  try {
    const flight = extractFlightData(html);
    if (!flight) throw new Error("No Next.js flight data was found");
    sourceRows = extractJsonArray(flight, '"initialScreenings":');
  } catch (error) {
    return { screenings: [], sourceCount: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const screenings: ParsedScreening[] = [];
  for (const row of sourceRows) {
    const parsed = parseSourceScreening(row);
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.screening && new Date(parsed.screening.startTimeIso).getTime() > nowUtc.getTime()) screenings.push(parsed.screening);
  }
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const screening of screenings) {
    if (references.has(screening.sourceReference)) errors.push(`Duplicate source reference: ${screening.sourceReference}`);
    references.add(screening.sourceReference);
    const titleTime = `${screening.movieTitle.toLowerCase()}|${screening.startTimeIso}`;
    if (titleTimes.has(titleTime)) errors.push(`Duplicate title/time: ${screening.movieTitle} at ${screening.startTimeIso}`);
    titleTimes.add(titleTime);
  }
  return { screenings, sourceCount: sourceRows.length, errors };
}
