import {
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseRuntimeMinutes,
  type ProgrammeType,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";

export interface EventMetadata {
  releaseYear: number | null;
  directors: string[];
}

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

export function parseEventMetadata(html: string): EventMetadata {
  const release = cleanText(html.match(/<b>\s*Release Date:\s*<\/b>\s*([^<]+)/i)?.[1]);
  const releaseMatch = release.match(/^(\d{1,2})\/(\d{1,2})\/((?:19|20|21)\d{2})$/);
  const directorText = cleanText(html.match(/<b>\s*Directed by:\s*<\/b>\s*([^<]+)/i)?.[1]);
  return {
    releaseYear: releaseMatch ? Number(releaseMatch[3]) : null,
    directors: compactStrings(directorText.split(/\s*(?:,|\band\b|&)\s*/i)),
  };
}

export function displayTitle(sourceTitle: string): string {
  return cleanText(sourceTitle);
}

function stripTerminalEventAdditions(value: string): string {
  let result = value.trim();
  for (let pass = 0; pass < 4; pass++) {
    const previous = result;
    result = result
      .replace(
        /\s*\+\s*(?:(?:virtual\s+|recorded\s+)?Q\s*(?:&|\+)\s*A(?:\s+with\b[\s\S]*)?|intro(?:duction)?(?:\s+by\b[\s\S]*)?)\s*$/i,
        "",
      )
      .trim();
    if (result === previous) break;
  }
  return result;
}

function removeKnownProgrammeDecoration(value: string): string {
  let result = value
    .replace(/^TFFF\s*[-:]\s*/i, "")
    .replace(/^(?:TFFF|Reclaim The Frame|Made For Cinema|Fringe\s*x\s*TGirlsonFilm)\s+(?:Presents?|presents?)\s*:\s*/i, "")
    .replace(/^Bar Trash:\s*(?:Opening Night\s*[–—-]\s*)?/i, "")
    .replace(/\s*-\s*(?:LIFF|HKFF\s*\d{4}|Tibet Film Festival London|Women Resist|Halloween at Genesis)\s*$/i, "")
    .replace(/\s*-\s*Presented by the Cult Classic Collective\s*$/i, "")
    .trim();

  result = stripTerminalEventAdditions(result);

  return result
    .replace(/\s*\(in\s+35\s*mm\)/gi, "")
    .replace(/\s*\((?:London|UK|World)\s+Premiere\)/gi, "")
    .replace(/\s*\((?:19|20)\d{2}\)/g, "")
    .replace(/\s+\d{1,3}(?:st|nd|rd|th)\s+Anniversary\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function explicitTitleYear(sourceTitle: string): number | null {
  const years = [...cleanText(sourceTitle).matchAll(/\(((?:18|19|20|21)\d{2})\)/g)]
    .map((match) => Number(match[1]));
  const uniqueYears = [...new Set(years)];
  return uniqueYears.length === 1 ? uniqueYears[0] : null;
}

function hasEventStyleReleaseDateRisk(sourceTitle: string): boolean {
  const title = cleanText(sourceTitle);
  return (
    /^TFFF\s*[-:]/i.test(title) ||
    /^Bar Trash:/i.test(title) ||
    /^(?:Reclaim The Frame|Made For Cinema|Fringe\s*x\s*TGirlsonFilm)\b/i.test(title) ||
    /\b(?:UK|London|World)\s+(?:Theatrical\s+)?Premiere\b/i.test(title) ||
    /\b\d{1,3}(?:st|nd|rd|th)\s+Anniversary\b/i.test(title) ||
    /\b(?:Q\s*(?:&|\+)\s*A|Intro(?:duction)?)\b/i.test(title) ||
    /\bpresent(?:ed|s)?\s+by\b/i.test(title) ||
    /\b(?:LIFF|HKFF\s*\d{4}|Tibet Film Festival London|Women Resist|FRINGE!)\b/i.test(title) ||
    /^First Watch Preview:/i.test(title) ||
    /^BRUCE LEE U\.?K\.?\s+EVENT\b/i.test(title) ||
    /^JOY\s*\+\s*DAISIES\s*:/i.test(title)
  );
}

export function sourceReleaseYear(sourceTitle: string, detailReleaseYear: number | null): number | null {
  const titleYear = explicitTitleYear(sourceTitle);
  if (titleYear) return titleYear;
  return hasEventStyleReleaseDateRisk(sourceTitle) ? null : detailReleaseYear;
}

export function safeFilmTitleHint(sourceTitle: string): string | null {
  const source = cleanText(sourceTitle);
  if (!source) return null;
  if (
    /\b(?:shorts?\s+block|short film competition|double[ -](?:bill|feature)|compilation|mystery screening|secret screening|mini-market|workshop|party|poetry slam|watch party)\b/i.test(source) ||
    /^(?:National Theatre Live|NT Live)\s*:/i.test(source) ||
    /\b(?:New Queer Worlds|Intimate Meetings)\s*-\s*FRINGE!/i.test(source) ||
    /^BRUCE LEE U\.?K\.?\s+EVENT\b/i.test(source) ||
    /^JOY\s*\+\s*DAISIES\s*:/i.test(source)
  ) return null;
  const hint = removeKnownProgrammeDecoration(source);
  return hint.length >= 2 && !/[+&]\s*$/.test(hint) ? hint : null;
}

export function explicitLabels(sourceTitle: string, performanceLabels: string[]): string[] {
  const title = cleanText(sourceTitle);
  const labels: string[] = [...performanceLabels];
  const qAndA = title.match(/(?:virtual\s+|recorded\s+)?Q\s*&\s*A(?:\s+with\s+[^–—-]+)?/i)?.[0];
  if (qAndA) labels.push(qAndA);
  if (/\+\s*Intro(?:duction)?\b/i.test(title)) labels.push("Introduction");
  if (/^TFFF\s*[-:]/i.test(title)) labels.push("TFFF");
  if (/\s-\sLIFF\s*$/i.test(title)) labels.push("LIFF");
  if (/\bTibet Film Festival London\b/i.test(title)) labels.push("Tibet Film Festival London");
  if (/\bWomen Resist\b/i.test(title)) labels.push("Women Resist");
  if (/\bFRINGE!\b/i.test(title)) labels.push("FRINGE!");
  if (/\b(?:UK|London|World) Premiere\b/i.test(title)) labels.push(title.match(/\b(?:UK|London|World) Premiere\b/i)![0]);
  if (/\b\d{1,3}(?:st|nd|rd|th) Anniversary\b/i.test(title)) labels.push(title.match(/\b\d{1,3}(?:st|nd|rd|th) Anniversary\b/i)![0]);
  return compactStrings(labels);
}

export function projectionFormats(labels: string[]) {
  return normaliseProjectionFormats(labels);
}

export function programmeTypes(labels: string[]): ProgrammeType[] {
  return labels.some((label) => /parent\s*&\s*baby/i.test(label)) ? ["parent_and_baby"] : [];
}

export function screeningTags(labels: string[]): ScreeningTag[] {
  return normaliseScreeningTags(labels);
}

export function runtimeMinutes(value: string): number | null {
  return parseRuntimeMinutes(cleanText(value));
}

export function isClearlyNonFilm(sourceTitle: string, performanceLabels: string[]): boolean {
  const title = cleanText(sourceTitle);
  if (/\b(?:mini-market|poetry slam|pitching workshop|opening night party|closing party|awards ceremony)\b/i.test(title)) return true;
  if (/\bfilm marketing\s*&\s*distribution for independent filmmakers\b/i.test(title)) return true;
  if (/\bSome Like it Swing\b/i.test(title)) return true;
  if (performanceLabels.some((label) => /bar/i.test(label)) && !/^Bar Trash:/i.test(title)) return true;
  return false;
}
