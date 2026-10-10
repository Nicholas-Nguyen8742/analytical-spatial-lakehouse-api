import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type { BBox, TractFeature } from "./api/types";
import { Controls } from "./components/Controls";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { Legend } from "./components/Legend";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { MapView } from "./components/MapView";
import { StatusBadge } from "./components/StatusBadge";
import { Tooltip } from "./components/Tooltip";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { useHealth, useTractStats } from "./hooks/useTractStats";
import { quantileBreaks } from "./lib/colorScale";
import type { HoverInfo } from "./map/layers";
import { resolveTractView } from "./state/resolveView";

/** Stable identity so the empty case does not invalidate every downstream memo. */
const NO_FEATURES: readonly TractFeature[] = [];

const FILTER_DEBOUNCE_MS = 250;

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: 1 },
    },
  });
}

/**
 * The dashboard. Split from `App` so tests can render it without standing up a second
 * QueryClientProvider.
 */
export function Dashboard() {
  const [bbox, setBbox] = useState<BBox | undefined>(undefined);
  const [minCountInput, setMinCountInput] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // The slider drives this immediately for the label, but only the debounced value
  // reaches the query — otherwise every pixel of drag fires a request.
  const minCount = useDebouncedValue(minCountInput, FILTER_DEBOUNCE_MS);

  const tracts = useTractStats({
    ...(bbox === undefined ? {} : { bbox }),
    minCount,
  });
  const health = useHealth();

  const retry = useCallback(() => {
    void tracts.refetch();
  }, [tracts]);

  const view = resolveTractView(
    { error: tracts.error, isPending: tracts.isPending, data: tracts.data },
    retry,
  );

  // Deliberately read from `tracts.data` rather than `view`: with keepPreviousData the
  // map keeps showing the last good result while an error banner sits above it.
  const features = tracts.data?.collection.features ?? NO_FEATURES;

  const breaks = useMemo(
    () => quantileBreaks(features.map((f) => f.properties.building_count)),
    [features],
  );

  const maxCount = useMemo(
    () =>
      features.reduce(
        (max, f) => Math.max(max, f.properties.building_count),
        0,
      ),
    [features],
  );

  // The slider range is a property of the *dataset*, not of whatever subset is on
  // screen. Deriving it from `maxCount` would collapse the ceiling to 1 the moment a
  // filter excluded everything, snapping the thumb back and leaving the user no way to
  // undo the filter from the UI. Falls back to the visible max until health resolves.
  const sliderCeiling = health.data?.max_building_count ?? maxCount;

  const handleHover = useCallback(
    (info: HoverInfo | null) => setHover(info),
    [],
  );

  const handleViewChange = useCallback((next: BBox) => setBbox(next), []);

  const handleResetView = useCallback(() => {
    setBbox(undefined);
    setHover(null);
    setResetToken((token) => token + 1);
  }, []);

  const handleClearFilter = useCallback(() => {
    setMinCountInput(0);
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__titles">
          <h1 className="app__title">Analytical Spatial Lakehouse</h1>
          <p className="app__subtitle">
            2M building footprints joined against 5,000 tracts by DuckDB, served
            from Parquet, rendered in WebGL.
          </p>
        </div>
        <StatusBadge
          queryTimeMs={tracts.data?.meta.queryTimeMs ?? null}
          featureCount={tracts.data?.meta.featureCount ?? null}
          isFetching={tracts.isFetching}
          health={health.data ?? null}
        />
      </header>

      <Controls
        minCount={minCountInput}
        maxCount={sliderCeiling}
        onMinCountChange={setMinCountInput}
        onRefresh={retry}
        onResetView={handleResetView}
        isFetching={tracts.isFetching}
      />

      <main className="app__stage">
        <MapView
          features={features}
          breaks={breaks}
          onHover={handleHover}
          onViewChange={handleViewChange}
          resetToken={resetToken}
        />

        {view.kind === "loading" && <LoadingOverlay />}
        {view.kind === "error" && (
          <ErrorState
            error={view.error}
            onRetry={view.retry}
            isRetrying={tracts.isFetching}
          />
        )}
        {view.kind === "empty" && (
          <EmptyState
            onReset={minCountInput > 0 ? handleClearFilter : handleResetView}
            filteredOut={minCountInput > 0}
          />
        )}

        {breaks.length > 0 && (
          <Legend breaks={breaks} metric="Buildings per tract" />
        )}
        {hover !== null && <Tooltip hover={hover} />}
      </main>
    </div>
  );
}

/** Application shell: owns the QueryClient so `App` can be rendered standalone. */
export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}
