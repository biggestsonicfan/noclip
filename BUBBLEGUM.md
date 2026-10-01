# Bubblegum fixes: an audit (Pinboard #248)

This file lists the places where the explorer patches a symptom (a list of model numbers, a fitted threshold, a per-game switch) and the board has a simpler rule underneath. It is the audit of master at `7f17395` (2026-09-30), and nothing in `js/` was changed by it. Line numbers are as of that commit. m2-hle2 has the same audit for its renderer (its `BUBBLEGUM.md`, Pinboard #245/#247); the two share the z-sort, and §1 says where the explorer's case differs.

---

## 1. The z-sort: one bound and four exceptions to it

**The board's rule** (MAME `model2_v.cpp`): each polygon gets one z, chosen by attribute bits 10–11 (previous polygon's, nearest corner, farthest corner, or "behind everything"). Polygons are bucketed by that z and filled nearest first; a pixel is written once, and a tie goes to the later polygon.

**What the explorer does**, unlike m2-hle2, has a real reason not to copy that outright: its camera can go anywhere, and a floor sorted by its nearest corner turns into a wall from a camera the game never uses (`js/viewer.js:94-113`). So it keeps the depth buffer and lets a polygon only *recede* towards its key, and two fitted numbers decide how far:

- the bound, `uZsortRecede` = 12 units (`js/games.js:158`, used at `js/viewer.js:199-206`);
- the cut-off, "a face deeper than the bound keeps its own depth" (`js/viewer.js:204`), added for Aurora Icefield's ice wedges.

Only Sonic The Fighters uses that bound. Fighting Vipers, both HOTDs and Daytona set `recede: 0` (`js/games.js:481, 775, 1171, 1726`) and rely on the depth buffer plus face layers (§2). Every patch in the table below is STF-only and exists because of those two numbers:

| Patch | Where | Keyed on | Symptom it fixed |
|---|---|---|---|
| `floorMaterial` (concede + polygon offset 1/1) | `viewer.js:1100-1105`, chosen by `groundPlate` at `display.js:1682` | the `camera_init` floor plate | South Island floor 517 vs sea 555 |
| `waterMaterial` (concede the whole bound per vertex) | `viewer.js:1137-1139`, chosen by `layer === 'water'` at `app.js:815` | sea 555 (`display.js:1709`), Canyon river 2559-2561 (`display.js:1062`, `1378`) | island and boat hull sinking into the water |
| `concedeMaterial` (concede per pixel) | `viewer.js:1180-1182`, `viewer.js:563-578` | Sphynx rug plate 3332 (`display.js:1481`), Tails' lab ground 78 (`display.js:304`, `2005`), the Canyon river | rug going flat under the camera; launch rail buried (issue 44, the newest one) |
| `standingMaterial` (keep own depth) | `viewer.js:1163-1165`, `ZSORT_KEEP` at `viewer.js:214` | Aurora walruses 1601 and the eight pillars (`display.js:815, 824`) | pillars and walruses sinking through ice 559 |
| Tails' lab sea 74 drawn as a backdrop | `display.js:2003` | one model | the shore shallows lost to the sea once the ground conceded |
| `planeBias` 0/1/2 | `viewer.js:1196-1206`, `display.js:1568-1584` | the stage-record list a model came from | coplanar upper/ground/floor/platform ties |

The pattern is the giveaway. Every one of these is a big plate that the board sorts by a corner hundreds of units away (so everything standing in it wins), which the deep-face cut-off stopped from receding. Each new stage that has such a plate then needs a model number flagged to opt back in. The odd one out is Aurora, where the ice must *not* concede because the reflection and the cage's lower half hang under it, so the things standing on the ice are flagged instead.

**The rule underneath, in a few lines:** a far-corner face (mode 2) that is deeper than the bound concedes the bound a pixel at a time, which is what `concedeMaterial` does now. That is the board's own result for exactly those faces, from any camera: a plate sorted by its far corner loses to whatever lies on it. It would replace `floorMaterial`, `waterMaterial` and `concedeMaterial`, the `groundPlate`/`concede`/`'water'` routing in `app.js:793-819`, `pushConceding`, the `concede` argument of `pushWorld`, the Tails' lab sea-as-backdrop, and the model flags for 517, 555, 2559-2561, 3332 and 78. It would also cover the next stage without a new flag. It could be a per-face attribute set from geometry in `model.js` rather than a per-draw material.

That leaves Aurora as the one exception, and it is a rule too: the only things modelled under that floor are the mirrored draws (`MIRROR_Y`, `display.js:697-700`). A mirrored draw is the reflection *of* the floor's scene, so "a mirrored draw never comes through a non-mirrored floor" (render the mirrored draws first, or give them their own depth range) would let the ice concede like every other plate and would remove `standingMaterial`, `ZSORT_KEEP` and `pushStanding`.

**Risk, to be measured, not assumed:** Aurora is where an unbounded recede went black before (m2-hle2 `17e9b72`), and the cut-off was first added there. The 216-camera South Island count and the 16-stage × 6-camera pixel count quoted in `viewer.js:1128-1135` are the harness that made these patches; the same harness, plus m2-hle2's `grade-zsort.mjs` at the board's cameras (memory: explorer vs MAME pictures), should show the one rule matches them before any of them are deleted.

**Measured (Pinboard #250): no single per-face rule holds.** With every floor/water/concede/standing route removed, four candidate rules were rendered over 16 stages × 8 cameras plus the issue 44/46 links and set views (Flying Carpet, Canyon, South Island, Aurora, Tails' lab), against master:

| Rule | 16-stage px | Breaks |
|---|---|---|
| 1. every deep mode-2 face concedes 12 per vertex | 69k | issue 44 (things outside the lab roof show through it), issue 46 (roof-edge strip), Death Egg bar loses to its column |
| 2. deep, mode 2 and upward-facing | 67k | Tails' lab upper walkways |
| 3. every upward-facing mode-2 face, per pixel, to max(z−12, far corner) | 21k | lab walkways (9.5k px), the Sphynx plinth top stipples, Aurora's reflection shows through the ice |
| 4. every deep mode-2 face, as rule 3 | 31k | issue 46 (54k px), issue 44 |

The reason is the same each time. A walkway attached to the lab wall is within 12 units of the wall, so it concedes to it, but on the board the wall's key is its far corner, far behind the walkway's, and the walkway is drawn over it. A bounded recede only gives the board's answer when both faces recede towards their keys, and letting the deep wall recede too (rule 4) is what the cut-off was added to stop. A depth test can't say "lose to faces with a nearer key"; it can only say "lose to what is within 12 units". Doing better needs the key in the test: for example a stencil pass that tests a plate at its own depth and writes it receded, drawn after the static faces whose keys are farther away. That needs the plates split out of their meshes. Until then the per-model flags stay, because they are the cases where "within 12" and "nearer key" agree.

The floor/sea tie (517 vs 555) is the one thing the rules did fix cleanly, once both concede: a fragment bias of one slope step on the floor plate. The existing polygon offset does that job today, and it still applies, because `gl_FragCoord.z` carries the offset into `gl_FragDepth` on the path without a plane.

`planeBias` turned out not to be a guess: `display.js:1555-1598` takes its three steps from the order the cited draw functions run in (sub_238E4's sixteen, then the floor, then ground_upper_disp and sub_235BC). A submission index would give the same three steps, so this one stays.

## 2. Face layers: a static majority vote standing in for a live sort

`js/layers.js` finds faces lying on each other (within `gap = 0.5`, `tie = 0.02`, `cosine = 0.999`, `layers.js:176`) and ranks each pair by sorting it "as the board would from a spread of directions", taking the order when three in four agree (`share >= 0.75`, `layers.js:361`). Around that sit:

- the window exception (`layers.js:341-343`): a solid face with a larger cut-out after it;
- the circle-breaker for pairs that trade places (`layers.js:363-364`);
- three rule switches, each on for some games and off for others because a grade said so: `keepFar` and `leaveApart` (STF only, `games.js:159`, from m2-hle2 issue #75), and `copies` (Daytona only, `games.js:1726`, issue 38, "only this game asks, because … Sonic The Fighters … is graded … without the rule").

The vote is a precomputed answer to a question the shader could answer per frame: which of these coplanar faces has the nearer board key *from this camera*. Inside a group the faces already share one depth (the group plane, `viewer.js:542-560`), so the board's rule there is just "nearer key wins, tie to the later draw". Writing the face's own key, quantised, into the low bits below the plane depth (`gl_FragDepth = planeDepth - eps * rank(key)`) with `LEQUAL` and draw order would make the ranking exact and camera-dependent, as the board's is. The vote, the 0.75 share, the circle-breaker, the window exception and the three switches would go, and the games would stop needing different rules. The grouping itself (gap, tie, cosine) stays: that only decides which faces share a plane.

This one is less certain than §1. The depth range left under the plane depth is small (24 bits), so the key would have to be quantised coarsely, and the board's own 16-bit buckets are the natural size to try. HOTD's rooms and Daytona's flags are the test, since they lean on the layers hardest.

## 3. Drawing every state at once, then filtering

The board draws one zone, one camera block, one phase at a time. The explorer draws the union of all of them so you can fly through the whole stage, which is fair, but the union then needs heuristics to undo the overlaps:

| What | Where | Keyed on | Real rule |
|---|---|---|---|
| `resolveAlternates` | `placements.js:300-345` | props at one rounded position count as versions of each other if no zone draws them together and their boxes overlap by IoU ≥ 0.25; tie-broken by first zone, zone count, polygon count | take the set the section script's current zone lists (HOTD) |
| Every car lane's block reach | `daytona.js:579-615` | `AREA_REACH = 2` is the board's (`set_area_block`'s 5×5 window); applying it to every lane at once is not | the window round the one camera block, for a chosen point on the course |
| Horse speed clamps | `daytona.js:440-444` | `HORSE_MIN_SPEED 1.0`, `HORSE_MAX_SPEED 6.0`, `HORSE_CATCH_UP 120`, "the explorer's numbers" | the object routine run against one player car |

A "current zone / camera block" state (a slider or the board camera's position) would let each of these read the board's choice instead of guessing it. The union view can stay as an option. The point is that it should not need its own heuristics to look right.

## 4. Unported routines replaced by fitted numbers

- **`courseGround`** (`daytona.js:659-719`) picks the face nearest the lane height and rejects slopes with `ny/len < 0.7`. It stands in for the TGP's ground query (op 0x36). A port would delete the heuristic and the 0.7.
- **Block rounding disagrees with itself:** `gridBlock` and two other places use `Math.round` (`daytona.js:482, 575, 668`), while `boardBlock` uses `Math.trunc` (`daytona.js:641`). So near a block edge, a car's block depends on which function asks. Check the routine's conversion and use one helper. *Fixed (#256).* `get_m_block` (Rev A 0x172a0) converts with `cvtri`, which rounds by the AC register's mode, and the boot code's `modac` at 0xa6c clears that to round-to-nearest. So `Math.round` was right and `boardBlock`'s `Math.trunc` was wrong. All four places now use one helper, `gridBlock`/`blockOf`, rounding ties to even as the FPU does. In every build only `courseReach` changes: course 0 gains block 188, and that block is empty, so nothing drawn changes.
- **`DAYTONA_HORIZON_ROW = 144`** (`scroll.js:174`) was measured in MAME because `camd_99` is not ported. It has a measured source, so this one is low priority.

## 5. A wrong table hidden by a skip

These skips each hide one known decode bug. Fixing the bug removes the skip, and probably fixes other places that use the same data:

- **Fighting Vipers' sky skipped colorxlat.** *Fixed (#250).* The column was wrong because FV was given STF's test-menu defaults (add 22, multiply 54). A MAME boot on empty NVRAM leaves 0x40/0x25 at 0x500234..0x500239. With those, the ROM-built colorxlat equals MAME's dump byte for byte, and the night-city sky is (0,0,46) as MAME draws it. The skip is gone. STF's table was checked the same way and already matched.
- **HOTD's light used `unverifiedLight`.** *Fixed (#250).* MAME's display lists (`m2 geodasm`), taken back through an unrotated stage piece's matrix, give (0.707, -0.707, 0) for both the prototype and revision A. That is `stageLight` unflipped, so the flip is gone.
- **`HEAD_FACE = 0xc000`** (`pose.js:146`, applied for fighters that borrow Bean's animation table, `characters.js:275-292`). It is a constant quarter turn because the head "reads as facing right". The borrowed table's own rest angle is probably the missing data.
- **`motionKin` / `rankMotions`** (`bodies.js:220-322`) guess which motions a lone enemy body uses, from name prefixes and a fitted median test, with a second pass to drop the wrong families. Reading each enemy routine's motion numbers would replace about 100 lines. *Fixed (#263).* `tools/hotd-motions/body_motions.py` reads them: for every routine a spawn record, a constant body store or a constant `sub_2DFD0` body sets up, every motion number reaching a setter in the code the routine runs, plus the body-indexed tables (0x22F70 start motion, 0x94940 states, 0x94C00 attacks, 0x94D10 hits, 0x59FA0 death). The monkeys and class 32's zombies take their body from the record at obj+0x344, not the spawn byte. `rig.bodyMotions` holds the result; `bodyMotionList` keeps the body's joint count. Before, 29 bodies found motions by name and the rest a fitted guess; now 67 of the 68 lead with motions the program plays. BO_zonbi_b_2 is the exception: its only motions are 18-joint zombie ones, and it has 21 joints. The finished game's code was rewritten too far to read the same way, so its table is the prototype's carried over by body and motion name: 58 of its 94 bodies have a row, and 72 have a lead; the 36 bodies new to it lead with their hit reactions. Reading its own routines is still open.

## 6. Small ones

| What | Where | Note |
|---|---|---|
| `platformScale = slot === 7 ? … : [fs, 1.6, fs]` | `display.js:1816` | *Checked (#256):* the board's own rule. `stage_dsp` tests the slot against 7 (Giant Wing) at 0x26530 and scales (fs, fs, fs) there. Now cited, and named `GIANT_WING_SLOT` |
| `CASINO_LEVER` offset `[20, 7, -48]`, `DYNAMITE_SWING_AT`, `GIANT_WING_BLADE_AT`, `GIANT_WING_CLOUDS` | `display.js:671, 848, 934, 941-948` | *Checked (#256):* all ROM immediates, and all agree with the code: the lever at 0x7442c (scale, then translate 20, 7, 48), the swing at 0x75bf4/0x75d18, the blade at 0x771f8, the clouds at 0x76b04-0x76b6c, 0x76c30, 0x76ca4 and 0x77110. Addresses now cited in `display.js` |
| `SKY_RADIUS = 600` and the height estimate beside it | `app.js:1146` | the comment says it is an estimate |
| `SHARED_TEX_SET = 1` and the one-game `texPair: 'literal'` switch | `stages.js:262-273` | taken from captures, not from the routine |
| `bestTextureSet` / `bankTextureSet` | `texture.js:568-600, 814-835` | guess the set of a model with no stage; fine as a fallback, but nothing tells you it is a guess |
| `DAYTONA_PATCHES` | `games.js:~1431-1470` | m2emulator's ROM fixes, already an opt-in switch (off by default); band-aids by definition, but labelled as such |

## Checked and clean

These look like magic numbers but cite the routine or a MAME measurement, and should stay: `SOUTH_ISLAND_CAGE_CORNERS`, `EGGMAN_DOORS`, `MUSHROOM_RINGS`, `FRAME_TABLES`, `CANYON_SLOPE_DIV` (display.js); the `colors.js` constants from sub_74C; `AREA_REACH`, `SLOT_REELS`, `BIRD_RADIUS` (daytona.js); `TAILS_LAB_VECTER_Y`; `partDraws` (a port of sub_764C0); `RAW_MIP_RECTS`; `osage.js`'s gravity and damping; `exhaust.js`'s chest slots; `zanzou.js`'s spacing (checked against 901 MAME captures). The placement opcode sets in `placements.js:50-61` are the stage-script VM's operand lengths.

## Suggested order

1. ~~**"Deep far-corner faces concede" as one rule (§1).**~~ Measured and rejected; see "no single per-face rule holds" in §1. The next try is a key-aware pass, not a rule on depth alone.
2. ~~**Submission index instead of `planeBias` (§1).**~~ Already the cited draw order; stays.
3. ~~**The FV luma column and the HOTD light (§5).**~~ Done (#250), both checked against MAME.
4. **Live key ranking in face layers (§2).** This has the biggest payoff in the layer code, but it is the least certain. Try it on HOTD and Daytona's flags first.
5. **A current-zone/block state (§3) and the TGP ground query (§4).** These are larger features. They are worth doing when the Daytona/HOTD work comes back round.
