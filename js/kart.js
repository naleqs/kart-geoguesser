// Builds Three.js kart + driver models straight out of the user's Mario Kart DS ROM.
(function (global) {
  'use strict';

  // Character order used by kartoffsetdata.bin seat offsets.
  const CHARACTERS = [
    { id: 'MR', dir: 'mario', name: 'Mario' },
    { id: 'DK', dir: 'donkey', name: 'Donkey Kong' },
    { id: 'KO', dir: 'kinopio', name: 'Toad' },
    { id: 'KP', dir: 'koopa', name: 'Bowser' },
    { id: 'PC', dir: 'peach', name: 'Peach' },
    { id: 'WR', dir: 'wario', name: 'Wario' },
    { id: 'YS', dir: 'yoshi', name: 'Yoshi' },
    { id: 'LG', dir: 'luigi', name: 'Luigi' },
    { id: 'DS', dir: 'daisy', name: 'Daisy' },
    { id: 'KA', dir: 'karon', name: 'Dry Bones' },
    { id: 'WL', dir: 'waluigi', name: 'Waluigi' },
    { id: 'RB', dir: 'robo', name: 'R.O.B.' },
    { id: 'HH', dir: 'heyho', name: 'Shy Guy' },
  ];

  // kartoffsetdata.bin holds three karts per character (standard, b, c) in CHARACTERS order.
  const KART_ORDER = CHARACTERS.flatMap((c) => ['a', 'b', 'c'].map((l) => 'kart_' + c.id + '_' + l));

  class KartFactory {
    constructor(romBuffer) {
      this.rom = NDS.parseRom(romBuffer);
      if (this.rom.code.slice(0, 3) !== 'AMC') throw new Error('This does not look like a Mario Kart DS ROM (game code ' + this.rom.code + ')');
      this.files = new Map();
      for (const [k, v] of this.rom.files) this.files.set(k, v);
      for (const arc of ['data/KartModelSub.carc', 'data/KartModelMain.carc', 'data/KartModelMenu.carc']) {
        const f = this.rom.files.get(arc);
        if (!f) continue;
        for (const [k, v] of NDS.parseNARC(f)) if (!this.files.has('arc/' + k)) this.files.set('arc/' + k, v);
      }
      this.offsets = this._parseOffsets(this.file('kartoffsetdata.bin'));
      this.texCache = new Map();
    }

    // Find a file by trailing path, preferring the menu folder (full-detail models).
    file(suffix) {
      const pref = ['data/KartModelMenu/' + suffix, 'arc/' + suffix];
      for (const p of pref) if (this.files.has(p)) return this.files.get(p);
      for (const [k, v] of this.files) if (k.endsWith('/' + suffix)) return v;
      return null;
    }

    _parseOffsets(u8) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const out = [];
      const v3 = (o) => [dv.getInt32(o, true) / 4096, dv.getInt32(o + 4, true) / 4096, dv.getInt32(o + 8, true) / 4096];
      for (let off = 0; off + 224 <= u8.length; off += 224) {
        let name = '';
        for (let i = 0; i < 16 && u8[off + i]; i++) name += String.fromCharCode(u8[off + i]);
        const tires = [0, 1, 2, 3].map((i) => v3(off + 0x14 + i * 12));
        const seats = CHARACTERS.map((c, i) => v3(off + 0x44 + i * 12));
        out.push({ tire: name, tireScale: dv.getInt32(off + 0x10, true) / 4096, tires, seats });
      }
      return out;
    }

    // Shy Guy only ships as a palette swap of another model, so he isn't offered.
    characters() { return CHARACTERS.filter((c) => c.id !== 'HH'); }

    // Index of a kart in kartoffsetdata.bin.
    kartIndex(name) {
      return KART_ORDER.indexOf(name);
    }

    kartsFor(charId) {
      return ['a', 'b', 'c'].map((l) => 'kart_' + charId + '_' + l).filter((n) => this.file(this._kartPath(n)));
    }

    _kartPath(name) {
      if (name.endsWith('_a')) name = 'kart_MR_a'; // every standard kart shares one body
      const c = CHARACTERS.find((ch) => ch.id === name.split('_')[1]);
      return 'kart/' + (c ? c.dir : '') + '/' + name + '.nsbmd';
    }

    // Build a THREE.Group from an nsbmd (+ optional nsbtx) pair.
    // opts.overrideTex: nsbtx paths searched before the model's own textures.
    // opts.palette: { name, colors: Uint8Array of RGB555 } replacing a palette in texPath.
    buildModel(mdlPath, texPath, posePath, opts = {}) {
      const mdl = this.file(mdlPath);
      if (!mdl) throw new Error('Missing ' + mdlPath);
      const parsed = Nitro.parseNSBMD(mdl);
      const anim = posePath && this.file(posePath);
      if (anim) {
        try { Nitro.applyPose(parsed.models[0], Nitro.parseNSBCAFrame(anim, 0)); } catch (e) { console.warn('Pose failed', e); }
      }
      const texSets = [];
      for (const p of opts.overrideTex || []) { const f = this.file(p); if (f) texSets.push(Nitro.parseNSBTX(f)); }
      texSets.push(parsed.tex0);
      let tx = texPath && this.file(texPath);
      if (tx) {
        if (opts.palette) {
          tx = tx.slice();
          const t0 = Nitro.parseNSBTX(tx);
          const pal = t0.palettes.find((q) => q.name === opts.palette.name);
          if (pal) tx.set(opts.palette.colors, t0.palData + pal.offset);
        }
        texSets.push(Nitro.parseNSBTX(tx));
      }
      const group = new THREE.Group();
      const cache = new Map();
      for (const model of parsed.models) {
        const meshes = Nitro.buildMesh(model, (m) => {
          const t = Nitro.resolveTexture(texSets, m, cache);
          return t ? [t.width, t.height] : null;
        });
        for (const { material: m, tris } of meshes) {
          if (!tris.length) continue;
          const n = tris.length;
          const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
          tris.forEach((v, i) => { pos.set(v.pos, i * 3); uv.set(v.uv, i * 2); col.set(v.col, i * 3); });
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
          geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
          const img = Nitro.resolveTexture(texSets, m, cache);
          const matOpts = { vertexColors: true, transparent: m.alpha < 1, opacity: m.alpha, alphaTest: 0.4 };
          if (img) {
            const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
            const wrap = (rep, flip) => (rep ? (flip ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping) : THREE.ClampToEdgeWrapping);
            tex.wrapS = wrap(m.repeatS, m.flipS);
            tex.wrapT = wrap(m.repeatT, m.flipT);
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            matOpts.map = tex;
          }
          const front = m.cull & 2, back = m.cull & 1;
          matOpts.side = front && back ? THREE.DoubleSide : back ? THREE.BackSide : THREE.FrontSide;
          if (!front && !back) continue; // invisible material
          const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial(matOpts));
          mesh.name = m.name;
          group.add(mesh);
        }
      }
      return group;
    }

    // Complete kart: body + four tires + driver, facing +Z, ground at y=0, ~1 unit long.
    buildKart(charId, kartName) {
      const char = CHARACTERS.find((c) => c.id === charId) || CHARACTERS[0];
      kartName = kartName || this.kartsFor(char.id)[0] || 'kart_MR_a';
      const off = this.offsets[this.kartIndex(kartName)] || this.offsets[0];
      const root = new THREE.Group();
      const opts = {};
      if (kartName.endsWith('_a')) {
        // Standard kart: recolour with this character's slot of kart_a.NCLR and use their emblem.
        const nclr = this.file('kart/palette/kart_a.NCLR');
        const slot = CHARACTERS.indexOf(char);
        if (nclr) opts.palette = { name: 'kart_MR_a_pl', colors: nclr.subarray(0x28 + slot * 32, 0x28 + slot * 32 + 32) };
        opts.overrideTex = ['emblem/' + char.id + '_emblem.nsbtx'];
      }
      const body = this.buildModel(this._kartPath(kartName), this._kartPath(kartName).replace('.nsbmd', '.nsbtx'), null, opts);
      root.add(body);

      const tireTemplate = this.buildModel('kart/tire/' + off.tire + '.nsbmd', 'kart/tire/' + off.tire + '.nsbtx');
      tireTemplate.scale.setScalar(off.tireScale);
      const wheels = [];
      off.tires.forEach((t, i) => {
        const w = tireTemplate.clone();
        if (t[0] < 0) w.scale.x = -1; // mirror for the opposite side
        const pivot = new THREE.Group(); // steers around y
        pivot.position.set(t[0] / 16, t[1] / 16, t[2] / 16);
        pivot.add(w); // spins around x
        root.add(pivot);
        wheels.push({ pivot, wheel: w, front: i < 2 });
      });

      let driver = null;
      try {
        const base = 'character/' + char.dir + '/P_' + char.id;
        driver = this.buildModel(base + '.nsbmd', base + '.nsbtx', base + '_drive.nsbca');
        const seat = off.seats[CHARACTERS.indexOf(char)] || [0, 0, 0];
        driver.position.set(seat[0], seat[1], seat[2]);
        root.add(driver);
      } catch (e) {
        console.warn('Driver model failed', e);
      }

      // Normalise: centre on x/z, rest on the ground, scale to unit length.
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const s = 1 / Math.max(size.z, size.x, 1e-6);
      const wrapper = new THREE.Group();
      root.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      wrapper.add(root);
      wrapper.scale.setScalar(s);
      const outer = new THREE.Group();
      outer.add(wrapper);
      outer.userData = { wheels, driver, body, kartName, character: char };
      return outer;
    }
  }

  global.KartFactory = KartFactory;
  global.KART_CHARACTERS = CHARACTERS;
})(typeof window !== 'undefined' ? window : globalThis);
