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
function buildForecast(tz) {
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
    latitude: 51.05, longitude: -114.07, timezone: tz || "America/Edmonton",
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
    // Return a timezone that matches the requested longitude so country-by-timezone
    // detection behaves like production: Calgary → Canada, Lisbon → Europe.
    const m = /[?&]longitude=(-?[\d.]+)/.exec(r.request().url());
    const lon = m ? parseFloat(m[1]) : -114.07;
    const tz = lon > -30 ? "Europe/Lisbon" : "America/Edmonton";
    return r.fulfill(json(buildForecast(tz)));
  });
  await page.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
  await page.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: {
    us_aqi: 63, us_aqi_ozone: 63, us_aqi_pm2_5: 41, us_aqi_pm10: 30, us_aqi_nitrogen_dioxide: 12,
    ozone: 96, pm2_5: 12, pm10: 20, nitrogen_dioxide: 15 } })));
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
  // Cells must be positioned relative to their strip (strip is position:relative), so
  // offsetLeft is strip-relative — the scroll-to-Now and track marker math depend on it.
  // (When the app is centred on desktop, a page-relative offsetLeft threw both far off.)
  assert(await page.$eval("#daily .cell.today", (el) => el.offsetParent === document.getElementById("daily")), "daily cell is positioned relative to the strip");
  assert(await page.$eval("#hourly .cell.now", (el) => el.offsetParent === document.getElementById("hourly")), "hourly cell is positioned relative to the strip");
  assert((await page.$eval("#summary .fcast", (e) => e.textContent.trim().length)) > 0, "precip outlook subtitle renders");
  // About panel opens and closes
  assert(await page.$eval("#aboutBackdrop", (e) => e.classList.contains("hidden")), "about panel hidden by default");
  await page.click("#aboutBtn");
  assert(!(await page.$eval("#aboutBackdrop", (e) => e.classList.contains("hidden"))), "about panel opens");
  await page.click("#aboutClose");
  assert(await page.$eval("#aboutBackdrop", (e) => e.classList.contains("hidden")), "about panel closes");
  // Info-page figures track the °C/°F toggle (metric by default; imperial on °F).
  assert((await page.$$eval("#aboutBackdrop .u-pmin", (e) => e.map((x) => x.textContent))).every((t) => t === "1 mm"), "info precip threshold is metric by default");
  await page.click("#unitF");
  await page.waitForTimeout(30);
  assert((await page.$$eval("#aboutBackdrop .u-pmin", (e) => e.map((x) => x.textContent))).every((t) => t === "0.04 in"), "info precip threshold switches to imperial");
  assert((await page.$eval("#aboutBackdrop .u-cell", (e) => e.textContent)) === "1–2 miles", "info grid size switches to miles");
  await page.click("#unitC"); // restore metric for the remaining assertions
  await page.waitForTimeout(30);
  assert((await page.$eval("#aboutBackdrop .u-cell", (e) => e.textContent)) === "1–3 km", "info grid size back to km");
  assert(!(await page.$("#daily .cell.today .fog")), "overnight fog does not make today foggy");
  assert(await page.$("#daily .fog"), "custom fog glyph renders (out-of-window day via daily code)");
  // Air quality: Calgary is in Canada, so the summary shows the AQHI (1–10), not the US AQI.
  const airLine = await page.$eval("#summary .air-line", (e) => e.textContent.replace(/\s+/g, " ").trim());
  assert(/\b4\b/.test(airLine) && /Moderate/.test(airLine), `Canada air line shows AQHI value + risk, got "${airLine}"`);
  assert(!/63/.test(airLine), `Canada should not show the US AQI value, got "${airLine}"`);
  assert(await page.$eval("#airBackdrop", (e) => e.classList.contains("hidden")), "air panel hidden by default");
  await page.click("#summary .air-line");
  assert(!(await page.$eval("#airBackdrop", (e) => e.classList.contains("hidden"))), "air panel opens on tap");
  const aqhiBadge = await page.$eval("#airBody .air-badge", (e) => e.textContent);
  assert(/AQHI/.test(aqhiBadge) && /Moderate/.test(aqhiBadge), `AQHI panel badge shows scale + risk, got "${aqhiBadge}"`);
  assert((await page.$$eval("#airBody .air-poll .prow", (e) => e.length)) === 3, "AQHI panel lists three contributing pollutants");
  assert((await page.$$eval("#airBody .airscale-bar .seg", (e) => e.length)) === 4, "AQHI scale has four colour bands");
  assert(await page.$("#airBody .airscale .needle"), "AQHI scale shows a where-you-sit marker");
  assert(/Moderate/.test(await page.$eval("#airBody .airscale-legend .lg.on", (e) => e.textContent)), "AQHI legend highlights the current band");
  await page.click("#airClose");
  assert(await page.$eval("#airBackdrop", (e) => e.classList.contains("hidden")), "air panel closes");

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
  // Correctly-measured thumb reflects the true window (~5% of 121 hourly cells);
  // the bug (measuring while hidden) left it at 100%.
  const thumbW = await page.$eval("#hThumb", (e) => parseFloat(e.style.width) || 0);
  assert(thumbW >= 3 && thumbW < 12, `hourly thumb sized after map pick, got ${thumbW}%`);
  assert(await page.$eval("#hMarker", (e) => e.style.display !== "none" && e.style.left !== ""), "now marker visible after map pick");
  // The bar reflects the true window, so the Now dot sits inside it at rest and
  // leaves it (to the right) once Now is scrolled off the right edge.
  const dotAtRest = await page.evaluate(() => {
    const th = document.getElementById("hThumb"), mk = document.getElementById("hMarker");
    const l = parseFloat(th.style.left) || 0, w = parseFloat(th.style.width) || 0, m = parseFloat(mk.style.left) || 0;
    return m >= l - 0.5 && m <= l + w + 0.5;
  });
  assert(dotAtRest, "Now dot sits within the window bar at rest");
  await page.$eval("#hourly", (e) => { e.scrollLeft = 0; });
  await page.waitForTimeout(30);
  const dotLeft = await page.evaluate(() => {
    const th = document.getElementById("hThumb"), mk = document.getElementById("hMarker");
    const l = parseFloat(th.style.left) || 0, w = parseFloat(th.style.width) || 0, m = parseFloat(mk.style.left) || 0;
    return m > l + w; // dot is to the right of (outside) the thumb
  });
  assert(dotLeft, "Now dot leaves the window bar when Now scrolls off to the right");

  // 3) Search (Mapbox mock) + recents
  await page.click("#cityPill");
  await page.fill("#searchInput", "Lisbon");
  await page.waitForFunction(() => document.querySelectorAll("#results li[data-i]").length > 0, { timeout: 5000 });
  await page.click('#results li[data-i="0"]');
  assert((await page.$eval("#cityName", (e) => e.textContent)) === "Lisbon", "selected place loads");
  // Lisbon (Portugal) is outside Canada → the scale switches back to the US AQI (0–500).
  const usLine = await page.$eval("#summary .air-line", (e) => e.textContent.replace(/\s+/g, " ").trim());
  assert(/63/.test(usLine) && /Moderate/.test(usLine), `non-Canada air line shows US AQI, got "${usLine}"`);
  await page.click("#summary .air-line");
  assert(/US AQI/.test(await page.$eval("#airBody .air-badge", (e) => e.textContent)), "US AQI panel for a non-Canada location");
  assert((await page.$$eval("#airBody .air-poll .prow", (e) => e.length)) === 4, "US AQI panel lists four pollutants");
  assert((await page.$$eval("#airBody .airscale-bar .seg", (e) => e.length)) === 6, "US AQI scale has six colour bands");
  assert(/Moderate/.test(await page.$eval("#airBody .airscale-legend .lg.on", (e) => e.textContent)), "US AQI legend highlights the current band");
  await page.click("#airClose");
  await page.click("#cityPill");
  assert(await page.$("#results .rc-head"), "recent header present");
  const recents = await page.$$eval("#results li[data-i]", (e) => e.map((x) => x.textContent));
  assert(recents.some((t) => t.includes("Lisbon")), "recent saved");
  // Per-item delete: seed two recents, remove one, and confirm the other stays.
  await page.click("#closeModal");
  await page.evaluate(() => localStorage.setItem("bw-recents", JSON.stringify([
    { name: "Lisbon", sub: "Portugal", lat: 38.72, lon: -9.13, cc: "PT" },
    { name: "Calgary", sub: "Alberta, Canada", lat: 51.05, lon: -114.07, cc: "CA" }
  ])));
  await page.click("#cityPill");
  assert((await page.$$eval("#results li[data-i]", (e) => e.length)) === 2, "two recents seeded");
  assert((await page.$$eval("#results .rc-del", (e) => e.length)) === 2, "each recent has a delete control");
  await page.click('#results li[data-i="0"] .rc-del'); // remove the first (Lisbon)
  const afterDel = await page.$$eval("#results li[data-i]", (e) => e.map((x) => x.textContent));
  assert(afterDel.length === 1 && afterDel[0].includes("Calgary"), `individual delete removes just that one, got ${JSON.stringify(afterDel)}`);
  // Clear all: removes the rest.
  await page.click("#results .rc-clear");
  assert((await page.$$eval("#results li[data-i]", (e) => e.length)) === 0, "recents cleared");

  // 4) Desktop pointer affordances (mouse drag + draggable thumb). page.mouse
  // dispatches mouse-type pointer events, so this exercises the non-touch paths
  // without disturbing the native touch scrolling used on phones.
  await page.click("#closeModal");
  await page.click("#tabWeather");
  await page.waitForTimeout(120);
  await page.$eval("#hourly", (e) => { e.scrollLeft = 0; });
  const hbox = await (await page.$("#hourly")).boundingBox();
  await page.mouse.move(hbox.x + hbox.width * 0.75, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hbox.x + hbox.width * 0.25, hbox.y + hbox.height / 2, { steps: 8 });
  await page.mouse.up();
  const dragScroll = await page.$eval("#hourly", (e) => e.scrollLeft);
  assert(dragScroll > 20, `mouse-drag scrolls the hourly strip, scrollLeft=${dragScroll}`);
  // Dragging the thumb scrubs the strip.
  await page.$eval("#hourly", (e) => { e.scrollLeft = 0; });
  await page.waitForTimeout(30);
  const tbox = await (await page.$("#hThumb")).boundingBox();
  await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tbox.x + tbox.width / 2 + 80, tbox.y + tbox.height / 2, { steps: 6 });
  await page.mouse.up();
  const thumbScroll = await page.$eval("#hourly", (e) => e.scrollLeft);
  assert(thumbScroll > 20, `dragging the thumb scrolls the strip, scrollLeft=${thumbScroll}`);

  assert(errors.length === 0, "page errors: " + errors.join(" | "));

  // 5) Dry outlook: a notable amount at a low chance softens "N days" to "N+ days";
  // a likely (>=50%) day stays firm. Uses a fully-dry hourly window so the outlook
  // falls through to the daily-extend branch.
  {
    const dryForecast = (dayOffset, sum, pop) => {
      const now = new Date(); now.setMinutes(0, 0, 0);
      const H = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [], wind_speed_10m: [], is_day: [] };
      const startH = new Date(now.getTime() - 48 * 3600e3);
      for (let i = 0; i < 121; i++) { const t = new Date(startH.getTime() + i * 3600e3); H.time.push(fmt(t)); H.temperature_2m.push(8); H.apparent_temperature.push(6); H.precipitation_probability.push(15); H.precipitation.push(0); H.weather_code.push(3); H.wind_speed_10m.push(20); H.is_day.push(1); }
      const D = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], sunrise: [], sunset: [] };
      const startD = new Date(now.getTime() - 7 * 86400e3);
      for (let i = 0; i < 23; i++) { const d = new Date(startD.getTime() + i * 86400e3); const wet = (i - 7) === dayOffset; D.time.push(fmtDate(d)); D.weather_code.push(wet ? 61 : 3); D.temperature_2m_max.push(12); D.temperature_2m_min.push(3); D.precipitation_sum.push(wet ? sum : 0); D.precipitation_probability_max.push(wet ? pop : 8); D.wind_speed_10m_max.push(28); const sr = new Date(d); sr.setHours(7, 29, 0, 0); const ss = new Date(d); ss.setHours(19, 25, 0, 0); D.sunrise.push(fmt(sr)); D.sunset.push(fmt(ss)); }
      return { latitude: 51.05, longitude: -114.07, timezone: "America/Edmonton", current: { time: fmt(now), temperature_2m: 6, apparent_temperature: 4, weather_code: 3, wind_speed_10m: 28, precipitation: 0, is_day: 1 }, hourly: H, daily: D };
    };
    const dctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const dpage = await dctx.newPage();
    let dryDay = [6, 5, 10]; // [dayOffset, sum(mm), pop(%)] — start with the low-confidence case
    await dpage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Calgary", admin1: "Alberta", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await dpage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(dryForecast(dryDay[0], dryDay[1], dryDay[2]))));
    await dpage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await dpage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 22 } })));
    await dpage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await dpage.goto(URL);
    await dpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const fcastSoft = await dpage.$eval("#summary .fcast", (e) => e.textContent.trim());
    assert(fcastSoft === "Dry for the next 6+ days", `low-confidence amount softens to N+, got "${fcastSoft}"`);
    dryDay = [4, 2, 60]; // a likely (>=50%) day, 4 out — should stay firm, no plus
    await dpage.reload();
    await dpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const fcastFirm = await dpage.$eval("#summary .fcast", (e) => e.textContent.trim());
    assert(fcastFirm === "Dry for the next 4 days", `a likely day stays firm, got "${fcastFirm}"`);
    await dctx.close();
  }

  // 6) Auto-refresh: a refocus refetches only once the data is stale, and does so
  // silently (the forecast stays on screen — no loading flash). Uses a fake clock.
  {
    const rctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const rpage = await rctx.newPage();
    await rpage.clock.install();
    let temp = 5, hits = 0;
    const fc = (t) => { const f = buildForecast(); f.current.temperature_2m = t; return f; };
    await rpage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Calgary", admin1: "Alberta", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await rpage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => { hits++; r.fulfill(json(fc(temp))); });
    await rpage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await rpage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await rpage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await rpage.goto(URL);
    await rpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    temp = 20; // change the source — a non-stale refocus must NOT pick it up
    await rpage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await rpage.waitForTimeout(50);
    assert((await rpage.$eval("#summary .temp", (e) => e.textContent)).startsWith("5"), "fresh data is not refetched on refocus");
    await rpage.clock.fastForward(31 * 60 * 1000); // now older than the stale threshold
    await rpage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await rpage.waitForFunction(() => document.querySelector("#summary .temp").textContent.startsWith("20"), { timeout: 5000 });
    assert(await rpage.$eval("#result", (e) => !e.classList.contains("hidden")), "auto-refresh keeps the forecast visible (no loading flash)");
    await rctx.close();
  }

  await browser.close();
  console.log(`PASS — hourly=${hourly} daily=${daily} recents+tabs+search OK`);
}

run().catch((err) => { console.error("FAIL —", err.message); process.exit(1); });
