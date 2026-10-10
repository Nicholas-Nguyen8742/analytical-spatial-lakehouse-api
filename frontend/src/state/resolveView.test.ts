import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import type { TractFeature, TractResult } from '../api/types';
import { describeError, resolveTractView } from './resolveView';

function feature(geoid: string, count: number): TractFeature {
  return {
    type: 'Feature',
    id: geoid,
    properties: { geoid, building_count: count, avg_height_m: 10, p95_height_m: 20 },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  };
}

function result(...features: TractFeature[]): TractResult {
  return {
    collection: { type: 'FeatureCollection', features },
    meta: { queryTimeMs: 1, featureCount: features.length, requestId: 'abc' },
  };
}

describe('resolveTractView', () => {
  const retry = vi.fn();

  it('puts error first, even when stale data is still on screen', () => {
    const error = new ApiError('boom', { status: 503 });

    const view = resolveTractView(
      { error, isPending: false, data: result(feature('t1', 5)) },
      retry,
    );

    expect(view.kind).toBe('error');
    if (view.kind !== 'error') throw new Error('unreachable');
    expect(view.error).toBe(error);
    expect(view.retry).toBe(retry);
  });

  it('shows loading on first fetch, when there is nothing to display', () => {
    expect(resolveTractView({ error: null, isPending: true, data: undefined }, retry).kind).toBe(
      'loading',
    );
  });

  it('does NOT show loading during a refetch that still has data', () => {
    // The golden rule. With keepPreviousData this is the viewport-change case, and a
    // spinner here is exactly the flash the pattern exists to prevent.
    const view = resolveTractView(
      { error: null, isPending: true, data: result(feature('t1', 5)) },
      retry,
    );

    expect(view.kind).toBe('ready');
  });

  it('reports empty for a successful query that matched nothing', () => {
    const view = resolveTractView({ error: null, isPending: false, data: result() }, retry);

    expect(view.kind).toBe('empty');
  });

  it('returns ready with the payload when features exist', () => {
    const data = result(feature('t1', 5), feature('t2', 9));

    const view = resolveTractView({ error: null, isPending: false, data }, retry);

    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') throw new Error('unreachable');
    expect(view.result).toBe(data);
  });

  it('falls back to loading rather than empty when not pending and unpopulated', () => {
    // Defensive: must never render "no results" for a query that has not resolved.
    expect(resolveTractView({ error: null, isPending: false, data: undefined }, retry).kind).toBe(
      'loading',
    );
  });
});

describe('describeError', () => {
  it('treats a status-0 failure as the API being unreachable', () => {
    const copy = describeError(new ApiError('Cannot reach the API', { status: 0 }));

    expect(copy.title).toMatch(/cannot reach/i);
    expect(copy.canRetry).toBe(true);
    expect(copy.hint).toMatch(/VITE_API_BASE_URL/);
  });

  it('explains a 503 as a failed spatial query', () => {
    const copy = describeError(new ApiError('API returned 503: Spatial query failed', { status: 503 }));

    expect(copy.title).toMatch(/spatial query failed/i);
    expect(copy.canRetry).toBe(true);
  });

  it('marks 4xx as not retryable, because retrying would fail identically', () => {
    const copy = describeError(new ApiError('API returned 422: invalid bbox', { status: 422 }));

    expect(copy.canRetry).toBe(false);
  });

  it('treats 500 and 429 as retryable', () => {
    expect(describeError(new ApiError('x', { status: 500 })).canRetry).toBe(true);
    expect(describeError(new ApiError('x', { status: 429 })).canRetry).toBe(true);
  });

  it('recognises an aborted request', () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';

    expect(describeError(aborted).title).toMatch(/cancelled/i);
  });

  it('degrades gracefully for a non-Error value', () => {
    const copy = describeError('a string was thrown');

    expect(copy.title).toBe('Something went wrong');
    expect(copy.detail).toBe('a string was thrown');
    expect(copy.canRetry).toBe(true);
  });
});
