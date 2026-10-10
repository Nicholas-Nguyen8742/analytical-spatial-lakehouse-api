"""Generate the synthetic lake: tract polygons and building points as Parquet.

Design notes
------------
Geometry is **not** materialised for buildings. Two million points are written as plain
``x``/``y`` DOUBLE columns and turned into ``GEOMETRY`` with ``ST_Point`` at ETL time.
That keeps the file ~3x smaller, makes column pruning effective, and avoids building two
million Shapely objects in Python — which is where the naive ``geopandas`` approach spends
minutes and gigabytes.

Tracts *do* carry a WKB ``geometry`` column, because there are only 5,000 of them and the
aggregate step joins against real polygon geometry rather than a bounding box.

Determinism comes from ``hash()`` rather than ``random()``: DuckDB's hash is a pure
function of its input, so the same seed reproduces byte-identical output across runs and
across machines, independent of query parallelism. ``setseed()`` only guarantees
reproducibility within one session.

Usage::

    uv run python -m datalake.generate_data [--seed N] [--buildings N] [--data-dir PATH]
"""

from __future__ import annotations

import argparse
import logging
import time
from dataclasses import dataclass, replace
from pathlib import Path

import duckdb

from datalake.db import connect, path_literal
from datalake.settings import get_settings
from datalake.spec import CANDIDATE_MULTIPLIER, DEFAULT_SPEC, DatasetSpec, d

logger = logging.getLogger(__name__)

_HASH_MOD = 1_000_000_007

# Distinct multipliers per uniform draw so the four streams are decorrelated.
# Products stay well inside BIGINT range for candidate counts up to ~3e9.
_MIX_X = 1
_MIX_Y = 2_654_435_761
_MIX_ACCEPT = 40_503
_MIX_HEIGHT = 2_246_822_519


@dataclass(frozen=True, slots=True)
class GenerationReport:
    """What was written, and how long it took."""

    tracts_path: Path
    buildings_path: Path
    tract_count: int
    building_count: int
    elapsed_s: float

    def describe(self) -> str:
        return (
            f"{self.tract_count:,} tracts -> {self.tracts_path.name}, "
            f"{self.building_count:,} buildings -> {self.buildings_path.name} "
            f"in {self.elapsed_s:.1f}s"
        )


def _uniform(column: str, seed: int, mix: int) -> str:
    """SQL expression yielding a deterministic uniform in [0, 1).

    ``mix`` decorrelates the streams from one another; ``seed`` shifts all of them
    together so that ``--seed`` really does produce a different city.
    """
    return f"(hash({column} * {mix} + {seed}) % {_HASH_MOD})::DOUBLE / {d(float(_HASH_MOD))}"


def _tracts_sql(spec: DatasetSpec, dest: Path) -> str:
    bbox = spec.bbox
    cw, ch = d(spec.cell_width), d(spec.cell_height)
    xmin, ymin = d(bbox.x_min), d(bbox.y_min)
    row, col = "r.row_idx", "c.col_idx"

    def x_of(c: str) -> str:
        return f"{xmin} + {c} * {cw}"

    def y_of(r: str) -> str:
        return f"{ymin} + {r} * {ch}"

    return f"""
        COPY (
            SELECT
                'tract_' || lpad(({row} * {spec.cols} + {col})::VARCHAR, 5, '0') AS geoid,
                {col} AS col_idx,
                {row} AS row_idx,
                {x_of(col)} AS x0,
                {y_of(row)} AS y0,
                {x_of(f"({col} + 1)")} AS x1,
                {y_of(f"({row} + 1)")} AS y1,
                ST_AsWKB(
                    ST_MakeEnvelope(
                        {x_of(col)},
                        {y_of(row)},
                        {x_of(f"({col} + 1)")},
                        {y_of(f"({row} + 1)")}
                    )
                ) AS geometry
            FROM generate_series(0, {spec.rows - 1}) AS r(row_idx),
                 generate_series(0, {spec.cols - 1}) AS c(col_idx)
        ) TO {path_literal(dest)} (FORMAT PARQUET, COMPRESSION ZSTD)
    """


def _buildings_sql(spec: DatasetSpec, dest: Path) -> str:
    bbox = spec.bbox
    seed = spec.seed
    ux = _uniform("i", seed, _MIX_X)
    uy = _uniform("i", seed, _MIX_Y)
    ua = _uniform("i", seed, _MIX_ACCEPT)
    uh = _uniform("i", seed, _MIX_HEIGHT)
    density = spec.density_expr("x", "y")
    height = spec.height_expr("uh", "d")

    return f"""
        COPY (
            WITH placed AS (
                SELECT
                    i AS id,
                    {d(bbox.x_min)} + ({ux}) * {d(bbox.width)} AS x,
                    {d(bbox.y_min)} + ({uy}) * {d(bbox.height)} AS y,
                    {ua} AS ua,
                    {uh} AS uh
                FROM generate_series(1, {spec.building_candidates}) AS t(i)
            ),
            accepted AS (
                SELECT id, x, y, uh, {density} AS d
                FROM placed
                WHERE ua < d
            )
            SELECT id, x, y, {height} AS height_m
            FROM (SELECT *, row_number() OVER (ORDER BY id) AS rn FROM accepted)
            WHERE rn <= {spec.building_target}
        ) TO {path_literal(dest)} (FORMAT PARQUET, COMPRESSION ZSTD)
    """


def _validate_counts(spec: DatasetSpec, tract_count: int, building_count: int) -> None:
    if tract_count != spec.tract_count:
        raise RuntimeError(
            f"expected {spec.tract_count:,} tracts, wrote {tract_count:,} — grid generation broke"
        )
    if building_count != spec.building_target:
        raise RuntimeError(
            f"expected {spec.building_target:,} buildings, wrote {building_count:,}. "
            f"Rejection sampling accepted too few of {spec.building_candidates:,} candidates; "
            "raise building_candidates or lower building_target."
        )


def generate(spec: DatasetSpec, data_dir: Path) -> GenerationReport:
    """Write ``tracts.parquet`` and ``buildings.parquet`` into ``data_dir``.

    Files are staged as ``*.partial`` and promoted into place only after their row
    counts are verified, so a failed run cannot leave a truncated artifact that
    :mod:`datalake.build_summary` would then silently aggregate.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    tracts_path = data_dir / "tracts.parquet"
    buildings_path = data_dir / "buildings.parquet"
    staged = (
        tracts_path.with_name(tracts_path.name + ".partial"),
        buildings_path.with_name(buildings_path.name + ".partial"),
    )

    started = time.perf_counter()
    con = connect(spatial=True)
    succeeded = False
    try:
        logger.info("generating %s tracts", f"{spec.tract_count:,}")
        con.execute(_tracts_sql(spec, staged[0]))

        logger.info(
            "generating %s buildings from %s candidates",
            f"{spec.building_target:,}",
            f"{spec.building_candidates:,}",
        )
        con.execute(_buildings_sql(spec, staged[1]))

        tract_count = _count(con, staged[0])
        building_count = _count(con, staged[1])
        _validate_counts(spec, tract_count, building_count)
        succeeded = True
    finally:
        con.close()
        if not succeeded:
            for path in staged:
                path.unlink(missing_ok=True)

    for stage, final in zip(staged, (tracts_path, buildings_path), strict=True):
        stage.replace(final)

    report = GenerationReport(
        tracts_path=tracts_path,
        buildings_path=buildings_path,
        tract_count=tract_count,
        building_count=building_count,
        elapsed_s=time.perf_counter() - started,
    )
    logger.info("generation complete: %s", report.describe())
    return report


def _count(con: duckdb.DuckDBPyConnection, path: Path) -> int:
    row = con.execute(f"SELECT count(*) FROM read_parquet({path_literal(path)})").fetchone()
    return int(row[0]) if row else 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="datalake.generate_data", description=__doc__)
    parser.add_argument("--seed", type=int, default=None, help="override the dataset seed")
    parser.add_argument(
        "--buildings", type=int, default=None, help="override the target building count"
    )
    parser.add_argument("--data-dir", type=Path, default=None, help="override the lake directory")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = _parse_args(argv)

    spec = DEFAULT_SPEC
    overrides: dict[str, object] = {}
    if args.seed is not None:
        overrides["seed"] = args.seed
    if args.buildings is not None:
        overrides["building_target"] = args.buildings
        overrides["building_candidates"] = args.buildings * CANDIDATE_MULTIPLIER
    if overrides:
        spec = replace(spec, **overrides)  # type: ignore[arg-type]

    data_dir = args.data_dir or get_settings().data_dir
    report = generate(spec, data_dir)
    print(report.describe())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
