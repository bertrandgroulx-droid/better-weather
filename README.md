# ⛅ Better Weather

**A single-screen weather dashboard. Everything at a glance.**

Better Weather is a single-file, dependency-free web app. Search any city (or use
your device location) and see — all on one screen — current conditions, a 24-hour
hourly forecast, and a 14-day outlook. Powered by the free
[Open-Meteo API](https://open-meteo.com/) — **no API key required**.

## Features

- 🔎 **Search anywhere** — type a city name; geocoding finds it for you.
- 📍 **Use my location** — loads your local weather automatically on first visit.
- 🌡️ **Rich current conditions** — temperature, "feels like", humidity, wind
  speed/direction/gusts, pressure, cloud cover, UV index, and sunrise/sunset.
- 📈 **24-hour hourly charts** — temperature (line) with precipitation chance
  (bars) and a separate wind speed + gusts chart.
- 📅 **14-day outlook** — daily high/low temperature range bars (color-coded by
  temperature) plus precipitation chance.
- 🔁 **Metric or imperial** — toggle °C/km/h ↔ °F/mph; your choice is remembered.
- 🎨 **No build step, no dependencies, no chart library** — charts are drawn with
  hand-built inline SVG/CSS. It's just one `index.html`.

## Run it locally

It's a static file — open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying with GitHub Pages

This repo ships a GitHub Actions workflow (`.github/workflows/pages.yml`) that
deploys the site on every push to `main`. Set **Settings → Pages → Build and
deployment → Source** to **GitHub Actions** (one time). Once deployed, the site
is served at `https://<your-username>.github.io/better-weather/`.

## Credits

Weather and geocoding data from the free, open
[Open-Meteo API](https://open-meteo.com/).
