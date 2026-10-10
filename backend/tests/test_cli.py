"""Tests for the two console entry points."""

from __future__ import annotations

from pathlib import Path

import pytest

from datalake.build_summary import main as build_main
from datalake.generate_data import main as generate_main
from datalake.spec import DEFAULT_SPEC


def test_generate_cli_honours_data_dir_and_counts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert generate_main(["--data-dir", str(tmp_path), "--buildings", "500", "--seed", "5"]) == 0

    out = capsys.readouterr().out
    assert "500 buildings" in out
    assert (tmp_path / "tracts.parquet").is_file()
    assert (tmp_path / "buildings.parquet").is_file()


def test_generate_cli_scales_candidates_with_the_target(tmp_path: Path) -> None:
    """`--buildings 500` must not pull the 24M-candidate default pool."""
    from datalake.generate_data import _parse_args
    from datalake.spec import CANDIDATE_MULTIPLIER

    args = _parse_args(["--data-dir", str(tmp_path), "--buildings", "500"])
    assert args.buildings * CANDIDATE_MULTIPLIER < DEFAULT_SPEC.building_candidates


def test_generate_cli_parses_seed_and_data_dir(tmp_path: Path) -> None:
    from datalake.generate_data import _parse_args

    args = _parse_args(["--seed", "1234", "--data-dir", str(tmp_path)])
    assert args.seed == 1234
    assert args.data_dir == tmp_path


def test_generate_cli_defaults_leave_overrides_unset() -> None:
    """Bare invocation must use DEFAULT_SPEC untouched — no accidental overrides."""
    from datalake.generate_data import _parse_args

    args = _parse_args([])
    assert args.seed is None
    assert args.buildings is None
    assert args.data_dir is None


def test_build_summary_cli_writes_and_reports(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    generate_main(["--data-dir", str(tmp_path), "--buildings", "500"])
    capsys.readouterr()

    assert build_main(["--data-dir", str(tmp_path)]) == 0

    out = capsys.readouterr().out
    assert "exact spatial join" in out
    assert (tmp_path / "summary.parquet").is_file()


def test_build_summary_cli_fails_cleanly_without_inputs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(FileNotFoundError, match="generate_data"):
        build_main(["--data-dir", str(tmp_path)])

    assert not (tmp_path / "summary.parquet").exists()
    assert list(tmp_path.glob("*.partial")) == []
