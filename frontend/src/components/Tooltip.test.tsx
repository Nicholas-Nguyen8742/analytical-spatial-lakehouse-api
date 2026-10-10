import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TractFeature } from "../api/types";
import type { HoverInfo } from "../map/layers";
import { Tooltip } from "./Tooltip";

const FEATURE: TractFeature = {
  type: "Feature",
  id: "tract_42",
  properties: {
    geoid: "tract_42",
    building_count: 1234,
    avg_height_m: 18.25,
    p95_height_m: 64.5,
  },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
};

function hoverAt(x: number, y: number): HoverInfo {
  return { x, y, feature: FEATURE };
}

function transformOf() {
  return screen.getByRole("tooltip").style.transform ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tooltip", () => {
  it("renders the geoid and all three statistics, thousands-separated", () => {
    render(<Tooltip hover={hoverAt(100, 100)} />);

    expect(screen.getByRole("tooltip")).toHaveTextContent("tract_42");
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("18.3 m")).toBeInTheDocument();
    expect(screen.getByText("64.5 m")).toBeInTheDocument();
  });

  it("anchors at the pointer and offsets away from it", () => {
    render(<Tooltip hover={hoverAt(120, 340)} />);

    const el = screen.getByRole("tooltip");
    expect(el.style.left).toBe("120px");
    expect(el.style.top).toBe("340px");
    expect(transformOf()).toContain("14px");
    expect(transformOf()).not.toContain("-100%");
  });

  it("flips to the left of the pointer near the right edge", () => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 768);

    render(<Tooltip hover={hoverAt(790, 100)} />);

    expect(transformOf()).toContain("calc(-100% - 14px)");
  });

  it("flips above the pointer near the bottom edge", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);

    render(<Tooltip hover={hoverAt(100, 760)} />);

    expect(transformOf()).toContain("calc(-100% - 14px)");
  });

  it("does not intercept pointer events, so the map stays draggable underneath", () => {
    render(<Tooltip hover={hoverAt(10, 10)} />);

    expect(screen.getByRole("tooltip")).toHaveClass("tooltip");
  });
});
