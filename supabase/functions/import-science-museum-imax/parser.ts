export type ProjectionFormat = "35mm" | "70mm" | "imax";
export type AvailabilityStatus = "available" | "sold_out" | "unknown";

export interface OfficialFilm {
  displayTitle: string;
  filmTitleHint: string | null;
  eventUrl: string;
  bookingKeywordId: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
  artworkUrl: string | null;
  displayFormat: string;
  projectionFormats: ProjectionFormat[];
  screenName: string;
}

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
  displayFormat: string;
  projectionFormats: ProjectionFormat[];
  accessibilityFeatures: [];
  programmeTypes: [];
  availabilityStatus: AvailabilityStatus;
  screenName: string;
  screeningLabel: string | null;
  screeningTags: [];
  soldOut: boolean;
}

interface TicketPerformance {
  id?: unknown;
  performanceDate?: unknown;
  iso8601DateString?: unknown;
  displayDate?: unknown;
  displayTime?: unknown;
  performanceTitle?: unknown;
  actionUrl?: unknown;
  isPerformanceVisible?: unknown;
  isOnSale?: unknown;
  performanceStatusMessage?: unknown;
}

interface TicketProduction {
  productionSeasonId?: unknown;
  productionTitle?: unknown;
  performances?: unknown;
}

export interface TicketParseResult {
  screenings: ParsedScreening[];
  sourcePerformances: number;
  errors: string[];
}

const MUSEUM_ORIGIN = "https://www.sciencemuseum.org.uk";
const TICKET_ORIGIN = "https://my.sciencemuseum.org.uk";

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#(?:39|039);|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–").replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&reg;/gi, "®").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
    : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function safeUrl(value: unknown, expectedOrigin: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(decodeEntities(value), expectedOrigin);
    return url.origin === expectedOrigin && url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normaliseTitle(value: string): string {
  return cleanText(value).toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s*\((?:u|pg|12a|12|15|18|cert\s+tbc)\)\s*(?:imax®?)?\s*$/i, "")
    .replace(/\s+imax(?:®|\s+70mm)?\s*$/i, "")
    .replace(/[^a-z0-9']+/g, " ").trim();
}

function cardBodies(section: string): string[] {
  return section.split(/<article\b[^>]*class="[^"]*c-card[^"]*"[^>]*>/i).slice(1)
    .map((chunk) => {
      const end = chunk.indexOf("</article>");
      return end >= 0 ? chunk.slice(0, end) : "";
    })
    .filter(Boolean);
}

function filmPathsFromCards(section: string): string[] {
  const paths: string[] = [];
  for (const body of cardBodies(section)) {
    const category = cleanText(body.match(/<div\b[^>]*class="[^"]*c-card__info[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "")
      .replace(/^Category:\s*/i, "");
    const href = body.match(/<a\b[^>]*href="(\/see-and-do\/[^"#?]+)"/i)?.[1];
    if (href && /^IMAX screening$/i.test(category)) paths.push(href);
  }
  return paths;
}

export function discoverOfficialFilmPages(imaxHtml: string, seasonHtml: string): { urls: string[]; errors: string[] } {
  const errors: string[] = [];
  const blockbuster = imaxHtml.match(/<span\b[^>]*id="blockbuster-films-currently-showing"[^>]*>[\s\S]*?<\/span>([\s\S]*?)<span\b[^>]*id="educational-films-currently-showing"/i)?.[1];
  const educational = imaxHtml.match(/<span\b[^>]*id="educational-films-currently-showing"[^>]*>[\s\S]*?<\/span>([\s\S]*?)(?:<span\b[^>]*id="visit-information"|<h2[^>]*>\s*Visit information)/i)?.[1];
  if (!blockbuster || !educational) {
    errors.push("The official IMAX page no longer exposes the expected blockbuster and educational-film sections.");
  }
  const seasonWhatsOn = seasonHtml.match(/<span\b[^>]*id="what-s-on"[^>]*>[\s\S]*?<\/span>([\s\S]*?)(?:<span\b[^>]*id="visit-information"|<h2[^>]*>\s*Visit information)/i)?.[1] ?? "";
  const paths = unique([
    ...(blockbuster ? filmPathsFromCards(blockbuster) : []),
    ...(educational ? filmPathsFromCards(educational) : []),
    ...filmPathsFromCards(seasonWhatsOn),
  ]);
  if (paths.length === 0) errors.push("No official blockbuster, educational, or 70mm film pages were found.");
  return { urls: paths.map((path) => new URL(path, MUSEUM_ORIGIN).href), errors };
}

function labelledValue(html: string, label: string): string {
  const expression = new RegExp(`<span\\b[^>]*class="[^"]*o-label[^"]*"[^>]*>\\s*${label}:?\\s*<\\/span>([\\s\\S]*?)(?:<\\/li>|<span\\b[^>]*class="[^"]*o-label)`, "i");
  return cleanText(html.match(expression)?.[1] ?? "");
}

function structuredCredit(html: string): { hint: string | null; year: number | null; runtime: number | null; directors: string[] } {
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const raw = match[1];
    const text = cleanText(raw);
    const yearMatch = text.match(/(?:^|[,;]\s*)((?:19|20|21)\d{2})(?:\s*[,;]|$)/);
    const runtimeMatch = text.match(/\b(\d{1,3})\s*(?:mins?|minutes?)\b/i);
    const directorMatch = text.match(/\bdir(?:ector)?\.?\s+(.+?)(?=\s*[,;]\s*\d{1,3}\s*(?:mins?|minutes?)\b|[.;]?$)/i);
    if (!yearMatch || !runtimeMatch || !directorMatch) continue;
    const hint = cleanText(raw.match(/<em\b[^>]*>([\s\S]*?)<\/em>/i)?.[1] ?? "") || null;
    return {
      hint,
      year: Number(yearMatch[1]),
      runtime: Number(runtimeMatch[1]),
      directors: unique(directorMatch[1].split(/\s*(?:,|;|\band\b|&)\s*/i)),
    };
  }
  return { hint: null, year: null, runtime: null, directors: [] };
}

function bookingKeywordId(html: string): string | null {
  for (const href of html.matchAll(/href="(https:\/\/my\.sciencemuseum\.org\.uk\/events\?[^"#]+)"/gi)) {
    const url = safeUrl(href[1], TICKET_ORIGIN);
    if (!url) continue;
    const keyword = new URL(url).searchParams.get("kid");
    if (keyword && /^\d+$/.test(keyword)) return keyword;
  }
  return null;
}

export function parseOfficialFilmPage(html: string, eventUrl: string): OfficialFilm | null {
  if (!/IMAX screening/i.test(html)) return null;
  const displayTitle = cleanText(html.match(/<h1\b[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (!displayTitle) return null;
  const credit = structuredCredit(html);
  const duration = Number(labelledValue(html, "Duration").match(/\b(\d{1,3})\s*(?:mins?|minutes?)\b/i)?.[1] ?? 0) || null;
  const location = labelledValue(html, "Location");
  if (!/^IMAX:\s*The Ronson Theatre\b/i.test(location)) return null;
  const artworkUrl = safeUrl(html.match(/<meta\b[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1], MUSEUM_ORIGIN);
  const is70mm = /\bIMAX(?:\s|&nbsp;|<[^>]+>)*70mm\b|\b70mm(?:\s|&nbsp;|<[^>]+>)*IMAX\b/i.test(html);
  const hint = credit.hint && normaliseTitle(credit.hint) === normaliseTitle(displayTitle) ? credit.hint : null;
  return {
    displayTitle,
    filmTitleHint: hint,
    eventUrl,
    bookingKeywordId: bookingKeywordId(html),
    releaseYear: credit.year,
    runtimeMinutes: duration ?? credit.runtime,
    directors: credit.directors,
    countries: [],
    artworkUrl,
    displayFormat: is70mm ? "IMAX, 70mm" : "IMAX",
    projectionFormats: is70mm ? ["imax", "70mm"] : ["imax"],
    screenName: "The Ronson Theatre",
  };
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function safeBookingUrl(value: unknown, productionSeasonId: string, performanceId: number): string | null {
  const url = safeUrl(value, TICKET_ORIGIN);
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.pathname === `/${productionSeasonId}/${performanceId}` ? parsed.href : null;
}

export function parseTicketResponse(payload: unknown, film: OfficialFilm, now: Date): TicketParseResult {
  const errors: string[] = [];
  const screenings: ParsedScreening[] = [];
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { productions?: unknown }).productions)) {
    return { screenings, sourcePerformances: 0, errors: ["Ticket API response did not contain a productions array."] };
  }
  let sourcePerformances = 0;
  for (const production of (payload as { productions: TicketProduction[] }).productions) {
    const productionTitle = cleanText(production.productionTitle);
    const productionSeasonId = cleanText(production.productionSeasonId);
    if (!productionTitle || !/^\d+$/.test(productionSeasonId) || !Array.isArray(production.performances)) {
      errors.push("Ticket API returned an incomplete production.");
      continue;
    }
    if (normaliseTitle(productionTitle) !== normaliseTitle(film.displayTitle)) {
      errors.push(`Ticket API returned unexpected production '${productionTitle}' for '${film.displayTitle}'.`);
      continue;
    }
    for (const performance of production.performances as TicketPerformance[]) {
      if (performance.isPerformanceVisible !== true) continue;
      sourcePerformances++;
      const performanceId = typeof performance.id === "number" && Number.isInteger(performance.id) ? performance.id : null;
      const utc = parseInstant(performance.performanceDate);
      const local = parseInstant(performance.iso8601DateString);
      if (!performanceId || !utc || !local || utc.getTime() !== local.getTime()) {
        errors.push(`${productionTitle}: performance lacked a valid ID or matching UTC/local timestamps.`);
        continue;
      }
      if (utc <= now) continue;
      const status = cleanText(performance.performanceStatusMessage);
      const soldOut = /\bsold\s*out\b/i.test(status);
      const directUrl = safeBookingUrl(performance.actionUrl, productionSeasonId, performanceId);
      const bookingUrl = !soldOut && performance.isOnSale === true ? directUrl : null;
      const available = performance.isOnSale === true && Boolean(bookingUrl);
      const performanceTitle = cleanText(performance.performanceTitle);
      const label = performanceTitle && normaliseTitle(performanceTitle) !== normaliseTitle(film.displayTitle)
        ? performanceTitle : null;
      screenings.push({
        movieTitle: film.displayTitle,
        filmTitleHint: film.filmTitleHint,
        startTimeIso: utc.toISOString(),
        bookingUrl,
        sourceReference: `science-museum-imax:${performanceId}`,
        sourceReleaseYear: film.releaseYear,
        sourceRuntimeMinutes: film.runtimeMinutes,
        sourceDirectors: film.directors,
        sourceCountries: film.countries,
        sourceEventUrl: film.eventUrl,
        artworkUrl: film.artworkUrl,
        displayFormat: film.displayFormat,
        projectionFormats: film.projectionFormats,
        accessibilityFeatures: [],
        programmeTypes: [],
        availabilityStatus: soldOut ? "sold_out" : available ? "available" : "unknown",
        screenName: film.screenName,
        screeningLabel: label,
        screeningTags: [],
        soldOut,
      });
    }
  }
  return { screenings, sourcePerformances, errors };
}

export function validateScreenings(screenings: ParsedScreening[]): string[] {
  const errors: string[] = [];
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const row of screenings) {
    if (references.has(row.sourceReference)) errors.push(`Duplicate source reference ${row.sourceReference}.`);
    references.add(row.sourceReference);
    const titleTime = `${normaliseTitle(row.movieTitle)}|${row.startTimeIso}`;
    if (titleTimes.has(titleTime)) errors.push(`Duplicate title/time ${row.movieTitle} at ${row.startTimeIso}.`);
    titleTimes.add(titleTime);
    if (row.soldOut && row.bookingUrl) errors.push(`${row.sourceReference}: sold-out row retained a booking URL.`);
    if (row.availabilityStatus === "available" && !row.bookingUrl) errors.push(`${row.sourceReference}: available row lacked a booking URL.`);
  }
  return errors;
}
