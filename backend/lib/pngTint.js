// backend/lib/pngTint.js
//
// [Round 119, follow-up to the energy-orb IL investigation] Tyler asked why
// his own custom orb art doesn't change to the character's color in-game.
// Answer, confirmed via full IL disassembly of BaseLib.dll: the energy
// orb's two "color" fields (CustomEnergyCounter.OutlineColor/BurstColor)
// don't retint layer art at all — OutlineColor only recolors the thin ring
// outline (BaseLib.Abstracts.EnergyCounterOutlineColorPatch.Prefix sets it
// as a `ref Godot.Color` on some vanilla outline getter) and BurstColor
// only recolors the particle burst VFX modulate behind the orb
// (NEnergyCounterFactory.FromLegacy: `EnergyVfxBack.Modulate = BurstColor`).
// Neither ever touches the 5 layer textures or the Backdrop. There is no
// real in-game mechanism that retints layer art to a character's color —
// vanilla characters just have their art pre-colored by hand.
//
// Forge's own per-layer "Recolor" tint (see orb.layers[].color in
// character.schema.json) has always been flagged as a LIVE-PREVIEW-ONLY
// effect for exactly this reason: no image-manipulation library was
// available in this backend to bake a flat-color silhouette fill into the
// exported PNG bytes. Tyler asked directly for this to actually work in
// the compiled mod ("Bake Forge's per-layer Recolor tint into the
// export"), so this module adds that — a small, dependency-free PNG
// decoder/encoder (matching this project's own established preference for
// hand-rolled tooling over new npm dependencies that complicate Electron
// packaging — see tools/sts2tools's hand-rolled .pck reader/CIL
// disassembler for the same pattern) plus a tint function that reproduces
// the exact same "alpha channel becomes a mask, RGB becomes a flat color"
// effect as the live preview's CSS mask (see maskedVisualCss in
// frontend/index.html) — so the exported art matches what Forge already
// shows you.
//
// Supports 8-bit, non-interlaced PNGs of color type 6 (RGBA), 2 (RGB,
// treated as fully opaque), 0 (grayscale), and 4 (grayscale+alpha) — this
// covers every bundled Forge asset and every custom upload (uploads always
// go through resizeDataUrlToExact's HTML5 canvas .toDataURL('image/png')
// in frontend/index.html, which always produces a plain 8-bit RGBA,
// non-interlaced PNG). Anything else (16-bit, interlaced, indexed/palette)
// is deliberately NOT supported — decodePNG returns null rather than
// guessing, and every caller in compiler.js falls back to writing the
// original, untinted bytes when that happens, so an unusual upload can
// never break a compile; it just silently keeps its own native colors,
// same as before this round.

const zlib = require('zlib');
const { autoMiddleGradientStops } = require('./colorMath');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- CRC32 (standard PNG chunk checksum) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decodes a PNG buffer to { width, height, rgba: Buffer } (4 bytes/pixel,
// straight, non-premultiplied alpha) or null if it's a shape we don't
// support (see header comment) — callers must treat null as "leave this
// file untinted" rather than throw.
function decodePNG(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idatChunks = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return null;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }
  if (!width || !height) return null;
  if (bitDepth !== 8) return null; // 16-bit / sub-byte not supported
  if (interlace !== 0) return null; // Adam7 not supported
  if (![0, 2, 4, 6].includes(colorType)) return null; // no palette support

  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const srcChannels = channelsByType[colorType];
  const bpp = srcChannels; // 8-bit depth, so bytes-per-pixel == channels

  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  } catch (e) {
    return null;
  }

  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (inflated.length < expected) return null;

  const raw = Buffer.alloc(stride * height);
  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = inflated[inPos]; inPos += 1;
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const raw_x = inflated[inPos + x];
      const a = x >= bpp ? raw[rowStart + x - bpp] : 0;
      const b = y > 0 ? raw[prevRowStart + x] : 0;
      const c = (y > 0 && x >= bpp) ? raw[prevRowStart + x - bpp] : 0;
      let val;
      switch (filterType) {
        case 0: val = raw_x; break;
        case 1: val = raw_x + a; break;
        case 2: val = raw_x + b; break;
        case 3: val = raw_x + Math.floor((a + b) / 2); break;
        case 4: val = raw_x + paeth(a, b, c); break;
        default: return null;
      }
      raw[rowStart + x] = val & 0xff;
    }
    inPos += stride;
  }

  // Expand to straight RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, px = 0; px < width * height; px++, i += bpp) {
    let r, g, b, a;
    if (colorType === 6) { r = raw[i]; g = raw[i + 1]; b = raw[i + 2]; a = raw[i + 3]; }
    else if (colorType === 2) { r = raw[i]; g = raw[i + 1]; b = raw[i + 2]; a = 255; }
    else if (colorType === 4) { r = g = b = raw[i]; a = raw[i + 1]; }
    else /* 0 */ { r = g = b = raw[i]; a = 255; }
    const o = px * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  }
  return { width, height, rgba };
}

function writeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Encodes { width, height, rgba } back to a standard 8-bit RGBA PNG
// (color type 6, filter type None on every scanline — simplicity over
// compression ratio, these are small UI-sized textures).
function encodePNG({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', idat),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Parses '#rrggbb' (or '#rgb') to {r,g,b}. Falls back to opaque grey on a
// malformed value rather than throwing.
function parseHexColor(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 128, g: 128, b: 128 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// The actual tint: replaces every pixel's RGB with the flat color while
// leaving its alpha untouched — same silhouette-fill effect as the live
// preview's CSS mask (maskedVisualCss in frontend/index.html).
function tintRgba(rgba, hexColor) {
  const { r, g, b } = parseHexColor(hexColor);
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r; out[i + 1] = g; out[i + 2] = b; // alpha (i+3) untouched
  }
  return out;
}

// Top-level helper used by compiler.js: tint a PNG buffer to a flat hex
// color, preserving its alpha channel. Returns the ORIGINAL buffer
// unchanged if decoding isn't supported (see decodePNG's header comment)
// — callers never need their own fallback branch.
function tintPngBuffer(buffer, hexColor) {
  const decoded = decodePNG(buffer);
  if (!decoded) return buffer;
  const tinted = tintRgba(decoded.rgba, hexColor);
  try {
    return encodePNG({ width: decoded.width, height: decoded.height, rgba: tinted });
  } catch (e) {
    return buffer;
  }
}

// [Round 119, seventh follow-up] Base is unchanged from the sixth
// follow-up: a plain 2-stop diagonal gradient, dark (bottom-left) to
// light (top-right), reproducing CSS's `to top right` gradient-line
// projection exactly (a pixel's position along the gradient, 0 at the
// bottom-left corner to 1 at the top-right corner, is its projection in
// y-up coordinates onto the direction vector (width, height), normalized
// by width² + height²).
//
// New this round: Tyler annotated a reference image showing 2 small
// highlight shapes on each side and specified their colors directly —
// "The highlighted shapes on the left side should be the same color as
// the inner spinning piece. The highlighted shapes on the right side
// should be the same color as the back spinning piece." (Spin B is the
// smaller/central "inner" swirl, Spin A the larger shape it sits on top
// of — confirmed by extracting both real shapes from Tyler's .pck.)
// These 4 blobs are alpha-blended on top of the base gradient, using the
// SAME `innerHighlight`/`backHighlight` colors autoMiddleGradientStops()
// derives — which are themselves identical to autoLayerColors()'s own
// spinB/spinA tints, not a new invented shade (that's what read as white
// in the previous round). Positions/order match autoMiddleGradient()'s
// CSS layers in frontend/index.html exactly.
const MIDDLE_HIGHLIGHT_SPOTS = [
  { cx: 0.80, cy: 0.36, radius: 0.11, colorKey: 'backHighlight' },  // right
  { cx: 0.73, cy: 0.19, radius: 0.075, colorKey: 'backHighlight' }, // right
  { cx: 0.27, cy: 0.72, radius: 0.09, colorKey: 'innerHighlight' }, // left
  { cx: 0.17, cy: 0.60, radius: 0.12, colorKey: 'innerHighlight' }, // left
];
function tintRgbaMiddleGradient(rgba, width, height, stops) {
  const dark = parseHexColor(stops.dark);
  const light = parseHexColor(stops.light);
  const out = Buffer.from(rgba);
  const denom = (width * width + height * height) || 1;
  const minDim = Math.min(width, height);
  const hasHighlights = stops.innerHighlight && stops.backHighlight;
  const spots = hasHighlights ? MIDDLE_HIGHLIGHT_SPOTS.map(s => ({
    cx: s.cx * width,
    cy: s.cy * height,
    radius: Math.max(1, s.radius * minDim),
    color: parseHexColor(s.colorKey === 'backHighlight' ? stops.backHighlight : stops.innerHighlight),
  })) : [];
  for (let y = 0; y < height; y++) {
    const yUp = height - (y + 0.5); // flip to y-up, origin at bottom-left
    for (let x = 0; x < width; x++) {
      const xPos = x + 0.5;
      let t = (xPos * width + yUp * height) / denom;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      let r = dark.r + (light.r - dark.r) * t;
      let g = dark.g + (light.g - dark.g) * t;
      let b = dark.b + (light.b - dark.b) * t;
      // Overlay any highlight blobs (alpha-blend, same as stacked CSS
      // background layers, first-listed drawn last/on top here too).
      for (let s = spots.length - 1; s >= 0; s--) {
        const spot = spots[s];
        const d = Math.hypot(xPos - spot.cx, (y + 0.5) - spot.cy);
        let a = 1 - d / spot.radius;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        r = spot.color.r * a + r * (1 - a);
        g = spot.color.g * a + g * (1 - a);
        b = spot.color.b * a + b * (1 - a);
      }
      const i = (y * width + x) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      // alpha (i+3) untouched, same as tintRgba
    }
  }
  return out;
}

// Top-level helper used by compiler.js for the Middle layer specifically:
// bakes the same dark-left/light-right + dual-highlight look
// autoMiddleGradient() shows in the live preview, derived from a single
// base hex color. Returns the ORIGINAL buffer unchanged if decoding isn't
// supported, same contract as tintPngBuffer.
function tintPngBufferMiddleGradient(buffer, baseColorHex) {
  const decoded = decodePNG(buffer);
  if (!decoded) return buffer;
  const stops = autoMiddleGradientStops(baseColorHex);
  const tinted = tintRgbaMiddleGradient(decoded.rgba, decoded.width, decoded.height, stops);
  try {
    return encodePNG({ width: decoded.width, height: decoded.height, rgba: tinted });
  } catch (e) {
    return buffer;
  }
}

module.exports = {
  decodePNG, encodePNG, tintPngBuffer, tintRgba, parseHexColor,
  tintRgbaMiddleGradient, tintPngBufferMiddleGradient,
};
