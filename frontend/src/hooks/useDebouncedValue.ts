import { useEffect, useState } from 'react';

/**
 * Delay propagating a rapidly-changing value.
 *
 * Dragging the density filter would otherwise fire one API request per pixel of slider
 * movement. The map's `moveend` is already discrete, so only the slider needs this.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
