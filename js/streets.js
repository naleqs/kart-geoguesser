// Street-level 360° imagery from Panoramax (open, keyless, CORS-enabled).
(function (global) {
  'use strict';

  const API = 'https://api.panoramax.xyz/api';
  const FILTER = 'filter=' + encodeURIComponent('field_of_view=360');

  // Regions with known 360° coverage. bbox = [west, south, east, north].
  const REGIONS = [
    { name: 'France', bbox: [-4.8, 42.4, 8.2, 51.1], w: 4 },
    { name: 'Germany', bbox: [5.9, 47.3, 15.0, 55.0], w: 3 },
    { name: 'Iberia', bbox: [-9.5, 36.0, 3.3, 43.8], w: 2 },
    { name: 'Italy', bbox: [6.6, 36.6, 18.5, 47.0], w: 2 },
    { name: 'Britain', bbox: [-8.0, 50.0, 1.8, 58.6], w: 1.5 },
    { name: 'Benelux', bbox: [2.5, 49.5, 7.2, 53.5], w: 1.5 },
    { name: 'Central Europe', bbox: [12.0, 45.8, 24.0, 55.0], w: 2 },
    { name: 'Nordics', bbox: [5.0, 55.0, 31.0, 70.0], w: 1.5 },
    { name: 'Japan', bbox: [129.0, 31.0, 146.0, 45.0], w: 2 },
    { name: 'Brazil', bbox: [-74.0, -34.0, -35.0, 5.0], w: 1.5 },
    { name: 'Australia', bbox: [112.0, -44.0, 154.0, -10.0], w: 1.5 },
    { name: 'Levant', bbox: [34.0, 29.0, 36.0, 33.4], w: 0.7 },
  ];

  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  function distance(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.json();
  }

  function normalize(f) {
    const p = f.properties || {};
    const links = (f.links || [])
      .filter((l) => (l.rel === 'next' || l.rel === 'prev') && l.geometry && l.id)
      .map((l) => ({ id: l.id, collection: f.collection, lon: l.geometry.coordinates[0], lat: l.geometry.coordinates[1], rel: l.rel }));
    return {
      id: f.id,
      collection: f.collection,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      azimuth: +p['view:azimuth'] || 0,
      pitch: +p['pers:pitch'] || 0,
      roll: +p['pers:roll'] || 0,
      date: p.datetime || '',
      image: (f.assets && (f.assets.sd || f.assets.hd || {}).href) || p['geovisio:image'],
      links,
    };
  }

  const itemCache = new Map();
  async function getItem(collection, id) {
    const key = collection + '/' + id;
    if (!itemCache.has(key)) {
      itemCache.set(key, getJSON(API + '/collections/' + collection + '/items/' + id).then(normalize).catch((e) => { itemCache.delete(key); throw e; }));
    }
    return itemCache.get(key);
  }

  async function search(bbox, limit) {
    const b = bbox.map((v) => v.toFixed(6)).join(',');
    const j = await getJSON(API + '/search?bbox=' + b + '&limit=' + limit + '&' + FILTER);
    return (j.features || []).filter((f) => f.geometry && f.assets).map(normalize);
  }

  function pickRegion() {
    const total = REGIONS.reduce((s, r) => s + r.w, 0);
    let x = Math.random() * total;
    for (const r of REGIONS) { x -= r.w; if (x <= 0) return r; }
    return REGIONS[0];
  }

  // Finds a random 360° panorama somewhere in the covered regions.
  async function randomLocation(onAttempt) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const reg = pickRegion();
      const [w, s, e, n] = reg.bbox;
      const lon = w + Math.random() * (e - w), lat = s + Math.random() * (n - s);
      if (onAttempt) onAttempt(attempt, reg.name);
      for (const half of [0.15, 0.8, 3]) {
        const box = [Math.max(w, lon - half), Math.max(s, lat - half), Math.min(e, lon + half), Math.min(n, lat + half)];
        let res;
        try { res = await search(box, 40); } catch (err) { console.warn(err); continue; }
        const good = res.filter((p) => p.image && p.links.length);
        if (good.length) {
          const pick = good[Math.floor(Math.random() * good.length)];
          itemCache.set(pick.collection + '/' + pick.id, Promise.resolve(pick));
          return pick;
        }
      }
    }
    throw new Error('Could not find any street imagery. Check your internet connection.');
  }

  function candidateAdder(pano, out) {
    return (c) => {
      if (c.id === pano.id || out.has(c.id)) return;
      const d = distance(pano, c);
      // Sequence links are kept even when GPS puts them almost on top of us; they carry the road onward.
      if (d < (c.rel ? 0.05 : 0.8) || d > (c.rel ? 80 : 45)) return;
      out.set(c.id, { id: c.id, collection: c.collection, lat: c.lat, lon: c.lon, dist: Math.max(d, 1), bearing: bearing(pano, c), rel: c.rel });
    };
  }

  // Sequence neighbours only; available instantly from the panorama itself.
  function linkNeighbors(pano) {
    const out = new Map();
    pano.links.forEach(candidateAdder(pano, out));
    return [...out.values()];
  }

  // Places you can drive to from `pano`: its sequence neighbours plus nearby shots from other sequences.
  async function neighbors(pano) {
    const out = new Map();
    const add = candidateAdder(pano, out);
    pano.links.forEach(add);
    try {
      const dLat = 0.00022, dLon = 0.00022 / Math.max(0.2, Math.cos(rad(pano.lat)));
      const near = await search([pano.lon - dLon, pano.lat - dLat, pano.lon + dLon, pano.lat + dLat], 30);
      for (const p of near) {
        if (p.collection === pano.collection) continue; // sequence neighbours are already covered by links
        itemCache.set(p.collection + '/' + p.id, Promise.resolve(p));
        add(p);
      }
    } catch (e) { console.warn('Nearby search failed', e); }
    // Keep only the closest option per ~35° sector so turns are meaningful.
    const list = [...out.values()].sort((a, b) => a.dist - b.dist);
    const kept = list.filter((c) => c.rel);
    for (const c of list) {
      if (c.rel) continue;
      if (!kept.some((k) => Math.abs(((c.bearing - k.bearing + 540) % 360) - 180) < 35)) kept.push(c);
    }
    return kept;
  }

  const texCache = new Map();
  function loadImage(url) {
    if (texCache.has(url)) return texCache.get(url);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed: ' + url));
      img.src = url;
    });
    p.catch(() => texCache.delete(url));
    texCache.set(url, p);
    if (texCache.size > 40) texCache.delete(texCache.keys().next().value);
    return p;
  }

  global.Streets = { randomLocation, getItem, neighbors, linkNeighbors, loadImage, distance, bearing, REGIONS };
})(typeof window !== 'undefined' ? window : globalThis);
