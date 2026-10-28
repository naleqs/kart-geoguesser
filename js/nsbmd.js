// Nitro (NDS) NSBMD model + NSBTX texture decoder.
// Produces plain mesh data (per-material triangle lists with positions, uvs, colors)
// and RGBA texture images, ready to hand to a renderer.
(function (global) {
  'use strict';

  const fx32 = (v) => v / 4096;
  const str = (u8, off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = u8[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  // ---------- 4x3 matrix helpers (column vectors, stored as 12 floats row-major: [r0 c0..c3, r1.., r2..]) ----------
  const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  function mul(a, b) {
    const o = new Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        let v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
        if (c === 3) v += a[r * 4 + 3];
        o[r * 4 + c] = v;
      }
    }
    return o;
  }
  const xform = (m, x, y, z) => [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
  const scaleM = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0];

  // ---------- Nitro dictionary ----------
  function readDict(dv, u8, off) {
    const count = u8[off + 1];
    // Skip the patricia tree; the data section starts at off + (u16 at off+6).
    const dataOff = off + dv.getUint16(off + 6, true);
    const unit = dv.getUint16(dataOff, true);
    const entries = [];
    const namesOff = dataOff + 4 + unit * count;
    for (let i = 0; i < count; i++) {
      entries.push({ name: str(u8, namesOff + i * 16, 16), off: dataOff + 4 + i * unit });
    }
    return entries;
  }

  function blocks(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint16(0x0e, true);
    const out = {};
    for (let i = 0; i < n; i++) {
      const off = dv.getUint32(0x10 + i * 4, true);
      out[str(u8, off, 4)] = off;
    }
    return { dv, out };
  }

  // ---------- Textures (TEX0) ----------
  function rgb555(c) {
    return [((c & 31) * 255 / 31) | 0, (((c >> 5) & 31) * 255 / 31) | 0, (((c >> 10) & 31) * 255 / 31) | 0];
  }

  function parseTEX0(u8, base) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const texInfo = base + dv.getUint16(base + 0x0e, true);
    const texData = base + dv.getUint32(base + 0x14, true);
    const cmpData = base + dv.getUint32(base + 0x24, true);
    const cmpInfo = base + dv.getUint32(base + 0x28, true);
    const palInfo = base + dv.getUint32(base + 0x34, true);
    const palData = base + dv.getUint32(base + 0x38, true);
    const textures = readDict(dv, u8, texInfo).map((e) => {
      const p = dv.getUint32(e.off, true);
      return {
        name: e.name,
        offset: (p & 0xffff) << 3,
        width: 8 << ((p >> 20) & 7),
        height: 8 << ((p >> 23) & 7),
        format: (p >> 26) & 7,
        color0Transparent: !!((p >> 29) & 1),
      };
    });
    const palettes = readDict(dv, u8, palInfo).map((e) => ({ name: e.name, offset: dv.getUint16(e.off, true) << 3 }));
    return { u8, dv, texData, cmpData, cmpInfo, palData, textures, palettes };
  }

  // Decode a texture with a palette into RGBA.
  function decodeTexture(tex0, tex, pal) {
    const { u8, dv } = tex0;
    const w = tex.width, h = tex.height;
    const out = new Uint8ClampedArray(w * h * 4);
    const palBase = tex0.palData + (pal ? pal.offset : 0);
    const color = (i) => rgb555(dv.getUint16(palBase + i * 2, true));
    const put = (i, c, a) => { out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = a; };
    const src = tex0.texData + tex.offset;
    const n = w * h;
    switch (tex.format) {
      case 1: // A3I5
        for (let i = 0; i < n; i++) { const b = u8[src + i]; const a = b >> 5; put(i, color(b & 31), ((a * 4 + (a >> 1)) * 255 / 31) | 0); }
        break;
      case 2: // 4-colour
        for (let i = 0; i < n; i++) { const idx = (u8[src + (i >> 2)] >> ((i & 3) * 2)) & 3; put(i, color(idx), idx === 0 && tex.color0Transparent ? 0 : 255); }
        break;
      case 3: // 16-colour
        for (let i = 0; i < n; i++) { const idx = (u8[src + (i >> 1)] >> ((i & 1) * 4)) & 15; put(i, color(idx), idx === 0 && tex.color0Transparent ? 0 : 255); }
        break;
      case 4: // 256-colour
        for (let i = 0; i < n; i++) { const idx = u8[src + i]; put(i, color(idx), idx === 0 && tex.color0Transparent ? 0 : 255); }
        break;
      case 5: { // 4x4 compressed
        const blk = tex0.cmpData + tex.offset;
        const info = tex0.cmpInfo + (tex.offset >> 1);
        const bw = w >> 2;
        for (let by = 0; by < (h >> 2); by++) {
          for (let bx = 0; bx < bw; bx++) {
            const bi = by * bw + bx;
            const texels = dv.getUint32(blk + bi * 4, true);
            const pi = dv.getUint16(info + bi * 2, true);
            const mode = pi >> 14;
            const pb = palBase + ((pi & 0x3fff) << 2);
            const pc = (k) => rgb555(dv.getUint16(pb + k * 2, true));
            const c0 = pc(0), c1 = pc(1);
            const mix = (a, b, wa, wb, d) => [((a[0] * wa + b[0] * wb) / d) | 0, ((a[1] * wa + b[1] * wb) / d) | 0, ((a[2] * wa + b[2] * wb) / d) | 0];
            let cols;
            if (mode === 0) cols = [c0, c1, pc(2), null];
            else if (mode === 1) cols = [c0, c1, mix(c0, c1, 1, 1, 2), null];
            else if (mode === 2) cols = [c0, c1, pc(2), pc(3)];
            else cols = [c0, c1, mix(c0, c1, 5, 3, 8), mix(c0, c1, 3, 5, 8)];
            for (let t = 0; t < 16; t++) {
              const c = cols[(texels >> (t * 2)) & 3];
              const i = (by * 4 + (t >> 2)) * w + bx * 4 + (t & 3);
              if (c) put(i, c, 255); else put(i, [0, 0, 0], 0);
            }
          }
        }
        break;
      }
      case 6: // A5I3
        for (let i = 0; i < n; i++) { const b = u8[src + i]; put(i, color(b & 7), ((b >> 3) * 255 / 31) | 0); }
        break;
      case 7: // direct colour
        for (let i = 0; i < n; i++) { const c = dv.getUint16(src + i * 2, true); put(i, rgb555(c), c & 0x8000 ? 255 : 0); }
        break;
      default:
        out.fill(255);
    }
    return { width: w, height: h, data: out };
  }

  // ---------- Model (MDL0) ----------
  function parseObjects(dv, u8, dictOff) {
    return readDict(dv, u8, dictOff).map((e) => {
      let p = dictOff + dv.getUint32(e.off, true);
      const flags = dv.getUint16(p, true);
      const m0 = dv.getInt16(p + 2, true) / 4096;
      p += 4;
      let t = [0, 0, 0], r = [1, 0, 0, 0, 1, 0, 0, 0, 1], s = [1, 1, 1];
      if (!(flags & 1)) { t = [fx32(dv.getInt32(p, true)), fx32(dv.getInt32(p + 4, true)), fx32(dv.getInt32(p + 8, true))]; p += 12; }
      if (flags & 8) {
        const a = dv.getInt16(p, true) / 4096, b = dv.getInt16(p + 2, true) / 4096;
        p += 4;
        const sel = (flags >> 4) & 15, neg = (flags >> 8) & 15;
        const o = neg & 1 ? -1 : 1, c = neg & 2 ? -b : b, d = neg & 4 ? -a : a;
        r = [
          [o, 0, 0, 0, a, b, 0, c, d], [0, o, 0, a, 0, b, c, 0, d], [0, 0, o, a, b, 0, c, d, 0],
          [0, a, b, o, 0, 0, 0, c, d], [a, 0, b, 0, o, 0, c, 0, d], [a, b, 0, 0, 0, o, c, d, 0],
          [0, a, b, 0, c, d, o, 0, 0], [a, 0, b, c, 0, d, 0, o, 0], [a, b, 0, c, d, 0, 0, 0, o],
        ][sel] || r;
      } else if (!(flags & 2)) {
        r = [m0];
        for (let i = 0; i < 8; i++) r.push(dv.getInt16(p + i * 2, true) / 4096);
        p += 16;
      }
      if (!(flags & 4)) { s = [fx32(dv.getInt32(p, true)), fx32(dv.getInt32(p + 4, true)), fx32(dv.getInt32(p + 8, true))]; }
      // Nitro stores matrices for row vectors; transpose into our column-vector form.
      const m = [
        r[0] * s[0], r[3] * s[1], r[6] * s[2], t[0],
        r[1] * s[0], r[4] * s[1], r[7] * s[2], t[1],
        r[2] * s[0], r[5] * s[1], r[8] * s[2], t[2],
      ];
      return { name: e.name, matrix: m };
    });
  }

  function parseMaterials(dv, u8, base) {
    const texPairs = base + dv.getUint16(base, true);
    const palPairs = base + dv.getUint16(base + 2, true);
    const mats = readDict(dv, u8, base + 4).map((e) => {
      const p = base + dv.getUint32(e.off, true);
      const difAmb = dv.getUint32(p + 4, true);
      const polyAttr = dv.getUint32(p + 0x0c, true);
      const texParam = dv.getUint32(p + 0x14, true);
      return {
        name: e.name,
        diffuse: rgb555(difAmb & 0x7fff),
        alpha: ((polyAttr >> 16) & 31) / 31,
        cull: (polyAttr >> 6) & 3, // bit0 = draw back, bit1 = draw front
        repeatS: !!(texParam & (1 << 16)), repeatT: !!(texParam & (1 << 17)),
        flipS: !!(texParam & (1 << 18)), flipT: !!(texParam & (1 << 19)),
        texture: null, palette: null,
      };
    });
    const assign = (dictOff, key) => {
      for (const e of readDict(dv, u8, dictOff)) {
        const listOff = base + dv.getUint16(e.off, true);
        const n = u8[e.off + 2];
        for (let i = 0; i < n; i++) { const m = mats[u8[listOff + i]]; if (m) m[key] = e.name; }
      }
    };
    assign(texPairs, 'texture');
    assign(palPairs, 'palette');
    return mats;
  }

  function parseShapes(dv, u8, base) {
    return readDict(dv, u8, base).map((e) => {
      const p = base + dv.getUint32(e.off, true);
      const dlOff = p + dv.getUint32(p + 8, true);
      const dlSize = dv.getUint32(p + 12, true);
      return { name: e.name, dl: [dlOff, dlSize] };
    });
  }

  const DL_PARAMS = {
    0x00: 0, 0x10: 1, 0x11: 0, 0x12: 1, 0x13: 1, 0x14: 1, 0x15: 0, 0x16: 16, 0x17: 12, 0x18: 16, 0x19: 12, 0x1a: 9,
    0x1b: 3, 0x1c: 3, 0x20: 1, 0x21: 1, 0x22: 1, 0x23: 2, 0x24: 1, 0x25: 1, 0x26: 1, 0x27: 1, 0x28: 1, 0x29: 1,
    0x2a: 1, 0x2b: 1, 0x30: 1, 0x31: 1, 0x32: 1, 0x33: 1, 0x34: 32, 0x40: 1, 0x41: 0, 0x50: 1, 0x60: 1, 0x70: 3,
    0x71: 2, 0x72: 1,
  };
  const s10 = (v) => (v & 0x200 ? v - 0x400 : v);

  // Runs a shape's GPU display list, appending triangles to `out`.
  function runDisplayList(dv, start, size, gpu, out, texW, texH) {
    let p = start;
    const end = start + size;
    let prim = 0, strip = [];
    let vx = 0, vy = 0, vz = 0, u = 0, v = 0, col = gpu.color;
    const emit = () => {
      const pos = xform(gpu.cur, vx, vy, vz);
      strip.push({ pos, uv: [u / texW, v / texH], col: col.slice() });
      const n = strip.length;
      const tri = (a, b, c) => out.push(a, b, c);
      if (prim === 0 && n % 3 === 0) tri(strip[n - 3], strip[n - 2], strip[n - 1]);
      else if (prim === 1 && n % 4 === 0) { tri(strip[n - 4], strip[n - 3], strip[n - 2]); tri(strip[n - 4], strip[n - 2], strip[n - 1]); }
      else if (prim === 2 && n >= 3) { if (n % 2) tri(strip[n - 3], strip[n - 2], strip[n - 1]); else tri(strip[n - 2], strip[n - 3], strip[n - 1]); }
      else if (prim === 3 && n >= 4 && n % 2 === 0) { tri(strip[n - 4], strip[n - 3], strip[n - 1]); tri(strip[n - 4], strip[n - 1], strip[n - 2]); }
    };
    while (p < end) {
      const cmds = [u8at(dv, p), u8at(dv, p + 1), u8at(dv, p + 2), u8at(dv, p + 3)];
      p += 4;
      for (const c of cmds) {
        const np = DL_PARAMS[c];
        if (np === undefined) return;
        const prm = (i) => dv.getUint32(p + i * 4, true);
        switch (c) {
          case 0x14: gpu.cur = (gpu.stack[prm(0) & 31] || ident()).slice(); break;
          case 0x15: gpu.cur = ident(); break;
          case 0x1b: gpu.cur = mul(gpu.cur, [fx32(prm(0) | 0), 0, 0, 0, 0, fx32(prm(1) | 0), 0, 0, 0, 0, fx32(prm(2) | 0), 0]); break;
          case 0x20: { const c5 = prm(0); col = [(c5 & 31) / 31, ((c5 >> 5) & 31) / 31, ((c5 >> 10) & 31) / 31]; gpu.color = col; break; }
          case 0x22: { const t = prm(0); u = ((t << 16) >> 16) / 16; v = (t >> 16) / 16; break; }
          case 0x23: { const a = prm(0), b = prm(1); vx = ((a << 16) >> 16) / 4096; vy = (a >> 16) / 4096; vz = ((b << 16) >> 16) / 4096; emit(); break; }
          case 0x24: { const a = prm(0); vx = s10(a & 0x3ff) / 64; vy = s10((a >> 10) & 0x3ff) / 64; vz = s10((a >> 20) & 0x3ff) / 64; emit(); break; }
          case 0x25: { const a = prm(0); vx = ((a << 16) >> 16) / 4096; vy = (a >> 16) / 4096; emit(); break; }
          case 0x26: { const a = prm(0); vx = ((a << 16) >> 16) / 4096; vz = (a >> 16) / 4096; emit(); break; }
          case 0x27: { const a = prm(0); vy = ((a << 16) >> 16) / 4096; vz = (a >> 16) / 4096; emit(); break; }
          case 0x28: { const a = prm(0); vx += s10(a & 0x3ff) / 4096; vy += s10((a >> 10) & 0x3ff) / 4096; vz += s10((a >> 20) & 0x3ff) / 4096; emit(); break; }
          case 0x30: { const d = prm(0); if (d & 0x8000) { const c3 = rgb555(d & 0x7fff); col = [c3[0] / 255, c3[1] / 255, c3[2] / 255]; gpu.color = col; } break; }
          case 0x40: prim = prm(0) & 3; strip = []; break;
          case 0x41: strip = []; break;
        }
        p += np * 4;
      }
    }
  }
  const u8at = (dv, p) => dv.getUint8(p);

  function parseModel(dv, u8, base, name) {
    const sbcOff = base + dv.getUint32(base + 4, true);
    const matOff = base + dv.getUint32(base + 8, true);
    const shpOff = base + dv.getUint32(base + 12, true);
    const invOff = base + dv.getUint32(base + 16, true);
    const upScale = fx32(dv.getInt32(base + 0x1c, true));
    const downScale = fx32(dv.getInt32(base + 0x20, true));
    const objects = parseObjects(dv, u8, base + 0x40);
    const materials = parseMaterials(dv, u8, matOff);
    const shapes = parseShapes(dv, u8, shpOff);
    const invBind = (i) => {
      const q = invOff + i * 84;
      const m = [];
      for (let k = 0; k < 12; k++) m.push(fx32(dv.getInt32(q + k * 4, true)));
      // Stored as 4x3 for row vectors: rows are basis vectors, last row translation.
      return [m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11]];
    };
    return { name, sbcOff, upScale, downScale, objects, materials, shapes, invBind, dv };
  }

  // Executes the render bytecode and returns per-material triangle soups.
  function buildMesh(model, texSizeOf) {
    const { dv } = model;
    const gpu = { cur: ident(), stack: [], color: [1, 1, 1] };
    const groups = new Map();
    let mat = 0;
    let p = model.sbcOff;
    for (let guard = 0; guard < 100000; guard++) {
      const op = dv.getUint8(p);
      const a = (i) => dv.getUint8(p + 1 + i);
      if (op === 0x01) break;
      switch (op) {
        case 0x00: p += 1; break;
        case 0x02: p += 3; break;
        case 0x03: gpu.cur = (gpu.stack[a(0)] || ident()).slice(); p += 2; break;
        case 0x04: case 0x24: case 0x44: mat = a(0); p += 2; break;
        case 0x05: {
          const shape = model.shapes[a(0)];
          const m = model.materials[mat];
          const size = (m && texSizeOf(m)) || [1, 1];
          if (!groups.has(mat)) groups.set(mat, []);
          if (shape) runDisplayList(dv, shape.dl[0], shape.dl[1], gpu, groups.get(mat), size[0], size[1]);
          p += 2; break;
        }
        case 0x06: case 0x26: case 0x46: case 0x66: {
          const obj = a(0);
          let k = 3, dest = -1, src = -1;
          if (op === 0x26) dest = a(k++);
          else if (op === 0x46) src = a(k++);
          else if (op === 0x66) { dest = a(k++); src = a(k++); }
          if (src >= 0) gpu.cur = (gpu.stack[src] || ident()).slice();
          const o = model.objects[obj];
          if (o) gpu.cur = mul(gpu.cur, o.matrix);
          if (dest >= 0) gpu.stack[dest] = gpu.cur.slice();
          p += 1 + k; break;
        }
        case 0x07: case 0x47: case 0x08: case 0x48: p += 2; break;
        case 0x09: {
          const dest = a(0), n = a(1);
          const acc = new Array(12).fill(0);
          for (let i = 0; i < n; i++) {
            const sIdx = a(2 + i * 3), inv = a(3 + i * 3), w = a(4 + i * 3) / 256;
            const m = mul(gpu.stack[sIdx] || ident(), model.invBind(inv));
            for (let j = 0; j < 12; j++) acc[j] += m[j] * w;
          }
          gpu.stack[dest] = acc;
          p += 3 + n * 3; break;
        }
        case 0x0a: p += 9; break;
        case 0x0b: gpu.cur = mul(gpu.cur, scaleM(model.upScale)); p += 1; break;
        case 0x2b: gpu.cur = mul(gpu.cur, scaleM(model.downScale)); p += 1; break;
        case 0x0c: case 0x0d: p += 3; break;
        default: guard = 1e9; // unknown op: stop
      }
    }
    return [...groups.entries()].map(([mi, tris]) => ({ material: model.materials[mi], tris }));
  }

  // ---------- Joint animation (NSBCA) ----------
  const toColumn = (r, s, t) => [
    r[0] * s[0], r[3] * s[1], r[6] * s[2], t[0],
    r[1] * s[0], r[4] * s[1], r[7] * s[2], t[1],
    r[2] * s[0], r[5] * s[1], r[8] * s[2], t[2],
  ];

  // Returns { objIndex: matrix } for one frame of the first animation in the file.
  function parseNSBCAFrame(u8, frame) {
    const { dv, out } = blocks(u8);
    const jnt = out.JNT0;
    const anims = readDict(dv, u8, jnt + 8);
    const a = jnt + dv.getUint32(anims[0].off, true);
    const numFrames = dv.getUint16(a + 4, true);
    const numObj = dv.getUint16(a + 6, true);
    const pivotOff = a + dv.getUint32(a + 12, true);
    const basisOff = a + dv.getUint32(a + 16, true);
    const f = Math.max(0, Math.min(numFrames - 1, frame | 0));
    const sampleIdx = (info, f) => {
      // bits 30-31 of curve info select a reduced sample rate.
      const rate = (info >>> 30) & 3;
      return rate === 0 ? f : rate === 1 ? f >> 1 : f >> 2;
    };
    const rotation = (idx) => {
      if (idx & 0x8000) {
        const q = pivotOff + (idx & 0x7fff) * 6;
        const info = dv.getUint16(q, true);
        const A = dv.getInt16(q + 2, true) / 4096, B = dv.getInt16(q + 4, true) / 4096;
        const sel = info & 15, neg = (info >> 4) & 15;
        const o = neg & 1 ? -1 : 1, c = neg & 2 ? -B : B, d = neg & 4 ? -A : A;
        return [
          [o, 0, 0, 0, A, B, 0, c, d], [0, o, 0, A, 0, B, c, 0, d], [0, 0, o, A, B, 0, c, d, 0],
          [0, A, B, o, 0, 0, 0, c, d], [A, 0, B, 0, o, 0, c, 0, d], [A, B, 0, 0, 0, o, c, d, 0],
          [0, A, B, 0, c, d, o, 0, 0], [A, 0, B, c, 0, d, 0, o, 0], [A, B, 0, c, d, 0, 0, 0, o],
        ][sel] || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      }
      const q = basisOff + idx * 10;
      const x = [0, 1, 2, 3, 4].map((i) => dv.getInt16(q + i * 2, true));
      const r0 = [x[0] >> 3, x[1] >> 3, x[2] >> 3].map((v) => v / 4096);
      const r1 = [x[3] >> 3, x[4] >> 3, 0].map((v) => v / 4096);
      // The sixth element is packed into the low bits; rebuild it from orthonormality instead.
      const mag = Math.sqrt(Math.max(0, 1 - r1[0] * r1[0] - r1[1] * r1[1]));
      if (Math.abs(r0[2]) > 0.05) r1[2] = Math.max(-mag, Math.min(mag, -(r0[0] * r1[0] + r0[1] * r1[1]) / r0[2]));
      else r1[2] = x[0] & 4 ? -mag : mag;
      const n1 = Math.hypot(r1[0], r1[1], r1[2]) || 1;
      r1[0] /= n1; r1[1] /= n1; r1[2] /= n1;
      const r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]];
      return [...r0, ...r1, ...r2];
    };
    const result = {};
    for (let i = 0; i < numObj; i++) {
      let p = a + dv.getUint16(a + 20 + i * 2, true);
      const flags = dv.getUint16(p, true);
      const objId = u8[p + 3];
      p += 4;
      if (flags & 1) continue; // identity / untouched
      let t = [0, 0, 0], r = [1, 0, 0, 0, 1, 0, 0, 0, 1], s = [1, 1, 1];
      if (!(flags & 6)) {
        for (let k = 0; k < 3; k++) {
          if (flags & (8 << k)) { t[k] = fx32(dv.getInt32(p, true)); p += 4; }
          else {
            const info = dv.getUint32(p, true), off = a + dv.getUint32(p + 4, true); p += 8;
            const si = sampleIdx(info, f);
            t[k] = info & 0x20000000 ? dv.getInt16(off + si * 2, true) / 4096 : fx32(dv.getInt32(off + si * 4, true));
          }
        }
      }
      if (!(flags & 0xc0)) {
        if (flags & 0x100) { r = rotation(dv.getUint16(p, true)); p += 4; }
        else {
          const info = dv.getUint32(p, true), off = a + dv.getUint32(p + 4, true); p += 8;
          r = rotation(dv.getUint16(off + sampleIdx(info, f) * 2, true));
        }
      }
      if (!(flags & 0x600)) {
        for (let k = 0; k < 3; k++) {
          if (flags & (0x800 << k)) { s[k] = fx32(dv.getInt32(p, true)); p += 8; }
          else {
            const info = dv.getUint32(p, true), off = a + dv.getUint32(p + 4, true); p += 8;
            const si = sampleIdx(info, f);
            s[k] = info & 0x20000000 ? dv.getInt16(off + si * 4, true) / 4096 : fx32(dv.getInt32(off + si * 8, true));
          }
        }
      }
      result[objId] = toColumn(r, s, t);
    }
    return result;
  }

  // Applies an animation pose to a parsed model (replaces object matrices).
  function applyPose(model, pose) {
    for (const k in pose) if (model.objects[k]) model.objects[k].matrix = pose[k];
  }

  function parseNSBMD(u8) {
    const { dv, out } = blocks(u8);
    const models = [];
    if (out.MDL0 !== undefined) {
      for (const e of readDict(dv, u8, out.MDL0 + 8)) models.push(parseModel(dv, u8, out.MDL0 + dv.getUint32(e.off, true), e.name));
    }
    const tex0 = out.TEX0 !== undefined ? parseTEX0(u8, out.TEX0) : null;
    return { models, tex0 };
  }

  function parseNSBTX(u8) {
    const { out } = blocks(u8);
    return out.TEX0 !== undefined ? parseTEX0(u8, out.TEX0) : null;
  }

  // Resolve a material's texture across the given TEX0 blocks and decode it.
  function resolveTexture(texSets, mat, cache) {
    if (!mat.texture) return null;
    const key = mat.texture + '|' + mat.palette;
    if (cache.has(key)) return cache.get(key);
    let result = null;
    for (const t0 of texSets) {
      if (!t0) continue;
      const tex = t0.textures.find((t) => t.name === mat.texture);
      if (!tex) continue;
      const pal = t0.palettes.find((q) => q.name === mat.palette) || t0.palettes.find((q) => q.name === mat.texture + '_pl') || null;
      result = decodeTexture(t0, tex, pal);
      break;
    }
    cache.set(key, result);
    return result;
  }

  global.Nitro = { parseNSBMD, parseNSBTX, parseNSBCAFrame, applyPose, buildMesh, resolveTexture, decodeTexture };
})(typeof window !== 'undefined' ? window : globalThis);
