"""Shared pytest fixtures.

Tests run against a deliberately tiny :class:`~datalake.spec.DatasetSpec` in a
``tmp_path`` so the suite finishes in seconds instead of the minutes the full
2M-building lake needs.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import duckdb
import pytest

from datalake.build_summary import build
from datalake.db import connect
from datalake.generate_data import generate
from datalake.settings import Settings
from datalake.spec import BBox, DatasetSpec, DensityCenter


@pytest.fixture
def small_spec() -> DatasetSpec:
    """40 tracts, 2,000 buildings — same shape as production, ~1000x smaller."""
    return DatasetSpec(
        bbox=BBox(x_min=-122.52, y_min=37.70, x_max=-122.36, y_max=37.82),
        cols=8,
        rows=5,
        seed=7,
        building_target=2_000,
        building_candidates=80_000,
        centers=(
            DensityCenter(lon=-122.44, lat=37.77, weight=0.90, sigma_lon=0.020, sigma_lat=0.020),
        ),
        base_density=0.05,
    )


@pytest.fixture
def spatial_con() -> Iterator[duckdb.DuckDBPyConnection]:
    """An in-memory DuckDB connection with the spatial extension loaded."""
    con = connect(spatial=True)
    try:
        yield con
    finally:
        con.close()


@pytest.fixture
def complete_lake(small_spec: DatasetSpec, tmp_path: Path) -> Settings:
    """A fully built lake — generated *and* aggregated — as ready-to-use Settings.

    Both steps are required: :func:`datalake.db.register_lake_views` opens a view over
    ``summary.parquet``, so a lake without the aggregate cannot be served at all.
    """
    generate(small_spec, tmp_path)
    settings = Settings(data_dir=tmp_path)
    build(settings)
    return settings
