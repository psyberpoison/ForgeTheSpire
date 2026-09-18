# STS2 modding toolchain — verified findings

This document replaces guesswork from the first Forge session with facts pulled
from three sources, in order of trust:

1. **Your own game install** (`Slay the Spire 2/`) — `strings` output from the
   two real compiled character mods already in your `mods/` folder
   (`TheBurdenedNewCharacter`, `TheTrainerNewCharacter`), which were built by
   the existing `slay.spencerstiles.com` "STS2 Character Mod Creator" tool.
2. **A real, working example mod repo**: [lamali292/sts2_example_mod](https://github.com/lamali292/sts2_example_mod)
   — small, minimal, and (unlike the character-creator output) has readable
   source checked in. This is the single best source in this document because
   it's uncompiled, verified-working source, not a decompile or a wiki
   paraphrase.
3. **BaseLib / ModTemplate-StS2 wiki pages** ([Alchyr/BaseLib-StS2](https://github.com/Alchyr/BaseLib-StS2),
   [Alchyr/ModTemplate-StS2](https://github.com/Alchyr/ModTemplate-StS2)) —
   fetched through a summarizing tool, so treat prose descriptions here as
   lower-confidence than the verbatim code blocks.

Every claim below is tagged **[VERIFIED]** (seen directly, verbatim) or
**[BEST EFFORT]** (inferred from a paraphrase or from identifier names only,
not confirmed against real source). Nothing here has been run through an
actual `dotnet build` yet — that's still the next real validation step, see
the bottom of this file.

## The project file — [VERIFIED]

The old `ModProject.csproj.template` guessed `Godot.NET.Sdk/4.x` and
`net8.0`, and referenced only `sts2.dll`. The real one
([raw source](https://raw.githubusercontent.com/lamali292/sts2_example_mod/main/ExampleMod.csproj)):

- SDK is plain **`Microsoft.NET.Sdk`**, not a Godot-specific SDK.
- **`net9.0`**, `PlatformTarget=x64`, nullable + implicit usings enabled.
- References **three** DLLs via `HintPath`, all pulled straight from the
  game's own data folder (`data_sts2_windows_x86_64/`, which is a sibling of
  `mods/` in your STS2 install) — not from NuGet:
  - `0Harmony.dll`
  - `GodotSharp.dll`
  - `sts2.dll`
- Paths are supplied by an MSBuild property `STS2GamePath`, with an
  `Import Project="local.props"` for the user's own path plus an in-file
  `Condition="'$(...)' == ''"` fallback default. Because `local.props` is
  just conditionally-defaulted properties, our backend can skip the file
  entirely and pass `-p:STS2GamePath=... -p:GodotExePath=...` on the
  `dotnet build` command line — MSBuild global properties from `-p:` win
  over both the file default *and* any later in-project assignment (like
  `ModsOutputDir`, which is plain-assigned, not conditioned — a `-p:` value
  still overrides it because command-line/global properties can't be
  reassigned by the project file at all).
- Two `BeforeBuild` MSBuild targets **generate `project.godot` and the mod
  manifest JSON at build time** — we don't need to hand-write
  `project.godot` ourselves, the template does it.
- A `PostBuild` target copies the built DLL into
  `$(STS2GamePath)\mods\$(ModName)\` and then shells out to the **Godot
  editor** (not the game) to export the `.pck`:
  `"$(GodotExePath)" --headless --path "$(PackProject)" --export-pack "Windows Desktop" "$(ModsOutputDir)\$(ModName).pck"`

This means our local backend needs the user to have **both**:
- Slay the Spire 2 (already detected by `gameLocator.js`), **and**
- a separately-downloaded **Godot 4.5.1 Mono editor** executable, which the
  old design never accounted for. There's no Steam install to auto-detect
  for this one — see `godotLocator.js` below.

## The manifest — [BEST EFFORT, two different shapes seen]

The example repo's MSBuild-generated `mod_manifest.json` is minimal:
```json
{ "pck_name": "...", "name": "...", "author": "...", "version": "..." }
```
But the **installed** manifests sitting in your `mods/` folder (the ones the
game actually reads at runtime) have more fields:
```json
{
  "id": "TheBurdenedNewCharacter",
  "name": "The Burdened - New Character",
  "author": "Atlas",
  "description": "...",
  "version": "1.0.0",
  "has_pck": true,
  "has_dll": true,
  "dependencies": [{ "id": "BaseLib", "min_version": "3.4.1" }],
  "affects_gameplay": true
}
```
Best-effort read: `has_pck`/`has_dll` are very likely computed by the game
itself when it scans the mods folder on launch, not written by the build —
the minimal example mod (no BaseLib dependency) never shows them because
they aren't source fields at all. `dependencies` only appears on mods that
actually depend on BaseLib. Our generator should emit the richer shape
(`id`, `name`, `author`, `description`, `version`, `dependencies`,
`affects_gameplay`) and simply omit `has_pck`/`has_dll` and let the game
compute those — **this is not confirmed**, flag if a real build's manifest
looks wrong.

## Mod entry point — [VERIFIED]

Every mod needs one class with a Harmony bootstrap
([raw source](https://raw.githubusercontent.com/lamali292/sts2_example_mod/main/ModEntry.cs)):
```csharp
using HarmonyLib;
using MegaCrit.Sts2.Core.Modding;

[ModInitializer("Initialize")]
public class ModEntry
{
    public static void Initialize()
    {
        var harmony = new Harmony("yourmod.patch");
        harmony.PatchAll();
    }
}
```
`MegaCrit.Sts2.Core.Modding` is a real namespace (also seen in the decompiled
mods) and hosts `ModInitializerAttribute`. `HarmonyLib` confirms mods can
(and BaseLib-based ones likely do, per the `Patches/` folder inside
`BaseLib-StS2` and the `TheBurdenedNewCharacter.Patches` namespace found in
the decompile) use Harmony patches directly, not just BaseLib's model
classes.

## Export/pack config — [VERIFIED, static file]

`pack/export_presets.cfg` is a plain committed file, not something Godot has
to regenerate from scratch each time — a single `[preset.0]` /
`[preset.0.options]` block naming the `"Windows Desktop"` platform. We can
ship this verbatim as a static template asset (see
`templates/export_presets.cfg`) and drop it into every generated project's
`pack/` folder unmodified.

## Real namespaces, from decompiling your two installed mods — [VERIFIED
identifiers, BEST EFFORT semantics]

`strings` on `TheBurdenedNewCharacter.dll` gives exact namespace and type
names (no method bodies — that needs a real decompiler, which this sandbox
doesn't have). Confirmed to exist:

```
MegaCrit.Sts2.Core.Modding
MegaCrit.Sts2.Core.Models.Cards
MegaCrit.Sts2.Core.Models.Relics
MegaCrit.Sts2.Core.Models.Powers
MegaCrit.Sts2.Core.Entities.Cards
MegaCrit.Sts2.Core.Entities.Relics
MegaCrit.Sts2.Core.Entities.Powers
MegaCrit.Sts2.Core.Entities.Creatures
MegaCrit.Sts2.Core.Entities.Characters
MegaCrit.Sts2.Core.Entities.Orbs
BaseLib
BaseLib.Abstracts
BaseLib.Utils
```

Base classes confirmed present in the assembly (by exact name string, from
BaseLib): `CustomCardModel`, `CustomCardPoolModel`, `CustomCharacterModel`,
`CustomRelicModel`, `CustomRelicPoolModel`, `CustomPotionPoolModel`,
`CustomPowerModel`.

A mod's own generated code follows this folder/namespace convention (seen in
both installed mods):
```
<ModId>.Cards.<CardName>            e.g. TheBurdenedNewCharacter.Cards.Jab
<ModId>.Relics.<RelicName>
<ModId>.Powers.<PowerName>Power     e.g. FatiguePower, BurdenedPower
<ModId>.Orbs.<OrbName>Orb
<ModId>.Potions.<PotionName>
<ModId>.TokenCards.<TokenName>      mid-combat generated cards
<ModId>.CardPools.<ModId>CardPool   one pool class per character
<ModId>.RelicPools.<ModId>RelicPool
<ModId>.PotionPools.<ModId>PotionPool
<ModId>.Characters.<CharacterName>  the CustomCharacterModel itself
<ModId>.Enchantments.<Name>
<ModId>.Commands.<Name>Cmd
<ModId>.Patches.<Name>
<ModId>.Nodes.<Name>                 Godot visual nodes: merchant_character.cs,
                                      rest_site_character.cs, rest_site_selection_reticle.cs
```

`Card.OnPlay` is **`async Task`, not `void`** — the decompile shows compiler
-generated async state machines (`<OnPlay>d__9`) on every card. Same for
relic hooks. The old template's `public override void OnPlay(...)` is wrong
on both the return type and (likely) the signature shape.

## Real relic hook code — [VERIFIED, full file]

[`ExampleRelic.cs`](https://raw.githubusercontent.com/lamali292/sts2_example_mod/main/Relics/ExampleRelic.cs)
is the single most valuable file found — real, complete, compiling source
for a relic that doesn't even use BaseLib:

```csharp
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Relics;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.ValueProps;

namespace FirstMod.Relics;

public sealed class ExampleRelic : RelicModel
{
    public override RelicRarity Rarity => RelicRarity.Common;
    public override bool IsAllowed(IRunState runState) => true;
    public override bool ShouldReceiveCombatHooks => true;

    public override Task AfterDamageGiven(
        PlayerChoiceContext choiceContext,
        Creature? dealer,
        DamageResult result,
        ValueProp props,
        Creature target,
        CardModel? cardSource)
    {
        if (dealer?.IsPlayer == true && result.TotalDamage > 0)
        {
            dealer.GainBlockInternal(2);
            Flash();
        }
        return Task.CompletedTask;
    }
}
```

Takeaways:
- Hooks are `async Task` overrides taking a typed context
  (`PlayerChoiceContext`, `Creature`, `CardModel?`, `ValueProp`,
  `DamageResult`, `IRunState`), not a generic `ctx` grab-bag like our old
  `compiler.js` invented.
- **`GainBlockInternal(int)` is a real, verified method** on `Creature`.
  This is the one action in our whole effect-block DSL we can now generate
  with full confidence instead of a guess.
- `Flash()` is a base-class visual feedback call.
- `ShouldReceiveCombatHooks` gates whether a relic receives combat hook
  calls at all — our generated relics need to return `true` here whenever
  they have any effect blocks.
- Confirms two parallel ways to add content: plain `RelicModel` (this file,
  no BaseLib) vs. BaseLib's `CustomRelicModel` with a `[Pool(typeof(...))]`
  attribute (seen in the wiki, needed for relics that belong to one specific
  custom character's relic pool rather than being globally available).

## Harmony patch pattern — [VERIFIED, paraphrased]

`Patches/ExamplePatch.cs` in the same repo postfixes `Player.CreateForNewRun`
to inject starting gold and a starting relic. This is a second valid pattern
for character setup (imperative patch) alongside BaseLib's declarative
`CustomCharacterModel` properties — worth knowing about if the declarative
surface turns out to be missing something the character schema needs.

## Update after inspecting BaseLib.dll directly

Tyler installed BaseLib into his `mods/` folder (`mods/BaseLib/BaseLib.dll` +
`.pck` + `.json`) — a normal mod install, same layout as any character mod.
That's the actual library the `Custom*` base classes live in, not just code
that *uses* it, so a `strings`/metadata scan of it is a much stronger source
than decompiling mods that merely reference it. `mods/BaseLib/BaseLib.json`
confirms the installed version directly: `"version": "v3.4.1"` (matches the
`min_version` both real character mods already depend on) and
`"min_game_version": "0.107.1"`.

Enumerating every `get_X`/`set_X` property-accessor string in the DLL and
checking our guesses against that list:

**[CONFIRMED to exist by name]** (semantics still not confirmed without a
real build, but the identifier is real): `Id`, `Name`, `Rarity`, `Target`,
`MaxHp`, `StartingGold`, `CardPool`, `ShouldReceiveCombatHooks`,
`StartingRelics` (**plural** — the schema/template guessed a singular
`StartingRelicId` before this; corrected in `Character.cs.template`),
`CustomCardPoolModel`, `CustomRelicPoolModel`, `CustomPotionPoolModel`,
`CustomTemporaryPowerModel`, `ConstructedCardModel` (an alternative to
`CustomCardModel`, per the wiki — not used here, but real).

**[NOT FOUND anywhere in the DLL — likely wrong or nonexistent]**:
- `EnergyPerTurn` — zero hits. Every `Energy*` string found is UI-related
  (energy counter icons/formatting) or the `GainEnergy` action, nothing
  matching a per-character starting-energy override. Best-effort read:
  characters can't set this in BaseLib; energy-per-turn is probably a fixed
  game constant. `Character.cs.template` no longer emits this as an
  override — the schema still collects it, the generated file just doesn't
  wire it anywhere real yet.
- `Exhausts` / `Innate` as property names — zero hits for `Innate`
  anywhere; the only `Exhaust*` hits are an unrelated *existing* keyword
  called `Exhaustive` (a real STS2 mechanic, not what we meant). Meanwhile
  the DLL has `Keywords`, `AddKeyword`, `CustomKeyword`/`CustomKeywords`,
  and the base game (`sts2.dll`, referenced from BaseLib) has a real
  `CardKeyword` enum in `MegaCrit.Sts2.Core.Entities.Cards`. Best-effort
  read: exhaust/innate are almost certainly expressed as `CardKeyword`
  values added to a `Keywords` collection, not two separate booleans. Not
  rewritten in `Card.cs.template` yet — the exact `Keywords` property shape
  (array vs. list, settable vs. built via `AddKeyword`) isn't confirmed
  enough to guess without risking being wrong in a *different* way. Flagged
  inline in the template instead.
- `StartingDeck` as a property name — zero hits. Plausible read: the
  starting deck isn't a character-level list at all, but derived
  automatically from whichever cards in the character's `CardPool` are
  marked `Rarity.Starter` (the schema already models a `Starter` card
  rarity). `Character.cs.template` still emits a `StartingDeck` override as
  the best available guess, flagged.
- `Cost` as a plain property — zero hits for a simple `Cost` accessor.
  Instead: `GetCost` (with a compiler-generated backing field, i.e.
  `<GetCost>k__BackingField`), `CostField`, `CanonicalCostField`,
  `CostsMoreThanZero`, `CostsX`. Best-effort read: card cost is wrapped in
  some field/modifier object (supporting things like X-cost, cost
  modifiers) rather than being a bare `int` passed straight to a
  constructor. `Card.cs.template`'s constructor-based `cost: {{cost}}` is
  now flagged as **likely wrong in shape**, not just unverified — this is
  probably the single most likely first compiler error.

This is genuinely useful progress (several guesses confirmed, several
specific ones now known to need rework instead of just "maybe wrong") but
still short of a real build — a `strings` scan gives identifier names, not
method bodies, parameter types, or parameter order.

## Which Godot version — 4.5.x, not newer

The `.pck` export step needs a specific Godot line, not "whatever's newest."
Evidence, cross-checked from two independent angles:

1. `ModProject.csproj.template`'s `GenerateProjectGodot` target (verified
   from the real example mod's `.csproj`) writes
   `config/features=PackedStringArray("4.5", "Forward Plus")` into every
   generated `project.godot` — the tool itself expects a 4.5 engine.
2. An independent community source (a different modding tutorial's
   "verified baseline" table, checked against a real STS2 release) lists
   `Main PCK format: Godot 4.5.1`.

Godot's `.pck` resource format is not guaranteed compatible across minor
engine versions, and the game ships its own `GodotSharp.dll` built against
4.5.x — so exporting with something newer (4.7.x, etc.) risks producing a
`.pck` the game's own bundled (older) engine can't load correctly. **4.7.1
would not be a safe substitute.**

Two known-good 4.5.x sources:
- **MegaCrit's own custom build, "MegaDot"** — `https://megadot.megacrit.com/`.
  One community setup guide describes it as "a custom build of the Godot
  game engine that Slay the Spire 2 is built on... used to package your
  mod's resources." Likely the safest choice, being MegaCrit's own.
- **Vanilla Godot 4.5.1 "Mono"/".NET" build** from godotengine.org's
  download archive — confirmed working by at least one other example mod's
  setup instructions, independent of MegaDot.

`godotLocator.js` matches either naming convention. **[VERIFIED against a
real download]**: MegaDot's filename is `MegaDot_v4.5.1-stable_mono_win64.exe`
— same convention as vanilla Godot, "MegaDot" swapped in for "Godot" — which
also confirms the 4.5.1 pin above from a third, independent angle.

## Real build attempt #1 — first actual `dotnet build` result

Tyler ran a real test export (minimal character, one card) through the app
on his own machine, which found a genuine, actionable bug (not a BaseLib API
guess — this one was ours):

`server.js`'s `run()` helper only captured the child process's `stderr` for
the error message it writes into `BUILD_FAILED.txt`. `dotnet build`'s actual
compiler/MSBuild diagnostics print to **stdout**, so the first failed build
only surfaced "Command failed: dotnet build ..." with none of the real
error. Fixed to capture both stdout and stderr.

With that fixed, the real first error was:
```
error NETSDK1022: Duplicate 'Compile' items were included. The .NET SDK
includes 'Compile' items from your project directory by default...
```
Cause: `ModProject.csproj.template` had an explicit
`<ItemGroup><Compile Include="Cards/**/*.cs" />...</ItemGroup>`, but
`Microsoft.NET.Sdk` already auto-includes every `.cs` file under the project
directory by default (excluding `bin`/`obj`) — exactly what the real,
verified `ExampleMod.csproj` relies on, with zero `Compile` items of its
own. The explicit item group double-included every generated file. Fixed by
removing it entirely.

Also confirmed working in this same run, worth noting since it's easy to
assume the whole toolchain is shaky when one part fails: `dotnet restore`
succeeded and correctly used the local `mods/BaseLib/BaseLib.dll` via
`HintPath` without touching NuGet at all — the `-p:BaseLibDllPath=...`
mechanism from "Update after inspecting BaseLib.dll directly" works as
designed.

## What's still genuinely unverified

- The exact **constructor signature** of `CustomCardModel` (docs say cost/
  type/rarity/target go through the base constructor, not property
  overrides — but the exact parameter order and any additional required
  args are unconfirmed).
- The full property surface of `CustomCharacterModel` (starting deck/relic/
  hp/gold/energy/orb — the wiki page that should cover this was truncated
  and mostly described visuals, not the numeric setup surface).
- Whether `CustomPowerModel` (permanent custom statuses) uses the same hook
  method names as `RelicModel` (`AfterCardPlayed`, `AfterDamageGiven`, etc.)
  — likely yes since BaseLib is designed to standardize this, but not seen
  directly.
- Exact fields Godot expects under `res://<mod-id-lowercase>/...` for card
  art / orb layers / portraits beyond the three `Nodes/*.cs` filenames
  spotted in the decompile.

## The real next validation step

Nothing above has been through a real compiler. The single highest-value
next action, once you're ready, is still what the original README
recommended — just now with real inputs instead of guesses: install the
[ModTemplate-StS2](https://github.com/Alchyr/ModTemplate-StS2) dotnet
templates (or clone `sts2_example_mod` directly) on your machine, add a
`CustomCardModel` subclass by hand, and see what the compiler actually
demands. That will confirm or correct the "still genuinely unverified" list
above in about the time it takes to read one compiler error.

## Real build attempt #2 — 21 real compiler errors (richest data yet)

Tyler ran another real test export after build attempt #1's fixes landed.
This is the most informative build yet — 21 distinct errors, all real
compiler diagnostics, covering nearly every remaining guess in the
templates. Grouped by root cause (not in raw error order):

**`CS0246` — `Pool`/`PoolAttribute` and pool-class names not found.**
`[Pool(typeof(...))]` on Card/Relic needed `using BaseLib;` (the attribute's
apparent home namespace, by analogy with the already-working
`using BaseLib.Abstracts;`), and the referenced pool class
(`<ModId>CardPool`/`<ModId>RelicPool`) needed its own namespace imported
(`{{namespace}}.CardPools` / `.RelicPools`) since it lives in a sibling
namespace to the card/relic file, not the same one. Fixed in both
`Card.cs.template` and (proactively, untested) `Relic.cs.template`.

**`CS0506` — `Id`/`Name` "cannot override inherited member ... because it
is not marked virtual, abstract, or override".** Confirmed on both
`CustomCardModel` and `CustomCharacterModel`. These aren't overridable
anywhere in the model hierarchy, full stop — removed from every template
(Card, Relic, Character, and proactively Power). Strong circumstantial
evidence (a blog post covering real card XML/JSON) that card **names** and
**descriptions** are instead resolved via a localization file keyed
`"{ID_UPPERCASE}.name"` / `"{ID_UPPERCASE}.description"` — **not yet
implemented**, because the exact file format/location is still uncertain
enough that guessing it wrong would be much harder to detect than a
compiler error (a wrong localization file just silently shows a blank name
in-game, not a build failure). Tracked as a known follow-up. Until it's
implemented, compiled cards/characters will very likely display with a
blank or placeholder name/description in-game — that's expected, not a
regression.

**`CS0115` — `Exhausts`/`Innate` "no suitable method found to override".**
Confirms these aren't plain bool overrides either. Replaced with
`AddKeyword(CardKeyword.Exhaust)` / `.Innate` / `.Ethereal` calls in the
card's constructor — `[UNVERIFIED]`, based on BaseLib.dll's strings table
showing `Keywords`/`AddKeyword`/`CustomKeyword(s)` as real member names and
the base game having a real `CardKeyword` enum
(`MegaCrit.Sts2.Core.Entities.Cards`). This is also where the frontend's
missing Exhaust/Innate/Ethereal UI controls came from — `ethereal` didn't
exist in the schema or data model at all before this round; added to both
(`schema/character.schema.json`'s card definition, and a new checkbox row
in `frontend/index.html`'s card editor modal, alongside surfacing the
already-existing-but-hidden `exhausts`/`innate` checkboxes).

**`CS1715` — `StartingDeck`/`StartingRelics` type mismatch.** The compiler
error itself states the required types: `IEnumerable<CardModel>` for
`StartingDeck`, `IReadOnlyList<RelicModel>` for `StartingRelics` — not
`List<string>` as previously guessed. Fixed by having `compiler.js` resolve
each schema ID against the card/relic C# class it's generating in the same
pass, and emitting `ModelDb.Card<T>()` / `ModelDb.Relic<T>()` expressions.
`ModelDb`'s own namespace (guessed as the `BaseLib` root namespace) and
method signatures are themselves still `[UNVERIFIED]` — grounded only in an
earlier BaseLib wiki excerpt showing `ModelDb.Card<Anticipate>()` used
exactly this way, not a direct build confirmation yet.

**`CS0534` — missing abstract member overrides**, split across two classes:

- `CardPoolModel` (via `CustomCardPoolModel`): `IsColorless` (bool),
  `DeckEntryCardColor` (type unknown — guessed `Godot.Color`, built from
  the character's hex color), `Title` (string, guessed to be the
  character's display name).
- `CharacterModel` (via `CustomCharacterModel`): `StartingHp` (separate
  from `MaxHp` — fixed trivially as `StartingHp => MaxHp`), `NameColor`
  (same `Godot.Color` guess as `DeckEntryCardColor`), `PotionPool` (new
  per-character empty pool added — `PotionPool.cs.template` +
  `CustomPotionPoolModel`, guessed by naming symmetry with
  `CardPool`/`RelicPool`; character.schema.json has no potion concept yet,
  so this pool is always empty), `Gender` (type totally unknown — guessed
  as an enum literally named `Gender`; this one is a placeholder more than
  a real guess, see below), `GetArchitectAttackVfx()` (return type totally
  unknown — guessed `string`, returning `string.Empty`).

For `Gender` and `GetArchitectAttackVfx()` specifically: there's no
evidence at all to ground the guess (no matching string, no doc, no
decompile hit for either). They're shipped anyway, not left blank, because
a wrong type guess for an abstract override is **self-correcting** — C#'s
`CS0508` ("return type must be X to match overridden member") and `CS0117`
("Y does not contain a definition for Z") errors state the real required
type/member directly in the error text. So even a wrong guess here turns
into free information on the next build, rather than another blind attempt.

### A faster path than guess-and-rebuild: `tools/reflect-baselib`

Given how many of this round's fixes came down to "guess a type, let the
next compiler error confirm or correct it," a small reflection tool
(`tools/reflect-baselib/`, shipped alongside this update) was added to
short-circuit that loop entirely. Run once against your own `sts2.dll` +
`BaseLib.dll`, it reflects over `CharacterModel`, `CardModel`,
`CardPoolModel`, `PotionPoolModel`, etc. directly and prints every abstract
member's *exact* type and name — no guessing, no waiting on a build. See
its `README.md` for usage. Not required to keep iterating the old way (that
still works, per the self-correcting-guesses point above), but it turns
several more build-and-report round trips into one `dotnet run`.

## reflect-baselib round 1 — ground truth, not guesses

Tyler ran `tools/reflect-baselib` (round 1) against his real `sts2.dll` +
`BaseLib.dll`. This is reflection metadata, not a compiler error to
interpret — as close to certain as anything in this document gets short of
a real successful build. Full raw output is in the chat history; digest of
what changed:

**Confirmed exactly right already:** `DeckEntryCardColor`'s `Godot.Color`
guess, `NameColor`'s `Godot.Color` guess, `StartingDeck`/`StartingRelics`'
types, `ModelDb.Card<T>()`/`ModelDb.Relic<T>()` (both real, generic, exactly
as used), `CardKeyword`'s members (`None`/`Exhaust`/`Ethereal`/`Innate`/
`Unplayable`/`Retain`/`Sly`/`Eternal`), `RelicModel`'s abstract surface
(`Rarity` + `ShouldReceiveCombatHooks`, nothing else), `CustomPotionPoolModel`
as a real base class name.

**Confirmed wrong, now fixed with the real type/name:**
- `Gender`'s real type is `MegaCrit.Sts2.Core.Entities.Characters.CharacterGender`
  (members: `Neutral`/`Feminine`/`Masculine`), not a type literally called
  `Gender`.
- `GetArchitectAttackVfx()` returns `List<string>`, not `string`.
- `ModelDb`'s real namespace is `MegaCrit.Sts2.Core.Models`, not `BaseLib`.
- `Power.cs.template`'s previous `Stackable`/`DecaysPerTurn`/`IsBuff`
  overrides were entirely fictional — the real abstract surface is
  `PowerType Type` + `PowerStackType StackType` (+ `ShouldReceiveCombatHooks`).
  Rewritten from scratch; real enum member names for `PowerType`/
  `PowerStackType` still pending a round 2 (see below).

**New abstract members discovered that hadn't shown up as compiler errors
yet** (attempt #2's build died on earlier errors before reaching these —
reflection sees the whole picture at once, a build only sees as far as the
first wave of errors):
- `AbstractModel.ShouldReceiveCombatHooks` (bool) — required on literally
  every model type Forge generates (Card, Character, Power, CardPool,
  RelicPool, PotionPool), not just Relic (which already had it, copied from
  the one verified real relic). Added everywhere.
- `CharacterModel.UnlocksAfterRunAs` (nullable `CharacterModel`),
  `AttackAnimDelay`/`CastAnimDelay` (float) — all new, all defaulted to
  null/0f.
- `CardPoolModel.EnergyColorName`, `CardFrameMaterialPath` (both plain
  strings, cosmetic), `GenerateAllCards()` (`CardModel[]`) — the last one
  is very likely the *actual* mechanism that registers a character's cards
  into their pool (separate from each card's own `[Pool(typeof(...))]`
  attribute). Implemented in `compiler.js` by enumerating every card the
  character defines.
- `RelicPoolModel.EnergyColorName`, `GenerateAllRelics()`
  (`IEnumerable<RelicModel>`) — same pattern.
- `PotionPoolModel.EnergyColorName`, `GenerateAllPotions()`
  (`IEnumerable<PotionModel>`) — schema has no potion concept, so this
  always returns an empty list.

All of the above are now implemented in `backend/templates/*.cs.template`
and wired through `backend/compiler.js`. `EnergyColorName`/
`CardFrameMaterialPath` are plain strings with no enum to get wrong — any
value compiles — so they're cosmetic-only guesses, not build risks.

### Still open after round 1 — needs reflect-baselib round 2

Reflection only shows **abstract** members — anything concrete or virtual
(already implemented in the base class, optionally overridable) is
invisible to that scan. Round 2 of the tool (already shipped, same
`tools/reflect-baselib/` folder, same command) adds three more targeted
searches to close the remaining gaps:

- `OnPlay`'s exact parameter types on `CustomCardModel` (still only a
  best-effort guess).
- Whether `AddKeyword(CardKeyword)` (or a `Keywords` collection, or
  something else) is the real way to set Exhaust/Innate/Ethereal on a card.
- The real hook method names/signatures on `CustomRelicModel`
  (`AfterCardPlayed` etc. — currently a best-effort mapping per trigger).
- `PowerType`/`PowerStackType`'s real enum member names.

Ask Tyler to re-run `tools/reflect-baselib` (same command as before — the
tool auto-picks up the new searches) and paste back `reflect-output.txt`
before assuming those four items are still guesses.

## reflect-baselib round 2 — resolved almost everything left

Tyler ran round 2. Massive haul — this closed nearly every remaining
`[UNVERIFIED]` guess in the project. Digest:

**`PowerType`/`PowerStackType` enum members — CONFIRMED:**
`PowerType` is `None`/`Buff`/`Debuff` (matches the existing `Buff`/`Debuff`
guess exactly). `PowerStackType` is `None`/`Counter`/`Single` — the
previous guess (`Intensity`/`None`) was WRONG (`Intensity` doesn't exist at
all); fixed to `Counter`/`Single` (`compiler.js:generateMechanicSource`).

**`OnPlay`'s real signature — CONFIRMED, and it's completely different
from the guess:**
```
Task OnPlay(PlayerChoiceContext choiceContext, CardPlay cardPlay)
```
NOT `(PlayerChoiceContext, Creature player, Creature? target)`. `CardPlay`
is a real type (`MegaCrit.Sts2.Core.Entities.Cards.CardPlay`) whose own
members haven't been reflected on yet — `cardPlay.Player`/`.Target` are a
[BEST EFFORT] guess at how to get the Creatures back out, grounded in how
consistently "player"/"target" Creature parameters are named everywhere
else in this dump. `Card.cs.template` rewritten to the real signature.

**`AddKeyword(CardKeyword keyword)` — CONFIRMED real**, exact name and
signature, concrete (not abstract) instance method. The keyword-setting
mechanism is no longer a guess.

**`OnUpgrade()` — CONFIRMED real** (void, no params), matches what the app
already generated.

**Relic hook methods — CONFIRMED real names AND full real parameter
lists** for every trigger except two (`OnCombatStart`/`OnKillEnemy`, which
don't have an exact real analog — see below). The previous version of
`TRIGGER_HOOKS` used ONE made-up signature
(`PlayerChoiceContext choiceContext, Creature player, Creature? target,
CardModel? cardSource`) for every single hook; the real signatures are all
different from each other and from that guess:

| trigger | real method | real params |
|---|---|---|
| OnPlay | `AfterCardPlayed` | `PlayerChoiceContext choiceContext, CardPlay cardPlay` |
| OnDrawCard | `AfterCardDrawn` | `PlayerChoiceContext choiceContext, CardModel card, bool fromHandDraw` |
| OnExhaust | `AfterCardExhausted` | `PlayerChoiceContext choiceContext, CardModel card, bool causedByEthereal` |
| OnTurnEnd | `AfterSideTurnEnd` | `PlayerChoiceContext choiceContext, CombatSide side, IEnumerable<Creature> participants` |
| OnTurnStart | `AfterSideTurnStart` | `CombatSide side, IReadOnlyList<Creature> participants, ICombatState combatState` (no `PlayerChoiceContext` at all) |
| OnTakeDamage | `AfterDamageReceived` | `PlayerChoiceContext choiceContext, Creature target, DamageResult result, ValueProp props, Creature dealer, CardModel cardSource` |
| OnCombatStart | *(no real analog — remapped to `BeforeCombatStart()`, no params)* | — |
| OnKillEnemy | *(no real analog — remapped to `AfterDeath(...)`, fires for ANY creature's death, not just enemies)* | `PlayerChoiceContext choiceContext, Creature creature, bool wasRemovalPrevented, float deathAnimLength` |

Only `OnPlay` and `OnTakeDamage` expose a confirmed way to derive both a
"player" and a "target" Creature for reusing this app's shared action-code
generator; every other trigger's real params don't cleanly map to that
shape, so those hook bodies now emit `ForgeActions.Todo(...)` instead of
silently binding the wrong Creature (or none at all). All of this is now
implemented in `compiler.js`'s `TRIGGER_HOOKS` + `generateRelicHooks`.

### A real bug caught during this round: CS0136 variable collision

While wiring the real `AfterDamageReceived` signature above, its own
parameter is literally named `target` — and the app's existing generated
code declared a local variable also named `target` inside every hook body
(`var player = ...; var target = ...;`) to feed the shared action-code
generator. That's a genuine C# compile error (`CS0136`, "a local variable
named 'target' cannot be declared in this scope because that name is used
... to define a parameter") — caught during review before shipping, not by
a real build. Fixed by renaming the shared local-variable convention
project-wide from `player`/`target` to `fg`-prefixed `fgPlayer`/`fgTarget`
(`compiler.js:resolveTargetExpr`, `actionToCSharp`, `conditionToCSharp`,
`generateRelicHooks`, and `Card.cs.template`'s `OnPlay` all updated
together) — a name real BaseLib parameters are extremely unlikely to ever
collide with.

### Still open — needs reflect-baselib round 3 (already shipped)

The only meaningful gap left: `CardPlay`'s own member names (does it really
expose `.Player`/`.Target`, or something else?). Round 3 of the tool
(already shipped, same command) dumps every property/field on `CardPlay`
directly — ask Tyler to run it once more before assuming `cardPlay.Player`/
`.Target` are correct. Everything else of substance in the project is now
either [VERIFIED] or an honest, self-correcting [BEST EFFORT]/Todo
fallback rather than a blind guess.

## Real build attempt #3 — 13 real compiler errors, four distinct bug classes

Tyler ran a real `dotnet build` after all the round-1/round-2 fixes landed
(test character: 2 cards, 0 relics, 0 mechanics). 13 errors, four genuinely
different root causes — all fixed:

**A real bug this app introduced, not a BaseLib guess (`CS0234`):**
`Character.cs.template` and `RelicPool.cs.template` both unconditionally
`using {{namespace}}.Relics;`. With 0 relics, no `.cs` file was ever
written into the `Relics/` folder, so nothing ever declared that
namespace — the `using` failed with "the type or namespace name 'Relics'
does not exist in the namespace 'TestChar'". Not a wrong guess about
BaseLib at all, just a gap in this app's own generation logic for the
zero-count case. Fixed by always writing a placeholder
`Cards/_Namespace.cs` / `Relics/_Namespace.cs` (just a bare
`namespace X.Cards;` / `.Relics;` declaration, nothing else) regardless of
count — a namespace declaration with no members is valid, empty C#, so
this costs nothing when cards/relics ARE present.

**`PoolAttribute`'s namespace guess was wrong (`CS0246`):** `using
BaseLib;` (guessed by naming-convention symmetry with the already-working
`using BaseLib.Abstracts;`) does NOT contain `PoolAttribute` — every
single generated card/relic fails to compile at all until this is fixed,
since `[Pool(typeof(...))]` is on all of them. Rather than guess again
blindly, `tools/reflect-baselib` round 4 (already shipped) searches for
any type named `PoolAttribute` (or any `Attribute`-derived type containing
"Pool") across both assemblies and prints its real, exact namespace —
**this is the one concrete thing Tyler needs to re-run reflect-baselib
for before the next build has any chance of getting past the Cards/Relics
folders at all.**

**Several members are `protected`, not `public` (`CS0507`, "cannot change
access modifiers when overriding"):** `CardModel.OnPlay`,
`CardPoolModel.GenerateAllCards()`, `RelicPoolModel.GenerateAllRelics()`,
`PotionPoolModel.GenerateAllPotions()`, and
`CustomCharacterModel.UnlocksAfterRunAs` are all declared `protected` on
the real base classes — every one of them had been generated as `public
override` (reflection had found the right member and signature, just not
its accessibility, since round 1/2's dump code never queried it). Fixed in
each template (`protected override` now) — see the confirmed value below
under "everything else". **`tools/reflect-baselib` itself was also
upgraded (round 4)**: `AccessString(...)` now reports the real access
modifier (`public`/`protected`/`internal`/etc) next to every member it
prints, so this exact class of error shouldn't recur for anything the tool
has already looked at.

**`MaxHp` isn't a real override at all (`CS0115`):** same failure mode as
`Id`/`Name` — `CS0115: 'TestCharCharacter.MaxHp': no suitable method found
to override`. There's no separate "max HP" concept on the model distinct
from `StartingHp` (which IS confirmed real, via reflection). Removed
`MaxHp` entirely; `StartingHp` is now bound directly to the schema's
`maxHp` value instead of routing through a property that never existed.

**Everything else in this build's generated source that reflection had
found — `ShouldReceiveCombatHooks`, `NameColor`, `Gender`,
`CardPool`/`RelicPool`/`PotionPool`, `StartingGold`, `StartingDeck`/
`StartingRelics`, `AttackAnimDelay`/`CastAnimDelay`,
`GetArchitectAttackVfx()`, `IsColorless`/`DeckEntryCardColor`/`Title`/
`EnergyColorName`/`CardFrameMaterialPath`, `Rarity` — did NOT error.**
That's reasonably strong indirect confirmation those are correctly `public`
and otherwise fine as generated; only the five members above needed a
`protected` fix.

### Next step

Ask Tyler to run `tools/reflect-baselib` once more (round 4 is additive to
rounds 1–3, same command) specifically to resolve `PoolAttribute`'s real
namespace — that's the one hard blocker left before a build can get past
every single card/relic file. Everything else from this round is already
fixed and shipped.

## reflect-baselib rounds 1–4, combined dump — processed

Tyler re-ran `tools/reflect-baselib` (now cumulative through round 4 in one
invocation) and pasted the full output back. Three concrete findings, two
already fixed and shipped, one still open:

**`PoolAttribute`'s real namespace — CONFIRMED, FIXED.** Round 4's targeted
search found exactly one match:
`BaseLib.Utils.PoolAttribute` (assembly: `BaseLib`). `using BaseLib;` was
wrong; `using BaseLib.Utils;` is correct. This was the hard blocker
mentioned above — fixed in both `Card.cs.template` and
`Relic.cs.template`. This alone should unblock every generated card/relic
from failing at the attribute-resolution stage.

**`OnUpgrade()`'s access modifier — CONFIRMED, FIXED.** Round 2's
`*Upgrade*` member scan (re-surfaced with round 4's accessibility
reporting applied) shows:
`[CardModel, virtual, protected] method System.Void OnUpgrade()`. The
previous version of `compiler.js`'s `generateCardSource` emitted `public
override void OnUpgrade()` — same class of bug as the five `CS0507`s
from build attempt #3. Fixed to `protected override void OnUpgrade()`.

**`CardPlay`'s own members — CONFIRMED, but surfaces a NEW open issue.**
Round 3 dumped every instance property/field on
`MegaCrit.Sts2.Core.Entities.Cards.CardPlay` directly:

```
[CardPlay] property CardModel Card { get; set; }
[CardPlay] property MegaCrit.Sts2.Core.Entities.Players.Player Player { get; set; }
[CardPlay] property MegaCrit.Sts2.Core.Entities.Creatures.Creature Target { get; set; }
[CardPlay] property PileType ResultPile { get; set; }
[CardPlay] property ResourceInfo Resources { get; set; }
[CardPlay] property bool IsAutoPlay { get; set; }
[CardPlay] property int PlayIndex { get; set; }
[CardPlay] property int PlayCount { get; set; }
[CardPlay] property bool IsFirstInSeries { get; }
[CardPlay] property bool IsLastInSeries { get; }
```

`cardPlay.Target` is confirmed `Creature` — the existing `fgTarget =
cardPlay.Target` binding in `Card.cs.template`'s `OnPlay` and in
`compiler.js`'s `TRIGGER_HOOKS.OnPlay` is correct as-is, no change needed.

`cardPlay.Player`, however, is confirmed type
`MegaCrit.Sts2.Core.Entities.Players.Player` — **not** `Creature`. Every
`ForgeActions` combat helper (`GainBlock`, `DealDamage`, `Heal`, `LoseHp`,
`ApplyStatus`, `RemoveStatus`, `GetStatusStacks`) takes a `Creature`
parameter, and `resolveTargetExpr`'s `"Self"` target resolves to
`fgPlayer` — which is bound to `cardPlay.Player` throughout `OnPlay` and
`OnTakeDamage`'s relic hook. **This means any card or relic whose effect
targets "Self" will fail to compile with `CS1503` ("cannot convert from
'Player' to 'Creature'") the next time it's built.** Confirmed via a local
Node smoke test reproducing the generated source for a "Self"-targeted
`GainBlock` card — the emitted line is
`ForgeActions.GainBlock(fgPlayer, 5);` where `fgPlayer`'s static type is
`Player`, not `Creature`.

This is NOT fixed yet, deliberately — guessing a property name on `Player`
(e.g. `.Creature`, `.CombatCreature`, `.Entity`) risks being just as wrong
as the original `cardPlay.Player`/`.Target` guess was, and reflect-baselib
is cheap and fast to re-run compared to a full `dotnet build` cycle. A
**round 5** search has been added to `tools/reflect-baselib/Program.cs`:
it looks specifically for any `Creature`-typed property, field, or method
on `Player` (across its whole hierarchy, any accessibility), and falls
back to dumping literally every property/field on `Player` if that first
targeted search comes up empty. Re-running the tool (same command as
before — the round 5 search is additive) should give the exact
property/method name needed to fix `fgPlayer`'s binding once and for all.

### Next step

Ask Tyler to re-run `tools/reflect-baselib` once more (round 5 is additive)
specifically to resolve how to get from a `Player` to its `Creature`. Once
that's known, update `Card.cs.template`'s `OnPlay` body and
`compiler.js`'s `TRIGGER_HOOKS.OnPlay.playerExpr` to route through it
(e.g. `cardPlay.Player.Creature` or similar) instead of binding `fgPlayer`
directly to `cardPlay.Player`. The `PoolAttribute` and `OnUpgrade` fixes
from this round are already shipped and don't need another build to
confirm — they matched the real access/namespace exactly.

## reflect-baselib round 5, combined dump — processed, last open blocker closed

Tyler re-ran `tools/reflect-baselib` (rounds 1-5 in one invocation) and
pasted the output back. Round 5's targeted search on
`MegaCrit.Sts2.Core.Entities.Players.Player` found the answer directly:

```
[Player, concrete, public] property Creature Creature { get; }
[Player, concrete, public] property Creature Osty { get; }
```

`Player.Creature` is a real, public, concrete property — exactly the
combat entity `ForgeActions`' Creature-typed helpers need. **Fixed**:
`Card.cs.template`'s `OnPlay` now binds
`var fgPlayer = cardPlay.Player.Creature;` (was `cardPlay.Player`), and
`compiler.js`'s `TRIGGER_HOOKS.OnPlay.playerExpr` is now
`'cardPlay.Player.Creature'` (was `'cardPlay.Player'`). Verified via the
Node smoke test — the previously-mistyped
`ForgeActions.GainBlock(fgPlayer, 5)` line (where `fgPlayer` was `Player`)
now correctly resolves `fgPlayer` to `Creature`.

(Note: `Player.Osty` also showed up as a `Creature`-typed property —
that's the "Osty" companion/pet creature some STS2 characters have, not
the player's own combat entity. Not used here; noted in case a future
character mechanic needs it.)

This closes every concrete blocker known from build attempt #3 plus
everything reflect-baselib rounds 1-5 have surfaced since. The next real
`dotnet build` is the first one with a real shot at getting past every
card/relic file — remaining risk is concentrated in genuinely
[UNVERIFIED] areas that were never blocking compilation before (run-level
actions like DrawCard/GainEnergy/GainGold still route to
`ForgeActions.Todo(...)`, several relic hook triggers remapped to the
closest real analog rather than an exact match, etc.) — see
`ForgeActions.cs.template` and `compiler.js`'s `TRIGGER_HOOKS` for the
current list of what's still a guess.

### Next step

No more reflect-baselib gaps are currently known. Ask Tyler to run a real
test export + `dotnet build` — whatever errors (if any) come back next are
the next source of ground truth, same as build attempt #3 was.

## Real build attempt #4 — 12 errors, five distinct bug classes (all in previously-unverified areas)

Tyler ran a real test export (three cards including two deliberate edge
cases — a negative cost, a "Special" rarity, a "None" target — plus a
relic and a mechanic) and `dotnet build`. **The `PoolAttribute` namespace
fix and the `protected`-accessibility fixes from build attempt #3 both
held — none of those errors recurred.** This is the first build to get
past the attribute/namespace/accessibility layer entirely; every error
this round is in a part of the generator that was never reflection-
verified in the first place (the card constructor call and several
`ForgeActions` "...Internal" method guesses were explicitly flagged as
BEST EFFORT from day one — see `ForgeActions.cs.template`'s and
`Card.cs.template`'s own headers).

**1. `CustomCardModel`'s base constructor call is wrong shape (`CS1739`,
`CS0103`):**
```
error CS1739: The best overload for '.ctor' does not have a parameter named 'cost'
error CS0103: The name 'CardTarget' does not exist in the current context
```
The generated `: base(cost: ..., type: ..., rarity: ..., target: ...)`
call (in every card, all three failed here) was always a guess — never
reflected on, unlike almost everything else in this file. Two separate
problems bundled together: the real constructor doesn't have a `cost`-
named parameter (so either the parameter is named differently, isn't in
the constructor at all, or the whole overload shape differs), AND
`CardTarget` isn't just the wrong enum *value* — `CS0103` means the type
name itself doesn't resolve in scope at all, so either it's named
something else entirely or targeting isn't a constructor concern the way
this guessed. **Not fixed yet — needs round 6's constructor dump.**

**2. `CardRarity` doesn't have a `Special` member (`CS0117`):**
```
error CS0117: 'CardRarity' does not contain a definition for 'Special'
```
`character.schema.json`'s card rarity enum includes `"Special"` (Tyler's
test card deliberately used it), but real `CardRarity` doesn't have that
member. **Not fixed yet — needs round 6's real enum dump**; once known,
either the schema's enum list needs correcting to match real values, or
"Special" maps onto whatever the closest real member is.

**3–6. Four `ForgeActions` "...Internal" method guesses are wrong
(`CS1061` x2, `CS7036`, `CS1501`, `CS1503`):**
```
error CS1061: 'Creature' does not contain a definition for 'TakeDamageInternal'
error CS7036: ... required parameter 'props' of 'Creature.LoseHpInternal(decimal, ValueProp)'
error CS1501: No overload for method 'ApplyPowerInternal' takes 2 arguments
error CS1503: Argument 1: cannot convert from 'string' to 'MegaCrit.Sts2.Core.Models.PowerModel'
error CS1061: 'Creature' does not contain a definition for 'GetPowerAmountInternal'
```
Only `GainBlockInternal(int)` was ever [VERIFIED] (from the one real relic
source found earlier); `TakeDamageInternal`, `LoseHpInternal`,
`ApplyPowerInternal`, and `GetPowerAmountInternal` were all [BEST EFFORT]
guesses extrapolated from that one confirmed method's naming convention —
now confirmed wrong in four different ways:
- `TakeDamageInternal` doesn't exist on `Creature` at all — the real
  damage-dealing method is named something else.
- `LoseHpInternal` DOES exist, but needs a second `ValueProp props`
  argument this app has no way to construct yet — `LoseHpInternal(decimal
  amount, ValueProp props)`, confirmed by the compiler error itself (this
  one didn't need reflection to partially resolve, though the full
  picture — what a valid `ValueProp` even looks like — still does).
- `ApplyPowerInternal` exists but takes a different argument count/shape,
  AND its first parameter is `PowerModel`, not `string` — this is an
  architectural gap, not just a wrong guess: applying a status by ID
  string was never going to work if the real API wants a resolved model
  instance. Custom mechanics will likely need to route through
  `ModelDb.Power<T>()` the same way cards/relics already route through
  `ModelDb.Card<T>()`/`ModelDb.Relic<T>()` — built-in statuses like
  Strength/Dexterity will need a different resolution path since Forge
  doesn't generate those (they're base-game powers, not custom ones).
- `GetPowerAmountInternal` doesn't exist on `Creature` either.

**Not fixed yet — needs round 6's data**: Creature's real
Damage/Hp/Power/Block-matching members (with full signatures), `ValueProp`'s
constructors/static factories, and (since `ApplyPowerInternal` wants a
`PowerModel`) `CustomPowerModel`'s own constructor — flagged as the same
un-verified risk class `CustomCardModel`'s constructor turned out to be,
and not yet build-tested at all since this test character's mechanic
was never actually referenced by a card/relic action in this export.

### reflect-baselib round 6 (shipped, not yet run by Tyler)

Added to `tools/reflect-baselib/Program.cs`:
- `DumpConstructors(Type)` — new helper, dumps every constructor (any
  accessibility) with full parameter names/types/defaults. Applied to
  `CardModel`, `CustomCardModel`, `PowerModel`, `CustomPowerModel`, and
  `ValueProp`.
- Broadened enum search (`Rarity`/`Target`/`CardType`) to catch
  `CardRarity`'s real members and whatever the real "target" type/enum is
  actually called, plus a non-enum fallback that lists any type
  containing "Target" in a `*.Cards` namespace in case it isn't an enum
  at all.
- `Creature`'s real members matching `*Damage*`, `*Hp*`/`*Heal*`,
  `*Power*`, and `*Block*` (the last as a sanity check against the
  already-[VERIFIED] `GainBlockInternal`).
- `ValueProp`'s constructors and static members.

### Next step

Ask Tyler to re-run `tools/reflect-baselib` once more (round 6 is
additive) and paste the output back. This should resolve all five bug
classes above in one pass, the same way round 4's targeted `PoolAttribute`
search closed that round's hard blocker.

## reflect-baselib round 6, combined dump — processed, two of five bug classes fixed

Tyler re-ran the tool (rounds 1-6) and pasted the output back. Round 6's
constructor/enum dumps fully resolved bug classes #1 and #2 from build
attempt #4; bug class #3 (the four `ForgeActions` "...Internal" guesses)
turned out to need MORE data than round 6 alone provided — see "round 7"
below.

**1. `CustomCardModel`'s real constructor — CONFIRMED, FIXED:**
```
[public] CustomCardModel(int baseCost, CardType type, CardRarity rarity, TargetType target, bool showInCardLibrary = true, bool autoAdd = true)
```
Two fixes applied to `Card.cs.template`: the named parameter is
`baseCost:`, not `cost:` (closes `CS1739`); and the real 4th parameter
type is `MegaCrit.Sts2.Core.Entities.Cards.TargetType`, not a type called
`CardTarget` (closes `CS0103` — that guess didn't even resolve to a real
type). `TargetType`'s real members
(`None`/`Self`/`AnyEnemy`/`AllEnemies`/`RandomEnemy`/`AnyPlayer`/`AnyAlly`/
`AllAllies`/`TargetedNoCreature`/`Osty`) don't line up with this app's own
`card.target` schema vocabulary
(`SingleEnemy`/`AllEnemies`/`Self`/`None`), so a small translation layer
was added — `compiler.js`'s new `CARD_TARGET_TYPE_MAP`
(`SingleEnemy`→`AnyEnemy`, everything else passes through unchanged) —
rather than renaming the schema/frontend to match BaseLib's naming
directly. This keeps Forge's own target vocabulary consistent between
card-level targeting and effect-action targeting (which was never a
literal enum match anyway — see `resolveTargetExpr`).

**2. `CardRarity`/`RelicRarity`'s real members — CONFIRMED, FIXED
(schema-level, not just template-level):**
```
enum CardRarity: None, Basic, Common, Uncommon, Rare, Ancient, Event, Token, Status, Curse, Quest
enum RelicRarity: None, Starter, Common, Uncommon, Rare, Shop, Event, Ancient
```
`character.schema.json`'s card rarity list (`Starter`/`Common`/
`Uncommon`/`Rare`/`Special`) had TWO invented values with no real
equivalent (`Starter`, `Special` — real `CardRarity` has no such members;
the real name for starting-deck cards like Strike/Defend is `Basic`).
Fixed by replacing the schema's card rarity enum with the real
`CardRarity` member list verbatim (minus `None`, which isn't a meaningful
design choice for an authored card) — this is a breaking schema change
for any character JSON already using `"Starter"` or `"Special"` as a card
rarity; Tyler will need to re-pick a rarity on any existing test cards
using those two values. Separately, the schema's relic rarity list had
one invented value (`Boss` — not a real `RelicRarity` member) and was
missing one real one (`Ancient`) — fixed to match the real enum exactly.
Both `frontend/index.html` rarity dropdowns updated to match.

**3. The four `ForgeActions` "...Internal" method guesses — PARTIALLY
resolved, more data needed (see round 7):**
Round 6's `Creature` member dump confirmed real signatures for two of the
four and raised new questions for the other two:
- `LoseHpInternal(decimal amount, ValueProp props)` — CONFIRMED to exist,
  needs a `ValueProp`. Not fixed yet — needs to know whether `ValueProp`
  is a struct (safely `default`-constructible) or something requiring a
  real constructor call; round 6's constructor dump found NO declared
  constructors on `ValueProp` at all, which is exactly what you'd expect
  from a struct with only an implicit parameterless constructor (not
  reflectable via `GetConstructors` the same way), but this wasn't
  confirmed directly.
- `TakeDamageInternal` and `GetPowerAmountInternal` — CONFIRMED to NOT
  exist on `Creature` at all. The only `*Damage*`-matching member found
  was `DamageBlockInternal(decimal amount, ValueProp props)`, which
  reduces BLOCK, not HP — there is no simple "deal damage" method on
  `Creature`. Combined with `AfterAttack(PlayerChoiceContext,
  AttackCommand command)`/`BeforeAttack(AttackCommand command)` (seen
  back in round 2's relic-hook dump), real damage-dealing is most likely
  NOT a single method call at all, but a command/builder object
  (`MegaCrit.Sts2.Core.Commands.Builders.AttackCommand`) built and
  dispatched some other way. This is a bigger architectural question than
  the earlier fixes — needs its own targeted round.
- `ApplyPowerInternal` — CONFIRMED real signature is
  `void ApplyPowerInternal(PowerModel power)`, a single resolved model
  instance, not `(string, int)`. But round 6 also confirmed
  `PowerModel`/`CustomPowerModel`'s ONLY constructor is a parameterless
  `protected` one — so there's no way to pass "how many stacks to apply"
  through the constructor. Some other member (an `Amount`/`Stacks`-style
  settable property, presumably) must exist on `PowerModel` for this to
  work at all; round 6 never searched `PowerModel` itself for this since
  the original `*Power*` search was scoped to `Creature`, not
  `PowerModel`.
- `RemovePowerInternal` — also confirmed to take `PowerModel`, same
  resolution question as `ApplyPowerInternal`.

**Deliberately not fixed yet**: `ForgeActions.cs.template`'s `DealDamage`/
`LoseHp`/`ApplyStatus`/`RemoveStatus`/`GetStatusStacks` are all still
guesses as of this round — the `ApplyPowerInternal`/`RemovePowerInternal`
question in particular is an architecture decision (custom mechanics
likely need to resolve through `ModelDb.Power<T>()` the same way
cards/relics do, similar to how a fresh model instance's "amount" gets
set), not something safe to guess at without more evidence.

**Also fixed (tool-only)**: `DumpMatchingMembers`/`DumpAbstractMembers` had
a latent gap in this round's own `Creature` dump — generic methods like
`T GetPower<T>()` printed as `T GetPower()`, indistinguishable from a
(nonexistent) non-generic overload, because nothing appended the `<T>`
marker after the method name (the return-type placeholder "T" printed
fine on its own, coincidentally). Added a shared
`MethodNameWithGenericArgs` helper (mirroring the `ModelDb` static-member
dump, which already handled this correctly) and applied it everywhere a
method signature gets printed — this makes round 6's own `GetPower<T>()`/
`GetPowerInstances<T>()`/possibly-generic `GetPowerAmount()` unambiguous
once re-run.

### reflect-baselib round 7 (shipped, not yet run by Tyler)

Added to `tools/reflect-baselib/Program.cs`:
- `PowerModel`/`CustomPowerModel`'s own members matching
  `*Amount*`/`*Stack*`/`*Count*` — to find how to set a power's stack
  count before calling `ApplyPowerInternal`.
- `AttackCommand`'s full shape: constructors, every declared instance
  method (its own fluent/builder API, if any), AND a scan across BOTH
  assemblies for any method that takes an `AttackCommand` (or its base
  type) as a parameter — to find the real dispatch mechanism for dealing
  damage, since no direct "deal damage" method exists on `Creature`.
- `ValueProp`'s `IsValueType`/`IsClass`/`IsAbstract` flags plus a full
  instance-member dump (not just the static fields already found) — to
  confirm whether `default(ValueProp)` is a safe, correct way to satisfy
  the `props` parameter every `*Internal` combat method needs.
- Fixed the generic-method printing gap described above, benefiting every
  dump this round and retroactively clarifying anything already dumped in
  earlier rounds once re-run.

### Next step

Ask Tyler to re-run `tools/reflect-baselib` once more (round 7 is
additive) and paste the output back. This should close out bug class #3
(the last unresolved piece of build attempt #4) and hopefully make the
next real build the first one to reach warnings-only or a full success —
everything else known from build attempts #1-4 is now fixed.

## reflect-baselib round 7, combined dump — processed, ForgeActions rewritten

Tyler re-ran the tool (rounds 1-7) and pasted the output back (note: the
file was large enough — round 7's AttackCommand-taker search had a bug
that made it match every method taking a bare `object` parameter anywhere
in either assembly — that it had to be read in pieces; the bug itself is
fixed below). This round's data was enough to fully rewrite
`ForgeActions.cs.template`'s `DealDamage`/`LoseHp`/`ApplyStatus`/
`RemoveStatus`/`GetStatusStacks` — the last unresolved piece of build
attempt #4.

**Real damage-dealing — CONFIRMED, FIXED.** There is no simple "deal
damage to a Creature" method anywhere (`TakeDamageInternal`/
`GetPowerAmountInternal` really don't exist, as build attempt #4 already
showed). Instead, damage goes through a fluent builder,
`MegaCrit.Sts2.Core.Commands.Builders.AttackCommand`:
```
AttackCommand(decimal damagePerHit)
  .FromCard(CardModel, CardPlay) / .FromOsty(...) / .FromMonster(...)   [optional: attacker attribution]
  .Targeting(Creature) / .TargetingAllOpponents(...) / .TargetingRandomOpponents(...)
  .WithHitCount(int) / .Unpowered() / .WithAttackerAnim(...) / ...      [optional: cosmetic/behavior tweaks]
  await .Execute(PlayerChoiceContext) -> Task<AttackCommand>
```
`ForgeActions.DealDamage` is now `async Task`, builds
`new AttackCommand(amount).Targeting(target)`, and awaits `.Execute(choiceContext)`.
**[BEST EFFORT] deliberately omitted**: `.FromCard(...)`/`.FromOsty(...)`/
`.FromMonster(...)` attacker attribution — this helper is shared between
card and relic contexts and there's no generic `.FromCreature(...)`
overload, so the actual damage number/target/execution path is
[VERIFIED] real, only optional VFX/hook-source metadata is left unset.
`compiler.js`'s `actionToCSharp` now emits `await ForgeActions.DealDamage(choiceContext, ...)`
instead of a bare call — safe because every context that reaches this
line is inside an already-`async Task` method with a real `choiceContext`
parameter (gated by the same condition that binds `fgPlayer`/`fgTarget`
in the first place).

**`LoseHpInternal`'s `ValueProp` parameter — CONFIRMED, FIXED.** Round
7's instance-member dump on `ValueProp` showed only a single
compiler-generated `value__` field — the unmistakable signature of an
**enum**, not a class or a hand-rolled struct. `IsValueType=True` (also
logged) confirms it. `default(MegaCrit.Sts2.Core.ValueProps.ValueProp)`
is therefore a safe, correctly-typed "no special flags" value.
`ForgeActions.LoseHp` now calls `target.LoseHpInternal(amount, default(ValueProp))`.

**`ApplyPowerInternal`/`RemovePowerInternal`'s instance-resolution
question — CONFIRMED, FIXED for custom mechanics.** Round 7 found
`PowerModel.SetAmount(int amount, bool silent)` (concrete, public) — this
is how stack count gets set on a power instance before applying it. Also
confirmed (via this round's `MethodNameWithGenericArgs` bugfix, see
below): `Creature.GetPower<T>()`/`HasPower<T>()`/`GetPowerAmount<T>()` are
real GENERIC methods — no `ModelId`/string lookup needed at all for a
power type Forge itself generated. `ForgeActions.cs.template` now has:
```csharp
public static void ApplyStatus<T>(Creature target, int amount) where T : CustomPowerModel, new()
{
    var power = new T();
    power.SetAmount(amount, silent: false);
    target.ApplyPowerInternal(power);
}
public static void RemoveStatus<T>(Creature target) where T : PowerModel { ... GetPower<T>()/RemovePowerInternal(...) ... }
public static int GetStatusStacks<T>(Creature target) where T : PowerModel => ... GetPowerAmount<T>() ...
```
`new T()` is safe because Forge-generated `Powers/XxxPower.cs` classes
never declare their own constructor, so the compiler emits an implicit
**public** parameterless one (calling the accessible-but-`protected`
`CustomPowerModel()` base ctor from round 6) — satisfying the `new()`
generic constraint. `compiler.js` now threads a `mechanicClassById` map
(mirroring `cardClassById`/`relicClassById`) through a new module-level
`currentMechanicClassById`/`mechanicClassName()` resolver so
`actionToCSharp`/`conditionToCSharp` can turn a schema `statusRef`
(mechanic id) into the real generated class name at codegen time —
`ForgeActions.ApplyStatus<FuryPower>(target, 3)` instead of a string.
**[BEST EFFORT]**: the overall `new T()` + `SetAmount` + `ApplyPowerInternal`
pattern is a reasonable reading of the API shape (matches how
`CustomCardModel`/`CustomPowerModel`'s constructors are always
parameterless, so per-application state has to live in a settable
property instead), not confirmed end-to-end by an actual build yet.

**Built-in statuses (Strength/Dexterity) — still NOT resolved.** These
aren't Forge-generated `CustomPowerModel` types, so they can't use the
new generic `ApplyStatus<T>()` at all — they need their OWN real
BaseLib/MegaCrit class names. `compiler.js`'s `GainStrength`/
`GainDexterity` action cases still route to `ForgeActions.Todo(...)`.
Round 7's incidental (buggy) AttackCommand-taker dump happened to reveal
several real built-in power classes under `MegaCrit.Sts2.Core.Models.Powers`
(`GigantificationPower`, `HellraiserPower`, `PainfulStabsPower`,
`SkittishPower`, `SuckPower`, `VigorPower`) — confirming that's the right
namespace, but `Strength`/`Dexterity` themselves didn't happen to appear
in that incidental list.

**Also fixed this round: a namespace placeholder gap.** Both
`Card.cs.template` and `Relic.cs.template` now unconditionally
`using {{namespace}}.Powers;` (needed for the generic type-argument
class names above) — which would hit the exact same `CS0234` bug fixed
for `.Cards`/`.Relics` in build attempt #3 if a character has zero
mechanics. Added the matching `Powers/_Namespace.cs` placeholder in
`generateProject` proactively, verified via the Node smoke test (a
zero-mechanic character correctly gets the placeholder file) rather than
waiting to discover it the hard way in a fifth real build.

**Also fixed this round: a latent `ForgeActions.TodoCondition` bug,
unrelated to this round's main work.** `compiler.js`'s `conditionToCSharp`
has called `ForgeActions.TodoCondition(...)` for `HpBelowPercent`/
`EnergyRemaining`/`CardsInHand`/`IsAttack` conditions since early in the
project, but `ForgeActions.cs.template` never actually declared that
method — only `Todo(string)` existed. This was never build-tested since
Tyler's test characters hadn't used those condition kinds yet, but would
have been a `CS0117`/`CS1061` the moment one was. Added
`public static bool TodoCondition(string what) => throw ...` alongside
`Todo`.

**Also fixed this round (tool-only): the `AttackCommand`-taker search's
false-positive bug.** The search matched not just `AttackCommand` itself
but also its base type as a fallback — since `AttackCommand`'s base is
plain `System.Object`, this accidentally matched every `Equals(object)`-
style method in both assemblies, bloating the round 7 output enough that
it had to be read in multiple pieces. Fixed to match the exact type only.

### reflect-baselib round 8 (shipped, not yet run by Tyler)

Added to `tools/reflect-baselib/Program.cs`:
- Lists every type directly in the `MegaCrit.Sts2.Core.Models.Powers`
  namespace (built-in powers), plus a case-insensitive fallback search for
  any type named like "Strength"/"Dexterity" anywhere in either assembly —
  to find the real class names `GainStrength`/`GainDexterity` need.

### reflect-baselib round 8, dump — processed, last known gap closed

Tyler ran round 8 (additive on top of rounds 1-7) and pasted back the
combined dump. It answered the last open question from build attempt #4:
the real class names for built-in Strength/Dexterity.

**Found: `MegaCrit.Sts2.Core.Models.Powers.StrengthPower` and
`MegaCrit.Sts2.Core.Models.Powers.DexterityPower`.** Both showed up in
round 8's namespace listing AND its Strength/Dexterity name-fallback
search, so there's no ambiguity about which class is the real one (as
opposed to e.g. `TemporaryStrengthPower`, `PossessStrengthPower`, or
`MonarchsGazeStrengthDownPower`, all of which also matched the fallback
search but are clearly different, more specific mechanics — real STS2
relics/cards that grant *temporary* Strength or manipulate someone else's
Strength, not the plain built-in status).

**Key structural finding: both derive `PowerModel` directly**
(`(base: MegaCrit.Sts2.Core.Models.PowerModel)`), NOT `CustomPowerModel`.
That meant the existing `ForgeActions.ApplyStatus<T>()` — constrained to
`where T : CustomPowerModel, new()` — could not accept them as-is. Rather
than add a second, near-duplicate generic method just for built-ins, the
constraint was relaxed to `where T : PowerModel, new()`. This is safe
because:
- `CustomPowerModel` itself derives `PowerModel` (confirmed all the way
  back in round 1's base-class dump), so every Forge-generated
  `Powers/XxxPower.cs` class still satisfies the relaxed constraint.
- Every member `ApplyStatus<T>` actually calls — `SetAmount(int, bool)`
  (round 7) and `Creature.ApplyPowerInternal(PowerModel)` (round 6) — is
  declared on `PowerModel` itself or on `Creature`, not on
  `CustomPowerModel`. Nothing in the method body was relying on anything
  `CustomPowerModel`-specific.
- `RemoveStatus<T>`/`GetStatusStacks<T>` were already constrained to
  `PowerModel`, not `CustomPowerModel` — so this makes `ApplyStatus<T>`
  consistent with its two siblings instead of an outlier.

`compiler.js` gained a `BUILTIN_POWER_CLASS_MAP` (`Strength`/`Dexterity`
-> fully-qualified `global::MegaCrit.Sts2.Core.Models.Powers.XxxPower`
strings). `global::`-qualifying rather than adding a `using
MegaCrit.Sts2.Core.Models.Powers;` to the templates was a deliberate
choice: a mod author could plausibly name their own custom mechanic
"Strength" (generating `{{namespace}}.Powers.StrengthPower`), and a
`using` for the real BaseLib namespace would create either an ambiguous
reference or silent shadowing depending on import order — fully
qualifying every use of a built-in power class sidesteps that entirely,
at zero cost since these two names are only used in two spots.

`GainStrength`/`GainDexterity` in `compiler.js`'s `actionToCSharp` now
emit `ForgeActions.ApplyStatus<global::...StrengthPower>(target, amount)`
(and Dexterity) instead of `ForgeActions.Todo(...)`. Tagged
`[BEST EFFORT]`, not `[VERIFIED]`, for one remaining reason: round 8
confirmed `StrengthPower`/`DexterityPower`'s namespace and base type, but
did NOT dump their own constructors directly — only the base
`PowerModel()` constructor (which is `protected`) was confirmed. The
assumption that `StrengthPower`/`DexterityPower` don't declare their own
constructor (so C#'s implicit public parameterless constructor applies,
same as already assumed for Forge's own generated `CustomPowerModel`
subclasses) is reasonable but not confirmed end-to-end. If a real build
disagrees here, the fix is narrow: either these two specific classes need
a different construction path, or (more likely, if consistent) the
assumption was fine and something else in the same call chain was wrong.

Re-ran the Node smoke test with a card exercising `GainStrength`+
`GainDexterity` on a card AND a relic hook — confirmed the generated C#
emits `ForgeActions.ApplyStatus<global::MegaCrit.Sts2.Core.Models.Powers.StrengthPower>(fgPlayer, 2);`
and the Dexterity equivalent, with correct fully-qualified type arguments
and no using-list changes needed. Both existing smoke tests (the original
mechanics-exercising one and this round's Strength/Dexterity-exercising
one) still pass.

### Next step

With this fix, **every known gap from real build attempts #1-4, across
all eight reflect-baselib rounds, has now been addressed** in the
generated templates/compiler. The strongest next step is for Tyler to run
a fresh test export and a real `dotnet build` — this would be the first
build attempt where every currently-known ground-truth question has
already been answered ahead of time, rather than discovered by the build
itself. If it fails, the failure is likely either (a) something genuinely
new (a signature this project's reflect tool hasn't targeted yet), or (b)
one of the `[BEST EFFORT]` assumptions flagged throughout this doc turning
out wrong — both are useful, narrower signals than another blind guess
would be.

## App-level stress test — build attempt #5, and the "nothing validates
## anything" gap

Different kind of round: Tyler deliberately built three broken pieces of
content to stress-test the APP itself, not the toolchain — a card with a
negative cost and a "Passive" trigger whose OnPlay-only compiler silently
ignores it, a card action (`ExhaustCard`) targeting an enemy despite that
making no sense, a relic using the card-only "OnPlay" trigger, and a
mechanic with genuinely no way to define what it does. He also shipped an
actual `dotnet build` attempt (#5) alongside this, which caught one real
compiler error.

### The one real build error: CS0246 on `CustomPowerModel`

`Powers/NewStatusPower.cs(26,38): error CS0246: The type or namespace name
'CustomPowerModel' could not be found`. `Power.cs.template` was simply
missing `using BaseLib.Abstracts;` — every other generated file
(Card/Relic) already had this import; this one never got build-tested
before because every earlier test character had 0 mechanics. One-line
fix, [VERIFIED] by the exact same reasoning as every other file's
`BaseLib.Abstracts` import (reflect-baselib round 1 confirmed that's
where `CustomPowerModel` lives).

### The bigger finding: nothing validated a package before compiling it

`server.js`'s `/api/compile` handler had ONLY ever checked that
`character.name` existed and `cards` was an array — literally everything
else (cost ranges, enum values, which trigger makes sense on which entity
type, whether an action's target makes sense for that action type) went
straight through to `generateProject()` untouched. `schema/
character.schema.json` existed and *described* several of these
constraints (e.g. `card.cost` already had `"minimum": -1`) but was never
actually run against anything — pure documentation. Tyler's stress test
found four concrete consequences of this:

1. **Cost -5 compiled clean.** `baseCost: -5` is syntactically valid C#,
   so nothing caught it. -1 is a real, meaningful value (STS2's "X cost");
   anything below that isn't.
2. **A card's "Passive" effect block silently vanished.**
   `generateCardSource` has only ever looked at `OnPlay`-triggered
   effects (that's the only real hook this project has confirmed for
   `CustomCardModel`) — everything else was filtered out with zero
   warning. The card compiled clean, looking successful, while quietly
   doing nothing extra.
3. **A relic using "OnPlay" compiled, but meaninglessly.** `TRIGGER_HOOKS`
   had an `OnPlay` entry mapping to `AfterCardPlayed` so relics could
   "use" it too — but that hook fires for ANY card ANYONE plays, not
   something intrinsic to the relic, and its `cardPlay.Target` is
   whatever the triggering card's target happened to be (nullable, for an
   untargeted card). "Deal damage to a single enemy" via this trigger
   doesn't mean what it looks like it means.
4. **`ExhaustCard` targeting `AllEnemies` compiled clean.** Nothing
   restricted an action's `target` based on its `type` — player/hand/deck
   -level actions (`DrawCard`, `GainEnergy`, `GainGold`, `DiscardCard`,
   `ExhaustCard`, `CreateCardInHand`, `CreateCardInDrawPile`,
   `ShuffleCardIntoDraw`) have no "target an enemy" concept in this game
   at all.
5. **Mechanics had no way to define behavior at all.** The schema had
   `id`/`name`/`stackable`/`decaysPerTurn`/`isBuff` and nothing else — a
   mechanic compiled to a real `CustomPowerModel` with only its required
   `Type`/`StackType`/`ShouldReceiveCombatHooks` overrides. There was no
   field anywhere to say what a custom status actually DOES when it
   procs.

### Fixes shipped this round

**Real validation, not just shape-checking.** New `backend/validate.js` —
hand-rolled rather than an `ajv` dependency (several of the rules that
matter most are cross-field: an action's valid targets depend on its
type; a card's valid triggers differ from a relic's — awkward to express
as a bare JSON-Schema enum anyway). Checks: cost range, every enum field,
per-entity-kind trigger validity, per-action-type target validity,
`statusRef`/`cardRef`/`startingDeckCardIds`/`startingRelicId` reference
integrity. Returns ALL errors at once, not just the first. Wired into
`server.js`'s `/api/compile` as the very first thing that runs, replacing
the old two-line stub — a bad package now gets one clear 400 response
listing everything wrong, instead of silently compiling into
misleading-looking C#.

**Card triggers restricted to `OnPlay` only** (frontend dropdown +
`validate.js` + a `generateCardSource` throw as a third backstop, in case
`generateProject()` is ever called directly without going through
validation first). This is the true fix for the "Passive silently
vanishes" bug — better than trying to detect and warn about it, the
invalid state is no longer representable through the UI at all, and a
stale/hand-crafted package with an old trigger gets a clear rejection
instead of silent data loss.

**Relic/mechanic triggers exclude `OnPlay`** (same three-layer pattern —
frontend, validator, and a `generateHookEffects` throw). `TRIGGER_HOOKS`
no longer has an `OnPlay` entry at all. A relic-appropriate "whenever ANY
card is played" trigger might be worth reintroducing later under a
clearer name (e.g. `OnAnyCardPlayed`) now that it's understood to be a
different concept from a card's own `OnPlay` — that's a new feature for
later, not part of this fix.

**Action targets restricted per action type** — `PLAYER_ONLY_ACTIONS` +
`validTargetsForAction()` (compiler.js, exported and reused by
`validate.js` so there's one source of truth; mirrored in
`frontend/index.html` for the live dropdown). The frontend's action-type
dropdown now re-renders the target dropdown's options whenever the action
type changes, snapping the stored target to a valid option if the
previous one no longer is one — this is the "field should update
dynamically" behavior Tyler asked for.

**Mechanics can now define real behavior.** `mechanic.effects` (schema,
new) — same `trigger -> conditions -> actions` shape as relics, since a
mechanic (like a relic) is hook-driven rather than "played". The relic
hook-generation code (previously `generateRelicHooks`) was generalized
into `generateHookEffects(entity, entityKind)` and is now shared by both
`Relic.cs.template` and the rewritten `Power.cs.template`. The frontend's
mechanic modal gained a full effects editor (reusing the same
trigger/condition/action UI components cards and relics already use).

One honest, deliberately-flagged gap in the mechanic-effects feature:
player/target binding inside a mechanic's own hook methods reuses the
EXACT SAME best-effort expressions already used for relics (e.g.
`OnTakeDamage` binds `fgPlayer`/`fgTarget` to the hook's `target`/`dealer`
parameters) — none of this has been confirmed to specifically mean "the
creature that HOLDS this power instance." For triggers where that
happens to line up anyway (a poison-style "this power's owner takes
damage," via `OnTakeDamage`) it's usable as written; for anything that
needs the power's actual owner regardless of trigger, that's still an
open question. **Reflect-baselib round 9 candidate**: search `PowerModel`
for an `Owner`/`Holder`/`Source`-style `Creature`-typed member — if one
exists, mechanic hook binding could be tightened to reference it directly
instead of borrowing whatever a given hook's own parameters happen to
expose.

Also fixed in passing: `frontend/index.html`'s `ACTION_TYPES` list was
missing `CreateCardInDrawPile`/`ShuffleCardIntoDraw`, present in the
schema/compiler but never selectable in the UI — added for consistency.

### Verification

Re-ran both existing Node smoke tests (unchanged, still pass) plus a new
comprehensive check exercising: Tyler's exact broken package (rejected,
all 4 issues reported, nothing else), a full valid package including a
`mechanic.effects` block (accepted, generates real `AfterSideTurnStart`
hook code with no leftover `{{...}}` placeholders), and an unknown
`statusRef` reference (rejected with a clear message). All defense-in-depth
throws in `compiler.js` (card w/ non-OnPlay trigger, relic w/ OnPlay
trigger, action/target mismatch) verified directly by calling
`generateProject()` with `validate.js` deliberately bypassed. One bug
caught and fixed during this verification pass: the new
`Power.cs.template`'s header comments used literal `` `{{hookMethods}}` ``
inside prose (meant as a readable placeholder name) — `fillTemplate`'s
substitution is a blind global regex over the WHOLE template file, so
those comment mentions got replaced with the actual generated hook-method
C# instead of staying as text, producing a garbled header. Fixed by
rewording the comments to describe the block without using the literal
`{{word}}` token syntax — grepped every other `.template` file for the
same pattern (`` `{{ ``) to confirm none of them had the same latent bug.

### Next step

Ship this to Tyler; the CS0246 fix means the next full test-character
build should get further than build attempt #5 did. The validation layer
means any FUTURE stress test (or an accidental slip through the UI) gets
a clear rejection message instead of silently-wrong generated code — that
class of bug should be structurally much harder to reintroduce now. The
mechanic-effects feature is new and unverified end-to-end (no real build
has exercised a mechanic with an actual hook body yet) — worth an early
test character that gives a custom mechanic a real `OnTurnStart`/
`OnTakeDamage` effect and runs it through a real `dotnet build`.

### Follow-up bug: ApplyStatus/RemoveStatus had no way to pick WHICH status

Reported directly by Tyler right after the round above shipped: setting an
action's type to "Apply Status" always failed export validation with
"ApplyStatus requires statusRef", with no obvious way to fix it in the UI.

Root cause: `renderActionRows` in `frontend/index.html` has ONLY ever
rendered `type` / `target` / `amount` for an action row — there was never
a `statusRef` field at all, for any action type, at any point in this
project's history. This predates the validation-layer round above; it
just went unnoticed until `validate.js` started actually enforcing the
requirement `ApplyStatus`/`RemoveStatus` already had in the schema and in
`compiler.js` (`mechanicClassName()` throws if `statusRef` doesn't
resolve to a defined mechanic) — before that, the only way to discover
this gap was a `dotnet build` failing deep inside generated C#, or (worse)
`ForgeActions.ApplyStatus<${mechanicClassName(action.statusRef)}>` being
handed `undefined` and producing garbage.

Fixed: the action row now conditionally renders a `.a-status` dropdown
(listing every defined mechanic by name, or a disabled "— no mechanics
defined —" placeholder if there are none yet) whenever the action's type
is `ApplyStatus` or `RemoveStatus`, and hides the amount field for
`RemoveStatus` specifically (`ForgeActions.RemoveStatus<T>(target)` takes
no amount at all — real signature, reflect-baselib round 7). The whole
row's field set now rebuilds (not just the target dropdown, which
already did this from the previous round) whenever the action type
changes, and — separately — a saved action that already has type
`ApplyStatus`/`RemoveStatus` but no `statusRef` (e.g. from before this
fix) gets a mechanic auto-assigned on load rather than rendering a
dropdown that LOOKS like something is selected (browsers auto-select the
first `<option>` when none is marked `selected`) while the underlying
data stays empty underneath.

Verified via a standalone Node harness exercising the extracted helper
functions (`actionNeedsStatusRef`, `actionNeedsAmount`,
`statusRefOptionsHtml`) directly, since this is pure frontend/DOM logic
with no C#/build angle to it. `backend/validate.js` needed no changes —
it was correctly rejecting exactly what it was designed to reject; the
bug was entirely that the UI never gave a way to satisfy it.

### Design change: vanilla vs custom status actions split into 4 action types

Requested directly by Tyler as a follow-up: "Apply Status" only ever meant
a custom mechanic (statusRef), with vanilla statuses (Strength/Dexterity)
living as their own separate, dropdown-less action types
(`GainStrength`/`GainDexterity`) — two different UI shapes for what's
conceptually the same thing ("give a creature a status"). Requested split:
"Apply Status" gets a dropdown of real vanilla game statuses; a new
"Apply Custom Status" gets the mechanic dropdown that used to live under
"Apply Status".

**New action-type taxonomy**: `ApplyStatus`/`RemoveStatus` (vanilla —
`builtinStatus` field, dropdown sourced from `BUILTIN_STATUSES`, itself
derived from `BUILTIN_POWER_CLASS_MAP`'s keys) and `ApplyCustomStatus`/
`RemoveCustomStatus` (custom mechanic — `statusRef` field, dropdown of
`state.mechanics`, exactly what plain "ApplyStatus"/"RemoveStatus" used to
mean). `GainStrength`/`GainDexterity` are retired — superseded by vanilla
`ApplyStatus` + `builtinStatus: "Strength"`/`"Dexterity"`. Added the
"Remove Status" (vanilla) side proactively for symmetry with the new
"Remove Custom Status", even though only "Apply" was explicitly asked for
— `ForgeActions.RemoveStatus<T>` already works generically for any
`PowerModel`-derived class (built-in or custom, since round 8's
constraint relaxation), so there was no reason to leave Remove
inconsistent with the new Apply/Custom split.

**Underlying C# generation is unchanged** — same real `ForgeActions.
ApplyStatus<T>()`/`RemoveStatus<T>()` generic methods either way, just
resolving `T` from a different map depending on which of the 4 action
types is used (`BUILTIN_POWER_CLASS_MAP[action.builtinStatus]` vs
`mechanicClassName(action.statusRef)`). `compiler.js` now exports
`BUILTIN_STATUSES` (`Object.keys(BUILTIN_POWER_CLASS_MAP)`) alongside the
existing `PLAYER_ONLY_ACTIONS`/`validTargetsForAction` exports, so
`validate.js` stays the single source of truth's consumer rather than
hand-copying the built-in status list.

**localStorage migration**: this redefines what `"ApplyStatus"`/
`"RemoveStatus"` MEAN for any character Tyler already had saved in his
browser before this change (previously always custom, now always
vanilla) — a real backward-compatibility concern, not just a schema
nicety. `frontend/index.html` gained `migrateLegacyStatusActions()`, run
on every `load()` (idempotent — safe to run against already-migrated or
brand-new data): an old `GainStrength`/`GainDexterity` action becomes
vanilla `ApplyStatus` with the matching `builtinStatus`; an old
`ApplyStatus`/`RemoveStatus` action that already has a `statusRef` (the
telltale sign it meant "custom" under the old rules) becomes
`ApplyCustomStatus`/`RemoveCustomStatus`. `blankState()`'s
`formatVersion` bumped 1 -> 2 to mark the new baseline shape, though the
migration itself runs unconditionally rather than gating on the version
number (simpler, and version-gating would have required trusting that
every existing save actually had the field set correctly).

Verified via a standalone Node harness: fed the migration function a
package built from Tyler's actual pre-change action shapes (one of each:
`GainStrength`, `GainDexterity`, `ApplyStatus`+`statusRef`,
`RemoveStatus`+`statusRef`, plus an unrelated `DealDamage` to confirm
non-status actions pass through untouched) — all four migrated to the
correct new shape, and running the migration a second time against
already-migrated output produced byte-identical results (confirms
idempotency, i.e. reopening the app repeatedly can't double-migrate or
corrupt data). Also re-ran the full validate.js + generateProject()
round trip with the new 4-action-type taxonomy directly (bypassing the
frontend migration, as `server.js` always does) — generates the same
underlying `ForgeActions.ApplyStatus<T>()`/`RemoveStatus<T>()` calls as
before, just resolving `T` through whichever map matches the action type
used.

### Full vanilla status list (247, not 2), multi-select apply/remove, and a real "Remove All Statuses"

Tyler's request, three parts: "Is it possible to scan the game's files for
a list of all vanilla statuses and not just strength and dexterity? Also
some statuses may accumulate, so there should be a way to apply more than
one and remove more than one. It should also preserve the 'remove all' if
possible."

**Part 1 — the full status list.** No new `reflect-baselib` run was
needed: the round 8 combined dump (`e99b61b2-reflectoutput.txt`, the same
file that found Strength/Dexterity) already contains the FULL
`MegaCrit.Sts2.Core.Models.Powers` namespace listing — round 8 just never
looked past the two statuses that mattered at the time. Re-mined that
same file for every line matching `MegaCrit.Sts2.Core.Models.Powers.X
(base: MegaCrit.Sts2.Core.Models.PowerModel)` — i.e. every class deriving
`PowerModel` DIRECTLY, which excludes both compiler-generated nested
types (`+<>c`, `+Data`, async-state-machine `+<...>d__N` types) and a
handful of classes that derive some OTHER concrete power instead of
`PowerModel` itself (e.g. one-offs that subclass `TemporaryStrengthPower`)
— those aren't safe to `new()` up generically the way
`ForgeActions.ApplyStatus<T>()` does. Result: 247 unique classes, no
duplicates, including every recognizable classic STS status (Vulnerable,
Weak, Frail, Poison, Thorns, Buffer, Intangible, Confused, Regen,
Artifact, Barricade, ...) plus Strength/Dexterity. `compiler.js`'s
`BUILTIN_POWER_CLASS_MAP` grew from 2 entries to all 247;
`BUILTIN_STATUSES` (its exported key list, consumed by `validate.js` and
mirrored into `frontend/index.html`'s own `BUILTIN_STATUSES` literal,
since the browser has no `require()`) updates automatically.

**Open risk, flagged but not yet resolved**: `ApplyStatus<T>()`'s generic
constraint is `where T : PowerModel, new()` — every `T` needs a public
parameterless constructor. That's only ever been checked (as best-effort,
via "a concrete C# class with no declared constructor gets an implicit
public parameterless one," not a real build) for Strength/Dexterity
specifically. None of the other 245 classes' constructors have been
individually reflected — if one of them declares its own non-default
constructor, selecting it would be a hard compile error (CS0310) the
moment a card/relic/mechanic using it gets built. A `reflect-baselib`
round 9 that runs the existing `DumpConstructors` helper across the whole
`Powers` namespace would close this gap. Not blocking this round (no way
to confirm without a real `dotnet build`, which this sandbox can't run),
but worth doing before leaning on an obscure entry from this list in a
real build.

**Part 2 — multi-select.** `builtinStatus` (singular string) and
`statusRef` (singular string, for the 4 status-related action types
specifically — its OTHER uses, on `HasStatusStacks` conditions and
`amountScalesWithStatus`, are untouched and stay singular) became
`builtinStatuses`/`statusRefs` (arrays). `compiler.js:actionToCSharp`'s
`ApplyStatus`/`RemoveStatus`/`ApplyCustomStatus`/`RemoveCustomStatus`
cases now loop over the array and emit one `ForgeActions.ApplyStatus<T>()`
/`RemoveStatus<T>()` call per selected entry, sharing the action's
`target`/`amount` — e.g. one "Apply Status" action picking Vulnerable +
Weak emits two calls. `effectBlockToCSharp` had a latent indentation bug
here: it always indented only the FIRST line of an action's generated
code inside a conditional block, which was invisible with one line per
action but would have produced visibly mis-indented (though still
compile-valid) C# once one action could emit several lines — fixed by
indenting every line of a multi-line action's output.
`backend/validate.js` requires a non-empty `statusRefs[]`/
`builtinStatuses[]` array for these action types (falling back to reading
a legacy singular field as a one-element array, so an old saved package
mid-migration or a hand-built test package still validates) and checks
every entry individually. `frontend/index.html`'s single `<select>` for
these fields became `<select multiple>`; the built-in status one also got
a text filter input (`.a-builtin-filter`) given the jump from 2 to 247
options — filters by hiding non-matching `<option>` elements client-side,
no server round-trip.

**Part 3 — "Remove All Statuses," preserved on a real API.** Grepped the
already-collected reflectoutput.txt files for "clear|removeall|cleanse|
purge|RemoveAllPowers" and found a real, `[Creature, concrete, public]`
method already sitting in the round 8 dump (never previously used):
`IEnumerable<PowerModel> RemoveAllPowersInternalExcept(IEnumerable<PowerModel> except)`.
Calling it with an empty collection removes every power currently on the
target — vanilla and custom alike, since the method doesn't distinguish.
Added `ForgeActions.RemoveAllStatuses(Creature target) =>
target.RemoveAllPowersInternalExcept(Array.Empty<PowerModel>())` (tagged
`[VERIFIED]` — real method, not a guess) and a new `RemoveAllStatuses`
action type (`compiler.js`, `validate.js`, `schema/character.schema.json`,
`frontend/index.html`) that needs neither a status list nor an amount,
just a target. This is what "preserve the 'remove all' if possible" asked
for — it existed nowhere before this (there was no bulk-remove action of
any kind, vanilla or custom), so "preserve" here means "the multi-select
redesign doesn't lose the ability to strip everything," now backed by a
real method instead of looping over every known status by hand (which
would also have silently missed anything not in `BUILTIN_POWER_CLASS_MAP`
— a mechanic Tyler defines, for instance).

**localStorage migration, again**: `migrateLegacyStatusActions()` gained
a second migration step (still one function, still runs unconditionally
on every `load()`, still idempotent) — after the existing v1->v2 step
(GainStrength/GainDexterity -> ApplyStatus, etc.), a new v2->v3 step
converts any leftover singular `builtinStatus`/`statusRef` on the 4
status-related action types into the new `builtinStatuses`/`statusRefs`
arrays, then deletes the old singular field. `blankState()`'s
`formatVersion` bumped 2 -> 3.

**Verification**: `node --check` on `compiler.js`/`validate.js` and on
the extracted frontend `<script>` block; a full-file brace/paren balance
check on the frontend script (159/159, 440/440). Ran `generateProject()`
against a hand-built package exercising every new path — multi-select
`ApplyStatus` (2 built-ins) inside an `if (HasStatusStacks...)` block
(confirmed correct per-line indentation of the resulting 2-line block),
multi-select `ApplyCustomStatus`/`RemoveCustomStatus` against a real
mechanic class name, and `RemoveAllStatuses` — inspected the generated
C# directly and confirmed 2 `ForgeActions.ApplyStatus<T>()` calls (one
per selected status), correctly resolved custom mechanic calls, and the
new `ForgeActions.RemoveAllStatuses(...)` call, all correctly indented.
Ran `validate.js` against five hand-built cases (valid multi-select
package; missing `builtinStatuses` entirely; an invalid entry inside
`builtinStatuses`; a legacy singular `builtinStatus` still accepted as a
fallback; an empty `statusRefs` array) — all five produced the expected
`valid`/`errors` result with clear messages. Ran the migration function
directly against both a v1-style package (`GainStrength` +
`ApplyStatus`+`statusRef` under the old meaning) and a v2-style package
(singular `builtinStatus`/`statusRef`) — both migrated to the identical
correct v3 shape, and running the migration again against its own v3
output was confirmed byte-identical (idempotent). No `dotnet build`
available in this sandbox, so none of this is confirmed against a real
compiler — same caveat as every other round.

### Status/mechanic picker UX pass — pure frontend, no generated-C# changes

Tyler's follow-up on the 247-status/multi-select round above: the native
`<select multiple>` (ctrl/shift-click) was awkward at 247 options, there
was no way to see what a status DOES while picking it, and the full list
dumping itself onto the screen the instant "Apply Status" was selected
was noisy. All fixes are `frontend/index.html`-only — nothing here
touches `compiler.js`/`validate.js`/the schema, since the underlying
`act.builtinStatuses`/`act.statusRefs` array shape (and everything
downstream of it) is unchanged.

- **Checkboxes replace ctrl/shift-click.** `renderStatusPicker(kind, act,
  fieldName)` is a new shared widget (used for both the built-in status
  field and the custom-mechanic field) that renders a checkbox per
  option; toggling one directly pushes/splices `act[fieldName]` — no
  modifier-key gesture required.
- **Selected values show as chip bubbles** above the filter box at all
  times (a `✕` on each chip removes it and unchecks the matching box), so
  "what does this action apply" is visible without opening the list.
- **The full list only appears after the filter box is focused/clicked**
  (a `.picker-wrap.open` class toggled on focus, closed by a single
  delegated `document` click listener that closes any open picker not
  containing the click target) — addresses "the list should only appear
  after you click the filter box," and also fixes the underlying "247
  options is a lot to look at by default" problem the filter box was
  already there to solve.
- **Hover tooltips** on both the checkbox rows and the chip bubbles (plain
  `title` attribute — the simplest reliable cross-browser hover
  mechanism) show what each status/mechanic does. For built-in statuses,
  a new `STATUS_DESCRIPTIONS` map covers 35 statuses that map onto a
  recognizable Slay the Spire 1 mechanic of the same name — tagged
  `[BEST EFFORT, NOT VERIFIED against real STS2]` in its header comment,
  since `reflect-baselib` only ever exposed class/method NAMES, never the
  actual gameplay/tooltip text (that lives in the game's own localization
  data, which nothing here has read). The other ~212 statuses fall back
  to an honest "no description available yet" message rather than
  guessing at an unfamiliar STS2-only name. Custom mechanics show their
  own schema `description` field as their tooltip (already existed,
  simply wasn't surfaced anywhere before).
- **"remove block" → "remove this effect"** on the effect-block remove
  button (shared by cards/relics/mechanics via `renderEffectsList`) —
  clearer about what the button actually deletes.

**Verification**: `node --check` + brace/paren balance on the extracted
frontend `<script>` block (167/167). Extracted `BUILTIN_STATUSES`/
`STATUS_DESCRIPTIONS` and confirmed every one of the 35 description keys
matches a real entry in `BUILTIN_STATUSES` (no stale/misspelled keys), and
spot-checked that an undescribed status (e.g. "Accelerant") correctly
returns `undefined` from the map (so the fallback text path is actually
exercised, not silently skipped). No DOM test harness in this sandbox, so
the interactive behavior (checkbox wiring, chip removal, filter-reveal,
outside-click-close) is reviewed by hand rather than run — worth a manual
click-through in the real app before relying on it for a complex
character.

## First real build confirmation of the ApplyStatus<T> feature set

Tyler uploaded a compiled `test_char.zip` — "It compiled correctly." This
is the first real `dotnet build` success that actually exercises the
multi-select/built-in-status work from the last two rounds: the zip
contains a real `TestChar.dll`/`.pck`/manifest, and `Cards/NewCardCard.cs`
inside it has a genuine, compiler-accepted
`ForgeActions.ApplyStatus<global::MegaCrit.Sts2.Core.Models.Powers.StrengthPower>(fgPlayer, 3);`
call. That moves `StrengthPower`'s constructor-accessibility assumption
(see the 247-status round above — `ApplyStatus<T>()`'s `where T :
PowerModel, new()` constraint needs a public parameterless constructor,
previously only assumed by C# default-constructor rules, never build-
confirmed) from best-effort to build-confirmed for that one class. The
constructor risk for the other 246 classes in
`BUILTIN_POWER_CLASS_MAP` is unchanged — still open, still flagged as a
round-9 candidate.

## Per-entry amounts for multi-select Apply actions

Tyler's follow-up, off the back of that successful build: "making a much
smaller number selector next to each status... This means that you can
have one block for 'apply status' and have it apply something like 3
strength and 5 dexterity as opposed to having multiple apply status
effects for different numbers."

**Design**: `ApplyStatus`'s single shared `amount` field is now only a
FALLBACK. A new `action.statusAmounts` object (keyed by built-in status
name, e.g. `{ "Strength": 3, "Dexterity": 5 }`) lets each selected status
carry its own amount; `ApplyCustomStatus` gets the equivalent
`action.refAmounts` (keyed by mechanic id). `compiler.js:perEntryAmount(
action, amountsMap, key)` resolves the amount for one entry with a
three-step fallback: the per-entry map value if present -> the action's
old flat `amount` if present -> `1`. This means a package saved before
this feature (one shared `amount` across every selected status) keeps
compiling with that same value applied uniformly, without needing every
existing character to be re-edited. Deliberately did NOT extend this to
`RemoveStatus`/`RemoveCustomStatus` — those never took an amount at all
(`ForgeActions.RemoveStatus<T>` only takes a target), so there's nothing
to make per-entry.

**Frontend**: `renderStatusPicker()` (the checkbox/chip/filter widget
from the previous round) gained an optional `amountsField` parameter.
When set (only for `ApplyStatus`/`ApplyCustomStatus`), each checkbox row
gets its own small number input — hidden via CSS until that row is
checked, so the list doesn't show 247 irrelevant number boxes — and the
chip bubble for a selected entry shows "Label ×N" so the amount is
visible at a glance alongside the selection itself. The single shared
`amount` input at the top of the action row (previously always shown
except for Remove* actions) is now ALSO hidden for `ApplyStatus`/
`ApplyCustomStatus` specifically (`actionNeedsAmount()` updated) — every
other action type (DealDamage, GainBlock, LoseHp, HealHp, the
player/run-level ones) is unaffected and keeps the single shared amount
field exactly as before.

**Migration**: `migrateLegacyStatusActions()` gained a v3->v4 step —
for every currently-selected status/mechanic on an `ApplyStatus`/
`ApplyCustomStatus` action, if there's no per-entry amount yet, copies
the action's old flat `amount` (or `1` if that's also missing) into the
new map, then deletes the flat `amount` field from these two action types
specifically (every other action type's `amount` field is untouched).
`formatVersion` bumped 3 -> 4. Still idempotent (a re-run only fills a
map entry that's genuinely missing, never overwrites one that's already
there — verified directly, including the full v1->v4 chain in one call).

**Validation**: `backend/validate.js` type-checks `statusAmounts`/
`refAmounts` when present (must be a plain object, every provided value
must be a number) but doesn't require an entry for every selected
status/mechanic — the compiler's own fallback chain makes a missing entry
harmless, so requiring one would just be busywork validation with no real
payoff.

**Verification**: `node --check` + brace/paren balance on `compiler.js`,
`validate.js`, and the extracted frontend `<script>` block (all balanced).
Ran `generateProject()` against hand-built packages covering: two
built-in statuses with distinct per-entry amounts (Strength 3, Dexterity
5 — confirmed exact numbers in the generated C#), a custom mechanic with
an explicit per-entry amount alongside one relying on the "no map, no
flat amount" -> `1` default, and a built-in status relying purely on the
legacy flat `action.amount` fallback (no `statusAmounts` map at all) —
all four fallback paths produced the correct number in the generated
`ForgeActions.ApplyStatus<T>()` call. Ran `validate.js` against a valid
per-entry package, a non-numeric entry, an array passed where an object
was expected, and a package with no `statusAmounts` at all (correctly
still valid, relying on the compiler's fallback) — all four produced the
expected result. Ran the v3->v4 migration directly (including a
`RemoveStatus` action confirmed to correctly get NO amount map at all)
and confirmed idempotency, plus the full v1->v4 chain in a single call.
Still no `dotnet build` available in this sandbox for the per-entry-
amount feature specifically — everything above is generated-code/logic
verification, not a real compile, same caveat as always, though the
underlying `ForgeActions.ApplyStatus<T>()` call shape itself is now
build-confirmed per the section above.

## Blue theme recolor + live card art preview — pure frontend, no generated-C# changes

Tyler: "I'm not in love with the brown color of everything. Can we use
various shades of blue? Preferably something darker for the main page so
it doesnt strain the eyes." Plus a live card-art preview while editing,
with an explicit "may want later" nod toward a Moxfield-style tiled
gallery view (not built this round — flagged as a real future ask, not
implied scope creep). All frontend-only, `frontend/index.html` — nothing
here touches `compiler.js`/`validate.js`/the schema.

**Recolor**: replaced the old warm brown/parchment palette with a blue
one in `:root`. `--ink` (the page background base) went notably darker
(`#161310` -> `#0a121e`) specifically per "darker... so it doesn't strain
the eyes" — panel surfaces (`--stone`/`--stone-2`) sit a couple steps
brighter than that so panels still read as distinct surfaces against a
darker page. The old `--ember`/`--ember-bright` accent variables were
renamed to `--accent`/`--accent-bright` (a warm-color name didn't fit a
blue palette) — every `var(--ember...)` reference was updated to match,
including two JS string literals (`gameStatusEl.style.color =
'var(--ember-bright)'`) that a pure-CSS find/replace wouldn't have
caught. New `--border`/`--border-soft` variables replace what were
previously ~16 scattered hardcoded brown hex literals
(`#3a3226`/`#4a4132`/`#4a4030`) across the stylesheet — consolidating
those means a future palette tweak only touches `:root`, not the whole
file. `--danger`/`--danger-bright` (delete/remove buttons) kept a red
hue on purpose — a blue "danger" button reads as anything but dangerous
— just adjusted slightly for legibility against the new dark blue instead
of the old dark brown. The character's own default accent color
(`character.color`, what tints THEIR cards/energy orb in the actual
game — a real gameplay field, not app chrome) was deliberately left
alone at its existing default; recoloring the app's own UI chrome is a
different thing from picking a character's in-game color, and Tyler
already has a color picker for that.

**Live card art preview**: `card.artAssetRef`/`assets[].kind:'cardArt'`
already existed in the schema but were never wired to anything in the
frontend — there was no upload control anywhere, so this field was
dead. Added a file input (`accept="image/png,image/jpeg,image/webp"`) in
the card editor, read via `FileReader.readAsDataURL` (same in-memory,
no-network approach as everything else in this app), plus a
`renderCardPreview()` widget that live-updates a rough card-shaped
element (cost badge, name, type/rarity footer, Exhaust/Innate/Ethereal
keyword pills, the uploaded art as a background image or a type-name
watermark placeholder if none) from whatever's CURRENTLY in the form
fields — not the saved `card` object, consistent with this editor's
existing "nothing touches state until Done" convention. The uploaded
art itself follows that same convention: held in a local
`pendingArtDataUrl` closure variable, only committed to
`state.assets`/`card.artAssetRef` when Done is clicked, so closing the
editor without saving (or deleting the card) can't leave an orphaned
upload behind. The modal gained an optional "wide" mode
(`openModal(html, {wide:true})`) so the card editor alone gets the extra
width for a form+preview side-by-side layout — every other editor
(relic/mechanic/character) is unaffected and keeps its original width.
**Honest caveat, stated directly in the editor's own hint text**:
`compiler.js` never reads `artAssetRef`/`assets` at all — this is a
design-time preview only, nothing about it is exported into the compiled
mod yet. Baking real card art into the Godot `.pck` (texture import,
`CardArt` resource reference on the generated card model, etc.) is a
separate, unstarted feature.

**Small step toward the "tiled gallery" want**: the existing card grid
tile now shows the art as a background image (with the same darkening
gradient treatment as the preview, so the name/cost text stays legible)
when a card has art set — not the full Moxfield-style gallery Tyler
described wanting "later," but a card with art now visually stands out
in the grid that already exists, at effectively no extra cost. The full
tiled/zoomable gallery view remains unbuilt and is worth asking Tyler
about scope for directly when he's ready for it (a dedicated view? just
bigger tiles? a lightbox?).

**Verification**: `node --check` + brace/paren/backtick-balance on the
extracted frontend `<script>` block (all balanced). Full visual
verification via Playwright + the sandbox's pre-installed Chromium
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) — screenshotted
the main page, the card editor (empty state and with a real uploaded
test image), the resulting grid tile, reopening the same card to confirm
the art persisted through a save/reload cycle, the "Remove art" flow
reverting to the placeholder, the status/mechanic picker widgets (to
confirm the recolor didn't break their contrast/legibility), and the
relic editor (to confirm modals that DON'T use the new `wide` mode are
unaffected). Watched the browser console throughout — the only errors
were the expected `/api/game-status` fetch failures from running the
file directly with no backend server present (a `file://` CORS/network
limitation of this test, not a real app bug), nothing related to the
recolor or the new art/preview code.

## Card keywords (full real set) + type colors — Tyler's verbatim request

Tyler: "Currently the only effect trigger is OnPlay. Can we add other
conditional triggers? such as 'When retained' or 'While in discard' or
'When discarded'. In addition to this there should be other possible
attributes tied to cards instead of just exhaust, ethereal, and innate.
There should also be some others like 'Sly', 'Eternal', and 'Unplayable'.
Can you gather a list of all of the card modifiers such as this and come
up with a sleek way of having all of those be selectable? Oh and Attacks
are generally red, Skills are typically blue, Powers are typically green,
statuses are grey, and curses are black."

Three asks: (1) new per-card effect triggers beyond OnPlay, (2) the full
real set of card keywords/modifiers, selectable in a sleek UI, (3) fixed
type-based colors. (2) and (3) are fully implemented. (1) is answered
honestly rather than faked — see below.

### What "gather a list of all of the card modifiers" turned up

`schema/character.schema.json`'s card definition already only exposed 3 of
the 7 real keywords (exhausts/innate/ethereal, as separate booleans).
Re-checked this doc's own earlier findings first: reflect-baselib round 1
had ALREADY confirmed the full real `CardKeyword` enum — `None`/`Exhaust`/
`Ethereal`/`Innate`/`Unplayable`/`Retain`/`Sly`/`Eternal` — and round 2 had
ALREADY confirmed `AddKeyword(CardKeyword keyword)` as a real, concrete,
public method. The other 4 (Unplayable, Retain, Sly, Eternal — exactly the
3 Tyler named plus Retain, which he didn't but which is real) were simply
never wired up to anything. No new reflection needed for this part — just
finishing what was already confirmed.

Their actual *behavior* isn't something reflection can see (it only shows
member names, not what they do), so their definitions/tooltip hints are
sourced from community documentation instead — `slaythespire.wiki.gg`'s
Keywords page and `mobalytics.gg`'s keyword guide, cross-checked against
each other:

- **Exhaust** — removed from the deck until the end of combat once played.
- **Ethereal** — auto-Exhausted if still in hand at the end of your turn.
- **Innate** — always in your opening hand at the start of combat.
- **Retain** — stays in hand at the end of your turn instead of being discarded.
- **Unplayable** — can't be played from hand; no Energy cost.
- **Sly** — "if this card is discarded during your turn, it immediately
  plays for free." (Per `slaythespire.wiki.gg`, this is a Silent-exclusive
  keyword in the base game — Forge doesn't enforce that restriction, since
  a custom character isn't the Silent, and there's no confirmed real
  mechanism for character-locking a keyword anyway.)
- **Eternal** — cannot be removed or transformed from your deck by other effects.

**This directly answers one of Tyler's three requested triggers.** "When
discarded" isn't a new trigger at all — it's `CardKeyword.Sly`, a real,
already-confirmed keyword. A Sly card's existing `OnPlay` effect block
fires for real on discard, via the game's own keyword system, with zero
new compiler code. Implemented as one of the 7 selectable keyword chips,
not a separate trigger option.

### What ISN'T implemented, and why (honest, not guessed)

"When retained" (a bonus effect specifically triggered by being retained,
beyond Retain just keeping the card in hand) and "while in discard" (a
passive effect while sitting in the discard pile) are **not implemented**.
Every reflect-baselib round so far (1 through 8) has only ever confirmed
`OnPlay` + `OnUpgrade` as `CustomCardModel`'s real overridable surface,
plus `AddKeyword` — nothing hook-shaped for either of these. Checked
carefully before writing this off, and found a real gap worth closing:
round 2's `CustomCardModel` sweep only searched for `*Play*`/`*Keyword*`/
`*Upgrade*` name substrings specifically — it never ran the broader "every
`After*`/`On*`/`Before*` member" sweep it ran on `CustomRelicModel` right
below it in the same round. So "does CustomCardModel expose anything
hook-shaped beyond OnPlay/OnUpgrade?" has genuinely never been checked.

Rather than guess a fake trigger name and risk it silently doing nothing
(exactly the failure mode `validate.js`'s card-trigger restriction exists
to prevent — see its "real stress test" history above), added a
**reflect-baselib round 9** (`tools/reflect-baselib/Program.cs`, already
shipped, not yet run by Tyler) with two targeted searches:

- **9a**: the same `After*`/`On*`/`Before*` hook-shaped-member sweep round
  2 already ran on `CustomRelicModel`, now also run on `CustomCardModel` —
  closes the "when retained"/"when discarded"-as-a-real-hook question
  directly. If it turns up something like `AfterCardRetained`, that's a
  real trigger to wire up next round instead of a guess now.
- **9b**: bundled in the same round since it's a real, already-flagged
  open risk (see "reflect-baselib round 8" above) — dumps constructors for
  every one of round 8's 247 built-in Powers classes, closing whether
  `ForgeActions.ApplyStatus<T>()`'s `where T : PowerModel, new()`
  constraint actually holds for all 247 or just the 2 (Strength/Dexterity)
  that have been individually checked so far.

Cards still only compile `OnPlay` effect blocks — `validate.js`/
`compiler.js` unchanged on that front, still hard-reject anything else for
a card, per the existing "silently dropped effect block" stress-test
history. Nothing new here silently no-ops.

### Card keyword schema/compiler/frontend changes

- `schema/character.schema.json`: card's `exhausts`/`innate`/`ethereal`
  booleans replaced with `keywords: string[]` (enum of the 7 real values,
  `uniqueItems`).
- `backend/validate.js`: new `CARD_KEYWORDS` list; validates `card.keywords`
  is an array of only real values with no duplicates.
- `backend/compiler.js`: `generateKeywordCalls(card)` now loops
  `card.keywords` and emits one `AddKeyword(CardKeyword.X)` per entry
  (previously 3 separate `if` checks for the 3 old booleans). Verified by
  generating a real card with all 4 of the newly-added keywords (Retain/
  Sly/Eternal/Unplayable) — the generated `TestCurseCard.cs` correctly
  emits all 4 `AddKeyword` calls, one per line, each still tagged
  `[VERIFIED]`.
- `frontend/index.html`:
  - `blankState()`/new-card default: `keywords: []` instead of 3 booleans.
  - **localStorage migration v4 -> v5** (in the same idempotent
    `migrateLegacyStatusActions` function every `load()` already runs
    through): an old card's `exhausts`/`innate`/`ethereal` booleans become
    `keywords` array entries 1:1, then get deleted. Verified directly via
    Playwright: seeded `localStorage` with a real v3-shaped card
    (`exhausts:true, ethereal:true`), reloaded, confirmed
    `state.formatVersion === 5` and `card.keywords === ["Exhaust",
    "Ethereal"]` with the old boolean fields gone.
  - The 3-checkbox row in the card editor is replaced with a `.kw-picker`
    of 7 toggleable `.kw-chip` pill buttons (one per `CARD_KEYWORDS`
    entry), each with a `title` tooltip carrying its real definition
    (sourced as above). Click toggles membership in a closure-scoped
    `selectedKeywords` Set — same "nothing touches state until Done"
    convention as every other field in this editor — only written to
    `card.keywords` in the `save-card` handler. The live preview's
    keyword badges (`.cp-kw`) now read directly from this Set instead of
    3 booleans.

### Card type colors — Attack red / Skill blue / Power green / Status grey / Curse black

`CARD_TYPE_COLOR` (already existed, driving the live preview's cost badge
+ `.cp-meta` text — previously an arbitrary on-theme guess, not tied to
anything Tyler asked for) updated to Tyler's exact spec: Attack `#d9463f`,
Skill `#3f8fe0`, Power `#4caf6b`, Status `#9aa4b3`, Curse (see below).
Extended to two new places for a stronger "sleek… selectable" read at a
glance:

- A 5px type-color accent bar across the top of the card-preview panel in
  the editor (new `.card-preview::before` — `::after` was already taken by
  the existing art-darkening overlay, so this needed its own z-index:3 to
  guarantee it always paints on top regardless of source order, same
  reasoning as the existing `::before`/`::after` split documented above).
- A 4px type-color left border stripe on each card tile in the main grid
  (`.tile.tile-card`, with `--type-accent` set inline per-card in
  `renderCards()`) — scoped to cards only via a new `tile-card` class so
  relic/mechanic tiles (which share the base `.tile` class) are
  unaffected. A small further step toward the "manageable tiled view"
  direction Tyler mentioned wanting later, same spirit as last round's art
  thumbnails — still not the full gallery.

**Legibility fix caught by actual screenshot, not assumed:** the initial
implementation used a literal near-black (`#17171b`) for Curse and applied
`CARD_TYPE_COLOR` directly to `.cp-meta`'s text color too. A first
Playwright screenshot pass showed two real problems: the Curse tile's left
border and top bar were nearly invisible against the app's own dark navy
`--ink`/`--stone-2` backgrounds (both already very dark, and close enough
in tone to a literal black that the "stripe" essentially disappeared —
exactly the type Tyler most specifically called out), and using
`--type-color` for small mono text (`.cp-meta`) would have made Curse's
"Type · Rarity" line borderline unreadable too. Fixed two ways:

1. `.cp-meta`/`.cp-placeholder` switched to a fixed neutral color
   (`var(--parchment-dim)`) instead of following `CARD_TYPE_COLOR` — type
   identity now shows via the (solid-fill, no-contrast-problem) top bar +
   cost badge + tile stripe instead of via colored text, which reads
   cleaner anyway (5 different mono-text colors next to each other is
   noisier, not sleeker).
2. Curse's swatch bumped from a literal near-black (`#17171b`, nearly
   identical in tone to `--ink`) to `#2c2830` — still unambiguously reads
   as "black" to the eye, but far enough from the app's own near-black
   theme to actually show as a distinct stripe/bar. Also added a subtle
   `rgba(255,255,255,.12-.15)` inset highlight to both the tile stripe and
   the preview top bar (all 5 types, not just Curse) so every color swatch
   gets a crisp edge against the dark UI. Re-screenshotted after the fix —
   confirmed the Curse tile stripe and top bar are now clearly visible and
   distinct from Attack/Skill/Power/Status, alongside the cost badge
   (dark fill + light `#eef3fb` text via a new `CARD_TYPE_BADGE_TEXT`
   override map, default `#04101c` elsewhere) which was already legible
   from the white ring border it already had.

### Verification

Playwright + the same pre-installed Chromium as last round
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). Cleared
`localStorage`, added 5 cards (one per type), toggled Retain/Sly/Eternal
on the Curse card, reopened it and confirmed the 3 keywords were still
active (real state persistence, not just visual), screenshotted the editor
(both the default Attack card and the Curse card, before AND after the
contrast fix) and the full card grid with all 5 type-colored tiles.
Console/pageerror listeners caught nothing beyond the expected
`/api/game-status` `file://`-CORS noise from testing without a backend
server, same as every prior round.

Separately (not in-browser): ran `backend/validate.js` directly against a
package with an invalid keyword string — correctly rejected with a clear
error listing the 7 real values; and a valid package with all 4
newly-added keywords — passed. Ran `backend/compiler.js`'s
`generateProject()` directly against that valid package and read the
actual generated `TestCurseCard.cs` off disk — confirmed all 4
`AddKeyword(CardKeyword.X)` calls are present, one per line, matching what
was selected. `node --check` on `validate.js`, `compiler.js`, and the
frontend's extracted `<script>` block; brace/paren balance check on the
updated `tools/reflect-baselib/Program.cs` (no `dotnet` available in this
sandbox to build it for real — same limitation as every prior
reflect-baselib round, Tyler still needs to run it against his own
installed game/BaseLib DLLs).

## Card art layout: real 500x375 size, top-bound, blocked-out description panel

Tyler: "The size of image allowed for the cards should be 500x375px. Keep
the image towards the top of the card like in the game, and keep the
bottom blocked out for the description."

Pure `frontend/index.html` change (no schema/backend involvement — art is
still a design-time-only preview, `compiler.js` still never reads it).

- **Exact-dimension validation, not just an aspect-ratio guideline.** The
  upload handler now loads the file into a real `Image()` object and
  checks `naturalWidth`/`naturalHeight` against new `CARD_ART_WIDTH`/
  `CARD_ART_HEIGHT` constants (500/375) before accepting it — a mismatch
  is rejected outright (clear inline error stating the actual dimensions
  found, file input reset) rather than silently resized/cropped to fit.
  Same "reject clearly rather than silently accept something off"
  convention `backend/validate.js` already uses everywhere else, just
  enforced client-side since there's still nothing server-side that
  touches art at all. Verified via Playwright: an 800x400 test image was
  correctly rejected with the exact expected/actual numbers in the error
  text; a real 500x375 test image was accepted and rendered.
- **Layout rebuilt to match a real card**, not full-bleed art with a
  darkening gradient (the previous version). `.card-preview` is now a
  flex column: a `.cp-art-frame` bound to the exact 500:375 (4:3) ratio,
  full width, flush with the card's top/left/right edges, sitting right
  below the type-color accent bar — then an opaque `.cp-panel` below it
  (background `var(--stone)`, a visible border-top) holding name/type-
  rarity/keyword pills, which fills whatever height is left down to the
  card's bottom edge. The old `::after` darkening gradient (needed when
  text sat directly over art) is gone entirely — text now lives on the
  opaque panel, no legibility trick needed.
- **The "blocked out for the description" part is honest, not decorative
  filler pretending to be real text.** Forge has no description-text
  concept anywhere (cards don't even have a manual description/flavor
  field the way relics have `flavorText` — deliberately not added here
  either, out of scope for this ask) and doesn't generate one from effect
  data. Rather than leave the panel looking broken/empty, or invent fake
  description text, it shows three dim wireframe bars (`.cp-desc-lines`,
  pure CSS, `aria-hidden`) as a placeholder for where real text will
  eventually sit, with the hint text under the upload button stating
  plainly that Forge doesn't generate description text yet.

Verified via Playwright — the full CARD_TYPE_COLOR set from last round's
work still renders correctly against the new layout (accent bar + cost
badge), the wrong-size rejection and correct-size acceptance were both
screenshotted, and `node --check` + brace/paren/backtick balance checks
passed on the extracted `<script>` block.

## Card triggers beyond OnPlay — still not added, Tyler asked again

Tyler followed up: "the triggers have not been updated. Is it possible to
add more triggers alongside the 'onplay' option for when effects happen?"

Answer stays the same as last round, restated because it's a real,
current blocker, not something forgotten: every reflect-baselib round (1
through 8) has only ever confirmed `OnPlay` + `OnUpgrade` + `AddKeyword`
as `CustomCardModel`'s real overridable/callable surface. Whether it
exposes anything else hook-shaped (which would be needed for a real "when
retained"/"when discarded"-as-a-trigger, as opposed to `CardKeyword.Sly`,
which already covers "when discarded" for real — see the keywords section
above) is unknown until Tyler runs `tools/reflect-baselib` round 9 (already
shipped last round, not yet run) and pastes back `reflect-output.txt`. No
new information has arrived since the last round to act on. Offered Tyler
the actual choice explicitly this time (wait for round 9's real data, vs.
add a same-day best-effort GUESSED trigger or two, clearly tagged
[UNVERIFIED], that would fail loudly with a real compiler error if wrong
rather than silently do nothing — the same self-correcting-guess pattern
already used elsewhere in this app for `Gender`/`GetArchitectAttackVfx`/
etc., with the caveat that those guesses were grounded in at least some
evidence, e.g. a strings-table hit or naming symmetry with a confirmed
sibling, and a guess at a brand-new card hook name has none of that —
so it's a weaker bet than those were).

## Round 9 lands: real card triggers beyond OnPlay, and a protected-constructor bug caught before it shipped

Tyler chose to run `tools/reflect-baselib` round 9 against his real
game/BaseLib DLLs (via the explicit choice offered at the end of the last
section) rather than take a same-day guess, and pasted back
`reflect-output.txt`. Round 9 ran two searches:

- **9a — hook-shaped member sweep on `CustomCardModel`.** Mirrors round
  2's sweep of `CustomRelicModel` (`After*`/`On*`/`Before*` members),
  this time run against `CustomCardModel`/`CardModel`/`AbstractModel` to
  finally answer the question the previous section left open: does the
  card hierarchy expose anything beyond `OnPlay`/`OnUpgrade`/
  `AddKeyword`? It does — two real hooks:
  - `AfterCardDiscarded(PlayerChoiceContext choiceContext, CardModel card)`
    — `[AbstractModel, virtual, public]`. Same shape as `AfterCardPlayed`
    on relics (round 2): fires globally for ANY card discarded by anyone,
    not just this one, so the generated override filters with
    `ReferenceEquals(card, this)` before running the card's own actions.
  - `OnTurnEndInHand(PlayerChoiceContext choiceContext)` — `[CardModel,
    virtual, protected]`. Declared directly on `CardModel` itself (not
    inherited from `AbstractModel`), fires for THIS card instance
    whenever it's still in hand at turn end — regardless of whether it
    has the `Retain` keyword. That makes it the closest real analog to
    Tyler's original "when retained" ask, not an exact match: it fires
    for any card left in hand, Retain or not. Pairing it with the
    `Retain` keyword (added last round) is how to actually build a
    "when retained" effect — Retain keeps the card in hand past the
    discard step, `OnTurnEndInHand` is what then fires.
  - **No hook found for "while in discard" (a continuous passive that
    checks each turn whether the card is sitting in the discard pile).**
    This is a genuine gap, not an oversight — the sweep found
    `AfterCardChangedPiles(CardModel card, PileType oldPileType,
    AbstractModel clonedBy)` as a coarser one-time pile-transition event
    (fires once when a card moves piles, not continuously while it sits
    in one), which isn't the same thing and wasn't implemented. If Tyler
    wants a real "while in discard" trigger, that needs either a future
    reflect-baselib round finding something more specific, or building
    it out of `AfterCardChangedPiles` transitions as a best-effort
    approximation — not done here since it wasn't asked for directly and
    the exact-match gap should stay visible rather than be quietly
    papered over.
  - Neither `AfterCardDiscarded` nor `OnTurnEndInHand`'s real parameters
    expose a confirmed player/target `Creature` the way `OnPlay`'s
    `CardPlay` does. Same situation several existing relic hooks are
    already in (`OnDrawCard`/`OnExhaust` etc. in `TRIGGER_HOOKS`) — the
    generated action bodies for these two triggers fall back to
    `ForgeActions.Todo("...")` (compiles clean, throws
    `NotImplementedException` if actually reached at runtime) rather than
    guessing a binding that reflection hasn't confirmed.

- **9b — constructor dump across every built-in Powers class.** Round 8
  built `BUILTIN_POWER_CLASS_MAP` (244 real classes under
  `MegaCrit.Sts2.Core.Models.Powers`, confirmed via `IsSubclassOf`) but
  flagged an open risk: `ForgeActions.ApplyStatus<T>()` requires `where T
  : PowerModel, new()`, and round 8 never checked whether all 244 classes
  actually have a public parameterless constructor to satisfy that `new()`
  constraint. Round 9 ran `DumpConstructors` across all 268 real
  (non-nested) classes in that namespace to close the gap. Result: 3 have
  a `protected`, not `public`, parameterless constructor —
  `TemporaryDexterityPower`, `TemporaryFocusPower`, `TemporaryStrengthPower`
  (each shown as `[protected] ClassName()` in the dump). Selecting any of
  these 3 in `ApplyStatus` would compile-fail with a real `CS0122`
  ("member is inaccessible due to its protection level") the moment Tyler
  tried to build the generated mod — this would have shipped completely
  silently otherwise, since nothing in this app's own validation would
  have caught it without the reflection data.

  `RemoveStatus<T>()` has no `new()` constraint at all (confirmed
  directly by reading `backend/templates/ForgeActions.cs.template`:
  `where T : PowerModel` only, no `new()`), so removing any of these 3
  would actually be safe. They're excluded from both the apply AND
  remove pickers anyway, purely because `BUILTIN_STATUSES` is one shared
  list feeding both UI pickers — splitting it into two lists just to
  let 3 statuses be removable-but-not-appliable wasn't worth the added
  complexity for what's a narrow edge case (temporary stat buffs that
  can never legally be granted don't need a removal path either).

### Implementation

- **`schema/character.schema.json`** — `cardEffectBlock.trigger` enum
  grew from `["OnPlay"]` to `["OnPlay", "OnDiscard", "OnTurnEndInHand"]`,
  with the description updated to name the real hooks each maps to and
  the Todo-fallback caveat.
- **`backend/validate.js`** — `CARD_TRIGGERS` const updated to match;
  the "cards only support OnPlay right now" error message now lists
  whichever triggers are actually allowed instead of hardcoding one.
- **`backend/compiler.js`**:
  - New `CARD_TRIGGER_HOOKS` map (one entry per non-OnPlay trigger) holds
    each hook's real method name, parameter list, access modifier, and
    whether it needs the `ReferenceEquals(card, this)` self-filter —
    `OnDiscard` does (global hook), `OnTurnEndInHand` doesn't (already
    per-instance).
  - `generateCardSource` now filters `card.effects` down to `OnPlay`
    entries for the existing `OnPlay` method body (previously assumed
    every effect was OnPlay, which broke once other triggers existed),
    and separately generates one override method per non-OnPlay trigger
    actually used by the card, each falling back to
    `ForgeActions.Todo("...")` for its action bodies per the caveat
    above.
  - New `PROTECTED_CTOR_BUILTIN_POWERS` set
    (`TemporaryDexterity`/`TemporaryFocus`/`TemporaryStrength`) plus a
    defensive throw inside `actionToCSharp`'s `ApplyStatus` case if one
    ever slips through anyway, and `BUILTIN_STATUSES` (the exported list
    the frontend picker reads) now filters these 3 out — verified via a
    direct `node` check that it's exactly 244 entries, down from 247.
- **`backend/templates/Card.cs.template`** — new `{{extraTriggerMethods}}`
  placeholder after the `OnPlay` method, with a comment explaining the
  two new triggers and pointing at `compiler.js:CARD_TRIGGER_HOOKS` for
  specifics; top file comment block updated with round 9's findings.
- **`frontend/index.html`**:
  - `CARD_TRIGGERS` grown to match the schema; new `TRIGGER_HINTS` object
    shows contextual copy under the trigger dropdown explaining what each
    new trigger really fires on, the Todo-fallback caveat, and — for
    `OnDiscard` specifically — a pointer to the `Sly` keyword as the
    real, caveat-free way to get "discard this card to replay its OnPlay
    effect for free" if that's closer to what's actually wanted.
  - `BUILTIN_STATUSES` array updated to drop the same 3 entries —
    checked byte-for-byte identical to `compiler.js`'s exported list via
    a direct comparison script (244 entries each).
  - `migrateLegacyStatusActions` gained a v5→v6 step stripping the 3
    protected-ctor statuses (and their `statusAmounts` entries) from any
    already-saved `ApplyStatus`/`RemoveStatus` action; `formatVersion`
    bumped to 6.

### Verification

Direct `node --check` on every modified `.js` file, plus a direct
`compiler.generateProject()` call against a hand-built "Perseverance"
card carrying all three triggers (OnPlay/OnDiscard/OnTurnEndInHand) —
confirmed the generated `.cs` correctly emits a public
`AfterCardDiscarded` override with the `ReferenceEquals` self-filter and
a protected `OnTurnEndInHand` override, both falling back to
`ForgeActions.Todo(...)`; a second run with an OnPlay-only "Strike" card
confirmed zero extra trigger methods are emitted when none are used (no
empty/dead override methods cluttering generated output). A direct
`validateCharacterPackage()` test confirmed `OnTurnEndInHand` passes
validation on a card, `Passive` (not a real trigger) is correctly
rejected, and `TemporaryStrength` in an `ApplyStatus` action is correctly
rejected with a clear error naming the reflection-confirmed reason.

Playwright, same pre-installed Chromium as every prior round: created a
card, selected `OnDiscard` as an effect block's trigger, confirmed the
correct hint text renders (screenshot, `Scrap Toss` card); did the same
for `OnTurnEndInHand` paired with the `Retain` keyword (screenshot,
`Perseverance` card). Separately, seeded `localStorage` directly with a
hand-built v5-shaped package containing an `ApplyStatus` action on
`TemporaryStrength` + `Weak`, reloaded, and confirmed the in-memory
`state` immediately reflects the v5→v6 migration (`formatVersion: 6`,
`TemporaryStrength` stripped from both `builtinStatuses` and
`statusAmounts`, `Weak` left untouched) — then confirmed it also
persists correctly to `localStorage` once any save action fires (opened
and re-saved the card), matching this app's existing pattern where
migrations apply in-memory on load and get written back to storage on
the next save, same as every earlier formatVersion migration in this
app. One dead helper function (`generateCardTriggerMethod`, an earlier
draft never actually wired up — the real logic ended up inlined into
`generateCardSource` instead) was caught via `grep` and removed before
delivery; `node --check` confirmed the file was still valid after
deletion.

## Card board: type-grouped columns, sort, and custom tags — pure frontend, no generated-C# changes

Tyler: "under the card section i would like to stack the cards with the
same type in their own columns with the ability to sort by rarity, cost,
and alphabetically. I also want the ability to add custom tags to cards
with the ability to filter by tag as well in the card section."

Entirely `frontend/index.html` (plus a small, honest `schema/`+
`validate.js` addition for tags' organizational metadata) — no
`compiler.js`/generated-C# involvement at all. This is the natural next
step after the type-color-coding round: that round colored cards by
type, this one actually organizes the board by it.

### Type-grouped columns

The flat `.grid-cards` auto-fill grid is replaced with `.cards-columns`
— one vertical column per real card type
(`CARD_TYPE_ORDER = ["Attack","Skill","Power","Status","Curse"]`, the
same order Tyler specified colors in), each headed by a colored dot +
label + count using the same `CARD_TYPE_COLOR` map from the earlier
type-color round. A type with zero cards (or zero cards visible under
the active tag filter) doesn't get an empty column — the board only
shows columns that actually have something in them, so filtering down to
one type doesn't leave four empty husks on screen.

### Sort: rarity / cost / alphabetical

A single `<select id="card-sort">` above the board controls ordering
INSIDE every column at once (not a per-column control — Tyler asked for
"the ability to sort," one shared setting reads cleaner than five
independent ones and there's no indication he wanted columns sorted
differently from each other).

- **Rarity** sorts by `CARD_RARITY_ORDER`, the real `CardRarity` enum
  member order confirmed back in reflect-baselib round 6 (`Basic` →
  `Quest`) — not alphabetical, which would scatter `Basic`/`Common`/
  `Uncommon`/`Rare` out of their natural progression. It's also the
  default sort on load, since a rarity progression reads as the most
  natural starting order for browsing a deck.
- **Cost** sorts numerically, with one deliberate special case: `-1`
  ("X cost", a real STS2 mechanic — see `TOOLCHAIN_FINDINGS.md`'s round-6
  section) sorts as the MOST expensive, not literally negative/cheapest
  — "costs all remaining energy" reads backwards next to a 0-cost card
  if it sorted first.
- **Alphabetical** is a plain `localeCompare` on name.

All three sorts break ties alphabetically by name, so identical-rarity
or identical-cost cards don't jump around unpredictably between renders.

Sort choice (and the tag filter, below) is deliberately NOT persisted to
`state`/`localStorage` — it's a view-only convenience for browsing the
board, not part of the character package itself, so no schema/
`formatVersion` bump was needed for this half of the feature. It resets
to "Rarity" on reload, same as e.g. which status picker happens to be
scrolled where.

### Custom tags — organizational only, not a real game concept

New `card.tags: string[]` — freeform text labels the deck author assigns
(e.g. "combo piece", "early game"), added via a text input + "+ Add tag"
button (or Enter) in the card editor, shown as removable chip bubbles.
**Explicitly NOT a BaseLib/MegaCrit concept** — unlike `card.keywords`
(the real `CardKeyword` enum, reflection-confirmed), tags exist purely to
power this app's own board UI. `compiler.js` never reads `card.tags` at
all — verified directly (see Verification below), not just asserted.
Stated as much in both the schema description and the editor's own label
text, so this doesn't read as a stealth game-data field the way a wrong
guess might.

Duplicate prevention is case-insensitive on add (typing "AOE" when "aoe"
already exists is a no-op, not a second chip) but tags are otherwise
completely free text — no fixed vocabulary, no reflection involved,
nothing to get wrong the way a guessed BaseLib enum member could be. A
`<datalist>` sourced from every tag already used elsewhere in the
character is offered as a typing suggestion (encourages reusing
"combo piece" instead of accidentally creating a near-duplicate like
"Combo Piece") but doesn't restrict what can be typed.

`backend/validate.js` type-checks `card.tags` when present (array of
non-empty strings, ≤40 chars each, no case-insensitive duplicates) —
same "reject clearly rather than silently accept something broken"
convention as everywhere else, even though nothing here can produce a
real compiler error the way a bad BaseLib guess could. No
`formatVersion` migration needed — `tags` defaults to absent/empty on
any card that predates this feature, and every read site (`card.tags ||
[]` / `Array.isArray(card.tags) ? ... : []`) already treats a missing
field as "no tags," so there's nothing to migrate.

### Tag filter — "any selected" (OR), not "all selected" (AND)

The board's tag filter chips (rendered above the columns, one per tag in
use across every card, each showing a live count) use OR logic: selecting
both "combo piece" and "starter" shows any card with EITHER tag, not only
cards with both. Labeled explicitly in the UI ("Filter by tag (any
selected)") rather than left ambiguous — OR is the more common
convention for a flat tag filter (vs. AND, which is more common for
faceted filters across DIFFERENT dimensions, not multiple values of the
same one) and matches what "filter by tag" most naturally means when
browsing a shared tag cloud.

### Verification

`node --check` on the extracted frontend `<script>` block plus a full
brace/paren/backtick balance check (all balanced) and on
`backend/validate.js`; `schema/character.schema.json` re-parsed
successfully as JSON. Direct `validateCharacterPackage()`-equivalent
calls against five hand-built cases: a valid card with 2 tags (passes),
`tags` as a non-array (rejected), an empty-string tag entry (rejected),
a case-insensitive duplicate pair `["Combo","combo"]` (rejected), a
41-character tag (rejected), and a card with `tags` omitted entirely
(still passes — confirms no migration is needed). A direct
`compiler.generateProject()` run against a card carrying `tags` produced
a clean, successful build with no `tags`/`{{...}}` leakage anywhere in
the generated `.cs` output — confirms the "compiler never reads this
field" claim above isn't just asserted, it's checked.

Playwright, same pre-installed Chromium as every prior round: built a
5-card test board (2 Attack, 2 Skill, 1 Power, spanning Basic/Common/
Uncommon/Rare, with a mix of "starter"/"combo piece" tags), confirmed
columns render in the correct type order with correct per-column counts;
confirmed cost-sort and name-sort both produce the correct in-column
order (screenshotted the default rarity-sorted board); confirmed
clicking the "combo piece" tag chip filters the board down to exactly
the 2 matching cards across 2 columns, with non-matching columns
disappearing entirely (screenshotted); and, in the card editor itself,
confirmed adding "aoe" + "combo piece" tags renders 2 chips, that typing
"AOE" (different case) after doesn't add a 3rd chip, that the chip "×"
button removes a tag and updates the count live, and that the surviving
tag persists correctly into `state.cards[0].tags` after Save. Console/
pageerror listeners caught nothing beyond the expected `/api/game-status`
`file://`-CORS noise from testing without a backend server, same as every
prior round.

## Tag-triggered card synergies — "whenever a card marked X is played, this reacts"

Tyler asked how slay.spencerstiles.com manages tag-triggered synergies
(his example: a card tagged "hit" causes another card to react whenever
it's played) and whether Forge could support the same thing, since it'd
have a real impact on character design.

### What slay.spencerstiles.com is actually doing (research, not reflection)

The site itself is closed-source with no public technical docs beyond
its own user-facing guide, which only documents card-type and "cards
played in a row" filtering — no mention of custom tags at that level.
The mechanism underneath is BaseLib's, per BaseLib's own wiki
(doc-page level — these specific claims were NOT reflected against
Tyler's DLLs before this round, see below for what now has been):
`CardTag` is the base game's own card-categorization enum (e.g.
`CardTag.Strike`, used by real Strike-synergy cards already in the base
game), attached to a card via `CustomCardModel.CanonicalTags` or
`ConstructedCardModel.WithTags(...)`, and extensible with a
`[CustomEnum]` attribute that lets a mod declare brand-new tag values
of its own — which is presumably how a builder tool like
slay.spencerstiles.com lets its users invent tags like "hit" that don't
exist in the base game at all. A `strings` scan of Tyler's own
`TheTrainerNewCharacter.dll` (no `dotnet`/`mono`/`ildasm`/`ilspycmd`
available in this sandbox to actually decompile it — same limitation as
every prior round, `strings` is the fallback used since the project's
earliest rounds) found the real identifiers `CardTag`, `CardTags`, and
`get_CanonicalTags` present in the compiled binary, and confirmed
several of his own Card classes (`Bulbasaur`, `Charmander`, `Charmeleon`,
`Charizard`, `Ivysaur`, `Venusaur`, `Pokemon`, `Bag`, `Run`, `Fight`)
implement `AfterCardPlayed` directly — consistent with the wiki's
description, but `strings` can only prove an identifier exists
*somewhere* in the file, not which class declares what or with what
real signature. That gap is what reflect-baselib round 10 (below) is
for.

### `AfterCardPlayed` — real today, and it was already sitting in round 2's own data

While chasing this down, found that `AfterCardPlayed(PlayerChoiceContext
choiceContext, CardPlay cardPlay)` — the exact hook needed for "react
whenever ANY card is played, not just this one" — was already
reflection-confirmed real back in round 2's own `*Play*`-substring sweep
of `CustomCardModel` (`[AbstractModel, virtual, public]`), and
re-confirmed in round 9's data too. It was simply never wired up as a
selectable Forge trigger in any earlier round — round 2 had been
focused on "when retained"/"when discarded" specifically, and treated
`OnPlay` as already covering "when played," missing that
`AfterCardPlayed` is a fundamentally different, more powerful hook: it
fires for a card played by *anyone*, including the base game's own
cards and every other custom card in the run, not just this one playing
itself. This was a pure oversight, not a new discovery requiring new
reflection — it let this round ship a fully-real feature (no `Todo()`
fallback, unlike `OnDiscard`/`OnTurnEndInHand`) using data already on
disk.

Crucially, `AfterCardPlayed` takes the exact same `CardPlay` parameter
shape as `OnPlay` (already fully bound via `cardPlay.Player.Creature`/
`cardPlay.Target`, both [VERIFIED] in earlier rounds — see
`Card.cs.template`'s header comment), so no new player/target binding
work was needed either. A bonus `AfterCardPlayedLate` variant also
turned up alongside it in round 9's dump — noted, not wired up, out of
scope for this round.

### What's live now: `OnAnyCardPlayed` trigger + `PlayedCardHasKeyword` condition

Added `OnAnyCardPlayed` as a new selectable trigger, for both cards
(`CARD_TRIGGER_HOOKS`, `backend/compiler.js`) and relics/mechanics
(`TRIGGER_HOOKS`) — relics/mechanics needed zero new codegen since
`TRIGGER_HOOKS` already supported generic `playerExpr`/`targetExpr`
binding; cards got a new `fullCardPlayBinding: true` flag on the hook
entry so `generateCardSource` emits a real bound method body (binding
`fgPlayer`/`fgTarget` the same way `OnPlay` does, then running the
card's own effects) instead of the `ForgeActions.Todo(...)` fallback
`OnDiscard`/`OnTurnEndInHand` use.

Paired with a new `PlayedCardHasKeyword` condition kind — checks
`cardPlay.Card.Keywords.Contains(CardKeyword.X)` in generated code,
using `CardModel.Keywords` (confirmed real AND queryable at runtime,
not just settable via `AddKeyword`, per round 9's own `*Keyword*` sweep
of `CustomCardModel`, which also turned up `CanonicalKeywords`,
`LocalKeywords`, `GetKeywordsWithSources`, `RemoveKeyword`, and
`TryModifyKeywordsInCombat` in passing). Every piece of this condition
— `CardPlay.Card`, `CardModel.Keywords`, `.Contains` — is independently
reflection-verified, so it's a fully real, working synergy mechanic
today, not a guess: "whenever a card with the Sly keyword is played,
this card reacts" works right now, using the 7 real `CardKeyword`
values already confirmed in earlier rounds. `validate.js` enforces the
condition only makes sense on the `OnAnyCardPlayed` trigger (rejects it
elsewhere with a clear message, since `cardPlay` isn't in scope on any
other trigger) and that `keyword` names one of the 7 real values.

This is honestly scoped as a *keyword* filter, not a true *custom tag*
filter — it's real and useful today (Tyler can build "whenever a Sly
card is played, gain block" right now), but it doesn't yet let him
invent a brand-new tag like "hit" the way slay.spencerstiles.com
apparently does. That needs `CardTag`/`[CustomEnum]` reflection-
confirmed first — see round 10 below. The frontend's trigger hint text
for `OnAnyCardPlayed` says this explicitly, so Tyler doesn't mistake
today's keyword filter for the custom-tag feature he actually asked
about.

### A gap noticed along the way: no general conditions-editor UI exists

While wiring up the condition row for `OnAnyCardPlayed`, noticed the
frontend has no general-purpose conditions editor anywhere — `HasStatus
Stacks`/`HpBelowPercent`/`EnergyRemaining`/`CardsInHand`/`IsAttack`
all exist as condition kinds in `schema/character.schema.json` and
`backend/compiler.js`, but `entity.effects[].conditions` is always `[]`
in practice; there's no UI path that ever sets it to anything else. This
round deliberately did NOT attempt to build a general conditions editor
covering all 6 kinds now — that's real scope beyond what Tyler asked
for, and the one narrow, purpose-built row added for
`PlayedCardHasKeyword` (shown/hidden based on the selected trigger, not
a generic condition-kind picker) avoids that scope creep. Flagging here
for future work, not fixing now.

### reflect-baselib round 10 — what's still needed for TRUE custom tags

`tools/reflect-baselib/Program.cs` gained a 4th round of searches and a
new optional 3rd CLI argument (a path to a compiled mod's own DLL, e.g.
`TheTrainerNewCharacter.dll`) so it can also reflect that mod's own
types, not just the game/BaseLib's. This can't be run in this sandbox —
no `dotnet` SDK is available here (checked `mono`/`monodis`/`ildasm`/
`ikdasm`/`dotnet-ildasm`/`pythonnet` too, none present — consistent with
every prior round's documented sandbox limitation) — so it needs to run
on Tyler's own machine, same as every previous round.

New searches:

- **10a** — the same `*Tag*`-substring sweep the existing `*Play*`/
  `*Keyword*`/`*Upgrade*` searches already run on `CustomCardModel`,
  closing whether it exposes a `CanonicalTags`-style property the same
  way it exposes `CanonicalKeywords` (already confirmed in rounds 2/9).
- **10b** — finds the `CardTag` type itself wherever it lives, reports
  whether it's a real `IsEnum` (which couldn't be extended by a mod at
  runtime) or some other shape (consistent with an extensible
  "smart enum" pattern of static readonly instances), and — either
  way — scans every loaded assembly for public static fields/properties
  of type `CardTag`, which is how both BaseLib's own built-in tag
  values (e.g. `Strike`) and any mod-declared custom ones would show up
  in one pass.
- **10c** — searches for real `[CustomEnum]`/`[KeywordProperties]`
  attribute types (the BaseLib wiki's documented mechanism for adding
  new tag/keyword values) and dumps their constructors and full shape
  if found, so Forge would know their real usable signature before ever
  trying to emit one in generated code.
- **10d** — only runs if the new 3rd argument was given. Lists every
  type in that mod's own `Cards`/`Powers`/`Relics`/`Characters`/
  `TokenCards` namespaces by reflection (not `strings`-guessing), then
  for each one lists any *declared* (not inherited) property/method
  whose name contains "Tag", "Keyword", or "CardPlayed" — this is how
  to see exactly which of Tyler's own classes override
  `CanonicalTags`/`Keywords`/`AfterCardPlayed`, and with what real
  signature, instead of inferring it from `strings` output alone.

Updated usage (from the `tools/reflect-baselib` folder):

```
dotnet run -- "<path to data_sts2_windows_x86_64>" "<path to BaseLib.dll>" ["<path to an example mod DLL, e.g. TheTrainerNewCharacter.dll>"]
```

The first two arguments are unchanged from every prior round; the third
is new and optional — omitting it just skips round 10d, everything else
still runs.

### Verification

`node --check` on `backend/validate.js` and `backend/compiler.js`;
`schema/character.schema.json` re-parsed successfully as JSON.
`validate.js`'s new `PlayedCardHasKeyword` handling tested directly:
wrong-trigger use rejected with a clear message, an invalid keyword
name rejected, a valid case passes, and the "no condition set" (any
card) case also passes. `compiler.js`'s `generateProject()` tested
directly against a hand-built card with an `OnAnyCardPlayed` trigger, a
`PlayedCardHasKeyword` condition (keyword: Sly), and a `GainBlock`
action — produced a correct, fully-bound `AfterCardPlayed` override
(shown in full in the compiler.js comment above `CARD_TRIGGER_HOOKS`'s
`OnAnyCardPlayed` entry) with no `Todo()` fallback anywhere in it; a
parallel test against a relic with the same trigger confirmed the
existing generic `TRIGGER_HOOKS` codegen path needed zero changes.
Playwright (same pre-installed Chromium as every prior round) confirmed:
the trigger hint text renders for `OnAnyCardPlayed`; the new keyword
condition row shows only when that trigger is selected and hides
otherwise; selecting a keyword and saving persists it correctly to
`state.cards[0].effects[0].conditions`; switching the trigger away from
`OnAnyCardPlayed` clears the condition; and the relic editor also
offers `OnAnyCardPlayed` with the same condition row behavior. Console/
pageerror listeners caught nothing beyond the expected
`/api/game-status` CORS noise from testing without a backend server.
`tools/reflect-baselib/Program.cs`'s round 10 additions were checked
with a brace/paren balance script (no `dotnet` available in this
sandbox to actually compile it, same limitation as every prior round on
this file) — balanced (275/275 braces, 770/770 parens).

## General conditions editor — pure frontend, no backend/generated-C# changes

Tyler's direct follow-up: "Lets also build out the general conditions in
the ui." — closing the gap flagged at the end of the `OnAnyCardPlayed`
round above (no general conditions-editor UI existed anywhere; only the
single, purpose-built `PlayedCardHasKeyword` row had one).

Checking `backend/validate.js`/`backend/compiler.js` first confirmed this
really was a UI-only gap: every one of the 6 condition kinds
(`HasStatusStacks`/`HpBelowPercent`/`EnergyRemaining`/`CardsInHand`/
`IsAttack`/`PlayedCardHasKeyword`) was already fully validated
server-side and had a real `conditionToCSharp` mapping — the shape has
been correct in schema/validate.js/compiler.js since the app-level
stress-test round. Confirmed via `node --check` on both files (no
changes needed) — this round is entirely `frontend/index.html`.

### What was built

Each effect block (card OR relic/mechanic — `renderEffectsList` is shared
by both) now has a real conditions list, not the single hardcoded keyword
row: a "+ condition" button adds a row, each row has its own kind
dropdown, and the row's other fields rebuild to match whichever kind is
selected — mirroring the existing action-row split
(`renderActionRowFields`/`wireActionRowHandlers`) with a matching pair,
`renderConditionRowFields`/`wireConditionRowHandlers`, plus
`renderConditionRows` (rebuilds the whole list) and `blankCondition(kind)`
(returns a correctly-shaped fresh object per kind, mirroring exactly what
`backend/validate.js` requires). Conditions on one block are ANDed
together in the generated C# (`effectBlockToCSharp` already did this,
unchanged) — the UI states this directly ("Conditions (all must be
true — leave empty to always run)").

Per kind, the row shows:
- **Has status stacks** (`HasStatusStacks`) — a mechanic dropdown (built
  from `state.mechanics` via the existing `mechanicOptionsData()` helper,
  already used by the custom-status action picker — same hover tooltips),
  plus comparator + numeric value.
- **HP below %** / **Energy remaining** / **Cards in hand** / **Played
  card is an Attack** (`HpBelowPercent`/`EnergyRemaining`/`CardsInHand`/
  `IsAttack`) — comparator + numeric value only.
- **Played card has keyword** (`PlayedCardHasKeyword`) — the one
  already-real condition from last round, a keyword dropdown instead of
  comparator/value, unchanged from its prior single-purpose
  implementation.

**Honest, not hidden, about what's real vs. Todo.** `CONDITION_KINDS`
(new, `frontend/index.html`) carries a `real: true/false` flag per kind
matching `compiler.js:conditionToCSharp`'s actual behavior —
`HasStatusStacks` and `PlayedCardHasKeyword` are real, reflection-backed
checks; the other four compile but throw at runtime
(`ForgeActions.TodoCondition`) since no reflect-baselib round has ever
confirmed a real BaseLib accessor for HP percentage, remaining energy,
hand size, or a card's type at combat-hook time. Rather than hide the
four Todo kinds (which would make that real, still-open gap invisible),
each row shows its kind's exact hint text under the fields — the real
kinds' hints cite which reflect-baselib round confirmed them; the Todo
kinds' hints say `[UNVERIFIED]` plainly and are styled in the app's
existing danger-red color (`.c-hint.not-real`, reusing `--danger-bright`)
so a Todo condition doesn't visually blend in with a working one. This
mirrors the exact convention `TRIGGER_HINTS` already established for
trigger dropdowns.

**`PlayedCardHasKeyword`'s trigger restriction is enforced in the UI
now, not just server-side.** `availableConditionKinds(eff)` filters it
out of the kind dropdown entirely unless the effect block's own trigger
is `OnAnyCardPlayed` (matching `backend/validate.js`'s existing rejection
rule) — so the UI never offers a choice it already knows
`validate.js`/`compiler.js` would reject. Switching a block's trigger
AWAY from `OnAnyCardPlayed` while it has a `PlayedCardHasKeyword`
condition auto-drops just that one condition (not the whole conditions
list, unlike the previous single-purpose row's behavior, which wiped
everything on any trigger change) — every other condition kind on the
same block is trigger-agnostic and stays untouched.

### Verification

`node --check` on the extracted frontend `<script>` block plus a full
brace/paren/backtick balance check (326/326 braces, 951/951 parens,
138/138 brackets, 128 backticks — even, so 64 balanced pairs) — all
balanced; `node --check` on `backend/validate.js`/`backend/compiler.js`
confirmed unchanged-and-still-valid.

Playwright, same pre-installed Chromium as every prior round
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`): created a
mechanic ("Ember Stacks") and a card, added an effect block, confirmed
the empty-conditions state renders ("No conditions — this block always
runs on its trigger"); added a condition and confirmed it defaults to
`HasStatusStacks` (since a mechanic now exists) with the real mechanic
correctly listed in its dropdown and a `[VERIFIED]`-tagged hint; switched
its kind to `HpBelowPercent` and confirmed the statusRef field disappears,
comparator+value fields remain, and the hint switches to the
red-styled `[UNVERIFIED]` text; switched the block's trigger to
`OnAnyCardPlayed` and confirmed `PlayedCardHasKeyword` becomes selectable
in the kind dropdown, selected it, confirmed the keyword field appears
and comparator/value disappear; switched the trigger back to `OnPlay` and
confirmed the condition is auto-dropped back to the empty state; added a
final `HasStatusStacks` condition with real comparator/value, saved the
card, and read `localStorage` directly afterward to confirm the exact
condition object persisted correctly (`{kind:"HasStatusStacks",
comparator:"gte", value:5, statusRef:"mech_..."}`, matching a real
mechanic id) — screenshotted both the populated editor (two condition
rows, one real/one Todo, visually distinct) and the saved board. Console/
pageerror listeners caught nothing beyond the expected `/api/game-status`
network noise from testing without a backend server (this run surfaced
it as `ERR_TUNNEL_CONNECTION_FAILED` rather than the CORS message seen in
earlier rounds — same underlying non-issue, a failed fetch to a backend
that isn't running in this test, not a real app bug).

## reflect-baselib round 10 lands: TRUE custom tags, via a Forge-native mechanism, not BaseLib's CardTag

Tyler ran reflect-baselib round 10 (including the new 3rd argument,
pointed at his real `TheTrainerNewCharacter.dll`) and pasted back
`reflect-output.txt`. This closes the original "let's figure out this
custom tag thing" ask directly — with a genuinely different answer than
initially expected.

### What round 10 actually found

- **`CardModel.Tags`/`CanonicalTags` — CONFIRMED real.** `[CardModel,
  virtual, public] property IEnumerable<CardTag> Tags { get; }` and
  `[CardModel, virtual, protected] property HashSet<CardTag>
  CanonicalTags { get; }` — a card overrides `CanonicalTags` to declare
  its own tags, same override pattern as `CanonicalKeywords`.
- **`CardTag` itself — CONFIRMED to be a genuine, CLOSED C# enum.**
  `IsEnum=True, IsClass=False, IsValueType=True, base: System.Enum`, with
  exactly 5 real members: `None`, `Strike`, `Defend`, `Minion`,
  `OstyAttack`, `Shiv`. A real .NET enum's member set is fixed at compile
  time — nothing a mod does at runtime can add a 6th member to it. A
  second, independent search (every public static field/property of type
  `CardTag`, across every loaded assembly — game, BaseLib, AND Tyler's own
  `TheTrainerNewCharacter.dll`) turned up only those same 5 built-in
  values — airtight confirmation nothing anywhere declares a new one.
- **`[CustomEnum]` — CONFIRMED to be a real BaseLib attribute**
  (`BaseLib.Patches.Content.CustomEnumAttribute`, constructor takes an
  optional `string name = null`) — but its own namespace ("Patches")
  strongly suggests it works via a Harmony/IL-level patch applied at
  mod-load time, not ordinary C#, and **round 10 found ZERO real usage
  example anywhere** — not in the base game, not in Tyler's own compiled
  mod. `BaseLib.Patches.Content.CustomEnums` (a plausible-sounding
  companion class) exists but declares no members at all in the reflected
  assembly, so it isn't a usable registry either.
- **The pivotal finding: Tyler's own `TheTrainerNewCharacter.dll` (built
  by slay.spencerstiles.com's tool) does NOT use `[CustomEnum]` at all.**
  Round 10d's per-class scan of all 222 of its own Cards/Powers/Relics/
  Characters/TokenCards types shows exactly what each one does: every
  Pokemon evolution card (`Bulbasaur`, `Charmander`, `Charizard`, etc.)
  overrides `CanonicalKeywords` and implements `AfterCardPlayed` — real
  `CardKeyword` usage, not tags at all. Only two classes override
  `CanonicalTags` — `StrikeTheTrainer` and `DefendTheTrainer` — and given
  those exact names next to the 5 confirmed real `CardTag` values
  (Strike/Defend), these almost certainly just reuse the game's own real
  `CardTag.Strike`/`CardTag.Defend` on reskinned Strike/Defend cards (a
  common modding pattern — the method BODY isn't visible to reflection,
  only the property override's existence, so this is a strong inference,
  not 100% certain, but there is zero evidence of a genuinely NEW tag
  value anywhere in this mod).

**Conclusion: the competing tool's "hit"-style tag-triggered synergies are
almost certainly NOT built on BaseLib's real `CardTag` enum at all** — at
minimum, this specific reflected mod doesn't demonstrate that mechanism,
and the mechanism that WOULD extend it ([CustomEnum]) has no working
example anywhere to safely copy. Guessing the exact declaration shape
`[CustomEnum]` needs (which member, what accessibility, what triggers
registration, at what point in mod load order) with zero real evidence
would be exactly the kind of blind guess this project avoids — a real
chance of producing code that compiles clean but silently doesn't
register anything at runtime.

### The actual fix: a Forge-owned tagging system, not a BaseLib one

Since Forge already generates 100% of a character's own Card classes from
scratch, tagging never needed to touch BaseLib's real (closed) `CardTag`
enum at all. New pieces, entirely within Forge's own control — no
guessing at unconfirmed BaseLib internals anywhere in this design:

- **`Generated/IForgeTaggedCard.cs`** (new,
  `backend/templates/IForgeTaggedCard.cs.template`, written once per
  project alongside `ForgeActions.cs`) — a plain C# interface:
  `IReadOnlySet<string> ForgeTags { get; }`. Both `IReadOnlySet<T>` and
  `HashSet<T>` are real, ordinary BCL types (net9.0), not a BaseLib guess
  of any kind.
- **Every generated card implements it** (`Card.cs.template`) — `public
  IReadOnlySet<string> ForgeTags { get; } = new
  HashSet<string>(new string[] { "hit", ... },
  StringComparer.OrdinalIgnoreCase);`, populated from a new schema field,
  **`card.gameplayTags`** — a SEPARATE array from the pre-existing,
  purely organizational `card.tags` (which still compiles to nothing at
  all; the two are intentionally kept distinct, both in the schema and in
  the card editor UI, so "board filter label" and "real gameplay tag"
  never get confused with each other). Case-insensitive comparer so
  "Hit"/"hit"/"HIT" typed on different cards all match the same
  condition, matching the existing case-insensitive dedup convention
  `card.tags` already uses.
- **New `PlayedCardHasTag` condition** (`backend/compiler.js`,
  `backend/validate.js`, `schema/character.schema.json`) — generates
  `(cardPlay.Card as IForgeTaggedCard)?.ForgeTags.Contains("hit") ==
  true`. The `as`-pattern cast is what makes this safe against base-game
  or other-mod cards, which simply won't implement
  `IForgeTaggedCard` — the cast yields null and the whole expression is
  false, not a crash. Same trigger restriction as `PlayedCardHasKeyword`
  (only valid on `OnAnyCardPlayed`, where `cardPlay` is in scope),
  enforced the same way in `validate.js`.
- **A cross-reference check `PlayedCardHasKeyword` never needed** (since
  keywords are a fixed enum, a typo is impossible) but `PlayedCardHasTag`
  does, since tags are freeform: `validate.js` now collects every
  `gameplayTags` value used ANYWHERE in the character up front
  (`gameplayTagsInUse`, built alongside the existing `cardIds`/
  `mechanicIds` sets) and rejects a `PlayedCardHasTag` condition whose
  `tag` doesn't match any of them (case-insensitive) — this catches
  "Hitt" vs "Hit" before it ships as a condition that would compile clean
  but always evaluate false, the same "reject clearly rather than
  silently accept something broken" reasoning `statusRef`/`cardRef`
  references already get elsewhere in this file.
- **Frontend**: the card editor gained a second, clearly-distinguished
  "Gameplay Tags" section (accent-colored label, explicit "REAL —
  compiles into the mod" callout) right below the existing organizational
  "Tags" section, same chip-input widget shape, separate array
  (`cardGameplayTags`), separate `card.gameplayTags` write-back on save.
  The general conditions editor (from the previous round) gained
  `PlayedCardHasTag` as a 7th selectable kind — its own field is a
  `<select>` populated from every gameplay tag actually in use across the
  whole character (`allGameplayTags()`, mirroring the existing
  `allCardTags()` helper for the organizational field) rather than free
  text, so a typo literally can't be typed into the dropdown in the first
  place; an empty state ("— no gameplay tags defined yet —", disabled)
  shows with a hint pointing at where to add one if the character has
  none yet. `TRIGGER_HINTS.OnAnyCardPlayed`'s copy (previously honest
  that custom tags weren't ready — "needs one more reflect-baselib round
  to confirm") was updated now that they are.
- **No `formatVersion` migration needed** — same reasoning as
  `card.tags`: absent `gameplayTags` defaults to "no tags" everywhere it's
  read (`Array.isArray(card.gameplayTags) ? card.gameplayTags : []`
  throughout), so nothing needs migrating for a character saved before
  this round.

### Verification

`node --check` on `backend/validate.js`/`backend/compiler.js`; schema
JSON re-parsed successfully; a brace/paren balance check on both the new
`IForgeTaggedCard.cs.template` (4/4 braces, 13/13 parens) and the updated
`Card.cs.template` (43/43 braces, 56/56 parens) — no `dotnet` available
in this sandbox to actually compile either, same limitation as every
prior C#-template round.

Six direct `validateCharacterPackage()`/`generateProject()` tests: (1) a
valid package — a "Quick Jab" card tagged `"Hit"` and a "Combo Finisher"
card with an `OnAnyCardPlayed` + `PlayedCardHasTag(tag:"hit")` condition
— passes despite the case mismatch (case-insensitive match confirmed);
(2) the same package with the condition's tag typo'd to `"Hitt"` —
correctly rejected with a clear "doesn't match any card.gameplayTags
value" message; (3) the condition moved to the `OnPlay` trigger —
correctly rejected as trigger-mismatched, same message pattern as
`PlayedCardHasKeyword`; (4) `gameplayTags: ["Hit", "hit"]` on one card —
correctly rejected as a case-insensitive duplicate; (5) a real
`generateProject()` run — read the actual generated `QuickJabCard.cs` off
disk and confirmed the exact line `public IReadOnlySet<string> ForgeTags
{ get; } = new HashSet<string>(new string[] { "Hit" },
StringComparer.OrdinalIgnoreCase);`, and `ComboFinisherCard.cs`'s real
`AfterCardPlayed` override body containing exactly `if ((cardPlay.Card as
IForgeTaggedCard)?.ForgeTags.Contains("hit") == true)` wrapping the
`GainBlock` action — no leftover `{{...}}` placeholders anywhere in
either file; (6) a card with NO `gameplayTags` at all still generates a
clean, valid (empty) `new string[] { }` initializer — confirms the
"absent = no tags" default holds all the way through codegen, not just
validation. A separate direct test confirmed the SAME `PlayedCardHasTag`
condition on a RELIC (not just a card) generates correctly through the
existing generic `TRIGGER_HOOKS` codegen path with zero new relic-side
code — a "Hit Tracker" relic's generated `AfterCardPlayed` override
contains the identical `(cardPlay.Card as IForgeTaggedCard)?
.ForgeTags.Contains("hit") == true` check wrapping a `DealDamage` call.

Playwright, same pre-installed Chromium as every prior round: created a
"Quick Jab" card, added a "Hit" gameplay tag via the new section,
confirmed the chip renders and that typing "hit" (different case)
afterward does NOT add a second chip (case-insensitive dedup, matching
the organizational tags widget's existing behavior) and that the
pre-existing organizational Tags section stays empty/untouched (the two
fields are genuinely independent in the UI, not just in the schema);
created a "Combo Finisher" card, set its trigger to `OnAnyCardPlayed`,
added a condition, switched its kind to "Played card has (gameplay) tag",
confirmed "Hit" appears as a real option in the tag dropdown (sourced
live from the other card's `gameplayTags`) and that the hint text cites
"[VERIFIED] ... round 10"; saved both cards and read `localStorage`
directly afterward to confirm `hitter.gameplayTags === ["Hit"]`,
`hitter.tags === []` (organizational field genuinely untouched), and
`reactor.effects[0].conditions[0] === {kind:"PlayedCardHasTag",
tag:"Hit"}`; reopened the reactor card and switched its trigger away from
`OnAnyCardPlayed`, confirming the tag condition auto-drops back to the
empty state, same behavior the keyword condition already had. Console/
pageerror listeners caught nothing beyond the expected `/api/game-status`
network noise from testing without a backend server.

## Card editor compaction: "Label"/"Tag" — pure frontend, no schema/
## backend/generated-C# changes

Tyler: the organizational Tags section and the new gameplayTags section
(above) were each taking a full-width row in the card editor, with their
text inputs always visible, even though most character authors will
never touch either field. Renamed for clarity too — "Tags" and "Gameplay
Tags" read as near-synonyms; Tyler asked for "Label" (organizational,
`card.tags`) and "Tag" (compiles, `card.gameplayTags`) instead, since
those two words are visually and semantically more distinct at a glance.

**Important: this is a UI-only relabeling.** The underlying schema field
names (`card.tags`, `card.gameplayTags`), the generated C# (`ForgeTags`,
`IForgeTaggedCard`), the condition kind id (`PlayedCardHasTag`), and
every backend validation rule from the round above are all completely
unchanged — only what's labeled/shown in the card editor moved. Anyone
reading `character.schema.json`, `compiler.js`, or `validate.js` will
still see `tags`/`gameplayTags` exactly as before; "Label" and "Tag" are
presentation-layer names only, chosen to read better in the editor.

What changed, `frontend/index.html` only:

- **Layout**: the two sections moved from stacked full-width blocks to a
  single two-column `.row` (existing flex layout class), each column
  `flex:1` — roughly halving the vertical space both together used to
  take, on top of the collapse behavior below.
- **Collapsed by default**: each section now shows only its chip row and
  a small toggle button ("+ Label" / "+ Tag") — the text input is
  `display:none` until the button is clicked. New shared widget,
  `setupCompactTagPicker({chipRowId, toggleBtnId, inputId,
  suggestionsId, tags, suggestions, emptyText})`, replaces what used to
  be two independent, near-duplicate ~30-line blocks (one per field).
  Clicking the toggle hides the button, reveals the input, and focuses
  it; Enter commits the typed value (trim, ≤40 chars, case-insensitive
  dedup against the existing array — same rule the fields already
  enforced) and collapses back to button-visible; Escape cancels without
  committing and collapses; blur also commits-then-collapses, so tabbing
  or clicking away doesn't silently discard a typed-but-unsubmitted
  value. Chip removal (the existing ✕ affordance) is unchanged.
- **Tooltips**: the explanatory sentence that used to sit as visible text
  under each field's label now lives in the toggle button's `title`
  attribute instead — shown on hover, keeping the always-visible UI
  compact while the explanation is still one hover away. "Label"'s
  tooltip explains it's purely organizational (board sort/filter only,
  no effect on the compiled mod); "Tag"'s tooltip explains it's a real
  gameplay tag other cards can react to via a condition, distinguishes it
  from BaseLib's closed `CardTag` enum, and notes it's case-insensitive.

Verified: `node --check` on the extracted `<script>` block passed;
brace/paren/backtick balance all matched (344/344 braces, 1002/1002
parens, 142 backticks even). Playwright (same pre-installed Chromium):
opened a card editor for a card seeded with an existing Label and Tag,
confirmed the field headers read "Label"/"Tag" (not "Tags"/"Gameplay
Tags"), confirmed both existing chips render correctly on open, confirmed
both inputs start hidden and both toggle buttons show the right text
("+ Label"/"+ Tag") and tooltip text; clicked the Label toggle and
confirmed the input appears, is focused, and the button hides; typed a
new label and pressed Enter, confirming it's added as a chip and the
widget collapses back to button-visible; clicked the Tag toggle, typed a
value, and pressed Escape, confirming nothing was added and the widget
collapsed; clicked the Tag toggle again, typed a different value, and
clicked elsewhere in the modal to blur, confirming the value WAS added
via the blur-commit path (a first attempt at this check clicked
`<body>` directly, which doesn't reliably blur a focused input in
headless Chromium — not a real bug, confirmed by clicking a real
in-modal element instead and by calling `.blur()` directly, both of
which committed correctly); saved the card and read `state` back to
confirm `card.tags`/`card.gameplayTags` hold exactly the expected final
arrays; reopened the editor and clicked a chip's ✕ to confirm removal
still works unchanged. No console/pageerrors at any point.

## Card editor compaction, round 2: "Labels:"/"Tags:" as single inline lines, no empty-state text

Tyler's direct follow-up to the round above: the two-column layout from
the first compaction pass wasn't what he wanted. He asked for no "no
labels/tags yet" placeholder text at all, "Labels:" with the +Label
button immediately to its right, chips stacking to the right of that
(same visual pattern as the multi-select status chip rows elsewhere in
this editor — `renderStatusPicker`'s `.chip-row`), "Labels:" and "Tags:"
directly stacked on top of each other, and the whole section limited to
exactly 2 lines (one per field).

Again UI-only — `card.tags`/`card.gameplayTags`, the generated C#, and
`PlayedCardHasTag` are all untouched; this is purely `frontend/index.html`
markup/CSS/JS.

- **Layout**: dropped the two-column `.row` from round 1 entirely.
  Replaced with two `.tagline` rows (new CSS class, `display:flex;
  flex-wrap:wrap; align-items:center`), stacked with a 2px gap. Each
  `.tagline` holds, in order: a fixed `.tagline-label` caption
  ("Labels:"/"Tags:"), a `.tag-add-row` (the toggle button, or — once
  clicked — the input, occupying the same spot), then a `.chip-row`
  that's `flex:1 1 auto` so chips flow immediately after the button and
  wrap onto extra lines only if there end up being enough chips to need
  it (verified up to 5 chips staying on one line in a normal-width
  editor; wrapping is still available for anyone who adds many more,
  rather than clipping or overflowing).
- **No empty-state text**: `setupCompactTagPicker` (from round 1) had an
  `emptyText` option that showed "No labels yet"/"No tags yet" as
  placeholder text in the chip row. Removed entirely — an unused field
  now renders as just the caption and the toggle button, nothing else,
  which is what makes the "always exactly 2 lines regardless of content"
  requirement work. The parameter and both call sites in `openCardEditor`
  were updated together.
- **Toggle button placement is now fixed** — it sits directly after the
  caption (not after the chips), and swaps in place for the input when
  clicked, so the caption+button always anchor the left edge of the line
  and chips always render after them, matching "the +Label button to the
  right of it" and "labels stack up to the right of the Labels: area."

Verified: `node --check` + brace/paren/backtick balance on the extracted
`<script>` block (343/343 braces, 1001/1001 parens, 140 backticks even);
HTML `<div>`/`</div>` count balanced (116/116). Playwright: confirmed the
caption text reads exactly "Labels:"/"Tags:" (not the old `<label>`
"Label"/"Tag"); confirmed neither "No labels yet" nor "No tags yet"
appears anywhere in the modal, for a freshly-created empty card; confirmed
both chip rows render as empty markup (not a placeholder span) when
unused; added 5 labels in sequence via the toggle→type→Enter flow and
confirmed all 5 render as chips on the same line, positioned immediately
to the right of the toggle button (same y-coordinate); added a gameplay
tag and confirmed its line is independent and unaffected; measured both
`.tagline` rows' bounding boxes and confirmed they're stacked directly on
top of each other (29px apart, tight — no leftover gap from the old
column layout); saved the card and confirmed `card.tags`/
`card.gameplayTags` persisted correctly; took screenshots of the empty
state, a populated state (3 labels + 2 tags), and the expanded-input state
and visually confirmed the layout matches the request (2 lines total,
chips flowing right, input swapping in for the button in place). No
console/pageerrors at any point.

## Real If/Then/Else conditions, a condition "subject" (target/self/pet), and stacked branches — schema + backend + frontend

Tyler: "The conditions area on cards should be simplified. Start with an
'if' statement... 'If' <target> ... 'has' <some condition> ... 'then'...
add a numerical check here if it makes sense... but not for a condition
like 'played card is an attack'... stack if/else statements... 'If player
has 4 strength, deal 12 damage, else: deal 5 damage. But also, if the
player has 2 dexterity, deal an additional 2 damage', all in the same
card." This landed as three real, separate pieces, not one:

**1. The "stack if/else statements... all in the same card" half was
ALREADY structurally possible** — every effect block already ANDs its
conditions and gates its actions on them, and a card/relic/mechanic
already supports multiple independent effect blocks under the same
trigger via "+ Add effect block". What was missing was purely (a) a
real "else" branch per block, and (b) the UI reading as "If/Then/Else"
rather than an abstract "Conditions" + "Actions" pair. Both fixed below —
no new "stack multiple conditions" mechanism was needed, just make the
one that already existed read like Tyler's example.

**2. New: `elseActions` — a real "else" branch per effect block.**
`backend/compiler.js`'s `effectBlockToCSharp` now emits a real C# `else`
clause (`if (cond) { actions } else { elseActions }`) whenever an effect
block has both conditions AND a non-empty `elseActions` array — omitted
entirely (just the existing `if { actions }`) when `elseActions` is empty,
so every previously-generated card's C# output is byte-for-byte unchanged
unless it opts in. `elseActions` is validated with the exact same rules as
`actions` (`backend/validate.js`'s `validateActions` gained an optional
`fieldName` parameter — 'actions' by default, 'elseActions' when called a
second time — reusing one function instead of a second, drift-prone
copy) and is REJECTED outright if present on a condition-less block (an
"else" with nothing to be the opposite of is meaningless — and
compiler.js's `effectBlockToCSharp` would never even reach the branch that
emits it, so it'd silently never run if allowed through).

**3. New: condition `subject` (Self/CardTarget/Pet) — Tyler's "If
<target> has <condition>" ask**, changeable per condition, on
`HasStatusStacks` (the only real numeric per-creature condition kind
today — the ones without a meaningful "target creature" concept at all,
like `EnergyRemaining`/`CardsInHand`/`PlayedCardHasKeyword`, don't get a
subject dropdown, matching Tyler's own "but not for a condition like
'played card is an attack'" carve-out).

- **"Self" and "CardTarget"** resolve to the exact same `fgPlayer`/
  `fgTarget!` locals every action already uses (`resolveTargetExpr`) —
  zero new risk, since `HasStatusStacks` already ran unconditionally on
  `fgPlayer` before this round; `subject: undefined` (any condition saved
  before this field existed) is read as `'Self'` by
  `resolveConditionSubjectExpr`, so old saved packages compile to the
  identical behavior they always had.
- **"Pet" is a genuinely new, real capability** — `[VERIFIED via
  reflect-baselib round 5]` `Player.Osty` (found the SAME round as
  `Player.Creature`, sitting right next to it in the dump — see "reflect-
  baselib round 5, combined dump" above) is a real, public, concrete
  `Creature`-typed property: the "pet" companion creature some STS2
  characters have. `cardPlay.Player.Osty` is a real, grounded expression —
  but `cardPlay` itself (the thing with a `.Player` to walk from) is ONLY
  ever in scope in the two trigger contexts that bind directly off a
  `CardPlay`: a card's own `OnPlay`, and `OnAnyCardPlayed` (real for both
  cards AND relics/mechanics). Every OTHER trigger either has no real
  player/target binding at all (falls to `ForgeActions.Todo(...)`, so a
  Pet subject never reaches generated code either way) or binds off some
  OTHER real parameter that isn't a `Player` (e.g. `OnTakeDamage`'s
  `target`/`dealer` — plain `Creature` params, no back-reference to a
  `Player` to find `.Osty` on). `backend/compiler.js` now exports
  `PET_SUPPORTED_TRIGGERS = ['OnPlay', 'OnAnyCardPlayed']` (one source of
  truth, imported by `backend/validate.js`) — a `subject: "Pet"` condition
  on any other trigger is REJECTED before it ever risks emitting a
  reference to an unbound `fgPet` local. `Card.cs.template`'s `OnPlay` and
  both `OnAnyCardPlayed` codegen paths (`CARD_TRIGGER_HOOKS`' card-side
  generation, and `TRIGGER_HOOKS`' relic/mechanic-side `generateHookEffects`)
  all now bind `var fgPet = cardPlay.Player.Osty;` alongside the existing
  `fgPlayer`/`fgTarget` lines.
- Deliberately a SEPARATE vocabulary from action `target` (SingleEnemy/
  AllEnemies/Self/RandomEnemy) — subject picks WHICH ONE creature a
  condition reads a value FROM; target picks which creature(s) an ACTION
  affects. Reusing the same enum would have conflated two different
  questions (e.g. "AllEnemies" is a valid action target but meaningless as
  "which one creature's stacks to check").

**4. UI reframed as a real If/Then/Else, `frontend/index.html` only** (no
schema/backend concept changed by this half — purely presentation):

- The conditions section now reads "If (all of the following are true —
  leave empty to always run):" with a leading `IF` badge on the first line
  of each condition row (`.cond-if` — a Tyler ask: "start with an 'if'
  statement").
- HasStatusStacks rows gained the subject `<select>` (Self (you)/Target of
  card/Pet (Osty)) right after the `IF` badge — filtered by
  `availableSubjects(eff)` to hide "Pet" entirely on any trigger outside
  `PET_SUPPORTED_TRIGGERS`, same "don't offer a choice validate.js would
  reject" convention `availableConditionKinds` already used for
  PlayedCardHasKeyword/PlayedCardHasTag. Switching an effect block's
  trigger away from OnPlay/OnAnyCardPlayed now also resets any
  already-selected "Pet" subject back to "Self" (mirrors the existing
  kind-vs-trigger mismatch cleanup `refreshConditions` already did for
  condition KINDS, now also covering subject).
- A `THEN:` label sits above the actions list, and a new `Else:` section
  (its own action list + "+ else action" button) sits below it — same row
  rendering/wiring code as the main actions list, generalized
  (`renderActionRows`/`wireActionRowHandlers` now take the actions ARRAY
  directly instead of an effect block, so `eff.actions` and
  `eff.elseActions` share one implementation instead of a duplicated one).
  The Else section is only enabled once the block has at least one
  condition — greyed out with an explanatory label
  ("Else — add a condition above first...") otherwise, and any existing
  else actions are cleared automatically the moment a block's last
  condition is removed (mirrors validate.js's server-side rejection of
  that same combination, applied live in the UI instead of only being
  caught on export).
- "Stack if/else statements... all in the same card" (Tyler's exact
  phrase) needed NO new UI — "+ Add effect block" (pre-existing) already
  adds another independent If/Then/Else unit under the same trigger; the
  worked example below uses exactly two stacked blocks, matching Tyler's
  two-sentence request precisely.

**Verified**: `node --check` + brace/paren/backtick balance on the
extracted `<script>` block (all matched) and `<div>`/`</div>` HTML
balance; direct `validateCharacterPackage()`/`generateProject()` tests
covering: a valid if/else with subject Self (matches Tyler's "If player
has 4 strength, deal 12, else deal 5" verbatim); a second stacked block
with subject CardTarget and no else (matches "if player has 2 dexterity,
deal an additional 2 damage"); subject Pet on OnPlay (valid) and on a
relic's OnTakeDamage (correctly REJECTED, unbound `fgPet`); elseActions
with no conditions (correctly REJECTED); an invalid subject value
(correctly REJECTED); a condition with no `subject` field at all — the
pre-existing shape — still validating clean (backward compatible); and a
combined stress test (3 stacked blocks mixing Self/Pet/CardTarget
subjects on a card, plus a mechanic reacting on OnAnyCardPlayed with a Pet
subject and an empty elseActions array) generating fully correct,
brace-balanced C# for both the card and the mechanic, confirming `fgPet`
binds correctly on the relic/mechanic codegen path too, not just cards.
Playwright (same pre-installed Chromium): built a two-block card matching
Tyler's exact worked example end to end through the real UI (add effect
block, add condition, pick subject/mechanic/comparator/value, add a Then
action, add an Else action, add a second stacked block with no else);
confirmed the `IF`/`THEN:`/`Else:` labels render, the subject dropdown
offers Self/CardTarget/Pet on OnPlay; confirmed removing a block's only
condition disables and clears its Else section live; confirmed switching
a block's trigger to OnDiscard removes "Pet" from the subject dropdown
and resets an already-selected Pet subject back to Self; confirmed
switching a condition's kind away from HasStatusStacks (e.g. to "Played
card is an Attack") hides the subject dropdown entirely and switching
back restores it defaulted to Self; saved and read the resulting
`state.cards[].effects` back to confirm `conditions[].subject` and
`elseActions[]` both persisted exactly as built. No console/pageerrors at
any point.

---

## HP% conditions get a subject too, HasStatusStacks learns vanilla statuses, and a data-only Pets/Orbs section

Tyler's follow-up, verbatim: "the hp below % condition should allow either
yourself or pet or enemy to be the target of the check. Also, the
condition that checks for statuses should work on both vanilla as well as
custom statuses. Currently it only works for custom. We also need to add
a section to the page to create custom pets as well as orbs." Three
separate asks, handled in order of how much evidence backs each one.

### 1. HpBelowPercent gets a subject (Self/CardTarget/Pet)

Straightforward extension of the exact mechanism built for HasStatusStacks
last round: `backend/compiler.js`'s `CONDITION_SUBJECTS`/
`resolveConditionSubjectExpr`/`PET_SUPPORTED_TRIGGERS` are all reused
as-is (nothing about the underlying subject vocabulary or Pet-on-two-
triggers-only restriction changes for a second condition kind). A new
`SUBJECT_CAPABLE_CONDITION_KINDS = ['HasStatusStacks', 'HpBelowPercent']`
list (mirrored frontend/backend, same pattern as `BUILTIN_STATUSES`) is
the single source of truth for "which condition kinds show the subject
dropdown at all" — `backend/validate.js`'s subject validation block moved
from being nested inside the `HasStatusStacks`-only `if` to running for
any kind in that list, so the exact same Pet-on-wrong-trigger rejection
now protects HpBelowPercent too.

The honest part: HP% itself STILL has no confirmed BaseLib accessor in
any reflect-baselib round so far (rounds 1-11 never found one) — this
condition remains `ForgeActions.TodoCondition(...)`, compiles but throws
if actually reached. The subject is captured and threaded into the Todo
message (`TodoCondition("HpBelowPercent(subject=Pet)")` etc.) so it's
visible in generated code/logs, but it doesn't change runtime behavior
yet — it's stored now so nothing about the UI/schema needs to change
again once a future round confirms a real HP accessor. This mirrors the
project's established pattern (see e.g. `OnDiscard`/`OnTurnEndInHand`'s
real trigger + Todo body) one level further: here even the trigger-side
piece (subject) is real/wired while the condition's OWN evaluation is
still the honest placeholder.

### 2. HasStatusStacks: vanilla statuses, not just custom mechanics

New `cond.statusKind` field (`'vanilla' | 'custom'`, defaults to `'custom'`
— the only kind this condition supported before this round, so old saved
packages keep compiling identically). Mirrors the ALREADY-EXISTING
action-side split exactly: `ApplyStatus`/`RemoveStatus` (vanilla,
`builtinStatuses[]` from the same `BUILTIN_POWER_CLASS_MAP` reflect-
baselib round 8 confirmed) vs. `ApplyCustomStatus`/`RemoveCustomStatus`
(custom, `statusRefs[]`). A condition only checks ONE threshold though
(not several statuses at once, unlike an action applying/removing a
batch), so this is a single-select toggle + single-select status/mechanic
picker, not the multi-select `renderStatusPicker` widget those actions
use.

`backend/compiler.js`'s `conditionToCSharp` HasStatusStacks case now
resolves its generic type argument from either `BUILTIN_POWER_CLASS_MAP[cond.builtinStatus]`
(vanilla) or `mechanicClassName(cond.statusRef)` (custom, same as before)
— e.g. `ForgeActions.GetStatusStacks<global::MegaCrit.Sts2.Core.Models.Powers.StrengthPower>(fgPlayer) >= 4`
for a vanilla Strength check. `backend/validate.js` validates
`builtinStatus` against `BUILTIN_STATUSES` (vanilla) or `statusRef`
against `mechanicIds` (custom) depending on `statusKind`. Confidence
level: same [BEST EFFORT] as the existing vanilla ApplyStatus/RemoveStatus
actions — `GetStatusStacks<T>()` itself is [VERIFIED] real (round 7), and
`BUILTIN_POWER_CLASS_MAP`'s 244 selectable classes are [VERIFIED] real
names (round 8), but the exact runtime behavior of reading a built-in
Power's stack count this way hasn't been confirmed by an actual build
with this specific condition yet.

### 3. Pets & Orbs — a genuinely new gap, handled by NOT generating C# yet

This is different from every other [UNVERIFIED]/Todo placeholder already
in this codebase. Every existing Todo (HpBelowPercent, EnergyRemaining,
CardsInHand, IsAttack, OnDiscard/OnTurnEndInHand's action bodies) has a
CONFIRMED REAL trigger/method signature — the uncertainty is narrowly
scoped to "what does the body do", and `ForgeActions.Todo(...)`/
`TodoCondition(...)` are real, compiling methods that only fail at
runtime IF actually reached. Custom Pets/Orbs are a level less certain
than that:

- **Orbs**: reflect-baselib previously confirmed (see "Real namespaces,
  from decompiling your two installed mods" above)
  `<ModId>.Orbs.<OrbName>Orb` is a genuine, real folder/namespace
  convention used by real installed mods — so custom Orbs ARE a real,
  supported BaseLib concept in principle. But no round has ever reflected
  the actual base class name, constructor signature, or method shape
  needed to generate C# for one. Round 11 (`tools/reflect-baselib/Program.cs`,
  new this round) searches specifically for `CustomOrbModel` (following
  the extremely consistent `Custom<Thing>Model` naming pattern — 7 for 7
  other confirmed base classes: CustomCardModel/CustomRelicModel/
  CustomPowerModel/CustomCharacterModel/CustomCardPoolModel/
  CustomRelicPoolModel/CustomPotionPoolModel), any other `*Orb*`-named
  type, and dumps every type actually declared in the confirmed-real
  `MegaCrit.Sts2.Core.Entities.Orbs` namespace directly (the base game's
  own built-in orbs almost certainly share whatever base class a custom
  one would need).
- **Pets**: even less grounded. The only confirmed real "pet" concept
  anywhere in this project is `Player.Osty` (round 5) — a FIXED property
  every Player already has, not something a mod creates. No round has
  found any evidence (not even a plausible naming-pattern guess) that a
  mod can define an additional or replacement companion. Round 11 also
  sweeps for any `*Pet*`/`*Companion*`/`*Osty*`-named type anywhere, plus
  a fresh look at `Player`'s own METHODS (round 5 only ever looked at its
  PROPERTIES) for anything companion-creation-shaped.

**Why this changes the implementation approach**: guessing a base class
name for a `.cs` file risks a hard `CS0246` ("type or namespace not
found") if the guess is wrong — unlike a Todo() runtime exception, this
would fail the ENTIRE mod's build, not just silently misbehave if this
one feature is reached. That blast radius is categorically worse than
every other [UNVERIFIED] piece in this project, so the same "guess and
let a real build attempt correct it" methodology used everywhere else
(OnPlay's signature, the base constructor, PoolAttribute's namespace,
etc.) isn't safe to apply here yet — those guesses were all corrected by
ONE real build attempt catching ONE error; a wrong Orb/Pet base class
guess could plausibly block Tyler from building ANYTHING while he
diagnoses it.

**What was actually built instead**: a real, working Forge UI (new
"05 Pets" / "06 Orbs" panel sections, `frontend/index.html`) for
capturing name/description/passive-effect-text/evoke-effect-text/base-
magnitude/Focus-scaling per pet or orb, backed by real schema (`pets`/
`orbs` arrays, `schema/character.schema.json`) and real validation
(`backend/validate.js`) — all fully functional today. On export,
`backend/compiler.js`'s new `buildPetsReadme`/`buildOrbsReadme` render
this data into `Pets/README.md` / `Orbs/README.md` inside the compiled
mod zip — Markdown, not `.cs`, so MSBuild's default `**/*.cs` glob never
sees them and NOTHING typed into either section can ever break a real
build. Both the in-app section descriptions and the README headers
explicitly say "not yet compiled" and explain why, so nothing about this
overstates its own completeness. The moment round 11 (or a later round)
confirms a real base class/constructor for either, this same captured
data is ready to drive real Cs# generation — only `generateProject`'s two
`if (...)` blocks need to change from "write a README" to "write a real
.cs from a new template", the data model itself doesn't need to change.

Note: this "Orbs" gameplay concept (Frost/Lightning/Dark-style, evoke/
passive) is UNRELATED to the pre-existing "Orb mode" in the Art section
(`character.orb.mode` — buildFromColor/customLayers/default) — that's the
character's visual energy-orb ART (the graphic showing HP/energy in the
UI), a completely different thing that already works and wasn't touched
this round. Both the new Orbs section's panel-desc and its README header
call this distinction out explicitly to avoid confusion.

### Verification

`node --check` on `backend/compiler.js`, `backend/validate.js`, and the
extracted frontend `<script>` block; brace/paren/backtick balance
(`{`/`}` 402/402, `(`/`)` 1193/1193, backtick 184 — even) on the extracted
script; `<div>`/`</div>` HTML balance (144/144); `JSON.parse()` on
`schema/character.schema.json`. Direct `validateCharacterPackage()`/
`generateProject()` tests: vanilla HasStatusStacks (Strength, subject
Self, with elseActions) validates clean and compiles to
`ForgeActions.GetStatusStacks<global::MegaCrit.Sts2.Core.Models.Powers.StrengthPower>(fgPlayer) >= 4`;
custom HasStatusStacks (backward-compat, no `statusKind` field at all)
still validates clean and compiles to the mechanic's own Power class,
confirming old saved packages keep working; vanilla with no
`builtinStatus` correctly REJECTED; HpBelowPercent with subject Pet on
OnPlay validates clean and compiles to
`ForgeActions.TodoCondition("HpBelowPercent(subject=Pet)")`; the same
condition with subject Pet on a relic's OnTurnStart correctly REJECTED
(same Pet-restricted-triggers message as HasStatusStacks). Pets/Orbs:
valid pet+orb round-trip through validation and `generateProject()`,
producing exactly the two expected README.md files with all captured
fields rendered; a pet with no name, and an orb with a non-numeric
`baseValue`, both correctly REJECTED; zero pets/zero orbs produces zero
Pets/Orbs files (no empty README clutter). Playwright (same pre-installed
Chromium): built a HasStatusStacks condition, confirmed the vanilla/
custom toggle swaps between a builtin-status dropdown and a mechanic
dropdown live, confirmed changing the builtin-status selection and the
subject (to Pet) both persist onto the live condition object, confirmed
changing the effect block's trigger away from a Pet-supported one resets
the subject back to Self; confirmed HpBelowPercent also gets the subject
dropdown. Separately: clicked through the real Pets and Orbs section "+"
tiles, filled in every field through the actual modal editors, saved,
and confirmed the resulting `state.pets`/`state.orbs` arrays and the
live "N pet(s)"/"N orb(s)" counters both matched exactly what was
entered, with zero console/page errors throughout.

---

## Round 12: reflect-baselib now supports multiple example mods, and directly checks each for a real, working pet/orb

Tyler: "I have several pets in my thetrainernewcharacter.dll that we
might want to reference. I also have a new orb in my
theburdenednewcharacter.dll that might help in that department. Should
the reflect tool be modified to take a look at those as well?" Yes — this
is a categorically stronger evidence source than round 11's name/
namespace sweep of the base game/BaseLib alone. Round 11 can only tell us
whether a plausible base class *exists somewhere* to extend; a real,
installed, presumably-working mod that already extends it tells us
*exactly* which class that is, read straight off reflection's `.BaseType`
— no guessing, no naming-convention inference, the same "read it straight
from a real example" approach round 10 already used successfully for
CardTag/AfterCardPlayed usage against `TheTrainerNewCharacter.dll`.

Two changes to `tools/reflect-baselib/Program.cs`:

1. **Multiple example mods, not just one.** The example-mod argument
   (previously a single optional 3rd CLI argument, `exampleModPath`) now
   accepts any number of trailing arguments — `args.Skip(2)` — each
   loaded into its own `(Label, Asm, Types)` tuple. Every existing round
   that referenced "the example mod" (round 10's Cards/Powers/Relics/
   Characters/TokenCards usage dump, its Tag/Keyword/CardPlayed sweep)
   now loops over every mod passed in and reports findings attributed to
   the specific DLL they came from, rather than assuming just one.
   Backward compatible — passing zero or one mod behaves identically to
   every previous round.
2. **New round 12: a dedicated pet/orb sweep per example mod.** For each
   mod, finds every candidate type by namespace convention (`.Pets`/
   `.Companions`/`.Orbs` — the same `<ModId>.<Thing>` pattern already
   confirmed for Cards/Powers/Relics/Characters/TokenCards/Orbs) OR by
   "Pet"/"Companion"/"Orb" appearing anywhere in the type name (in case a
   mod doesn't follow the namespace convention). For every match, dumps:
   its full base type chain (walking `.BaseType` up to `object`) — the
   single most valuable line, since if `TheTrainerNewCharacter.dll`
   already has a real, working pet, this literally IS the confirmed real
   base class Forge needs to extend; every constructor (`DumpConstructors`,
   round 6); and every property/field (`DumpAllInstanceMembers`, round 3).

Not yet run — Tyler hasn't executed this round against his real DLLs yet.
Once he does and pastes back `reflect-output.txt`, this should directly
close (or substantially narrow) the two open gaps from last round: a
confirmed real base class for custom Orbs (if `TheBurdenedNewCharacter.dll`'s
orb shows up), and — a genuinely new possibility — a confirmed real
mechanism for custom Pets at all (if `TheTrainerNewCharacter.dll`'s pets
show up), which previously had *zero* supporting evidence of any kind.

### Verification

Since this sandbox has no `dotnet` SDK available (consistent with every
previous round — Tyler's real `dotnet run` on his own machine is the only
way this file has ever actually been compiled), verification here is
structural: brace/paren balance across the whole file (315/315 braces,
933/933 parens after this round's edits) and a careful manual read of
every new/changed block against the existing helper signatures
(`DumpConstructors(Type)`, `DumpAllInstanceMembers(Type)`,
`DumpMatchingMembers(Type, Func<string,bool>, string)`, `TryLoad(string)`,
`SafeGetTypes(Assembly)`) already used identically elsewhere in the file,
confirming no stale references to the retired single-mod variables
(`exampleModAsm`/`exampleModPath`/`exampleModTypes`) remained anywhere.

## Round 12 results: Tyler ran it against TheTrainerNewCharacter.dll (TheBurdenedNewCharacter.dll failed to load)

Tyler ran the round-12 reflect-baselib build and pasted back a real
`reflect-output.txt` (3468 lines). Findings:

- **`BaseLib.Abstracts.CustomOrbModel` — CONFIRMED real.** Abstract,
  extends `MegaCrit.Sts2.Core.Models.OrbModel`, public parameterless
  constructor. Abstract members: `PassiveVal`/`EvokeVal` (decimal).
  Virtual members: `Passive(PlayerChoiceContext, Creature)`,
  `Evoke(PlayerChoiceContext)` returning `Task<IEnumerable<Creature>>`,
  `ActivatePassive()`, `ActivateEvoke(Creature[])`, plus sfx hooks. This is
  now real evidence toward generating actual Orb C# (still not implemented
  — `orbs[]` is still data-capture-only, see schema/character.schema.json —
  but the blocker specifically is a follow-up reflect-baselib round to
  confirm the base constructor call shape and hook signatures precisely
  enough to safely generate, not "no evidence exists" anymore).
- **`BaseLib.Abstracts.CustomPetModel` — exists (found by the name sweep,
  `abstract=True`) but was NOT deep-dumped** — a gap in round 11/12's own
  scripts (the sweep matched it by name but the deep-dump logic only ran
  on the mod-sourced pet types below, not this BaseLib base class itself).
  Left as an open follow-up rather than guessing its shape.
- **The pivotal finding: `TheTrainerNewCharacter`'s real, working pets do
  NOT use `CustomPetModel` at all.** `BlastoisePet`, `BulbasaurPet`,
  `CharizardPet`, `CharmanderPet`, `CharmeleonPet`, `IvysaurPet`,
  `SquirtlePet`, `VenusaurPet`, `WartortlePet` (namespace
  `TheTrainerNewCharacter.Monsters`) all extend
  `BaseLib.Abstracts.CustomMonsterModel` ->
  `MegaCrit.Sts2.Core.Models.MonsterModel` ->
  `MegaCrit.Sts2.Core.Models.AbstractModel`. Each has a public
  parameterless constructor and declares `MinInitialHp`/`MaxInitialHp`/
  `IsHealthBarVisible`. Almost certainly attached at runtime via
  `MegaCrit.Sts2.Core.Commands.PlayerCmd.AddPet` (seen only as
  compiler-generated async state machine names —
  `<AddPet>d__14`/`<AddPet>d__15` — real signature not yet captured) and/or
  `MegaCrit.Sts2.Core.Commands.OstyCmd` (abstract, not deep-dumped). This
  changes the plan for real Pet codegen: it should follow the
  `CustomMonsterModel` + `PlayerCmd.AddPet` path Tyler's own mod actually
  demonstrates working, not the unused, unconfirmed-in-practice
  `CustomPetModel` base class, once `AddPet`'s real signature and
  `CustomMonsterModel`'s abstract requirements are confirmed. `pets[]`
  stays data-capture-only for now (see schema) — this is real, useful
  evidence, not yet enough to safely generate compiling C#.
- **`TheBurdenedNewCharacter.dll` FAILED TO LOAD** — Tyler passed the
  containing folder path (`...\mods\TheBurdenedNewCharacter`) rather than
  the `.dll` file inside it. Its orb data is still unknown; needs a
  corrected re-run pointed at the actual `.dll` to close this gap.
- **`enum MegaCrit.Sts2.Core.Entities.Characters.CharacterGender {
  Neutral, Feminine, Masculine }` — CONFIRMED real**, and `Gender` is
  confirmed to be an ABSTRACT, override-required member (public getter
  only) on both `CharacterModel` and `CustomCharacterModel`. This is now
  wired into a real `character.gender` schema field and UI control — see
  "Task #14: real character gender selector" below.
- **`[Player] property System.Int32 BaseOrbSlotCount { get; set; }` —
  CONFIRMED real and settable**, but NOT found among `CharacterModel`'s
  abstract members — the mechanism for a custom character to seed this at
  run start (Tyler's item 13, "char options for orb slots base") is still
  unconfirmed. Stays an open follow-up (see the round-13 wishlist below).

### Open follow-ups for a future reflect-baselib round

1. Item 13's orb-slots-base mechanism — how a custom character seeds
   `Player.BaseOrbSlotCount` at run start (no abstract `CharacterModel`
   member found for this yet).
2. `CustomPetModel`'s own deep dump (constructors + all members) — never
   done, despite being found by name.
3. `CustomMonsterModel`'s abstract requirements — needed to know what a
   Forge-generated pet-as-monster class must implement.
4. `PlayerCmd.AddPet`'s real signature (only the compiler-generated async
   state machine name is visible so far).
5. `OstyCmd`'s real shape (abstract, not deep-dumped).
6. A corrected `TheBurdenedNewCharacter.dll` path (the file itself, not
   its containing folder) to finally get real orb example data from
   Tyler's own installed mod.

## Task #8: status-stacks scaling ("do this equal to the number of stacks of the status I have")

Tyler's item 1 from his 18-item list, using his own example: "status needs
a 'do this thing equal to the number of stacks of the status I have' like
poison." This was a previously half-built feature — `amountScalesWithStatus`
already existed in `schema/character.schema.json` and had a validation
stub in `backend/validate.js`, but was never wired to any codegen or any
UI control, so it was completely unreachable/inert before this round.

Completed end-to-end, following the same vanilla/custom split pattern
`HasStatusStacks` already established earlier this session (since Tyler's
own example — Poison — is a real vanilla status, not a custom mechanic,
the feature has to support both):

- **`schema/character.schema.json`** — replaced the single
  `amountScalesWithStatus` property with three:
  `amountScalesWithStatusKind` (`"vanilla"`/`"custom"`),
  `amountScalesWithStatus` (existing — custom mechanic id), and
  `amountScalesWithBuiltinStatus` (new — real vanilla status class name,
  from the same 244-entry `BUILTIN_POWER_CLASS_MAP` every other
  vanilla-status feature uses).
- **`backend/validate.js`** — full vanilla/custom validation (kind must be
  one of the two values; the matching ref field must be present and must
  resolve to a real mechanic id / real builtin status name).
- **`backend/compiler.js`** — new `resolveAmountExpr(action)` helper:
  returns the raw `action.amount` literal normally, or
  `(${amount} * ForgeActions.GetStatusStacks<${typeArg}>(fgPlayer))` when
  scaling is configured. Wired into the exactly 4 action types that
  consume `action.amount` as a raw `int` literal — `DealDamage`,
  `GainBlock`, `LoseHp`, `HealHp` — replacing their previous bare
  `${action.amount}` reference. Always reads the ACTING PLAYER's own
  current stacks (`fgPlayer`/Self) — no subject picker — matching Tyler's
  literal wording, "the status **I** have."
- **`frontend/index.html`** — new `actionCanScaleWithStatus(type)` mirrors
  the same 4-type backend scoping; the action-row editor grew a "per
  stack" checkbox (shown only for those 4 types) that reveals a
  vanilla/custom kind toggle plus the matching picker, reusing the
  existing `statusOptionsData()`/`mechanicOptionsData()` option-list
  builders.
- **Bug found and fixed during Playwright verification**: the row's
  `isScaling` flag was originally computed as
  `canScale && (act.amountScalesWithStatus || act.amountScalesWithBuiltinStatus)`
  — truthy-checking the ref value itself. With zero custom mechanics
  defined, switching the kind to "custom" sets
  `act.amountScalesWithStatus = ''` (empty string, since there's nothing
  to default to), which is falsy — so the entire scale row, including the
  kind selector, silently vanished the moment a user picked "custom
  mechanic" with none defined yet, with no way back to vanilla short of
  unchecking and rechecking. Fixed by keying `isScaling` off
  `!!act.amountScalesWithStatusKind` instead (always set by both the
  toggle-on and kind-switch handlers whenever scaling is actually on), so
  an empty ref value no longer gets mistaken for "scaling off."

### Verification

`node --check` on `backend/compiler.js`/`backend/validate.js`; schema JSON
re-parsed; three direct `validateCharacterPackage()` tests (vanilla-valid,
custom-valid, vanilla-missing-ref correctly rejected); a direct
`generateProject()` test confirming real codegen —
`await ForgeActions.DealDamage(choiceContext, fgTarget!, (1 *
ForgeActions.GetStatusStacks<global::MegaCrit.Sts2.Core.Models.Powers.PoisonPower>(fgPlayer)));`.
Frontend verified with a real headless-Chromium (Playwright) pass against
the static frontend: the "per stack" checkbox appears only on the 4
eligible action types, toggling it reveals the vanilla/custom row (244
real vanilla statuses in the dropdown, confirmed by option count), the
custom path correctly shows a real injected mechanic by name and writes
its id back into `action.amountScalesWithStatus`, and unchecking correctly
hides the row again — this pass is what caught and confirmed the fix for
the `isScaling` bug above.

## Task #14: real character gender selector (Neutral/Feminine/Masculine)

Tyler's item 12. Fully evidenced already (see the `CharacterGender`
finding in "Round 12 results" above) — no further reflect-baselib work
needed. `character.gender` is a new, optional schema enum
(`Neutral`/`Feminine`/`Masculine`, defaults to `Neutral` for
backward-compat with characters saved before this field existed), exposed
as a select in the Character panel, validated in `backend/validate.js`,
and wired into `backend/templates/Character.cs.template`'s existing
`Gender` override (previously a hardcoded `CharacterGender.Neutral`
[BEST EFFORT] placeholder — now real per-character data, `[VERIFIED]`).

### Verification

`node --check`/JSON parse on all changed files; `validateCharacterPackage()`
tests for a valid gender, an invalid one (rejected with a clear message),
and an omitted one (valid, defaults applied); a direct `generateProject()`
test confirming the template emits
`public override CharacterGender Gender => CharacterGender.Masculine;`
for a character with `gender: "Masculine"`. Frontend verified with
Playwright: the new Gender select renders with the right 3 options,
defaults to Neutral, and selecting a value writes it to
`state.character.gender` immediately.

## Task #16: real BaseLib CardTag (Strike/Defend) on cards

Tyler's item 15, "need to add tag for if card is strike or defend." This
is a DIFFERENT mechanism from the Forge-owned `gameplayTags`/`ForgeTags`
system built in round 10 — that one is freeform and only understood by
other Forge-generated cards via `PlayedCardHasTag`. This task targets
BaseLib's own real, closed `CardTag` enum instead, so base-game/other-mod
logic that specifically checks `CardTag` (e.g. real Strike-synergy
relics/powers already in the base game) recognizes the card too. Round 10
had already confirmed everything needed to do this safely:

- `CardTag` — real, closed enum: `None`, `Strike`, `Defend`, `Minion`,
  `OstyAttack`, `Shiv`.
- `CanonicalTags` — `[CardModel, virtual, protected] property
  HashSet<CardTag> CanonicalTags { get; }`, a real, overridable property,
  the same override shape as the already-real `CanonicalKeywords`.

New: `card.baseCardTag` (schema, one of the 6 real enum values, defaults
to `"None"`), a "Base card tag" select in the card editor (right below the
Keywords picker, distinctly labeled and titled from the Tags/gameplay-tag
chip widgets), and `backend/compiler.js`'s new
`generateCanonicalTagsOverride(card)` — emits
`protected override HashSet<CardTag> CanonicalTags => new HashSet<CardTag>
{ CardTag.X };` when a real tag is set, or nothing at all (falls back to
the base class's own default) when left at `"None"`. All 5 real non-None
values are exposed, not just Strike/Defend — Tyler's literal ask — since
they're part of the same confirmed closed enum and cost nothing extra to
offer; the UI copy notes Minion/OstyAttack/Shiv are mainly relevant to
summon/Osty-attack/Silent-shiv-style cards.

### Verification

`node --check`/JSON parse on all changed files; `validateCharacterPackage()`
tests (Strike valid, None valid, omitted valid, an invalid value rejected
with a clear message); a direct `generateProject()` test confirming a
Strike-tagged card emits the real `CanonicalTags` override and an
untagged card emits nothing extra. Frontend verified with Playwright: the
select renders with all 6 real values, defaults to None, and the chosen
value round-trips through Save into `state.cards[].baseCardTag`
correctly.

## Round 11 & 12 corrected re-run: BOTH mods loaded — real MoonOrb and MoonPet found

Tyler re-ran reflect-baselib with the corrected path (the actual
`TheBurdenedNewCharacter.dll` file this time, not its containing folder)
and pasted back a new `reflect-output.txt` (3909 lines). Both example mods
loaded successfully this run, closing the round-13 wishlist's biggest
item — real, working custom Orb AND Pet examples from Tyler's own
`TheBurdenedNewCharacter.dll`.

### What's newly confirmed

- **`TheBurdenedNewCharacter.Orbs.MoonOrb` — a REAL, WORKING custom Orb.**
  Base type chain: `BaseLib.Abstracts.CustomOrbModel -> MegaCrit.Sts2.Core.Models.OrbModel -> MegaCrit.Sts2.Core.Models.AbstractModel`.
  Public parameterless constructor (`MoonOrb()`), and its own declared
  members are EXACTLY 3: `PassiveVal` (decimal), `EvokeVal` (decimal),
  `DarkenedColor` (Godot.Color) — nothing else. It also overrides
  `Passive()`/`Evoke()`/`AfterTurnStartOrbTrigger()` (confirmed by its
  compiled async state-machine nested classes, e.g.
  `MoonOrb+<Evoke>d__17`), for its own custom per-turn/evoke behavior —
  but those method BODIES aren't visible to reflection, only that they
  exist.
- **`TheBurdenedNewCharacter.Monsters.MoonPet` — a SECOND real pet
  example**, confirming the `CustomMonsterModel` finding from the earlier
  round wasn't a one-off: same base chain as all 9 Trainer pets
  (`CustomMonsterModel -> MonsterModel -> AbstractModel`), same 3 declared
  members (`MinInitialHp`/`MaxInitialHp`/`IsHealthBarVisible`), public
  parameterless constructor. Across all 10 real pets now reflected (9
  Trainer + 1 Burdened), the required-override set is 100% consistent —
  strong confirmation this is genuinely the right base class and its full
  abstract-member set, not a partial/coincidental match.
- **A resolved discrepancy worth documenting for future rounds' honesty
  calibration**: `DumpAbstractMembers(customOrbModel)` (the same "abstract
  members of every model base class" sweep that correctly found Card's/
  Character's/Power's required overrides) ALSO flagged
  `ShouldReceiveCombatHooks` as still-abstract on `CustomOrbModel`. But
  `MoonOrb` — a real compiled DLL, which the C# compiler would refuse to
  build as a non-abstract class unless every abstract member were
  satisfied — does NOT declare it anywhere in its own member dump.
  Reading `tools/reflect-baselib/Program.cs`'s `DumpAbstractMembers`
  directly resolves this: it walks `DeclaredOnly` properties at EVERY
  level of the hierarchy and logs each level's ORIGINAL abstract
  declaration, without checking whether an INTERMEDIATE level (here,
  `OrbModel` itself) already overrode it concretely. So the sweep's
  report for this one member is a false positive — `OrbModel` almost
  certainly already provides a concrete default, and `MoonOrb` correctly
  doesn't need to touch it. This is a real, now-understood limitation of
  that specific sweep (not a general problem — it correctly found every
  other required override, including this same Orb's other 3 members).
  Noted here in case a future round hits similar-looking "sweep says
  abstract, real example doesn't override it" contradictions — the real
  compiled example is the tie-breaker, always.
- **`PlayerCmd.AddPet`'s real signature is STILL unconfirmed** — only the
  compiler-generated async state-machine names
  (`PlayerCmd+<AddPet>d__14\`1` / `PlayerCmd+<AddPet>d__15`, suggesting
  possibly a generic + non-generic overload pair) are visible; `PlayerCmd`
  itself was never directly dumped. This remains the one gap blocking
  real Pet codegen — the pet's own Monster class shape is now fully
  confirmed, but not how a character actually attaches one to a run.
- **`OstyCmd` and `BaseLib.Abstracts.CustomPetModel` are STILL not deep-
  dumped** — both appeared only in the round-11 name-sweep list, never
  individually reflected. `CustomPetModel` matters less now (confirmed
  real pets don't use it), but `OstyCmd` may be relevant to how
  `PlayerCmd.AddPet` is invoked internally.
- **`Player.BaseOrbSlotCount`'s seeding mechanism is STILL unconfirmed**
  — re-checked `CharacterModel`'s full real abstract-member list in this
  new output (`NameColor`/`Gender`/`UnlocksAfterRunAs`/`StartingHp`/
  `StartingGold`/`CardPool`/`RelicPool`/`PotionPool`/`StartingDeck`/
  `StartingRelics`/`AttackAnimDelay`/`CastAnimDelay`/
  `GetArchitectAttackVfx()`/`ShouldReceiveCombatHooks` — nothing
  orb-slot-related). Item 13 (orb slots base) stays open.

### The result: real Orb codegen shipped this round

With a genuine working reference confirming the exact shape, Orbs moved
from data-capture-only to real, compiling C# — see "Real Orb codegen"
below. Pets stay data-capture-only; the gap is now much narrower and
precisely pinpointed (`PlayerCmd.AddPet`'s signature) rather than "no
mechanism found at all."

### Verification

Structural only (no `dotnet` SDK in this sandbox, same limitation as
every prior round) — this round didn't touch `tools/reflect-baselib/
Program.cs` itself (Tyler ran the existing round-12 build with a
corrected file path), so no new tool code needed re-verifying; the
findings above were cross-checked directly against
`tools/reflect-baselib/Program.cs`'s own source for the
`ShouldReceiveCombatHooks` discrepancy specifically, rather than assumed.

## Real Orb codegen: Orbs now compile to a real CustomOrbModel subclass

Directly enabled by the round 11/12 corrected re-run above. Orbs move
from "data capture only, exported as a design doc" to "real numeric
overrides compile, behavior is still a design note" — the same category
of honest partial-completion Cards' `OnDiscard`/`OnTurnEndInHand`
triggers already use (real hook, Todo-fallback body).

- **`backend/templates/Orb.cs.template`** (new) — `public sealed class
  {{className}} : CustomOrbModel` with exactly 3 real overrides:
  `PassiveVal`/`EvokeVal` (decimal, from the new schema fields) and
  `DarkenedColor` (Godot.Color, `[BEST EFFORT]` reusing the character's
  own accent color — no orb-specific color field exists yet).
  `Passive()`/`Evoke()`/`AfterTurnStartOrbTrigger()` deliberately NOT
  overridden — MoonOrb overrides these for its own custom behavior, but
  Forge has no effect editor for orb hooks yet, and (unlike
  `OnUpgrade`/`OnDiscard`'s `ForgeActions.Todo(...)` fallback elsewhere)
  a throwing stub here would crash combat every single turn this orb
  sits in a slot, since `Passive()` is a core always-on loop, not an
  edge-case hook — leaving it un-overridden (inheriting whatever
  `OrbModel`'s own default does, most likely a harmless no-op given every
  built-in orb individually overrides it) is the safer failure mode.
- **`schema/character.schema.json`** — orb gained `passiveValue`/
  `evokeValue` (real, numeric, wired to the two confirmed overrides);
  `baseValue` kept for backward compat as their fallback default (old
  entries only ever captured one shared magnitude); `passiveText`/
  `evokeText`/`focusScales` all explicitly re-documented as still
  freeform/uncompiled.
- **`backend/compiler.js`** — new `generateOrbSource(orb, namespace,
  colorHex)`, wired into `generateProject()`'s write loop (one
  `Orbs/<OrbName>Orb.cs` per orb, same pattern as Cards/Relics/Powers).
  `buildOrbsReadme` rewritten to describe the new split state (numbers
  real, behavior still a note) instead of "nothing compiles yet."
- **`backend/validate.js`** — `passiveValue`/`evokeValue` get real
  numeric validation (same bar every other compiled numeric field gets);
  `baseValue`/`focusScales` keep their existing shape-only checks.
- **Frontend** — orb editor gained two labeled "(compiled)" number
  inputs for Passive/Evoke value, with a rewritten panel banner
  distinguishing what's now real from what's still a design note; the
  orb tile's meta line and the 06 Orbs section's own description were
  both updated to stop saying "not yet compiled into your mod's code."

### Verification

`node --check` on `backend/compiler.js`/`backend/validate.js`; schema
JSON re-parsed; brace/paren balance on `Orb.cs.template` (11/11 braces,
20/20 parens); `validateCharacterPackage()` tests (valid orb accepted,
non-numeric `passiveValue` rejected); a direct `generateProject()` test
confirming real codegen —
```
public override decimal PassiveVal => 2m;
public override decimal EvokeVal => 8m;
public override Color DarkenedColor => new Color("#3355ff");
```
— for an orb with `passiveValue: 2, evokeValue: 8`, and confirming the
`baseValue`-only fallback produces matching `PassiveVal`/`EvokeVal` for a
character saved before this round. A combined smoke test (character +
tagged card + status-stacks-scaling action + real orb, all in one
package) validated and generated cleanly end to end, confirming this
round's Orb work doesn't interact badly with anything else added this
session. Frontend verified with Playwright: the new Passive/Evoke value
inputs render and default correctly (falling back to a legacy
`baseValue` when present), and saved values round-trip into
`state.orbs[].passiveValue`/`evokeValue` correctly.
correctly.

## Round: "Art items" — unified Character & Art section (Tasks #9–#13, #17, #18)

Tyler: *"Lets move on to the art items next."* This covers items 2, 3, 4,
5, 7, 8, 9, 10, 11, 16, and 18 from Tyler's original 18-item list —
everything art/lore-related except the freeform drag-and-drop layout
editor (item 6 / Task #20, explicitly deferred) and the character/pet art
animation option (item 17 / Task #19, explicitly deferred).

### What was actually there before this round

Before touching anything, worth being honest about what the old "07 Art"
section actually did: almost nothing. `portrait-upload` had zero
change-handler wiring anywhere in the JS. `orb-layer-inputs` (the div
meant to hold 5 file inputs for custom orb layers) was never populated —
the container existed, nothing filled it. `compiler.js`/`validate.js`
never read `assets[]`, `portrait`, or `orbLayer` at all. This round is
mostly new construction from a stub, not extending something that
half-worked.

### What changed

**`frontend/index.html`:**
- Deleted the old standalone `<section id="section-art">` (07 Art) block
  entirely — its `portrait-upload`/`orb-mode`/`orb-layers`/
  `orb-layer-inputs` markup is fully superseded by the merged section
  below (kept both around briefly would have meant duplicate DOM ids).
- Replaced `<section id="section-character">` (01 Character) with a
  merged **"01 Character & Art"** section using the existing
  `.editor-grid`/`.editor-form`/`.editor-preview` two-column layout
  (previously only used inside the card editor modal, now used directly
  in the page body). Left column: Name/Description/Color/Gender/Target
  branch/MaxHP/Gold/Energy/Lore. Right column: Portrait upload+preview,
  character-select mini-preview tile (reuses the same portrait, smaller
  frame), Energy orb (mode select + clickable circular preview that
  opens a per-layer editor + show/hide-stars checkbox + conditional star
  upload), Hand art (4 slots, exactly 422×1200px each), and an in-game
  placeholder preview (two CSS-gradient "scene boxes" — Combat/Rest site
  — with the portrait overlaid, explicitly labeled as Forge-generated
  placeholders, not real game art).
- New CSS block: `.art-preview-frame`, `.art-placeholder`,
  `.char-select-tile`, `.energy-preview-wrap`/`.energy-preview`/
  `.energy-preview-inner`, `.energy-star`/`.fallback`, `.star-toggle`,
  `.hand-art-grid`/`.hand-art-slot`/`.hand-art-frame`, `.scene-row`/
  `.scene-box`/`.scene-combat`/`.scene-rest`, `.lore-entry`,
  `.layer-edit-row`/`.layer-edit-swatch`.
- New JS (all under the `/* ---- art assets ---- */` block): generic
  `findAssetDataUrl(assetRef, kind)`/`commitAsset(dataUrl, existingRef,
  kind)` helpers generalizing the pattern the card-art upload already
  established, then per-feature wiring: portrait upload+preview+clear
  (mirrors into both the main frame and the character-select tile),
  scene preview binding (mirrors the portrait into both scene boxes),
  energy orb preview rendering (flat color for buildFromColor, a plain
  note for the Ironclad default, a rough 5-ring stacked approximation
  for customLayers) plus a click-to-open per-layer editor modal
  (`openOrbLayerEditor`, 5 rows, Color/Image toggle per layer, 256×256px
  enforced on image uploads), show/hide-stars checkbox + star upload,
  hand-art 4-slot upload+422×1200px validation+preview+clear, and lore
  entry list add/remove/edit (title+text, flavor-only).
- `blankState()` gained `character.branch`, `character.portraitAssetRef`,
  `character.showEnergyStars`, `character.starAssetRef`,
  `character.handArt{point,rock,paper,scissors}`, `character.lore[]`,
  and restructured `character.orb.layers[]` (5× `{mode,color,assetRef}`)
  replacing the old flat `orb.layerAssetRefs[]`.
- `migrateLegacyStatusActions` gained a **v6 → v7** migration: every new
  field above gets a safe default if missing; `orb.layerAssetRefs[]`
  (if present) is converted positionally into `orb.layers[]` (each old
  ref becomes an `'image'` row carrying the same asset id forward,
  nothing already uploaded is lost; missing slots up to 5 become
  `'color'` rows). `pkg.formatVersion` now ends at `7`.

**`schema/character.schema.json`:**
- Added `branch`, `portraitAssetRef`, `showEnergyStars`, `starAssetRef`,
  `handArt{point,rock,paper,scissors}`, `lore[]`, and rewrote `orb` to
  document `layers[]` (with `layerAssetRefs[]` kept, marked superseded,
  for anyone reading an old saved package's shape).
- Extended the top-level `assets[].kind` enum with `'star'` and
  `'handArt'` (previously only `portrait`/`orbLayer`/`cardArt`/
  `relicIcon`).
- **Unrelated fix caught while in this file**: the top-level `orbs[]`
  array description still said "DATA-CAPTURE ONLY... no reflect-baselib
  round has reflected the real base class" — stale, left over from
  before the Real Orb Codegen round earlier this session. Corrected to
  match what `definitions/orb` already said (passiveValue/evokeValue
  compile for real now).
- **No changes to `backend/compiler.js`/`backend/validate.js`** —
  character-level art was never read by either before this round and
  still isn't; every new field is a design-time preview only, same
  honesty convention already established for card art, Pets, and Orbs'
  passive/evoke text. Confirmed by a `generateProject()`/
  `validateCharacterPackage()` smoke test against a package using every
  new field (customLayers orb, lore entries, branch, showEnergyStars) —
  compiled cleanly, no new fields touched.

### A real bug found and fixed during verification

The energy-orb preview circle uses `overflow:hidden` to clip its stacked
layer `<div>`s to a circle. The star badge is deliberately positioned
*outside* that circle (`top:-6px; right:-6px`, so it reads as an overlay
badge, not part of the orb art) — but as a child of the same clipped
element, it was being clipped along with everything else and never
rendered at all (confirmed via Playwright: the `.energy-star.fallback`
element existed in the DOM with the right text, but a pixel crop of that
screen region showed nothing there). Fixed by splitting the clipping
into a new `.energy-preview-inner` wrapper (the layers/placeholder live
inside it, clipped) while the star stays a direct, unclipped child of
`.energy-preview` itself. Re-verified with a pixel crop after the fix —
the star (or uploaded custom star image) now renders correctly in the
top-right corner.

### Verification

`node --check` on the extracted inline script (syntax-clean); div/section
tag-balance check (172/172, 6/6); duplicate-DOM-id sweep (only
pre-existing, expected duplicates from reused modal templates — e.g.
`m-name`/`m-rarity` shared between card/relic/mechanic editors, never
simultaneously in the DOM); `grep` sweep confirming no leftover
`#orb-layers`/`#orb-layer-inputs`/`section-art` references anywhere.
Backend: `validateCharacterPackage()` + `generateProject()` against a
package exercising every new field — valid, compiled cleanly, output
file list unchanged from before this round (art fields aren't read).
Frontend: a full Playwright pass (a static file server, since `npm
install` was blocked from the registry this session — see note below)
covering portrait upload+preview+character-select-tile+scene-preview
mirroring, energy orb mode switching, the per-layer editor modal (5 rows
render, mode toggle, color edit, save round-trips), show/hide-stars +
the clipping bug fix above, hand-art upload with both a valid
422×1200px image (accepted) and an invalid 400×400px image (rejected
with the exact expected error message, nothing silently accepted),
lore entry add/remove, and a full page reload confirming every new field
(`branch`, `lore`, `orb.layers`, `handArt`, `showEnergyStars`) persists
through `localStorage` at `formatVersion: 7` — i.e. the v6→v7 migration
runs correctly and is idempotent on reload.

**Environment note**: this session's `npm install` (for `backend/`'s
`express`/`archiver`) got a `403 Forbidden` from the npm registry this
round — a change from earlier in the session, where installs worked.
Backend logic itself was still fully verified directly via `node -e`
(`validateCharacterPackage`/`generateProject`, no server needed); the
frontend Playwright pass served `frontend/index.html` with a plain
`python3 -m http.server` instead of the real Express backend, so
`fetch('/api/...')` calls (game-path status, compile) 404'd as expected
in the console log — harmless for what this round needed to verify,
since none of the new art code touches those endpoints.

## Round: art field breakdown — 7 new dedicated art slots (Tasks #24–#33)

Tyler followed up on the "art items" round with a much more precise
breakdown of exactly what art the character needs, each with a real
required size:

> Portrait (256×256), Body Sprite (512×512, the real in-game model, one
> of 2 images overlaid on a static background), the 4 hands (unchanged),
> HUD icon (88×88, shown while traversing the map), Select screen art
> (132×195, like a portrait but for the character-select screen), Select
> screen background (1280×720), optional Campfire art (512×512, the
> second overlay image, character sitting at a campfire), optional Shop
> sprite (512×512), and the energy/star icons — import Ironclad's default
> energy icon layers as a placeholder, click to swap each layer for a
> 256×256px image or a color; star defaults to the Regent's star icon,
> swappable to a 64×64px custom image, shown/hidden by the existing
> checkbox. *"Work on adding the fields for now and we will move them
> around after."*

### What changed

**Portrait redefined.** Previously unconstrained and reused for 3 things
(the character-select tile, the combat scene overlay, the rest-site scene
overlay). Now: exactly 256×256px, enforced on upload, and a genuinely
standalone field — it no longer feeds anything else, since those 3 uses
each got their own dedicated, correctly-sized field below.

**6 brand-new character-level art fields**, `bodySpriteAssetRef` /
`hudIconAssetRef` / `selectScreenArtAssetRef` /
`selectScreenBackgroundAssetRef` / `campfireArtAssetRef` /
`shopSpriteAssetRef`, each with its own upload input, exact-dimension
enforcement (rejected outright with the exact mismatched size shown, same
convention as every other dimension-checked upload in this app), and
preview frame. `character.starAssetRef`'s upload also gained the same
64×64px enforcement it never had before.

**Two fields feed the existing overlay previews, replacing portrait
there**: Body sprite (the real in-game model) is what overlays the
combat scene placeholder; Campfire art (explicitly optional) overlays the
rest-site scene placeholder, falling back to Body sprite when left unset
(a rest-site preview with SOME model shown is more useful than a blank
box, and Campfire art not existing yet doesn't mean the character itself
doesn't). Select screen art now drives the existing character-select
mini-preview tile (previously just a passive mirror of the portrait —
this is a much better fit for what that tile was always meant to show,
now with its own correctly-sized 132×195px upload instead of stretching
whatever portrait happened to be uploaded).

**Energy orb now defaults to a seeded, Ironclad-style placeholder.**
`orb.mode` defaults to `'customLayers'` (was `'buildFromColor'`) and
`orb.layers[]` is pre-populated with a 5-color red/orange gradient
(`IRONCLAD_PLACEHOLDER_LAYER_COLORS` in `frontend/index.html`) instead of
5 blank circles — a brand-new character's orb preview now actually looks
like something on first load. **Important honesty note, called out in
both the code comment and the schema**: this is a Forge-generated
*approximation* using Ironclad's known red/orange palette, NOT the real
extracted Ironclad energy-orb PNG layers — those live in the game's own
asset files and aren't available anywhere in this project to "import."
Every layer is still fully swappable to a real 256×256px image or a
different color via the existing per-layer editor (unchanged from the
previous round — click-to-edit was already available regardless of
mode). Same honesty treatment for the star icon: the label now says it
"defaults to a plain star placeholder, not the real Regent asset" rather
than implying a real extracted icon is included.

**Migration**: existing (already-migrated v7) characters are NOT
retroactively re-seeded with the new Ironclad-placeholder colors — that
seed is `blankState()`-only, for genuinely brand-new characters. Silently
repainting an existing character's already-customized orb on migration
would change how it looks without Tyler asking for that; the new
`formatVersion 7 -> 8` migration only adds the 6 new asset-ref fields
(defaulting to `null`) and otherwise leaves an existing character
untouched.

**A new `wireArtField()` helper** in `frontend/index.html` generalizes
the upload → FileReader → exact-dimension-check → commitAsset → preview
pattern that was previously hand-duplicated per field (card art, hand
art, orb layers) — now used for all 8 fixed-dimension character art
slots (Portrait, Body sprite, HUD icon, Select screen art, Select screen
background, Campfire art, Shop sprite; Star icon keeps its own handler
since it's conditionally shown/hidden by the stars checkbox rather than
always visible). Reduces ~8 near-identical blocks to one shared function
plus one short call per field.

**Deliberately NOT done this round**, per Tyler's own framing ("we will
move them around after"): no attempt to redesign the overall layout of
the art column now that it holds 8+ upload fields — everything was added
in the most straightforward position within the existing column, with
the explicit expectation that arrangement is a separate, later pass. Also
did not build a composited "select-screen-art-over-background" preview
(unlike the combat/rest overlay, which already existed from last round
and was a natural, low-risk rewire) — Select screen art and Select screen
background are each their own simple standalone preview for now.

### Schema/state changes

`schema/character.schema.json`: 6 new `character.*AssetRef` properties
(all `["string","null"]`, all documented as design-time-preview-only,
each noting its required dimensions and, where relevant, which existing
preview it feeds); `assets[].kind` enum extended with `bodySprite` /
`hudIcon` / `selectScreenArt` / `selectScreenBackground` / `campfireArt`
/ `shopSprite`; `orb.mode`/`orb.layers` descriptions updated to document
the new Ironclad-placeholder default and cross-reference
`IRONCLAD_PLACEHOLDER_LAYER_COLORS`. No `backend/compiler.js`/
`backend/validate.js` changes — same as every character-art field before
it, none of this is read at compile time.

### Verification

`node --check` on the extracted inline script; div/section tag-balance
check (190/190, 6/6); a Python cross-reference confirming every
`getElementById(...)` call in the script resolves to a real `id="..."`
in the HTML (catches typos between the two — none found). Backend:
`validateCharacterPackage()` + `generateProject()` against a package
exercising every new field (all 6 new asset refs set, customLayers orb
with the new default palette) — valid, compiled cleanly, output file
list unchanged. Frontend: a full Playwright pass covering every one of
the 8 dimension-enforced fields — an intentionally-wrong-size upload
first (confirmed rejected with the exact mismatched-dimensions message,
nothing silently accepted) followed by a correct-size upload (confirmed
accepted and rendered); confirmed the combat scene overlay pulls from
Body sprite and the rest-site overlay pulls from Campfire art (both
verified by comparing the rendered `<img src>` against the actual
`state.assets[]` `dataUrl`, not just "an image appeared"); confirmed
clearing Campfire art falls the rest-site overlay back to Body sprite;
confirmed a brand-new character's `orb.mode`/`orb.layers` matches the new
Ironclad-placeholder default exactly; confirmed every new field
round-trips through `localStorage` at `formatVersion: 8` after a full
page reload.

## Round: real campfire background art + measured character-overlay position (Task #35)

Tyler placed 3 real art assets directly in his `CharProject` folder
(outside `sts2-builder/`, alongside it) — `CampfirePlaceholder.png`
(585×465), `CampfireAvailableSpace.png` (725×472, the same scene with a
white square marking where a seated character belongs), and
`CombatPlaceholder.png` (852×530, not used this round — see below):

> "the campfire placeholder image will be the background if they upload
> a sitting version of their character. the campfireavailablespace image
> is roughly the same, but places a white square where the character is
> expected to sit. ultimately, i would like to hide the campfire scene
> unless the user decides to upload a sitting image, then it will
> display their sitting image in the correct spot on the placeholder
> campfire image."

### The measurement problem, and how it was actually solved

The two campfire images are NOT the same canvas size (585×465 vs
725×472) or the same crop framing (`CampfireAvailableSpace.png` is a
wider shot revealing more of the scene on both sides — visually
confirmed by rendering both images). This means the white square's pixel
coordinates in `CampfireAvailableSpace.png` do NOT translate directly
onto `CampfirePlaceholder.png` — using them as-is would have put the
character overlay in the wrong spot.

Solved with real image measurement, not eyeballing:
1. **Feature-matched the two images** with OpenCV ORB descriptors (the
   white square itself was masked out of the source image first so it
   couldn't pollute the descriptor set), then fit a similarity transform
   (`cv2.estimateAffinePartial2D`, RANSAC) between the two coordinate
   systems — 27/39 matches were inliers.
2. **Sanity-checked the fit independently**: computed the campfire
   flame's pixel centroid separately in both images (thresholding for
   bright cyan/white pixels, nothing to do with the feature-matching
   step) and confirmed the fitted transform maps one onto the other
   within ~1.3px. The fit came out to essentially uniform scale 1.004
   (i.e., both images are the SAME pixel scale, just different crop
   windows) with a small (+13, +11) translation and negligible rotation
   — consistent with "same source art, two different crop exports," not
   a real camera/perspective change (an earlier attempt using a full
   8-DOF homography instead of a 4-DOF similarity transform produced a
   wildly overfit result that mapped the white square to off-canvas
   negative coordinates — discarded in favor of the lower-DOF, better-
   sanity-checked fit once the flame-centroid check exposed the
   discrepancy).
3. **Detected the white square's bounding box** in `CampfireAvailableSpace.png`
   directly (thresholding for near-pure-white pixels: x 80–233, y
   96–248), then mapped its 4 corners through the fitted transform into
   `CampfirePlaceholder.png`'s own pixel space, and expressed the result
   as a percentage of that canvas: **left 16.14%, top 22.51%, width
   26.54%, height 33.18%**.
4. **Visually verified** by drawing that exact percentage box onto
   `CampfirePlaceholder.png` and rendering it — it lands squarely on the
   log's sitting surface, exactly where a seated character belongs.

### What changed

- `frontend/assets/campfire-placeholder.png` (new — a real bundled
  static asset, served by the existing `express.static(frontend/)`
  mount in `backend/server.js`; no server changes needed). This is the
  first REAL (non-CSS-gradient, non-user-uploaded) art asset shipped
  with Forge itself.
- `.scene-box.scene-rest` (CSS): background switched from a CSS-gradient
  guess to `background-image:url('assets/campfire-placeholder.png')`,
  and `aspect-ratio` changed from the shared `4/3` to the real PNG's own
  `585/465` — this match is REQUIRED, not cosmetic: a mismatched
  container ratio would make `background-size:cover` crop the image,
  which would throw off the measured %-position below (it was measured
  against the full, uncropped canvas).
- `.scene-box.scene-rest img#scene-rest-img` (new CSS rule, overrides
  the generic centered-at-bottom `.scene-box img` rule via selector
  specificity): the measured `left:16.14%; top:22.51%; width:26.54%;
  height:33.18%` absolute position.
- `#scene-rest-box` (new id on the existing rest-site `<div>`) +
  `renderScenePreview()` rewritten: the whole box now starts
  `display:none` and only becomes visible once `campfireArtAssetRef` is
  set — not just "empty," genuinely hidden, per Tyler's explicit ask.
  **The body-sprite fallback added in the previous round is REMOVED** —
  Tyler was explicit that an unset Campfire art should hide the rest
  scene entirely, not show a stand-in.
- `schema/character.schema.json`: `campfireArtAssetRef`'s description
  updated to match (removed the now-incorrect "falls back to
  bodySpriteAssetRef" line, documented the real measured-position
  mechanism instead).

**Not done this round, deliberately flagged rather than silently
expanded**: `CombatPlaceholder.png` (852×530) is also sitting in the
`CharProject` folder, clearly named to parallel `CampfirePlaceholder.png`,
but Tyler's message only described the campfire treatment. There's no
`CombatAvailableSpace.png` counterpart to measure a Body-sprite overlay
position from, so Combat's scene box is UNCHANGED this round (still the
CSS-gradient placeholder). Flagged to Tyler as a natural next ask if he
wants the same real-background + measured-position treatment there.

### Verification

`node --check` on the extracted inline script; div/section tag-balance
(190/190, 6/6); JSON schema re-validated. Backend:
`validateCharacterPackage()`/`generateProject()` smoke test — unaffected
(campfire art was never compiled, still isn't). Frontend: Playwright
confirmed (a) the rest-site box is `display:none` (both inline and
computed) on a fresh character with no campfire art, (b) the real
background image URL loads (`getComputedStyle(...).backgroundImage`
resolved to the actual `assets/campfire-placeholder.png` URL, not a
gradient), (c) uploading a bright-magenta 512×512 test image made the
box visible and rendered the overlay at the measured position — a
screenshot crop confirms the magenta square lands exactly on the log's
sitting surface, matching the earlier standalone verification render,
and (d) clearing the Campfire art hides the box again.

## Round: Remove in-game scene compositing; combine Select Screen Art + Background (2026-08-18)

Tyler's message: "i have removed the combat placeholder image. I no longer
want to do a preview of the character in game since that is easy enough to
see. Instead I want to just have the character's body sprite be visible
with the transparent background... I would like to adjust the character
portion though to have overlapping elements similar to this [mockup
screenshot]."

**Interpretation flagged to Tyler**: "not worry about mapping it to a
background" was read as a general policy statement, not Combat-specific,
so it was applied to BOTH the Combat scene preview AND the just-built
Campfire-art-on-real-background compositing from the previous round (not
just the Body sprite / Combat pairing he named explicitly). If that's
wrong and he wants the Campfire compositing kept, it's a straightforward
revert — the measured position (16.14%/22.51%/26.54%/33.18%) is still
recorded above and the code is a small, self-contained diff.

### What changed

- **Removed entirely**: `.scene-row`/`.scene-box`/`.scene-box.scene-combat`/
  `.scene-box.scene-rest`/`.scene-box.scene-rest img#scene-rest-img`/
  `.scene-box .scene-label` CSS; the `renderScenePreview()` JS function and
  its explanatory comment block; its two `onChange` hooks on the
  `bodySpriteAssetRef`/`campfireArtAssetRef` `wireArtField()` calls; its
  call-site in the init block. No more Combat CSS-gradient placeholder, no
  more Rest-site campfire-background compositing.
- **Body sprite** and **Campfire art**: now plain standalone
  `.art-preview-frame` previews (same pattern as Portrait/HUD icon/Shop
  sprite) — whatever's uploaded is shown as-is, transparent background and
  all, no positional mapping onto anything. Label copy updated to match.
- **Select Screen Art + Select Screen Background merged**: previously two
  separate fields with two separate preview frames; now one `#select-bg-frame`
  (1280×720 background) with the 132×195 art (`#char-select-tile`, reusing
  the existing `.char-select-tile` styling but absolutely positioned inline)
  nested inside it, overlapping per Tyler's own mockup. `renderCharSelectTile()`
  (pre-existing function, unchanged) already targeted the right element ids,
  so no new JS was needed for the composite itself — only the HTML structure
  changed.
- **Measured the overlap position from Tyler's own mockup screenshot**
  (same rigor as the earlier campfire measurement, different technique):
  masked nothing this time — instead used color-distance thresholding
  against `--border-soft` (#375a82) plus connected-component analysis to
  find the real `#select-bg-frame`-equivalent bordered box in his 1517×641
  screenshot (found at x:[619–1442] y:[100–593]), then found his annotated
  overlap box's position within that frame as percentages:
  `left:2.1%; top:44.6%; width:20.4%; height:52.5%`.
- **Bonus bug found + fixed while investigating**: `.editor-preview` was
  not respecting its `flex:0 0 320px` inline override — a flex item's
  default `min-width:auto` let child content (native `<select>`/
  `<input type=file>` rendering) force it wider (measured 390px instead of
  320px in a from-scratch Playwright repro at 1517px viewport before the
  fix). This is almost certainly why Tyler's own screenshot showed an even
  more dramatically stretched right column than my reproduction — likely a
  wider native form-control rendering on his OS/browser. Fixed with
  `min-width:0` on `.editor-preview`.
- `schema/character.schema.json`: rewrote `bodySpriteAssetRef` and
  `campfireArtAssetRef` descriptions to remove the now-false "overlaid
  on..." language; documented the new Select Screen composite mechanism on
  both `selectScreenArtAssetRef` and `selectScreenBackgroundAssetRef`.

**Left as-is, flagged rather than silently cleaned up**:
`frontend/assets/campfire-placeholder.png` (the real background art
delivered and committed to Tyler's folder last round) is now unreferenced
by any CSS, since the compositing that used it was removed. There's no
tool available in this session to delete files already committed to
Tyler's local folder via the device bridge (`device_bash` explicitly can't
`rm`), so it will sit there unused unless Tyler deletes it himself or asks
for the Campfire compositing to come back (in which case it's needed
again).

### Verification

`node --check` on the extracted inline script — OK. div/label/section/
span/button tag-balance — all matched (190/190 div, 56/56 label, 6/6
section, 53/53 span, 39/39 button). `getElementById` cross-reference
against every `id="..."` in the HTML — no missing ids. JSON schema
re-validated as valid JSON. Backend: `validateCharacterPackage`/
`generateProject` modules load and export unchanged (character art was
never compiled, still isn't — unaffected by this round). Frontend:
Playwright (static server, real backend still blocked by the ongoing npm
403) confirmed — zero `.scene-row`/`.scene-box` elements remain in the
DOM; `#body-sprite-frame` and `#campfire-art-frame` have no
`background-image` (plain standalone frames, confirmed); `.editor-preview`
computed width is exactly `320px` (bug fix confirmed); the
`#select-bg-frame`/`#char-select-tile` composite measured out to
left≈2.70% top≈44.71% width≈20.14% height≈51.33% against a target of
2.1%/44.6%/20.4%/52.5% — small deltas are expected (the tile's own 2px
border is included in `boundingBox()` measurements, inflating width/height
slightly), well within visual tolerance. No new console errors from the
removed elements; the only console/network errors present (Google Fonts
blocked by sandbox network, `/api/game-status` 404) are both pre-existing
artifacts of the static-server verification workaround, unrelated to this
round's changes.

## Round: Campfire preview restored; Character panel split text/pictures; click-to-upload boxes (2026-08-18, same day follow-up)

Tyler, immediately after the previous round: "I still want to keep the
campfire preview feature since getting to the campfire section of the
game is tedious to do for testing. The new bundled select screen pictures
should be the main focus of the character panel, with it taking up the
right half of the box. I also want to get rid of the upload pictures
buttons and have the user click on the box that the pictures would go in
instead. This means that the character section should be split in half,
with the left half being the text-based information, and the right half
being pictures."

Three real, distinct asks in one message:

### 1. Campfire compositing restored (partial revert of the previous round)

The real `campfire-placeholder.png` background + the measured
seated-character overlay position (`left:16.14% top:22.51% width:26.54%
height:33.18%` of the 585×465 canvas — see the earlier OpenCV
feature-matching round above) is back. **Not** restored as a separate
"in-game preview" row like the original implementation — it now lives
directly on the Campfire art field's own preview box
(`#campfire-art-frame`), reusing the same element the upload now happens
through. This was a deliberate adaptation, not a like-for-like revert:
the box can no longer start `display:none` (hidden until an image is
uploaded, per Tyler's original campfire request from two rounds ago)
because it now ALSO has to be the clickable upload target — a hidden box
can't be clicked. The real background art shows always now (it's bundled
with the app, nothing user-specific to hide there); only the uploaded
character overlay is conditional on `campfireArtAssetRef` being set.
**Combat's scene preview was NOT restored** — Tyler only asked for
campfire back, and there's still no `CombatAvailableSpace.png` reference
to measure a position from (see the earlier round's note on this — still
true, still unrequested).

### 2. Character panel split: left = text, right = pictures, Select Screen composite as hero

New `.char-panel-grid`/`.char-panel-text`/`.char-panel-art` classes,
deliberately separate from the existing `.editor-grid`/`.editor-form`/
`.editor-preview` trio the card editor MODAL elsewhere in this file also
uses — reusing those classes here would have changed the modal's layout
too, which wasn't asked for. Left column: Name/Description/Color/Gender/
Target branch/Max HP/Starting Gold/Energy/Lore (unchanged content, just
recontainered). Right column: the Select Screen composite sits at the
top as a full-width hero image (`.art-hero`, matches the artColumn's own
width, confirmed via Playwright: hero width == art column width, both
512px at a 1517px viewport), then a `.art-thumb-grid` (2-column grid)
below it holding Portrait/Body sprite/HUD icon/Campfire art/Shop sprite
as smaller boxes, then Energy orb + star toggle + Hand art below that.

**Interpretation flagged**: Tyler's message can be read two ways — "select
screen takes up the ENTIRE right half, other art fields go somewhere
else" vs. "the right half is the whole pictures column, and select screen
is just the largest/first thing in it." Went with the second reading,
since his own very next sentence explicitly redefines the split as
"right half being pictures" (plural — all of them), which only makes
sense if the right half holds every art field, not just one. If the first
reading is what he actually wanted, it's a straightforward change: move
the thumb-grid fields out from under `.char-panel-art` into their own
row below the two-column grid instead.

### 3. Click-to-upload boxes, no more visible upload buttons

Every `<input type="file">` for a fixed-dimension art field (Portrait,
Select Screen Art, Select Screen Background, Body sprite, HUD icon,
Campfire art, Shop sprite, all 4 Hand art poses) is now visually hidden
(new `.art-upload-input` class — 1×1px, `overflow:hidden`, NOT
`display:none`, so it still receives a programmatic `.click()` from a
real event-driven call the same as before) rather than removed — every
existing `wireArtField()`/hand-art `change` listener is unchanged, only
the file input's visibility changed. `wireArtField()` gained an optional
`frameId` param: when present, clicking that DOM element calls
`uploadEl.click()` (with `stopPropagation()`, since Select Screen Art's
frame — `#char-select-tile` — nests INSIDE Select Screen Background's own
clickable frame; without stopping propagation, clicking the small art
tile would also bubble up and open the background's file picker). Hand
art frames got the same treatment via a small dedicated click-wiring loop
in `renderHandArtGrid()` (not using `wireArtField()`, since hand art was
already custom-coded outside that helper). Added a `.art-click-hint`
overlay (dark scrim + "Click to change" text) that fades in on `:hover`
for every clickable box, so the interaction stays discoverable now that
there's no visible button telling the user what to do. "Remove" buttons
were NOT touched — Tyler only asked to drop the upload buttons, removal
stays a small explicit button below each box.

**Not converted to click-to-upload**: the Star icon file input (still a
plain, visible `<input type=file>`). There's no dedicated preview "box"
for the star the way every other field has one — it only ever shows as a
small badge overlaid on the energy orb circle, and that circle already
has its own click handler (opens the orb layer editor modal). Making the
badge itself clickable-for-upload would either conflict with that or need
a second small hit-target sitting on top of the orb preview, which felt
like a worse interaction than just leaving its one remaining plain file
input in place. Flagged as a scope call, not an oversight.

### Verification

`node --check` on the extracted inline script — OK. div/label/section/
span/button/input tag balance — all matched (204/204 div, 54/54 label,
6/6 section, 53/53 span, 39/39 button, 39/39 input — void elements
counted as self-closing). `getElementById` cross-reference against every
literal `id="..."` in the HTML — no missing ids (hand-art's per-pose ids
are template-generated at runtime and correctly excluded from this
static check). JSON schema re-validated as valid JSON. Backend
(`validate.js`/`compiler.js`) loads unchanged — this round never touched
backend code. Frontend, via Playwright against the static-server
workaround: zero visible `<input type=file>` elements remain anywhere in
the Character & Art section; clicking `#portrait-frame` reliably opens a
real file-chooser event; `.char-panel-grid`/`.char-panel-text`/
`.char-panel-art` all present with the hero (`#select-bg-frame`) width
matching the art column's own width exactly; `#campfire-art-frame`'s
`background-image` resolves to the real bundled PNG and its aspect ratio
computes to 1.2581 (585/465, matches exactly); uploading a synthetic
512×512 magenta PNG via a direct `change`-event dispatch (bypassing the
real OS file picker, same technique used in earlier rounds) confirmed the
overlay renders at left≈16.68% top≈23.07% width≈26.11% height≈32.51%
against a 16.14/22.51/26.54/33.18 target — small deltas from the
uploaded `<img>`'s own thin border being included in `boundingBox()`
measurements, same known source of slop as the Select Screen composite's
earlier measurement, well within visual tolerance; the Select Screen
composite's own position re-measured at left≈2.47% top≈44.67% against
2.1%/44.6% target, same story. No new console errors — only the same
pre-existing, unrelated Google Fonts network block and `/api/game-status`
404 from the static-server verification workaround.

## Finding: energy orb layer count CONFIRMED as 5 (real, not a Forge guess) — via hand-rolled IL/metadata disassembly (2026-08-18)

Tyler asked how many energy-icon customization layers the real, modifiable
game code exposes, then reported that his own `TheBurdenedNewCharacter.dll`
implements a custom energy icon with 5 layers, and asked whether that's
verifiable from here.

**Short answer: yes, confirmed — 5, with real evidence, not an assumption.**
Forge's own 5-layer energy orb editor (`IRONCLAD_PLACEHOLDER_LAYER_COLORS`,
the per-layer editor) had always been an arbitrary Forge design choice with
NO evidence behind it — reflect-baselib only ever captured `CustomOrbModel`
(a completely different game concept — the in-combat energy ORB used
during a run — from the CHARACTER SELECT/HUD energy COUNTER icon Tyler is
asking about here, which is a different class entirely). This round closes
that gap for real.

### Why standard tooling couldn't answer this

This sandbox has no `dotnet` SDK, no `mono`/`monodis`/`ilspycmd`, and (newly
confirmed this round) **no working package registry access at all** —
`pip install dnfile`/`pefile` and `apt-get install mono-utils` all failed
(403/no distribution found), consistent with the already-documented `npm
install` 403 issue, just now confirmed to be a total package-install
block, not npm-specific. Tyler's real `TheBurdenedNewCharacter.dll` and
`BaseLib.dll`, however, WERE already sitting in this session's uploads
folder from earlier reflect-baselib rounds (`/mnt/user-data/uploads/Slay
the Spire 2/mods/...`) — no `.pck` (Godot resource pack) alongside them,
so actual image assets aren't inspectable, only the compiled C#.

### What was done

Hand-wrote a minimal ECMA-335 (.NET metadata format) parser in pure
Python (stdlib only — `struct`) from scratch this round:
PE header → CLR runtime header (COR20) → metadata root → `#~`/`#Strings`/
`#US`/`#Blob`/`#GUID` streams → compressed table-stream header (row counts,
heap-index widths, coded-index widths computed per ECMA-335 §II.24.2.6) →
per-table row layouts for `TypeDef`/`Field`/`MethodDef`/`Property`/
`PropertyMap`/`MemberRef`/etc. Self-validated by reconstructing each file's
total table-stream byte length from the parsed row counts/sizes and
confirming it lands within a few bytes of the real stream size (matched
exactly for the small file, within 2 bytes for BaseLib.dll — negligible,
consistent with reserved/padding). Caught and fixed one real bug during
development (a `TypeDef.MethodList` column-offset miscalculation that
was misattributing methods to nonsense owning classes, like a property
getter appearing to live inside a compiler-generated `OnPlay` async state
machine — fixed once caught, then re-verified against several methods with
already-known-plausible owners before trusting further results). Also
wrote a minimal tiny/fat IL method-header parser (RVA → method body →
raw opcode bytes) and hand-decoded specific opcode sequences relevant to
this question (`ldstr`, `ldc.i4.*`, `call`, `ldarga.s`, `newobj`) — not a
full disassembler, just enough to read the specific bytes in question.

### The trail

1. `strings` on `TheBurdenedNewCharacter.dll` surfaced `EnergyCounterLayerPath`,
   `get_BigEnergyIconPath`, `get_CustomEnergyCounter`, `get_TextEnergyIconPath`
   — new, not previously captured by any reflect-baselib round (those only
   ever targeted Orbs/Pets/gender).
2. Metadata parse: `EnergyCounterLayerPath` is a real `private` `MethodDef`
   on `TheBurdenedNewCharacter.Characters.TheBurdened` (Tyler's own
   character class), signature `(int) -> string`. IL body decodes to
   `String.Concat("res://images/packed/energy_counters/theburdenednewcharacter_layer_", index.ToString(), ".png")`
   (both string literals read directly from the `#US` heap) — CONFIRMED
   real resource-path-building code Tyler's own character-creator tool
   generated, using a `_layer_{N}.png` naming convention.
3. `get_CustomEnergyCounter`'s IL body builds a `Func<int,string>` bound to
   that method (`ldftn`/`newobj Func<int,string>` pattern), then calls
   `BaseLib.Abstracts.CustomEnergyCounter`'s constructor
   (`MemberRef → BaseLib.Abstracts.CustomEnergyCounter::.ctor`, signature
   decoded to `(Func<int,string>, Color, Color)` — exactly 3 params, ONE
   delegate covering ALL layers, not 5 separate params or an array).
4. Followed that constructor into `BaseLib.dll` itself:
   `BaseLib.Abstracts.CustomEnergyCounter` (TypeDef, confirmed a struct/
   valuetype) has exactly 3 backing fields (`<pathFunc>P`, `OutlineColor`,
   `BurstColor`) and one forwarding method, `LayerImagePath(int) => pathFunc(index)`
   — no stored count anywhere in the mod-facing type itself.
5. Searched the ENTIRE `BaseLib.dll` binary for every raw occurrence of the
   `call`/`callvirt` token bytes for `LayerImagePath` — found **exactly 5**,
   all plain `call` instructions, all inside ONE method:
   `BaseLib.Utils.NodeFactories.NEnergyCounterFactory.FromLegacy` (a static
   method taking a `CustomEnergyCounter` struct). Decoded the `ldc.i4.*`
   constant immediately preceding each of the 5 calls: **1, 2, 3, 4, 5** —
   i.e. `LayerImagePath(1)`, `LayerImagePath(2)`, `LayerImagePath(3)`,
   `LayerImagePath(4)`, `LayerImagePath(5)`, each immediately followed by a
   call to `NEnergyCounterFactory.AddLayer(...)`. This is the ONLY place
   in either DLL that ever calls `LayerImagePath` — no 6th call anywhere,
   no loop with a variable bound, five literal unrolled calls.

### Confidence and caveats

High confidence on the count itself (5, 1-indexed 1 through 5) — it's
directly counted from real compiled bytecode across two independently-
sourced assemblies (Tyler's own mod + BaseLib), cross-consistent (the mod's
own resource-naming convention matches the indices the consumer actually
requests). Two honest caveats: (1) the consuming method is literally named
`FromLegacy` — plausibly an older/compatibility code path rather than
"the" current pipeline, though it's the only call site that exists
anywhere in the assembly, so there's no alternative candidate to compare
against; (2) this is hand-rolled metadata/IL parsing without a real
decompiler double-checking the work — self-validated via the table-length
reconstruction check and a deliberate bug-catch-and-fix pass, but a proper
tool (ILSpy, dnSpy, `dotnet-ildasm`) would be the ideal independent
confirmation if Tyler ever runs one locally.

### What changed

`frontend/index.html`'s `IRONCLAD_PLACEHOLDER_LAYER_COLORS` comment and
`schema/character.schema.json`'s `orb.mode` description both updated to
record this as a CONFIRMED fact rather than an unverified Forge design
choice — Forge's existing 5-layer editor UI needed no functional change,
since 5 already happened to be the number originally guessed at.

## Round: energy icon layer semantics + real measured colors from Tyler's reference screenshots (2026-08-18)

Tyler added 7 real reference images to his `CharProject` folder and
described what they show: `Energy1/2/3.png` (Ironclad's real energy icon,
3 separate screenshots at different moments), `RegentEnergy1/2/3.png`
(Regent's real energy icon + his real default star icon, same idea), and
`AtlasEnergy.png` (a custom moon-themed energy icon + custom moon-themed
star icon, as an example of a fully custom design). His own description
of the 5 real layers: a background, 2 separately-animated/spinning
layers (more visible on Regent's), a glow layer behind the number, and a
small circle layer behind the number for legibility — with the explicit
caveat that he doesn't know which of Layers 1-5 (Forge's own back-to-
front numbering) maps to which of those roles. The numbers themselves are
composited at render time, not part of the 5 layers or the 1 star image.

### What was measured (real pixel analysis, not guesses)

Staged all 7 images from the device via `device_stage_files`, analyzed
with PIL/numpy (no OpenCV needed this round):

- **Regent's default star color, precisely measured**: cyan/blue-dominant
  pixel mask (excluding the white "3" number and dark background) gave
  median RGB (66,205,255) / (66,205,255) / (65,202,255) across the 3
  independent screenshots — essentially identical, hex ≈ `#42cdff`. Shape
  confirmed visually as a 4-pointed sparkle/diamond (not 5-pointed).
- **Ironclad's energy icon colors, precisely measured**: sampled 3 zones
  (outer red gem-facet edge, mid-glow, brightest glow core) across all 3
  screenshots — outer edge `#c03028`, mid-glow `#d66836`, core `#fff6e2`,
  again essentially identical across all 3 independently-cropped frames
  (a strong signal these are real, stable, non-animated color zones, not
  measurement noise).
- **Rotation/animation attempt**: built a polar-coordinate cross-
  correlation (unwrap each frame around the icon's warm-pixel centroid,
  compare angular brightness profiles at several radius bands between
  frame pairs via FFT-based circular cross-correlation) to try to isolate
  "2 separately spinning layers." Result: the outer gem-facet ring looks
  visually identical across all 3 Ironclad frames (same facet pattern,
  same position) and showed ~0° best-fit shift with high correlation
  (0.86-0.98) at every radius band tested — i.e. no rotation was
  detected in the outer shell. Real, visible pixel-level differences DO
  exist between frames, concentrated in the inner glow's mottled/lava-
  like texture (visually confirmed by eye in cropped/upscaled comparisons)
  — consistent with Tyler's "different levels of opacity" observation —
  but the cross-correlation approach couldn't resolve a clean rotation
  angle for that texture, most likely because it's a turbulent/procedural
  pattern rather than a rigid rotating shape (rigid-body rotation
  assumptions don't apply well to that kind of motion), or possibly
  because 3 casual screenshots simply aren't enough temporal samples to
  resolve it. Reported honestly as inconclusive rather than forcing a
  number.
- **Not attempted**: extracting a clean, standalone star or layer PNG
  asset from these screenshots. Both energy icons and both star icons
  have their number baked directly into the screenshot pixels (composited
  by the game, per Tyler's own description) — removing a baked-in number
  cleanly would mean inventing what's actually underneath it, which this
  session's whole standing practice is to avoid. If Tyler can get the
  real, uncomposited asset files out of the game's own `.pck` at some
  point, those could be bundled directly instead of any of this
  measurement-based approximation.

### What changed

- `IRONCLAD_PLACEHOLDER_LAYER_COLORS`: replaced the fully-invented
  5-color gradient from an earlier round (`#7a1f12`...`#f2a541`) with a
  real measured one — the 3 sampled colors above (edge/mid/core) linearly
  interpolated across the 5 layers, back-to-front (`#c03028`, `#cb4c2f`,
  `#d66836`, `#eaaf8c`, `#fff6e2`). Still not a true per-layer
  decomposition (that mapping is unknown, see above) — a color
  approximation of the composited whole, but now anchored to real
  measurements instead of invented from scratch.
- `.energy-star.fallback` color: `#ffd76a` (invented gold) → `#42ccff`
  (measured Regent cyan). Fallback glyph: `★` (5-pointed) → `✦` (4-pointed,
  `U+2726 BLACK FOUR POINTED STAR`) to match the real shape.
- `schema/character.schema.json`: `starAssetRef` and `orb.mode`
  descriptions updated to record these as real measurements with the
  methodology, and to document Tyler's 5-layer conceptual breakdown
  (background/2 spin layers/glow/legibility-circle) without claiming to
  know the Layer-1-through-5 index mapping, since that's genuinely
  unknown.

### Verification

`node --check` on the extracted inline script — OK. JSON schema
re-validated as valid JSON. Playwright screenshot of the energy preview
with "Show stars" checked confirms the new gradient renders (visibly
red-outer to near-white-core, matching the real reference images far
better than the old arbitrary gradient) and the new cyan 4-pointed star
badge renders correctly in the corner. No new console errors — same
pre-existing, unrelated Google Fonts block + `/api/game-status` 404 from
the static-server verification workaround.

## Round: energy icon per-layer roles CONFIRMED + rotation re-test still inconclusive (2026-08-18, follow-up)

Tyler: "in the charproject folder I have added energy1,2,and 3, as well as
regentenergy1,2, and 3, and lastly, atlasenergy... [long message, see the
prior round above]" was followed up in the very next turn with: "ok, i have
added some new images. layers, which is all 5 layers of the energy icon.
and testimage1,2, and 3. Those are in-game screenshots that show the
orientation of the layers as well as the spin I mentioned before. These
are now reflected in my TheBurdenedNewCharacter.dll file."

Two new files appeared in `~/Desktop/CharProject`: `Layers.png` (872×258)
and `TestEnergy1/2/3.png` (188×170, 207×151, 231×143).

### Layers.png — the big find: real per-layer roles, not a Forge guess

`Layers.png` is a screenshot of a real reference/editor tool (checked —
this is NOT Forge; grepped `frontend/index.html` for the label text found
in it and got zero matches) showing all 5 layers of Tyler's own
TheBurdenedNewCharacter energy icon side by side, each in its own panel
with a title and a one-line description:

- **Back** — "Outer ring / backdrop" — a solid gold ring with small tick
  marks around it.
- **Spin A** — "Rotating inner element" — 2 opposing arc segments (a
  broken ring, roughly 2 "C" shapes).
- **Spin B** — "Rotating inner element" — 6 short dashes arranged in a
  ring, smaller radius than Spin A.
- **Middle** — "Center orb / glow" — a soft radial gradient blob (bright
  center, fading to transparent).
- **Front** — "Center plate behind number" — a thin ring outline, small
  radius, sitting right where the number would render.

This maps 1:1 onto what Tyler described verbally in the prior round
(background, 2 separately-spinning layers, a glow layer behind the
number, a small legibility circle behind the number) — direct visual and
textual confirmation, not an inference. Measuring the radii of each
layer's content in the crop (mean pixel-distance-from-centroid, in a
174×170px per-panel crop): Back ring ≈59.8px, Spin A arcs ≈49.2px, Spin B
dashes ≈38.7px (ignoring one outlier pixel), Middle glow concentrated
toward center (mean ≈21.3px, heavily gradient-weighted), Front ring
≈19.9px (very tight variance — a real thin ring, not a blob). Front and
Middle sit at almost the same radius, consistent with "glow behind the
number, thin ring plate also behind the number."

Colors measured from this same crop are warm gold/amber (e.g. Back's
top-15%-brightness median ≈ RGB(204,159,55)) — notably NOT the same red
as vanilla Ironclad's Energy1/2/3.png from the prior round. That's
expected, not a contradiction: Layers.png is Tyler's own
TheBurdenedNewCharacter, a different character with its own (apparently
gold/default-template) coloring, while Energy1/2/3.png was vanilla
Ironclad. **Decision**: did NOT fold Layers.png's gold colors into
`IRONCLAD_PLACEHOLDER_LAYER_COLORS` — that placeholder is explicitly
Ironclad-flavored and already correctly sampled from real Ironclad
screenshots; mixing in a different character's colors would make it
neither. What DID change: `ORB_LAYER_LABELS` in `frontend/index.html`
now shows the real role names/hints (Back/Spin A/Spin B/Middle/Front,
with a one-line description under each) in the per-layer editor modal
instead of generic "Layer 1 (back)" / "Layer 2" / etc. Verified with a
fresh Playwright screenshot of the modal (`/tmp/orb_layer_editor.png`) —
renders cleanly, all 5 rows show the new title+hint.

**One real caveat, flagged rather than glossed over**: the tool's
left-to-right display order (Back, Spin A, Spin B, Middle, Front) is
*assumed* to match the real 1-5 index order confirmed in the prior round
(`NEnergyCounterFactory.FromLegacy` calling `LayerImagePath(1..5)` in
that order) — there's no direct evidence tying this tool's panel order to
that literal index order, just that it's the obviously most natural
reading of a tool built to edit exactly those 5 layers in sequence.

### TestEnergy1/2/3.png — rotation re-test, same inconclusive result, now with a likely explanation

Cropped each tightly around the ring using a gold-pixel-mask centroid +
bounding-box radius (same method as the prior round, refined slightly).
Result: all 3 frames measured an **identical** ring radius (53.5px) and
nearly identical ring pixel counts (1950 / 1950 / 1951). Ran the same
polar-coordinate FFT cross-correlation from the prior round, now using
Layers.png's own measured radii to target the Spin A band (≈0.823× the
ring radius) and Spin B band (≈0.648× the ring radius) precisely instead
of guessing an annulus. Result: shift ≈0.0° on every frame pair, both
bands, with correlation 0.95-0.99 (i.e. the profiles are nearly
identical, not just failing to align). Given the exactly-matching radius
and pixel counts across all 3 screenshots, the most likely explanation
isn't a measurement failure — it's that these 3 captures landed on the
same or a near-identical point in the spin cycle (e.g. taken in rapid
succession, or with the game paused), not 3 genuinely different phases of
the animation. Reported to Tyler as such rather than claiming "no
rotation exists."

### What changed in Forge this round
- `ORB_LAYER_LABELS` (`frontend/index.html`) — real role names + hints
  per layer, replacing generic numbering. Large comment above it
  documents the Layers.png discovery, the display-order assumption
  caveat, and the rotation re-test result.
- Layer editor's `hint-small` intro text updated to mention the roles are
  now confirmed from Tyler's own reference tool.
- `schema/character.schema.json` — `orb.mode` description expanded with
  the same findings.
- `IRONCLAD_PLACEHOLDER_LAYER_COLORS` itself — unchanged. Still the
  real-measured Ironclad red/orange gradient from the prior round; not
  touched by this round's gold-colored Layers.png findings (different
  character, deliberately not mixed in).
- Visual SHAPE of the `customLayers` preview (`renderEnergyPreview()`) —
  unchanged. It still renders 5 concentric shrinking solid circles, which
  doesn't match the real shapes now confirmed (ring / 2 arc-sets / glow
  blob / thin ring). This is a bigger visual rework than a label/text
  change, so it was deliberately NOT done silently this round — flagged
  to Tyler as an open option instead of guessing he wants it.

## Round: real energy-orb layer art shipped — recolor + image-replace both live, Spin A/Spin B animate, star gets its own editor (2026-08-18, follow-up 2)

Tyler: "I have uploaded several images. I have uploaded background, spinA,
spinB, Middle, and Front. Those are all placeholder images that should be
overlayed on top of each other to make the energy icon. If we really want
spinA and spinB to spin in the app, that is fine, but spinB needs to spin
at about half the speed of spinA. I have also uploaded Star, which is the
placeholder image for the star. In addition, i have uploaded Complete,
which is all of the layers of the energy overlapped and is what all of
the layers together should look like. I want the user to be able to
change the colors of each layer, but to still be able to replace each
layer with their own image and see what it looks like in real-time. The
star should still appear and disappear if the user clicks on a check
box. Clicking on the revealed star should present them with the option
to recolor or replace it with their own image."

### The 7 new files

`Background.png`, `SpinA.png`, `SpinB.png`, `Middle.png`, `Front.png`
(all 256×256, matching Forge's existing per-layer dimension requirement
exactly), `Star.png` (64×64, matching the existing star dimension
requirement exactly), and `Complete.png` (256×256, all 5 layers
overlapped — a reference for what the composite should look like, not
itself a game asset). Visually: Background is a solid red nonagon/gem
shape with a thin outline; SpinA and SpinB are jagged orange "sunburst"
shapes of different sizes/rotations; Middle is a red/orange glow
concentrated toward the edges with a transparent center; Front is a thin
polygon outline; Star is a cyan 4-pointed sparkle (matching the earlier
round's independently-measured `#42ccff` star color — a nice
cross-confirmation). Compositing the 5 layers in Forge and comparing
against Complete.png confirms the overlay approach reproduces
essentially the same look.

### Data model rework: recolor and image-replace are now independent axes

The old `orb.layers[i]` shape was `{mode:'color'|'image', color,
assetRef}` — a layer was EITHER a flat color OR a custom image, never
both. Tyler's ask this round ("I want the user to be able to change the
colors of each layer, but to still be able to replace each layer with
their own image and see what it looks like in real-time") requires both
to work together. New shape: `{assetRef, color}` where `assetRef: null`
means "show Forge's bundled default placeholder art for this slot" (the
real PNGs above) and `color: null` means "show that art's native
colors, no tint." Recoloring is implemented as a CSS mask: the image
(bundled OR custom, doesn't matter which) becomes a `mask-image`/
`-webkit-mask-image` and the layer is filled with a flat
`background-color` instead — a real, live silhouette recolor that works
identically no matter which image is showing. See `tintableVisualCss()`
in `frontend/index.html` — one shared function used by the main
preview, the per-layer editor's swatches, and the new star editor's
swatch, so all three always render identically.

This is a formatVersion 8→9 migration. An old `mode:'image'` row keeps
its `assetRef`, `color` becomes `null` (no visual change — color was
already unused in image mode). An old `mode:'color'` row becomes
`assetRef:null` with that same color carried over as a tint on the NEW
bundled placeholder shape — the closest real equivalent, but a
genuinely visible change for anyone with an already-customized
color-mode layer (shape changes from a shrinking circle to the real
bundled art silhouette). Flagged, not silently glossed over.

The old `IRONCLAD_PLACEHOLDER_LAYER_COLORS` constant (a 5-stop
red-to-cream gradient measured from vanilla Ironclad screenshots two
rounds ago, rendered as shrinking concentric circles) is now fully
superseded and was removed from the code — real placeholder SHAPES
exist now, there's no reason to keep guessing at circles. That
measurement work isn't lost, it's preserved in this file's history
above.

### Spin animation — real CSS rotation, ratio matches what Tyler asked for

Tyler explicitly greenlit this: "If we really want spinA and spinB to
spin in the app, that is fine, but spinB needs to spin at about half the
speed of spinA." Implemented as plain CSS `@keyframes` rotation, applied
by layer INDEX (1 = Spin A, 2 = Spin B, matching the role-mapping
confirmed 2 rounds ago) — `.orb-layer-spin-a{animation:orb-spin 6s
linear infinite;}` / `.orb-layer-spin-b{animation:orb-spin 12s linear
infinite;}`. Double the duration = half the angular speed, exactly the
ratio asked for. Verified programmatically via Playwright
(`getComputedStyle(...).animationDuration` read back as "6s"/"12s" on
the two elements) rather than just eyeballing a screenshot, since a
static image can't show motion. Direction and absolute speed weren't
specified beyond the 2:1 ratio, so both layers spin the same direction
at a middling default rather than guessing at anything fancier.

### Star gets its own click-to-edit modal, replacing the old glyph fallback

Tyler: "The star should still appear and disappear if the user clicks
on a check box. Clicking on the revealed star should present them with
the option to recolor or replace it with their own image." The
"appear/disappear via checkbox" half already existed (`showEnergyStars`).
Added: the star badge itself is now clickable (with `stopPropagation`
so it doesn't also open the orb's own layer editor), opening a small
`openStarEditor()` modal with the same independent recolor/replace-image
pattern as the per-layer editor, just for one image. New
`character.starColor` field (schema formatVersion 9). The old
always-visible plain `<input type=file>` upload row under the checkbox,
and the old text-glyph fallback (a `✦` character in CSS color
`#42ccff`, from 2 rounds ago's real-measurement work) are both gone now
— superseded by real bundled `Star.png` art (which happens to already
be that same measured cyan color, a nice consistency check) shown/tinted
through the same `tintableVisualCss()` path as everything else.

### Verified

`node --check` on the extracted script, JSON-validated the schema.
Playwright: default `customLayers` preview screenshot visually resembles
Complete.png (red/orange faceted gem look, correct layering order).
Opened the per-layer editor modal, toggled Recolor on Layer 1
(Background) and picked a color, confirmed the modal swatch AND the
live main preview both updated to a green-tinted Background layer after
Done. Confirmed `animation-name`/`animation-duration` computed styles on
`.orb-layer-spin-a`/`.orb-layer-spin-b` (6s vs 12s, exactly 2:1). Tested
image upload on a layer (dimension-checked 256×256 PNG accepted, "Reset
to default" button appears and correctly reverts to bundled art) and
dimension-rejection (a 64×64 PNG correctly triggers the "must be exactly
256×256px" alert on a layer upload). Clicked the star badge, confirmed
the editor modal opens, recolored it, confirmed the live badge updates
to the new tint after Done. No new console errors — the only 404s seen
(`/favicon.ico`, `/api/game-status`) are pre-existing, unrelated to this
round (the static-file-server verification fallback has no real backend
behind `/api/...`, documented in earlier rounds).

### What changed
- 6 new bundled assets: `frontend/assets/orb-layer-background.png`,
  `orb-layer-spinA.png`, `orb-layer-spinB.png`, `orb-layer-middle.png`,
  `orb-layer-front.png`, `orb-star.png` (Tyler's own uploaded PNGs,
  copied in as-is).
- `frontend/index.html`: `ORB_LAYER_DEFAULT_ASSETS`/`ORB_STAR_DEFAULT_ASSET`/
  `tintableVisualCss()`/`layerImageSrc()`/`starImageSrc()` new shared
  helpers; `renderEnergyPreview()` rewritten to overlay real layer art
  instead of shrinking circles, with spin animation classes; per-layer
  editor rewritten for independent recolor+image-replace; new
  `openStarEditor()`; `IRONCLAD_PLACEHOLDER_LAYER_COLORS` removed;
  `blankState()`/migration updated for the new `{assetRef,color}` layer
  shape and `starColor`; `formatVersion` 8→9.
- `schema/character.schema.json`: `orb.layers[]` items shape changed,
  `orb.mode`/`starAssetRef` descriptions rewritten, new `starColor`
  field.

## Round: buildFromColor auto-tints real placeholder art, "Use Ironclad default" hides the preview entirely (2026-08-18, follow-up 3)

Tyler: "Build from colors should default to showing the placeholder
energy that we created, but color shift each layer to be based off of
their selected color. The Background should ideally attempt to be the
color they have selected, with spinA being lighter, spin B being
somewhere between the background and spinA, Middle should be a
combination of dark and light highlights, and front should be darker
than the background. This would make the 'Create from color' option
make the most sense. Also, if 'use ironclad default' is selected,
don't bother showing the preview."

Before this round, `orb.mode === 'buildFromColor'` was untouched by the
prior round's real-art rework — it still rendered a flat single-color
fill per layer, not the bundled placeholder shapes at all. This round
extends the same real-bundled-art philosophy to buildFromColor: it now
renders the same 5 layer images as customLayers mode (Background/Spin
A/Spin B/Middle/Front), but instead of a user-chosen per-layer color,
each layer's tint is auto-derived from `character.color` via HSL
lightness shifts, live, with nothing new stored on the character.

### Color-derivation logic (implements Tyler's spec exactly)
New HSL helper chain (`hexToRgb`/`rgbToHex`/`rgbToHsl`/`hslToRgb`/
`shiftLightness`) plus two derivation functions:
- `autoLayerColors(baseColor)`: `background = baseColor` (as selected,
  unmodified); `spinA = shiftLightness(baseColor, +26)` (lighter);
  `spinB = shiftLightness(baseColor, +13)` (between Background and
  Spin A — half of Spin A's shift); `front = shiftLightness(baseColor,
  -22)` (darker).
- `autoMiddleGradient(baseColor)`: "a combination of dark and light
  highlights" can't be expressed as one flat hex tint, so Middle
  renders as a CSS radial-gradient instead — a light highlight near one
  edge, the base color in the middle, a dark highlight opposite:
  `radial-gradient(circle at 36% 32%, ${light} 0%, ${baseColor} 48%,
  ${dark} 100%)` where `light = shiftLightness(baseColor, 36, -10)` and
  `dark = shiftLightness(baseColor, -32, 10)`. **Flagged to Tyler as an
  interpretation call** — this is the one part of his spec that isn't a
  literal single-color instruction, so I'm calling out the choice
  rather than silently picking it.

To let a masked layer accept a gradient (not just a flat color) as its
fill, `tintableVisualCss()` was refactored to delegate to a new shared
primitive, `maskedVisualCss(src, bg)`, where `bg` can be any valid CSS
`background` value.

**Bug caught by Playwright verification, fixed before delivery:**
`maskedVisualCss`'s first draft set `background:${bg}; background-image:
none;` unconditionally — for a flat color this is a no-op (the
shorthand already implies no image), but for the Middle layer's
gradient, `background-image:none` came AFTER `background:${gradient}`
in the same cssText string and silently overrode it, so Middle rendered
fully transparent (mask over nothing). A Playwright check on the live
computed `background-image` caught this immediately (`bgImage: "none"`
for the Middle layer, should have been the gradient). Fixed by
detecting `gradient(` in `bg` and, in that case, setting
`background-color:transparent; background-image:${bg}; background-
size/repeat/position` explicitly instead of relying on the shorthand +
blanket reset. Re-verified: Middle layer's computed `background-image`
now shows the real radial-gradient string.

### "Use Ironclad default" hides the preview
`renderEnergyPreview()` now branches on mode with an early return for
`'default'`: it hides `.energy-preview-wrap` (the orb badge + Show
Stars checkbox) and `#star-upload-row` entirely and returns before
building anything, per Tyler: "don't bother showing the preview." No
placeholder circle, no empty box — the row disappears completely.
Switching back to buildFromColor/customLayers restores it (verified).

### Small proactive fix (flagged, not explicitly requested)
The `#energy-preview` click handler used to always open the per-layer
editor. Since buildFromColor's preview is no longer per-layer-editable
(it's auto-derived, not user-set per layer), the click handler was
updated to only open `openOrbLayerEditor()` when `orb.mode ===
'customLayers'`. Clicking the preview in buildFromColor or default mode
now does nothing. If Tyler would rather buildFromColor still opened
some kind of editor (e.g. jump to the color picker), flag it and this
is a one-line revert.

### Verification
- `node --check` on the extracted `<script>` contents: clean.
- `python3 -c "import json; json.load(...)"` on the updated
  `character.schema.json`: valid.
- Playwright (static-file-server fallback, same limitation as prior
  rounds — `npm install` on the Express backend still 403s):
  1. Set `character.color = '#3050c0'`, mode = buildFromColor. Measured
     computed `background-color` per layer: Background `rgb(48,80,192)`
     (exact match to input), Spin A `rgb(145,163,228)` (lighter), Spin
     B `rgb(92,119,214)` (between Background and Spin A component-wise),
     Front `rgb(26,43,102)` (darker) — all match the spec directly.
     Middle's computed `background-image` is the radial-gradient string
     (after the bug fix above).
  2. Spin A/Spin B still carry `.orb-layer-spin-a`/`-spin-b`, computed
     `animation-name: orb-spin`, `animation-duration: 6s`/`12s` (2:1
     ratio preserved in buildFromColor mode too).
  3. Clicking the preview in buildFromColor mode: `#overlay` does NOT
     gain the `.open` class (editor does not open).
  4. Changed `character.color` to `#c02020` live, re-rendered: layer 0's
     computed background-color updated to `rgb(192,32,32)` immediately.
  5. Switched mode to `default`: `.energy-preview-wrap` computed
     `display:none`, `#star-upload-row` computed `display:none`.
  6. Switched mode back to `customLayers`: `.energy-preview-wrap`
     restored (`display` no longer `none`), and clicking the preview
     now DOES set `#overlay.classList.contains('open') === true`
     (editor opens correctly, confirming the mode-gated click fix
     didn't break the existing customLayers flow).
  7. Screenshot of the buildFromColor preview (test color `#3050c0`,
     blue) visually shows a coherent tinted orb: darker blue outer
     shell, lighter blue spin shapes, a visible light/dark gradient on
     the middle glow, and a darker blue front plate — consistent with
     Tyler's Complete.png-style overlay approach, just recolored.
  - No new console errors introduced (only pre-existing, unrelated
    404s/tunnel-blocked requests from the no-real-backend fallback
    setup, same as prior rounds).

### What changed
- `frontend/index.html`: `tintableVisualCss()` refactored to delegate
  to new `maskedVisualCss(src, bg)` (accepts flat color OR gradient);
  new HSL helpers (`hexToRgb`/`rgbToHex`/`rgbToHsl`/`hslToRgb`/
  `shiftLightness`); new `autoLayerColors()`/`autoMiddleGradient()`;
  `renderEnergyPreview()` rewritten with 3 mode branches (`default`
  hides the preview and returns early; `buildFromColor` builds 5 tinted
  layer divs from the bundled art; `customLayers` unchanged); the
  `#energy-preview` click handler now only opens the layer editor in
  `customLayers` mode; the "Energy orb" label's hint text rewritten to
  describe all three modes; redundant `star-upload-row` display-toggle
  lines removed (now handled solely inside `renderEnergyPreview()`).
- `schema/character.schema.json`: `orb.mode` description expanded to
  document the buildFromColor auto-derivation logic and the
  default-mode-hides-preview behavior.
- No new asset files — reuses the same 6 bundled PNGs delivered in the
  prior round.

## Round: Character & Art panel reorganized per Tyler's "Template" reference screenshot (2026-08-18, follow-up 4)

Tyler attached a screenshot of a target layout (saved on his end as
"Template") and asked: "I would like to reorganize the windows to look
like this." No text description beyond that — the ask was read directly
off the image.

### What the template showed, vs. the live app before this round
Two real, structural differences from the panel's existing layout:
1. **Energy orb moved from the right (art) column into the left (text)
   column**, placed directly below Lore.
2. **The art column's thumbnail row reorganized**: Body sprite/Portrait/
   HUD icon go from a uniform 2-column grid (5 equal-size boxes:
   Portrait, Body sprite, HUD icon, Campfire art, Shop sprite) to one
   row with Body sprite large, Portrait medium, HUD icon small, and the
   two optional fields (Campfire art, Shop sprite) collapsed to compact
   "+ Add X" buttons instead of always-visible empty boxes.

The template also showed the Campfire art button labeled "+ Add Rest
Sprite" rather than "+ Add Campfire Art" — a real naming difference from
"Shop sprite," which matched exactly and needed no rename. Genuinely
ambiguous whether this meant a display-label rename or a wholly separate
new field, so **asked Tyler directly** rather than guessing on a
structural question with migration implications either way. He confirmed:
rename only (same data underneath). Also asked what an optional field's
collapsed "+ Add" button should turn into once populated (no populated
state was visible in the template screenshot to infer from) — he chose
"expand to a thumbnail box," matching Portrait/HUD icon's existing style,
over staying compact permanently.

### Implementation
- **Energy orb block** (label/hint, `#orb-mode` select, `.energy-preview-
  wrap`, `#star-upload-row`) moved verbatim from the end of
  `.char-panel-art` to the end of `.char-panel-text`, right after the "+
  Add lore entry" button. No JS changes needed — all of `renderEnergy
  Preview()`/the mode-change listener/etc. reference elements purely by
  id, unaffected by which column those ids live in.
- **New `.art-primary-row`** replaces the old `.art-thumb-grid` for Body
  sprite/Portrait/HUD icon: a single flex row, `.art-slot-body`/`-portrait`/
  `-hud` sized 148/88/56px (same ~2.6:1.6:1 ratio the template implies).
  `.art-thumb-grid` itself is left in the CSS, unused, in case it's ever
  wanted again — nothing currently references it.
- **New collapsible optional-field pattern** for Rest sprite (the
  renamed Campfire art field) and Shop sprite: each gets an `.art-
  optional-slot` wrapper containing a `+ Add X` button (`.secondary`,
  same style as "+ Add lore entry") plus an `.art-optional-box` holding
  the existing preview-frame/upload-input/clear-button/error markup,
  starting `display:none`. `wireArtField()` already supported an
  `onChange(url)` callback (used elsewhere for the select-screen tile);
  a small new `toggleOptionalSlot(addId, boxId)` helper is passed as
  that callback for both fields — shows the button when the field is
  empty, the box when it's populated. Since `wireArtField()` calls
  `render()` once immediately on setup, an already-populated character
  opens straight to the expanded box on load, not the button — verified.
  The `+ Add X` button's own click just forwards to the existing hidden
  file input (`uploadEl.click()`), same mechanism the preview frame
  itself already used.
- **Label-only rename**: "Campfire art" → "Rest sprite" in the visible
  `<label>` text and its dim-hint (now says "rest-site background
  preview" instead of "campfire background preview" for consistency).
  The field key (`campfireArtAssetRef`), asset kind (`'campfireArt'`),
  and every element id (`campfire-art-*`) are UNCHANGED on purpose — no
  formatVersion bump, no migration, an old saved character's Campfire
  art just displays under the new label with zero data impact. Schema
  description updated to note the UI rename explicitly so a future
  reader doesn't wonder why the schema still says "campfire" everywhere.

### A real sizing bug caught by measuring, not guessing
The first draft used the template's apparent proportions almost 1:1
(200/120/74px for Body/Portrait/HUD icon) and left the two "+ Add"
buttons to fill remaining row space via `flex:1`. Looked plausible from
the CSS alone, but Playwright's actual `getBoundingClientRect()` showed
the button column wrapped to its own line below instead of sharing the
row — this app's own `main{max-width:1180px}` caps the real art column
at ~530px wide (two ~530px columns + a 26px gap ≈ 1086px, well under
1180 once the 40px side padding is subtracted), and 200+120+74+3×16px
gaps already ate 442px of that, leaving only ~70px for a button column
that needs real text room. Confirmed by measuring, not assumed. Fixed by
shrinking all three boxes proportionally (148/88/56px, same ratio,
tighter 12px gaps) — re-measured afterward: all 4 items now share one
row's `y` coordinate exactly, matching the template.

### Verification
- `node --check` on the extracted `<script>` contents: clean.
- `character.schema.json` JSON validity: clean.
- Div tag balance inside `<section id="section-character">`: 58 opens /
  58 closes.
- Playwright (static-file-server fallback, same limitation noted in
  every round — real Express backend still 403s on `npm install`):
  1. `#orb-mode` confirmed present inside `.char-panel-text` and absent
     from `.char-panel-art`.
  2. `.art-primary-row`'s DOM child order confirmed: body slot, portrait
     slot, hud slot, optional column.
  3. Fresh/unpopulated state: both "+ Add" buttons visible, both boxes
     `display:none`.
  4. Measured real widths: body 148px, portrait 88px, hud 56px — matches
     the CSS as authored (not just assumed to cascade correctly).
  5. Clicking "+ Add Rest Sprite" dispatches a real click on the
     underlying hidden file input (listener-fired check, not just DOM
     presence).
  6. Populated `campfireArtAssetRef` directly in `state`, reloaded the
     page fresh (so `wireArtField()`'s own initial `render()` — not a
     manual DOM poke — is what's under test): the "+ Add" button is
     hidden and the thumbnail box is shown, matching the chosen
     populated-state behavior.
  7. Two full-panel screenshots (fresh state, and with Rest sprite
     populated) visually confirm the reorg matches Tyler's template:
     Energy orb under Lore on the left; Body/Portrait/HUD icon/+Add
     buttons sharing one row on the right, Rest sprite correctly
     expanding into the 4th slot with a Remove link once populated.
  - No new console errors (only the same pre-existing, unrelated
    404s/tunnel-blocked requests from the no-real-backend fallback,
    consistent with every prior round).

### What changed
- `frontend/index.html`: Energy orb block relocated from `.char-panel-
  art` to the end of `.char-panel-text`; `.art-thumb-grid`'s 5-item
  markup replaced with `.art-primary-row` (Body sprite/Portrait/HUD icon
  inline) + two `.art-optional-slot` blocks (Rest sprite/Shop sprite,
  collapsible); new CSS (`.art-primary-row`, `.art-slot-body/-portrait/
  -hud`, `.art-optional-col`, `.art-optional-box`); new
  `toggleOptionalSlot()` helper wired into the `campfireArtAssetRef`/
  `shopSpriteAssetRef` `wireArtField()` calls' `onChange`; two new click
  listeners for the "+ Add" buttons; "Campfire art" label/hint text
  changed to "Rest sprite" (data/ids unchanged); `panel-desc` intro text
  updated to mention the Energy orb now living in the left column too.
- `schema/character.schema.json`: `campfireArtAssetRef`'s description
  appended with a note documenting the display-only rename.
- No new asset files, no formatVersion bump, no migration — purely a
  layout/label change.

## Round: select-screen remove-button swap/rename; a real hand-art rendering bug fixed (2026-08-18, follow-up 5)

Tyler, on the panel reorg just delivered: "underneath the select screen
box, swap the position of the remove art and remove background buttons.
also change the text from 'remove art' to 'remove character select
art'. In addition to this, the hand art boxes are incorrect and look
nothing like the reference image. the hand arts are 422px wide by
1200px tall, not the other way around. I want them to be much smaller
in the ui... Ideally i would like for all of the hand boxes to fit into
the circled area in the photo whenever someone uploads both the rest
and shop sprites. If rotating the images 90 degrees in the ui would
make them fit better then we can do that, but leave the orientation of
the file the same as it's uploaded orientation."

### Select-screen remove buttons
Straightforward swap + rename, no logic changes — `select-art-clear`
now renders before `select-bg-clear` in the DOM (so "Remove character
select art" is on the left, "Remove background" on the right, matching
Tyler's screenshot), and its button text changed from "Remove art" to
"Remove character select art". Both buttons' ids, click handlers, and
`wireArtField()` wiring are untouched — this was purely a markup
reorder + text change.

### Hand art — a real rendering bug, not just a resize
Tyler's screenshot showed the hand art boxes as wide/landscape 2x2
tiles, nothing like his reference (narrow vertical strips). Checked the
actual dimension enforcement first (`HAND_ART_WIDTH=422`,
`HAND_ART_HEIGHT=1200` in the JS) — that was always correct, uploads
were already being validated against the real 422×1200 shape. The bug
was purely in the CSS: `.hand-art-frame` had `width:100%` (stretched to
whatever the 2-column grid cell happened to be, several hundred px) AND
`max-height:130px`, both fighting the `aspect-ratio:422/1200`
declaration. With TWO dimensions already pinned (a wide width from the
grid, a short height from the cap), `aspect-ratio` had nothing left to
solve for and was effectively ignored — the box rendered wide-and-short
instead of narrow-and-tall, and `object-fit:cover` then cropped a
correctly-uploaded portrait image down to that wrong shape. This is
exactly why Tyler's own uploaded art "looked nothing like the
reference" even though the upload validation itself was fine.

Fixed by giving the frame one FIXED dimension (`width:54px`) and letting
`aspect-ratio` freely compute the other (height ≈ 154px) — no more
competing constraints. Re-measured via Playwright: real rendered ratio
`54/154 = 0.352`, matching `422/1200 = 0.352` exactly.

Also switched the grid from a 2-column `display:grid` (2x2) to a single
`display:flex` row of 4 (closer to Tyler's own reference layout, which
showed all 4 poses side by side, not stacked), and shrunk supporting
text (placeholder label, click hint, Remove button, error text) down
further (6-9px) since each box is now only 54px wide.

### Repositioned to fit "the circled area"
Tyler's circle in his annotated screenshot sat in the empty space below
Body sprite/Portrait/HUD icon and to the left of the (usually taller,
once populated) Rest sprite/Shop sprite column. Rather than guess at
exact pixel placement from a hand-drawn circle, read the INTENT — hand
art should live in whatever leftover space exists there, not add height
to the whole panel. Implementation: wrapped Body/Portrait/HUD icon (now
`.art-body-row`) and Hand art into a new `.art-primary-left` container
(content-width only, doesn't stretch), a sibling of the existing
`.art-optional-col` (Rest/Shop sprite) inside `.art-primary-row`. Hand
art now renders directly below the Body/Portrait/HUD row, at that row's
own ~316px content width — well under the ~530px-wide art column, so it
comfortably sits beside/below the optional column without pushing
anything.

Verified via Playwright with both optional fields populated (so the
Rest/Shop sprite column is at its tallest, two 512×512-ish boxes
stacked): Hand art's 4 boxes sit directly below Body/Portrait/HUD icon,
well within the leftover height beside that taller column, matching a
screenshot comparison against the populated-state mockup.

Tyler offered rotating the hand art images 90° in the UI (keeping the
underlying file's own orientation untouched) if that would help them
fit. Not needed — real 422:1200-ratio boxes at 54px wide already fit
comfortably in the target area without any rotation, so no transform
was added. Flagged this choice rather than adding unrequested rotation
complexity; easy to add later if the boxes ever need to be even smaller.

### Verification
- `node --check` on the extracted `<script>` contents: clean.
- Div tag balance inside `<section id="section-character">`: 60 opens /
  60 closes (was 58 before this round — 2 new wrapper divs,
  `.art-primary-left` and `.art-body-row`, accounted for).
- Playwright (static-file-server fallback, same limitation noted in
  every round):
  1. Confirmed button DOM order + text: `select-art-clear` first with
     text "Remove character select art", `select-bg-clear` second with
     text "Remove background".
  2. Measured `#ha-frame-point`'s real `getBoundingClientRect()`:
     54×154px, ratio 0.352 — exact match to 422/1200's own ratio
     (0.352), confirming the fix (not just assumed from the CSS).
  3. Confirmed all 4 hand art frames share the same `y` coordinate (824)
     — one row, not a 2x2 grid.
  4. Confirmed Hand art's `x` position matches the Body/Portrait/HUD
     row's own `x` (both 713) and sits below it (`y:824` vs. body row's
     `bottom:781`), while the optional column starts well to the right
     (`x:1041`) — Hand art is beside/below the optional column, not
     overlapping or pushed under it.
  5. Two full-panel screenshots (empty state, and with Rest sprite +
     Shop sprite both populated) visually confirm Hand art now reads as
     4 small, correctly-proportioned vertical strips sitting in the
     leftover space beside the taller populated column, not a large,
     wrongly-cropped 2x2 grid.
  - No new console errors (only the same pre-existing, unrelated
    404s/tunnel-blocked requests from the no-real-backend fallback).

### What changed
- `frontend/index.html`: `select-art-clear`/`select-bg-clear` button
  markup reordered and `select-art-clear`'s text changed; Body sprite/
  Portrait/HUD icon wrapped in new `.art-body-row`, itself wrapped along
  with Hand art in new `.art-primary-left`, both new siblings of the
  unchanged `.art-optional-col` inside `.art-primary-row`; the old
  duplicate/leftover Hand art block below the primary row removed;
  `.hand-art-grid`/`.hand-art-frame`/`.hand-art-slot` CSS rewritten
  (grid→flex row, fixed 54px width instead of stretchy 100%+max-height,
  smaller supporting text); hand art placeholder/hint/remove-button/
  error inline styles shrunk to fit the smaller box.
- No schema changes, no data/migration changes — purely layout/CSS and
  button label fixes.

## Round: Target branch auto-fills from the game's own release_info.json (2026-08-19, follow-up 6)

Tyler asked a factual question first: "Is it possible to get what branch
the game is playing on by looking at the game files? For instance, the
version i have installed is beta branch v0.111.0" — answered by finding
a real file, `release_info.json`, at the root of his uploaded game
folder (sibling of `mods/` and `data_sts2_linuxbsd_x86_64/`), confirmed
content:

```json
{
  "commit": "41cef1ea",
  "version": "v0.111.0",
  "date": "2026-08-13T17:39:18-07:00",
  "branch": "v0.111.0",
  "main_assembly_hash": 222455745
}
```

Worth flagging: the `branch` field's *value* is the version tag itself
("v0.111.0"), not the literal word "beta" — the game's own build
pipeline appears to tag internal branches by version number, not by
Steam's beta/default label. Tyler's Steam branch happens to currently be
pinned to that exact build. We use the field verbatim rather than trying
to translate it into "beta"/"default", since it's still the exact,
unambiguous build identifier either way.

Tyler then explicitly asked: "lets auto fill that branch field with the
available field from the game files as soon as the application picks up
a valid game installed."

### Reused existing infrastructure, didn't build a parallel system
Forge already had a complete, working, OS-aware game-install
auto-detection system built for an unrelated purpose (locating
`sts2.dll`/`GodotSharp.dll`/`0Harmony.dll` for compilation):
`backend/gameLocator.js`'s `locateGame()`/`locateGameAt()`, `server.js`'s
`/api/game-status` + `currentGame()`, and the frontend's
`refreshGameStatus()` (already polled on page load and after saving a
manual path). Extended this exact chain instead of adding a second
detection system:

- **`gameLocator.js`**: new `readReleaseInfo(sts2GamePath)` — reads
  `release_info.json` from the install root, defensive (missing file,
  malformed JSON, or `sts2GamePath` itself missing all just resolve to
  `null`, same convention as `locateGame()`'s own "not found" handling —
  never throws). Exported alongside the existing functions.
- **`server.js`**: `currentGame()` now sets `result.releaseInfo =
  result.found ? readReleaseInfo(result.sts2GamePath) : null`, so
  `/api/game-status` carries it automatically — no new endpoint needed.
- **`frontend/index.html`**: `refreshGameStatus()`'s existing
  found-branch calls a new `applyDetectedBranch(releaseInfo)`.

### Never silently overwrites a value Tyler already typed
This is a UX safety decision I made proactively, not something Tyler
asked for directly, worth being upfront about: `state.character.branch`
is auto-filled from `releaseInfo.branch` *only* while the field is
currently empty. If it already holds something different (an older
character built against another branch, or hand-typed text),
auto-filling would silently discard that — instead a small hint appears
next to the field: "detected from your game install: v0.111.0 — use
this", with "use this" as a clickable link that applies it on demand.
If the field is empty, or already matches the detected value exactly,
no hint shows.

Also confirmed the install *path* itself is not stored on
`state.character` (which would leak local-machine-specific info into
exported/shared character packages) — it already lives only in
`server.js`'s in-memory `manualGameDir`, outside the character schema
entirely. No new architectural risk introduced.

### Two bugs found and fixed along the way (not requested, flagged here for transparency)
1. **Pre-existing**: `refreshGameStatus()` was reading `data.gameDir`, a
   field that never existed on `/api/game-status`'s response shape (the
   real field is `sts2GamePath`) — meaning the "set install path" modal
   always opened with an empty path, and the game-status pill's hover
   tooltip was always empty, even when a game *was* found. Fixed in
   passing since it's the exact code block being extended.
2. **New, introduced then caught by our own verification**: the
   game-status tooltip's version text first rendered as `"vv0.111.0"` —
   `release_info.json`'s own `version` field already includes a leading
   "v", and the template literal was prepending a second one. Fixed by
   stripping any leading `v`/`V` from `version` before prepending ours
   (handles an unprefixed version string too, in case that ever varies).

### Verification
- `node --check` clean on `gameLocator.js`, `server.js`, and the
  extracted `<script>` from `frontend/index.html`.
- No `node_modules` for `express`/`archiver` exist in this sandbox
  (confirmed via `ls` on both `backend/node_modules` and the project
  root — long-documented limitation), and `server.js` calls
  `app.listen()` unconditionally with no `require.main === module`
  guard, so it can't be `require()`'d directly here either way. Instead
  simulated `currentGame()`'s exact new logic via a standalone `node -e`
  script depending only on `gameLocator.js` (no express dependency)
  against a fake install directory shaped like Tyler's real one, plus a
  malformed-JSON case and a nonexistent-path case — all resolved
  correctly, no throws.
- Playwright against the `python3 -m http.server` static-file fallback
  (same limitation as every prior round — no real backend to hit, so
  `/api/game-status` responses were mocked via `page.route()`), 5 cases:
  1. Empty branch field auto-fills from a mocked found+releaseInfo
     response; hint stays hidden; tooltip reads `.../install —
     v0.111.0 · branch v0.111.0 · commit 41cef1ea` (confirms the double-v
     fix).
  2. An existing different branch value (`"default"`) is left
     untouched; hint appears with the exact expected text; clicking "use
     this" applies the detected value and hides the hint.
  3. An existing branch value that already exactly matches the detected
     one keeps the hint hidden (no redundant nagging).
  4. A "not found" response leaves the branch field empty, no crash, no
     new console errors beyond the same pre-existing tunnel-blocked
     noise from the no-real-backend fallback.
  5. A `releaseInfo` object present but missing the `branch` key
     entirely is handled gracefully — no crash, no auto-fill.

### What changed
- `backend/gameLocator.js`: new `readReleaseInfo()`, exported.
- `backend/server.js`: `currentGame()` now includes `releaseInfo`.
- `frontend/index.html`: Target branch field gets a new detect-hint
  element and updated tooltip copy; `refreshGameStatus()` extended with
  `applyDetectedBranch()`/`renderBranchDetectHint()`; the pre-existing
  `data.gameDir` bug and the double-v cosmetic bug both fixed in the
  same block.
- No schema changes — `character.branch` was already free text; this
  only changes what pre-fills it and when.

## Round: Character art made fully functional — real disassembly of 2 mods, README consolidated, reimport sidecar shipped (2026-08-19, follow-up 7)

Tyler asked what in the Character section was still UI-only (not passed to
the backend). Answer, checked directly against `compiler.js`/`validate.js`
rather than from memory: every art field, the Energy orb, and Lore were
pure preview — the full character state (including base64 art) was sent
to `/api/compile` in the request body, but `compiler.js` never read any of
it, so it silently went nowhere. Tyler's response: "Lets make this fully
functional before we move on... this is an essential feature that I would
like to add to the scope," plus two explicit asks — a README with real
build info (game version/branch), and the ability to re-import an exported
character to keep editing it.

### Real evidence, not guesses: disassembling Tyler's own compiled mods

Rather than guess at BaseLib property names, Tyler's two real compiled
character mods (`TheBurdenedNewCharacter.dll`, `TheTrainerNewCharacter.dll`
— both already used for earlier reflect-baselib rounds) were disassembled
directly: `strings -e l` (catches .NET's UTF-16 string-literal heap, which
plain `strings` misses) surfaced every real `res://` asset path baked into
each DLL, and a hand-rolled ECMA-335 metadata + IL parser (same technique
as the earlier `EnergyCounterLayerPath` discovery, rebuilt from scratch
since the prior scratch script didn't survive the session boundary) decoded
the exact getter methods returning each path. Every finding below was
cross-checked on BOTH mods — they use different id prefixes throughout, so
agreement between the two is real confirmation, not coincidence.

Confirmed REAL, with explicit overridable C# properties:
- `CustomCharacterSelectIconPath` → `images/packed/portraits/<id>_char_select.png` (Select screen art)
- `CustomMapMarkerPath` + `CustomIconTexturePath` → both → `images/packed/portraits/<id>_hud_icon.png` (HUD icon)
- `CustomArmPaperTexturePath`/`CustomArmPointingTexturePath`/`CustomArmRockTexturePath`/`CustomArmScissorsTexturePath` → `images/packed/hands/<id>_hand_{paper,pointing,rock,scissors}.png` (Hand art — Forge's own schema key `point` maps to the real `Pointing` name, the one naming mismatch found; already correctly RPS-named everywhere else, a nice pre-existing consistency check)
- `EnergyCounterLayerPath`/`CustomEnergyCounter` (already known from an earlier round) → `images/packed/energy_counters/<id>_layer_{1-5}.png` (Energy orb)

Confirmed as a real, consistent filename convention but with **no C# getter
found anywhere in either DLL**:
- `<id>_creature.png` (Body sprite) and `<id>_star_icon.png` (Star icon) — every other asset had an explicit override; these two didn't, despite an exhaustive sweep of all 510 `get_*` properties in the Burdened DLL. Exported anyway (best-effort, filename-convention-only), flagged clearly in the generated README and schema.

Confirmed BLOCKED — real full Godot **scenes**, not flat images:
- `CustomCharacterSelectBg` → `scenes/screens/char_select/char_select_bg_*.tscn` (Select screen background)
- `CustomMerchantAnimPath` → `scenes/merchant/*_merchant.tscn` (Shop sprite)
- `CustomRestSiteAnimPath` → `scenes/rest_site/*_rest_site.tscn` (Rest/Campfire sprite)

No hook found at all, in either DLL, by any name:
- `portraitAssetRef` (the standalone 256×256 "Portrait" field) — every other field had SOME real evidence; this one had none. Left unwired rather than inventing an override name.

Bonus finding, unrelated to this round's ask but worth recording: `get_BaseOrbSlotCount` showed up in the full getter sweep — this resolves a long-standing open item (item 13, `Player.BaseOrbSlotCount`'s seeding mechanism) from several rounds ago. Not acted on this round (out of scope), noted for a future one.

Also note: `PortraitPath`/`CustomPortraitPath` (the two most similarly-named
getters found) turned out to be per-CARD portrait paths (one per card in
the DLL, matching `images/packed/card_portraits/<id>/<card>.png`), not a
character-level field at all — a naming collision worth remembering before
any future round touches card art export.

### Tyler's call on the 3 blocked fields

Presented the evidence above via AskUserQuestion (not guessed silently,
since shipping a fake/broken `.tscn` would either fail to compile or ship
broken art at runtime) — options were "leave as preview-only" (safest),
"attempt a best-effort static scene" (experimental, might not match the
real node structure), or "drop from Character section for now." Tyler
picked **leave as preview-only** — the safest option. `character.schema.json`
now documents this as a confirmed-permanent decision for these 3 fields
(and separately, for Portrait, as "no evidence found" rather than "not
done yet").

### What changed

- **`backend/compiler.js`**: new `writeCharacterArt()` — writes real PNGs
  into `pack/images/...` at the confirmed paths above (custom upload if
  present, else Forge's own bundled default art read straight off disk for
  Energy orb layers/Star icon, same files the live preview already falls
  back to) and builds a C# override block spliced into a new
  `{{artOverrides}}` placeholder in `Character.cs.template`. Skips the 3
  blocked fields and Portrait entirely. `orb.mode === 'default'` ("Use
  Ironclad default") also skips — there's no real art configured in that
  mode, matching the live preview showing nothing. `showEnergyStars ===
  false` skips the star icon. Returns a plain-English `artReport` (what
  exported, what didn't, why) consumed by the new README below.
  A real bug caught by my own testing before shipping: the `CustomEnergyCounter`
  override line used a `{{colorHex}}` placeholder INSIDE a value that gets
  spliced into an already-`fillTemplate()`'d string — `String.replace()`
  doesn't rescan replacement text for further matches, so that would have
  shipped as the literal text `{{colorHex}}` in the generated C#. Fixed by
  passing `colorHex` as a real JS parameter and interpolating directly.
- **Known, flagged limitation, not fixed this round**: recolor tints
  (`orb.layers[].color`, `starColor`) are a live CSS-mask effect in the
  browser only — this backend has no image-manipulation library available
  (same `npm install` 403 limitation documented throughout this project),
  so a tinted layer/star exports as its UNTINTED base art. Only matters
  when a tint is actually set (`color`/`starColor` non-null) — an
  un-customized character (the common case, tint fields default to null)
  exports exactly what it previews. Flagged per-character in the generated
  README when it applies.
- **`backend/templates/Character.cs.template`**: new `{{artOverrides}}`
  insertion point at the end of the class body.
- **`backend/server.js`**: new `buildTopReadme()` replaces the old
  scattered `BUILD_FAILED.txt`/`GAME_NOT_FOUND.txt`/`INSTALLED.txt` with
  one consolidated `README.md` per Tyler's ask — same build-outcome info
  those 3 files carried, now in one place, PLUS what they never had: the
  real game version/branch this was compiled against (from
  `release_info.json`, wired in the previous round), the full character-art
  export report, and reimport instructions.
- **Reimport sidecar** (Tyler: "I want to create this with the intention
  of being able to reverse-engineer anything that is exported... import a
  character that they have created and work on it some more after the
  initial export"): every export now includes `Forge_Project/character_project.json`
  — the exact, complete, unmodified package Forge sent to `/api/compile`
  (not a lossy reconstruction from the generated C#/art). Lives outside
  `pack/`/`Cards/`/etc., invisible to MSBuild's `**/*.cs` glob and never
  referenced by any generated scene/resource, so the game will never try
  to load or run it — pure passenger data, same reasoning already
  established for the Pets/Orbs README.md files.
- **`frontend/index.html`**: new "Import project" button (top bar, next to
  Reset) reads that sidecar file back in, runs it through the SAME
  `migrateLegacyStatusActions()` pipeline `load()` already uses on every
  normal page load (so an export from an older Forge/formatVersion
  migrates cleanly, no separate import-specific migration path to
  maintain), confirms before overwriting an in-progress character, then
  saves to localStorage and reloads the page — reloading rather than
  manually re-calling every `render*()` function scattered across the file
  guarantees a fully correct re-render the same way a normal page load
  already is, rather than risking a missed render call (the existing
  `resetBtn` handler's manual re-render list is NOT fully exhaustive
  either, a pre-existing gap noticed in passing, not fixed this round
  since Reset's behavior wasn't in scope).
- **`schema/character.schema.json`**: every character art field's
  description rewritten to reflect the real, now-confirmed status —
  `[VERIFIED, EXPORTED]` for the 2 fields with confirmed overrides,
  `[EXPORTED ... BEST EFFORT]` for Body sprite/Star icon, and explicit
  "CONFIRMED permanent" language for the 3 blocked scene-based fields and
  Portrait, replacing the old blanket "[DESIGN-TIME PREVIEW ONLY, not
  compiled]" tag that no longer told the whole story.

### Verification

- `node --check` clean on `compiler.js`, `server.js`, and the extracted
  `<script>` from `frontend/index.html`; `character.schema.json` re-parsed
  as valid JSON after every edit.
- Direct `node -e` test of `writeCharacterArt()`/`generateProject()`
  against a full mock character package exercising every branch (all 6
  exportable fields populated, 2 hand-art poses deliberately left empty, a
  tint set on one orb layer, `showEnergyStars` on with no custom upload
  falling back to bundled art) — confirmed every real PNG landed at the
  exact expected path (walked the output tree), confirmed with PIL that
  a written file is genuinely valid PNG bytes (not corrupted), and read
  back the generated `Character.cs`'s art-override block to confirm no
  stray `{{colorHex}}`-style template leakage (this is what caught the bug
  described above, before it ever shipped). A second full regression test
  with real cards/relics (going through `validateCharacterPackage()` too,
  not just `generateProject()` directly) confirmed nothing else in the
  existing pipeline broke.
- `buildTopReadme()` extracted directly from the real `server.js` source
  (not hand-retyped) and exercised against all 3 build-outcome branches
  (compiled / build failed / game not found) plus a game-version/branch
  mismatch case — all rendered correctly.
- Playwright against the static-file-server fallback (same no-real-backend
  limitation as every round): confirmed the Import project button exists
  and the updated panel-desc text renders; fed a valid minimal project
  JSON through the real hidden `<input type=file>` via `setInputFiles`
  and confirmed, after the page's own reload, that Name/HP/etc. actually
  loaded from the imported file (not just that no error was thrown);
  confirmed invalid JSON shows the right alert and leaves state
  untouched; confirmed a JSON file missing a `character` key is rejected
  with a clear message. No new console errors. A full-page screenshot
  confirmed the new header button doesn't break the existing layout.

### What's still open

Card-level art (`card.artAssetRef`, 500×375px) is a separate system and
was explicitly out of scope for this round (Tyler's ask was scoped to
"the character section") — it remains exactly as preview-only as before,
`compiler.js` still never reads it. A natural next-round candidate if
Tyler wants the same treatment there, though card art has no confirmed
real asset-path evidence gathered yet the way character art now does.

Body sprite and Star icon's BEST EFFORT status (real filename convention,
no confirmed override) is the one meaningful remaining uncertainty in
what shipped this round — self-correcting the same way every other
BEST-EFFORT guess in this project has been: if either doesn't show up
correctly on Tyler's first real build/test, that's the first thing to
investigate, and any error message the game logs would be the next real
evidence to chase.

## Card section audit + upgrade UI, phase 1 of 2 (2026-08-19, follow-up 8)

Tyler moved on to the Card section and asked for the same audit treatment
as Character: "anything that isn't currently being passed through to the
back end and is just an element in the ui?" — checked directly against
`backend/compiler.js` (`generateCardSource()`), `backend/validate.js`
(the card-validation block), and `schema/character.schema.json`'s
`definitions.card`/`definitions.cardEffectBlock`, not from memory.

Found two real gaps, different in character:

- **Card art** (`card.artAssetRef`, 500×375px) — pure UI-only, exactly
  like the old character-art gap: sent in the compile request body,
  never read by `compiler.js` at all. No frontend or backend change made
  to this yet — still an open item, flagged below.
- **Card upgrades** (`card.upgrade` = `{costDelta, effects}`) — a more
  interesting shape of gap. `validate.js` already validates
  `card.upgrade.effects` with the exact same rigor as base card effects
  (`validateEffects()`, `allowedTriggers: CARD_TRIGGERS`) — confirmed via
  direct `node -e` test, a card with `upgrade.effects` set validates
  clean. But `compiler.js`'s `generateCardSource()` builds `OnUpgrade()`
  as an unconditional `ForgeActions.Todo(...)` stub whenever `card.upgrade`
  is truthy — `costDelta`/`effects` are read nowhere in compiler.js. AND,
  until this round, there was zero frontend UI anywhere to even set
  `card.upgrade` (confirmed via a full-file grep for "upgrade" — only 4
  unrelated hits, none of them an editor). So this was a fully dormant,
  currently-unusable gap across all 3 layers, not something silently
  discarding real player-authored data today.

Tyler: "we should add upgrades first. lets finish most of this section
before we tie it in to the back end." — explicit two-phase split: build
the frontend UI now (this round), defer the actual `OnUpgrade()` codegen
to a later round. `backend/compiler.js` was NOT touched this round.

### What shipped

`frontend/index.html`'s `openCardEditor` — new "Has an upgrade (Card+)"
checkbox in the card editor modal. Unchecked (default): `card.upgrade`
stays undefined, same as every card saved before this round. Checked:
reveals a Cost change number input (`card.upgrade.costDelta`, can be
negative — e.g. -1 to cost 1 less when upgraded) and a full second
effects editor bound to `card.upgrade.effects`, using the exact same
trigger/conditions/actions/elseActions block editor as the base Effects
section above it (same `CARD_TRIGGERS`, since `validate.js` already
confirmed upgrade effects share that same allowed-trigger set).

`renderEffectsList()` — the function backing all three effects editors
in the app (Card, Relic, Mechanic) — was generalized to take an optional
`listElId` parameter (defaults to `'effects-list'`, so the 3 existing
call sites are unaffected) instead of a hardcoded DOM id. This was the
one piece of real surgery needed: the card editor is now the first place
in the app with *two* effects editors open in the same modal at once
(base effects + upgrade effects), so they can't share one `#effects-list`
node the way the old single-editor-per-modal assumption allowed.

Unchecking the box deletes `card.upgrade` entirely (not just hides it) —
same "don't leave disabled-but-present data around" convention the art
Remove button already uses elsewhere, so an unchecked card round-trips
back to exactly the shape it had before this feature existed.

The UI is explicit that this doesn't compile yet: a hint under the
checkbox says plainly that `backend/compiler.js` still emits a
placeholder regardless of what's set here, so nothing implies more than
what's actually true.

### Verification

- `node --check` on the extracted `<script>` body — clean.
- Div-tag balance check on the full file (225 open / 225 close) — clean.
- `node -e` against `validate.js` directly with a card carrying a real
  `upgrade: {costDelta:-1, effects:[...]}` — validates clean (`valid:
  true`), confirming the new UI can only ever produce data the backend
  already accepts.
- Full Playwright pass against the static-file-server fallback: checked
  the box → section reveals and `card.upgrade` is created; added an
  upgrade effect block → renders and pushes into
  `card.upgrade.effects`; added an action inside it → persists; set
  costDelta to -1 → persists; clicked Done → `card.upgrade` on the saved
  card matches everything entered; reloaded the page fresh from
  localStorage → the upgrade data survived the real `save()`/`load()`
  round-trip, not just the in-memory object; reopened the editor on the
  reloaded card → checkbox correctly pre-checked, cost field correctly
  pre-filled, effect block correctly re-rendered; unchecked the box and
  saved → confirmed `'upgrade' in card` is `false` afterward (fully
  removed, not just hidden); reopened the editor once more and exercised
  the *base* Effects editor (add effect block) as a regression check on
  the `renderEffectsList()` generalization → still works, unaffected. No
  page errors thrown at any point (checked via Playwright's `pageerror`
  listener, not just console noise from unrelated resource 404s).

### What's still open

`backend/compiler.js`'s `OnUpgrade()` — still an unconditional
`ForgeActions.Todo(...)` stub. Explicitly deferred to a later round per
Tyler's own phasing; the UI now saves real, validate.js-clean
`costDelta`/`effects` data, ready for that round to consume.

Card art (`card.artAssetRef`) — untouched this round, remains exactly as
preview-only as it's always been. Natural next candidate after upgrades
are wired to the backend, following the same real-disassembly-first
approach used for character art (follow-up 7) if/when Tyler wants it.


## Round: Rest sprite live drag/resize preview (2026-09-01)

Tyler, verbatim: "lets see about adding the scalability into the rest
sprite. Ideally I would like to be able to move the character around and
resize them. When that is handled, we can see about the shop sprite
problem. There is still the 'campfire available space' and 'campfire
placeholder' inside of the resources folder in the charproject directory.
previously we mapped the 512x512 image to that available space. I would
like to reuse that same technique to see the size and placement of the
character in real-time in the app."

Scoped to Rest sprite only, per Tyler's own ordering ("when that is
handled, we can see about the shop sprite problem") -- Shop sprite stays
untouched this round, and per Round 27's IL findings it's a hard,
structural Spine requirement with no flat-image path anyway (see that
round's addendum), so there's nothing analogous to build there.

### What changed

Rest sprite's preview box (`#campfire-art-frame`/`#campfire-art-img`) used
to be a fixed CSS inset -- `left:16.14% top:22.51% width:26.54%
height:33.18%` of the bundled `campfire-placeholder.png`, measured once via
OpenCV feature-matching against Tyler's own `CampfireAvailableSpace.png`
(see the "measured position" round earlier in this doc). That fixed inset
is now the DEFAULT starting box (`DEFAULT_REST_SPRITE_TRANSFORM` in
frontend/index.html), not the only one -- the uploaded sitting art is
wrapped in a new `.rest-sprite-stage` div that's a real, live drag/resize
handle directly in the Forge UI:

- **Drag anywhere on the character art to reposition it** (pointer
  events, not mouse-only, so it also works on touch/pen). Position
  updates live as you drag; committed to
  `state.character.restSpriteTransform.{x,y}` (percentages of the
  585x465 frame, same coordinate space the old hard-coded inset used) on
  release.
- **Drag the small handle at the art's bottom-right corner to resize it**
  (anchored to the top-left corner, independent width/height -- safe to
  do freely since the image itself is `object-fit:contain` inside the
  box, so it never distorts/stretches, only the box's footprint changes).
  Committed to `.width`/`.height` on release, clamped 4%-100% of the
  frame.
- **"Reset position" button** (only visible once art is uploaded) snaps
  back to `DEFAULT_REST_SPRITE_TRANSFORM` -- the original measured box --
  in one click.
- A plain click on the art (no drag) still opens the file picker to
  swap the art, exactly like every other art field -- only an actual
  drag suppresses that click, via a `moved`/`suppressClick` flag rather
  than blocking clicks outright.

### Data model

New optional `character.restSpriteTransform` field: `{x,y,width,height}`,
all percentages, `null` until the user first drags/resizes (at which
point `getRestSpriteTransform()` falls back live to
`DEFAULT_REST_SPRITE_TRANSFORM` -- so an untouched character's preview
renders identically to before this round, byte-for-byte the same
position). Purely additive: `blankState()` seeds it `null`, and a new
migration line backfills `null` for any already-saved character missing
the key -- **no formatVersion bump**, same convention as every other
purely-additive field this project has added (pets/orbs arrays, the v7/v8
art fields, etc.).

`schema/character.schema.json` gained the matching `restSpriteTransform`
property (optional, `{object, null}`, not in `required[]`,
`additionalProperties` unrestricted at the character level) -- confirmed
`validate.js` doesn't independently whitelist character keys anywhere
(character-level art was never schema-validated before this round either,
same as every other art field), so this is a pure passthrough, exactly as
preview-only as `campfireArtAssetRef` itself.

### Explicitly NOT done this round (same honesty convention as every art field)

`backend/compiler.js`/`backend/validate.js` are UNCHANGED -- this
transform is not read at compile time. The real game still resolves the
rest-site scene via a Godot `.tscn` (`CustomRestSiteAnimPath`), which
Forge can't author. Round 27's IL findings already established that a
flat image is structurally viable there (`NRestSiteCharacter`'s own
`GetChildSpineNodes()` gracefully no-ops when no native `SpineSprite`
child exists) -- if that ever gets built into a real `.tscn` export, this
round's `x/y/width/height` is the natural, ready-made source for the
generated node's `Position`/`Scale`. Not attempted this round; scoped
purely to the live preview Tyler asked for.

### Verification

`node --check` on the extracted inline `<script>` -- clean.
`schema/character.schema.json` re-parsed as JSON -- valid.
`backend/validate.js`/`backend/compiler.js` both still `require()` clean
(schema addition didn't break either module's load). Markup-only div
tag balance (everything before `<script>`, the actual HTML rather than
JS-generated template strings elsewhere in the file) -- 105/105,
confirmed clean; a whole-file naive div count shows a pre-existing 1-tag
mismatch that traced to JS template-literal strings inside `<script>`,
unrelated to and unchanged by this round's edit. All 4 new element ids
(`campfire-art-stage`/`campfire-art-resize-handle`/`campfire-art-reset`/
`campfire-art-drag-hint`) confirmed unique, no collisions.

No local Playwright/browser environment available in this round's sandbox
to drive an actual pointer-drag end-to-end (unlike most rounds' usual
Playwright pass) -- this is a real gap versus the project's normal
verification bar, flagged rather than glossed over. Static
checks (syntax, schema validity, id wiring, module loading) all pass, but
Tyler should do one quick manual pass after his next reload: upload a
Rest sprite, drag it, resize it via the corner handle, reload the app,
and confirm the position/size persisted -- that's the one thing this
round couldn't self-verify.

### Delivered

`schema/character.schema.json` and `frontend/index.html` only, edited
directly in Tyler's `CharProject/sts2-builder` folder via the device
bridge. Frontend is a static file served by the existing Express app --
Tyler's usual reload/restart picks it up, no backend restart strictly
required since `backend/` itself wasn't touched, but a full app restart
is the safer bet given the browser process may have the old JS cached.


## Round: Rest sprite drag/resize moved into its own "Modify position/size" modal (2026-09-01, same-day follow-up)

Tyler, immediately after the previous round: "lets add a button for
'modify position/size' under the rest sprite. I want this to pop it into
a new window that is larger so that the user can see what they are doing
more clearly. When they click 'done' after changing the size and
position, it should reflect their changes in the smaller preview window.
This means that the current window should only show the preview, and not
allow them to modify the size or position. I want all of that
functionality to be in the new window."

**Asked first, before building**: whether "new window" meant a literal
separate OS window (would need `setWindowOpenHandler` wiring in
`electron/main.js` -- Electron blocks popup windows by default -- plus a
way to hand data between two separate JS realms) or a large in-app
overlay. Tyler chose the in-app overlay. This matters because the app
already has a full, reusable modal system (`openModal(html, opts)` /
`closeModal()`, backed by the shared `#modal`/`#overlay` elements, used by
every other editor in this file -- cards, relics, mechanics, pets, orbs,
the energy-star/orb-layer pickers) -- a real second window would have
been a materially bigger, riskier lift for no functional gain here.

### What changed

- **`#campfire-art-frame`'s small preview is now read-only.** The drag/
  resize wiring this app had (previous round) is REMOVED from the small
  view entirely -- no pointer listeners, no visible handle (the handle
  `<div>` isn't even in that markup anymore), `.rest-sprite-stage--readonly`
  sets `pointer-events:none` on the stage. It still shows the character
  art at whatever `state.character.restSpriteTransform` currently holds
  -- just can't be touched there. Clicking the frame still opens the
  upload dialog to swap the art (unrelated to position/size, untouched).
- **New "Modify position/size" button** under Rest sprite (next to
  Remove, same visibility rule -- hidden until art is uploaded).
  `openRestSpriteModal()` builds a modal via the app's existing
  `openModal()`, ~3x larger than the small preview
  (`.rest-sprite-modal-frame{width:min(78vw, 820px)}` vs. the sidebar
  box's ~260px), same 585:465 aspect ratio and bundled
  `campfire-placeholder.png` background, with a bigger 20px drag handle
  (`.rest-sprite-handle--lg`) for easier grabbing at the larger scale.
- **Drag/resize logic refactored into a reusable `wireStageDragResize
  (frame, stage, handle, getT, onChange)`** -- takes any frame/stage/
  handle triple plus getter/onChange callbacks, doesn't touch `state`
  itself. The modal is the only caller now.
- **"Nothing touches state until Done"** -- same convention
  `openCardEditor` already uses for its own pending art/keywords/tags.
  The modal works against a local `draft` variable (`{...
  getRestSpriteTransform()}` on open); dragging/resizing only repaints the
  modal's own stage and updates `draft`. "Done" commits `draft` to
  `state.character.restSpriteTransform`, saves, and re-renders the small
  read-only preview. The modal's own X (`closeModal()`, same shared
  convention every other editor's header close button uses) or clicking
  outside the modal both just discard `draft` -- exactly the existing
  cancel behavior for every other editor here, no new code needed for
  that part. "Reset position" now lives ONLY inside the modal (also
  draft-only until Done, not an immediate commit like the previous
  round's version).

### Verification

`node --check` on the extracted inline `<script>` -- clean. Markup-only
div tag balance (before `<script>`) -- 103/103 (down from the previous
round's 105/105, consistent with removing the handle + drag-hint divs
from the small view; the modal's own divs are JS template strings, not
static markup, so they don't count here). All 8 new/changed element ids
(`campfire-art-modify-btn`, `rest-sprite-modal-frame/-stage/-img/-handle/
-reset/-done`) confirmed unique -- zero collisions. Grepped for every
removed id/class (`campfire-art-resize-handle`, `campfire-art-reset`,
`campfire-art-drag-hint`, `.rs-dragging`) across the whole file -- zero
leftover references anywhere, in either markup or CSS.
`backend/validate.js`/`backend/compiler.js` still `require()` clean
(nothing here touches the backend at all this round -- position/size was
already preview-only, still is).

Same gap as last round, still true: no local Playwright/browser
environment available to drive an actual pointer-drag test end-to-end.
Static checks all pass. Tyler should confirm after his next reload:
button appears once a Rest sprite is uploaded, opens a visibly larger
modal, drag/resize work inside it, "Done" carries the change back to the
small preview, and the small preview no longer responds to drag attempts
directly.

### Delivered

`frontend/index.html` only (CSS block + Rest sprite HTML block + the JS
drag/render/modal block), edited directly in Tyler's
`CharProject/sts2-builder` folder via the device bridge. Same-file diff
as last round, no schema change this time (the `restSpriteTransform` data
shape itself didn't change, only how it's edited).


## Round: Rest sprite drag/resize/modal mechanic — live browser verification (2026-09-01, same-day follow-up)

Tyler, verbatim: "I want to wire up this repositioning mechanic before we
move on to the shop sprite. lets make sure it works." Every prior round in
this project (including both earlier Rest sprite rounds today) was only
ever verified statically - `node --check`, JSON-schema validation, `vm`-
sandbox unit tests, DOM-id/CSS spot-checks by reading the file. No
Playwright/headless-browser environment had ever been available in this
sandbox. This round finally closed that gap for real.

### What was tried and ruled out first

1. **A persistent local `node server.js` inside the device's own Linux VM,
   curl-tested from a follow-up call.** Failed - confirmed via `ps aux`
   that ANY backgrounded process (even `nohup ... &`) dies the instant its
   own `device_bash` call returns. Each `device_bash` invocation is a
   fully fresh, isolated `bwrap --unshare-pid` sandbox; there is no way to
   keep a server alive across separate calls from that tool.
2. **A headless browser (chromium) in the device's Linux VM.** Not
   present (`which chromium chromium-browser google-chrome` all empty,
   `/opt` only contains `cowork`), and installing one via npm/apt was
   blocked - `curl` to `registry.npmjs.org` from that VM returned `403`.
3. **`jsdom`-based DOM simulation inside THIS session's own cloud
   container** (a separate sandbox from the device VM). Also blocked:
   `npm install jsdom` failed with a real `403 Forbidden` from
   `registry.npmjs.org` itself, confirmed NOT to be a proxy/routing issue
   (checked `$HTTPS_PROXY/__agentproxy/status`; `registry.npmjs.org` is
   correctly in the proxy's own `NO_PROXY` allowlist, meaning the request
   went out directly and was rejected by npm's registry-level access
   control under this org's policy) - an org-level block on new package
   installs, not something to route around.

### What actually worked

Tyler confirmed his own Forge instance was already running, listening on
`localhost:3000` (not the Electron-packaged default of 3131 - he runs it
via something like `npm start` rather than the packaged app, so the port
varies build to build). This session has its own browser-pane tool
(`Claude_Browser__*`, distinct from the device VM's `device_bash`, and not
sharing its network namespace) that can navigate, click, drag, screenshot,
and run arbitrary JS directly against a real, already-running desktop
browser tab. After one `Claude_Browser__request_access` grant (scope
"site") and pointing it at `localhost:3000` instead of 3131, this let the
actual mechanic be driven end-to-end in Tyler's real app, not re-read as
code or simulated.

One implementation detail worth recording for future rounds: file uploads
were exercised through the REAL upload code path, not by poking `state`
directly - built a genuine 512x512 PNG via `document.createElement('canvas')`
+ `toBlob()`, wrapped it in a real `File`/`DataTransfer`, assigned it to
the file `<input>`'s `.files`, and dispatched a real `change` `Event`. This
exercises the actual `FileReader`/dimension-check/`commitAsset()` chain
`wireArtField()` wires up, the same as if Tyler had picked a file himself.

### The 10-step sequence run, each confirmed by screenshot and/or direct
### JS state/DOM inspection (not assumed)

1. Confirmed the project was genuinely blank first (`campfireArtAssetRef:
   null`, `state.assets.length === 0`) before touching anything.
2. Uploaded a real 512x512 test PNG through the real file-input `change`
   event described above - confirmed the upload path (art shows up,
   `campfireArtAssetRef` populated, asset added to `state.assets[]`)
   still works end to end.
3. **Small preview confirmed genuinely read-only**: a real pointer
   down->move->up drag directly on the art in the small view produced ZERO
   change - `state.character.restSpriteTransform` stayed `null`, the
   stage `<div>`'s inline style string was byte-identical before and
   after the drag, and no modal opened. Cross-checked via
   `getComputedStyle(...).pointerEvents === 'none'` on the stage element
   and confirmed the resize-handle `<div>` genuinely does not exist in
   the small view's DOM (not just hidden via CSS).
4. **"Modify position/size" button opens the modal** - screenshotted:
   visibly ~3x the small preview's size, dashed outline around the stage,
   a visible blue corner resize handle, "Reset position"/"Done" buttons
   in the modal footer, correct modal title.
5. **Drag-to-move confirmed live inside the modal** - a real drag from
   the art's center to a new point on the frame; screenshot shows it
   tracking the cursor exactly. Confirmed via JS inspection that
   `state.character.restSpriteTransform` was STILL `null` at this exact
   point mid-interaction - the modal's local `draft` variable is genuinely
   separate from committed state, matching the same "don't touch state
   until Done" convention `openCardEditor` already uses, now verified for
   real rather than only by reading the source.
6. **Drag-to-resize confirmed live** - dragged the corner handle outward;
   screenshot shows the art growing while staying anchored at its
   top-left corner, and staying a perfectly round circle throughout (the
   test image was a circle specifically to make any `object-fit`
   distortion visually obvious) - `object-fit:contain` confirmed correct
   in practice, not just by CSS inspection. Still uncommitted draft state.
7. **"Reset position" confirmed** - snapped the draft exactly back to the
   default box (`x:16.14 y:22.51 width:26.54 height:33.18`), still
   without touching `state.character.restSpriteTransform` (still `null`).
8. **"Done" confirmed committing correctly** - performed a fresh real
   drag+resize, then clicked Done: `state.character.restSpriteTransform`
   picked up the exact final dragged/resized numbers, `localStorage`'s
   stored JSON picked up the identical values (confirming a real `save()`
   call fired, not just an in-memory update), the modal closed, and the
   SMALL preview's own stage inline style updated to match immediately -
   all as one atomic commit, exactly as designed.
9. **Reload persistence confirmed** - a real full page navigation/reload
   (not a soft in-page state reset) came back with the exact same
   `restSpriteTransform` values still applied to the small preview, and
   zero console errors logged at any point across the whole reload.
10. **Cleanup confirmed** - removed the test asset (mirroring the real
    "Remove" button's own code path) and reset `restSpriteTransform` back
    to `null`, then reloaded once more to directly confirm Tyler's real
    project was left in its exact original blank state - no leftover test
    asset, no leftover transform, nothing to clean up on his end.

Zero console errors were observed at any point in the entire sequence.

### What this closes

Both earlier Rest sprite rounds today explicitly flagged the same caveat
when they shipped: "no local Playwright/browser environment is available
in this sandbox; Tyler should do one quick manual pass to confirm." That
caveat is now retired for this specific mechanic - the drag/resize/modal
flow is confirmed working end to end in Tyler's own real, live app, via
real DOM events and a real reload, not simulated state pokes or static
code reading. This is also the first round in this project's whole history
where a UI interaction has been live-verified this way; noted in
`claude/status.md`'s Key Facts as a capability now available for future
rounds (with the caveat that it only works because Tyler's own instance
was already running - there's still no way to spin up and drive a fresh
instance unattended from this sandbox).

### Delivered

No code changes this round - verification only. Test asset and transform
were added and then fully removed from Tyler's real project as part of the
sequence above; his project is unchanged from before this round started.

## Round: Starting deck quantities silently reset on bulk add/remove — real bug, fixed (2026-09-01)

Tyler, verbatim (a quick aside during the shop-sprite live test): "adding
a card to the starting deck will reset the quantities of cards currently
in the starting deck."

Confirmed real, in `frontend/index.html`. `character.startingDeckCardIds`
is a flat array of card ids with no dedup - a card's "quantity" is just
how many times its id repeats in the array (see the Quantities dropdown's
own `startingDeckGroups()`/`setStartingDeckQty()`). Both bulk selection-bar
buttons ("+ Starting deck" / its remove counterpart) rebuilt that array by
round-tripping it through a JS `Set` - `new Set(state.character.
startingDeckCardIds)` then `Array.from(set)` - which deduplicates
EVERY element, not just the ones the click was actually about. Any card
already sitting above qty 1 (set via the Quantities dropdown) silently
collapsed back down to a single copy on every bulk add OR remove click,
even ones targeting a completely different card.

**Fix**: replaced the Set round-trip in both handlers.
- Add: `state.character.startingDeckCardIds.concat(additions)`, where
  `additions` is only the newly-selected ids not already present at all -
  every existing entry (including duplicates) is left untouched. Matches
  the original code's own comment ("a fresh copy... rather than stacking
  another copy on top of an existing one") without the collateral reset.
- Remove: `state.character.startingDeckCardIds.filter(id=>!removeIds.
  has(id))` - removes every copy of each selected card (matching this
  button's own "take it out of the starting deck" semantics), leaves every
  other card's count alone.

### Verification

`node --check` on the extracted inline script: clean. Ran both new
handler bodies verbatim in a real `node -e` snippet against a synthetic
`state` (5 strikes + 1 defend, matching Tyler's own scenario shape):
adding a new card ("bash") left the 5 strikes at 5 and simply appended
bash; removing "defend" afterward left the 5 strikes untouched and
dropped defend entirely. Both matched expected behavior exactly.

**Delivered**: `frontend/index.html` only, edited directly on Tyler's
machine via `device_bash`. No backend/schema/compiler.js change needed -
this was purely a frontend array-mutation bug, `startingDeckCardIds`'s
on-disk shape is unaffected.

## Round: Export zip contained the entire raw build tree, not just the installable dll/pck/json - fixed (2026-09-01)

Tyler, verbatim: "when exporting the character from forge, it compiles
correctly as a zip, but the files that it outputs inside of the zip are
not in the correct file format. it should only contain the json, the pck,
and the dll for the character in order for the game to recognize it."

Confirmed real, in `backend/server.js`'s `/api/compile` handler. The zip
step (`archive.directory(tempDir, false)`) zipped the ENTIRE `tempDir` on
every request - the full `generateProject()` output (raw generated C#
source: `Cards/`, `Relics/`, `Characters/`, `CardPools/`, `RelicPools/`,
`PotionPools/`, `Powers/`, `Generated/`), the full `pack/` Godot project
(including its own `.godot/` build cache), `bin/`/`obj/` build artifacts,
`mod.csproj`, `ModEntry.cs` - none of which the game needs to load a mod.
The actual installable `<modId>.dll`/`.pck`/`.json` were ALSO present, but
nested one level deep inside `output/<modId>/`, not at the zip's own
top level. Dragging that whole zip's contents into a real
`mods/` folder produced a folder full of irrelevant source/build noise
with the 3 files the game actually scans for (a flat `mods/<modId>/`
folder holding exactly its own `.dll`/`.pck`/`.json`) buried one directory
too deep - exactly the "not in the correct file format" symptom.

**Fix**: on a successful compile, the zip now contains only three things,
scoped explicitly rather than dumping the whole `tempDir`:
- `README.md` (compile report, unchanged content/purpose)
- `Forge_Project/` (character_project.json + its own README, for
  re-importing into Forge later - unchanged, still included)
- a top-level `<modId>/` folder holding exactly `<modId>.dll`/`.pck`/
  `.json` - the same shape as a real `mods/<modId>/` folder. The
  intermediate copy step that used to land these files at
  `tempDir/output/<modId>/` now lands them directly at `tempDir/<modId>/`
  instead, matching what the zip step needs. The README's own text was
  updated to match (was pointing at the old `output/<modId>/` path).

The raw generated C# source (`Cards/`, `pack/`, `mod.csproj`, etc.) is no
longer included in a SUCCESSFUL compile's zip at all - it was never
useful to the end user there, only during the build itself. The
FAILURE-path zip (when `dotnet build` fails, the zip ships the raw
generated source for inspection - deliberate, pre-existing, documented
behavior) is untouched; Tyler's report was specifically about a
successful compile, and that path already serves a real, different
purpose (letting someone see why their build broke).

### Verification

`node --check backend/server.js`: clean. Built a standalone simulation
(`archiver` is already a real dependency of this backend) against a
synthetic `tempDir` containing README.md, a Forge_Project/ folder, an
installable TestMod/ folder (dll/pck/json), and a pile of realistic junk
(Cards/SomeCard.cs, bin/, obj/, pack/.godot/, mod.csproj) - the exact new
code path (copied verbatim from the edited handler) produced a real
6-entry zip containing ONLY README.md, Forge_Project/README.md,
Forge_Project/character_project.json, TestMod/TestMod.dll,
TestMod/TestMod.json, TestMod/TestMod.pck - confirmed by listing the real
zip's contents. None of the junk made it in.

No local dotnet/Godot toolchain here (standing sandbox caveat, same as
every round) - this verifies the zip-assembly LOGIC directly and
completely (the actual risk here was purely a Node/archiver packaging
bug, not a compiler/schema issue), but Tyler re-exporting a real
character through the running app is still the real-world confirmation
this project's convention calls for.

**Delivered**: `backend/server.js` only, edited directly on Tyler's
machine via `device_bash`. Needs a backend restart to take effect (same
recurring gotcha as every other `server.js` change in this project) -
Forge caches the old `require()`'d module otherwise.

## Round: exported characters never showed up in the character select screen at all - likely root cause found (missing Localization/CharacterLoc), fixed (2026-09-01)

Tyler, during the shop-sprite live test: "Spine shop test does not show up
as a character in the selection screen. TestChar didnt either. This is a
good modding template for STS2, lets reference that and see if we have
done anything wrong. https://github.com/Alchyr/ModTemplate-StS2"

This is bigger than the shop-sprite test itself - BOTH SpineShopTest AND
the real, previously "successfully compiled and installed" TestChar mod
(Round 25/26) fail to appear as a playable character at all. Every prior
round's "success" only ever confirmed `dotnet build` succeeding and the
files landing in the mods folder - nobody had confirmed a Forge-built
character actually renders as SELECTABLE in-game before this round,
because no live-browser-equivalent existed for the actual game until this
session's Round 28 browser-pane work, and even that only reached Forge's
own web UI, not the game itself.

### Chasing the real ModTemplate-StS2 repo (Tyler's own suggestion)

Directory listings are blocked (`/tree/`, `api.github.com`) but individual
file blobs work, same tooling note as Round 27. The repo's `master` branch
(not `main`) README names its 3 real templates ("Slay the Spire 2
Character" / "Content" / "Mod") and points to a wiki Setup guide. That
guide's own words, quoted directly:

> "If using the character template and you get an error related to
> localization, the project is set up correctly."
>
> "If you are using the character template, you will need to generate the
> localization for the character. Open the character class in
> `YourModCode/Character/YourMod.cs`. It should have two errors like
> this; one for "character" localization and one for "ancient"
> localization."
>
> "For each one, push alt+enter and choose "Generate localization", then
> move the generated text to the appropriate file
> (`localization/eng/characters.json` and `localization/eng/ancients.json`)."

So the OFFICIAL, sanctioned workflow for a character mod REQUIRES real
localization content for the character (and, separately, for a companion
"ancient" - see the open question below) - not an optional nicety. Forge
generated neither, for any character, ever.

### Finding the real in-code equivalent (no Rider available in this
### pipeline, so the IDE quick-fix isn't an option - had to find BaseLib's
### own programmatic path instead)

Rather than trying to replicate an IDE code-gen quick-fix's file output
blind, went straight to the real, installed `BaseLib.dll` with this
project's own `ecma_dump.py` ECMA-335 reader (same tool used earlier this
session for the `AddedNode<,>` namespace fix). Confirmed directly,
[VERIFIED] tier:

- `BaseLib.Abstracts.CustomCharacterModel` implements
  `BaseLib.Abstracts.ILocalizationProvider`, which declares
  `public abstract List<(string,string)> Localization { get; }` -
  **the exact same override point `card.description` already uses for
  cards** (`Localization => new CardLoc(title, description)`, see
  `generateCardLocalization` - this was already a proven, working
  pattern, just never extended to the character itself).
- `BaseLib.Abstracts.CharacterLoc` is a real record - characters' own
  CardLoc-equivalent - with a confirmed implicit conversion to that exact
  `List<(string,string)>` shape. Its real constructor (14 required string
  fields + an `ExtraLoc` tail array), read directly off the real
  assembly, not guessed:
  `CharacterLoc(string Title, string TitleObject, string Description,
  string PronounObject, string PronounSubject, string PronounPossessive,
  string PossessiveAdjective, string AromaPrinciple, string
  EndTurnPingAlive, string EndTurnPingDead, string EventDeathPrevention,
  string GoldMonologue, string CardsModifierTitle, string
  CardsModifierDescription, (string,string)[] ExtraLoc)`.

No `Character.cs.template` had EVER emitted a `Localization` override -
every exported character compiled and installed clean but registered no
name/title/description anywhere the game's own loc tables could find it.
Strong circumstantial evidence this is why nothing has ever shown up on
the character select screen, cross-confirmed by the official template's
own setup guide treating this as a required step, not polish.

### The fix

New `generateCharacterLocalization(character)` in `backend/compiler.js`,
wired into `Character.cs.template` via a new `{{localizationOverride}}`
placeholder (same pattern `generateCardLocalization`/card art overrides
already use). Field mapping:

- `Title`/`TitleObject` <- `character.name` (schema-backed; TitleObject
  reuses the same proper noun - names don't inflect).
- `Description` <- `character.shortDescription` (schema-backed).
- `PronounObject`/`PronounSubject`/`PronounPossessive`/
  `PossessiveAdjective` <- derived from `character.gender`
  (schema-backed, [VERIFIED] enum) via ordinary English grammar - a real,
  correct mapping for all 3 enum values (Neutral -> they/them/their/
  theirs), not a guess.
- Everything else (`AromaPrinciple`, `EndTurnPingAlive`/`Dead`,
  `EventDeathPrevention`, `GoldMonologue`, `CardsModifierTitle`/
  `Description`) - no schema field collects this narrative/flavor text
  yet. Deliberately did NOT repurpose `character.lore[]` for this (that
  field is explicitly `[DESIGN-TIME PREVIEW ONLY, not compiled]` -
  reusing it here would have silently broken that documented contract).
  Defaulted to `character.shortDescription`/`character.name` instead, so
  the character compiles and registers with REAL text everywhere the
  game looks rather than empty strings of unknown consequence - clearly
  marked `[BEST EFFORT placeholder]` in the generated C# comment. A
  dedicated authoring UI for this content (13 real narrative fields) is
  a real, unscoped future feature, not attempted this round.

### Verification

`node --check` on both `backend/compiler.js` and (via the extracted
inline-script check used elsewhere this session) unaffected files: clean.
Ran `generateProject()` directly against Tyler's own real, current
`Forge_Project/character_project.json` (from the TestChar/SpineShopTest
export) - confirmed the generated `Characters/TestCharCharacter.cs` now
contains a real `Localization => new CharacterLoc(...)` block with every
field populated (Title/TitleObject/Description = "Test Char"/"No
description yet.", pronouns correctly "him"/"he"/"his"/"his" matching the
character's own real `Gender => CharacterGender.Masculine`), zero
unresolved `{{...}}` template placeholders, balanced braces/parens. No
local `dotnet build` toolchain in this sandbox (standing caveat, same as
every round) - **this needs a real Tyler rebuild + relaunch to confirm
the character now actually appears on the select screen**, which is the
real test this whole investigation was chasing.

### Open question, NOT resolved this round: the "ancient" half

The wiki's own quote above says the character template raises errors for
BOTH character AND ancient localization - `BaseLib.Abstracts.
CustomAncientModel` is confirmed real (found via the same ecma_dump.py
sweep), and `BaseLib.Patches.Content.AddCustomAncientsToPool`/
`CustomAncientExistence` suggest ancients get registered into their own
pool at mod load, separate from the playable character itself. Whether a
character mod NEEDS a companion Ancient class registered for the
character itself to appear on the select screen (vs. Ancients being a
separate, later-game mechanic that's independently missing but not
select-screen-blocking) is genuinely unknown - Forge generates no Ancient
content at all today, and this round didn't have time to chase that
class's own real shape the way CharacterLoc got chased. **This is the
next lead to pull if Tyler rebuilds and the character STILL doesn't
appear** - not chased further this round since the Localization gap alone
is already well-evidenced enough to be worth testing first in isolation.

**Delivered**: `backend/compiler.js`, `backend/templates/
Character.cs.template` - both edited directly on Tyler's machine via
`device_bash`. Needs Tyler to `dotnet build` (in whichever project copy
he's testing - spine-shop-test and/or a fresh real TestChar export both
pick this up, since it's a compiler.js/template change, not tied to
either project specifically) and relaunch the game.


---

## Round 28, continued: THE actual root cause — manifest missing `has_pck`/`has_dll`

**Context**: Tyler rebuilt with the Localization/CharacterLoc fix above,
restarted the backend, recompiled the character, and relaunched the game.
The character STILL did not appear in the character select screen. Tyler
also reported: "the game sees the mod, it loads correctly and is checked,
but it does not appear in the selection screen" and provided the real
game log path: `C:\Users\Tyler Whitmore\AppData\Roaming\SlayTheSpire2\
logs`. This is the first time this project has had direct access to a
real game log file - previous rounds relied entirely on static analysis
of decompiled DLLs and Forge's own generated output.

**What the log showed**: `godot.log` contains, for both `TestChar` and
`SpineShopTest` (Forge's own exports):

```
[WARN] Neither a DLL nor a PCK was loaded for mod TestChar, something seems wrong!
[WARN] Neither a DLL nor a PCK was loaded for mod SpineShopTest, something seems wrong!
```

with **zero** preceding `[INFO] Loading assembly DLL ...` / `[INFO]
Loading Godot PCK ...` lines for either mod - the loader skips straight
past the load step. Compare this to the real, working `TheBurdenedNewCharacter`
mod's log entries for the exact same load pass, which show all three
expected steps in order:

```
[INFO] Loading assembly DLL ... TheBurdenedNewCharacter.dll
[INFO] Loading Godot PCK ... TheBurdenedNewCharacter.pck
[INFO] Calling initializer method ...
```

**Ruled out first**: confirmed via `device_list_dir` that the actual
`.dll`/`.pck`/`.json` files DO exist, correctly named and correctly
sized, in both `mods/TestChar/` and `mods/SpineShopTest/` on disk. This
is not a missing-file problem - the loader has the files but isn't even
trying to load them.

**Root cause, found by direct comparison of manifest JSON, not guessed**:
read and diffed Forge's generated `TestChar.json` against two real,
independently-verified WORKING mods' manifests already installed on
Tyler's machine - `TheBurdenedNewCharacter.json` and `BaseLib.json`.
Forge's manifest omits the `has_pck` and `has_dll` fields entirely. Both
real working manifests explicitly declare:

```json
"has_pck": true,
"has_dll": true
```

This directly explains the log: the loader is almost certainly gating its
own "attempt to load DLL" / "attempt to load PCK" steps on these two
manifest flags, and since Forge never wrote them, both steps get skipped
for every Forge-exported mod - which produces exactly the WARN line seen
above instead of the three INFO lines a working mod gets.

**Where this came from in Forge's own code**: `backend/compiler.js`'s
`buildManifestJson(characterPackage, modId)` had an existing code comment
that turns out to have been simply WRONG - a previous [BEST EFFORT] guess
recorded without real evidence:

```
// has_pck / has_dll deliberately omitted — see TOOLCHAIN_FINDINGS.md
// "The manifest": best-effort read is that the game computes those
// itself when scanning the mods folder, not that we should write them.
```

This assumption is now disproven by direct evidence (the log file itself,
plus two independent real working manifests). The game does NOT compute
these itself - it reads them from the manifest, and skips loading
anything for a mod that doesn't declare them.

**Significance**: this is very likely THE actual, previously-undiscovered
root cause explaining why NO Forge-exported character has EVER appeared
as playable in-game across this entire project's history - a more
fundamental gap than the Localization/CharacterLoc fix (which was real
and necessary, since a character with no Localization would likely show
up nameless/blank even if it did load, but was not, on its own,
sufficient to make the mod load at all).

**Fix applied**: `backend/compiler.js`'s `buildManifestJson()` now
hardcodes `has_pck: true, has_dll: true` in the returned manifest object,
with the disproven comment replaced by one documenting this evidence
trail. Since every Forge character mod ships both a DLL and a PCK by
construction (there's no Forge codepath that produces a DLL-only or
PCK-only character mod), hardcoding `true` for both is correct for every
case Forge can currently produce - this isn't a narrowing of what Forge
supports, just filling in two fields that were always true and always
should have been written.

**Verified [VERIFIED, not just BEST EFFORT this time]**:
- `node --check backend/compiler.js` - clean.
- A real `generateProject()` run against Tyler's actual
  `spine-shop-test/Forge_Project/character_project.json` project file
  (same technique used to verify the Localization fix) - inspected the
  resulting `mod.csproj`'s baked `<ModManifestContent>` block directly and
  confirmed it now reads:
  ```json
  {
    "id": "TestChar",
    "name": "Test Char",
    "author": "Unknown",
    "description": "",
    "version": "1.0.0",
    "dependencies": [{ "id": "BaseLib", "min_version": "3.4.1" }],
    "affects_gameplay": true,
    "has_pck": true,
    "has_dll": true
  }
  ```
  matching the real working mods' shape exactly.

**Not yet verified**: a real Tyler rebuild + backend restart + relaunch
test to confirm the character now actually appears on the select screen.
This is the critical, still-outstanding real-world test - if this is
truly the root cause, it should resolve the symptom on its own, even
without the "ancient" open question (above) being chased further. If the
character STILL doesn't appear after this fix, the ancient-registration
lead is the next one to pull.

**Delivered**: `backend/compiler.js` only, edited directly on Tyler's
machine via `device_bash`. Needs Tyler to recompile (any project copy -
this is a compiler.js change, so it applies to any future Forge export,
not tied to one project) and restart the backend first (compiler.js is
loaded by `server.js` at startup, same as the earlier Localization fix),
then relaunch the game.


---

## Round 28 continued: ⚠ CRITICAL — has_pck/has_dll fix caused the game to fail to launch entirely

**Immediate action taken**: Tyler reported the game failed to launch twice
after installing the freshly-recompiled TestChar (built with the
has_pck/has_dll manifest fix above). Since a game that won't launch at
all is strictly worse than a mod that silently doesn't appear, both
`mods/TestChar` and `mods/SpineShopTest` were moved out of the active
`mods/` folder into a new `mods_disabled/` folder (sibling of `mods/`,
same STS2 install root) via `device_bash` — a plain `mv`, fully
reversible, nothing deleted. **Tyler should now be able to launch the
game normally again** with only `BaseLib`/`TheBurdenedNewCharacter`
active.

**What was investigated, all inconclusive so far**:
- No new `godot.log`/`godotYYYY-MM-DDTHH.MM.SS.log` file exists for
  either failed launch (newest log on disk is from ~6 hours before the
  recompiled TestChar's file mtimes) — the crash happens early/hard
  enough that Godot's own log never gets flushed to disk.
- The game's local Sentry crash-reporter directory
  (`AppData/Roaming/SlayTheSpire2/sentry/`) also has nothing newer than
  that same earlier session — no crash event was captured there either.
  Together these two negative results suggest a very early, hard native
  crash (before the engine's own logging/telemetry initializes), not a
  caught .NET exception the engine could log gracefully.
- Confirmed the actual installed files are NOT obviously corrupt: real
  sizes (TestChar.dll 48640B, TestChar.pck 426604B, TestChar.json 304B),
  and the PCK's binary header is well-formed (`GDPC` magic, pack format
  version 3, engine version 4.5.1 — the exact same pack format version
  and engine version as the real, working `BaseLib.pck`, so pack-format
  compatibility alone doesn't explain it). `TheBurdenedNewCharacter.pck`
  uses the OLDER pack format version 2 (also works fine) — so the game
  tolerates both v2 and v3 packs; format version isn't the discriminator.

**Leading hypothesis, NOT confirmed**: the has_pck/has_dll fix is
necessarily also the FIRST time in this entire project that a
Forge-generated character's actual compiled C# has ever executed inside
the real game process (every previous "successful build" only ever
proved `dotnet build` succeeded — the manifest gate meant the DLL's own
mod-initializer code, including the newly-added `CharacterLoc`/
`Localization` override, had literally never run before now). A runtime
exception thrown during mod initialization (`Calling initializer
method...` in the log, the exact line that never appears for our mods)
is a very plausible culprit, but genuinely unconfirmed — could equally
be something in the PCK's packed resources (a `.tscn`/import-cache
mismatch) rather than the C# code at all. No log/crash-dump evidence
currently distinguishes between these.

**This sandbox has no way to reach further evidence**: no access to
Windows process output, Event Viewer, or a live console (the device
bridge is a Linux VM with only mounted folders, not general Windows
control). **Asked Tyler for**: (1) any visible error dialog text on the
two failed launches, (2) whether launching the game's `.exe` directly
from a terminal (bypassing Steam) shows a console stack trace, and (3)
whether Windows Event Viewer → Windows Logs → Application has an
"Application Error"/".NET Runtime" entry timestamped to either failed
launch, with its exception/module details.

**Status**: has_pck/has_dll fix itself is still believed correct (it
matches real working mods' manifests byte-for-byte, and is the
documented mechanism the loader gates on) — but it has uncovered a
SEPARATE, more serious problem: the first real execution of Forge's own
generated character code appears to crash the game outright. This
downgrades the has_pck/has_dll round's own status from "fix, pending
confirmation the character appears" to "fix confirmed correct in
isolation, but now blocked on a NEW crash-on-load bug before it can be
safely re-tested." TestChar/SpineShopTest remain quarantined in
`mods_disabled/` until this is root-caused.


---

## Round 28 ground-up audit against the real Alchyr.Sts2.Templates package — likely crash root cause found and fixed

**Context**: Tyler asked to go over the entire project from the ground up
using the real official STS2 modding template as the guide (after an
initial link, DarkVexon/ProTemplate, turned out to be for the ORIGINAL
Slay the Spire — Java/Maven/ModTheSpire, a completely different game and
toolchain, confirmed by directly reading its pom.xml — ruled out and not
used). Tyler then pointed back at the real one, `https://github.com/
Alchyr/ModTemplate-StS2/wiki/Setup`, and asked for a full ground-up
review — timed right after the game had failed to launch twice with a
freshly has_pck/has_dll-fixed TestChar installed (see the prior round's
crash writeup and the mods_disabled/ quarantine).

**What was fetched, all real, all verbatim** (GitHub directory/tree
listings are blocked by robots.txt in this sandbox, same limitation noted
in earlier rounds — but individual `/blob/` file-view pages are fetchable,
so every file below was read directly, not guessed):
- The wiki Setup page itself.
- `Alchyr.Sts2.Templates.csproj` (the NuGet template package's own project
  file — confirms this repo IS the source of the real `dotnet new install
  Alchyr.Sts2.Templates` package real STS2 mod authors actually use, not
  just "an example").
- `content/ModTemplate/ModTemplate.csproj` — the REAL mod project file
  every `dotnet new sts2-mod`/Character/Content project is scaffolded
  from.
- `content/ModTemplate/Sts2PathDiscovery.props`
- `content/ModTemplate/project.godot`
- `content/ModTemplate/export_presets.cfg`
- `content/ModTemplate/ModTemplate.json` (the real manifest shape)

**Finding #1 [VERIFIED] — wrong SDK entirely.** The real template's
`ModTemplate.csproj` starts `<Project Sdk="Godot.NET.Sdk/4.5.1"
InitialTargets="CheckDependencyPaths">` — the actual Godot C# SDK, which
provides real MSBuild integration with Godot's own build/export/publish
pipeline (Publish/PackPck targets, Godot source generators, etc). Forge's
`mod.csproj` uses plain `Microsoft.NET.Sdk` and hand-rolls a `project.godot`
file plus a raw `godot --headless --export-pack` shell-out as a `PostBuild`
target — structurally a completely different build system, just one that
happens to also produce a `.dll`+`.pck`+`.json` triplet. NOT changed this
round (a full Godot.NET.Sdk migration is a large, risky rewrite of the
whole compile pipeline — server.js's entire `dotnet build`-based flow,
Godot version auto-detection, etc. — flagged as a real, open architecture
gap, not attempted here) — but this framing matters: it's *why* several of
the more surgical mismatches below (architecture, rendering method) exist
at all, since Forge's export step was never going through Godot's own
real project lifecycle in the first place.

**Finding #2 [VERIFIED] — Build vs Publish.** The wiki is explicit:
"You must publish for any non-code changes (localization, images, scenes)
to show up... For code-only changes, use Build instead, which is faster."
Confirmed directly in the real csproj: `CopyToModsFolderOnBuild`
(`AfterTargets="PostBuildEvent"`) copies only `.dll`/`.json`/`.pdb` on a
plain Build — the actual Godot PCK export (`GodotPublish`, `AfterTargets=
"Publish"`) ONLY runs on `dotnet publish`. Forge instead runs its Godot
export on every plain `dotnet build` (`AfterTargets="Build"`). This
doesn't fully explain the crash on its own (Tyler's builds DO produce a
real, correctly-headered `.pck`), but it's a second confirmation that
Forge's build lifecycle has diverged from the one the real SDK/tooling
was designed around. Not changed this round — noted as a smaller, lower-
priority gap than the two fixes below.

**Finding #3 [VERIFIED, HIGH-CONFIDENCE CRASH CAUSE #1] — wrong export
architecture.** Forge's `export_presets.cfg` had
`binary_format/architecture="x86_64"`. The real template's own generated
preset — and the real `Godot.NET.Sdk` csproj's own code comment,
verbatim: *"Diasble architecture mismatch warning; mods are ideally built
for all platforms (MSIL) while your local StS2 version will be for your
specific platform."* — uses `binary_format/architecture="msil"`. MSIL
(platform-agnostic managed bytecode export) is the explicitly documented,
correct choice for a mod; Forge was exporting an architecture-specific
native pack instead. **Fixed**: `backend/templates/export_presets.cfg`
now uses `architecture="msil"`.

**Finding #4 [VERIFIED, HIGH-CONFIDENCE CRASH CAUSE #2] — wrong/missing
rendering method.** Forge's generated `project.godot` had NO `[rendering]`
section at all (implicit engine default) and tagged
`config/features=PackedStringArray("4.5", "Forward Plus")`. The real
template's `project.godot` explicitly sets
`renderer/rendering_method="mobile"` under `[rendering]`, and tags
features as `("4.5", "C#", "Mobile")` — meaning the actual game itself
almost certainly runs the Mobile renderer, not Forward+. Godot's Forward+
and Mobile renderers use genuinely different shader/material compilation
paths; a resource pack built under the wrong one being merged into a
running game using the other is a very plausible native-crash cause,
independent of anything in the mod's own C# code. **This is very likely
why the game failed to launch outright** the moment has_pck/has_dll made
it actually try to load a Forge-built PCK for the first time. **Fixed**:
`backend/templates/ModProject.csproj.template`'s `GenerateProjectGodot`
target now emits the exact same `[rendering] renderer/rendering_method=
"mobile"` section and `("4.5", "C#", "Mobile")` features array as the
real template.

**Finding #5 [VERIFIED] — missing `min_game_version` manifest field.**
The real template's `ModTemplate.json` includes a top-level
`"min_game_version": "0.107.0"` field (that template's own version at
time of publish); Forge's manifest never had this field at all. Fixed
properly, not hardcoded: `backend/gameLocator.js` already had a
`readReleaseInfo()` helper (from an earlier round, previously only used
for the README's "Game version" display line) reading the real
installed game's own `release_info.json` — confirmed against Tyler's
actual install: `{"version": "v0.111.0", ...}`. `server.js`'s
`/api/compile` handler now calls `currentGame()` BEFORE
`generateProject()` (it's a cheap synchronous filesystem check, safe to
move earlier) and threads the real, live-detected version
(`"0.111.0"`, `v` prefix stripped to match the real template's unprefixed
field) through a new `opts.gameVersion` parameter into
`generateProject()`/`buildManifestJson()`. Falls back to omitting the
field (same as before) if no game install is found — an honest gap, not
a guess, matching this project's usual convention.

**Finding #6 [VERIFIED, matched already]** — BaseLib min_version
(`BASELIB_MIN_VERSION = '3.4.1'` in compiler.js) already matches Tyler's
real installed BaseLib version exactly; `has_pck`/`has_dll` (fixed last
round) match the real manifest's fields exactly. Both independently
reconfirmed correct by this same real-template diff, not just by the
earlier working-mod comparison.

**Not chased further this round, explicitly flagged as open**:
- Full Godot.NET.Sdk migration (Finding #1) — a large rewrite, not
  attempted.
- Build-vs-Publish lifecycle split (Finding #2) — Forge's current
  Build-triggers-export approach isn't proven wrong on its own, just
  divergent from the documented real workflow; revisit if the two fixes
  above don't fully resolve the crash.
- `.godot/` import cache / whether a project that's never been opened in
  the actual Godot editor before `--export-pack` is invoked packs
  resources correctly — not directly tested, lower-priority than the two
  concrete config mismatches above.
- The Character-specific real template project
  (`Alchyr.Sts2.Templates`'s "Slay the Spire 2 Character" option) and its
  Ancient-class requirement — the open question flagged two rounds ago —
  wasn't re-examined this round; still open.

### Verification

`node --check` clean on both `backend/compiler.js` and `backend/server.js`.
A real `generateProject()` run against Tyler's actual `spine-shop-test`
project file, passing `{ gameVersion: '0.111.0' }` (matching what
server.js now derives live), confirmed the generated `mod.csproj`'s baked
manifest now includes `"min_game_version": "0.111.0"` in the right place,
and its baked `project.godot` content now includes the `[rendering]`
section and corrected features array verbatim. `export_presets.cfg`
confirmed on disk: `architecture="msil"`, `modify_resources=false`,
`exclude_filter="mod_manifest.json"` (also brought in line with the real
template, which excludes its own manifest file from the packed
resources — lower-priority cosmetic/hygiene fix, not a crash cause on its
own). No local `dotnet build`/Godot toolchain in this sandbox (standing
caveat) — **this needs a real Tyler rebuild + install + relaunch to
confirm the crash is actually gone**, which is the real test this round
was chasing.

**Delivered**: `backend/templates/export_presets.cfg`,
`backend/templates/ModProject.csproj.template`, `backend/compiler.js`,
`backend/server.js` — all edited directly on Tyler's machine via
`device_bash`. Needs Tyler to restart the backend (compiler.js/server.js
changes), then recompile TestChar fresh (NOT just reinstall the
quarantined build in `mods_disabled/` — that build still has the old
x86_64/Forward-Plus pack baked in) and try launching again.


---

## Round 28 continued: game now LAUNCHES with a real Forge mod loaded — new crash found and fixed via real game log evidence (AddKeyword-in-constructor bug)

**Progress confirmed**: after the msil/mobile-renderer fixes above, Tyler
reinstalled TestChar and relaunched — this time the game actually
launched far enough to write a real log file (a first — every previous
attempt after has_pck/has_dll produced no log at all, meaning an
instant hard native crash). `godot.log` now shows the full expected
mod-loading sequence succeeding for real, for the first time ever:

```
[INFO] Loading assembly DLL ...\TestChar\TestChar.dll
[INFO] Loading Godot PCK ...\TestChar\TestChar.pck
[INFO] Calling initializer method of type ModEntry for TestChar, Version=1.0.0.0, ...
[INFO] Finished mod initialization for 'Test Char' (TestChar).
```

This directly confirms: the msil/mobile-renderer fixes were correct and
necessary — the game's earlier instant-crash was real and is now gone.
Tyler still reported "still an issue with starting the game" though —
the log's story continues past mod initialization into a NEW, different,
much more specific and useful failure:

```
[ERROR] System.Reflection.TargetInvocationException: Exception has been thrown by the target of an invocation.
 ---> MegaCrit.Sts2.Core.Models.Exceptions.CanonicalModelException: Canonical model of type TestChar.Cards.StressTestCard used in incorrect place.
   at MegaCrit.Sts2.Core.Models.AbstractModel.AssertMutable()
   at MegaCrit.Sts2.Core.Models.CardModel.AddKeyword(CardKeyword keyword)
   at TestChar.Cards.StressTestCard..ctor()
   at System.RuntimeType.CreateInstanceDefaultCtor(...)
   at MegaCrit.Sts2.Core.Models.ModelDb.Init_Patch9(Type[] injectedModelTypes)
   at MegaCrit.Sts2.Core.Helpers.OneTimeInitialization.ExecuteEssential_Patch1()
   at MegaCrit.Sts2.Core.Nodes.NGame.GameStartup()
```

**Root cause, found and fixed for real this time — not a guess**:
`ModelDb.Init_Patch9` is the game's own canonical-model registration
pass: it instantiates one canonical (read-only template) instance of
every card/relic/character from every loaded mod at startup, by calling
each type's parameterless constructor via reflection. Forge's card
codegen (`generateKeywordCalls` in `compiler.js`, wired into
`Card.cs.template`'s constructor body) called `AddKeyword(CardKeyword.X)`
directly inside the constructor for every keyword a card has. `AddKeyword`
is a MUTATING method meant for a live, in-play card instance — calling it
on the canonical template being built by `Init_Patch9` throws exactly
this `CanonicalModelException`, and this happens during ESSENTIAL game
startup (`ExecuteEssential_Patch1` -> `NGame.GameStartup`), not something
scoped to just this card or mod — very plausibly why the game still
wouldn't finish starting even after the earlier two fixes.

**The real, correct mechanism was already documented in this exact
project since round 10** — and had simply never been wired up for
keywords specifically, a genuine leftover oversight rather than new
research: `CardModel.CanonicalKeywords` (confirmed real via direct
sts2.dll metadata read: `public virtual IEnumerable<CardKeyword>`) is a
declarative, read-only override property — the exact same pattern
already used correctly for `CanonicalTags` (base card tag) and
`CanonicalVars` (dynamic vars). In fact, `generateCanonicalTagsOverride`'s
own existing code comment cited `CanonicalKeywords` BY NAME as its
confirmed-real evidence anchor ("same override shape as the already-real
CanonicalKeywords") — the parallel was already known, just never applied
to keywords themselves until now.

**Fixed**: `generateKeywordCalls` (compiler.js) renamed to
`generateCanonicalKeywordsOverride`, now emits
`public override IEnumerable<CardKeyword> CanonicalKeywords => new[] { ... };`
as a class-level override instead of constructor statements.
`Card.cs.template`'s `{{keywordCalls}}` constructor-body placeholder
removed entirely; a new `{{canonicalKeywordsOverride}}` class-member
placeholder added next to the existing `{{canonicalTagsOverride}}`/
`{{canonicalVarsOverride}}` ones.

**A self-inflicted bug caught and fixed during this same edit**: the
explanatory header comment initially written into `Card.cs.template`
accidentally included the literal `{{canonicalKeywordsOverride}}` token
INSIDE its own comment text (describing "the {{canonicalKeywordsOverride}}
placeholder below") — since `fillTemplate` does a global find-and-replace
across the whole file, not scoped to one intended slot, this duplicated
the generated override into the comment block too. Caught immediately by
a real `generateProject()` verification run (the override appeared
twice, once inside a comment) and fixed by rewording the comment to not
use the double-brace syntax literally. Documented here as a reminder for
future template edits: never write a literal `{{token}}` string inside
a template's own prose/comments.

### Verification

`node --check` clean. A real `generateProject()` run against Tyler's
actual `spine-shop-test` package (which contains the real `StressTestCard`
that threw in-game) confirmed the generated `StressTestCard.cs` now
contains exactly ONE `CanonicalKeywords =>` override
(`new[] { CardKeyword.Exhaust, CardKeyword.Ethereal, CardKeyword.Innate }`)
and zero real `AddKeyword(...)` calls (only inside explanatory comment
text). No local `dotnet build`/game toolchain in this sandbox (standing
caveat) — **this needs a real Tyler rebuild + install + relaunch to
confirm the game actually finishes starting this time**, the real test
this round was chasing.

**Delivered**: `backend/compiler.js`, `backend/templates/Card.cs.template`
— both edited directly on Tyler's machine via `device_bash`. Needs Tyler
to restart the backend (compiler.js change) and recompile TestChar FRESH
before testing again.


---

## Round 28 continued: character-select click crash — CardPool/RelicPool/PotionPool were being re-constructed (and re-registered) on every access, fixed

**Context**: after the AddKeyword->CanonicalKeywords fix, Tyler reported
the game launched successfully this time, but clicking the button to go
into character select made the game stop working. Read the real log
(`godot.log`) directly — this project's evidence keeps getting stronger
round over round instead of guessing.

**What the log showed**: TWO occurrences of the same exception. The
FIRST happens quietly during ordinary main-menu startup
(`NGame.LaunchMainMenu` -> `LoadDeferredStartupAssetsAsync` ->
`ModelDb.Preload_Patch2()`) and is apparently tolerated/swallowed
somewhere (the main menu still loads fine). The SECOND happens the
moment the player clicks into character select
(`NCharacterSelectScreen.SelectCharacter_Patch4`, reading a relic's pool
to build its hover description) — and this one is NOT recovered from;
`NGame.Quit()` is called immediately after, which is what Tyler saw as
"the game stopped working" (a clean-looking shutdown with save writes,
not a native crash — but from the player's side, indistinguishable from
the game just closing on you).

```
[ERROR] MegaCrit.Sts2.Core.Models.Exceptions.DuplicateModelException:
ModelDb already contains ID RELIC_POOL.TESTCHAR-TEST_CHAR_RELIC_POOL
mapped to type TestChar.RelicPools.TestCharRelicPool, but you are trying
to map it to type TestChar.RelicPools.TestCharRelicPool. Possible causes:
 - You have called a constructor on an AbstractModel. Use ModelDb instead.
 - There is a conflict in mod content names.
   at MegaCrit.Sts2.Core.Models.AbstractModel..ctor()
   at MegaCrit.Sts2.Core.Models.RelicPoolModel..ctor()
   at BaseLib.Abstracts.CustomRelicPoolModel..ctor()
   at TestChar.RelicPools.TestCharRelicPool..ctor()
   at TestChar.Characters.TestCharCharacter.get_RelicPool()
```

**Root cause, found by direct log reading, not guessed**: Forge's
`Character.cs.template` generated `RelicPool` (and, structurally
identically, `CardPool`/`PotionPool`) as an expression-bodied property:
`public override CustomRelicPoolModel RelicPool => new
{{relicPoolClassName}}();` — constructing a BRAND NEW pool instance on
EVERY property access. Every `AbstractModel` subclass in this game's
framework (cards, relics, powers, pools, characters — everything this
whole project has been reverse-engineering) self-registers into a global
`ModelDb` under a fixed ID inside its own base constructor — the exact
same "canonical, singleton, constructed once" pattern behind the
AddKeyword/CanonicalKeywords bug fixed earlier this same round. Calling
`new TestCharRelicPool()` a second time re-runs that same self-
registration under the same fixed ID a second time, which the game
explicitly rejects with `DuplicateModelException`.

**Fixed**: `Character.cs.template`'s `CardPool`/`RelicPool`/`PotionPool`
properties now each return a cached, once-constructed private field
(`private readonly TestCharRelicPool _relicPool = new
TestCharRelicPool();`, initialized once when the character model itself
is constructed — which, per the exact same canonical/singleton pattern,
ModelDb also only ever does once) instead of constructing fresh on every
access. `CardPool`/`PotionPool` had the byte-for-byte identical bug lying
in wait — not yet independently observed throwing in Tyler's own
playtest, but structurally identical to the one that did, so fixed
alongside `RelicPool` rather than waiting to individually hit each one.

**Explicitly flagged, NOT independently verified**: `CardPool.cs.
template`'s `GenerateAllCards()` (and the equivalent `GenerateAllRelics`/
`GenerateAllPotions` on the other two pool types) constructs each
individual card/relic/potion model instance fresh inside its own body
(`new RareAttackCard()` etc., inside `{{generateAllCardsExprs}}`) — if
the base `CardPoolModel` class calls this abstract method more than once
per pool instance (rather than the much more likely pattern: calling it
ONCE and caching the returned list internally, matching every other
"canonical, register once" pattern in this framework), the exact same
DuplicateModelException would recur one level deeper, for individual
cards instead of the pool itself. No direct evidence either way yet —
the naming ("Generate", not "Get"/a plain property) and the pool-level
fix above (a pool is now itself only ever constructed once) both suggest
this is fine, but this is an assumption, not a confirmed fact. If Tyler
hits a NEW `DuplicateModelException` naming an individual card/relic/
potion type (not a pool type) after this round's fix, this is the first
place to look next.

### Verification

`node --check` clean (compiler.js itself untouched this round — this was
a template-only fix). A real `generateProject()` run against Tyler's
actual package confirmed the generated `TestCharCharacter.cs` now
declares all three cached fields and returns them from the three pool
properties, with correct types (`TestCharCardPool`/`TestCharRelicPool`/
`TestCharPotionPool`) matching the real class names used elsewhere in the
same generated project. No local `dotnet build`/game toolchain in this
sandbox (standing caveat) — **needs a real Tyler rebuild + install +
relaunch + a real click into character select to confirm this specific
crash is gone**, the real test this round was chasing.

**Delivered**: `backend/templates/Character.cs.template` only — edited
directly on Tyler's machine via `device_bash`. No backend restart needed
for this one alone (template-only, no compiler.js logic changed) — but
recompile TestChar FRESH regardless, since the underlying character
package still needs regenerating from the updated template either way.


---

## Round 28 continued: the pool-caching fix was wrong too — real fix is ModelDb's own generic lookup accessors, not `new` at all

**Context**: Tyler recompiled/reinstalled with the pool-caching fix and
reported another problem starting the game. Read the new log — the
caching fix reduced but did not eliminate the bug; it just moved where it
threw.

**What the log showed**: the SAME `DuplicateModelException` for
`RELIC_POOL.TESTCHAR-TEST_CHAR_RELIC_POOL`, but this time thrown from
INSIDE `TestCharCharacter`'s own constructor (the cached field's
initializer), during `ModelDb.Init_Patch9` — the game's own essential
startup registration pass — not from a second property access like
before:

```
   at MegaCrit.Sts2.Core.Models.RelicPoolModel..ctor()
   at TestChar.RelicPools.TestCharRelicPool..ctor()
   at TestChar.Characters.TestCharCharacter..ctor()     <- now thrown from the cached field initializer itself
   at System.RuntimeType.CreateInstanceDefaultCtor(...)
   at MegaCrit.Sts2.Core.Models.ModelDb.Init_Patch9(Type[] injectedModelTypes)
```

**The real explanation** (this is the piece that was missing from the
earlier "cache it" fix): `TestCharRelicPool` — like every AbstractModel
subclass in a mod's assembly, every Card/Relic/Power/Pool class — is
ALSO independently discovered and constructed exactly once by
`ModelDb.Init_Patch9`'s own reflection scan over `injectedModelTypes`,
completely separately from anything the character class itself does.
Any `new SomeModel()` call ANYWHERE in generated code outside that one
reflection-driven registration path collides with it — a cached field is
still one construction too many, just less often triggered than the
original bug (only collides once, at startup, instead of on every
access). The exception's own text says this outright: "You have called a
constructor on an AbstractModel. Use ModelDb instead."

**The real, correct mechanism — confirmed via direct sts2.dll metadata
read of `ModelDb`, not guessed**: a full `MethodDef` dump of
`MegaCrit.Sts2.Core.Models.ModelDb` turned up a whole family of real,
public, generic, static lookup accessors, one per model category —
`Card()`, `CardPool()`, `Character()`, `Potion()`, `PotionPool()`,
`Power()`, `Relic()`, `RelicPool()`, `Orb()`, `Affliction()`,
`Enchantment()`, `Event()`, `AncientEvent()`, `Monster()`, `Encounter()`,
`Act()`, `Singleton()`, `Badge()`, `Achievement()`, `Modifier()` — every
one returning the method's own generic type parameter (`!!0` in the raw
metadata dump), i.e. `public static T Card<T>()` /
`public static T RelicPool<T>()` etc. — real, type-safe accessors that
return the ALREADY-canonically-registered singleton instance of type T,
never constructing anything themselves.

**This pattern was already correctly used elsewhere in this exact
codebase** — `generateAllCardsExprs`/`generateAllRelicsExprs`/
`startingDeckExprs`/`startingRelicExprs` in `compiler.js` already emit
`ModelDb.Card<T>()`/`ModelDb.Relic<T>()` for every card/relic reference,
confirmed correct and never flagged as a problem (StartingDeck/
StartingRelics/GenerateAllCards/GenerateAllRelics all use it). The
character's own `CardPool`/`RelicPool`/`PotionPool` properties were
simply never brought in line with this same established, working
convention — both prior attempts (raw `new`, then a cached field)
missed it.

**Fixed for real this time**: `Character.cs.template`'s `CardPool`/
`RelicPool`/`PotionPool` now read:
```csharp
public override CustomCardPoolModel CardPool => ModelDb.CardPool<{{cardPoolClassName}}>();
public override CustomRelicPoolModel RelicPool => ModelDb.RelicPool<{{relicPoolClassName}}>();
public override CustomPotionPoolModel PotionPool => ModelDb.PotionPool<{{potionPoolClassName}}>();
```
No `new` anywhere in these three lines — the cached-field approach from
the previous round's fix is fully removed, not just patched further.

### Verification

A real `generateProject()` run against Tyler's actual package confirmed
the generated `TestCharCharacter.cs` now uses all three `ModelDb.
XPool<T>()` calls with zero `new TestCharXPool()` constructions anywhere
in the file. No local `dotnet build`/game toolchain in this sandbox
(standing caveat) — **needs a real Tyler rebuild + install + relaunch to
confirm the game now finishes starting**, the real test this round was
chasing.

**Delivered**: `backend/templates/Character.cs.template` only — edited
directly on Tyler's machine via `device_bash`. Template-only change, no
backend restart needed, but recompile TestChar FRESH regardless (the
character package needs regenerating from the updated template).

---

## Character-select click crash #3 — the REAL, final root cause: `StartingRelics[0]` with no empty check in the base game itself (2026-09-01)

**Tyler's report** (the first-ever confirmation a Forge character reached the select screen): "i can now get into the character selection screen and i see the test char. when i click on him though, it will not allow me to actually select him. no art appears for the splash, the box isn't highlighted."

This looked at first like it might be related to the three `[ERROR] Failed to load resource synchronously:` lines also present in the same log (a missing per-character `char_select_bg_*.tscn`, a missing `*_locked.png`, and a missing `*_transition_mat.tres`) — but those are all non-fatal (each falls back to sync load, then to "Using an empty background", and the game keeps running). They are the same pre-existing, deliberate "Select screen background: NOT exported (design-time preview only)" gap already documented in `writeCharacterArt()`'s header comment and in `character.schema.json` — not new, and not what's blocking selection.

The real blocker was found a few lines further down the same `godot.log`, immediately after the FMOD "select" sound plays:

```
ERROR: System.ArgumentOutOfRangeException: Index was out of range. Must be non-negative and less than the size of the collection. (Parameter 'index')
   at System.Collections.Generic.List`1.get_Item(Int32 index)
   at MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen.SelectCharacter_Patch4(NCharacterSelectScreen this, NCharacterSelectButton charSelectButton, CharacterModel characterModel)
   at MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectButton.Select_Patch1(NCharacterSelectButton this)
```

(repeats 4 times in the log — once per click Tyler made.)

**Root-caused via real IL disassembly**, not guesswork: staged `sts2.dll` (`data_sts2_windows_x86_64/sts2.dll`) straight off Tyler's install into the cloud workspace and ran the project's own hand-rolled CIL disassembler (`ildisasm.py`, built in an earlier round on top of `ecma_dump_ext.py`) against `MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen::SelectCharacter` (the "_Patch4" suffix in the log is just how the game's own patch-numbering shows up in a stack trace — the real method name is plain `SelectCharacter`). The exact IL:

```
IL_0245: ldarg.2
IL_0246: callvirt MegaCrit.Sts2.Core.Models.CharacterModel::get_StartingRelics
IL_024b: ldc.i4.0
IL_024c: callvirt System.Collections.Generic.IReadOnlyList<RelicModel>::get_Item
IL_0251: stloc.s 4
```

i.e. `characterModel.StartingRelics[0]` — read unconditionally, with **no `Count` check at all**, every single time a character is clicked, purely to populate the info panel's relic title/description/icon. If `StartingRelics` is empty, this throws `ArgumentOutOfRangeException` right there, the exception unwinds out of the whole click handler, and everything AFTER that point in the method (button highlight, splash-art swap, embark-button enable) never runs — which is exactly Tyler's symptom: no highlight, no splash art, nothing happens.

**Why every Forge character has hit this, always, until now:** `character.startingRelicId` has been a real field in `schema/character.schema.json` and wired all the way through `backend/compiler.js`'s `generateProject()` (`startingRelicExprs` → `ModelDb.Relic<T>()`) since long before this round — but **the frontend never had ANY control to set it.** `grep`ing `frontend/index.html` for `startingRelicId` before this fix found exactly one hit, a hint string on an unrelated condition kind — zero UI wiring. So `StartingRelics` has been an empty `List<RelicModel> { }` for every character anyone has ever exported from Forge, guaranteeing this exact crash the moment the character got far enough to be clickable — which, until this round's launch fixes (msil/mobile-renderer/CanonicalKeywords/ModelDb-pool-lookup), no character ever had.

Confirmed directly against Tyler's real `character_project.json` (`spine-shop-test/Forge_Project`): `character.startingRelicId` is absent, and none of TestChar's 6 relics have `rarity: "Starter"` — exactly the crash condition.

**The fix (3 parts, all shipped this round):**

1. **`backend/compiler.js`** — `startingRelicIdRaw` now resolves `character.startingRelicId` first, and if that's unset, falls back to the first relic in `relics[]` with `rarity === 'Starter'` (the same real-game concept the base game itself uses for this — e.g. Ironclad's Burning Blood is `RelicRarity.Starter`, and Forge's relic-rarity dropdown already had a "Starter" option that nothing consumed). This makes an existing saved project with a Starter-rarity relic "just work" on next compile with zero action needed.
2. **`backend/validate.js`** — hard compile-blocking error if NEITHER an explicit `startingRelicId` NOR any Starter-rarity relic resolves, so it is now impossible to export a character guaranteed to crash on click. Verified against Tyler's real `character_project.json`: `valid: false`, with the new message, before any fix; `valid: true` after setting either.
3. **`frontend/index.html`** — new "Starting relic" dropdown in the Relics panel head, wired to `state.character.startingRelicId`, re-rendered on every `renderRelics()` call (so add/rename/delete relics keeps it in sync) plus a ★ badge on the chosen relic's tile and a visible warning when nothing's chosen yet.

**Verification (real `generateProject()` runs against Tyler's actual package, both paths):**
- Explicit `startingRelicId` set to one of TestChar's 6 relics → `valid: true`, generated `Characters/TestCharCharacter.cs` contains `public override IReadOnlyList<RelicModel> StartingRelics => new List<RelicModel> { ModelDb.Relic<Group1Relic>() };`
- No explicit id, one relic's `rarity` changed to `"Starter"` → same result, resolves to that relic automatically.
- Package as Tyler actually has it saved right now (neither) → `valid: false` with the new, clear error message, correctly blocking export instead of shipping a silent crash.

**What Tyler needs to do to unblock TestChar specifically:** open Forge in the browser, refresh the page (picks up the new frontend), go to the Relics panel, use the new "Starting relic" dropdown to pick one of the 6 existing relics (any of them — this doesn't need to be a special one, it just needs to exist so `StartingRelics` isn't empty), then recompile/reinstall/relaunch and try selecting the character again. The backend (`server.js`/`compiler.js`/`validate.js`) needs a restart to pick up the compiler/validator changes since Node caches `require()`d modules at process start — a browser refresh alone is NOT enough for those two files, only for `index.html`.

---

## Black screen on embark — three missing character-select assets, one of them fatal (2026-09-01)

**Tyler's report** (right after the StartingRelics fix above): "another error was thrown before i git a black screen" — he could now click and select TestChar (confirming the fix above worked), but pressing Embark produced a new crash and a black screen.

Read the newest `godot.log`: the click-to-select fix worked completely (relic loc/atlas warnings for "Group 1" now resolve, the select SFX plays). The new failure is on Embark:

```
[ERROR] Exception starting singleplayer run : MegaCrit.Sts2.Core.Assets.AssetLoadException: Asset previously failed to load: res://materials/transitions/testchar-test_char_character_transition_mat.tres. The game installation may be corrupted.
   at MegaCrit.Sts2.Core.Assets.AssetCache.LoadAsset_Patch1(AssetCache this, String path)
   at MegaCrit.Sts2.Core.Assets.AssetCache.GetAsset(String path)
   at MegaCrit.Sts2.Core.Assets.AssetCache.GetMaterial(String path)
   at MegaCrit.Sts2.Core.Nodes.NTransition.FadeOut(Single time, String transitionPath, Nullable`1 cancelToken)
   at MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen.StartNewSingleplayerRun(String seed, List`1 acts)
   ...
ERROR: System.NullReferenceException: Object reference not set to an instance of an object.
   at MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen.OnEmbarkPressed_Patch3(NCharacterSelectScreen this, NButton _)
```

`AssetCache` had already tried (and failed) to preload this same asset earlier, during the select-screen's own preload pass (the `[ERROR] Failed to load resource synchronously:` lines documented in the previous section) — this second attempt, on Embark, hits the cached failure and throws a hard `AssetLoadException` instead of retrying, which the game's own Embark handler doesn't catch, producing the `NullReferenceException` right after and the black screen (the fade transition never completes).

### Root-caused via real IL, not guesswork

Disassembled `MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen`'s compiler-generated `<StartNewSingleplayerRun>d__55.MoveNext()` (the real async body — the outer method is just the async trampoline) and found the exact call:

```
IL_0172: callvirt MegaCrit.Sts2.Core.Models.CharacterModel::get_CharacterSelectTransitionPath
IL_0181: callvirt MegaCrit.Sts2.Core.Nodes.NTransition::FadeOut
```

Then disassembled `CharacterModel`'s three character-select asset-path getters directly (`get_CharacterSelectBg`, `get_CharacterSelectIconPath`, `get_CharacterSelectLockedIconPath`, `get_CharacterSelectTransitionPath`) and found ALL FOUR are built the exact same convention-based way — `"<fixed prefix>" + AbstractModel.Id.Entry.ToLowerInvariant() + "<fixed suffix>"` — e.g.:

```
=== get_CharacterSelectTransitionPath
IL_0000: ldstr 'res://materials/transitions/'
IL_0005: ldarg.0
IL_0006: call MegaCrit.Sts2.Core.Models.AbstractModel::get_Id
IL_000b: callvirt MegaCrit.Sts2.Core.Models.ModelId::get_Entry
IL_0010: callvirt System.String::ToLowerInvariant
IL_0015: ldstr '_transition_mat.tres'
IL_001a: call System.String::Concat
IL_001f: ret
```

Critically: `get_CharacterSelectBg` and `get_CharacterSelectTransitionPath` are **NOT virtual** — there is no C# override point at all. `get_CharacterSelectIconPath`/`get_CharacterSelectLockedIconPath` ARE virtual, but a check of `BaseLib.dll` (`BaseLib.Abstracts.CharacterSelectTransitionPath.Custom` etc., a Harmony prefix patch) showed BaseLib's own override mechanism (`CustomCharacterModel.CustomCharacterSelectTransitionPath` etc.) only helps if it returns a REAL non-null path — there's no "opt out" value. **The only real fix, for all three, is to place a real Godot resource at the exact conventional path.**

### `ModelId.Entry` is NOT `character.id` — traced the real slug algorithm

The path is keyed on `AbstractModel.Id.Entry`, not the schema's `character.id` field directly. Traced the whole chain: `AbstractModel..ctor` → `ModelDb.GetId(Type)` → `ModelDb.GetEntry(Type)` → `StringHelper.Slugify(type.Name)` (i.e. the **C# class name**, not the schema id) — and read the exact real regex patterns straight out of sts2.dll's own metadata (3 source-generated `[GeneratedRegex]` classes):

```
CamelCaseRegex:   ([A-Za-z0-9]|\G(?!^))([A-Z])   -> '$1_$2'
                  (then .ToUpperInvariant())
WhitespaceRegex:  \s+                             -> '_'
SpecialCharRegex: [^A-Z0-9_]                      -> ''
```

Confirmed against two independent real examples straight from Tyler's own log: class `TestCharCharacter` → entry `TEST_CHAR_CHARACTER` (note: NOT `TEST_CHAR`, which is what `character.id` alone gives — Forge's className is `${modId}Character`, one word longer); class `Group1Relic` → entry `GROUP1_RELIC`. Ported as `slugifyClassName()` in `backend/compiler.js`, applied to the generated class name (`${modId}Character`), lowercased for the res:// paths.

### Extracted a real, working example straight out of Tyler's own compiled mod

Wrote a minimal Godot `.pck` reader (`GDPC` format, pack_version 2 — no existing tool for this in `tools/sts2tools`) and pulled `char_select_bg_the_burdened.tscn` + its `.gd` script straight out of `TheBurdenedNewCharacter.pck`. This **overturns an earlier-round belief** ("the real game uses a full animated Godot scene here... Forge can't author scenes," presented to and accepted by Tyler as a permanent limitation) — the real file is nothing of the kind:

```gdscript
extends TextureRect

func _ready():
	if ResourceLoader.exists("res://images/packed/portraits/theburdenednewcharacter_bg.png"):
		texture = load("res://images/packed/portraits/theburdenednewcharacter_bg.png")
```
```
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scenes/screens/char_select/char_select_bg_the_burdened.gd" id="1"]

[node name="Bg" type="Control"]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2

[node name="Background" type="TextureRect" parent="."]
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2
expand_mode = 1
stretch_mode = 6
mouse_filter = 2
script = ExtResource("1")
```

Just a `Control` + one child `TextureRect`, loading a flat PNG by hand — exactly the shape Forge already knows how to generate. The `format=3` header value was also empirically confirmed this way (this exact game's Godot 4.5.1 build uses format 3 for text resources), rather than assumed.

Same mod's `.pck` was also checked for a locked-icon PNG and a transition-material `.tres` — **it ships neither**, and evidently doesn't need to (locked-state art likely never renders for an always-unlocked mod character; the transition material's absence would presumably crash it on Embark exactly like TestChar, if Tyler has ever actually pressed Embark with that character — untested/unknown either way). This is why the transition-material fix below is unconditional rather than tied to any upload.

### The fix (all in `backend/compiler.js`'s `writeCharacterArt`/`generateProject`, no C# template changes needed)

1. **Transition material (the fatal one, fixed unconditionally, every export)**: writes a minimal, valid, all-default `CanvasItemMaterial` resource —
   ```
   [gd_resource type="CanvasItemMaterial" format=3]

   [resource]
   ```
   — to `pack/materials/transitions/{modid}-{entry}_transition_mat.tres`. `CanvasItemMaterial` needs no shader/texture of its own and is a real `Material` subtype (the type `AssetCache.GetMaterial()` requires), so this is the smallest resource that satisfies the load without inventing any character-specific visual effect.
2. **Locked icon** (best-effort, free): if Select screen art was uploaded, the same PNG is also written to `pack/images/packed/character_select/char_select_{modid}-{entry}_locked.png`.
3. **Select screen background** (now real, not preview-only): if `selectScreenBackgroundAssetRef` was uploaded, writes the PNG plus a generated `.gd` + `.tscn` in the exact real shape shown above, to `pack/scenes/screens/char_select/char_select_bg_{modid}-{entry}.tscn` (+ `.gd`). If nothing was uploaded, unchanged graceful "empty background" fallback (confirmed non-fatal).

None of the three needed any C# override — all three getters resolve by naming convention alone (two aren't even virtual), so this is purely an asset-writing change; `Character.cs.template` is untouched.

**Verified** via a real `generateProject()` run against Tyler's actual `character_project.json`: generated paths match the real crash-log paths byte-for-byte —
```
materials/transitions/testchar-test_char_character_transition_mat.tres
images/packed/character_select/char_select_testchar-test_char_character_locked.png
scenes/screens/char_select/char_select_bg_testchar-test_char_character.tscn (+ .gd)
```
— and Tyler's project already has a `selectScreenBackgroundAssetRef` upload, so the background scene generates for him with no further action needed. `character.schema.json`'s `selectScreenBackgroundAssetRef` description and `frontend/index.html`'s matching comment were both updated to drop the now-incorrect "permanently preview-only" framing.

**What Tyler needs to do**: same as the StartingRelics fix — refresh the browser (no frontend UI changed this round, but harmless), **restart the backend server** (compiler.js changed, needs a fresh `require()`), recompile, reinstall, relaunch, select the character, and press Embark. If a run actually starts this time, that's the real, final test this whole investigation has been chasing.

---

## Still a black screen after the transition-material fix — the SAME crash pattern, one asset later (2026-09-02)

**Tyler's report**: "ok, i got past character select. my mouse was able to move, but i did not load into the first scene properly. still a black screen." — confirms the transition-material fix worked (Embark no longer crashes immediately), but the run still doesn't actually start.

Read the newest `godot.log`: during the character-select preload pass (`Preloading 'characters=TESTCHAR-TEST_CHAR_CHARACTER' Complete: assets=41`), FIVE more convention-based per-character scene paths fail to load, and one of them is fatal — the exact same `AssetLoadException` → `NullReferenceException` → aborted-run pattern as the transition material, just on a different asset:

```
[ERROR] Failed to load resource synchronously: res://scenes/creature_visuals/testchar-test_char_character.tscn
[ERROR] Failed to load resource synchronously: res://scenes/ui/character_icons/testchar-test_char_character_icon.tscn
[ERROR] Failed to load resource synchronously: res://scenes/rest_site/characters/testchar-test_char_character_rest_site.tscn
[ERROR] Failed to load resource synchronously: res://scenes/merchant/characters/testchar-test_char_character_merchant.tscn
[ERROR] Failed to load VFX scene: res://scenes/vfx/card_trail_testchar-test_char_character.tscn
...
ERROR: MegaCrit.Sts2.Core.Assets.AssetLoadException: Asset previously failed to load: res://scenes/ui/character_icons/testchar-test_char_character_icon.tscn. The game installation may be corrupted.
...
[ERROR] Exception starting singleplayer run : System.NullReferenceException: Object reference not set to an instance of an object.
```

Only `character_icons/*_icon.tscn` actually threw — the other four only produced the soft warn+error (same non-fatal shape the char-select background/locked-icon used to, before being fixed).

### IL confirms the same family of getters, all resolved by `SceneHelper.GetScenePath(prefix + Entry.ToLowerInvariant() + suffix)`, none virtual except IconPath:

```
get_TrailPath          'vfx/card_trail_'          + entry            not virtual
get_VisualsPath         'creature_visuals/'        + entry            not virtual
get_IconPath            'ui/character_icons/'      + entry + '_icon'  VIRTUAL (on CharacterModel itself)
get_MerchantAnimPath    'merchant/characters/'     + entry + '_merchant'  not virtual
get_RestSiteAnimPath    'rest_site/characters/'    + entry + '_rest_site' not virtual
```

Checked `TheBurdenedNewCharacter.pck` again for real examples: it ships a real `character_icons/the_burdened_icon.tscn` + `.gd` (same trivial TextureRect-with-script shape as the char-select background scene — real content pulled below), confirming this is a real requirement every working character mod satisfies. It ships **no** `creature_visuals` and **no** `vfx/card_trail_*` file at all, matching the two that stayed non-fatal in Tyler's log — real evidence these two are safe to leave alone for now (same as before: don't guess without evidence, and `CreateVisuals()`'s `NCreatureVisuals` return type suggests a meaningfully more complex real node shape than the trivial ones fixed so far, not something to improvise blind). Its `rest_site`/`merchant` scenes exist too, but at the mod's OWN custom filenames (e.g. `theburdenednewcharacter_rest_site.tscn`, no `characters/` subfolder) — meaning that mod overrides `CustomRestSiteAnimPath`/`CustomMerchantAnimPath` (BaseLib's real virtual hook, confirmed in an earlier round) rather than relying on the convention-default path Forge's TestChar falls back to since Tyler chose not to export Rest/Shop sprite art.

Real extracted example (`the_burdened_icon.gd`/`.tscn`):
```gdscript
extends TextureRect

func _ready():
	if ResourceLoader.exists("res://images/packed/portraits/theburdenednewcharacter_hud_icon.png"):
		texture = load("res://images/packed/portraits/theburdenednewcharacter_hud_icon.png")
```
```
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scenes/ui/character_icons/the_burdened_icon.gd" id="1"]

[node name="Icon" type="TextureRect"]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2
expand_mode = 1
stretch_mode = 5
mouse_filter = 2
script = ExtResource("1")
```

Reuses their own HUD icon PNG — same pattern as the char-select background scene, just a bare `TextureRect` instead of `Control`+`TextureRect`.

### The fix (`backend/compiler.js`'s `writeCharacterArt`, no C# template changes)

1. **Character icon scene (the fatal one, unconditional, every export)**: generates `pack/scenes/ui/character_icons/{modid}-{entry}_icon.tscn` + `.gd` in the exact real shape above, reusing the already-exported HUD icon PNG if uploaded, else the Select screen art PNG, else no texture at all (still a valid loadable scene, just blank) — so this can never again be the reason a run fails to start, regardless of what art is uploaded.
2. **Rest site / Merchant scenes (defensive, not yet confirmed fatal)**: writes a minimal, textureless, valid `TextureRect` placeholder scene at both real convention paths (`scenes/rest_site/characters/...`/`scenes/merchant/characters/...`). Tyler's explicit choice to keep Rest sprite/Shop sprite preview-only stands — this doesn't add real art, it only prevents a THIRD black-screen report if/when this character reaches a campfire or shop, since these fail via the exact same soft-then-hard pattern already proven twice.
3. **creature_visuals and vfx/card_trail — deliberately left alone**, backed by real evidence (TheBurdenedNewCharacter.pck ships neither and evidently works fine): still non-fatal in Tyler's own log, and worth chasing only if a future report shows otherwise.

**Verified** via a real `generateProject()` run against Tyler's actual package — all generated paths match the crash-log paths byte-for-byte, `.gd` script content and tab formatting confirmed correct, `validateCharacterPackage` still passes clean.

### A note on tooling hygiene this round

Writing these fixes hit a real self-inflicted bug worth remembering: editing `compiler.js` via a Python triple-quoted heredoc string with un-doubled `\t`/`\n` sequences let Python's own string escaping consume them as real tab/newline characters before they ever reached the JS file, corrupting two `.join('\n')` calls into `.join('` + a literal newline + `')` — a real `SyntaxError`, caught immediately by the now-standard `node --check` verification step before ever reaching Tyler. Fixed by re-doing the edit with properly doubled `\\t`/`\\n` (matching the convention already used successfully in this same session's earlier edits) and swept the whole file for stray raw tab characters afterward to confirm none remained.

**What Tyler needs to do**: same as before — restart the backend server (compiler.js changed again), recompile, reinstall, relaunch, select the character, press Embark. If a run actually starts and the first scene loads, that's the real finish line.

---

## Still a black screen after Neow — the REAL root cause: `_gradientTransition` left permanently opaque by `RoomFadeOut`/`RoomFadeIn`

**Tyler's report (verbatim):** "ok, i heard neow (the first scene). but the screen stayed black. there also wasn't a selection sound when i clicked on my testchar like there is for everyone else. it changes depending on who you select though, so it may be something we have to set."

This confirmed game logic was progressing correctly (Neow's dialogue audio plays, mouse moves, no fatal exceptions in `godot.log`) — the screen itself just never became visible. The only anomaly in the log was:

```
[INFO] Preloading 'Event Room' Complete: assets=2 time_elapsed=238ms
[WARN] NTransition.Material is null or not a ShaderMaterial (actual: CanvasItemMaterial). Skipping transition.
[INFO] [BaseLib] Checking for additional interactions with NEOW
```

### Investigation

The previous fix (see "Black screen on embark" section above) made `CharacterModel.CharacterSelectTransitionPath` resolve to a real file by exporting a minimal `CanvasItemMaterial` `.tres`. That fixed the `AssetLoadException` crash on Embark, but a `CanvasItemMaterial` is not a `Godot.ShaderMaterial`, and it turns out `NTransition` has *two different* fade code paths in the real game, which handle that type-mismatch very differently:

1. **`NTransition.FadeOut`/`FadeIn`** (used by the Embark button itself, main menu transitions, "load a saved run", etc. — confirmed via full IL disassembly plus a token-level call-site scan of every method in `sts2.dll`) tween `_simpleTransition`'s `modulate:a` unconditionally, *before* checking `this.Material` for `ShaderMaterial`. This is what covers the screen when Embark is pressed and is why that part always worked.

2. **`NTransition.RoomFadeOut`/`RoomFadeIn`** — the methods actually used when entering a room (confirmed via IL disassembly of `RunManager.EnterRoomWithoutExitingCurrentRoom`, which is what `NGame.StartNewSingleplayerRun` uses for the very first room of a fresh run: it calls `RunManager.FadeOut()` → `NTransition.RoomFadeOut`, then `RunManager.EnterRoomInternal(room)` (loads Neow's room), then `RunManager.FadeIn(true)` → `NTransition.RoomFadeIn`) — behave asymmetrically:
   - `RoomFadeOut` **unconditionally**, with **no ShaderMaterial check at all**, sets `_gradientTransition.Modulate.A = 1.0` (fully opaque) as one of its very first actions.
   - `RoomFadeIn` casts `this.Material` to `ShaderMaterial`. When that cast fails (our `CanvasItemMaterial`), it logs exactly the `[WARN] ... Skipping transition.` line seen in Tyler's log, resets **only `_simpleTransition`**'s alpha back to 0, and returns immediately. The line that resets `_gradientTransition` back to transparent is inside the ShaderMaterial-success branch and is *never reached* on the failure path.

**Net effect:** `_gradientTransition` — a full-screen `CanvasItem` — is set fully opaque by `RoomFadeOut` and then never cleared by `RoomFadeIn`, because our material fails its type check. It stays opaque forever, permanently covering the screen, even though `_simpleTransition` correctly becomes transparent and the game underneath is running fine. This exactly matches Tyler's report: audio confirms game logic progressed, but the screen stays black.

Confirmed via direct IL disassembly of (all against the real `sts2.dll`, no guessing):
- `NTransition.RoomFadeOut`'s `<RoomFadeOut>d__18.MoveNext()` — the unconditional `_gradientTransition.Modulate.A = 1.0` set, with no material check gating it.
- `NTransition.RoomFadeIn`'s `<RoomFadeIn>d__19.MoveNext()` — the ShaderMaterial check, the `[WARN] ... Skipping transition.` log call (byte-for-byte the same string seen in Tyler's log), and the early `leave` that skips the `_gradientTransition` reset.
- `RunManager.EnterRoomWithoutExitingCurrentRoom`'s `<EnterRoomWithoutExitingCurrentRoom>d__205.MoveNext()` — confirms the real call sequence `RunManager.FadeOut()` → `EnterRoomInternal(room)` → `RunManager.FadeIn(true)`.
- `NTransition..cctor` — confirms the exact shader uniform name the real game drives: `NTransition._threshold` is a `Godot.StringName` initialized to the literal `"threshold"`, and `NTransition._thresholdTweenPath` is a `Godot.NodePath` initialized to `"shader_parameter/threshold"`.

A call-site scan (token-level scan of every method body in `sts2.dll` for `call`/`callvirt` instructions targeting `NTransition.FadeOut`/`FadeIn`/`RoomFadeOut`/`RoomFadeIn`'s exact `MethodDef` tokens) was used to positively identify `NCharacterSelectScreen.StartNewSingleplayerRun` as Tyler's real Embark call site (confirmed by its "Embarking on a singleplayer ... run. Ascension: ... Seed: ..." log string) and to trace the actual room-transition call path, rather than guessing from method names alone — a naive by-name match (`<StartRun>d__34`) turned out to belong to the *multiplayer* "load a saved run" flow, a red herring caught only by reading the disassembled body's own field references.

### Fix

`writeCharacterArt()` in `backend/compiler.js` no longer exports a plain `CanvasItemMaterial` for the character-select transition material. It now exports a real `ShaderMaterial` `.tres` plus a minimal attached `.gdshader`:

```
materials/transitions/{modid}-{entry}_transition_mat.tres   (ShaderMaterial, ext_resource -> the shader below)
materials/transitions/{modid}-{entry}_transition_shader.gdshader
```

The shader is intentionally minimal — it does not attempt to reproduce the real game's actual gradient-wipe visual (we don't have that shader's source), it only needs to (a) be a real `Godot.ShaderMaterial` so `isinst ShaderMaterial` succeeds in both `RoomFadeIn` and the generic `FadeIn`/`FadeOut`, letting their full logic run (including the `_gradientTransition` reset), and (b) expose a `uniform float threshold` — the exact name the real C# drives via `SetShaderParameter`/`TweenProperty("shader_parameter/threshold", ...)` — so those calls succeed rather than silently no-op against a missing uniform:

```glsl
shader_type canvas_item;
uniform float threshold : hint_range(0.0, 1.0) = 0.0;
void fragment() {
    COLOR = vec4(0.0, 0.0, 0.0, threshold);
}
```

`threshold` at 0.0 = fully transparent (revealed), 1.0 = fully opaque black (covered) — matching the direction the real game's own `FadeOut`/`FadeIn` tween it (0→1 on FadeOut, 1→0 on FadeIn).

**Verified:** `node --check backend/compiler.js` passes. A real `generateProject()` run against Tyler's actual `character_project.json` produces both files at the exact conventional paths with the expected content (`ShaderMaterial` resource correctly referencing the shader via `ext_resource`, shader correctly declaring the `threshold` uniform).

### Tooling note: an off-by-one bug in this session's own ad-hoc IL analysis scripts

While tracing which `<StartRun>d__NN`/`<StartNewSingleplayerRun>d__NN` nested async state-machine type belonged to which real outer class, several ad-hoc scripts passed `NestedClass.EnclosingClass` directly into `MetadataReader.typedef_full_name()`, which expects a 0-based Python list index — but per ECMA-335, `NestedClass.EnclosingClass` (like `NestedClass.NestedClass` itself) is a **1-based** `TypeDef` RID (this is exactly why `ecma_dump_ext.py`'s own `nested_types_of()` subtracts 1 from both). This produced plausible-looking but *wrong* owning-class names (e.g. `RunRngSet` instead of the correct `RunManager`) for several lookups, which were only caught by cross-checking the disassembled method body's own field references against the claimed owning class and noticing a mismatch. All conclusions in this section were re-derived with the off-by-one corrected and cross-checked against real IL field references before being relied on.

---

## Card added to deck never leaves the screen — missing `vfx/card_trail_{entry}.tscn` crashes the fly-to-deck animation mid-`_Ready()`

**Tyler's report (verbatim):** "i got past neow, but it added a card to my deck and it never left my screen. normally there is an animation of it going to the deck and it will leave the screen"

### Investigation

Fetched Tyler's freshest `godot.log` and found exactly two `System.NullReferenceException` occurrences in the entire run, both part of the same single incident, right after `[INFO] [BaseLib] Checking for additional interactions with NEOW`:

```
ERROR: Error loading resource: 'res://scenes/vfx/card_trail_testchar-test_char_character.tscn'.
[WARN] Asset not cached: res://scenes/vfx/card_trail_testchar-test_char_character.tscn
ERROR: System.NullReferenceException: Object reference not set to an instance of an object.
   at MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx.Create_Patch1(Control card, String characterTrailPath)
   at MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyVfx._Ready()
   ...
   at MegaCrit.Sts2.Core.Commands.CardCmd+<>c__DisplayClass29_0.<PreviewInternal>b__1()
```

`NCardFlyVfx` is the node responsible for animating a card flying to the deck (confirmed via IL: it's what `CardCmd`'s card-preview flow — used both for Neow adding a card and, per the stack trace's own generality, likely any "obtain/preview a card" moment — spawns). Its `_Ready()` calls `NCardTrailVfx.Create(card, characterTrailPath)` to attach a decorative particle trail behind the flying card. Direct IL disassembly of `NCardTrailVfx.Create` (sts2.dll) confirms the exact bug:

```
call PreloadManager.Cache
ldarg characterTrailPath
callvirt AssetCache.GetScene      // returns null if the file doesn't exist
callvirt PackedScene.Instantiate  // <-- NO NULL CHECK. Throws NullReferenceException on a null PackedScene.
```

`CharacterModel.TrailPath` (`'vfx/card_trail_' + entry`, routed through `SceneHelper` → `res://scenes/...`) is **not virtual** — same shape as every other convention-based asset path found this investigation. This file was previously believed safe to skip (see the "Still a black screen after the transition-material fix" section above — `creature_visuals`/`vfx/card_trail` were "deliberately left alone" because `TheBurdenedNewCharacter.pck` doesn't ship either, and the *only* prior evidence was that a background **preload** attempt logs a soft, non-fatal `[ERROR] Failed to load VFX scene` and moves on (via `AssetLoadingSession.ProcessVfxQueue`, confirmed still true — that early preload failure earlier in the same log is genuinely non-fatal). That conclusion was correct as far as it went, but incomplete: it covered only the *background preload* path. The **live, on-demand** path — actually flying a card, e.g. when Neow adds one — goes through `NCardFlyVfx._Ready()` → `NCardTrailVfx.Create()` instead, which has no defensive null-check at all and throws for real. Godot's C# bridge catches the exception at the outermost call boundary (`CSharpInstanceBridge.Call`) and just logs it — the game doesn't crash — but `NCardFlyVfx._Ready()` itself aborts partway through, before whatever tween/animation logic was supposed to run next, leaving the card node frozen in place forever. This exactly matches Tyler's report.

Confirmed only 2 `NullReferenceException`s total in the entire log (both this one incident) — this is an isolated, well-understood bug, not a symptom of something broader. `creature_visuals` was re-checked against this same log and still shows only the soft/non-fatal preload-failure pattern (16 occurrences, zero exceptions) — no new evidence it's live-crashing anywhere, so it remains deliberately deferred.

### A placeholder scene would NOT have been safe here

Unlike the character-icon/rest-site/merchant fixes (round 27), a bare placeholder `TextureRect` scene is not a safe fix for this one. `NCardTrailVfx` is a real compiled game class with its own `_Ready()`/`_Process()` — almost certainly doing `GetNode<Line2D>(...)`/`GetNode<CPUParticles2D>(...)` lookups for named child nodes it expects to exist (confirmed once the real scene was extracted — see below: `Trails/OuterTrail`, `Trails/InnerTrail`, `Sprites/BigSparks`, etc.). `GetNode<T>` throws if the path doesn't resolve. A structurally-empty placeholder would very likely just trade this exact crash for an equally-fatal one one level deeper, inside the trail's own `_Ready()`.

### Extracting the real scene — extending the project's own `.pck` reader to support pack_format_version 3

The base game's own `SlayTheSpire2.pck` (2GB) uses `pack_format_version 3`, which this project's `.pck` reader (written in an earlier round, GDPC v1/v2 only) didn't support — this was previously set aside as out of scope. It was worth fixing this round: fetched the real Godot engine source (`core/io/file_access_pack.cpp`, `PackedSourcePCK::try_open_pack`) directly from `godotengine/godot` on GitHub to get the authoritative v3 layout rather than guessing from raw bytes. The real difference from v2: instead of "16 reserved uint32 fields, then the directory follows immediately," v3 reads a `uint64 dir_offset` right after `file_base` and seeks there before reading `file_count`/the per-file entries — the directory can live anywhere in the file (in practice, at the very end, after all file data). Verified empirically against the real header bytes of Tyler's own `SlayTheSpire2.pck`: `pack_flags=2`, `file_base=112` (which, before the fix, pointed straight at the first file's raw content — a giveaway something was missing), and the recovered `dir_offset` correctly locates a real 15,890-entry directory. `pck_stream.py` (the project's streaming, multi-GB-safe reader) now supports v1/v2/v3.

With that working, extracted the real base game's own `res://scenes/vfx/card_trail_ironclad.tscn` (the base game ships one per built-in character — ironclad/silent/defect/necrobinder/regent — confirming "Regent" from an earlier round's class-name red herring is in fact a real base character codename, not a multiplayer artifact). All five are structurally identical (same `ext_resource`s, same node tree, same sub-resources), differing only in per-node tint colors — a shared, recolorable VFX. Root node: `Node2D` with `script = ExtResource(...)` → `res://src/Core/Nodes/Vfx/NCardTrailVfx.cs`; children `Trails/OuterTrail` and `Trails/InnerTrail` (`Line2D`, script `NCardTrail.cs`) and `Sprites/BigSparks`/`LittleSparks`/two `Sprite2D`s — all built from the base game's own shared VFX textures/materials (`images/packed/vfx/trail.png`, `themes/canvas_item_material_additive_shared.tres`, etc.), nothing character-authored.

### Fix

Bundled that real scene (with every `uid="uid://..."` attribute stripped — Godot resolves `ext_resource`/`gd_scene` references by `path=` alone just fine without one; keeping the real game's own uid on our copy would have claimed the *same* resource-cache ID as the real `card_trail_ironclad.tscn`, and reusing one fixed uid across multiple different Forge-generated characters installed at once would collide with each other too) as `backend/templates/card_trail_generic.tscn`. `writeCharacterArt()` now unconditionally writes this verbatim to `scenes/vfx/card_trail_{entry}.tscn` for every export — no upload needed, matching the transition-material/character-icon pattern. Not currently tinted per-character (that's a real, low-risk follow-up — the color could be driven from the character's own accent `colorHex` the same way the energy orb is tinted — but out of scope for this crash fix).

**Verified:** `node --check backend/compiler.js` passes. A real `generateProject()` run against Tyler's actual `character_project.json` produces `scenes/vfx/card_trail_test_char_character.tscn`, confirmed **byte-identical** to the bundled template (and, by construction, to the real base game's own working `card_trail_ironclad.tscn` apart from the stripped uids).

### Separate, NOT-yet-investigated finding, noticed along the way

The same `godot.log` also shows a large repeating flood (600+ occurrences) of a *different* crash, triggered every time the Deck View screen is opened (`NTopBarDeckButton.OnRelease` → `NDeckViewScreen.ShowScreen` → `_Ready_Patch1`):

```
ERROR: Cannot open file 'res://materials/cards/frames/_mat.tres'.
   at MegaCrit.Sts2.Core.Models.CardPoolModel.get_FrameMaterial_Patch2(CardPoolModel)
```

The path `materials/cards/frames/_mat.tres` has an **empty** interpolated segment where a card pool identifier should be — `CardPoolModel.FrameMaterial` is building `'materials/cards/frames/' + <something empty> + '_mat.tres'`. This looks like a distinct, not-yet-root-caused bug (possibly a card pool with a blank/unset id somewhere in Forge's output) — Tyler hasn't reported it yet (this log capture just happened to include him repeatedly opening the Deck View screen), noted here so it isn't lost, not investigated further this round since it's unrelated to today's fix.

---

## Card trail VFX retinted to the character's accent color

Tyler, verbatim: "we dont necessarily have to do this now, but the trailing effect of adding a card to your deck should be the same color as the character's chosen color in the creator."

Implemented directly (small, low-risk, well-scoped follow-up to the card-trail crash fix above).

`writeCharacterArt()` now runs the bundled `card_trail_generic.tscn` template through a new `tintCardTrailTemplate(tscnText, colorHex)` before writing it out. It targets exactly the four `modulate = Color(...)` lines that read as "the trail's color" — the outer and inner trail lines (`Trails/OuterTrail`, `Trails/InnerTrail`) and the two accent glow sprites (`Sprite2D2`, `Sprite2D3`) — replacing each one's R/G/B with the character's own `character.color` hex (converted to Godot's `[0,1]` float range via a new `hexToFloatRgb()` helper, since `.tscn` text-resource `Color(...)` literals take floats, not a hex string like the C#-side `new Color("#RRGGBB")` calls elsewhere in this file). Each node's original alpha is preserved untouched — the outer/inner trail's differing alphas (0.752941 vs 0.501961) are what give the effect its layered look, only the hue changes.

Deliberately left the `BigSparks`/`LittleSparks` particle color-ramp `Gradient` sub-resources (the small ember sparkles) at their original fire tones — retinting a multi-stop `PackedColorArray` safely is meaningfully riskier (more values, no single unique anchor line to match against) for a much less visually prominent detail than the trail lines themselves. If Tyler wants those retinted too later, that's a real, scoped follow-up, not attempted this round.

Each replacement is done via an exact-string match with an occurrence-count guard (only replaces if the original line appears exactly once) — if the bundled template ever changes, a line that no longer matches is just left untinted rather than risking a wrong or partial replace. This is a cosmetic enhancement; it can never break the export.

**Verified:** `node --check backend/compiler.js` passes. A real `generateProject()` run against Tyler's actual `character_project.json` (`character.color = "#0a3170"`, a dark blue) produces `card_trail_test_char_character.tscn` that `diff`s identical to the bundled template except for exactly those 4 lines, each correctly converted (e.g. `Color(1, 0.168627, 0, 0.752941)` → `Color(0.0392..., 0.1921..., 0.4392..., 0.752941)`, alpha untouched).


---

## "the compiler exports too many files again" — the card-trail fix broke the real Godot pack export; root-caused and fixed with real build-log evidence

Tyler, verbatim: "the compiler exports too many files again."

### Investigation

This phrase closely echoed an earlier, already-fixed bug (the zip used to contain the entire raw build tree instead of just the installable dll/pck/json — see the "Export zip contained the entire raw build tree" section above). Checked the actual `mods/TestChar/` folder on Tyler's machine directly: exactly the 3 correct files, freshly timestamped. That ruled out a regression of that specific fix at the code level, so rather than guess further, asked Tyler where he was seeing it. He confirmed: the downloaded zip itself.

Tyler shared the actual zip. It was NOT the successful-compile zip shape (README/Forge_Project/`<modId>/`) — it was the **failure-path** zip: the full raw `tempDir` (`Cards/`, `Relics/`, `pack/` with its own `.godot/` cache, `bin/`, `obj/`, `mod.csproj`, etc.), which `server.js` ships deliberately whenever a real `dotnet build` fails, so the user can see why. That zip's own `README.md` contains the real build log — and it showed a genuine, new build failure, not a symptom of the zip logic itself:

```
EXEC : error : Cannot open file 'res://src/Core/Nodes/Vfx/NCardTrailVfx.cs'.
EXEC : error : Failed to read file: 'res://src/Core/Nodes/Vfx/NCardTrailVfx.cs'.
EXEC : error : Cannot load C# script file 'res://src/Core/Nodes/Vfx/NCardTrailVfx.cs'.
EXEC : error : Failed loading resource: res://src/Core/Nodes/Vfx/NCardTrailVfx.cs.
EXEC : error : Failed loading resource: res://images/packed/vfx/trail.png.
EXEC : error : Failed loading resource: res://images/packed/vfx/trail2.png.
EXEC : error : Failed loading resource: res://images/vfx/brush_particle_2.png.
EXEC : error : Cannot open file 'res://src/Core/Nodes/Vfx/NCardTrail.cs'.
... (same pattern for NCardTrail.cs, small_card_silhouette.png, sparkle.png,
    themes/canvas_item_material_additive_shared.tres)
EXEC : error : Cannot set object script. Parameter should be null or a
reference to a valid script.
mod.csproj(173,5): error MSB3073: The command "...--export-pack..." exited
with code -1.
```

So Tyler's "too many files" report was really the *symptom* of the card-trail VFX crash fix (previous round) genuinely breaking the real Godot `--export-pack` step — meaning that fix, while structurally correct, had never actually been build-tested before this. Its earlier "Verified" note only checked that `generateProject()`'s text output matched the bundled template byte-for-byte, since there was no local Godot/dotnet toolchain available to actually run the export step. This round's evidence closes that gap.

### Root cause

`card_trail_generic.tscn` was extracted verbatim from the base game's OWN `res://scenes/vfx/card_trail_ironclad.tscn`, so its `ext_resource`s point at the base game's own paths: its script (`NCardTrailVfx.cs`/`NCardTrail.cs`), a shared material (`canvas_item_material_additive_shared.tres`), and 5 VFX textures. Those paths resolve fine **at runtime**, because the base game's own `.pck` is already loaded alongside every mod's `.pck` in a merged virtual filesystem. But Forge's own `pack/` folder is a separate, ISOLATED Godot project when Godot actually exports it — it has no knowledge of the base game's files at all, and `--export-pack` needs to locally resolve every `ext_resource` before it can produce a `.pck`. None of those 8 files exist inside Forge's own project, so the export step fails outright — every earlier round's `character_icons`/rest-site/merchant/transition-material fixes never hit this because each of those was either 100% self-authored (the transition shader/material) or reused only assets Forge itself already bundles (the character's own uploaded icon PNG) — the card-trail scene is the only one that pulled in genuinely external, base-game-only dependencies.

### Fix

Bundled real, local copies of all 8 referenced dependencies directly inside Forge's own `pack/` project, at the exact same `res://` paths the scene already references, so Godot's exporter can resolve everything without needing the base game's project at all:

- **`NCardTrailVfx.cs` / `NCardTrail.cs`** — [VERIFIED, byte-for-byte]. Extracted the REAL base game's own `SlayTheSpire2.pck` entries at these exact paths directly (not guessed): both are a literal single newline byte (`\n`), size 1. This makes sense once you know how Godot's C# export actually works — a script's real behavior comes from the compiled .NET assembly (a script-path → Type mapping baked in by Godot's own C# source generators at compile time), not from re-parsing `.cs` text at pack-export time, so the base game's own exporter strips its real script files down to a 1-byte placeholder too. Our bundled stub matches that exact real, working, shipped convention — direct evidence, not an assumption.
- **`themes/canvas_item_material_additive_shared.tres`** — [VERIFIED, byte-for-byte content]. A genuinely tiny (102-byte) real resource (`blend_mode = 1`), extracted and bundled verbatim, with its `uid=` attribute stripped (same reasoning as `card_trail_generic.tscn` itself — avoids claiming the same resource-cache slot as the base game's own copy of this file, since both are loaded together at runtime).
- **`trail.png` / `trail2.png` / `brush_particle_2.png` / `small_card_silhouette.png` / `sparkle.png`** — [BEST EFFORT, NOT the base game's real art]. Unlike the `.cs`/`.tres` above, the actual base-game PNGs are genuinely not recoverable from the exported `.pck` at all — confirmed by direct search: Godot's texture import pipeline only ships the imported/compressed `.ctex` plus a tiny `.import` stub, never the original PNG bytes. (Redistributing the real game's own art inside every Forge-exported mod would also be its own separate concern, so this isn't purely a technical limitation.) Generated small, simple, locally-authored placeholder textures instead — soft gradient streaks for the two trail lines, a soft circle for the spark particles, a faint rounded-rect for the card silhouette, a 4-point glint for the sparkle. Visually different from the real game's own trail, but real, valid images Godot's exporter can actually import and pack, using the exact same PNG-in-`pack/` pipeline already proven working by every uploaded card-art/icon image this project exports today.

All 8 are written unconditionally by `writeCharacterArt()` alongside the retinted `card_trail_{entry}.tscn` scene itself, via a new `loadTemplateBinary()` helper (mirrors `loadTemplate()`, for raw bytes instead of utf8 text) and a small `backend/templates/card_trail_assets/` folder holding all 8 files.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run against Tyler's actual `character_project.json` confirms every one of the 8 dependency files now lands inside the generated `pack/` tree at the exact paths `card_trail_test_char_character.tscn`'s own `ext_resource` lines reference (verified by grepping the generated scene's `ext_resource` paths against the generated file tree directly, not assumed) — no more paths pointing outside the project. All 5 placeholder PNGs verified as valid, openable images. The color-retint feature (previous round) still applies correctly on top of this fix — same 4 `modulate` lines, same character-blue conversion, unaffected.

**Not yet re-confirmed by a real `dotnet build`** — this closes the exact failure Tyler's log showed, but per this project's standing rule, a real recompile is still the only true confirmation. Worth Tyler's next rebuild specifically checking that the Godot `--export-pack` step now succeeds (no more `Cannot open file 'res://...'` errors) and that the resulting zip is back to the normal successful shape (`README.md` / `Forge_Project/` / `<modId>/` with just `.dll`/`.pck`/`.json`).


---

## The bundled-scene approach hit a second, deeper wall — abandoned in favor of a Harmony patch (no custom trail scene at all)

After the dependency-bundle fix above, Tyler recompiled again and got a NEW, different build failure — real forward progress (the earlier "Cannot open file" errors were completely gone), but a new one:

```
EXEC : error : Export .NET Project: This project contains C# files but no
solution file was found at the following path: .../pack/TestChar.sln
EXEC : error : System.InvalidOperationException: res://src/Core/Nodes/Vfx/
NCardTrail.cs is a C# file but no solution file exists.
... (same for NCardTrailVfx.cs)
error MSB3073: ...--export-pack... exited with code -1.
```

### Root cause

Simply having ANY real `.cs` file present as a `Script`-type `ext_resource` inside this mod's isolated `pack/` project makes Godot's own exporter try to "Export .NET Project" — a separate build step that requires a real `.sln`. Forge's mod projects don't have one: the actual C# compile happens through a completely separate top-level `mod.csproj`/`dotnet build`, never through Godot's own Mono export pipeline. Checked whether any other real, shipped mod has ever worked around this — extracted the full file listing of Tyler's own installed `TheBurdenedNewCharacter.pck` directly and searched for any `.cs` entry anywhere in it: **zero**. No real mod in this ecosystem references a C# script from its own pack project at all, which strongly suggests this genuinely isn't a supported pattern to force through, rather than something Forge was doing wrong.

### The actual fix: skip the scene entirely, patch the crash at its source

Re-examined the real IL of the actual CALLER, `NCardFlyVfx._Ready()` (not just `NCardTrailVfx.Create()` itself, which is all that had been checked before). It already does exactly this:

```
_vfx = NCardTrailVfx.Create(_card, _trailPath);
if (_vfx != null) AddChildSafely(GetParent(), _vfx);
// ... continues unconditionally: sets up _controlPointOffset/_speed/
// _accel/_arcDir/_duration, connects TreeExited, calls PlayAnim() ...
```

`_Ready()` already null-checks `Create()`'s result before adding it as a child, and runs its own animation setup (including the actual `PlayAnim()` call that flies the card to the deck) regardless of whether a trail was attached. The ONLY problem is that `Create()` itself *throws* instead of returning null when the scene can't be found — which aborts `_Ready()` entirely (including the `PlayAnim()` call further down), rather than just skipping the trail.

Added a small Harmony patch instead of any custom scene at all — `Generated/ForgeCardTrailNullGuard.cs` (`[HarmonyPatch(typeof(NCardTrailVfx), nameof(NCardTrailVfx.Create))]`, a `Prefix` that checks `PreloadManager.Cache.GetScene(characterTrailPath)` itself, and if null, sets `__result = null` and returns `false` to skip the original method instead of letting it throw). `ModEntry.cs` already bootstraps `new Harmony(...).PatchAll()`, which picks up any `[HarmonyPatch]`-decorated class anywhere in the mod's own assembly automatically — no extra wiring needed, and this exact bootstrap pattern has already compiled and run successfully in every one of Tyler's prior real builds.

Net effect: a card obtained mid-run now flies to the deck and disappears correctly — it just has no decorative particle trail behind it. **This also means the color-retint feature from the previous round no longer applies to anything** (there's no trail being rendered to tint) — reverted along with it. A real, character-colored trail effect would require solving the Godot pack-project ".sln" problem for real (a genuinely bigger, riskier undertaking — likely hand-authoring a minimal Godot-generated solution/csproj pointing at the mod's own already-built assembly, unverified territory with no real precedent found in this ecosystem) — worth a dedicated future round if Tyler wants to pursue it, not bolted onto this crash fix.

Removed the now-dead `card_trail_generic.tscn` bundling logic, the 8-file dependency bundle, and `tintCardTrailTemplate()`/its call site from `compiler.js`. The template files themselves (`backend/templates/card_trail_generic.tscn`, `backend/templates/card_trail_assets/`) were left on disk, unreferenced — harmless, and useful reference material if a future round does pursue the real-scene approach.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run against Tyler's actual `character_project.json` confirms `Generated/ForgeCardTrailNullGuard.cs` is now written (namespace-templated correctly), and none of the old card-trail scene/dependency paths (`pack/scenes/vfx`, `pack/src`, `pack/themes`, `pack/images/card_trail`) are generated anymore.

**Not yet confirmed by a real `dotnet build`** — same standing caveat as always. This is a fundamentally different, much lower-risk mechanism than the last two attempts (a plain generated C# file compiled by the SAME `mod.csproj`/`dotnet build` path that has already worked repeatedly, with zero interaction with Godot's export step at all), but only a real recompile is the true confirmation.


---

## "neither my character nor any enemies loaded in" — first combat crash, root-caused and fixed the same way as the card-trail crash

Tyler, verbatim: "ok i was able to get to the first combat this time. neither my character nor any enemies loaded in though."

### Investigation

Fetched the freshest `godot.log` and found the real chain of events right as combat starts:

```
[WARN] Threaded load status Failed for res://scenes/creature_visuals/testchar-test_char_character.tscn, falling back to sync load
ERROR: Error loading resource: 'res://scenes/creature_visuals/testchar-test_char_character.tscn'.
[ERROR] Failed to load resource synchronously: res://scenes/creature_visuals/testchar-test_char_character.tscn
ERROR: MegaCrit.Sts2.Core.Assets.AssetLoadException: Asset previously failed to load: res://scenes/creature_visuals/testchar-test_char_character.tscn. The game installation may be corrupted.
...
[ERROR] Attempted to play animation on creature Creature Nibbit but its creature node doesn't exist!
[ERROR] Attempted to play animation on creature Creature Test Char but its creature node doesn't exist!
```

`creature_visuals/{entry}.tscn` (the character's actual combat sprite/rig scene) was deliberately left un-exported in an earlier round, on the belief — like `vfx/card_trail` before it — that a missing file here only causes a soft, non-fatal *preload* failure. That belief has now failed the same way it did for card-trail: this is the **live** load path, not preload, and it's fatal.

Traced the real call chain via direct IL disassembly, confirming the exact same unguarded shape as the card-trail bug:

- `CharacterModel.CreateVisuals()` (no params — the path is built from a **private** `VisualsPath` property, `'creature_visuals/' + Id.Entry.ToLowerInvariant()`) does `PreloadManager.Cache.GetScene(VisualsPath)` then `PackedScene.Instantiate<NCreatureVisuals>()` — no null-check.
- `Creature.CreateVisuals()` calls straight into it (for a player) — no try/catch.
- `NCreature.Create(entity)` (confirmed via a real token-level scan of every call site in sts2.dll, the actual per-creature spawn factory used when a room's combat is set up) calls `entity.CreateVisuals()` directly into `set_Visuals` — no try/catch either.

So the exception propagates all the way out of `NCreature.Create()` uncaught for the player's own creature. Since the enemies' own `creature_visuals` scenes are completely real, unmodified base-game files (confirmed: Nibbit's is a genuine, tiny, valid scene, still present and correct), their absence from combat isn't really about them at all — whatever loop calls `NCreature.Create()` once per creature in the room appears to abort the moment it hits our own character's unhandled exception, so no enemy after that point ever gets its turn to spawn either. That's the real explanation for "neither my character nor any enemies loaded in."

### Fix

Same mechanism as the card-trail fix: a generated Harmony patch, `Generated/ForgeCreatureVisualsNullGuard.cs`, on `CharacterModel.CreateVisuals()`. This one uses a **Finalizer** patch instead of a Prefix (unlike the card-trail case, this method takes no parameters — the path it loads comes from a private property this mod's own code has no way to call directly, so pre-checking "would this fail" isn't possible the way it was for the trail fix). A Finalizer lets the original method run normally and catches whatever exception it throws, clearing it and substituting a safe `null` result instead of letting it propagate.

Confirmed `NCreature.set_Visuals` is a plain, side-effect-free backing-field setter (real IL, no null-dereference risk), and the game's own code already tolerates a missing creature visual node gracefully in at least one place (that exact "its creature node doesn't exist!" warning, logged rather than crashing) — so returning null here is a safe, minimal change.

**Being upfront about the real scope of this**: unlike the card-trail fix, where the tradeoff was "no decorative trail effect," this one is more significant — **the character itself will be invisible in combat** (no sprite/rig at all) until Forge can export a real combat visual. That's a genuinely different scale of problem than a missing VFX flourish: a real one needs (a) solving the same Godot ".sln" export wall the card-trail scene hit (`creature_visuals` scenes also reference a compiled C# script, `NCreatureVisuals.cs`), AND (b) a real animated Spine rig, which is exactly the same "Spine rig requirement" Tyler already flagged he doesn't want Forge to force on users for the Shop/Rest sprite problem — likely solvable the same speculative way (a minimal synthesized Spine skeleton wrapping a flat image, per the Round 27 research), but that's a genuinely bigger, dedicated piece of work, not a same-round bolt-on to this crash fix. This fix's job is narrowly to stop combat from being unable to start at all, not to make the character visible.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run against Tyler's actual `character_project.json` confirms `Generated/ForgeCreatureVisualsNullGuard.cs` is written correctly (namespace-templated, matching the card-trail patch's established shape).

**Not yet confirmed by a real `dotnet build`** — same standing caveat. Worth Tyler's next rebuild checking that (1) the build succeeds, (2) combat starts and enemies are now visible again, and (3) as expected, the player's own character has no visible sprite in combat (this is the known, accepted gap from this fix, not a new bug to report back).


---

## "Only the enemy's health bar loads in" — the previous fix's own Finalizer patch was itself the cause; fixed by matching the real fallback mechanism `MonsterModel` already uses

Tyler sent two screenshots of real running combat (cards in hand, energy orb, End Turn button, a relic tooltip, and a floating enemy health bar reading "88/88") with: "Only the enemy's health bar loads in."

This was genuinely new progress — combat now boots up and runs (a first) — but both the player's character (expected/flagged after the previous fix) *and* the enemy (previously theorized to be pure collateral damage, which should have been resolved) still showed no sprite.

### Investigation

The freshest `godot.log` had two new, previously-unseen `NullReferenceException` entries right as `NCombatRoom` sets up creatures for the fight, with full stack traces this time:

```
ERROR: System.NullReferenceException: Object reference not set to an instance of an object.
   at MegaCrit.Sts2.Core.Nodes.Combat.NCreature._Ready_Patch2(NCreature this)
   ...
       [4] void MegaCrit.Sts2.Core.Helpers.GodotTreeExtensions.AddChildSafely(Godot.Node, Godot.Node)
       [5] ... NCombatRoom.AddCreature_Patch2(...)
       [6] void MegaCrit.Sts2.Core.Nodes.Rooms.NCombatRoom.CreateAllyNodes()

ERROR: System.NullReferenceException: Object reference not set to an instance of an object.
   at MegaCrit.Sts2.Core.Nodes.Rooms.NCombatRoom.<>c.<PositionPlayersAndPets>b__85_0(NCreature n)
   at System.Linq.Enumerable.Sum[TSource,TResult,TAccumulator](...)
   at MegaCrit.Sts2.Core.Nodes.Rooms.NCombatRoom.PositionPlayersAndPets(...)
```

Disassembling `NCreature._Ready()`'s real IL confirmed the cause immediately: it unconditionally does `AddChildSafely(this, get_Visuals())`, then `MoveChildSafely(Visuals, 0)`, `Visuals.set_Position(Vector2.Zero)`, and `UpdateBounds(Visuals)` — four separate, completely unguarded dereferences of `Visuals`. The previous round's fix (`ForgeCreatureVisualsNullGuard.cs`, a Harmony Finalizer that swallowed `CharacterModel.CreateVisuals()`'s exception and left `__result = null`) stopped the *original* crash, but simply relocated it one call deeper — into `_Ready()`'s very first line. And because Godot's C#↔native call bridge (`CSharpInstanceBridge.Call`) catches and logs C# exceptions thrown from Node lifecycle callbacks instead of crashing the whole game, this new failure didn't halt anything — it just silently aborted creature setup partway through, for **every creature in the room at once** (the second stack trace shows `PositionPlayersAndPets`'s `.Sum()` lambda over *all* creature nodes throwing the instant it reaches the one with null `Visuals` — aborting position/visual setup for the enemy too, which is why only its already-independently-created health bar UI ever appeared).

The real fix was sitting in the game's own code the whole time. Disassembling `MonsterModel.CreateVisuals()` (the equivalent method used for enemies, as opposed to `CharacterModel.CreateVisuals()` used for the player) showed it already solves exactly this problem:

```
CreateVisuals():
    try { return PreloadManager.Cache.GetScene(VisualsPath).Instantiate<NCreatureVisuals>(); }
    catch (Exception e) {
        Log.Error($"...Falling back to error scene. Exception: {e}");
        SentryService.CaptureException(e);
        return CreateFallbackVisuals();
    }

CreateFallbackVisuals():
    return PreloadManager.Cache.GetScene(_fallbackVisualsPath).Instantiate<NCreatureVisuals>();

// static .cctor:
_fallbackVisualsPath = SceneHelper.GetScenePath("creature_visuals/fallback");
```

`"creature_visuals/fallback"` is a real literal string baked into `sts2.dll` itself. Extracting `scenes/creature_visuals/fallback.tscn` directly from `SlayTheSpire2.pck` confirmed it's a real, always-shipped base-game asset: a plain `NCreatureVisuals`-scripted node with a generic `res://images/monsters/error.png` sprite, and the same `%Visuals` / `%Bounds` / `%CenterPos` / `%IntentPos` unique-named children every real creature visual scene has. This is the base game's own designed answer to "this creature's real visual is broken" — `MonsterModel` already uses it for monsters; `CharacterModel` (the player's own character) simply never got the same try/catch.

### Fix

Rewrote `ForgeCreatureVisualsNullGuard.cs`'s Finalizer to do exactly what `MonsterModel.CreateFallbackVisuals()` does, instead of leaving `__result` null:

```csharp
static Exception Finalizer(Exception __exception, ref NCreatureVisuals __result)
{
    if (__exception != null)
    {
        string fallbackPath = SceneHelper.GetScenePath("creature_visuals/fallback");
        PackedScene fallbackScene = PreloadManager.Cache.GetScene(fallbackPath);
        __result = fallbackScene?.Instantiate<NCreatureVisuals>();
    }
    return null;
}
```

Since `Visuals` is never null anymore, all four dereferences in `NCreature._Ready()` succeed normally, and `PositionPlayersAndPets()`'s room-wide `.Sum()` no longer throws partway through — fixing the enemy's rendering too, since that was collateral damage from this same patch's earlier (over-defensive) version, not an independent bug.

**Net effect**: the player's own character now renders as a generic "?" error-sprite placeholder in combat — not invisible, not a crash — exactly like what already happens in the unmodded game when a *monster's* own visual is broken. It's not real character art, but it's the same fallback the base game itself uses, not a Forge-specific hack.

### Verification

`node --check backend/compiler.js`: clean (no change to compiler.js was needed — it already writes this template unconditionally). A real `generateProject()` run against Tyler's actual `character_project.json` confirms `Generated/ForgeCreatureVisualsNullGuard.cs` renders correctly with the real `TestChar` namespace and the new fallback logic.

**Not yet confirmed by a real `dotnet build` + in-game combat run.** Worth Tyler's next rebuild checking: (1) the build succeeds, (2) the player's character now shows the generic "?" error-sprite in combat instead of nothing, and (3) the enemy renders normally again (sprite + health bar both).


---

## Getting the character working for real — the ".sln" export wall solved, real combat sprite, and the card trail restored

Tyler, after seeing the "?" fallback sprite working correctly: "lets get the character working, this should allow us to also take care of the trailing effect when adding a card to your deck." This round tackles both at once, since they were blocked by the exact same wall.

### Two real discoveries changed the scope of this a lot

**1. No Spine rig is needed for a real combat sprite, at all.** Extracting real base-game `creature_visuals/*.tscn` scenes directly from `SlayTheSpire2.pck` turned up `crusher.tscn` — a real, shipped monster visual using a **plain `Sprite2D`** for its `%Visuals` node, not a Spine skeleton. Disassembling `NCreatureVisuals._Ready()`'s real IL confirmed why this works: `HasSpineAnimation` is determined purely by checking whether `%Visuals`' *runtime Godot class name* equals `"SpineSprite"` (`get_IsSpineNode`) — if it's a plain `Sprite2D`, the entire Spine-rig setup block in `NCreature._Ready()` is skipped cleanly, no crash, no missing functionality. This overturns the assumption carried since Round 27 that a synthesized Spine rig would be needed — it isn't. A flat, uploaded PNG in a `Sprite2D` is a completely real, fully-supported creature visual.

**2. The real ".sln" requirement, and how the official toolchain actually solves it.** Fetched Godot's own real engine source (`modules/mono/editor/GodotTools/GodotTools/Export/ExportPlugin.cs`): the moment any `.tscn` in a C#-enabled project references a Script `ext_resource`, the exporter checks `File.Exists(GodotSharpDirs.ProjectSlnPath)` and throws exactly the error Tyler hit twice. This isn't just a path check — right after it passes, `ExportPlugin._ExportBeginImpl()` calls `BuildManager.PublishProjectBlocking(...)`, which runs a **real `dotnet publish`** against that `.sln`/`.csproj`. Cross-checked against the real, official `Alchyr.Sts2.Templates` package (its wiki: *"Godot requires a .sln file"*) and a real, live, shipped STS2 character mod's own repo (`github.com/harsh2204/STS2-Buu`) — both confirm the real pattern uses `Sdk="Godot.NET.Sdk/4.5.1"`.

### The fix

**`pack/{ModName}.csproj` + `pack/{ModName}.sln`** (new templates, written unconditionally in `generateProject()`): a minimal, real, buildable `Godot.NET.Sdk/4.5.1` project living only inside `pack/`. It has zero real code — the script stubs it compiles (`NCardTrailVfx.cs`, `NCardTrail.cs`, `NCreatureVisuals.cs`) are the same real single-newline-byte placeholders already established as matching the base game's own convention. Its only job is to give Godot's exporter something real to `dotnet publish` against; Forge's actual gameplay C# still compiles entirely separately via the existing top-level `mod.csproj`, completely untouched.

**Real combat creature sprite**: `bodySpriteAssetRef` ("Body sprite" — already a real, enforced-512×512-transparent-PNG upload field, exported to `images/packed/portraits/<id>_creature.png`, but with nothing to ever display it) is now wired into a real `creature_visuals/{entry}.tscn` scene, structured exactly like the real `crusher.tscn`/`fallback.tscn` pattern above: a plain `Sprite2D` `%Visuals` plus `%Bounds`/`%CenterPos`/`%IntentPos`. Placement (scale 0.5, positioned so the image's bottom sits at the node's floor-contact origin) is [BEST EFFORT] — not extracted from a real example sized to this art, so worth Tyler's first look in-game. The `ForgeCreatureVisualsNullGuard.cs` Harmony patch (last round's real-fallback-scene fix) stays in place unconditionally as a defensive backstop.

**Card trail VFX restored**: the original bundled-scene approach (dependency bundle + retinted `card_trail_generic.tscn`) was correct all along — it was only ever blocked by the ".sln" wall, not by anything wrong with the scene itself. Now that the wall is solved, it's regenerated at the real `scenes/vfx/card_trail_{entry}.tscn` path. `ForgeCardTrailNullGuard.cs` also stays in place as a backstop.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run against Tyler's actual `character_project.json` (which already has a real Body sprite uploaded) confirmed every new file lands exactly where expected: `pack/TestChar.csproj`, `pack/TestChar.sln`, `pack/scenes/creature_visuals/testchar-test_char_character.tscn` (referencing the real, already-exported `testchar_creature.png`), `pack/src/Core/Nodes/Combat/NCreatureVisuals.cs` (1 byte, matching convention), and the full card-trail bundle + `pack/scenes/vfx/card_trail_testchar-test_char_character.tscn`.

**Not yet confirmed by a real `dotnet build`** — this is the biggest change this project has made to the actual Godot export step, and per this project's standing rule, only a real rebuild is the true test. Worth Tyler's next rebuild specifically checking: (1) the build succeeds — the most likely new failure mode, if any, is something SDK-resolution-related from the new `Godot.NET.Sdk/4.5.1` reference (a NuGet restore issue, a missing Godot workload) rather than anything code-level; (2) the character now shows the real Body sprite in combat instead of the "?" fallback, and whether its size/position (currently a [BEST EFFORT] guess) needs adjusting; (3) a card obtained mid-run now has a visible (placeholder-art) trail effect behind it again.


---

## "once again, we are compiling too many files" — real build error #4, a genuinely new bug in the ".sln" fix itself (invalid XML comment)

Tyler uploaded a fresh zip after the ".sln"/real-sprite/card-trail round above, with the same message he's used before for a failed compile.

### Investigation

The zip's own `README.md` build log showed the real `dotnet build` output. Progress first: `mod -> ...\bin\Release\net9.0\TestChar.dll` confirms the mod's actual C# compiled successfully (all Cards/Relics/Powers/Generated files, including both Harmony null-guard patches) — the failure is entirely inside the new Godot export step this project just added:

```
EXEC : error : Microsoft.Build.Exceptions.InvalidProjectFileException: The
project file could not be loaded. An XML comment cannot contain '--',
and '-' cannot be the last character. Line 2, position 54.
...\pack\TestChar.csproj [...\mod.csproj]
 ---> System.Xml.XmlException: An XML comment cannot contain '--'...
   at GodotTools.ProjectEditor.ProjectUtils.Open(String path)
   at GodotTools.GodotSharpEditor.ApplyNecessaryChangesToSolution()
   at GodotTools.GodotSharpEditor._EnablePlugin()
```

Real root cause, immediately obvious once the exact error is read: `PackProject.csproj.template`'s own header comment (written by this project, this same round) used the prose idiom "`— see ...`"/"`-- confirmed ...`" (a literal double hyphen) repeatedly, inside an actual XML `<!-- -->` comment. XML has a hard rule (part of the spec, not a Godot quirk) that a comment's content can never contain two adjacent hyphens anywhere. Every other comment block in this codebase uses that same "`--`" idiom safely, because they're all `//`-style C#/JS comments — this is the first real XML file this project has ever hand-authored with prose commentary in it, and the rule was missed.

This also confirms something genuinely useful about the fix from the previous round: the stack trace shows the failure happening inside `GodotTools.GodotSharpEditor.ApplyNecessaryChangesToSolution()`, called from `_EnablePlugin()` — i.e. Godot's own C# editor tooling really does open and parse `pack/TestChar.csproj` with `Microsoft.Build.Construction.ProjectRootElement` as part of bringing up its C# support before exporting, exactly matching what the real engine source predicted last round. The mechanism is right; this was a straightforward content bug in the file this project generates, not a flaw in the approach.

### Fix

Rewrote `PackProject.csproj.template`'s header comment to remove every literal double-hyphen (replaced with em dashes / plain sentence breaks, matching this project's usual prose style elsewhere), including inside the two "export-pack" Godot flag mentions that had been written as `--export-pack`. Added an explicit in-file warning comment (itself double-hyphen-free) noting why, so a future edit to this file doesn't reintroduce the same bug.

### Verification

`node --check backend/compiler.js`: clean. Validated the fixed template directly with Python's `xml.dom.minidom` parser (the same class of strict XML reader that caused the real failure): parses clean. A real `generateProject()` run against Tyler's actual `character_project.json` confirmed the generated `pack/TestChar.csproj` now contains zero `--` sequences anywhere and parses as valid XML.

**Not yet re-confirmed by a real `dotnet build`** — worth Tyler's next rebuild specifically getting past this exact error (the log should show `GodotSharpEditor` succeeding instead of throwing `InvalidProjectFileException`) and reaching the same checks flagged last round: the character showing its real Body sprite art, and a visible card trail.


---

## "when playing a card though they just freeze in the middle of the screen" — real crash #5, a real NullReferenceException inside a relic's own real hook

Tyler's newest screenshots showed real running combat: the character's own art now renders (the round above's fix confirmed working), enemies rendering correctly, cards in hand, energy orb — but a "Defend" card ("Gain 5 Block") frozen large and centered on screen instead of finishing its play animation.

### Investigation

Fetched the freshest `godot.log` (confirmed current via `ls -la *.log | sort -k6,7`) and searched for exceptions around card-play. Found the real cause immediately — not related to the card-trail VFX restored last round at all:

```
[INFO] Player 1 playing card TESTCHAR-DEFEND_CARD (no target)
[ERROR] System.NullReferenceException: Object reference not set to an instance of an object.
   at MegaCrit.Sts2.Core.Commands.CreatureCmd.Stun(Creature creature, Func`2 stunMove, String nextMoveId)
   at MegaCrit.Sts2.Core.Commands.CreatureCmd.Stun(Creature creature, String nextMoveId)
   at TestChar.Relics.Group1Relic.AfterCardPlayed(PlayerChoiceContext choiceContext, CardPlay cardPlay)
   ...
[ERROR] GameAction PlayCardAction card: CARD.TESTCHAR-DEFEND_CARD (61093719) index: 1 targetid:  completed with exception: System.AggregateException: One or more errors occurred. (Object reference not set to an instance of an object.)
```

Tyler's own relic (`Group1Relic`) has an `OnAnyCardPlayed` effect that calls `StunEnemy` (a `SingleEnemy`-targeted action). `AfterCardPlayed` fires for ANY card played by anyone — including the Defend card just played "(no target)". Forge's own generated code binds `var fgTarget = cardPlay.Target;` for this hook, and `cardPlay.Target` is genuinely `null` for an untargeted card. `resolveTargetExpr('SingleEnemy')` then emits `fgTarget!` — the `!` is only a **compile-time** null-forgiving assertion; it does nothing at runtime. The generated call `await CreatureCmd.Stun(fgTarget!, null)` passed a real `null` `Creature` straight into the base game's own `CreatureCmd.Stun`, which crashed inside it. The crash faults the whole `PlayCardAction`'s task, which is why the card visually freezes mid-play instead of completing — the game never gets a chance to finish the card's play/discard animation because the action that was supposed to drive it threw.

Worth noting: this exact danger was already called out in this codebase's own comment on `TRIGGER_HOOKS.OnAnyCardPlayed`, written when that hook was first wired up — *"`cardPlay.Target` in that context is borrowed from whatever card triggered the hook, not a target the relic itself defines, and can be null for an untargeted card play"* — but no actual runtime guard was ever implemented for it. This round closes that real, previously-flagged gap.

The same borrowed-nullable-target shape also applies to `CARD_TRIGGER_HOOKS.OnAnyCardPlayed` (a card's own reactive override that fires when any OTHER card is played — same `cardPlay.Target`, same nullability), and to 5 real condition kinds (`HasStatusStacks`, `HpBelowPercent`, `BlockAmount`, `DebuffStacks`, `HasPet`) whenever their `subject` is `'CardTarget'` under one of those two hooks — all fixed together this round since they share the exact same root cause.

### Fix

Added a new `ctx.targetMayBeNull` flag, set only on the two real "borrowed target" contexts (`TRIGGER_HOOKS.OnAnyCardPlayed` for relics/mechanics, and `cascadingTriggerBody`'s `trigger === 'OnAnyCardPlayed'` case for a card's own reactive override) — every other hook (including a card's own `OnPlay`, where the base game itself guarantees a real target before constructing `cardPlay` for a targeted card) is completely unaffected.

- `actionToCSharp`: a new `SingleEnemy`-target branch, structured identically to the existing `RandomEnemy`/`AllEnemies` null-guard wrapper added round 24 — wraps the action in `if (fgTarget != null) { ... }` and recurses with `fgTarget` itself as the forced target expression, exactly the same shape already proven correct for those two other target kinds.
- `conditionToCSharp`: the existing per-kind switch was renamed to `conditionToCSharpRaw` and a thin wrapper added — when `ctx.targetMayBeNull && cond.subject === 'CardTarget'`, the raw condition expression is prefixed `fgTarget != null && (...)`, so a gate that would have dereferenced a null Creature now safely evaluates false (skipping its actions) instead of crashing. Every other call site is unaffected — the wrapper is a pure passthrough when the flag isn't set.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run against Tyler's actual `character_project.json` regenerated all 63 files; the crashing relic's real generated `AfterCardPlayed` method now reads:

```csharp
var fgTarget = cardPlay.Target; // [BEST EFFORT]
{ // [Fix, round 29] ...
    if (fgTarget != null)
    {
        await MegaCrit.Sts2.Core.Commands.CreatureCmd.Stun(fgTarget, null);
    }
}
```

Confirmed via a brace-balance check across every one of the 63 generated `.cs` files (all balanced, zero mismatches) that the new wrapper's block structure is syntactically sound. This is the first real crash this project has traced all the way into the generated code's OWN logic error (not a template/build-file bug) — every earlier round's build/export failures were about getting Godot's own exporter to accept the pack/ project at all; this one is a genuine runtime null-target gap in the relic-hook codegen itself, now fixed at its root (the shared `actionToCSharp`/`conditionToCSharp` helpers), not just patched for `StunEnemy`/`Group1Relic` specifically.

**Not yet re-confirmed by a real build+play** — worth Tyler's next playtest specifically replaying a Defend (or any other untargeted card) with this same relic active, confirming the card now completes its play/discard animation instead of freezing.


---

## "card is still stuck, also when ending turn it didnt draw more cards" — two real, distinct, previously-undiscovered bugs, both closed

Tyler rebuilt with the round 29 fix and reported two new symptoms in the same playtest. The round 29 fix is confirmed working — the freshest `godot.log` shows no more Stun-related crash at all. Both new symptoms turned out to be genuinely new bugs, unrelated to each other and to round 29.

### Investigation

Fetched the freshest `godot.log` (confirmed current via `ls -la *.log | sort -k6,7`) and searched for exceptions around card-play and turn-end.

**Bug A — "card is still stuck"**: playing an ordinary Strike card threw a real exception straight out of the base game's own combat pipeline:

```
[INFO] Player 1 playing card TESTCHAR-STRIKE_CARD (targeting Seapunk (index 1))
[ERROR] System.InvalidOperationException: No attacker set.
   at MegaCrit.Sts2.Core.Commands.Builders.AttackCommand+<Execute>d__90.MoveNext_Patch1(...)
   at TestChar.Generated.ForgeActions.DealDamage(PlayerChoiceContext choiceContext, Creature target, Int32 amount, Int32 hitCount)
   at TestChar.Cards.StrikeCard.OnPlay(PlayerChoiceContext choiceContext, CardPlay cardPlay)
```

A direct `sts2.dll` read of `AttackCommand`'s full real public surface confirmed it exposes exactly THREE ways to set its `Attacker` — `FromCard(CardModel, CardPlay)`, `FromOsty(Creature, CardModel, CardPlay)`, `FromMonster(MonsterModel)` — and `set_Attacker` itself is **private**, so nothing else can set it. `ForgeActions.DealDamage` built a `DamageCmd.Attack(...)` chain but called none of them — its own comment even flagged this as a known gap ("`.FromCard(...)` attacker attribution is still deliberately NOT called here... there's no generic `.FromCreature(...)` overload"), written back when this was still a theoretical risk rather than a proven one. Since virtually every card in this app deals damage, this meant DealDamage was always going to throw the first time it actually ran in real combat — it simply hadn't been reached in real gameplay until this project's other blocking bugs were cleared this week.

Disassembling `FromCard`'s own real IL (straight from `sts2.dll`) confirmed exactly what it needs: `Attacker = card.Owner.Creature` — `card` is dereferenced unconditionally (must be real), but `cardPlay` may genuinely be null. A card's own generated body always has both a real `this` (the CardModel) and a real `cardPlay` local in scope. A relic/mechanic hook body has neither. Since `AttackCommand` has no generic "attack from a bare Creature" path at all, a *different* real, lower-level API was needed for that case — found directly in the SAME crash log's own stack trace one bug later (see Bug B's investigation, which surfaced `AttackHitHook.DamageAndAfterAttackHit` calling `MegaCrit.Sts2.Core.Commands.CreatureCmd.Damage(PlayerChoiceContext, Creature target, decimal amount, ValueProp props, Creature dealer, ...)`), cross-confirmed via a direct `sts2.dll` read of the full real static `CreatureCmd.Damage` overload family (several real overloads exist, including ones taking a bare `Creature dealer` with no `CardModel`/`CardPlay` at all).

**Bug B — "didnt draw more cards"**: immediately after Bug A's card-play exception, the very next monster turn produced this:

```
[ERROR] Combat #1 turn loop died while its combat is in progress; the combat is stuck until the room is restarted: System.NotImplementedException: Forge: "DrawCard 6" has no verified STS2/BaseLib API mapping yet.
   at TestChar.Generated.ForgeActions.Todo(String what)
   at TestChar.Relics.Group1Relic.AfterBlockBroken(PlayerChoiceContext choiceContext, Creature target, Creature breaker)
```

Tyler's relic has a `DrawCard 6` effect on its `AfterBlockBroken` trigger. `ForgeActions.Todo()` is real, by design (see its own header comment — "compiles so one uncertain action doesn't block the whole card from building, but throws clearly if actually reached") — but reached for real, it doesn't just skip that one action: the thrown exception kills the **entire combat turn loop**, "stuck until the room is restarted." That's exactly why nothing after it ran, including the next turn's own draw step. This was never really a "draw is broken" bug — draw was collateral damage from the turn loop dying.

Why did DrawCard hit the Todo fallback at all? Its codegen was gated on `ctx.cardPlayBound` alone, needing a real `Player` for `CardPileCmd.Draw`'s 3rd parameter, and `AfterBlockBroken` isn't cardPlayBound. But `resolvePlayerExpr(ctx)` (added round 24, fixed round 25) already solves exactly this — it resolves a real `Player` via `fgPlayer.Player` in ANY hook context, the same gap GainEnergy/GainGold/CreateCard already closed with it. DrawCard was simply never updated when that helper was introduced. `choiceContext` was never actually the blocker either — it's the first parameter on literally every `TRIGGER_HOOKS` entry, confirmed again directly by this exact crash's own `AfterBlockBroken(PlayerChoiceContext choiceContext, ...)` signature.

### Fix

**`ForgeActions.cs.template`**: `DealDamage`/`DealDamageAllEnemies` now take `(Creature dealer, CardModel? sourceCard, CardPlay? cardPlay)` in addition to their existing params. When `sourceCard` is non-null (a card's own generated body), they use the real `FromCard(sourceCard, cardPlay)` attacker path, unchanged from the always-correct AttackCommand pipeline. When `sourceCard` is null (a relic/mechanic hook), they fall back to the real `CreatureCmd.Damage(choiceContext, target, amount, props, dealer)` family instead — dealer = `fgPlayer`, always bound regardless of context.

**`compiler.js`**: new `resolveDamageSourceArgs(ctx)` helper returns `'fgPlayer, this, cardPlay'` when `ctx.thisIsCard` (a card's own body — cascadingTriggerBody's own guarantee that `cardPlay` is always in scope there too) or `'fgPlayer, null, null'` otherwise (relic/mechanic hook). Threaded into both `DealDamage`/`DealDamageAllEnemies` call sites in `actionToCSharp`. `DrawCard`'s case now always calls the real `CardPileCmd.Draw(choiceContext, amount, resolvePlayerExpr(ctx), false)` — the `ctx.cardPlayBound` gate and its Todo-fallback branch are gone entirely (the "next turn" mode, which has no real API at all, stays an honest Todo stub, unchanged).

**Not touched this round, flagged for later**: the same "gated on `cardPlayBound` when `resolvePlayerExpr(ctx)` would actually work everywhere" pattern also affects `ExhaustCard`, `DiscardCard`, and 4 condition kinds (`HandCardTypeCheck`, `OrbSlotCount`, `HasSpecificRelic`, `NoCopiesOfCardInHand`, `CardsInHand`) — none of these are reported broken by Tyler yet, and touching all of them in one round without individual real-build confirmation felt riskier than the scoped, evidenced fix above. Worth a dedicated future round once one of these actually gets exercised (same "fix once it's actually hit" discipline this whole project already follows).

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run confirmed both fixes land correctly in generated output: `RareAttackCard.cs`/`StressTestCard.cs` (card context) now emit `ForgeActions.DealDamage(choiceContext, fgPlayer, this, cardPlay, fgTarget!, ...)`; `Group1Relic.cs` (relic context) emits `ForgeActions.DealDamage(choiceContext, fgPlayer, null, null, fgTarget!, ...)` for its own DealDamage effect, and its `DrawCard 6` effect now emits a real `CardPileCmd.Draw(choiceContext, 6, fgPlayer.Player, false)` instead of a Todo stub. A brace-and-paren balance check across all 26 generated `.cs` files came back clean.

Cross-checked against the ACTUAL currently-installed mod DLL (`Slay the Spire 2/mods/TestChar/TestChar.dll`, staged and disassembled directly — the on-disk `character_project.json` this project has been using for `generateProject()` tests turned out to be a stale, earlier save missing Tyler's Strike/Defend cards, so this cross-check used real IL from the actual crash-producing build instead): `StrikeCard`'s real, currently-installed `OnPlay` IL confirms the pre-fix call shape exactly (`ForgeActions.DealDamage(choiceContext, target, 6, 1)`, the old 4-arg signature) — ground truth for the bug, independent of which project file was on disk.

**Not yet re-confirmed by a real build+play** — worth Tyler's next rebuild specifically checking (1) a Strike (or any other damage-dealing card) completes normally instead of throwing "No attacker set.", (2) Group1Relic's DrawCard effect no longer kills the turn loop when it fires (breaking block on an enemy), (3) the normal per-turn draw happens again once nothing upstream crashes the turn loop.


---

## "block works, strike is broken, and i had a game crash" — the round 30 fix landed and worked further than before; a new, deeper NullReferenceException found and fixed; a real native crash confirmed but not fully forensics-traceable

Tyler rebuilt with the round 30 fix. Block (a non-damage card) now plays cleanly — confirms round 30's `DrawCard`/`resolvePlayerExpr` work didn't regress anything. Strike (a damage card) still failed, but differently and further along than before — real progress, not a repeat of the same bug.

### Investigation

Fetched the freshest `godot.log` and confirmed via full-timestamp `ls` sort (plain `sort -k6,7` on `ls -la` output only sorts by month/day, not time-of-day — insufficient when several logs share the same day) that `godot.log` (01:11:49) was current.

The Strike card's stack trace confirmed the round 30 `DealDamage` fix genuinely landed and worked correctly:

```
[INFO] Player 1 playing card TESTCHAR-STRIKE_CARD (targeting Toadpole (index 1))
[ERROR] System.NullReferenceException: Object reference not set to an instance of an object.
   at MegaCrit.Sts2.Core.Commands.CardPileCmd+<DrawInternal>d__21.MoveNext_Patch2(...)
   at TestChar.Relics.Group1Relic.AfterBlockBroken(PlayerChoiceContext choiceContext, Creature target, Creature breaker)
   at MegaCrit.Sts2.Core.Commands.CreatureCmd.Damage(...)
   at MegaCrit.Sts2.Core.Commands.Builders.AttackCommand+<Execute>d__90...
   at TestChar.Generated.ForgeActions.DealDamage(PlayerChoiceContext choiceContext, Creature dealer, CardModel sourceCard, CardPlay cardPlay, Creature target, Int32 amount, Int32 hitCount)
   at TestChar.Cards.StrikeCard.OnPlay(...)
```

The `DealDamage` call now shows the real new 7-arg signature — the attack actually executes, correctly hits, and correctly triggers the base game's own real `AfterBlockBroken` hook. That's what reaches Group1Relic's `DrawCard` effect (also a round 30 fix) for the first time — and THAT is where a brand new, different `NullReferenceException` now happens, one level deeper, inside the base game's own `CardPileCmd.DrawInternal`.

Root cause: `TRIGGER_HOOKS.AfterBlockBroken` binds `fgPlayer` to `target` — "whoever's block just broke." Here, Strike hit an ENEMY (Toadpole) and broke ITS block, so `target` (bound as `fgPlayer`) was the ENEMY creature. Round 30's `resolvePlayerExpr(ctx)` fallback, `fgPlayer.Player`, evaluated `Toadpole.Player` — a real property access, but `null`, because a monster-side `Creature` has no owning `Player` at all. `CardPileCmd.Draw(choiceContext, amount, null, false)` dereferencing that null `Player` inside `DrawInternal` is exactly this crash. This is a real, pre-existing gap in `resolvePlayerExpr` itself (not something round 30 introduced) — `GainEnergy`/`GainGold`/`CreateCard`/`EndTurn` already carried the same latent risk on any hook where `playerExpr` can bind to either side (`AfterBlockBroken`, `OnTakeDamage`, `AfterBlockGained`, ...). `DrawCard` was simply the first of that whole family to actually get exercised in real gameplay.

A direct `sts2.dll` read found the real, clean fix: `RelicModel.Owner` is a real, public, get/set property typed `Player` **directly** — genuinely different from `PowerModel.Owner` (Creature-typed, since a mechanic/Power CAN be applied to an enemy). A relic's `Owner` is unambiguously the real player who has it equipped, regardless of which creature triggered this particular firing.

**The game crash**: also checked the connected Sentry crash folder. Found a real, `level: fatal, platform: native` Sentry crash event (`event_id df7dce90-...`) whose session start time (`2026-09-03 01:09:55`) matches this exact play session. Its breadcrumb trail only captured early mod-loading warnings (01:09:57–01:10:02, before combat even started) — this Sentry integration doesn't appear to breadcrumb general gameplay/combat events, and no minidump (`.dmp`) file is present in the connected Sentry folder, only the envelope metadata (device/OS/engine info) and those early breadcrumbs. **I could not recover an actual native stack trace or exception message for this crash** — the forensic evidence available locally doesn't go deeper than "a real fatal native crash happened this session." Given round 30's own established finding that a relic hook exception "kills the whole combat turn loop... stuck until the room is restarted," and this exact session's `DrawInternal` NullReferenceException left combat in exactly that stuck state (the log shows 2 more monster moves logged afterward, then stops abruptly with no clean shutdown), the most plausible explanation is that the native crash was a downstream consequence of continuing to interact with that already-corrupted combat state — but this is inference, not confirmed by a decoded native trace, and should be called out as such.

### Fix

`resolvePlayerExpr(ctx)` gained a new branch: `ctx.entityKind === 'relic'` now resolves to `this.Owner` (the relic's own real, unambiguous `Player`) instead of the old `fgPlayer.Player` fallback. `generateHookEffects`'s `hookCtx` now carries `entityKind` (already available as a function parameter, just not threaded through before) so this can be selected per-call. Mechanics (`ctx.entityKind === 'mechanic'`) keep the old `fgPlayer.Player` fallback for now — `PowerModel.Owner` being Creature-typed means the same ambiguity could theoretically still exist there, but that combination hasn't been hit by any real build yet, so it's left flagged rather than guessed at (same "fix once it's actually reached" discipline as the round 30 write-up's `ExhaustCard`/`DiscardCard` note). This one change automatically improves all 5 real call sites that go through `resolvePlayerExpr` for relics — `DrawCard`, `GainEnergy`, `ModifyGold`, `CreateCard`, and `EndTurn` — not just the one that happened to crash first.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run confirmed Group1Relic's `DrawCard` effect now generates `CardPileCmd.Draw(choiceContext, 6, this.Owner, false)` instead of the null-prone `fgPlayer.Player`. A brace-and-paren balance check across all generated `.cs` files came back clean.

**Not yet re-confirmed by a real build+play** — worth Tyler's next rebuild specifically checking (1) Strike (and any other card that can break an enemy's block while a relic has a DrawCard-on-AfterBlockBroken effect) completes normally and actually draws cards, (2) whether the native crash recurs — if it does NOT recur once this fix is in, that's reasonably strong (though still circumstantial) confirmation the stuck-turn-loop state was the real cause; if it DOES still happen, that's real evidence of a genuinely separate issue worth its own dedicated investigation with a fresh crash report to examine.


---

## "another crash, it looks like it is crashing right as then enemy goes to hit me" — a real, previously-deprioritized card-frame bug, now confirmed firing on every single card, fixed

### Investigation

Fetched the freshest `godot.log` (confirmed current via full-timestamp `ls` sort). The log ends abruptly at line 1327/1327, mid-combat, with **zero managed exception logged** — the last line is simply `[INFO] Monster NIBBIT performing move BUTT_MOVE`, then nothing. Checking the prior rotated log for comparison found the exact same signature: it also cuts off abruptly right after `[INFO] Monster TOADPOLE performing move WHIRL_MOVE`, no shutdown message either. Two independent real sessions, both ending mid-combat with no caught exception, both immediately after a monster's move is announced — a real, reproducible pattern matching Tyler's own description exactly ("crashing right as the enemy goes to hit me").

The connected Sentry crash folder confirmed a real, fresh `level: fatal, platform: native` crash event (`event_id fe377cab-...`) whose session start matches this exact play session. Same limitation as the round 31 crash: no minidump present, breadcrumbs only cover early mod-loading (before combat), no native stack trace recoverable.

Disassembled the real base-game `MonsterModel.PerformMove` (its async state machine, `<PerformMove>d__105.MoveNext`, found via direct `sts2.dll` IL read) to see what runs right after the "performing move" log line — the very next real call is into the concrete `MoveState`'s own `PerformMove` (the actual attack/effect resolution), which is real base-game code, not something Forge generates or controls.

Separately, the same log shows 16 real resource-load errors, all before combat even starts (during the opening hand draw — one per card node), all for the identical broken path:

```
ERROR: Cannot open file 'res://materials/cards/frames/_mat.tres'.
ERROR: Failed loading resource: res://materials/cards/frames/_mat.tres.
ERROR: Error loading resource: 'res://materials/cards/frames/_mat.tres'.
```

This is a previously-known issue (`status.md`'s "materials/cards/frames/_mat.tres empty-segment crash flood") that had been tracked only as a non-fatal Deck View cosmetic annoyance, never confirmed either way as contributing to anything worse. A direct `sts2.dll` IL read of the real call chain (`CardModel.FrameMaterial` → `CardPoolModel.FrameMaterial` → `FrameMaterialPath`) found the exact, literal construction:

```
FrameMaterialPath = "res://materials/cards/frames/" + CardFrameMaterialPath + "_mat.tres"
```

`CardFrameMaterialPath` is a real, abstract, per-pool override. Forge's own `CardPool.cs.template` hardcodes it to a literal empty string — its own existing comment even flagged this honestly at the time: *"left empty rather than inventing a fake-looking res:// path... a real default frame asset path is a known follow-up, not guessed here."** That placeholder produces exactly the broken literal path seen crashing in the log — for **every single TestChar card, every time it's drawn**, not just occasionally.

Given every generated TestChar card has therefore always rendered with a permanently-null `FrameMaterial`, and both real fatal crashes land during a moment of extra combat visual activity (a monster's attack/hit resolution — animations, HUD updates, hand visuals all get touched), a null `Material` propagating into a native Godot rendering call is a real, plausible contributor to an unmanaged access violation. This is **not proven as THE cause** — no native stack trace is recoverable, same honest limitation as round 31's crash forensics — but it's a real, definitely-firing bug regardless, not just cosmetic as previously assumed.

### Fix

A direct `sts2.dll` TypeDef scan of `CardPoolModel`'s real subclasses — the vanilla game's own character card pools — found the real, confirmed-valid values `CardFrameMaterialPath` actually takes:

| Pool | Value |
|---|---|
| IroncladCardPool | `card_frame_red` |
| SilentCardPool | `card_frame_green` |
| DefectCardPool | `card_frame_blue` |
| NecrobinderCardPool | `card_frame_pink` |
| RegentCardPool | `card_frame_orange` |
| Colorless/Status/TokenCardPool | `card_frame_colorless` |
| CurseCardPool | `card_frame_curse` |

(a full string-heap sweep also confirmed `card_frame_quest` exists, used by a non-color role-specific pool — not a real option for a themed custom character, left out).

New `guessCardFrameColorName(hex)` in `compiler.js` reuses the existing `guessEnergyColorName(hex)` heuristic (already bucketing a character's hex color into Red/Orange/Green/Purple/Blue for an unrelated, purely-cosmetic UI purpose) and maps that bucket onto the real frame asset names above. "Purple" has no real vanilla-color match — mapped to the closest real option, `card_frame_pink` (Necrobinder's own), rather than guessed/invented. `CardPool.cs.template`'s `CardFrameMaterialPath` now emits `"{{cardFrameColorName}}"` instead of `""`.

### Verification

`node --check backend/compiler.js`: clean. A real `generateProject()` run against Tyler's test project (character color `#0a3170`, a dark blue) confirmed the generated `TestCharCardPool.cs` now emits `CardFrameMaterialPath => "card_frame_blue"` — a real, existing asset path, not the broken empty-segment one. A brace-and-paren balance check across all 26 generated `.cs` files came back clean.

**Not yet confirmed by a real rebuild+playtest.** This closes a real, definitely-firing bug (every card's frame material was broken, not just cosmetically), which is worth Tyler's next rebuild regardless — but whether it was the actual cause of the two fatal native crashes is still an open, ohestly-flagged question, not a closed one. Worth Tyler's next few playtests specifically noting: (1) do the 16 `_mat.tres` resource-load errors disappear from the log (confirms the fix landed and cards now have a real frame material), and (2) does the "crashing right as the enemy attacks" pattern recur — if it does NOT, that's real (though still circumstantial) evidence this was a contributing cause; if it DOES still happen with the `_mat.tres` errors gone, that's clean evidence the crash has a separate, still-unidentified cause, worth its own fresh investigation once it recurs.


---

## "another of the same crash right as they go to hit me" + "our strike is not reading as a strike to the game" — the REAL crash cause found via a Windows minidump, and a separate data-authoring bug diagnosed

Two unrelated reports in one message. Handled separately below.

### Part 1: the recurring crash — root cause found via a real Windows minidump, not inference this time

Tyler rebuilt with round 32's `CardFrameMaterialPath` fix and hit the exact same crash signature again. Checked the freshest `godot.log`: **zero `_mat.tres` errors this time** (confirmed via `grep -c`), proving round 32's fix genuinely landed in the build — but the game still crashed identically: log ends abruptly mid-combat, right after `[INFO] Monster SEAPUNK performing move SEA_KICK_MOVE`, no managed exception. This cleanly **falsifies** the round 32 hypothesis that the null frame material was a contributing cause — good, real negative evidence, not just another guess.

The connected Sentry folder had the same limitation as before (no stack trace recoverable from breadcrumbs). So this round, checked a location never checked before: `%LOCALAPPDATA%\CrashDumps`, granted by Tyler this session. **Real Windows minidumps exist there for all three of this week's native crashes** (SlayTheSpire2.exe.*.dmp, timestamps matching each crash session exactly). Staged the newest one and parsed it directly (no `minidump` Python package available/installable in this sandbox — hand-parsed the real MINIDUMP format: header, stream directory, exception stream, module list, thread list).

**Real, concrete findings from the minidump itself** (not inference):
- `ExceptionCode = 0xC00000FD` = **`STATUS_STACK_OVERFLOW`**. Not an access violation, not a null-pointer crash — a real, unbounded-recursion stack overflow.
- The faulting thread's captured stack (`~8MB`, fully used) is dominated by a handful of distinct addresses repeating **tens of thousands of times** (43200, 32404, 30604, ... occurrences) — the unmistakable signature of a small number of methods calling each other recursively until the stack ran out. These addresses fall in JIT-compiled managed code (not any static module), consistent with .NET/C# recursion, not native engine code — this rules out the `_mat.tres`/rendering theory even more directly.

**Traced the real recursive call chain via direct `sts2.dll` and the actual installed `TestChar.dll` IL** (not guessed):

1. `TestChar.Relics.Group1Relic.AfterDamageGiven` (Tyler's own real, currently-shipped relic hook — decompiled directly from the live installed mod DLL) has a real effect: on this hook, deal 6 more damage from `dealer` to `target` — compiles to `ForgeActions.DealDamage(choiceContext, dealer, null, null, target, 6, 1)`.
2. Round 30's relic/mechanic damage path routes that into the real `MegaCrit.Sts2.Core.Commands.CreatureCmd.Damage(...)` overload.
3. Direct IL read of `CreatureCmd.Damage`'s real implementation shows it calls the real, **static, global** `MegaCrit.Sts2.Core.Hooks.Hook.AfterDamageGiven(...)` dispatcher.
4. That dispatcher's own real IL: it iterates `ICombatState.IterateHookListeners()` — **every** hook-listening model in combat, unconditionally — and calls `.AfterDamageGiven(...)` on each one. This is a genuinely global "any damage was dealt, by anyone, to anyone" event, not scoped to the relic's own owner.
5. That includes calling back into **`Group1Relic.AfterDamageGiven` again** — which deals 6 more damage — which reaches step 2 again — forever.

This is a fully mechanistic, IL-proven, unconditional infinite loop: **any damage dealt by anyone, anywhere in combat, while this relic's current effect is active, recurses until the stack overflows.** No randomness, no special conditions — a deterministic crash waiting to happen on the very next damage instance once triggered. This fully explains the STATUS_STACK_OVERFLOW evidence, the JIT-address repetition pattern, and why round 32's unrelated fix didn't help.

**Fix**: `backend/validate.js` now rejects (compile-time error, not just a warning) any `DealDamage` action configured on the `AfterDamageGiven` trigger, with a message explaining exactly why and what to do instead. Verified two ways: (1) a synthetic injection test confirmed the check fires with the exact expected message; (2) running the *unmodified* stale test project file through validation found this exact bug **already present for real** in its own saved "Group 1" relic (effects[3]) — same 6-damage amount as the real compiled DLL — confirming this isn't hypothetical, it's Tyler's actual current relic configuration. Removing just that one action and re-validating leaves only one unrelated, pre-existing error (missing `startingRelicId` on that throwaway test file).

**Not a Forge compiler bug in the runtime-codegen sense** — every piece Forge generated here was individually correct (DealDamage does deal damage; the relic hook does fire on damage-given). The bug is a structural interaction: the real base game's hook system is more re-entrant than a first read suggests, and Forge had no guard against authoring an effect that re-triggers its own listening trigger. That gap is now closed for this specific, proven case.

**Action needed from Tyler**: remove the "Deal Damage" action from Group1Relic's `AfterDamageGiven` effect in the Forge UI (the export will now refuse to build until it's gone), then rebuild. If the intent was "counter-attack when I deal damage with an Attack," the safer real equivalent is gating a card's own `OnPlay` (or `AfterCardPlayed`) on `PlayedCardHasType == Attack`, which doesn't create a new "damage given" event of its own.

### Part 2: "our strike is not reading as a strike to the game" — a real, confirmed cause, but a data issue not a compiler bug

Tyler correctly diagnosed the symptom himself. Confirmed via direct IL read of the real, currently-installed `TestChar.dll`'s `StrikeCard`/`DefendCard` constructors (decoding the real `CustomCardModel(int baseCost, CardType type, CardRarity rarity, TargetType target, bool, bool)` argument list against the real `CardType`/`CardRarity` enum values, both confirmed via their real `Constant` table entries in `sts2.dll`):

- **StrikeCard**: `type = Attack` (correct), **`rarity = Common`**, `target = AnyEnemy` (correct).
- **DefendCard**: `type = Skill` (correct), **`rarity = Basic`** (correct), `target = Self` (correct).

The schema's own `rarity` enum description already states: *"'Basic' is the real name for starting-deck cards like Strike/Defend (there is no 'Starter' or 'Special' card rarity in the real game)."* Whatever real base-game system grants "upgrade 1 [basic Attack] and 1 [basic Skill]" almost certainly selects its targets by `CardRarity.Basic` — Defend qualifies, Strike doesn't, because Strike's rarity field is `Common` instead of `Basic`.

Root cause, found in `frontend/index.html`: every brand-new card created in the Forge UI defaults to `rarity: 'Common'`. There's no special "this is a starter card" concept — a card only becomes `Basic` if its Rarity dropdown is explicitly changed. This isn't a compiler bug (`compiler.js`'s `rarity: CardRarity.{{rarity}}` faithfully emits whatever rarity is set); it's a real gap between the character's own intended design (Strike/Defend as basics) and what got saved, most likely because Strike's Rarity dropdown was simply never touched from its default.

**Fix for Tyler**: open Strike in the Forge editor, change its Rarity from "Common" to "Basic," re-export, rebuild. No code change needed on Forge's side for this one — flagged here so the fix path is clear and to close the loop on his own diagnosis, which was exactly right.


---

## "we should warn the user if any loops are present in their triggers/effects" — generalizing round 33's crash fix into a real, IL-verified loop-detection table

Tyler's direct follow-up after round 33's fix: he said he'd manually fix Group1Relic himself, but asked for the general case to be covered, not just the one hardcoded `AfterDamageGiven`+`DealDamage` check. This round builds that — not by guessing which other action/trigger pairs might be dangerous, but by disassembling the real `sts2.dll` method behind every OTHER Forge action type's `ForgeActions` helper and checking, the same way round 33 proved the original case, whether it contains a direct, unconditional `call Hook.<Method>`.

### Method

For each action type with a real (non-stub) codegen path, found its real underlying `sts2.dll` method via `ForgeActions.cs.template`, then disassembled that method's real IL (following into its async state-machine `MoveNext` where relevant — the `async Task Foo(...)` stub methods `ildisasm.py` shows first are just `AsyncTaskMethodBuilder` boilerplate; the actual logic, and any `Hook.*` calls, live in the compiler-generated nested `<Foo>d__N.MoveNext`) and grepped the result for `call MegaCrit.Sts2.Core.Hooks.Hook::`.

### Results — 6 real action types checked this round, 4 found dangerous, 2 confirmed safe

| Forge action | Real call | Hook fired? | Verdict |
|---|---|---|---|
| `ModifyHp` (Gain/Heal) | `Creature.HealInternal` (direct) | none | **safe** |
| `ModifyHp` (Lose) | `Creature.LoseHpInternal` (direct) | none | **safe** |
| `GainBlock` | `Creature.GainBlockInternal` (direct) | none | **safe** |
| `ModifyStatus` (Add, Self/SingleEnemy/RandomEnemy) | `Creature.ApplyPowerInternal` (direct) | none | **safe** |
| `ModifyStatus` (Add, **AllEnemies**) | `PowerCmd.Apply<T>` → `<Apply>d__2.MoveNext` | **`Hook.AfterPowerAmountChanged`** | **DANGEROUS** |
| `ModifyGold` (Gain) | `PlayerCmd.GainGold` → `<GainGold>d__9.MoveNext` | **`Hook.AfterGoldGained`** | **DANGEROUS** |
| `ModifyGold` (Lose) | `PlayerCmd.LoseGold` (plain sync method, no async state machine at all) | none | **safe** |
| `DrawCard` | `CardPileCmd.Draw` → `<DrawInternal>d__21.MoveNext` | **`Hook.AfterCardDrawn`** | **DANGEROUS** |
| `ExhaustCard` (non-random) | `CardCmd.Exhaust` → `<Exhaust>d__6.MoveNext` | **`Hook.AfterCardExhausted`** | **DANGEROUS** |
| `DiscardCard` (non-random) | `CardCmd.Discard` → delegates to `CardCmd.DiscardAndDraw` → `<DiscardAndDraw>d__4.MoveNext` | **`Hook.AfterCardDiscarded`** | **DANGEROUS** (relic/mechanic-facing trigger only — see note below) |
| `DealDamage` (any target, including `AllEnemies`) | `CreatureCmd.Damage`, reached both via the relic/mechanic path (round 33) AND the card path (`AttackCommand.Execute` → confirmed round 34 by direct IL read: `Execute` calls `CreatureCmd::Damage` directly) | `Hook.AfterDamageGiven` | **DANGEROUS** — same case round 33 already fixed; independently re-confirmed the card path funnels through the identical call, and confirmed `target: "AllEnemies"` is still `action.type: "DealDamage"` at the schema level (not a separate type), so round 33's original check already covered it |

One important asymmetry worth calling out: `ModifyStatus` is genuinely different depending on `target`. Applying a status to one specific creature goes through a low-level direct call that never touches the hook system at all; applying to `AllEnemies` goes through the real `PowerCmd.Apply<T>` command layer instead, which **does** fire the hook. Same schema `type`, same `mode`, different real danger depending on `target` — this is exactly the kind of thing that can't be gotten right by pattern-matching on the JSON shape without checking the real compiled call each variant actually makes.

Also worth noting explicitly: the card-facing `OnDiscard` trigger (`CARD_TRIGGERS`) is a different, `selfFilter`-restricted variant of the relic/mechanic-facing `AfterCardDiscarded` trigger (`HOOK_TRIGGERS`) — it only fires for "this exact card instance was discarded." By the time it runs, the triggering card has already left hand and physically can't be re-selected by its own `DiscardCard` action, so a card's own `OnDiscard` + `DiscardCard` is real and confirmed-safe (a *different* copy of the same card could theoretically get swept up and cascade, but that's bounded by hand size/copy count, not an unconditional forever-loop) — deliberately left unflagged, not overlooked.

### Fix

`backend/validate.js` — replaced round 33's single hardcoded `if (eff.trigger === 'AfterDamageGiven') { ...check for DealDamage... }` block with a general, table-driven `TRIGGER_SELF_LOOP_ACTIONS` map (trigger name → predicate over an action), keyed by all 5 real dangerous pairs found above (round 33's original `AfterDamageGiven`/`DealDamage` plus this round's 4 new ones), each with its own doc comment citing the exact real method/IL evidence. `validateEffects` now does one generic lookup instead of a special case, checking both `eff.actions` and `eff.elseActions` the same way round 33 did, and reports which specific action type and trigger caused the rejection.

### Verification

`node --check` on both `validate.js` and `compiler.js` (untouched this round, checked anyway): clean. Built a synthetic test package (the same real, known-stale `character_project.json` test file plus 10 injected synthetic relics — one deliberately-dangerous relic per new pair, plus 4 deliberately-safe control relics for the confirmed-safe combinations) and ran it directly through `validateCharacterPackage`: all 5 dangerous pairs (round 33's original DealDamage case plus the 4 new ones — `ModifyStatus`+`AllEnemies`, `ModifyGold` Gain, `DrawCard`, `ExhaustCard`, `DiscardCard`, which is 5 keys covering 6 test relics since DealDamage's AllEnemies case reuses the same key) fired their expected error exactly once each; all 4 safe control relics produced zero false positives. Re-ran the real, unmodified stale test project file through the new general validator afterward: found exactly the same one real bug round 33 already found (Group1Relic's `AfterDamageGiven`→`DealDamage`) and nothing new — confirming no other instance of this whole broader bug class currently exists in Tyler's actual saved data. A full `generateProject()` run against the same test file (compiler.js itself wasn't touched this round) came back clean — 63 files written, no errors.

### Action needed from Tyler

None beyond what round 33 already asked (removing Group1Relic's `AfterDamageGiven`→`DealDamage` action, which he said he'd do himself). This round adds no new required action — it closes 4 additional real crash classes that hadn't been hit yet in play but were sitting there waiting, the same way the DealDamage one was before it got hit.
