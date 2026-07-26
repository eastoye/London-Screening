// Shared parser for Olympic/mycloudcinema whats-on pages.
// Used by import-olympic-cinemas edge function.

import {
  londonToUtc,
  inferYear,
  decodeEntities,
  stripTags,
} from "./importSafety.ts";

export interface ParsedOlympicScreening {
  movie_title: string;
  start_time_iso: string | null;
  venue_label: string;
  booking_url: string | null;
  booking_id: string | null;
  film_slug: string;
  film_url: string;
  status_label: string | null;
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

// Parse a date heading. Supports both orderings, with optional year and commas:
//   "Sunday July 19"  /  "Sunday July 19 2026"
//   "Sunday 19 July"  /  "Sunday 19 July 2026"
//   "Sunday, July 19" /  "Sunday, 19 July 2026"
function parseDateHeading(
  text: string
): { day: number; month: number; year: number | null } | null {
  // Normalise: collapse whitespace, remove commas.
  const trimmed = text.trim().replace(/,/g, "").replace(/\s+/g, " ").trim();
  // Format A: weekday  month  day  [year]  — "Sunday July 19"
  let m = trimmed.match(/^[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    return { day: parseInt(m[2], 10), month, year: m[3] ? parseInt(m[3], 10) : null };
  }
  // Format B: weekday  day  month  [year]  — "Sunday 19 July"
  m = trimmed.match(/^[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    return { day: parseInt(m[1], 10), month, year: m[3] ? parseInt(m[3], 10) : null };
  }
  return null;
}

// Parse 24h time like "19:30".
function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Normalise a title for fallback source_reference.
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Extract numeric booking ID from a mycloudcinema URL.
export function extractBookingId(url: string): string | null {
  const m = url.match(/mycloudcinema\.com\/#\/book\/(\d+)/);
  return m ? m[1] : null;
}

// Extract a format label from the booking URL suffix.
function extractFormatFromUrl(url: string): string | null {
  const m = url.match(/mycloudcinema\.com\/#\/book\/\d+\/([a-z-]+)/);
  if (!m) return null;
  const suffix = m[1];
  if (suffix === "preview-screening") return "Preview Screening";
  if (suffix === "q&a" || suffix === "q-amp-a") return "Q&A";
  return suffix;
}

// Detect venue from a booking-button class attribute.
// Returns "arches", "power-station", or null.
function venueFromClass(classAttr: string): string | null {
  if (/arches/i.test(classAttr)) return "arches";
  if (/power(?:station)?/i.test(classAttr)) return "power-station";
  return null;
}

// Detect venue from an h6 heading text.
// Returns "arches", "power-station", or null.
function venueFromHeading(text: string): string | null {
  if (/arches/i.test(text)) return "arches";
  if (/power\s*station/i.test(text)) return "power-station";
  return null;
}

// Parse a single Olympic/mycloudcinema whats-on page.
// Returns raw screenings with venue_label set plus diagnostic counts.
export function parseOlympicPage(
  html: string,
  baseUrl: string,
  nowLondon: Date
): OlympicParseResult {
  const results: ParsedOlympicScreening[] = [];
  const diagnostics: OlympicDiagnostics = {
    venueHeadingsArches: 0,
    venueHeadingsPowerstation: 0,
    archesBookingButtons: 0,
    powerStationBookingButtons: 0,
  };

  // Split by date sections.
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

    // Extract date from h3.
    const dateMatch = sectionBody.match(
      /<h3[^>]*class="date-day[^"]*"[^>]*>([^<]+)<\/h3>/
    );
    if (!dateMatch) continue;
    const dateText = stripTags(dateMatch[1]).trim();
    const dateParts = parseDateHeading(dateText);
    if (!dateParts) continue;

    const year =
      dateParts.year ?? inferYear(dateParts.day, dateParts.month, nowLondon);

    // Find all film link anchors to delimit film blocks.
    // Matching the full <a ...>...</a> tag ensures the block starts at the
    // opening <a, so nested booking buttons are included in the block.
    const filmLinkRegex =
      /<a\s+[^>]*href="\/film\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const filmLinks: { slug: string; index: number; title: string }[] = [];
    let flMatch: RegExpExecArray | null;
    while ((flMatch = filmLinkRegex.exec(sectionBody)) !== null) {
      const anchorTitle = decodeEntities(stripTags(flMatch[2])).trim();
      filmLinks.push({ slug: flMatch[1], index: flMatch.index, title: anchorTitle });
    }

    for (let i = 0; i < filmLinks.length; i++) {
      const { slug, title: anchorTitle } = filmLinks[i];
      const blockStart = filmLinks[i].index;
      const blockEnd =
        i + 1 < filmLinks.length ? filmLinks[i + 1].index : sectionBody.length;
      const block = sectionBody.slice(blockStart, blockEnd);

      // Title: prefer the anchor text, fall back to img alt, then slug.
      let movieTitle: string | null = anchorTitle || null;
      if (!movieTitle) {
        const altMatch = block.match(/<img[^>]*alt="([^"]+)"/);
        if (altMatch && altMatch[1].trim() && !altMatch[1].startsWith("BBFC")) {
          movieTitle = decodeEntities(altMatch[1]).trim();
        }
      }
      if (!movieTitle) {
        movieTitle = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (!movieTitle) continue;

      const filmUrl = `${baseUrl}/film/${slug}`;

      // --- Venue tracking in document order ---
      // Find all h6 venue headings and booking button anchors in document
      // order, then walk through them tracking the current venue.
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
        events.push({ type: "heading", index: h6m.index, text: h6m[1].trim() });
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

      for (const ev of events) {
        if (ev.type === "heading") {
          currentVenueLabel = ev.text || "";
          const key = ev.text ? venueFromHeading(ev.text) : null;
          if (key === "arches") diagnostics.venueHeadingsArches++;
          else if (key === "power-station") diagnostics.venueHeadingsPowerstation++;
          currentVenueKey = key;
          continue;
        }

        // It's a booking button.
        const fullAnchor = ev.fullAnchor!;
        const innerContent = ev.innerContent!;

        // Determine venue for this button: heading takes precedence, then
        // fall back to the button's own class.
        let venueLabel = currentVenueLabel;
        let venueKey = currentVenueKey;
        const classMatch = fullAnchor.match(/class="([^"]*)"/);
        const classAttr = classMatch ? classMatch[1] : "";
        const classKey = venueFromClass(classAttr);
        if (classKey === "arches") diagnostics.archesBookingButtons++;
        else if (classKey === "power-station") diagnostics.powerStationBookingButtons++;
        if (!venueKey && classKey) {
          venueKey = classKey;
          venueLabel =
            classKey === "arches"
              ? "The Cinema in the Arches"
              : "The Cinema in the Power Station";
        }

        // Extract href from the anchor. Arches buttons use href="#" with the
        // real booking URL in a data-booking-url attribute; Power Station
        // buttons put the real URL directly in href.
        const hrefMatch = fullAnchor.match(/href="([^"]*)"/);
        let rawHref = hrefMatch ? hrefMatch[1] : null;
        if (!rawHref || rawHref === "#") {
          const dataMatch = fullAnchor.match(/data-booking-url="([^"]*)"/);
          if (dataMatch) rawHref = dataMatch[1];
        }

        // Extract time.
        const timeMatch = innerContent.match(
          /<span class="btn-times-fs"[^>]*>([^<]+)<\/span>/
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
            status_label: null,
            sold_out: false,
            parse_error: `Unparseable time: "${timeText}"`,
          });
          continue;
        }

        const bookingId = rawHref ? extractBookingId(rawHref) : null;
        const bookingUrl = rawHref && bookingId ? rawHref : null;

        // Extract status label (e.g., "Last Few").
        const statusMatch = innerContent.match(
          /<span class="ms-2[^"]*"[^>]*>([^<]+)<\/span>/
        );
        const rawStatus = statusMatch ? statusMatch[1].trim() : null;
        const statusLabel = rawStatus || null;

        // Check for sold-out indicators.
        const soldOut =
          /sold[- ]?out/i.test(fullAnchor) ||
          /class="[^"]*(?:inactive|disabled)[^"]*"/.test(fullAnchor);

        // Format from URL suffix.
        const formatFromUrl = bookingUrl
          ? extractFormatFromUrl(bookingUrl)
          : null;

        const utc = londonToUtc(
          year,
          dateParts.month,
          dateParts.day,
          timeParts.hour,
          timeParts.minute
        );

        results.push({
          movie_title: movieTitle,
          start_time_iso: utc.toISOString(),
          venue_label: venueLabel,
          booking_url: bookingUrl,
          booking_id: bookingId,
          film_slug: slug,
          film_url: filmUrl,
          status_label: statusLabel ?? formatFromUrl,
          sold_out: soldOut,
        });
      }
    }
  }

  return { screenings: results, diagnostics };
}

// Build a stable source_reference for a screening without a booking ID.
export function fallbackSourceRef(
  prefix: string,
  title: string,
  startIso: string
): string {
  const d = new Date(startIso);
  const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const timeStr = `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `olympic:${prefix}:${normaliseTitle(title)}:${dateStr}:${timeStr}`;
}
