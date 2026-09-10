const EARTH_RADIUS_MILES = 3958.7613;
const DISTANCE_EPSILON = 1e-9;

export const DEFAULT_DISTANCE_FILTER = Object.freeze({
  origin: null,
  maxMiles: null,
  maxLabel: null,
});

export function hasValidCoordinates(value) {
  const latitude = Number(value?.latitude);
  const longitude = Number(value?.longitude);

  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function normaliseDistanceFilter(value = {}) {
  const origin = hasValidCoordinates(value.origin)
    ? {
        latitude: Number(value.origin.latitude),
        longitude: Number(value.origin.longitude),
        label:
          typeof value.origin.label === "string" && value.origin.label.trim()
            ? value.origin.label.trim()
            : "Chosen location",
        source: value.origin.source === "device" ? "device" : "address",
      }
    : null;
  const maxMiles = Number(value.maxMiles);

  if (!origin || !Number.isFinite(maxMiles) || maxMiles < 0) {
    return { ...DEFAULT_DISTANCE_FILTER };
  }

  return {
    origin,
    maxMiles,
    maxLabel:
      typeof value.maxLabel === "string" && value.maxLabel.trim()
        ? value.maxLabel.trim()
        : `${maxMiles.toFixed(1)} mi`,
  };
}

export function isDistanceFilterActive(value) {
  const normalised = normaliseDistanceFilter(value);
  return normalised.origin !== null && normalised.maxMiles !== null;
}

export function haversineMiles(from, to) {
  if (!hasValidCoordinates(from) || !hasValidCoordinates(to)) {
    return null;
  }

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitude1 = toRadians(Number(from.latitude));
  const latitude2 = toRadians(Number(to.latitude));
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = toRadians(
    Number(to.longitude) - Number(from.longitude)
  );

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_MILES * centralAngle;
}

function formatDistanceLabel(tenthsOfAMile) {
  if (tenthsOfAMile === 0) return "<0.1 mi";
  return `${(tenthsOfAMile / 10).toFixed(1)} mi`;
}

export function buildCinemaDistanceData(origin, cinemaNames, cinemaLocations) {
  const locationByName = new Map(
    (Array.isArray(cinemaLocations) ? cinemaLocations : []).map((location) => [
      location.name,
      location,
    ])
  );
  const distanceByCinema = new Map();
  const missingCinemaNames = [];
  const buckets = new Map();

  if (!hasValidCoordinates(origin)) {
    return { distanceByCinema, missingCinemaNames, options: [] };
  }

  for (const cinemaName of cinemaNames) {
    const distance = haversineMiles(origin, locationByName.get(cinemaName));

    if (distance === null) {
      missingCinemaNames.push(cinemaName);
      continue;
    }

    distanceByCinema.set(cinemaName, distance);
    const displayBucket = Math.round(distance * 10);
    const bucket = buckets.get(displayBucket) ?? [];
    bucket.push(distance);
    buckets.set(displayBucket, bucket);
  }

  const options = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([displayBucket, distances]) => ({
      label: formatDistanceLabel(displayBucket),
      // Use the furthest exact distance represented by the displayed value.
      // This prevents a rounded option from accidentally excluding a cinema
      // that appears to sit exactly on that boundary.
      thresholdMiles: Math.max(...distances),
    }));

  return { distanceByCinema, missingCinemaNames, options };
}

export function distanceIncludesCinema(distance, maxMiles) {
  return (
    Number.isFinite(distance) &&
    Number.isFinite(maxMiles) &&
    distance <= maxMiles + DISTANCE_EPSILON
  );
}
