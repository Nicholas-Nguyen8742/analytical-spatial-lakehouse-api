"""Runtime configuration, sourced from environment variables.

Everything here is deployment/runtime concern only. The *shape* of the synthetic
dataset lives in :mod:`datalake.spec` so that generation, aggregation and tests all
derive from one definition.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/src/datalake/settings.py -> backend/src/datalake -> src -> backend -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    """Application settings.

    All values may be overridden with a ``DATALAKE_``-prefixed environment variable
    or a ``.env`` file in the working directory.
    """

    model_config = SettingsConfigDict(
        env_prefix="DATALAKE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Field(default_factory=lambda: _REPO_ROOT / "data")

    #: Origins allowed to call the API from a browser. Deliberately not ``["*"]``.
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )

    #: Hard ceiling on tracts the live-join endpoint may scan, to keep worst-case
    #: request latency bounded regardless of the bbox a client supplies.
    max_join_tracts: int = 250

    @field_validator("max_join_tracts")
    @classmethod
    def _positive(cls, value: int) -> int:
        if value < 1:
            raise ValueError("max_join_tracts must be >= 1")
        return value

    @property
    def tracts_path(self) -> Path:
        return self.data_dir / "tracts.parquet"

    @property
    def buildings_path(self) -> Path:
        return self.data_dir / "buildings.parquet"

    @property
    def summary_path(self) -> Path:
        return self.data_dir / "summary.parquet"

    def _require(self, paths: tuple[Path, ...], hint: str) -> None:
        missing = [
            p.relative_to(_REPO_ROOT).as_posix() if p.is_relative_to(_REPO_ROOT) else str(p)
            for p in paths
            if not p.is_file()
        ]
        if missing:
            raise FileNotFoundError(f"Missing lake artifacts: {', '.join(missing)}. {hint}")

    def require_inputs(self) -> None:
        """Fail fast unless the raw lake files exist.

        This is the precondition for :mod:`datalake.build_summary` — deliberately not
        ``require_ready``, since the summary is the very thing that build produces.
        """
        self._require(
            (self.tracts_path, self.buildings_path),
            "Run `uv run python -m datalake.generate_data`.",
        )

    def require_ready(self) -> None:
        """Fail fast unless the whole lake, aggregate included, is present."""
        self._require(
            (self.tracts_path, self.buildings_path, self.summary_path),
            "Run `uv run python -m datalake.generate_data` then "
            "`uv run python -m datalake.build_summary`.",
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide cached settings."""
    return Settings()
