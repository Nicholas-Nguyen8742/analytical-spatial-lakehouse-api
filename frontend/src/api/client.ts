/**
 * The single fetch boundary for the lakehouse API.
 *
 * Two deliberate choices:
 *
 * 1. **Parse, don't validate.** Wire JSON is turned into a trusted domain type here,
 *    so nothing downstream has to re-check that `properties.building_count` is a
 *    number. A malformed payload fails loudly at the edge with the offending path in
 *    the message, instead of producing `NaN` somewhere in a colour ramp.
 *
 * 2. **Every failure becomes an `ApiError`.** Network faults, timeouts, HTTP errors
 *    and malformed bodies all surface as one type carrying a `retryable` flag, so the
 *    UI can always render its error state and the retry policy has something to key on.
 */

import type {
  BBox,
  HealthResponse,
  JoinResponse,
  TractCollection,
  TractResult,
} from "./types";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Thrown for every API failure so callers never have to branch on error shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    // 0 means the request never completed (network down, CORS, DNS, timeout).
    this.status = options.status ?? 0;
    this.retryable =
      options.retryable ??
      (this.status === 0 || this.status >= 500 || this.status === 429);
  }
}

export function resolveBaseUrl(): string {
  // Already typed `string | undefined` by src/vite-env.d.ts; no assertion needed.
  const configured = import.meta.env.VITE_API_BASE_URL;
  return configured && configured.length > 0
    ? configured.replace(/\/+$/, "")
    : DEFAULT_BASE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(
      `Malformed response: ${path} must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ApiError(
      `Malformed response: ${path} must be a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function optionalHeaderNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function request(
  path: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;

  // Compose caller cancellation with a timeout so a hung backend cannot leave the UI
  // stuck in a loading state forever.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    timeoutMs,
  );
  const onCallerAbort = (): void => controller.abort();
  rest.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(`${resolveBaseUrl()}${path}`, {
      ...rest,
      signal: controller.signal,
    });
  } catch (cause) {
    const timedOut =
      controller.signal.reason instanceof Error &&
      controller.signal.reason.message === "timeout";
    throw new ApiError(
      timedOut
        ? `Request to ${path} timed out after ${timeoutMs}ms`
        : `Cannot reach the API at ${path}`,
      { status: 0, retryable: true, cause },
    );
  } finally {
    clearTimeout(timer);
    rest.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (!response.ok) {
    // FastAPI puts a human-readable reason in `detail`; surface it without leaking
    // anything else from the body.
    let detail = response.statusText;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.detail === "string")
        detail = body.detail;
    } catch {
      // A non-JSON error body is not itself an error; keep the status text.
    }
    throw new ApiError(`API returned ${response.status}: ${detail}`, {
      status: response.status,
    });
  }

  return response;
}

function parseCollection(raw: unknown): TractCollection {
  if (!isRecord(raw) || raw.type !== "FeatureCollection") {
    throw new ApiError(
      "Malformed response: expected a GeoJSON FeatureCollection",
    );
  }
  if (!Array.isArray(raw.features)) {
    throw new ApiError(
      "Malformed response: FeatureCollection.features must be an array",
    );
  }

  const features = raw.features.map((entry, index) => {
    const at = `features[${index}]`;
    if (!isRecord(entry) || entry.type !== "Feature") {
      throw new ApiError(`Malformed response: ${at} is not a Feature`);
    }
    if (!isRecord(entry.properties)) {
      throw new ApiError(`Malformed response: ${at}.properties is missing`);
    }
    const p = entry.properties;
    if (!isRecord(entry.geometry) || entry.geometry.type !== "Polygon") {
      throw new ApiError(
        `Malformed response: ${at}.geometry must be a Polygon`,
      );
    }
    if (!Array.isArray(entry.geometry.coordinates)) {
      throw new ApiError(
        `Malformed response: ${at}.geometry.coordinates must be an array`,
      );
    }

    return {
      type: "Feature" as const,
      id: requireString(entry.id, `${at}.id`),
      properties: {
        geoid: requireString(p.geoid, `${at}.properties.geoid`),
        building_count: requireNumber(
          p.building_count,
          `${at}.properties.building_count`,
        ),
        avg_height_m: requireNumber(
          p.avg_height_m,
          `${at}.properties.avg_height_m`,
        ),
        p95_height_m: requireNumber(
          p.p95_height_m,
          `${at}.properties.p95_height_m`,
        ),
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: entry.geometry
          .coordinates as TractCollection["features"][number]["geometry"]["coordinates"],
      },
    };
  });

  return { type: "FeatureCollection", features };
}

export interface FetchTractsOptions {
  readonly bbox?: BBox | null;
  readonly minCount?: number;
  readonly signal?: AbortSignal | null;
  readonly timeoutMs?: number;
}

export function formatBBox(bbox: BBox): string {
  return [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY]
    .map((n) => n.toFixed(6))
    .join(",");
}

export async function fetchTracts(
  options: FetchTractsOptions = {},
): Promise<TractResult> {
  const params = new URLSearchParams();
  if (options.bbox) params.set("bbox", formatBBox(options.bbox));
  if (options.minCount !== undefined && options.minCount > 0) {
    params.set("min_count", String(options.minCount));
  }
  const query = params.toString();

  // `RequestInit.signal` is `AbortSignal | null`; under exactOptionalPropertyTypes an
  // explicit `undefined` is not assignable to it, so normalise to null.
  const response = await request(`/api/tracts${query ? `?${query}` : ""}`, {
    signal: options.signal ?? null,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });

  return {
    collection: parseCollection(await response.json()),
    meta: {
      queryTimeMs: optionalHeaderNumber(response.headers, "X-Query-Time-Ms"),
      featureCount: optionalHeaderNumber(response.headers, "X-Feature-Count"),
      requestId: response.headers.get("X-Request-Id"),
    },
  };
}

export async function fetchJoin(
  bbox: BBox | undefined,
  signal?: AbortSignal,
): Promise<JoinResponse> {
  const query = bbox ? `?bbox=${formatBBox(bbox)}` : "";
  const response = await request(`/api/join${query}`, {
    signal: signal ?? null,
  });
  const raw: unknown = await response.json();

  if (!isRecord(raw))
    throw new ApiError("Malformed response: expected a join object");
  return {
    tracts_in_scope: requireNumber(raw.tracts_in_scope, "tracts_in_scope"),
    tracts_matched: requireNumber(raw.tracts_matched, "tracts_matched"),
    buildings_matched: requireNumber(
      raw.buildings_matched,
      "buildings_matched",
    ),
    truncated: raw.truncated === true,
    query_time_ms: requireNumber(raw.query_time_ms, "query_time_ms"),
    tracts: Array.isArray(raw.tracts)
      ? raw.tracts.map((entry, index) => {
          if (!isRecord(entry))
            throw new ApiError(`Malformed response: tracts[${index}]`);
          return {
            geoid: requireString(entry.geoid, `tracts[${index}].geoid`),
            building_count: requireNumber(
              entry.building_count,
              `tracts[${index}].building_count`,
            ),
            avg_height_m: requireNumber(
              entry.avg_height_m,
              `tracts[${index}].avg_height_m`,
            ),
          };
        })
      : [],
  };
}

export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const response = await request("/api/health", { signal: signal ?? null });
  const raw: unknown = await response.json();

  if (!isRecord(raw))
    throw new ApiError("Malformed response: expected a health object");
  return {
    status:
      raw.status === "ok"
        ? "ok"
        : (requireString(raw.status, "status") as "ok"),
    tract_count: requireNumber(raw.tract_count, "tract_count"),
    building_count: requireNumber(raw.building_count, "building_count"),
    max_building_count: requireNumber(
      raw.max_building_count,
      "max_building_count",
    ),
    duckdb_version: requireString(raw.duckdb_version, "duckdb_version"),
    spatial_version: requireString(raw.spatial_version, "spatial_version"),
    data_dir: requireString(raw.data_dir, "data_dir"),
  };
}
