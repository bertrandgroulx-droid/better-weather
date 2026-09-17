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
    subsampleGapSec: 14 * 60, // ~15 min between preloaded frames
    warmDelayMs: 350,
    scrubThrottleMs: 80,
    circleColor: "#ffd166",
    locColor: "#fb8500"
  };

  var slider = document.getElementById("frameSlider");
  var timeEl = document.getElementById("frameTime");
  var modelEl = document.getElementById("radarModel");
  var pickEl = document.getElementById("radarPick");
  var pickGo = document.getElementById("radarPickGo");
  var pickX = document.getElementById("radarPickX");
  var tempCanvas = document.getElementById("tempCanvas");
  var tempLegendEl = document.getElementById("tempLegend");
  var tempGradEl = document.getElementById("tempGrad");
  var tempLoEl = document.getElementById("tempLo");
  var tempHiEl = document.getElementById("tempHi");
  var radarCtrlEl = document.getElementById("radarCtrl");
  var radarLegendEl = document.getElementById("radarLegend");
  var layerRadarBtn = document.getElementById("layerRadar");
  var layerTempBtn = document.getElementById("layerTemp");

  // ---- state ----
  var map = null, mapInited = false, locMarker = null, modelCircle = null;
  var pickMarker = null, pendingPick = null;
  var mode = "radar", tempGrid = null, tempFetchTimer = null, tempRAF = null, tempReqId = 0;
  var TEMP = { cols: 9, rows: 7, fine: 4, refetchMs: 450 };
  var rvHost = "", frames = [], animPos = 0, radarLayer = null, tz = null;
  var warmed = {}, warmedCount = 0, warmImgs = [], warmTimer = null;
  var scrubTimer = null, scrubPending = null;

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

  // ---- temperature overlay (contour lines computed from Open-Meteo) ----
  // Colour ramp is defined in °C; values in °F are mapped back to °C for colour.
  var TSTOPS = [[-10,49,54,149],[-2,69,117,180],[4,116,173,209],[10,171,217,233],[14,224,243,248],
    [16,255,255,191],[20,254,224,144],[24,253,174,97],[28,244,109,67],[34,215,48,39]];
  function tcolor(c) {
    if (c <= TSTOPS[0][0]) return TSTOPS[0].slice(1);
    for (var i = 1; i < TSTOPS.length; i++) {
      if (c <= TSTOPS[i][0]) {
        var a = TSTOPS[i - 1], b = TSTOPS[i], f = (c - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
      }
    }
    return TSTOPS[TSTOPS.length - 1].slice(1);
  }
  function isImp() { return ctx.getUnits && ctx.getUnits() === "imperial"; }
  function tempUnitParam() { return isImp() ? "fahrenheit" : "celsius"; }
  function tempStep() { return isImp() ? 5 : 4; }         // isotherm spacing
  function toC(v) { return isImp() ? (v - 32) / 1.8 : v; } // colour ramp is in °C
  function tcolorU(v) { return tcolor(toC(v)); }

  function updateTempLegend() {
    if (!tempGradEl) return;
    if (!tempGradEl._filled) {
      var lo = TSTOPS[0][0], hi = TSTOPS[TSTOPS.length - 1][0];
      var parts = TSTOPS.map(function (p) {
        return "rgb(" + p[1] + "," + p[2] + "," + p[3] + ") " + Math.round((p[0] - lo) / (hi - lo) * 100) + "%";
      });
      tempGradEl.style.background = "linear-gradient(90deg," + parts.join(",") + ")";
      tempGradEl._filled = true;
    }
    if (tempGrid && tempLoEl) { tempLoEl.textContent = Math.round(tempGrid.min) + "°"; tempHiEl.textContent = Math.round(tempGrid.max) + "°"; }
  }

  function scheduleTempFetch() { clearTimeout(tempFetchTimer); tempFetchTimer = setTimeout(fetchTempGrid, TEMP.refetchMs); }

  function fetchTempGrid() {
    if (!map || mode !== "temp") return;
    var b = map.getBounds(), s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    var rows = TEMP.rows, cols = TEMP.cols, latRow = [], lonCol = [], lats = [], lons = [], j, i;
    for (j = 0; j < rows; j++) latRow.push(n + (s - n) * j / (rows - 1)); // north -> south
    for (i = 0; i < cols; i++) lonCol.push(w + (e - w) * i / (cols - 1)); // west -> east
    for (j = 0; j < rows; j++) for (i = 0; i < cols; i++) { lats.push(latRow[j].toFixed(4)); lons.push(lonCol[i].toFixed(4)); }
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lats.join(",") +
      "&longitude=" + lons.join(",") + "&current=temperature_2m&temperature_unit=" + tempUnitParam();
    var id = ++tempReqId;
    ctx.fetchJson(url).then(function (res) {
      if (id !== tempReqId || mode !== "temp") return;
      var arr = Array.isArray(res) ? res : [res], vals = [], k = 0, mn = Infinity, mx = -Infinity, jj, ii;
      for (jj = 0; jj < rows; jj++) {
        vals[jj] = [];
        for (ii = 0; ii < cols; ii++) {
          var o = arr[k++], v = (o && o.current) ? o.current.temperature_2m : null;
          vals[jj][ii] = v;
          if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; }
        }
      }
      tempGrid = { rows: rows, cols: cols, latRow: latRow, lonCol: lonCol, vals: vals, min: mn, max: mx };
      updateTempLegend();
      drawTemp();
    }).catch(function () { /* keep the previous grid on a failed refresh */ });
  }

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

  function drawTempThrottled() {
    if (tempRAF) return;
    tempRAF = requestAnimationFrame(function () { tempRAF = null; drawTemp(); });
  }

  function drawTemp() {
    if (!map || !tempGrid || mode !== "temp" || !tempCanvas) return;
    var mapEl = document.getElementById("map"), W = mapEl.clientWidth, H = mapEl.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    tempCanvas.width = Math.round(W * dpr); tempCanvas.height = Math.round(H * dpr);
    tempCanvas.style.width = W + "px"; tempCanvas.style.height = H + "px";
    var cx = tempCanvas.getContext("2d"); cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);

    var g = tempGrid, R = g.rows, C = g.cols, px = [], j, i;
    for (j = 0; j < R; j++) { px[j] = []; for (i = 0; i < C; i++) { var p = map.latLngToContainerPoint([g.latRow[j], g.lonCol[i]]); px[j][i] = [p.x, p.y]; } }

    // upsample to a fine grid (bilinear) for smoother contours
    var FF = TEMP.fine, FNR = (R - 1) * FF + 1, FNC = (C - 1) * FF + 1, fv = [], fp = [];
    for (j = 0; j < FNR; j++) {
      fv[j] = []; fp[j] = []; var vv = j / FF;
      for (i = 0; i < FNC; i++) { var uu = i / FF; fv[j][i] = bilerp(g.vals, uu, vv); fp[j][i] = bilerpPt(px, uu, vv); }
    }

    // faint fill for context under the lines
    for (j = 0; j < FNR - 1; j++) for (i = 0; i < FNC - 1; i++) {
      if (fv[j][i] == null) continue;
      var col = tcolorU((fv[j][i] + fv[j][i + 1] + fv[j + 1][i] + fv[j + 1][i + 1]) / 4);
      cx.fillStyle = "rgba(" + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0) + ",0.30)";
      var a = fp[j][i], b = fp[j][i + 1], c = fp[j + 1][i + 1], d = fp[j + 1][i];
      cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.lineTo(c[0], c[1]); cx.lineTo(d[0], d[1]); cx.closePath(); cx.fill();
    }

    // marching-squares isotherms with a label per line
    var step = tempStep(), lo = Math.ceil(g.min / step) * step, hi = Math.floor(g.max / step) * step;
    cx.lineWidth = 1.8; cx.strokeStyle = "rgba(255,255,255,0.9)"; cx.font = "600 12px system-ui,sans-serif"; cx.textBaseline = "middle";
    function edge(p1, v1, p2, v2, thr) { var t = (thr - v1) / (v2 - v1); return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]; }
    for (var thr = lo; thr <= hi + 1e-6; thr += step) {
      var labeled = false;
      for (j = 0; j < FNR - 1; j++) for (i = 0; i < FNC - 1; i++) {
        var A = fv[j][i], Bv = fv[j][i + 1], Cv = fv[j + 1][i + 1], Dv = fv[j + 1][i];
        if (A == null || Bv == null || Cv == null || Dv == null) continue;
        var idx = (A > thr ? 8 : 0) | (Bv > thr ? 4 : 0) | (Cv > thr ? 2 : 0) | (Dv > thr ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        var pa = fp[j][i], pb = fp[j][i + 1], pc = fp[j + 1][i + 1], pd = fp[j + 1][i];
        var Tt = edge(pa, A, pb, Bv, thr), Rt = edge(pb, Bv, pc, Cv, thr), Bt = edge(pd, Dv, pc, Cv, thr), Lt = edge(pa, A, pd, Dv, thr);
        var seg = ({ 1: [Bt, Lt], 2: [Rt, Bt], 3: [Rt, Lt], 4: [Tt, Rt], 5: [[Tt, Lt], [Rt, Bt]], 6: [Tt, Bt],
          7: [Tt, Lt], 8: [Tt, Lt], 9: [Tt, Bt], 10: [[Tt, Rt], [Bt, Lt]], 11: [Tt, Rt], 12: [Rt, Lt], 13: [Rt, Bt], 14: [Bt, Lt] })[idx];
        if (!seg) continue;
        var pairs = (idx === 5 || idx === 10) ? seg : [seg];
        for (var s = 0; s < pairs.length; s++) { cx.beginPath(); cx.moveTo(pairs[s][0][0], pairs[s][0][1]); cx.lineTo(pairs[s][1][0], pairs[s][1][1]); cx.stroke(); }
        if (!labeled) {
          var lx = pairs[0][0][0], ly = pairs[0][0][1];
          if (lx > 26 && lx < W - 26 && ly > 18 && ly < H - 14) {
            var txt = Math.round(thr) + "°";
            cx.lineWidth = 3.5; cx.strokeStyle = "rgba(11,31,58,0.9)"; cx.strokeText(txt, lx + 3, ly);
            cx.fillStyle = "#fff"; cx.fillText(txt, lx + 3, ly);
            cx.lineWidth = 1.8; cx.strokeStyle = "rgba(255,255,255,0.9)"; labeled = true;
          }
        }
      }
    }
  }

  function toggleHidden(el, hide) { if (el) el.classList.toggle("hidden", hide); }
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    var temp = m === "temp";
    if (layerRadarBtn) layerRadarBtn.classList.toggle("on", !temp);
    if (layerTempBtn) layerTempBtn.classList.toggle("on", temp);
    if (radarLayer) radarLayer.setOpacity(temp ? 0 : RADAR.opacity);
    toggleHidden(tempCanvas, !temp); toggleHidden(tempLegendEl, !temp);
    toggleHidden(radarCtrlEl, temp); toggleHidden(radarLegendEl, temp);
    if (temp) { updateTempLegend(); if (tempGrid) drawTemp(); scheduleTempFetch(); }
    else if (tempCanvas) { var cx = tempCanvas.getContext("2d"); cx.clearRect(0, 0, tempCanvas.width, tempCanvas.height); }
  }

  // ---- map / basemap ----
  function addBasemap() {
    if (ctx.token) {
      L.tileLayer("https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}", {
        id: "mapbox/dark-v11", tileSize: 512, zoomOffset: -1, maxZoom: RADAR.maxZoom,
        accessToken: ctx.token, attribution: '&copy; Mapbox &copy; OpenStreetMap'
      }).addTo(map);
    } else {
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
    }
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
    map.on("moveend", warmCacheSoon); // re-warm the cache after zoom/pan
    map.on("click", onMapClick);      // tap the map to pick a forecast location
    map.on("move zoom", positionPick); // keep the confirm bar anchored to the pin
    if (pickGo) pickGo.addEventListener("click", function () {
      if (pendingPick && ctx.onPick) ctx.onPick(pendingPick.lat, pendingPick.lng);
      clearPick(); // recenter follows once the forecast resolves
    });
    if (pickX) pickX.addEventListener("click", clearPick);
    if (layerRadarBtn) layerRadarBtn.addEventListener("click", function () { setMode("radar"); });
    if (layerTempBtn) layerTempBtn.addEventListener("click", function () { setMode("temp"); });
    map.on("move zoom", function () { if (mode === "temp") drawTempThrottled(); }); // reproject contours live
    map.on("moveend", function () { if (mode === "temp") scheduleTempFetch(); });   // refetch for the new area
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
      if (!frames.length) { timeEl.textContent = "No radar data"; return; }
      slider.max = frames.length - 1;
      animPos = frames.length - 1; // newest observed frame = "now"
      slider.value = animPos;
      showFrame(animPos);
      setTimeout(warmCache, 300); // preload the other frames so scrubbing is instant
    }).catch(function () { timeEl.textContent = "Radar unavailable"; });
  }

  // Warm the browser cache with every frame's tiles for the current view, so the
  // single radar layer can swap frames instantly (no on-the-spot fetch).
  function warmCache() {
    if (!map || !rvHost || !frames.length) return;
    if (warmedCount > 4000) { warmed = {}; warmedCount = 0; } // bound the dedupe set
    var z = Math.min(Math.round(map.getZoom()), RADAR.maxNativeZoom);
    var n = Math.pow(2, z);
    var b = map.getBounds();
    var nw = map.project(b.getNorthWest(), z).divideBy(256).floor();
    var se = map.project(b.getSouthEast(), z).divideBy(256).floor();
    warmImgs = [];
    for (var f = 0; f < frames.length; f++) {
      for (var x = nw.x - 1; x <= se.x + 1; x++) {
        for (var y = nw.y - 1; y <= se.y + 1; y++) {
          if (y < 0 || y >= n) continue;
          var xx = ((x % n) + n) % n;
          var url = rvHost + frames[f].path + "/256/" + z + "/" + xx + "/" + y +
            "/" + RADAR.colorScheme + "/" + RADAR.snow + ".png";
          if (warmed[url]) continue;
          warmed[url] = true; warmedCount++;
          var img = new Image();
          img.decoding = "async";
          img.src = url; // browser caches the response
          warmImgs.push(img);
        }
      }
    }
  }

  function warmCacheSoon() {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(warmCache, RADAR.warmDelayMs);
  }

  // ---- rendering a frame ----
  function frameUrl(fr) {
    return rvHost + fr.path + "/256/{z}/{x}/{y}/" + RADAR.colorScheme + "/" + RADAR.snow + ".png";
  }

  function frameLabel(i) {
    slider.value = i;
    var opts = { hour: "numeric", minute: "2-digit" };
    if (tz) opts.timeZone = tz; // show the active location's local time
    var t = new Date(frames[i].time * 1000).toLocaleTimeString([], opts);
    timeEl.textContent = i === frames.length - 1 ? t + " · now" : t;
  }

  function loadFrame(i) {
    var fr = frames[i];
    if (!radarLayer) {
      radarLayer = L.tileLayer(frameUrl(fr), {
        opacity: mode === "temp" ? 0 : RADAR.opacity, tileSize: RADAR.tileSize,
        maxNativeZoom: RADAR.maxNativeZoom, maxZoom: RADAR.maxZoom,
        updateWhenZooming: false, keepBuffer: 1,
        attribution: "Radar &copy; RainViewer"
      }).addTo(map);
    } else {
      radarLayer.setUrl(frameUrl(fr));
    }
  }

  function showFrame(i) {
    if (!frames.length) return;
    i = (i % frames.length + frames.length) % frames.length;
    animPos = i;
    frameLabel(i);
    loadFrame(i);
  }

  // Throttle tile loads while dragging so scrubbing stays smooth and we don't
  // hammer the rate-limited tile server. The label tracks instantly; tiles load
  // at most a few times a second, and the final frame loads on release.
  function scrubTo(i) {
    if (!frames.length) return;
    animPos = i;
    frameLabel(i);
    scrubPending = i;
    if (scrubTimer) return;
    scrubTimer = setTimeout(function () {
      scrubTimer = null;
      if (scrubPending != null) { loadFrame(scrubPending); scrubPending = null; }
    }, RADAR.scrubThrottleMs);
  }

  // ---- public API ----
  return {
    open: initRadar,
    recenter: recenterMap,
    setTz: function (t) { tz = t || null; if (frames.length) frameLabel(animPos); },
    onScrub: scrubTo,
    onCommit: showFrame,
    clearPick: function () { if (map) clearPick(); },
    onUnits: function () { if (mode === "temp") { updateTempLegend(); scheduleTempFetch(); } },
    onResize: function () { if (map) { map.invalidateSize(); if (mode === "temp") drawTemp(); } }
  };
};
