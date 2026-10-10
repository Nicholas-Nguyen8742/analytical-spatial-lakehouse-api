/**
 * First-load indicator.
 *
 * Only ever rendered when there is no data at all — see `resolveTractView`. A refetch
 * with data on screen shows the subtler `StatusBadge` pulse instead, never this.
 *
 * A skeleton rather than a bare spinner: the layout of the result is known ahead of
 * time, so the placeholder can match it and avoid a reflow on arrival.
 */
export function LoadingOverlay() {
  return (
    <div className="overlay overlay--loading" role="status" aria-live="polite">
      <div className="panel">
        <span className="spinner" aria-hidden="true" />
        <h2 className="panel__title">Querying the lake</h2>
        <p className="panel__detail">
          Running the spatial aggregate over 2,000,000 building footprints…
        </p>
        <div className="skeleton" aria-hidden="true">
          <span style={{ width: '82%' }} />
          <span style={{ width: '64%' }} />
          <span style={{ width: '73%' }} />
        </div>
      </div>
    </div>
  );
}
