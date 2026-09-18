// backend/lib/colorMath.js
//
// [Round 119] Direct port of frontend/index.html's hexToRgb/rgbToHsl/
// hslToRgb/shiftLightness/autoLayerColors (search that file for the same
// function names) — kept byte-for-byte in sync so the server-side baked
// export of "Build from color" mode matches what Forge's own live preview
// already shows. See that file's own header comment on autoLayerColors for
// Tyler's original spec ("Background should ideally attempt to be the
// color they have selected, with spinA being lighter, spin B being
// somewhere between the background and spinA... front should be darker
// than the background").

function hexToRgb(hex) {
  hex = (hex || '#c1502e').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}
function shiftLightness(hex, deltaL, deltaS) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const l = Math.max(4, Math.min(96, hsl.l + deltaL));
  const s = deltaS !== undefined ? Math.max(0, Math.min(100, hsl.s + deltaS)) : hsl.s;
  const rgb = hslToRgb(hsl.h, s, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}
function autoLayerColors(baseColor) {
  return {
    background: baseColor,
    spinA: shiftLightness(baseColor, 26),
    spinB: shiftLightness(baseColor, 13),
    front: shiftLightness(baseColor, -22),
  };
}

// [Round 119, seventh follow-up] Direct port of frontend/index.html's
// autoMiddleGradient() color math. Tyler, annotating a reference image:
// the left/bottom portion is a darker shade of the base color, the
// right/top portion is a lighter shade — but ALSO: "Inside of both of
// those are 2 more circled areas. Those are the highlighted shapes. The
// highlighted shapes on the left side should be the same color as the
// inner spinning piece. The highlighted shapes on the right side should
// be the same color as the back spinning piece." Confirmed by extracting
// the real compiled Spin A/Spin B art from Tyler's own .pck: Spin B is
// the smaller, more central swirl ("inner"); Spin A is the larger
// spiky shape it sits on top of, visible around/behind it ("back"). So
// the highlight colors are the EXACT same colors autoLayerColors()
// already computes for spinB/spinA (shiftLightness deltas 13 and 26, no
// saturation shift), reused here so the Middle layer's highlights
// visually tie to the real spin pieces instead of introducing a new,
// unrelated color.
//
// [Round 119, eighth follow-up] Tyler, still seeing white on the Middle
// layer after that fix. Two compounding problems in the `dark`/`light`
// base stops, both now fixed:
//   1. `light` had a `-10` saturation delta — a leftover from an earlier
//      version of this gradient designed as a small center highlight,
//      never reconsidered once it became half the whole shape's base
//      color. Dropped entirely (pure lightness shift now).
//   2. Even without that, +36/-32 lightness are LARGE swings — HSL
//      colors converge toward white/black as |L| approaches 100/0
//      regardless of saturation, so a +36 shift on a mid-lightness base
//      color lands close to washed-out pale almost no matter what. And
//      Tyler's own wording was "SLIGHTLY darker"/"SLIGHTLY lighter" —
//      +36/-32 was never a slight shift to begin with. Dialed both back
//      to ±16 (comparable to spinB's own +13, well under spinA's +26 and
//      front's -22), which reads as a clear but genuinely subtle tint
//      shift instead of a near-white/near-black extreme.
// The highlight colors (innerHighlight/backHighlight) are unaffected —
// those are meant to visibly pop as the real Spin B/Spin A colors, not
// blend subtly, and Tyler never flagged them as wrong once matched to
// the real spin-piece colors.
function autoMiddleGradientStops(baseColor) {
  return {
    dark: shiftLightness(baseColor, -16),  // "slightly darker than the background"
    light: shiftLightness(baseColor, 16),  // "slightly lighter than the background"
    innerHighlight: shiftLightness(baseColor, 13), // == autoLayerColors().spinB
    backHighlight: shiftLightness(baseColor, 26),  // == autoLayerColors().spinA
  };
}

module.exports = { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, shiftLightness, autoLayerColors, autoMiddleGradientStops };
