import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App, Dashboard } from "./App";
import type { TractFeature } from "./api/types";
import { fetchUrl } from "./test/fetchUrl";

/**
 * MapView drives a real WebGL context through MapLibre, which jsdom cannot provide.
 * It is the only component stubbed here — everything above it (query layer, state
 * resolution, overlays) is exercised for real.
 *
 * The stub exposes buttons that invoke the callbacks App passes down, so the hover,
 * tooltip and viewport-filter wiring is covered rather than silently skipped.
 */
vi.mock("./components/MapView", async () => {
  const react = await import("react");
  type StubProps = {
    features: readonly TractFeature[];
    onHover: (info: unknown) => void;
    onViewChange: (bbox: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    }) => void;
  };
  return {
    MapView: (props: StubProps) =>
      react.createElement(
        "div",
        { "data-testid": "map-stub" },
        `features:${props.features.length}`,
        react.createElement(
          "button",
          {
            "data-testid": "stub-hover",
            onClick: () => {
              const first = props.features[0];
              if (first !== undefined)
                props.onHover({ x: 5, y: 6, feature: first });
            },
          },
          "hover",
        ),
        react.createElement(
          "button",
          { "data-testid": "stub-unhover", onClick: () => props.onHover(null) },
          "unhover",
        ),
        react.createElement(
          "button",
          {
            "data-testid": "stub-move",
            onClick: () =>
              props.onViewChange({ minX: -30, minY: 40, maxX: -29, maxY: 41 }),
          },
          "move",
        ),
      ),
  };
});

const HEALTH_BODY = {
  status: "ok",
  tract_count: 5000,
  building_count: 2_000_000,
  // Dataset-wide ceiling; the density filter must not derive this from the visible subset.
  max_building_count: 500,
  duckdb_version: "v1.5.6",
  spatial_version: "04270fe",
  data_dir: "C:/data",
};

function feature(geoid: string, count: number): TractFeature {
  return {
    type: "Feature",
    id: geoid,
    properties: {
      geoid,
      building_count: count,
      avg_height_m: 12.5,
      p95_height_m: 30,
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
}

function collection(...features: TractFeature[]) {
  return { type: "FeatureCollection", features };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface Handlers {
  tracts: (url: string) => Promise<Response> | Response;
  health?: () => Promise<Response> | Response;
}

function installFetch({ tracts, health }: Handlers) {
  // Record narrowed URL strings rather than reading `mock.calls` later: the call
  // arguments are typed `RequestInfo | URL`, and `String()` on the Request form yields
  // `[object Object]`, which would make assertions pass vacuously.
  const urls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = fetchUrl(input);
    urls.push(url);
    if (url.includes("/api/health"))
      return (health ?? (() => json(HEALTH_BODY)))();
    if (url.includes("/api/tracts")) return tracts(url);
    throw new Error(`unexpected request in test: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, urls };
}

function renderDashboard() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // The query-level retry policy still applies; zero delay keeps it instant.
        retryDelay: 0,
        refetchOnWindowFocus: false,
        gcTime: 0,
      },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("first load", () => {
  it("shows a loading overlay while nothing is on screen", async () => {
    installFetch({ tracts: () => new Promise<Response>(() => {}) });

    renderDashboard();

    expect(await screen.findByText("Querying the lake")).toBeInTheDocument();
    expect(screen.getByTestId("map-stub")).toHaveTextContent("features:0");
  });

  it("renders the choropleth and the legend once data arrives", async () => {
    installFetch({
      tracts: () =>
        json(collection(feature("tract_1", 40), feature("tract_2", 900)), 200, {
          "X-Query-Time-Ms": "7.42",
          "X-Feature-Count": "2",
        }),
    });

    renderDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:2"),
    );
    expect(
      screen.getByRole("region", { name: /buildings per tract legend/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("7.4")).toBeInTheDocument();
    expect(screen.queryByText("Querying the lake")).not.toBeInTheDocument();
  });

  it("renders an empty state when the query succeeds but matches nothing", async () => {
    installFetch({ tracts: () => json(collection()) });

    renderDashboard();

    expect(
      await screen.findByText("No tracts in this view"),
    ).toBeInTheDocument();
    // An empty result is a valid answer, not a failure.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("error handling", () => {
  it("surfaces an unreachable API with an actionable retry", async () => {
    installFetch({
      tracts: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    renderDashboard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/cannot reach the analytics api/i);
    expect(alert).toHaveTextContent(/VITE_API_BASE_URL/);
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });

  it("recovers when retry succeeds after the API comes back", async () => {
    let online = false;
    installFetch({
      tracts: () =>
        online
          ? json(collection(feature("tract_9", 7)))
          : Promise.reject(new Error("down")),
    });

    renderDashboard();
    await screen.findByRole("alert");

    online = true;
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides the retry button for a 4xx, which would fail identically", async () => {
    installFetch({
      tracts: () =>
        json({ detail: "invalid bbox: min_x must be < max_x" }, 422),
    });

    renderDashboard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/that request was rejected/i);
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(alert).toHaveTextContent(/retrying will not help/i);
  });
});

describe("refetch behaviour", () => {
  /** The golden rule: never blank the map when data is already on screen. */
  it("keeps the previous result visible during a refetch", async () => {
    let hang = false;
    installFetch({
      tracts: () =>
        hang
          ? new Promise<Response>(() => {})
          : json(collection(feature("tract_1", 40), feature("tract_2", 900))),
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:2"),
    );

    hang = true;
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    // No full-screen loading overlay, and the map still holds the last good result.
    expect(screen.queryByText("Querying the lake")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-stub")).toHaveTextContent("features:2");
    // The subtle in-flight indicator takes over instead.
    expect(screen.getByText("Querying…")).toBeInTheDocument();
  });

  it("disables every trigger while a request is in flight", async () => {
    let hang = false;
    installFetch({
      tracts: () =>
        hang
          ? new Promise<Response>(() => {})
          : json(collection(feature("t", 5))),
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );

    const refresh = screen.getByRole("button", { name: /refresh/i });
    expect(refresh).toBeEnabled();

    hang = true;
    await userEvent.click(refresh);

    await waitFor(() => expect(refresh).toBeDisabled());
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /reset view/i })).toBeDisabled();
    // The slider is disabled too, so a drag cannot queue overlapping queries.
    expect(screen.getByRole("slider")).toBeDisabled();
  });
});

describe("status strip", () => {
  it("reports the lake size from the health endpoint", async () => {
    installFetch({ tracts: () => json(collection(feature("t", 5))) });

    renderDashboard();

    expect(await screen.findByText(/DuckDB v1\.5\.6/)).toBeInTheDocument();
    expect(screen.getByText(/2,000,000 buildings/)).toBeInTheDocument();
  });
});

describe("map interaction wiring", () => {
  it("shows a tooltip for the hovered tract and clears it on exit", async () => {
    installFetch({
      tracts: () => json(collection(feature("tract_77", 420))),
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("stub-hover"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("tract_77");

    await userEvent.click(screen.getByTestId("stub-unhover"));
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
  });

  it("narrows the query to the new viewport when the map settles", async () => {
    const { urls } = installFetch({
      tracts: () => json(collection(feature("tract_1", 40))),
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );

    // The first request has no bbox: the app opens on the full extent.
    expect(urls[0]).not.toContain("bbox=");

    await userEvent.click(screen.getByTestId("stub-move"));

    await waitFor(() => {
      expect(urls.at(-1)).toContain(
        "bbox=-30.000000%2C40.000000%2C-29.000000%2C41.000000",
      );
    });
  });

  it("clears the viewport filter and flies home on reset", async () => {
    const { urls } = installFetch({
      tracts: (url) =>
        url.includes("bbox=")
          ? json(collection())
          : json(collection(feature("t", 5))),
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );

    await userEvent.click(screen.getByTestId("stub-move"));
    expect(
      await screen.findByText("No tracts in this view"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /reset the view/i }),
    );

    await waitFor(() => {
      expect(urls.at(-1)).not.toContain("bbox=");
    });
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );
  });
});

describe("density filter", () => {
  it("debounces the slider into a min_count query and keeps the ceiling stable", async () => {
    const { urls } = installFetch({
      tracts: (url) =>
        url.includes("min_count=")
          ? json(collection())
          : json(collection(feature("t", 500))),
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );

    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("max", "500");

    fireEvent.change(slider, { target: { value: "100" } });
    expect(slider).toHaveValue("100");

    expect(
      await screen.findByText("No tracts above that density"),
    ).toBeInTheDocument();
    expect(urls.at(-1)).toContain("min_count=100");

    // Regression guard: an empty result set must not collapse the slider ceiling to 1
    // and snap the thumb back, which would strand the user in an unfilterable state.
    const afterEmpty = screen.getByRole("slider");
    expect(afterEmpty).toHaveAttribute("max", "500");
    expect(afterEmpty).toHaveValue("100");

    await userEvent.click(
      screen.getByRole("button", { name: /clear the filter/i }),
    );

    await waitFor(() => expect(urls.at(-1)).not.toContain("min_count="));
    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );
    expect(screen.getByRole("slider")).toHaveValue("0");
  });
});

describe("app shell", () => {
  it("supplies its own query client so App renders standalone", async () => {
    installFetch({ tracts: () => json(collection(feature("t", 5))) });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("map-stub")).toHaveTextContent("features:1"),
    );
    expect(
      screen.getByRole("heading", { name: /analytical spatial lakehouse/i }),
    ).toBeInTheDocument();
  });
});
