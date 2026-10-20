"""The corridor grid of the heatmap (API-CONTRACT D-19 and D-22).

**Geometry (D-22, binding for backend and map).** ``lat0`` / ``lon0`` is the *south-west corner* of
cell (row 0, col 0); rows increase northward and columns eastward; the cell index is
``row * cols + col``; cell ``(r, c)`` spans latitude ``[lat0 + r*dlat, lat0 + (r+1)*dlat)`` and
longitude ``[lon0 + c*dlon, lon0 + (c+1)*dlon)``; its weather is sampled at the cell *centre*.

**Lattice alignment (D-19).** Cell size is a multiple of the 0.1 degree weather lattice (0.2 to 0.5
degrees) and every cell *centre* is a lattice point, so a cell's forecast is one cached lattice
lookup that checkpoints of overlapping plans share. The grid is therefore stored as the
integer lattice coordinates (tenths of a degree) of the centre of cell (0, 0) plus the step:
centres are exact, the corner (``lat0 = centre - dlat / 2``) is derived. Centres sit at multiples of
the step, so grids of different plans line up.

**Corridor.** A cell belongs to the corridor when its centre is within ``CORRIDOR_RADIUS_MI`` of
a route (the union of the buffers around every route). A cell is at most about 23 miles from
its centre to its corner at the coarsest spacing, so the buffer always covers every cell a route
crosses. The finest spacing whose corridor has at most ``MAX_CELLS`` cells wins; when even the
coarsest has more, the ``MAX_CELLS`` cells nearest to a route are kept.
"""

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Final

from haulcast.domain import EARTH_RADIUS_MI, Coordinate
from haulcast.providers.weather.base import LATTICE_STEPS_PER_DEGREE, LatticePoint

CORRIDOR_RADIUS_MI: Final = 25.0
"""Buffer around each route; a cell centre inside it puts the cell in the corridor."""

MAX_CELLS: Final = 200
"""Cells per heatmap (D-19): bounds the weather lookups and the payload."""

STEPS_E1: Final = (2, 3, 4, 5)
"""Cell sizes to try, finest first, in tenths of a degree (0.2 to 0.5 degrees)."""

SAMPLE_SPACING_MI: Final = 2.0
"""Routes are sampled at least this densely when deciding which cells they reach."""

_MI_PER_DEGREE: Final = EARTH_RADIUS_MI * math.pi / 180
_MIN_COSINE: Final = 0.05
"""Floor of cos(latitude): keeps the longitude reach finite next to the poles."""

Cell = tuple[int, int]
"""A cell as the lattice indices ``(i, j)`` of its centre in units of the step."""


@dataclass(frozen=True, slots=True)
class RouteLine:
    """A route as drawn: vertices ``(lon, lat)`` with their cumulative miles."""

    coords: tuple[Coordinate, ...]
    cum_mi: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class HeatmapGrid:
    """A regular grid whose listed ``cells`` form the corridor (see the module docstring)."""

    step_e1: int
    lat_centre0_e1: int
    lon_centre0_e1: int
    rows: int
    cols: int
    cells: tuple[int, ...]

    @property
    def dlat(self) -> float:
        """Cell height in degrees."""
        return self.step_e1 / LATTICE_STEPS_PER_DEGREE

    @property
    def dlon(self) -> float:
        """Cell width in degrees."""
        return self.step_e1 / LATTICE_STEPS_PER_DEGREE

    @property
    def lat0(self) -> float:
        """South edge of row 0 (the centre of cell (0, 0) minus half a cell)."""
        return (2 * self.lat_centre0_e1 - self.step_e1) / (2 * LATTICE_STEPS_PER_DEGREE)

    @property
    def lon0(self) -> float:
        """West edge of column 0 (the centre of cell (0, 0) minus half a cell)."""
        return (2 * self.lon_centre0_e1 - self.step_e1) / (2 * LATTICE_STEPS_PER_DEGREE)

    def centre(self, index: int) -> LatticePoint:
        """Return the lattice point at the centre of cell ``index`` (``row * cols + col``)."""
        row, col = divmod(index, self.cols)
        return LatticePoint(
            self.lat_centre0_e1 + row * self.step_e1, self.lon_centre0_e1 + col * self.step_e1
        )


def build_grid(
    routes: Sequence[RouteLine],
    *,
    radius_mi: float = CORRIDOR_RADIUS_MI,
    max_cells: int = MAX_CELLS,
    steps_e1: Sequence[int] = STEPS_E1,
) -> HeatmapGrid:
    """Return the finest grid whose corridor around ``routes`` has at most ``max_cells`` cells.

    Raises:
        ValueError: ``routes`` is empty.
    """
    if not routes:
        raise ValueError("a heatmap grid needs at least one route")
    samples = [sample for route in routes for sample in _samples(route)]
    for step in steps_e1:
        found = _scan(samples, step, radius_mi, max_cells)
        if len(found) <= max_cells:
            return _grid(step, list(found))
    coarsest = steps_e1[-1]
    nearest = sorted(_scan(samples, coarsest, radius_mi, math.inf).items(), key=_by_distance)
    return _grid(coarsest, [cell for cell, _ in nearest[:max_cells]])


def _by_distance(item: tuple[Cell, float]) -> tuple[float, Cell]:
    """Sort key: nearest first, ties by cell so the choice is deterministic."""
    return item[1], item[0]


def _samples(route: RouteLine) -> Iterator[Coordinate]:
    """Yield points along ``route`` no further apart than :data:`SAMPLE_SPACING_MI`."""
    yield route.coords[0]
    for (start, end), (mile_from, mile_to) in zip(
        zip(route.coords, route.coords[1:], strict=False),
        zip(route.cum_mi, route.cum_mi[1:], strict=False),
        strict=True,
    ):
        pieces = max(1, math.ceil((mile_to - mile_from) / SAMPLE_SPACING_MI))
        for piece in range(1, pieces + 1):
            share = piece / pieces
            yield (
                start[0] + (end[0] - start[0]) * share,
                start[1] + (end[1] - start[1]) * share,
            )


def _scan(
    samples: Sequence[Coordinate], step_e1: int, radius_mi: float, limit: float
) -> dict[Cell, float]:
    """Return the squared miles from each in-radius cell centre to its nearest sample.

    Stops early, returning more than ``limit`` cells, once the corridor is known to be too big.
    """
    radius_sq = radius_mi * radius_mi
    lat_reach = radius_mi / _MI_PER_DEGREE
    per_degree = LATTICE_STEPS_PER_DEGREE / step_e1
    nearest: dict[Cell, float] = {}
    for lon, lat in samples:
        cosine = max(math.cos(math.radians(lat)), _MIN_COSINE)
        lon_reach = lat_reach / cosine
        for i in range(
            math.ceil((lat - lat_reach) * per_degree),
            math.floor((lat + lat_reach) * per_degree) + 1,
        ):
            dy = (i * step_e1 / LATTICE_STEPS_PER_DEGREE - lat) * _MI_PER_DEGREE
            for j in range(
                math.ceil((lon - lon_reach) * per_degree),
                math.floor((lon + lon_reach) * per_degree) + 1,
            ):
                dx = (j * step_e1 / LATTICE_STEPS_PER_DEGREE - lon) * cosine * _MI_PER_DEGREE
                distance_sq = dx * dx + dy * dy
                if distance_sq <= radius_sq and distance_sq < nearest.get((i, j), math.inf):
                    nearest[(i, j)] = distance_sq
        if len(nearest) > limit:
            break
    return nearest


def _grid(step_e1: int, cells: Sequence[Cell]) -> HeatmapGrid:
    """Wrap ``cells`` (lattice indices) into the smallest grid that holds them."""
    i_min = min(i for i, _ in cells)
    j_min = min(j for _, j in cells)
    rows = max(i for i, _ in cells) - i_min + 1
    cols = max(j for _, j in cells) - j_min + 1
    return HeatmapGrid(
        step_e1=step_e1,
        lat_centre0_e1=i_min * step_e1,
        lon_centre0_e1=j_min * step_e1,
        rows=rows,
        cols=cols,
        cells=tuple(sorted((i - i_min) * cols + (j - j_min) for i, j in cells)),
    )
