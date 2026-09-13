export const CINEMA_NAME = "Rich Mix";
export const CINEMA_URL = "https://richmix.org.uk/cinema/";
const API_BASE = "https://system.spektrix.com/richmix/api/v3";

export interface RichMixEvent {
  id: string;
  name: string;
  duration: number;
  imageUrl: string;
  thumbnailUrl: string;
  firstInstanceDateTimeUtc: string;
  lastInstanceDateTimeUtc: string;
  attributes: Record<string, unknown>;
}

export interface RichMixInstance {
  id: string;
  startUtc: string;
  isOnSale: boolean;
  cancelled: boolean;
  attributes: Record<string, unknown>;
}

function attributes(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("attribute_")));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchResponse(url: string, accept: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)",
          Accept: accept,
          "Accept-Language": "en-GB,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(300);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchJsonArray(url: string): Promise<Record<string, unknown>[]> {
  const response = await fetchResponse(url, "application/json");
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error(`${new URL(url).pathname} did not return an array`);
  return value as Record<string, unknown>[];
}

export async function fetchEvents(): Promise<RichMixEvent[]> {
  const raw = await fetchJsonArray(`${API_BASE}/events`);
  if (raw.length < 20) throw new Error(`Unexpected Rich Mix event catalogue size (${raw.length})`);
  return raw.map((event) => ({
    id: String(event.id ?? ""),
    name: String(event.name ?? ""),
    duration: Number(event.duration ?? 0),
    imageUrl: String(event.imageUrl ?? ""),
    thumbnailUrl: String(event.thumbnailUrl ?? ""),
    firstInstanceDateTimeUtc: String(event.firstInstanceDateTimeUtc ?? ""),
    lastInstanceDateTimeUtc: String(event.lastInstanceDateTimeUtc ?? ""),
    attributes: attributes(event),
  }));
}

export function isCinemaEvent(event: RichMixEvent): boolean {
  const programme = String(event.attributes.attribute_COGEventProgramme ?? "");
  const firstCategory = String(event.attributes.attribute_COGFirstCategory ?? "");
  const websiteChannel = String(event.attributes.attribute_WebsiteChannel ?? "");
  const primaryCategory = String(event.attributes.attribute_PrimaryCategory ?? "");
  const explicitlyFilm = /film/i.test(programme) || /film/i.test(websiteChannel) ||
    (/^film$/i.test(firstCategory) && /^film$/i.test(primaryCategory));
  const cinemaCategory = /cinema|film/i.test(firstCategory) || /film|cinema|screening|festival/i.test(primaryCategory);
  if (!explicitlyFilm || !cinemaCategory) return false;
  // Rich Mix previously filed this live stage show under its film channel.
  if (/^Film Stories Live\b/i.test(event.name)) return false;
  // Fringe film entries were historically filed under LIVE, including one
  // explicitly named launch party that contained no screening.
  if (/^live$/i.test(programme) && /\bparty\b/i.test(event.name)) return false;
  return true;
}

export function eventIsFuture(event: RichMixEvent, now: Date): boolean {
  const last = new Date(event.lastInstanceDateTimeUtc);
  return Number.isFinite(last.getTime()) && last > now;
}

export async function fetchInstances(eventId: string): Promise<RichMixInstance[]> {
  if (!/^[A-Z0-9]+$/i.test(eventId)) throw new Error(`Invalid Rich Mix event ID ${eventId}`);
  const raw = await fetchJsonArray(`${API_BASE}/events/${encodeURIComponent(eventId)}/instances`);
  return raw.map((instance) => ({
    id: String(instance.id ?? ""),
    startUtc: String(instance.startUtc ?? ""),
    isOnSale: instance.isOnSale === true,
    cancelled: instance.cancelled === true,
    attributes: attributes(instance),
  }));
}

export async function fetchInstancesForEvents(
  events: RichMixEvent[],
): Promise<Map<string, RichMixInstance[]>> {
  const result = new Map<string, RichMixInstance[]>();
  const batchSize = 6;
  for (let index = 0; index < events.length; index += batchSize) {
    const batch = events.slice(index, index + batchSize);
    const responses = await Promise.all(batch.map(async (event) => [event.id, await fetchInstances(event.id)] as const));
    for (const [eventId, instances] of responses) result.set(eventId, instances);
  }
  return result;
}

export async function officialPageConfirmsEmptyProgramme(): Promise<boolean> {
  const response = await fetchResponse(CINEMA_URL, "text/html,application/xhtml+xml");
  const html = await response.text();
  if (html.length < 20_000) throw new Error(`Rich Mix cinema page was unexpectedly short (${html.length} bytes)`);
  return /There are no films coming soon/i.test(html);
}

export function publicBookingUrl(instanceId: string): string | null {
  const publicId = instanceId.match(/^\d+/)?.[0];
  if (!publicId) return null;
  return `https://tickets.richmix.org.uk/richmix/website/ChooseSeats.aspx?EventInstanceId=${publicId}&resize=true`;
}

export function sourceArtworkUrl(event: RichMixEvent): string | null {
  const value = event.imageUrl || event.thumbnailUrl;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
