// Europe/London helpers using Intl. All formatting is done in the browser's
// locale (en-GB) but pinned to the Europe/London timezone so times match what
// is on the cinema's website.

const TZ = "Europe/London";

function getLondonNow() {
  // Wall-clock "now" in Europe/London as a plain object.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10) % 24,
    minute: parseInt(get("minute"), 10),
  };
}

// Returns the London calendar date (YYYY-MM-DD) of an ISO timestamp.
export function londonDateKey(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// "18:35" — 24-hour, tabular-friendly.
export function londonTime(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

// Date heading for a group: "Today", "Tomorrow", or "Tuesday 21 July".
export function londonDateHeading(iso) {
  const now = getLondonNow();
  const key = londonDateKey(iso);
  const todayKey = `${now.year}-${String(now.month).padStart(2, "0")}-${String(
    now.day
  ).padStart(2, "0")}`;

  // Tomorrow key: add one day to today's date (in London).
  const tomorrowDate = new Date(Date.UTC(now.year, now.month - 1, now.day + 1));
  const tomorrowKey = `${tomorrowDate.getUTCFullYear()}-${String(
    tomorrowDate.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(tomorrowDate.getUTCDate()).padStart(2, "0")}`;

  if (key === todayKey) return "Today";
  if (key === tomorrowKey) return "Tomorrow";

  const d = new Date(iso);
  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "long",
  }).format(d);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "numeric",
  }).format(d);
  const month = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    month: "long",
  }).format(d);
  return `${weekday} ${day} ${month}`;
}

export function isToday(iso) {
  const now = getLondonNow();
  const key = londonDateKey(iso);
  const todayKey = `${now.year}-${String(now.month).padStart(2, "0")}-${String(
    now.day
  ).padStart(2, "0")}`;
  return key === todayKey;
}
