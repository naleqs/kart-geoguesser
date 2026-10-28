// Nintendo DS ROM filesystem + common container formats (NARC, LZ77 / LZ10/LZ11).
(function (global) {
  'use strict';

  function readName(u8, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
    return s;
  }

  // Parses an FNT + FAT pair (used by both the ROM itself and NARC archives).
  // Returns a Map of path -> Uint8Array view.
  function parseFileSystem(u8, fntOff, fatOff, fileBase, fatCount) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const files = new Map();
    const fileAt = (id) => {
      const s = dv.getUint32(fatOff + id * 8, true);
      const e = dv.getUint32(fatOff + id * 8 + 4, true);
      return u8.subarray(fileBase + s, fileBase + e);
    };
    function walk(dirId, prefix) {
      const ent = fntOff + (dirId & 0xfff) * 8;
      let p = fntOff + dv.getUint32(ent, true);
      let fileId = dv.getUint16(ent + 4, true);
      for (;;) {
        const t = u8[p++];
        if (t === 0) break;
        const len = t & 0x7f;
        const name = readName(u8, p, len);
        p += len;
        if (t & 0x80) {
          const sub = dv.getUint16(p, true);
          p += 2;
          walk(sub, prefix + name + '/');
        } else {
          files.set(prefix + name, fileAt(fileId++));
        }
      }
    }
    walk(0xf000, '');
    // NARCs without names: expose by index.
    if (files.size === 0 && fatCount) {
      for (let i = 0; i < fatCount; i++) files.set(String(i), fileAt(i));
    }
    return files;
  }

  function parseRom(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const title = readName(u8, 0, 12).replace(/\0+$/, '');
    const code = readName(u8, 12, 4);
    const fntOff = dv.getUint32(0x40, true);
    const fatOff = dv.getUint32(0x48, true);
    const files = parseFileSystem(u8, fntOff, fatOff, 0);
    return { title, code, files };
  }

  function decompressLZ(src) {
    const type = src[0];
    let size = src[1] | (src[2] << 8) | (src[3] << 16);
    let p = 4;
    if (size === 0) { size = src[4] | (src[5] << 8) | (src[6] << 16) | (src[7] << 24); p = 8; }
    const out = new Uint8Array(size);
    let o = 0;
    while (o < size) {
      const flags = src[p++];
      for (let b = 0; b < 8 && o < size; b++) {
        if (flags & (0x80 >> b)) {
          let len, disp;
          if (type === 0x10) {
            const b1 = src[p++], b2 = src[p++];
            len = (b1 >> 4) + 3;
            disp = (((b1 & 0xf) << 8) | b2) + 1;
          } else {
            const b1 = src[p++];
            const ind = b1 >> 4;
            if (ind === 0) {
              const b2 = src[p++], b3 = src[p++];
              len = (((b1 & 0xf) << 4) | (b2 >> 4)) + 0x11;
              disp = (((b2 & 0xf) << 8) | b3) + 1;
            } else if (ind === 1) {
              const b2 = src[p++], b3 = src[p++], b4 = src[p++];
              len = (((b1 & 0xf) << 12) | (b2 << 4) | (b3 >> 4)) + 0x111;
              disp = (((b3 & 0xf) << 8) | b4) + 1;
            } else {
              const b2 = src[p++];
              len = ind + 1;
              disp = (((b1 & 0xf) << 8) | b2) + 1;
            }
          }
          for (let i = 0; i < len && o < size; i++, o++) out[o] = out[o - disp];
        } else {
          out[o++] = src[p++];
        }
      }
    }
    return out;
  }

  function maybeDecompress(u8) {
    if ((u8[0] === 0x10 || u8[0] === 0x11) && readName(u8, 0, 4) !== 'NARC') {
      try { return decompressLZ(u8); } catch (e) { return u8; }
    }
    return u8;
  }

  function parseNARC(u8) {
    u8 = maybeDecompress(u8);
    if (readName(u8, 0, 4) !== 'NARC') throw new Error('Not a NARC');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const hdr = dv.getUint16(0x0c, true);
    let p = hdr;
    const fatbOff = p;
    const fatCount = dv.getUint16(fatbOff + 8, true);
    p += dv.getUint32(p + 4, true);
    const fntbOff = p;
    p += dv.getUint32(p + 4, true);
    const fimgOff = p;
    return parseFileSystem(u8, fntbOff + 8, fatbOff + 12, fimgOff + 8, fatCount);
  }

  global.NDS = { parseRom, parseNARC, decompressLZ, maybeDecompress, readName };
})(typeof window !== 'undefined' ? window : globalThis);
