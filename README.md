# ⛅ Better Weather

**A phone-first weather app that fits on one screen.**

Better Weather is a single-file, dependency-free web app designed for a phone in
portrait. It fits the whole picture on one screen: a condensed current summary up
top, then horizontally scrollable **Hourly** and **Daily** strips you can swipe
through — including recent history. Powered by the free
[Open-Meteo API](https://open-meteo.com/) — **no API key required**.

## Features

- 📱 **Phone-first, single screen** — everything fits in portrait; the two
  forecast strips scroll sideways rather than pushing the page down.
- 🔎 **Search in a modal** — tap the city pill to open a search dialog with live
  results for cities, addresses and points of interest (via Mapbox geocoding,
  falling back to Open-Meteo's city geocoder when no token is set), or "Use my
  current location". Recent searches are remembered and shown when you reopen it.
- 🔁 **°C / °F toggle** — switch units in the top bar; your choice is remembered.
- 🧾 **Daily summary** — big current temperature and condition, "feels like",
  today's high/low **with the time they occur**, POP, precipitation total, wind
  high/low, and sunrise/sunset.
- ⏱️ **Hourly strip** — swipe left/right through **48 hours of history** and
  **72 hours ahead** of "Now". A weekday label and divider mark each new day.
  Each hour shows the icon, temperature, feels-like, precipitation chance, and a
  rising "water" fill for the amount.
- 📅 **Daily strip** — swipe through the full range, with **7 days of history**
  behind "Today", out to ~16 days ahead. Each day shows day/night icons,
  high/low, precipitation chance, and the precip "water" fill.
- 🟡 **Scroll indicators** — a position bar under each strip shows where you are.
- 🗺️ **Animated radar tab** — a bottom tab opens a full-screen zoomable map with
  animated precipitation radar (rain and snow) you scrub through the recent past
  and short-term nowcast, centered on your location. Radar tiles are the free,
  keyless [RainViewer](https://www.rainviewer.com/) feed on a
  [Leaflet](https://leafletjs.com/) map. The basemap uses
  [Mapbox](https://www.mapbox.com/) (dark style) — set your token in the
  `MAPBOX_TOKEN` constant near the top of the script; leave it blank to fall
  back to OpenStreetMap. Restrict the token to your site's URL in the Mapbox
  dashboard, since it's visible in the page.
- 🎨 **No build step** — plain static files served as-is: `index.html` holds the
  forecast app (CSS + inline script), and the radar map lives in a separate
  `radar.js` module (`createRadar(ctx)` factory). Tunables live in a single
  `CONFIG` block near the top of the script.
- 📲 **Add to Home Screen** — ships an `apple-touch-icon` and a web manifest, so
  on iOS (Share → *Add to Home Screen*) it gets a custom icon and launches
  full-screen; installable on Android too.

## Run it locally

It's a static file — open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Services & keys

The app is client-side only but talks to several external services. Good to know
what can break and where:

| Service | Used for | Key? | Notes |
|---|---|---|---|
| [Open-Meteo Forecast](https://open-meteo.com/) | Current + hourly + daily forecast | none | Free, no key |
| [Open-Meteo Archive](https://open-meteo.com/en/docs/historical-weather-api) | ERA5 reanalysis for older history days | none | ~5-day latency |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | City search fallback | none | Used only if no Mapbox token |
| [Mapbox](https://www.mapbox.com/) | Map dark basemap **and** address/POI geocoding | **`pk.` token** | Free tier; token is in `MAPBOX_TOKEN` (base64) and must be **URL-restricted** to your site |
| [RainViewer](https://www.rainviewer.com/) | Animated precipitation radar tiles | none | Free tier: ~2h past, no future, zoom ≤ 7, rate-limited |
| [Leaflet](https://leafletjs.com/) (cdnjs) | Map rendering library | none | Loaded from CDN in `<head>` |
| [OpenStreetMap tiles](https://www.openstreetmap.org/) | Basemap fallback when no Mapbox token | none | Light theme |

The Mapbox token is a **public** token (safe to expose) but should be locked to
your domain in the Mapbox dashboard. To change it, base64-encode the new token
and replace the value in the `MAPBOX_TOKEN` line, or set a plain `pk.…` string.

## Testing

A headless smoke test (Playwright, with the network mocked) checks that the
forecast renders, the tabs switch, and search + recents work:

```sh
npm install
npm test
```

It also runs in CI on every push/PR (`.github/workflows/ci.yml`).

## Deploying with GitHub Pages

This repo ships a GitHub Actions workflow (`.github/workflows/pages.yml`) that
deploys the site on every push to `main`. Set **Settings → Pages → Build and
deployment → Source** to **GitHub Actions** (one time). Once deployed, the site
is served at `https://<your-username>.github.io/better-weather/`.

## Credits

Weather and geocoding data from the free, open
[Open-Meteo API](https://open-meteo.com/).
