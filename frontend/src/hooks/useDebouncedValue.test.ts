import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue(5, 100));

    expect(result.current).toBe(5);
  });

  it("collapses a burst of changes into the final value", async () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ value }) => useDebouncedValue(value, 200),
        {
          initialProps: { value: 0 },
        },
      );

      // Simulates dragging the density slider: many intermediate values, one request.
      for (const value of [10, 20, 30, 40]) {
        rerender({ value });
      }
      expect(result.current).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(result.current).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the window when the value keeps changing", async () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ value }) => useDebouncedValue(value, 100),
        {
          initialProps: { value: "a" },
        },
      );

      rerender({ value: "ab" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      rerender({ value: "abc" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      expect(result.current).toBe("a");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      expect(result.current).toBe("abc");
    } finally {
      vi.useRealTimers();
    }
  });
});
