"""Materialise the tract-level aggregate — the ETL half of the lakehouse.

This is where the spatial compute happens: an exact ``ST_Intersects`` join of every
building point against every tract polygon, aggregated to per-tract statistics and
written to ``summary.parquet``. The API only ever reads that file, so a map pan costs a
columnar scan of 5,000 rows instead of a 2M-row spatial join.

Why the exact join and not a grid-key equi-join
----------------------------------------------
Because the tracts are a regular grid, tract membership can be computed
arithmetically with ``floor((x - x_min) / cell_w)``, which is a pure hash join. It is
faster — but it is an *approximation*. Measured against ``ST_Contains`` on 200,000
points it disagreed on 43 of them (0.02%), because fixed-point cell boundaries and
DOUBLE division round differently. Shipping a silently-inexact aggregate to save 180ms
once, at build time, is a bad trade. So we pay for exactness.

DuckDB 1.5.6 has no ``CREATE SPATIAL INDEX ... USING RTREE`` — the statement is a
syntax error. The spatial extension nevertheless applies its own bounding-box
pre-filter to ``ST_Intersects`` joins, which puts the full 2M x 5,000 join at ~200ms.
This module measures and logs that figure rather than assuming it.

Usage::

    uv run python -m datalake.build_summary [--data-dir PATH]
"""

from __future__ import annotations

import argparse
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import duckdb

from datalake.db import connect, path_literal
from datalake.settings import Settings, get_settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SummaryReport:
    """What the build produced, and what it cost."""

    summary_path: Path
    tract_count: int
    building_count: int
    matched_buildings: int
    tracts_with_buildings: int
    join_ms: float
    total_ms: float

    def describe(self) -> str:
        pct = 100.0 * self.tracts_with_buildings / self.tract_count if self.tract_count else 0.0
        return (
            f"{self.tract_count:,} tracts ({self.tracts_with_buildings:,} populated, {pct:.1f}%), "
            f"{self.matched_buildings:,}/{self.building_count:,} buildings matched "
            f"— exact spatial join in {self.join_ms:.0f} ms, build total {self.total_ms:.1f}s "
            f"-> {self.summary_path.name}"
        )


_AGGREGATE_SQL = """
    COPY (
        WITH agg AS (
            SELECT
                t.geoid,
                count(*) AS building_count,
                avg(b.height_m) AS avg_height_m,
                quantile_cont(b.height_m, 0.95) AS p95_height_m
            FROM buildings AS b
            JOIN tracts AS t ON ST_Intersects(t.geom, b.geom)
            GROUP BY t.geoid
        )
        SELECT
            t.geoid,
            t.x0, t.y0, t.x1, t.y1,
            ST_AsGeoJSON(t.geom) AS geometry,
            coalesce(a.building_count, 0)::BIGINT AS building_count,
            a.avg_height_m,
            a.p95_height_m
        FROM tracts AS t
        LEFT JOIN agg AS a USING (geoid)
    ) TO {dest} (FORMAT PARQUET, COMPRESSION ZSTD)
"""


def build(settings: Settings) -> SummaryReport:
    """Join, aggregate and write ``summary.parquet``.

    Raises ``FileNotFoundError`` if the lake has not been generated, and
    ``RuntimeError`` if the join loses or duplicates any building — the failure mode
    that silently corrupts every downstream statistic.
    """
    settings.require_inputs()

    final = settings.summary_path
    staged = final.with_name(final.name + ".partial")

    started = time.perf_counter()
    con = connect(spatial=True)
    succeeded = False
    try:
        con.execute(
            f"""
            CREATE TEMP TABLE tracts AS
            SELECT geoid, x0, y0, x1, y1, ST_GeomFromWKB(geometry) AS geom
            FROM read_parquet({path_literal(settings.tracts_path)})
            """
        )
        con.execute(
            f"""
            CREATE TEMP TABLE buildings AS
            SELECT id, height_m, ST_Point(x, y) AS geom
            FROM read_parquet({path_literal(settings.buildings_path)})
            """
        )

        tract_count = _scalar(con, "SELECT count(*) FROM tracts")
        building_count = _scalar(con, "SELECT count(*) FROM buildings")
        logger.info(
            "joining %s buildings against %s tracts",
            f"{building_count:,}",
            f"{tract_count:,}",
        )

        join_started = time.perf_counter()
        con.execute(_AGGREGATE_SQL.format(dest=path_literal(staged)))
        join_ms = (time.perf_counter() - join_started) * 1000

        matched = _scalar(
            con, f"SELECT sum(building_count) FROM read_parquet({path_literal(staged)})"
        )
        populated = _scalar(
            con,
            f"SELECT count(*) FROM read_parquet({path_literal(staged)}) WHERE building_count > 0",
        )
        _validate(building_count, matched, tract_count, populated)
        succeeded = True
    finally:
        con.close()
        if not succeeded:
            staged.unlink(missing_ok=True)

    staged.replace(final)

    report = SummaryReport(
        summary_path=final,
        tract_count=int(tract_count),
        building_count=int(building_count),
        matched_buildings=int(matched),
        tracts_with_buildings=int(populated),
        join_ms=join_ms,
        total_ms=time.perf_counter() - started,
    )
    logger.info("summary build complete: %s", report.describe())
    return report


def _validate(building_count: int, matched: int, tract_count: int, populated: int) -> None:
    """Assert the join conserved every row.

    ``sum(building_count)`` over the aggregate must equal the number of buildings that
    went in. Less means points were dropped outside the grid; more means tracts
    overlap and points were double-counted. Either way every statistic served from
    this file would be wrong.
    """
    if matched != building_count:
        raise RuntimeError(
            f"spatial join is not row-conserving: {building_count:,} buildings in, "
            f"{matched:,} matched. Points were dropped (under-coverage) or double-counted "
            "(overlapping tracts)."
        )
    if populated > tract_count:
        raise RuntimeError(f"aggregate produced {populated:,} rows for {tract_count:,} tracts")


def _scalar(con: duckdb.DuckDBPyConnection, sql: str) -> int:
    row = con.execute(sql).fetchone()
    if row is None or row[0] is None:
        return 0
    return int(row[0])


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="datalake.build_summary", description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=None, help="override the lake directory")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = _parse_args(argv)

    settings = get_settings()
    if args.data_dir is not None:
        settings = settings.model_copy(update={"data_dir": args.data_dir})

    print(build(settings).describe())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
