export type ProjectionFormat = "35mm" | "70mm" | "imax";
export type AccessibilityFeature = "captioned" | "audio_described" | "relaxed";
export type ProgrammeType = "members_only" | "parent_and_baby" | "child_required" | "seniors";
export type ScreeningTag =
  | "q_and_a" | "introduction" | "discussion" | "premiere" | "preview"
  | "anniversary" | "double_bill" | "live_music" | "singalong" | "no_adverts"
  | "family_friendly" | "send_friendly" | "subtitled" | "dubbed"
  | "rerelease" | "restoration";

export interface ParsedPerformance {
  movieTitle: string;
  filmTitleHint: string | null;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  bookingUrl: string | null;
  sourceEventUrl: string;
  artworkUrl: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
  projectionFormats: ProjectionFormat[];
  accessibilityFeatures: AccessibilityFeature[];
  programmeTypes: ProgrammeType[];
  screeningTags: ScreeningTag[];
  screeningLabel: string | null;
  soldOut: boolean;
}

export interface ProgrammeParseResult {
  performances: ParsedPerformance[];
  cardCount: number;
  excludedNonFilm: string[];
  excludedPlaceholder: string[];
  errors: string[];
}

export interface DetailEnrichment {
  directors: string[];
  bookingUrl: string | null;
}

const BASE_URL = "https://www.davidleancinema.uk/";
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&#8217;/gi, "'")
    .replace(/&#8211;|&ndash;/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function textLines(value: string): string[] {
  return decodeEntities(
    value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  )
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function normaliseTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function titleMatchKey(value: string): string {
  return normaliseTitle(
    value
      .replace(/^Cert\s+(?:U|PG|12A?|15|18|TBC)\s*[-:–]\s*/i, "")
      .replace(/\s*\((?:BIA|Babes? In Arms|35\s*mm|70\s*mm|IMAX|\+\s*activities)\)\s*$/i, "")
  );
}

function filmTitleHint(title: string): string | null {
  let hint = title
    .replace(/^Cert\s+(?:U|PG|12A?|15|18|TBC)\s*[-:–]\s*/i, "")
    .replace(/\s*\((?:BIA|Babes? In Arms|35\s*mm|70\s*mm|IMAX)\)\s*$/i, "")
    .replace(/\s*\(\+\s*activities\)\s*$/i, "")
    .trim();
  if (!hint || /^(?:TBC|To Be Confirmed)$/i.test(hint)) return null;
  if (/\b(?:shorts?|short films?|compilation|programme)\b/i.test(hint)) return null;
  return hint;
}

function isExplicitNonFilm(title: string, text: string): boolean {
  if (/^(?:NT Live|National Theatre Live|Royal Ballet|Royal Opera|The Met(?:ropolitan)? Opera|English National Ballet)\b/i.test(title)) {
    return true;
  }
  // The official listing presents this item as a 160-minute performance with an interval;
  // its linked Ticketsolve product identifies English National Ballet, not a film.
  if (/^The Sleeping Beauty$/i.test(title) && /\bwith interval\b/i.test(text)) return true;
  return false;
}

function validArtworkUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value), BASE_URL);
    return url.protocol === "https:" && url.hostname === "www.davidleancinema.uk" &&
        url.pathname.startsWith("/wp-content/uploads/")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function validPublicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value), BASE_URL);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseMetadata(line: string): {
  releaseYear: number | null;
  runtimeMinutes: number | null;
  countries: string[];
} | null {
  const match = line.match(/^((?:18|19|20|21)\d{2}|x{4})\s*\|\s*(.*?)\s*\|\s*(\d{1,3}|x{3})\s*min\b/i);
  if (!match) return null;
  const releaseYear = /^\d{4}$/.test(match[1]) ? Number(match[1]) : null;
  const runtimeMinutes = /^\d{1,3}$/.test(match[3]) ? Number(match[3]) : null;
  const countries = match[2]
    .split("|")
    .map((country) => country.trim())
    .filter((country) => country.length > 1 && !/^x+$/i.test(country));
  return {
    releaseYear: releaseYear && releaseYear >= 1888 && releaseYear <= 2200 ? releaseYear : null,
    runtimeMinutes: runtimeMinutes && runtimeMinutes <= 600 ? runtimeMinutes : null,
    countries: unique(countries),
  };
}

function inferProgrammeYear(day: number, month: number, nowLondon: Date): number {
  let year = nowLondon.getFullYear();
  const currentMonth = nowLondon.getMonth() + 1;
  if (month <= 3 && currentMonth >= 10) year += 1;
  if (month >= 10 && currentMonth <= 3) year -= 1;
  return year;
}

function parseClock(hourText: string, minuteText: string, ampm: string): { hour: number; minute: number } | null {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;
  if (ampm.toLowerCase() === "pm" && hour !== 12) hour += 12;
  return { hour, minute };
}

function labelsForPerformance(
  allText: string,
  inlineLabel: string | null,
  index: number,
  total: number
): string[] {
  const labels: string[] = [];
  if (inlineLabel) labels.push(inlineLabel.trim());

  // Only promote performance metadata to every showtime when the card explicitly
  // states that it applies to all/both/every screening. Parenthetical labels next
  // to a time are already captured by inlineLabel and must remain performance-specific.
  const cardWideMatch = allText.match(
    /\b(?:all|both|every)\s+(?:screenings?|performances?)\b[^.!?;]{0,120}\b(?:English subtitles|subtitles|subtitled|captioned|HOH|hard of hearing|Dementia Friendly|Babes? In Arms|BIA)\b/i,
  );
  if (cardWideMatch) labels.push(cardWideMatch[0]);

  if (/\bno trailers\b|\bdo not show adverts\b/i.test(allText)) labels.push("No trailers / no adverts");
  if (/\bevening screening includes descriptive subtitles\b/i.test(allText) && index === total - 1) {
    labels.push("Descriptive subtitles");
  }
  if (/\bafternoon screening includes descriptive subtitles\b/i.test(allText) && index === 0) {
    labels.push("Descriptive subtitles");
  }
  return unique(labels);
}

function structuredLabels(labels: string[]): {
  projectionFormats: ProjectionFormat[];
  accessibilityFeatures: AccessibilityFeature[];
  programmeTypes: ProgrammeType[];
  screeningTags: ScreeningTag[];
} {
  const text = labels.join(" ");
  const projectionFormats: ProjectionFormat[] = [];
  if (/\b35\s*mm\b/i.test(text)) projectionFormats.push("35mm");
  if (/\b70\s*mm\b/i.test(text)) projectionFormats.push("70mm");
  if (/\bIMAX\b/i.test(text)) projectionFormats.push("imax");

  const accessibilityFeatures: AccessibilityFeature[] = [];
  if (/\bHOH\b|descriptive subtitles|captioned/i.test(text)) accessibilityFeatures.push("captioned");
  if (/audio described|audio description|\bAD\b/i.test(text)) accessibilityFeatures.push("audio_described");
  if (/\brelaxed\b/i.test(text)) accessibilityFeatures.push("relaxed");

  const programmeTypes: ProgrammeType[] = [];
  if (/Babes? In Arms|\bBIA\b/i.test(text)) programmeTypes.push("parent_and_baby");

  const screeningTags: ScreeningTag[] = [];
  if (/English subtitles|\bsubtitled\b|\bwith subtitles\b/i.test(text)) screeningTags.push("subtitled");
  if (/\bno trailers\b|\bno adverts\b/i.test(text)) screeningTags.push("no_adverts");
  if (/\brestor(?:ed|ation)\b/i.test(text)) screeningTags.push("restoration");
  if (/\banniversary\b/i.test(text)) screeningTags.push("anniversary");
  return { projectionFormats, accessibilityFeatures, programmeTypes, screeningTags };
}

export function extractDirectorMap(html: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const slides = html.split(/<div class="et_pb_slide_\d+[^>]*>/i);
  for (const slide of slides) {
    const titleHtml = slide.match(/et_pb_slide_title[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1];
    const contentHtml = slide.match(/<div class="et_pb_slide_content">([\s\S]*?)<\/div>/i)?.[1];
    if (!titleHtml || !contentHtml) continue;
    const title = stripTags(titleHtml);
    const director = stripTags(contentHtml).match(/\bDir\s+([^|]+?)\s*\|/i)?.[1]?.trim();
    if (!director) continue;
    const directors = director.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean);
    const key = titleMatchKey(title);
    result.set(key, directors);
    const withoutParenthetical = title.replace(/\s*\([^)]*\)\s*$/, "");
    if (withoutParenthetical !== title) result.set(titleMatchKey(withoutParenthetical), directors);
  }
  return result;
}

export function extractProgramme(html: string, nowLondon: Date): ProgrammeParseResult {
  const performances: ParsedPerformance[] = [];
  const excludedNonFilm: string[] = [];
  const excludedPlaceholder: string[] = [];
  const errors: string[] = [];
  const directors = extractDirectorMap(html);
  const chunks = html.split(/<div class="[^"]*\bet_pb_column_\d+\b[^"]*">/i);
  let cardCount = 0;

  for (const chunk of chunks) {
    if (!/class="[^"]*d5tl-image/i.test(chunk)) continue;
    const textInner = chunk.match(/<div class="[^"]*et_pb_text_inner[^"]*">([\s\S]*?)<\/div>/i)?.[1];
    const titleHtml = textInner?.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    if (!textInner || !titleHtml) continue;
    const lines = textLines(textInner);
    const title = stripTags(titleHtml);
    const metadataLine = lines.find((line) => /^(?:(?:18|19|20|21)\d{2}|x{4})\s*\|/i.test(line));
    const scheduleLine = lines.find((line) => /^(?:Mon|Tue|Tues|Wed|Weds|Thu|Thurs|Fri|Sat|Sun)\w*\s+\d{1,2}\s+[A-Za-z]+\s+at\s+/i.test(line));
    if (!metadataLine || !scheduleLine) continue;
    cardCount += 1;
    const allText = lines.join(" ");

    if (isExplicitNonFilm(title, allText)) {
      excludedNonFilm.push(title);
      continue;
    }

    const button = [...chunk.matchAll(/<a[^>]*class="[^"]*et_pb_button[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({ url: validPublicUrl(match[1]), text: stripTags(match[2]) }))
      .find((item) => /tickets?|sold out/i.test(item.text));
    const soldOut = /\bsold out\b/i.test(`${button?.text ?? ""} ${allText}`);
    if (/^(?:TBC|To Be Confirmed)$/i.test(title) && !button?.url && !soldOut) {
      excludedPlaceholder.push(title);
      continue;
    }

    const metadata = parseMetadata(metadataLine);
    const date = scheduleLine.match(/^(?:Mon|Tue|Tues|Wed|Weds|Thu|Thurs|Fri|Sat|Sun)\w*\s+(\d{1,2})\s+([A-Za-z]+)\s+at\s+/i);
    if (!metadata || !date) {
      errors.push(`${title}: could not parse explicit metadata/date`);
      continue;
    }
    const day = Number(date[1]);
    const month = MONTHS[date[2].toLowerCase()];
    if (!month) {
      errors.push(`${title}: unknown month ${date[2]}`);
      continue;
    }
    const timeMatches = [...scheduleLine.matchAll(/(\d{1,2})[.:](\d{2})\s*(am|pm)(?:\s*\(([^)]+)\))?/gi)];
    if (timeMatches.length === 0) {
      errors.push(`${title}: no times in ${scheduleLine}`);
      continue;
    }

    const artwork = validArtworkUrl(chunk.match(/<img[^>]*class="[^"]*d5tl-image[^"]*"[^>]*src="([^"]+)"/i)?.[1] ?? null);
    const projectionTitleLabels = [title.match(/\((?:35\s*mm|70\s*mm|IMAX)\)/i)?.[0] ?? ""];
    const sourceEventUrl = button?.url?.startsWith("https://www.davidleancinema.uk/") ? button.url : BASE_URL;
    const cleanHint = filmTitleHint(title);

    timeMatches.forEach((timeMatch, index) => {
      const clock = parseClock(timeMatch[1], timeMatch[2], timeMatch[3]);
      if (!clock) {
        errors.push(`${title}: invalid time ${timeMatch[0]}`);
        return;
      }
      const labels = labelsForPerformance(allText, timeMatch[4] ?? null, index, timeMatches.length);
      labels.push(...projectionTitleLabels.filter(Boolean));
      const structured = structuredLabels(labels);
      performances.push({
        movieTitle: title,
        filmTitleHint: cleanHint,
        year: inferProgrammeYear(day, month, nowLondon),
        month,
        day,
        hour: clock.hour,
        minute: clock.minute,
        bookingUrl: soldOut ? null : button?.url ?? null,
        sourceEventUrl,
        artworkUrl: artwork,
        releaseYear: metadata.releaseYear,
        runtimeMinutes: metadata.runtimeMinutes,
        directors: directors.get(titleMatchKey(title)) ?? [],
        countries: metadata.countries,
        projectionFormats: structured.projectionFormats,
        accessibilityFeatures: structured.accessibilityFeatures,
        programmeTypes: structured.programmeTypes,
        screeningTags: structured.screeningTags,
        screeningLabel: labels.length ? unique(labels).join("; ") : null,
        soldOut,
      });
    });
  }

  return { performances, cardCount, excludedNonFilm: unique(excludedNonFilm), excludedPlaceholder: unique(excludedPlaceholder), errors };
}

export function extractDetailEnrichment(html: string): DetailEnrichment {
  const text = stripTags(html);
  const director = text.match(/\bDir\s+([^|]+?)\s*\|/i)?.[1]?.trim();
  const button = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ url: validPublicUrl(match[1]), text: stripTags(match[2]) }))
    .find((item) => item.url && /get\s+tickets?|book\s+tickets?/i.test(item.text));
  return {
    directors: director ? director.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean) : [],
    bookingUrl: button?.url ?? null,
  };
}
