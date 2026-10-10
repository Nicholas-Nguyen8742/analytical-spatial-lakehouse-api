/**
 * deck.gl layer construction.
 *
 * Kept out of the component so the encoding (colour ramp, extrusion, picking) is a pure
 * function of the data and can be reasoned about without a WebGL context.
 */

import { GeoJsonLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';

import type { TractFeature } from '../api/types';
import { colorForValue, elevationFor } from '../lib/colorScale';

export interface HoverInfo {
  /** Pointer position in viewport pixels, for placing the tooltip. */
  readonly x: number;
  readonly y: number;
  readonly feature: TractFeature;
}

export interface LayerCallbacks {
  readonly onHover: (info: HoverInfo | null) => void;
}

function toCollection(features: readonly TractFeature[]): GeoJSON.FeatureCollection {
  // deck.gl wants a mutable GeoJSON object; the cast is confined to this one boundary
  // so the rest of the app keeps its readonly domain types.
  return {
    type: 'FeatureCollection',
    features: features as unknown as GeoJSON.Feature[],
  };
}

export function buildTractLayers(
  features: readonly TractFeature[],
  breaks: readonly number[],
  maxCount: number,
  callbacks: LayerCallbacks,
): GeoJsonLayer[] {
  return [
    new GeoJsonLayer({
      id: 'tracts',
      data: toCollection(features),
      filled: true,
      stroked: true,
      extruded: true,
      pickable: true,
      lineWidthMinPixels: 0.5,
      getLineColor: [12, 16, 26, 140],
      getFillColor: (feature: unknown) => {
        const tract = feature as TractFeature;
        return colorForValue(tract.properties.building_count, breaks);
      },
      getElevation: (feature: unknown) => {
        const tract = feature as TractFeature;
        return elevationFor(tract.properties.building_count, maxCount);
      },
      elevationScale: 1,
      // Transitions make a viewport change read as movement rather than a jump.
      updateTriggers: {
        getFillColor: breaks,
        getElevation: maxCount,
      },
      transitions: { getElevation: 350, getFillColor: 350 },
      onHover: (info: PickingInfo) => {
        if (info.object === undefined || info.object === null) {
          callbacks.onHover(null);
          return;
        }
        callbacks.onHover({ x: info.x, y: info.y, feature: info.object as TractFeature });
      },
    }),
  ];
}
