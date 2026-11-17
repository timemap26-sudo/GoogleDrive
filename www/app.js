/* 街景兜風 Street Drive
 * 把 Google 街景照片一張張串起來，用方向鍵像開車一樣在街道上移動。
 *
 *  ↑ / W     前進（沿著最接近車頭方向的道路連結前往下一張街景）
 *  ↓ / S     倒車
 *  ← → / A D 轉向
 *  Space     自動駕駛（會自動沿著道路彎道行駛）
 *  + / -     切換速度檔位
 *  M         顯示/隱藏小地圖
 *  N         放大/縮小小地圖
 *  B         小地圖切換 一般/衛星
 *  H         顯示/隱藏操作說明
 *  滑鼠/手指拖曳畫面  轉動視角（左右改變車頭方向、上下看天空/地面）
 */
(() => {
  'use strict';

  const CFG = window.STREET_DRIVE_CONFIG || {};
  const KEY_STORAGE = 'streetDrive.apiKey';
  const POS_STORAGE = 'streetDrive.lastPos';
  const MAPTYPE_STORAGE = 'streetDrive.mapType';

  // 每檔位：多久前進一張街景（毫秒）。街景照片間距約 8~12 公尺。
  const GEARS = [
    { name: '1', interval: 1400 },
    { name: '2', interval: 1000 },
    { name: '3', interval: 750 },
    { name: '4', interval: 550 },
    { name: '5', interval: 400 },
  ];
  const METERS_PER_STEP = 10;
  const TURN_RATE = 70;          // 度/秒
  const TURN_ACCEL = 7;          // 轉向加速/減速的平滑度（越大越快達到全速）
  const CAM_SMOOTH = 6;          // 鏡頭跟隨車頭的平滑度（越小越柔和）
  const ALIGN_RATE = 1.6;        // 自動對齊道路方向的速度（越大越快）
  const ALIGN_DEADBAND = 7;      // 道路方向差在此角度內視為直路，不修正（避免鏡頭左右晃）
  const MIN_DWELL = 220;         // 每張街景至少停留的時間，避免畫面還沒載好就跳下一張
  const MAX_FORWARD_ANGLE = 80;  // 手動前進時可接受的道路夾角
  const STEP_TIMEOUT = 3000;     // 等待街景載入的逾時
  // 連續感：三層全景輪替。下一張先在隱藏層預載，換張時交叉淡入；
  // 前進時鏡頭持續緩慢推近（模擬往前開），淡入的新照片剛好接上推近後的畫面。
  const BASE_ZOOM = 0;
  const DOLLY_ZOOM = 0.42;       // 每前進一張推近的 zoom 量（約等於往前 10 公尺的放大）
  const FADE_MIN = 220, FADE_MAX = 520, JUMP_FADE = 600; // 交叉淡入時間（毫秒）
  const TILE_GRACE = 140;        // 剛載好資料時多等一下，讓影像圖磚載入再淡入
  const DRAG_FOV = 100;          // 拖過整個畫面寬度約轉動的角度
  const MAX_PITCH = 80;

  const $ = (id) => document.getElementById(id);
  const els = {
    layers: [$('panoA'), $('panoB'), $('panoC')], minimap: $('minimap'), minimapWrap: $('minimapWrap'), status: $('status'),
    speed: $('speedValue'), gear: $('gear'), needle: $('needle'), headingText: $('headingText'),
    help: $('help'), autoBtn: $('autoBtn'),
    keyDialog: $('keyDialog'), keyForm: $('keyForm'), keyInput: $('keyInput'),
    searchForm: $('searchForm'), searchInput: $('searchInput'), settingsBtn: $('settingsBtn'),
  };

  const state = {
    panorama: null, layers: [], front: null, preload: null, fading: null, fadeUntil: 0,
    pending: null, pendingFade: 0, map: null, marker: null, svService: null, geocoder: null,
    heading: CFG.startHeading || 0,   // 車頭（邏輯）方向
    cam: CFG.startHeading || 0,       // 鏡頭實際顯示的方向，平滑跟隨 heading
    camPitch: 0,
    lastPovHeading: null,             // 最後一次由程式設定的鏡頭方向
    turnVel: 0,                       // 目前轉向角速度（度/秒）
    arrivedAt: 0,
    alignTarget: null,        // 道路方向，車頭會慢慢對齊
    keys: new Set(),
    drag: null,               // 滑鼠/觸控拖曳中的指標
    gear: 2,
    auto: false,
    busy: false,
    busySince: 0,
    lastStep: 0,
    lastDir: 0,               // 1 前進, -1 倒車, 0 停止
    displaySpeed: 0,
    lastFrame: performance.now(),
    ui: {},                   // 快取儀表顯示值，避免每幀重寫 DOM
  };

  // ---------- 工具 ----------
  const norm = (h) => ((h % 360) + 360) % 360;
  const angleDiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)) % 360; return d > 180 ? 360 - d : d; };
  const signedDiff = (from, to) => { let d = norm(to) - norm(from); if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  const setStatus = (t) => { els.status.textContent = t; };

  function bestLink(targetHeading, excludeBackward = false) {
    const links = (state.panorama && state.panorama.getLinks()) || [];
    let best = null, bestD = Infinity;
    for (const l of links) {
      if (!l || !l.pano) continue;
      const d = angleDiff(l.heading, targetHeading);
      if (excludeBackward && d > 135) continue;
      if (d < bestD) { bestD = d; best = l; }
    }
    return best ? { link: best, diff: bestD } : null;
  }

  // ---------- API Key / 載入 Google Maps ----------
  function getApiKey() {
    const url = new URLSearchParams(location.search).get('key');
    if (url) { try { localStorage.setItem(KEY_STORAGE, url); } catch (_) {} return url; }
    if (CFG.apiKey) return CFG.apiKey;
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (_) { return ''; }
  }

  function askKey() {
    els.keyInput.value = getApiKey();
    if (!els.keyDialog.open) els.keyDialog.showModal();
  }

  els.keyForm.addEventListener('submit', () => {
    const k = els.keyInput.value.trim();
    if (!k) return;
    try { localStorage.setItem(KEY_STORAGE, k); } catch (_) {}
    if (window.google && window.google.maps) location.reload();
    else loadMaps(k);
  });
  els.settingsBtn.addEventListener('click', askKey);

  window.gm_authFailure = () => {
    setStatus('API Key 無效或未啟用 Maps JavaScript API');
    try { localStorage.removeItem(KEY_STORAGE); } catch (_) {}
    askKey();
  };

  function loadMaps(key) {
    setStatus('載入 Google Maps…');
    window.__streetDriveInit = init;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=zh-TW&callback=__streetDriveInit`;
    s.async = true;
    s.onerror = () => setStatus('無法載入 Google Maps，請檢查網路');
    document.head.appendChild(s);
  }

  // ---------- 初始化 ----------
  function init() {
    const g = google.maps;
    state.svService = new g.StreetViewService();
    state.geocoder = new g.Geocoder();

    const panoOpts = {
      pov: { heading: state.heading, pitch: 0 },
      zoom: BASE_ZOOM,
      disableDefaultUI: true,
      showRoadLabels: true,
      linksControl: true,
      addressControl: true,
      addressControlOptions: { position: g.ControlPosition.BOTTOM_CENTER },
      clickToGo: false,
      scrollwheel: false,
      keyboardShortcuts: false,
      motionTracking: false,
      motionTrackingControl: false,
    };
    state.layers = els.layers.map((el) => makeLayer(el, panoOpts));
    state.front = state.layers[0];
    state.preload = state.layers[1];
    state.panorama = state.front.pano;

    state.map = new g.Map(els.minimap, {
      center: CFG.start, zoom: 17, disableDefaultUI: true, gestureHandling: 'none',
      keyboardShortcuts: false, clickableIcons: false,
    });
    state.marker = new g.Marker({
      map: state.map, position: CFG.start, clickable: false,
      icon: { path: g.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, rotation: state.heading,
        fillColor: '#f43f5e', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
    });
    // 點小地圖可以瞬間移動
    state.map.setOptions({ gestureHandling: 'greedy' });
    state.map.addListener('click', (e) => jumpTo(e.latLng));
    $('mapExpand').addEventListener('click', toggleMapExpand);
    $('mapZoomIn').addEventListener('click', () => state.map.setZoom(state.map.getZoom() + 1));
    $('mapZoomOut').addEventListener('click', () => state.map.setZoom(state.map.getZoom() - 1));
    $('mapType').addEventListener('click', toggleMapType);
    try { if (localStorage.getItem(MAPTYPE_STORAGE) === 'hybrid') toggleMapType(); } catch (_) {}


    let start = CFG.start;
    try {
      const saved = JSON.parse(localStorage.getItem(POS_STORAGE) || 'null');
      if (saved && typeof saved.lat === 'number') { start = saved; state.heading = saved.h || 0; }
    } catch (_) {}
    jumpTo(start);
    requestAnimationFrame(loop);
    setInterval(healthCheck, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(healthCheck, 300); });
  }

  // ---------- 全景圖層 ----------
  function makeLayer(el, opts) {
    const L = { el, opts, pano: null, want: null, id: null, readyAt: 0, z: BASE_ZOOM, zApplied: BASE_ZOOM };
    buildPano(L);
    // WebGL 畫布失效（手機記憶體不足、切到背景再回來）時街景會整片變黑，重建該圖層
    el.addEventListener('webglcontextlost', () => rebuildLayer(L), true);
    return L;
  }

  function buildPano(L) {
    if (L.pano) { google.maps.event.clearInstanceListeners(L.pano); L.pano.setVisible(false); }
    L.el.textContent = '';
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    L.el.appendChild(host);
    L.pano = new google.maps.StreetViewPanorama(host, L.opts);
    L.zApplied = L.z = BASE_ZOOM;
    L.pano.addListener('links_changed', () => {
      const id = L.pano.getPano();
      if (id && id === L.want && L.id !== id) { L.id = id; L.readyAt = performance.now(); }
      if (L === state.front && !state.pending) onLinks();
    });
    L.pano.addListener('position_changed', () => { if (L === state.front) updatePosition(); });
    // 使用者若用滑鼠拖曳畫面，同步車頭方向
    L.pano.addListener('pov_changed', () => {
      if (L !== state.front) return;
      const pov = L.pano.getPov();
      if (state.lastPovHeading === null || angleDiff(pov.heading, state.lastPovHeading) > 0.5) {
        if (!state.keys.size && !state.auto) {
          state.heading = state.cam = norm(pov.heading);
          state.alignTarget = null;
          state.turnVel = 0;
        }
        state.lastPovHeading = norm(pov.heading);
      }
      state.camPitch = pov.pitch;
    });
  }

  function rebuildLayer(L) {
    if (L.rebuilding) return;
    L.rebuilding = true;
    setTimeout(() => {
      L.rebuilding = false;
      const id = L.id || L.want;
      buildPano(L);
      L.want = null; L.id = null; L.readyAt = 0;
      if (L === state.front) {
        state.panorama = L.pano;
        if (id) loadInto(L, id);
      }
    }, 50);
  }

  function contextLost(L) {
    for (const c of L.el.querySelectorAll('canvas')) {
      let gl = null;
      try { gl = c.getContext('webgl2') || c.getContext('webgl'); } catch (_) {}
      if (gl && gl.isContextLost()) return true;
    }
    return false;
  }

  function healthCheck() {
    if (!state.layers.length || document.hidden) return;
    for (const L of state.layers) if (contextLost(L)) rebuildLayer(L);
    // 保險：目前顯示的圖層一定要是可見的
    const F = state.front;
    if (F && !state.pending && F.el.style.opacity !== '1') {
      F.el.style.transition = 'none'; F.el.style.opacity = '1'; F.el.style.zIndex = '3';
    }
  }

  function setZoom(L, z) {
    L.z = z;
    if (Math.abs(L.zApplied - z) > 0.02 || (z === BASE_ZOOM && L.zApplied !== BASE_ZOOM)) { L.zApplied = z; L.pano.setZoom(z); }
  }

  // 在預載層載入指定的街景（不顯示）
  function loadInto(L, id) {
    if (L.want === id) return;
    L.want = id; L.id = null; L.readyAt = 0;
    L.pano.setPov({ heading: state.cam, pitch: state.camPitch });
    setZoom(L, BASE_ZOOM);
    L.pano.setPano(id);
    L.pano.setVisible(true);
  }

  // 要求前往某張街景：在預載層載好後交叉淡入
  function goTo(id, fade) {
    state.busy = true;
    state.busySince = performance.now();
    state.pending = id;
    state.pendingFade = fade;
    loadInto(state.preload, id);
  }

  function swap(now) {
    const next = state.preload, prev = state.front;
    // 上一次還沒淡完的圖層直接收起來
    const spare = state.fading || state.layers.find((l) => l !== next && l !== prev);
    spare.el.style.transition = 'none';
    spare.el.style.opacity = '0';
    spare.el.style.zIndex = '1';

    prev.el.style.zIndex = '2';
    next.el.style.zIndex = '3';
    setZoom(next, BASE_ZOOM);
    next.pano.setPov({ heading: state.cam, pitch: state.camPitch });
    next.el.style.transition = `opacity ${state.pendingFade}ms linear`;
    next.el.style.opacity = '1';

    state.front = next;
    state.panorama = next.pano;
    state.fading = prev;
    state.fadeUntil = now + state.pendingFade;
    state.preload = spare;
    state.pending = null;
    state.lastPovHeading = norm(state.cam);
    onArrive();
    updatePosition();
  }

  function abortPending(now) {
    const P = state.preload;
    state.pending = null;
    state.busy = false;
    state.lastStep = now;
    P.want = null; P.id = null;
    if (contextLost(P)) rebuildLayer(P);
    setStatus('街景載入逾時，重試中…');
  }

  function updatePosition() {
    const p = state.panorama && state.panorama.getPosition();
    if (!p) return;
    state.map.panTo(p);
    state.marker.setPosition(p);
    try { localStorage.setItem(POS_STORAGE, JSON.stringify({ lat: p.lat(), lng: p.lng(), h: state.heading })); } catch (_) {}
  }

  // 預先載入「接下來最可能走的」那張街景
  function predictNext() {
    if (state.pending) return;
    const dir = state.lastDir === -1 && !state.auto ? -1 : 1;
    const want = dir === 1 ? state.heading : state.heading + 180;
    const r = bestLink(want, state.auto);
    if (!r || r.diff > (state.auto ? 135 : MAX_FORWARD_ANGLE)) return;
    loadInto(state.preload, r.link.pano);
  }

  // ---------- 找街景 / 跳轉 ----------
  function jumpTo(latLng, radius = 80) {
    setStatus('尋找附近的街景…');
    state.svService.getPanorama({
      location: latLng, radius,
      preference: google.maps.StreetViewPreference.NEAREST,
      source: google.maps.StreetViewSource.OUTDOOR,
    }, (data, status) => {
      if (status !== google.maps.StreetViewStatus.OK) {
        if (radius < 1000) return jumpTo(latLng, radius * 4);
        setStatus('這附近沒有街景，換個地點試試');
        return;
      }
      // 車頭朝向最接近目前方向的道路
      const links = data.links || [];
      if (links.length) {
        let best = links[0];
        for (const l of links) if (angleDiff(l.heading, state.heading) < angleDiff(best.heading, state.heading)) best = l;
        state.heading = norm(best.heading);
      }
      state.cam = state.heading; state.camPitch = 0; state.turnVel = 0; state.alignTarget = null;
      state.lastDir = 0;
      goTo(data.location.pano, JUMP_FADE);
    });
  }

  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = els.searchInput.value.trim();
    els.searchInput.blur();
    if (!q || !state.geocoder) return;
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return jumpTo({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
    setStatus('搜尋中…');
    state.geocoder.geocode({ address: q }, (res, status) => {
      if (status === 'OK' && res[0]) jumpTo(res[0].geometry.location);
      else setStatus('找不到地點（需要啟用 Geocoding API，或直接輸入經緯度）');
    });
  });

  // ---------- 開車核心 ----------
  function applyPov(heading, pitch) {
    state.lastPovHeading = norm(heading);
    const pov = { heading: state.lastPovHeading, pitch };
    state.panorama.setPov(pov);
    if (state.fading) state.fading.pano.setPov(pov); // 淡出中的畫面也一起轉，兩張才對得上
  }

  function onArrive() {
    state.busy = false;
    state.arrivedAt = performance.now();
    // 不在這裡強制設定鏡頭，交給每幀的平滑跟隨，避免換張時鏡頭突然跳動
    onLinks();
  }

  function onLinks() {
    // 到新的一張街景後，找出「繼續往前」的道路，讓車頭順著彎道慢慢轉過去
    const ref = state.lastDir === -1 ? state.heading + 180 : state.heading;
    const r = bestLink(ref);
    if (r && r.diff < 50 && r.diff > ALIGN_DEADBAND) {
      state.alignTarget = state.lastDir === -1 ? norm(r.link.heading + 180) : norm(r.link.heading);
    } else if (!r || r.diff >= 50) {
      state.alignTarget = null;
    }
    const n = (state.panorama.getLinks() || []).length;
    if (!state.auto && !state.keys.size) setStatus(n ? `路口：${n} 條路可走` : '沒有可行駛的道路');
  }

  function step(dir) {
    const now = performance.now();
    if (state.busy && now - state.busySince < STEP_TIMEOUT) return;
    const want = dir === 1 ? state.heading : state.heading + 180;
    const r = bestLink(want, state.auto);
    const limit = state.auto ? 135 : MAX_FORWARD_ANGLE;
    if (!r || r.diff > limit) {
      setStatus(dir === 1 ? '前方沒有路，請轉向 ← →' : '後方沒有路');
      if (state.auto && !r) toggleAuto(false);
      state.lastStep = now;
      return;
    }
    // 自動駕駛在路口時，直接轉向新的道路
    if (state.auto && r.diff > 30) state.heading = norm(r.link.heading);

    state.lastStep = now;
    state.lastDir = dir;
    goTo(r.link.pano, Math.max(FADE_MIN, Math.min(FADE_MAX, GEARS[state.gear].interval * 0.6)));
    if (navigator.vibrate) navigator.vibrate(8);
    setStatus(r.link.description || (dir === 1 ? '前進中' : '倒車中'));
  }

  const ease = (rate, dt) => 1 - Math.exp(-rate * dt); // 與幀率無關的平滑係數
  function setText(key, el, v) { if (state.ui[key] !== v) { state.ui[key] = v; el.textContent = v; } }

  function loop(now) {
    const dt = Math.min(0.1, (now - state.lastFrame) / 1000);
    state.lastFrame = now;
    const k = state.keys;

    if (state.panorama) {
      // 轉向
      let turn = 0;
      if (k.has('ArrowLeft') || k.has('a')) turn -= 1;
      if (k.has('ArrowRight') || k.has('d')) turn += 1;
      // 轉向速度有加減速，按下/放開時不會突然甩動
      state.turnVel += (turn * TURN_RATE - state.turnVel) * ease(TURN_ACCEL, dt);
      if (Math.abs(state.turnVel) < 0.5 && !turn) state.turnVel = 0;
      if (state.turnVel) {
        state.heading = norm(state.heading + state.turnVel * dt);
        if (turn) state.alignTarget = null;
      }
      if (!turn && state.alignTarget !== null) {
        const d = signedDiff(state.heading, state.alignTarget);
        if (Math.abs(d) < 0.3) { state.heading = state.alignTarget; state.alignTarget = null; }
        else state.heading = norm(state.heading + d * ease(ALIGN_RATE, dt));
      }

      // 鏡頭平滑跟隨車頭方向；行駛中 pitch 慢慢回正（拖曳中或停車時保留使用者的視角）
      const cd = signedDiff(state.cam, state.heading);
      const driving = state.auto || k.has('ArrowUp') || k.has('w') || k.has('ArrowDown') || k.has('s');
      const pitch = state.drag || !driving ? state.camPitch
        : Math.abs(state.camPitch) < 0.05 ? 0 : state.camPitch * (1 - ease(3, dt));
      if (Math.abs(cd) > 0.02 || pitch !== state.camPitch) {
        state.cam = Math.abs(cd) < 0.02 ? state.heading : norm(state.cam + cd * ease(CAM_SMOOTH, dt));
        state.camPitch = pitch;
        applyPov(state.cam, pitch);
      }

      // 前進 / 倒車
      const fwd = k.has('ArrowUp') || k.has('w') || state.auto;
      const back = k.has('ArrowDown') || k.has('s');
      const interval = GEARS[state.gear].interval;
      let moving = 0;
      if (fwd && !back) moving = 1; else if (back && !fwd) moving = -1;
      if (moving && now - state.lastStep >= (moving === -1 ? interval * 1.4 : interval)
          && now - state.arrivedAt >= MIN_DWELL) step(moving);

      // 預載層準備好就交叉淡入（逾時也直接換，避免卡住）
      if (state.pending) {
        const P = state.preload;
        const ready = P.id === state.pending && now - P.readyAt >= TILE_GRACE;
        if (ready) swap(now);
        else if (now - state.busySince > STEP_TIMEOUT) {
          if (!state.front.id) swap(now);       // 還沒有任何畫面（剛開啟）：照樣顯示
          else abortPending(now);               // 已有畫面：保留目前畫面，不換成黑的
        }
      }
      if (state.fading && now >= state.fadeUntil) {
        const F = state.fading;
        F.el.style.transition = 'none';
        F.el.style.opacity = '0';
        F.el.style.zIndex = '1';
        setZoom(F, BASE_ZOOM);
        state.fading = null;
      }

      // 前進時鏡頭持續推近，看起來像一直往前開，而不是一格一格跳
      const dollyRate = DOLLY_ZOOM / (interval / 1000);
      if (moving === 1) {
        setZoom(state.front, Math.min(BASE_ZOOM + DOLLY_ZOOM * 1.2, state.front.z + dollyRate * dt));
      } else if (state.front.z !== BASE_ZOOM) {
        const z = state.front.z + (BASE_ZOOM - state.front.z) * ease(moving ? 6 : 1.5, dt);
        setZoom(state.front, Math.abs(z - BASE_ZOOM) < 0.003 ? BASE_ZOOM : z);
      }
      if (state.fading && state.lastDir === 1) {
        setZoom(state.fading, Math.min(BASE_ZOOM + DOLLY_ZOOM * 2.2, state.fading.z + dollyRate * dt));
      }

      if (!state.pending && state.front.id) predictNext();

      // 儀表
      const target = moving ? (METERS_PER_STEP / ((moving === -1 ? interval * 1.4 : interval) / 1000)) * 3.6 : 0;
      state.displaySpeed += (target - state.displaySpeed) * Math.min(1, dt * 3);
      setText('speed', els.speed, String(Math.round(state.displaySpeed)));
      setText('gear', els.gear, moving === -1 ? 'R' : (moving ? GEARS[state.gear].name : 'P'));
      const hdg = Math.round(state.cam) % 360;
      if (state.ui.hdg !== hdg) {
        state.ui.hdg = hdg;
        els.needle.style.transform = `rotate(${-hdg}deg)`;
        els.headingText.textContent = `${hdg}°`;
      }
      const icon = state.marker.getIcon();
      if (angleDiff(icon.rotation || 0, state.cam) > 2) { icon.rotation = state.cam; state.marker.setIcon(icon); }
    }
    requestAnimationFrame(loop);
  }

  function toggleAuto(on = !state.auto) {
    state.auto = on;
    els.autoBtn.classList.toggle('on', on);
    setStatus(on ? '自動駕駛中（方向鍵可轉彎，空白鍵停止）' : '自動駕駛關閉');
  }

  // 小地圖放大/還原
  function toggleMapExpand() {
    const on = els.minimapWrap.classList.toggle('expanded');
    $('mapExpand').textContent = on ? '⤡' : '⤢';
    $('mapExpand').title = on ? '縮小地圖 (N)' : '放大地圖 (N)';
    if (state.map) {
      state.map.setZoom(on ? Math.max(state.map.getZoom(), 17) : 17);
      // 等尺寸動畫結束後重新置中
      setTimeout(() => {
        const p = state.panorama && state.panorama.getPosition();
        if (p) state.map.setCenter(p);
      }, 300);
    }
  }

  // 小地圖切換 一般 / 衛星（含道路標示）
  function toggleMapType() {
    if (!state.map) return;
    const sat = state.map.getMapTypeId() !== 'hybrid';
    state.map.setMapTypeId(sat ? 'hybrid' : 'roadmap');
    const btn = $('mapType');
    btn.textContent = sat ? '🗺' : '🛰';
    btn.title = sat ? '切換一般地圖 (B)' : '切換衛星地圖 (B)';
    btn.setAttribute('aria-label', btn.title);
    try { localStorage.setItem(MAPTYPE_STORAGE, sat ? 'hybrid' : 'roadmap'); } catch (_) {}
  }

  function shiftGear(d) {
    state.gear = Math.max(0, Math.min(GEARS.length - 1, state.gear + d));
    setStatus(`檔位 ${GEARS[state.gear].name}`);
  }

  // ---------- 鍵盤 ----------
  const DRIVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']);
  function keyName(e) { return e.key.length === 1 ? e.key.toLowerCase() : e.key; }

  window.addEventListener('keydown', (e) => {
    if (e.target === els.searchInput || e.target === els.keyInput) return;
    const k = keyName(e);
    if (DRIVE_KEYS.has(k)) { state.keys.add(k); e.preventDefault(); e.stopPropagation(); return; }
    if (e.repeat) return;
    if (k === ' ') { toggleAuto(); e.preventDefault(); }
    else if (k === '+' || k === '=') shiftGear(1);
    else if (k === '-' || k === '_') shiftGear(-1);
    else if (k === 'm') els.minimapWrap.classList.toggle('hidden');
    else if (k === 'n') toggleMapExpand();
    else if (k === 'b') toggleMapType();
    else if (k === 'h') els.help.classList.toggle('hidden');
  }, true);
  window.addEventListener('keyup', (e) => { state.keys.delete(keyName(e)); }, true);
  window.addEventListener('blur', () => state.keys.clear());

  // ---------- 滑鼠 / 觸控拖曳轉動視角 ----------
  // 自己處理拖曳（而不是交給 Google 街景），才不會和每幀的鏡頭平滑跟隨互相搶控制。
  const panoEl = $('pano');
  panoEl.style.cursor = 'grab';
  panoEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (state.drag || !state.panorama) return;
    e.preventDefault();
    e.stopPropagation();
    state.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { panoEl.setPointerCapture(e.pointerId); } catch (_) {}
    panoEl.style.cursor = 'grabbing';
  }, true);
  panoEl.addEventListener('pointermove', (e) => {
    const d = state.drag;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const sens = DRAG_FOV / Math.max(1, panoEl.clientWidth) / Math.pow(2, state.front ? state.front.z : 0);
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    // 抓住畫面拖：往右拖 → 視角往左轉；往下拖 → 往上看
    state.heading = state.cam = norm(state.cam - dx * sens);
    state.camPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, state.camPitch + dy * sens));
    state.alignTarget = null;
    state.turnVel = 0;
    applyPov(state.cam, state.camPitch);
  }, true);
  const endDrag = (e) => {
    if (!state.drag || state.drag.id !== e.pointerId) return;
    state.drag = null;
    panoEl.style.cursor = 'grab';
  };
  panoEl.addEventListener('pointerup', endDrag, true);
  panoEl.addEventListener('pointercancel', endDrag, true);
  panoEl.addEventListener('lostpointercapture', endDrag, true);
  // 擋掉 Google 街景自己的拖曳處理
  ['mousedown', 'touchstart', 'touchmove'].forEach((t) =>
    panoEl.addEventListener(t, (e) => e.stopPropagation(), { capture: true, passive: true }));

  // ---------- 觸控按鈕 ----------
  document.querySelectorAll('#touchControls [data-key]').forEach((btn) => {
    const key = btn.dataset.key;
    const isHold = DRIVE_KEYS.has(key);
    const down = (e) => {
      e.preventDefault();
      btn.setPointerCapture && btn.setPointerCapture(e.pointerId);
      btn.classList.add('active');
      if (isHold) state.keys.add(key);
      else shiftGear(key === '+' ? 1 : -1);
    };
    const up = () => { btn.classList.remove('active'); if (isHold) state.keys.delete(key); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  els.autoBtn.addEventListener('click', () => toggleAuto());

  // ---------- PWA ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---------- 啟動 ----------
  const key = getApiKey();
  if (key) loadMaps(key); else { setStatus('請輸入 Google Maps API Key'); askKey(); }
})();
