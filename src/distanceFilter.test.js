import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCinemaDistanceData,
  distanceIncludesCinema,
  haversineMiles,
} from "./distanceFilter.js";

test("haversineMiles returns a realistic London distance", () => {
  const distance = haversineMiles(
    { latitude: 51.5114907, longitude: -0.1302137 },
    { latitude: 51.5067272, longitude: -0.1151999 }
  );

  assert.ok(distance > 0.6 && distance < 0.8);
});

test("dynamic options are ordered and merge duplicate displayed distances", () => {
  const origin = { latitude: 51.5, longitude: -0.1 };
  const cinemas = ["Near A", "Far", "Near B"];
  const locations = [
    { name: "Near A", latitude: 51.501, longitude: -0.1 },
    { name: "Near B", latitude: 51.5012, longitude: -0.1 },
    { name: "Far", latitude: 51.52, longitude: -0.1 },
  ];
  const data = buildCinemaDistanceData(origin, cinemas, locations);

  assert.equal(data.options.length, 2);
  assert.deepEqual(
    data.options.map((option) => option.label),
    ["0.1 mi", "1.4 mi"]
  );
});

test("a rounded boundary includes every cinema represented by that option", () => {
  const origin = { latitude: 51.5, longitude: -0.1 };
  const cinemas = ["A", "B"];
  const locations = [
    { name: "A", latitude: 51.5009, longitude: -0.1 },
    { name: "B", latitude: 51.5013, longitude: -0.1 },
  ];
  const data = buildCinemaDistanceData(origin, cinemas, locations);
  const option = data.options[0];

  assert.equal(option.label, "0.1 mi");
  assert.equal(
    distanceIncludesCinema(data.distanceByCinema.get("A"), option.thresholdMiles),
    true
  );
  assert.equal(
    distanceIncludesCinema(data.distanceByCinema.get("B"), option.thresholdMiles),
    true
  );
});

test("cinemas without coordinates are reported and never treated as nearby", () => {
  const data = buildCinemaDistanceData(
    { latitude: 51.5, longitude: -0.1 },
    ["Known", "Missing"],
    [{ name: "Known", latitude: 51.51, longitude: -0.1 }]
  );

  assert.deepEqual(data.missingCinemaNames, ["Missing"]);
  assert.equal(data.distanceByCinema.has("Missing"), false);
});
