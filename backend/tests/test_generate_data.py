"""Tests for the synthetic lake generator."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import duckdb
import pytest

from datalake.db import connect, path_literal
from datalake.generate_data import generate
from datalake.spec import BBox, DatasetSpec


def _rows(path: Path, sql: str) -> list[tuple[object, ...]]:
    con = connect(spatial=False)
    try:
        return con.execute(sql.replace("__P__", path_literal(path))).fetchall()
    finally:
        con.close()


def test_writes_the_expected_row_counts(small_spec: DatasetSpec, tmp_path: Path) -> None:
    report = generate(small_spec, tmp_path)

    assert report.tract_count == small_spec.tract_count == 40
    assert report.building_count == small_spec.building_target
    assert report.tracts_path.is_file()
    assert report.buildings_path.is_file()


def test_tract_geoids_are_unique_and_dense(small_spec: DatasetSpec, tmp_path: Path) -> None:
    generate(small_spec, tmp_path)
    (distinct, total, blank) = _rows(
        tmp_path / "tracts.parquet",
        "SELECT count(DISTINCT geoid), count(*), count(*) FILTER (WHERE geoid = '') FROM __P__",
    )[0]
    assert distinct == total == small_spec.tract_count
    assert blank == 0


def test_tract_polygons_are_valid_and_tiled(
    small_spec: DatasetSpec, tmp_path: Path, spatial_con: duckdb.DuckDBPyConnection
) -> None:
    """Grid must be a non-overlapping tiling — the defect in the original plan was
    5,000 randomly-placed overlapping squares, which renders as visual noise."""
    generate(small_spec, tmp_path)
    lit = path_literal(tmp_path / "tracts.parquet")

    invalid, total_area = spatial_con.execute(
        f"""
        SELECT
          count(*) FILTER (WHERE NOT ST_IsValid(ST_GeomFromWKB(geometry))),
          sum(ST_Area(ST_GeomFromWKB(geometry)))
        FROM read_parquet({lit})
        """
    ).fetchone()

    # Computed in Python, not SQL: a bare `0.16 * 0.12` literal is DECIMAL in DuckDB
    # and cannot be compared against the DOUBLE sum returned by ST_Area.
    grid_area = small_spec.bbox.width * small_spec.bbox.height

    assert invalid == 0
    # Non-overlapping tiling: sum of cell areas equals the bbox area.
    assert float(total_area) == pytest.approx(grid_area, rel=1e-9)


def test_buildings_land_strictly_inside_the_bbox(small_spec: DatasetSpec, tmp_path: Path) -> None:
    generate(small_spec, tmp_path)
    (outside, lo_x, hi_x, lo_y, hi_y) = _rows(
        tmp_path / "buildings.parquet",
        f"""
        SELECT
          count(*) FILTER (
            WHERE x < {small_spec.bbox.x_min!r} OR x >= {small_spec.bbox.x_max!r}
               OR y < {small_spec.bbox.y_min!r} OR y >= {small_spec.bbox.y_max!r}
          ),
          min(x), max(x), min(y), max(y)
        FROM __P__
        """,
    )[0]

    assert outside == 0, "points outside the bbox would be silently dropped by the join"
    assert float(lo_x) >= small_spec.bbox.x_min
    assert float(hi_x) < small_spec.bbox.x_max
    assert float(lo_y) >= small_spec.bbox.y_min
    assert float(hi_y) < small_spec.bbox.y_max


def test_heights_are_positive_and_within_bounds(small_spec: DatasetSpec, tmp_path: Path) -> None:
    generate(small_spec, tmp_path)
    (lo, hi, n) = _rows(
        tmp_path / "buildings.parquet",
        "SELECT min(height_m), max(height_m), count(*) FILTER (WHERE height_m IS NULL) FROM __P__",
    )[0]

    assert n == 0
    assert float(lo) >= small_spec.min_height_m
    assert float(hi) <= small_spec.max_height_m


def test_generation_is_reproducible_for_a_seed(small_spec: DatasetSpec, tmp_path: Path) -> None:
    """Same seed must yield identical rows — a reviewer cloning the repo has to see
    the same map every time."""
    generate(small_spec, tmp_path / "a")
    generate(small_spec, tmp_path / "b")

    for name in ("tracts.parquet", "buildings.parquet"):
        left = _rows(tmp_path / "a" / name, "SELECT * FROM __P__ ORDER BY ALL")
        right = _rows(tmp_path / "b" / name, "SELECT * FROM __P__ ORDER BY ALL")
        assert left == right, f"{name} is not reproducible"


def test_different_seeds_produce_different_cities(small_spec: DatasetSpec, tmp_path: Path) -> None:
    generate(small_spec, tmp_path / "s7")
    generate(replace(small_spec, seed=99), tmp_path / "s99")

    a = _rows(tmp_path / "s7" / "buildings.parquet", "SELECT x, y FROM __P__ ORDER BY id")
    b = _rows(tmp_path / "s99" / "buildings.parquet", "SELECT x, y FROM __P__ ORDER BY id")
    assert a != b


def test_density_field_concentrates_buildings(small_spec: DatasetSpec, tmp_path: Path) -> None:
    """Rejection sampling must actually produce structure, not uniform noise."""
    generate(small_spec, tmp_path)
    center = small_spec.centers[0]
    (near, far) = _rows(
        tmp_path / "buildings.parquet",
        f"""
        SELECT
          count(*) FILTER (
            WHERE abs(x - {center.lon!r}) < {center.sigma_lon!r}
              AND abs(y - {center.lat!r}) < {center.sigma_lat!r}
          ),
          count(*) FILTER (
            WHERE abs(x - {center.lon!r}) > 4 * {center.sigma_lon!r}
              AND abs(y - {center.lat!r}) > 4 * {center.sigma_lat!r}
          )
        FROM __P__
        """,
    )[0]

    # The core covers ~4% of the bbox area but must hold far more than 4% of buildings.
    assert float(near) > float(far) / 4, f"no density structure: near={near} far={far}"


def test_insufficient_candidates_raises_instead_of_writing_a_short_file(
    small_spec: DatasetSpec, tmp_path: Path
) -> None:
    starved = replace(small_spec, building_target=2_000, building_candidates=2_000)
    with pytest.raises(RuntimeError, match="accepted too few"):
        generate(starved, tmp_path)

    # Neither the truncated artifact nor its staging file may survive: a later
    # build_summary run must fail loudly, not aggregate a partial lake.
    assert not (tmp_path / "buildings.parquet").exists()
    assert not (tmp_path / "buildings.parquet.partial").exists()
    assert list(tmp_path.glob("*.partial")) == []


def test_spec_rejects_degenerate_grid(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="grid dimensions"):
        DatasetSpec(
            bbox=BBox(x_min=0, y_min=0, x_max=1, y_max=1),
            cols=0,
            rows=1,
            seed=1,
            building_target=1,
            building_candidates=1,
            centers=(),
            base_density=0.5,
        )


def test_bbox_rejects_inverted_extent() -> None:
    with pytest.raises(ValueError, match="x_min must be < x_max"):
        BBox(x_min=1.0, y_min=0.0, x_max=0.0, y_max=1.0)
