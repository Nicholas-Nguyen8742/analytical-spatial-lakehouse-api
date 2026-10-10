/**
 * Domain types for the lakehouse API contract.
 *
 * These mirror the Pydantic models in `backend/src/datalake/models.py`. The response
 * body is a strictly conformant GeoJSON FeatureCollection; server-side telemetry
 * arrives in headers, not in the body.
 */

/** Per-tract aggregate produced by the DuckDB spatial join. */
export interface TractProperties {
  readonly geoid: string;
  readonly building_count: number;
  readonly avg_height_m: number;
  readonly p95_height_m: number;
}

export interface PolygonGeometry {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

export interface TractFeature {
  readonly type: "Feature";
  readonly id: string;
  readonly properties: TractProperties;
  readonly geometry: PolygonGeometry;
}

export interface TractCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly TractFeature[];
}

/** An axis-aligned viewport in lon/lat degrees. */
export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Server-reported telemetry, read from response headers. */
export interface QueryMeta {
  readonly queryTimeMs: number | null;
  readonly featureCount: number | null;
  readonly requestId: string | null;
}

export interface TractResult {
  readonly collection: TractCollection;
  readonly meta: QueryMeta;
}

/** Result of the on-demand exact spatial join. */
export interface JoinResponse {
  readonly tracts_in_scope: number;
  readonly tracts_matched: number;
  readonly buildings_matched: number;
  readonly truncated: boolean;
  readonly query_time_ms: number;
  readonly tracts: readonly {
    readonly geoid: string;
    readonly building_count: number;
    readonly avg_height_m: number;
  }[];
}

export interface HealthResponse {
  readonly status: "ok";
  readonly tract_count: number;
  readonly building_count: number;
  /** Densest tract in the whole lake; bounds the client's density filter. */
  readonly max_building_count: number;
  readonly duckdb_version: string;
  readonly spatial_version: string;
  readonly data_dir: string;
}
