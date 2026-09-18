# reflect-baselib

A small standalone reflection tool — not part of the Forge app itself — that
answers every `[UNVERIFIED]`/`[BEST EFFORT]` guess left in Forge's generated
C# templates (`backend/templates/*.cs.template`) in one shot, instead of
discovering them one `dotnet build` at a time.

## Why

Every time Forge's generated code guesses wrong about an exact property
type or method signature (e.g. `Gender`'s real type, `DeckEntryCardColor`'s
real type, `GetArchitectAttackVfx()`'s real return type), the only way
we've had to find out is: you run a real export, `dotnet build` fails with
a compiler error, you paste it back, and it gets fixed for the *next* guess
that also turns out wrong. That works, but it's slow — each unresolved
member costs a full round trip.

This tool skips all of that by reflecting directly over your own installed
`sts2.dll` and `BaseLib.dll` and printing the **exact** type/method
signature of every abstract member on the base classes Forge's templates
have to extend (`CharacterModel`, `CardModel`, `CardPoolModel`,
`RelicPoolModel`, `PotionPoolModel`, etc.), plus every enum whose name
contains "Gender" or "Keyword", plus `ModelDb`'s static methods
(`Card<T>()`/`Relic<T>()` and friends). No guessing required — reflection
metadata doesn't lie about types the way inferring from a compiler error
message does.

## Usage

From this folder, on your Windows machine (same machine you've been
running Forge's exports on):

```
dotnet run -- "C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64" "C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\BaseLib\BaseLib.dll"
```

(Adjust the first path to whatever `GameDataDir` Forge has been using for
you, and the second to wherever BaseLib.dll actually sits in your
`mods\BaseLib\` folder — the exact same two paths Forge's own build already
depends on.)

It prints its findings to the console **and** writes them to
`reflect-output.txt` in this folder. Paste that file's contents back into
the chat and every remaining `[UNVERIFIED]` guess in the templates
(`Gender`, `DeckEntryCardColor`, `GetArchitectAttackVfx`, the
`Keywords`/`AddKeyword` mechanism, `ModelDb`'s real namespace/method
signatures, `PotionPoolModel`'s real base member names) can be corrected
from ground truth instead of another guess-and-rebuild round.

## Round 2

The tool now also dumps three more things beyond round 1's abstract-member
scan (same command, no new arguments needed):

- Every `*Play*`, `*Keyword*`, and `*Upgrade*` member on `CustomCardModel`
  (concrete/virtual, not just abstract) — this is how we find `OnPlay`'s
  real parameter types and whether `AddKeyword`/`Keywords` really exist.
- Every `After*`/`On*`/`Before*` member on `CustomRelicModel` — the real
  relic hook method names and signatures.
- Enums named `PowerType`/`PowerStackType` (in addition to round 1's
  `Gender`/`Keyword` search).

If you already ran round 1, just run the exact same command again — the
new sections are additive, nothing from round 1 was removed.

## Round 3

Adds one more dump: every property/field on `CardPlay` itself (the type
`OnPlay`'s real signature — found via round 2 — actually hands you). This
is the last real unknown blocking card-play action logic: Forge currently
guesses `cardPlay.Player`/`cardPlay.Target` as the way to get at the
Creatures involved, based on naming convention alone. This dump will
confirm or correct those two property names directly. Same command as
before — no new arguments.

## Round 12 — multiple example mods, and does one of them already have a working pet/orb?

The example-mod argument (previously a single optional 3rd argument) now
accepts **any number of mods** — pass as many as you like as additional
trailing arguments:

```
dotnet run -- "<game path>" "<BaseLib.dll path>" "<TheTrainerNewCharacter.dll path>" "<TheBurdenedNewCharacter.dll path>"
```

Every round that used to only look at "the example mod" (round 10's own
Cards/Powers/Relics/Characters/TokenCards usage, its Tag/Keyword/
CardPlayed sweep) now loops over every mod passed in, reporting findings
separately per DLL.

New this round: a dedicated pet/orb sweep of each example mod. If a mod
already defines its own pet or orb (Tyler: "I have several pets in my
thetrainernewcharacter.dll... I also have a new orb in my
theburdenednewcharacter.dll"), this is the strongest possible evidence
available — stronger than searching the base game/BaseLib for a
plausible base class name, because a real, working mod's own class tells
us the CONFIRMED real base class straight off `.BaseType`, no guessing.
For every candidate type found (matched by namespace convention —
`.Pets`/`.Companions`/`.Orbs` — or by "Pet"/"Companion"/"Orb" appearing in
the type name), this dumps its full base type chain, every constructor,
and every property/field. Pass TheTrainerNewCharacter.dll and/or
TheBurdenedNewCharacter.dll to run it.

## Round 13 — the real card-upgrade mechanism (Card+/++/+++/++++)

Same command as before — no new arguments needed. This round targets the
single biggest remaining gap in the Card section: `OnUpgrade()`'s NAME and
signature were already confirmed real back in round 4, but nothing has
ever confirmed what a real upgrade actually DOES, or how STS2 represents
a card having more than one upgrade tier (unlike original Slay the Spire,
where a card only ever has one upgrade). Four new dumps:

- **13a** — every TYPE (not just member) anywhere across every loaded
  assembly whose name contains "Upgrade" or "Tier", in case there's a
  dedicated data-holder type (e.g. something like `UpgradeData`/
  `CardTier`) rather than plain fields on `CardModel` itself. Full
  members + constructors dumped for anything found.
- **13b** — every `*Upgrade*`/`*Tier*`/`*Rank*`/`*Level*` member directly
  on `CardModel` itself (round 2 only ever checked `CustomCardModel`,
  its mod-facing subclass) — the most likely place for a real
  `TimesUpgraded`/`UpgradeCount`/`IsUpgraded`-shaped member to live.
- **13c** — the real payoff. Finds every actual base-game card
  (baked into `sts2.dll` itself — real, working, shipped cards, not
  BaseLib's mod-facing base classes) that declares its own `OnUpgrade()`
  override, then reads that method's **actual IL** — not just its
  signature (already known) but what it really *calls*. This works
  because the tool runs under your own real, live .NET runtime, so it
  can use `MethodBody`/`GetILAsByteArray()` directly (a much simpler
  path than the sandbox-side hand-rolled ECMA-335 parser used elsewhere
  in this project to disassemble compiled MOD DLLs offline, which has no
  live CLR to ask). It's a crude decompile — it only identifies
  `call`/`callvirt`/`newobj` instructions and resolves each one back to
  a real method/constructor name, not a full disassembly — but that's
  enough to see, for a real upgradable card, what API it actually
  touches when it upgrades. Capped at 25 cards dumped in full (the rest
  listed by name only) so the output stays readable if the game ships
  hundreds of upgradable cards.
- **13d** — a broad sweep for any static field/property anywhere whose
  name suggests a max-upgrade-tier constant (e.g. `MaxUpgrades`,
  `MAX_UPGRADE_TIER`) — since a card that can upgrade more than once
  needs the engine to know how many times it's allowed to, this is where
  a real cap (if the game exposes one as a named constant reflection can
  see at all) would most likely live. Directly answers whether Forge's
  own `MAX_UPGRADE_TIERS = 4` guess is right.

If any of this surfaces a real multi-tier mechanism, or shows an
`OnUpgrade()` body calling something Forge doesn't already know about,
paste the relevant section of `reflect-output.txt` back into the chat —
that's what unblocks wiring `compiler.js`'s `OnUpgrade()` stub for real.

## Round 14 — X-cost card interaction + a live star/energy count

Same command as before — no new arguments needed. Tyler's ask this round:
"should have some interaction with x cost cards, i.e. deal x damage, or
deal damage x times, or apply x status" and "add optional star cost to
cards, and a conditional that checks for certain amount of stars." The
star-cost-as-a-field half shipped immediately this round — an EXISTING
`reflect-output.txt` sitting on Tyler's machine from a prior run of this
tool (rounds 1-13d) already confirmed `CardModel.BaseStarCost` is a real,
public, settable int property, alongside `CanonicalStarCost`/
`CurrentStarCost`/`TemporaryStarCost`/`HasStarCostX`/`HasEnergyCostX`/
`LastStarsSpent`/`SetStarCostUntilPlayed`/`UpgradeStarCostBy` — none of
which had ever been fully processed into this project's findings before.
What's still missing, and what Round 14 targets, is everything needed to
make X-cost interaction and a "stars remaining" CONDITION real instead of
UI-only stubs. Three new dumps:

- **14a** — full member dumps of `CardEnergyCost`, `TemporaryCardCost`,
  `ResourceInfo`, and `PlayerCombatState` — the types most likely to hold
  either (1) a card's own "how much X was spent to play me" value (needed
  for "deal X damage"/"deal damage X times"/"apply X stacks" to read
  anything at all) or (2) a LIVE current star/energy count (needed for
  the StarsRemaining/EnergyRemaining conditions, which are UI-authorable
  today but compile to a stub — `ForgeActions.TodoCondition(...)` — since
  no confirmed live-read accessor exists yet). None of these four types
  has ever been dumped in full before this round.
- **14b** — a broad substring sweep across EVERY loaded type for any
  property whose name looks like a LIVE star or energy count (contains
  "Star"/"Energy" but not "Cost", AND contains "Current"/"Remaining"/
  "Left"/"Spent"/"Available", or is bare "Star"/"Stars"/"Energy") — in
  case the real accessor lives somewhere none of 14a's four named types
  actually cover. `Player`'s own full member dump (already available)
  was checked by hand and confirmed to have no such property, which is
  what motivated this round in the first place.
- **14c** — the real payoff for X-cost specifically: finds every real,
  concrete card class (baked into `sts2.dll`, not a BaseLib mod-facing
  base class) that declares its own `OnPlay()` override, reads that
  method's actual IL (same `MethodBody.GetILAsByteArray()` approach as
  round 13c, deliberately re-implemented as its own separate helper
  rather than reusing/refactoring 13c's, to avoid any risk of regressing
  that already-verified path), and reports only the ones whose `OnPlay()`
  body calls something matching `EnergyCost`/`StarCost`/`DynamicVar`/
  `ResourceInfo`/`.Resources` — i.e. real, shipped X-cost cards (if any
  exist in the base game) caught in the act of reading their own played
  cost. Capped at 20 matching cards shown in full.

If this surfaces a real "current stars/energy" accessor, or a real
pattern for how a card reads its own X-cost amount inside `OnPlay()`,
paste the relevant section of `reflect-output.txt` back into the chat (or
just let Claude know it's sitting in this folder again — it can be
fetched directly) — that's what unblocks both StarsRemaining/
EnergyRemaining's `TodoCondition` stub AND real X-cost action codegen,
neither of which has any UI yet (deliberately — the "deal X damage"/"X
times"/"apply X stacks" shape is still unknown enough that building UI
for it now would risk needing rework to the data model itself, not just
the codegen, once a real accessor is found).

## Round 15 — the full "then effect" vocabulary, plus targeted Stun/EndTurn searches

Same command as before — no new arguments needed. Tyler's ask this round:
"we should add 2 more effects to the 'then' section. one that stuns the
enemy, and one that ends the players turn. While we are at it, is it
possible to setup the reflect tool to scan for every possible 'then'
effect available for cards?" This closes the "Full 'then effect' scan"
item that's been sitting open in `claude/feature-backlog.md`'s Group C
since round 14 shipped.

`StunEnemy` and `EndTurn` already ship this round as UI-authorable action
types in Forge itself (the card editor's "Then" section), but with
honest `ForgeActions.Todo()` stub codegen — neither has a confirmed real
API yet. This round's job is finding out whether real ones exist, and —
the broader ask — building a full, ranked list of every real action verb
the base game's own cards actually invoke, so future "then effect" ideas
can be checked against ground truth instead of guessed at one at a time.
Three new dumps:

- **15a** — the full-vocabulary scan. Every real, concrete card class's
  own `OnPlay()` override, every `call`/`callvirt`/`newobj` site
  (unfiltered this time — round 14c's version only reported sites
  matching a specific keyword like "EnergyCost"), aggregated across every
  card and ranked by how many DIFFERENT cards call each one. A call site
  many cards share is much more likely to be a genuine, reusable action
  primitive than one only a single oddball card touches once — so the
  most-reused real game API calls surface at the top. Filters out plain
  BCL/language plumbing (`System.*`/`Microsoft.*` — `ToString`,
  collection methods, closures) so the list stays focused on real STS2
  game API rather than C# mechanics every method happens to use. Capped
  at 300 distinct call-sites shown (flagged, not silently truncated, if
  hit) — this is the direct answer to "scan for every possible 'then'
  effect available for cards."
- **15b** — does a real "Stun" status/mechanism exist AT ALL? A broad
  search (not limited to round 8's already-confirmed 247 Powers classes)
  for any type OR member anywhere named like "Stun". Worth knowing
  up-front: "Stun" isn't among the 244 statuses Forge's own
  `BUILTIN_STATUSES` already confirmed real via reflect-baselib round 8/9
  — so there's a real chance STS2 either doesn't have a status by this
  exact name, or calls it something else entirely (a turn-skip flag
  rather than a stacking Power, for instance). This dump is what actually
  answers that, instead of guessing.
- **15c** — does a real "end the turn" API exist, and does any ACTUAL
  base-game card's `OnPlay()` call it? A method-name sweep first
  (anything named like `EndTurn`/`FinishTurn`/"contains both End and
  Turn"), then the same IL-call-site technique as 15a, filtered to
  Turn-shaped call sites, to see whether a real, shipped card ever
  actually calls whatever that method turns out to be.

If 15a surfaces a real, well-attested (many-card) call site for either
effect Tyler wants, or 15b/15c find a real Stun/EndTurn-shaped API by a
different name, paste the relevant section of `reflect-output.txt` back
into the chat (or just let Claude know it's sitting in this folder again)
— that's what moves `StunEnemy`/`EndTurn` from a `Todo()` stub to real
codegen. The 15a dump is also worth skimming on its own even if neither
Stun nor EndTurn turns out to be real — it's the first time this tool has
ever surfaced the FULL vocabulary of real action verbs STS2 cards use,
which is useful evidence for any future "can Forge do X" question, not
just this round's two specific asks.

## What it does NOT do

- It doesn't modify anything — read-only reflection, no code generation.
- It's not part of the shipped Forge app and never will be; it's a one-time
  (or occasional, after a game/BaseLib update) research aid for us, not an
  end-user-facing tool.
- It can't resolve things reflection genuinely can't see — mostly runtime
  *behavior* (what a method actually does), not just its *shape* (name,
  types). Round 13's IL call-site scan is the one exception (it reads
  which OTHER methods/constructors a method's body directly calls), but
  it's still not a real decompile — no local variables, no conditional
  logic, no actual values. If a finding really matters, a real
  decompiler (ILSpy/dnSpy) on that one specific method is the next step.
