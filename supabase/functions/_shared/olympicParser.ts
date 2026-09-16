// Shared parser for Olympic/mycloudcinema whats-on pages.
// Used by import-olympic-cinemas edge function.

import {
  londonToUtc,
  inferYear,
  decodeEntities,
  stripTags,
} from "./importSafety.ts";
import {
  normaliseProjectionFormats,
  normaliseScreeningTags,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
  type ScreeningTag,
} from "./screeningMetadata.ts";

export interface ParsedOlympicScreening {
  movie_title: string;
  start_time_iso: string | null;
  venue_label: string;
  booking_url: string | null;
  booking_id: string | null;
  film_slug: string;
  film_url: string;
  format: string | null;
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: AvailabilityStatus;
  screening_label: string | null;
  screening_tags: ScreeningTag[];
  sold_out: boolean;
  parse_error?: string;
}

export interface OlympicDiagnostics {
  venueHeadingsArches: number;
  venueHeadingsPowerstation: number;
  archesBookingButtons: number;
  powerStationBookingButtons: number;
}

export interface OlympicParseResult {
  screenings: ParsedOlympicScreening[];
  diagnostics: OlympicDiagnostics;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.replace(/\s+/g, " ").trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

// Parse a date heading. Supports both orderings, with optional year and commas:
//   "Sunday July 19"  /  "Sunday July 19 2026"
//   "Sunday 19 July"  /  "Sunday 19 July 2026"
//   "Sunday, July 19" /  "Sunday, 19 July 2026"
function parseDateHeading(
  text: string,
): { day: number; month: number; year: number | null } | null {
  const trimmed = text.trim().replace(/,/g, "").replace(/\s+/g, " ").trim();

  let m = trimmed.match(
    /^[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/,
  );
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    return {
      day: parseInt(m[2], 10),
      month,
      year: m[3] ? parseInt(m[3], 10) : null,
    };
  }

  m = trimmed.match(
    /^[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/,
  );
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    return {
      day: parseInt(m[1], 10),
      month,
      year: m[3] ? parseInt(m[3], 10) : null,
    };
  }

  return null;
}

function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function extractBookingId(url: string): string | null {
  const m = decodeEntities(url).match(/mycloudcinema\.com\/#\/book\/(\d+)/i);
  return m ? m[1] : null;
}

function extractBookingSuffix(url: string): string | null {
  const m = decodeEntities(url).match(
    /mycloudcinema\.com\/#\/book\/\d+\/([^/?#"'<>]+)/i,
  );
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

function humaniseSuffix(suffix: string): string {
  return suffix
    .replace(/-amp-/g, "-and-")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bQ And A\b/i, "Q&A");
}

function labelFromSuffix(suffix: string | null): string | null {
  if (!suffix) return null;
  if (/^sold[-_]?out$/i.test(suffix)) return "Sold Out";
  if (/^preview[-_]?screening$/i.test(suffix)) return "Preview Screening";
  if (/^(?:q[-_]?a|q[-_]?amp[-_]?a|q[-_]?and[-_]?a)$/i.test(suffix)) return "Q&A";
  if (/^relaxed[-_]?screening$/i.test(suffix)) return "Relaxed Screening";
  if (/^kids?[-_]?club$/i.test(suffix)) return "Kids Club";
  if (/^babes?[-_]?in[-_]?arms$/i.test(suffix)) return "Babes In Arms";
  if (/^captioned$/i.test(suffix)) return "Captioned";
  if (/^audio[-_]?described$/i.test(suffix)) return "Audio Described";
  if (/^members?[-_]?(?:only|screenings?)$/i.test(suffix)) return "Members Screening";
  if (/^35[-_]?mm$/i.test(suffix)) return "35mm";
  if (/^70[-_]?mm$/i.test(suffix)) return "70mm";
  if (/^imax$/i.test(suffix)) return "IMAX";
  if (/^4k$/i.test(suffix)) return "4K";
  if (/^2k$/i.test(suffix)) return "2K";
  if (/^digital$/i.test(suffix)) return "Digital";
  if (/^laser$/i.test(suffix)) return "Laser";
  if (/^3d$/i.test(suffix)) return "3D";
  if (/^dolby[-_]?cinema$/i.test(suffix)) return "Dolby Cinema";
  return humaniseSuffix(suffix);
}

function venueFromClass(classAttr: string): string | null {
  if (/arches/i.test(classAttr)) return "arches";
  if (/power(?:station)?/i.test(classAttr)) return "power-station";
  return null;
}

function venueFromHeading(text: string): string | null {
  if (/arches/i.test(text)) return "arches";
  if (/power\s*station/i.test(text)) return "power-station";
  return null;
}

function isPresentationFormat(label: string): boolean {
  return /^(?:35\s*mm|70\s*mm|IMAX|4K|2K|Digital|Laser|3D|Dolby Cinema)$/i.test(
    label.trim(),
  );
}

function canonicalPresentationFormat(label: string): string {
  const value = label.trim();
  if (/^35\s*mm$/i.test(value)) return "35mm";
  if (/^70\s*mm$/i.test(value)) return "70mm";
  if (/^imax$/i.test(value)) return "IMAX";
  if (/^4k$/i.test(value)) return "4K";
  if (/^2k$/i.test(value)) return "2K";
  if (/^digital$/i.test(value)) return "Digital";
  if (/^laser$/i.test(value)) return "Laser";
  if (/^3d$/i.test(value)) return "3D";
  if (/^dolby cinema$/i.test(value)) return "Dolby Cinema";
  return value;
}

function accessibilityFromLabels(labels: string[]): AccessibilityFeature[] {
  const text = labels.join(" ");
  const result: AccessibilityFeature[] = [];
  if (/\bCaptioned\b|\bClosed Captions?\b|\bHard of Hearing\b/i.test(text)) {
    result.push("captioned");
  }
  if (/\bAudio Described\b|\bAudio Description\b/i.test(text)) {
    result.push("audio_described");
  }
  if (/\bRelaxed(?: Screening)?\b/i.test(text)) {
    result.push("relaxed");
  }
  return Array.from(new Set(result));
}

function programmeTypesFromLabels(labels: string[]): ProgrammeType[] {
  const text = labels.join(" ");
  const result: ProgrammeType[] = [];
  if (/\bMembers?\b.*\b(?:Only|Screenings?)\b|\bMembers? Screening\b/i.test(text)) {
    result.push("members_only");
  }
  if (/\bBabes? In Arms\b|\bParent(?:s)?\s*(?:&|and)\s*Bab(?:y|ies)\b/i.test(text)) {
    result.push("parent_and_baby");
  }
  if (/\bSenior(?:s| Citizen)?(?: Screening)?\b|\bSilver Screen\b/i.test(text)) {
    result.push("seniors");
  }
  return Array.from(new Set(result));
}

function screeningTagsFromLabels(labels: string[]): ScreeningTag[] {
  const tags = new Set<ScreeningTag>(normaliseScreeningTags(labels));
  if (labels.some((label) => /\bKids? Club\b/i.test(label))) {
    tags.add("family_friendly");
  }
  return Array.from(tags);
}

function explicitImageLabels(innerContent: string): string[] {
  return Array.from(
    innerContent.matchAll(/<img\b[^>]*\balt="([^"]+)"[^>]*>/gi),
    (match) => decodeEntities(match[1]).trim(),
  ).filter((label) => isPresentationFormat(label));
}

export function parseOlympicPage(
  html: string,
  baseUrl: string,
  nowLondon: Date,
): OlympicParseResult {
  const results: ParsedOlympicScreening[] = [];
  const diagnostics: OlympicDiagnostics = {
    venueHeadingsArches: 0,
    venueHeadingsPowerstation: 0,
    archesBookingButtons: 0,
    powerStationBookingButtons: 0,
  };

  const sectionRegex = /<section class="date-section">/g;
  const sectionStarts: number[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRegex.exec(html)) !== null) {
    sectionStarts.push(sm.index);
  }

  for (let si = 0; si < sectionStarts.length; si++) {
    const start = sectionStarts[si];
    const end = si + 1 < sectionStarts.length ? sectionStarts[si + 1] : html.length;
    const sectionBody = html.slice(start, end);

    const dateMatch = sectionBody.match(
      /<h3[^>]*class="date-day[^"]*"[^>]*>([^<]+)<\/h3>/,
    );
    if (!dateMatch) continue;

    const dateText = stripTags(dateMatch[1]).trim();
    const dateParts = parseDateHeading(dateText);
    if (!dateParts) continue;

    const year =
      dateParts.year ?? inferYear(dateParts.day, dateParts.month, nowLondon);

    const filmLinkRegex =
      /<a\s+[^>]*href="\/film\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const filmLinks: { slug: string; index: number; title: string }[] = [];
    let flMatch: RegExpExecArray | null;
    while ((flMatch = filmLinkRegex.exec(sectionBody)) !== null) {
      const anchorTitle = decodeEntities(stripTags(flMatch[2])).trim();
      filmLinks.push({
        slug: flMatch[1],
        index: flMatch.index,
        title: anchorTitle,
      });
    }

    for (let i = 0; i < filmLinks.length; i++) {
      const { slug, title: anchorTitle } = filmLinks[i];
      const blockStart = filmLinks[i].index;
      const blockEnd =
        i + 1 < filmLinks.length ? filmLinks[i + 1].index : sectionBody.length;
      const block = sectionBody.slice(blockStart, blockEnd);

      let movieTitle: string | null = anchorTitle || null;
      if (!movieTitle) {
        const altMatch = block.match(/<img[^>]*alt="([^"]+)"/);
        if (
          altMatch &&
          altMatch[1].trim() &&
          !altMatch[1].startsWith("BBFC")
        ) {
          movieTitle = decodeEntities(altMatch[1]).trim();
        }
      }
      if (!movieTitle) {
        movieTitle = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase());
      }
      if (!movieTitle) continue;

      const filmUrl = `${baseUrl}/film/${slug}`;

      const h6Regex = /<h6[^>]*>([^<]+)<\/h6>/g;
      const btnAnchorRegex =
        /<a\s+[^>]*class="[^"]*btn\s+btn-[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

      const events: {
        type: "heading" | "button";
        index: number;
        text?: string;
        fullAnchor?: string;
        innerContent?: string;
      }[] = [];

      let h6m: RegExpExecArray | null;
      while ((h6m = h6Regex.exec(block)) !== null) {
        events.push({
          type: "heading",
          index: h6m.index,
          text: h6m[1].trim(),
        });
      }

      let btnm: RegExpExecArray | null;
      while ((btnm = btnAnchorRegex.exec(block)) !== null) {
        events.push({
          type: "button",
          index: btnm.index,
          fullAnchor: btnm[0],
          innerContent: btnm[1],
        });
      }

      events.sort((a, b) => a.index - b.index);

      let currentVenueLabel = "";
      let currentVenueKey: string | null = null;

      for (const event of events) {
        if (event.type === "heading") {
          currentVenueLabel = event.text || "";
          const key = event.text ? venueFromHeading(event.text) : null;
          if (key === "arches") diagnostics.venueHeadingsArches++;
          else if (key === "power-station") {
            diagnostics.venueHeadingsPowerstation++;
          }
          currentVenueKey = key;
          continue;
        }

        const fullAnchor = event.fullAnchor!;
        const innerContent = event.innerContent!;

        let venueLabel = currentVenueLabel;
        let venueKey = currentVenueKey;
        const classMatch = fullAnchor.match(/class="([^"]*)"/);
        const classAttr = classMatch ? classMatch[1] : "";
        const classKey = venueFromClass(classAttr);

        if (classKey === "arches") diagnostics.archesBookingButtons++;
        else if (classKey === "power-station") {
          diagnostics.powerStationBookingButtons++;
        }

        if (!venueKey && classKey) {
          venueKey = classKey;
          venueLabel =
            classKey === "arches"
              ? "The Cinema in the Arches"
              : "The Cinema in the Power Station";
        }

        const hrefMatch = fullAnchor.match(/href="([^"]*)"/);
        let rawHref = hrefMatch ? hrefMatch[1] : null;
        if (!rawHref || rawHref === "#") {
          const dataMatch = fullAnchor.match(/data-booking-url="([^"]*)"/);
          if (dataMatch) rawHref = dataMatch[1];
        }

        const timeMatch = innerContent.match(
          /<span class="btn-times-fs"[^>]*>([^<]+)<\/span>/,
        );
        if (!timeMatch) continue;

        const timeText = timeMatch[1].trim();
        const timeParts = parse24hTime(timeText);
        if (!timeParts) {
          results.push({
            movie_title: movieTitle,
            start_time_iso: null,
            venue_label: venueLabel,
            booking_url: null,
            booking_id: null,
            film_slug: slug,
            film_url: filmUrl,
            format: null,
            projection_formats: [],
            accessibility_features: [],
            programme_types: [],
            availability_status: "unknown",
            screening_label: null,
            screening_tags: [],
            sold_out: false,
            parse_error: `Unparseable time: "${timeText}"`,
          });
          continue;
        }

        const bookingId = rawHref ? extractBookingId(rawHref) : null;
        const bookingUrl =
          rawHref && bookingId ? decodeEntities(rawHref) : null;
        const suffix = bookingUrl ? extractBookingSuffix(bookingUrl) : null;

        const visibleLabels = Array.from(
          innerContent.matchAll(
            /<span class="ms-2[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
          ),
          (match) => decodeEntities(stripTags(match[1])).trim(),
        ).filter(Boolean);

        const suffixLabel = labelFromSuffix(suffix);
        const imageLabels = explicitImageLabels(innerContent);
        const labels = uniqueStrings([
          ...visibleLabels,
          suffixLabel,
          ...imageLabels,
        ]);

        const soldOut =
          labels.some((label) => /\bSold[- ]?Out\b/i.test(label)) ||
          /\bsold[- ]?out\b/i.test(fullAnchor);

        const disabled =
          /\bdisabled\b/i.test(classAttr) ||
          /\binactive\b/i.test(classAttr) ||
          /aria-disabled\s*=\s*"true"/i.test(fullAnchor);

        const presentationLabels = uniqueStrings(
          labels
            .filter((label) => isPresentationFormat(label))
            .map(canonicalPresentationFormat),
        );

        const projectionFormats =
          normaliseProjectionFormats(presentationLabels);
        const accessibilityFeatures = accessibilityFromLabels(labels);
        const programmeTypes = programmeTypesFromLabels(labels);
        const screeningTags = screeningTagsFromLabels(labels);
        const availabilityStatus: AvailabilityStatus = soldOut
          ? "sold_out"
          : bookingUrl && !disabled
          ? "available"
          : "unknown";

        const utc = londonToUtc(
          year,
          dateParts.month,
          dateParts.day,
          timeParts.hour,
          timeParts.minute,
        );

        results.push({
          movie_title: movieTitle,
          start_time_iso: utc.toISOString(),
          venue_label: venueLabel,
          booking_url: bookingUrl,
          booking_id: bookingId,
          film_slug: slug,
          film_url: filmUrl,
          format: presentationLabels.join(", ") || null,
          projection_formats: projectionFormats,
          accessibility_features: accessibilityFeatures,
          programme_types: programmeTypes,
          availability_status: availabilityStatus,
          screening_label: labels.join("; ") || null,
          screening_tags: screeningTags,
          sold_out: soldOut,
        });
      }
    }
  }

  return { screenings: results, diagnostics };
}

export function fallbackSourceRef(
  prefix: string,
  title: string,
  startIso: string,
): string {
  const date = new Date(startIso);
  const dateStr =
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const timeStr =
    `${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `olympic:${prefix}:${normaliseTitle(title)}:${dateStr}:${timeStr}`;
}
