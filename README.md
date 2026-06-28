# 🐦 Skylark

**A tiny, friendly weather app. Search a place, see the sky.**

Skylark is a single-file, dependency-free web app. Search any city (or use your
device location) to get current conditions plus a 7-day forecast, all powered by
the free [Open-Meteo API](https://open-meteo.com/) — **no API key required**.

## Features

- 🔎 **Search anywhere** — type a city name; geocoding finds it for you.
- 📍 **Use my location** — one tap for weather where you are.
- 🌡️ **Now & next** — current temperature, "feels like", humidity, wind, and a
  7-day forecast with highs, lows, and precipitation chance.
- 🔁 **Metric or imperial** — toggle °C/km/h ↔ °F/mph; your choice is remembered.
- 🎨 **No build step, no dependencies** — it's just one `index.html`.

## Run it locally

It's a static file — open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying with GitHub Pages

This repo ships a GitHub Actions workflow (`.github/workflows/pages.yml`) that
deploys the site on every push to `main`. The workflow enables Pages
automatically the first time it runs.

If your repository settings require it, set **Settings → Pages → Build and
deployment → Source** to **GitHub Actions**. Once deployed, the site is served
at `https://<your-username>.github.io/better-weather/`.

## Credits

Weather and geocoding data from the free, open
[Open-Meteo API](https://open-meteo.com/).
