// gameLocator.js
// Finds the user's own Slay the Spire 2 install so the local compiler can
// reference sts2.dll / GodotSharp.dll / 0Harmony.dll from it. We NEVER copy
// these files into the app, ship them, or send them anywhere — we only read
// their path and hand that path to `dotnet build` as a local HintPath
// reference, exactly like the real ModTemplate-StS2 project file does
// (see TOOLCHAIN_FINDINGS.md).
//
// UPDATED after inspecting a real install: STS2's Windows layout is
//   <install root>\data_sts2_windows_x86_64\{sts2,GodotSharp,0Harmony}.dll
//   <install root>\mods\<ModName>\
// confirmed directly against a real game folder. The macOS/Linux data-dir
// names below follow Godot's normal per-export-target naming convention but
// are NOT independently confirmed against a real install on those OSes —
// flagged BEST EFFORT.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Candidate *install roots* (the folder that directly contains `mods/`),
// not the data dir itself — kept consistent across OSes so callers always
// get one thing (the root) plus a separately-resolved data dir.
function candidateRoots() {
  const home = os.homedir();
  const plat = process.platform;

  if (plat === 'win32') {
    // [VERIFIED] against a real Windows install.
    return [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Slay the Spire 2',
      'C:\\Program Files\\Steam\\steamapps\\common\\Slay the Spire 2',
      path.join(home, 'Steam', 'steamapps', 'common', 'Slay the Spire 2'),
    ];
  }
  if (plat === 'darwin') {
    // [BEST EFFORT] — not verified against a real macOS install.
    return [
      path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Slay the Spire 2'),
    ];
  }
  // linux [BEST EFFORT]
  return [
    path.join(home, '.steam', 'steam', 'steamapps', 'common', 'Slay the Spire 2'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Slay the Spire 2'),
  ];
}

// Per-OS data dir folder name, sibling of `mods/` under the install root.
// Only the Windows name is verified; the others are Godot's standard export
// naming convention applied by inference.
function dataDirNames() {
  if (process.platform === 'darwin') return ['data_sts2_macos_arm64', 'data_sts2_macos_x64'];
  if (process.platform === 'win32') return ['data_sts2_windows_x86_64'];
  return ['data_sts2_linuxbsd_x86_64'];
}

// Shallow recursive search for a file by exact lowercase name, depth-limited
// since we don't know the precise relative path on every OS/layout.
function findFileUnder(dir, fileName, depth = 3) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) {
      return path.join(dir, e.name);
    }
  }
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory()) {
        const found = findFileUnder(path.join(dir, e.name), fileName, depth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function findDllUnder(dir, depth = 2) {
  return findFileUnder(dir, 'sts2.dll', depth);
}

// Returns { found, dllPath, gameDataDir, sts2GamePath, modsDir } — never
// throws, since "not found" (custom install location, game not installed
// yet) is an expected, common state the UI should handle gracefully.
function locateGame() {
  for (const root of candidateRoots()) {
    // Try the known data-dir names first (fast path), fall back to a
    // shallow search of the whole root if the naming guess is wrong.
    for (const dataDirName of dataDirNames()) {
      const guess = path.join(root, dataDirName);
      if (fs.existsSync(path.join(guess, 'sts2.dll'))) {
        return resultFor(root, path.join(guess, 'sts2.dll'));
      }
    }
    const dllPath = findDllUnder(root);
    if (dllPath) return resultFor(root, dllPath);
  }
  return { found: false, dllPath: null, gameDataDir: null, sts2GamePath: null, modsDir: null };
}

function resultFor(sts2GamePath, dllPath) {
  return {
    found: true,
    dllPath,
    gameDataDir: path.dirname(dllPath),
    sts2GamePath,
    modsDir: path.join(sts2GamePath, 'mods'),
  };
}

// Given a manually-provided install root, resolve the same shape locateGame() returns.
function locateGameAt(root) {
  const dllPath = findDllUnder(root);
  if (!dllPath) return { found: false, dllPath: null, gameDataDir: null, sts2GamePath: root, modsDir: null };
  return resultFor(root, dllPath);
}

// [VERIFIED] BaseLib installs into the mods folder as a normal mod, same as
// any character mod: <modsDir>/BaseLib/BaseLib.dll (+ .pck + .json). If the
// user already has it there (confirmed against a real install), we can
// reference that exact DLL directly via HintPath at build time instead of
// an unverified NuGet package id — see TOOLCHAIN_FINDINGS.md's "Update
// after inspecting BaseLib.dll directly".
function findBaseLibDll(modsDir) {
  if (!modsDir) return null;
  const guess = path.join(modsDir, 'BaseLib', 'BaseLib.dll');
  return fs.existsSync(guess) ? guess : null;
}

// release_info.json lives at the install root — sibling of `mods/` and the
// data_sts2_* folder — a real build manifest the game itself writes, not
// anything Forge generates. CONFIRMED against Tyler's own real install:
//   { "commit": "41cef1ea", "version": "v0.111.0",
//     "date": "2026-08-13T17:39:18-07:00", "branch": "v0.111.0",
//     "main_assembly_hash": 222455745 }
// Note the "branch" field's value there is the version tag itself
// ("v0.111.0"), not the word "beta" — Tyler's Steam beta branch happens to
// currently be pinned to that build, so the devs appear to tag internal
// branches by version rather than by Steam's beta/default label. We use
// this field verbatim rather than trying to translate it, since it's the
// exact, unambiguous build identifier either way. Defensive: a missing or
// malformed file just means "no release info available" — never throws,
// same convention as locateGame()/locateGameAt() above.
function readReleaseInfo(sts2GamePath) {
  if (!sts2GamePath) return null;
  const p = path.join(sts2GamePath, 'release_info.json');
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

// [New] "if the game gets an update that breaks the character creator,
// there should be a prompt to update the application" (Tyler). Forge has
// no way to know WHETHER a given update actually broke anything (that
// takes a real re-verification pass, same manual decompile-and-confirm
// work every research round in this project already does) — what it CAN
// do cheaply and reliably is notice that the game's own installed build no
// longer matches the build Forge was last verified against, and say so,
// rather than silently compiling against untested ground.
//
// verifiedGameVersion.json (sibling of this file) holds a SNAPSHOT of
// release_info.json's own fields from whenever a research round last
// confirmed Forge's generated code still matches a real, freshly-rebuilt
// game install — updated by hand as part of that verification work, not
// automatically. `main_assembly_hash` is release_info.json's own content
// hash of the game's main assembly (not a version STRING) — the most
// robust single field to key a "did the actual game code change" check
// off of, since a version/branch string could theoretically stay the same
// across a hotfix while the assembly itself changed, or vice versa. Falls
// back to comparing version+commit if either snapshot is missing a hash
// (e.g. an older verifiedGameVersion.json saved before this field existed).
let cachedVerifiedSnapshot = null;
function loadVerifiedSnapshot() {
  if (cachedVerifiedSnapshot !== null) return cachedVerifiedSnapshot;
  try {
    const p = path.join(__dirname, 'verifiedGameVersion.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    cachedVerifiedSnapshot = (parsed && typeof parsed === 'object') ? parsed : false;
  } catch {
    cachedVerifiedSnapshot = false; // missing/malformed file — never throws, same convention as the rest of this module
  }
  return cachedVerifiedSnapshot || null;
}

// Returns null when there's nothing to compare (no installed release info,
// or no verified snapshot on file) — the frontend treats null as "nothing
// to warn about," same as every other "not found" shape in this module.
// Otherwise { changed, verified: {version, commit, verifiedAt}, current:
// {version, commit} }.
function compareGameVersion(installedReleaseInfo) {
  const verified = loadVerifiedSnapshot();
  if (!verified || !installedReleaseInfo) return null;
  const haveBothHashes = Number.isFinite(verified.mainAssemblyHash) && Number.isFinite(installedReleaseInfo.main_assembly_hash);
  const changed = haveBothHashes
    ? verified.mainAssemblyHash !== installedReleaseInfo.main_assembly_hash
    : (String(verified.version || '') !== String(installedReleaseInfo.version || '')
       || String(verified.commit || '') !== String(installedReleaseInfo.commit || ''));
  return {
    changed,
    verified: { version: verified.version || null, commit: verified.commit || null, verifiedAt: verified.verifiedAt || null },
    current: { version: installedReleaseInfo.version || null, commit: installedReleaseInfo.commit || null },
  };
}

module.exports = { locateGame, locateGameAt, findDllUnder, findFileUnder, findBaseLibDll, readReleaseInfo, compareGameVersion };
