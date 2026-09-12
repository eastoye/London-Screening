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
  bookingUrl: string | null;
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
  excludedNonFilm: string[];
  errors: string[];
}

const BASE_URL = "https://princecharlescinema.com";
const SOURCE_PREFIX = "pcc";
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const NON_FILM_TYPES = new Set(["film quiz", "live podcast"]);

function unique<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function safeEventUrl(value: string): string | null {
  try {
    const url = new URL(decodeEntities(value), BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "princecharlescinema.com") return null;
    if (!/^\/film\/\d+\//.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeArtworkUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value));
    const allowed = url.hostname === "cdn.taposapp.com"
      || (url.hostname === "posters-uk.s3.eu-west-2.amazonaws.com" && url.pathname.startsWith("/PRILON/"));
    return url.protocol === "https:" && allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeBookingUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value), BASE_URL);
    const pcc = url.protocol === "https:" && url.hostname === "princecharlescinema.com"
      && /^\/prince-charles-cinema\/booknow\/\d+\/?$/.test(url.pathname);
    const bfi = url.protocol === "https:" && url.hostname === "whatson.bfi.org.uk"
      && url.pathname.startsWith("/lff/Online/");
    return pcc || bfi ? url.toString() : null;
  } catch {
    return null;
  }
}

function pccPerformanceId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value), BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "princecharlescinema.com") return null;
    return url.pathname.match(/^\/prince-charles-cinema\/booknow\/(\d+)\/?$/)?.[1] ?? null;
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

function londonNow(nowUtc: Date): Date {
  return new Date(nowUtc.getTime() + londonOffsetMinutes(nowUtc) * 60_000);
}

function inferYear(month: number, currentLondon: Date): number {
  const currentMonth = currentLondon.getUTCMonth() + 1;
  let year = currentLondon.getUTCFullYear();
  if (month <= 3 && currentMonth >= 10) year += 1;
  if (month >= 10 && currentMonth <= 3) year -= 1;
  return year;
}

function parseDate(value: string, currentLondon: Date) {
  const match = value.trim().match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)$/i);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return { year: inferYear(month, currentLondon), month, day: Number(match[1]) };
}

function parseTime(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (match[3].toLowerCase() === "am") hour = hour === 12 ? 0 : hour;
  else if (hour !== 12) hour += 12;
  return { hour, minute };
}

function normaliseTitle(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function sourceReference(title: string, startTime: Date, performanceId: string | null): string {
  if (performanceId) return `${SOURCE_PREFIX}:${performanceId}`;
  const yyyy = startTime.getUTCFullYear();
  const mm = String(startTime.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(startTime.getUTCDate()).padStart(2, "0");
  const hh = String(startTime.getUTCHours()).padStart(2, "0");
  const mi = String(startTime.getUTCMinutes()).padStart(2, "0");
  return `${SOURCE_PREFIX}:${normaliseTitle(title)}:${yyyy}-${mm}-${dd}:${hh}:${mi}`;
}

interface FilmMetadata {
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
  contentType: string | null;
}

function filmMetadata(eventHtml: string): FilmMetadata {
  const runningHtml = eventHtml.match(/<div class="running-time">([\s\S]*?)<\/div>/i)?.[1] ?? "";
  const values = Array.from(runningHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi), (match) => textFromHtml(match[1])).filter(Boolean);
  const yearIndex = values.findIndex((value) => /^(?:18|19|20|21)\d{2}$/.test(value));
  const rawYear = yearIndex >= 0 ? Number(values[yearIndex]) : null;
  const releaseYear = rawYear && rawYear >= 1888 && rawYear <= 2200 ? rawYear : null;
  const runtimeIndex = values.findIndex((value) => /^\d{1,4}\s*mins?$/i.test(value));
  const runtimeMatch = runtimeIndex >= 0 ? values[runtimeIndex].match(/^(\d{1,4})/) : null;
  const rawRuntime = runtimeMatch ? Number(runtimeMatch[1]) : null;
  const runtimeMinutes = rawRuntime && rawRuntime <= 1440 ? rawRuntime : null;
  const certificateIndex = values.findIndex((value) => /^\([^)]+\)$/.test(value));
  const contentType = certificateIndex >= 0 && values[certificateIndex + 1] ? values[certificateIndex + 1] : null;
  const countryValues = runtimeIndex >= 0 && certificateIndex > runtimeIndex + 1
    ? values.slice(runtimeIndex + 1, certificateIndex)
    : [];
  const countries = countryValues.flatMap((value) => value.split(/\s*(?:,|\/)\s*/))
    .filter((value) => value && !/^(?:unknown|various|we can'?t tell you)$/i.test(value));

  const directorText = textFromHtml(eventHtml.match(/<div class="film-info">([\s\S]*?)<\/div>/i)?.[1] ?? "")
    .match(/Directed by\s+(.+?)(?=\s+Starring\b|$)/i)?.[1];
  const directors = directorText
    ? directorText.split(/\s*(?:,|&|\band\b)\s*/i).map((value) => value.trim())
      .filter((value) => value && !/^(?:various(?: directors?)?|unknown|n\/?a|who knows\??)$/i.test(value))
    : [];
  return { releaseYear, runtimeMinutes, directors: unique(directors), countries: unique(countries), contentType };
}

function titleHint(title: string, contentType: string | null): string | null {
  if (/\b(?:mystery movie|all[- ]nighter|double bill|triple bill|shorts? programme|film quiz|live podcast)\b/i.test(title)) return null;
  if (/movie marathons/i.test(contentType ?? "")) return null;
  let value = title
    .replace(/\s*[-–—]\s*\d+(?:st|nd|rd|th)\s+Anniversary\s*$/i, "")
    .replace(/\s*\((?:18|19|20|21)\d{2}\)\s*$/, "")
    .replace(/\s*(?:\+|with)\s*Q(?:\s*(?:&|\+)\s*|\s+and\s+)A(?:\s+screening)?\s*$/i, "")
    .replace(/\s*\+\s*(?:video\s+)?intro(?:duction)?(?:\s+by\b.*)?$/i, "")
    .replace(/\s*\+\s*live\s+score(?:\s+by\b.*)?$/i, "")
    .trim();
  if (/\s+\+\s+/.test(value)) return null;
  return value || null;
}

function normaliseTags(rawTags: string[], title: string) {
  const tags = unique(rawTags.map((tag) => tag.replace(/\s+/g, " ").trim()).filter(Boolean));
  const lower = tags.map((tag) => tag.toLowerCase());
  const projectionFormats: ProjectionFormat[] = [];
  const accessibilityFeatures: AccessibilityFeature[] = [];
  const programmeTypes: ProgrammeType[] = [];
  const screeningTags: ScreeningTag[] = [];

  if (lower.some((tag) => /\b35\s*mm\b/.test(tag))) projectionFormats.push("35mm");
  if (lower.some((tag) => /\b70\s*mm\b/.test(tag))) projectionFormats.push("70mm");
  if (lower.some((tag) => /\bimax\b/.test(tag))) projectionFormats.push("imax");
  if (lower.includes("hoh")) accessibilityFeatures.push("captioned");
  if (lower.includes("£1 mem")) programmeTypes.push("members_only");
  if (lower.includes("sub") || lower.includes("hoh")) screeningTags.push("subtitled");
  if (lower.includes("q&a")) screeningTags.push("q_and_a");
  if (lower.includes("intro") || lower.includes("vid intro")) screeningTags.push("introduction");
  if (lower.includes("live score")) screeningTags.push("live_music");
  if (lower.includes("sing along")) screeningTags.push("singalong");
  if (lower.includes("premiere") || lower.includes("ukpremiere")) screeningTags.push("premiere");
  if (lower.includes("preview")) screeningTags.push("preview");
  if (/\b\d+(?:st|nd|rd|th)\s+anniversary\b/i.test(title)) screeningTags.push("anniversary");
  if (/\bdouble bill\b/i.test(title)) screeningTags.push("double_bill");

  const displayFormats = tags.filter((tag) => /^(?:35mm|70mm|4K|IMAX|35mm\s*\/\s*DCP)$/i.test(tag));
  return {
    displayFormat: displayFormats.length ? displayFormats.join(", ") : null,
    projectionFormats: unique(projectionFormats),
    accessibilityFeatures: unique(accessibilityFeatures),
    programmeTypes: unique(programmeTypes),
    screeningTags: unique(screeningTags),
    screeningLabel: tags.length ? tags.join(", ") : null,
  };
}

export function parsePrinceCharlesPage(html: string, nowUtc = new Date()): ParseResult {
  const eventStarts = Array.from(html.matchAll(/<div class="jacro-event movie-tabs row[^>]*>/gi), (match) => match.index ?? 0);
  const screenings = new Map<string, ParsedScreening>();
  const excluded = new Set<string>();
  const errors: string[] = [];
  const currentLondon = londonNow(nowUtc);

  for (let eventIndex = 0; eventIndex < eventStarts.length; eventIndex++) {
    const eventHtml = html.slice(eventStarts[eventIndex], eventStarts[eventIndex + 1] ?? html.length);
    const titleMatch = eventHtml.match(/<a class="liveeventtitle"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const movieTitle = textFromHtml(titleMatch[2]);
    const sourceEventUrl = safeEventUrl(titleMatch[1]);
    if (!movieTitle || !sourceEventUrl) continue;
    const metadata = filmMetadata(eventHtml);
    const unknownMysteryFilm = /^Mystery (?:Horror )?Movie$/i.test(movieTitle);
    if (metadata.contentType && NON_FILM_TYPES.has(metadata.contentType.toLowerCase())) {
      excluded.add(movieTitle);
      continue;
    }
    const artworkUrl = safeArtworkUrl(eventHtml.match(/<div class="film_img">[\s\S]*?<img[^>]*\ssrc="([^"]+)"/i)?.[1]);
    const filmTitleHint = titleHint(movieTitle, metadata.contentType);
    const performanceHtml = eventHtml.match(/<ul class="performance-list-items">([\s\S]*?)<\/ul>/i)?.[1];
    if (!performanceHtml) continue;
    const dateChunks = performanceHtml.split(/<div class="heading">([^<]+)<\/div>/i);

    for (let chunkIndex = 1; chunkIndex < dateChunks.length; chunkIndex += 2) {
      const dateText = textFromHtml(dateChunks[chunkIndex]);
      const date = parseDate(dateText, currentLondon);
      if (!date) {
        errors.push(`${movieTitle}: unparseable date ${dateText}`);
        continue;
      }
      const itemsHtml = dateChunks[chunkIndex + 1] ?? "";
      for (const itemMatch of itemsHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const itemHtml = itemMatch[1];
        const timeText = textFromHtml(itemHtml.match(/<span class="time">([\s\S]*?)<\/span>/i)?.[1] ?? "");
        const time = parseTime(timeText);
        if (!time) {
          errors.push(`${movieTitle}: unparseable time ${timeText || "(missing)"}`);
          continue;
        }
        const soldOut = /soldfilm_book_button/i.test(itemHtml) || /\bSold Out\b/i.test(itemHtml);
        const bookingAnchor = Array.from(itemHtml.matchAll(/<a\b[^>]*>/gi), (match) => match[0])
          .find((anchor) => {
            const classes = anchor.match(/\bclass="([^"]*)"/i)?.[1]?.split(/\s+/) ?? [];
            return classes.includes("film_book_button") || classes.includes("soldfilm_book_button");
          });
        const rawHref = bookingAnchor?.match(/\bhref="([^"]+)"/i)?.[1];
        const performanceId = pccPerformanceId(rawHref);
        const bookingUrl = soldOut ? null : safeBookingUrl(rawHref);
        if (!soldOut && rawHref && !bookingUrl) {
          errors.push(`${movieTitle}: rejected booking URL`);
          continue;
        }
        const rawTags = Array.from(itemHtml.matchAll(/<span class="tag[^"]*">([\s\S]*?)<\/span>/gi), (match) => textFromHtml(match[1]));
        const tagMetadata = normaliseTags(rawTags, movieTitle);
        const startTime = londonToUtc(date.year, date.month, date.day, time.hour, time.minute);
        const reference = sourceReference(movieTitle, startTime, performanceId);
        const record: ParsedScreening = {
          movieTitle,
          filmTitleHint,
          startTimeIso: startTime.toISOString(),
          bookingUrl,
          sourceReference: reference,
          sourceReleaseYear: unknownMysteryFilm ? null : metadata.releaseYear,
          sourceRuntimeMinutes: unknownMysteryFilm ? null : metadata.runtimeMinutes,
          sourceDirectors: unknownMysteryFilm ? [] : metadata.directors,
          sourceCountries: unknownMysteryFilm ? [] : metadata.countries,
          sourceEventUrl,
          artworkUrl,
          soldOut,
          availabilityStatus: soldOut ? "sold_out" : bookingUrl ? "available" : "unknown",
          ...tagMetadata,
        };
        const previous = screenings.get(reference);
        if (!previous) screenings.set(reference, record);
        else if (previous.movieTitle !== record.movieTitle || previous.startTimeIso !== record.startTimeIso) {
          errors.push(`${reference}: conflicting duplicate performance`);
        }
      }
    }
  }
  if (!eventStarts.length) errors.push("No Jacro film events were found");
  return { screenings: Array.from(screenings.values()), excludedNonFilm: Array.from(excluded).sort(), errors };
}
