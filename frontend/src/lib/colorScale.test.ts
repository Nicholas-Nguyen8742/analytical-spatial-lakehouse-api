import { describe, expect, it } from "vitest";

import {
  MAX_ELEVATION_M,
  RAMP,
  bucketIndex,
  bucketLabels,
  colorForValue,
  elevationFor,
  quantileBreaks,
} from "./colorScale";

describe("quantileBreaks", () => {
  it("splits a uniform range into equal-population buckets", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);

    const breaks = quantileBreaks(values, 5);

    expect(breaks).toHaveLength(4);
    expect(breaks).toEqual([...breaks].sort((a, b) => a - b));
    expect(breaks[0]).toBeCloseTo(20.8, 5);
    expect(breaks[3]).toBeCloseTo(80.2, 5);
  });

  it("de-duplicates breaks produced by heavily skewed data", () => {
    // 90 zeros then a tail: several quantiles coincide, and keeping them would create
    // buckets no value can ever land in.
    const values = [...Array.from({ length: 90 }, () => 0), 10, 20, 30, 40, 50];

    const breaks = quantileBreaks(values, 5);

    expect(new Set(breaks).size).toBe(breaks.length);
    expect(breaks.every((v, i) => i === 0 || v > breaks[i - 1])).toBe(true);
  });

  it("handles the degenerate inputs", () => {
    expect(quantileBreaks([], 5)).toEqual([]);
    expect(quantileBreaks([1, 2, 3], 1)).toEqual([]);
    expect(quantileBreaks([7, 7, 7], 5)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];

    quantileBreaks(values, 3);

    expect(values).toEqual([3, 1, 2]);
  });

  it("defaults to one fewer break than ramp entries", () => {
    const values = Array.from({ length: 50 }, (_, i) => i);

    expect(quantileBreaks(values)).toHaveLength(RAMP.length - 1);
  });
});

describe("bucketIndex", () => {
  const breaks = [10, 20, 30];

  it("puts values below every break in the first bucket", () => {
    expect(bucketIndex(0, breaks)).toBe(0);
    expect(bucketIndex(9.99, breaks)).toBe(0);
  });

  it("is exclusive at the lower edge of each break", () => {
    expect(bucketIndex(10, breaks)).toBe(0);
    expect(bucketIndex(10.01, breaks)).toBe(1);
    expect(bucketIndex(30.01, breaks)).toBe(3);
  });

  it("never exceeds the number of available buckets", () => {
    // Three breaks define four buckets, so the top index is 3 — not RAMP.length - 1.
    expect(bucketIndex(1e9, breaks)).toBe(breaks.length);
    expect(bucketIndex(1e9, [])).toBe(0);
  });

  it("clamps to the ramp when handed more breaks than colours", () => {
    const tooMany = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(bucketIndex(1e9, tooMany)).toBe(RAMP.length - 1);
  });
});

describe("colorForValue", () => {
  it("always returns a ramp colour", () => {
    const breaks = quantileBreaks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], RAMP.length);

    for (const value of [0, 1, 5, 10, 1e6]) {
      expect(RAMP).toContain(colorForValue(value, breaks));
    }
  });
});

describe("elevationFor", () => {
  it("maps the densest tract to the maximum extrusion", () => {
    expect(elevationFor(2500, 2500)).toBe(MAX_ELEVATION_M);
  });

  it("scales linearly", () => {
    expect(elevationFor(1250, 2500)).toBeCloseTo(MAX_ELEVATION_M / 2, 6);
  });

  it("returns zero for an empty view rather than NaN", () => {
    expect(elevationFor(5, 0)).toBe(0);
    expect(elevationFor(5, -1)).toBe(0);
  });

  it("guards against non-finite input from a malformed payload", () => {
    expect(elevationFor(Number.NaN, 100)).toBe(0);
    expect(elevationFor(50, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("clamps a count above the stated maximum", () => {
    expect(elevationFor(9999, 100)).toBe(MAX_ELEVATION_M);
  });
});

describe("bucketLabels", () => {
  it("produces one label per ramp entry", () => {
    const labels = bucketLabels([10, 20, 30, 40]);

    expect(labels).toHaveLength(RAMP.length);
    expect(labels[0]).toBe("< 10");
    expect(labels[1]).toBe("10 – 20");
    expect(labels[4]).toBe("≥ 40");
  });

  it("labels a single bucket as all", () => {
    expect(bucketLabels([])).toEqual(["all"]);
  });

  it("accepts a custom formatter", () => {
    expect(bucketLabels([1.5], (n) => n.toFixed(1))).toEqual([
      "< 1.5",
      "≥ 1.5",
    ]);
  });
});
