"""Tests for the ETL step that materialises ``summary.parquet``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from datalake.build_summary import build
from datalake.db import connect, path_literal
from datalake.generate_data import generate
from datalake.settings import Settings
from datalake.spec import DatasetSpec


@pytest.fixture
def settings_for(tmp_path: Path, small_spec: DatasetSpec) -> Settings:
    generate(small_spec, tmp_path)
    return Settings(data_dir=tmp_path)


def _scalar(path: Path, sql: str) -> object:
    con = connect(spatial=False)
    try:
        return con.execute(sql.replace("__P__", path_literal(path))).fetchone()[0]
    finally:
        con.close()


def test_build_reports_every_building_matched(
    settings_for: Settings, small_spec: DatasetSpec
) -> None:
    """The row-conservation invariant: a spatial join that drops or duplicates points
    silently corrupts every statistic served downstream."""
    report = build(settings_for)

    assert report.tract_count == small_spec.tract_count
    assert report.building_count == small_spec.building_target
    assert report.matched_buildings == report.building_count
    assert report.join_ms > 0


def test_summary_row_count_matches_tract_count(
    settings_for: Settings, small_spec: DatasetSpec
) -> None:
    build(settings_for)
    rows = _scalar(settings_for.summary_path, "SELECT count(*) FROM __P__")
    assert rows == small_spec.tract_count


def test_per_tract_counts_sum_to_the_building_total(
    settings_for: Settings, small_spec: DatasetSpec
) -> None:
    build(settings_for)
    total = _scalar(settings_for.summary_path, "SELECT sum(building_count) FROM __P__")
    buildings = _scalar(settings_for.buildings_path, "SELECT count(*) FROM __P__")
    assert total == buildings == small_spec.building_target


def test_every_tract_carries_a_parseable_geojson_polygon(settings_for: Settings) -> None:
    """Guards the defect in the original plan, which called ``json.loads`` on a raw
    WKB blob and would have thrown on the first row."""
    build(settings_for)

    con = connect(spatial=False)
    try:
        geometries = [
            r[0]
            for r in con.execute(
                f"SELECT geometry FROM read_parquet({path_literal(settings_for.summary_path)})"
            ).fetchall()
        ]
    finally:
        con.close()

    assert geometries
    for raw in geometries:
        parsed = json.loads(raw)
        assert parsed["type"] == "Polygon"
        ring = parsed["coordinates"][0]
        assert len(ring) == 5, "polygon ring must be closed"
        assert ring[0] == ring[-1]


def test_tracts_with_no_buildings_still_appear(tmp_path: Path) -> None:
    """A LEFT JOIN, not an INNER one: empty tracts must survive so the map shows gaps
    instead of holes."""
    from datalake.spec import BBox, DensityCenter

    sparse = DatasetSpec(
        bbox=BBox(x_min=0.0, y_min=0.0, x_max=1.0, y_max=1.0),
        cols=10,
        rows=10,
        seed=3,
        building_target=200,
        building_candidates=800_000,
        # One tight kernel in a single corner leaves most of the grid empty.
        centers=(DensityCenter(lon=0.05, lat=0.05, weight=1.0, sigma_lon=0.01, sigma_lat=0.01),),
        base_density=0.0,
    )
    generate(sparse, tmp_path)
    report = build(Settings(data_dir=tmp_path))

    assert report.tracts_with_buildings < report.tract_count
    assert report.matched_buildings == sparse.building_target

    empties = _scalar(
        report.summary_path,
        "SELECT count(*) FROM __P__ WHERE building_count = 0",
    )
    assert int(empties) == report.tract_count - report.tracts_with_buildings


def test_build_is_idempotent(settings_for: Settings) -> None:
    first = build(settings_for)
    second = build(settings_for)

    assert first.tract_count == second.tract_count
    assert first.matched_buildings == second.matched_buildings
    assert list(settings_for.data_dir.glob("*.partial")) == []


def test_missing_inputs_raise_with_an_actionable_message(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)
    with pytest.raises(FileNotFoundError, match="generate_data"):
        build(settings)
