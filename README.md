# Analytical Spatial Lakehouse

DuckDB reads Parquet directly and performs an exact spatial join over 2,000,000 building
points against 5,000 tract polygons. FastAPI serves the materialised aggregate as
GeoJSON. React + deck.gl renders it as an extruded choropleth in WebGL.

```
generate_data.py  ──►  tracts.parquet  buildings.parquet     (lake layer, 44.7 MB)
                             │                │
                             ▼                ▼
              build_summary.py — exact ST_Intersects join, ONCE (223 ms)
                             │
                             ▼
                      summary.parquet                          (214 KB)
                             │
                             ▼
   GET /api/tracts ── SELECT … WHERE x1 >= $min_x …            (7.4 ms)
                             │
                             ▼
              React + TanStack Query + deck.gl
```

## Why the compute happens at build time

Not because the join is slow — it isn't. A full 2M × 5,000 `ST_Intersects` join takes
**223 ms** on this machine, because DuckDB's spatial extension applies its own
bounding-box pre-filter without needing an index. It is moved to ETL time because 223 ms
is still too slow to re-run on every map pan, while a columnar scan of 5,000
pre-aggregated rows takes 7 ms.

The raw capability is still exposed at `GET /api/join`, bounded by `max_join_tracts` so a
client cannot turn one request into a full-dataset scan.

## Quickstart

Requires [uv](https://docs.astral.sh/uv/) and Node 20+. No system Python needed — uv
provisions its own.

```bash
# Backend: provision Python, install, build the lake
cd backend
uv sync
uv run python -m datalake.generate_data     # ~4 s, deterministic
uv run python -m datalake.build_summary     # ~0.3 s
uv run uvicorn datalake.main:app --port 8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                                  # http://localhost:5173
```

## Measured on this repo

| Step | Result |
|---|---|
| Generate 5,000 tracts + 2M buildings (from 24M rejection-sampled candidates) | **3.8 s** |
| Exact `ST_Intersects` join, 2M × 5,000 | **223 ms** |
| Row conservation | **2,000,000 / 2,000,000** matched |
| `GET /api/tracts`, full extent (5,000 features) | **7.4 ms** server-side, 42 ms round trip |
| Payload, full extent | 1.65 MB raw → **248 KB** gzipped |
| `GET /api/tracts`, downtown bbox | **8 ms**, 124 KB |
| `GET /api/join`, 65 tracts, 136,378 buildings | **47.8 ms** |
| Lake file sizes | buildings 44.6 MB · tracts 56 KB · summary 214 KB |
| `building_count` distribution | min 90 · p50 201 · p95 1,256 · max 2,473 |

## Checks

```bash
# backend
cd backend
uv run ruff check . && uv run ruff format --check .
uv run mypy                     # strict
uv run pytest --cov=datalake    # 53 tests, 96% coverage

# frontend
cd frontend
npm run lint                    # eslint + typescript-eslint, type-aware
npm run typecheck               # tsc strict, exactOptionalPropertyTypes
npm run test                    # 92 tests, 97.8% coverage
npm run build
```

## Design decisions worth knowing

**Geometry is not materialised for buildings.** Two million points are stored as plain
`x`/`y` DOUBLE columns and turned into `GEOMETRY` with `ST_Point` during the join. That
keeps `buildings.parquet` at 44.6 MB instead of ~90 MB, makes column pruning effective,
and avoids constructing two million Shapely objects in Python — which is where the
conventional `geopandas` approach spends minutes and gigabytes.

**Determinism comes from `hash()`, not `random()`.** DuckDB's hash is a pure function of
its input, so the same seed reproduces identical output across runs and machines,
independent of query parallelism. `setseed()` only guarantees reproducibility within a
single session.

**The grid-key equi-join was measured and rejected.** Because the tracts form a regular
grid, membership can be computed with `floor((x - x_min) / cell_w)` as a pure hash join.
It is faster — but against `ST_Contains` on 200,000 points it disagreed on **43 of them**
(0.02%), because fixed-point cell boundaries and DOUBLE division round differently.
Saving 180 ms once, at build time, is not worth shipping a silently inexact aggregate.

**Every coordinate literal is cast to DOUBLE.** DuckDB parses a bare decimal literal as
`DECIMAL`, and `BIGINT * DECIMAL` promotes to `DECIMAL`, not `DOUBLE`. Left implicit, the
tract grid would be computed in fixed-point and round differently from the points it is
supposed to contain. See `spec.d()`.

**The join is asserted row-conserving.** `build_summary` raises unless
`sum(building_count)` equals the building row count exactly. Less means points were
dropped outside the grid; more means tracts overlap and points were double-counted.
Either way every downstream statistic would be silently wrong.

**Telemetry lives in headers.** `X-Query-Time-Ms`, `X-Feature-Count` and `X-Request-Id`
are response headers, so the body stays a strictly conformant GeoJSON
`FeatureCollection` that any client can consume unmodified. They are listed in
`access-control-expose-headers` — without that, browser JS cannot read them.

## Frontend state handling

The react-ui-patterns decision tree is lifted out of JSX into a pure function
(`src/state/resolveView.ts`) so the ordering guarantee is unit-tested rather than
eyeballed:

```
error → loading → empty → ready
```

The load-bearing detail is that **loading only fires when `data` is undefined**. The
query uses `placeholderData: keepPreviousData`, so a viewport change or filter drag
re-renders the map in place with the last good result while a subtle status dot pulses —
instead of flashing a spinner over the whole map. There is a regression test for exactly
this (`App.test.tsx` → "keeps the previous result visible during a refetch").

Overlays are rendered *over* the map rather than replacing it, so an error never destroys
the WebGL context and a retry does not have to rebuild it.

## Known limitations

Being explicit about what this is not:

1. **Not strict GeoParquet.** DuckDB 1.5.6's Parquet writer rejects `KEY_VALUE_METADATA`
   and its bundled GDAL has no `Parquet` driver, so the spec-required `geo` metadata key
   cannot be emitted. `tracts.parquet` carries WKB-encoded geometry (GeoParquet's
   encoding) without the metadata block; `buildings.parquet` is plain columnar. Adding
   `pyarrow` to stamp the key is the obvious follow-up if strict compliance matters.
2. **No R-tree index.** `CREATE SPATIAL INDEX … USING RTREE` is a *syntax error* in
   DuckDB 1.5.6, and `ST_Read` only opens GDAL datasets, not plain Parquet. The join
   performance above comes from the extension's internal bbox pre-filter, not an index.
3. **Synthetic data.** Rejection sampling against four Gaussian kernels produces a
   plausible city with dense cores and sparse outskirts, but it is not real geography.
   The Overture Maps / `httpfs` cloud-query path is deliberately not implemented.
4. **No auth, no ingestion pipeline, no Docker.** Out of scope by design.
5. **Browser-level visual verification was not performed.** The production build compiles,
   every module resolves through Vite, and the deck.gl/MapLibre integration is covered by
   unit tests with `MapView` stubbed — but no WebGL render was captured, because no
   browser automation MCP was available in this environment.

## Layout

```
backend/    uv + FastAPI + DuckDB.  src/datalake/{spec,db,queries,models,settings,
            generate_data,build_summary,main}.py   tests/
frontend/   Vite + React 19 + TS + deck.gl 9 + MapLibre 6 + TanStack Query 5.
            src/{api,state,hooks,lib,map,components}/
data/       gitignored Parquet artifacts
```

`frontend/package.json` pins `@loaders.gl/*` to 4.5.3 via `overrides`. Version 4.5.4 of
`@loaders.gl/core` was published pinning exact dependencies on `worker-utils@4.5.4`,
which was never published — so `@deck.gl/core@9.4.0`'s `^4.4.3` range resolves straight
into an uninstallable tree. 4.5.3 is the nearest internally consistent release set.
