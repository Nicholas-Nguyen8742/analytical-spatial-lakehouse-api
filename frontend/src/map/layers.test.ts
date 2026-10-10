import { describe, expect, it, vi } from 'vitest';

import type { TractFeature } from '../api/types';
import { MAX_ELEVATION_M, RAMP, colorForValue, elevationFor } from '../lib/colorScale';
import { buildTractLayers, type HoverInfo } from './layers';

function feature(geoid: string, count: number): TractFeature {
  return {
    type: 'Feature',
    id: geoid,
    properties: { geoid, building_count: count, avg_height_m: 12, p95_height_m: 30 },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  };
}

/** Accessors are declared as `value | function`; these tests always pass functions. */
function accessor<A extends unknown[], R>(value: unknown): (...args: A) => R {
  if (typeof value !== 'function') throw new Error('expected a function accessor');
  return value as (...args: A) => R;
}

function propsOf(features: readonly TractFeature[], breaks: readonly number[], maxCount: number, onHover: (i: HoverInfo | null) => void) {
  const [layer] = buildTractLayers(features, breaks, maxCount, { onHover });
  return layer.props;
}

describe('buildTractLayers', () => {
  it('returns a single stable, pickable, extruded polygon layer', () => {
    const layers = buildTractLayers([], [], 0, { onHover: vi.fn() });

    expect(layers).toHaveLength(1);
    // deck.gl reconciles layers by id; changing it would rebuild the layer each render.
    expect(layers[0].id).toBe('tracts');
    expect(layers[0].props.pickable).toBe(true);
    expect(layers[0].props.extruded).toBe(true);
    expect(layers[0].props.filled).toBe(true);
  });

  it('passes the features through as a GeoJSON FeatureCollection', () => {
    const features = [feature('a', 1), feature('b', 2)];

    const data = propsOf(features, [], 2, vi.fn()).data as GeoJSON.FeatureCollection;

    expect(data.type).toBe('FeatureCollection');
    expect(data.features).toHaveLength(2);
  });

  it('encodes fill colour from building_count through the quantile ramp', () => {
    const features = [feature('sparse', 10), feature('dense', 900)];
    const breaks = [100, 300, 500, 700];
    const getFillColor = accessor<[TractFeature], readonly number[]>(
      propsOf(features, breaks, 900, vi.fn()).getFillColor,
    );

    expect(getFillColor(features[0])).toEqual(colorForValue(10, breaks));
    expect(getFillColor(features[1])).toEqual(colorForValue(900, breaks));
    expect(RAMP).toContain(getFillColor(features[1]));
  });

  it('encodes elevation from building_count normalised to the view maximum', () => {
    const features = [feature('half', 450), feature('full', 900)];
    const getElevation = accessor<[TractFeature], number>(
      propsOf(features, [], 900, vi.fn()).getElevation,
    );

    expect(getElevation(features[1])).toBe(MAX_ELEVATION_M);
    expect(getElevation(features[0])).toBeCloseTo(elevationFor(450, 900), 6);
  });

  it('does not divide by zero on an empty view', () => {
    const getElevation = accessor<[TractFeature], number>(propsOf([], [], 0, vi.fn()).getElevation);

    expect(getElevation(feature('x', 5))).toBe(0);
  });

  it('declares update triggers so colours re-evaluate when breaks change', () => {
    const breaks = [100, 200];
    const props = propsOf([], breaks, 5, vi.fn());

    expect(props.updateTriggers).toMatchObject({ getFillColor: breaks, getElevation: 5 });
  });

  it('maps a deck.gl pick onto the hovered tract', () => {
    const onHover = vi.fn();
    const picked = feature('tract_42', 77);
    const props = propsOf([picked], [], 77, onHover);

    accessor<[{ object: TractFeature; x: number; y: number }], void>(props.onHover)({
      object: picked,
      x: 120,
      y: 340,
    });

    expect(onHover).toHaveBeenCalledWith({ x: 120, y: 340, feature: picked });
  });

  it('clears the tooltip when the pointer leaves every tract', () => {
    const onHover = vi.fn();
    const props = propsOf([], [], 0, onHover);

    accessor<[{ object: null; x: number; y: number }], void>(props.onHover)({
      object: null,
      x: 10,
      y: 10,
    });

    expect(onHover).toHaveBeenCalledWith(null);
  });
});
