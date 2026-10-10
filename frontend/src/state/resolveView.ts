/**
 * Which UI state to render, decided in exactly one place.
 *
 * This is the react-ui-patterns decision tree lifted out of JSX and into a pure
 * function, so the ordering guarantee can be unit-tested instead of eyeballed:
 *
 *   1. error                      — always wins; never render stale data over a failure
 *   2. loading, and only then     — a spinner shows only when there is nothing to show
 *   3. empty                      — a successful query that matched nothing
 *   4. ready
 *
 * The golden rule is step 2. Because the query is configured with
 * `placeholderData: keepPreviousData`, `data` stays populated across a refetch, so a
 * viewport change re-renders in place instead of flashing a spinner over the map.
 */

import { ApiError } from '../api/client';
import type { TractResult } from '../api/types';

export type ViewState =
  | { readonly kind: 'error'; readonly error: Error; readonly retry: () => void }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly result: TractResult };

export interface QuerySnapshot<TData> {
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly data: TData | undefined;
}

export function resolveTractView(
  snapshot: QuerySnapshot<TractResult>,
  retry: () => void,
): ViewState {
  if (snapshot.error !== null) {
    return { kind: 'error', error: snapshot.error, retry };
  }

  // Equivalent to the skill's `isPending && !data`, and additionally covers the
  // defensive case of "not pending but no data yet", which must never render as empty.
  if (snapshot.data === undefined) {
    return { kind: 'loading' };
  }

  if (snapshot.data.collection.features.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'ready', result: snapshot.data };
}

export interface ErrorCopy {
  readonly title: string;
  readonly detail: string;
  readonly hint: string | null;
  readonly canRetry: boolean;
}

/**
 * Turn any thrown value into something a person can act on.
 *
 * Internal messages are logged by the caller, never rendered — an `ApiError` message
 * can contain a backend detail string, and the UI shows a stable summary instead.
 */
export function describeError(error: unknown): ErrorCopy {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return {
        title: 'Cannot reach the analytics API',
        detail: error.message,
        hint: 'Check that the backend is running and that VITE_API_BASE_URL points at it.',
        canRetry: true,
      };
    }
    if (error.status === 503) {
      return {
        title: 'The spatial query failed',
        detail: error.message,
        hint: 'The lake may be mid-rebuild. Retry in a moment.',
        canRetry: true,
      };
    }
    if (error.status >= 500 || error.status === 429) {
      return {
        title: 'The server could not answer that request',
        detail: error.message,
        hint: null,
        canRetry: true,
      };
    }
    if (error.status >= 400) {
      // A 4xx will fail identically on retry; offering the button would be a lie.
      return {
        title: 'That request was rejected',
        detail: error.message,
        hint: 'Adjust the viewport or filters and try again.',
        canRetry: false,
      };
    }
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return {
      title: 'Request cancelled',
      detail: 'The query was superseded before it finished.',
      hint: null,
      canRetry: true,
    };
  }

  return {
    title: 'Something went wrong',
    detail: error instanceof Error ? error.message : String(error),
    hint: null,
    canRetry: true,
  };
}
