// Gets the Mario Kart DS ROM into the page: from the project folder, the browser cache, or a file the player picks.
(function (global) {
  'use strict';

  const ROM_DIR = 'Mario Kart DS (USA, Australia) (En,Fr,De,Es,It)';
  const ROM_URL = encodeURIComponent(ROM_DIR) + '/' + encodeURIComponent(ROM_DIR + '.nds');
  const DB = 'kart-geoguesser', STORE = 'rom';

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function cacheGet() {
    try {
      const db = await idb();
      return await new Promise((resolve) => {
        const r = db.transaction(STORE).objectStore(STORE).get('rom');
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }
  async function cachePut(buf) {
    try {
      const db = await idb();
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(buf, 'rom');
    } catch (e) { /* caching is optional */ }
  }

  async function fromFolder() {
    if (location.protocol === 'file:') return null;
    try {
      const r = await fetch(ROM_URL);
      if (!r.ok) return null;
      return await r.arrayBuffer();
    } catch (e) { return null; }
  }

  // Resolves with an ArrayBuffer. `askUser(onFile)` is called when the ROM has to be picked by hand.
  async function load(askUser) {
    const local = await fromFolder();
    if (local) return local;
    const cached = await cacheGet();
    if (cached) return cached;
    const buf = await new Promise((resolve) => askUser((file) => file.arrayBuffer().then(resolve)));
    cachePut(buf);
    return buf;
  }

  global.RomLoader = { load };
})(window);
