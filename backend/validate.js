// validate.js
// Hand-rolled validation for a CharacterPackage, run by server.js BEFORE
// generateProject() is ever called. This is the thing server.js's original
// "minimal shape validation" comment flagged as a stopgap ("swap for full
// ajv/schema validation") — implemented here as plain JS rather than
// pulling in a schema-validation library, since several of the rules that
// matter most are CROSS-FIELD (an action's valid `target` options depend
// on its `type`; a card's valid `trigger` options are different from a
// relic's) and don't fit a bare JSON-Schema enum cleanly anyway. See
// schema/character.schema.json for the shape this mirrors.
//
// Written directly in response to a real stress test (three deliberately
// broken cards/relics/mechanics) that exposed a hard truth about this
// project up to this point: NOTHING validated a package before compiling
// it. A card with cost -5 silently became `baseCost: -5` in real C#. A
// card's "Passive" effect block silently vanished (compiler.js only ever
// looked at OnPlay-triggered effects for cards, with no error for
// anything else). A relic's "OnPlay" trigger technically compiled but
// bound to a meaningless/nullable target. An ExhaustCard action targeting
// "AllEnemies" compiled with no error despite there being no way to
// "exhaust a card from an enemy" in this game. None of these were C#
// compiler errors — they were silently-wrong data the compiler happily
// turned into silently-wrong (or misleadingly "successful") generated
// code. This file's job is to catch all of that BEFORE generation, with
// one clear, complete list of what's wrong, rather than one card at a
// time discovered via more real `dotnet build` attempts.
//
// Returns { valid: boolean, errors: string[] } — ALL errors are collected
// (not just the first) so a single validation pass is actually useful.

const CARD_TYPES = ['Attack', 'Skill', 'Power', 'Status', 'Curse'];
const CARD_RARITIES = ['Basic', 'Common', 'Uncommon', 'Rare', 'Ancient', 'Event', 'Token', 'Status', 'Curse', 'Quest'];
const CARD_TARGETS = ['SingleEnemy', 'AllEnemies', 'Self', 'None'];
const RELIC_RARITIES = ['Starter', 'Common', 'Uncommon', 'Rare', 'Shop', 'Event', 'Ancient'];
// [VERIFIED via reflect-baselib round 9] a full After*/On*/Before* hook
// sweep of CustomCardModel (the same sweep round 2 ran on CustomRelicModel)
// turned up two real triggers beyond OnPlay — see compiler.js:
// CARD_TRIGGER_HOOKS for the real method names/signatures and the honest
// caveat that their actions aren't bound to a confirmed player/target yet.
// [VERIFIED via reflect-baselib rounds 2 & 9] AfterCardPlayed was ALREADY
// present in round 2's own CustomCardModel *Play* sweep (it's declared on
// AbstractModel, shared with the already-wired relic hook of the same
// name) — it just never got wired up as a selectable card trigger, since
// at the time OnPlay seemed to already cover "when played." It doesn't:
// AfterCardPlayed fires for ANY card played by ANYONE, not just this one
// (see compiler.js:CARD_TRIGGER_HOOKS for the real signature/caveats).
// This is the real mechanism behind "whenever you play a card with X,
// this other card reacts" — confirmed directly against Tyler's own
// TheTrainerNewCharacter.dll, which uses exactly this hook on several of
// its Pokemon cards.
// [Round 95] OnRetained added — VERIFIED via decompiling TheBurdenedNewCharacter.dll's
// real, shipped PatientStrike.cs/TrainedAssault.cs (both override AfterFlush,
// gated on `player == base.Owner && retainedCards.Contains(this)`) — see
// compiler.js:CARD_TRIGGER_HOOKS.OnRetained for the full evidence.
const CARD_TRIGGERS = ['OnPlay', 'OnDiscard', 'OnTurnEndInHand', 'OnAnyCardPlayed', 'OnRetained'];
// The real MegaCrit.Sts2.Core.Entities.Cards.CardKeyword enum, minus None
// — confirmed via reflect-baselib round 1 (see TOOLCHAIN_FINDINGS.md).
// Applied per-card via AddKeyword(CardKeyword.X) (compiler.js), a real,
// concrete, confirmed method (round 2). Replaced the old exhausts/innate/
// ethereal booleans, which only covered 3 of these 7.
const CARD_KEYWORDS = ['Exhaust', 'Ethereal', 'Innate', 'Retain', 'Unplayable', 'Sly', 'Eternal'];
// Real BaseLib MegaCrit.Sts2.Core.Entities.Cards.CardTag enum — [CONFIRMED
// via reflect-baselib round 10] a genuine closed enum, exactly these 5
// non-None members. NOT the same list as CARD_KEYWORDS/gameplayTags — see
// schema/character.schema.json's card.baseCardTag description.
const CARD_TAGS = ['None', 'Strike', 'Defend', 'Minion', 'OstyAttack', 'Shiv'];
// Round 19 (2026-08-27): 39 more real triggers added, all [VERIFIED via
// direct sts2.dll read] against the real override surface
// MegaCrit.Sts2.Core.Models.AbstractModel — kept in sync with
// schema/character.schema.json's hookEffectBlock.trigger enum and
// backend/compiler.js:TRIGGER_HOOKS (same 3-file discipline every prior
// trigger/condition-kind round has used).
//
// Round 20 (2026-08-25) correction: the earlier comment here claimed "37
// more real hooks... was deliberately deferred; see round19_hook_review.md"
// — that file never existed anywhere (verified while cross-checking
// Tyler's own reconstructed hook list against a fresh sts2.dll read; the
// real story is in claude/round20-groupb-findings.md, a Claude Project
// doc, not a device file). Those value-returning hooks (Group B — bool/
// int/decimal-returning AbstractModel overrides, not Task-returning
// events) now have their own real mechanism: see backend/compiler.js's
// MODIFIER_HOOKS/generateModifierOverrides and this file's own
// validateModifiers below. 'AfterForge' also moves here (not into Group B)
// — despite being on Tyler's reconstructed "odd-shaped Group B" list, a
// fresh sts2.dll read confirmed it's Task-returning, i.e. a real Group A
// event hook like every other entry in this array.
const HOOK_TRIGGERS = ['OnMyTurnStart', 'OnEnemyTurnStart', 'OnMyTurnEnd', 'OnEnemyTurnEnd', 'OnCombatStart', 'OnKillEnemy', 'OnMyDamageTaken', 'OnEnemyDamageTaken', 'OnExhaust', 'OnDrawCard', 'Passive', 'OnAnyCardPlayed', 'AfterCardGeneratedForCombat', 'AfterModifyingCardPlayCount', 'AfterCardDiscarded', 'AfterAttack', 'AfterMyDamageGiven', 'AfterEnemyDamageGiven', 'BeforeMyDamageReceived', 'BeforeEnemyDamageReceived', 'AfterMyBlockCleared', 'AfterEnemyBlockCleared', 'AfterMyBlockGained', 'AfterEnemyBlockGained', 'AfterMyBlockBroken', 'AfterEnemyBlockBroken', 'AfterEnemyAddedToCombat', 'AfterMyCurrentHpChanged', 'AfterEnemyCurrentHpChanged', 'BeforeMyDeath', 'BeforeEnemyDeath', 'AfterDiedToDoom', 'AfterPreventingMyDeath', 'AfterPreventingEnemyDeath', 'AfterSummon', 'AfterMyPowerAmountChanged', 'AfterEnemyPowerAmountChanged', 'AfterEnergyReset', 'AfterEnergySpent', 'AfterGoldGained', 'AfterStarsSpent', 'AfterStarsGained', 'BeforeHandDraw', 'AfterHandEmptied', 'AfterPreventingDraw', 'AfterShuffle', 'AfterActEntered', 'AfterCombatEnd', 'AfterCombatVictory', 'BeforeSideTurnStart', 'AfterPlayerTurnStart', 'AfterOrbChanneled', 'AfterOrbEvoked', 'AfterRestSiteHeal', 'AfterRestSiteSmith', 'BeforePotionUsed', 'AfterPotionUsed', 'AfterPotionDiscarded', 'AfterPotionProcured', 'AfterItemPurchased', 'AfterForge'];
// [Fix, round 35] 13 old ambiguous "fires for both your side and the
// enemy's" trigger ids retired above (fail loud -- Tyler's own migration
// choice, see RETIRED_AMBIGUOUS_TRIGGERS below): AfterDamageGiven,
// OnTakeDamage, AfterBlockBroken, BeforeDamageReceived, AfterBlockCleared,
// AfterBlockGained, AfterCurrentHpChanged, BeforeDeath,
// AfterPowerAmountChanged, AfterPreventingDeath, OnTurnStart, OnTurnEnd,
// AfterCreatureAddedToCombat. Each is replaced by a Mine/Enemy (or
// turn-side) pair above except AfterCreatureAddedToCombat, which is
// repurposed to enemy-only as AfterEnemyAddedToCombat (no Mine sibling --
// see backend/compiler.js:TRIGGER_HOOKS.AfterEnemyAddedToCombat's own
// comment for Tyler's reasoning). See TOOLCHAIN_FINDINGS.md, "12 triggers
// -> real Creature.IsEnemy split", for the full evidence trail.
// [VERIFIED via reflect-baselib round 10] PlayedCardHasTag is Forge's own
// TRUE custom-tag mechanism (Tyler's original "hit" example) — NOT
// BaseLib's real CardTag enum, which round 10 confirmed is a genuine,
// CLOSED C# enum a mod cannot add new members to at runtime. See
// backend/templates/IForgeTaggedCard.cs.template's header comment for the
// full reasoning. Uses `tag` (a freeform string, matched against
// card.gameplayTags — see below) instead of comparator/value, same shape
// convention as PlayedCardHasKeyword, and the same OnAnyCardPlayed-only
// restriction (cardPlay isn't in scope anywhere else).
// CardsPlayedThisTurn — [VERIFIED via decompiling
// TheBurdenedNewCharacter.dll's Eternal, both its real OnPlay AND its real
// ShouldGlowGoldInternal override] a real comparator+value threshold (same
// shape as EnergyRemaining/StarsRemaining/CardsInHand below) on how many
// cards this card's own owner has finished playing so far this turn —
// originally shipped as a fixed "< 1" (first-card-only) check named
// FirstCardPlayedThisTurn, generalized this round per Tyler's follow-up:
// "the glow condition should instead check if cards played this turn are
// <= an amount." Reachable through plain CardModel instance members
// (CombatState/Owner) with no cardPlay local needed, so — unlike every
// trigger-restricted condition above it — this one is valid on EVERY
// trigger AND inside card.advancedOptions.glow/.playability — see
// compiler.js:conditionToCSharp. No subject (not in
// SUBJECT_CAPABLE_CONDITION_KINDS) — the count is always this card's own
// owner's, there's no "whose plays" concept to pick.
const CONDITION_KINDS = [
  'HasStatusStacks', 'HpBelowPercent', 'EnergyRemaining', 'StarsRemaining', 'CardsInHand',
  'PlayedCardHasKeyword', 'PlayedCardHasTag', 'PlayedCardHasType', 'CardsPlayedThisTurn', 'DamageBrokeBlock',
  // 2026-08-27 condition-kind expansion round — see
  // schema/character.schema.json's own kind-enum description for the full
  // evidence trail on each of these 9 (all [VERIFIED] via direct sts2.dll
  // read, none are placeholders).
  'HasBlock', 'DebuffStacksTotal', 'PetIsOut', 'HandCardTypeCheck',
  'AttacksPlayedThisTurn', 'OrbSlotCount', 'EnemyIntent', 'HasSpecificRelic', 'NoCopiesOfCardInHand',
  // 2026-09-08 (round 52) — [VERIFIED via decompiling
  // TheBurdenedNewCharacter.dll v3 — Earthquake's real IsPlayable override]
  // see this file's own dedicated validation block below and
  // compiler.js:conditionToCSharpRaw's CardPositionInHand case for the
  // full evidence trail.
  'CardPositionInHand',
];
// cardPlayBound-only condition kinds — down to just EnemyIntent as of
// round 63. HandCardTypeCheck/OrbSlotCount/HasSpecificRelic/
// NoCopiesOfCardInHand were generalized off `ctx.cardPlayBound` in
// compiler.js:conditionToCSharp (now gated on the much wider
// `ctx.fgPlayerBound` via resolvePlayerExpr(ctx), same fix
// DrawCard/GainEnergy/GainGold/CreateCard/GainOrbSlots already got — see
// claude/round62-session-handoff.md and claude/round63-*.md); they moved to
// GENERALIZED_PLAYER_ONLY_CONDITION_KINDS below, which is checked against
// `trigger === undefined` (Glow/Playability + Group B modifiers, the only
// two places `ctx.fgPlayerBound` is still false) instead of the narrow
// PET_SUPPORTED_TRIGGERS allowlist. EnemyIntent stays here: it reads
// `cardPlay.Target` specifically (an opposing Creature), which has no
// equivalent binding anywhere outside a real `cardPlay` local — Player has
// fgPlayer/resolvePlayerExpr(ctx) as a real fallback, Target does not, per
// compiler.js:resolvePlayerExpr's own comment.
const CARD_PLAY_BOUND_ONLY_CONDITION_KINDS = ['EnemyIntent'];
// [Round 63] See the comment above and this list's own use in
// validateConditions below.
const GENERALIZED_PLAYER_ONLY_CONDITION_KINDS = ['HandCardTypeCheck', 'OrbSlotCount', 'HasSpecificRelic', 'NoCopiesOfCardInHand'];
const COMPARATORS = ['lt', 'lte', 'eq', 'gte', 'gt'];
// 12-action-type model — replaces the old 17-type list (ApplyStatus/
// RemoveStatus/ApplyCustomStatus/RemoveCustomStatus/LoseHp/HealHp/GainGold/
// CreateCardInHand/CreateCardInDrawPile all retired) per Tyler's big
// legibility ask: "lets reduce apply/remove/customapply/customremove to
// just be 'Modify status'... Gain and lose HP should be combined into
// 'Modify HP'... Gold should get the same treatment... Create card in hand
// and draw pile should be 'Create Card'." See compiler.js's `actionToCSharp`
// switch (same 12 cases) and schema/character.schema.json's `type`
// description for the full old->new mapping and the formatVersion 11->12
// migration this backs. Old fields (statusRef/statusRefs/refAmounts/
// builtinStatus/builtinStatuses/statusAmounts) are DEPRECATED — still
// present in the schema as migration-source shape, no longer read here or
// by compiler.js.
// "StunEnemy"/"EndTurn" added 2026-08-25 — Tyler: "we should add 2 more
// effects to the 'then' section. one that stuns the enemy, and one that
// ends the players turn." 2026-08-26: "EndTurn" now compiles to a real
// [BEST EFFORT] call in most contexts (see compiler.js's actionToCSharp
// EndTurn case), "StunEnemy" is still [UNVERIFIED] — either way, same
// validation treatment as every other action type here, nothing
// StunEnemy/EndTurn-specific needed since neither takes an amount, mode,
// or any type-specific extra field (which real/stub tier compiler.js
// picks doesn't change what a valid PACKAGE looks like, only what C# it
// emits).
const ACTION_TYPES = [
  'DealDamage', 'GainBlock', 'ModifyStatus', 'RemoveAllStatuses',
  'DrawCard', 'ModifyEnergy', 'ModifyHp', 'ModifyGold', 'DiscardCard',
  'ExhaustCard', 'CreateCard', 'ShuffleCardIntoDraw',
  'StunEnemy', 'EndTurn', 'ModifyOrbSlots', 'ReturnToHand',
  // [Round 193] Tyler: "can we add an effect to our existing effect list
  // that modifies the cost of the card?" -- see compiler.js's
  // actionToCSharp "ModifyCost" case for the full evidence trail.
  'ModifyCost',
  // [Round 197] Tyler: "we also need to add effects to remove or afflict
  // cards" -- see compiler.js's actionToCSharp cases (AfflictCard/
  // RemoveAffliction/EnchantCard/RemoveEnchantment) for the real
  // CardCmd.Afflict<T>/ClearAffliction/Enchant<T>/ClearEnchantment calls
  // these compile to.
  'AfflictCard', 'RemoveAffliction', 'EnchantCard', 'RemoveEnchantment',
];
// mode's valid pair depends on action.type — ModifyStatus reads Add/Remove
// (which of the two old apply/remove call pairs to make), ModifyHp/
// ModifyGold read Gain/Lose (which of the two old separate action types'
// call to make). Every other action type ignores `mode` entirely — set here
// (rather than one shared boolean) since several different type/value
// pairings are cross-checked below.
// [Round 160] ModifyEnergy (Gain/Lose) and ModifyOrbSlots (Add/Remove)
// added — Tyler, choosing between a sign-based amount (like round 159's
// original ModifyEnergy) and this mode-dropdown pattern for the brand-new
// ModifyOrbSlots: "i like number 2 [mode dropdown], can we also apply that
// to the energy?" So ModifyEnergy's round-159 sign-based design is
// superseded — it now reads `mode` exactly like ModifyHp/ModifyGold, and
// ModifyOrbSlots (replacing "GainOrbSlots") launches with the same pattern
// from day one instead of a plain always-add amount. See compiler.js's
// ModifyEnergy/ModifyOrbSlots cases for the underlying API evidence.
const MODE_ACTIONS = { ModifyStatus: ['Add', 'Remove'], ModifyHp: ['Gain', 'Lose'], ModifyGold: ['Gain', 'Lose'], ModifyEnergy: ['Gain', 'Lose'], ModifyOrbSlots: ['Add', 'Remove'], ModifyCost: ['Decrease', 'Increase'] };
// Imported from compiler.js rather than duplicated here — one source of
// truth for "what's a valid target for this action type", "what are the
// real built-in status classes", and "which vanilla/protected-ctor
// concepts exist", used both to reject a bad package up-front (here) and
// as compiler.js's own defense-in-depth check (in case generateProject()
// is ever called directly without going through this validator first).
const { PLAYER_ONLY_ACTIONS, SELF_ONLY_ACTIONS, validTargetsForAction, BUILTIN_STATUSES, PROTECTED_CTOR_BUILTIN_POWERS, VANILLA_TOKEN_CARDS, CONDITION_SUBJECTS, PET_SUPPORTED_TRIGGERS, SUBJECT_CAPABLE_CONDITION_KINDS, MAX_UPGRADE_TIERS, CARD_COST_REDUCTION_SCOPES, CARD_COST_REDUCTION_DIRECTIONS, TRIGGER_HOOKS, MODIFIER_HOOKS, CARD_KEYWORD_VALUES, CARD_TRIGGER_HOOKS, PILE_TRIGGER_HOOK_IDS, PILE_TYPES, MAX_RESOURCE_BARS, RESOURCE_BAR_ANCHORS, resolveBarAnchor } = require('./compiler');
// Round 19 — derived (not hand-maintained) from TRIGGER_HOOKS: every
// trigger whose hook binds a real fgPlayer but has no fgTarget (playerExpr
// set, targetExpr null — see compiler.js:generateHookEffects' 3-way branch
// and its comment for the full reasoning). An action/condition on one of
// these triggers that references fgTarget (action.target === 'SingleEnemy',
// condition.subject === 'CardTarget', action.amountScalesWithSubject ===
// 'Target') would compile to a real CS0103 (fgTarget is never declared in
// that hook body) — this set is what the 3 checks below reject up-front.
//
// [Fix, round 35 follow-up] `|| TRIGGER_HOOKS[t].collectionExpr` added —
// OnMyTurnStart/OnEnemyTurnStart/OnMyTurnEnd/OnEnemyTurnEnd bind a real
// fgPlayer per-iteration via a foreach over `collectionExpr` instead of a
// single playerExpr (see compiler.js:generateHookEffects' collection
// branch), but still never bind fgTarget either way — same real CS0103
// risk, same gate needed.
const TARGETLESS_BOUND_HOOK_TRIGGERS = new Set([
  ...Object.keys(TRIGGER_HOOKS).filter(t => (TRIGGER_HOOKS[t].playerExpr || TRIGGER_HOOKS[t].collectionExpr) && !TRIGGER_HOOKS[t].targetExpr),
  // [Round 57] Same derivation, now also over a card's OWN hook table
  // (CARD_TRIGGER_HOOKS) — OnDiscard/OnTurnEndInHand gained a real
  // playerExpr (CardModel.Owner, see compiler.js:PET_SUPPORTED_TRIGGERS'
  // own comment for the evidence) but still have no targetExpr (no real
  // "target" Creature exists for either), so they need the exact same
  // fgTarget-reference guard relic/mechanic hooks already get here.
  // OnAnyCardPlayed is correctly excluded — it uses fullCardPlayBinding
  // (a real cardPlay.Target), not playerExpr, so this filter never
  // matches it.
  ...Object.keys(CARD_TRIGGER_HOOKS).filter(t => CARD_TRIGGER_HOOKS[t].playerExpr && !CARD_TRIGGER_HOOKS[t].targetExpr),
]);

// Round 21 — Tyler: "lets go through the hooks and their targets... I need
// this to be fullproof." Auditing every TRIGGER_HOOKS entry against
// compiler.js:actionToCSharp turned up a second, previously-unguarded
// CS0103 risk in the same family as TARGETLESS_BOUND_HOOK_TRIGGERS above,
// but on a DIFFERENT local: `choiceContext`. `DealDamage` (any target) and
// `ModifyStatus`'s Add+AllEnemies case both unconditionally emit a bare
// `choiceContext` reference (see compiler.js:actionToCSharp's "DealDamage"/
// "ModifyStatus" cases) — that identifier is only ever a real local when
// it's a genuine parameter of the CURRENT hook's real method signature.
// This was safe by construction back when only OnPlay/OnTakeDamage-style
// hooks existed (every one of those DOES declare `choiceContext` — see
// TOOLCHAIN_FINDINGS.md's reflect-baselib round 7 note, "safe because
// every context that reaches this line is inside an already-async Task
// method... alongside a real choiceContext param"), but Round 19 added 39
// new relic/mechanic hooks and 17 of them (plus Round 20's AfterForge — 18
// total) bind a real fgPlayer with NO `choiceContext` in their real params
// at all (e.g. AfterGoldGained's bare `Player player`, AfterBlockCleared's
// bare `Creature creature`) — the round-7 comment's invariant silently
// stopped holding for those and was never revisited. Confirmed directly
// against every TRIGGER_HOOKS params string (all [VERIFIED] via
// reflect-baselib/direct sts2.dll reads already) — no new dll read needed,
// this is a pure cross-check of data already in the file. Derived here the
// same way TARGETLESS_BOUND_HOOK_TRIGGERS is, so it can never drift from
// TRIGGER_HOOKS as more hooks are added.
//
// IMPORTANT: gated on `playerExpr` too, same as TARGETLESS_BOUND_HOOK_
// TRIGGERS — and for the same underlying reason. compiler.js:
// generateHookEffects only ever calls effectBlockToCSharp/actionToCSharp
// (the functions that emit `choiceContext`) when `hook.playerExpr` (or, as
// of round 35 follow-up, `hook.collectionExpr` — see that fix's own
// comment on TARGETLESS_BOUND_HOOK_TRIGGERS above) is truthy; when both
// are falsy (a genuinely "unbound" hook, e.g. AfterActEntered/
// OnCombatStart), the ENTIRE effect block collapses to one
// `ForgeActions.Todo(...)` call before any individual action is ever
// touched — so an unbound hook's actions never reach the risky codegen at
// all and don't need blocking here (they're already an honest no-op stub,
// a separate and already-flagged limitation, not this bug). Real trigger
// names drift as new hooks get added/split (round 35 alone retired 13 ids
// and added 27), so this comment intentionally no longer hand-lists them —
// this Set (and TARGETLESS_BOUND_HOOK_TRIGGERS above) are the single
// source of truth, re-derived automatically from TRIGGER_HOOKS every time
// the module loads; log `[...NO_CHOICE_CONTEXT_HOOK_TRIGGERS]` at runtime
// if the exact current membership is ever needed. Every OTHER action type
// (GainBlock, single-target ApplyStatus/RemoveStatus/RemoveAllStatuses,
// ModifyHp) was checked against compiler.js's own case bodies and
// confirmed to never reference `choiceContext` — only DealDamage and
// ModifyStatus's AllEnemies branch do, so those are the only two gated
// below. Full writeup in claude/status.md's Round 21 section (original
// derivation) and Round 35 (collectionExpr extension).
const NO_CHOICE_CONTEXT_HOOK_TRIGGERS = new Set(
  Object.keys(TRIGGER_HOOKS).filter(t => (TRIGGER_HOOKS[t].playerExpr || TRIGGER_HOOKS[t].collectionExpr) && !(TRIGGER_HOOKS[t].params || '').includes('choiceContext'))
);

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

// `modifierHook` (round 20) — pass the real MODIFIER_HOOKS[mod.hook] entry
// when these conditions belong to a Group B modifier block, not a normal
// trigger-based effect block. Every other call site leaves it undefined.
// It exists because modifier conditions are compiled with
// `modCtx.cardPlayBound: false` unconditionally (see
// compiler.js:generateModifierOverrides) and bind fgPlayer/fgTarget from
// the HOOK's own real params (MODIFIER_HOOKS[hook].playerExpr/targetExpr),
// never from a cardPlay/glow path — so the existing trigger-shaped
// CardTarget/Pet rules below (written for TRIGGER_HOOKS/glow/playability)
// don't fit: a modifier hook can bind a real fgTarget with no "trigger" at
// all (e.g. ModifyDamageAdditive's `dealer`), and NO modifier hook ever
// binds fgPet (there's no cardPlay.Player.Osty path for a value-returning
// hook body, unlike OnPlay/OnAnyCardPlayed) — see the modifierHook branch
// inside the SUBJECT_CAPABLE_CONDITION_KINDS block below.
function validateConditions(conditions, path, errors, mechanicIds, cardIds, relicIds, trigger, gameplayTagsInUse, modifierHook) {
  if (conditions === undefined) return;
  if (!Array.isArray(conditions)) { errors.push(`${path}.conditions must be an array.`); return; }
  conditions.forEach((cond, i) => {
    const p = `${path}.conditions[${i}]`;
    if (!cond || typeof cond !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!CONDITION_KINDS.includes(cond.kind)) { errors.push(`${p}.kind "${cond.kind}" is not one of: ${CONDITION_KINDS.join(', ')}.`); return; }
    if (cond.kind === 'PlayedCardHasKeyword') {
      // Different shape than every other condition kind — this checks the
      // CARD that triggered the hook (`cardPlay.Card.Keywords.Contains(...)`
      // in the generated C#), not a comparator/value threshold, so it uses
      // its own `keyword` field instead of comparator/value. `cardPlay` is
      // only in scope inside the OnAnyCardPlayed hook body (see
      // compiler.js:CARD_TRIGGER_HOOKS/TRIGGER_HOOKS) — using it on any
      // other trigger would reference an undefined variable and fail to
      // compile for real, so it's rejected here before that ever happens.
      if (trigger !== 'OnAnyCardPlayed') {
        errors.push(`${p} has kind "PlayedCardHasKeyword" but this effect block's trigger is "${trigger}" — this condition only makes sense on "OnAnyCardPlayed" (it checks the card that triggered THAT hook; no other trigger exposes one to check).`);
      }
      if (!CARD_KEYWORDS.includes(cond.keyword)) errors.push(`${p}.keyword "${cond.keyword}" is not one of: ${CARD_KEYWORDS.join(', ')}.`);
      return;
    }
    if (cond.kind === 'PlayedCardHasTag') {
      // Same trigger restriction as PlayedCardHasKeyword, same reason
      // (cardPlay only in scope on OnAnyCardPlayed) — but `tag` is
      // freeform text (there's no fixed enum the way CardKeyword is), so
      // instead cross-checked against every card.gameplayTags value used
      // ANYWHERE in this character (case-insensitive, matching the same
      // dedup convention card.tags/card.gameplayTags both use). This
      // catches a typo'd tag ("Hitt" vs "Hit") before it ships as a
      // condition that would silently always evaluate false — the same
      // "reject clearly rather than silently accept something broken"
      // reasoning statusRef/cardRef references already get elsewhere in
      // this file.
      if (trigger !== 'OnAnyCardPlayed') {
        errors.push(`${p} has kind "PlayedCardHasTag" but this effect block's trigger is "${trigger}" — this condition only makes sense on "OnAnyCardPlayed" (it checks the card that triggered THAT hook; no other trigger exposes one to check).`);
      }
      if (!isNonEmptyString(cond.tag)) {
        errors.push(`${p} has kind "PlayedCardHasTag" but no tag.`);
      } else if (cond.tag.length > 40) {
        errors.push(`${p}.tag "${cond.tag}" is longer than 40 characters.`);
      } else if (gameplayTagsInUse && !gameplayTagsInUse.has(cond.tag.toLowerCase())) {
        errors.push(`${p}.tag "${cond.tag}" doesn't match any card.gameplayTags value used anywhere in this character (case-insensitive) — this would compile but always evaluate false. Check spelling, or add this tag to at least one card first.`);
      }
      return;
    }
    if (cond.kind === 'PlayedCardHasType') {
      // Same trigger restriction as PlayedCardHasKeyword/PlayedCardHasTag
      // (cardPlay only in scope on OnAnyCardPlayed), and same "own field
      // instead of comparator/value" shape — `cardType` is a boolean
      // has/has-not check against one of the 5 real CardType values
      // (CARD_TYPES — the same list card.type itself is validated
      // against below), not a numeric threshold. Replaces the old
      // single-type "IsAttack" condition.
      if (trigger !== 'OnAnyCardPlayed') {
        errors.push(`${p} has kind "PlayedCardHasType" but this effect block's trigger is "${trigger}" — this condition only makes sense on "OnAnyCardPlayed" (it checks the card that triggered THAT hook; no other trigger exposes one to check).`);
      }
      if (!CARD_TYPES.includes(cond.cardType)) errors.push(`${p}.cardType "${cond.cardType}" is not one of: ${CARD_TYPES.join(', ')}.`);
      return;
    }
    if (cond.kind === 'DamageBrokeBlock') {
      // Added 2026-08-26 (Tyler's "Flick" lead — see
      // compiler.js:conditionToCSharp's DamageBrokeBlock case for the full
      // decompiled-evidence writeup). No comparator/value/subject — a plain
      // boolean check with no other fields at all, so — unlike every other
      // condition above — there's nothing left to validate here beyond the
      // trigger restriction. Restricted to OnPlay only: the generated
      // expression reads `this` (the CardModel instance) as "the card that
      // just dealt damage", which is only a coherent idea inside that
      // card's own OnPlay — not on OnAnyCardPlayed (a DIFFERENT card
      // triggered that hook) or any relic/mechanic hook (no "this card's
      // own damage" concept exists there at all). Matches Flick's own real
      // usage (its ONLY use of this pattern is inside its own OnPlay).
      if (trigger !== 'OnPlay') {
        errors.push(`${p} has kind "DamageBrokeBlock" but this effect block's trigger is "${trigger}" — this condition only makes sense on "OnPlay" (it checks whether THIS card's own damage broke its target's block, which is only meaningful for the card's own play).`);
      }
      return;
    }
    // ---- 2026-08-27 condition-kind expansion round ----
    // EnemyIntent (the one kind still in CARD_PLAY_BOUND_ONLY_CONDITION_KINDS
    // as of round 63) needs a real cardPlay.Target local in scope — see
    // compiler.js's conditionToCSharp, which falls back to an honest
    // TodoCondition stub outside those two triggers. Rejecting here up
    // front matches this file's established "reject clearly rather than
    // silently accept something broken" convention (same reasoning as the
    // Pet-subject trigger check further below) rather than letting the
    // package save fine and silently compile to a no-op.
    if (CARD_PLAY_BOUND_ONLY_CONDITION_KINDS.includes(cond.kind)) {
      if (trigger === undefined || !PET_SUPPORTED_TRIGGERS.includes(trigger)) {
        errors.push(`${p} has kind "${cond.kind}" but this effect block's trigger is "${trigger}" — this condition needs a real cardPlay.Player/cardPlay.Target in scope, which today is only ${PET_SUPPORTED_TRIGGERS.join(' and ')}.`);
      }
    }
    // [Round 63] HandCardTypeCheck/OrbSlotCount/HasSpecificRelic/
    // NoCopiesOfCardInHand were generalized off `ctx.cardPlayBound` in
    // compiler.js:conditionToCSharp — they now compile for real on ANY
    // effect-block trigger (relic/mechanic/card, not just OnPlay/
    // OnAnyCardPlayed) via `resolvePlayerExpr(ctx)`, gated on the much
    // wider `ctx.fgPlayerBound`. But `ctx.fgPlayerBound` is still flatly
    // false in exactly two places (see resolvePlayerExpr's own comment
    // and CardsPlayedThisTurn's identical gate above): the Glow/
    // Playability property getter (no locals at all there — `trigger` is
    // `undefined` at that call site) and a Group B modifier hook (also
    // `trigger === undefined` — see availableConditionKinds' mod-
    // conditions call site in frontend/index.html). Both pass `trigger:
    // undefined` here, so one check covers both — same "reject clearly"
    // convention as the block above, now correctly scoped instead of
    // over-restricting to just 2 triggers.
    if (GENERALIZED_PLAYER_ONLY_CONDITION_KINDS.includes(cond.kind) && trigger === undefined) {
      errors.push(`${p} has kind "${cond.kind}" but this condition has no effect-block trigger in scope (Glow/Playability or a Group B modifier hook) — this condition needs a real Player in scope, which today means any normal relic/mechanic/card effect-block trigger, not Glow/Playability or a modifier hook.`);
    }
    if (cond.kind === 'HandCardTypeCheck') {
      // [VERIFIED via sts2.dll — PileType.Hand.GetPile(cardPlay.Player).Cards]
      // `mode` (Any/All) + `cardType` (reuses PlayedCardHasType's own
      // CARD_TYPES list) — no comparator/value.
      if (cond.mode !== undefined && !['Any', 'All'].includes(cond.mode)) {
        errors.push(`${p}.mode "${cond.mode}" is not one of: Any, All.`);
      }
      if (!CARD_TYPES.includes(cond.cardType)) errors.push(`${p}.cardType "${cond.cardType}" is not one of: ${CARD_TYPES.join(', ')}.`);
      return;
    }
    if (cond.kind === 'EnemyIntent') {
      // [VERIFIED via sts2.dll — Monster.NextMove.Intents] `intentKind`
      // (Attack/Defend only — the two confirmed real Intent subclasses) —
      // no comparator/value.
      if (!['Attack', 'Defend'].includes(cond.intentKind)) errors.push(`${p}.intentKind "${cond.intentKind}" is not one of: Attack, Defend.`);
      return;
    }
    if (cond.kind === 'HasSpecificRelic') {
      // [VERIFIED — reuses the same real Player.Relics + ModelDb-class-
      // identity pattern startingRelicId already relies on] `relicRef` —
      // a relic id from this character's own relics[], cross-checked the
      // same way startingRelicId is at the top level.
      if (!isNonEmptyString(cond.relicRef)) errors.push(`${p} has kind "HasSpecificRelic" but no relicRef.`);
      else if (!relicIds.has(cond.relicRef)) errors.push(`${p}.relicRef "${cond.relicRef}" doesn't match any defined relic id.`);
      return;
    }
    if (cond.kind === 'NoCopiesOfCardInHand') {
      // [VERIFIED — same real hand-pile access as HandCardTypeCheck + same
      // cardClassById identity pattern as HasSpecificRelic] `cardRef` — a
      // card id from this character's own cards[].
      if (!isNonEmptyString(cond.cardRef)) errors.push(`${p} has kind "NoCopiesOfCardInHand" but no cardRef.`);
      else if (!cardIds.has(cond.cardRef)) errors.push(`${p}.cardRef "${cond.cardRef}" doesn't match any defined card id.`);
      return;
    }
if (cond.kind === 'CardPositionInHand') {
      // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3 —
      // Earthquake's real IsPlayable override, "isLeftmostInHand"] Checks
      // THIS card's own position in its owner's hand pile — `edge`
      // ('Left'|'Right', default 'Left') + `position` (1-based, default 1;
      // 1 = the edge card itself) instead of comparator/value, since this
      // is an exact-position check, not a threshold. No subject (not in
      // SUBJECT_CAPABLE_CONDITION_KINDS) — it's always THIS card's own
      // position, there's no "whose hand" to pick.
      //
      // Restricted to exactly the same real context Glow/Playability
      // already use (trigger === undefined, no modifierHook) — see
      // compiler.js:resolveGlowSubjectExpr's doc comment — PLUS, as of
      // round 54, a card's own OnPlay and OnAnyCardPlayed triggers, and
      // as of round 56, OnDiscard and OnTurnEndInHand too.
      //
      // [Round 53, 2026-09-08 — VERIFIED, not just reasoned] Decompiled
      // sts2.dll to check whether a LIVE hand-position check could work on
      // OnPlay/OnAnyCardPlayed. CardModel.OnPlayWrapper calls
      // CardPileCmd.AddDuringManualCardPlay BEFORE Hook.BeforeCardPlayed /
      // CardModel.OnPlay / Hook.AfterCardPlayed (the hook OnAnyCardPlayed
      // compiles to) — and AddDuringManualCardPlay's own IL is
      // card.RemoveFromCurrentPile() immediately followed by
      // PileTypeExtensions.GetPile(...).AddInternal(card) into the Play
      // pile. So a live check is confirmed unconditionally false there —
      // correctly declined at the time.
      //
      // [Round 54, 2026-09-08] Tyler's updated TheBurdenedNewCharacter.dll
      // v4 has a real, compiled Strike card that deals bonus damage if it
      // "was" leftmost/rightmost in hand WHEN PLAYED — via a Harmony
      // PREFIX patch on CardModel.OnPlayWrapper (ModHandPositionPatch,
      // confirmed via its CustomAttribute blob) that captures the position
      // BEFORE the pile-removal above happens, read later from OnPlay.
      // Generated/ForgeHandPositionTracker.cs reimplements that real
      // mechanism generically — see compiler.js's CardPositionInHand case
      // and Generated/IForgeHandPosition.cs for the full evidence trail.
      // So OnPlay (checks `this`, the card being played) and
      // OnAnyCardPlayed (checks `cardPlay.Card`, the card that was
      // actually played — same reasoning PlayedCardHasTag/Keyword/Type use)
      // are now real too.
      //
      // [Round 56, 2026-09-08 — Tyler: "add a 'this card' target option
      // whenever the trigger is set to played/discarded/kept in hand, and
      // a 'that card' target option for whenever any card is played"]
      // OnDiscard/OnTurnEndInHand were previously rejected here as
      // "architectural stubs regardless" — that was true for every OTHER
      // condition/action on those two triggers (no real target binding
      // exists yet), but NOT actually true for this specific condition,
      // which only ever needs `this` (both are selfFilter/single-card
      // triggers — see CARD_TRIGGER_HOOKS in compiler.js). Direct IL of
      // CardCmd.DiscardAndDraw and CombatManager.DoTurnEndCards this round
      // confirmed both have the exact same "card already left Hand by the
      // time the real hook fires" timing problem OnPlay had (Discard moves
      // the card into the Discard pile before Hook.AfterCardDiscarded;
      // turn-end processing moves it into the Play pile, via
      // AddTurnEndCardToPlayPileWithDelay, before
      // CardModel.OnTurnEndInHandWrapper) — so two more Harmony prefixes
      // (Generated/ForgeHandPositionDiscardTracker.cs,
      // Generated/ForgeHandPositionTurnEndTracker.cs) now capture the
      // position before THAT removal too, the same "capture before
      // removal" trick round 54 proved for OnPlay. Both are now real and
      // accepted below. A relic/mechanic modifier hook's own conditions
      // never reach this validator with trigger !== undefined in the
      // first place (its UI always passes trigger:undefined — see
      // frontend/index.html's mod-conditions call site), so `modifierHook`
      // alone remains the correct thing to reject on, same as every
      // SUBJECT_CAPABLE_CONDITION_KINDS modifierHook check further below.
      const cardPositionInHandOk = !modifierHook && (trigger === undefined || CARD_TRIGGERS.includes(trigger));
      if (!cardPositionInHandOk) {
        errors.push(`${p} has kind "CardPositionInHand" but this isn't a Glow/Playability condition (Advanced Options), and its trigger "${trigger}" isn't one of this card's own triggers (OnPlay/OnDiscard/OnTurnEndInHand/OnAnyCardPlayed) either — a relic/mechanic modifier hook has no card of its own to check [VERIFIED via decompiling sts2.dll's CardModel.OnPlayWrapper/CardCmd.DiscardAndDraw/CombatManager.DoTurnEndCards for why every other real timing needs a captured-before-removal Harmony prefix, not a live check].`);
      }
            if (cond.edge !== undefined && !['Left', 'Right'].includes(cond.edge)) {
        errors.push(`${p}.edge "${cond.edge}" is not one of: Left, Right.`);
      }
      if (typeof cond.position !== 'number' || !Number.isInteger(cond.position) || cond.position < 1) {
        errors.push(`${p}.position must be a positive integer (1 = the edge card itself).`);
      }
      return;
    }
    // PetIsOut [VERIFIED via sts2.dll — Creature.Pets] is boolean, no
    // comparator/value — unlike DamageBrokeBlock it IS subject-capable (see
    // SUBJECT_CAPABLE_CONDITION_KINDS below), so it doesn't return early
    // here; it just skips the comparator/value requirement every other
    // (non-boolean) kind needs and falls through to the shared
    // subject-validation block below.
    if (cond.kind !== 'PetIsOut') {
      if (!COMPARATORS.includes(cond.comparator)) errors.push(`${p}.comparator "${cond.comparator}" is not one of: ${COMPARATORS.join(', ')}.`);
      if (typeof cond.value !== 'number') errors.push(`${p}.value must be a number.`);
    }
    if (cond.kind === 'HasStatusStacks') {
      // `statusKind` ('vanilla' | 'custom', defaults to 'custom' — the
      // only kind this condition supported before Tyler's follow-up "the
      // condition that checks for statuses should work on both vanilla as
      // well as custom statuses. Currently it only works for custom").
      // Mirrors the existing ApplyStatus (builtinStatuses, vanilla) vs.
      // ApplyCustomStatus (statusRefs, custom) action-side split — see
      // compiler.js:conditionToCSharp's HasStatusStacks case.
      const statusKind = cond.statusKind === 'vanilla' ? 'vanilla' : 'custom';
      if (cond.statusKind !== undefined && !['vanilla', 'custom'].includes(cond.statusKind)) {
        errors.push(`${p}.statusKind "${cond.statusKind}" is not one of: vanilla, custom.`);
      } else if (statusKind === 'vanilla') {
        if (!isNonEmptyString(cond.builtinStatus)) errors.push(`${p} has kind "HasStatusStacks" with statusKind "vanilla" but no builtinStatus.`);
        else if (!BUILTIN_STATUSES.includes(cond.builtinStatus)) errors.push(`${p}.builtinStatus "${cond.builtinStatus}" is not one of the known built-in statuses.`);
      } else {
        if (!isNonEmptyString(cond.statusRef)) errors.push(`${p} has kind "HasStatusStacks" but no statusRef.`);
        else if (!mechanicIds.has(cond.statusRef)) errors.push(`${p}.statusRef "${cond.statusRef}" doesn't match any defined mechanic id.`);
      }
    }
    if (SUBJECT_CAPABLE_CONDITION_KINDS.includes(cond.kind)) {
      // `subject` (Self/CardTarget/Pet) — Tyler's "If <target> has
      // <condition>" ask: WHICH creature to check, changeable from the
      // card's target to self or the pet. Originally HasStatusStacks-only;
      // extended to HpBelowPercent per Tyler's follow-up ("the hp below %
      // condition should allow either yourself or pet or enemy to be the
      // target of the check") — see compiler.js:SUBJECT_CAPABLE_CONDITION_KINDS.
      // `undefined` is valid (a condition saved before this field existed)
      // and is read as 'Self' by compiler.js:resolveConditionSubjectExpr —
      // the only subject either condition ever checked before this field
      // existed — so old saved packages aren't rejected retroactively.
      // 'Pet' specifically is only real on the two triggers where
      // `cardPlay.Player.Osty` is reachable (see
      // compiler.js:PET_SUPPORTED_TRIGGERS) — anywhere else it would
      // reference an unbound `fgPet` local and fail to compile for real,
      // so it's rejected here first, same "reject clearly rather than
      // silently accept something broken" reasoning as the
      // PlayedCardHasKeyword/PlayedCardHasTag trigger checks above.
      if (cond.subject !== undefined && !CONDITION_SUBJECTS.includes(cond.subject)) {
        errors.push(`${p}.subject "${cond.subject}" is not one of: ${CONDITION_SUBJECTS.join(', ')}.`);
      } else if (modifierHook) {
        // Round 20 — Group B modifier conditions: no cardPlay, no glow
        // context, no cardPlay.Player.Osty path — fgPlayer/fgTarget come
        // straight from this specific hook's own real params (see the
        // comment on the `modifierHook` parameter above). 'CardTarget' is
        // only real when THIS hook binds a second party; 'Pet' is never
        // real here, on any modifier hook.
        if (cond.subject === 'CardTarget' && !modifierHook.targetExpr) {
          errors.push(`${p} has subject "CardTarget" but modifier hook "${modifierHook.method}" only exposes one real Creature (bound as fgPlayer), no second party to check — use "You" (Self) instead.`);
        } else if (cond.subject === 'Pet') {
          errors.push(`${p} has subject "Pet" but a Group B modifier condition has no cardPlay/Osty path in scope (see compiler.js:generateModifierOverrides — modifiers never bind fgPet) — Pet isn't resolvable here. Use "You" (Self) instead.`);
        }
      } else if (cond.subject === 'CardTarget' && trigger === undefined) {
        // trigger === undefined ONLY ever happens for the
        // card.advancedOptions.glow/.playability call site below (every
        // real effect block always has a real trigger string) — a card
        // sitting in hand/deck has no target yet, so 'CardTarget' would
        // compile to a reference to `fgTarget`, a local that only exists
        // inside a real cardPlay-bound trigger body. [Found while wiring
        // glow's real ShouldGlowGoldInternal override for real —
        // compiler.js:resolveGlowSubjectExpr has no CardTarget case at
        // all, on purpose.]
        errors.push(`${p} has subject "CardTarget" but this is a glow/playability condition — there's no card target yet before the card is played. Use "You" (Self) or "Pet" instead.`);
      } else if (cond.subject === 'CardTarget' && trigger !== undefined && TARGETLESS_BOUND_HOOK_TRIGGERS.has(trigger)) {
        // Round 19 — same CS0103 risk as the glow/playability case just
        // above, but for a real effect-block trigger this time: this
        // hook's body never declares fgTarget (see
        // TARGETLESS_BOUND_HOOK_TRIGGERS' definition above), so
        // "CardTarget" here would reference an undeclared local.
        errors.push(`${p} has subject "CardTarget" but trigger "${trigger}" only exposes one real Creature (bound as fgPlayer), no second party to check — use "You" (Self) or "Pet" instead.`);
      } else if (cond.subject === 'Pet' && trigger !== undefined && !PET_SUPPORTED_TRIGGERS.includes(trigger)) {
        // trigger === undefined (glow/playability) is EXCLUDED from this
        // check, not covered by it — [VERIFIED via decompiling
        // TheBurdenedNewCharacter.dll] `Owner` is a real, always-reachable
        // CardModel property in every context, including the glow/
        // playability property-getter context, so `Owner?.Osty` (see
        // compiler.js:resolveGlowSubjectExpr) is just as real there as
        // `cardPlay.Player.Osty` is inside OnPlay/OnAnyCardPlayed.
        //
        // [Round 57] PET_SUPPORTED_TRIGGERS now also includes OnDiscard/
        // OnTurnEndInHand, which reach Osty via `this.Owner.Osty` — NOT
        // `cardPlay.Player.Osty` (neither has a real cardPlay at all, see
        // compiler.js:CARD_TRIGGER_HOOKS' own comments) — so this message
        // no longer names one single expression, just the real trigger
        // list itself.
        errors.push(`${p} has subject "Pet" but this effect block's trigger is "${trigger}" — Pet (Osty) is only resolvable on ${PET_SUPPORTED_TRIGGERS.join(', ')} (plus glow/playability, which reach it a different real way) — every other trigger has no confirmed path from its own real hook parameters back to a Player/Osty.`);
      }
    }
  });
}

// `fieldName` defaults to 'actions' — pass 'elseActions' to validate an
// effect block's else-branch actions instead (see validateEffects below),
// re-using every one of these same rules (a valid action here is a valid
// action there too, same ACTION_TYPES/validTargetsForAction/statusRefs
// etc. checks) rather than a second, drift-prone copy of this function.
function validateActions(actions, path, errors, mechanicIds, cardIds, afflictionIds, enchantmentIds, fieldName = 'actions', xContext = {}) {
  if (!Array.isArray(actions)) { errors.push(`${path}.${fieldName} must be an array.`); return; }
  // xEligible — whether amountIsX/hitCountIsX are even allowed at this
  // call site. [VERIFIED via decompiling TheBurdenedNewCharacter.dll]
  // CardModel.ResolveEnergyXValue() is an instance method reached as
  // `this.ResolveEnergyXValue()` in generated code — `this` only means
  // "this card" inside a CARD's own generated class, and the one real
  // confirmed example (Retaliation) only calls it from that card's own
  // OnPlay. So: entityKind must be 'card', trigger must be 'OnPlay', and
  // the card itself must have costsX true (compiler.js's HasEnergyCostX
  // override is what makes ResolveEnergyXValue() return anything
  // meaningful in the first place).
  const xEligible = xContext.entityKind === 'card' && xContext.trigger === 'OnPlay' && xContext.cardCostsX === true;
  // [Round 74] Star counterpart — mirrors xEligible exactly, keyed off
  // cardCostsStarX/HasStarCostX instead of cardCostsX/HasEnergyCostX. See
  // compiler.js's RESOLVE_STAR_X_EXPR comment for the real evidence trail
  // ("X Star" card's decompiled OnPlay).
  const xStarEligible = xContext.entityKind === 'card' && xContext.trigger === 'OnPlay' && xContext.cardCostsStarX === true;
  actions.forEach((act, i) => {
    const p = `${path}.${fieldName}[${i}]`;
    if (!act || typeof act !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!ACTION_TYPES.includes(act.type)) { errors.push(`${p}.type "${act.type}" is not one of: ${ACTION_TYPES.join(', ')}.`); return; }
    const validTargets = validTargetsForAction(act.type);
    if (!validTargets.includes(act.target)) {
      errors.push(`${p}: action "${act.type}" can't target "${act.target}" — valid targets are: ${validTargets.join(', ')}.` +
        (PLAYER_ONLY_ACTIONS.includes(act.type) ? ` ("${act.type}" acts on the player's own hand/deck/discard/energy/gold — there's no way to do this to an enemy.)` : '') +
        (SELF_ONLY_ACTIONS.includes(act.type) ? ` ("${act.type}" only ever targets the player's own creature by design — see compiler.js:SELF_ONLY_ACTIONS.)` : ''));
    } else if (act.target === 'SingleEnemy' && xContext.trigger !== undefined && TARGETLESS_BOUND_HOOK_TRIGGERS.has(xContext.trigger)) {
      // Round 19 — this hook's own body never declares an fgTarget local
      // (see TARGETLESS_BOUND_HOOK_TRIGGERS' definition above and
      // compiler.js:generateHookEffects' 3-way branch), so "SingleEnemy"
      // here would compile to a reference to an undeclared variable — a
      // real CS0103, not a silently-wrong no-op. Rejected clearly instead,
      // same convention as every other trigger-scoped check in this file.
      errors.push(`${p}: action "${act.type}" can't target "SingleEnemy" on trigger "${xContext.trigger}" — this hook only exposes one real Creature (bound as fgPlayer), no second party to target. Use "Self" instead.`);
    } else if (act.type === 'DealDamage' && xContext.trigger !== undefined && NO_CHOICE_CONTEXT_HOOK_TRIGGERS.has(xContext.trigger)) {
      // Round 21 — see NO_CHOICE_CONTEXT_HOOK_TRIGGERS' own comment above.
      // Every DealDamage call (any target) needs a real `choiceContext` to
      // pass to ForgeActions.DealDamage/DealDamageAllEnemies — this hook's
      // real signature doesn't have one.
      errors.push(`${p}: action "DealDamage" can't be used on trigger "${xContext.trigger}" — this hook's real signature has no PlayerChoiceContext parameter, which DealDamage needs to actually execute (see compiler.js:TRIGGER_HOOKS/NO_CHOICE_CONTEXT_HOOK_TRIGGERS). Pick a different action for this trigger, or move this effect to a trigger that exposes one.`);
    } else if (act.type === 'ModifyStatus' && act.mode === 'Add' && act.target === 'AllEnemies' && xContext.trigger !== undefined && NO_CHOICE_CONTEXT_HOOK_TRIGGERS.has(xContext.trigger)) {
      // Round 21 — same NO_CHOICE_CONTEXT_HOOK_TRIGGERS gap, the OTHER
      // codegen path that references it (ForgeActions.ApplyStatusAllEnemies).
      // Add+single-target and Remove (any target) don't reference
      // choiceContext at all, so only this one combination is blocked.
      errors.push(`${p}: action "ModifyStatus" (Add) can't target "AllEnemies" on trigger "${xContext.trigger}" — this hook's real signature has no PlayerChoiceContext parameter, which the all-enemies status call needs (see compiler.js:TRIGGER_HOOKS/NO_CHOICE_CONTEXT_HOOK_TRIGGERS). Target "Self" instead, or move this effect to a trigger that exposes one.`);
    }
    if (act.amount !== undefined && typeof act.amount !== 'number') errors.push(`${p}.amount must be a number.`);
    // amountIsX / hitCount / hitCountIsX — [VERIFIED via decompiling
    // TheBurdenedNewCharacter.dll] see schema descriptions for the full
    // evidence trail. hitCount/hitCountIsX are DealDamage-only (the real
    // confirmed mechanism, AttackCommand.WithHitCount, is specific to
    // attacks) — checked here rather than left to silently do nothing on
    // e.g. GainBlock, matching this file's "reject clearly" convention.
    if (act.amountIsX !== undefined && typeof act.amountIsX !== 'boolean') errors.push(`${p}.amountIsX must be a boolean if present.`);
    if (act.amountIsX === true && !xEligible) {
      errors.push(`${p}.amountIsX is true, but "Use X" is only valid on a card whose own costsX is true, inside that SAME card's own OnPlay effect block (the only usage a real example confirms) — got entityKind=${xContext.entityKind || 'unknown'}, trigger=${xContext.trigger || 'unknown'}, card.costsX=${xContext.cardCostsX === true}.`);
    }
    // [Round 74] amountIsStarX — CardModel.ResolveStarXValue(), the star
    // counterpart of amountIsX. [VERIFIED via decompiling Tyler's own
    // updated TheBurdenedNewCharacter.dll — "X Star"'s real OnPlay,
    // see compiler.js's RESOLVE_STAR_X_EXPR]. Same costsStarX +
    // this-card's-own-OnPlay-only restriction as amountIsX, plus mutual
    // exclusion with amountIsX itself (the UI never lets both be true —
    // see index.html's amountUseX/amountUseStarX handlers — but a
    // hand-edited package could, and resolveAmountExpr would silently
    // just prefer amountIsX in that case, so reject it clearly instead).
    if (act.amountIsStarX !== undefined && typeof act.amountIsStarX !== 'boolean') errors.push(`${p}.amountIsStarX must be a boolean if present.`);
    if (act.amountIsStarX === true && !xStarEligible) {
      errors.push(`${p}.amountIsStarX is true, but "Use X (Star)" is only valid on a card whose own costsStarX is true, inside that SAME card's own OnPlay effect block (the only usage a real example confirms) — got entityKind=${xContext.entityKind || 'unknown'}, trigger=${xContext.trigger || 'unknown'}, card.costsStarX=${xContext.cardCostsStarX === true}.`);
    }
    if (act.amountIsX === true && act.amountIsStarX === true) {
      errors.push(`${p}: amountIsX and amountIsStarX can't both be true — they're alternate sources for the same amount (energy-X vs. star-X), not stackable.`);
    }
    if (act.hitCount !== undefined && (!isInt(act.hitCount) || act.hitCount < 1)) errors.push(`${p}.hitCount must be an integer >= 1 if present.`);
    if (act.hitCountIsX !== undefined && typeof act.hitCountIsX !== 'boolean') errors.push(`${p}.hitCountIsX must be a boolean if present.`);
    // [Round 76, shipped BEST EFFORT] hitCountIsStarX — Tyler explicitly
    // asked for this by symmetry with hitCountIsX/amountIsStarX.
    // [Round 77, VERIFIED] Tyler's uploaded "NEW X STAR" card confirms
    // this for real — see compiler.js's resolveHitCountExpr for the IL
    // evidence.
    if (act.hitCountIsStarX !== undefined && typeof act.hitCountIsStarX !== 'boolean') errors.push(`${p}.hitCountIsStarX must be a boolean if present.`);
    if ((act.hitCount !== undefined || act.hitCountIsX === true || act.hitCountIsStarX === true) && act.type !== 'DealDamage') {
      errors.push(`${p}: hitCount/hitCountIsX/hitCountIsStarX are only meaningful on "DealDamage" (real AttackCommand.WithHitCount) — action type is "${act.type}".`);
    }
    if (act.hitCountIsX === true && !xEligible) {
      errors.push(`${p}.hitCountIsX is true, but "Use X" is only valid on a card whose own costsX is true, inside that SAME card's own OnPlay effect block — got entityKind=${xContext.entityKind || 'unknown'}, trigger=${xContext.trigger || 'unknown'}, card.costsX=${xContext.cardCostsX === true}.`);
    }
    if (act.hitCountIsStarX === true && !xStarEligible) {
      errors.push(`${p}.hitCountIsStarX is true, but "X Star Hits" is only valid on a card whose own costsStarX is true, inside that SAME card's own OnPlay effect block — got entityKind=${xContext.entityKind || 'unknown'}, trigger=${xContext.trigger || 'unknown'}, card.costsStarX=${xContext.cardCostsStarX === true}.`);
    }
    if (act.hitCountIsX === true && act.hitCountIsStarX === true) {
      errors.push(`${p}: hitCountIsX and hitCountIsStarX can't both be true — they're alternate sources for the same hit count (energy-X vs. star-X), not stackable.`);
    }
    // [Round 80] hit count SCALING with a status's stack count — Tyler:
    // "what if I want to deal x damage, 1 time per stack? meaning i hit
    // based on how many stacks i have?" Mirrors the amountScalesWith*
    // block above exactly (same real ForgeActions.GetStatusStacks<T>
    // mechanism, same vanilla/custom split, same subject options) but for
    // hitCount instead of amount, and DealDamage-only since hitCount only
    // exists there. Deliberately NOT gated behind xEligible/xStarEligible
    // — independent of amount's own X state, per Tyler's own example
    // (amount = X, hit count = per stack, at the same time).
    if (act.hitCountScalesWithStatus || act.hitCountScalesWithBuiltinStatus || act.hitCountScalesWithStatusKind) {
      if (act.type !== 'DealDamage') {
        errors.push(`${p}: hitCountScalesWith* is only meaningful on "DealDamage" — action type is "${act.type}".`);
      }
      const hcScaleKind = act.hitCountScalesWithStatusKind === 'vanilla' ? 'vanilla' : 'custom';
      if (act.hitCountScalesWithStatusKind !== undefined && !['vanilla', 'custom'].includes(act.hitCountScalesWithStatusKind)) {
        errors.push(`${p}.hitCountScalesWithStatusKind "${act.hitCountScalesWithStatusKind}" is not one of: vanilla, custom.`);
      } else if (hcScaleKind === 'vanilla') {
        if (!isNonEmptyString(act.hitCountScalesWithBuiltinStatus)) errors.push(`${p}.hitCountScalesWithStatusKind is "vanilla" but hitCountScalesWithBuiltinStatus is missing.`);
        else if (!BUILTIN_STATUSES.includes(act.hitCountScalesWithBuiltinStatus)) errors.push(`${p}.hitCountScalesWithBuiltinStatus "${act.hitCountScalesWithBuiltinStatus}" is not one of the known built-in statuses.`);
      } else if (!isNonEmptyString(act.hitCountScalesWithStatus)) {
        errors.push(`${p}.hitCountScalesWithStatusKind is "custom" but hitCountScalesWithStatus is missing.`);
      } else if (!mechanicIds.has(act.hitCountScalesWithStatus)) {
        errors.push(`${p}.hitCountScalesWithStatus "${act.hitCountScalesWithStatus}" doesn't match any defined mechanic id.`);
      }
      if (act.hitCountScalesWithSubject !== undefined && !['Target', 'Self', 'AllEnemies'].includes(act.hitCountScalesWithSubject)) {
        errors.push(`${p}.hitCountScalesWithSubject "${act.hitCountScalesWithSubject}" is not one of: Target, Self, AllEnemies.`);
      } else if (act.hitCountScalesWithSubject === 'Target' && xContext.trigger !== undefined && TARGETLESS_BOUND_HOOK_TRIGGERS.has(xContext.trigger)) {
        errors.push(`${p}.hitCountScalesWithSubject is "Target" but trigger "${xContext.trigger}" only exposes one real Creature (bound as fgPlayer), no second party — use "Self" instead.`);
      }
      // Hit count can only have one source — same one-source-per-field
      // rule amountIsX/amountIsStarX/amountScalesWith* already follow.
      if (act.hitCountIsX === true) errors.push(`${p}: hitCountIsX and hitCountScalesWith* can't both be set — they're alternate sources for the same hit count, not stackable.`);
      if (act.hitCountIsStarX === true) errors.push(`${p}: hitCountIsStarX and hitCountScalesWith* can't both be set — they're alternate sources for the same hit count, not stackable.`);
    }
    // mode — ModifyStatus/ModifyOrbSlots read Add/Remove, ModifyHp/
    // ModifyGold/ModifyEnergy read Gain/Lose, no other type reads it at all
    // (see MODE_ACTIONS above / schema's `mode` description). Required
    // whenever the type is one of the mode-driven types — an undefined
    // mode would leave compiler.js's own `action.mode === 'X' ? 'X' :
    // <default>` fallback to silently pick a default the user never
    // actually chose, so (unlike several other optional fields in this
    // file) this is enforced as required, not merely type-checked-if-present.
    const modePair = MODE_ACTIONS[act.type];
    if (modePair) {
      if (!modePair.includes(act.mode)) {
        errors.push(`${p}: action "${act.type}" requires mode to be one of: ${modePair.join(', ')} (got ${JSON.stringify(act.mode)}).`);
      }
    } else if (act.mode !== undefined && !['Add', 'Remove', 'Gain', 'Lose'].includes(act.mode)) {
      errors.push(`${p}.mode "${act.mode}" is not one of: Add, Remove, Gain, Lose.`);
    }
    // scope — ModifyCost only (round 193). Same real two-option choice
    // (which CardEnergyCost.Add{Scope} overload to call) as
    // card.advancedOptions.costReductions[].scope already validates below
    // — optional (defaults to "ThisCombat" in compiler.js's ModifyCost
    // case), so only type-checked when present, not required.
    if (act.scope !== undefined && act.type !== 'ModifyCost') {
      errors.push(`${p}: scope is only meaningful on "ModifyCost" — action type is "${act.type}".`);
    } else if (act.scope !== undefined && !CARD_COST_REDUCTION_SCOPES.includes(act.scope)) {
      errors.push(`${p}.scope "${act.scope}" is not one of: ${CARD_COST_REDUCTION_SCOPES.join(', ')}.`);
    }
    // statusEntries[] — ModifyStatus only. Replaces the old separate
    // builtinStatuses[]/statusRefs[] + statusAmounts{}/refAmounts{} — see
    // this const's own comment on the schema and compiler.js's
    // "ModifyStatus" actionToCSharp case for the full reasoning. Required,
    // non-empty; every entry's kind/ref cross-checked exactly the way
    // compiler.js itself resolves them, INCLUDING the mode-gated
    // protected-constructor restriction (a vanilla entry naming one of the
    // 3 PROTECTED_CTOR_BUILTIN_POWERS classes is fine for Remove but not
    // for Add — see compiler.js:PROTECTED_CTOR_BUILTIN_POWERS) so that
    // specific failure is caught here instead of only at generateProject()
    // time.
    if (act.type === 'ModifyStatus') {
      const entries = Array.isArray(act.statusEntries) ? act.statusEntries : [];
      if (!entries.length) {
        errors.push(`${p}: action "ModifyStatus" requires at least one entry in statusEntries[] (which status(es)/mechanic(s)).`);
      } else {
        entries.forEach((entry, ei) => {
          const ep = `${p}.statusEntries[${ei}]`;
          if (!entry || typeof entry !== 'object') { errors.push(`${ep} must be an object.`); return; }
          const kind = entry.kind === 'vanilla' ? 'vanilla' : (entry.kind === 'custom' ? 'custom' : undefined);
          if (kind === undefined) { errors.push(`${ep}.kind "${entry.kind}" is not one of: vanilla, custom.`); return; }
          if (!isNonEmptyString(entry.ref)) { errors.push(`${ep} has kind "${kind}" but no ref.`); return; }
          if (kind === 'vanilla') {
            const allVanillaPowers = BUILTIN_STATUSES.concat(PROTECTED_CTOR_BUILTIN_POWERS);
            if (!allVanillaPowers.includes(entry.ref)) {
              errors.push(`${ep}.ref "${entry.ref}" is not one of the known built-in statuses.`);
            } else if (act.mode === 'Add' && PROTECTED_CTOR_BUILTIN_POWERS.includes(entry.ref)) {
              errors.push(`${ep}.ref "${entry.ref}" has a protected constructor (confirmed via reflect-baselib) — it can be Removed but not Added; this action's mode is "Add".`);
            }
          } else if (!mechanicIds.has(entry.ref)) {
            errors.push(`${ep}.ref "${entry.ref}" doesn't match any defined mechanic id.`);
          }
          if (entry.amount !== undefined && typeof entry.amount !== 'number') errors.push(`${ep}.amount must be a number if present.`);
        });
      }
    }
    // drawNextTurn / doubleEnergy / random — simple type-restricted
    // booleans, one per newly-split-out checkbox Tyler asked for (DrawCard/
    // ModifyEnergy/DiscardCard+ExhaustCard respectively; ModifyEnergy was
    // "GainEnergy" before round 159's sign-based Gain/Lose consolidation —
    // see compiler.js's ModifyEnergy case for the full reasoning).
    // All [UNVERIFIED] — see their schema descriptions — validated here
    // purely for shape and applicability, same "reject clearly rather than
    // silently accept something broken" convention as hitCount/hitCountIsX
    // above.
    if (act.drawNextTurn !== undefined) {
      if (typeof act.drawNextTurn !== 'boolean') errors.push(`${p}.drawNextTurn must be a boolean if present.`);
      if (act.type !== 'DrawCard') errors.push(`${p}: drawNextTurn is only meaningful on "DrawCard" — action type is "${act.type}".`);
    }
    if (act.doubleEnergy !== undefined) {
      if (typeof act.doubleEnergy !== 'boolean') errors.push(`${p}.doubleEnergy must be a boolean if present.`);
      if (act.type !== 'ModifyEnergy') errors.push(`${p}: doubleEnergy is only meaningful on "ModifyEnergy" — action type is "${act.type}".`);
    }
    if (act.random !== undefined) {
      if (typeof act.random !== 'boolean') errors.push(`${p}.random must be a boolean if present.`);
      if (act.type !== 'DiscardCard' && act.type !== 'ExhaustCard') errors.push(`${p}: random is only meaningful on "DiscardCard"/"ExhaustCard" — action type is "${act.type}".`);
    }
    // destination / tokenRefKind / tokenRef / tokenVanillaRef — CreateCard
    // only, replacing the old separate CreateCardInHand/CreateCardInDrawPile
    // types. All optional with a compiler.js-side fallback (destination ->
    // "Hand", tokenRefKind -> "custom") so these are only type/cross-
    // reference-checked when present, not required outright — mirrors how
    // leniently compiler.js's own "CreateCard" case already reads them.
    if (act.destination !== undefined && !['Hand', 'DrawPile', 'Discard'].includes(act.destination)) {
      errors.push(`${p}.destination "${act.destination}" is not one of: Hand, DrawPile, Discard.`);
    }
    if (act.destination !== undefined && act.type !== 'CreateCard') {
      errors.push(`${p}: destination is only meaningful on "CreateCard" — action type is "${act.type}".`);
    }
    if (act.tokenRefKind !== undefined) {
      if (!['custom', 'vanilla'].includes(act.tokenRefKind)) errors.push(`${p}.tokenRefKind "${act.tokenRefKind}" is not one of: custom, vanilla.`);
      if (act.type !== 'CreateCard') errors.push(`${p}: tokenRefKind is only meaningful on "CreateCard" — action type is "${act.type}".`);
    }
    if (act.type === 'CreateCard') {
      const tokenKind = act.tokenRefKind === 'vanilla' ? 'vanilla' : 'custom';
      if (tokenKind === 'vanilla') {
        if (act.tokenVanillaRef !== undefined && !VANILLA_TOKEN_CARDS.includes(act.tokenVanillaRef)) {
          errors.push(`${p}.tokenVanillaRef "${act.tokenVanillaRef}" is not one of: ${VANILLA_TOKEN_CARDS.join(', ')} (this list is [UNVERIFIED] — see compiler.js:VANILLA_TOKEN_CARDS).`);
        }
      } else if (act.tokenRef !== undefined && !cardIds.has(act.tokenRef)) {
        // Round 20 — an empty tokenRef is a real, common case (a UI bug,
        // now fixed in frontend/index.html's ensureActionRefDefaults, used
        // to leave it this way whenever this action was set up before any
        // Token-rarity card existed yet) rather than a corrupted reference
        // — worded differently so it reads as "pick one" instead of "this
        // value is wrong."
        if (act.tokenRef === '') {
          errors.push(`${p}: action "CreateCard" needs a token card selected — pick one from the dropdown, or add a Token-rarity card first if none exist yet (Cards section, rarity "Token").`);
        } else {
          errors.push(`${p}.tokenRef "${act.tokenRef}" doesn't match any defined card id.`);
        }
      }
    } else {
      if (act.tokenRef !== undefined) errors.push(`${p}: tokenRef is only meaningful on "CreateCard" — action type is "${act.type}".`);
      if (act.tokenVanillaRef !== undefined) errors.push(`${p}: tokenVanillaRef is only meaningful on "CreateCard" — action type is "${act.type}".`);
    }
    // [Round 197] afflictionRef / enchantmentRef -- AfflictCard/
    // EnchantCard only, same "reject an empty pick with a friendlier
    // message, reject a stale/unknown id otherwise" shape as CreateCard's
    // tokenRef right above.
    if (act.type === 'AfflictCard') {
      if (act.afflictionRef === '' || act.afflictionRef === undefined) {
        errors.push(`${p}: action "AfflictCard" needs an affliction selected — pick one from the dropdown, or add an Affliction first if none exist yet (Enchantments & Afflictions section).`);
      } else if (!afflictionIds.has(act.afflictionRef)) {
        errors.push(`${p}.afflictionRef "${act.afflictionRef}" doesn't match any defined affliction id.`);
      }
    } else if (act.afflictionRef !== undefined) {
      errors.push(`${p}: afflictionRef is only meaningful on "AfflictCard" — action type is "${act.type}".`);
    }
    if (act.type === 'EnchantCard') {
      if (act.enchantmentRef === '' || act.enchantmentRef === undefined) {
        errors.push(`${p}: action "EnchantCard" needs an enchantment selected — pick one from the dropdown, or add an Enchantment first if none exist yet (Enchantments & Afflictions section).`);
      } else if (!enchantmentIds.has(act.enchantmentRef)) {
        errors.push(`${p}.enchantmentRef "${act.enchantmentRef}" doesn't match any defined enchantment id.`);
      }
    } else if (act.enchantmentRef !== undefined) {
      errors.push(`${p}: enchantmentRef is only meaningful on "EnchantCard" — action type is "${act.type}".`);
    }
    // [Round 155] retainThisTurn — Tyler's companion checkbox: "There
    // should also be a check box to 'retain the card this turn' if the
    // return to hand is selected." Simple type-restricted boolean, same
    // shape as drawNextTurn/doubleEnergy/random above.
    if (act.retainThisTurn !== undefined) {
      if (typeof act.retainThisTurn !== 'boolean') errors.push(`${p}.retainThisTurn must be a boolean if present.`);
      if (act.type !== 'ReturnToHand') errors.push(`${p}: retainThisTurn is only meaningful on "ReturnToHand" — action type is "${act.type}".`);
    }
    // [Round 155] ReturnToHand ("Return This Card To Hand") — Tyler: "add
    // a 'return this card to hand' effect for the pile triggers that
    // arent in hand." Hard-rejected outside its one real, eligible
    // context: a card's own "While in a pile" effect block (entityKind
    // 'card', trigger one of the real PILE_TRIGGER_HOOK_IDS — the
    // hand-only OnTurnEndInHand is deliberately excluded, mirroring
    // frontend/index.html's returnToHandEligibleNow()) whose OWN pile
    // isn't "Hand" — a card can't "return" to the pile it's already
    // sitting in. Pile defaults to "Hand" when omitted, same default the
    // whileInHand.pile check above (and compiler.js's own pileTypeExpr)
    // already use, so an omitted xContext.pile is treated as "Hand" here
    // too rather than silently passing.
    if (act.type === 'ReturnToHand') {
      const effectivePile = xContext.pile || 'Hand';
      // [Round 195] OnAnyCardPlayed is eligible too, same reasoning as the
      // 15 PILE_TRIGGER_HOOK_IDS above — it's now a real, per-entry
      // pile-gated whileInHand trigger (compiler.js:whileInHandMergeLines),
      // and ReturnToHand's own codegen only needs ctx.thisIsCard (true
      // there), not a specific hook shape.
      const eligible = xContext.entityKind === 'card'
        && xContext.trigger !== undefined
        && (PILE_TRIGGER_HOOK_IDS.includes(xContext.trigger) || xContext.trigger === 'OnAnyCardPlayed')
        && effectivePile !== 'Hand';
      if (!eligible) {
        errors.push(`${p}: action "ReturnToHand" ("Return This Card To Hand") is only valid inside a card's own "While in a pile" effect whose pile isn't "Hand" — got entityKind=${xContext.entityKind || 'unknown'}, trigger=${xContext.trigger || 'unknown'}, pile=${effectivePile}. A card can't return to a pile it's already in.`);
      }
    }
    // amount SCALING with a status's stack count — Tyler's request:
    // "status needs a 'do this thing equal to the number of stacks of the
    // status I have' like poison." This field existed in the schema
    // already (an earlier round added it) but was never wired into
    // codegen/UI — this closes that gap. Mirrors the vanilla/custom split
    // already used for HasStatusStacks: `amountScalesWithStatusKind`
    // ('vanilla'|'custom', defaults to 'custom' — the only kind this field
    // supported before this round) picks whether `amountScalesWithBuiltinStatus`
    // (vanilla, e.g. real Poison) or `amountScalesWithStatus` (custom
    // mechanic id, unchanged) is read. Always reads the ACTING PLAYER's own
    // stacks — "the status I have", Tyler's own wording — see
    // compiler.js:resolveAmountExpr.
    if (act.amountScalesWithStatus || act.amountScalesWithBuiltinStatus || act.amountScalesWithStatusKind) {
      const scaleKind = act.amountScalesWithStatusKind === 'vanilla' ? 'vanilla' : 'custom';
      if (act.amountScalesWithStatusKind !== undefined && !['vanilla', 'custom'].includes(act.amountScalesWithStatusKind)) {
        errors.push(`${p}.amountScalesWithStatusKind "${act.amountScalesWithStatusKind}" is not one of: vanilla, custom.`);
      } else if (scaleKind === 'vanilla') {
        if (!isNonEmptyString(act.amountScalesWithBuiltinStatus)) errors.push(`${p}.amountScalesWithStatusKind is "vanilla" but amountScalesWithBuiltinStatus is missing.`);
        else if (!BUILTIN_STATUSES.includes(act.amountScalesWithBuiltinStatus)) errors.push(`${p}.amountScalesWithBuiltinStatus "${act.amountScalesWithBuiltinStatus}" is not one of the known built-in statuses.`);
      } else if (!isNonEmptyString(act.amountScalesWithStatus)) {
        errors.push(`${p}.amountScalesWithStatusKind is "custom" but amountScalesWithStatus is missing.`);
      } else if (!mechanicIds.has(act.amountScalesWithStatus)) {
        errors.push(`${p}.amountScalesWithStatus "${act.amountScalesWithStatus}" doesn't match any defined mechanic id.`);
      }
      // "whose stacks" — Tyler's follow-up when the DealDamage row gained
      // its sentence layout: "we need to add a new box for per stack that
      // checks whose stacks to reference." Optional; undefined reads as
      // "Self" everywhere downstream (frontend default + compiler.js), the
      // only subject this ever checked before this field existed — see the
      // schema's own description for the full reasoning, including why
      // AllEnemies is still allowed through despite having no real codegen
      // behind it yet (same "compiles but throws" convention as everywhere
      // else in this app).
      if (act.amountScalesWithSubject !== undefined && !['Target', 'Self', 'AllEnemies'].includes(act.amountScalesWithSubject)) {
        errors.push(`${p}.amountScalesWithSubject "${act.amountScalesWithSubject}" is not one of: Target, Self, AllEnemies.`);
      } else if (act.amountScalesWithSubject === 'Target' && xContext.trigger !== undefined && TARGETLESS_BOUND_HOOK_TRIGGERS.has(xContext.trigger)) {
        // Same CS0103 risk as the SingleEnemy check above — "Target" here
        // resolves to fgTarget, which this trigger's hook body never binds.
        errors.push(`${p}.amountScalesWithSubject is "Target" but trigger "${xContext.trigger}" only exposes one real Creature (bound as fgPlayer), no second party — use "Self" instead.`);
      }
    }
    if (act.cardRef && !cardIds.has(act.cardRef)) {
      errors.push(`${p}.cardRef "${act.cardRef}" doesn't match any defined card id.`);
    }
    // followUp — Tyler's "follow up" ask (added 2026-08-27, see
    // actionsArray's followUp field in schema/character.schema.json for the
    // full evidence writeup). DealDamage-only, same "reject clearly rather
    // than silently do nothing" convention as hitCount/hitCountIsX above.
    // Nested `actions[]` are validated with the SAME xContext this action
    // itself was validated under (amountIsX/hitCountIsX eligibility doesn't
    // change just because an action is inside a follow-up rather than a
    // top-level effect — it's still the same card/trigger).
    if (act.followUp !== undefined) {
      if (act.type !== 'DealDamage') {
        errors.push(`${p}: followUp is only meaningful on "DealDamage" — action type is "${act.type}".`);
      } else if (!act.followUp || typeof act.followUp !== 'object') {
        errors.push(`${p}.followUp must be an object if present.`);
      } else {
        const FOLLOWUP_TRIGGERS = ['BrokeBlock', 'KilledTarget', 'FullyBlocked', 'UnblockedAmount'];
        if (!FOLLOWUP_TRIGGERS.includes(act.followUp.trigger)) {
          errors.push(`${p}.followUp.trigger "${act.followUp.trigger}" is not one of: ${FOLLOWUP_TRIGGERS.join(', ')}.`);
        }
        // UnblockedAmount (2026-08-27 expansion round) is the one followUp
        // trigger that isn't a plain boolean — it needs comparator+value to
        // compare DamageResult.UnblockedDamage against, same shape as any
        // other comparator-using condition kind. The other 3 triggers stay
        // boolean-only; comparator/value are ignored (and not required) for
        // them.
        if (act.followUp.trigger === 'UnblockedAmount') {
          if (!COMPARATORS.includes(act.followUp.comparator)) {
            errors.push(`${p}.followUp.comparator "${act.followUp.comparator}" is not one of: ${COMPARATORS.join(', ')}.`);
          }
          if (typeof act.followUp.value !== 'number') errors.push(`${p}.followUp.value must be a number.`);
        }
        if (!Array.isArray(act.followUp.actions) || !act.followUp.actions.length) {
          errors.push(`${p}.followUp.actions must be a non-empty array.`);
        } else {
          validateActions(act.followUp.actions, p, errors, mechanicIds, cardIds, afflictionIds, enchantmentIds, 'followUp.actions', xContext);
        }
      }
    }
  });
}

// [Fix, round 34 — Tyler: "we should warn the user if any loops are present in
// their triggers/effects", following round 33's single hardcoded
// AfterDamageGiven+DealDamage crash fix. This generalizes that into a real,
// IL-verified table: every entry below was found by disassembling the ACTUAL
// real sts2.dll method the action type's ForgeActions helper calls, and
// confirming a direct, unconditional `call Hook.<Method>` inside it — the
// exact same mechanism round 33 proved for DealDamage/AfterDamageGiven via a
// real Windows minidump (STATUS_STACK_OVERFLOW) + full IL trail. Every pair
// below is a GUARANTEED, unconditional infinite recursion if an effect whose
// OWN trigger is the key fires an action matching that key's predicate —
// not a maybe, not a "could theoretically" — the real base game's Hook
// dispatcher unconditionally calls back into every listening model,
// including the one whose own effect just caused it. See
// TOOLCHAIN_FINDINGS.md "general trigger/effect loop detection (round 34)"
// for the full per-pair IL trail (methoddef rid/rva for every hop).
//
// Two real action types were independently checked this round and found
// SAFE — deliberately left OUT of this table, not simply unconsidered:
//   - ModifyHp (both Gain/Heal and Lose): compiles to
//     Creature.HealInternal/LoseHpInternal, called DIRECTLY — neither one
//     calls into any Hook.* dispatcher at all (confirmed by direct IL read).
//     AfterCurrentHpChanged is a real, selectable trigger, but nothing
//     ModifyHp does can ever cause it to fire, so it can't self-loop.
//   - GainBlock: compiles to Creature.GainBlockInternal, same story — no
//     Hook call anywhere in its real IL. AfterBlockGained is real and
//     selectable but GainBlock can't cause it to fire either.
// ModifyStatus is intentionally asymmetric below: only the mode:"Add" +
// target:"AllEnemies" combination (which compiles to
// ForgeActions.ApplyStatusAllEnemies<T> -> the real PowerCmd.Apply<T>) was
// proven to call Hook.AfterPowerAmountChanged. The single-target path
// (Self/SingleEnemy/RandomEnemy, mode:"Add") compiles to
// ForgeActions.ApplyStatus<T> -> Creature.ApplyPowerInternal instead, which
// does NOT call that hook (same direct-IL-read method) — confirmed safe,
// left unflagged. mode:"Remove" (either target) never applies a power so
// can't fire this hook either way.
// [Fix, round 35 -- Tyler: "'After block is broken' currently triggers on
// when your block or when an enemy's block is broken. Those should be two
// separate triggers... we need to take a look at all of the triggers that
// happen to both the player as well as to the enemies."] Old ambiguous
// trigger id -> plain-English name(s) of its real replacement(s), used
// only to build a clear migration error message above (RETIRED_
// AMBIGUOUS_TRIGGERS[t] is truthy for exactly the 13 ids this round
// removed from HOOK_TRIGGERS). Tyler's own migration choice was explicit:
// "Fail loud — reject the old trigger name, you pick the side manually"
// — so this is deliberately NOT an auto-remap table.
const RETIRED_AMBIGUOUS_TRIGGERS = {
  AfterDamageGiven: '"After you deal damage" or "After an enemy deals damage"',
  OnTakeDamage: '"When you take damage" or "When an enemy takes damage"',
  AfterBlockBroken: '"After your block is broken" or "After an enemy\'s block is broken"',
  BeforeDamageReceived: '"Before you receive damage" or "Before an enemy receives damage"',
  AfterBlockCleared: '"After your block is cleared" or "After an enemy\'s block is cleared"',
  AfterBlockGained: '"After you gain block" or "After an enemy gains block"',
  AfterCurrentHpChanged: '"After your HP changes" or "After an enemy\'s HP changes"',
  BeforeDeath: '"Before you die" or "Before an enemy dies"',
  AfterPowerAmountChanged: '"After you change a power\'s stacks" or "After an enemy changes a power\'s stacks"',
  AfterPreventingDeath: '"After your death is prevented" or "After an enemy\'s death is prevented"',
  OnTurnStart: '"At the start of your turn" or "At the start of an enemy\'s turn"',
  OnTurnEnd: '"At the end of your turn" or "At the end of an enemy\'s turn"',
  // Not a Mine/Enemy pair -- repurposed to enemy-only, see
  // backend/compiler.js:TRIGGER_HOOKS.AfterEnemyAddedToCombat's own
  // comment for why there's no "mine" replacement here.
  AfterCreatureAddedToCombat: '"After an enemy is added to combat" (the "mine" case was redundant with "When combat starts" -- see TOOLCHAIN_FINDINGS.md)',
};

const TRIGGER_SELF_LOOP_ACTIONS = {
  // [Fix, round 33; re-verified round 34] CreatureCmd.Damage — the real call
  // BOTH the card path (AttackCommand.Execute, confirmed round 34 by direct
  // IL read: Execute calls CreatureCmd::Damage directly) and the
  // relic/mechanic path use — unconditionally calls Hook.AfterDamageGiven.
  // NOTE: there is only ever ONE schema-level action.type for this,
  // 'DealDamage' — a "Deal Damage" action with target:"AllEnemies" still has
  // type:"DealDamage" (compiler.js's DealDamage case picks the real
  // ForgeActions.DealDamageAllEnemies C# helper internally based on
  // action.target, it's not a separate schema-level type) — so round 33's
  // original, target-unfiltered a.type === 'DealDamage' check already
  // covered the AllEnemies case too. Round 34 independently re-confirmed
  // that by disassembling AttackCommand.Execute directly (the AllEnemies
  // target still funnels through it) rather than just assuming.
  // [Fix, round 35] Split into AfterMyDamageGiven/AfterEnemyDamageGiven
  // (see backend/compiler.js:TRIGGER_HOOKS) -- the real danger is
  // unchanged by which side triggered it, so both new ids are keyed here.
  AfterMyDamageGiven: (a) => a && a.type === 'DealDamage',
  AfterEnemyDamageGiven: (a) => a && a.type === 'DealDamage',
  // [Fix, round 34] PowerCmd.Apply<T>'s real async body (<Apply>d__2.MoveNext)
  // calls Hook.AfterPowerAmountChanged directly — this is the exact real
  // call ForgeActions.ApplyStatusAllEnemies<T> uses, i.e. what
  // ModifyStatus(mode:"Add", target:"AllEnemies") compiles to.
  // [Fix, round 35] Split into AfterMyPowerAmountChanged/
  // AfterEnemyPowerAmountChanged (see backend/compiler.js:TRIGGER_HOOKS)
  // -- same real danger either side, both new ids keyed here.
  AfterMyPowerAmountChanged: (a) => a && a.type === 'ModifyStatus' && a.mode !== 'Remove' && a.target === 'AllEnemies',
  AfterEnemyPowerAmountChanged: (a) => a && a.type === 'ModifyStatus' && a.mode !== 'Remove' && a.target === 'AllEnemies',
  // [Fix, round 34] PlayerCmd.GainGold's real async body calls
  // Hook.AfterGoldGained directly (confirmed via IL). PlayerCmd.LoseGold
  // (ModifyGold mode:"Lose") is a plain SYNCHRONOUS method with no Hook call
  // anywhere in it (confirmed the same way, not even an async state
  // machine) — only Gain mode (the default when mode is unset) is flagged.
  AfterGoldGained: (a) => a && a.type === 'ModifyGold' && a.mode !== 'Lose',
  // [Fix, round 34] CardPileCmd.Draw's real internal async body
  // (<DrawInternal>d__21.MoveNext) calls Hook.AfterCardDrawn directly —
  // confirmed via IL. Only relics/mechanics can select "OnDrawCard" as a
  // trigger at all (see CARD_TRIGGERS above — cards can't), so this only
  // ever matters there.
  OnDrawCard: (a) => a && a.type === 'DrawCard',
  // [Fix, round 34] CardCmd.Exhaust's real async body
  // (<Exhaust>d__6.MoveNext) calls Hook.AfterCardExhausted directly —
  // confirmed via IL. Same relic/mechanic-only scope as OnDrawCard above
  // (cards can't select "OnExhaust" as a trigger either).
  OnExhaust: (a) => a && a.type === 'ExhaustCard',
  // [Fix, round 34] CardCmd.DiscardAndDraw (the real method CardCmd.Discard
  // delegates into for its actual work) calls Hook.AfterCardDiscarded
  // directly — confirmed via IL. This is the relic/mechanic-facing
  // "AfterCardDiscarded" trigger (HOOK_TRIGGERS — fires for ANY card
  // discarded by anyone, no filter) — deliberately NOT the card-facing
  // "OnDiscard" trigger (CARD_TRIGGERS), which real IL/schema evidence
  // (selfFilter: true in compiler.js's CARD_TRIGGER_HOOKS) shows only fires
  // for "this exact card instance was discarded"; by the time that runs,
  // the triggering card has already left hand and can't be re-selected by
  // its own DiscardCard action, so that specific case is real and
  // confirmed-safe — left unflagged on purpose, not overlooked.
  AfterCardDiscarded: (a) => a && a.type === 'DiscardCard',
};

function validateEffects(effects, path, errors, { allowedTriggers, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind, gameplayTagsInUse, cardCostsX, cardCostsStarX }) {
  if (!Array.isArray(effects)) { errors.push(`${path}.effects must be an array.`); return; }
  const xContext = { entityKind, cardCostsX, cardCostsStarX };
  effects.forEach((eff, i) => {
    const p = `${path}.effects[${i}]`;
    if (!eff || typeof eff !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!allowedTriggers.includes(eff.trigger)) {
      if (eff.trigger === 'OnPlay' && entityKind !== 'card') {
        errors.push(`${p}.trigger is "OnPlay" — that doesn't apply to a ${entityKind} (a ${entityKind} isn't "played", that's card-only). Valid triggers here: ${allowedTriggers.join(', ')}.`);
      } else if (RETIRED_AMBIGUOUS_TRIGGERS[eff.trigger]) {
        // [Fix, round 35 -- Tyler: "we need to take a look at all of the
        // triggers that happen to both the player as well as to the
        // enemies," migration choice: "Fail loud — reject the old trigger
        // name, you pick the side manually."] A clearer, more actionable
        // error than the generic "not one of" fallback below for the 13
        // ids retired this round specifically — names the real
        // replacement(s) instead of making the user hunt through the
        // full trigger list.
        errors.push(`${p}.trigger "${eff.trigger}" no longer exists — it used to fire for BOTH your side and the enemy's with no way to tell them apart, and has been split so effects can react to just one. Pick ${RETIRED_AMBIGUOUS_TRIGGERS[eff.trigger]} instead.`);
      } else if (entityKind === 'card') {
        errors.push(`${p}.trigger is "${eff.trigger}" — cards only support ${allowedTriggers.join(', ')} (no other card hook is confirmed real yet). This used to silently compile with the effect dropped entirely; it's rejected outright now instead.`);
      } else {
        errors.push(`${p}.trigger "${eff.trigger}" is not one of: ${allowedTriggers.join(', ')}.`);
      }
    }
    validateConditions(eff.conditions, p, errors, mechanicIds, cardIds, relicIds, eff.trigger, gameplayTagsInUse);
    // [Fix, round 33 — real crash: a genuine, mechanistically-proven
    // infinite-recursion stack overflow, root-caused via a real Windows
    // minidump (STATUS_STACK_OVERFLOW, ~thousands of uniformly-repeated
    // JIT-code return addresses filling an 8MB thread stack) plus direct
    // sts2.dll IL evidence at every hop of the real call chain:
    //   CreatureCmd.Damage(...) [the exact real call ForgeActions.DealDamage's
    //   relic/mechanic path uses, see round 30] -> the real base-game
    //   MegaCrit.Sts2.Core.Hooks.Hook.AfterDamageGiven(...) (a real, STATIC,
    //   GLOBAL dispatcher — fires for ANY damage dealt by ANYONE in combat,
    //   not scoped to this relic's own owner) -> iterates
    //   ICombatState.IterateHookListeners() and calls .AfterDamageGiven(...)
    //   on EVERY listening model, including this one -> if that override's
    //   own effect is itself a DealDamage action, it calls straight back
    //   into ForgeActions.DealDamage -> CreatureCmd.Damage -> the same real
    //   Hook.AfterDamageGiven dispatcher again -> forever, guaranteed, no
    //   condition required. See TOOLCHAIN_FINDINGS.md "another of the same
    //   crash... 1 strike and 1 defend" for the full IL trail (every call
    //   site's exact token/RVA). This is REJECTED outright (not just a
    //   Todo-stub or a runtime guard) because there is currently no real,
    //   confirmed-safe way for a DealDamage action on this specific trigger
    //   to avoid it — unlike ModifyHp's LoseHp path (a different real call,
    //   not yet independently confirmed to skip this same dispatcher, but
    //   also not proven to hit it — left unrestricted rather than guessed
    //   at either way).
    // [Fix, round 34] general, table-driven version of round 33's single
    // hardcoded AfterDamageGiven+DealDamage check — see
    // TRIGGER_SELF_LOOP_ACTIONS above for the full evidence trail on every
    // pair it covers (all real, IL-confirmed, unconditional infinite loops).
    const loopCheck = TRIGGER_SELF_LOOP_ACTIONS[eff.trigger];
    if (loopCheck) {
      const findLoopAction = (arr) => Array.isArray(arr) ? arr.find(a => loopCheck(a)) : undefined;
      const offender = findLoopAction(eff.actions) || findLoopAction(eff.elseActions);
      if (offender) {
        errors.push(`${p}: a "${offender.type}" action on the "${eff.trigger}" trigger is a GUARANTEED infinite loop / game crash (real, IL-confirmed — this action's own real game API call re-fires the exact same "${eff.trigger}" hook this effect is listening on, unconditionally, forever, until the stack overflows — the same STATUS_STACK_OVERFLOW mechanism round 33's AfterDamageGiven+DealDamage crash was proven to be via a real Windows minidump). Remove this action from this effect, or trigger it a different way that doesn't react to the same event it causes. See TOOLCHAIN_FINDINGS.md for the specific real call chain proving this pair.`);
      }
    }
    // [Round 155] pile: eff.pile joins trigger in the per-effect xContext
    // spread — ReturnToHand is only ever valid inside a "While in a pile"
    // entry whose OWN pile isn't Hand (see validateActions' own
    // ReturnToHand check below), so validateActions needs the pile this
    // specific effect block is scoped to, not just its trigger.
    validateActions(eff.actions, p, errors, mechanicIds, cardIds, afflictionIds, enchantmentIds, 'actions', { ...xContext, trigger: eff.trigger, pile: eff.pile });
    // elseActions — Tyler's "if X, deal 12, else deal 5" ask. Optional
    // (undefined means "no else branch", same as an empty array) — only
    // validated when present, but when present AND non-empty, this effect
    // block needs at least one condition to actually branch on; an
    // "else" with nothing to be the opposite of would just be a second,
    // silently-unreachable-looking set of actions (compiler.js's
    // effectBlockToCSharp only ever emits an else clause inside an `if`,
    // so elseActions on a condition-less block would compile to nothing
    // at all — rejected here instead of shipping a UI-visible action list
    // that quietly never runs).
    if (eff.elseActions !== undefined) {
      validateActions(eff.elseActions, p, errors, mechanicIds, cardIds, afflictionIds, enchantmentIds, 'elseActions', { ...xContext, trigger: eff.trigger, pile: eff.pile });
    }
    if (Array.isArray(eff.elseActions) && eff.elseActions.length && (!Array.isArray(eff.conditions) || !eff.conditions.length)) {
      errors.push(`${p}.elseActions has entries but ${p}.conditions is empty — "else" only makes sense with an "if" condition above it to be the opposite of. Add a condition, or remove the else actions.`);
    }
  });
}

// Group B modifier validation (round 20) — a `modifiers[]` entry gates or
// tweaks a real value-returning AbstractModel override (see
// compiler.js:MODIFIER_HOOKS/generateModifierOverrides) rather than firing
// an event, so it doesn't fit validateEffects' trigger/action shape at all.
// Each entry needs a real hook name (checked against MODIFIER_HOOKS itself
// — the same map compiler.js uses to generate the C#, one source of truth,
// not a second hand-maintained list) plus whichever extra field(s) its
// shape actually reads: gate -> gateValue, numeric -> numericValue (+
// numericMode, but only on a hook that doesn't lock its own op — see
// MODIFIER_HOOKS' lockedOp), tryRefNumeric -> setValue, keywordSet ->
// keywordOp + keyword. The 7 'deferred' hooks (CardLocation/RestSiteOption/
// etc. construction not yet researched — see
// claude/round20-groupb-findings.md) need nothing beyond a valid hook name:
// compiler.js emits an honest ForgeActions.Todo(...) stub for those and
// never reads mod.conditions or any shape-specific field at all (see
// generateModifierOverrides' early `shape === 'deferred'` branch), so this
// function doesn't require — or validate — any of that here either, same
// "compiles but throws, not misleadingly" convention as every other
// [UNVERIFIED]/deferred surface in this project.
function validateModifiers(modifiers, path, errors, mechanicIds, cardIds, relicIds, gameplayTagsInUse) {
  if (modifiers === undefined) return;
  if (!Array.isArray(modifiers)) { errors.push(`${path}.modifiers must be an array.`); return; }
  // Round 116: every modifier ultimately compiles to `public override
  // <real method>(...)` on the same generated class — two modifiers that
  // both land on the SAME real method is a hard CS0111 ("already defines a
  // member") at build time, not a soft conflict. This was a latent gap
  // even before round 116 (nothing stopped two ModifyDamageAdditive
  // entries on one relic/mechanic), but ReduceHpLossBeforeBlock makes it
  // much easier to hit by accident — it silently emits overrides for BOTH
  // ModifyHpLostBeforeOsty AND ModifyDamageAdditive, so it collides with a
  // plain ModifyHpLostBeforeOsty modifier, a plain ModifyDamageAdditive
  // modifier, or a second ReduceHpLossBeforeBlock, all equally. Tracked by
  // real method name (not mod.hook id) so this catches every one of those
  // cases in one pass.
  const realMethodsUsed = new Map(); // real method name -> first modifier index that claimed it
  modifiers.forEach((mod, i) => {
    const p = `${path}.modifiers[${i}]`;
    if (!mod || typeof mod !== 'object') { errors.push(`${p} must be an object.`); return; }
    const hook = MODIFIER_HOOKS[mod.hook];
    if (!hook) {
      errors.push(`${p}.hook "${mod.hook}" is not one of: ${Object.keys(MODIFIER_HOOKS).join(', ')}.`);
      return;
    }
    const realMethods = hook.shape === 'hpLossDisplayFixed' ? [hook.method, hook.companionMethod] : [hook.method];
    for (const realMethod of realMethods) {
      if (realMethodsUsed.has(realMethod)) {
        const firstIdx = realMethodsUsed.get(realMethod);
        errors.push(`${p}.hook "${mod.hook}" would generate a second "${realMethod}" override on this entity — modifiers[${firstIdx}] already produces one (directly, or as the paired half of a ReduceHpLossBeforeBlock hook). Only one modifier may target a given real method per relic/mechanic.`);
      } else {
        realMethodsUsed.set(realMethod, i);
      }
    }
    if (hook.shape === 'deferred') return;
    validateConditions(mod.conditions, p, errors, mechanicIds, cardIds, relicIds, undefined, gameplayTagsInUse, hook);
    if (hook.shape === 'gate') {
      if (mod.gateValue !== undefined && typeof mod.gateValue !== 'boolean') errors.push(`${p}.gateValue must be a boolean if present.`);
    } else if (hook.shape === 'numeric') {
      if (typeof mod.numericValue !== 'number') errors.push(`${p}.numericValue must be a number.`);
      if (hook.lockedOp) {
        // e.g. ModifyBlockAdditive/ModifyDamageAdditive lock to Add,
        // ModifyBlockMultiplicative/ModifyDamageMultiplicative lock to
        // Multiply, ModifyPowerAmountGivenAdditive locks to Add — the real
        // hook name already says which operation makes sense, and
        // compiler.js ignores numericMode entirely for these (see
        // MODIFIER_HOOKS' lockedOp), so a numericMode here would silently
        // do nothing — rejected outright rather than let the UI show a
        // setting with no effect.
        if (mod.numericMode !== undefined) errors.push(`${p}.numericMode is set but hook "${mod.hook}" locks its operation to "${hook.lockedOp}" (see its name) — remove numericMode, it would be ignored.`);
      } else if (mod.numericMode !== undefined && !['Add', 'Multiply', 'Set'].includes(mod.numericMode)) {
        errors.push(`${p}.numericMode "${mod.numericMode}" is not one of: Add, Multiply, Set.`);
      }
    } else if (hook.shape === 'tryRefNumeric') {
      if (typeof mod.setValue !== 'number') errors.push(`${p}.setValue must be a number.`);
    } else if (hook.shape === 'keywordSet') {
      if (mod.keywordOp !== undefined && !['Add', 'Remove'].includes(mod.keywordOp)) errors.push(`${p}.keywordOp "${mod.keywordOp}" is not one of: Add, Remove.`);
      // [Round 139] validateModifiers doesn't have this character's custom
      // cardKeywords in scope here (it's a top-level function, not a
      // closure over validateCharacterPackage's local customKeywordWords),
      // so a relic/mechanic's TryModifyKeywordsInCombat hook is still
      // restricted to the 7 real built-ins for now — compiler.js's
      // keywordExpr() would actually compile a custom word fine here too
      // (see its own comment), this is just an unwired validation gap, not
      // a real engine restriction. Tyler's actual ask ("the player should
      // see the option to add a keyword to any card they make") is about
      // the per-card editor, which IS fully wired — see frontend/index.html.
      if (!CARD_KEYWORD_VALUES.includes(mod.keyword)) errors.push(`${p}.keyword "${mod.keyword}" is not one of: ${CARD_KEYWORD_VALUES.join(', ')}.`);
    } else if (hook.shape === 'hpLossDisplayFixed') {
      if (typeof mod.numericValue !== 'number') errors.push(`${p}.numericValue must be a number.`);
    }
  });
}

// Advanced Options (card.advancedOptions) — Tyler's follow-up ask: below
// the description field, an expandable section with 4 sub-features. See
// compiler.js's own comments (costReductionTodoLines/
// generateAdvancedOptionsNotes/generateCardSource) for the full honesty
// trail on what each one actually compiles to.
function validateAdvancedOptions(card, p, errors, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, gameplayTagsInUse) {
  const opts = card.advancedOptions;
  if (opts === undefined) return;
  if (!opts || typeof opts !== 'object') { errors.push(`${p}.advancedOptions must be an object if present.`); return; }

  // costReductions — reduce THIS card's own cost when one of its own
  // (already-real) triggers fires. `cardTypeFilter` only makes sense
  // paired with "OnAnyCardPlayed" (same reasoning as PlayedCardHasType
  // above — it checks the card that triggered THAT hook specifically).
  if (opts.costReductions !== undefined) {
    if (!Array.isArray(opts.costReductions)) {
      errors.push(`${p}.advancedOptions.costReductions must be an array.`);
    } else {
      opts.costReductions.forEach((r, ri) => {
        const rp = `${p}.advancedOptions.costReductions[${ri}]`;
        if (!r || typeof r !== 'object') { errors.push(`${rp} must be an object.`); return; }
        if (!CARD_TRIGGERS.includes(r.trigger)) errors.push(`${rp}.trigger "${r.trigger}" is not one of: ${CARD_TRIGGERS.join(', ')}.`);
        if (r.cardTypeFilter !== undefined) {
          if (!CARD_TYPES.includes(r.cardTypeFilter)) errors.push(`${rp}.cardTypeFilter "${r.cardTypeFilter}" is not one of: ${CARD_TYPES.join(', ')}.`);
          if (r.trigger !== 'OnAnyCardPlayed') errors.push(`${rp} has cardTypeFilter set but trigger is "${r.trigger}" — cardTypeFilter only makes sense on "OnAnyCardPlayed" (it checks the card that triggered THAT hook; no other trigger exposes one to check).`);
        }
        // [Round 165] cardTagFilter — Tyler: "the 'whenever any card is
        // played' trigger should also add in a tag filter option, not just
        // type." Same trigger restriction as cardTypeFilter above, and the
        // exact same freeform-tag validation PlayedCardHasTag's own
        // condition check uses (see validateConditions) — non-empty,
        // <=40 chars, and cross-checked against gameplayTagsInUse so a
        // typo'd tag is caught here instead of silently always-false.
        if (r.cardTagFilter !== undefined) {
          if (r.trigger !== 'OnAnyCardPlayed') errors.push(`${rp} has cardTagFilter set but trigger is "${r.trigger}" — cardTagFilter only makes sense on "OnAnyCardPlayed" (it checks the card that triggered THAT hook; no other trigger exposes one to check).`);
          if (!isNonEmptyString(r.cardTagFilter)) {
            errors.push(`${rp}.cardTagFilter must be a non-empty string if present.`);
          } else if (r.cardTagFilter.length > 40) {
            errors.push(`${rp}.cardTagFilter "${r.cardTagFilter}" is longer than 40 characters.`);
          } else if (gameplayTagsInUse && !gameplayTagsInUse.has(r.cardTagFilter.toLowerCase())) {
            errors.push(`${rp}.cardTagFilter "${r.cardTagFilter}" doesn't match any card.gameplayTags value used anywhere in this character (case-insensitive) — this would compile but always evaluate false. Check spelling, or add this tag to at least one card first.`);
          }
        }
        if (!isInt(r.amount) || r.amount < 1) errors.push(`${rp}.amount must be an integer >= 1 (got ${JSON.stringify(r.amount)}).`);
        if (r.scope !== undefined && !CARD_COST_REDUCTION_SCOPES.includes(r.scope)) errors.push(`${rp}.scope "${r.scope}" is not one of: ${CARD_COST_REDUCTION_SCOPES.join(', ')}.`);
        // [Round 164] "Increase" is the cost-raising counterpart to the
        // original (default) "Decrease" — see compiler.js:costReductionTodoLines
        // for what each compiles to and the evidence split between them.
        if (r.direction !== undefined && !CARD_COST_REDUCTION_DIRECTIONS.includes(r.direction)) errors.push(`${rp}.direction "${r.direction}" is not one of: ${CARD_COST_REDUCTION_DIRECTIONS.join(', ')}.`);
      });
    }
  }

  // glow / playability — condition-gated. `conditions` reuses the exact
  // same rules an effect block's conditions already get, with `trigger`
  // passed as undefined — correctly rejecting PlayedCardHasKeyword/
  // PlayedCardHasTag/PlayedCardHasType (none of those make sense here;
  // there's no cardPlay in scope for a glow/playability check, same as any
  // trigger other than OnAnyCardPlayed) and, per the CardTarget/Pet checks
  // above, rejecting a CardTarget subject outright while specifically
  // ALLOWING Pet (both real, different reasons — see those checks). Glow
  // itself compiles for real now (see compiler.js:generateGlowOverride) —
  // playability is still comment-only; see compiler.js's own doc comment
  // on generateAdvancedOptionsNotes for the current evidence split.
  ['glow', 'playability'].forEach(key => {
    const sub = opts[key];
    if (sub === undefined) return;
    if (!sub || typeof sub !== 'object') { errors.push(`${p}.advancedOptions.${key} must be an object if present.`); return; }
    if (sub.enabled !== undefined && typeof sub.enabled !== 'boolean') errors.push(`${p}.advancedOptions.${key}.enabled must be a boolean if present.`);
    validateConditions(sub.conditions, `${p}.advancedOptions.${key}`, errors, mechanicIds, cardIds, relicIds, undefined, gameplayTagsInUse);
  });

  // whileInHand — cardEffectBlock-shaped entries. 'OnTurnEndInHand' (the
  // original, still-real "sits in hand at turn end" analog) plus, as of
  // round 90, the 15 PILE_TRIGGER_HOOK_IDS ("while in a pile" — see
  // compiler.js:PILE_TRIGGER_OWNER_GUARD's own comment for the full
  // decompiled evidence), plus, as of round 195 (Tyler: "i noticed there
  // isn't a 'whenever you play a card' trigger in here"), 'OnAnyCardPlayed'
  // — real, per-entry this.Pile?.Type == X gated codegen via
  // compiler.js:whileInHandMergeLines (same round also fixed a real bug
  // where whileInHand's pre-existing OnTurnEndInHand entries silently
  // compiled to nothing — see that function's own comment). Reuses
  // validateEffects wholesale rather than a second hand-rolled block
  // validator — same rules, just a wider allowed-trigger list than before.
  if (opts.whileInHand !== undefined) {
    validateEffects(opts.whileInHand, `${p}.advancedOptions`, errors, { allowedTriggers: ['OnTurnEndInHand', 'OnAnyCardPlayed', ...PILE_TRIGGER_HOOK_IDS], mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'card', gameplayTagsInUse, cardCostsX: card.costsX === true, cardCostsStarX: card.costsStarX === true });
    // [Round 90] `pile` — which real pile (Hand/Discard/Draw/Exhaust) this
    // entry's Pile.Type check compiles to (see compiler.js:pileTypeExpr).
    // Optional — undefined defaults to 'Hand' both here and in the actual
    // codegen, so an old saved entry (pre-round-90, no `pile` field at
    // all) keeps validating and compiling exactly as it always has.
    (opts.whileInHand || []).forEach((eff, i) => {
      if (!eff || typeof eff !== 'object' || eff.pile === undefined) return;
      if (!PILE_TYPES.includes(eff.pile)) {
        errors.push(`${p}.advancedOptions.whileInHand[${i}].pile is "${eff.pile}" — must be one of: ${PILE_TYPES.join(', ')} (or omitted, which defaults to "Hand").`);
      }
    });
  }

  // heavyAttackAnimation [Round 121] — only meaningful on an Attack-type
  // card (see character.poseSheets: the character's AfterCardPlayed hook
  // only distinguishes attack vs heavyAttack for cards of CardType.Attack;
  // a Skill/Power card already routes to the "cast" pose regardless of
  // this flag, so leaving it true there would be silently meaningless).
  if (opts.heavyAttackAnimation !== undefined) {
    if (typeof opts.heavyAttackAnimation !== 'boolean') {
      errors.push(`${p}.advancedOptions.heavyAttackAnimation must be a boolean if present.`);
    } else if (opts.heavyAttackAnimation && card.type !== 'Attack') {
      errors.push(`${p}.advancedOptions.heavyAttackAnimation is only meaningful on an Attack-type card (this card is "${card.type}") — the heavyAttack pose only ever plays for CardType.Attack card plays.`);
    }
  }
}

function validateCharacterPackage(pkg) {
  const errors = [];

  if (!pkg || typeof pkg !== 'object') return { valid: false, errors: ['Request body must be a JSON object.'] };

  const cards = Array.isArray(pkg.cards) ? pkg.cards : [];
  const relics = Array.isArray(pkg.relics) ? pkg.relics : [];
  const mechanics = Array.isArray(pkg.mechanics) ? pkg.mechanics : [];
  if (!Array.isArray(pkg.cards)) errors.push('"cards" must be an array.');
  if (!Array.isArray(pkg.relics)) errors.push('"relics" must be an array.');
  if (!Array.isArray(pkg.mechanics)) errors.push('"mechanics" must be an array.');

  const cardIds = new Set(cards.map(c => c && c.id).filter(Boolean));
  const relicIds = new Set(relics.map(r => r && r.id).filter(Boolean));
  const mechanicIds = new Set(mechanics.map(m => m && m.id).filter(Boolean));
  // [Round 197] Built here (rather than down by `enchantments`/
  // `afflictions` below, which is defined later in this function) so
  // they're in scope for card.effects/relic.effects/mechanic hooks'
  // AfflictCard/EnchantCard ref validation -- same "build every id set up
  // front" convention cardIds/relicIds/mechanicIds already follow.
  const afflictionIds = new Set((Array.isArray(pkg.afflictions) ? pkg.afflictions : []).map(a => a && a.id).filter(Boolean));
  const enchantmentIds = new Set((Array.isArray(pkg.enchantments) ? pkg.enchantments : []).map(e => e && e.id).filter(Boolean));
  // Every gameplayTags value used anywhere in this character, lowercased —
  // built up front (before any effect blocks are validated) so a
  // PlayedCardHasTag condition on ANY card/relic/mechanic can be
  // cross-checked against it, the same "does this reference something
  // real" pattern statusRef/cardRef already use elsewhere in this file.
  const gameplayTagsInUse = new Set(
    cards.flatMap(c => (c && Array.isArray(c.gameplayTags) ? c.gameplayTags : []))
      .filter(t => typeof t === 'string')
      .map(t => t.toLowerCase())
  );
  // [Round 139] This character's own custom keyword words (raw, as typed
  // — not yet PascalCase-normalized) — declared up front, at the same
  // level as cardIds/mechanicIds above, so the per-card `card.keywords`
  // check further down (a sibling top-level cards.forEach, not nested
  // inside the "--- character ---" block below) can also see it. Only
  // populated for real below, inside that block's own cardKeywords
  // validation loop.
  const customKeywordWords = new Set();

  // --- character ---
  const ch = pkg.character;
  if (!ch || typeof ch !== 'object') {
    errors.push('"character" must be an object.');
  } else {
    if (!isNonEmptyString(ch.name)) errors.push('character.name must be a non-empty string.');
    if (ch.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(ch.color)) errors.push(`character.color "${ch.color}" must be a hex color like "#c1502e".`);
    if (!isInt(ch.maxHp) || ch.maxHp < 1) errors.push('character.maxHp must be an integer >= 1.');
    if (!isInt(ch.startingGold) || ch.startingGold < 0) errors.push('character.startingGold must be an integer >= 0.');
    if (!isInt(ch.energyPerTurn) || ch.energyPerTurn < 1) errors.push('character.energyPerTurn must be an integer >= 1.');
    // [Round 95] Optional — defaults to 0 (see compiler.js's own
    // baseOrbSlotCount handling), so only reject when actually present
    // and invalid, same pattern character.color's own optional check uses.
    if (ch.baseOrbSlotCount !== undefined && (!isInt(ch.baseOrbSlotCount) || ch.baseOrbSlotCount < 0)) errors.push('character.baseOrbSlotCount must be an integer >= 0.');
    // [Round 122] Combat sprite size slider — optional, defaults to 1
    // (compiler.js's own combatSpriteScale handling), same "only reject
    // when actually present and invalid" pattern as baseOrbSlotCount above.
    if (ch.combatSpriteScale !== undefined && (typeof ch.combatSpriteScale !== 'number' || ch.combatSpriteScale < 0.5 || ch.combatSpriteScale > 2)) {
      errors.push('character.combatSpriteScale must be a number between 0.5 and 2.');
    }
    if (ch.gender !== undefined && !['Neutral', 'Feminine', 'Masculine'].includes(ch.gender)) {
      errors.push(`character.gender "${ch.gender}" must be one of "Neutral", "Feminine", "Masculine".`);
    }
    // Resource bars (round 92) — see backend/compiler.js's writeResourceBars
    // for the real Harmony-patch codegen this backs. Optional; an
    // omitted/empty character.resourceBars compiles to nothing (no
    // Generated/ForgeResourceBar*.cs at all), same "absent = off" default
    // every other optional character-level feature in this schema uses.
    if (ch.resourceBarAnchor !== undefined && !RESOURCE_BAR_ANCHORS.includes(ch.resourceBarAnchor)) {
      errors.push(`character.resourceBarAnchor "${ch.resourceBarAnchor}" must be one of: ${RESOURCE_BAR_ANCHORS.join(', ')}.`);
    }
    if (ch.resourceBars !== undefined) {
      if (!Array.isArray(ch.resourceBars)) {
        errors.push('character.resourceBars must be an array.');
      } else {
        ch.resourceBars.forEach((bar, i) => {
          const p = `character.resourceBars[${i}]`;
          if (!bar || typeof bar !== 'object') { errors.push(`${p} must be an object.`); return; }
          if (bar.enabled === false) return; // disabled entries aren't otherwise validated — mirrors advancedOptions' own convention
          // Round 101 — anchor moved from the single character-wide
          // character.resourceBarAnchor to a per-entry field. Optional: an
          // entry with no anchor of its own falls back to
          // character.resourceBarAnchor, then to 'HealthBar' (round 102's
          // default — see compiler.js's resolveBarAnchor(), the one shared
          // source of truth for that fallback).
          if (bar.anchor !== undefined && !RESOURCE_BAR_ANCHORS.includes(bar.anchor)) {
            errors.push(`${p}.anchor "${bar.anchor}" must be one of: ${RESOURCE_BAR_ANCHORS.join(', ')}.`);
          }
          if (bar.statusKind !== undefined && !['vanilla', 'custom'].includes(bar.statusKind)) {
            errors.push(`${p}.statusKind "${bar.statusKind}" must be "vanilla" or "custom".`);
          }
          if (bar.statusKind === 'vanilla') {
            if (!isNonEmptyString(bar.builtinStatus) || !BUILTIN_STATUSES.includes(bar.builtinStatus)) {
              errors.push(`${p}.builtinStatus "${bar.builtinStatus}" doesn't match any real built-in status.`);
            }
          } else {
            if (!isNonEmptyString(bar.status) || !mechanicIds.has(bar.status)) {
              errors.push(`${p}.status "${bar.status}" doesn't match any defined mechanic id.`);
            }
          }
          if (!isInt(bar.max) || bar.max < 1) errors.push(`${p}.max must be an integer >= 1.`);
          if (bar.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(bar.color)) {
            errors.push(`${p}.color "${bar.color}" must be a hex color like "#3399ff".`);
          }
          // Round 94 — layout/diamondGroup/diamondRole reproduce Tyler's
          // own real dual-bar+diamond widget (see backend/compiler.js's
          // writeResourceBars). "standalone" (default) needs neither of
          // the other two fields; "diamond" needs a role, and compiler.js
          // itself enforces the one-left/one-right-per-group rule (a
          // group-shape error, not a single-entry shape error, so it isn't
          // duplicated here).
          if (bar.layout !== undefined && !['standalone', 'diamond'].includes(bar.layout)) {
            errors.push(`${p}.layout "${bar.layout}" must be "standalone" or "diamond".`);
          }
          if (bar.layout === 'diamond') {
            if (!isNonEmptyString(bar.diamondGroup)) {
              errors.push(`${p}.diamondGroup must be a non-empty string when layout is "diamond".`);
            }
            if (!isNonEmptyString(bar.diamondRole) || !['left', 'right', 'center'].includes(bar.diamondRole)) {
              errors.push(`${p}.diamondRole must be "left", "right", or "center" when layout is "diamond".`);
            }
          } else if (bar.diamondGroup !== undefined || bar.diamondRole !== undefined) {
            errors.push(`${p}.diamondGroup/diamondRole are only used when layout is "diamond".`);
          }
        });

        // Round 101 — per-anchor bucket caps, mirrors backend/compiler.js's
        // writeResourceBars(): up to MAX_RESOURCE_BARS standalone bars per
        // anchor (diamond groups don't count against this cap, same as
        // compiler.js's own slice), and "below health bar" supports only 1
        // widget total (a standalone bar OR a whole diamond group) across
        // that anchor.
        const active = ch.resourceBars.filter(b => b && typeof b === 'object' && b.enabled !== false);
        for (const anchorName of RESOURCE_BAR_ANCHORS) {
          const inAnchor = active.filter(b => resolveBarAnchor(ch, b) === anchorName);
          const standaloneCount = inAnchor.filter(b => b.layout !== 'diamond').length;
          const diamondGroupIds = new Set(inAnchor.filter(b => b.layout === 'diamond' && isNonEmptyString(b.diamondGroup)).map(b => b.diamondGroup));
          if (standaloneCount > MAX_RESOURCE_BARS) {
            errors.push(`character.resourceBars: ${standaloneCount} standalone bar(s) are anchored "${anchorName}" — at most ${MAX_RESOURCE_BARS} are supported per anchor.`);
          }
          if (anchorName === 'HealthBar') {
            const widgetCount = standaloneCount + diamondGroupIds.size;
            if (widgetCount > 1) {
              errors.push(`character.resourceBars: the "below health bar" anchor supports only 1 bar/diamond group total (found ${widgetCount} anchored there).`);
            }
          }
        }

        // Round 101 — a diamond group is one indivisible on-screen widget,
        // so every entry sharing a diamondGroup id must resolve to the same
        // anchor. Mirrors compiler.js's own up-front check, surfaced here
        // too for a clean validation error instead of only failing deep
        // inside compile.
        const groupAnchors = new Map();
        for (const b of active) {
          if (b.layout !== 'diamond' || !isNonEmptyString(b.diamondGroup)) continue;
          const a = resolveBarAnchor(ch, b);
          if (!groupAnchors.has(b.diamondGroup)) groupAnchors.set(b.diamondGroup, a);
          else if (groupAnchors.get(b.diamondGroup) !== a) {
            errors.push(`character.resourceBars: diamond group "${b.diamondGroup}" has entries anchored to different places — all entries in a diamond group must share the same anchor.`);
          }
        }
      }
    }
    // vanillaCardAccess [Round 139] — see schema's own description for the
    // full "whole-character checkbox, DESIGN-TIME PREVIEW ONLY" writeup.
    // Just a plain object of booleans; nothing here is cross-referenced
    // against anything else, same shallow-check tier as advancedOptions'
    // own booleans elsewhere in this file.
    const VANILLA_CARD_ACCESS_KEYS = ['ironclad', 'silent', 'defect', 'necrobinder', 'regent', 'colorless'];
    if (ch.vanillaCardAccess !== undefined) {
      if (!ch.vanillaCardAccess || typeof ch.vanillaCardAccess !== 'object') {
        errors.push('character.vanillaCardAccess must be an object if present.');
      } else {
        Object.keys(ch.vanillaCardAccess).forEach(key => {
          if (!VANILLA_CARD_ACCESS_KEYS.includes(key)) {
            errors.push(`character.vanillaCardAccess has an unknown key "${key}" — must be one of: ${VANILLA_CARD_ACCESS_KEYS.join(', ')}.`);
            return;
          }
          if (ch.vanillaCardAccess[key] !== undefined && typeof ch.vanillaCardAccess[key] !== 'boolean') {
            errors.push(`character.vanillaCardAccess.${key} must be a boolean if present.`);
          }
        });
      }
    }

    // cardKeywords [Round 139] — see schema's own description for the full
    // real-mechanism evidence trail (compiler.js's keywordExpr/
    // generateModKeywordsSource). `word` must be a non-empty string that
    // doesn't collide, case-insensitively, with a real built-in
    // CardKeyword (compiler.js re-PascalCases it the same way every other
    // generated identifier is normalized, so two words that only differ by
    // spacing/casing would silently collide into the same generated field
    // — caught here up front instead of failing deep inside compile).
    if (ch.cardKeywords !== undefined) {
      if (!Array.isArray(ch.cardKeywords)) {
        errors.push('character.cardKeywords must be an array.');
      } else {
        const seenLower = new Set();
        ch.cardKeywords.forEach((kw, i) => {
          const p = `character.cardKeywords[${i}]`;
          if (!kw || typeof kw !== 'object') { errors.push(`${p} must be an object.`); return; }
          if (!isNonEmptyString(kw.word)) {
            errors.push(`${p}.word must be a non-empty string.`);
            return;
          }
          const normalized = kw.word.replace(/[^a-zA-Z0-9]+/g, '');
          const lower = normalized.toLowerCase();
          if (!normalized) { errors.push(`${p}.word "${kw.word}" has no letters/digits to build a real identifier from.`); return; }
          if (CARD_KEYWORDS.map(k => k.toLowerCase()).includes(lower)) {
            errors.push(`${p}.word "${kw.word}" collides with a real built-in CardKeyword (${CARD_KEYWORDS.join(', ')}) — pick a different word.`);
          }
          if (seenLower.has(lower)) {
            errors.push(`${p}.word "${kw.word}" collides with another cardKeywords entry (same word, ignoring case/spacing).`);
          }
          seenLower.add(lower);
          customKeywordWords.add(kw.word);
          if (kw.description !== undefined && typeof kw.description !== 'string') {
            errors.push(`${p}.description must be a string if present.`);
          }
          if (kw.position !== undefined && !['Before', 'After'].includes(kw.position)) {
            errors.push(`${p}.position "${kw.position}" must be "Before" or "After".`);
          }
        });
      }
    }

    // poseSheets [Round 121] — see schema's poseSheetEntry for the full
    // compile mechanism. Only fps/frameCount/columns are checked here
    // (bounds only — the pixel dimensions themselves aren't enforced, see
    // poseSheetEntry's own description); an un-uploaded pose (assetRef
    // null/undefined) is always fine to skip validating its numeric
    // fields, same "not uploaded = not checked" convention every other
    // optional art slot in this file already follows.
    const POSE_SHEET_NAMES = ['idle', 'attack', 'heavyAttack', 'cast', 'hurt', 'death', 'victory'];
    if (ch.poseSheets !== undefined) {
      if (!ch.poseSheets || typeof ch.poseSheets !== 'object') {
        errors.push('character.poseSheets must be an object if present.');
      } else {
        Object.keys(ch.poseSheets).forEach(key => {
          if (!POSE_SHEET_NAMES.includes(key)) {
            errors.push(`character.poseSheets has an unknown pose "${key}" — must be one of: ${POSE_SHEET_NAMES.join(', ')}.`);
            return;
          }
          const entry = ch.poseSheets[key];
          if (entry === undefined || entry === null) return;
          const p = `character.poseSheets.${key}`;
          if (typeof entry !== 'object') { errors.push(`${p} must be an object if present.`); return; }
          if (!entry.assetRef) return; // nothing uploaded — numeric fields don't matter yet
          if (entry.fps !== undefined && !(typeof entry.fps === 'number' && entry.fps >= 1)) {
            errors.push(`${p}.fps must be a number >= 1.`);
          }
          if (entry.frameCount !== undefined && !(Number.isInteger(entry.frameCount) && entry.frameCount >= 1)) {
            errors.push(`${p}.frameCount must be an integer >= 1.`);
          }
          if (entry.columns !== undefined && !(Number.isInteger(entry.columns) && entry.columns >= 0)) {
            errors.push(`${p}.columns must be an integer >= 0 (0 = single row).`);
          }
        });
        // [Round 121 follow-up] Tyler: "Lets just replace the idle sprite
        // with the sprite sheet if they upload one. The other spritesheets
        // should be ignored unless something is uploaded to them." Each
        // pose is now independent — idle is no longer a prerequisite for
        // any other pose. compiler.js's generatePoseSheetVisuals() picks a
        // resting-look texture on its own (idle sheet, else the Body
        // sprite, else the first uploaded pose sheet) whenever ANY pose is
        // uploaded, so an attack/hurt/etc. sheet with no idle sheet still
        // compiles into a real, working AnimationPlayer — no cross-field
        // requirement to enforce here any more.
      }
    }
    (ch.startingDeckCardIds || []).forEach(id => {
      if (!cardIds.has(id)) errors.push(`character.startingDeckCardIds references "${id}", which isn't defined in cards[].`);
    });
    if (ch.startingRelicId && !relicIds.has(ch.startingRelicId)) {
      errors.push(`character.startingRelicId "${ch.startingRelicId}" isn't defined in relics[].`);
    }
    // [VERIFIED via real sts2.dll IL disassembly, 2026-09-01 — see
    // TOOLCHAIN_FINDINGS.md "character-select click crash #3"]
    // MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen
    // .SelectCharacter() unconditionally does characterModel.StartingRelics[0]
    // with no Count check the instant this character is clicked on the
    // select screen — an empty StartingRelics list throws
    // ArgumentOutOfRangeException right there and the click does nothing
    // (no highlight, no splash art), which is exactly the bug that made
    // every Forge-exported character before this round unselectable.
    // backend/compiler.js resolves the same explicit-id-then-Starter-
    // rarity fallback this check mirrors — this only fails when NEITHER
    // resolves, i.e. the export really would ship a guaranteed-crash
    // character.
    const hasStarterRarityRelic = relics.some(r => r && r.rarity === 'Starter');
    if (!ch.startingRelicId && !hasStarterRarityRelic) {
      errors.push('character has no starting relic: set character.startingRelicId (pick one in the Relics panel\'s "Starting relic" dropdown), or mark one of relics[] as rarity "Starter". The real game crashes the instant this character is clicked on the select screen without one — see TOOLCHAIN_FINDINGS.md.');
    }
  }

  // --- cards ---
  // Round 20 — Tyler: "make the errors that the compiler throws a bit more
  // legible." Every error under this entity used to read as a bare
  // "cards[3]...", leaving Tyler to count cards to find out which one that
  // even was. `p` now carries the card's own name (when it has one) right
  // in the path — every nested error string built from `p` below
  // (effects[i]/modifiers[i]/upgrades[i]/advancedOptions...) picks this up
  // for free, no other change needed. frontend/index.html's
  // showCompileErrorModal groups by this exact `kind[index] "name"` shape
  // (see parseCompileError there) to render a clickable "Open editor →"
  // per entity instead of one flat wall of text.
  cards.forEach((card, i) => {
    const named = card && typeof card === 'object' && isNonEmptyString(card.name);
    const p = `cards[${i}]${named ? ` "${card.name}"` : ''}`;
    if (!card || typeof card !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(card.name)) errors.push(`${p}.name must be a non-empty string.`);
    // [CORRECTED] Used to treat -1 as a real "X cost" sentinel (an STS1-
    // style assumption, never actually reflect-baselib-confirmed for
    // STS2). Decompiling Tyler's own real, compiled TheBurdenedNewCharacter.dll
    // disproved that — its one real X-cost card (Retaliation) passes cost
    // 0 to the base constructor, not -1. X-cost-ness is a SEPARATE
    // declaration now (card.costsX, checked below), so cost is just a
    // plain non-negative integer again.
    if (!isInt(card.cost) || card.cost < 0) errors.push(`${p}.cost must be a non-negative integer (got ${JSON.stringify(card.cost)}).`);
    // card.costsX — [VERIFIED via decompiling TheBurdenedNewCharacter.dll]
    // CardModel.HasEnergyCostX is a real protected virtual bool getter,
    // confirmed overridden (-> true) by a real working X-cost card
    // (Retaliation) in that mod, and confirmed NOT required to be
    // overridden by a DIFFERENT real card in the same mod that isn't
    // X-cost (CostOfGlory) — i.e. it's a real optional override, not a
    // guess. When set, cost must be exactly 0 — the only value the one
    // confirmed real example demonstrates; nothing has confirmed what (if
    // anything) a nonzero cost alongside costsX would even mean.
    if (card.costsX !== undefined && typeof card.costsX !== 'boolean') errors.push(`${p}.costsX must be a boolean if present.`);
    if (card.costsX === true && card.cost !== 0) errors.push(`${p}.costsX is true but cost is ${JSON.stringify(card.cost)} — cost must be 0 for an X-cost card (the real confirmed example, Retaliation, uses baseCost 0; costsX is what declares "X", not a nonzero cost value).`);
    // Optional — undefined/omitted means "no star cost", the common case.
    // [VERIFIED via decompiling TheBurdenedNewCharacter.dll v3's "Star
    // Cost Change" card, round 59] CardModel.CanonicalStarCost — NOT
    // BaseStarCost, whose setter turned out private — is the real,
    // public, overridable member this compiles through (see
    // compiler.js's generateCanonicalStarCostOverride). The StarsRemaining
    // CONDITION (a different thing — a live count of the player's current
    // stars, not this card's own star cost) also compiles for real, as of
    // reflect-baselib round 14 — see compiler.js's conditionToCSharp.
    if (card.starCost !== undefined && (!isInt(card.starCost) || card.starCost < 0)) errors.push(`${p}.starCost must be a non-negative integer if present (got ${JSON.stringify(card.starCost)}).`);
    // card.costsStarX (round 71, Tyler: "i want to make an x star cost
    // check box"). [VERIFIED via decompiling Tyler's own updated
    // TheBurdenedNewCharacter.dll, round 73 — see compiler.js's own
    // comment on generateHasStarCostXOverride] CardModel.HasStarCostX is
    // real; confirmed overridden by a real card (X Star) in that mod,
    // same confirmation tier as costsX/HasEnergyCostX (Retaliation).
    // Same "must be 0" pairing rule as costsX/cost
    // regardless, so a hand-edited package can't silently combine a
    // nonzero starCost with costsStarX.
    if (card.costsStarX !== undefined && typeof card.costsStarX !== 'boolean') errors.push(`${p}.costsStarX must be a boolean if present.`);
    if (card.costsStarX === true && card.starCost !== undefined && card.starCost !== null && card.starCost !== 0) errors.push(`${p}.costsStarX is true but starCost is ${JSON.stringify(card.starCost)} — starCost must be 0 (or omitted) for an X-star-cost card, same pairing rule as costsX/cost above.`);
    if (!CARD_TYPES.includes(card.type)) errors.push(`${p}.type "${card.type}" is not one of: ${CARD_TYPES.join(', ')}.`);
    if (!CARD_RARITIES.includes(card.rarity)) errors.push(`${p}.rarity "${card.rarity}" is not one of: ${CARD_RARITIES.join(', ')}.`);
    if (!CARD_TARGETS.includes(card.target)) errors.push(`${p}.target "${card.target}" is not one of: ${CARD_TARGETS.join(', ')}.`);
    if (card.keywords !== undefined) {
      if (!Array.isArray(card.keywords)) {
        errors.push(`${p}.keywords must be an array.`);
      } else {
        card.keywords.forEach((kw, ki) => {
          // [Round 139] Either a real built-in CardKeyword, or this
          // character's own cardKeywords[].word (customKeywordWords,
          // populated above from character.cardKeywords).
          if (!CARD_KEYWORDS.includes(kw) && !customKeywordWords.has(kw)) errors.push(`${p}.keywords[${ki}] "${kw}" is not one of the built-in keywords (${CARD_KEYWORDS.join(', ')}) or a keyword defined in character.cardKeywords.`);
        });
        if (new Set(card.keywords).size !== card.keywords.length) errors.push(`${p}.keywords has duplicate entries.`);
      }
    }
    // Tags are Forge-only organizational metadata — free text, no real
    // BaseLib/game concept behind them (unlike keywords, which map to the
    // real CardKeyword enum). compiler.js never reads card.tags at all;
    // they exist purely to power the card section's grouping/filtering UI.
    // Still validated for basic sanity (non-empty strings, no dupes, a
    // length cap) so a malformed package can't quietly break that UI.
    if (card.tags !== undefined) {
      if (!Array.isArray(card.tags)) {
        errors.push(`${p}.tags must be an array.`);
      } else {
        card.tags.forEach((tag, ti) => {
          if (!isNonEmptyString(tag)) errors.push(`${p}.tags[${ti}] must be a non-empty string.`);
          else if (tag.length > 40) errors.push(`${p}.tags[${ti}] "${tag}" is longer than 40 characters.`);
        });
        const lower = card.tags.map(t => (typeof t === 'string' ? t.toLowerCase() : t));
        if (new Set(lower).size !== lower.length) errors.push(`${p}.tags has duplicate entries (case-insensitive).`);
      }
    }
    // gameplayTags are TRUE custom tags — unlike card.tags above, these DO
    // compile (backend/compiler.js:generateGameplayTagsInit emits them
    // straight into each card's ForgeTags HashSet<string> — see
    // backend/templates/IForgeTaggedCard.cs.template's header for why this
    // is a Forge-owned mechanism, not BaseLib's real CardTag enum). Same
    // sanity checks as card.tags (non-empty, length cap, case-insensitive
    // dedup) since the shape is identical — the only difference is that
    // these values are read by compiler.js, not just the frontend board UI.
    if (card.gameplayTags !== undefined) {
      if (!Array.isArray(card.gameplayTags)) {
        errors.push(`${p}.gameplayTags must be an array.`);
      } else {
        card.gameplayTags.forEach((tag, ti) => {
          if (!isNonEmptyString(tag)) errors.push(`${p}.gameplayTags[${ti}] must be a non-empty string.`);
          else if (tag.length > 40) errors.push(`${p}.gameplayTags[${ti}] "${tag}" is longer than 40 characters.`);
        });
        const lowerGp = card.gameplayTags.map(t => (typeof t === 'string' ? t.toLowerCase() : t));
        if (new Set(lowerGp).size !== lowerGp.length) errors.push(`${p}.gameplayTags has duplicate entries (case-insensitive).`);
      }
    }
    // Real BaseLib CardTag (Tyler's item 15) — a closed enum, so unlike
    // gameplayTags above, a typo here is impossible from the UI (dropdown
    // only), but validated anyway since generateProject() is also callable
    // directly with a hand-built package.
    if (card.baseCardTag !== undefined && !CARD_TAGS.includes(card.baseCardTag)) {
      errors.push(`${p}.baseCardTag "${card.baseCardTag}" is not one of: ${CARD_TAGS.join(', ')}.`);
    }
    validateEffects(card.effects || [], p, errors, { allowedTriggers: CARD_TRIGGERS, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'card', gameplayTagsInUse, cardCostsX: card.costsX === true, cardCostsStarX: card.costsStarX === true });
    validateAdvancedOptions(card, p, errors, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, gameplayTagsInUse);
    // card.upgrades[] — one entry per unlocked upgrade tier (index 0 =
    // Card+, 1 = Card++, ... up to MAX_UPGRADE_TIERS). A `null` entry means
    // that tier exists (its tab was added in the editor) but still mirrors
    // the tier below it rather than having its own real data yet — nothing
    // to validate there. Replaces the old singular `card.upgrade` object
    // (formatVersion 9 -> 10 migration in frontend/index.html wraps any
    // old value into `upgrades: [oldValue]`).
    if (card.upgrades !== undefined) {
      if (!Array.isArray(card.upgrades)) {
        errors.push(`${p}.upgrades must be an array.`);
      } else {
        if (card.upgrades.length > MAX_UPGRADE_TIERS) {
          errors.push(`${p}.upgrades has ${card.upgrades.length} tiers — only up to ${MAX_UPGRADE_TIERS} are supported.`);
        }
        if (card.upgrades.length > 0 && (card.type === 'Status' || card.type === 'Curse')) {
          errors.push(`${p}.upgrades is set but card.type is "${card.type}" — Status/Curse cards can't be upgraded (no Card+ in real STS2 for these types).`);
        }
        card.upgrades.forEach((tier, i) => {
          if (tier === null || tier === undefined) return; // not-yet-diverged placeholder — nothing to check
          if (typeof tier !== 'object') { errors.push(`${p}.upgrades[${i}] must be an object or null.`); return; }
          if (tier.effects) {
            validateEffects(tier.effects, `${p}.upgrades[${i}]`, errors, { allowedTriggers: CARD_TRIGGERS, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'card', gameplayTagsInUse, cardCostsX: card.costsX === true, cardCostsStarX: card.costsStarX === true });
          }
        });
      }
    }
    // card.transformOnUpgrade — [Round 167] "one card to transform into
    // another when upgraded". Mutually exclusive with card.upgrades (a
    // transformed card becomes a whole different CardModel instance, so
    // "this card's own tier 2/3/4" has no meaning once it's a different
    // card) and, like upgrades, only valid on non-Status/Curse types. See
    // schema/character.schema.json's description and backend/compiler.js's
    // generateTransformUpgradeMethod for the full evidence trail.
    if (card.transformOnUpgrade !== undefined && card.transformOnUpgrade !== null) {
      const t = card.transformOnUpgrade;
      if (typeof t !== 'object') {
        errors.push(`${p}.transformOnUpgrade must be an object or null.`);
      } else {
        // Any tier tab at all (even a still-null, not-yet-diverged one —
        // it's still a real MaxUpgradeLevel entry the user added) conflicts
        // with a transform, which needs MaxUpgradeLevel to stay exactly 1.
        if (Array.isArray(card.upgrades) && card.upgrades.length > 0) {
          errors.push(`${p} has both transformOnUpgrade and upgrades set — a card either gains stat-delta upgrade tiers OR fully transforms into a different card on upgrade, not both. Remove one.`);
        }
        if (card.type === 'Status' || card.type === 'Curse') {
          errors.push(`${p}.transformOnUpgrade is set but card.type is "${card.type}" — Status/Curse cards can't be upgraded (no Card+ in real STS2 for these types), so they can't transform on upgrade either.`);
        }
        if (!isNonEmptyString(t.targetCardId)) {
          errors.push(`${p}.transformOnUpgrade.targetCardId must be a non-empty string.`);
        } else if (t.targetCardId === card.id) {
          errors.push(`${p}.transformOnUpgrade.targetCardId can't reference this card itself — pick a different card to transform into.`);
        } else if (!cardIds.has(t.targetCardId)) {
          errors.push(`${p}.transformOnUpgrade.targetCardId "${t.targetCardId}" doesn't match any defined card id.`);
        }
      }
    }
  });

  // --- relics ---
  relics.forEach((relic, i) => {
    const named = relic && typeof relic === 'object' && isNonEmptyString(relic.name);
    const p = `relics[${i}]${named ? ` "${relic.name}"` : ''}`; // Round 20 — see cards.forEach's own comment above on why `p` carries the name
    if (!relic || typeof relic !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(relic.name)) errors.push(`${p}.name must be a non-empty string.`);
    if (!RELIC_RARITIES.includes(relic.rarity)) errors.push(`${p}.rarity "${relic.rarity}" is not one of: ${RELIC_RARITIES.join(', ')}.`);
    validateEffects(relic.effects || [], p, errors, { allowedTriggers: HOOK_TRIGGERS, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'relic', gameplayTagsInUse });
    validateModifiers(relic.modifiers, p, errors, mechanicIds, cardIds, relicIds, gameplayTagsInUse);
  });

  // --- mechanics ---
  mechanics.forEach((mech, i) => {
    const named = mech && typeof mech === 'object' && isNonEmptyString(mech.name);
    const p = `mechanics[${i}]${named ? ` "${mech.name}"` : ''}`; // Round 20 — see cards.forEach's own comment above on why `p` carries the name
    if (!mech || typeof mech !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(mech.name)) errors.push(`${p}.name must be a non-empty string.`);
    if (typeof mech.stackable !== 'boolean') errors.push(`${p}.stackable must be a boolean.`);
    // Round 94 — hideIcon compiles to `protected override bool
    // IsVisibleInternal => false;` (backend/compiler.js:generateMechanicSource).
    // Independent of resourceBars — see schema/character.schema.json's
    // description on this field.
    if (mech.hideIcon !== undefined && typeof mech.hideIcon !== 'boolean') {
      errors.push(`${p}.hideIcon must be a boolean.`);
    }
    if (mech.effects !== undefined) {
      validateEffects(mech.effects, p, errors, { allowedTriggers: HOOK_TRIGGERS, mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'mechanic', gameplayTagsInUse });
    }
    validateModifiers(mech.modifiers, p, errors, mechanicIds, cardIds, relicIds, gameplayTagsInUse);
  });

  // --- pets / orbs — Tyler's "add a section to the page to create custom
  // pets as well as orbs" ask.
  // Pets: STILL data-capture only — see schema/character.schema.json's
  // `pets` description and compiler.js:buildPetsReadme for why (real base
  // class confirmed, real attachment mechanism (PlayerCmd.AddPet) not
  // yet). Validated only for basic shape sanity.
  // Orbs: UPGRADED this round — passiveValue/evokeValue DO compile now
  // (see compiler.js:generateOrbSource/Orb.cs.template), so they get real
  // numeric validation, same bar action.amount and every other real
  // numeric field in this file gets. passiveText/evokeText/focusScales
  // remain freeform/uncompiled, same shape-only bar as before.
  const pets = Array.isArray(pkg.pets) ? pkg.pets : [];
  const orbs = Array.isArray(pkg.orbs) ? pkg.orbs : [];
  if (pkg.pets !== undefined && !Array.isArray(pkg.pets)) errors.push('"pets" must be an array.');
  if (pkg.orbs !== undefined && !Array.isArray(pkg.orbs)) errors.push('"orbs" must be an array.');

  pets.forEach((pet, i) => {
    const p = `pets[${i}]`;
    if (!pet || typeof pet !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(pet.name)) errors.push(`${p}.name must be a non-empty string.`);
  });

  // Enchantments/Afflictions — Round 95, Tyler: "Enchantments/Afflictions
  // need their own section after cards." Same shape-only bar as Pets
  // above (still genuinely unresearched whether a real mechanism exists —
  // see schema's `enchantments`/`afflictions` descriptions and
  // compiler.js:buildEnchantmentAfflictionReadme).
  const enchantments = Array.isArray(pkg.enchantments) ? pkg.enchantments : [];
  const afflictions = Array.isArray(pkg.afflictions) ? pkg.afflictions : [];
  if (pkg.enchantments !== undefined && !Array.isArray(pkg.enchantments)) errors.push('"enchantments" must be an array.');
  if (pkg.afflictions !== undefined && !Array.isArray(pkg.afflictions)) errors.push('"afflictions" must be an array.');
  enchantments.forEach((e, i) => {
    const p = `enchantments[${i}]`;
    if (!e || typeof e !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(e.name)) errors.push(`${p}.name must be a non-empty string.`);
    // [Round 197] Enchantments' own onPlay/whilePile effect lists were
    // never validated before now -- they were only checked for .name.
    // This matters as of round 197 because EnchantCard/AfflictCard
    // actions (with their new afflictionRef/enchantmentRef cross-checks
    // below) are most naturally used INSIDE these very effect lists (e.g.
    // an Enchantment's own OnPlay removing itself). entityKind: 'enchantment'
    // (not 'card') deliberately keeps the X-cost-eligibility check off --
    // Enchantments have no energy cost of their own.
    validateEffects((e.onPlay && e.onPlay.effects) || [], p, errors, { allowedTriggers: ['OnPlay'], mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'enchantment', gameplayTagsInUse });
    validateEffects((e.whilePile && e.whilePile.effects) || [], p, errors, { allowedTriggers: ['OnTurnEndInHand', 'OnAnyCardPlayed', ...PILE_TRIGGER_HOOK_IDS], mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'enchantment', gameplayTagsInUse });
  });
  // Afflictions — Round 196 upgrade: AfflictionModel is a real, separate
  // base-game class from EnchantmentModel (see compiler.js:generateAfflictionSource
  // for the full reflection evidence trail). Tyler: "afflictions are
  // temporary enchantments... add any fields that we don't have" (vs.
  // slay.spencerstiles.com's Afflictions editor). Validated to the same
  // bar as every other real, compiled field in this file — mirrors the
  // HasStatusStacks vanilla/custom split above for requiresStatus, and
  // CARD_KEYWORD_VALUES gating above for keywordsWhileAfflicted.
  afflictions.forEach((e, i) => {
    const p = `afflictions[${i}]`;
    if (!e || typeof e !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(e.name)) errors.push(`${p}.name must be a non-empty string.`);
    if (e.canStack !== undefined && typeof e.canStack !== 'boolean') errors.push(`${p}.canStack must be a boolean.`);
    if (e.canAffectUnplayableCards !== undefined && typeof e.canAffectUnplayableCards !== 'boolean') {
      errors.push(`${p}.canAffectUnplayableCards must be a boolean.`);
    }
    if (e.requiresStatus !== undefined) {
      const rs = e.requiresStatus;
      if (!rs || typeof rs !== 'object') {
        errors.push(`${p}.requiresStatus must be an object.`);
      } else if (rs.enabled) {
        const kind = rs.kind === 'vanilla' ? 'vanilla' : 'custom';
        if (rs.kind !== undefined && !['vanilla', 'custom'].includes(rs.kind)) {
          errors.push(`${p}.requiresStatus.kind "${rs.kind}" is not one of: vanilla, custom.`);
        } else if (kind === 'vanilla') {
          if (!isNonEmptyString(rs.builtinStatus)) errors.push(`${p}.requiresStatus is enabled with kind "vanilla" but has no builtinStatus.`);
          else if (!BUILTIN_STATUSES.includes(rs.builtinStatus)) errors.push(`${p}.requiresStatus.builtinStatus "${rs.builtinStatus}" is not one of the known built-in statuses.`);
        } else {
          if (!isNonEmptyString(rs.statusRef)) errors.push(`${p}.requiresStatus is enabled but has no statusRef.`);
          else if (!mechanicIds.has(rs.statusRef)) errors.push(`${p}.requiresStatus.statusRef "${rs.statusRef}" doesn't match any defined mechanic id.`);
        }
      }
    }
    if (e.costChange !== undefined) {
      const cc = e.costChange;
      if (!cc || typeof cc !== 'object') {
        errors.push(`${p}.costChange must be an object.`);
      } else {
        if (cc.amount !== undefined && typeof cc.amount !== 'number') errors.push(`${p}.costChange.amount must be a number.`);
        if (cc.multiplyByAmount !== undefined && typeof cc.multiplyByAmount !== 'boolean') errors.push(`${p}.costChange.multiplyByAmount must be a boolean.`);
      }
    }
    if (e.keywordsWhileAfflicted !== undefined) {
      if (!Array.isArray(e.keywordsWhileAfflicted)) {
        errors.push(`${p}.keywordsWhileAfflicted must be an array.`);
      } else {
        e.keywordsWhileAfflicted.forEach((kw, ki) => {
          if (!CARD_KEYWORD_VALUES.includes(kw)) {
            errors.push(`${p}.keywordsWhileAfflicted[${ki}] "${kw}" is not one of: ${CARD_KEYWORD_VALUES.join(', ')}.`);
          }
        });
      }
    }
    if (e.validTargets !== undefined) {
      const vt = e.validTargets;
      if (!vt || typeof vt !== 'object') {
        errors.push(`${p}.validTargets must be an object.`);
      } else if (vt.types !== undefined) {
        if (!vt.types || typeof vt.types !== 'object') {
          errors.push(`${p}.validTargets.types must be an object.`);
        } else {
          ['attack', 'skill', 'power', 'status', 'curse'].forEach((key) => {
            if (vt.types[key] !== undefined && typeof vt.types[key] !== 'boolean') {
              errors.push(`${p}.validTargets.types.${key} must be a boolean.`);
            }
          });
        }
      }
    }
    // [Round 197] Same gap as Enchantments above -- Afflictions' own
    // onPlay/whilePile effects were never validated. compiler.js's
    // generateAfflictionSource filters onPlay.effects down to
    // trigger === 'OnPlay' only, so that's the only allowed trigger here
    // too. entityKind: 'affliction' keeps X-cost-eligibility off.
    validateEffects((e.onPlay && e.onPlay.effects) || [], p, errors, { allowedTriggers: ['OnPlay'], mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'affliction', gameplayTagsInUse });
    validateEffects((e.whilePile && e.whilePile.effects) || [], p, errors, { allowedTriggers: ['OnTurnEndInHand', 'OnAnyCardPlayed', ...PILE_TRIGGER_HOOK_IDS], mechanicIds, cardIds, relicIds, afflictionIds, enchantmentIds, entityKind: 'affliction', gameplayTagsInUse });
  });

  orbs.forEach((orb, i) => {
    const p = `orbs[${i}]`;
    if (!orb || typeof orb !== 'object') { errors.push(`${p} must be an object.`); return; }
    if (!isNonEmptyString(orb.name)) errors.push(`${p}.name must be a non-empty string.`);
    if (orb.baseValue !== undefined && typeof orb.baseValue !== 'number') errors.push(`${p}.baseValue must be a number.`);
    if (orb.passiveValue !== undefined && typeof orb.passiveValue !== 'number') errors.push(`${p}.passiveValue must be a number.`);
    if (orb.evokeValue !== undefined && typeof orb.evokeValue !== 'number') errors.push(`${p}.evokeValue must be a number.`);
    if (orb.focusScales !== undefined && typeof orb.focusScales !== 'boolean') errors.push(`${p}.focusScales must be a boolean.`);
  });

  return { valid: errors.length === 0, errors };
}

module.exports = { validateCharacterPackage };
