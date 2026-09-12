import {
  availabilityFromSignals,
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
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
  PP?: unknown;
  SP?: unknown;
  CM?: unknown;
  QA?: unknown;
  FF?: unknown;
  HoH?: unknown;
  RS?: unknown;
  CB?: unknown;
  NoAds?: unknown;
  RF?: unknown;
  StartDate?: unknown;
  StartTime?: unknown;
  StartTimeAndNotes?: unknown;
  Notes?: unknown;
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

interface SavoyPayload { Events?: unknown }

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

export type LondonToUtc = (
  year: number, month: number, day: number, hour: number, minute: number,
) => Date;

const SOURCE_ORIGIN = "https://riocinema.org.uk";
const PROGRAMME_PATH = "/Rio.dll/WhatsOn";
const PROGRAMME_URL = `${SOURCE_ORIGIN}${PROGRAMME_PATH}`;
const ARTWORK_ORIGINS = new Set([SOURCE_ORIGIN, "https://images.savoysystems.co.uk"]);

const PERFORMANCE_LABELS: Array<{ key: keyof SavoyPerformance; label: string }> = [
  { key: "PP", label: "Pink Palace" },
  { key: "SP", label: "Special Event" },
  { key: "CM", label: "Classic Matinee" },
  { key: "QA", label: "Q+A / Discussion" },
  { key: "FF", label: "Family Flicks" },
  { key: "HoH", label: "Hard of Hearing" },
  { key: "RS", label: "Relaxed Screening" },
  { key: "CB", label: "Carers + Baby" },
  { key: "NoAds", label: "No Ads or Trailers" },
  { key: "RF", label: "Rio Forever" },
];

function isYes(value: unknown): boolean {
  return value === true || String(value ?? "").toUpperCase() === "Y";
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#(?:39|039);|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–").replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&bull;|&#8226;/gi, "•").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function cleanText(value: unknown): string {
  return decodeEntities(String(value ?? ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value: unknown, allowedOrigins: Set<string>, base = PROGRAMME_URL): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(decodeEntities(value), base);
    return url.protocol === "https:" && allowedOrigins.has(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

function extractObject(html: string): string {
  const marker = /\bvar\s+Events\s*=\s*/.exec(html);
  if (!marker) throw new Error("Savoy Events payload was not found.");
  const start = html.indexOf("{", marker.index + marker[0].length);
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
    if (character === '"') { inString = true; continue; }
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error("Savoy Events payload is incomplete.");
}

export function extractEventsPayload(html: string): SavoyEvent[] {
  let payload: SavoyPayload;
  try {
    payload = JSON.parse(extractObject(html)) as SavoyPayload;
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
  const url = safeUrl(performance.URL, new Set([SOURCE_ORIGIN]));
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.pathname === "/Rio.dll/Booking" && parsed.search.includes(`TcsPerformance_${performanceId}.`)
    ? parsed.href
    : null;
}

function seasonLabels(event: SavoyEvent): string[] {
  if (!Array.isArray(event.Seasons)) return [];
  return compactStrings(event.Seasons.map((season) =>
    season && typeof season === "object"
      ? cleanText((season as Record<string, unknown>).SeasonName)
      : null
  )).filter((label) => !/^Main Features?$/i.test(label));
}

function performanceLabels(performance: SavoyPerformance): string[] {
  const labels = PERFORMANCE_LABELS.filter(({ key }) => isYes(performance[key])).map(({ label }) => label);
  const notes = cleanText(performance.Notes);
  if (/\bHard of Hearing\b/i.test(notes)) labels.push("Hard of Hearing");
  if (/\bRelaxed Screening\b/i.test(notes)) labels.push("Relaxed Screening");
  if (/\bNo Ads or Trailers\b/i.test(notes)) labels.push("No Ads or Trailers");
  return labels;
}

function publicLabels(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of compactStrings(values)) {
    const key = value.toLowerCase()
      .replace(/&|\+/g, "and")
      .replace(/babies/g, "baby")
      .replace(/events/g, "event")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result;
}

function explicitProjectionLabels(event: SavoyEvent, title: string): string[] {
  const labels: string[] = [];
  if (Array.isArray(event.Tags)) {
    for (const tag of event.Tags) {
      if (!tag || typeof tag !== "object") continue;
      const label = cleanText((tag as Record<string, unknown>).Format);
      if (/\b(?:8|16|35|70)\s*mm\b|\bIMAX\b|\b4K\b|\bDCP\b|\bDigital\b|\bVHS\b/i.test(label)) labels.push(label);
    }
  }
  for (const match of title.matchAll(/\b(?:8|16|35|70)\s*mm\b|\bIMAX\b|\b4K\b|\bDCP\b|\bVHS\b/gi)) {
    labels.push(match[0].replace(/\s+/g, ""));
  }
  return compactStrings(labels);
}

function titleFeatureLabels(title: string): string[] {
  const labels: string[] = [];
  if (/\bQ\s*(?:&|\+)\s*A\b/i.test(title)) labels.push("Q+A");
  if (/\bDiscussion\b/i.test(title)) labels.push("Discussion");
  if (/\bAcoustic Set\b/i.test(title)) labels.push("Live music");
  if (/\bShadow Cast\b/i.test(title)) labels.push("Shadow Cast");
  if (/\bBook Launch\b/i.test(title)) labels.push("Book Launch");
  return labels;
}

function singleYear(value: unknown): number | null {
  const text = cleanText(value);
  if (!/^\d{4}$/.test(text)) return null;
  const year = Number(text);
  return year >= 1888 && year <= 2200 ? year : null;
}

function directors(value: unknown): string[] {
  const text = cleanText(value);
  if (!text || /^\?+$/.test(text) || /^(?:Various|World Wide Web)$/i.test(text)) return [];
  return compactStrings(text.split(/\s*(?:,|;|\/|\band\b|&)\s*/i));
}

function countries(value: unknown): string[] {
  const text = cleanText(value);
  if (!text || /^\?+$/.test(text)) return [];
  if (/^[A-Z]{2,3}\s*&\s*[A-Z]{2,3}$/.test(text)) return compactStrings(text.split(/\s*&\s*/));
  return compactStrings(text.split(/\s*(?:,|;|\/)\s*/));
}

function hasCompilationEvidence(title: string, synopsis: string, year: string, director: string): boolean {
  if (/\b(?:programme|selection|collection|showcase)\s+of\s+(?:short\s+)?films?\b/i.test(synopsis)) return true;
  if (/\bshort films?\b|\bmusic videos\b/i.test(synopsis)) return true;
  if (/^(?:Various|World Wide Web)$/i.test(director) || /^\?+$/.test(director)) return true;
  if (/\d{4}\s*(?:\/|,|–|-)\s*\d{4}/.test(year) || /^\?+$/.test(year)) return true;
  const withoutFeatures = title
    .replace(/\(\s*\+?\s*(?:Q\s*(?:&|\+)\s*A.*|Discussion|Craft Activities|Acoustic Set)\s*\)/gi, "")
    .replace(/\s*\+\s*(?:Q\s*(?:&|\+)\s*A.*|Book Launch)\s*$/gi, "");
  return /\s\+\s/.test(withoutFeatures);
}

function cleanFilmTitleHint(title: string, synopsis: string, year: string, director: string): string | null {
  if (hasCompilationEvidence(title, synopsis, year, director)) return null;
  if (!singleYear(year) && directors(director).length === 0) return null;
  let hint = title
    .replace(/^Carers\s*(?:&|and)\s*Bab(?:y|ies):\s*/i, "")
    .replace(/^Classic Matinee:\s*/i, "")
    .replace(/^Saturday Morning Picture Club:\s*/i, "")
    .replace(/^(?:Fringe!\s+and\s+)?Pink Palace:\s*/i, "")
    .replace(/^Pink Palace\s*&\s*Contemporary Films:\s*/i, "")
    .replace(/^Doc'n Roll:\s*/i, "")
    .replace(/^Hong Kong Film Festival:\s*/i, "")
    .replace(/^Tibet Film Festival London:\s*/i, "")
    .replace(/^Never Watching Movies(?:\s*&[^:]+)?:\s*/i, "")
    .replace(/^Queer Horror Nights:\s*/i, "")
    .replace(/^J\.G\.\s*Ballard[’']s\s+/i, "")
    .replace(/\s+presented by\s+.+$/i, "")
    .replace(/\s+with Shadow Cast\s*$/i, "")
    .replace(/\s*\(\s*\+?\s*(?:Q\s*(?:&|\+)\s*A.*|Discussion|Craft Activities|Acoustic Set)\s*\)\s*$/i, "")
    .replace(/\s*\+\s*(?:Q\s*(?:&|\+)\s*A.*|Book Launch)\s*$/i, "")
    .replace(/\s*\((?:8|16|35|70)\s*mm\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return hint.length >= 2 ? hint : null;
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
    const synopsis = cleanText(event.Synopsis);
    const yearText = cleanText(event.Year);
    const directorText = cleanText(event.Director);
    const runtime = parseRuntimeMinutes(event.RunningTime as string | number | null | undefined);
    const officialEventUrl = eventUrl(event, eventId);
    const artworkUrl = safeUrl(event.ImageURL, ARTWORK_ORIGINS);
    const sourceDirectors = directors(event.Director);
    const sourceCountries = countries(event.Country);
    const projectionLabels = explicitProjectionLabels(event, title);
    const performances = Array.isArray(event.Performances) ? event.Performances as SavoyPerformance[] : [];
    totalPerformances += performances.length;
    if (!eventId || !title) {
      errors.push(`Event ${eventId || "unknown"} lacked a stable ID or title.`);
      continue;
    }

    for (const performance of performances) {
      const performanceId = /^\d+$/.test(String(performance.ID ?? "")) ? String(performance.ID) : "";
      const startTimeIso = parseLocalStart(performance, londonToUtc);
      if (!startTimeIso) {
        errors.push(`Performance ${performanceId || "unknown"} had an invalid date/time.`);
        continue;
      }
      if (new Date(startTimeIso) <= now) continue;
      futurePerformances++;

      const soldOut = isYes(performance.IsSoldOut);
      const openForSale = typeof performance.IsOpenForSale === "boolean" ? performance.IsOpenForSale : null;
      const directBookingUrl = bookingUrl(performance, performanceId);
      if (!performanceId || (openForSale === true && !soldOut && !directBookingUrl)) {
        errors.push(`Future performance ${performanceId || "unknown"} lacked a stable ID or usable booking URL.`);
        continue;
      }
      const usableBookingUrl = !soldOut && openForSale === true ? directBookingUrl : null;
      const labels = publicLabels([
        ...seasonLabels(event),
        ...performanceLabels(performance),
        ...titleFeatureLabels(title),
      ]);
      const tagLabels = compactStrings([
        ...labels.filter((label) => label !== "Q+A / Discussion"),
        isYes(performance.FF) ? "Family friendly" : null,
      ]);
      const accessibilityFeatures: AccessibilityFeature[] = [];
      if (isYes(performance.HoH) || labels.some((label) => /^Hard of Hearing$/i.test(label))) {
        accessibilityFeatures.push("captioned");
      }
      if (isYes(performance.RS) || labels.some((label) => /^Relaxed Screening$/i.test(label))) {
        accessibilityFeatures.push("relaxed");
      }
      const programmeTypes: ProgrammeType[] = [];
      if (isYes(performance.CB)) programmeTypes.push("parent_and_baby");
      if (
        isYes(performance.CM) ||
        labels.some((label) => /^Classic Matinee$/i.test(label))
      ) {
        programmeTypes.push("seniors");
      }

      screenings.push({
        movieTitle: title,
        filmTitleHint: cleanFilmTitleHint(title, synopsis, yearText, directorText),
        startTimeIso,
        bookingUrl: usableBookingUrl,
        sourceReference: `rio:${performanceId}`,
        displayFormat: projectionLabels.join(", ") || null,
        soldOut,
        projectionFormats: normaliseProjectionFormats(projectionLabels),
        accessibilityFeatures,
        programmeTypes,
        availabilityStatus: availabilityFromSignals({ soldOut, openForSale, hasBookingUrl: Boolean(usableBookingUrl) }),
        sourceReleaseYear: singleYear(event.Year),
        sourceRuntimeMinutes: runtime,
        sourceDirectors,
        sourceCountries,
        sourceEventUrl: officialEventUrl,
        screenName: cleanText(performance.AuditoriumName) || null,
        screeningLabel: labels.join(", ") || null,
        screeningTags: normaliseScreeningTags(tagLabels),
        artworkUrl,
      });
    }
  }

  return { screenings, totalEvents: events.length, totalPerformances, futurePerformances, errors };
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
