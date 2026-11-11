import assert from "node:assert/strict";
import { test } from "node:test";
import { TIER_ORDER, tierName } from "../src/contracts.ts";

test("TIER_ORDER runs from light to heavy", () => {
  assert.deepEqual([...TIER_ORDER], ["light", "medium", "heavy"]);
});

test("tierName reads the Indonesian aliases as their tiers and leaves any other name alone", () => {
  assert.deepEqual(["ringan", "sedang", "berat"].map(tierName), [...TIER_ORDER]);
  assert.deepEqual([...TIER_ORDER, "mega", "constructor", ""].map(tierName), [...TIER_ORDER, "mega", "constructor", ""]);
});
