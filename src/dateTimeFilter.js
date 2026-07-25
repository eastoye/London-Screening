import { londonDateKey } from "./time.js";

export const DEFAULT_DATE_TIME_FILTER = Object.freeze({
  datePreset: "all",
  customDate: "",
  timePeriod: "any",
});

const VALID_DATE_PRESETS = new Set([
  "all",
  "today",
  "tomorrow",
  "weekend",
  "next7",
  "custom",
]);

const VALID_TIME_PERIODS = new Set([
  "any",
  "morning",
  "afternoon",
  "evening",
]);

const londonHourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  hourCycle: "h23",
});

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDaysToDateKey(dateKey, numberOfDays) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + numberOfDays));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function weekdayForDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function getWeekendRange(todayKey) {
  const weekday = weekdayForDateKey(todayKey);

  if (weekday === 6) {
    return {
      start: todayKey,
      end: addDaysToDateKey(todayKey, 1),
    };
  }

  if (weekday === 0) {
    return {
      start: todayKey,
      end: todayKey,
    };
  }

  const daysUntilSaturday = 6 - weekday;
  const saturday = addDaysToDateKey(todayKey, daysUntilSaturday);

  return {
    start: saturday,
    end: addDaysToDateKey(saturday, 1),
  };
}

function londonHour(isoTimestamp) {
  const parts = londonHourFormatter.formatToParts(new Date(isoTimestamp));
  const hourPart = parts.find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);

  return Number.isInteger(hour) ? hour % 24 : null;
}

export function normaliseDateTimeFilter(value) {
  const datePreset = VALID_DATE_PRESETS.has(value?.datePreset)
    ? value.datePreset
    : DEFAULT_DATE_TIME_FILTER.datePreset;

  const timePeriod = VALID_TIME_PERIODS.has(value?.timePeriod)
    ? value.timePeriod
    : DEFAULT_DATE_TIME_FILTER.timePeriod;

  const customDate =
    typeof value?.customDate === "string" && isDateKey(value.customDate)
      ? value.customDate
      : "";

  return {
    datePreset,
    customDate,
    timePeriod,
  };
}

export function isDefaultDateTimeFilter(value) {
  const filter = normaliseDateTimeFilter(value);

  return filter.datePreset === "all" && filter.timePeriod === "any";
}

export function isValidDateTimeFilter(value) {
  const filter = normaliseDateTimeFilter(value);

  return filter.datePreset !== "custom" || Boolean(filter.customDate);
}

export function getLondonTodayKey() {
  return londonDateKey(new Date());
}

export function createDateTimeMatcher(value, now = new Date()) {
  const filter = normaliseDateTimeFilter(value);
  const todayKey = londonDateKey(now);

  let exactDate = null;
  let rangeStart = null;
  let rangeEnd = null;

  switch (filter.datePreset) {
    case "today":
      exactDate = todayKey;
      break;

    case "tomorrow":
      exactDate = addDaysToDateKey(todayKey, 1);
      break;

    case "weekend": {
      const weekend = getWeekendRange(todayKey);
      rangeStart = weekend.start;
      rangeEnd = weekend.end;
      break;
    }

    case "next7":
      rangeStart = todayKey;
      rangeEnd = addDaysToDateKey(todayKey, 6);
      break;

    case "custom":
      exactDate = filter.customDate || null;
      break;

    default:
      break;
  }

  return (startTime) => {
    const screeningDate = londonDateKey(startTime);

    if (filter.datePreset === "custom" && !exactDate) {
      return false;
    }

    if (exactDate && screeningDate !== exactDate) {
      return false;
    }

    if (
      rangeStart &&
      rangeEnd &&
      (screeningDate < rangeStart || screeningDate > rangeEnd)
    ) {
      return false;
    }

    if (filter.timePeriod === "any") {
      return true;
    }

    const hour = londonHour(startTime);

    if (hour === null) {
      return false;
    }

    if (filter.timePeriod === "morning") {
      return hour < 12;
    }

    if (filter.timePeriod === "afternoon") {
      return hour >= 12 && hour < 18;
    }

    return hour >= 18;
  };
}

function customDateLabel(dateKey) {
  if (!isDateKey(dateKey)) {
    return "Custom date";
  }

  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function dateTimeFilterLabel(value) {
  const filter = normaliseDateTimeFilter(value);

  if (isDefaultDateTimeFilter(filter)) {
    return "All dates & times";
  }

  const dateLabels = {
    all: "Any date",
    today: "Today",
    tomorrow: "Tomorrow",
    weekend: "This weekend",
    next7: "Next 7 days",
    custom: customDateLabel(filter.customDate),
  };

  const timeLabels = {
    morning: "Morning",
    afternoon: "Afternoon",
    evening: "Evening",
  };

  const dateLabel = dateLabels[filter.datePreset];

  if (filter.timePeriod === "any") {
    return dateLabel;
  }

  return `${dateLabel} · ${timeLabels[filter.timePeriod]}`;
}