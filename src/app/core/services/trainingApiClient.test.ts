import { describe, expect, it } from "vitest";
import { emptyListCooldown } from "./trainingApiClient";

describe("emptyListCooldown", () => {
  it("dedupes identical empty list reads within the cooldown window", () => {
    const key = emptyListCooldown.buildKey("metrics/batches", "job-1", "limit=50");
    const t0 = 1000;
    emptyListCooldown.clear(key);

    expect(emptyListCooldown.shouldSkip(key, t0)).toBe(false);

    emptyListCooldown.recordEmpty(key, t0);

    expect(emptyListCooldown.shouldSkip(key, t0 + 1)).toBe(true);
    expect(emptyListCooldown.shouldSkip(key, t0 + 1499)).toBe(true);
    expect(emptyListCooldown.shouldSkip(key, t0 + 1500)).toBe(false);

    emptyListCooldown.clear(key);
    expect(emptyListCooldown.shouldSkip(key, t0 + 1)).toBe(false);
  });
});
