"""Pydantic v2 request/response contracts.

The ``/api/tracts`` body is a strictly conformant GeoJSON ``FeatureCollection`` — no
extra top-level keys. Per-request telemetry travels in ``X-Query-Time-Ms`` and
``X-Feature-Count`` headers instead, so any GeoJSON client (deck.gl included) can
consume the body unmodified.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

#: A decoded GeoJSON geometry object. Kept loose on purpose: the shape varies by
#: geometry type and we pass it straight through from DuckDB's ST_AsGeoJSON.
Geometry = dict[str, Any]


class BBox(BaseModel):
    """An axis-aligned viewport filter in lon/lat degrees."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    min_x: float
    min_y: float
    max_x: float
    max_y: float

    @model_validator(mode="after")
    def _check_ordered(self) -> BBox:
        if self.min_x >= self.max_x:
            raise ValueError(f"bbox min_x must be < max_x, got {self.min_x} >= {self.max_x}")
        if self.min_y >= self.max_y:
            raise ValueError(f"bbox min_y must be < max_y, got {self.min_y} >= {self.max_y}")
        if not (-180.0 <= self.min_x <= 180.0 and -180.0 <= self.max_x <= 180.0):
            raise ValueError("bbox longitudes must be within [-180, 180]")
        if not (-90.0 <= self.min_y <= 90.0 and -90.0 <= self.max_y <= 90.0):
            raise ValueError("bbox latitudes must be within [-90, 90]")
        return self


class TractProperties(BaseModel):
    """Per-tract aggregate carried on each GeoJSON feature."""

    model_config = ConfigDict(extra="forbid")

    geoid: str
    building_count: int
    avg_height_m: float
    p95_height_m: float


class Feature(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["Feature"] = "Feature"
    id: str
    properties: TractProperties
    geometry: Geometry


class FeatureCollection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[Feature] = Field(default_factory=list)


class TractJoinStat(BaseModel):
    """One tract's result from the live spatial join."""

    model_config = ConfigDict(extra="forbid")

    geoid: str
    building_count: int
    avg_height_m: float


class JoinResponse(BaseModel):
    """Result of an on-demand exact ``ST_Intersects`` join."""

    model_config = ConfigDict(extra="forbid")

    tracts_in_scope: int
    tracts_matched: int
    buildings_matched: int
    truncated: bool
    query_time_ms: float
    tracts: list[TractJoinStat] = Field(default_factory=list)


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"] = "ok"
    tract_count: int
    building_count: int
    #: Densest tract in the whole lake. Bounds the client's density filter.
    max_building_count: int
    duckdb_version: str
    spatial_version: str
    data_dir: str


#: Header names for request telemetry.
HEADER_QUERY_TIME_MS = "X-Query-Time-Ms"
HEADER_FEATURE_COUNT = "X-Feature-Count"

#: ``minx,miny,maxx,maxy`` with optional fractional and sign parts.
BBOX_PATTERN = r"^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3}$"
