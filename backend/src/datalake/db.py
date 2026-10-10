"""DuckDB connection management.

DuckDB is in-process — no server, no port, no connection pool to tune. One parent
connection owns the catalog (including the views over the lake files) and each
request takes a :meth:`~duckdb.DuckDBPyConnection.cursor` from it, which is the
supported way to share a single database instance across threads.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

import duckdb

from datalake.settings import Settings

logger = logging.getLogger(__name__)

#: View names registered over the lake files. Fixed identifiers, never interpolated
#: from request data.
VIEW_TRACTS = "tracts_raw"
VIEW_BUILDINGS = "buildings_raw"
VIEW_SUMMARY = "tracts_summary"


def path_literal(path: Path) -> str:
    """Render a filesystem path as a single-quoted SQL literal.

    Paths come from :class:`~datalake.settings.Settings`, never from a request. The
    quote check is defence in depth: a misconfigured ``DATALAKE_DATA_DIR`` should
    raise here rather than become an injection vector.
    """
    resolved = path.resolve().as_posix()
    if "'" in resolved:
        raise ValueError(f"data path must not contain a single quote: {resolved!r}")
    return f"'{resolved}'"


def load_spatial(con: duckdb.DuckDBPyConnection) -> str:
    """Install (if needed) and load the spatial extension, returning its version."""
    try:
        con.execute("INSTALL spatial")
    except duckdb.Error as exc:
        # Already present, or no network. LOAD below raises the real error if unusable.
        logger.debug("INSTALL spatial skipped: %s", exc)
    con.execute("LOAD spatial")
    row = con.execute(
        "SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'spatial'"
    ).fetchone()
    return str(row[0]) if row and row[0] else "unknown"


def connect(*, spatial: bool = True) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB connection.

    In-memory is deliberate: the lake lives in Parquet files that are only ever read
    through ``read_parquet`` views, so the serving process cannot write to them.
    """
    con = duckdb.connect()
    if spatial:
        load_spatial(con)
    return con


def register_lake_views(con: duckdb.DuckDBPyConnection, settings: Settings) -> None:
    """Expose the lake files as named views so query SQL never embeds a path.

    Views are created on the parent connection and are visible to every cursor taken
    from it, which means the path literal is injected exactly once, from trusted config.
    """
    statements = (
        (VIEW_TRACTS, settings.tracts_path),
        (VIEW_BUILDINGS, settings.buildings_path),
        (VIEW_SUMMARY, settings.summary_path),
    )
    for view, path in statements:
        con.execute(
            f"CREATE OR REPLACE VIEW {view} AS SELECT * FROM read_parquet({path_literal(path)})"
        )
    logger.info("registered lake views over %s", settings.data_dir)


def iter_cursor(con: duckdb.DuckDBPyConnection) -> Iterator[duckdb.DuckDBPyConnection]:
    """Yield a thread-local cursor for one request."""
    yield con.cursor()
