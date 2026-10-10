"""Tests for the HTTP serving layer."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import duckdb
import pytest
from fastapi.testclient import TestClient

from datalake.main import create_app, get_db
from datalake.models import HEADER_FEATURE_COUNT, HEADER_QUERY_TIME_MS
from datalake.settings import Settings
from datalake.spec import DatasetSpec


@pytest.fixture
def lake_settings(complete_lake: Settings) -> Settings:
    """Alias for the shared conftest fixture, named for how these tests use it."""
    return complete_lake


@pytest.fixture
def client(lake_settings: Settings) -> Iterator[TestClient]:
    # The context manager runs the lifespan, which is where require_ready() fires.
    with TestClient(create_app(lake_settings)) as test_client:
        yield test_client


def _features(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return payload["features"]


def _bounds(feature: dict[str, Any]) -> tuple[float, float, float, float]:
    coords = feature["geometry"]["coordinates"][0]
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return min(xs), min(ys), max(xs), max(ys)


def test_health_reports_lake_counts(client: TestClient, small_spec: DatasetSpec) -> None:
    body = client.get("/api/health").json()

    assert body["status"] == "ok"
    assert body["tract_count"] == small_spec.tract_count
    assert body["building_count"] == small_spec.building_target
    assert body["spatial_version"] not in ("", "unknown")

    # The client fixes its density-filter range from this value, not from whatever
    # subset is currently on screen — otherwise the slider's own maximum collapses the
    # moment a filter excludes everything.
    densest = max(
        f["properties"]["building_count"] for f in _features(client.get("/api/tracts").json())
    )
    assert body["max_building_count"] == densest > 0


def test_tracts_returns_a_conformant_feature_collection(
    client: TestClient, small_spec: DatasetSpec
) -> None:
    response = client.get("/api/tracts")
    assert response.status_code == 200

    payload = response.json()
    assert payload["type"] == "FeatureCollection"
    # Strictly conformant: no telemetry keys smuggled into the GeoJSON body.
    assert set(payload) == {"type", "features"}
    assert len(_features(payload)) == small_spec.tract_count

    feature = _features(payload)[0]
    assert feature["type"] == "Feature"
    assert feature["id"] == feature["properties"]["geoid"]
    assert feature["geometry"]["type"] == "Polygon"
    assert set(feature["properties"]) == {
        "geoid",
        "building_count",
        "avg_height_m",
        "p95_height_m",
    }


def test_tracts_sets_telemetry_headers(client: TestClient) -> None:
    response = client.get("/api/tracts")

    assert float(response.headers[HEADER_QUERY_TIME_MS]) >= 0
    assert int(response.headers[HEADER_FEATURE_COUNT]) == len(_features(response.json()))
    assert response.headers["X-Request-Id"]


def test_served_counts_conserve_every_building(client: TestClient, small_spec: DatasetSpec) -> None:
    """End-to-end version of the row-conservation invariant."""
    features = _features(client.get("/api/tracts").json())
    total = sum(f["properties"]["building_count"] for f in features)
    assert total == small_spec.building_target


def test_bbox_filter_returns_only_overlapping_tracts(client: TestClient) -> None:
    min_x, min_y, max_x, max_y = -122.48, 37.74, -122.44, 37.78
    response = client.get("/api/tracts", params={"bbox": f"{min_x},{min_y},{max_x},{max_y}"})
    features = _features(response.json())

    unfiltered = len(_features(client.get("/api/tracts").json()))
    assert 0 < len(features) < unfiltered, "bbox filter must actually narrow the result"

    for feature in features:
        x0, y0, x1, y1 = _bounds(feature)
        assert x1 >= min_x and x0 <= max_x, f"{feature['id']} lies outside the bbox on x"
        assert y1 >= min_y and y0 <= max_y, f"{feature['id']} lies outside the bbox on y"


def test_min_count_filter_excludes_sparse_tracts(client: TestClient) -> None:
    response = client.get("/api/tracts", params={"min_count": 50})
    features = _features(response.json())

    assert features, "filter is too aggressive for the fixture"
    assert all(f["properties"]["building_count"] >= 50 for f in features)
    assert len(features) < len(_features(client.get("/api/tracts").json()))


def test_viewport_outside_the_extent_yields_an_empty_collection(client: TestClient) -> None:
    """The path the frontend's EmptyState renders — mid-Atlantic, no tracts."""
    response = client.get("/api/tracts", params={"bbox": "-30.0,40.0,-29.0,41.0"})

    assert response.status_code == 200
    assert response.json() == {"type": "FeatureCollection", "features": []}
    assert response.headers[HEADER_FEATURE_COUNT] == "0"


def test_malformed_bbox_is_rejected(client: TestClient) -> None:
    for bad in ("abc", "-122.4,37.7", "-122.4,37.7,-122.3,37.8,9", "-122.4,37.7,-122.3"):
        assert client.get("/api/tracts", params={"bbox": bad}).status_code == 422, bad


def test_inverted_bbox_is_rejected_with_a_useful_message(client: TestClient) -> None:
    response = client.get("/api/tracts", params={"bbox": "-122.3,37.8,-122.5,37.7"})

    assert response.status_code == 422
    assert "must be <" in response.text


def test_out_of_range_coordinates_are_rejected(client: TestClient) -> None:
    assert client.get("/api/tracts", params={"bbox": "-200,0,-190,10"}).status_code == 422


def test_negative_min_count_is_rejected(client: TestClient) -> None:
    assert client.get("/api/tracts", params={"min_count": -1}).status_code == 422


def test_live_join_agrees_with_the_materialised_summary(client: TestClient) -> None:
    """The two code paths must produce identical numbers.

    ``/api/tracts`` reads the pre-aggregated file; ``/api/join`` recomputes the exact
    ``ST_Intersects`` join on demand. If the ETL step were dropping or miscounting
    anything, this is where it would show.
    """
    served = {f["id"]: f["properties"] for f in _features(client.get("/api/tracts").json())}
    join = client.get("/api/join").json()

    assert join["tracts_matched"] == len(served)
    assert not join["truncated"]

    for stat in join["tracts"]:
        expected = served[stat["geoid"]]
        assert stat["building_count"] == expected["building_count"], stat["geoid"]
        assert stat["avg_height_m"] == pytest.approx(expected["avg_height_m"], rel=1e-9)


def test_live_join_is_capped_and_reports_truncation(lake_settings: Settings) -> None:
    capped = lake_settings.model_copy(update={"max_join_tracts": 3})
    with TestClient(create_app(capped)) as test_client:
        join = test_client.get("/api/join").json()

    assert join["tracts_in_scope"] == 3
    assert join["tracts_matched"] <= 3
    assert join["truncated"] is True


def test_live_join_respects_bbox(lake_settings: Settings) -> None:
    with TestClient(create_app(lake_settings)) as test_client:
        narrow = test_client.get("/api/join", params={"bbox": "-122.46,37.75,-122.45,37.76"}).json()

    assert narrow["tracts_in_scope"] < 40
    assert narrow["tracts_matched"] <= narrow["tracts_in_scope"]


def test_startup_fails_fast_when_the_lake_is_missing(tmp_path: Path) -> None:
    """A missing dataset must stop the process, not become an opaque 500 later."""
    app = create_app(Settings(data_dir=tmp_path))
    with pytest.raises(FileNotFoundError, match="build_summary"), TestClient(app):
        pass


def test_cors_allows_only_configured_origins(client: TestClient) -> None:
    allowed = client.get("/api/tracts", headers={"Origin": "http://localhost:5173"})
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:5173"

    denied = client.get("/api/tracts", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in denied.headers


class _FailingCursor:
    """Stands in for a DuckDB cursor whose every query blows up."""

    def execute(self, *args: object, **kwargs: object) -> None:
        raise duckdb.Error("simulated engine failure")


@pytest.fixture
def broken_client(lake_settings: Settings) -> Iterator[TestClient]:
    app = create_app(lake_settings)
    app.dependency_overrides[get_db] = lambda: _FailingCursor()
    with TestClient(app) as test_client:
        yield test_client


def test_tract_query_failure_surfaces_as_503_not_a_hang(broken_client: TestClient) -> None:
    """Errors must reach the client so the frontend can render its ErrorState."""
    response = broken_client.get("/api/tracts")

    assert response.status_code == 503
    assert response.json() == {"detail": "Spatial query failed"}
    # The internal DuckDB message is logged, never leaked to the caller.
    assert "simulated engine failure" not in response.text


def test_live_join_failure_surfaces_as_503(broken_client: TestClient) -> None:
    response = broken_client.get("/api/join")

    assert response.status_code == 503
    assert response.json() == {"detail": "Spatial join failed"}


def test_root_describes_the_service(client: TestClient) -> None:
    body = client.get("/").json()

    assert body["service"] == "datalake"
    assert "/api/tracts" in body["endpoints"]
