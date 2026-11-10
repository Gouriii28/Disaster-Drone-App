"""
Decides whether a disaster event is in India.

Two checks, in this order:
  1. Text: the event's title / place / country mentions India -> yes.
     If it names only a neighbouring country -> no.
  2. Position: the point lies inside a simplified outline of India
     (mainland, Andaman & Nicobar Islands, Lakshadweep).

The outline is approximate (about 10-30 km), which is fine for listing
events; the text check handles events close to the borders.
"""
from typing import List, Tuple

# (longitude, latitude) points around mainland India, in order
MAINLAND: List[Tuple[float, float]] = [
    (68.2, 23.7), (69.5, 24.3), (70.3, 25.4), (70.0, 26.6), (71.0, 27.8), (72.9, 29.0),
    (73.9, 30.0), (74.5, 30.9), (74.7, 31.9), (74.0, 32.7), (73.8, 33.8), (74.1, 34.7),
    (76.0, 35.2), (77.8, 35.6), (79.5, 35.5), (80.3, 35.0), (78.9, 33.6), (78.7, 32.5),
    (79.0, 31.3), (80.3, 30.4), (81.0, 30.2), (80.1, 28.8), (81.0, 28.0), (83.3, 27.3),
    (84.6, 27.0), (85.9, 26.6), (87.0, 26.4), (88.1, 26.4), (88.0, 27.2), (88.8, 28.1),
    (88.9, 27.3), (89.7, 26.7), (92.0, 26.85), (91.6, 27.8), (94.0, 28.9), (96.1, 29.4),
    (97.4, 28.3), (95.4, 26.7), (94.6, 25.2), (94.1, 23.6), (93.4, 22.4), (92.7, 21.95),
    (92.3, 22.6), (92.0, 23.6), (91.2, 23.4), (91.3, 24.2), (92.1, 24.4), (92.4, 25.0),
    (90.0, 25.2), (89.8, 25.4), (89.85, 26.1), (89.0, 26.35), (88.5, 26.3), (88.4, 26.2),
    (88.1, 25.1), (88.7, 24.2), (88.9, 23.2), (89.1, 21.7), (88.0, 21.6), (86.9, 20.8),
    (84.9, 19.3), (82.3, 16.6), (80.1, 15.5), (80.3, 13.4), (79.9, 12.0), (79.3, 10.3),
    (78.2, 8.9), (77.5, 8.0), (76.0, 10.0), (74.8, 12.8), (73.4, 16.0), (72.8, 19.0),
    (72.6, 21.0), (70.0, 20.8), (68.1, 23.6),
]

# (min_lon, min_lat, max_lon, max_lat) for island territories
ISLANDS = [
    (92.1, 6.5, 94.0, 14.0),   # Andaman & Nicobar Islands
    (71.5, 8.0, 74.0, 12.5),   # Lakshadweep
]

NEIGHBOURS = ["pakistan", "nepal", "bangladesh", "bhutan", "china", "tibet", "myanmar",
              "burma", "sri lanka", "afghanistan", "maldives"]


def _inside(lon: float, lat: float, poly) -> bool:
    """Ray-casting point-in-polygon test."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def point_in_india(lat: float, lon: float) -> bool:
    if _inside(lon, lat, MAINLAND):
        return True
    return any(a <= lon <= c and b <= lat <= d for a, b, c, d in ISLANDS)


def is_india_event(lat: float, lon: float, *texts: str) -> bool:
    text = " ".join(t for t in texts if t).lower()
    if "india" in text:
        return True
    if any(n in text for n in NEIGHBOURS):
        return False
    return point_in_india(lat, lon)


# Centre and zoom used by the app to show the whole country
INDIA_VIEW = {"lat": 22.5, "lon": 80.0, "zoom": 5}
