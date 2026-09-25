// compiler.js
// Turns a validated CharacterPackage (see schema/character.schema.json) into
// a folder of generated C# source + a Godot `pack/` project, ready to be
// built by `dotnet build` into a real mod (.dll + .pck + manifest .json).
//
// IMPORTANT ARCHITECTURE NOTE:
// This module ONLY generates source. It never touches a database and never
// writes the incoming character JSON anywhere persistent — the caller
// (server.js) is responsible for using a fresh temp directory per request
// and deleting it once the response has been sent.
//
// ACCURACY NOTE (read TOOLCHAIN_FINDINGS.md for the full picture):
// This version replaces the previous session's from-scratch guesses with
// templates grounded in real, verified sources — a working example mod's
// checked-in source, and namespaces decompiled out of two real character
// mods already sitting in your STS2 mods folder. But several specific
// signatures (CustomCardModel's constructor, CustomCharacterModel's numeric
// setup surface, most relic hook method signatures beyond AfterDamageGiven)
// are still BEST EFFORT, not confirmed against real BaseLib source — every
// generated file says so inline, at the exact point the guess is made.

const fs = require('fs');
const path = require('path');
// [Round 119] Real server-side PNG recolor — see these modules' own header
// comments for the full story (Tyler: "Bake Forge's per-layer Recolor tint
// into the export", after IL disassembly proved the game's own
// CustomEnergyCounter colors don't retint layer art at all).
const { tintPngBuffer, tintPngBufferMiddleGradient } = require('./lib/pngTint');
const { autoLayerColors } = require('./lib/colorMath');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const BASELIB_MIN_VERSION = '3.4.1'; // seen in both installed mods' manifests — bump/verify before relying on it

function loadTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

// Same as loadTemplate() but for raw bytes (PNGs, the tiny .cs script
// stubs below) instead of utf8 text -- used by the card-trail VFX
// dependency bundle in writeCharacterArt() below.
function loadTemplateBinary(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name));
}

function fillTemplate(tpl, values) {
  return tpl.replace(/{{(\w+)}}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing template value: ${key}`);
    return values[key];
  });
}

function pascalCase(str) {
  return String(str)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// [VERIFIED via direct sts2.dll IL disassembly, 2026-09-01 — see
// TOOLCHAIN_FINDINGS.md "black screen on embark" section] This is a
// faithful port of the REAL algorithm the game itself uses to turn a C#
// class name into its ModelId.Entry (the string baked into every
// convention-based res:// asset path Forge needs to match exactly —
// character-select background/locked-icon/transition-material paths all
// derive from this, and none of them have a C# override point Forge can
// redirect instead). Traced: AbstractModel..ctor -> ModelDb.GetId(Type) ->
// ModelDb.GetEntry(Type) -> StringHelper.Slugify(type.Name), then read the
// exact real regex patterns straight out of sts2.dll's own metadata (3
// source-generated [GeneratedRegex] classes):
//   1. CamelCaseRegex  /([A-Za-z0-9]|\G(?!^))([A-Z])/  -> '$1_$2'
//   2. .ToUpperInvariant()
//   3. WhitespaceRegex /\s+/                            -> '_'
//   4. SpecialCharRegex /[^A-Z0-9_]/                     -> ''
// Confirmed correct against TWO real, independent examples straight out of
// Tyler's own godot.log: class "TestCharCharacter" -> entry
// "TEST_CHAR_CHARACTER", class "Group1Relic" -> entry "GROUP1_RELIC" (both
// appear verbatim in real crash/loc-key log lines). JS has no \G anchor,
// but \G(?!^) only changes behavior for BACK-TO-BACK capital runs
// (acronyms like "XMLParser") — Forge's own generated class names are
// always `pascalCase(name) + a fixed suffix` (Character/Relic/Card/...),
// which only produces that pattern if a user types an already-all-caps
// word with no separating space/punctuation (pascalCase capitalizes each
// word's first letter but does NOT lowercase the rest — see pascalCase
// above). [BEST EFFORT] for that one rare edge case; [VERIFIED] for every
// normal name.
function slugifyClassName(className) {
  let s = String(className).trim();
  s = s.replace(/([A-Za-z0-9])([A-Z])/g, '$1_$2');
  s = s.toUpperCase().replace(/\s+/g, '_');
  s = s.replace(/[^A-Z0-9_]/g, '');
  return s;
}

function escapeXmlText(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// [UNVERIFIED — cosmetic only] EnergyColorName is a plain string on
// CardPoolModel/RelicPoolModel/PotionPoolModel (confirmed via
// reflect-baselib), so any value compiles — there's no enum to get wrong.
// Real valid/expected values are unknown; this is a crude hue bucket off
// the character's own hex color purely so the field isn't blank.
// [VERIFIED] Godot .tscn/.tres text-resource Color(...) literals take
// float components in [0,1], not a hex string (unlike the C#-side
// `new Color("#RRGGBB")` constructor used elsewhere in this file for
// CustomEnergyCounter etc.) -- this converts Forge's own hex color field
// to that format for retinting a bundled template scene's modulate colors.
function hexToFloatRgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  if (h.length < 6) return { r: 1, g: 1, b: 1 };
  const r = parseInt(h.substr(0, 2), 16) / 255;
  const g = parseInt(h.substr(2, 2), 16) / 255;
  const b = parseInt(h.substr(4, 2), 16) / 255;
  return { r, g, b };
}

function guessEnergyColorName(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  if (h.length < 6) return 'Red';
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  if (r >= g && r >= b) return (g >= b) ? 'Orange' : 'Red';
  if (g >= r && g >= b) return 'Green';
  return (r >= g) ? 'Purple' : 'Blue';
}

// [Fix, round 32 — real crash: godot.log showed 16 real resource-load
// failures per combat ("Cannot open file 'res://materials/cards/frames/
// _mat.tres'"), one per TestChar card node, immediately followed (across
// two separate real sessions) by a fatal native crash mid-combat — see
// TOOLCHAIN_FINDINGS.md "crashing right as the enemy goes to hit me"]
// Maps guessEnergyColorName's existing 5-way hex bucket onto the real,
// confirmed-valid CardFrameMaterialPath values a direct sts2.dll TypeDef
// scan found on the game's own real vanilla card pools (Ironclad="red",
// Silent="green", Defect="blue", Necrobinder="pink", Regent="orange",
// Colorless/Status/Token="colorless"). "Purple" has no real vanilla-color
// match — mapped to the closest real option, "pink" (Necrobinder's own),
// rather than guessed/invented.
function guessCardFrameColorName(hex) {
  const bucket = guessEnergyColorName(hex);
  const REAL_FRAME_COLOR_BY_BUCKET = {
    Red: 'red',
    Orange: 'orange',
    Green: 'green',
    Blue: 'blue',
    Purple: 'pink', // closest real vanilla frame asset; no real "purple" frame exists
  };
  return `card_frame_${REAL_FRAME_COLOR_BY_BUCKET[bucket] || 'colorless'}`;
}

// --- action -> C# statement -----------------------------------------------
// Every branch here calls into ForgeActions (templates/ForgeActions.cs.template),
// never the game/BaseLib API directly — see that file's header for why.
// Confidence tags mirror the ones used there.

// Set by generateProject() before any card/relic source is generated for a
// given character (see there) — maps a schema mechanic id (`statusRef` on
// an ApplyCustomStatus/RemoveCustomStatus action or a HasStatusStacks
// condition) to the real generated `Powers/XxxPower.cs` class name, so ForgeActions'
// generic `ApplyStatus<T>()`/`RemoveStatus<T>()`/`GetStatusStacks<T>()`
// calls (see TOOLCHAIN_FINDINGS.md "reflect-baselib round 7" — Creature's
// GetPower<T>()/HasPower<T>()/GetPowerAmount<T>() are all real generic
// methods) can reference the right type. Module-level rather than threaded
// through effectBlockToCSharp/actionToCSharp/conditionToCSharp's call
// chain, matching this file's existing TRIGGER_HOOKS-style module-scoped
// constants — safe because generateProject runs a single character
// synchronously per call, never concurrently with itself.
let currentMechanicClassById = new Map();

function mechanicClassName(statusRef) {
  const cls = currentMechanicClassById.get(statusRef);
  if (!cls) throw new Error(`Action/condition references mechanic id "${statusRef}" which isn't defined in this character's mechanics[].`);
  return cls;
}

// [Round 139] Same module-level pattern as currentMechanicClassById above,
// set by generateProject() before any card source is generated — the set
// of this character's own custom keyword words (see character.cardKeywords
// in the schema), PascalCase-normalized the same way pascalCase() already
// normalizes every other generated identifier. keywordExpr() below is the
// one place every CardKeyword-emitting call site (generateCanonicalKeywordsOverride,
// conditionToCSharp's PlayedCardHasKeyword case, generateKeywordCalls'
// TryModifyKeywordsInCombat case) goes through, so they never need to know
// built-in vs custom themselves.
//
// [VERIFIED real BaseLib mechanism via reflect-baselib round 139, direct
// TypeDef read of the installed BaseLib.dll] `BaseLib.Patches.Content.
// CustomEnumAttribute(string name = null)` and `BaseLib.Patches.Content.
// KeywordPropertiesAttribute(AutoKeywordPosition position, bool
// richKeyword = false)` are real attributes; `BaseLib.Patches.Content.
// AutoKeywordPosition` is a real enum with exactly None/Before/After
// members. A real working example was found on Tyler's own machine
// (Keywords/ModKeywords.cs, header: "AUTO-GENERATED by STS2 Character
// Creator — do not edit manually"): `[CustomEnum(null)] [KeywordProperties
// (AutoKeywordPosition.After)] public static CardKeyword Heavy;` — a
// STATIC FIELD, not an enum member; BaseLib's GenEnumValues rewrites it
// into a genuinely new CardKeyword value at ModelDb.Init. This means a
// custom keyword is referenced elsewhere as `<Namespace>.Keywords.
// ModKeywords.Heavy` — NOT `CardKeyword.Heavy`, since no such enum member
// exists at compile time — which is exactly what keywordExpr() decides
// between. See generateModKeywordsSource() below for the file this
// registers against.
let currentCustomKeywordWords = new Set();
let currentKeywordNamespace = '';

function keywordExpr(word) {
  if (currentCustomKeywordWords.has(word)) return `${currentKeywordNamespace}.Keywords.ModKeywords.${word}`;
  return `CardKeyword.${word}`;
}

// Generates Keywords/ModKeywords.cs — the real BaseLib CustomEnum
// registration file for this character's custom keywords (see
// keywordExpr()'s own comment for the full evidence trail). Returns null
// when the character has no cardKeywords, so generateProject can skip
// writing the file entirely rather than writing an empty static class.
function generateModKeywordsSource(character, namespace) {
  const kws = Array.isArray(character.cardKeywords) ? character.cardKeywords : [];
  if (!kws.length) return null;
  const fields = kws.map(k => {
    const word = pascalCase(k.word);
    const position = (k.position === 'Before' || k.position === 'After') ? k.position : 'After';
    return `    [CustomEnum(null)]\n    [KeywordProperties(AutoKeywordPosition.${position})]\n    public static CardKeyword ${word};`;
  }).join('\n\n');
  return `// AUTO-GENERATED by STS2 Character Creator — do not edit manually
using BaseLib.Patches.Content;
using MegaCrit.Sts2.Core.Entities.Cards;

namespace ${namespace}.Keywords;

// BaseLib's GenEnumValues finds these by attribute at ModelDb.Init and gives
// each one a real CardKeyword value. [BEST EFFORT, unconfirmed via
// reflection] The loc rows they read are assumed to live in
// localization/eng/card_keywords.json under "${namespace.toUpperCase()}-<NAME>"
// (see that file, written alongside this one) — modeled on a real example
// found on this machine, not independently confirmed.
public static class ModKeywords
{
${fields}
}
`;
}

// [BEST EFFORT, unconfirmed via reflection — see generateModKeywordsSource's
// own comment] Best-guess localization rows for each custom keyword's
// description text, keyed "<MODID>-<NAME>" (uppercased) per the real
// ModKeywords.cs example found on Tyler's machine. Returns null when the
// character has no cardKeywords.
function generateCardKeywordsLocalization(character, namespace) {
  const kws = Array.isArray(character.cardKeywords) ? character.cardKeywords : [];
  if (!kws.length) return null;
  const modIdUpper = namespace.toUpperCase();
  const rows = {};
  for (const k of kws) {
    const word = pascalCase(k.word);
    rows[`${modIdUpper}-${word.toUpperCase()}`] = String(k.description || '');
  }
  return JSON.stringify(rows, null, 2) + '\n';
}

// Real BaseLib/MegaCrit built-in power classes — [VERIFIED to exist as
// classes] found via reflect-baselib round 8's full
// `MegaCrit.Sts2.Core.Models.Powers` namespace listing (108KB dump,
// e99b61b2-reflectoutput.txt), by keeping every class whose reported
// `(base: ...)` is `MegaCrit.Sts2.Core.Models.PowerModel` DIRECTLY (247
// classes) — this excludes compiler-generated nested types (`+<>c`,
// `+Data`, async-state-machine `+<...>d__N` types) and excludes classes
// that derive some OTHER concrete power (e.g. a handful of one-off classes
// derive `TemporaryStrengthPower` rather than `PowerModel` itself), since
// those aren't safe to `new()` up and apply generically the way this map's
// consumer (ForgeActions.ApplyStatus<T>()) does. Originally only 2 entries
// (Strength, Dexterity, found by name in round 8); expanded to the full
// list per Tyler's request ("scan the game's files for a list of all
// vanilla statuses, not just Strength and Dexterity") — no new
// reflect-baselib run was needed, this was mined from data already on
// hand. Fully-qualified with `global::` rather than added as a `using` in
// the templates, so a mod author's own custom mechanic with a colliding
// name (e.g. "Strength", which would generate
// `{{namespace}}.Powers.StrengthPower`) can never collide with or shadow
// the real built-in class.
//
// [RESOLVED via reflect-baselib round 9]: ForgeActions.ApplyStatus<T>()'s
// generic constraint is `where T : PowerModel, new()` — every T needs a
// PUBLIC PARAMETERLESS constructor. Round 9 ran DumpConstructors across
// every one of these 247 classes for real (closing the open risk this
// comment used to describe) — 244 of them have one (either declared
// `public ClassName()`, or no declared constructor at all, which C# gives
// an implicit public parameterless one). The other 3 —
// TemporaryDexterityPower/TemporaryFocusPower/TemporaryStrengthPower —
// have a PROTECTED parameterless constructor instead, which fails this
// exact generic constraint (`new T()` would be a hard CS0122). See
// PROTECTED_CTOR_BUILTIN_POWERS right below the map — those 3 are
// excluded from BUILTIN_STATUSES (the selectable list) so this can never
// actually be selected and generate broken code.
const BUILTIN_POWER_CLASS_MAP = {
  Accelerant: 'global::MegaCrit.Sts2.Core.Models.Powers.AccelerantPower',
  Accuracy: 'global::MegaCrit.Sts2.Core.Models.Powers.AccuracyPower',
  Adaptable: 'global::MegaCrit.Sts2.Core.Models.Powers.AdaptablePower',
  Afterimage: 'global::MegaCrit.Sts2.Core.Models.Powers.AfterimagePower',
  Aggression: 'global::MegaCrit.Sts2.Core.Models.Powers.AggressionPower',
  Ambergris: 'global::MegaCrit.Sts2.Core.Models.Powers.AmbergrisPower',
  Arsenal: 'global::MegaCrit.Sts2.Core.Models.Powers.ArsenalPower',
  Artifact: 'global::MegaCrit.Sts2.Core.Models.Powers.ArtifactPower',
  Asleep: 'global::MegaCrit.Sts2.Core.Models.Powers.AsleepPower',
  Automation: 'global::MegaCrit.Sts2.Core.Models.Powers.AutomationPower',
  BackAttackLeft: 'global::MegaCrit.Sts2.Core.Models.Powers.BackAttackLeftPower',
  BackAttackRight: 'global::MegaCrit.Sts2.Core.Models.Powers.BackAttackRightPower',
  Barricade: 'global::MegaCrit.Sts2.Core.Models.Powers.BarricadePower',
  BattlewornDummyTimeLimit: 'global::MegaCrit.Sts2.Core.Models.Powers.BattlewornDummyTimeLimitPower',
  BeaconOfHope: 'global::MegaCrit.Sts2.Core.Models.Powers.BeaconOfHopePower',
  BiasedCognition: 'global::MegaCrit.Sts2.Core.Models.Powers.BiasedCognitionPower',
  BlackHole: 'global::MegaCrit.Sts2.Core.Models.Powers.BlackHolePower',
  BlockNextTurn: 'global::MegaCrit.Sts2.Core.Models.Powers.BlockNextTurnPower',
  Blur: 'global::MegaCrit.Sts2.Core.Models.Powers.BlurPower',
  BorrowedTime: 'global::MegaCrit.Sts2.Core.Models.Powers.BorrowedTimePower',
  Buffer: 'global::MegaCrit.Sts2.Core.Models.Powers.BufferPower',
  Burrowed: 'global::MegaCrit.Sts2.Core.Models.Powers.BurrowedPower',
  Burst: 'global::MegaCrit.Sts2.Core.Models.Powers.BurstPower',
  Cacophony: 'global::MegaCrit.Sts2.Core.Models.Powers.CacophonyPower',
  Calamity: 'global::MegaCrit.Sts2.Core.Models.Powers.CalamityPower',
  Calcify: 'global::MegaCrit.Sts2.Core.Models.Powers.CalcifyPower',
  CallOfTheVoid: 'global::MegaCrit.Sts2.Core.Models.Powers.CallOfTheVoidPower',
  ChainsOfBinding: 'global::MegaCrit.Sts2.Core.Models.Powers.ChainsOfBindingPower',
  ChildOfTheStars: 'global::MegaCrit.Sts2.Core.Models.Powers.ChildOfTheStarsPower',
  Clarity: 'global::MegaCrit.Sts2.Core.Models.Powers.ClarityPower',
  Colossus: 'global::MegaCrit.Sts2.Core.Models.Powers.ColossusPower',
  Concoct: 'global::MegaCrit.Sts2.Core.Models.Powers.ConcoctPower',
  Confused: 'global::MegaCrit.Sts2.Core.Models.Powers.ConfusedPower',
  Conqueror: 'global::MegaCrit.Sts2.Core.Models.Powers.ConquerorPower',
  Constrict: 'global::MegaCrit.Sts2.Core.Models.Powers.ConstrictPower',
  ConsumingShadow: 'global::MegaCrit.Sts2.Core.Models.Powers.ConsumingShadowPower',
  Coolant: 'global::MegaCrit.Sts2.Core.Models.Powers.CoolantPower',
  CorrosiveWave: 'global::MegaCrit.Sts2.Core.Models.Powers.CorrosiveWavePower',
  Corruption: 'global::MegaCrit.Sts2.Core.Models.Powers.CorruptionPower',
  Countdown: 'global::MegaCrit.Sts2.Core.Models.Powers.CountdownPower',
  Covered: 'global::MegaCrit.Sts2.Core.Models.Powers.CoveredPower',
  CrabRage: 'global::MegaCrit.Sts2.Core.Models.Powers.CrabRagePower',
  CreativeAi: 'global::MegaCrit.Sts2.Core.Models.Powers.CreativeAiPower',
  CrimsonMantle: 'global::MegaCrit.Sts2.Core.Models.Powers.CrimsonMantlePower',
  Cruelty: 'global::MegaCrit.Sts2.Core.Models.Powers.CrueltyPower',
  Curious: 'global::MegaCrit.Sts2.Core.Models.Powers.CuriousPower',
  CurlUp: 'global::MegaCrit.Sts2.Core.Models.Powers.CurlUpPower',
  Dampen: 'global::MegaCrit.Sts2.Core.Models.Powers.DampenPower',
  DanseMacabre: 'global::MegaCrit.Sts2.Core.Models.Powers.DanseMacabrePower',
  DarkEmbrace: 'global::MegaCrit.Sts2.Core.Models.Powers.DarkEmbracePower',
  Debilitate: 'global::MegaCrit.Sts2.Core.Models.Powers.DebilitatePower',
  Demesne: 'global::MegaCrit.Sts2.Core.Models.Powers.DemesnePower',
  Demise: 'global::MegaCrit.Sts2.Core.Models.Powers.DemisePower',
  DemonForm: 'global::MegaCrit.Sts2.Core.Models.Powers.DemonFormPower',
  DevourLife: 'global::MegaCrit.Sts2.Core.Models.Powers.DevourLifePower',
  Dexterity: 'global::MegaCrit.Sts2.Core.Models.Powers.DexterityPower',
  DieForYou: 'global::MegaCrit.Sts2.Core.Models.Powers.DieForYouPower',
  Disintegration: 'global::MegaCrit.Sts2.Core.Models.Powers.DisintegrationPower',
  Doom: 'global::MegaCrit.Sts2.Core.Models.Powers.DoomPower',
  DoubleDamage: 'global::MegaCrit.Sts2.Core.Models.Powers.DoubleDamagePower',
  DrawCardsNextTurn: 'global::MegaCrit.Sts2.Core.Models.Powers.DrawCardsNextTurnPower',
  Duplication: 'global::MegaCrit.Sts2.Core.Models.Powers.DuplicationPower',
  EchoForm: 'global::MegaCrit.Sts2.Core.Models.Powers.EchoFormPower',
  EnergyNextTurn: 'global::MegaCrit.Sts2.Core.Models.Powers.EnergyNextTurnPower',
  Enrage: 'global::MegaCrit.Sts2.Core.Models.Powers.EnragePower',
  Entropy: 'global::MegaCrit.Sts2.Core.Models.Powers.EntropyPower',
  Envenom: 'global::MegaCrit.Sts2.Core.Models.Powers.EnvenomPower',
  EscapeArtist: 'global::MegaCrit.Sts2.Core.Models.Powers.EscapeArtistPower',
  FanOfKnives: 'global::MegaCrit.Sts2.Core.Models.Powers.FanOfKnivesPower',
  Fasten: 'global::MegaCrit.Sts2.Core.Models.Powers.FastenPower',
  FeelNoPain: 'global::MegaCrit.Sts2.Core.Models.Powers.FeelNoPainPower',
  Feral: 'global::MegaCrit.Sts2.Core.Models.Powers.FeralPower',
  FlameBarrier: 'global::MegaCrit.Sts2.Core.Models.Powers.FlameBarrierPower',
  Flanking: 'global::MegaCrit.Sts2.Core.Models.Powers.FlankingPower',
  Flutter: 'global::MegaCrit.Sts2.Core.Models.Powers.FlutterPower',
  Focus: 'global::MegaCrit.Sts2.Core.Models.Powers.FocusPower',
  ForbiddenGrimoire: 'global::MegaCrit.Sts2.Core.Models.Powers.ForbiddenGrimoirePower',
  ForegoneConclusion: 'global::MegaCrit.Sts2.Core.Models.Powers.ForegoneConclusionPower',
  Frail: 'global::MegaCrit.Sts2.Core.Models.Powers.FrailPower',
  FreeAttack: 'global::MegaCrit.Sts2.Core.Models.Powers.FreeAttackPower',
  FreePower: 'global::MegaCrit.Sts2.Core.Models.Powers.FreePowerPower',
  FreeSkill: 'global::MegaCrit.Sts2.Core.Models.Powers.FreeSkillPower',
  Friendship: 'global::MegaCrit.Sts2.Core.Models.Powers.FriendshipPower',
  Furnace: 'global::MegaCrit.Sts2.Core.Models.Powers.FurnacePower',
  Galvanic: 'global::MegaCrit.Sts2.Core.Models.Powers.GalvanicPower',
  Genesis: 'global::MegaCrit.Sts2.Core.Models.Powers.GenesisPower',
  Gigantification: 'global::MegaCrit.Sts2.Core.Models.Powers.GigantificationPower',
  Gravity: 'global::MegaCrit.Sts2.Core.Models.Powers.GravityPower',
  Guarded: 'global::MegaCrit.Sts2.Core.Models.Powers.GuardedPower',
  Hailstorm: 'global::MegaCrit.Sts2.Core.Models.Powers.HailstormPower',
  HammerTime: 'global::MegaCrit.Sts2.Core.Models.Powers.HammerTimePower',
  Hang: 'global::MegaCrit.Sts2.Core.Models.Powers.HangPower',
  HardToKill: 'global::MegaCrit.Sts2.Core.Models.Powers.HardToKillPower',
  HardenedShell: 'global::MegaCrit.Sts2.Core.Models.Powers.HardenedShellPower',
  Hatch: 'global::MegaCrit.Sts2.Core.Models.Powers.HatchPower',
  Haunt: 'global::MegaCrit.Sts2.Core.Models.Powers.HauntPower',
  Heist: 'global::MegaCrit.Sts2.Core.Models.Powers.HeistPower',
  HelloWorld: 'global::MegaCrit.Sts2.Core.Models.Powers.HelloWorldPower',
  Hellraiser: 'global::MegaCrit.Sts2.Core.Models.Powers.HellraiserPower',
  Hex: 'global::MegaCrit.Sts2.Core.Models.Powers.HexPower',
  Hibernate: 'global::MegaCrit.Sts2.Core.Models.Powers.HibernatePower',
  HighVoltage: 'global::MegaCrit.Sts2.Core.Models.Powers.HighVoltagePower',
  Illusion: 'global::MegaCrit.Sts2.Core.Models.Powers.IllusionPower',
  Imbalanced: 'global::MegaCrit.Sts2.Core.Models.Powers.ImbalancedPower',
  ImitationLearning: 'global::MegaCrit.Sts2.Core.Models.Powers.ImitationLearningPower',
  Improvement: 'global::MegaCrit.Sts2.Core.Models.Powers.ImprovementPower',
  Inferno: 'global::MegaCrit.Sts2.Core.Models.Powers.InfernoPower',
  Infested: 'global::MegaCrit.Sts2.Core.Models.Powers.InfestedPower',
  InfiniteBlades: 'global::MegaCrit.Sts2.Core.Models.Powers.InfiniteBladesPower',
  Intangible: 'global::MegaCrit.Sts2.Core.Models.Powers.IntangiblePower',
  Intercept: 'global::MegaCrit.Sts2.Core.Models.Powers.InterceptPower',
  Iteration: 'global::MegaCrit.Sts2.Core.Models.Powers.IterationPower',
  Juggernaut: 'global::MegaCrit.Sts2.Core.Models.Powers.JuggernautPower',
  Juggling: 'global::MegaCrit.Sts2.Core.Models.Powers.JugglingPower',
  Knockdown: 'global::MegaCrit.Sts2.Core.Models.Powers.KnockdownPower',
  Leadership: 'global::MegaCrit.Sts2.Core.Models.Powers.LeadershipPower',
  Lethality: 'global::MegaCrit.Sts2.Core.Models.Powers.LethalityPower',
  LightningRod: 'global::MegaCrit.Sts2.Core.Models.Powers.LightningRodPower',
  Loop: 'global::MegaCrit.Sts2.Core.Models.Powers.LoopPower',
  MachineLearning: 'global::MegaCrit.Sts2.Core.Models.Powers.MachineLearningPower',
  MagicBomb: 'global::MegaCrit.Sts2.Core.Models.Powers.MagicBombPower',
  MasterPlanner: 'global::MegaCrit.Sts2.Core.Models.Powers.MasterPlannerPower',
  Mayhem: 'global::MegaCrit.Sts2.Core.Models.Powers.MayhemPower',
  MindRot: 'global::MegaCrit.Sts2.Core.Models.Powers.MindRotPower',
  Minion: 'global::MegaCrit.Sts2.Core.Models.Powers.MinionPower',
  MonarchsGaze: 'global::MegaCrit.Sts2.Core.Models.Powers.MonarchsGazePower',
  Monologue: 'global::MegaCrit.Sts2.Core.Models.Powers.MonologuePower',
  NecroMastery: 'global::MegaCrit.Sts2.Core.Models.Powers.NecroMasteryPower',
  Nemesis: 'global::MegaCrit.Sts2.Core.Models.Powers.NemesisPower',
  Neurosurge: 'global::MegaCrit.Sts2.Core.Models.Powers.NeurosurgePower',
  Nightmare: 'global::MegaCrit.Sts2.Core.Models.Powers.NightmarePower',
  NoBlock: 'global::MegaCrit.Sts2.Core.Models.Powers.NoBlockPower',
  NoDraw: 'global::MegaCrit.Sts2.Core.Models.Powers.NoDrawPower',
  NoEnergyGain: 'global::MegaCrit.Sts2.Core.Models.Powers.NoEnergyGainPower',
  Nostalgia: 'global::MegaCrit.Sts2.Core.Models.Powers.NostalgiaPower',
  NoxiousFumes: 'global::MegaCrit.Sts2.Core.Models.Powers.NoxiousFumesPower',
  Oblivion: 'global::MegaCrit.Sts2.Core.Models.Powers.OblivionPower',
  OneForAll: 'global::MegaCrit.Sts2.Core.Models.Powers.OneForAllPower',
  OneTwoPunch: 'global::MegaCrit.Sts2.Core.Models.Powers.OneTwoPunchPower',
  Orbit: 'global::MegaCrit.Sts2.Core.Models.Powers.OrbitPower',
  Pagestorm: 'global::MegaCrit.Sts2.Core.Models.Powers.PagestormPower',
  PainfulStabs: 'global::MegaCrit.Sts2.Core.Models.Powers.PainfulStabsPower',
  PaleBlueDot: 'global::MegaCrit.Sts2.Core.Models.Powers.PaleBlueDotPower',
  Panache: 'global::MegaCrit.Sts2.Core.Models.Powers.PanachePower',
  PaperCuts: 'global::MegaCrit.Sts2.Core.Models.Powers.PaperCutsPower',
  Parry: 'global::MegaCrit.Sts2.Core.Models.Powers.ParryPower',
  PersonalHive: 'global::MegaCrit.Sts2.Core.Models.Powers.PersonalHivePower',
  PhantomBlades: 'global::MegaCrit.Sts2.Core.Models.Powers.PhantomBladesPower',
  PillarOfCreation: 'global::MegaCrit.Sts2.Core.Models.Powers.PillarOfCreationPower',
  Plating: 'global::MegaCrit.Sts2.Core.Models.Powers.PlatingPower',
  Plow: 'global::MegaCrit.Sts2.Core.Models.Powers.PlowPower',
  Poison: 'global::MegaCrit.Sts2.Core.Models.Powers.PoisonPower',
  PossessSpeed: 'global::MegaCrit.Sts2.Core.Models.Powers.PossessSpeedPower',
  PossessStrength: 'global::MegaCrit.Sts2.Core.Models.Powers.PossessStrengthPower',
  PrepTime: 'global::MegaCrit.Sts2.Core.Models.Powers.PrepTimePower',
  Pyre: 'global::MegaCrit.Sts2.Core.Models.Powers.PyrePower',
  Radiance: 'global::MegaCrit.Sts2.Core.Models.Powers.RadiancePower',
  Rage: 'global::MegaCrit.Sts2.Core.Models.Powers.RagePower',
  Rampart: 'global::MegaCrit.Sts2.Core.Models.Powers.RampartPower',
  Ravenous: 'global::MegaCrit.Sts2.Core.Models.Powers.RavenousPower',
  ReaperForm: 'global::MegaCrit.Sts2.Core.Models.Powers.ReaperFormPower',
  Reattach: 'global::MegaCrit.Sts2.Core.Models.Powers.ReattachPower',
  Rebound: 'global::MegaCrit.Sts2.Core.Models.Powers.ReboundPower',
  Reflect: 'global::MegaCrit.Sts2.Core.Models.Powers.ReflectPower',
  Regen: 'global::MegaCrit.Sts2.Core.Models.Powers.RegenPower',
  RetainHand: 'global::MegaCrit.Sts2.Core.Models.Powers.RetainHandPower',
  Ringing: 'global::MegaCrit.Sts2.Core.Models.Powers.RingingPower',
  Ritual: 'global::MegaCrit.Sts2.Core.Models.Powers.RitualPower',
  RollingBoulder: 'global::MegaCrit.Sts2.Core.Models.Powers.RollingBoulderPower',
  Royalties: 'global::MegaCrit.Sts2.Core.Models.Powers.RoyaltiesPower',
  Rupture: 'global::MegaCrit.Sts2.Core.Models.Powers.RupturePower',
  Sandpit: 'global::MegaCrit.Sts2.Core.Models.Powers.SandpitPower',
  SeekingEdge: 'global::MegaCrit.Sts2.Core.Models.Powers.SeekingEdgePower',
  SelfFormingClay: 'global::MegaCrit.Sts2.Core.Models.Powers.SelfFormingClayPower',
  SentryMode: 'global::MegaCrit.Sts2.Core.Models.Powers.SentryModePower',
  SerpentForm: 'global::MegaCrit.Sts2.Core.Models.Powers.SerpentFormPower',
  ShadowStep: 'global::MegaCrit.Sts2.Core.Models.Powers.ShadowStepPower',
  Shadowmeld: 'global::MegaCrit.Sts2.Core.Models.Powers.ShadowmeldPower',
  Shriek: 'global::MegaCrit.Sts2.Core.Models.Powers.ShriekPower',
  Shrink: 'global::MegaCrit.Sts2.Core.Models.Powers.ShrinkPower',
  Shroud: 'global::MegaCrit.Sts2.Core.Models.Powers.ShroudPower',
  SicEm: 'global::MegaCrit.Sts2.Core.Models.Powers.SicEmPower',
  SignalBoost: 'global::MegaCrit.Sts2.Core.Models.Powers.SignalBoostPower',
  Skittish: 'global::MegaCrit.Sts2.Core.Models.Powers.SkittishPower',
  SleightOfFlesh: 'global::MegaCrit.Sts2.Core.Models.Powers.SleightOfFleshPower',
  Slippery: 'global::MegaCrit.Sts2.Core.Models.Powers.SlipperyPower',
  Sloth: 'global::MegaCrit.Sts2.Core.Models.Powers.SlothPower',
  Slow: 'global::MegaCrit.Sts2.Core.Models.Powers.SlowPower',
  Slumber: 'global::MegaCrit.Sts2.Core.Models.Powers.SlumberPower',
  Smoggy: 'global::MegaCrit.Sts2.Core.Models.Powers.SmoggyPower',
  Smokestack: 'global::MegaCrit.Sts2.Core.Models.Powers.SmokestackPower',
  Sneaky: 'global::MegaCrit.Sts2.Core.Models.Powers.SneakyPower',
  Soar: 'global::MegaCrit.Sts2.Core.Models.Powers.SoarPower',
  Soulbound: 'global::MegaCrit.Sts2.Core.Models.Powers.SoulboundPower',
  SpectrumShift: 'global::MegaCrit.Sts2.Core.Models.Powers.SpectrumShiftPower',
  Speedster: 'global::MegaCrit.Sts2.Core.Models.Powers.SpeedsterPower',
  Spinner: 'global::MegaCrit.Sts2.Core.Models.Powers.SpinnerPower',
  SpiritOfAsh: 'global::MegaCrit.Sts2.Core.Models.Powers.SpiritOfAshPower',
  Stampede: 'global::MegaCrit.Sts2.Core.Models.Powers.StampedePower',
  StarNextTurn: 'global::MegaCrit.Sts2.Core.Models.Powers.StarNextTurnPower',
  SteamEruption: 'global::MegaCrit.Sts2.Core.Models.Powers.SteamEruptionPower',
  Stock: 'global::MegaCrit.Sts2.Core.Models.Powers.StockPower',
  Storm: 'global::MegaCrit.Sts2.Core.Models.Powers.StormPower',
  Strangle: 'global::MegaCrit.Sts2.Core.Models.Powers.StranglePower',
  Stratagem: 'global::MegaCrit.Sts2.Core.Models.Powers.StratagemPower',
  Strength: 'global::MegaCrit.Sts2.Core.Models.Powers.StrengthPower',
  Subroutine: 'global::MegaCrit.Sts2.Core.Models.Powers.SubroutinePower',
  Suck: 'global::MegaCrit.Sts2.Core.Models.Powers.SuckPower',
  SummonNextTurn: 'global::MegaCrit.Sts2.Core.Models.Powers.SummonNextTurnPower',
  Surprise: 'global::MegaCrit.Sts2.Core.Models.Powers.SurprisePower',
  Surrounded: 'global::MegaCrit.Sts2.Core.Models.Powers.SurroundedPower',
  Swipe: 'global::MegaCrit.Sts2.Core.Models.Powers.SwipePower',
  SwordSage: 'global::MegaCrit.Sts2.Core.Models.Powers.SwordSagePower',
  TagTeam: 'global::MegaCrit.Sts2.Core.Models.Powers.TagTeamPower',
  Tainted: 'global::MegaCrit.Sts2.Core.Models.Powers.TaintedPower',
  Tangled: 'global::MegaCrit.Sts2.Core.Models.Powers.TangledPower',
  Tank: 'global::MegaCrit.Sts2.Core.Models.Powers.TankPower',
  TemporaryDexterity: 'global::MegaCrit.Sts2.Core.Models.Powers.TemporaryDexterityPower',
  TemporaryFocus: 'global::MegaCrit.Sts2.Core.Models.Powers.TemporaryFocusPower',
  TemporaryStrength: 'global::MegaCrit.Sts2.Core.Models.Powers.TemporaryStrengthPower',
  Tender: 'global::MegaCrit.Sts2.Core.Models.Powers.TenderPower',
  Territorial: 'global::MegaCrit.Sts2.Core.Models.Powers.TerritorialPower',
  TheBomb: 'global::MegaCrit.Sts2.Core.Models.Powers.TheBombPower',
  TheGambit: 'global::MegaCrit.Sts2.Core.Models.Powers.TheGambitPower',
  TheHunt: 'global::MegaCrit.Sts2.Core.Models.Powers.TheHuntPower',
  TheSealedThrone: 'global::MegaCrit.Sts2.Core.Models.Powers.TheSealedThronePower',
  Thievery: 'global::MegaCrit.Sts2.Core.Models.Powers.ThieveryPower',
  Thorns: 'global::MegaCrit.Sts2.Core.Models.Powers.ThornsPower',
  Thunder: 'global::MegaCrit.Sts2.Core.Models.Powers.ThunderPower',
  ToolsOfTheTrade: 'global::MegaCrit.Sts2.Core.Models.Powers.ToolsOfTheTradePower',
  ToricToughness: 'global::MegaCrit.Sts2.Core.Models.Powers.ToricToughnessPower',
  Tracking: 'global::MegaCrit.Sts2.Core.Models.Powers.TrackingPower',
  TrashToTreasure: 'global::MegaCrit.Sts2.Core.Models.Powers.TrashToTreasurePower',
  Tyranny: 'global::MegaCrit.Sts2.Core.Models.Powers.TyrannyPower',
  Underworld: 'global::MegaCrit.Sts2.Core.Models.Powers.UnderworldPower',
  Unmovable: 'global::MegaCrit.Sts2.Core.Models.Powers.UnmovablePower',
  Veilpiercer: 'global::MegaCrit.Sts2.Core.Models.Powers.VeilpiercerPower',
  Vicious: 'global::MegaCrit.Sts2.Core.Models.Powers.ViciousPower',
  Vigor: 'global::MegaCrit.Sts2.Core.Models.Powers.VigorPower',
  VitalSpark: 'global::MegaCrit.Sts2.Core.Models.Powers.VitalSparkPower',
  VoidForm: 'global::MegaCrit.Sts2.Core.Models.Powers.VoidFormPower',
  Vulnerable: 'global::MegaCrit.Sts2.Core.Models.Powers.VulnerablePower',
  WasteAway: 'global::MegaCrit.Sts2.Core.Models.Powers.WasteAwayPower',
  Weak: 'global::MegaCrit.Sts2.Core.Models.Powers.WeakPower',
  WellLaidPlans: 'global::MegaCrit.Sts2.Core.Models.Powers.WellLaidPlansPower',
  WitheringPresence: 'global::MegaCrit.Sts2.Core.Models.Powers.WitheringPresencePower',
  WraithForm: 'global::MegaCrit.Sts2.Core.Models.Powers.WraithFormPower',
};

// [CONFIRMED via reflect-baselib round 9] Three of the 247 classes above —
// TemporaryDexterityPower/TemporaryFocusPower/TemporaryStrengthPower (the
// "N turns only" variants of Dexterity/Focus/Strength) — declare a
// PROTECTED, not public, parameterless constructor:
//   [protected] TemporaryDexterityPower()
//   [protected] TemporaryFocusPower()
//   [protected] TemporaryStrengthPower()
// `ForgeActions.ApplyStatus<T>()`'s `where T : PowerModel, new()`
// constraint needs a PUBLIC one — selecting any of these 3 for ApplyStatus
// would be a hard CS0122 ("inaccessible due to its protection level") the
// moment it compiled. `ForgeActions.RemoveStatus<T>()` has no `new()`
// constraint (it never constructs a T, just looks one up), so removing
// these 3 would actually be safe — excluded from BUILTIN_STATUSES
// (shared by both the apply and remove pickers) anyway, for a simpler,
// consistent picker rather than an apply/remove asymmetry over 3 out of
// 247 statuses. Kept in BUILTIN_POWER_CLASS_MAP above (the class-name
// reference) since the real classes do exist — just not safely
// constructible this specific way. No evidence of an alternate
// construction path (a public factory method, etc.) has turned up in any
// reflect-baselib round so far.
const PROTECTED_CTOR_BUILTIN_POWERS = new Set(['TemporaryDexterity', 'TemporaryFocus', 'TemporaryStrength']);

// Action types with no grounding for a Creature target at all — these act
// on the PLAYER's own hand/deck/discard/energy/gold, not on any creature,
// so "target: AllEnemies" (etc.) on one of these is nonsensical no matter
// how the target expression resolves (there's no "exhaust a card from an
// enemy" concept in STS2 — enemies don't have hands). This is exactly the
// existing bucket `actionToCSharp`'s switch already groups together under
// "[UNVERIFIED] — player/run-level actions with no grounding at all", so
// this list mirrors that switch rather than inventing a new rule. Caught
// by a real stress test: a "New Broken Card" had `ExhaustCard` targeting
// `AllEnemies` — this compiled with no error before this fix, since
// nothing validated action.target against action.type at all.
// "EndTurn" (Tyler, 2026-08-25: "one that ends the players turn") joined
// this list this round — ending YOUR OWN turn has no creature-target
// concept either, same bucket as the rest.
// [Round 159] "GainEnergy" -> "ModifyEnergy" — Tyler asked whether a
// negative "Gain Energy" amount reduces energy; direct sts2.dll IL
// confirmed it doesn't (PlayerCmd.GainEnergy no-ops on amount <= 0), so
// he asked for a real Modify Energy action instead — see that case's own
// comment for the full reasoning. Migrated by frontend/index.html's
// migrateLegacyStatusActions (old GainEnergy actions become ModifyEnergy
// unchanged otherwise); "GainEnergy" itself is retired from ACTION_TYPES.
const PLAYER_ONLY_ACTIONS = [
  'DrawCard', 'ModifyEnergy', 'ModifyGold', 'DiscardCard', 'ExhaustCard',
  'CreateCard', 'ShuffleCardIntoDraw', 'EndTurn', 'ModifyOrbSlots', 'ReturnToHand',
  // [Round 193] "ModifyCost" -- acts on "this card" (the card the effect
  // block belongs to), same "no real Creature-target concept" reasoning
  // as ReturnToHand/ShuffleCardIntoDraw right above -- see that case's own
  // comment in actionToCSharp for the full evidence trail.
  'ModifyCost',
  // [Round 197] Tyler: "we also need to add effects to remove or afflict
  // cards" -- CardCmd.Afflict<T>/CardCmd.Enchant<T>/CardCmd.ClearAffliction/
  // CardCmd.ClearEnchantment are all real (see actionToCSharp's own cases)
  // but every one of them acts on a specific CardModel, not a Creature --
  // same "no real Creature-target concept" bucket as ModifyCost right
  // above, resolved via resolveActedCardExpr(ctx) instead of a target
  // picker.
  'AfflictCard', 'RemoveAffliction', 'EnchantCard', 'RemoveEnchantment',
  // [Round 199] "ClearAfflictionFromPile" -- BUG FIX: this was missed when
  // the action was first added, leaving it validated against the default
  // Creature-target list (SingleEnemy/AllEnemies/Self/RandomEnemy) even
  // though actionToCSharp's own case never reads action.target at all --
  // it loops PileTypeExtensions.GetPile(pile, owner).Cards instead, a
  // whole PILE, not a single Creature or CardModel. Same bucket as
  // AfflictCard/RemoveAffliction/EnchantCard/RemoveEnchantment right
  // above for that same underlying reason.
  'ClearAfflictionFromPile',
  // [2026-09-23] Tyler pointed at a relic from a different, unrelated
  // STS2 character-creator tool ("Test Relic") doing two things Forge
  // couldn't yet: swapping the Draw/Discard piles, and transforming deck
  // cards into a different card. Both act on a whole pile, same
  // "no real Creature-target concept" bucket as ClearAfflictionFromPile
  // right above -- see actionToCSharp's own cases for the full evidence.
  'SwapDrawDiscard', 'TransformDeckCards',
];
// "GainOrbSlots" (round 59) — [VERIFIED via decompiling TheBurdenedNewCharacter.
// dll v3's "Orbit" card, PLUS a direct sts2.dll read confirming the exact
// signature] MegaCrit.Sts2.Core.Commands.OrbCmd.AddSlots(Player, int) is a
// real, public, static method — Orbit's own gainOrbSlots effect calls it
// directly with its own Owner. No creature-target concept (it's a
// player-level resource, same bucket as GainEnergy/ModifyGold), so it
// joins PLAYER_ONLY_ACTIONS. Real on every trigger via resolvePlayerExpr(ctx)
// — see its own actionToCSharp case.
// [Round 160] "GainOrbSlots" -> "ModifyOrbSlots" — Tyler asked for a
// remove-slots counterpart ("can we also do a modify orb slots? for adding
// and removing"). A direct sts2.dll read of OrbCmd (alongside AddSlots)
// turned up a real, public, static sibling: `OrbCmd.RemoveSlots(Player
// player, int amount)` — [VERIFIED]. Unlike GainEnergy/LoseEnergy, neither
// AddSlots nor RemoveSlots self-guards against a wrong-sign `amount` (both
// just clamp against the player's current OrbQueue capacity, no <= 0
// early-return) — but per Tyler's explicit pick of the mode-dropdown
// pattern (this same round, applied to ModifyEnergy too — see that case's
// own comment), ModifyOrbSlots reads an author-facing `mode` (Add/Remove)
// with `amount` always a positive magnitude, same shape as ModifyHp/
// ModifyGold, rather than a runtime sign check. See ModifyOrbSlots' own
// actionToCSharp case for the full call-shape reasoning (RemoveSlots
// returns `void`, not `Task` — no `await`, unlike every other real call in
// this list).

// A SEPARATE, smaller list from PLAYER_ONLY_ACTIONS above — Tyler: "Gain
// block should only ever be for yourself... We can remove the target
// dropdown box." Kept apart from PLAYER_ONLY_ACTIONS deliberately: that
// list is about actions with NO real Creature-target grounding at all
// (hand/pile/energy/gold — there's no "exhaust a card from an enemy"
// concept). GainBlock is different — it's a real, [VERIFIED]
// Creature-targeted call (ForgeActions.GainBlock(Creature,int)) that
// simply now only ever gets called with the player's own creature by
// design, not because there's nothing to target. Both lists collapse to
// the same "Self" restriction in validTargetsForAction below, but keeping
// them separate preserves the accurate "why" for anyone reading either
// one later.
const SELF_ONLY_ACTIONS = ['GainBlock'];

// [UNVERIFIED — list itself, not just the CreateCard action] Tyler: "Create
// card in hand and draw pile should be 'Create Card'... this should pull a
// dropdown menu containing all of the user's created token cards, as well
// as the vanilla status cards if possible." "The user's created token
// cards" is a real, live thing (any card in THIS package with type:Status +
// rarity:Token — see the "Token cards" status.md round) looked up directly
// from `pkg.cards`, no guessing needed. "The vanilla status cards" is
// different: these are STS1/STS2's OWN built-in Status/Curse cards that
// ship with the base game, existing entirely OUTSIDE any Forge package, so
// there's nothing in `pkg.cards` to look them up from. No reflect-baselib
// round has gone looking for their real BaseLib class names (unlike
// BUILTIN_POWER_CLASS_MAP's 247 statuses, which round 8 did confirm one by
// one) — this list is a best-effort guess at which real STS1 status/curse
// names plausibly carried over to STS2, assembled from general franchise
// familiarity, NOT a reflect-baselib dump. Used only to populate a
// dropdown and to embed a plain string in a `ForgeActions.Todo(...)` stub
// (see `actionToCSharp`'s "CreateCard" case) — CreateCard has no real
// codegen behind it yet either way, so a wrong/incomplete name here changes
// stub text, not behavior. Tighten (or replace with a real confirmed list)
// once a reflect-baselib round specifically targets STS2's built-in
// Status/Curse card classes.
const VANILLA_TOKEN_CARDS = [
  'Wound', 'Dazed', 'Slimed', 'Burn', 'Void', 'Regret', 'Shame', 'Doubt',
  'Decay', 'Clumsy', 'Parasite',
];

// Real, confirmed class names for 10 of VANILLA_TOKEN_CARDS' 11 entries —
// found round 24 (2026-08-30) via a direct sts2.dll TypeDef sweep (not a
// guess like the list above): every one of these compiles down to
// `MegaCrit.Sts2.Core.Models.Cards.<Name>`, an exact 1:1 match with the
// franchise-familiarity guess VANILLA_TOKEN_CARDS already made. "Parasite"
// is deliberately excluded — no MegaCrit.Sts2.Core.Models.Cards.Parasite
// (or similar) class exists; the only real TypeDef with "Parasite" in the
// name is a Monster (PhrogParasite), not a card — actionToCSharp's
// "CreateCard" case falls back to an honest stub for that one specific
// entry rather than guessing a class name with zero evidence behind it.
const VANILLA_TOKEN_CARD_CLASS_MAP = {
  Wound: 'MegaCrit.Sts2.Core.Models.Cards.Wound',
  Dazed: 'MegaCrit.Sts2.Core.Models.Cards.Dazed',
  Slimed: 'MegaCrit.Sts2.Core.Models.Cards.Slimed',
  Burn: 'MegaCrit.Sts2.Core.Models.Cards.Burn',
  Void: 'MegaCrit.Sts2.Core.Models.Cards.Void',
  Regret: 'MegaCrit.Sts2.Core.Models.Cards.Regret',
  Shame: 'MegaCrit.Sts2.Core.Models.Cards.Shame',
  Doubt: 'MegaCrit.Sts2.Core.Models.Cards.Doubt',
  Decay: 'MegaCrit.Sts2.Core.Models.Cards.Decay',
  Clumsy: 'MegaCrit.Sts2.Core.Models.Cards.Clumsy',
};

// [Round 213] Real MegaCrit.Sts2.Core.Models.CardPools.* subclasses of the
// real, abstract CardPoolModel -- confirmed via a direct TypeDef listing of
// the real, installed sts2.dll's own CardPools namespace this round. Closes
// #13 expandCardRewardPools. Reached at runtime via the same generic
// ModelDb.CardPool<T>() factory pattern ModelDb.Card<T>()/RelicPool<T>()
// already use elsewhere in this file (confirmed real, same shape, via
// direct ecma_dump_ext.py read of MegaCrit.Sts2.Core.Models.ModelDb this
// round: `public static !!0 CardPool()`). Four real subclasses found but
// deliberately EXCLUDED from this map as not sensible reward-pool-expansion
// targets: EventCardPool/QuestCardPool (narrative/event-choice pools, not
// combat card rewards), DeprecatedCardPool (its own real name says not to
// use it), MockCardPool (internal test fixture, same reasoning
// TestCharCardPool-style scratch classes are never exposed to authors).
const CARD_POOL_CLASS_MAP = {
  Colorless: 'MegaCrit.Sts2.Core.Models.CardPools.ColorlessCardPool',
  Curse: 'MegaCrit.Sts2.Core.Models.CardPools.CurseCardPool',
  Status: 'MegaCrit.Sts2.Core.Models.CardPools.StatusCardPool',
  Token: 'MegaCrit.Sts2.Core.Models.CardPools.TokenCardPool',
  Ironclad: 'MegaCrit.Sts2.Core.Models.CardPools.IroncladCardPool',
  Silent: 'MegaCrit.Sts2.Core.Models.CardPools.SilentCardPool',
  Defect: 'MegaCrit.Sts2.Core.Models.CardPools.DefectCardPool',
  Necrobinder: 'MegaCrit.Sts2.Core.Models.CardPools.NecrobinderCardPool',
  Regent: 'MegaCrit.Sts2.Core.Models.CardPools.RegentCardPool',
  Deprived: 'MegaCrit.Sts2.Core.Models.CardPools.DeprivedCardPool',
};

// Some real STS2 cards upgrade more than once (Card+, Card++, ...) — Tyler:
// "This should allow for up to 4 upgrades unless we later find out that the
// limit is different." 4 is STILL a guess after reflect-baselib round 13:
// round 13d swept every static field/property anywhere for a name like
// MaxUpgrades/MAX_UPGRADE_TIER and found NONE — STS2 doesn't expose a
// single shared cap as a named constant reflection can see. What round 13
// DID confirm is that the real cap is per-card, not global: CardModel has a
// real `public virtual int MaxUpgradeLevel { get; }` (default presumably 1
// — round 13c's IL sample of 25 real base-game cards' OnUpgrade() bodies
// never once read CurrentUpgradeLevel/MaxUpgradeLevel back out, i.e. none
// of them special-case a level, consistent with most cards only ever
// having a single upgrade). So `4` stays as Forge's own authoring ceiling
// (a single constant here + validate.js), independent of whatever any one
// real card's MaxUpgradeLevel override actually returns — see
// generateCardSource's upgradeMethod for the confirmed override this now
// emits per-card.
const MAX_UPGRADE_TIERS = 4;

function validTargetsForAction(actionType) {
  return (PLAYER_ONLY_ACTIONS.includes(actionType) || SELF_ONLY_ACTIONS.includes(actionType))
    ? ['Self']
    : ['SingleEnemy', 'AllEnemies', 'Self', 'RandomEnemy'];
}

// --- condition SUBJECT (who a per-creature condition like HasStatusStacks
// checks) — Tyler's request: "If <target> has <condition>", where <target>
// is changeable between the card's target, the player themself, or the
// player's pet. A SEPARATE vocabulary from action.target (SingleEnemy/
// AllEnemies/Self/RandomEnemy, resolveTargetExpr above) — subject is about
// which ONE creature to inspect for a condition check, not which creature
// (or creatures) an action affects, so deliberately not reusing the same
// enum/values.
//
// UPDATED per Tyler's follow-up ("the hp below % condition should allow
// either yourself or pet or enemy to be the target of the check"):
// HpBelowPercent now ALSO stores/reads a subject, same enum, same
// resolveConditionSubjectExpr below — even though HP% itself has no
// confirmed BaseLib accessor yet (still [UNVERIFIED]/TodoCondition, see
// conditionToCSharp's HpBelowPercent case) the subject choice is captured
// now so nothing about the UI/schema needs to change again once a real
// accessor is found in a future reflect-baselib round; it's just inert
// until then, same as the rest of that condition.
const CONDITION_SUBJECTS = ['Self', 'CardTarget', 'Pet'];

// Condition kinds that take a `subject` field at all — used by the
// frontend (which kinds show the subject dropdown) and kept here, next to
// CONDITION_SUBJECTS, so the two lists can't drift apart.
const SUBJECT_CAPABLE_CONDITION_KINDS = ['HasStatusStacks', 'HpBelowPercent', 'HasBlock', 'DebuffStacksTotal', 'PetIsOut'];

// [VERIFIED via reflect-baselib round 5] `Player.Osty` — the "pet"
// creature some STS2 characters have — is a real, public, concrete
// `Creature`-typed property, found in the SAME round that confirmed
// `Player.Creature` (see TOOLCHAIN_FINDINGS.md "reflect-baselib round 5").
// `cardPlay.Player.Osty` is therefore a real, grounded expression, real in
// the two trigger contexts that bind directly off a CardPlay: a card's own
// OnPlay, and OnAnyCardPlayed (real for both cards AND relics/mechanics —
// see TRIGGER_HOOKS/CARD_TRIGGER_HOOKS below).
//
// [Round 57, 2026-09-08 — Tyler uploaded a new build with a custom
// DiscardStatusPower reacting to AfterCardDiscarded/AfterSideTurnEnd,
// asking "does this help?"] Decompiling it found its real AfterCardDiscarded
// override reads `card.Owner` (a CardModel, since `card` is the discarded
// card) to compare against `this.Owner` (the power's own owner) — direct
// proof `CardModel.Owner` (returns `Player`) is a real member reachable
// from OUTSIDE the card's own class. Cross-checked directly against the
// base game's own sts2.dll (not just Tyler's mod): `CardModel.get_Owner`
// is real, `public`, non-virtual, RVA present, returns
// `MegaCrit.Sts2.Core.Entities.Players.Player`. Since a card's own
// OnDiscard/OnTurnEndInHand hook runs on `this` (the actual CardModel
// instance — OnDiscard already `ReferenceEquals(card, this)`-filters to
// only its own event; OnTurnEndInHand has no `card` param at all because
// it's already per-instance), `this.Owner.Creature`/`this.Owner.Osty` give
// those two triggers the exact same real fgPlayer/fgPet binding OnPlay/
// OnAnyCardPlayed get from `cardPlay.Player.Creature`/`cardPlay.Player.
// Osty` — see CARD_TRIGGER_HOOKS' OnDiscard/OnTurnEndInHand entries below.
// This closes the Round-9 "Todo() fallback" gap for both triggers' Self/
// AllEnemies-targeted actions (no real "target" Creature exists for
// either — nothing is being targeted when a card is discarded or stays in
// hand at turn end — so SingleEnemy actions and the CardTarget subject
// stay rejected exactly like every other player-only-bound hook; see
// backend/validate.js's TARGETLESS_BOUND_HOOK_TRIGGERS).
//
// Every OTHER trigger still has no player/target Creature binding at all
// (falls to ForgeActions.Todo(...), so a Pet subject never actually
// reaches generated code) or binds off some OTHER real parameter that
// isn't a Player (e.g. OnTakeDamage's `target`/`dealer` — plain Creature
// params, no back-reference to a Player to find `.Osty` on) — Pet subject
// is rejected by backend/validate.js on every trigger outside this list,
// rather than ever risk emitting a reference to an unbound `fgPet`.
const PET_SUPPORTED_TRIGGERS = ['OnPlay', 'OnAnyCardPlayed', 'OnDiscard', 'OnTurnEndInHand', 'OnRetained']; // [Round 95] OnRetained added — same real this.Owner.Osty petExpr as OnDiscard/OnTurnEndInHand, see CARD_TRIGGER_HOOKS.OnRetained

// Resolves a condition's `subject` field (see CONDITION_SUBJECTS above) to
// the local variable a per-creature condition (HasStatusStacks) should
// read. Mirrors resolveTargetExpr's `fgTarget!` null-forgiving pattern —
// `fgTarget`/`fgPet` are both ultimately sourced from a nullable BaseLib
// property (`CardPlay.Target`, `Player.Osty`) even though neither has been
// confirmed non-nullable by reflection (reflection exposes member
// signatures, not C# 8+ nullable-reference annotations) — the `!` is a
// harmless no-op if the real type turns out non-nullable, and required if
// it's actually `Creature?`, so it's applied defensively either way, same
// as the existing SingleEnemy case below. `undefined` (a condition saved
// before this field existed) defaults to 'Self' — the ONLY subject
// HasStatusStacks ever checked before this round, so old saved packages
// keep compiling to the exact same behavior they always had.
function resolveConditionSubjectExpr(subject) {
  if (subject === 'CardTarget') return 'fgTarget!';
  if (subject === 'Pet') return 'fgPet!';
  return 'fgPlayer'; // 'Self', or undefined (pre-existing packages)
}

// Glow-context counterpart to resolveConditionSubjectExpr above — used ONLY
// when a condition is being compiled for card.advancedOptions.glow (see
// conditionToCSharp's `ctx.glowContext` branch below), never for a normal
// effect block's "If". Glow's real backing method, `ShouldGlowGoldInternal`,
// is a bare property getter with no cardPlay/fgPlayer/fgTarget/fgPet locals
// anywhere in scope — [VERIFIED via decompiling TheBurdenedNewCharacter.dll]
// both EnergeticAttack's and Eternal's own overrides reach the player
// through `CardModel.Owner` directly instead (a real, always-accessible
// instance property — `call CardModel::get_Owner` is the very first
// instruction of EnergeticAttack's `get_ShouldGlowGoldInternal`), then
// `.Creature`/`.Osty` off of that ([VERIFIED via reflect-baselib round 5]
// same properties fgPlayer/fgPet already use elsewhere). `Owner` and
// `.Creature`/`.Osty` are walked with `?.` (matching the exact real
// null-conditional chain both decompiled getters use — `Owner?.Creature?.…`
// — rather than this codebase's usual `!` null-forgiving convention) since
// this is a genuinely different, weaker-guaranteed context (a card sitting
// in hand/deck, possibly outside any live combat) than an OnPlay body,
// where a `cardPlay` having been constructed at all already implies a real
// player/target exist. There is no glow-context equivalent for
// 'CardTarget' — a card that hasn't been played yet has no target — so
// backend/validate.js rejects that combination before this is ever called.
function resolveGlowSubjectExpr(subject) {
  if (subject === 'Pet') return 'Owner?.Osty';
  return 'Owner?.Creature'; // 'Self', or undefined
}

function resolveTargetExpr(target) {
  // AllEnemies / RandomEnemy still resolve to null HERE — this function only
  // ever resolves a SINGLE fixed Creature expression from the action's own
  // static target field. That used to mean "no way to enumerate/pick
  // enemies" and fall straight to an UNVERIFIED stub, but it no longer does:
  // CombatState.HittableEnemies is a real, proven-real enumerable (same bare
  // instance member DealDamage's/ModifyStatus-Add's own dedicated AllEnemies
  // codegen already uses) — see actionToCSharp's generic RandomEnemy/
  // AllEnemies wrapper (added round 24, 2026-08-30), which calls THIS
  // function again with a forced target expression (`fgRandomTarget`/
  // `fgAllEnemiesTarget`) once it's already picked/looped a real Creature,
  // rather than teaching this function itself about enumeration.
  //
  // Local variable names are `fgPlayer`/`fgTarget` (Forge-prefixed), NOT
  // the more obvious `player`/`target` — a real bug caught during review:
  // some real relic hook parameters ARE literally named `target`
  // (`AfterDamageReceived(..., Creature target, ..., Creature dealer, ...)`,
  // confirmed via reflect-baselib round 2), so declaring a local also named
  // `target` inside that method is CS0136 ("cannot be declared in this
  // scope"). The fg-prefix sidesteps that collision everywhere, including
  // in hooks not yet seen.
  if (target === 'Self') return 'fgPlayer';
  if (target === 'SingleEnemy') return 'fgTarget!';
  return null;
}

// Resolves a real `Player` expression for the player/run-level action types
// (EndTurn, GainEnergy, ModifyGold, CreateCard) that need one but aren't
// necessarily authored somewhere with a real `cardPlay` in scope — added
// round 24 (2026-08-30), fixed round 25 (2026-09-01). `cardPlay.Player`
// stays the [VERIFIED] choice wherever it's actually in scope (unchanged).
//
// The non-cardPlayBound fallback was `CombatState.Players.FirstOrDefault()!`
// in round 24 — WRONG, and caught by Tyler's own first real `dotnet build`
// of this round's output (see claude/round25-real-build-findings.md): bare
// `CombatState` only resolves to a real instance property on CardModel/
// PowerModel (both have `public ICombatState CombatState { get; }`,
// confirmed via direct sts2.dll read) — RelicModel does NOT declare or
// inherit any such member. Every non-cardPlayBound call site this fallback
// serves is a relic/mechanic hook body (generateHookEffects), where `this`
// can be a CustomRelicModel — so the bare form is a real CS0120 there
// ("An object reference is required for the non-static field, method, or
// property 'CombatState.Players'"), exactly what Tyler's build log showed
// 10 times across 3 relics. `CombatState` bare gets parsed as the TYPE
// `MegaCrit.Sts2.Core.Combat.CombatState` (imported via using) once no
// instance member of that name is in scope, then `.Players`/
// `.HittableEnemies` fail as non-static members accessed off a type.
//
// Fix: go through `fgPlayer.CombatState` instead of bare `CombatState`.
// `Creature.CombatState` (get **and** set) is a real, confirmed-via-direct-
// sts2.dll-read instance property returning the same `ICombatState`
// CardModel/PowerModel expose — and `fgPlayer` is unconditionally bound as
// a real `Creature` immediately before ANY action codegen in every context
// this file has (Card.cs.template's OnPlay: `cardPlay.Player.Creature`;
// generateHookEffects: `hook.playerExpr`, always Creature-typed per every
// TRIGGER_HOOKS entry; CARD_TRIGGER_HOOKS: `cardPlay.Player.Creature`) —
// whenever hook.playerExpr is null instead, the whole effect body becomes a
// Todo() fallback and this function is never reached. So `fgPlayer.
// CombatState` is safe everywhere resolveStatusStacksExpr/actionToCSharp's
// AllEnemies-RandomEnemy wrapper actually run, regardless of whether `this`
// is a CardModel, RelicModel, or PowerModel — no entityKind branching
// needed.
//
// Round 26 (2026-09-01) — Tyler uploaded an updated build of
// TheBurdenedNewCharacter.dll; re-decompiling it to check whether anything
// changed turned up a strictly better fallback for THIS function
// specifically (full trail in claude/round26-updated-mod-findings.md).
// Direct sts2.dll read confirms `Creature` has a real, public, get-only
// `Player Player { get; }` property (`get_Player()`, sitting right next to
// the already-confirmed `CombatState` property on the same type) — and the
// exact real, compiled call this function's own [VERIFIED] EndTurn tier is
// built on (`FatiguePower`'s `AfterPowerAmountChanged` hook, still present
// in the new build with byte-identical logic) resolves its player via
// `base.Owner.Player` — i.e. `Owner` (Creature-typed on PowerModel, per
// this file's own earlier finding) `.Player`, ONE hop, not
// `CombatState.Players.FirstOrDefault()`. `fgPlayer` is that same
// `Creature`-typed local, always in scope wherever this function runs, so
// `fgPlayer.Player` is both a direct real-usage match AND strictly more
// correct than the old `.FirstOrDefault()` guess: `CombatState.Players`
// enumerates EVERY player in combat, and picking the first one is only
// ever right by accident outside single-player, whereas `fgPlayer.Player`
// names the actual right player unconditionally. `!` null-forgiving
// suffix dropped — `Player` isn't documented nullable and no real call
// site null-checks it before using it this way.
function resolvePlayerExpr(ctx) {
  // [Fix, round 31 — real crash: godot.log showed a real
  // System.NullReferenceException inside the base game's own
  // CardPileCmd.DrawInternal, reached via TestChar.Relics.Group1Relic.
  // AfterBlockBroken — see TOOLCHAIN_FINDINGS.md "strike is broken...
  // DrawInternal"] TRIGGER_HOOKS.AfterBlockBroken (and several other real
  // hooks — OnTakeDamage, AfterBlockGained, etc.) bind `fgPlayer` to
  // "whoever this specific firing's own hook params call the first
  // Creature," which is NOT always the real player — it was the ENEMY
  // here (Strike broke the enemy's own block). `fgPlayer.Player` on a
  // monster-side Creature is a real property access that evaluates to
  // null (monsters have no owning Player at all), and that null flowed
  // straight into CardPileCmd.Draw. `ctx.entityKind === 'relic'` uses
  // `this.Owner` instead — a direct sts2.dll read confirms RelicModel.Owner
  // is a real, public, get/set property typed `Player` DIRECTLY (distinct
  // from PowerModel.Owner, which is Creature-typed, since a mechanic CAN
  // be applied to an enemy) — a relic's Owner is unambiguously the real
  // player who has it equipped, regardless of which creature triggered
  // this particular firing. Mechanics (ctx.entityKind === 'mechanic')
  // keep the old fgPlayer.Player fallback for now — PowerModel.Owner being
  // Creature-typed means the SAME ambiguity could still exist there (a
  // mechanic applied to an enemy has no real owning player either), but
  // that combination hasn't actually been hit by any real build yet, so
  // it's left as a flagged, not-yet-evidenced gap rather than guessed at
  // — same "fix once it's actually reached" discipline as ExhaustCard/
  // DiscardCard's own still-open gap noted in the round 30 write-up.
  if (ctx.cardPlayBound) return 'cardPlay.Player';
  if (ctx.entityKind === 'relic') return 'this.Owner';
  // [Round 199, extended round 200] Neither AfflictionModel nor
  // EnchantmentModel has an Owner property of its own (only get_Card()) --
  // CardModel.Owner IS the real, confirmed Player-typed property (see
  // Affliction.cs.template's own OnPlay comment/generateAfflictionSource),
  // so `this.Card.Owner` is the real analog to RelicModel.Owner above,
  // same as Reckless.cs's own real `_affOwner = base.Card.Owner`. Round
  // 200 extends this to `entityKind === 'enchantment'` too -- its own new
  // "Additional Triggers"/whilePile hooks (generateHookEffects) bind
  // fgPlayer off each hook's own playerExpr (e.g. a raw `target`/`dealer`
  // Creature, not necessarily the owning player), the exact same
  // fgPlayer.Player-can-be-null risk round 31's real DrawInternal crash
  // exposed -- this.Card.Owner sidesteps it identically for Enchantments.
  if (ctx.entityKind === 'affliction' || ctx.entityKind === 'enchantment') return 'this.Card.Owner';
  return 'fgPlayer.Player';
}

// [Fix, round 30 — real crash: godot.log showed a real
// `System.InvalidOperationException: No attacker set.` thrown from
// AttackCommand.Execute() when TestChar.Cards.StrikeCard.OnPlay called
// ForgeActions.DealDamage to play an ordinary Strike card — see
// TOOLCHAIN_FINDINGS.md "card is still stuck ... No attacker set."]
// Resolves the extra source-attribution arguments ForgeActions.DealDamage/
// DealDamageAllEnemies now need (added this round) to actually set a real
// Attacker on the base game's AttackCommand builder — direct sts2.dll read
// confirms AttackCommand exposes exactly THREE real ways to do that
// (FromCard/FromOsty/FromMonster; set_Attacker itself is PRIVATE, so
// nothing else can set it). A card's own generated body (ctx.thisIsCard —
// cascadingTriggerBody's own guarantee: always true together with a real
// `cardPlay` local in scope) has a real CardModel `this` and `cardPlay` to
// hand to `FromCard(this, cardPlay)`, matching FromCard's own real IL
// (Attacker = card.Owner.Creature). A relic/mechanic hook body has neither
// — AttackCommand has no generic "FromCreature" attacker path at all — so
// ForgeActions.DealDamage/DealDamageAllEnemies fall back to a different,
// real, lower-level API there instead (see their own comments in
// ForgeActions.cs.template): `fgPlayer` (always bound — see this
// function's own comment above for the "always bound" argument) is passed
// as `dealer`, with `sourceCard`/`cardPlay` both `null` to select that
// fallback path.
//
// [Fix, round 57] Gated on `ctx.cardPlayBound`, NOT `ctx.thisIsCard` — the
// two used to always agree (cascadingTriggerBody's only two callers before
// round 57, OnPlay and OnAnyCardPlayed's fullCardPlayBinding branch, both
// have a real `cardPlay` local AND a real CardModel `this`), so either
// flag happened to give the same answer here. Round 57 added a THIRD
// caller (OnDiscard/OnTurnEndInHand, real via CardModel.Owner — see
// PET_SUPPORTED_TRIGGERS' own comment) where `this` genuinely IS the
// CardModel (thisIsCard: true, correctly keeping CardPositionInHand's/
// ShuffleCardIntoDraw's own `this`-based codegen real) but there is NO
// `cardPlay` local at all — `FromCard(this, cardPlay)` there would
// reference an undeclared `cardPlay` (CS0103). `cardPlayBound` is the
// actual "is a real `cardPlay` local in scope" signal (see effectBlockToCSharp/
// GainBlock's own identical gate), so checking it here instead correctly
// falls OnDiscard/OnTurnEndInHand through to the same `fgPlayer, null,
// null` lower-level path a relic/mechanic hook already uses — unchanged
// behavior for OnPlay/OnAnyCardPlayed, where cardPlayBound is still true.
function resolveDamageSourceArgs(ctx) {
  // [Round 191 fix] `sourceCard` is CardModel? (nullable) — ForgeActions.
  // DealDamage/DealDamageAllEnemies' real confirmed signature (see
  // ForgeActions.cs.template). Previously always emitted bare `this`
  // whenever cardPlayBound was true, which is only actually a CardModel
  // when ctx.thisIsCard is ALSO true (a card's own generated class, where
  // `this` IS the CardModel). Discovered via generateEnchantmentSource
  // (round 191): an EnchantmentModel's OnPlay is cardPlayBound but
  // thisIsCard:false, so the old code would have emitted `this` (an
  // EnchantmentModel) into a `CardModel?` parameter — a real CS1503 that
  // would have failed to compile. `cardPlay.Card` is the correct, real,
  // ALWAYS-available CardModel in any cardPlayBound context regardless of
  // what `this` is, so it's used whenever thisIsCard is false, rather
  // than falling back to null (strictly more informative than losing the
  // source-card attribution entirely) — same fix benefits any future
  // non-card cardPlayBound context (relics/mechanics currently never hit
  // this path since 'OnPlay' is rejected for them, but OnAnyCardPlayed
  // could).
  if (!ctx.cardPlayBound) return 'fgPlayer, null, null';
  return ctx.thisIsCard ? 'fgPlayer, this, cardPlay' : 'fgPlayer, cardPlay.Card, cardPlay';
}

// NOTE: the old perEntryAmount(action, amountsMap, key) helper that used
// to live here was retired along with ApplyStatus/ApplyCustomStatus (see
// resolveStatusEntryAmountExpr below, defined after resolveAmountExpr so
// it can reuse resolveAmountScaleSubjectExpr) — "ModifyStatus" reads each
// entry's own `amount` property directly off statusEntries[] instead of a
// separate amountsMap keyed by id.

// Resolves an action's `amount` — either the flat literal, or, if
// `amountScalesWithStatus`/`amountScalesWithBuiltinStatus` is set, an
// expression that multiplies it by the ACTING PLAYER's own current stack
// count of that status. Tyler's request: "status needs a 'do this thing
// equal to the number of stacks of the status I have' like poison." The
// underlying field (`amountScalesWithStatus`, custom-only) existed in the
// schema from an earlier round but was never actually wired into codegen
// — this closes that gap and, per the same "vanilla too, not just custom"
// pattern HasStatusStacks just got, adds `amountScalesWithBuiltinStatus`
// for real statuses like Poison. `action.amount` acts as a per-stack
// multiplier (amount=1 -> exactly your stacks; amount=2 -> double your
// stacks), matching the schema's original "amount becomes 'X per stack'"
// description. Always reads `fgPlayer` (Self) — "the status I HAVE",
// Tyler's own wording — not the action's own target, so this is safe to
// call even for enemy-targeted actions (e.g. "deal damage to the enemy
// equal to YOUR OWN Strength" is a real, common STS pattern). No subject
// picker (unlike HasStatusStacks/HpBelowPercent) since only Self was
// asked for.
// [VERIFIED via decompiling Tyler's own TheBurdenedNewCharacter.dll — a
// real, compiled, tested mod] `CardModel.ResolveEnergyXValue()` is a
// real, concrete, zero-argument instance method -> int. Hand-decoded IL
// of Retaliation (a real, working X-cost card in that mod) shows it
// called on `this` (the card instance being played) to resolve "X" for
// the current play, then fed straight into a real AttackCommand call
// (`.WithHitCount(x)`). Generated action code always lives inside the
// card's own CustomCardModel subclass (see Card.cs.template's OnPlay),
// so `this` here is always that same card — no cardPlay/context needed,
// unlike EnergyRemaining/StarsRemaining. backend/validate.js is what
// actually restricts amountIsX/hitCountIsX to cards with costsX=true on
// their own OnPlay trigger (the only usage the real example confirms) —
// this string is only ever reached once that's already guaranteed.
const RESOLVE_X_EXPR = 'this.ResolveEnergyXValue() /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll] */';

// [Round 74] Star counterpart of RESOLVE_X_EXPR above. [VERIFIED via
// decompiling Tyler's own updated TheBurdenedNewCharacter.dll, round
// 73/74] "X Star" (TheBurdenedNewCharacter.Cards.XStar)'s real,
// decompiled OnPlay: `_xStars = this.ResolveStarXValue()` (loc.2), fed
// straight into `DamageCmd.Attack(Damage.BaseValue + xStars)` — the
// SAME "resolve X, use it as a real amount" shape RESOLVE_X_EXPR already
// documents for ResolveEnergyXValue(), just a different real zero-arg
// instance method on CardModel. Only wired to actionsArray's amountIsStarX
// (see resolveAmountExpr/resolveStatusEntryAmountExpr below) — no
// hit-count counterpart: that same real card scales hit count with
// ENERGY-X on a separate attack, not star-X, so hitCountIsX stays
// energy-only (RESOLVE_X_EXPR).
const RESOLVE_STAR_X_EXPR = 'this.ResolveStarXValue() /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3\'s "X Star" card] */';

// Resolves WHOSE stacks per-stack scaling counts (action.amountScalesWithSubject
// — see schema's own description for the full reasoning) — added when the
// DealDamage row gained its sentence layout (Tyler: "we need to add a new
// box for per stack that checks whose stacks to reference"). Returns a real
// C# expression for 'Target'/'Self'/undefined, or `null` for 'AllEnemies' to
// signal the caller there's no real expression to emit yet.
//
// 'Target' reuses resolveTargetExpr(action.target) — the SAME resolution
// this action's own target already went through. Always safe to call here:
// actionToCSharp already Todo-stubs the WHOLE action (before ever reaching
// resolveAmountExpr) if action.target itself doesn't resolve to a real
// expression, so by the time this runs action.target is guaranteed to be
// 'Self' or 'SingleEnemy' — never the AllEnemies/RandomEnemy/None cases
// resolveTargetExpr returns null for.
//
// 'AllEnemies' returns null HERE (no single subject expression makes sense
// for "every enemy at once") — resolveStatusStacksExpr below is what
// actually builds AllEnemies' real aggregate expression, using CombatState.
// HittableEnemies directly rather than a single subjectExpr.
//
// undefined (a package saved before this field existed) and 'Self' both
// resolve to 'fgPlayer' — the ACTING PLAYER's own stacks, "the status I
// have" in Tyler's own original wording, and the ONLY subject this ever
// checked before this field existed — so old saved packages keep compiling
// to the exact same behavior they always had.
function resolveAmountScaleSubjectExpr(action) {
  const subject = action.amountScalesWithSubject;
  if (subject === 'Target') return resolveTargetExpr(action.target);
  if (subject === 'AllEnemies') return null;
  return 'fgPlayer'; // 'Self', or undefined (pre-existing packages)
}

// Builds the full `ForgeActions.GetStatusStacks<T>(...)`-based stack-count
// expression for a given action's amountScalesWithSubject, INCLUDING the
// AllEnemies case — added round 24 (2026-08-30), fixed round 25 (2026-09-01)
// to go through `fgPlayer.CombatState.HittableEnemies` instead of bare
// `CombatState.HittableEnemies` — see resolvePlayerExpr's comment above for
// the full real-build evidence (bare `CombatState` is a CS0120 inside a
// CustomRelicModel hook; `fgPlayer.CombatState` is safe everywhere this
// runs). `Sum` — total stacks added up across every enemy, not an average
// or a max — is Tyler's own explicit design choice (2026-08-30) for what
// "the enemies' stacks" means when there's more than one enemy. Every
// non-AllEnemies subject is unchanged: single real GetStatusStacks<T> call
// against resolveAmountScaleSubjectExpr's expression.
function resolveStatusStacksExpr(action, typeArg) {
  if (action.amountScalesWithSubject === 'AllEnemies') {
    return `fgPlayer.CombatState.HittableEnemies.Sum(fgScaleTarget => ForgeActions.GetStatusStacks<${typeArg}>(fgScaleTarget))`; // [BEST EFFORT] Sum is Tyler's own choice over average/max — see this function's own comment
  }
  return `ForgeActions.GetStatusStacks<${typeArg}>(${resolveAmountScaleSubjectExpr(action)})`;
}

function resolveAmountExpr(action) {
  if (action.amountIsX) return RESOLVE_X_EXPR;
  if (action.amountIsStarX) return RESOLVE_STAR_X_EXPR;
  const scaleKind = action.amountScalesWithStatusKind === 'vanilla' ? 'vanilla' : 'custom';
  const ref = scaleKind === 'vanilla' ? action.amountScalesWithBuiltinStatus : action.amountScalesWithStatus;
  if (!ref) return String(action.amount);
  const typeArg = scaleKind === 'vanilla' ? BUILTIN_POWER_CLASS_MAP[ref] : mechanicClassName(ref);
  return `(${action.amount} * ${resolveStatusStacksExpr(action, typeArg)})`;
}

// [Round 80] Hit-count counterpart of resolveAmountScaleSubjectExpr above
// — see that function's own comment for the full reasoning (Target/
// AllEnemies/Self resolution). Reads hitCountScalesWithSubject instead of
// amountScalesWithSubject; otherwise identical.
function resolveHitCountScaleSubjectExpr(action) {
  const subject = action.hitCountScalesWithSubject;
  if (subject === 'Target') return resolveTargetExpr(action.target);
  if (subject === 'AllEnemies') return null;
  return 'fgPlayer'; // 'Self', or undefined (pre-existing packages)
}

// [Round 80] Hit-count counterpart of resolveStatusStacksExpr above — same
// real ForgeActions.GetStatusStacks<T> call, same AllEnemies Sum shape,
// just built off resolveHitCountScaleSubjectExpr instead.
function resolveHitCountStatusStacksExpr(action, typeArg) {
  if (action.hitCountScalesWithSubject === 'AllEnemies') {
    return `fgPlayer.CombatState.HittableEnemies.Sum(fgScaleTarget => ForgeActions.GetStatusStacks<${typeArg}>(fgScaleTarget))`; // [BEST EFFORT] Sum — same choice resolveStatusStacksExpr's AllEnemies case already makes
  }
  return `ForgeActions.GetStatusStacks<${typeArg}>(${resolveHitCountScaleSubjectExpr(action)})`;
}

// ModifyStatus's per-entry counterpart to resolveAmountExpr above — Tyler's
// follow-up once ApplyStatus/RemoveStatus/ApplyCustomStatus/RemoveCustomStatus
// merged into one "ModifyStatus" action with a combined vanilla+custom
// statusEntries[] list: "Applying status doesn't have a 'per stack' option.
// we should add one." Reuses the EXACT same amountScalesWith* fields/
// resolveAmountScaleSubjectExpr as DealDamage/GainBlock/ModifyHp — same
// [BEST EFFORT]/TodoAmount honesty tiers — just multiplies THIS entry's own
// base amount (from statusEntries[].amount, defaulting to 1, mirroring the
// old perEntryAmount's fallback-to-1) instead of the action's flat
// `amount`, since a ModifyStatus action can have several entries each with
// their own base amount before scaling is even applied.
function resolveStatusEntryAmountExpr(action, entry) {
  if (action.amountIsX) return RESOLVE_X_EXPR;
  if (action.amountIsStarX) return RESOLVE_STAR_X_EXPR;
  const base = (entry.amount !== undefined && entry.amount !== null && !Number.isNaN(Number(entry.amount))) ? entry.amount : 1;
  const scaleKind = action.amountScalesWithStatusKind === 'vanilla' ? 'vanilla' : 'custom';
  const ref = scaleKind === 'vanilla' ? action.amountScalesWithBuiltinStatus : action.amountScalesWithStatus;
  if (!ref) return String(base);
  const typeArg = scaleKind === 'vanilla' ? BUILTIN_POWER_CLASS_MAP[ref] : mechanicClassName(ref);
  return `(${base} * ${resolveStatusStacksExpr(action, typeArg)})`;
}

// DealDamage's own hit-count expression — a real, separate concept from
// amount (see RESOLVE_X_EXPR above and ForgeActions.DealDamage's new
// hitCount parameter). "1" (a real single hit) when neither hitCountIsX
// nor hitCount is set, matching the exact behavior every card had before
// this field existed.
function resolveHitCountExpr(action) {
  if (action.hitCountIsX) return RESOLVE_X_EXPR;
  // [Round 77, VERIFIED via decompiling Tyler's own uploaded
  // TheBurdenedNewCharacter.dll's "NEW X STAR" card] Shipped as
  // [BEST EFFORT] in round 76 (Tyler asked for it by symmetry, before any
  // real card demonstrated it); now confirmed for real. NEWXSTAR's own
  // OnPlay does exactly DamageCmd.Attack(DynamicVars.Damage.BaseValue)
  // .WithHitCount(this.ResolveStarXValue()) — a single attack, fixed base
  // damage amount, hit count scaled by star-X. Real, concrete, confirmed.
  if (action.hitCountIsStarX) return RESOLVE_STAR_X_EXPR;
  // [Round 80] hitCountScalesWith* — Tyler: "deal x damage, 1 time per
  // stack... i hit based on how many stacks i have." Same real
  // GetStatusStacks<T> mechanism amountScalesWith* already uses for
  // amount, applied to hitCount instead; hitCount itself is the
  // multiplier (1 = exactly your stacks). Mutually exclusive with
  // hitCountIsX/hitCountIsStarX above — backend/validate.js enforces that
  // — so this is only ever reached when neither of those is set.
  {
    const scaleKind = action.hitCountScalesWithStatusKind === 'vanilla' ? 'vanilla' : 'custom';
    const ref = scaleKind === 'vanilla' ? action.hitCountScalesWithBuiltinStatus : action.hitCountScalesWithStatus;
    if (ref) {
      const typeArg = scaleKind === 'vanilla' ? BUILTIN_POWER_CLASS_MAP[ref] : mechanicClassName(ref);
      const hc = (action.hitCount !== undefined && action.hitCount !== null) ? action.hitCount : 1;
      return `(${hc} * ${resolveHitCountStatusStacksExpr(action, typeArg)})`;
    }
  }
  if (action.hitCount !== undefined && action.hitCount !== null) return String(action.hitCount);
  return '1';
}

// Plain-text (NOT a C# expression) description of an action's amount, for
// embedding inside a ForgeActions.Todo(...) stub's descriptive string —
// used by the still-entirely-[UNVERIFIED] player/run-level action types
// (GainEnergy, ModifyGold, CreateCard) where there's no real call site to
// build a live expression FOR yet. Deliberately does NOT reuse
// resolveAmountExpr() here: that function can return a real C# expression
// (e.g. a GetStatusStacks<T>(...) call) meant to be emitted as CODE at a
// real call site — dropping that verbatim into a Todo() string argument
// would just be inert text inside quotes, misleadingly implying scaling is
// actually being computed when nothing here executes it. "X" for
// amountIsX, otherwise the plain literal amount (0 if unset).
function describeAmountForStub(action) {
  if (action.amountIsX || action.amountIsStarX) return 'X';
  return String(action.amount ?? 0);
}

// `ctx` (optional, default {}) added 2026-08-26 — mirrors
// conditionToCSharp(cond, ctx)'s own `cardPlayBound` flag exactly (see
// effectBlockToCSharp's doc comment above for the full definition: TRUE
// wherever a real `cardPlay` local is actually in scope — OnPlay itself
// and OnAnyCardPlayed — FALSE for every other hook that reaches here,
// e.g. relics/mechanics' OnTakeDamage/OnTurnStart/etc). Added specifically
// so the new 'EndTurn' case below can safely use the real, [VERIFIED]
// `cardPlay.Player` expression ONLY where it's actually guaranteed to
// exist, falling back to the honest Todo() stub everywhere else — same
// "only claim real where the evidence actually applies" discipline
// EnergyRemaining/StarsRemaining/CardsPlayedThisTurn already follow on
// the condition side. effectBlockToCSharp (the only real caller chain)
// already threads this same ctx through unchanged — see its own 3
// actionToCSharp(a, ctx) call sites.
//
// `forcedTargetExpr` (optional, default null) added round 24 (2026-08-30)
// — the generic RandomEnemy/AllEnemies wrapper below calls this SAME
// function recursively with a real, already-resolved single-Creature
// expression (`fgRandomTarget`/`fgAllEnemiesTarget`) to get that action's
// "as if single-target" statement(s), rather than every action type having
// to know how to enumerate/pick enemies itself. Only ever set by that
// recursive call — every other caller in this file omits it (defaults to
// null), which keeps this a top-level call that still does the validation/
// wrapping below.
// [Round 59 — VERIFIED via decompiling TheBurdenedNewCharacter.dll v3's
// "Exhaust" (exhaustRandomCard effect) and "Discard" (discardRandom
// effect) cards] Both compile to the SAME real pattern: read a pile's
// current `.Cards` fresh, and if non-empty, hand it to
// `Player.RunState.Rng.CombatCardSelection.NextItem(IEnumerable<T>)` — a
// real, public, INSTANCE method on `MegaCrit.Sts2.Core.Random.Rng`
// (confirmed via a direct sts2.dll read: NextItem flags=0x86 — Public,
// not static — called as `rng.NextItem(...)`, matching the real IL's
// `callvirt` off a fetched `Rng` instance). Looping `amount` times and
// re-reading `.Cards` each iteration (rather than picking `amount` cards
// from one snapshot) matches how the real card only ever picks ONE at a
// time — repeating that exact real shape rather than inventing a
// batched-random-sample variant with no decompiled evidence of its own.
// `PileTypeExtensions.GetPile(PileType, Player)` and `CardPile.Cards`
// (IReadOnlyList<CardModel>) are both separately confirmed public via
// direct sts2.dll reads. Gated on `ctx.cardPlayBound` by both callers,
// same as their own non-random paths — `cardPlay.Player` is what supplies
// the real `RunState`.
function resolveRandomCardPickAndAct(loopVarPrefix, amountExpr, actExprBuilder, playerExpr) {
  const iVar = `fg${loopVarPrefix}I`;
  const cardsVar = `fg${loopVarPrefix}Cards`;
  const pickVar = `fg${loopVarPrefix}Pick`;
  // [Round 63] `playerExpr` generalized from a hardcoded `cardPlay.Player`
  // to resolvePlayerExpr(ctx), passed in by both callers (ExhaustCard/
  // DiscardCard's random mode below) — same fix DrawCard/GainEnergy/
  // GainGold/CreateCard already got in earlier rounds; this helper simply
  // predates resolvePlayerExpr(ctx) itself (round 59) and never got
  // updated when it was introduced.
  return [
    `        for (var ${iVar} = 0; ${iVar} < ${amountExpr}; ${iVar}++)`,
    `        {`,
    `            var ${cardsVar} = MegaCrit.Sts2.Core.Entities.Cards.PileTypeExtensions.GetPile(MegaCrit.Sts2.Core.Entities.Cards.PileType.Hand, ${playerExpr}).Cards;`,
    `            if (${cardsVar}.Count > 0)`,
    `            {`,
    `                var ${pickVar} = ${playerExpr}.RunState.Rng.CombatCardSelection.NextItem(${cardsVar});`,
    `                ${actExprBuilder(pickVar)}`,
    `            }`,
    `        }`,
  ].join('\n');
}

function actionToCSharp(action, ctx = {}, forcedTargetExpr = null) {
  if (forcedTargetExpr === null) {
    // Defense-in-depth: the frontend now filters the target dropdown to
    // only valid options per action type (see ACTION_TARGETS/
    // validTargetsForAction in frontend/index.html) and backend/validate.js
    // rejects the package before it ever reaches here — but
    // generateProject()/actionToCSharp() are also callable directly (tests,
    // future callers), so this stays a hard error rather than silently
    // compiling a nonsensical action, same "fail loud" philosophy as
    // everywhere else in this file. Caught by a real stress test:
    // `ExhaustCard` (a player/hand-level action — there is no "exhaust a
    // card from an enemy" concept) targeting `AllEnemies` compiled silently
    // before this check existed.
    const validTargets = validTargetsForAction(action.type);
    if (!validTargets.includes(action.target)) {
      throw new Error(`Action "${action.type}" can't target "${action.target}" — valid targets for this action type are: ${validTargets.join(', ')}.`);
    }

    // AllEnemies is a legal target (validTargetsForAction) but
    // resolveTargetExpr only ever resolves a SINGLE-Creature expression —
    // it correctly returns null for AllEnemies (and RandomEnemy). DealDamage
    // and ModifyStatus's Add mode have their OWN real, evidenced multi-
    // target APIs for AllEnemies specifically (decompiling
    // TheBurdenedNewCharacter's real source, e.g. Stomp hitting every
    // enemy) — see their own case bodies below plus ForgeActions.cs.
    // template's DealDamageAllEnemies/ApplyStatusAllEnemies<T> for the full
    // evidence trail — so those two specific (type, target) combinations
    // are exempted from the generic wrapper below and handle themselves
    // inline instead.
    const allEnemiesHandledInline = action.target === 'AllEnemies' &&
      (action.type === 'DealDamage' || (action.type === 'ModifyStatus' && action.mode !== 'Remove'));

    // Generic RandomEnemy/AllEnemies wrapper — added round 24 (2026-08-30),
    // fixed round 25 (2026-09-01). The old comment here used to say there
    // was "no way to enumerate/pick enemies from the current OnPlay
    // signature" and fall through to an UNVERIFIED Todo() for every action
    // type but the two special-cased above. That was stale: `HittableEnemies`
    // is a real, already-proven-real `IReadOnlyList<Creature>` (it's
    // literally what DealDamageAllEnemies/ApplyStatusAllEnemies<T> already
    // use) — but it is NOT reachable via a bare `CombatState` from every
    // generated class this can be emitted inside. Round 24 assumed
    // CustomCardModel/CustomRelicModel/CustomPowerModel all exposed it the
    // same way; Tyler's first real `dotnet build` of that output proved
    // otherwise (10 real CS0120 errors, all inside CustomRelicModel hook
    // bodies — see claude/round25-real-build-findings.md). Direct sts2.dll
    // reads confirmed why: `CardModel`/`PowerModel` both declare a real
    // instance property `ICombatState CombatState { get; }`, but
    // `RelicModel` does not — so bare `CombatState` there gets parsed as the
    // TYPE (`MegaCrit.Sts2.Core.Combat.CombatState`, in scope via using),
    // and `.HittableEnemies`/`.Players` fail as non-static members accessed
    // off a type. Fixed by going through `fgPlayer.CombatState` instead —
    // `Creature.CombatState` (also real, also confirmed) is reachable
    // identically regardless of whether `this` is a CardModel, RelicModel,
    // or PowerModel, and `fgPlayer` is unconditionally bound as a real
    // Creature before any action codegen runs (see resolvePlayerExpr's own
    // comment for the full "always bound" argument). Rather than teach
    // DealDamage/ModifyStatus/RemoveAllStatuses/ModifyHp/StunEnemy (the only
    // 5 action types AllEnemies/RandomEnemy are even legal targets for — see
    // validTargetsForAction) to each enumerate enemies themselves, this
    // recursively asks THIS SAME function for the action's "as if
    // single-target" statement(s) against a forced target expression, then
    // wraps that in a null-guard (RandomEnemy, via a new
    // ForgeActions.PickRandomEnemy helper — see ForgeActions.cs.template) or
    // a foreach loop (AllEnemies). Traced against every existing switch case
    // below: zero regression to DealDamage's/ModifyStatus-Add's own
    // dedicated AllEnemies paths (both exempted via allEnemiesHandledInline
    // above, and fixed the same way — see their own case bodies), and every
    // other case only ever reads `targetExpr`/checks
    // `action.target === 'AllEnemies'` in ways that stay correct once the
    // recursive call substitutes in a real per-enemy/random-enemy local.
    if (action.target === 'RandomEnemy') {
      const inner = actionToCSharp(action, ctx, 'fgRandomTarget');
      return [
        '        { // [BEST EFFORT] RandomEnemy — generic wrapper over fgPlayer.CombatState.HittableEnemies (see actionToCSharp\'s own comment on this block) — not a dedicated per-type API',
        '            var fgRandomTarget = ForgeActions.PickRandomEnemy(fgPlayer.CombatState.HittableEnemies);',
        '            if (fgRandomTarget != null)',
        '            {',
        inner,
        '            }',
        '        }',
      ].join('\n');
    }
    if (action.target === 'AllEnemies' && !allEnemiesHandledInline) {
      const inner = actionToCSharp(action, ctx, 'fgAllEnemiesTarget');
      return [
        '        { // [BEST EFFORT] AllEnemies — generic wrapper over fgPlayer.CombatState.HittableEnemies (see actionToCSharp\'s own comment on this block) — not a dedicated per-type API',
        '            foreach (var fgAllEnemiesTarget in fgPlayer.CombatState.HittableEnemies.ToList())',
        '            {',
        inner,
        '            }',
        '        }',
      ].join('\n');
    }

    // [Fix, round 29 — real crash, see TOOLCHAIN_FINDINGS.md] SingleEnemy
    // on a hook where ctx.targetMayBeNull is set (TRIGGER_HOOKS/
    // CARD_TRIGGER_HOOKS' OnAnyCardPlayed — see their own comments) binds
    // fgTarget from a BORROWED cardPlay.Target that can genuinely be null
    // (an untargeted card play). resolveTargetExpr's plain `fgTarget!` is
    // only a compile-time assertion, not a runtime check — confirmed by a
    // real godot.log NullReferenceException inside CreatureCmd.Stun when
    // this exact combination (a relic's OnAnyCardPlayed -> StunEnemy
    // effect) fired on an untargeted Defend card play. Same recursive
    // forced-target-expr shape as RandomEnemy/AllEnemies just above —
    // fgTarget itself becomes the forced expression once we're already
    // inside the null check, so the recursive call's own `forcedTargetExpr
    // !== null` skips this branch and every other hook (targetMayBeNull
    // unset/false) is completely unaffected.
    if (action.target === 'SingleEnemy' && ctx.targetMayBeNull) {
      const inner = actionToCSharp(action, ctx, 'fgTarget');
      return [
        '        { // [Fix, round 29] SingleEnemy target borrowed from cardPlay.Target on an OnAnyCardPlayed-style hook — can be null for an untargeted card play, guarded instead of trusting the old `fgTarget!` null-forgiving cast (see actionToCSharp\'s own comment on this block)',
        '            if (fgTarget != null)',
        '            {',
        inner,
        '            }',
        '        }',
      ].join('\n');
    }
  }

  const targetExpr = forcedTargetExpr || resolveTargetExpr(action.target);

  // The one legitimate case where targetExpr is still null but that's fine:
  // DealDamage/ModifyStatus-Add targeting AllEnemies, which the switch below
  // handles itself via their own `action.target === 'AllEnemies'` checks
  // (dedicated ForgeActions.DealDamageAllEnemies/ApplyStatusAllEnemies<T>
  // calls, never `targetExpr`) rather than reading targetExpr at all — see
  // the wrapper section above for why these two never reach this function
  // via forcedTargetExpr either.
  const allEnemiesHandledInline = forcedTargetExpr === null && action.target === 'AllEnemies' &&
    (action.type === 'DealDamage' || (action.type === 'ModifyStatus' && action.mode !== 'Remove'));

  if (!targetExpr && action.target !== 'None' && !allEnemiesHandledInline) {
    return `        ForgeActions.Todo("${action.type} targeting ${action.target}"); // [UNVERIFIED]`;
  }

  switch (action.type) {
    case 'DealDamage':
      // [BEST EFFORT] real damage-dealing goes through AttackCommand's
      // fluent builder (reflect-baselib round 7), not a simple Creature
      // method — ForgeActions.DealDamage is now `async Task`, awaited
      // here since it's always emitted inside an `async Task` method
      // (OnPlay or a relic hook) alongside a real `choiceContext` param —
      // see TRIGGER_HOOKS/generateRelicHooks for why that's guaranteed.
      // The 4th arg (hitCount) is now [VERIFIED via decompiling
      // TheBurdenedNewCharacter.dll] — AttackCommand.WithHitCount(int) is
      // real, confirmed by a working card (Retaliation) in that mod;
      // always passed explicitly (defaults to "1", a real single hit,
      // when hitCount/hitCountIsX aren't set — unchanged behavior).
      //
      // AllEnemies (added 2026-08-26, fixed round 25 2026-09-01): routes to
      // the separate ForgeActions.DealDamageAllEnemies helper instead — see
      // its own comment in ForgeActions.cs.template. Goes through
      // `fgPlayer.CombatState` rather than a bare `CombatState` — bare
      // `CombatState` is only a real instance member on CardModel/
      // PowerModel, NOT RelicModel (confirmed via direct sts2.dll read
      // after Tyler's real build caught this — see resolvePlayerExpr's own
      // comment for the full evidence); `fgPlayer.CombatState` (via
      // Creature.CombatState, also real) works identically everywhere this
      // is emitted, no ctx/entityKind branching needed.
      {
        // [Fix, round 30] dmgSrc supplies the real attacker-attribution
        // args ForgeActions.DealDamage/DealDamageAllEnemies now require —
        // see resolveDamageSourceArgs's own comment above.
        const dmgSrc = resolveDamageSourceArgs(ctx);
        // followUp — Tyler's "follow up" ask (added 2026-08-27, see
        // actionsArray's followUp field in schema/character.schema.json for
        // the full evidence writeup). Synthesizes a plain `if (...) { ... }`
        // block right after this action's own DealDamage/DealDamageAllEnemies
        // call, in the SAME method body — reusing conditionToCSharp's
        // DamageBrokeBlock case (a synthetic {kind:...} object, never a
        // user-authored condition) for BrokeBlock/FullyBlocked/
        // UnblockedAmount, and actionToCSharp recursively for the nested
        // actions, exactly like effectBlockToCSharp's own if/else-actions
        // indentation pattern above.
        const fu = action.followUp;
        // [Round 70] Tyler: "lets change how it works to the verified
        // version from TemperedStrength" — KilledTarget's followUp now
        // reads the real AttackCommand's own `.Results` (see
        // ForgeActions.cs.template's DealDamage/DealDamageAllEnemies,
        // which now return it instead of discarding it) rather than the
        // old [BEST EFFORT] CombatManager.History walk. Every other case
        // (no followUp, or BrokeBlock/FullyBlocked/UnblockedAmount) is
        // unaffected — discarding an awaited Task<T>'s result as a bare
        // statement is ordinary C#, no local variable needed there.
        const usesKilledTargetAttackCommand = !!(fu && fu.trigger === 'KilledTarget' && Array.isArray(fu.actions) && fu.actions.length);
        // [Round 199] "Unblockable" -- ValueProp.Unblockable is
        // [VERIFIED via direct ECMA-335 field read of the real
        // MegaCrit.Sts2.Core.ValueProps.ValueProp [Flags] enum, round
        // 199] a real member (= 2). Only actually reachable on the
        // sourceCard-less path ForgeActions.DealDamage/DealDamageAllEnemies
        // take (see their own template comment) -- the sourceCard path
        // goes through AttackCommand's own fluent builder, whose
        // DamageProps setter is PRIVATE (confirmed same reflection pass),
        // so there's no way to set it there. dmgSrc already tells us which
        // path this call takes (resolveDamageSourceArgs) -- a sourceCard
        // is present exactly when ctx.cardPlayBound, so the flag is
        // honestly dropped (not silently wrong) with a comment on that
        // branch instead of being passed somewhere it can't take effect.
        const unblockableArg = action.unblockable ? 'true' : 'false';
        const unblockableNote = (action.unblockable && ctx.cardPlayBound)
          ? ' /* [KNOWN GAP] "Unblockable" has no effect here -- this goes through AttackCommand, whose DamageProps setter is private; only takes effect on a relic/mechanic/affliction\'s own DealDamage (no CardModel source) -- see compiler.js\'s own comment on this case */'
          : '';
        const dealLine = action.target === 'AllEnemies'
          ? `        ${usesKilledTargetAttackCommand ? 'var fuAttackCommand = ' : ''}await ForgeActions.DealDamageAllEnemies(choiceContext, ${dmgSrc}, fgPlayer.CombatState, ${resolveAmountExpr(action)}, ${resolveHitCountExpr(action)}, ${unblockableArg}); // [Fix, round 30] see ForgeActions.cs.template's DealDamageAllEnemies${unblockableNote}`
          : `        ${usesKilledTargetAttackCommand ? 'var fuAttackCommand = ' : ''}await ForgeActions.DealDamage(choiceContext, ${dmgSrc}, ${targetExpr}, ${resolveAmountExpr(action)}, ${resolveHitCountExpr(action)}, ${unblockableArg}); // [Fix, round 30] see ForgeActions.cs.template's DealDamage${unblockableNote}`;
        if (fu && fu.trigger && Array.isArray(fu.actions) && fu.actions.length) {
          // FullyBlocked/UnblockedAmount added 2026-08-27 (sts2.dll direct
          // read confirmed DamageResult.WasFullyBlocked/UnblockedDamage as
          // real properties — see DamageWasFullyBlocked/DamageUnblockedAmount
          // condition kinds above). UnblockedAmount is the one followUp
          // trigger that needs its own comparator+value (a real numeric
          // amount, not a boolean outcome) — threaded straight from the
          // action's own followUp.comparator/value into the synthetic cond.
          const FOLLOWUP_COND_KINDS = { BrokeBlock: 'DamageBrokeBlock', FullyBlocked: 'DamageWasFullyBlocked', UnblockedAmount: 'DamageUnblockedAmount' };
          // [Round 70] `fuAttackCommand` can genuinely be null — the
          // relic/mechanic no-sourceCard branch (see
          // ForgeActions.DealDamage's own comment) has no real
          // AttackCommand to read Results off at all, so this correctly
          // (and honestly) never fires there, same real limitation the
          // old History-walk version already had in that same context
          // (its `e.CardSource == this` check could never match there
          // either, since `this` isn't a CardModel on a relic/mechanic
          // hook) — not a new gap this round introduces.
          const condExpr = usesKilledTargetAttackCommand
            ? `(fuAttackCommand?.Results.SelectMany(h => h).Any(r => r.WasTargetKilled) ?? false) /* [VERIFIED via decompiling TemperedStrength's real OnPlay — AttackCommand.Results.SelectMany(h=>h).Any(r => r.WasTargetKilled)] */`
            : conditionToCSharp({ kind: FOLLOWUP_COND_KINDS[fu.trigger] || 'DamageBrokeBlock', comparator: fu.comparator, value: fu.value }, ctx);
          const lines = [dealLine, `        if (${condExpr})`, `        {`];
          fu.actions.forEach(fa => {
            const code = actionToCSharp(fa, ctx);
            lines.push(code.split('\n').map(l => `    ${l}`).join('\n'));
          });
          lines.push(`        }`);
          return lines.join('\n');
        }
        return dealLine;
      }
    case 'GainBlock':
      // Target is ALWAYS "Self" (see SELF_ONLY_ACTIONS/validTargetsForAction
      // above — enforced before this switch is ever reached) — Tyler:
      // "Gain block should only ever be for yourself."
      //
      // [Fix, round 36 — real bug: Tyler reported no sound when gaining
      // block, then asked directly whether block itself might be applied
      // incorrectly rather than it being a character-art gap — he was
      // right. ForgeActions.GainBlock now goes through the real
      // MegaCrit.Sts2.Core.Commands.CreatureCmd.GainBlock command instead
      // of calling Creature.GainBlockInternal directly — see
      // ForgeActions.cs.template's GainBlock for the full real call chain
      // this was silently skipping (sound, VFX, block-amount modifier
      // hooks, combat history). Now `await`ed (the real command is async),
      // and threads a real `cardPlay` through whenever one is in scope —
      // same ctx.cardPlayBound gate DealDamage/resolveDamageSourceArgs
      // already use elsewhere in this file — so CombatHistory/the
      // Before/AfterBlockGained hooks can see the real source card the
      // same way a vanilla card's own OnPlay does; a relic/mechanic hook
      // with no real cardPlay in scope omits it (defaults to null on the
      // C# side).
      return `        await ForgeActions.GainBlock(${targetExpr}, ${resolveAmountExpr(action)}${ctx.cardPlayBound ? ', cardPlay' : ''}); // [Fix, round 36] see ForgeActions.cs.template's GainBlock`;
    case 'ModifyStatus': {
      // Replaces the old ApplyStatus/RemoveStatus/ApplyCustomStatus/
      // RemoveCustomStatus — Tyler: "lets reduce apply/remove/customapply/
      // customremove to just be 'Modify status'... We can use the combined
      // vanilla+custom statuse list so we can get rid of the custom
      // options." `statusEntries[]` (each `{kind, ref, amount?}`) is ONE
      // combined list instead of 4 separate action types/fields — one
      // ForgeActions call per entry, sharing this action's target and
      // `mode`. Same real, generic ForgeActions.ApplyStatus<T>()/
      // RemoveStatus<T>() calls the 4 retired types already used — see
      // TOOLCHAIN_FINDINGS.md "reflect-baselib round 8" — this is a UI/data-
      // model consolidation, not a change to what actually gets called.
      const entries = Array.isArray(action.statusEntries) ? action.statusEntries : [];
      if (!entries.length) {
        throw new Error(`Action "ModifyStatus" needs at least one entry selected (statusEntries[]).`);
      }
      const mode = action.mode === 'Remove' ? 'Remove' : 'Add';
      return entries.map(entry => {
        const kind = entry.kind === 'vanilla' ? 'vanilla' : 'custom';
        let typeArg;
        if (kind === 'vanilla') {
          if (!BUILTIN_POWER_CLASS_MAP[entry.ref]) {
            throw new Error(`Action "ModifyStatus" has a vanilla entry "${entry.ref}" — must be one of: ${Object.keys(BUILTIN_POWER_CLASS_MAP).join(', ')}.`);
          }
          // Defense in depth (see PROTECTED_CTOR_BUILTIN_POWERS above) —
          // only matters for Add (RemoveStatus<T>() has no "new()"
          // constraint) — BUILTIN_STATUSES already excludes these 3 so
          // the frontend/validate.js should never let one through for
          // Add, but generateProject() is also callable directly.
          if (mode === 'Add' && PROTECTED_CTOR_BUILTIN_POWERS.has(entry.ref)) {
            throw new Error(`Action "ModifyStatus" has a vanilla entry "${entry.ref}" with mode "Add" — this class has a protected (not public) constructor [confirmed via reflect-baselib round 9], so ForgeActions.ApplyStatus<T>()'s "new()" constraint can't construct it.`);
          }
          typeArg = BUILTIN_POWER_CLASS_MAP[entry.ref];
        } else {
          typeArg = mechanicClassName(entry.ref);
        }
        if (mode === 'Add') {
          const amt = resolveStatusEntryAmountExpr(action, entry);
          // AllEnemies (added 2026-08-26, fixed round 25 2026-09-01): routes
          // through the separate ForgeActions.ApplyStatusAllEnemies<T>
          // helper instead — see its own comment in ForgeActions.cs.template.
          // `fgPlayer` (the acting player's Creature — already unconditionally
          // bound by every hook this can be emitted inside, unlike `this`,
          // which would be wrong-typed outside a card context) is the
          // `source` arg, matching every real example seen; `sourceCard:
          // null` is a real, proven-valid value (several real cards pass
          // exactly `(CardModel?)null` here) rather than trying to reference
          // `this`, which only means "the playing card" inside a CARD's own
          // generated class — this action can also be authored on a
          // relic/mechanic hook, where `this` is a different, wrong type
          // entirely. The enemy list itself goes through
          // `fgPlayer.CombatState.HittableEnemies` rather than a bare
          // `CombatState.HittableEnemies` — bare `CombatState` is only a
          // real instance member on CardModel/PowerModel, not RelicModel
          // (see resolvePlayerExpr's own comment for the full real-build
          // evidence that caught this).
          if (action.target === 'AllEnemies') {
            return `        await ForgeActions.ApplyStatusAllEnemies<${typeArg}>(choiceContext, fgPlayer.CombatState.HittableEnemies, ${amt}, fgPlayer, null); // [BEST EFFORT] see ForgeActions.cs.template's ApplyStatusAllEnemies<T>`;
          }
          return `        ForgeActions.ApplyStatus<${typeArg}>(${targetExpr}, ${amt}); // [BEST EFFORT] see TOOLCHAIN_FINDINGS.md "reflect-baselib round 8"`;
        }
        return `        ForgeActions.RemoveStatus<${typeArg}>(${targetExpr}); // [BEST EFFORT] see TOOLCHAIN_FINDINGS.md "reflect-baselib round 8"`;
      }).join('\n');
    }
    case 'RemoveAllStatuses':
      // Preserves the old "remove all" concept Tyler asked to keep, now on
      // a real, verified API instead of a loop over every known status:
      // Creature.RemoveAllPowersInternalExcept(IEnumerable<PowerModel> except)
      // is a real, concrete, public method — found in already-collected
      // round 8 reflect-baselib data (see TOOLCHAIN_FINDINGS.md
      // "reflect-baselib round 8 — RemoveAllPowersInternalExcept"). Calling
      // it with an empty collection removes every power currently on the
      // target, vanilla AND custom alike (it doesn't care which are which)
      // — no per-status enumeration needed, so this one call is correct
      // regardless of how large BUILTIN_POWER_CLASS_MAP grows.
      return `        ForgeActions.RemoveAllStatuses(${targetExpr}); // [VERIFIED] see TOOLCHAIN_FINDINGS.md "reflect-baselib round 8 — RemoveAllPowersInternalExcept"`;
    case 'ModifyHp': {
      // Replaces the old separate LoseHp/HealHp types — Tyler: "Gain and
      // lose HP should be combined into 'Modify HP' with a dropdown in the
      // sentence for 'gain' or 'lose'." Both underlying calls are
      // unchanged [BEST EFFORT] real ForgeActions methods (see
      // TOOLCHAIN_FINDINGS.md "reflect-baselib round 7") — `mode` just
      // picks which one, same amount/scaling resolution either way.
      //
      // [Round 204, Tyler: "we need to add an option to affect max HP
      // instead of just current"] `hpKind === 'max'` routes through the
      // separate, real CreatureCmd.GainMaxHp/LoseMaxHp pair instead (see
      // ForgeActions.cs.template's own comment on GainMaxHp/LoseMaxHp for
      // the IL evidence) — a genuinely different pair of real methods
      // from LoseHpInternal/HealInternal above, not a parameter on the
      // same call. LoseMaxHp needs `choiceContext` (real, always in scope
      // — every hook's first param, same as DrawCard's own real
      // CardPileCmd.Draw call above) and `isFromCard`, which is exactly
      // what ctx.cardPlayBound already tracks: whether this action is
      // executing as part of a card's own OnPlay rather than a relic/
      // mechanic/affliction hook.
      const mode = action.mode === 'Lose' ? 'Lose' : 'Gain';
      if (action.hpKind === 'max') {
        if (mode === 'Lose') {
          return `        await ForgeActions.LoseMaxHp(choiceContext, ${targetExpr}, ${resolveAmountExpr(action)}, ${ctx.cardPlayBound ? 'true' : 'false'}); // [VERIFIED via direct ECMA-335 IL disassembly of the real installed sts2.dll — CreatureCmd.LoseMaxHp] see ForgeActions.cs.template`;
        }
        return `        await ForgeActions.GainMaxHp(${targetExpr}, ${resolveAmountExpr(action)}); // [VERIFIED via direct ECMA-335 IL disassembly of the real installed sts2.dll — CreatureCmd.GainMaxHp] see ForgeActions.cs.template`;
      }
      if (mode === 'Lose') {
        return `        ForgeActions.LoseHp(${targetExpr}, ${resolveAmountExpr(action)}); // [BEST EFFORT] see TOOLCHAIN_FINDINGS.md "reflect-baselib round 7"`;
      }
      return `        ForgeActions.Heal(${targetExpr}, ${resolveAmountExpr(action)}); // [BEST EFFORT]`;
    }
    case 'DrawCard':
      // [BEST EFFORT] upgraded round 24 (2026-08-30) — direct sts2.dll read
      // confirmed `MegaCrit.Sts2.Core.Commands.CardPileCmd.Draw(
      // PlayerChoiceContext choiceContext, decimal count, Player player,
      // bool fromHandDraw) : Task<IEnumerable<CardModel>>` is real.
      // `fromHandDraw: false` is Tyler's own explicit choice (2026-08-30) —
      // treating this as a triggered-effect draw, not the start-of-turn
      // hand draw step; the exact semantics of that flag aren't pinned
      // down by any witnessed real call.
      //
      // [Fix, round 30 — real crash: godot.log showed
      // `System.NotImplementedException: Forge: "DrawCard 6" has no
      // verified STS2/BaseLib API mapping yet` thrown from TestChar.
      // Relics.Group1Relic.AfterBlockBroken, which KILLED THE WHOLE COMBAT
      // TURN LOOP ("stuck until the room is restarted") — not a harmless
      // skipped action; see TOOLCHAIN_FINDINGS.md "didnt draw more cards".
      // The old comment here claimed "no non-cardPlayBound fallback for
      // anywhere else either" and gated this on ctx.cardPlayBound — stale:
      // resolvePlayerExpr(ctx) (added round 24, fixed round 25) already
      // resolves a real Player from ANY hook context via `fgPlayer.
      // Player`, the exact same gap GainEnergy/GainGold/CreateCard already
      // closed with it. `choiceContext` is likewise real in every hook
      // context — it's the first param on literally every TRIGGER_HOOKS
      // entry, confirmed again directly by this exact crash's own
      // AfterBlockBroken(PlayerChoiceContext choiceContext, ...) params.
      // So the non-cardPlayBound branch was never actually blocked on
      // missing evidence, just never updated when resolvePlayerExpr was
      // introduced — DrawCard now always emits the real call.
      //
      // `drawNextTurn` retired this round (Tyler uploaded his own real,
      // compiled "Star Cost" card from The Burdened v3 to settle it) — it
      // was solving the wrong problem. There is no "schedule a draw for
      // next turn" API and there was never going to be one to find,
      // because that isn't how the real game does this: the uploaded
      // card's OnPlay applies the vanilla BaseLib power
      // `DrawCardsNextTurnPower` (MegaCrit.Sts2.Core.Models.Powers,
      // confirmed via direct TypeRef/MemberRef inspection of the shipped
      // DLL) instead of calling any draw-scheduling method at all — and
      // that class was ALREADY in BUILTIN_POWER_CLASS_MAP/BUILTIN_STATUSES
      // above (as "DrawCardsNextTurn") and isn't one of the 3
      // protected-ctor exclusions, so ModifyStatus -> Apply ->
      // "DrawCardsNextTurn" already compiles for real via the existing
      // generic ForgeActions.ApplyStatus<T>() path today. "Draw next
      // turn" was never a DrawCard variant — it's a status application.
      // See validate.js/character.schema.json for the matching
      // drawNextTurn retirement.
      return `        await MegaCrit.Sts2.Core.Commands.CardPileCmd.Draw(choiceContext, ${resolveAmountExpr(action)}, ${resolvePlayerExpr(ctx)}, false); // [Fix, round 30] see compiler.js's own comment on this case / resolvePlayerExpr's own comment`;
    case 'ModifyEnergy': {
      // [Round 160] Tyler reconsidered round 159's sign-based design after
      // being asked to choose between it and a mode dropdown for the new
      // ModifyOrbSlots action (see that case below): "i like number 2
      // [mode dropdown], can we also apply that to the energy?" So
      // ModifyEnergy now matches ModifyHp/ModifyGold exactly — an
      // author-facing `mode` field (Gain/Lose), `amount` always a positive
      // magnitude the author enters, no runtime sign check. Round 159's
      // no-mode/sign-based version is fully superseded; the underlying API
      // evidence is unchanged:
      //   - GainEnergy(decimal amount, Player player) — [BEST EFFORT], same
      //     real call the original "Gain Energy" action used (decompiled
      //     TheBurdenedNewCharacter source). Its own IL no-ops on
      //     amount <= 0 (both before and after modifier resolution) — a
      //     non-issue here since Gain mode's `amount` is authored positive.
      //   - LoseEnergy(decimal amount, Player player) — [VERIFIED via
      //     direct sts2.dll IL read, round 159] a real, public, static,
      //     non-async sibling method. Its IL: `if (amount <= 0) return
      //     Task.CompletedTask;` else `player.PlayerCombatState.
      //     LoseEnergy(amount)` — expects a POSITIVE magnitude ("how much
      //     to lose"), which is exactly what Lose mode's `amount` already
      //     is, so no negation is needed (unlike round 159's sign-flip).
      //
      // doubleEnergy (Tyler's "double the user's current energy" checkbox,
      // [VERIFIED] round 59) is unaffected either way — it always computes
      // a genuine gain and keeps calling GainEnergy directly, ignoring
      // `mode` entirely (same as before round 159).
      if (action.doubleEnergy) {
        return `        await MegaCrit.Sts2.Core.Commands.PlayerCmd.GainEnergy((decimal)${resolvePlayerExpr(ctx)}.PlayerCombatState.Energy, ${resolvePlayerExpr(ctx)}); // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — "Double Energy" card, round 59] see compiler.js's own comment on this case`;
      }
      const fgEnergyPlayerExpr = resolvePlayerExpr(ctx);
      return action.mode === 'Lose'
        ? `        await MegaCrit.Sts2.Core.Commands.PlayerCmd.LoseEnergy(${resolveAmountExpr(action)}, ${fgEnergyPlayerExpr}); // [VERIFIED via direct sts2.dll IL read, round 159] see compiler.js's own comment on this case`
        : `        await MegaCrit.Sts2.Core.Commands.PlayerCmd.GainEnergy(${resolveAmountExpr(action)}, ${fgEnergyPlayerExpr}); // [BEST EFFORT] see compiler.js's own comment on this case`;
    }
    case 'ModifyGold': {
      // [BEST EFFORT] upgraded round 24 (2026-08-30) — Gain's real call was
      // found 2026-08-26 (same decompile as GainEnergy):
      // `MegaCrit.Sts2.Core.Commands.PlayerCmd.GainGold(decimal amount,
      // Player owner, bool wasStolenBack)` (`await PlayerCmd.GainGold(30m,
      // base.Owner);` — the 3rd arg is real but was optional/omitted in
      // that real call; `false` here matches "not a steal-back", the
      // ordinary case). Lose's real call — `PlayerCmd.LoseGold(decimal
      // amount, Player player, GoldLossType goldLossType)` — was confirmed
      // this round via a direct sts2.dll read (not a decompiled mod usage,
      // so [BEST EFFORT] rather than [VERIFIED] like the Gain path already
      // was); `GoldLossType.Lost` (enum values None/Spent/Lost/Stolen, all
      // confirmed the same way) is the one matching "a forced loss effect",
      // as opposed to Spent (buying something) or Stolen (a relic/enemy
      // took it). Non-cardPlayBound fallback (both modes) uses
      // resolvePlayerExpr(ctx) — see GainEnergy's own comment above for why
      // that's now real instead of a stub.
      const playerExpr = resolvePlayerExpr(ctx);
      return action.mode === 'Lose'
        ? `        await MegaCrit.Sts2.Core.Commands.PlayerCmd.LoseGold(${resolveAmountExpr(action)}, ${playerExpr}, MegaCrit.Sts2.Core.Entities.Gold.GoldLossType.Lost); // [BEST EFFORT] see compiler.js's own comment on this case`
        : `        await MegaCrit.Sts2.Core.Commands.PlayerCmd.GainGold(${resolveAmountExpr(action)}, ${playerExpr}, false); // [BEST EFFORT] see compiler.js's own comment on this case`;
    }
    case 'ExhaustCard': {
      // [Round 63] Generalized off `ctx.cardPlayBound` — same fix
      // DrawCard/GainEnergy/GainGold/CreateCard already got (rounds 24-26,
      // 59): `resolvePlayerExpr(ctx)` resolves a real Player from ANY hook
      // context (see its own comment), and `choiceContext` is a real param
      // on every TRIGGER_HOOKS entry (confirmed directly by DrawCard's own
      // fix comment above) — so this action was never actually blocked on
      // missing evidence, just never updated when resolvePlayerExpr was
      // introduced (see claude/round62-session-handoff.md). `random` still
      // has no real "pick N at random" API found for anything BUT the
      // Rng.NextItem loop resolveRandomCardPickAndAct already uses, so
      // that mode is unaffected beyond threading the resolved player
      // through it too.
      const exhaustPlayerExpr = resolvePlayerExpr(ctx);
      if (action.random) {
        return resolveRandomCardPickAndAct('ExhaustRandom', resolveAmountExpr(action), (pickVar) => `await MegaCrit.Sts2.Core.Commands.CardCmd.Exhaust(choiceContext, ${pickVar}, false, false); // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — "Exhaust" card's exhaustRandomCard effect, round 59]`, exhaustPlayerExpr);
      }
      // [Round 191 fix] The prompt-picker's last arg is bare `this` --
      // never confirmed against a real non-card `this` (an EnchantmentModel
      // authoring this action would pass itself, not a CardModel/
      // AbstractModel-verified-safe type here). Gated on ctx.thisIsCard,
      // same ReturnToHand/ShuffleCardIntoDraw precedent, rather than
      // guessing this parameter accepts anything but a real card.
      if (!ctx.thisIsCard) {
        return `        ForgeActions.Todo("ExhaustCard (prompt) -- this action's CardSelectCmd.FromHand call takes \`this\` as its last argument, unconfirmed outside a card's own generated class"); // [UNVERIFIED] see compiler.js's own comment on this case`;
      }
      return `        foreach (var fgExhaustCard in await MegaCrit.Sts2.Core.Commands.CardSelectCmd.FromHand(choiceContext, ${exhaustPlayerExpr}, new MegaCrit.Sts2.Core.CardSelection.CardSelectorPrefs(MegaCrit.Sts2.Core.CardSelection.CardSelectorPrefs.ExhaustSelectionPrompt, ${resolveAmountExpr(action)}), null, this)) { await MegaCrit.Sts2.Core.Commands.CardCmd.Exhaust(choiceContext, fgExhaustCard, false, false); } // [Round 63] see compiler.js's own comment on this case / resolvePlayerExpr's own comment`;
    }
    case 'DiscardCard': {
      // [Round 63] Generalized off `ctx.cardPlayBound` — same fix as
      // ExhaustCard just above (its own comment has the full reasoning).
      // The real, [VERIFIED] non-random call chain (round 16 — 4/4 real
      // discard cards) and the [VERIFIED] random loop (round 59) are both
      // unchanged; only the player expression they resolve through moved
      // from a hardcoded `cardPlay.Player` to `resolvePlayerExpr(ctx)`.
      const discardPlayerExpr = resolvePlayerExpr(ctx);
      if (action.random) {
        return resolveRandomCardPickAndAct('DiscardRandom', resolveAmountExpr(action), (pickVar) => `await MegaCrit.Sts2.Core.Commands.CardCmd.Discard(choiceContext, ${pickVar}); // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — "Discard" card's discardRandom effect, round 59]`, discardPlayerExpr);
      }
      // [Round 191 fix] Same ctx.thisIsCard gate as ExhaustCard's own
      // prompt-picker branch just above -- see its comment for the full
      // reasoning.
      if (!ctx.thisIsCard) {
        return `        ForgeActions.Todo("DiscardCard (prompt) -- this action's CardSelectCmd.FromHandForDiscard call takes \`this\` as its last argument, unconfirmed outside a card's own generated class"); // [UNVERIFIED] see compiler.js's own comment on this case`;
      }
      return `        await MegaCrit.Sts2.Core.Commands.CardCmd.Discard(choiceContext, await MegaCrit.Sts2.Core.Commands.CardSelectCmd.FromHandForDiscard(choiceContext, ${discardPlayerExpr}, new MegaCrit.Sts2.Core.CardSelection.CardSelectorPrefs(MegaCrit.Sts2.Core.CardSelection.CardSelectorPrefs.DiscardSelectionPrompt, ${resolveAmountExpr(action)}), null, this)); // [VERIFIED via decompiling TheBurdenedNewCharacter.dll — 4/4 real discard cards use this exact chain — see compiler.js's own comment on this case / resolvePlayerExpr's own comment`;
    }
    case 'CreateCard': {
      // [BEST EFFORT] upgraded round 24 (2026-08-30) — replaces the old
      // separate CreateCardInHand/CreateCardInDrawPile types. Tyler:
      // "Create card in hand and draw pile should be 'Create Card' ...
      // this should pull a dropdown menu containing all of the user's
      // created token cards, as well as the vanilla status cards if
      // possible."
      //
      // `CombatState.CreateCard(CardModel canonicalCard, Player owner) :
      // CardModel` is a real instance method on ICombatState (confirmed via
      // direct sts2.dll read), reached here via `fgPlayer.CombatState`
      // rather than a bare `CombatState` — bare `CombatState` is only a
      // real instance member on CardModel/PowerModel, not RelicModel (a
      // round 24 assumption that Tyler's first real `dotnet build` proved
      // wrong for relics — see resolvePlayerExpr's own comment for the full
      // evidence trail; fixed round 25, 2026-09-01). It properly creates
      // and registers a brand-new card instance for combat from a canonical
      // model reference — the SAME `ModelDb.Card<T>()` pattern this file
      // already uses elsewhere for real, confirmed codegen (starting
      // deck/relics — see generateProject's cardClassById/
      // generateAllCardsExprs).
      // `CardPileCmd.AddGeneratedCardToCombat(CardModel, PileType, Player,
      // CardPilePosition) : Task<CardPileAddResult>` then places it — a
      // real method dedicated to exactly this "generate a card mid-combat"
      // case (as opposed to `Add(...)`, which is for a card already in a
      // pile changing piles). PileType/CardPilePosition enum values
      // confirmed via direct sts2.dll Field/Constant reads this round.
      //
      // "The vanilla status cards" (VANILLA_TOKEN_CARDS, Tyler's own
      // best-effort guess list) now has real confirmed class names for 10
      // of its 11 entries — see VANILLA_TOKEN_CARD_CLASS_MAP below.
      // "Parasite" has no matching MegaCrit.Sts2.Core.Models.Cards.* class
      // (only a Monster class, PhrogParasite, shares the name fragment)
      // and stays an honest stub until a real class name turns up. The
      // user's own token cards (tokenRefKind: 'custom') resolve via the
      // same `cardClassById` map real starting-deck/relic codegen already
      // uses.
      //
      // Position is Forge's own authoring choice, not reflected evidence:
      // DrawPile uses Random (matching ShuffleCardIntoDraw's own "shuffle
      // in" semantics for this same pile below); Hand/Discard use Top (the
      // only sensible constant for piles without a "shuffle" framing).
      // Player resolution uses resolvePlayerExpr(ctx) — see its own
      // comment (this action isn't restricted to cardPlayBound contexts).
      const dest = ['Hand', 'DrawPile', 'Discard'].includes(action.destination) ? action.destination : 'Hand';
      const PILE_TYPE_BY_DEST = { Hand: 'Hand', DrawPile: 'Draw', Discard: 'Discard' };
      const POSITION_BY_DEST = { Hand: 'Top', DrawPile: 'Random', Discard: 'Top' };
      const which = action.tokenRefKind === 'vanilla'
        ? `vanilla:${action.tokenVanillaRef || '?'}`
        : `card:${action.tokenRef || '?'}`;
      let canonicalExpr = null;
      if (action.tokenRefKind === 'vanilla') {
        const realClass = VANILLA_TOKEN_CARD_CLASS_MAP[action.tokenVanillaRef];
        if (realClass) canonicalExpr = `MegaCrit.Sts2.Core.Models.ModelDb.Card<${realClass}>()`;
      } else {
        const cls = ctx.cardClassById && ctx.cardClassById.get(action.tokenRef);
        if (cls) canonicalExpr = `MegaCrit.Sts2.Core.Models.ModelDb.Card<${cls}>()`;
      }
      if (!canonicalExpr) {
        return `        ForgeActions.Todo("CreateCard ${describeAmountForStub(action)}x ${which} -> ${dest}"); // [UNVERIFIED] no real class name confirmed for this specific card reference — see compiler.js's own comment on this case`;
      }
      const playerExpr = resolvePlayerExpr(ctx);
      const pileTypeExpr = `MegaCrit.Sts2.Core.Entities.Cards.PileType.${PILE_TYPE_BY_DEST[dest]}`;
      const positionExpr = `MegaCrit.Sts2.Core.Entities.Cards.CardPilePosition.${POSITION_BY_DEST[dest]}`;
      return [
        `        for (var fgCreateCardI = 0; fgCreateCardI < ${resolveAmountExpr(action)}; fgCreateCardI++)`,
        `        {`,
        `            var fgNewCard = fgPlayer.CombatState.CreateCard(${canonicalExpr}, ${playerExpr}); // [BEST EFFORT] see compiler.js's own comment on this case`,
        `            await MegaCrit.Sts2.Core.Commands.CardPileCmd.AddGeneratedCardToCombat(fgNewCard, ${pileTypeExpr}, ${playerExpr}, ${positionExpr}); // [BEST EFFORT]`,
        `        }`,
      ].join('\n');
    }
    case 'ShuffleCardIntoDraw':
      // [BEST EFFORT] upgraded round 24 (2026-08-30) — Tyler: "Shuffle card
      // into draw should instead be 'shuffle this card into your draw pile'
      // only allowing the card that is being played to go back into draw."
      // Confirmed this round: generateCardSource's generated class is
      // `sealed class {{className}} : CustomCardModel` (see Card.cs.
      // template) — `this` inside a card's own generated body IS literally
      // that CardModel instance. `CardPileCmd.Add(CardModel card, PileType
      // newPileType, CardPilePosition position, AbstractModel clonedBy,
      // bool skipVisuals) : Task<CardPileAddResult>` is real (direct
      // sts2.dll read); `CardPilePosition.Random` matches "shuffle."
      // ONLY real inside an actual card's own generated class — gated on
      // ctx.thisIsCard (true only for a card's own OnPlay/OnAnyCardPlayed
      // body — see cascadingTriggerBody's own comment) rather than
      // ctx.cardPlayBound, since OnAnyCardPlayed is ALSO reachable from a
      // relic/mechanic hook (TRIGGER_HOOKS' OnAnyCardPlayed entry), where
      // `this` is a RelicModel/PowerModel, not the played card at all —
      // that combination stays an honest stub.
      return ctx.thisIsCard
        ? `        await MegaCrit.Sts2.Core.Commands.CardPileCmd.Add(this, MegaCrit.Sts2.Core.Entities.Cards.PileType.Draw, MegaCrit.Sts2.Core.Entities.Cards.CardPilePosition.Random, null, false); // [BEST EFFORT] see compiler.js's own comment on this case`
        : `        ForgeActions.Todo("ShuffleCardIntoDraw (this card only)"); // [UNVERIFIED] real CardPileCmd.Add(...) exists but \`this\` isn't a CardModel at this specific hook (not authored on a card's own OnPlay/OnAnyCardPlayed) — see compiler.js's own comment on this case`;
    case 'ReturnToHand': {
      // [Round 155] Tyler: "add a 'return this card to hand' effect for
      // the pile triggers that arent in hand. There should also be a
      // check box to 'retain the card this turn' if the return to hand
      // is selected." Same real CardPileCmd.Add(CardModel, PileType,
      // CardPilePosition, AbstractModel, bool) call ShuffleCardIntoDraw
      // uses immediately above — same ctx.thisIsCard gate (this action
      // only ever appears inside a card's own "While in a pile" trigger
      // body — see frontend's returnToHandEligibleNow()/
      // hiddenActionTypesForTrigger, and validate.js's matching hard
      // rejection outside that context — so `this` is always the
      // CardModel there, exactly like ShuffleCardIntoDraw). PileType.Hand
      // + CardPilePosition.Top mirrors CreateCard's own
      // POSITION_BY_DEST.Hand mapping above.
      //
      // action.retainThisTurn (the companion checkbox) — [VERIFIED via
      // direct sts2.dll IL read] CardModel.GiveSingleTurnRetain() is a
      // real, public, parameterless instance method; its IL body is
      // exactly `ldarg.0; ldc.i4.1; call set_HasSingleTurnRetain; ret`,
      // and CardModel.ShouldRetainThisTurn's own getter reads that same
      // private flag back (`get_Keywords().Contains(<Retain keyword
      // enum>) ? true : get_HasSingleTurnRetain()`) — i.e. a genuine,
      // real one-turn-only version of the static Retain keyword, not an
      // invented stand-in.
      if (!ctx.thisIsCard) {
        return `        ForgeActions.Todo("ReturnToHand (this card only)"); // [UNVERIFIED] real CardPileCmd.Add(...) exists but \`this\` isn't a CardModel at this specific hook (not authored on a card's own "While in a pile" body) — see compiler.js's own comment on this case`;
      }
      const lines = [
        `        await MegaCrit.Sts2.Core.Commands.CardPileCmd.Add(this, MegaCrit.Sts2.Core.Entities.Cards.PileType.Hand, MegaCrit.Sts2.Core.Entities.Cards.CardPilePosition.Top, null, false); // [BEST EFFORT] see compiler.js's own comment on this case`,
      ];
      if (action.retainThisTurn) {
        lines.push(`        this.GiveSingleTurnRetain(); // [VERIFIED via direct sts2.dll IL read] see compiler.js's own comment on this case`);
      }
      return lines.join('\n');
    }
    case 'StunEnemy': {
      // [VERIFIED via decompiling Tyler's own TheBurdenedNewCharacter.dll —
      // same evidentiary tier as CardsPlayedThisTurn (Eternal) and hitCount
      // (Retaliation) above, both confirmed the identical way: real,
      // compiled, working-mod IL, not reflection alone] — 2026-08-26, Tyler
      // pointed at a THIRD card in that same DLL: "Flick" ("it deals damage
      // and then stuns the enemy if that damage broke their block"). Its
      // OnPlay compiles down to an async state machine (<OnPlay>d__7.
      // MoveNext); hand-decoding that IL (via this repo's sandbox-local
      // ecma335.py/ildecode.py, not reflect-baselib — no dotnet needed for
      // reading an ALREADY-COMPILED mod DLL) shows the exact real call this
      // round 15b left unresolved:
      //   var target = cardPlay.Target ?? CombatState.HittableEnemies.FirstOrDefault();
      //   if (target != null) await CreatureCmd.Stun(target, null);
      // This directly closes round 15b's access-level gap — a call to
      // `MegaCrit.Sts2.Core.Commands.CreatureCmd.Stun(Creature creature,
      // string nextMoveId)` sitting in Flick's own compiled IL, callable
      // from an entirely separate mod assembly, is only possible if that
      // method is actually public — no CS0122 was thrown at Tyler's own
      // build time, which is stronger proof than any reflection AccessString
      // dump could give (see this project's "real compiled mod > reflection
      // guess" principle). Return type is real `Task` too (proven by the
      // `GetAwaiter`/`TaskAwaiter.GetResult()` pair immediately following
      // the call in Flick's IL) — awaited here unconditionally, same as
      // DealDamage above; every trigger hook this can be emitted inside is
      // itself `async Task` (see TRIGGER_HOOKS/generateRelicHooks), so this
      // needs no ctx.cardPlayBound branching the way EndTurn's
      // `cardPlay.Player` dependency did. `nextMoveId` is passed `null` —
      // mirroring Flick's own real call exactly rather than inventing a
      // value for a parameter whose semantics are still otherwise
      // unconfirmed (see the retired comment this replaced, on
      // `stunnedMoveId`-style monster-AI fields — that uncertainty is now
      // moot: `null` is a real, proven-compiling argument for it).
      // `targetExpr` here is Forge's OWN target resolution (SingleEnemy ->
      // `fgTarget!`), not Flick's own fallback-to-HittableEnemies chain —
      // StunEnemy already has its own user-chosen target field, so there's
      // no need to replicate Flick's null-coalescing fallback.
      //
      // 2026-08-26 follow-up: Tyler gave direct access to the uncompiled
      // C# source for this same mod (plus BaseLib's own GitHub repo) —
      // Flick's real source shows `await CreatureCmd.Stun(_stunTarget);`,
      // ONE argument, confirming `nextMoveId` is genuinely optional
      // (defaults to null when omitted) rather than us guessing that null
      // was merely an acceptable value. Our hand-decoded IL read from the
      // previous round was accurate — this is a nice independent sanity
      // check on this project's IL-reading methodology, not just new
      // evidence about Stun itself.
      return `        await MegaCrit.Sts2.Core.Commands.CreatureCmd.Stun(${targetExpr}, null); // [VERIFIED via decompiling TheBurdenedNewCharacter.dll's "Flick", confirmed against its real uncompiled source — see compiler.js's own comment on this case]`;
    }
    case 'EndTurn':
      // [VERIFIED] upgraded 2026-08-26 — Tyler gave direct access to
      // BaseLib's own GitHub source AND the uncompiled C# for
      // TheBurdenedNewCharacter (same mod as the Flick/StunEnemy find
      // above). A real card in that mod's Power classes calls
      // `PlayerCmd.EndTurn(base.Owner.Player, false)` — 2 args only,
      // confirming `actionDuringEnemyTurn` is an optional param (defaults
      // when omitted) the same way StunEnemy's `nextMoveId` turned out to
      // be. That's a genuine working call site, not just a reflected
      // signature, so this moves from [BEST EFFORT] to [VERIFIED] — same
      // tier as GainBlock. Simplified to the confirmed 2-arg form (dropped
      // the 3rd `null` this used to pass explicitly — semantically
      // identical, since C# fills an omitted optional param with the same
      // default either way, but matching the real call exactly is
      // stronger evidence than an equivalent-but-unproven 3-arg form).
      // `cardPlay.Player` ([VERIFIED] round 5) is the real, in-scope local
      // wherever `ctx.cardPlayBound` is true (OnPlay itself, and the
      // OnAnyCardPlayed hook). `canBackOut: false` (a card-forced end turn
      // shouldn't offer an undo) is Forge's own authoring choice, not a
      // reflected value.
      //
      // Non-cardPlayBound fallback upgraded round 24 (2026-08-30) — used to
      // stay a stub ("no real cardPlay.Player is in scope"). resolvePlayerExpr
      // closes that gap the same way it does for GainEnergy/ModifyGold
      // above — see its own comment for the full reasoning. Upgraded again
      // round 26 (2026-09-01): the fallback now emits `fgPlayer.Player`,
      // which — unlike round 24/25's `CombatState.Players.FirstOrDefault()`
      // — is the SAME shape as the real `base.Owner.Player` call cited
      // just above (Owner and fgPlayer are both real `Creature` locals;
      // `.Player` is the confirmed real hop from either one), not just an
      // equivalent-but-different guess. See resolvePlayerExpr's own comment
      // for the full round 26 evidence trail.
      return `        MegaCrit.Sts2.Core.Commands.PlayerCmd.EndTurn(${resolvePlayerExpr(ctx)}, false); // ${ctx.cardPlayBound ? '[VERIFIED via decompiling TheBurdenedNewCharacter.dll' : '[VERIFIED via decompiling TheBurdenedNewCharacter.dll — fgPlayer.Player matches the real base.Owner.Player call above'} — see compiler.js's own comment on this case]`;
    case 'ModifyOrbSlots': {
      // [Round 59 — VERIFIED via decompiling TheBurdenedNewCharacter.dll v3's
      // "Orbit" card ("Summon a Moon orb" — its gainOrbSlots effect), PLUS a
      // direct sts2.dll read confirming the exact real signature]
      // MegaCrit.Sts2.Core.Commands.OrbCmd.AddSlots(Player player, int amount)
      // is real, public, static (sts2.dll flags=0x96) — the real card calls
      // it as `OrbCmd.AddSlots(this.Owner, 1)` guarded by an
      // "orbSlotsAtLeast, negate:true" condition (not modeled here — Forge
      // doesn't stop the player from calling this past their real cap;
      // AddSlots itself clamps internally, same trust level as every other
      // real ForgeActions-adjacent call in this file). Real via
      // resolvePlayerExpr(ctx) on every trigger, same as GainEnergy/ModifyGold.
      //
      // [Round 160] "GainOrbSlots" -> "ModifyOrbSlots" — Tyler: "can we
      // also do a modify orb slots? for adding and removing", then picked
      // the mode-dropdown pattern (same choice applied to ModifyEnergy
      // above) over a sign-based amount. `OrbCmd.RemoveSlots(Player player,
      // int amount)` — [VERIFIED via direct sts2.dll IL read, round 160] —
      // is real, public, static, and is the exact structural mirror of
      // AddSlots (same "clamp against current capacity, then call
      // OrbQueue.RemoveCapacity" body shape), but its return type is
      // `void`, not `Task` — it's not async at all, unlike AddSlots (whose
      // Task return is likewise just `Task.CompletedTask` under a plain
      // synchronous body — neither method is a real async state machine,
      // both were disassembled directly with no state-machine lookup
      // needed). So Remove mode's call has no `await`, the one real
      // difference in shape from every sibling mode-dropdown case in this
      // file.
      const orbSlotsPlayerExpr = resolvePlayerExpr(ctx);
      return action.mode === 'Remove'
        ? `        MegaCrit.Sts2.Core.Commands.OrbCmd.RemoveSlots(${orbSlotsPlayerExpr}, ${resolveAmountExpr(action)}); // [VERIFIED via direct sts2.dll IL read, round 160] see compiler.js's own comment on this case`
        : `        await MegaCrit.Sts2.Core.Commands.OrbCmd.AddSlots(${orbSlotsPlayerExpr}, ${resolveAmountExpr(action)}); // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — "Orbit" card's gainOrbSlots effect, round 59]`;
    }
    case 'ModifyCost': {
      // [Round 193] Tyler: "instead of energy reduction while left in
      // hand ... can we add an effect to our existing effect list that
      // modifies the cost of the card?" -- replaces the enchantment
      // editor's old, never-compiled `whileInHand.energyReductionPerTurn`
      // freeform number field (removed this round, see
      // generateEnchantmentSource/newRichEnchantmentEntity) with a real
      // action any effect list can use. Reuses the EXACT same real,
      // [BEST EFFORT] CardEnergyCost.Add{Scope}(int amount, bool
      // reduceOnly) call costReductionTodoLines already emits for
      // card.advancedOptions.costReductions -- see that function's own
      // comment above for the full evidence trail (direct sts2.dll read
      // of CardEnergyCost's real 26-method table, cross-confirmed against
      // Enlightenment's real decompiled IL).
      //
      // Unlike costReductionTodoLines -- which generateCardSource ONLY
      // ever calls from a card's own generated class, so `this` is always
      // safe -- this action can be authored into ANY effect list (a
      // card's own effects/whileInHand, a relic/mechanic hook, an
      // enchantment's OnPlay), so it needs the same ctx.thisIsCard gate
      // ExhaustCard/DiscardCard/ReturnToHand/ShuffleCardIntoDraw already
      // use for the identical "acts on a specific CardModel" reason
      // (round 191's enchantment rewiring is what surfaced this whole
      // pattern). When !ctx.thisIsCard but ctx.cardPlayBound IS true (an
      // enchantment's OnPlay is exactly this case), this falls back to
      // `cardPlay.Card` -- the SAME confirmed-real CardModel reference
      // resolveDamageSourceArgs already uses for that exact situation,
      // and the same bare (no null-forgiving `!`) dereference pattern
      // conditionToCSharpRaw's PlayedCardHasType/Keyword/Tag cases already
      // use on `cardPlay.Card` -- rather than a blanket stub, since a real
      // card reference genuinely is available there. Only a relic/
      // mechanic hook with no cardPlay in scope at all falls back to an
      // honest Todo().
      const mcScope = action.scope === 'ThisTurnOrUntilPlayed' ? 'ThisTurnOrUntilPlayed' : 'ThisCombat';
      const mcIncrease = action.mode === 'Increase';
      const mcAmountExpr = resolveAmountExpr(action);
      const mcSignedAmountExpr = mcIncrease ? mcAmountExpr : `-(${mcAmountExpr})`;
      const mcReduceOnlyArg = mcIncrease ? 'false' : 'true';
      const mcEvidenceTag = mcIncrease
        ? `[BEST EFFORT, reduceOnly:false inferred — NOT independently confirmed by a decompiled sample, see compiler.js's costReductionTodoLines comment]`
        : `[BEST EFFORT]`;
      if (ctx.thisIsCard) {
        return `        this.EnergyCost.Add${mcScope}(${mcSignedAmountExpr}, ${mcReduceOnlyArg}); // ${mcEvidenceTag} see compiler.js's own comment on this case`;
      }
      if (ctx.cardPlayBound) {
        return `        cardPlay.Card.EnergyCost.Add${mcScope}(${mcSignedAmountExpr}, ${mcReduceOnlyArg}); // ${mcEvidenceTag} see compiler.js's own comment on this case`;
      }
      return `        ForgeActions.Todo("ModifyCost -- no CardModel reference in scope on this hook"); // [UNVERIFIED] see compiler.js's own comment on this case`;
    }
    // [Round 197] Tyler: "we also need to add effects to remove or
    // afflict cards" -- the "known gap" flagged in round 190
    // (generateEnchantmentSource) and round 196 (generateAfflictionSource):
    // "nothing in Forge can GRANT/APPLY this [enchantment/affliction] to a
    // card yet." Closed for real via CardCmd, reflected directly off
    // sts2.dll AND cross-confirmed against Tyler's own real, working "The
    // Burdened" project (FatiguePower.cs/Reckless.cs -- built with the
    // slay.spencerstiles.com reference tool, found under his connected
    // Animation folder):
    //   public static Task<T> Afflict<T>(CardModel card, decimal amount)
    //   public static void ClearAffliction(CardModel card)
    //   public static T Enchant<T>(CardModel card, decimal amount)  -- NOT
    //     async, unlike Afflict<T> -- confirmed by the raw method
    //     signature (no Task<> wrapper) via direct ECMA-335 read.
    //   public static void ClearEnchantment(CardModel card)
    // All four act on a specific CardModel, not a Creature -- same "acts
    // on THIS card, no target picker" shape as ModifyCost/ExhaustCard/
    // DiscardCard/ReturnToHand/ShuffleCardIntoDraw above, resolved via
    // resolveActedCardExpr(ctx) (see its own comment) rather than
    // repeating the inline ctx.thisIsCard/ctx.cardPlayBound check by hand
    // -- that helper also covers a case those four never needed: an
    // Affliction's own OnPlay, where `this.Card` is the real,
    // [VERIFIED] way to reach "the card this affliction is on" (there's
    // no CardPlay object in scope there at all -- see
    // generateAfflictionSource's onPlayCtx, which sets
    // affectedCardIsThisCard: true).
    case 'AfflictCard': {
      const acCardExpr = resolveActedCardExpr(ctx);
      if (!acCardExpr) return `        ForgeActions.Todo("AfflictCard -- no CardModel reference in scope on this hook"); // [UNVERIFIED] see compiler.js's own comment on this case`;
      const afflCls = ctx.afflictionClassById && ctx.afflictionClassById.get(action.afflictionRef);
      if (!afflCls) return `        ForgeActions.Todo("AfflictCard -- no affliction selected"); // pick an affliction in this action's own dropdown`;
      return `        await MegaCrit.Sts2.Core.Commands.CardCmd.Afflict<${afflCls}>(${acCardExpr}, (decimal)(${resolveAmountExpr(action)})); // [VERIFIED via decompiling Tyler's own real "The Burdened" project, round 197 -- Powers/FatiguePower.cs's real, working "await CardCmd.Afflict<Reckless>(_ac, base.Amount * 1m)" call] CardCmd.Afflict<T>(CardModel, decimal) is real, public, static, generic, async -- it constructs/attaches the affliction itself, no ModelDb.Affliction<T>()/ToMutable() needed here.`;
    }
    case 'RemoveAffliction': {
      const raCardExpr = resolveActedCardExpr(ctx);
      if (!raCardExpr) return `        ForgeActions.Todo("RemoveAffliction -- no CardModel reference in scope on this hook"); // [UNVERIFIED] see compiler.js's own comment on this case`;
      return `        MegaCrit.Sts2.Core.Commands.CardCmd.ClearAffliction(${raCardExpr}); // [VERIFIED via decompiling Tyler's own real "The Burdened" project, round 197 -- Afflictions/Reckless.cs's real, working "CardCmd.ClearAffliction(_ac)" call] CardCmd.ClearAffliction(CardModel) is real, public, static, and synchronous (no Task/await, unlike Afflict<T>). Clears whatever affliction the card currently has -- a card only ever carries one, so this isn't per-affliction-type.`;
    }
    case 'EnchantCard': {
      const ecCardExpr = resolveActedCardExpr(ctx);
      if (!ecCardExpr) return `        ForgeActions.Todo("EnchantCard -- no CardModel reference in scope on this hook"); // [UNVERIFIED] see compiler.js's own comment on this case`;
      const enchCls = ctx.enchantmentClassById && ctx.enchantmentClassById.get(action.enchantmentRef);
      if (!enchCls) return `        ForgeActions.Todo("EnchantCard -- no enchantment selected"); // pick an enchantment in this action's own dropdown`;
      return `        MegaCrit.Sts2.Core.Commands.CardCmd.Enchant<${enchCls}>(${ecCardExpr}, (decimal)(${resolveAmountExpr(action)})); // [VERIFIED via direct ECMA-335 metadata read of MegaCrit.Sts2.Core.Commands.CardCmd, round 197] CardCmd.Enchant<T>(CardModel, decimal) is real, public, static, generic -- genuinely NOT async (returns T directly, no Task<> wrapper in its real signature), unlike CardCmd.Afflict<T> right above, so this call has no await.`;
    }
    case 'RemoveEnchantment': {
      const reCardExpr = resolveActedCardExpr(ctx);
      if (!reCardExpr) return `        ForgeActions.Todo("RemoveEnchantment -- no CardModel reference in scope on this hook"); // [UNVERIFIED] see compiler.js's own comment on this case`;
      return `        MegaCrit.Sts2.Core.Commands.CardCmd.ClearEnchantment(${reCardExpr}); // [VERIFIED via direct ECMA-335 metadata read of MegaCrit.Sts2.Core.Commands.CardCmd, round 197] CardCmd.ClearEnchantment(CardModel) is real, public, static, synchronous. Clears whatever enchantment the card currently has -- a card only ever carries one.`;
    }
    // [Round 199 -- "build out the full affliction section"] Directly
    // evidenced by Afflictions/Reckless.cs's own real, working OnPlay body
    // (Tyler's real "The Burdened" project, rounds 197-199's reference):
    // it clears its OWN affliction type from every OTHER card in hand via
    // `PileType.Hand.GetPile(_affOwner).Cards.Where(_c => _c.Affliction is
    // global::...Reckless).ToList()` then `CardCmd.ClearAffliction(_ac)`
    // per match -- a self-limiting "only one of me active at a time" rule.
    // Generalized here beyond hand-only/self-only: any pile
    // (PileTypeExtensions.GetPile/CardPile.Cards -- both [VERIFIED], see
    // resolveRandomCardPickAndAct's own comment for the same real access
    // pattern), and any afflictionRef (not just "this affliction"), so a
    // relic/mechanic/card can use it too, not only an affliction acting on
    // itself. `.ToList()` snapshots the pile before mutating it, matching
    // Reckless.cs's own real defensive copy. No CardModel needed in scope
    // at all -- only a real Player (via resolvePlayerExpr) to find the
    // pile's owner -- so this never falls back to Todo() for lack of a
    // CardModel the way the four actions above can.
    case 'ClearAfflictionFromPile': {
      const cafpAfflCls = ctx.afflictionClassById && ctx.afflictionClassById.get(action.afflictionRef);
      if (!cafpAfflCls) return `        ForgeActions.Todo("ClearAfflictionFromPile -- no affliction selected"); // pick an affliction in this action's own dropdown`;
      const cafpPileExpr = pileTypeExpr(action.pile);
      const cafpOwnerExpr = resolvePlayerExpr(ctx);
      return `        foreach (CardModel fgAflC in MegaCrit.Sts2.Core.Entities.Cards.PileTypeExtensions.GetPile(${cafpPileExpr}, ${cafpOwnerExpr}).Cards.Where(_c => _c.Affliction is ${cafpAfflCls}).ToList()) // [VERIFIED via decompiling Tyler's own real "The Burdened" project, round 199 -- Afflictions/Reckless.cs's real, working PileType.Hand.GetPile(...).Cards.Where(_c => _c.Affliction is ...).ToList() pattern]
        {
            MegaCrit.Sts2.Core.Commands.CardCmd.ClearAffliction(fgAflC);
        }`;
    }
    // [2026-09-23] Tyler pointed at a relic from a different, unrelated
    // STS2 character-creator tool ("Test Relic") that swaps a player's
    // Draw and Discard piles. No dedicated "swap" API exists in sts2.dll
    // -- composited from two independently-[VERIFIED] real primitives
    // already used elsewhere in this file: PileTypeExtensions.GetPile(
    // PileType, Player).Cards (real, public -- see ClearAfflictionFromPile's
    // own case above) and CardPileCmd.Add(CardModel, PileType,
    // CardPilePosition, AbstractModel, bool) (real, public, static -- the
    // same call ShuffleCardIntoDraw/ReturnToHand already use). Both piles
    // are snapshotted into a .ToList() first (same defensive-copy
    // reasoning ClearAfflictionFromPile uses) before either loop starts
    // mutating them, so moving Draw's cards into Discard doesn't also
    // sweep up the cards Discard just received. [BEST EFFORT] -- no single
    // decompiled example of a "swap both piles" relic exists to confirm
    // this exact composition end-to-end, but every individual call in it
    // is independently real.
    case 'SwapDrawDiscard': {
      const sddPlayerExpr = resolvePlayerExpr(ctx);
      return `        var fgSwapDraw = MegaCrit.Sts2.Core.Entities.Cards.PileTypeExtensions.GetPile(MegaCrit.Sts2.Core.Entities.Cards.PileType.Draw, ${sddPlayerExpr}).Cards.ToList();
        var fgSwapDiscard = MegaCrit.Sts2.Core.Entities.Cards.PileTypeExtensions.GetPile(MegaCrit.Sts2.Core.Entities.Cards.PileType.Discard, ${sddPlayerExpr}).Cards.ToList();
        foreach (CardModel fgSwapC in fgSwapDraw) { await MegaCrit.Sts2.Core.Commands.CardPileCmd.Add(fgSwapC, MegaCrit.Sts2.Core.Entities.Cards.PileType.Discard, MegaCrit.Sts2.Core.Entities.Cards.CardPilePosition.Random, null, false); }
        foreach (CardModel fgSwapC in fgSwapDiscard) { await MegaCrit.Sts2.Core.Commands.CardPileCmd.Add(fgSwapC, MegaCrit.Sts2.Core.Entities.Cards.PileType.Draw, MegaCrit.Sts2.Core.Entities.Cards.CardPilePosition.Random, null, false); } // [BEST EFFORT] see compiler.js's own comment on this case`;
    }
    // [2026-09-23] Same "Test Relic" reference -- its deckCardsBecome
    // passive modifier transforms deck cards into a different specific
    // card. Reuses MegaCrit.Sts2.Core.Commands.CardCmd.Transform(CardModel
    // original, CardModel replacement, CardPreviewStyle style) --
    // ALREADY [VERIFIED]/real (Task<CardPileAddResult?>, confirmed via
    // direct sts2.dll read this round), the exact same call
    // generateTransformUpgradeMethod above uses for transformOnUpgrade --
    // extended here to a relic/mechanic-triggered loop over every
    // matching card sitting in the player's real Deck pile, instead of a
    // card transforming only itself. CardModel.IsTransformable --
    // disassembled directly this round (`IsRemovable || (Pile != null &&
    // Pile.Type == PileType.Deck)`) -- confirms Transform is safe on ANY
    // card sitting in Deck, unconditionally, not just during a rest-site
    // upgrade flow, closing the one open question transformOnUpgrade's
    // own comment had left open. Unlike that synchronous OnUpgrade
    // context, this action lives inside an async hook/effect body, so
    // (unlike transformOnUpgrade's fire-and-forget `_ = ...`) the real
    // Task IS awaited here. [BEST EFFORT] -- no decompiled example of a
    // RELIC (as opposed to a card upgrading itself) calling Transform
    // exists yet, but every individual piece is independently real.
    case 'TransformDeckCards': {
      const tdcSourceCls = ctx.cardClassById && ctx.cardClassById.get(action.sourceCardRef);
      const tdcTargetCls = ctx.cardClassById && ctx.cardClassById.get(action.becomesCardId);
      if (!tdcSourceCls || !tdcTargetCls) return `        ForgeActions.Todo("TransformDeckCards -- pick both a source and a target card"); // pick both cards in this action's own dropdowns`;
      const tdcPlayerExpr = resolvePlayerExpr(ctx);
      return `        foreach (CardModel fgTransC in MegaCrit.Sts2.Core.Entities.Cards.PileTypeExtensions.GetPile(MegaCrit.Sts2.Core.Entities.Cards.PileType.Deck, ${tdcPlayerExpr}).Cards.Where(_c => _c is ${tdcSourceCls}).ToList()) // [BEST EFFORT] see compiler.js's own comment on this case
        {
            await MegaCrit.Sts2.Core.Commands.CardCmd.Transform(fgTransC, new ${tdcTargetCls}(), MegaCrit.Sts2.Core.Nodes.CommonUi.CardPreviewStyle.None);
        }`;
    }
    default:
      throw new Error(`No C# mapping registered for action type "${action.type}". Add one in compiler.js:actionToCSharp before this card can compile.`);
  }
}

// [Round 197] Resolves "the CardModel this action acts on" for the four
// CardModel-scoped actions right above (AfflictCard/RemoveAffliction/
// EnchantCard/RemoveEnchantment), none of which have a separate target
// picker. Same three-way fallback ModifyCost/ExhaustCard/DiscardCard/
// ReturnToHand/ShuffleCardIntoDraw already use inline (ctx.thisIsCard ->
// `this`, ctx.cardPlayBound -> `cardPlay.Card`), PLUS a third case those
// five never needed: ctx.affectedCardIsThisCard, set only by
// generateAfflictionSource's onPlayCtx -- an Affliction's own OnPlay has
// NO CardPlay object in scope at all (AfflictionModel.OnPlay's real
// signature takes a raw Creature, not a CardPlay -- see that function's
// own header comment), but `this.Card` is a real, [VERIFIED]
// AfflictionModel property pointing at exactly the card this affliction
// is attached to. Returns null when none of the three apply -- callers
// fall back to an honest Todo().
function resolveActedCardExpr(ctx) {
  if (ctx.thisIsCard) return 'this';
  if (ctx.cardPlayBound) return 'cardPlay.Card';
  if (ctx.affectedCardIsThisCard) return 'this.Card';
  return null;
}

// --- card keywords (Exhaust/Ethereal/Innate/Retain/Unplayable/Sly/Eternal) --
// [VERIFIED via reflect-baselib round 2] `AddKeyword(CardKeyword keyword)`
// is a real, concrete, public instance method on CardModel with exactly
// this signature. [VERIFIED via reflect-baselib round 1] CardKeyword's
// real members are exactly None/Exhaust/Ethereal/Innate/Unplayable/Retain/
// Sly/Eternal — all 7 non-None values are wired here now (previously only
// Exhaust/Innate/Ethereal had frontend checkboxes; Tyler asked for the
// rest, and reflection had already confirmed the other 4 existed, just
// unused).
//
// This is also the answer to two of Tyler's three requested new card
// TRIGGERS ("when discarded" / "when retained"), without adding any new
// trigger at all:
//   - "When discarded" is CardKeyword.Sly, not a new hook. Per community
//     wiki/guide docs (not reflection — reflection only confirms the enum
//     member NAME exists, not its behavior): "if this card is discarded
//     during your turn, it immediately plays for free." So a Sly card's
//     existing OnPlay effect block already fires on discard, for real, via
//     the game's own keyword system — no per-card discard hook needed.
//   - "When retained" (a bonus effect specifically when the card IS
//     retained, on top of Retain just keeping it in hand) is NOT covered
//     by any confirmed real mechanism. Every reflect-baselib round so far
//     (1 through 8) has only ever confirmed OnPlay + OnUpgrade as
//     CustomCardModel's real overridable surface, plus this AddKeyword
//     call — nothing hook-shaped. Notably, round 2's own CustomCardModel
//     scan only searched for *Play*/*Keyword*/*Upgrade* substrings; it
//     never ran the same broad "every After*/On*/Before* member" sweep it
//     ran on CustomRelicModel. A reflect-baselib round 9 addition
//     (queued, see tools/reflect-baselib/Program.cs) closes exactly that
//     gap — if it turns up something like AfterCardRetained, this can be
//     wired up for real next round instead of guessed at now.
//   - "While in discard" (a passive effect while just sitting in the
//     discard pile) has no evidence at all in any reflect-baselib round or
//     community source — not implemented, not queued as a specific search
//     either, since there's not even a plausible real method name to look
//     for yet.
// [CORRECTED, Round 28 ground-up audit — real in-game crash evidence]
// This used to emit `AddKeyword(CardKeyword.X)` calls directly inside the
// card's constructor. That's wrong: a real Tyler playtest threw
// `MegaCrit.Sts2.Core.Models.Exceptions.CanonicalModelException:
// Canonical model of type TestChar.Cards.StressTestCard used in incorrect
// place` from inside `AbstractModel.AssertMutable()`, called by
// `CardModel.AddKeyword`, called by the card's own `.ctor()` — thrown
// during the game's own `ModelDb.Init_Patch9` canonical-model registration
// pass at startup (essential game init, not scoped to just this card/mod).
// AddKeyword mutates a LIVE card instance; it isn't valid on the read-only
// canonical template being constructed at that point.
//
// The real mechanism was already known and documented in this exact file
// since round 10 (used as the confirmed-real evidence anchor when
// generateCanonicalTagsOverride was built — see its own comment: "same
// override shape as the already-real CanonicalKeywords") but never
// actually wired up for keywords themselves until now:
// `CardModel.CanonicalKeywords` is a real, confirmed (direct sts2.dll
// metadata read) `public virtual IEnumerable<CardKeyword>` property —
// override it declaratively, exactly like CanonicalTags/CanonicalVars,
// instead of mutating in the constructor. Emits nothing (falls back to
// the base class's own default, empty CanonicalKeywords) when a card has
// no keywords set — same "no override needed for the default case"
// pattern generateCanonicalTagsOverride/generateUpgradeMethod already use.
function generateCanonicalKeywordsOverride(card) {
  const keywords = Array.isArray(card.keywords) ? card.keywords : [];
  if (!keywords.length) return '';
  const items = keywords.map(kw => keywordExpr(kw)).join(', ');
  return `
    // [VERIFIED via direct sts2.dll metadata read + a real in-game crash
    // that proved the old AddKeyword-in-constructor approach wrong — see
    // this function's own header comment and TOOLCHAIN_FINDINGS.md]
    public override IEnumerable<CardKeyword> CanonicalKeywords => new[] { ${items} };`;
}

// card.costsX (Tyler's X-cost ask). Emits nothing when unset — the real
// base CardModel.HasEnergyCostX is a virtual property with a default
// (false) implementation, CONFIRMED not abstract: a DIFFERENT real card
// in TheBurdenedNewCharacter.dll (CostOfGlory) compiles/works fine
// without overriding it at all, while Retaliation (the real X-cost card
// in the same mod) overrides it to return true — same "no override
// needed for the default case" pattern generateStarCostAssign/
// generateCanonicalTagsOverride already use. [VERIFIED via decompiling
// TheBurdenedNewCharacter.dll] — see schema's card.costsX description
// for the full trail. backend/validate.js enforces card.cost === 0
// whenever this is true, matching the one real confirmed example.
function generateHasEnergyCostXOverride(card) {
  if (!card.costsX) return '';
  return `
    // [VERIFIED via decompiling Tyler's own TheBurdenedNewCharacter.dll]
    // real protected virtual bool getter on CardModel; overridden exactly
    // like this by Retaliation, a real working X-cost card in that mod.
    // This is what makes ResolveEnergyXValue() (used below by any
    // amountIsX/hitCountIsX action) return something meaningful.
    protected override bool HasEnergyCostX => true;
`;
}

// card.costsStarX (Tyler, round 71: "i want to make an x star cost check
// box next to the existing x cost button on cards"). [VERIFIED via
// decompiling Tyler's own updated TheBurdenedNewCharacter.dll, round 73]
// Round 71 shipped this as [BEST EFFORT] — CardModel.HasStarCostX was a
// real member (reflect-baselib's CardModel dump) with no confirmed real
// override. Round 73: Tyler uploaded a new build containing a real card,
// "X Star" (TheBurdenedNewCharacter.Cards.XStar), whose decompiled
// get_HasStarCostX body is exactly `ldc.i4.1; ret` — a real card
// genuinely overriding this to true. Same evidentiary tier as
// HasEnergyCostX now.
//
// That same card's real OnPlay (see round 73's own project doc for the
// full IL trail) also confirmed `CardModel.ResolveStarXValue()` — a real,
// concrete, zero-arg instance method returning the resolved star-X value,
// the direct star-cost counterpart of ResolveEnergyXValue() — used to
// scale an AttackCommand's damage AMOUNT (not hit count; XStar uses
// ResolveEnergyXValue() for hit count instead, on a SEPARATE second
// attack). [Round 74] Now wired in for real — see RESOLVE_STAR_X_EXPR
// and actionsArray's new amountIsStarX field (resolveAmountExpr/
// resolveStatusEntryAmountExpr above). No hitCountIsStarX — hit count
// scaling stays energy-only, matching what the real example actually
// demonstrates.
function generateHasStarCostXOverride(card) {
  if (!card.costsStarX) return '';
  return `
    // [VERIFIED via decompiling Tyler's own updated
    // TheBurdenedNewCharacter.dll, round 73 — "X Star" card's real
    // get_HasStarCostX overrides this exactly] Real protected virtual
    // bool getter on CardModel, same confirmation tier as
    // HasEnergyCostX above.
    protected override bool HasStarCostX => true;
`;
}

// Optional star cost (Tyler: "add optional star cost to cards..."). Emits
// nothing when card.starCost is unset — same "no override/statement needed
// for the default case" pattern generateCanonicalTagsOverride/
// generateUpgradeMethod already use.
//
// Kept as a constructor-body slot (no longer used) purely so
// Card.cs.template's {{starCostAssign}} placeholder still resolves to
// something without a template edit. The real work moved to
// generateCanonicalStarCostOverride below (round 59) — see that
// function's own comment for the full evidence trail.
function generateStarCostAssign(card) {
  return '        // star cost is set via the CanonicalStarCost override below, not here';
}

// [Round 59 — real, VERIFIED via decompiling Tyler's own
// "Star Cost Change" card in TheBurdenedNewCharacter.dll v3, PLUS a direct
// sts2.dll MethodDef.Flags read confirming access levels] Closes the gap
// generateStarCostAssign's old comment (2026-08-27) flagged as downgraded:
// CardModel.BaseStarCost's SETTER is real but genuinely `private`
// (sts2.dll: set_BaseStarCost flags=0x881, low 3 bits = 1 = Private) —
// that path was correctly abandoned. The real mechanism is a DIFFERENT
// member entirely: `CanonicalStarCost` is a real `public virtual int`
// getter (sts2.dll: get_CanonicalStarCost flags=0x9c6 — Public, Virtual,
// NewSlot, NOT Abstract, i.e. a normal overridable property with a
// default implementation) — Star Cost Change's own generated class
// overrides it with a single `return 3;` (its authored starCost), exactly
// the same "override a virtual getter" shape as HasEnergyCostX just above.
// This sets the card's INITIAL star cost for real. (See
// generateUpgradeMethod's own comment for the SEPARATE real mechanism —
// UpgradeStarCostBy — that now handles star cost CHANGING on upgrade.)
function generateCanonicalStarCostOverride(card) {
  // [Round 71] costsStarX means the star cost isn't a fixed number at
  // all — card.starCost is just locked to a placeholder 0 in the UI
  // while it's checked (same convention as card.cost/costsX). Emitting
  // "CanonicalStarCost => 0" here would be actively wrong, not just
  // unhelpful, so this treats costsStarX the same as fully-unset.
  if (card.costsStarX) return '';
  if (card.starCost === undefined || card.starCost === null) return '';
  return `
    // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — "Star Cost
    // Change" card, plus a direct sts2.dll read confirming CanonicalStarCost
    // is a real, public, overridable (non-abstract) virtual property —
    // see compiler.js's own comment on generateCanonicalStarCostOverride]
    public override int CanonicalStarCost => ${card.starCost};
`;
}

// Escapes a plain string for use inside a C# string literal (quotes and
// backslashes only — gameplay tags are validated to be short, plain text
// by backend/validate.js, but this is cheap insurance against a hand-built
// package containing a quote/backslash reaching generated code unescaped).
function csharpStringLiteral(str) {
  return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// TRUE custom tags (Generated/IForgeTaggedCard.cs.template — see that
// file's header for the full "why not BaseLib's real CardTag enum"
// reasoning). A SEPARATE field from card.tags (the pre-existing, purely
// organizational board-filter tags, which compile to nothing at all) —
// card.gameplayTags is what actually reaches generated code, as a plain
// C# string array initializer.
function generateGameplayTagsInit(card) {
  const tags = Array.isArray(card.gameplayTags) ? card.gameplayTags : [];
  return tags.map(csharpStringLiteral).join(', ');
}

// Real BaseLib CardTag (Tyler's item 15: "tag for if card is strike or
// defend") — NOT the same mechanism as generateGameplayTagsInit above. See
// schema/character.schema.json's card.baseCardTag description for the full
// evidence trail (reflect-baselib round 10: CardTag is a genuine closed
// enum with exactly 5 non-None members, and CanonicalTags is a confirmed
// real, overridable `protected virtual HashSet<CardTag>` property, same
// override shape as the already-real CanonicalKeywords). Emits nothing
// (falls back to the base class's own default, empty CanonicalTags) when
// baseCardTag is unset or "None" — same "no override needed for the
// default case" pattern generateUpgradeMethod already uses.
function generateCanonicalTagsOverride(card) {
  const tag = card.baseCardTag;
  if (!tag || tag === 'None') return '';
  return `
    // Real BaseLib MegaCrit.Sts2.Core.Entities.Cards.CardTag — [VERIFIED via
    // reflect-baselib round 10] CanonicalTags is a real, protected,
    // overridable property; CardTag.${tag} is one of its 5 real closed
    // members. This is what lets base-game/other-mod logic that checks
    // CardTag specifically (e.g. Strike-synergy relics) recognize this
    // card — see card.gameplayTags for Forge's OWN, separate tag system.
    protected override HashSet<CardTag> CanonicalTags => new HashSet<CardTag> { CardTag.${tag} };`;
}

// `ctx` (optional, default {}) threads context that a condition's codegen
// may need to know to stay compile-safe — today just `cardPlayBound`: is a
// real `cardPlay` (CardPlay) local actually in scope at this call site?
// TRUE for every card trigger that ever reaches this function (OnPlay,
// OnAnyCardPlayed — see cascadingTriggerBody, always called from a
// cardPlay-bound context) and for relics/mechanics' OnAnyCardPlayed hook
// (TRIGGER_HOOKS.OnAnyCardPlayed.cardPlayBound below); FALSE for the one
// other hook that gets a real (non-Todo) body, relics/mechanics'
// OnTakeDamage — its real params (target/dealer, both bare Creatures) have
// no CardPlay anywhere, so a condition that needs `cardPlay.Player...`
// would be a real CS0103 there if compiled the same way. See
// conditionToCSharp's EnergyRemaining/StarsRemaining cases.
function effectBlockToCSharp(effect, ctx = {}) {
  const lines = [];
  // elseActions — Tyler's "if X, deal 12, else deal 5" ask. Only ever
  // emitted alongside a real `if`, since an "else" with nothing to be the
  // opposite of is meaningless — backend/validate.js rejects a package
  // with elseActions but no conditions before this ever runs, so the
  // `effect.conditions.length` branch below is the only place this reads.
  const elseActions = Array.isArray(effect.elseActions) ? effect.elseActions : [];
  if (effect.conditions && effect.conditions.length) {
    const condExprs = effect.conditions.map(c => conditionToCSharp(c, ctx));
    lines.push(`        if (${condExprs.join(' && ')})`);
    lines.push(`        {`);
    // actionToCSharp() can now return MULTIPLE statement lines joined by
    // '\n' (one action, e.g. "apply Vulnerable + Weak", can emit several
    // ForgeActions calls — see the multi-select ApplyStatus/RemoveStatus/
    // ApplyCustomStatus/RemoveCustomStatus cases above), so every line of
    // its output needs the extra indent, not just the first.
    effect.actions.forEach(a => {
      const code = actionToCSharp(a, ctx);
      lines.push(code.split('\n').map(l => `    ${l}`).join('\n'));
    });
    lines.push(`        }`);
    if (elseActions.length) {
      lines.push(`        else`);
      lines.push(`        {`);
      elseActions.forEach(a => {
        const code = actionToCSharp(a, ctx);
        lines.push(code.split('\n').map(l => `    ${l}`).join('\n'));
      });
      lines.push(`        }`);
    }
  } else {
    effect.actions.forEach(a => lines.push(actionToCSharp(a, ctx)));
  }
  return lines.join('\n');
}

function effectsToCSharp(effects, ctx = {}) {
  return effects.map(effect => effectBlockToCSharp(effect, ctx)).join('\n');
}

// Resolves card.upgrades[] (which can contain `null` entries — a tier tab
// that exists but still "mirrors" the tier below it, per the frontend's own
// refreshTierChain()) into a fully-resolved list of real {costDelta,
// effects}, one per tier (index 0 = Card+ / CurrentUpgradeLevel 1, index 1
// = Card++ / level 2, ...). A `null` tier resolves to costDelta 0 (no
// change at that tier) and whatever effects the nearest tier below it (or
// the base card, for index 0) already resolved to — same semantics as the
// live editor, just re-derived here from the saved package.
function resolveUpgradeTiers(card) {
  if (!Array.isArray(card.upgrades)) return [];
  const resolved = [];
  let carryEffects = card.effects || [];
  for (const raw of card.upgrades) {
    if (raw) {
      resolved.push({ costDelta: raw.costDelta || 0, starCostDelta: raw.starCostDelta || 0, effects: raw.effects || [] });
      carryEffects = raw.effects || [];
    } else {
      resolved.push({ costDelta: 0, starCostDelta: 0, effects: carryEffects });
    }
  }
  return resolved;
}

// [Round 167] "currently we have different upgrade tiers for cards, but the
// creator should allow for one card to transform into another when
// upgraded. Like my stomp into earthquake card in theburdenednewcharacter."
// (Tyler). Direct decompilation of his own Stomp/Earthquake pair found NO
// code-level link between them (no OnUpgrade override on Stomp, no
// cross-references) — this is a genuinely new capability being added, not
// a reproduction of something already compiled in his mod. Mutually
// exclusive with card.upgrades[] (backend/validate.js enforces this): a
// transform swaps out the whole CardModel instance for a different one, so
// the tiered stat-delta system (which mutates THIS card across levels) has
// no meaning once the card has become a different card entirely.
//
// Full evidence trail, all gathered via direct sts2.dll IL reads this
// round (decompilation tooling at /tmp/claude-0/sts2tools_local/):
//
//   - `MegaCrit.Sts2.Core.Commands.CardCmd.Transform(CardModel original,
//     CardModel replacement, CardPreviewStyle style)` — [VERIFIED] real,
//     public, static, confirmed exact signature via ecma_dump.py.
//   - Its own IL constructs `new CardTransformation(original, replacement)`
//     internally (the 2-arg ctor, one of three real overloads) and calls
//     `.GetReplacement(rng)` on it. [VERIFIED via directly reading
//     CardTransformation.GetReplacement's IL] that method returns
//     `replacement` COMPLETELY UNCHANGED — no cloning at all — whenever a
//     specific replacement instance was supplied (only the OTHER two ctor
//     overloads, which take a pool of random options instead, route
//     through CardFactory.CreateRandomCardForTransform). So whatever
//     CardModel instance Forge hands in as `replacement` is exactly what
//     ends up in the pile.
//   - `CardModel.IsTransformable` — [VERIFIED via direct IL] real logic is
//     `IsRemovable || (Pile != null && Pile.Type == PileType.Deck)` (Deck
//     confirmed = enum value 6 via a direct Field/Constant metadata read).
//     Transform throws InvalidOperationException if this is false. A card
//     being upgraded at a rest site sits in the player's Deck pile, so
//     this is satisfied there regardless of IsRemovable.
//   - Transform's own real IL body: AssertMutable() on the original ->
//     IsTransformable check -> Pile null-check -> records the original's
//     index in its pile (to preserve position) -> RemoveFromCurrentPile on
//     the original -> AddInternal on the pile with the replacement at that
//     same recorded position -> AfterTransformedFrom() on the original /
//     AfterTransformedTo() on the replacement (both real, virtual,
//     overridable CardModel hooks, confirmed via ecma_dump.py).
//   - `new {{targetClass}}()` (this card class's own real public
//     parameterless constructor — every Forge-generated card already has
//     exactly this) builds a genuinely fresh, ordinary instance.
//     Deliberately NOT `MegaCrit.Sts2.Core.Models.ModelDb.Card<T>()` (the
//     pattern this file's own CreateCard action codegen uses elsewhere) —
//     that returns the game's single shared CANONICAL template instance
//     for that card type, used everywhere else as a read-only reference;
//     handing that same shared object into a live pile via Transform would
//     corrupt every other use of it. This reasoning leans on
//     Card.cs.template's own documented real crash (a real Tyler playtest
//     threw CanonicalModelException calling a mutating, AssertMutable()-
//     gated method from inside a card's OWN constructor, during the
//     engine's own canonical-registration startup pass) — [BEST EFFORT]:
//     no directly decompiled example of a card self-transforming this way
//     exists to confirm `new` vs `ModelDb.Card<T>()` against head-to-head,
//     but `new` is the only choice consistent with both confirmed facts
//     (Transform doesn't clone; the canonical singleton is shared/
//     read-only elsewhere).
//   - `OnUpgrade()` itself is [VERIFIED] synchronous (`family virtual
//     void`, confirmed via ecma_dump.py), called synchronously in the
//     middle of `CardModel.UpgradeInternal()` (confirmed via direct IL —
//     increments CurrentUpgradeLevel, calls OnUpgrade(), then recalculates
//     DynamicVars) — but `CardCmd.Transform` returns
//     `Task<CardPileAddResult?>`. A sync void method can't `await`, so
//     this fires it without awaiting (`_ = ...`, discarding the Task) —
//     the only way to bridge a sync override to an async API. By ordinary
//     C# async/await semantics, everything up to Transform's own first
//     `await` still runs synchronously on this exact call; the pile swap
//     itself (AssertMutable/IsTransformable/RemoveFromCurrentPile/
//     AddInternal above) isn't behind any `await` in the IL read this
//     round — only later visual/animation steps are. [BEST EFFORT] — no
//     real decompiled example of Transform being fired from a sync context
//     exists to confirm this exact composition end-to-end, but it's the
//     only C#-legal way to call it from here.
//   - `CardPreviewStyle.None` (0) — [VERIFIED] real enum value (direct
//     Field/Constant read), chosen as the least assumption-laden default —
//     no real example shows which style an upgrade-triggered transform
//     should use.
function generateTransformUpgradeMethod(card, refMaps) {
  const targetId = card.transformOnUpgrade.targetCardId;
  const cardClassById = refMaps && refMaps.cardClassById;
  const targetClass = cardClassById && cardClassById.get(targetId);
  if (!targetClass) {
    return `
    // Transform-on-upgrade target "${(targetId || '').replace(/"/g, '\\"')}" didn't resolve to a real card class — see compiler.js's own comment on generateTransformUpgradeMethod.
    public override int MaxUpgradeLevel => 1;

    protected override void OnUpgrade()
    {
        ForgeActions.Todo("Transform on upgrade -> unresolved card id \\"${(targetId || '').replace(/"/g, '\\\\"')}\\""); // [UNVERIFIED] no real class name confirmed for this transform target
    }`;
  }
  return `
    // MaxUpgradeLevel/OnUpgrade — same CONFIRMED-real hooks the tiered
    // upgrade system uses elsewhere in this file (CurrentUpgradeLevel/
    // MaxUpgradeLevel/OnUpgrade all real via reflect-baselib round 13).
    // This card has exactly ONE upgrade, which transforms it into a
    // different authored card rather than applying a stat delta — see
    // compiler.js's own comment on generateTransformUpgradeMethod for the
    // full CardCmd.Transform/CardTransformation/IsTransformable evidence
    // trail [round 167].
    public override int MaxUpgradeLevel => 1;

    protected override void OnUpgrade()
    {
        _ = MegaCrit.Sts2.Core.Commands.CardCmd.Transform(this, new ${targetClass}(), MegaCrit.Sts2.Core.Nodes.CommonUi.CardPreviewStyle.None); // [BEST EFFORT] see compiler.js's own comment on generateTransformUpgradeMethod for the full evidence trail — real Transform/IsTransformable/CardTransformation.GetReplacement mechanics confirmed via direct IL reads, but no real decompiled example of a card self-transforming on upgrade this way exists to confirm end-to-end
    }`;
}

// Builds one trigger's method body (OnPlay, OnDiscard, ...) as a
// CurrentUpgradeLevel-gated cascade — CurrentUpgradeLevel is CONFIRMED real
// via reflect-baselib round 13 (`CardModel.CurrentUpgradeLevel { get; set;
// }`, public, incremented by the engine itself each time it calls
// OnUpgrade()). Each tier's ALREADY-KNOWN full resolved action list for
// this trigger becomes its own `if (CurrentUpgradeLevel >= N)` branch,
// falling through to the base card's own effects at level 0. This is
// deliberately NOT trying to derive a numeric delta between two tiers' full
// action lists (unlike costDelta below) — actions can be added, removed,
// reordered, or swapped entirely between tiers, not just have one number
// change, and Forge doesn't route action amounts through
// CardModel.DynamicVars the way real sampled OnUpgrade() bodies do (see
// TOOLCHAIN_FINDINGS.md "reflect-baselib round 13") — so there's no safe
// way to compute one. Using each tier's full, already-authored resolved
// action list directly is correct by construction instead.
function cascadingTriggerBody(card, trigger, resolvedTiers, refMaps, ctxOverrides) {
  // Called for a trigger with a real `cardPlay` local in scope (OnPlay
  // itself, or a CARD_TRIGGER_HOOKS entry with fullCardPlayBinding) OR,
  // as of round 57, a CARD_TRIGGER_HOOKS entry with a real `playerExpr`
  // but NO cardPlay (OnDiscard/OnTurnEndInHand, bound via CardModel.Owner
  // instead — see PET_SUPPORTED_TRIGGERS' own comment for the evidence).
  // The 5th `ctxOverrides` param (optional, defaults to {}) lets that third
  // call site flip `cardPlayBound`/`targetMayBeNull` off without touching
  // the other two — every function this ctx flows into that emits a
  // `cardPlay`-referencing expression already gates on `ctx.cardPlayBound`
  // specifically (not `thisIsCard` — see resolveDamageSourceArgs' round-57
  // fix), so cardPlayBound:false correctly and safely downgrades every
  // such path to its existing honest non-cardPlay fallback (already
  // proven — that's the exact same fallback relics/mechanics use).
  // `refMaps` (added 2026-08-27, condition-kind expansion round) — carries
  // {cardClassById, relicClassById} down from generateProject() so
  // conditionToCSharp's HasSpecificRelic/NoCopiesOfCardInHand cases can
  // resolve a referenced card/relic id to its real generated class name,
  // the exact same map generateProject() already builds and uses for real,
  // confirmed ModelDb.Card<T>()/ModelDb.Relic<T>() codegen (starting
  // deck/relics) — reused here, not a new/guessed mechanism.
  // `thisIsCard: true` (added round 24, 2026-08-30) — distinct from
  // cardPlayBound: this function is ALWAYS generating a method body that
  // lives inside a card's own generated `CustomCardModel` subclass (see
  // this doc comment's own "always called for..." note above), so `this`
  // is genuinely that CardModel instance here — true even where
  // cardPlayBound alone wouldn't be enough evidence, since TRIGGER_HOOKS'
  // OnAnyCardPlayed entry (cardPlayBound: true) is ALSO reachable from a
  // relic/mechanic hook, where `this` is a RelicModel/PowerModel instead.
  // actionToCSharp's ShuffleCardIntoDraw case is the one consumer so far.
  // `fgPlayerBound: true` (added round 25, 2026-09-01) — Card.cs.template's
  // OnPlay (and this same function's own extraTriggerMethods
  // fullCardPlayBinding call site) unconditionally declares
  // `var fgPlayer = cardPlay.Player.Creature;` before this body runs — see
  // conditionToCSharp's CardsPlayedThisTurn/AttacksPlayedThisTurn cases for
  // the one consumer so far, and resolvePlayerExpr's comment for the
  // broader "fgPlayer is always bound" argument this flag makes explicit
  // rather than assumed per-call-site.
  const ctx = { cardPlayBound: true, thisIsCard: true, fgPlayerBound: true, targetMayBeNull: trigger === 'OnAnyCardPlayed', cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById, ...(ctxOverrides || {}) }; // targetMayBeNull [Fix, round 29] — this function also generates a card's OWN AfterCardPlayed override (CARD_TRIGGER_HOOKS.OnAnyCardPlayed's fullCardPlayBinding branch), reacting to ANY other card's play; cardPlay.Target is exactly as borrowed/nullable there as it is for a relic/mechanic hook — see TRIGGER_HOOKS.OnAnyCardPlayed's own comment. `trigger === 'OnPlay'` (this card's own play) stays false/unguarded: the base game itself only constructs a real cardPlay for a targeted card once a real target is chosen, so cardPlay.Target is safe there whenever this card's own `target` field calls for one.
  const baseEffects = (card.effects || []).filter(e => e.trigger === trigger);
  const baseBody = baseEffects.length ? effectsToCSharp(baseEffects, ctx) : null;
  if (!resolvedTiers.length) return baseBody;

  const tierBodies = resolvedTiers.map(t => {
    const effs = (t.effects || []).filter(e => e.trigger === trigger);
    return effs.length ? effectsToCSharp(effs, ctx) : null;
  });

  if (!baseBody && tierBodies.every(b => !b)) return null;

  const indent = s => s.split('\n').map(l => `    ${l}`).join('\n');
  let out = '';
  for (let i = tierBodies.length - 1; i >= 0; i--) {
    const kw = i === tierBodies.length - 1 ? 'if' : 'else if';
    out += `        ${kw} (CurrentUpgradeLevel >= ${i + 1})\n        {\n${indent(tierBodies[i] || '// no effects at this tier')}\n        }\n`;
  }
  out += `        else\n        {\n${indent(baseBody || '// no base effects defined')}\n        }`;
  return out;
}

function conditionToCSharpRaw(cond, ctx = {}) {
  const cmp = { lt: '<', lte: '<=', eq: '==', gte: '>=', gt: '>' }[cond.comparator];
  switch (cond.kind) {
    case 'HasStatusStacks': {
      // `cond.subject` (Self/CardTarget/Pet — see CONDITION_SUBJECTS and
      // resolveConditionSubjectExpr above) picks WHICH creature's stacks to
      // read — Tyler's "If <target> has <condition>" ask. Defaults to
      // 'Self' (fgPlayer) when absent, the only subject this condition
      // ever checked before this field existed.
      //
      // `cond.statusKind` ('vanilla' | 'custom', defaults to 'custom' —
      // the only kind this condition supported before Tyler's follow-up
      // "the condition that checks for statuses should work on both
      // vanilla as well as custom statuses. Currently it only works for
      // custom") picks which type argument ForgeActions.GetStatusStacks<T>
      // gets: a real built-in Powers class (from BUILTIN_POWER_CLASS_MAP,
      // the SAME map ApplyStatus/RemoveStatus actions already use — round
      // 8) for 'vanilla', or this character's own generated mechanic class
      // for 'custom' — mirrors the existing action-side
      // ApplyStatus/ApplyCustomStatus split rather than inventing a new
      // shape.
      const statusKind = cond.statusKind === 'vanilla' ? 'vanilla' : 'custom';
      const typeArg = statusKind === 'vanilla'
        ? BUILTIN_POWER_CLASS_MAP[cond.builtinStatus]
        : mechanicClassName(cond.statusRef);
      // [UPGRADED to VERIFIED] Both notes below used to read "[BEST
      // EFFORT]". `Creature.GetPowerAmount<T>()` itself was already
      // reflection-confirmed real (round 6/7 — ForgeActions.cs.template's
      // header), but ONLY as a member existing on the class, never seen
      // actually being CALLED this way in real, working, shipped code —
      // this round's decompile of EnergeticAttack's real, compiled
      // `get_ShouldGlowGoldInternal` closes that gap directly:
      // `Owner?.Creature?.GetPowerAmount<FatiguePower>()`, T a CUSTOM
      // mod-defined Power, the exact same shape mechanicClassName(...)
      // generates here (confirming the 'custom' arm outright) — and since
      // built-in Powers classes share the identical generic
      // method/type-parameter shape against the same PowerModel
      // constraint (see ForgeActions.cs.template's own header), 'vanilla'
      // is no longer an unconfirmed guess either.
      const evidenceNote = statusKind === 'vanilla'
        ? '[VERIFIED] GetPowerAmount<T> confirmed via decompiling TheBurdenedNewCharacter.dll\'s EnergeticAttack; T resolved from the same BUILTIN_POWER_CLASS_MAP the ApplyStatus/RemoveStatus actions already use — see TOOLCHAIN_FINDINGS.md'
        : '[VERIFIED via decompiling TheBurdenedNewCharacter.dll\'s EnergeticAttack — Owner?.Creature?.GetPowerAmount<FatiguePower>()] see TOOLCHAIN_FINDINGS.md';
      // Glow (`ShouldGlowGoldInternal`) is a bare property getter — no
      // fgPlayer/fgTarget/fgPet locals exist there (see
      // resolveGlowSubjectExpr's own doc comment above). Every other call
      // site (a normal effect block's "If") still goes through the
      // cardPlay-bound fgPlayer/fgTarget/fgPet locals as before.
      if (ctx.glowContext) {
        const subjExpr = resolveGlowSubjectExpr(cond.subject);
        return `(${subjExpr}?.GetPowerAmount<${typeArg}>()).GetValueOrDefault() ${cmp} ${cond.value} /* ${evidenceNote} */`;
      }
      return `ForgeActions.GetStatusStacks<${typeArg}>(${resolveConditionSubjectExpr(cond.subject)}) ${cmp} ${cond.value} /* ${evidenceNote} */`;
    }
    case 'HpBelowPercent':
      // [UPGRADED to VERIFIED, 2026-08-27] Tyler's follow-up: "the hp below
      // % condition should allow either yourself or pet or enemy to be the
      // target of the check" — subject was already captured (same
      // CONDITION_SUBJECTS/resolveConditionSubjectExpr as HasStatusStacks),
      // but HP% itself had no confirmed accessor through any reflect-baselib
      // round — this round found it directly in the real game assembly
      // (`sts2.dll`, read straight off Tyler's own game install, not
      // reflected): `Creature.CurrentHp`/`Creature.MaxHp` are both real,
      // public, concrete properties on the exact same real `Creature` type
      // fgPlayer/fgTarget/fgPet already resolve to (see effectBlockToCSharp's
      // `ctx` doc comment) — no guessing involved, this is the type's own
      // real member list. Despite the kind's name ("...Below...", kept for
      // backward compatibility with already-saved packages), the real
      // comparator/value pair the schema already threads through covers
      // BOTH "below" (lt/lte) and "above" (gt/gte) in one expression —
      // Tyler's screenshot's "HP below N%"/"HP above N%" are the same real
      // check with a different comparator, not two different mechanisms.
      // 2026-09-07 fix — this case had NO ctx.glowContext branch despite
      // the frontend already treating it as glow-safe (Tyler's follow-up
      // added it to SUBJECT_CAPABLE_CONDITION_KINDS, and availableSubjects'
      // own comment already excludes CardTarget for glow specifically,
      // clearly intending this to work there) — but it kept unconditionally
      // emitting fgPlayer/fgTarget/fgPet, locals that DON'T EXIST inside
      // ShouldGlowGoldInternal (a bare property getter — see
      // resolveGlowSubjectExpr's own doc comment). That's not a safe
      // "compiles but throws at runtime" gap like the properly-guarded
      // cases below (EnergyRemaining etc.) — it's an undefined-variable
      // reference, a HARD C# COMPILE FAILURE (CS0103) that would have
      // broken the whole mod's build the moment a user picked "HP" as a
      // glow condition. Fixed by mirroring HasStatusStacks' own real
      // ctx.glowContext branch above — same real Creature.CurrentHp/MaxHp
      // accessors, just resolved through Owner?.Creature/Owner?.Osty
      // (resolveGlowSubjectExpr) instead of fgPlayer/fgTarget/fgPet.
      // Null-conditional + GetValueOrDefault throughout since Owner?.
      // Creature is nullable (a card sitting in hand/deck, possibly
      // outside live combat) — MaxHp defaults to 1, not 0, so an
      // unresolved subject reads as 0% rather than dividing by zero.
      if (ctx.glowContext) {
        const subjExpr = resolveGlowSubjectExpr(cond.subject);
        return `(((decimal)(${subjExpr}?.CurrentHp).GetValueOrDefault() / (decimal)(${subjExpr}?.MaxHp).GetValueOrDefault(1)) * 100m) ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Creature.CurrentHp/MaxHp] */`;
      }
      return `(((decimal)${resolveConditionSubjectExpr(cond.subject)}.CurrentHp / (decimal)${resolveConditionSubjectExpr(cond.subject)}.MaxHp) * 100m) ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Creature.CurrentHp/MaxHp] */`;
    case 'EnergyRemaining':
    case 'StarsRemaining':
      // [VERIFIED via reflect-baselib round 14a/14b] Player.PlayerCombatState
      // is a real, public, get/set property (round 5's own Player dump —
      // re-read this round, not new — `[Player] property PlayerCombatState
      // PlayerCombatState { get; set; }`), and PlayerCombatState itself has
      // real, live, get/set `System.Int32 Energy`/`System.Int32 Stars`
      // properties — the LIVE remaining count, distinct from
      // CardModel.BaseStarCost/CurrentStarCost (a CARD's own star cost, not
      // how many the player currently has) and distinct from
      // Player.MaxEnergy (the cap, not what's left). Cross-confirmed twice
      // in the same run: once in round 14a's full dump of
      // PlayerCombatState, once in round 14b's independent broad sweep for
      // any live-count-shaped member anywhere. Reached via `cardPlay.Player`
      // — the same real (round 3/5) path OnPlay's own `fgPlayer` local
      // already uses — so this only compiles for real where a `cardPlay`
      // local is actually in scope (see effectBlockToCSharp's `ctx` doc
      // comment above). Every card trigger that reaches this function
      // qualifies; the one narrow exception is relics/mechanics' OnTakeDamage
      // hook (TRIGGER_HOOKS — real params are bare Creatures, no CardPlay
      // anywhere), which still falls back to the honest TodoCondition below
      // rather than reference an undefined `cardPlay` and fail to compile.
      if (ctx.cardPlayBound) {
        const prop = cond.kind === 'StarsRemaining' ? 'Stars' : 'Energy';
        return `cardPlay.Player.PlayerCombatState.${prop} ${cmp} ${cond.value} /* [VERIFIED via reflect-baselib round 14a/14b] */`;
      }
      return `ForgeActions.TodoCondition("${cond.kind}(no cardPlay in scope on this hook)")`;
    case 'CardsInHand':
      // [BEST EFFORT] upgraded 2026-08-26 — decompiling
      // TheBurdenedNewCharacter's real source (Tyler gave direct access,
      // alongside BaseLib's own GitHub repo) turned up the real accessor:
      // `PileType.Hand.GetPile(Player)` returns a real `CardPile` whose
      // `.Cards` is a real, countable collection — seen directly in
      // several real, compiled cards/relics (e.g. `PileType.Hand.
      // GetPile(base.Owner).Cards.Any(...)`). Same `ctx.cardPlayBound`-
      // gated `cardPlay.Player` pattern as EnergyRemaining/StarsRemaining
      // above — `GetPile` needs a real `Player`, only guaranteed in scope
      // where a real `cardPlay` local exists.
      // 2026-09-07 fix — this and 2 other call sites (HandCardTypeCheck,
      // NoCopiesOfCardInHand below) had all hardcoded the WRONG fully-
      // qualified name, `MegaCrit.Sts2.Core.Models.PileType` — confirmed
      // via a direct IL sweep of sts2.dll this round (`il_dump.py --find
      // "PileType"`) that the real type is
      // `MegaCrit.Sts2.Core.Entities.Cards.PileType` (PileTypeExtensions
      // alongside it); the `Models` namespace contains no PileType at
      // all. That's not a [BEST EFFORT] inaccuracy, it's a hard CS0234
      // ("type or namespace name does not exist") the instant any of
      // these 3 kinds actually gets used — found while researching
      // Tyler's "check the position of the card in hand" ask (CardPosition
      // InHand below uses this exact same real API family). Fixed by
      // dropping the wrong explicit prefix; Card/Relic/Power.cs.template
      // all already have `using MegaCrit.Sts2.Core.Entities.Cards;`, so
      // the bare `PileType.Hand` these comments always claimed to emit
      // now actually IS what's emitted.
      if (ctx.cardPlayBound) {
        return `PileType.Hand.GetPile(cardPlay.Player).Cards.Count() ${cmp} ${cond.value} /* [BEST EFFORT] see compiler.js's own comment on this case */`;
      }
      return `ForgeActions.TodoCondition("${cond.kind}(no cardPlay in scope on this hook)")`;
    case 'PlayedCardHasType':
      // [VERIFIED] upgraded 2026-08-26 — same decompile as CardsInHand
      // above found the real getter: `CardModel.Type` (a real, public
      // `CardType` property), seen directly in real, compiled code
      // filtering cards by type (e.g. `.Cards.Where(c => c.Type ==
      // CardType.Attack)`). `cardPlay.Card` is [VERIFIED via
      // reflect-baselib round 3]; only valid on the "OnAnyCardPlayed"
      // trigger, same restriction as PlayedCardHasKeyword/PlayedCardHasTag
      // (cardPlay is only in scope there) — enforced in validate.js, so
      // `cardPlay` is always real by the time this compiles. Replaces the
      // old `IsAttack` condition, which hard-coded a single type instead
      // of letting the author pick any of the 5.
      return `cardPlay.Card.Type == CardType.${cond.cardType} /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll] */`;
    case 'PlayedCardHasKeyword':
      // [VERIFIED via reflect-baselib rounds 2/3/9] `cardPlay.Card` is a
      // real CardModel (round 3), and CardModel.Keywords is a real,
      // concrete, public `IReadOnlySet<CardKeyword>` getter (round 9's
      // *Keyword* sweep) — `.Contains(...)` on it is a plain real
      // HashSet-style call, not a guess. Only valid where `cardPlay` is
      // actually in scope — see CARD_TRIGGER_HOOKS/TRIGGER_HOOKS'
      // OnAnyCardPlayed entries and validate.js's trigger check, which
      // rejects this condition anywhere else before it ever gets here.
      return `cardPlay.Card.Keywords.Contains(${keywordExpr(cond.keyword)})`;
    case 'PlayedCardHasTag':
      // TRUE custom tags — Tyler's original "hit" example. NOT BaseLib's
      // CardTag (a real but closed enum, see Generated/
      // IForgeTaggedCard.cs.template's header for the full reasoning) —
      // this is a Forge-owned mechanism: every generated card implements
      // IForgeTaggedCard, so this is a plain `as`-pattern check + a plain
      // C# HashSet<string>.Contains(...) call, nothing borrowed from an
      // unconfirmed BaseLib attribute. `cardPlay.Card` is the played
      // CardModel — a card from the BASE GAME (or another mod) simply
      // won't implement IForgeTaggedCard at all, so the `as` cast safely
      // yields null and the whole expression is false, not a crash.
      // Same trigger restriction as PlayedCardHasKeyword — only valid
      // where `cardPlay` is in scope (OnAnyCardPlayed), enforced by
      // validate.js before this ever runs.
      return `(cardPlay.Card as IForgeTaggedCard)?.ForgeTags.Contains(${csharpStringLiteral(cond.tag)}) == true`;
    case 'CardsPlayedThisTurn': {
      // [VERIFIED via decompiling TheBurdenedNewCharacter.dll's Eternal] —
      // its real OnPlay body only grants Regen when this exact count is
      // zero, AND its real ShouldGlowGoldInternal override uses the
      // IDENTICAL count to decide whether to glow (Tyler: "it has a card
      // called eternal that gives you regen when it is the first card
      // played that turn"). Tyler's follow-up generalized this from a
      // fixed "< 1" (first-card-only) check into a real comparator+value
      // threshold on that same count: "the glow condition should instead
      // check if cards played this turn are <= an amount." The count
      // expression itself is unchanged — CombatManager.Instance/.History
      // are real (already used elsewhere in this codebase); CombatHistory's
      // real CardPlaysFinished is a filterable collection of
      // CardPlayFinishedEntry, each with a real, concrete
      // HappenedThisTurn(ICombatState) instance method and a real
      // CardPlay-typed CardPlay property, walked down to Card.Owner —
      // counting entries that (a) happened this turn AND (b) were played by
      // THIS card's own owner — deliberately `this.Owner` (the entity's own
      // owner), NOT whatever `fgPlayer` happens to be bound to at a given
      // relic/mechanic hook (e.g. an enemy Creature on AfterBlockCleared) —
      // that would silently change the meaning from "did MY owner play N
      // cards" to "did the creature THIS hook happened to fire for play N
      // cards", which is a real behavior bug, not just a compile one, so
      // `Owner` stays untouched here regardless of ctx.
      //
      // Round 25 (2026-09-01) fix: this condition kind is selectable on ANY
      // trigger (frontend's conditionKindAllowedForTrigger has no
      // requiresTrigger for it) AND has no entity-kind restriction in
      // CONDITION_KINDS — so it's reachable not just from a card's own
      // glow/OnPlay but from a RELIC's or MECHANIC's own effect condition
      // too (generateHookEffects), and from a Group B modifier's condition
      // (generateModifierOverrides). The old unconditional bare
      // `CombatState` comment above was wrong to claim "no ctx-based
      // branching needed at all": bare `CombatState` is only a real
      // instance member on CardModel/PowerModel, NOT RelicModel (confirmed
      // via direct sts2.dll read after Tyler's real `dotnet build` caught
      // the identical bug in actionToCSharp — see resolvePlayerExpr's own
      // comment for the full evidence). Fixed by going through
      // `fgPlayer.CombatState` (Creature.CombatState, also real) instead of
      // bare `CombatState` wherever `fgPlayer` is provably bound —
      // `ctx.fgPlayerBound`, set by cascadingTriggerBody/generateHookEffects
      // unconditionally and by generateModifierOverrides per-hook (see each
      // one's own comment) — true everywhere but the glow property getter
      // (no locals at all there) and a Group B modifier hook with
      // `playerExpr: null` (ShouldPlay, ModifyAttackHitCount, etc.), both of
      // which keep the old bare `CombatState` — correct on a card/mechanic,
      // still latently unverified on a relic in that specific narrow
      // combination, exactly as before this round and not made worse by it.
      const combatStateExpr = ctx.fgPlayerBound ? 'fgPlayer.CombatState' : 'CombatState';
      return `(MegaCrit.Sts2.Core.Combat.CombatManager.Instance?.History?.CardPlaysFinished.Count(e => e.HappenedThisTurn(${combatStateExpr}) && e.CardPlay.Card.Owner == Owner) ?? 0) ${cmp} ${cond.value}`;
    }
    case 'DamageBrokeBlock':
      // Added 2026-08-26 for Tyler's "Flick" lead — SAME source as
      // StunEnemy's upgrade above (decompiled TheBurdenedNewCharacter.dll),
      // and Tyler's own explicit architecture instruction: "note that 'if
      // this damage broke their block' is a conditional to the stun effect
      // and not directly tied to it" — i.e. model it as its own condition
      // gating a later effect block's actions, NOT as a property bundled
      // into DealDamage itself. This mirrors exactly how the app already
      // supports "deal damage, THEN [conditionally] do something else": two
      // separate effect entries on the same trigger, run in the order
      // they're authored (effectsToCSharp loops effect blocks in sequence
      // within one method body) — an unconditional DealDamage effect
      // followed by a second effect whose only condition is this one.
      //
      // The individual pieces are each [VERIFIED via decompiling
      // TheBurdenedNewCharacter.dll's Flick]: `CombatManager.Instance.
      // History.Entries` (a superset stream CombatHistory exposes ABOVE the
      // already-real CardPlaysFinished used by CardsPlayedThisTurn above),
      // filtered with `OfType<DamageReceivedEntry>()`; each entry has real
      // `CardSource` (compared by reference against `this` — Flick's own
      // predicate lambda captures `this`, i.e. the CardModel instance
      // itself, and compares it against `entry.CardSource` directly — no
      // `cardPlay` needed, so — like CardsPlayedThisTurn — this needs no
      // ctx.cardPlayBound branching either) and real `Result` ->
      // `DamageResult.WasBlockBroken`.
      //
      // Flick's OWN literal codegen is more involved than what's below: it
      // snapshots `History.Entries.OfType<DamageReceivedEntry>().Count()`
      // BEFORE dealing damage, then after awaiting the attack does
      // `.Skip(thatSnapshot).Any(e => e.CardSource == this && e.Result.
      // WasBlockBroken)` — because ITS predicate lambda is a closure that
      // needs the skip-count to only look at entries newer than the
      // snapshot. This codegen takes a [BEST EFFORT] shortcut instead:
      // `.LastOrDefault(e => e.CardSource == this)` — the most recent
      // history entry this exact card instance caused, anywhere in the
      // whole combat. That's behaviorally identical to Flick's own
      // Skip+Count approach for the intended/only sane placement of this
      // condition (a second effect block, right after a DealDamage effect,
      // on the same OnPlay) — this card's own most recent damage entry IS
      // the one that effect's DealDamage action just caused, since nothing
      // else can run between two effect blocks in the same synchronous
      // OnPlay body. It does NOT require threading a shared snapshot
      // variable between two independently-authored effect blocks, which
      // the current effect-block architecture has no mechanism for anyway.
      // Placing this condition anywhere OTHER than immediately after a
      // DealDamage effect for the same card/trigger (e.g. with no preceding
      // DealDamage at all) would just read whatever this card's last damage
      // instance was from an earlier, unrelated play — a real but
      // misleading result, not a compile error; flagged in this condition's
      // own CONDITION_KINDS hint in frontend/index.html rather than
      // silently guarded against, since there's no reliable way to detect
      // "was there a DealDamage effect right before this one" from here.
      // Restricted to the OnPlay trigger only (requiresTrigger — see
      // frontend CONDITION_KINDS / backend validate.js) since that's the
      // only trigger where "this card's own damage" is a coherent idea at
      // all (matches Flick's own usage).
      // [Round 191 fix] `this` is only a CardModel when ctx.thisIsCard
      // is true (a card's own generated class); for an enchantment's OnPlay
      // (thisIsCard: false, `this` is the EnchantmentModel) `e.CardSource ==
      // this` would never match a real CardModel and is a type mismatch risk
      // besides -- fall back to an honest TodoCondition stub instead.
      if (!ctx.thisIsCard) return `ForgeActions.TodoCondition("DamageBrokeBlock(only valid on a card's own OnPlay -- e.CardSource == this has no meaning outside a card's own generated class)")`;
      return `(MegaCrit.Sts2.Core.Combat.CombatManager.Instance?.History?.Entries.OfType<MegaCrit.Sts2.Core.Combat.History.Entries.DamageReceivedEntry>().LastOrDefault(e => e.CardSource == this)?.Result.WasBlockBroken ?? false)`;
    // [Round 70] 'DamageKilledTarget' removed — Tyler asked to switch the
    // followUp's "killed the target" check to the fully VERIFIED
    // TemperedStrength access path instead of this case's old [BEST
    // EFFORT] History-walk guess; that path needs the real AttackCommand
    // built by the DealDamage/DealDamageAllEnemies call itself (see
    // actionToCSharp's DealDamage case), which this generic
    // conditionToCSharp function has no way to reference — so the
    // KilledTarget followUp is now synthesized directly inline there
    // instead of routing through this switch at all. Confirmed via grep
    // that 'DamageKilledTarget' had no other reference anywhere in the
    // codebase (it was never a standalone, user-pickable CONDITION_KINDS
    // entry) before removing this case.
    case 'DamageWasFullyBlocked':
      // Added 2026-08-27 alongside the condition-kind expansion sweep below
      // — same internal-only synthesis as DamageKilledTarget (never a
      // user-pickable standalone CONDITION_KINDS entry), just reading
      // `.Result.WasFullyBlocked` instead. [VERIFIED via sts2.dll] —
      // DamageResult.WasFullyBlocked is a real, confirmed property, found
      // reading the actual game assembly directly this round (stronger
      // evidence than WasBlockBroken/WasTargetKilled originally had, both
      // of which were only confirmed via mod-usage decompiles until this
      // same sts2.dll read cross-confirmed them too).
      // [Round 191 fix] same ctx.thisIsCard guard as DamageBrokeBlock above.
      if (!ctx.thisIsCard) return `ForgeActions.TodoCondition("DamageWasFullyBlocked(only valid on a card's own OnPlay -- e.CardSource == this has no meaning outside a card's own generated class)")`;
      return `(MegaCrit.Sts2.Core.Combat.CombatManager.Instance?.History?.Entries.OfType<MegaCrit.Sts2.Core.Combat.History.Entries.DamageReceivedEntry>().LastOrDefault(e => e.CardSource == this)?.Result.WasFullyBlocked ?? false)`;
    case 'DamageUnblockedAmount': {
      // Added 2026-08-27, same internal-only synthesis as above.
      // [VERIFIED via sts2.dll] DamageResult.UnblockedDamage is a real,
      // confirmed numeric property (not a bool like the other 3 Damage*
      // kinds) — takes a real comparator+value pair off the synthetic cond
      // object (see actionToCSharp's DealDamage case, which builds this
      // cond from action.followUp.comparator/value).
      const fuCmp = { lt: '<', lte: '<=', eq: '==', gte: '>=', gt: '>' }[cond.comparator] || '>=';
      // [Round 191 fix] same ctx.thisIsCard guard as DamageBrokeBlock above.
      if (!ctx.thisIsCard) return `ForgeActions.TodoCondition("DamageUnblockedAmount(only valid on a card's own OnPlay -- e.CardSource == this has no meaning outside a card's own generated class)")`;
      return `((MegaCrit.Sts2.Core.Combat.CombatManager.Instance?.History?.Entries.OfType<MegaCrit.Sts2.Core.Combat.History.Entries.DamageReceivedEntry>().LastOrDefault(e => e.CardSource == this)?.Result.UnblockedDamage) ${fuCmp} ${cond.value ?? 0})`;
    }

    // ---- 2026-08-27 condition-kind expansion round --------------------
    // Tyler shared 4 screenshots of a ~50-entry "follow-up condition" list
    // from elsewhere and asked for a full sweep of the real game assembly
    // (sts2.dll, read directly this round — see TOOLCHAIN_FINDINGS.md's
    // "MAJOR toolchain upgrade" entry), BaseLib source, and both real
    // decompiled mods before adding ANY of it. Most of that list turned out
    // to be general state checks, not outcomes of a specific action — these
    // cases extend the existing top-level effect-condition system
    // (CONDITION_KINDS), NOT the DealDamage followUp mechanism above, which
    // stays untouched. Every case below cites its real evidence; anything
    // from Tyler's screenshots with NO real backing found (Stance system,
    // relic tags, "marker" cards, the "Consume" pet ability) was
    // deliberately left OUT rather than added as a guess — see
    // TOOLCHAIN_FINDINGS.md for the full negative-findings list.
    case 'HasBlock':
      // [VERIFIED via sts2.dll] Creature.Block is a real, public, concrete
      // property — same real Creature type fgPlayer/fgTarget/fgPet resolve
      // to. Comparator+value covers both "has Block" (gte 1) and "has no
      // Block" (lt 1) from Tyler's screenshot — one real expression, no
      // separate boolean-shaped kind needed (same reasoning as HpBelowPercent
      // above covering both "below" and "above" with one comparator).
      // 2026-09-07 fix — same undefined-variable-in-glow bug as
      // HpBelowPercent above (see that case's own comment for the full
      // reasoning); this kind is ALSO in SUBJECT_CAPABLE_CONDITION_KINDS
      // and ALSO already treated as glow-safe by the frontend, so the same
      // fix applies: branch through resolveGlowSubjectExpr in glow context.
      if (ctx.glowContext) {
        const subjExpr = resolveGlowSubjectExpr(cond.subject);
        return `(${subjExpr}?.Block).GetValueOrDefault() ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Creature.Block] */`;
      }
      return `${resolveConditionSubjectExpr(cond.subject)}.Block ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Creature.Block] */`;
    case 'DebuffStacksTotal':
      // [VERIFIED via sts2.dll] Creature.Powers is a real, enumerable
      // collection; PowerModel.Type returns the real PowerType enum
      // (None/Buff/Debuff — [VERIFIED enum members via reflect-baselib
      // round 2], now independently re-confirmed reading sts2.dll directly).
      // Summing Amount across every power whose Type is Debuff covers both
      // "has any debuff" (gte 1) and "debuff stacks total >= N" from
      // Tyler's screenshot — same one-expression-two-comparators pattern as
      // HasBlock/HpBelowPercent above.
      // 2026-09-07 fix — same undefined-variable-in-glow bug as
      // HpBelowPercent above (see that case's own comment); also in
      // SUBJECT_CAPABLE_CONDITION_KINDS, also already treated as glow-safe
      // by the frontend. `Powers` is walked with `?.` too (not just the
      // subject itself) — Owner?.Creature existing doesn't guarantee its
      // Powers collection does, same defensive style resolveGlowSubjectExpr
      // itself already uses for the Owner->Creature/Osty chain.
      if (ctx.glowContext) {
        const subjExpr = resolveGlowSubjectExpr(cond.subject);
        return `(${subjExpr}?.Powers?.Where(p => p.Type == MegaCrit.Sts2.Core.Entities.Powers.PowerType.Debuff).Sum(p => p.Amount)).GetValueOrDefault() ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Creature.Powers, PowerModel.Type/Amount] */`;
      }
      return `${resolveConditionSubjectExpr(cond.subject)}.Powers.Where(p => p.Type == MegaCrit.Sts2.Core.Entities.Powers.PowerType.Debuff).Sum(p => p.Amount) ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Creature.Powers, PowerModel.Type/Amount] */`;
    case 'PetIsOut':
      // [VERIFIED via sts2.dll] Creature.Pets is a real, enumerable
      // collection (`get_Pets`), independently corroborated by
      // Player.Osty/IsOstyAlive (already [VERIFIED via reflect-baselib
      // round 5], used elsewhere in this file for the Pet subject) AND by
      // TheTrainerNewCharacter.dll — a SECOND real, compiled, shipped mod
      // this round examined for the first time — defining a full real pet
      // roster (BlastoisePet, CharizardPet, etc.) as working
      // Creature-owned pets. No comparator/value/subject — a plain
      // "does the player currently have an active pet" boolean check.
      // 2026-09-07 fix — same undefined-variable-in-glow bug as
      // HpBelowPercent above (see that case's own comment); also in
      // SUBJECT_CAPABLE_CONDITION_KINDS, also already treated as glow-safe
      // by the frontend.
      if (ctx.glowContext) {
        const subjExpr = resolveGlowSubjectExpr(cond.subject);
        return `(${subjExpr}?.Pets?.Any()).GetValueOrDefault() /* [VERIFIED via sts2.dll — Creature.Pets, cross-confirmed via TheTrainerNewCharacter.dll's real pet roster] */`;
      }
      return `${resolveConditionSubjectExpr(cond.subject)}.Pets.Any() /* [VERIFIED via sts2.dll — Creature.Pets, cross-confirmed via TheTrainerNewCharacter.dll's real pet roster] */`;
    case 'HandCardTypeCheck': {
      // [Round 63] Generalized off `ctx.cardPlayBound` — reuses the exact
      // same real access pattern CardsInHand already established
      // (`PileType.Hand.GetPile(<player>).Cards`), filtered by the real
      // CardType enum. `cond.mode` ('Any'|'All', default 'Any') covers
      // "Hand is all Attacks" (mode=All) AND "You have a Curse/Status in
      // hand" (mode=Any) with one kind. Player resolution now goes through
      // `resolvePlayerExpr(ctx)` instead of a hardcoded `cardPlay.Player`
      // — real on any trigger where `ctx.fgPlayerBound` is true (every
      // TRIGGER_HOOKS entry except the glow property getter and a Group B
      // modifier hook with `playerExpr: null` — see resolvePlayerExpr's
      // own comment and CardsPlayedThisTurn's identical `fgPlayerBound`
      // gate above), falling back to an honest stub in those two cases
      // rather than referencing an unbound `fgPlayer`.
      if (!ctx.fgPlayerBound) return `ForgeActions.TodoCondition("HandCardTypeCheck(no player in scope on this hook)")`;
      const method = cond.mode === 'All' ? 'All' : 'Any';
      return `PileType.Hand.GetPile(${resolvePlayerExpr(ctx)}).Cards.${method}(c => c.Type == CardType.${cond.cardType}) /* [BEST EFFORT] see compiler.js's own comment on this case */`;
    }
    case 'AttacksPlayedThisTurn': {
      // [VERIFIED via decompiling TheBurdenedNewCharacter.dll's Eternal —
      // same real CombatManager.Instance.History.CardPlaysFinished walk
      // CardsPlayedThisTurn already uses above] just adds a real
      // `.CardPlay.Card.Type == CardType.Attack` filter — CardModel.Type is
      // the same [VERIFIED via decompiling TheBurdenedNewCharacter.dll]
      // getter PlayedCardHasType already uses. Kept as its own condition
      // kind rather than folding an optional filter into the existing,
      // already-verified CardsPlayedThisTurn case, to avoid any risk of
      // regressing that one's real, working codegen (used by glow too).
      // Same round 25 (2026-09-01) `ctx.fgPlayerBound` fix as
      // CardsPlayedThisTurn above (bare `CombatState` swapped for
      // `fgPlayer.CombatState` wherever fgPlayer is provably bound; `Owner`
      // deliberately left untouched — see its own comment for the full
      // real-build evidence and the reasoning for not touching Owner).
      const combatStateExpr = ctx.fgPlayerBound ? 'fgPlayer.CombatState' : 'CombatState';
      return `(MegaCrit.Sts2.Core.Combat.CombatManager.Instance?.History?.CardPlaysFinished.Count(e => e.HappenedThisTurn(${combatStateExpr}) && e.CardPlay.Card.Owner == Owner && e.CardPlay.Card.Type == CardType.Attack) ?? 0) ${cmp} ${cond.value}`;
    }
    case 'OrbSlotCount':
      // [Round 63] Generalized off `ctx.cardPlayBound` — Player.
      // BaseOrbSlotCount is a real backing field (independently
      // corroborated by the real OrbQueue.Capacity/AddCapacity/
      // RemoveCapacity members on the actual runtime orb queue type), and
      // is a Player-level (not Creature-level) member, so it's reached the
      // same way GainOrbSlots' own action already does: `resolvePlayerExpr(ctx)`
      // instead of a hardcoded `cardPlay.Player`, gated on `ctx.fgPlayerBound`
      // (see HandCardTypeCheck's own comment above for the full reasoning).
      if (ctx.fgPlayerBound) {
        return `${resolvePlayerExpr(ctx)}.BaseOrbSlotCount ${cmp} ${cond.value} /* [VERIFIED via sts2.dll — Player.BaseOrbSlotCount] */`;
      }
      return `ForgeActions.TodoCondition("OrbSlotCount(no player in scope on this hook)")`;
    case 'EnemyIntent': {
      // [VERIFIED via sts2.dll's real MonsterMoves.Intents type hierarchy,
      // cross-confirmed via a real usage pattern already found in Tyler's
      // own TheBurdenedNewCharacter.dll source: `cardPlay.Target?.Monster?.
      // NextMove?.Intents?.Any(i => i is AttackIntent)`, used 4 times
      // across real cards]. sts2.dll confirms 14 real concrete Intent
      // types total (AttackIntent, DefendIntent, BuffIntent, DebuffIntent,
      // HealIntent, StunIntent, SummonIntent, SleepIntent, EscapeIntent,
      // MultiAttackIntent, SingleAttackIntent, CardDebuffIntent,
      // DeathBlowIntent, HiddenIntent, StatusIntent, UnknownIntent) — only
      // Attack/Defend are exposed here (matching Tyler's screenshot's
      // "intends to attack"/"intends to block" exactly); the rest are real
      // and confirmed but not wired to a picker yet, left for a future
      // round rather than adding UI for intents nobody asked for. Only
      // valid where cardPlay.Target is in scope (same restriction as the
      // real usage pattern this reuses).
      if (!ctx.cardPlayBound) return `ForgeActions.TodoCondition("EnemyIntent(no cardPlay in scope on this hook)")`;
      const intentClass = cond.intentKind === 'Defend' ? 'DefendIntent' : 'AttackIntent';
      return `(cardPlay.Target?.Monster?.NextMove?.Intents?.Any(i => i is MegaCrit.Sts2.Core.MonsterMoves.Intents.${intentClass}) == true) /* [VERIFIED via sts2.dll + real usage in TheBurdenedNewCharacter.dll] */`;
    }
    case 'HasSpecificRelic': {
      // [Round 63] Generalized off `ctx.cardPlayBound` — Player.Relics is
      // a real, enumerable collection reached the same way every other
      // generalized condition/action above now reaches its Player, via
      // `resolvePlayerExpr(ctx)` (which, notably, already special-cases
      // `ctx.entityKind === 'relic'` to `this.Owner` — RelicModel.Owner is
      // directly Player-typed, see resolvePlayerExpr's own comment — so a
      // relic's own condition checking "do I hold relic X" resolves
      // correctly too, not just card/mechanic hooks). Gated on
      // `ctx.fgPlayerBound` (see HandCardTypeCheck's own comment above).
      if (!ctx.fgPlayerBound) return `ForgeActions.TodoCondition("HasSpecificRelic(no player in scope on this hook)")`;
      const relicCls = ctx.relicClassById && ctx.relicClassById.get(cond.relicRef);
      if (!relicCls) return `ForgeActions.TodoCondition("HasSpecificRelic(no relic selected or relic not found: ${cond.relicRef || ''})")`;
      return `${resolvePlayerExpr(ctx)}.Relics.Any(r => r is ${relicCls}) /* [VERIFIED via sts2.dll — Player.Relics] */`;
    }
    case 'NoCopiesOfCardInHand': {
      // [Round 63] Generalized off `ctx.cardPlayBound` — same real
      // PileType.Hand.GetPile(<player>).Cards access CardsInHand/
      // HandCardTypeCheck already use, now reached via `resolvePlayerExpr(ctx)`
      // instead of a hardcoded `cardPlay.Player`, gated on
      // `ctx.fgPlayerBound` (see HandCardTypeCheck's own comment above).
      if (!ctx.fgPlayerBound) return `ForgeActions.TodoCondition("NoCopiesOfCardInHand(no player in scope on this hook)")`;
      const cardCls = ctx.cardClassById && ctx.cardClassById.get(cond.cardRef);
      if (!cardCls) return `ForgeActions.TodoCondition("NoCopiesOfCardInHand(no card selected or card not found: ${cond.cardRef || ''})")`;
      return `!PileType.Hand.GetPile(${resolvePlayerExpr(ctx)}).Cards.Any(c => c is ${cardCls}) /* [BEST EFFORT] see compiler.js's own comment on this case */`;
    }

    // 2026-09-08 (round 52) — Tyler uploaded an updated
    // TheBurdenedNewCharacter.dll v3 in which his real "Earthquake" card
    // has a real playableCondition of "isLeftmostInHand" (confirmed both
    // in the mod creator's own exported project.txt AND in the compiled
    // DLL). Decompiled Earthquake's real, compiled `get_IsPlayable()`
    // directly via il_dump.py — it's exactly:
    //   PileTypeExtensions.GetPile(PileType.Hand, Owner).Cards.FirstOrDefault() == this;
    // [VERIFIED via sts2.dll, this round] `PileType.Hand` = 2 (read
    // straight off the enum's own Constant-table value — not guessed);
    // `PileTypeExtensions.GetPile(PileType, Player)` is real/public/
    // static; `CardPile.Cards` is a real, public `IReadOnlyList<CardModel>`
    // — so indexing/Count are plain BCL operations on top of those 3 real,
    // confirmed facts, not additional game-specific guesses. Earthquake's
    // OWN `ShouldGlowGoldInternal` override, also decompiled this round,
    // is literally `return this.IsPlayable;` — real, independent
    // confirmation that Glow and Playability share the exact same bare-
    // property-getter, no-cardPlay, `this`-bound shape (see
    // resolveGlowSubjectExpr's doc comment above), which is why this
    // condition (like every other real glow-safe kind) only ever compiles
    // for real when `ctx.glowContext` is true — see generatePlayabilityOverride
    // below for why that flag now also drives the (newly real) Playability
    // override, not just Glow. `ForgeActions.IsCardAtHandPosition` wraps
    // the 3 real primitives above into one reusable, null-safe (Owner can
    // be null for a canonical/un-owned instance) helper, generalized from
    // Earthquake's exact "leftmost" (edge:'Left', position:1) case to any
    // edge/position. No subject field (not in SUBJECT_CAPABLE_CONDITION_KINDS)
    // — this is always about THIS card's own position, there's no "whose
    // hand" to pick.
    case 'CardPositionInHand': {
      const fromRight = cond.edge === 'Right' ? 'true' : 'false';
      const position = Number.isInteger(cond.position) && cond.position >= 1 ? cond.position : 1;
      if (ctx.glowContext) {
        return `ForgeActions.IsCardAtHandPosition(this, ${fromRight}, ${position}) /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — Earthquake's real IsPlayable override] */`;
      }
      // [Round 53, 2026-09-08] Tyler asked to extend this to card-effect
      // conditionals (OnPlay/OnAnyCardPlayed) too. Investigated for real
      // before doing anything: decompiled CardModel.OnPlayWrapper and
      // CardPileCmd.AddDuringManualCardPlay in sts2.dll. Confirmed IL order —
      // AddDuringManualCardPlay calls card.RemoveFromCurrentPile() then
      // PileTypeExtensions.GetPile(...).AddInternal(card) (moving the card to
      // the Play pile), and OnPlayWrapper calls THAT before Hook.BeforeCardPlayed,
      // CardModel.OnPlay, and Hook.AfterCardPlayed (the hook OnAnyCardPlayed
      // compiles to) ever run. So a LIVE hand-position check (this same
      // ForgeActions.IsCardAtHandPosition helper) is unconditionally false
      // by the time any card-effect trigger's conditions evaluate — round
      // 53 correctly declined to wire that up as a silent, always-false
      // check.
      //
      // [Round 54, 2026-09-08] Tyler's updated TheBurdenedNewCharacter.dll
      // v4 has a real, compiled Strike card that deals bonus damage if it
      // "was" leftmost/rightmost in hand when played — solving exactly
      // this problem via a Harmony PREFIX patch on CardModel.OnPlayWrapper
      // (runs BEFORE the pile-removal above) that captures the position
      // into a per-card field, read later from OnPlay. Generated/
      // ForgeHandPositionTracker.cs reimplements that exact mechanism
      // generically (index+count instead of his 2 fixed booleans) — see
      // its header and Generated/IForgeHandPosition.cs for the full
      // decompiled evidence trail.
      //
      // [Round 56, 2026-09-08 — Tyler: "add a 'this card' target option
      // whenever the trigger is set to played/discarded/kept in hand, and
      // a 'that card' target option for whenever any card is played"]
      // `ctx.thisIsCard` is already unconditionally true for EVERY trigger
      // cascadingTriggerBody generates a body for (OnPlay, OnDiscard,
      // OnTurnEndInHand, OnAnyCardPlayed alike — see that function's own
      // ctx construction) — so this branch was ALREADY reachable for
      // OnDiscard/OnTurnEndInHand mechanically; the only thing gating them
      // out was validate.js's own trigger check (now widened below) plus
      // there being no real captured data behind it yet. Direct IL of
      // CardCmd.DiscardAndDraw and CombatManager.DoTurnEndCards this round
      // confirmed both have the exact same "already gone from Hand by the
      // time the real hook fires" timing problem OnPlay had — so two more
      // Harmony prefixes (Generated/ForgeHandPositionDiscardTracker.cs,
      // Generated/ForgeHandPositionTurnEndTracker.cs) now capture the same
      // way, and this branch's `this` is correct for OnDiscard/
      // OnTurnEndInHand too (both are `selfFilter`/single-card triggers on
      // the card's own generated class — see CARD_TRIGGER_HOOKS — so
      // `this` genuinely is the card in question, same as OnPlay).
      // Renamed WasCardAtHandPositionWhenPlayed -> WasCardAtHandPositionOnRemoval
      // (see ForgeActions.cs.template) since "when played" no longer
      // describes all three real capture points.
      //
      // `ctx.targetMayBeNull` [existing flag, reused not new — see its own
      // doc comment above] is true exactly on OnAnyCardPlayed (a card's own
      // reactive hook) and false everywhere else — the one place a
      // `trigger`-like signal is already threaded through this ctx object.
      // On OnAnyCardPlayed, `this` is the REACTING card, not necessarily
      // the one that was played — same reasoning PlayedCardHasTag/Keyword/
      // Type use `cardPlay.Card as IForgeTaggedCard` instead of `this` —
      // so this does the same cast against IForgeHandPosition. On every
      // other real trigger, `this` IS the card in question, so it's used
      // directly (matches Tyler's own Strike card exactly: its OnPlay
      // reads its OWN captured flags).
      // [Round 68] Tyler: "when the 'whenever any card is played'
      // trigger is selected, if the if statement reads 'if [this card]'
      // then the next box should change to 'is in the' instead of 'was
      // in the' since the card in question isn't the one being played
      // and thus has not moved." Before this round, `cond.subject`
      // ('ThisCard'/'ThatCard' — see frontend/index.html's
      // CONDITION_SUBJECTS) was NEVER read here at all: on
      // OnAnyCardPlayed this branch always checked cardPlay.Card (the
      // PLAYED card) no matter which subject the UI had selected, so
      // picking "This Card" under that trigger silently had zero effect
      // on the compiled output. Now: only fall back to `this` (the
      // reacting card's own position, unmoved, "is") when the row
      // explicitly asked for that AND this is actually a card's own
      // effect block in the first place (`ctx.thisIsCard`) — a
      // relic/mechanic reacting to OnAnyCardPlayed has no card `this` to
      // check (it isn't a card at all), so it still safely falls back to
      // cardPlay.Card regardless of whatever subject value got saved on
      // it, same as every version of this code before this round.
      if (ctx.targetMayBeNull) {
        if (cond.subject === 'ThisCard' && ctx.thisIsCard) {
          return `ForgeActions.WasCardAtHandPositionOnRemoval(this, ${fromRight}, ${position}) /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll v4 — Strike's real leftmost/rightmost damage bonus; round 68 — "This Card" on OnAnyCardPlayed checks the REACTING card's own position, not the played card's] */`;
        }
        return `ForgeActions.WasCardAtHandPositionOnRemoval(cardPlay.Card as IForgeHandPosition, ${fromRight}, ${position}) /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll v4 — Strike's real leftmost/rightmost damage bonus] */`;
      }
      if (ctx.thisIsCard) {
        return `ForgeActions.WasCardAtHandPositionOnRemoval(this, ${fromRight}, ${position}) /* [VERIFIED via decompiling TheBurdenedNewCharacter.dll v4 — Strike's real leftmost/rightmost damage bonus; round 56 extended the real capture to OnDiscard/OnTurnEndInHand too via direct IL of CardCmd.DiscardAndDraw/CombatManager.DoTurnEndCards] */`;
      }
      // No real backing left anywhere else — a relic/mechanic modifier
      // hook's own conditions never reach this branch in the first place
      // (its UI always passes trigger:undefined — see
      // frontend/index.html:availableConditionKinds' mod-conditions call
      // site — so validate.js is what actually enforces this, not this
      // fallback).
      return `ForgeActions.TodoCondition("CardPositionInHand(only valid inside Glow/Playability, or a card's own OnPlay/OnDiscard/OnTurnEndInHand/OnAnyCardPlayed — [VERIFIED via decompiling sts2.dll's CardModel.OnPlayWrapper/CardCmd.DiscardAndDraw/CombatManager.DoTurnEndCards] this card has already left the hand pile by the time any other trigger fires)")`;
    }

    default:
      throw new Error(`No C# mapping registered for condition kind "${cond.kind}".`);
  }
}

// [Fix, round 29 — real crash, see TOOLCHAIN_FINDINGS.md] Thin wrapper
// around conditionToCSharpRaw (the actual per-kind switch, renamed from
// this function's old name unchanged otherwise) — every real call site in
// this file already goes through the name `conditionToCSharp`, so nothing
// else needed to change. 5 real condition kinds (HasStatusStacks,
// HpBelowPercent, BlockAmount, DebuffStacks, HasPet) read
// resolveConditionSubjectExpr(cond.subject), which resolves subject
// 'CardTarget' to the same borrowed, possibly-null `fgTarget!` actionToCSharp's
// SingleEnemy guard above was just fixed for. A condition is a boolean
// expression feeding an "If" gate (see effectBlockToCSharp) rather than a
// standalone statement, so the fix here is different in shape but the same
// idea: short-circuit to false instead of dereferencing a null Creature,
// by prefixing `fgTarget != null &&` — this correctly makes the whole gate
// evaluate false (skipping its actions) rather than crash, exactly like a
// real "the enemy this card would have targeted doesn't exist" case should
// behave. Every OTHER ctx (targetMayBeNull unset/false) or subject
// ('Self'/'Pet'/undefined) passes straight through to the raw expression,
// unchanged from before this fix.
function conditionToCSharp(cond, ctx = {}) {
  const raw = conditionToCSharpRaw(cond, ctx);
  if (ctx.targetMayBeNull && cond.subject === 'CardTarget') {
    return `(fgTarget != null && (${raw}))`;
  }
  return raw;
}

// --- hook-driven effects (relics + mechanics) --------------------------------
// Maps the schema's trigger enum onto the REAL BaseLib/MegaCrit hook method,
// with its REAL parameter list — confirmed via tools/reflect-baselib round 2
// (see TOOLCHAIN_FINDINGS.md "reflect-baselib round 2"), which dumped every
// After*/On*/Before* member on CustomRelicModel's full hierarchy directly
// from the real installed sts2.dll/BaseLib.dll. This replaced a previous
// version that used one fixed, entirely made-up signature
// `(PlayerChoiceContext choiceContext, Creature player, Creature? target,
// CardModel? cardSource)` for every hook — that was wrong for essentially
// all of them (most don't even take a PlayerChoiceContext, let alone that
// exact Creature/CardModel shape).
//
// Also used by mechanics (CustomPowerModel) since it shares the same
// AbstractModel-derived hook surface as CustomRelicModel — see
// generateHookEffects below and Power.cs.template.
//
// Deliberately has NO 'OnPlay' entry — caught by a real stress test: a
// relic with trigger "OnPlay" compiled (mapped to AfterCardPlayed) but
// makes no real sense for a relic (a relic isn't "played", and
// AfterCardPlayed actually fires for ANY card ANYONE plays, not something
// intrinsic to the relic — `cardPlay.Target` in that context is
// borrowed from whatever card triggered the hook, not a target the relic
// itself defines, and can be null for an untargeted card play). 'OnPlay'
// is now a card-only trigger (see generateCardSource) — the frontend no
// longer offers it for relics/mechanics, and generateHookEffects below
// throws a clear error as a backstop if one somehow arrives here anyway.
// The relic-appropriate "whenever ANY card is played" trigger flagged
// here as a future idea is now implemented for real, under the clearer
// name "OnAnyCardPlayed" (see the TRIGGER_HOOKS entry below) — same real
// AfterCardPlayed hook, just given its own honest name instead of
// overloading "OnPlay".
//
// Each entry:
//   method  — the real method name [VERIFIED]
//   params  — the real full parameter list, verbatim [VERIFIED]
//   playerExpr/targetExpr — best-effort expressions to populate local
//     `player`/`target` variables from the real parameters, so the rest of
//     this app's effect-block code (which references `player`/`target` by
//     those names) doesn't need trigger-specific logic. `null` means the
//     real parameters don't expose anything we can confidently call
//     "the player" or "the target" — those triggers fall back to
//     ForgeActions.Todo(...) instead of silently binding to the wrong
//     Creature.
const TRIGGER_HOOKS = {
  OnDrawCard: {
    method: 'AfterCardDrawn',
    params: 'PlayerChoiceContext choiceContext, CardModel card, bool fromHandDraw',
    playerExpr: null, targetExpr: null, // no Creature reference in the real params at all
  },
  OnExhaust: {
    method: 'AfterCardExhausted',
    params: 'PlayerChoiceContext choiceContext, CardModel card, bool causedByEthereal',
    playerExpr: null, targetExpr: null,
  },
  // [Fix, round 35 -- Tyler: "we need to take a look at all of the
  // triggers that happen to both the player as well as to the enemies."]
  // OnTurnEnd used to fire once per side (yours AND every enemy side)
  // with no way to tell which apart -- split into two ids on the real
  // `side` param (CombatSide.Player/CombatSide.Enemy, the same real enum
  // Creature.IsEnemy itself compares against -- see AfterMyDamageGiven
  // below for that property's own IL-confirmed evidence).
  //
  // [Fix, round 35 follow-up -- Tyler, asked why these stayed Todo()-only
  // stubs: "the player and pet all take their turn at the same time. all
  // enemies take their turn at the same time as well."] That's the real
  // reason `participants` is a COLLECTION and not a single Creature --
  // it's not an API gap, it's the real game mechanic (everyone on a side
  // genuinely acts at once). `collectionExpr` (below) drives
  // generateHookEffects to emit a real `foreach (var fgPlayer in
  // participants) { ... }` around each effect's own action body -- the
  // same real pattern already proven for AllEnemies targeting (round 24,
  // actionToCSharp's own AllEnemies case) -- instead of an unconditional
  // Todo() stub. No fgTarget is bound (there's no second Creature in this
  // shape, just the one collection), so this behaves like every other
  // single-Creature-bound ('player'-shape) hook for validation/UI
  // purposes -- see backend/validate.js's TARGETLESS_BOUND_HOOK_TRIGGERS/
  // NO_CHOICE_CONTEXT_HOOK_TRIGGERS (now both derived off `playerExpr ||
  // collectionExpr`) and frontend/index.html's HOOK_TRIGGER_BINDING
  // (these 4 ids are 'player' there now, not 'unbound').
  OnMyTurnEnd: {
    method: 'AfterSideTurnEnd',
    params: 'PlayerChoiceContext choiceContext, CombatSide side, IEnumerable<Creature> participants',
    playerExpr: null, targetExpr: null,
    collectionExpr: 'participants', // real param name, IEnumerable<Creature> -- see AfterSideTurnEnd's own params above
    guardExpr: 'side == CombatSide.Player',
  },
  OnEnemyTurnEnd: {
    method: 'AfterSideTurnEnd',
    params: 'PlayerChoiceContext choiceContext, CombatSide side, IEnumerable<Creature> participants',
    playerExpr: null, targetExpr: null,
    collectionExpr: 'participants',
    guardExpr: 'side == CombatSide.Enemy',
  },
  // [Fix, round 35 (+ follow-up)] Same OnTurnEnd split/collection-loop
  // above, mirrored for turn start -- see that entry's comment for the
  // full reasoning. One real difference: AfterSideTurnStart's own params
  // have NO PlayerChoiceContext at all (unlike AfterSideTurnEnd, which
  // has one) -- so DealDamage/ModifyStatus-AllEnemies stay unavailable
  // here specifically (NO_CHOICE_CONTEXT_HOOK_TRIGGERS picks this up
  // automatically once derived off collectionExpr too).
  OnMyTurnStart: {
    method: 'AfterSideTurnStart',
    params: 'CombatSide side, IReadOnlyList<Creature> participants, ICombatState combatState',
    playerExpr: null, targetExpr: null, // also note: NO PlayerChoiceContext param at all on this one
    collectionExpr: 'participants', // real param name, IReadOnlyList<Creature> -- see AfterSideTurnStart's own params above
    guardExpr: 'side == CombatSide.Player',
  },
  OnEnemyTurnStart: {
    method: 'AfterSideTurnStart',
    params: 'CombatSide side, IReadOnlyList<Creature> participants, ICombatState combatState',
    playerExpr: null, targetExpr: null,
    collectionExpr: 'participants',
    guardExpr: 'side == CombatSide.Enemy',
  },
  OnCombatStart: {
    // [BEST EFFORT remap] no "AfterCombatStart" exists anywhere in the real
    // dump — only `BeforeCombatStart()`/`BeforeCombatStartLate()` (no
    // params). Remapped to the closest real analog.
    method: 'BeforeCombatStart',
    params: '',
    playerExpr: null, targetExpr: null,
  },
  OnKillEnemy: {
    // [BEST EFFORT remap] no "AfterEnemyKilled" exists either — closest
    // real analog is AfterDeath, which fires for ANY creature's death
    // (ally or enemy), not just enemies. No confirmed way to filter to
    // "enemy specifically" from these params, so left as Todo rather than
    // risk firing this effect on the player's own death too.
    method: 'AfterDeath',
    params: 'PlayerChoiceContext choiceContext, Creature creature, bool wasRemovalPrevented, float deathAnimLength',
    playerExpr: null, targetExpr: null,
  },
  // [Fix, round 35] Mine/Enemy split via the real, IL-confirmed
  // Creature.IsEnemy property (MegaCrit.Sts2.Core.Entities.Creatures.
  // Creature -- direct IL read confirms `return Side == CombatSide.Enemy;`,
  // methoddef rid 20937 -- [VERIFIED via direct sts2.dll read]) on fgPlayer
  // (= target = whoever received the damage). fgTarget (= dealer) is still
  // bound either way. Old id `OnTakeDamage` retired -- fail loud, per
  // Tyler's own migration choice, rather than silently guessing a side.
  OnMyDamageTaken: {
    method: 'AfterDamageReceived',
    params: 'PlayerChoiceContext choiceContext, Creature target, DamageResult result, ValueProp props, Creature dealer, CardModel cardSource',
    playerExpr: 'target', targetExpr: 'dealer',
    guardExpr: '!fgPlayer.IsEnemy',
  },
  OnEnemyDamageTaken: {
    method: 'AfterDamageReceived',
    params: 'PlayerChoiceContext choiceContext, Creature target, DamageResult result, ValueProp props, Creature dealer, CardModel cardSource',
    playerExpr: 'target', targetExpr: 'dealer',
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [VERIFIED via reflect-baselib round 2, re-confirmed round 9]
  // AfterCardPlayed was sitting in round 2's own CustomCardModel *Play*
  // sweep the whole time (it's declared on AbstractModel, same as the
  // already-wired card/relic hooks) — never wired up as a selectable
  // trigger because OnPlay seemed to already cover "when played." It
  // doesn't: this fires for ANY card played by ANYONE, which is exactly
  // the "whenever a tagged card is played, this relic/power reacts"
  // mechanic Tyler asked about after seeing it in slay.spencerstiles.com
  // and confirming the pattern directly in his own TheTrainerNewCharacter
  // mod (several Pokemon cards there override this exact hook). Same real
  // `CardPlay` shape as OnPlay itself, so player/target binding is real
  // here too — not a Todo fallback like most of this map's other entries.
  OnAnyCardPlayed: {
    method: 'AfterCardPlayed',
    params: 'PlayerChoiceContext choiceContext, CardPlay cardPlay',
    playerExpr: 'cardPlay.Player.Creature', // [VERIFIED via reflect-baselib round 5] same expression OnPlay itself uses
    targetExpr: 'cardPlay.Target', // [VERIFIED via reflect-baselib round 3]
    petExpr: 'cardPlay.Player.Osty', // [VERIFIED via reflect-baselib round 5] see PET_SUPPORTED_TRIGGERS above — cardPlay.Player is only reachable here and on a card's own OnPlay
    cardPlayBound: true, // a real `cardPlay` local (this hook's own param) is in scope — see effectBlockToCSharp's `ctx` doc comment
    targetMayBeNull: true, // [Fix, round 29 — real crash: TestChar.Relics.Group1Relic.AfterCardPlayed -> CreatureCmd.Stun(null, ...) NullReferenceException, see TOOLCHAIN_FINDINGS.md] cardPlay.Target here is whoever the TRIGGERING card (which might be ANY card, not one this relic/mechanic defines) was played against — genuinely null for an untargeted card play (confirmed via real godot.log: "Player 1 playing card TESTCHAR-DEFEND_CARD (no target)"). Consumed by actionToCSharp's SingleEnemy guard and conditionToCSharp's CardTarget guard below, instead of trusting the old `fgTarget!` null-forgiving cast.
  },
  // --- Round 19 additions: 39 real hooks confirmed via direct sts2.dll read
  // against MegaCrit.Sts2.Core.Models.AbstractModel (the REAL override surface
  // — see round19_hook_review.md; an earlier pass mistakenly read a different,
  // lower-level class named Hook that shares method names but not signatures).
  // player/target binding follows the same conservative convention as every
  // existing entry above: only bound when a real param unambiguously identifies
  // who's who, Todo() fallback otherwise. All [VERIFIED via direct sts2.dll read].
  AfterActEntered: {
    method: 'AfterActEntered',
    params: '',
    playerExpr: null, targetExpr: null, // Turn/run lifecycle — a new Act begins. No params at all.
  },
  AfterAttack: {
    method: 'AfterAttack',
    params: 'PlayerChoiceContext choiceContext, AttackCommand command',
    playerExpr: null, targetExpr: null, // Attack-command level (broader than Deal Damage's own followUp) — no Creature exposed on the command param itself.
  },
  // [Fix, round 35] Mine/Enemy split via Creature.IsEnemy -- see
  // OnMyDamageTaken above for the real IL evidence, same mechanism reused
  // for every split in this file. fgPlayer is still bound from the single
  // real `creature` param either way; guardExpr filters which side's
  // block-clear actually runs this effect's actions.
  AfterMyBlockCleared: {
    method: 'AfterBlockCleared',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterEnemyBlockCleared: {
    method: 'AfterBlockCleared',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Fix, round 35] Mine/Enemy split -- see AfterMyBlockCleared above.
  AfterMyBlockGained: {
    method: 'AfterBlockGained',
    params: 'Creature creature, decimal amount, ValueProp props, CardModel cardSource',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterEnemyBlockGained: {
    method: 'AfterBlockGained',
    params: 'Creature creature, decimal amount, ValueProp props, CardModel cardSource',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Fix, round 35 -- Tyler's own example: "'After block is broken'
  // currently triggers on when your block or when an enemy's block is
  // broken. Those should be two separate triggers."] Mine/Enemy split via
  // Creature.IsEnemy on fgPlayer (= target = whose block broke) -- same
  // mechanism as AfterMyBlockCleared above. fgTarget (= breaker) is still
  // bound either way.
  AfterMyBlockBroken: {
    method: 'AfterBlockBroken',
    params: 'PlayerChoiceContext choiceContext, Creature target, Creature breaker',
    playerExpr: 'target', targetExpr: 'breaker',
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterEnemyBlockBroken: {
    method: 'AfterBlockBroken',
    params: 'PlayerChoiceContext choiceContext, Creature target, Creature breaker',
    playerExpr: 'target', targetExpr: 'breaker',
    guardExpr: 'fgPlayer.IsEnemy',
  },
  AfterCardGeneratedForCombat: {
    method: 'AfterCardGeneratedForCombat',
    params: 'CardModel card, Player creator',
    playerExpr: 'creator.Creature', targetExpr: null, // creator — bound as fgPlayer via .Creature, same pattern OnAnyCardPlayed's cardPlay.Player.Creature already uses.
  },
  AfterCombatEnd: {
    method: 'AfterCombatEnd',
    params: 'CombatRoom room',
    playerExpr: null, targetExpr: null, // No Creature/Player exposed.
  },
  AfterCombatVictory: {
    method: 'AfterCombatVictory',
    params: 'CombatRoom room',
    playerExpr: null, targetExpr: null, // No Creature/Player exposed.
  },
  // [Fix, round 35 -- Tyler: "aftercreatureaddedtocombat should not
  // check for you entering combat. there should already be an 'at the
  // beginning of combat' trigger."] He's right: the player is only ever
  // "added to combat" once, at combat start -- already covered by
  // OnCombatStart (BeforeCombatStart, above) -- so a "Mine" variant of
  // this hook would be a redundant, always-fires-alongside-OnCombatStart
  // no-op. Repurposed to ENEMY-ONLY instead of split in two: this is
  // where a mid-combat summon (an enemy added after combat already
  // started) becomes reachable as its own real, honestly-named trigger,
  // with no meaningless "mine" sibling cluttering the picker. Old id
  // `AfterCreatureAddedToCombat` retired -- this is NOT a rename (fail
  // loud, same as every other split this round): its semantics actually
  // changed (used to also fire for the player entering combat), so an old
  // package using it must be re-picked by hand, not silently remapped.
  AfterEnemyAddedToCombat: {
    method: 'AfterCreatureAddedToCombat',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Fix, round 35] Mine/Enemy split -- see AfterMyBlockCleared above.
  AfterMyCurrentHpChanged: {
    method: 'AfterCurrentHpChanged',
    params: 'Creature creature, decimal delta',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterEnemyCurrentHpChanged: {
    method: 'AfterCurrentHpChanged',
    params: 'Creature creature, decimal delta',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Fix, round 35] Mine/Enemy split via Creature.IsEnemy on fgPlayer
  // (= dealer, this hook's own GIVER-perspective binding -- see the
  // original comment below, unchanged). fgTarget (= target, the one who
  // received the damage) is still bound either way. NOTE: this trigger id
  // is also a TRIGGER_SELF_LOOP_ACTIONS key (round 33/34's DealDamage
  // infinite-loop check, see validate.js) -- both new ids below carry the
  // exact same real danger (a DealDamage action still re-fires this same
  // real hook regardless of which side triggered it), so
  // backend/validate.js's table is updated to key off both new ids
  // instead of the old single one.
  AfterMyDamageGiven: {
    method: 'AfterDamageGiven',
    params: 'PlayerChoiceContext choiceContext, Creature dealer, DamageResult result, ValueProp props, Creature target, CardModel cardSource',
    playerExpr: 'dealer', targetExpr: 'target', // This hook's own name is from the GIVER's perspective — dealer bound as fgPlayer, target as fgTarget (opposite direction from OnMyDamageTaken/OnEnemyDamageTaken, which are from the RECEIVER's perspective).
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterEnemyDamageGiven: {
    method: 'AfterDamageGiven',
    params: 'PlayerChoiceContext choiceContext, Creature dealer, DamageResult result, ValueProp props, Creature target, CardModel cardSource',
    playerExpr: 'dealer', targetExpr: 'target',
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Fix, round 35 -- Tyler's own example, same request as
  // AfterBlockBroken above: "The same is true for 'Before damage is
  // received'."] Mine/Enemy split via Creature.IsEnemy on fgPlayer
  // (= target = who is about to receive the damage). fgTarget (= dealer)
  // is still bound either way.
  BeforeMyDamageReceived: {
    method: 'BeforeDamageReceived',
    params: 'PlayerChoiceContext choiceContext, Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource',
    playerExpr: 'target', targetExpr: 'dealer', // Same real params/binding direction as OnMyDamageTaken/OnEnemyDamageTaken (AfterDamageReceived), just the Before variant.
    guardExpr: '!fgPlayer.IsEnemy',
  },
  BeforeEnemyDamageReceived: {
    method: 'BeforeDamageReceived',
    params: 'PlayerChoiceContext choiceContext, Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource',
    playerExpr: 'target', targetExpr: 'dealer',
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Fix, round 35] Mine/Enemy split -- see AfterMyBlockCleared above.
  BeforeMyDeath: {
    method: 'BeforeDeath',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: '!fgPlayer.IsEnemy',
  },
  BeforeEnemyDeath: {
    method: 'BeforeDeath',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  AfterDiedToDoom: {
    method: 'AfterDiedToDoom',
    params: 'PlayerChoiceContext choiceContext, IReadOnlyList<Creature> creatures',
    playerExpr: null, targetExpr: null, // A COLLECTION of creatures (multi-kill 'Doom' mechanic), not a single Creature.
  },
  AfterEnergyReset: {
    method: 'AfterEnergyReset',
    params: 'Player player',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterEnergySpent: {
    method: 'AfterEnergySpent',
    params: 'CardModel card, int amount',
    playerExpr: null, targetExpr: null, // No Creature/Player exposed.
  },
  AfterGoldGained: {
    method: 'AfterGoldGained',
    params: 'Player player',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  // [Round 199 -- "build out the full affliction section"] BeforeFlush/
  // AfterFlush are REAL, both [VERIFIED via direct ECMA-335 metadata read
  // of the real installed sts2.dll/MegaCrit.Sts2.Core.dll this round] --
  // declared on MegaCrit.Sts2.Core.Models.AbstractModel itself (newslot,
  // virtual, public), NOT AfflictionModel specifically, so every entity
  // kind that already has access to TRIGGER_HOOKS (relics, mechanics, and
  // now afflictions -- see generateHookEffects' entityKind === 'affliction'
  // handling below) gets these too. Discovered while investigating a real,
  // working custom Affliction (Afflictions/Reckless.cs, rounds 197/198's
  // reference project on Tyler's own machine) whose real, compiled
  // BeforeFlush(PlayerChoiceContext, Player) override clears its own
  // affliction from the player's whole hand if its card never got played
  // that turn -- "Flush" is this game's term for that end-of-turn
  // unplayed-hand-discard step. `player.Creature` binding is the same
  // real Player.Creature property AfterGoldGained above already uses.
  BeforeFlush: {
    method: 'BeforeFlush',
    params: 'PlayerChoiceContext choiceContext, Player player',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterFlush: {
    // Real params also include `IReadOnlyCollection<CardModel> flushedCards,
    // IReadOnlyCollection<CardModel> retainedCards` -- no confirmed way to
    // bind either as a single fgTarget-style Creature, so they're left out
    // of `params` reaching the generated method signature would need them
    // typed correctly anyway; omitted here means this hook fires but those
    // two collections aren't reachable from Forge's own action vocabulary
    // yet -- same honest scope-limiting as every other collectionless hook.
    method: 'AfterFlush',
    params: 'PlayerChoiceContext choiceContext, Player player, System.Collections.Generic.IReadOnlyCollection<CardModel> flushedCards, System.Collections.Generic.IReadOnlyCollection<CardModel> retainedCards',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  BeforeHandDraw: {
    method: 'BeforeHandDraw',
    params: 'Player player, PlayerChoiceContext choiceContext, ICombatState combatState',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterHandEmptied: {
    method: 'AfterHandEmptied',
    params: 'PlayerChoiceContext choiceContext, Player player',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterItemPurchased: {
    method: 'AfterItemPurchased',
    params: 'Player player, MerchantEntry itemPurchased, int goldSpent',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterModifyingCardPlayCount: {
    method: 'AfterModifyingCardPlayCount',
    params: 'CardModel card',
    playerExpr: null, targetExpr: null, // No Creature/Player exposed.
  },
  AfterPreventingDraw: {
    method: 'AfterPreventingDraw',
    params: '',
    playerExpr: null, targetExpr: null, // No params at all.
  },
  AfterOrbChanneled: {
    method: 'AfterOrbChanneled',
    params: 'PlayerChoiceContext choiceContext, Player player, OrbModel orb',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterOrbEvoked: {
    method: 'AfterOrbEvoked',
    params: 'PlayerChoiceContext choiceContext, OrbModel orb, IEnumerable<Creature> targets',
    playerExpr: null, targetExpr: null, // A COLLECTION of creatures (an orb can evoke onto multiple targets), not a single Creature.
  },
  BeforePotionUsed: {
    method: 'BeforePotionUsed',
    params: 'PotionModel potion, Creature target',
    playerExpr: 'target', targetExpr: null, // Single Creature — bound as fgPlayer.
  },
  AfterPotionUsed: {
    method: 'AfterPotionUsed',
    params: 'PotionModel potion, Creature target',
    playerExpr: 'target', targetExpr: null, // Single Creature — bound as fgPlayer.
  },
  AfterPotionDiscarded: {
    method: 'AfterPotionDiscarded',
    params: 'PotionModel potion',
    playerExpr: null, targetExpr: null, // No Creature/Player exposed.
  },
  AfterPotionProcured: {
    method: 'AfterPotionProcured',
    params: 'PotionModel potion',
    playerExpr: null, targetExpr: null, // No Creature/Player exposed.
  },
  // [Fix, round 35] Mine/Enemy split via Creature.IsEnemy on fgPlayer
  // (= applier -- the one who APPLIED the power change, NOT the power's
  // own holder, which still isn't exposed by this real hook -- see the
  // original comment below, unchanged, and the matching label/hint text
  // in frontend/index.html which spells this distinction out for the
  // user). NOTE: also a TRIGGER_SELF_LOOP_ACTIONS key (round 34's
  // ModifyStatus/AllEnemies infinite-loop check, see validate.js) -- both
  // new ids below carry the same real danger regardless of side, table
  // updated to key off both.
  AfterMyPowerAmountChanged: {
    method: 'AfterPowerAmountChanged',
    params: 'PlayerChoiceContext choiceContext, PowerModel power, decimal amount, Creature applier, CardModel cardSource',
    playerExpr: 'applier', targetExpr: null, // applier — bound as fgPlayer (single Creature; the power's own holder isn't exposed here, only who applied it).
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterEnemyPowerAmountChanged: {
    method: 'AfterPowerAmountChanged',
    params: 'PlayerChoiceContext choiceContext, PowerModel power, decimal amount, Creature applier, CardModel cardSource',
    playerExpr: 'applier', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  // [Round 276] Tyler: "the burdened new character dll file contains a
  // fatigue status. It checks for 'if stacks of this status are added'
  // can we add that hook as well as a 'when stacks of this status are
  // removed' hook?" -- direct evidence from TWO real sources:
  //
  // 1. TheBurdenedNewCharacter.Powers.FatiguePower's real, compiled
  //    AfterPowerAmountChanged override (disassembled via
  //    tools/sts2tools/il_dump.py) gates its whole body on
  //    `power == this && amount > 0` before doing anything -- i.e. "this
  //    exact status instance's own stacks, and only when they went UP."
  //    `power == this` is REQUIRED, not defensive boilerplate: confirmed
  //    by direct sts2.dll IL read of PowerCmd.ModifyAmount, which calls
  //    the real `MegaCrit.Sts2.Core.Hooks.Hook.AfterPowerAmountChanged`
  //    STATIC dispatcher (same class/pattern already documented above at
  //    TRIGGER_SELF_LOOP_ACTIONS' AfterDamageGiven entry) -- a real,
  //    global broadcast to every hook listener in combat, not scoped to
  //    the power that actually changed. Without the self-check, THIS
  //    hook fires for every status change on EITHER side, which is
  //    exactly the existing (unfiltered) AfterMyPowerAmountChanged/
  //    AfterEnemyPowerAmountChanged behavior above.
  //
  // 2. Same IL read confirms `amount` is a real signed delta (decimal):
  //    PowerCmd.ModifyAmount computes `newAmount = power.Amount +
  //    (decimal)modifiedOffset` BEFORE calling SetAmount, and only AFTER
  //    that calls Hook.AfterPowerAmountChanged with that same offset as
  //    `amount` -- so `amount > 0` genuinely means "stacks just went up"
  //    and `amount < 0` means "stacks just went down," exactly the two
  //    directions FatiguePower itself branches on.
  //
  // No separate native "stacks added"/"stacks removed" hook exists --
  // both of these compile to the SAME real AfterPowerAmountChanged
  // method as the pair above, merged into one generated override by
  // generateHookEffects' methodGroups (see that function's own comment).
  // Design call confirmed with Tyler via AskUserQuestion: no Mine/Enemy
  // split here (unlike the pair above) -- FatiguePower's own code never
  // checks who applied the change, only that it's THIS status and the
  // direction, so that's exactly what's implemented. `applier` stays
  // bound as fgPlayer regardless (same real single-Creature binding the
  // pair above already has) so effect actions can still reference it.
  AfterThisPowerStacksAdded: {
    method: 'AfterPowerAmountChanged',
    params: 'PlayerChoiceContext choiceContext, PowerModel power, decimal amount, Creature applier, CardModel cardSource',
    playerExpr: 'applier', targetExpr: null,
    guardExpr: 'power == this && amount > 0',
  },
  AfterThisPowerStacksRemoved: {
    method: 'AfterPowerAmountChanged',
    params: 'PlayerChoiceContext choiceContext, PowerModel power, decimal amount, Creature applier, CardModel cardSource',
    playerExpr: 'applier', targetExpr: null,
    guardExpr: 'power == this && amount < 0',
  },
  // [Round 277] Tyler: "lets do 2 more for 'when this status is applied'
  // and 'when this status is removed'". Direct sts2.dll evidence,
  // disassembled from PowerCmd.Apply/PowerCmd.Remove's real async bodies:
  //
  // - PowerCmd.Apply(...) -- the real call ForgeActions.ApplyStatus<T>
  //   uses -- first checks PowerCmd.FindExistingInstanceForStacking(...).
  //   If an existing instance is found (this status is ALREADY on the
  //   target), it just calls PowerCmd.ModifyAmount(...) instead -- the
  //   exact same real method AfterThisPowerStacksAdded/Removed and
  //   AfterMyPowerAmountChanged/AfterEnemyPowerAmountChanged above are
  //   built on. Only when NO existing instance is found (genuinely new
  //   to this target) does it go on to call, directly on the new power
  //   instance (`power.BeforeApplied(...)` / `power.AfterApplied(...)`,
  //   both real `callvirt`s on `power` itself -- NOT the static, global
  //   `Hook.*` broadcast dispatcher AfterPowerAmountChanged/AfterApplied's
  //   OWN cousins BeforePowerAmountChanged/etc. go through). That means
  //   AfterApplied is inherently self-scoped already -- fires exactly
  //   once, only on THIS instance, only the first time this status
  //   attaches to a creature -- no `power == this` guard needed (there's
  //   no `power` param at all; the method is called ON the instance).
  //   Confirmed via PowerModel.ApplyInternal's own IL: it calls
  //   `set_Owner(target)` BEFORE PowerCmd.Apply ever reaches the
  //   AfterApplied call, so `Owner` (a real, public, Creature-typed
  //   property already relied on elsewhere -- see resolvePlayerExpr's
  //   round-26 comment) is safely readable by the time this hook runs.
  //   Real signature: AfterApplied(Creature applier, CardModel
  //   cardSource) -- no target/owner param at all, unlike AfterRemoved
  //   below, which is why Owner (not one of this method's own params) is
  //   what's bound here -- strictly better than the "applier" binding
  //   the older hooks above are stuck with (their real params never
  //   exposed the status's own holder at all -- this one's `this.Owner`
  //   genuinely does).
  //
  // - PowerCmd.Remove(PowerModel power) calls `power.RemoveInternal()`
  //   then, directly on that same instance, `power.AfterRemoved(power.
  //   Owner)` -- also a real instance `callvirt`, not the static
  //   dispatcher, so also inherently self-scoped with no guard needed.
  //   PowerModel.RemoveInternal's own IL confirmed it never clears
  //   Owner, so the value PowerCmd.Remove re-reads and passes as the
  //   real `owner` parameter is genuinely the creature this status was
  //   just removed from.
  //
  // Infinite-loop check (same discipline as TRIGGER_SELF_LOOP_ACTIONS):
  // unlike AfterPowerAmountChanged (which the real ModifyAmount path
  // fires UNCONDITIONALLY on every stack change, new or existing --
  // proven genuinely unbounded when its own effect reapplies the same
  // status to AllEnemies), AfterApplied only fires the FIRST time a
  // given creature receives this status -- a same-status "Apply to All
  // Enemies" action from inside this trigger's own effect would, for any
  // enemy that already has an instance, route through ModifyAmount
  // instead (per FindExistingInstanceForStacking above), which does NOT
  // call AfterApplied again. So this is self-limiting (bounded by "how
  // many creatures don't yet have this status"), not a proven
  // unconditional loop -- deliberately NOT added to
  // backend/validate.js's TRIGGER_SELF_LOOP_ACTIONS without real
  // evidence of an actual unbounded cycle, same "don't guess a
  // restriction" discipline as ModifyHp's LoseHp path.
  AfterThisPowerApplied: {
    method: 'AfterApplied',
    params: 'Creature applier, CardModel cardSource',
    playerExpr: 'Owner', targetExpr: null, // Owner, not one of this method's own params -- see the comment above.
  },
  AfterThisPowerRemoved: {
    method: 'AfterRemoved',
    params: 'Creature owner',
    playerExpr: 'owner', targetExpr: null,
  },
  // [Fix, round 35] Mine/Enemy split -- see AfterMyBlockCleared above.
  AfterPreventingMyDeath: {
    method: 'AfterPreventingDeath',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: '!fgPlayer.IsEnemy',
  },
  AfterPreventingEnemyDeath: {
    method: 'AfterPreventingDeath',
    params: 'Creature creature',
    playerExpr: 'creature', targetExpr: null,
    guardExpr: 'fgPlayer.IsEnemy',
  },
  AfterRestSiteHeal: {
    method: 'AfterRestSiteHeal',
    params: 'Player player, bool isMimicked',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterRestSiteSmith: {
    method: 'AfterRestSiteSmith',
    params: 'Player player',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterShuffle: {
    method: 'AfterShuffle',
    params: 'PlayerChoiceContext choiceContext, Player shuffler',
    playerExpr: 'shuffler.Creature', targetExpr: null,
  },
  AfterStarsSpent: {
    method: 'AfterStarsSpent',
    params: 'int amount, Player spender',
    playerExpr: 'spender.Creature', targetExpr: null,
  },
  AfterStarsGained: {
    method: 'AfterStarsGained',
    params: 'int amount, Player gainer',
    playerExpr: 'gainer.Creature', targetExpr: null,
  },
  AfterSummon: {
    method: 'AfterSummon',
    params: 'PlayerChoiceContext choiceContext, Player summoner, decimal amount',
    playerExpr: 'summoner.Creature', targetExpr: null,
  },
  BeforeSideTurnStart: {
    method: 'BeforeSideTurnStart',
    params: 'PlayerChoiceContext choiceContext, CombatSide side, IReadOnlyList<Creature> participants, ICombatState combatState',
    playerExpr: null, targetExpr: null, // A COLLECTION (participants), not a single Creature — same reasoning as the already-shipped OnTurnStart (AfterSideTurnStart).
  },
  AfterPlayerTurnStart: {
    method: 'AfterPlayerTurnStart',
    params: 'PlayerChoiceContext choiceContext, Player player',
    playerExpr: 'player.Creature', targetExpr: null,
  },
  AfterCardDiscarded: {
    method: 'AfterCardDiscarded',
    params: 'PlayerChoiceContext choiceContext, CardModel card',
    playerExpr: null, targetExpr: null, // NEW for relics/mechanics — this exact hook already backs cards' own OnDiscard (CARD_TRIGGER_HOOKS) but had no relic/mechanic-level 'any card discarded' trigger until now (the parallel to OnAnyCardPlayed). Real params have no CardPlay/Creature.
  },
  // --- Round 20 addition: AfterForge, a real Task-returning AbstractModel
  // hook that got missed entirely by Round 19's review (it was mistakenly
  // filed into the reconstructed "Group B" list even though it returns
  // Task, not a value — caught by cross-checking Tyler's reconstructed
  // hook list against a fresh direct sts2.dll read; see
  // claude/round20-groupb-findings.md). [VERIFIED via direct sts2.dll
  // read.] Single real `Player forger` param — same player-only-bound
  // shape as AfterGoldGained/AfterEnergyReset above.
  AfterForge: {
    method: 'AfterForge',
    params: 'decimal amount, Player forger, AbstractModel source',
    playerExpr: 'forger.Creature', targetExpr: null,
  },
  // Passive has no hook override in this model — see generateHookEffects.
};

// [VERIFIED via direct ECMA-335 metadata read of the real installed
// sts2.dll, 2026-09-22] The 9 real, concrete subclasses of
// MegaCrit.Sts2.Core.Entities.RestSite.RestSiteOption (the abstract base
// itself has a protected ctor -- can't be instantiated directly). Every
// one of these 9 has a real, PUBLIC `.ctor(Player)` constructor -- dumped
// directly off sts2.dll's own MethodDef table, not inferred -- so this is
// a closed, confirmed vocabulary, same shape as BUILTIN_POWER_CLASS_MAP
// above. Used by MODIFIER_HOOKS.TryModifyRestSiteOptions' 'restSiteOption'
// shape below.
const BUILTIN_REST_SITE_OPTION_CLASS_MAP = {
  Clone: 'CloneRestSiteOption',
  Cook: 'CookRestSiteOption',
  Dig: 'DigRestSiteOption',
  Hatch: 'HatchRestSiteOption',
  Heal: 'HealRestSiteOption',
  Kindle: 'KindleRestSiteOption',
  Lift: 'LiftRestSiteOption',
  Mend: 'MendRestSiteOption',
  Smith: 'SmithRestSiteOption',
};

// --- Group B: value-returning AbstractModel hooks (modifiers/gates, NOT
// events) --------------------------------------------------------------
// Round 20 (2026-08-25). Round 19's own working notes for these ("37 value-
// returning hooks") never actually made it into any persisted file — see
// claude/round20-groupb-findings.md for the full story. Tyler reconstructed
// his approved list from memory; every one of the 37 real hooks on it
// (38 minus AfterForge, which is actually a Task-returning Group A hook —
// see above) was independently cross-checked against a fresh direct
// sts2.dll read before being added here, using the same rebuilt
// sts2tools/ecma_dump.py that reproduced every existing TRIGGER_HOOKS
// entry byte-identical.
//
// 33 of the 37 get real, working codegen now. 4 are real, verified hooks
// that Tyler approved but which still need more research/design before
// they can compile to anything but an honest stub (see `shape: 'deferred'`
// below, and each entry's own `reason`) — two need a real "construct a new
// CardModel" mechanism Forge doesn't have yet (same open gap as the
// existing CreateCardInHand/CreateCardInDrawPile backlog item), one needs
// a confirmed ad-hoc LocString authoring path (its real ctor signature —
// LocString(string locTable, string locEntryKey) — is now confirmed, but
// not the mod-authoring convention for a fresh custom entry), and one
// (ModifyShuffleOrder) has a fully-confirmed real API but needs its own
// authoring-UI design pass, not just a value-editor field — deliberately
// left deferred, not attempted this round (Tyler's own call, scope check
// via AskUserQuestion).
//
// [2026-09-23] ModifyCardPlayResultLocation moved from 'deferred' to a
// real 'cardLocation' shape this round — Tyler pointed at a relic from a
// different, unrelated STS2 character-creator tool ("Test Relic") whose
// playedCardDestination modifier is exactly this hook. Its evidence was
// already fully closed last round; this round just adds the missing
// destPile/destPosition authoring fields — see MODIFIER_HOOKS'
// ModifyCardPlayResultLocation entry and generateModifierOverrides'
// 'cardLocation' branch below.
//
// [2026-09-22] TryModifyRestSiteHealRewards and TryModifyRestSiteOptions
// moved from 'deferred' to real, closed-vocabulary shapes this round —
// see BUILTIN_REST_SITE_OPTION_CLASS_MAP above and 'restSiteReward'/
// 'restSiteOption' below. Reward itself is abstract with a protected ctor
// (can't construct a bare Reward), but GoldReward — one of its 6 concrete
// subclasses — has a real, public `.ctor(int amount, Player player, bool
// wasGoldStolenBack)`, confirmed via direct sts2.dll read; the other 5
// subclasses (CardReward/RelicReward/PotionReward/CardRemovalReward/
// SpecialCardReward) weren't investigated this round, so only Gold is
// offered for now.
//
// Six shapes, by return type — see claude/round20-groupb-findings.md's
// design proposal for the original four's full reasoning:
//   'gate'          — bool, no output param. Force Allow/Prevent when
//                      conditions match, else fall through to `base`.
//   'numeric'        — int/decimal, takes the current value as a param.
//                      Always reads `base.<Method>(...)` first (so this
//                      composes safely with other mods / the base game),
//                      then applies Add/Multiply/Set only when conditions
//                      match. `lockedOp` is set (and the UI can't override
//                      it) for the 4 hooks whose real name already commits
//                      to Additive or Multiplicative — using the OTHER
//                      operation there would contradict what the hook's
//                      own name promises the base game/other mods.
//   'tryRefNumeric'  — bool + a `ref decimal` param. Reads `base` first
//                      (preserves the ref value even when not overriding),
//                      sets the ref + returns true when conditions match,
//                      else returns base's own bool.
//   'keywordSet'     — bool + a mutable `ISet<CardKeyword>` param (no
//                      `ref` needed — a set mutates through reference
//                      semantics). Add/Remove one of the 7 real
//                      CardKeyword values when conditions match.
//   'restSiteOption' — bool + a mutable `ICollection<RestSiteOption>`
//                      param. Add/Remove one of the 9 real built-in
//                      RestSiteOption types (BUILTIN_REST_SITE_OPTION_CLASS_MAP
//                      above) when conditions match — same reference-
//                      mutation reasoning as keywordSet.
//   'restSiteReward' — bool + a mutable `List<Reward>` param. Add a new
//                      real GoldReward(amount, player, false), or remove
//                      any existing GoldReward entries, when conditions
//                      match — see the 2026-09-22 note above for why only
//                      Gold is offered.
//   'deferred'       — real hook, not compiled yet. Emits an honest
//                      ForgeActions.Todo(...) stub carrying the reason,
//                      same "compiles but throws" convention as every
//                      other [UNVERIFIED] member in this file.
const MODIFIER_HOOKS = {
  // ---- Boolean gates (8) ----
  ShouldPlay: { method: 'ShouldPlay', ret: 'bool', params: 'CardModel card, AutoPlayType autoPlayType', shape: 'gate', playerExpr: null, targetExpr: null },
  ShouldDie: { method: 'ShouldDie', ret: 'bool', params: 'Creature creature', shape: 'gate', playerExpr: 'creature', targetExpr: null },
  ShouldClearBlock: { method: 'ShouldClearBlock', ret: 'bool', params: 'Creature creature', shape: 'gate', playerExpr: 'creature', targetExpr: null },
  ShouldDraw: { method: 'ShouldDraw', ret: 'bool', params: 'Player player, bool fromHandDraw', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldAllowHitting: { method: 'ShouldAllowHitting', ret: 'bool', params: 'Creature creature', shape: 'gate', playerExpr: 'creature', targetExpr: null },
  ShouldPlayerResetEnergy: { method: 'ShouldPlayerResetEnergy', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldPayExcessEnergyCostWithStars: { method: 'ShouldPayExcessEnergyCostWithStars', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldCreatureBeRemovedFromCombatAfterDeath: { method: 'ShouldCreatureBeRemovedFromCombatAfterDeath', ret: 'bool', params: 'Creature creature', shape: 'gate', playerExpr: 'creature', targetExpr: null },

  // ---- Numeric modifiers (17) ----
  ModifyBlockAdditive: { method: 'ModifyBlockAdditive', ret: 'decimal', params: 'Creature target, decimal block, ValueProp props, CardModel cardSource, CardPlay cardPlay', shape: 'numeric', valueParam: 'block', lockedOp: 'Add', playerExpr: 'target', targetExpr: null },
  ModifyBlockMultiplicative: { method: 'ModifyBlockMultiplicative', ret: 'decimal', params: 'Creature target, decimal block, ValueProp props, CardModel cardSource, CardPlay cardPlay', shape: 'numeric', valueParam: 'block', lockedOp: 'Multiply', playerExpr: 'target', targetExpr: null },
  ModifyDamageAdditive: { method: 'ModifyDamageAdditive', ret: 'decimal', params: 'Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource, CardPlay cardPlay', shape: 'damageNumeric', valueParam: 'amount', lockedOp: 'Add', playerExpr: 'target', targetExpr: 'dealer' },
  ModifyDamageMultiplicative: { method: 'ModifyDamageMultiplicative', ret: 'decimal', params: 'Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource, CardPlay cardPlay', shape: 'damageNumeric', valueParam: 'amount', lockedOp: 'Multiply', playerExpr: 'target', targetExpr: 'dealer' },
  ModifyDamageCap: { method: 'ModifyDamageCap', ret: 'decimal', params: 'Creature target, ValueProp props, Creature dealer, CardModel cardSource, CardPlay cardPlay', shape: 'numeric', valueParam: null, lockedOp: null, playerExpr: 'target', targetExpr: 'dealer' },
  ModifyAttackHitCount: { method: 'ModifyAttackHitCount', ret: 'int', params: 'AttackCommand attack, int hitCount', shape: 'numeric', valueParam: 'hitCount', lockedOp: null, playerExpr: null, targetExpr: null },
  ModifyCardPlayCount: { method: 'ModifyCardPlayCount', ret: 'int', params: 'CardModel card, Creature target, int playCount', shape: 'numeric', valueParam: 'playCount', lockedOp: null, playerExpr: 'target', targetExpr: null },
  ModifyGoldGained: { method: 'ModifyGoldGained', ret: 'decimal', params: 'Player player, decimal amount', shape: 'numeric', valueParam: 'amount', lockedOp: null, playerExpr: 'player.Creature', targetExpr: null },
  ModifyHandDraw: { method: 'ModifyHandDraw', ret: 'decimal', params: 'Player player, decimal count', shape: 'numeric', valueParam: 'count', lockedOp: null, playerExpr: 'player.Creature', targetExpr: null },
  ModifyHpLostBeforeOsty: { method: 'ModifyHpLostBeforeOsty', ret: 'decimal', params: 'Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource', shape: 'numeric', valueParam: 'amount', lockedOp: null, playerExpr: 'target', targetExpr: 'dealer' },
  ModifyMaxEnergy: { method: 'ModifyMaxEnergy', ret: 'decimal', params: 'Player player, decimal amount', shape: 'numeric', valueParam: 'amount', lockedOp: null, playerExpr: 'player.Creature', targetExpr: null },
  ModifyOrbPassiveTriggerCounts: { method: 'ModifyOrbPassiveTriggerCounts', ret: 'int', params: 'OrbModel orb, int triggerCount', shape: 'numeric', valueParam: 'triggerCount', lockedOp: null, playerExpr: null, targetExpr: null },
  ModifyOrbValue: { method: 'ModifyOrbValue', ret: 'decimal', params: 'OrbModel orb, decimal value', shape: 'numeric', valueParam: 'value', lockedOp: null, playerExpr: null, targetExpr: null },
  ModifyPowerAmountGivenAdditive: { method: 'ModifyPowerAmountGivenAdditive', ret: 'decimal', params: 'PowerModel power, Creature giver, decimal amount, Creature target, CardModel cardSource', shape: 'numeric', valueParam: 'amount', lockedOp: 'Add', playerExpr: 'giver', targetExpr: 'target' },
  ModifyRestSiteHealAmount: { method: 'ModifyRestSiteHealAmount', ret: 'decimal', params: 'Creature creature, decimal amount', shape: 'numeric', valueParam: 'amount', lockedOp: null, playerExpr: 'creature', targetExpr: null },
  ModifySummonAmount: { method: 'ModifySummonAmount', ret: 'decimal', params: 'Player summoner, decimal amount, AbstractModel source', shape: 'numeric', valueParam: 'amount', lockedOp: null, playerExpr: 'summoner.Creature', targetExpr: null },
  ModifyXValue: { method: 'ModifyXValue', ret: 'int', params: 'CardModel card, int originalValue', shape: 'numeric', valueParam: 'originalValue', lockedOp: null, playerExpr: null, targetExpr: null },

  // ---- Paired display-fix hook (1) — added round 116, straight from a
  // real bug found (and fixed) in TheBurdenedNewCharacter's own Toughen
  // mechanic. A flat HP-loss reduction authored purely on
  // ModifyHpLostBeforeOsty is REAL and correctly reduces the damage taken,
  // but that hook runs AFTER the enemy's attack-intent number is already
  // computed and shown — so a mechanic built with the plain
  // ModifyHpLostBeforeOsty hook above silently shows the WRONG (higher)
  // number over the enemy's head, even though the actual HP loss is
  // correct. IronBlood/Withstand/SlowStart-style percentage mitigations
  // don't have this problem because they use ModifyDamageMultiplicative
  // instead, a hook that DOES feed the displayed intent. Confirmed via a
  // direct IL read of the real, installed sts2.dll (this project's own
  // sts2tools/ecma_dump_ext.py): ModifyDamageAdditive and
  // ModifyHpLostBeforeOsty are declared side by side on the same
  // MegaCrit.Sts2.Core.Models.AbstractModel base class, so a flat
  // reduction moved onto ModifyDamageAdditive instead shows up correctly
  // in the enemy intent, with ModifyHpLostBeforeOsty left as a pure
  // passthrough so the reduction is never double-applied.
  // `method`/`params` describe the PRIMARY hook this is authored as
  // (matches ModifyHpLostBeforeOsty exactly) for validate.js's condition-
  // kind/subject filtering; `companionMethod`/`companionParams` describe
  // the paired ModifyDamageAdditive override generateModifierOverrides
  // also emits. See claude/round116-reduce-hp-loss-display-fix.md.
  ReduceHpLossBeforeBlock: { method: 'ModifyHpLostBeforeOsty', ret: 'decimal', params: 'Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource', shape: 'hpLossDisplayFixed', valueParam: 'amount', lockedOp: 'Subtract', playerExpr: 'target', targetExpr: 'dealer', companionMethod: 'ModifyDamageAdditive', companionParams: 'Creature target, decimal amount, ValueProp props, Creature dealer, CardModel cardSource, CardPlay cardPlay' },

  // ---- Combined gate+modifier: bool + ref decimal (4) ----
  TryModifyEnergyCostInCombat: { method: 'TryModifyEnergyCostInCombat', ret: 'bool', params: 'CardModel card, decimal originalCost, ref decimal modifiedCost', shape: 'tryRefNumeric', refParam: 'modifiedCost', playerExpr: null, targetExpr: null },
  TryModifyEnergyCostInCombatLate: { method: 'TryModifyEnergyCostInCombatLate', ret: 'bool', params: 'CardModel card, decimal originalCost, ref decimal modifiedCost', shape: 'tryRefNumeric', refParam: 'modifiedCost', playerExpr: null, targetExpr: null },
  TryModifyPowerAmountReceived: { method: 'TryModifyPowerAmountReceived', ret: 'bool', params: 'PowerModel canonicalPower, Creature target, decimal amount, Creature applier, ref decimal modifiedAmount', shape: 'powerReceivedFilter', refParam: 'modifiedAmount', playerExpr: 'target', targetExpr: 'applier' },
  TryModifyStarCost: { method: 'TryModifyStarCost', ret: 'bool', params: 'CardModel card, decimal originalCost, ref decimal modifiedCost', shape: 'tryRefNumeric', refParam: 'modifiedCost', playerExpr: null, targetExpr: null },

  // ---- Collection mutation (1) — the only one of the 6 real "TryModify +
  // mutable collection" shapes tractable this round, since CardKeyword's
  // real 7 members are already fully known (card.keywords). ----
  TryModifyKeywordsInCombat: { method: 'TryModifyKeywordsInCombat', ret: 'bool', params: 'CardModel card, ISet<CardKeyword> keywords', shape: 'keywordSet', playerExpr: null, targetExpr: null },

  // ---- Deferred (7) — real, verified, Tyler-approved hooks that need
  // more research before real codegen. See each `reason`. ----
  TryModifyCardBeingAddedToDeck: { method: 'TryModifyCardBeingAddedToDeck', ret: 'bool', params: 'CardModel card, ref CardModel newCard', shape: 'cardTransformOnAdd', playerExpr: 'card.Owner.Creature', targetExpr: null },
  TryModifyCardBeingAddedToDeckLate: { method: 'TryModifyCardBeingAddedToDeckLate', ret: 'bool', params: 'CardModel card, ref CardModel newCard', shape: 'cardTransformOnAdd', playerExpr: 'card.Owner.Creature', targetExpr: null },
  TryModifyRestSiteHealRewards: { method: 'TryModifyRestSiteHealRewards', ret: 'bool', params: 'Player player, List<Reward> rewards, bool isMimicked', shape: 'restSiteReward', playerExpr: 'player.Creature', targetExpr: null },
  TryModifyRestSiteOptions: { method: 'TryModifyRestSiteOptions', ret: 'bool', params: 'Player player, ICollection<RestSiteOption> options', shape: 'restSiteOption', playerExpr: 'player.Creature', targetExpr: null },
  ModifyCardPlayResultLocation: { method: 'ModifyCardPlayResultLocation', ret: 'CardLocation', params: 'CardModel card, bool isAutoPlay, ResourceInfo resources, CardLocation cardLocation', shape: 'cardLocation', playerExpr: 'card.Owner.Creature', targetExpr: null },
  // [2026-09-23, this round] Moved off 'deferred' -- direct ECMA-335
  // reads of BOTH the real installed sts2.dll AND mods/BaseLib/BaseLib.dll
  // confirm the full real path: `LocString(string locTable, string
  // locEntryKey)` is a real public ctor (sts2.dll); `CustomRelicModel`/
  // `CustomPowerModel` already implement `BaseLib.Abstracts.
  // ILocalizationProvider` (confirmed via a real InterfaceImpl table
  // read of BaseLib.dll -- the SAME interface generateCardLocalization/
  // generateCharacterLocalization already use for CardModel/
  // CharacterModel, just never extended to relics/mechanics before now);
  // its `Localization` member is a real, overridable `List<(string,
  // string)>?` an entity's own generated class can freely add rows to.
  // No guessing at the real default `LocTable` value needed -- the
  // generated override below references the live `LocTable` PROPERTY
  // (not a hardcoded string), so whatever table it resolves to at
  // runtime is exactly the same table the Localization override just
  // added its row under. See generateExtraHealTextLocalization's own
  // comment for the paired class-level override this hook's codegen
  // needs alongside it.
  ModifyExtraRestSiteHealText: { method: 'ModifyExtraRestSiteHealText', ret: 'IReadOnlyList<LocString>', params: 'Player player, IReadOnlyList<LocString> currentExtraText', shape: 'extraHealText', playerExpr: 'player.Creature', targetExpr: null },
  // [2026-09-23, this round] Moved off 'deferred' -- the authoring-UI
  // design pass the old `reason` called for is now built: a real
  // 'shuffleOrder' shape (see generateModifierOverrides below), reusing
  // the SAME two real card-match primitives already proven elsewhere in
  // this file -- `card.Type == CardType.X` (HandCardTypeCheck/
  // PlayedCardHasType) and `(card as IForgeTaggedCard)?.ForgeTags.
  // Contains(tag)` (PlayedCardHasTag) -- plus the real `isInitialShuffle`
  // param (initial-shuffle-only vs reshuffle-only scoping) and a plain
  // `List<CardModel>.RemoveAll`/`InsertRange`/`AddRange` in-place mutate
  // (same 'mutate a live list, no return value' pattern restSiteOption/
  // cardListUpgradeVoid already use). `player`/`cards`/`isInitialShuffle`
  // are this hook's own real, confirmed params -- nothing new to verify.
  ModifyShuffleOrder: { method: 'ModifyShuffleOrder', ret: 'void', params: 'Player player, List<CardModel> cards, bool isInitialShuffle', shape: 'shuffleOrder', playerExpr: 'player.Creature', targetExpr: null },

  // ---- Round 207 (2026-09-23) — 16 new hooks, all confirmed via a full,
  // authoritative dump of the REAL, installed sts2.dll's own
  // MegaCrit.Sts2.Core.Models.AbstractModel (207 real methods read whole,
  // not grepped piecemeal — tools/sts2tools/ecma_dump_ext.py against
  // Tyler's actual Steam install, not just TheBurdenedNewCharacter_v3.dll's
  // derived evidence). Closes 16 of the 93 slay.spencerstiles.com
  // confirmed-passives list (claude/round206-spencerstiles-passive-list-gap-
  // analysis.md + round206b's DLL evidence) — every one below reuses the
  // exact 'gate'/'numeric' shapes already proven by the 8 gates/17
  // numerics above, so generateModifierOverrides needed zero new codegen
  // to support them. See claude/round207-passive-buildout-punchlist.md for
  // the full item-by-item mapping and what's still open after this round.
  ShouldProcurePotion: { method: 'ShouldProcurePotion', ret: 'bool', params: 'PotionModel potion, Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldAfflict: { method: 'ShouldAfflict', ret: 'bool', params: 'CardModel card, AfflictionModel affliction', shape: 'gate', playerExpr: 'card.Owner.Creature', targetExpr: null },
  ShouldGenerateTreasure: { method: 'ShouldGenerateTreasure', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldAllowMerchantCardRemoval: { method: 'ShouldAllowMerchantCardRemoval', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldDisableRemainingRestSiteOptions: { method: 'ShouldDisableRemainingRestSiteOptions', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldTakeExtraTurn: { method: 'ShouldTakeExtraTurn', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldFlush: { method: 'ShouldFlush', ret: 'bool', params: 'Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  ShouldEtherealTrigger: { method: 'ShouldEtherealTrigger', ret: 'bool', params: 'CardModel card', shape: 'gate', playerExpr: 'card.Owner.Creature', targetExpr: null },
  ShouldGainStars: { method: 'ShouldGainStars', ret: 'bool', params: 'decimal amount, Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  // No real params at all on this one (confirmed — ShouldAllowFreeTravel()
  // takes nothing), so playerExpr is null same as ShouldPlay/
  // ModifyAttackHitCount/ModifyOrbPassiveTriggerCounts/ModifyOrbValue
  // above — conditions here can't reference "you" via fgPlayer, but a
  // plain unconditional gate (no conditions authored) is exactly what
  // "freeMapTravel" (#29) needs.
  ShouldAllowFreeTravel: { method: 'ShouldAllowFreeTravel', ret: 'bool', params: '', shape: 'gate', playerExpr: null, targetExpr: null },
  ShouldRefillMerchantEntry: { method: 'ShouldRefillMerchantEntry', ret: 'bool', params: 'MerchantEntry entry, Player player', shape: 'gate', playerExpr: 'player.Creature', targetExpr: null },
  // [Caveat, see round207 punchlist] Real params include `RoomType
  // roomType` (TheBurdenedNewCharacter's own compiled body gated on a
  // roomType range check) but Forge has no RoomType condition kind yet,
  // so this gate is NOT room-type-filtered here — an author's "force a
  // potion reward" gate applies to every room this hook fires for unless
  // they add their own conditions. Flagged, not silently narrowed.
  ShouldForcePotionReward: { method: 'ShouldForcePotionReward', ret: 'bool', params: 'Player player, RoomType roomType', shape: 'gateRoomTypeFiltered', playerExpr: 'player.Creature', targetExpr: null },

  ModifyEnergyGain: { method: 'ModifyEnergyGain', ret: 'decimal', params: 'Player player, decimal amount', shape: 'numeric', valueParam: 'amount', lockedOp: null, playerExpr: 'player.Creature', targetExpr: null },
  // Real sibling of ModifyPowerAmountGivenAdditive above — SAME real
  // params, SAME playerExpr/targetExpr ('giver'/'target'), just the
  // Multiplicative override instead of Additive. [VERIFIED hook identity
  // via TheBurdenedNewCharacter_v3.dll kind 74 powerAmountGivenPercent —
  // real percent-multiply body, degenerate *1 test value] and confirmed
  // to exist verbatim in the real sts2.dll's own AbstractModel this round.
  ModifyPowerAmountGivenMultiplicative: { method: 'ModifyPowerAmountGivenMultiplicative', ret: 'decimal', params: 'PowerModel power, Creature giver, decimal amount, Creature target, CardModel cardSource', shape: 'numeric', valueParam: 'amount', lockedOp: 'Multiply', playerExpr: 'giver', targetExpr: 'target' },
  ModifyMerchantPrice: { method: 'ModifyMerchantPrice', ret: 'decimal', params: 'Player player, MerchantEntry entry, decimal cost', shape: 'numeric', valueParam: 'cost', lockedOp: null, playerExpr: 'player.Creature', targetExpr: null },
  ModifyCardRewardUpgradeOdds: { method: 'ModifyCardRewardUpgradeOdds', ret: 'decimal', params: 'Player player, CardModel card, decimal odds', shape: 'numeric', valueParam: 'odds', lockedOp: null, playerExpr: 'player.Creature', targetExpr: null },

  // ---- Round 208 (2026-09-23) — new 'creatureRedirect' shape, closes
  // #93 "Its attacks hit its own allies instead" (attacksHitOwnAllies).
  // ModifyUnblockedDamageTarget(Creature target, decimal amount, ValueProp
  // props, Creature dealer): Creature -- confirmed real via a full dump of
  // the real, installed sts2.dll's own AbstractModel (round207's evidence
  // pass). `dealer.CombatState` (real, public ICombatState-typed property
  // on Creature) exposes GetTeammatesOf(Creature)/GetOpponentsOf(Creature):
  // IReadOnlyList<Creature> -- both confirmed real, public, ABSTRACT
  // members of the ICombatState INTERFACE itself (not just the concrete
  // CombatState class), via direct sts2.dll read of both types this round
  // (ecma_dump_ext.py against MegaCrit.Sts2.Core.Combat.CombatState AND
  // MegaCrit.Sts2.Core.Combat.ICombatState separately) -- so calling them
  // off dealer.CombatState (interface-typed) compiles for real.
  ModifyUnblockedDamageTarget: { method: 'ModifyUnblockedDamageTarget', ret: 'Creature', params: 'Creature target, decimal amount, ValueProp props, Creature dealer', shape: 'creatureRedirect', playerExpr: 'dealer', targetExpr: 'target' },

  // ---- Round 213 (2026-09-23) -- closes #13 expandCardRewardPools. Real
  // signatures confirmed via the full authoritative AbstractModel dump
  // (round207's evidence pass):
  //   ModifyCardRewardCreationOptions(Player, CardCreationOptions): CardCreationOptions
  //   ModifyCardRewardCreationOptionsLate(Player, CardCreationOptions): CardCreationOptions
  // CardCreationOptions.WithCardPools(IEnumerable<CardPoolModel>) is a real
  // public instance method (confirmed via direct ecma_dump_ext.py read of
  // MegaCrit.Sts2.Core.Runs.CardCreationOptions this round) -- a genuine
  // fluent 'with' method, not a guess at a mutation API. See
  // CARD_POOL_CLASS_MAP above for the real CardPoolModel subclass list.
  ModifyCardRewardCreationOptions: { method: 'ModifyCardRewardCreationOptions', ret: 'CardCreationOptions', params: 'Player player, CardCreationOptions options', shape: 'cardRewardPoolAppend', playerExpr: 'player.Creature', targetExpr: null },
  ModifyCardRewardCreationOptionsLate: { method: 'ModifyCardRewardCreationOptionsLate', ret: 'CardCreationOptions', params: 'Player player, CardCreationOptions options', shape: 'cardRewardPoolAppend', playerExpr: 'player.Creature', targetExpr: null },

  // ---- Round 214 (2026-09-23) -- closes #88 cardRewardCountDelta. Real
  // signatures confirmed via the full authoritative AbstractModel dump
  // (round207's evidence pass):
  //   TryModifyCardRewardOptions(Player, List<CardCreationResult>, CardCreationOptions): bool
  //   TryModifyCardRewardOptionsLate(Player, List<CardCreationResult>, CardCreationOptions): bool
  // MegaCrit.Sts2.Core.Factories.CardFactory.CreateForReward(Player player,
  // int cardCount, CardCreationOptions options): IEnumerable<CardCreationResult>
  // is a real PUBLIC static overload (confirmed via direct ecma_dump_ext.py
  // read of CardFactory this round) -- cleaner evidence than the compiled
  // third-party example round206b found, which called a different, PRIVATE
  // overload. Only the ADD direction is implemented (rewardCountDelta > 0);
  // there's no real-evidenced mechanism for which specific option to
  // remove, so 'remove N' is intentionally not offered rather than guessed.
  TryModifyCardRewardOptions: { method: 'TryModifyCardRewardOptions', ret: 'bool', params: 'Player player, List<CardCreationResult> cardRewardOptions, CardCreationOptions creationOptions', shape: 'cardRewardCountDelta', playerExpr: 'player.Creature', targetExpr: null },
  TryModifyCardRewardOptionsLate: { method: 'TryModifyCardRewardOptionsLate', ret: 'bool', params: 'Player player, List<CardCreationResult> cardRewardOptions, CardCreationOptions creationOptions', shape: 'cardRewardCountDelta', playerExpr: 'player.Creature', targetExpr: null },

  // ---- Round 216 (2026-09-23) -- closes #24 upgradeAcquiredCards' shop
  // surface (reward/deck surfaces are separate orthogonal extensions to
  // already-shipped shapes, see generateModifierOverrides' own comments on
  // 'cardRewardCountDelta' and 'cardTransformOnAdd'). Real signature
  // confirmed via the full authoritative AbstractModel dump:
  //   ModifyMerchantCardCreationResults(Player, List<CardCreationResult>): void
  // A genuinely VOID hook (no bool/return-value gate) -- the base game just
  // calls it and reads back whatever mutations were made to the list/its
  // CardCreationResult entries. Real upgrade mechanism confirmed via
  // round206b's IL evidence (clone-then-CardCmd.Upgrade, gated to
  // card.IsUpgradable && CurrentUpgradeLevel < 1) plus this round's own
  // direct sts2.dll reads: CardModel.CreateClone(): CardModel (real,
  // public, no-arg -- NOT the RunState.CreateCard<T>() pattern round 211
  // used, since this clones the SAME card rather than swapping to a
  // different class); CardCmd.Upgrade(CardModel, CardPreviewStyle): void
  // (real, public, static); CardPreviewStyle's real members confirmed via
  // direct Field/Constant metadata read this round
  // (None=0/HorizontalLayout=1/MessyLayout=2/EventLayout=3/GridLayout=4) --
  // None used here since this isn't tied to any specific screen layout;
  // CardCreationResult.ModifyCard(CardModel, RelicModel): void (real,
  // confirmed via ecma_dump_ext.py read of CardCreationResult) swaps in the
  // upgraded clone as this option's actual card WITHOUT mutating the
  // shared canonical CardModel instance in place (which would wrongly
  // upgrade every future draw of that card, not just this one reward).
  ModifyMerchantCardCreationResults: { method: 'ModifyMerchantCardCreationResults', ret: 'void', params: 'Player player, List<CardCreationResult> cards', shape: 'cardListUpgradeVoid', playerExpr: 'player.Creature', targetExpr: null },

  // ---- Round 209 (2026-09-23) — closes #21 (modifyRoomRewards): real
  // signature TryModifyRewards(Player player, List<Reward> rewards,
  // AbstractRoom room) -- SAME param names ('player'/'rewards') as
  // TryModifyRestSiteHealRewards above, so it reuses that hook's exact
  // 'restSiteReward' shape/codegen verbatim (Add/Remove a GoldReward) with
  // zero new code -- confirmed via the round207 full sts2.dll
  // AbstractModel dump. TryModifyRewardsLate is the same real signature
  // (late-pipeline variant) -- added as its own hook rather than folded
  // into one entry since a relic/mechanic may want either or both timing
  // points as separate overrides. NOTE: this does NOT close #25 ("card
  // rewards can be rerolled") -- that needs a different mutation (toggle
  // CanReroll=true on EXISTING CardReward entries, not Add/Remove Gold)
  // and isn't built yet -- see claude/round207-208-passive-buildout-punchlist.md.
  TryModifyRewards: { method: 'TryModifyRewards', ret: 'bool', params: 'Player player, List<Reward> rewards, AbstractRoom room', shape: 'restSiteReward', playerExpr: 'player.Creature', targetExpr: null },
  TryModifyRewardsLate: { method: 'TryModifyRewardsLate', ret: 'bool', params: 'Player player, List<Reward> rewards, AbstractRoom room', shape: 'restSiteReward', playerExpr: 'player.Creature', targetExpr: null },
};

// "ref decimal modifiedCost" -> "modifiedCost" (declaration -> a plain
// local reference), but "ref decimal modifiedCost" -> "ref modifiedCost"
// for a CALL SITE (calling base.<Method>(...) must repeat the `ref`
// keyword or it's a real C# compile error, CS1620).
function modifierParamNamesForCall(params) {
  if (!params || !params.trim()) return '';
  return params.split(',').map(p => {
    p = p.trim();
    const isRef = /^ref\s+/.test(p);
    const rest = p.replace(/^ref\s+/, '');
    const name = rest.trim().split(/\s+/).pop();
    return isRef ? `ref ${name}` : name;
  }).join(', ');
}

// Generates one `public override <ret> <Method>(<params>) { ... }` block
// per entry in entity.modifiers[] — see MODIFIER_HOOKS above for the 4
// shapes. Shares the exact same conditionToCSharp(cond, ctx) every other
// condition in this file goes through — Group B modifiers are NOT a new
// condition-kind vocabulary, just a new place real conditions can gate a
// return value instead of an action list.
function generateModifierOverrides(entity, entityKind, refMaps) {
  const blocks = [];
  for (const mod of entity.modifiers || []) {
    const hook = MODIFIER_HOOKS[mod.hook];
    if (!hook) {
      throw new Error(`No modifier hook mapping registered for ${entityKind} modifier "${mod.hook}". Add one in compiler.js:MODIFIER_HOOKS.`);
    }
    const paramNames = modifierParamNamesForCall(hook.params);
    if (hook.shape === 'deferred') {
      const todoMsg = `${mod.hook} — ${hook.reason}`.replace(/"/g, '\\"');
      const passthrough = hook.ret === 'void'
        ? `        base.${hook.method}(${paramNames});`
        : `        return base.${hook.method}(${paramNames});`;
      blocks.push(
`    // modifier: ${mod.hook} -> ${hook.method}(${hook.params}) [DEFERRED, round 20 — see claude/round20-groupb-findings.md] ${hook.reason}
    public override ${hook.ret} ${hook.method}(${hook.params})
    {
        ForgeActions.Todo("${todoMsg}"); // [UNVERIFIED — deferred, real hook]
${passthrough}
    }`);
      continue;
    }

    // `fgPlayerBound` (added round 25, 2026-09-01) mirrors this exact
    // hook's own `bindLines` logic right below (`if (hook.playerExpr)
    // bindLines.push('var fgPlayer = ...')`) — UNLIKE generateHookEffects,
    // this function always calls conditionToCSharp regardless of whether
    // fgPlayer got bound (several real MODIFIER_HOOKS entries have
    // `playerExpr: null` — ShouldPlay, ModifyAttackHitCount,
    // ModifyOrbPassiveTriggerCounts, ModifyOrbValue), so a condition kind
    // that assumes fgPlayer is always in scope (CardsPlayedThisTurn/
    // AttacksPlayedThisTurn) needs to know per-hook whether it really is —
    // see those cases' own comment for why.
    const modCtx = { cardPlayBound: false, fgPlayerBound: !!hook.playerExpr, cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById };
    const condExpr = (mod.conditions && mod.conditions.length)
      ? mod.conditions.map(c => conditionToCSharp(c, modCtx)).join(' && ')
      : 'true';
    const bindLines = [];
    if (hook.playerExpr) bindLines.push(`        var fgPlayer = ${hook.playerExpr}; // [VERIFIED via direct sts2.dll read]`);
    if (hook.targetExpr) bindLines.push(`        var fgTarget = ${hook.targetExpr}; // [VERIFIED via direct sts2.dll read]`);
    const bind = bindLines.length ? bindLines.join('\n') + '\n' : '';

    if (hook.shape === 'hpLossDisplayFixed') {
      // See MODIFIER_HOOKS.ReduceHpLossBeforeBlock's own comment for the
      // full story. Two overrides, not one: ModifyHpLostBeforeOsty is left
      // a pure passthrough (base value only, no reduction applied there),
      // and ModifyDamageAdditive is where the real flat reduction lives —
      // that's the hook the base game actually reads when it computes the
      // enemy's displayed attack-intent number, so this is the one real
      // fix confirmed (and shipped) against TheBurdenedNewCharacter's own
      // Toughen mechanic, generalized into a reusable Forge hook.
      const rawVal = typeof mod.numericValue === 'number' ? mod.numericValue : 0;
      const val = `${rawVal}m`;
      const passthroughParamNames = paramNames;
      const companionParamNames = modifierParamNamesForCall(hook.companionParams);
      blocks.push(
`    // modifier: ${mod.hook} -> ${hook.method}(${hook.params}) [paired display-fix hook — passthrough half, round 116]
    public override ${hook.ret} ${hook.method}(${hook.params})
    {
        return base.${hook.method}(${passthroughParamNames}); // intentionally unchanged here -- ${hook.companionMethod} below owns the real reduction so the enemy-intent display and the actual HP loss never diverge
    }`);
      blocks.push(
`    // modifier: ${mod.hook} -> ${hook.companionMethod}(${hook.companionParams}) [paired display-fix hook — reduction half, round 116]
    public override decimal ${hook.companionMethod}(${hook.companionParams})
    {
${bind}        decimal result = base.${hook.companionMethod}(${companionParamNames});
        if (${condExpr})
        {
            result = result - ${val};
        }
        return result;
    }`);
      continue;
    }

    let body;
    if (hook.shape === 'gate') {
      const gateValue = mod.gateValue === true ? 'true' : 'false';
      body = `${bind}        if (${condExpr})\n        {\n            return ${gateValue};\n        }\n        return base.${hook.method}(${paramNames});`;
    } else if (hook.shape === 'gateRoomTypeFiltered') {
      // [Round 212] ShouldForcePotionReward-specific shape -- closes Flag A
      // from the round207-208 punchlist (this hook wasn't room-type-
      // filtered before). MegaCrit.Sts2.Core.Rooms.RoomType's real members
      // (Unassigned=0, Monster=1, Elite=2, Boss=3, Treasure=4, Shop=5,
      // Event=6, RestSite=7, Map=8) were confirmed this round via a direct
      // Field/Constant metadata read of the real, installed sts2.dll's own
      // RoomType TypeDef. mod.roomTypes defaults to an empty array, which
      // reproduces this shape's old 'gate' behavior EXACTLY (no room-type
      // clause at all) for any character JSON saved before this round.
      const gateValue2 = mod.gateValue === true ? 'true' : 'false';
      const rooms = Array.isArray(mod.roomTypes) ? mod.roomTypes.filter(Boolean) : [];
      const roomCheck = rooms.length
        ? '(' + rooms.map(rt => `roomType == MegaCrit.Sts2.Core.Rooms.RoomType.${rt}`).join(' || ') + ')'
        : 'true';
      body = `${bind}        if ((${condExpr}) && ${roomCheck})\n        {\n            return ${gateValue2};\n        }\n        return base.${hook.method}(${paramNames});`;
    } else if (hook.shape === 'numeric') {
      const op = hook.lockedOp || (mod.numericMode === 'Multiply' ? 'Multiply' : (mod.numericMode === 'Set' ? 'Set' : 'Add'));
      const litSuffix = hook.ret === 'int' ? '' : 'm';
      const rawVal = typeof mod.numericValue === 'number' ? mod.numericValue : 0;
      const val = `${rawVal}${litSuffix}`;
      const applyExpr = op === 'Set' ? val : (op === 'Multiply' ? `result * ${val}` : `result + ${val}`);
      body = `${bind}        ${hook.ret} result = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            result = ${applyExpr};\n        }\n        return result;`;
    } else if (hook.shape === 'damageNumeric') {
      // [Round 217] ModifyDamageAdditive/ModifyDamageMultiplicative-only
      // shape -- closes Flag B (owner-scoping) and #43/#44 (damage TAKEN).
      // Tyler's explicit direct answer (2026-09-23, resuming from the
      // round 207-216 overnight session): these two hooks now ALWAYS
      // auto-scope to the relic's own owner -- no author condition needed
      // or offered -- a deliberate, acknowledged change to the
      // already-shipped #41/#42 codegen (previously shape:'numeric' with
      // ZERO owner-scoping at all, per Flag B's own finding that every
      // real compiled example hand-writes this check itself). mod.
      // damageDirection: 'Dealt' (default) -> dealer == this.Owner.Creature
      // (#41 damageDealtFlat / #42 damageDealtPercent); 'Taken' -> target
      // == this.Owner.Creature (#43 damageTakenPercent / #44
      // damageTakenFlat). Both comparisons are [VERIFIED] straight off
      // round206b's decompile of TheBurdenedNewCharacter_v3.dll's own
      // Passive8 relic, which hand-writes exactly these two checks in its
      // real compiled ModifyDamageAdditive/Multiplicative overrides.
      // #45 damageTakenPerCardPlayed (a per-turn cards-played scaling
      // counter) is NOT covered by this shape -- it needs its own stateful
      // counter field, same class of gap as #48/#87/#92 -- deliberately
      // left for its own round rather than guessed at here.
      const direction = mod.damageDirection === 'Taken' ? 'Taken' : 'Dealt';
      const scopeExpr = direction === 'Taken' ? 'target == this.Owner.Creature' : 'dealer == this.Owner.Creature';
      const dnRawVal = typeof mod.numericValue === 'number' ? mod.numericValue : 0;
      const dnVal = `${dnRawVal}m`;
      const dnApplyExpr = hook.lockedOp === 'Multiply' ? `result * ${dnVal}` : `result + ${dnVal}`;
      body = `${bind}        ${hook.ret} result = base.${hook.method}(${paramNames});\n        if ((${condExpr}) && ${scopeExpr})\n        {\n            result = ${dnApplyExpr};\n        }\n        return result;`;
    } else if (hook.shape === 'tryRefNumeric') {
      const rawVal = typeof mod.setValue === 'number' ? mod.setValue : 0;
      const val = `${rawVal}m`;
      body = `${bind}        bool baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            ${hook.refParam} = ${val};\n            return true;\n        }\n        return baseResult;`;
    } else if (hook.shape === 'powerReceivedFilter') {
      // [Round 210] TryModifyPowerAmountReceived-specific shape -- closes
      // #76 'Negate incoming debuffs' and #77 'Negate incoming buffs'
      // (setValue=0 plus powerTypeFilter='Debuff'/'Buff'), and generalizes
      // to overriding the amount of ANY incoming power of a given real
      // PowerType. MegaCrit.Sts2.Core.Entities.Powers.PowerType's real
      // members are None/Buff/Debuff -- [VERIFIED via reflect-baselib
      // round 2], and PowerModel.Type is already used the same way
      // elsewhere in this file's DebuffStacksTotal condition codegen
      // ([VERIFIED via sts2.dll -- Creature.Powers, PowerModel.Type]), so
      // this reuses existing evidence rather than adding new evidence.
      // powerTypeFilter defaults to 'Any' (no type clause at all), which
      // reproduces the shape's old 'tryRefNumeric' behavior exactly.
      const rawVal2 = typeof mod.setValue === 'number' ? mod.setValue : 0;
      const val2 = `${rawVal2}m`;
      const typeFilter = mod.powerTypeFilter === 'Debuff' ? ' && canonicalPower.Type == MegaCrit.Sts2.Core.Entities.Powers.PowerType.Debuff'
        : mod.powerTypeFilter === 'Buff' ? ' && canonicalPower.Type == MegaCrit.Sts2.Core.Entities.Powers.PowerType.Buff'
        : '';
      body = `${bind}        bool baseResult = base.${hook.method}(${paramNames});\n        if ((${condExpr})${typeFilter})\n        {\n            ${hook.refParam} = ${val2};\n            return true;\n        }\n        return baseResult;`;
    } else if (hook.shape === 'cardTransformOnAdd') {
      // [Round 211] TryModifyCardBeingAddedToDeck(Late)-specific shape --
      // closes #69 'deckCardsBecome' (cards added to your deck become a
      // different, author-picked card). Real mechanism confirmed via a
      // direct IL read of the only real compiled example found
      // (TheBurdenedNewCharacter_v3.dll, Relics.Passive12::
      // TryModifyCardBeingAddedToDeck, round211 evidence pass):
      //   newCard = null;
      //   if (card.Owner != this.Owner) return false;
      //   if (card is <TargetClass>) return false; // guards infinite transform loop
      //   newCard = card.Owner.RunState.CreateCard<TargetClass>(card.Owner);
      //   return true;
      // MegaCrit.Sts2.Core.Runs.ICardScope.CreateCard<T>(Player owner): T
      // is a real generic instance method -- confirmed via direct
      // MemberRef/TypeRef metadata resolution of that exact call site (not
      // guessed from the mnemonic alone), reached off Player.RunState. The
      // owner check and the self-guard are reproduced verbatim as
      // UNCONDITIONAL parts of this shape's codegen (not author-optional)
      // since they're structural requirements of the real hook (without
      // the self-guard, RunState.CreateCard's own newly-created card would
      // immediately re-trigger this same hook -- an infinite loop), not a
      // design choice Forge is free to omit. Author conditions (condExpr)
      // apply ON TOP of these two mandatory checks to further scope WHEN
      // the transform applies (e.g. only below some HP threshold).
      const fgCls = modCtx.cardClassById && modCtx.cardClassById.get(mod.becomesCardId);
      if (fgCls) {
        body = `${bind}        newCard = null;\n        if (card.Owner != this.Owner || card is ${fgCls} || !(${condExpr}))\n        {\n            return base.${hook.method}(${paramNames});\n        }\n        newCard = card.Owner.RunState.CreateCard<${fgCls}>(card.Owner);\n        return true;`;
      } else if (mod.autoUpgradeOnAdd) {
        // [Round 216] closes #24's deck-addition surface (upgradeAcquiredCards)
        // -- an orthogonal alternative to the transform-to-a-different-card
        // path above, picked when no becomesCardId is set. Same real
        // clone-then-CardCmd.Upgrade pattern as the reward/shop surfaces
        // (see MODIFIER_HOOKS.ModifyMerchantCardCreationResults' own
        // comment for the full evidence trail). No self-guard against
        // re-triggering is needed here (unlike the transform path above):
        // the post-upgrade clone's own CurrentUpgradeLevel >= 1 already
        // makes a repeat call on it fall through to the real base result,
        // so this is self-limiting by construction, not by an extra check.
        body = `${bind}        newCard = null;\n        if (card.Owner != this.Owner || !card.IsUpgradable || card.CurrentUpgradeLevel >= 1 || !(${condExpr}))\n        {\n            return base.${hook.method}(${paramNames});\n        }\n        MegaCrit.Sts2.Core.Models.CardModel fgClone = card.CreateClone();\n        MegaCrit.Sts2.Core.Commands.CardCmd.Upgrade(fgClone, MegaCrit.Sts2.Core.Nodes.CommonUi.CardPreviewStyle.None);\n        newCard = fgClone;\n        return true;`;
      } else {
        body = `${bind}        return base.${hook.method}(${paramNames}); // [UNVERIFIED] pick a target card, or enable auto-upgrade, in this modifier's own fields -- neither set yet`;
      }
    } else if (hook.shape === 'cardRewardPoolAppend') {
      // [Round 213] closes #13 expandCardRewardPools -- appends the
      // author-picked real CardPoolModel(s) (see CARD_POOL_CLASS_MAP) to
      // this reward's existing pool list via the real, confirmed
      // CardCreationOptions.WithCardPools(IEnumerable<CardPoolModel>)
      // fluent method. Falls through to the real, unmodified base result
      // when no pools are picked yet, or when condExpr doesn't match.
      const fgPools = (Array.isArray(mod.addPools) ? mod.addPools : []).filter(p => CARD_POOL_CLASS_MAP[p]);
      if (!fgPools.length) {
        body = `${bind}        return base.${hook.method}(${paramNames}); // [UNVERIFIED] pick at least one card pool to add in this modifier's own checkboxes -- none selected yet`;
      } else {
        const poolExprs = fgPools.map(p => `MegaCrit.Sts2.Core.Models.ModelDb.CardPool<${CARD_POOL_CLASS_MAP[p]}>()`).join(', ');
        body = `${bind}        CardCreationOptions baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            return baseResult.WithCardPools(baseResult.CardPools.Concat(new MegaCrit.Sts2.Core.Models.CardPoolModel[] { ${poolExprs} }));\n        }\n        return baseResult;`;
      }
    } else if (hook.shape === 'cardRewardCountDelta') {
      // [Round 214] closes #88 cardRewardCountDelta -- adds N extra reward
      // card options via the real, public
      // CardFactory.CreateForReward(Player, int, CardCreationOptions):
      // IEnumerable<CardCreationResult> static factory.
      const fgN = (typeof mod.rewardCountDelta === 'number' && mod.rewardCountDelta > 0) ? Math.floor(mod.rewardCountDelta) : 1;
      // [Round 216] Orthogonal, optional extra mutation -- closes #24's
      // reward-screen surface (upgradeAcquiredCards). Applies ALONGSIDE
      // adding extra options above (both independent, matching round 215's
      // same-pattern extension of 'restSiteReward').
      const fgUpgradeLoop = mod.autoUpgradeRewards
        ? ` foreach (var fgResult in cardRewardOptions) { if (fgResult.Card.IsUpgradable && fgResult.Card.CurrentUpgradeLevel < 1) { MegaCrit.Sts2.Core.Models.CardModel fgClone = fgResult.Card.CreateClone(); MegaCrit.Sts2.Core.Commands.CardCmd.Upgrade(fgClone, MegaCrit.Sts2.Core.Nodes.CommonUi.CardPreviewStyle.None); fgResult.ModifyCard(fgClone, this); } }`
        : '';
      body = `${bind}        bool baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            cardRewardOptions.AddRange(MegaCrit.Sts2.Core.Factories.CardFactory.CreateForReward(player, ${fgN}, creationOptions));\n${fgUpgradeLoop}\n            return true;\n        }\n        return baseResult;`;
    } else if (hook.shape === 'cardListUpgradeVoid') {
      // [Round 216] closes #24 upgradeAcquiredCards' shop surface
      // (ModifyMerchantCardCreationResults is a VOID hook -- see
      // MODIFIER_HOOKS' own comment on this entry for the full evidence).
      const upgradeLoop = ' foreach (var fgResult in cards) { if (fgResult.Card.IsUpgradable && fgResult.Card.CurrentUpgradeLevel < 1) { MegaCrit.Sts2.Core.Models.CardModel fgClone = fgResult.Card.CreateClone(); MegaCrit.Sts2.Core.Commands.CardCmd.Upgrade(fgClone, MegaCrit.Sts2.Core.Nodes.CommonUi.CardPreviewStyle.None); fgResult.ModifyCard(fgClone, this); } }';
      body = `${bind}        base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {${upgradeLoop}\n        }`;
    } else if (hook.shape === 'shuffleOrder') {
      // [2026-09-23] ModifyShuffleOrder's own authoring-UI design pass —
      // "which cards" reuses the exact two real card-match primitives this
      // file already has proven codegen for: `card.Type == CardType.X`
      // (same real CardType enum access as HandCardTypeCheck/
      // PlayedCardHasType) and `(card as IForgeTaggedCard)?.ForgeTags.
      // Contains(tag) == true` (same Forge-owned tag mechanism as
      // PlayedCardHasTag). Both filters are optional and AND together;
      // leaving both off matches every card in the list (a no-op move,
      // same "author left it wide open" convention gateRoomTypeFiltered's
      // empty-roomTypes case already uses). `cards` is the hook's own
      // real, live `List<CardModel>` param — plain RemoveAll+InsertRange/
      // AddRange mutates it in place, no `ref` needed (List<T> is a
      // reference type), same in-place-mutate pattern restSiteOption/
      // restSiteReward already use on their own live list params.
      // `isInitialShuffle` is this hook's own real third param — exposed
      // as an explicit scope choice (every shuffle / only the very first
      // shuffle of combat / only mid-combat reshuffles) rather than
      // silently ignored, since a shuffle-order effect that's only
      // supposed to run once per combat needs it to not double-fire on
      // every discard-pile-into-draw-pile reshuffle.
      const shuffleMatchClauses = [];
      if (mod.shuffleCardTypeFilter) shuffleMatchClauses.push(`c.Type == CardType.${mod.shuffleCardTypeFilter}`);
      if (mod.shuffleCardTagFilter) shuffleMatchClauses.push(`(c as IForgeTaggedCard)?.ForgeTags.Contains(${csharpStringLiteral(mod.shuffleCardTagFilter)}) == true`);
      const shuffleMatchExpr = shuffleMatchClauses.length ? shuffleMatchClauses.join(' && ') : 'true';
      const shuffleScopeClause = mod.shuffleScope === 'InitialOnly' ? ' && isInitialShuffle'
        : mod.shuffleScope === 'ReshuffleOnly' ? ' && !isInitialShuffle'
        : '';
      const shuffleMove = mod.shuffleDestination === 'Bottom' ? 'cards.AddRange(fgMatches);' : 'cards.InsertRange(0, fgMatches);';
      body = `${bind}        base.${hook.method}(${paramNames});\n        if ((${condExpr})${shuffleScopeClause})\n        {\n            var fgMatches = cards.Where(c => ${shuffleMatchExpr}).ToList();\n            cards.RemoveAll(c => ${shuffleMatchExpr});\n            ${shuffleMove}\n        }`;
    } else if (hook.shape === 'extraHealText') {
      // [2026-09-23] ModifyExtraRestSiteHealText -- see MODIFIER_HOOKS'
      // own entry and generateExtraHealTextLocalization's comment for the
      // full real-evidence trail. This override just appends ONE real
      // LocString to the base result; the actual text lives in the
      // paired `Localization` property override (emitted separately, once
      // per class, by generateExtraHealTextLocalization -- NOT here,
      // since a class-level property can't be emitted once per modifier
      // the way every other hook override in this function is). `LocTable`
      // is referenced live (not a hardcoded string) so this always points
      // at whatever table that same Localization override's row actually
      // landed in -- no guessing which default table name the real
      // ILocalizationProvider.LocTable DIM would have picked.
      body = `${bind}        IReadOnlyList<LocString> baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            return baseResult.Append(new LocString(LocTable, "EXTRAHEALTEXT")).ToList();\n        }\n        return baseResult;`;
    } else if (hook.shape === 'keywordSet') {
      const op = mod.keywordOp === 'Remove' ? 'Remove' : 'Add';
      // [Round 139] mod.keyword may now also be a custom keyword word (see
      // keywordExpr's own comment) — fall back to 'Exhaust' only when it
      // matches neither the 7 built-ins nor this character's own
      // cardKeywords[].word.
      const kw = (CARD_KEYWORD_VALUES.includes(mod.keyword) || currentCustomKeywordWords.has(mod.keyword)) ? mod.keyword : 'Exhaust';
      const call = op === 'Remove' ? `keywords.Remove(${keywordExpr(kw)});` : `keywords.Add(${keywordExpr(kw)});`;
      body = `${bind}        bool baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            ${call}\n            return true;\n        }\n        return baseResult;`;
    } else if (hook.shape === 'cardLocation') {
      // [2026-09-23] ModifyCardPlayResultLocation's evidence was already
      // fully closed last round (CardLocation(Player, PileType,
      // CardPilePosition) is a real record ctor, confirmed via direct
      // sts2.dll read) -- this round adds the missing authoring UI/schema
      // fields (destPile/destPosition) that were the one open gap. `card`
      // (the hook's own real CardModel param, the card that was just
      // played) is the correct real player source here -- card.Owner
      // (Player-typed on CardModel, per round25's own finding) -- NOT
      // fgPlayer/hook.playerExpr, which only binds a Creature for
      // condition evaluation (see `bind` above); using card.Owner instead
      // keeps this correct even in a hypothetical multiplayer context
      // where the played card's owner might not be whichever creature
      // this specific firing bound.
      const destPileExpr = pileTypeExpr(mod.destPile);
      const destPositionValue = ['Top', 'Bottom', 'Random'].includes(mod.destPosition) ? mod.destPosition : 'Top';
      body = `${bind}        MegaCrit.Sts2.Core.Entities.Cards.CardLocation baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            return new MegaCrit.Sts2.Core.Entities.Cards.CardLocation(card.Owner, ${destPileExpr}, MegaCrit.Sts2.Core.Entities.Cards.CardPilePosition.${destPositionValue});\n        }\n        return baseResult;`;
    } else if (hook.shape === 'creatureRedirect') {
      // [Round 208] Redirects this hit to a random ally or enemy OF THE
      // ATTACKER (dealer), excluding the dealer itself and the original
      // target from the candidate pool so a redirect never silently
      // no-ops back onto the same creature it already would have hit;
      // falls back to the real base result when the pool is empty (e.g.
      // "redirect to an ally" in a solo fight with no allies present).
      const call = mod.redirectMode === 'Enemy' ? 'GetOpponentsOf' : 'GetTeammatesOf';
      body = `${bind}        MegaCrit.Sts2.Core.Entities.Creatures.Creature baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            var fgCandidates = dealer.CombatState.${call}(dealer).Where(c => c != dealer && c != target).ToList();\n            if (fgCandidates.Count > 0)\n            {\n                return fgCandidates[0];\n            }\n        }\n        return baseResult;`;
    } else if (hook.shape === 'restSiteOption') {
      // [VERIFIED via direct sts2.dll read, 2026-09-22 — see
      // BUILTIN_REST_SITE_OPTION_CLASS_MAP's own comment] All 9 real
      // RestSiteOption subclasses take just a Player in their public ctor
      // — `player` here is the hook's own real parameter (already in
      // scope), not fgPlayer (which is a Creature, not a Player, and only
      // bound for condition evaluation — see `bind` above).
      const op = mod.optionOp === 'Remove' ? 'Remove' : 'Add';
      const cls = BUILTIN_REST_SITE_OPTION_CLASS_MAP[mod.optionType] || BUILTIN_REST_SITE_OPTION_CLASS_MAP.Smith;
      const mutate = op === 'Remove'
        ? `foreach (var opt in options.Where(o => o is ${cls}).ToList()) { options.Remove(opt); }`
        : `options.Add(new ${cls}(player));`;
      body = `${bind}        bool baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            ${mutate}\n            return true;\n        }\n        return baseResult;`;
    } else if (hook.shape === 'restSiteReward') {
      // [VERIFIED via direct sts2.dll read, 2026-09-22] GoldReward(int
      // amount, Player player, bool wasGoldStolenBack) is a real, public
      // constructor on Reward's one investigated concrete subclass —
      // `wasGoldStolenBack: false` for an authored bonus reward (it's not
      // stolen back from anything). See the shape-list comment above for
      // why only Gold is offered.
      const op = mod.rewardOp === 'Remove' ? 'Remove' : (mod.rewardOp === 'None' ? 'None' : 'Add');
      const rawAmount = typeof mod.rewardAmount === 'number' ? Math.round(mod.rewardAmount) : 0;
      const mutate = op === 'None' ? ''
        : op === 'Remove'
        ? `foreach (var rew in rewards.Where(r => r is GoldReward).ToList()) { rewards.Remove(rew); }`
        : `rewards.Add(new GoldReward(${rawAmount}, player, false));`;
      // [Round 215] Orthogonal, optional extra mutation -- closes #25
      // cardRewardsCanReroll. CardReward.CanReroll is a real, public,
      // settable bool property (confirmed via direct ecma_dump_ext.py read
      // of MegaCrit.Sts2.Core.Rewards.CardReward this round). Applies
      // ALONGSIDE the Add/Remove Gold operation above (both are optional
      // and independent -- a modifier can do one, the other, or both) so
      // this stays a single override of the same real hook rather than a
      // second, colliding modifier entry on the same method name.
      const rerollMutate = mod.makeCardRewardsRerollable ? ` foreach (var rew in rewards.OfType<CardReward>()) { rew.CanReroll = true; }` : '';
      body = `${bind}        bool baseResult = base.${hook.method}(${paramNames});\n        if (${condExpr})\n        {\n            ${mutate}${rerollMutate}\n            return true;\n        }\n        return baseResult;`;
    }
    blocks.push(
`    // modifier: ${mod.hook} -> ${hook.method}(${hook.params}) [Round 20 — see claude/round20-groupb-findings.md]
    public override ${hook.ret} ${hook.method}(${hook.params})
    {
${body}
    }`);
  }
  return blocks.length ? blocks.join('\n\n') : '';
}

// Same 7 real CardKeyword members card.keywords already uses — reused
// here rather than re-declaring, so there's exactly one source of truth
// for "what's a real keyword" in this file.
const CARD_KEYWORD_VALUES = ['Exhaust', 'Ethereal', 'Innate', 'Retain', 'Unplayable', 'Sly', 'Eternal'];

// Shared by relics (Relic.cs.template) AND mechanics (Power.cs.template) —
// both are hook-driven (react to combat events) rather than "played" like a
// card, so they share the exact same trigger -> real BaseLib method
// mapping. `entityKind` is just for clearer error messages.
// [Round 200 -- "make this section fully functional"] Real per-effect
// pile-membership gate, used to fold Enchantment/Affliction's own "While
// in a Card Pile" entries into this SAME merged-hook codegen instead of
// leaving them uncompiled. `this.Card.Pile` is [VERIFIED via direct
// ECMA-335 metadata read of CardModel, round 200] a real, public,
// non-virtual property (CardModel.get_Pile()), and `CardPile.Type` is
// likewise real (CardPile.get_Type()) -- the exact same real property
// already read as `this.Pile?.Type` from a CARD's own generated class
// elsewhere in this file (whileInHandMergeLines), just reached via
// `this.Card` instead of `this` since here `this` is the Enchantment/
// AfflictionModel instance, not the CardModel itself. Only set on an
// effect when it came from a whilePile entry (see generateEnchantmentSource/
// generateAfflictionSource) -- a plain "Additional Triggers" entry has no
// `__pileGuard` and passes through unwrapped.
function wrapPileGuard(effect, code) {
  if (!effect.__pileGuard) return code;
  const indented = code.split('\n').map(l => l ? '    ' + l : l).join('\n');
  return `        // effect: ${effect.trigger} (while in a pile -- this.Card.Pile is [VERIFIED via direct ECMA-335 metadata read of CardModel, round 200])\n        if (this.Card.Pile?.Type == ${effect.__pileGuard})\n        {\n${indented}\n        }`;
}

function generateHookEffects(entity, entityKind, refMaps) {
  const blocks = [];
  // [Fix, round 35] Same-real-method merge groups. Before this round,
  // every TRIGGER_HOOKS entry mapped to a UNIQUE real `method` (verified
  // by a direct sweep of the table — see TOOLCHAIN_FINDINGS.md, "12
  // triggers -> real Creature.IsEnemy split"), so one effect always meant
  // one generated override. The Mine/Enemy and turn-side splits added
  // this round break that invariant on purpose: e.g. AfterMyBlockBroken
  // and AfterEnemyBlockBroken both compile to the SAME real
  // `AfterBlockBroken` override. C# allows exactly one `public override`
  // per real method name — two entities' worth of these on one entity
  // would be a real CS0111 ("already defines a member") if emitted as two
  // separate methods, so effects that land on the same real method are
  // merged into a single generated override here, each one's own actions
  // wrapped in its own `if (hook.guardExpr)` gate instead. Keyed by real
  // method name, preserving first-seen order (Map, not a plain object, so
  // insertion order is guaranteed regardless of key shape).
  const methodGroups = new Map(); // method -> [{ effect, hook }, ...]
  for (const effect of entity.effects || []) {
    if (effect.trigger === 'OnPlay') {
      // Defense-in-depth backstop — see TRIGGER_HOOKS' header comment for
      // why 'OnPlay' is a card-only trigger. The frontend no longer offers
      // this option for relics/mechanics and backend/validate.js rejects
      // the package before it reaches here, but generateProject() is also
      // callable directly, so this stays a hard error rather than
      // silently compiling something misleading.
      //
      // [Round 199] Afflictions DO have a real OnPlay (AfflictionModel.
      // OnPlay(PlayerChoiceContext, Creature) — a genuinely different real
      // signature from this generic hook vocabulary's own) — it's handled
      // by generateAfflictionSource's own dedicated onPlayBody/
      // onPlayEffects, never through this function, so an affliction's
      // "additional triggers" list (this function's entity.effects) still
      // correctly rejects picking 'OnPlay' again here — same defense-in-
      // depth reasoning, just a more accurate message for this entityKind.
      const reason = entityKind === 'affliction'
        ? `an affliction's own OnPlay is already available as its dedicated "When this card is played" section above — this list is for its OTHER triggers`
        : `a ${entityKind} isn't "played" (that's card-only)`;
      throw new Error(`"${effect.trigger}" isn't a valid trigger here — ${reason}. Pick a real trigger like OnCombatStart, OnTakeDamage, etc.`);
    }
    if (effect.trigger === 'Passive') {
      blocks.push(`    // trigger: Passive — no hook override generated; a passive ${entityKind}'s\n    // presence alone (via CardPool/RelicPool membership, or being applied to a\n    // creature) is assumed to be enough. [UNVERIFIED]`);
      continue;
    }
    const hook = TRIGGER_HOOKS[effect.trigger];
    if (!hook) {
      throw new Error(`No hook mapping registered for ${entityKind} trigger "${effect.trigger}". Add one in compiler.js:TRIGGER_HOOKS.`);
    }
    if (!methodGroups.has(hook.method)) methodGroups.set(hook.method, []);
    methodGroups.get(hook.method).push({ effect, hook });
  }
  for (const group of methodGroups.values()) {
    // Every entry in one group is, by construction, a different Forge id
    // for the exact SAME real hook method — so method/params/playerExpr/
    // targetExpr/petExpr/cardPlayBound/targetMayBeNull are guaranteed
    // identical across the whole group (only `guardExpr`, and the label a
    // user picked, differ between siblings). Take them from the first
    // entry; the assertion below is a cheap tripwire in case a future
    // TRIGGER_HOOKS edit ever breaks that invariant by hand.
    const hook = group[0].hook;
    if (group.some(g => g.hook.params !== hook.params || g.hook.playerExpr !== hook.playerExpr || g.hook.targetExpr !== hook.targetExpr || g.hook.collectionExpr !== hook.collectionExpr)) {
      throw new Error(`TRIGGER_HOOKS entries sharing real method "${hook.method}" have mismatched params/playerExpr/targetExpr/collectionExpr — every id mapped to the same real method must describe the exact same real signature/binding, only guardExpr may differ. Fix the TRIGGER_HOOKS table.`);
    }
    // Local vars are `fgPlayer`/`fgTarget` (Forge-prefixed), NOT `player`/
    // `target` — several real hook parameter LISTS themselves contain a
    // parameter literally named `target` (e.g. AfterDamageReceived's
    // `Creature target`), so a same-named local would be CS0136. See
    // resolveTargetExpr's comment above for the full explanation; this
    // must stay in sync with that naming choice since effectBlockToCSharp/
    // actionToCSharp (shared with Card.cs.template's OnPlay body) also
    // emit `fgPlayer`/`fgTarget` references.
    // fgPet only bound when this hook's petExpr is set (today, just
    // OnAnyCardPlayed — see PET_SUPPORTED_TRIGGERS above) — every other
    // hook either has no real player/target binding at all (the Todo
    // fallback below) or binds off a Creature with no confirmed path back
    // to a Player/Osty, so no fgPet local is declared there at all rather
    // than risk a Pet-subject condition referencing an unbound variable.
    const petLine = hook.petExpr ? `        var fgPet = ${hook.petExpr}; // [VERIFIED via reflect-baselib round 5 — Player.Osty]\n` : '';
    // `fgPlayerBound: true` (added round 25, 2026-09-01) is safe to hardcode
    // here — unlike generateModifierOverrides, this function's `body`
    // (right below) only ever calls effectBlockToCSharp/conditionToCSharp
    // at all in the `hook.playerExpr` truthy branch; when it's null the
    // whole method body is just the Todo() fallback and neither is
    // invoked. So every reachable call passes through this ctx with
    // fgPlayer already unconditionally bound.
    const hookCtx = { cardPlayBound: !!hook.cardPlayBound, fgPlayerBound: true, targetMayBeNull: !!hook.targetMayBeNull, entityKind, affectedCardIsThisCard: entityKind === 'affliction' || entityKind === 'enchantment', cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById }; // targetMayBeNull [Fix, round 29] — see TRIGGER_HOOKS.OnAnyCardPlayed's own comment. entityKind [Fix, round 31] — see resolvePlayerExpr's own comment. affectedCardIsThisCard [Round 199, extended round 200 to entityKind 'enchantment' too] — on an affliction's or enchantment's own additional-trigger hooks, `this` IS the AfflictionModel/EnchantmentModel instance and `this.Card` is always its real, confirmed owning CardModel (see resolveActedCardExpr) — lets AfflictCard/RemoveAffliction/EnchantCard/RemoveEnchantment/ClearAfflictionFromPile work from ANY of these hooks, not just OnPlay.
    // Round 19 added a THIRD real shape beyond "both bound"/"neither bound"
    // — 22 of the 39 new hooks expose exactly ONE real Creature (playerExpr
    // set, targetExpr null: e.g. AfterGoldGained's bare `Player player`,
    // AfterBlockCleared's bare `Creature creature`). Binding fgPlayer alone
    // in that case is real and safe — the risk is actions/conditions that
    // reference the OTHER local (fgTarget, via action.target === 'SingleEnemy'
    // or condition.subject === 'CardTarget') on a hook that never declares
    // it, which would be a real CS0103. backend/validate.js's
    // TARGETLESS_BOUND_HOOK_TRIGGERS (derived from this same TRIGGER_HOOKS
    // map — see this file's module.exports) rejects that combination before
    // it ever reaches here, so no fgTarget-referencing action/condition can
    // survive into a player-only-bound hook body.
    let body;
    if (!hook.playerExpr && !hook.collectionExpr) {
      // Genuinely unbound hook — no real Creature and no real collection
      // exposed at all. Whole effect collapses to a Todo() stub, one call
      // per grouped effect. (Before round 35's follow-up, OnMyTurnStart/
      // OnEnemyTurnStart/OnMyTurnEnd/OnEnemyTurnEnd fell into this branch
      // too — they now have a real collectionExpr and use the loop branch
      // below instead. As of round 35 follow-up, no null-playerExpr entry
      // with a guardExpr remains in this Todo branch — this stays as a
      // defensive fallback for any future trigger that's genuinely
      // unbound rather than collection-bound.)
      body = group.map(({ effect }) => wrapPileGuard(effect,
        `        ForgeActions.Todo("${effect.trigger} effect — ${hook.method}'s real parameters (${hook.params || 'none'}) don't expose a confirmed player/target Creature to bind this effect's actions to"); // [UNVERIFIED]`
      )).join('\n');
    } else if (hook.collectionExpr) {
      // [Fix, round 35 follow-up -- Tyler: "the player and pet all take
      // their turn at the same time. all enemies take their turn at the
      // same time as well."] Real per-participant execution: each
      // effect's own action body runs once per Creature in the real
      // collection, binding that one Creature as fgPlayer for the
      // duration of the loop body — the exact same foreach-over-a-
      // collection pattern already proven for AllEnemies targeting
      // (round 24, actionToCSharp's own AllEnemies case), just applied at
      // the whole-effect level instead of one action. No fgTarget is ever
      // bound here (there's no second Creature in this shape) — that's
      // enforced the same way as every other 'player'-shape hook, via
      // TARGETLESS_BOUND_HOOK_TRIGGERS (backend/validate.js), now derived
      // off `playerExpr || collectionExpr` so these 4 ids are correctly
      // included.
      const effectBodies = group.map(({ effect, hook: effHook }) => {
        const raw = effectBlockToCSharp(effect, hookCtx);
        const loopBody = raw.split('\n').map(l => l ? '    ' + l : l).join('\n');
        const loop = `        foreach (var fgPlayer in ${effHook.collectionExpr}) // [VERIFIED shape via direct sts2.dll read — see TRIGGER_HOOKS.${effect.trigger}'s own comment]\n        {\n${loopBody}\n        }`;
        if (!effHook.guardExpr) return wrapPileGuard(effect, loop);
        // Side-filtered sibling (Mine/Enemy on the real `side` param) —
        // guard wraps the WHOLE loop, not each iteration, since `side`
        // never changes mid-loop (it's a method parameter, not per-
        // participant) — same guard mechanism as every other split pair,
        // see the round-35 comment on effectBodies below in the non-
        // collection branch.
        const indented = loop.split('\n').map(l => l ? '    ' + l : l).join('\n');
        return wrapPileGuard(effect, `        // effect: ${effect.trigger} (side-filtered — see TRIGGER_HOOKS.${effect.trigger}.guardExpr)\n        if (${effHook.guardExpr})\n        {\n${indented}\n        }`);
      });
      body = effectBodies.join('\n');
    } else {
      const bindLines = (hook.playerExpr && hook.targetExpr)
        ? `        var fgPlayer = ${hook.playerExpr}; // [BEST EFFORT]\n        var fgTarget = ${hook.targetExpr}; // [BEST EFFORT]\n${petLine}`
        : `        var fgPlayer = ${hook.playerExpr}; // [VERIFIED via direct sts2.dll read — single-Creature/Player hook, no second party exposed]\n${petLine}`;
      const effectBodies = group.map(({ effect, hook: effHook }) => {
        const raw = effectBlockToCSharp(effect, hookCtx);
        if (!effHook.guardExpr) return wrapPileGuard(effect, raw);
        // [Fix, round 35] Mine/Enemy (or turn-side) filtered sibling —
        // see TRIGGER_HOOKS' own comments on the split entries for the
        // real Creature.IsEnemy/CombatSide evidence this guard is built
        // from. Re-indented one level deeper since it's now wrapped in
        // its own if-block rather than being the whole method body.
        const indented = raw.split('\n').map(l => l ? '    ' + l : l).join('\n');
        return wrapPileGuard(effect, `        // effect: ${effect.trigger} (side-filtered — see TRIGGER_HOOKS.${effect.trigger}.guardExpr)\n        if (${effHook.guardExpr})\n        {\n${indented}\n        }`);
      });
      body = `${bindLines}${effectBodies.join('\n')}`;
    }
    const triggerList = group.map(g => g.effect.trigger).join(', ');
    blocks.push(
`    // trigger(s): ${triggerList} -> ${hook.method}(${hook.params}) [VERIFIED signature via reflect-baselib round 2; player/target binding is best-effort or a Todo fallback, see TRIGGER_HOOKS above. Multiple triggers on one line means they're Mine/Enemy (or turn-side) siblings sharing this one real method — see the round-35 comment on generateHookEffects' methodGroups.]
    public override async System.Threading.Tasks.Task ${hook.method}(${hook.params})
    {
${body}
        await System.Threading.Tasks.Task.CompletedTask;
    }`);
  }
  return blocks.length ? blocks.join('\n\n') : `    // no effect blocks defined on this ${entityKind}`;
}

// --- card.target -> real TargetType -----------------------------------------
// [VERIFIED via reflect-baselib round 6] `TargetType`
// (MegaCrit.Sts2.Core.Entities.Cards.TargetType) is the real 4th parameter
// of CustomCardModel's constructor — NOT a type called "CardTarget" as
// previously guessed (that guess didn't even resolve, CS0103). Its real
// members are None/Self/AnyEnemy/AllEnemies/RandomEnemy/AnyPlayer/
// AnyAlly/AllAllies/TargetedNoCreature/Osty, which don't match this app's
// own `card.target` schema vocabulary (SingleEnemy/AllEnemies/Self/None —
// shared with effect actions' target vocabulary, see ACTION_TARGETS in
// frontend/index.html). Translating here keeps the schema/frontend on
// Forge's own consistent naming rather than exposing BaseLib's directly.
const CARD_TARGET_TYPE_MAP = {
  SingleEnemy: 'AnyEnemy',
  AllEnemies: 'AllEnemies',
  Self: 'Self',
  None: 'None',
};

function cardTargetToRealTargetType(schemaTarget) {
  const real = CARD_TARGET_TYPE_MAP[schemaTarget];
  if (!real) throw new Error(`No real TargetType mapping registered for card.target "${schemaTarget}". Add one in compiler.js:CARD_TARGET_TYPE_MAP.`);
  return real;
}

// --- top-level generation ---------------------------------------------------

// --- card triggers beyond OnPlay --------------------------------------------
// [VERIFIED via reflect-baselib round 9] A full After*/On*/Before* hook
// sweep of CustomCardModel — the exact search round 2 already ran on
// CustomRelicModel but never on this type — turned up two real hooks
// beyond OnPlay/OnUpgrade, directly answering Tyler's "when retained"/
// "when discarded" trigger want (community-doc-sourced CardKeyword.Sly
// already covers a THIRD flavor of "when discarded" — "discard this card
// to replay its OnPlay effect for free" — with no trigger needed at all;
// see generateCanonicalKeywordsOverride above):
//
//   - AfterCardDiscarded(PlayerChoiceContext choiceContext, CardModel card)
//     — [AbstractModel, virtual, public]. Same shape as AfterCardPlayed on
//     relics: fires for ANY card discarded by anyone, not just this one —
//     the generated override filters to `card == this` (via
//     ReferenceEquals) so only this card's own discard triggers it.
//   - OnTurnEndInHand(PlayerChoiceContext choiceContext) — [CardModel,
//     virtual, protected]. Declared directly on THIS card's own class, no
//     filtering needed — but it fires whenever this card is in hand at
//     turn end, WHETHER OR NOT it has the Retain keyword (a non-Retain
//     card fires this once and then gets discarded right after) — the
//     closest real analog to "when retained" found, not a guaranteed
//     Retain-only equivalent. Meant to be paired with CardKeyword.Retain.
//
// Neither real signature exposes a confirmed player/target Creature the
// way OnPlay's `cardPlay` does (same situation as OnDrawCard/OnExhaust on
// relics — see TRIGGER_HOOKS above) — so unlike OnPlay, actions under
// these two ALWAYS compile to ForgeActions.Todo(...) for now, regardless
// of what's actually defined, rather than guess at a binding. The trigger
// itself firing at the real, confirmed moment is real either way; wiring
// real actions to it is a future round's job once something exposes a
// Creature to bind to.
//
// No hook of ANY kind was found for "while in discard" (a continuous
// passive effect while sitting in the discard pile, as opposed to the
// one-time discard EVENT above) — genuinely nothing to wire up, not
// implemented. `AfterCardChangedPiles(CardModel card, PileType
// oldPileType, AbstractModel clonedBy)` exists and could detect "just
// entered the discard pile" as a one-time edge in a future round, but
// that's still an EVENT, not the continuous "while there" Tyler described
// — flagged, not built.
// OnAnyCardPlayed — [VERIFIED via reflect-baselib round 2, re-confirmed
// round 9] AfterCardPlayed(PlayerChoiceContext, CardPlay) is a REAL,
// concrete-overridable hook on CustomCardModel (declared on AbstractModel,
// shared with the already-wired relic hook of the same name) — it was
// sitting in round 2's own CustomCardModel *Play* sweep from the start,
// just never surfaced as a selectable trigger because OnPlay already
// seemed to cover "when played." It doesn't: OnPlay only fires when THIS
// card is played; AfterCardPlayed fires for ANY card played by ANYONE,
// including this card's own play. That's the real mechanism behind
// Tyler's "whenever you play a card marked 'hit', this other card does a
// thing" ask — confirmed directly by reflecting his own
// TheTrainerNewCharacter.dll, which has several Pokemon cards (Bulbasaur,
// Charmander, Ivysaur, Venusaur, Charizard) overriding exactly this hook.
//
// This one carries `fullCardPlayBinding: true` — its real params are the
// SAME CardPlay shape OnPlay itself uses, so fgPlayer/fgTarget (a real
// TARGET Creature, unlike OnDiscard/OnTurnEndInHand) bind for real here
// too (see generateCardSource below). OnDiscard/OnTurnEndInHand get their
// own real fgPlayer (no fgTarget — see CARD_TRIGGER_HOOKS' own comments,
// round 57) a different way, via CardModel.Owner rather than a CardPlay,
// since neither of them actually has one. Pairs with
// the new PlayedCardHasKeyword condition (see conditionToCSharp above) to
// scope it to specific cards — e.g. "whenever a card with the Sly
// keyword is played, do X" — using the real, reflection-confirmed
// CardModel.Keywords getter. True CUSTOM tags (an author-defined value
// beyond the real 7 CardKeyword members, like Tyler's own "Hit" example)
// are a separate, still-open question — see tools/reflect-baselib round
// 10 and TOOLCHAIN_FINDINGS.md for what's confirmed so far (a real,
// documented BaseLib CardTag/[CustomEnum] extensibility mechanism exists,
// but hasn't been reflected against Tyler's own DLLs yet).
// Advanced Options — Tyler's follow-up ask: below the (already-shipped)
// description field, an expandable "Advanced Options" section with 4
// sub-features (card.advancedOptions, schema/character.schema.json).
// 2026-09-07 fix — this summary was stale (still describing costReductions
// as a Todo stub after round 24 wired it for real, and miscounting glow as
// "genuinely unresearched" when it's actually been real since the
// EnergeticAttack/Eternal decompile). Current, accurate state of all 4:
// costReductions and glow both compile to real code (costReductions via
// CardEnergyCost.Add<Scope>, [BEST EFFORT] — see costReductionTodoLines
// below; glow via ShouldGlowGoldInternal, [VERIFIED] — see
// generateGlowOverride); whileInHand reuses the already-real
// OnTurnEndInHand trigger machinery below rather than inventing anything
// new; only playability remains genuinely unresearched and compiles to
// nothing but a descriptive comment — see each helper's own comment for
// the full reasoning.

// Cost reduction — "reduce the cost of this card when you play a skill
// or any other of the possible triggers." Real evidence trail: round
// 14c's IL scan of every real base-game card's own OnPlay() for any
// EnergyCost/StarCost/DynamicVar/ResourceInfo call found exactly ONE
// match — Enlightenment, a real card that reduces OTHER cards' costs by
// calling `get_EnergyCost()` then two real-NAMED methods on the result,
// `SetThisCombat(...)` and `SetThisTurnOrUntilPlayed(...)` (see
// claude/status.md's "X-cost interaction" section). That scan only
// reports call-site METHOD NAMES, not full parameter types/counts —
// guessing a call here risks a hard compile failure (wrong overload),
// a categorically worse outcome than a safe Todo() throw, so this
// doesn't guess. `CardEnergyCost.UpgradeBy(int)` IS fully signature-
// confirmed (round 13), but every sampled real usage applies a
// PERMANENT delta from OnUpgrade() — reusing it for a temporary,
// trigger-scoped reduction would misrepresent what it actually does,
// so it isn't reused here either. Stays a Todo() stub, same "compiles
// but throws" convention as every other [UNVERIFIED] member call in
// this file, carrying the real evidence trail in its own message so a
// future reflect-baselib round confirming Set{Scope}'s real signature
// has exactly what it needs to wire this for real.
// [BEST EFFORT] upgraded round 24 (2026-08-30) — a direct sts2.dll read of
// `MegaCrit.Sts2.Core.Entities.Cards.CardEnergyCost` confirmed the full real
// signatures reflect-baselib round 14c's IL scan only found the NAMES of:
// `AddThisCombat(int amount, bool reduceOnly)` and
// `AddThisTurnOrUntilPlayed(int amount, bool reduceOnly)` (plus
// AddThisTurn/AddUntilPlayed, not exposed by this schema's 2 scopes).
// `CardModel.EnergyCost` is a real public property, so `this.EnergyCost.
// Add<Scope>(...)` reaches it from any of this card's own trigger bodies —
// this function is ONLY ever called from generateCardSource's per-card
// codegen (OnPlay directly, or one of the extra trigger methods), so `this`
// is always a real CardModel here, no ctx/thisIsCard gating needed the way
// actionToCSharp's ShuffleCardIntoDraw case needs it.
// `-amount` (negative) is the reduction itself; `reduceOnly: true` is
// Tyler's own explicit choice (2026-08-30) over `false` — a reduction stays
// a reduction rather than being undoable by whatever `AddXxx`'s otherwise-
// unconfirmed `reduceOnly` semantics might allow.
// `cardTypeFilter` (only meaningful/accepted on the "OnAnyCardPlayed"
// trigger — enforced in validate.js) reuses the SAME real, [VERIFIED]
// `cardPlay.Card.Type == CardType.X` expression conditionToCSharp's own
// PlayedCardHasType case already emits — this is Tyler's own "reduce the
// cost of this card... when you play a skill" example, wrapped in a plain
// `if` around the same Add call rather than inventing a second mechanism.
// 2026-09-07 re-verification — Tyler asked to "iron out how it works" and
// get rid of a stale frontend hint (still describing the pre-round-24
// Todo() stub, never updated when this function stopped emitting one).
// Before touching the UI text, re-ran the underlying evidence fresh rather
// than trusting this comment's own prior claim: `ecma_dump.py` against the
// real sts2.dll re-confirmed CardEnergyCost's full 26-method table exactly
// as described above (Add/SetThisCombat, Add/SetThisTurnOrUntilPlayed,
// Add/SetThisTurn, Add/SetUntilPlayed, all real (int, bool) signatures),
// and `il_dump.py` against Enlightenment.OnPlay's real IL confirms the
// exact mechanism this file's comment describes: it iterates every card in
// `Owner`'s hand pile and calls `card.EnergyCost.SetThisCombat(1, true)`
// (if `IsUpgraded`) or `SetThisTurnOrUntilPlayed(1, true)` (otherwise) on
// EACH one — i.e. Enlightenment reduces OTHER cards' cost, this feature
// reduces THIS card's own, but both go through the exact same real,
// public `CardModel.EnergyCost` property and the exact same real
// `CardEnergyCost` class, so the access pattern this function uses is
// solid. No `InvokeEnergyCostChanged()`/event-raise call appears anywhere
// in Enlightenment's real IL after its Set* calls, confirming the codegen
// below doesn't need one either — CardEnergyCost's own Add/Set methods
// evidently raise `EnergyCostChanged` internally. Frontend hint (the
// `.hint-small.not-real`, red-styled div under this feature's UI) and this
// field's schema description (schema/character.schema.json's
// advancedOptions.costReductions) both updated to match — this comment
// was already accurate, they just never caught up to it.
// [Round 164] Tyler: "is there a way to increase the cost of the card as
// well?" — extended via a new per-entry `direction` field ("Decrease",
// the pre-existing default, or "Increase"). The signature confirmed above,
// `Add{Scope}(int amount, bool reduceOnly)`, was always going to make this
// POSSIBLE (same real method, just a positive amount) — the open question
// was what `reduceOnly` actually does, since its own semantics were never
// independently confirmed, only Tyler's explicit choice to pass `true`
// defensively (see the "2026-08-30" paragraph above). The one piece of
// real behavioral evidence this file has for it is Enlightenment's own
// `SetThisCombat(1, true)` — it unconditionally WANTS every card in hand
// pinned to cost 1, yet still passes `true`, which only makes sense if
// `true` means "only apply this if it would actually lower the value" (a
// guard against a cheaper card's cost getting bumped UP to 1). Passing
// `true` on a positive-amount Increase call would, by that same reading,
// make the call a permanent no-op — a positive delta can never be a
// "lower value" outcome — so Increase entries instead compile with
// `reduceOnly: false`, removing that guard so the raise actually lands.
// This is real code with the same confirmed `(int, bool)` overload as the
// Decrease path (no compile-failure risk — the "guessing a call" caution
// at the top of this comment block is about an unconfirmed METHOD, not an
// already-confirmed method's second argument value), but the false-branch
// behavior itself has no independent decompiled sample confirming it —
// one tier below the Decrease path's own [BEST EFFORT], not equal to it.
// Flagged as such in both the generated C# comment and the schema.
function costReductionTodoLines(card, trigger) {
  const entries = ((card.advancedOptions && Array.isArray(card.advancedOptions.costReductions)) ? card.advancedOptions.costReductions : [])
    .filter(r => r && r.trigger === trigger);
  return entries.map(r => {
    const scope = r.scope === 'ThisTurnOrUntilPlayed' ? 'ThisTurnOrUntilPlayed' : 'ThisCombat';
    const increase = r.direction === 'Increase';
    const signedAmount = increase ? `${r.amount}` : `-${r.amount}`;
    const reduceOnlyArg = increase ? 'false' : 'true';
    const evidenceTag = increase
      ? `[BEST EFFORT, reduceOnly:false inferred — NOT independently confirmed by a decompiled sample, see costReductionTodoLines's own comment]`
      : `[BEST EFFORT]`;
    const call = `        this.EnergyCost.Add${scope}(${signedAmount}, ${reduceOnlyArg}); // ${evidenceTag} see compiler.js's own comment on costReductionTodoLines`;
    // [Round 165] Tyler: "the 'whenever any card is played' trigger should
    // also add in a tag filter option, not just type." cardTagFilter reuses
    // the exact same real PlayedCardHasTag condition an effect block's own
    // "If" section already offers (Forge's own IForgeTaggedCard mechanism —
    // see conditionToCSharp's PlayedCardHasTag case for the full evidence
    // trail; unlike cardTypeFilter this one is fully Forge-owned generated
    // code, not dependent on any base-game internals, so it carries no
    // extra evidence caveat of its own). Both filters are independently
    // optional and, when both are set, ANDed together — same "every
    // condition on a block is ANDed" convention this app already uses
    // everywhere else conditions combine (playability, effect blocks' own
    // "If" sections).
    const filterExprs = [];
    if (r.cardTypeFilter) filterExprs.push(conditionToCSharp({ kind: 'PlayedCardHasType', cardType: r.cardTypeFilter }, { cardPlayBound: true }));
    if (r.cardTagFilter) filterExprs.push(conditionToCSharp({ kind: 'PlayedCardHasTag', tag: r.cardTagFilter }, { cardPlayBound: true }));
    if (filterExprs.length) {
      const condExpr = filterExprs.join(' && ');
      return [`        if (${condExpr})`, `        {`, call, `        }`].join('\n');
    }
    return call;
  });
}

// Card glow — "the option to enable the card to glow when certain
// conditions are met." [UPGRADED TO REAL — see TOOLCHAIN_FINDINGS.md]
// Tyler: "check my theburdenednewcharacter for energetic attack. it has a
// glowing effect when you have 2 or less fatigue (custom status)... it
// also has a card called eternal that gives you regen when it is the
// first card played that turn." Decompiling both real cards found the
// exact real mechanism: `CardModel` exposes a real, non-abstract
// `protected virtual bool ShouldGlowGoldInternal { get; }` — EnergeticAttack
// overrides it with `Owner?.Creature?.GetPowerAmount<FatiguePower>() < 3`,
// Eternal overrides it with the same "cards played this turn" count check
// its own OnPlay uses (see conditionToCSharp's CardsPlayedThisTurn case).
//
// 2026-09-07 rewrite — Tyler: "let's iron out how [glow] works." This
// comment was stale AND, worse, wrong in a way that mattered: it claimed
// HpBelowPercent fell back "safely" to ForgeActions.TodoCondition(...) in
// glow, but that case had no such fallback at all — it unconditionally
// referenced fgPlayer/fgTarget/fgPet, locals that don't exist inside this
// bare property getter, which would have been a HARD C# COMPILE FAILURE
// (CS0103), not a safe runtime throw, the instant a user picked "HP" as a
// glow condition. Same bug existed for HasBlock/DebuffStacksTotal/PetIsOut
// — all 4 are in SUBJECT_CAPABLE_CONDITION_KINDS and frontend/index.html
// already treated them as glow-safe (excluding CardTarget from their
// subject picker there, exactly like it always did for HasStatusStacks),
// so the frontend's own intent was already "these work in glow" — the
// backend just never finished wiring it. Fixed: all 4 now branch through
// resolveGlowSubjectExpr (Owner?.Creature/Owner?.Osty) in glow context,
// the exact same real Creature.CurrentHp/MaxHp/Block/Powers/Pets
// accessors, same pattern HasStatusStacks already used — see each case's
// own 2026-09-07 comment in conditionToCSharpRaw.
//
// Current, accurate state of every condition kind glow.conditions can
// hold: HasStatusStacks, HpBelowPercent, HasBlock, DebuffStacksTotal,
// PetIsOut, CardsPlayedThisTurn, and AttacksPlayedThisTurn all compile to
// REAL, working code here (7 kinds, not 2). EnergyRemaining/StarsRemaining/
// CardsInHand have real backing too, but only where `cardPlay.Player` is
// reachable, which a bare property getter never has — those 3 stay
// PROPERLY guarded (`if (ctx.cardPlayBound) {...}` before ANY reference to
// a cardPlay-derived local), safely falling back to
// ForgeActions.TodoCondition(...) via conditionToCSharp's own existing
// gating (glowContext implies cardPlayBound: false) — a genuine "compiles
// but throws" case, unlike the 4 that were actually broken. Every other
// condition kind (PlayedCardHasType/Keyword/Tag, DamageBrokeBlock,
// HandCardTypeCheck, OrbSlotCount, EnemyIntent, HasSpecificRelic,
// NoCopiesOfCardInHand) is excluded from the glow picker's dropdown
// entirely by frontend/index.html's own conditionKindAllowedForTrigger
// (their requiresTrigger can never be satisfied when eff.trigger is
// undefined, glow's own call shape) — never reachable from here at all,
// not even as a Todo() throw.
function generateGlowOverride(card) {
  const opts = card.advancedOptions || {};
  // [Round 147] Tyler: "lets remove the checkboxes for glow and playability
  // and assume they are checked if there is a condition added." The old
  // `.enabled` checkbox is gone from the UI — this now gates purely on
  // having at least one real condition, so an empty list means genuinely
  // off (no override emitted at all) rather than the old "enabled with
  // zero conditions = always runs" case, which is no longer reachable from
  // the UI (there's no way left to turn this on without adding a
  // condition). `.enabled` itself is left alone in the data model —
  // harmless, unread legacy state on old saved packages.
  const conditions = Array.isArray(opts.glow && opts.glow.conditions) ? opts.glow.conditions : [];
  if (!conditions.length) return null;
  const expr = conditions.map(c => conditionToCSharp(c, { glowContext: true })).join(' && ');
  return [
    '    // [Advanced Options] Card glow — [VERIFIED via decompiling',
    '    // TheBurdenedNewCharacter.dll] CardModel.ShouldGlowGoldInternal is a',
    '    // real, non-abstract `protected virtual bool` property; both',
    '    // EnergeticAttack and Eternal override it exactly this way. See',
    '    // TOOLCHAIN_FINDINGS.md for the full evidence trail.',
    '    protected override bool ShouldGlowGoldInternal =>',
    `        ${expr};`,
  ].join('\n');
}

// Playability conditions — "playability conditions, so the card is only
// playable when your actions have met a certain criteria." WIRED FOR REAL
// as of 2026-09-08 (round 52). Previously flagged as "genuinely
// unresearched" — no round had ever found a CanPlay/IsPlayable-shaped
// override, and guessing an `override` specifically (vs. a plain method
// call) risks a hard CS0115 if wrong, a categorically worse blast radius
// than a runtime throw, so nothing was emitted rather than guess.
//
// Tyler's updated TheBurdenedNewCharacter.dll v3 closed that gap for
// real: his own "Earthquake" card has a real playableCondition
// ("isLeftmostInHand", confirmed both in the mod creator's exported
// project.txt and in the compiled DLL). Decompiling it directly
// (il_dump.py against the real DLL) found the actual override:
// [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 — Earthquake]
// `CardModel.IsPlayable` is a real, non-abstract `protected virtual bool`
// property — Earthquake overrides it exactly like Glow/ShouldGlowGoldInternal
// (a bare getter, no cardPlay in scope) — see conditionToCSharpRaw's
// CardPositionInHand case for the exact decompiled expression. Earthquake's
// OWN ShouldGlowGoldInternal override is literally `return this.IsPlayable;`
// — independent, real confirmation that Glow and Playability share this
// identical bare-getter shape, which is why generatePlayabilityOverride
// below reuses `conditionToCSharp(c, { glowContext: true })` verbatim
// (same resolveGlowSubjectExpr-based resolution, same real condition
// kinds) rather than inventing a second, parallel context flag — every
// condition kind already real inside Glow (HasStatusStacks, HpBelowPercent,
// HasBlock, DebuffStacksTotal, PetIsOut, CardsPlayedThisTurn,
// AttacksPlayedThisTurn, and the new CardPositionInHand) becomes real
// inside Playability too, for free, backed by the exact same evidence.
//
// Earthquake's own override REPLACES the base check entirely (its real,
// decompiled IL never calls `base.get_IsPlayable()` anywhere) — matched
// here exactly: an empty/false condition list emits `true` (matching
// glow's own "no conditions = always runs" convention) rather than ANDing
// with a `base.IsPlayable` whose default behavior isn't evidenced.
function generatePlayabilityOverride(card) {
  const opts = card.advancedOptions || {};
  // [Round 147] Same change as generateGlowOverride above — gates on
  // having at least one condition instead of the now-removed `.enabled`
  // checkbox.
  const conditions = Array.isArray(opts.playability && opts.playability.conditions) ? opts.playability.conditions : [];
  if (!conditions.length) return null;
  const expr = conditions.map(c => conditionToCSharp(c, { glowContext: true })).join(' && ');
  return [
    '    // [Advanced Options] Playability conditions — [VERIFIED via',
    '    // decompiling TheBurdenedNewCharacter.dll v3] CardModel.IsPlayable',
    '    // is a real, non-abstract `protected virtual bool` property;',
    '    // Earthquake overrides it exactly this way to require being the',
    '    // leftmost card in hand. See TOOLCHAIN_FINDINGS.md for the full',
    '    // evidence trail.',
    '    protected override bool IsPlayable =>',
    `        ${expr};`,
  ].join('\n');
}
function generateAdvancedOptionsNotes(card) {
  const opts = card.advancedOptions || {};
  const parts = [];
  const glowOverride = generateGlowOverride(card);
  if (glowOverride) parts.push(glowOverride);
  const playabilityOverride = generatePlayabilityOverride(card);
  if (playabilityOverride) parts.push(playabilityOverride);
  return parts.join('\n\n');
}

// [Round 90] Per-hook ownership-guard expression — compares the event's
// own real Player/Creature param (exact param name straight off that
// hook's TRIGGER_HOOKS.params string) against `this.Owner`, matching the
// exact pattern decompiled from Tyler's own reference cards (see the big
// comment above CARD_TRIGGER_HOOKS' declaration for the full evidence).
// `null` = no single bindable Player/Creature exists in this hook's real
// params — fires unscoped (any matching event), same honest limitation
// already carried by that id's own TRIGGER_HOOKS entry elsewhere.
const PILE_TRIGGER_OWNER_GUARD = {
  AfterPlayerTurnStart: 'player == this.Owner',
  AfterEnergyReset: 'player == this.Owner',
  BeforeHandDraw: 'player == this.Owner',
  AfterHandEmptied: 'player == this.Owner',
  AfterOrbChanneled: 'player == this.Owner',
  AfterOrbEvoked: null, // real params: choiceContext, orb, IEnumerable<Creature> targets — no single bindable Player.
  AfterPotionUsed: 'target == this.Owner.Creature', // real params bind a Creature ("target"), not a Player — compared against this.Owner.Creature instead.
  AfterPotionDiscarded: null, // real params: potion only — no Player/Creature at all.
  AfterPotionProcured: null, // real params: potion only — no Player/Creature at all.
  AfterStarsSpent: 'spender == this.Owner',
  AfterStarsGained: 'gainer == this.Owner',
  AfterForge: 'forger == this.Owner',
  AfterDiedToDoom: null, // real params: choiceContext, IReadOnlyList<Creature> creatures — a COLLECTION, no single bindable Player.
  AfterCombatEnd: null, // real params: room only — no Player/Creature at all.
  AfterEnergySpent: 'card.Owner == this.Owner', // real params bind the CARD whose energy was spent, not a Player directly — compared via that card's own Owner.
};
// The 15 ids above, in one place — the allowed trigger vocabulary for
// card.advancedOptions.whileInHand entries beyond the pre-existing
// 'OnTurnEndInHand' (which stays its own separate, simpler codegen path
// below — it's inherently hand-only already, so it never needed a pile
// check to begin with).
const PILE_TRIGGER_HOOK_IDS = Object.keys(PILE_TRIGGER_OWNER_GUARD);
// [Round 90] Real PileType enum values, MegaCrit.Sts2.Core.Entities.Cards.
// PileType — Hand=2 already independently confirmed elsewhere in this
// codebase (see PILE_TYPE_BY_DEST above); Draw=1/Discard=3/Exhaust=4 read
// directly off Tyler's own reference cards' decompiled IL this round (see
// the big comment above for the exact evidence).
function pileTypeExpr(pile) {
  const p = ['Hand', 'Discard', 'Draw', 'Exhaust'].includes(pile) ? pile : 'Hand';
  return `MegaCrit.Sts2.Core.Entities.Cards.PileType.${p}`;
}

// [Round 195 -- Tyler: "i noticed there isn't a 'whenever you play a
// card' trigger in here" (WHILE_IN_HAND_TRIGGERS' bubble picker, both the
// card Advanced Options "While in a pile" section and the enchantment
// editor's analog).] While tracing how to add it, found that whileInHand
// entries for a trigger that's ALSO a real CARD_TRIGGER_HOOKS key (until
// now, only OnTurnEndInHand) were being silently dropped from codegen --
// the override method DID get generated (cardEffectsPlusWhileInHand made
// the "does this method need to exist at all" check in extraTriggerMethods
// see them) but cascadingTriggerBody's actual body-generation only ever
// reads card.effects, never card.advancedOptions.whileInHand. A card with
// ONLY a whileInHand OnTurnEndInHand entry (no base card.effects entry on
// that trigger) compiled to a real, empty, "// no effects defined"
// override -- a genuine pre-existing bug, not a design choice (confirmed
// via a standalone generateProject() test before this fix: a GainBlock
// action set through the "While in a pile" UI never appeared anywhere in
// the generated C#). This helper is the fix, called from both
// extraTriggerMethods branches below: it emits the whileInHand-sourced
// entries for a trigger as an extra body segment, appended as a SIBLING
// to cascadingTriggerBody's output (same "appended alongside, not merged
// inside" shape costReductionTodoLines' lines already use in the same two
// callers) rather than folded into it, so upgrade-tier branching (which
// whileInHand entries have no concept of -- they're not per-tier) stays
// untouched.
//   - OnTurnEndInHand: pile is decorative/ignored here (see round 156 --
//     that hook is inherently hand-only already), so its entries merge in
//     completely ungated, matching the design intent round 90's own
//     comment already claimed ("the pre-existing OnTurnEndInHand path...
//     never needed a pile check") -- it just wasn't actually wired up.
//   - Every other hook reachable here (OnAnyCardPlayed, as of this round)
//     fires broadly (for ANY card played, regardless of where THIS card
//     is currently sitting), so each entry needs its own real
//     `this.Pile?.Type == X` gate -- same shape pileTriggerMethods already
//     uses for the other 15 pile-aware triggers, reusing pileTypeExpr.
function whileInHandMergeLines(entries, trigger, ctx) {
  if (!entries.length) return '';
  if (trigger === 'OnTurnEndInHand') {
    return effectsToCSharp(entries, ctx);
  }
  return entries.map(e => {
    const inner = effectBlockToCSharp(e, ctx);
    const indented = inner.split('\n').map(l => `    ${l}`).join('\n');
    return `        if (this.Pile?.Type == ${pileTypeExpr(e.pile)})\n        {\n${indented}\n        }`;
  }).join('\n');
}

const CARD_TRIGGER_HOOKS = {
  // [Round 57 — VERIFIED via decompiling Tyler's DiscardStatusPower
  // (TheBurdenedNewCharacter.dll v5) + direct sts2.dll read of
  // CardModel.Owner — see PET_SUPPORTED_TRIGGERS' own comment for the
  // full evidence] `playerExpr`/`petExpr` give this hook a real fgPlayer/
  // fgPet binding (via `this.Owner`, real+public+Player-typed) even
  // though there's no `cardPlay` here — `this` is the discarded card
  // itself once `selfFilter` below has already confirmed
  // `ReferenceEquals(card, this)`. No `targetExpr` — a discard has no
  // real "target" Creature at all, so SingleEnemy actions/CardTarget
  // subject stay rejected (backend/validate.js's
  // TARGETLESS_BOUND_HOOK_TRIGGERS, now derived off CARD_TRIGGER_HOOKS
  // too).
  OnDiscard: {
    method: 'AfterCardDiscarded',
    params: 'PlayerChoiceContext choiceContext, CardModel card',
    access: 'public',
    selfFilter: true,
    playerExpr: 'this.Owner.Creature',
    petExpr: 'this.Owner.Osty',
  },
  // [Round 57] Same real CardModel.Owner evidence as OnDiscard above —
  // `this` is already the specific card kept in hand at turn end (no
  // `card` param needed here, unlike OnDiscard, since this hook is
  // already per-instance), so `this.Owner.Creature`/`this.Owner.Osty`
  // give it the same real fgPlayer/fgPet binding. No targetExpr, same
  // reasoning as OnDiscard — nothing is being targeted when your turn
  // ends with a card still in hand.
  OnTurnEndInHand: {
    method: 'OnTurnEndInHand',
    params: 'PlayerChoiceContext choiceContext',
    access: 'protected',
    selfFilter: false,
    playerExpr: 'this.Owner.Creature',
    petExpr: 'this.Owner.Osty',
  },
  OnAnyCardPlayed: {
    method: 'AfterCardPlayed',
    params: 'PlayerChoiceContext choiceContext, CardPlay cardPlay',
    access: 'public',
    selfFilter: false, // deliberately NOT filtered — fires for any card including this one's own play; see comment above
    fullCardPlayBinding: true,
  },
  // [Round 95 — Tyler: "'When this card is retained' trigger — is already
  // on a couple of cards in my theburdenednewcharacter file, namely
  // 'Patient Strike'"] VERIFIED via decompiling BOTH PatientStrike.cs AND
  // TrainedAssault.cs (TheBurdenedNewCharacter.dll) — two real, shipped,
  // independent retain-scaling cards using the IDENTICAL override, not a
  // one-off: `public override Task AfterFlush(PlayerChoiceContext
  // choiceContext, Player player, IReadOnlyCollection<CardModel>
  // flushedCards, IReadOnlyCollection<CardModel> retainedCards)`. Fires
  // once per end-of-turn card flush for EVERY card currently in play
  // (any owner, any pile) — both real examples gate identically down to
  // THIS specific card being retained by ITS OWN owner:
  // `player == base.Owner && retainedCards.Contains(this)`. Real
  // fgPlayer/fgPet via this.Owner, same evidence CARD_TRIGGER_HOOKS'
  // OnDiscard/OnTurnEndInHand entries already rely on — no real "target"
  // Creature (retaining a card isn't targeted at anything, same as
  // discard/turn-end-in-hand above).
  OnRetained: {
    method: 'AfterFlush',
    params: 'PlayerChoiceContext choiceContext, Player player, System.Collections.Generic.IReadOnlyCollection<CardModel> flushedCards, System.Collections.Generic.IReadOnlyCollection<CardModel> retainedCards',
    access: 'public',
    retainFilter: true,
    playerExpr: 'this.Owner.Creature',
    petExpr: 'this.Owner.Osty',
  },
};

// ---- Description first pass: CanonicalVars + Localization/CardLoc ----
// [Round 16, Tyler: "everything, including a first pass at description
// redesign"] — decompiling TheBurdenedNewCharacter's real source found
// that NONE of its 71 regular cards manually author description text at
// all: every one declares `protected override IEnumerable<DynamicVar>
// CanonicalVars => new DynamicVar[] { new DamageVar(6m, ValueProp.Move),
// ... }`, and the base game auto-composes vanilla-style "Deal !D! damage."
// text from those declared vars — confirmed real constructors, seen
// dozens of times each: `DamageVar(decimal, ValueProp)`,
// `BlockVar(decimal, ValueProp)` (both always paired with `ValueProp.Move`
// in every real example), `PowerVar<TPower>(decimal)` (TPower can be a
// real vanilla built-in power class OR the mod's own custom power class —
// confirmed both ways), and `CardsVar(int)` — confirmed via Yoink's real
// OnPlay reading `base.DynamicVars.Cards.BaseValue` into
// `CardPileCmd.Draw(...)`, i.e. CardsVar is specifically "cards this card
// draws", not a generic card-count var. `CustomCardModel.GainsBlock` also
// reads `DynamicVars.Any(v => v.Value is BlockVar or CalculatedBlockVar)`
// — so declaring BlockVar isn't just cosmetic, it affects real UI behavior
// (whether the game shows this card's block-gain icon).
//
// THIS FIRST PASS emits CanonicalVars declaratively, mirroring whatever
// literal amount this card's own OnPlay codegen already uses — it does
// NOT rewire OnPlay to read back through `base.DynamicVars.X.BaseValue`
// the way Yoink's real OnPlay does (`DamageCmd.Attack(base.DynamicVars.
// Damage.BaseValue)` instead of a literal), and OnUpgrade still uses
// Forge's existing CurrentUpgradeLevel-branch codegen rather than Yoink's
// real `base.DynamicVars.Cards.UpgradeValueBy(1m)` pattern. Wiring
// CanonicalVars into the ACTUAL executed amount (not just a declared-
// alongside duplicate) is real, deeper surgery on working, already-
// [VERIFIED] codegen — flagged here as the natural next round, not
// attempted in this first pass. Only literal, non-X, non-per-stack-
// scaling amounts on this card's own base-tier OnPlay actions are
// emitted; anything else (X-cost cards, per-stack scaling, non-OnPlay
// triggers) is silently skipped — CanonicalVars staying incomplete for
// those cards is honest (real cards can have partial/no CanonicalVars,
// e.g. Card.cs's own `Array.Empty<DynamicVar>()` example), unlike a Todo
// stub that throws.
function generateCanonicalVars(card) {
  const onPlayActions = (card.effects || [])
    .filter(e => e.trigger === 'OnPlay')
    .flatMap(e => e.actions || []);
  const isLiteral = a => !a.amountIsX && !a.amountIsStarX && !a.amountScalesWithStatus && !a.amountScalesWithBuiltinStatus
    && a.amount !== undefined && a.amount !== null && !Number.isNaN(Number(a.amount));
  const vars = [];
  for (const action of onPlayActions) {
    if (action.type === 'DealDamage' && isLiteral(action)) {
      vars.push(`new DamageVar(${action.amount}m, ValueProp.Move)`);
    } else if (action.type === 'GainBlock' && isLiteral(action)) {
      vars.push(`new BlockVar(${action.amount}m, ValueProp.Move)`);
    } else if (action.type === 'DrawCard' && isLiteral(action)) {
      vars.push(`new CardsVar(${Math.trunc(Number(action.amount))})`);
    } else if (action.type === 'ModifyStatus' && (action.mode !== 'Remove') && !action.amountIsX && !action.amountIsStarX && !action.amountScalesWithStatus && !action.amountScalesWithBuiltinStatus) {
      for (const entry of (action.statusEntries || [])) {
        if (entry.amount === undefined || entry.amount === null || Number.isNaN(Number(entry.amount))) continue;
        const typeArg = entry.kind === 'vanilla' ? BUILTIN_POWER_CLASS_MAP[entry.ref] : mechanicClassName(entry.ref);
        if (!typeArg) continue;
        vars.push(`new PowerVar<${typeArg}>(${entry.amount}m)`);
      }
    }
  }
  if (!vars.length) return '';
  return `
    // [BEST EFFORT via decompiling TheBurdenedNewCharacter.dll — declared-only first pass, see compiler.js's own comment on generateCanonicalVars] mirrors this card's own literal OnPlay amounts; not yet wired back into OnPlay/OnUpgrade's actual executed values.
    protected override IEnumerable<DynamicVar> CanonicalVars =>
        new DynamicVar[] { ${vars.join(', ')} };`;
}

// [Round 95, Tyler: "my theburdened character has a card called basket of
// apples that gives the player a golden apple token. Hovering over the
// basket of apples card shows a preview of the golden apple token, but
// I'm not sure if that is something that the web app has coded in in the
// background, or if it is base game."] Investigated by decompiling the
// real BasketOfApples.cs: it's neither automatic base-game behavior nor
// anything Forge compiled before this round — the card explicitly
// declares `protected override IEnumerable<IHoverTip> ExtraHoverTips =>
// new IHoverTip[] { HoverTipFactory.FromCard<GoldenApple>() };`
// [VERIFIED — CustomCardModel really does declare an overridable
// ExtraHoverTips member, and HoverTipFactory.FromCard<T>() is the exact
// real method ModStatusBars.cs's own Round 13-14 investigation already
// found (MegaCrit.Sts2.Core.HoverTips.{HoverTip, IHoverTip,
// HoverTipFactory}), independently cross-confirmed here by a second real
// usage]. This generates that override for real: every distinct Forge
// token card (tokenRefKind:'custom', a real generated class via
// ctx.cardClassById — same resolution CreateCard's own codegen uses)
// referenced by one of this card's own CreateCard actions gets a hover
// preview wired up automatically, matching the game's own real
// convention Tyler pointed at. Vanilla token refs (tokenRefKind:'vanilla')
// are skipped — VANILLA_TOKEN_CARD_CLASS_MAP is Tyler's own best-effort
// guess list, not confirmed real class names on every entry, and a wrong
// class reference here would be a hard compile failure (CS0246), not a
// safe no-op.
function generateHoverTipsOverride(card, refMaps) {
  const cardClassById = refMaps && refMaps.cardClassById;
  if (!cardClassById) return '';
  const whileInHandEffects = (card.advancedOptions && Array.isArray(card.advancedOptions.whileInHand)) ? card.advancedOptions.whileInHand : [];
  const allEffects = (card.effects || []).concat(whileInHandEffects);
  const tokenClasses = new Set();
  for (const eff of allEffects) {
    for (const action of (eff.actions || []).concat(eff.elseActions || [])) {
      if (action.type === 'CreateCard' && action.tokenRefKind !== 'vanilla' && action.tokenRef) {
        const cls = cardClassById.get(action.tokenRef);
        if (cls) tokenClasses.add(cls);
      }
    }
  }
  if (!tokenClasses.size) return '';
  const entries = [...tokenClasses].map(cls => `HoverTipFactory.FromCard<${cls}>()`);
  return `
    // [VERIFIED override point, see compiler.js's own comment on generateHoverTipsOverride — decompiled directly from TheBurdenedNewCharacter's real BasketOfApples.cs] hover preview for the token card(s) this card creates, matching the game's own real convention.
    protected override IEnumerable<IHoverTip> ExtraHoverTips =>
        new IHoverTip[] { ${entries.join(', ')} };`;
}

// [VERIFIED via reading BaseLib's real Abstracts/ILocalizationProvider.cs
// source directly — round 16] `CustomCardModel : CardModel, ICustomModel,
// ILocalizationProvider` already declares `public virtual List<(string,
// string)>? Localization => null;` — a real, overridable member, and
// `CardLoc(string Title, string Description, params (string,string)[]
// ExtraLoc)` is a real record with a confirmed implicit conversion to
// exactly that list shape. NO real card in the decompiled mod actually
// uses this path (all 71 rely on CanonicalVars-driven vanilla auto-
// composition instead, per generateCanonicalVars above) — CardLoc is
// BaseLib's real mechanism for freeform AUTHORED text, which is what
// Forge's own `card.description` field is (Tyler: "an editable
// description box"), so this is still the correct real override to use
// for it, just a different (and rarer, in the wild) path than the vanilla
// cards take. [Round 204] `card.description` is the user's own typed
// override ONLY — never auto-filled any more (see that field's own
// schema note). The real fallback chain, matching what the live editor
// preview already shows: a real typed description wins outright; failing
// that, `card.autoGeneratedDescription` (Forge's own best-effort guess,
// refreshed by the frontend every time the card editor is saved with the
// field left blank); failing THAT too (a package edited/imported outside
// the normal editor flow, so no save ever ran), the plain fallback string
// below.
function generateCardLocalization(card) {
  const title = (card.name || 'Untitled').replace(/"/g, '\\"');
  const description = (card.description || card.autoGeneratedDescription || 'See card effects.').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `
    // [VERIFIED override point via reading BaseLib's real ILocalizationProvider.cs source — see compiler.js's own comment on generateCardLocalization] authored description text.
    public override List<(string, string)>? Localization => new CardLoc("${title}", "${description}");`;
}

// [VERIFIED via direct ECMA-335 metadata read of the real installed
// BaseLib.dll, not source-reading or inference — round 28's shop-sprite
// investigation] `CustomCharacterModel : ... , ILocalizationProvider`
// declares the SAME `Localization` member CardLoc already uses for cards
// (see generateCardLocalization above), and `BaseLib.Abstracts.
// CharacterLoc` is a real record with a confirmed implicit conversion to
// that exact `List<(string,string)>?` shape — this is characters' own
// CardLoc-equivalent. Its real constructor (confirmed via ecma_dump.py
// against BaseLib.dll directly) is NOT just Title/Description like
// CardLoc — it's 14 required string fields: Title, TitleObject,
// Description, PronounObject, PronounSubject, PronounPossessive,
// PossessiveAdjective, AromaPrinciple, EndTurnPingAlive, EndTurnPingDead,
// EventDeathPrevention, GoldMonologue, CardsModifierTitle,
// CardsModifierDescription, plus an ExtraLoc (string,string)[] tail.
//
// THIS WAS PREVIOUSLY MISSING ENTIRELY — no character.cs.template ever
// emitted a Localization override, so every Forge-exported character
// compiled and installed clean but carried NO registered name/title/
// description anywhere the game's loc tables could find. Strong
// circumstantial evidence this is why Tyler's real installed TestChar
// mod never appeared on the character select screen at all (Tyler,
// verbatim: "Spine shop test does not show up as a character in the
// selection screen. TestChar didnt either.") — cross-checked against
// ModTemplate-StS2's own official setup guide, which treats generating
// `localization/eng/characters.json` content as a REQUIRED step for the
// character template, not optional polish. Not 100% certain this is the
// ONLY blocker (see the "Ancient" registration open question in
// TOOLCHAIN_FINDINGS.md's round writeup), but it is definitely something
// every real working character mod has and Forge's output never did.
//
// Field mapping, [BEST EFFORT] beyond the 3 schema-backed ones:
//   Title / TitleObject     <- character.name (schema-backed; TitleObject
//                               reuses the same proper noun — names don't
//                               inflect, so no separate "object case" form
//                               is needed)
//   Description             <- character.shortDescription (schema-backed)
//   PronounObject/Subject/
//   Possessive, Possessive
//   Adjective                <- derived from character.gender (schema-
//                               backed, [VERIFIED] enum) via ordinary
//                               English grammar - a real, correct mapping,
//                               not a guess, for the 3 values the enum
//                               actually offers (Neutral -> they/them/
//                               their/theirs).
//   Everything else (AromaPrinciple, EndTurnPingAlive/Dead,
//   EventDeathPrevention, GoldMonologue, CardsModifierTitle/Description)
//                            <- no schema field collects this narrative/
//                               flavor text yet. [Round 203] character.lore
//                               (design-preview-only) was renamed/replaced
//                               by character.chronicles — a different,
//                               structurally distinct concept (per-epoch
//                               title/description/unlockInfo, compiled for
//                               real into localization/eng/epochs.json —
//                               see generateChronicleLocalization) that
//                               was never a fit for this character-wide
//                               narrative text either. Defaulted to character.shortDescription
//                               (or character.name where a short label
//                               reads better) so the character compiles
//                               and registers with REAL text everywhere
//                               the game looks, rather than empty strings
//                               of unknown consequence — clearly [BEST
//                               EFFORT placeholder] in the generated
//                               comment, worth its own authoring UI later
//                               if Tyler wants real per-field flavor text.
function generateCharacterLocalization(character) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const name = esc(character.name || 'Unnamed');
  const desc = esc(character.shortDescription || 'No description yet.');
  const gender = ['Neutral', 'Feminine', 'Masculine'].includes(character.gender) ? character.gender : 'Neutral';
  const pronouns = {
    Neutral:   { object: 'them',  subject: 'they', possessive: 'theirs', adjective: 'their' },
    Feminine:  { object: 'her',   subject: 'she',  possessive: 'hers',   adjective: 'her'   },
    Masculine: { object: 'him',   subject: 'he',   possessive: 'his',    adjective: 'his'   },
  }[gender];
  return `
    // [VERIFIED override point via direct ECMA-335 read of the real installed BaseLib.dll — see compiler.js's own comment on generateCharacterLocalization] Title/Description are real (character.name/shortDescription); pronoun fields are a real, correct mapping from character.gender; the remaining narrative-flavor fields (AromaPrinciple/EndTurnPing*/EventDeathPrevention/GoldMonologue/CardsModifier*) are [BEST EFFORT placeholder] text — Forge has no dedicated authoring UI for that content yet.
    public override List<(string, string)>? Localization => new CharacterLoc(
        Title: "${name}",
        TitleObject: "${name}",
        Description: "${desc}",
        PronounObject: "${pronouns.object}",
        PronounSubject: "${pronouns.subject}",
        PronounPossessive: "${pronouns.possessive}",
        PossessiveAdjective: "${pronouns.adjective}",
        AromaPrinciple: "${desc}",
        EndTurnPingAlive: "${name}, turn's over.",
        EndTurnPingDead: "...",
        EventDeathPrevention: "${name} narrowly survives.",
        GoldMonologue: "More gold for the journey.",
        CardsModifierTitle: "${name}'s Cards",
        CardsModifierDescription: "${desc}",
        ExtraLoc: System.Array.Empty<(string, string)>());`;
}

function generateCardSource(card, namespace, poolClassName, cardArtOverride, refMaps) {
  const tpl = loadTemplate('Card.cs.template');
  // Defense-in-depth: cards only ever get real CustomCardModel overrides
  // for the triggers in CARD_TRIGGER_HOOKS plus "OnPlay" (see
  // Card.cs.template) — anything else has never been confirmed against
  // real BaseLib. This USED to silently filter out and drop any
  // non-OnPlay effect block with no error at all — caught by a real
  // stress test: a card with a "Passive" effect block compiled clean,
  // with that entire effect block silently discarded, no warning
  // anywhere. The frontend no longer offers any other trigger and
  // backend/validate.js rejects the package before it reaches here, but
  // generateProject() is also callable directly, so this stays a hard
  // error instead of quietly losing data again.
  const allowedCardTriggers = new Set(['OnPlay', ...Object.keys(CARD_TRIGGER_HOOKS)]);
  // Advanced Options' whileInHand entries are cardEffectBlock-shaped
  // (same trigger/conditions/actions/elseActions fields) — as of round
  // 195, trigger can be 'OnTurnEndInHand' OR 'OnAnyCardPlayed' (plus the
  // 15 PILE_TRIGGER_HOOK_IDS handled by pileTriggerMethods below), Tyler
  // having pointed out "whenever you play a card" was missing from the
  // picker. cardEffectsPlusWhileInHand (just below) only decides whether
  // each trigger's override method needs to exist at all — the actual
  // body content for OnTurnEndInHand/OnAnyCardPlayed comes from
  // whileInHandMergeLines (see its own comment for the real bug this
  // round found and fixed: whileInHand's OnTurnEndInHand entries used to
  // compile to a real, silently EMPTY override, never actually reading
  // card.advancedOptions.whileInHand at all despite this comment's old
  // claim that they did).
  const whileInHandEffects = (card.advancedOptions && Array.isArray(card.advancedOptions.whileInHand)) ? card.advancedOptions.whileInHand : [];
  const cardEffectsPlusWhileInHand = (card.effects || []).concat(whileInHandEffects);
  const badTrigger = cardEffectsPlusWhileInHand.find(e => !allowedCardTriggers.has(e.trigger) && !PILE_TRIGGER_HOOK_IDS.includes(e.trigger));
  if (badTrigger) {
    throw new Error(`Card "${card.name}" has an effect block with trigger "${badTrigger.trigger}" — cards only support ${[...allowedCardTriggers].join(', ')} (plus ${PILE_TRIGGER_HOOK_IDS.join(', ')} inside Advanced Options' "While in a pile" section specifically) right now (no other CustomCardModel hook has been confirmed against real BaseLib yet).`);
  }
  const badBasePileTrigger = (card.effects || []).find(e => PILE_TRIGGER_HOOK_IDS.includes(e.trigger));
  if (badBasePileTrigger) {
    throw new Error(`Card "${card.name}" has a base Effects block with trigger "${badBasePileTrigger.trigger}" — that trigger only exists inside Advanced Options' "While in a pile" section (card.advancedOptions.whileInHand), not a card's own Effects list.`);
  }
  const badCostReductionTrigger = ((card.advancedOptions && card.advancedOptions.costReductions) || []).find(r => r && !allowedCardTriggers.has(r.trigger));
  if (badCostReductionTrigger) {
    throw new Error(`Card "${card.name}" has an Advanced Options cost-reduction rule with trigger "${badCostReductionTrigger.trigger}" — cost reductions only support the same triggers cards do: ${[...allowedCardTriggers].join(', ')}.`);
  }

  // card.upgrade (singular) was replaced by card.upgrades[] (up to
  // MAX_UPGRADE_TIERS tiers — Tyler: "some cards have the ability to be
  // upgraded multiple times... up to 4 upgrades"). resolveUpgradeTiers()
  // turns any `null` (still-mirroring) entries into the real, fully-known
  // effects/costDelta each tier actually resolves to — every trigger's
  // body below (OnPlay and the extra hooks) and OnUpgrade()/
  // MaxUpgradeLevel share this single resolved list.
  const resolvedTiers = resolveUpgradeTiers(card);

  // Advanced Options' cost-reduction rules targeting OnPlay fold into
  // this same method body, right after any real effects — see
  // costReductionTodoLines above.
  const onPlayCostLines = costReductionTodoLines(card, 'OnPlay');
  const body = [cascadingTriggerBody(card, 'OnPlay', resolvedTiers, refMaps), onPlayCostLines.join('\n')].filter(Boolean).join('\n') || '        // no OnPlay effects defined';

  // Extra trigger methods (OnDiscard/OnTurnEndInHand) — one real override
  // method per distinct trigger actually used on this card (by the base
  // card, any upgrade tier, or an Advanced Options whileInHand/
  // cost-reduction rule targeting it — see cardEffectsPlusWhileInHand/
  // costReductionTodoLines above), grouping all of that trigger's effect
  // blocks under it (same "trigger -> one override" shape OnPlay already
  // uses), gated by CurrentUpgradeLevel exactly like OnPlay when the card
  // has upgrade tiers.
  const extraTriggerMethods = Object.keys(CARD_TRIGGER_HOOKS)
    .map(trigger => {
      const baseEffects = cardEffectsPlusWhileInHand.filter(e => e.trigger === trigger);
      const tierHasEffects = resolvedTiers.some(t => (t.effects || []).some(e => e.trigger === trigger));
      const costLines = costReductionTodoLines(card, trigger);
      if (!baseEffects.length && !tierHasEffects && !costLines.length) return null;
      const hook = CARD_TRIGGER_HOOKS[trigger];
      const filterLine = hook.selfFilter
        ? `        if (!ReferenceEquals(card, this)) { await Task.CompletedTask; return; } // only react to THIS card's own event — ${hook.method} fires for anyone's\n`
        // [Round 95] OnRetained's own selfFilter-equivalent — AfterFlush
        // fires once per flush for every card in play, not just this one,
        // so the same "THIS card, retained by ITS OWN owner" guard both
        // real decompiled examples (PatientStrike/TrainedAssault) use is
        // required here too. See CARD_TRIGGER_HOOKS.OnRetained's own comment.
        : hook.retainFilter
        ? `        if (!(player == this.Owner && retainedCards.Contains(this))) { await Task.CompletedTask; return; } // only react to THIS card being retained by ITS OWN owner — [VERIFIED via decompiling TheBurdenedNewCharacter.dll's PatientStrike.cs/TrainedAssault.cs, both real retain-scaling cards using this exact guard]\n`
        : '';

      // OnAnyCardPlayed (and any future trigger sharing CardPlay's shape)
      // gets a REAL body, not the Todo fallback below — its real params
      // are the exact same CardPlay OnPlay itself uses, so fgPlayer/
      // fgTarget bind for real here too. See CARD_TRIGGER_HOOKS' comment
      // for why this one's different from OnDiscard/OnTurnEndInHand.
      if (hook.fullCardPlayBinding) {
        // [Round 195] Merge any whileInHand entries on this same trigger
        // (only OnAnyCardPlayed reaches this branch today) into this SAME
        // method — see whileInHandMergeLines' own comment. Each entry
        // gets a real per-entry this.Pile?.Type == X gate since this
        // trigger fires for ANY card played, not just ones sitting in a
        // particular pile. ctx here matches cascadingTriggerBody's own
        // internal ctx for this trigger exactly (cardPlayBound/thisIsCard/
        // fgPlayerBound/targetMayBeNull), since these lines execute in the
        // same method body, after the same fgPlayer/fgTarget/fgPet
        // bindings below.
        const whileInHandLines = whileInHandMergeLines(
          whileInHandEffects.filter(e => e.trigger === trigger),
          trigger,
          { cardPlayBound: true, thisIsCard: true, fgPlayerBound: true, targetMayBeNull: true, cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById }
        );
        const triggerBody = [cascadingTriggerBody(card, trigger, resolvedTiers, refMaps), whileInHandLines, costLines.join('\n')].filter(Boolean).join('\n') || '        // no effects defined';
        return `
    // trigger: ${trigger} -> ${hook.method}(${hook.params}) [VERIFIED real signature via reflect-baselib round 2/9] — same CardPlay shape as OnPlay, so real player/target binding works here too (not a Todo fallback). Fires for ANY card played by anyone, including this card's own play if it has an OnPlay effect too. [Round 195] Also merges any Advanced Options "While in a pile" (whileInHand) entries on this same trigger, each gated by its own real this.Pile?.Type == X check — see whileInHandMergeLines' own comment.
    ${hook.access} override async Task ${hook.method}(${hook.params})
    {
${filterLine}        var fgPlayer = cardPlay.Player.Creature; // [VERIFIED via reflect-baselib round 5]
        var fgTarget = cardPlay.Target; // [VERIFIED via reflect-baselib round 3]
        var fgPet = cardPlay.Player.Osty; // [VERIFIED via reflect-baselib round 5 — Player.Osty]
${triggerBody}
        await Task.CompletedTask;
    }`;
      }

      // [Round 57] OnDiscard/OnTurnEndInHand — real fgPlayer/fgPet binding
      // via `this.Owner` (see CARD_TRIGGER_HOOKS' own comments and
      // PET_SUPPORTED_TRIGGERS' comment for the full evidence trail), but
      // NO cardPlay and NO real target — cascadingTriggerBody's ctxOverrides
      // flips cardPlayBound off so every cardPlay-referencing codegen path
      // correctly falls to its existing non-cardPlay fallback instead of
      // emitting an undefined `cardPlay` reference (CS0103); `thisIsCard`
      // stays true, so CardPositionInHand's/ShuffleCardIntoDraw's own
      // `this`-based codegen (both real here already, thanks to round 56
      // for CardPositionInHand and this always having been true for
      // ShuffleCardIntoDraw) keeps working. SingleEnemy actions and the
      // CardTarget subject are rejected up-front by backend/validate.js
      // (TARGETLESS_BOUND_HOOK_TRIGGERS) before this codegen is ever
      // reached, so no fgTarget reference can survive into this body.
      if (hook.playerExpr) {
        // [Round 195] Merge any whileInHand entries on this same trigger
        // into this SAME method — see whileInHandMergeLines' own comment
        // (this is the branch OnTurnEndInHand reaches, and the exact spot
        // the silent-drop bug lived: cascadingTriggerBody below never read
        // whileInHandEffects, so these entries' actions never compiled).
        // OnTurnEndInHand merges in ungated (pile is decorative there —
        // round 156); OnDiscard/OnRetained don't currently accept
        // whileInHand entries at all (not in WHILE_IN_HAND_TRIGGERS), so
        // this is a no-op for them today, but stays correct if that ever
        // changes. ctx matches cascadingTriggerBody's own ctxOverrides for
        // this branch (cardPlayBound:false, targetMayBeNull:false), since
        // these lines execute in the same method body, after fgPlayer/
        // fgPet are bound below.
        const whileInHandLines = whileInHandMergeLines(
          whileInHandEffects.filter(e => e.trigger === trigger),
          trigger,
          { cardPlayBound: false, thisIsCard: true, fgPlayerBound: true, targetMayBeNull: false, cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById }
        );
        const triggerBody = [cascadingTriggerBody(card, trigger, resolvedTiers, refMaps, { cardPlayBound: false, targetMayBeNull: false }), whileInHandLines, costLines.join('\n')].filter(Boolean).join('\n') || '        // no effects defined';
        const petLine = hook.petExpr ? `        var fgPet = ${hook.petExpr}; // [VERIFIED via decompiling TheBurdenedNewCharacter.dll's DiscardStatusPower v5 + direct sts2.dll read of CardModel.Owner/Player.Osty]\n` : '';
        return `
    // trigger: ${trigger} -> ${hook.method}(${hook.params}) [VERIFIED real signature via reflect-baselib round 9${trigger === 'OnRetained' ? "; round 95 for OnRetained specifically, via decompiling TheBurdenedNewCharacter.dll's PatientStrike.cs/TrainedAssault.cs" : ''}; real player binding added round 57 — see CARD_TRIGGER_HOOKS' own comment and PET_SUPPORTED_TRIGGERS' comment for the full CardModel.Owner evidence trail]. No real "target" Creature exists for ${trigger} (nothing is being targeted when a card is discarded, stays in hand at turn end, or is retained) — SingleEnemy actions and the CardTarget subject are rejected up front (see backend/validate.js). [Round 195] Also merges any Advanced Options "While in a pile" (whileInHand) entries on this same trigger — see whileInHandMergeLines' own comment for the bug this fixed.
    ${hook.access} override async Task ${hook.method}(${hook.params})
    {
${filterLine}        var fgPlayer = ${hook.playerExpr}; // [VERIFIED via decompiling sts2.dll's CardModel.Owner (public, Player-typed) + TheBurdenedNewCharacter.dll's DiscardStatusPower v5, a real compiled mechanic reading the same property]
${petLine}${triggerBody}
        await Task.CompletedTask;
    }`;
      }

      const totalActions = baseEffects.reduce((n, e) => n + (e.actions ? e.actions.length : 0), 0)
        + resolvedTiers.reduce((n, t) => n + (t.effects || []).filter(e => e.trigger === trigger).reduce((m, e) => m + (e.actions ? e.actions.length : 0), 0), 0);
      return `
    // trigger: ${trigger} -> ${hook.method}(${hook.params}) [VERIFIED real signature via reflect-baselib round 9]. Action binding here is a Todo fallback (see compiler.js:CARD_TRIGGER_HOOKS) — ${hook.method}'s real params don't expose a confirmed player/target Creature yet, so the ${totalActions} action(s) defined on this trigger (across the base card, any upgrade tier, and any Advanced Options "while in hand" block — see compiler.js:generateCardSource) aren't reachable from here yet.
    ${hook.access} override async Task ${hook.method}(${hook.params})
    {
${filterLine}        ForgeActions.Todo("${trigger} on \\"${card.name.replace(/"/g, '\\\\"')}\\""); // [UNVERIFIED] see comment above
${costLines.length ? costLines.join('\n') + '\n' : ''}        await Task.CompletedTask;
    }`;
    })
    .filter(Boolean)
    .join('\n');

  // [Round 90] "While in a pile" — one real override method per distinct
  // PILE_TRIGGER_HOOK_IDS trigger actually used by this card's
  // whileInHand entries, each grouping every entry that picked that
  // trigger (across however many different piles) into ONE method body —
  // matching the exact shape decompiled from Tyler's own reference cards
  // (see PILE_TRIGGER_OWNER_GUARD's own comment for the full evidence).
  // A separate, parallel path from extraTriggerMethods above rather than
  // folded into CARD_TRIGGER_HOOKS: these 15 ids are never valid on
  // card.effects/upgrade tiers (only on whileInHand — see
  // allowedCardTriggers above, unchanged), so they never need
  // CurrentUpgradeLevel cascading, and the real per-entry Pile.Type check
  // has no equivalent anywhere in the CARD_TRIGGER_HOOKS shape.
  const pileTriggerMethods = PILE_TRIGGER_HOOK_IDS
    .map(triggerId => {
      const entries = whileInHandEffects.filter(e => e.trigger === triggerId);
      if (!entries.length) return null;
      const hook = TRIGGER_HOOKS[triggerId];
      const guard = PILE_TRIGGER_OWNER_GUARD[triggerId];
      const ctx = { cardPlayBound: false, thisIsCard: true, fgPlayerBound: true, targetMayBeNull: false, cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById };
      const indent = s => s.split('\n').map(l => `    ${l}`).join('\n');
      const perEntryBlocks = entries.map(e => {
        const body = effectsToCSharp([e], ctx) || '        // no effects defined';
        return `        if (this.Pile?.Type == ${pileTypeExpr(e.pile)})\n        {\n${indent(body)}\n        }`;
      }).join('\n');
      const guardedBlocks = guard
        ? `        if (${guard})\n        {\n${indent(perEntryBlocks)}\n        }`
        : perEntryBlocks;
      return `
    // trigger: While in a pile (${triggerId}) -> ${hook.method}(${hook.params}) [VERIFIED via decompiling Tyler's own "Pile Trigger 1-9" reference cards built with a different STS2 character tool, round 90 — same real method/params TRIGGER_HOOKS already confirmed for the relic/mechanic version of this hook; CardModel shares the same overridable hook surface]. this.Pile?.Type/PileType [VERIFIED — Hand=2 already confirmed elsewhere in this file; Draw=1/Discard=3/Exhaust=4 read directly off the decompiled IL of Tyler's own reference cards this round; see claude/round90-pile-triggers.md].${guard ? ` Ownership-scoped (${guard}) — matches the exact CardModel.Owner comparison the reference cards themselves compile to, so this only reacts to THIS card's own owner's event, not anyone's.` : ' [BEST EFFORT] no single bindable Player/Creature exists in this hook\'s real params to scope an owner check against, so this fires for ANY matching event — same honest limitation this id\'s existing TRIGGER_HOOKS entry already carries.'}
    public override async Task ${hook.method}(${hook.params})
    {
        var fgPlayer = this.Owner.Creature; // [VERIFIED — same CardModel.Owner binding OnDiscard/OnTurnEndInHand already use, and the exact expression Tyler's own reference cards' GainBlock calls target]
        var fgPet = this.Owner.Osty; // [VERIFIED — same CardModel.Owner.Osty binding OnDiscard/OnTurnEndInHand already use]
${guardedBlocks}
        await Task.CompletedTask;
    }`;
    })
    .filter(Boolean)
    .join('\n');

  const upgradeMethod = (card.transformOnUpgrade && card.transformOnUpgrade.targetCardId)
    ? generateTransformUpgradeMethod(card, refMaps)
    : resolvedTiers.length
    ? `
    // MaxUpgradeLevel/CurrentUpgradeLevel/OnUpgrade() all CONFIRMED real via
    // reflect-baselib round 13: CardModel.CurrentUpgradeLevel (int, public
    // get/set, incremented by the engine itself), CardModel.MaxUpgradeLevel
    // ([CardModel, virtual, public] int getter — per-CARD, not a single
    // shared constant; round 13d found no MAX_UPGRADE_TIERS-style constant
    // anywhere), CardModel.OnUpgrade() ([CardModel, virtual, protected]
    // void, same access-modifier fix as OnPlay — CS0507 if this doesn't
    // match). The engine calls OnUpgrade() once per level-up, up to
    // MaxUpgradeLevel times; round 13c's real IL sample of 25 base-game
    // cards' OnUpgrade() bodies apply a single fixed delta each
    // (CardEnergyCost.UpgradeBy(int) / DynamicVar.UpgradeValueBy(decimal) /
    // AddKeyword / RemoveKeyword) with NO branching on the level — this
    // override still branches on CurrentUpgradeLevel below purely to pick
    // the right tier's costDelta, which is a Forge-authoring convenience
    // (each tier's costDelta is already "the change at this tier vs. the
    // tier before it"), not evidence real cards do the same internally.
    public override int MaxUpgradeLevel => ${resolvedTiers.length};

    protected override void OnUpgrade()
    {
        switch (CurrentUpgradeLevel)
        {
${resolvedTiers.map((t, i) => `            case ${i + 1}: ${t.costDelta ? `EnergyCost.UpgradeBy(${t.costDelta}); ` : ''}${t.starCostDelta ? `UpgradeStarCostBy(${t.starCostDelta}); ` : ''}break; // Card${'+'.repeat(i + 1)}${(t.costDelta || t.starCostDelta) ? '' : ' — no cost change at this tier'}${t.starCostDelta ? ` [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3's "Star Cost Change" card, round 59 — CardModel.UpgradeStarCostBy(int) is real; sts2.dll confirms it protected (flags=0x84), so calling it bare (implicit this) from this override is legal]` : ''}`).join('\n')}
        }
        // Effect changes at each tier are handled directly in OnPlay (and
        // any other trigger method this card uses) by branching on
        // CurrentUpgradeLevel there, rather than mutating DynamicVars here
        // — see cascadingTriggerBody's comment in compiler.js for why.
    }`
    : '';

  return fillTemplate(tpl, {
    namespace,
    poolClassName,
    className: pascalCase(card.name) + 'Card',
    cardId: card.id,
    cardName: card.name.replace(/"/g, '\\"'),
    cost: card.cost,
    cardType: card.type,
    rarity: card.rarity,
    target: cardTargetToRealTargetType(card.target),
    canonicalKeywordsOverride: generateCanonicalKeywordsOverride(card),
    starCostAssign: generateStarCostAssign(card),
    canonicalStarCostOverride: generateCanonicalStarCostOverride(card),
    hasEnergyCostXOverride: generateHasEnergyCostXOverride(card),
    hasStarCostXOverride: generateHasStarCostXOverride(card),
    forgeTagsInit: generateGameplayTagsInit(card),
    canonicalTagsOverride: generateCanonicalTagsOverride(card),
    cardArtOverride: cardArtOverride || '',
    canonicalVarsOverride: generateCanonicalVars(card),
    localizationOverride: generateCardLocalization(card),
    hoverTipsOverride: generateHoverTipsOverride(card, refMaps),
    advancedOptionsNotes: generateAdvancedOptionsNotes(card),
    onPlayBody: body,
    extraTriggerMethods: [extraTriggerMethods, pileTriggerMethods].filter(Boolean).join('\n'),
    upgradeMethod,
    // [Round 121] IHeavyAttackCard — see IHeavyAttackCard.cs.template's
    // header. Only added for an Attack-type card with the checkbox on
    // (backend/validate.js already rejects the checkbox on a non-Attack
    // card, so no extra guard needed here beyond mirroring that same rule).
    extraInterfaces: (card.advancedOptions && card.advancedOptions.heavyAttackAnimation && card.type === 'Attack') ? ', IHeavyAttackCard' : '',
  });
}

// [Round 217] "Automatically claim shop items for free" (#14
// claimShopInventory) -- Tyler's direct call after reviewing the round
// 207-216 punchlist: build it now, test the live sequencing together.
// [Round 221] Rewritten against a real, shipped relic instead of a
// reconstructed trace -- Tyler pointed out that
// MegaCrit.Sts2.Core.Models.Relics.LordsParasol does exactly this (buys
// everything in the shop on room entry). Decompiled its real
// AfterRoomEntered override AND its private
// PurchaseEverything(MerchantInventory) async state machine
// (<PurchaseEverything>d__3::MoveNext) straight from the installed
// sts2.dll's IL (tools/sts2tools/il_dump.py), so every step below is the
// real relic's own real logic, not a guess:
//   - Bails out if inventory.Player != this.Owner (only claims YOUR own
//     shop).
//   - The initial Map/Deck/travel disable + one-process-frame wait only
//     runs when MegaCrit.Sts2.Core.TestSupport.TestMode.IsOff is true --
//     skipped in test mode. Forge relics only ever run in real gameplay
//     so this branch is always taken there, but the real relic's own
//     conditional (and its NRun.Instance null-guard around the frame
//     wait) is kept for fidelity.
//   - MegaCrit.Sts2.Core.Nodes.GodotExtensions.NodeUtil.AwaitProcessFrame
//     takes the Node to wait on plus a CancellationToken -- real relic
//     passes NRun.Instance and default(CancellationToken).
//   - fgNInventory.BlockInput() -> wait 0.75s -> fgNInventory.Open() ->
//     wait 1.0s -- unchanged from the previous version, already correct.
//   - NOT a single loop over MerchantInventory.AllEntries (the previous
//     version's approach). The real relic loops FOUR separate typed
//     collections, each with different real rules, in this exact order:
//       1. CharacterCardEntries -- buy only if IsStocked; if not, the
//          real relic logs a SentryService.CaptureMessage warning and
//          skips it instead of buying (kept as a Console.WriteLine here
//          since Forge relics don't have Sentry wired up).
//       2. ColorlessCardEntries -- same IsStocked-gated pattern.
//       3. RelicEntries -- no IsStocked check (always buys). Uniquely,
//          the real relic Enables Map+Deck right before buying EACH
//          relic and Disables them again right after -- cards/potions
//          never touch the buttons per-iteration. Kept exactly as-is
//          even though the reason isn't obvious (maybe a relic-pickup
//          animation needs the buttons in their default state) -- this
//          is real, shipped behavior, not something to "fix".
//       4. PotionEntries -- no IsStocked check, buys unconditionally.
//     Each purchase in all four loops is followed by a real 0.25s wait
//     (Cmd.Wait) -- the previous version bought everything back-to-back
//     with no pacing at all.
//   - CardRemovalEntry is NOT part of any of the four loops above -- it's
//     a single property, not a collection, and the real relic buys it in
//     its own separate step AFTER the main try/finally has already
//     restored the UI: if inventory.CardRemovalEntry != null AND
//     RunManager.Instance.IsInProgress (real relic reads this with no
//     null-guard, so neither does this), it disables travel, calls
//     CardRemovalEntry.OnTryPurchaseWrapper(inventory, ignoreCost: true,
//     cancelable: false) -- a 3-arg overload specific to
//     MerchantCardRemovalEntry, not the 2-arg MerchantEntry base one
//     used everywhere else -- then re-enables travel. The previous
//     version never bought this at all.
// LordsParasol itself carries no reentry-guard fields of its own (the
// game's own room-entry lifecycle apparently makes that unnecessary for
// a real relic). _fgClaimingShop/_fgClaimedShops below are kept anyway
// as a Forge-added safety net -- a separately-compiled relic doesn't get
// to rely on assumptions about how AfterRoomEntered is invoked.
// Still only compile-tested, never played -- test this specific relic
// in-game before trusting it in a real run.
function generateClaimShopInventoryOverride(relic) {
  if (!relic.autoClaimShopInventory) return null;
  return `    // modifier: autoClaimShopInventory -> AfterRoomEntered(AbstractRoom) [Round 221 -- matches the real MegaCrit.Sts2.Core.Models.Relics.LordsParasol relic's own decompiled logic; see generateClaimShopInventoryOverride's own header comment] #14 claimShopInventory
    private readonly System.Collections.Generic.HashSet<MegaCrit.Sts2.Core.Entities.Merchant.MerchantInventory> _fgClaimedShops = new System.Collections.Generic.HashSet<MegaCrit.Sts2.Core.Entities.Merchant.MerchantInventory>();
    private bool _fgClaimingShop = false;

    private async System.Threading.Tasks.Task FgPurchaseEverything(MegaCrit.Sts2.Core.Entities.Merchant.MerchantInventory fgInventory)
    {
        var fgTopBar = MegaCrit.Sts2.Core.Nodes.NRun.Instance?.GlobalUi?.TopBar;
        var fgNInventory = MegaCrit.Sts2.Core.Nodes.Rooms.NMerchantRoom.Instance?.Inventory;
        bool fgUiBlocked = false;
        try
        {
            if (MegaCrit.Sts2.Core.TestSupport.TestMode.IsOff)
            {
                fgTopBar?.Map?.Disable();
                fgTopBar?.Deck?.Disable();
                MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen.Instance?.SetTravelEnabled(false);
                if (MegaCrit.Sts2.Core.Nodes.NRun.Instance != null)
                {
                    await MegaCrit.Sts2.Core.Nodes.GodotExtensions.NodeUtil.AwaitProcessFrame(MegaCrit.Sts2.Core.Nodes.NRun.Instance, default);
                }
            }
            fgUiBlocked = true;
            fgNInventory?.BlockInput();
            await MegaCrit.Sts2.Core.Commands.Cmd.Wait(0.75f, false);
            fgNInventory?.Open();
            await MegaCrit.Sts2.Core.Commands.Cmd.Wait(1.0f, false);

            foreach (var fgEntry in fgInventory.CharacterCardEntries.ToList())
            {
                if (!fgEntry.IsStocked) { System.Console.WriteLine("[Forge] autoClaimShopInventory: skipped out-of-stock character card"); continue; }
                await fgEntry.OnTryPurchaseWrapper(fgInventory, true);
                await MegaCrit.Sts2.Core.Commands.Cmd.Wait(0.25f, false);
            }
            foreach (var fgEntry in fgInventory.ColorlessCardEntries.ToList())
            {
                if (!fgEntry.IsStocked) { System.Console.WriteLine("[Forge] autoClaimShopInventory: skipped out-of-stock colorless card"); continue; }
                await fgEntry.OnTryPurchaseWrapper(fgInventory, true);
                await MegaCrit.Sts2.Core.Commands.Cmd.Wait(0.25f, false);
            }
            foreach (var fgEntry in fgInventory.RelicEntries.ToList())
            {
                fgTopBar?.Map?.Enable();
                fgTopBar?.Deck?.Enable();
                await fgEntry.OnTryPurchaseWrapper(fgInventory, true);
                fgTopBar?.Deck?.Disable();
                fgTopBar?.Map?.Disable();
                await MegaCrit.Sts2.Core.Commands.Cmd.Wait(0.25f, false);
            }
            foreach (var fgEntry in fgInventory.PotionEntries.ToList())
            {
                await fgEntry.OnTryPurchaseWrapper(fgInventory, true);
                await MegaCrit.Sts2.Core.Commands.Cmd.Wait(0.25f, false);
            }
        }
        finally
        {
            if (fgUiBlocked)
            {
                fgNInventory?.UnblockInput();
                fgTopBar?.Map?.Enable();
                fgTopBar?.Deck?.Enable();
                MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen.Instance?.SetTravelEnabled(true);
            }
        }

        if (fgInventory.CardRemovalEntry != null && MegaCrit.Sts2.Core.Runs.RunManager.Instance.IsInProgress)
        {
            MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen.Instance?.SetTravelEnabled(false);
            await fgInventory.CardRemovalEntry.OnTryPurchaseWrapper(fgInventory, true, false);
            MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen.Instance?.SetTravelEnabled(true);
        }
    }

    public override async System.Threading.Tasks.Task AfterRoomEntered(MegaCrit.Sts2.Core.Rooms.AbstractRoom room)
    {
        if (!(room is MegaCrit.Sts2.Core.Rooms.MerchantRoom fgMerchantRoom)) { await System.Threading.Tasks.Task.CompletedTask; return; }
        var fgInventory = fgMerchantRoom.GetLocalInventory();
        if (fgInventory == null || fgInventory.Player != this.Owner || _fgClaimingShop || _fgClaimedShops.Contains(fgInventory)) { await System.Threading.Tasks.Task.CompletedTask; return; }
        _fgClaimingShop = true;
        _fgClaimedShops.Add(fgInventory);
        try
        {
            await FgPurchaseEverything(fgInventory);
        }
        finally
        {
            _fgClaimingShop = false;
        }
    }`;
}


// [Round 218] #37/38 -- Weak/Vulnerable's own math, not "bonus damage vs
// weak/vulnerable targets". Tyler uploaded a fresh build of the
// slay.spencerstiles.com evidence rig (project file's Passive 7 relic
// carried a third "kind", amplifyWeakAndVulnerable/#39, alongside these
// two) and this round found the REAL mechanism: a generated support
// class (TheBurdenedNewCharacter.DebuffMultiplierSupport) plus two
// Harmony PREFIX patches (CreatorWeakInteractionPatch/
// CreatorVulnerableInteractionPatch) that intercept WeakPower/
// VulnerablePower's own real `ModifyDamageMultiplicative` override
// directly -- both real, both independently re-confirmed via a direct
// ECMA-335 read of the real, installed sts2.dll this round:
//   MegaCrit.Sts2.Core.Models.Powers.WeakPower.ModifyDamageMultiplicative
//   MegaCrit.Sts2.Core.Models.Powers.VulnerablePower.ModifyDamageMultiplicative
// both real params (Creature target, decimal amount, ValueProp props,
// Creature dealer, CardModel cardSource, CardPlay cardPlay) -- same
// signature already independently confirmed and shipped via this app's
// own MODIFIER_HOOKS.ModifyDamageMultiplicative entry.
//
// The original mod's own Prefix REPLACES the base calculation entirely
// (reading a base multiplier off DynamicVars, then layering on other
// real relics/powers it happens to know about -- PaperKrane,
// DebilitatePower, PaperPhrog, CrueltyPower -- via more Harmony calls).
// That's real, but risky to copy verbatim: skipping the original method
// means Forge would have to reproduce ALL of it (including interactions
// with other mods patching the same method) or silently drop them. This
// generator instead uses a Harmony POSTFIX -- adjusts `__result` AFTER
// the real base game (and any other mod) has already computed it, never
// replaces anything -- which is both simpler and safer, and produces the
// same net numbers for the two pieces Tyler's passives actually need:
//
//   - incomingWeakBonus (#37): when THIS relic's owner is the one being
//     attacked by a Weakened dealer, subtract an extra flat amount from
//     the multiplier (real evidence: DebuffMultiplierSupport.
//     IncomingWeakBonus(target), subtracted in .Weak()'s own real body).
//   - vulnerableDamageBonus (#38): when THIS relic's owner is the one
//     DEALING damage to a Vulnerable target (and isn't hitting itself),
//     add an extra flat amount to the multiplier (real evidence:
//     DebuffMultiplierSupport.CrueltyBonus(target, dealer), added in
//     .Vulnerable()'s own real body -- same real "attacker gets a
//     bonus against a Vulnerable target" shape, generalized off the
//     specific CrueltyPower-only implementation the original used).
//
// [Round 221] amplifyWeakAndVulnerable (#39) removed entirely, per
// Tyler's direct call -- it was real (both .Weak() and .Vulnerable() in
// the evidence rig ended with the identical
// `1 + (multiplier - 1) * Amplification(holder)` formula), but he wants
// the UI limited to just these two direct percentages. Also: real
// WeakPower/VulnerablePower base multipliers were independently
// re-confirmed THIS round via a direct read of each class's own
// get_CanonicalVars IL -- WeakPower's "DamageDecrease" DynamicVar is
// literally constructed as `new System.Decimal(75, 0, 0, false, 2)` (=
// 0.75, i.e. -25% damage) and VulnerablePower's "DamageIncrease" as
// `new System.Decimal(15, 0, 0, false, 1)` (= 1.5, i.e. +50% damage) --
// these are the "Base 25%"/"Base 50%" numbers shown next to the two
// fields below in the editor now.
//
// Only written when at least one relic in the project actually sets one
// of these two fields -- an unmodified project gets no new Harmony patch
// at all. `Player.GetRelic<T>()` is real, public, generic [VERIFIED via
// direct sts2.dll read] and returns null when the player doesn't have
// that relic (confirmed via its own real IL -- an `isinst`+`unbox.any`
// pattern, never throws). Values are stored as their original
// whole-number percent (matching the editor's UI) and divided by 100m
// directly in the generated expression to avoid any JS-side
// floating-point rounding.
function generateDebuffMultiplierSupportFile(characterPackage, namespace, relicClassById) {
  const relics = characterPackage.relics || [];
  const weakBonusRelics = relics.filter(r => typeof r.incomingWeakBonus === 'number' && r.incomingWeakBonus !== 0);
  const vulnBonusRelics = relics.filter(r => typeof r.vulnerableDamageBonus === 'number' && r.vulnerableDamageBonus !== 0);
  if (!weakBonusRelics.length && !vulnBonusRelics.length) return null;

  const relicExpr = (r) => `global::${namespace}.Relics.${relicClassById.get(r.id)}`;
  const weakBonusLines = weakBonusRelics.map(r => `        if (player.GetRelic<${relicExpr(r)}>() != null) bonus += ${r.incomingWeakBonus}m / 100m;`).join('\n');
  const vulnBonusLines = vulnBonusRelics.map(r => `        if (player.GetRelic<${relicExpr(r)}>() != null) bonus += ${r.vulnerableDamageBonus}m / 100m;`).join('\n');

  return `using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.ValueProps;

namespace ${namespace}.Generated;

// AUTO-GENERATED by Forge — do not hand-edit, changes will be overwritten on next export.
//
// [Round 218, #37/38] See generateDebuffMultiplierSupportFile's own
// header comment in compiler.js for the full evidence trail. Adjusts the
// real WeakPower/VulnerablePower.ModifyDamageMultiplicative result via a
// Harmony POSTFIX (ModEntry.cs already bootstraps \`new Harmony(...).
// PatchAll()\`, which picks up any [HarmonyPatch] class in this assembly
// automatically — no extra wiring needed) — never replaces the base
// game's own calculation, just adjusts it afterward, so it composes
// safely with the base game and any other mod patching the same method.
public static class ForgeDebuffMultiplierSupport
{
    internal static decimal IncomingWeakBonus(Creature target)
    {
        decimal bonus = 0m;
        var player = target?.Player;
        if (player == null) return bonus;
${weakBonusLines || '        // no relic sets incomingWeakBonus'}
        return bonus;
    }

    internal static decimal VulnerableDamageBonus(Creature dealer)
    {
        decimal bonus = 0m;
        var player = dealer?.Player;
        if (player == null) return bonus;
${vulnBonusLines || '        // no relic sets vulnerableDamageBonus'}
        return bonus;
    }
}

[HarmonyPatch(typeof(WeakPower), nameof(WeakPower.ModifyDamageMultiplicative))]
public static class ForgeWeakMultiplierBonus
{
    // [VERIFIED via direct sts2.dll read] WeakPower.ModifyDamageMultiplicative's
    // own real body already gates its OWN reduction on dealer == this.Owner
    // (PowerModel.Owner is Creature-typed) — this patch only adjusts the
    // result further in that same case, so it never fires when Weak wasn't
    // actually relevant to this particular damage instance.
    static void Postfix(WeakPower __instance, Creature target, ValueProp props, Creature dealer, ref decimal __result)
    {
        if (dealer == null || dealer != __instance.Owner || !ValuePropExtensions.IsPoweredAttack(props)) return;
        __result -= ForgeDebuffMultiplierSupport.IncomingWeakBonus(target);
    }
}

[HarmonyPatch(typeof(VulnerablePower), nameof(VulnerablePower.ModifyDamageMultiplicative))]
public static class ForgeVulnerableMultiplierBonus
{
    // [VERIFIED via direct sts2.dll read] VulnerablePower.ModifyDamageMultiplicative's
    // own real body already gates its OWN increase on target == this.Owner
    // (PowerModel.Owner is Creature-typed) — same reasoning as the Weak
    // patch above.
    static void Postfix(VulnerablePower __instance, Creature target, ValueProp props, Creature dealer, ref decimal __result)
    {
        if (target == null || target != __instance.Owner || !ValuePropExtensions.IsPoweredAttack(props)) return;
        if (dealer != null && dealer != target)
        {
            __result += ForgeDebuffMultiplierSupport.VulnerableDamageBonus(dealer);
        }
    }
}
`;
}

// [Round 232] "Stay visible at 0 stacks" -- see the `stayVisibleAtZero`
// schema field's own description for the evidence summary. Full trail:
// round 231 confirmed via direct sts2.dll IL read that
// PowerModel.ShouldRemoveDueToAmount() is NOT virtual (no "virtual"
// keyword), so it can't be overridden on a generated Power subclass the
// way AllowNegative/ShouldPlayVfx are -- that round hit a genuine dead
// end there. Tyler then supplied his own real, compiled "The Burdened"
// reference mod (round 232) with two powers -- FatiguePower,
// TitanMightPower -- he confirmed "are both set to stay visible at 0" in
// it; decompiling it found source/Patches/ModStatusRowPatch.cs, a Harmony
// POSTFIX patch on exactly this method:
//
//   [HarmonyPatch(typeof(PowerModel), nameof(PowerModel.ShouldRemoveDueToAmount))]
//   internal static class ModKeepStatusAtZeroPatch {
//       [HarmonyPostfix]
//       private static void Postfix(PowerModel __instance, ref bool __result) {
//           if (!__result) return;
//           if (__instance.Amount != 0) return;
//           if (false || __instance is FatiguePower || __instance is TitanMightPower
//               || __instance is MoveTo0Power || __instance is DecayPower)
//               __result = false;
//       }
//   }
//
// -- one patch class per character, listing every flagged mechanic in an
// `is` chain, exactly mirroring the generateDebuffMultiplierSupportFile
// pattern just above (one file, only written when >=1 entity sets the
// flag, all qualifying entities folded into a single generated class).
// Only exactly-0 is intercepted, matching Tyler's own reference patch's
// comment ("A status driven NEGATIVE is a different situation and the
// game's own answer -- remove it -- is still the right one").
function generateStayVisibleAtZeroSupportFile(characterPackage, namespace, mechanicClassById) {
  const mechanics = (characterPackage.mechanics || []).filter(m => m.stayVisibleAtZero === true);
  if (!mechanics.length) return null;

  const typeChecks = mechanics
    .map(m => `            || __instance is global::${namespace}.Powers.${mechanicClassById.get(m.id)}`)
    .join('\n');

  return `using HarmonyLib;
using MegaCrit.Sts2.Core.Models;

namespace ${namespace}.Generated;

// AUTO-GENERATED by Forge -- do not hand-edit, changes will be overwritten on next export.
//
// [Round 232] See generateStayVisibleAtZeroSupportFile's own header
// comment in compiler.js for the full evidence trail -- decompiled from
// Tyler's own real, compiled "The Burdened" reference mod's
// Patches/ModStatusRowPatch.cs, which patches this exact method the exact
// same way for its own FatiguePower/TitanMightPower/etc. PowerCmd calls
// PowerModel.ShouldRemoveDueToAmount straight-line -- an if on this method
// guarding an await Remove(power), no loop around it -- so answering
// false only skips the removal. Amount does not gate PowerModel.IsVisible,
// so the status keeps drawing, showing 0. ModEntry.cs already bootstraps
// \`new Harmony(...).PatchAll()\`, which picks up this [HarmonyPatch] class
// automatically -- no extra wiring needed.
[HarmonyPatch(typeof(PowerModel), nameof(PowerModel.ShouldRemoveDueToAmount))]
internal static class ForgeKeepStatusAtZeroPatch
{
    [HarmonyPostfix]
    private static void Postfix(PowerModel __instance, ref bool __result)
    {
        if (!__result) return;
        // Only at exactly 0. A status driven NEGATIVE is a different
        // situation and the game's own answer -- remove it -- is still
        // the right one [same carve-out as Tyler's own reference patch].
        if (__instance.Amount != 0) return;
        if (false
${typeChecks}
        ) __result = false;
    }
}
`;
}

// [2026-09-23] Builds the single 'ModifyExtraRestSiteHealText' loc row
// -- see MODIFIER_HOOKS' ModifyExtraRestSiteHealText entry and
// generateModifierOverrides' 'extraHealText' branch for the full real-
// evidence trail (BaseLib.Abstracts.ILocalizationProvider, confirmed via
// direct InterfaceImpl reads of both sts2.dll and BaseLib.dll). Only
// returns a row when a real 'ModifyExtraRestSiteHealText' modifier with
// actual text is present (validate.js requires non-empty text whenever
// this modifier exists, so `mod.extraHealText` is trustworthy here --
// the `!mod.extraHealText` branch below is just defense-in-depth for a
// package saved before that validation existed). "EXTRAHEALTEXT" is an
// arbitrary Forge-chosen key -- the ONLY other place it needs to match is
// generateModifierOverrides' own 'extraHealText' branch, which it does.
// [Round 270] Used to BE the entire `Localization` override by itself
// (a class-level property, so it can only appear once per generated
// class); now just returns this one tuple's source text, folded into
// generateRelicLocalization/generateMechanicLocalization's own combined
// Localization property below, since relics/mechanics now also carry a
// real title/description(/flavor) row there.
function generateExtraHealTextLocalization(entity) {
  const mod = (entity.modifiers || []).find(m => m.hook === 'ModifyExtraRestSiteHealText');
  if (!mod || !mod.extraHealText) return null;
  const text = String(mod.extraHealText).replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `("EXTRAHEALTEXT", "${text}")`;
}

// Escapes a string for use inside a C# regular (non-verbatim) string
// literal INCLUDING real newlines -- csharpStringLiteral above handles
// quotes/backslashes but leaves a literal newline character in place,
// which is a genuine C# compile error (CS1010) inside a plain "..."
// literal. Used for relic/mechanic description/flavor text below, which
// (unlike gameplay tags/card names) really can contain user-typed line
// breaks.
function csharpLocLiteral(str) {
  return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n/g, '\n').replace(/\n/g, '\\n')}"`;
}

// [Round 270] Real Localization override for RELICS -- Tyler: "add the
// auto-generate description feature from the card section here as well.
// and also for relics if that isn't in place already," then, once told
// relics had no real in-game description output at all yet: "look
// through my character dll as well as game files. I want this
// verified." Verified via direct ECMA-335 IL reads of BOTH the real
// installed sts2.dll (tools/reflect-baselib/bin/Debug/net9.0/sts2.dll)
// AND the real installed BaseLib.dll -- not inferred from naming:
//   - CustomRelicModel implements BaseLib.Abstracts.ILocalizationProvider
//     (confirmed off BaseLib.dll's InterfaceImpl table -- the SAME
//     interface CardLoc/generateCardLocalization already use for cards;
//     see this file's own comment on MODIFIER_HOOKS.
//     ModifyExtraRestSiteHealText for the original find).
//   - RelicModel.get_Title()/get_Description()/get_Flavor() (all three,
//     direct sts2.dll IL read) each build a LocString the exact same
//     way: LocTable "relics", key "{this.Id.Entry}.title" / ".description"
//     / ".flavor" -- read live off LocManager.Instance at ACCESS time,
//     not baked into the class at all.
//   - BaseLib.Abstracts.RelicLoc (direct BaseLib.dll IL read of its own
//     op_Implicit -> List<(string,string)> conversion) is a real,
//     purpose-built helper confirmed to emit exactly [("title", Title),
//     ("description", Description), ("flavor", Flavor)] tuples -- same
//     shape as CardLoc, just with an extra Flavor slot.
//   - BaseLib.Patches.Localization.ModelLocPatch.AddModelLoc (direct
//     BaseLib.dll IL read) is the real Harmony patch that walks every
//     loaded ILocalizationProvider model at content-load time, reads its
//     .Localization list, and writes each tuple into LocManager's live
//     "relics" table under key "{this.Id.Entry}.{tupleKey}" -- exactly
//     the keys RelicModel's own getters above read back out at runtime.
// Net finding: this was a real, working, VERIFIED mechanism Forge had
// simply never wired up for relics before this round -- Relic.cs.template
// deliberately has no Name/Title override at all (see its own header
// comment, "based on the same CS0506 evidence that killed them on Card
// and Character"), and nothing else in this file ever wrote a "relics"
// loc entry, so a relic's Name/Description/Flavor text has never
// actually reached a compiled mod until now. Built as ONE raw
// List<(string,string)> rather than `new RelicLoc(...)` directly --
// RelicLoc's own op_Implicit unconditionally emits all 3 of its fields as
// separate tuples regardless of whether they're set, and while an empty
// "flavor" row is harmless (RelicModel.get_Flavor has no "HasFlavor"-
// style gate the way PowerModel.SmartDescription does -- see
// generateMechanicLocalization's own comment for why THAT one needs the
// opposite care), building the row list directly keeps this function's
// real, verified output explicit rather than delegating to an unread
// record type. `Localization` is a class-level property (only one per
// generated class), so this also absorbs the extraHealText row
// generateExtraHealTextLocalization used to emit as its own override.
function generateRelicLocalization(relic) {
  const rows = [`("title", ${csharpLocLiteral(relic.name || 'Untitled')})`];
  const description = (relic.description || relic.autoGeneratedDescription || '').trim();
  if (description) rows.push(`("description", ${csharpLocLiteral(description)})`);
  const flavor = (relic.flavorText || '').trim();
  if (flavor) rows.push(`("flavor", ${csharpLocLiteral(flavor)})`);
  const extraHealTextRow = generateExtraHealTextLocalization(relic);
  if (extraHealTextRow) rows.push(extraHealTextRow);
  return `    // [Round 270] Real BaseLib.Abstracts.ILocalizationProvider override -- see this file's own generateRelicLocalization comment for the full sts2.dll/BaseLib.dll IL evidence trail.
    public override List<(string, string)>? Localization => new List<(string, string)> { ${rows.join(', ')} };`;
}

// [Round 270] Real Localization override for MECHANICS (statuses) -- same
// ask/verification as generateRelicLocalization above, same evidence tier.
// CustomPowerModel implements BaseLib.Abstracts.ILocalizationProvider
// (same InterfaceImpl confirmation as CustomRelicModel). PowerModel.
// get_Title()/get_Description() (direct sts2.dll IL read) build a
// LocString the exact same way: LocTable "powers", key
// "{this.Id.Entry}.title" / ".description". BaseLib.Abstracts.PowerLoc
// (direct BaseLib.dll IL read of its own op_Implicit) emits
// [("title", Title), ("description", Description),
// ("smartDescription", SmartDescription)] tuples -- but unlike Flavor
// above, SmartDescription is NOT safe to leave empty: PowerModel.
// get_HasSmartDescription() (direct sts2.dll IL read) is a pure
// LocTable.HasEntry(key) check -- it does NOT check whether the value is
// non-empty -- so registering an empty "smartDescription" tuple would
// make HasSmartDescription true and get_SmartDescription() (confirmed:
// falls back to plain Description only when HasSmartDescription is
// false) return a blank LocString instead of falling back, i.e. it would
// make the tooltip WORSE than not touching this at all. Forge has no
// authored source for SmartDescription content (no confirmed dynamic-var
// template syntax for it either), so this deliberately builds the row
// list directly (same reasoning as generateRelicLocalization) and never
// emits a "smartDescription" row -- HasSmartDescription then correctly
// stays false and PowerModel.SmartDescription cleanly falls back to
// Description on its own, real, verified default behavior. Same
// Localization-is-class-level-only reasoning as relics: also absorbs the
// extraHealText row (a legacy mechanic saved before round 268 restricted
// that modifier category to relics-only could still carry one).
function generateMechanicLocalization(mechanic) {
  const rows = [`("title", ${csharpLocLiteral(mechanic.name || 'Untitled')})`];
  const description = (mechanic.description || mechanic.autoGeneratedDescription || '').trim();
  if (description) rows.push(`("description", ${csharpLocLiteral(description)})`);
  const extraHealTextRow = generateExtraHealTextLocalization(mechanic);
  if (extraHealTextRow) rows.push(extraHealTextRow);
  return `    // [Round 270] Real BaseLib.Abstracts.ILocalizationProvider override -- see this file's own generateMechanicLocalization comment for the full sts2.dll/BaseLib.dll IL evidence trail.
    public override List<(string, string)>? Localization => new List<(string, string)> { ${rows.join(', ')} };`;
}

function generateRelicSource(relic, namespace, poolClassName, refMaps, iconOverride) {
  const tpl = loadTemplate('Relic.cs.template');
  return fillTemplate(tpl, {
    namespace,
    poolClassName,
    className: pascalCase(relic.name) + 'Relic',
    relicId: relic.id,
    relicName: relic.name.replace(/"/g, '\\"'),
    rarity: relic.rarity,
    iconOverride: iconOverride || '',
    hookMethods: [generateHookEffects(relic, 'relic', refMaps), generateModifierOverrides(relic, 'relic', refMaps), generateRelicLocalization(relic), generateClaimShopInventoryOverride(relic)].filter(Boolean).join('\n\n'),
  });
}

// [VERIFIED via reflect-baselib rounds 11/12] see Orb.cs.template's header
// for the full evidence trail — TheBurdenedNewCharacter.Orbs.MoonOrb is a
// real, working CustomOrbModel subclass overriding exactly PassiveVal/
// EvokeVal/DarkenedColor, nothing else. `passiveValue`/`evokeValue` fall
// back to the older, single-shared `baseValue` field for characters saved
// before this round (same "absent field defaults sensibly" convention
// used throughout this app — see character.gender for the most recent
// example).
function generateOrbSource(orb, namespace, colorHex) {
  const tpl = loadTemplate('Orb.cs.template');
  const passiveValue = orb.passiveValue !== undefined ? orb.passiveValue : (orb.baseValue || 0);
  const evokeValue = orb.evokeValue !== undefined ? orb.evokeValue : (orb.baseValue || 0);
  return fillTemplate(tpl, {
    namespace,
    className: pascalCase(orb.name) + 'Orb',
    passiveValue,
    evokeValue,
    colorHex,
  });
}

// [Round 229] Icon -- Tyler: "we need to allow for a 256x256 icon."
// UNLIKE relics (RelicModel.PackedIconPath is virtual + reached via
// callvirt, see writeRelicIcon's header) mechanics needed fresh IL
// evidence: MegaCrit.Sts2.Core.Models.PowerModel.PackedIconPath is NOT
// virtual (its get_Icon/get_IconPath/get_PackedIconPath chain uses plain
// `call`, confirmed via il_dump.py against the real installed sts2.dll --
// overriding it on a subclass would silently never be reached). The real
// consumption path is a Harmony Prefix patch instead, structurally
// identical to the already-proven CustomEnchantmentModel.CustomIconPath
// mechanism (round 198): BaseLib.Abstracts.PackedIconPath::Custom (real
// installed BaseLib.dll, RVA 0x3c878) does `isinst
// BaseLib.Abstracts.ICustomPower` on the power instance and, if it
// matches, `callvirt`s ICustomPower::get_CustomPackedIconPath() and
// writes that as the result PowerModel::get_PackedIconPath() returns --
// same "Prefix short-circuits the vanilla getter" shape as the
// enchantment patch. Confirmed CustomPowerModel (the base class every
// generated mechanic already extends, see Power.cs.template) really does
// implement ICustomPower -- read directly off BaseLib.dll's InterfaceImpl
// metadata table (TypeDef row for CustomPowerModel lists
// BaseLib.Abstracts.ICustomPower among its 4 real interfaces, alongside
// ICustomModel/ILocalizationProvider/IHealthBarForecastSource) -- so
// overriding CustomPackedIconPath on the generated `{{className}}` class
// is a real, working override point, not a guess. See writeMechanicIcon
// just below for the export side.
function generateMechanicSource(mechanic, namespace, refMaps, iconOverride) {
  const tpl = loadTemplate('Power.cs.template');
  // [VERIFIED enum members via reflect-baselib round 2] PowerType's real
  // members are None/Buff/Debuff and PowerStackType's are None/Counter/
  // Single (see TOOLCHAIN_FINDINGS.md "reflect-baselib round 2") — both
  // confirmed to exist by name now. Only the semantic MAPPING from the
  // schema's isBuff/stackable booleans onto these specific real members is
  // still a guess (Buff/Debuff for isBuff is a direct, high-confidence
  // mapping; Counter/Single for stackable is a plausible reading of the
  // names — "Counter" for stacks that increment, "Single" for a plain
  // present/absent power — but not confirmed against real behavior).
  const powerTypeGuess = mechanic.isBuff ? 'Buff' : 'Debuff';
  const powerStackTypeGuess = mechanic.stackable ? 'Counter' : 'Single';
  // Round 94 — [VERIFIED via direct read of Tyler's own generated
  // FatiguePower.cs off a real character built by a different character
  // creator tool (slay.spencerstiles.com), decompiled while fixing the
  // "hidden status breaks the custom bar's tooltip" bug: that tool's own
  // "Hide from the status bar" checkbox compiles to exactly this real
  // override — `protected override bool IsVisibleInternal => false;` on
  // CustomPowerModel. No icon, no apply flash, and Artifact ignores the
  // power (can't eat a charge from a hidden counter) — the game reads
  // this one flag for all three. See claude/round94-hidden-status-
  // tooltip-fix.md for the full evidence trail, including why a resource
  // bar tracking a hidden power needs its own Harmony-patch workaround
  // (ForgeResourceBarSupport's ForceVisibleForTooltipPatch) to still show
  // a tooltip on hover.
  const visibilityOverride = mechanic.hideIcon
    ? '\n    protected override bool IsVisibleInternal => false; // [VERIFIED — round 94, see claude/round94-hidden-status-tooltip-fix.md] "Hide status icon" checked: no vanilla icon, no apply flash, Artifact ignores it.'
    : '';
  // [Round 231] Tyler: "allow negative stacks checkbox... checkbox for hide
  // flash when effect triggers." Both [VERIFIED via direct ECMA-335 IL
  // disassembly of the real installed sts2.dll, round 231]:
  //   - PowerModel.AllowNegative (virtual, base returns false) is read
  //     directly by PowerModel.ShouldRemoveDueToAmount() (called from
  //     PowerCmd.ModifyAmount right after every stack change) — with it
  //     true, the status is removed only when Amount==0 exactly instead of
  //     whenever Amount<=0, letting it go negative without being deleted.
  //   - PowerModel.ShouldPlayVfx (virtual) gates ALL THREE of:
  //     NPowerFlashVfx.Create (icon flash particle), NPowerAppliedVfx.Create
  //     (applied banner/amount popup), and the buff/debuff SFX in
  //     NCreature.OnPowerIncreased — each checks power.ShouldPlayVfx and
  //     bails immediately if false. One override suppresses all three.
  // See schema/character.schema.json's mechanic.allowNegative/hideFlash for
  // the full evidence trail.
  const allowNegativeOverride = mechanic.allowNegative
    ? '\n    public override bool AllowNegative => true; // [VERIFIED — round 231, direct IL disassembly of sts2.dll] "Allow negative stacks" checked: ShouldRemoveDueToAmount() only removes this status at Amount==0 exactly, not whenever Amount<=0.'
    : '';
  const hideFlashOverride = mechanic.hideFlash
    ? '\n    public override bool ShouldPlayVfx => false; // [VERIFIED — round 231, direct IL disassembly of sts2.dll] "Hide flash when effect triggers" checked: suppresses the icon flash particle, the applied-VFX banner, and the buff/debuff SFX — all three real call sites gate on this one flag.'
    : '';
  return fillTemplate(tpl, {
    namespace,
    className: pascalCase(mechanic.name) + 'Power',
    mechanicId: mechanic.id,
    mechanicName: mechanic.name.replace(/"/g, '\\"'),
    powerTypeGuess,
    powerStackTypeGuess,
    visibilityOverride,
    allowNegativeOverride,
    hideFlashOverride,
    iconOverride: iconOverride || '',
    // NEW — mechanics previously had no way to define what they actually
    // DO on trigger (schema had no `mechanic.effects` field at all); this
    // reuses the exact same relic hook infrastructure (generateHookEffects/
    // TRIGGER_HOOKS), see Power.cs.template's header for the one remaining
    // honest caveat (player/target binding here isn't confirmed to be
    // specifically "this power's owner").
    hookMethods: [generateHookEffects(mechanic, 'mechanic', refMaps), generateModifierOverrides(mechanic, 'mechanic', refMaps), generateMechanicLocalization(mechanic)].filter(Boolean).join('\n\n'),
  });
}

// [Round 190] Real C# codegen for Enchantments -- Tyler: "lets wire this
// up to the real OnCardPlay trigger... Go further -- wire the whole
// schema." See Enchantment.cs.template's own header for the full
// field-mapping legend and the confirmed EnchantmentModel evidence trail
// (tools/sts2tools/ecma_dump_ext.py against the real installed sts2.dll).
// Mirrors generateRelicSource/generateMechanicSource's overall shape
// (loadTemplate -> build placeholder values -> fillTemplate) but hand-
// writes the override bodies directly instead of routing through
// generateHookEffects/actionToCSharp -- enchantments' schema
// (character.schema.json's enchantment/affliction shape, see
// buildEnchantmentAfflictionReadme just above for the full field list)
// is a fixed set of typed number/boolean fields, not an {trigger,
// conditions[], actions[]} effect list like cards/relics/mechanics have,
// so there's no action-object list for actionToCSharp to walk here.
function generateEnchantmentSource(enchantment, namespace, refMaps, assetCtx) {
  if (!enchantment.name || !pascalCase(enchantment.name)) {
    throw new Error('Enchantment has no usable name -- every enchantment needs a name to generate a C# class from.');
  }
  const tpl = loadTemplate('Enchantment.cs.template');
  const has = (n) => n !== null && n !== undefined && n !== '';
  const mo = enchantment.modifiers || {};
  const oa = enchantment.onApply || {};
  const op = enchantment.onPlay || {};
  const wp = enchantment.whilePile || {};
  const vt = enchantment.validTargets || {};
  const sh = enchantment.shuffle || {};
  const perStack = !!mo.perStack;
  const stacksSuffix = perStack ? ' * this.Amount' : '';

  // [Round 198] Icon -- the editor has always collected this (see
  // frontend/index.html's ench-icon-box / commitAsset(..., 'enchantmentIcon'))
  // but nothing in this generator ever read it back -- a real gap, same
  // "captured by the UI but never compiled" shape round 193's doc flagged
  // for the old energyReductionPerTurn field. Now wired: exported to a
  // real PNG under the real path convention a genuine working mod uses
  // (see ART_ENCHANTMENT_PREFIX's own comment), and CustomIconPath (the
  // one member CustomEnchantmentModel adds over plain EnchantmentModel --
  // see this file's own base-class comment above) points at it.
  let iconOverride = '';
  if (assetCtx) {
    const iconUrl = findAssetDataUrl(assetCtx.characterPackage, enchantment.icon, 'enchantmentIcon');
    if (iconUrl) {
      const rel = `${ART_ENCHANTMENT_PREFIX}${assetCtx.modIdLower}_${slugifyClassName(pascalCase(enchantment.name)).toLowerCase()}.png`;
      assetCtx.writeBinary(`pack/${rel}`, dataUrlToBuffer(iconUrl));
      iconOverride = `    // [VERIFIED via decompiling a real, working "STS2 Character Creator"-generated mod on Tyler's own machine (Enchantments/AddedWeight.cs et al, round 198) -- CustomEnchantmentModel.CustomIconPath is the real override point real custom enchantments use for their icon.
    protected override string? CustomIconPath => "res://${rel}";
`;
    }
  }

  const overrides = [];

  if (mo.canStack) {
    overrides.push(`    // [VERIFIED] real virtual bool get_IsStackable() override
    public override bool IsStackable => true;`);
  }
  if (mo.showNumberOnCard === false) {
    overrides.push(`    // [VERIFIED] real virtual bool get_ShowAmount() override
    public override bool ShowAmount => false;`);
  }
  if (sh.startAtBottomOfDraw) {
    overrides.push(`    // [VERIFIED] real virtual bool get_ShouldStartAtBottomOfDrawPile() override
    public override bool ShouldStartAtBottomOfDrawPile => true;`);
  }

  const typesSelected = [];
  if (vt.types) {
    if (vt.types.attack) typesSelected.push('Attack');
    if (vt.types.skill) typesSelected.push('Skill');
    if (vt.types.power) typesSelected.push('Power');
  }
  if (typesSelected.length && typesSelected.length < 3) {
    const expr = typesSelected.map(t => `cardType == CardType.${t}`).join(' || ');
    overrides.push(`    // [VERIFIED] real virtual bool CanEnchantCardType(CardType) override
    public override bool CanEnchantCardType(CardType cardType) => ${expr};`);
  }

  const vtTags = Array.isArray(vt.tags) ? vt.tags : [];
  const vtBaseTags = vtTags.filter(t => t && t.kind === 'base').map(t => t.ref);
  const vtCustomTags = vtTags.filter(t => t && t.kind === 'custom').map(t => t.ref);
  if (vtBaseTags.length || vtCustomTags.length || vt.excludeXCost) {
    const checks = [];
    vtBaseTags.forEach(k => checks.push(`        if (!card.Keywords.Contains(${keywordExpr(k)})) return false; // [VERIFIED] CardModel.Keywords is a real IReadOnlySet<CardKeyword> -- see conditionToCSharp's PlayedCardHasKeyword case`));
    vtCustomTags.forEach(t => checks.push(`        if ((card as IForgeTaggedCard)?.ForgeTags.Contains(${csharpStringLiteral(t)}) != true) return false; // [VERIFIED] same Forge-owned IForgeTaggedCard mechanism as conditionToCSharp's PlayedCardHasTag case`));
    if (vt.excludeXCost) checks.push(`        if (card.EnergyCost.CostsX) return false; // [VERIFIED via direct ECMA-335 metadata read of CardEnergyCost, round 200] CardEnergyCost.CostsX is a real, public, non-virtual bool property.`);
    overrides.push(`    // [VERIFIED signature, BEST EFFORT body] real virtual bool CanEnchant(CardModel) override
    public override bool CanEnchant(CardModel card)
    {
        if (!base.CanEnchant(card)) return false;
${checks.join('\n')}
        return true;
    }`);
  }

  if (has(mo.extraBlock)) {
    overrides.push(`    // [VERIFIED] real virtual decimal EnchantBlockAdditive(decimal) override
    public override decimal EnchantBlockAdditive(decimal originalBlock) => originalBlock + ${mo.extraBlock}m${stacksSuffix};`);
  }
  if (has(mo.blockBonusPct)) {
    overrides.push(`    // [VERIFIED] real virtual decimal EnchantBlockMultiplicative(decimal) override
    public override decimal EnchantBlockMultiplicative(decimal originalBlock) => originalBlock * (1m + (${mo.blockBonusPct}m${stacksSuffix} / 100m)); // [BEST EFFORT] "Multiplicative" applying as a % scale on top of the original value is Forge's own reading of the name -- not confirmed against a real multiplicative enchantment`);
  }
  if (has(mo.extraDamage)) {
    overrides.push(`    // [VERIFIED] real virtual decimal EnchantDamageAdditive(decimal, ValueProp) override
    public override decimal EnchantDamageAdditive(decimal originalDamage, ValueProp props) => originalDamage + ${mo.extraDamage}m${stacksSuffix};`);
  }
  if (has(mo.damageBonusPct)) {
    overrides.push(`    // [VERIFIED] real virtual decimal EnchantDamageMultiplicative(decimal, ValueProp) override
    public override decimal EnchantDamageMultiplicative(decimal originalDamage, ValueProp props) => originalDamage * (1m + (${mo.damageBonusPct}m${stacksSuffix} / 100m)); // [BEST EFFORT] see compiler.js's own comment on generateEnchantmentSource`);
  }
  if (has(mo.extraPlays)) {
    overrides.push(`    // [VERIFIED] real virtual int EnchantPlayCount(int) override
    public override int EnchantPlayCount(int originalPlayCount) => originalPlayCount + ${Math.trunc(mo.extraPlays)}${stacksSuffix};`);
  }

  // OnEnchant() -- fires once when the enchantment is applied [VERIFIED
  // signature: family virtual void OnEnchant()]. this.Card is a real
  // (non-virtual) CardModel-typed property -- safe to READ even though it
  // can't be overridden itself (same CS0506 reasoning Card.cs.template's
  // header gives for why its own Id/Name overrides were removed).
  const onEnchantLines = [];
  if (oa.zeroEnergyCostOnApply) {
    onEnchantLines.push(`        this.Card.EnergyCost.SetThisCombat(0, true); // [BEST EFFORT] CardEnergyCost.SetThisCombat(int, bool) is [VERIFIED] real (see compiler.js's costReductionTodoLines comment) -- the SAME real call TryModifyEnergyCostInCombat-driven cost reductions already use`);
  }
  // [Round 201 -- correcting round 200] Tyler supplied a real, working
  // reference enchantment ("TestRemove", from a genuinely different,
  // unrelated STS2 character-creator tool -- slay.spencerstiles.com --
  // found in a fresh copy of "The Burdened - New Character" on his own
  // machine) that adds Exhaust/Ethereal/Innate and removes
  // Retain/Sly/Eternal/Unplayable, all inside OnEnchant(), with NO
  // reversal on removal. Direct IL disassembly of its real, compiled
  // OnEnchant() body (tools/sts2tools/il_dump.py against that mod's own
  // .dll) shows exactly this: three CardModel.AddKeyword(CardKeyword)
  // calls (same [VERIFIED] real, public, non-virtual instance method
  // round 199 already uses for Afflictions), then four
  // CardCmd.RemoveKeyword(CardModel, CardKeyword[]) calls. Cross-checked
  // against the canonical installed sts2.dll: CardModel also has a real,
  // public, non-virtual RemoveKeyword(CardKeyword) instance method (the
  // exact symmetric pair to AddKeyword, same one round 199 already uses
  // for Afflictions' AfterApplied/BeforeRemoved apply-once/remove-once
  // pattern) -- used here instead of the CardCmd array-based static
  // version for consistency with AddKeyword just above and with
  // Afflictions' own call shape elsewhere in this file.
  //
  // Round 200 removed this feature outright, reasoning that since
  // EnchantmentModel has no removal/unenchant hook, a keyword change with
  // no way to reverse it on removal would be a real bug. That reasoning
  // was WRONG about the premise: this real, shipped, working reference
  // enchantment proves the correct semantic was never "reversible while
  // enchanted" -- it's a PERMANENT, one-way mutation applied once on
  // enchant, exactly like this.Card.EnergyCost.SetThisCombat(0, true)
  // above (zeroEnergyCostOnApply) already was, and exactly what
  // "removeKeywordsOnEnchant" is named for in the other tool's own
  // schema. Removing this enchantment later does NOT restore the
  // removed keywords or strip the added ones -- disclosed plainly in the
  // editor copy, not hidden.
  (Array.isArray(oa.addKeywords) ? oa.addKeywords : []).filter(k => CARD_KEYWORD_VALUES.includes(k)).forEach(k => {
    onEnchantLines.push(`        this.Card.AddKeyword(${keywordExpr(k)}); // [VERIFIED via direct ECMA-335 metadata read of CardModel, cross-confirmed by IL-disassembling a real, working reference enchantment's compiled OnEnchant() body, round 201] CardModel.AddKeyword(CardKeyword) is real, public, non-virtual -- applied once on enchant, permanent (no reversal on removal).`);
  });
  (Array.isArray(oa.removeKeywords) ? oa.removeKeywords : []).filter(k => CARD_KEYWORD_VALUES.includes(k)).forEach(k => {
    onEnchantLines.push(`        this.Card.RemoveKeyword(${keywordExpr(k)}); // [VERIFIED via direct ECMA-335 metadata read of CardModel, cross-confirmed by IL-disassembling a real, working reference enchantment's compiled OnEnchant() body, round 201] CardModel.RemoveKeyword(CardKeyword) is real, public, non-virtual -- applied once on enchant, permanent (no reversal on removal).`);
  });
  const onEnchantMethod = onEnchantLines.length
    ? `\n    protected override void OnEnchant()\n    {\n${onEnchantLines.join('\n')}\n    }\n`
    : '';

  // OnPlay() body -- [Round 191] Tyler: "there should be no freeform
  // boxes. the on play box should pull the onplay effect options." The
  // editor's "When the card is played" box is now the SAME
  // renderEffectsList() trigger/condition/action editor cards use for
  // their own OnPlay, restricted to the one confirmed real
  // EnchantmentModel hook ('OnPlay') -- so this now reuses the exact same
  // effectsToCSharp/actionToCSharp machinery generateCardSource's own
  // OnPlay body does, instead of round 190's ad-hoc per-field mapping
  // (onceOnlyPerCombat/damageGrowthPerStack/etc., all removed from the
  // schema this round). ctx mirrors cascadingTriggerBody's own OnPlay ctx
  // exactly (cardPlayBound/fgPlayerBound true, targetMayBeNull false --
  // same real cardPlay object, same real guarantees a card's own OnPlay
  // already relies on) except thisIsCard: false -- `this` here is the
  // EnchantmentModel, not the played CardModel, so actions like
  // ShuffleCardIntoDraw/ReturnToHand correctly fall back to their own
  // existing ctx.thisIsCard-gated Todo() stubs instead of emitting
  // `this`-referencing code that would target the wrong object.
  const onPlayEffects = (Array.isArray(op.effects) ? op.effects : []).filter(eff => eff && eff.trigger === 'OnPlay');
  const onPlayCtx = { cardPlayBound: true, thisIsCard: false, fgPlayerBound: true, targetMayBeNull: false, cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById };
  const onPlayBody = onPlayEffects.length ? effectsToCSharp(onPlayEffects, onPlayCtx) : '        // no OnPlay effects defined';

  // [Round 200 -- "make this section fully functional"] "Additional
  // Triggers" -- NEW for Enchantments this round, mirroring Afflictions'
  // round-199 addition: EnchantmentModel extends AbstractModel (the same
  // common base Cards/Relics/Powers/Afflictions/Orbs all share -- see
  // TRIGGER_HOOKS' own header), so it genuinely has the same 200+-method
  // real hook surface. `enchantment.effects` is a NEW, separate array
  // from `onPlay.effects` above (which keeps its own dedicated OnPlay-only
  // shape unchanged) -- generateHookEffects itself rejects 'OnPlay' being
  // picked again here.
  //
  // "While in a pile" now compiles for real too, merged into this SAME
  // combined list -- each whilePile entry tagged with a real __pileGuard
  // (this.Card.Pile?.Type == X, see wrapPileGuard's own header comment)
  // instead of staying a NOT-compiled comment the way round 190/191 left
  // it. Both arrays share the same real HOOK_TRIGGERS vocabulary now (the
  // frontend no longer offers the card-only WHILE_IN_HAND_TRIGGERS ids
  // here -- EnchantmentModel can't override those, they're declared on
  // CustomCardModel).
  const whilePileEffects = Array.isArray(wp.effects) ? wp.effects : [];
  const combinedTriggerEffects = [
    ...(Array.isArray(enchantment.effects) ? enchantment.effects : []),
    ...whilePileEffects.map(e => ({ ...e, __pileGuard: pileTypeExpr(e.pile) })),
  ];
  const extraTriggerMethods = combinedTriggerEffects.length
    ? generateHookEffects({ effects: combinedTriggerEffects }, 'enchantment', refMaps)
    : '';

  return fillTemplate(tpl, {
    namespace,
    className: pascalCase(enchantment.name) + 'Enchantment',
    iconOverride,
    modifierOverrides: overrides.length ? overrides.join('\n\n') + '\n' : '',
    onEnchantMethod,
    perStackFlag: perStack ? 'true' : 'false',
    onPlayBody,
    extraTriggerMethods,
  });
}

// [Round 196] AfflictionModel -- a REAL, SEPARATE base-game class from
// EnchantmentModel (confirmed via direct ECMA-335 metadata read of the
// real installed sts2.dll, same tools/sts2tools/ecma_dump_ext.py
// toolchain round 190 used for EnchantmentModel). Tyler's own framing:
// "afflictions are temporary enchantments" -- this is why the two now
// have genuinely different schemas/editors (no damage/block modifiers,
// no icon, no card frames on Afflictions; new cost-change/keyword/
// status-gating fields Enchantments don't have) instead of sharing one
// shape the way rounds 95-195 had them.
//
// Confirmed real virtual members used below (35 total methods found on
// AfflictionModel; see claude/round196-afflictions-real-shape.md for the
// full dump):
//   CanAfflictCardType(CardType cardType)
//   bool get_CanAfflictUnplayableCards()
//   bool get_IsStackable()
//   bool CanAfflict(CardModel card)
//   void AfterApplied()      -- fires once when this affliction attaches
//   void BeforeRemoved()     -- fires once when it's removed/cleared
//   Task OnPlay(PlayerChoiceContext, Creature target) -- NOTE: a raw
//     Creature, not a CardPlay -- see the OnPlay body comment below.
// this.Card (get_Card/set_Card) is real but NOT virtual -- same
// CS0506 reasoning as EnchantmentModel's Card/Title/etc., safe to READ,
// never override.
function generateAfflictionSource(affliction, namespace, refMaps) {
  if (!affliction.name || !pascalCase(affliction.name)) {
    throw new Error('Affliction has no usable name -- every affliction needs a name to generate a C# class from.');
  }
  const tpl = loadTemplate('Affliction.cs.template');
  const has = (n) => n !== null && n !== undefined && n !== '';
  const vt = affliction.validTargets || {};
  const cc = affliction.costChange || {};
  const rs = affliction.requiresStatus || {};

  const overrides = [];

  if (affliction.canStack) {
    overrides.push(`    // [VERIFIED] real virtual bool get_IsStackable() override
    public override bool IsStackable => true;`);
  }
  if (affliction.canAffectUnplayableCards) {
    overrides.push(`    // [VERIFIED] real virtual bool get_CanAfflictUnplayableCards() override
    public override bool CanAfflictUnplayableCards => true;`);
  }

  // [Round 196] 5 real CardType values Forge itself already offers
  // elsewhere (CARD_TYPE_ORDER, frontend) -- Attack/Skill/Power/Status/
  // Curse. The reference tool's own picker also showed a 6th "Quest"
  // checkbox; left out here since no card anywhere in Forge can actually
  // BE type Quest (typeOptionsForCard never offers it), so a working
  // checkbox for an unreachable type would be misleading rather than
  // useful -- can be added for real the moment Forge supports Quest cards
  // elsewhere.
  const typesSelected = [];
  if (vt.types) {
    if (vt.types.attack) typesSelected.push('Attack');
    if (vt.types.skill) typesSelected.push('Skill');
    if (vt.types.power) typesSelected.push('Power');
    if (vt.types.status) typesSelected.push('Status');
    if (vt.types.curse) typesSelected.push('Curse');
  }
  if (typesSelected.length && typesSelected.length < 5) {
    const expr = typesSelected.map(t => `cardType == CardType.${t}`).join(' || ');
    overrides.push(`    // [VERIFIED] real virtual bool CanAfflictCardType(CardType) override
    public override bool CanAfflictCardType(CardType cardType) => ${expr};`);
  }

  const vtTags = Array.isArray(vt.tags) ? vt.tags : [];
  const vtBaseTags = vtTags.filter(t => t && t.kind === 'base').map(t => t.ref);
  const vtCustomTags = vtTags.filter(t => t && t.kind === 'custom').map(t => t.ref);
  if (vtBaseTags.length || vtCustomTags.length || vt.excludeXCost) {
    const checks = [];
    vtBaseTags.forEach(k => checks.push(`        if (!card.Keywords.Contains(${keywordExpr(k)})) return false; // [VERIFIED] CardModel.Keywords is a real IReadOnlySet<CardKeyword> -- see conditionToCSharp's PlayedCardHasKeyword case`));
    vtCustomTags.forEach(t => checks.push(`        if ((card as IForgeTaggedCard)?.ForgeTags.Contains(${csharpStringLiteral(t)}) != true) return false; // [VERIFIED] same Forge-owned IForgeTaggedCard mechanism as conditionToCSharp's PlayedCardHasTag case`));
    if (vt.excludeXCost) checks.push(`        if (card.EnergyCost.CostsX) return false; // [VERIFIED via direct ECMA-335 metadata read of CardEnergyCost, round 200] CardEnergyCost.CostsX is a real, public, non-virtual bool property.`);
    overrides.push(`    // [VERIFIED signature, BEST EFFORT body] real virtual bool CanAfflict(CardModel) override
    public override bool CanAfflict(CardModel card)
    {
        if (!base.CanAfflict(card)) return false;
${checks.join('\n')}
        return true;
    }`);
  }

  // AfterApplied()/BeforeRemoved() -- [VERIFIED signatures: public virtual
  // void AfterApplied() / BeforeRemoved()], the affliction-side analog of
  // EnchantmentModel's OnEnchant(). Two things can land here:
  //   1. costChange (BEST EFFORT) -- no continuous "modify this card's
  //      cost while attached" override exists on AfflictionModel (unlike
  //      what EnchantBlockAdditive/etc. give Enchantments), so this reuses
  //      the same [VERIFIED] CardEnergyCost.AddThisCombat(int, bool) call
  //      costReductionTodoLines/ModifyCost already use elsewhere, applied
  //      once on attach and reversed once on removal so an early removal
  //      mid-combat doesn't leave a stale cost change behind. Multiplying
  //      by `this.Amount` (real, non-virtual int) when
  //      "Multiply cost change by Amount" is checked is Forge's own
  //      stacking semantic, same convention Enchantments' `perStack` uses
  //      -- a KNOWN limitation: if Amount changes between separate
  //      applications, the BeforeRemoved() reversal (which reads Amount
  //      AGAIN at removal time) may not exactly cancel out the sum of
  //      several differently-sized applications. Disclosed, not silently
  //      wrong.
  //   2. keywordsWhileAfflicted (Round 199 -- now [VERIFIED] real) --
  //      CardModel.AddKeyword(CardKeyword)/RemoveKeyword(CardKeyword), both
  //      confirmed real via direct ECMA-335 metadata read, applied once on
  //      attach and reversed once on removal, same timing as costChange
  //      above. (Enchantments' own equivalent onApply.addKeywords/
  //      removeKeywords fields were removed outright instead, rather than
  //      compiled the same way -- EnchantmentModel has no removal hook at
  //      all to reverse them with; see Enchantment.cs.template's header.)
  const applyLines = [];
  const removeLines = [];
  const ccAmount = has(cc.amount) ? Math.trunc(Number(cc.amount)) : 0;
  if (ccAmount !== 0) {
    const stacksExpr = cc.multiplyByAmount ? ' * this.Amount' : '';
    applyLines.push(`        this.Card.EnergyCost.AddThisCombat(${ccAmount}${stacksExpr}, false); // [BEST EFFORT] CardEnergyCost.AddThisCombat(int, bool) is [VERIFIED] real (see compiler.js's costReductionTodoLines comment) -- applied once on attach, reversed in BeforeRemoved() below`);
    removeLines.push(`        this.Card.EnergyCost.AddThisCombat(${-ccAmount}${stacksExpr}, false); // [BEST EFFORT] undoes the AfterApplied() change -- see this affliction's class header for the known stacking-amount caveat`);
  }
  // [Round 199 -- "build out the full affliction section"] Closed via
  // direct ECMA-335 reflection of CardModel: `public void AddKeyword
  // (CardKeyword keyword)` / `public void RemoveKeyword(CardKeyword
  // keyword)` are both real, public, non-virtual instance methods --
  // confirmed as a DIFFERENT member pair from the get_Keywords()/
  // get_CanonicalKeywords() getters this class's header used to cite as
  // the only confirmed surface. Mirrors the exact same real call
  // (CardModel.AddKeyword(CardKeyword)) already [VERIFIED] and in use
  // elsewhere in this file for a card's own permanent keywords (see
  // resolveActedCardExpr's neighboring comment) -- this is the same real
  // API, just invoked dynamically here (attach/detach) instead of once at
  // construction. keywordExpr(word) is the existing CardKeyword.${word}
  // helper this file already uses for CanAfflict's tag checks above.
  const kwWhile = Array.isArray(affliction.keywordsWhileAfflicted) ? affliction.keywordsWhileAfflicted.filter(k => CARD_KEYWORD_VALUES.includes(k)) : [];
  if (kwWhile.length) {
    kwWhile.forEach(k => {
      applyLines.push(`        this.Card.AddKeyword(${keywordExpr(k)}); // [VERIFIED via direct ECMA-335 metadata read of CardModel, round 199] CardModel.AddKeyword(CardKeyword) is real, public, non-virtual -- applied once on attach, reversed in BeforeRemoved() below.`);
      removeLines.push(`        this.Card.RemoveKeyword(${keywordExpr(k)}); // [VERIFIED via direct ECMA-335 metadata read of CardModel, round 199] CardModel.RemoveKeyword(CardKeyword) is real, public, non-virtual -- undoes the AfterApplied() change above.`);
    });
  }
  const applyRemoveParts = [];
  if (applyLines.length) applyRemoveParts.push(`    public override void AfterApplied()\n    {\n${applyLines.join('\n')}\n    }`);
  if (removeLines.length) applyRemoveParts.push(`    public override void BeforeRemoved()\n    {\n${removeLines.join('\n')}\n    }`);
  const applyRemoveMethods = applyRemoveParts.length ? '\n' + applyRemoveParts.join('\n\n') + '\n' : '';

  // "Requires status on owner" -- [BEST EFFORT] no confirmed "recheck this
  // continuously" override exists, so this only gates the OnPlay effects
  // below (real, since OnPlay fires fresh every play -- true continuous
  // behavior emerges from that, not from a dedicated status-gate API).
  // Reuses the exact same [VERIFIED] ForgeActions.GetStatusStacks<T>
  // call conditionToCSharp's HasStatusStacks case already uses, same
  // vanilla/custom split (BUILTIN_POWER_CLASS_MAP / mechanicClassName).
  let requiresStatusGuard = '';
  if (rs.enabled) {
    const statusKind = rs.kind === 'custom' ? 'custom' : 'vanilla';
    const typeArg = statusKind === 'vanilla' ? BUILTIN_POWER_CLASS_MAP[rs.builtinStatus] : mechanicClassName(rs.statusRef);
    if (typeArg) {
      requiresStatusGuard = `        if (ForgeActions.GetStatusStacks<${typeArg}>(fgPlayer) < 1) { await Task.CompletedTask; return; } // [BEST EFFORT] "Requires status on owner" -- only gates these OnPlay effects (real, rechecked every play); does NOT gate the AfterApplied/BeforeRemoved cost/keyword changes above -- see this affliction's class header.\n`;
    }
  }

  // OnPlay() body -- [Round 196] same renderEffectsList()-authored
  // {trigger,conditions,actions,elseActions} shape Enchantments' OnPlay
  // already uses, but ctx differs: cardPlayBound: false, thisIsCard:
  // false -- AfflictionModel.OnPlay has no real CardPlay object in scope
  // at all (its second parameter is a raw Creature, not a CardPlay -- see
  // Affliction.cs.template's own header), so anything requiring
  // ctx.cardPlayBound (ModifyCost's "borrow cardPlay.Card" fallback tier,
  // EndTurn, etc.) correctly falls to its next, more conservative
  // fallback instead of emitting a compile-breaking `cardPlay` reference.
  const onPlayEffects = ((affliction.onPlay && Array.isArray(affliction.onPlay.effects)) ? affliction.onPlay.effects : []).filter(eff => eff && eff.trigger === 'OnPlay');
  const onPlayCtx = { cardPlayBound: false, thisIsCard: false, fgPlayerBound: true, targetMayBeNull: true, affectedCardIsThisCard: true, cardClassById: refMaps && refMaps.cardClassById, relicClassById: refMaps && refMaps.relicClassById, afflictionClassById: refMaps && refMaps.afflictionClassById, enchantmentClassById: refMaps && refMaps.enchantmentClassById };
  const onPlayBody = onPlayEffects.length ? effectsToCSharp(onPlayEffects, onPlayCtx) : '        // no OnPlay effects defined';

  // [Round 199 -- "build out the full affliction section"] Additional
  // triggers beyond OnPlay -- AfflictionModel extends AbstractModel (round
  // 199's own AfflictionModel reflection, re-confirming round 196's), so
  // it genuinely inherits the SAME 200+-method real hook surface Relics/
  // Mechanics already expose via TRIGGER_HOOKS/generateHookEffects
  // (BeforeFlush -- the exact hook Reckless.cs's real end-of-turn cleanup
  // needs, see TRIGGER_HOOKS' own new entry -- OnCombatStart,
  // OnMyTurnStart, AfterMyDamageGiven, etc.). `affliction.effects` is a
  // NEW, separate array from `affliction.onPlay.effects` (which keeps its
  // own dedicated, differently-shaped OnPlay handling above unchanged) --
  // generateHookEffects itself rejects 'OnPlay' being picked again here
  // (see its own updated error message). hookCtx's affectedCardIsThisCard
  // (set for entityKind==='affliction') is what lets AfflictCard/
  // RemoveAffliction/EnchantCard/RemoveEnchantment/ClearAfflictionFromPile
  // resolve "this card" correctly from any of these hooks too, not just
  // OnPlay.
  // [Round 200 -- "make this section fully functional"] "While in a
  // pile" now compiles for real too -- merged into the SAME combined
  // effects list "Additional Triggers" uses, each whilePile entry tagged
  // with a real __pileGuard (this.Card.Pile?.Type == X, see
  // wrapPileGuard's own header comment) instead of staying a NOT-compiled
  // comment. Both arrays share the same real HOOK_TRIGGERS vocabulary
  // now (the frontend no longer offers the card-only WHILE_IN_HAND_TRIGGERS
  // ids here -- AfflictionModel can't override those, they're declared on
  // CustomCardModel).
  const whilePileEffects = (affliction.whilePile && Array.isArray(affliction.whilePile.effects)) ? affliction.whilePile.effects : [];
  const combinedTriggerEffects = [
    ...(Array.isArray(affliction.effects) ? affliction.effects : []),
    ...whilePileEffects.map(e => ({ ...e, __pileGuard: pileTypeExpr(e.pile) })),
  ];
  const extraTriggerMethods = combinedTriggerEffects.length
    ? generateHookEffects({ effects: combinedTriggerEffects }, 'affliction', refMaps)
    : '';

  // [Round 198] Registration -- AfflictionModel has no CustomAfflictionModel
  // wrapper in BaseLib (unlike every other custom-content category), so a
  // real, working example (Afflictions/Reckless.cs, a genuinely different
  // "STS2 Character Creator"-generated mod on Tyler's own machine) uses an
  // explicit [CustomID("...")] attribute instead. Same real ID shape that
  // file uses ("MODID-CLASSNAME"), built with slugifyClassName -- the
  // [VERIFIED via real sts2.dll IL disassembly] algorithm the game itself
  // uses for ModelId.Entry -- rather than inventing a new naming scheme.
  const afflictionCustomId = `${namespace.toUpperCase()}-${slugifyClassName(pascalCase(affliction.name))}`;
  const classAttribute = `[BaseLib.Utils.Attributes.CustomID(${csharpStringLiteral(afflictionCustomId)})] // [VERIFIED via decompiling a real, working "STS2 Character Creator"-generated mod on Tyler's own machine (Afflictions/Reckless.cs, round 198) -- the real registration mechanism real custom afflictions use, since AfflictionModel has no CustomAfflictionModel wrapper to extend.
`;

  return fillTemplate(tpl, {
    namespace,
    className: pascalCase(affliction.name) + 'Affliction',
    classAttribute,
    modifierOverrides: overrides.length ? overrides.join('\n\n') + '\n' : '',
    applyRemoveMethods,
    requiresStatusGuard,
    onPlayBody,
    extraTriggerMethods,
  });
}

function buildManifestJson(characterPackage, modId, gameVersion) {
  const manifest = {
    id: modId,
    name: characterPackage.character.name,
    author: characterPackage.author || 'Unknown',
    description: characterPackage.character.shortDescription || '',
    version: characterPackage.modVersion || '1.0.0',
    // [VERIFIED, Round 28 ground-up audit] the real official template's own
    // manifest (Alchyr.Sts2.Templates package, content/ModTemplate/
    // ModTemplate.json, fetched verbatim from GitHub) always includes a
    // top-level min_game_version field ("0.107.0" in that template's own
    // published example) — Forge's manifest never had this field at all.
    // gameVersion here comes from server.js reading the real installed
    // game's own release_info.json (gameLocator.readReleaseInfo), so this
    // always reflects Tyler's actual installed version rather than a
    // hardcoded/stale guess — confirmed "v0.111.0" -> "0.111.0" against his
    // real install. Falls back to null (field omitted, same as before) if
    // no game install could be located at compile time — an honest gap,
    // not a guess, same convention as every other [VERIFIED] field here.
    ...(gameVersion ? { min_game_version: gameVersion } : {}),
    dependencies: [{ id: 'BaseLib', min_version: BASELIB_MIN_VERSION }],
    affects_gameplay: true,
    // [VERIFIED, Round 28] has_pck/has_dll ARE required, not optional/computed.
    // Confirmed by comparing real working mod manifests (TheBurdenedNewCharacter.json,
    // BaseLib.json) which both explicitly declare these two fields, against Forge's
    // own generated manifests (TestChar.json, SpineShopTest.json) which previously
    // omitted them entirely. The game's own log file (godot.log) proved the causal
    // link: mods missing these fields get
    //   "[WARN] Neither a DLL nor a PCK was loaded for mod X, something seems wrong!"
    // and the loader never even attempts "Loading assembly DLL" / "Loading Godot PCK" /
    // "Calling initializer method" — the exact three steps present in the log for
    // working mods. This is very likely THE root cause of every Forge-exported
    // character never appearing in the in-game character select screen. Every Forge
    // character mod ships both a DLL and a PCK, so both are hardcoded true here.
    // See TOOLCHAIN_FINDINGS.md for the full evidence trail.
    has_pck: true,
    has_dll: true,
  };
  return escapeXmlText(JSON.stringify(manifest, null, 2));
}

// Writes the full generated project into outDir. Returns { written, modId, modName }.
// Pets/Orbs README builders — see generateProject's call sites above for
// why these are markdown, not C#. Both follow the exact same shape: a
// short evidence-review header (copied from the frontend's section-pets/
// section-orbs panel-desc, so the story is consistent wherever Tyler reads
// it) followed by one Markdown section per captured entity, dumping every
// field Tyler entered so nothing typed into either editor is ever lost on
// export even though it doesn't compile yet.
function buildPetsReadme(pets) {
  const lines = [];
  lines.push('# Pets — captured, not yet compiled');
  lines.push('');
  lines.push('Every STS2 character reflected so far has ONE fixed companion (`Player.Osty` —');
  lines.push('[VERIFIED via reflect-baselib round 5]) that already exists on the base game\'s');
  lines.push('`Player` type. No reflect-baselib round has found any real, confirmed (or even');
  lines.push('plausibly-guessable) mechanism for a mod to define an ADDITIONAL or REPLACEMENT');
  lines.push('pet/companion of its own — unlike Orbs (see Orbs/README.md), there isn\'t even a');
  lines.push('real namespace/folder convention pointing at one existing anywhere. The pet(s)');
  lines.push('below are saved as a design doc so they\'re ready the moment a future');
  lines.push('reflect-baselib round confirms a real mechanism — this file is not read by the');
  lines.push('compiled mod at runtime.');
  lines.push('');
  pets.forEach(p => {
    lines.push(`## ${p.name || 'Untitled'}`);
    lines.push('');
    if (p.description) { lines.push(p.description); lines.push(''); }
    if (p.abilityText) { lines.push('**What it does:** ' + p.abilityText); lines.push(''); }
  });
  return lines.join('\n');
}

// [Round 95] Shared by both Enchantments/README.md and Afflictions/
// README.md (same shape as buildPetsReadme just above, just parameterized
// by the noun/heading since the two entities are structurally identical —
// see character.schema.json's enchantment/affliction definitions).
// [Round 168] Rewritten for the much richer field set the editor now
// captures (Tyler pointed at slay.spencerstiles.com's own Enchantments
// editor as the reference shape — see frontend/index.html's own header
// comment on this section for the full context). Still a pure design-doc
// export — nothing here is [VERIFIED]/[BEST EFFORT] compiled behavior,
// same honesty convention as before; only non-blank/non-default fields
// are printed so an entry with just a name+description still reads clean.
function buildEnchantmentAfflictionReadme(heading, entries) {
  const lines = [];
  const isEnchantments = heading === 'Enchantments';
  if (isEnchantments) {
    lines.push(`# ${heading} -- this now fully compiles to real C#`);
    lines.push('');
    lines.push('MegaCrit.Sts2.Core.Models.EnchantmentModel is a [VERIFIED] real base-game');
    lines.push('class (see claude/round190-enchantments-real-codegen.md for the full');
    lines.push('reflection evidence) -- each entry below also writes a real');
    lines.push('Enchantments/<Name>Enchantment.cs. Every field on this section now');
    lines.push('compiles to real, confirmed C# -- see that .cs file\'s own header comment');
    lines.push('for the full evidence trail on each override ([VERIFIED] vs. [BEST');
    lines.push('EFFORT] semantics-only caveats). This file itself is a design-doc summary');
    lines.push('only -- it is not read by the compiled mod at runtime.');
    lines.push('');
  } else {
    lines.push(`# ${heading} -- this now fully compiles to real C#`);
    lines.push('');
    lines.push('[Round 196] MegaCrit.Sts2.Core.Models.AfflictionModel is a [VERIFIED] real,');
    lines.push('SEPARATE base-game class from EnchantmentModel above (see');
    lines.push('claude/round196-afflictions-real-shape.md for the full reflection');
    lines.push('evidence) -- Tyler\'s own framing: "afflictions are temporary');
    lines.push('enchantments." Each entry below also writes a real');
    lines.push('Afflictions/<Name>Affliction.cs. Every field on this section now');
    lines.push('compiles to real, confirmed C# -- see that .cs file\'s own header comment');
    lines.push('for the full evidence trail on each override ([VERIFIED] vs. [BEST');
    lines.push('EFFORT] semantics-only caveats). This file itself is a design-doc summary');
    lines.push('only -- it is not read by the compiled mod at runtime.');
    lines.push('');
  }
  lines.push('[Round 168] Roughed out against the fuller field set a similar community');
  lines.push('tool (slay.spencerstiles.com) uses for its own card-enchantment editor --');
  lines.push('every field below is captured the same design-doc-only way as before, just');
  lines.push('a richer shape. Fields left blank in the editor are omitted below.');
  lines.push('');

  const has = (n) => n !== null && n !== undefined && n !== '';

  if (isEnchantments) {
    entries.forEach(e => {
      lines.push(`## ${e.name || 'Untitled'}`);
      lines.push('');
      if (e.description) { lines.push(''); lines.push(e.description); }
      if (e.cardLineText) { lines.push(''); lines.push(`**Line added to the card:** ${e.cardLineText}`); }
      lines.push('');

      const vt = e.validTargets || {};
      const vtTypes = vt.types || {};
      const vtTypeBits = [];
      if (vtTypes.attack) vtTypeBits.push('Attack');
      if (vtTypes.skill) vtTypeBits.push('Skill');
      if (vtTypes.power) vtTypeBits.push('Power');
      const validTargetBits = [];
      if (vtTypeBits.length && vtTypeBits.length < 3) validTargetBits.push(`types: ${vtTypeBits.join(', ')}`);
      if (vt.excludeXCost) validTargetBits.push('excludes X-cost cards');
      const vtTags = Array.isArray(vt.tags) ? vt.tags : [];
      const vtBaseTags = vtTags.filter(t => t && t.kind === 'base').map(t => t.ref);
      const vtCustomTags = vtTags.filter(t => t && t.kind === 'custom').map(t => t.ref);
      if (vtBaseTags.length) validTargetBits.push(`base tags: ${vtBaseTags.join(', ')}`);
      if (vtCustomTags.length) validTargetBits.push(`custom tags: ${vtCustomTags.join(', ')}`);
      if (validTargetBits.length) { lines.push(`**Valid targets:** ${validTargetBits.join('; ')}`); lines.push(''); }

      const mo = e.modifiers || {};
      const moBits = [];
      if (has(mo.extraDamage)) moBits.push(`+${mo.extraDamage} damage`);
      if (has(mo.damageBonusPct)) moBits.push(`+${mo.damageBonusPct}% damage`);
      if (has(mo.extraBlock)) moBits.push(`+${mo.extraBlock} Block`);
      if (has(mo.blockBonusPct)) moBits.push(`+${mo.blockBonusPct}% Block`);
      if (has(mo.extraPlays)) moBits.push(`+${mo.extraPlays} extra play(s)`);
      if (mo.perStack) moBits.push('multiplied by stacks applied');
      if (mo.canStack) moBits.push('stacks (applying again raises the amount)');
      if (mo.showNumberOnCard === false) moBits.push('stack number hidden on card');
      if (moBits.length) { lines.push(`**Modifiers:** ${moBits.join(', ')}`); lines.push(''); }

      // [Round 201 -- correcting round 200] addKeywords/removeKeywords
      // are real again -- see generateEnchantmentSource's own comment for
      // the full evidence trail (a real, working reference enchantment
      // proved this compiles for real, permanently, on OnEnchant()).
      const oa = e.onApply || {};
      const oaBits = [];
      if ((oa.addKeywords || []).length) oaBits.push(`adds ${oa.addKeywords.join(', ')} (permanent)`);
      if ((oa.removeKeywords || []).length) oaBits.push(`removes ${oa.removeKeywords.join(', ')} (permanent)`);
      if (oa.zeroEnergyCostOnApply) oaBits.push('sets Energy cost to 0');
      if (oaBits.length) { lines.push(`**On application:** ${oaBits.join('; ')}`); lines.push(''); }

      // [Round 191] op.effects/wp.effects replace the old ad-hoc onPlay
      // fields and whilePile.triggersText freeform text -- see
      // generateEnchantmentSource for how (and whether) each compiles.
      const op = e.onPlay || {};
      const opEffects = Array.isArray(op.effects) ? op.effects : [];
      if (opEffects.length) {
        lines.push(`**On play:** ${opEffects.length} effect block(s) defined in the editor -- compiles to real C#, see Enchantments/${pascalCase(e.name || 'Untitled')}Enchantment.cs`);
        opEffects.forEach((eff, i) => {
          const condN = (eff.conditions || []).length;
          const actN = (eff.actions || []).length;
          lines.push(`- Effect ${i + 1}: ${actN} action(s)${condN ? `, ${condN} condition(s)` : ''}`);
        });
        lines.push('');
      } else if (e.effectText) {
        lines.push(`**What it does:** ${e.effectText}`); lines.push('');
      }

      const sh = e.shuffle || {};
      if (sh.startAtBottomOfDraw || (sh.shuffleOrder && sh.shuffleOrder !== 'normal')) {
        const shBits = [];
        if (sh.startAtBottomOfDraw) shBits.push('starts at the bottom of the draw pile');
        if (sh.shuffleOrder && sh.shuffleOrder !== 'normal') shBits.push(`shuffle order: ${sh.shuffleOrder}`);
        lines.push(`**Shuffling:** ${shBits.join('; ')}`);
        lines.push('');
      }

      const wp = e.whilePile || {};
      const wpEffects = Array.isArray(wp.effects) ? wp.effects : [];
      if (wpEffects.length) {
        lines.push(`**While waiting in a pile:** ${wpEffects.length} effect block(s) defined in the editor -- compiles to real C# (Round 200), gated by a real \`this.Card.Pile?.Type\` check, see Enchantments/${pascalCase(e.name || 'Untitled')}Enchantment.cs`);
        wpEffects.forEach((eff, i) => {
          const actN = (eff.actions || []).length;
          lines.push(`- While in ${eff.pile || 'Hand'}, ${eff.trigger || '?'}: ${actN} action(s)`);
        });
        lines.push('');
      }

      // [Round 200] Additional Triggers -- NEW for Enchantments this
      // round, same real hook vocabulary Relics/Mechanics/Afflictions use.
      const additionalEffects = Array.isArray(e.effects) ? e.effects : [];
      if (additionalEffects.length) {
        lines.push(`**Additional triggers:** ${additionalEffects.length} effect block(s) defined in the editor -- compiles to real C#, see Enchantments/${pascalCase(e.name || 'Untitled')}Enchantment.cs`);
        additionalEffects.forEach((eff, i) => {
          const actN = (eff.actions || []).length;
          lines.push(`- Trigger ${eff.trigger || '?'}: ${actN} action(s)`);
        });
        lines.push('');
      }

      if (e.icon) lines.push('_Has a custom icon._');
      const cf = e.cardFrames || {};
      if (cf.enchanted || cf.attack || cf.skill || cf.power) lines.push('_Has custom enchanted card frame art._');
      lines.push('');
    });
    return lines.join('\n');
  }

  // [Round 196] Afflictions -- genuinely different shape from
  // Enchantments now (no modifiers/onApply/icon/cardFrames -- see
  // generateAfflictionSource's own comment for why).
  entries.forEach(e => {
    lines.push(`## ${e.name || 'Untitled'}`); // [Round 196 follow-up] Category field removed per Tyler's ask
    lines.push('');
    if (e.description) { lines.push(''); lines.push(e.description); }
    if (e.cardLineText) { lines.push(''); lines.push(`**Line added to the card:** ${e.cardLineText}`); }
    lines.push('');

    const vt = e.validTargets || {};
    const vtTypes = vt.types || {};
    const vtTypeBits = [];
    if (vtTypes.attack) vtTypeBits.push('Attack');
    if (vtTypes.skill) vtTypeBits.push('Skill');
    if (vtTypes.power) vtTypeBits.push('Power');
    if (vtTypes.status) vtTypeBits.push('Status');
    if (vtTypes.curse) vtTypeBits.push('Curse');
    const validTargetBits = [];
    if (vtTypeBits.length && vtTypeBits.length < 5) validTargetBits.push(`types: ${vtTypeBits.join(', ')}`);
    if (vt.excludeXCost) validTargetBits.push('excludes X-cost cards');
    const vtTags = Array.isArray(vt.tags) ? vt.tags : [];
    const vtBaseTags = vtTags.filter(t => t && t.kind === 'base').map(t => t.ref);
    const vtCustomTags = vtTags.filter(t => t && t.kind === 'custom').map(t => t.ref);
    if (vtBaseTags.length) validTargetBits.push(`base tags: ${vtBaseTags.join(', ')}`);
    if (vtCustomTags.length) validTargetBits.push(`custom tags: ${vtCustomTags.join(', ')}`);
    if (validTargetBits.length) { lines.push(`**Valid targets:** ${validTargetBits.join('; ')}`); lines.push(''); }

    const propBits = [];
    if (e.canStack) propBits.push('stacks (repeated applications raise the amount)');
    if (e.canAffectUnplayableCards) propBits.push('can affect already-Unplayable cards');
    if (propBits.length) { lines.push(`**Properties:** ${propBits.join('; ')}`); lines.push(''); }

    const rs = e.requiresStatus || {};
    if (rs.enabled) {
      const statusLabel = rs.kind === 'custom' ? `custom status "${rs.statusRef || '?'}"` : (rs.builtinStatus || '?');
      lines.push(`**Requires status on owner:** ${statusLabel} (gates the On Play effects below only -- see the generated .cs for why it can't gate the cost/keyword changes too)`);
      lines.push('');
    }

    const cc = e.costChange || {};
    const ccBits = [];
    if (has(cc.amount) && Number(cc.amount) !== 0) {
      ccBits.push(`${cc.amount > 0 ? '+' : ''}${cc.amount} Energy cost${cc.multiplyByAmount ? ' (multiplied by stacks applied)' : ''}`);
    }
    if (ccBits.length) { lines.push(`**Energy cost change:** ${ccBits.join(', ')}`); lines.push(''); }

    const kwWhile = Array.isArray(e.keywordsWhileAfflicted) ? e.keywordsWhileAfflicted : [];
    if (kwWhile.length) { lines.push(`**Keywords while afflicted:** ${kwWhile.join(', ')}`); lines.push(''); }

    const op = e.onPlay || {};
    const opEffects = Array.isArray(op.effects) ? op.effects : [];
    if (opEffects.length) {
      lines.push(`**On play:** ${opEffects.length} effect block(s) defined in the editor -- compiles to real C#, see Afflictions/${pascalCase(e.name || 'Untitled')}Affliction.cs`);
      opEffects.forEach((eff, i) => {
        const condN = (eff.conditions || []).length;
        const actN = (eff.actions || []).length;
        lines.push(`- Effect ${i + 1}: ${actN} action(s)${condN ? `, ${condN} condition(s)` : ''}`);
      });
      lines.push('');
    }

    const wp = e.whilePile || {};
    const wpEffects = Array.isArray(wp.effects) ? wp.effects : [];
    if (wpEffects.length) {
      lines.push(`**While waiting in a pile:** ${wpEffects.length} effect block(s) defined in the editor -- compiles to real C# (Round 200), gated by a real \`this.Card.Pile?.Type\` check, see Afflictions/${pascalCase(e.name || 'Untitled')}Affliction.cs`);
      wpEffects.forEach((eff, i) => {
        const actN = (eff.actions || []).length;
        lines.push(`- While in ${eff.pile || 'Hand'}, ${eff.trigger || '?'}: ${actN} action(s)`);
      });
      lines.push('');
    }

    // [Round 199/200] Additional Triggers -- same real hook vocabulary
    // Relics/Mechanics/Enchantments use. Previously captured but never
    // reported in this README generator.
    const additionalEffects = Array.isArray(e.effects) ? e.effects : [];
    if (additionalEffects.length) {
      lines.push(`**Additional triggers:** ${additionalEffects.length} effect block(s) defined in the editor -- compiles to real C#, see Afflictions/${pascalCase(e.name || 'Untitled')}Affliction.cs`);
      additionalEffects.forEach((eff, i) => {
        const actN = (eff.actions || []).length;
        lines.push(`- Trigger ${eff.trigger || '?'}: ${actN} action(s)`);
      });
      lines.push('');
    }

    lines.push('');
  });
  return lines.join('\n');
}

function buildOrbsReadme(orbs) {
  const lines = [];
  lines.push('# Orbs — the numbers are real, behavior isn\'t wired yet');
  lines.push('');
  lines.push('UPDATED: each orb below now ALSO compiles to a real');
  lines.push('`Orbs/<OrbName>Orb.cs` — reflect-baselib rounds 11/12 confirmed');
  lines.push('`BaseLib.Abstracts.CustomOrbModel`\'s real shape against a genuine working');
  lines.push('example, `TheBurdenedNewCharacter.Orbs.MoonOrb`. `PassiveVal`/`EvokeVal` are');
  lines.push('real, typed overrides now (from passiveValue/evokeValue below). What\'s NOT');
  lines.push('compiled: the passive/evoke TEXT below (what the orb actually DOES each turn');
  lines.push('or on evoke) — Forge has no effect editor for orb hooks yet, so `Passive()`/');
  lines.push('`Evoke()` aren\'t overridden in the generated class (see Orb.cs.template\'s');
  lines.push('header for the full reasoning). This file exists purely to keep that design');
  lines.push('intent readable — it is not read by the compiled mod at runtime.');
  lines.push('');
  orbs.forEach(o => {
    lines.push(`## ${o.name || 'Untitled'}`);
    lines.push('');
    if (o.description) { lines.push(o.description); lines.push(''); }
    if (o.passiveText) { lines.push('**Passive (each turn, while slotted) — NOT compiled:** ' + o.passiveText); lines.push(''); }
    if (o.evokeText) { lines.push('**Evoke (when passed out of the last slot) — NOT compiled:** ' + o.evokeText); lines.push(''); }
    const passiveValue = o.passiveValue !== undefined ? o.passiveValue : (o.baseValue || 0);
    const evokeValue = o.evokeValue !== undefined ? o.evokeValue : (o.baseValue || 0);
    lines.push(`**Compiled:** PassiveVal = ${passiveValue}, EvokeVal = ${evokeValue}${o.focusScales !== false ? ' (marked as scaling with Focus — NOT compiled, no confirmed mechanism yet)' : ' (marked as not scaling with Focus)'}`);
    lines.push('');
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Character art export.
//
// Tyler: "Lets make this fully functional before we move on... this is an
// essential feature that I would like to add to the scope." Every real
// asset path/property name referenced below is [VERIFIED] — found by
// running `strings -e l` (to catch .NET's UTF-16 string-literal heap)
// against Tyler's own two real compiled character mods
// (TheBurdenedNewCharacter.dll, TheTrainerNewCharacter.dll, both already
// used earlier for reflect-baselib), then confirming each candidate
// getter's exact literal string via a hand-rolled ECMA-335 metadata + IL
// disassembler (same technique used earlier this project to confirm the
// energy-counter layer count) — cross-checked on BOTH mods, not just one,
// since Tyler's Trainer character uses a different id/asset-name prefix
// throughout, so agreement between the two is real confirmation, not
// coincidence. Full trail in TOOLCHAIN_FINDINGS.md.
//
// UPDATED 2026-09-01: selectScreenBackgroundAssetRef is NO LONGER
// preview-only — see this function's own "Character-select background"
// section below for the full story (the old belief that it needed a real
// ANIMATED Godot scene was wrong; a real extracted example from Tyler's
// own TheBurdenedNewCharacter.pck showed it's just a static
// Control/TextureRect, which Forge can and now does generate).
//
// UPDATED 2026-09-04 (round 50): campfireArtAssetRef (the "Rest sprite")
// is ALSO no longer preview-only — see the "Rest site character scene"
// section below for the full real-IL trail (BaseLib.dll's own
// NRestSiteCharacterFactory.GenerateNode/TransferAndCreateNodes,
// disassembled directly) confirming exactly what real node structure the
// game needs, and two independently-extracted real, working reference
// scenes (vanilla Ironclad's own rest_site scene AND Tyler's own
// TheBurdenedNewCharacter mod's, both pulled straight from their real
// .pck files) confirming a flat PNG genuinely works there, no Spine rig
// needed — this closes the gap Round 27's addendum first flagged as
// theoretically possible but never wired up.
//
// shopSpriteAssetRef stays genuinely Spine-only (see round 27's addendum
// for the hard, structural IL evidence — NMerchantCharacter._Ready()'s
// unconditional `new MegaSprite(GetChild(0))` has no plain-sprite code
// path at all) — its own real export (round 47–49) is the
// synthesized-fake-Spine-rig technique, not a flat TextureRect like Rest
// site gets here.
//
// [Round 115] The standalone 256x256 "Portrait" field (portraitAssetRef)
// that used to live here was removed from the UI/schema entirely per
// Tyler: "lets remove portrait" — it never had a real getter OR filename
// convention in either disassembled DLL (every other character art field
// did), so it was never anything more than an unused design-time preview.
// See claude/round115-portrait-removed.md for the full history.

const ART_ID_PREFIX = 'images/packed/portraits/';
const ART_HAND_PREFIX = 'images/packed/hands/';
const ART_ENERGY_PREFIX = 'images/packed/energy_counters/';
// [Round 151] Mirrors the real folder convention seen in a genuine
// installed character mod's own compiled .pck (`res://audio/
// theburdenednewcharacter/<name>.pcm`) — same shape, real file extension
// instead of that mod's own unconfirmed raw-PCM convention (see
// writeCharacterSfx's own header comment for why).
const ART_AUDIO_PREFIX = 'audio/';
// [Round 198] Enchantment icon export -- real path convention confirmed
// via a real, working "STS2 Character Creator"-generated mod on Tyler's
// own machine (res://images/enchantments/theburdenednewcharacter_addedweight.png
// et al) -- see generateEnchantmentSource's own CustomIconPath wiring.
const ART_ENCHANTMENT_PREFIX = 'images/enchantments/';

// Real filename suffix per real BaseLib.Abstracts.CustomEnergyCounter arm
// texture getter [VERIFIED both DLLs]. Forge's own schema/state key is the
// short 'point' (see handArt in character.schema.json / blankState() in
// frontend/index.html) but the real file/property name is "Pointing" —
// this map bridges that one naming mismatch, nothing else.
const HAND_ART_REAL_SUFFIX = { point: 'pointing', rock: 'rock', paper: 'paper', scissors: 'scissors' };
const HAND_ART_REAL_GETTER = { point: 'CustomArmPointingTexturePath', rock: 'CustomArmRockTexturePath', paper: 'CustomArmPaperTexturePath', scissors: 'CustomArmScissorsTexturePath' };

function findAssetDataUrl(characterPackage, assetRef, kind) {
  if (!assetRef) return null;
  const asset = (characterPackage.assets || []).find(a => a && a.id === assetRef && a.kind === kind);
  return asset ? asset.dataUrl : null;
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

// Bundled default art shipped in frontend/assets/ — the same files the
// live Forge preview falls back to when a slot has no custom upload (see
// ORB_LAYER_DEFAULT_ASSETS / ORB_STAR_DEFAULT_ASSET in frontend/index.html).
// Read directly off disk here so an un-customized layer/star still exports
// something real (Tyler's own placeholder art) instead of nothing at all.
const FRONTEND_ASSETS_DIR = path.join(__dirname, '..', 'frontend', 'assets');
// [Round 119] Layer 1 ("Ring") paints ABOVE the two spin layers, not below
// them — full IL disassembly of BaseLib's NEnergyCounterFactory::
// FromLegacy/AddLayer (against Tyler's own updated
// TheBurdenedNewCharacter.dll) proved this. An opaque default there hid all
// spin animation — exactly the flat, non-animated orb Tyler reported
// in-game. The opaque shape moved to ORB_BACKDROP_SHAPE_FILE below.
//
// [Round 119 FOLLOW-UP] Tyler then pointed at slay.spencerstiles.com's own
// Energy Counter tool, which confirmed the same z-order AND "Unused layers
// stay transparent" — asked explicitly to match that ("Match the reference
// site — blank by default"). So the customLayers-mode fallback for every
// un-uploaded layer/backdrop is now the blank placeholder
// (ORB_LAYER_BLANK_FILE), not real shape art. The original shape files
// still exist and are still exported — but now only as the buildFromColor-
// mode fallback (ORB_LAYER_SHAPE_FILES/ORB_BACKDROP_SHAPE_FILE below),
// since that mode has no stored per-layer state to fall back on at all and
// needs a real silhouette to derive its auto-tinted colors from (matching
// Forge's own live preview — see renderEnergyPreview's ORB_BUILD_FROM_COLOR_SHAPES
// in frontend/index.html). Exporting blank there instead would ship a
// literally invisible orb for every buildFromColor character, a real
// regression — so that mode intentionally keeps the old shape-but-untinted
// fallback behavior.
const ORB_LAYER_BLANK_FILE = 'orb-layer-blank.png';
const ORB_LAYER_BUNDLED_FILES = [ORB_LAYER_BLANK_FILE, ORB_LAYER_BLANK_FILE, ORB_LAYER_BLANK_FILE, ORB_LAYER_BLANK_FILE, ORB_LAYER_BLANK_FILE];
const ORB_STAR_BUNDLED_FILE = 'orb-star.png';
// [Round 119, new] The real bottom-most piece of the orb, confirmed via a
// Harmony postfix (`EnergyBackdrop`) found in Tyler's own updated
// TheBurdenedNewCharacter.dll — see ForgeEnergyBackdrop.cs.template.
// customLayers-mode fallback is blank (see comment above); buildFromColor
// falls back to the real shape file instead — see ORB_BACKDROP_SHAPE_FILE.
const ORB_BACKDROP_BUNDLED_FILE = ORB_LAYER_BLANK_FILE;
// Real placeholder SHAPE art — buildFromColor-mode fallback ONLY (see
// comment above). Index 0 (Ring) has none: buildFromColor never rendered a
// Ring shape, even before this round (see frontend's
// ORB_BUILD_FROM_COLOR_SHAPES comment for why).
const ORB_LAYER_SHAPE_FILES = [null, 'orb-layer-spinA.png', 'orb-layer-spinB.png', 'orb-layer-middle.png', 'orb-layer-front.png'];
const ORB_BACKDROP_SHAPE_FILE = 'orb-layer-background.png';

// [Round 121] Sprite-sheet pose-animation ("Advanced" character/art
// section) — Tyler's round-95 spec: "There should be an option to add a
// sprite sheet for every possible pose in the game. If I attack, I should
// be able to upload a sprite sheet that shows a full attack animation. The
// FPS should be customizable, and the frame count should allow for as
// little as 1." Direct generalization of Tyler's own real, compiled,
// device-bridge-fetched reference implementation (TheBurdenedNewCharacter's
// Characters/TheBurdened.cs — idle 50 frames/9 FPS, attack 7 frames/9 FPS,
// via AnimationPlayer/AnimationLibrary/AtlasTexture frame-slicing) plus
// fresh direct sts2.dll/BaseLib.dll IL evidence gathered this round (see
// schema's character.poseSheets description for the full VERIFIED member
// list — Creature.GetCreatureNode(), NCreature.Visuals,
// CombatRoom.CombatState, CustomCharacterModel.CreateCustomVisuals(), and
// AbstractModel's real AfterCardPlayed/AfterDamageReceived/BeforeDeath/
// AfterCombatVictory virtuals that CharacterModel already inherits).
const POSE_SHEET_NAMES = ['idle', 'attack', 'heavyAttack', 'cast', 'hurt', 'death', 'victory'];
const POSE_SHEET_FILE_SUFFIX = { idle: 'idle', attack: 'attack', heavyAttack: 'heavy_attack', cast: 'cast', hurt: 'hurt', death: 'death', victory: 'victory' };
// Poses that should hold their final frame instead of auto-returning to
// idle once their (non-looping) animation finishes — direct port of
// TheBurdened.cs's own AnimationFinished handler ("Death stays on its
// final frame on purpose").
const POSE_SHEET_HOLD_LAST_FRAME = new Set(['death', 'victory']);

// Builds the CreateCustomVisuals() override + the 4 combat-hook overrides
// that drive it, when ANY character.poseSheets entry is uploaded. Returns
// null (meaning: caller should fall back to the existing static
// single-image creature_visuals scene, unchanged) only when NO pose sheet
// at all is uploaded — every character compiled before this round, and
// every character that simply never opens the Advanced section, keeps
// compiling exactly as before.
//
// [Round 121 follow-up] Tyler: "Lets just replace the idle sprite with
// the sprite sheet if they upload one. The other spritesheets should be
// ignored unless something is uploaded to them." Idle is no longer a
// prerequisite for the other six poses — each pose is fully independent.
// Uploading idle simply replaces the character's resting look (in place
// of the static Body sprite); the other poses, if uploaded, animate on
// their own triggers regardless of whether idle is set. `bodyUrl` (the
// character's existing Body sprite, already resolved by the caller) is
// passed in purely to serve as the resting-look fallback when idle isn't
// uploaded but some other pose is — see resolveBaseTexture below.
function generatePoseSheetVisuals(characterPackage, modIdLower, writeBinary, characterClassName, bodyUrl, combatSpriteScale) {
  const ch = characterPackage.character || {};
  const poseSheets = ch.poseSheets || {};
  // Defensive default (same 0.5-2 bounds writeCharacterArt already
  // resolves) — keeps this function safe to call directly (e.g. tests)
  // without threading the caller's own resolution through first.
  const sizeScale = (typeof combatSpriteScale === 'number' && combatSpriteScale >= 0.5 && combatSpriteScale <= 2) ? combatSpriteScale : 1;

  const report = [];
  const uploaded = {}; // poseName -> { rel, fps, frameCount, columns }
  for (const pose of POSE_SHEET_NAMES) {
    const entry = poseSheets[pose];
    const url = entry && findAssetDataUrl(characterPackage, entry.assetRef, 'poseSheet');
    if (!url) { report.push(`- Pose sheet (${pose}): not uploaded, skipped.`); continue; }
    const rel = `images/packed/sheets/${modIdLower}_${POSE_SHEET_FILE_SUFFIX[pose]}_sheet.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(url));
    const fps = (typeof entry.fps === 'number' && entry.fps >= 1) ? entry.fps : 12;
    const frameCount = (Number.isInteger(entry.frameCount) && entry.frameCount >= 1) ? entry.frameCount : 1;
    const columns = (Number.isInteger(entry.columns) && entry.columns >= 0) ? entry.columns : 0;
    uploaded[pose] = { rel, fps, frameCount, columns };
    report.push(`- Pose sheet (${pose}): exported to \`${rel}\` (${frameCount} frame${frameCount === 1 ? '' : 's'} @ ${fps} FPS${columns ? `, ${columns} column${columns === 1 ? '' : 's'}` : ''}), baked into the generated \`CreateCustomVisuals()\` AnimationPlayer below. [VERIFIED mechanism — direct port of TheBurdenedNewCharacter's own real, compiled TheBurdened.cs, round 121]`);
  }

  if (Object.keys(uploaded).length === 0) return null;

  // ---- Resting-look resolution (idle sheet > Body sprite > first
  // uploaded pose's own frame 0) — see this function's own header comment
  // above for why this exists now instead of a hard idle requirement. ----
  const idleUploaded = !!uploaded.idle;
  let bodyFallbackRel = null;
  if (!idleUploaded && bodyUrl) {
    bodyFallbackRel = `${ART_ID_PREFIX}${modIdLower}_creature.png`;
    writeBinary(`pack/${bodyFallbackRel}`, dataUrlToBuffer(bodyUrl));
    report.push(`- Resting look: no idle sheet uploaded — falling back to the existing Body sprite (\`${bodyFallbackRel}\`) as the character's static at-rest texture, per Tyler's "just replace the idle sprite with the sprite sheet if they upload one" (round 121 follow-up).`);
  }
  // Only reached when there's neither an idle sheet nor a Body sprite at
  // all, but at least one other pose is uploaded — [BEST EFFORT], a rare
  // edge case Tyler didn't specify directly: the first uploaded pose (in
  // POSE_SHEET_NAMES order) lends its own frame 0 as a static rest look,
  // purely so the character has SOME visible texture rather than none.
  const staticFallbackPose = (!idleUploaded && !bodyFallbackRel) ? POSE_SHEET_NAMES.find(p => uploaded[p]) : null;
  const baseVarName = idleUploaded ? 'idleSheet' : (bodyFallbackRel ? 'bodyFallbackSheet' : `${staticFallbackPose}Sheet`);
  const baseTextureExpr = idleUploaded
    ? `MakeAtlasFrame(idleSheet, 0, ${uploaded.idle.frameCount}, ${uploaded.idle.columns})`
    : (bodyFallbackRel ? 'bodyFallbackSheet' : `MakeAtlasFrame(${staticFallbackPose}Sheet, 0, ${uploaded[staticFallbackPose].frameCount}, ${uploaded[staticFallbackPose].columns})`);
  // Idle only auto-plays (and is returned to once a non-held pose
  // finishes) when it's actually uploaded — animPlayer.Play("idle") would
  // throw/no-op otherwise since no "idle" entry exists in animLib. When
  // idle isn't uploaded, a finished non-held pose instead snaps the
  // sprite straight back to the resolved resting texture (baseTextureExpr
  // above) rather than trying to play a pose that was never built.
  const initialPlayLine = idleUploaded ? '        animPlayer.Play("idle");' : '';
  const finishedAction = idleUploaded ? 'animPlayer.Play("idle");' : `sprite.Texture = ${baseTextureExpr};`;

  // ---- Per-pose Animation block, direct port of TheBurdened.cs's own
  // idle/attack blocks, generalized to any of the 7 poses. ----
  const animBlocks = POSE_SHEET_NAMES.filter(p => uploaded[p]).map(pose => {
    const u = uploaded[pose];
    const varSuffix = pose;
    const stepSec = 1 / u.fps;
    const length = u.frameCount * stepSec;
    const loopMode = pose === 'idle' ? 'Animation.LoopModeEnum.Linear' : 'Animation.LoopModeEnum.None';
    const keyLines = [];
    for (let i = 0; i < u.frameCount; i++) {
      keyLines.push(`                anim.TrackInsertKey(trackIdx, ${(i * stepSec).toFixed(6)}f, MakeAtlasFrame(${varSuffix}Sheet, ${i}, ${u.frameCount}, ${u.columns}));`);
    }
    return `
        // ${pose} spritesheet animation (${u.frameCount} frame${u.frameCount === 1 ? '' : 's'} @ ${u.fps} FPS)
        {
            var anim = new Animation();
            anim.Length = ${length.toFixed(6)}f;
            anim.LoopMode = ${loopMode};
            var trackIdx = anim.AddTrack(Animation.TrackType.Value);
            anim.TrackSetPath(trackIdx, "Sprite:texture");
            if (${varSuffix}Sheet != null)
            {
${keyLines.join('\n')}
            }
            // Per-pose scale normalization — fits THIS sheet's frame height to
            // the target so pose sheets authored at different heights render at
            // the same size. [VERIFIED, direct port of TheBurdened.cs]
            float _sheetH_${varSuffix} = (${varSuffix}Sheet?.GetHeight() ?? 512f) / ${Math.max(1, Math.ceil(u.frameCount / (u.columns || u.frameCount)))}f;
            float _sheetS_${varSuffix} = _sheetH_${varSuffix} > 0f ? (465.0f * _sizeScale) / _sheetH_${varSuffix} : _baseScale;
            var scaleIdx_${varSuffix} = anim.AddTrack(Animation.TrackType.Value);
            anim.TrackSetPath(scaleIdx_${varSuffix}, "Sprite:scale");
            anim.TrackInsertKey(scaleIdx_${varSuffix}, 0.0f, new Vector2(_sheetS_${varSuffix}, _sheetS_${varSuffix}));
            animLib.AddAnimation("${pose}", anim);
        }`;
  }).join('\n');

  const loadLines = POSE_SHEET_NAMES.filter(p => uploaded[p]).map(pose =>
    `        var ${pose}Sheet = LoadModTexture("res://${uploaded[pose].rel}");`
  ).join('\n') + (bodyFallbackRel ? `\n        var bodyFallbackSheet = LoadModTexture("res://${bodyFallbackRel}");` : '');

  const holdSet = POSE_SHEET_NAMES.filter(p => uploaded[p] && POSE_SHEET_HOLD_LAST_FRAME.has(p));
  const holdCheck = holdSet.length ? holdSet.map(p => `animName != "${p}"`).join(' && ') + ' && ' : '';

  const createCustomVisuals = `
    // ---- Pose-sheet animation (round 121) — [VERIFIED mechanism, direct
    // port of TheBurdenedNewCharacter's own real, compiled Characters/
    // TheBurdened.cs] Only generated because character.poseSheets.idle is
    // uploaded — every character without an idle pose sheet keeps the
    // existing static single-image creature_visuals .tscn scene instead
    // (see writeCharacterArt), completely unchanged.
    private static Texture2D? LoadModTexture(string path)
    {
        return ResourceLoader.Exists(path)
            ? ResourceLoader.Load<Texture2D>(path, null, ResourceLoader.CacheMode.Reuse)
            : null;
    }

    // columns <= 0 means the legacy single row (every frame on one line,
    // sheet height IS frame height). [VERIFIED, direct port of
    // TheBurdened.cs's own MakeAtlasFrame]
    private static AtlasTexture MakeAtlasFrame(Texture2D? sheet, int frameIdx, int totalFrames, int columns = 0)
    {
        var atlas = new AtlasTexture();
        if (sheet != null)
        {
            atlas.Atlas = sheet;
            int cols = columns > 0 ? columns : totalFrames;
            int rows = (totalFrames + cols - 1) / cols;
            float frameW = sheet.GetWidth() / (float)cols;
            float frameH = sheet.GetHeight() / (float)rows;
            atlas.Region = new Rect2((frameIdx % cols) * frameW, (frameIdx / cols) * frameH, frameW, frameH);
        }
        return atlas;
    }

    public override MegaCrit.Sts2.Core.Nodes.Combat.NCreatureVisuals? CreateCustomVisuals()
    {
        // [Round 122] Combat sprite size slider (character.combatSpriteScale)
        // — a plain multiplier baked in at compile time over the fixed
        // ~465px target height/offsets below. 1 = unchanged default size.
        float _sizeScale = ${sizeScale}f;
${loadLines}
        if (${baseVarName} == null)
            return base.CreateCustomVisuals();

        var cv = new MegaCrit.Sts2.Core.Nodes.Combat.NCreatureVisuals();
        cv.Name = "${characterClassName}";

        var formVfx = new Control();
        formVfx.Name = "FormVfx";
        formVfx.UniqueNameInOwner = true;
        formVfx.MouseFilter = Control.MouseFilterEnum.Ignore;
        cv.AddChild(formVfx);
        formVfx.Owner = cv;

        var visuals = new Node2D();
        visuals.Name = "Visuals";
        visuals.UniqueNameInOwner = true;
        cv.AddChild(visuals);
        visuals.Owner = cv;

        var sprite = new Sprite2D();
        sprite.Name = "Sprite";
        sprite.Texture = ${baseTextureExpr};
        // Scale so the character fills the standard creature bounds (~465 px
        // tall) regardless of source resolution. [VERIFIED, direct port of
        // TheBurdened.cs]
        float _texH = sprite.Texture?.GetHeight() ?? 512f;
        float _baseScale = (465.0f * _sizeScale) / _texH;
        float _baseY = -(_texH * _baseScale) / 2f + 0f;
        sprite.Position = new Vector2(0, _baseY);
        sprite.Scale = new Vector2(_baseScale, _baseScale);
        visuals.AddChild(sprite);
        sprite.Owner = cv;

        var animPlayer = new AnimationPlayer();
        animPlayer.Name = "AnimationPlayer";
        visuals.AddChild(animPlayer);
        animPlayer.Owner = cv;

        var animLib = new AnimationLibrary();
${animBlocks}

        animPlayer.AddAnimationLibrary("", animLib);
${initialPlayLine}
        // Return to idle (or, when idle isn't uploaded, back to the static
        // resting texture) when any non-held animation finishes. [VERIFIED
        // idle-present case is a direct port of TheBurdened.cs; the no-idle
        // fallback is new this round — round 121 follow-up]
        animPlayer.AnimationFinished += (animName) =>
        {
            if (${holdCheck}GodotObject.IsInstanceValid(animPlayer))
            {
                ${finishedAction}
            }
        };

        var bounds = new Control();
        bounds.Name = "Bounds";
        bounds.UniqueNameInOwner = true;
        bounds.OffsetLeft = -120f * _sizeScale;
        bounds.OffsetTop = (-465.0f * _sizeScale) + 0f;
        bounds.OffsetRight = 120f * _sizeScale;
        bounds.OffsetBottom = 0f;
        cv.AddChild(bounds);
        bounds.Owner = cv;

        var intentPos = new Marker2D();
        intentPos.Name = "IntentPos";
        intentPos.UniqueNameInOwner = true;
        intentPos.Position = new Vector2(0, -330 * _sizeScale);
        cv.AddChild(intentPos);
        intentPos.Owner = cv;

        var centerPos = new Marker2D();
        centerPos.Name = "CenterPos";
        centerPos.UniqueNameInOwner = true;
        centerPos.Position = new Vector2(0, -160 * _sizeScale);
        cv.AddChild(centerPos);
        centerPos.Owner = cv;

        var orbPos = new Marker2D();
        orbPos.Name = "OrbPos";
        orbPos.UniqueNameInOwner = true;
        orbPos.Position = new Vector2(-190f * _sizeScale, -560f * _sizeScale);
        cv.AddChild(orbPos);
        orbPos.Owner = cv;

        var talkPos = new Marker2D();
        talkPos.Name = "TalkPos";
        talkPos.UniqueNameInOwner = true;
        talkPos.Position = new Vector2(100 * _sizeScale, -280 * _sizeScale);
        cv.AddChild(talkPos);
        talkPos.Owner = cv;

        return cv;
    }

    // ---- Combat-hook-driven pose triggering (round 121) — [VERIFIED via
    // direct sts2.dll IL read] Creature.GetCreatureNode() -> NCreature (both
    // real, public) -> NCreature.Visuals (real, public property) -> this
    // same CreateCustomVisuals()'s own fixed "Visuals/AnimationPlayer" node
    // path. NCreature.SetAnimationTrigger (the base game's own animation-
    // trigger mechanism) was checked directly too and confirmed Spine-only
    // (a no-op whenever _spineAnimator is null, which it always is for this
    // plain-Sprite2D character) — this direct AnimationPlayer.Play() call is
    // the real, necessary mechanism, not a workaround. ShouldReceiveCombatHooks
    // is already unconditionally true above (pre-existing, every character),
    // so these overrides fire for real without any extra opt-in.
    private void PlayPose(MegaCrit.Sts2.Core.Entities.Creatures.Creature? creature, string pose)
    {
        try
        {
            var ncreature = creature?.GetCreatureNode();
            var animPlayer = ncreature?.Visuals?.GetNode<AnimationPlayer>("Visuals/AnimationPlayer");
            if (animPlayer != null && animPlayer.HasAnimation(pose))
            {
                animPlayer.Play(pose);
            }
        }
        catch (System.Exception ex)
        {
            GD.PrintErr($"[{GetType().Name}] Error in PlayPose({pose}): " + ex);
        }
    }

    // [BEST EFFORT, single-player scope — same known limitation every other
    // "Mine"-side hook in this codebase carries: !IsEnemy distinguishes a
    // player from a monster, not one multiplayer player's card play from
    // another's, so a multiplayer game could animate the wrong player's
    // character here. No established multiplayer-safe pattern exists
    // anywhere else in this codebase either.]
    public override System.Threading.Tasks.Task AfterCardPlayed(MegaCrit.Sts2.Core.GameActions.Multiplayer.PlayerChoiceContext choiceContext, MegaCrit.Sts2.Core.Entities.Cards.CardPlay cardPlay)
    {
        var creature = cardPlay.Player?.Creature;
        if (creature != null && !creature.IsEnemy)
        {
            if (cardPlay.Card.Type == CardType.Attack)
            {
                PlayPose(creature, cardPlay.Card is IHeavyAttackCard ? "heavyAttack" : "attack");
            }
            else
            {
                PlayPose(creature, "cast");
            }
        }
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public override System.Threading.Tasks.Task AfterDamageReceived(MegaCrit.Sts2.Core.GameActions.Multiplayer.PlayerChoiceContext choiceContext, MegaCrit.Sts2.Core.Entities.Creatures.Creature target, MegaCrit.Sts2.Core.Entities.Creatures.DamageResult result, MegaCrit.Sts2.Core.ValueProps.ValueProp props, MegaCrit.Sts2.Core.Entities.Creatures.Creature dealer, CardModel cardSource)
    {
        if (!target.IsEnemy) PlayPose(target, "hurt");
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public override System.Threading.Tasks.Task BeforeDeath(MegaCrit.Sts2.Core.Entities.Creatures.Creature creature)
    {
        if (!creature.IsEnemy) PlayPose(creature, "death");
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public override System.Threading.Tasks.Task AfterCombatVictory(MegaCrit.Sts2.Core.Rooms.CombatRoom room)
    {
        PlayPose(room?.CombatState?.Players?.FirstOrDefault()?.Creature, "victory");
        return System.Threading.Tasks.Task.CompletedTask;
    }
`;

  report.unshift(`- Combat creature sprite: pose-sheet animation ACTIVE — a real \`CreateCustomVisuals()\` override (AnimationPlayer/AnimationLibrary, AtlasTexture frame-slicing) replaces the static single-image scene, with ${Object.keys(uploaded).length} of 7 poses uploaded${sizeScale !== 1 ? `, sized at ${Math.round(sizeScale * 100)}% via combatSpriteScale` : ''}. [VERIFIED mechanism, round 121 — see character.poseSheets' schema description for the full IL evidence trail]`);

  return { overrideLines: [createCustomVisuals], report };
}

// [Round 151] Extension for an audio dataUrl, read off its own reported
// MIME type rather than assumed — a browser's <input type="file"> reports
// whatever the OS/browser itself thinks the file is (e.g. Chrome reports
// "audio/mpeg" for .mp3, "audio/wav" or "audio/x-wav" for .wav), so this
// covers the couple of real-world spellings seen for each rather than only
// the one MDN lists as canonical. Falls back to .wav (the more
// permissive/simpler of the two real formats this feature accepts) for
// anything unrecognized rather than refusing to export.
function sfxExtensionFromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)/i.exec(dataUrl || '');
  const mime = m ? m[1].toLowerCase() : '';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return 'mp3';
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave' || mime === 'audio/vnd.wave') return 'wav';
  return 'wav';
}

// ---- Character sound overrides -> CharacterSelectSfx / CustomDeathSfx ----
// [Round 151] See this function's call site in writeCharacterArt for the
// full evidence trail (both override points, and the BEST-EFFORT resource-
// format bet). Kept as its own small function rather than folded inline —
// unlike every image field above, this one has no fixed-dimension upload
// check to share, and keeping it separate makes the [BEST EFFORT] caveat
// easy to find in one place instead of scattered across two near-identical
// blocks.
function writeCharacterSfx(characterPackage, modIdLower, writeBinary, overrideLines) {
  const ch = characterPackage.character || {};
  const report = [];

  const selectUrl = findAssetDataUrl(characterPackage, ch.selectSfxAssetRef, 'selectSfx');
  if (selectUrl) {
    const ext = sfxExtensionFromDataUrl(selectUrl);
    const rel = `${ART_AUDIO_PREFIX}${modIdLower}/${modIdLower}_select.${ext}`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(selectUrl));
    overrideLines.push(`    public override string? CharacterSelectSfx => "res://${rel}"; // [VERIFIED override point — see claude/round151-custom-sound-feasibility-research.md; BEST EFFORT that a raw ${ext.toUpperCase()} file loads here with no separate Godot .import step, same bet every image override above already makes]`);
    report.push(`- Select screen sound: exported to \`${rel}\`, \`CharacterSelectSfx\` override added. [VERIFIED override point exists; BEST EFFORT that this exact raw-file convention is what it expects — test in-game]`);
  } else {
    report.push('- Select screen sound: not uploaded, skipped.');
  }

  const deathUrl = findAssetDataUrl(characterPackage, ch.deathSfxAssetRef, 'deathSfx');
  if (deathUrl) {
    const ext = sfxExtensionFromDataUrl(deathUrl);
    const rel = `${ART_AUDIO_PREFIX}${modIdLower}/${modIdLower}_death.${ext}`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(deathUrl));
    overrideLines.push(`    public override string? CustomDeathSfx => "res://${rel}"; // [VERIFIED override point — see claude/round151-custom-sound-feasibility-research.md; BEST EFFORT that a raw ${ext.toUpperCase()} file loads here with no separate Godot .import step, same bet every image override above already makes]`);
    report.push(`- Death sound: exported to \`${rel}\`, \`CustomDeathSfx\` override added. [VERIFIED override point exists; BEST EFFORT that this exact raw-file convention is what it expects — test in-game]`);
  } else {
    report.push('- Death sound: not uploaded, skipped.');
  }

  return report;
}

function writeCharacterArt(characterPackage, modIdLower, entrySlugLower, writeBinary, write, colorHex, namespace, characterClassName) {
  const ch = characterPackage.character || {};
  const overrideLines = [];
  const report = [];

  // [Round 122] Combat sprite size slider — Tyler: "is it possible to add
  // a slider to change the size of the sprite?" A plain multiplier on the
  // fixed 465px target height/offsets used by BOTH the pose-sheet
  // AnimationPlayer system and the legacy static creature_visuals scene
  // below — resolved once here so both branches use the same value.
  // Defaults to 1 (today's existing behavior, unchanged) whenever unset
  // or out of the validated 0.5-2 range.
  const combatSpriteScale = (typeof ch.combatSpriteScale === 'number' && ch.combatSpriteScale >= 0.5 && ch.combatSpriteScale <= 2)
    ? ch.combatSpriteScale
    : 1;

  // ---- Select screen art -> CustomCharacterSelectIconPath [VERIFIED] ----
  const selectArtUrl = findAssetDataUrl(characterPackage, ch.selectScreenArtAssetRef, 'selectScreenArt');
  if (selectArtUrl) {
    const rel = `${ART_ID_PREFIX}${modIdLower}_char_select.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(selectArtUrl));
    overrideLines.push(`    public override string CustomCharacterSelectIconPath => "res://${rel}"; // [VERIFIED getter name + path shape, both against your own real mods]`);
    report.push(`- Select screen art: exported to \`${rel}\`, \`CustomCharacterSelectIconPath\` override added. [VERIFIED]`);
  } else {
    report.push('- Select screen art: not uploaded, skipped.');
  }

  // ---- HUD icon -> CustomMapMarkerPath + CustomIconTexturePath [VERIFIED, both point at the same file] ----
  const hudUrl = findAssetDataUrl(characterPackage, ch.hudIconAssetRef, 'hudIcon');
  if (hudUrl) {
    const rel = `${ART_ID_PREFIX}${modIdLower}_hud_icon.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(hudUrl));
    overrideLines.push(`    public override string CustomMapMarkerPath => "res://${rel}"; // [VERIFIED]`);
    overrideLines.push(`    public override string CustomIconTexturePath => "res://${rel}"; // [VERIFIED — same file as CustomMapMarkerPath in both real mods checked]`);
    report.push(`- HUD icon: exported to \`${rel}\`, \`CustomMapMarkerPath\`/\`CustomIconTexturePath\` overrides added. [VERIFIED]`);
  } else {
    report.push('- HUD icon: not uploaded, skipped.');
  }

  // ---- Body sprite -> conventional "_creature.png" path, loaded by hand
  // inside CreateCustomVisuals() (below), not a static property override ----
  // [Round 96 — upgraded from BEST EFFORT to VERIFIED] TheBurdenedNewCharacter's
  // own decompiled Characters/TheBurdened.cs — a genuinely new, independent,
  // Forge-generated real example (see IStarIconCard.cs.template's header) —
  // loads its body texture via the EXACT same path convention this function
  // already uses (`LoadModTexture("res://images/packed/portraits/
  // theburdenednewcharacter_creature.png")`, inside its own real
  // CreateCustomVisuals() override), independently confirming both this
  // convention AND that CreateCustomVisuals() — not a static property — is
  // the real, correct place to consume it. ALSO the source art for a real
  // creature_visuals/{entry}.tscn scene (see below) -- see
  // TOOLCHAIN_FINDINGS.md "getting the character working for real" for the
  // full evidence trail.
  // [Round 121] Pose-sheet animation takes over the combat visuals entirely
  // whenever ANY character.poseSheets entry is uploaded — a real
  // CreateCustomVisuals() override supersedes the static single-image
  // scene below (which would otherwise fight with it over which one the
  // game actually loads). See generatePoseSheetVisuals's own header
  // comment for the full evidence trail, including the round-121-follow-up
  // resting-look fallback (idle sheet > this same Body sprite > first
  // uploaded pose's own frame 0) that replaced the earlier "idle required
  // first" rule. A character with NO pose sheets uploaded at all falls
  // straight through to the existing, unchanged static-scene behavior.
  const bodyUrl = findAssetDataUrl(characterPackage, ch.bodySpriteAssetRef, 'bodySprite');
  const poseVisuals = generatePoseSheetVisuals(characterPackage, modIdLower, writeBinary, characterClassName, bodyUrl, combatSpriteScale);
  if (poseVisuals) {
    overrideLines.push(...poseVisuals.overrideLines);
    report.push(...poseVisuals.report);
  } else if (bodyUrl) {
    const rel = `${ART_ID_PREFIX}${modIdLower}_creature.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(bodyUrl));
    report.push(`- Body sprite: exported to \`${rel}\`, consumed by the generated \`creature_visuals\` scene below${combatSpriteScale !== 1 ? ` at ${Math.round(combatSpriteScale * 100)}% size (character.combatSpriteScale)` : ''}. [VERIFIED, round 96 — this exact path convention AND its CreateCustomVisuals()-based consumption are independently confirmed via TheBurdenedNewCharacter's own real, shipped equivalent, which uses the identical filename convention.]`);

    // ---- Real combat creature_visuals scene [VERIFIED structurally,
    // 2026-09-02 -- see TOOLCHAIN_FINDINGS.md "getting the character
    // working for real"] ----
    // CharacterModel.CreateVisuals() loads 'creature_visuals/' + entry
    // (VisualsPath, a private property -- see
    // Generated/ForgeCreatureVisualsNullGuard.cs.template for the fuller
    // IL trail) and Instantiate<NCreatureVisuals>()s it. Real IL for
    // NCreatureVisuals._Ready() shows it looks up %Visuals/%Bounds/
    // %CenterPos/%IntentPos by unique name and determines HasSpineAnimation
    // purely by checking whether %Visuals' *runtime Godot class name*
    // equals "SpineSprite" (get_IsSpineNode, confirmed via IL) -- so a
    // plain Sprite2D %Visuals is a completely real, fully supported,
    // Spine-free shape: confirmed by extracting real base-game
    // creature_visuals scenes directly from SlayTheSpire2.pck --
    // crusher.tscn and fallback.tscn (the base game's OWN designated
    // fallback, see ForgeCreatureVisualsNullGuard) are BOTH plain
    // Sprite2D-based, no Spine at all, same four child nodes below. This
    // scene uses that exact real, working shape with your uploaded Body
    // sprite (bodySpriteAssetRef, enforced 512x512 transparent PNG) as
    // the texture.
    //
    // Getting Godot to actually export a scene that references a real
    // C# Script ext_resource (NCreatureVisuals.cs) required solving the
    // ".sln" export wall this project hit twice before (card-trail VFX,
    // then this same creature-visuals scene) -- see
    // backend/templates/PackProject.csproj.template's header comment and
    // TOOLCHAIN_FINDINGS.md for the full real-engine-source evidence
    // trail; that fix (pack/{{modName}}.csproj + .sln, written
    // unconditionally in generateProject()) is what makes this scene
    // exportable at all.
    //
    // Bounds/CenterPos/IntentPos below are [BEST EFFORT] placement, not
    // extracted from a real example (every real example is sized to its
    // own specific art) -- assumes your 512x512 upload's visible content
    // roughly fills the canvas and is meant to stand with its base near
    // the bottom, scaled to 256x256 on-screen (roughly comparable to
    // Nibbit/Crusher's real on-screen size) with its bottom edge at the
    // node's own origin (the real floor-contact point every other real
    // creature_visuals scene also anchors to). If the character looks
    // too big/small or mispositioned in a real screenshot, this is the
    // first thing to adjust -- the numbers below, not the mechanism.
    const creatureVisualsRel = `scenes/creature_visuals/${modIdLower}-${entrySlugLower}.tscn`;
    write(`pack/${creatureVisualsRel}`, [
      '[gd_scene load_steps=3 format=3]',
      '',
      '[ext_resource type="Script" path="res://src/Core/Nodes/Combat/NCreatureVisuals.cs" id="1_forge"]',
      `[ext_resource type="Texture2D" path="res://${rel}" id="2_forge"]`,
      '',
      '[node name="CreatureVisuals" type="Node2D"]',
      'script = ExtResource("1_forge")',
      'metadata/_edit_group_ = true',
      '',
      '[node name="Visuals" type="Sprite2D" parent="."]',
      'unique_name_in_owner = true',
      `position = Vector2(0, ${(-128 * combatSpriteScale).toFixed(4)})`,
      `scale = Vector2(${(0.5 * combatSpriteScale).toFixed(4)}, ${(0.5 * combatSpriteScale).toFixed(4)})`,
      'texture = ExtResource("2_forge")',
      '',
      '[node name="Bounds" type="Control" parent="."]',
      'unique_name_in_owner = true',
      'layout_mode = 3',
      'anchors_preset = 0',
      `offset_left = ${(-128 * combatSpriteScale).toFixed(4)}`,
      `offset_top = ${(-256 * combatSpriteScale).toFixed(4)}`,
      `offset_right = ${(128 * combatSpriteScale).toFixed(4)}`,
      'offset_bottom = 0.0',
      'mouse_filter = 2',
      '',
      '[node name="CenterPos" type="Marker2D" parent="."]',
      'unique_name_in_owner = true',
      `position = Vector2(0, ${(-128 * combatSpriteScale).toFixed(4)})`,
      '',
      '[node name="IntentPos" type="Marker2D" parent="."]',
      'unique_name_in_owner = true',
      `position = Vector2(0, ${(-316 * combatSpriteScale).toFixed(4)})`,
      '',
    ].join('\n'));
    // Real, single-newline-byte stub -- matches the base game's own
    // exported convention for this exact script (confirmed by extracting
    // it directly from SlayTheSpire2.pck in an earlier round). Real
    // behavior resolves via the base game's already-loaded assembly at
    // runtime, not this file's content.
    writeBinary('pack/src/Core/Nodes/Combat/NCreatureVisuals.cs', loadTemplateBinary('card_trail_assets/NCreatureVisuals.cs'));
    report.push(`- Combat creature sprite: a real \`creature_visuals/${modIdLower}-${entrySlugLower}.tscn\` scene is now generated, showing your Body sprite in combat (in place of the previous round's generic base-game "?" fallback). [BEST EFFORT placement -- see TOOLCHAIN_FINDINGS.md] The \`ForgeCreatureVisualsNullGuard.cs\` Harmony patch stays in place as a defensive backstop in case this real scene ever fails to load for any reason.`);
  } else {
    report.push('- Body sprite: not uploaded, skipped.');
    report.push('- Combat creature sprite: not exported (no Body sprite uploaded) -- your character will show the generic base-game "?" fallback in combat (see ForgeCreatureVisualsNullGuard.cs / TOOLCHAIN_FINDINGS.md). Upload a Body sprite to fix this.');
  }

  // ---- Star icon -> exported to a conventional path, and (round 96) now
  // REALLY ACTIVATED via a generated Harmony patch pair, not just exported
  // by naming convention and left inert. Previously this only wrote the PNG
  // — nothing in the compiled mod ever pointed at it, so an uploaded star
  // icon compiled but never actually appeared in-game. Tyler, this round:
  // "It does have an uploaded custom star icon, but it is not activated, so
  // we may not see it" — exactly this gap. Closed via a genuinely new
  // evidence source: TheBurdenedNewCharacter's own decompiled source turned
  // out to be Forge-generated itself (see IStarIconCard.cs.template's
  // header) — its Patches/TexturePatches.cs is a real, working, in-game-
  // proven example of the activation patches, not a guess. See
  // ForgeStarIconActivation.cs.template for the full mechanism (two Harmony
  // postfixes: one on NCard.UpdateStarCostVisuals for the on-card badge, one
  // on NStarCounter.Initialize/_Process for the HUD counter beside the
  // energy orb). ----
  if (ch.showEnergyStars) {
    const starUrl = findAssetDataUrl(characterPackage, ch.starAssetRef, 'star');
    const rel = `${ART_ID_PREFIX}${modIdLower}_star_icon.png`;
    let starBytes;
    if (starUrl) {
      starBytes = dataUrlToBuffer(starUrl);
    } else {
      starBytes = fs.readFileSync(path.join(FRONTEND_ASSETS_DIR, ORB_STAR_BUNDLED_FILE));
    }
    // [Round 119 follow-up] Same real-tint fix as the energy orb layers
    // above, same reason — this was previously flagged as a live-preview-
    // only effect purely because no image library was available server-
    // side; now baked for real via backend/lib/pngTint.js.
    let starBaked = false;
    if (ch.starColor) { starBytes = tintPngBuffer(starBytes, ch.starColor); starBaked = true; }
    writeBinary(`pack/${rel}`, starBytes);
    write('Generated/ForgeStarIconActivation.cs', fillTemplate(loadTemplate('ForgeStarIconActivation.cs.template'), {
      namespace,
      characterClassName,
      starIconPath: rel,
    }));
    const tintNote = starBaked ? ' Recolor tint is now BAKED into the exported PNG for real (Round 119).' : '';
    report.push(`- Star icon: exported to \`${rel}\` (${starUrl ? 'your uploaded image' : "Forge's bundled default star art"}) AND activated — \`Generated/ForgeStarIconActivation.cs\` now swaps it in for both the on-card star badge and the HUD star counter (previously exported but never wired up). [VERIFIED — direct port of TheBurdenedNewCharacter's own real, working Patches/TexturePatches.cs, round 96].${tintNote}`);
  } else {
    report.push('- Star icon: skipped ("Show energy stars" is off).');
  }

  // ---- Hand art x4 -> CustomArm{Paper,Pointing,Rock,Scissors}TexturePath [VERIFIED] ----
  const handArt = ch.handArt || {};
  const handExported = [];
  const handMissing = [];
  for (const pose of ['point', 'rock', 'paper', 'scissors']) {
    const url = findAssetDataUrl(characterPackage, handArt[pose], 'handArt');
    if (url) {
      const rel = `${ART_HAND_PREFIX}${modIdLower}_hand_${HAND_ART_REAL_SUFFIX[pose]}.png`;
      writeBinary(`pack/${rel}`, dataUrlToBuffer(url));
      overrideLines.push(`    public override string ${HAND_ART_REAL_GETTER[pose]} => "res://${rel}"; // [VERIFIED]`);
      handExported.push(pose);
    } else {
      handMissing.push(pose);
    }
  }
  if (handExported.length) {
    report.push(`- Hand art: exported ${handExported.length}/4 poses (${handExported.join(', ')})${handMissing.length ? `; not uploaded: ${handMissing.join(', ')}` : ''}. [VERIFIED overrides]`);
  } else {
    report.push('- Hand art: none of the 4 poses uploaded, skipped entirely.');
  }

  // ---- Energy orb layers x5 -> EnergyCounterLayerPath/CustomEnergyCounter [VERIFIED shape, BEST EFFORT colors] ----
  // orb.mode 'default' ("Use Ironclad default") means Tyler has no real art
  // configured at all for this character (Forge's own preview shows
  // nothing in that mode too) -- skip entirely rather than exporting 5
  // files that don't represent anything Tyler actually chose.
  if ((ch.orb && ch.orb.mode) !== 'default') {
    const orbMode = (ch.orb && ch.orb.mode) || 'customLayers';
    const layers = (ch.orb && ch.orb.layers) || [];
    // [Round 119 follow-up] Real server-side recolor. Tyler: his own
    // uploaded orb art showed up correctly but never changed to the
    // character's color. Root cause, confirmed via IL disassembly of
    // BaseLib.dll: CustomEnergyCounter's 2 real Color fields
    // (OutlineColor/BurstColor) don't retint layer art at all —
    // OutlineColor only recolors the thin ring outline
    // (EnergyCounterOutlineColorPatch.Prefix sets it as a `ref Godot.Color`
    // override) and BurstColor only recolors the particle burst VFX
    // modulate behind the orb (NEnergyCounterFactory.FromLegacy:
    // `EnergyVfxBack.Modulate = BurstColor`). Neither ever touches the 5
    // layer textures or the Backdrop — there is no real in-game mechanism
    // that retints layer art. So Forge's own per-layer "Recolor" tint (see
    // orb.layers[].color) was always a live-preview-only effect, same for
    // buildFromColor mode's auto-derived colors — this export previously
    // always wrote UNTINTED bytes regardless of what either mode showed.
    // Tyler explicitly asked for this to be baked in for real ("Bake
    // Forge's per-layer Recolor tint into the export") — see
    // backend/lib/pngTint.js for the small, dependency-free PNG
    // decode/tint/encode this uses (mirrors the live preview's CSS-mask
    // silhouette-fill exactly, alpha channel preserved).
    const buildFromColorAuto = orbMode === 'buildFromColor' ? autoLayerColors(colorHex) : null;
    // [Round 119, second follow-up] Matches renderEnergyPreview()'s
    // ORB_BUILD_FROM_COLOR_SHAPES tint choices exactly, Middle included
    // now: Tyler flagged the compiled orb as "missing a layer" because
    // Middle had been baked as a flat approximation of the live preview's
    // radial gradient. That gradient (light near 36%/32%, fading through
    // the base color to a dark shadow at the far edge — matches Tyler's
    // own "bottom half darker... top half lighter" and the reference art
    // in CharProject/Resources/Middle.png) is now rasterized for real via
    // tintPngBufferMiddleGradient (pngTint.js), so index 3 (Middle) is
    // handled separately from this flat-tint map below rather than
    // through it.
    const MIDDLE_LAYER_INDEX = 3; // ORB_LAYER_LABELS[3] === "Layer 4 — Middle"
    const buildFromColorLayerTint = buildFromColorAuto ? {
      1: buildFromColorAuto.spinA,
      2: buildFromColorAuto.spinB,
      4: buildFromColorAuto.front,
    } : null;
    let anyTinted = false;
    let anyBaked = false;
    for (let i = 0; i < 5; i++) {
      const layer = layers[i] || {};
      const customUrl = findAssetDataUrl(characterPackage, layer.assetRef, 'orbLayer');
      const rel = `${ART_ENERGY_PREFIX}${modIdLower}_layer_${i + 1}.png`;
      let bytes;
      if (customUrl) {
        bytes = dataUrlToBuffer(customUrl);
        if (layer.color) {
          // Middle (Layer 4) gets the same 2-tone radial gradient the live
          // preview shows for its Recolor toggle too — every other layer
          // keeps the flat silhouette-fill tint.
          bytes = i === MIDDLE_LAYER_INDEX ? tintPngBufferMiddleGradient(bytes, layer.color) : tintPngBuffer(bytes, layer.color);
          anyBaked = true;
        }
      } else {
        // [Round 119 follow-up] customLayers mode: blank (matches Tyler's
        // "match the reference site" call — un-uploaded stays transparent).
        // buildFromColor mode: falls back to the real shape file instead,
        // since that mode has no per-layer assetRef to ever be "uploaded"
        // and a blank fallback would export a literally invisible orb —
        // and now bakes that mode's own auto-derived tint into it too.
        const fallbackFile = (orbMode === 'buildFromColor' && ORB_LAYER_SHAPE_FILES[i]) ? ORB_LAYER_SHAPE_FILES[i] : ORB_LAYER_BLANK_FILE;
        bytes = fs.readFileSync(path.join(FRONTEND_ASSETS_DIR, fallbackFile));
        if (buildFromColorAuto) {
          if (i === MIDDLE_LAYER_INDEX) { bytes = tintPngBufferMiddleGradient(bytes, colorHex); anyBaked = true; }
          else if (buildFromColorLayerTint[i]) { bytes = tintPngBuffer(bytes, buildFromColorLayerTint[i]); anyBaked = true; }
        }
      }
      writeBinary(`pack/${rel}`, bytes);
      if (layer.color) anyTinted = true;
    }
    overrideLines.push('');
    overrideLines.push('    // [VERIFIED shape: a Func<int,string> + 2 Godot.Color args, from BaseLib.Abstracts.CustomEnergyCounter\'s real constructor,');
    overrideLines.push('    // confirmed via IL disassembly. [VERIFIED, round 119] the real semantic meaning of these 2 colors: OutlineColor recolors the');
    overrideLines.push('    // thin ring outline (EnergyCounterOutlineColorPatch), BurstColor recolors the particle burst VFX behind the orb (FromLegacy\'s');
    overrideLines.push('    // EnergyVfxBack.Modulate) — NEITHER retints the layer art itself, so layer recoloring is baked into the exported PNGs instead');
    overrideLines.push('    // (see writeCharacterArt\'s own comment above this block) rather than relying on these 2 colors to do it.');
    overrideLines.push('    // Return type is `CustomEnergyCounter?` (nullable), NOT `CustomEnergyCounter` — CS1715, a real build error caught 2026-08-27');
    overrideLines.push('    // (Tyler\'s own first real dotnet build against this round\'s work): the base `CustomCharacterModel.CustomEnergyCounter` member is');
    overrideLines.push('    // declared nullable, so an override must match exactly even though this always assigns a real, non-null value.');
    overrideLines.push(`    private string EnergyCounterLayerPath(int i) => $"res://${ART_ENERGY_PREFIX}${modIdLower}_layer_{i}.png";`);
    overrideLines.push(`    public override CustomEnergyCounter? CustomEnergyCounter => new CustomEnergyCounter(EnergyCounterLayerPath, new Color("${colorHex}"), new Color("${colorHex}"));`);
    report.push(`- Energy orb: exported all 5 layers (mode: ${ch.orb ? ch.orb.mode : 'customLayers'}), \`CustomEnergyCounter\`/\`EnergyCounterLayerPath\` overrides added. [VERIFIED shape]${anyBaked ? ' Recolor tint(s) are now BAKED into the exported PNGs for real (Round 119) — the outline/burst colors on CustomEnergyCounter never did this themselves (VERIFIED via IL: they only recolor the outline ring and burst VFX, not layer art).' : ''}${anyTinted && !anyBaked ? " NOTE: one or more layers has a recolor tint set in Forge, but the underlying image couldn't be decoded for baking (unsupported PNG format) — that layer's export is untinted." : ''}`);

    // ---- Energy orb Backdrop -> new Harmony patch [Round 119, VERIFIED] ----
    // This is the actual fix for Tyler's bug report ("The different spin
    // layers don't appear to be working either. We may have gotten the
    // layering wrong in the compile side."). The 5-layer CustomEnergyCounter
    // export above was always shape-correct, but the real game composites a
    // 6th piece — a true bottom-most "orb sphere" backdrop — via a separate
    // runtime mechanism that Forge never generated before this round. See
    // ForgeEnergyBackdrop.cs.template's header for the full disassembly.
    const backdropUrl = findAssetDataUrl(characterPackage, ch.orb && ch.orb.backdropAssetRef, 'orbBackdrop');
    const backdropRel = `${ART_ENERGY_PREFIX}${modIdLower}_backdrop.png`;
    let backdropBytes;
    if (backdropUrl) {
      backdropBytes = dataUrlToBuffer(backdropUrl);
      // The Backdrop has no recolor-tint field of its own (no color
      // parameter on the real EnergyBackdrop patch) EXCEPT in
      // buildFromColor mode, where it stands in for that mode's
      // "Background" role — bake the same derived tint a custom backdrop
      // upload would show in the live preview (see
      // renderEnergyPreview()'s buildFromColor branch).
      if (buildFromColorAuto) backdropBytes = tintPngBuffer(backdropBytes, buildFromColorAuto.background);
    } else {
      // Same customLayers-vs-buildFromColor fallback split as the 5 layers
      // above (Round 119 follow-up) — blank by default, real shape art
      // only for buildFromColor (no per-character backdropAssetRef ever
      // gets set in that mode, so blank there would export nothing).
      const backdropFallback = orbMode === 'buildFromColor' ? ORB_BACKDROP_SHAPE_FILE : ORB_BACKDROP_BUNDLED_FILE;
      backdropBytes = fs.readFileSync(path.join(FRONTEND_ASSETS_DIR, backdropFallback));
      if (buildFromColorAuto) backdropBytes = tintPngBuffer(backdropBytes, buildFromColorAuto.background);
    }
    writeBinary(`pack/${backdropRel}`, backdropBytes);
    write('Generated/ForgeEnergyBackdrop.cs', fillTemplate(loadTemplate('ForgeEnergyBackdrop.cs.template'), {
      namespace,
      characterClassName,
      backdropPath: backdropRel,
    }));
    report.push(`- Energy orb Backdrop: exported to \`${backdropRel}\` (${backdropUrl ? 'your uploaded image' : "Forge's bundled default backdrop art"}${buildFromColorAuto ? ', tinted to your character color' : ''}) AND activated via a new Harmony patch (\`Generated/ForgeEnergyBackdrop.cs\`) that inserts it as the bottom-most layer at runtime — this was the missing piece causing the flat/non-animated orb you saw in-game. [VERIFIED — direct port of TheBurdenedNewCharacter's own real EnergyBackdrop patch, round 119].`);

    // ---- Energy label outline color -> EnergyLabelOutlineColor [Round 119, VERIFIED, simple] ----
    // A small real override confirmed via IL on the same updated DLL:
    // `get_EnergyLabelOutlineColor` returns a plain Godot.Color. Easy,
    // well-evidenced addition alongside the rest of the orb fix.
    overrideLines.push(`    public override Color EnergyLabelOutlineColor => new Color("${colorHex}"); // [VERIFIED via IL, round 119]`);
    report.push(`- Energy label outline color: \`EnergyLabelOutlineColor\` override added (BEST EFFORT — set to your character's accent color; real semantic meaning of this field is unconfirmed beyond its type). [VERIFIED shape]`);
  } else {
    report.push('- Energy orb: skipped ("Use Ironclad default" selected — no real art configured to export).');
  }

  // ---- Character-select transition material -> res://materials/transitions/{modid}-{entry}_transition_mat.tres [VERIFIED via real sts2.dll IL disassembly, 2026-09-02] ----
  // NOT optional, NOT best-effort -- unconditional, every export, no upload
  // needed. CharacterModel.CharacterSelectTransitionPath (confirmed via IL:
  // AbstractModel..ctor -> ModelDb.GetId -> GetEntry -> StringHelper.Slugify)
  // is NOT virtual, so there is no C# override point -- the ONLY way to
  // satisfy it is a real resource file at this exact conventional path.
  //
  // [VERIFIED, superseding the previous CanvasItemMaterial fix] A plain
  // CanvasItemMaterial avoids the AssetLoadException crash on Embark, but
  // causes a DIFFERENT bug: a permanent black screen after entering the
  // first room. Root-caused via full IL disassembly of
  // MegaCrit.Sts2.Core.Nodes.NTransition.RoomFadeOut/RoomFadeIn (the real
  // methods called by RunManager.FadeOut/FadeIn around
  // RunManager.EnterRoomInternal -- confirmed as the actual call path for
  // a fresh singleplayer embark via NCharacterSelectScreen
  // .StartNewSingleplayerRun -> NGame.StartNewSingleplayerRun ->
  // RunManager.EnterRoomWithoutExitingCurrentRoom):
  //   - RoomFadeOut UNCONDITIONALLY sets _gradientTransition's
  //     Modulate.A = 1.0 (fully opaque), with no ShaderMaterial check at
  //     all -- this always runs, covering the screen.
  //   - RoomFadeIn casts this.Material to Godot.ShaderMaterial. When that
  //     cast fails (a CanvasItemMaterial is not a ShaderMaterial), it logs
  //     "NTransition.Material is null or not a ShaderMaterial (actual:
  //     CanvasItemMaterial). Skipping transition." (exactly the warning in
  //     Tyler's own godot.log) and returns immediately -- it only resets
  //     _simpleTransition's alpha back to 0 first; the line that resets
  //     _gradientTransition back to transparent is INSIDE the
  //     ShaderMaterial success branch and is never reached.
  //   - Net effect: _gradientTransition is left permanently opaque. Game
  //     logic keeps running fine underneath (Neow's dialogue plays, mouse
  //     moves) but the screen stays black forever -- matching Tyler's
  //     exact report ("i heard neow... but the screen stayed black").
  // The fix is to export a real Godot ShaderMaterial (with a minimal but
  // functional attached Shader defining the exact uniform the real game's
  // C# drives: NTransition._threshold is the StringName "threshold",
  // NTransition._thresholdTweenPath is the NodePath
  // "shader_parameter/threshold" -- both confirmed via direct IL
  // disassembly of NTransition's static constructor, which is the only
  // place these literals appear in the real game's own code, so a shader
  // uniform of any other name would still leave `isinst ShaderMaterial`
  // satisfied but SetShaderParameter/TweenProperty as silent no-ops).
  // format=3 confirmed empirically against a real .tscn pulled out of
  // Tyler's own TheBurdenedNewCharacter.pck (this exact game's Godot
  // build, 4.5.1, does use format=3 for its text resources).
  {
    const shaderRel = `materials/transitions/${modIdLower}-${entrySlugLower}_transition_shader.gdshader`;
    const matRel = `materials/transitions/${modIdLower}-${entrySlugLower}_transition_mat.tres`;
    write(`pack/${shaderRel}`, [
      'shader_type canvas_item;',
      '',
      '// [VERIFIED] uniform name must be exactly "threshold" -- this is the literal',
      '// string NTransition._threshold (a Godot.StringName) is initialized to in',
      '// the real game\'s own NTransition..cctor (sts2.dll IL, confirmed 2026-09-02).',
      '// 0.0 = fully revealed (transparent), 1.0 = fully covered (opaque black).',
      'uniform float threshold : hint_range(0.0, 1.0) = 0.0;',
      '',
      'void fragment() {',
      '\tCOLOR = vec4(0.0, 0.0, 0.0, threshold);',
      '}',
      '',
    ].join('\n'));
    write(`pack/${matRel}`, [
      '[gd_resource type="ShaderMaterial" load_steps=2 format=3]',
      '',
      `[ext_resource type="Shader" path="res://${shaderRel}" id="1"]`,
      '',
      '[resource]',
      'shader = ExtResource("1")',
      'shader_parameter/threshold = 0.0',
      '',
    ].join('\n'));
    report.push(`- Character-select transition material: exported to \`${matRel}\` as a real ShaderMaterial (with a minimal attached shader at \`${shaderRel}\` exposing the exact "threshold" uniform the real game drives) -- NOT a plain CanvasItemMaterial. [VERIFIED -- this one is mandatory, not tied to any upload. A CanvasItemMaterial avoids the earlier Embark crash but causes a *different*, silent bug: a permanent black screen after entering the first room, because NTransition.RoomFadeIn's ShaderMaterial check fails and it bails out before resetting the gradient-transition overlay's alpha back to transparent. See TOOLCHAIN_FINDINGS.md "still a black screen after Neow" for the full IL trail.]`);
  }


  // ---- Character-select "locked" icon -> res://images/packed/character_select/char_select_{modid}-{entry}_locked.png [VERIFIED naming convention via IL] ----
  // get_CharacterSelectLockedIconPath IS virtual on CharacterModel, but the
  // base (unoverridden) implementation just resolves this same
  // naming-convention path — so, same as the transition material, placing
  // a real file there satisfies it with no C# override needed. Reuses the
  // already-uploaded select-screen icon (same image, not a distinct
  // "silhouette" asset — no evidence a modded character's locked state is
  // ever actually shown in practice; TheBurdenedNewCharacter.pck itself
  // ships no locked icon at all and evidently doesn't need one, so this is
  // a low-stakes belt-and-suspenders export, not filling a proven gap).
  if (selectArtUrl) {
    const rel = `images/packed/character_select/char_select_${modIdLower}-${entrySlugLower}_locked.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(selectArtUrl));
    report.push(`- Character-select locked icon: exported to \`${rel}\` (same image as Select screen art) — [BEST EFFORT naming convention, VERIFIED via IL that this path is real] closes one more of the \`[ERROR] Failed to load resource synchronously\` lines seen in Tyler's log; not proven to matter in practice, but free to fix.`);
  } else {
    report.push('- Character-select locked icon: skipped (no Select screen art uploaded to reuse).');
  }

  // ---- Character-select background -> res://scenes/screens/char_select/char_select_bg_{modid}-{entry}.tscn [VERIFIED via real Godot pack extraction, 2026-09-01 — see TOOLCHAIN_FINDINGS.md] ----
  // Earlier rounds called this "permanently preview-only" on the belief
  // that the real game needs a full ANIMATED Godot scene here that Forge
  // has no way to author. That belief was WRONG, caught this round by
  // writing a minimal Godot .pck reader (tools/sts2tools had no pck reader
  // yet — see the one built this round) and extracting the REAL
  // char_select_bg_the_burdened.tscn + its .gd script straight out of
  // Tyler's own TheBurdenedNewCharacter.pck: it is NOT animated at all —
  // just a Control root with one child TextureRect, and a 3-line GDScript
  // that loads a flat PNG by hand via ResourceLoader.exists() (a graceful
  // no-op if missing, matching the "Using an empty background" fallback
  // already documented for when this is absent). CharacterModel's
  // [CORRECTED, round 96] The claim above that CharacterSelectBg is NOT
  // virtual, so this can only ever work by naming-convention placement, was
  // WRONG — a new evidence source (TheBurdenedNewCharacter's own decompiled
  // source, itself Forge-generated — see IStarIconCard.cs.template's header)
  // shows its real, shipped Characters/TheBurdened.cs unconditionally
  // overriding `public override string CustomCharacterSelectBg => "res://
  // scenes/screens/char_select/char_select_bg_the_burdened.tscn";` — a real,
  // compiling, in-game-proven override point on CustomCharacterModel/
  // PlaceholderCharacterModel that Forge had simply never added. Unlike the
  // Character icon scene below (independently confirmed via a real
  // godot.log fix to resolve correctly by naming convention ALONE, with no
  // override), this scene's discoverability by naming convention was never
  // itself runtime-tested — only its internal file structure was. Now
  // overridden explicitly (below, when uploaded) as a belt-and-suspenders
  // fix, matching the real working example exactly rather than leaving this
  // asset's actual load-path unconfirmed.
  const bgUrl = findAssetDataUrl(characterPackage, ch.selectScreenBackgroundAssetRef, 'selectScreenBackground');
  if (bgUrl) {
    const bgPngRel = `${ART_ID_PREFIX}${modIdLower}_bg.png`;
    writeBinary(`pack/${bgPngRel}`, dataUrlToBuffer(bgUrl));
    const gdRel = `scenes/screens/char_select/char_select_bg_${modIdLower}-${entrySlugLower}.gd`;
    const tscnRel = `scenes/screens/char_select/char_select_bg_${modIdLower}-${entrySlugLower}.tscn`;
    write(`pack/${gdRel}`, [
      'extends TextureRect',
      '',
      'func _ready():',
      `\tif ResourceLoader.exists("res://${bgPngRel}"):`,
      `\t\ttexture = load("res://${bgPngRel}")`,
      '',
    ].join('\n'));
    write(`pack/${tscnRel}`, [
      '[gd_scene load_steps=2 format=3]',
      '',
      `[ext_resource type="Script" path="res://${gdRel}" id="1"]`,
      '',
      '[node name="Bg" type="Control"]',
      'anchors_preset = 15',
      'anchor_right = 1.0',
      'anchor_bottom = 1.0',
      'grow_horizontal = 2',
      'grow_vertical = 2',
      '',
      '[node name="Background" type="TextureRect" parent="."]',
      'anchor_right = 1.0',
      'anchor_bottom = 1.0',
      'grow_horizontal = 2',
      'grow_vertical = 2',
      'expand_mode = 1',
      'stretch_mode = 6',
      'mouse_filter = 2',
      'script = ExtResource("1")',
      '',
    ].join('\n'));
    overrideLines.push(`    public override string CustomCharacterSelectBg => "res://${tscnRel}"; // [Fix, round 96] real, previously-missing override — see this function's own comment above for the corrected evidence trail`);
    report.push(`- Select screen background: exported to \`${bgPngRel}\` + a generated \`${tscnRel}\` scene (Control/TextureRect, same real shape confirmed against your own TheBurdenedNewCharacter mod's compiled .pck), AND (round 96) \`CustomCharacterSelectBg\` override added — previously this scene was written but never pointed to by any override, relying on an unconfirmed naming-convention resolution. [VERIFIED — this was previously marked permanently preview-only, which turned out to be wrong; the override itself is a round-96 fix on top of that, see TOOLCHAIN_FINDINGS.md.]`);
  } else {
    report.push('- Select screen background: not uploaded, skipped — falls back to the real game\'s own graceful "empty background" behavior (confirmed non-fatal).');
  }

  // ---- Character icon scene -> res://scenes/ui/character_icons/{modid}-{entry}_icon.tscn [VERIFIED via real sts2.dll IL + a real extracted example, 2026-09-02] ----
  // NOT optional — unconditional, every export, no upload strictly needed.
  // CharacterModel.IconPath (confirmed via IL: prefix 'ui/character_icons/'
  // + Id.Entry.ToLowerInvariant() + '_icon', through SceneHelper.GetScenePath)
  // is what's ACTUALLY behind Tyler's newest report ("got past character
  // select... did not load into the first scene properly, still a black
  // screen") — confirmed against his real godot.log: this exact path threw
  // the same AssetLoadException -> NullReferenceException -> aborted-run
  // pattern as the transition-material crash, just one asset later. Real,
  // working example pulled straight out of TheBurdenedNewCharacter.pck
  // (the_burdened_icon.tscn/.gd) — it's just a bare TextureRect with a
  // 3-line script loading their existing HUD icon PNG by hand. Reuses
  // Forge's own already-exported HUD icon (CustomMapMarkerPath's PNG) the
  // exact same way; falls back to the Select screen art PNG if no HUD icon
  // was uploaded, and to no texture at all (still a valid, loadable scene —
  // just shows nothing) if neither was uploaded, so this can never be the
  // reason a run fails to start regardless of what art Tyler's uploaded.
  {
    const iconPngRel = hudUrl ? `${ART_ID_PREFIX}${modIdLower}_hud_icon.png` : (selectArtUrl ? `${ART_ID_PREFIX}${modIdLower}_char_select.png` : null);
    const gdRel = `scenes/ui/character_icons/${modIdLower}-${entrySlugLower}_icon.gd`;
    const tscnRel = `scenes/ui/character_icons/${modIdLower}-${entrySlugLower}_icon.tscn`;
    write(`pack/${gdRel}`, [
      'extends TextureRect',
      '',
      'func _ready():',
      iconPngRel ? `\tif ResourceLoader.exists("res://${iconPngRel}"):` : '\tif false: # no HUD icon or Select screen art uploaded to reuse',
      iconPngRel ? `\t\ttexture = load("res://${iconPngRel}")` : '\t\tpass',
      '',
    ].join('\n'));
    write(`pack/${tscnRel}`, [
      '[gd_scene load_steps=2 format=3]',
      '',
      `[ext_resource type="Script" path="res://${gdRel}" id="1"]`,
      '',
      '[node name="Icon" type="TextureRect"]',
      'anchors_preset = 15',
      'anchor_right = 1.0',
      'anchor_bottom = 1.0',
      'grow_horizontal = 2',
      'grow_vertical = 2',
      'expand_mode = 1',
      'stretch_mode = 5',
      'mouse_filter = 2',
      'script = ExtResource("1")',
      '',
    ].join('\n'));
    // [Round 96 addition] The naming-convention placement above was already
    // independently confirmed working via a real godot.log fix (see this
    // block's own header comment) — no override was ever required. Added
    // anyway as defensive belt-and-suspenders: TheBurdenedNewCharacter's own
    // real, shipped TheBurdened.cs ALSO unconditionally overrides
    // `CustomIconPath` pointing at this exact same scene, on top of its own
    // (differently-named, but equally convention-based) file — matching the
    // real proven pattern exactly costs nothing and removes any future
    // dependence on the naming convention continuing to resolve correctly.
    overrideLines.push(`    public override string? CustomIconPath => "res://${tscnRel}"; // [Round 96] defensive override matching TheBurdenedNewCharacter's own real pattern — see comment above`);
    report.push(`- Character icon scene: exported to \`${tscnRel}\`${iconPngRel ? ` reusing \`${iconPngRel}\`` : ' (no HUD icon or Select screen art uploaded, so it loads no texture — still valid, just blank)'}, plus (round 96) an explicit \`CustomIconPath\` override as defensive belt-and-suspenders. [VERIFIED — this one is mandatory, same as the transition material; see TOOLCHAIN_FINDINGS.md "first scene black screen".]`);
  }

  // ---- Rest site / Merchant character scenes -> res://scenes/{rest_site,merchant}/characters/{modid}-{entry}_{rest_site,merchant}.tscn [DEFENSIVE, 2026-09-02] ----
  // CharacterModel.RestSiteAnimPath/MerchantAnimPath (the NON-virtual,
  // convention-path getters — "merchant/characters/" + entry.ToLower() +
  // "_merchant", confirmed via direct sts2.dll IL read) are a COMPLETELY
  // SEPARATE mechanism from CustomRestSiteAnimPath/CustomMerchantAnimPath
  // (the REAL, virtual override points BaseLib's CustomCharacterModel
  // declares — confirmed via direct BaseLib.dll IL read, default
  // implementation `ldnull; ret` — i.e. null unless overridden). Real mods
  // (TheBurdenedNewCharacter, the Alchemist) always override the latter;
  // Forge never did — this was a real, separate, and MORE FUNDAMENTAL gap
  // than "no real Spine rig", confirmed this round (round 36) by disassembling
  // BaseLib's own CustomCharacterModel.RegisterSceneConversions() directly:
  // it only calls `RegisterSceneForConversion<NMerchantCharacter>(path)` /
  // `RegisterSceneForConversion<NRestSiteCharacter>(path)` (matching the real
  // "[BaseLib] Registered scene ... for auto-conversion to NMerchantCharacter"
  // log line seen for TheBurdenedNewCharacter, and NEVER for TestChar) when
  // CustomMerchantAnimPath/CustomRestSiteAnimPath is non-null — with neither
  // ever overridden, NEITHER scene was ever registered for conversion at all,
  // for ANY Forge character, regardless of what file sits at the placeholder
  // path or what its root node type is. This is the REAL, confirmed cause of
  // the live `System.InvalidCastException: Unable to cast object of type
  // 'Godot.TextureRect' to type '...NMerchantCharacter'` Tyler hit in his own
  // log (his installed RitsuLib mod's own merchant-instantiation patch does
  // `PackedScene.Instantiate<NMerchantCharacter>()`, which can only ever
  // succeed on a scene BaseLib has already registered for that exact
  // conversion) — see TOOLCHAIN_FINDINGS.md "Round 36" for the full trail.
  //
  // [Fix, round 36] Both overrides now added, pointing at the same
  // placeholder `.tscn` this function already writes below. This closes the
  // registration gap for real — but is NOT by itself a complete, working
  // Rest sprite / Shop sprite: (1) Merchant still separately needs a real
  // (or synthesized-fake, per the round 27 second addendum's still-unproven
  // technique) Spine `SpineSprite` as its scene's first child —
  // `NMerchantCharacter._Ready()`'s own real IL does an unconditional
  // `new MegaSprite(GetChild(0))` with zero null/OfType guard (round 27,
  // [VERIFIED]), and this placeholder has no children at all, so reaching
  // the shop will likely still throw — just a DIFFERENT exception now (the
  // cast itself will succeed; GetChild(0) on an empty node is what fails
  // next). (2) Rest site's placeholder is ALSO still missing the real
  // required internal node structure round 27 already found and confirmed
  // fatal-shaped (`NRestSiteCharacter._Ready()`'s own `GetNode<T>("%Hitbox")`/
  // `"%ThoughtBubbleLeft"`/`"%ThoughtBubbleRight"`/`"ControlRoot"` calls,
  // needed regardless of art choice) — this placeholder is a bare
  // `TextureRect` with none of those. Registering the scene is a real,
  // necessary, and previously entirely-missing prerequisite either way —
  // just not sufficient alone for either scene to actually work yet.
  // ---- Merchant character scene -> blank placeholder [DEFENSIVE, still Spine-blocked, unchanged since round 36] ----
  {
    const rel = `scenes/merchant/characters/${modIdLower}-${entrySlugLower}_merchant.tscn`;
    write(`pack/${rel}`, [
      '[gd_scene load_steps=1 format=3]',
      '',
      '[node name="Placeholder" type="TextureRect"]',
      'anchors_preset = 15',
      'anchor_right = 1.0',
      'anchor_bottom = 1.0',
      'grow_horizontal = 2',
      'grow_vertical = 2',
      'mouse_filter = 2',
      '',
    ].join('\n'));
    overrideLines.push(`    public override string CustomMerchantAnimPath => "res://${rel}"; // [Fix, round 36] registers this scene with BaseLib's RegisterSceneConversions — see this function's own comment above for the full real evidence trail`);
    report.push(`- Merchant scene: a blank placeholder \`.tscn\` was generated at the real convention-based path, and (round 36) \`CustomMerchantAnimPath\` was overridden to point at it, closing the scene-registration gap. Still NOT a real Shop sprite — \`NMerchantCharacter._Ready()\`'s own unconditional \`new MegaSprite(GetChild(0))\` needs a real (or synthesized-fake, see round 47-49) Spine SpineSprite child specifically; a flat placeholder alone will fail there with a different exception. Use "Modify position/size" (shopSpriteResizable) for the real Shop sprite export — see round 47-49.`);
  }

  // ---- Rest site character scene -> REAL flat-PNG export [Fix, round 50] ----
  // Round 27's addendum already found Rest site needs no Spine rig
  // ([VERIFIED] IL: NRestSiteCharacter._Ready() -> GetChildSpineNodes()
  // just filters by native class name and no-ops when none match) — but
  // that was never wired into a real .tscn until now. The blank
  // placeholder this function used to write for BOTH rest_site and
  // merchant crashed the Rest site specifically: Tyler's own godot.log
  // (round 50) showed `[BaseLib] ControlRoot must be defined`/`%Hitbox
  // must be defined` warnings, then a fatal NullReferenceException inside
  // `NRestSiteCharacterFactory.GenerateNode`, then RitsuLib (one of
  // Tyler's own installed mods) silently falling back to
  // `ironclad_rest_site.tscn` — which is why Ironclad showed up instead
  // of Tyler's own character at the rest site.
  //
  // Real, exact requirement confirmed via direct IL disassembly of
  // BaseLib.dll (tools/sts2tools/il_dump.py against
  // NRestSiteCharacterFactory.GenerateNode/NodeFactory`1.TransferAndCreateNodes,
  // round 50): the factory looks up each of its 5 required unique-named
  // nodes (ControlRoot, %Hitbox, %ThoughtBubbleRight, %ThoughtBubbleLeft,
  // %SelectionReticle) independently via GetNodeOrNull — if %Hitbox is
  // genuinely missing ANYWHERE in the scene, resolving it (needed to
  // auto-generate the other three) throws immediately, exactly matching
  // the real crash. ControlRoot's absence is only ever WARNED about, never
  // fatal. If %Hitbox IS present, %ThoughtBubbleRight/%ThoughtBubbleLeft/
  // %SelectionReticle are auto-generated by BaseLib itself, positioned
  // relative to %Hitbox's own real Position/Size (confirmed via the exact
  // IL: new Control positioned at Hitbox.Position + Hitbox.Size * (0.8,
  // 0.2) or (0.2, 0.2); SelectionReticle instances the base game's own
  // real `res://scenes/ui/selection_reticle.tscn` and copies Hitbox's
  // Control properties onto it) — so this generator only needs to author
  // ControlRoot + a real, correctly-sized %Hitbox; the rest is free.
  // Independently cross-checked against TWO real, working reference
  // scenes extracted directly from their own real .pck files (round 50's
  // own hand-rolled pck reader, format v2/v3, verified against Godot's
  // real engine source): vanilla `ironclad_rest_site.tscn` (Spine-based,
  // but confirms the exact same ControlRoot/%Hitbox/%ThoughtBubbleLeft/
  // %ThoughtBubbleRight/%SelectionReticle shape) and Tyler's own installed
  // `TheBurdenedNewCharacter` mod's real `theburdenednewcharacter_rest_site
  // .tscn` (flat-PNG based, NOT Spine — the direct analog for Forge's own
  // case), which independently confirms a plain TextureRect "Sprite" child
  // works and uses a real, in-game-proven target height of 465px.
  //
  // character.restSpriteExportTransform (new field, round 50) is real
  // Godot pixel units {modelHeight, offsetX, offsetY} — same shape as
  // shopSpriteTransform — defaulting to {modelHeight:465, offsetX:0,
  // offsetY:0}, the exact real value TheBurdenedNewCharacter's own working
  // mod uses. campfireArtAssetRef is schema-enforced exactly 512x512, so
  // scale is always uniform (modelHeight / 512) and the rendered art is
  // always a square of side modelHeight, bottom-anchored at the node's
  // local origin (matching the same "ArtBottomCenter" convention already
  // proven for the Shop sprite). %Hitbox is sized to exactly match the
  // rendered art's own rect, so the auto-generated thought-bubble anchors
  // scale sensibly with it regardless of a character's specific art.
  //
  // [BEST EFFORT] on exact on-screen placement — 465px/centered/
  // bottom-anchored is a real, proven, in-game value from a different
  // character's own tuned scene, not independently re-measured against
  // Tyler's specific character; the existing restSpriteTransform preview
  // modal (round 28) still previews against the campfire PHOTO'S own
  // percentage space, a different coordinate system from this real
  // in-engine px transform, so it is a visual guide only, not a live
  // 1:1 mapping (same honest caveat Shop sprite carried from round 47
  // until round 49's real screenshot measurement — a future round could
  // do the same OpenCV recalibration here against a real rest-site
  // screenshot if Tyler wants live-accurate preview/editing).
  {
    const restUrl = findAssetDataUrl(characterPackage, ch.campfireArtAssetRef, 'campfireArt');
    const rt = (ch.restSpriteExportTransform && typeof ch.restSpriteExportTransform === 'object') ? ch.restSpriteExportTransform : {};
    const modelHeight = Number.isFinite(rt.modelHeight) ? rt.modelHeight : 465;
    const offsetX = Number.isFinite(rt.offsetX) ? rt.offsetX : 0;
    const offsetY = Number.isFinite(rt.offsetY) ? rt.offsetY : 0;
    const left = offsetX - modelHeight / 2;
    const right = offsetX + modelHeight / 2;
    const top = offsetY - modelHeight;
    const bottom = offsetY;
    const rel = `scenes/rest_site/characters/${modIdLower}-${entrySlugLower}_rest_site.tscn`;

    let artRel = null;
    if (restUrl) {
      artRel = `${ART_ID_PREFIX}${modIdLower}_rest_site.png`;
      writeBinary(`pack/${artRel}`, dataUrlToBuffer(restUrl));
    }

    const lines = [];
    lines.push(`[gd_scene load_steps=${artRel ? 2 : 1} format=3]`, '');
    if (artRel) lines.push(`[ext_resource type="Texture2D" path="res://${artRel}" id="1"]`, '');
    lines.push('[node name="RestSiteCharacter" type="Node2D"]', '');
    lines.push('[node name="Sprite" type="TextureRect" parent="."]');
    lines.push(`offset_left = ${left}`, `offset_top = ${top}`, `offset_right = ${right}`, `offset_bottom = ${bottom}`);
    lines.push('expand_mode = 1', 'stretch_mode = 5', 'mouse_filter = 2');
    if (artRel) lines.push('texture = ExtResource("1")');
    lines.push('', '[node name="ControlRoot" type="Control" parent="."]', '');
    lines.push('[node name="Hitbox" type="Control" parent="ControlRoot"]');
    lines.push('unique_name_in_owner = true');
    lines.push(`offset_left = ${left}`, `offset_top = ${top}`, `offset_right = ${right}`, `offset_bottom = ${bottom}`, '');
    write(`pack/${rel}`, lines.join('\n'));

    overrideLines.push(`    public override string CustomRestSiteAnimPath => "res://${rel}"; // [Fix, round 50] real flat-PNG rest-site scene — see this function's own comment above for the full IL + real-reference-scene evidence trail`);
    if (artRel) {
      report.push(`- Rest sprite: exported to \`${artRel}\`, wired into a real \`${rel}\` scene (ControlRoot/%Hitbox authored; %ThoughtBubbleLeft/%ThoughtBubbleRight/%SelectionReticle auto-generated by BaseLib itself from %Hitbox's real geometry — confirmed via direct IL of NRestSiteCharacterFactory) at modelHeight=${modelHeight}, offset=(${offsetX}, ${offsetY}). \`CustomRestSiteAnimPath\` override added. [VERIFIED mechanism — cross-checked against vanilla Ironclad's own real rest_site scene AND your own TheBurdenedNewCharacter mod's real rest_site scene, both extracted from their real .pck files, round 50] [BEST EFFORT placement — 465px/centered/bottom-anchored is a real, proven value from a different character, not yet measured against yours specifically; send a screenshot after your next rest-site visit if it needs a nudge].`);
    } else {
      report.push(`- Rest sprite: not uploaded — a real, structurally-complete (but textureless) \`${rel}\` scene is still generated so the rest site doesn't crash or fall back to another character; upload a Rest sprite (Forge UI, exactly 512x512) and re-export to make your own character actually appear.`);
    }
  }

  // ---- Card trail VFX crash [FIXED via a Harmony patch instead of a
  // bundled scene, 2026-09-02 -- see TOOLCHAIN_FINDINGS.md for the full
  // story of why the earlier bundled-scene approach was abandoned] ----
  // CharacterModel.TrailPath ('vfx/card_trail_' + entry, not virtual)
  // has no file at that path for a Forge character. NCardFlyVfx._Ready()
  // calls NCardTrailVfx.Create(card, characterTrailPath) with no
  // null-check on AssetCache.GetScene(...), which throws a real
  // NullReferenceException the moment a card is obtained/previewed (e.g.
  // Neow adding a card) -- confirmed via Tyler's own godot.log and direct
  // IL disassembly. That exception aborts _Ready() ENTIRELY, including
  // its own PlayAnim() call further down, leaving the card frozen on
  // screen forever.
  //
  // A first attempt bundled a real extracted card-trail scene (the base
  // game's own card_trail_ironclad.tscn) plus local copies of its 8
  // dependencies (2 scripts, a material, 5 placeholder textures) so
  // Godot's exporter could resolve it -- that got past the original
  // "Cannot open file" errors, but hit a deeper wall: any C#-script
  // ext_resource in this mod's isolated pack/ project makes Godot try to
  // "Export .NET Project," which requires a real .sln that doesn't exist
  // here (this mod's actual C# builds via a separate top-level
  // mod.csproj/dotnet build, not through Godot's own Mono export
  // pipeline) -- confirmed via a second real build failure. No other
  // real, shipped mod (checked TheBurdenedNewCharacter.pck directly) ever
  // references a .cs script from its own pack/ project at all, so this
  // isn't a supported pattern to force through.
  //
  // The actual fix is much simpler and doesn't touch Godot's export at
  // all: direct IL disassembly of NCardFlyVfx._Ready() shows it ALREADY
  // null-checks the result of NCardTrailVfx.Create() before adding it as
  // a child (`if (_vfx != null) AddChildSafely(...)`), then continues on
  // to its own animation setup and PlayAnim() regardless. The bug is
  // narrowly that Create() itself throws instead of returning null on a
  // missing scene. A small generated Harmony patch (ModEntry.cs already
  // bootstraps `new Harmony(...).PatchAll()`, so any [HarmonyPatch] class
  // anywhere in this mod's own assembly is picked up automatically, no
  // extra wiring needed) makes Create() return null gracefully when the
  // scene can't be found, letting _Ready()'s own existing defensive logic
  // do the rest -- the card flies to the deck and disappears correctly,
  // just without a decorative trail effect behind it. See
  // Generated/ForgeCardTrailNullGuard.cs.template and
  // TOOLCHAIN_FINDINGS.md for the full IL evidence trail.
  // [RESTORED, 2026-09-02 -- see TOOLCHAIN_FINDINGS.md "getting the
  // character working for real"] The bundled-scene approach above was
  // abandoned specifically because of the ".sln" export wall (see the
  // long comment above), NOT because the scene/dependency bundle itself
  // was wrong -- that part was already confirmed working back when this
  // was first built (see the very first Round 26 fix, "the compiler
  // exports too many files again"). Now that pack/{{modName}}.csproj +
  // .sln exist (see PackProject.csproj.template), Godot's exporter can
  // resolve the two real Script ext_resources this scene needs, so the
  // original real bundled scene is restored.
  const CARD_TRAIL_DEPS = [
    ['src/Core/Nodes/Vfx/NCardTrailVfx.cs', 'card_trail_assets/NCardTrailVfx.cs'],
    ['src/Core/Nodes/Vfx/NCardTrail.cs', 'card_trail_assets/NCardTrail.cs'],
    ['themes/canvas_item_material_additive_shared.tres', 'card_trail_assets/canvas_item_material_additive_shared.tres'],
    ['images/card_trail/trail.png', 'card_trail_assets/trail.png'],
    ['images/card_trail/trail2.png', 'card_trail_assets/trail2.png'],
    ['images/card_trail/brush_particle_2.png', 'card_trail_assets/brush_particle_2.png'],
    ['images/card_trail/small_card_silhouette.png', 'card_trail_assets/small_card_silhouette.png'],
    ['images/card_trail/sparkle.png', 'card_trail_assets/sparkle.png'],
  ];
  for (const [rel, templateName] of CARD_TRAIL_DEPS) {
    writeBinary(`pack/${rel}`, loadTemplateBinary(templateName));
  }
  const cardTrailRel = `scenes/vfx/card_trail_${modIdLower}-${entrySlugLower}.tscn`;
  write(`pack/${cardTrailRel}`, loadTemplate('card_trail_generic.tscn'));
  report.push(`- Card trail VFX: a real \`${cardTrailRel}\` scene is now generated (locally-authored placeholder trail/spark art -- see TOOLCHAIN_FINDINGS.md for why the real base-game art can't be redistributed) -- a card obtained mid-run now flies to the deck with a visible trail effect behind it. [BEST EFFORT art, VERIFIED mechanism] The \`ForgeCardTrailNullGuard.cs\` Harmony patch stays in place as a defensive backstop in case this real scene ever fails to load for any reason.`);


  // ---- Shop sprite -> a real synthesized fake-single-region Spine rig
  // [VERIFIED end to end via spine-shop-test2, rounds 40-46 — see
  // TOOLCHAIN_FINDINGS.md "Round 46"] Ports the technique first proposed
  // in round 27's second addendum, hand-built and iteratively fixed in
  // spine-shop-test2/SpineTest/SpineShopTest.cs through rounds 40-45, and
  // confirmed working end to end via a real godot.log
  // (is_skeleton_data_loaded() == true, no errors) plus Tyler's own
  // screenshot (round 45/46) — into real, per-character compiler.js
  // codegen. Generates a minimal Spine atlas + skeleton-JSON pair (a
  // single bone/slot/region attachment sized to the uploaded PNG's real
  // 512x512 dimensions — no live Spine software needed, same minimal
  // format round 27's addendum already worked out) plus a per-character
  // Harmony [HarmonyPrefix] on NMerchantCharacter._Ready()
  // (Generated/ForgeShopSpriteAttach.cs, a direct byte-for-byte port of
  // the already-proven SpineShopTestReadyPatch) that swaps the
  // placeholder scene's child for a real SpineSprite built from that rig.
  // CustomMerchantAnimPath (added round 36, above) still points at the
  // same blank placeholder .tscn — unchanged, still required for BaseLib
  // to register the scene for conversion at all; this prefix is what
  // fills that scene in once the game auto-converts it.
  //
  // [Round 48 — Tyler: "some users might not want to resize their sprite
  // in the shop. this should be an optional feature. it should only
  // apply the spine if the user intends to resize the shop sprite."]
  // Uploading a Shop sprite PNG is no longer, by itself, enough to
  // trigger this whole real-Spine-rig codegen path — it's gated behind
  // the separate, explicit ch.shopSpriteResizable opt-in (Forge UI:
  // "Make this sprite resizable/positionable in the shop" checkbox).
  // Uploaded-but-not-opted-in characters fall through to the plain
  // preview-only behavior every art field had before round 47 — no
  // atlas/skeleton/PNG under pack/spine_shop/, no
  // Generated/ForgeShopSpriteAttach.cs at all.
  const shopUrl = findAssetDataUrl(characterPackage, ch.shopSpriteAssetRef, 'shopSprite');
  if (shopUrl && ch.shopSpriteResizable) {
    const shopBaseName = `${modIdLower}-${entrySlugLower}_shop`;
    const shopDir = `spine_shop`;
    const pngRel = `${shopDir}/${shopBaseName}.png`;
    const atlasRel = `${shopDir}/${shopBaseName}.atlas`;
    const spjsonRel = `${shopDir}/${shopBaseName}.spjson`;
    writeBinary(`pack/${pngRel}`, dataUrlToBuffer(shopUrl));
    // A single bone/slot/region-attachment rig covering the entire
    // 512x512 upload — the exact same minimal shape as spine-shop-test2's
    // own hand-authored shop_test.atlas/.spjson (round 27's addendum),
    // now generated instead of hand-written. Godot's own export-filter
    // needs *.atlas/*.spjson explicitly include_filter'd (round 43/44's
    // finding, on spine-shop-test2's own separate hand-maintained
    // export_presets.cfg) — [Fix, round 47] applied the same
    // include_filter="*.atlas, *.spjson" to Forge's own real, generated
    // backend/templates/export_presets.cfg (previously include_filter=""
    // — the exact round-43 bug, just never hit before since Forge never
    // exported a real .atlas/.spjson pair until this round), so this
    // works for every future character with a Shop sprite uploaded, not
    // just the throwaway test rig.
    write(`pack/${atlasRel}`, [
      `${shopBaseName}.png`,
      'size: 512, 512',
      'format: RGBA8888',
      'filter: Linear, Linear',
      'repeat: none',
      shopBaseName,
      '  rotate: false',
      '  xy: 0, 0',
      '  size: 512, 512',
      '  orig: 512, 512',
      '  offset: 0, 0',
      '  index: -1',
      '',
    ].join('\n'));
    write(`pack/${spjsonRel}`, JSON.stringify({
      skeleton: { hash: shopBaseName, spine: '4.2.00', x: -256, y: -256, width: 512, height: 512, images: '', audio: '' },
      bones: [{ name: 'root' }],
      slots: [{ name: shopBaseName, bone: 'root', attachment: shopBaseName }],
      skins: [{ name: 'default', attachments: { [shopBaseName]: { [shopBaseName]: { type: 'region', width: 512, height: 512 } } } }],
      animations: { relaxed_loop: {} },
    }, null, 2));
    const t = (ch.shopSpriteTransform && typeof ch.shopSpriteTransform === 'object') ? ch.shopSpriteTransform : {};
    const modelHeight = Number.isFinite(t.modelHeight) ? t.modelHeight : 473;
    const offsetX = Number.isFinite(t.offsetX) ? t.offsetX : 0;
    const offsetY = Number.isFinite(t.offsetY) ? t.offsetY : 0;
    write('Generated/ForgeShopSpriteAttach.cs', fillTemplate(loadTemplate('ForgeShopSpriteAttach.cs.template'), {
      namespace,
      atlasResPath: atlasRel,
      skeletonResPath: spjsonRel,
      modelHeight: String(modelHeight),
      offsetX: String(offsetX),
      offsetY: String(offsetY),
    }));
    report.push(`- Shop sprite: exported to \`${pngRel}\`, plus a generated Spine atlas+skeleton pair (\`${atlasRel}\`/\`${spjsonRel}\`) and a per-character Harmony prefix (\`Generated/ForgeShopSpriteAttach.cs\`) that builds a real SpineSprite from them at scale/position modelHeight=${modelHeight}, offset=(${offsetX}, ${offsetY}). [VERIFIED mechanism — this exact technique is confirmed working end to end via spine-shop-test2, see TOOLCHAIN_FINDINGS.md "Round 46"] [BEST EFFORT placement if left at defaults — nudge shopSpriteTransform (Forge UI: "Modify position/size") and re-export if the model looks off in a real screenshot, same iterative process the real reference mod's own author used].`);
  } else if (shopUrl) {
    // [Round 112] Wording updated — the old opt-in checkbox is gone; this
    // now means the user uploaded a Shop sprite but never opened "Modify
    // position/size" (Forge sets shopSpriteResizable silently the moment
    // that modal is opened, see frontend/index.html's openShopSpriteModal).
    report.push('- Shop sprite: uploaded but NOT exported as a real in-game attachment — the "Modify position/size" editor was never opened, so it stays a Forge-UI preview only. A blank placeholder scene is still generated at the real convention path (see above) purely to avoid a crash. Open that editor and re-export if you want the real Spine rig + Harmony prefix (see the round 47 mechanism, above).');
  } else {
    report.push('- Shop sprite: not uploaded, skipped — a blank placeholder scene is still generated at the real convention path (see above) purely to avoid a crash.');
  }
  // [Fix, round 50] Removed here — stale/contradictory now that a real Rest
  // sprite scene IS exported above; its own report.push(...) call (in the
  // "Rest site character scene -> REAL flat-PNG export" block, above) covers
  // it accurately for both the uploaded and not-uploaded cases.

  // ---- Character sound overrides -> CharacterSelectSfx / CustomDeathSfx
  // [Round 151] Tyler: "lets add the ability to add custom 5 second wav or
  // mp3 files that overrides the base game sounds for the select screen,
  // being hit, dying, or winning." Investigated all 4; only 2 have a real,
  // confirmed override point on a playable character (see
  // claude/round151-custom-sound-feasibility-research.md for the full
  // evidence trail — being-hit/winning have no equivalent hook anywhere and
  // are not offered in the schema at all, not silently dropped here).
  //
  // [VERIFIED override points, both via a fresh ecma_dump.py read of the
  // real, current sts2.dll/BaseLib.dll — CharacterModel.CharacterSelectSfx
  // (virtual) and CustomCharacterModel.CustomDeathSfx (virtual), the latter
  // on the exact class Forge already extends, the former inherited into it
  // unchanged.] [BEST EFFORT resource format — every image asset in this
  // app already gets away with writing raw uploaded bytes straight into the
  // pack with no separate Godot .import step, and Godot's built-in runtime
  // loaders for WAV/OggVorbis/MP3 are expected to behave the same way for
  // audio, but that specific bet is UNTESTED against a real build. Uses the
  // dataUrl's own reported MIME type to pick the real file extension
  // (audio/wav -> .wav, audio/mpeg -> .mp3, anything else falls back to
  // .wav) rather than assuming one — see writeCharacterSfx below.]
  const sfxReport = writeCharacterSfx(characterPackage, modIdLower, writeBinary, overrideLines);
  report.push(...sfxReport);

  if (!overrideLines.length) overrideLines.push('    // No character art fields were uploaded — nothing to override. See README.md\'s "Character art" section.');

  return { overrides: overrideLines.join('\n'), report };
}

// ---- Resource bars anchored under the energy counter or health bar
// [BEST EFFORT — first real build of this feature, see
// claude/feature-backlog.md's "Resource bars anchored under the
// character's health bar" entry (Group B) and
// claude/round92-resource-bars.md for this round's own writeup] ----
//
// Generalizes the bar-drawing shape already proven real in Tyler's own
// installed mod (TheBurdenedNewCharacter's `Patches.ModStatusBarsPatch`,
// round 51/52 evidence) into a real, schema-driven Forge feature: up to
// MAX_RESOURCE_BARS bars, each tied to a chosen status/mechanic
// (character.resourceBars[].statusKind/builtinStatus/status, same 3-field
// vocabulary as amountScalesWithStatus/amountScalesWithBuiltinStatus
// elsewhere in this file), with its own max value and color, anchored
// either above the energy counter (default) or below the health bar.
// Round 53 first added this as a single character-wide setting
// (character.resourceBarAnchor); round 101 — Tyler: "the 'Resource bars
// anchor' section. Can we move that to the status section. Ideally i'd
// like to be able to set that per status." — moved it to a per-entry
// field (character.resourceBars[].anchor), so different bars can anchor
// to different places on the same character. See resolveBarAnchor()
// below for the exact fallback rule (an old project with only the
// character-wide value keeps working unchanged).
const MAX_RESOURCE_BARS = 3;
const RESOURCE_BAR_ANCHORS = ['EnergyCounter', 'HealthBar'];
function isNonEmptyStringRb(v) { return typeof v === 'string' && v.trim().length > 0; }

// Round 94 — resolves a resourceBars[] entry's status reference to its
// generated C# type name, same 3-field vocabulary (statusKind/builtinStatus/
// status) used by amountScalesWithStatus elsewhere in this file. Shared by
// both the standalone-bar path and the diamond-group path below so both
// throw the same clear error shape on an unknown reference.
function resolveBarTypeArg(b, pathLabel) {
  const isVanilla = b.statusKind === 'vanilla';
  const typeArg = isVanilla ? BUILTIN_POWER_CLASS_MAP[b.builtinStatus] : mechanicClassName(b.status);
  if (!typeArg) throw new Error(`${pathLabel} references unknown ${isVanilla ? `built-in status "${b.builtinStatus}"` : `status/mechanic "${b.status}"`}.`);
  return { isVanilla, typeArg };
}

// Round 101 — Tyler: "the 'Resource bars anchor' section. Can we move
// that to the status section. Ideally i'd like to be able to set that per
// status." Anchor moved from character.resourceBarAnchor (one value for
// every bar) to resourceBars[].anchor (one value per bar/diamond-group
// entry). resolveBarAnchor() is the single fallback rule shared by this
// function and the frontend (frontend/index.html has its own JS mirror of
// this same fallback, kept in sync by hand): an entry's own `anchor` wins
// if it's a real value; otherwise fall back to the character's old
// single-value `resourceBarAnchor` (so a project saved before round 101
// keeps behaving exactly as it did); otherwise default to 'HealthBar'.
//
// Round 102 — Tyler: "the character panel shouldnt have a anchor selector
// for statuses. they should all go below the health bar by default. Only
// custom statuses should be moveable." Default flipped from
// 'EnergyCounter' to 'HealthBar' (was round 101's own default before this
// round). The Character panel's own bar list (renderResourceBars in
// frontend/index.html) no longer shows an anchor picker at all — those
// entries just resolve through this same fallback and always land on
// 'HealthBar' unless the SAME underlying entry is also a mechanic-linked
// ("custom") bar that's been moved from ITS OWN per-status editor
// (renderMechBarFields), which still has the one remaining anchor picker.
function resolveBarAnchor(character, b) {
  if (RESOURCE_BAR_ANCHORS.includes(b.anchor)) return b.anchor;
  if (RESOURCE_BAR_ANCHORS.includes(character.resourceBarAnchor)) return character.resourceBarAnchor;
  return 'HealthBar';
}

function writeResourceBars(character, namespace, characterClassName, write) {
  const report = [];
  const rawBars = Array.isArray(character.resourceBars) ? character.resourceBars : [];
  const eligibleBars = rawBars
    .filter(b => b && b.enabled !== false)
    .filter(b => (b.statusKind === 'vanilla' ? isNonEmptyStringRb(b.builtinStatus) : isNonEmptyStringRb(b.status)))
    .filter(b => Number.isFinite(b.max) && b.max > 0);

  if (!eligibleBars.length) {
    report.push('- Resource bars: none configured — skipped entirely (no Generated/ForgeResourceBar*.cs files written).');
    return { report };
  }

  // Round 101 — a diamond group is one indivisible on-screen widget, so
  // every entry sharing a diamondGroup id must resolve to the same
  // anchor. Checked up front, across ALL eligible diamond entries
  // (before splitting by anchor below) so a mismatch gets one clear error
  // naming the group, instead of surfacing later as a confusing "missing
  // a left/right entry" once the mismatched entries land in different
  // anchor buckets.
  const diamondGroupAnchors = new Map();
  for (const b of eligibleBars) {
    if (b.layout !== 'diamond') continue;
    const gid = isNonEmptyStringRb(b.diamondGroup) ? b.diamondGroup : '__default__';
    const a = resolveBarAnchor(character, b);
    if (!diamondGroupAnchors.has(gid)) diamondGroupAnchors.set(gid, a);
    else if (diamondGroupAnchors.get(gid) !== a) {
      throw new Error(`character.resourceBars: diamond group "${gid}" has entries anchored to different places — all entries in a diamond group must share the same anchor.`);
    }
  }

  // Round 94 — split by layout. "diamond" entries are grouped by
  // diamondGroup below instead of being emitted as independent BarSpecs;
  // "standalone" (default, and anything with an unrecognized layout value)
  // keeps round 92's original one-bar-per-entry behavior. Round 101 —
  // additionally split by resolved anchor first, so each anchor gets its
  // own independent MAX_RESOURCE_BARS cap and its own bar-key numbering.
  function buildForAnchor(anchorName) {
    const standaloneBars = eligibleBars
      .filter(b => b.layout !== 'diamond' && resolveBarAnchor(character, b) === anchorName)
      .slice(0, MAX_RESOURCE_BARS);
    const diamondBars = eligibleBars.filter(b => b.layout === 'diamond' && resolveBarAnchor(character, b) === anchorName);

    const barSpecEntries = standaloneBars.map((b, i) => {
      const { isVanilla, typeArg } = resolveBarTypeArg(b, `character.resourceBars (${anchorName}) [${i}]`);
      const key = `Bar${i}`;
      const displayLabel = isNonEmptyStringRb(b.label) ? b.label : (isVanilla ? b.builtinStatus : typeArg.replace(/Power$/, ''));
      return `        new ForgeResourceBarSupport.BarSpec { Key = ${csharpStringLiteral(key)}, Label = ${csharpStringLiteral(displayLabel)}, Max = ${Math.round(b.max)}, Color = new Color(${csharpStringLiteral(b.color || '#3399ff')}), GetAmount = c => ForgeActions.GetStatusStacks<${typeArg}>(c), GetModel = c => c.GetPower<${typeArg}>() },`;
    }).join('\n');

    // Round 94 — group diamond-layout entries by diamondGroup, validate
    // each group has exactly one "left" and one "right" (an optional
    // "center" renders the diamond between them; without one it's just
    // two bars with no diamond), and emit one
    // ForgeResourceBarSupport.DiamondSpec per group.
    const groupsById = new Map();
    for (const b of diamondBars) {
      const gid = isNonEmptyStringRb(b.diamondGroup) ? b.diamondGroup : '__default__';
      if (!groupsById.has(gid)) groupsById.set(gid, []);
      groupsById.get(gid).push(b);
    }

    const diamondSpecEntries = Array.from(groupsById.entries()).map(([gid, entries]) => {
      const left = entries.find(b => b.diamondRole === 'left');
      const right = entries.find(b => b.diamondRole === 'right');
      const center = entries.find(b => b.diamondRole === 'center');
      if (!left) throw new Error(`character.resourceBars: diamond group "${gid}" is missing a "left" entry.`);
      if (!right) throw new Error(`character.resourceBars: diamond group "${gid}" is missing a "right" entry.`);

      const { typeArg: leftType } = resolveBarTypeArg(left, `character.resourceBars diamond group "${gid}" (left)`);
      const { typeArg: rightType } = resolveBarTypeArg(right, `character.resourceBars diamond group "${gid}" (right)`);
      const centerType = center ? resolveBarTypeArg(center, `character.resourceBars diamond group "${gid}" (center)`).typeArg : null;

      const fields = [
        `Key = ${csharpStringLiteral(gid)}`,
        `LeftColor = new Color(${csharpStringLiteral(left.color || '#3399ff')})`,
        `RightColor = new Color(${csharpStringLiteral(right.color || '#3399ff')})`,
        `HasCenter = ${center ? 'true' : 'false'}`,
        `LeftMax = ${Math.round(left.max)}`,
        `RightMax = ${Math.round(right.max)}`,
        `GetLeftAmount = c => ForgeActions.GetStatusStacks<${leftType}>(c)`,
        `GetRightAmount = c => ForgeActions.GetStatusStacks<${rightType}>(c)`,
        `GetLeftModel = c => c.GetPower<${leftType}>()`,
        `GetRightModel = c => c.GetPower<${rightType}>()`,
      ];
      if (center) {
        fields.push(`CenterColor = new Color(${csharpStringLiteral(center.color || '#3399ff')})`);
        fields.push(`CenterMax = ${Math.round(center.max)}`);
        fields.push(`GetCenterAmount = c => ForgeActions.GetStatusStacks<${centerType}>(c)`);
        fields.push(`GetCenterModel = c => c.GetPower<${centerType}>()`);
      }
      return `        new ForgeResourceBarSupport.DiamondSpec { ${fields.join(', ')} },`;
    }).join('\n');

    return { standaloneBars, groupsById, barSpecEntries, diamondSpecEntries };
  }

  const energy = buildForAnchor('EnergyCounter');
  const health = buildForAnchor('HealthBar');

  // Round 94b's "below health bar supports only 1 widget total" limit,
  // now checked against just the health-anchored subset.
  const healthWidgetCount = health.standaloneBars.length + health.groupsById.size;
  if (healthWidgetCount > 1) {
    throw new Error(`character.resourceBars: the "below health bar" anchor supports only 1 bar/diamond group total (found ${healthWidgetCount} anchored there).`);
  }

  if (!energy.standaloneBars.length && !energy.groupsById.size && !health.standaloneBars.length && !health.groupsById.size) {
    report.push('- Resource bars: none configured — skipped entirely (no Generated/ForgeResourceBar*.cs files written).');
    return { report };
  }

  write('Generated/ForgeResourceBarSupport.cs', fillTemplate(loadTemplate('ForgeResourceBarSupport.cs.template'), {
    namespace,
    energyBarSpecEntries: energy.barSpecEntries,
    energyDiamondSpecEntries: energy.diamondSpecEntries,
    healthBarSpecEntries: health.barSpecEntries,
    healthDiamondSpecEntries: health.diamondSpecEntries,
  }));

  // Round 101 — both anchor patch files can now be generated together
  // (one bar above the energy counter AND one below the health bar, at
  // the same time), where round 92-94b only ever generated one or the
  // other for the whole character.
  if (energy.standaloneBars.length || energy.groupsById.size) {
    write('Generated/ForgeResourceBarsEnergyAnchor.cs', fillTemplate(loadTemplate('ForgeResourceBarsEnergyAnchor.cs.template'), {
      namespace,
    }));
  }
  if (health.standaloneBars.length || health.groupsById.size) {
    write('Generated/ForgeResourceBarsHealthAnchor.cs', fillTemplate(loadTemplate('ForgeResourceBarsHealthAnchor.cs.template'), {
      namespace,
      characterClassFull: `${namespace}.Characters.${characterClassName}`,
    }));
  }

  const parts = [];
  if (energy.standaloneBars.length || energy.groupsById.size) {
    parts.push(`${energy.standaloneBars.length} standalone bar(s) + ${energy.groupsById.size} diamond group(s) above the energy counter (\`Generated/ForgeResourceBarsEnergyAnchor.cs\`)`);
  }
  if (health.standaloneBars.length || health.groupsById.size) {
    parts.push(`${health.standaloneBars.length} standalone bar(s) + ${health.groupsById.size} diamond group(s) below the health bar (\`Generated/ForgeResourceBarsHealthAnchor.cs\`, 1 widget max there)`);
  }
  report.push(`- Resource bars: ${parts.join('; ')} (\`Generated/ForgeResourceBarSupport.cs\`). [BEST EFFORT — first real build of this feature, see claude/round92-resource-bars.md and claude/round94-hidden-status-tooltip-fix.md] standalone-bar mechanism ported from Tyler's own installed TheBurdenedNewCharacter mod's real \`ModStatusBarsPatch\` (round 51/52 evidence); diamond-group mechanism reproduces that same mod's real dual-bar+diamond widget shape (round 93/94 evidence); anchor now set per status (round 101) rather than once for the whole character, not yet exercised through a real \`dotnet build\`.`);

  return { report };
}

// ---- Per-card portrait art -> CustomPortraitPath [VERIFIED via decompiling
// TheBurdenedNewCharacter.dll, confirmed against its real uncompiled source —
// round 16, Tyler's own full mod source + a full clone of BaseLib-StS2] ----
//
// All 71 of Tyler's own real cards were found overriding BOTH
// `CardModel.PortraitPath` (a Godot .tres atlas-sprite resource path) AND
// `CustomCardModel.CustomPortraitPath` (the actual .png) with the SAME
// visual, at res://images/packed/card_portraits/<modIdLower>/<cardIdLower>.png
// -shaped paths — directly parallel to the already-working character-art
// pattern above (writeCharacterArt/ART_ID_PREFIX). BaseLib's own
// Abstracts/CustomCardModel.cs source confirms both are real, publicly
// overridable members (`CustomPortraitPath` is a real `virtual string?`
// property), Harmony-patched via a `CustomCardPortraitPngPath` class hooking
// `CardModel.PortraitPngPath` — this is the confirmed real PNG-loading path,
// so Forge only needs to emit ONE override (CustomPortraitPath), not
// hand-author a fake .tres atlas-sprite resource it has no pipeline to
// generate for real.
const ART_CARD_PREFIX = 'images/packed/card_portraits/';

function writeCardArt(card, characterPackage, modIdLower, writeBinary) {
  const url = findAssetDataUrl(characterPackage, card.artAssetRef, 'cardArt');
  if (!url) return { override: '', reportLine: null };

  const cardIdLower = (card.id || card.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rel = `${ART_CARD_PREFIX}${modIdLower}/${cardIdLower}.png`;
  writeBinary(`pack/${rel}`, dataUrlToBuffer(url));
  const override = `\n\n    // [VERIFIED via decompiling TheBurdenedNewCharacter.dll — confirmed at scale across all 71 real cards, all using this exact PNG-path override] card portrait art.\n    public override string? CustomPortraitPath => "res://${rel}";`;
  return { override, reportLine: `- ${card.name}: card art exported to \`${rel}\`, \`CustomPortraitPath\` override added. [VERIFIED]` };
}

// ---- Relic icon -> PackedIconPath override [VERIFIED via direct ECMA-335
// IL disassembly of the real installed sts2.dll, done specifically for
// Tyler's "relics need to be able to have a 256x256px icon added to them"
// request] ----
//
// RelicModel.get_Icon() (Texture2D, NOT virtual itself) does exactly two
// things: `callvirt RelicModel::get_PackedIconPath()` (a VIRTUAL call —
// confirmed via IL, unlike EpochModel.Portrait's non-virtual getter that
// needed a Harmony patch in Round 203), then passes that string straight
// into `Godot.ResourceLoader.Load<Texture2D>(path, null, cacheMode)`
// (MemberRef#562 in the raw metadata table — il_dump.py's own
// typedef_or_ref_name() has a gap where a MethodSpec's base method is
// itself a MemberRef, so it printed the unresolved "MemberRef#562"
// placeholder instead of a name; resolved by hand by calling
// reader.memberref_name(562) directly, which returned the real name).
// ResourceLoader.Load is Godot's generic, format-agnostic resource
// loader — it works on any resolvable resource path, not just a `.tres`
// atlas-sprite entry, so there is no atlas-format gate to work around.
// Because PackedIconPath is virtual and reached via callvirt, a generated
// relic subclass can simply override it to point at a raw PNG — the same
// "override one real virtual property, no Harmony patch" shape as
// writeCardArt's CustomPortraitPath above, and simpler than Round 203's
// Epoch portrait (which needed a Harmony patch specifically because
// EpochModel.Portrait ISN'T virtual).
const RELIC_ICON_PREFIX = 'images/packed/relic_icons/';

function writeRelicIcon(relic, characterPackage, modIdLower, writeBinary) {
  const url = findAssetDataUrl(characterPackage, relic.iconAssetRef, 'relicIcon');
  if (!url) return { override: '', reportLine: null };

  const relicIdLower = (relic.id || relic.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rel = `${RELIC_ICON_PREFIX}${modIdLower}/${relicIdLower}.png`;
  writeBinary(`pack/${rel}`, dataUrlToBuffer(url));
  const override = `\n    // [VERIFIED via direct ECMA-335 IL disassembly of the real installed sts2.dll — RelicModel.get_Icon() calls the VIRTUAL get_PackedIconPath() via callvirt, then Godot.ResourceLoader.Load<Texture2D> on whatever path it returns, no atlas-format gate] relic icon art.\n    public override string PackedIconPath => "res://${rel}";`;
  return { override, reportLine: `- ${relic.name}: relic icon exported to \`${rel}\`, \`PackedIconPath\` override added. [VERIFIED]` };
}

// [Round 229] Mechanic (custom power/status) icon export — same
// write-PNG-then-splice-override shape as writeRelicIcon just above, but
// the override point itself is different: CustomPackedIconPath (not
// PackedIconPath), consumed through a Harmony patch rather than a direct
// virtual call — see generateMechanicSource's own header comment for the
// full IL evidence trail (BaseLib.Abstracts.PackedIconPath::Custom +
// CustomPowerModel : ICustomPower, both confirmed via direct
// ECMA-335 disassembly of the real installed BaseLib.dll). The exported
// PNG still flows through the exact same Godot.ResourceLoader.Load<Texture2D>
// call the vanilla path uses (PowerModel.get_Icon(), see writeRelicIcon's
// header) — only the getter that supplies the path differs, not how the
// path is ultimately loaded — so a plain PNG at a res:// path works here
// exactly like it does for relics and enchantments.
//
// Folder convention (images/packed/power_icons/) is [BEST EFFORT] — chosen
// to mirror the sibling images/packed/relic_icons/ convention (nested
// modId/id folder, same as relics) since no shipped real mod with a
// custom power icon has been found yet to confirm an exact real
// convention the way enchantment icons' path was confirmed against
// Tyler's own installed reference mod (round 198). This is safe either
// way: the res:// string here is whatever WE choose to export the PNG
// under and then point CustomPackedIconPath at — nothing about the real
// game constrains that folder name, only that a loadable resource exists
// at the path we write.
const MECHANIC_ICON_PREFIX = 'images/packed/power_icons/';

function writeMechanicIcon(mechanic, characterPackage, modIdLower, writeBinary) {
  const url = findAssetDataUrl(characterPackage, mechanic.iconAssetRef, 'mechanicIcon');
  if (!url) return { override: '', reportLine: null };

  const mechIdLower = (mechanic.id || mechanic.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rel = `${MECHANIC_ICON_PREFIX}${modIdLower}/${mechIdLower}.png`;
  writeBinary(`pack/${rel}`, dataUrlToBuffer(url));
  const override = `\n    // [VERIFIED via direct ECMA-335 IL disassembly of the real installed sts2.dll + BaseLib.dll, round 229 — CustomPowerModel implements BaseLib.Abstracts.ICustomPower (confirmed via BaseLib.dll's InterfaceImpl metadata table), and the real Harmony patch BaseLib.Abstracts.PackedIconPath::Custom calls ICustomPower.CustomPackedIconPath through this exact override point] mechanic/status icon art.\n    public override string CustomPackedIconPath => "res://${rel}";`;
  return { override, reportLine: `- ${mechanic.name}: mechanic icon exported to \`${rel}\`, \`CustomPackedIconPath\` override added. [VERIFIED]` };
}

// [Round 203 — Tyler: "change the name of lore to 'Chronicles'. Chronicles
// are a collection of items called 'Epochs'."] MegaCrit.Sts2.Core.Timeline.
// EpochEra — [VERIFIED via direct fields_dump2.py read of the real
// installed sts2.dll: 26 named literal members + the enum's own value__
// field]. Exact real int values (not used here, just documented for
// evidence): Prehistoria0=-20000..Prehistoria2=-19998, Seeds0=0..Seeds3=3,
// Blight0=1201..Blight2=1203, Flourish0=1800..Flourish3=1803,
// Invitation0=2733..Invitation7=2740, Peace0=3000..Peace1=3001,
// FarFuture0=10000..FarFuture1=10001. Matches Tyler's own 3 uploaded
// screenshots of the in-game Era dropdown exactly, 26-for-26.
const EPOCH_ERAS = [
  'Prehistoria0', 'Prehistoria1', 'Prehistoria2',
  'Seeds0', 'Seeds1', 'Seeds2', 'Seeds3',
  'Blight0', 'Blight1', 'Blight2',
  'Flourish0', 'Flourish1', 'Flourish2', 'Flourish3',
  'Invitation0', 'Invitation1', 'Invitation2', 'Invitation3', 'Invitation4', 'Invitation5', 'Invitation6', 'Invitation7',
  'Peace0', 'Peace1',
  'FarFuture0', 'FarFuture1',
];

// [VERIFIED via direct IL disassembly of EpochModel::get_RealPortraitPath /
// get_PackedPortraitPath in the real sts2.dll, AND independently confirmed
// by strings-dumping the reference mod's .pck] An epoch portrait's real
// convention path is `images/timeline/epoch_portraits/<id-lowercased>.png`
// — NOT `<modid>_<epochid>.png` like card art; the epoch's OWN Id (already
// mod-prefixed, see generateEpochSource) is the entire filename once
// lowercased. EpochModel.Portrait's own DEFAULT getter loads from a
// vanilla sprite atlas that never contains a mod's custom ids though, so
// this path alone isn't enough — see ChronicleProgress.cs.template's
// ChroniclePortrait Harmony patch (real IL-confirmed necessity, not a
// guess) for the other half of this.
const EPOCH_PORTRAIT_PREFIX = 'images/timeline/epoch_portraits/';

function writeEpochPortrait(epoch, epochId, characterPackage, writeBinary) {
  const url = findAssetDataUrl(characterPackage, epoch.imageAssetRef, 'epochPortrait');
  if (!url) return null;
  const rel = `${EPOCH_PORTRAIT_PREFIX}${epochId.toLowerCase()}.png`;
  writeBinary(`pack/${rel}`, dataUrlToBuffer(url));
  return rel;
}

// [VERIFIED via direct IL disassembly of ChronicleProgress.Evaluate in
// Tyler's own updated TheBurdenedNewCharacter.dll v3 — see
// ChronicleProgress.cs.template's header for the full trace] Two of these
// 7 branches (finishThisCharacter, climbFloors) are a literal reproduction
// of the reference mod's own real compiled condition expressions. The
// other 4 non-trivial kinds (winThisCharacter/winAnyCharacter/
// finishAnyCharacter, plus none/immediate) are [BEST EFFORT] — built the
// same way from the same real, confirmed ProgressState/CharacterStats
// members (GetStatsForCharacter/TotalWins/TotalLosses/Wins/Losses/
// FloorsClimbed — all independently confirmed via ecma_dump_ext.py against
// the real sts2.dll), just not each individually exercised by a real
// compiled example the way the other two were.
function chronicleUnlockConditionExpr(requirement, characterClassFull) {
  const kind = (requirement && requirement.kind) || 'none';
  const amount = Math.max(1, parseInt(requirement && requirement.amount, 10) || 1);
  const statsExpr = `progress.GetStatsForCharacter(ModelDb.GetId(typeof(${characterClassFull})))`;
  switch (kind) {
    case 'winThisCharacter': return `((${statsExpr})?.TotalWins ?? 0) >= ${amount}`;
    case 'finishThisCharacter': return `(((${statsExpr})?.TotalWins ?? 0) + ((${statsExpr})?.TotalLosses ?? 0)) >= ${amount}`;
    case 'winAnyCharacter': return `progress.Wins >= ${amount}`;
    case 'finishAnyCharacter': return `(progress.Wins + progress.Losses) >= ${amount}`;
    case 'climbFloors': return `progress.FloorsClimbed >= ${amount}`;
    case 'immediate':
    case 'none':
    default:
      return 'true';
  }
}

// Human-readable UnlockInfo text — [VERIFIED phrasing for
// finishThisCharacter/climbFloors, copied near-verbatim from the real
// localization strings found in the reference mod's .pck ("Finish 5 runs
// as The Burdened (wins or losses)." / "Climb 3 floors across all
// runs."); the other kinds are [BEST EFFORT] phrasing in the same style,
// not independently confirmed against a real compiled example.
function buildUnlockInfoText(requirement, characterName) {
  const kind = (requirement && requirement.kind) || 'none';
  const amount = Math.max(1, parseInt(requirement && requirement.amount, 10) || 1);
  const plural = amount === 1 ? '' : 's';
  switch (kind) {
    case 'immediate': return 'Available immediately.';
    case 'winThisCharacter': return `Win ${amount} run${plural} as ${characterName}.`;
    case 'finishThisCharacter': return `Finish ${amount} run${plural} as ${characterName} (wins or losses).`;
    case 'winAnyCharacter': return `Win ${amount} run${plural} with any character.`;
    case 'finishAnyCharacter': return `Finish ${amount} run${plural} with any character (wins or losses).`;
    case 'climbFloors': return `Climb ${amount} floor${plural} across all runs.`;
    case 'none':
    default:
      return 'No requirement \u2014 always available.';
  }
}

function epochUnlockCardInstances(epoch, cardClassById) {
  const ids = Array.isArray(epoch.unlockCardIds) ? epoch.unlockCardIds : [];
  const lines = ids.map(id => {
    const cls = cardClassById.get(id);
    return cls ? `        new ${cls}(),` : null;
  }).filter(Boolean);
  return lines.join('\n') || '        // (no unlocked cards configured)';
}

function generateEpochSource(epoch, namespace, className, epochId, storyId, cardClassById) {
  const tpl = loadTemplate('Epoch.cs.template');
  return fillTemplate(tpl, {
    namespace,
    className,
    epochId,
    era: EPOCH_ERAS.includes(epoch.era) ? epoch.era : 'Seeds0',
    eraPosition: String(Number.isFinite(epoch.eraPosition) ? Math.max(0, Math.min(4, Math.trunc(epoch.eraPosition))) : 0),
    storyId,
    cardInstances: epochUnlockCardInstances(epoch, cardClassById),
  });
}

function generateStorySource(namespace, className, storyId, epochClassNames) {
  const tpl = loadTemplate('Story.cs.template');
  const epochInstances = epochClassNames.map(cn => `        new ${cn}(),`).join('\n');
  return fillTemplate(tpl, { namespace, className, storyId, epochInstances });
}

function generateChronicleRegistrarSource(namespace, epochEntries, storyClassNames) {
  const tpl = loadTemplate('ChronicleRegistrar.cs.template');
  const epochRegistrations = epochEntries.map(e => `            AddEpoch("${e.epochId}", typeof(${e.className}));`).join('\n');
  const storyRegistrations = storyClassNames.map(cn => `            AddStory(typeof(${cn}));`).join('\n');
  const epochIdList = epochEntries.map(e => `"${e.epochId}"`).join(', ');
  return fillTemplate(tpl, { namespace, epochRegistrations, storyRegistrations, epochIdList });
}

function generateChronicleProgressSource(namespace, epochEntries, characterClassFull, epochIdsWithArt) {
  const tpl = loadTemplate('ChronicleProgress.cs.template');
  const perEpochChecks = epochEntries.map(e => {
    const cond = chronicleUnlockConditionExpr(e.unlockRequirement, characterClassFull);
    return `        UpdateEpoch(progress, "${e.epochId}", ${cond});`;
  }).join('\n');
  const epochIdsWithArtLines = epochIdsWithArt.length
    ? epochIdsWithArt.map(id => `        "${id}",`).join('\n')
    : '        // (no epoch portraits uploaded)';
  return fillTemplate(tpl, { namespace, perEpochChecks, epochIdsWithArt: epochIdsWithArtLines });
}

function generateChronicleLocalization(storyEntries, epochEntries, characterName) {
  const rows = {};
  for (const s of storyEntries) {
    rows[`STORY_${s.storyId}`] = String(s.name || '');
  }
  for (const e of epochEntries) {
    rows[`${e.epochId}.title`] = String(e.name || '');
    rows[`${e.epochId}.description`] = String(e.description || '');
    rows[`${e.epochId}.unlockInfo`] = buildUnlockInfoText(e.unlockRequirement, characterName);
  }
  return JSON.stringify(rows, null, 2) + '\n';
}

function generateProject(characterPackage, outDir, opts = {}) {
  const modId = pascalCase(characterPackage.character.id || 'CustomCharacter');
  const namespace = modId;
  const written = [];

  const dirs = ['Cards', 'Relics', 'Powers', 'Enchantments', 'Characters', 'CardPools', 'RelicPools', 'PotionPools', 'Generated', 'Timeline', 'pack'];
  for (const d of dirs) fs.mkdirSync(path.join(outDir, d), { recursive: true });

  const write = (relPath, content) => {
    const filePath = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    written.push(filePath);
  };
  // Same as write() but for raw bytes (PNGs) instead of utf8 text — used by
  // writeCharacterArt() below. Real image bytes, never run through a text
  // encoding.
  const writeBinary = (relPath, buffer) => {
    const filePath = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    written.push(filePath);
  };

  // Shared action helper layer.
  write('Generated/ForgeActions.cs', fillTemplate(loadTemplate('ForgeActions.cs.template'), { namespace }));

  // TRUE custom tags interface — every generated card implements this
  // (see Card.cs.template/generateCardSource's forgeTagsInit). Written
  // once per project, same pattern as ForgeActions.cs above.
  write('Generated/IForgeTaggedCard.cs', fillTemplate(loadTemplate('IForgeTaggedCard.cs.template'), { namespace }));

  // Star-icon activation marker — every generated card implements this
  // (see Card.cs.template). Written once per project, same pattern as
  // IForgeTaggedCard.cs above. See IStarIconCard.cs.template's header for
  // the full evidence trail (round 96).
  write('Generated/IStarIconCard.cs', fillTemplate(loadTemplate('IStarIconCard.cs.template'), { namespace }));

  // Heavy-attack pose marker — every generated card implements this
  // (only the specific cards opted in actually get it added to their own
  // class declaration, see Card.cs.template's {{extraInterfaces}}), same
  // written-once-per-project pattern as IStarIconCard.cs above. See
  // IHeavyAttackCard.cs.template's header (round 121).
  write('Generated/IHeavyAttackCard.cs', fillTemplate(loadTemplate('IHeavyAttackCard.cs.template'), { namespace }));

  // Hand-position capture interface + its 3 Harmony prefixes — every
  // generated card implements IForgeHandPosition (Card.cs.template).
  // Round 54 shipped the first prefix (CardModel.OnPlayWrapper, for
  // OnPlay). Round 56 (Tyler: "add a 'this card' target option whenever
  // the trigger is set to played/discarded/kept in hand") added two more
  // after direct IL of CardCmd.DiscardAndDraw and
  // CombatManager.DoTurnEndCards confirmed OnDiscard/OnTurnEndInHand have
  // the exact same "card already left Hand" timing problem OnPlay used
  // to have — see Generated/IForgeHandPosition.cs's header for the full
  // decompiled-evidence trail for all three. Written once per project,
  // same pattern as IForgeTaggedCard.cs above.
  write('Generated/IForgeHandPosition.cs', fillTemplate(loadTemplate('IForgeHandPosition.cs.template'), { namespace }));
  write('Generated/ForgeHandPositionTracker.cs', fillTemplate(loadTemplate('ForgeHandPositionTracker.cs.template'), { namespace }));
  write('Generated/ForgeHandPositionDiscardTracker.cs', fillTemplate(loadTemplate('ForgeHandPositionDiscardTracker.cs.template'), { namespace }));
  write('Generated/ForgeHandPositionTurnEndTracker.cs', fillTemplate(loadTemplate('ForgeHandPositionTurnEndTracker.cs.template'), { namespace }));

  // Harmony patch that prevents the card-trail VFX crash (see
  // TOOLCHAIN_FINDINGS.md, "the compiler exports too many files again" /
  // "Card added to deck never leaves the screen") — written once per
  // project, unconditionally, same pattern as ForgeActions.cs above.
  write('Generated/ForgeCardTrailNullGuard.cs', fillTemplate(loadTemplate('ForgeCardTrailNullGuard.cs.template'), { namespace }));

  // Harmony patch that prevents the creature-visuals crash in combat (see
  // TOOLCHAIN_FINDINGS.md, "neither my character nor any enemies loaded
  // in") — written once per project, unconditionally, same pattern as
  // ForgeActions.cs above.
  write('Generated/ForgeCreatureVisualsNullGuard.cs', fillTemplate(loadTemplate('ForgeCreatureVisualsNullGuard.cs.template'), { namespace }));

  // Real Godot.NET.Sdk project + solution for the pack/ Godot project
  // itself -- exists ONLY to satisfy Godot's own exporter the moment any
  // .tscn in pack/ references a Script ext_resource (card trail,
  // creature visuals). Written unconditionally, same pattern as the
  // Harmony patches above -- harmless/unused if no scene ends up
  // referencing a script this compile. See
  // PackProject.csproj.template's header comment for the full real-
  // engine-source evidence trail (TOOLCHAIN_FINDINGS.md, "getting the
  // character working for real").
  write(`pack/${modId}.csproj`, fillTemplate(loadTemplate('PackProject.csproj.template'), { modName: modId }));
  write(`pack/${modId}.sln`, fillTemplate(loadTemplate('PackProject.sln.template'), { modName: modId }));

  // Mod entry point (Harmony bootstrap).
  // [Round 203] Chronicles (see the big comment further down, right
  // after Characters/<ModId>Character.cs is written, for the full
  // evidence trail) need one explicit call from ModEntry.Initialize() —
  // ChronicleRegistrar.Register() is plain reflection, not a
  // [HarmonyPatch]-attributed type, so the patch-discovery loop below
  // would never find it on its own. Computed here (rather than after
  // cardClassById, where the rest of Chronicles generation happens) since
  // ModEntry.cs itself is written before cardClassById exists — this
  // slot only needs to know WHETHER chronicles exist, not their content.
  const hasChronicles = Array.isArray(characterPackage.character.chronicles) && characterPackage.character.chronicles.length > 0;
  const chronicleRegistrarCall = hasChronicles
    ? `        try
        {
            ${namespace}.Timeline.ChronicleRegistrar.Register();
        }
        catch (Exception e)
        {
            GD.PrintErr($"[Forge] Chronicle registration failed: {e.Message}");
        }
`
    : '';
  write('ModEntry.cs', fillTemplate(loadTemplate('ModEntry.cs.template'), { harmonyId: `${modId.toLowerCase()}.patch`, chronicleRegistrarCall }));

  // Class-name maps, computed up front since both the pools (GenerateAllCards/
  // GenerateAllRelics, confirmed required by reflect-baselib) and the
  // character (StartingDeck/StartingRelics, confirmed by CS1715) need to
  // reference these same generated class names via ModelDb.Card<T>()/
  // ModelDb.Relic<T>().
  const cardClassById = new Map(characterPackage.cards.map(c => [c.id, pascalCase(c.name) + 'Card']));
  const relicClassById = new Map((characterPackage.relics || []).map(r => [r.id, pascalCase(r.name) + 'Relic']));
  // [Round 197] Same map-by-id convention as cardClassById/relicClassById
  // above, built fully-qualified (global::{namespace}.Afflictions.X /
  // .Enchantments.X) rather than bare -- unlike cardClassById/
  // relicClassById, these two get referenced from potentially ANY
  // generated namespace (a relic's or mechanic's own effects, not just a
  // card's own), and Relic.cs.template/Mechanic.cs.template have no
  // `using {{namespace}}.Afflictions;`/`.Enchantments;` of their own, so a
  // bare class name would risk an unresolved-type build error there. See
  // actionToCSharp's AfflictCard/EnchantCard cases (ctx.afflictionClassById/
  // ctx.enchantmentClassById).
  const afflictionClassById = new Map((characterPackage.afflictions || []).map(a => [a.id, `global::${namespace}.Afflictions.${pascalCase(a.name)}Affliction`]));

  // [Round 218] #37/38 -- only writes a file at all when at least one
  // relic in the project sets incomingWeakBonus/vulnerableDamageBonus.
  // See generateDebuffMultiplierSupportFile's own header comment for the
  // full evidence trail.
  const debuffMultiplierSupportSrc = generateDebuffMultiplierSupportFile(characterPackage, namespace, relicClassById);
  if (debuffMultiplierSupportSrc) {
    write('Generated/ForgeDebuffMultiplierSupport.cs', debuffMultiplierSupportSrc);
  }
  const enchantmentClassById = new Map((characterPackage.enchantments || []).map(e => [e.id, `global::${namespace}.Enchantments.${pascalCase(e.name)}Enchantment`]));
  const generateAllCardsExprs = characterPackage.cards.map(c => `ModelDb.Card<${cardClassById.get(c.id)}>()`).join(', ');
  const generateAllRelicsExprs = (characterPackage.relics || []).map(r => `ModelDb.Relic<${relicClassById.get(r.id)}>()`).join(', ');

  // Same class-name-map pattern for mechanics (custom powers) — set on the
  // module-level `currentMechanicClassById` (see its definition above)
  // before any card/relic source is generated, so `actionToCSharp`/
  // `conditionToCSharp` can resolve a schema `statusRef` (mechanic id) to
  // the real generated `Powers/XxxPower.cs` class name for
  // `ForgeActions.ApplyStatus<XxxPower>(...)`-style generic calls (see
  // TOOLCHAIN_FINDINGS.md "reflect-baselib round 7").
  currentMechanicClassById = new Map((characterPackage.mechanics || []).map(m => [m.id, pascalCase(m.name) + 'Power']));

  // [Round 232] Only writes a file at all when at least one mechanic in
  // the project sets stayVisibleAtZero -- see
  // generateStayVisibleAtZeroSupportFile's own header comment for the
  // full evidence trail. Placed after currentMechanicClassById above so
  // it can reuse that same id->class-name map rather than building a
  // second one.
  const stayVisibleAtZeroSupportSrc = generateStayVisibleAtZeroSupportFile(characterPackage, namespace, currentMechanicClassById);
  if (stayVisibleAtZeroSupportSrc) {
    write('Generated/ForgeStayVisibleAtZeroSupport.cs', stayVisibleAtZeroSupportSrc);
  }

  // [Round 139] Same module-level-before-any-card-source pattern as
  // currentMechanicClassById above, for custom card keywords — see
  // keywordExpr()'s own comment for the full evidence trail.
  const cardKeywordDefs = Array.isArray(characterPackage.character.cardKeywords) ? characterPackage.character.cardKeywords : [];
  currentCustomKeywordWords = new Set(cardKeywordDefs.map(k => pascalCase(k.word)));
  currentKeywordNamespace = namespace;
  const modKeywordsSource = generateModKeywordsSource(characterPackage.character, namespace);
  if (modKeywordsSource) write('Keywords/ModKeywords.cs', modKeywordsSource);
  const cardKeywordsLoc = generateCardKeywordsLocalization(characterPackage.character, namespace);
  if (cardKeywordsLoc) write('localization/eng/card_keywords.json', cardKeywordsLoc);

  // Pools (one card pool + one relic pool + one potion pool per character,
  // per the pattern seen in both installed mods: <ModId>CardPool /
  // <ModId>RelicPool — PotionPool added in this round, see
  // PotionPool.cs.template).
  const cardPoolClassName = `${modId}CardPool`;
  const relicPoolClassName = `${modId}RelicPool`;
  const potionPoolClassName = `${modId}PotionPool`;
  const colorHex = characterPackage.character.color || '#FFFFFF';
  const energyColorName = guessEnergyColorName(colorHex);
  const cardFrameColorName = guessCardFrameColorName(colorHex); // [Fix, round 32] — see guessCardFrameColorName's own comment
  write(`CardPools/${cardPoolClassName}.cs`, fillTemplate(loadTemplate('CardPool.cs.template'), {
    namespace,
    className: cardPoolClassName,
    colorHex,
    title: characterPackage.character.name.replace(/"/g, '\\"'),
    energyColorName,
    cardFrameColorName,
    generateAllCardsExprs,
  }));
  write(`RelicPools/${relicPoolClassName}.cs`, fillTemplate(loadTemplate('RelicPool.cs.template'), {
    namespace,
    className: relicPoolClassName,
    energyColorName,
    generateAllRelicsExprs,
  }));
  write(`PotionPools/${potionPoolClassName}.cs`, fillTemplate(loadTemplate('PotionPool.cs.template'), { namespace, className: potionPoolClassName }));

  // Character.
  // StartingDeck/StartingRelics must be IEnumerable<CardModel>/
  // IReadOnlyList<RelicModel> (CS1715, confirmed exactly by reflect-baselib
  // too), not lists of ID strings — resolve each schema ID against the
  // card/relic class names computed above and emit ModelDb.Card<T>()/
  // ModelDb.Relic<T>() expressions. Throws early (with a clear message) if a
  // starting-deck/relic ID doesn't match any card/relic actually defined on
  // this character, rather than silently emitting nothing.
  const startingDeckExprs = (characterPackage.character.startingDeckCardIds || [])
    .map(id => {
      const cls = cardClassById.get(id);
      if (!cls) throw new Error(`startingDeckCardIds references card id "${id}" which isn't defined in this character's cards[].`);
      return `ModelDb.Card<${cls}>()`;
    }).join(', ');

  // [VERIFIED via real sts2.dll IL disassembly of NCharacterSelectScreen
  // .SelectCharacter(), 2026-09-01 — see TOOLCHAIN_FINDINGS.md "character-
  // select click crash #3" for the full IL dump] The base game's own
  // character-select screen unconditionally does
  // `characterModel.StartingRelics[0]` (a plain List<RelicModel>.get_Item,
  // no Count check) the instant you click a character, to populate the
  // info panel. A character with an empty StartingRelics list throws
  // System.ArgumentOutOfRangeException right there and the click silently
  // does nothing further (no highlight, no splash art) — this is real
  // vanilla game behavior Forge cannot patch around, only avoid triggering.
  // Every character Forge has ever exported hit this, because nothing
  // wrote to the (already-existing) startingRelicId schema field until
  // this round added the frontend picker (see index.html's
  // renderStartingRelicPicker). Resolution order: explicit
  // character.startingRelicId first; else fall back to the first relic
  // marked rarity:"Starter" (the same concept the base game itself uses —
  // e.g. Ironclad's Burning Blood is RelicRarity.Starter) so an old saved
  // project that already has a Starter-rarity relic just works without
  // Tyler having to touch anything. validateCharacterPackage (see
  // backend/validate.js) hard-errors at compile time if NEITHER resolves,
  // rather than silently shipping a character guaranteed to crash on click.
  // Multiple-starter-relics round: character.startingRelicIds (array) is
  // now the primary field — StartingRelics is a real IReadOnlyList
  // (confirmed above), so there was never a real cap at one entry, only
  // the UI/schema hadn't caught up. Resolution order: the explicit array
  // if non-empty, else the legacy singular startingRelicId (old saved
  // packages that reach generateProject() directly, bypassing the
  // frontend's own migration pass), else every Starter-rarity relic —
  // same "old save with a Starter relic just works" fallback as before,
  // now collecting ALL of them instead of just the first.
  const startingRelicIdsRaw = Array.isArray(characterPackage.character.startingRelicIds) && characterPackage.character.startingRelicIds.length
    ? characterPackage.character.startingRelicIds
    : (characterPackage.character.startingRelicId
        ? [characterPackage.character.startingRelicId]
        : (characterPackage.relics || []).filter(r => r.rarity === 'Starter').map(r => r.id));
  const startingRelicExprs = startingRelicIdsRaw.map(id => {
    const cls = relicClassById.get(id);
    if (!cls) throw new Error(`startingRelicIds references relic id "${id}" which isn't defined in this character's relics[].`);
    return `ModelDb.Relic<${cls}>()`;
  }).join(', ');

  // Character art — see writeCharacterArt's own header comment for the
  // full evidence trail. Writes real PNGs into pack/images/... at their
  // real confirmed res:// paths and returns the C# override block to
  // splice into Character.cs.template, plus a per-field report written
  // into README.md by server.js (see server.js's writeReadme).
  //
  // entrySlugLower: the real game's own ModelId.Entry for this character
  // (see slugifyClassName's header comment for the full IL trail), needed
  // because the character-select background/locked-icon/transition-
  // material paths are ALL built from this exact string, not from
  // character.id — confirmed via real log evidence: className
  // "TestCharCharacter" -> entry "TEST_CHAR_CHARACTER", not "TEST_CHAR"
  // (which is what character.id alone would have given).
  const entrySlugLower = slugifyClassName(`${modId}Character`).toLowerCase();
  const { overrides: artOverrides, report: artReport } = writeCharacterArt(characterPackage, modId.toLowerCase(), entrySlugLower, writeBinary, write, colorHex, namespace, `${modId}Character`);

  // Resource bars (round 92) — see writeResourceBars's own header comment.
  const { report: resourceBarReport } = writeResourceBars(characterPackage.character, namespace, `${modId}Character`, write);
  artReport.push('', '**Resource bars:**', ...resourceBarReport);

  write(`Characters/${modId}Character.cs`, fillTemplate(loadTemplate('Character.cs.template'), {
    namespace,
    className: `${modId}Character`,
    maxHp: characterPackage.character.maxHp,
    startingGold: characterPackage.character.startingGold,
    energyPerTurn: characterPackage.character.energyPerTurn,
    // [Round 95] Defaults to 0 (matches TheBurdened's own real example,
    // and is a safe no-orbs default for a non-Orb-focused character) when
    // unset — see schema's character.baseOrbSlotCount and Character.cs.template's
    // own comment on BaseOrbSlotCount for the evidence.
    baseOrbSlotCount: Number.isFinite(characterPackage.character.baseOrbSlotCount) ? Math.trunc(characterPackage.character.baseOrbSlotCount) : 0,
    gender: ['Neutral', 'Feminine', 'Masculine'].includes(characterPackage.character.gender) ? characterPackage.character.gender : 'Neutral',
    startingDeckExprs,
    startingRelicExprs,
    cardPoolClassName,
    relicPoolClassName,
    potionPoolClassName,
    colorHex,
    artOverrides,
    localizationOverride: generateCharacterLocalization(characterPackage.character),
  }));

  // Chronicles (Tyler's "Epochs" spec, Round 203 — "change the name of
  // lore to 'Chronicles'. Chronicles are a collection of items called
  // 'Epochs'.") — see claude/round203-chronicles-epochs.md for the full
  // research trail. MegaCrit.Sts2.Core.Timeline.EpochModel/StoryModel are
  // real base-game classes, [VERIFIED] via direct sts2.dll IL disassembly
  // AND by decompiling Tyler's own updated TheBurdenedNewCharacter.dll
  // (v3, "New Chronicle" update) — including the fact that
  // unlockRequirement is a REAL, enforced mechanic (ChronicleProgress.
  // Evaluate/UpdateEpoch, Harmony-hooked into 4 real SaveManager/
  // NTimelineScreen entry points — see ChronicleProgress.cs.template's own
  // header), not just descriptive text, and that a custom epoch's
  // portrait needs its own Harmony patch on EpochModel.Portrait to ever
  // display (the base game's own default Portrait getter only looks in a
  // vanilla sprite atlas that never has this mod's ids in it).
  {
    const chronicles = Array.isArray(characterPackage.character.chronicles) ? characterPackage.character.chronicles : [];
    if (chronicles.length) {
      const modIdUpper = modId.toUpperCase();
      const characterClassFull = `${namespace}.Characters.${modId}Character`;
      const characterName = characterPackage.character.name || 'this character';

      const epochEntries = [];
      const storyEntries = [];
      let epochArtHeaderAdded = false;

      for (const chronicle of chronicles) {
        const storyClassName = `${pascalCase(chronicle.name)}Story`;
        const storyId = `${modIdUpper}_${slugifyClassName(pascalCase(chronicle.name))}`;
        const epochClassNames = [];

        for (const epoch of (Array.isArray(chronicle.epochs) ? chronicle.epochs : [])) {
          const className = `${pascalCase(epoch.name)}Epoch`;
          const epochId = `${modIdUpper}_${slugifyClassName(pascalCase(epoch.name))}_EPOCH`;
          epochClassNames.push(className);

          // Portrait art — same per-entity report-line pattern as
          // writeCardArt above. [VERIFIED convention path, see
          // writeEpochPortrait's own header comment.]
          const portraitRel = writeEpochPortrait(epoch, epochId, characterPackage, writeBinary);
          if (portraitRel) {
            if (!epochArtHeaderAdded) { artReport.push('', '**Epoch portraits:**'); epochArtHeaderAdded = true; }
            artReport.push(`- ${epoch.name}: epoch portrait exported to \`${portraitRel}\`. [VERIFIED]`);
          }

          write(`Timeline/${className}.cs`, generateEpochSource(epoch, namespace, className, epochId, storyId, cardClassById));

          epochEntries.push({
            epochId, className, name: epoch.name, description: epoch.description,
            unlockRequirement: epoch.unlockRequirement, hasPortrait: !!portraitRel,
          });
        }

        write(`Timeline/${storyClassName}.cs`, generateStorySource(namespace, storyClassName, storyId, epochClassNames));
        storyEntries.push({ storyId, className: storyClassName, name: chronicle.name });
      }

      write('Timeline/ChronicleRegistrar.cs', generateChronicleRegistrarSource(namespace, epochEntries, storyEntries.map(s => s.className)));
      write('Timeline/ChronicleProgress.cs', generateChronicleProgressSource(namespace, epochEntries, characterClassFull, epochEntries.filter(e => e.hasPortrait).map(e => e.epochId)));
      write('localization/eng/epochs.json', generateChronicleLocalization(storyEntries, epochEntries, characterName));
    }
  }

  // Placeholder files that establish the `{{namespace}}.Cards` / `.Relics`
  // namespaces even when there are zero cards or zero relics. Real bug
  // caught by an actual build: Character.cs.template and
  // RelicPool.cs.template both unconditionally `using {{namespace}}.Relics;`
  // — with 0 relics, no file ever declared that namespace, so the compiler
  // couldn't resolve it at all (CS0234 "does not exist in the namespace"),
  // not because of a wrong guess but because the namespace's only evidence
  // of existing was the (never-written) files inside it. A file-scoped
  // `namespace X;` declaration with nothing else in it is valid, empty C#,
  // so this costs nothing when cards/relics ARE present (just one extra,
  // otherwise-inert file) and fixes the 0-count case entirely.
  // Same placeholder needed for `.Powers` now that Card.cs.template and
  // Relic.cs.template both unconditionally `using {{namespace}}.Powers;`
  // (added this round for ForgeActions' generic ApplyStatus<T>()/etc. —
  // see TOOLCHAIN_FINDINGS.md "reflect-baselib round 7") — zero mechanics
  // would otherwise hit the exact same CS0234 bug fixed for Cards/Relics
  // below.
  write('Cards/_Namespace.cs', `namespace ${namespace}.Cards;\n`);
  write('Relics/_Namespace.cs', `namespace ${namespace}.Relics;\n`);
  write('Powers/_Namespace.cs', `namespace ${namespace}.Powers;\n`);

  // Pets — Tyler's "add a section to the page to create custom pets" ask.
  // STILL written as README.md, NOT .cs — see buildPetsReadme below for
  // the full evidence review on why. reflect-baselib rounds 11/12 DID
  // confirm the real base class Tyler's own working pets use
  // (CustomMonsterModel, via TheTrainerNewCharacter.Monsters.*Pet) and
  // its 3 real abstract members (MinInitialHp/MaxInitialHp/
  // IsHealthBarVisible, confirmed consistently across all 9 real Pokemon
  // pets) — but NOT the real signature of PlayerCmd.AddPet, the call that
  // actually attaches a pet to a run. Generating a compiling Monster class
  // with no confirmed way to ever attach it to a character would be a
  // silent dead end, not a real feature, so this stays a design doc until
  // a future round closes that gap. A .md file is invisible to MSBuild's
  // default `**/*.cs` glob, so this can NEVER break a real build no
  // matter what Tyler types in.
  if ((characterPackage.pets || []).length) {
    write('Pets/README.md', buildPetsReadme(characterPackage.pets));
  }

  // Enchantments — Round 95, Tyler: "Enchantments/Afflictions need their
  // own section after cards." UPDATED Round 190: the "still genuinely
  // unresearched" caveat that used to sit here is now OVERTURNED —
  // MegaCrit.Sts2.Core.Models.EnchantmentModel is a [VERIFIED] real
  // base-game class (direct ECMA-335 metadata read of the real installed
  // sts2.dll — see Enchantment.cs.template's header and
  // generateEnchantmentSource's own comment for the full evidence trail
  // and field-by-field mapping). Each enchantment now ALSO compiles to a
  // real .cs file, same "per-entity .cs file + one README" pattern Orbs
  // already uses just above.
  for (const enchantment of characterPackage.enchantments || []) {
    const enchSrc = generateEnchantmentSource(enchantment, namespace, { cardClassById, relicClassById, afflictionClassById, enchantmentClassById }, { characterPackage, writeBinary, modIdLower: modId.toLowerCase() });
    write(`Enchantments/${pascalCase(enchantment.name)}Enchantment.cs`, enchSrc);
  }
  if ((characterPackage.enchantments || []).length) {
    write('Enchantments/README.md', buildEnchantmentAfflictionReadme('Enchantments', characterPackage.enchantments));
  }

  // Afflictions — Round 196: same overturn as Enchantments got in round
  // 190, but for AfflictionModel, a REAL, SEPARATE base-game class (not a
  // reskin of EnchantmentModel — see Affliction.cs.template's header and
  // generateAfflictionSource's own comment for the full evidence trail).
  // Tyler: "afflictions are temporary enchantments."
  for (const affliction of characterPackage.afflictions || []) {
    const afflSrc = generateAfflictionSource(affliction, namespace, { cardClassById, relicClassById, afflictionClassById, enchantmentClassById });
    write(`Afflictions/${pascalCase(affliction.name)}Affliction.cs`, afflSrc);
  }
  if ((characterPackage.afflictions || []).length) {
    write('Afflictions/README.md', buildEnchantmentAfflictionReadme('Afflictions', characterPackage.afflictions));
  }

  // Orbs — Tyler's "add a section to the page to create custom orbs" ask.
  // UPGRADED this round: reflect-baselib rounds 11/12 found a REAL,
  // WORKING example (TheBurdenedNewCharacter.Orbs.MoonOrb) confirming
  // BaseLib.Abstracts.CustomOrbModel's exact real shape — see
  // generateOrbSource/Orb.cs.template. Every orb now compiles to a real
  // CustomOrbModel subclass with real PassiveVal/EvokeVal/DarkenedColor
  // overrides. Orbs/README.md is STILL written alongside the real .cs —
  // it now documents only what's NOT compiled yet (passiveText/evokeText/
  // focusScales — no confirmed way to wire actual Passive()/Evoke()
  // behavior, see Orb.cs.template's header), not the whole feature.
  // No 0-orbs `_Namespace.cs` fallback needed here (unlike Cards/Relics/
  // Powers above) — nothing else in this project does an unconditional
  // `using {{namespace}}.Orbs;`, so there's no CS0234 risk to guard
  // against yet.
  for (const orb of characterPackage.orbs || []) {
    const src = generateOrbSource(orb, namespace, colorHex);
    write(`Orbs/${pascalCase(orb.name)}Orb.cs`, src);
  }
  if ((characterPackage.orbs || []).length) {
    write('Orbs/README.md', buildOrbsReadme(characterPackage.orbs));
  }

  // Cards.
  let cardArtHeaderAdded = false;
  for (const card of characterPackage.cards) {
    // Card art — see writeCardArt's own header comment for the full
    // evidence trail. Writes real PNGs into pack/images/... and splices
    // the CustomPortraitPath override into this card's own generated
    // source; per-card report lines fold into the same artReport array
    // writeCharacterArt above already populates, so server.js's existing
    // README writer picks these up too without needing its own change.
    const { override: cardArtOverride, reportLine: cardArtReportLine } = writeCardArt(card, characterPackage, modId.toLowerCase(), writeBinary);
    if (cardArtReportLine) {
      if (!cardArtHeaderAdded) { artReport.push('', '**Card art:**'); cardArtHeaderAdded = true; }
      artReport.push(cardArtReportLine);
    }
    const src = generateCardSource(card, namespace, cardPoolClassName, cardArtOverride, { cardClassById, relicClassById, afflictionClassById, enchantmentClassById });
    write(`Cards/${pascalCase(card.name)}Card.cs`, src);
  }
  if (characterPackage.cards.length && !cardArtHeaderAdded) {
    artReport.push('', '**Card art:** none of your cards have uploaded art — skipped entirely.');
  }

  // Relics.
  let relicIconHeaderAdded = false;
  for (const relic of characterPackage.relics || []) {
    // Relic icon — see writeRelicIcon's own header comment for the full
    // IL evidence trail (PackedIconPath is virtual + reached via callvirt,
    // so a plain override suffices, no Harmony patch). Same
    // write-PNG-then-splice-override shape as writeCardArt above.
    const { override: relicIconOverride, reportLine: relicIconReportLine } = writeRelicIcon(relic, characterPackage, modId.toLowerCase(), writeBinary);
    if (relicIconReportLine) {
      if (!relicIconHeaderAdded) { artReport.push('', '**Relic icons:**'); relicIconHeaderAdded = true; }
      artReport.push(relicIconReportLine);
    }
    const src = generateRelicSource(relic, namespace, relicPoolClassName, { cardClassById, relicClassById, afflictionClassById, enchantmentClassById }, relicIconOverride);
    write(`Relics/${pascalCase(relic.name)}Relic.cs`, src);
  }

  // Mechanics (custom powers/statuses).
  let mechIconHeaderAdded = false;
  for (const mechanic of characterPackage.mechanics || []) {
    // Mechanic icon — see writeMechanicIcon's own header comment for the
    // full IL evidence trail (round 229). Same write-PNG-then-splice-
    // override shape as writeCardArt/writeRelicIcon above.
    const { override: mechIconOverride, reportLine: mechIconReportLine } = writeMechanicIcon(mechanic, characterPackage, modId.toLowerCase(), writeBinary);
    if (mechIconReportLine) {
      if (!mechIconHeaderAdded) { artReport.push('', '**Mechanic icons:**'); mechIconHeaderAdded = true; }
      artReport.push(mechIconReportLine);
    }
    const src = generateMechanicSource(mechanic, namespace, { cardClassById, relicClassById, afflictionClassById, enchantmentClassById }, mechIconOverride);
    write(`Powers/${pascalCase(mechanic.name)}Power.cs`, src);
  }

  // Static pack asset — Godot export preset, copied verbatim.
  fs.copyFileSync(path.join(TEMPLATES_DIR, 'export_presets.cfg'), path.join(outDir, 'pack', 'export_presets.cfg'));
  written.push(path.join(outDir, 'pack', 'export_presets.cfg'));
  // project.godot and mod_manifest.json are generated by MSBuild targets
  // inside mod.csproj itself at build time — not written here.

  // The .csproj — filled with mod metadata; game/Godot paths are supplied
  // as -p: overrides on the `dotnet build` command line by server.js, not
  // baked in here.
  const csproj = fillTemplate(loadTemplate('ModProject.csproj.template'), {
    modName: modId,
    modDisplayName: characterPackage.character.name.replace(/"/g, '&quot;'),
    modAuthor: (characterPackage.author || 'Unknown').replace(/"/g, '&quot;'),
    modVersion: characterPackage.modVersion || '1.0.0',
    baseLibVersion: '*',
    manifestJson: buildManifestJson(characterPackage, modId, opts.gameVersion),
  });
  write('mod.csproj', csproj);

  // ---- Reimport sidecar — "reverse-engineer anything that is exported" ----
  // Tyler: "I want to create this with the intention of being able to
  // reverse-engineer anything that is exported, so that the user can
  // import a character that they have created and work on it some more
  // after the initial export." The most honest way to do this is to just
  // ship the exact, complete input Forge already has in memory — the same
  // JSON this function was called with, unmodified — rather than trying to
  // reconstruct it later from the generated C#/art (which would be lossy:
  // effect logic, lore text, per-layer tint colors, etc. don't round-trip
  // through the compiled output). A plain .json file living outside
  // pack/**/*.cs and Cards/Relics/Powers/Characters is invisible to
  // MSBuild's default `**/*.cs` glob and never referenced by any generated
  // scene/resource, so the game will never try to load or run it — it's
  // pure passenger data alongside the real mod. See frontend/index.html's
  // "Import project" button (openProjectImport/importProjectFile) for the
  // other half of this — reads this exact file back into Forge, using the
  // same formatVersion migration pipeine (migrateLegacyStatusActions) that
  // already runs on every normal page load, so an old export from a prior
  // Forge version re-imports cleanly too.
  write('Forge_Project/character_project.json', JSON.stringify(characterPackage, null, 2));
  write('Forge_Project/README.md',
    "# Forge project file\n\n" +
    "`character_project.json` in this folder is a full copy of everything you had\n" +
    "entered in Forge when you exported this character — not just what compiled.\n" +
    "It is NOT read by the game or the compiled mod; it only exists so you (or\n" +
    "anyone else) can pick this character back up later.\n\n" +
    "**To keep editing this character:** open Forge, click **Import project** in\n" +
    "the top bar, and select this file. Everything — cards, relics, mechanics,\n" +
    "art, chronicles, the works — loads back in exactly as it was.\n");

  return { written, modId, modName: modId, artReport };
}

// [Round 203] The 7 real unlockRequirement kinds — one source of truth,
// exported below so validate.js enforces the exact same vocabulary
// (including which kinds need a positive-integer amount) instead of
// keeping its own copy that could drift out of sync.
const EPOCH_UNLOCK_REQUIREMENT_KINDS = ['none', 'immediate', 'winThisCharacter', 'finishThisCharacter', 'winAnyCharacter', 'finishAnyCharacter', 'climbFloors'];
const EPOCH_UNLOCK_REQUIREMENT_KINDS_NEEDING_AMOUNT = new Set(['winThisCharacter', 'finishThisCharacter', 'winAnyCharacter', 'finishAnyCharacter', 'climbFloors']);

module.exports = {
  generateProject, actionToCSharp, effectBlockToCSharp,
  // [Round 203] Chronicles/Epochs — EPOCH_ERAS is the confirmed-real,
  // 26-value MegaCrit.Sts2.Core.Timeline.EpochEra enum (see EPOCH_ERAS'
  // own comment above for the fields_dump2.py evidence); the requirement
  // kind lists are this file's own vocabulary (see
  // chronicleUnlockConditionExpr/buildUnlockInfoText). validate.js uses
  // both instead of keeping its own copies.
  EPOCH_ERAS, EPOCH_UNLOCK_REQUIREMENT_KINDS, EPOCH_UNLOCK_REQUIREMENT_KINDS_NEEDING_AMOUNT,
  // Exported so backend/validate.js can enforce the exact same rules
  // up-front (clear 400 response) instead of only finding out when
  // generateProject() throws deep inside a compile — one source of truth
  // for "what's a valid target for this action type" instead of two
  // copies that could drift apart.
  PLAYER_ONLY_ACTIONS, SELF_ONLY_ACTIONS, validTargetsForAction, MAX_UPGRADE_TIERS,
  // VANILLA_TOKEN_CARDS: the best-effort built-in-status-card name list for
  // CreateCard's "vanilla" token picker (see that const's own comment for
  // the full honesty caveat). PROTECTED_CTOR_BUILTIN_POWERS: exported as a
  // plain array (not the internal Set) so validate.js can allow a
  // ModifyStatus Remove entry to reference one of these 3 classes (real,
  // just not safely Add-able — see actionToCSharp's "ModifyStatus" case)
  // without validate.js needing its own copy of the same 3 names.
  VANILLA_TOKEN_CARDS, PROTECTED_CTOR_BUILTIN_POWERS: Array.from(PROTECTED_CTOR_BUILTIN_POWERS),
  // Same reasoning — condition subject vocabulary (Self/CardTarget/Pet)
  // and which triggers Pet is actually safe on (see CONDITION_SUBJECTS/
  // PET_SUPPORTED_TRIGGERS above) — one source of truth so validate.js
  // can reject a Pet-subject condition on the wrong trigger up-front.
  CONDITION_SUBJECTS, PET_SUPPORTED_TRIGGERS, SUBJECT_CAPABLE_CONDITION_KINDS,
  // Same reasoning — the list of real built-in status classes ApplyStatus/
  // RemoveStatus's builtinStatus dropdown can pick from. Derived from
  // BUILTIN_POWER_CLASS_MAP's own keys rather than a separate literal, so
  // adding a new built-in status (a real reflect-baselib find) only means
  // adding one entry to that map, not updating a parallel list too. Minus
  // PROTECTED_CTOR_BUILTIN_POWERS (3 classes confirmed un-constructible via
  // ApplyStatus<T>()'s "new()" constraint — see that const above) — 244
  // selectable, not 247.
  BUILTIN_STATUSES: Object.keys(BUILTIN_POWER_CLASS_MAP).filter(k => !PROTECTED_CTOR_BUILTIN_POWERS.has(k)),
  // [2026-09-22] Same reasoning as BUILTIN_STATUSES above — the 9 real
  // built-in RestSiteOption types TryModifyRestSiteOptions' 'restSiteOption'
  // shape can Add/Remove (see BUILTIN_REST_SITE_OPTION_CLASS_MAP), derived
  // from its own keys so validate.js has one source of truth instead of a
  // second hand-maintained list.
  REST_SITE_OPTION_TYPES: Object.keys(BUILTIN_REST_SITE_OPTION_CLASS_MAP),
  // Resource bars (round 92; round 101 — per-entry anchor) — one source
  // of truth for validate.js.
  MAX_RESOURCE_BARS, RESOURCE_BAR_ANCHORS, resolveBarAnchor,
  // Advanced Options — cost-reduction rules' `scope` enum, one shared
  // source of truth for backend/validate.js the same way every other
  // exported list above is.
  CARD_COST_REDUCTION_SCOPES: ['ThisCombat', 'ThisTurnOrUntilPlayed'],
  // [Round 164] cost-reduction rules' `direction` enum — same one-shared-
  // source-of-truth reasoning as CARD_COST_REDUCTION_SCOPES above. See
  // costReductionTodoLines's own comment for what each value compiles to
  // and the evidence split between them.
  CARD_COST_REDUCTION_DIRECTIONS: ['Decrease', 'Increase'],
  // Round 19 — the full relic/mechanic hook-trigger map (method/params/
  // playerExpr/targetExpr per trigger id). Exported so validate.js can
  // derive TARGETLESS_BOUND_HOOK_TRIGGERS (triggers with a real fgPlayer
  // binding but no fgTarget) and reject any action/condition on those
  // triggers that would reference an undeclared fgTarget local — see
  // generateHookEffects' own comment above for the CS0103 risk this guards
  // against. One source of truth instead of a second copy that could drift.
  TRIGGER_HOOKS,
  // Round 20 — Group B's hook/shape map, same "one source of truth"
  // reasoning as TRIGGER_HOOKS above. validate.js derives its own
  // per-shape field requirements (gateValue on 'gate', numericValue/
  // numericMode on 'numeric', setValue on 'tryRefNumeric', keywordOp/
  // keyword on 'keywordSet') from this map rather than hand-maintaining a
  // second list of which hook needs which fields.
  MODIFIER_HOOKS, CARD_KEYWORD_VALUES,
  // Round 57 — a card's own hook/shape map (OnDiscard/OnTurnEndInHand/
  // OnAnyCardPlayed), same "one source of truth" reasoning as TRIGGER_HOOKS.
  // validate.js widens TARGETLESS_BOUND_HOOK_TRIGGERS off this too (not
  // just TRIGGER_HOOKS) now that OnDiscard/OnTurnEndInHand have a real
  // playerExpr but no targetExpr, same CS0103 risk that set already guards
  // relic/mechanic hooks against.
  CARD_TRIGGER_HOOKS,
  // [Round 90] "While in a pile" — the 15-id trigger vocabulary + the
  // real 4-value PileType enum ('Hand'/'Discard'/'Draw'/'Exhaust', the
  // schema-facing strings pileTypeExpr() maps to the real enum member
  // names of the same spelling) — exported so validate.js can allow these
  // as whileInHand triggers and validate each entry's `pile` field
  // against the same 4 real values, one source of truth same as every
  // other exported list above.
  PILE_TRIGGER_HOOK_IDS,
  PILE_TYPES: ['Hand', 'Discard', 'Draw', 'Exhaust'],
};
