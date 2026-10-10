import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useLatest } from './useLatest';

describe('useLatest', () => {
  it('exposes a stable ref identity across renders', () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 1 },
    });

    const firstRef = result.current;
    rerender({ value: 2 });

    expect(result.current).toBe(firstRef);
  });

  it('tracks the newest value', () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 'a' },
    });

    expect(result.current.current).toBe('a');

    rerender({ value: 'b' });
    expect(result.current.current).toBe('b');
  });

  it('holds object identity, not a copy', () => {
    const callback = (): void => {};
    const { result } = renderHook(() => useLatest(callback));

    expect(result.current.current).toBe(callback);
  });
});
