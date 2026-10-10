"""Tests for the DuckDB connection layer, including the path-quoting guard."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from datalake.db import (
    VIEW_BUILDINGS,
    VIEW_SUMMARY,
    VIEW_TRACTS,
    connect,
    iter_cursor,
    load_spatial,
    path_literal,
    register_lake_views,
)
from datalake.settings import Settings


def test_path_literal_uses_forward_slashes_on_windows(tmp_path: Path) -> None:
    """Windows backslashes would otherwise need escaping inside SQL string literals."""
    target = tmp_path / "nested" / "tracts.parquet"
    target.parent.mkdir(parents=True)
    target.touch()

    assert path_literal(target) == f"'{target.resolve().as_posix()}'"


def test_path_literal_rejects_embedded_quotes(tmp_path: Path) -> None:
    """The injection guard. A path containing a quote must fail here, not become SQL."""
    hostile = tmp_path / "x'); DROP TABLE tracts; --.parquet"
    with pytest.raises(ValueError, match="single quote"):
        path_literal(hostile)


def test_connect_without_spatial_leaves_the_extension_unloaded() -> None:
    con = connect(spatial=False)
    try:
        with pytest.raises(duckdb.Error):
            con.execute("SELECT ST_AsText(ST_Point(0, 0))")
    finally:
        con.close()


def test_connect_with_spatial_can_run_geospatial_sql() -> None:
    con = connect(spatial=True)
    try:
        assert con.execute("SELECT ST_AsText(ST_Point(1, 2))").fetchone()[0] == "POINT (1 2)"
    finally:
        con.close()


def test_load_spatial_reports_a_real_version() -> None:
    con = connect(spatial=False)
    try:
        version = load_spatial(con)
    finally:
        con.close()

    assert version not in ("", "unknown")


def test_load_spatial_is_idempotent() -> None:
    con = connect(spatial=False)
    try:
        first = load_spatial(con)
        second = load_spatial(con)
    finally:
        con.close()

    assert first == second


def test_register_lake_views_exposes_all_three(complete_lake: Settings) -> None:
    con = connect(spatial=True)
    try:
        register_lake_views(con, complete_lake)
        for view in (VIEW_TRACTS, VIEW_BUILDINGS, VIEW_SUMMARY):
            assert con.execute(f"SELECT count(*) FROM {view}").fetchone()[0] > 0
    finally:
        con.close()


def test_register_lake_views_survives_being_called_twice(complete_lake: Settings) -> None:
    """Server restarts and test reuse both re-register; CREATE OR REPLACE must not fail."""
    con = connect(spatial=True)
    try:
        register_lake_views(con, complete_lake)
        register_lake_views(con, complete_lake)
        assert con.execute(f"SELECT count(*) FROM {VIEW_SUMMARY}").fetchone()[0] > 0
    finally:
        con.close()


def test_cursor_shares_the_parent_catalog(complete_lake: Settings) -> None:
    """The concurrency model depends on cursors seeing the parent's views."""
    con = connect(spatial=True)
    try:
        register_lake_views(con, complete_lake)
        for cursor in iter_cursor(con):
            assert cursor.execute(f"SELECT count(*) FROM {VIEW_TRACTS}").fetchone()[0] > 0
    finally:
        con.close()


def test_concurrent_cursors_do_not_interfere(complete_lake: Settings) -> None:
    """FastAPI runs sync endpoints on a threadpool, so cursors are used concurrently."""
    from concurrent.futures import ThreadPoolExecutor

    con = connect(spatial=True)
    try:
        register_lake_views(con, complete_lake)

        def query(_: int) -> int:
            cursor = con.cursor()
            try:
                return int(cursor.execute(f"SELECT count(*) FROM {VIEW_SUMMARY}").fetchone()[0])
            finally:
                cursor.close()

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(query, range(32)))
    finally:
        con.close()

    assert len(set(results)) == 1, f"concurrent cursors disagreed: {set(results)}"
