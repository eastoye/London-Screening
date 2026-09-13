import {
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type ProgrammeType,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";

export interface FilmMetadata {
  detailTitle: string | null;
  filmTitleHint: string | null;
  runtimeMinutes: number | null;
  directors: string[];
  eventUrl: string;
  artworkUrl: string | null;
  formatLabel: string | null;
}

export type SpecialKind = "hard_of_hearing" | "autism_friendly" | "watch_with_baby";

export function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteOfficialUrl(value: string, eventUrl: string): string | null {
  try {
    const url = new URL(value, eventUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.peckhamplex.london") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeArtworkUrl(value: string, eventUrl: string): string | null {
  const url = absoluteOfficialUrl(value, eventUrl);
  if (!url) return null;
  const pathname = new URL(url).pathname;
  if (!/^\/imgs\/posters\/(?:large|medium|trailers)\//i.test(pathname)) return null;
  return url;
}

function safeFormatLabel(value: string): string | null {
  const label = cleanText(value);
  if (!label) return null;
  return /^(?:(?:2D|3D)(?:\s+Digital)?|Digital|DCP|4K|35\s*mm|70\s*mm|IMAX)$/i.test(label)
    ? label.replace(/\b(35|70)\s*mm\b/i, "$1mm")
    : null;
}

export function safeFilmTitleHint(publicTitle: string, detailTitle: string | null): string | null {
  let title = cleanText(detailTitle || publicTitle);
  if (!title) return null;
  if (
    /^(?:TFFF|NT\s*Live|National Theatre Live|EXHIBITION ON SCREEN|Royal (?:Ballet|Opera)|The Met(?:ropolitan)? Opera)\s*:/i.test(title) ||
    /\b(?:shorts?|film festival|double[ -]bill|marathon|mystery screening|secret screening|programme|showcase)\b/i.test(title) ||
    /\b(?:The Musical|Live on Screen|Event Cinema)\b/i.test(title) ||
    /\bRadiohead\s*[x×]\s*Nosferatu\b/i.test(title)
  ) return null;

  if (/^British Horror Studio Season\s*:/i.test(title)) return null;
  title = title.replace(/^British Horror Studio\s*:\s*/i, "");
  title = title.replace(/\s*\((?:\d{1,3}(?:st|nd|rd|th)\s+Anniversary|20\d{2})\)\s*$/i, "").trim();
  return title.length >= 2 ? title : null;
}

export function parseFilmDetail(html: string, eventUrl: string, publicTitle: string): FilmMetadata {
  const detailTitle = cleanText(html.match(/<h1\b[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1]) || null;
  const runtimeText = cleanText(html.match(/<b>\s*Running Time:\s*<\/b>([\s\S]*?)<\/p>/i)?.[1]);
  const formatText = cleanText(html.match(/<b>\s*Format:\s*<\/b>([\s\S]*?)<\/p>/i)?.[1]);
  const imageValue = html.match(/<img\b[^>]*itemprop=["']image["'][^>]*src=["']([^"']+)["']/i)?.[1] ?? "";
  const directors = compactStrings([...html.matchAll(
    /itemprop=["']director["'][\s\S]*?<span\b[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/span>/gi,
  )].map((match) => cleanText(match[1])));
  return {
    detailTitle,
    filmTitleHint: safeFilmTitleHint(publicTitle, detailTitle),
    runtimeMinutes: parseRuntimeMinutes(runtimeText),
    directors,
    eventUrl,
    artworkUrl: safeArtworkUrl(imageValue, eventUrl),
    formatLabel: safeFormatLabel(formatText),
  };
}

export function labelsForSpecialKinds(kinds: ReadonlySet<SpecialKind>): string[] {
  return compactStrings([
    kinds.has("hard_of_hearing") ? "Hard of Hearing" : null,
    kinds.has("autism_friendly") ? "Autism Friendly" : null,
    kinds.has("watch_with_baby") ? "Watch With Baby" : null,
  ]);
}

export function accessibilityForSpecialKinds(kinds: ReadonlySet<SpecialKind>): AccessibilityFeature[] {
  const result: AccessibilityFeature[] = [];
  if (kinds.has("hard_of_hearing")) result.push("captioned");
  if (kinds.has("autism_friendly")) result.push("relaxed");
  return result;
}

export function programmesForSpecialKinds(kinds: ReadonlySet<SpecialKind>): ProgrammeType[] {
  return kinds.has("watch_with_baby") ? ["parent_and_baby", "child_required"] : [];
}

export function screeningTags(publicTitle: string, labels: string[]): ScreeningTag[] {
  const explicit = [...labels];
  if (/\banniversary\b/i.test(publicTitle)) explicit.push("Anniversary");
  if (labels.includes("Autism Friendly")) explicit.push("No adverts");
  if (labels.includes("Hard of Hearing")) explicit.push("Subtitled");
  return normaliseScreeningTags(explicit);
}

export function projectionFormats(formatLabel: string | null) {
  return normaliseProjectionFormats([formatLabel]);
}

export function programmeLabel(publicTitle: string): string | null {
  const match = publicTitle.match(/^(TFFF|British Horror Studio(?: Season)?|NT\s*Live|National Theatre Live|EXHIBITION ON SCREEN)\s*:/i);
  return match ? cleanText(match[1]) : null;
}
