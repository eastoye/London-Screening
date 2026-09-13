import {
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type ProgrammeType,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";

export interface Jw3PageItem {
  item_code?: string;
  item_id?: string;
  item_status?: string;
  item_hall?: string;
}

export interface Jw3PageMetadata {
  canonicalUrl: string | null;
  artworkUrl: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
  itemByInstanceId: Map<string, Jw3PageItem>;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|039);/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plainText(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeHtml(match[2]).trim() : null;
}

function splitPeople(value: string | null): string[] {
  if (!value) return [];
  return compactStrings(value.split(/\s*(?:,|\band\b|&)\s*/i));
}

function splitCountries(value: string | null): string[] {
  if (!value) return [];
  return compactStrings(value.split(/\s*(?:,|\/|;|\band\b)\s*/i));
}

function readInfoList(html: string): Map<string, string> {
  const values = new Map<string, string>();
  const pairRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  for (const match of html.matchAll(pairRe)) {
    const key = plainText(match[1]).toLowerCase();
    const value = plainText(match[2]);
    if (key && value && !values.has(key)) values.set(key, value);
  }
  return values;
}

function jsonArrayAfter(html: string, marker: RegExp): string | null {
  const markerMatch = marker.exec(html);
  if (!markerMatch) return null;
  const start = html.indexOf("[", markerMatch.index + markerMatch[0].length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return null;
}

function readDataLayerItems(html: string): Jw3PageItem[] {
  const json = jsonArrayAfter(html, /\bvar\s+dataLayer\s*=/i);
  if (!json) return [];
  try {
    const layer = JSON.parse(json) as Array<Record<string, unknown>>;
    const items: Jw3PageItem[] = [];
    for (const entry of layer) {
      if (!Array.isArray(entry.detail_items)) continue;
      for (const raw of entry.detail_items) {
        if (raw && typeof raw === "object") items.push(raw as Jw3PageItem);
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function parseJw3Page(html: string): Jw3PageMetadata {
  const canonicalTag = html.match(/<link\b[^>]*\brel\s*=\s*(["'])canonical\1[^>]*>/i)?.[0]
    ?? html.match(/<link\b[^>]*\bhref\s*=\s*(["'])[^"']+\1[^>]*\brel\s*=\s*(["'])canonical\2[^>]*>/i)?.[0]
    ?? "";
  const canonicalUrl = canonicalTag ? attribute(canonicalTag, "href") : null;

  let artworkUrl: string | null = null;
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const className = attribute(tag, "class") ?? "";
    if (!/(?:^|\s)poster(?:\s|$)/i.test(className)) continue;
    artworkUrl = attribute(tag, "src");
    if (artworkUrl) break;
  }
  if (!artworkUrl) {
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if ((attribute(tag, "property") ?? "").toLowerCase() !== "og:image") continue;
      artworkUrl = attribute(tag, "content");
      if (artworkUrl) break;
    }
  }

  const info = readInfoList(html);
  const yearValue = info.get("year") ?? info.get("release year") ?? null;
  const runtimeValue = info.get("duration") ?? info.get("runtime") ?? null;
  const directionValue = info.get("direction") ?? info.get("director") ?? info.get("directors") ?? null;
  const countryValue = info.get("country") ?? info.get("countries") ?? null;

  const itemByInstanceId = new Map<string, Jw3PageItem>();
  for (const item of readDataLayerItems(html)) {
    const id = String(item.item_id ?? item.item_code ?? "").trim();
    if (id) itemByInstanceId.set(id, item);
  }

  return {
    canonicalUrl,
    artworkUrl,
    releaseYear: parseExplicitYear(yearValue),
    runtimeMinutes: parseRuntimeMinutes(runtimeValue),
    directors: splitPeople(directionValue),
    countries: splitCountries(countryValue),
    itemByInstanceId,
  };
}

export function slugifyJw3Title(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Q\s*&\s*A/gi, "q and a")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function mapJw3EventPages(sitemapXml: string): Map<string, string> {
  const candidates = new Map<string, string[]>();
  for (const match of sitemapXml.matchAll(/<loc>\s*(https:\/\/www\.jw3\.org\.uk\/whats-on\/([^<\s]+))\s*<\/loc>/gi)) {
    const url = decodeHtml(match[1]);
    const pathSlug = decodeURIComponent(match[2]).replace(/-[a-z0-9]{4}$/i, "");
    const existing = candidates.get(pathSlug) ?? [];
    existing.push(url);
    candidates.set(pathSlug, existing);
  }
  const unique = new Map<string, string>();
  for (const [slug, urls] of candidates) {
    if (urls.length === 1) unique.set(slug, urls[0]);
  }
  return unique;
}

export function eventPageForTitle(title: string, pages: Map<string, string>): string | null {
  return pages.get(slugifyJw3Title(title)) ?? null;
}

export function explicitTitleLabels(title: string): string[] {
  const labels: string[] = [];
  if (/^Babykino\s*:/i.test(title)) labels.push("Babykino");
  if (/\bpreview screening\b/i.test(title)) labels.push("Preview screening");
  if (/\bQ\s*(?:&|\+)\s*A\b/i.test(title)) labels.push("Q&A");
  if (/\brelaxed screening\b/i.test(title)) labels.push("Relaxed screening");
  if (/\b(?:35|70)\s*mm\b/i.test(title)) labels.push(title.match(/\b(?:35|70)\s*mm\b/i)?.[0] ?? "");
  if (/\bIMAX\b/i.test(title)) labels.push("IMAX");
  return compactStrings(labels);
}

export function safeFilmTitleHint(title: string): string | null {
  if (/^(?:National Theatre Live|NT Live|Royal (?:Ballet|Opera)|Met Opera|Exhibition on Screen)\s*:/i.test(title)) {
    return null;
  }
  if (/\b(?:shorts?|programme|compilation|double[ -]bill)\b/i.test(title)) return null;

  let hint = title.trim();
  hint = hint.replace(/^Babykino\s*:\s*/i, "");
  hint = hint.replace(/\s+preview screening\s*\+\s*Q\s*&\s*A\s*$/i, "");
  hint = hint.replace(/\s*\+\s*Q\s*&\s*A\s*$/i, "");
  hint = hint.replace(/\s*\(((?:18|19|20|21)\d{2})\)\s*$/, "").trim();
  return hint.length >= 2 ? hint : null;
}

export function sourceYear(title: string, page: Jw3PageMetadata | null): number | null {
  return page?.releaseYear ?? parseExplicitYear(title.match(/\(((?:18|19|20|21)\d{2})\)\s*$/)?.[1]);
}

export function jw3ProgrammeTypes(title: string): ProgrammeType[] {
  return /^Babykino\s*:/i.test(title) ? ["parent_and_baby"] : [];
}

export function jw3Accessibility(labels: ReadonlyArray<string>): AccessibilityFeature[] {
  const text = labels.join(" ");
  const result: AccessibilityFeature[] = [];
  if (/\bcaption(?:ed|s)?\b|\bHOH\b/i.test(text)) result.push("captioned");
  if (/\baudio[ -](?:described|description)\b|\bAD\b/i.test(text)) result.push("audio_described");
  if (/\brelaxed\b/i.test(text)) result.push("relaxed");
  return result;
}

export function jw3ScreeningTags(labels: ReadonlyArray<string>): ScreeningTag[] {
  return normaliseScreeningTags(labels);
}

export function jw3ProjectionFormats(labels: ReadonlyArray<string>) {
  return normaliseProjectionFormats(labels);
}
