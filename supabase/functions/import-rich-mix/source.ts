export const CINEMA_NAME = "Rich Mix";
export const CINEMA_URL = "https://richmix.org.uk/cinema/";
const API_BASE = "https://system.spektrix.com/richmix/api/v3";
const PUBLIC_EVENT_LIST_URL = "https://system.spektrix.com/richmix/website/EventList.aspx";
const MAX_PUBLIC_MONTHS = 24;
const RECENT_FILM_WINDOW_MS = 370 * 24 * 60 * 60 * 1000;

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

function londonYearMonth(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Could not determine current Europe/London month for Rich Mix completeness check");
  }
  return { year, month };
}

function monthSelector(year: number, month: number): string {
  return `${year}${month}`;
}

function parseMonthSelector(value: string): { selector: string; ordinal: number } | null {
  const match = value.match(/^(\d{4})(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2200 || month < 1 || month > 12) return null;
  return { selector: value, ordinal: year * 12 + month };
}

function publicEventId(eventId: string): string | null {
  return eventId.match(/^(\d+)/)?.[1] ?? null;
}

async function fetchPublicEventListPage(selector: string): Promise<string> {
  const url = `${PUBLIC_EVENT_LIST_URL}?MonthSelect=${encodeURIComponent(selector)}&SortBy=Date&resize=true`;
  const response = await fetchResponse(url, "text/html,application/xhtml+xml");
  const html = await response.text();
  if (html.length < 20_000) {
    throw new Error(`Rich Mix public Spektrix event list was unexpectedly short (${html.length} bytes)`);
  }
  if (!/Displaying events between|There are no events in this month/i.test(html)) {
    throw new Error("Rich Mix public Spektrix event list did not contain its expected programme marker");
  }
  return html;
}

function publicEventIds(html: string): Set<string> {
  return new Set(
    Array.from(html.matchAll(/EventDetails\.aspx\?EventId=(\d+)/gi), (match) => match[1]),
  );
}

function futureMonthSelectors(html: string, now: Date): string[] {
  const current = londonYearMonth(now);
  const currentOrdinal = current.year * 12 + current.month;
  const selectors = new Map<string, number>();
  selectors.set(monthSelector(current.year, current.month), currentOrdinal);

  for (const match of html.matchAll(/MonthSelect=(\d{5,6})/gi)) {
    const parsed = parseMonthSelector(match[1]);
    if (parsed && parsed.ordinal >= currentOrdinal) selectors.set(parsed.selector, parsed.ordinal);
  }

  if (selectors.size > MAX_PUBLIC_MONTHS) {
    throw new Error(`Rich Mix public Spektrix event list exposed too many future months (${selectors.size})`);
  }

  return [...selectors.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([selector]) => selector);
}

async function publicSpektrixFutureEventIds(now: Date): Promise<Set<string>> {
  const current = londonYearMonth(now);
  const currentSelector = monthSelector(current.year, current.month);
  const firstPage = await fetchPublicEventListPage(currentSelector);
  const selectors = futureMonthSelectors(firstPage, now);
  const ids = publicEventIds(firstPage);

  for (const selector of selectors) {
    if (selector === currentSelector) continue;
    const html = await fetchPublicEventListPage(selector);
    for (const id of publicEventIds(html)) ids.add(id);
  }
  return ids;
}

// The Rich Mix WordPress cinema page is currently protected by an anti-bot
// challenge and returns HTTP 403 to the importer runtime. For the zero-programme
// safety check, use two official Spektrix surfaces instead:
//   1. the v3 API taxonomy must contain no future cinema/film events; and
//   2. the public Spektrix "What's On" pages must contain no future public event
//      that is absent from that API catalogue.
// A recent genuine film record is also required so a future ticketing-system or
// taxonomy migration cannot silently turn an empty API result into confirmation.
export async function officialPageConfirmsEmptyProgramme(): Promise<boolean> {
  const now = new Date();
  const events = await fetchEvents();
  const futureEvents = events.filter((event) => eventIsFuture(event, now));
  if (futureEvents.some(isCinemaEvent)) return false;

  const recentFilm = events.some((event) => {
    if (!isCinemaEvent(event)) return false;
    const last = new Date(event.lastInstanceDateTimeUtc);
    if (!Number.isFinite(last.getTime()) || last > now) return false;
    return now.getTime() - last.getTime() <= RECENT_FILM_WINDOW_MS;
  });
  if (!recentFilm) {
    throw new Error("Rich Mix zero-programme check could not find a recent film record in Spektrix");
  }

  const apiFutureIds = new Set<string>();
  for (const event of futureEvents) {
    const id = publicEventId(event.id);
    if (!id) throw new Error(`Rich Mix future event ${event.id} had no public Spektrix event ID`);
    apiFutureIds.add(id);
  }

  const publicFutureIds = await publicSpektrixFutureEventIds(now);
  const publicOnly = [...publicFutureIds].filter((id) => !apiFutureIds.has(id));
  if (publicOnly.length) {
    throw new Error(
      `Rich Mix public Spektrix programme contained events absent from the API catalogue: ${publicOnly.slice(0, 5).join(", ")}`,
    );
  }

  return true;
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
