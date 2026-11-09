import assert from "node:assert/strict";
import { test } from "node:test";
import { TIER_ORDER } from "../src/contracts.ts";

test("TIER_ORDER runs from light to heavy", () => {
  assert.deepEqual([...TIER_ORDER], ["ringan", "sedang", "berat"]);
});
