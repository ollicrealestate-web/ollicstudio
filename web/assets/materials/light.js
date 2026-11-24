// Daylight for the realistic preview: where the sun is for a place, a date and a time (the standard solar position
// formulas, good to about a tenth of a degree), and four skies: sunny day, overcast, golden hour and dusk.

export const PLACES = {
  lagos: { name: "Lagos", lat: 6.4541, lon: 3.3947, utc: 1 },
  abuja: { name: "Abuja", lat: 9.0765, lon: 7.3986, utc: 1 },
  portharcourt: { name: "Port Harcourt", lat: 4.8156, lon: 7.0498, utc: 1 },
  ibadan: { name: "Ibadan", lat: 7.3775, lon: 3.947, utc: 1 },
  enugu: { name: "Enugu", lat: 6.4584, lon: 7.5464, utc: 1 },
  kano: { name: "Kano", lat: 12.0022, lon: 8.592, utc: 1 },
  accra: { name: "Accra", lat: 5.6037, lon: -0.187, utc: 0 },
};
const D = Math.PI / 180;

/**
 * The sun's direction at a place and moment: elevation above the horizon and azimuth clockwise from north, in
 * radians. date is the moment (a JS Date: an instant, so the place's clock time must be converted to UTC first).
 */
export function sunAngles(lat, lon, date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;            // days since 1 Jan 2000, 12:00 UTC
  const g = ((357.529 + 0.98560028 * d) % 360) * D;                        // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360;                              // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D;        // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * D;                                 // tilt of the earth
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) * D - ra);                                  // hour angle
  const la = lat * D;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  let az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  if (az < 0) az += 2 * Math.PI;
  return { el, az };
}
/** The moment for a place's local clock time on a day ("2026-11-24", minutes after midnight). */
export function momentAt(place, day, minutes) {
  const [y, m, dd] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 0, 0, 0) + (minutes - place.utc * 60) * 60000);
}
/** The local time (minutes) on that day when the sun stands at a given elevation in the afternoon (golden hour, dusk). */
export function afternoonAt(place, day, elevationDeg) {
  let best = 15 * 60, err = Infinity;
  for (let m = 12 * 60; m <= 20 * 60; m += 2) {
    const s = sunAngles(place.lat, place.lon, momentAt(place, day, m)), x = Math.abs(s.el / D - elevationDeg);
    if (x < err) { err = x; best = m; }
  }
  return best;
}
/** A direction vector in the viewer's frame (x east, y up, -z north) for an elevation and azimuth. */
export function sunVector(el, az, northOffset = 0) {
  const a = az - northOffset;
  return [Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el)];
}

/**
 * The four skies. sky: the sky model's haze and scattering; sun: light colour and strength (scaled down as the sun
 * nears the horizon); hemi: sky and ground fill; env: how much the sky lights and reflects; exposure; shadow softness.
 */
export const PRESETS = {
  sunny: { name: "Sunny day", sky: { turbidity: 2.2, rayleigh: 1.6, mie: 0.004, g: 0.82 }, sun: { color: "#fff1dc", intensity: 3.6 }, hemi: { sky: "#dfe9ff", ground: "#5a5140", intensity: 0.35 },
    env: 0.6, exposure: 0.7, shadow: 2.5, time: 10 * 60 + 30 },
  overcast: { name: "Overcast", sky: { turbidity: 12, rayleigh: 0.6, mie: 0.02, g: 0.6 }, sun: { color: "#eef1f5", intensity: 0.55 }, hemi: { sky: "#e6ebf0", ground: "#6b665c", intensity: 1.05 },
    env: 1.1, exposure: 0.95, shadow: 14, time: 13 * 60, flatSky: "#c3c9cf" },
  golden: { name: "Golden hour", sky: { turbidity: 4.5, rayleigh: 2.4, mie: 0.006, g: 0.86 }, sun: { color: "#ffb36b", intensity: 3.0 }, hemi: { sky: "#c9d4ee", ground: "#5c4a36", intensity: 0.3 },
    env: 0.55, exposure: 0.82, shadow: 3, elevation: 9 },
  dusk: { name: "Dusk", sky: { turbidity: 6, rayleigh: 3.5, mie: 0.01, g: 0.9 }, sun: { color: "#ff8a4c", intensity: 0.6 }, hemi: { sky: "#7d8db8", ground: "#3a3230", intensity: 0.6 },
    env: 0.9, exposure: 1.15, shadow: 8, elevation: 0.6, lightsOn: true },
};
/** The sun's light colour and strength fade and warm as it nears the horizon. */
export function sunLight(preset, el) {
  const h = el / D;
  const k = h <= -1 ? 0 : h >= 15 ? 1 : (h + 1) / 16;
  return { intensity: preset.sun.intensity * (preset.lightsOn ? 1 : Math.pow(k, 0.7)), warm: h < 20 ? 1 - Math.max(0, h) / 20 : 0 };
}
