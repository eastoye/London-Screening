import {
  availabilityFromSignals,
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";

export interface SavoyPerformance {
  ID?: unknown;
  IsSoldOut?: unknown;
  IsOpenForSale?: unknown;
  BB?: unknown;
  CC?: unknown;
  AD?: unknown;
  R?: unknown;
  QA?: unknown;
  SU?: unknown;
  NA?: unknown;
  StartDate?: unknown;
  StartTime?: unknown;
  StartTimeAndNotes?: unknown;
  AuditoriumName?: unknown;
  URL?: unknown;
}

export interface SavoyEvent {
  ID?: unknown;
  Title?: unknown;
  TypeDescription?: unknown;
  Synopsis?: unknown;
  RunningTime?: unknown;
  ImageURL?: unknown;
  Director?: unknown;
  Year?: unknown;
  Country?: unknown;
  URL?: unknown;
  Seasons?: unknown;
  Tags?: unknown;
  Performances?: unknown;
}

interface SavoyPayload {
  Events?: unknown;
}

export interface ParsedScreening {
  movieTitle: string;
  filmTitleHint: string | null;
  startTimeIso: string;
  bookingUrl: string | null;
  sourceReference: string;
  displayFormat: string | null;
  soldOut: boolean;
  projectionFormats: ProjectionFormat[];
  accessibilityFeatures: AccessibilityFeature[];
  programmeTypes: ProgrammeType[];
  availabilityStatus: AvailabilityStatus;
  sourceReleaseYear: number | null;
  sourceRuntimeMinutes: number | null;
  sourceDirectors: string[];
  sourceCountries: string[];
  sourceEventUrl: string | null;
  screenName: string | null;
  screeningLabel: string | null;
  screeningTags: ScreeningTag[];
  artworkUrl: string | null;
}

export interface ProgrammeParseResult {
  screenings: ParsedScreening[];
  totalEvents: number;
  totalPerformances: number;
  futurePerformances: number;
  errors: string[];
}

const SOURCE_ORIGIN = "https://www.phoenixcinema.co.uk";
const PROGRAMME_PATH = "/PhoenixCinemaLondon.dll/WhatsOn";
const PROGRAMME_URL = `${SOURCE_ORIGIN}${PROGRAMME_PATH}`;
const ARTWORK_ORIGINS = new Set([
  SOURCE_ORIGIN,
  "https://images.savoysystems.co.uk",
]);
const BOOKING_ORIGINS = new Set([
  SOURCE_ORIGIN,
  "https://escapes.cinematik.app",
  "https://japanesefilm.club",
]);
const FILM_LIKE_TYPES = new Set([
  "film",
  "phoenix classics",
  "documentaries",
  "art live",
]);

export type LondonToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) => Date;

const PERFORMANCE_LABELS: Array<{
  key: keyof SavoyPerformance;
  label: string;
}> = [
  { key: "BB", label: "Watch With Baby" },
  { key: "CC", label: "Closed Captions" },
  { key: "AD", label: "Audio Described" },
  { key: "R", label: "Relaxed Screening" },
  { key: "QA", label: "Q+A" },
  { key: "SU", label: "Subtitled" },
  { key: "NA", label: "Phoenix for Nature" },
];

function isYes(value: unknown): boolean {
  return value === true || String(value ?? "").toUpperCase() === "Y";
}

function cleanText(value: unknown): string {
  return decodeEntities(String(value ?? ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#(?:39|039);|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–").replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function safeUrl(value: unknown, allowedOrigins: Set<string>): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(decodeEntities(value), PROGRAMME_URL);
    return url.protocol === "https:" && allowedOrigins.has(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

function extractObject(html: string, marker: RegExp): string {
  const markerMatch = marker.exec(html);
  if (!markerMatch) throw new Error("Savoy Events payload was not found.");
  const start = html.indexOf("{", markerMatch.index + markerMatch[0].length);
  if (start < 0) throw new Error("Savoy Events payload has no opening brace.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error("Savoy Events payload is incomplete.");
}

export function extractEventsPayload(html: string): SavoyEvent[] {
  let payload: SavoyPayload;
  try {
    payload = JSON.parse(extractObject(html, /\bvar\s+Events\s*=\s*/)) as SavoyPayload;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Savoy Events payload was invalid JSON.");
    throw error;
  }
  if (!Array.isArray(payload.Events)) throw new Error("Savoy Events payload has no Events array.");
  return payload.Events as SavoyEvent[];
}

function parseLocalStart(performance: SavoyPerformance, londonToUtc: LondonToUtc): string | null {
  const date = String(performance.StartDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let time = String(performance.StartTime ?? "").trim().match(/^(\d{2})(\d{2})$/);
  if (!time) time = String(performance.StartTimeAndNotes ?? "").match(/\b(\d{1,2}):(\d{2})\b/);
  if (!date || !time) return null;

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day || hour > 23 || minute > 59
  ) return null;
  return londonToUtc(year, month, day, hour, minute).toISOString();
}

function eventUrl(event: SavoyEvent, eventId: string): string | null {
  const url = safeUrl(event.URL, new Set([SOURCE_ORIGIN]));
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.pathname === PROGRAMME_PATH && parsed.searchParams.get("f") === eventId ? parsed.href : null;
}

function bookingUrl(performance: SavoyPerformance, performanceId: string): string | null {
  const url = safeUrl(performance.URL, BOOKING_ORIGINS);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.origin === SOURCE_ORIGIN) {
    return parsed.pathname === "/PhoenixCinemaLondon.dll/Booking" &&
        parsed.search.includes(`TcsPerformance_${performanceId}.`)
      ? parsed.href
      : null;
  }
  if (parsed.origin === "https://escapes.cinematik.app") {
    return parsed.pathname.startsWith("/book/") ? parsed.href : null;
  }
  return parsed.origin === "https://japanesefilm.club" ? parsed.href : null;
}

function formatLabels(event: SavoyEvent): string[] {
  if (!Array.isArray(event.Tags)) return [];
  const labels: string[] = [];
  for (const tag of event.Tags) {
    if (!tag || typeof tag !== "object") continue;
    const format = cleanText((tag as Record<string, unknown>).Format);
    if (format) labels.push(format);
  }
  return compactStrings(labels);
}

function isProjectionLabel(label: string): boolean {
  return /\b(?:8|16|35|70)\s*mm\b|\bIMAX\b|\b4K\b|\bDCP\b|\bDigital\b|\bVHS\b/i.test(label);
}

function seasonLabels(event: SavoyEvent): string[] {
  if (!Array.isArray(event.Seasons)) return [];
  return compactStrings(event.Seasons.map((season) =>
    season && typeof season === "object"
      ? cleanText((season as Record<string, unknown>).SeasonName)
      : null
  ));
}

function performanceLabels(performance: SavoyPerformance): string[] {
  return PERFORMANCE_LABELS.filter(({ key }) => isYes(performance[key])).map(({ label }) => label);
}

function titleFeatureLabels(title: string): string[] {
  const labels: string[] = [];
  if (/\+\s*(?:(?:director|recorded)\s+)?Q\s*(?:&|\+)\s*A\b/i.test(title)) labels.push("Q+A");
  if (/\blive score(?:\s+by\b|$)/i.test(title)) labels.push("Live score");
  if (/\banniversary celebration\b/i.test(title)) labels.push("Anniversary");
  return labels;
}

function isCompilation(title: string, synopsis: string): boolean {
  return /\b(?:programme|selection|collection|showcase)\s+of\s+(?:short\s+)?films?\b/i.test(synopsis) ||
    /\bshort films?\b/i.test(synopsis) ||
    /\bthe film edit\b/i.test(title);
}

function cleanFilmTitleHint(
  title: string,
  typeDescription: string,
  synopsis: string,
  labels: string[],
): string | null {
  if (!FILM_LIKE_TYPES.has(typeDescription.toLowerCase()) || isCompilation(title, synopsis)) return null;
  let hint = title;
  if (labels.some((label) => /^Watch With Baby$/i.test(label))) {
    hint = hint.replace(/^Parent\s*(?:&|and)\s*Baby Screening:\s*/i, "");
  }
  if (labels.some((label) => /^Phoenix for Nature$/i.test(label))) {
    hint = hint.replace(/^Phoenix For Nature:\s*/i, "");
  }
  hint = hint
    .replace(/^75 Years of Contemporary Films:\s*/i, "")
    .replace(/^Tribute to Dolly Parton:\s*/i, "")
    .replace(/\s*\+\s*(?:(?:director|recorded)\s+)?Q\s*(?:&|\+)\s*A(?:\s+with\b.*)?$/i, "")
    .replace(/\s+live score(?:\s+by\b.*)?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return hint && hint.length >= 2 ? hint : null;
}

function directors(value: unknown, filmLike: boolean): string[] {
  if (!filmLike) return [];
  const text = cleanText(value);
  if (!text || /^(?:presented|hosted|introduced|conducted)\s+by\b/i.test(text)) return [];
  return compactStrings(text.split(/\s*(?:,|;|\band\b|&)\s*/i));
}

function countries(value: unknown, filmLike: boolean): string[] {
  if (!filmLike) return [];
  return compactStrings(cleanText(value).split(/\s*(?:,|;|\/)\s*/));
}

export function parseProgramme(html: string, now: Date, londonToUtc: LondonToUtc): ProgrammeParseResult {
  const events = extractEventsPayload(html);
  const screenings: ParsedScreening[] = [];
  const errors: string[] = [];
  let totalPerformances = 0;
  let futurePerformances = 0;

  for (const event of events) {
    const eventId = /^\d+$/.test(String(event.ID ?? "")) ? String(event.ID) : "";
    const title = cleanText(event.Title);
    const typeDescription = cleanText(event.TypeDescription);
    const synopsis = cleanText(event.Synopsis);
    const officialEventUrl = eventUrl(event, eventId);
    const artworkUrl = safeUrl(event.ImageURL, ARTWORK_ORIGINS);
    const runtime = parseRuntimeMinutes(event.RunningTime as string | number | null | undefined);
    const filmLike = FILM_LIKE_TYPES.has(typeDescription.toLowerCase());
    const releaseYear = filmLike
      ? parseExplicitYear(event.Year as string | number | null | undefined)
      : null;
    const sourceDirectors = directors(event.Director, filmLike);
    const sourceCountries = countries(event.Country, filmLike);
    const formats = formatLabels(event);
    const projections = normaliseProjectionFormats(formats);
    const displayFormat = formats.filter(isProjectionLabel).join(", ") || null;
    const performances = Array.isArray(event.Performances)
      ? event.Performances as SavoyPerformance[]
      : [];
    totalPerformances += performances.length;

    if (!eventId || !title) {
      errors.push(`Event ${eventId || "unknown"} lacked a stable ID or title.`);
      continue;
    }

    if (!filmLike) continue;

    for (const performance of performances) {
      const performanceId = /^\d+$/.test(String(performance.ID ?? "")) ? String(performance.ID) : "";
      const startTimeIso = parseLocalStart(performance, londonToUtc);
      if (!startTimeIso) {
        errors.push(`Performance ${performanceId || "unknown"} had an invalid date/time.`);
        continue;
      }
      if (new Date(startTimeIso) <= now) continue;
      futurePerformances++;

      const screenName = cleanText(performance.AuditoriumName);
      const soldOut = isYes(performance.IsSoldOut);
      const openForSale = typeof performance.IsOpenForSale === "boolean"
        ? performance.IsOpenForSale
        : null;
      const directBookingUrl = bookingUrl(performance, performanceId);
      if (!performanceId || (openForSale === true && !soldOut && !directBookingUrl)) {
        errors.push(`Future performance ${performanceId || "unknown"} lacked a stable ID or usable booking URL.`);
        continue;
      }
      const usableBookingUrl = !soldOut && openForSale === true ? directBookingUrl : null;
      const explicitLabels = compactStrings([
        ...(typeDescription.toLowerCase() === "film" ? [] : [typeDescription]),
        ...seasonLabels(event),
        ...performanceLabels(performance),
        ...titleFeatureLabels(title),
      ]);
      const programmeTypes: ProgrammeType[] = explicitLabels.some((label) =>
        /^(?:Watch With Baby|Parent\s*(?:&|and)\s*Baby)$/i.test(label)
      ) ? ["parent_and_baby"] : [];
      const accessibilityFeatures: AccessibilityFeature[] = [];
      if (isYes(performance.CC)) accessibilityFeatures.push("captioned");
      if (isYes(performance.AD)) accessibilityFeatures.push("audio_described");
      if (isYes(performance.R)) accessibilityFeatures.push("relaxed");

      screenings.push({
        movieTitle: title,
        filmTitleHint: cleanFilmTitleHint(title, typeDescription, synopsis, explicitLabels),
        startTimeIso,
        bookingUrl: usableBookingUrl,
        sourceReference: `phoenix:${performanceId}`,
        displayFormat,
        soldOut,
        projectionFormats: projections,
        accessibilityFeatures,
        programmeTypes,
        availabilityStatus: availabilityFromSignals({
          soldOut,
          openForSale,
          hasBookingUrl: Boolean(usableBookingUrl),
        }),
        sourceReleaseYear: releaseYear,
        sourceRuntimeMinutes: runtime,
        sourceDirectors,
        sourceCountries,
        sourceEventUrl: officialEventUrl,
        screenName,
        screeningLabel: explicitLabels.join(", ") || null,
        screeningTags: normaliseScreeningTags(explicitLabels),
        artworkUrl,
      });
    }
  }

  return {
    screenings,
    totalEvents: events.length,
    totalPerformances,
    futurePerformances,
    errors,
  };
}

export function validateScreenings(screenings: ParsedScreening[]): string[] {
  const errors: string[] = [];
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const row of screenings) {
    if (references.has(row.sourceReference)) errors.push(`Duplicate source reference ${row.sourceReference}.`);
    references.add(row.sourceReference);
    const titleTime = `${row.movieTitle.toLowerCase()}|${row.startTimeIso}`;
    if (titleTimes.has(titleTime)) errors.push(`Duplicate title/time ${row.movieTitle} at ${row.startTimeIso}.`);
    titleTimes.add(titleTime);
    if (row.soldOut && row.bookingUrl) errors.push(`${row.sourceReference}: sold-out row has a booking URL.`);
    if (row.availabilityStatus === "available" && !row.bookingUrl) errors.push(`${row.sourceReference}: available row lacks a booking URL.`);
  }
  return errors;
}
