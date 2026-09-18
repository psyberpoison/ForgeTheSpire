// reflect-baselib
//
// One-shot answer to every [UNVERIFIED]/[BEST EFFORT] type guess left in
// Forge's C# templates (Gender, DeckEntryCardColor, GetArchitectAttackVfx,
// the Keywords mechanism, OnPlay's exact parameter types, etc.) — instead
// of guessing one at a time and waiting on the next `dotnet build` to find
// out we guessed wrong, this reflects directly over your own installed
// sts2.dll + BaseLib.dll and prints every abstract member's EXACT type and
// name for the model base classes Forge's generated code has to extend.
//
// USAGE (from this folder):
//   dotnet run -- "<path to data_sts2_windows_x86_64>" "<path to BaseLib.dll>" ["<path to an example mod DLL>"]
//
// Example, using the same paths you've already been giving Forge, plus
// round 10's new third (optional) argument — point it at a real, already-
// compiled mod's own DLL (e.g. one of your installed characters) to also
// reflect ITS types, not just the game/BaseLib's:
//   dotnet run -- "C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64" "C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\BaseLib\BaseLib.dll" "C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\TheTrainerNewCharacter\TheTrainerNewCharacter.dll"
//
// (The BaseLib.dll path is the second argument — optional, but most of what
// this needs to find, like CustomCharacterModel/CustomCardModel, lives
// there, not in sts2.dll. The example-mod path is the third argument —
// also optional, only needed for round 10's CardTag/custom-tag questions,
// which specifically want to see how a REAL compiled mod uses these
// features, not just what BaseLib itself declares.)
//
// It writes everything it prints to reflect-output.txt in this folder too
// — just paste that file's contents back into the chat and it removes the
// remaining guesswork from every template in one shot.

using System.Reflection;
using System.Text;

if (args.Length < 1)
{
    Console.WriteLine("Usage: dotnet run -- <path-to-data_sts2_windows_x86_64> [path-to-BaseLib.dll] [path-to-an-example-mod.dll] [path-to-another-example-mod.dll] ...");
    Console.WriteLine();
    Console.WriteLine("Example (two example mods — round 12 supports any number, not just one):");
    Console.WriteLine(@"  dotnet run -- ""C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64"" ""C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\BaseLib\BaseLib.dll"" ""C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\TheTrainerNewCharacter\TheTrainerNewCharacter.dll"" ""C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\mods\TheBurdenedNewCharacter\TheBurdenedNewCharacter.dll""");
    return 1;
}

string gameDataDir = args[0];
string? baseLibPath = args.Length > 1 ? args[1] : null;
// Round 12: any number of example mod DLLs, not just one — previously a
// single, optional 3rd argument (`exampleModPath`, now retired). Tyler
// has real, working custom pets in TheTrainerNewCharacter.dll and a real,
// working custom orb in TheBurdenedNewCharacter.dll — both answer round
// 11's still-open "does a real mechanism for either exist" questions
// directly: a REAL compiled mod that already does the thing is the
// strongest possible evidence there is, since its own class's `BaseType`
// literally IS the real base class name, no guessing required. Every
// argument from index 2 onward is now treated as an example mod path —
// fully backward compatible, since passing zero or one mod behaves
// identically to every previous round.
var exampleModPaths = args.Skip(2).Where(p => !string.IsNullOrWhiteSpace(p)).ToList();

var sb = new StringBuilder();
void Log(string s)
{
    Console.WriteLine(s);
    sb.AppendLine(s);
}

Assembly? TryLoad(string path)
{
    if (!File.Exists(path))
    {
        Log($"MISSING (skipped): {path}");
        return null;
    }
    try
    {
        Log($"Loading: {path}");
        return Assembly.LoadFrom(path);
    }
    catch (Exception ex)
    {
        Log($"FAILED to load {path}: {ex.Message}");
        return null;
    }
}

var sts2Asm = TryLoad(Path.Combine(gameDataDir, "sts2.dll"));
var baseLibAsm = baseLibPath != null ? TryLoad(baseLibPath) : null;

List<Type> SafeGetTypes(Assembly asm)
{
    try
    {
        return asm.GetTypes().ToList();
    }
    catch (ReflectionTypeLoadException ex)
    {
        Log($"  (partial load from {asm.GetName().Name}: {ex.LoaderExceptions.Length} type(s) failed to load — continuing with the rest)");
        return ex.Types.Where(t => t != null).Select(t => t!).ToList();
    }
}

string TypeName(Type t)
{
    if (t.IsGenericType)
    {
        var name = t.GetGenericTypeDefinition().Name;
        var tick = name.IndexOf('`');
        if (tick >= 0) name = name.Substring(0, tick);
        var genArgs = string.Join(", ", t.GetGenericArguments().Select(TypeName));
        return $"{name}<{genArgs}>";
    }
    return t.FullName ?? t.Name;
}

// Round 6 bugfix (found while re-reading round 2's own dump for this
// round's Creature search): methods like `T GetPower()`/`T GetPower<T>()`
// printed WITHOUT the `<T>` generic-method marker anywhere in this tool's
// output prior to this fix — TypeName(m.ReturnType) already happened to
// print the bare type-parameter name "T" correctly (FullName is null for
// an open generic parameter, so it falls back to .Name), but nothing
// appended `<T>` after the method name itself, so a real generic method
// like `T GetPower<T>()` printed indistinguishable from a hypothetical
// non-generic `T GetPower()` — genuinely ambiguous and easy to miscopy
// into a template. This mirrors the `genArgs` handling the ModelDb static-
// member dump already had; now shared everywhere a method signature gets
// printed.
string MethodNameWithGenericArgs(MethodInfo m) =>
    m.IsGenericMethodDefinition ? $"{m.Name}<{string.Join(", ", m.GetGenericArguments().Select(g => g.Name))}>" : m.Name;

// Round 4 addition: report the REAL access modifier (public/protected/
// internal/etc) for a method, not just whether it's abstract/virtual. A
// real build caught this the hard way — several members reflection had
// correctly found (GenerateAllCards, OnPlay, UnlocksAfterRunAs) turned out
// to be `protected`, not `public`, and every override this tool had
// suggested as `public override ...` failed with CS0507 ("cannot change
// access modifiers when overriding"). Printing accessibility up front
// avoids ever hitting that class of error again.
// Takes MethodBase (not just MethodInfo) so the same helper works for both
// regular methods AND constructors (ConstructorInfo also derives from
// MethodBase) — added in round 6 for DumpConstructors below, no behavior
// change for any existing caller.
string AccessString(MethodBase? m)
{
    if (m == null) return "?";
    if (m.IsPublic) return "public";
    if (m.IsFamily) return "protected";
    if (m.IsFamilyOrAssembly) return "protected internal";
    if (m.IsFamilyAndAssembly) return "private protected";
    if (m.IsAssembly) return "internal";
    if (m.IsPrivate) return "private";
    return "?";
}

void DumpAbstractMembers(Type type)
{
    Log("");
    Log($"===== {type.FullName} =====");
    Log($"  (base: {type.BaseType?.FullName})");
    var t = type;
    var seen = new HashSet<string>();
    var any = false;
    while (t != null && t != typeof(object))
    {
        foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            var accessor = p.GetGetMethod(true) ?? p.GetSetMethod(true);
            if (accessor == null || !accessor.IsAbstract) continue;
            var sig = $"  [from {t.Name}, {AccessString(accessor)}] property {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (!m.IsAbstract || m.IsSpecialName) continue;
            var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
            var sig = $"  [from {t.Name}, {AccessString(m)}] method {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        t = t.BaseType;
    }
    if (!any) Log("  (no abstract members found — either fully concrete or reflection couldn't see them)");
}

// Round 2: unlike DumpAbstractMembers above, this also picks up CONCRETE
// and VIRTUAL members (not just abstract ones) whose name matches a
// pattern — this is how we find things like OnPlay/AddKeyword/Keywords on
// CardModel and the relic hook methods (AfterCardPlayed etc.) on
// RelicModel, none of which are abstract (so DumpAbstractMembers can't see
// them at all) but whose exact signature still matters for whether our
// override compiles.
void DumpMatchingMembers(Type type, Func<string, bool> namePredicate, string label)
{
    Log("");
    Log($"----- {label}: matches found in {type.FullName} and its base classes -----");
    var t = type;
    var seen = new HashSet<string>();
    var any = false;
    while (t != null && t != typeof(object))
    {
        foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (!namePredicate(p.Name)) continue;
            var accessor = p.GetGetMethod(true) ?? p.GetSetMethod(true);
            var kind = accessor == null ? "?" : accessor.IsAbstract ? "abstract" : accessor.IsVirtual ? "virtual" : "concrete";
            var sig = $"  [{t.Name}, {kind}, {AccessString(accessor)}] property {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (m.IsSpecialName || !namePredicate(m.Name)) continue;
            var kind = m.IsAbstract ? "abstract" : m.IsVirtual ? "virtual" : "concrete";
            var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
            var sig = $"  [{t.Name}, {kind}, {AccessString(m)}] method {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        t = t.BaseType;
    }
    if (!any) Log("  (no matches)");
}

var wantedTypeNames = new[]
{
    "AbstractModel",
    "CardModel", "CustomCardModel",
    "CharacterModel", "CustomCharacterModel",
    "RelicModel", "CustomRelicModel",
    "PowerModel", "CustomPowerModel",
    "CardPoolModel", "CustomCardPoolModel",
    "RelicPoolModel", "CustomRelicPoolModel",
    "PotionPoolModel", "CustomPotionPoolModel",
};

var allTypes = new List<Type>();
if (sts2Asm != null) allTypes.AddRange(SafeGetTypes(sts2Asm));
if (baseLibAsm != null) allTypes.AddRange(SafeGetTypes(baseLibAsm));
// Round 10 (extended round 12 for multiple mods): each example mod's own
// types are ALSO folded into allTypes (so the generic "find CardTag
// wherever it lives" search below can see them too, in case a mod ever
// needs to redeclare something) — but the per-mod (Label, Asm, Types)
// list is kept separately too, for round 10d's/round 12's mod-specific
// "which of YOUR classes override/declare this" scans, which deliberately
// do NOT want to also scan every game/BaseLib type (or every OTHER mod's
// types) for the same thing — each mod's findings need to stay
// attributable to that one mod.
var exampleMods = new List<(string Label, Assembly Asm, List<Type> Types)>();
foreach (var p in exampleModPaths)
{
    var asm = TryLoad(p);
    if (asm == null) continue;
    exampleMods.Add((Path.GetFileNameWithoutExtension(p), asm, SafeGetTypes(asm)));
}
var allExampleModTypes = exampleMods.SelectMany(m => m.Types).ToList();
allTypes.AddRange(allExampleModTypes);

Log("");
Log("############################################################");
Log("# Abstract members of every model base class Forge extends #");
Log("############################################################");
foreach (var name in wantedTypeNames)
{
    var matches = allTypes.Where(t => t.Name == name).ToList();
    if (matches.Count == 0)
    {
        Log("");
        Log($"===== {name}: NOT FOUND in either assembly =====");
        continue;
    }
    foreach (var m in matches) DumpAbstractMembers(m);
}

Log("");
Log("############################################################");
Log("# Enums whose name contains Gender/Keyword/PowerType/StackType #");
Log("############################################################");
foreach (var t in allTypes.Where(t => t.IsEnum && (t.Name.Contains("Gender") || t.Name.Contains("Keyword") || t.Name.Contains("PowerType") || t.Name.Contains("StackType"))))
{
    Log("");
    Log($"enum {t.FullName}");
    foreach (var name in Enum.GetNames(t)) Log("  " + name);
}

Log("");
Log("############################################################");
Log("# Round 2: Play/Keyword members on CustomCardModel          #");
Log("############################################################");
var customCardModel = allTypes.FirstOrDefault(t => t.Name == "CustomCardModel");
if (customCardModel != null)
{
    DumpMatchingMembers(customCardModel, n => n.Contains("Play", StringComparison.OrdinalIgnoreCase), "*Play* members");
    DumpMatchingMembers(customCardModel, n => n.Contains("Keyword", StringComparison.OrdinalIgnoreCase), "*Keyword* members");
    DumpMatchingMembers(customCardModel, n => n.Contains("Upgrade", StringComparison.OrdinalIgnoreCase), "*Upgrade* members");
}
else
{
    Log("CustomCardModel not found — can't dump its Play/Keyword/Upgrade members.");
}

Log("");
Log("############################################################");
Log("# Round 2: hook/trigger members on CustomRelicModel         #");
Log("############################################################");
var customRelicModel = allTypes.FirstOrDefault(t => t.Name == "CustomRelicModel");
if (customRelicModel != null)
{
    DumpMatchingMembers(customRelicModel, n => n.StartsWith("After") || n.StartsWith("On") || n.StartsWith("Before"), "hook-shaped members (After*/On*/Before*)");
}
else
{
    Log("CustomRelicModel not found — can't dump its hook members.");
}

// Round 3: for a plain data-holder type (not a model base class to
// override), we don't care about abstract/virtual/concrete at all — just
// "what properties does it expose". Dumps every public+nonpublic instance
// property (and public fields, in case some are exposed as fields instead
// of auto-properties) declared anywhere in the type's hierarchy.
void DumpAllInstanceMembers(Type type)
{
    Log("");
    Log($"===== {type.FullName}: ALL instance properties/fields =====");
    var t = type;
    var seen = new HashSet<string>();
    var any = false;
    while (t != null && t != typeof(object))
    {
        foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            var sig = $"  [{t.Name}] property {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            var sig = $"  [{t.Name}] field {TypeName(f.FieldType)} {f.Name}";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        t = t.BaseType;
    }
    if (!any) Log("  (nothing found)");
}

Log("");
Log("############################################################");
Log("# Round 4: PoolAttribute's real namespace                   #");
Log("############################################################");
// `using BaseLib;` (guessed by naming-convention symmetry with
// `BaseLib.Abstracts`) turned out to be WRONG per a real build (CS0246:
// "PoolAttribute could not be found") — [Pool(typeof(...))] on every
// generated card/relic doesn't compile at all until this is fixed. Instead
// of guessing again, find every type whose name is "PoolAttribute" (or any
// Attribute-derived type with "Pool" in the name, in case the exact name
// differs) and print its real, exact namespace.
foreach (var t in allTypes.Where(t => t.Name == "PoolAttribute" || (typeof(Attribute).IsAssignableFrom(t) && t.Name.Contains("Pool"))))
{
    Log($"  {t.FullName}  (assembly: {t.Assembly.GetName().Name})");
}
if (!allTypes.Any(t => t.Name == "PoolAttribute" || (typeof(Attribute).IsAssignableFrom(t) && t.Name.Contains("Pool"))))
{
    Log("  Nothing found matching \"PoolAttribute\" or an Attribute type containing \"Pool\" — the real attribute may be named something else entirely; if so, tell Claude what [Pool(...)]-equivalent syntax you see in any other real mod source you have access to.");
}

Log("");
Log("############################################################");
Log("# Round 3: CardPlay's own members (resolves OnPlay's body)  #");
Log("############################################################");
var cardPlayType = allTypes.FirstOrDefault(t => t.Name == "CardPlay");
if (cardPlayType != null)
{
    DumpAllInstanceMembers(cardPlayType);
}
else
{
    Log("CardPlay not found in either assembly.");
}

Log("");
Log("############################################################");
Log("# ModelDb — static members (Card<T>()/Relic<T>() etc.)     #");
Log("############################################################");
var modelDb = allTypes.FirstOrDefault(t => t.Name == "ModelDb");
if (modelDb == null)
{
    Log("ModelDb: NOT FOUND by that exact name in either assembly.");
}
else
{
    Log($"Found: {modelDb.FullName}");
    foreach (var m in modelDb.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
    {
        if (m.IsSpecialName) continue;
        var genArgs = m.IsGenericMethodDefinition ? $"<{string.Join(", ", m.GetGenericArguments().Select(g => g.Name))}>" : "";
        var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
        Log($"  static {TypeName(m.ReturnType)} {m.Name}{genArgs}({ps})");
    }
}

// Round 5: CardPlay.Player turned out to be type
// MegaCrit.Sts2.Core.Entities.Players.Player, NOT Creature — but
// ForgeActions' combat helpers (GainBlock/DealDamage/Heal/etc., all
// [VERIFIED] or [BEST EFFORT] against a Creature parameter) need a Creature
// to act on for "target: Self" actions on a played card. There must be some
// way to get from a Player (run/hand/energy-level entity) to the Creature
// that actually has HP/block/powers in combat — this scans Player's own
// properties AND methods (any accessibility) for anything whose type name
// contains "Creature", which should surface it directly instead of guessing
// a property name and waiting on another failed build.
void DumpMembersByTypeNameSubstring(Type type, string substring, string label)
{
    Log("");
    Log($"----- {label}: members of {type.FullName} (and base classes) whose type name contains \"{substring}\" -----");
    var t = type;
    var seen = new HashSet<string>();
    var any = false;
    while (t != null && t != typeof(object))
    {
        foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (!TypeName(p.PropertyType).Contains(substring, StringComparison.OrdinalIgnoreCase)) continue;
            var accessor = p.GetGetMethod(true) ?? p.GetSetMethod(true);
            var kind = accessor == null ? "?" : accessor.IsAbstract ? "abstract" : accessor.IsVirtual ? "virtual" : "concrete";
            var sig = $"  [{t.Name}, {kind}, {AccessString(accessor)}] property {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (!TypeName(f.FieldType).Contains(substring, StringComparison.OrdinalIgnoreCase)) continue;
            var sig = $"  [{t.Name}] field {TypeName(f.FieldType)} {f.Name}";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (m.IsSpecialName) continue;
            if (!TypeName(m.ReturnType).Contains(substring, StringComparison.OrdinalIgnoreCase)) continue;
            var kind = m.IsAbstract ? "abstract" : m.IsVirtual ? "virtual" : "concrete";
            var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
            var sig = $"  [{t.Name}, {kind}, {AccessString(m)}] method {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})";
            if (seen.Add(sig)) { Log(sig); any = true; }
        }
        t = t.BaseType;
    }
    if (!any) Log("  (nothing found)");
}

Log("");
Log("############################################################");
Log("# Round 5: how to get a Creature from a Player               #");
Log("############################################################");
var playerType = allTypes.FirstOrDefault(t => t.FullName == "MegaCrit.Sts2.Core.Entities.Players.Player" || t.Name == "Player");
if (playerType != null)
{
    Log($"Found: {playerType.FullName}  (base: {playerType.BaseType?.FullName})");
    DumpMembersByTypeNameSubstring(playerType, "Creature", "Creature-typed members");
    // Fallback: if nothing above matched, dump everything on Player so
    // Claude can eyeball it for a differently-named combat-entity property.
    DumpAllInstanceMembers(playerType);
}
else
{
    Log("Player not found in either assembly (looked for MegaCrit.Sts2.Core.Entities.Players.Player or any type literally named \"Player\").");
}

// Round 6: a real build (attempt #4) caught a fresh batch of errors,
// all in areas that were NEVER reflection-verified before (the
// CustomCardModel constructor call, CardRarity's real members, whether a
// "CardTarget" type exists at all, and several ForgeActions "...Internal"
// method guesses on Creature) — see TOOLCHAIN_FINDINGS.md "real build
// attempt #4" for the exact errors. Targeted searches for each:

// 6a. Dump every constructor (any accessibility) on CardModel and
// CustomCardModel, with each parameter's exact name and type — the
// current generated `: base(cost: ..., type: ..., rarity: ..., target: ...)`
// call was always a guess (never reflected on), and a real build just
// proved at least two of those four names/types wrong (CS1739 "no
// parameter named 'cost'", CS0103 "CardTarget does not exist").
void DumpConstructors(Type type)
{
    Log("");
    Log($"===== {type.FullName}: constructors =====");
    var any = false;
    foreach (var ctor in type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        var ps = string.Join(", ", ctor.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}" + (p.HasDefaultValue ? $" = {p.DefaultValue ?? "null"}" : "")));
        Log($"  [{AccessString(ctor)}] {type.Name}({ps})");
        any = true;
    }
    if (!any) Log("  (no declared constructors found — may only inherit a base class's)");
}

Log("");
Log("############################################################");
Log("# Round 6: CustomCardModel/CardModel constructors            #");
Log("############################################################");
foreach (var name in new[] { "CardModel", "CustomCardModel" })
{
    foreach (var t in allTypes.Where(t => t.Name == name)) DumpConstructors(t);
}

// 6b. CardRarity's and CardTarget's (or whatever the real target type is
// named) real members. Broadened the enum-name search from round 1 to
// also catch "Rarity"/"Target"/"Type" so this surfaces whatever the real
// type is called even if it isn't literally "CardTarget".
Log("");
Log("############################################################");
Log("# Round 6: CardRarity / CardTarget (or real equivalent)      #");
Log("############################################################");
foreach (var t in allTypes.Where(t => t.IsEnum && (t.Name.Contains("Rarity") || t.Name.Contains("Target") || t.Name == "CardType")))
{
    Log("");
    Log($"enum {t.FullName}");
    foreach (var name in Enum.GetNames(t)) Log("  " + name);
}
// Fallback: if nothing named "*Target*" is an enum, it might be a class/
// struct instead (or not exist under that name at all) — list any type
// (enum or not) in the Cards namespace containing "Target" so Claude can
// see what's actually there.
var targetLikeTypes = allTypes.Where(t => t.Name.Contains("Target") && (t.Namespace?.Contains("Cards") ?? false)).ToList();
if (targetLikeTypes.Count > 0)
{
    Log("");
    Log("-- non-enum-search fallback: all types containing \"Target\" in a *.Cards namespace --");
    foreach (var t in targetLikeTypes) Log($"  {t.FullName}  (IsEnum={t.IsEnum}, IsClass={t.IsClass}, IsValueType={t.IsValueType})");
}

// 6c. Creature's real Damage/Hp/Power-related members — ForgeActions
// guessed `TakeDamageInternal`/`LoseHpInternal`/`ApplyPowerInternal`/
// `GetPowerAmountInternal` purely from the "...Internal" naming
// convention `GainBlockInternal` (the one [VERIFIED] method) established;
// a real build just proved TakeDamageInternal and GetPowerAmountInternal
// don't exist at all, LoseHpInternal needs an extra `ValueProp props`
// argument, and ApplyPowerInternal's first parameter is a `PowerModel`,
// not a `string`. Dump every concrete/virtual member on Creature matching
// these patterns, with full real signatures.
Log("");
Log("############################################################");
Log("# Round 6: Creature's real Damage/Hp/Power members           #");
Log("############################################################");
var creatureType = allTypes.FirstOrDefault(t => t.FullName == "MegaCrit.Sts2.Core.Entities.Creatures.Creature" || t.Name == "Creature");
if (creatureType != null)
{
    DumpMatchingMembers(creatureType, n => n.Contains("Damage", StringComparison.OrdinalIgnoreCase), "*Damage* members");
    DumpMatchingMembers(creatureType, n => n.Contains("Hp", StringComparison.OrdinalIgnoreCase) || n.Contains("Heal", StringComparison.OrdinalIgnoreCase), "*Hp*/*Heal* members");
    DumpMatchingMembers(creatureType, n => n.Contains("Power", StringComparison.OrdinalIgnoreCase), "*Power* members");
    DumpMatchingMembers(creatureType, n => n.Contains("Block", StringComparison.OrdinalIgnoreCase), "*Block* members (sanity-check against the one already-[VERIFIED] GainBlockInternal)");
}
else
{
    Log("Creature not found in either assembly.");
}

// 6d. ValueProp's constructors/static factories — several of the real
// Creature methods above (e.g. LoseHpInternal) take a `ValueProp props`
// argument that ForgeActions currently has no way to construct at all.
Log("");
Log("############################################################");
Log("# Round 6: ValueProp's constructors + static members         #");
Log("############################################################");
var valuePropType = allTypes.FirstOrDefault(t => t.Name == "ValueProp");
if (valuePropType != null)
{
    DumpConstructors(valuePropType);
    Log("");
    Log($"----- static members on {valuePropType.FullName} -----");
    var anyStatic = false;
    foreach (var m in valuePropType.GetMembers(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
    {
        if (m.MemberType == MemberTypes.Method && ((MethodInfo)m).IsSpecialName) continue;
        Log($"  {m.MemberType} {m.Name}");
        anyStatic = true;
    }
    if (!anyStatic) Log("  (no static members found)");
}
else
{
    Log("ValueProp not found in either assembly.");
}

// 6e. PowerModel-related: ApplyPowerInternal wanting a PowerModel (not a
// string) means Forge's mechanic (custom power) references need to
// resolve through ModelDb.Power<T>() the same way card/relic references
// already do via ModelDb.Card<T>()/ModelDb.Relic<T>() — confirm
// ModelDb.Power<T>()'s exact signature (already dumped above under
// "ModelDb — static members", included here again as a pointer) and
// double-check CustomPowerModel's own constructor in case it's also
// guessed wrong like CustomCardModel's was.
Log("");
Log("############################################################");
Log("# Round 6: CustomPowerModel constructors (same risk class    #");
Log("# as CustomCardModel's, not yet build-tested)                #");
Log("############################################################");
foreach (var name in new[] { "PowerModel", "CustomPowerModel" })
{
    foreach (var t in allTypes.Where(t => t.Name == name)) DumpConstructors(t);
}

// Round 7: round 6 confirmed `ApplyPowerInternal(PowerModel power)` takes
// a resolved model instance (not a string), and `PowerModel`/
// `CustomPowerModel`'s only constructor is a parameterless `protected`
// one — so there's no way to pass "how many stacks" through the
// constructor. There must be a settable property (an "Amount"/"Stacks"-
// style member) on PowerModel itself that ForgeActions needs to set
// before calling ApplyPowerInternal. Also: round 6's *Damage* search on
// Creature found only `DamageBlockInternal` (which reduces BLOCK, not
// HP) — no method resembling "deal damage to a creature" exists on
// Creature at all. Combined with `AfterAttack(PlayerChoiceContext,
// AttackCommand command)` / `BeforeAttack(AttackCommand command)` already
// seen in round 2's relic-hook dump, real damage-dealing is most likely
// NOT a single method call at all but a command/builder object
// (`MegaCrit.Sts2.Core.Commands.Builders.AttackCommand`) that gets built
// and then dispatched some other way — this round dumps that type
// directly instead of guessing at a builder API blind.
Log("");
Log("############################################################");
Log("# Round 7: PowerModel's own Amount/Stack-related members     #");
Log("############################################################");
foreach (var name in new[] { "PowerModel", "CustomPowerModel" })
{
    var t = allTypes.FirstOrDefault(x => x.Name == name);
    if (t == null) { Log($"{name} not found."); continue; }
    DumpMatchingMembers(t, n => n.Contains("Amount", StringComparison.OrdinalIgnoreCase) || n.Contains("Stack", StringComparison.OrdinalIgnoreCase) || n.Contains("Count", StringComparison.OrdinalIgnoreCase), $"*Amount*/*Stack*/*Count* members on {name}");
}

Log("");
Log("############################################################");
Log("# Round 7: AttackCommand's shape (how real damage is dealt)  #");
Log("############################################################");
var attackCommandType = allTypes.FirstOrDefault(t => t.Name == "AttackCommand");
if (attackCommandType != null)
{
    Log($"Found: {attackCommandType.FullName}  (base: {attackCommandType.BaseType?.FullName}, IsAbstract={attackCommandType.IsAbstract})");
    DumpConstructors(attackCommandType);
    Log("");
    Log($"----- ALL public+nonpublic instance methods on {attackCommandType.FullName} (its own declared members only) -----");
    var anyM = false;
    foreach (var m in attackCommandType.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (m.IsSpecialName) continue;
        var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
        Log($"  [{AccessString(m)}] {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})");
        anyM = true;
    }
    if (!anyM) Log("  (none)");
    // Also: whatever builds/queues an AttackCommand for real damage has to
    // dispatch it somehow — search every type in both assemblies for any
    // method that TAKES an AttackCommand as a parameter, which should
    // point straight at the real "execute this command" API.
    //
    // Round 8 bugfix: this used to ALSO match `attackCommandType.BaseType`
    // (as a fallback in case the real parameter type were a common base
    // class rather than AttackCommand itself) — but AttackCommand's base
    // is plain `System.Object`, so that fallback accidentally matched
    // EVERY method anywhere taking a bare `object` parameter (Equals(object),
    // etc), bloating a single run's output past this chat's per-file size
    // limit for no benefit. Matching the exact type only.
    Log("");
    Log($"----- methods anywhere in either assembly that take {attackCommandType.Name} as a parameter -----");
    var anyTaker = false;
    foreach (var t in allTypes)
    {
        foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (m.IsSpecialName) continue;
            var ps = m.GetParameters();
            if (!ps.Any(p => p.ParameterType == attackCommandType)) continue;
            var psStr = string.Join(", ", ps.Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
            Log($"  [{t.FullName}, {(m.IsStatic ? "static " : "")}{AccessString(m)}] {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({psStr})");
            anyTaker = true;
        }
    }
    if (!anyTaker) Log("  (none found — the dispatch mechanism must be something other than a direct method parameter, e.g. a fluent .Execute()/.Send() on the command object itself, already covered by the instance-methods dump above)");
}
else
{
    Log("AttackCommand not found in either assembly.");
}

Log("");
Log("############################################################");
Log("# Round 7: ValueProp — is it a struct? what are its fields?  #");
Log("############################################################");
if (valuePropType != null)
{
    Log($"IsValueType={valuePropType.IsValueType}, IsClass={valuePropType.IsClass}, IsAbstract={valuePropType.IsAbstract}");
    Log("(If IsValueType=True, this is a struct — `default(ValueProp)`/`new ValueProp()` is always safely constructible even with zero declared constructors, which explains round 6's empty constructor dump.)");
    DumpAllInstanceMembers(valuePropType);
}
else
{
    Log("ValueProp not found (round 6 already reported this).");
}

// Round 8: ForgeActions.cs.template's generic ApplyStatus<T>()/
// RemoveStatus<T>()/GetStatusStacks<T>() (shipped this round, see
// TOOLCHAIN_FINDINGS.md "reflect-baselib round 7") only work for
// Forge-generated custom mechanics (CustomPowerModel subclasses) — the
// schema's built-in GainStrength/GainDexterity actions still have no real
// class to construct. Round 7's incidental AttackCommand-taker dump
// happened to show several REAL built-in power classes living under
// `MegaCrit.Sts2.Core.Models.Powers` (GigantificationPower, VigorPower,
// etc), confirming that's the right namespace — this lists every type in
// it directly (skipping the `.Mocks` sub-namespace, which is test-only)
// so the real Strength/Dexterity class names (if they follow the same
// "XPower" convention) can be read off directly instead of guessed.
Log("");
Log("############################################################");
Log("# Round 8: built-in power classes (for Strength/Dexterity)   #");
Log("############################################################");
var builtInPowerTypes = allTypes.Where(t => t.Namespace == "MegaCrit.Sts2.Core.Models.Powers" && t.IsClass).OrderBy(t => t.Name).ToList();
if (builtInPowerTypes.Count > 0)
{
    Log($"Found {builtInPowerTypes.Count} type(s) directly in MegaCrit.Sts2.Core.Models.Powers (excluding .Mocks):");
    foreach (var t in builtInPowerTypes) Log($"  {t.FullName}  (base: {t.BaseType?.FullName})");
}
else
{
    Log("No types found directly in namespace MegaCrit.Sts2.Core.Models.Powers.");
}
// Fallback/cross-check: case-insensitive name search for "Strength" or
// "Dexterity" anywhere in either assembly, in case the real classes live
// in a different namespace than guessed above.
Log("");
Log("-- fallback: any type anywhere named like Strength/Dexterity --");
var strDexTypes = allTypes.Where(t => t.Name.Contains("Strength", StringComparison.OrdinalIgnoreCase) || t.Name.Contains("Dexterity", StringComparison.OrdinalIgnoreCase)).ToList();
if (strDexTypes.Count > 0)
{
    foreach (var t in strDexTypes) Log($"  {t.FullName}");
}
else
{
    Log("  (none found by name anywhere in either assembly)");
}

// Round 9a: round 2's CustomCardModel search only checked for
// *Play*/*Keyword*/*Upgrade* substrings — it never ran the broader
// "every After*/On*/Before* member" sweep it ran on CustomRelicModel just
// below it. That means "does CustomCardModel expose anything hook-shaped
// beyond OnPlay/OnUpgrade?" (e.g. a per-card 'when retained' or 'when
// discarded' bonus-effect hook, as opposed to the CardKeyword.Retain/Sly
// flags, which are already confirmed real and don't need this) has never
// actually been checked. Same sweep, same predicate, just pointed at the
// type round 2 skipped it for.
Log("");
Log("############################################################");
Log("# Round 9: hook-shaped members (After*/On*/Before*) on       #");
Log("# CustomCardModel — closes the one gap round 2's narrower    #");
Log("# Play/Keyword/Upgrade-only search on this type left open.   #");
Log("############################################################");
if (customCardModel != null)
{
    DumpMatchingMembers(customCardModel, n => n.StartsWith("After") || n.StartsWith("On") || n.StartsWith("Before"), "hook-shaped members (After*/On*/Before*) on CustomCardModel");
}
else
{
    Log("CustomCardModel not found (see round 2 above) — can't sweep its hook-shaped members.");
}

// Round 9b: closes round 8's flagged open risk. ForgeActions.ApplyStatus<T>()
// requires `T : PowerModel, new()` — a public parameterless constructor —
// but only Strength/Dexterity have actually had their constructors
// reflected on. The other 245 of round 8's 247 built-in power classes are
// unchecked; if one declares its own non-default constructor, picking it
// from Forge's status dropdown would be a hard CS0310 the moment that
// card/relic/mechanic gets built. Dumps every constructor for every class
// round 8 already found in MegaCrit.Sts2.Core.Models.Powers.
Log("");
Log("############################################################");
Log("# Round 9: constructors for every built-in Powers class      #");
Log("# (closes round 8's open ApplyStatus<T>() / new() risk)      #");
Log("############################################################");
if (builtInPowerTypes.Count > 0)
{
    foreach (var t in builtInPowerTypes) DumpConstructors(t);
}
else
{
    Log("No built-in Powers types found (see round 8 above) — nothing to check.");
}

// ============================================================
// ROUND 10: custom card TAGS (as opposed to keywords) — closes
// Tyler's "how does slay.spencerstiles.com manage tag-triggered
// card synergies" question. Round 2's *Keyword* sweep already
// confirmed CardModel.Keywords/CanonicalKeywords are real and
// queryable — this round adds the equivalent search for a SEPARATE
// concept, CardTag, which the BaseLib wiki documents (doc-page
// level, not yet reflected against your own DLLs) as the base
// game's own card-categorization system (e.g. CardTag.Strike, used
// by real Strike-synergy cards), extensible via a `[CustomEnum]`
// attribute so a mod can add its OWN new tag values. A `strings`
// scan of your own TheTrainerNewCharacter.dll already found the
// real identifiers CardTag/CardTags/get_CanonicalTags present — this
// round confirms the actual shape via real reflection instead.
// ============================================================

// Round 10a: same *Tag* substring sweep the existing *Play*/*Keyword*/
// *Upgrade* searches already run on CustomCardModel — closes whether
// it exposes a CanonicalTags-style property the same way it exposes
// CanonicalKeywords (round 2/9 already confirmed the latter).
Log("");
Log("############################################################");
Log("# Round 10: *Tag* members on CustomCardModel                 #");
Log("############################################################");
if (customCardModel != null)
{
    DumpMatchingMembers(customCardModel, n => n.Contains("Tag", StringComparison.OrdinalIgnoreCase), "*Tag* members");
}
else
{
    Log("CustomCardModel not found (see round 2 above) — can't sweep its Tag members.");
}

// Round 10b: find the CardTag type itself, wherever it lives (game,
// BaseLib, or — new this round — the example mod, if one was passed
// as the 3rd argument), report its REAL classification (a plain C#
// `enum` can't be extended by a mod at runtime, so if `[CustomEnum]`
// really lets a mod add new CardTag values, CardTag is almost
// certainly NOT IsEnum — more likely a class/struct with static
// readonly instances, the standard "extensible enum" pattern), and
// dump every public static field/property of type CardTag declared
// ANYWHERE across every loaded assembly — this is how both BaseLib's
// own built-in tag values (e.g. Strike) AND any custom ones a mod
// declares (e.g. Tyler's own, if TheTrainerNewCharacter.dll was
// passed in) show up in one pass.
Log("");
Log("############################################################");
Log("# Round 10: the CardTag type itself                          #");
Log("############################################################");
var cardTagType = allTypes.FirstOrDefault(t => t.Name == "CardTag");
if (cardTagType != null)
{
    Log($"Found: {cardTagType.FullName} (assembly: {cardTagType.Assembly.GetName().Name})");
    Log($"  IsEnum={cardTagType.IsEnum}, IsClass={cardTagType.IsClass}, IsValueType={cardTagType.IsValueType}, IsAbstract={cardTagType.IsAbstract}, base: {cardTagType.BaseType?.FullName}");
    if (cardTagType.IsEnum)
    {
        Log("  (real C# enum — every member below; a mod CANNOT add new members to a real enum at runtime, so [CustomEnum] must work some other way if this is genuinely how mods add tags)");
        foreach (var name in Enum.GetNames(cardTagType)) Log("  " + name);
    }
    else
    {
        Log("  (not IsEnum — consistent with an extensible \"smart enum\" pattern: static readonly instances of this type, discoverable as static fields/properties wherever they're declared)");
        DumpAllInstanceMembers(cardTagType);
    }
    Log("");
    Log("-- every public static field/property of type CardTag, declared anywhere across every loaded assembly (game + BaseLib + example mod, if given) --");
    var foundAny = false;
    foreach (var t in allTypes)
    {
        foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly))
        {
            if (f.FieldType != cardTagType) continue;
            Log($"  [{t.FullName}] static field CardTag {f.Name}");
            foundAny = true;
        }
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly))
        {
            if (p.PropertyType != cardTagType) continue;
            Log($"  [{t.FullName}] static property CardTag {p.Name}");
            foundAny = true;
        }
    }
    if (!foundAny) Log("  (none found — either CardTag values live somewhere reflection-over-loaded-assemblies can't see, e.g. generated at build time, or none of the loaded assemblies declare any)");
}
else
{
    Log("CardTag: NOT FOUND in any loaded assembly (game, BaseLib, or the example mod if one was passed) — the BaseLib wiki's CardTag/CanonicalTags docs may be describing a different/renamed real type, or this needs a newer BaseLib version than what's installed.");
}

// Round 10c: the BaseLib wiki (doc-page level, not yet reflection-
// confirmed) describes a `[CustomEnum]` attribute (generic — used for
// CardTag AND CardKeyword extension) and a `[KeywordProperties(...)]`
// attribute (keyword-specific, controls auto-tooltip-text insertion).
// This searches every loaded assembly for any type whose name contains
// either string and dumps its full shape (constructors + instance
// members) — confirms whether these are real attribute types at all,
// and if so, what their real constructor signature/usable properties
// are, before Forge ever tries to emit one in generated code.
Log("");
Log("############################################################");
Log("# Round 10: CustomEnum / KeywordProperties attribute types    #");
Log("############################################################");
var attrCandidates = allTypes.Where(t => t.Name.Contains("CustomEnum") || t.Name.Contains("KeywordProperties")).ToList();
if (attrCandidates.Count > 0)
{
    foreach (var t in attrCandidates)
    {
        Log($"Found: {t.FullName} (assembly: {t.Assembly.GetName().Name}, base: {t.BaseType?.FullName})");
        DumpConstructors(t);
        DumpAllInstanceMembers(t);
    }
}
else
{
    Log("No type named like CustomEnum/KeywordProperties found in any loaded assembly — the BaseLib wiki's [CustomEnum]/[KeywordProperties] attributes may live under a different name, or need a newer BaseLib version than what's installed.");
}

// Round 10d (extended round 12 for multiple mods): ONLY runs if at least
// one example mod DLL (3rd+ argument) was passed. Lists every type in
// EACH mod's own Cards/Powers/Relics/Characters namespaces (confirms the
// roster by reflection, not just `strings`), then — for each one — lists
// any DECLARED (not inherited) property/method whose name contains "Tag",
// "Keyword", or "CardPlayed" specifically. This is how to see EXACTLY
// which of your own classes override CanonicalTags/Keywords/
// AfterCardPlayed and how, rather than inferring it from `strings` output
// alone (which can only show that a method NAME exists somewhere in the
// file, not which class declares it or what it actually checks). Loops
// over every example mod separately (not merged) so findings stay
// attributable to the specific DLL they came from.
Log("");
Log("############################################################");
Log("# Round 10: example mod(s)' own Tag/Keyword/CardPlayed usage  #");
Log("############################################################");
if (exampleMods.Count > 0)
{
    var modNamespacePrefixes = new[] { ".Cards", ".Powers", ".Relics", ".Characters", ".TokenCards" };
    foreach (var (label, asm, types) in exampleMods)
    {
        var modContentTypes = types.Where(t => t.Namespace != null && modNamespacePrefixes.Any(suffix => t.Namespace.EndsWith(suffix))).OrderBy(t => t.FullName).ToList();
        Log($"--- {label} ({asm.GetName().Name}) ---");
        Log($"Found {modContentTypes.Count} type(s) in its own Cards/Powers/Relics/Characters/TokenCards namespaces.");
        foreach (var t in modContentTypes)
        {
            var matches = new List<string>();
            foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                if (p.Name.Contains("Tag", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Keyword", StringComparison.OrdinalIgnoreCase))
                    matches.Add($"    property {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}");
            }
            foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                if (m.IsSpecialName) continue;
                if (m.Name.Contains("Tag", StringComparison.OrdinalIgnoreCase) || m.Name.Contains("Keyword", StringComparison.OrdinalIgnoreCase) || m.Name.Contains("CardPlayed", StringComparison.OrdinalIgnoreCase))
                {
                    var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
                    matches.Add($"    method {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})");
                }
            }
            if (matches.Count > 0)
            {
                Log($"  {t.FullName}:");
                foreach (var m in matches) Log(m);
            }
        }
        if (modContentTypes.Count == 0)
        {
            Log("  (no Cards/Powers/Relics/Characters/TokenCards namespace types found — check the mod DLL path, or its namespace convention differs from ModId.Cards/.Powers/etc.)");
        }
        Log("");
    }
}
else
{
    Log("No example mod DLLs were given (3rd+ arguments) — skipping this search. Re-run with paths to one or more of your installed mods' own DLLs (e.g. TheTrainerNewCharacter.dll, TheBurdenedNewCharacter.dll) to see exactly which of THEIR classes use CardTag/CanonicalTags/AfterCardPlayed and how.");
}

// ============================================================
// ROUND 11: custom PETS/COMPANIONS and custom ORBS — Tyler's request:
// "We also need to add a section to the page to create custom pets as
// well as orbs." Forge now has a data-capture UI for both (see
// frontend/index.html's Pets/Orbs sections), but generates NO C# from
// either yet — TOOLCHAIN_FINDINGS.md's "Real namespaces, from decompiling
// your two installed mods" section previously found exactly one relevant
// fact: `<ModId>.Orbs.<OrbName>Orb` is a real folder/namespace convention
// in real installed mods, so custom Orbs are a real, supported concept —
// but no base class/constructor was ever reflected. Pets have even less
// evidence: the only confirmed real "pet" concept anywhere is the FIXED
// `Player.Osty` property (round 5) — nothing suggesting a mod can define
// its own. This round closes both gaps directly.
// ============================================================

// Round 11a: does a CustomOrbModel (or any *Orb*-named type at all, so a
// differently-named equivalent isn't missed) exist in BaseLib/sts2, the
// same "Custom<Thing>Model" naming pattern every other confirmed base
// class here follows (CustomCardModel/CustomRelicModel/CustomPowerModel/
// CustomCharacterModel/CustomCardPoolModel/CustomRelicPoolModel/
// CustomPotionPoolModel — 7 for 7 so far)?
Log("");
Log("############################################################");
Log("# Round 11: does a CustomOrbModel (or any *Orb*-named type)   #");
Log("# exist? Closes Tyler's \"custom orbs\" ask.                   #");
Log("############################################################");
var orbNamedTypes = allTypes.Where(t => t.Name.Contains("Orb", StringComparison.Ordinal)).OrderBy(t => t.FullName).ToList();
if (orbNamedTypes.Count > 0)
{
    Log($"Found {orbNamedTypes.Count} type(s) with \"Orb\" in the name:");
    foreach (var t in orbNamedTypes) Log($"  {t.FullName}  (abstract={t.IsAbstract}, class={t.IsClass})");
}
else
{
    Log("  (no type anywhere in sts2.dll/BaseLib.dll/the example mod has \"Orb\" in its name)");
}
var customOrbModel = allTypes.FirstOrDefault(t => t.Name == "CustomOrbModel");
if (customOrbModel != null)
{
    DumpAbstractMembers(customOrbModel);
    DumpConstructors(customOrbModel);
    DumpMatchingMembers(customOrbModel, n => n.StartsWith("After") || n.StartsWith("On") || n.StartsWith("Before") || n.Contains("Evoke", StringComparison.OrdinalIgnoreCase) || n.Contains("Passive", StringComparison.OrdinalIgnoreCase) || n.Contains("Channel", StringComparison.OrdinalIgnoreCase), "hook/evoke/passive/channel-shaped members on CustomOrbModel");
}
else
{
    Log("  CustomOrbModel specifically not found by exact name — if the list above found a differently-named orb base class, re-run DumpAbstractMembers/DumpConstructors on it by hand (or tell Claude its exact name and ask for a follow-up round).");
}
// Also dump every type actually IN the confirmed-real Orbs namespace
// directly, regardless of name — this is how the base game's OWN built-in
// orbs (Frost/Lightning/Dark/Plasma, etc.) are declared, and its base
// class is very likely the same one a custom orb needs to extend.
var coreOrbsTypes = allTypes.Where(t => t.Namespace == "MegaCrit.Sts2.Core.Entities.Orbs").OrderBy(t => t.FullName).ToList();
Log("");
Log($"MegaCrit.Sts2.Core.Entities.Orbs namespace contains {coreOrbsTypes.Count} type(s):");
foreach (var t in coreOrbsTypes)
{
    Log($"  {t.FullName}  (base: {t.BaseType?.FullName}, abstract={t.IsAbstract})");
}
if (coreOrbsTypes.Count == 0)
{
    Log("  (namespace not found in the loaded assemblies — it may live in a game-content assembly this tool wasn't pointed at, e.g. a different DLL than sts2.dll/BaseLib.dll)");
}

// Round 11b: does ANY type (pet/companion/osty-creating) exist that would
// let a mod define a NEW companion creature, as opposed to just reading
// the existing Player.Osty property (round 5, already confirmed)? Broad
// name sweep across every loaded assembly — Pet/Companion/Osty substrings.
Log("");
Log("############################################################");
Log("# Round 11: any custom PET/COMPANION creation mechanism?      #");
Log("# Closes Tyler's \"custom pets\" ask.                          #");
Log("############################################################");
var petNamedTypes = allTypes.Where(t =>
    t.Name.Contains("Pet", StringComparison.OrdinalIgnoreCase) ||
    t.Name.Contains("Companion", StringComparison.OrdinalIgnoreCase) ||
    t.Name.Contains("Osty", StringComparison.Ordinal)
).OrderBy(t => t.FullName).ToList();
if (petNamedTypes.Count > 0)
{
    Log($"Found {petNamedTypes.Count} type(s) matching Pet/Companion/Osty:");
    foreach (var t in petNamedTypes) Log($"  {t.FullName}  (abstract={t.IsAbstract}, class={t.IsClass}, enum={t.IsEnum})");
}
else
{
    Log("  (no type anywhere matches Pet/Companion/Osty except the already-confirmed Player.Osty PROPERTY itself, which isn't a type — see round 5. This is negative evidence, not proof of absence: it means no such mechanism was found by NAME, not that one can't exist under a different name.)");
}
// If Player itself has any method (not just the Osty property) whose name
// suggests creating/assigning/replacing a companion, this would catch it —
// round 5 only ever looked at Player's PROPERTIES (Creature/Osty), never
// swept its methods for anything Osty/companion/pet-creation-shaped.
if (playerType != null)
{
    DumpMatchingMembers(playerType, n =>
        n.Contains("Osty", StringComparison.Ordinal) ||
        n.Contains("Pet", StringComparison.OrdinalIgnoreCase) ||
        n.Contains("Companion", StringComparison.OrdinalIgnoreCase),
        "Osty/Pet/Companion-shaped members on Player (methods, not just the already-confirmed Osty property)");
}
else
{
    Log("  Player type not found (see round 5 above) — can't sweep its methods.");
}

// ============================================================
// ROUND 12: does one of YOUR OWN real, compiled, working mods already
// define a custom pet or a custom orb? Tyler: "I have several pets in my
// thetrainernewcharacter.dll that we might want to reference. I also have
// a new orb in my theburdenednewcharacter.dll that might help in that
// department." This is a categorically STRONGER evidence source than
// round 11's name/namespace sweep of the game+BaseLib alone — round 11
// can only tell us whether a base class EXISTS to extend; a real,
// installed, presumably-working mod that already extends it tells us
// EXACTLY which class that is (read straight off `.BaseType`, no guessing
// at all) and exactly what its constructor/override shape looks like,
// the same "read it straight from a real example" approach round 10
// already used for CardTag/AfterCardPlayed usage. Runs once per example
// mod passed on the command line (see the multi-mod support added above)
// — Tyler can pass both TheTrainerNewCharacter.dll and
// TheBurdenedNewCharacter.dll in the same run.
// ============================================================
Log("");
Log("############################################################");
Log("# Round 12: does an example mod define its own pet/orb?      #");
Log("# (real, compiled, working mods are the strongest evidence   #");
Log("# available — this reads their real base class straight off  #");
Log("# reflection, no guessing.)                                  #");
Log("############################################################");
if (exampleMods.Count > 0)
{
    // Same ModId.<Thing> namespace convention already confirmed for
    // Cards/Powers/Relics/Characters/TokenCards (round 10) and Orbs
    // (previous round's mod-decompile find, <ModId>.Orbs.<OrbName>Orb) —
    // widened here to also catch .Pets/.Companions, in case that's the
    // convention TheTrainerNewCharacter.dll actually uses for its pets.
    var petOrbNamespaceSuffixes = new[] { ".Pets", ".Companions", ".Orbs" };
    foreach (var (label, asm, types) in exampleMods)
    {
        Log($"--- {label} ({asm.GetName().Name}) ---");
        // Two ways to find candidates, unioned: (1) namespace convention
        // match, same as round 10's Cards/Powers/etc. sweep; (2) name
        // substring match (Pet/Companion/Orb), in case this mod doesn't
        // follow the ModId.<Thing> namespace convention at all — a mod
        // author doesn't have to use it, it's just the pattern seen so
        // far. Deliberately over-inclusive (a false positive here just
        // means one extra type dumped; a false negative means missing
        // the exact evidence this round exists to find).
        var candidates = types.Where(t =>
            (t.Namespace != null && petOrbNamespaceSuffixes.Any(suffix => t.Namespace.EndsWith(suffix))) ||
            t.Name.Contains("Pet", StringComparison.OrdinalIgnoreCase) ||
            t.Name.Contains("Companion", StringComparison.OrdinalIgnoreCase) ||
            t.Name.Contains("Orb", StringComparison.Ordinal)
        ).OrderBy(t => t.FullName).ToList();
        if (candidates.Count == 0)
        {
            Log("  (no Pet/Companion/Orb-shaped type found by name or namespace in this mod)");
            Log("");
            continue;
        }
        Log($"Found {candidates.Count} candidate type(s):");
        foreach (var t in candidates)
        {
            Log("");
            Log($"  === {t.FullName} ===");
            // The single most valuable line in this entire round: this
            // mod's own class's REAL base type. If TheTrainerNewCharacter
            // or TheBurdenedNewCharacter already has a working pet/orb,
            // this IS the confirmed real base class Forge needs to
            // extend — no guessing, no round-11-style name pattern
            // inference, read straight from the compiled DLL.
            var baseChain = new List<string>();
            var bt = t.BaseType;
            while (bt != null && bt != typeof(object)) { baseChain.Add(bt.FullName ?? bt.Name); bt = bt.BaseType; }
            Log($"    base type chain: {(baseChain.Count > 0 ? string.Join(" -> ", baseChain) : "(none — extends object directly, or is an interface/enum)")}");
            Log($"    kind: {(t.IsInterface ? "interface" : t.IsEnum ? "enum" : t.IsAbstract ? "abstract class" : "class")}, namespace: {t.Namespace}");
            DumpConstructors(t);
            // Every property/field this type declares, walked all the way
            // up its base chain (DumpAllInstanceMembers, round 3) — a real,
            // working mod's own pet/orb class is small enough that dumping
            // everything on it is more useful here than a name-filtered
            // sweep like round 10/11 use for the much bigger BaseLib types.
            DumpAllInstanceMembers(t);
        }
        Log("");
    }
}
else
{
    Log("No example mod DLLs were given (3rd+ arguments) — skipping this round entirely. Re-run with paths to TheTrainerNewCharacter.dll (pets) and/or TheBurdenedNewCharacter.dll (the new orb) — see the usage examples at the top of this tool's output — to check whether either already has a real, working custom pet/orb implementation to read the base class straight off.");
}

// ============================================================
// Round 13: the real card-UPGRADE mechanism — Tyler: "update the reflect
// tool so that I can run any other tests necessary to get the card
// section working properly." Card+ is the single biggest remaining gap
// in the Card section: OnUpgrade()'s NAME/signature was already confirmed
// real back in round 4 (see compiler.js's upgradeMethod comment), but
// nothing has ever confirmed what a REAL upgrade actually DOES (mutate
// fields directly? call a helper? something else entirely?) or how STS2
// represents a card having MULTIPLE upgrade tiers (Card+/++/+++/++++ —
// unlike original Slay the Spire, which only ever has one). Four passes:
// ============================================================

// 13a. Any TYPE (not just member) anywhere across every loaded assembly
// whose name contains "Upgrade" or "Tier" — round 2 only ever searched
// for member NAMES containing "Upgrade" on CustomCardModel specifically;
// this catches a dedicated data-holder type instead (e.g. something like
// "UpgradeData"/"CardTier"), the same "search broader, not just where we
// already expect it" move round 10b made for CardTag. Every match gets
// its full member list + constructors dumped (DumpAllInstanceMembers/
// DumpConstructors, same as round 10b/12's own data-type dumps).
Log("");
Log("############################################################");
Log("# Round 13a: any type named *Upgrade*/*Tier* in any assembly  #");
Log("############################################################");
var upgradeTierTypes = allTypes.Where(t =>
    t.Name.Contains("Upgrade", StringComparison.OrdinalIgnoreCase) ||
    t.Name.Contains("Tier", StringComparison.OrdinalIgnoreCase)
).OrderBy(t => t.FullName).ToList();
if (upgradeTierTypes.Count > 0)
{
    foreach (var t in upgradeTierTypes)
    {
        Log($"  Found: {t.FullName}  (assembly: {t.Assembly.GetName().Name}, IsEnum={t.IsEnum}, IsClass={t.IsClass}, IsAbstract={t.IsAbstract})");
        if (t.IsEnum)
        {
            foreach (var name in Enum.GetNames(t)) Log("    " + name);
        }
        else
        {
            DumpConstructors(t);
            DumpAllInstanceMembers(t);
        }
    }
}
else
{
    Log("  (no type anywhere named *Upgrade*/*Tier* — the mechanism, if it exists, is expressed some other way, e.g. plain int fields on CardModel itself; see 13b below)");
}

// 13b. *Upgrade*/*Tier*/*Rank*/*Level* MEMBERS directly on CardModel
// itself, not just CustomCardModel (round 2 only ever checked
// CustomCardModel — CardModel is its base, and a "how many times has
// this card been upgraded" counter/flag is exactly the kind of thing
// that would live on the shared base rather than the mod-facing subclass).
// This is the single most likely place to find the real multi-tier
// mechanism Tyler's asking about (e.g. a TimesUpgraded/UpgradeCount int,
// or an IsUpgraded bool that a 2nd-tier system would need something
// richer than to work at all).
Log("");
Log("############################################################");
Log("# Round 13b: *Upgrade*/*Tier*/*Rank*/*Level* members on       #");
Log("# CardModel itself (not just CustomCardModel)                #");
Log("############################################################");
var cardModelType = allTypes.FirstOrDefault(t => t.Name == "CardModel");
if (cardModelType != null)
{
    DumpMatchingMembers(cardModelType, n =>
        n.Contains("Upgrade", StringComparison.OrdinalIgnoreCase) ||
        n.Contains("Tier", StringComparison.OrdinalIgnoreCase) ||
        n.Contains("Rank", StringComparison.OrdinalIgnoreCase) ||
        n.Contains("Level", StringComparison.OrdinalIgnoreCase),
        "*Upgrade*/*Tier*/*Rank*/*Level* members");
}
else
{
    Log("  CardModel not found — can't check it directly (only CustomCardModel was ever checked, back in round 2).");
}

// 13c. The real payoff: find actual REAL cards (base-game cards baked
// into sts2.dll itself, not just BaseLib's mod-facing base classes) that
// declare their OWN OnUpgrade() override, and read the ACTUAL IL of that
// override — not just its signature (already known) but what it really
// CALLS. Reflection alone only shows a method's shape; this goes one
// step further using MethodBody/GetILAsByteArray, which only works
// because this tool runs under a real, live .NET runtime (unlike the
// sandbox-side hand-rolled ECMA-335 parser used elsewhere in this project
// to disassemble compiled MOD DLLs offline — here we can just ask the CLR
// directly). A crude but effective decompile: scan for call/callvirt/
// newobj opcodes and resolve each one's metadata token back to a real
// method/constructor name. This is the best real evidence available for
// "what does a genuine upgrade actually DO" short of Tyler doing a full
// decompile himself.
Log("");
Log("############################################################");
Log("# Round 13c: real base-game cards' OWN OnUpgrade() bodies —   #");
Log("# what do they actually CALL? (real IL, not just signatures)  #");
Log("############################################################");
// A correct (not hand-guessed) IL opcode length table, built directly
// from System.Reflection.Emit.OpCodes' own public static fields — since
// this tool runs under a real, live .NET runtime, the actual opcode
// metadata (each opcode's numeric Value and its OperandType, which
// determines how many bytes follow it) is right there for the taking
// rather than something to hand-type and get wrong. Keyed by Value (a
// short — 1-byte opcodes are 0x00-0xFD/0xFF, 2-byte opcodes prefixed by
// 0xFE are encoded here as 0xFE00 | secondByte, matching how the CLI spec
// itself numbers them).
var ilOpcodeTable = new Dictionary<short, System.Reflection.Emit.OpCode>();
foreach (var field in typeof(System.Reflection.Emit.OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
{
    if (field.GetValue(null) is System.Reflection.Emit.OpCode code) ilOpcodeTable[code.Value] = code;
}

void DumpMethodCallSites(MethodInfo method)
{
    MethodBody? body;
    try { body = method.GetMethodBody(); }
    catch (Exception ex) { Log($"      (couldn't read method body: {ex.Message})"); return; }
    if (body == null) { Log("      (no method body — abstract/extern/compiler-generated passthrough/etc.)"); return; }
    byte[] il;
    try { il = body.GetILAsByteArray() ?? Array.Empty<byte>(); }
    catch (Exception ex) { Log($"      (couldn't read IL bytes: {ex.Message})"); return; }
    if (il.Length == 0) { Log("      (empty IL body)"); return; }
    var module = method.Module;
    var typeGenArgs = method.DeclaringType != null && method.DeclaringType.IsGenericType ? method.DeclaringType.GetGenericArguments() : Type.EmptyTypes;
    var methodGenArgs = method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes;
    var seen = new HashSet<string>();
    var any = false;
    int i = 0;
    while (i < il.Length)
    {
        byte b = il[i];
        short opValue;
        int opSize;
        if (b == 0xFE)
        {
            if (i + 1 >= il.Length) break;
            opValue = (short)(0xFE00 | il[i + 1]);
            opSize = 2;
        }
        else
        {
            opValue = b;
            opSize = 1;
        }
        if (!ilOpcodeTable.TryGetValue(opValue, out var opcode))
        {
            // An opcode byte this table doesn't recognize — can't safely
            // know its operand length, so the scan can't reliably continue
            // past this point without risking treating operand bytes as
            // opcodes. Stop here rather than produce possibly-garbage
            // results; whatever was found above this point is still real.
            Log($"      (scan stopped early at byte offset {i} — unrecognized opcode 0x{opValue:X}; call-sites found above this point are still real, just possibly incomplete for this one method)");
            break;
        }
        i += opSize;
        bool isCallLike = opcode.Value == System.Reflection.Emit.OpCodes.Call.Value
            || opcode.Value == System.Reflection.Emit.OpCodes.Callvirt.Value
            || opcode.Value == System.Reflection.Emit.OpCodes.Newobj.Value;
        if (opcode.OperandType == System.Reflection.Emit.OperandType.InlineSwitch)
        {
            // switch: a 4-byte case count N, then N 4-byte target offsets.
            if (i + 4 > il.Length) break;
            int caseCount = BitConverter.ToInt32(il, i);
            i += 4 + (caseCount * 4);
            continue;
        }
        int operandLen = opcode.OperandType switch
        {
            System.Reflection.Emit.OperandType.InlineNone => 0,
            System.Reflection.Emit.OperandType.ShortInlineBrTarget => 1,
            System.Reflection.Emit.OperandType.ShortInlineI => 1,
            System.Reflection.Emit.OperandType.ShortInlineVar => 1,
            System.Reflection.Emit.OperandType.InlineVar => 2,
            System.Reflection.Emit.OperandType.InlineBrTarget => 4,
            System.Reflection.Emit.OperandType.InlineField => 4,
            System.Reflection.Emit.OperandType.InlineI => 4,
            System.Reflection.Emit.OperandType.InlineMethod => 4,
            System.Reflection.Emit.OperandType.InlineSig => 4,
            System.Reflection.Emit.OperandType.InlineString => 4,
            System.Reflection.Emit.OperandType.InlineTok => 4,
            System.Reflection.Emit.OperandType.InlineType => 4,
            System.Reflection.Emit.OperandType.ShortInlineR => 4,
            System.Reflection.Emit.OperandType.InlineI8 => 8,
            System.Reflection.Emit.OperandType.InlineR => 8,
            _ => 0,
        };
        if (isCallLike && operandLen == 4 && i + 4 <= il.Length)
        {
            int token = BitConverter.ToInt32(il, i);
            try
            {
                var member = module.ResolveMember(token, typeGenArgs, methodGenArgs);
                string kind = opcode.Value == System.Reflection.Emit.OpCodes.Newobj.Value ? "newobj"
                    : opcode.Value == System.Reflection.Emit.OpCodes.Callvirt.Value ? "callvirt" : "call";
                string desc = member is MethodBase mb
                    ? $"{kind} {TypeName(mb.DeclaringType ?? typeof(object))}.{mb.Name}({string.Join(", ", mb.GetParameters().Select(p => TypeName(p.ParameterType)))})"
                    : $"{kind} {member.DeclaringType?.FullName}.{member.Name}";
                if (seen.Add(desc)) { Log("      " + desc); any = true; }
            }
            catch { /* token didn't resolve (generic-context edge case, etc.) — best-effort, skip silently */ }
        }
        i += operandLen;
    }
    if (!any) Log("      (no call/callvirt/newobj instructions found or resolvable — possibly a trivial/empty override, or the scan stopped early on an unrecognized opcode; worth a manual look with a real decompiler like ILSpy/dnSpy on this one method if it matters)");
}

if (cardModelType != null)
{
    var concreteUpgradableCards = allTypes.Where(t =>
        cardModelType.IsAssignableFrom(t) && !t.IsAbstract && t != cardModelType &&
        t.GetMethod("OnUpgrade", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly) != null
    ).OrderBy(t => t.FullName).ToList();
    Log($"Found {concreteUpgradableCards.Count} real, concrete card class(es) that declare their own OnUpgrade() override.");
    if (concreteUpgradableCards.Count == 0)
    {
        Log("  (none — either no base-game card overrides OnUpgrade the ordinary way reflection can see, or upgrades are handled entirely through some other, not-yet-found mechanism. Worth checking 13a/13b's findings above for an alternative shape.)");
    }
    // Capped at 25 — sts2.dll likely ships hundreds of cards; every
    // upgradable one gets dumped up to that cap so this round's output
    // stays readable rather than dumping the entire card list. Flagged
    // explicitly (not a silent truncation) if the cap is hit.
    const int CARD_DUMP_CAP = 25;
    foreach (var t in concreteUpgradableCards.Take(CARD_DUMP_CAP))
    {
        Log("");
        Log($"  === {t.FullName} ===");
        DumpMatchingMembers(t, n =>
            n.Contains("Upgrade", StringComparison.OrdinalIgnoreCase) ||
            n.Contains("Tier", StringComparison.OrdinalIgnoreCase),
            "this card's own *Upgrade*/*Tier* members (in case a real multi-tier card exposes something CardModel itself doesn't)");
        var onUpgrade = t.GetMethod("OnUpgrade", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        if (onUpgrade != null)
        {
            Log($"    OnUpgrade() real IL call-sites:");
            DumpMethodCallSites(onUpgrade);
        }
    }
    if (concreteUpgradableCards.Count > CARD_DUMP_CAP)
    {
        Log("");
        Log($"  ...and {concreteUpgradableCards.Count - CARD_DUMP_CAP} more upgradable card(s) not dumped (capped at {CARD_DUMP_CAP} to keep output readable) — full list of names:");
        foreach (var t in concreteUpgradableCards.Skip(CARD_DUMP_CAP)) Log($"    {t.FullName}");
    }
}
else
{
    Log("  CardModel not found — can't search for real concrete upgradable cards.");
}

// 13d. A card that upgrades MORE THAN ONCE needs the ENGINE to know how
// many times it's allowed to (otherwise nothing would stop it upgrading
// forever) — search every loaded assembly for a static field/property
// whose name suggests a max-upgrade-tier constant (broader than 13a/13b's
// per-type/per-member search: this one specifically targets constants
// like "MaxUpgrades"/"MAX_UPGRADE_TIER"/etc. wherever they live, the same
// "search broad, not just where expected" approach as 13a).
Log("");
Log("############################################################");
Log("# Round 13d: any static field/property that looks like a     #");
Log("# max-upgrade-tier constant, anywhere                        #");
Log("############################################################");
var maxUpgradeFound = false;
foreach (var t in allTypes)
{
    foreach (var f in t.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (!f.Name.Contains("Upgrade", StringComparison.OrdinalIgnoreCase)) continue;
        if (!(f.Name.Contains("Max", StringComparison.OrdinalIgnoreCase) || f.Name.Contains("Limit", StringComparison.OrdinalIgnoreCase) || f.Name.Contains("Count", StringComparison.OrdinalIgnoreCase) || f.Name.Contains("Tier", StringComparison.OrdinalIgnoreCase))) continue;
        object? val = null;
        try { val = f.GetValue(null); } catch { /* best-effort */ }
        Log($"  [{t.FullName}] static field {TypeName(f.FieldType)} {f.Name}{(val != null ? $" = {val}" : "")}");
        maxUpgradeFound = true;
    }
    foreach (var p in t.GetProperties(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (!p.Name.Contains("Upgrade", StringComparison.OrdinalIgnoreCase)) continue;
        if (!(p.Name.Contains("Max", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Limit", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Count", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Tier", StringComparison.OrdinalIgnoreCase))) continue;
        Log($"  [{t.FullName}] static property {TypeName(p.PropertyType)} {p.Name}");
        maxUpgradeFound = true;
    }
}
if (!maxUpgradeFound) Log("  (none found — MAX_UPGRADE_TIERS=4 in Forge's own code stays a guess; if STS2 really caps it differently, it isn't exposed as an obviously-named constant reflection can see)");

// Round 14: X-cost cards ("deal X damage"/"deal damage X times"/"apply X
// stacks") and Star cost + a star-count conditional — Tyler: "should have
// some interaction with x cost cards... add optional star cost to cards,
// and a conditional that checks for certain amount of stars." Round 6's
// full CardModel member dump (already sitting in this tool's own earlier
// output) already turned up real, promising members that were never
// chased down: `BaseStarCost`/`CanonicalStarCost`/`CurrentStarCost`
// (settable int, presumably the star-cost equivalent of BaseCost/
// CanonicalEnergyCost/EnergyCost), `HasEnergyCostX`/`HasStarCostX` (real
// get-only bools — so "X cost" is apparently a genuine flag BaseLib
// tracks, not just Forge's own -1-sentinel convention), and
// `SetStarCostUntilPlayed`/`UpgradeStarCostBy`. But three things are
// still unknown: (1) what `EnergyCost`/`TemporaryStarCost` (the CLASSES
// those cost properties return) actually expose — never fully dumped,
// only ever called via the one confirmed `.UpgradeBy(int)`; (2) where
// the LIVE "how many stars/how much energy does the player have RIGHT
// NOW" count actually lives (needed for a star-count condition, and for
// the existing-but-still-blocked EnergyRemaining condition too) — not on
// Player itself (round 6 dumped it in full, no such member); (3) how a
// card's own OnPlay body would actually read "X" (how much energy/stars
// were spent playing THIS card) to scale a damage/repeat/stack amount by
// it. Four passes:
// ============================================================

// 14a. Full member dump of the cost-related data-holder types themselves
// — CardEnergyCost (what CardModel.EnergyCost returns; only its
// UpgradeBy(int) method has ever been seen, via round 13c's OnUpgrade IL
// sampling, never its full shape) and TemporaryCardCost (what
// CardModel.TemporaryStarCost returns, and what UpgradeStarCostBy's own
// lambda parameter is typed as per round 13's *Upgrade* member dump).
// Same DumpAllInstanceMembers/DumpConstructors treatment round 3/10b/12
// already gave CardPlay/CardTag/pet-candidate types.
Log("");
Log("############################################################");
Log("# Round 14a: CardEnergyCost/TemporaryCardCost/ResourceInfo/   #");
Log("# PlayerCombatState — full member dumps                      #");
Log("############################################################");
foreach (var typeName in new[] { "CardEnergyCost", "TemporaryCardCost", "ResourceInfo", "PlayerCombatState" })
{
    var t = allTypes.FirstOrDefault(x => x.Name == typeName);
    if (t != null)
    {
        DumpConstructors(t);
        DumpAllInstanceMembers(t);
    }
    else
    {
        Log($"  {typeName} not found in any loaded assembly by that exact name.");
    }
}

// 14b. Broad substring search, across EVERY loaded type (not just
// Player/CardModel, both already fully dumped and confirmed NOT to have
// a live "current stars"/"current energy" count) — any instance member
// anywhere whose name suggests a live, spendable resource count. This is
// what a `StarsRemaining`/real `EnergyRemaining` condition would read.
Log("");
Log("############################################################");
Log("# Round 14b: any member anywhere named like a LIVE star/      #");
Log("# energy count (not just the cost-side members above)        #");
Log("############################################################");
var liveResourceFound = false;
foreach (var t in allTypes)
{
    foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        bool starLike = p.Name.Contains("Star", StringComparison.OrdinalIgnoreCase) && !p.Name.Contains("Cost", StringComparison.OrdinalIgnoreCase);
        bool energyLike = p.Name.Contains("Energy", StringComparison.OrdinalIgnoreCase) && !p.Name.Contains("Cost", StringComparison.OrdinalIgnoreCase) && !p.Name.Contains("Icon", StringComparison.OrdinalIgnoreCase) && !p.Name.Contains("HoverTip", StringComparison.OrdinalIgnoreCase);
        if (!starLike && !energyLike) continue;
        bool livelike = p.Name.Contains("Current", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Remaining", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Left", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Spent", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Available", StringComparison.OrdinalIgnoreCase) || p.Name == "Star" || p.Name == "Stars" || p.Name == "Energy";
        if (!livelike) continue;
        Log($"  [{t.FullName}] property {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}");
        liveResourceFound = true;
    }
}
if (!liveResourceFound) Log("  (none found by name — a live star/energy count either has a name this search didn't anticipate, or lives inside one of the 14a data-holder types above under a different-sounding name; check those dumps directly)");

// 14c. Real base-game cards' own OnPlay() bodies — do any of them
// reference EnergyCost/StarCost/DynamicVars/ResourceInfo members
// directly? This is the closest evidence available for how "X" (energy
// or stars spent to play THIS card) would actually be read from inside a
// card's own effect logic, using the exact same IL-call-site technique
// round 13c already used for OnUpgrade (just applied to OnPlay, and
// FILTERED to only report cards whose call-sites actually mention a
// cost/resource-shaped member — OnPlay is far more common than
// OnUpgrade, so dumping every single one unfiltered would be unreadably
// large).
Log("");
Log("############################################################");
Log("# Round 14c: real cards' OnPlay() bodies that reference       #");
Log("# EnergyCost/StarCost/DynamicVar/ResourceInfo members         #");
Log("############################################################");
List<string> GetMethodCallSiteNames(MethodInfo method)
{
    // Deliberately a SEPARATE copy of DumpMethodCallSites' IL-walking
    // core (round 13c), not a refactor of it, so this new, less-tested
    // filtered use can't risk regressing that already-shipped, already-
    // verified code path — this one returns names instead of logging
    // them, silently skipping anything it can't read/resolve rather than
    // logging a diagnostic (14c only cares about matches, not every
    // method's full story the way 13c's direct per-card dump does).
    var names = new List<string>();
    MethodBody? body;
    try { body = method.GetMethodBody(); } catch { return names; }
    if (body == null) return names;
    byte[] il;
    try { il = body.GetILAsByteArray() ?? Array.Empty<byte>(); } catch { return names; }
    if (il.Length == 0) return names;
    var module = method.Module;
    var typeGenArgs = method.DeclaringType != null && method.DeclaringType.IsGenericType ? method.DeclaringType.GetGenericArguments() : Type.EmptyTypes;
    var methodGenArgs = method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes;
    int i = 0;
    while (i < il.Length)
    {
        byte b = il[i];
        short opValue; int opSize;
        if (b == 0xFE) { if (i + 1 >= il.Length) break; opValue = (short)(0xFE00 | il[i + 1]); opSize = 2; }
        else { opValue = b; opSize = 1; }
        if (!ilOpcodeTable.TryGetValue(opValue, out var opcode)) break;
        i += opSize;
        bool isCallLike = opcode.Value == System.Reflection.Emit.OpCodes.Call.Value
            || opcode.Value == System.Reflection.Emit.OpCodes.Callvirt.Value
            || opcode.Value == System.Reflection.Emit.OpCodes.Newobj.Value;
        if (opcode.OperandType == System.Reflection.Emit.OperandType.InlineSwitch)
        {
            if (i + 4 > il.Length) break;
            int caseCount = BitConverter.ToInt32(il, i);
            i += 4 + (caseCount * 4);
            continue;
        }
        int operandLen = opcode.OperandType switch
        {
            System.Reflection.Emit.OperandType.InlineNone => 0,
            System.Reflection.Emit.OperandType.ShortInlineBrTarget => 1,
            System.Reflection.Emit.OperandType.ShortInlineI => 1,
            System.Reflection.Emit.OperandType.ShortInlineVar => 1,
            System.Reflection.Emit.OperandType.InlineVar => 2,
            System.Reflection.Emit.OperandType.InlineBrTarget => 4,
            System.Reflection.Emit.OperandType.InlineField => 4,
            System.Reflection.Emit.OperandType.InlineI => 4,
            System.Reflection.Emit.OperandType.InlineMethod => 4,
            System.Reflection.Emit.OperandType.InlineSig => 4,
            System.Reflection.Emit.OperandType.InlineString => 4,
            System.Reflection.Emit.OperandType.InlineTok => 4,
            System.Reflection.Emit.OperandType.InlineType => 4,
            System.Reflection.Emit.OperandType.ShortInlineR => 4,
            System.Reflection.Emit.OperandType.InlineI8 => 8,
            System.Reflection.Emit.OperandType.InlineR => 8,
            _ => 0,
        };
        if (isCallLike && operandLen == 4 && i + 4 <= il.Length)
        {
            int token = BitConverter.ToInt32(il, i);
            try
            {
                var member = module.ResolveMember(token, typeGenArgs, methodGenArgs);
                string kind = opcode.Value == System.Reflection.Emit.OpCodes.Newobj.Value ? "newobj"
                    : opcode.Value == System.Reflection.Emit.OpCodes.Callvirt.Value ? "callvirt" : "call";
                string desc = member is MethodBase mb
                    ? $"{kind} {TypeName(mb.DeclaringType ?? typeof(object))}.{mb.Name}({string.Join(", ", mb.GetParameters().Select(p => TypeName(p.ParameterType)))})"
                    : $"{kind} {member.DeclaringType?.FullName}.{member.Name}";
                names.Add(desc);
            }
            catch { /* best-effort, skip */ }
        }
        i += operandLen;
    }
    return names;
}
if (cardModelType != null)
{
    var concretePlayableCards = allTypes.Where(t =>
        cardModelType.IsAssignableFrom(t) && !t.IsAbstract && t != cardModelType &&
        t.GetMethod("OnPlay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly) != null
    ).OrderBy(t => t.FullName).ToList();
    Log($"Scanning {concretePlayableCards.Count} real, concrete card class(es) that declare their own OnPlay() override for cost/resource-shaped call-sites...");
    const int MATCH_CAP = 20;
    var matchCount = 0;
    foreach (var t in concretePlayableCards)
    {
        var onPlay = t.GetMethod("OnPlay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        if (onPlay == null) continue;
        var callSites = GetMethodCallSiteNames(onPlay);
        var interesting = callSites.Where(c =>
            c.Contains("EnergyCost", StringComparison.OrdinalIgnoreCase) ||
            c.Contains("StarCost", StringComparison.OrdinalIgnoreCase) ||
            c.Contains("DynamicVar", StringComparison.OrdinalIgnoreCase) ||
            c.Contains("ResourceInfo", StringComparison.OrdinalIgnoreCase) ||
            c.Contains(".Resources", StringComparison.OrdinalIgnoreCase)
        ).ToList();
        if (interesting.Count == 0) continue;
        matchCount++;
        if (matchCount > MATCH_CAP)
        {
            Log($"  ...({matchCount - MATCH_CAP} more matching card(s) not shown, capped at {MATCH_CAP})");
            continue;
        }
        Log("");
        Log($"  === {t.FullName} — OnPlay() reads a cost/resource member ===");
        foreach (var c in interesting) Log("      " + c);
    }
    if (matchCount == 0) Log("  (no card's OnPlay() body referenced any EnergyCost/StarCost/DynamicVar/ResourceInfo member directly — X-cost scaling, if it works this way at all, may be handled somewhere else entirely, e.g. inside CardEnergyCost's own class logic rather than each card's OnPlay; the 14a dump above is the next place to look)");
    else Log($"  {matchCount} card(s) total matched (showing up to {MATCH_CAP}).");
}
else
{
    Log("  CardModel not found — can't search real concrete cards' OnPlay bodies.");
}

// ============================================================
// ROUND 15: the full "then effect" vocabulary, plus targeted Stun/EndTurn
// searches — Tyler: "we should add 2 more effects to the 'then' section.
// one that stuns the enemy, and one that ends the players turn. While we
// are at it, is it possible to setup the reflect tool to scan for every
// possible 'then' effect available for cards?" This closes the "Full
// 'then effect' scan" item that's been sitting open in
// claude/feature-backlog.md's Group C since round 14 shipped (its own
// wording: "a broad reflect-baselib pass over real cards' OnPlay IL to
// enumerate every real action verb STS2 cards use, so Forge's action-type
// list can be checked for completeness").
//
// StunEnemy and EndTurn already ship this round as UI-authorable action
// types (frontend/index.html's ACTION_TYPES) with honest
// ForgeActions.Todo() stub codegen (backend/compiler.js) — neither has a
// confirmed real API yet. This round's job is finding out whether real
// ones exist at all, and — the broader ask — building a full, ranked list
// of every real action verb the base game's own cards actually invoke, so
// future "then effect" ideas can be checked against ground truth instead
// of guessed at one at a time.
// ============================================================

// 15a. THE full-vocabulary scan — every real, concrete card class's own
// OnPlay() override, EVERY call/callvirt/newobj site (unfiltered, unlike
// round 14c's keyword-filtered version), aggregated across ALL cards and
// ranked by how many DIFFERENT cards call each one (a call site many
// cards share is much more likely to be a genuine, reusable action
// primitive than one only a single oddball card touches once). Reuses
// round 14c's GetMethodCallSiteNames(method) — a pure query function
// (returns names, doesn't Log) rather than a Log-writing helper like
// round 13c's DumpMethodCallSites, so reusing it here for a different
// aggregation carries none of the "don't risk regressing an already-
// shipped Log path" concern that motivated 14c keeping its OWN separate
// copy of the IL walker instead of reusing 13c's.
Log("");
Log("############################################################");
Log("# Round 15a: EVERY real action verb STS2 cards' OnPlay()      #");
Log("# bodies call — the full then-effect vocabulary, unfiltered   #");
Log("# (not narrowed to any one keyword like round 14c was),       #");
Log("# ranked by how many different cards call each one            #");
Log("############################################################");
if (cardModelType != null)
{
    var allPlayableCards15a = allTypes.Where(t =>
        cardModelType.IsAssignableFrom(t) && !t.IsAbstract && t != cardModelType &&
        t.GetMethod("OnPlay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly) != null
    ).OrderBy(t => t.FullName).ToList();
    Log($"Scanning {allPlayableCards15a.Count} real, concrete card class(es)' own OnPlay() overrides for every call/callvirt/newobj site (unfiltered this time)...");
    // callSiteDescription -> set of distinct declaring card class names
    // that call it (a HashSet so a card calling the same site more than
    // once inside its own OnPlay only counts once).
    var verbToCards = new Dictionary<string, HashSet<string>>();
    foreach (var t in allPlayableCards15a)
    {
        var onPlay = t.GetMethod("OnPlay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        if (onPlay == null) continue;
        foreach (var callSite in GetMethodCallSiteNames(onPlay).Distinct())
        {
            if (!verbToCards.TryGetValue(callSite, out var set)) { set = new HashSet<string>(); verbToCards[callSite] = set; }
            set.Add(t.Name);
        }
    }
    // Filters out pure BCL/language-plumbing noise (System.*/Microsoft.*
    // calls — ToString, list/collection methods, closures, etc: real
    // C# mechanics every method uses, not STS2 game action verbs) so the
    // ranked list stays focused on real game API. Deliberately does NOT
    // filter by namespace allow-list (e.g. "must start with MegaCrit.") —
    // safer to over-include (a real verb living somewhere unexpected still
    // shows up) than to silently hide one this filter didn't anticipate.
    bool LooksLikeBclNoise(string callSite)
    {
        var afterKind = callSite.IndexOf(' ') + 1;
        var openParen = callSite.IndexOf('(');
        var beforeMethod = callSite.Substring(afterKind, (openParen > afterKind ? openParen : callSite.Length) - afterKind);
        var lastDot = beforeMethod.LastIndexOf('.');
        var typePart = lastDot >= 0 ? beforeMethod.Substring(0, lastDot) : beforeMethod;
        return typePart.StartsWith("System.") || typePart.StartsWith("Microsoft.");
    }
    var ranked = verbToCards
        .Where(kv => !LooksLikeBclNoise(kv.Key))
        .OrderByDescending(kv => kv.Value.Count)
        .ThenBy(kv => kv.Key)
        .ToList();
    Log($"Found {ranked.Count} distinct real (non-BCL) call-site(s) across every card's OnPlay(), out of {verbToCards.Count} total before filtering.");
    Log("Sorted by how many DIFFERENT cards call each one (most common — i.e. most likely to be a genuine, reusable action primitive — first). Format: [N card(s), e.g. examples] call-site.");
    // Capped, not silently truncated — flagged explicitly if hit, same
    // convention as round 13c/13d's CARD_DUMP_CAP.
    const int VERB_CAP = 300;
    foreach (var kv in ranked.Take(VERB_CAP))
    {
        var exampleCards = string.Join(", ", kv.Value.OrderBy(c => c).Take(3));
        Log($"  [{kv.Value.Count} card(s), e.g. {exampleCards}{(kv.Value.Count > 3 ? ", ..." : "")}] {kv.Key}");
    }
    if (ranked.Count > VERB_CAP)
    {
        Log($"  ...and {ranked.Count - VERB_CAP} more distinct call-site(s) not shown (capped at {VERB_CAP} to keep this file readable) — DEFINITELY not exhaustive of the tail; ask Claude for a keyword-filtered follow-up sweep (round 14c's pattern) for anything specific suspected to be in it.");
    }
}
else
{
    Log("  CardModel not found — can't run the full then-effect vocabulary scan.");
}

// 15b. Does a real "Stun" status/mechanism exist AT ALL? Broadest
// possible net: any TYPE anywhere (not just round 8's confirmed 247 in
// MegaCrit.Sts2.Core.Models.Powers) whose name contains "Stun", PLUS any
// member (property/method/field) anywhere named like "Stun" in case it's
// not a Power class at all but some other real mechanism (e.g. a
// CombatManager/Creature flag that skips a turn instead of a stacking
// status).
Log("");
Log("############################################################");
Log("# Round 15b: does a real \"Stun\" status/mechanism exist?      #");
Log("############################################################");
var stunTypes = allTypes.Where(t => t.Name.Contains("Stun", StringComparison.OrdinalIgnoreCase)).ToList();
if (stunTypes.Count > 0)
{
    Log($"Found {stunTypes.Count} type(s) with \"Stun\" in the name:");
    foreach (var t in stunTypes) Log($"  {t.FullName}  (base: {t.BaseType?.FullName}, assembly: {t.Assembly.GetName().Name})");
}
else
{
    Log("  No type anywhere (game, BaseLib, or example mods) has \"Stun\" in its name — STS2 likely does not have a status literally called \"Stun\" (consistent with it also being absent from the confirmed 244-status BUILTIN_STATUSES list already in this app). It may use a different name for a similar effect — worth asking Tyler what real in-game effect he means by \"stun\" before assuming this needs new plumbing (the closest existing entries by theme are Slow/Confused/Skittish/Weak).");
}
Log("");
Log("-- fallback: any member (property/method/field) anywhere named like \"Stun\" --");
var stunMemberFound = false;
foreach (var t in allTypes)
{
    foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (!p.Name.Contains("Stun", StringComparison.OrdinalIgnoreCase)) continue;
        Log($"  [{t.FullName}] property {TypeName(p.PropertyType)} {p.Name}");
        stunMemberFound = true;
    }
    foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (m.IsSpecialName || !m.Name.Contains("Stun", StringComparison.OrdinalIgnoreCase)) continue;
        var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
        Log($"  [{t.FullName}] method {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})");
        stunMemberFound = true;
    }
    foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (!f.Name.Contains("Stun", StringComparison.OrdinalIgnoreCase)) continue;
        Log($"  [{t.FullName}] field {TypeName(f.FieldType)} {f.Name}");
        stunMemberFound = true;
    }
}
if (!stunMemberFound) Log("  (none found)");

// 15c. Does a real "end the turn" API exist, and — the real payoff — does
// any ACTUAL base-game card's OnPlay() call it? Two parts: a broad
// method-name sweep (EndTurn/FinishTurn/anything containing both "End"
// and "Turn"), then the same IL-call-site technique as 15a/round 14c,
// filtered to Turn-shaped call sites.
Log("");
Log("############################################################");
Log("# Round 15c: does a real \"end the turn\" API exist, and does  #");
Log("# any real card's OnPlay() actually call it?                  #");
Log("############################################################");
var endTurnMembers = new List<string>();
foreach (var t in allTypes)
{
    foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
    {
        if (m.IsSpecialName) continue;
        var nameHasEndTurn = m.Name.Contains("EndTurn", StringComparison.OrdinalIgnoreCase)
            || m.Name.Contains("FinishTurn", StringComparison.OrdinalIgnoreCase)
            || (m.Name.Contains("End", StringComparison.OrdinalIgnoreCase) && m.Name.Contains("Turn", StringComparison.OrdinalIgnoreCase));
        if (!nameHasEndTurn) continue;
        var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
        endTurnMembers.Add($"  [{t.FullName}, {(m.IsStatic ? "static " : "")}{AccessString(m)}] {TypeName(m.ReturnType)} {MethodNameWithGenericArgs(m)}({ps})");
    }
}
if (endTurnMembers.Count > 0)
{
    Log($"Found {endTurnMembers.Count} method(s) anywhere named like ending/finishing a turn:");
    foreach (var s in endTurnMembers) Log(s);
}
else
{
    Log("  No method anywhere is named like ending/finishing a turn — worth checking CombatManager's/PlayerCombatState's full member dump (search this file for those type names) by hand for a differently-named equivalent (e.g. something phrased as \"pass\"/\"advance\" instead of \"end\").");
}
if (cardModelType != null)
{
    Log("");
    Log("-- real base-game cards whose OnPlay() body calls something Turn-shaped --");
    var allPlayableCards15c = allTypes.Where(t =>
        cardModelType.IsAssignableFrom(t) && !t.IsAbstract && t != cardModelType &&
        t.GetMethod("OnPlay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly) != null
    ).OrderBy(t => t.FullName).ToList();
    var turnMatchCount = 0;
    const int TURN_MATCH_CAP = 20;
    foreach (var t in allPlayableCards15c)
    {
        var onPlay = t.GetMethod("OnPlay", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        if (onPlay == null) continue;
        var interesting = GetMethodCallSiteNames(onPlay).Where(c => c.Contains("Turn", StringComparison.OrdinalIgnoreCase)).Distinct().ToList();
        if (interesting.Count == 0) continue;
        turnMatchCount++;
        if (turnMatchCount > TURN_MATCH_CAP) { Log($"  ...({turnMatchCount - TURN_MATCH_CAP} more not shown, capped at {TURN_MATCH_CAP})"); continue; }
        Log($"  === {t.FullName} ===");
        foreach (var c in interesting) Log("      " + c);
    }
    if (turnMatchCount == 0) Log("  (no card's OnPlay() body called anything Turn-shaped — a real \"end your turn as a card effect\" card may not exist in the base game at all, or calls something not named with \"Turn\" in it — if 15a's full vocabulary dump above shows a plausible differently-named candidate, e.g. something in a Combat/Phase-sounding type, check that instead)");
    else Log($"  {turnMatchCount} card(s) total matched (showing up to {TURN_MATCH_CAP}).");
}
else
{
    Log("  CardModel not found — can't search real concrete cards' OnPlay bodies for Turn-shaped calls.");
}

var outPath = Path.Combine(AppContext.BaseDirectory, "reflect-output.txt");
try
{
    File.WriteAllText("reflect-output.txt", sb.ToString());
    Log("");
    Log($"Full output also written to reflect-output.txt (in the folder you ran `dotnet run` from) — please share that file's contents.");
}
catch (Exception ex)
{
    Log($"(Couldn't write reflect-output.txt: {ex.Message} — the console output above has everything, just copy it directly.)");
}

return 0;
