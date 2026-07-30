import { londonDateKey } from "./time.js";

export const DEFAULT_DATE_TIME_FILTER = Object.freeze({
  datePreset: "all",
  customDate: "",
  timeFrom: "",
  timeTo: "",
});

const VALID_DATE_PRESETS = new Set([
  "all",
  "today",
  "tomorrow",
  "weekend",
  "next7",
  "custom",
]);

const londonTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
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

function isTimeValue(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function timeValueToMinutes(value) {
  if (!isTimeValue(value)) {
    return null;
  }

  const [hour, minute] = value.split(":").map(Number);

  return hour * 60 + minute;
}

function londonTimeInMinutes(isoTimestamp) {
  const date = new Date(isoTimestamp);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = londonTimeFormatter.formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour");
  const minutePart = parts.find((part) => part.type === "minute");
  const hour = Number(hourPart?.value);
  const minute = Number(minutePart?.value);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  return (hour % 24) * 60 + minute;
}

export function normaliseDateTimeFilter(value) {
  const datePreset = VALID_DATE_PRESETS.has(value?.datePreset)
    ? value.datePreset
    : DEFAULT_DATE_TIME_FILTER.datePreset;

  const customDate =
    typeof value?.customDate === "string" && isDateKey(value.customDate)
      ? value.customDate
      : "";

  const timeFrom =
    typeof value?.timeFrom === "string" && isTimeValue(value.timeFrom)
      ? value.timeFrom
      : "";

  const timeTo =
    typeof value?.timeTo === "string" && isTimeValue(value.timeTo)
      ? value.timeTo
      : "";

  return {
    datePreset,
    customDate,
    timeFrom,
    timeTo,
  };
}

export function isDefaultDateTimeFilter(value) {
  const filter = normaliseDateTimeFilter(value);

  return (
    filter.datePreset === "all" &&
    !filter.timeFrom &&
    !filter.timeTo
  );
}

export function isValidDateTimeFilter(value) {
  const filter = normaliseDateTimeFilter(value);

  if (filter.datePreset === "custom" && !filter.customDate) {
    return false;
  }

  if (filter.timeFrom && filter.timeTo) {
    return filter.timeFrom <= filter.timeTo;
  }

  return true;
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

    if (!filter.timeFrom && !filter.timeTo) {
      return true;
    }

    const screeningTime = londonTimeInMinutes(startTime);

    if (screeningTime === null) {
      return false;
    }

    const timeFrom = timeValueToMinutes(filter.timeFrom);
    const timeTo = timeValueToMinutes(filter.timeTo);

    if (timeFrom !== null && screeningTime < timeFrom) {
      return false;
    }

    if (timeTo !== null && screeningTime > timeTo) {
      return false;
    }

    return true;
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

  const dateLabel = dateLabels[filter.datePreset];
  let timeLabel = "";

  if (filter.timeFrom && filter.timeTo) {
    timeLabel = `${filter.timeFrom}–${filter.timeTo}`;
  } else if (filter.timeFrom) {
    timeLabel = `From ${filter.timeFrom}`;
  } else if (filter.timeTo) {
    timeLabel = `Until ${filter.timeTo}`;
  }

  if (!timeLabel) {
    return dateLabel;
  }

  if (filter.datePreset === "all") {
    return timeLabel;
  }

  return `${dateLabel} · ${timeLabel}`;
}