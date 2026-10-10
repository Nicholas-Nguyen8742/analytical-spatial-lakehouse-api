import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { ApiError, fetchHealth, fetchTracts } from "../api/client";
import type { BBox, HealthResponse, TractResult } from "../api/types";

export interface TractFilters {
  readonly bbox?: BBox;
  readonly minCount: number;
}

function bboxKey(bbox: BBox | undefined): readonly number[] | null {
  // Primitive tuple, not the object: TanStack Query hashes keys structurally, but a
  // fresh object identity per render would still churn the cache for no benefit.
  return bbox ? [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] : null;
}

export function useTractStats(filters: TractFilters) {
  const { bbox, minCount } = filters;

  return useQuery<TractResult, Error>({
    queryKey: ["tracts", bboxKey(bbox), minCount],
    queryFn: ({ signal }) =>
      fetchTracts({ bbox: bbox ?? null, minCount, signal }),

    // The single most important line for perceived performance: keep the previous
    // result on screen while a refetch is in flight, so the map never blanks out.
    placeholderData: keepPreviousData,

    staleTime: 30_000,
    refetchOnWindowFocus: false,

    // A 4xx will fail identically on retry; do not waste two more attempts on it.
    retry: (failureCount, error) =>
      error instanceof ApiError && !error.retryable ? false : failureCount < 2,
  });
}

export function useHealth() {
  return useQuery<HealthResponse, Error>({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
