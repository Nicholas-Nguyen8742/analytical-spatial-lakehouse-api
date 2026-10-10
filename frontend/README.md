# geo-lakehouse-frontend

React 19 + TypeScript + deck.gl 9 + MapLibre 6 client for the DuckDB spatial lakehouse API.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on `http://127.0.0.1:5173` |
| `npm run build` | `tsc -b` then production bundle into `dist/` |
| `npm run typecheck` | Strict TS, including `exactOptionalPropertyTypes` |
| `npm run lint` | ESLint with type-aware rules and `react-hooks/exhaustive-deps` as an error |
| `npm run test` | Vitest + Testing Library, jsdom |
| `npm run coverage` | Same, with a v8 coverage report |

The backend must be running on `http://127.0.0.1:8000`. Override with
`VITE_API_BASE_URL` (see `.env.example`).

## Structure

```
src/
├── api/         client.ts is the single fetch boundary; types.ts mirrors the Pydantic models
├── state/       resolveView.ts — the loading/error/empty/ready decision tree, as a pure function
├── hooks/       useTractStats (TanStack Query), useDebouncedValue, useLatest
├── lib/         colorScale.ts — quantile breaks, ramp, elevation encoding
├── map/         config.ts (static view), layers.ts (deck.gl layer construction)
└── components/  MapView + one component per UI state
```

## Two decisions that are easy to undo by accident

**`resolveView` decides what renders, and nothing else does.** The order
`error → loading → empty → ready` is the contract; `App.tsx` only switches on its result.
If you add a state, add it there and add a test — do not branch on `isPending` inline in
JSX, which is how the spinner-flash bug gets reintroduced.

**`MapView` creates the MapLibre map exactly once.** Callbacks are read through
`useLatest` refs rather than closed over, and the initial view is a module constant rather
than a prop. Passing it as a prop object would give the effect a new dependency identity on
every parent render and tear down the WebGL context each time.

## Notes

- `react-map-gl` is deliberately **not** a dependency. `@deck.gl/mapbox`'s `MapboxOverlay`
  attaches to a MapLibre map directly, which removes a dependency and a class of
  deck.gl/react-map-gl peer-range conflicts.
- `@loaders.gl/*` is pinned to 4.5.3 in the root `overrides` block. Do not remove it:
  `@loaders.gl/core@4.5.4` pins an exact dependency on `worker-utils@4.5.4`, which was
  never published, so the default resolution is uninstallable.
- `import 'maplibre-gl/dist/maplibre-gl.css'` lives in `MapView.tsx`. Removing it yields an
  unstyled map that looks like a rendering bug rather than a missing stylesheet.
