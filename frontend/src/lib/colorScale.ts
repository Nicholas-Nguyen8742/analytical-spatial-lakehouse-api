/**
 * Colour and elevation encoding for the choropleth.
 *
 * Quantile breaks rather than equal-width bins: `building_count` is heavily skewed
 * (measured p50 ~200 against a max of ~2,500 on the full dataset), so equal-width bins
 * would put nearly every tract in the first bucket and the map would read as one flat
 * colour. Quantiles guarantee each bucket holds roughly the same number of tracts.
 */

export type RGBA = readonly [number, number, number, number];

/** Dark-to-bright sequential ramp, chosen to stay legible on a dark basemap. */
export const RAMP: readonly RGBA[] = [
  [15, 25, 45, 190],
  [30, 85, 130, 205],
  [24, 145, 145, 215],
  [110, 195, 110, 225],
  [240, 240, 130, 235],
];

/** Metres of extrusion given to the densest tract. */
export const MAX_ELEVATION_M = 900;

/**
 * Cut points dividing `values` into `RAMP.length` equal-population buckets.
 *
 * Returns at most `RAMP.length - 1` ascending values, de-duplicated: skewed data can
 * produce identical adjacent quantiles, and leaving them in would create a bucket that
 * no value can ever fall into.
 */
export function quantileBreaks(
  values: readonly number[],
  steps: number = RAMP.length,
): number[] {
  if (steps < 2 || values.length === 0) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  // No spread means nothing to encode. One bucket labelled "all" is the honest
  // rendering, and any break we returned here would be unreachable.
  if (min === max) return [];

  const unique: number[] = [];

  for (let i = 1; i < steps; i += 1) {
    // Linear interpolation between order statistics, matching numpy's default method.
    const position = (i / steps) * (sorted.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    const value = sorted[low] + (sorted[high] - sorted[low]) * (position - low);

    // Keep only breaks that can actually separate two values. Skewed data piles several
    // quantiles onto min or onto each other; leaving those in renders legend rows no
    // tract can ever fall into.
    if (value <= min || value >= max) continue;

    const last = unique[unique.length - 1];
    if (unique.length === 0 || value > last) unique.push(value);
  }

  return unique;
}

/** Which ramp entry a value falls into, in `[0, RAMP.length - 1]`. */
export function bucketIndex(value: number, breaks: readonly number[]): number {
  let bucket = 0;
  for (const cut of breaks) {
    if (value > cut) bucket += 1;
  }
  return Math.min(bucket, RAMP.length - 1);
}

export function colorForValue(value: number, breaks: readonly number[]): RGBA {
  return RAMP[bucketIndex(value, breaks)];
}

/**
 * Extrusion height in metres, linear in density and normalised to the current view.
 *
 * Normalising per-view rather than against a fixed global maximum keeps small viewports
 * readable: zoomed into one neighbourhood, the tallest tract there still stands out.
 */
export function elevationFor(count: number, maxCount: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(maxCount) || maxCount <= 0)
    return 0;
  return Math.max(0, Math.min(count / maxCount, 1)) * MAX_ELEVATION_M;
}

/** Human-readable bounds for each ramp bucket, for the legend. */
export function bucketLabels(
  breaks: readonly number[],
  format: (n: number) => string = (n) => Math.round(n).toLocaleString(),
): string[] {
  const edges = [null, ...breaks, null];
  const labels: string[] = [];

  for (let i = 0; i < edges.length - 1; i += 1) {
    const low = edges[i];
    const high = edges[i + 1];
    // Nested rather than `low === null && high === null` first: TypeScript only narrows
    // `high` to `number` when the null cases are discriminated one variable at a time.
    if (low === null) {
      labels.push(high === null ? "all" : `< ${format(high)}`);
    } else if (high === null) {
      labels.push(`≥ ${format(low)}`);
    } else {
      labels.push(`${format(low)} – ${format(high)}`);
    }
  }

  return labels;
}
