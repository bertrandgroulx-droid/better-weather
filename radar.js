// Radar map module — Leaflet map + Esri dark basemap (labels above the radar, Mapbox as the
// fallback) + RainViewer radar tiles, repainted so rain and snow each get their own colours.
// A factory: app.js calls createRadar(ctx) and wires the returned API to the UI.
// ctx = { fetchJson, token, getLastLoc, CONFIG }.
window.createRadar = function (ctx) {
  "use strict";
  var L = window.L;

  // ---- module config ----
  var RADAR = {
    colorScheme: 2,          // RainViewer palette (free tier serves Universal Blue regardless)
    opacity: 0.85,
    tileSize: 256,
    maxNativeZoom: 7,        // RainViewer free tiles top out at z7; upscale beyond
    maxZoom: 20,
    initialZoom: 9,
    subsampleGapSec: 14 * 60, // ~15 min between frames
    scrubThrottleMs: 80,
    warmGapMs: 1100,          // pace tile pre-warming (~54 req/min, leaves headroom under RainViewer's ~100/min)
    circleColor: "#ffd166",
    locColor: "#fb8500"
  };

  var slider = document.getElementById("frameSlider");
  var timeEl = document.getElementById("frameTime");
  var modelEl = document.getElementById("radarModel");
  var pickEl = document.getElementById("radarPick");
  var pickGo = document.getElementById("radarPickGo");
  var pickX = document.getElementById("radarPickX");
  var busyEl = document.getElementById("radarBusy");

  // ---- state ----
  var map = null, mapInited = false, locMarker = null, modelCircle = null;
  var pickMarker = null, pendingPick = null;
  var tileBusy = 0, busyTimer = null, busyMax = null;
  var rvHost = "", frames = [], animPos = 0, radarLayer = null, tz = null;
  var scrubTimer = null, scrubPending = null;
  var warmed = {}, warmedCount = 0, warmQueue = [], warmTimer = null, warmDebounce = null;

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
  // Esri's dark grey canvas (free, no key): the base without labels under the radar, and its
  // labels as a separate layer above it. If Esri won't load, fall back to Mapbox/OSM, whose
  // labels are baked into the image (so they sit under the radar).
  var ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/{svc}/MapServer/tile/{z}/{y}/{x}";
  function addBasemap() {
    map.createPane("radar").style.zIndex = 380;
    var lp = map.createPane("labels"); lp.style.zIndex = 420; lp.style.pointerEvents = "none";
    var base = L.tileLayer(ESRI, { svc: "World_Dark_Gray_Base", maxNativeZoom: 16, maxZoom: RADAR.maxZoom,
      attribution: "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" });
    var labels = L.tileLayer(ESRI, { svc: "World_Dark_Gray_Reference", maxNativeZoom: 16, maxZoom: RADAR.maxZoom, pane: "labels" });
    var fails = 0, loaded = false;
    base.on("tileload", function () { loaded = true; });
    base.on("tileerror", function () {
      if (loaded || ++fails !== 3) return;
      map.removeLayer(base); map.removeLayer(labels); addFallbackBasemap();
    });
    base.on("loading", onTilesLoading);
    base.on("load", onTilesLoaded);
    base.addTo(map); labels.addTo(map);
  }
  function addFallbackBasemap() {
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
    map.on("moveend", scheduleWarm);   // re-warm tiles for the new view (debounced + paced)
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
      if (!frames.length) { timeEl.textContent = "No radar data"; return; }
      slider.max = frames.length - 1;
      animPos = frames.length - 1; // newest observed frame = "now"
      slider.value = animPos;
      showFrame(animPos);
      scheduleWarm(); // gently preload the other frames for smooth scrubbing
    }).catch(function () { timeEl.textContent = "Radar unavailable"; });
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
  function tileUrl(path, c, snow) {
    return rvHost + path + "/256/" + c.z + "/" + c.x + "/" + c.y + "/" + RADAR.colorScheme + "/" + (snow ? "1_1" : "1_0") + ".png";
  }

  // ---- repaint: rain and snow on scales of their own ----
  // RainViewer serves each frame with its snow marking off (1_0) and on (1_1). A pixel that
  // differs between the two is one RainViewer calls snow (estimated from temperatures). Its
  // strength is read from the snow-off colour (Universal Blue: tan drizzle → light → dark blue →
  // yellow → orange → red → pink), then painted rain green→red or snow pale blue→violet.
  var RAMP = {
    rain: [[143,212,122],[63,174,85],[31,138,62],[242,212,60],[240,138,44],[217,54,54],[194,63,176]],
    snow: [[228,244,255],[168,214,247],[106,174,240],[63,116,227],[106,79,214]]
  };
  function strength(r, g, b) { // 0 (lightest) … 1 (heaviest)
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h, lt = (mx + mn) / 510;
    if (d < 12) return lt > 0.8 ? 1 : 0.05;                   // white = extreme; greys = lightest
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h >= 25 && h < 70 && d / mx < 0.5) return 0.04;        // tan: drizzle
    // blues, darker = heavier; they stay in the greens, so yellow keeps meaning heavy
    if (h >= 150 && h < 260) return 0.08 + 0.25 * Math.max(0, Math.min(1, (0.8 - lt) / 0.5));
    if (h >= 40 && h < 150) return 0.5 + (70 - Math.min(70, h)) / 30 * 0.1;  // yellow
    if (h < 40) return 0.6 + (40 - h) / 40 * 0.22;             // orange → red
    return 0.85 + (360 - h) / 100 * 0.15;                      // red → pink → purple
  }
  function rampAt(ramp, t) {
    t = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
    var i = Math.floor(t), f = t - i, a = ramp[i], b = ramp[Math.min(ramp.length - 1, i + 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function loadImg(url, cors) {
    return new Promise(function (res, rej) {
      var im = new Image(); if (cors) im.crossOrigin = "anonymous";
      im.onload = function () { res(im); }; im.onerror = rej; im.src = url;
    });
  }
  function repaint(tile, off, on) {
    var g = tile.getContext("2d"), cv = document.createElement("canvas"); cv.width = cv.height = 256;
    var g2 = cv.getContext("2d"); g2.drawImage(on, 0, 0); g.drawImage(off, 0, 0);
    var d = g.getImageData(0, 0, 256, 256), p = d.data, s = g2.getImageData(0, 0, 256, 256).data;
    for (var i = 0; i < p.length; i += 4) {
      var eo = p[i + 3] >= 16, es = s[i + 3] >= 16;
      if (!eo && !es) { p[i + 3] = 0; continue; }
      var snow = es && (!eo || Math.abs(p[i] - s[i]) + Math.abs(p[i + 1] - s[i + 1]) + Math.abs(p[i + 2] - s[i + 2]) > 24);
      var c = rampAt(snow ? RAMP.snow : RAMP.rain, eo ? strength(p[i], p[i + 1], p[i + 2]) : 0.1);
      p[i] = c[0]; p[i + 1] = c[1]; p[i + 2] = c[2]; p[i + 3] = 225;
    }
    g.putImageData(d, 0, 0);
  }
  var canRepaint = true; // false once the browser refuses to let us read RainViewer's pixels
  var RepaintLayer = L ? L.GridLayer.extend({
    setPath: function (path) { this.path = path; this.redraw(); },
    createTile: function (c, done) {
      var tile = document.createElement("canvas"); tile.width = tile.height = 256;
      var path = this.path, plain = function () { // RainViewer's own colours, as before
        loadImg(tileUrl(path, c, false), false).then(function (im) { tile.getContext("2d").drawImage(im, 0, 0); done(null, tile); },
          function () { done(null, tile); });
      };
      if (!canRepaint) { plain(); return tile; }
      Promise.all([loadImg(tileUrl(path, c, false), true), loadImg(tileUrl(path, c, true), true)]).then(function (im) {
        try { repaint(tile, im[0], im[1]); done(null, tile); }
        catch (e) { canRepaint = false; plain(); }
      }, plain);
      return tile;
    }
  }) : null;

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
      radarLayer = new RepaintLayer({
        pane: "radar", opacity: RADAR.opacity, tileSize: RADAR.tileSize,
        maxNativeZoom: RADAR.maxNativeZoom, maxZoom: RADAR.maxZoom,
        updateWhenZooming: false, keepBuffer: 1,
        attribution: "Radar &copy; RainViewer"
      });
      radarLayer.path = fr.path;
      radarLayer.on("loading", onTilesLoading);
      radarLayer.on("load", onTilesLoaded);
      radarLayer.addTo(map);
    } else {
      radarLayer.setPath(fr.path);
    }
  }

  function showFrame(i) {
    if (!frames.length) return;
    i = (i % frames.length + frames.length) % frames.length;
    animPos = i;
    frameLabel(i);
    loadFrame(i);
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
    // Warm frames nearest the visible one first — those are the likeliest to be scrubbed to.
    var order = [];
    for (var i = 0; i < frames.length; i++) if (i !== animPos) order.push(i);
    order.sort(function (a, b) { return Math.abs(a - animPos) - Math.abs(b - animPos); });
    warmQueue = [];
    for (var oi = 0; oi < order.length; oi++) for (var ti = 0; ti < tiles.length; ti++) {
      var t = tiles[ti];
      // both versions of each tile (snow marking off and on), which the repaint needs
      for (var sn = 0; sn < 2; sn++) {
        var url = tileUrl(frames[order[oi]].path, t, sn === 1);
        if (!warmed[url]) warmQueue.push(url);
      }
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
      // same CORS mode as the repaint's own requests, so the browser cache serves them
      var img = new Image(); img.decoding = "async"; img.crossOrigin = "anonymous"; img.src = url;
    }, RADAR.warmGapMs);
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
    onResize: function () { if (map) map.invalidateSize(); }
  };
};
