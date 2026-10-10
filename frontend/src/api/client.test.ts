import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  ApiError,
  fetchHealth,
  fetchJoin,
  fetchTracts,
  formatBBox,
} from "./client";
import { fetchUrl } from "../test/fetchUrl";

type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const BBOX = { minX: -122.5, minY: 37.7, maxX: -122.4, maxY: 37.8 };

const VALID_BODY = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "tract_1",
      properties: {
        geoid: "tract_1",
        building_count: 5,
        avg_height_m: 1.5,
        p95_height_m: 2.5,
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fetchMock(): Mock<FetchImpl> {
  return fetch as unknown as Mock<FetchImpl>;
}

/**
 * Await a promise expected to reject, and return the error narrowed to `ApiError`.
 *
 * `.catch(e => e as ApiError)` would type the result as `TractResult | ApiError`, and it
 * silently passes if the promise resolves. This fails the test in that case instead.
 */
async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the request to reject, but it resolved");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatBBox", () => {
  it("emits minx,miny,maxx,maxy at fixed precision", () => {
    expect(formatBBox(BBOX)).toBe(
      "-122.500000,37.700000,-122.400000,37.800000",
    );
  });
});

describe("fetchTracts request building", () => {
  it("queries the bare path when no filters are given", async () => {
    fetchMock().mockResolvedValue(jsonResponse(VALID_BODY));

    await fetchTracts();

    expect(fetchUrl(fetchMock().mock.calls[0][0])).toMatch(/\/api\/tracts$/);
  });

  it("appends bbox and min_count as query parameters", async () => {
    fetchMock().mockResolvedValue(jsonResponse(VALID_BODY));

    await fetchTracts({ bbox: BBOX, minCount: 25 });

    const url = new URL(fetchUrl(fetchMock().mock.calls[0][0]));
    expect(url.pathname).toBe("/api/tracts");
    expect(url.searchParams.get("bbox")).toBe(
      "-122.500000,37.700000,-122.400000,37.800000",
    );
    expect(url.searchParams.get("min_count")).toBe("25");
  });

  it("omits min_count when it is zero, so the backend default applies", async () => {
    fetchMock().mockResolvedValue(jsonResponse(VALID_BODY));

    await fetchTracts({ minCount: 0 });

    expect(
      new URL(fetchUrl(fetchMock().mock.calls[0][0])).searchParams.has(
        "min_count",
      ),
    ).toBe(false);
  });
});

describe("fetchTracts response parsing", () => {
  it("returns typed features and reads telemetry from headers", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(VALID_BODY, 200, {
        "X-Query-Time-Ms": "7.42",
        "X-Feature-Count": "1",
        "X-Request-Id": "deadbeef",
      }),
    );

    const result = await fetchTracts();

    expect(result.collection.features).toHaveLength(1);
    expect(result.collection.features[0].properties.building_count).toBe(5);
    expect(result.meta).toEqual({
      queryTimeMs: 7.42,
      featureCount: 1,
      requestId: "deadbeef",
    });
  });

  it("tolerates missing telemetry headers", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ type: "FeatureCollection", features: [] }),
    );

    const result = await fetchTracts();

    expect(result.meta).toEqual({
      queryTimeMs: null,
      featureCount: null,
      requestId: null,
    });
    expect(result.collection.features).toEqual([]);
  });

  it.each([
    [
      "the body is not a FeatureCollection",
      { type: "Feature" },
      /FeatureCollection/,
    ],
    [
      "features is not an array",
      { type: "FeatureCollection", features: null },
      /must be an array/,
    ],
    [
      "a feature is not a Feature",
      { type: "FeatureCollection", features: [{ type: "Point" }] },
      /features\[0\] is not a Feature/,
    ],
    [
      "building_count is a string",
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "a",
            properties: {
              geoid: "a",
              building_count: "5",
              avg_height_m: 1,
              p95_height_m: 2,
            },
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
          },
        ],
      },
      /building_count must be a finite number/,
    ],
    [
      "building_count is NaN",
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "a",
            properties: {
              geoid: "a",
              building_count: null,
              avg_height_m: 1,
              p95_height_m: 2,
            },
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
          },
        ],
      },
      /building_count/,
    ],
    [
      "the geometry is not a Polygon",
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "a",
            properties: {
              geoid: "a",
              building_count: 1,
              avg_height_m: 1,
              p95_height_m: 2,
            },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
      /geometry must be a Polygon/,
    ],
  ])("rejects a malformed payload when %s", async (_label, body, pattern) => {
    // mockImplementation, not mockResolvedValue: a Response body can only be consumed
    // once, so a shared instance would fail on the second read with a TypeError and
    // mask the parse error under test.
    fetchMock().mockImplementation(() => Promise.resolve(jsonResponse(body)));

    const error = await captureError(fetchTracts());

    expect(error.message).toMatch(pattern);
  });
});

describe("fetchTracts failure mapping", () => {
  it("maps a network rejection to a retryable status-0 error", async () => {
    fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await captureError(fetchTracts());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/cannot reach the api/i);
  });

  it("surfaces the backend detail on a 4xx and marks it non-retryable", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ detail: "invalid bbox: min_x must be < max_x" }, 422),
    );

    const error = await captureError(fetchTracts());

    expect(error.status).toBe(422);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("min_x must be < max_x");
  });

  it("marks a 503 as retryable", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ detail: "Spatial query failed" }, 503),
    );

    const error = await captureError(fetchTracts());

    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    fetchMock().mockResolvedValue(
      new Response("gateway exploded", { status: 502 }),
    );

    const error = await captureError(fetchTracts());

    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });

  it("times out instead of hanging forever", async () => {
    // Mirror real fetch: reject when the signal aborts, never resolve otherwise.
    fetchMock().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const error = await captureError(fetchTracts({ timeoutMs: 5 }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/timed out after 5ms/);
  });

  it("propagates a caller abort", async () => {
    const controller = new AbortController();
    fetchMock().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const pending = fetchTracts({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ApiError);
  });
});

describe("fetchHealth", () => {
  it("parses the readiness payload", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        status: "ok",
        tract_count: 5000,
        building_count: 2_000_000,
        max_building_count: 2473,
        duckdb_version: "v1.5.6",
        spatial_version: "04270fe",
        data_dir: "/data",
      }),
    );

    const health = await fetchHealth();

    expect(health.building_count).toBe(2_000_000);
    expect(health.max_building_count).toBe(2473);
    expect(health.duckdb_version).toBe("v1.5.6");
  });

  it("rejects a payload missing a required field", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ status: "ok", tract_count: 1 }),
    );

    await expect(fetchHealth()).rejects.toThrow(/building_count/);
  });
});

describe("fetchJoin", () => {
  const JOIN_BODY = {
    tracts_in_scope: 65,
    tracts_matched: 65,
    buildings_matched: 136_378,
    truncated: false,
    query_time_ms: 47.77,
    tracts: [{ geoid: "tract_1", building_count: 2155, avg_height_m: 20.65 }],
  };

  it("omits the bbox parameter when none is supplied", async () => {
    fetchMock().mockResolvedValue(jsonResponse(JOIN_BODY));

    await fetchJoin(undefined);

    expect(fetchUrl(fetchMock().mock.calls[0][0])).toMatch(/\/api\/join$/);
  });

  it("appends the bbox when supplied", async () => {
    fetchMock().mockResolvedValue(jsonResponse(JOIN_BODY));

    await fetchJoin(BBOX);

    expect(
      new URL(fetchUrl(fetchMock().mock.calls[0][0])).searchParams.get("bbox"),
    ).toBe("-122.500000,37.700000,-122.400000,37.800000");
  });

  it("parses the join summary and its per-tract rows", async () => {
    fetchMock().mockResolvedValue(jsonResponse(JOIN_BODY));

    const join = await fetchJoin(undefined);

    expect(join.buildings_matched).toBe(136_378);
    expect(join.truncated).toBe(false);
    expect(join.query_time_ms).toBeCloseTo(47.77, 6);
    expect(join.tracts).toEqual([
      { geoid: "tract_1", building_count: 2155, avg_height_m: 20.65 },
    ]);
  });

  it("coerces a missing truncated flag to false rather than undefined", async () => {
    const { truncated: _omitted, ...rest } = JOIN_BODY;
    fetchMock().mockResolvedValue(jsonResponse(rest));

    expect((await fetchJoin(undefined)).truncated).toBe(false);
  });

  it("rejects a payload with a non-numeric match count", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ ...JOIN_BODY, buildings_matched: "lots" }),
    );

    const error = await captureError(fetchJoin(undefined));

    expect(error.message).toMatch(/buildings_matched/);
  });

  it("rejects a non-object payload", async () => {
    fetchMock().mockResolvedValue(jsonResponse([]));

    await expect(fetchJoin(undefined)).rejects.toThrow(
      /expected a join object/,
    );
  });
});
