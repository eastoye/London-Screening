// Shared Spektrix parser for Spektrix-powered cinema importers.
// Handles:
//   - fetching events and per-event instances from the Spektrix v3 API
//   - extracting EventInstanceId
//   - constructing exact booking URLs (ChooseSeats.aspx)
//   - parsing performance date/time (Europe/London → UTC)
//   - venue/screen extraction via plan → venue lookup
//   - availability / sold-out status
//   - accessibility and event labels

export interface SpektrixConfig {
  // Spektrix client name, e.g. "barbicancentre", "tricycle", "richmix"
  client: string;
  // Base URL for the Spektrix host. Can be a custom domain
  // (e.g. "https://tickets.barbican.org.uk") or the standard
  // "https://system.spektrix.com".
  baseUrl: string;
  // Source prefix for source_reference, e.g. "barbican", "kiln"
  sourcePrefix: string;
}

export interface SpektrixEvent {
  id: string;
  name: string;
  description: string;
  duration: number;
  imageUrl: string;
  thumbnailUrl: string;
  instanceDates: string;
  isOnSale: boolean;
  firstInstanceDateTime: string;
  lastInstanceDateTime: string;
  // Event-level attributes (prefix "attribute_")
  attributes: Record<string, unknown>;
}

export interface SpektrixInstance {
  id: string;
  eventId: string;
  start: string;
  startUtc: string;
  isOnSale: boolean;
  cancelled: boolean;
  planId: string;
  webInstanceId: string | null;
  // Instance-level attributes (prefix "attribute_")
  attributes: Record<string, unknown>;
}

export interface SpektrixPlan {
  id: string;
  name: string;
  venue: { id: string };
}

export interface SpektrixVenue {
  id: string;
  name: string;
  address: string;
}

export interface ParsedScreening {
  movie_title: string;
  start_time_iso: string;
  event_instance_id: string;
  booking_url: string;
  plan_id: string;
  venue_name: string | null;
  screen_name: string | null;
  format: string | null;
  labels: string[];
  sold_out: boolean;
  source_reference: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function fetchOpts(): RequestInit {
  return {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "follow" as const,
  };
}

function apiBase(config: SpektrixConfig): string {
  return `${config.baseUrl}/${config.client}/api/v3`;
}

// Fetch all events from the Spektrix API.
export async function fetchEvents(
  config: SpektrixConfig
): Promise<SpektrixEvent[]> {
  const url = `${apiBase(config)}/events`;
  const resp = await fetch(url, fetchOpts());
  if (!resp.ok) {
    throw new Error(`Spektrix events API returned HTTP ${resp.status}`);
  }
  const raw = (await resp.json()) as Record<string, unknown>[];
  return raw.map((e) => ({
    id: e.id as string,
    name: e.name as string,
    description: (e.description as string) || "",
    duration: e.duration as number,
    imageUrl: (e.imageUrl as string) || "",
    thumbnailUrl: (e.thumbnailUrl as string) || "",
    instanceDates: (e.instanceDates as string) || "",
    isOnSale: e.isOnSale as boolean,
    firstInstanceDateTime: (e.firstInstanceDateTime as string) || "",
    lastInstanceDateTime: (e.lastInstanceDateTime as string) || "",
    attributes: extractAttributes(e),
  }));
}

// Fetch all instances for a given event.
export async function fetchInstances(
  config: SpektrixConfig,
  eventId: string
): Promise<SpektrixInstance[]> {
  const url = `${apiBase(config)}/events/${eventId}/instances`;
  const resp = await fetch(url, fetchOpts());
  if (!resp.ok) {
    throw new Error(
      `Spektrix instances API for event ${eventId} returned HTTP ${resp.status}`
    );
  }
  const raw = (await resp.json()) as Record<string, unknown>[];
  return raw.map((i) => ({
    id: i.id as string,
    eventId: ((i.event as Record<string, unknown>)?.id as string) || eventId,
    start: i.start as string,
    startUtc: i.startUtc as string,
    isOnSale: i.isOnSale as boolean,
    cancelled: i.cancelled as boolean,
    planId: i.planId as string,
    webInstanceId: (i.webInstanceId as string) || null,
    attributes: extractAttributes(i),
  }));
}

// Fetch all venues.
export async function fetchVenues(
  config: SpektrixConfig
): Promise<SpektrixVenue[]> {
  const url = `${apiBase(config)}/venues`;
  const resp = await fetch(url, fetchOpts());
  if (!resp.ok) {
    throw new Error(`Spektrix venues API returned HTTP ${resp.status}`);
  }
  const raw = (await resp.json()) as Record<string, unknown>[];
  return raw.map((v) => ({
    id: v.id as string,
    name: v.name as string,
    address: (v.address as string) || "",
  }));
}

// Fetch all plans and return a map of planId → { name, venueId }.
export async function fetchPlanMap(
  config: SpektrixConfig
): Promise<Map<string, { name: string; venueId: string }>> {
  const url = `${apiBase(config)}/plans`;
  const resp = await fetch(url, fetchOpts());
  if (!resp.ok) {
    throw new Error(`Spektrix plans API returned HTTP ${resp.status}`);
  }
  const raw = (await resp.json()) as Record<string, unknown>[];
  const map = new Map<string, { name: string; venueId: string }>();
  for (const p of raw) {
    const venue = p.venue as Record<string, unknown> | undefined;
    map.set(p.id as string, {
      name: (p.name as string) || "",
      venueId: venue?.id as string,
    });
  }
  return map;
}

// Build the booking URL for an instance using the Spektrix ChooseSeats.aspx pattern.
export function buildBookingUrl(
  config: SpektrixConfig,
  eventInstanceId: string
): string {
  return `${config.baseUrl}/${config.client}/website/ChooseSeats.aspx?resize=true&EventInstanceId=${eventInstanceId}`;
}

// Parse the start time from an instance. The Spektrix API provides both
// `start` (local wall-clock) and `startUtc` (UTC). We prefer `startUtc`
// but fall back to parsing `start` as a local time.
export function parseStartTime(instance: SpektrixInstance): string | null {
  if (instance.startUtc) {
    // Spektrix startUtc may or may not have a "Z" suffix.
    const iso = instance.startUtc.endsWith("Z")
      ? instance.startUtc
      : instance.startUtc + "Z";
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (instance.start) {
    const d = new Date(instance.start);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// Extract all attribute_ prefixed fields from a Spektrix object.
function extractAttributes(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("attribute_")) {
      attrs[k] = v;
    }
  }
  return attrs;
}

// Extract accessibility and event labels from instance attributes.
// Returns an array of short label strings like ["AD", "HOH", "Relaxed"].
export function extractLabels(
  instance: SpektrixInstance,
  event?: SpektrixEvent
): string[] {
  const labels: string[] = [];
  const instAttrs = instance.attributes;
  const evtAttrs = event?.attributes || {};

  // Boolean accessibility attributes
  if (instAttrs.attribute_AudioDescribed === true) labels.push("AD");
  if (instAttrs.attribute_BSL === true || instAttrs.attribute_BSLInterpreted === true)
    labels.push("BSL");
  if (instAttrs.attribute_Captioned === true) labels.push("Captioned");
  if (instAttrs.attribute_Relaxed === true) labels.push("Relaxed");
  if (instAttrs.attribute_TouchTour === true) labels.push("Touch Tour");
  if (instAttrs.attribute_Preview === true) labels.push("Preview");

  // String-based accessibility attributes
  const access = instAttrs.attribute_Access as string | undefined;
  if (access && access.trim()) labels.push(access.trim());

  // Subtitled
  if (instAttrs.attribute_SubtitledInEnglish === true) labels.push("Subtitled");

  // Instance type (e.g. "Screening", "Q&A", "Parent and Baby")
  const instType = instAttrs.attribute_InstanceType as string | undefined;
  if (instType && instType.trim()) labels.push(instType.trim());

  // Event-level attributes
  const eventType = evtAttrs.attribute_EventType as string | undefined;
  if (eventType && /relaxed/i.test(eventType)) labels.push("Relaxed");

  // Format from event name or attributes
  const format = evtAttrs.attribute_Format as string | undefined;
  if (format && format.trim()) labels.push(format.trim());

  // Ticket text
  const ticketText = instAttrs.attribute_TicketText1 as string | undefined;
  if (ticketText && ticketText.trim()) labels.push(ticketText.trim());

  // Deduplicate
  return [...new Set(labels)];
}

// Extract format string (e.g. "35mm", "70mm") from labels or event name.
export function extractFormat(
  instance: SpektrixInstance,
  event: SpektrixEvent,
  labels: string[]
): string | null {
  // Check labels for format indicators
  for (const l of labels) {
    if (/^(35mm|70mm|4k|3d|2d|digital|dcp)$/i.test(l)) return l;
  }
  // Check event name for format indicators
  const name = event.name || "";
  const fmtMatch = name.match(/\b(35mm|70mm|4K|3D|2D)\b/i);
  if (fmtMatch) return fmtMatch[1].toUpperCase();
  // Check event attributes
  const format = event.attributes.attribute_Format as string | undefined;
  if (format && format.trim()) return format.trim();
  return null;
}

// Determine sold-out status from instance attributes.
export function isSoldOut(instance: SpektrixInstance): boolean {
  if (instance.cancelled) return true;
  // If isOnSale is false and the instance hasn't started yet, it's likely sold out
  // or off-sale. We only mark as sold out if the instance is in the future.
  if (!instance.isOnSale) {
    const start = parseStartTime(instance);
    if (start && new Date(start).getTime() > Date.now()) return true;
  }
  return false;
}

// Build a complete ParsedScreening from an event + instance.
export function buildScreening(
  config: SpektrixConfig,
  event: SpektrixEvent,
  instance: SpektrixInstance,
  planMap: Map<string, { name: string; venueId: string }>,
  venueMap: Map<string, string>
): ParsedScreening | null {
  const startTime = parseStartTime(instance);
  if (!startTime) return null;

  const eventInstanceId = instance.id;
  if (!eventInstanceId) return null;

  const labels = extractLabels(instance, event);
  const format = extractFormat(instance, event, labels);

  // Get screen/venue info from plan
  const plan = planMap.get(instance.planId);
  const screenName = plan?.name || null;
  const venueName = plan ? venueMap.get(plan.venueId) || null : null;

  return {
    movie_title: event.name.trim(),
    start_time_iso: startTime,
    event_instance_id: eventInstanceId,
    booking_url: buildBookingUrl(config, eventInstanceId),
    plan_id: instance.planId,
    venue_name: venueName,
    screen_name: screenName,
    format,
    labels,
    sold_out: isSoldOut(instance),
    source_reference: `${config.sourcePrefix}:spektrix:${eventInstanceId}`,
  };
}

// Fetch all events, filter to cinema events, fetch instances for each,
// and build ParsedScreening objects. The cinemaFilter function is
// provided by each cinema-specific importer.
export async function fetchAllScreenings(
  config: SpektrixConfig,
  cinemaFilter: (event: SpektrixEvent) => boolean,
  options?: {
    // Only include instances after this date
    fromDate?: Date;
    // Max events to fetch (for testing)
    maxEvents?: number;
  }
): Promise<{
  screenings: ParsedScreening[];
  eventsCount: number;
  cinemaEventsCount: number;
  instancesFetched: number;
  errors: string[];
}> {
  const errors: string[] = [];

  // 1. Fetch all events
  const events = await fetchEvents(config);
  console.log(
    `[spektrix] ${config.client}: fetched ${events.length} events`
  );

  // 2. Filter to cinema events
  const cinemaEvents = events.filter(cinemaFilter);
  console.log(
    `[spektrix] ${config.client}: ${cinemaEvents.length} cinema events after filter`
  );

  if (options?.maxEvents) {
    cinemaEvents.length = options.maxEvents;
  }

  // 3. Fetch venues and plans for screen/venue lookup
  const venues = await fetchVenues(config);
  const venueMap = new Map<string, string>();
  for (const v of venues) {
    venueMap.set(v.id, v.name);
  }

  const planMap = await fetchPlanMap(config);

  // 4. Fetch instances for each cinema event and build screenings
  const screenings: ParsedScreening[] = [];
  let instancesFetched = 0;

  for (const event of cinemaEvents) {
    try {
      const instances = await fetchInstances(config, event.id);
      instancesFetched += instances.length;

      for (const instance of instances) {
        // Skip cancelled instances
        if (instance.cancelled) continue;

        // Skip past instances
        if (options?.fromDate) {
          const start = parseStartTime(instance);
          if (start && new Date(start).getTime() < options.fromDate.getTime()) {
            continue;
          }
        }

        const screening = buildScreening(
          config,
          event,
          instance,
          planMap,
          venueMap
        );
        if (screening) screenings.push(screening);
      }

      // Be gentle between events
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      const msg = `Event ${event.id} (${event.name}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.warn(`[spektrix] ${msg}`);
    }
  }

  return {
    screenings,
    eventsCount: events.length,
    cinemaEventsCount: cinemaEvents.length,
    instancesFetched,
    errors,
  };
}
