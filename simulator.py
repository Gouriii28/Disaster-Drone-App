"""
Training simulator for SAADAXA.

Used when SIMULATION=1 in .env, so the app can be tried without real
aircraft. It imitates what a real aerial unit would send to the server:

  * strip-decomposition survey flight (parallel passes over the search box)
  * dual-mode navigation: GNSS -> anchored visual-inertial odometry (VIO)
    when HDOP > 5.0, re-anchoring back to GNSS when HDOP < 2.0
  * dual-tier link: wideband Wi-Fi above -75 dBm, long-range radio (LoRa)
    below it, with live video/audio suspended on LoRa
  * survivor detections (thermal + depth) projected into WGS84 and sent
    to the store, which de-duplicates them within 3 m
  * return-to-launch on low battery

Every value this module produces is synthetic and the app labels it as a
training simulation.
"""
import asyncio
import math
import random

from geo import enu_to_geodetic, haversine_m

HDOP_DEGRADE = 5.0
HDOP_RECOVER = 2.0
RSSI_THRESHOLD = -75.0     # drop to long-range radio below this
RSSI_RECOVER = -70.0       # return to Wi-Fi only above this (avoids flapping)


class SimDrone:
    def __init__(self, drone_id, base_lat, base_lon, box_e, box_n, width_m, height_m,
                 strip_spacing_m, speed_mps, seed):
        self.id = drone_id
        self.base = (base_lat, base_lon)
        self.rng = random.Random(seed)
        self.speed = speed_mps
        self.alt = 0.0
        self.target_alt = 30.0
        self.battery = 100.0 - self.rng.random() * 15
        self.hdop = 1.0
        self.nav_mode = "GNSS"
        self.link = "WIFI"
        self.state = "SURVEY"
        self.e, self.n = 0.0, 0.0
        self.anchor = None
        self.vio_drift = 0.0
        # Build lawn-mower waypoints (east/north metres from the base)
        self.waypoints = []
        x0, y0 = box_e, box_n
        rows = int(height_m // strip_spacing_m) + 1
        for i in range(rows):
            y = y0 + i * strip_spacing_m
            xs = (x0, x0 + width_m) if i % 2 == 0 else (x0 + width_m, x0)
            self.waypoints += [(xs[0], y), (xs[1], y)]
        self.wp_index = 0

    def _move_towards(self, tx, ty, dt):
        dx, dy = tx - self.e, ty - self.n
        dist = math.hypot(dx, dy)
        step = self.speed * dt
        if dist <= step:
            self.e, self.n = tx, ty
            return True
        self.e += dx / dist * step
        self.n += dy / dist * step
        return False

    def tick(self, dt):
        r = self.rng
        # ---- altitude ----
        goal_alt = 0.0 if self.state == "LANDED" else self.target_alt
        self.alt += max(-2.0 * dt, min(2.0 * dt, goal_alt - self.alt))

        # ---- flight state machine ----
        if self.state == "SURVEY":
            tx, ty = self.waypoints[self.wp_index]
            if self._move_towards(tx, ty, dt):
                self.wp_index = (self.wp_index + 1) % len(self.waypoints)
            if self.battery < 20:
                self.state = "RTL"
        elif self.state == "RTL":
            if self._move_towards(0.0, 0.0, dt):
                self.state = "LANDED"
        elif self.state == "LANDED":
            self.battery = min(100.0, self.battery + 6 * dt)  # battery swap / charge
            if self.battery >= 99:
                self.state = "SURVEY"

        if self.state != "LANDED":
            self.battery = max(0.0, self.battery - 0.08 * dt)

        # ---- satellite quality random walk -> navigation mode ----
        self.hdop = max(0.6, min(9.0, self.hdop + r.gauss(0, 0.25)
                                 + (0.35 if r.random() < 0.01 else 0) - 0.02))
        lat_true, lon_true = enu_to_geodetic(*self.base, self.e, self.n)
        if self.nav_mode == "GNSS" and self.hdop > HDOP_DEGRADE:
            self.nav_mode = "VIO"
            self.anchor = (lat_true, lon_true)   # latch last valid fix
            self.vio_drift = 0.0
        elif self.nav_mode == "VIO" and self.hdop < HDOP_RECOVER:
            self.nav_mode = "GNSS"               # re-anchor, drift reset
            self.anchor = None
            self.vio_drift = 0.0
        if self.nav_mode == "VIO":
            self.vio_drift = min(6.0, self.vio_drift + 0.02 * self.speed * dt)

        # ---- link quality -> link mode ----
        dist = max(1.0, math.hypot(self.e, self.n))
        rssi = -40 - 26 * math.log10(dist / 10) + r.gauss(0, 2.0)  # far edges of the box drop below -75 dBm
        self.rssi = round(rssi, 1)
        # the link manager polls signal strength every 5 seconds (per the specification)
        self.link_poll = getattr(self, "link_poll", 0.0) + dt
        if self.link_poll >= 5.0:
            self.link_poll = 0.0
            if self.link == "WIFI" and rssi < RSSI_THRESHOLD:
                self.link = "LORA"
            elif self.link == "LORA" and rssi > RSSI_RECOVER:
                self.link = "WIFI"

        # reported position = truth plus drift (VIO) or small GNSS noise
        noise = self.vio_drift if self.nav_mode == "VIO" else 0.4
        rep_lat, rep_lon = enu_to_geodetic(*self.base, self.e + r.gauss(0, noise),
                                           self.n + r.gauss(0, noise))
        return {
            "drone_id": self.id,
            "lat": rep_lat, "lon": rep_lon,
            "alt": round(self.alt, 1),
            "battery": round(self.battery, 1),
            "hdop": round(self.hdop, 2),
            "nav_mode": self.nav_mode,
            "rssi": self.rssi,
            "link": self.link,
            "video": self.link == "WIFI" and self.state != "LANDED",
            "audio": self.link == "WIFI" and self.state != "LANDED",
            "state": self.state,
            "drift_m": round(self.vio_drift, 2),
            "anchor": self.anchor,
            "simulated": True,
        }


class Simulator:
    def __init__(self, store, center_lat, center_lon):
        self.store = store
        self.center = (center_lat, center_lon)
        self.rng = random.Random(42)
        self.drones = [
            SimDrone("UAV-01", center_lat, center_lon, -260, -40, 240, 220, 22, 6.0, 1),
            SimDrone("UAV-02", center_lat, center_lon, 20, -40, 240, 220, 22, 6.0, 2),
        ]
        # hidden "ground truth" people inside the search box
        self.people = []
        for _ in range(9):
            e = self.rng.uniform(-250, 250)
            n = self.rng.uniform(-30, 170)
            self.people.append({"lat_lon": enu_to_geodetic(center_lat, center_lon, e, n),
                                "thermal": self.rng.random() > 0.2,
                                "conf": self.rng.uniform(0.55, 0.95)})

    async def run(self):
        self.store.log("info", "system", "Training simulation started (synthetic data)")
        dt = 0.5
        while True:
            for d in self.drones:
                t = d.tick(dt)
                self.store.update_telemetry(t)
                if d.state != "SURVEY" or d.alt < 20:
                    continue
                for p in self.people:
                    plat, plon = p["lat_lon"]
                    if haversine_m(t["lat"], t["lon"], plat, plon) < 18 and self.rng.random() < 0.25:
                        jitter = max(0.5, t["drift_m"] * 0.3)
                        jlat, jlon = enu_to_geodetic(plat, plon, self.rng.gauss(0, jitter),
                                                     self.rng.gauss(0, jitter))
                        self.store.add_detection({
                            "lat": jlat, "lon": jlon,
                            "confidence": round(min(0.99, p["conf"] + self.rng.gauss(0, 0.04)), 2),
                            "thermal": p["thermal"],
                            "drone_id": d.id, "nav_mode": t["nav_mode"], "link": t["link"],
                        })
            await asyncio.sleep(dt)
