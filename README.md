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
  city results, or "Use my current location".
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
- 🎨 **No build step, no dependencies, no chart library** — it's just one
  `index.html` with hand-built CSS/SVG.
- 📲 **Add to Home Screen** — ships an `apple-touch-icon` and a web manifest, so
  on iOS (Share → *Add to Home Screen*) it gets a custom icon and launches
  full-screen; installable on Android too.

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
