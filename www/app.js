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

  // 每檔位的定速（km/h）。依「實際照片間距」決定何時換下一張，所以速度固定，不會忽快忽慢。
  const GEARS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((kmh, i) => ({ name: String(i + 1), kmh }));
  const DEFAULT_STEP_M = 10;     // 還不知道下一張位置時，假設的照片間距
  const REVERSE_FACTOR = 0.6;    // 倒車速度比例
  const TURN_RATE = 70;          // 度/秒
  const TURN_ACCEL = 7;          // 轉向加速/減速的平滑度（越大越快達到全速）
  const CAM_SMOOTH = 6;          // 鏡頭跟隨車頭的平滑度（越小越柔和）
  const ALIGN_RATE = 1.6;        // 自動對齊道路方向的速度（越大越快）
  const ALIGN_DEADBAND = 7;      // 道路方向差在此角度內視為直路，不修正（避免鏡頭左右晃）
  const MIN_DWELL = 150;         // 每張街景至少停留的時間，避免畫面還沒載好就跳下一張
  const MAX_FORWARD_ANGLE = 80;  // 手動前進時可接受的道路夾角
  const STEP_TIMEOUT = 3000;     // 等待街景載入的逾時
  // 無縫銜接：三層全景輪替，下一張先在隱藏層預載。
  // 程式記錄一個「虛擬車位」（真實座標，公尺），每張照片都依自己拍攝點到虛擬車位的位移，
  // 調整視角/縮放/方向去模擬「從虛擬車位看出去」的畫面（以前方 REF_DEPTH 公尺的景物為基準對齊）。
  // 開到兩張照片的中點時交叉淡入：舊照片往前推近、新照片往後拉遠，兩張看到的是同一個位置，
  // 所以淡入時地上的車子、電線桿、斑馬線都疊在同一個地方，不會跳。
  // 畫質：zoom 0 是 180° 超廣角（影像被拉扯、解析度低）；橫向畫面用 zoom 1（90°，跟 Google 預設一樣清楚），
  // 直向手機用 0.6 保留足夠視野。zoom 越高 Google 會載入越高解析度的圖磚。
  const baseZoom = () => (window.innerWidth >= window.innerHeight ? 1 : 0.6);
  let BASE_ZOOM = baseZoom();
  const REF_DEPTH = 20;          // 對齊基準：前方幾公尺的景物要完全疊合
  const MAX_FWD = 0.65;          // 單張照片最多模擬往前 REF_DEPTH 的幾成（避免放太大）
  const FADE_MIN = 160, FADE_MAX = 450, JUMP_FADE = 600; // 交叉淡入時間（毫秒）
  const TILE_GRACE = 220;        // 剛載好資料時多等一下，讓影像圖磚與 Google 自己的過場跑完再淡入
  const DRAG_FOV = 100;          // 拖過整個畫面寬度約轉動的角度
  const MAX_PITCH = 80;

  const $ = (id) => document.getElementById(id);
  const els = {
    layers: [$('panoA'), $('panoB'), $('panoC')], minimap: $('minimap'), minimapWrap: $('minimapWrap'), status: $('status'),
    speed: $('speedValue'), gear: $('gear'), needle: $('needle'), headingText: $('headingText'),
    help: $('help'), autoBtn: $('autoBtn'), cruiseBtn: $('cruiseBtn'),
    keyDialog: $('keyDialog'), keyForm: $('keyForm'), keyInput: $('keyInput'),
    searchForm: $('searchForm'), searchInput: $('searchInput'), settingsBtn: $('settingsBtn'),
  };

  const state = {
    panorama: null, layers: [], front: null, preload: null, fading: null, fadeUntil: 0,
    pending: null, pendingFade: 0, map: null, marker: null, svService: null, geocoder: null,
    heading: CFG.startHeading || 0,   // 車頭（邏輯）方向
    cam: CFG.startHeading || 0,       // 鏡頭實際顯示的方向，平滑跟隨 heading
    camPitch: 0,
    turnVel: 0,                       // 目前轉向角速度（度/秒）
    arrivedAt: 0,
    alignTarget: null,        // 道路方向，車頭會慢慢對齊
    keys: new Set(),
    drag: null,               // 滑鼠/觸控拖曳中的指標
    gear: 4,
    lite: false,              // 單圖層模式（裝置 WebGL 記憶體不足時自動切換）
    auto: false,
    cruise: false,            // 定速巡航：不用按住 ↑ 也會持續前進，方向自己控制
    brakeHeld: null,          // 按 ↓ 解除巡航時，這顆鍵放開前不當成倒車
    busy: false,
    busySince: 0,
    vOff: { x: 0, y: 0 },     // 虛擬車位相對目前照片拍攝點的位移（公尺，x 東 y 北）
    pendingHeading: null,     // 正在前往的那條道路方向（null = 瞬間移動，不做位移銜接）
    speed: 0,                 // 目前車速（公尺/秒）
    blockedUntil: 0,          // 前方沒路時，暫停重試
    lastDir: 0,               // 1 前進, -1 倒車, 0 停止
    displaySpeed: 0,
    lastFrame: performance.now(),
    ui: {},                   // 快取儀表顯示值，避免每幀重寫 DOM
  };

  // ---------- 工具 ----------
  const norm = (h) => ((h % 360) + 360) % 360;
  const angleDiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)) % 360; return d > 180 ? 360 - d : d; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const signedDiff = (from, to) => { let d = norm(to) - norm(from); if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  const setStatus = (t) => { els.status.textContent = t; };
  const R2D = 180 / Math.PI, D2R = Math.PI / 180;
  // a → b 的平面位移（公尺，x 東 y 北），照片間距離很短，用局部平面近似即可
  function enu(a, b) {
    return { x: (b.lng() - a.lng()) * 111320 * Math.cos(a.lat() * D2R), y: (b.lat() - a.lat()) * 110540 };
  }
  const dirVec = (h) => ({ x: Math.sin(h * D2R), y: Math.cos(h * D2R) });

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
    if (new URLSearchParams(location.search).get('lite') === '1') enterLite();
    jumpTo(start);
    requestAnimationFrame(loop);
    setInterval(healthCheck, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(healthCheck, 300); });
  }

  // ---------- 全景圖層 ----------
  function makeLayer(el, opts) {
    const L = { el, opts, pano: null, want: null, id: null, prevId: null, failed: null, readyAt: 0,
      z: BASE_ZOOM, zApplied: BASE_ZOOM, dead: false, lostAt: 0, restoredAt: 0, rebuiltAt: 0 };
    buildPano(L);
    // WebGL 畫布失效（手機記憶體不足、切到背景再回來）時街景會整片變黑。
    // 注意：不可以自己對畫布呼叫 getContext() 檢查，那會搶走/多開 WebGL context，反而造成黑屏。
    el.addEventListener('webglcontextlost', (e) => onContextLost(L, e.target), true);
    el.addEventListener('webglcontextrestored', () => { L.restoredAt = performance.now(); }, true);
    return L;
  }

  // 圖層載好指定的街景了嗎？Google 有時會把 pano id 換成別名，所以只要換成「新的一張」就算載好
  function markReady(L) {
    const id = L.pano.getPano();
    if (!L.want || L.id || !id) return;
    if (id === L.want || id !== L.prevId) { L.id = L.want; L.readyAt = performance.now(); }
  }

  function buildPano(L) {
    if (L.pano) { google.maps.event.clearInstanceListeners(L.pano); L.pano.setVisible(false); }
    L.el.textContent = '';
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    L.el.appendChild(host);
    L.pano = new google.maps.StreetViewPanorama(host, L.opts);
    L.zApplied = L.z = BASE_ZOOM;
    L.povH = undefined; L.povP = undefined;
    L.pano.addListener('links_changed', () => {
      markReady(L);
      if (L === state.front && !state.pending) onLinks();
    });
    L.pano.addListener('status_changed', () => {
      const s = L.pano.getStatus();
      if (s === 'OK') markReady(L);
      else if (s && L.want && !L.id) L.failed = L.want;   // 這張載入失敗，不要等到逾時
    });
    L.pano.addListener('position_changed', () => { if (L === state.front) updatePosition(); });
    // 使用者若用滑鼠拖曳畫面，同步車頭方向
    L.pano.addListener('pov_changed', () => {
      if (L !== state.front) return;
      const pov = L.pano.getPov();
      // 程式自己設定的視角（含銜接用的位移修正）不算
      if (L.povH !== undefined && angleDiff(pov.heading, L.povH) < 0.5 && Math.abs(pov.pitch - L.povP) < 0.5) return;
      if (!state.keys.size && !state.auto && !state.cruise && !state.drag) {
        state.heading = state.cam = norm(pov.heading);
        state.camPitch = pov.pitch;
        state.alignTarget = null;
        state.turnVel = 0;
      }
      L.povH = norm(pov.heading); L.povP = pov.pitch;
    });
  }

  function onContextLost(L, canvas) {
    if (L.dead) return;
    const lostAt = L.lostAt = performance.now();
    // 給 Google 一點時間自己復原；畫布若已被 Google 自己移除，就不是我們的問題
    setTimeout(() => {
      if (L.dead || L.restoredAt > lostAt || !canvas.isConnected || !L.el.contains(canvas)) return;
      // 裝置撐不住多個 WebGL 街景：改用單一圖層（省記憶體），再把目前畫面重建回來
      enterLite();
      if (L === state.front) rebuildLayer(L);
    }, 1200);
  }

  function rebuildLayer(L) {
    if (L.dead) return;
    const now = performance.now();
    if (now - L.rebuiltAt < 3000) { setTimeout(() => rebuildLayer(L), 3000); return; }
    L.rebuiltAt = now;
    const id = L.id || L.want;
    buildPano(L);
    L.want = null; L.id = null; L.prevId = null; L.failed = null; L.readyAt = 0;
    if (L === state.front) {
      state.panorama = L.pano;
      if (id) loadInto(L, id);
      showLayer(L);
    }
  }

  // 釋放不再使用的圖層（連同它的 WebGL 記憶體）
  function destroyLayer(L) {
    L.dead = true;
    try { google.maps.event.clearInstanceListeners(L.pano); L.pano.setVisible(false); } catch (_) {}
    for (const c of L.el.querySelectorAll('canvas')) {
      try {
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        const ext = gl && gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (_) {}
    }
    L.el.textContent = '';
    L.el.style.display = 'none';
  }

  function showLayer(L) {
    L.el.style.transition = 'none'; L.el.style.opacity = '1'; L.el.style.zIndex = '3';
  }

  // 省電/低記憶體模式：只用一個街景圖層，換張交給 Google 自己的過場（不會黑屏）
  function enterLite() {
    if (state.lite) return;
    state.lite = true;
    const F = state.front;
    const pend = state.pending;
    for (const L of state.layers) if (L !== F) destroyLayer(L);
    state.layers = [F];
    state.preload = F;
    state.fading = null;
    state.pending = null;
    state.busy = false;
    state.vOff = { x: 0, y: 0 };
    showLayer(F);
    if (pend) goTo(pend, 0, state.pendingHeading);
  }

  function healthCheck() {
    if (!state.layers.length || document.hidden) return;
    // 保險：目前顯示的圖層一定要是可見的
    const F = state.front;
    if (F && (state.lite || !state.pending) && F.el.style.opacity !== '1' && (F.id || state.lite)) showLayer(F);
  }

  function setZoom(L, z) {
    L.z = z;
    if (Math.abs(L.zApplied - z) > 0.004 || (z === BASE_ZOOM && L.zApplied !== BASE_ZOOM)) { L.zApplied = z; L.pano.setZoom(z); }
  }

  // 在預載層載入指定的街景（不顯示）
  function loadInto(L, id) {
    if (L.want === id) return;
    L.prevId = L.pano.getPano() || null;
    L.want = id; L.id = null; L.readyAt = 0; L.failed = null;
    if (L !== state.front) renderLayer(L);
    if (L.prevId === id && L.pano.getStatus() === 'OK') {
      // 已經是這一張了（例如逾時後重試）：setPano 不會再觸發事件，直接視為載好
      L.id = id; L.readyAt = performance.now();
    } else {
      L.pano.setPano(id);
    }
    L.pano.setVisible(true);
  }

  // 要求前往某張街景：在預載層載好後交叉淡入
  function goTo(id, fade, heading = null) {
    state.busy = true;
    state.busySince = performance.now();
    state.pending = id;
    state.pendingFade = fade;
    state.pendingHeading = heading;
    loadInto(state.preload, id);
  }

  function swap(now) {
    if (state.lite) {
      // 單圖層：新照片就載在目前的圖層上，不需要換層
      state.pending = null;
      state.vOff = { x: 0, y: 0 };
      showLayer(state.front);
      onArrive();
      updatePosition();
      return;
    }
    const next = state.preload, prev = state.front;
    // 上一次還沒淡完的圖層直接收起來
    const spare = state.fading || state.layers.find((l) => l !== next && l !== prev);
    spare.el.style.transition = 'none';
    spare.el.style.opacity = '0';
    spare.el.style.zIndex = '1';

    prev.el.style.zIndex = '2';
    next.el.style.zIndex = '3';
    // 虛擬車位改成以新照片為基準（位置不變，只是換參考點），兩張畫面才會疊在一起
    const a = prev.pano.getPosition(), b = next.pano.getPosition();
    if (state.pendingHeading !== null && a && b) {
      const v = enu(a, b);
      state.vOff = { x: state.vOff.x - v.x, y: state.vOff.y - v.y };
    } else state.vOff = { x: 0, y: 0 };
    renderLayer(next);
    next.el.style.transition = `opacity ${state.pendingFade}ms linear`;
    next.el.style.opacity = '1';

    state.front = next;
    state.panorama = next.pano;
    state.fading = prev;
    state.fadeUntil = now + state.pendingFade;
    state.preload = spare;
    state.pending = null;
    onArrive();
    updatePosition();
  }

  function abortPending(now) {
    const P = state.preload;
    state.pending = null;
    state.busy = false;
    state.blockedUntil = now + 300;
    P.want = null; P.id = null; P.failed = null;
    setStatus('街景載入失敗，重試中…');
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
    if (state.pending || state.lite) return;
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
      state.lastDir = 0; state.vOff = { x: 0, y: 0 };
      goTo(data.location.pano, JUMP_FADE, null);
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
    if (!state.auto && !state.cruise && !state.keys.size) setStatus(n ? `路口：${n} 條路可走` : '沒有可行駛的道路');
  }

  // 往某張照片的位移向量（公尺）。預載層已經載好就用真實座標，否則先用道路方向 × 預設間距
  function segmentTo(id, heading) {
    const P = state.preload, F = state.front;
    if (P !== F && P.want === id && P.id) {
      const a = F.pano.getPosition(), b = P.pano.getPosition();
      if (a && b) {
        const v = enu(a, b);
        if (Math.hypot(v.x, v.y) >= 0.3) return v;
      }
    }
    const u = dirVec(heading);
    return { x: u.x * DEFAULT_STEP_M, y: u.y * DEFAULT_STEP_M };
  }

  function linkFor(dir) {
    const r = bestLink(dir === 1 ? state.heading : state.heading + 180, state.auto);
    return r && r.diff <= (state.auto ? 135 : MAX_FORWARD_ANGLE) ? r : null;
  }

  // 出發前往下一張（在預載層載好後交叉淡入）
  function commit(dir, r, dist, speed) {
    // 自動駕駛在路口時，直接轉向新的道路
    if (state.auto && r.diff > 30) state.heading = norm(r.link.heading);
    state.lastDir = dir;
    goTo(r.link.pano, clamp((dist / speed) * 500, FADE_MIN, FADE_MAX), r.link.heading);
    if (navigator.vibrate) navigator.vibrate(8);
    setStatus(r.link.description || (dir === 1 ? '前進中' : '倒車中'));
  }

  // 依「照片拍攝點 → 虛擬車位」的位移，算出這張照片要用的視角，模擬從虛擬車位看出去的畫面。
  // 以前方 REF_DEPTH 公尺、垂直視線的平面為基準：往前 f 公尺 → 畫面放大 D/(D-f)；
  // 往右 l 公尺 → 基準平面上的景物往左滑，鏡頭往右偏 atan(l/D)。
  function viewFor(off) {
    const c = state.cam * D2R, D = REF_DEPTH;
    let f = off.x * Math.sin(c) + off.y * Math.cos(c);
    let l = off.x * Math.cos(c) - off.y * Math.sin(c);
    f = clamp(f, -2 * D, MAX_FWD * D);
    l = clamp(l, -D, D);
    const k = D / (D - f);
    const fov = 180 / Math.pow(2, BASE_ZOOM);
    const fovP = 2 * Math.atan(Math.tan(fov * D2R / 2) / k) * R2D;
    return {
      heading: norm(state.cam + Math.atan(l / D) * R2D),
      pitch: Math.atan(Math.tan(state.camPitch * D2R) / k) * R2D,
      zoom: clamp(Math.log2(180 / fovP), 0, 4),
    };
  }

  function renderLayer(L) {
    let off = { x: 0, y: 0 };
    if (!state.lite) {
      off = state.vOff;
      if (L !== state.front) {
        const lp = L.pano.getPosition(), fp = state.front.pano.getPosition();
        if (lp && fp) { const v = enu(lp, fp); off = { x: off.x + v.x, y: off.y + v.y }; }
      }
    }
    const v = viewFor(off);
    if (L.povH === undefined || angleDiff(v.heading, L.povH) > 0.01 || Math.abs(v.pitch - L.povP) > 0.01) {
      L.povH = v.heading; L.povP = v.pitch;
      L.pano.setPov({ heading: v.heading, pitch: v.pitch });
    }
    setZoom(L, v.zoom);
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
      const driving = state.auto || state.cruise || k.has('ArrowUp') || k.has('w') || k.has('ArrowDown') || k.has('s');
      if (!state.drag) {
        state.cam = Math.abs(cd) < 0.02 ? state.heading : norm(state.cam + cd * ease(CAM_SMOOTH, dt));
        if (driving) state.camPitch = Math.abs(state.camPitch) < 0.05 ? 0 : state.camPitch * (1 - ease(3, dt));
      }

      // 前進 / 倒車：虛擬車位以定速沿著道路往下一張照片移動，走到兩張中點附近就換張
      const fwd = k.has('ArrowUp') || k.has('w') || state.auto || state.cruise;
      const back = (k.has('ArrowDown') && state.brakeHeld !== 'ArrowDown') || (k.has('s') && state.brakeHeld !== 's');
      let moving = 0;
      if (fwd && !back) moving = 1; else if (back && !fwd) moving = -1;
      let speed = moving ? (GEARS[state.gear].kmh / 3.6) * (moving === -1 ? REVERSE_FACTOR : 1) : 0;
      if (moving) {
        let id = null, hd = 0, r = null;
        if (state.pending) {
          if (state.pendingHeading !== null) { id = state.pending; hd = state.pendingHeading; }
        } else if ((r = linkFor(moving))) { id = r.link.pano; hd = r.link.heading; }
        if (id) {
          const S = segmentTo(id, hd);
          const d = Math.hypot(S.x, S.y), u = { x: S.x / d, y: S.y / d };
          const p = state.vOff.x * u.x + state.vOff.y * u.y;
          // 下一張還沒載好時，最多停在它的位置等，不會衝過頭
          const adv = Math.min(speed * dt, Math.max(0, d - p));
          state.vOff = { x: state.vOff.x + u.x * adv, y: state.vOff.y + u.y * adv };
          const fade = clamp((d / speed) * 500, FADE_MIN, FADE_MAX);
          // 讓交叉淡入的正中間剛好落在兩張照片的中點（單圖層模式則走到下一張才換）
          const at = state.lite ? d : d / 2 - speed * fade / 2000;
          if (r && p + adv >= at && now >= state.blockedUntil && now - state.arrivedAt >= MIN_DWELL
              && !(state.busy && now - state.busySince < STEP_TIMEOUT)) commit(moving, r, d, speed);
        } else if (!state.pending) {
          speed = 0;
          if (now >= state.blockedUntil) {
            const any = bestLink(moving === 1 ? state.heading : state.heading + 180, state.auto);
            setStatus(moving === 1 ? '前方沒有路，請轉向 ← →' : '後方沒有路');
            if (state.auto && !any) toggleAuto(false);
            state.blockedUntil = now + 400;
          }
        }
      }
      state.speed = speed;

      // 預載層準備好就交叉淡入（逾時也直接換，避免卡住）
      if (state.pending) {
        const P = state.preload;
        const ready = P.id === state.pending && now - P.readyAt >= (state.lite ? 0 : TILE_GRACE);
        if (ready) swap(now);
        else if (P.failed === state.pending) abortPending(now);
        else if (now - state.busySince > STEP_TIMEOUT) {
          if (state.lite) swap(now);            // 單圖層：Google 會保留舊畫面直到新的載好
          else if (!state.front.id) swap(now);  // 還沒有任何畫面（剛開啟）：照樣顯示
          else abortPending(now);               // 已有畫面：保留目前畫面，不換成黑的
        }
      }
      if (state.fading && now >= state.fadeUntil) {
        const F = state.fading;
        F.el.style.transition = 'none';
        F.el.style.opacity = '0';
        F.el.style.zIndex = '1';
        state.fading = null;
      }

      // 每張照片都依自己到虛擬車位的位移調整視角：前景、淡出中、預載中的三張永遠對齊同一個位置
      renderLayer(state.front);
      if (!state.lite) {
        if (state.fading) renderLayer(state.fading);
        const P = state.preload;
        if (P !== state.front && P !== state.fading && P.want) renderLayer(P);
      }

      if (!state.pending && state.front.id) predictNext();

      // 儀表
      const target = speed * 3.6;
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
    if (on && state.cruise) toggleCruise(false, true);
    state.auto = on;
    els.autoBtn.classList.toggle('on', on);
    setStatus(on ? '自動駕駛中（方向鍵可轉彎，空白鍵停止）' : '自動駕駛關閉');
  }

  // 定速巡航：放開 ↑ 也會用目前檔位的速度持續前進，← → 自己轉彎，↓ 或 C 解除
  function toggleCruise(on = !state.cruise, quiet = false) {
    if (on && state.auto) toggleAuto(false);
    state.cruise = on;
    els.cruiseBtn.classList.toggle('on', on);
    if (!quiet) setStatus(on ? `定速巡航 ${GEARS[state.gear].kmh} km/h（← → 轉向，↓ 或 C 解除）` : '定速巡航解除');
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
    setStatus(`檔位 ${GEARS[state.gear].name}：定速 ${GEARS[state.gear].kmh} km/h`);
  }

  // ---------- 鍵盤 ----------
  const DRIVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']);
  function keyName(e) { return e.key.length === 1 ? e.key.toLowerCase() : e.key; }
  // 巡航中踩 ↓ 等於踩煞車：解除巡航並停車，要再按一次才會倒車
  function pressDrive(k) {
    if ((k === 'ArrowDown' || k === 's') && state.cruise) {
      toggleCruise(false);
      state.brakeHeld = k;
    }
    state.keys.add(k);
  }
  function releaseDrive(k) {
    state.keys.delete(k);
    if (state.brakeHeld === k) state.brakeHeld = null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.target === els.searchInput || e.target === els.keyInput) return;
    const k = keyName(e);
    if (DRIVE_KEYS.has(k)) {
      if (!e.repeat) pressDrive(k);
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.repeat) return;
    if (k === ' ') { toggleAuto(); e.preventDefault(); }
    else if (k === 'c') toggleCruise();
    else if (k === '+' || k === '=') shiftGear(1);
    else if (k === '-' || k === '_') shiftGear(-1);
    else if (k === 'm') els.minimapWrap.classList.toggle('hidden');
    else if (k === 'n') toggleMapExpand();
    else if (k === 'b') toggleMapType();
    else if (k === 'h') els.help.classList.toggle('hidden');
  }, true);
  window.addEventListener('keyup', (e) => releaseDrive(keyName(e)), true);
  window.addEventListener('blur', () => { state.keys.clear(); state.brakeHeld = null; });
  window.addEventListener('resize', () => { BASE_ZOOM = baseZoom(); });

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
      if (isHold) pressDrive(key);
      else shiftGear(key === '+' ? 1 : -1);
    };
    const up = () => { btn.classList.remove('active'); if (isHold) releaseDrive(key); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  els.autoBtn.addEventListener('click', () => toggleAuto());
  els.cruiseBtn.addEventListener('click', () => toggleCruise());

  // ---------- PWA ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---------- 啟動 ----------
  const key = getApiKey();
  if (key) loadMaps(key); else { setStatus('請輸入 Google Maps API Key'); askKey(); }
})();
