import sys

path = "backend/compiler.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# ---- Edit 1: Body sprite block -> also generate a real creature_visuals scene ----
old_body = '''  // ---- Body sprite -> conventional "_creature.png" path, NO confirmed override ----
  const bodyUrl = findAssetDataUrl(characterPackage, ch.bodySpriteAssetRef, 'bodySprite');
  if (bodyUrl) {
    const rel = `${ART_ID_PREFIX}${modIdLower}_creature.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(bodyUrl));
    report.push(`- Body sprite: exported to \\`${rel}\\` by naming convention only \u2014 [BEST EFFORT] no C# override was found for this asset in either disassembled mod (unlike every other field here), so this relies on the game resolving it purely from the filename. If it doesn't show up in-game, this is the first thing to double-check.`);
  } else {
    report.push('- Body sprite: not uploaded, skipped.');
  }
'''
assert content.count(old_body) == 1, "body sprite anchor not found or not unique"

new_body = '''  // ---- Body sprite -> conventional "_creature.png" path, NO confirmed override ----
  // ALSO now the source art for a real creature_visuals/{entry}.tscn scene
  // (see below) -- see TOOLCHAIN_FINDINGS.md "getting the character
  // working for real" for the full evidence trail.
  const bodyUrl = findAssetDataUrl(characterPackage, ch.bodySpriteAssetRef, 'bodySprite');
  if (bodyUrl) {
    const rel = `${ART_ID_PREFIX}${modIdLower}_creature.png`;
    writeBinary(`pack/${rel}`, dataUrlToBuffer(bodyUrl));
    report.push(`- Body sprite: exported to \\`${rel}\\` by naming convention only \u2014 [BEST EFFORT] no C# override was found for this asset in either disassembled mod (unlike every other field here), so this relies on the game resolving it purely from the filename. If it doesn't show up in-game, this is the first thing to double-check.`);

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
      'position = Vector2(0, -128)',
      'scale = Vector2(0.5, 0.5)',
      'texture = ExtResource("2_forge")',
      '',
      '[node name="Bounds" type="Control" parent="."]',
      'unique_name_in_owner = true',
      'layout_mode = 3',
      'anchors_preset = 0',
      'offset_left = -128.0',
      'offset_top = -256.0',
      'offset_right = 128.0',
      'offset_bottom = 0.0',
      'mouse_filter = 2',
      '',
      '[node name="CenterPos" type="Marker2D" parent="."]',
      'unique_name_in_owner = true',
      'position = Vector2(0, -128)',
      '',
      '[node name="IntentPos" type="Marker2D" parent="."]',
      'unique_name_in_owner = true',
      'position = Vector2(0, -316)',
      '',
    ].join('\\n'));
    // Real, single-newline-byte stub -- matches the base game's own
    // exported convention for this exact script (confirmed by extracting
    // it directly from SlayTheSpire2.pck in an earlier round). Real
    // behavior resolves via the base game's already-loaded assembly at
    // runtime, not this file's content.
    writeBinary('pack/src/Core/Nodes/Combat/NCreatureVisuals.cs', loadTemplateBinary('card_trail_assets/NCreatureVisuals.cs'));
    report.push(`- Combat creature sprite: a real \\`creature_visuals/${modIdLower}-${entrySlugLower}.tscn\\` scene is now generated, showing your Body sprite in combat (in place of the previous round's generic base-game "?" fallback). [BEST EFFORT placement -- see TOOLCHAIN_FINDINGS.md] The \\`ForgeCreatureVisualsNullGuard.cs\\` Harmony patch stays in place as a defensive backstop in case this real scene ever fails to load for any reason.`);
  } else {
    report.push('- Body sprite: not uploaded, skipped.');
    report.push('- Combat creature sprite: not exported (no Body sprite uploaded) -- your character will show the generic base-game "?" fallback in combat (see ForgeCreatureVisualsNullGuard.cs / TOOLCHAIN_FINDINGS.md). Upload a Body sprite to fix this.');
  }
'''

content = content.replace(old_body, new_body, 1)

# ---- Edit 2: Card trail VFX -- restore the real bundled scene now that the .sln wall is solved ----
old_trail_report = '''  report.push('- Card trail VFX: no custom trail effect is exported (the real one is base-game-only art this toolchain can\\'t safely bundle from an isolated mod project -- see TOOLCHAIN_FINDINGS.md). A small Harmony patch (Generated/ForgeCardTrailNullGuard.cs) prevents the crash this used to cause -- a card obtained mid-run now flies to the deck and disappears correctly, it just has no particle trail behind it. [VERIFIED FATAL, now fixed via a different mechanism than art export.]');
'''
assert content.count(old_trail_report) == 1, "card trail report anchor not found or not unique"

new_trail_block = '''  // [RESTORED, 2026-09-02 -- see TOOLCHAIN_FINDINGS.md "getting the
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
  report.push(`- Card trail VFX: a real \\`${cardTrailRel}\\` scene is now generated (locally-authored placeholder trail/spark art -- see TOOLCHAIN_FINDINGS.md for why the real base-game art can't be redistributed) -- a card obtained mid-run now flies to the deck with a visible trail effect behind it. [BEST EFFORT art, VERIFIED mechanism] The \\`ForgeCardTrailNullGuard.cs\\` Harmony patch stays in place as a defensive backstop in case this real scene ever fails to load for any reason.`);
'''

content = content.replace(old_trail_report, new_trail_block, 1)

# ---- Edit 3: write pack/{modId}.csproj + .sln unconditionally, so Godot's
# exporter can resolve any Script ext_resource (card trail, creature
# visuals) -- see PackProject.csproj.template's header comment for the
# full real-engine-source evidence trail.
old_modentry_anchor = '''  write('Generated/ForgeCreatureVisualsNullGuard.cs', fillTemplate(loadTemplate('ForgeCreatureVisualsNullGuard.cs.template'), { namespace }));

  // Mod entry point (Harmony bootstrap).
  write('ModEntry.cs', fillTemplate(loadTemplate('ModEntry.cs.template'), { harmonyId: `${modId.toLowerCase()}.patch` }));
'''
assert content.count(old_modentry_anchor) == 1, "ModEntry anchor not found or not unique"

new_modentry_block = '''  write('Generated/ForgeCreatureVisualsNullGuard.cs', fillTemplate(loadTemplate('ForgeCreatureVisualsNullGuard.cs.template'), { namespace }));

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
  write('ModEntry.cs', fillTemplate(loadTemplate('ModEntry.cs.template'), { harmonyId: `${modId.toLowerCase()}.patch` }));
'''

content = content.replace(old_modentry_anchor, new_modentry_block, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("OK - all three edits applied")
