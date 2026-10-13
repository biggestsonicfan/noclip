# Bubblegum fixes: an audit (Pinboard #248, refreshed #712)

This file lists the places where the explorer patches a symptom (a list of model numbers, a fitted threshold, a per-game switch) and the board has a simpler rule underneath. The first audit was of master at `7f17395` (2026-09-30); §1-§6 keep its findings and what each fix did, with line numbers as of that commit. The refresh (Pinboard #712) is of master at `213fb82` (2026-10-12), after Virtua Cop, Virtua Fighter 2, the Cells tab and the Virtua Cop z-fight issues landed; its new findings are §7 and §8, with line numbers as of that commit. Nothing in `js/` was changed by either audit. m2-hle2 has the same audit for its renderer (its `BUBBLEGUM.md`, Pinboard #245/#247); the two share the z-sort, and §1 says where the explorer's case differs.

## Where things stand (2026-10-12)

Everything the first audit found is fixed or checked, except three things no routine has been read for yet (the finished HOTD's prop lifetimes and enemy routines, and the lone models no routine names; see "Suggested order"). The z-sort flags (§1), the static layer vote (§2), the union heuristics (§3), the fitted ground and horizon (§4), the skips (§5) and the small ones (§6) are all gone or cited.

What has grown back is in the same place §2 cleared: the face layers. Since 2026-10-11 `js/layers.js` has gained seven fitted rules, each from one Virtua Cop stage 3 issue (69, 71, 73, 78, 80, 82, 83), and every one of them applies to every game that has `layers` on: STF, both HOTDs, every Daytona, Virtua Cop and VF2. None was graded on anything but the issue's own view. §7 lists them and what the board's rule under them may be. That is the one cross-game item open, and the one to do next.

The two new games (§8) are mostly read from their routines. What is not is labelled in the code: a few per-type lists from MAME runs in Virtua Cop, and VF2's fight-driven effects, which are switches marked "stand-in".

---

## 1. The z-sort: one bound and four exceptions to it

**The board's rule** (MAME `model2_v.cpp`): each polygon gets one z, chosen by attribute bits 10–11 (previous polygon's, nearest corner, farthest corner, or "behind everything"). Polygons are bucketed by that z and filled nearest first; a pixel is written once, and a tie goes to the later polygon.

**What the explorer does**, unlike m2-hle2, has a real reason not to copy that outright: its camera can go anywhere, and a floor sorted by its nearest corner turns into a wall from a camera the game never uses (`js/viewer.js:94-113`). So it keeps the depth buffer and lets a polygon only *recede* towards its key, and two fitted numbers decide how far:

- the bound, `uZsortRecede` = 12 units (`js/games.js:158`, used at `js/viewer.js:199-206`);
- the cut-off, "a face deeper than the bound keeps its own depth" (`js/viewer.js:204`), added for Aurora Icefield's ice wedges.

Only Sonic The Fighters uses that bound (still true at `213fb82`: Virtua Cop and VF2 set `recede: 0` too). Fighting Vipers, both HOTDs and Daytona set `recede: 0` (`js/games.js:481, 775, 1171, 1726`) and rely on the depth buffer plus face layers (§2). Every patch in the table below is STF-only and exists because of those two numbers:

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

**Done (Pinboard #258): a key-aware pass and the board's windows.** Two things replace the flags. The first is the board's own layering, which the per-model flags were standing in for. The geometry processor files every draw in one of eight windows (`set_window` 0x5564, called once per pass), and the rasterizer fills them last to first, so a later window covers an earlier one whatever the keys. The floor is in window 1; the ground and sea 555 are in 2; Aurora's extras and the Sphynx rug are in 3; the platform and the Canyon deck are in 4; the cage and most objects are in 5. Routines reach the earlier windows through the slot records at 0x50183C. Every entry in the explorer's stage list now carries its window (`display.js`, `OBJECT_WINDOWS` and the routine defaults). All 340 explorer draws that appear in the board's lists from m2-hle2 match replays and the attract agree with the board's window.

The second is `Viewer.drawScene`. One pass records the nearest surface at each pixel (leaving out window 1, the backdrop) with its key. The keyed faces are then drawn window by window, sorted by key inside each window, and a face only counts where it is within `uKeyReach` = 1 of that nearest surface. Mirrored draws never come through a surface that isn't mirrored, which is Aurora's ice without `standingMaterial`. Everything else falls back to true depth. This removes `floorMaterial`, `waterMaterial`, `concedeMaterial`, `standingMaterial`, `ZSORT_KEEP`/`ZSORT_CONCEDE`, `pushStanding`/`pushConceding`, the `groundPlate`/`concede`/`'water'` routing, `surfaceCorners`, the lab sea as backdrop, and the flags for 517, 555, 2559-2561, 3332, 78 and the Aurora pillars and walruses.

Measured against #48 over 16 stages × 8 cameras plus the issue 44/46 views: 278k px changed, mostly from orbit cameras the board never uses. The two largest are Mushroom Hill seen from outside the canopy, where the arena now shows through as the board would draw it, and Giant Wing's cloud sheets. Issue 44 now has its girders whole and issue 46 is unchanged. At the board's own cameras (MAME match replays of stages 1, 2, 5, 7, 10 and 12, explorer rendered from the recorded camera):

- Casino Night's table goes from blue to the board's dark green: of 726k changed px, 437k are nearer MAME and 127k further.
- The Giant Wing clouds reach down to the deck as in MAME.
- Mushroom Hill shows the stems' ground shadows that MAME shows.
- Stages 1, 2 and 10 are within framing noise.

A reach of 12 was worse everywhere (issue 46 alone 62k px).

`planeBias` turned out not to be a guess: `display.js:1555-1598` takes its three steps from the order the cited draw functions run in (sub_238E4's sixteen, then the floor, then ground_upper_disp and sub_235BC). A submission index would give the same three steps, so this one stays.

## 2. Face layers: a static majority vote standing in for a live sort

`js/layers.js` finds faces lying on each other (within `gap = 0.5`, `tie = 0.02`, `cosine = 0.999`, `layers.js:176`) and ranks each pair by sorting it "as the board would from a spread of directions", taking the order when three in four agree (`share >= 0.75`, `layers.js:361`). Around that sit:

- the window exception (`layers.js:341-343`): a solid face with a larger cut-out after it;
- the circle-breaker for pairs that trade places (`layers.js:363-364`);
- three rule switches, each on for some games and off for others because a grade said so: `keepFar` and `leaveApart` (STF only, `games.js:159`, from m2-hle2 issue #75), and `copies` (Daytona only, `games.js:1726`, issue 38, "only this game asks, because … Sonic The Fighters … is graded … without the rule").

The vote is a precomputed answer to a question the shader could answer per frame: which of these coplanar faces has the nearer board key *from this camera*. Inside a group the faces already share one depth (the group plane, `viewer.js:542-560`), so the board's rule there is just "nearer key wins, tie to the later draw". Writing the face's own key, quantised, into the low bits below the plane depth (`gl_FragDepth = planeDepth - eps * rank(key)`) with `LEQUAL` and draw order would make the ranking exact and camera-dependent, as the board's is. The vote, the 0.75 share, the circle-breaker, the window exception and the three switches would go, and the games would stop needing different rules. The grouping itself (gap, tie, cosine) stays: that only decides which faces share a plane.

This one is less certain than §1. The depth range left under the plane depth is small (24 bits), so the key would have to be quantised coarsely, and the board's own 16-bit buckets are the natural size to try. HOTD's rooms and Daytona's flags are the test, since they lean on the layers hardest.

*Done (Pinboard #259).* The vote, the window exception, the circle-breaker and the three switches are gone; the grouping stays. `rankLayers` keys each paired face as the board does (near or far corner, or "very far", by its z mode, rounded to the 12-bit-mantissa bucket of `float_to_zval`) from the camera about to draw, puts the later face on top in a tie, and gives each face its longest path up as its layer. That runs on the CPU every frame (well under 1 ms for HOTD's 2262 paired faces and Daytona's 16147), not in the depth bits: a 24-bit step is about 3e-6·z² view units, a quarter of a unit 300 out, which no key could hide under. A copy (`twins`) is now ranked in every game. Graded against MAME, on the pixels the change moved: Casino Night, 61 frames of the board camera, 1.58M pixels nearer MAME and 0.35M further (the blue disc the vote laid over the floor is gone); Flying Carpet changes only the desert, which does not register with MAME; Dinosaur Canyon (349 frames) changes at most 33 pixels a frame, the flags unchanged. HOTD could not be graded: attract keeps no view matrix in main RAM.

*Since then (#712):* the live ranking is no longer the sort alone. Seven rules have been added on top of it for Virtua Cop's stage 3, and they apply to every game with `layers` on. See §7.

## 3. Drawing every state at once, then filtering

The board draws one zone, one camera block, one phase at a time. The explorer draws the union of all of them so you can fly through the whole stage, which is fair, but the union then needs heuristics to undo the overlaps:

| What | Where | Keyed on | Real rule |
|---|---|---|---|
| `resolveAlternates` | `placements.js:300-345` | props at one rounded position count as versions of each other if no zone draws them together and their boxes overlap by IoU ≥ 0.25; tie-broken by first zone, zone count, polygon count | take the set the section script's current zone lists (HOTD) |
| Every car lane's block reach | `daytona.js:579-615` | `AREA_REACH = 2` is the board's (`set_area_block`'s 5×5 window); applying it to every lane at once is not | the window round the one camera block, for a chosen point on the course |
| Horse speed clamps | `daytona.js:440-444` | `HORSE_MIN_SPEED 1.0`, `HORSE_MAX_SPEED 6.0`, `HORSE_CATCH_UP 120`, "the explorer's numbers" | the object routine run against one player car |

A "current zone / camera block" state (a slider or the board camera's position) would let each of these read the board's choice instead of guessing it. The union view can stay as an option. The point is that it should not need its own heuristics to look right.

**Done (#260):**

- HOTD: `resolveAlternates` is gone. Each stage carries its zones in script order (`zoneViews`, `placements.js`), and a **Zone** picker draws exactly the placements the picked zone lists, under the set it is drawn with. A stage opens in its first zone. "Every zone at once" is the plain union, with no filtering, so versions at one spot overlap there. The Models tab still credits a stage with every zone's models. Props are now split by zone too. No opcode removes a prop: each closes itself in `sub_33320`, which the prop handler (0x30670) calls every frame. It closes once the script index (0x520089) has changed more times than its record's halfword (obj+0x6C), or once its camera-frame window (record +0x25, rows at 0x85940) ends with it hidden. `propZones` runs that clock over the scripts and the branch table, and a zone draws the props drawn while it is current. Zone 3 of Stage 1, set 1 went from 31 props to none, and zone 1 to 2. The finished game's addresses for this are not in its profiles, so it still draws every prop in every zone.
- Daytona: a **Blocks drawn** picker. "The 5×5 blocks round the camera" builds every block and shows, each frame, those that `courseArea` puts in the board's area bitmap (0x501520) for the camera. `set_area_block` (Rev A 0x172E8) makes it from the 5×5 round the camera's block with three cuts: the course edges; a cut by heading (0x1770C, unnamed), which takes one of four records by the quarter the car faces and opens the cells of the record's block corners that lie ahead (tables Rev A 0x17908, 1993 0x17658, Special Edition 0x17D84, Saturn-era `daytonas` 0x17DF4); and `extra_clip` (0x17688), which is not a heading cut but a cut by road position, on Dinosaur Canyon only (36-byte records {lo, hi, 16 row masks}, Rev A 0x175E0). The road position is the car's +0x12C: the point the road table at course row +4 gives for the last road polygon the car stood on (0x10F30; a polygon is road when its attribute byte, through row +0xC, has low nibble 1). The explorer takes the polygon from `courseGround` under the camera. Against 5,700 frames of the board's bitmap logged in MAME it differs on 23, single cells whose corner stands within a unit and a half of the quarter's edge, where the TGP's sine and the explorer's differ, and the frames of a camera cut, where the board read the heading the frame before. Objects follow their routine's own test (below), and a horse's ellipse stops while its block is out of the area, as on the board. "Every block a car reaches" is the old union.
- Objects: every routine now tests what it tests on the board, not the block whose list holds its record (`SHOWN` in `daytona.js`, `shown` in the profiles). There are three kinds of test. Most routines test the block the task stands in, which `get_m_block` (Rev A 0x172A0) works out from the task's own x and z. Some test that block in the area (0x501520): the plain props, the slot reels, the banner, the rank board, the check points, the pylons, the windows, the gulls and the big bird. Others test it in a smaller set, 0x501540, which `set_area_block` builds in the same walk: the first ten cells of its order table (Rev A 0x17594; on Dinosaur Canyon with the camera in block 72 or 88 the next 25 bytes), which is the 3x3 plus one cell two on in z, if they are in the area. The near set is used by the model cycles, the dice (`z_kaitenn`, `rou2`) and the flags. In 1993 it is also used by the two plain prop routines and three of the check points. Some routines test fixed blocks instead: the boat 0x75 or 0x55 in the area, the flags 0x55, 0x65 or 0x75 near, one light 0x7A or 0x6A in the area, another 0x99 or 0x89 near. Some test only where the player is on the road (car +0x12C, +0x128 in 1993): the wall (points 520-576), the Jeffry statue (242-320, and in the ending while the clock is 1016-1211) and the windmill in a race (250-360; in attract mode and the ending, its own block in the area). Rev A has one crowd (points 760-830). The Special Edition adds the plaza's (149-193). In 1993 the plaza's crowd shows while its own block is near and, failing that, the shuttle's by its stretch. The light at Rev A 0x212A4 and the curtain call test nothing. Attract mode is `ADV_DSP` (M_mode 8), not `GAME_DSP`, so the mode picker now has it apart from a race. The hack builds share Rev A's code byte for byte. The Saturn-ads set (`daytonas`) is the Special Edition's code with the tables 0x510 on. Its profile had inherited Rev A's tables, so its objects threw and its sky and car lanes read the wrong row. It now has its own (objects 0x34DD8, sky 0x4838). Its zip spells the program ROMs `.12`/`.13`, not MAME's `.ic12`/`.ic13`, so the game is now also told by those chips' checksums, as the loader already found every other chip (`identifyCrc`, `detectGames`). Checked against MAME (`daytona`, the attract race on each of the three courses held by `sel_course`, 3,202 frames each). A read tap on the model table logged which object models the board drew. The board's own 0x501520, 0x501540 and +0x12C were then put through each draw's test. Against the bitmaps logged one frame earlier (the logger reads them at the end of a frame, and the board draws from the previous ones), every draw of every kind agrees on every frame: pylons, props, cycles, dice, slot, banner, rank board, windows, wall, check points, horses, gulls, big bird, windmill, lights, flags and boat. With the race rule, the windmill's three draws would be wrong on 540 of 9,606 checks. The near set the explorer builds from the area matched 0x501540 on all 9,606 frames. Not exercised: the Jeffry statue and the crowds (the attract race never reaches their stretches), time attack, the ending, and the alternate walk order.
- Horses: the clamps are gone, and the horses run the board's routine with the camera as the car. `uma_dsp` (Rev A 0x22630) turns the horse on its ellipse while its block is in the area; `uma_getaway_chk` (0x2276C) bolts it when the car is within 8. At 0x2286C it takes the car's heading of motion (+0x48) and 1.5 times its ground speed a frame (+0x34). Each frame 0x228B0 checks again (`uma_getaway_chk2`, 0x227DC: within 8 of the car, it takes the car's speed and heading anew), steps along the heading, and drops onto the ground with `get_y_position`. It is drawn at the height it had the frame before. Once out of the area it is gone for 2,560 frames (`nashi`, 0x229E4), then back on its ellipse. The camera's speed and heading are how far and which way it moved since the last frame, so a camera that stops beside the ring holds the horses that reach it, where they reach it, as a stopped car would. `HORSE_CATCH_UP` stays: it is how many frames the explorer steps at once after a pause, and the board has no such thing. A horse's block is its own place's (`get_m_block` in `uma_int`, 0x22608), not the block whose list holds the record; the two differ for most records. The lane points' 28 bytes are x, y, z at +0, +4, +8, a heading (s16, times 4) at +0x12 and the road polygon at +0x1A; the CPU cars take +0x30 from it. The horses read none of it.

## 4. Unported routines replaced by fitted numbers

- **`courseGround`** (`daytona.js:659-719`) picks the face nearest the lane height and rejects slopes with `ny/len < 0.7`. It stands in for the TGP's ground query (op 0x36). A port would delete the heuristic and the 0.7. *Fixed (#261).* `get_y_position` (Rev A 0x11C28) picks a 128x128 cell under x, z and hands TGP op 0x36 that cell's list of collision polygons, which come from the coprocessor's data ROM (now loaded, optionally, as `copro`). The op keeps the polygon whose height is nearest a reference height: the record's own y for a pylon, the horse's y for a horse. `courseGround` now does the same thing in single precision. Against an emulation of the TGP running its own microcode, it picks the same polygon on 1,600 points over the four courses, with heights within a few ulps. The heuristic, the 0.7 and the block decoding it needed are gone. Porting the pylon's tilt showed that the explorer's RZ had the wrong sign (the Z mirror reverses X and Y but not Z), so z_kaitenn, the horse lean and the decor's Z turns turn the other way now.
- **Block rounding disagrees with itself:** `gridBlock` and two other places use `Math.round` (`daytona.js:482, 575, 668`), while `boardBlock` uses `Math.trunc` (`daytona.js:641`). So near a block edge, a car's block depends on which function asks. Check the routine's conversion and use one helper. *Fixed (#256).* `get_m_block` (Rev A 0x172a0) converts with `cvtri`, which rounds by the AC register's mode, and the boot code's `modac` at 0xa6c clears that to round-to-nearest. So `Math.round` was right and `boardBlock`'s `Math.trunc` was wrong. All four places now use one helper, `gridBlock`/`blockOf`, rounding ties to even as the FPU does. In every build only `courseReach` changes: course 0 gains block 188, and that block is empty, so nothing drawn changes.
- **`DAYTONA_HORIZON_ROW = 144`** (`scroll.js:174`) was measured in MAME because `camd_99` is not ported. It has a measured source, so this one is low priority. *Fixed.* `camd_99` is the tail every Rev A camera mode ends in (0x70C0-0x71C0, camera object 0x50DA80). It sets the sky's Y scroll (0x50130A) from the camera alone: A = atan2(eye height, 2048) (TGP op 0x0A), then V = cy + focal · tan(pitch down - A) (ops 0x1B, 0x1C, 0x24-0x29, 0x25), with cy and focal from the view record (0x501730, 0x501734). Breakpoints in MAME on 2,506 attract frames give that formula to within 0.001 px of the TGP's result, once atan is truncated as the TGP truncates it. The same cy and focal set the 3D view: its centre is 320 + cy (table 0x17E68), and the vertical sync register is -2, so the eye line is screen line 192 - cy. The streamer puts panorama row 0 on line 48 - V. So cy cancels, and the eye-line row is 144 - focal · tan A: row 144 as if it stood on the ground 2048 units away. `DAYTONA_HORIZON_ROW` is gone. The panorama now carries row 144 (`VIEW_CENTRE_ROW - 48`) and the distance 2048, and `stepSky` lowers the strip by radius · height / 2048 for the camera's height in the board's frame. In the attract race that is 1-2 px, so the old measurement was right; at 200 units up the painted horizon falls 5.6 degrees below the eye line (32 px at a focal of 326), as on the board. The board scrolls up at the focal of the camera drawing the scene (about 200-600, depending on the camera mode). The explorer's camera is that camera, so the strip now takes its focal: its field of view on the board's 384-line picture, 333 at the explorer's 60 degrees (§6). The H scroll (0x501308) is not part of `camd_99`. The sky streamer (0x1DFB8) writes it as `heading >> 5 & 0x1FF` from 0x5FE11A, which `buildCourseSky` already follows.

## 5. A wrong table hidden by a skip

These skips each hide one known decode bug. Fixing the bug removes the skip, and probably fixes other places that use the same data:

- **Fighting Vipers' sky skipped colorxlat.** *Fixed (#250).* The column was wrong because FV was given STF's test-menu defaults (add 22, multiply 54). A MAME boot on empty NVRAM leaves 0x40/0x25 at 0x500234..0x500239. With those, the ROM-built colorxlat equals MAME's dump byte for byte, and the night-city sky is (0,0,46) as MAME draws it. The skip is gone. STF's table was checked the same way and already matched.
- **HOTD's light used `unverifiedLight`.** *Fixed (#250).* MAME's display lists (`m2 geodasm`), taken back through an unrotated stage piece's matrix, give (0.707, -0.707, 0) for both the prototype and revision A. That is `stageLight` unflipped, so the flip is gone.
- **`HEAD_FACE = 0xc000`** (`pose.js:146`, applied for fighters that borrow Bean's animation table, `characters.js:275-292`). It is a constant quarter turn because the head "reads as facing right". The borrowed table's own rest angle is probably the missing data. *Fixed (#262).* There is no rest angle: the head block (`0x30FE8`, `g1 == 2`) has no case for a borrowed table and aims every head, with its pitch clamped to ±`0x2000` (`0x312A8`) and a target on the head's -Y side flattened onto its X axis (`0x311A4`). Bean's face target lands below the four taller heads, so the board holds them at the clamp. `HEAD_FACE` and the `headAim` switch are gone, and `aimHead` has both limits. Against MAME, with the attract replay's fighter 0 pinned to the boss and then the minion on their own rigs, the head's stored angles now match on all 527 motion-target frames (pitch exact, yaw within 2). Before, pitch was `0x2000` out on every one of them. TECHNICAL.md, "The head's aim", has the run and the table.
- **`motionKin` / `rankMotions`** (`bodies.js:220-322`) guess which motions a lone enemy body uses, from name prefixes and a fitted median test, with a second pass to drop the wrong families. Reading each enemy routine's motion numbers would replace about 100 lines. *Fixed (#263).* `tools/hotd-motions/body_motions.py` reads them: for every routine a spawn record, a constant body store or a constant `sub_2DFD0` body sets up, every motion number reaching a setter in the code the routine runs, plus the body-indexed tables (0x22F70 start motion, 0x94940 states, 0x94C00 attacks, 0x94D10 hits, 0x59FA0 death). The monkeys and class 32's zombies take their body from the record at obj+0x344, not the spawn byte. `rig.bodyMotions` holds the result; `bodyMotionList` keeps the body's joint count. Before, 29 bodies found motions by name and the rest a fitted guess; now 67 of the 68 lead with motions the program plays. BO_zonbi_b_2 is the exception: its only motions are 18-joint zombie ones, and it has 21 joints. The finished game's code was rewritten too far to read the same way, so its table is the prototype's carried over by body and motion name: 58 of its 94 bodies have a row, and 72 have a lead; the 36 bodies new to it lead with their hit reactions. Reading its own routines is still open.

## 6. Small ones

| What | Where | Note |
|---|---|---|
| `platformScale = slot === 7 ? … : [fs, 1.6, fs]` | `display.js:1816` | *Checked (#256):* the board's own rule. `stage_dsp` tests the slot against 7 (Giant Wing) at 0x26530 and scales (fs, fs, fs) there. Now cited, and named `GIANT_WING_SLOT` |
| `CASINO_LEVER` offset `[20, 7, -48]`, `DYNAMITE_SWING_AT`, `GIANT_WING_BLADE_AT`, `GIANT_WING_CLOUDS` | `display.js:671, 848, 934, 941-948` | *Checked (#256):* all ROM immediates, and all agree with the code: the lever at 0x7442c (scale, then translate 20, 7, 48), the swing at 0x75bf4/0x75d18, the blade at 0x771f8, the clouds at 0x76b04-0x76b6c, 0x76c30, 0x76ca4 and 0x77110. Addresses now cited in `display.js` |
| `SKY_RADIUS = 600` and the height estimate beside it | `app.js:1146` | *Checked (#264):* the radius changes nothing on screen: the cylinder rides the camera with the depth test off, so it only has to sit inside the clip range (now said so). Fighting Vipers' sky routine (0x29A40-0x29B40) is now derived. One turn is 16 patterns, not 18: patterns 16-17 repeat 0-1 and the board never reads them, so the old strip had a 64-tile seam. The eye line is row 192 + list[2], and the vertical scale is the fight focal of 480 px (`scroll.js`). Daytona's Y scroll (`camd_99`, §4) is now ported for the eye line, which follows the camera's height, and for the scale, the focal of the camera drawing the scene, which here is the explorer's own (333 at its 60 degrees). *Then (Pinboard #448):* the heading phase. The routine scrolls by the camera's Yang plus 16 times list[0] (0x503040), and MAME's frames show screen column x as strip column x - heading/16, unmirrored. list[0] turns each stage's sky by up to half a turn (slot 2: 181 degrees). The explorer's cylinder had neither: seen from inside, its texture ran right to left, so both games' skies were mirrored, and it was not turned. It is now mirrored back and turned so the column the board centres at Yang 0 (248 - list[0]) lies down the board's +Z. Daytona's heading (0x5FE11A) is the same Yang, with no phase: 248 - heading/32. Rendering the explorer's sky alone from MAME's camera, its centre column matched the board's within 2 px on four FV frames (slots 1 and 2) and four Daytona attract frames. Before the fix, every one of those frames was mirrored. The pitch clamp (list+0x4C/0x4E, ±45 degrees, 43 up on four stages) keeps the flat layer from wrapping its 512-row tilemap. The cylinder has nothing to wrap, so it is left out on purpose (`scroll.js` says so) |
| `SHARED_TEX_SET = 1` and the one-game `texPair: 'literal'` switch | `stages.js:262-273` | *Checked (#264):* derived. g0 (record+0x0C) is the stage's texture set and g1 (+0x0E) is `send_tex_col_stage`'s colour block (`send_tex_stage_delay`, STF 0x4A9FC / FV 0x4AD24). Each game's boot set stays resident: STF `send_tex_rob(1, 0, 0)` at 0x4A994, FV set 36 at 0x4ACBC. Now `texture.bootSet` + `resolveTexSets`, and `texPair` is gone. A tile-coverage check on all 16 stages per game agrees |
| `bestTextureSet` / `bankTextureSet` | `texture.js` (`programTextureSets`, `bestTextureCombo`), `app.js` (`modelTextureGuess`) | *Checked (#264, then this branch):* derived where the program says, a narrow guess where it does not. **FV:** a fighter's 16 parts come from the character record at `0x640D2B0[char]` (+0 parts, +0x20 set). Player set-up 0x1243C hands the set to 0x4B0FC, and handler 0x4B1C0 loads set N and N+1 into the player's slot. A model whose tiles all lie on boot set 36 (0x4ACBC) takes that set. Of 3462 lone models, 180 are fighter parts, 1591 are on the boot set and 51 are untextured. The other 1589 stay a guess, now limited to sets the board can load together: 1370 lie on the fighters' pages (every fighter's pair lands on the same pages, so nothing says whose), 216 on the stages' pages, and 3 on single-set coverage. **Daytona:** boot loads its bank onto sheet 1 (0x11B8, 0x1454). sel_course picks sheet 0's bank (0x1438, `ld 0x15A0[course*4]`). Of 1390 lone models, 159 are untextured and 913 are on sheet 1 alone, the same on every course. 254 are named by one course's records: a window's other 63 frames and a check point's last-lap list. 64 stay on the opening set as a labelled guess. **HOTD:** the bank rule is the derivation (the stage data and palettes, `games.js`), and it is no longer called a guess. Spawn records agree for 17 bodies spawned under one set. 10 bodies disagree, where the class does not read +0x24 as the body |
| `DAYTONA_PATCHES` | `games.js:~1431-1470` | m2emulator's ROM fixes, already an opt-in switch (off by default); band-aids by definition, but labelled as such |

## 7. Face layers again: seven rules from one stage (#712)

§2's fix left the layers with one rule: the board's key from this camera, the later face on a tie. Between 2026-10-11 and 2026-10-12 the Virtua Cop issues added seven more. Each is a threshold or a special case fitted to one view of stage 3, and each runs for every game with `depth.layers` on (STF, `hotdp`, `hotdo`, `hotd`, every Daytona build, `vcop`, `vf2`; Fighting Vipers alone has it off, `games.js:532`). None of them was graded on another game, against MAME, or over the 16-stage harness §1 used. Line numbers are as of `213fb82`.

| # | Rule | Where | Fitted on | Applies to |
|---|---|---|---|---|
| 1 | `ASKEW` = tan 80°: faces apart are paired as far as they overlap seen within 80° of square on | `layers.js:116`, `pairsOf` (its `consider`) `411-416` | issue 69, two office wall pieces half a unit apart | every layered game |
| 2 | `APART` = 0.25: a face that far in front across the whole overlap goes on top from every camera, whatever the key | `layers.js:319`, `inFront` `347-351` | issue 71, a bookcase 0.4 in front of a wall | every layered game |
| 3 | `SMALL_APART` = 0.05: the same for a face that is smaller than the other | `layers.js:329`, `inFront` | issue 73, books 0.11 in front of a wall | every layered game |
| 4 | a one-sided face `APART` or more behind its group's plane keeps its own depth | `setPlanes`, `layers.js:452-461` | issue 78, a hall ceiling over a lower one | every layered game |
| 5 | the slope a layer lifts a face with no plane is capped at that of a face seen about 70° off square on (3 px) | `viewer.js:565-573` | issue 80, a computer case top through a monitor | every layered game |
| 6 | `laterZone`: faces of draws with no zone in common go the later zone's way; and a circle of pairs is broken by letting go a face that waits only on the sort's pairs | `layers.js:363-367`, `layersFrom`/`letGo` `644-701` | issue 82, the road under the lobby carpet | draws that carry `zones`: Virtua Cop's segments **and HOTD's zones** (`placements.js:579-680`) |
| 7 | `smallerOnTop`, `SMALLER` = 0.9: of two far-corner faces from draws with different zone sets, less than 0.05 apart, the smaller goes on top | `layers.js:383-395` | issue 83, courtyard gravel on the road | as 6, and in a single HOTD zone too, wherever two draws' zone sets differ |

Two kinds are mixed here.

**Rules 1, 4 and 5 pay for the explorer's own depth trick, not for the board.** A face in a group is drawn at the depth of its group's largest face's plane (`viewer.js:540-583`), which can be as much as the gap (0.5) from where the face is. At a slant that error grows by the tangent of the angle, and each of the three rules limits one way it shows: pairing further (1), dropping the plane for faces well behind it (4), capping the slope (5). The plane is there because a 24-bit depth buffer can't keep a pane 0.0025 behind its wall at a distance (`rankLayers`' note, `layers.js:589-592`). The explorer already writes `gl_FragDepth`, so it could write a reversed or logarithmic depth into a 32-bit float depth buffer instead. Then the step at 300 units out is about 300 × 2⁻²⁴ ≈ 2e-5, far under 0.0025, and a face could keep its own depth plus a few ulps per layer. That would remove the group plane, and with it rules 1, 4 and 5 and the "a 24-bit step is a quarter of a unit" argument in `rankLayers`. Risk: issue 38 (Daytona's flag copies) was about two triangles interpolating a hair apart, not about precision, so the copy rule (`twins`) has to be checked under it, and the render targets (`viewer.js:1419-1425`) need a depth texture of that format in WebGL2.

**Rules 2, 3, 6 and 7 replace the board's answer with the depth buffer's, for cameras the game never uses.** The board keys a whole polygon by one corner, so near a big face's edge it can lose to the face behind it. That is the board's picture, but from where the game's camera never stands. The comment at `layers.js:305-317` says this plainly. Two questions for each:

- *Does it change what a game's own camera sees?* STF and HOTD lean on decals a few hundredths in front of their walls, keyed by the far corner. Rule 3 now puts every such decal that is smaller and 0.05 or more in front on top from every camera, where the board would sometimes put the wall on top. Rule 7 changes HOTD's ordering inside one zone wherever a draw is listed in more zones than its neighbour. This has not been measured. The harness exists: the 16 STF stages × 8 cameras, the issue 44/46/58 views, `grade-zsort` at the board's cameras (memory: explorer vs MAME pictures), and Daytona's attract frames. A run of each with the seven rules on and off says which of them move board-camera pixels.
- *Is there one rule under the four?* §1 already has the explorer's answer for "a camera the board never uses": `Viewer.drawScene`'s `uKeyReach`, where a keyed face only counts within reach of the nearest surface, and true depth decides the rest. Rules 2 and 3 are the same idea per pair with two distances (0.25, 0.05) instead of one. A single "apart by more than the reach, true depth wins" in the ranking, the same number the key pass uses, is the candidate to try first. Rules 6 and 7 are about the union view ("every segment at once"), which §3 left as a plain union with no filtering for HOTD. In a single-segment view the draws are the board's own list, so the sort is the picture there and neither rule should be needed. Gating both on the union view, and checking whether issue 83 was seen in a single segment, would show whether 7 is needed at all.

Until it is measured, these are the explorer's newest bubblegum and the one item here that crosses games.

### Rules 6 and 7 in a single segment (Pinboard #742)

Rules 6 and 7 were gated on the union view (`zones` passed to the layers only when `stageView(stage) === stage.union`). Every single-segment and single-zone view was rendered from its own framing camera at 640×400 under SwiftShader, against master.

- **Rule 6 does nothing in a single segment, by construction.** Every draw there shares the segment, so `laterZone` never fires. It is already union-only and needs no gate.
- **Rule 7 is needed in a single segment.** In Virtua Cop's single-segment views it orders 3-45 pairs per segment differently. Pixels moved in stage 3 segment 7 (462 px), segments 1 and 2 (64 and 63 px), stage 1 segment 4 (15 px) and segment 1 (3 px), and stage 2 segment 7 (4 px). The 462 px are issue 83 itself: with the gate, the road's grey quads come back through the courtyard's brick in segment 7's own view. So rule 7 is a free-camera rule like 2 and 3, not a union one. Issues 82 and 83 were both filed in the default `all` view, which is why that wasn't seen.
- **In House of the Dead, rule 7 moves no pixels from each zone's framing camera.** In stage 1, zones 0-11, it reorders 4 pairs in zones 5-9 (77 to 73, 75 to 71). The finished game's other stages and the prototype were not run.

The gate was not kept.

### Rule 1 measured (Pinboard #714)

Rule 1 alone, one game at a time, from that game's own camera as MAME logged it, rendered with `ASKEW` on and with it off (reach 0), at 496×384 under SwiftShader. Each "on" frame was rendered twice to get the noise floor, with the stage clock held on the board's frame. Nothing else was changed. A change in the picture counts as a regression.

| Game | Camera | Frames | Changed | What changes | Verdict |
|---|---|---|---|---|---|
| STF, 16 stages | camera record 0x519E98, Sonic vs Bean replay, frames 400-1300 | 31 per stage | South Island 1 (13 px), Canyon Cruise 18 (≤62 px), Casino Night 29 (≤14 px), Stage 10 31 (≤39 px), 1-2 frames of ≤13 px on Dynamite Plant, 13, 14, 15; none on Aurora, Mushroom Hill, 9, 11, 12 | 1-px seams: a rope's edge, a banner's top edge, single pixels along a grid line | no visible change. Flying Carpet and Giant Wing change only within the noise. Stage 8 hangs the headless page when it loads, so it is not measured |
| Daytona Rev A | view matrix 0x501560, attract race holding sel_course, frames 520-3580 | 52 per course | Three-Seven 46 (up to 7441 px), Seaside 43 (≤127 px), Dinosaur Canyon 50 (≤330 px) | **the tire marks and worn-lane patches on the road.** With the rule on, the road's own faces are put over them in block-shaped pieces (frames 880, 1480, 3100) | **regression**: the marks are the board's (memory: tire marks are ranked over the road), and off keeps them whole |
| Virtua Fighter 2 | camera record 0x515400 (STF's layout, yaw the other way), stage byte 0x500064 | 31 in the Colosseum fight (4800-6000), 31 in the demo stage (1800-3000) | Colosseum 21 (up to 5640 px); demo 5 (≤3 px) | **the tan border round the Colosseum ring.** With the rule on, the outer floor covers half its length from a low camera | **regression**: MAME's frame 6000 shows the border the whole way across, as rule off does |
| House of the Dead (`hotdo`, `hotdp`) | not found: the rail camera is computed on the copro (memory: hotdp stage data) | | | | not measured |
| Virtua Cop | not found: the matrices at 0x50F63C on are the enemies', not the view | | | | not measured from the game's camera; the issue 69 view, from the explorer's camera, is below |

So rule 1 moves visible pixels from the game's own camera in two games it was not fitted on, both for the reason §7 gives: a decal or border that lies a little apart from a big face gets paired with it at a slant and loses to the group's plane. The rule stays in until the float depth buffer (item 9) can take it, and that change should be graded on these same frames: Daytona 880/1480/3100 on Three-Seven, VF2's Colosseum 5600-6000.

### Rule 1 at the issue 69 view (Pinboard #723)

The view is the one in the issue's link: Virtua Cop stage 3 (stage value 2), frame 2425, noclip camera at (-16.247, 7.46, 95.474), yaw 11.7412, pitch 0.017, fov 60. That is **the explorer's camera, not the game's**: the game's camera is still not found in RAM. It was rendered at 1120×640 under SwiftShader, with the same `ASKEW`-off switch (reach 0) and the clock held. 19527 px change, and two "on" renders do not differ at all.

- **Rule off: the issue's fight comes back in part.** The blinds wall is drawn over the left end of the bookcase (a strip about 40 px wide and 200 px high), and the bookcase's frame shows through the blinds beside it. The shelf boards also shift along their edges.
- **Rule on:** the bookcase is whole, apart from a dotted 1 px seam along the top of its middle shelf.
- The rest of the issue's screenshot does not come back with rule 1 off on this build: there, the wall also hides the bookcase from the right.

So at the view it was tuned for, rule 1 still removes a visible fight. Rule 1 is not one of the two rules that also change House of the Dead zone views (6 and 7 in the table above), so no HOTD zone view was rendered for it.

### All seven rules off at the issue 69 view (Pinboard #726)

The same view, camera, size and SwiftShader, rendered once with all seven rules off at once (in a scratch copy of the page; no rule was changed in the source). Against the rule-1-off picture above it differs by **225667 px** (of 716800). A fresh rule-1-off render matched the recorded one exactly, and two all-off renders were identical, so none of that is noise.

- **The right-side hiding comes back.** With every rule off the wall is drawn over the bookcase from the right as in the issue's screenshot: only a window two shelves high and about 130 px wide, at the bookcase's left end, is left, and the bookcase at the far left of the room is covered too. So the rest of issue 69's fight is undone by rules 2-7 together, not by rule 1. Which of them does it was not measured.

### Rules 2-7 one at a time at the issue 69 view (Pinboard #728)

The same view, camera, size and SwiftShader, with rule 1 off throughout and exactly one of rules 2-7 also off per render (six renders, in a scratch copy of the page; no rule was changed in the source). Rules 2 and 3 were turned off separately inside `inFront`; rule 6 is `laterZone` and `letGo` together. The two pictures compared against are the stored rule-1-off and all-off renders above. Each render was taken twice and the two never differed.

| Off (besides rule 1) | vs rule-1-off | vs all-off | Right-side bookcase hiding |
|---|---|---|---|
| 2 `APART` | 0 px | 225667 px | no |
| 3 `SMALL_APART` | 6692 px | 219136 px | no |
| 4 one-sided face behind its plane | 0 px | 225667 px | no |
| 5 slope cap | 2 px | 225667 px | no |
| 6 `laterZone` / `letGo` | 0 px | 225667 px | no |
| 7 `smallerOnTop` | 0 px | 225667 px | no |

Rule 3's 6692 px are all at the far left (x 0-72): the small bookcase there loses its two rows of books to the wall behind it. The big bookcase stays whole. No single rule among 2-7 brings back the issue's right-side hiding or accounts for most of the 225667 px, so it takes two or more of them at once. Pairs were not tried.

### Rules 2-7 two at a time at the issue 69 view (Pinboard #730)

The same view, camera, size and SwiftShader, with rule 1 off throughout and exactly one pair of rules 2-7 also off per render (all 15 pairs, in the same scratch copy of the page; no rule was changed in the source). Rules 2 and 3 were turned off separately inside `inFront`; rule 6 is `laterZone` and `letGo` together. The pictures compared against are the stored rule-1-off and all-off renders above. Every pair with a count under 100 px (including 2+3's 0 px against all-off) was rendered a second time; each second render matched its first exactly.

| Off (besides rule 1) | vs rule-1-off | vs all-off | Right-side bookcase hiding |
|---|---|---|---|
| 2 + 3 | 225667 px | 0 px | **yes** |
| 2 + 4 | 0 px | 225667 px | no |
| 2 + 5 | 0 px | 225667 px | no |
| 2 + 6 | 0 px | 225667 px | no |
| 2 + 7 | 0 px | 225667 px | no |
| 3 + 4 | 6692 px | 219136 px | no |
| 3 + 5 | 6694 px | 219136 px | no |
| 3 + 6 | 6692 px | 219136 px | no |
| 3 + 7 | 6692 px | 219136 px | no |
| 4 + 5 | 2 px | 225667 px | no |
| 4 + 6 | 0 px | 225667 px | no |
| 4 + 7 | 0 px | 225667 px | no |
| 5 + 6 | 2 px | 225667 px | no |
| 5 + 7 | 2 px | 225667 px | no |
| 6 + 7 | 0 px | 225667 px | no |

Only rules 2 and 3 together (`APART` and `SMALL_APART`, both in `inFront`) bring back the issue's right-side hiding. That pair covers all 225667 px: its picture is identical to the all-off one, with the wall hiding the big bookcase from the right except the window at its left end, as in the issue screenshot. Every pair with rule 3 but not rule 2 shows only rule 3's far-left change; 3 + 5 adds rule 5's 2 px. The other pairs give 0 or 2 px. Triples were not tried.

### Rules 2 and 3 off with rule 1 on at the issue 69 view (Pinboard #735)

The same view, camera, size and SwiftShader, rendered once with rule 1 **on**, rules 2 and 3 off, and rules 4-7 on (in the same scratch copy of the page; no rule was changed in the source). It was compared with the stored pictures above. No count was under 100 px, so it was not rendered again.

| Compared with | Differs by |
|---|---|
| rule-1-off picture | 240567 px |
| all-off picture | 16396 px |
| rule 1 off + rules 2 and 3 off picture | 16396 px |

- **The right-side hiding appears: rules 2 and 3 off are enough for it with rule 1 on.** The wall covers the big bookcase from the right, and only a window at its left end, two shelves high, is left.
- **What rule 1 still changes:** the 16396 px between this picture and the 2 + 3 picture with rule 1 off are rule 1's own. With rule 1 on, the left end of the window is whole: the bookcase frame shows there, about 50 px wide and 190 px high, so the window is about 180 px wide where the rule-1-off picture's is about 130 px. In the rule-1-off picture that strip is the blinds wall, with bits of the frame showing through. With rule 1 on, the wall is also more solid. The brown trim along its top shows through only from about x 905, where the rule-1-off picture shows it from about x 725. The brown strip along the wall's foot does not show through at all. A few desk and shelf edges and a small patch by the vent (about x 330-350) differ too.

### Rule 2 alone and rule 3 alone off with rule 1 on at the issue 69 view (Pinboard #736)

The same view, camera, size and SwiftShader, rendered twice with rule 1 **on** and rules 4-7 on: once with only rule 2 off, once with only rule 3 off (in the same scratch copy of the page; no rule was changed in the source). Each was compared with the stored pictures above. No count was under 100 px, so neither was rendered again.

| Off (rule 1 on) | vs rule-1-off | vs all-off | vs rule 1 on + rules 2 and 3 off | Picture |
|---|---|---|---|---|
| 2 | 19539 px | 240376 px | 225822 px | no hiding |
| 3 | 22908 px | 237213 px | 222495 px | far-left only |

- **Rule 2 off:** the picture is the rule-1-on one. It differs from the stored rule-1-on render of #723 by 17 px, scattered between x 375 and 585, and the big bookcase is whole.
- **Rule 3 off:** the small bookcase at the far left loses its books to the wall behind it, as with rule 3 off and rule 1 off. Against the rule-1-on render, 3348 px differ at x 0-86 and 93 px elsewhere; the big bookcase is whole.
- **With rule 1 on, the pair is still required.** Neither rule 2 alone nor rule 3 alone gives either kind of right-side cover: not the issue's about-130 px window, and not the coarse cover with the about-180 px window that rules 2 and 3 off together give.

### Rules 2-7 off with rule 1 on at the issue 69 view (Pinboard #740)

The same view, camera, size and SwiftShader, rendered once with rule 1 **on** and rules 2, 3, 4, 5, 6 and 7 all off (in the same scratch copy of the page; no rule was changed in the source), and compared with the stored pictures above. The count against the rule-1-on plus rules-2-and-3-off picture was under 100 px, so the picture was rendered a second time; the second render was byte-for-byte the same as the first.

| Off (rule 1 on) | vs rule-1-off | vs all-off | vs rule 1 on + rules 2 and 3 off | Picture |
|---|---|---|---|---|
| 2-7 | 240572 px | 16436 px | 51 px | coarse cover only |

- **The picture is the rule-1-on plus rules-2-and-3-off one.** The wall covers the big bookcase from the right, but the left window is about 180 px wide with the bookcase frame showing, not the issue's about-130 px window. The 51 px are thin slivers: a 32 px run of one row at x 935-966 (y 334), 7 px at x 356-362 (y 339), and 12 px on a desk edge around x 540-557 (y 438-441).
- **Rules 4-7 barely change this view once rule 1 is on and rules 2 and 3 are off.** Turning them off too moves the gap to the all-off picture from 16396 px to 16436 px; it does not close it. With rules 2 and 3 off, the gap between the coarse cover and the issue match comes from rule 1 alone. Rules 4-7 were not turned off one at a time.

## 8. The new games (#712)

**Virtua Cop** (`vcop.js`, `vcopsky.js`) reads its segments, objects, clouds and sky from the program, with routines cited. What is not read from a routine:

| What | Where | Note |
|---|---|---|
| `INTACT` | `vcop.js:139` | how many parts of a breakable object stand whole, per type. *Read (#94):* types 0, 1 and 3 get mask 3 from the segment loader's switch (0x31600, stores at 0x31768, 0x317A8, 0x317EC), and 0x26 and 0x27 from their routines' masks. A write tap on every slot's mask over 20000 attract frames found no other type spawned with part of its mask clear |
| `IN_WORLD`, `SCRIPTS`, `GLINTS` | `vcop.js:133-149` | per-type sets, each with its reason cited; `IN_WORLD` includes 0x24, "a pair no list places", from MAME draws. Small, and each line names the routine |
| `REST_Y` | `vcop.js:153` | one crate's resting height, from the routine at 0x37500. Cited |
| `BOARD_FOCAL` | `vcopsky.js` | *Read (#94):* 0x1CE30 sends the GEO's focal each frame as 248 / tan(fov / 2), from the field of view at 0x50F3F4. That rests at 30° (0x1CD0C; 0x10700 sets 925.5 outright), so the focal is 925.5, not the 1180 measured before: that frame was mid-zoom (23.6°), as the attract demo narrows to 6.4° onto a target. The sky's scroll doesn't follow the zoom. Not yet graded against a MAME frame |
| `CLOUDLESS_STAGE`/`FROM` | `vcop.js:244-245` | the high-rise drops the clouds from its third segment; the routine that drops them isn't cited |
| `paletteFixes` | `games.js:2615` | the boot's own palette writes (commit `1ed1c25`), not a patch |

**Virtua Fighter 2** (`vf2.js`, `vf2fx.js`, `vf2fighters.js`) is cited almost line by line. The approximations are labelled as such. The fight-driven effects (Souseiji's corner falls, the burst, the bubbles, the stone that flies) are switches named "stand-in", because what sets them off is fight state the explorer doesn't run. The Colosseum's lightning uses a seeded generator, because the board's random number adds hardware counters (`vf2.js:268-273`). The head always looks at the opponent, and the chest twist is left out, both said in `vf2fighters.js:74-77`. The Great Wall's banners turned `layers` on for VF2 (issue 87, `games.js:2793-2796`), so VF2 now runs every rule in §7.

**The Cells tab** (`cells.js`) picks a cell's CG by the game's own lists where it names one. Where it doesn't, it falls back to tile coverage and then `seamScore`, a picture heuristic (`cells.js:309-364`). That is labelled in the code and only orders a picker.

## Checked and clean

These look like magic numbers but cite the routine or a MAME measurement, and should stay: `SOUTH_ISLAND_CAGE_CORNERS`, `EGGMAN_DOORS`, `MUSHROOM_RINGS`, `FRAME_TABLES`, `CANYON_SLOPE_DIV` (display.js); the `colors.js` constants from sub_74C; `AREA_REACH`, `SLOT_REELS`, `BIRD_RADIUS` (daytona.js); `TAILS_LAB_VECTER_Y`; `partDraws` (a port of sub_764C0); `RAW_MIP_RECTS`; `osage.js`'s gravity and damping; `exhaust.js`'s chest slots; `zanzou.js`'s spacing (checked against 901 MAME captures). The placement opcode sets in `placements.js:50-61` are the stage-script VM's operand lengths.

## Suggested order

1. ~~**"Deep far-corner faces concede" as one rule (§1).**~~ Measured and rejected; see "no single per-face rule holds" in §1. The next try is a key-aware pass, not a rule on depth alone. Done in #258: the key pass plus the board's windows replace every flag.
2. ~~**Submission index instead of `planeBias` (§1).**~~ Already the cited draw order; stays.
3. ~~**The FV luma column and the HOTD light (§5).**~~ Done (#250), both checked against MAME.
4. ~~**Live key ranking in face layers (§2).**~~ Done (Pinboard #259), graded on STF and Daytona.
5. ~~**A current-zone/block state (§3) and the TGP ground query (§4).**~~ Done (#260, #261).

Next (#712), in this order:

6. **Measure §7's seven rules** (rule 1 done, #714: a regression on Daytona and VF2) with each one on and off, on STF's 16 stages × 8 cameras, the issue 44/46/58 views, `grade-zsort` at the board's cameras, HOTD's zones and Daytona's attract frames, as well as Virtua Cop's issue views. A rule that moves board-camera pixels in another game is a regression there, whatever it fixed on stage 3.
7. ~~**Gate rules 6 and 7 on the union view** (§7), if the measurement shows they do nothing in a single segment or zone.~~ Measured and rejected (Pinboard #742; see "Rules 6 and 7 in a single segment" in §7). Rule 6 is already union-only, and rule 7 is needed in a single segment.
8. **One "apart beyond the reach, true depth wins" rule** in place of `APART` and `SMALL_APART`, with the key pass's `uKeyReach`. As written, this can't work. `uKeyReach` is 1, twice the 0.5 gap inside which faces are paired at all, so no pair would ever be "beyond the reach". Rules 2 and 3 split at 0.25 and 0.05 because issues 69 and 73 sit at those distances, and rule 7 (issue 83) is a third case of the same kind. A single number would have to be measured anew, not borrowed from the key pass.
9. **A float depth buffer in place of the group plane**, which would take rules 1, 4 and 5 with it. This is the largest change, and the one with the widest reach.
10. ~~Virtua Cop's focal from its view record, and its `INTACT` masks from the routines (§8).~~ Done (#94): the focal from the lens routine at 0x1CE30, and the masks from the segment loader.

Still open from the first audit, none of them blocking: the finished HOTD's prop lifetimes (§3, the prototype's are read), the finished HOTD's own enemy routines (§5), and the lone models no routine names (§6: Fighting Vipers' extra fighter and stage parts, 64 Daytona frames).

Merging master (Pinboard #440): master's issue 58 fix for Tails' lab's posters (`keepFar`'s layer -1 floor and `leaveApart`'s reordering, `dadf307`, `2f800f0`) was written for the static vote that §2 removed, so it went with it. With the live ranking the issue 58 view renders clean on the RTX 3070 and under SwiftShader. It was not clean, though: two palm trees stood on the world-map poster that master does not show (Pinboard #441). They are model 3798, drawn by `adv_movie_snc_disp` outside the lab, 150 units behind the room's back wall. The board never draws them inside: `adv_movie_snc_disp2` draws the room without them, and MAME's attract run shows the poster bare from the board's own camera. The cause was the key pass itself. `drawScene` left the key texture bound after pass 3, so from the second frame on pass 1 drew into the texture its own program samples, and WebGL dropped every one of those draws as a feedback loop. The key texture held only its clear, no face was held to `uKeyReach`, and window 4 (the palms, the hangar) was drawn over window 3 (the room) wherever it lay behind it. Separately, the clear was zeros rather than "no surface" (view z -1e9), because three.js premultiplies the clear colour by its alpha of 0; that only matters to the mirrored-draw test, and changes 13 pixels on an Aurora view of the ice. Both are fixed: the placeholder goes back after pass 3, and the clear's alpha is 1. The picture is now what a single `drawScene` on a fresh page gave all along (identical on issue 46, within run-to-run noise on the stage views), which is what a grader rendering one frame per page saw. Pixels changed against the branch, with a second render of the branch as the noise floor: issue 58 1.1k (the palms), issue 46 238k (noise 0: the outside's hangar door, roof edge and dish no longer cover the room), issue 44 91k (noise 11k, the dish and the roof edge gone). On the 16 stages' default orbit views, cameras the board never uses: Final Eggman Boss 11k (noise 2k), Aurora 9k (noise 0.2k), Stage 8 3k (0.7k), under 2k each elsewhere. The RTX 3070 and SwiftShader agree.
