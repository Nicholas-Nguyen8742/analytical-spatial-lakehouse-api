export interface EmptyStateProps {
  readonly onReset: () => void;
  /** True when a density filter, rather than the viewport, is what excluded everything. */
  readonly filteredOut: boolean;
}

/**
 * Shown when a query succeeded but matched nothing.
 *
 * Distinct from the error state on purpose: this is a valid answer, and the copy says
 * so. Panning to open ocean or setting a density floor above every tract both land here.
 */
export function EmptyState({ onReset, filteredOut }: EmptyStateProps) {
  return (
    <div className="overlay overlay--empty">
      <div className="panel">
        <p className="panel__eyebrow">No results</p>
        <h2 className="panel__title">
          {filteredOut ? 'No tracts above that density' : 'No tracts in this view'}
        </h2>
        <p className="panel__detail">
          {filteredOut
            ? 'Every tract in the current viewport has fewer buildings than the filter allows.'
            : 'The viewport is outside the generated dataset, which covers a San Francisco-sized extent.'}
        </p>
        <button type="button" className="btn btn--primary" onClick={onReset}>
          {filteredOut ? 'Clear the filter' : 'Reset the view'}
        </button>
      </div>
    </div>
  );
}
