import { useEffect, useRef } from 'react';

/**
 * Hold the latest value in a ref with a stable identity.
 *
 * Used for callbacks handed to long-lived imperative objects — the MapLibre map and the
 * deck.gl overlay are created once, but must still call the newest closure. Assigning in
 * an effect rather than during render keeps this correct under concurrent rendering.
 */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  });

  return ref;
}
