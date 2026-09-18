# Forge — STS2 Character Builder

A **local, downloadable app** for designing custom Slay the Spire 2
characters. Character data lives only in the browser view's `localStorage`;
the backend that compiles it runs on the user's own machine, not a hosted
server, so it can compile against the game files and Godot editor already on
that machine without anyone redistributing them, and without paying for
server-side compute on every export.

That local-first shape was a deliberate choice, not just a default: a
browser-based version of this exact idea already exists and works
(`slay.spencerstiles.com`, the "STS2 Character Mod Creator" — it's what
built the two custom characters this project's own dev machine had sitting
in its `mods/` folder). Going local instead trades that tool's zero-install
convenience for not depending on someone else's hosting/maintenance, and for
not needing to run `dotnet build` + a headless Godot export on a server for
every user's export.

## Read this first: `TOOLCHAIN_FINDINGS.md`

The previous version of this project guessed at the real STS2 modding
toolchain — namespaces, project file shape, manifest format — because that
session never had the actual game files or a real example mod to check
against. This version replaces most of those guesses with facts pulled from
your own game install (decompiling two real, working custom-character mods
already in your `mods/` folder) and a real open-source example mod's
checked-in source. **`TOOLCHAIN_FINDINGS.md` is the receipts** — every claim
in it is tagged `[VERIFIED]` (seen directly) or `[BEST EFFORT]` (inferred,
not confirmed), and the generated C# repeats those same tags inline at the
exact point each guess is made. Read it before touching `compiler.js` or the
templates.

## Layout

```
TOOLCHAIN_FINDINGS.md          verified vs. best-effort facts about the real STS2 modding toolchain
schema/character.schema.json   the data contract — read this first
frontend/index.html            the entire UI (no build step, just open it)
backend/server.js              local /api/compile endpoint + game/Godot detection
backend/gameLocator.js         finds the user's own STS2 install & sts2.dll/GodotSharp.dll/0Harmony.dll
backend/godotLocator.js        finds the user's Godot 4.5.1 Mono EDITOR (needed to export .pck)
backend/compiler.js            JSON -> C# project generator
backend/templates/             .cs / .csproj / export_presets.cfg templates, filled in by compiler.js
electron/                      desktop app shell (spawns backend, opens a window)
```

## Running it in dev (as a web page, fastest iteration loop)

```
cd backend
npm install
npm start          # serves both the API and frontend/ at http://localhost:3000
```

Open `http://localhost:3000`. This is the fastest way to iterate on the UI
and the effect DSL — no Electron rebuild needed for frontend/backend changes.

## Running it as the actual desktop app

```
cd electron
npm install
npm start           # launches the Electron window, which forks backend/server.js itself
```

`electron/main.js` forks `backend/server.js` as a child process on a fixed
local port, points a `BrowserWindow` at it, and kills that child process when
the window closes. Packaging installers (`.dmg` / `.exe` / `.AppImage`) is
`npx electron-builder` from `electron/`, once you're ready to distribute —
config is already in `electron/package.json`.

## Toolchain detection: two separate things now, not one

A real compile needs **both**:
1. **The game itself** (`gameLocator.js`) — for `sts2.dll`, `GodotSharp.dll`,
   and `0Harmony.dll`, all three referenced straight from the game's own
   data folder. `GET /api/game-status` / `POST /api/game-path`, same as
   before.
2. **A separately-downloaded Godot 4.5.1 Mono editor** (`godotLocator.js`) —
   not the game, the actual Godot editor, needed to run
   `godot --headless --export-pack` and produce the `.pck`. This is new:
   the previous session's design never accounted for it, because it never
   got far enough into the real toolchain to find out `dotnet build` alone
   isn't enough — a `.pck` also has to be exported through Godot itself.
   `GET /api/godot-status` / `POST /api/godot-path`, same pattern as the
   game pair. There's no Steam install to anchor auto-detect on for this
   one, so treat the manual override as the realistic common path, not a
   rare fallback — **the frontend doesn't have a status pill for this yet,
   see "what's still stubbed" below.**

Both overrides are in-memory only, never written to disk, and reset on
restart — same privacy posture as before.

## What's real vs. stubbed right now

**Real and working end-to-end:**
- The schema (`character.schema.json`) — cards, relics, mechanics, and the
  effect-block DSL (trigger → condition → action) are fully defined.
- The frontend: one page, no sidebar, click a tile to open a modal editor.
  State round-trips through `localStorage`.
- `compiler.js` generates a **complete** project now, not just cards: mod
  entry point, character, card pool, relic pool, cards, relics, and
  mechanics (custom powers) all get real `.cs` files, plus the `pack/`
  folder's `export_presets.cfg` and the `.csproj` itself.
- Game *and* Godot detection, each with a manual override.
- The privacy guarantee: `server.js` writes to a fresh `os.tmpdir()` folder
  per request and deletes it in a `finally` block.
- `templates/ModProject.csproj.template` is now modeled directly on a real,
  working example mod's `.csproj` (see `TOOLCHAIN_FINDINGS.md`) instead of a
  guess — `net9.0`, `Microsoft.NET.Sdk`, `HintPath` references to the three
  game DLLs, MSBuild targets that auto-generate `project.godot` and the mod
  manifest, and a `PostBuild` target that installs the mod straight into the
  user's own `STS2/mods/<ModName>/` and shells out to Godot for the `.pck`.
  `server.js` drives all of this via `-p:` command-line property overrides
  instead of a `local.props` file.
- If BaseLib is already installed as a mod (`mods/BaseLib/BaseLib.dll`),
  `gameLocator.js`'s `findBaseLibDll()` finds it and `server.js` references
  that exact DLL via `HintPath` instead of an unverified NuGet package id —
  falls back to the NuGet `PackageReference` guess only if it's missing.
- The Electron shell (`electron/`): unchanged, forks the backend, opens a
  window, cleans up the child process on quit.

**Genuinely unverified — compiles, but flagged inline, see
`TOOLCHAIN_FINDINGS.md` → "What's still genuinely unverified" and "Update
after inspecting BaseLib.dll directly":**
- `CustomCardModel`'s constructor signature — a `strings` scan of a real
  installed `BaseLib.dll` now shows card `Cost` is *not* a plain property
  (`GetCost` + `CostField`/`CanonicalCostField` backing members instead),
  so the constructor's `cost: {{cost}}` shape is flagged as **likely wrong**,
  not just unverified — probably the first real compiler error you'll hit.
- `Exhausts`/`Innate` as plain bools are also flagged **likely wrong** —
  BaseLib has `Keywords`/`AddKeyword`/`CustomKeyword(s)` and the base game
  has a real `CardKeyword` enum; almost certainly the actual mechanism, not
  confirmed enough in shape to rewrite yet.
- `CustomCharacterModel`'s `EnergyPerTurn`/`StartingDeck` — `EnergyPerTurn`
  has zero hits anywhere in `BaseLib.dll` (probably not character-settable
  at all); `StartingDeck` also has zero hits (plausibly auto-derived from
  `Rarity.Starter` cards in the pool instead). `StartingRelics` **is**
  confirmed to exist, but plural — the previous singular
  `StartingRelicId` guess was corrected.
- Most relic hook method names beyond `AfterCardPlayed`/`AfterCardDrawn`/
  `AfterCardExhausted`/`AfterSideTurnEnd` (whose *names* are confirmed to
  exist, semantics still guessed) — `OnTurnStart`, `OnCombatStart`,
  `OnKillEnemy`, `OnTakeDamage` map to invented method names.
- Every action beyond `GainBlock` (the one `[VERIFIED]` action, via
  `Creature.GainBlockInternal`) is either `[BEST EFFORT]` (same `...Internal`
  naming convention, unconfirmed) or routes through `ForgeActions.Todo(...)`
  — a deliberate runtime throw, not a silent no-op, for anything with zero
  grounding (hand/energy/gold manipulation, targeting "all enemies" or "a
  random enemy", every condition kind).
- Card upgrades (`OnUpgrade`) — real mechanism unknown, generates a
  `ForgeActions.Todo(...)` stub.
- The manifest's `has_pck`/`has_dll` fields — best-effort guess that the
  game computes these itself rather than the build writing them; the
  richer `dependencies`/`affects_gameplay` shape is generated either way.

**Still stubbed, not attempted yet:**
- **Godot status pill in the frontend.** `godotLocator.js`/`/api/godot-status`/
  `/api/godot-path` exist server-side; `index.html` still only shows one
  status pill (game) from the previous session and has no UI for the Godot
  path yet. This is the most visible remaining gap.
- **`author` / `modVersion` fields in the frontend.** Added to the schema
  (both optional, default to `'Unknown'` / `'1.0.0'`) so the manifest has
  something to put there, but there's no UI to set them yet.
- Art pipeline (portrait, orb layers, card art) — frontend collects file
  inputs but nothing writes them into the generated project's Godot
  resources yet. `TOOLCHAIN_FINDINGS.md` has the three `res://` node-script
  filenames spotted in the decompile (`merchant_character.cs`,
  `rest_site_character.cs`, `rest_site_selection_reticle.cs`) as a starting
  point, but the full asset pipeline is unexplored.
- Real JSON-schema validation (`ajv`) in place of the hand-rolled checks in
  `server.js`.

## Suggested build order from here

1. **Get one real compile working, first — same advice as before, now with
   real inputs instead of guesses to test against.** Install the
   [ModTemplate-StS2](https://github.com/Alchyr/ModTemplate-StS2) dotnet
   templates (or just clone
   [lamali292/sts2_example_mod](https://github.com/lamali292/sts2_example_mod)
   directly) on a machine with the game *and* Godot 4.5.1 Mono installed,
   point `npm start` at it, and try exporting a single trivial card. Expect
   the first errors to land on exactly the things flagged `[BEST EFFORT]`/
   `[UNVERIFIED]` above — `CustomCardModel`'s constructor is the most likely
   first one. Each error you get back is strictly more information than
   this document has right now; feed it back into the relevant
   `templates/*.template` file and `TOOLCHAIN_FINDINGS.md`.
2. **Add the Godot status pill + `author`/`modVersion` fields to
   `index.html`** — the backend already supports both, the frontend just
   hasn't caught up.
3. **Conditions UI**: `compiler.js` generates condition checks, but there's
   still no frontend UI to add them — effect blocks in the modal only
   expose actions.
4. **Art pipeline**: base64 assets from `state.assets` need to land as real
   files in the generated project (`res://` paths Godot expects) and get
   referenced from card/orb/character definitions.
5. **Validation**: swap the hand-rolled checks in `server.js` for real
   JSON-schema validation (e.g. `ajv`) against `character.schema.json`.
6. **Packaging**: once 1–5 feel solid, `npx electron-builder` from
   `electron/` to produce real installers for distribution.

## End-user experience — deliberately deferred, not forgotten

Right now, actually *using* Forge to export a character requires the same
four things development does: the .NET 9 SDK, the game, BaseLib, and a
Godot 4.5.x editor (MegaDot or vanilla) all installed separately. That's a
real gap between this and the pitch of "download an app, make a character"
— it's currently closer to "set up a modding toolchain, then make a
character." Decided (2026-08-17) to hold off on closing that gap until step
1 above is actually solid — no point smoothing onboarding for a compile
step that doesn't work yet. Options on the table for later, roughly in order
of effort:

1. Do nothing — frame Forge as a tool for people already set up to mod
   STS2, which is arguably most of the real audience anyway.
2. Auto-install BaseLib into the user's mods folder on first run instead of
   asking them to do it manually — small, low-risk, but check BaseLib's
   `LICENSE.txt` first to confirm redistribution is actually allowed before
   bundling/auto-placing a copy.
3. Bundle a Godot/MegaDot editor inside the Electron app so the user never
   installs one separately. Vanilla Godot is MIT-licensed so that's likely
   fine; MegaDot's redistribution terms haven't been checked.
4. Bundle the .NET SDK too, or further, replace the `dotnet build`/
   MSBuild-project approach with driving Roslyn directly against the
   referenced DLLs — removes the last "install an SDK" requirement, but is
   a real rewrite of the compile step, not a packaging tweak.

## A deliberate constraint worth keeping

Every new action/condition/trigger you add needs an entry in both the
frontend's option lists (`ACTION_TYPES` etc. in `index.html`) *and* a
matching branch in `compiler.js` (`actionToCSharp` / `conditionToCSharp` /
`TRIGGER_HOOKS`). `compiler.js` throws loudly (in JS, at generation time) if
a mapping is missing entirely, and the generated C# throws loudly (at
runtime, via `ForgeActions.Todo`/`TodoCondition`) if a mapping exists but has
no verified implementation yet — keep both behaviors. A card that "compiles"
but silently does nothing, or confidently calls a method that doesn't exist,
is a much worse bug to chase than a build failure or a clear runtime
exception that points straight at the unverified case.
