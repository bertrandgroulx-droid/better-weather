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
  var busyEl = document.getElementById("radarBusy");

  // ---- state ----
  var map = null, mapInited = false, locMarker = null, modelCircle = null;
  var pickMarker = null, pendingPick = null;
  var tileBusy = 0, busyTimer = null, busyMax = null;
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
    onResize: function () { if (map) map.invalidateSize(); }
  };
};
