import { londonToUtc } from "../_shared/importSafety.ts";

export const CINEMA_NAME = "The Lexi Cinema";
export const PROGRAMME_URL = "https://thelexicinema.co.uk/TheLexiCinema.dll/WhatsOn";
const SITE_ORIGIN = "https://thelexicinema.co.uk";

export interface LexiFormatTag {
  Format?: string | null;
}

export interface LexiSeason {
  ID?: number | string | null;
  SeasonName?: string | null;
}

export interface LexiPerformance {
  ID?: number | string | null;
  IsSoldOut?: string | null;
  BF?: string | null;
  FF?: string | null;
  AD?: string | null;
  HOH?: string | null;
  RS?: string | null;
  QA?: string | null;
  AS?: string | null;
  BHS?: string | null;
  TP?: string | null;
  OC?: string | null;
  SL?: string | null;
  PR?: string | null;
  LS?: string | null;
  BR?: string | null;
  StartDate?: string | null;
  StartTimeAndNotes?: string | null;
  StartTime?: string | null;
  ReadableDate?: string | null;
  Notes?: string | null;
  AuditoriumName?: string | null;
  URL?: string | null;
  IsOpenForSale?: boolean | null;
}

export interface LexiEvent {
  ID?: number | string | null;
  Title?: string | null;
  TypeDescription?: string | null;
  Tags?: LexiFormatTag[] | null;
  Seasons?: LexiSeason[] | null;
  Year?: string | number | null;
  RunningTime?: string | number | null;
  Director?: string | null;
  Country?: string | null;
  ImageURL?: string | null;
  URL?: string | null;
  Performances?: LexiPerformance[] | null;
}

export interface LexiProgramme {
  Events?: LexiEvent[];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchProgrammeHtml(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(PROGRAMME_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`Lexi programme HTTP ${response.status}`);
      const html = await response.text();
      if (html.length < 50_000) throw new Error(`Lexi programme response was unexpectedly short (${html.length} bytes)`);
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractProgramme(html: string): LexiProgramme {
  const start = html.indexOf('{"Events":[');
  if (start < 0) throw new Error("Could not find Lexi Events JSON");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) throw new Error("Lexi Events JSON was incomplete");
  const parsed = JSON.parse(html.slice(start, end)) as LexiProgramme;
  if (!Array.isArray(parsed.Events) || parsed.Events.length < 5) {
    throw new Error(`Unexpected Lexi event count (${parsed.Events?.length ?? 0})`);
  }
  return parsed;
}

export async function fetchProgramme(): Promise<LexiEvent[]> {
  return extractProgramme(await fetchProgrammeHtml()).Events as LexiEvent[];
}

export function startTime(performance: LexiPerformance): string | null {
  const date = performance.StartDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const labelled = performance.StartTimeAndNotes?.trim().match(/^(\d{1,2}):(\d{2})$/);
  const compact = performance.StartTime?.trim().match(/^(\d{2})(\d{2})$/);
  const hour = labelled ? Number(labelled[1]) : compact ? Number(compact[1]) : NaN;
  const minute = labelled ? Number(labelled[2]) : compact ? Number(compact[2]) : NaN;
  if (!date || !Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return londonToUtc(Number(date[1]), Number(date[2]), Number(date[3]), hour, minute).toISOString();
}

export function officialUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, `${SITE_ORIGIN}/TheLexiCinema.dll/`);
    return url.protocol === "https:" && url.hostname === "thelexicinema.co.uk" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function bookingUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, `${SITE_ORIGIN}/TheLexiCinema.dll/`);
    const allowedHosts = new Set(["thelexicinema.co.uk", "japanesefilm.club"]);
    return url.protocol === "https:" && allowedHosts.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function artworkUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "images.savoysystems.co.uk" ? url.toString() : null;
  } catch {
    return null;
  }
}
