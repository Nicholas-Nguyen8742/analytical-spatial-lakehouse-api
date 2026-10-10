import { describeError } from '../state/resolveView';

export interface ErrorStateProps {
  readonly error: Error;
  readonly onRetry: () => void;
  /** Disables the button and shows progress while a retry is in flight. */
  readonly isRetrying: boolean;
}

/**
 * Page-level error banner.
 *
 * Rendered *over* the map rather than replacing it, so the basemap and controls stay
 * usable and a retry does not have to rebuild the WebGL context. The internal error
 * message is shown as detail but the backend's own reason string is summarised by
 * `describeError` rather than dumped raw.
 */
export function ErrorState({ error, onRetry, isRetrying }: ErrorStateProps) {
  const copy = describeError(error);

  return (
    <div className="overlay overlay--error" role="alert" aria-live="assertive">
      <div className="panel">
        <p className="panel__eyebrow">Request failed</p>
        <h2 className="panel__title">{copy.title}</h2>
        <p className="panel__detail">{copy.detail}</p>
        {copy.hint !== null && <p className="panel__hint">{copy.hint}</p>}

        {copy.canRetry ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onRetry}
            disabled={isRetrying}
            aria-busy={isRetrying}
          >
            {isRetrying ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Retrying…
              </>
            ) : (
              'Try again'
            )}
          </button>
        ) : (
          <p className="panel__hint panel__hint--muted">Retrying will not help here.</p>
        )}
      </div>
    </div>
  );
}
