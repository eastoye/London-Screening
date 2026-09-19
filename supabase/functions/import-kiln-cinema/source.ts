export const CINEMA_NAME = "Kiln Cinema";
const API_BASE = "https://tickets.kilntheatre.com/tricycle/api/v3";

export interface KilnEvent {
  id: string;
  name: string;
  description: string;
  duration: number;
  imageUrl: string;
  thumbnailUrl: string;
  firstInstanceDateTimeUtc: string;
  lastInstanceDateTimeUtc: string;
  isOnSale: boolean;
  attributes: Record<string, unknown>;
}

export interface KilnInstance {
  id: string;
  startUtc: string;
  isOnSale: boolean;
  cancelled: boolean;
  planId: string;
  webInstanceId: string | null;
  attributes: Record<string, unknown>;
}

function attributes(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("attribute_")));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJsonArray(url: string): Promise<Record<string, unknown>[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; London-Screenings/2.0)",
          Accept: "application/json",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
      const value = await response.json();
      if (!Array.isArray(value)) throw new Error(`${new URL(url).pathname} did not return an array`);
      return value as Record<string, unknown>[];
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(attempt * 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchEvents(): Promise<KilnEvent[]> {
  const raw = await fetchJsonArray(`${API_BASE}/events`);
  if (raw.length < 10 || raw.length > 400) {
    throw new Error(`Unexpected Kiln event catalogue size (${raw.length})`);
  }
  return raw.map((event) => ({
    id: String(event.id ?? ""),
    name: String(event.name ?? ""),
    description: String(event.description ?? ""),
    duration: Number(event.duration ?? 0),
    imageUrl: String(event.imageUrl ?? ""),
    thumbnailUrl: String(event.thumbnailUrl ?? ""),
    firstInstanceDateTimeUtc: String(event.firstInstanceDateTimeUtc ?? ""),
    lastInstanceDateTimeUtc: String(event.lastInstanceDateTimeUtc ?? ""),
    isOnSale: event.isOnSale === true,
    attributes: attributes(event),
  }));
}

export function isCinemaEvent(event: KilnEvent): boolean {
  const category = String(event.attributes.attribute_Category ?? "");
  const type = String(event.attributes.attribute_Type ?? "");
  const webEventType = String(event.attributes.attribute_WebEventType ?? "");
  const accountCode = String(event.attributes.attribute_AccountCode ?? "");
  const artform = String(event.attributes.attribute_TAAArtform ?? "");

  const isCinema = /cinema/i.test(category) || /cinema/i.test(type) ||
    /cinema/i.test(webEventType) || /cinema/i.test(accountCode);
  if (!isCinema && /film/i.test(artform)) {
    return /cinema/i.test(webEventType) || /cinema/i.test(category);
  }
  return isCinema;
}

function parseUtc(value: string): Date | null {
  const text = value.trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function eventIsFuture(event: KilnEvent, now: Date): boolean {
  const last = parseUtc(event.lastInstanceDateTimeUtc);
  return Boolean(last && last > now);
}

export async function fetchInstances(eventId: string): Promise<KilnInstance[]> {
  if (!/^[A-Z0-9]+$/i.test(eventId)) throw new Error(`Invalid Kiln event ID ${eventId}`);
  const raw = await fetchJsonArray(`${API_BASE}/events/${encodeURIComponent(eventId)}/instances`);
  return raw.map((instance) => ({
    id: String(instance.id ?? ""),
    startUtc: String(instance.startUtc ?? ""),
    isOnSale: instance.isOnSale === true,
    cancelled: instance.cancelled === true,
    planId: String(instance.planId ?? ""),
    webInstanceId: instance.webInstanceId ? String(instance.webInstanceId) : null,
    attributes: attributes(instance),
  }));
}

export async function fetchInstancesForEvents(events: KilnEvent[]): Promise<Map<string, KilnInstance[]>> {
  const result = new Map<string, KilnInstance[]>();
  const batchSize = 6;
  for (let index = 0; index < events.length; index += batchSize) {
    const batch = events.slice(index, index + batchSize);
    const responses = await Promise.all(
      batch.map(async (event) => [event.id, await fetchInstances(event.id)] as const),
    );
    for (const [eventId, instances] of responses) result.set(eventId, instances);
  }
  return result;
}

export function parseInstanceStart(instance: KilnInstance): Date | null {
  return parseUtc(instance.startUtc);
}

export function bookingUrl(instanceId: string): string | null {
  if (!/^[A-Z0-9]+$/i.test(instanceId)) return null;
  return `https://tickets.kilntheatre.com/tricycle/website/ChooseSeats.aspx?resize=true&EventInstanceId=${instanceId}`;
}

export function sourceArtworkUrl(event: KilnEvent): string | null {
  const value = event.imageUrl.trim() || event.thumbnailUrl.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
