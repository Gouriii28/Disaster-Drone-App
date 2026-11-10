"""
Geodesy helpers used across SAADAXA.

Implements the coordinate-recovery idea from the system specification:
a last valid satellite fix is latched as an origin anchor, a local
East-North-Up (ENU) metric frame is built at that anchor, and metric
offsets (metres east / north) are projected back into WGS84 latitude and
longitude with an inverse projection referenced to the anchor latitude.
"""
import math

# WGS84 ellipsoid constants
WGS84_A = 6378137.0                 # semi-major axis (m)
WGS84_E2 = 6.69437999014e-3         # first eccentricity squared


def meridional_radius(lat_deg: float) -> float:
    """Radius of curvature in the meridian (north-south), metres."""
    s = math.sin(math.radians(lat_deg))
    return WGS84_A * (1 - WGS84_E2) / (1 - WGS84_E2 * s * s) ** 1.5


def prime_vertical_radius(lat_deg: float) -> float:
    """Radius of curvature in the prime vertical (east-west), metres."""
    s = math.sin(math.radians(lat_deg))
    return WGS84_A / math.sqrt(1 - WGS84_E2 * s * s)


def enu_to_geodetic(anchor_lat: float, anchor_lon: float, east_m: float, north_m: float):
    """Project a local ENU offset (metres) from the anchor into (lat, lon) degrees."""
    d_lat = north_m / meridional_radius(anchor_lat)
    d_lon = east_m / (prime_vertical_radius(anchor_lat) * math.cos(math.radians(anchor_lat)))
    return anchor_lat + math.degrees(d_lat), anchor_lon + math.degrees(d_lon)


def geodetic_to_enu(anchor_lat: float, anchor_lon: float, lat: float, lon: float):
    """Inverse of enu_to_geodetic: (lat, lon) -> (east_m, north_m) from the anchor."""
    north = math.radians(lat - anchor_lat) * meridional_radius(anchor_lat)
    east = (math.radians(lon - anchor_lon)
            * prime_vertical_radius(anchor_lat) * math.cos(math.radians(anchor_lat)))
    return east, north


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))
