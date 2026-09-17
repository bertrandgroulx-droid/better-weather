// Radar map module — Leaflet map + Mapbox dark basemap + RainViewer radar tiles.
// A factory: app.js calls createRadar(ctx) and wires the returned API to the UI.
// ctx = { fetchJson, token, getLastLoc, CONFIG }.
window.createRadar = function (ctx) {
  "use strict";
  var L = window.L;

  // ---- module config ----
  var RADAR = {
    colorScheme: 2,          // RainViewer palette (free tier serves Universal Blue regardless)
    snow: "1_0",             // smoothed, snow not coloured separately (avoids "snow everywhere")
    opacity: 0.72,
    tileSize: 256,
    maxNativeZoom: 7,        // RainViewer free tiles top out at z7; upscale beyond
    maxZoom: 20,
    initialZoom: 9,
    subsampleGapSec: 14 * 60, // ~15 min between frames
    scrubThrottleMs: 80,
    warmGapMs: 1100,          // pace tile pre-warming (~54 req/min, leaves headroom under RainViewer's ~100/min)
    circleColor: "#ffd166",
    locColor: "#fb8500",
    fcastHours: 18,           // hours of model precipitation forecast (right half of the slider)
    fcastCols: 8, fcastRows: 6, // grid sampled over the view (one Open-Meteo call gives all hours)
    fcastFine: 4,             // bilinear upsample factor for a smoother field
    precipFull: 5             // mm/h that maps to full-intensity colour
  };

  var slider = document.getElementById("frameSlider");
  var timeEl = document.getElementById("frameTime");
  var modelEl = document.getElementById("radarModel");
  var pickEl = document.getElementById("radarPick");
  var pickGo = document.getElementById("radarPickGo");
  var pickX = document.getElementById("radarPickX");
  var busyEl = document.getElementById("radarBusy");
  var fcastCanvas = document.getElementById("fcastCanvas");

  // ---- state ----
  var map = null, mapInited = false, locMarker = null, modelCircle = null;
  var pickMarker = null, pendingPick = null;
  var tileBusy = 0, busyTimer = null, busyMax = null;
  var rvHost = "", frames = [], radarLayer = null, tz = null;
  var scrubTimer = null, scrubPending = null;
  var warmed = {}, warmedCount = 0, warmQueue = [], warmTimer = null, warmDebounce = null;
  // Combined timeline: radar frames (past→now) + model forecast hours (future).
  var timeline = [], pos = 0, fcast = null, fcastDebounce = null, fcastReq = 0;

  // ---- model-grid circle ----
  // Approximate grid resolution of the high-res model Open-Meteo tends to pick
  // per region (best_match blends models, so this is an estimate). name, km, and
  // bounding box [south, west, north, east]; finest match wins.
  var FORECAST_MODELS = [
    { n: "MET Nordic",   km: 1,   bb: [55, -10, 72, 42] },
    { n: "AROME",        km: 1.3, bb: [42, -5, 51, 9] },
    { n: "UKV",          km: 2,   bb: [48, -11, 61, 2] },
    { n: "ICON-D2",      km: 2.2, bb: [43.2, -3.9, 58.1, 20.3] },
    { n: "HRDPS",        km: 2.5, bb: [39, -142, 70, -52] },
    { n: "HRRR",         km: 3,   bb: [21, -134, 53, -60] },
    { n: "MSM (JMA)",    km: 5,   bb: [22, 120, 48, 150] },
    { n: "ICON-EU",      km: 7,   bb: [29.5, -23.5, 70.5, 45] }
  ];
  function modelForLoc(lat, lon) {
    var best = null;
    for (var i = 0; i < FORECAST_MODELS.length; i++) {
      var m = FORECAST_MODELS[i], b = m.bb;
      if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3] && (!best || m.km < best.km)) best = m;
    }
    return best || { n: "Global (GFS/ICON)", km: 11 };
  }
  function drawModelCircle(loc) {
    if (!map || !loc) return;
    var m = modelForLoc(loc.lat, loc.lon);
    var radius = m.km * 500; // metres; the circle's diameter ≈ one grid cell
    if (!modelCircle) {
      modelCircle = L.circle([loc.lat, loc.lon], {
        radius: radius, color: RADAR.circleColor, weight: 1.5, opacity: 0.9,
        fillColor: RADAR.circleColor, fillOpacity: 0.12, interactive: false
      }).addTo(map);
    } else {
      modelCircle.setLatLng([loc.lat, loc.lon]);
      modelCircle.setRadius(radius);
    }
    modelEl.textContent = "Zoom in to see yellow circle = forecast area";
  }

  function recenterMap(loc) {
    if (map && loc) {
      clearPick(); // any new location supersedes a pending map pick
      map.setView([loc.lat, loc.lon], map.getZoom());
      if (locMarker) locMarker.setLatLng([loc.lat, loc.lon]);
      drawModelCircle(loc);
    }
  }

  // ---- tap-to-pick a forecast location on the map ----
  var pickIcon = L ? L.divIcon({ className: "pick-pin", html: "📍", iconSize: [30, 30], iconAnchor: [15, 28] }) : null;
  function onMapClick(e) {
    pendingPick = e.latlng;
    if (!pickMarker) pickMarker = L.marker(e.latlng, { icon: pickIcon, interactive: false, keyboard: false }).addTo(map);
    else pickMarker.setLatLng(e.latlng);
    if (pickEl) pickEl.classList.remove("hidden");
    document.body.classList.add("picking"); // free the top-right corner for the confirm bar
    positionPick();
  }
  function clearPick() {
    pendingPick = null;
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
    if (pickEl) pickEl.classList.add("hidden");
    document.body.classList.remove("picking");
  }
  // Place the confirm bar just above the dropped pin (or below if there's no
  // room), clamped to the map, and keep it there as the map pans/zooms.
  function positionPick() {
    if (!map || !pendingPick || !pickEl || pickEl.classList.contains("hidden")) return;
    var mapEl = document.getElementById("map");
    var pt = map.latLngToContainerPoint(pendingPick);
    var bw = pickEl.offsetWidth, bh = pickEl.offsetHeight;
    var mw = mapEl.clientWidth, mh = mapEl.clientHeight;
    var gap = 12, pinUp = 32; // pin height above its tip
    var top = pt.y - pinUp - gap - bh;   // above the pin
    if (top < 6) top = pt.y + gap;       // not enough headroom → sit below the tip
    top = Math.max(6, Math.min(top, mh - bh - 6));
    var left = Math.max(6, Math.min(pt.x - bw / 2, mw - bw - 6));
    pickEl.style.left = left + "px";
    pickEl.style.top = top + "px";
  }

  // ---- map / basemap ----
  function addBasemap() {
    var layer = ctx.token
      ? L.tileLayer("https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}", {
          id: "mapbox/dark-v11", tileSize: 512, zoomOffset: -1, maxZoom: RADAR.maxZoom,
          accessToken: ctx.token, attribution: '&copy; Mapbox &copy; OpenStreetMap'
        })
      : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        });
    // Zooming in past the radar's max native zoom refetches only the basemap,
    // so track its tiles too — that's the load the user waits on when zooming.
    layer.on("loading", onTilesLoading);
    layer.on("load", onTilesLoaded);
    layer.addTo(map);
  }

  function initRadar() {
    if (mapInited) { setTimeout(function () { map.invalidateSize(); }, 60); recenterMap(ctx.getLastLoc()); return; }
    if (!L) {
      document.getElementById("map").innerHTML =
        '<div class="maperr">The map library couldn\'t load. Check your connection and reopen this tab.</div>';
      return;
    }
    mapInited = true;
    var loc = ctx.getLastLoc();
    var center = loc ? [loc.lat, loc.lon] : [51.05, -114.07];
    map = L.map("map", { zoomControl: true, attributionControl: true, maxZoom: RADAR.maxZoom })
      .setView(center, RADAR.initialZoom);
    addBasemap();
    locMarker = L.circleMarker(center, {
      radius: 8, color: "#ffffff", weight: 3, fillColor: RADAR.locColor, fillOpacity: 1
    }).addTo(map);
    drawModelCircle({ lat: center[0], lon: center[1] });
    map.on("click", onMapClick);      // tap the map to pick a forecast location
    map.on("move zoom", positionPick); // keep the confirm bar anchored to the pin
    map.on("move zoom", function () { if (currentIsFcast()) drawFcast(timeline[pos].ref); }); // keep forecast aligned
    map.on("moveend", scheduleWarm);   // re-warm tiles for the new view (debounced + paced)
    map.on("moveend", scheduleFcastFetch); // refetch the forecast grid for the new area
    if (pickGo) pickGo.addEventListener("click", function () {
      if (pendingPick && ctx.onPick) ctx.onPick(pendingPick.lat, pendingPick.lng);
      clearPick(); // recenter follows once the forecast resolves
    });
    if (pickX) pickX.addEventListener("click", clearPick);
    setTimeout(function () { map.invalidateSize(); }, 60);
    loadRadarFrames();
  }

  // ---- frames + preloading ----
  // Keep ~15 min between frames (the source is ~10 min) to cut how much we
  // preload while still showing the trend.
  function subsample(list, minGap) {
    if (!list.length) return [];
    var out = [list[0]], last = list[0].time;
    for (var i = 1; i < list.length; i++) {
      if (list[i].time - last >= minGap) { out.push(list[i]); last = list[i].time; }
    }
    if (out[out.length - 1] !== list[list.length - 1]) out.push(list[list.length - 1]);
    return out;
  }

  function loadRadarFrames() {
    ctx.fetchJson("https://api.rainviewer.com/public/weather-maps.json").then(function (api) {
      rvHost = api.host;
      var sp = subsample((api.radar && api.radar.past) || [], RADAR.subsampleGapSec);
      var sn = subsample((api.radar && api.radar.nowcast) || [], RADAR.subsampleGapSec);
      frames = sp.concat(sn);
      if (!frames.length) timeEl.textContent = "No radar data";
      buildTimeline();
      if (timeline.length) showStep(nowIndex());
      scheduleWarm(); // gently preload radar frames for smooth scrubbing
    }).catch(function () { timeEl.textContent = "Radar unavailable"; });
    fetchFcast(); // model precipitation for the future half of the slider (independent of radar)
  }

  // ---- "updating radar…" indicator ----
  // Show it only if a tile load runs longer than a moment, so quick (cached)
  // loads don't flash the spinner. Tracks the radar layer's loading/load events.
  function showBusy() {
    if (busyEl) busyEl.classList.remove("hidden");
    clearTimeout(busyMax); busyMax = setTimeout(function () { tileBusy = 0; hideBusy(); }, 12000); // never stick
  }
  function hideBusy() { clearTimeout(busyTimer); clearTimeout(busyMax); busyTimer = null; if (busyEl) busyEl.classList.add("hidden"); }
  function onTilesLoading() { tileBusy++; if (!busyTimer) busyTimer = setTimeout(function () { busyTimer = null; if (tileBusy > 0) showBusy(); }, 300); }
  function onTilesLoaded() { tileBusy = Math.max(0, tileBusy - 1); if (tileBusy === 0) hideBusy(); }

  // ---- rendering a frame ----
  function frameUrl(fr) {
    return rvHost + fr.path + "/256/{z}/{x}/{y}/" + RADAR.colorScheme + "/" + RADAR.snow + ".png";
  }

  // ---- combined timeline (radar past→now + model forecast future) ----
  function nowSec() { return frames.length ? frames[frames.length - 1].time : Math.floor(Date.now() / 1000); }
  function buildTimeline() {
    var steps = [], i;
    for (i = 0; i < frames.length; i++) steps.push({ t: frames[i].time, kind: "radar", ref: i });
    var now = nowSec();
    if (fcast && fcast.times) {
      for (i = 0; i < fcast.times.length; i++) {
        var ts = Math.floor(new Date(fcast.times[i] + ":00Z").getTime() / 1000); // fcast times are GMT
        if (ts > now + 60) steps.push({ t: ts, kind: "fcast", ref: i });
      }
    }
    steps.sort(function (a, b) { return a.t - b.t; });
    timeline = steps;
    slider.max = Math.max(0, timeline.length - 1);
  }
  function nowIndex() { // slider position of the newest radar frame ("now")
    var now = nowSec(), best = 0;
    for (var i = 0; i < timeline.length; i++) if (timeline[i].kind === "radar" && timeline[i].t === now) best = i;
    return best;
  }

  function labelStep(step) {
    var opts = { hour: "numeric", minute: "2-digit" };
    if (tz) opts.timeZone = tz; // show the active location's local time
    var t = new Date(step.t * 1000).toLocaleTimeString([], opts);
    var isFcast = step.kind === "fcast";
    timeEl.textContent = t + (isFcast ? " · forecast" : (step.t === nowSec() ? " · now" : " · radar"));
    timeEl.classList.toggle("fcast", isFcast);
  }

  function loadRadarTile(f) {
    var fr = frames[f];
    if (!radarLayer) {
      radarLayer = L.tileLayer(frameUrl(fr), {
        opacity: RADAR.opacity, tileSize: RADAR.tileSize,
        maxNativeZoom: RADAR.maxNativeZoom, maxZoom: RADAR.maxZoom,
        updateWhenZooming: false, keepBuffer: 1,
        attribution: "Radar &copy; RainViewer"
      });
      radarLayer.on("loading", onTilesLoading);
      radarLayer.on("load", onTilesLoaded);
      radarLayer.addTo(map);
    } else {
      radarLayer.setUrl(frameUrl(fr));
    }
  }

  function showStep(i) {
    if (!timeline.length) return;
    i = Math.max(0, Math.min(i, timeline.length - 1));
    pos = i;
    slider.value = i;
    var step = timeline[i];
    labelStep(step);
    if (step.kind === "radar") {
      hideFcastCanvas();
      if (radarLayer) radarLayer.setOpacity(RADAR.opacity);
      loadRadarTile(step.ref);
    } else {
      if (radarLayer) radarLayer.setOpacity(0);
      drawFcast(step.ref); // shows the canvas
    }
  }

  // ---- gentle tile pre-warming ----
  // Preload the other frames' tiles for the current view so scrubbing is smooth,
  // but ONE tile at a time on a slow cadence so we never burst past RainViewer's
  // free-tier rate limit (the all-at-once version starved the visible layer).
  function tilesForView() {
    var z = Math.min(Math.round(map.getZoom()), RADAR.maxNativeZoom), n = Math.pow(2, z);
    var b = map.getBounds();
    var nw = map.project(b.getNorthWest(), z).divideBy(256).floor();
    var se = map.project(b.getSouthEast(), z).divideBy(256).floor();
    var out = [];
    for (var x = nw.x; x <= se.x; x++) for (var y = nw.y; y <= se.y; y++) {
      if (y < 0 || y >= n) continue;
      out.push({ x: ((x % n) + n) % n, y: y, z: z });
    }
    return out;
  }
  function scheduleWarm() { clearTimeout(warmDebounce); warmDebounce = setTimeout(buildWarmQueue, 700); }
  function buildWarmQueue() {
    if (!map || !rvHost || frames.length <= 1) return;
    var tiles = tilesForView();
    // Warm newest frames first — those nearest "now" are the likeliest to be scrubbed to.
    var order = [];
    for (var i = frames.length - 1; i >= 0; i--) order.push(i);
    warmQueue = [];
    for (var oi = 0; oi < order.length; oi++) for (var ti = 0; ti < tiles.length; ti++) {
      var t = tiles[ti];
      var url = rvHost + frames[order[oi]].path + "/256/" + t.z + "/" + t.x + "/" + t.y + "/" + RADAR.colorScheme + "/" + RADAR.snow + ".png";
      if (!warmed[url]) warmQueue.push(url);
    }
    pumpWarm();
  }
  function pumpWarm() {
    if (warmTimer) return;
    warmTimer = setInterval(function () {
      if (!warmQueue.length) { clearInterval(warmTimer); warmTimer = null; return; }
      var url = warmQueue.shift();
      if (warmed[url]) return;
      if (warmedCount > 3000) { warmed = {}; warmedCount = 0; } // bound the dedupe set
      warmed[url] = true; warmedCount++;
      var img = new Image(); img.decoding = "async"; img.src = url; // browser caches it
    }, RADAR.warmGapMs);
  }

  // Throttle tile loads while dragging so scrubbing stays smooth and we don't
  // hammer the rate-limited tile server. The label tracks instantly; tiles load
  // at most a few times a second, and the final frame loads on release.
  function scrubStep(i) {
    if (!timeline.length) return;
    i = Math.max(0, Math.min(i, timeline.length - 1));
    pos = i;
    var step = timeline[i];
    labelStep(step);
    if (step.kind === "fcast") { // forecast draw is local + cheap — no throttle
      if (radarLayer) radarLayer.setOpacity(0);
      drawFcast(step.ref);
      return;
    }
    hideFcastCanvas();
    if (radarLayer) radarLayer.setOpacity(RADAR.opacity);
    scrubPending = step.ref; // throttle the rate-limited radar tile loads
    if (scrubTimer) return;
    scrubTimer = setTimeout(function () {
      scrubTimer = null;
      if (scrubPending != null) { loadRadarTile(scrubPending); scrubPending = null; }
    }, RADAR.scrubThrottleMs);
  }

  // ---- model precipitation forecast layer (Open-Meteo, future half of the slider) ----
  var PSTOPS = [[0.0, 58, 160, 255, 0], [0.14, 58, 160, 255, 0.55], [0.34, 73, 208, 224, 0.62],
    [0.55, 242, 228, 0, 0.7], [0.75, 245, 154, 11, 0.8], [1.0, 224, 20, 10, 0.88]];
  function pcolor(v) {
    if (v <= 0) return null;
    for (var i = 1; i < PSTOPS.length; i++) {
      if (v <= PSTOPS[i][0]) {
        var a = PSTOPS[i - 1], b = PSTOPS[i], f = (v - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
      }
    }
    var l = PSTOPS[PSTOPS.length - 1]; return [l[1], l[2], l[3], l[4]];
  }
  function intensity(mm) { return mm > 0 ? Math.min(1, Math.sqrt(mm / RADAR.precipFull)) : 0; }
  function bilerp(a, u, v) {
    var i0 = Math.floor(u), j0 = Math.floor(v), i1 = Math.min(i0 + 1, a[0].length - 1), j1 = Math.min(j0 + 1, a.length - 1);
    var fu = u - i0, fv = v - j0, p00 = a[j0][i0], p10 = a[j0][i1], p01 = a[j1][i0], p11 = a[j1][i1];
    if (p00 == null || p10 == null || p01 == null || p11 == null) return null;
    return p00 * (1 - fu) * (1 - fv) + p10 * fu * (1 - fv) + p01 * (1 - fu) * fv + p11 * fu * fv;
  }
  function bilerpPt(px, u, v) {
    var i0 = Math.floor(u), j0 = Math.floor(v), i1 = Math.min(i0 + 1, px[0].length - 1), j1 = Math.min(j0 + 1, px.length - 1);
    var fu = u - i0, fv = v - j0, a = px[j0][i0], b = px[j0][i1], c = px[j1][i0], d = px[j1][i1];
    return [a[0] * (1 - fu) * (1 - fv) + b[0] * fu * (1 - fv) + c[0] * (1 - fu) * fv + d[0] * fu * fv,
            a[1] * (1 - fu) * (1 - fv) + b[1] * fu * (1 - fv) + c[1] * (1 - fu) * fv + d[1] * fu * fv];
  }
  function hideFcastCanvas() { if (fcastCanvas) fcastCanvas.classList.add("hidden"); }
  function currentIsFcast() { return timeline.length && timeline[pos] && timeline[pos].kind === "fcast"; }

  function scheduleFcastFetch() { clearTimeout(fcastDebounce); fcastDebounce = setTimeout(fetchFcast, 500); }
  function fetchFcast() {
    if (!map) return;
    var b = map.getBounds(), s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    var rows = RADAR.fcastRows, cols = RADAR.fcastCols, latRow = [], lonCol = [], lats = [], lons = [], jj, ii;
    for (jj = 0; jj < rows; jj++) latRow.push(n + (s - n) * jj / (rows - 1));
    for (ii = 0; ii < cols; ii++) lonCol.push(w + (e - w) * ii / (cols - 1));
    for (jj = 0; jj < rows; jj++) for (ii = 0; ii < cols; ii++) { lats.push(latRow[jj].toFixed(4)); lons.push(lonCol[ii].toFixed(4)); }
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lats.join(",") + "&longitude=" + lons.join(",") +
      "&hourly=precipitation&past_hours=0&forecast_hours=" + RADAR.fcastHours + "&timezone=GMT";
    var id = ++fcastReq;
    ctx.fetchJson(url).then(function (res) {
      if (id !== fcastReq) return;
      var arr = Array.isArray(res) ? res : [res];
      var times = arr[0] && arr[0].hourly ? arr[0].hourly.time : null;
      if (!times || !times.length) return;
      var vals = []; // vals[hour][row][col] in mm
      for (var h = 0; h < times.length; h++) { vals[h] = []; for (var r = 0; r < rows; r++) vals[h][r] = []; }
      for (var k = 0; k < arr.length; k++) {
        var r2 = Math.floor(k / cols), c2 = k % cols, series = arr[k] && arr[k].hourly ? arr[k].hourly.precipitation : null;
        for (var h2 = 0; h2 < times.length; h2++) vals[h2][r2][c2] = series ? series[h2] : null;
      }
      fcast = { rows: rows, cols: cols, latRow: latRow, lonCol: lonCol, times: times, vals: vals };
      buildTimeline();
      showStep(pos); // redraw current step (may now be a forecast frame)
    }).catch(function () { /* forecast optional — slider stays radar-only */ });
  }

  function drawFcast(h) {
    if (!map || !fcast || !fcastCanvas || !fcast.vals[h]) return;
    fcastCanvas.classList.remove("hidden");
    var mapEl = document.getElementById("map"), W = mapEl.clientWidth, H = mapEl.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    fcastCanvas.width = Math.round(W * dpr); fcastCanvas.height = Math.round(H * dpr);
    fcastCanvas.style.width = W + "px"; fcastCanvas.style.height = H + "px";
    var cx = fcastCanvas.getContext("2d"); cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
    var g = fcast, R = g.rows, C = g.cols, grid = g.vals[h], px = [], j, i;
    for (j = 0; j < R; j++) { px[j] = []; for (i = 0; i < C; i++) { var p = map.latLngToContainerPoint([g.latRow[j], g.lonCol[i]]); px[j][i] = [p.x, p.y]; } }
    var FF = RADAR.fcastFine, FNR = (R - 1) * FF + 1, FNC = (C - 1) * FF + 1;
    for (j = 0; j < FNR - 1; j++) for (i = 0; i < FNC - 1; i++) {
      var mm = bilerp(grid, i / FF, j / FF);
      if (mm == null) continue;
      var col = pcolor(intensity(mm));
      if (!col) continue;
      var a = bilerpPt(px, i / FF, j / FF), b = bilerpPt(px, (i + 1) / FF, j / FF),
          c = bilerpPt(px, (i + 1) / FF, (j + 1) / FF), d = bilerpPt(px, i / FF, (j + 1) / FF);
      cx.fillStyle = "rgba(" + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0) + "," + col[3].toFixed(2) + ")";
      cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.lineTo(c[0], c[1]); cx.lineTo(d[0], d[1]); cx.closePath(); cx.fill();
    }
  }

  // ---- public API ----
  return {
    open: initRadar,
    recenter: recenterMap,
    setTz: function (t) { tz = t || null; if (timeline.length) labelStep(timeline[pos]); },
    onScrub: scrubStep,
    onCommit: showStep,
    clearPick: function () { if (map) clearPick(); },
    onResize: function () { if (map) { map.invalidateSize(); if (currentIsFcast()) drawFcast(timeline[pos].ref); } }
  };
};
