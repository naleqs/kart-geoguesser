// Street-level 360° imagery from Panoramax (open, keyless, CORS-enabled).
(function (global) {
  'use strict';

  const API = 'https://api.panoramax.xyz/api';
  const FILTER = 'filter=' + encodeURIComponent('field_of_view=360');

  // Capital cities with linked 360° Panoramax coverage (checked October 2026).
  const CAPITALS = [
    ['Paris', 'France', 48.8566, 2.3522], ['Berlin', 'Germany', 52.52, 13.405], ['Madrid', 'Spain', 40.4168, -3.7038],
    ['Lisbon', 'Portugal', 38.7223, -9.1393], ['London', 'United Kingdom', 51.5074, -0.1278], ['Dublin', 'Ireland', 53.3498, -6.2603],
    ['Brussels', 'Belgium', 50.8503, 4.3517], ['Amsterdam', 'Netherlands', 52.3676, 4.9041], ['Luxembourg', 'Luxembourg', 49.6116, 6.1319],
    ['Vienna', 'Austria', 48.2082, 16.3738], ['Prague', 'Czechia', 50.0755, 14.4378], ['Bratislava', 'Slovakia', 48.1486, 17.1077],
    ['Budapest', 'Hungary', 47.4979, 19.0402], ['Zagreb', 'Croatia', 45.815, 15.9819], ['Belgrade', 'Serbia', 44.7866, 20.4489],
    ['Podgorica', 'Montenegro', 42.4304, 19.2594], ['Kyiv', 'Ukraine', 50.4501, 30.5234], ['Helsinki', 'Finland', 60.1699, 24.9384],
    ['Stockholm', 'Sweden', 59.3293, 18.0686], ['Oslo', 'Norway', 59.9139, 10.7522], ['Copenhagen', 'Denmark', 55.6761, 12.5683],
    ['Andorra la Vella', 'Andorra', 42.5063, 1.5218], ['Monaco', 'Monaco', 43.7384, 7.4246], ['Tokyo', 'Japan', 35.6762, 139.6503],
    ['Taipei', 'Taiwan', 25.033, 121.5654], ['Kathmandu', 'Nepal', 27.7172, 85.324], ['Wellington', 'New Zealand', -41.2865, 174.7762],
    ['Buenos Aires', 'Argentina', -34.6037, -58.3816], ['Brasília', 'Brazil', -15.7975, -47.8919],
  ].map(([name, country, lat, lon]) => ({ name, country, lat, lon }));

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

  // Finds a random 360° panorama in or around a capital city. `exclude` holds capital names already used this game.
  async function randomLocation(onAttempt, exclude = []) {
    for (let attempt = 0; attempt < 14; attempt++) {
      let pool = CAPITALS.filter((c) => !exclude.includes(c.name));
      if (!pool.length) pool = CAPITALS;
      const cap = pool[Math.floor(Math.random() * pool.length)];
      // Start somewhere around town rather than always at the exact centre.
      const lat = cap.lat + (Math.random() - 0.5) * 0.06, lon = cap.lon + (Math.random() - 0.5) * 0.08;
      if (onAttempt) onAttempt(attempt, cap);
      for (const half of [0.02, 0.06, 0.15, 0.3]) {
        const box = [lon - half, lat - half, lon + half, lat + half];
        let res;
        try { res = await search(box, 40); } catch (err) { console.warn(err); continue; }
        const good = res.filter((p) => p.image && p.links.length);
        if (good.length) {
          const pick = good[Math.floor(Math.random() * good.length)];
          itemCache.set(pick.collection + '/' + pick.id, Promise.resolve(pick));
          pick.capital = cap;
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

  global.Streets = { randomLocation, getItem, neighbors, linkNeighbors, loadImage, distance, bearing, CAPITALS };
})(typeof window !== 'undefined' ? window : globalThis);
