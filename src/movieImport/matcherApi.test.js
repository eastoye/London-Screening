import assert from "node:assert/strict";
import test from "node:test";
import { matchImportRecords } from "./matcherApi.js";
import { deduplicateBeforeMatching } from "./model.js";
import { parseTextInput } from "./textParser.js";
test("one matcher supports films with rating conflicts without writing either destination", async () => {
  const records = deduplicateBeforeMatching(parseTextInput("Alien (1979), 8/10\nAlien (1979), 9/10"));
  const calls = [];
  const [result] = await matchImportRecords(records, { request: async (payload) => {
    calls.push(payload); return { results: [{ clientId: payload.records[0].clientId, status: "matched", match: { tmdbId: 348 } }] };
  } });
  assert.equal(result.ratingConflict, true); assert.equal(result.status, "matched"); assert.equal(result.selectedTmdbId, 348);
  assert.equal(calls[0].action, "match"); assert.equal(calls[0].records[0].rating, undefined);
});
test("identity-invalid rows stay invalid without contacting the matcher", async () => {
  const [record] = parseTextInput("Alien"); record.invalidReason = "Missing identity";
  const [result] = await matchImportRecords([record], { request() { throw new Error("must not request"); } });
  assert.equal(result.status, "invalid");
});
test("stops matching and suppresses responses after cancellation", async () => {
  let active = true;
  await assert.rejects(matchImportRecords(parseTextInput("Alien"), { isActive: () => active, request: async () => { active = false; return { results: [] }; } }), /cancelled/);
});
