import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  commitImport,
  corsHeaders,
  endRun,
  jsonResponse,
  londonToUtc,
  startRun,
  type ImportRunContext,
  type ScreeningRecord,
} from "../_shared/importSafety.ts";
import {
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type ProgrammeType,
  type ProjectionFormat,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";

const CINEMA_NAME = "Forest Cinema Walthamstow";
const BASE_URL = "https://www.forestcinema.co.uk";
const LISTINGS_URL = `${BASE_URL}/whatson`;
const SOURCE_PREFIX = "forest-walthamstow";
const MIN_SCREENINGS = 5;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const REQUEST_TIMEOUT_MS = 25_000;
const DETAIL_BATCH_SIZE = 6;

const OPTIONAL_METADATA_URLS = [
  `${BASE_URL}/whatson/subtitled`,
  `${BASE_URL}/whatson/forestseniors`,
  `${BASE_URL}/whatson/parentandbaby`,
  `${BASE_URL}/whatson/autismfriendly`,
  `${BASE_URL}/Forestjuniors`,
] as const;

type AvailabilityStatus = "available" | "sold_out" | "unknown";

interface StructuredPerformance {
  code: string;
  eventCode: string;
  performanceType: string;
  timestamp: number;
  runtime: number | null;
  hall: string | null;
  soldOut: boolean;
  subtitled: boolean;
  audioDescription: boolean;
  hardOfHearing: boolean;
  autismFriendly: boolean;
  memberOnly: boolean;
  advanceScreening: boolean;
  tags: string;
  suffix: string;
  bookingUrl: string;
}

interface ForestEvent {
  code: string;
  title: string;
  structuredPerformances: StructuredPerformance[];
}

interface DetailPerformance {
  performanceId: string;
  startTime: Date;
  bookingUrl: string;
  soldOut: boolean;
  openForSale: boolean;
  label: string | null;
  accessibility: AccessibilityFeature[];
  programmeTypes: ProgrammeType[];
  screeningTags: ScreeningTag[];
}

interface EventDetail {
  eventCode: string;
  title: string;
  runtimeMinutes: number | null;
  eventUrl: string;
  artworkUrl: string | null;
  performances: DetailPerformance[];
}

const fetchHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractString(block: string, key: string): string {
  const escaped = escapeRegExp(key);
  return block.match(new RegExp(`\\["${escaped}"\\]=>\\s*string\\(\\d+\\) "([^"]*)"`))?.[1] || "";
}

function extractInt(block: string, key: string): number | null {
  const escaped = escapeRegExp(key);
  const integer = block.match(new RegExp(`\\["${escaped}"\\]=>\\s*int\\((\\d+)\\)`))?.[1];
  if (integer) return Number(integer);
  const stringValue = block.match(new RegExp(`\\["${escaped}"\\]=>\\s*string\\(\\d+\\) "(\\d+)"`))?.[1];
  return stringValue ? Number(stringValue) : null;
}

function extractBool(block: string, key: string): boolean {
  const escaped = escapeRegExp(key);
  return block.match(new RegExp(`\\["${escaped}"\\]=>\\s*bool\\((true|false)\\)`))?.[1] === "true";
}

function canonicalPerformanceUrl(value: string, performanceId: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "forestwalthamstow.admit-one.co.uk") return null;
    if (url.pathname !== `/performance/${performanceId}/`) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url: string, minBytes: number, requiredMarker?: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: fetchHeaders,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      const html = await response.text();
      if (html.length < minBytes) throw new Error(`${url} returned only ${html.length} bytes`);
      if (!/<\/html>\s*$/i.test(html.trim())) throw new Error(`${url} appears truncated (missing closing html)`);
      if (requiredMarker && !html.includes(requiredMarker)) throw new Error(`${url} is missing ${requiredMarker}`);
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parsePerformanceObject(block: string): StructuredPerformance | null {
  const code = extractString(block, "code");
  const eventCode = extractString(block, "eventcode");
  const timestamp = extractInt(block, "time");
  const rawBookingUrl = cleanText(extractString(block, "link"));
  if (!code || !eventCode || !timestamp || !rawBookingUrl) return null;
  const bookingUrl = canonicalPerformanceUrl(rawBookingUrl, code);
  if (!bookingUrl) return null;
  return {
    code,
    eventCode,
    performanceType: cleanText(extractString(block, "perftype")),
    timestamp,
    runtime: parseRuntimeMinutes(extractString(block, "runtime") || extractInt(block, "runtime")),
    hall: cleanText(extractString(block, "hall")) || null,
    soldOut: extractBool(block, "soldout"),
    subtitled: extractBool(block, "subtitled"),
    audioDescription: extractBool(block, "audiodescription"),
    hardOfHearing: extractBool(block, "hoh"),
    autismFriendly: extractBool(block, "autismfriendly"),
    memberOnly: extractBool(block, "memberonly"),
    advanceScreening: extractBool(block, "advancescreening"),
    tags: cleanText(extractString(block, "performancetags")),
    suffix: cleanText(extractString(block, "suffix")),
    bookingUrl,
  };
}

function parseStructuredPerformances(html: string): StructuredPerformance[] {
  const performances: StructuredPerformance[] = [];
  const errors: string[] = [];
  for (const match of html.matchAll(/<!--([\s\S]*?object\(web_performance\)[\s\S]*?)-->/gi)) {
    const performance = parsePerformanceObject(match[1]);
    if (!performance) {
      errors.push("Found a Forest performance object without a valid ID, event ID, time or booking URL.");
      continue;
    }
    performances.push(performance);
  }
  if (errors.length) throw new Error(`Forest structured source parse failed: ${errors.slice(0, 5).join(" | ")}`);
  return performances;
}

function parseEventTitles(html: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const match of html.matchAll(/<h2[^>]*>\s*<a[^>]+href=["'](?:https?:\/\/www\.forestcinema\.co\.uk)?\/event\/(\d+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi)) {
    const title = cleanText(match[2]);
    if (title) titles.set(match[1], title);
  }
  return titles;
}

function discoverEvents(mainHtml: string): { events: ForestEvent[]; excludedEvents: number; structuredCount: number } {
  const titles = parseEventTitles(mainHtml);
  const structured = parseStructuredPerformances(mainHtml);
  if (!titles.size) throw new Error("Forest listings contained no event cards.");
  if (!structured.length) throw new Error("Forest listings contained no structured performance objects.");

  const byEvent = new Map<string, StructuredPerformance[]>();
  for (const performance of structured) {
    const list = byEvent.get(performance.eventCode) ?? [];
    list.push(performance);
    byEvent.set(performance.eventCode, list);
  }

  const events: ForestEvent[] = [];
  let excludedEvents = 0;
  for (const [eventCode, performances] of byEvent.entries()) {
    const title = titles.get(eventCode);
    if (!title) throw new Error(`Forest event ${eventCode} has performance data but no programme title.`);
    const eventTypes = performances.map((performance) => performance.performanceType.toUpperCase() === "EVENT");
    if (eventTypes.some(Boolean) && eventTypes.some((value) => !value)) {
      throw new Error(`Forest event ${eventCode} mixes EVENT and film performance types.`);
    }
    if (eventTypes.every(Boolean)) {
      excludedEvents++;
      continue;
    }
    events.push({ code: eventCode, title, structuredPerformances: performances });
  }
  if (!events.length) throw new Error("Forest listings contained no non-EVENT programme entries.");
  return { events, excludedEvents, structuredCount: structured.length };
}

function programmeTypesFromLabel(label: string | null): ProgrammeType[] {
  const text = label ?? "";
  const values: ProgrammeType[] = [];
  if (/\bmembers?\s*only\b/i.test(text)) values.push("members_only");
  if (/\bparent\s*(?:&|and)\s*baby\b|\bbaby\s*club\b/i.test(text)) values.push("parent_and_baby");
  if (/\bforest\s*juniors?\b|\bchild\s*required\b/i.test(text)) values.push("child_required");
  if (/\bforest\s*seniors?\b|\bseniors?\b/i.test(text)) values.push("seniors");
  return values;
}

function accessibilityFromEvidence(text: string): AccessibilityFeature[] {
  const values: AccessibilityFeature[] = [];
  if (/a1-event-subtitles|\bsubtit(?:led|les)\b|\bcaptioned\b|\bHOH\b/i.test(text)) values.push("captioned");
  if (/a1-event-[^"']*(?:audio|describ)|\baudio[ -]?(?:described|description)\b/i.test(text)) values.push("audio_described");
  if (/a1-event-[^"']*(?:autism|relaxed)|\bautism\s*friendly\b|\brelaxed\b/i.test(text)) values.push("relaxed");
  return values;
}

function explicitTitleTags(title: string): ScreeningTag[] {
  const values: ScreeningTag[] = [];
  const add = (tag: ScreeningTag) => { if (!values.includes(tag)) values.push(tag); };
  if (/\bQ\s*(?:&|\+)\s*A\b|\bquestions?\s+and\s+answers?\b/i.test(title)) add("q_and_a");
  if (/\b(?:with|plus|director(?:'s)?)\s+intro(?:duction)?\b|\+\s*intro(?:duction)?\b/i.test(title)) add("introduction");
  if (/\b(?:with|plus|followed by)\s+(?:a\s+)?discussion\b|\+\s*discussion\b/i.test(title)) add("discussion");
  if (/\b(?:UK|London|World|International)\s+Premiere\b|^Premiere\s*[:\-]/i.test(title)) add("premiere");
  if (/^Preview\s*[:\-]|\bPreview Screening\b/i.test(title)) add("preview");
  if (/\b\d+(?:st|nd|rd|th)\s+Anniversary\b/i.test(title)) add("anniversary");
  if (/\bdouble[ -]bill\b/i.test(title)) add("double_bill");
  if (/\blive music\b|\blive score\b|\blive accompaniment\b/i.test(title)) add("live_music");
  if (/\bsing[ -]?along\b/i.test(title)) add("singalong");
  if (/\bno (?:ads|adverts|trailers)\b/i.test(title)) add("no_adverts");
  if (/\bfamily friendly\b/i.test(title)) add("family_friendly");
  if (/\bSEND friendly\b/i.test(title)) add("send_friendly");
  if (/\bsubtit(?:led|les)\b/i.test(title)) add("subtitled");
  if (/\bdubbed\b/i.test(title)) add("dubbed");
  if (/\brerelease\b|\bre-release\b/i.test(title)) add("rerelease");
  if (/\brestoration\b|\brestored\b/i.test(title)) add("restoration");
  return values;
}

function conservativeFilmTitleHint(title: string): string | null {
  const original = cleanText(title);
  if (!original) return null;
  if (/^(?:NT Live|National Theatre Live|RBO\b|ROH\b|The Royal Ballet\b|The Royal Opera\b|Met Opera\b)/i.test(original)) return null;
  if (/\b(?:double|triple)[ -]bill\b|\bselection of short films\b|\bshorts?\s+(?:programme|program|collection)\b/i.test(original)) return null;
  if (/\bEncore\b/i.test(original)) return null;

  let hint = original
    .replace(/\s*\([^)]*\blanguage\b[^)]*\)\s*$/i, "")
    .replace(/\s*-\s*Pyjama Party\s*$/i, "")
    .replace(/\s*\((?:\d+(?:st|nd|rd|th)\s+)?Anniversary\)\s*$/i, "")
    .replace(/\s+\d+(?:st|nd|rd|th)\s+Anniversary(?:\s+Screening)?\s*$/i, "")
    .trim();

  const decorated = hint.match(/^(.*?)(?:\s+(?:\+|-|:)\s*(?:Q\s*(?:&|\+)\s*A|Intro(?:duction)?|Discussion))\b/i);
  if (decorated?.[1]?.trim()) hint = decorated[1].trim();
  else if (/\b(?:Q\s*(?:&|\+)\s*A|Intro(?:duction)?|Discussion)\b/i.test(hint)) return null;

  return hint.length >= 2 ? hint : null;
}

function artworkUrl(html: string, eventCode: string): string | null {
  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const src = match[1];
    try {
      const url = new URL(src, BASE_URL);
      if (url.pathname.replace(/\/{2,}/g, "/").toLowerCase().endsWith(`/filmimages/small/${eventCode}.jpg`.toLowerCase())) {
        return url.protocol === "https:" ? url.toString() : null;
      }
    } catch {
      // Ignore malformed image URLs.
    }
  }
  return null;
}

function mergeUnique<T extends string>(...groups: ReadonlyArray<ReadonlyArray<T>>): T[] {
  return Array.from(new Set(groups.flat()));
}

function parseEventDetail(html: string, event: ForestEvent, metadataByPerformance: Map<string, StructuredPerformance>): EventDetail {
  const pageText = cleanText(html);
  const heading = cleanText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (!heading) throw new Error(`Forest event ${event.code} detail page has no title.`);
  if (heading.toLowerCase() !== event.title.toLowerCase()) {
    throw new Error(`Forest event ${event.code} title mismatch: programme="${event.title}" detail="${heading}".`);
  }

  const runtimeMinutes = parseRuntimeMinutes(pageText.match(/Running\s*time:\s*(\d+)\s*mins?/i)?.[1] ?? null);
  const eventUrl = `${BASE_URL}/event/${event.code}`;
  const verifiedArtworkUrl = artworkUrl(html, event.code);
  const lines = html.split(/\r?\n/);
  const seen = new Set<string>();
  const performances: DetailPerformance[] = [];
  let currentDate: { year: number; month: number; day: number } | null = null;
  let currentLabel: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const panel = line.match(/id=["']panel_(\d{4})(\d{2})(\d{2})["']/i);
    if (panel) {
      currentDate = { year: Number(panel[1]), month: Number(panel[2]), day: Number(panel[3]) };
      currentLabel = null;
      continue;
    }
    if (currentDate) {
      const labelMatch = line.match(/<p[^>]*font-semibold[^>]*>([\s\S]*?)<\/p>/i);
      if (labelMatch) {
        const label = cleanText(labelMatch[1]);
        currentLabel = label && !/^standard$/i.test(label) ? label : null;
      }
    }

    const performanceMatch = line.match(/href=["'](https:\/\/forestwalthamstow\.admit-one\.co\.uk\/performance\/(\d+)\/)["']/i);
    if (!performanceMatch || !currentDate) continue;
    const performanceId = performanceMatch[2];
    if (seen.has(performanceId)) throw new Error(`Forest event ${event.code} repeats performance ${performanceId}.`);
    seen.add(performanceId);

    const segment = lines.slice(index, Math.min(lines.length, index + 14)).join(" ");
    const timeMatch = segment.match(/>\s*([0-2]?\d:[0-5]\d)\s*</);
    if (!timeMatch) throw new Error(`Forest performance ${performanceId} has no parseable display time.`);
    const [hourText, minuteText] = timeMatch[1].split(":");
    const startTime = londonToUtc(currentDate.year, currentDate.month, currentDate.day, Number(hourText), Number(minuteText));
    const soldOut = /soldOutPerformance|soldOutOverride_color/i.test(line);
    const bookingUrl = canonicalPerformanceUrl(performanceMatch[1], performanceId);
    if (!bookingUrl) throw new Error(`Forest performance ${performanceId} has an invalid booking URL.`);

    const structured = metadataByPerformance.get(performanceId);
    const sourceTagLabels = structured?.tags ? structured.tags.split(";") : [];
    const labelEvidence = compactStrings([
      currentLabel,
      structured?.performanceType && !/^EVENT$/i.test(structured.performanceType) ? structured.performanceType : null,
      ...sourceTagLabels,
      structured?.suffix,
    ]);
    const accessibility = mergeUnique<AccessibilityFeature>(
      accessibilityFromEvidence(`${segment} ${labelEvidence.join(" ")}`),
      structured?.subtitled || structured?.hardOfHearing ? ["captioned"] : [],
      structured?.audioDescription ? ["audio_described"] : [],
      structured?.autismFriendly ? ["relaxed"] : [],
    );
    const programmeTypes = mergeUnique<ProgrammeType>(
      programmeTypesFromLabel(labelEvidence.join(" ")),
      structured?.memberOnly ? ["members_only"] : [],
    );
    const tagEvidence = labelEvidence.filter((value) => !/^STANDARD$/i.test(value));
    const screeningTags = mergeUnique<ScreeningTag>(
      normaliseScreeningTags(tagEvidence),
      explicitTitleTags(event.title),
      accessibility.includes("captioned") ? ["subtitled"] : [],
      structured?.advanceScreening ? ["preview"] : [],
    );
    const meaningfulLabel = compactStrings([
      ...labelEvidence.filter((value) => !/^STANDARD$/i.test(value)),
      accessibility.includes("captioned") && !labelEvidence.some((value) => /subtit|caption/i.test(value)) ? "Subtitled" : null,
    ]).join("; ") || null;

    const detailSoldOut = soldOut || structured?.soldOut === true;
    const openForSale = /^\s*<a\b/i.test(line) || Boolean(structured && !structured.soldOut && structured.bookingUrl);
    performances.push({
      performanceId,
      startTime,
      bookingUrl,
      soldOut: detailSoldOut,
      openForSale,
      label: meaningfulLabel,
      accessibility,
      programmeTypes,
      screeningTags,
    });
  }

  if (!performances.length) throw new Error(`Forest event ${event.code} detail page contains no performances.`);
  const detailIds = new Set(performances.map((performance) => performance.performanceId));
  for (const structured of event.structuredPerformances) {
    if (structured.timestamp * 1000 > Date.now() && !detailIds.has(structured.code)) {
      throw new Error(`Forest event ${event.code} detail page omitted visible performance ${structured.code}.`);
    }
    if (structured.runtime && runtimeMinutes && structured.runtime !== runtimeMinutes) {
      throw new Error(`Forest event ${event.code} runtime mismatch (${structured.runtime} vs ${runtimeMinutes}).`);
    }
  }

  return {
    eventCode: event.code,
    title: event.title,
    runtimeMinutes,
    eventUrl,
    artworkUrl: verifiedArtworkUrl,
    performances,
  };
}

async function fetchOptionalStructuredMetadata(): Promise<{ map: Map<string, StructuredPerformance>; failures: string[] }> {
  const map = new Map<string, StructuredPerformance>();
  const failures: string[] = [];
  const results = await Promise.allSettled(
    OPTIONAL_METADATA_URLS.map(async (url) => ({
      url,
      html: await fetchHtml(url, 20_000),
    })),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    try {
      for (const performance of parseStructuredPerformances(result.value.html)) map.set(performance.code, performance);
    } catch (error) {
      failures.push(`${result.value.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { map, failures };
}

async function fetchEventDetails(events: ForestEvent[], metadataByPerformance: Map<string, StructuredPerformance>): Promise<EventDetail[]> {
  const details: EventDetail[] = [];
  for (let offset = 0; offset < events.length; offset += DETAIL_BATCH_SIZE) {
    const batch = events.slice(offset, offset + DETAIL_BATCH_SIZE);
    const pages = await Promise.all(batch.map(async (event) => {
      const url = `${BASE_URL}/event/${event.code}`;
      const html = await fetchHtml(url, 40_000, `/performance/`);
      return parseEventDetail(html, event, metadataByPerformance);
    }));
    details.push(...pages);
  }
  return details;
}

function buildRecords(details: EventDetail[], metadataByPerformance: Map<string, StructuredPerformance>, nowUtc: Date): ScreeningRecord[] {
  const records: ScreeningRecord[] = [];
  for (const detail of details) {
    const titleHint = conservativeFilmTitleHint(detail.title);
    for (const performance of detail.performances) {
      if (performance.startTime <= nowUtc) continue;
      const structured = metadataByPerformance.get(performance.performanceId);
      const explicitFormatEvidence = compactStrings([
        ...(structured?.tags ? structured.tags.split(";") : []),
        structured?.suffix,
        ...(detail.title.match(/\b(?:35\s*mm|70\s*mm|IMAX)\b/gi) ?? []),
      ]);
      const projectionFormats = normaliseProjectionFormats(explicitFormatEvidence);
      const availabilityStatus: AvailabilityStatus = performance.soldOut
        ? "sold_out"
        : performance.openForSale && performance.bookingUrl
          ? "available"
          : "unknown";
      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: detail.title,
        start_time: performance.startTime.toISOString(),
        booking_url: performance.bookingUrl,
        format: projectionFormats.length
          ? projectionFormats.map((value) => value === "imax" ? "IMAX" : value).join(", ")
          : null,
        sold_out: performance.soldOut,
        projection_formats: projectionFormats,
        accessibility_features: performance.accessibility,
        programme_types: performance.programmeTypes,
        availability_status: availabilityStatus,
        film_title_hint: titleHint,
        source_release_year: null,
        source_runtime_minutes: detail.runtimeMinutes,
        source_directors: [],
        source_countries: [],
        source_event_url: detail.eventUrl,
        screen_name: structured?.hall ?? null,
        screening_label: performance.label,
        screening_tags: performance.screeningTags,
        verified_artwork_url: detail.artworkUrl,
        source_reference: `${SOURCE_PREFIX}:performance:${performance.performanceId}`,
        last_seen_at: nowUtc.toISOString(),
      });
    }
  }
  return records.sort((a, b) => a.start_time.localeCompare(b.start_time));
}

function duplicateValues(records: ScreeningRecord[], key: (record: ScreeningRecord) => string): string[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

async function getPreviousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not read previous Forest screening count: ${error.message}`);
  return count ?? 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ctx: ImportRunContext = { supabase, cinemaName: CINEMA_NAME, minScreenings: MIN_SCREENINGS, startedAt };

  const runStart = await startRun(ctx);
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  if (runStart.error || !runStart.runId) return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  const runId = runStart.runId;
  let found = 0;

  try {
    const mainHtml = await fetchHtml(LISTINGS_URL, 100_000, "object(web_performance)");
    const discovery = discoverEvents(mainHtml);

    const mainMetadata = new Map<string, StructuredPerformance>();
    for (const event of discovery.events) {
      for (const performance of event.structuredPerformances) mainMetadata.set(performance.code, performance);
    }
    const optional = await fetchOptionalStructuredMetadata();
    for (const [code, performance] of optional.map.entries()) mainMetadata.set(code, performance);

    const details = await fetchEventDetails(discovery.events, mainMetadata);
    const nowUtc = new Date();
    const records = buildRecords(details, mainMetadata, nowUtc);
    found = records.length;

    const duplicateReferences = duplicateValues(records, (record) => record.source_reference);
    if (duplicateReferences.length) throw new Error(`Duplicate Forest references: ${duplicateReferences.slice(0, 5).join(", ")}`);
    const duplicateTitleTimes = duplicateValues(records, (record) => `${record.movie_title.toLowerCase()}\u0000${record.start_time}`);
    if (duplicateTitleTimes.length) throw new Error(`Duplicate Forest title/time rows (${duplicateTitleTimes.length})`);

    const previousCount = await getPreviousActiveCount(ctx, nowUtc);
    if (previousCount >= RATIO_GUARD_MIN_EXISTING && records.length < Math.ceil(previousCount * MIN_EXPECTED_RATIO)) {
      throw new Error(`Count-drop guard blocked import: ${records.length} new future screenings vs ${previousCount} currently active.`);
    }
    if (records.length < MIN_SCREENINGS) throw new Error(`Unusually low screening count (${records.length}); database left untouched.`);

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length) throw new Error(`Import errors: ${errors.join("; ")}`);
    await endRun(ctx, runId, "success", records.length, saved);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      source: "official-forest-programme-plus-event-pages",
      screenings_found: records.length,
      screenings_saved: saved,
      previous_active: previousCount,
      discovered_events: discovery.events.length,
      excluded_non_film_events: discovery.excludedEvents,
      main_structured_performances: discovery.structuredCount,
      optional_metadata_failures: optional.failures,
      metadata_population: {
        title_hints: records.filter((record) => record.film_title_hint).length,
        runtimes: records.filter((record) => record.source_runtime_minutes).length,
        artwork: records.filter((record) => record.verified_artwork_url).length,
        source_event_urls: records.filter((record) => record.source_event_url).length,
        screens: records.filter((record) => record.screen_name).length,
        projection_formats: records.filter((record) => record.projection_formats?.length).length,
        accessibility: records.filter((record) => record.accessibility_features?.length).length,
        programme_types: records.filter((record) => record.programme_types?.length).length,
        screening_labels: records.filter((record) => record.screening_label).length,
        screening_tags: records.filter((record) => record.screening_tags?.length).length,
        known_availability: records.filter((record) => record.availability_status !== "unknown").length,
        sold_out: records.filter((record) => record.sold_out).length,
      },
      examples: records.slice(0, 8),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
