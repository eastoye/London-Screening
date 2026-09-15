import { strict as assert } from "node:assert";
import {
  bookingUrlForAvailability,
  filmTitleHint,
  screeningTags,
  structuredMetadata,
} from "./metadata.ts";
import type { LexiEvent, LexiPerformance } from "./import-common.ts";

const performance = (overrides: Partial<LexiPerformance> = {}): LexiPerformance => ({ ID: 1, ...overrides });
const event = (title: string, overrides: Partial<LexiEvent> = {}): LexiEvent => ({
  ID: 1,
  Title: title,
  TypeDescription: "Film",
  ...overrides,
});

assert.equal(filmTitleHint(event("Brazilian Summer Nights: The Best Mother In The World (UK Premiere)", {
  Seasons: [{ SeasonName: "Brazilian Summer Nights" }],
}), performance()), "The Best Mother In The World");
assert.equal(filmTitleHint(event("Japanese Film Club: Kamikaze Girls"), performance()), "Kamikaze Girls");
assert.equal(filmTitleHint(event("Spotlight: The Eternal Memory", {
  Seasons: [{ SeasonName: "Spotlight: Female Filmmakers" }],
}), performance()), "The Eternal Memory");
assert.equal(filmTitleHint(event("Lexi Seniors' Film Club: Disclosure Day + Q&A"), performance()), "Disclosure Day");
assert.equal(filmTitleHint(event("NT Live: The Misanthrope", { TypeDescription: "Theatre and Arts" }), performance()), null);

const family = structuredMetadata(event("Example"), performance({ FF: "Y", PR: "Y" }), "https://example.test");
assert.deepEqual(family.programmeTypeValues, []);
assert.ok(family.labels.includes("Preview"));
assert.ok(!family.labels.includes("Private"));
assert.deepEqual(screeningTags("Example", family.labels, performance({ FF: "Y" })), ["preview", "family_friendly"]);
assert.deepEqual(structuredMetadata(event("Example"), performance({ AS: "Y" }), "https://example.test").accessibilityFeatures, []);
assert.deepEqual(structuredMetadata(event("Example"), performance({ RS: "Y" }), "https://example.test").accessibilityFeatures, ["relaxed"]);
assert.deepEqual(structuredMetadata(event("Example"), performance({ HOH: "Y" }), "https://example.test").accessibilityFeatures, ["captioned"]);
assert.deepEqual(structuredMetadata(event("Example"), performance({ TP: "Y" }), "https://example.test").programmeTypeValues, ["seniors"]);
const correctedFlags = structuredMetadata(
  event("Example"),
  performance({ AS: "Y", OC: "Y", SL: "Y", PR: "Y", LS: "Y" }),
  "https://example.test",
);
assert.deepEqual(correctedFlags.labels, [
  "Accessible Screenings",
  "Oscars Contenders",
  "Spotlight",
  "Preview",
  "Lexi Selects",
]);
assert.equal(bookingUrlForAvailability("https://japanesefilm.club/example", true), null);
assert.equal(
  bookingUrlForAvailability("https://japanesefilm.club/example", false),
  "https://japanesefilm.club/example",
);
assert.equal(structuredMetadata(event("Example"), performance({ AuditoriumName: "Screen 1" }), "https://example.test").labels.includes("Screen 1"), false);
const mixedEvent = event("Example", {
  Seasons: [{ SeasonName: "Baby-Friendly Screenings" }, { SeasonName: "HOH Subtitled Screenings" }],
  Performances: [performance({ ID: 1, BF: "Y" }), performance({ ID: 2 })],
});
assert.deepEqual(structuredMetadata(mixedEvent, mixedEvent.Performances![1], "https://example.test").labels, []);
const qAndA = event("Example", {
  Seasons: [{ SeasonName: "Q&amp;As + Panels" }],
  Performances: [performance()],
});
assert.deepEqual(structuredMetadata(qAndA, qAndA.Performances![0], "https://example.test").labels, ["Q&As + Panels"]);

console.log("Lexi metadata tests passed");
