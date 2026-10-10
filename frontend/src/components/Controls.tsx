export interface ControlsProps {
  readonly minCount: number;
  readonly maxCount: number;
  readonly onMinCountChange: (value: number) => void;
  readonly onRefresh: () => void;
  readonly onResetView: () => void;
  readonly isFetching: boolean;
}

const numberFormat = new Intl.NumberFormat('en-US');

/**
 * Filter and action controls.
 *
 * Every trigger is disabled while a request is in flight. That is not cosmetic: without
 * it a held-down refresh button queues overlapping queries against the same DuckDB
 * cursor.
 */
export function Controls({
  minCount,
  maxCount,
  onMinCountChange,
  onRefresh,
  onResetView,
  isFetching,
}: ControlsProps) {
  const ceiling = Math.max(maxCount, 1);

  return (
    <div className="controls">
      <label className="controls__field" htmlFor="min-count">
        <span className="controls__label">
          Minimum buildings
          <output className="controls__value" htmlFor="min-count">
            {numberFormat.format(minCount)}
          </output>
        </span>
        <input
          id="min-count"
          type="range"
          min={0}
          max={ceiling}
          step={Math.max(1, Math.round(ceiling / 100))}
          value={Math.min(minCount, ceiling)}
          onChange={(event) => onMinCountChange(Number(event.target.value))}
          disabled={isFetching}
          aria-describedby="min-count-hint"
        />
        <span id="min-count-hint" className="controls__hint">
          Hides tracts below this density
        </span>
      </label>

      <div className="controls__actions">
        <button
          type="button"
          className="btn"
          onClick={onRefresh}
          disabled={isFetching}
          aria-busy={isFetching}
        >
          {isFetching ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Loading…
            </>
          ) : (
            'Refresh'
          )}
        </button>
        <button type="button" className="btn" onClick={onResetView} disabled={isFetching}>
          Reset view
        </button>
      </div>
    </div>
  );
}
