// Kart GeoGuesser: drive a kart through 360° street imagery, then guess where you are.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const rad = THREE.MathUtils.degToRad;
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const lerp = (a, b, t) => a + (b - a) * t;
  const fwd = (deg) => new THREE.Vector3(Math.sin(rad(deg)), 0, -Math.cos(rad(deg)));

  const ROUNDS = 5;
  const MAX_SPEED = 16; // m/s
  const SPHERE_R = 60;
  const KART_LEN = 1.7;
  const KART_LABELS = ['Standard', 'Kart 2', 'Kart 3'];

  // ---------- renderer ----------
  const canvas = $('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const cams = [];
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    for (const c of cams) { c.aspect = window.innerWidth / window.innerHeight; c.updateProjectionMatrix(); }
  }
  window.addEventListener('resize', resize);

  let factory = null;
  const state = {
    screen: 'loading', charIdx: 0, kartIdx: 0, round: 0, total: 0, results: [],
    muted: false,
  };
  const keys = {};

  // ---------- helpers ----------
  function setLoading(text) {
    $('loading-text').textContent = text;
    show('loading');
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1300);
  }
  function canvasTexture(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- karts ----------
  const kartCache = new Map();
  function getKart(charId, kartName) {
    const key = charId + '|' + kartName;
    if (!kartCache.has(key)) {
      const k = factory.buildKart(charId, kartName);
      k.scale.setScalar(KART_LEN);
      kartCache.set(key, k);
    }
    return kartCache.get(key);
  }
  const chars = () => factory.characters();
  const currentChar = () => chars()[state.charIdx];
  const currentKarts = () => factory.kartsFor(currentChar().id);
  const currentKart = () => getKart(currentChar().id, currentKarts()[state.kartIdx] || currentKarts()[0]);

  // ---------- menu scene ----------
  const menuScene = new THREE.Scene();
  menuScene.background = canvasTexture(4, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#3d7bff'); gr.addColorStop(0.6, '#8fd0ff'); gr.addColorStop(1, '#ffe9a8');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const menuCam = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
  cams.push(menuCam);
  const turntable = new THREE.Group();
  menuScene.add(turntable);
  {
    const checker = canvasTexture(256, 256, (g, w, h) => {
      const n = 8;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fafafa'; g.fillRect((x * w) / n, (y * h) / n, w / n, h / n); }
    });
    checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
    checker.repeat.set(3, 3);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.55, 0.12, 64), [
      new THREE.MeshBasicMaterial({ color: 0xe4252b }), new THREE.MeshBasicMaterial({ map: checker }), new THREE.MeshBasicMaterial({ color: 0x222222 }),
    ]);
    disc.position.y = -0.06;
    turntable.add(disc);
  }
  let menuKart = null;
  function refreshMenuKart() {
    if (menuKart) turntable.remove(menuKart);
    menuKart = currentKart();
    menuKart.position.set(0, 0, 0);
    menuKart.rotation.set(0, 0, 0);
    resetKartPose(menuKart);
    turntable.add(menuKart);
    $('char-name').textContent = currentChar().name;
    const tabs = $('kart-tabs');
    tabs.innerHTML = '';
    currentKarts().forEach((k, i) => {
      const b = document.createElement('button');
      b.textContent = KART_LABELS[i] || 'Kart ' + (i + 1);
      if (i === state.kartIdx) b.className = 'on';
      b.onclick = () => { state.kartIdx = i; refreshMenuKart(); };
      tabs.appendChild(b);
    });
  }
  function resetKartPose(k) {
    for (const w of k.userData.wheels) { w.pivot.rotation.set(0, 0, 0); w.wheel.rotation.set(0, 0, 0); }
  }
  function changeChar(d) {
    const n = chars().length;
    state.charIdx = (state.charIdx + d + n) % n;
    state.kartIdx = 0;
    refreshMenuKart();
  }
  function changeKart(d) {
    const n = currentKarts().length;
    state.kartIdx = (state.kartIdx + d + n) % n;
    refreshMenuKart();
  }
  function enterMenu() {
    state.screen = 'menu';
    ['loading', 'rompick', 'hud', 'result', 'final'].forEach(hide);
    show('menu');
    refreshMenuKart();
  }
  $('char-prev').onclick = () => changeChar(-1);
  $('char-next').onclick = () => changeChar(1);
  $('start').onclick = () => startGame();

  // ---------- game scene ----------
  // Panoramas render in their own pass underneath the kart scene.
  const panoScene = new THREE.Scene();
  panoScene.background = new THREE.Color(0x87b6ff);
  const gameScene = new THREE.Scene();
  const gameCam = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
  cams.push(gameCam);
  function makeSphere() {
    const geo = new THREE.SphereGeometry(SPHERE_R, 96, 48);
    geo.scale(-1, 1, 1);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false }));
    mesh.renderOrder = -2;
    mesh.visible = false;
    panoScene.add(mesh);
    return mesh;
  }
  const sphereCur = makeSphere();
  const spherePrev = makeSphere();
  spherePrev.renderOrder = -1;
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 2.2),
    new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false,
      map: canvasTexture(128, 128, (g) => {
        const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
        gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      }),
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  const kartHolder = new THREE.Group(); // yaw
  const kartBody = new THREE.Group(); // hop / lean
  kartHolder.add(shadow, kartBody);
  gameScene.add(kartHolder);

  const drive = {
    pano: null, neighbors: [], neighborsReady: false,
    heading: 0, camYaw: 0, lookYaw: 0, lookPitch: 0, dragging: false,
    v: 0, steer: 0, travel: 0, travelVis: 0, target: null,
    hopY: 0, hopV: 0, fade: 0, bump: 0, lastToast: 0, time: 0,
  };
  const ready = new Map(); // pano id -> { promise, item, img }

  // Fetches a panorama + image. Sequence links also prefetch a few more shots along the same road.
  function prepare(n, ahead = 5) {
    if (ready.has(n.id)) return ready.get(n.id);
    const entry = { item: null, img: null, failed: false };
    entry.promise = Streets.getItem(n.collection, n.id)
      .then((item) => {
        if (n.rel && ahead > 0) {
          const nextLink = item.links.find((l) => l.rel === n.rel);
          if (nextLink) setTimeout(() => prepare(nextLink, ahead - 1), 0);
        }
        return Streets.loadImage(item.image).then((img) => { entry.item = item; entry.img = img; });
      })
      .catch((e) => { console.warn(e); entry.failed = true; });
    ready.set(n.id, entry);
    if (ready.size > 60) ready.delete(ready.keys().next().value);
    return entry;
  }

  function setSphere(sphere, pano, img) {
    const old = sphere.material.map;
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    sphere.material.map = tex;
    sphere.material.needsUpdate = true;
    sphere.rotation.set(0, rad(270 - pano.azimuth), 0);
    sphere.userData.pano = pano;
    sphere.visible = true;
    if (old && old !== spherePrev.material.map && old !== sphereCur.material.map) old.dispose();
  }

  async function arriveAt(pano, img, carry) {
    // Hand the current view to the fading sphere and show the new panorama.
    if (sphereCur.material.map) {
      const oldMap = spherePrev.material.map;
      spherePrev.material.map = sphereCur.material.map;
      spherePrev.material.needsUpdate = true;
      spherePrev.rotation.copy(sphereCur.rotation);
      spherePrev.userData.offset = drive.target ? fwd(drive.target.bearing).multiplyScalar(drive.travelVis) : new THREE.Vector3();
      spherePrev.visible = true;
      if (oldMap && oldMap !== spherePrev.material.map) oldMap.dispose();
      sphereCur.material.map = null;
      drive.fade = 1;
    }
    setSphere(sphereCur, pano, img);
    drive.pano = pano;
    drive.travel = carry || 0;
    drive.travelVis = 0;
    drive.target = null;
    // Sequence links are usable right away; side streets from the nearby search are merged in when they arrive.
    drive.neighbors = Streets.linkNeighbors(pano);
    drive.neighborsReady = false;
    drive.neighbors.forEach((n) => prepare(n));
    const list = await Streets.neighbors(pano);
    if (drive.pano !== pano) return;
    drive.neighbors = list;
    drive.neighborsReady = true;
    list.forEach((n) => prepare(n));
  }

  // Short sequence hops have unreliable bearings (GPS jitter), so they get a wider cone.
  const coneFor = (n) => (n.rel ? (n.dist < 3 ? 150 : n.dist < 10 ? 110 : 65) : 55);

  function pickTarget(dir) {
    let best = null, bestScore = Infinity;
    for (const n of drive.neighbors) {
      const d = angDiff(n.bearing, dir);
      if (d > coneFor(n)) continue;
      const score = d + n.dist * 0.6;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  function updateDrive(dt) {
    const d = drive;
    d.time += dt;
    const up = keys.ArrowUp || keys.KeyW, down = keys.ArrowDown || keys.KeyS;
    const left = keys.ArrowLeft || keys.KeyA, right = keys.ArrowRight || keys.KeyD;
    const mapFocused = $('minimap-wrap').classList.contains('open');

    // Speed.
    if (up && !mapFocused) d.v = Math.min(MAX_SPEED, d.v + (d.v < 0 ? 20 : 8) * dt);
    else if (down && !mapFocused) d.v = d.v > 0.3 ? d.v - 22 * dt : Math.max(-5, d.v - 6 * dt);
    else d.v -= Math.sign(d.v) * Math.min(Math.abs(d.v), 5 * dt);

    // Steering (allowed at standstill so you can look around the spot).
    const s = mapFocused ? 0 : (right ? 1 : 0) - (left ? 1 : 0);
    const turn = Math.abs(d.v) > 0.5 ? 80 : 65;
    d.heading = (d.heading + s * turn * dt * (d.v < -0.3 ? -1 : 1) + 360) % 360;
    d.steer = lerp(d.steer, s, Math.min(1, dt * 8));

    // Travel toward the neighbour panorama in the driving direction.
    const dir = d.v >= 0 ? d.heading : (d.heading + 180) % 360;
    if (d.target && angDiff(d.target.bearing, dir) > coneFor(d.target) + 20) d.target = null;
    // Steering assist: without input, gently follow the road we're heading down.
    if (d.target && !s && d.v > 1 && d.target.dist >= 4) {
      const diff = ((d.target.bearing - dir + 540) % 360) - 180;
      if (Math.abs(diff) < 60) d.heading = (d.heading + Math.sign(diff) * Math.min(Math.abs(diff), 30 * dt) + 360) % 360;
    }
    if (!d.target || d.travel < 0.5) {
      const t = pickTarget(dir);
      if (t !== d.target) { d.target = t; d.travel = 0; }
    }
    let waiting = false;
    if (Math.abs(d.v) > 0.05) {
      if (d.target) {
        d.travel += Math.abs(d.v) * dt;
        const entry = prepare(d.target);
        if (d.travel >= d.target.dist) {
          if (entry.img && entry.item) {
            const carry = Math.min(d.travel - d.target.dist, 3);
            arriveAt(entry.item, entry.img, carry);
          } else if (entry.failed) {
            d.neighbors = d.neighbors.filter((n) => n !== d.target);
            d.target = null; d.travel = 0;
          } else {
            d.travel = d.target.dist * 0.92;
            waiting = true;
          }
        }
      } else if (d.neighborsReady) {
        if (Math.abs(d.v) > 3) {
          d.bump = 1;
          if (d.time - d.lastToast > 1.5) { toast(d.neighbors.length ? 'No road that way!' : 'Dead end! Turn around'); d.lastToast = d.time; }
        }
        d.v = 0;
      } else {
        waiting = true;
      }
    }
    $('pano-loading').classList.toggle('hidden', !waiting && d.neighborsReady);
    d.travelVis = lerp(d.travelVis, d.target ? d.travel * 0.75 : 0, Math.min(1, dt * 10));

    // Hop.
    if (d.hopY > 0 || d.hopV > 0) {
      d.hopV -= 22 * dt;
      d.hopY = Math.max(0, d.hopY + d.hopV * dt);
      if (d.hopY === 0) d.hopV = 0;
    }
    d.bump = Math.max(0, d.bump - dt * 3);

    // Camera follows heading; dragging adds a look offset that eases back while driving.
    if (!d.dragging && Math.abs(d.v) > 1) { d.lookYaw = lerp(d.lookYaw, 0, Math.min(1, dt * 2)); d.lookPitch = lerp(d.lookPitch, 0, Math.min(1, dt * 2)); }
    const camDelta = ((d.heading - d.camYaw + 540) % 360) - 180;
    d.camYaw = (d.camYaw + camDelta * Math.min(1, dt * 6) + 360) % 360;
    const yaw = d.camYaw + d.lookYaw;
    const f = fwd(yaw);
    const camPos = f.clone().multiplyScalar(-2.7).add(new THREE.Vector3(0, 1.25, 0));
    gameCam.position.copy(camPos);
    const look = f.clone().multiplyScalar(3).add(new THREE.Vector3(0, 0.6 + d.lookPitch * 0.06, 0));
    gameCam.lookAt(look);
    gameCam.fov = lerp(gameCam.fov, 70 + Math.abs(d.v) * 0.6, Math.min(1, dt * 4));
    gameCam.updateProjectionMatrix();

    // Spheres: eye at centre, shifted backwards as we travel to fake forward motion.
    const travelOff = d.target ? fwd(d.target.bearing).multiplyScalar(d.travelVis) : new THREE.Vector3();
    sphereCur.position.copy(camPos).sub(travelOff);
    if (spherePrev.visible) {
      d.fade = Math.max(0, d.fade - dt * 3.5);
      spherePrev.material.opacity = d.fade;
      const off = (spherePrev.userData.offset || new THREE.Vector3()).clone().multiplyScalar(1 + (1 - d.fade) * 0.6);
      spherePrev.position.copy(camPos).sub(off);
      if (d.fade <= 0) spherePrev.visible = false;
    }
    sphereCur.material.opacity = 1;

    // Kart.
    kartHolder.rotation.y = Math.PI - rad(d.heading) - d.steer * 0.25;
    const bob = Math.sin(d.time * 26) * 0.012 * Math.min(1, Math.abs(d.v) / 4);
    kartBody.position.y = d.hopY + bob + Math.sin(d.bump * Math.PI) * 0.08;
    kartBody.rotation.z = -d.steer * 0.06 * Math.min(1, Math.abs(d.v) / 6);
    kartBody.rotation.x = -d.bump * 0.15;
    shadow.scale.setScalar(1 - d.hopY * 0.3);
    const kart = kartBody.children[0];
    if (kart) {
      for (const w of kart.userData.wheels) {
        w.wheel.rotation.x += d.v * dt * 3.5;
        if (w.front) w.pivot.rotation.y = -d.steer * 0.35;
      }
    }

    // HUD.
    $('speed').textContent = Math.round(Math.abs(d.v) * 3.6);
    $('compass-strip').style.transform = 'translateX(' + -(((yaw % 360) + 360) / 15 * 30 + 15) + 'px)';
    updateEngine(Math.abs(d.v));
  }

  // Compass labels.
  {
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let a = 0; a < 1080; a += 15) {
      const n = names[a % 360];
      html += n ? '<span class="card' + (n === 'N' ? ' n' : '') + '">' + n + '</span>' : '<span>·</span>';
    }
    $('compass-strip').innerHTML = html;
  }

  // Look around by dragging.
  canvas.addEventListener('pointerdown', (e) => {
    if (state.screen !== 'game') return;
    drive.dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drive.dragging) return;
    drive.lookYaw -= e.movementX * 0.25;
    drive.lookPitch = Math.max(-10, Math.min(10, drive.lookPitch - e.movementY * 0.08));
  });
  const endDrag = () => { drive.dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---------- engine sound ----------
  let audio = null;
  function initAudio() {
    if (audio) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      osc.type = 'sawtooth'; osc2.type = 'square';
      filter.type = 'lowpass'; filter.frequency.value = 600;
      gain.gain.value = 0;
      osc.connect(filter); osc2.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc2.start();
      audio = { ctx, osc, osc2, gain, filter };
    } catch (e) { audio = null; }
  }
  function updateEngine(v) {
    if (!audio) return;
    const on = state.screen === 'game' && !state.muted && !document.hidden;
    const t = audio.ctx.currentTime;
    audio.osc.frequency.setTargetAtTime(48 + v * 7, t, 0.08);
    audio.osc2.frequency.setTargetAtTime(24 + v * 3.5, t, 0.08);
    audio.filter.frequency.setTargetAtTime(500 + v * 80, t, 0.1);
    audio.gain.gain.setTargetAtTime(on ? 0.035 + v * 0.002 : 0, t, 0.1);
  }

  // ---------- maps ----------
  const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileOpts = { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' };
  const pinIcon = (cls) => L.divIcon({ className: '', html: '<div class="pin ' + cls + '"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  let minimap = null, guessMarker = null, resultMap = null;
  function ensureMinimap() {
    if (minimap) return;
    minimap = L.map('minimap', { worldCopyJump: true, zoomControl: false, attributionControl: true }).setView([25, 10], 1);
    L.tileLayer(tileUrl, tileOpts).addTo(minimap);
    minimap.on('click', (e) => {
      if (guessMarker) guessMarker.setLatLng(e.latlng);
      else guessMarker = L.marker(e.latlng, { icon: pinIcon('guess') }).addTo(minimap);
      $('guess').disabled = false;
      $('guess').textContent = 'Guess!';
    });
    const wrap = $('minimap-wrap');
    wrap.addEventListener('transitionend', () => minimap.invalidateSize());
    wrap.addEventListener('mouseenter', () => setTimeout(() => minimap.invalidateSize(), 220));
  }
  function toggleMap(open) {
    const wrap = $('minimap-wrap');
    wrap.classList.toggle('open', open === undefined ? !wrap.classList.contains('open') : open);
    setTimeout(() => minimap && minimap.invalidateSize(), 220);
    setTimeout(() => minimap && minimap.invalidateSize(), 500);
  }
  $('guess').onclick = () => submitGuess();

  // ---------- rounds ----------
  function startGame() {
    initAudio();
    state.round = 0;
    state.total = 0;
    state.results = [];
    kartBody.clear();
    kartBody.add(currentKart());
    resetKartPose(currentKart());
    nextRound();
  }

  async function nextRound() {
    state.round++;
    state.screen = 'loading';
    ['menu', 'hud', 'result', 'final'].forEach(hide);
    setLoading('Finding somewhere to drive…');
    let pano = null, img = null;
    for (let tries = 0; tries < 6 && !img; tries++) {
      try {
        pano = await Streets.randomLocation((n, region) => setLoading('Scouting ' + region + '…'));
        img = await Streets.loadImage(pano.image);
      } catch (e) {
        console.warn(e);
        img = null;
        if (tries === 5) { setLoading('Could not load street imagery: ' + e.message); return; }
      }
    }
    const d = drive;
    Object.assign(d, { v: 0, steer: 0, travel: 0, travelVis: 0, target: null, lookYaw: 0, lookPitch: 0, hopY: 0, hopV: 0, fade: 0, bump: 0 });
    spherePrev.visible = false;
    sphereCur.material.map = null;
    d.heading = pano.links.length ? Streets.bearing(pano, pano.links.find((l) => l.rel === 'next') || pano.links[0]) : pano.azimuth;
    d.camYaw = d.heading;
    d.start = pano;
    await arriveAt(pano, img, 0);

    ensureMinimap();
    if (guessMarker) { guessMarker.remove(); guessMarker = null; }
    $('guess').disabled = true;
    $('guess').textContent = 'Place a pin';
    $('round').textContent = 'Round ' + state.round + ' / ' + ROUNDS;
    $('score').textContent = state.total.toLocaleString() + ' pts';
    hide('loading');
    show('hud');
    toggleMap(false);
    minimap.setView([25, 10], 1);
    setTimeout(() => minimap.invalidateSize(), 50);
    state.screen = 'game';
    toast('GO!');
  }

  const scoreFor = (km) => Math.round(5000 * Math.exp(-km / 1500));

  async function submitGuess() {
    if (!guessMarker || state.screen !== 'game') return;
    state.screen = 'result';
    const g = guessMarker.getLatLng();
    const here = drive.pano;
    const km = Streets.distance({ lat: g.lat, lon: g.lng }, here) / 1000;
    const pts = scoreFor(km);
    state.total += pts;
    const entry = { km, pts, place: '' };
    state.results.push(entry);

    hide('hud');
    show('result');
    if (!resultMap) {
      resultMap = L.map('result-map', { worldCopyJump: true, zoomControl: false });
      L.tileLayer(tileUrl, tileOpts).addTo(resultMap);
    }
    resultMap.eachLayer((l) => { if (!(l instanceof L.TileLayer)) l.remove(); });
    resultMap.invalidateSize();
    const real = [here.lat, here.lon];
    L.marker([g.lat, g.lng], { icon: pinIcon('guess') }).addTo(resultMap);
    L.marker(real, { icon: pinIcon('real') }).addTo(resultMap);
    L.polyline([[g.lat, g.lng], real], { color: '#1b1530', weight: 3, dashArray: '8 8' }).addTo(resultMap);
    resultMap.fitBounds(L.latLngBounds([[g.lat, g.lng], real]), { maxZoom: 13, paddingTopLeft: [60, 60], paddingBottomRight: [60, 320] });

    $('result-dist').textContent = km < 1 ? Math.round(km * 1000) + ' m away' : Math.round(km).toLocaleString() + ' km away';
    $('result-points').textContent = '+' + pts.toLocaleString() + ' pts';
    $('result-bar').style.width = '0';
    setTimeout(() => { $('result-bar').style.width = (pts / 50) + '%'; }, 60);
    $('next').textContent = state.round >= ROUNDS ? 'See results' : 'Next round';
    $('result-place').textContent = '';
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=en&lat=' + here.lat + '&lon=' + here.lon);
      const j = await r.json();
      const a = j.address || {};
      entry.place = [a.city || a.town || a.village || a.county || a.state, a.country].filter(Boolean).join(', ');
    } catch (e) { entry.place = ''; }
    if (state.screen === 'result') $('result-place').textContent = entry.place ? 'You were in ' + entry.place : '';
  }

  $('next').onclick = () => {
    if (state.round >= ROUNDS) showFinal();
    else nextRound();
  };

  function showFinal() {
    state.screen = 'final';
    hide('result');
    show('final');
    $('final-score').textContent = state.total.toLocaleString() + ' pts';
    $('final-list').innerHTML = state.results.map((r) =>
      '<li>' + (r.place || 'Somewhere') + ' — ' + (r.km < 1 ? Math.round(r.km * 1000) + ' m' : Math.round(r.km).toLocaleString() + ' km') + ' · ' + r.pts.toLocaleString() + '</li>').join('');
  }
  $('again').onclick = () => enterMenu();

  // ---------- input ----------
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    initAudio();
    if (audio && audio.ctx.state === 'suspended') audio.ctx.resume();
    if (state.screen === 'menu') {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') changeChar(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') changeChar(1);
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') changeKart(-1);
      else if (e.code === 'ArrowDown' || e.code === 'KeyS') changeKart(1);
      else if (e.code === 'Enter' || e.code === 'Space') startGame();
    } else if (state.screen === 'game') {
      if (e.code === 'Space' && drive.hopY === 0) { drive.hopV = 4.5; e.preventDefault(); }
      else if (e.code === 'KeyM') toggleMap();
      else if (e.code === 'KeyN') { state.muted = !state.muted; toast(state.muted ? 'Sound off' : 'Sound on'); }
      else if (e.code === 'Enter' && guessMarker) submitGuess();
      if (e.code.startsWith('Arrow')) e.preventDefault();
    } else if (state.screen === 'result' && (e.code === 'Enter' || e.code === 'Space')) {
      $('next').click();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.screen === 'menu') {
      turntable.rotation.y += dt * 0.6;
      const narrow = window.innerWidth < window.innerHeight;
      menuCam.position.set(0, 1.9, narrow ? 10 : 7.4);
      menuCam.lookAt(0, 0.3, 0);
      renderer.render(menuScene, menuCam);
    } else if (state.screen === 'game' || (state.screen === 'loading' && drive.pano)) {
      if (state.screen === 'game') updateDrive(dt);
      renderer.autoClear = false;
      renderer.clear();
      renderer.render(panoScene, gameCam);
      renderer.clearDepth();
      renderer.render(gameScene, gameCam);
      renderer.autoClear = true;
    }
    requestAnimationFrame(frame);
  }

  // ---------- boot ----------
  async function boot() {
    resize();
    requestAnimationFrame(frame);
    try {
      setLoading('Reading cartridge…');
      const buf = await RomLoader.load((onFile) => {
        hide('loading');
        show('rompick');
        const pick = (file) => {
          if (!file) return;
          hide('rompick');
          setLoading('Reading cartridge…');
          onFile(file);
        };
        $('rom-input').onchange = (e) => pick(e.target.files[0]);
        const zone = $('rompick');
        zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag'); };
        zone.ondragleave = () => zone.classList.remove('drag');
        zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('drag'); pick(e.dataTransfer.files[0]); };
      });
      setLoading('Building karts…');
      await nextFrame();
      factory = new KartFactory(buf);
      enterMenu();
    } catch (e) {
      console.error(e);
      setLoading('Something went wrong: ' + e.message);
    }
  }
  boot();

  // Exposed for debugging in the console.
  window.KartGeo = { state, drive, keys, startGame, submitGuess, renderer };
})();
