"""SQL for the serving layer.

Two rules hold throughout:

1. Every *value* is a bound parameter. Nothing from a request is ever interpolated
   into SQL text.
2. Every *identifier* — view and column names — comes from the fixed allowlists below,
   never from request data. The optional-bbox predicate is assembled from those
   constants, so building the WHERE clause dynamically introduces no injection surface.

The serving layer needs no spatial functions at all: ``summary.parquet`` carries both
the GeoJSON geometry text and the tract bounding-box columns, so viewport filtering is
plain numeric comparison over a columnar file.
"""

from __future__ import annotations

from datalake.db import VIEW_BUILDINGS, VIEW_SUMMARY, VIEW_TRACTS
from datalake.models import BBox

Sql = tuple[str, dict[str, object]]

SUMMARY_COLUMNS = "geoid, geometry, building_count, avg_height_m, p95_height_m"

_TRACT_COLUMNS = ("x0", "y0", "x1", "y1")


def _bbox_predicate(bbox: BBox | None, params: dict[str, object]) -> list[str]:
    """Append bbox params and return the predicate fragments.

    Column names are drawn from :data:`_TRACT_COLUMNS`; only values are bound.
    """
    if bbox is None:
        return []
    params.update(
        {
            "min_x": bbox.min_x,
            "min_y": bbox.min_y,
            "max_x": bbox.max_x,
            "max_y": bbox.max_y,
        }
    )
    # A tract intersects the viewport when it is not wholly outside it on any axis.
    return ["x1 >= $min_x", "x0 <= $max_x", "y1 >= $min_y", "y0 <= $max_y"]


def tracts_sql(bbox: BBox | None, min_count: int) -> Sql:
    """Serve the materialised aggregate, optionally filtered by viewport and count."""
    params: dict[str, object] = {"min_count": min_count}
    clauses = ["building_count >= $min_count", *_bbox_predicate(bbox, params)]
    return (
        f"SELECT {SUMMARY_COLUMNS} FROM {VIEW_SUMMARY} WHERE {' AND '.join(clauses)}",
        params,
    )


def live_join_scope_sql(bbox: BBox | None, max_tracts: int) -> Sql:
    """Count how many tracts fall in scope, to report truncation honestly."""
    params: dict[str, object] = {"max_tracts": max_tracts}
    clauses = _bbox_predicate(bbox, params)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return (
        f"SELECT count(*) FROM (SELECT 1 FROM {VIEW_TRACTS} {where} LIMIT $max_tracts)",
        params,
    )


def live_join_sql(bbox: BBox | None, max_tracts: int) -> Sql:
    """Exact ``ST_Intersects`` join, bounded to at most ``max_tracts`` tracts.

    This is the raw spatial capability the materialised summary exists to avoid paying
    for on every request. It is capped so a client cannot turn one query into a
    full-dataset scan regardless of the bbox it sends.
    """
    params: dict[str, object] = {"max_tracts": max_tracts}
    clauses = _bbox_predicate(bbox, params)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return (
        f"""
        WITH target AS (
            SELECT geoid, ST_GeomFromWKB(geometry) AS geom
            FROM {VIEW_TRACTS}
            {where}
            LIMIT $max_tracts
        )
        SELECT t.geoid, count(*) AS building_count, avg(b.height_m) AS avg_height_m
        FROM target AS t
        JOIN {VIEW_BUILDINGS} AS b ON ST_Intersects(t.geom, ST_Point(b.x, b.y))
        GROUP BY t.geoid
        """,
        params,
    )


def health_counts_sql() -> Sql:
    """Row counts and the density ceiling for the readiness probe.

    ``max_building_count`` lets the client fix its density-filter range to the dataset
    rather than to whatever subset is currently on screen, which would otherwise make
    the slider's own maximum collapse the moment a filter excludes everything.
    """
    return (
        f"""
        SELECT
            (SELECT count(*) FROM {VIEW_SUMMARY}),
            (SELECT count(*) FROM {VIEW_BUILDINGS}),
            (SELECT max(building_count) FROM {VIEW_SUMMARY})
        """,
        {},
    )
