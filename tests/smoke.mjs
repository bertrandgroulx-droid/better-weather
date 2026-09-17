// Headless smoke test — loads the app with the network mocked and checks the
// forecast renders, the tabs switch, and search + recent searches work.
// Run: npm test   (needs `npx playwright install chromium` once).
import { chromium } from "playwright";
import assert from "node:assert";
import { pathToFileURL } from "node:url";
import path from "node:path";

const URL = pathToFileURL(path.resolve("index.html")).href;

function pad(n) { return String(n).padStart(2, "0"); }
function fmt(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function fmtDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

// Minimal but shape-correct Open-Meteo forecast (48h past + now + 72h future,
// 7 past days + 16 forecast days).
function buildForecast() {
  const now = new Date(); now.setMinutes(0, 0, 0);
  const H = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [], wind_speed_10m: [], is_day: [] };
  const startH = new Date(now.getTime() - 48 * 3600e3);
  for (let i = 0; i < 48 + 1 + 72; i++) {
    const t = new Date(startH.getTime() + i * 3600e3);
    const hr = t.getHours();
    H.time.push(fmt(t));
    H.temperature_2m.push(15 + (hr % 8));
    H.apparent_temperature.push(14 + (hr % 8));
    H.precipitation_probability.push(hr % 100);
    H.precipitation.push(hr % 5 === 0 ? 0.4 : 0);
    // Foggy overnight, clear-ish by day: the daily icon should ignore the
    // overnight fog and never mark a covered day foggy.
    H.weather_code.push(hr >= 7 && hr <= 19 ? 2 : 45);
    H.wind_speed_10m.push(10 + (hr % 5));
    H.is_day.push(hr >= 7 && hr <= 19 ? 1 : 0);
  }
  const D = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], sunrise: [], sunset: [] };
  const startD = new Date(now.getTime() - 7 * 86400e3);
  for (let i = 0; i < 7 + 16; i++) {
    const d = new Date(startD.getTime() + i * 86400e3);
    D.time.push(fmtDate(d));
    // A far-out day (beyond the hourly window) is fog: its icon comes from the
    // daily code (fallback path) and should render the custom fog glyph.
    D.weather_code.push(i === 20 ? 45 : [2, 3, 61, 2][i % 4]);
    D.temperature_2m_max.push(18 - (i % 5));
    D.temperature_2m_min.push(7 + (i % 4));
    D.precipitation_sum.push([2, 0, 1, 7][i % 4]);
    D.precipitation_probability_max.push([20, 40, 60, 70][i % 4]);
    D.wind_speed_10m_max.push(25);
    const sr = new Date(d); sr.setHours(6, 23, 0, 0);
    const ss = new Date(d); ss.setHours(20, 35, 0, 0);
    D.sunrise.push(fmt(sr)); D.sunset.push(fmt(ss));
  }
  return {
    latitude: 51.05, longitude: -114.07, timezone: "America/Edmonton",
    current: { time: fmt(now), temperature_2m: 13, apparent_temperature: 11, relative_humidity_2m: 60, weather_code: 2, wind_speed_10m: 18, precipitation: 0, is_day: 1 },
    hourly: H, daily: D
  };
}

const json = (body) => ({ contentType: "application/json", body: JSON.stringify(body) });

async function run() {
  // CHROMIUM_PATH lets a pre-installed browser be used; CI uses the default.
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true,
    permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) =>
    r.fulfill(json({ results: [{ name: "Calgary", admin1: "Alberta", country: "Canada", latitude: 51.05, longitude: -114.07 }] })));
  // First forecast request fails with a transient 503; the app should retry and recover.
  let forecastHits = 0;
  await page.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => {
    forecastHits++;
    if (forecastHits === 1) return r.fulfill({ status: 503, contentType: "text/plain", body: "Service Unavailable" });
    return r.fulfill(json(buildForecast()));
  });
  await page.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
  await page.route(/api\.mapbox\.com\/search\/geocode/, (r) =>
    r.fulfill(json({ features: [{ properties: { name: "Lisbon", place_formatted: "Portugal" }, geometry: { coordinates: [-9.13, 38.72] } }] })));
  await page.route(/api\.rainviewer\.com/, (r) => r.fulfill(json({ host: "https://x", radar: { past: [], nowcast: [] } })));
  // Don't hit real tile servers.
  await page.route(/(tilecache\.rainviewer\.com|api\.mapbox\.com\/styles|tile\.openstreetmap\.org)/, (r) => r.abort());

  await page.goto(URL);

  // 1) Forecast renders
  await page.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
  const hourly = await page.$$eval("#hourly .cell", (e) => e.length);
  const daily = await page.$$eval("#daily .cell", (e) => e.length);
  assert(hourly > 100 && hourly < 130, `hourly cells ~121, got ${hourly}`);
  assert(daily === 23, `daily cells 23, got ${daily}`);
  assert(forecastHits >= 2, `transient 503 should be retried, forecast requests = ${forecastHits}`);
  assert((await page.$eval("#hourly .cell.now .lbl", (e) => e.textContent)) === "Now", "now marker");
  assert((await page.$eval("#summary .fcast", (e) => e.textContent.trim().length)) > 0, "precip outlook subtitle renders");
  assert(!(await page.$("#daily .cell.today .fog")), "overnight fog does not make today foggy");
  assert(await page.$("#daily .fog"), "custom fog glyph renders (out-of-window day via daily code)");

  // 2) Tabs switch
  await page.click("#tabRadar");
  assert(await page.$eval("#radar", (e) => !e.classList.contains("hidden")), "radar shown");
  assert(await page.$eval("#result", (e) => e.classList.contains("hidden")), "weather hidden on map");
  assert((await page.getAttribute("#tabRadar", "aria-selected")) === "true", "aria-selected on map tab");
  // Tap-to-pick confirm bar exists and starts hidden (map itself can't init headlessly).
  assert(await page.$eval("#radarPick", (e) => e.classList.contains("hidden")), "pick bar hidden until a point is tapped");
  // Search dialog opens cleanly over the map: overlays hidden, dialog stacked above them.
  await page.click("#cityPill");
  assert(await page.$eval("body", (b) => b.classList.contains("searching")), "searching class set over map");
  assert(await page.$eval(".radar-legend", (e) => getComputedStyle(e).display === "none").catch(() => true), "map legend hidden while searching");
  assert(await page.$eval(".backdrop", (e) => parseInt(getComputedStyle(e).zIndex, 10) > 1000), "dialog stacked above map controls");
  await page.click("#closeModal");
  assert(!(await page.$eval("body", (b) => b.classList.contains("searching"))), "searching class cleared on close");

  // Selecting a location while ON the map renders the strips hidden; switching to
  // Weather must lay them out (thumb sized, Now/Today marker visible) — regression
  // guard for picking a forecast location from the map.
  await page.click("#cityPill");
  await page.fill("#searchInput", "Lisbon");
  await page.waitForFunction(() => document.querySelectorAll("#results li[data-i]").length > 0, { timeout: 5000 });
  await page.click('#results li[data-i="0"]');
  await page.click("#tabWeather");
  await page.waitForTimeout(120); // allow the rAF layout to run
  assert(await page.$eval("#result", (e) => !e.classList.contains("hidden")), "weather restored");
  // Correctly-measured thumb is small (~10%); the bug (measuring while hidden)
  // leaves it at 100%.
  const thumbW = await page.$eval("#hThumb", (e) => parseFloat(e.style.width) || 0);
  assert(thumbW >= 10 && thumbW < 30, `hourly thumb sized after map pick, got ${thumbW}%`);
  assert(await page.$eval("#hMarker", (e) => e.style.display !== "none" && e.style.left !== ""), "now marker visible after map pick");

  // 3) Search (Mapbox mock) + recents
  await page.click("#cityPill");
  await page.fill("#searchInput", "Lisbon");
  await page.waitForFunction(() => document.querySelectorAll("#results li[data-i]").length > 0, { timeout: 5000 });
  await page.click('#results li[data-i="0"]');
  assert((await page.$eval("#cityName", (e) => e.textContent)) === "Lisbon", "selected place loads");
  await page.click("#cityPill");
  assert(await page.$("#results .rc-head"), "recent header present");
  const recents = await page.$$eval("#results li[data-i]", (e) => e.map((x) => x.textContent));
  assert(recents.some((t) => t.includes("Lisbon")), "recent saved");
  await page.click("#results .rc-clear");
  assert((await page.$$eval("#results li[data-i]", (e) => e.length)) === 0, "recents cleared");

  assert(errors.length === 0, "page errors: " + errors.join(" | "));
  await browser.close();
  console.log(`PASS — hourly=${hourly} daily=${daily} recents+tabs+search OK`);
}

run().catch((err) => { console.error("FAIL —", err.message); process.exit(1); });
