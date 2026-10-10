/** Static map configuration. */

/** CARTO dark matter via MapLibre — no API token or billing setup required. */
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/**
 * Module-level constant on purpose. Passing the initial view as a prop object would
 * give the map-creation effect a new dependency identity on every parent render and
 * tear down and rebuild the WebGL context each time.
 */
export const INITIAL_VIEW = {
  longitude: -122.44,
  latitude: 37.76,
  zoom: 10.6,
  pitch: 48,
  bearing: 0,
} as const;

/** Full extent of the generated lake, used for "reset view". */
export const DATA_EXTENT = {
  minX: -122.52,
  minY: 37.7,
  maxX: -122.36,
  maxY: 37.82,
} as const;
