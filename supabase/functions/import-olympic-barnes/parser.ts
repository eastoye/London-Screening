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

export type LondonToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) => Date;

export interface CoreScreening {
  movieTitle: string;
  startTimeIso: string;
  bookingId: string;
  bookingUrl: string | null;
  sourceReference: string;
  filmSlug: string;
  filmUrl: string;
  displayFormat: string | null;
  soldOut: boolean;
  projectionFormats: ProjectionFormat[];
  accessibilityFeatures: AccessibilityFeature[];
  programmeTypes: ProgrammeType[];
  availabilityStatus: AvailabilityStatus;
  screeningLabel: string | null;
  screeningTags: ScreeningTag[];
}

export interface ListingParseResult {
  screenings: CoreScreening[];
  dateSections: number;
  bookingButtons: number;
  errors: string[];
}

export interface DetailPerformance {
  startTimeIso: string | null;
  availability: "in_stock" | "out_of_stock" | "unknown";
  artworkUrl: string | null;
}

export interface FilmDetail {
  slug: string;
  title: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
  artworkUrl: string | null;
  performances: Map<string, DetailPerformance>;
}

export interface ExistingMetadata {
  movieTitle: string;
  filmTitleHint: string | null;
  sourceReleaseYear: number | null;
  sourceRuntimeMinutes: number | null;
  sourceDirectors: string[];
  sourceCountries: string[];
  sourceEventUrl: string | null;
  screenName: string | null;
  verifiedArtworkUrl: string | null;
}

export interface EnrichedScreening extends CoreScreening {
  filmTitleHint: string | null;
  sourceReleaseYear: number | null;
  sourceRuntimeMinutes: number | null;
  sourceDirectors: string[];
  sourceCountries: string[];
  sourceEventUrl: string;
  screenName: string | null;
  verifiedArtworkUrl: string | null;
  detailTimeMismatch: boolean;
}

const ORIGIN = "https://www.olympiccinema.com";
const BOOKING_ORIGIN = "https://web1.empire.mycloudcinema.com";
const ARTWORK_ORIGIN = "https://m.cinemacloud.co.uk";

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39);|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&bull;|&#8226;/gi, "•")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(value: unknown): string {
  return decodeEntities(String(value ?? ""))
    .replace(/<br\s*\/?\s*>/gi, ", ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilmUrl(slug: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  return `${ORIGIN}/film/${slug}`;
}

function parseBookingUrl(value: string): {
  bookingId: string;
  url: string;
  suffix: string | null;
} | null {
  try {
    const url = new URL(decodeEntities(value));
    if (url.protocol !== "https:" || url.origin !== BOOKING_ORIGIN || url.pathname !== "/") return null;
    const match = url.hash.match(/^#\/book\/(\d+)(?:\/([^?#]+))?$/i);
    if (!match) return null;
    return {
      bookingId: match[1],
      url: url.href,
      suffix: match[2]?.toLowerCase() ?? null,
    };
  } catch {
    return null;
  }
}

function parseDateHeading(value: string): { day: number; month: number; year: number | null } | null {
  const text = cleanText(value).replace(/,/g, "");
  let match = text.match(/^[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (!month) return null;
    return { day: Number(match[2]), month, year: match[3] ? Number(match[3]) : null };
  }
  match = text.match(/^[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return { day: Number(match[1]), month, year: match[3] ? Number(match[3]) : null };
}

function inferYear(day: number, month: number, nowLondon: Date): number {
  let year = nowLondon.getUTCFullYear();
  const currentMonth = nowLondon.getUTCMonth() + 1;
  if (month <= 3 && currentMonth >= 10) year++;
  if (month >= 10 && currentMonth <= 3) year--;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? year : Number.NaN;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = cleanText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function suffixLabel(suffix: string | null): string | null {
  if (!suffix) return null;
  const decoded = decodeURIComponent(suffix).replace(/&amp;/gi, "&");
  if (/^q(?:&|%26|-)a$/i.test(decoded) || /^q-amp-a$/i.test(decoded)) return "Q&A";
  if (decoded === "kids-club") return "Kids Club";
  if (decoded === "babes-in-arms") return "Babes in Arms";
  if (decoded === "preview-screening") return "Preview Screening";
  if (decoded === "relaxed-screening") return "Relaxed Screening";
  if (/^(?:captioned|audio-described|members-only|senior-screening)$/i.test(decoded)) {
    return decoded.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  }
  return null;
}

function explicitTitleLabels(title: string): string[] {
  const labels: string[] = [];
  if (/^Preview Screening\s*[-:]/i.test(title)) labels.push("Preview Screening");
  if (/\bQ\s*(?:&|\+)\s*A\b/i.test(title)) labels.push("Q&A");
  if (/\bIntroduction\b|\bIntro\b/i.test(title)) labels.push("Introduction");
  if (/\bDouble[ -]Bill\b/i.test(title)) labels.push("Double Bill");
  if (/\bRelaxed Screening\b/i.test(title)) labels.push("Relaxed Screening");
  if (/\bCaptioned\b|\bHard of Hearing\b/i.test(title)) labels.push("Captioned");
  if (/\bAudio Described\b/i.test(title)) labels.push("Audio Described");
  return labels;
}

function explicitFormats(title: string, labels: string[]): string[] {
  const values: string[] = [];
  const source = [title, ...labels].join(" ");
  for (const match of source.matchAll(/\b(?:8|16|35|70)\s*mm\b|\bIMAX\b|\b4K\b|\bDCP\b|\bDigital\b|\bVHS\b/gi)) {
    values.push(match[0].replace(/\s+/g, ""));
  }
  return compactStrings(values);
}

function publicLabels(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of compactStrings(values)) {
    if (/^Sold[ -]?Out$/i.test(value)) continue;
    const key = value.toLowerCase().replace(/&|\+/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }
  return output;
}

function accessibilityFromLabels(labels: string[]): AccessibilityFeature[] {
  const text = labels.join(" ");
  const output: AccessibilityFeature[] = [];
  if (/\bCaptioned\b|\bHard of Hearing\b/i.test(text)) output.push("captioned");
  if (/\bAudio Described\b/i.test(text)) output.push("audio_described");
  if (/\bRelaxed Screening\b/i.test(text)) output.push("relaxed");
  return output;
}

function programmesFromLabels(labels: string[]): ProgrammeType[] {
  const text = labels.join(" ");
  const output: ProgrammeType[] = [];
  if (/\bBabes in Arms\b|\bParent(?:s)?\s*(?:&|and)\s*Bab(?:y|ies)\b/i.test(text)) {
    output.push("parent_and_baby");
  }
  if (/\bMembers?[’']? Only\b/i.test(text)) output.push("members_only");
  if (/\bSenior(?:s| Citizen)?(?: Screening)?\b/i.test(text)) output.push("seniors");
  return output;
}

export function parseProgrammeListing(
  html: string,
  nowUtc: Date,
  nowLondon: Date,
  londonToUtc: LondonToUtc,
): ListingParseResult {
  const screenings: CoreScreening[] = [];
  const errors: string[] = [];
  let dateSections = 0;
  let bookingButtons = 0;
  const sectionExpression = /<section\s+class="date-section">([\s\S]*?)<\/section>/gi;

  for (const sectionMatch of html.matchAll(sectionExpression)) {
    dateSections++;
    const section = sectionMatch[1];
    const heading = section.match(/<h3[^>]*class="[^"]*date-day[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const date = heading ? parseDateHeading(heading) : null;
    if (!date) {
      errors.push(`Date section ${dateSections} had no valid date heading.`);
      continue;
    }
    const year = date.year ?? inferYear(date.day, date.month, nowLondon);
    if (!Number.isInteger(year)) {
      errors.push(`Date section ${dateSections} had an invalid calendar date.`);
      continue;
    }

    const filmLinks = [...section.matchAll(/<a\s+[^>]*href="\/film\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({ slug: match[1], title: cleanText(match[2]), index: match.index ?? 0 }));
    if (!filmLinks.length) errors.push(`Date section ${dateSections} contained no film rows.`);

    for (let filmIndex = 0; filmIndex < filmLinks.length; filmIndex++) {
      const film = filmLinks[filmIndex];
      const nextIndex = filmLinks[filmIndex + 1]?.index ?? section.length;
      const block = section.slice(film.index, nextIndex);
      const filmUrl = safeFilmUrl(film.slug);
      if (!film.title || !filmUrl) {
        errors.push(`Date section ${dateSections} contained an invalid film link.`);
        continue;
      }

      const buttonExpression = /<a\s+([^>]*class="[^"]*\bbtn\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
      for (const button of block.matchAll(buttonExpression)) {
        bookingButtons++;
        const attributes = button[1];
        const inner = button[2];
        const rawHref = attributes.match(/\bhref="([^"]+)"/i)?.[1] ?? "";
        const booking = parseBookingUrl(rawHref);
        const timeText = inner.match(/<span[^>]*class="[^"]*btn-times-fs[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
        const time = timeText ? parseTime(timeText) : null;
        if (!booking || !time) {
          errors.push(`${film.title}: a future-facing performance lacked a valid booking ID, URL or time.`);
          continue;
        }
        const start = londonToUtc(year, date.month, date.day, time.hour, time.minute);
        if (!Number.isFinite(start.getTime())) {
          errors.push(`${film.title}: performance ${booking.bookingId} had an invalid date/time.`);
          continue;
        }
        if (start <= nowUtc) continue;

        const visibleLabels = [...inner.matchAll(/<span[^>]*class="[^"]*ms-2[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
          .map((match) => cleanText(match[1]))
          .filter(Boolean);
        const soldOut = visibleLabels.some((label) => /^Sold[ -]?Out$/i.test(label));
        const disabled = /\bdisabled\b/i.test(attributes) || /aria-disabled="true"/i.test(attributes);
        const openForSale = !disabled && !soldOut;
        const labels = publicLabels([
          ...visibleLabels,
          suffixLabel(booking.suffix) ?? "",
          ...explicitTitleLabels(film.title),
        ]);
        const formatLabels = explicitFormats(film.title, labels);
        const usableBookingUrl = openForSale ? booking.url : null;

        screenings.push({
          movieTitle: film.title,
          startTimeIso: start.toISOString(),
          bookingId: booking.bookingId,
          bookingUrl: usableBookingUrl,
          sourceReference: `olympic:barnes:${booking.bookingId}`,
          filmSlug: film.slug,
          filmUrl,
          displayFormat: formatLabels.join(", ") || null,
          soldOut,
          projectionFormats: normaliseProjectionFormats(formatLabels),
          accessibilityFeatures: accessibilityFromLabels(labels),
          programmeTypes: programmesFromLabels(labels),
          availabilityStatus: availabilityFromSignals({
            soldOut,
            openForSale,
            hasBookingUrl: Boolean(usableBookingUrl),
          }),
          screeningLabel: labels.join(", ") || null,
          screeningTags: normaliseScreeningTags([
            ...labels,
            labels.some((label) => /^Kids Club$/i.test(label)) ? "Family friendly" : null,
          ]),
        });
      }
    }
  }

  return { screenings, dateSections, bookingButtons, errors };
}

function explicitFieldHtml(html: string, label: string): string | null {
  const expression = new RegExp(
    `<p[^>]*>\\s*${label}:?\\s*</p>\\s*<p[^>]*>([\\s\\S]*?)</p>`,
    "i",
  );
  return html.match(expression)?.[1] ?? null;
}

function splitStructuredList(value: string | null): string[] {
  if (!value) return [];
  const delimited = decodeEntities(value)
    .replace(/<br\s*\/?\s*>/gi, "|")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compactStrings(delimited.split(/\s*(?:\||,|;)\s*/));
}

function safeArtworkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(decodeEntities(value));
    if (url.protocol !== "https:" || url.origin !== ARTWORK_ORIGIN) return null;
    return /^\/imageFilm\/[^/?#]+$/i.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function detailTitle(html: string): string | null {
  const match = html.match(/<h3[^>]*class="[^"]*fs-3[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
  return match ? cleanText(match[1]) || null : null;
}

function exactReleaseYear(html: string): number | null {
  for (const match of html.matchAll(/<span[^>]*class="[^"]*badge[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = cleanText(match[1]);
    if (/^\d{4}$/.test(text)) {
      const year = Number(text);
      if (year >= 1888 && year <= 2200) return year;
    }
  }
  return null;
}

function parseDetailPerformances(html: string): Map<string, DetailPerformance> {
  const performances = new Map<string, DetailPerformance>();
  for (const match of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]) as Record<string, unknown>;
      if (value["@type"] !== "Event") continue;
      const offer = value.offers as Record<string, unknown> | undefined;
      const booking = parseBookingUrl(String(offer?.url ?? ""));
      if (!booking) continue;
      const rawStart = typeof value.startDate === "string" ? value.startDate : "";
      const parsedStart = new Date(rawStart);
      const startTimeIso = rawStart && Number.isFinite(parsedStart.getTime()) ? parsedStart.toISOString() : null;
      const rawAvailability = String(offer?.availability ?? "");
      const availability = /\/InStock$/i.test(rawAvailability)
        ? "in_stock"
        : /\/OutOfStock$/i.test(rawAvailability)
        ? "out_of_stock"
        : "unknown";
      const artworkUrl = safeArtworkUrl(value.image);
      const previous = performances.get(booking.bookingId);
      if (
        previous &&
        (previous.startTimeIso !== startTimeIso || previous.availability !== availability)
      ) {
        throw new Error(`Conflicting JSON-LD for performance ${booking.bookingId}.`);
      }
      performances.set(booking.bookingId, { startTimeIso, availability, artworkUrl });
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return performances;
}

export function parseFilmDetail(slug: string, html: string): FilmDetail {
  const canonical = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1] ?? "";
  if (canonical !== `${ORIGIN}/film/${slug}`) throw new Error(`${slug}: canonical film URL did not match.`);
  const runtimeText = explicitFieldHtml(html, "Duration");
  const heroArtwork = html.match(/<img[^>]*src="(https:\/\/m\.cinemacloud\.co\.uk\/imageFilm\/[^\"]+_10_\d+\.[^\"]+)"[^>]*class="[^"]*film-header-bg/i)?.[1] ?? null;
  const performances = parseDetailPerformances(html);
  const jsonLdArtwork = [...performances.values()].find((performance) => performance.artworkUrl)?.artworkUrl ?? null;

  return {
    slug,
    title: detailTitle(html),
    releaseYear: exactReleaseYear(html),
    runtimeMinutes: parseRuntimeMinutes(runtimeText ? cleanText(runtimeText) : null),
    directors: splitStructuredList(explicitFieldHtml(html, "Director")),
    countries: splitStructuredList(explicitFieldHtml(html, "Country")),
    artworkUrl: safeArtworkUrl(heroArtwork) ?? jsonLdArtwork,
    performances,
  };
}

function safeFilmTitleHint(publicTitle: string, detail: FilmDetail): string | null {
  const sourceTitle = detail.title;
  if (!sourceTitle) return null;
  if (/^(?:NT Live|RBO|ROH|EOS|Met Opera|National Theatre|Royal Ballet|Royal Opera)\s*:/i.test(sourceTitle)) {
    return null;
  }
  let hint = sourceTitle
    .replace(/^Kids Club:\s*/i, "")
    .replace(/^Preview Screening\s*[-:]\s*/i, "")
    .replace(/\s*\+\s*Q\s*(?:&|\+)\s*A\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/\s\+\s/.test(hint) || /\b(?:programme|selection|compilation)\b/i.test(hint)) return null;
  if (hint.length < 2) return null;
  const comparablePublic = publicTitle
    .replace(/^Kids Club:\s*/i, "")
    .replace(/^Preview Screening\s*[-:]\s*/i, "")
    .replace(/\s*\+\s*Q\s*(?:&|\+)\s*A\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return comparablePublic.localeCompare(hint, "en", { sensitivity: "base" }) === 0 ? hint : null;
}

export function enrichScreening(
  core: CoreScreening,
  detail: FilmDetail | null,
  existing: ExistingMetadata | null,
): EnrichedScreening {
  if (!detail) {
    const canReuse = existing?.movieTitle === core.movieTitle;
    return {
      ...core,
      filmTitleHint: canReuse ? existing.filmTitleHint : null,
      sourceReleaseYear: canReuse ? existing.sourceReleaseYear : null,
      sourceRuntimeMinutes: canReuse ? existing.sourceRuntimeMinutes : null,
      sourceDirectors: canReuse ? existing.sourceDirectors : [],
      sourceCountries: canReuse ? existing.sourceCountries : [],
      sourceEventUrl: core.filmUrl,
      screenName: canReuse ? existing.screenName : null,
      verifiedArtworkUrl: canReuse ? existing.verifiedArtworkUrl : null,
      detailTimeMismatch: false,
    };
  }

  const performance = detail.performances.get(core.bookingId);
  const detailTimeMismatch = Boolean(
    performance?.startTimeIso &&
    Math.abs(new Date(performance.startTimeIso).getTime() - new Date(core.startTimeIso).getTime()) > 60_000
  );
  const soldOut = core.soldOut || performance?.availability === "out_of_stock";
  const available = !soldOut && (performance?.availability === "in_stock" || core.availabilityStatus === "available");
  const bookingUrl = available ? core.bookingUrl : null;

  return {
    ...core,
    bookingUrl,
    soldOut,
    availabilityStatus: soldOut ? "sold_out" : available ? "available" : "unknown",
    filmTitleHint: safeFilmTitleHint(core.movieTitle, detail),
    sourceReleaseYear: detail.releaseYear,
    sourceRuntimeMinutes: detail.runtimeMinutes,
    sourceDirectors: detail.directors,
    sourceCountries: detail.countries,
    sourceEventUrl: core.filmUrl,
    screenName: null,
    verifiedArtworkUrl: detail.artworkUrl ?? performance?.artworkUrl ?? null,
    detailTimeMismatch,
  };
}

export function validateScreenings(screenings: EnrichedScreening[]): string[] {
  const errors: string[] = [];
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const row of screenings) {
    if (references.has(row.sourceReference)) errors.push(`Duplicate source reference ${row.sourceReference}.`);
    references.add(row.sourceReference);
    const titleTime = `${row.movieTitle.toLowerCase()}|${row.startTimeIso}`;
    if (titleTimes.has(titleTime)) errors.push(`Duplicate title/time ${row.movieTitle} at ${row.startTimeIso}.`);
    titleTimes.add(titleTime);
    if (row.detailTimeMismatch) errors.push(`${row.sourceReference}: listing/detail time mismatch.`);
    if (row.soldOut && row.bookingUrl) errors.push(`${row.sourceReference}: sold-out row retained a booking URL.`);
    if (row.availabilityStatus === "available" && !row.bookingUrl) {
      errors.push(`${row.sourceReference}: available row lacked a booking URL.`);
    }
  }
  return errors;
}
