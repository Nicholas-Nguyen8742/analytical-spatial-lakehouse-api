"""FastAPI application serving the analytical spatial lakehouse.

The app is built by :func:`create_app` so tests can inject a :class:`Settings` pointing
at a temporary lake instead of mutating process-global state. ``app`` exists at module
level only as uvicorn's entry point.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

import duckdb
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from datalake import __version__, queries
from datalake.db import connect, iter_cursor, load_spatial, register_lake_views
from datalake.models import (
    BBOX_PATTERN,
    HEADER_FEATURE_COUNT,
    HEADER_QUERY_TIME_MS,
    BBox,
    Feature,
    FeatureCollection,
    HealthResponse,
    JoinResponse,
    TractJoinStat,
    TractProperties,
)
from datalake.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def get_db(request: Request) -> Iterator[duckdb.DuckDBPyConnection]:
    """Yield a cursor on the shared catalog for one request.

    DuckDB connections are not thread-safe, but a cursor taken from a parent connection
    shares the same database instance and catalog — the supported pattern for serving
    concurrent reads from one in-process database.
    """
    db: duckdb.DuckDBPyConnection = request.app.state.db
    yield from iter_cursor(db)


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


DbDep = Annotated[duckdb.DuckDBPyConnection, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]


def parse_bbox(
    bbox: Annotated[
        str | None,
        Query(
            pattern=BBOX_PATTERN,
            description="Viewport filter as `min_lon,min_lat,max_lon,max_lat`.",
        ),
    ] = None,
) -> BBox | None:
    """Parse and range-check the ``bbox`` query parameter."""
    if bbox is None:
        return None
    try:
        min_x, min_y, max_x, max_y = (float(part) for part in bbox.split(","))
        return BBox(min_x=min_x, min_y=min_y, max_x=max_x, max_y=max_y)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid bbox {bbox!r}: {exc}") from exc


def _to_feature(row: tuple[Any, ...]) -> Feature:
    geoid, geometry, building_count, avg_height_m, p95_height_m = row
    return Feature(
        id=str(geoid),
        properties=TractProperties(
            geoid=str(geoid),
            building_count=int(building_count),
            avg_height_m=float(avg_height_m),
            p95_height_m=float(p95_height_m),
        ),
        geometry=json.loads(geometry),
    )


def _one(
    db: duckdb.DuckDBPyConnection, sql: str, params: dict[str, object] | None = None
) -> tuple[Any, ...]:
    """Execute a single-row query, raising rather than silently returning ``None``.

    DuckDB types ``fetchone()`` as optional. Every query here is an aggregate that
    always yields exactly one row, so ``None`` means something is genuinely wrong and
    must not be unpacked into a tuple of ``NoneType``.
    """
    row = db.execute(sql, params or {}).fetchone()
    if row is None:
        raise RuntimeError(f"expected exactly one row from query: {sql}")
    return tuple(row)


def _spatial(db: duckdb.DuckDBPyConnection) -> str:
    """Version of the loaded spatial extension, or ``unknown`` if absent."""
    row = db.execute(
        "SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'spatial'"
    ).fetchone()
    return str(row[0]) if row and row[0] else "unknown"


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the API. ``settings`` defaults to the environment-derived singleton."""
    resolved = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Fail fast: a missing lake should stop the process, not surface as an opaque
        # 500 on the first request.
        resolved.require_ready()

        con = connect(spatial=False)
        try:
            spatial_version = load_spatial(con)
            register_lake_views(con, resolved)
            sql, _ = queries.health_counts_sql()
            tract_count, building_count, max_building_count = _one(con, sql)

            app.state.settings = resolved
            app.state.db = con
            app.state.spatial_version = spatial_version
            app.state.duckdb_version = duckdb.__version__

            logger.info(
                "ready | %s tracts (densest %s), %s buildings | duckdb %s | spatial %s | %s",
                f"{tract_count:,}",
                f"{max_building_count:,}",
                f"{building_count:,}",
                duckdb.__version__,
                spatial_version,
                resolved.data_dir,
            )
            yield
        finally:
            con.close()
            logger.info("closed duckdb connection")

    app = FastAPI(
        title="Analytical Spatial Lakehouse",
        version=__version__,
        summary="DuckDB + GeoParquet spatial analytics served as GeoJSON to deck.gl.",
        lifespan=lifespan,
    )

    # Explicit origin allowlist from config — not "*".
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_origins,
        allow_methods=["GET"],
        allow_headers=["*"],
        expose_headers=[HEADER_QUERY_TIME_MS, HEADER_FEATURE_COUNT, "X-Request-Id"],
    )
    # 5,000 GeoJSON polygons compress roughly 10x; this is the cheapest latency win available.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    @app.middleware("http")
    async def trace_requests(request: Request, call_next: Any) -> Response:
        request_id = uuid.uuid4().hex[:8]
        started = time.perf_counter()
        response: Response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers["X-Request-Id"] = request_id
        logger.info(
            "%s %s -> %d in %.1fms rid=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            request_id,
        )
        return response

    @app.get("/", include_in_schema=False)
    def root() -> JSONResponse:
        return JSONResponse(
            {
                "service": "datalake",
                "version": __version__,
                "docs": "/docs",
                "endpoints": ["/api/tracts", "/api/join", "/api/health"],
            }
        )

    @app.get("/api/health", response_model=HealthResponse, tags=["meta"])
    def health(db: DbDep, settings_dep: SettingsDep) -> HealthResponse:
        sql, _ = queries.health_counts_sql()
        tract_count, building_count, max_building_count = _one(db, sql)
        return HealthResponse(
            tract_count=int(tract_count),
            building_count=int(building_count),
            max_building_count=int(max_building_count or 0),
            duckdb_version=str(_one(db, "SELECT version()")[0]),
            spatial_version=_spatial(db),
            data_dir=str(settings_dep.data_dir),
        )

    @app.get(
        "/api/tracts",
        response_model=FeatureCollection,
        tags=["analytics"],
        summary="Materialised per-tract building statistics as GeoJSON.",
    )
    def get_tracts(
        response: Response,
        db: DbDep,
        bbox: Annotated[BBox | None, Depends(parse_bbox)] = None,
        min_count: Annotated[
            int, Query(ge=0, description="Drop tracts with fewer buildings than this.")
        ] = 0,
    ) -> FeatureCollection:
        sql, params = queries.tracts_sql(bbox, min_count)
        started = time.perf_counter()
        try:
            rows = db.execute(sql, params).fetchall()
        except duckdb.Error as exc:
            logger.exception("tract query failed | bbox=%s min_count=%s", bbox, min_count)
            raise HTTPException(status_code=503, detail="Spatial query failed") from exc
        elapsed_ms = (time.perf_counter() - started) * 1000

        features = [_to_feature(row) for row in rows]
        response.headers[HEADER_QUERY_TIME_MS] = f"{elapsed_ms:.2f}"
        response.headers[HEADER_FEATURE_COUNT] = str(len(features))
        logger.debug("served %d tracts in %.2fms", len(features), elapsed_ms)
        return FeatureCollection(features=features)

    @app.get(
        "/api/join",
        response_model=JoinResponse,
        tags=["analytics"],
        summary="On-demand exact ST_Intersects join, bounded to max_join_tracts.",
    )
    def get_live_join(
        db: DbDep,
        settings_dep: SettingsDep,
        bbox: Annotated[BBox | None, Depends(parse_bbox)] = None,
    ) -> JoinResponse:
        cap = settings_dep.max_join_tracts
        scope_sql, scope_params = queries.live_join_scope_sql(bbox, cap)
        join_sql, join_params = queries.live_join_sql(bbox, cap)

        started = time.perf_counter()
        try:
            in_scope = int(_one(db, scope_sql, scope_params)[0])
            rows = db.execute(join_sql, join_params).fetchall()
        except duckdb.Error as exc:
            logger.exception("live join failed | bbox=%s cap=%s", bbox, cap)
            raise HTTPException(status_code=503, detail="Spatial join failed") from exc
        elapsed_ms = (time.perf_counter() - started) * 1000

        tracts = [
            TractJoinStat(geoid=str(g), building_count=int(n), avg_height_m=float(a))
            for g, n, a in rows
        ]
        return JoinResponse(
            tracts_in_scope=in_scope,
            tracts_matched=len(tracts),
            buildings_matched=sum(t.building_count for t in tracts),
            truncated=in_scope >= cap,
            query_time_ms=elapsed_ms,
            tracts=tracts,
        )

    return app


app = create_app()


def main() -> None:
    """Console entry point: ``uv run datalake-api``."""
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    uvicorn.run("datalake.main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
