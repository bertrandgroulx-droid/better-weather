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
  const H = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], is_day: [] };
  const startH = new Date(now.getTime() - 48 * 3600e3);
  for (let i = 0; i < 48 + 1 + 72; i++) {
    const t = new Date(startH.getTime() + i * 3600e3);
    const hr = t.getHours();
    H.time.push(fmt(t));
    H.temperature_2m.push(15 + (hr % 8));
    H.apparent_temperature.push(14 + (hr % 8));
    H.precipitation_probability.push(hr % 100);
    H.precipitation.push(hr % 5 === 0 ? 0.4 : 0);
    H.wind_gusts_10m.push(18 + (hr % 7));
    H.wind_direction_10m.push((200 + i * 9) % 360);
    // Foggy overnight + a brief foggy morning (7–9), then clear (10–14) and
    // overcast (15–19). The daily icon should ignore the minority fog AND, since
    // the dry-sky hours are an even clear/overcast mix, read as partly cloudy —
    // not fog, and not the single cloudiest hour.
    H.weather_code.push(hr >= 7 && hr <= 19 ? (hr <= 9 ? 45 : (hr <= 14 ? 0 : 3)) : 45);
    H.wind_speed_10m.push(10 + (hr % 5));
    H.is_day.push(hr >= 7 && hr <= 19 ? 1 : 0);
  }
  const D = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], wind_direction_10m_dominant: [], sunrise: [], sunset: [] };
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
    D.wind_direction_10m_dominant.push(315); // NW
    const sr = new Date(d); sr.setHours(6, 23, 0, 0);
    const ss = new Date(d); ss.setHours(20, 35, 0, 0);
    D.sunrise.push(fmt(sr)); D.sunset.push(fmt(ss));
  }
  return {
    latitude: 51.05, longitude: -114.07, timezone: tz || "America/Edmonton",
    // Open-Meteo gives the current time to the quarter hour — never assume it lands on the hour
    current: { time: fmt(new Date(now.getTime() + 30 * 60000)), temperature_2m: 13, apparent_temperature: 11, relative_humidity_2m: 60, weather_code: 2, wind_speed_10m: 18, wind_gusts_10m: 31, wind_direction_10m: 315, precipitation: 0, is_day: 1 },
    hourly: H, daily: D
  };
}

const json = (body) => ({ contentType: "application/json", body: JSON.stringify(body) });

async function run() {
  // CHROMIUM_PATH lets a pre-installed browser be used; CI uses the default.
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, // a phone: Find the Moon is offered on touch devices
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
  await page.route(/(tilecache\.rainviewer\.com|api\.mapbox\.com\/styles|tile\.openstreetmap\.org|arcgisonline\.com)/, (r) => r.abort());

  await page.goto(URL);

  // 1) Forecast renders
  await page.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
  const hourly = await page.$$eval("#hourly .cell", (e) => e.length);
  const daily = await page.$$eval("#daily .cell", (e) => e.length);
  assert(hourly > 100 && hourly < 130, `hourly cells ~121, got ${hourly}`);
  assert(daily === 23, `daily cells 23, got ${daily}`);
  assert(forecastHits >= 2, `transient 503 should be retried, forecast requests = ${forecastHits}`);
  assert((await page.$eval("#hourly .cell.now .lbl", (e) => e.textContent)) === "Now", "now marker");
  // "Now" is the hour that contains the current time (xx:30 → the xx:00 slot), so the next cell
  // is one hour on — not two, as happened when the lookup fell through to the first slot after now
  {
    const h0 = new Date(); h0.setMinutes(0, 0, 0); const hN = h0.getUTCHours(); // the fixture's times are UTC strings
    if (hN !== 23) { // at 23:xx the next cell starts a new day and carries a day label instead
      const want = ((hN + 1) % 12 || 12) + ((hN + 1) % 24 < 12 ? "am" : "pm");
      const next = await page.$eval("#hourly .cell.now + .cell .lbl", (e) => e.textContent.trim());
      assert(next === want, `cell after Now is the next hour (${want}), got "${next}"`);
    }
  }
  // Cells must be positioned relative to their strip (strip is position:relative), so
  // offsetLeft is strip-relative — the scroll-to-Now and track marker math depend on it.
  // (When the app is centred on desktop, a page-relative offsetLeft threw both far off.)
  assert(await page.$eval("#daily .cell.today", (el) => el.offsetParent === document.getElementById("daily")), "daily cell is positioned relative to the strip");
  assert(await page.$eval("#hourly .cell.now", (el) => el.offsetParent === document.getElementById("hourly")), "hourly cell is positioned relative to the strip");
  assert((await page.$eval("#summary .fcast", (e) => e.textContent.trim().length)) > 0, "precip outlook subtitle renders");
  // Summary card layout (design v5): the place name on top, one metrics column in the order
  // Daylight · Wind · Air Quality · Moon; POP, Precip, H/L and the right column are gone
  {
    const card = await page.$eval("#summary", (c) => {
      const top = (sel) => { const e = c.querySelector(sel); return e ? e.getBoundingClientRect().top : null; };
      return {
        order: [top(".sum-loc"), top(".sum-hero"), top(".fcast"), top(".sum-left")],
        lines: [...c.querySelectorAll(".sum-metrics > div")].map((d) => d.className.split(" ")[0]),
        text: c.querySelector(".sum-metrics").textContent.replace(/\s+/g, " "),
        right: !!c.querySelector(".sum-right"),
        about: !!c.querySelector(".sum-left #aboutBtn"),
      };
    });
    assert(card.order.every((v, i, a) => v != null && (i === 0 || v > a[i - 1])), `card rows run place · temperature · outlook · metrics, got ${JSON.stringify(card.order)}`);
    assert(JSON.stringify(card.lines.filter((k) => k !== "air-line")) === JSON.stringify(["day-line", "wind-line", "moon-line"]), `metrics column is Daylight, Wind, (Air), Moon, got ${JSON.stringify(card.lines)}`);
    assert(!/\bPOP\b|Precip|\bH:|\bL:/.test(card.text) && !card.right, `POP, Precip, H/L and the right column are gone, got "${card.text}"`);
    assert(/Daylight\s+\d+h \d+m \(\d{1,2}:\d\d [ap]m to \d{1,2}:\d\d [ap]m\)/.test(card.text), `Daylight carries the sunrise–sunset window, got "${card.text}"`);
    assert(/Moon:\s+(New\s+[A-Z][a-z]{2} \d{1,2}\s*Full|Full\s+[A-Z][a-z]{2} \d{1,2}\s*New)\s+[A-Z][a-z]{2} \d{1,2}/.test(card.text), `moon line reads "Moon: New <date> Full <date>", got "${card.text}"`);
    assert(card.about, "the ⓘ sits in the metrics column");
  }
  // no bold anywhere (design review): every rendered element uses the regular weight
  {
    const heavy = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.offsetParent !== null && parseInt(getComputedStyle(e).fontWeight, 10) > 400).map((e) => e.tagName + "." + e.className).slice(0, 5));
    assert(heavy.length === 0, `no element renders bold, found ${JSON.stringify(heavy)}`);
  }
  // Wind line: a direction arrow (from-direction, in the accessible name) + unit
  // once, then H/L without repeated units
  const windLine = await page.$eval("#summary .sum-metrics", (e) => {
    const div = [...e.querySelectorAll("div")].find((d) => /^Wind/.test(d.textContent));
    return div ? div.textContent.replace(/\s+/g, " ").trim() : "";
  });
  assert(/^Wind\s/.test(windLine), `wind line starts with Wind, got "${windLine}"`);
  assert((windLine.match(/km\/h/g) || []).length === 1, `wind unit appears once, got "${windLine}"`);
  assert(!/gust/i.test(windLine), `the word "gust" is replaced by an icon, got "${windLine}"`);
  assert(await page.$("#summary .wind-line .gust-ico"), "gust shown as an icon");
  const arrowLbl = await page.$eval("#summary .wind-line .dir-arrow", (e) => e.getAttribute("aria-label"));
  assert(/wind from the (N|S|E|W|NE|NW|SE|SW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW)/.test(arrowLbl), `direction arrow names the compass source, got "${arrowLbl}"`);
  const rot = await page.$eval("#summary .wind-line .dir-arrow path", (e) => e.getAttribute("transform"));
  assert(/rotate\(\d+/.test(rot), `arrow is rotated to the direction, got "${rot}"`);
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
  // A day that mixes clear and overcast hours reads as partly cloudy (⛅), not as
  // its single cloudiest hour (☁️) — the daily icon averages the sky.
  assert((await page.$eval("#daily .cell.today .ic", (e) => e.textContent)) === "⛅", "mixed sun/cloud day reads partly cloudy, not overcast");
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
  // Moon line taps open the Moon panel: shaded disc, phase, hourly scrubber, stats, calendar.
  assert(await page.$eval("#moonBackdrop", (e) => e.classList.contains("hidden")), "moon panel hidden by default");
  await page.click("#summary .moon-line");
  assert(!(await page.$eval("#moonBackdrop", (e) => e.classList.contains("hidden"))), "moon panel opens on tap");
  assert(await page.$("#moDisc .mo-moon"), "moon disc rendered");
  const phase = await page.$eval("#moPhase", (e) => e.textContent);
  assert(/^(New Moon|Waxing Crescent|First Quarter|Waxing Gibbous|Full Moon|Waning Gibbous|Last Quarter|Waning Crescent)$/.test(phase), `phase name, got "${phase}"`);
  const stats = await page.$$eval("#moStats .mo-row", (e) => e.map((x) => x.textContent));
  assert(!stats.some((t) => /^Illumination/.test(t)), "no Illumination row (the scrubber band shows it)");
  assert(stats.some((t) => /^(Moonrise|Moonset)/.test(t)) || stats.some((t) => /none today/.test(t)), "moonrise/moonset rows");
  // Find the Moon: offered on a touch device with orientation events; synthetic sensor
  // events drive the turn/tilt guidance and the on-target ring
  assert(await page.$eval("#moFind", (b) => getComputedStyle(b).display !== "none"), "Find the Moon button offered on a touch device");
  await page.click("#moFind");
  await page.waitForSelector("#findBackdrop:not(.hidden)", { timeout: 3000 });
  const tgt = await page.$eval("#findTarget", (e) => { const m = e.textContent.match(/(\d+)°,\s*(\d+)° (above|below)/); return m ? { az: +m[1], alt: (m[3] === "below" ? -1 : 1) * +m[2] } : null; });
  const aim = async (heading, tiltUp) => { for (let i = 0; i < 14; i++) { await page.evaluate(([h, t]) => { const ev = new Event(("ondeviceorientationabsolute" in window) ? "deviceorientationabsolute" : "deviceorientation"); Object.defineProperty(ev, "webkitCompassHeading", { value: h }); Object.defineProperty(ev, "alpha", { value: null }); Object.defineProperty(ev, "beta", { value: t }); /* pointer model: tilt = beta */ Object.defineProperty(ev, "gamma", { value: 0 }); window.dispatchEvent(ev); }, [heading, tiltUp]); await page.waitForTimeout(25); } };
  assert(tgt, `find header gives the Moon's bearing and height, got "${await page.$eval("#findTarget", (e) => e.textContent)}"`);
  // magnetic declination is applied automatically (World Magnetic Model): Calgary is ~13° east in
  // 2026, so the phone's raw (magnetic) heading has to be 13° short of the Moon's true bearing
  const declTxt = await page.$eval("#findDecl", (e) => e.textContent);
  const declM = declTxt.match(/magnetic north ([+−])(\d+)°/);
  assert(declM, `finder states the declination correction, got "${declTxt.trim()}"`);
  const decl = (declM[1] === "−" ? -1 : 1) * +declM[2];
  assert(decl >= 12 && decl <= 15, `Calgary declination ~13° E from the WMM, got ${decl}`);
  const mag = (trueAz) => (trueAz - decl + 720) % 360; // what the phone's compass would read
  // aim off (above or below the horizon alike), then on
  await aim(mag(tgt.az + 40), tgt.alt - 20);
  const off = await page.$eval("#findBody", (e) => e.textContent.replace(/\s+/g, " "));
  // ±1°: the test aims with the declination as displayed (rounded); the app uses the exact value
  assert(/left (39|40|41)°/.test(off) && /up (19|20|21)°/.test(off), `find guidance says turn left ~40° / tilt up ~20°, got "${off.slice(0, 200)}"`);
  await aim(tgt.az, tgt.alt); // the true bearing fed as a magnetic one: 13° off → ring dark
  assert(!(await page.$eval("#findView", (v) => v.classList.contains("on"))), "ring is dark when the raw heading equals the true bearing (declination applied)");
  await aim(mag(tgt.az), tgt.alt);
  assert(await page.$eval("#findView", (v) => v.classList.contains("on")), "ring lights when the raw heading is the magnetic bearing of the Moon");
  await page.click("#findClose");
  assert(await page.$eval("#findBackdrop", (e) => e.classList.contains("hidden")) && !(await page.$eval("#moonBackdrop", (e) => e.classList.contains("hidden"))), "closing Find returns to the Moon panel");
  // hero's third line: the Moon's place in the sky at the scrubbed hour, or not visible
  const sky = await page.$eval("#moSky", (e) => e.textContent.replace(/\s+/g, " ").trim());
  assert(/^[NESW]{1,3} \d{1,3}°, \d{1,2}° (above|below) the horizon$/.test(sky), `hero sky line, got "${sky}"`);
  // each rise/set carries its compass bearing ahead of the time, e.g. "NE 55° 1:18 AM"
  assert(stats.filter((t) => /^(Moonrise|Moonset)/.test(t)).every((t) => /^Moon(rise|set)[NESW]{1,3} \d{1,3}° \d{1,2}:\d\d [AP]M$/.test(t)), `moonrise/moonset bearings, got ${JSON.stringify(stats)}`);
  assert(stats.some((t) => /^Next full moon\([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}\) (Today|Tomorrow|\d+ days)$/.test(t)), "next full moon row shows the date then the count");
  // distance: surface to surface, no toggle, above the moon so it stays in view while scrubbing
  assert(/^[\d,]+ (km|mi)$/.test(await page.$eval("#moDist .md-val", (e) => e.textContent)), "distance figure on the perigee–apogee scale");
  assert(await page.$("#moDist .md-mark"), "distance marker on the scale");
  assert(!(await page.$("#moonBody [data-dm]")), "no Centre/Surface toggle");
  assert(await page.$eval("#moonBody", (b) => { const d = b.querySelector("#moDist"), h = b.querySelector(".mo-hero"); return d.getBoundingClientRect().bottom <= h.getBoundingClientRect().top; }), "distance sits above the moon");
  // scrubber: a month (15 days either side), drawn as the illumination band with a tick per midnight
  assert((await page.$$eval("#moTrack .mb-day", (e) => e.length)) >= 30, "scrubber spans a month of midnights");
  assert(await page.$("#moTrack .mb-illum"), "illumination band drawn");
  const calDays = await page.$$eval("#moCal .mc-d[data-ms]", (e) => e.length);
  assert(calDays >= 28 && calDays <= 31, `calendar has a cell per day, got ${calDays}`);
  assert(await page.$("#moCal .mc-d.today"), "today highlighted in the calendar");
  const evs = await page.$$eval("#moCal .mo-ev", (e) => e.map((x) => x.textContent));
  assert(evs.some((t) => /New Moon/.test(t)) || evs.some((t) => /Full Moon/.test(t)), "month lists its new/full moons");
  // scrubbing by scroll changes the selected hour; the calendar's next-month arrow works
  const when0 = await page.$eval("#moWhen", (e) => e.textContent);
  await page.$eval("#moScroll", (e) => { e.scrollLeft += 7 * 24 * 2; });
  await page.waitForTimeout(250);
  assert((await page.$eval("#moWhen", (e) => e.textContent)) !== when0, "scrubbing moves the selected time");
  // the track marks the current hour "Now" (in place of today's date)
  assert((await page.$$eval("#moTrack .ml-now", (e) => e.map((x) => x.textContent))).join() === "Now", "moon track labels the current hour Now");
  // drag anywhere: a sideways drag across the Moon picture moves the scrubber; an up/down one doesn't
  const drag = async (pg, sel, dx, dy) => { const b = await (await pg.$(sel)).boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2; await pg.mouse.move(x, y); await pg.mouse.down(); for (let k = 1; k <= 10; k++) await pg.mouse.move(x + dx * k / 10, y + dy * k / 10); await pg.mouse.up(); await pg.waitForTimeout(300); };
  const sl0 = await page.$eval("#moScroll", (e) => e.scrollLeft), when1 = await page.$eval("#moWhen", (e) => e.textContent);
  await drag(page, "#moDisc", 0, 40);
  assert(Math.abs((await page.$eval("#moScroll", (e) => e.scrollLeft)) - sl0) < 2, "an up/down drag on the Moon panel leaves the scrubber");
  await drag(page, "#moDisc", -120, 0);
  assert((await page.$eval("#moScroll", (e) => e.scrollLeft)) > sl0 + 60 && (await page.$eval("#moWhen", (e) => e.textContent)) !== when1, "a sideways drag on the Moon picture moves the scrubber");
  const title0 = await page.$eval("#moCal .mc-title", (e) => e.textContent);
  await page.click('#moCal .mc-nav[data-nav="1"]');
  assert((await page.$eval("#moCal .mc-title", (e) => e.textContent)) !== title0, "calendar steps to the next month");
  await page.click("#moonClose");
  assert(await page.$eval("#moonBackdrop", (e) => e.classList.contains("hidden")), "moon panel closes");

  // 2) Tabs switch
  await page.click("#tabRadar");
  assert(await page.$eval("#radar", (e) => !e.classList.contains("hidden")), "radar shown");
  assert(await page.$eval("#result", (e) => e.classList.contains("hidden")), "weather hidden on map");
  assert((await page.getAttribute("#tabRadar", "aria-selected")) === "true", "aria-selected on map tab");
  // Tap-to-pick confirm bar exists and starts hidden (map itself can't init headlessly).
  assert(await page.$eval("#radarPick", (e) => e.classList.contains("hidden")), "pick bar hidden until a point is tapped");
  // Legend: separate rain and snow scales.
  assert(await page.$$eval(".radar-legend .lg-grad", (g) => g.map((e) => e.className).join()) === "lg-grad rain,lg-grad snow", "legend has rain and snow scales");
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

  // 7) Remember last location: first run geolocates, but after choosing a specific
  // place, reopening restores it. With permission already granted and a remembered
  // current location, reopening may quietly refresh that location for the summary
  // card's step list — but it must never change the restored place, and with no
  // remembered location it must not request geolocation at all (no surprise prompt).
  {
    const lctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const lpage = await lctx.newPage();
    let revHits = 0;
    await lpage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => { revHits++; r.fulfill(json({ results: [{ name: "Calgary", admin1: "Alberta", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })); });
    await lpage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(buildForecast())));
    await lpage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await lpage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await lpage.route(/api\.mapbox\.com\/search\/geocode/, (r) => r.fulfill(json({ features: [{ properties: { name: "Lisbon", place_formatted: "Portugal" }, geometry: { coordinates: [-9.13, 38.72] } }] })));
    await lpage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com\/styles|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await lpage.goto(URL);
    await lpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    assert((await lpage.$eval("#cityName", (e) => e.textContent)) === "Calgary", "first run geolocates");
    const revAfterFirst = revHits;
    await lpage.click("#cityPill");
    await lpage.fill("#searchInput", "Lisbon");
    await lpage.waitForFunction(() => document.querySelectorAll("#results li[data-i]").length > 0, { timeout: 5000 });
    await lpage.click('#results li[data-i="0"]');
    assert((await lpage.$eval("#cityName", (e) => e.textContent)) === "Lisbon", "a specific place is selected");
    await lpage.reload();
    await lpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    assert((await lpage.$eval("#cityName", (e) => e.textContent)) === "Lisbon", "reopening restores the last place");
    await lpage.waitForTimeout(600); // let any quiet current-location refresh land
    assert((await lpage.$eval("#cityName", (e) => e.textContent)) === "Lisbon", "a quiet location refresh never changes the restored place");
    assert(await lpage.$eval("#summary", (e) => !!e.querySelector(".sd-dot.geo")), "the remembered current location (Calgary, far from Lisbon) joins the step list with a ring dot");
    // No remembered current location → reopening must not touch geolocation.
    await lpage.evaluate(() => localStorage.removeItem("bw-geo"));
    const revBeforeCold = revHits;
    await lpage.reload();
    await lpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    await lpage.waitForTimeout(600);
    assert((await lpage.$eval("#cityName", (e) => e.textContent)) === "Lisbon", "reopening restores the last place (no remembered location)");
    assert(revHits === revBeforeCold, "reopening with no remembered location does not request geolocation");
    await lctx.close();
  }

  // 8) Outlook wording by confidence: an hour that's wet on amount alone at a low
  // chance is "possible" and doesn't flash; a >=50% hour is "likely" and flashes.
  {
    const octx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const opage = await octx.newPage();
    // Dry now, with a single wet hour `wetOffset` hours ahead at (mm, pop).
    const oneWet = (wetOffset, mm, pop, code) => {
      const now = new Date(); now.setMinutes(0, 0, 0);
      const H = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [], wind_speed_10m: [], is_day: [] };
      const start = new Date(now.getTime() - 48 * 3600e3);
      for (let i = 0; i < 121; i++) { const t = new Date(start.getTime() + i * 3600e3); const off = Math.round((t - now) / 3600e3); const wet = off === wetOffset; H.time.push(fmt(t)); H.temperature_2m.push(10); H.apparent_temperature.push(8); H.precipitation_probability.push(wet ? pop : 5); H.precipitation.push(wet ? mm : 0); H.weather_code.push(wet ? code : 3); H.wind_speed_10m.push(10); H.is_day.push(1); }
      const D = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], sunrise: [], sunset: [] };
      const sd = new Date(now.getTime() - 7 * 86400e3);
      for (let i = 0; i < 23; i++) { const d = new Date(sd.getTime() + i * 86400e3); D.time.push(fmtDate(d)); D.weather_code.push(3); D.temperature_2m_max.push(12); D.temperature_2m_min.push(3); D.precipitation_sum.push(0); D.precipitation_probability_max.push(5); D.wind_speed_10m_max.push(15); const sr = new Date(d); sr.setHours(7, 32); const ss = new Date(d); ss.setHours(19, 20); D.sunrise.push(fmt(sr)); D.sunset.push(fmt(ss)); }
      return { latitude: 51.05, longitude: -114.07, timezone: "America/Edmonton", current: { time: fmt(now), temperature_2m: 12, apparent_temperature: 8, weather_code: 3, wind_speed_10m: 18, precipitation: 0, is_day: 1 }, hourly: H, daily: D };
    };
    let f = oneWet(5, 0.4, 18, 51); // 0.4 mm drizzle at 18%, 5 h out
    await opage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Home", admin1: "AB", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await opage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(f)));
    await opage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await opage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await opage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await opage.goto(URL);
    await opage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const low = await opage.$eval("#summary .fcast", (e) => ({ text: e.textContent.trim(), soon: e.classList.contains("soon") }));
    assert(/possible/.test(low.text) && !/likely/.test(low.text), `low-chance amount reads "possible", got "${low.text}"`);
    assert(low.soon === false, "a low-chance outlook does not flash");
    f = oneWet(4, 1.0, 60, 61); // 1 mm rain at 60%, 4 h out
    await opage.reload();
    await opage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const hi = await opage.$eval("#summary .fcast", (e) => ({ text: e.textContent.trim(), soon: e.classList.contains("soon") }));
    assert(/likely/.test(hi.text), `a >=50% hour reads "likely", got "${hi.text}"`);
    assert(hi.soon === true, "an imminent likely outlook flashes");
    await octx.close();
  }

  // 9) "Raining now" follows the OBSERVED current condition, not the hourly
  // amount/chance — so the outlook never contradicts the summary's headline.
  {
    const nctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const npage = await nctx.newPage();
    // nowCode = current condition; hoursWet = whether the coming hours read wet.
    const nowRaining = (nowCode, hoursWet) => {
      const now = new Date(); now.setMinutes(0, 0, 0);
      const H = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [], wind_speed_10m: [], is_day: [] };
      const start = new Date(now.getTime() - 48 * 3600e3);
      for (let i = 0; i < 121; i++) { const t = new Date(start.getTime() + i * 3600e3); const off = Math.round((t - now) / 3600e3); const wet = hoursWet && off >= 0; H.time.push(fmt(t)); H.temperature_2m.push(9); H.apparent_temperature.push(7); H.precipitation_probability.push(wet ? 70 : 5); H.precipitation.push(wet ? 0.6 : 0); H.weather_code.push(wet ? 61 : 3); H.wind_speed_10m.push(12); H.is_day.push(1); }
      const D = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], sunrise: [], sunset: [] };
      const sd = new Date(now.getTime() - 7 * 86400e3);
      for (let i = 0; i < 23; i++) { const d = new Date(sd.getTime() + i * 86400e3); D.time.push(fmtDate(d)); D.weather_code.push(3); D.temperature_2m_max.push(11); D.temperature_2m_min.push(3); D.precipitation_sum.push(0); D.precipitation_probability_max.push(5); D.wind_speed_10m_max.push(15); const sr = new Date(d); sr.setHours(7, 32); const ss = new Date(d); ss.setHours(19, 20); D.sunrise.push(fmt(sr)); D.sunset.push(fmt(ss)); }
      return { latitude: 51.05, longitude: -114.07, timezone: "America/Edmonton", current: { time: fmt(now), temperature_2m: 9, apparent_temperature: 7, weather_code: nowCode, wind_speed_10m: 18, precipitation: hoursWet ? 0.6 : 0, is_day: 1 }, hourly: H, daily: D };
    };
    await npage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Home", admin1: "AB", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await npage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await npage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await npage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    // Raining now, then it clears → "easing by".
    let nf = nowRaining(61, false);
    await npage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(nf)));
    await npage.goto(URL);
    await npage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const easing = await npage.$eval("#summary .fcast", (e) => e.textContent.trim());
    assert(/easing by/.test(easing), `raining now + clearing reads "easing by", got "${easing}"`);
    // Raining now, still wet ahead → "continuing".
    nf = nowRaining(61, true);
    await npage.reload();
    await npage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const cont = await npage.$eval("#summary .fcast", (e) => e.textContent.trim());
    assert(/continuing/.test(cont), `raining now + still wet reads "continuing", got "${cont}"`);
    // Dry current condition (overcast) even with a wet hour ahead → forward
    // "possible/likely" wording, never "continuing"/"easing".
    nf = nowRaining(3, true);
    await npage.reload();
    await npage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const dry = await npage.$eval("#summary .fcast", (e) => e.textContent.trim());
    assert(!/continuing|easing/.test(dry), `dry current condition never says continuing/easing, got "${dry}"`);
    await nctx.close();
  }

  // 10) Daylight over the year: a "Daylight" pill opens a rolling 12-month
  // chart centred on today (six months back, six ahead) whose draggable scrubber
  // reads out any day.
  {
    const yctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const ypage = await yctx.newPage();
    await ypage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Calgary", admin1: "AB", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await ypage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(buildForecast())));
    await ypage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await ypage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await ypage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await ypage.goto(URL);
    await ypage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const dpill = await ypage.$eval("#summary .day-line", (e) => e.textContent.trim());
    assert(/Daylight/.test(dpill) && /\d+m/.test(dpill), `summary shows a Daylight pill with a length, got "${dpill}"`);
    await ypage.click("#summary .day-line");
    await ypage.waitForSelector("#dayBackdrop:not(.hidden)", { timeout: 5000 });
    assert((await ypage.$eval("#dayScroll .dc-nowlab", (e) => e.textContent)) === "NOW", "daylight marks today NOW");
    // the chart drew a daylight band and a full year of month labels
    assert(await ypage.$("#dayBody .day-chart .band"), "daylight band polygon is drawn");
    const months = await ypage.$$eval("#dayBody .day-chart text", (ts) => ts.map((t) => t.textContent));
    assert(["J", "F", "M", "A", "S", "O", "N", "D"].every((x) => months.includes(x)), "month labels J..D present");
    // a DST zone shows a clock-change marker at each shift across the two years of data
    // (a year each way from today): two springs forward, two falls back
    const dstN = await ypage.$$eval("#dayBody .dst-line", (e) => e.length);
    assert(dstN === 4, `four DST markers across two years for a daylight-saving zone, got ${dstN}`);
    const dstLbls = await ypage.$$eval("#dayBody .dst-lbl", (e) => e.map((t) => t.textContent));
    assert(dstLbls.some((s) => /^\+1h$/.test(s)) && dstLbls.some((s) => /^−1h$/.test(s)), `DST labels are +1h and -1h, got ${JSON.stringify(dstLbls)}`);
    // season markers: two years of data hold two of each solstice (dots) and equinox (rings)
    const solN = await ypage.$$eval("#dayBody .sol-dot", (e) => e.length), eqN = await ypage.$$eval("#dayBody .eq-dot", (e) => e.length);
    assert(solN === 4 && eqN === 4, `four solstice dots and four equinox rings over two years, got ${solN}/${eqN}`);
    // vitamin D band (Sun above 45°): at Calgary's latitude it exists each summer and vanishes each winter,
    // so two years of data give two lenses; the readout carries a Vitamin D line
    const vdN = await ypage.$$eval("#dayBody .vd-band", (e) => e.length);
    assert(vdN === 2, `two vitamin D lenses over two years at 51°N, got ${vdN}`);
    assert(/Vitamin D\s+(none today|\d{1,2}:\d\d–\d{1,2}:\d\d · \d+h)/.test(await ypage.$eval("#dayReadout", (e) => e.textContent)), "readout has a Vitamin D line");
    // sunrise and sunset carry a compass bearing ("7:41 AM E 96°")
    const azOK = /Sunrise\s+\d{1,2}:\d\d [AP]M\s*[NESW]{1,3} \d{1,3}°/.test(await ypage.$eval("#dayReadout", (e) => e.textContent));
    assert(azOK, "sunrise shows its compass bearing");
    const today = await ypage.$eval("#dayReadout", (e) => e.textContent);
    assert(/today/.test(today), `readout starts on today, got "${today.replace(/\s+/g, " ").trim()}"`);
    // the chart scrolls under a fixed centre line and opens with today's marker under it
    await ypage.waitForTimeout(100);
    const offset = await ypage.evaluate(() => { const t = document.querySelector("#dayScroll .today-line").getBoundingClientRect(); const l = document.querySelector(".day-cursor .dc-line").getBoundingClientRect(); return t.left - (l.left + l.width / 2); });
    assert(Math.abs(offset) < 2, `today's marker opens under the centre line, got offset ${offset.toFixed(1)}px`);
    // scrolling to each end reads a different, non-today day ~6 months out
    const scrollTo = async (fx) => { await ypage.$eval("#dayScroll", (e, f) => { e.scrollLeft = f * (e.scrollWidth - e.clientWidth); }, fx); await ypage.waitForTimeout(350); return ypage.$eval("#dayReadout .rd-date", (e) => e.textContent.trim()); };
    const left = await scrollTo(0);
    const right = await scrollTo(1);
    assert(!/today/.test(left) && !/today/.test(right), `edges are not today, got "${left}" / "${right}"`);
    assert(left !== right, `the two edges are different days, got "${left}" / "${right}"`);
    // back-to-today arrow: hidden on today, shown once scrubbed away, and a tap glides back to today
    const arrowShown = await ypage.$eval("#dayNow", (b) => getComputedStyle(b).display !== "none");
    assert(arrowShown, "back-to-today arrow appears when scrubbed off today");
    await ypage.click("#dayNow"); await ypage.waitForTimeout(1200);
    const backHome = await ypage.$eval("#dayReadout .rd-date", (e) => e.textContent);
    assert(/today/.test(backHome) && await ypage.$eval("#dayNow", (b) => getComputedStyle(b).display === "none"), `arrow returns to today and hides, got "${backHome.trim()}"`);
    await scrollTo(1);
    // the readout still carries a full sunrise/sunset/length line off-centre
    const lenOK = /Daylight\s+\d+h\s+\d+m/.test(await ypage.$eval("#dayReadout", (e) => e.textContent));
    assert(lenOK, "a scrubbed day still shows sunrise/sunset/daylight length");
    await yctx.close();
  }

  // 11) Hourly wind graph: the Wind line opens a dipstick chart like Conditions — wind +
  // gust lines, band labels, direction arrows, a now marker, a day picker, a centred readout.
  {
    const wctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const wpage = await wctx.newPage();
    // reopen on a saved place whose address carries a postal code (the card must drop it)
    await wpage.addInitScript(() => localStorage.setItem("bw-last-loc", JSON.stringify({ name: "8524 48 Avenue NW", sub: "Calgary, Alberta T3B 2A6, Canada", lat: 51.05, lon: -114.07, cc: "CA" })));
    await wpage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Calgary", admin1: "AB", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await wpage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(buildForecast())));
    await wpage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await wpage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await wpage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await wpage.goto(URL);
    await wpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    // the Wind line is a tappable hard metric (has a chevron), not a quiet pill
    assert(await wpage.$("#summary .wind-line.tap"), "wind line is marked tappable (+ cue)");
    await wpage.click("#summary .wind-line");
    await wpage.waitForSelector("#windBackdrop:not(.hidden)", { timeout: 5000 });
    await wpage.waitForTimeout(300);
    assert(await wpage.$("#windBody .wind-chart .wind-line"), "wind-speed line is drawn");
    assert(await wpage.$("#windBody .wind-chart .wind-gustline"), "gust line is drawn");
    assert((await wpage.$$eval("#windBody .wind-chart .wind-arrow", (e) => e.length)) > 0, "direction arrows drawn");
    assert(await wpage.$("#windBody .wind-chart .cc-now"), "now marker drawn");
    const bands = await wpage.$$eval("#windBody .cc-ylab", (e) => e.map((t) => t.textContent));
    assert(["Light", "Mod", "Strong", "Severe"].every((b) => bands.includes(b)), `band labels present, got ${JSON.stringify(bands)}`);
    // dipstick: the centre line is fixed and the chart scrolls; the centred card reads the hour under it
    const rd0 = await wpage.$eval("#windRead", (e) => e.textContent);
    assert(/now/.test(rd0), `readout starts at now, got "${rd0}"`);
    assert(/Wind\s*\d+ km\/h [NSEW]/.test(rd0), `readout shows wind speed + direction, got "${rd0}"`);
    assert(/Gust\s*\d+ km\/h/.test(rd0), `readout shows gust speed, got "${rd0}"`);
    assert(await wpage.$eval("#windRead", (e) => getComputedStyle(e).textAlign === "center"), "wind readout is centred");
    // the whole fetched range is scrollable: more than a day of chart beyond the viewport
    assert(await wpage.$eval("#windScroll", (e) => e.scrollWidth > e.clientWidth * 4), "wind chart spans several days");
    await wpage.$eval("#windScroll", (e) => { e.scrollLeft += 15 * 30; }); // 30 hours on
    await wpage.waitForTimeout(500);
    assert(!/now/.test(await wpage.$eval("#windRead", (e) => e.textContent)), "scrolling off now updates the readout");
    // back-to-now arrow: hidden at now, shown once scrolled off (pointing back), tap glides home
    assert(await wpage.$eval("#windNow", (b) => getComputedStyle(b).display !== "none" && !b.classList.contains("right")), "wind back-to-now arrow shows, pointing left");
    await wpage.click("#windNow"); await wpage.waitForTimeout(1000);
    assert(/now/.test(await wpage.$eval("#windRead", (e) => e.textContent)) && await wpage.$eval("#windNow", (b) => getComputedStyle(b).display === "none"), "wind arrow returns to now and hides");
    // drag anywhere: a sideways drag on the readout card moves the chart off now
    { const b = await (await wpage.$("#windRead")).boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2;
      await wpage.mouse.move(x, y); await wpage.mouse.down(); for (let k = 1; k <= 10; k++) await wpage.mouse.move(x - 15 * k, y); await wpage.mouse.up(); await wpage.waitForTimeout(600); }
    assert(!/now/.test(await wpage.$eval("#windRead", (e) => e.textContent)), "a sideways drag on the wind panel moves the chart");
    // the day picker jumps to a day
    const lastDay = await wpage.$$eval("#windDays .cd-day", (b) => b[b.length - 1].dataset.day);
    await wpage.click(`#windDays .cd-day[data-day="${lastDay}"]`); await wpage.waitForTimeout(300);
    assert(await wpage.$eval(`#windDays .cd-day[data-day="${lastDay}"]`, (b) => b.classList.contains("sel")), "day picker selects the tapped day");
    await wpage.click("#windClose");
    // the card's address line drops the postal code (search/saved places keep it)
    const locLine = await wpage.$eval("#summary .sum-loc", (e) => e.textContent);
    assert(/Calgary, Alberta, Canada/.test(locLine) && !/T3B|2A6/.test(locLine), `card address drops the postal code, got "${locLine}"`);
    // Conditions (tap an hour): its readout card is centred — the default readout style
    const nowI = await wpage.$$eval("#hourly .cell", (cs) => cs.findIndex((c) => c.classList.contains("now")));
    await (await wpage.$$("#hourly .cell"))[nowI + 2].click();
    await wpage.waitForSelector("#condBackdrop:not(.hidden)", { timeout: 5000 });
    assert(await wpage.$eval("#condRead", (e) => getComputedStyle(e).textAlign === "center" && [...e.querySelectorAll(".cr-line")].every((l) => getComputedStyle(l).justifyContent === "center")), "conditions readout is centred");
    // its back-to-now arrow: shown once scrolled off now, tap returns to now
    await wpage.waitForTimeout(400);
    await wpage.$eval("#condScroll", (e) => { e.scrollLeft += 15 * 20; }); await wpage.waitForTimeout(700);
    assert(await wpage.$eval("#condNow", (b) => getComputedStyle(b).display !== "none"), "conditions back-to-now arrow shows off now");
    await wpage.click("#condNow"); await wpage.waitForTimeout(1000);
    assert(/now/.test(await wpage.$eval("#condRead", (e) => e.textContent)), "conditions arrow returns to now");
    await wctx.close();
  }

  // 12) Snow: rain and snow are told apart. Snow is labelled in cm of snow (white, stacked
  // above any rain), an hour/day with both gets the rain-and-snow glyph and wording, freezing
  // rain gets its own glyph, and Conditions reads out Rain and Snow separately.
  {
    const sctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 51.05, longitude: -114.07 } });
    const spage = await sctx.newPage();
    const snowy = (rainNow) => {
      const now = new Date(); now.setMinutes(0, 0, 0);
      const H = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], rain: [], showers: [], snowfall: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], is_day: [] };
      for (let i = -48; i <= 200; i++) {
        const t = new Date(now.getTime() + i * 3600e3);
        // 2–3 h ahead: rain and snow; 4–8 h: snow; 30–32 h: freezing rain
        let rain = 0, snowW = 0, code = 3, pop = 10;
        if (i >= 2 && i <= 3) { rain = 0.3; snowW = 0.4; code = 71; pop = 80; }
        if (i >= 4 && i <= 8) { snowW = 0.8; code = 73; pop = 85; }
        if (i >= 30 && i <= 32) { rain = 0.4; code = 67; pop = 70; }
        if (rainNow && i >= 0 && i <= 1) { rain = 0.6; code = 61; pop = 80; }
        H.time.push(fmt(t)); H.temperature_2m.push(0); H.apparent_temperature.push(-5); H.precipitation_probability.push(pop);
        H.precipitation.push(+(rain + snowW).toFixed(2)); H.rain.push(rain); H.showers.push(0); H.snowfall.push(+(snowW * 0.7).toFixed(2));
        H.weather_code.push(code); H.wind_speed_10m.push(12); H.wind_gusts_10m.push(20); H.wind_direction_10m.push(300); H.is_day.push(1);
      }
      const D = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], rain_sum: [], showers_sum: [], snowfall_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], sunrise: [], sunset: [] };
      const sd = new Date(now); sd.setHours(0, 0, 0, 0);
      for (let k = -7; k < 16; k++) {
        const d = new Date(sd.getTime() + k * 86400e3), ds = fmtDate(d);
        // tomorrow: a snow day (8 mm water = 5.6 cm); the day after: rain and snow
        const pr = k === 1 ? 8 : k === 2 ? 5 : 0, rn = k === 2 ? 3 : 0, sn = k === 1 ? 5.6 : k === 2 ? 1.4 : 0;
        D.time.push(ds); D.weather_code.push(k === 1 ? 73 : k === 2 ? 71 : 3); D.temperature_2m_max.push(2); D.temperature_2m_min.push(-4);
        D.precipitation_sum.push(pr); D.rain_sum.push(rn); D.showers_sum.push(0); D.snowfall_sum.push(sn);
        D.precipitation_probability_max.push(pr ? 80 : 10); D.wind_speed_10m_max.push(20); D.sunrise.push(ds + "T07:50"); D.sunset.push(ds + "T18:50");
      }
      return { latitude: 51.05, longitude: -114.07, timezone: "America/Edmonton", current: { time: fmt(new Date(now.getTime() + 15 * 60000)), temperature_2m: 0, apparent_temperature: -5, weather_code: rainNow ? 61 : 3, wind_speed_10m: 12, wind_gusts_10m: 20, wind_direction_10m: 300, precipitation: 0, is_day: 1 }, hourly: H, daily: D };
    };
    await spage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Calgary", admin1: "AB", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    let fUrl = "";
    await spage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => { fUrl = r.request().url(); r.fulfill(json(snowy())); });
    await spage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await spage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await spage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await spage.goto(URL);
    await spage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    assert(/hourly=[^&]*\brain\b[^&]*\bsnowfall\b/.test(fUrl) && /daily=[^&]*\bsnowfall_sum\b/.test(fUrl), "forecast requests the rain/snowfall split");
    // outlook: the first wet hour has both
    const sOut = await spage.$eval("#summary .fcast", (e) => e.textContent);
    assert(/^Rain and snow/.test(sOut), `outlook names rain and snow, got "${sOut}"`);
    // daily: tomorrow is snow in cm (no mm), the day after shows both; the snow layer is drawn
    const dcells = await spage.$$eval("#daily .cell", (cs) => { const t = cs.findIndex((c) => c.classList.contains("today")); return [cs[t + 1], cs[t + 2]].map((c) => ({ amt: (c.querySelector(".pamt") || {}).textContent || "", snow: !!c.querySelector(".pa-snow"), rain: !!c.querySelector(".pa-rain"), mixIcon: !!c.querySelector(".ic .wx"), fill: (c.querySelector(".water") || {}).getAttribute ? c.querySelector(".water").getAttribute("style") : "" })); });
    assert(/^6 cm$/.test(dcells[0].amt) && dcells[0].snow && !dcells[0].rain, `snow day labelled in cm only, got ${JSON.stringify(dcells[0])}`);
    assert(!dcells[0].mixIcon, "a snow day keeps the snow emoji (no custom glyph)");
    assert(dcells[1].snow && dcells[1].rain && /1 cm/.test(dcells[1].amt) && /3 mm/.test(dcells[1].amt), `mixed day shows cm and mm, got ${JSON.stringify(dcells[1])}`);
    assert(/linear-gradient/.test(dcells[1].fill), "mixed day's fill stacks rain under snow");
    assert(dcells[1].mixIcon, "mixed day gets the rain-and-snow glyph");
    // hourly: the mixed hour has the glyph; the freezing-rain hour has its own
    const hglyphs = await spage.$$eval("#hourly .cell", (cs) => { const n = cs.findIndex((c) => c.classList.contains("now")); return { mix: !!cs[n + 2].querySelector(".ic .wx"), snow: !!cs[n + 5].querySelector(".ic .wx"), freeze: !!cs[n + 31].querySelector(".ic .wx") }; });
    assert(hglyphs.mix && !hglyphs.snow && hglyphs.freeze, `glyphs: mixed and freezing custom, snow emoji, got ${JSON.stringify(hglyphs)}`);
    // Conditions on the mixed hour: Precip row label, Rain and Snow read out separately
    const n = await spage.$$eval("#hourly .cell", (cs) => cs.findIndex((c) => c.classList.contains("now")));
    await (await spage.$$("#hourly .cell"))[n + 2].click();
    await spage.waitForSelector("#condBackdrop:not(.hidden)", { timeout: 5000 });
    await spage.waitForTimeout(300);
    const sRead = await spage.$eval("#condRead", (e) => e.textContent.replace(/\s+/g, " "));
    assert(/Rain 0\.3mm/.test(sRead) && /Snow 0\.3cm/.test(sRead), `conditions reads out rain and snow, got "${sRead}"`);
    assert((await spage.$eval("#condBody .cc-plab", (e) => e.textContent)) === "Precip", "precip row is labelled Precip");
    assert(await spage.$("#condBody .cp-bar.snow"), "snow bars drawn in the precip row");
    // raining now, turning to snow before it stops: the outlook says so
    const tpage = await sctx.newPage();
    await tpage.route(/geocoding-api\.open-meteo\.com\/v1\/reverse/, (r) => r.fulfill(json({ results: [{ name: "Calgary", admin1: "AB", country: "Canada", country_code: "CA", latitude: 51.05, longitude: -114.07 }] })));
    await tpage.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => r.fulfill(json(snowy(true))));
    await tpage.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill(json({ daily: { time: [] } })));
    await tpage.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill(json({ current: { us_aqi: 20 } })));
    await tpage.route(/(api\.rainviewer\.com|tilecache\.rainviewer\.com|api\.mapbox\.com|tile\.openstreetmap\.org|cdnjs\.cloudflare\.com)/, (r) => r.abort());
    await tpage.goto(URL);
    await tpage.waitForSelector("#result:not(.hidden)", { timeout: 20000 });
    const tOut = await tpage.$eval("#summary .fcast", (e) => e.textContent);
    assert(/^Rain turning to snow, easing by \d+\s?(AM|PM)/i.test(tOut), `outlook says rain turning to snow, got "${tOut}"`);
    await sctx.close();
  }

  await browser.close();
  console.log(`PASS — hourly=${hourly} daily=${daily} recents+tabs+search OK`);
}

run().catch((err) => { console.error("FAIL —", err.message); process.exit(1); });
