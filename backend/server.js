// server.js
// Stateless compile endpoint. No database, no filesystem persistence beyond
// a per-request temp directory that is deleted in the `finally` block below —
// that's the entire "we save nothing server-side" guarantee, enforced in code
// rather than just promised in a privacy note.

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { execFile } = require('child_process');
const { generateProject } = require('./compiler');
const { validateCharacterPackage } = require('./validate');
const { locateGame, locateGameAt, findFileUnder, findBaseLibDll, readReleaseInfo, compareGameVersion } = require('./gameLocator');
const { locateGodot } = require('./godotLocator');

const app = express();
app.use(express.json({ limit: '15mb' })); // generous-ish, for base64 art assets
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// In-memory only — if auto-detection misses, the user can point us at the
// right paths from the UI. Never written to disk: on restart this resets to
// null and we re-detect. Two separate overrides now, since a real compile
// needs BOTH the game (for sts2.dll/GodotSharp.dll/0Harmony.dll) and a
// separately-downloaded Godot 4.5.1 Mono EDITOR (to export the .pck) — see
// TOOLCHAIN_FINDINGS.md. The previous session's design only knew about the
// game half of this.
let manualGameDir = null;
let manualGodotPath = null;

function currentGame() {
  const result = manualGameDir ? { ...locateGameAt(manualGameDir), source: 'manual' } : { ...locateGame(), source: 'auto' };
  result.baseLibDllPath = result.found ? findBaseLibDll(result.modsDir) : null;
  // Tyler: "lets auto fill that branch field with the available field from
  // the game files as soon as the application picks up a valid game
  // installed." release_info.json lives at the install root — see
  // gameLocator.readReleaseInfo's comment for the real field shape and the
  // "branch" field's actual value. null when not found/unreadable, same
  // as every other field on this response — the frontend already handles
  // `found:false` gracefully, this is no different.
  result.releaseInfo = result.found ? readReleaseInfo(result.sts2GamePath) : null;
  // "if the game gets an update that breaks the character creator, there
  // should be a prompt to update the application" (Tyler) — see
  // gameLocator.compareGameVersion's own comment for what this actually
  // checks (a snapshot/hash mismatch, not a real "did anything break"
  // test) and backend/verifiedGameVersion.json for the stored baseline.
  // null (same "nothing to report" shape as every other field here) when
  // there's no game found or no verified snapshot on file yet.
  result.gameVersionCheck = result.releaseInfo ? compareGameVersion(result.releaseInfo) : null;
  return result;
}
function currentGodot() {
  if (manualGodotPath) return { found: true, godotExePath: manualGodotPath, source: 'manual' };
  return { ...locateGodot(), source: 'auto' };
}

// GET /api/game-status — lets the frontend show "found your install" /
// "point me at it" without the user having to know any of this exists
// until it's relevant.
app.get('/api/game-status', (req, res) => res.json(currentGame()));

app.post('/api/game-path', (req, res) => {
  const { gameDir } = req.body || {};
  if (!gameDir || !fs.existsSync(gameDir)) {
    return res.status(400).json({ error: 'That path does not exist.' });
  }
  const check = locateGameAt(gameDir);
  if (!check.found) {
    return res.status(400).json({ error: "Couldn't find sts2.dll under that folder — point me at your STS2 install root." });
  }
  manualGameDir = gameDir;
  res.json({ ok: true, ...check });
});

// GET /api/godot-status / POST /api/godot-path — same pattern as the game
// pair above, for the Godot 4.5.1 Mono EDITOR (not the game) needed to run
// `--export-pack`. There's no Steam install to anchor auto-detect on here,
// so a manual override is the realistic common path, not just a fallback.
app.get('/api/godot-status', (req, res) => res.json(currentGodot()));

app.post('/api/godot-path', (req, res) => {
  const { godotExePath } = req.body || {};
  if (!godotExePath || !fs.existsSync(godotExePath)) {
    return res.status(400).json({ error: 'That path does not exist.' });
  }
  manualGodotPath = godotExePath;
  res.json({ ok: true, godotExePath });
});

// One consolidated README.md written into every compile's output zip.
// Replaces the old scattered BUILD_FAILED.txt/GAME_NOT_FOUND.txt/
// INSTALLED.txt (same build-outcome info, now one file) and adds what
// those never had: the real game build this was made against, and the
// full character-art export report (see compiler.js's writeCharacterArt).
function buildTopReadme({ characterPackage, modId, game, godot, compiled, buildErrMessage, installedDir, artReport }) {
  const ch = characterPackage.character || {};
  const lines = [];
  lines.push(`# ${ch.name || modId} — Forge export`);
  lines.push('');
  lines.push(`Generated by Forge on ${new Date().toISOString()}.`);
  lines.push('');

  lines.push('## Build outcome');
  lines.push('');
  if (compiled) {
    lines.push(`Compiled successfully and installed directly into:`);
    lines.push('');
    lines.push('```');
    lines.push(installedDir || '(unknown path)');
    lines.push('```');
    lines.push('');
    lines.push('It should already be playable next time you launch Slay the Spire 2. A copy of');
    lines.push(`the same .dll/.pck/.json is included in this zip in the \`${modId}/\` folder — drag`);
    lines.push('that whole folder into another computer\'s Slay the Spire 2 `mods/` directory to');
    lines.push('install it there (for sharing or backup); it contains nothing but the .dll/.pck/.json');
    lines.push('the game itself looks for, same as any other installed mod folder.');
  } else if (buildErrMessage) {
    lines.push('`dotnet build` failed — this zip contains generated C# source only, not a compiled mod:');
    lines.push('');
    lines.push('```');
    lines.push(buildErrMessage);
    lines.push('```');
    lines.push('');
    lines.push('Generated C# source is included for inspection. Several parts of this generator');
    lines.push('are BEST EFFORT / not yet verified against real BaseLib source (see');
    lines.push('TOOLCHAIN_FINDINGS.md in the Forge repo) — a constructor or method-signature');
    lines.push('mismatch here is expected on a first real build, not a sign anything is broadly wrong.');
  } else {
    const missing = [];
    if (!game.found) missing.push('your Slay the Spire 2 install (set it via the game status pill)');
    if (!godot.found) missing.push('your Godot 4.5.1 Mono editor, needed to export the .pck (set it via the Godot status pill)');
    lines.push(`Couldn't find: ${missing.join(' and ')}. This zip contains generated C# source only`);
    lines.push('(not a compiled mod). Set the missing path(s) in Forge and export again.');
  }
  lines.push('');

  lines.push('## Built against');
  lines.push('');
  if (game.found) {
    lines.push(`- **Game install:** \`${game.sts2GamePath}\``);
    if (game.releaseInfo) {
      const ri = game.releaseInfo;
      lines.push(`- **Game version:** ${ri.version || '(unknown)'}`);
      lines.push(`- **Game branch:** ${ri.branch || '(unknown)'}${ch.branch && ch.branch !== ri.branch ? ` (character's own "Target branch" note says "${ch.branch}" — see character.branch below)` : ''}`);
      if (ri.commit) lines.push(`- **Game commit:** ${ri.commit}`);
    } else {
      lines.push('- **Game version:** unknown — no `release_info.json` found at the install root.');
    }
  } else {
    lines.push('- Game install not found at compile time — version/branch unknown.');
  }
  if (ch.branch) lines.push(`- **Character's own "Target branch" note:** ${ch.branch} (free text Tyler/you typed into Forge, not necessarily the same as the detected branch above)`);
  lines.push('');

  lines.push('## Character art');
  lines.push('');
  lines.push('What actually made it into the compiled mod vs. what stayed a Forge-only preview —');
  lines.push('see TOOLCHAIN_FINDINGS.md for the full disassembly trail behind every line below.');
  lines.push('');
  (artReport || []).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Reimporting this character into Forge');
  lines.push('');
  lines.push('See `Forge_Project/character_project.json` (and its own README) in this zip —');
  lines.push('a full copy of everything you had entered in Forge, not just what compiled.');
  lines.push('Open Forge, click **Import project**, and select that file to keep editing.');
  lines.push('');

  return lines.join('\n');
}

app.post('/api/compile', async (req, res) => {
  const characterPackage = req.body;

  // --- real validation, not just a shape check ---
  // Was: "minimal shape validation (swap for full ajv/schema validation)" —
  // this is that swap, done as hand-rolled JS (see validate.js's header for
  // why) instead of an ajv dependency. Caught by a real stress test: cost
  // -5, a card's "Passive" trigger silently discarded, a relic's
  // meaningless "OnPlay" trigger, and ExhaustCard targeting AllEnemies all
  // used to sail straight through to generateProject() and produce
  // silently-wrong (or misleadingly successful) generated C#. Now rejected
  // here, up front, with the full list of what's wrong in one response.
  const { valid, errors } = validateCharacterPackage(characterPackage);
  if (!valid) {
    // Round 20 — Tyler: "make the errors that the compiler throws a bit
    // more legible." Used to be one formatted plain-text blob
    // (`res.send(...)`), which the frontend could only show verbatim in a
    // raw alert() — no way to group by entity or jump to the thing that's
    // actually wrong. Real JSON now, so frontend/index.html's
    // showCompileErrorModal can parse/group structurally instead of
    // regex-scraping bullet lines. A frontend older than this round (not
    // yet re-fetched) still gets a real error either way — its try/catch
    // around res.json() falls back to res.text() on anything that isn't
    // valid JSON, and this stays a well-formed error response regardless.
    return res.status(400).json({ errors });
  }

  const requestId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `forge-${requestId}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    // Looked up BEFORE generateProject() now (Round 28 ground-up audit) so
    // its real release_info.json version can be stamped into the mod
    // manifest's new min_game_version field — the real official template's
    // own manifest (Alchyr.Sts2.Templates' ModTemplate.json) always
    // includes this field; Forge's never did. currentGame() is a cheap,
    // synchronous filesystem check (no heavy work), safe to call this much
    // earlier than the actual compile step below.
    const game = currentGame();

    // 1. Generate the full C# project + pack/ folder from the JSON package.
    const gameVersion = game.releaseInfo && typeof game.releaseInfo.version === 'string'
      ? game.releaseInfo.version.replace(/^v/i, '') // "v0.111.0" -> "0.111.0", matching the real template's unprefixed manifest field
      : null;
    const { modId, artReport } = generateProject(characterPackage, tempDir, { gameVersion });

    // 2. Try to compile for real, using the game + Godot editor found on
    //    this machine — never a copy we ship. Running locally is what makes
    //    this possible without a hosted service needing its own licensed
    //    copy of sts2.dll (or, per TOOLCHAIN_FINDINGS.md, a compute budget
    //    for `godot --export-pack` on every request).
    const godot = currentGodot();

    let compiled = false;
    let buildErrMessage = null;
    if (game.found && godot.found) {
      try {
        await buildProject(tempDir, game, godot.godotExePath, modId);
        compiled = true;
      } catch (buildErr) {
        // Don't fail the whole request — fall back to shipping source so
        // the user still gets *something* useful, plus the real error.
        console.warn(`[compile ${requestId}] dotnet build failed, falling back to source-only zip:`, buildErr.message);
        buildErrMessage = buildErr.message;
      }
    }

    // 3. If compiled, the real build also installed the mod straight into
    //    this machine's STS2/mods/<ModId>/ folder (that's what the verified
    //    csproj's PostBuild target does) — pull a copy of exactly those
    //    files into tempDir so the zip we stream back matches what's live.
    let installedDir = null;
    if (compiled) {
      installedDir = path.join(game.sts2GamePath, 'mods', modId);
      // FIXED (Tyler report: "the files that it outputs inside of the zip
      // are not in the correct file format. it should only contain the
      // json, the pck, and the dll for the character in order for the
      // game to recognize it") — this used to land at
      // tempDir/output/<modId>/, one level deeper than a real
      // mods/<modId>/ folder. Now it sits directly at tempDir/<modId>/ so
      // the zip step below can hand the user a folder that IS a real
      // mods/<modId>/ folder, not one nested inside another.
      const outDir = path.join(tempDir, modId);
      fs.mkdirSync(outDir, { recursive: true });
      for (const ext of ['dll', 'pck', 'json']) {
        const src = path.join(installedDir, `${modId}.${ext}`);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, `${modId}.${ext}`));
      }
    }

    // 3b. One consolidated README.md instead of the old scattered
    //     BUILD_FAILED.txt/GAME_NOT_FOUND.txt/INSTALLED.txt — Tyler:
    //     "Ideally any important info should be added to a readme file in
    //     the output folder. stuff like what version of the game the
    //     character was made for." Covers build outcome (same info the 3
    //     old files carried, just in one place now) PLUS what the old
    //     files never had: which real game/Godot build this was compiled
    //     against (from release_info.json — see gameLocator.readReleaseInfo)
    //     and the full character-art export report from writeCharacterArt.
    fs.writeFileSync(path.join(tempDir, 'README.md'),
      buildTopReadme({ characterPackage, modId, game, godot, compiled, buildErrMessage, installedDir, artReport }));

    // 4. Zip the result. FIXED (Tyler report: "the files that it outputs
    //    inside of the zip are not in the correct file format... it
    //    should only contain the json, the pck, and the dll... in order
    //    for the game to recognize it") — a successful compile used to
    //    zip the ENTIRE tempDir: raw generated C# source, mod.csproj, the
    //    full pack/ Godot project (including its own .godot/ build
    //    cache), bin/, obj/ — none of it needed to install the mod — with
    //    the actual installable .dll/.pck/.json buried a level deep
    //    inside output/<modId>/. Dragging that whole zip into a mods
    //    folder produced a folder full of noise with the 3 files the game
    //    actually needs nested in the wrong place. Now, on a successful
    //    compile, the zip contains ONLY: README.md, Forge_Project/ (so
    //    re-importing into Forge later still works, same as before), and
    //    a top-level <modId>/ folder holding exactly
    //    <modId>.dll/.pck/.json — the same shape as a real
    //    mods/<modId>/ folder, so "drag this folder into your mods
    //    directory" is literally true. The failure-path zip (raw source,
    //    for inspecting why a build failed) is untouched — a
    //    deliberately different, already-working case Tyler didn't report
    //    an issue with.
    res.attachment(`${modId || 'custom_character'}${compiled ? '' : '_source'}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);
    if (compiled) {
      archive.file(path.join(tempDir, 'README.md'), { name: 'README.md' });
      const forgeProjectDir = path.join(tempDir, 'Forge_Project');
      if (fs.existsSync(forgeProjectDir)) archive.directory(forgeProjectDir, 'Forge_Project');
      const installDir = path.join(tempDir, modId);
      if (fs.existsSync(installDir)) archive.directory(installDir, modId);
    } else {
      archive.directory(tempDir, false);
    }
    await archive.finalize();

  } catch (err) {
    console.error(`[compile ${requestId}] failed:`, err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  } finally {
    // Always clean up, whether the request succeeded or failed.
    fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
});

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      // BUG FIX: `dotnet build`'s actual compiler diagnostics (the useful
      // part — file, line, CS#### code, message) print to STDOUT, not
      // stderr. The previous version of this only used `stderr`, which for
      // a failed build is often empty or just a generic "process exited
      // with code 1" — so BUILD_FAILED.txt was showing the command that
      // ran instead of why it failed. Include both, stdout first since
      // that's where the actual error almost always is.
      if (err) reject(new Error([stdout, stderr].filter(Boolean).join('\n\n').trim() || err.message));
      else resolve(stdout);
    });
  });
}

// Invokes `dotnet build`, passing game/Godot paths as MSBuild command-line
// properties instead of writing a local.props file — see
// TOOLCHAIN_FINDINGS.md for why -p: overrides are safe to rely on here
// (they take precedence over both the csproj's own Condition-guarded
// defaults and any later plain-assigned property in the same file, like
// ModsOutputDir, which is what lets this install for real into the user's
// own mods folder without us needing to touch that property at all).
async function buildProject(tempDir, game, godotExePath, modName) {
  const csprojPath = path.join(tempDir, 'mod.csproj');
  const args = [
    'build', csprojPath,
    '-c', 'Release',
    `-p:STS2GamePath=${game.sts2GamePath}`,
    `-p:GameDataDir=${game.gameDataDir}`,
    `-p:GodotExePath=${godotExePath}`,
  ];
  // If the user already has BaseLib installed as a mod, reference that exact
  // DLL instead of relying on the unverified NuGet package id — see
  // TOOLCHAIN_FINDINGS.md and ModProject.csproj.template.
  const baseLibDllPath = findBaseLibDll(game.modsDir);
  if (baseLibDllPath) args.push(`-p:BaseLibDllPath=${baseLibDllPath}`);
  // Explicit maxBuffer: MSBuild/Godot export output can be verbose, and
  // Node's execFile default (1MB) could truncate a real error in the
  // middle of a wall of restore/build noise.
  await run('dotnet', args, { maxBuffer: 20 * 1024 * 1024 });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Forge backend listening on :${PORT}`));
