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
  screenName: string | null;
  screeningLabel: string | null;
  screeningTags: ScreeningTag[];
  soldOut: boolean;
}

export interface ProgrammeCard {
  title: string;
  eventUrl: string;
  body: string;
  sourceType: string;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  artworkUrl: string | null;
}

export interface ParseResult {
  screenings: ParsedScreening[];
  sourceCount: number;
  candidateCards: number;
  errors: string[];
}

interface CalendarPerformance {
  title?: unknown;
  datetime?: unknown;
  venue?: unknown;
  screen?: unknown;
  onSale?: unknown;
  available?: unknown;
  soldOut?: unknown;
  bookingUrl?: unknown;
  accessibility?: unknown;
  format?: unknown;
  formats?: unknown;
  specialFeatures?: unknown;
}

interface DetailData {
  directors: string[];
  countries: string[];
  calendar: CalendarPerformance[];
  isCompilation: boolean;
}

interface ListingPerformance {
  card: ProgrammeCard;
  startTimeIso: string;
  rawBookingUrl: string | null;
  soldOut: boolean;
  screenName: string | null;
  label: string;
}

const ORIGIN = "https://cinemas.bfi.org.uk";
const TICKET_ORIGIN = "https://whatson.bfi.org.uk";
const NON_FILM_TYPES = /(?:^|\s|•)(?:talk|tour|exhibition|adult course|course|workshop|member salon|library lates)(?:$|\s|•)/i;
const EXACT_NON_FILM_SLUGS = new Set([
  "/whats-on/mark-kermode-live-in-3d-at-the-bfi",
  "/whats-on/z-test-show-please-ignore",
]);
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function unique<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#(?:39|039);|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–").replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
    : "";
}

function safeUrl(value: string, expectedOrigin: string): string | null {
  try {
    const url = new URL(decodeEntities(value), expectedOrigin);
    if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function londonOffsetMinutes(dateUtc: Date): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London", timeZoneName: "shortOffset",
  }).formatToParts(dateUtc).find((part) => part.type === "timeZoneName")?.value;
  const match = value?.match(/GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/);
  if (!match || !match[1]) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function londonToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60_000);
}

function inferYear(month: number, now: Date): number {
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  let year = local.getFullYear();
  const currentMonth = local.getMonth() + 1;
  if (month <= 3 && currentMonth >= 10) year++;
  if (month >= 10 && currentMonth <= 3) year--;
  return year;
}

function parseListingDateTime(label: string, now: Date): string | null {
  const match = label.match(/^(\d{1,2}):(\d{2})\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\s+([A-Za-z]+)/i);
  if (!match) return null;
  const month = MONTHS[match[4].toLowerCase()];
  if (!month) return null;
  const date = londonToUtc(inferYear(month, now), month, Number(match[3]), Number(match[1]), Number(match[2]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseCardMetadata(body: string): Omit<ProgrammeCard, "title" | "body" | "sourceType"> | null {
  const href = body.match(/<a\b[^>]*class="card-link"[^>]*href="([^"]+)"/i)?.[1];
  const eventUrl = href ? safeUrl(href, ORIGIN) : null;
  if (!eventUrl) return null;
  const image = body.match(/class="showImage"[^>]*>[\s\S]*?<img\b[^>]*src="([^"]+)"/i)?.[1];
  const artworkUrl = image ? safeUrl(image, ORIGIN) : null;
  const work = body.match(/class="workData"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
  const duration = work.match(/datetime="PT(?:(\d+)H)?(?:(\d+)M)?"/i);
  const years = unique([...work.matchAll(/<span\b[^>]*>\s*((?:18|19|20|21)\d{2})\s*<\/span>/g)].map((item) => item[1]));
  return {
    eventUrl,
    artworkUrl,
    releaseYear: years.length === 1 ? Number(years[0]) : null,
    runtimeMinutes: duration ? (Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0) || null) : null,
  };
}

export function discoverProgrammeCards(html: string): { cards: ProgrammeCard[]; errors: string[] } {
  const cards: ProgrammeCard[] = [];
  const errors: string[] = [];
  const chunks = html.split(/<article\b[^>]*class="[^"]*showCard[^"]*"[^>]*>/i).slice(1);
  for (const [index, chunk] of chunks.entries()) {
    const end = chunk.indexOf("</article>");
    if (end < 0) { errors.push(`Card ${index + 1} was truncated.`); continue; }
    const body = chunk.slice(0, end);
    const title = cleanText(body.match(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*class="card-link"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
    const sourceType = cleanText(body.slice(0, Math.max(0, body.indexOf("<h3"))));
    const metadata = parseCardMetadata(body);
    if (!title || !metadata) { errors.push(`Card ${index + 1} was missing its title or official event URL.`); continue; }
    const path = new URL(metadata.eventUrl).pathname.replace(/\/$/, "");
    if (NON_FILM_TYPES.test(sourceType) || EXACT_NON_FILM_SLUGS.has(path)) continue;
    cards.push({ title, body, sourceType, ...metadata });
  }
  return { cards, errors };
}

function splitValues(value: string): string[] {
  if (!value || /^(?:unknown|various|n\/?a)$/i.test(value)) return [];
  return unique(value.split(/\s*(?:,|;|\/|\band\b|&)\s*/i).map((part) => part.trim()).filter(Boolean));
}

function detailField(html: string, name: string): string {
  return cleanText(html.match(new RegExp(`<h2\\b[^>]*>\\s*${name}\\s*<\\/h2>\\s*<span\\b[^>]*>([\\s\\S]*?)<\\/span>`, "i"))?.[1] ?? "");
}

export function parseDetailPage(html: string): DetailData {
  let calendar: CalendarPerformance[] = [];
  const encoded = html.match(/\bcalendar-dates="([\s\S]*?)"/i)?.[1];
  if (encoded) {
    try {
      const parsed = JSON.parse(decodeEntities(encoded));
      if (Array.isArray(parsed)) calendar = parsed as CalendarPerformance[];
    } catch {
      // The listing remains authoritative if a page does not contain valid calendar JSON.
    }
  }
  const workBlocks = (html.match(/\bwork-block(?:__|\s|"|')/gi) ?? []).length;
  return {
    directors: splitValues(detailField(html, "Director")),
    countries: splitValues(detailField(html, "Country")),
    calendar,
    isCompilation: workBlocks > 2 || /\b(?:short film programme|programme of shorts|compilation|double bill|triple bill)\b/i.test(cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "")),
  };
}

function parseListingPerformances(card: ProgrammeCard, now: Date): { rows: ListingPerformance[]; errors: string[]; sourceCount: number } {
  const rows: ListingPerformance[] = [];
  const errors: string[] = [];
  let sourceCount = 0;
  const sectionRe = /<h4\b[^>]*aria-label="((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\s+[A-Za-z]+)"[^>]*>[\s\S]*?<ul\b[^>]*>([\s\S]*?)<\/ul>/gi;
  let section: RegExpExecArray | null;
  while ((section = sectionRe.exec(card.body))) {
    for (const rawLi of section[2].split(/<li\b[^>]*>/i).slice(1)) {
      const li = rawLi.split("</li>")[0];
      const link = li.match(/<a\b[^>]*href="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*data-ga-event="booking_click"[^>]*>/i);
      const disabled = li.match(/<button\b[^>]*aria-disabled="true"[^>]*>(\d{1,2}:\d{2})<\/button>/i);
      if (!link && !disabled) continue;
      const label = decodeEntities(link?.[2] ?? `${disabled![1]} ${section[1]}`);
      const isSouthbank = /\bNFT[1-4]\b|General Admission|Studio/i.test(label);
      const tagText = cleanText([...li.matchAll(/<div\b[^>]*class="tagsWrapper"[^>]*>([\s\S]*?)<\/div>/gi)].map((item) => item[1]).join(" "));
      const explicitImax = /BFI IMAX|IMAX, Waterloo/i.test(label) || /\bIMAX\b/i.test(tagText);
      if (link && !isSouthbank) continue;
      if (!link && explicitImax) continue;
      sourceCount++;
      const startTimeIso = parseListingDateTime(label, now);
      if (!startTimeIso) { errors.push(`${card.title}: unparseable performance date '${label}'.`); continue; }
      if (new Date(startTimeIso) <= now) continue;
      const screenMatch = label.match(/(?:Screen\s+(.+)|((?:BFI )?IMAX, Waterloo))$/i);
      rows.push({
        card,
        startTimeIso,
        rawBookingUrl: link ? safeUrl(link[1], TICKET_ORIGIN) : null,
        soldOut: /\bSold out\b/i.test(li),
        screenName: cleanText(screenMatch?.[1] ?? screenMatch?.[2] ?? "") || null,
        label: tagText,
      });
    }
  }
  const bookingClickCount = [...card.body.matchAll(/<a\b[^>]*aria-label="([^"]+)"[^>]*data-ga-event="booking_click"[^>]*>/gi)]
    .filter((match) => /\bNFT[1-4]\b|General Admission|Studio/i.test(decodeEntities(match[1])))
    .length;
  const parsedBookingCount = rows.filter((row) => row.rawBookingUrl).length;
  if (parsedBookingCount !== bookingClickCount) {
    errors.push(`${card.title}: parsed ${parsedBookingCount} of ${bookingClickCount} booking links.`);
  }
  return { rows, errors, sourceCount };
}

function calendarRowsAt(detail: DetailData, startTimeIso: string): CalendarPerformance[] {
  const target = new Date(startTimeIso).getTime();
  return detail.calendar.filter((row) => {
    const time = typeof row.datetime === "string" ? new Date(row.datetime).getTime() : NaN;
    return Number.isFinite(time) && time === target;
  });
}

function calendarAt(detail: DetailData, startTimeIso: string): CalendarPerformance | null {
  return calendarRowsAt(detail, startTimeIso)
    .find((row) => cleanText(row.venue) === "BFI Southbank") ?? null;
}

function disabledSouthbankCalendarAt(detail: DetailData, startTimeIso: string): CalendarPerformance | null {
  const matches = calendarRowsAt(detail, startTimeIso);
  if (!matches.length || matches.some((row) => cleanText(row.venue) !== "BFI Southbank")) return null;
  return matches[0];
}

function objectLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item === "string") labels.push(cleanText(item));
    else if (item && typeof item === "object") {
      const object = item as Record<string, unknown>;
      labels.push(cleanText(object.name) || cleanText(object.value));
    }
  }
  return labels.filter(Boolean);
}

function explicitLabels(listingLabel: string, calendar: CalendarPerformance | null): string[] {
  const labels = [listingLabel];
  if (calendar) {
    labels.push(cleanText(calendar.format));
    if (Array.isArray(calendar.formats)) labels.push(...calendar.formats.map(cleanText));
    labels.push(...objectLabels(calendar.accessibility), ...objectLabels(calendar.specialFeatures));
  }
  return unique(labels.filter(Boolean));
}

function projectionFormats(labels: string[]): ProjectionFormat[] {
  const text = labels.join(" ");
  const result: ProjectionFormat[] = [];
  if (/\b35\s*mm\b/i.test(text)) result.push("35mm");
  if (/\b70\s*mm\b/i.test(text)) result.push("70mm");
  if (/\bIMAX\b/i.test(text)) result.push("imax");
  return result;
}

function displayFormat(labels: string[]): string | null {
  const text = labels.join(" ");
  const values: string[] = [];
  const add = (value: string) => { if (!values.includes(value)) values.push(value); };
  for (const [pattern, value] of [
    [/\b16\s*mm\b/i, "16mm"], [/\b35\s*mm\b/i, "35mm"], [/\b70\s*mm\b/i, "70mm"],
    [/\b4K\b/i, "4K"], [/\b3D\b/i, "3D"], [/\bDCP\b/i, "DCP"], [/Dolby Atmos/i, "Dolby Atmos"],
  ] as const) if (pattern.test(text)) add(value);
  return values.join(", ") || null;
}

function accessibilityFeatures(labels: string[]): AccessibilityFeature[] {
  const text = labels.join(" ");
  const result: AccessibilityFeature[] = [];
  if (/descriptive subtitles|open captions|closed captions|captioned/i.test(text)) result.push("captioned");
  if (/audio description|audio described/i.test(text)) result.push("audio_described");
  if (/relaxed screening|relaxed performance/i.test(text)) result.push("relaxed");
  return result;
}

function programmeTypes(labels: string[]): ProgrammeType[] {
  const text = labels.join(" ");
  const result: ProgrammeType[] = [];
  if (/members[’']? only/i.test(text)) result.push("members_only");
  if (/parent\s*(?:&|and)\s*baby|baby\s*(?:&|and)\s*carer/i.test(text)) result.push("parent_and_baby");
  if (/child required|children must be accompanied/i.test(text)) result.push("child_required");
  if (/seniors[’']? (?:free )?matinee/i.test(text)) result.push("seniors");
  return result;
}

function screeningTags(labels: string[]): ScreeningTag[] {
  const text = labels.join(" ");
  const result: ScreeningTag[] = [];
  const add = (value: ScreeningTag) => { if (!result.includes(value)) result.push(value); };
  if (/\bQ\s*(?:&|\+)\s*A\b|\bqa\b/i.test(text)) add("q_and_a");
  if (/\bintro(?:duction)?\b/i.test(text)) add("introduction");
  if (/\bdiscussion\b/i.test(text)) add("discussion");
  if (/\bpremiere\b/i.test(text)) add("premiere");
  if (/\bpreview\b/i.test(text)) add("preview");
  if (/\banniversary\b/i.test(text)) add("anniversary");
  if (/\bdouble[ -]bill\b/i.test(text)) add("double_bill");
  if (/\blive music\b|\blive score\b|\blive accompaniment\b/i.test(text)) add("live_music");
  if (/\bsing[ -]?along\b/i.test(text)) add("singalong");
  if (/\bno (?:ads|adverts|trailers)\b/i.test(text)) add("no_adverts");
  if (/\bfamily friendly\b/i.test(text)) add("family_friendly");
  if (/\bSEND friendly\b/i.test(text)) add("send_friendly");
  if (/\bsubtit(?:led|les)\b/i.test(text)) add("subtitled");
  if (/\bdubbed\b/i.test(text)) add("dubbed");
  if (/\brerelease\b|\bre-release\b/i.test(text)) add("rerelease");
  if (/\brestoration\b|\brestored\b/i.test(text)) add("restoration");
  return result;
}

function performanceUuid(rawBookingUrl: string | null): string | null {
  if (!rawBookingUrl) return null;
  const decoded = decodeURIComponent(rawBookingUrl);
  return decoded.match(/performance_ids=([0-9a-f-]{36})/i)?.[1]?.toUpperCase() ?? null;
}

export function publicBookingUrl(rawBookingUrl: string | null): string | null {
  if (!rawBookingUrl) return null;
  try {
    const source = new URL(rawBookingUrl);
    if (source.origin !== TICKET_ORIGIN) return null;
    if (/^\/Online\/(?:mapSelect|seatSelect)\.asp$/i.test(source.pathname)) {
      return performanceUuid(source.href) ? source.href : null;
    }
    if (!/^\/Online\/login\.asp$/i.test(source.pathname)) return null;
    const target = source.searchParams.get("targetPage");
    if (!target) return null;
    const decodedTarget = decodeURIComponent(target);
    if (!/^(?:mapSelect|seatSelect)\.asp\?/i.test(decodedTarget)) return null;
    const destination = new URL(`/Online/${decodedTarget}`, TICKET_ORIGIN);
    if (!performanceUuid(destination.href)) return null;
    return destination.href;
  } catch {
    return null;
  }
}

function safeFilmTitleHint(card: ProgrammeCard, detail: DetailData): string | null {
  if (!card.releaseYear || !card.runtimeMinutes || detail.directors.length === 0 || detail.isCompilation) return null;
  if (/\b(?:programme|compilation|double bill|triple bill|mystery film|member poll|TV preview|series\s+\d+|episode\s+\d+)\b/i.test(card.title)) return null;
  const stripped = card.title
    .replace(/^(?:Member Picks|Relaxed Screening|Seniors['’] Free Matinee|Parent (?:&|and) Baby|Preview)\s*:\s*/i, "")
    .replace(/\s+-\s+(?:\d+(?:st|nd|rd|th) anniversary(?: screening)?|restoration (?:world |UK )?premiere|(?:world|UK) premiere|preview)\s*$/i, "")
    .trim();
  return stripped || null;
}

function fallbackReference(row: ListingPerformance, screenName: string | null): string {
  return `${row.card.title}|${row.startTimeIso}|${screenName ?? "southbank"}`
    .toLowerCase().replace(/[^a-z0-9|:-]+/g, "-");
}

export function parseBfiSouthbank(
  programmeHtml: string,
  detailPages: ReadonlyMap<string, string>,
  now: Date,
): ParseResult {
  const discovered = discoverProgrammeCards(programmeHtml);
  const errors = [...discovered.errors];
  const screenings: ParsedScreening[] = [];
  let sourceCount = 0;
  for (const card of discovered.cards) {
    const html = detailPages.get(card.eventUrl);
    if (!html) { errors.push(`${card.title}: official detail page was not supplied.`); continue; }
    const detail = parseDetailPage(html);
    const listed = parseListingPerformances(card, now);
    errors.push(...listed.errors);
    sourceCount += listed.sourceCount;
    for (const row of listed.rows) {
      const calendar = row.rawBookingUrl
        ? calendarAt(detail, row.startTimeIso)
        : disabledSouthbankCalendarAt(detail, row.startTimeIso);
      if (!row.rawBookingUrl && !calendar) continue;
      const structuredBooking = typeof calendar?.bookingUrl === "string" ? safeUrl(calendar.bookingUrl, TICKET_ORIGIN) : null;
      const rawBooking = structuredBooking ?? row.rawBookingUrl;
      const uuid = performanceUuid(rawBooking);
      const soldOut = calendar?.soldOut === true || row.soldOut;
      const screenName = cleanText(calendar?.screen).replace(/^Screen\s+/i, "") || row.screenName;
      const labels = explicitLabels(row.label, calendar);
      const bookingUrl = soldOut ? null : publicBookingUrl(rawBooking);
      const openForSale = calendar ? calendar.onSale === true && calendar.available === true : Boolean(row.rawBookingUrl);
      const label = labels.map((value) => value.replace(/\bSold out\b/gi, "").replace(/\s+/g, " ").trim())
        .filter(Boolean).join(" · ") || null;
      screenings.push({
        movieTitle: card.title,
        filmTitleHint: safeFilmTitleHint(card, detail),
        startTimeIso: row.startTimeIso,
        bookingUrl,
        sourceReference: `bfi-southbank:${uuid ?? fallbackReference(row, screenName)}`,
        sourceReleaseYear: card.releaseYear,
        sourceRuntimeMinutes: card.runtimeMinutes,
        sourceDirectors: detail.directors,
        sourceCountries: detail.countries,
        sourceEventUrl: card.eventUrl,
        artworkUrl: card.artworkUrl,
        displayFormat: displayFormat(labels),
        projectionFormats: projectionFormats(labels),
        accessibilityFeatures: accessibilityFeatures(labels),
        programmeTypes: programmeTypes(labels),
        availabilityStatus: soldOut ? "sold_out" : openForSale && Boolean(bookingUrl) ? "available" : "unknown",
        screenName,
        screeningLabel: label,
        screeningTags: screeningTags(labels),
        soldOut,
      });
    }
  }
  const byReference = new Map<string, ParsedScreening>();
  for (const row of screenings) {
    const prior = byReference.get(row.sourceReference);
    if (prior && (prior.movieTitle !== row.movieTitle || prior.startTimeIso !== row.startTimeIso)) {
      errors.push(`Conflicting source reference ${row.sourceReference}.`);
    } else if (!prior || (!prior.bookingUrl && row.bookingUrl)) {
      byReference.set(row.sourceReference, row);
    }
  }
  const result = [...byReference.values()].sort((a, b) => a.startTimeIso.localeCompare(b.startTimeIso));
  const titleTimes = new Set<string>();
  for (const row of result) {
    const key = `${row.movieTitle.toLowerCase()}|${row.startTimeIso}`;
    if (titleTimes.has(key)) errors.push(`Duplicate title/time ${row.movieTitle} at ${row.startTimeIso}.`);
    titleTimes.add(key);
    if (!row.soldOut && row.availabilityStatus === "available" && !row.bookingUrl) {
      errors.push(`${row.movieTitle} at ${row.startTimeIso}: available performance lacked a safe public booking URL.`);
    }
  }
  return { screenings: result, sourceCount, candidateCards: discovered.cards.length, errors };
}
