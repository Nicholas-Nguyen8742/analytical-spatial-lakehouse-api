"""Single source of truth for the synthetic dataset's spatial layout.

The generator and the summary builder both derive their SQL from :data:`DEFAULT_SPEC`,
so the tract grid written to ``tracts.parquet`` can never drift from the grid the
aggregate is grouped by. Tests import the same object to assert invariants.
"""

from __future__ import annotations

from dataclasses import dataclass


def d(value: float) -> str:
    """Render a float as an explicit ``DOUBLE`` SQL literal.

    DuckDB parses a bare decimal literal as ``DECIMAL``, and ``BIGINT * DECIMAL``
    promotes to ``DECIMAL`` rather than ``DOUBLE``. Left implicit, the tract grid
    coordinates would be computed in fixed-point and silently round differently from
    the points they are supposed to contain. Every coordinate we emit is cast.
    """
    return f"({value!r})::DOUBLE"


#: San Francisco-ish extent. Small enough to demo, large enough to be plausible.
LON_MIN = -122.52
LON_MAX = -122.36
LAT_MIN = 37.70
LAT_MAX = 37.82

#: Rejection sampling keeps roughly one candidate in seven, so the pool needs several
#: times as many candidates as the target. 12x was measured to clear 2M with margin;
#: :func:`datalake.generate_data._validate_counts` fails loudly if that ever stops
#: holding rather than writing a short file.
CANDIDATE_MULTIPLIER = 12


@dataclass(frozen=True, slots=True)
class BBox:
    """Axis-aligned bounding box in lon/lat degrees."""

    x_min: float
    y_min: float
    x_max: float
    y_max: float

    def __post_init__(self) -> None:
        if self.x_min >= self.x_max:
            raise ValueError(f"x_min must be < x_max, got {self.x_min} >= {self.x_max}")
        if self.y_min >= self.y_max:
            raise ValueError(f"y_min must be < y_max, got {self.y_min} >= {self.y_max}")

    @property
    def width(self) -> float:
        return self.x_max - self.x_min

    @property
    def height(self) -> float:
        return self.y_max - self.y_min

    def overlaps(self, other: BBox) -> bool:
        return not (
            self.x_max < other.x_min
            or self.x_min > other.x_max
            or self.y_max < other.y_min
            or self.y_min > other.y_max
        )


@dataclass(frozen=True, slots=True)
class DensityCenter:
    """A Gaussian kernel that raises building density and height around a hotspot."""

    lon: float
    lat: float
    weight: float
    sigma_lon: float
    sigma_lat: float

    def __post_init__(self) -> None:
        if not 0.0 < self.weight <= 1.0:
            raise ValueError(f"weight must be in (0, 1], got {self.weight}")
        if self.sigma_lon <= 0 or self.sigma_lat <= 0:
            raise ValueError("sigmas must be positive")


@dataclass(frozen=True, slots=True)
class DatasetSpec:
    """Complete description of the synthetic lake."""

    bbox: BBox
    cols: int
    rows: int
    seed: int
    building_target: int
    building_candidates: int
    centers: tuple[DensityCenter, ...]
    base_density: float
    min_height_m: float = 3.0
    max_height_m: float = 100.0

    def __post_init__(self) -> None:
        if self.cols < 1 or self.rows < 1:
            raise ValueError("grid dimensions must be >= 1")
        if self.building_target < 1:
            raise ValueError("building_target must be >= 1")
        if self.building_candidates < self.building_target:
            raise ValueError(
                f"building_candidates ({self.building_candidates}) must be >= "
                f"building_target ({self.building_target})"
            )
        if not 0.0 <= self.base_density < 1.0:
            raise ValueError(f"base_density must be in [0, 1), got {self.base_density}")

    @property
    def tract_count(self) -> int:
        return self.cols * self.rows

    @property
    def cell_width(self) -> float:
        return self.bbox.width / self.cols

    @property
    def cell_height(self) -> float:
        return self.bbox.height / self.rows

    def density_expr(self, x_sql: str, y_sql: str) -> str:
        """Build the SQL acceptance-probability expression, clamped to [0, 1].

        Rejection sampling against this field is what gives the synthetic city its
        structure: dense downtown cores, sparse outskirts. Without it the choropleth
        is uniform noise and the visualisation communicates nothing.
        """
        terms = [d(self.base_density)]
        for c in self.centers:
            dx = f"(({x_sql}) - {d(c.lon)}) / {d(c.sigma_lon)}"
            dy = f"(({y_sql}) - {d(c.lat)}) / {d(c.sigma_lat)}"
            terms.append(f"{d(c.weight)} * exp(-(pow({dx}, 2) + pow({dy}, 2)) / 2.0)")
        return f"least(1.0, {' + '.join(terms)})"

    def height_expr(self, uniform_sql: str, density_sql: str) -> str:
        """Height in metres, skewed short with a tall tail and scaled by local density."""
        span = self.max_height_m - self.min_height_m
        return (
            f"{d(self.min_height_m)} + pow({uniform_sql}, 4.0) * {d(span)} "
            f"* (0.15 + 0.85 * ({density_sql}))"
        )


DEFAULT_SPEC = DatasetSpec(
    bbox=BBox(x_min=LON_MIN, y_min=LAT_MIN, x_max=LON_MAX, y_max=LAT_MAX),
    cols=100,
    rows=50,
    seed=42,
    building_target=2_000_000,
    building_candidates=2_000_000 * CANDIDATE_MULTIPLIER,
    centers=(
        DensityCenter(lon=-122.4200, lat=37.7750, weight=0.95, sigma_lon=0.0130, sigma_lat=0.0100),
        DensityCenter(lon=-122.4700, lat=37.7600, weight=0.60, sigma_lon=0.0160, sigma_lat=0.0120),
        DensityCenter(lon=-122.4000, lat=37.7200, weight=0.50, sigma_lon=0.0140, sigma_lat=0.0110),
        DensityCenter(lon=-122.4500, lat=37.8000, weight=0.35, sigma_lon=0.0110, sigma_lat=0.0090),
    ),
    base_density=0.05,
)
