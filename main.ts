// PNG Squeeze: a lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// Reads every /input/<id>/image.png and writes the smallest lossless PNG it can
// find to /output/<id>/image.png. The search, per image:
//   1. pick the cheapest colour form: a palette (at most 256 colours, transparent
//      entries first so tRNS stays short), grey / grey+alpha when every pixel is
//      grey, RGB / RGBA otherwise, with a tRNS key when the image holds a single
//      fully transparent value and no opaque pixel shares it;
//   2. for that form, filter every row five ways plus the minimum-sum and
//      fewest-pairs per-row choices, and weigh the best few by real zlib level 9;
//   3. refine the winner row by row: each row's filter is the one whose zlib
//      stream (level 4, the 32 KiB written before it as dictionary) is shortest;
//   4. deflate the winner at zlib levels 6 and 9, each with the default and
//      filtered strategies, keeping the smallest stream (level 9 does not
//      dominate level 6 on this data).
// No clock is read and no randomness is used, so two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ */
/* PNG container: CRC-32, chunk writing, decoding to RGBA.             */
/* ------------------------------------------------------------------ */

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const data = new Uint8Array(13);
  new DataView(data.buffer).setUint32(0, width);
  new DataView(data.buffer).setUint32(4, height);
  data[8] = 8;
  data[9] = colourType;
  return data;
}

/** Paeth predictor, as PNG defines it. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a bit-depth-8, non-interlaced PNG of colour type 0, 2, 3, 4 or 6 to
 * RGBA, or return { ok: false, why } when the file is not one the contest reads.
 */
function decodePng(bytes) {
  const fail = (why) => ({ ok: false, why });
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('no PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) return fail('bytes after IEND');
    if (at + 12 > bytes.length) return fail('cut-off chunk header');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) return fail('chunk overruns the file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(`${type} fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) return fail(`unread chunk ${type}`);
    if (type === 'IHDR') {
      if (header !== null || len !== 13) return fail('bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = {
        width: dv.getUint32(0),
        height: dv.getUint32(4),
        depth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType) || header.interlace !== 0) {
        return fail('unsupported IHDR');
      }
    } else if (type === 'PLTE') {
      if (header.colourType !== 3 || len === 0 || len % 3 !== 0 || len > 768) return fail('bad PLTE');
      palette = data;
    } else if (type === 'tRNS') {
      if (header.colourType === 3) {
        if (palette === null || len > palette.length / 3) return fail('bad palette tRNS');
      } else if (header.colourType === 0 || header.colourType === 2) {
        if (len !== (header.colourType === 0 ? 2 : 6)) return fail('bad grey/RGB tRNS');
      } else return fail('tRNS with an alpha colour type');
      trns = data;
    } else if (type === 'IDAT') {
      if (header.colourType === 3 && palette === null) return fail('IDAT before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) return fail('non-empty IEND');
      ended = true;
    }
  }
  if (!ended || idat.length === 0) return fail('no IEND or no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return fail('IDAT does not inflate');
  }
  if (raw.length !== expected) return fail('IDAT inflates to the wrong length');

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} filter ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`palette index ${e} out of range`);
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { ok: true, width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* Image analysis: what colour forms can hold this image exactly.      */
/* ------------------------------------------------------------------ */

/**
 * One pass over the pixels: whether every pixel is opaque, whether every
 * pixel is grey, and the colour histogram when the image holds at most 256
 * distinct colours (null otherwise). Colours are keyed by a 32-bit word built
 * from the bytes, so the key is the same on any platform.
 */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const word = (r << 24) | (g << 16) | (b << 8) | a;
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else counts.set(word, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      r: (word >>> 24) & 0xff,
      g: (word >>> 16) & 0xff,
      b: (word >>> 8) & 0xff,
      a: word & 0xff,
      word,
      count,
    }));
  }
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey sample, or packed RGB) the image may
 * key by tRNS instead of carrying an alpha channel: every non-opaque pixel is
 * that exact value at alpha 0, and no opaque pixel shares the value.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type ct (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** Palette entries in write order: transparent ones first (by alpha), then by `order`. */
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  return [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

/** A palette form: its PLTE, its tRNS (null when every entry is opaque), and its index samples. */
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const word = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
    indices[i] = index.get(word);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

/** The channel form (grey / grey+alpha / RGB / RGBA) for an image without a palette. */
function channelForm(rgba, opaque, grey) {
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, (key >>> 16) & 0xff, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  return { colourType: ct, bpp: { 0: 1, 2: 3, 4: 2, 6: 4 }[ct], samples: samplesOf(rgba, ct), plte: null, trns };
}

/** Every colour form that can hold this image exactly, cheapest first by shape. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  forms.push(channelForm(rgba, opaque, grey));
  return forms;
}

/** The bytes a form's PLTE and tRNS chunks add to its file. */
const chunkOverhead = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/* ------------------------------------------------------------------ */
/* Filtering: one row, five ways, and the per-row cost heuristics.     */
/* ------------------------------------------------------------------ */

/** Row `cur` (with `prev` above it, or null) filtered by `type` into `out`. */
function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** A filtered row's bytes read as signed values, summed in absolute: the PNG spec's heuristic cost. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct neighbouring byte pairs a filtered row holds. */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/**
 * All seven filterings of an image's samples: the five fixed filters, the
 * per-row minimum-sum choice, and the per-row fewest-pairs choice, each as a
 * full raw buffer (filter byte before every row), with each variant's total
 * signed sum for ranking them before any deflate runs.
 */
function buildVariants(samples, width, height, bpp) {
  const stride = width * bpp;
  const rowLen = stride + 1;
  const bufs = Array.from({ length: 7 }, () => new Uint8Array(height * rowLen));
  const sums = new Array(7).fill(0);
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowLen;
    const s = new Array(5);
    const p = new Array(5);
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trial[t]);
      s[t] = signedSum(trial[t]);
      p[t] = pairsOf(trial[t], seen, ++stamp);
      bufs[t][at] = t;
      bufs[t].set(trial[t], at + 1);
      sums[t] += s[t];
    }
    let bestSum = 0;
    let bestPairs = 0;
    for (let t = 1; t < 5; t++) {
      if (s[t] < s[bestSum]) bestSum = t;
      if (p[t] < p[bestPairs]) bestPairs = t;
    }
    bufs[5][at] = bestSum;
    bufs[5].set(trial[bestSum], at + 1);
    sums[5] += s[bestSum];
    bufs[6][at] = bestPairs;
    bufs[6].set(trial[bestPairs], at + 1);
    sums[6] += s[bestPairs];
  }
  return { bufs, sums };
}

/**
 * The brute-force filtering: each row takes the filter whose own zlib stream
 * (level 4, the 32 KiB already written as its dictionary) is shortest.
 */
function bruteRefine(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride + 1);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let bestType = 0;
    let bestLen = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      filterRowInto(t, cur, prev, bpp, trial.subarray(1));
      const len = deflateSync(
        trial,
        before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before },
      ).length;
      if (len < bestLen) {
        bestLen = len;
        bestType = t;
      }
    }
    raw[at] = bestType;
    filterRowInto(bestType, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* Deflate screening and the per-image search.                         */
/* ------------------------------------------------------------------ */

/**
 * The deflate settings a finalist is weighed at. Neither level nor memLevel
 * dominates: on one practice image level 9 writes 530 bytes more than level 6
 * of the same filtered rows, and memLevel 9 writes 500 to 1,700 bytes more
 * than memLevel 8 at every level, so levels 6, 8 and 9 at memLevel 8 (plus
 * level 9 filtered) are tried and the smallest stream kept.
 */
const DEFLATE_SETTINGS = [
  { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 8, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
];

/**
 * The cheapest encoding of one colour form: screen its filter variants at
 * level 6 (the unfiltered variant is always screened, since its signed sum
 * is the worst of all yet its stream can be the smallest), weigh the best
 * two at every deflate setting, then refine by brute force at levels 6 and 9.
 */
function encodeForm(form, width, height) {
  const overhead = chunkOverhead(form);
  const { bufs, sums } = buildVariants(form.samples, width, height, form.bpp);
  const order = [0, 1, 2, 3, 4, 5, 6].sort((x, y) => sums[x] - sums[y]);
  const candIdx = [...new Set([0, ...order.slice(0, 3)])];
  const screened = candIdx
    .map((idx) => ({ idx, comp: deflateSync(bufs[idx], DEFLATE_SETTINGS[0]) }))
    .sort((a, b) => a.comp.length - b.comp.length);
  let best = null;
  const consider = (comp) => {
    const total = comp.length + overhead;
    if (best === null || total < best.total) best = { comp, total };
  };
  for (const { idx } of screened.slice(0, 2)) {
    for (const setting of DEFLATE_SETTINGS) consider(deflateSync(bufs[idx], setting));
  }
  const bruteRaw = bruteRefine(form.samples, width, height, form.bpp);
  consider(deflateSync(bruteRaw, DEFLATE_SETTINGS[0]));
  consider(deflateSync(bruteRaw, DEFLATE_SETTINGS[1]));
  consider(deflateSync(bruteRaw, DEFLATE_SETTINGS[2]));
  return best;
}

/** The smallest lossless PNG of an RGBA image. */
function squeeze(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const { comp, total } = encodeForm(form, width, height);
    if (best === null || total < best.total) best = { form, comp, total };
  }
  const chunks = [['IHDR', ihdrOf(width, height, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', new Uint8Array(best.comp)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/* ------------------------------------------------------------------ */
/* Entry point: every instance in /input, every answer in /output.     */
/* ------------------------------------------------------------------ */

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
