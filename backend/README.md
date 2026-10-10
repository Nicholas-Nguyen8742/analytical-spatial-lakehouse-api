# datalake — backend

Analytical spatial lakehouse backend. DuckDB reads GeoParquet directly; FastAPI serves
pre-aggregated GeoJSON to the deck.gl frontend.

## Design

Expensive spatial compute happens **once at build time**, not per request:

```
generate_data.py  ->  tracts.parquet, buildings.parquet      (lake layer)
build_summary.py  ->  summary.parquet                        (ETL: R-tree spatial join)
main.py           ->  SELECT ... FROM summary.parquet        (serve layer, ~ms)
```

The serve layer needs no spatial extension at all — `summary.parquet` carries both the
GeoJSON geometry text and the tract bounding-box columns, so viewport filtering is plain
numeric comparison over a columnar file.

## Quickstart

```bash
uv sync
uv run python -m datalake.generate_data      # ~30s, deterministic
uv run python -m datalake.build_summary      # spatial join, prints timing
uv run uvicorn datalake.main:app --reload --port 8000
```

## Checks

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest --cov=datalake
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tracts` | GeoJSON FeatureCollection; `bbox=minx,miny,maxx,maxy`, `min_count` |
| GET | `/api/join` | live R-tree spatial join, `X-Query-Time-Ms` header |
| GET | `/api/health` | row counts, duckdb/spatial versions |

Response timing is reported via `X-Query-Time-Ms` and `X-Feature-Count` headers so the
body stays a strictly conformant GeoJSON FeatureCollection.
