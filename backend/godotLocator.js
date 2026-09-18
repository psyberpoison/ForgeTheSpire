// godotLocator.js
// Finds the user's Godot EDITOR — a separate download from the game itself,
// needed only to run `godot --headless --export-pack` as part of the real
// build (see TOOLCHAIN_FINDINGS.md, "The project file"). This did not exist
// as a concept in the previous session's design; the earlier scaffold only
// ever looked for the game.
//
// [VERIFIED] the version matters, and it is NOT "whatever's newest" — the
// game's own generated `project.godot` (see ModProject.csproj.template's
// GenerateProjectGodot target) pins `config/features=PackedStringArray("4.5",
// "Forward Plus")`, and an independent community source (a modding
// tutorial's "verified baseline" table, cross-checked against a real STS2
// release) confirms "Main PCK format: Godot 4.5.1". Godot's .pck resource
// format is not guaranteed compatible across minor engine versions (4.5 vs.
// 4.6 vs. 4.7), and the game ships its own `GodotSharp.dll` built against
// 4.5.x — so a newer editor (4.7.x etc.) exporting the .pck is a real risk
// of producing something the game's own bundled (older) engine can't load
// correctly, not just an untested combination. Stick to the 4.5.x line.
//
// Two known-good sources for that:
//   1. MegaCrit's own custom build, "MegaDot" — https://megadot.megacrit.com/
//      — described by community docs as "a custom build of the Godot game
//      engine that Slay the Spire 2 is built on. It is used to package your
//      mod's resources." Likely the safest choice since it's MegaCrit's own.
//   2. Vanilla Godot 4.5.1 "Mono"/".NET" build from godotengine.org's
//      archive — also confirmed working by at least one other example mod's
//      setup instructions.
//
// Unlike sts2.dll, there's no Steam install to anchor a search on — the
// user downloads and extracts either of the above wherever they like.
// Auto-detect here is a best-effort convenience (a few common extraction
// spots, matching either naming convention), not something to rely on; the
// UI's manual "point me at it" override is the real fallback path,
// mirroring how gameLocator.js already handles a missed auto-detect.

const fs = require('fs');
const os = require('os');
const path = require('path');

function candidateDirs() {
  const home = os.homedir();
  const plat = process.platform;
  const dirs = [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Godot'),
    home,
  ];
  if (plat === 'win32') {
    dirs.push('C:\\Godot', 'C:\\Program Files\\Godot', 'C:\\Program Files (x86)\\Godot');
  } else if (plat === 'darwin') {
    dirs.push('/Applications');
  } else {
    dirs.push('/opt/godot', '/usr/local/bin', path.join(home, '.local', 'share', 'godot'));
  }
  return dirs;
}

// A vanilla Godot Mono editor executable name looks like:
//   Windows: Godot_v4.5.1-stable_mono_win64.exe
//   macOS:   Godot_mono.app (a bundle) or Godot.app
//   Linux:   Godot_v4.5.1-stable_mono_linux.x86_64
// [VERIFIED] MegaCrit's "MegaDot" build follows the exact same convention,
// just with "MegaDot" swapped in for "Godot" — confirmed against a real
// download: `MegaDot_v4.5.1-stable_mono_win64.exe`. Note that name does
// NOT contain the substring "godot" (MegaDot ≠ ...ga-DOT...), which is
// exactly why this checks for "megadot" as its own separate case below
// rather than relying on the vanilla check to catch it too.
function looksLikeGodotEditorExecutable(name) {
  const lower = name.toLowerCase();
  const isVanillaGodotMono = lower.includes('godot') && lower.includes('mono');
  const isMegaDot = lower.includes('megadot');
  if (!isVanillaGodotMono && !isMegaDot) return false;
  if (process.platform === 'win32') return lower.endsWith('.exe');
  if (process.platform === 'darwin') return lower.endsWith('.app');
  return true; // linux binaries usually have no extension
}

function searchDir(dir, depth = 2) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if ((e.isFile() || e.isDirectory()) && looksLikeGodotEditorExecutable(e.name)) {
      return path.join(dir, e.name);
    }
  }
  if (depth > 0) {
    for (const e of entries) {
      // Don't descend into huge/system dirs unprompted.
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const found = searchDir(path.join(dir, e.name), depth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// Returns { found, godotExePath, source: 'auto' } — never throws.
function locateGodot() {
  for (const dir of candidateDirs()) {
    const found = searchDir(dir);
    if (found) return { found: true, godotExePath: found };
  }
  return { found: false, godotExePath: null };
}

module.exports = { locateGodot };
