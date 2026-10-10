import { MapboxOverlay } from '@deck.gl/mapbox';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';

import type { BBox, TractFeature } from '../api/types';
import { useLatest } from '../hooks/useLatest';
import { INITIAL_VIEW, MAP_STYLE } from '../map/config';
import { buildTractLayers, type HoverInfo } from '../map/layers';

// Omitting this leaves the map unstyled and looks like a rendering bug rather than a
// missing stylesheet.
import 'maplibre-gl/dist/maplibre-gl.css';

export interface MapViewProps {
  readonly features: readonly TractFeature[];
  readonly breaks: readonly number[];
  readonly onHover: (info: HoverInfo | null) => void;
  readonly onViewChange: (bbox: BBox) => void;
  /** Increment to fly back to the initial view. */
  readonly resetToken: number;
}

/**
 * MapLibre basemap with deck.gl composited on top.
 *
 * Uses `MapboxOverlay` as a map control rather than `react-map-gl`. deck.gl 9 and
 * react-map-gl 8 have a history of peer-range skew, and MapLibre's map object is
 * API-compatible with what the overlay expects — so this removes a dependency and a
 * whole class of version-conflict bugs at the cost of one imperative effect.
 *
 * The map is created exactly once. Callbacks are read through refs so a parent re-render
 * can never tear down and rebuild the WebGL context.
 */
export function MapView({ features, breaks, onHover, onViewChange, resetToken }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const skippedFirstReset = useRef(false);

  const onHoverRef = useLatest(onHover);
  const onViewChangeRef = useLatest(onViewChange);

  const maxCount = useMemo(
    () => features.reduce((max, f) => Math.max(max, f.properties.building_count), 0),
    [features],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const map = new MapLibreMap({
      container,
      style: MAP_STYLE,
      center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
      zoom: INITIAL_VIEW.zoom,
      pitch: INITIAL_VIEW.pitch,
      bearing: INITIAL_VIEW.bearing,
      attributionControl: { compact: true },
    });

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);

    map.on('moveend', () => {
      const bounds = map.getBounds();
      onViewChangeRef.current({
        minX: bounds.getWest(),
        minY: bounds.getSouth(),
        maxX: bounds.getEast(),
        maxY: bounds.getNorth(),
      });
    });

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, [onViewChangeRef]);

  useEffect(() => {
    overlayRef.current?.setProps({
      layers: buildTractLayers(features, breaks, maxCount, {
        onHover: (info) => onHoverRef.current(info),
      }),
    });
  }, [features, breaks, maxCount, onHoverRef]);

  useEffect(() => {
    // The map already opens on INITIAL_VIEW; only later token changes should fly.
    if (!skippedFirstReset.current) {
      skippedFirstReset.current = true;
      return;
    }
    mapRef.current?.flyTo({
      center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
      zoom: INITIAL_VIEW.zoom,
      pitch: INITIAL_VIEW.pitch,
      bearing: INITIAL_VIEW.bearing,
    });
  }, [resetToken]);

  return <div className="map" ref={containerRef} data-testid="map-canvas" />;
}
