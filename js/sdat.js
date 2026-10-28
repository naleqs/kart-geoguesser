// Nintendo DS sound archive (SDAT) reader and a small Web Audio sequence player.
// Plays SSEQ music with its SBNK instruments and SWAR samples straight from the ROM.
(function (global) {
  'use strict';

  const str4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

  // ---------- archive ----------
  function parseSDAT(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (str4(u8, 0) !== 'SDAT') throw new Error('Not an SDAT');
    const symbOff = dv.getUint32(0x10, true), infoOff = dv.getUint32(0x18, true), fatOff = dv.getUint32(0x20, true);
    const cstr = (o) => { let s = ''; while (u8[o]) s += String.fromCharCode(u8[o++]); return s; };

    const names = [];
    if (symbOff) {
      for (let r = 0; r < 8; r++) {
        const rec = symbOff + dv.getUint32(symbOff + 8 + r * 4, true);
        const n = dv.getUint32(rec, true), list = [];
        for (let i = 0; i < n; i++) { const o = dv.getUint32(rec + 4 + i * 4, true); list.push(o ? cstr(symbOff + o) : ''); }
        names.push(list);
      }
    }
    const info = [];
    for (let r = 0; r < 8; r++) {
      const rec = infoOff + dv.getUint32(infoOff + 8 + r * 4, true);
      const n = dv.getUint32(rec, true), list = [];
      for (let i = 0; i < n; i++) { const o = dv.getUint32(rec + 4 + i * 4, true); list.push(o ? infoOff + o : 0); }
      info.push(list);
    }
    const fatCount = dv.getUint32(fatOff + 8, true);
    const file = (id) => {
      if (id >= fatCount) return null;
      const e = fatOff + 12 + id * 16;
      const off = dv.getUint32(e, true);
      return u8.subarray(off, off + dv.getUint32(e + 4, true));
    };

    const seqs = info[0].map((o, i) => o && {
      id: i, name: (names[0] || [])[i] || 'SEQ_' + i,
      file: dv.getUint16(o, true), bank: dv.getUint16(o + 4, true), volume: u8[o + 6],
    }).filter(Boolean);
    const banks = info[2].map((o) => o && {
      file: dv.getUint16(o, true), waveArcs: [0, 1, 2, 3].map((k) => dv.getUint16(o + 4 + k * 2, true)),
    });
    const waveArcs = info[3].map((o) => o && { file: dv.getUint32(o, true) & 0xffffff });
    return { seqs, banks, waveArcs, file };
  }

  // ---------- samples ----------
  const ADPCM_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const ADPCM_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

  function parseSWAR(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(0x38, true);
    const waves = [];
    for (let i = 0; i < n; i++) {
      const o = dv.getUint32(0x3c + i * 4, true);
      const type = u8[o], loop = !!u8[o + 1], rate = dv.getUint16(o + 2, true);
      const loopOff = dv.getUint16(o + 6, true), len = dv.getUint32(o + 8, true);
      const data = u8.subarray(o + 12, o + 12 + (loopOff + len) * 4);
      let pcm, loopStart;
      if (type === 0) { // PCM8
        pcm = new Float32Array(data.length);
        for (let k = 0; k < data.length; k++) pcm[k] = ((data[k] << 24) >> 24) / 128;
        loopStart = loopOff * 4;
      } else if (type === 1) { // PCM16
        pcm = new Float32Array(data.length >> 1);
        const d2 = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let k = 0; k < pcm.length; k++) pcm[k] = d2.getInt16(k * 2, true) / 32768;
        loopStart = loopOff * 2;
      } else { // IMA-ADPCM
        const d2 = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let pred = d2.getInt16(0, true), idx = Math.min(88, data[2]);
        pcm = new Float32Array(Math.max(0, (data.length - 4) * 2));
        for (let k = 0; k < pcm.length; k++) {
          const nib = (data[4 + (k >> 1)] >> ((k & 1) * 4)) & 15;
          const step = ADPCM_STEP[idx];
          let diff = step >> 3;
          if (nib & 1) diff += step >> 2;
          if (nib & 2) diff += step >> 1;
          if (nib & 4) diff += step;
          pred = nib & 8 ? Math.max(-32767, pred - diff) : Math.min(32767, pred + diff);
          idx = Math.max(0, Math.min(88, idx + ADPCM_IDX[nib & 7]));
          pcm[k] = pred / 32768;
        }
        loopStart = Math.max(0, (loopOff * 4 - 4) * 2);
      }
      waves.push({ pcm, rate: Math.max(3000, rate), loop, loopStart });
    }
    return waves;
  }

  // ---------- instruments ----------
  function readRegion(dv, o, type) {
    return {
      type, wave: dv.getUint16(o, true), arc: dv.getUint16(o + 2, true), base: dv.getUint8(o + 4),
      a: dv.getUint8(o + 5), d: dv.getUint8(o + 6), s: dv.getUint8(o + 7), r: dv.getUint8(o + 8), pan: dv.getUint8(o + 9),
    };
  }
  function parseSBNK(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(0x38, true);
    const insts = [];
    for (let i = 0; i < n; i++) {
      const rec = 0x3c + i * 4;
      const type = u8[rec], off = dv.getUint16(rec + 1, true);
      if (type === 0) { insts.push(null); continue; }
      if (type < 16) { insts.push({ kind: 'single', region: readRegion(dv, off, type) }); continue; }
      if (type === 16) { // drum set: one region per key
        const lo = u8[off], hi = u8[off + 1], regions = [];
        for (let k = lo; k <= hi; k++) {
          const p = off + 2 + (k - lo) * 12;
          regions.push({ lo: k, hi: k, region: readRegion(dv, p + 2, dv.getUint16(p, true)) });
        }
        insts.push({ kind: 'split', regions });
        continue;
      }
      if (type === 17) { // key split: up to 8 ranges
        const regions = [];
        let lo = 0, p = off + 8;
        for (let k = 0; k < 8 && u8[off + k]; k++) {
          regions.push({ lo, hi: u8[off + k], region: readRegion(dv, p + 2, dv.getUint16(p, true)) });
          lo = u8[off + k] + 1;
          p += 12;
        }
        insts.push({ kind: 'split', regions });
        continue;
      }
      insts.push(null);
    }
    return insts;
  }
  const regionFor = (inst, key) => {
    if (!inst) return null;
    if (inst.kind === 'single') return inst.region;
    const r = inst.regions.find((q) => key >= q.lo && key <= q.hi);
    return r ? r.region : null;
  };

  // DS envelope rates converted to seconds (the hardware runs its envelope at ~192 Hz).
  const decayRate = (v) => (v >= 127 ? 65535 : v === 126 ? 15360 : v < 50 ? v * 2 + 1 : 7680 / (126 - v));
  const decayTime = (v) => 92544 / decayRate(v) / 192;
  const attackTime = (a) => (a >= 127 ? 0.001 : Math.min(1.5, Math.pow((127 - a) / 127, 2) * 1.2));
  const level = (v) => Math.pow(v / 127, 2);

  // ---------- sequence player ----------
  class Player {
    constructor(sdat, ctx, destination) {
      this.sdat = sdat;
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.connect(destination || ctx.destination);
      this.buffers = new Map();
      this.bankCache = new Map();
      this.timer = null;
      this.voices = new Set();
    }

    _bank(id) {
      if (this.bankCache.has(id)) return this.bankCache.get(id);
      const b = this.sdat.banks[id];
      const insts = parseSBNK(this.sdat.file(b.file));
      const arcs = b.waveArcs.map((w) => {
        if (w === 0xffff || !this.sdat.waveArcs[w]) return null;
        const f = this.sdat.file(this.sdat.waveArcs[w].file);
        return f ? parseSWAR(f) : null;
      });
      const bank = { insts, arcs };
      this.bankCache.set(id, bank);
      return bank;
    }

    _buffer(arcs, region) {
      const key = region.arc + ':' + region.wave + ':' + arcs.id;
      const arc = arcs[region.arc];
      const w = arc && arc[region.wave];
      if (!w || !w.pcm.length) return null;
      if (!w.buffer) {
        const buf = this.ctx.createBuffer(1, w.pcm.length, w.rate);
        buf.copyToChannel(w.pcm, 0);
        w.buffer = buf;
      }
      return w;
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      const t = this.ctx.currentTime;
      for (const v of this.voices) { try { v.gain.gain.cancelScheduledValues(t); v.gain.gain.setTargetAtTime(0, t, 0.05); v.src.stop(t + 0.3); } catch (e) { /* already stopped */ } }
      this.voices.clear();
      this.playing = null;
    }

    play(seqName) {
      this.stop();
      const seq = this.sdat.seqs.find((s) => s.name === seqName) || this.sdat.seqs[seqName];
      if (!seq) throw new Error('No sequence ' + seqName);
      const u8 = this.sdat.file(seq.file);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const base = dv.getUint32(0x18, true);
      this.bank = this._bank(seq.bank);
      this.seqVol = seq.volume / 127;
      this.playing = seq.name;
      const S = { u8, dv, base, tempo: 120, vars: new Int16Array(32) };
      this.S = S;
      this.tracks = [this._track(S, base, 0)];
      this.time = this.ctx.currentTime + 0.1;
      this.timer = setInterval(() => this._pump(), 40);
      this._pump();
    }

    _track(S, pc, no) {
      return {
        no, pc, wait: 0, done: false, stack: [], loops: [], prg: 0, vol: 127, expr: 127, pan: 64, trans: 0,
        bend: 0, bendRange: 2, noteWait: true, tie: false, a: -1, d: -1, s: -1, r: -1, cond: true, tieVoice: null,
      };
    }

    // Schedule everything up to 0.3 s ahead.
    _pump(until) {
      const horizon = until !== undefined ? until : this.ctx.currentTime + 0.3;
      let guard = 0;
      while (this.time < horizon && guard++ < 4000) {
        const alive = this.tracks.filter((t) => !t.done);
        if (!alive.length) { this.stop(); return; }
        for (const t of alive) {
          let steps = 0;
          while (t.wait <= 0 && !t.done && steps++ < 512) this._step(t);
          t.wait--;
        }
        this.time += 60 / (this.S.tempo * 48);
      }
    }

    _varlen(t) {
      const u8 = this.S.u8;
      let v = 0, b;
      do { b = u8[t.pc++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
      return v;
    }

    _step(t) {
      const S = this.S, u8 = S.u8, dv = S.dv;
      const u24 = () => { const v = u8[t.pc] | (u8[t.pc + 1] << 8) | (u8[t.pc + 2] << 16); t.pc += 3; return v; };
      let cmd = u8[t.pc++];
      // Prefix commands: random / variable argument, conditional.
      let argMode = null;
      if (cmd === 0xa0 || cmd === 0xa1) { argMode = cmd; cmd = u8[t.pc++]; }
      let skip = false;
      if (cmd === 0xa2) { skip = !t.cond; cmd = u8[t.pc++]; }
      const arg = (readDefault) => {
        if (argMode === 0xa0) { const lo = dv.getInt16(t.pc, true), hi = dv.getInt16(t.pc + 2, true); t.pc += 4; return lo + Math.floor(Math.random() * (hi - lo + 1)); }
        if (argMode === 0xa1) { const v = S.vars[u8[t.pc++] & 31]; return v; }
        return readDefault();
      };
      const u8a = () => u8[t.pc++];

      if (cmd < 0x80) {
        const vel = u8a();
        const dur = arg(() => this._varlen(t));
        if (!skip) this._note(t, cmd + t.trans, vel, dur);
        if (t.noteWait) t.wait = dur;
        return;
      }
      switch (cmd) {
        case 0x80: { const r = arg(() => this._varlen(t)); if (!skip) t.wait = r; break; }
        case 0x81: { const p = arg(() => this._varlen(t)); if (!skip) t.prg = p; break; }
        case 0x93: { const no = u8a(), off = u24(); if (!skip && !this.tracks.some((q) => q.no === no)) this.tracks.push(this._track(S, S.base + off - 0x1c + 0x1c, no)); break; }
        case 0x94: { const off = u24(); if (!skip) t.pc = S.base + off - 0x1c + 0x1c; break; }
        case 0x95: { const off = u24(); if (!skip) { t.stack.push(t.pc); t.pc = S.base + off - 0x1c + 0x1c; } break; }
        case 0xfd: if (!skip && t.stack.length) t.pc = t.stack.pop(); break;
        case 0xd4: { const n = arg(u8a); if (!skip) t.loops.push({ pc: t.pc, n }); break; }
        case 0xfc: if (!skip && t.loops.length) {
          const l = t.loops[t.loops.length - 1];
          if (l.n === 0) t.pc = l.pc; // infinite
          else if (--l.n > 0) t.pc = l.pc;
          else t.loops.pop();
        } break;
        case 0xfe: t.pc += 2; break;
        case 0xff: if (!skip) t.done = true; break;
        case 0xc0: { const v = arg(u8a); if (!skip) t.pan = v; break; }
        case 0xc1: { const v = arg(u8a); if (!skip) t.vol = v; break; }
        case 0xc2: { const v = arg(u8a); if (!skip) this.seqVol = v / 127; break; }
        case 0xc3: { const v = arg(u8a); if (!skip) t.trans = (v << 24) >> 24; break; }
        case 0xc4: { const v = arg(u8a); if (!skip) t.bend = (v << 24) >> 24; break; }
        case 0xc5: { const v = arg(u8a); if (!skip) t.bendRange = v; break; }
        case 0xc7: { const v = arg(u8a); if (!skip) t.noteWait = !!v; break; }
        case 0xc8: { const v = arg(u8a); if (!skip) { t.tie = !!v; if (!v && t.tieVoice) { this._release(t.tieVoice, this.time); t.tieVoice = null; } } break; }
        case 0xd0: { const v = arg(u8a); if (!skip) t.a = v; break; }
        case 0xd1: { const v = arg(u8a); if (!skip) t.d = v; break; }
        case 0xd2: { const v = arg(u8a); if (!skip) t.s = v; break; }
        case 0xd3: { const v = arg(u8a); if (!skip) t.r = v; break; }
        case 0xd5: { const v = arg(u8a); if (!skip) t.expr = v; break; }
        case 0xc6: case 0xc9: case 0xca: case 0xcb: case 0xcc: case 0xcd: case 0xce: case 0xcf: case 0xd6: case 0xd7: arg(u8a); break;
        case 0xe0: case 0xe3: arg(() => { t.pc += 2; return 0; }); break;
        case 0xe1: { const v = arg(() => { const x = dv.getUint16(t.pc, true); t.pc += 2; return x; }); if (!skip && v > 0) S.tempo = v; break; }
        default:
          if (cmd >= 0xb0 && cmd <= 0xbd) { // variable operations
            const vi = u8a() & 31;
            const val = arg(() => { const x = dv.getInt16(t.pc, true); t.pc += 2; return x; });
            if (skip) break;
            const V = S.vars;
            switch (cmd) {
              case 0xb0: V[vi] = val; break; case 0xb1: V[vi] += val; break; case 0xb2: V[vi] -= val; break;
              case 0xb3: V[vi] *= val; break; case 0xb4: if (val) V[vi] = (V[vi] / val) | 0; break;
              case 0xb5: V[vi] = val >= 0 ? V[vi] << val : V[vi] >> -val; break;
              case 0xb6: V[vi] = Math.floor(Math.random() * (Math.abs(val) + 1)) * Math.sign(val || 1); break;
              case 0xb8: t.cond = V[vi] === val; break; case 0xb9: t.cond = V[vi] >= val; break;
              case 0xba: t.cond = V[vi] > val; break; case 0xbb: t.cond = V[vi] <= val; break;
              case 0xbc: t.cond = V[vi] < val; break; case 0xbd: t.cond = V[vi] !== val; break;
            }
          } else {
            t.done = true; // unknown command: stop this track rather than read garbage
          }
      }
    }

    _note(t, key, vel, dur) {
      const inst = this.bank.insts[t.prg];
      const region = regionFor(inst, key);
      if (!region) return;
      if (t.tie && t.tieVoice) { // tie mode: glide the held note to the new pitch
        const v = t.tieVoice;
        v.src.playbackRate.setValueAtTime(Math.pow(2, (key - v.base + (t.bend / 128) * t.bendRange) / 12), this.time);
        return;
      }
      const ctx = this.ctx, when = this.time;
      let src, base = region.base;
      if (region.type === 1) {
        const w = this._buffer(this.bank.arcs, region);
        if (!w) return;
        src = ctx.createBufferSource();
        src.buffer = w.buffer;
        if (w.loop && w.loopStart < w.pcm.length - 1) { src.loop = true; src.loopStart = w.loopStart / w.rate; src.loopEnd = w.pcm.length / w.rate; }
        src.playbackRate.value = Math.pow(2, (key - base + (t.bend / 128) * t.bendRange) / 12);
      } else if (region.type === 2) { // PSG square wave
        src = ctx.createOscillator();
        src.type = 'square';
        src.frequency.value = 440 * Math.pow(2, (key - 69) / 12);
        base = key;
      } else {
        return;
      }
      const a = t.a >= 0 ? t.a : region.a, d = t.d >= 0 ? t.d : region.d, s = t.s >= 0 ? t.s : region.s, r = t.r >= 0 ? t.r : region.r;
      const peak = (vel / 127) * level(t.vol) * level(t.expr) * this.seqVol * 0.35 * (region.type === 2 ? 0.25 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      const ta = attackTime(a);
      g.gain.linearRampToValueAtTime(peak, when + ta);
      g.gain.setTargetAtTime(peak * level(s), when + ta, decayTime(d) / 4);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = Math.max(-1, Math.min(1, ((t.pan - 64) / 64) * 0.8 + ((region.pan - 64) / 64) * 0.2)); src.connect(g); g.connect(pan); pan.connect(this.out); }
      else { src.connect(g); g.connect(this.out); }
      src.start(when);
      const voice = { src, gain: g, base, peak, rel: decayTime(r) };
      this.voices.add(voice);
      src.onended = () => this.voices.delete(voice);
      if (t.tie) { t.tieVoice = voice; return; }
      this._release(voice, when + dur * 60 / (this.S.tempo * 48));
    }

    _release(v, when) {
      v.gain.gain.cancelScheduledValues(when);
      v.gain.gain.setTargetAtTime(0, when, Math.max(0.01, v.rel / 5));
      try { v.src.stop(when + Math.min(4, v.rel) + 0.05); } catch (e) { /* already stopped */ }
    }
  }

  global.SDAT = { parseSDAT, Player };
})(typeof window !== 'undefined' ? window : globalThis);
