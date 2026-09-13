import { londonToUtc } from "../_shared/importSafety.ts";

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

const SOURCE_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};

export interface IcaPagePerformance {
  startTime: string;
  screenName: string;
  sourceText: string;
}

export interface IcaFilmPage {
  path: string;
  url: string;
  html: string;
  displayTitle: string;
  bookingEventId: string;
  performances: IcaPagePerformance[];
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|039);|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function cleanHtml(value: unknown): string {
  return decodeHtml(String(value ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchText(url: string, label: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        headers: SOURCE_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
      const body = await response.text();
      if (body.length < 1_000) throw new Error(`${label} response was unexpectedly small`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} request failed`);
}

export function discoverFilmPaths(html: string): string[] {
  const paths = [...html.matchAll(/href=["'](\/films\/[^"'#?]+)["']/gi)]
    .map((match) => match[1].replace(/\/$/, ""))
    .filter((path) => path.split("/").length === 3);
  return [...new Set(paths)];
}

function parsePerformance(block: string): IcaPagePerformance | null {
  const date = block.match(
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})/
  );
  const time = block.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  const screenName = cleanHtml(block.match(/<div class=['"]venue['"]>([\s\S]*?)<\/div>/i)?.[1]);
  if (!date || !time || !screenName || !MONTHS[date[2]]) return null;

  let hour = Number(time[1]);
  if (time[3].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (time[3].toLowerCase() === "am" && hour === 12) hour = 0;
  const startTime = londonToUtc(
    Number(date[3]),
    MONTHS[date[2]],
    Number(date[1]),
    hour,
    Number(time[2])
  ).toISOString();
  return { startTime, screenName, sourceText: cleanHtml(block) };
}

export function parseFilmPage(baseUrl: string, path: string, html: string): IcaFilmPage | null {
  const titleHtml = html.match(/<span class=['"]title['"]>([\s\S]*?)<\/span>/i)?.[1];
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']ICA \| ([^"']+)["']/i)?.[1];
  const displayTitle = cleanHtml(titleHtml ?? ogTitle ?? "");
  const bookingEventId = html.match(/location\.href=["']\/book\/(\d+)["']/i)?.[1] ?? "";
  if (!displayTitle || !bookingEventId) return null;

  const section = html.match(/<div class=["']performance-list["']>([\s\S]*?)<\/div>\s*<details/i)?.[1] ?? "";
  const rawBlocks = [...section.matchAll(
    /<div class=['"]performance future['"]>([\s\S]*?)(?=<div class=['"]performance future['"]>|$)/gi
  )];
  const performances: IcaPagePerformance[] = [];
  for (const match of rawBlocks) {
    const performance = parsePerformance(match[1]);
    if (!performance) throw new Error(`Could not parse an ICA performance on ${path}`);
    performances.push(performance);
  }

  return {
    path,
    url: `${baseUrl}${path}`,
    html,
    displayTitle,
    bookingEventId,
    performances,
  };
}

export function performanceKey(startTime: string, screenName: string): string {
  return `${new Date(startTime).toISOString()}|${screenName.trim().toLowerCase()}`;
}
