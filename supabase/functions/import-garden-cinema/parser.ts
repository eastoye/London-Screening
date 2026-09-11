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

const BASE_URL = "https://www.thegardencinema.co.uk";
const SOURCE_PREFIX = "garden";

const COUNTRY_NAMES = new Set([
  "argentina", "australia", "austria", "belgium", "brazil", "canada", "chile",
  "china", "colombia", "czechoslovakia", "denmark", "east germany", "finland",
  "france", "germany", "greece", "hong kong", "hungary", "iceland", "india",
  "iran", "ireland", "israel", "italy", "japan", "kenya", "lebanon", "mexico",
  "netherlands", "new zealand", "norway", "panama", "peru", "poland", "portugal",
  "romania", "russia", "south africa", "south korea", "soviet union", "spain",
  "sweden", "switzerland", "taiwan", "tibet", "turkey", "uk", "united kingdom",
  "usa", "united states", "uruguay", "venezuela", "vietnam", "west germany",
  "yugoslavia",
]);

const TAG_LABELS: Record<string, string> = {
  intro: "Introduction",
  q_and_a: "Q&A",
  discussion: "Discussion",
  live_music: "Live Music",
  festival: "Festival",
  pay_what_you_can: "Pay What You Can",
  hoh: "Hard of Hearing",
  audio_description: "Audio Description",
  baby_screening: "Bring Your Baby",
  members: "Members Only",
  relaxed: "Relaxed",
  "35mm": "35mm",
  "70mm": "70mm",
  imax: "IMAX",
};

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

function safeGardenUrl(value: string, pathPrefix: string): string | null {
  try {
    const url = new URL(decodeEntities(value), BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "www.thegardencinema.co.uk") return null;
    if (!url.pathname.startsWith(pathPrefix)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeArtworkUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value));
    if (url.protocol !== "https:" || url.hostname !== "images.savoysystems.co.uk") return null;
    if (!url.pathname.startsWith("/GCL/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function londonOffsetMinutes(dateUtc: Date): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  }).formatToParts(dateUtc).find((item) => item.type === "timeZoneName")?.value;
  const match = part?.match(/GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/);
  if (!match || !match[1]) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function londonToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60_000);
}

function parseStats(statsText: string): {
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
  hasFilmEvidence: boolean;
} {
  const parts = statsText.replace(/[.\s]+$/, "").split(",").map((part) => part.trim()).filter(Boolean);
  const runtimePart = parts.at(-1) ?? "";
  const runtimeMatch = runtimePart.match(/^(\d{1,3})\s*m(?:in(?:ute)?s?)?$/i);
  const runtimeMinutes = runtimeMatch ? Number(runtimeMatch[1]) : null;
  const yearIndexes = parts
    .map((part, index) => (/^(?:18|19|20|21)\d{2}$/.test(part) ? index : -1))
    .filter((index) => index >= 0);
  const releaseYear = yearIndexes.length === 1 ? Number(parts[yearIndexes[0]]) : null;
  const yearIndex = yearIndexes.length === 1 ? yearIndexes[0] : -1;

  const beforeYear = yearIndex > 0 ? parts.slice(0, yearIndex) : [];
  const countryStart = beforeYear.findIndex((part) =>
    part.split("/").every((country) => COUNTRY_NAMES.has(country.trim().toLowerCase()))
  );
  const directors = countryStart > 0
    ? beforeYear.slice(0, countryStart).filter((value) => !/^various(?: directors?)?$/i.test(value))
    : [];
  const countries = countryStart > 0
    ? beforeYear.slice(countryStart).flatMap((value) => value.split("/").map((country) => country.trim()))
    : [];

  return {
    releaseYear,
    runtimeMinutes: runtimeMinutes && runtimeMinutes <= 600 ? runtimeMinutes : null,
    directors,
    countries,
    hasFilmEvidence: Boolean(runtimeMinutes && (releaseYear || countryStart > 0)),
  };
}

function cleanFilmTitleHint(title: string, hasFilmEvidence: boolean, releaseYear: number | null): string | null {
  if (!hasFilmEvidence) return null;
  let value = title.trim();
  value = value
    .replace(/\s*(?:\+|with)\s*Q(?:\s*(?:&|\+)\s*|\s+and\s+)A(?:\s+screening)?\s*$/i, "")
    .replace(/\s*\+\s*(?:an?\s+)?intro(?:duction)?(?:\s+by\b.*)?$/i, "")
    .replace(/\s*\+\s*discussion(?:\s+with\b.*)?$/i, "")
    .replace(/\s*[-–—]\s*\d{1,3}(?:st|nd|rd|th)\s+anniversary\s*$/i, "")
    .replace(/\s*\(\s*\d{1,3}(?:st|nd|rd|th)\s+anniversary\s*\)\s*$/i, "")
    .trim();
  const yearSuffix = value.match(/\s*\(((?:18|19|20|21)\d{2})\)\s*$/);
  if (yearSuffix && releaseYear === Number(yearSuffix[1])) {
    value = value.slice(0, yearSuffix.index).trim();
  }
  const explicitScreeningPrefix = value.match(/^(?:.+?\s+)?(?:preview\s+)?Q(?:\s*(?:&|\+)\s*)A\s+screening\s*:\s*(.+)$/i);
  if (explicitScreeningPrefix) value = explicitScreeningPrefix[1].trim();
  if (/\b(?:shorts?|short films|programme|selection|anthology|compilation)\b/i.test(value)) return null;
  if (/\s+\+\s+/.test(value)) return null;
  return value || null;
}

function filmWideScreeningTags(title: string, cardWideText: string): ScreeningTag[] {
  const tags: ScreeningTag[] = [];

  if (/\b\d{1,3}(?:st|nd|rd|th)\s+anniversary\b/i.test(title)) {
    tags.push("anniversary");
  }
  if (/\b(?:UK|World|European|London)\s+Premiere\b/i.test(cardWideText)) {
    tags.push("premiere");
  }
  if (
    /\b(?:UK|World|European|London)\s+Premiere\s+of\s+(?:the\s+)?(?:\d+k\s+|digital\s+)?restoration\b/i.test(cardWideText) ||
    /\bnew\s+(?:\d+k\s+|digital\s+)?restoration\b/i.test(cardWideText)
  ) {
    tags.push("restoration");
  }
  if (/\bin\s+[^.!?]{1,100}?\s+with\s+English(?:\s+and\s+[^.!?]{1,60}?)?\s+subtitles\b/i.test(cardWideText)) {
    tags.push("subtitled");
  }

  return unique(tags);
}

function isClearlyNonFilm(title: string, hasFilmEvidence: boolean): boolean {
  if (hasFilmEvidence) return false;
  return /\b(?:networking|mingle|writing session|industry session|workshop|karaoke|quiz|reading group)\b/i.test(title)
    || /^panel\s*:/i.test(title);
}

function sourceTags(panelClasses: string, panelHtml: string): string[] {
  const values = panelClasses.trim().split(/\s+/).filter(Boolean);
  for (const match of panelHtml.matchAll(/screening-tag\s+ext-([\w-]+)/gi)) values.push(match[1]);
  return unique(values.map((value) => value.toLowerCase()));
}

function screeningMetadata(
  tags: string[],
  strand: string | null,
  soldOut: boolean,
  filmWideTags: ScreeningTag[] = [],
) {
  const projectionFormats: ProjectionFormat[] = [];
  const accessibilityFeatures: AccessibilityFeature[] = [];
  const programmeTypes: ProgrammeType[] = [];
  const screeningTags: ScreeningTag[] = [...filmWideTags];

  if (tags.includes("35mm")) projectionFormats.push("35mm");
  if (tags.includes("70mm")) projectionFormats.push("70mm");
  if (tags.includes("imax")) projectionFormats.push("imax");
  if (tags.includes("hoh")) {
    accessibilityFeatures.push("captioned");
    screeningTags.push("subtitled");
  }
  if (tags.includes("audio_description")) accessibilityFeatures.push("audio_described");
  if (tags.includes("relaxed")) accessibilityFeatures.push("relaxed");
  if (tags.includes("baby_screening")) programmeTypes.push("parent_and_baby");
  if (tags.includes("members") || strand === "Members' Events") programmeTypes.push("members_only");
  if (tags.includes("q_and_a")) screeningTags.push("q_and_a");
  if (tags.includes("intro")) screeningTags.push("introduction");
  if (tags.includes("discussion")) screeningTags.push("discussion");
  if (tags.includes("live_music")) screeningTags.push("live_music");
  if (strand === "Films for the Family") screeningTags.push("family_friendly");

  const labels = unique(tags.map((tag) => TAG_LABELS[tag]).filter(Boolean));
  return {
    projectionFormats,
    accessibilityFeatures,
    programmeTypes,
    screeningTags: unique(screeningTags),
    screeningLabel: labels.length ? labels.join(", ") : null,
    availabilityStatus: (soldOut ? "sold_out" : "available") as AvailabilityStatus,
  };
}

export function parseGardenPage(html: string): ParseResult {
  const dates: Array<{ year: number; month: number; day: number; index: number }> = [];
  for (const match of html.matchAll(/<div\s+class="date-block"[^>]*data-date="(\d{4})-(\d{2})-(\d{2})"[^>]*>/gi)) {
    dates.push({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), index: match.index ?? 0 });
  }

  const records = new Map<string, ParsedScreening>();
  const excluded = new Set<string>();
  const errors: string[] = [];

  for (let dateIndex = 0; dateIndex < dates.length; dateIndex++) {
    const date = dates[dateIndex];
    const blankIndex = html.indexOf('<div class="films-list__by-date__blank"', date.index);
    const sectionEnd = html.indexOf("</section>", date.index);
    const lastDateEnd = [blankIndex, sectionEnd].filter((index) => index > date.index).sort((a, b) => a - b)[0] ?? html.length;
    const dateHtml = html.slice(date.index, dates[dateIndex + 1]?.index ?? lastDateEnd);
    const filmStarts = Array.from(dateHtml.matchAll(/<div\s+class="films-list__by-date__film"[^>]*>/gi), (match) => match.index ?? 0);

    for (let filmIndex = 0; filmIndex < filmStarts.length; filmIndex++) {
      const filmHtml = dateHtml.slice(filmStarts[filmIndex], filmStarts[filmIndex + 1] ?? dateHtml.length);
      const titleMatch = filmHtml.match(/<h1[^>]*class="films-list__by-date__film__title"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h1>/i);
      if (!titleMatch) continue;
      const title = textFromHtml(titleMatch[2].replace(/<span[^>]*films-list__by-date__film__rating[^>]*>[\s\S]*?<\/span>/gi, ""));
      const eventUrl = safeGardenUrl(titleMatch[1], "/film/");
      if (!title || !eventUrl) continue;

      const statsText = textFromHtml(filmHtml.match(/films-list__by-date__film__stats[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
      const stats = parseStats(statsText);
      if (isClearlyNonFilm(title, stats.hasFilmEvidence)) {
        excluded.add(title);
        continue;
      }
      const image = filmHtml.match(/films-list__by-date__film__thumb[^>]*\ssrc="([^"]+)"/i)?.[1];
      const artworkUrl = safeArtworkUrl(image);
      const strand = textFromHtml(filmHtml.match(/films-list__by-date__film__season__link[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "") || null;
      const filmTitleHint = cleanFilmTitleHint(title, stats.hasFilmEvidence, stats.releaseYear);

      const panels = Array.from(filmHtml.matchAll(/<div\s+class="screening-panel(?!__)([^"]*)"[^>]*>/gi), (match) => ({
        index: match.index ?? 0,
        classes: match[1] ?? "",
      }));
      const cardWideHtml = filmHtml.slice(0, panels[0]?.index ?? filmHtml.length);
      const filmWideTags = filmWideScreeningTags(title, textFromHtml(cardWideHtml));
      for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
        const panel = panels[panelIndex];
        const panelHtml = filmHtml.slice(panel.index, panels[panelIndex + 1]?.index ?? filmHtml.length);
        const booking = panelHtml.match(/<a[^>]*href="([^"]*TcsPerformance_(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!booking) continue;
        const time = textFromHtml(booking[3]).match(/^(\d{1,2}):(\d{2})$/);
        if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) {
          errors.push(`${title}: unparseable performance time`);
          continue;
        }
        let bookingUrl: string;
        try {
          const url = new URL(decodeEntities(booking[1]));
          if (url.protocol !== "https:" || url.hostname !== "bookings.thegardencinema.co.uk") throw new Error();
          bookingUrl = url.toString();
        } catch {
          errors.push(`${title}: invalid booking URL for ${booking[2]}`);
          continue;
        }

        const sourceReference = `${SOURCE_PREFIX}:${booking[2]}`;
        const soldOut = /\bsold-out\b/i.test(panel.classes) || /\bSOLD\s*OUT\b/i.test(panelHtml);
        const metadata = screeningMetadata(sourceTags(panel.classes, panelHtml), strand, soldOut, filmWideTags);
        const parsed: ParsedScreening = {
          movieTitle: title,
          filmTitleHint,
          startTimeIso: londonToUtc(date.year, date.month, date.day, Number(time[1]), Number(time[2])).toISOString(),
          bookingUrl,
          sourceReference,
          sourceReleaseYear: stats.releaseYear,
          sourceRuntimeMinutes: stats.runtimeMinutes,
          sourceDirectors: stats.directors,
          sourceCountries: stats.countries,
          sourceEventUrl: eventUrl,
          artworkUrl,
          soldOut,
          ...metadata,
        };
        const previous = records.get(sourceReference);
        if (!previous) records.set(sourceReference, parsed);
        else if (previous.movieTitle !== parsed.movieTitle || previous.startTimeIso !== parsed.startTimeIso) {
          errors.push(`${sourceReference}: conflicting duplicate performance`);
        }
      }
    }
  }

  if (!dates.length) errors.push("No dated programme blocks were found");
  return { screenings: Array.from(records.values()), excludedNonFilm: Array.from(excluded).sort(), errors };
}
