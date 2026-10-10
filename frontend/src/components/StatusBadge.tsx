import type { HealthResponse } from '../api/types';

export interface StatusBadgeProps {
  readonly queryTimeMs: number | null;
  readonly featureCount: number | null;
  readonly isFetching: boolean;
  readonly health: HealthResponse | null;
}

const numberFormat = new Intl.NumberFormat('en-US');

/**
 * Persistent telemetry strip.
 *
 * This is the "we already have data, a refetch is happening" indicator. It replaces a
 * spinner precisely so that a viewport change never blanks the map — the previous result
 * stays rendered and only this strip shows that work is in progress.
 */
export function StatusBadge({ queryTimeMs, featureCount, isFetching, health }: StatusBadgeProps) {
  return (
    <div className="status" aria-live="polite">
      <span className={`status__dot${isFetching ? ' status__dot--busy' : ''}`} aria-hidden="true" />
      <span className="status__item">
        {isFetching ? 'Querying…' : 'Idle'}
      </span>

      {featureCount !== null && (
        <span className="status__item">
          <strong>{numberFormat.format(featureCount)}</strong> tracts
        </span>
      )}

      {queryTimeMs !== null && (
        <span className="status__item">
          <strong>{queryTimeMs.toFixed(1)}</strong> ms server-side
        </span>
      )}

      {health !== null && (
        <span className="status__item status__item--meta">
          DuckDB {health.duckdb_version} · {numberFormat.format(health.building_count)} buildings
        </span>
      )}
    </div>
  );
}
