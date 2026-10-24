# Technical notes

How the explorer reads a Sega Model 2 ROM set and turns it into what you see.
Most of what follows is *Sonic The Fighters*, the game it goes deepest on; the
parts that are not its alone say so. For running and deploying the viewer, see
[README.md](README.md).

## Layout

```
index.html  style.css
js/
  zip.js         zip central-directory reader + inflate
  games.js       per-game ROM recipes and table addresses
  romset.js      MAME region assembly, model table, address translation
  model.js       index-array polygon decoder
  stages.js      stage_data reader
  display.js     per-stage draw list: what gets scaled, rotated, offset
                 and animated
  texture.js     ROM -> texture RAM: the game's own unpack routines, ported
  colors.js      ROM -> luma RAM + colorxlat: the colour tables, likewise
  atlas.js       texture-RAM sheets -> shader atlas
  characters.js  CHAR_PARTS roster, part tables, skeleton tables
  motion.js      the motion keyframe format: block walk and curve sampling
  pose.js        the pose a motion solves into: body matrix, aims, two-bone IK
  osage.js       the sway chains: pigtails, tails, feathers
  tails.js       Tails' two tails: the baked cycle drawn off the pelvis
  exhaust.js     Metal Sonic's jet: the eight-frame plume drawn off the chest
  eggrobo.js     the Egg robots' two frame-counter animations: the boss's
                 arms and the minion's head
  doa.js         Dead or Alive: runs each stage's own routine, keeps its draws
  i960.js        the i960 interpreter doa.js runs them on
  viewer.js      three.js scene, shader, orbit + noclip cameras
  app.js         UI wiring
  sound/
    sound.js     the music switch: reads the sound ROMs, boots the board
    worklet.js   runs the board on the audio thread
    board.wasm   m2-hle2's Model 2 sound board, built by tools/sound/build.sh
    model1.wasm  the Model 1 sound board (Daytona), built by the same
tools/sound/
  board.c        the wasm's surface over m2-hle2's src/board/sound.h
  model1.c       the Model 1 board: m2-hle2's 68000, the memory map, the UART
  model1_chips.cpp  MAME's MultiPCM and ymfm's YM3438 for it
  build.sh       emcc build of both
```

The tools this document keeps citing are not in the tree. They live in
[stf-tools](https://github.com/biggestsonicfan/stf-tools) — the dev server, the
headless screenshots, the ROM inspection, `i960dis.mjs` (read the program ROM's
own routines), `mame-dump-texram.lua` (texture RAM capture) and every
`test-*.mjs` named below. That repository carries this one as a submodule and
decodes the ROM through the `js/` modules above, so a check there measures this
code rather than a copy of it. A `stf-tools/x` path below is a file at the root
of that repository.

Nothing is vendored and there is no build step for the page, with one
exception: the two `js/sound/*.wasm`, which are compiled C and committed as built
— see [Music](#music-jssound). `index.html`'s import map pins
three.js to cdnjs and its one addon, OrbitControls, to jsDelivr, and gives a
SHA-512 for each of the three files in an `integrity` map — so the page gets
those exact builds or none. That is not decorative: corrupting one hash and
reloading gets *"Failed to find a valid digest in the 'integrity' attribute …
The resource has been blocked"* and a page that does not boot, which is the
behaviour worth having. The library was byte-identical to the copy that used to
be vendored, so moving it changed nothing but what this repository holds; the
addons are on jsDelivr because cdnjs publishes only the four core builds and the
WebGPU ones. The cost is that the page now wants a network on first load, where
before it was self-contained — pointing those two entries back at local copies
is the way out.

## How it works

### ROM assembly (`js/zip.js`, `js/romset.js`, `js/games.js`)

The zip members are inflated in the browser via `DecompressionStream` and
interleaved into MAME's region layout (`ROM_LOAD32_WORD`: two 16-bit halves into
32-bit words). Four regions are assembled — the program ROM, the main data ROM
(model table, face palette, motion tables), the polygon ROM and the texture ROM.

Which chips make up each region, and where the tables sit once it is built, is
per-game and lives in `js/games.js`. `loadRomSet` identifies the set from its
member names rather than being told, and hangs the profile it chose on the ROM
set as `rom.game`, so the decoders read their numbers off the set they were
handed. Nothing downstream carries a game's address as a module constant.

### Working out a second game's layout

Adding *Fighting Vipers* meant deriving a layout for a set whose MAME recipe was
not to hand, and the method is worth recording because it needs no recipe.

The program ROM settles the tables. Both games are built on Sega's Model 2
library and Fighting Vipers' program ROM carries the same official labels, so
`set_obj` is where it always is and reaches for the model table the same way:

```
set_obj:  ld   off_501018, r4
          ...
          lda  unk_20E0004[g0*16], g0
          ldq  (g0), r8
```

`MAIN_DATA` is based at `0x02000000`, so that is data offset `0x0E0004` on a
16-byte stride — the same as Sonic The Fighters, and the `ldq` confirms the
16-byte entry. The face palette is the labelled `unk_2100000`, data offset
`0x100000`, and reading it back shows a linear BGR555 grey ramp, which is what a
palette that starts at black and walks to white looks like.

The chips settle themselves, given something to score them against. Each region
is a small number of candidate pairings, and a wrong one is not subtly wrong —
it is floating-point garbage. Two tests separate them:

- **Polygons.** Every 40-byte record ends in the polygon's normal, and the board
  stores it unit length. Build a candidate, decode a few hundred meshes, and
  count how many open on normals whose length is 1. The right pairing scores
  across the whole region; a wrong one collapses in the 4MB band it got wrong.
- **Textures.** A material record's first half-word gives the tile size as two
  three-bit fields, and the UV stream is texel coordinates in eighths. A
  candidate that yields tile sizes over 512, or UVs in the thousands, is not the
  texture ROM. Because a record's bytes alternate between the two chips, the low
  chip is scored on the header and the high chip on the UVs.

The pointer ranges size the regions before any of that: the largest mesh pointer
in the table is at 9.9MB, which no two 2MB pairs can hold, so the polygon ROM
has three; the UV pointers stop below 12MB with a 4MB hole in the middle, which
is two pairs at the same offsets Sonic The Fighters uses.

The table's length is the one thing the program does not state. Entries run in
banks separated by runs of zeros, so the end is not the first zero — it is where
entries stop being *plausible*. Every entry up to 5412 has a mesh pointer inside
the polygon ROM and uv/material pointers inside the texture ROM; nothing above
8190 does. That upper stretch is other data that happens to follow the table.

The texture pipeline did carry across, whole. Every routine `js/texture.js`
ports is in Fighting Vipers' program ROM under the same official label —
`unp_send_tex_para_sub`, `unpack_lod_data`, `make_huf_8bit`, `send_beta_data`,
`send_lod_data`, `send_lod_data_q` — and the data header is reached by the same
`ld off_230000C, r4`, so the codec, the page format and the descriptor layout
are all identical. Two numbers move: the page grid, which the same
`ldos unk_4B9C0[g0*4]` pair gives, and the count of texture numbers, which
`unp_send_tex_req` bounds with `lda unk_63, r3 / cmpoble g0, r3` — 0..0x63, so
100 sets against the other game's 18.

What a second game has no answer for is *which* set to unpack. A stage record
names the texture numbers, and there is no stage table. But a face already names
a 32-pixel tile in the atlas, and where a set's pages land is decided by the
origin word and the page grid alone — the codec never enters into it. So
`texturePages` walks a set's page list and returns its 256×256 origins without
unpacking a byte, and `bestTextureSet` scores every set on how many of a model's
tiles it covers. Over 3550 textured models that picks a fully-covering set for
all but one, in about half a second for the whole table; unpacking all 100 sets
to find out would have cost seconds per model.

Coverage is now the last resort, not the first. A fighter's parts take the
set its character record names. A model wholly on the boot set takes the boot
set. What is left is scored against the sets the board can hold at once (the
boot set with a fighter's pair, or with a stage's set), not each set alone.
See `programTextureSets`.

### Working out a later build of the same game

*The House of the Dead* shipped two years after the prototype above, and the
finished set is a harder case than a new game, not an easier one. Nothing about
the library changed — the raw texture banks, the curve colour pipeline, the
placement-driven stages are all still there — but the two program ROMs diverge
196 bytes in and share 5.5% of their 4KB blocks. Not one table address survives.
So no address here was adjusted from the prototype's; each was found again, and
what the prototype supplied was not a number but a *signature* to look for.

The regions come from MAME, and what needs checking is only that the chips are
paired and ordered right. Four things moved: the program ROM is two pairs and
2MB, the polygon ROM is four pairs where the prototype had three, the data ROM
ends in a 1MB EPROM pair mirrored up to `0x2000000`, and the XTRA_DATA window is
the whole top 16MB rather than 8. The window's size is read off the program's own
pointers — the prototype's `0x06xxxxxx` constants stop in the eighth megabyte and
this build's fill all sixteen.

Then, in the order each one unlocks the next:

- **The debug name table.** Both builds keep 1384 texture file names and then one
  `PN_` name per model, as pointers to C strings at `data + 0x02000000`. Scanning
  the data region for a long run of such pointers finds one run beginning
  `GG07.dgt`, and the skip is 1384 in both.
- **The model table**, from the name table's holes. A name pointer is null
  wherever the model table has an empty entry, so the null indices are a mask:
  look for a 16-byte-strided base that is all zeros at every one of them and
  non-zero on either side of each. In 32MB exactly one base matches — and where
  the prototype's table is two copies of 5049 entries, this one is a single copy
  of 7477 that ends with the string pool in the next entry.
- **Confirmation, from the normals.** Decode every mesh the table points at and
  measure the length of the first record's normal. 99.5% are unit, and every
  normal that is not unit is exactly zero rather than noise — the prototype's own
  shape. Scored per 8MB band it holds across all four, including the fourth's 623
  meshes, which is what says the added polygon pair is paired the right way round.
- **The palette tables**, from their first four colours. Every per-set table in
  both builds opens `0x8000, 0xFC00, 0x83E0, 0xFFE0` behind a half-word count,
  and they are packed end to end with the top-of-palette table following the last
  of them. Finding those bodies gives the tables; the one pointer array in the
  program ROM that names them all is the array the game indexes. Thirteen sets
  here against eleven. The top table is a hundred colours whose first are the
  prototype's byte for byte.
- **The neighbours.** Once the palette array is placed, the colour-curve pointers
  and the texture bank table are immediately behind it, in the same order and with
  the same padding as the prototype's — which is worth checking rather than
  assuming, and does check out. The texture patch table is found by its shape:
  set 0's record is 32 zero bytes with set 1's eight data-ROM pointers behind it.
- **The luma table**, which is 0x4000 bytes containing nothing above 63. Its first
  thirty-two bytes match the prototype's exactly, and the match is unique in 32MB.
- **The curve gain**, a float the builder reads as a constant. The prototype has
  1.1 followed by 1.0 with a run of `0x80008000` behind it; that neighbourhood
  occurs once in this program ROM.
- **The material table** did not move at all: all 31 slots byte for byte at
  `0x7A0`, in a program ROM otherwise 94% different. A table that was never edited
  and happened to keep its place.

#### Reading the split and the bank order off the art

Two facts that the prototype needed its own disassembly for fall out of the ROM
here without any.

A set's palette table is written into palette RAM from `split` on, and `split`
is 500 — an address in an instruction, in the prototype. But the models say so
by themselves. Take every model's highest colorbase below the top table's range,
gather it per bank, and compare against `500 + that set's count - 1`: nine of the
thirteen banks land on their set's last colour exactly, none reaches past its own
set's end, and no other set's end fits any of them. The same measurement pins
`split` from the other side, because no face in the whole game names a colour
between the shared table's last entry at 212 and 500. That gap would not be empty
if the split were anywhere else.

The same measurement gives the bank order for free. `bankSets` says which texture
set each bank of the model table is drawn under, and in the prototype it had to
be read off the stage data, because the raw banks are too dense for tile coverage
to answer. Here the colours answer it: bank *k* is drawn under set *k*, for all
thirteen. Bank 0 is the shared one — it names nothing above 212, and one of its
98985 textured faces sits on sheet 1 where every other bank's face does — so its
set decides nothing, and it takes its own.

#### The stages, which do describe themselves after all

The stage tables looked at first like a disassembly job — indexed tables reached
only through code. They are not. Two of the three have a shape nothing else in
the program ROM has:

- A **placement** is 24 bytes: a model number, three world floats, and two tail
  words. So a run of records whose model is inside the model table, whose three
  floats are finite and of sane magnitude, and whose tail is empty is a placement
  table and essentially nothing else is. The prototype yields exactly two such
  runs — its two chapters, the second 27 records long, which is what its own
  notes say. The finished game yields four.
- A **zone** is 50 bytes of placement indices terminated by `0xFF` with zeros
  behind it, which is as distinctive. Four of those as well.

`maps` and `zones` are then simply the arrays that name what was found, and they
sit 0x20 apart in both builds. `scripts` did not move at all — still `0xE0000`,
still a header of chapter pointers, a `-1` and a `0x5C`, with chapter 0's section
array behind it. `sectionSets` is the one array of four pointers to arrays
holding nothing but set numbers, and it reads as the game plays: chapter 0 is
1,1,1,1,1,3,3,3,3,1,1,1 — courtyard, mansion, out — section for section the
prototype's.

Two details differ, and both would have passed silently as corruption:

- The prototype's placement tables close on a record whose model is 0. The
  finished game's close on a `-1` and then a 0, and a walk that stops only at 0
  takes the `-1` for a placement and indexes the model tables with 4294967295.
- The cycle list — the `-1`-terminated run of model numbers an animated placement
  draws in turn — is in the record's *second* tail word here, not its first. Each
  build has exactly one placement that uses one, and it is the same placement in
  both: index 55, `PN_room5a_CT00a`, the rain in the mansion corridor's windows,
  cycling `PN_room5a_CT01` through `CT32`. That the index matches is also the
  reason the draw loop's quarter turn for placement 55 is carried across: the
  compare is against that index, and that index is still that plane.

#### The rig, which describes itself from both ends

The rig is six arrays in the program ROM, laid end to end with two words of
padding between them, and three of the six announce themselves:

- the **body names** are the only long run of pointers to strings beginning
  `BO_`, and the **motion names** the only one to `MO_`;
- the **motion data** table is the only long strictly-increasing run of
  XTRA_DATA addresses, and it opens at `0x06000000` in both builds.

With any one of them placed, the rest follow, because every boundary is a whole
number of entries plus eight bytes of padding. In the finished game the run is
trees `0xC7230`, joints `0xC73B0`, data `0xC7530`, frames `0xC7FC0`, body names
`0xC8A50`, motion names `0xC8BD0` — 94 bodies and 674 motions against the
prototype's 68 and 508 — and the frame counts it lands on open 156, 66, 31, 61,
89, 116, which is the prototype's opening, motion for motion.

The data-ROM tables have no such shape, and were read against the prototype
instead. 59 bodies share a name *and* a joint count between the two builds, and
that is enough to score a candidate base: `roles` is the one base at which 55 of
those 59 agree role for role (the runner-up scores 20), and `scales` the one at
which 58 agree value for value (runner-up 45). `hitMotions` needed no comparison
— it is the only per-body pointer array in 32MB whose every target is twenty
valid motion numbers — and it reads the way the prototype's does: the dogs get
`MO_ddoggdam`, the zombies `MO_z_a_*hit`, the monkeys `MO_saru*dam`.

Two tables changed region, which is the kind of thing no amount of scanning
tells you and a disassembler says in one line. The skin index and the skin's
texture-record pointers are in the data ROM in the prototype and in the
**program** ROM in the finished game — `ldis word_63C60[g4*2]` and
`ldl 0x63D20[g4*8]` — and the pointers are indexed by *body* there rather than
by skin, so bodies sharing a skin carry the same pair. There is still a copy of
the skin index at data `0xF80000`, beside the skin block where the prototype
kept it; it agrees with the program-ROM copy for the first forty bodies and then
does not, and the one the code reads is the one to believe.

The 28 skins' own strides come straight off the routine that builds them: the
count at `0x2F8D220[skin*4]`, the template at `0x2F803A0 + skin*0x640`, the
points at `0x2F8B2A0 + skin*144`, the slots at `0x2F8C260 + skin*96`, the order
at `0x2F8CCE0 + skin*48`, and the shared pair at `0x2F8D290` on an 8-byte
stride. Each ends exactly where the next begins at 28 entries, which is also the
highest index the skin table names.

650 of the 674 motions fit exactly one of the joint counts the bodies have; the
24 that do not are written for counts no body in the table carries, which is the
same thing that leaves two of the prototype's 508 unfitted.

#### A leading zero that was mistaken for padding

The finished game's colour ramps were read one set out, and it took a body to
show it. `BO_kyurianb` came out grey where `BO_kyurian`, the same figure under
another texture set, came out in tan and pale blue.

The two are worth keeping in mind as a technique, because between them they made
the fault findable. They share a name, a joint count, a skin and a part tree,
part for part, offset for offset — only their models differ, one bank's worth
each, so anything that shows on one and not the other is a property of the *set*
and not of the body. That ruled out the tree, the roles and the skin in one
comparison, and drawing each head on its own ruled out the geometry: model 7406
renders perfectly under set 12, grey.

Grey and *lit* is the clue. A model drawn under a set that does not hold its
textures comes out nearly black — 6991 under set 12 lights 3859 pixels against
37490 under its own. 7406 under set 12 lit 32735 pixels at a saturation of 8
where its twin managed 139. The texture was there and bright; the colour was
not. That is the curve, not the sheets.

`colors.curve.sets.ptrs` had been read as the first *non-zero* entry of its
array. It is not: the array opens on a zero because set 0, the boot set, has no
ramps of its own, and the game indexes it with the same set number it uses for
everything else. The set-loading routine says so in three consecutive
instructions:

```
ld   unk_A9970[r4*4], g0   ; the texture bank
ld   off_A98F0[r4*4], g0   ; the palette table
ld   unk_A9930[r4*4], g0   ; the colour ramps
```

Starting after the zero hands every set the next one's ramps, and the last set
none at all — which is the bare grey curve, and why set 12 was the one that
looked broken rather than merely wrong. The prototype's profile had the base
right all along, and its array has the same leading zero, which is the check
that settles the shape.

What it cost elsewhere was subtler and worse for being subtle: every set in the
game was wearing its neighbour's colours. The first chapter's sky came out blue
where it should be a warm sepia, and Stage 4's last section, drawn under set 12,
was black enough to look like nothing had loaded.

The same zero settles what the shared bank is drawn under, which a second body
turned up: `BO_samson` had a black head and black arms. Its models are in bank 0
— the enemies every chapter shares — and bank 0 had been given set 0 on the
argument that neither its palette nor its sheets care which set it takes. They
do not. Its ramps do, and set 0 is not a set the game ever loads: `sub_1330`
dereferences the table it is handed with no check, so a zero would fault. What
boot hands it is `lda off_A95F0, g0`, the table in slot 1. So the ramps a shared
body is drawn under are set 1's, and bank 0 takes set 1 — which is what the
prototype's profile says, for the same reason.

Only the untextured faces moved. A body whose surfaces are textured, like
`BO_kenkyu`, looks identical either way; one that leans on solid colours, where
a palette entry is a row number into the curve rather than a colour, loses them
all to the bare grey. That is why this showed up as *black limbs on one zombie*
rather than as anything so obvious as the whole game being wrong.

#### The draw callback is a table of numbers, not a table of names

`sub_764C0` draws something other than a part's own model for eleven bodies —
Tom's coat, the hand's fingers, the spider's legs, Samson's swapped hand,
Sophie's blinking head, the Devilons' wing beats, and the gun hands of the
shooting motions. Those rules were read off the prototype and written into
`js/bodies.js` as constants, which was fine while there was one game to draw.

Every number in them is an index into the body, the motion or the model table,
and all three renumber between builds. Taken over to the finished game they do
not miss by a little. The prototype's body 34 is `BO_tarab`, the spider, and the
finished game's is `BO_sophi` — so Sophie drew a run of spider legs out of her
head joint, one model a frame, which is the garbage that turned up in her
animation. Its 35 is `BO_samson` and this build's is `BO_hyum` — so hyum's joint
5 was swapped every vsync for Samson's right hand.

So the rules stay in `bodies.js` and the numbers moved to the profile, resolved
by name: `BO_sophi` is 34 here and 39 there, `MO_gman_soten` 195 against 124,
`PN_devilon_hane01` 5121 against 4814. Three of them have no counterpart at all
— this game has no `BO_gman`, no `BO_handrb` and no `BO_tarab` — and a null
cannot match a body number, so those rules simply never fire.

The mapping is confirmed where the finished game's own callback states it. It
compares the body number against 2, 34 and 50, which are `BO_tom`, `BO_sophi`
and `BO_devilon` under the name mapping, and it reaches the two wing beats with
`lda 0x1401` and `lda 0x7CD` — 5121 and 1997, which are exactly where
`PN_devilon_hane01` and `PN_devilonm_hane01` sit in this build's model table.
Its callback (0x9CE50) is the larger of the two and treats bodies of its own
apart. Its body switch (0x9D240) jumps through `0x9D24C[body - 2]`, and the
table sends `BO_devilonx` (69) to `BO_devilon`'s case (0x9DABC). On joint 1
that case draws the part's model and a wing beat, `0x1401` plus the body's
tick rem 100 for body 50 and `0x195F` plus it for the other: 6495,
`PN_devilonx_hane01` to `_hane9a`. So `BO_devilonx` beats its own hundred
wings as the other two do (`devilonX` in the profile; the prototype has no
such body). The case's other half is left out: while the object's `+0x2F4`,
which the case counts down, is odd, the part is drawn another way. What sets
`+0x2F4` was not traced. Read from the ROM, not checked in
MAME. The three Moodys have a case each: `BO_moody` (59, 0x9DFD4), `BO_moodyb`
(70, 0x9E000) and `BO_moodyc` (88, 0x9E018) test the joint's role byte for 2
and, there, draw `0x1618`, `0x1895` or `0x1A56` plus `[0x51EDA0]` rem 50 in
place of the part's own model, then return: `PN_moody_katar_01` to `_50` and
the B and C capes, one a vsync off the counter Samson's case reads. On all three
that is joint 3 (`moodyCape` and the rest in the profile; the prototype has no
Moody body). Bodies 92 and 93, `BO_moodybb` and `BO_moodycc`, reach the same two
runs (0x9E030, 0x9E05C) but have no joint with role 2, so they draw no cape.
Read from the ROM, not checked in MAME. The cases for bodies 48, 60, 64, 76, 78
and 84 have not been read yet.

#### The wounds a shot part takes

The callback draws whatever model a part holds, and a hit changes that model.
`sub_68010` runs on the part a shot lands on. The part's `+0x79` is a signed
count of the shots still to go: a shot takes one off a count above 0, and a
count left at 0 wounds the part. `+0x78` counts the wounds it has, and the next
one is

    ld 0x11DFF0[body * 0x200 + zone * 0x20 + wounds * 4]

stored over the part's model (`+0`) when it is not 0, with `+0x78` one up.
`zone` is byte 3 of the part's joint record (`0x1184E0`, eight bytes a joint,
31 joints a body; the same byte `roles` reads). Byte 2 of that record is the
count the part starts with: 0 or 1, a wound on the first shot; 255, which is
-1 and never reaches 0, so the part never wounds; and once 4, `BO_kage`'s chest,
which wounds on the fourth. After each wound the count is reloaded from
`ldob 0x129BF0[body * 256 + zone * 16 + wounds * 2]`, which is 0, 1 or 255 in
every entry, so after the first each shot on a part draws its next wound until
the list runs out. A zone with no model left ends it; on a head or
an arm (byte 4 of 1 or 2) that also sets the part's `+0x3C` bit 31.

- The last wound of most heads is model 1, `PN_spaceB`, which draws nothing: the
  head is gone. A head reaching `0x135940[body]` wounds also calls `0x69540`.
- One model is never stored: `cmpibe g7, 0x7B0` skips `PN_zonbimana_mune_dam03a`,
  so that chest keeps its third wound when it takes its fourth.
- A head or an arm is left as it is while `0x51F520+0x3C5` has bit 1 set. That
  flag was not followed further.
- Zones are shared across bodies freely: `BO_siriru`'s hands wound into
  `BO_zom`'s, which hold no axe, and `BO_samson`'s left arm starts at
  `PN_zonbisan_udel_dam01a`.
- 50 of the 94 bodies wound. `BO_boss3`'s every joint names a zone but starts at
  255, so it never does.

All four tables are in the second program pair (`epr-19694`/`19695`), which
both revisions share, so `rig.wounds` is the same for both. The Animation tab's
**Wounds** slider is the shots on each part (`readWounds`, `woundModel`,
`partDraws`' `shots`).

Graded against MAME (shared build, `hotdo` attract, 300 s): a breakpoint on the
store at `0x68154` logged body `[0x520220]`, joint `+0x38`, wounds `+0x78` and
the model, 65 stores over `BO_zom`, `BO_zonbiman`, `BO_neil`, `BO_siriru`,
`BO_samson` and `BO_mon_kihon`. All 65 are the model `readWounds` gives for that
part and that many shots.

#### The bodies were never given their layers

`js/layers.js` exists because this game's art lays one face on another in the
same plane and leaves the board's polygon sort to say which is on top. A depth
buffer cannot, so the ranking is computed and the fill shader takes a ranked
face's depth from its group's plane. Both games that need it declare
`depth.layers`.

It was applied to the stage draws and to a lone model in the Models tab, and
never to a body's parts. So every enemy wore its decals fighting: `BO_neil`'s
wounds are faces laid on his face, and which of the two the depth buffer kept
came down to rounding, in stripes, differently each frame as the pose moved.

A part is the easy case, easier than a stage. It is rigid — a pose moves its
matrix and never its points — so its faces can be ranked once per model in the
part's own space, and the vertex shader already carries a plane from local space
into view through the normal matrix, the same way it carries a normal. Nothing
had to be added to the shader; the ranking simply was not being asked for.

It is not a rare shape. 81 of the finished game's 94 bodies have at least one
part with faces stacked in a plane, and 58 of the prototype's 68 — `BO_ebita`
has thirteen of its seventeen parts that way, and 74 of the 148 faces of its
chest alone.

The geometry cache the parts draw from is shared with the stage path, which
ranks the same models against a whole scene rather than against themselves. The
two need not agree, because switching tabs rebuilds whichever view is showing.

#### Auditing the bodies

Two bugs found by eye — Sophie's garbage and hyum's hand — were both a part
drawing a model out of a bank its body has nothing else in, and a third,
Samson's black limbs, was a face naming a colour its texture set does not hold.
Those are mechanical questions, so they are worth asking of every body at once
rather than waiting for the next one to be noticed. Over each body: does the
part tree match the joint count, do the models every part can draw — its own and
the callback's, sampled across its motions, frames and vsync parities — all
exist, decode to geometry, come from a bank the body uses, and name colours the
body's set resolves, and does a named skin build?

Across all 94 bodies of both revisions, and the prototype's 68, nothing is left
of those three classes: no model past the table, none decoding to nothing, none
from a foreign bank, none naming an unresolvable colour. What the sweep does
turn up is two things that are the ROM's rather than the reader's:

- Seven bodies have fewer parts than joints — `BO_neopetit` and its two
  variants, `BO_pkenb`, `BO_pdolob`, and, in the finished game, `BO_pbaba` and
  `BO_gfrog`. The same bodies do it in the prototype, so a tree that uses twelve
  of its eighteen joints is how they are built, not a truncated walk. The
  motions are still written for eighteen.
- `BO_moodybb` and `BO_moodycc`, the last two entries of the finished game's
  table, name skin 23 and carry real texture pointers for it, but their records
  in the roles table are not records — the table's structure runs to body 91 and
  what follows at their offsets is other data. Without a chest and a hips role
  there is nothing for a skin to join, and the game's own callback switches on
  the same bytes, so it has no more to work with. They draw; they have no torso
  seam.

The prototype's own sweep flags one thing the finished game's does not: Tom and
the two gmen each draw one model from bank 0 that their own parts never use.
That is the shared gun hand, and it is correct — their bodies are in a chapter's
bank and the hand they are handed is in the bank every chapter holds.

#### Revision A, and what a shifted build is worth

The finished game shipped in two revisions. MAME calls the later one `hotd` and
the first `hotdo`, and they differ in one chip pair — `epr-19696a.15` and
`epr-19697a.16`, the first megabyte of the program ROM, which is where every
table the viewer reads out of it lives. The second pair and every mask ROM are
the same chips, so the model table, the names, the bounds, the roles, the
scales, the hit motions, the luma curve and the whole skin block do not move.

28.5% of that megabyte's bytes differ, across 408 clusters, which looks like a
rewrite and is not. It is an insertion. Running the same finders over Revision A
that found the first revision's tables — the `BO_`/`MO_` name runs, the
increasing XTRA_DATA run, the palette tables' four opening colours, the 24-byte
placement records, the 50-byte zone lists, the sky's dome numbers — puts every
table exactly sixteen bytes later than before, the colour block a hundred and
twelve, with two exceptions: the skin index and its pointers moved a quarter of
a megabyte back, and the stage scripts did not move at all.

It is worth saying why this was still done with the finders rather than by
adding sixteen to the profile. A constant offset is a *result* here, not a
method. It is only trustworthy because each address was found independently and
the offsets came out equal, and the two tables that broke the pattern are
exactly what a blanket shift would have got wrong — silently, since a wrong
skin-pointer base still reads plausible-looking numbers.

The contents then check the addresses back. Every table that holds values rather
than pointers is byte for byte the first revision's: the joint counts, the frame
counts, the flat ankles, the top palette, the gain, the sky records, the texture
patches, the bank table, all 94 skin indices and all 28 skins. Every table that
holds pointers differs by exactly the shift. And the two builds produce the same
eighteen stages with the same zone, placement, draw and triangle counts, and the
same 94 bodies over 674 motions with 650 fitted and 55 skinned — which is the
real test, because a single wrong base would have moved one of those numbers.

#### Telling a merged set apart

A merged MAME archive holds the parent and every clone at once, and it broke
detection the first time one was loaded. `readZipDirectory` keys members on
their basename so that a split set resolves, and under that rule the one archive
satisfies all three House of the Dead profiles at the same time — `prg0.15` is
in it, as `hotdp/prg0.15`, and so is `epr-19696.15` as `hotdo/epr-19696.15`. The
answer came down to the order of the `GAMES` list, which is no answer at all.

MAME's own convention settles it: the parent's chips are the ones at the top
level, and a clone's are in a directory named for it. So the reader now records
whether a member was nested, never lets a nested chip displace a top-level one
of the same name, and `detectGame` prefers the profile whose members are all
top-level, falling back to basenames only when none is. A merged archive then
identifies as the parent, each standalone clone zip as itself.

#### The sky, which the model names give away

The sky is geometry in both builds: a dome a script opcode picks and turns, and
`PN_skyuv02a`, a cut-out band, drawn over whichever dome is up. So the names
find it. Eight of the finished game's models have `sky` in the name, six of them
domes, and the one array in the program ROM that names any of those six names
all six.

It is not shaped like the prototype's. There, the models and their heights are
two arrays of four and the drift rate is a constant in the code; here the three
are folded into a sixteen-byte record per sky. The heights confirm it anyway:
`PN_r2skyuvb` hangs at -200 in both builds and every other dome at -9.

What the sky proves is not only itself. The stage scripts hand out the sky by
opcode, and the chapters they hand it to are the chapters the artists named the
models for — `PN_skyuv` and `PN_skyuvb` over the first chapter's courtyard and
mansion, `PN_r2skyuv`, `PN_r2skyuvb` and `PN_r2skyuvc` over the second's three
sets, `PN_skyuvst4a` over stage 4's last set, and nothing at all over the third
chapter, which is indoors. Nothing in the placement, zone or script tables knows
what those names say, so the agreement is a check on the script walk as much as
on the sky.

### Colour and light for a second game

The colour tables carried across as completely as the textures did.
`send_tex_col_go` in Fighting Vipers is instruction for instruction the other
game's `send_tex_col_loop` — the same `0x200` row stride, the same `0x60` group,
the same sixteen colours over luma 48..63 with channels `0x20` apart. The ramp
in `chg_pol_color_req` uses the same `0x1C`/`0x12` rational and starts its row
loop at 1, leaving row 0 and luma 0 zero exactly as the other does. `sub_74C`
builds the intensity curve on the same pivot and divisor, written as
`shlo 2, 0x1D` and `addo 0x1F, 6` — 116 and 37. And `check_sram_all` ships add
22, multiply 54 and brightness 31, which are the other game's numbers, though
this one keeps a pair per channel at `0x500234`..`0x500239` rather than one for
all three. So `js/colors.js` is one implementation with the addresses lifted out
into the profile.

Two things differ. There is no pointer block: each upload names its table
outright, `lda unk_2109700` for the scene's and `lda unk_2105800` for a
fighter's parts. And a fighter takes seven colorxlat rows a side rather than
five, so rows 0..6 and 7..13 are both spoken for and there is no gap left for
the pair of boot-time tables the other game needs.

### The second data bank

The lighting is in a place the ROM layout did not originally have. Sockets .5
and .6 are not part of the data region the i960 sees at `0x02000000`; they are a
second bank reached only through the XTRA_DATA window, and the window is split
in two. Anything with `0x800000` set mirrors that bank, anything without mirrors
the last megabyte of the data region, and both halves repeat every megabyte. The
split was read off the board's own addresses: `lda unk_64266E0` for luma RAM
lands in the low half and matches the data region byte for byte, while
`ld off_6CE33A4[r12*4]` for the material table lands in the high half and
matches the .5/.6 pair, which nothing else in the set uses.

In that bank is a scene table, indexed by `change_scene` with `shlo 8, r12, r4`
off `stage_num` — the same `0x100` stride the other game's stage record has. The
fields the viewer reads are the ones `change_scene` and `stage_disp` read:
brightness and the two rotations that build the light vector, the pair of
texture numbers handed to `send_tex_stage`, and three bytes copied to `0x5000E0`
as the per-channel trim. A second array gives the materials: `sub_24878` walks
32 slots out of `off_6CE33A4[stage_num*4]` and pushes them at the geometry
engine behind command `0x606`. The debug editor at `sub_56694` names every field
of a slot as it builds one, which is how the packing was confirmed — diffuse in
bits 0-7, ambient in 8-15, specular in 16-23, mirror in 24-31.

The light vector needs no new code: it is `(0, 0, bright)` turned by the same two
rotations, which is the board's formula and already in `stageLight`.

### Where the sky is

There is no sky geometry in Fighting Vipers. No stage record carries a shell —
every byte past `0xB8` is zero on all sixteen, where the other game keeps a
four-entry list at `0xC0` — and no stage has anything enclosing to stand in for
one: on the western arena the tallest model reaches seven units and the largest
is its own floor. The two models `sub_24224` draws four times round the arena
are both railings, which was settled by rendering them.

The sky is the board's 2D scroll layer, and it is per stage. `sub_29728` takes
`stage_num`, indexes a 32-byte record at `0x6CE3600`, and hands the number at
its `0x0C` to `_Scroll_Initialize`, which loads that stage's tile graphics from
`off_6450000[n]` and that stage's palette from `off_6450000[n + 1]`. A second
pointer at `0x14` feeds a per-stage tile blit that lands in text RAM at
`0x1004000`, which is the visible tilemap.

Those palettes are visibly skies and visibly differ. The western arena's is a
ramp of blues at full blue with the green climbing — a gradient — topping out at
white; the night parking lot's opens on `0x9400`, which is R0 G0 B5, a near
black. So a per-stage sky colour does exist, and it is in that palette.

The layer is now decoded, in `js/scroll.js`. Three formats, each read off the
routine that walks it: the CG list is pairs of source and destination until the
source is zero, a source being a count followed by that many 32-byte tiles —
8x8 at four bits a pixel; the palette list is blocks of destination, halfword
count and data; a pattern is a header whose `0x04` is its row count, then rows
of 32 tilemap entries on a 64-byte stride.

A tilemap entry is read the way the System 24 tile chip reads one, as MAME's
`segaic24` does and m2-hle2's tile renderer now does too: the character is the
low 14 bits, the palette group is bits 7–14, and bit 15 is the category, which
puts a tile behind the 3D when clear and in front when set. `0x1080000 + char *
32` is the tile's pixels, and `0x1080000` is the address `clr_first_group_cg`
clears.

The character and the group share bits 7–13. That is why no split of the entry
into separate character and palette fields put every character inside a range
the CG list fills, and why this section once concluded there was no palette
field and coloured the whole sky from the first group the palette list writes.
The game packs its characters so that the overlap *is* the group it wants. The
sky's characters start at 7680, which is group 60, the first group every
stage's palette list writes, and on all sixteen stages every tile names a
group its list writes. Each list writes 19 to 67 groups, so a single group
was never enough: it coloured 6% to 80% of a stage's sky wrong. Slot 4's sunset
broke into banded clouds with black holes in them, and slot 0's hills came out
as a white stripe. Every sky tile is category 0, behind the arena.

Eighteen patterns of 32 tiles is 576 across where the hardware shows 64, so the
strip is nine screens wide. That is not a wide backdrop to be cropped: 576 tiles
is one full turn and 64 of them is the board's horizontal field, which is why
the viewer puts it on a cylinder at that scale. Turning the camera walks the
strip exactly as the scroll registers walk the tilemap.

Vertically it is an estimate rather than the board's arithmetic. The board draws
the layer in screen space at one tile to eight pixels, so how much sky is in
frame is a property of the projection and not of anything in the data. The
cylinder is scaled by the same pixels-per-radian the horizontal mapping implies
and carried on the camera, the foot of the strip on the eye line — which is what
a skybox does, and here it is the behaviour being reproduced rather than a
convention borrowed.

The backdrop comes out of the same decode. The panorama is a band, not a dome,
and above its top row the hardware shows the backdrop; the commonest colour
along that row is what the sky is doing where it runs out. That is the per-stage
colour, and it is what the viewer now uses — deep blue over the western arena,
near-black over the night parking lot. The boot-time constant `init_fix` hands
`bg_col_set` is kept only as a fallback for a stage whose panorama will not
decode.

### The stage records

They are the other game's records exactly. `stage_data` is a label in this
program ROM at `0x06CE1048`, and `change_scene` indexes it with
`shlo 8, r12, r4` — the same `0x100` stride. Every field `js/stages.js` already
knew is at the same offset, and each was confirmed against the routine that
reads it: `change_scene` for the brightness, rotations and texture pair,
`stage_disp` for the trim, `pole_disp` for `0x1C`, `cage_sub_disp` for `0x1E`,
`cage_clip_m` for the cage at `0x84`, `ground_upper_disp` for a list at `0x24`
the other game has no equivalent for, and `object_init` for the pointer at
`0xB4`. Every single-model field resolves to a table entry carrying geometry.

So `readStageTable` is one reader with the addresses in the profile, and the one
new thing it needs is that a record may live behind the mirror window rather
than in the program ROM.

The draw list, though, is not the same at all, and it is simpler. The other
game's `buildStageDisplayList` is mostly about transforms — the 1.6 scale on the
arena, a matrix each for the cage, its posts, the ring ramp and the platform.
This one pushes the stage position once and then hands each list to `area_clip`,
and `area_clip` is a cull:

```
area_clip:  ldos  (g2), r5          ; count
            ...                     ; four indices into a visibility bitmap
            and   r9, r10, r10
            cmpobne 0, r10, skip
            ldos  (g3)[r6*2], r13   ; the model
            mov   0, g1
            call  set_obj           ; no matrix
```

Four bytes of clip-region indices per model decide whether it is drawn, and
nothing transforms it. The geometry is already in world space, so the draw list
is the lists themselves at the identity, and `buildFlatDisplayList` is the whole
of it. The layers are a grouping for the sidebar rather than a claim about
transforms.

The cage is the one list that is transformed. `cage_display` (`0x221A8`)
pushes a scale of `(s, 1, s)`, `s` the ring-out bound over 6, and then takes
four sides, a quarter turn about Y after each; `cage_clip_m` (`0x22398`) draws
the side's panels from `+0x84` under a push of `+6` on Z. That is eight
panels, or four, two or one when flag bit `0x13`, `0x15` or `0x16` is set (the
later bit wins), and with bit `0x14` the model at `+0x20` too. The Observation
Deck's `boss_cage` (`0x22668`) draws two panels a side instead, by corner. The
board draws a side only while the camera is inside its plane (`byte_500288`);
that is a cull, and the viewer draws all four. Before this was read the viewer
drew one side and left the other three to the rail `sub_24224` lays round all
four, which is translucent.

The object list at `0xB4` is what animates a stage; see
[Fighting Vipers' stage objects](#fighting-vipers-stage-objects-jsfvobjectsjs).

### Virtua Fighter 2's stage records (`js/vf2.js`)

Virtua Fighter 2's records are 256 bytes at `0x6EE38`, indexed by `stage_num`
(`0x500064`) shifted left by 8, and the draw at `0x20708` reads them. They
are not Fighting Vipers' layout: thirty-two scenery models at `+0x00`, culled
by camera cell (`0x20AFC`), sixteen backdrop models at `+0x40` picked by view
direction (`0x207E0`), single models at `+0x60` (flag bit 8), `+0x62` (the ring
floor) and `+0x64` (flag bit 5, Dural's mirror floor), the flags at `+0x68`,
the light at `+0x6C`/`+0x70`/`+0x72` (copied by `0xCE1C` as `change_scene`
does), the texture pair at `+0x78`/`+0x7C` and six ground models at `+0x84`
by ring size (flag bit 2). None is drawn under a matrix except the floors, which
`0x20264` and `0x20418` scale by (size/6, 1, size/6), size the operator
setting at `0x50A00C`.

Flag bit 3 is the raft. `0x20054` walks eight logs from a list in the stage
state (`0x100(g13)`), under the ring scale, at x = 5.4, then 1.4 and five steps
of 1.6 down, and the last 0.2 back; `0x202E8` walks ten planks from
`0x150(g13)` 2.2 apart from x = 9.9 and then model `0x764`. `0x1D6D0` and
`0x1D824` fill both lists whole while the raft is clear of the bank's shade,
and the raft cut by the shade otherwise (below). Flag bit 6 swaps every list for the ones at
`0x6FE38` while byte `0xDF` of the stage state says so: the Colosseum's second
look, its lightning (below).

The names are the debug menu's (`0x71AF4`, thirteen-byte strings, pointers at
`0x46108`), indexed by the colour block plus one. Records 10 and 11, 13 and 14
repeat earlier ones in everything drawn and are listed once; record 15 draws
model `0x8FF` alone (flag bit 12, `0x20078`) and is listed with just that.

The sky is the tile chip's layer (`buildVf2Sky` in `js/scroll.js`). `0x24314`
indexes a 32-byte record at `0x2502C` by `stage_num << 5`: the CG list at
`+0x08`, the palette list at `+0x0C` and the pattern list at `+0x10`, a
halfword row count, the vertical offset's byte and eighteen pointers straight
at pattern rows. The per-frame routine (`0x24534`) is Fighting Vipers'
`0x29A40` without the arena turn; the vertical scroll is
`8 * list[2] - (pitch - 0x2E0) / 16`.

The raft moves under two flags. Bit 3: `0x1D530` takes 0.037 off `0x50A014`
every frame, and the stage draw pushes the negated vector before the scenery,
so the bank slides along +X. Bit 4: `0x1D550` counts frames at `0x50A026` and
sets the roll at `0x50A024` to `411 sin(128 t) + 133 sin(192 t + 0x1234)`, and
`0x1DD8C` rolls the view by its negation under the raft, the ring floor and the
fighters. The counts start again with the stage (`0x1FE78`); the explorer
starts them again every thirty seconds.

What looked like the logs drifting apart is the river's shade, and it follows
the river, not the fighters (`0x1D66C`, the stage's "river shade" switch, on
to start with). Each frame `0x1FBB4` takes the raft's reach along the river,
the river less and plus a half length times cos(roll) (the ring setting for
the logs, 11 for the planks), and tests it against [-22, -12], then
[-70, -60]. Out of both, the lists are whole. In one, the band's part over the
raft, as (x - river) / cos(roll), goes to `0x1FACC`, which walks the pieces
from one end: logs from -5.95 s to -4.8 s and 1.6 s a step (s the ring scale),
tables `0x6E648`, unit 0.05 s, cut entry 32; planks from -10.95 to -8.8 and 2.2
a step, tables `0x6E998`, unit 0.05, cut entry 44 (`0x6E9C0` instead under a
`0x500068` mode the explorer does not use). A piece the band misses takes entry
0; one the band starts in, entry cut + round((start - piece start) / unit);
one it covers, entry cut; one it ends in, round((end - piece start) / unit).
The tables are u32 model numbers. A log that is not a whole one is drawn over
`0x6A6` (the ends) or `0x6FF` (between), `0x20118`. The plank list's index i
is at x = -9.9 + 2.2 i.

Record `+0x80`..`+0x82` scales red, green and blue (0x80 is one) into
`0x5000E0` for the colour tables (`0x2C38`), as Fighting Vipers'
`stage_RED`: the mirror stage's 50 70 80 is its water, Souseiji's and the
stones' a warmer dusk. `+0x76` is the stage's kind, and `0x31408`, after the
fighters, runs the kind's own effects under the camera.

- Tou-rin (kind 12): `0x30E74` draws `0x70FBC[(frame >> 1) & 0xFF]` at the
  origin, 256 models of blown leaves, each one frame of a 512-frame gust.
  `0x30EAC` is a burst the fight sets off (below). The frame in that
  index is `0x500020`, the board's power-on frame counter (zeroed at
  `0x99E8`, one added a frame at `0xA028`), drawn under the stage origin's
  matrix. That counter is not a stage-record field and not the explorer's
  frame, so which leaf the explorer shows at a given frame is an
  approximation of the board's, and stays one.
- The Colosseum: its sky's per-frame routine `0x2468C` runs four channels. A
  frame's random byte (`0x94D0`, which sums hardware counters, so a seeded
  generator stands in) starts channel n if it is n and the channel is idle;
  0 and 2 never run together. Each channel steps the timeline at `0x24D70`
  once a frame (0 on, 1 off, 0xFF stop): on for frames 0-2, 4-5, 8-10, 12-17,
  20-22 and 24-25. Channel 0 rewrites the cloud's palette groups 59-95 from
  `0x24C6C`; 1 lights the mountain (groups 100-117 from `0x24CB6`,
  `0x24CF8`); 2 puts the bolt's eight 2x18-tile blocks (`0x2AA8346`, `0x8F1C`'s
  format) over stream columns 24-31 from tile row 8. Each off write puts the
  stage's own palette or tiles back. Channel 3 sets bit 0 of `0xDF`, which
  swaps in the second look (its rings at `+0x64` of the list at `0x6FE38`),
  and `0x1FC00` sets the light to 9999 at angles `0x9D00`, `0xBF00` while it
  is on.
- The mirror stage (kind 4): the tint above, and the sky's per-frame routine
  `0x24DBC` turns on the line scroll and shifts line l by
  `0x24E30[(frame + l + 0x2E) & 127]`, two ±4-pixel sines interleaved line by
  line. The line table is indexed by screen line (`segaic24.cpp`) at
  `g6 + l`, and V is `8 * list[2] - g6`, so line l shows panorama row
  `8 * list[2] + l` at any pitch. `0x30CA4`'s bubbles rise from a fighter's
  part (below).
- Stages 7, 9 and 12-14 shimmer the sea the same way (`0x24F90`): lines
  `[g1, 0xF0)` take `0x25024[((frame >> 2) + l - g1) & 7]`, g1 `0x96`, or 100
  on stage 7.

#### Faces laid on faces

The Great Wall's banners (`棋逢对手`, `决斗胜负`) are painted on the wall in the
wall's own plane. A depth buffer finds the same depth on both, so the brick
showed through the banner's edges in stripes (issue 87). On the board, the
polygon sort decides which face is drawn on top; the board has no depth buffer.
VF2 therefore sets `depth.layers`, like Sonic The Fighters, The House of the Dead
and Daytona: `js/layers.js` ranks coplanar faces the way the board's sort does,
from the camera, every frame. The same ranking settles two other ties. The
Islands' grass now lays its ragged fringe over the sand, where the sand used to
cut it in straight lines. A triangle that the Mirror stage's floor lost to the
tile under it is drawn again.

#### The switched effects (`js/vf2fx.js`)

What the stage view leaves out unless asked is a switch in the stage panel's
Effects field, each listed by the stage it belongs to; switching one rebuilds
the stage and keeps the round's clock. Three run on the power-on counter `c`
(`0x500020`) and the camera (`g13 + 0x18` x, `+0x20` z, `+0x26` yaw). The
explorer's frame stands in for `c` and its own camera for the board's: the
yaw is `cameraOnCourse`'s heading, the sense the culling tables agree with
(Budou-jou keeps the billboard at x = -12 while the camera faces -x). The
octant is yaw >> 13; the cell is col + 4 row, each of x and z + 10 counted
past 0 and past 20 (truncated for the billboards, rounded for the Islands).

- **billboards**, Budou-jou (`0x2EC24`, kind 11): `0x2EE90[c & 15]` at
  (12, 1.19, 12) and `0x2EE90[(c + 8) & 15]` at (-12, 1.19, 12) (models
  `0xF58`-`0xF67`), turned to the yaw ^ 0x8000. `0x2EE40[cell] &
  0x2EE70[octant]`: bit 1 draws the first, bit 0 the second.
- **animated objects**, the Islands (`0x2EEE8`, kind 1):
  `0x2F788[(c >> 2) & 63]` at (12.5, 0, 17.6) turned 0xE000, unless
  `0x2F778[octant]` is 0xFFFF; while yaw bit 15 is set, `0x2F808[((c >> 2) + 8)
  & 63]` at the origin and `0x2F788[((c >> 2) + 16) & 63]` at (22.4, 0, -5.8)
  turned 0xC000. Then 23 records at `0x2F364` (44 bytes): record i draws
  `(+0x00)[(+0x24)[((c >> +0x28) + +0x23) & +0x22]]` at `+0x04`, turned y, z,
  x by `+0x1C`.. and scaled by `+0x10`, if `+0x29` has `0x2F35C[octant]` and
  bit `cell` of `+0x2A` is set.
- **corner objects**, Souseiji (`0x2FCBC`, kind 7): corner 0 while
  `0x2FD08[octant]` is set, corner 1 while `0x2FD10[octant]` is. The upper
  model `0x7125C[(c / 3 + 8 i) & 15]` at height 1.86, scaled by `0x2FD18[k]`,
  turned to the yaw ^ 0x8000; under it `0x7121C` / `0x7123C[(c / 3) & 15]` at
  -0.5, turned x, z, y by `+0x2B0`.. They stand at (9.19, -9.19) and
  (-9.19, -9.19).

The rest a fighter sets off, and the stage view has none, so a stand-in sets
them off at fixed times of the explorer's thirty-second round and stands at the
ring's centre:

- **corner falls**: k (`+0x27E` / `+0x27F`) is 1 once a fighter (`+0x1F4`)
  stands past ±8.69 in x and below -8.69 in z (`0x30168`, `0x3018C`), then one
  more a frame to 31 (`0x30240`). The lower model tips by x = k << 9 (negated
  for corner 1) and z = atan2(sin x, 1); both sink 0.125 k out along the
  diagonal; the upper one shrinks down `0x2FD18` and goes at 16, when the lower
  one becomes `0xE43`. The stand-in steps into corner 0 at 10 s and corner 1 at
  20 s. On, it replaces the corner objects at rest.
- **burst**, Tou-rin and Souseiji (`0x30EAC`, kinds 12 and 7): when a fighter's
  `+0x1A8` is 0x40A with `+0x1AA` at 1, 177 frames of `0x70CFC[n]` and
  `0x70E3C[n]` (the same list 32 behind) at the fighter's waist (`+0x1F4`)
  less 1.5 in y. The stand-in: every 10 s from 1 s, at the origin.
- **bubbles**, the mirror stage (`0x30CA4`, kind 4): `0x711BC[(c >> 2) & 15]`
  turned to the yaw, then about x by the camera's pitch over 16, at a point
  re-taken every 64 frames from a fighter's part, (0.15, 0, -0.03) in its
  frame. Not drawn while `0x50004C` is 2. The stand-in's part is at (0, 1, 0).
  The turns are the camera record's (`g13` is `0x515400`): `+0x26` by
  `0x36806D6D` unless 0, then `0x10000 - ((+0x24 × 0x4000) >> 18)` by
  `0x36006C6C` (`0x30DC0`..`0x30E40`). Both are read by `ldos`, which
  zero-extends (`ldis` is the signed load), so the tilt is
  `-((pitch & 0xFFFF) >> 4)`: −pitch/16 while the camera looks up, and that
  less a sixteenth of a turn while it looks down (pitch negative), which is
  most of a fight. The explorer takes the pitch from its own camera
  (`cameraOnCourse`, `asin` of the view's y as a board angle) and draws the
  same turns (`bubbleTilt`, `js/vf2fx.js`).
  - MAME, attract with `0x500064` held at 10 once the demo picks its stage,
    a breakpoint at `0x30E18` logging `0x515424` and the tilt: 2929 draws,
    pitch −8081 to 2691 (1369 up, 1560 down), every tilt equal to
    `bubbleTilt`'s (e.g. pitch `0x2E0` → `0xFFD2`, `0xFD91` → `0xF027`).
  - Headless Chrome, stage slot 11 (Mirror) with the switch on, the camera
    framed from four directions: pitch `0xE000` tilts the bubble's up axis
    19.69°, `0xF7F5` 21.79°, `0x0BE0` 1.04°, level 0°. No page errors.
  - The lean: MAME's geometrizer matrix for the bubble (the `0x0B` matrix write before its object in buffer RAM) is a turn about view x by pitch − tilt, both looking down (pitch −3.43°, tilt −22.29°: 18.86°) and up (7.88°, −0.49°: 8.37°), and the explorer's view matrix gives the same (18.85° at −3.43°, 8.46° at 7.97°), so `angX` turns the way `0x36006C6C` does.
- **stone flies**, the stones (`0x311B8`): below.

- The stones (kind 5): `0x31040` draws the u16 at `0x70CBC`, model `0xEE1`,
  translated to the stage state's `+0x54`. The stage set-up (`0x2EC0C`) clears
  `+0x40` and `0x31004` puts `+0x54` at (6, 4.7, 18.5): the stone at rest, which
  the explorer draws. Once the fight sets bit 1 of `+0x40` (the round's end at
  `0xF700`, or all of `0x171730` in `0x500700` at `0x313FC`), `0x311B8` pushes
  the stone at the head (`+0x20C`, 0.25 up) of the fighter `0x500065` picks:
  each frame 0.02 of the way on each axis, held within a limit that grows
  0.0005 a frame from 0 (`+0x60`); the yaw `+0x70` turns to atan2(dz, dx) by up
  to 0x400 a frame, the roll `+0x72` to the climb by up to 0x200 within
  ±0x2000; and `0x31188` draws `0x70CBC[c & 31]` turned by them. Bit 2 puts it
  back and bit 3 carries it with a fighter; neither is followed. The **stone
  flies** switch lets it go at 5 s at a head 1.6 up at the centre, and replaces
  the stone at rest. One MAME dump (vf2, attract forced to
  stage 7, frames 1500, 1597 and 1694, `+0x40` = 0) draws `0xEE1` once, with
  the stage origin's rotation and the origin moved by (6, 4.7, 18.5); the
  largest translation error is 7.1e-7.

### Virtua Fighter 2's fighters (`js/vf2fighters.js`)

Character set-up (`0x13F08`) reads the record `ld 0x200620C[char*4]`: the
sixteen part models at `+0x00`, the skeleton at `+0x04` (fifteen offsets,
entry j slot j+1's place in its parent's frame), the texture set at `+0x30`
(the request at `0x4B838`, which loads it and the next) and thirty-two hand
models at `+0x3C` (`0x19E34` picks from them). There are twenty-six records.

The names are the game's own. The pointer tables at `0x2980C` and `0x509E8`
name records 0 to 10, AKIRA to LION in record order, and drawing each record on
its own texture sets agrees. The tables at `0x5CB28` (eight-byte names) and
`0x46298` (the debug menu's, with the development names SUI, ACHO and TOU for
Shun, Dural and Lion) go on to MUE and KOJACKY for 11 and 12. The record table
holds the same pointer, `0x20032A8`, at 10, 11 and 12: the game stores Lion's
record three times over, so the two named slots draw Lion.

Records 13-25 are the thirteen again as player 2 wears them, as in Fighting
Vipers. When both players pick the same fighter, `0xBDE4` adds 13 to player 2's
character at `+0x1B0` (`0xCED4` does the same to the arcade opponent's when it
draws the player's fighter); the record is read by that number (`0x13F10`), and
`send_tex_col_part` reads 13 and up out of its second table (`0x2107780`, `0x788`).
`+0x1B1` is the number less 13 (`0xB6C4`), and the crouch reads that one
(`0x29414`). Each is on its fighter's own texture sets. Akira's (13) is the
white gi; Dural's (22) is Dural's own record again, so only the colours change;
23-25 are Lion's three times over, as 10-12 are.

The motions are Sonic the Fighters' keyframe blocks (`js/motion.js`). A motion
id indexes the pointer table at `0x2120004` directly (`0x1A21C`, `0x27B5C`);
entry 0 points at the table's own end, so it holds 1360.

The pose routine (`0x27CE0`) is `calc_rob_angle_cont` nearly op for op, and
`buildPose` in `js/pose.js` takes the three differences as options:

- Everyone is solved on one standard rig, the table at program ROM `0x296A0`:
  the chest and head offsets, then per limb its pivot and the two bone lengths.
- A motion can hold a slot's look as angles rather than a point. A float
  object keyed with channel type 1 (13, 14 or 17) is latched by `0x26FAC`:
  its three floats are rounded (`cvtri`) into the slot's angles and a bit is
  set at player `+0xBDC`, and the draw turns Rz then Ry by them (`held`). All
  but one motion hold the pelvis, object 17, at (0, 0, 0x4000): the quarter
  roll Sonic the Fighters hard-codes.
- A foot turns from the floor: `0x171B0` starts from the matrix saved at
  `0x501024`, the fighter's place and facing before any of the pose
  (`levelFeet`).

The draw (`0x16504`-`0x176A0`) then places each slot at its parent's place plus
its parent's matrix times the record's offset, with the solved rotation.

What the fight adds (`fight`, filled in frame by frame by `poseFighter`):

- **Blend.** Player `+0xBE8 + 6*obj` holds an (x, y, z) turn for each of the
  twelve angle objects: 0-3 the hands and feet, 4 the body (`+0xC00`), 5-11 the
  rest. Each is applied after its object's euler as rotY, rotX, rotZ. At a
  switch, `0x27630` computes the residual with op `0x2A005454`:
  `E(new)^T E(old) B(current blend)` as Y, X, Z angles, with E the ZYX euler,
  and stores it as a step; on frame f the turn is the step times (N - f),
  gone by frame N. The hand and foot targets blend the same way (`0x27730`):
  (old - new) / 2^shift per float, x and z measured from the body position,
  old being the targets as last drawn.
- **Blend length.** It comes from the new motion. Set-up (`0x27130`) reads
  its frame count (`+0x800`): N is 8 for a motion longer than 16 frames, 4
  for 9-16, 2 for 5-8, 1 for 3-4, and none for a shorter one. The shift is
  3, 2 or 1 (`0x2760C`, the same for the points at `0x27708`). Checked
  against all 162 switches captured: `+0x800` is always the motion's frame
  count. A motion that loops from its last frame back to its first blends
  into itself (16 of 17 loops captured); one cut short and restarted
  doesn't.
- **Which ways a switch blends** (`blendMode` in `js/vf2fighters.js`).
  Set-up (VF2 `0x27130`, FV `0x29F50`) stores a mode at `+0xBDD`: bit 0
  blends in, bit 1 blends out. The first tests are the fight's and stay left
  out: `0x508008`, `+0` bit 26 clear and `+0xBE4` = 1 give none (the intro
  and win poses are the `+0xBE4` ones: the fight sets it the frame they
  start), as do FV's `+0x720` bit 1. The rest are the motion's, in the
  game's order:
  - FV only: none where the record's u32 +4 (`+0x860`) has bit 2;
  - the new `+0x1A4` (the setup word; set_mot_dat keeps bit 17) with bit 17
    blends out only;
  - VF2: a setup word (`+0x804`) with bit 18 or 19 blends in only. FV:
    bit 18 blends both ways, bit 19 in only;
  - else none if the word before (`+0xC30`) has bits 15 and 6 both, VF2's
    has bit 23, or the record's stance byte (`+0x814`: VF2 byte +6, FV byte
    +10) is 4;
  - a stance byte of 0x7F blends in only; so does a `+0x1A4` with any of
    `0x6600`, except that FV blends both ways where it has bit 26 first;
  - the rest blend both ways.
  Then: a motion of 2 frames or fewer never blends (`0x271DC`, Blend
  length). One with setup op 2 (`+0xA00`) whose first frame (`+0x808`)
  comes after the blend-out would start (`len - N`) does not blend out.
  The carry: a switch after a blend-out that ran to its end (`+0xBE5` bit 1,
  with the old mode's bit 1) does not blend in (`0x27218`). Last, unless the
  mode is out only (`0x27240` skips it), the turn set-up (VF2 `0x2756C`, FV
  `0x2A308`) cancels the blend, storing 0 again, when the word before and
  the new `+0x1A4` both have bit 10.
  A pass of a motion the game loops runs set-up again (`0x1ABE8`) on `+0x1A4`
  as the last frame left it, so there bits 17 and 10 are that frame's move
  flags. Checked against every store to `+0xBDD` in the attract mode, under
  a MAME watchpoint that logs the inputs as the store runs (VF2 and FV, 420
  seconds each): all 1153 VF2 and 1317 FV set-ups match, both bits, with 481
  and 601 blending out, 102 and 123 decided by the carry, 21 and 52 by the
  cancel and 75 and 96 loop passes. Another 292 and 221 were the fight's
  tests.

  | Switch (unmirrored) | Old code, frame 1 off the motion's own pose | Now |
  |---|---|---|
  | VF2 Akira 1285 → hit 251 (bit 17) | hands 0.46/0.31, feet 0.02 (frame 3: 0.34/0.22) | 0 |
  | FV Grace 224 → hit 306 (bit 17) | waist 8.8°, hands 0.18/0.24, feet 0.10 | 0 |
  | VF2 Akira 62 → 65 (bit 10) | hands 0.12/0.22, feet 0.05 | 0 |
  | FV Jane 156 → 155 (bit 10) | hands 0.27/0.48, feet 0.04 | 0 |

  Of the reactions, 42 of VF2's 63 and 35 of FV's 48 no longer blend in.
- **The blend-out** (`blendOutFor` in `js/vf2fighters.js`). A motion whose
  mode has bit 1 eases its last N frames (N its blend length) toward a
  stance pose. Per frame (VF2 `0x28298`, FV `0x2B004`), past `+0xBE0`
  (`len - N`) the first such frame calls the set-up (VF2 `0x2776C`, FV
  `0x2A53C`) and sets `+0xBE5` bit 0; frame `from + k` then adds k angle
  steps and k point steps, and bit 1 is set at k = N - 1 (the carry above).
  - The set-up samples the motion's last key (`0x28848`), mirrored when the
    fighter is.
  - The stance byte (`+0x814`) picks one of five poses: 0, 0x80, 3, 0x83, 4
    go to `+0x1E0`, `+0x2D0`, `+0x3C0`, `+0x4B0`, `+0x5A0`; any other byte
    clears the out bit. The poses are filled when the fighter loads (VF2
    `0x270D4`, FV `0x29EEC`): the first frame, unmirrored, of action table
    slots 0, 1, 8, 10, 31 (VF2) or 0, 1, 8, 12, 42 (FV) (`rig.blendOut`).
  - The stance pose is mirrored when the fighter is mirrored XOR the setup
    word has bit 21.
  - Where `+0x1A4` has bit 6 the pose is turned about the body by `+0x812`,
    and `+0x812` is added to the y angles of objects 2, 3 and 4. `+0x812`
    starts at 0x8000 for a word with bit 6, else 0; setup ops 5, 6 and 7
    set it from the int16 at op +8, +3 and +1; it is negated when mirrored
    (VF2 `0x1A3A4`); script op 22 sets it from op +3 and sets bit 6 (VF2
    `0x1B3D8`, FV `0x1C7AC`).
  - Angle step: `yxz(E(last)^T E(stance)) >> shift` per object; point step:
    `(stance - last) >> shift`, x and z measured from the body.
  Played alone, 814 of VF2's 1359 motions and 649 of FV's 1054 blend out.
  Checked against MAME's attract mode (per-frame taps on both players, 420
  seconds each): the steps of all VF2 97 and FV 80 blend-outs the attract
  ran match, angles and used points (an unused target holds garbage on the
  board and is skipped).

  | Motion → next (stance pose) | Old code, last frame off the stance | Now |
  |---|---|---|
  | VF2 Akira 71 → 1285 | hands 0.00/0.17 (0.02 more each frame from 13) | 0 |
  | VF2 Akira 71 → 1285, mirrored | hands 0.17/0.00 | 0 |
  | FV Grace 217 → 224 | waist 0.3°, hands 0.01/0.15 | waist 0, 0.05 all four (the body's own place offset) |

  Frame 1 of 1285 after 71 no longer blends in (the carry).
- **The blend's first frame is drawn as the fighter is.** Set-up samples the
  new motion's frame 1 into `0x50E000` with `0x28780`, which mirrors it when
  `+0` bit 6 is set (`0x28840`). The explorer took the residual from the
  unmirrored frame, so every switch of a mirrored fighter blended from the
  wrong side: Akira (VF2) looping stance 1285 mirrored was off by 0.34/0.35 at
  the hands and 0.39 at the feet on each pass's frame 1, Grace (FV) stance
  224 by 17.5° at the waist, 0.33/0.38 and 0.38. Both are now exact.
- **A turn-round switch.** Setup-word bit 20 (`+0x1A4`, kept by set_mot_dat;
  181 VF2 motions, 108 FV, throws among them, each authored facing
  the other way) turns the fighter round: op 0's tail (`0x1B444`; FV clears
  it at `0x1C950`) flips the facing (`+0x26`, `+0x61A`) by 0x8000. Set-up is
  called after `+0x1A4` is stored (`0x1A0C0`, `0x1A0C8`; FV `0x1B7CC`,
  `0x1B7D4`), and when the new `+0x1A4` has bit 20, or the word before
  (`+0xC30`, copied at `0x1A240`; FV `0x1B8FC`) has bit 6, it takes the turn
  path (`0x27384`-`0x27558`; FV `0x2A1C4`-`0x2A2F4`): objects 0-4 get no
  step (`0x27660`; FV `0x2A3FC`), and each old point's (x, z) about the body
  is turned by `E(new 4) (E(old 4) B(old 4))^-1`, the new body's angles
  (`0x50E030`) and the old as last drawn (`+0x140`, written at `0x285D4`;
  FV `0x2B214`), height kept, before the point steps are taken. The loop
  restart (`0xFFFF`, `0x1ABD8`) reloads neither word, so a looping motion
  turns on each pass only if the motion before its first had bit 6. The
  explorer blended these like any switch, so the body spun half a turn over
  the blend: Akira from stance 1285 into motion 16 was 157.5° off at the
  waist on frame 1 (hands 0.85/0.65, feet 0.75), 22.5° less each frame;
  Grace from stance 224 into 31, 148.7° (0.68/0.56, 0.71). Now the waist is
  exact and the points start 0.18/0.38, 0.03 and 0.08/0.18, 0.13 out, the
  arms' own blend. Throw pairs need no change of place: thrower and victim
  have bit 20 as 0/1, 1/0 or, for back throws, 0/0, which the shared place
  already gives.
- **Head** (`0x2922C`). With the face target in the chest frame as (d0, d1,
  d2): a target behind (d1 < 0) is brought to d1 = 0, and the old yaw is kept
  if it already faces that way within half a unit; yaw = -atan2(d1, d0),
  stepped by at most 0x800 a frame; pitch = atan2(d2, hypot(d0, d1)), stepped
  by 0x400 and held to +-0x2000 (`headStep`).
- **Twist** (`+0xBE6`, `0x2912C`): the chest turns about its spine toward the
  target, a = atan2(d2, d0); half of a up to 0x2000, 0x1000 up to 0x6000,
  stepped 0x100 a frame within 0..0x1000. It runs only when the move flags
  (`+0x1A4`) have no bit of 0x16000 and one of 0x20C, and it is off in the
  explorer (see When the chest twists, below).
- **Crouch** (`0x29414`, `+0xC50`): characters 6 and 10 draw their body at
  0.97 of its height, 8 at 0.92.
- **Hands** (`0x19E34`): the left hand is entry 0-31 of the table at `+0x67C`,
  the right entry 96-127 (`+0x180` on); Shun's right fist is model 0x546.

- **Opponent** (`0x2867C`, `poseBout`): the fight writes the other fighter's
  head over the face target (see the head's section under Animation). The
  head's place is the one the draw left at `+0x20C` (`0x168A0`, the head
  slot's translation), taken into this fighter's frame by its place (`+0x18`)
  and facing (`+0x26`): with d = head - place and c, s the facing's cosine
  and sine (0x8000 = half a turn), the target is (c dx + s dz, dy,
  -s dx + c dz). Player 1 is posed and drawn first, so it looks at player 2's
  head of the frame before, and player 2 at player 1's of this one. A round
  starts the fighters at x = -1 and +1 facing each other, so the explorer
  stands its opponent 2 ahead, turned half round: in the fighter's viewer
  frame the opponent's (x, y, z) is (2 - x, y, -z), and the target is the
  opponent's head as (2 - x, y, -z) read in the motions' (z, y, x) order. The
  opponent is a body of its own so it keeps its own playback: the same
  fighter on the same motion unless the panel picks another fighter, or a
  reaction for it to play (see The opponent's reaction below).

**When the game looks.** The store is `stt r12, 0xb0c(g7)` at `0x286A0`, after
op `0x31806363`. Four branches to `0x286A4` skip it:

- `0x28644`: `0x500034` is 6 or less (the round is not running).
- `0x28654`: `0x500034 & 0x3F0000` is not 0.
- `0x28664`: the fighter's status word `+0 & 0xA00000` is not 0.
- `0x28678`: the move flags `+0x1A4 & 0x6C111` are not 0.

The first three are not in a motion or move record the explorer reads.
`0x500034` is the round's state, and `+0` is the fighter's status. The fourth
is: `+0x1A4` is built while a move plays, from the motion's setup and script
(see "Which motions leave `+0x1A4` at `0x200`" below, which `moveFlags`
follows for both games): the move script interpreter at `0x1AD5C` (op table `0x1B910`,
stepped against the motion frame `+0x1AA`) has ops that set, clear and toggle
a `+0x1A4` bit named by the op's operand (`0x1AF90`, `0x1AFA8`, `0x1AFC0`).
Other move code changes bits too (`0x1ACB0`, `0x1B4C8`, `0x18184`), and
`0x3AC10` restores the word from a RAM snapshot (`0x535000`). Motion 361, for
one, runs with `+0x1A4 = 0x40061`, so Kage's head keeps the motion's own
target through it; `moveFlags` gives `0x40061` on all its frames too.

Fighting Vipers' gate (`0x2B274`-`0x2B310`) is the same with more tests: it
also skips on `0x50002C` bit 7, on `0x500034` below `0x80` and its own mask
`0x3B0000`, on `+0` bits 23 and 8, and its move flags mask is `0x6C119`
(bit 3 added). It sets `+0x7D7` only when it looks (see the Fighting Vipers
head below).

The explorer takes the move flags' part (`rig.look.gate`, `looksAtOther`):
on a frame where the motion's flags have a gate bit up, the opponent's head
is not fed and the head steps toward the motion's own target, at Fighting
Vipers' own-target speed there. The round and the status it takes as a fight
under way, the fighter on its feet. Before this it looked at the opponent on
every frame. Posed in `poseBout` with the opponent ahead, head against the
same motion posed alone (Node):

| Motion | Frame | Flags | Before | Now |
|---|---|---|---|---|
| VF2 Kage 361 (opponent Akira 1) | 9 | `0x40061`, gate closed | 144.805 degrees | 0.000 |
| FV Grace 19 (opponent Jane 1) | 10 | `0x25`, gate closed (bit 0) | 34.089 degrees | 0.000 |
| FV Grace 19 | 16 | `0x24`, open | 22.732 degrees | 10.432 |

On FV 19 the gate opens at frame 15, when op 2's third frame drops bit 0,
and the head starts turning from the motion's own target then, so it is
further from the opponent than before for some frames (frame 22: 21.358 both
ways). Residues of 0.01-0.04 degrees on closed frames are float rounding in
the angle.

**When the chest twists.** The check at `0x29130` reads `+0x1A4`; with a bit
of 0x16000 set or none of 0x20C, `0x2914C` stores 0 (`stis r11, 0xbe6(g7)` at
`0x29150`). `+0x1A4` starts from the move
record at `0x200D34C[id]` (`0x1A214`), and the record's set-up (op 2's frames,
phase machine `0x1AC14`) and script (`0x1AD5C`, ops 5-7) change it frame by
frame. That much is ROM, and a ROM-only gate built from it matches the board's
`+0x1A4` twist bits on every frame checked. It is still not drawn, because the
gate is not the only thing that keeps `+0xBE6` at 0. With the gate on, the code
sends the face target `+0xB0C` into the chest's frame (op `0x6A`) and takes
a = atan2 of it (op `0x27`), negated when the fighter is mirrored (`+0` bit 6).
Then, before the store at `0x29210` (`stis r11, 0xbe6(g7)`):

- `0x29198` `cmpibg 0, r11`: a < 0 sets the goal to 0;
- `0x291B0` `cmpibl 0x6000, r11`: a > 0x6000 skips the store, keeping the old
  twist (0 if it was 0);
- `0x291FC` `cmpible 0, r11`: a step down below 0 is held at 0.

All three test where `+0xB0C` lies, and `+0xB0C` is fight state: the fight
writes the other fighter's head over it at `0x286A0` when its own look gate
lets it (see When the game looks, above), and the step starts from last
frame's `+0xBE6`. With the motion's own target there, the explorer's gate-on
chest twists, so on these frames the board was aiming at the opponent. A second
attract capture, with the gate wired and nothing read from the board but motion,
frame and round-start places (chest):

| Frame | Motion | Board `+0x1A4` | Board `+0xBE6` | Gate | Without | With |
|---|---|---|---|---|---|---|
| 4650 | Shun 646, 26 | 0x200 | 0 | on | 0.005° | 6.559° |
| 4660 | Shun 646, 36 | 0x200 | 0 | on | 0.005° | 11.730° |
| 4670 | Shun 684, 4 | 0x2C | 0 | on | 0.003° | 8.317° |

Where the board did twist, the gate brought the chest from up to 20.181° to
0.009°, but a chest 12° off on frames that were right is worse. On these frames
the twist is held at 0 by `0x29198` or `0x291B0` (the capture does not say
which) on an angle to the fight-written `+0xB0C`, so the explorer leaves the
twist out.

Checked against MAME's attract mode: a tap on the geometrizer's read-start
register (`0x803008`) saved the display list each second, and each part's
object (its `oba` is the model's mesh pointer) gives the part's matrix as the
board drew it. The game's matrices are the explorer's transposed, with z
negated. Fitting each fighter's motions and frames to those matrices, Akira
(motion 1285), Jacky (1225), Lau (1226), Pai (1227) and Lion (185) come out
exact in all sixteen slots, hands included (the board draws hand models
numbered near the `+0x3C` table's, not the part list's): 0.0001 in place,
0.05 degrees in turn. So the euler order, the standard-rig solve and the step out along the
fighter's own skeleton are the game's.

The fight terms were checked against a second capture that saved the player
records with each display list. Posing from a record's own blend, held angles,
twist and head angles, all 656 fighter poses and every character match in all
sixteen slots, Shun's right hand included: at most 0.037 degrees in turn and
0.0002 in place (the solve's rounding times the bone length). The head rule
gives the board's angles to within 2 units in 7061 of 7192 frames, the twist
rule in 4219 of 4228.

The explorer's own playback was checked the same way: `poseFighter` given
only the motion id and frame of each captured frame, sampled from ROM, no
board state, over the 40 frames before each display list. On frames where
the fight made no blend choice and the face target is the motion's own, the
waist (pelvis) is exact for Akira (47 frames), Kage (15), Jeffry (36) and
Wolf (9), and the head is within 0.008 degrees and 0.00011 in place. So the
pelvis's 1 degree and the head's turn left from the first comparison are gone.
The opponent target was replayed the same way, both fighters posed in the
board's order at the board's places, each target computed from the explorer's
own pose of the other fighter. On every frame where the board's `+0xB0C` is
the other fighter's head, the computed target matches it to 0.00001 (Kage,
2916-2924). Whether the head looks at the other fighter at all is the fight's
gate; measured here before the explorer had its move-flag part:

| Face target fed, Kage frame 2940 (motion 361, frame 16) | Head |
|---|---|
| none (the motion's own, blended by the explorer) | 3.879 degrees |
| A: `poseBout`'s, on every frame | 21.214 degrees |
| A, only where the board's gate is on | 3.879 degrees |
| B: the board's `+0xB0C`, on every frame | 0.002 degrees |

At 2940 the target fed is A (0.21956, 1.13813, -0.33532) and B (0.11278,
1.22150, 0.00497). B is the motion's own target: the gate has been off since
2925, as motion 361 sets move flags 0x40001 in `+0x1A4`. A points at the
other fighter there, which the game does not. With the gate taken from the
board, A comes back to 3.879. The rest, between that and B, is the face
target's own blend. The board blends `+0xB0C` with everything else on a switch
it blends (Akira 3629-3632 move from the old target to the new), but the
fight started motion 361 at 2925 without a blend (`+0xBDD` bit 0 clear), so
`+0xB0C` jumps to the new motion's target. Fed on every frame, B carries that
choice in, so B honours the fight's no-blend through the target alone.

With the board's gate, the head is within 0.008 degrees (Akira's 18 frames
looking at the other fighter: 0.007), except where a fighter's own blend or
mirror choice throws the other's target off. Jeffry's 12.6 degrees at 2420 is
Wolf's mirrored switch, and Akira's 40 degrees at 3630 is Jacky's unblended
one. Without the gate, `poseBout` looked at the opponent on every frame, and
in attract mode the head was up to 134 degrees off where the game looks at the
motion's own target. It now has the move flags' part of the gate (When the
game looks, above); the round and status part is fight state, so the
explorer's opponent is still off by default. Across all sixteen slots, 470 of 539 replayed
frames match. The misses are the fight's blend choices above (since
modelled where they are the motion's: Which switches blend in).

#### The midriff and the low hips (record `+0x38`; read from the ROM, the hips checked against MAME)

Every VF2 record points at a struct from `+0x38` that has the same layout as
Fighting Vipers' midriff (record `+0x24`, see "The midriff" under Fighting
Vipers' fighters). VF2 uses it in the same way and a little more:

- `0x18FCC`, at the top of every draw, copies its word `+0` into slot 9's
  model (`+0x64`) and `+4` into slot 1's (`+0x44`). For all 26 records they
  are the part list's own, so nothing changes.
- `0x16F3C`, in `calc_unit_mat` right after slot 9's matrix, runs the same
  instructions as Fighting Vipers' `0x17A30`: invert the hips' matrix, take
  the chest's (slot 1) into it, carry the 16 ring points at `+0x70`, then
  write the `+0xD0` links (20 for every record) to polygon RAM.
- `rob_disp`'s slot 9 entry (`0x195F8`, from the jump table at `0x191D8`)
  draws it in geometrizer mode 3 with the model named by word `+8` (Akira's
  is 0x995), with the same player-2 colour offset as Fighting Vipers'
  `0x1A2D8`. There is no hit flash and no broken one. It is skipped only
  while `0x500068` bit 25 is set and the fighter's `+0x700` bit 5 is clear,
  the gate the replay's afterimage draws at `0x18F14` use too. The explorer
  draws it on every frame.
- `0x19090`, in the part loop: on slot 9, while the waist (`+0x1F8`, slot
  0's height) is under 0.2, or under 0.4 when move flag `+0x1A4` bit 15 is
  set, the model is word `+0xC` instead. Only Lau (0xAC6 → 0xF08, player 2
  0x2CC → 0xF07) and Shun (0xA2A → 0x1238, player 2 0xD69 → 0x1237) have a
  different word there. It is the robe lying flat, used while they are down
  or getting up.

**What the explorer draws.** The profile's `rig.fighters.midriff` (`at:
0x38`) builds the band with `readMidriff`, as for Fighting Vipers.
`rig.fighters.lowHips` gives `readLowHips` word `+0xC`, kept only where it
differs from slot 9's model, and `lowHipsModel` picks it from the posed slot
0 height (after the crouch) and the motion's move flags. Node, old code
against new:

- Midriff: old none for every record; now each of the 13 has one (8 chest
  points). In headless Chrome, Akira 180 frame 13 bends the chest far enough
  from the hips (the chest's ring moves 0.31 from rest) that the old picture has a hole in
  the belt at the bend, and the band now fills it.
- Low hips: Lau 175 frame 10 (waist 0.100) was 0xAC6 and is now 0xF08; Lau
  169 frame 20 (waist 0.303, flag 15) was 0xAC6 and is now 0xF08, and frame
  29 (0.606) stays 0xAC6; Shun 175 frame 10 was 0xA2A and is now 0x1238. Lau's
  stance 1226 (0.950) is unchanged.

MAME attract mode, a breakpoint at `0x190E8` on slot 9 logging the record,
`+0x1F8`, `+0x1A4` and the model: 11,595 Lau and Shun frames (878 low, 78 of
those between 0.2 and 0.4 with bit 15) all match the rule. The midriff's
geometry was not checked against MAME separately; its code is
instruction for instruction Fighting Vipers' one, which was.

#### Kage's and Pai's head piece (record `+0x40`; read from the ROM, checked against MAME)

VF2 only. The fighter's load (`0x13FF8`) reads the record's pointer `+0x40`
(a 0x20-byte struct). When its first word is not 0 it copies that model to
player `+0x704`, words +4, +8 and +0xC to `+0x758`, `+0x75C` and `+0x760`,
the vector at +0x10 to `+0x708` and the float at +0x1C to `+0x764`, sets
`+0x700` bit 0 and clears bit 1 and the byte `+0x714`; otherwise it clears
bit 0. Records with one:

| Record | Who | Model | Offset (`+0x708`) |
|---|---|---|---|
| 3 | Kage | 0x988 | (0.0227, 0, −0.176) |
| 6 | Pai | 0xA7A | (0, 0, −0.2117) |
| 19 | Pai, player 2 | 0x987 | (0, 0, −0.241) |

Kage's player 2 record (16) has a struct with model 0, so no piece.

rob_disp's part loop sends slot 2 (the head) to `0x19218` after the head's
own model. While `+0x700` bit 0 is set and `+0x714` is 0 (`0x19298`) it
translates by `+0x708` (`0x37806F6F`), turns about Z by 0x4000
(`0x37006E6E`) and about X by 0x4000 (`0x36006C6C`), or by 0x8000 when
`+0x1B0` is 6 (`0x192F8`; Pai's player 2 look, 19, takes the 0x4000), and
draws `+0x704` through `0x7C60`. Kage's is the studded band round his hood
and Pai's the ornament on her bun. Nothing in a motion touches these fields,
so every motion of either fighter shows it.

**What the explorer draws.** The profile's `rig.fighters.headPiece` gives
`readHeadPiece` the record field, the offset and the turns. It adds the piece
to the body's `extras` on slot 2, always shown, placed like the held item.
Node, old code against new, frame 1: Kage's start motion 990 had no extra
and now draws 0x988 at (0.301, 1.406, −0.083); Pai 1227 had none and now
draws 0xA7A at (0.135, 1.467, −0.086). The headless Chrome pictures show the
band on Kage's hood and the ornament on Pai's bun.

MAME attract mode, a breakpoint on the draw call (`0x193C8`) logging
`+0x1B0`, the model and `+0x708`, over 240 seconds: 462 draws of 0x988 on
Kage and 1040 of 0xA7A on Pai, with the offsets above, on their stances and
moves (Kage's 990 among them).

Left out, all of them fight state:

- The knock-off. Once `+0x700` bit 1 is set, `0x62FB8`, from a hit, steps
  `+0x714` through 1, 2, 3 as the piece flies (`+0x724`.., `+0x730`..,
  `+0x73C`..). With bit 3 as well (set at the load for `+0x1B1` = 3, Kage)
  it swaps the head model (`+0x48`) to 0xAD2, or 0xAC5 for record 16.

**Its reflection (drawn on stages 10 and 11).** An earlier note here had the
struct's +8 (`+0x75C`) as the piece's floor shadow and fight state. It is
neither. Straight after the piece (`0x193C8`), `0x193CC` tests the stage
flags (`0x6EEA0` bit 5, the Mirror floor's), then the head's point `+0x20C`
(slot 2's, read back as `+0x1F4` is slot 0's): y not below 0, and |x| and
|z| not past the ring (`0x50A00C`, 8) less 1. If it passes, it pushes, sends
`0x23804747` (op `0x47`, `Fn_mul_matrix_rev`: current = M · current) with
the twelve words at `0x501960`, and draws `+0x75C` through the window
`0x501834`. `0x1E52C` stores M each frame: push, invert (`0x6000C0C`), save
to inner 0 (`0x43`), pop; push, scale (1, −1, 1), times inner 0 (`0x45`),
read back (`0x05`) to `0x501960`, pop. So M = camera · S(1, −1, 1) ·
camera⁻¹, and the draw is the piece's matrix reflected through y = 0, the
same as the fighters' reflection (`0x20488`, below). The models are cut-down
copies of the piece, as the body's reflection models are of the body: Kage
0x988 → 0x260 (672 vertices → 282, same bounds), Pai 0xA7A → 0xD77 (240 →
96), Pai player 2 (record 19) 0x987 → 0x2FA (303 → 132). The knock-off's
routine (`0x634C0`) has the same test and draw for a flying piece.

The explorer reads the +8 with the piece (`headPiece.reflection`) and adds
its draw to the reflection's pool when the stage field names stage 10 or 11,
placed as the piece is and reflected as the body is. The head bound is
`reflection.piece` (ring 8, less 1). Node, on Kage's 990, Pai's 1227 and Pai
player 2's start motion, frame 1: 0x260 at (0.301, −1.406, 0.083) in the
board frame, 0xD77 at (0.135, −1.467, 0.086), 0x2FA at (0.143, −1.494,
0.090); with the head moved 7.5 along x or 5 down, none. Other stages and
fighters draw what they did. Read from the ROM, not checked against MAME:
the attract never reaches stage 10 or 11.

Fighting Vipers has no counterpart. Its slot 2 case (`0x1A12C`) draws only
Picky's hair, and its fighter load copies no such struct.

### The opponent's reaction (`js/reactions.js`)

When a move lands, the game picks the motion the one on the end of it plays,
and Virtua Fighter 2 and Fighting Vipers pick it the same way, at addresses of
their own (`rig.reactions`):

| | Virtua Fighter 2 | Fighting Vipers |
|---|---|---|
| set_mot_dat | `0x1A1E4` | `0x1B880` |
| setup scripts, head | `0x200D34C`, 8 bytes | `0x6411E94`, 12 bytes |
| op lengths (program ROM) | `0x1B7F6`, ops to `0x11` | `0x1CE86`, ops to `0x18` |
| strike's kind (op 4) | `+0xA` | `+7` (`sub_1BB20`) |
| reaction picker | `0x230D4` | `0x26978` |
| reaction table | `0x201CCFC`, 30 kinds | `0x641F834`, 22 kinds |

Three setup ops say how a motion hurts. Op 2's three u16s (`+1`, `+3`, `+5`)
go to `+0x808..+0x80C`, the frames the attack opens, closes and winds down on.
Op 4, the strike, writes a u16 to `+0x828`: the low byte is the kind of blow,
bit 15 the side it comes from. Op 5, the throw, writes its u16 at `+1` there
instead, and the throw code (VF2 `0x14570`, FV `0x13054`) finds it again
through calc_mht_adr and starts it on the one thrown with command `0x11`: the
throw motion and the thrown one's are neighbours in the table (FV 31 and 32,
VF2 15 and 16). Op 5's float at `+4` (`+0x824`) is the reach the throw catches
within (`0x16634` compares the gap `+0x5F4` against it), 1.2 to 2.7.

The pair are not left where the throw caught them. The thrower's action
`0x10` (FV `0x1570C`, VF2 `0x15F48`) steps it halfway to the other's place
every frame while move flag 1 is up, and once the flag drops at `+0x808` it
copies the other's place (`+0x18..+0x20`, `ldt`) and facing (`+0x26`). The
thrown one's action `0x11` (FV `0x157F0`) only starts its motion and stops
it. So both play on one place and facing, and the motions are made for it:
the thrown one's root starts where the throw holds it (VF2 16 starts 1.4
ahead, FV's thrower 31 1.79 ahead of its victim's 0.29). The explorer stands a
thrown opponent on the fighter's own place and facing (`opponentMatrix`,
`thrown`). Fighting Vipers has 394 strikes and 111 throws, Virtua
Fighter 2 569 and 112.

Sharing a facing is not all: the one thrown takes the thrower's mirror too.
Player `+0` bit 6 is not a half turn but a mirror: once a frame is sampled,
the pose code (VF2 `0x28AF4`, FV `0x2B778`, the same instructions) swaps
the left and right objects and reflects them (`mirrorSample` in
js/vf2fighters.js has the list). set_motion flips the bit when the motion
before ends with move flag 21 set (`0x1B65C`) or the new id has bit 15
(`0x1B66C`), and `0x184F0` (FV `0x18F14`) keeps `+0` bit 10 as bit 6 xor
flag 21 on every frame: the way the fighter will stand once its motion ends.
Each throw start writes the one thrown's bit 6 from the thrower's: bit 10
(VF2 `0x18C58`, FV `0x19C70`), or bit 6 xor flag 21 (VF2 `0x1461C`, FV
`0x130D4`). The victim command's bit 15 follows the throw id's, so the two
stay in step through their set_motions, and the thrown one's own flag 21 is
cleared first. So both are drawn on one facing and the same side. No throw
from a stance has flag 21 up when it catches (FV's seven that set it do
so from frame 40 on, for after the throw), so it is the thrower's mirror
alone: the explorer's "mirrored" switch mirrors the fighter, and with it a
thrown opponent. Any other opponent's bit is fight state, and stays clear.

The mirror stops at the sampled frame. The held angles (setup `0x26FAC`
latches the type-1 float objects into the `0x29724` entries, `+0x140` on)
are read raw by the aim code at `0x29118`, which has no bit-6 test, so a
mirrored fighter holds its chest, head and pelvis as the motion gives them,
as `heldAngles` does. Only the chest twist `+0xBE6` is negated under the
mirror (`0x29188`, `0x291C4`, `0x29204`), and the explorer has no twist.
The face target (`+0xB0C`, written at `0x28600`, the opponent's head at
`0x286A0`) is not mirrored either. The part models keep their slots: each
pair of left and right parts is a mirror image across the part's own
sideways axis (x for objects 0, 12 and 15, y for 2, z for the rest), checked
to 0.001 for Akira, Jacky, Sarah, Kage, Jane, Grace, Honey and Tokio, save
Jane's forearms (4 and 7, 0.17 and 0.28 apart) and Sarah's and Honey's feet
(0.03). The swapped, reflected matrices equal the unmirrored ones reflected
(diag(1, 1, -1)) exactly, so the mirrored fighter is the unmirrored one in a
mirror; the one thing a side changes is which hand a shape goes to (below).

coli_attack_chk (FV `0x25AA4`) lets a strike land from frame `+0x808` on,
and only while move flag 8 (`+0x1A4`) is set, which 0x1C180 clears at the
second frame. The explorer plays the reaction from the first such frame
(`moveFlags`), else from `+0x808`. VF2's strike check (`0x222A8`) has the
same rule, bit 8 set and bit 1 clear. With VF2's flags stepped too, none of
its 569 strikes lands on another frame than `+0x808`'s. A throw's motion starts with the throw.

`table[kind]` is forty u32s, five categories of eight. The category is
attack_hit's callers' `r8`: 0 and 1 the guards, 2 the hit, 3 the counter hit
(the path with the "counter" string), 4 the knock-down, which writes command
`0xC000000` where the others write `0xF000000`. Within one, the index adds 4
if the one hit crouches (`+0x1A4` bit 3), 2 unless it faces the attacker, and
the blow's side. The low 13 bits are the motion; bit 15 turns the fighter
round. Fighting Vipers' kind 0 reads guard `0xFA`/`0xF9`, hit
`0x134`/`0x136`, counter `0x135`/`0x137` and knock-down `0x24D`.

The explorer's opponent stands and faces the fighter, so it takes the
standing, facing entries. Left out as fight state: the side's other terms
(both players' `+0` words and the defender's `+0x1A4` bit 21), Virtua Fighter
2's program-ROM table at `0x23D98` for a defender with bit 25 set, Fighting
Vipers' `0x26A04`, which swaps `0x24D` for `0x250` when the defender's waist
is low, and the category 5 entry the pickers index at `0x28`.

While it waits for the blow, the opponent plays its stance, slot 0 of its
action table (record `+0x14` in both games: VF2's action_init puts it at
player `+0x1A0` at `0x13F1C`, 84 ids, as FV's does with 55).

### The hands (`js/fighterhands.js`)

Both games shape a fighter's hands from the move script: op 18 is seven
bytes, `[18, frame u16, hand, shape, end u16]`, run once the motion frame
(`+0x1AA`) reaches its frame. The script follows the setup ops (op 0 ends
the setup on itself, op 8 just past it); its op lengths are `rig.script`
(VF2 interpreter `0x1AD5C`, table `0x1B910`; FV `0x1C24C`, `0x1D028`).
Virtua Fighter 2 has op 18 in 390 of 1359 motions (shapes 0, 3, 7, 9, 15,
23, 31), Fighting Vipers in 383 of 1054 (shapes 0-2).

Virtua Fighter 2 eases (`0x1B2F4`). Each hand has six bytes, `+0x6C4` hand 0
and `+0x6CA` hand 1: count, target, the shape as 8.8, step. With n = end -
frame > 0 the op sets n + 1 steps of trunc(((shape << 8) - now) / (n + 1));
otherwise it sets the shape outright with one step left, keeping the old
step. `0x1B4E8` then steps every hand with steps left, in the same frame.
Its `be` at `0x1B500` compares against a literal 0 and never branches, so
an ease ends short (23 to 31 lands on 30) and an outright set still adds the
stale step; the explorer does the same. When record `+0x3C` (player
`+0x67C`, `0x13FF4`) is set, the draw (`0x1907C`) asks `0x19E34` for slots
5 and 8: slot `r5` (5, or 8 when mirrored) takes hand 1's shape (`+0x6CD`)
and the other hand 0's (`+0x6C7`), & 31, as an index into its table, slot
5's at `+0`, slot 8's at `+0x180`.

Fighting Vipers sets the model outright (`0x1C718`): `0x640EBF4[record]`
holds four s16 models per hand, hand * 4 + shape, and the op writes it over
the part list's (`+0x40`) slot 5 + 3 * hand, unless it is 0. A mirrored
fighter's hand is turned first (1 to 0, else 1). Shape 0 is the part list's
own model. FV keeps the eased picker (`0x1AC80`), but the `+0x6AC` that
turns it on is record `+0x28` (action_init, `0x12624`), 0 in all thirteen
records.

So the mirror moves shapes, not models: each slot keeps its own table, and
the two tables are mirror images (every pair checked). Most motions shape
both hands alike; VF2 Akira 3, 5, 25 or FV Grace 579, 776 do not, and show
the swap. The throws (VF2 15, FV 31 and 33) shape them alike.

A hand keeps its shape from one motion into the next. MAME watchpoints on
both fighters' hand bytes over a 100-second attract run catch no writer but
op 18 (VF2 `0x1B32C`-`0x1B360`, FV `0x1C760`) and VF2's step (`0x1B500`,
`0x1B514`), and FV's round start (`0x12554`, the part list copied to
`+0x40`; VF2's `0x13F08` copies it too, but never touches `+0x6C4`). A
motion's setup resets nothing, and the game copies no hand state from the
thrower to the one thrown. So:

- VF2's hands start at power on as shape 0 (count, step 0) and are never
  reset after; a step under way carries on into the next motion. Its draw
  takes slots 5 and 8 from the table whenever `+0x3C` is set, so the part
  list's hand models never show (Dural has no table and keeps them).
- FV's hands start each round as the part list has them, which is shape 0.

What a fighter played before a motion is fight history the explorer cannot
know, so a motion with nothing live before it starts on the game's cold
hands: VF2 shape 0, FV the part list's. Only a motion on screen carries
over. The opponent waits in its stance (itself started cold) until the move
lands, and its reaction starts from the stance frame shown then, mid-ease
if it was; a reaction with no stance shown first starts cold. VF2 Akira 4
shows the difference from starting on the first shape named: its op 18s
are at frame 20, so frames 1-20 hold shape 0 (it used to show 3 from frame
1), and the hands ease to 2 by frame 30 (one short of 3). In FV, Grace 302
holds the part list's hands to frame 9, where they used to be shape 2 from
frame 1.

No other op touches a hand. Every handler in both tables (VF2's 24, FV's
31) was read: none but op 18 writes the hand bytes or slots 5 and 8, and the
rest of what bears on a hand is this.

- **Loops.** When a motion runs past its last frame (VF2 `0x1AB74`, FV
  `0x1C114`) the game reads `+0x802`, which set_mot_dat clears and setup op
  1's u16 sets (FV's op 0x13 too): 0 holds the last frame, a motion id
  starts that motion, and 0xFFFF plays this one again, the frame back to 1
  and the script back to its start (`+0x6D0`, FV `+0x700`; VF2 `0x1ABD8`, FV
  `0x1C160`). The hands are left as the pass ended. The explorer plays every
  motion over and over, so a motion the game loops now starts each pass
  after the first from the hands the last one ended on (`playedOver` counts
  the passes, and the opponent's stance and the stance frame it is caught on
  count their own); any other motion starts each pass as before, since the
  game never plays it twice running. In VF2, 34 motions loop, and on Akira
  16 of them show it, its stance (1285) among them: it eases to 31 from
  frame 1 and back to 15 from frame 80, so from the second pass it sets out
  from 15, not 0, and frame 10 is shape 19 (it was 7), frame 30 shape 26 (it
  was 23). The bytes never quite settle (a truncated step leaves a few
  1/256ths a pass), so every pass is worked out from the one before. An
  Akira caught on stance frame 11 carries shape 19 into the throw on the
  second pass, 8 on the first. FV's 15 looping motions with an op 18 all set
  both hands outright on frame 1, so a loop never shows there: no FV motion
  differs.
- **Op 23** (both games) tests `+0x5B8` bit 0 against its byte and, when
  they match, sets `+0x60C` to 31 and `+0x852`/`+0x853` from the op and
  returns from the script, past VF2's hand step (`0x1B438` to `0x1B530`), so
  no hand steps that frame. It is fight state, and it is in no motion with
  an op 18 (VF2 has it in 28 motions, FV in none).
- **Slow motion.** VF2 doubles every op's frame when `0x500068` bit 20 is
  set (`0x1AD80`; op 3 halves its speed under the same bit), but not op 18's
  end, so an ease would run short there. The explorer has no such state.
- **The draw.** VF2's slots 5 and 8 come from the table whenever `+0x67C` is
  set, which only action_init writes; the other swaps in the part loop are
  slots 12 and 15 (`+0x5F0`, `0x19D28`) and 3 and 6 (`0x19E6C`), not hands.
  The per-part bytes (`+0x688`, FV `+0x6B8`) are a visibility test of each
  part's place, not a hand state.
- **FV armour.** The per-frame part refresh (`0x27528`, `0x27650`) rebuilds
  every slot from the part list and the broken-armour bits except 2, 5 and 8,
  so it leaves the hands to op 18. A hit's armour break (`0x2D588`) does
  write a slot itself, and Jane's armour table (`0x640EDAC`) has slot 5: it
  gets model 0x2DE, the one all her op 18s write there. A break is fight
  state the explorer does not model.

### The face (`js/fighterhands.js`)

The head (slot 2, `+0x48`) changes with the move script too: op 16 swaps
its model, for an expression (eyes shut on a hit, a talking mouth in a win
pose). Its byte 3 picks a row of a table by fighter. The explorer used to
draw the part list's head on every frame. Now `handModels` gives slot 2
alongside 5 and 8. The face carries from one motion into the next, and over
a loop's passes, the same way the hands do.

- **Fighting Vipers** (`0x2DDB0`) writes the model outright:
  `0x640D31C[op][record]` points at two s16 models. The game takes the
  second once the helmet is off (`+0x1F48` bit 2: `bbc 2` on `ldos
  0x1F48(g7)`, then `ldis (g0)[r4*2]`) and the first otherwise. Only a hit's
  armour break (`0x2D588`) sets that bit, and the explorer's Armour switch is
  that break: with the upper half broken, a fighter whose slot 2 has a break
  entry has the bit (`helmetOff` from `armouredFighter`, the same test as
  Picky's hair), and op 16 reads the second column. Eight fighters differ
  there. In rows 0-6 and 9: Grace 194/192, Honey 2553/2551, Bahn 687/31,
  Picky 895/892, Raxel 1536/699, Sanman 1062/1059, Mahler 1497/3887, B.M.
  3589/3588; row 8 is each one's next model (Honey's 2552, Picky's 893,
  Raxel's 700, Sanman's 1060). Before, the stance's frame-1 op put Bahn's,
  Mahler's and B.M.'s helmets back on over the broken head. Jane, Tokio and
  Sonic break no helmet and keep the first column. Checked in MAME
  (`fvipers`, attract, 150 s, bit 2 ORed into `+0x1F48` at `0x2DDB0`, the
  store logged at `0x2DDD8`): 240 stores, each the second column of the
  fighter's row, Grace 192, Honey 2551/2552, Bahn 31, Picky 892, Raxel 699,
  Sanman 1059, Tokio 3017, Jane 488/489. Mahler and B.M. did not come up in
  attract. Before any op the slot holds the round start's model, the part
  list's. Nothing else
  writes `+0x48` but replay save and restore (`0x3C5E8`, `0x3C94C`). The
  per-frame part refresh skips slot 2, and the face step (`0x4AF18`) works out
  a model but never stores it. Op 16 is in 285 motions. Every stance
  starts with row 0 on frame 1, and win and intro poses use row 7 (the
  part list's head). Jane's stance 904 frame 1 shows 488 (shut eyes, the
  same mesh as 489 with other UVs); it used to show the part list's 712.
- **Virtua Fighter 2** (`0x1B2B0`) starts a chain:
  `0x4B604(0x2006278[op][char])` loads a record (u16 +0 frames, s16 +4 the
  value aimed at, u32 +8 the model picker, +0x10 the next record; null
  changes nothing) and leaves the current value (`+0x6A8`) as it was. The
  face step `0x4B640`, run at `0x14408` after the frame counter and script,
  counts the frames down by one and moves the value a truncated
  1/frames-left of the way to the aim (all of it on the last frame). The
  picker (u16 +2 steps, +4 a table of 16-byte entries, +8 a byte per step)
  then gives entry `value × steps / 1001`, whose first word goes in `+0x48`.
  At a record's end the next one loads, and a chain whose frames are 0
  leaves the model alone. action_init (`0x4B5D0`) zeroes the value and loads
  the fighter's own chain (`0x20062A0[char]`): one frame at 0, the part
  list's head. Akira's hit 251 has op 16 row 8 on frame 1 (six frames to
  1000: 412, 680, 680, 681, 681, 681) and row 9 on frame 7 (15 frames back
  to 0, so 412 again by frame 20). It used to show 412 throughout. Dural
  has no tables, so the head never changes.
- **VF2's player 2 face.** An entry of the picker is four words, and
  `0x4B74C` takes the second (`addo 4`) while `+0x1B0` is not `+0x1B1`: the
  record player 2 wears when both pick the same fighter (13 on) against the
  fighter. With **P2 colours** on, the explorer reads that word. Only Sarah,
  Kage and Jeffry's pickers have a second word unlike the first: Sarah's
  stance head is 0x90C rather than 0x1DB, Kage's 0x8DC rather than 0x35, and
  Jeffry's 0x8CC rather than 0x25, with their eyes and mouths alongside
  (Sarah's 0xE84/0xE85 for 0xC38/0xC39, Kage's 0xAFA/0xAFB for
  0xAFE/0xAFF). Before, the face step put player 1's head back on the P2
  record from the first frame (Sarah P2's 1269 drew 0x1DB, her own part
  list says 0x90C). Checked in MAME (`vf2`, attract, both players' `+0x1B0`
  set to `+0x1B1` + 13 from frame 600, a breakpoint at the store `0x4B76C`
  for 150 s): 0x90C, 0xE84 and 0xE85 on Sarah's record 15, 0x8DC, 0xAFA
  and 0xAFB on Kage's 16, 0x8CC on Jeffry's 18, and every other fighter's
  the same models as before the write.
- **VF2's voice** (op 9, `0x1B05C`) runs only on its own frame. It names a
  voice by `0x201E44C[op][char]` (0: nothing). If it does, it sets the voice's
  time left (`+0x770`) to `0x201E498[op][char]`. That counts down by 1 at
  each frame's start (`0x14358`) and stops at 0. When it reads 25, the
  face step loads row 2's chain (the talking mouth) unless row 1's is the
  one running. Both are in the motion, so this is modelled. The op is
  skipped while the sound sequencer waits (`0x504070`), which is taken as
  never.

Left out: the record's second value and its picker's id, which only time
sound requests (`0x4B7B0`, `0x4B7E8`); the picker's +8 column, taken
under `+0x700` bit 4 (Kage's 0xAD2), which the fighter's load clears
(`0x1408C`) and no motion sets; the game-mode tests at the top of
`0x4B640` (attract and the ending scenes); and the scene resets
(`0x4B5B0`), which are not motions.

### The held item (`js/fighterhands.js`, `js/vf2fighters.js`)

VF2 only: Shun's gourd. Script op 17 (`0x1B2D0`) runs only on its own
frame (`cmpobne`: `+0x1AA` must equal the op's frame, not just pass it). It
sets player `+0` bit 27 when its byte is 1 and clears it otherwise. The
fighter's load (`0x14098`) clears the bit, and nothing else in a motion
touches it, so it carries into the next motion like the hands do. The
explorer's cold start has it clear.

While the bit is set, rob_disp's part loop (jump table `0x191D8`, after the
slot's own model at `0x1918C`) draws one more model:

- slot 8 (`0x19530`) when not mirrored, z = +0.03;
- slot 5 (`0x19544`) when mirrored (`+0` bit 6), z = −0.03.

Both go on to `0x19554`: translate (0.15, 0.01, z) (`0x37806F6F`), turn
about Z by `0x9DF0` (`0x37006E6E`), then draw model `0x98A` (116 faces,
the gourd) through `0x7C60`. The explorer draws the extra only on frames
where the bit is set.

Motions with op 17: 172 (on at 90, off at 144); 666, 667, 1045 and
1205–1208 (on at 1); 1172 and 1202 (on at 14, off at 45). Any VF2 motion
plays on any fighter, so all of them can be opened. Shun 666 frame 1 shows
the gourd in his hand, and 172 shows it from frame 90 to 143. Before this,
the explorer drew no gourd at all.

FV's op 17 (`0x1C6E4`) is not the gourd, and it does draw. It picks the
item record (`+0x784`, from fighter record `+0x2C`) that `rob_disp`
(`0x1A4B4`) draws on every slot's turn of the part loop. That is Picky's
board, Raxel's guitar and Bahn's hat: see "The carried item" below. The
gourd does not take part in it, and FV has no gourd.

Left out: op 14's camera shake (`[0x500814]+0xFC`, the camera, not the
fighter) and ops 20/21, the command VM's pointer and counter (input).

### The rest of the move script and the setup ops

Every op of the motion's script and setup has now been read for what it
writes. None of the rest changes a pose, a model or a light on a motion the
explorer can open. Counted over every motion (VF2 1359, FV 1054):

- Script op 2 (VF2 `0x1ADAC`, 33 motions; FV `0x1C28C`, 4) writes request
  `0x0D000000` to `+0x198` and 0 to the timer `+0x5DE`. That is the down
  state (handler `0x157DC`), whose next motion the stick and the timer pick.
- VF2 op 15 (`0x1B290`, 4) adds one to `+0x69C`, at most 8: a damage scale
  (`+0x822`) and an AI test (`0x1CE28`). VF2 op 19 (`0x1B368`, 14) sets the
  timer `+0x5DE`, doubled when `0x500068` has bit 20.
- Setup ops 3, 9 and 11-14 fill in the hit's data: reach, the launch speed
  (`+0x5CC`, `+0x81C`), the damage and its scaling by distance (`+0x822`),
  the knock direction (`+0x844`). The state handlers that read them run on
  the one hit. Op 10's windows (`+0x838`) and ops 15, 17 and 22 (read later
  through `calc_mht_adr`, VF2 `0x1AB34`, FV `0x1C0BC`) wait on input or a
  throw.
- FV setup op 18 (`+0x864`/`+0x868`/`+0x878`) sets `+0` bit 14 when the
  opponent is within a range. Op 21 scales the damage by `+0xA20`. Op 23
  (`+0x87A`) is a late-input window (`0x1D634`). Op 0x13's second motion is
  taken only once a button has been held `+0x86E` frames (`+0xA1C`,
  `0x1D4A4`).
- FV setup op 20 (motion 733 only): at the bit-20 turn the facing is set to
  `+0x616`, the direction of the opponent, in place of a half turn
  (`0x1C964`). That depends on where the opponent stands, which is fight
  state.
- FV setup op 24 (motion 990, the one 989 throws) moves the catch point in
  throw kind `0x26` (`0x15C1C`). That handler steers the one thrown toward
  the thrower by 0.6 of the gap a frame while `+0x1A4` bit 1 is up. Kind
  `0x26` is the throw of a fighter in the air (`+0` bit 2), and the gap is
  wherever the fight left them. Once caught, the pair share one place, as
  the explorer draws them.

### The fighters' shadows (`js/fightershadow.js`)

Both games lay a flat model under each part of a fighter, slid along the
stage's light onto the floor. Each frame the game sends the coprocessor the
light's elevation a0 and azimuth a1 (VF2 `0x61684`, FV `0x5FA7C`,
`Fn_kage_mat`), and it builds three matrices, with r = a1 ^ 0x8000 and g the
ground's height (`0x50A010`):

- `inner[0]` = Ry(r) S(1, 0, 1) Rx(a0 − 0x4000) Ry(−r), the flattening;
- `inner[1]` = Ry(r) S(1, 1, 1/sin a0) Ry(−r), for parts over the ring;
- `inner[2]`, the same moved by Ry(r)·(0, g, −g cot a0), for parts below it.

`Fn_kage_flag` (VF2 `0x61A14`, FV `0x6027C`) slides one test ball per slot
along the light onto y = 0 (by kx = −sin(a1 + 0x8000) cot a0, kz =
cos(a1 + 0x8000) cot a0) and sorts the slots into two masks: near if the
ball is at or above the floor and not past the ring less 0.3, else far if
not inside the ring plus 0.2; bit 0 takes bit 9's answer. The draw (VF2
`0x61BA0`, FV `0x60640`) walks the fighter's table, 15 entries of 24 bytes
(slot, model, flags, offset), and for each slot in a mask draws the model
on inner[0] · the slot's matrix, moved by the offset when flag bit 2 is
set, one axis laid flat, then inner[1] (near) or inner[2] (far).

| | VF2 | FV |
|---|---|---|
| tables | `0x61CFC`, by `+0x1B1` mod 13 | u32 `[0x60BC8 + 4·+0x1B0]`, 26 (player 2's look 13 on) |
| test ball | the middle of the slot's list (`0x2007BEE`) | the first; the boot (`0x1950`) copies them to `0x506000`/`0x506200`; slot 0 has no list and uses slot 9's |
| light | stage record `0x6EE38` + 256·stage, `+0x70`/`+0x72` | VECTER_X/Y, record `0x6CE1048` + 256·stage, `+0x08`/`+0x0A` (`0x5FA08`) |
| ring | 8 by default (`0x50A00C`) | 5 (`0xB658`) |
| ground | −0.5 | by stage, f32 `0x6CE3564` (`0x248FC`): −0.2, 0.3, 0, −0.01, … |
| laid flat | bit 0 the x, else the z | bit 1 the z, else bit 0 the x, else neither (`kage_poly`) |

FV adds, all read from its own tables:

- The stage flags u32 `[0x6442BA8 + 12·stage]`: bit 8 takes the mirror
  path and draws no shadows; bit 31 waits on the fight's event bits
  (`0x574004` & 15), clear at every round's start, so Bay Side (stage 5)
  draws none.
- A round test on the stages whose byte `[0x60B98 + stage]` is set (0 and
  4): the distance is 0.70710677 · hypot.
- Slot 9 is skipped while the move flags (`+0x1A4`) have bits 14 and 16
  (`0x60690`).
- The shadow cards (models 0xE4 to 0xF2) name palette entry 247, which
  the stage setup (`0x21664`) fills from the stage record's u16 at +0x16:
  black on all sixteen stages, and black in MAME's palette RAM. The
  table's own colour there, 0x9970, drew them brown.
- The Factory (stage 1, `[0x5FA6C + stage]`) is lit by four lamps
  (`0x60468`) at (±1, 0), (0, ±1) × the ring (`0x60620`). The one nearest
  slot 0 (`+0x1F4`) in plan wins, the last on a tie; a1 = 0x8000 − its
  bearing, a0 = atan2(h, max(ring + 1 − d, 0)) with h = f32
  `[0x6CE35A4 + 4·stage]`. Its margins are 0.2 wider, and only the near
  draw is made: the far one waits on `+0xA29`, fight state.

Checked against MAME by dumping the coprocessor's display list and fitting
each slot's matrix from the part draws (camera = the stage floor model's
matrix): VF2 attract frame 4900, 4.2e-7 at most; FV attract frames 3600
(Factory, lamps, player 2's slot 9 skipped), 4800, 5400, 6000 and 6600
(a part-mask frame), 29 to 30 shadows each, 2.4e-5 at most. A control with
a1 one step of 0x100 off misses by 3.5. FV frame 4200 misses by 1.7e-3:
player 2 is in the air at the wall, where `+0x1F4` lags slot 0 by 0.025.

Before, the explorer drew no fighter shadows in either game. Now, e.g.:
VF2 Akira 1285 frame 1 on stage 1, 15 shadows (0x15B at 1.867, 0, 0.287);
FV Grace 3 frame 1 on stage 0, light 0xD000/0xF400, ground −0.2, 15 shadows
(0xE8 at 0.554, 0, 0.315).

Left out:

- the masks are refreshed only on alternate frames per player
  (`[0x500020]` parity); the explorer refreshes every frame;
- FV's `name_char_kage_disp` (`+0x2A`) and the extra entry at table + 360,
  both fight state;
- FV's flying armour pieces' shadows on the light (`0x608B8`, `0x609B0`,
  from `0x60350`) are drawn, as is the Factory's and Bay Side's own floor
  copy: both under "The pieces' floor shadows";
- stages whose light turns take the record's start (the round's first frame).

### Fighting Vipers' wall shadows (`js/fvwallshadow.js`)

On Bay Side (stage 5) FV also lays each fighter's shadow on the ring's walls:
`rob_kabe_kage_disp` (`0x76944`), which `camera_control` calls for each player
just before `rob_disp`. It runs on a stage whose flags u32
`[0x6442BA8 + 12·stage]` have bit 31; with bit 7 it also needs the fight's
event bits (`0x574004` & 15) clear. Stage 5's flags are `0x8000028F`.

`rob_kabe_set_matrix` (`0x76A98`) builds two walls from slot 0's point x, z
(`+0x1F4`), the ring D (`0x50A00C`, 5; record `+4` with flag bit 5) and the
light's angle a, which is the camera's yaw (`+0x26`; record `+8` with bit 4),
with 0x4000/0xC000 nudged by one. No wall is built while |x| or |z| ≥ D.

- The z wall is at Zw = ±D, negative when a's bits 15 and 14 differ:
  - `inner[6]` = T(−x cos(−a) + z sin(−a), 0, 0)·Ry(−a);
  - `inner[7]` = T(X0, −0.08, Zw)·S(1.7·kz, 1.7, 0), with
    X0 = x − zs·tan a·(D − zs·z) and kz = min(1/cos a, 3).
- The x wall is at Xw = ±D, negative when bit 15 is clear:
  - `inner[4]` = T(0, 0, −x sin b − z cos b)·Ry(b), with b = 0xC000 − a;
  - `inner[5]` = T(Xw, −0.08, Z0)·S(0, 1.7, 1.7·kx), with
    Z0 = z − xs·cot a·(D − xs·x) and kx = min(1/sin(a + 0x8000), 3).
- A cosine (sine) of 0 builds no z (x) wall. The 1.7 comes from
  `0x50A3D0`, set at boot (`0x7690`).

`0x77AF8` draws the z wall, then the x wall, each on the fighter's 15
entries of 28 bytes (slot, six models). The tables are
u32 `[0x6442C68 + 4·+0x1B0]`. For each entry, p = upper·lower·slot matrix:

- An entry is skipped when p.y is above the stage's top (f32
  `[0x6CE35A4 + 4·stage]`, 3.1 on Bay Side) plus the slot's own (f32
  `0x6443EDC`; slot 2 −0.1, the rest 0).
- The z wall takes only a p within D + 0.1 of the ring's middle on both axes.
  The x wall takes only the slots the z wall did not.
- p is stored at `0x50F600` by slot. A wall draws nothing while the camera
  (`+0x18`/`+0x20`) is beyond it.
- The model is chosen in this order:
  - slot 9 with p.y ≤ 0.2: `+0x18`;
  - slots 15/12: 0xBB8/0xBB9, unless move flag 14 or 4 is set;
  - a broken slot (`+0x1F48`): `+0x10`;
  - otherwise `+4`, or with the item in hand (`+0` bit 27) `+8`, mirrored
    too (`+0` bit 6) `+0xC`.
- The carried item, while it isn't in hand, goes on the first wall that
  takes its matrix (the ring entry `rob_disp` left the frame before), as entry
  `[+0x788]`'s `+0x14`, if that wall drew its slot.

`0x7860C` then lays model 0xAB6, a flat strip, under each slot 1..15 lower
than 0.24 (the feet; `cmpr 0.24, y` / `ble` skips the rest): T(x, 0, z)·Ry(bearing to the stored wall point + 0x8000)·
S(0.4, 0, 1.15·distance).

The explorer runs all of this on the pose it already has. It uses the explorer
camera's yaw and place in the board frame as the fight camera's, and runs
again when the camera moves. Its fighters stand inside the ring and the
Animation tab has no event bits, so on stage 5 the wall copy shows whenever
the fighter does. In the game, the camera bits and the event-bit test are
fight state.

Now, e.g. Grace motion 1 frame 1 on stage 5, camera yaw 0x8000: 15 wall
draws on the z wall at z = −5 (0xBBC at 0.403, 2.103) and 2 floor streaks
(the feet). On stage 0 there are none.

Checked against MAME (the shared build, attract Bay Side, frames 16535 to
16715, both players, 362 passes) with breakpoints after the set-up, on each
projected point, each draw and each streak:

- The set-up's stored values (X0 `0x50A3EC`, Z0 `0x50A3F4`, kz `0x50A3E8`,
  kx `0x50A3F0`) agree to 1.3e-3 relative at most, the worst near a = 0x4000,
  where X0 runs into the hundreds. Both walls' sides agree in every pass.
- Every projected point of 317 passes agrees to 1e-4. In the other 45 the
  logged slot points (`+0x1F4`) lag the matrices the coprocessor projected
  (by up to 0.106), as in the floor shadows' frame 4200; in 27 of them every
  slot is off by the same height, and the stored set-up still agrees.
- Which slots each wall takes and draws, and the model of all 5044 draws
  (0xBB8/0xBB9 included), match in every pass. The streaks' slots match in
  every pass, and their length matches 1.15 × the logged distance to 4e-7.
- Not covered by the window: the camera beyond a wall (every wall drew), the
  item draw, broken or mirrored models, the item in hand, and the streak's
  angle (the breakpoint read it after it was overwritten).

Left out:

- the event bits (`0x574004`) and the fight camera, which are fight state;
- a fighter thrown outside the ring, which the explorer never poses.

### Fighting Vipers' fighters (`js/vf2fighters.js`)

Fighting Vipers poses its fighters the way Virtua Fighter 2 does, and the
explorer runs them through the same code on the profile's own addresses.
Walking both call trees side by side with the disassembler, the pose routine
`calc_rob_angle` (`0x2AA84`) is VF2's `0x27CE0` instruction for instruction
once the addresses are normalised out, `calc_unit_1` (`0x2BBE0`) is its
`0x2901C`, and `calc_unit_mat` (`0x17160`) its draw placement, stepping each
part out along the fighter's own skeleton at player `+0x8C`.

- **Records**: `ld 0x640D2B0[char*4]` in `action_init` (`0x1243C`): the parts
  at `+0`, the skeleton at `+4` (as VF2), the texture set at `+0x20` (VF2:
  `+0x30`).
- **Motions**: `offset_list_motions` is `ld 0x6C00004[g0*4]` (`set_mot_dat`,
  `calc_rob_angle_int`, `get_kamae_value`), in the second data bank, the
  XTRA window's high half. Entry 0 points at the table's end, 1055 entries
  on. The blocks are in both the data ROM and that bank, so `js/motion.js`
  now resolves every address through the profile's XTRA banks and reads a
  block through the view of the region it is in. 1052 of the 1054 hold the
  pelvis at a latched angle, as VF2's do.
- **Standard rig**: `lda 0x2C194, g6` before op `0x6B`.
- **Roster**: the profile cards in the data ROM at `0x3023A1C` run JANE, GRACE,
  HONEY, TOKIO, BAHN, PICKY, RAXEL, SANMAN, MAHLER, B.M., then SONIC & TAILS.
  The records' `+0x1C` (72, 55, 40, 69, 85, 48, 54, 120, 95, 95) runs with the
  cards' weights, `pky_kami_disp` (Picky's hair) is drawn for character 5,
  Mahler and B.M. share texture set 17, and each record drawn on its own sets
  is the fighter the card names. 10 is Sonic. 11 and 12 are untextured
  stand-ins. Records 13-25 are the thirteen again as player 2 wears them:
  player `+0x1B0` indexes the records, the colour tables (13 and up read the
  second, `0x2107780`) and the armour tables, and `0xA0A8` adds 13 to player
  2's when both pick the same fighter. `+0x1B1` is the number less 13
  (`0xA0D8`), and the crouch reads that one. Jane's (13) is in jeans; Honey's
  (15) and Picky's (18) are on texture sets 81 and 87; Mahler's (21) is his
  own record again, so only the colours change.
- **Crouch**: `adj_taikaku` (`0x2BF4C`) is VF2's `0x29414` with other
  constants: B.M. (9) is drawn at 1.1 of the motion's height, Sonic (10) at
  0.56, everyone else at 1.
- **Head**: one difference. `0x2B274` clears player `+0x7D7` and sets it
  only when the fight lets the head look at the other fighter. While it is
  clear, `0x2BE0C` steps the head up to `0x2000` a frame in both yaw and
  pitch, not VF2's `0x800` and `0x400`. So a fighter alone follows its
  motion's own target faster than one looking at an opponent (`rig.look`).
  Its gate on the move flags is `0x6C119`, VF2's `0x6C111` with bit 3.

Record `+0x24` is the midriff and is drawn (below, "The midriff"; VF2's
`+0x38`, the same struct, is too: "The midriff and the low hips"). The special parts `rob_disp` (`0x19F10`) swaps in for
the chest and hips (`mune_unit_change`, `koshi_unit_change`), broken armour,
the pieces it throws (with one sample hit) and Picky's hair are drawn, below.

**Hands and feet are never swapped.** `rob_disp` calls the foot routine
(`set_ashi_ptn`, `0x1AB74`: slots 12 and 15, 32 models from player `+0x5F0`
picked by the foot's turn and height) only while `+0x5F0` is set, and the
hand routine (`set_te_ptn`, `0x1AC80`: slots 5 and 8, `+0x6AC` entry
`+0x6FD`/`+0x6F7` & 31, the right hand `+0x180` on, as VF2's `0x19E34`)
only while `+0x6AC` is set. `action_init` (`0x125EC..0x12624`) copies them
from the record's `+0x10` and `+0x28`, with `+0x0C` (an upper-arm table read
by `0x1ACB8`, which nothing calls) beside them, and all three are 0 in all
sixteen records at `0x640D2B0`. So both are skipped and every fighter draws
its part list's hands and feet, as the explorer does. Even with a table the
feet would not change: `rob_disp` drops what `0x1AB74` returns (`0x19FEC`).

#### The motion list: the fighter's own motions first

As in Sonic The Fighters, the motion list opens on the fighter's stance, then
its moves, then the rest of what it plays, then every other motion.

- **Action table**: record `+0x14`, which `action_init` copies to player
  `+0x1A0` and the action code reads as `ldos n(g6)`: 55 motion ids, the
  same layout for every fighter. Slot 0 is the stance: `set_mot_dat`
  (`0x1B5B0`) is handed it as the round starts (`0x12AB8`) and as a move
  winds back to neutral (`0x1379C`, `0x1C150`). The ids keep their low 13
  bits there (`and 0x1FFF`); bit 15 turns the fighter round. Bahn, Mahler and
  B.M. share one table (stance 21).
- **Moves**: `0x1D360` runs `ld 0x1EBE0[+0x1B1*4]`, one input program per
  fighter, through the opcode table at `0x1EC34`. The program and its opcodes
  are Sonic The Fighters' (`js/moves.js`): the lengths agree op for op over
  FV's 59 handlers, so the same walk lists every motion a commit names (Jane
  79, Honey 87, Sonic 45). The CPU's name table is not found yet, so the moves
  are listed by motion, each under its input, with the motion's own name: entry
  0 of `offset_list_motions` points at the list's end (`0x6C01080`), and that
  is 1055 more pointers, a name per id (`DOMI_TA_KAMAE_2` for Jane's stance,
  `SY_RPU` on down+P, `TA_SYORYU_HNY` for Honey's fwd . back+down . down .
  fwd+down . fwd+P). Read from the ROM; no word in the program ROM holds its
  address. The matcher (table `0x1EBE0`,
  handlers `0x1EC34`) is STF's (`0x1F00C`) instruction for instruction, on
  the same player fields (`+0x1218`, `+0x1203`, `+0x1242`, the distance at
  `+0x5F4`), and its input byte (`+0x1200`, from `0x500700`, built from the
  I/O port at `0x1C00004`) carries the bits MAME's `vf2` ports give it:
  P 1, K 2, G 4, down 0x10, up 0x20, right 0x40, left 0x80, as STF's
  `schamp` ports do. So `programMoves` reads the tree `readMoves` reads,
  without the names: a ground move goes under the plainest input a fighter
  standing 2 from its opponent reaches it by (a round starts them 2 apart),
  strings as their presses, and the rest under their input and the bits they
  need. State bit 18 stays a number: it is STF's hyper. The motion list
  splits the moves into those two groups (Jane 26 and 52). A string plays
  only its last motion: the hand-over at the cancel frame (STF's set-up
  op 2) is not read here yet. The inputs are read from the ROM, not typed
  in MAME.
- **Virtua Fighter 2's moves** are the same: `0x1BBD4` runs
  `ld 0x1D1FC[+0x1B1*4]`, handlers at `0x1D250`. Its opcodes stop at `0x33`
  and agree with these up to `0x31`. `0x32` and `0x33` are VF2's own: each
  jumps to its u32 while bit 6 of the settings byte `[0x50016C]+0x3351`
  (`0x59C351`) is set (`0x32`) or clear (`0x33`), else steps 5. MAME's `vf2`
  has that byte 0 all through attract, so the walk takes `0x33`'s jump and
  steps over `0x32` (`commands.isa` in `js/games.js`). Two more roots
  (`0x3927D`, `0x392B9`) are read instead while the matcher's `r10` has bit 25
  or 26 set; they are fight state and not listed. Akira lists 69 moves, Jacky
  78, Shun 76, each under its input as FV's are (Jacky 34 standing, 44 in
  other situations): throws on G+P, Jacky's P, P, back+P, Lau's P, P, P, K,
  Pai's P, P, P, down+K. Checked against MAME: 200 s of `vf2` attract with
  the commits
  (`0x1C8E8`, `0x1C950`) logged, 94 commits, 43 distinct motions on Lion,
  Shun, Jacky and Akira, all 43 in that fighter's list.
- **Hand-overs**: set-up op 1 of a motion's `mot_list` record
  (`0x6411E94[id]`, twelve bytes of head, handlers at `0x1B9A4`) and op
  `0x13`'s two write the motion that plays as this one runs out, `+0x802` and
  `+0x86C` (`0x1C114`), in place of the stance. Followed from the action
  table and the moves, they add a few per fighter: Jane's 900, Grace's 953
  and 954, Picky's 906 and 910. Set-up op 4 is 19 bytes here (STF: 18).
  Op `0xA` is a switch, `{key, frame, motion}` (`+0x838`): a command of type
  20 sets `+0x60C` to the key and `0x1CC4C` plays the motion once the frame
  comes (Bahn's 97). After set-up op 8, the play half (`0x1C24C`, handlers
  `0x1D028`, lengths from each handler's `addo n, g4, g4`) has three more
  switches, through `+0x852` and `0x1CCA4`: ops `0xA`, `0xB` (at random) and
  `0x17`. Honey's and Sanman's stances fidget that way (272, 449).
- **Round and attract poses**, by `+0x1B1`:
  - Intro: `0xC77C` commands `0x641F81E[char]` (u16) as the round starts
    (Jane 809, Bahn 807, Sonic 857).
  - Win: `0x3CCB8` takes one of four u16 tables, `0x641F78A[0..3]`, by the
    Guard, Punch or Kick held (`0x500700`), else by the time and life left.
  - Time up: `0x3CD98` plays `0x641F7F2[char]` (u32), 21 for everyone.
  - The attract showcase (`0x52628`) runs two scripts a player, one of three
    pairs a cycle. `0x529BC`'s twenty-byte records swap the fighter (`+0x10`)
    at the frame in `+0xE`; `0x52BF8`'s eight-byte ones put the command at
    `+0` in `+0x198` at the frame in `+4`, and `0x131D8` plays it once the
    current motion is done (Grace's 776, Raxel's 463, Jane's 116). Script B
    swaps to Honey a frame before its 438, so she plays Picky's pose too.

**Checked against MAME** (7000 frames of attract fights, player `+0x1A8` each
frame): every fighter seen fighting played its slot 0 most (Jane 904, Grace
224, Honey 271, Tokio 759, Bahn 21, Picky 916, Raxel 928, Sanman 169), and
most frames' motions are in the fighter's own groups (Jane 2371 of 3540,
Bahn 2128 of 2551). A 40000-frame attract pass, which runs all three
showcase scripts, and a coined match put every showcase and intro pose in
its fighter's pose group. What stays under every other motion: hit
reactions and throw victims, which the attacker picks (player `+0x19C`,
`0x26978`; 589, 798, 304-320), and the shared 648/649 and 804 (`0x13570`).

#### Armour breaking (read from the ROM; the explorer draws the broken parts)

`rob_disp` draws slot `s` with the model in player `+0x40 + 4s`, not the
record's list. `action_init` (`0x12554`) copies the record's sixteen parts
there, and breaking armour overwrites them. Slots are the rig's: 1 chest,
2 head, 3/6 upper arms, 4/7 forearms, 9 hips, 10/13 thighs, 11/14 shins.

**When it breaks** (`damage_unit`, `0x26A44`, on the fighter hit):

- Each hit adds its damage (`+0x822` of the attack) to `+0x1F00[slot]`, the
  slot being the lowest bit of the hit mask `+0x704` that is in the attack's
  height class (`0x27324[+0x821]`: 0 upper, 1 lower; slot 9 and up is lower).
- `calc_up_down_damage` (`0x2735C`) keeps the old sums in `+0x1F7C`/`+0x1F80`
  and sums slots 0-8 into `+0x1F74` (upper) and 9-15 into `+0x1F78` (lower).
- The limits are `+0xAF0`/`+0xAF4`: the record's `+0x3C` pair times the
  rounds to win (`0x500052`). Upper/lower: Jane, Tokio, Raxel 200/75; Grace,
  Honey, Picky 150/50; Bahn 250/100; Sanman 250/50; Mahler, B.M. 500/200.
- A half breaks on a hit whose attack has `+0x26C` bit 1 or 4, from an attacker
  with `+0x720` bit 5, once both the old and new sum of that half are at the
  limit. Then every slot of that half with a break entry breaks, and the loop
  stays on the slot (`b 0x26B9C`), so as read it runs through all of the
  slot's stages in one go. Bits 2/3 of `+0x7F4` mark the upper/lower half
  broken, both together set bit 28 of the player's flags.
- On the deciding round (`+0x1F5C` = rounds to win - 1) with `+0x7D6` bit 0,
  `mod_fa_effect + 0xA74` is set, every slot's damage becomes `0x1000` and
  everything breaks with no attack check: the finishing blow strips the lot.
- `zibaku_ckeck` (`0x270FC`) is a second path that breaks pieces the same way.
- `action_init` clears it all (`+0x1F48`, `+0x1F4C..`, `+0x1F60..`) only while
  `0x500055` is 0 or 1.

**What it swaps in** (`0x640EDAC[char]`): 16 entries of 8 bytes, one a slot.
Bytes 0-3 are the pieces each stage throws off (0 ends the list), `+4` points
at the pieces, `0x28` bytes each. `+0x1F20[slot]` is the stage reached,
`+0x1F4C[slot]` the pieces used. On a break `damage_unit` sets bit `slot` in
`+0x1F48` and calls `efc_crush_parts_set` (`0x2D390`), which launches the
stage's pieces (`+6` each one's model) and writes the stage's first piece's
`+4` into `+0x40[slot]`: that is the slot's new model. It skips the write in
`also_mode` `0xC`/`0xD` and some sub-modes of 3 and 9 (`0x2D4D0`).

**The flying pieces (drawn, with one sample hit).** `0x2D374` (from
`damage_unit`) gives each piece a launch speed (`0x2D614`) from the
attacker's attack, its damage `+0x83D`, kind `+0x843` and direction `+0x82A`
(set by the move script, `0x1BB20`), and `0x2D390` puts it in one of eight
`0x48`-byte slots at `mod_fa_effect + 0x88`, at the broken slot's place
(`+0x1F4 + 12·slot`). Each frame `0x2CE68` drops them on the stage's gravity,
floor and ring walls (`0x50A000`, `0x50A00C`, `0x50A010`) and spins them, and
`0x2E17C` draws model `+0x22` at the piece's place turned Y, X, Z, with a
floor shadow (`+0x44`, `0x77E48`/`0x78384`). With d = min(damage, 70) / 60,
`0x2D614` throws each piece out at d × `0x64216D0[kind]` and up at
(d × `0x64216E8[kind]` + 0.06) (1.5 times that for `+0xA74` = 1), both plus
an entry of `0x6421720` (the rise twice), heading the attacker's facing plus
its `+0x82A` less an entry of `0x6421700`; both entries are picked by those
two, the slot, the piece's `+6` and the bits of its `+0x14`, & 15.

The explorer's Armour switch breaks with no attack, so it throws the pieces
with one fixed hit, a real one from the ROM: **damage 60, kind 0, direction
0**, the attack (op 4, 19 bytes, `0x1BB20`) in move 128's setup script
(`0x641E26B`), at `0x641E27E`: `04 15 04 3c 02 00 00 07 40 00 00 00 ...`,
whose `+3` is the damage, `+5` the direction (a signed halfword) and `+10`
the kind. It sits inside the routine's limits: 60 is under the cap of 70, so
d = 1, and kind 0 picks the first entries (out 0.06, up 0.04 + 0.06). The
attacker stands straight ahead facing the fighter, so its facing is the
fighter's plus `0x8000` and direction 0 throws the pieces straight back
from it, each bent by its `0x6421700` entry (`js/fvdebris.js`,
`SAMPLE_HIT`).

`js/fvdebris.js` follows the three routines in single floats:

- **The launch (`0x2D390`)**, per broken slot and stage in `damage_unit`'s
  order (upper half, slots ascending, stages ascending). Each record goes
  into the first free slot with flags `+0x1C` | bit 11, its place, its
  speed, model `+6`, radius `+0x18`, weight `+0x14`, floor `+0x20`, X turn
  `+8`, Y turn the facing plus `+0xA`, Z turn `+0xC` (low half), the turns
  it settles on (`+0xE`/`+0x10`/`+0x12`, 0 none) and a spin
  `0x640F924[(bits of x + y + z + weight) & 15]`. A bit-3 record is the
  flipbook effect (`0x2D254`) instead when bit 1 is clear, or when two slots
  already hold bit-3 pieces (`0x2D8D4`), and **that ends the stage's loop**
  (`0x2D3F0`), as eight full slots do. A record with model 0 still takes a
  slot that nothing moves, draws or frees (`0x2CE68` and `0x2E17C` skip
  model 0), and it counts toward those two. So Jane's upper half throws 715
  and 714; her third chest stage's first record (719) is the effect and
  ends that stage, slot 4's 580 is the effect too, and slot 5's model 0 holds
  a slot. Grace's lower half throws four pieces (1740, 1741, 1985 twice) and
  two effects (slots 9 and 10), and her upper, whose records all have bit 3,
  only effects. Which records become effects depends on what is already
  flying: with Jane's lower half broken first, its two 486s make 715 and 714
  effects as well.
- **The flipbook effect (`0x2D254`, `0x2D2F4`).** Two `0x24`-byte slots at
  `mod_fa_effect + 0x508`; `0x2D254` takes the first whose `+0x1E` (the model
  shown) is 0, and with neither free nothing is launched. It writes the
  broken slot's place at `+0`, the piece's throw times (0.2, 0.01, 0.2)
  (`0x3E4CCCCD`, `0x3C23D70A`) at `+0xC`, the record number `+0x1B0` at
  `+0x1C`, a frame count of 0 at `+0x20` and the first model of
  `0x6421760[record]` at `+0x1E`. That list is 54 halfword models a record,
  one a frame (Jane 1849..1902, Grace 2110..2163, Honey 3910..3963); they are
  a burst of shreds in the fighter's colours, 180 points each, that spread
  from 0.3 to about 10 across in model space as the frames go on. It also
  keeps the three speeds' bits summed, plus slot × `0x400`, at `+0x1A`, which
  nothing reads. Each frame, after the pieces (`0x2CDC4`, `0x2CDC8`),
  `0x2D2F4` adds one to the count; at 54 it clears `+0x1E`, else it shows
  entry `count`, takes gravity (`0x50A000`) off the Y speed and moves by the
  speed: no floor, drag or wall, so it falls through the floor about 7.4
  below where it started by the last frame, while the shreds rise in the
  model. `0x2E17C` draws it after the pieces: push, translate, Y turn
  `0x8000` for the first slot and `0x4000` for the second, whatever the
  fighter faces, scale 1, model `+0x1E`, then model `+0x18`, which nothing
  sets, so 0; pop.
- **The push out of the bodies (`0x2CEA0`, `epc_oidasi`).** First, every
  frame, for every piece with a model, flying or resting, unless either
  player has `+0x7D6` bit 0 (set by the finishing blow, `0x264FC`, cleared by
  `action_init`, `0x129F8`): TGP op `0x77` (`0x3B807777`) gets the piece's
  x, y, z and radius (`+0x18`) and returns two sums, and x += 0.16 × the
  first, z += 0.16 × the second (`0x3E23D70A`); y is left alone. The copro
  (FV's own program, `0x20936`; cpres1's `0x77` is another routine) tests
  player 1's 32 body balls (`0x1403E80`, radii `0x30600`) and, only if none
  touched, player 2's (`0x1407E80`, `0x30700`). A body whose entry 13 is over
  1.4 (`0x3FB33333`) from the piece is skipped. For each entry with a radius,
  d = |ball − piece| and s = its radius + the piece's; within d ≤ s it adds
  (ball − piece) × (1 − q) to the sums, in x and z, with q the copro's d / s:
  RECIPS s, refined three times as F4 = F11 − s·F4, with F11 the 3.0 the
  length routine (`0x20281`, an inverse square root) leaves there instead of
  2.0. So q comes out near 2d / s: a piece inside s/2 of a ball is drawn in
  towards it, one between s/2 and s pushed out, and none past s is touched.
  The balls are `calc_unit_mat`'s: `set_coli_ball_data` (`0x18304`) sends
  each slot's list (the shadows' lists, `0x640E89C`, counts `0x640E914`)
  through op `0x39`, the ball's point (`0x640E4FC` + 16k) on the slot's
  matrix, into table entry `0x182E4[k]`; `send_coli_ball_R` (`0x1B90`, at
  boot) gives entry i the radius of ball `0x292AC[i]`, so each entry holds
  one ball and its own radius, the same for every character. Entry 13 is
  ball 3, the hips (slot 9); entries 30 and 31 have radius 0.
 (`0x3BAB1F2D`), vx and vz × 0.98,
  then the place moves by the speed. At or under the floor (`+0x40`, 0.5
  lower once out of the ring) the bounce is counted, the y step taken back,
  and vy = −vy × (0.2 + 0.2 / weight). Once |vy| ≤ 0.001 the piece rests
  (bit 7, speed 0); otherwise vx and vz × 0.9. The rest test is on the
  bounce's speed, and that speed settles near g·k/(1 + k) with k the bounce
  factor, so a piece whose bounce lands it just over the threshold chatters
  within a couple of millimetres of its floor without ever setting bit 7, in
  the ROM as here.
- **The walls**, below y 3.1 (`0x50027C`), about the ring's centre: past
  5.5 a piece is out (bit 19) and falls to the lower floor; past 5 less its
  radius it is put back and its speed on that axis × −0.3. The centre is
  half the opponent's distance ahead of the fighter. Every wall is up, as
  at the start of a round (`0x574004`).
- **The turns (`0x2D118`).** While flying and for its first four bounces a
  piece adds its spin to Y, and to X with flag bit 12 and Z with bit 14.
  After that each turn with a target steps onto it, `0x800` a frame
  (`0x1000` at rest), Y's step over (bounces + 1). The ROM keeps its two
  bounds in r11/r14 and Y's step leaves r14 the divisor, which Z's test then
  reads; that is kept.

The explorer runs the effect as above (`launchEffect`, `stepEffect` and
`effectPlace` in `js/fvdebris.js`; `readFlipbook` in `js/vf2fighters.js`),
one mesh per effect slot swapping through the 54 frames' geometry
(`placeEffects` in `js/app.js`).

The explorer runs the push before the fall (`pushOut` in `js/fvdebris.js`)
against the bodies on screen: `readBodyBalls` reads the table once,
`bodyBallsAt` places it on the fighter's pose as player 1 and on the
opponent's, when it is shown, as player 2 (`noteDebrisBodies` in
`js/app.js`), each frame's pose standing in for `calc_unit_mat`'s. The
arithmetic is the copro's in single precision, RECIPS's seed table and the
3.0 included; only the square root is taken exactly. The finishing blow
never lands, so the push never stops. There is none in VF2, which has no
armour to throw.

Checked in node: a piece of radius 0.1 level with one ball of 0.148 moves
−0.0027 at d 0.02, −0.0002 at 0.123, +0.020 at 0.2, +0.036 at 0.24 and not
at all from 0.248 on, and a body 1.5 away is skipped. In headless Chrome
(the motion held at the break, the push stepped against the same pieces
with no bodies): Jane, motion 21, upper half, pieces 715 and 714 are moved
0.003, 0.022 and 0.026 a frame over the first three frames, then never
again; they land 0.06 and 0.09 further out than without it. Grace, motion
360, lower half, with the opponent: her four pieces move up to 0.07 a frame
over frames 1 to 5 and land 0.04 to 0.19 away from where they would have.
Not checked against MAME, for the same reason as the shadows: attract never
breaks armour.

The pieces are the fighter's
own; the opponent's armour stays whole. They run in board frames of their
own, so they fly with the motion held as well as playing. Breaking a half
throws its pieces and effects from the pose on screen at that moment, making
it whole again takes them back, and another fighter starts with none.

**The landing sound (`0x2D218`; read from the ROM, checked against MAME).**
On each floor hit `0x2CF24` adds one to the piece's counter (`+0x3C`, zeroed
at the launch, `0x2D49C`), and while it is 1 or 2 (`0x2CFC0`, `cmpobl 2`)
calls `0x2D218`. That takes the highest of the flag word's bits 28 to 31
(`+0x24`, the record's `+0x1C`; `scanbit`) and sends one of four codes
through `0x41EA4`, the queue the stage sounds go on: `0xAE1146` for bit 28,
`0xAE1115` for 29, `0xAE1128` for 30 and `0xAE111F` for 31. So a piece sounds
on its first two touches of the floor and is quiet after, however long it
skids. Every record with a model has exactly one of the bits: 28 (Jane 2,
Grace 4, Honey 17, Picky 2, Sanman 2), 29 (most of the rest) or 31 (Jane 1,
Bahn 3, Picky 1, Raxel 2, Sanman 2, Mahler and B.M. 6 each); none has 30.
`0x2D254`, the flipbook effect, calls `0x2D214`, the bare `ret` before it,
not `0x2D218`, so the effect makes no sound. `fall` (`js/fvdebris.js`) puts
the code on the simulation's `cues` on those two hits, and `sendDebrisCues`
(`js/app.js`) sends them to the sound board when the music is on.

- Headless Chrome, a stand-in sound board, both halves broken while the
  stance plays: Jane sends `0xAE1146` four times (two pieces, bit 28),
  Grace `0xAE1115` eight times (four), Honey `0xAE1146` six times, Bahn
  `0xAE1115` four times and `0xAE111F` twice (the bit-31 piece), Mahler
  `0xAE111F` ten times (five). Two a piece, though some pieces touch the
  floor more than 200 times. No page errors.
- MAME (`fvipers`, coined game, the player standing still, breakpoints on
  the floor hit `0x2CFB4`, the call `0x2D23C` and the launch `0x2D414`):
  35 pieces thrown in 29,000 frames on stage 0, 1454 floor hits.
  The call came on exactly the hits that took the counter to 1 or 2, 54
  of them, and never on the other 1400; each sent its piece's code, `0xAE1115`
  for bit 29 (42) and `0xAE1146` for bit 28 (12). A piece that skidded on
  the floor for 600 frames sounded on its first two only.

**Off screen, a resting piece is gone (`0x316F0`; read from the ROM,
checked against MAME).** `0x2CF24` skips the fall for a piece at rest (flag
bit 7). If its flags also have bit 3, and the finishing blow's
`mod_fa_effect + 0xA74` is clear (the explorer never reaches it), it stores
the piece's point at `0x50A2AC` and its radius (`+0x18`, the one the walls and
the body push use) at `0x50A2FC` and calls `0x316F0`. That sends the point
through TGP `0x14802929` with the camera matrix current, puts x, y and the
radius on the screen at the focal `0x501084` (480) over z, and sets one bit of
`0x50A300` for each of four points strictly inside 496 by 384 about the
centre: the radius above the point and below it (if x is inside) and left and
right of it (if y is inside). A z with its sign bit set leaves all four
clear. With none set, `0x2D100` clears the piece's model (`+0x22`) and flags
(`+0x24`): the slot is free again (`0x2D390` takes the first with flags 0),
and the piece is never drawn again, even with the camera back on it. A piece
in flight, or one at rest without bit 3, is never tested. Most records have
bits 3 and 1 (bit 3 alone is the flipbook effect). Of the records with a
model: 7 of Jane's 8, 14 of Grace's 16, 16 of Honey's 17, all but one to
four of everyone's.

The board asks its fight camera; the Animation tab has none, so
`stepBodyDebris` (`js/app.js`) asks the explorer's own screen, as the
Airport planes' test does: `cameraOnCourse().view` puts the piece's point
into the camera's space (one rigid transform, so the radius needs no scale)
and `pieceOnScreen` (`js/fvdebris.js`) runs the four tests against the
window's edges. `fall` returns false for a piece it removes and
`stepDebris` frees its slot. So turn the view off a piece at rest and it is
gone. There is none in VF2, which has no armour.

- MAME (`fvipers`, coined game, the player standing still; breakpoints at
  `0x31740` for the view point, `0x2CF5C` for the result and `0x2D100` for
  the removal): 41 pieces thrown in 34,000 frames on stage 0,
  1972 tests of resting pieces, 7 off screen and 7 removals, each right
  after its failed test, all resting pieces with bit 3 (one of them out of
  the ring, bit 19). The camera matrix is rigid: in 394 pairs of pieces
  tested on one frame, the distance between them in view space is the one
  in the world to 1.3 × 10⁻⁶.
- Node: `pieceOnScreen`, given each MAME test's view point, radius and the
  focal's edges (248/480, 192/480), gives the board's answer on every one.
  Against a single-precision port of `0x31740`..`0x31884`, it differs on 1
  of 2,000,000 random points, a rounding at an edge.
- Headless Chrome, both halves broken with the view on the fighter, then
  turned away: the pieces still flying when it turns away all stay; once
  at rest, Jane loses both of hers, Grace 2 of 4, Bahn 2 of 3 and Mahler 1
  of 5, exactly the resting ones with bit 3 (Honey's two with bit 3 were
  still bouncing). They are still gone when the
  view comes back. With the view kept on them none goes. No page errors.

**Checked in headless Chrome on the RTX 3070** (Jane and Grace, motions 21
and 360, each half broken while the motion plays, and Jane with it held):
the drawn piece's translation equals the broken slot's drawn translation at
the launch, to 0.0001. Every drawn piece leaves it, rising 1.3 to 6.2 above
the floor, and lands 1.8 to 6.2 away, on its floor (0.05, or 0.008 for
Grace's slot 9), behind the fighter, away from the attacker. One of Grace's
leaves the ring and drops to the lower floor. Turns with targets reach them.

The effect, checked the same way (Jane and Grace, motions 21 and 360, each
half broken while the motion plays, in both orders): each effect's drawn
translation equals its broken slot's drawn translation at the launch, to
1e-5 (Jane's chest and forearm, 1 and 4, or her shins, 11 and 14; Grace's
hips and thigh, 9 and 10, or chest and head, 1 and 2), and moves with the
pose: Jane's forearm effect starts at (0.42, 1.04, 0.06) in motion 21 and
(0.31, 0.81, 0.18) in 360. The drawn mesh shows the frame the slot names
on every frame sampled, frames 0 to 53, and is hidden once the slot frees.
The first slot is drawn a quarter turn from the second. With the armour
whole none is launched.
The launch turn is not measurable against the armour: the piece models do
not sit on the intact slot model in any quarter turn (mean nearest vertex
0.04 to 0.08 for all four), so it rests on `0x2E17C`'s order alone. Not
checked against MAME.

**The pieces' floor shadows (drawn, Factory and Bay Side).** `camera_control`
calls `0x76A70` (`0x1FC7C`), which calls `0x78384` when the stage flags u32
`[0x6442BA8 + 12·stage]` have bit 9 or bit 31: stage 1, the Factory
(`0x20F`), and stage 5, Bay Side (`0x8000028F`). In geometrizer mode 2
(`0x58F0`) it saves the camera to inner slot 3 (`0x21804343, 3`) and walks the
eight piece slots, skipping model `+0x22` = 0 (the effects get none). The
floor is 0, or ground `0x50A010` for a piece out of the ring (bit 19). A piece
at y ≤ floor + 0.3 (`0x3E99999A`; `cmpr`/`bl` skips only a higher one) gets
its `+0x44` drawn on

    push; T(x, floor, z); S(1, 0, 1); Ry(+0x1E); Rx(+0x1C); Rz(+0x20);
    S(1.25) (0x3FA00000); 0x46 3; draw; pop

so the piece's own turns flattened onto the floor, a quarter bigger. Out of
the ring it goes through the lower window (`0x501844`), as `0x2E17C` draws
the piece itself. `+0x44` is the break record's `+0x24`, copied at the
launch (`0x2D48C`): 0xD36 in every record of every fighter, and 0xD38 in
some of Honey's, Bahn's and Raxel's.

The explorer reads `+0x24` with the record (`readArmourPiece`) and draws
`debrisShadowDraws` (`js/fvdebris.js`) from the pieces it already flies, on
the stages `debrisShadowStage` passes. For a piece out of the ring it uses
the same stand-in for `0x50A010` the fall does (−0.5). Before, it drew none.

Checked in node and in headless Chrome: the gate passes stages 1 and 5 only.
Jane, motion 21, upper half broken, `SAMPLE_HIT`: 714 gets its shadow on
frame 59 after the break (y 0.134), 715 on frame 64; they come and go as
the pieces bounce, and from frame 81 both stay, at rest at y 0.050 and 0.052,
each with 0xD36 at its own x, z and y = 0. In the page the pool shows the
same draws on the Factory and Bay Side (one at frame 74, both from 81 on)
and none on stage 0.
Not checked against MAME: attract never breaks armour. In the shared build,
about 29 minutes of attract (over 30,000 frames, through stages 0 to 8 and
the Factory and Bay Side twice) never reached the launch (`0x2D390`) or
either of `0x78384`'s draws.

**The pieces' shadows on the light (drawn, every other stage).** The
fighters' shadow routine `0x602F0`, which `camera_control` calls for each
player shown (`0x1FC60`, `0x1FC74`), ends in `0x60350`: `call 0x608B8; call
0x609B0`. It gets there only on a stage that draws the fighters' shadows
(flags without bit 8, or bit 31 with bit 7 and the event bits up), is not
the Factory's lamps (`0x5FA6C`: `0x60468` returns on its own path), and,
after the fighter's own `0x60640` (`+0x2A` = 0), has no flag bit 9
(`bbs 9, r12, ret` at `0x6034C`). Read for stages 0 to 11: every stage but
1 (`0x20F`, lamps and bit 9) and 5 (`0x8000028F`, bit 31 and bit 9), so
it and `0x78384` never meet. Both read the eight shared slots
(`[0x500844] + 0x88`).

- `0x608B8` latches `+0x24` bit 8 for each slot with a model (`+0x22`):
  slid along the light to y = 0 by `0x501990`/`0x501994` (Fn_kage_flag's
  kx, kz), the distance is max(|x|, |z|), or `Fn_get_2d_len` / sqrt 2 on the
  round stages (`0x60B98`, 0 and 4). Bit 8 is set when y ≥ 0 (an integer
  test, so −0 is below) and the distance ≤ ring − 0.5 (`0x3F000000`), and
  cleared when it is ≥ ring + 0.4 (`0x3ECCCCCD`); between, it keeps what it
  had. No record has bit 8 at the launch.
- `0x609B0`, in geometrizer mode 2: push, `Fn_load_matrix_inner 0`
  (inner[0], the flattening), then for each slot with a model:

      push; T(+0x00); Ry(+0x1E); Rx(+0x1C); Rz(+0x20);
      Fn_kage_leave_x_axis (0x41); Fn_mul_matrix_inner_rev g5 (0x46);
      draw +0x44; pop

  with g5 = 1 (the ring's floor) when bit 8 is set, else 2 (the ground,
  `0x50A010`). So it is the fighters' part shadow (inner[1] or inner[2] ·
  laid flat (inner[0] · piece)) with the piece's own matrix, the same
  `+0x44` model as `0x78384` (0xD36, or 0xD38), at its own size: no scale
  and no height test. A piece out of the ring (bit 19) goes through the
  lower window (`0x501844`), as the piece itself. The effects get none.
  The table `0x60BA8` it reads by `+0x32` is overwritten by `+0x44` before
  the draw. Both players' passes draw the same slots, so each shadow is sent
  twice, to the same place; the explorer draws it once.

The explorer runs `0x608B8` after each board frame of the pieces
(`latchPieces`) and draws `pieceShadowDraws` (`js/fightershadow.js`) from
the pieces it already flies, on the stages `pieceShadowSetting` passes, with
the stage's light and ground as the fighters' shadows take them. The ring
test is about the pieces' own ring centre (the walls', half the opponent's
distance ahead), where the fighters' test is about the fighter. Before, it
drew none there.

Checked in node and headless Chrome, Jane, motion 21, upper half broken,
`SAMPLE_HIT`: the gate passes stages 0, 2-4 and 6-11. On stage 0 both 715
and 714 have their shadow from the first frame, on y = 0, slid along the
light (0.414 a unit of height, `a0` 0xD000) and meeting the piece once it
rests (at 0.05). On stage 2 (a0 0xEB00, 1.77 a unit) the shadows of the
pieces at 1.8 to 2.6 lie 3.2 to 4.5 away. Stages 1 and 5 draw `0x78384`'s
copy only, as before. Honey, motion 360, both halves: the piece that drops
off the ring to −0.49 stays latched (it lands 4.9 out by the round
stage's measure, inside the 5.4) and keeps its ring-floor shadow, as the
ROM's latch would. Not checked against MAME, for the same reason as the
floor copy: attract never launches a piece.

| Char | Slots that break (base -> broken model) |
|---|---|
| 0 Jane | chest 732 -> 730 -> 729 -> 731 (three stages), 4: 738 -> 737, 5: 576 -> 734, 9: 493 (same), 11: 711 -> 710, 14: 709 -> 708 |
| 1 Grace | 1: 915 -> 1982, 2: 883 -> 2448, 3: 911 -> 1980, 4: 919 -> 1987, 6: 910 -> 1978, 7: 918 -> 1986, 9: 1736 (same, four pieces), 10: 1743 -> 914, 11: 882 -> 1975, 13: 1742 -> 913, 14: 881 -> 1974 |
| 2 Honey | 1: 2464 -> 2540, 2: 2435 -> 2552, 3: 2459 -> 2536, 4: 2468 -> 2550, 6: 2458 -> 2535, 7: 2467 -> 2549, 9: same, 10/13: -> 2463, 11: 2434 -> 2530, 14: 2433 -> 2529 |
| 3 Tokio | 1: 2480 -> 2662, 3: 2475 -> 2659, 4: 2484 -> 2668, 6: 2474 -> 2658, 7: 2483 -> 2667, 10/13: -> 2479, 11: 2472 -> 2654, 14: 2471 -> 2653 |
| 4 Bahn | 1: 694 -> 2398, 2: 687 -> 31, 3: 689 -> 2397, 6: 688 -> 2396, 9: 2405 -> 690, 11: 686 -> 2394, 14: 685 -> 2393 |
| 5 Picky | 1: 902 -> 450, 2: 894 -> 893, 3: 899 -> 446, 4: 907 -> 454, 6: 898 -> 445, 7: 906 -> 453, 10: 2414 -> 449, 11: 891 -> 443, 13: 2413 -> 448, 14: 890 -> 442 |
| 6 Raxel | 1: 966 -> 470, 2: 1538 -> 700, 3: 1540 -> 461, 4: 974 -> 474, 6: 1539 -> 460, 7: 973 -> 473, 9: 1541 -> 964, 11: 1535 -> 458, 12: 1533 -> 456, 14: 1534 -> 457, 15: 1532 -> 455 |
| 7 Sanman | 1: 1075 -> 1074, 2: 1061 -> 1060, 3: 1068 -> 1067, 4: 1084 -> 1083, 6: 1066 -> 1065, 7: 1082 -> 1081, 11: 1056 -> 1057 -> 1055, 14: 1053 -> 1054 -> 1052 |
| 8 Mahler | 2: 1497 -> 3887, 3/6: same, 4: 1516 -> 3893, 7: 1515 -> 3892, 11: 1496 -> 3886, 14: 1399 -> 3885 |
| 9 B.M. | 2: 3589 -> 3588, 3/6: same, 4: 3619 -> 3618, 7: 3617 -> 3616, 11: 3587 -> 3586, 14: 3585 -> 3584 |
| 13 Jane (P2, jeans) | as Jane: chest 1613 -> 1580 -> 1579 -> 1581, 4: 1620 -> 1619, 5: 1617 -> 1616, 11: 1563 -> 1562, 14: 1561 -> 1560 |

Sonic and the two stand-ins (10-12) have no armour (all entries 0).

**Drawn on top of the slot model**, all keyed on `+0x1F48`:

- `mune_unit_change` (`0x31888`, slot 1): only once the chest is broken
  (`+0x1F48` bit 1), and only for characters with a table at
  `0x6421F80[char]`: Jane, Grace, Honey, Jane in jeans and character 14.
  It swaps the chest's model for one of 31 picked by a spring, or for a
  per-frame list on some moves. The whole routine is below, under "The
  chest bounce".
- `koshi_unit_change` (`0x31ADC`, slot 9): Honey and Bahn (`0x6422400[char]`).
  It swaps the hips' model by motion and frame, by the waist's height and by
  move flags, taking the second of each pair once the hips are broken
  (`+0x1F48` bit 9). The whole routine is below, under "The hips".
- `kata_pat_disp` (`0x32A90`, slot 1): shoulder pads on their own swing
  (`0x642147C[char]`, left then right: model, limit, a second model and its
  offset at `+0x16`/`+0x18`). Raxel (959/960), Mahler (3889/3891 + 3888/3890)
  and B.M. (3592/3595 + 3888/3890) have them. The first pad goes when slot 6
  breaks, the second when slot 3 does.
- `kosi_mino_disp` (`0x31E54`, slot 9): the skirt panels of characters 0, 1,
  13 and 14 (`0x6421DE0[char*16]`), gone once the hips break (bit 9).
- `pky_kami_disp` (`0x1ADDC`, slot 2): Picky's hair is drawn only once his head armour
  (slot 2, the helmet) has broken. The whole routine is below, under "Picky's
  hair".
- Record `+0x24` is read on slot 9 too, and it is not a model: its `+8`
  picks 16 bytes at `0x20E0004` that go to the geometrizer before the skirt.
  Once the chest breaks the game reads `0x642F9EC[char]` instead.

#### Shoulder pads and skirt: how they are placed (read from the ROM)

Both are drawn from `rob_disp`'s per-slot jump table (`0x1A0EC`), straight
after the slot's own `set_obj`: slot 1 jumps to `kata_pat_disp`, slot 9 (after
the record `+0x24` geometrizer block) to `kosi_mino_disp`. Each routine starts
with `0x21804343, 3`, which saves the current matrix (the chest's, or the
hips') to inner slot 3, and draws every piece as

    push; 0x03 identity; translate; ang_z; ang_y; ang_x;
    0x05 (read back into the player, for the shadow); 0x46 3; set_obj; pop

`0x46 3` is `current = inner[3] * current`, so each piece is the slot's matrix
times its own translate and turns. The three `0x13` writes before `0x03` are
an add whose result is thrown away: a wait. Op names are m2-hle2's
(`tests/cop_replay.c`): `0x69` is `Fn_mul_mot_yrot` (a bone's rotation from TGP
memory, with `Ry(arg)` in front), `0x0F` reads the point back, `0x24`/`0x25` are
`a*sin`/`a*cos`, `0x27` atan, `0x1A` sqrt. Bone `n` of player `p` is at TGP word
`0x3A00 + 0x100p + 12n`, and the player's `+0x80 + 12n` is slot `n`'s
skeleton offset in its parent's frame (the list copied to `+0x8C` starts at
slot 1).

**Shoulder pads** (`kata_pat_disp`, `0x32A90`). `0x642147C[char]` points at
two records, left then right. `sub_32A0C`, called from `action_init`, copies
them into `mod_fa_effect` (`+0x60` for player 2). A record is `0x24` bytes:
`+0` model (`-1` none), `+2` swing limit, `+4` translate, `+0x10` X turn,
`+0x12` Y turn, `+0x14` Z turn, `+0x16` second model (0 none), `+0x18` its
translate.

| Char | Left (drawn until slot 6 breaks) | Right (until slot 3 breaks) | Limit; turns X/Y/Z |
|---|---|---|---|
| 6 Raxel | 959 at (0.35, 0, 0.14) | 960 at (0.35, 0, -0.14) | `0x3800`; `0xC000`/0/`0x4000` |
| 8 Mahler | 3889 at (0.39, 0, 0.17), then 3888 at (0, 0.05, 0.06) | 3891 at (0.39, 0, -0.17), then 3890 at (0, -0.05, 0.06) | the same |
| 9 B.M. | 3592 at (0.45, 0, 0.17), then 3888 as Mahler's | 3595 at (0.45, 0, -0.17), then 3890 as Mahler's | the same |

Every other fighter points at `0x64216CC`, whose model is `-1`: nothing is
drawn. A pad is the chest's matrix, its translate, `ang_z(Z)`, `ang_y(-Y)` on
the left and `ang_y(Y)` on the right, then `ang_x(X + swing)` on the left and
`ang_x(X - swing)` on the right. The second model follows on the pad's own
matrix, translated by `+0x18` with no turn. A pad is skipped (and `+0x1B28` /
`+0x1B2A` cleared) once bit 6 / bit 3 of `+0x1F48` is set, so one break of
the upper half takes both.

The swing works out how far each upper arm is raised; it is under "The
shoulder pads", after the skirt below, measured against MAME.

**Skirt** (`kosi_mino_disp`, `0x31E54`). Drawn for characters 0, 1, 13 and 14
only, and not once bit 9 of `+0x1F48` (hips broken) is set; then
`+0x1B20..0x1B26` are cleared. `0x6421DE0[char * 16]` holds four model numbers
(`+0`, `+2`, `+4`, `+6`) and a float at `+8`:

| Char | +0 | +2 | +4 | +6 | +8 |
|---|---|---|---|---|---|
| 0 Jane | 3045 | 3044 | 0 | 0 | 0.025 |
| 1 Grace | 2446 | 2445 | 2444 | 2443 | 0 |
| 13 Jane (P2, jeans) | 3037 | 3036 | 0 | 0 | 0.025 |
| 14 | 2439 | 2438 | 2437 | 2436 | 0 |

The routine does not check for 0, so for Jane it calls `set_obj` with model 0
for two panels. 14 is past the roster's 13 and not a fighter the explorer
lists; its models sit beside Grace's. The placement is the same for everyone:
`action_init` (`0x12768`) writes constants to `0x50A324..0x50A378`:

| Panel (draw order) | Model | Translate | Turns Z, Y, X | Limit |
|---|---|---|---|---|
| 1 | `+4` | (0.013, 0.087, 0) | 0, `0xC000`, `0x4000 + s1` | `0x3000` |
| 2 | `+6` | (0.013, -0.088, 0) | 0, `0xC000`, `0x4000 - s2` | `0x1E00` |
| 3 | `+2` | (0, -0.017, 0.107), then (0, 0, `+8`) | 0, `0xC000 + s3`, `0x4000` | `0x1000` |
| 4 | `+0` | (0, -0.017, -0.107), then (0, 0, `-(+8)`) | 0, `0xC000 - s4`, `0x4000` | `0x1000` |

All are on the hips' matrix. Each swing is `max(0, max(a, b) - limit)`, so a
panel stays at its base angles until a thigh lifts past the limit. `a` and `b`
come from the two thighs (bone 13, `+0x128`, and bone 10, `+0x104`, turned by
`0x69` with the facing word `0x50A398`, which nothing writes, so 0): their
angles against the hips' `+0xAD4` give `+0xAD8`/`+0xADE` and the terms at
`0x50A380..0x50A388`, scaled by `sin`/`cos` (`0x21`/`0x22`) through a float
round trip (`0x17`/`0x18`). The whole of it is under "The skirt", after
the midriff below, measured against MAME.

So both are drawn on a slot's matrix with fixed offsets and turns, and only
the swing depends on the pose. At rest the skirt's swing is 0, because
a thigh has to pass its limit first. A pad swings once its upper arm rises
past square to the body, which a guard often does.

**What the explorer draws.** `readArmour` (`js/vf2fighters.js`) reads
`0x640EDAC` per fighter (`rig.fighters.armour` in the profile) into each
slot's models by stage, and `0x6421F80`'s `+4` entry 15 as the broken chest
at rest. The Animation tab's Armour switch (intact / upper broken / lower
broken / all broken) is one hit per half as the board deals it, all stages at
once: `armouredFighter` gives each broken slot its last stage's model, the
chest of Jane, Grace, Honey and Jane in jeans the resting one (Jane 772,
Grace 2844, Honey 2978, jeans 1597), and the fighter is rebuilt the way a new
one is. The hips of Honey and Bahn are `koshi_unit_change`'s every frame
(below, "The hips"). Not checked against MAME. The shoulder pads and skirt are drawn as above:
`readPads`/`readSkirt` turn each piece into an extra on the chest's or hips'
matrix (`placeExtra`). The pads swing with the upper arms ("The shoulder
pads", below) and the skirt with the thighs ("The skirt", below). Jane's two model-0 panels are skipped like any other empty part, and
entry 14 is never read. The Armour switch hides both pads with the upper half
(slots 6 and 3) and the skirt with the lower (slot 9). Picky's hair
swings with the head ("Picky's hair", below). The chest's per-frame list
is drawn on the move flags the motion itself sets (below). The flying pieces are thrown by one sample hit (above).
Hands and feet have nothing to swap (above).

**The chest bounce (read from the ROM; drawn).** `rob_disp` calls
`mune_unit_change` (`0x31888`) for slot 1 only (`0x1A00C`), with the slot's
own model (`+0x44`) in `g0`, and draws whatever comes back in `g0` on the
slot's own matrix: the chest's, already sent (`0x19FD0`, slot × `0xC`). The
routine sends no matrix, offset or scale. The bounce is a model swap, nothing
else.

*When it runs.* It returns the slot model unchanged unless the character has
a table at `0x6421F80[char]` and `+0x1F48` bit 1 (chest broken) is set. Only
characters 0, 1, 2, 13 and 14 have a table, so only their broken chests
bounce. An intact chest never does: there is no other path. Jane's chest
breaks in three stages; bit 1 is set at the first one, so the bounce starts
then. Character 14 is in neither the break table above nor the explorer, but
`0x640EDAC[14]` does have a one-stage slot-1 entry. `debug_flag` bit 5
skips the spring step (and the copy at `0x1716C`) but still picks a model.

*The table* (`0x6421F80[char]` → two words): `+0` points at the per-frame
list (a count word, then that many 16-bit model numbers), `+4` at 31 16-bit
model numbers (entries 0-30, ending in a 0 word).

| Char | Table | 31 models (entry 0 → 30) | Per-frame list |
|---|---|---|---|
| 0 Jane | `0x6422018` | 701, 758-778, 864-872 | 21 frames |
| 1 Grace | `0x6422000` | 2829-2859 | 51 frames |
| 2 Honey | `0x6421FE8` | 2963-2993 | 68 frames |
| 13 Jane (jeans) | `0x6422024` | 1582-1612 | 21 frames |
| 14 | `0x642200C` | 436, 873, 2800-2828 | 51 frames |

The per-frame lists, as stored:

- Jane: 778 778 864 778 777 775 773 771 769 768 767 766 765 766 767 768 769
  771 773 775 777
- Grace: 2853 2850 2851 2852 2853 2853 2852 2851 2850 2849 2848 2846 2844
  2842 2840 2839 2838 2837 2838 2839 2840 2842 2844 2846 2848 2849 2850 2851
  2852 2853 2853 2852 2851 2850 2849 2848 2846 2844 2842 2840 2839 2838 2837
  2838 2839 2840 2842 2844 2846 2848 2849
- Honey: 2971 2971 2971 2970 2970 2970 2971 2971 2971 2972 2972 2973 2973
  2974 2974 2975 2975 2976 2976 2977 2977 2978 2979 2979 2980 2980 2981 2981
  2982 2982 2983 2983 2984 2984 2985 2985 2985 2986 2986 2986 2985 2985 2985
  2984 2984 2983 2983 2982 2982 2981 2981 2980 2980 2979 2979 2978 2977 2977
  2976 2976 2975 2975 2974 2974 2973 2973 2972 2972
- Jane (jeans): 1603 1603 1604 1603 1602 1600 1598 1596 1594 1593 1592 1591
  1590 1591 1592 1593 1594 1596 1598 1600 1602
- 14: 2822 2819 2820 2821 2822 2822 2821 2820 2819 2818 2817 2815 2813 2811
  2809 2808 2807 2806 2807 2808 2809 2811 2813 2815 2817 2818 2819 2820 2821
  2822 2822 2821 2820 2819 2818 2817 2815 2813 2811 2809 2808 2807 2806 2807
  2808 2809 2811 2813 2815 2817 2818

They are model numbers from the same character's 31 (entries 8-22 for Jane
and Jane in jeans, 8-24 for Grace and 14, 7-23 for Honey), not indices.

*The spring.* `+0xC6C` is the position, `+0xC68` the velocity, both floats.
`change_unit_init` (`0x2CA10`, from `efc_ram_init`, for both fighters) sets
three constants: `+0xC74` = 160.0, `+0xC70` = 0.14, `+0xC78` = -0.1. What
drives it is the distance from the head (`+0x20C`) to `+0xC7C`, a copy of
the waist (`+0x1F4`) that `calc_unit_mat` takes as it starts (`0x1716C`),
before it stores the new waist (`0x172D4`) and head (`0x17450`). The distance
is coprocessor function `0x2C` (`0x16002C2C`, six floats in, one out). In
FV's own coprocessor program (uploaded from `0x6400000` by
`b_crx_copro_down`, `0x1810`) entry `0x2C` of the dispatch table goes to
`0x20670`, the same instructions as cpres1's official `Fn_get_3d_r`:
`sqrt(dx² + dy² + dz²)` (its square root, `0x20281`, is the same code too).
Each frame, from `loc_3191C`:

1. `d` = that distance; `k` = `|+0xC64 - d|` × `+0xC74` (160), capped at
   4.2. `+0xC64` = `d` (kept for next frame); `+0xC88` = `k` (nothing reads
   it).
2. The kick: if the velocity is exactly 0 it becomes `k`; else if
   `k` ≥ |velocity| it becomes `k` with the velocity's sign; else it is left
   alone. So the kick only ever raises the speed, and only a spring at a
   dead stop is pushed in the + direction.
3. position += velocity; then velocity × 0.935.
4. If position ≥ 15: position = 15, velocity = -velocity × 0.78. If
   position ≤ -15: position = -15, the same.
5. velocity += 0.14 (`+0xC70`) if position is negative (sign bit), else
   -0.1 (`+0xC78`). The pull back is a constant, not proportional to the
   position, and stronger from below than from above.

*Which model.* Index = 15 + `int(position + 0.5)`, the conversion being
coprocessor function `0x18` (`0x0C001818`). In FV's program it goes to
`0x205A3`, the same bytes as cpres1's `r0 = fix f1`, and the program sets
`MODE1 = 0x18000` once (`0x20080`) and never again: bit 15, TRUNC, is on,
so `fix` truncates toward zero. With position in [-15, 15] the index runs
1-30; entry 0 (Jane 701, Grace 2829, Honey 2963, jeans 1582, 14's 436) is
never picked. Index 15 covers positions above -1.5 and below 0.5, two units
wide; every other index one unit. A higher index means a more positive
position. Which way that moves the chest on screen is in the models, not
the code. The model is stored in `+0xC94` and returned.

At rest (no kick) the constant pull keeps the position swinging about 0:
from 0/0, worked through the five steps above in floats, it settles within
±0.26, so the resting model is entry 15 (Jane 772, Grace 2844, Honey 2978,
jeans 1597, 14's 2813). Entry 16 (Jane 773) needs position ≥ 0.5.

*Reset.* `change_unit_init` sets only the three constants. Nothing in the
program ROM stores to `+0xC64`, `+0xC68`, `+0xC6C`, `+0xC90` or `+0xC94`
outside this routine. The one reset found is in it (`0x31A60`): when
`also_mode` is 9, `0x500031` is `0x11` and `+0x1A4` bit 16 is set, velocity
and position are set to 0 and the slot model is returned. Whether a block
clear of the fighter's work area zeroes them at a round start was not found.

*The per-frame list.* At the top (`0x318B4`), with `+0x1A4` bit 9 set and
bits 14 and 16 clear:

- If `+0xC90` is already set, the spring is not stepped. If `+0x1A4` is
  exactly `0x200` the model is list[`+0x1AA` mod count]; otherwise the slot
  model. `+0x1AA` is the motion frame (the move script steps against it),
  so the list plays at one entry per motion frame and wraps.
- Otherwise `+0xC90` is set, and the list taken (as above, `0x200` check
  included), when list[`+0x1AA` mod count] equals the model last
  picked (`+0xC94`) and |velocity| ≤ 0.8. Failing that, `+0xC90` is cleared
  and the spring runs.

Any other `+0x1A4` clears `+0xC90` and runs the spring. So the list takes
over only where it meets the spring's current model with the spring nearly
still: Jane and Jane in jeans's lists never hold their resting models (772,
1597), so they enter only from entry 16 or another listed model. While on
the list the spring is frozen and `+0xC64` is not updated, so the first
frame back measures the distance against the one from before the list
(capped by the 4.2). The list never updates `+0xC94`, so the model compared
on the way in is the spring's last pick, not the list's last entry.

*Which motions leave `+0x1A4` at `0x200`.* `set_mot_dat` (`0x1B880`) starts
the word from the motion's setup script, `0x6411E94[motion]`: its first word,
with bit 21 cleared and, when bits 8 and 15 are both set, bit 15 moved to 16
(`0x1B964`). The setup ops follow at +12 (lengths at `0x1CE86`; op 16 is
2 + 2 × its count byte; op 0 or op 8 ends them, and the script starts there,
past op 8's byte). Setup op 2 sets bit 1 and gives three frames (`+0x808`,
`+0x80A`, `+0x80C`), which the per-frame step (`0x1C180`, after `+0x1AA` is
counted at `0x12BF8`) walks through: from the first, bit 1 goes (and bit 16
when bits 8 and 15 were set); from the second, bits 26, 16 and 8 go, bit 15
too with bit 8, and bit 2 comes on; from the third, bits 12 and 0 go (bit 0
earlier, from setup op 3's frame `+0x850`, while bits 12 and 4 are set). Past
the third it re-runs all three every frame. Then the script after the setup
(`0x1C24C`, op table `0x1D028`, each op a frame word and run once the motion
frame reaches it) changes the word: op 5 sets, 6 clears and 7 flips the bit
named by its operand, op 1 flips bit 21, op 13 sets or clears bit 25, op 22
sets bit 6. Bit 20 is cleared when the script has run (`0x1C950`), and in the
same tail (`0x1C9A4`-`0x1C9FC`) bit 5 is set while the setup word (`+0x804`)
has bit 7, and bit 7, if set, cleared (the place re-anchored). All of it runs
before `rob_disp`, so the chest sees this frame's word.

VF2 does the same (`set_mot_dat` `0x1A1E4`, setup ops at +8 with lengths at
`0x1B7F6`, phase step `0x1AC14`, script `0x1AD5C`, tail `0x1B43C`) with three
differences, in `rig.flags`: the second frame drops bit 28 where Fighting
Vipers drops 26, script op 13 is bit 27, and `set_mot_dat` gives motion
`0x12E` a third frame of `0x49` and `0x375` one of 46 whatever the setup says
(`0x1A49C`, `0x1A4A8`). Left out: more such frames for `0x12D`, `0x2A1`,
`0x21A`/`0x21B`, `0x220`, `0x2B9`/`0x2BA`, `0x45F` and the ids at `0x1B9A2`,
and the bits 4 and 24 `0x1AC14` sets for `0x2DE`, `0x8D`, `0x8B`, `0x99`,
`0x59` and `0x5B`, all only with a setting in backup RAM (`0x599000+0x3351`)
on. VF2 script op 3 also sets bit 4 through `0x18B14` with the launch; it is
left out with the launch itself (the motions carry the arc), as what clears
it again is the landing, fight state. Bit 4 is in the look's gate, so in the
five motions with op 3 (110, 742, 743, 804, 1194) the explorer's head may
look at the opponent in the air where the board's does not.

Stepped that way, 86 of the 1054 motions with a setup run at exactly `0x200`
from their first frame to their last, and no other motion reaches it on any
frame: they are stances, win poses and other standing loops (21, 116,
123-125, 169, 187-192, 224, 231-233, 271, 272, 299-303, ... 1046). Motions
8, 152, 426 and 914 run at `0x208`, the list's gate with something else, so
once on the list those draw the slot model. Checked against MAME's attract
mode (30,000 frames, both players): on 29,480 of the 29,481 frames where the
board's `+0x1A4` was `0x200` the motion gives `0x200` too, and the list's
gate (bit 9 without 14 and 16) agrees on 58,412 of 58,414 frames. The
misses are fight state: on 55 frames in 116, 224, 271, 448, 904 and 928 the
fight had also set bit 7 (`0x280`), which the motion alone does not say.

The rule itself was checked the same way, with `+0x1F48` bit 1 forced on for
Jane, Grace and Honey so their chests bounce in attract mode (20,000
frames): fed the board's own word, frame, `+0xC94` and velocity, it gives the
board's `+0xC90` on 16,889 of 16,920 frames, 5,709 of them on the list (Honey
in 271, 272, 302 and 21, Grace in 224, 776 and 1016, Jane in 904 and 116, and
Grace in 152 at `0x208`). The 31 misses fall where a motion changes, where
the word read after the frame is not the one the chest saw.

*What the explorer draws.* The spring and the list. With the Armour
switch on upper or all broken, Jane, Grace, Honey and Jane in jeans draw
their chest as the 31 models' entry 15 + `int(position + 0.5)`, stepped once
per frame of playback (`bounceStep`/`bounceChest` in `js/vf2fighters.js`)
with the five steps above in 32-bit floats. The head is slot 2's translation
in the posed skeleton and the waist slot 0's, the waist as the frame before
left it. An intact chest keeps its slot model. Worked from 0/0 with no kick,
the code settles within -0.25..0.21, entry 15, as above. The Animation
panel's armour readout shows the model, entry, position and velocity per
frame.

These are the explorer's choices, not read from the ROM:

- The spring starts at position 0, velocity 0 whenever the fighter is
  loaded or its armour switched (the explorer's round start). The last
  distance (`+0xC64`) starts at the first frame's, so it starts with no kick.
- When a motion starts or loops, the explorer stands the fighter back where
  the motion starts, which the board's fighter does not do. On that frame the
  waist is that frame's own, not the one before.
- A frame picked on its own (scrubbing) holds the spring and only takes the
  new distance.

The per-frame list is followed on the move flags `moveFlags` steps from the
motion's setup and script, as above (`chestFromList`): on a frame with bit 9
and neither 14 nor 16, the chest goes on the list when list[frame mod count]
is the spring's last pick and |velocity| ≤ 0.8, stays on it while the gate
holds, and draws the list's model at exactly `0x200`, the slot model the
break left (Jane 731, Grace 1982, Honey 2540, jeans 1581) otherwise. On the
list the spring is held and its last distance kept; the waist copy still
moves on. In headless Chrome, played from the loaded fighter in motion 21,
Grace joins her list at frame 10, Honey at 21 and Jane at 27, each from a
spring that had settled near its rest, and stays on it through the loop.
The fight's own changes to `+0x1A4` (a hit, bit 7, `fix_hara`'s bit 4) are
left out.

**The hips (read from the ROM; drawn).** `rob_disp` calls
`koshi_unit_change` (`0x31ADC`) for slot 9 only (`0x1A024`), the same way as
the chest: the slot's own model (`+0x64`) in `g0`, and whatever comes back is
drawn on the hips' own matrix, already sent. The routine sends no matrix,
offset or scale; it is a model swap.

`0x6422400[char]` is 0 for everyone but Honey (2, `0x64224A8`), Bahn (4,
`0x6422468`) and entry 15. A table is eight pointers (0 is none):

| Offset | What | Honey | Bahn |
|---|---|---|---|
| `+0` | two pairs: standing, low | 2927/2927, 2931/2931 | 2405/690, 2407/1788 |
| `+4` | 80 pairs by frame (move flag bit 9) | none | none |
| `+8` | two pointers: 48 pairs by `+0x7FA`, 12 pairs by `+0xAEC` (move flag bit 4; the second with bit 14) | 2932..2962; 2932..2937 | 3189..3219/3243..3273; 3179..3184/3233..3238 |
| `+0xC` | motion `0x31`: halfwords by frame | none | 3223 to frame 30, then 3224..3232 from 31 to 39 |
| `+0x10` | motion `0x180`: halfwords by frame | 2932, up to 2962 at 21, back to 2932 | none |
| `+0x14` | 50 halfwords, a count at `+0xC8C` | 2932..2962..2932 | none |
| `+0x18` | broken hips | 2537 | none |
| `+0x1C` | per-motion lists: (motion, list) pairs to motion 0; a list is a count, then that many pairs | 302 and 1014 (90: 2932 to frame 74, then up to 2955), 1029 (2: 2927) | 548, 632, 633, 656, 832 (41: 3179 up to 3188 at 10, back to 3179; broken 3233..3242) |

A pair is the intact model, then the broken one; the routine adds 2 to the
address once `+0x1F48` bit 9 is set. Honey's own slot-9 model is 2460, which
the routine replaces in nearly every frame; Bahn's is 2405 (690 once broken).

The routine, in order (`g7` the player, `+0x1A8` the motion, `+0x1AA` its
frame, which `set_motion` starts at 1; `0x5000A2` is the versus win streak:
at a round's end `0xE05C` adds one to it while the side that won (`0x50004E`)
is the side that won before (`0x500066`), and starts it again otherwise):

1. *The ring.* When this fighter's `+0x1B1` is 5, `0x5000A2` is at least 20,
   the motion is `0x19D` or `0x19E` at frame 17, and `+0x5B8` bit 0 is clear,
   `+0x254` is saved to `0x50A420` and a radius `0x50A42C` set to 0.01. Each
   call it grows 0.16 and goes back to 0 past 15. `kuc_sukebo_check`
   (`0x31DEC`) sets `+0xC8C` to 1 while the distance from that point to the
   waist (`+0x1F4`) is within 0.4 inside the radius: a ring sweeping out
   from where that move was played. Who has `+0x1B1` = 5 was not read. Then the table is looked up; with none, the
   slot's model is drawn.
2. Honey's win-streak hips: with `+0x18`, a streak of at least 100 and the
   hips broken, `+0x18`'s first halfword (2537), whatever the motion.
3. Motion `0x31` with `+0x1A4` bit 29 clear: `+0xC` halfword
   [min(frame, 40)], or the slot's model with no list. `+0xC8C` cleared.
4. Motion `0x180`: the slot's model until the streak is 10, then `+0x10`
   halfword [frame] (no limit), or the slot's model with no list.
5. `kuc_motion`: the first `+0x1C` entry for the motion, pair
   [min(frame, count - 1)]. Taken only if it differs from the slot's model;
   otherwise on to 6.
6. By the move flags `+0x1A4`: bit 4 (set by `fix_hara`, `0x19B44`, with the
   fighter's place on the waist), `+0x8`, unless `+0x1C` equals `+0xC5C` or
   `+0xA0E` is set: with bit 14 the `+0xAEC` list [`+0xAEC` mod 12];
   otherwise, unless status `+0` bit 3 or `+0x7FA` is 0, the `+0x7FA` list
   [`+0x7FA`, or 31 + (`+0x7FA` mod 17) from 31 on]. Bit 16: 7 below. With
   `+0xC8C` set, the `+0x14` list [`+0xC8C` + 1], counting `+0xC8C` up and
   back to 0 (and the slot's model) at 50. Bit 9: `+4` [min(frame - 1, 79)],
   or the slot's model with no list.
7. The standing pair, or the low pair while the waist's height `+0x1F8` is
   under 0.4 (0.6 with `+0x1A4` bit 15; plus the raised floor `0x50A010` when
   `+0x624` is set).

**What the explorer draws** (`readHips`, `hipsModel` in `js/vf2fighters.js`).
`readHips` reads `+0`, `+8`, `+0xC`, `+0x10` (as many entries as motion `0x180`
has frames, plus one), `+0x18` and `+0x1C`; `hipsModel` follows steps 2 to 5
and 7 every frame, and step 6's bit 4 in an own-flight jump (below, "The hips
in the air"), the hips broken when the Armour switch breaks the lower
half. Otherwise the hips do not use the move flags, and the explorer has no other fighter or game state, so it
takes `+0x1A4` as 0 (0.4 in step 7), the streak as under
10 unless the 100-win switch (`?hentai=baka`, Honey only) asks for 100, no
ring (`+0xC8C` 0) and no raised floor. The waist
height is the explorer's slot 0 `y`, which is the board's `+0x1F8` above a
floor at 0. So:

- Honey stands on 2927 and drops to 2931 when her waist goes under 0.4
  (motion 1 from frame 26 to 48); her skirt lifts through the end of 302
  and 1014, and through motion 384 only on the 100-win switch, which is
  also what puts her in 2537 in every motion once her lower half breaks.
  In motion 49 (`0x31`) she has no list and shows her own 2460.
- Bahn stands on 2405 (690 broken), drops to 2407 (1788 broken) under 0.4,
  plays 3223..3232 through motion 49 and his coat swings through 3179..3188
  (3233..3242 broken) in motions 548, 632, 633, 656 and 832.

The Animation panel's armour readout shows the hips' model per frame, and in
the air the count. Only the hips in the air are checked against MAME. Every
list picked by motion id (with or without the frame) is drawn; what is left
out hangs on fight state, not on the motion:

- `+8` outside the own-flight jumps: the jumps a command or a hit launches
  (Honey's in attract are all of these) take their air steps from the
  command record or the hit, and `+8`'s second list needs move flag bit 14,
  which no own-flight jump sets.
- `+0x14`, the ring: needs `+0xC8C`, set by `kuc_sukebo_check` (`0x31DEC`)
  from the ring at `0x50A420`/`0x50A42C`.
- `+4`: needs `+0x1A4` bit 9; neither Honey nor Bahn has the list.

**The hips in the air (read from the ROM; drawn; checked against MAME).**
`+8`'s first list swings Honey's skirt and Bahn's coat tail while the fighter
falls. Motions 78, 79, 81, 83, 85, 88, 96 and 98 fly on their own: their
setups have op 3 (`0x1BAB0`: the launch frame `+0x80E`, the frame held
`+0x816`, the landing frame `+0x818`, the landing height `+0x81C`) and op 9
(`0x1BCC0`: the steps in the air `+0x5BE`, n, and a pull, stored as
-(pull × g) at `+0x5CC`). `flightClocks` runs the routines that move them a
tick at a time:

1. The jump's action (`0x14204`) launches once the frame reaches `+0x80E`:
   `fix_hara` (`0x19B44`) puts the place on the waist and sets `+0x1A4` bit 4
   and status bits 2 (in the air) and 3 (rising). The speed `+0x30` is
   (g - `+0x5CC`) × (1 + n) / 2 + (`+0x81C` - waist y) / n, with g the boot's
   `0x50A000` (`0x3BAB1F2D`, set at `0x7284`), so the n'th step lands at
   `+0x81C`.
2. Each step (`0x1880C`) takes g from the speed, adds `+0x5CC`, and moves
   the height by it; `rob_check_stage` lands the fighter once it is under
   `+0x81C` + 0.02 (`0x18A4C`), which clears bit 4.
3. Before the step, `0x1CCAC` clears status bit 3 once the speed is below 0,
   and holds the frame at `+0x816`, or at `+0x818` + 1 less the steps left
   where that is later.
4. `rob_disp` (`0x19F10`) counts `+0x7FA` up while bit 4 is set and bit 3 is
   clear, and sets it to 0 while bit 4 is clear. It runs twice a frame:
   `0x1FB50` draws the fighters inside the walls first (`0x21C14`), on every
   stage but the one whose flags (`0x6CE1048[stage]`) have bit 25 (stage 6),
   and `koshi_unit_change` is not reached on that pass; then `0x1FE10`, whose
   hips are the ones seen. So the hips step two entries a frame.

While rising the hips are the slot's own model (Bahn 2405, Honey 2460), not
the standing pair. The playback holds the frames as the board does; the
explorer's fighter does not leave the ground. Motions 71, 72, 128 and 806
have both ops but land at 1.5, above where they start, so they land on the
first step and play as before.

Graded against MAME's attract (`fvipers`, the shared build): Bahn plays
motion 98 at frame 3470, launches at frame 7, rises to frame 26, holds 27
for 16 frames and lands on 29. On every one of the 44 frames from the start
to the landing the explorer has the same motion frame and hips model (2405
rising; then 3191, 3193, ... 3217, 3219, 3219, 3218 at counts 2 to 34), and
the hips' place (`+0x260`) equals the waist's (`+0x1F4`) in MAME as slot 9's
origin equals slot 0's in the explorer. Honey's airborne motions in attract
are all hits and command jumps (589, 798, 706, 511, 624, 804, 606, 593, 346,
621), so her flight is the same code on her table, not graded.

**The hip matrix.** `koshi_unit_change` only picks the model; the matrix it
is drawn on is slot 9's, built by `calc_unit_mat` (`0x17160`) once a frame
and stored on the coprocessor. `rob_disp`'s part loop (`0x19F78`) adds
nothing to it: for each slot it sends `0x1B803737`, the player byte `+4` and
`slot × 0xC`, which loads the matrix `calc_unit_mat` stored under that index,
then the model. Slot 9's stretch of `calc_unit_mat` is `0x17838`..`0x17910`:

1. `0x1000202` pops back to the waist's matrix (slot 0, pushed at
   `0x172E0` after it was stored): the hips hang off the waist, not the
   chest.
2. `0x3000606` moves by `+0xEC`, the skeleton's entry 8 (player `+0x8C` +
   8 × 12, copied from the character record's `+4`): slot 9's offset in the
   waist's frame.
3. `0x1F803F3F` with `+0xBC4`, `+0xBC2`, `+0xBC0`: float object 9's euler, Z
   then Y then X (the pose's angle table runs from `+0xB8A`, 6 bytes an
   object; the head's is the same op with `+0xBAE`..).
4. `0x4800909` `+0xC20`, `0x4000808` `+0xC1E`, `0x5000A0A` `+0xC22`: Y, X, Z
   by object 9's blend (`+0xBE8` + 9 × 6), what is left of the last motion.
5. `0x5000A0A` `+0x172`, then `0x4800909` `+0x170`: the pelvis look, Z then
   Y; the motion's held angles (object 17, `+0xBDC`) or the aim 0x2901C
   worked out, which for all but one motion is the quarter-turn roll.
6. `0x1A803535`, player, `0x6C` (9 × 0xC) stores it; `0x7800F0F` reads the
   translation back to `+0x260` for `set_coli_ball_data(9)`.

No scale, and no offset or turn of its own on top of the bone. So the hip
model's matrix is: waist × T(skeleton entry 8) × object 9's euler × blend ×
look. The explorer's matches it step for step: `buildPose` turns slot 9 from
the waist's rotation by `A(9)`, the blend and the held look or aim, and
`onOwnSkeleton` places it at the waist plus the waist's matrix times
`offsets[9]` (the same entry 8), with `SLOT_PARENT[9] = 0`; the hip model is
drawn on that matrix as it stands. Nothing to change.

**The midriff.** `rob_disp` calls one more routine after each slot's model,
picked by the table at `0x1A0EC`: `0x1A1E0` for slot 1, `0x1A12C` for slot
2, `0x1A2D8` for slot 9 and `0x1A4B4` for the rest. `0x1A2D8` draws the band
that closes the gap between the chest and the hips, on slot 9's matrix as
it still stands from the hip model. (An earlier note here had it on "the
spring's own vectors"; there is no spring, and the matrix is slot 9's.)

The player's `+0x190` is its character record (`0x640D2B0[char]`, set at
`0x1244C`); the record's `+0x24` points at the midriff, a ROM struct. Characters 10
to 12 have none, so nothing is drawn; 0 to 9 and 13 to 15 all have one. Jane's is `0x642B3CC`:

| Offset | What |
|---|---|
| `+8` | the model whose texture points and material it is drawn with (the only field `0x1A2D8` reads) |
| `+0x70` | the chest's ring: 12-byte points in the chest's frame |
| `+0xD0` | `n`, the link count (20) |
| `+0xD4` | `n` links of `0x28` bytes: an attribute, a normal, two points |
| `+0xD4 + 10n × 4` | a closing word |
| `+0xD4 + (10n + 1) × 4` | two index bytes a link |

The work is split. `calc_unit_mat`, once slot 9's matrix is stored
(`0x178E0`) and its collision ball sent (`0x18304`), runs `0x17A30` ..
`0x17BA4` with slot 9's matrix still current:

1. `0x800101` pushes, `0x6000C0C` inverts it in place and `0x9801313` (a
   float add) waits for the inverse: H⁻¹.
2. `0x1B803737` multiplies by the stored slot 1 (the chest, C): H⁻¹·C, the
   chest's frame seen from the hips'.
3. `0x14802929` for each of the 16 points at `+0x70`, read back into the
   player's `+0x1860` + 12 per point: the chest's ring, now in the hips'
   frame. Only 8 are ever used.
4. Geometrizer command 5, polygon data, to address `player << 8`, `10n + 1`
   words: each link's attribute and normal, then its two points, each taken
   from `+0x1800 + index × 12` (chest point `index - 8`) when its index byte
   is 8 or more, else the link's own point, which is the hips' ring and
   already in the hips' frame; then the closing word.
5. `0x1000202` pops.

`0x1A2D8` itself takes `r4 = record +0x24`, or `0x642F9EC[char]` when
`+0x1F48` bit 1 (the chest broken) is set, and returns if it is 0. It sets
geometrizer mode 3 (`0x58F0`), which makes the board work out each face's
normal from its points and skip the stored one. It reads the model table
entry `0x20E0004 + (+8) × 16` and sends `0x101` with the entry's texture
points, its material (plus `hi16` of its fourth word × 4 for player 2, the
other player's colours), the object address `player × 0x100 + 4` (the
polygon RAM written above, past the first attribute and normal) and a count
of -1 (to the closing word). In some move states it swaps the material word
for `1 << 23` or `0x802000` (the hit flash, below). Then it sets mode 1 again, and calls
`kosi_mino_disp` (`0x31E54`, the skirt panels) and the default `0x1CB2C`.

So the midriff is drawn in the hips' frame on the hips' matrix: the hips'
ring stands as stored, and the chest's ring is H⁻¹·C·p. Every link is a
triangle (`attr & 3 = 2`), which reads its first point and skips the second
(each link stores the point twice). The link types alternate 3 (`0x1702`)
and 1 (`0x1502`), so the strip zig-zags between the two rings and closes the
waist in 16 triangles; the last links add two slivers by the hips' origin.
In the rest pose the chest's ring lands on the points the links store for
it, a band 0.008 tall (the ring is 0.15 across) that the chest and hip
models cover. It shows when the chest bends away from the hips: Bahn's
motion 360, or 362 for anyone. A broken chest keeps the same points; only
the model, and so the texture and material, change (for characters 2, 4, 7
and 15 the struct differs). For Honey that is her bare midriff (2461 for
2521), for Bahn 691 for 2406.

**What the explorer draws** (`readMidriff` in `js/vf2fighters.js`, `skinMesh`
in `js/bodies.js`). It reads the struct as above and keeps the links from
the first link's points on: those are `js/model.js`'s 40-byte records as
they stand (points, then the next link's attribute and normal). Every frame
it writes the chest's ring into the points the index bytes name, carried by
H⁻¹·C as The House of the Dead's chest-to-hips skin is, and draws the result
on slot 9 with the model's texture points and material, or the broken one's
when the Armour switch breaks the upper half. The opponent gets the same.
Checked in the view: characters 0 to 9 and their P2 looks, armour whole or
broken, motions 21, 360 and 362 stepped a frame at a time. Every chest-ring
point lands on the chest's drawn matrix to within 4e-8, and the band
changes shape against the hips by up to 0.07 in motion 21 and 0.38 (Sanman)
in 360, so it follows the pose, not the rest. The broken models
are the ones listed above, with P2's own for Honey (2625, 2493), Bahn (2402,
1707) and Sanman (1684, 1683). Sonic, Tails and the dummies draw none.
Not checked against a MAME picture. The move states' material swaps are drawn
as the hit flash (below).

*Lit by its planes.* `0x58F0` sends geometrizer command 7 (`0x707`), the
mode, and mode 3 is MAME's `geo_parse_nn_s`: the stored normal is skipped
and each face takes `(p1 - p0) × (p2 - p0)` of the strip's two last points
and its new one, for its lighting and for which side faces the camera. So
`readMidriff` marks the mesh `planeNormals`, and `decodeModel` takes the
plane path a mode-2 game uses for every model. Walking the midriff's bytes
the way `geo_parse_nn_s` does gives the explorer's face normals on all 16
band faces (dot 1.00, Jane and Bahn in motion 21). It matters: the plane and
the stored normal are 27° (Jane) to 79° (Bahn) apart on average, and on Bahn
and Honey six faces of the band face the other way even in motion 21 (their
attribute's bit 17 is clear, so they are drawn from one side only). In
motion 362 Sanman's shirt band had a wedge missing at the belt on the stored
normals; on the planes it is whole.

*Player 2's block is not needed here.* A fighter model's material records
run on past the first `hi16` (of its fourth table word), and those are player
2's. Over all 28,658 faces of the playable records (0-10, 13-23) the second
block is the first with the texture on the other sheet (`th2` bit 12) and
palette entries 1-5 moved to 8-12 and 29/30 to 31/32, nothing else: the rows
`send_tex_col_part` and the skin upload fill for the second player. Ordinary
parts hand the coprocessor the player byte instead (`0x5A48`). The explorer
draws every fighter, opponent included, from player 1's block over sheets and
rows filled for that fighter alone (`rivalSheets`, `rivalColours`), so the
midriff stays on player 1's block like the rest of the body.

**The skirt (read from the ROM, measured against MAME).** `kosi_mino_disp`
(`0x31E54..0x32A08`) is the call at the end of `0x1A2D8`, the hips' draw. It
draws the four skirt panels of `0x6421DE0` (the table, models and fixed
placement are under "Shoulder pads and skirt" above) for characters 0, 1, 13
and 14 while `+0x1F48` bit 9 (hips broken) is clear; otherwise it clears
`+0x1B20..0x1B26` and draws nothing. Each panel is `set_obj` on the hips'
matrix after its translate and `ang_z`, `ang_y`, `ang_x` (`0x0A`, `0x09`,
`0x08`); the swings below are added to the turns there.

What it reads. `calc_unit_mat` leaves each matrix's angles in the player
struct, from `Fn_get_glo_ang` (`0x51`), whose third angle is the roll
`atan2(col0.y, col1.y)`: the hips' (slot 9, `0x179A4`) less a half turn in
`+0xAD4`, the left thigh's (slot 13, `0x1802C`) in `+0xADA`, the right
thigh's (slot 10, `0x17CE4`) in `+0xAE0`. `kosi_mino_disp` then works out each
thigh's lift from the thigh's bone vector, the skeleton entry for the knee
(`+0x128` for slot 13, `+0x104` for slot 10), turned by the thigh's rotation
(`0x69`, with `0x50A398`, which nothing writes, as the extra yaw):
`lift = atan2(v.x, sin(AD4)·v.z + cos(AD4)·v.y)` (`0x27`, `0x24`, `0x25`).
It stores the lifts over the board's own `+0xAD8` and `+0xADE`.

The swings. `0x50A380..0x50A388` are zeroed, then each thigh's spread is
`d = s16(AD4 + roll + 0x8000)`; a positive one goes to the "out" word
(`0x50A380` for slot 13, `0x50A386` for slot 10), a negative one to the "back"
word (`0x50A382`, `0x50A388`). With `by(s, f) = f ≥ 0 ? trunc(s·f) : 0`
(`0x17`/`0x18`):

| Panel | Terms | Swing applied | Final angle |
|---|---|---|---|
| 1 (`+4`) | `by(out13, cos(lift13+0x8000))`, `by(out10, cos(lift10+0x8000))` | X `0x4000 + s1` | `0x50A36E` |
| 2 (`+6`) | `by(back13, cos lift13)`, `by(back10, cos lift10)` | X `0x4000 - s2` | `0x50A372` |
| 3 (`+2`) | `by(out13, sin(lift13+0x8000))`, `by(back13, sin(lift13+0x8000))` | Y `0xC000 + s3` | `0x50A376` |
| 4 (`+0`) | `by(out10, -sin(lift10+0x8000))`, `by(back10, sin(lift13+0x8000))` | Y `0xC000 - s4` | `0x50A37A` |

Each `s` is `max(0, max(terms) - limit)` with the limits `0x3000`, `0x1E00`,
`0x1000`, `0x1000`. The panel 3 terms go to `0x50A3B8`/`0x50A3BA` and the
panel 4 terms to `0x50A3BC`/`0x50A3BE`. Panel 4's second term takes slot 13's
lift, not slot 10's. That is how the code reads, and the explorer keeps it.

Measured. A Lua tap on MAME's attract mode logged `+0xAD4..+0xAE0` and the
`0x50A380` words for Jane in 40 frames of 20 motions. The spreads come out as
above (Jane in one frame: `-16973 - 9058 + 0x8000 = 6737` in `0x50A380`,
and with her lift `-17765` panel 3's angle `0x50A376` is `0xCA16`, a swing
of `0xA16` = 2582, where the table gives `trunc(6737 · 0.991) - 0x1000`). The
explorer's thigh rolls agree with the board's to a few units. Its hips' roll
is the board's negated (the explorer's pelvis is built the other way about,
so `+0xAD4` is `0x8000 - roll` there, `-0x4000` at rest). Its thigh vector is
the board's after the facing's quarter turn, so the board's `(x, y, z)` is
the explorer's `(-z, y, x)`. With those two, the swings worked out from the
explorer's pose agree with those worked out from the board's own words to
within about 150 in most frames (motion 610 frame 12: board 1743/0/10665/0,
explorer 1657/0/10577/0). Some are a frame apart (motions 112, 29). Some
differ more where the board blends from the previous motion and the explorer
starts the motion fresh (116, 359, 477, 515, 620). Panels 1 and 3 swing in
kicks and wide stances; panel 2 mostly stays put, behind its lower limit.

**What the explorer draws** (`skirtSwings` and `swungExtra` in
`js/vf2fighters.js`). `poseFighter` works out the four swings each frame for
a fighter with a skirt, from the posed slots 9, 10 and 13 and the skeleton
offsets, as above, and adds them to the panels' turns before `placeExtra`.
It returns them as `skirt`. Jane's and Jane in jeans' empty panels 1 and 2
are still skipped, so for them only panels 3 and 4 (her hip flaps) move.
The hip matrix and the panels' fixed placement are as before.

**The shoulder pads (read from the ROM, measured against MAME).**
`kata_pat_disp` (`0x32A90..0x331B0`) is slot 1's entry in `rob_disp`'s
table at `0x1A0EC`, after the chest's own `set_obj`. It draws Raxel's, Mahler's
and B.M.'s pads (records, models and fixed placement are under "Shoulder pads
and skirt" above) on the chest's matrix. Its working words are in the block
whose pointer is at `0x500844` (`+0x60` for player 2), not in the player.

What it reads. `calc_unit_mat` reads back each slot's origin into the player
from `+0x1F4`, 12 bytes a slot (`0x172D4` slot 0, the waist; `0x17450` slot 2,
the head). The lean is head less waist, `d`: its yaw `atan2(d.x, d.z)` goes to
`+0xACA` and its pitch `atan2(d.y, d.x·sin(yaw) + d.z·cos(yaw))` to `+0xAC8`
(`0x27` is `atan2(second, first)`, `0x24`/`0x25` `arg2·sin`/`arg2·cos` of
`arg1`). For each pad the routine pushes, loads identity, loads the upper
arm's rotation with the facing in front (`0x69`: bone 6 at TGP `0x3A48` for
the left, bone 3 at `0x3A24` for the right, `+0x100` for player 2, and `+0x26`),
translates by the elbow's skeleton offset (`+0xD4`, slot 7's, on the left;
`+0xB0`, slot 4's, on the right) and reads the point back (`0x0F`) into
`+0xA9C` / `+0xAA8`: the upper arm's vector, turned. Its component along the
lean, `p = v.y·sin(pitch) + cos(pitch)·(v.x·sin(yaw) + v.z·cos(yaw))`, goes
to `+0xAE0` (left) and `+0xAD4` (right), with its two terms in `+0xADC`/`+0xAD8`
and `+0xAD0`/`+0xACC`.

The swing. `p` below 0 (bit 31 set) is a swing of 0. Otherwise it is
`atan2(p, sqrt(L² − p²))` (`0x1A`, `0x27`), `asin(p / L)` with `L` the offset's
x (0.25 for Raxel and Mahler, 0.28 for B.M.), and at most the record's `+2`
(`0x3800` for all three; an unsigned compare). The left pad's X turn is
`+0xABA + swing`, the right's `+0xAB4 − swing`, written to `+0xAC0` before
the draw. So a pad starts to swing out once its upper arm rises past square
to the head-waist line and is at most 79° up. The second model follows on the
pad's matrix, so it swings with it. Before `set_obj` the routine reads the
pad's matrix back (`0x05`) into `+0x1AC0` (left) and `+0x1AF0` (right).

Measured. A Lua tap on MAME's attract mode logged Raxel's block (`+0xAE0`,
`+0xAD4`, `+0xAC0`, `+0xAC8`, `+0xACA`) in 35 motions. `+0xAC0`, the right
pad's angle, is `0xC000 − asin(p / L)` from the logged `p`: motion 671
frame 8, `p = 0.08512`, a swing of 3624 and `+0xAC0` = −20007. The explorer's
swings from its own pose agree in which pad moves and which way in every
sample, and at frame 30 to within about 300 in most motions (994: 3301
against the board's 3301; 576: 8281 against 8314; 78: 10219 and 14336
against 9927 and 14336). Motions 527, 620 and 676 differ by 600 to 3300,
and at frame 8 more motions do, where the board is still blending from the
previous motion and the explorer starts each motion fresh.

**What the explorer draws** (`padSwing` and `swungExtra` in
`js/vf2fighters.js`). `poseFighter` works out each pad's swing from the posed
slots 0, 2 and the upper arm, and the elbow's offset, as above. The lean and
the arm are both in the explorer's frame, so the facing's turn and the
explorer's axes cancel in `p`, and nothing like the skirt's corrections is
needed. It adds the swing to the left pad's X turn and takes it off the
right's, for the second model as well, and returns the two swings as `pads`.

**Picky's hair (read from the ROM; not checked against MAME).**
`pky_kami_disp` (`0x1ADDC..0x1B23C`) is called from slot 2's entry in
`rob_disp`'s table (`0x1A0EC` → `0x1A12C`), after the head's own `set_obj`,
only while the character byte `+0x1B0` is 5 (Picky) or 18 and `+0x1F48`
bit 2 is set: the helmet (slot 2, 894 → 893) has broken. Its state is player
`+0xA70..+0xAA6`, which `pky_kami_init` (`0x1AD08`, called from
`action_init` at `0x12B2C` for every fighter) fills with immediates, not
from a per-character table:

| Field | Value | Use |
|---|---|---|
| `+0xA70` | (0, 0, −0.2510) | translate on the head's matrix |
| `+0xAA2`, `+0xAA0`, `+0xAA4` | 680, 908, 909 | the three models |
| `+0xA92`, `+0xA90` | `0x4000`, `0x8000` | 680's Y, then X turn |
| `+0xA8E` | `0xC000` | 908's Y turn |
| `+0xA96`, `+0xA94` | `0x8000`, `0x4000` | 909's Y (plus the swing), Z turn |
| `+0xA98`, `+0xA9A` | 0, 0 | the swing `s` and its speed `w` |
| `+0xA9C`, `+0xA9E` | 48, `0x300` | the speed's pull and its cap |
| `+0xA88` | 180.0 | the kick's gain |
| `+0xA7C`, `+0xA80`/`+0xA84` | 0 | last head height, this and last rise |

How the mesh is placed. On the head's matrix it pushes, translates by
`+0xA70`, and draws each model twice, each draw in its own push/pop, turns
sent in this order (`0x09` Y, `0x08` X, `0x0A` Z):

1. 680: Y `0x4000`, X `0x8000`, then Z `−s` and, again, Z `−(s >> 1)`;
2. 908: Y `0xC000`, then Z `s` and Z `s >> 1`;
3. 909: Y `s + 0x8000` and Y `(s >> 1) + 0x8000`, then Z `0x4000`.

So each lock is drawn at the whole swing and at half of it. Each draw is
`0x5BE4` (`g2 = 0x800000`) with `+0x1A4` bit 26 and `+0x1AA` at most 4, or
(`g2 = 0x802000`) with `+0x720` bit 2 and an odd `+0x1AA` at most 4;
otherwise `0x5A48`.

What it reads. Only the head's height, `+0x210` (slot 2's y; the slots'
places run from `+0x1F4`, 12 bytes each), and the move flags. After the
draw (`0x1B18C`) it steps the swing, so a frame draws what the frame before
left:

- `v = y − +0xA7C` (stored at `+0xA80`), `dv = v − +0xA84`, negated unless
  `+0xA84` has its sign bit set (last frame's rise negative);
- the kick, `trunc(1000.0 × 180.0 × dv)` (`0xC001818`, the coprocessor's
  float to integer), goes on `w`; `w` loses `+0xA9C` (three times it with
  `+0x1A4` bit 16 set and bit 15 clear) and is held to at most `+0xA9E`;
- `s += w`; at `0x3000` or more `s` stops there, at 0 or less it rests at 0,
  and either way `w` is cleared;
- `+0xA7C = y`, `+0xA84 = v`.

So the hair hangs at rest and is flung up whenever the head stops rising or
stops falling (a landing, the top of a hop), then sinks back at a pull of 48 a
frame. The fighters' records play no part.

**What the explorer draws** (`HAIR_PIECES`, `hairStep` and `hairSwing` in
`js/vf2fighters.js`; the profile's `armour.hair` lists characters 5 and 18).
`readArmour` gives Picky the six draws as extras on slot 2, placed with the
turns in the order above (`turnedInOrder` in `js/pose.js`).
`armouredFighter` adds them once the Armour switch breaks the upper half.
`poseFighter` keeps the swing per fighter, like the chest bounce: it draws
the swing the last step left, then steps on this frame's head height when
playback moves on a frame; a frame picked on its own holds the swing and
takes the height afresh, with no rise. The explorer starts from the first
frame's height with no rise (the board starts both at 0, which gives a kick
on the second frame); that is the explorer's choice. The move flags are
clear, so the pull is always 48. Returned as `hair`. In headless Chrome
Picky's hair hangs at rest in motion 3 and stands up by frame 30, and the
swing reaches `0x3000` in many of his motions.

#### The hit flash (read from the ROM; not checked against MAME)

Every fighter draw swaps the material word on its first frames in some
motions: `rob_disp` (`0x1A04C`, `0x1A09C`), `set_obj_fifo` (`0x5DC0`) and the
midriff (`0x1A364..0x1A390`). The rule, the same in each:

- `+0x1A4` bit 26 set and `+0x1AA` (the motion's frame, 1 on its first) at
  most 4: the material is `1 << 23`;
- else `+0x720` bit 2 set, `+0x1AA` at most 4 and odd: the material is
  `0x802000`.

`set_mot_dat` (`0x1B880`) fills both words from the motion's setup script,
`0x6411E94[motion]`: its word +0 goes to `+0x804` then `+0x1A4`, word +4 to
`+0x860` then `+0x720`. Bit 26 is set in motions 605-611, 820-831, 864 and
1006 (a white-out on frames 1-4); bit 2 of the second word in 706 and 949
(a blink on frames 1 and 3). The debris pieces and the armour flipbook
(`0x2E17C`) never flash.

A material pointer with bit 23 reads the board's texture-header RAM, word
`ptr & 0xFFFF`. Fighting Vipers does not copy that from data: at boot
`0x12154` (`sub_121BC`) fills five blocks of `0x1000` words from `0x800000`,
each with one four-halfword header repeated, taken from the program ROM at
`0x12240`, eight bytes a block. So every face drawn through a block gets
that header. Block 0 (`0x800000`) is `4000 0000 1C1E 0400`: a textured tile
of texel 15 at sheet 1 (960, 512), colour base 16, a flat light beige. Block
2 (`0x802000`) has colour base 567 (`th3 = 0x8DC0`), a bright green. The
tile is in texture set 36, the boot set the explorer loads for every
fighter.

**What the explorer draws** (`flashMaterial` in `js/vf2fighters.js`, the
profile's `rig.fighters.flash` and `modelTable.textureRamFill`). `textureAt`
in `js/model.js` builds the five blocks from the ROM once and reads a bit-23
material from them. `poseBodyRig` asks `flashMaterial` for the motion's
material at the shown frame; when there is one, every part, extra, osage
piece and the midriff, the opponent's too, is drawn from the model decoded
with that material (`model#800000`). In headless Chrome Jane's 605 and 820
draw every part from block 0 on frames 1-4 and as normal from 5; Honey's 706
and Picky's 949 draw from block 2 on frames 1 and 3 only; Grace's 21 never
flashes.

#### Jane's player 2 broken chest takes another material (read from the ROM; not checked against MAME)

Fighting Vipers only. In `rob_disp`'s part loop the model a slot draws is
settled first: the part list, then the hands, the chest (`0x31888`) and the
hips (`0x31ADC`). Then, when that model is from 0x62E to 0x64C (`0x1A02C`),
the draw goes through `0x5BE4` with `g2 = 0x68CBC`. That replaces the
model's own material pointer (the second word of its table entry) with
0x68CBC, the material of model 0x62D. The hit flash and blink still come
first (`1 << 23`, `0x802000`, as in the section above). Only Jane's player
2 record (13) has models in that range: its broken chest at rest, 0x63D,
and its 31 bounce models, 0x62E–0x64C. Their own materials share a colour
word, `…0085`, in 232 of 424 face records. 0x62D's has `…40B3` there. VF2
has no such test, and no other draw in Fighting Vipers uses the range.

**What the explorer draws** (`partMaterial` in `js/vf2fighters.js`, the
profile's `rig.fighters.recolour`). `bouncedDraws` keys every part model in
the range with that material (`model#68cbc`) on frames without a flash. The
keys are the same ones the flash uses.

Old code against new, Jane with the player 2 look and the Armour switch
breaking the upper half, motion 904 frame 1:

- Node: slot 1's 0x63D was drawn in its own material; now it is drawn in
  0x68CBC.
- Headless Chrome: the old picture gives her broken top yellow; now it is
  white.

Any motion shows the change, and so does the opponent in player 2's look.

#### Move trails (script op 28; read from the ROM, checked against MAME)

Many Fighting Vipers moves shed a stippled trail off the feet, the hands or
the waist: Bahn's swing (motion 624), Grace's kick (3), the floor puff of a
fall (283). It comes from move-script op 28 (`0x1C8CC`, six bytes), which
writes a kind to `+0xA25` (byte +3, with byte +4 shifted up a nibble) and a
life to `+0xA24` (byte +5). `set_mot_dat` clears the kind at `0x1B8C0` as a
motion starts, so a kind holds from its op's frame to the next op 28 or the
end of the motion; 308 motions carry one. VF2 has no op 28 (its script ops
stop at 23) and draws no such trail.

The bits of the kind: 0 lets the first ring drop; 1 is the waist and 2 the
floor; 5 and 4 the left and right foot; 7 and 6 the left and right hand.
The values the ROM uses (b3/b4/b5 → kind, motions):

| b3/b4/b5 | kind | what | motions |
|---|---|---|---|
| 1/1/9 | `0x11` | right foot | 101 (3@1, 86@10) |
| 3/0/9 | `0x03` | waist | 92 (32@43, 589@141) |
| 1/2/9 | `0x21` | left foot | 63 (74@2) |
| 1/3/9, 1/3/10, 1/3/6 | `0x31` | both feet | 45, 3, 1 (624@3, life 6) |
| 5/0/9 | `0x05` | floor | 3 (283@16, 515@9, 566@14) |
| 1/4/9 | `0x41` | right hand | 3 (709@20, 710@20, 868@15) |
| 0/0/9 | 0 | off | 125 |

Every frame `0x7BDC0` (skipped while `0x508000` bit 5 is set) drops sparks
for both players into two shared rings of sixteen, the first at `*0x500890`
and the second at `*0x500894`. A drop takes the ring's next slot (byte +0x42
plus 1, mod 16): the point at +0x74 + 12·slot, the slot's bit in the live
mask at +0x40, the kind at +0x174 + slot and the life at +0x64 + slot. The
points are the player's slot translations, `+0x1F4 + 12·slot`, in the
board's frame.

- `0x7BE10`, the first ring: bit 0 is needed. A kind without bit 1 drops
  nothing while the frame counter `0x500020` has bit 1, so two frames in
  four. Bit 1 drops at the body (slot 0) 0.2 lower (`0xBE4CCCCD` added to
  y); otherwise bit 2 drops at the body's x and z on the floor (y = 0). The
  life is always 15.
- `0x7BEDC`, the second ring, in this order: bit 5 at `+0x284` (slot 12, the
  left foot), bit 4 at `+0x2A8` (slot 15, the right foot), bit 7 at `+0x230`
  (slot 5, the left hand), bit 6 at `+0x254` (slot 8, the right hand), each
  with life `+0xA24`. Mirrored (`+0` bit 6), each pair reads the other
  side's slot. With `+0x1A4` bit 27 the feet's sparks go on the floor (the
  hands' don't). Nothing drops while the setup word (`+0x804`) has bit 8
  and `+0x1A4` has bit 2.

Then a task, `0x7C178` (installed by `0x7C140`), ages each ring: a live slot
takes its life's model and size (+0x44 + 2·slot, +0x134 + 4·slot), loses a
life, and is freed once the life falls below 0. A free slot's model is 0.
The tables are indexed by life, the per-stage ones by `0x500064 & 15`:

- bit 2 (floor): model `(*0x6444520[stage])[life]`, 0x453 on every stage;
  size `0x64445C0[life]` = 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 3, then all but 0.
- bit 1 (waist): model `0x64446C0[life]`, 0x3A2 at life 15 up to 0x3AD as
  the life runs out; size 1.
- bit 6 or 7 (hands): model `(*0x6444430[stage])[life]`, 0xEA4 for the
  longest lives up to 0xEA9 at life 0, the same on every stage; size `0x6444490[life]` = 0.2.
- otherwise (feet): model `(*0x64445F0[stage])[life]`: 0x44E/0x44D/0x44C on
  stage 0, 0x452/0x451/0x450 on stages 2 and 3, 0x449/0x448/0x447 on the
  rest; size `0x6444690[life]` × 0.35 (`0x3EB33333`), so it grows from
  0.175 to 1.575 at life 8 and falls back to 0 by life 12.

`0x21FAC`, from the frame's draw list (`0x1FEE8`), draws each slot whose
model is not 0 as push, translate to its point, scale by its size, turn
about y by the camera's yaw (`g13+0x26`, and a quarter turn more in the
second ring), draw, pop. The models are two-face stippled quads (the feet
and floor), 18-face (hands) and 32-face (waist) shapes.

**Order in a frame, checked in MAME.** Breakpoints on `0x7BDC0`, `0x7C178`,
`0x21FAC` and `0x1C8CC` in attract mode show, each frame: the script step
(op 28 included), then the draw (`0x21FAC`), then the drop (`0x7BDC0`), then
the ageing. So what is drawn on a frame is what the frame before picked: a
spark dropped on frame n shows from frame n + 1 with its life's model, and
for life L it is drawn L + 1 times. At the drop, `+0xA25` is set by the op
28s at or before `+0x1AA`: motion 0x21B's op at frame 7, 0x21C's at 4,
0x270's at 3, 0x24D's at 141 (and off at 142) and 0x368's at 1 (off at 2)
all show in the kind the drop reads on exactly that frame. The points are
that frame's pose: the board's body, hand and foot points at the drop,
compared without rotation (distances from the body and between pairs) with
the explorer's pose of Bahn, are off by 0.004 a frame over 93 frames of
motion 0x129 and by 0.0000 over 29 of 0x13B at the same frame, and by 0.08
or more a frame earlier or later. `0x500020` counts one a frame.

**What the explorer draws** (`js/fvtrails.js`; `trailScript` in
`js/vf2fighters.js`, the profile's `rig.trails`; `placeSparks` in
`js/app.js`). For a Fighting Vipers motion with op 28, the explorer runs
both rings frame by frame from frame 1 of the pass on screen, on a stand-in
for the fighter posed with `poseFighter` (no blend or look carried in), with
the motion's move flags (`moveFlags`), its setup word and the panel's
mirroring, the display tick as the frame counter. It draws what the frame
before picked, turned by the explorer camera's heading. The Animation tab's
"Move trails" field lists the motion's op 28s, switches the trail off with
the afterimages' switch, and picks the stage whose models the feet take
(stage 0 by default). Only the fighter's own sparks are drawn: on the board
the opponent's share the rings, and the opponent in the explorer plays a
reaction, not a fight. Before this the explorer drew none: on Bahn's 624 it
now draws 4 sparks on frame 5 (two 0x44E and two 0x44D, both feet) and 12
on frame 9, gone by frame 17; on Grace's 3, 1 on frame 2 and 10 by frame
12; on 589, one waist spark from frame 142 (0x3A2) to 157 (0x3AD); on 283,
the feet's sparks and from frame 18 the floor puff, two frames in four.

#### The throw spark (script op 30; read from the ROM, checked against MAME)

When a throw lands, Fighting Vipers puts a flash and a spray of red shards on
the thrown fighter's head or arm. It comes from move-script op 30
(`0x1C93C`, four bytes), which writes byte +3 to `+0xC56`. Only nine motions
use it, all of them a thrown fighter's: 898, 945, 959, 961, 997, 999, 1031,
1038 and 1051, whose throwers play 897, 944, 958, 960, 996, 998, 1030, 1037
and 1050. Each has one op 30, with byte 1 or 2. VF2 has no op 30.

In the same tick, after both players' scripts (`0x1C24C`), `0x278DC` (called
from `0x24AB8` and `0x24ACC`) does the following:

- It ORs `1 << +0xC56` into `+0x770` and clears `+0xC56`.
- If `+0x1A4` has bit 16, it stops there. None of the nine motions has that
  bit on its op 30's frame.
- Otherwise it sets bit 8 (`0x100`) in the module's `+0xA68` and copies that
  to `+0x772`.
- It takes the first free record of five at `*0x500844 + 0x748` (0x34 bytes
  each) and writes flags `0x101` to it.
- The record's point is `+0x1F4 + 12 · (+0x770)`. That is the slot the
  *mask* names, not the bit: byte 1 gives slot 2 (the head) and byte 2 gives
  slot 4 (the left forearm). The read comes before the tick builds its pose,
  so it takes the pose of the frame before.

`0x27FE0` clears `+0x770`, `+0x772` and the module word every tick.

`0x2DB78`, the step, picks models for each live record by its age, then adds
1 to the age. With flag bit 8, two tables apply. Each table is a u32 count,
a float size, then the models.

- `+0x1E` comes from `0x64212B4`: 15 models, 0x723 to 0x731 (the shards), at
  size 0.9, indexed by the age.
- `+0x20` comes from `0x64211E0`: 2 models, 0x733 and 0 (the flash), at
  size 5.0, indexed by half the age, but only while the age is under 2.

The record is freed once the age reaches the first table's count.

`0x2DDE8`, the draw, runs only while the module's `+0` has bit 31. It pushes,
translates to the point, scales by the size, then turns by the camera's
angles: z (`0x5000A0A`, `g13+0x28`), y (`0x4800909`, `+0x26`) and x
(`0x4000808`, `+0x24`). So each model is a full billboard. Then it draws and
pops.

**Checked in MAME.** Breakpoints in a fight (`0x50002B` = 3, `0x500031` =
0xA) give this order each tick: the scripts, the spawn (`0x278DC`), the draw
(`0x1FEE4` → `0x2DDE8`, then the trails' `0x21FAC`), then the step
(`0x2DB78`). So an op 30 on frame N shows nothing on N. It draws 0x723 + k
at 0.9 on frame N + 1 + k (k = 0 to 14), and 0x733 at 5.0 on N + 1 and N + 2.
The record's point matched the head (slot 2) as logged after the tick
before.

The fight made one record per op 30. `0x277D4`, a second spawner that picks
its slot by scanning the mask's bits, runs only behind `0x27428`'s game-mode
gate, in the round intro, so the explorer leaves it out.

**What the explorer draws** (`js/fvhitspark.js`; `hitSparkScript` in
`js/vf2fighters.js`, the profile's `rig.hitSpark`; `placeHitSparks` in
`js/app.js`):

- For each op 30 of the motion on screen, on frames N + 1 to N + 15, it draws
  the models the age picks. They sit at the slot's point in the pose of
  frame N − 1, on a stand-in posed with `poseFighter`, and are turned to face
  the explorer camera.
- It does this for the fighter playing the motion, and for the opponent when
  the opponent plays the thrown half of a throw.
- The afterimages' switch turns it off.

Before this the explorer drew no spark. In Node:

- On 898 (op 30 at frame 80, slot 4) it now draws nothing on frame 80. Frame
  81 has 0x723 at 0.9 and 0x733 at 5.0, frame 82 has 0x724 and 0x733, frame
  83 has 0x725 alone, frame 95 has 0x731, and frame 96 has nothing.
- On 959 (op 30 at 43, slot 2) it draws from frame 44 to 58, at the head.

In headless Chrome:

- Motion 959 on its own draws the spark on frames 44 to 58, and none on 43 or
  59.
- Thrower 958 with the opponent playing 959 draws the opponent's 0x723 and
  0x733 on frame 44, and 0x729 by frame 50.

Left out, because the explorer cannot reach them:

- The hit sparks a landed blow leaves through `+0x704`. They come from the
  fight's hit test.
- Op 29, armour damage, and the armour break (`0x2D588`, under "The hands"
  above). Both are fight state.
- Op 24, a wall-hit state.
- The re-anchoring of the place to the fight's history.

#### The light strobe (`+0x720` bits 5 and 10; read from the ROM, checked against MAME)

In some Fighting Vipers motions the light on a fighter flickers: the fighter
flashes bright, goes dark on the lit side and bright on the other, and back,
every six frames. Each player is drawn by a light of its own. Before each
player's `rob_disp` the draw (`0x1FDD0` for P1, `0x1FE44` for P2) sends
command `0xA0A` with the light vector (`0x50108C`) times that player's scale
(P1 `0x50109C`, P2 `0x5010A0`), as `0x5010AC` and `0x5010B8`. VF2 has no
`0xA0A` and no per-player light, so this is Fighting Vipers only.

Each tick `0x1F000` sets the scale:

- First it sets it to `0x50A0E0[fighter]`, which `0x2176C` fills with 1.0
  for every fighter.
- Then, at `0x1F1FC` (P1) and `0x1F258` (P2), if the player's `+0x720` has
  bit 5 or bit 10, or its `+0x1A4` has bit 26, it adds `fround(0.8)` to a
  phase of the player's own (P1 `0x5010F0`, P2 `0x5010F4`). If the result is
  above 2.0, the phase becomes -2.0. The scale takes the phase.
- From 1.0 the scale runs 1.8, -2, -1.2, -0.4, 0.4, 1.2, 2, -2, and so on.
  Above 1 the lit side is brighter. Below 0 the light comes from the other
  side, so the shader lights the faces that were dark.

The phase is set to 1.0 only at the fight scene's start (the camera task's
init, `0x1ED20`, at `0x1ED44`). It steps only on gated frames, and it carries
on from one motion into the next.

`+0x720` (the same word as `+0x860`) is set by `set_mot_dat` (`0x1B98C`) to
the setup record's second u32. Script op 25 (`0x1C870`) sets the bit its byte
+3 names, op 26 (`0x1C888`) clears it, and op 27 (`0x1C8A0`) sets bit 3 if
that byte is 1 and clears it otherwise. Nothing else sets bits 5 or 10. The
other writers touch bits 6 (the armour), 2 and 3 (landing), or are the
replay's save and restore.

63 motions have the gate. Examples:

- 551 has bit 5 from its setup, and op 26 on frame 33.
- 605 to 611 also have `+0x1A4` bit 26 on frames 1 to 25 through 29.
- 128, 129, 413, 820 to 831 and 864 are gated too.
- 1017 to 1021 use bit 10.

None of them is a motion the game loops.

**Checked in MAME** (watchpoints on `0x5010A0`, the frame counter `+0x1AA`
and `+0x720`, in the attract):

- Each tick runs the script, then the light, then the draw. So the gate the
  script leaves on frame N decides frame N.
- On the attract's 551, P2's light is 1.8 on frame 1 (the setup's bit 5),
  steps through frame 32, and is 1.0 on frame 33, where op 26 clears the bit
  before the light runs.
- Over a 420-second attract and a second run that forced bit 5 on P1, every
  one of 1066 gated frames stepped the phase as above, across 551, 605 to 611,
  659, 691, 981 and others.
- On the 729 logged frames inside a motion, the explorer's gate agreed with
  MAME's.

**What the explorer does** (`js/fvstrobe.js`; `lightFlags` in
`js/vf2fighters.js`; the profile's `rig.strobe`; `strobeFighter` in
`js/app.js`; the shader's `uLightScale`):

- It follows `+0x720` through the motion's setup word and ops 25 to 27, and
  `+0x1A4` bit 26 through the motion's flags.
- It steps the phase from 1.0 on each gated frame, and draws every mesh of the
  fighter (parts, pads, skin, osage) with the light times the scale. Each mesh
  sets the shared material's `uLightScale` as it draws and puts back 1 after.
- The opponent gets its own scale from the motion it plays.
- In a built string, the phase runs on from the links before.
- A motion on its own starts from 1.0 on every pass, as a fight would at its
  start.

Before this every fighter was drawn at scale 1. In Node, on motion 551:

| Frame | Before | Now |
|------:|-------:|----:|
| 1     | 1      | 1.8 |
| 2     | 1      | -2  |
| 3     | 1      | -1.2|
| 6     | 1      | 1.2 |
| 7     | 1      | 2   |
| 32    | 1      | -2  |
| 33    | 1      | 1   |

Motion 605 is 0.4 on frame 29 and 2 on 31. VF2 has no such light, so it has
no case. In headless Chrome, motion 551 frame 2 drawn at -2 differs from the
same frame at 1 on 1358 pixels (arms and shoulders).

##### The stage's base scale (stages 2 and 9)

A frame with the gate shut is not always drawn at 1.0. The fight's scene
start (`0x101B4` stores the stage, then `0x21614`) calls `0x21794`. That
fills `0x50A0E0[0..25]` with 1.0 (`0x2176C`), then on stage 2 or 9 lowers
some records' entries. `0x1F040` and `0x1F05C` read the entry for each
player's `+0x1B0`, the record number (13 and up are player 2's look), every
tick. Only the stage and the record decide it, so there is no fight-state
test:

| stage | record (`+0x1B0`)            | scale |
|-------|------------------------------|-------|
| 2     | 17 Bahn (P2)                 | 0.56  |
| 2     | 18 Picky (P2)                | 0.47  |
| 9     | 1 Grace, 2 Honey             | 0.54  |
| 9     | 4 Bahn                       | 0.92  |
| 9     | 6 Raxel                      | 0.87  |
| 9     | 8 Mahler                     | 0.51  |
| 9     | 14 Grace (P2), 15 Honey (P2) | 0.54  |
| 9     | 17 Bahn (P2)                 | 0.53  |
| 9     | 18 Picky (P2)                | 0.66  |
| 9     | 19 Raxel (P2)                | 0.57  |
| 9     | 21 Mahler (P2)               | 0.51  |

The game's `rig.strobe.stages` holds these as the board's single-precision
bits. `stageFighterLight` reads them, and `strobeAt` draws a shut frame at
that scale instead of 1.0; a strobing frame is still the phase. The Animation
tab's stage pick (`state.sparkStage`, the trails' `0x500064`) is now shown on
every FV motion, and it sets both the trails and this light. It is drawn for
the fighter and for the opponent, each by its own record. On stage 9, Bahn's
motion 551 is 0.92 on frames 0, 33 and 34, where the old code drew 1.0. Frames
1 to 32 strobe as before. On stages 0, 1, 3–8 and 10–11 every record stays at
1.0, so nothing changes there. VF2 has no such light, so it has no case.

Left out:

- Stages 3 and 4 shade by place; no other stage does (the only writers of
  `0x50109C`/`0x5010A0` are the record table, these two, stage 7's player-2
  scale from the scene's `+0x313`, and the strobe). Checked in MAME's
  attract, which fights on both stages:
  - Stage 4 (`0x21398`): the distance in x/z (coprocessor `0x2B`) from
    (-2.75, -4.5), turned by `0x50A022`, which turns a step a tick. The
    scale is 0 within 1.5, rises from 0 to 1.0 between 1.5 and 2.0, and is
    left alone beyond that. It matched MAME on 896 of 899 samples, the rest
    one tick out (≤ 0.07). The spot is always 5.27 from the origin, so the
    explorer's fighter, mirrored or not, and the opponent 2 away never
    reach it.
  - Stage 3 (`0x21470`): the scale is 0 while the fighter's z (`+0x1FC`) is
    *inside* (-47.39, 49.08) plus `[0x543004]+0x20`, and ×1 outside.
    `[0x543004]` is the stage object at `0x543200`; `+0x20` is its z,
    which a keyframe path moves (`0x6B168`, then `0x6B248`). At the origin
    the scale is 0 while that object is near z = 0, for both fighters. The
    window is 96 wide, so mirroring and the opponent's 2 make no
    difference. In the attract, MAME showed 0 on attract frames
    9880–9950 and 38275–38345. Nothing resets the object when the stage
    starts. On the second visit it still held -1980 from the first, and
    each pass (about 280 down to -1980) began at a different point, 322
    and 327 frames into the stage. What starts it was not traced. It is
    neither the scene's start nor the motion's frame, so this stays out.
  - `0x214C0` (a further scale by place, into `0x5010E8`) has no caller.
- Op 14's camera shake (`[0x500814]+0xFC`, damped by ×-0.5 each tick).
  It moves the fight camera. The Animation tab has no fight camera, only
  its orbit view, so no motion there can show it.
- Stage 2's `0x21884` and stages 5 and 7's writes to `0x501022`, and
  stage 7's player-2 scale from the scene's `+0x313`. These come from
  scene state that the explorer does not have, and `0x501022` is not this
  scale.
- The phase a real fight carries in from motions before the one on screen.

#### The burst (FV, `0x21E40`; read from the ROM, checked against MAME)

`js/fvburst.js`. After both fighters' `rob_disp` (`0x19F10`), FV's draw
calls `0x21E40` once for P1 (`0x500804`) and once for P2 (`0x500808`).
Its gate is `+0x720` bit 10 or `+0x1A4` bit 26, and both are words of the
motion itself (the light word and the move flags). While the gate is set, it
pushes and translates to `+0x1F4` (slot 0's point). If the motion frame
`+0x1AA` is ≤ 15, it then turns by the camera's yaw alone (`0x4800909`,
`g13+0x26`), scales by 0.5 on every axis and draws the model that the u16
table `0x6CE35E4` names for that frame: `38 37 36 35 34 33 32 31 30 2F 28
27 26 25 24 23` (frame 0 is never drawn, because frames start at 1). The models are flat
light-streak starbursts facing -z, and they shrink from ±4.9 (`0x37` at 0.5)
to ±0.7 (`0x23`). The gate holds on frames 1–15 of motions 605–611, 820–831,
864 and 1006 (bit 26), and of 1017–1021 (bit 10).

- Node, old code against new: the old code drew nothing. With the new code,
  605 draws `0x37` on frame 1, `0x33` on 5 and `0x23` on 15, and nothing on 16.
  1017 draws `0x35` on 3 and `0x28` on 10. 551 and 3 draw nothing. Headless
  Chrome shows the same models in the pool, and no page errors.
- MAME attract, with a breakpoint on P1's draw (`0x21EE4`) and `+0x1AA`
  read at that point: 84 draws in 607, 608, 611 and 864. All 84 used
  `table[+0x1AA]`, at the translate `+0x1F4`. A poll after each frame
  predicted 83 of them and missed none. The one it did not predict was
  a tick where the poll was out of step.
- The yaw is the explorer's view yaw (`cameraTurn(place, true)`). The
  Animation tab has no fight camera.
- VF2 has no counterpart. Its `rob_disp` (`0x18EF8`) has nothing more the
  explorer can show. What is left there:
  - the replay ring (`0x548000`, ruled out)
  - the foot table (`0x19D28`, ruled out)
  - `0x19E6C`, which has no caller
  - the knocked-off head piece (`0x62FAC`); the `+0x75C` model, once
    listed here as a shadow, is the piece's reflection and is drawn (see
    "Kage's and Pai's head piece")
  - `+0` bit 25's debug ball (`0x19790`) and the `+0x2A` name characters
    (`0x198C0`), which are set only by game-mode code
  - the per-slot culling in `0x19EBC`

#### Virtua Fighter 2's per-frame fighter draw (`0x1D1DC`; read from the ROM)

The caller of `rob_disp` in a fight is `0x1D1DC`. `g13` there is the camera
task (`[0x500814]`), so its `+0` bits 1 and 2 are "draw player 1 / player 2"
(set at `0x1D8F4` unless `0x50009C` bit 1 or 2 hides one). Each player is drawn
twice. The first pass (`0x1DEA8`, `0x1DF0C`) runs with camera `+0xFA` bit 0
set; the second (`0x1E394`, `0x1E3FC`) runs with it clear. Between them come
the stage's display lists. What else it draws:

- **The fighters' reflection, `0x20488` (`js/vf2reflection.js`).** On a
  stage with flag bit 5 (`0x6EEA0`), after the mirror floor (`0x20400`), it
  pushes a scale of (1, −1, 1) and calls `0x19C94` for each player that is
  drawn. That routine draws sixteen models from the character record's
  `+0x34` list (`[+0x190]+0x34`), each on its slot's matrix (command
  `0x1B803737`, player `+4`, slot × 12). That puts a flipped copy of the
  fighter under the floor. It is gated on player `+0` bit 7, the same gate
  `rob_disp` uses, so the copy shows whenever the fighter does. The models
  are a set of their own (Akira's are `0x997`–`0x9A6`; his body is
  `0x197`–`0x1A6`). Only stage numbers 10 and 11 have the bit (the Mirror
  stage, Dural's). Kage's and Pai's head piece has a reflection of its own,
  drawn from `rob_disp` (`0x193CC`) rather than here; see "Kage's and Pai's
  head piece".

  The explorer draws it in the Animation tab when the stage field names
  stage 10 or 11, for the fighter and the opponent. It uses the pose the
  fighter already has. The slot matrices `0x19C94` multiplies by are stored
  in the world frame, under the camera, so the copy is that pose reflected
  through the floor's plane, y = 0: the y row of each rotation and y of each
  translation negated (determinant −1; the board cull, by face normal,
  needs no change). A mirrored fighter needs no case of its own: its pose
  is already mirrored, and the list is read by slot. The hands are the
  list's own slot 5 and 8 models, not the hand shapes of script op 18,
  since `0x19C94` reads only the list. The copy has none of the other
  models or the flash material `rob_disp` adds.

  `0x19C94` skips a part when `0x2069C` finds it outside the fight
  camera's view. The Animation tab has only its orbit view and no fight
  camera, so that test is not modelled: every part is drawn, and no camera
  clip is made up for it.

  MAME's attract mode never shows it. Over 44,000 frames the demo fights'
  stage number (`0x500064`) went 1 to 9, back to 0, and round again, with
  3 between some of them. It never reached 10 or 11. So the reflection is
  read from the ROM and not checked against MAME.
- Stage pieces, already read for the Stage tab: `0x2173C`/`0x1E52C` (light
  and floor matrices, no models), `0x1EE34` (fog), `0x20708` (scenery),
  `0x20400` (mirror floor), `0x20064` and `0x202E8` (the raft), `0x21368`
  and `0x30500` (by stage flag and kind).
- `0x61B88`/`0x61AC4`: the floor shadows ("The fighters' floor shadows").
  With player `+0x2A` set, `0x61AC4` draws one entry of `0x50B100` instead.
- `0x21864`/`0x21904` (camera `+0` bit 7): 32 models on a 3-unit grid,
  copied from `0x201EE58` to `0x50B100`. That list is set up when a player's `+0x2A`
  becomes 1 (`0x53C14`), so it is game mode, like `rob_disp`'s `0x198C0`.
- `0x56EE0`: model `0x164` at the camera's target, while camera `+0xB0` is 1.
  Only the `CAMERA_POSITION` debug code (`0x55A18`) sets that.
- Camera `+0` bit 24 (`0x1E434`): model `0x129` at each player's camera
  point (`+0x1BC`, `+0x1E4`). Nothing in the program sets that bit with
  `setbit` or a `0x1000000` constant.
- `0x6CA84` walks three display tasks; all their handlers are bare `ret`s.
  `0x21220` is a bare `ret` too.
- `0x500068` bit 25 sends the whole draw to `0x1E9BC`, the replay.

#### The carried item (FV, `0x1A4B4`; read from the ROM, checked against MAME)

`js/fvitem.js`. Every frame `0x1CB2C` copies an item record into player
`+0x784`. The record is at fighter record `+0x2C`, plus `0x70 × (+0xAFC − 1)`
when `+0xAFC` is not 0, plus `0x38` when the fighter is mirrored (`+0` bit 6).
`0x1CB2C` reads the byte at `[0x50016c]+0x3350`, which would pick `+0x38`'s
table (Picky's board `0x6D3`). It was 0 for the whole attract and no motion
sets it, so it is left out.

Script op 17, on its own frame, with a byte other than 0, sets `+0xAFC` to
that byte and sets `+0` bit 27. A byte of 0 clears both. Loading a fighter
clears `+0xAFC`, so a motion the explorer plays cold starts on record 0
with bit 27 clear.

`rob_disp` draws while the record's first model (`+0x78A`) is not 0. It
draws that model on the record's slot (`+0x788`), moved by `+0x78C` and
turned Y, X, Z by `+0x79A`, `+0x798` and `+0x79C`. While bit 27 is set it
uses the second half instead (slot `+0x7A0`, model `+0x7A2`, offset
`+0x7A4`, turns `+0x7B2`, `+0x7B0` and `+0x7B4`), so the item moves to the
hand. Before drawing, it steps the ring index `+0xF00` (mod 4; not while
`0x508000` bit 5 pauses), reads the matrix back into the ring entry at
`+0xF34 + 0x34 × index`, and sets the entry's `+0x30` while bit 27 is set
and `+0x1A4` bit 2 is clear. It then draws `+0x7F8` (the record's `+0x34`)
at every entry whose `+0x30` is set, so up to 4 copies, one of them at
the item itself.

- Picky: the board `0x2A9` on slot 1. In the hand it is `0x2AA` on slot 5,
  with copies of `0xAAE`. Mirrored, the hand half is `0x970` on slot 8, and
  the copies come from the mirrored half's `+0x34`, `0xAAD`.
- Raxel: the guitar `0x703` on slot 1. In the hand it is `0x704` on slot 5,
  with copies of `0xAB0`.
- Bahn: byte 2 (record 1) is `0x707` on slot 5.
- Everyone else's record 0 has model 0, so they draw nothing.
- Op 17's motions: 75, 76, 600 and 603 (frames 9–60); 78 (9–150); 89, 412
  and 816 (7–45); 323 (15–70); 357 (19–75); 413 and 414 (5–47); 452
  (15–60); 509 (15–45); 601 (5–45); 602 (1–60); byte 2 on frame 1 in 1002,
  1015, 1025 and 1028.
- The ring holds only the motion's own frames. A motion played cold starts
  with an empty ring, and copies left over from the motion before (fight
  history) are left out.
- Node, old code against new: the old code drew none of these models. With
  the new code, Picky motion 1 frame 1 draws `0x2A9` on slot 1, and so does
  its last frame (60), which has no op 17. Raxel motion 1 frame 1 draws
  `0x703` on slot 1. Picky 89 frame 7 draws `0x2AA` on slot 5 and one
  `0xAAE` copy, by frame 9 three, and no board on slot 1. From frame 45 the
  board is back on slot 1. Mirrored, 89 frame 7 draws `0x970` on slot 8.
  Bahn 1025 frame 1 draws `0x707` on slot 5. Grace draws nothing. Headless
  Chrome shows the same models in the pool, and no page errors.
- MAME attract, with a breakpoint on the draw: Picky's slot 1 is `0x2A9`
  (`+0xAFC` 0) across many motions, and Raxel's is `0x703` in 928. Picky 413
  draws `0x2AA` on slot 5 (`+0xAFC` 1) from frame 5, with copies of `0xAAE`.
  Raxel 1015 draws `0x703` on slot 8 (`+0xAFC` 2), with copy model 0, so no
  copies. Bahn 1025 draws `0x707` on slot 5 (`+0xAFC` 2).
  `[0x50016c]+0x3350` stayed 0 throughout.
- The hit flash ("The hit flash" above) is drawn on the item too. `0x1A4B4`
  tests it twice, with the body's rule: the item's model at `0x1A638`
  (`+0x1A4` bit 26 and `+0x1AA` ≤ 4: `set_obj_thd` with `1 << 23`; else
  `+0x720` bit 2, `+0x1AA` ≤ 4 and odd: `0x802000`; else `set_obj`), and
  each copy in the ring at `0x1A6EC`, the same test. `+0x1AA` is the
  fighter's own frame, so the copies flash with the item, not on their own
  frames. `placeCarried` (`js/app.js`) takes the fighter's `flashMaterial`
  (the opponent's from the motion it plays) and keys every draw
  `model#material`, as the parts are.
  - Headless Chrome: Picky's board (681) and Raxel's guitar (1795) draw
    from block 0 (`#800000`) on frames 1–4 of 605–611, 820–831, 864 and
    1006 and as normal from 5; from block 2 (`#802000`) on frames 1 and 3
    of 706 and 949. Bahn's record 0 has no model, so nothing changes for
    him. No page errors.
  - MAME attract, breakpoints on the two `set_obj_thd` calls of the item
    (`0x1A64C`, `0x1A670`) and the copies' (`0x1A700`, `0x1A724`): Picky
    draws `0x2A9` with `1 << 23` on frames 1–4 of `0x25F` (607) and `0x263`
    (611), Raxel `0x703` on frames 1–4 of `0x261` (609) and `0x33E` (830),
    and player 2's Picky `0x674` the same way. In `0x263` the copies
    (`0xAAC`, left in the ring by the motion before) flashed on frames 1
    and 2 with the item. 50,400 frames of attract showed no blink
    (`0x802000`): 706 and 949 never played with an item on.

### Dead or Alive's stages (`js/doa.js`, `js/i960.js`)

Dead or Alive keeps no stage records to read. Each stage is a routine, named
by the table at `0x719E0 + 4 * stage` on Revision B, that writes the camera
and each piece's matrix to the coprocessor's port and the piece's model to the
geometrizer's. `js/i960.js` is just enough of an i960 to run them: the integer,
float and branch instructions they use, and calls with their register frames.
`js/doa.js` puts the program and data ROMs and a blank work RAM on its bus and
listens on the two ports:

- the copro port takes the matrix commands (load, multiply, translate, turn,
  as the routines chain them), and the geometrizer's draw command reads the
  current matrix and the model pointer, which the model table names;
- the stage number goes in at `0x5555BE`, and `0x54FCDD = 1` has the
  routines draw the banners and ropes as well. `0x5A75F4 = 2` is what the
  round start (`0x70950`) sets from the ring size float at `0x54FCE8` (10.0
  from boot, so 2; 12.0 would be 0): nine stages index short model tables
  with it to pick the ring floor and its border, so 2 draws the small inner
  square and the wide Danger Zone MAME shows;
- the two culling helpers, `0x72600` and `0x72680`, are answered "in view",
  and the view vector at `0x5B9870` is (1, 1, 1), so nothing is culled.

Stages 0-11 draw; 12-15 point at a routine that draws nothing, and are
skipped. A piece turned only about Y becomes a turn op; anything else becomes
the new `m` op, a 3x3 by columns.

A piece is named by the model table entry the routine last read before the
draw. Stages 0 and 10 hand some over from RAM instead: on its first pass the
routine copies five entries from 0x2099D90 to 0x59FFC0, each a table model's
material, mesh and face count with another model's texture points, and the
glass tower's three (models 15995-15997, night 18719-18721) take their points
from 128 blocks picked by the yaw the routine keeps (0x5A0064 = 0x5A0018 >> 8,
0x2098B90 for the first). That is the tower's reflection. On stage 10 two
more pieces (18403) step through their blocks every pass. The explorer names
such a draw by its material, mesh and face count (the table's first model
with all three) and draws it with the points the routine sent (`doaPoints`).
These were left out before: 5 pieces on stage 0 and 7 on stage 10, on both
revisions.

The textures are slabs of 0xC0000 bytes that the routine at `0x7CBA0` copies
into texture RAM by mode: rows 0-127 and 512-639 (modes 0, 3), rows 128-255
and 640-767 (modes 1, 4), rows 256-511 (modes 2, 5), modes 3-5 to sheet 1.
The stage's slab is `0xCADA0[stage]`, the fighters' `0xCADE0[char]`.
`buildDoaTexram` does the same, the stage's slab onto both sheets. No slab
carries a mip chain: MAME's texture RAM in a fight leaves rows 768-1023 of
both sheets empty and still draws the far walls, so the board is never sent
to a smaller level. The profile says `texture.mips: false` and the viewer
stays on level 0 (`Viewer.setMipLevels`); sampling the lower levels drew the
temple's walls black.

Colour, each checked byte for byte against MAME's RAM: the face palette is
484 colours from `0x62A42` (`0x70D80`), the luma 0x4000 bytes from data
`0xFC0000` (`0x10D0`), and the colorxlat a grey ramp (`0xFB0`) with the
stage's five rows of colour over rows 21-29 from `0x7A7E0[stage]`. The
fighters' rows are 1-9 and 11-19, from `0x7A760[costume * 15 + char]`, grey
in a stage with no fighter. The materials are 32 slots at `0x6B0`, and the
light a fixed one, down and away from the camera.

Revision A (`doaa`, Model 2A) is the same game a build earlier. Its data,
model and texture chips are Revision B's; its RAM is laid out the same, and
everything the explorer reads from the program sits 0x7A40 lower (the sky's
stage table 0x79C0). All twelve stages draw the same pieces and render pixel
for pixel the same as Revision B's. Revision A has no attract fight of its own
mapped (its fighters take Revision B's scene, below), so stage 1 runs from its setups like the other moving stages
(`stageSetup.moving`): before that its 32 rope and banner pieces hung
straight and still, up to 2.8 units from where the board's swing puts them.
The two revisions now draw it the same, still and moving.

Revision C (`doa`, MAME's parent, Jan 10 1997) and the other two 2A builds
(`doaab`, Nov 3 1996, and the export `doaae`) are Revision B and Revision A
with their programs moved: code put in or taken out in places, so everything
after sits a little further on or back. `relocateDoa` in `js/games.js` builds
their profiles from those two by runs, as Sonic Championship's are built from
Sonic The Fighters': the two programs matched 16 bytes at a time, each run the
shift from the first block that matched with it. Every program address a
profile names falls well inside a run (checked one by one), and nothing else in
it moves. Revision C moved its RAM as well: 0x20 on from 0x5420D0 and 0x30
from 0x557C60, found by pairing the RAM addresses that the two programs'
matched instructions name; the RAM `js/doa.js` sets by hand is the profile's
`doa.ram` for that reason. The 2A builds keep Revision A's RAM but for a few
globals (`DOAAB_RAM`, `DOAAE_RAM`, below). Revision C
draws every stage, the attract fight on stage 1 included, pixel for pixel as
Revision B does, and `doaab` and `doaae` every stage as Revision A does. The
2A board seats the shared chips in other sockets, so its sets name them
differently (`DOA_2A_SOCKETS`).

The sky is the tile layer, in a format of Tecmo's own (`buildDoaSky` in
`js/scroll.js`). Data `0xC0000` is a table of 242 scroll pictures (tiles,
palette, map). As a stage starts, `0x6F558` lays four of them, named per
stage at program `0xC7660`, side by side into a 2048-pixel ring; stages 4, 5,
7 and 9 clear the layer, and 6 and 12-15 fill it with one plain tile. Each
frame `0x6FE00` scrolls it by `yaw >> 5` (a turn is the ring) and `0x70090` by
`200 * (pitch + 0xE39) / 0x238E`, linear in the pitch, so level centres row
272 on the eye line at 229 rows a radian. The board's yaw 0 looks down its +Z
and a positive yaw turns toward -X (the camera's eye and target at
`0x555598`). Rendered from the eye and target of a MAME attract frame, the
explorer shows the same arena and the same clouds over it. The colours are
the raw palette, as MAME shows them.

Stage 1's ropes and banners (models 16393-16424: four ropes of eight pieces)
swing, and the stage routine moves them itself each time it draws them
(`0x74000`, culled or not). The first piece of the first rope is a pendulum
(`0x74460`): its angle speeds up by one a frame toward `-0x500`, and above
`0x468` it is held there and stopped. Each piece keeps its last 32 angles
(`+0xC`, a ring indexed by `0x5A02F0`), and the piece below it takes one of
them, so the swing runs down the rope late; each rope then takes the one
before it the same way. The stage setup (`0x70480`) clears it all. So the
state is nothing but the routine's passes since the setup. For the attract
fight, the explorer runs the setup and then 924 passes (`doa.attract.stageInit`,
`stageFrames`). After that, 0x5A02F0-0x5A14A0 is MAME's RAM at board frame
0x75F byte for byte (639 passes give 0x640's). The eight rope pieces MAME
draws at frame 2000 match to 0.0001 in angle and position. The other 24 are
off-screen there; their state is part of that byte-for-byte match.

Seven other stages move pieces the same way, each pass of their own routine:
0 (16004), 2 (16597 16600 16628 16644), 3 (16867-16870), 4 (a conveyor of
33 pieces in 17013-17106 that slide on a 1:2 slope and wrap), 8 (17392 and
17398-17414; some swap models as they go, 17316-17318, and 17392 also reads
the frame count), 10 (two 18425s, turned by the stage tick below) and 11
(17704 17707 17715 17718), with their state at
0x5A0000-0x5A7667. The game sets them up in two steps: the stage task
(0x64640) runs the common setup 0x70480 once, and the round start (0x705F0)
calls the stage's own from the table at 0x70440 (stage 1's and 11's are a bare
`ret`). The explorer runs both, then 924 passes to frame count 0x75F, the
attract stage's count (`doa.stageSetup`; 2A's table at 0x68A00, setup 0x68A40).
After each pass the stage task (0x71138; 2A 0x696F8) counts on: 0x5A6EDD a
byte +1, 0x5A75F0 +0x80, 0x5B9720 +0x800 and 0x5B9724 +0x400, unless 0x54FCDE
is set. Stage 4 picks its belt frame by `(0x5A6EDD >> 2) % 26`, and stages 0
and 10 send 0x5A75F0 to the copro as an angle (function 0x1B), so stage 10
turns too; the explorer runs the tick after each pass (`stageSetup.tick`).

These are graded against MAME's attract: `tools/doa-stages/dump.lua` saves the
board's RAM 300, 301 and 600 frames into each stage (`DOA_SWAP` forces other
stages in), and `tools/doa-stages/grade.mjs` seeds the explorer with one dump
and runs it to the next. The fork's shared MAME needs `M2_GEO_SHARC_OFF=1`:
its real geometry SHARC, running beside the HLE geometry, takes a jump into
data (handler 0x20C26) and stops the attract with a bogus "op 15". The board
does not run a stage once a frame: it runs one twice when it falls behind and
skips one now and then, so the passes are counted from 0x5A75F0. Stages 1, 3,
4, 5, 6, 7 and 8 leave 0x5A0000-0x5A7667 exactly as MAME has it after 299
frames, and stage 11 all but 0x5A0140, the camera's sky scroll (below). Stages 0 and 10 copy the camera's yaw and position into their state
(0x5A0014, 0x5A00F4) and pick pieces by it; stage 2 runs its ring of eight
(0x67388) only while the camera is in range. Those differ only there, since
the explorer's camera is not the game's. Stage 9 was not reached.

Stage 11's sky waves. After the stage's pass, the stage task (0x71124) calls
0x702E0 (2A 0x688A0) when the stage is 11. That routine steps a byte at
0x5A0144 each pass and, every fourth, the wave's phase at 0x5A0145. It keeps
the camera's sky scroll 0x54F948 (made by the sky routine, 0x701C8, from the
camera) in 0x5A0140. Then it fills the scroll chip's line table at 0x1008800:
the lines above the horizon (0x54F950) at the last scroll, then four lines
at half the wave (table 0xC76E0, by phase), then the rest at the full wave.
The explorer runs it as the stage's `after` routine, before the tick.
0x5A0140 follows the camera, as stages 0, 2 and 10's words do, and is left
to differ.

0x54F944-0x54F953 is the program's copy of the tile chip's scroll registers
(0x100A000, uploaded at 0x84CC): 0x54F948 is layer 2's horizontal scroll and
0x54F950 its vertical. The sky routine sets bit 15 of the horizontal one for
stage 11 alone (0x6FE70, 2A 0x68430), and with it the chip scrolls each screen
line by its own word of layer 2's line table (tile RAM word 0x4400 + line,
segaic24.cpp). 0x702E0's table starts its wave at tilemap row 0xF4 whatever
the vertical scroll: the lines above it count 0xF4 less that scroll. The
explorer's panorama rows are the tilemap's, so its stage 11 sky reads the
table the stage's own run wrote at each frame (`doa.sky.lines`, `doaLineShift`
in js/doa.js) and shifts each row by its line's word less the scroll every
line has, through the same row-shift texture as Virtua Fighter 2's sky. The
sea below row 244 waves by up to two pixels, the four rows at its top by half
that, and the wave rolls a step every fourth frame. Stages 5, 6, 7
and 9 have nothing that moves, and are drawn once from cleared RAM.

The moving stages, stage 1 among them, go on moving in the viewer: the routine
keeps running, one pass a frame from the baked one, and each piece takes the
model and matrix of the piece the pass drew in its place in the list (`live`
on each draw, `liveScenery` in `js/doa.js`; a pass costs about half a
millisecond). Stage 4 draws 82 to 92 pieces depending on the pass, so its list
has a slot for the most the 924 passes drew, and a slot a pass leaves empty is
hidden. Stage 1's fighters hold their pose while the ropes go on swinging. If
the clock starts over, RAM goes back to the baked pass.

Stage 4's belt has four rows (x y z, 12 bytes each from 0x5A7600) stepped at
0x6BD0C, which wrap only at the top (y > 60). To keep the belt whole, four
blocks each draw a copy of a row 80 lower: row n's copy when row n stands above
row n-1. The fourth (0x6A0B0, 2A 0x62670) tests row 3 against row 2 and then
draws row 2's place, so for a quarter of the cycle a lone row hangs 80 below
the rest. The explorer runs the routine with that slip fixed
(`doa.fixes`, five words: the two heights loaded the other way round, the
compare's operands swapped, and row 3's x and z), patched into its own copy of
the program; the ROM's other users see it as it is. With the fix the copy sits
right under the belt's lowest row.

### Dead or Alive's stage pieces (`readDoaStages` in `js/doa.js`)

A stage is put together from five tables, each indexed by the stage number
(Revision B addresses; the program ones move with the build, the data ones
do not):

- the routine, `0x719E0 + 4 * stage`, which draws the pieces;
- the model table at data `0x3A160`: 19330 entries of 16 bytes, the texture
  points, the material, the mesh and the face count. A piece is the entry the
  routine sent (above), so the explorer names it by that entry's number;
- the texture slab, `0xCADA0[stage]`, a data pointer whose rows from `0x40000`
  on fill texture rows 256-511;
- the five colour rows, `0x7A7E0[stage]`, and the 32 material slots at `0x6B0`
  that every stage shares;
- the four sky pictures, `0xC7660 + 8 * stage`, out of the 242 pictures.

The explorer calls a stage "Stage n", in chapter n: the profile has no names
for them. Its info lists the stage, the routine's
address, the pieces drawn and, on the attract stage, the fighters. Stages
12-15 are not listed: their routine (`0x6F130`) draws nothing.

| stage | pieces | models | model range | slab | sky pictures |
|---|---|---|---|---|---|
| 0 | 54 | 40 | 15665-16004 | 0x25C0000 | 52 53 54 55 |
| 1 | 87 | 68 | 16347-16437 | 0x2680000 | 125 126 127 128 |
| 2 | 70 | 54 | 16587-16669 | 0x2740000 | 60 61 60 61 |
| 3 | 82 | 34 | 16814-16881 | 0x2800000 | 121 122 123 124 |
| 4 | 92 | 45 | 17013-17114 | 0x28C0000 | none |
| 5 | 25 | 25 | 19071-19175 | 0x2EC0000 | none |
| 6 | 50 | 45 | 17889-18109 | 0x2B00000 | one plain tile |
| 7 | 4 | 4 | 16372-16386 | 0x2680000 | none |
| 8 | 46 | 45 | 17277-17414 | 0x2980000 | 62 63 64 65 |
| 9 | 1 | 1 | 18109 | 0x2B00000 | none |
| 10 | 57 | 42 | 18389-18722 | 0x2BC0000 | 67 69 66 68 |
| 11 | 35 | 35 | 17633-17731 | 0x2A40000 | 134 135 136 133 |

Pieces are the draws of the explorer's pass (stage 4's belt draws 82 to 92;
the table counts the most), models the distinct entries among them. Each
stage keeps to its own run of the table, except for the two small ones:

- stage 7 is four of stage 1's models (16372, 16381, 16383, 16386) on stage
  1's slab, with stage 8's colour rows;
- stage 9 is one model, 18109, the first piece stage 6 draws, on stage 6's
  slab and with stage 6's colour rows.

Both are skyless; neither was reached in MAME's attract (above). Stage 2's
sky is two pictures twice, and stage 10's is the four (66-69) that stage 9's
entry names in another order; stage 9 itself never shows them. Stage 6 draws
every fifth entry from 17889 to 18109; the four after each are consecutive
meshes with the same face count, and nothing the explorer runs picks them:
not the ring size (`0x5A75F4`, 0-4), not the culling helpers' answer (0.5 to
5000), and not 400 passes of the stage task's tick.

They are picked by the caller, not by game state. Entries 17889 to 18108
are 44 characters of five entries each (44 x 5 = 220), and 18109 is the
one piece outside them. Stage 6's routine (`0x6C500`) draws a 7 by 7 board
of characters, a byte each from the string at `0xC75E0` ("A" to "Z", `,`,
`.`, "0" to "9", `!`, `?`, six spaces, then codes 2, 1 and 0), through
`0x63270(char, variant)`, which draws entry `0xC5A70[char] + variant`. That
table gives each character its first entry, five apart: "0" 17889 to "9"
17934, "A" 17939 to "Z" 18064, `,` 18069, code 0 18074, `!` 18079, `.`
18084, `?` 18089, space 18094 (and every code it has no glyph for), code 2
and `_` 18099, code 1 18104. The five entries of a character are one shape
in five colours: each has its own mesh pointer (17939 to 17943: `0x92BA13`,
`0x92BB1E`, ... `0x92BE3F`) and its own face records (`0x270330`,
`0x270340`, ... `0x270370`), but the meshes decode to the same vertices and
face count, and none of their faces is textured; the face records differ in
colour. Each model has two face records, which differ only in their last
word, the colour base (bits 6-15); its faces are untextured (bit 14 of the
first word clear), so the board colours them from palette RAM entry
`0x1000 + base`, shaded by the face's light. The second record is base 7
in all five, palette `0xFFFF` (31, 31, 31: white); the first is base 441
(`0x6E40`) in 17939, palette `0xFDC0` (red 0, green 14, blue 31), 482
(`0x7880`) in 17940, `0xBBE0` (0, 31, 14), 93 in 17941, `0x81DF` (31, 14,
0), 84 in 17942, `0x98C6` (6, 6, 6) and 483 in 17943, `0xB81F` (31, 0, 14):
blue, green, orange, dark grey and pink, each beside white. MAME's palette
RAM holds the same six values (read in `doab`'s attract, frames 600 to
5400; the game has one palette table, uploaded at boot).
Stage 6 passes variant 0 (loaded from `0xC75D0`, a ROM word holding 0) at
`0x6C614`, `0x6C6A0` and `0x6C70C`. The only other caller is the name entry
routine at `0x1DD00` (called from `0x1C540` and `0x1C7D8`): its grid of the
same letters (string `0x91BA0`) passes 1 at `0x1DEAC` and 2 for the letter
under the cursor (`0x557D48`) at `0x1DE98`; it passes 2 for the digits it
makes from `0x557D68` (`0x1DFE4`, `0x1E0A4`, `0x1E170`), the `.` at
`0x1E218`, the three initials `0x557D58`-`0x557D5C` (`0x1E30C`, `0x1E414`,
`0x1E524`) and a letter at `0x1E690`, and 4 for the letters at `0x1E8A0`.
Those 14 are every direct `call` to `0x63270` in the program; no instruction
loads its address and no word in the program or data ROMs holds it, so no
indirect call reaches it through a stored pointer. No direct call passes 3,
nothing else reads `0xC5A70`, and no code names those entries by address.
No indirect transfer reaches it either. A linear disassembly shows 343
`callx`, `bx` and `balx` and 12 `calls`; followed from the program's own
entry points (start IP `0x410`, `0x490` after the reinit at `0x3C0`, the
fault, system procedure and interrupt tables at `0x210`, `0x1C0` and
`0x7B10`, and the targets below), 80 of them are reachable and the rest are
data read as code. 71 are `switch` jumps, `ld T[g4*4]` then `bx`, through
tables of ROM words. Two are the task switcher (`0x25BC`, `0x27B4`), which
jumps to a task's word +0x10: only `0x8210` writes it, from the constant
each of its 42 callers loads (`0x2C70`, `0x5550`, ... `0x7D150`, never
`0x63270`), and `0x2604` writes `0x825C`, the return address of the
yield's `balx` at `0x8254`, which is one more and goes to the constant
`0x24E0`. Four are leaf returns
(`0x4E2F0`, `0x4E98C`, `0x4E99C`, `0x4EFD0`) through the register the
entry copied `g14` into, a return address. Two are `callx` through the
stage tables (`0x708AC`: `0x70440[0x5555BE]`; `0x71BD0`: `0x719E0[0x5555BE]`),
ROM words read with a byte index. None computes its target by arithmetic,
and the address `0x63270` is not in either ROM at any byte offset, so no
indirect call or jump can land on it: the 14 direct calls are its only
callers and each character's dark grey variant is never drawn. As a stage,
6 shows variant 0 only, which is what the explorer draws.

Its one piece outside the letters, 18109 (stage 9's too), is drawn as
`18109 + [0x5A6EE0]`, like other stages' pieces. That word is the texture
slot offset the stage loader sets (`0x715EC`-`0x71608`): 0 while the stage
sits in the first of two slots (`0x5A6EEE` = 0), `0xC5960[stage]` (250 for
stage 6) in the second, whose entries are the same meshes with their
texture points moved on (18359 is 18109's). It does not touch the letters;
the explorer draws the first slot.

Every build draws the same stages. `readDoaStages` run on `doab`, `doa`,
`doaa`, `doaab` and `doaae` gives the same models, matrices and texture points
for every scenery piece of all twelve stages (one hash a stage, the same in
all five), and the five tables above hold the same values in each: the same
slab pointers, the same sky pictures, the same colour rows byte for byte and
the same material slots (at 0x6B0 on the 2B builds and `doaa`, 0x870 on
`doaab` and `doaae`). The model table is the shared data chips', so a model
number means the same model in every build. The one difference is stage 1's
fighters: `doab` and `doa` play the attract fight there and draw its two
fighters (70 more pieces), while the 2A builds have no attract mapped and
show the stage empty. The colour pointers of stages 12-15 differ by build,
but those stages draw nothing. The routines sit at:

| stage | `doab` | `doa` | `doaa` | `doaab` | `doaae` |
|---|---|---|---|---|---|
| 0 | 0x646C0 | 0x64770 | 0x5CC80 | 0x5CC10 | 0x5CC20 |
| 11 | 0x6E8E0 | 0x6E990 | 0x66EA0 | 0x66E30 | 0x66E40 |

### Dead or Alive's fighters (`runDoaFighters` in `js/doa.js`)

The fighters are drawn by the game's own code too, on two players set up the
way the fight start does (Revision B addresses):

- the player record at `0x54FBE0 + 88 * p`: +1 character, +2 costume, +4
  position (y 1.0 is the floor), +0x14/+0x18/+0x1C angles (the body faces the
  first), +0x2D which head the body routine picks, +0x48 drawn;
- `0x407A0(char, p)` loads the character, `0x4F930(p)` clears its ribbon,
  `0x41900(p, char)` sets it up; the player's frame `0x41A50(p)` runs its
  action script (+0x28, started by +0x36 = 1), which starts motions with
  `0x420C0(p, motion)` (facing `0x550124[p]`, -1 is mirrored);
- the motion's fifteen joint tracks are pointers at `0x56ACD0 + 60 * p`, six
  bytes a frame (three int16 angles), which go to `0x56AA40 + 0xB4 * p` as
  int32; a mirrored player turns the other way about Y and Z;
- the face model is `0x58828C[p]`, the model bank `0x5A6ED0[p]`;
- the skeleton (`0x47810`, from the body routine `0x457C0`) lifts the hips by
  the root's y at `0x56AD54 + 12 * p` times the character's height
  `0x589B80[p]`, which `0x4DAE0` copies from `0xC1E80[char]`;
- the motion step `0x44840` moves the motion's clock on by the speed at
  `0x56ADA0[p]` times the record's rate (+0x10), and takes the joint angles
  and the hips' place (`0x56AD50 + 12 * p`: dx, y, dz) from the frame it has
  reached; the skeleton lifts the hips by that y times the height, and the
  body routine turns dx and dz by the heading `0x56AC28[p]` into the
  record's position and clears them, so the fighter steps as its motion does;
- a move can blend in: the script sets a frame count at `0x56AC04[p]`,
  `0x4A5B0(p)` works out a step per joint toward the move's first frame, and
  `0x4A8D0(p)` takes one a frame in place of the motion step until the count
  runs out;
- `0x4FEB0(p)` draws the ribbon (Tina's struct at `0x568470`), a chain it
  swings from frame to frame: a bob (`0x400B0`: acceleration, speed and place
  at `+0x5C..+0x64`, 32 frames a swing from the load on) and a push
  (`+0x74..+0x7C`), the joint the ribbon hangs from's move since the last
  swing; it swings only on frames whose parity is `0x589DB1` (`0x3FA50`).
  Each link's turn (`0x40540`) eases toward the angles the copro's `0x0F`
  gives for the push, and the push takes the floor's slope from a 14 x 14
  grid at `0x5A6F00` (two singles a cell, by the player's x and z, through
  `0x630B0` into `0x56AA30`), which the stage setup `0x70764` copies from
  `0xC7CA0` (`0xC82C0` on stages 2 and 5);
- the fight loop's frame (`0x4D8D8`) opens with `0x4DF20`, which works out
  `0x589DC0..C8` from the light at `0x5555B0` plus, with `0x54FC94 = 4`, the
  stage's entry of the table at `0xC32A0`, and closes with `0x4DDC0`, which
  copies the low bit of the frame count `0x54B158` to `0x589DB1`;
- the shadows (models 136-150 and 1493-1507) are drawn first by the body
  routine `0x45B24`, before the skeleton moves, so they are the frame
  before's: when `0x5555B4` < 0 and `0x54FC93` is set it calls `0x56180`
  (`0x568B0` or `0x56FE0` by byte +2 of the record). For each of the fifteen
  bones that takes its two ends from the joint table `0x5552B0`, 0.1 lower,
  projects them along `0x589DC0` onto the floor at `0x58BA80` if they lie
  inside the ring at `0x550100..0x550114`, else onto y 0, and draws model
  `0x203A160 + 16 * (0xC1F80[char] + bone + 0x5A6ED0[p])` on the copro's
  matrix: translate to the midpoint, turn about y by the arctangent, scale by
  (length, 0.01, 1). It projects anew only on the frames where `0x589DB1` is
  the player's number; on the others it sends the pieces it kept at
  `0x589F50` (copro `0x57`). The round start `0x54660`
  sets the floor (1.0) and the ring, half of the size the boot sets at
  `0x54FD5C/60` (24.0, at `0x44B8`).

- the round's setup also fills the fight's tables (`0x25870(c)` for c 0-12)
  and resets each player (`0x1B430(p)`: health +0x20 = 0xFF, the round's
  counts cleared); without the health, the first hit knocks the player down
  (`0x22540` compares +0x20 with the damage) where MAME's only reacts;
- each frame of the fight runs, in the board's order: `0x4DF20`, `0x41A50`
  for each player, `0x4FEB0` for each, `0x4DDC0`, the hit and push check
  `0x3E1E0`, the camera task, then the fight's tasks (`0x1FDD0` the hits,
  `0x24FD0` the reactions, `0x21400`, `0x22EF0`, `0x231D0`, `0x1FE80`,
  `0x23C80`) and the movers of the task at `0x2F4F0` (`0x2F5E0` the
  knockback, `0x2F670` the push of players in contact, and the rest);
- the camera task (`0x7D1B0`, a loop that waits for the next frame at
  `0x8240`) eases its eye and target after the players (`0x5552C8`,
  `0x865C0`) in mode `0x55558C` (0x23 in a fight) and builds the camera
  (`0x85BE0`): copro `0x08`, then the turns and the eye's move. The body
  routine outputs that matrix (`0x5888C0`) and builds the joints on it, so
  the copro's matrices are the camera's; the explorer takes the draws back
  to the stage's frame through its inverse;
- the copro's arctangent (`0x0A`, and `0x0F`: the yaw and the pitch from one
  point to another, yaw = atan2(-dx, dz), pitch = atan2(dy, the run)) reads
  a little short, about 6e-5 of the angle (straight back is 0x7FFE), and
  rounds down: MAME's answers agree with that to a unit.

The profile's `doa.attract` names MAME's attract fight at frame 2000 on stage
1: the stage, the light the attract script sets (`0x19710` turns two angles
into it), the board's frame count on the fight's first frame (0x6B0) and on
the one drawn (0x75F: the board shows a frame's display list on the next),
the camera task's state on the first frame as MAME has it, and each player's
record on that frame (Zack starting action 0; Tina turned, starting action
0x800). The rest is the fight code's, the attract's AI included. The AI is
a task of its own: its start (0x25BD0) sets it up, and each frame the loop
from 0x25CF4 runs a byte-code per player whose ops 0x2B28C and 0x2B3E0 give
the command (+0x2C), then 0x2F2E0 clears guard (+0x3A) and sets it again
from the AI's state (0x56471A), the other player's +0x46 and its own +0x2E.
It reads five bytes the attract's script sets before the fight, the
profile's `ai`: script op 0x1A370 sets each player's start flag
(0x5555F2/F3) to 1 and its pattern (0x5555F4/F5) from the table at 0x90E50
(Zack 0, Tina 1), and op 0x1AEE0 sets 0x5555CB to 2. It draws no random
number in this fight. Run after the camera task, it gives Tina 0xA6, 0xA7
and 0xA8 on frames 0x6C4, 0x6C5 and 0x6D3, and Zack guard from 0x6C6 and
0x40, 0x03, 0x53, 0xA8, 0xA9 and 0xAA on 0x6F2, 0x72A, 0x735, 0x736, 0x740
and 0x74A, the frames MAME has them on. Against MAME's
display list for that frame all 69 draws match, the ribbon's links
included, to 0.001 radians in their turn and 0.001 in place.

Revision A's fight code (`doaa`, and through it `doaab` and `doaae`) is an
older build of Revision B's, not Revision B's moved: the same routines, with
code taken out or put in between them, so the shift runs from 0x20 to −0x7A40
(`DOAA_FIGHT_PROGRAM` in `js/games.js`, found by matching 24 bytes round each
address the profile names; the frame start 0x4DF20 is 0x46660 here). Its
fight RAM is Revision B's, the camera at 0x5888C0 included, so the fighter
profile, the rig and the attract scene are Revision B's with their program
addresses moved. `doaab` takes its own program from `doaa`'s by runs as
before, and moves one RAM global (0x54FD84, 4 back). The export `doaae` moves
a few more (`DOAAE_RAM`): its body routine asks 0x54FC92 where the others ask
0x54FC93, and without that run it drew no shadows. With them every
character's motions and bodies come out of all five builds bit for bit the
same (Zack, Tina, Kasumi and Leifang, three motions each).

The attract scene is Revision B's: Revision A's own attract fight on stage 1
(Zack against Tina from 0x6B0, as on Revision B) has not been copied out of
its RAM, so `attract.onStage` is false and the stage still runs from its
setups. Graded the same way as Revision B against MAME's `doaa` display
list (every third frame from 0x6B1 to 0x75E, 58 frames, 3991 draws, the
geo FIFO under `M2_GEO_SHARC_OFF=1`, in the stage's frame through the camera
at 0x5888C0), Zack's body and shadow are within 6.1e-4 radians in their turn
(median 9e-5) and 6.4e-4 in place, Tina's within 1.2e-3 and 3.3e-4, and her
ribbon's three links within 1e-4 (median) but for 0x6E4–0x702 (up to 0.024)
and 0x744–0x75C (up to 0.053, 2.8e-3 in place). Revision B's run is within
5.9e-4 everywhere. Those spans, and Tina's 1.1e-3 on 0x6C3–0x6CC, are where
the board's own revisions part: MAME's `doaa` against its
`doab`, draw for draw, differs by the same amounts there and by about 3e-4
elsewhere. The two boards' fights drift apart by about 1e-5 in the players' places
from the first frames (the counters at 0x54FBD0 and 0x54FD78 differ as the
fight starts), and the ribbon swings that far out where Tina whips it. Giving
the explorer Revision A's camera state from MAME's RAM at 0x6B0 changes
nothing. One draw a frame (the 49th) is not in MAME's list on either
revision.

On the Animation tab a part is a place in that draw order, and the body
routine works out every matrix whole (the copro's stack stays flat), so the
skeleton is not in the ROM to read. `jointsOf` in `js/doafighters.js` finds
it from the motion: a joint is fixed on its parent's bone, so a part's parent
is the earlier part in whose frame its place holds still through every frame.
A joint the motion never bends holds still in several; of those the parent is
the one whose model comes nearest the joint, the bone it is the end of. That
gives hips, chest, head, two arms and two legs of three, and the chains that
hang (Tina's ribbons, Kasumi's sash and ponytail, Jann Lee's belt), the same
in every motion tried. A part
drawn on its parent's very matrix in every frame is laid on it: the face
(eyes and mouth) on the head, the bust on the chest. The board's sort puts
those over the skin in the order they are sent, so the explorer ranks each
such group's coplanar faces together (`rankJoinedParts` in `js/app.js`);
ranked one part at a time, the head's skin hid the eyes.

The fifteen squashed draws (determinant near 0) that come first in a frame
are the shadow; `framesOf` keeps them apart as `shadows`, and the tab lays
them on the floor with the fighter (`placeDoaShadows` in `js/app.js`).
Graded against MAME's doab attract on stage 1 (a Lua tap on the geometrizer's
FIFO logging every squashed object and the camera at `0x5888C0`), every third
frame from 0x6B1 to 0x75E: 1740 pieces, all the same models, in place to
0.0003 and in their matrices to 0.0009, with the bones from 1.0 to 1.8 long
as the fighters move. The fight's very first frame (0x6B0) is the one that
differs: MAME's pieces lie at the floor's 1.0 and the explorer's at y 0;
the tab never shows that frame.

### Sega Rally Championship (`js/games.js`, `readRallyStages` in `js/stages.js`)

The method is Daytona's and Virtua Cop's: run the game on a board that can be
watched, find the routine that writes each table, and read the table that
routine reads. m2-hle2 ran the attract mode, with save states taken on the
desert, the mountain and the forest, and its memory dumps of texture RAM,
palette RAM, colorxlat and lumaram are what everything below is checked
against. MAME's Lua read taps answered the one question the dumps cannot,
which models a course draws.

The program copies ROM 0x1000-0x61000 to RAM 0x5A0000 at boot and runs from
there, so a code or table address in RAM is the ROM's plus 0x59F000.

**The model table.** The TGP's draw command is four words on its FIFO at
0x804000, and every draw routine loads them with `ldq 0x2864B40[g5*16]`
(0x23CEC is one of 34 such sites). That is main_data 0x864B40: 1508 entries of
16 bytes, (tpa, tha, oba, count), in order through the ROMs, up to the
"CGM 1.0 " block at 0x86A980. Only entry 0 is empty, so there are no bank
separators. All 1508 decode: 146558 faces, 129983 of them textured.

**The palette.** A watch on palette RAM stops in the boot routine at 0x267B0,
which reads a count, `ldos 0x5FB89C` (ROM 0x5C89C), and copies that many
halfwords from ROM 0x5C89E to 0x1802000, colorbase 0. The count is 541; the
highest colour any face names is 538. The dumps on the three courses match it
with no differences and nothing written past it, so the courses do not change
it.

**The sheets.** Texture RAM is written by 0x3940, which deals a bank out of
the data ROM (bank n at main_data 0x200000 + n * 0x100000) by a run table at
0x3880: seven groups of eight halfwords, a repeat count and runs, each run
copied to one cursor while the other skips the same length, and the cursors
swapped after each (`uploadSrallycBank` in `js/texture.js`). The boot uploads
bank 0 with flag 0, which puts its full-size area on sheet 0; a course
uploads `bankTable[variant]` from 0x3DCF0, (2, 3, 4, 5), with flag 1, which
puts it on sheet 1. The variant is work RAM 0x214354. Built that way, both
sheets match the dumps byte for byte on all three courses. So a model that
samples only sheet 0 is the boot bank's, on every course, and one that
samples sheet 1 takes its course's bank: 671 and 668 models, and 169 are
untextured.

**colorxlat and lumaram.** Both are built by code, as Dead or Alive's are, so
they come from running it on the i960 interpreter (`runColorRoutines` in
`js/colors.js`): 0x5A2C80 then 0x5A3350 fill colorxlat at 0x1810000, and
0x5A3590 writes lumaram a byte every 4 bytes from 0x12800000. Only 256 luma
entries are set, two bands at lumabase 0 and 128, the only two any face uses.
Both match the dumps byte for byte and are the same on every course; the run
takes about 50 ms.

**Materials and light.** 0x4AC0 sends the scene's setup: the window
(function 3), the focal length, 350 by 350 (function 9), and the materials,
`mov 22, g1; lda 0x5A39C0, g2; bal 0x4958`, 22 (parameter, 1.0) pairs at ROM
0x49C0 sent as function 6. The light is function 0xA. The attract scenes send
a world light of (-0.707, -0.707, 0.707) through the TGP into camera space
before it (0x13914, 0x17450, 0x1F858, 0x4AC34); the profile negates Z, as
Daytona's does.

**The courses.** A MAME tap on reads of the model table (0x2864B40-0x286A97F),
reinstalled every 30 frames, logged the entries each course reads: 937-998 on
the desert, 1135-1195 on the mountain, 1257-1318 on the forest, besides the
cars. Those numbers are in the program ROM as runs of words, and a search for
pointers to them finds the table they hang from. 0x3BCC0 draws the course near
the camera:

    lda  (g0)[g0*2], g0         ; course * 3
    lda  0x5DCA00[g0*4], r6     ; its record, ROM 0x3DA00
    ld   0x4(r6), g0
    call 0x3B200                ; the segment the camera is in

and 0x3BD90 is the same with 0x5DCA60 (ROM 0x3DA60), the low-detail copy. A
record is three words: a header, [0, sky, 999, sky], a pointer into the data
ROM that 0x3B200 walks (the course's path; not read), and the segment list,
a model number a word. Four records are courses, in the order of the texture
variants: the desert (937-996, sky 997), the mountain (1135-1194, sky 1195),
the forest (1259-1318, sky 1257) and the fourth (1379-1438, sky 1439), which
the attract mode never draws. The fifth repeats the desert, and the last three
are a one-model scene (818). The low-detail lists are 1000-1059, 1197-1256,
1319-1378 and 1441-1500: the same ground in a tenth of the faces.

A course is 60 segments. The mountain's and the forest's lists end with a 0
there; the desert's and the fourth's run straight on into their low-detail
lists, which is why the reader stops at 60. A segment is drawn with no
matrix: model 1269, a stretch of the forest, has its vertices out at x 74
and z 400. So the geometry is in world space and a course is its list drawn
where it lies, as Daytona's blocks are (`stageTable.flat`). The sky is a dome
up to 400000 across and is kept out of the face layering
(`layered: false`), whose grid of 32-unit cells it would fill.

The fourth course is taken to be Lakeside, the secret one: it is the last
record, bank 5, and its trees are autumn colours. The courses' names are not
in the ROM.

Checked against MAME: the Castrol Celica (model 110) in snapshot colours, the
forest's banks and trees, and the mountain's sky with the snowy range MAME
shows behind the stone wall. Not right yet: the car windows are black, where
MAME draws dark glass, and what is under the sky beyond a course is left
black.

Not read: the course paths, the cars' places, the trackside objects, and the
CGM blocks in the data ROM, which the dumps show change nothing in palette
RAM on these three courses.

### Sega Rally Championship's people (`js/srally.js`)

The Animation tab's bodies are the spectators by the course and the cars.
The spectators are the only keyframed things in the game; everything else
that moves does so by code.

**The cars.** The car draw, 0x5C2A80 (ROM 0x23A80), takes the car's record
in g0 and the car in g1. The records are a table at ROM 0x23780, 0x30 bytes a
car picked by +0x50 & 0xF: a near record and a far one, 0x18 bytes each
(0x24800 picks; the far draws, 0x5C30C0 and 0x5C3560, leave the wheels out
or unturned). Near record: +0 the wheels' places (a RAM address, four of
three floats: front left, front right, rear left, rear right), +4 the shadow,
+8 the wheel, +0xC the body, +0x10 a second body, +0x14 an extra model. Slot
0 is the Celica (body 110, wheel 116), slot 1 the Delta (body 96, wheel 102).

The draw lays the shadow, then pushes, translates to the car (+0..+8), turns
it by +0x1C, +0x18 and +0x20 (TGP 0x2A, 0x29, 0x2B) and draws the body. Then
each wheel: push, translate by the wheel's place plus its suspension travel
(+0x30 + 4i) on Y, on the front two (g13 <= 1) a turn by the steer +0x24
(`0x15002A2A`), the spin +0x2C negated (`notbit 31`, `0x14802929`), the wheel
model, pop. On the board's axes, measured against the matrices the TGP writes
(function 5, read from bufferram at the geo write pointer 0x802008), a wheel
is T(place + travel) · Ry(-steer) · Rx(spin). The spin only goes up, past
8192 radians; the TGP takes the whole turns off in single floats, which
`wrapTurn` does too.

None of this is motion data: in play the physics writes the car each frame.
In the attract mode, 0x28990 (RAM 0x5C7990) writes it from a recorded run
instead, given the run (g1), the frame clock 0x20A7FC (g2) and an end (g3). A
run is the car itself, 0x58 bytes, every fourth frame. The clock's top bits
are the sample and its low two the quarter toward the next, and every value
is eased as (1 - t) a in double plus f32(b t), rounded to a float; on a sample
it is copied (0x28DDC). The three angles, +0x18 to +0x20, are eased instead as
a + f32(t d), with d = b - a brought within half a turn by 0x27BD8, so a
heading eases the short way round; +0x50 to +0x57 are taken whole from the
sample it eases toward. The seven runs are in main_data at 0x201F410 and
0x203E420 (scene 1), 0x290A100 (scene 2, one car, played with either),
0x28E9258 and 0x28F99AC (scene 3), 0x200FBE0 and 0x202EBF0 (scene 4). They
lie end to end, and a scene's clock runs a sample or two past its run, so a
run's length is the last clock MAME's attract reached, plus one.

Graded on MAME's attract, frames 300 to 12500: 19,062 car draws, 19,059 of
them matched to a run and clock; 17,478 with the front wheels steered and
17,399 with a wheel off its rest. The steer, spin and travel `poseRallyCar`
reads are the ones the draw read, 114,354 of 114,354 bit for bit. The wheel
matrices, relative to the body's: turn error median 8.5e-6 radians, 99%
1.3e-3 (the larger ones are spins past 8192, where a float's step is 1e-3);
wheel centres and rim points 1.4e-6 apart (median), 3.1e-4 (99%). With the
wheels left straight, as before, the turn error's median was 1.57. 49 of the
76,236 wheel matrices are off by more than 0.1 radians, all front wheels of
the Delta in scenes 3 and 4. They are the logger's: it reads each matrix from
bufferram at the end of the frame, sometimes before the TGP has written it.
Logged again with every matrix read once more one and two frames later
(frames 300 to 10500, 64,608 wheel matrices), each re-read is the pose
`poseRallyCar` gives, all 64,608 within the usual error; 23 frame-end reads
were off again, and not on the same draws as the first run, which read 7 of
its 10 unexplained ones cleanly this time.

**The body, the shadow and the models** (`poseRallyCar`, `rallyCarModels`).
The draw's first push is the shadow's: a translate to the car's X and Z at
the mean of the ground under the four wheels (+0x40 on, in the order of the
places) less 0.02, the heading +0x1C (function 0x2A), the ground's tilt front
to back, (FL + FR - RL - RR) x 0.2380952, as function 0x29, and side to side,
(FL + RL - FR - RR) / 3, as 0x2B; then the shadow model, pop. The body's
matrix is the car's place, the heading, the pitch +0x18 (0x29) and the roll
+0x20 (0x2B), and the wheels are drawn inside it. In the viewer, whose Z is
the board's negated, the three functions are Ry(a), Rx(a) and Rz(-a). The
view stands the car over the ground's mean with the heading taken off; with
root travel it drives the run from where it starts, turned as it starts, and
the camera follows it.

The body model is the record's +0xC, or +0x10 while +0x52 & 0x8888 is set; a
record with a model at +0x14 adds +0x51 & 3 to the body's number, and draws
that model on the body's matrix while +0x50 bit 4 is set. The run's flags
are not what the draw sees. The first and fourth scenes (0x10AE0, 0x116F4)
rewrite the word as ((w << 1) & 0xFFF0) | (w & 7), the first with 0x2222 put
over the top halfword, the fourth clearing bit 4; 0x12968 sets +0x51's low
two bits to 1 on the car in slot 1 and clears them on the other (a one-car
scene: 1 if 0x12968 made it the Delta, else 0); 0x247D0 clears +0x50 bits 5
and 6 before the near draw. Watched in MAME: the run's `0xFFF1` becomes
`0x2222FFE1`, then `0x2222FDE1`, then `0x2222FD81`. So the Delta always draws
body 0x61 (0x6B with the second body), the Celica 0x6E (0x77), the second body
shows only in the third scene (+0x52 = 0x9999) and the extra model (0x75 on
the Celica, 0x67 on the Delta) only in the second and third, a few frames at
a time.

Graded on the same attract run, frames 300 to 12500, tapping the shadow's and
the body's matrices (re-read a frame later), the body model and the extra
model: 19,058 car draws matched to a run and clock, over all seven runs. The
body and extra models are the draw's on all 19,058 (alt bodies on 934, extra
models on 203). The body relative to the shadow, inv(S) B, is within 2.8e-5
radians (median), 9.4e-5 (99%) and 1.1e-5 units (median), 8.1e-5 (99%);
5,617 of the draws have the pitch or roll past 0.1 radians, up to a roll of
1.58. Five are off, by up to 0.48 units: the last five clocks of the second
scene (1517 to 1521), whose next sample is past the run's end and is the
following table's data, drawn on the frames the scene cuts away. For the
heading and the place, the two cars on one frame against each other, inv(B1)
B2 with each run placed at its first sample: 8,511 pairs within 1.2e-7
radians and 1.2e-5 units (median), 4.1e-5 and 1.2e-4 (99%); the one pair off
is that same cut, where the cars are from two scenes. Before this the body
stood level; easing the heading straight across, not the short way, put the
pairs up to half a turn out on the samples where it crosses a half turn.

**The figures.** One routine, 0x5CA290 (ROM 0x2B290), draws every jointed
figure. It takes a figure record, a frame and a step:

| Offset | |
|---|---|
| +0x00 | key frames (30 for all three) |
| +0x04 | parts |
| +0x08 | the key frames, a main_data address |
| +0x0C | a model number per part |

The three records are at RAM 0x5CA180, 0x5CA1A0 and 0x5CA1D0 (ROM 0x2B180,
0x2B1A0, 0x2B1D0): 5 parts, models 284-288, data 0x2057F80; 8 parts, models
289-296, data 0x2058B40; 12 parts, models 297-308, data 0x2059E00. A key
frame is 20 bytes a part: the part's place as three floats, then halfwords at
+0x0C and +0x10 that go with the place to the TGP as one command, function
0x5F (`lda 0x2F805F5F`). +0x0E and +0x12 are never read. Each part is placed
from the figure's own origin, not from another part, so a key frame is the
whole pose; the explorer gives every part parent -1.

The TGP's function 0x5F was measured, not guessed: a MAME Lua script read the
matrix the TGP writes to the geometry buffer for each part (bufferram, at the
pointer in 0x802008) on all three figures, the second and third forced by
setting the operation-day count. Against the figure's own matrix, every part's
is T(place) · Rz(-h0C) · Rx(-h10) on the board's axes, to 3e-5 in the
translation and exactly in the rotation, at scale 1. The explorer's Z is the
board's negated, which keeps the Z turn and flips the X one: Rz(-h0C) ·
Rx(h10). The angles are 0x10000 a turn. The parts are flat quads stood up by
an X turn of a quarter.

**Playing.** The routine returns frame + step, and with the mode both callers
pass (g3 = 1) it swings back at the end: keys 0 to 29, then -29 to -1 taken by
their size, one a video frame. MAME showed key 29 twice and then the count
down. The explorer unrolls that into one motion of 59 frames a figure.

**Who draws them.** Object classes from the handler table at 0x5DDFC4:

- class 6 (0x5CAAE0, state at +0x60) turns each frame toward the player's
  car (0x2140CC) and draws the first figure (`lda 0x5CA180` at 0x5CAAAC);
- classes 5 and 7 (0x5CA6D0, 0x5CA710, draw 0x5CA5B0) face the camera
  (0x20220C) and take the figure from the four-entry table at 0x5CA280
  (first, second, third, second), indexed by `(0x1D001B8 / 30) & 3`.

0x1D001B8 is in backup RAM. The self-test report (0x5A8FEC) prints it with
"OPERATION DAYS %10d Days"; it is set at 0x5A1AF4 and counted up at
0x5A1D9C. So a cabinet's spectators change every thirty days it is on, and
MAME, fresh, always shows the first table entry.

The flat crowds (class 3, 0x5CA580, draw 0x5CA420) are single billboard
models from the table at 0x5CA210 indexed by object +0x5C, and are not jointed.

**The animals.** The desert's animals are figures in the same record layout,
drawn by a second routine, 0x5C70D0 (ROM 0x280D0; g0 record, g1 key, g2
step, g3 mode). Each part sends its place (function 0x27), then +0x0C as
function 0x34, +0x0E as 0x33 and +0x10 as 0x32, each between a push and a
pop, and the model header from the table at 0x2864B40 goes straight to the
geometry FIFO. Mode 0 loops back to key 0, mode 1 swings back as the people
do (the next key becomes 1 - keys, read by its size), anything else stops on
the last key. The handlers are classes of the table at 0x5DDFC4, whose class
names follow it:

| Class | Name | Per frame | Records (RAM) | Keys, parts | Models | Mode |
|---|---|---|---|---|---|---|
| 0 | Zebra | 0x5E29D0 | 0x5E2890 | 60, 24 | 1061-1084 | swing, rests rand & 0x17F |
| | | | 0x5E2900 | 120, 3 | 1085-1087 | swing, rests rand & 0xFF |
| 1 | Ostrich | 0x5E2B70 | 0x5E2920 | 60, 13 | 1097-1109 | loop |
| 2 | Bird1 | 0x5E2EA0 | 0x5E2830 hop, 0x5E2860 peck | 21, 1; 32, 1 | 283 | loop |
| | | | 0x5E2840 flying | 7, 5 | 279-283 | loop |
| 4 | Elephant | 0x5E32D0 | 0x5E2960 | 180, 25 | 1110-1134 | loop |
| 8 | Bird2 | 0x5E3590 | 0x5E2870 | 40, 5 | 1501-1505 | loop |

Every handler pushes, moves to the object's place (+0x18) and turns by its
heading (+0x28, function 0x2A). Bird1 adds pi to the heading and picks the
record by its state (+0x60); the elephant first draws model 118 0.1 up;
Bird2 scales by 0.3 (function 0x28) after the heading.

Measured on MAME's attract, frames 2820-3440, with the geometry-buffer tap
the people were graded with, a car's body matrix (0x5C2DCC) to solve the
camera, and each handler's object read at its entry: every part's matrix,
taken back through the camera and T(+0x18) · Ry(-heading), is
T(place) · Rz(-h0C) · Ry(-h0E) · Rx(-h10) on the board's axes, to 1e-4 in
the translation and 0.001 degrees in the rotation, on every key the run
reached (all of them but 0x5E2900's and 0x5E2960's, which were sampled every
seventh), with parts turned up to 180 degrees from rest. In the viewer's
axes that is Rz(-h0C) · Ry(h0E) · Rx(h10). The attract draws only the zebra
and Bird1. The other records were drawn by changing g0 and g1 at the
zebra's second call on alternate frames, so they were measured in the
zebra's frame; Bird2's 0.3 and the elephant's model 118 are read from the
code, not measured. Two things to know when tapping: a game frame straddles
MAME's frame callbacks, so group the calls by the car's draw, not by the
callback, and the zebra's figure 1 repeats while it rests, which hides a
frame's slip on it alone. The zebra's keys ran 0-59, held, then 59 down to 1
and 0, held: the explorer's swing without the random rests.

**The flags.** The desert's start line has eight flags, class 17 (Flag;
0x5E4550 init, 0x5E4380 per frame). They are not figures: each frame draws
one whole model, `table[+0x64]`, from 0x5E3B90 (models 321-395, a red R&D AM3
cloth) while the variant +0x5C is 0, or 0x5E3CC0 (396-470, a blue one)
otherwise, at the object's place (+0x18) turned by its heading (+0x28). Then
+0x64 goes up one and back to 0 past 0x4A, so the waving loops every 75
frames; the init starts it at `rand & 0x3F`. Both tables end in a 0. The
object records are the course's list at 0x5DE190[course] (0x20 bytes each,
ended by 99999), and their class field is one more than the class used here:
the creator, 0x5DE220, reads the handler at 0x5DDFC0[+4 & 31]. The desert's
list has the eight flags at x -364 and -374, alternately variant 0 and 1, all
mode +0x60 = 0, which draws only while the race is on (0x202230 = 0, 0x217184
bit 2 clear, 0x202098 not 2): the attract mode runs the handler and never
draws them, so +0x64 stays put. Graded with breakpoints at the two model
loads (0x5E4498, 0x5E44EC) on MAME, a championship started from two credits:
all eight flags, 4,497 draws each, every one table[+0x64] with +0x64 one up
on the draw before. The Animation tab lists them as `red AM3 flag` and `blue
flag`, each playing its table.

### Dynamite Cop (`js/dynamcop.js`)

All five builds share the data, polygon and texture chips and the program's
upper pair. Only the lower pair differs, so that is what `identifyCrc`
checks. The 2B and 2C zips call it `progrom0.15` and `progrom1.16`. The
tables below were read off the 2A export build (`dynamcop`) first: MAME, the
shared build, with Lua dumps of palette, colorxlat, luma and texture RAM at
three attract scenes, and the program's set loaders. The other builds'
addresses were found by searching each program for the same table bytes.
The 2B and 2C programs keep the same tables in another order.

| table | dynamcop | dyndeka2 | dynamcopb | dyndeka2b | dynamcopc |
|---|---|---|---|---|---|
| bank table | 0x429D0 | 0x429D0 | 0x10D30 | 0x10D30 | 0x42FC0 |
| palette tables | 0x42840 | 0x42840 | 0x10BA0 | 0x10BA0 | 0x42E30 |
| palette top | 0x428E0 | 0x428E0 | 0x10C40 | 0x10C40 | 0x42ED0 |
| palette extra | 0x42920 | 0x42920 | 0x10C80 | 0x10C80 | 0x42F10 |
| ramps | 0x42930 | 0x42930 | 0x10C90 | 0x10C90 | 0x42F20 |
| luma (0x7F80 bytes) | 0x36B40 | 0x36B40 | 0x4EA0 | 0x4EA0 | 0x37130 |
| curve weights | 0x70270 | 0x70260 | 0x191E0 | 0x191D0 | 0x70A20 |
| boot rectangles | 0xE4390 | 0xE4380 | 0xFA5B0 | 0xFA5A0 | 0xF4AB0 |
| stage blocks | 0xE4440 | 0xE4430 | 0xD5CA0 | 0xD5C90 | 0xF4B60 |
| enemy flags | 0x756B0 | 0x756A0 | 0x62330 | 0x62320 | 0x75EF0 |
| materials (31 x 8) | 0x6ECC0 | 0x6ECB0 | 0x17C40 | 0x17C30 | 0x6F3B0 |
| missions | 0xE9A70 | 0xE9A60 | 0xF9370 | 0xF9360 | 0xFA190 |

The function addresses below are the 2A export build's.

**Sets.** The game numbers 25 sets. Set 0 is boot, sets 1-13 are stages and
14-24 are enemy sets (enemy n is set 14 + n). Boot loads with 0x7D450, a
stage with 0x7D3F0 or 0x7D490, an enemy set with 0x7D420 or 0x7D4D0. Each
loader is handed the set number and every table it reads is a pointer array
indexed by it. RAM 0x543024 holds the loaded stage, 0x543028 and 0x54302C the
two enemy sets. The two enemy sets always have opposite flags in the enemy
flag table, and the flag picks which half of texture RAM and of the palette
each one takes. So a scene is a stage and an enemy pair, and the explorer
turns a set number into one (`dynamcopScene`). A stage is shown with enemy 0
and its partner; an enemy set with stage 1.

**Models.** The model table is at data 0xD40000 (i960 0x2D40000): 19432
entries of 16 bytes, The House of the Dead's layout. Fifty empty entries
split it into 51 banks: two copies of 25, one bank per set. Copy 1's banks
start at 0, 4000, 4370, 4419, 4853, 5264, 5335, 5621, 5908, 5971, 6184, 6333,
6436, 6984 (sets 0-13) and 7072, 7192, 7525, 7630, 7769, 7901, 8489, 8777,
8860, 9116, 9702 (sets 14-24). Copy 2 starts at 9716. Its enemy banks name
their texture records 4 MB lower in the texture ROMs than copy 1's. The
explorer draws copy 2's banks under the same sets as copy 1's, which is not
checked: what loads copy 2 was not found.

**Texture RAM** (`buildDynamcopTexram`). `bankTable[set]` is a data address.
XTRA_DATA (0x06000000) is data from 0x1000000 on, so set 5's bank at
0x06755500 is data 0x1755500. Boot's bank (0x978C0) is packed with Gage's
byte pair encoding and laid out by the boot rectangles (24 bytes each:
sheet, word offset, x0, y0, x1, y1; -1 ends it). A stage bank (0x6F9E0) is
0xAAA00 raw bytes: full size onto sheet 1 and its mips dealt between the two
sheets. An enemy bank (0x6F8D0) is 0x55500 bytes into the mip rectangles the
stage leaves free. 0x6FF60 copies the rectangles and 0x6F9A0 clears the far
sheet's mip corner. 0x97D10 then puts the stage's eight 64x64 blocks from
the stage block table onto sheet 0, as in The House of the Dead. Against
MAME's texture RAM in three attract scenes, sheet 1 matches exactly. Sheet 0
matches outside the eight block places, which on the board still hold the
blocks of every stage played before.

**Palette** (`dynamcopPalette` in `js/dynamcop.js`). Each table is a count
and that many BGR555 colours. In the order boot and the loaders write them:
the boot table up from 0, `top[0]` down from 1023, `extra` (its first 50 down
from 983, the rest down from 873), the stage's table up from 400, its `top`
down from 933, and each enemy's table up from 550 (flag 0) or 600 (flag 1).
Against MAME's palette RAM, the entries that differ are 446-484, 583-587 and
637-643, which hold colours of sets loaded earlier in the attract that the
current set's shorter tables do not overwrite, and 684, 925 and 1013-1023,
which the game changes while it runs.

**Colours.** Luma RAM is 0x7F80 bytes of the program ROM, copied by 0x70EB0.
The colour curve is The House of the Dead's with other weights (0.7, then
0.85) and fifteen ramps over the odd rows 1-29, with no gain: the first
eleven from boot's list, the last four from the stage's. Both match MAME's
RAM in all three scenes but for row 17, which the game animates.

**Lighting.** Boot uploads 31 material slots of 8 bytes from the material
table with 0x6EE74, the same call as The House of the Dead's. The table is
HOTD's but for slots 4 and 13, and the first 248 bytes are the same in all
five builds. The light vector and the plane normals are HOTD's, not read
from this program.

**Stages** (`readDynamcopStages`). The game builds its display list in
buffer RAM at 0x900000: per object a matrix, `00800101` and the model table
entry. Breakpoints on that showed the scenery comes from object records, not
from walking the banks. 0x2B960 (and 0x2B9F0) starts an area. The mission
table is twelve pointers, three per value of 0x51F4A0 (0-3), picked by
0x51F49C (0-2): `missions + 12 * [0x51F4A0] + 4 * [0x51F49C]`. Each
points at a run of area descriptors, 40 bytes each, and the area number is
0x51F4A4. Word +0x10 of a descriptor is its object list, 32-byte records:

| offset | | |
|---|---|---|
| +0x00 | byte | stored to the object's +0x50 |
| +0x02 | s16 | model, an index into the whole table |
| +0x04 | 3 floats | x, y, z |
| +0x10 | s16 | yaw, 0x4000 a quarter turn |
| +0x14 | u32 | type; the list ends at the first 0 after the first record |

The first record sets the area up (0x1D970, by its type). The others are
spawned through 0x1D9A0[type]. Type 2 (0x1F0D0, task 0x1DFD0) is the room:
its model goes to the object's +0x4C and its position to +0x30-0x38. The
other types were not traced one by one. They are props, the sea and sky
(model 4334, turned four ways, and 4367 at y -19, the sea's plane) and the
things cut scenes move. The explorer draws type 2 as scenery and the rest as
objects, each where its record puts it and turned by its yaw.

The runs have no count. A run ends where the next one starts, and the last
ends at the mission table; a descriptor whose list is outside 0x1D0000-
0x200000 is past the end. That gives 424 areas, 280 different lists, and 279
with something in them: the runs share many lists.
Each area is one room in its own frame, round the origin. The explorer lists
each list once, under the first entry that reaches it, named "Course m-v,
area a" after its place in the table (what the two indices mean in the game
was not worked out). An area is drawn under the set most of its models'
banks belong to (boot's models do not count); a model from an enemy bank is
drawn under its own set. In the attract, 0x51F4A0, 0x51F49C and 0x51F4A4 are
0, 0 and 28 at frame 2700, and "Course 1-1, area 28" in the explorer is the
cabin MAME shows then: the double doors, bed, desk and wall lamp, in the
same colours.

### Dynamite Cop's characters (`readDynamcopBodies` in `js/dynamcop.js`)

The Animation tab runs on The House of the Dead's code (`js/bodies.js`,
`readMotions` and `poseBody`) with a `dynamcop` rig in `js/games.js`. The
formats were read off the routines that use them, and differ from HOTD's in
four places.

**The skeleton is in code.** There is no body record. 0x15210 poses an
object: 16 joints, parents hard-coded as
`[-1,0,1,1,3,4,1,6,7,0,9,10,11,9,13,14]` (hips, chest, head, two arms of
three, two legs of three). Joint j >= 1 sits at entry j-1 of 16 float triples
at `offsets[char]` from its parent, turned by the parent: `pos = pos_p +
off * R_p` (row vectors). The matrices land at object +0x6A4 + 48 * j.
`models[char]` points at 15 model numbers, one for each of joints 1-15, drawn
by 0x18FC0 (joint 0 has no model). The two tables run in parallel, 96
characters each; 75 and 79 use other skeleton routines. 75 (drawn by
0x187E0) is left out; 79 is below.

| table | dynamcop | dyndeka2 | dynamcopb | dyndeka2b | dynamcopc |
|---|---|---|---|---|---|
| offsets | 0xE1890 | 0xE1880 | 0xCFE90 | 0xCFE80 | 0xF2260 |
| models | 0xE1A10 | 0xE1A00 | 0xD0010 | 0xD0000 | 0xF23E0 |

Each was found in its build by searching for the 2A tables' bytes. The motion
tables are in the shared upper half of the program, so they are the same in
all five: 2284 data pointers at 0x15FA00, frame counts at 0x161DB0 and a flag
byte per motion at 0x164160. Most data is in the extra ROM (0x06xxxxxx), some
in main data (0x02E...); the 24 pointing at 0x01... are not motions and are
skipped. 2226 motions are spaced for 16 joints: 2134 padded to the next
motion as HOTD's are, and 92 with hand tables (below) between their frames
and the next motion, which start right after the last frame or at the next
16 bytes.

**The frame is reversed.** It has HOTD's size, `((48 * joints + 127) >> 5) *
4` bytes, but the 16 angle triples come first and the root's x, y, z floats
after them, at 6 * joints. 0x15000 copies a triple's halfwords (h0, h1, h2)
to slot +0x40C, +0x40A, +0x408 (slot j at 0x3E4 + 0x2C * j), and 0x15210
builds `R = Rx(h2) Ry(h1) Rz(h0) R_parent`. Joint 0's triple is the root's
turn. Only the root's y is used for its position (x and z are travel, shown
with the travel option); the object's own yaw at +0x40 is outside the pose.
In the viewer's frame (z negated) this is HOTD's `turn` with ax = h2,
ay = h1, az = -h0, offsets (x, y, -z) and the root's z negated
(`readFrame`, `layout: 'dynamcop'`).

**Level joints come from the motion.** Bit 0 of the motion's flag byte sets
both ankles (joints 12 and 15) level, bits 1 and 2 the wrists (joints 5 and 8):
the joint's rotation starts again from the body's own and only its angles
turn it, as HOTD's reset to the scale matrix does. A part's `flatBits` names
its bit. The wrist bits were read from the code; no motion was found that
uses them.

**Checked against MAME.** A Lua script read the 16 matrices at +0x6A4 and the
motion number and frame from RAM in the attract and in play (10 dumps). The
positions `poseBody` gives for the same motion and frame match to 0.0000 in 6;
in the others the right ankle is off by up to 0.03 and two dumps by 0.12 and
0.07, most likely the frame read a tick apart from the matrices. Headless
Chrome pictures of Bruno (motion 1255, the throw) and Jean (motion 1970, the
high kick) match MAME's screen at frames 3300 and 4800, outfits included.

**The hands turn per frame** (`dynamcopHands`). The draw loop at 0x19124
(in 0x18FC0) draws joint 5 with 0x19580 and joint 8 with 0x192E0 when the
motion has a table at 0x164A50 + 8 * motion (+4 for joint 8): a halfword per
frame, indexed by the object's frame from 0 (+0x2C8). Only its top five bits
are read: n = h >> 11, r = n for joint 8 and 32 - n for joint 5. 0x7F0A0
looks the part's model up in a list of {base, alt} words ending with -1
(offsets + 0x5B0: 0xE1E40 in dynamcop, 0xE1E30 in dyndeka2, 0xD0430 in
dyndeka2b, 0xD0440 in dynamcopb, 0xF2810 in dynamcopc; the same 32 pairs in
all five). A model not listed is drawn as it is; otherwise r <= 0 or r > 23
draws alt, r <= 15 alt + r and the rest base. Bruno's hands 18 and 19 turn to
20 and 36, Jean's 226 and 227 to 228 and 244, Eddie's 355 and 356 to 357 and
373; the models after alt are the glove opened and flat. 96 motions
have tables; the 93 that read are shown (2259's points into the program ROM,
2282 and 2283 hold 0).

Checked against MAME: breakpoints on 0x192E0 and 0x19580 logged the model each
draw passes on, with the character, motion and frame. In the attract (frames
100-20000) 2908 of 2908 draws match the model `dynamcopHands` gives (2276 not
the base model), in two played runs 13416 of 13416 (characters 1, 7-10) and
242 of 242 (Bruno, motion 1718). The poses of the 10 newly shown motions
(1948-1956, 1959, 2056) were read from +0x6A4 the same way: pairwise joint
distances differ by 0.016 at the median (90% under 0.05, on a body 1.3 tall)
in the 2333 samples where the frame moves; 2056 matches to 0.000. At frame 0
the game is still blending out of the motion before, which is not drawn.

**The shadows** (`dynamcopShadows`, drawn by `placeDynamcopShadows` in
js/app.js). After the parts, the draw routine 0x197E0 calls 0x19B70 unless the
object's +0x54 has bit 5. It multiplies by the matrix at 0x54ECF0, then for each
joint in the list at 0xED2C0 (10 long, the count at 0xED2E8: joints 1, 3, 4,
6, 7, 9, 10, 11, 13 and 14) it pushes the joint's matrix (+0x6A4) and draws
`table[joint]` with 0x9A980. The table is `t[+0xBC]` (`t[0]` above 5), where
`t = 0xED140[char]`: six tables of 16 models per character. +0xBC is a hero's
player number, or an enemy's spawn record's +0x18 (0x1F130), so it picks one
of six copies of the pieces, each with its own textures. Bruno's first copy
is 1666-1675. The matrix at 0x54ECF0 is set once: 0xA6850 stores the angles
0x4000 and 0, and 0xA68D0 builds diag(1, 0, 1) from them, with no
translation. Nothing else writes it. So each piece is its joint's matrix with
world y set to 0: the joint laid flat on the floor, lit from straight above.
The view does the same to the posed joints. It always uses the first copy;
the view has no player or spawn record to pick another.
Each build loads its own addresses: tables 0xED140 (dynamcop), 0xED130
(dyndeka2), 0xFA400 (dynamcopb), 0xFA3F0 (dyndeka2b) and 0xFD860 (dynamcopc).
In every build the joint list is the tables + 0x180 and the count + 0x1A8. All
five builds' tables were read and found the same.

Checked against MAME. Breakpoints on 0x19B70 and 0x19ACC logged every shadow
draw. Every frame, a frame-done hook read each drawn object's 16 matrices,
character, motion and frame, and the matrix at 0x54ECF0. The runs were the
attract (frames 100-12000) and a coined run (to 20000):

- 0x54ECF0 held diag(1, 0, 1) in all 72279 object frames.
- In 800 random samples, `dynamcopShadows` gave the joints and models MAME drew
  in 799. The other one was cut off when its log ended.
- In the 410 samples whose posed joints match MAME's to 1 cm (296 of them
  away from the motion's first frames), the flattened pieces agree to 0.0085
  in position. Their axes agree to 0.035 (one sample at 0.11, Jean's joint 4),
  after one turn about y fits each body to MAME's.
- In the other samples, the whole pose already differs (characters 27, 45 and
  the played hero). That is the blend and the game's own turns, not the
  shadow.

MAME's picture with the 0x19B70 call patched out differs from the normal one
by exactly the floor shadows (frames 3300, 4800 and 5400).

#### What the hands hold (`dynamcopItems`, `dynamcopHeld`)

The draw (sub_197E0) calls one routine per joint from the table at 0x19760.
The right hand's (joint 8, sub_19350) and the left's (joint 5, sub_19600)
draw the hand, then what the object holds, in the hand's own matrix:

- Right hand: +0x1CC when +0x55 has bit 0. Characters 0x47 and 0x48 send copro
  0x13 (scale) 2, 2, 2 first.
- Left hand: +0x1D0 when +0x55 has bit 1. There is no special case.
- Right hand with bit 0 clear: the routine still draws +0x1CC when all of
  these hold:
  - the action (+0x178) is 0x38E;
  - +0x1CC is 0xB9D, 0xBA5 or 0xBAB;
  - the frame (+0x2C8, from 0) is past 8.

  It sends 0x12 (translate) 0.05, -0.1, 0, then 0x13 1.2, 1.2, 1.2, then
  draws.

These three models are the pickups. sub_9C338 (at 0x9C6A0) gives a hero
action 0x38E for item types 0x72, 0x76 and 0x79. 0x88180 then stores the
item's model in the hero's +0x1CC, leaving bit 0 clear. The special draw
mode (table 0x197A0: sub_1D3C0 and sub_1D4B0) draws the same two fields
with neither case.

No table lists the models. `dynamcopItems` finds every `st` of a constant
to +0x1CC or +0x1D0 in the first megabyte of program. The constant comes
from an `lda` up to twelve words before it, and stores to fp locals are
left out. The result is 13 right-hand models and 3 left-hand ones, the same
in all five builds.

An enemy's own weapon comes from its spawn records, 36 bytes each:

| offset | field |
|---|---|
| +0 | char |
| +4, +8, +C | x, y, z |
| +0x10 | turn |
| +0x14 | a pointer |
| +0x18 | the task |
| +0x1C, +0x20 | two words |

Each frame, the task stores the weapon with the constants above. The scan
reads the stores up to the task's first `ret`. Most of the
enemies get model 1134. Character 26 gets 1362 with 1388 in the left
hand, 47 gets 1034, and 31 and 66 have more than one set. The list puts
the most used set first. Heroes (0-2) have none; the char-0 records are
sub-objects.

The explorer's Held list starts on the character's own first set. It
offers every model found, and a pickup is drawn with the 0x38E case's
offset and scale from frame 10 on.

Checked against MAME using the logs from the shadow check, with a
breakpoint at each item draw (0x19550, 0x19740, 0x1D498, 0x1D590) and the
object's 16 read-back joint matrices on the same frame:

- The models: characters 36 and 40 drew 1134 in motion 981 with +0x55 = 1,
  as their spawn records give. Bruno, Jean and Eddie drew 0xBA5, 0xBAB and
  0xB9D in motion 1696 with +0x55 = 8 and action 0x38E. Every one of those
  draws was at frame 9 or later (from 0); none came earlier.
- The placement: the held model's matrix relative to the hips (joint 9),
  explorer against MAME, over 2765 draws in four logs. The hand turns up to 144° away
  from frame 1. The error stays within 0.26° and 0.0000 in position for:
  - characters 36 and 40 in motion 981 (2072 draws);
  - Jean and Eddie in motion 1696 (364);
  - and, in one played run, Bruno holding 1134 in motion 1718 (121; within
    2.2° and 0.009).
- The exception: Bruno in motion 1696 is off by up to 22° and 0.15 on
  frames 10-59, and exact from frame 60. Every joint differs on those
  frames, the legs and head too, so the body's pose differs, not the item.
  This is the blend again, as in the shadow check.

Not checked: the left hand (no character in the logs held anything there)
and characters 0x47 and 0x48's scale of 2.

Not done: the blend between motions, and which motions each character plays
in a fight (lists from 0x1B70A8). +0xCD8, once taken for a mirror flag, is the blend's
counter: 0x14690 starts a blend, storing +0xCD8 and +0xCD4 and each joint's
old and new angles from +0xCFC and +0xD7C, 8 bytes a joint; 0x14C10 eases the
angles and 0x14DA0 the root, and while +0xCD8 is set 0x15210 sends the joints
with copro commands 0x30 and 0x31, in another angle order, not 0x32 and 0x33.
No mirror was found. Only the three heroes are named.
**Cut-scene motions** (`dynamcopSceneMotions`). Word +0xC of an area
descriptor is the area's actor record. 0x84960 spawns one object (handler
0x85370) for each 36-byte entry from its +0xFC (char, x, y, z, turn, a
script, the task, two words), until an entry's script is 0. The object
takes the char in +0xDC and +0xE0, the entry's place + 2 in +0xBC, and the
entry in +0x1AC. 0x1AF00 starts it on the script:

| offset | field |
|---|---|
| +0 | s16, how long the scene runs (to +0xE48) |
| +2 | s16, the first frame, from 0 (to +0x2C8) |
| +4 | s16, the motion (to +0x2C4) |
| +6 | the next step, eight bytes a step, until a motion of 0xFFFF |

0x1AFD0 stops on 0xFFFE. The 402 entries are the same in all five builds.
The explorer leads each character's motion list with the motions its
entries name ("Played in its cut scenes"), the first one opening. So
Bruno opens on 1322, a skydive.

**Character 80** (offsets at 0x1F4F9C, models 199-213, about a fifth of a
person's size) looks like a small monkey. It appears only in course 4-1's ending
areas 46, 47 and 48, before the staff roll. Its entries' scripts are
0xC9BB0, 0xC9DA0 and 0xCA060: 510 frames of motion 2094 (16 joints, 25
frames). The tasks 0x80FC0 and 0x810B0 move it relative to the object at
[0x513450], and all three wrap +0x2C8 at 24. It is posed by 0x15210 like
any character. 0x197E0 draws it: joint routine 0x1D104 reads the model
from the list (+0xE4) and writes it straight to the display list (model
table 0x2D40000), not through 0x9A980. It also draws ten shadow pieces
from the shadow table, which character 80 shares with Jean (1838-1847
at +0xBC = 2 in area 46). Before this, the explorer opened it on motion 0
with the shadow over it, so nothing showed.

Checked against MAME by jumping to the ending: a breakpoint on 0x6E3E0
sets 0x51F4A0 = 3, 0x51F49C = 0 and area 0x2E. The object's 16
read-back matrices (+0x6A4) were dumped every 10 frames, 96 dumps over
areas 46-48, 12 of the loop's frames. Each joint's world rotation and its
position from joint 1 match the explorer's pose at frame +0x2C8: within
0.05° and 0.00001, where the joints turn up to 179° from rest. The
object's turn (+0x40) is 0 there, so world axes are the routine's own
frame. Joint 0 is not read back.

**Character 79, the bird** (`dynamcopQuadBody`, `poseDynamcopQuad`). The
object's handler 0x1A9BC sends char 0x4F to a skeleton routine of its own,
0x16BC0, after 0x169E0 copies the frame. Its motions (2093, 2097-2107) have
13 joints, 0x5C bytes a frame: 13 angle triples, 2 bytes of padding, and the
root's three floats in the last 12 bytes (`readFrame` reads them from the
end). 0x169E0 copies triple t to slots 0, 1, 2, 3, 6, 9, 5, 10-15 in that
order (h0 to +0x40C, h1 +0x40A, h2 +0x408 of slot 0x408 + 0x2C * slot), and
0x16880 puts the frame's height in +0x100. 0x16BC0 turns the root -0x4000
about y, or, for motion 2093 (a flight path in stage coordinates, height 98),
+0x40 about y and +0x3C about z instead, moves by +0x30, +0x34 + +0x100,
+0x38, then steps out joint by joint with copro 0x33 (push, move, turn z, y,
x) and 0x32, reading each matrix back to +0x6A4 + 48 * j. The 2B builds send
0x65 and 0x6B in-band after 0x19 for the same two.

The tree was fitted to those matrices against the offsets at 0x1F4EFC
(parents `-1 0 1 1 9 9 1 9 9 0 9 10 11 9 13 14`): chest 1 on the root, head 2
and wings 3 and 6 on the chest, hips 9 on the root, tail 5 and legs 10-12
and 13-15 on the hips. Slots 4, 7 and 8 get the tail's matrix and 0x17950
does not draw them. The explorer runs 0x169E0 and 0x16BC0 on the i960
(`rig.quad`, per build) with those copro commands. Without travel, 2093 is
held at its first frame's place.

Graded with a MAME hijack (break in the handler, set the char, motion and
frame, run 0x16BC0, save +0x6A4): 60 frames of the twelve motions, frames up
to 180° from rest, worst 0.039° in relative joint turns and 1.4e-5 in joint
distances. All five builds give the same matrices. Not done: 0x17950 also
draws each part flattened through 0x54ECF0 with 0x9AA50, the bird's own
shadow; the standard shadows, hands and held items are off for it.

**Character 75, the chain** (`dynamcopChainBody`). Its skeleton routine is
0x17FD0 (g0 the object, g1 the chain, 0 or 1), not the bird's 0x16D64 or
0x179A0. The record is 0x5430B0 + 0x2CC * g1: motion +0x2C, frame +0x30, and
the frame pointer +0x2C4. It turns by the frame's first three halfwords
(copro 0x32), then nine times: move by the char's next offset (0xE1890[75],
0x12), turn by the next three halfwords (0x32), and read the matrix back to
+0x48 + 0x30 * j. There is no push or pop, so it is a plain chain of ten parts,
link j on link j-1, and `poseBody` poses it as it is. Frames are 72 bytes:
ten angle triples and the root's three floats.

Two callers. sub_23D40 (spawned by 0x23F30 with char 0x4B and +0x56 bit 3)
runs motion 2245, moves by the frame's root, runs 0x17FD0 for chain 0 and
draws models 8039, 8037 ... 8025, 8024 (0xE0260[75]) on the links, with no
shadow. An enemy whose +0x56 has bit 3 runs sub_184D0 from its handler: two
chains, each pushed, moved to (+-0.75, 0.19, 0.75) (0xBECF0) on the body and
turned by 0x5430C4 (copro 0x14) and 0x5430C0 (0x15). sub_187E0 then draws
them, and the shadow under each link: 0x54ECF0, then the link's matrix, then
piece k of ED140[75][+0xBC] (7909 down to 7901), the same push, multiply and
pop as the standard shadows. The explorer shows one chain at the root, with
its shadows. The pieces' texture is on sheet 1 and comes out pale; its colour
was not checked against MAME.

The action table 0x1B70A0 (36 bytes an entry, motion at +8) names motions
2245-2257 for char 75. With the chain in `readMotions`, 2245-2250, 2252 and
2254-2256 fit ten joints, and no other motion changed its joint count. 2251
and 2253 have 16 joints, and 2257, the last motion, does not fit. 0x17DB0
blends one frame when the motion changes; the explorer does not.

Graded with a MAME hijack (break at 0x15210, set the object's +0xDC to 0x4B
and the record's +0x2C4 to the frame, run 0x17FD0 with g1 = 0, save
+0x48..+0x1F8 at its `ret`): 70 frames of the ten motions, up to 180° from a
straight chain, worst 0.014° in relative link turns and 2.7e-6 in link
distances. The root's own turn is not covered, since everything is measured
between links. All five builds read the same chain, motions and shadows.

### Fighting Vipers' cells (`js/cells.js`)

Sonic The Fighters' two tables a year earlier, at the addresses the stage sky
already reads (`stageTable.scroll`): `_ScrollCG_Initialize` (`0x2934C`) loads
`off_6450000[g0]` and `_ScrollColor_Initialize` `off_6450000[g0 + 1]`, and
`dsp_pattern` (`0x6744`) loads cell `off_6450300[g0]`. Neither routine has
Sonic The Fighters' bound, so the CG table runs up to the pattern table, 0xC0
entries or 96 CGs (`cells.cgEntries`), and the cells run to the pattern
table's terminating zero: 473.

The record is the same: the halfword at 0x00 is added to every entry, rows at
0x04, columns at 0x08, then the entries, a row 0x80 bytes on in the tilemap.
One difference: `dsp_pattern` reads the halfword at 0x02 as Daytona's draw
does, and copies byte entries where it is 0 (`0x677C`). No record has 0
there, so every cell is halfwords, as the profile reads them. Every record's
base is 0x8000, the category bit; `dsp_pattern_low` (`0x6708`) draws a cell
without it, which changes no tile or colour. Cell 22's pointer (`0x2A32EF0`)
leads to no record (a row count of 0x1020101), so the tab skips it.

472 cells have a CG that writes every character and colour they name. The
profile has no table of which CG the game uses for which cell, so the tab
ranks them as it does for an unnamed Sonic The Fighters cell. Where the code
loads a CG and then draws a cell, the ranking agrees: `0x9F40` loads CG 13
and `0x9F68` draws cell 93 (the title's backdrop), and `0x8A44` loads CG 55
before `0x8A6C` draws cell 111. The title's SEGA mark, cell 15, is drawn at
`0xA004` after CG 13 too, but CG 13 writes none of its tiles, so they are
already in from an earlier CG; the tab opens it on CG 9, which writes them
all. The unused cells are not worked out: `cells.unused` is empty.

### Virtua Fighter 2's cells (`js/cells.js`)

Virtua Fighter 2 (Version 2.1) has the same tile chip but neither Sonic The
Fighters' tables nor Daytona's: the draw, `0x8F1C`, takes the record's
address in g0 and copies it to the tilemap at g9. The record is Daytona's: a
halfword at 0x00 added to every entry, a halfword at 0x02 that is 0 for byte
entries and anything else for halfwords, rows at 0x04, columns at 0x08, the
entries from 0x0C, a row 0x80 bytes on in the tilemap. Callers name records
in the program ROM at their own addresses (`0x13D3C`), so the profile sets
`cells.programAt0` and js/scroll.js reads addresses below 0x200000 there.

There is no list of cells, so `cells.records` holds the runs the game's own
pointers lead to, records end to end, 12 runs and 268 cells across the
program and data ROMs. `0x8FE0` draws one frame of a strip (base, mode,
columns, rows, a frame count, then the frames side by side: the timer's
digits and the like); those records are not cells and each run stops at one.

The CGs are the two lists `0x23EE8` loads: a CG list of (source,
destination) pairs, each source a tile count and then 32-byte tiles, and
`0x23F30`'s palette list of (destination, halfword count, data), ending with
a destination of 0. They come three ways:

- the boot pair at `0x280000C` (`cells.cgPairs`);
- the stage skies, which `0x24314` loads from the pair at
  `0x2502C + n * 32 + 8`: 11 pairs, some shared by more than one stage;
- the pairs the screens' routines pass straight to the loaders
  (`cells.cgLists`, named by the routine): `0x11B70`, `0xAF54`, `0xB424`,
  `0x10388`, the fight's `0x10838`, `0x2DB94`, `0x31A34` (two, one on top of
  the other) and `0x60624`.

That is 21 CGs, and every cell has one that writes every tile it names. Where
a routine loads a CG and then draws cells, `cells.screens` opens them on it:
cell 0 on CG 12, 260 on 13, 152, 155 and 156 on 17, 87 on 18, 255 to 258 on
20; the ranking puts the same CG first for each. Cell 72 is drawn after CG 14
is loaded, but CG 14 writes none of its tiles, so it is not paired. The 12
unused cells (19, 38, 68, 83, 146 to 150, 153, 154, 259) are records no
aligned word in the program or data ROM points at; some of them show only
jumbles on every CG listed, so the CG they were made for is not among them.

### Virtua Cop's cells (`js/cells.js`)

Virtua Cop (Revision B) uses the same tile chip with a record of its own:
u16 columns, u16 rows, then a halfword entry per tile, written onto 0x80-byte
tilemap rows. This is the shape of Dead or Alive's maps, so `pictureHeader`
reads both. The draw, `0x55A0`, takes the record in g0, the tilemap address
in g1, and in g2 a halfword it adds to every entry. `0x5610` is the same but
skips zero entries. `0x5690` fills; `0x56F0` and `0x5A30` draw text and are not
cells. The bases the callers pass (`cells.base`, `cells.bases`):

- 0x8000 for most records;
- 0xC000 only, for 0x28022E8, 0x2802300, 0x2807D70 and 0x2807DA0;
- 0 for the sky 0x2803790, the sea 0x2802F00, 0x2810C40 and 0x2811150;
- both 0x8000 and 0xC000 for 0x2802A10, 0x2807DC0 and 0x2808640, and 0x8000
  and 0x4000 (`0x67080`) for 0x2812C90. The profile keeps 0x8000 for them.

The records lie end to end in two runs, with zero halfwords padding some of
them out (`cells.sized` skips the padding). [0x28022E8, 0x28113D4) holds 225
records and starts exactly where the boot palette's 52 runs from 0x2801C00 end.
[0x28114D0, 0x28143D4) holds 57 more, 282 cells in all. Most callers name a
record directly with `lda`. `0x6E50` to `0x6E74` read lists at 0x28149C0,
0x2814A10, 0x2814A20 and 0x2814A30 (a count, then {record, column, row}), and
`0x59BD4` reads 0x2839830 by stage. Because the displacements are aligned
words, the unused search works as it does elsewhere: 68 records are named by no
aligned word in the program or data ROM.

There are no CG lists. The boot, `0x49B0`, fills the chip itself, and
`cells.boot` repeats it in order:

- characters: `0x4A38` copies 0x2400000 into characters 0x80 to 0x37FF;
  `0x4AA8` copies 0x28E0000 over 0x3300 to 0x3FFF. Both swap the bytes of each
  halfword. `0x5080` expands a 1-bit font into characters 0 to 0x7F. No record
  names 1 to 0x7F and character 0 is blank, so this step is left out;
- palette: `0x4B10` writes runs from 0x2801C00 (a count, then 16 colours,
  written that many times) into groups 1 onwards until 0x7F are done. Then
  0x2814780 goes into group 0x2B, groups 1 to 0x7F are copied to 0x81 to 0xFF,
  0x2814680 goes into 0x81 to 0x83, 0x28146A0 into 0x84, 0x28148A0 into 0xAE
  and 0x28148C0 into 0xAF. `0x4CE0` writes the 6 runs at 0x28113E0 into 0x66
  onwards and again into 0xE6 onwards, and 0x2814940 goes into 0xFB to 0xFF.

The stage start writes 16 colours into group 0x10, the sky's, from the address
at 0x2814990 + stage × 4. So the Cells tab has four CGs: the boot's, and one per stage with
that stage's sky colours. Every cell has one that writes every tile it names.
The colours go through Daytona's colorxlat (`cells.colorxlat`).

### Dead or Alive's pictures (`js/cells.js`)

The 2D art is not Sonic The Fighters' cells and CGs: each picture brings its
own tiles, colours and map. The table at data 0x20C0000 (data ROM 0xC0000)
holds 242 entries of three pointers, 12 bytes each:

- tiles: chunks of a u32 count and that many 32-byte tiles, ending with a
  count of 0; each chunk starts a fresh block of 128 tiles;
- palette: 16 colours (32 bytes) a chunk, for every block the chunk fills;
- map: u16 width and height in tiles, then a u16 entry a tile, the low 13
  bits the picture's own tile number.

The loader (`0x9000` on Revision B) takes free blocks from its bitmap at
`0x54F980`, writes the tiles to `0x1080000 + block * 0x1000` and the colours
to `0x1800000 + block * 32`; the draw (`0x9250`) adds the block to each
entry's character (`block << 7`) and makes it the palette group too. Every
map's highest tile number is its own tile count less one, so a picture needs
nothing loaded with it: the Cells tab gives cell n its own CG n, loaded from
block 0. The pictures are the Tecmo logo and warnings, the profiles and name
plates, portraits, the stage skies (named from `doa.sky`), the fight's
messages, fonts, the rankings, endings, staff roll and title logos. The table
is the same in every build.

### Virtual-On (`js/von.js`, the `vonj` profile in `js/games.js`)

Cyber Troopers Virtual-On is a Model 2B game like Sonic the Fighters, but it
keeps none of the tables the others do. The tables below were found with
MAME (`vonj`): Lua taps on the copro and geometrizer ports, and the texture
RAM, colorxlat and luma RAM saved at each field's start, then compared with
what the explorer builds from the ROMs. The routine names are the ones in
rokuYAMP's `docs/von-rom-symbols.md`. Addresses are `vonj`'s; `vonu` has its
program tables 0x610 to 0xC30 further on, and the profile lists its own.

`vonj.zip` holds only the program pair (`epr-18664b.15`, `epr-18665b.16`);
the second program megabyte and the data, polygon and texture ROMs come from
the parent `von.zip`, as MAME loads them. The loader finds each chip by CRC,
so the two zips can be dropped together.

**Models.** There is no model table. Each piece is sent to the geometrizer
as an object: command 1 (`0x800010`), then three words to `0x804000`, the
texture point pointer, the header pointer and the mesh pointer. So
`scanModelTable` (`js/romset.js`) makes a table, one entry a mesh. The
meshes lie end to end from polygon word 0 (40-byte records up to one whose
attribute word, at +24, has its low two bits clear; the next mesh starts 3
words before that record ends), up to the 0xFFFFFFFF fill at word 0x3EE7F1:
7097 meshes, all of which decode (569,414 triangles). The data and program
ROMs keep many of the triples as aligned runs of three words, so the scan
looks there for (tpa, tha, 0x800000 | mesh start) with the first two under
0x800000. 5860 meshes have one, and the 2166 MAME's attract draws all agree.
A scan of the code's immediates for the rest was too noisy to use. The other
1237 are chained from the mesh before: their points start where its headers
end, and their headers where their own points end. That holds for 92% of
the pairs that both have a triple. The triples the stage code sends are
exact, so `addModelTriples` puts them in over the chained ones and chains
again; that fixes models 1331, 1430 and 1431, whose chained pointers were 8
bytes out.

**Textures.** `LoadTextureLZ` (0x281F0) unpacks banks with an LZ routine at
0x27E50 (a 0xFEE window). The boot bank starts at data 0xC00008, and the
other banks are listed at program 0x280C0. Each unpacked halfword goes to
the same place in one of the two texture sheets: the first 0x60000 go to
the first sheet, and past that the 512-byte table at 0x27C50 (read at
0x2801C) picks the sheet by the low and high byte of the index. The mip
levels live on the other sheet. A field loads the boot bank, bank 0, then
its own bank, from the table at 0xC8ED0 (one u32 a field, read at 0xC8FB4:
0, 0, 2, 1, 2, 1, 3, 3, 4, 4, 4, 4, 4, 4). Field 13 loads none and keeps
what was there before; in MAME's attract that is field 3's bank 1, so the
explorer gives it bank 0 (`keepBank0`). Fields 0, 2, 3, 4 and 5 match MAME's
texture RAM byte for byte.

**Palette.** The boot copies the face palette out of the program ROM; the
`ldos` at 0x29A98 points at it (0xF48D0). Entries 8-31 are cycled by the
records at data 0xBF83C4 (a shift, a mask and a pointer to the colours);
the explorer shows the first colour of each.

**Luma.** `MakeRGBTable` (0x28840) writes two grey ramps of 128, then 0x2080
bytes from data 0xFB1D10 at entry 0x800. It matches MAME exactly.

**Colorxlat.** `MakeRampIntensityTable` (0xE1E00) builds a grey curve, and
`RampSet` (0xE2330), through `SetRampRGB_TBL` (0xE1F20), `_URA` (0xE1FB0)
and `_BOTH` (0xE2040), puts rows of 64 RGB triples into it. The rows every
field has, and each field's own, are listed in the profile (`colors.von`)
as row number and source address; `InitRampSet` (0xE2130) loads them. The
robots' rows (1, 3 for player 1; 5, 7 for player 2) come from
`SetRoboRamp` (0xE2120) and the table at 0x142E94, by robot and costume.
The explorer's grey curve is the game's with a gamma of 0.55. Against
MAME's captures the only rows that differ are the robots' (which depend on
the attract's picks) and leftovers in the back half from the field before.

**Lighting.** `TGPInitialFunc` (0x294B0) uploads 32 material slots of 8
bytes from 0x293B0 with geometry function 6 (0x292D8). Each field's light
is three floats at 0x142FD4 + 12 * field, which `initField` stores at
0xC9030 into `g_light` (0x577100). Field 0's is (-0.296198, -0.5,
-0.813798), and the Models tab uses it.

**Stages.** The field number is at 0x5770F0. The table at 0xC8E10 has three
routines a field: the one `initField` (0xC8FA0) calls once, the floor's,
which `execFieldFloor` (0xC8F10) calls each frame with the frame count
(0x577114), and the rest's, which `execField` (0xC8F60) calls. `js/von.js`
runs them on `js/i960.js` with the copro and geometrizer of `js/doa.js`,
for two frames, and keeps the last frame's draws. The copro takes the same
commands as Dead or Alive's (5 push, 6 pop, 0x12 translate, 0x14-0x16
turns) and two more:

- 0x3A, with one word, the geometrizer list address (0x802008): the copro
  writes its matrix into the list, and the pieces after it draw under it;
- 0x2A, with one float, a scale on all three axes. Fields 3 and 4 draw their
  floors (0xC6EB0, 0xC7120) at 2.

No other command comes up. The pieces each field draws: 0: 4, 1: 19, 2: 2,
3: 4, 4: 10, 5: 4, 6: 5, 7: 10, 8: 6, 9: 7, 10: 10; 11 and 12 draw nothing,
and 13 runs 10's routines, so it is left out. The names are the strings the
fight's start prints, 18 bytes each, from `lda 0x21060[field * 18]`
(0x21EE4): Airport, Death Trap, Waterfront, Green Hills, Ruins, Space Dock,
Moon Base, Flooded City, Nirvana and Secret Base.

What this leaves out: Green Hills draws its sky and no floor, Space Dock
and Moon Base only a few small pieces, Nirvana a tube and Flooded City a
plane and its backdrop. The rest of those fields is probably drawn by code
that follows the camera or culls, which is not run. The robots are on the
Animation tab (below).

### Virtual-On's robots (`readVonBodies` in `js/von.js`)

The Animation tab has nine robots, `rig: { kind: 'von' }` in the profile.
Nothing of HOTD's `js/bodies.js` is used but the shape of a body: the parts,
the motions and the pose are read and built in `js/von.js`, from the draw
routines (the legs 0x8DD40, the upper body 0x8DFC0, the weapon 0x3403C).

**The robot record.** `ld 0x19360[g3*4]` (0x19D74 and others) reads a table
of ten pointers to robot records, in the select screen's order: Temjin,
Viper II, Belgdor, Raiden, Dorkas, Fei-Yen, Apharmd, Bal-Bas-Bow,
Jaguarandi, Zig-Raht. The name is at +0x6BC. +0x00, +0x08 and +0x10 are
three lists of parts, each a pointer and a count: the weapons, the upper
body and the legs. A list entry is 8 bytes:

| first word | second word | the entry |
|---|---|---|
| nonzero | variants pointer | a drawn part |
| 0 | -1 | nothing (the upper body's entry 0, its root) |
| 0 | 0-5 | a slot: its frame entry is kept at 0x562430 + 12 * slot |

A variant is 16 bytes: the texture point pointer, the header pointer, a
second header (used when the object's +0x1AA is set) and the mesh word.
Which variant is a halfword of the object per part (from +0xDA for the legs,
from +0xB6 for the upper body, +0xB2 for the weapon). The explorer draws
variant 0, except in a win or a loss (below), which step it. Variant 0 of
some parts has mesh 0, which is not drawn. Temjin's upper body part 6 has
62 variants that its win and loss step through, 61 down toward 2, one a
frame. The triples go into the model table through `addModelTriples`,
as the field code's do. Slot 0 is the waist, the legs list's last entry.
Slot 1 is the hand the weapon list's entry 1 is drawn in.

Zig-Raht's record, the last, has no weapons or upper body list. Its own
draw (0x3A510) places the object (0x12 its place, 0x2A its +0xAC scale,
0x15 and 0x14 its turns, as the other robots' draw does) and then sends
the legs list alone, 26 parts at 0x17720, through the same part draw
0x8DD40: `g0` the record at 0x51ACFC, `g4` the frame at 0x51AD00, `g3` the
variants at +0xB0, and `g5` 1 so it draws every frame. Its variants are 16
bytes like the others', two per part, the same. Its +0x70 pairs are other
robots' 8-part legs records, which it never plays. The records it plays
are set by its own code, 0x37FC4-0x399A0, all 26 parts: eight as literals
(0x2B1D9DC at 0x37FC4, 0x2AC7824 at 0x39994, ...) and fifteen loaded from a
table at 0x382F0 (`ld 0x382F0[g4*4]` at 0x38350, 0x382F4 at 0x384A0,
0x382F8 at 0x38610, 0x38320 at 0x386CC, 0x38334 at 0x388F4). The frames
come from counters on the object (+0x17A, +0x194). The explorer lists the
23 as Zig-Raht's motions (`rig.boss`), each its record's address, and
poses them on the legs path: one record's last frame is the next one's
first. vonu's code is the same 0xC30 on (the table at 0x38F20), and the
records, in the shared data ROM, the same. The effects the draw hangs
before the parts (table 0x2BE31DC, by the countdown at 0x51ACE4) and off
slot 0 after them (0x51ACE8) are not drawn.

Zig-Raht is a fight object like the others: the fight's setup reads each
player's robot from 0x503A98/0x503A9C (`ld 0x19360[g3*4]` at 0x19DC0), and
the object's init (0x27550) gives index 9 its own handler (0x274A0, which
runs the actions at 0x3D520 and the draw) and init (0x3D5D0). So writing 9
to 0x503A9C each frame puts it in the attract's fights as player 2, with
its own controller. Checked against MAME that way (upstream MAME, vonj,
20000 frames): a write tap on 0x801008 (the list address the copro writes
the matrix at, + 0x34) and 0x804000-0x80400F (the object's words, matched
to Zig-Raht's 25 meshes) logged each part, with 0x51ACFC and 0x51AD00 as it
was sent; the 12 floats after the 0x0580xxxx word at that address in
bufferram, read at the end of the frame, are its matrix. On all 10135
frames it was drawn, each part's matrix relative to part 0 matches the
explorer's on entry 0x51AD00 (the tab's frame + 1) to 0.064 degrees and
0.0041 units. Player 1's Temjin legs in the same run show the same floor
(95% of frames within 0.07 degrees), with or without `-nodrc`, so that is
the copro's arithmetic. 21 of the 23 records played, every entry of the
long ones. Two never did: 0x2B2BA44 (0x38224, when the counter +0x194 is
negative) and 0x2AC7824 (action 6, 0x39980).

`vonu`'s records are 0xF0 lower, their table at 0x19270; the records and
lists are the same.

**Motions.** From +0x70 the record holds 103 pairs of record pointers, the
upper body's then the legs'. The draw (0x2EE70) reads them as
`0x1D8[n * 40]` and `0x1DC[n * 40]`, the same pairs in groups of five. A
record is 8 bytes in the data ROM: the data pointer, a u16 frame count and
an s16 part count. A frame is 12 bytes a part: three s16 angles (x, y, z,
65536 a turn) and three IEEE half floats, the part's offset, which the copro
takes with command 0x2F (the low 16 bits of three words). The part count is
negative where the frames run backwards from the pointer; the draw steps by
the signed count and loops over its size, so a list entry past the count is
not drawn on that motion. The frame is clamped to the last. The legs'
records have 8 parts (Bal-Bas-Bow 9), the upper body's 12 to 17. The two
records of a pair play on one frame count (0x51AB10 and 0x51AB12). Repeated
pairs are dropped: Temjin, Viper II, Belgdor, Raiden, Dorkas, Apharmd and
Jaguarandi have 97 each, Fei-Yen 93 and Bal-Bas-Bow 89. The game names
none, so a motion is called by its pair's number.

These are not all of a robot's motions. The robots' action code keeps more
pairs in tables of its own, between 0x42460 and 0x4FFFF (865 different
pairs; the one Temjin is on at the attract's frame 2400 is at 0x46950, an
action indexed by the object's +0x188). Telling which robot plays them
means following each robot's action routines, so they are not listed, but
for the wins, the losses and the attacks on the move.

**Wins and losses.** The object's +0x172 is its action, dispatched at
0x33B0C through the table at 0x32560 (16 bytes an action). Action 41 is the
loss (0x324E0, set at 0x33944 when the object's +0x1D0, its health, is 0 or
less) and calls the record's +0x440; action 42 is the win (0x32540) and
calls +0x43C. These robot routines run on the object's frame counter +0x17A:
they pick pairs from tables of their own, write the record pointers and
frames to 0x51AB08-0x51AB12 (the legs and upper body, as the draw reads
them), and step the part variants. The draw (0x33C40) then calls the
record's +0x434, which steps more variants. A win picks one of two runs on
its first frame by the game's random draw (`bal 0xF5058`, `& 1`, kept in
+0x17E; `vonu`'s draw is 0xF5C98). Some routines pose parts only while the
scene, 0x503A00, is 12, the scene a played fight shows them in (the
attract's is 7, the KO's 10, 11, 20 and 21).

`runVonAction` runs them in `js/i960.js`: the object at 0x503AD0 (player 1)
with the record at +0x6C and 0x51AB14, the action at +0x172, the scene 12,
and the random draw hooked to answer 0 or 1. Each frame it sets the game
frame (0x5024E8), calls the routine and +0x434, and keeps the pair, both
frames and every part's variant. A run lasts its first legs record's frame
count. The Animation tab lists them after a robot's pairs as `win 1`,
`win 2` and `loss`, and the frame slider steps the run: each frame draws
its own pair at its own frames and each part's variant. Some robots share
code: Jaguarandi's win and loss are Raiden's pairs, and Apharmd's loss is
Temjin's. The hook needed `js/i960.js` to answer a `bal` as it does a
`call`; the stages and motions read for Dead or Alive, Air Walkers and
Dynamite Cop are the same with it.

Checked against MAME: a played run (inputs from a seeded random pad, 16000
frames) logged, each frame, the object's action, 0x51AB08-0x51AB12, the
variant halfwords and the mesh each part's draw sent (read at 0x8E28C, the
upper body, 0x8DF3C, the legs, and 0x34230/0x3428C, the weapon). It showed
Temjin's two wins and loss, Viper II's and Dorkas's losses and Belgdor's
first win. On the 1001 frames in scene 12 the explorer's pair and both
frames match on every one (1623 of 1623 over all scenes). The parts the
runs move off variant 0 match on every frame of the wins (Temjin 906 of 906
and 42 of 42, Belgdor 324 of 324) and on all but the first frame of each
loss in scene 12 (Temjin 244 of 246 and 360 of 360, Viper II 64 of 66). The
mesh each part's draw sent is the variant record's at MAME's variant 18310
times of 18318. The attract's loss of Bal-Bas-Bow (frames 6628-6688) is on
the explorer's pair.

What is left out:

- a loss in a fight starts in the KO scenes and reaches scene 12 some 72
  frames in, so the parts posed only in 12 start late there; the explorer
  runs the whole loss in scene 12;
- what the fight leaves behind: the boosters' flicker (upper body parts 2-5)
  and parts closed by fight states;
- the loser's parts knocked off at random every 8 frames (`19A = rand %
  count` at 0x3251C, variant 1, the debris drawn at 0x34F8C); these are the
  8 meshes and 4 variants that miss;
- Viper II's thrusters in its win, which its routine draws itself
  (0x6ECE0).

**Attacks on the move.** Action 16 (0x2FB20) is the attack. On the ground
it plays the record's listed pairs (+0xB8/+0xBC, 8 bytes a sector), but
when the object is moving it calls a routine the record holds, chosen by
the object's +0x170: +0x3AC while dashing (2, the state that leaves the
ground trail), +0x3B4 while jumping (3), +0x3C4 and +0x3BC for 4 and 5.
The routine picks its pairs by +0x188, one of four sectors from the angle
to the opponent at +0x102 (0x36578-0x365E8: 0x1001-0x2000 is 2,
0x2001-0x6000 is 1, 0x6000-0x6FFF is 3, the rest 0). Temjin's dash attack
(0x4A990) reads 0x46950, 24 bytes a sector: phase 0 plays the first pair,
phase 1 repeats while fire is held (+0x141, +0x1DE), then the third pair;
at its end it sets +0x170 back to 1. None of these pairs is among the
record's +0x70 pairs. Raiden's jump attack table (0x46E20) holds the same
records as Belgdor's (0x47660); the game shares them.

`runVonAction` takes the state and sector, sets +0x170 and +0x188 after
the action's entry, and runs the routine while the object stays in that
state and action. The Animation tab lists `dash attack 0`-`3` and `jump
attack 0`-`3` for every robot (72 runs of 29 to 80 frames; Temjin's dash
attack is 63 frames, his jump attack 43). States 4 and 5 are not listed: no
run showed them.

Checked against MAME (`vonj`): the attract (20000 frames), and the attract
again with Belgdor and Dorkas written into the robot choice (0x503A98,
0x503A9C) every frame, logged each frame's object and 0x51AB08-0x51AB12.
Each attack frame was stepped from MAME's object of the frame before. Of
1408 frames (Temjin, Viper II, Raiden, Fei-Yen, Apharmd and Bal-Bas-Bow,
both attacks) 1378 match the pair and both frames, and every part variant
of those frames matches. Of the 30 others, 23 are frames where MAME's frame
callback straddles a game frame (every 30th) and 7 are first frames, where
the action's entry (0x365EC clears +0x17A) ran before the routine. With
Belgdor and Dorkas 768 of 789 frames match; the 21 others are on the same
pair, one frame off. 19,892 of 19,968 variants match; the 76 others are
the body's part 6 cycling 2-5 every frame, which the attack routine does
not write. The 23 attract attacks that started from frame 0 follow the
tab's runs frame for frame until they are cut off, the fire is held or the
straddle; most attacks there start part-way, from a counter carried over.
Jaguarandi never attacked on the move in either run.

**The pose.** Every part is drawn at `T(offset) Rz Ry Rx` of its frame
entry (copro 0x2F, then 0x16, 0x15, 0x14), each in a push and pop:

- the legs from the robot's place, which is the object's matrix turned by
  its +0x184, +0xFC, +0xFE and +0x34;
- then the waist the same way, turned on y by the object's +0x36 (the
  twist, `0x33F70`); then the inverse of the upper body's entry 0
  (`Rx(-x) Ry(-y) Rz(-z) T(-offset)`); then each upper body part;
- the weapon at the hand's entry under the upper body's root; for Fei-Yen
  (the object's +0x64 is 5) moved (0, 0.3, 0) first (`0x340E4`); then, when
  the record's +0x484 is not 0, turned on y by the object's +0x3A and on x by
  its +0x38 (`0x3412C`). +0x484 is 0 for Fei-Yen and Bal-Bas-Bow, so their
  weapons never turn.

**The aim.** The fight sets +0x3A each frame (`0x339A0`-`0x33A74`): the
bearing to the opponent (+0x84) less the robot's facing (+0x2E) and the
twist, held to ±0x3000 and then nudged ±0x400 by the difference in height.
+0x36 and +0x38 follow the opponent a step at a time in the routines run
while +0x170 is 5 or 6 (`0x389F0`, `0x38B30`; the tilt is held to
-0x1300..0x3000 there). They start when the object's byte +0x13C, or +0x13B
while the counter 0x51ACA8 runs, is 0xFF (`0x3EBA4`). Neither came
up in the attract or in played runs. The explorer's Aim sliders set all
three (`poseVonRobot`'s `aim` option); their ranges are the clamps above.

**Checked against MAME.** A Lua script read the matrix written into the
geometrizer list for each object (`:bufferram` at the list address) and
the pair and frame from 0x51AB08-0x51AB12. In the attract fight at frame
1800 Temjin is on pair 0 with the counter at 16: with the record's entry 17
every leg and upper body part matches to 5e-5, and the weapon's offset
exactly (its turn differs by the aim). At frame 2400 (the pair at
0x46950) the legs match to 1e-4, and the upper body, drawn a
frame earlier, matches part to part to 3e-4. So the counter is one behind
the entry drawn; the tab's frame 1 is entry 0.

The aim was checked the same way, but reading `:bufferram` at the end of the
frame: read at the object write, a few matrices are the previous frame's.
The comparison is each part's matrix relative to the first leg part, MAME's
against the explorer's, for every robot drawn on every other frame:

- the attract, frames 1500-7000 (Temjin, Viper II, Fei-Yen, Bal-Bas-Bow,
  3219 robots): of the 2974 whose legs and upper body match, all but 7
  weapons match to 2.3e-3. Without the aim, 1251 Temjin and Viper II weapons
  miss. Without
  the 0.3 lift, Fei-Yen's weapon misses by 0.21. The 7 (Temjin at 1736,
  Bal-Bas-Bow at 6386-6480, whose +0x3A is 0) miss the same way without the
  aim, so the aim is not what they lack.
- a played fight (random held inputs, frames 1500-9000, 6693 robots): one
  weapon of the 6255 whose legs and upper body match misses.
- twists and tilts fed to the board's own draw by a read tap on +0x34-+0x3B
  that answers only inside the draw (`0x33D74`-`0x342FF`), twist ±0x3000 and
  tilt -0x1300..0x4B00 (3170 robots): every weapon whose legs and upper body
  match is within 1.3e-3. Without the aim, the upper body's median miss is
  4.4 and the weapon's 1.0.

### The House of the Dead's cells (`js/cells.js`)

The finished game (`hotdo`) keeps its 2D art in Dead or Alive's shape a year
early. The table at program 0xA6580 holds 630 entries of three pointers, 12
bytes each (tiles, colours, map), and ends where the floats at 0xA8308 start.
The draw (`0x17D80`) takes the tilemap, two bits, the column, the row and the
picture's number. It reads the picture's slot, a halfword at
`0xA9B50 + 2 * n`. If the slot is negative, `0x17D50` loads the picture:
`0x17B20` finds a run of free 128-tile blocks, `0x17CB0` copies each chunk of
tiles into a block of its own, and `0x17C10` copies that chunk's 16 colours
into the block's group. The map is the u16 columns and rows and then halfword
entries; the draw adds `(g1 << 15) + (g2 << 14) + (firstBlock << 7)` to each, so
the group is the block, as in Dead or Alive. The panel loads each picture from
block 0, with no other CG under it.

The palette goes through colorxlat, as MAME's `palette_w` sends it. Checked
against MAME's title frame: cells 38 and 39, drawn at (8, 24), match every
pixel (27994 and 29517 of them); without colorxlat, 31% match. The pictures
are reached by number, not by pointer, so there is no unused list.

Revision A (`hotd`) moved its tables, and its picture table has not been found,
so it has no Cells tab.

### Sega Rally Championship's cells (`js/cells.js`)

AM3 keeps its 2D art in files of its own, each a CG and its patterns. A file
starts with the eight bytes "CGM 1.0 ", which the loader (`0x5C8EB0`, in the
RAM copy of the program) compares before it reads anything else, so a scan
of the ROMs for them finds every file. After the magic:

- u16, the number of blocks;
- each block: 16 colours (32 bytes), a u16 the loader does not read, a u16
  tile count (up to 128), and the tiles, 32 bytes each;
- u16, the number of patterns;
- each pattern: a 16-byte name, s16 columns, s16 rows, and a halfword entry a
  tile.

The loader gives block k the palette group g + k and the 128 characters from
(g + k) × 128, copying both as they are (`0x5C58B0` and `0x5C5918` queue the
colours). g is the first free group, which the reset (`0x5C8A60`) sets to 9,
past the font; the draw (`0x5C8C10`) adds g << 7 to every entry, so the
group is the block. In m2-hle2 the first writes of the file at 0x28AE89C
(`sa_push1`, PUSH START BUTTON) are its colour 0x7EA9 to 0x1800120, group 9, and its
first tile word 0x11110011 to 0x1089000, character 0x480, as the profile
loads them.

The Cells tab has a CG for each file, loaded from group 9, and a cell for
each pattern, named as the file names it: 141 files (16 in the program ROM,
125 in the data ROM) and 853 patterns. MAME's third data pair is 2MB, and the
region repeats it from 0xA00000 to 0xC00000, so the scan stops at 0xA00000
(`cells.cgm.dataEnd`); past it would be the same 59 files again. The game
loads a file by its address, so the 49 files no aligned word in the program
or data ROM names have their 363 patterns marked unused. The colours go
through colorxlat, as on the other Model 2 games.

### Virtual-On's cells (`js/cells.js`, `vonCells` in `js/games.js`)

Virtual On's maps carry no header: the draw routines take the map's address,
its width and its height from the caller, and write each entry to a tilemap
with bits of their own set.

| routine | tilemap | bits |
|---|---|---|
| `0x1DC10` | layer A, 0x1000000 | 0x8000 |
| `0x1DD80`, `0x1DE00`, `0x1DE80` | 0x1002000, 0x1006000, 0x1004000 | 0x8000 |
| `0x1DC90` | layer A | 0xC000 |
| `0x1DD10` | layer A, at a column and row | 0xC000 |
| `0x1BC90` | any, a row at a time (`memcpy`) | none |

Bit 14 takes the colours from the upper half of the palette. So a cell is a
call with a constant map: the profile lists every one in vonj (`VON_MAPS`,
taken from the code, one cell a map, the largest where a map is drawn twice)
and the two tables:

- the robots, at program 0x20B50 (vonj), 0x68 bytes a robot: +0 the 31 × 35
  portrait (drawn by `0x211F0`), +0x4C the name plate with its columns and
  rows at +0x50 and +0x54 (drawn by `0x1DC90`). The plates name the robots;
- 0x211B0: ten 20 × 15 plans of the stages (`0x21EB8`).

The map at 0x2FDA1D0 is 64 × 64 zeros the game clears a layer with, and is
left out. So are the calls that take their map from a table of digit glyphs
(0x2EA1E50 to 0x2EA2090, and 0x2EA289C), a counter's 1 or 2 by 2 tiles each.
That makes 119 cells.

The tile chip is filled at the start and not again, as Virtua Cop's is
(`cells.boot`). `InitScroll` (`0x1C220`) draws the 1-bit font at data
0x2EA0BB8 into characters 0 to 0x7F with pen 1 (`0x1C730`). `SetScrolldata`
(`0x1BDA0`) does the rest, and its argument picks one of two fills: 0, from
`InitAll` (`0x18970`) and `InitAdvertize` (`0x2B508`), for the attract mode,
and 1, from `InitGameMain` (`0x190E4`), for the game. Each copies its
characters with the bytes of each halfword swapped (`0x1BC20`; the count is in
halfwords):

- 0: 0x2EA2A74 to characters 0x80, 0x1880 of them; 0x2ED3054 to 0x1900,
  0x1700; 0x2F4DB14 to 0x3000, 0x680;
- 1: 0x2EA2A74 to 0x80, 0x1880; 0x2F000D4 to 0x1900, 0x2700;
- both, after: six runs from the program ROM's second megabyte (0x144CC4,
  0x146324, 0x144184, 0x145BA4, 0x146C24, 0x146C64) to characters 0x1488,
  0x3DB0, 0x3D10, 0x3F40, 0x37C and 0x37E, and character 0x1570 filled with
  0x9999.

The colours are written by `SetScrollcol` (`0x1BB90`), which stores each
component's low bit apart: a stored colour v is the 555 colour
`(v >> 12 & 1) | (v & 15) << 1 | (v >> 13 & 1) << 5 | (v >> 4 & 15) << 6 |
(v >> 14 & 1) << 10 | (v >> 8 & 15) << 11`. Fill 0 writes 0x2FDEF20 (0x31
groups), 0x2FD6EA0 (0x2E) and 0x2FF7568 (0xD) from group 1, and the same from
0x2FDF540, 0x2FD7460 and 0x2FF7568 from group 0x81; fill 1 writes 0x2FDEF20
(0x31) and 0x2FED0E8 (0x4E) from group 1, and 0x2FDF540 and 0x2FEDAA8 from
0x81. Both then write program 0x1BB50 to group 0xA9 and 0x1BB70 to 0xFA, 0xFB
and 0xFE.

So the Cells tab has two CGs, the attract mode's and the game's, and every
cell has one that writes every tile it names. The colours go through
colorxlat. vonu has the same maps; its program moves the robot and stage
tables up by 0xA40 (to 0x21590 and 0x21BF0) and the two colour tables down
by 0xF0 (0x1BA60, 0x1BA80), found by their bytes, and its cells keep vonj's
call sites as their names. The seventh advice screen of the attract mode
(0x2FD0464, drawn by `0x20974`) comes out garbled on both CGs; the others
read, so its characters are probably loaded by something not found yet.

### Dynamite Cop's cells (`js/cells.js`)

Dynamite Cop keeps The House of the Dead's pictures, routines and all, a year
on. The table is at program 0xE9B10 in the 2A export build (0xE9B00 in the
Japanese 2A, 0xC9880 and 0xC9870 in the 2B pair, 0xFA230 in the 2C): 971
entries of three pointers, tiles, colours and map, into the program's upper
pair and the data ROM, ended by a zero entry. The table's bytes are the same
in all five builds; only where it sits moves. The code reads the three words
at `table`, `table + 4` and `table + 8`, indexed by `n * 3` (0xA3B94 to
0xA43A4 in the export 2A build, and 0x1DD00 and 0x2BA90).

0xA3F30 loads a picture into free blocks the first time it is drawn: 0xA3C50
finds a run of free 128-tile blocks, 0xA3E70 copies each chunk of tiles into
a block of its own, and 0xA3DE0 and 0xA3D40 copy that chunk's 16 colours into
the block's group. The draw (0xA3F90) adds the first block to every map entry,
and ORs in the category bit (`r5 << 15`) and `r6 << 14`, so the group is the
block, as in Dead or Alive and The House of the Dead. The panel loads each
picture from block 0, and the palette goes through colorxlat.

Checked in the explorer on every build: all 971 open, and the stage 4
briefing (cell 930) and the "2" logo (434) draw whole, as does the mission
text (600) in the export 2A build. The pictures are reached by number, so there is no unused list.

### Power Sled's cells (`js/cells.js`)

Power Sled has no maps. Its draw, 0x4EE0, takes the tilemap address in g0,
a script in g1 and a halfword to OR into the entries in g2 (every one of the
65 calls sets bit 15, the category bit), and walks the script a byte at a
time. A byte up to 0x7F writes entry b of a dictionary at RAM 0x51AD40; 0x80
and up index a jump table at 0x4F50, and anything above 0x8D returns. A
character is built from two bytes as `(0x100 + lo + (hi << 8)) & 0x3FFF`:

| op | arguments | what it does |
|---|---|---|
| 80 | x, y | go to `0x1000000 + (y << 9) + x * 2` |
| 81 | s | move `s * 2` bytes, s signed |
| 82 | n, lo, hi | n copies of the character, rightwards |
| 83, 84 | n, lo, hi | n entries counting up (down) from it |
| 85 | n, hi, b... | n entries, `(0x100 + (hi << 8)) \| b` each |
| 86 | n, (lo, hi)... | n characters, ORed with the whole of g2 |
| 87 | the same | and each one added to the dictionary |
| 88 | k | clear layer `k & 3` from the table at 0x33E0 (0x4890) |
| 89, 8A | n, lo, hi | n copies downwards, 0x80 bytes a step |
| 8B, 8C | n, lo, hi | n copies upwards |
| 8D | a, b | move `(a + b)` signed, times 0x200 bytes |

0x52D0 erases what a script drew by walking it the same way with zeros (30
calls). Every call loads its script with `lda`; the scripts lie end to end
from data 0x322500 to 0x323108, each ending with 0x8E, thirty of them. At
0x323108 there is a table of thirty offsets, each from the table itself,
which names the same thirty starts; nothing reads it. Eight scripts (cells 0,
1, 3, 4, 9, 10, 17 and 18) are named by no call, and listed `unused`. A cell
is what its script writes, run from entry 0, cropped to the entries it
touches; no script uses 88, and none reads a dictionary entry it did not add.

The tile chip is filled once, by the boot at 0x46F0, and that is the cells'
only CG:

- 0x48B0 expands the 1bpp font at program 0x33F0, 8 bytes a character with
  the top bit leftmost, into characters 0-255 at pen 1.
- 0x4EA0 copies 0x22500 bytes from data 0x300000 to 0x1082000, character 256
  on, straight: no byte swap, unlike Virtua Cop's.
- 0xF100 fills groups 0-127 with the 16 colours at 0xF0C0 and groups 128-255
  with those at 0xF0E0, then 0xF17C copies 0x230 colours from data 0x323180
  to 0x1800040, group 2 on.

Against m2-hle2's memory in the attract (frames 900 and 3000), the
characters match byte for byte and the palette in all but colour 0 of group
0. The interpreter's output for scripts 11, 21, 25 and 28 is found entry for
entry in the dumped tilemap layer 0, at 0x294, 0xF10, 0x81A and 0x844. The
palette goes through colorxlat, as MAME's `palette_w` sends every tile colour.

### Air Walkers (`js/texture.js`, `js/colors.js`, `js/romset.js`)

Data East's basketball game on Model 2A shares none of Sega's tables, so each
one was found from the code that uses it, with MAME's debugger logging the
calls (`bp addr,1,{logerror ...;g}` from a Lua script) and its memory dumped
to check the result.

**Regions.** As MAME's `airwlkrs` lays them out: the 2MB program pair, an 8MB
mask pair at data 0 and a 1MB EPROM pair that MAME repeats from 0x800000 to
16MB, one polygon pair and one texture pair.

**Model table.** 0x1E8D8 is the draw: `lda 0x258DD50[g0*16]`, `ldq`, then the
geometry FIFO. That is data 0x58DD50, 16 bytes an entry: texture word,
material word, mesh pointer, polygon count. It runs 2026 entries. The model
numbers MAME logs at 0x1E8E4 put the parts in groups: the players' bodies at
3..303, the courts' lines and the HUD text at 384..491, the intro's city and
dome at 539..555, home-side team models at 556..1291 and away-side ones at
1292..2025. The courts' arena, floors and stands go through it too, by
0x1E890 (see [the courts](#air-walkers-courts-jsairwlkrsjs)).
Model 555, the intro's city, is 5440 polygons in one mesh, so the profile
raises the decoder's cap of 4096 vertex pairs (`maxVertexPairs`).

**Textures.** The game copies raw texels from the data ROMs into the 2A
window itself, where dword n is halfword n of a sheet. 0x1D430 (source,
sheet, kind) loads a page and is a switch of 51 cases at 0x1D474; the game
calls two. Case 0x20 (0x1D678) is a whole half sheet and its mips, and boot
loads 0x2000000 to sheet 0 and 0x20AAA00 to sheet 1 (0x248DC). Case 0x31
(0x1D8D0) is rows 256..511, and the intro loads the title page 0x2155400 to
sheet 1 (0x256B8). 0x1D9B0 (source, sheet) loads a team's page into rows
512..767 and makes its mips with 0x1DA80. The routines under them are
0x1DCC0 (a rectangle of a sheet-shaped source), 0x1DD20 (a packed one) and
0x1DA80 (a mip level). The boot pages match m2-hle2's texture RAM, mips
included, texel for texel. The team mips follow the code but were not
compared.

**Teams.** 0x1F0E0 (n) sets a team up. The 34 numbers are 17 teams twice:
0..16 are the home side, which goes on colour slot 5 and sheet 0, and 17..33
the away side, on slot 6 and sheet 1 (`cmpi g0, 16` and then
`mov r4, 0, g1` for the page). It sends `ld 0x11A64[n*4]` to 0x1BAD0, lays
`ld 0xF18A0[n*4]` as a palette block with 0x16370, and loads
`ld 0xF1810[n*4]` with 0x1D9B0. The Models tab opens a part on a team's page
on team 0 of its side (set 0 or 17), and the picker gives the rest.

**Palette.** Boot writes {count, colours} from entry 0 out of 0x1E8F8
(0x162E4). Blocks are {first, count, colours}, laid by 0x16370: 0x1EBA0
(800..887, by the intro at 0x256A0) and 0x1EAF0 (400..485, by each court's
set-up), then the team's.

**Colours.** 0x1B9E0 writes a grey ramp to all 32 rows at boot (the floor
byte table is at 0x1B9C0). 0x1BAD0 (table, slot) lays 64 RGB triples on
slot k, which is row 1 + 2k (the halfword offsets at 0xF17F0). 0x1BB90 lays a
run of them on slots 0, 1, 2 and on: boot's 15 from 0x41F0 (0x1B5DC) and the
intro's 10 from 0x4D31 (0x256AC). A court's set-up, 0x247D0 (court, variant),
sends five tables from `ld 0xD440[court*4]` to the slots at 0xF1980, five
fixed ones from 0x4731 to slots 7..11, and the variant's two
(`ld 0xD484[v*4]` to slot 0, `ld 0xD494[v*4]` to slot 14). The team's comes
last. The court is the home team's (below), so a home team's number, 0..16,
builds its own court's tables in its own variant; an away team's builds court
0's in variant 1.

**Checks.** Against MAME's colorxlat and palette RAM in a game on court 0,
variant 1, with home team 0 against away team 20: every row and entry
matches, except the other side's team slot and block, which the Models tab
leaves at the intro's. Set 34 is the intro: the two runs and the first block
only. It matches MAME's dump 20 seconds after boot exactly.

**Not done.** Models 534..538 sample the same rows as the title page and
open on the boot pages, which may be wrong.

### Air Walkers' courts (`js/airwlkrs.js`)

**Which court.** The match set-up at 0xD048C takes the court from the home
side's team byte (0x5136D0 + side * 0xB0) and the variant from that team's
record. The records are 20 bytes at 0xFBA80: +0 the city's name, +4 the
nickname's, +12 the variant (0..3), the rest the line-up. So there are
seventeen courts, one a team, and the Legends' is the only one in variant 3.
A debug cycler at 0x29C88 steps 0..17; 17 is the intro's scene (0x256A0).

**Set-up, 0x247D0 (court, variant).** The court's colours (above), the
palette block 0x1EAF0, the two boot pages again, and two models by the
variant: 0x521774 = `ld 0xF8280[v*4]` (0x95, 0xDD, 0x10C, 0x120), drawn on
each hoop's stand, and 0x52178C = `ld 0xF8290[v*4]` (0x98, 0xDE, 0x10D,
0x121), drawn on the court. It ends in 0x25750, which sets up the
backboards' objects.

**Draw, 0x24DA0 (court)**, called each frame from 0xBA4 with `ldob
0x510980`. Every piece goes through 0x1E890 to the model table, under the
coprocessor's matrix (the commands js/doa.js keeps: push 0x05, pop 0x06,
translate 0x12, scale 0x13, turns 0x14..0x16). In order:

- 0x24470 works out from the camera (0x510964..0x510974) whether each hoop
  is near (1), far (3, drawn plainer by 0x24240) or out of view (0), into
  0x521768 and 0x521769;
- the arena 0x99, the crowd frame `ld 0xF19C0[f*4]` (f = 0x521784, which
  steps the crowd), 0x101, the stands 0x96, 0x94, 0x93, one of 0xDA..0xDC by
  a counter, and the variant's model;
- the players, by 0x23850 on each object at 0x510B40 and 0x511D10 (+0x390
  apart), and 0xB2B70;
- the floor `ld 0xF8230[court*4]` (0x175..0x185), turned 0x8000 about Y when
  byte 0x5136C5 is over 2; 0x186 and 0xD9 by flags; 0x8E; the crowd's second
  frame `ld 0xF19A0[f*4]`;
- the hoops, 0x24640 (0) and 0x24640 (1) under a turn of 0x8000: 0x9A, 0xD8,
  the variant's padding, the rim 0x10F at (115.41, 26.99, 0), and 0x24940's
  scoreboard digits out of 0xF81D0 and 0xF8200;
- 0x25B90, the ball and what the play has out (0x510990, 0x5109C0; type 7
  is model 0x18D at the object), and 0x8F..0x92 on a timer.

The explorer runs the set-up and one frame of the draw on js/i960.js with
js/doa.js's machine, from the identity, so each piece comes out in the
court's frame. It skips the player draw, the colour, palette and page
uploads (the explorer builds them from the same tables), and answers 0x24470
with "near" for both hoops. Each court is 32 pieces, and the run meets no
coprocessor command it does not know.

**Lighting.** The frame start (0x1C240) sends geometry function 6 with the
31 material slots at 0x1B3C0, {parameter word, distance coefficient} each,
and function 0x0A with the light (0, 0, 1), which is in the camera's frame.
So the light runs down the view wherever the camera is, and the Stages tab
keeps it there (`headlight`).

**Checks.** MAME's draw log (`bp 1E8D8` with the model number, frame 5000 of
the attract, a game on court 9 in variant 0) has the same pieces in the same
order: 153, the crowd, 257, 150, 148, 147, the counter's, 152, the players,
4, the floor 381, 142, the crowd, then each hoop as 154, 216, 149, 271 and
its digits. The crowd's frames and the counter's model differ with the
moment, and the play's ball and objects come after. The court as the Stages
tab shows it, from a camera behind one baseline, has the same floor, logo,
lines, boards, banners and stands as MAME's picture.

### Air Walkers' players (`js/airwlkrs.js`)

The Animation tab is a `BODY_RIGS.airwlkrs` rig (`rig` in `js/games.js`):
`readAirwlkrsBodies`, `readAirwlkrsMotions` and `poseAirwlkrs`, which hands
the viewer matrices the way `js/doafighters.js` does.

**The skeleton is in code.** There is no tree of parts. 0x23850 draws a
player object (0x510B40 and on, +0x390 apart); 0x23600 places it (translate
to its spot, scale `+0x58, +0x5C, +0x58`, translate (0, `+0xB0`, 0), turn
`+0x14` about Y) and calls 0x214A0 (the legs) and 0x21A70 (the rest), or
0x20850 for both when the team at `+0xC` is 34. Those push and pop the
coprocessor's stack down fifteen joints, with the bone lengths as constants
in the code: the legs at (1.5, 0, ±1.0) from the hips, knee and ankle 4.7
on; the neck 4.4 over the trunk; the shoulders at (3.6, 0, ±2.3), elbow and
wrist 2.7 on. Team 34's routine has lengths of its own. Each joint turns by
three halfwords of the pose at 0x5214C0 (6 bytes a joint): the first to
command 0x16 (Z), then 0x15 (Y), then 0x14 (X). Each draws one of the sixteen
models at `+0x120..+0x15C`, plus `ld 0x5215F0`, which is -1 (the plainer
model before it in the table) when the camera is over 35 units away. The
explorer runs the routines on js/i960.js with js/doa.js's machine, from the
identity, and takes each part's matrix at its draw; `PLAYER_PARTS` lists the
sixteen in their draw order with the field, parent and joint.

**Players.** The set-up 0x1F3F0 (object, team, player) copies sixteen model
words from `0xF4B20 + 0x190 * team + 0x50 * player` to the object: +0 the
trunk (`+0x140`), +4 the head (`+0x120`), +8..+0x1C the arms
(`+0x128..+0x13C`), +0x20 the hips (`+0x144`), +0x24..+0x38 the legs
(`+0x148..+0x15C`) and +0x3C the head's second model (`+0x124`). Teams 0..16
wear their home kit and 17..33 the same players' away kit, five each; team 34
has three records, bodies of their own, which the set-up swaps in for a player
when a cheat bit (0x5214A4) is set. That is 173 bodies. A team's body is shown
with its team's texture set and colours (`useAirwlkrsPlayerScene`), team 34's
with set 0.

**Motions.** The motion start 0x1F1B0 (object, m) takes the angles from
`ld 0x26E3CA0[m*4]` and the root's track from `ld 0x25BF740[m*4]`, unless the
byte at `0xF2C68 + 12 * m` is set: then from entry byte - 1 of 0x2CE9750 and
0x2CE96C0. 35 motions are taken from that second pair, ten of them ones the
first table has no frames for (64, 80, 81, 85..88, 90, 91). 0x23F94 keeps m at
or under 0x285. A motion is a halfword n, then n + 1 frames of 45 halfwords
(0x5A bytes), padded to 16; n = 0xFFFF is no motion. 619 of the 646 numbers
have frames. The clock `+0xE0` is 8.8 fixed point, and 0x201B0 eases each
angle from frame `t >> 8` to the next into 0x5214C0. The root's track is a
float triple a frame, eased into `+0xAC..+0xB4`: y is the hips' height
(about 12 standing, 34.3 at the top of motion 633's dunk), and 0x23600 lifts
the player by it; x and z are its path, which the explorer follows only with
root travel on. A third table, `ld 0x26F8600[m*4]` (0x2CE97E0 for the second
pair), goes to `+0x110` with a halfword a frame, 0x8000 at the start when
there is none; it is not read.

**Hands.** A motion picks the hands. 0x21A70 draws the hand on joint 7 as
`+0x13C` plus the byte at `+0x11E`, and the one on joint 4 as `+0x130` plus
`+0x11F`, with no far-model offset; the motion start (0x1F374) fills the two
bytes from bytes 4 and 5 of the motion's 12-byte record at
`0xF2C60 + 12 * m` (the same record as the second-table byte at +8 and the
flags at +3), the other way round when `+0xF4` is 1, which plays the motion
mirrored (0x1FD10). The offsets are 0 to 5, models after the record's hand:
384 of the 646 records keep both at 0, 64 take 4 for both (motion 0's
stance among them). Team 34's routine adds nothing. The explorer sets the two
bytes from the motion before it runs the draw, so the hands are whatever the
game's routine draws (`poseAirwlkrs`, `motions.records` in the rig).

**Mirrored motions.** The motion does not say whether it plays mirrored;
whoever starts it does, in `+0xF4`. In a game that is 0x66FA0 (and 0x66EE0,
the same on a word it is given): it takes the player's next step from its
move sequence, six halfwords each at `0x5A300 + 12 * (+0x348)`, step
`+0x34C`, and stores the low 12 bits at `+0x33C`, the action to start: its
six-byte record at `0x57FF0 + 6 * action` (0x66830) names the motion in its
first halfword (action 0x1B0 is motion 179). Bit 14 sets `+0xF4` and `+0xEC`,
bit 13 only `+0xEC`, bit 12 only `+0xF4`; 0xF000 ends the sequence. Of the
1100 steps in the 1024 sequences 478 are mirrored (bit 12 or 14: sequence 1 is
motion 18 and then 18 mirrored), over 430 motions, all but 313, 438 and 447
also played straight elsewhere. `+0xEC` plays the motion backward; see
**Backward**. The players' motion
scripts (0x28080) have their own bit for it, 15, and 0x26CF0 copies it back,
with the rest of a player's state, from the record at 0x5138A0 that 0x26BB0
fills. Each frame 0x201B0 eases the motion's angles into 0x521520, and 0x1FD10 copies them
to the pose words at 0x5214C0: as they are when `+0xF4` is 0, and mirrored
when it is 1. Mirrored, joints 0 and 8 take 0x8000 minus their first and
third words, joint 1 negates its second and third, the arms trade sides
(2-4 with 5-7) and so do the legs (9-10 with 12-13), their second and third
words negated, and joints 11 and 14 trade with 0x8000 minus the second word
(measured on all 693 mirrored draws below). The draw still puts each arm's
models on its own joints, so a mirrored player's wristband stays on the same
arm, doing what the other arm did; only the hands go with the motion, because the motion start swaps the
two record bytes (0x1F374). 0x22800 negates the root's x step. The explorer's
**mirrored** box sets `+0xF4`, swaps the two bytes, writes the frame to
0x521520 and runs 0x1FD10 itself (`eased` and `mirror` in the rig), and
negates the root's x when the travel is on.

**Backward.** `+0xEC` is the step's other flag: bit 13 sets it alone, bit
14 with `+0xF4`, so a motion can play backward mirrored or not. Of the 1100
steps at 0x5A300, 592 are plain, 460 mirrored, 30 backward and 18 backward and
mirrored, over 31 motions, each also played forward somewhere. The motion
start 0x1F1B0 sets `+0xE8` to (frames - 1) times 0x100, the last frame on the
8.8 clock, and the clock `+0xE0` to 0, or
to `+0xE8` when `+0xEC` is set. Each frame 0x24144 then takes the speed
`+0xE4` off the clock, where forward adds it; when the clock would pass 0
it is set to 0, the first frame, and the motion ends. 0x201B0 eases
frame `t >> 8` to the next by `(t & 0xFF) / 256` either way, so a backward
motion shows the same frames as a forward one, in the other order. The root's
step (0x22560) measures the track from where the motion started: from 0
forward, from the last frame's x and z backward. Nothing in the draw reads
`+0xEC`. The explorer's **backward** box shows frame `len - (tick % len)`
in place of `1 + (tick % len)`, sets `+0xEC`, and with root travel on takes
the last frame's x and z off the track (`poseAirwlkrs`); the clock it shows
runs as **Clock** below says.

Checked against MAME, attract frames 4980 to 5580, logging at 0x2373C the
clock, speed, `+0xE8`, `+0xEC` and `+0xF4` with the rest, and each step
0x66FA0 takes: all 440 steps set `+0xF4` and `+0xEC` by the rule above (336
plain, 88 bit 12, 7 bit 13, 9 bit 14), and on all 3000 draws `+0xE8` is the
motion's (frames - 1) times 0x100. 79 draws in 17 stretches play backward, over motions
5, 24, 94, 179, 187 and 189, mirrored and not; each starts with the clock at
`+0xE8` and takes `+0xE4` off it each frame (motion 179: 0x900, 0x710 ...
0x140, then the next step). On 70 of them MAME's eased angles are the
motion's frames eased at the clock the draw has, to the bit (three at a
clock 8 away where the speed changed between, six a player held at clock 0
at the end), and with those angles and the explorer's backward pose the
distances between the five read-back joint ends agree to 0.00002; the 16
on a whole frame, posed from the explorer's own frame as the Animation view
shows it, to 0.00001. The same draws played forward (the clock counted up
from 0) are off by 0.06 to 10.4, 2.0 at the median.

**Clock.** The speed `+0xE4` is 8.8 too, 0x100 a frame. 0x1FAF0 (and the
same lines at 0x230C0 and 0x23F54) sets it each frame the player moves to
the halfword that starts the motion's record (`0xF2C60 + 12 * m`, 0x80 to
0x4C0 over the table, 0x200 the most common) times the player's pace `+0x16`
shifted down 12, times the frame's length at 0x5214A0 (1.0; 0 while play
stands still), cut to a whole number (`airwlkrsSpeed`). The pace is 0x1000
when a player is made (0x1F410); the play code from 0x64B9C sets it a step at
a time, a base at 0x56DE6C plus 0x80 to 0xC00 for what the player is doing.
The players move every other frame, a draw each 1/30 s. Each draw 0x201B0
holds the clock to `+0xE8` and eases frame `t >> 8` to the next by
`(t & 0xFF) / 256`, in single floats, each angle the short way round and cut
toward 0, except in the last step: when `t + 0x100` reaches `+0xE8` it
doesn't ease, and frame `t >> 8` stays until the clock gets to `+0xE8`. The
root's height (0x22560) eases between the same two frames in the last step
too. Then 0x24144 moves the clock: forward it adds the speed while the clock
is short of `+0xE8`, so the last draw is at `+0xE8` or past it, posed as the
last frame, and the motion ends; backward it takes the speed off while that
leaves 0 or more, so the first frame shows only when the clock lands on it.
The speed is set before the motion start in the same frame, so a motion's
first step runs at the speed of the one before; from the second step it runs
at its own.

The explorer does the same: the Animation view ticks at 30 a second, one
draw a tick, through the clocks `airwlkrsClocks` lists for the motion, its
speed and the **backward** box, and `poseAirwlkrs` takes the clock and eases
the angles and the root as above (`airwlkrsEased`). **pace** sets `+0x16`
(1 is 0x1000). The slider steps draws, and its readout gives the draw and
the frame the clock is on, with its part of the way to the next.

Checked against MAME over the same attract (frames 4980 to 5580, 3000 draws,
logging the clock, speed, `+0xE8`, pace and frame length on entry to 0x201B0
as well as at the draw). The players draw every other frame, and the frame
length is 1.0 throughout; the paces are 0xF80, 0x1000, 0x1080 and 0x1280.
`+0xE4` is the record's speed times the pace on 2744 draws; the other 256
are the first draw of a motion, still at the speed of the one before. Of
2364 steps within a motion, 2280 add or take off the motion's own speed,
197 (the first step) the speed before, and 87 hold the clock where a player
stands still. 284 forward runs end at `+0xE8` or past it, the other 116 are
cut off by the next action; 15 backward runs end with the clock under one
step from 0, or at 0. On all 2940 draws whose angles 0x201B0 eased that frame
(the other 60, players held through a pause, draw the angles of an earlier
frame), `airwlkrsEased` at the logged clock gives MAME's angles to the bit,
174 of them in a last step that holds its frame (eased there anyway they
would be off by up to 2.5), and `poseAirwlkrs` at that clock gives joint
distances that agree to 0.00003: 2477 of the draws between two frames, 73
backward (57 between frames, to 0.00002). Posed at the whole frame the
clock is on, as the view did before, the draws between frames are off by up
to 3.6, 0.06 at the median.

**Head turn.** The motion start copies the motion record's flags (byte 3 of
`0xF2C60 + 12 * m`) to `+0x11D`; when bit 5 is set (58 of the 646 records,
motions 0 and 18 among them), 0x21A70 turns the head's joint by `+0xC8`,
`+0xC6` and `+0xC4` after its pose words (axes 0x1616, 0x1515, 0x1414). Each
frame of play 0xB1710 (from 0x65C18) fills them. By the player's state
(`+0x2C8`, the move sequence `+0x348`, ...) it either zeroes all three or
takes a bearing and tilt from 0x54BC0 toward the point it watches; `+0xC4`
is 0, `+0xC6` the bearing less the player's facing `+0x338`, held to ±0x3000
(67.5°), and `+0xC8` the tilt held to ±0x1000 (22.5°), or 0 once the
bearing is held. Which point it watches isn't followed here. The explorer sets
`+0x11D` from the record and, from the **Head turn** sliders, `+0xC6` and
`+0xC8` through the same holds (`airwlkrsHeadTurn`), then runs the draw. A
motion without bit 5 keeps the head straight whatever the sliders say, as in
the game, and the panel says so.

Checked against MAME, attract frames 4980 to 5580 (3000 draws, 693 mirrored,
31 motions), logging `+0xC4..+0xC8` with the rest at 0x2373C and watching
every player's three words: 0xB1710's stores are the only ones in play
(2860 each, and 0x26CF0's 60 from its record). `+0x11D` equals the record's
byte 3 on all 3000 draws, 1925 have bit 5 and 1916 a turn that isn't 0 (1123
of those held at ±0x3000). `+0xC4` was always 0, and every `+0xC6`/`+0xC8`
pair is one `airwlkrsHeadTurn` leaves as it is. With MAME's eased angles,
`+0xF4` and the head's words, the distances between all five read-back joint
ends, the head's included, agree to 0.00003 on all 3000 draws; with the head
left straight the turned draws are off by up to 0.35.

**No blend.** The game doesn't blend one motion into the next. In play a
new motion starts from 0x23F94 when the player's state word is 0x287: the
motion start 0x1F1B0 sets the clock `+0xE0` to 0 (to `+0xE8`, the last
frame, when `+0xEC` is set; 0x24144 then counts it down and the motion plays
backward), and 0x201B0 eases the new motion's own frames at that clock, the
same frame the motion has anywhere else. The program does have a blend:
0x20340 saves the pose words to 0x521580, poses the new motion's first frame
and sets `+0xE8` to a quarter of the biggest angle change, and 0x20560 eases
from the saved pose to it, printing the angles as it goes. Nothing calls
either: no call, no `lda` of their address, no word holding it in the program
or data ROM, nor 0x20820, the per-frame step that would go with them, so
they are left from development. Checked in MAME: over the attract window
above (2940 easings, 440 motion starts) and a game played from a coin for
8300 frames (5515 motion starts over 179 motions), neither 0x20340 nor
0x20560 nor 0x20820 ran once. In the attract, 0x201B0's output is the frame
pair at its clock, eased, on all 2940 easings to the last bit, and the
first draw after each of the 326 changes is the new motion at clock 0 to 0xB00
(at `+0xE8`, its last frame, after a backward step; see **Backward**).
Most changes are made to meet (the angles move 3.8° a word at the median
there, 3.1° within a motion), but one in ten jumps 23° or more. The explorer
shows each motion from its first frame (its last, played backward), as the
game does.

**Skin.** Nothing is patched at run time: 0x214A0 and 0x21A70 only send turns
and translates and call 0x1E890, which draws from the model table as it is.
A skin tone is a set of limb models: the player record names them (33, 56...
or 122, 139... or 192...), and they differ in their texture word's colour
base (`th3` 0x3C0, palette 15, for the darker skin; 0x400, palette 16, for
the lighter) over the same tiles. They came out black because their faces
use material slots 6 and 7 (diffuse 255, ambient 111 and 48), all diffuse and
little ambient, and Air Walkers has no game lighting table, so the player
scene kept whatever light and slots the last tab had set. It now takes the
court's slots (0x1B3C0) and the court's light down the view. Checked against
MAME at frame 5000 of the attract (Orlando against Chicago on court 9): its
palette, luma RAM and colour tables equal the explorer's, the texture sheet
too where the limb tiles are, and Orlando #7's dark brown and Chicago #22's
light skin come out as in MAME's picture.

**Checks.** MAME, `bp 0x2373C` logging the pose words and the coprocessor's
read-backs of five joint ends (0x5215E0..0x521630), on ten players in a game
on court 9: the pose words are the motion table's frames eased at `+0xE0`
(also just after a motion changes; there is no blend, see **No blend**), and with MAME's own pose
words the explorer's run gives the same distances between those ends to
0.0001 (0.21 where the head was turned, before the head turn was in; see
**Head turn**). `+0xB0` is the root track's
y (10.75 at motion 18's first frame), and motion 80 has the 8 frames of its
second-table entry. The headless page shows 173 bodies and 619 motions with no
errors; Orlando's #7 (TEDIN, set 9) wears the jersey MAME's screen shows.

The hands, checked the same way: MAME at frames 4980 to 5040 of the attract
(Orlando at home against Chicago in its away kit, ten players), logging the
model 0x21A70 passes at its two hand draws (0x21EBC, 0x22144) with the
object's motion, `+0xF4` and bytes, and at 0x2373C the pose words, the scale
(`+0x58`, `+0x5C`) and the five read-backs. All 580 hand draws, over 15
motions, mirrored and not, are the record's hand plus the motion record's
byte as above. The explorer, on each of the 212 unmirrored draws' player and
motion, draws the same two hand models as MAME (201 of them not the record's
own). With MAME's pose words and its scale put on the explorer's read-backs,
every distance between them agrees to 0.0001, the hands' included, except
those to the head's on the 258 draws whose head is turned (up to 0.21).

The mirrored motions, checked the same way over ten seconds of the same
attract (frames 4980 to 5580, 3000 draws, 693 of them mirrored over 31
motions), logging also the eased angles at 0x521520, and in a second run
watching every player's `+0xF4` from frame 4000 to 5580: there 0x66FA0 writes it 997 times (211 of them 1),
0x26CF0 60 times from its record, and the setup's 0x1F454 and 0x2DEF0 clear
it. The explorer draws MAME's
two hand models on all 3000, the 693 mirrored ones with the box on (posed
straight instead, 97 of those get the wrong hands). 0x1FD10 on MAME's eased
angles gives MAME's pose words on all 3000. With MAME's eased angles through
the explorer's pose, mirrored as MAME had it, and MAME's scale, every
distance between the five read-backs agrees to 0.00004 (but to a turned
head); posed unmirrored, the mirrored draws are off by up to 12.3.

### Air Walkers' cells (`js/cells.js`)

Data East's 2D is The House of the Dead's picture format, with its own copy
of the routines. The table is at data 0xC15220 as the code names it
(0x2C15220, the 1MB EPROM pair's third repeat; the pair itself starts at
0x800000): 492 entries of three pointers, tiles, colours and map. The 493rd
word is no pointer, and no code bounds the table, so the count is where the
pointers stop. The table is read at 0xC38DC, 0xC3B18, 0xC3BE8, 0xC3CEC,
0xC3DB0 and 0xC3E6C (tiles and colours) and at 0xC3F3C, 0xC3FC8, 0xCE330,
0xCE368, 0xD47B0, 0xD47E8 and 0xD4814 (maps).

0xC3CD0 loads a picture the first time it is drawn (its slot holds no block
yet): after a call to 0xC38D0 (not read), each chunk, a count and that many tiles, goes to a 128-tile
block of its own (`block << 12` from 0x1080000), and the chunk's 16 colours
go to every block it takes, at `0x1800000 + block * 32`. The draw, 0xC3F10,
takes the picture's slot in g0, the tilemap in g1, two bits in g2 and g3,
the column and row in g4 and g5, and the picture in g6; it adds
`(g2 << 15) + (g3 << 14) + (firstBlock << 7)` to each map entry, so the
group is the block. The panel loads each picture from block 0, and the
palette goes through colorxlat.

Found with m2-hle2: a write watchpoint on the title's tilemap stopped in the
draw at 0xC3FA0 reading map 40 (the AIR layer, layer 2) and map 41 (the
WALKERS layer, layer 0); both pictures in the tab match the dumped layers.

### Power Sled (`js/powsled.js`, `js/texture.js`, `js/colors.js`)

Sega's 1996 Model 2B snowmobile racer, as MAME's `powsled` (Slave, Revision
A). MAME's game stops at its network screen, so the tables were found in the
program and checked against m2-hle2's memory (`dump_geo_list`, texture,
palette, colorxlat and luma dumps) in attract mode.

**Models.** There is no model table. On 2B the main CPU writes object
commands into bufferram for the DSP: 0x00800101, then texture point address,
texture header address and object address (bit 23 set: a word index into the
polygon ROM). The program takes the three words from three places, and
`js/powsled.js` gathers them all:

- 64-byte part records in the data ROM, {tpa, tha, oba, 0, 3x3, place}:
  the frames of the figures (see Animation below), such as data 0x4770's,
  read by 0xE47AC through 0xE1F30.
- 28-byte named records in the program ROM, 0xD8EA0..0xE19E8: two words, the
  three, a zero and a pointer to a name such as `HONBAN_sce2_course_N_4_1_0`.
- Immediates: `lda tpa,g6; st g6,0x804000; lda d(g6),g6; st; lda oba,g6; st`,
  as at 0xE3F9C. An untextured model stores g6 twice, so its header address
  is its point address.

A triple counts if its object address is inside the polygon ROM's data
(0xFF fill from 0x2B3000), and its header address is no more than 0x1000
words past its point address; the widest real gap is 0xD84. That gives 494
distinct triples, 37 of them untextured. Every model in a captured frame's
display list is among them. The list does not reach about half the polygon
ROM (for one, 0x15803C..0x209EAC words), which is likely the courses' ground.

**Textures.** 0xC540, called from 0xE688 at boot, copies data 0x600000 to
sheet 0 and data 0x700000 to sheet 1, 1MB each, raw. That is the only texture
load, so there is one set (`layout: 'copy'`). It matches m2-hle2's texture
RAM byte for byte.

**Palette.** {count 0x20A, colours} at program 0x128EC, uploaded to 0x1802000
by 0xF1B0 (`paletteProgram`). All 522 entries match.

**Colours.** The curve is `trunc(255 * (x/255)^(10/17))`. 0xE2D0 fills all 32
rows at boot: row r has a = 8r + (r >> 2), and luma l gets the curve of
(a * (l + 1)) >> 6 on all three channels; luma 64 and up repeats luma 63.
0xE1D0 then lays the 15 odd rows 1..29 from the table at 0xCB50, 0x180 bytes
a row of {r, g, b} halfwords for luma 0..63, through 0xC960. Fades go through
RAM 0x53EB60..0x543B60 (0x18DF0 on), which the explorer leaves alone. The
result matches m2-hle2's colorxlat exactly.

**Luma.** 0xC8F0 writes two bands of 128, entry i = ((i & 127) + 1) >> 1
(`halfRamp`). It matches.

**The course** (`readPowsledStages`). There is one, and nothing names it.
The race keeps the sled's progress down the course and hands it to a scene
routine for each span of it (0x30AF4, and its twins 0x2A01C and 0x35CD0),
with what is left past the span's start:

| Routine | Progress | Records it draws |
|---|---|---|
| 0xDB0C0 | 0x000-0x0DB | `HONBAN_sce1_start`, `HONBAN_sce2_course_1..22` |
| 0xDBFD0 | 0x0DC-0x171 | `HONBAN_sce3_course_1..15` |
| 0xDCBF0 | 0x172-0x1B7 | `HONBAN_sce4_course_1..7`, `sce4_tonnel` |
| 0xDD250 | 0x1B8-0x1C6 | `HONBAN_sce5_course1..2` |
| 0xDE200 | 0x1C7-0x267 | `HONBAN_sce7_bridge_1..7` |
| 0xE1AF0 | 0x268-0x347 | `HONBAN_sce8_course1..7`, `_F1..F10`, `GOAL_KANBAN` |

Each one draws the 28-byte named records whose {first, last} span holds the
progress (0xD8B50: g0 the records, g1 their count, g2 the progress), in
world space under the camera, and a few pieces under a matrix of their own.
0x2A034's sce8 is 0xE1C80, the same less the goal (0xE04B0). Past 0x347
nothing changes.

The explorer runs each routine on the i960 (`js/i960.js`) for every progress
in its span. The coprocessor here is not the TGP: a command is one word to
0x884000 with the opcode in its low byte, then its singles. The routines send
0x04 push, 0x05 pop, 0x1D translate (3), 0x1F times a 3x4 (12), 0x07 hand
the matrix over (the geometrizer's 0x0B reads its twelve words back), and,
from the goal's sign only, 0x2C scale (1) and 0x21 turn about Y (1 word).
The geometrizer's 0x01 then draws {tpa, tha, oba} under that matrix. A piece
is kept once, at the first place it is drawn, keyed by its model and place,
with every scene that draws it and the first and last progress that does:
304 pieces, models 137 to 490, all from the model list. Six of them are
drawn at progress 0 only (one of them up to 3) and then swapped for another
on the same spot (m2-hle2's race draws mesh 0x8401B6 up to
frame 4601 and 0x822070 from 4731, never both); the stage keeps the one the
race keeps, which leaves 298. One piece, the goal sign's frame (mesh 0x882859), steps its
material with the frame counter; the stage draws it with the first one it
is sent, as model `283#608ac`. Every routine finishes, and no unknown
coprocessor opcode is met.

The scenes are the stage's views, named for their records; each opens on a
camera framed on its own pieces. The race sends the light straight to the
geometrizer (function 0xA, at 0x3672C and 0x3740C): (0.1, -1, 0.01). The 32
material pairs at program 0xEBC0 go with function 6 at boot (0xED04 calls
0xEB70 with a count of 31 + 1); the rocks are lit by slot 25 (diffuse 0xF7,
ambient 0x32), which reading only 16 left black. Over the palette's 0x20A
colours 0xF1F8 greys entries 8 to 63 (0x39CE), as m2-hle2's palette RAM
holds them through the race (`paletteFixes`); 0xF6E0's per-frame cycle into
the same entries is not modelled.

Three things the scene routines do not draw go with the stage as objects:

- The sky and the mountains. 0xD8890, which the race loops call through the
  words at 0x2A144, 0x30C0C and 0x35A4C, stands at the eye unturned and
  draws the sky (mesh 0x8AB219) 500 above it at three times its size
  (0xD88E4, 0xD890C), then the mountains (0x89DAE0) 2600 below it (0xD8A48).
  They follow the camera (display op `ce`, at the eye). The sky is the
  shell, drawn first; the mountains, whose floor runs under the course,
  are a backdrop drawn over it with no depth test, as the board's z sort
  puts the course in front of that floor where a depth buffer would not.
- The four cranes over the start that hold the sleds before the drop:
  0xE6DA0 runs r4 from 0 to 3 through 0xE6560, which draws
  {0xA244, 0xA798, 0x811E36} for an even r4 and {0xA7C8, 0xAD24, 0x8124FF}
  for an odd one, at a matrix the copro works out. Their places are read off
  m2-hle2's race: (6.959, 1783.965, 5527.939), (-9.041, 1790.465, 5567.939),
  (6.959, 1796.965, 5607.939) and (-9.041, 1803.465, 5647.939), unturned and
  still from frame 3561 to 4900. The sleds hanging from them are the
  players' and are left out.

The finish banners (the flag's stripes, *1996 KEROLYMPIC*, the vertical
*KEROAME*) are a plain face with the lettering laid on it as a second,
cut-out one, so the game takes Daytona's depth arrangement (`depth.layers`);
without it the two fight.

MAME cannot reach the race. As the network's master (the default) the board
stops at the RIDE ID prompt. With the ride ID (RAM 0x5293F0, printed by
0x152D4: 2 BLACK, 3 YELLOW) poked to a ride, it shows THIS IS RED RIDE and
waits for the master, which it looks for in the comm RAM at 0x1A02180
(0x24600 on): *Cannot find network main.*

m2-hle2 reaches it with two boards on its comm link: one run with
`--comm-master`, the other with `--comm-slave PORT:TOKEN` from the first's
log. On the main unit's panel CALL (input 0x200) at frame 2400, the ride's
ENTRY (0x100) at 2700, STEP (0x800) at 3000 and 3200 and GO (0x20000) at
3600 take both to race state 7 (RAM 0x53E744); the race runs to time-over
at about 7400. Every 130 frames or so the ride's picture and its geometry
captures (`get_geo_captures`: mesh, tpa and the 3x4 each object was drawn
under) were taken. In each frame one camera C fits every course capture,
C times the explorer's matrix for the same mesh to within 0.02 (rotation)
and 0.2 (translation), so the pieces stand where the race draws them. The
explorer was then rendered from that camera through the board's projection
(focal 200, centre 249, 183 of 496x384, which is a vertical field of
2 atan(192/200)) and set beside the board's picture: the start from the
ride (frame 3561) and from the main unit, the tunnel (5521) and the finish
banners (6300) match, but for the HUD and the player's own sled. The race
times out before the bridges and the goal, so those two scenes are checked
by eye only.

**Animation** (`readPowsledBodies`). Ten tables in the data ROM, each
{frame list, parts}; the list is a data offset a frame, ended by
0xFFFFFFFF, and a frame is a 64-byte record a part:

| Offset | |
|---|---|
| +0x00 | tpa, tha, oba (the part's model), then a zero |
| +0x10 | a 3x3, nine singles, columns X, Y, Z |
| +0x34 | the place, three singles |

0xE1D70 draws a frame (and 0xE1F30, the same with the ride's colour): per
part, copro push, translate by +0x34, times the 3x3 with a zero translation
(op 0x1F, the twelve words being +0x10..+0x30 and three zeros), output, draw,
pop. Every part is placed from the figure's origin, so a frame is the whole
pose baked; the explorer gives every part parent -1 and poses it as
S · T(place) · R · S, S the Z flip. A part's model is the same on every
frame.

| Table | Parts | Frames | What it shows | Played by |
|---|---|---|---|---|
| 0x4770 | 33 | 65 | crane with a sled | ride scenes, 0xE47AC |
| 0x260C0 | 33 | 25 | crane lowering the sled | - |
| 0x32F70 | 18 | 46 | crane arm and claw | - |
| 0x3FF34 | 28 | 381 | woman in a yellow suit | ride scenes 2 and 0 |
| 0xE7034 | 3 | 140 | three-part object | record 0x3B2C0 |
| 0xEDB70 | 38 | 135 | two riders on a sled | - |
| 0x13E018 | 38 | 135 | two riders, second take | ride scenes 2 and 0 |
| 0x18E4C0 | 38 | 135 | two riders, third take | ride scenes 1 and 3, 0xE46C0 |
| 0x1DE968 | 28 | 381 | woman, second take | ride scenes 1 and 3, 0xE45C0 |
| 0x285A68 | 3 | 140 | the object, mirrored in X | record 0x3B2A0 |

No address in the program names the three marked -, which were found by
their layout; all ten differ. The two three-part ones are named only by two records, {table, 1,
0x8B, 0}, at 0x3B2A0 and 0x3B2C0, just past a list of places at x = 8 and -8
by the start (0x3B190, read at 0x3B91C); what plays them is not found. The
names are the explorer's.

**The ride scenes** (`rideScenes`, `rideMatrices`; `rig.rides` in
`js/games.js`). The five played tables are not an attract: they are mode 5
(0x32F40, the mode word at 0x53E744), the ride's own screen before the race.
Its tasks include 0x33780, which picks a handler by the ride's number at
0x5293F0, and the handler draws the whole scene each frame, the camera and
the hangar first, with the task's clock at +0xC0:

| Ride | Waiting | After Entry | Camera | Colour |
|---|---|---|---|---|
| 1 | 0xE5760 | 0xE44B0 | 0xE2830 (a) | red |
| 2 | 0xE5AA0 | 0xE4820 | 0xE2E00 (b) | black |
| 3 | 0xE6190 | 0xE4BE0 | 0xE2830 (a) | yellow |
| 0 | 0xE5E30 | 0xE4F50 | 0xE2E00 (b) | - |

The waiting handler counts t up, wrapping at 0xE11, and on Entry (the input
edge 0x529368 & 0x500, either player) sets t to 0 and the handler to the
scene's. Both draw, under the camera, the woman, the riders and the crane,
each through 0xE1D70 at a frame the clock picks:

| | Layout a | Layout b | Frame after Entry | Waiting |
|---|---|---|---|---|
| woman | 0x1DE968 at T(0.85, 0, 0) | 0x3FF34 under turn-Y 0x7000, then T(1.4, 0, 0) | t to 0x17C, then 0x138 + (t - 0x137) % 0x45 | 0 |
| riders | 0x18E4C0 | 0x13E018 at T(0, 0, -0.1) | t to 0x86, then 0x86; none past 0xC7 | t & 1 |
| crane | 0x4770 | 0x4770 | 0 to 0x86, t - 0x87 (the lift) to 0xC7, then 64 | 0 |
| slide | 0xE2510: X (t - 0xDC) / 10 | 0xE2670: the negative | none to 0xDB, to 0x18F, then 18 | none |

The slide is a translate in front of the crane's frame. The crane goes
through 0xE1F30 (g2 the ride), which after each part's matrix pushes
T(0, -0.32, -4.1) and, for part 2, draws the colour piece there (ride 0
{0x30D62, 0x30EA6, 0x8459CB}, 1 {0x30AAA, 0x30BEE, 0x845625}, 2 {0x30C06,
0x30D4A, 0x8457F8}, 3 {0x30EBE, 0x31002, 0x845B9E}), then pops. Under the
part's own matrix, part 2 draws the sled's body in the colour instead of its
own model (ride 0 {0x36372, 0x36876, 0x84D714}, ride 2 {0x35E16, 0x3631A,
0x84D05F}, each with {0x9C0C, 0x9D44, 0x81166F}; ride 3 {0x368CE, 0x36DD2,
0x84DDC9}; ride 1 its own), parts 4 to 11 are drawn for ride 1 only, and
part 0 not for rides 0 and 2. The explorer has a body a ride, the three
figures' parts and the colour piece, and two motions, the wait (2 frames)
and the scene (t 0 to 0x1D4: the crane is still from 0x190, one loop of the
woman after that; the game's scene has no end of its own).

Copro op 0x21 (one word, 0x10000 a turn) here turns with columns
X = (c, 0, s), Z = (-s, 0, c): the other sign from the `Copro` class the
course runs on, which uses it for one spinning piece (70 angles from 0x64
by 0x65); that piece is not checked.

Graded against MAME (shared build), which stops at the network check: a Lua
script sets the ride number at 0x5293F0, presses Cancel Network Check, at
frame 1200 writes mode 5 (0x53E744 = 5, 0x53E74C = 0), from then writes
0x529464 = 0x1E4400 every frame (a zeroed span of ROM, so the comm
watchdogs 0xBD640 on read no shutdown), and presses P1 Entry at 1500. A
write tap on the geometrizer logs every model with the matrix it is drawn
under, and the scene's clock. Each game frame's draws, from the hangar on,
taken into the hangar's frame (the camera; rides 2 and 3 draw the hangar at
T(0, 0, -33.6)), against the explorer's at the same clock: all four rides,
the wait (t 96 to 297) and the scene (t 1 to 468, through the lift, the
riders' hiding, the slide and the woman's loop), 670 frames each, 51,418 to
56,778 draws; the same models every frame and the worst entry off by 5e-4.
MAME drops a frame at t 200, after which the logged clock is a frame ahead
of the one drawn.

### Last Bronx (`js/texture.js`, `js/colors.js`, `js/romset.js`)

Sega's 1996 fighter on Model 2B CRX (MAME's `lastbrnx` and `lastbrnxj`)
keeps none of the AM2 tables, so each was found from the code that uses it,
with MAME's debugger logging the calls and its memory dumped to check the
result. The program copies its data section to RAM 0x500000 at boot, out of
the program ROM at 0xC9100 (Export) or 0xC9220 (Japan), so a RAM address the
routines read is a program ROM offset here (`data` in the profile). The two
builds keep everything else at the same offsets, except the fighter records
(0xB53B0 / 0xB54D0) and the colour settings (0x3D4BB / 0x3D5DB), which move
with the data section.

**Model table.** The program ROM at 0x189B0, 16 bytes an entry: texture
word, material word, mesh pointer, polygon count. It runs 2544 entries, up to
a byte table at 0x229B0. The draws at 0x4370C and 0xAD930 send an entry as
it is: `ld 0x189B0..0x189BC` and `stq g0, 0x804000` after
`st 0x101, 0x800010`. The table being in the program and not the data ROMs
is new, so `modelTable.source` names the region (`readModelEntry` in
`js/romset.js`). Meshes are polygon ROM words, as in the other games
(`0x800000 | word`). Entries 1691, 1692, 1772 and 1773 name word 0x4000, the
polygon RAM the program fills itself, and decode to nothing. The Japan table
is the same but for entry 2548, past the end.

**Stage textures.** A stage's set-up loads one of three banks,
`ld 0x500010[ld 0x5042B0[stage*4]*4]`, an LZ stream in the data ROMs. 0x81C0
reads it: a 16-bit flag word, top bit first, then a literal halfword for a
set bit, or for a clear one a signed halfword t that copies (t & 15) + 2
halfwords of a 4096-halfword window from position t >> 4. 0x8320 deals it
onto the sheets by the table at program 0x8320: rows of 0x20 bytes, a repeat
count and then runs, each run written to the current sheet while the other
sheet's offset skips the same length, the sheets swapping after each run.

**Fighter pages.** Then three raw rectangles on sheet 1 by 0x8620, each with
its mips on the other sheet by 0x8920: the common page `ld 0x500030` at row
256, player 1's page at row 0 and player 2's at row 512 (x past 0x1FF folds
onto rows 512 on). A fighter's page is `ld 0x500030[n*4]` for the record's
word 7. The records are 128 bytes; +0x20 and +0x24 are the colour lists of
costume 0 and 1, and words 1..5, 10 and 11 are model lists, 28 pointers into
the model table each.

**Whose part a model is.** The model lists name the fighters' bodies. Each
fighter's models run from the first its word-1 list names (1353, 1440, 1542,
1669, 1784, 1869, 1985, 2101 and 2184 for fighters 0..8) to the next
fighter's first, the last ending at 2495, with player 1's and player 2's page
copies alternating; the models in a run that no list names (spare hands and
faces) are taken to be the fighter's too. A fighter's part opens on the set of
that fighter alone. A part that samples only the common and fighter pages
(the shared parts at 1185..1317 among them) is the same under every stage and
opens on the default set. The rest sample a stage bank and open on the
stage whose stage code draws them (below): 467 models, in one run per stage.
The 60 no stage draws (among them 70..95 and 144..148, between two stages'
runs) are left to the picker's tile-coverage guess.

**Sets.** 0..8 are the stages, each with the fighters asked for or, none
given, the attract's first fight: Yoko in costume 0 against Zaimoku in
costume 1. 9..26 are fighter c alone, costume k, as 9 + 2c + k, on Cross
Street with both sides that fighter (`lastbrnxScene` in `js/colors.js`).

**Palette.** {count, colours} at program 0x1872C, 318 colours, which 0x157F0
copies to the face palette. Some entries cycle at run time, and the table
holds their first frame (below).

**Stages** (`js/lastbrnx.js`). The stage task 0x71070 draws the stage with
0x71AC0, which reads the stage number (RAM 0x57DEC0) and walks that stage's
32-byte descriptor at program 0x795E0: an item list, its count and a cull
kind. An item is 12 bytes {type, value, pointer}: 0 is a model entry, 1 a
list of 24-byte placement records (0x72110; the model entry pointer at +0x14,
culled against the camera unless 0x5D2E60 is 2), 3 an animated piece
(0x71C68, dispatching on the stage's object kind through 0x94190: the crane,
the train, the airport's planes) and 2 the ring walls, which 0x72640 draws.
The Stages tab runs these routines on `js/i960.js`, with the camera (0x71DB0)
left out and the pieces' state set up by 0x941E0 as the round start does; a
draw is geometrizer command 0x01 with the model entry's four words. The copro
commands are Dead or Alive's, plus 0x0F (a box cull, answered "in view"),
0x17 and 0x6A. The stages that move are stepped a pass a frame, so the
viewer's clock plays them. Stage names come from the round banner's table
(0x2A190). Checked against MAME's display list at frame 1300: the 28 pieces
and four walls of Cross Street land where it has them.

**Colour cycles.** The round start 0x17950 takes the list for the stage's
object kind (0x5042E0; kinds past 8 take 8's) from 0x502B00: 12-byte records
{entry, frames, colours} up to one with no frames. An entry under 16 is face
palette entry 8 + entry, stepped by 0x17AA0's first loop; one of 16 or over
is the same entry, stepped by its second. Both step once a vblank (0x944),
going back to the first colour after the last. The colour table holds two
halfwords a frame; the second is used while 0x567140 is set, which nothing
in a fight does. This covers entries 8-19 and 40-48. The Stages tab plays
them, and so does the Models tab, using the cycles of the stage whose
texture set is shown.

**The USA build.** `lastbrnxu` (MAME's Revision A) has MAME's checksums but
was never in the container, so its offsets are worked out when it loads
(`settleLastbronx` in `js/games.js`, through the profile's `settle` hook in
`loadRomSet`). The program keeps its data section's source at 0x83C
(0xC9100 Export, 0xC9220 Japan). The difference from the Export's moves the
data, the fighter records, the settings and the stage code; the code is the
same, shifted by the same amount. Each stage routine is checked by its first
word, and if one doesn't match, the set loads without a Stages tab and with
a warning. This was checked on the Export and Japan programs (each settles
to its own profile), not on the USA set.

**Luma.** 0x1A50 works it out: two bands, divisors 120 and 112, entry k of
band d being ((k + 1) & 0x7E) × 64 / d up to d and 0x40 past it.

**Colours.** Out of the test menu's nine (add, multiply) settings, which an
empty backup RAM takes from the defaults in the program. 0x90D0 makes a
256-entry table of each: 0 at 0, then min(255, add + (mul × i >> 6)); pairs
0..2 are the ramps' red, green and blue, 3..5 the flat band's. 0x6D40 writes
a ramp to luma 0..63 of every row and 0x6DF0 a flat colour to luma 64..127.
0x92D0 (slot, table) then lays luma 0..63 of row 1 + 2 × (slot >> 1) from a
keyframe table (a float count, then position, red, green, blue floats),
interpolated in single precision as the board's FPU does and passed through
the ramp tables. 0x9590 sends the stage's five to rows 1..9 (the stage's
list by 0x504310, its sources `ld 0x502AA0[j*8]`), 0x9620 the two common ones
(`ld 0x502A08`) to rows 11 and 13, and 0x94E0 a fighter's four from its
record's list for its costume to rows 15..21 (player 1) or 23..29 (player 2).

**Checks.** Against MAME's texture RAM, colorxlat, luma and palette RAM at
frames 900, 1300 and 1800 of the attract (Cross Street, Yoko against
Zaimoku) and 3400 (stage 6, fighter 3 against Zaimoku): both texture sheets
match byte for byte, as do the luma and every colorxlat row but three of row
5 at frame 3400, which the previous stage leaves there. The palette matches
but for the six cycling entries. Through `loadRomSet` and `detectGames`, both
sets are detected with no warning, and 2540 models decode with 943314 faces
and no error.

The Japan build was checked the same way, against MAME's `lastbrnxj` every
100 frames from 1800 to 4500: stage 2 (Yoko against fighter 7 in costume 1)
matches in every colorxlat row, including stage 2's row 3, which comes from
the Japan build's own keyframes. Stage 6 (fighter 3 against fighter 7) also
matches, except for row 5: stage 6's list sends nothing for that row, so on
the board it keeps stage 2's colours.

**Fighters** (`js/lastbrnxfighters.js`, `js/sharc.js`). As for Dead or
Alive, there is no table of parts to read: the draw 0x4A940 works each part's
matrix out on the copro. Last Bronx's copro is a SHARC running a program the
i960 uploads (19698 halfwords at 0x99F8, through EPB0), and the fight code
leans on it as no stage piece does: a matrix stack, a pool of matrices it
hands out handles to (0x4B sets it up, 0x4C..0x4E take one, 0x59 gives one
back), lists of them per player, and command 0x46, which writes a whole
geometrizer packet into buffer RAM itself, 18 words at the geometry pointer
less 0x48: 0x05800B0B, the 12 matrix floats, flags, and the model entry's
four words. 0x47 closes a draw. So the explorer runs that program as well,
on `js/sharc.js`, a word-for-word port of m2-hle2's `sharc_cpu.h` (itself
MAME's interpreter), wired as the board wires it: FIFO in at 0x884000, FIFO
out, buffer RAM at 0x900000 on the i960's side; FLAG0 is "FIFO in empty". A
differential harness runs it and `sharc_cpu.h` side by side, on the
program fed random command streams (with and without one FIFO access in four
refused) and on random programs of every compute op: the traces, register
checksums and memory agree line for line.

The machine is the boot's (0x1380) set-up, the routines the copro's lists
and the fighters' tables need, in the boot's order: 0x12C0, 0x9110, 0x13490,
0x97D0, 0x154D0, 0x17870, 0x72E0 (cut short once it has uploaded the
program; the wait on the upload, 0x98D8, is answered by loading it), 0x15B0,
0x3E570, 0x366C0, 0x17CB0, 0x3F410, 0xD60, 0x1330, 0x13420, 0x9B130,
0x39070, then 0x4BC80, 0x452D0, 0x54A40, 0xB71C0, 0xC7760 and 0x231F0 (both
with 0x1E240) and 0x4F400. 0x3D700, 0x9DAC0 and 0x146D0 wait on hardware or
add nothing, and are left out: the draws match those of the whole boot
word for word. It takes ~180 ms. 0xB5E10 (player, fighter, costume, x,
bearing) then sets both players up as the round start (0x2F060) does: the
fighter in player one's place at the centre, its other costume facing it 3 m
away. 0x49540 (player, id) starts a motion, id = fighter << 10 | number, and
each frame is the step 0x49820 and the draw 0x4A940 under an identity
matrix (push 8, then 0x10; 5 before the draw and 6 after), so the parts come
back in the fighter's own frame, in metres, y up. A fighter is 16..19 parts
in the draw's order: hips, the legs three apiece, chest, an arm in three,
head, the other arm, and the weapon (models 1016 on). The model is the one
whose entry the four words are; the parents are worked out from the frames
(`jointsOf`, as for Dead or Alive).

The fighters are 1..8, by the 9-byte names at RAM 0x503F90 (YOKO, JOE,
NAGI, KUROSAWA, YUSAKU, TOMMY, LISA, ZAIMOKU; the ninth, REDEYE, has no
motions). Their motions are three tables of pointers per fighter, indexed
by the motion number: 0x52CEA0 the names (`kon_kamae_new_5_0`), 0x511BA0 the
data (a bitstream in the data ROM, unpacked by 0x4B090 to 0x585890 +
player * 0x19CC), 0x52B4D0 a 16-byte head whose halfwords at +8 and +10 are
the data's length in 1/30 s and the motion's in frames. 0x47D48 plays it at
57.5 * h8 / h10 a frame, and a motion holds its last pose once it ends. That
is 215, 277, 211, 195, 180, 152, 161 and 155 motions. A fighter stands on
the set of that fighter alone (9 + 2 * (fighter - 1) + costume).

The Japan build's code at or above 0x2A680 sits 0x120 higher; the code
below it, the copro's program, the model table and the RAM tables do not
move, and its draws are the Export build's word for word. The USA build is
checked by the first word of each fighter routine when it loads: where they
do not fit, the fighters are switched off with a warning.

**Not done.** The four models drawn from polygon RAM (1691, 1692, 1772,
1773), which the program fills itself, are empty; Nagi's first part is 1691
in costume 0 and 1772 in costume 1, so she stands without it. The fighters
have not been held against MAME's pictures; the copro is held only to
m2-hle2's port of MAME's interpreter. The USA set has not been tried.

### Polygon decoding (`js/model.js`)

A port of the index-array decoder from
[`m2-hle2`](../m2-hle2) (`src/board/geo3d.h`), which was validated at J=1.0
against 4405 reference meshes for STF and 2377 for Daytona USA — the algorithm
is the Model 2 board's polygon format, not a per-game quirk.

A mesh is a run of 40-byte vertex pairs. Two bytes per pair drive strip
connectivity (`iFlag`) and face type, an index array is built two groups behind
the tail, and quads emit with A-B-D-C winding. Per-face colour comes from an
8-byte material record indexed by *emitted* face, which selects a `colorbase`
into the global BGR555 palette at `main_data + 0x100000`.

**The UV stream runs against the reconstructed winding.** A face's corners come
out of the index array as A,B,D,C (A,B,C for a triangle) and the UV stream walks
the same loop the other way, because negating Z on read reverses the winding —
so the stream is B,A,C,D, not A,B,D,C.

The strips settle it without needing a reference image. A vertex shared by two
faces of one strip carries a single UV in ROM, so the right assignment is the
one that agrees with itself across shared vertices. Reading the stream backwards
agrees on 94% of them against 65% forwards, and every group of South Island's
geometry improves — the ground chunks go from 25% to 100%, the 3D palms from 58%
to 99%, the sky ring from 65% to 93%.

Read forwards, any face whose texture axis runs along the face comes out
mirrored. It is invisible on the tiling grass and rock, and unmissable on the
billboard palms in the background: they stood on their heads, with their
coconuts in the sand. Coverage tests cannot find this — permuting which corner
gets which UV leaves the set of UVs a face samples unchanged — which is why the
continuity of the strips is the measurement that matters.

**The polygon carries its own normal.** `+0x1C` of each record is a unit vector,
and it is the one the board lights that polygon with — `geo_parse_np_ns` reads
it straight out of the stream and never computes a plane. Paired with its own
record it is perpendicular to that face in 99.9% of South Island's triangles,
which is what identifies the field. The viewer used to cross the triangle's
edges instead. That is the same vector for a flat face, but not for a quad whose
four corners are not coplanar: the board shades such a quad as one polygon, and
crossing edges shades its two halves differently and creases it.

**The board has two transparencies, and the texture header holds both.**

Bits 14 and 13 of `texheader[0]` pick the renderer: textured, and transparent.
On a transparent face a texel of 15 is a hole (`model2rd.ipp`, the `Translucent`
instantiation of `draw_scanline_tex`) — 21,097 faces across the ROM use it, and
it cuts the palm fronds, the billboard trees and the ring ropes out of their
rectangles. The board still filters those faces: a hole carries no colour of its
own, so it borrows a neighbour's, and the four holes' weights blend into a
coverage that has to reach half a texel for the pixel to survive. The viewer runs
that same four-tap, which is what keeps a cut-out edge smooth rather than
stepped, and keeps the key from bleeding into the surface.

#### A decal is the same faces again

A decal on this board is not a face floating in front of a surface: it is the
surface's own faces emitted a second time, with a cut-out texture and the
transparent renderer, so the holes let the first copy show. Sonic's shouting
head, model 3544, is six such quads standing on six of the muzzle's, corner for
corner; 504 of the 4404 models that carry geometry have at least one.

The board never compares the two. Both take their z from the same corners, so
they land in the same bucket, and a bucket is drawn newest first — `model2_v.cpp`
prepends to the list — into a fill that writes a pixel only where nothing has.
The later polygon therefore keeps the quad whole. A depth test says the same
thing as long as it is `LessEqual`, which resolves a tie in favour of the later
draw; `js/viewer.js` states that on the material rather than leaving it to a
default, because every decal in the game depends on it.

It only holds while the two copies are the same triangles. A quad is filled as
two, and which diagonal it is cut along comes from where its strip anchored,
which for the second copy is not where the first anchored. Two of that mouth's
six quads were cut the other way, and across the other diagonal a quad with any
warp in it is a different surface: half of the decal bulged behind the muzzle and
was drawn behind it, which took the right-hand side of the mouth away. So
`js/model.js` cuts a quad whose four corners have been emitted before the way
that one was cut. Nothing else changes — same corners, same winding, the same
UVs on the same corners — and it took the number of triangles with an exact twin
from 4346 to 7216. `stf-tools/test-zsort.mjs` pins both the count and the mouth.

Bit 15 is the other one: **checker**. The polygon is drawn on every other screen
pixel and whatever is behind shows through the rest — the board's half
transparency, with no blending hardware involved. South Island sets it on 134
faces: the water planes at sea level and the waterfall. The pixels drawn are
those where `(x ^ scanline) & 1`, scanlines counted from the top; the shader
takes its row from the viewport's top, since `gl_FragCoord` counts from the
bottom and on 384 rows that is the other phase.

**The board sorts polygons, not pixels — and the viewer takes half of that.**

There is no depth buffer on a Model 2. `model2_3d_process_polygon` gives a whole
polygon a single z, and bits 10-11 of the attribute word say which of its corners
supplies it: `1` the nearest, `2` the farthest, `3` a fixed "very far", and `0`
whatever the previous polygon got, out of a register the rasterizer carries
across the frame. Polygons drop into 65536 buckets on that one z, the buckets are
drawn near-first, and the fill writes a pixel only if nothing has written it yet
(`model2rd.ipp`: `if (fill[x] == 0)`). So a *polygon* wins a pixel outright,
whatever the geometry does between it and the next one.

Casino Night's platform is what that buys. Its emerald is a five-triangle decal
modelled **0.087 below** the near-black diamond plate it is painted on — every
other piece of art on that platform sits at 0.000 to +0.032 — and the plate asks
to be sorted by its farthest corner. The plate is 5.1 units across and the decal
is one, so at the game's camera the plate buckets well behind it and the emerald
is drawn on top. Under a depth buffer it is simply buried, and only shows if you
fly under the platform, which is how the bug was reported.

The viewer honours **half** the rule: a polygon may take its own depth when that
pushes it *back*, never when it pulls it forward. Pushing back is what the art is
built on — a backing plane standing out of the way of the faces painted on it.
Pulling forward is the same instruction read the other way: a surface claims
every pixel it covers at the depth of its nearest corner. Under the game's fixed
camera that costs nothing; under a free one it turns South Island's ring floor
into a wall that swallows the corner posts standing on it and the palm trunks
behind it. That was tried, and it is worse than the bug it fixes — compared
against a MAME capture of the same arena, which shows neither artifact. So the
depth buffer keeps what a polygon would gain and the board's rule keeps only what
it gives up.

And what it gives up is **bounded at twelve units**, which the board does not
bound either. A recede is only safe while it lands behind the things the polygon
is meant to be behind, and it is the board's own camera that makes that true: it
sits close to what it draws, so a plane stepping back to its far corner steps
behind everything. From a camera that can be anywhere it does not. Canyon Cruise
is the case that shows it: the river runs from under the lens to forty units out,
and a face of it taken back to its own far corner lands in the middle of the boat
forty units away — painting water across the deck, on a boat that is sitting on
the water exactly where the board puts it. Twelve units is past what the art
needs (Casino Night's plate is 5.1 across and buckets behind its decal at six)
and short of what a polygon lying along the view would take, so a shallow face
still recedes in full and an oblique one keeps its slope.

Each vertex therefore carries the four corners of the polygon its face is sorted
by, and the vertex shader replaces the interpolated depth with the one the whole
face resolves to. A face asking for the previous polygon's z inherits that
polygon's corners; the first face of a model that asks would be inheriting from
whatever the board drew before it, which the ROM cannot say, so it takes its own
nearest corner and the rule leaves it alone. `stf-tools/test-zsort.mjs` pins the mode
resolution and the emerald against `model2_v.cpp` rather than against the shader.

**And only in front of the lens.** The substitute depth is carried as `z/w`
rather than as a depth, so that the clipper interpolates it along with `w` and
their ratio survives — but behind the camera `w` is negative and the ratio is
not a depth at all. The clamp that keeps a receded face inside the frustum hands
back ±1 whatever the corners say, so `z` comes out as exactly `-w`: the near
plane. The clipper, which finds where an edge crosses that plane by interpolating
the two against each other, is then told the crossing is at the vertex it should
have been cutting away, and throws the polygon out whole instead of trimming it.
A vertex the camera cannot see needs no help sorting, so it keeps the depth the
projection gave it.

Aurora Icefield is where that showed. Its ground is four wedges three hundred
units across, drawn on quarter turns; whichever one the camera happened to be
standing over lost every corner behind the lens and vanished, taking a quadrant
of the icefield with it. Canyon Cruise showed the same thing from inside a cliff.
Neither is visible from the board's own camera, which never stands in its
scenery — which is why the rule needed the bound in one direction and this guard
in the other.

**And only while the face is shallow.** A bound is still a sink: a ground plane
pushed back twelve units passes below anything modelled under it within them. So
the measure of whether to recede at all is the face's own depth — how far its
near corner stands in front of its far one along the view. A face turned toward
the camera is a few units deep whatever its size, and stepping it back by that is
the whole of what the rule was for: two faces lying flat against each other are
shallow together, so the backing one recedes in full and the decal keeps the
pixel. A face raked along the view is deep, and stepping it back by its far
corner sinks its near end through whatever stands under it. A face deeper than
the bound therefore keeps the depth the projection gave it.

Aurora Icefield is what that is for. Its ground wedges are hundreds of units deep
at any grazing angle, and receding them sank the ice below the walruses'
reflection and the lower half of the cage — both of which hang under it — so they
showed from outside the ring, where the board only ever shows them through it.

**What it costs is everything the sinking floor was covering up.** Mushroom Hill
is where that is simply true: its forest floor genuinely interpenetrates the
stump it surrounds, sinking the floor hid that, and leaving it where it is shows
the intersection as wedges of grass cutting into the bark. A floor that keeps its
own depth tells the truth about the models, and the models were built for a
machine that sorted whole polygons and never had to be truthful. The repair is
depth precision — `near` sits at 0.02 against a `far` of 2000, a hundred-thousand
to one — and not a smaller bound, which has to stay above the 0.139 Casino
Night's emerald is modelled behind its plate — 0.087 in the mesh, through the
ground pass's 1.6 — and so cannot go small enough to stop the sink mattering.

**And it strands open water.** The deep-face rule is written for scenery, and
there is one kind of surface it gets wrong: a single plate hundreds of units
across with the whole arena standing *in* it. South Island's sea 555 is deep from
every camera, so it never moves — while the island 518 standing in it is a box of
bumpy rock faces a few units deep that recede in full. The board sorts both by
their farthest corner and the island wins by hundreds of units; here the island
stepped back its own three or four and the sea, standing still, took the
difference. That is a flat waterline slicing a third off the rock wall and riding
up and down it as the camera moves, and the shore chunks and corner posts with
it. Canyon Cruise has the same thing worse: its river swallowed the boat's hull
and left the cabin floating.

South Island's four sea-level plates are the same fact at closer range. The sea
555, the floor plate 517 and ground chunks 506 and 511 are modelled **0.01
apart**, which at `near = 0.02` is under the depth buffer's resolution a hundred
units out; what had been holding them apart was exactly the differing shear the
bounded recede put across them, and all four are far deeper than the bound.

So the two plates say what the board's sort says: **the water concedes the whole
bound**, shallow faces or not, in `waterMaterial` and `floorMaterial`. What that
could cost is anything modelled under the water within twelve units, and in this
game nothing is — the sea plate and the river are the lowest surfaces their
stages have, which is the same fact that makes the board's own unbounded sort
safe on them. Measured over 216 cameras around South Island's arena, the two
plates took 1,975,304 of the island's 30,490,191 pixels and now take 202,172 —
and what is left is the stipple edge of the island's own shadow plate, which is
modelled in the sea's plane, drawn after it, and comes back with the rock. Across
the sixteen stages at six cameras each the change is 5,234 pixels, all of it
water meeting something standing in it. `stf-tools/test-zsort.mjs` pins the two
halves of the argument: that every face of both plates really is deeper than the
bound at a camera that showed the artifact, and that the island's own recede
stays inside the bound they concede.

**And the concession belongs to the draw, not to the layer.** Everything above is
an argument about `stage_floor` in particular — one plate hundreds of units
across, sorted by its own farthest corner, that `camera_init` lays down before
every other pass. `js/display.js` marks that draw `groundPlate`, and `js/app.js`
hands `floorMaterial` to draws carrying the mark rather than to the layer they
are filed under. The `floor` layer is a grouping for the sidebar's checkboxes,
and it collects one draw that is no such plate: the Final Eggman Boss's "E-MECH
ACTIVATED" panel, 2709, which slot 10 has no `stage_floor` for at all — it is
`sub_2731C`'s own draw, filed with the floor because that is what it reads as.
It is fourteen units across, not hundreds, and it lies **inside** the arena drum
1122 rather than under it, three units below the grid the drum's top is cut
into. Conceding the whole bound sank it past the drum's own wall, and the arch
of that wall then stood up through the lettering — visible through the cut-out
grid from any camera above the ring, which is how it was reported. Keeping its
own depth is the right answer for it and the wrong one for `stage_floor`, which
is the whole reason the two are told apart by the draw. Across sixteen stages at
three cameras each, the one frame that changes is the Final Eggman Boss's; the
other forty-seven are identical to the pixel.

That arch is worth naming for what it is: **back faces**. All 184 of 2450's wall
triangles are wound one way, and 1122's interior renders nothing at all under the
board's front/back test — the board would never draw either of them. The viewer
showed them then because it drew every face from both sides; it now takes that
test too, and see *Which side the board draws* below for what that changed.

**And a floor that cannot concede keeps what stands on it.** Aurora Icefield's
ice is `stage_extra`, 1602: four wedges hundreds of units deep, so it keeps its
own depth. It has to, because the stage hangs things under it, the walruses'
reflection and the lower half of the cage, and conceding would stand them up
through it. But the ice pillars 4278 and the walrus statues 1601 stand on it, and
every one of their faces asks for its farthest corner. Those faces are a few units
deep, so each receded in full, through the ice it stands on. The ice cut the
pillars' flared bases off flat and the walruses' feet with them, and inside a
pillar every face flattened to its far corner, so the inside of the far wall came
through the near one as streaks of the wrong panel. On the board the ice is sorted
by a corner out at its tip, and both solids win every pixel they cover. So
`aurora_disp`'s draws of them are marked `standing`, and `standingMaterial` gives
them the depth the projection gave them, with no recede at all. A closed solid is
something a depth buffer resolves on its own, and over the ice the true depth
gives the board's answer. Aurora's texture RAM was checked byte for byte against
m2-hle2's for the same scene before blaming the depth: the texels were never
wrong.

#### The floor plate concedes a tie

Depth precision is no answer at all to two surfaces that are not near each other
but *identical*. South Island's floor plate 517 is four quads round the ring, and
the sea 555 carries four quads of its own over exactly the same ground — not
merely coplanar, but sorted on the **same four corners**, so they resolve to one
z at every camera that exists. All four of the floor's sort groups are tied that
way. No depth test anywhere can separate them; only the submission order can, and
`stf-tools/dl-order.mjs` reads that order off a display-list capture rather than
guessing at it.

The board settles it without ever comparing the two. A bucket is rasterized
newest first — `model2_v.cpp` prepends to the list — into a fill that writes a
pixel only where nothing has, so the **last** submission over a bucket keeps it.
`camera_init` draws `stage_floor` before any other pass, which makes the floor
the one surface in the arena that loses every tie it is in.

The viewer had no rule for it, and three.js's default is not the board's: the
opaque sort keys on the geometry's bounding-sphere centre, and the sea's plate is
lopsided — x −94.5..318.8 against the floor's ±24 — so its centre lands the sea
before or after the floor depending on where the camera stands. Standing over the
island it landed the sea first and the floor took the whole ring off it: 222,389
pixels of still plate through the scrolling sea at one frame.

So the floor states the concession itself, in `floorMaterial`: one depth unit and
one slope unit back. The unit settles a shallow tie, the slope a raked one, where
the two triangulations of the same flat quad — the sea cuts three of these four
along the other diagonal — round apart and speckle. Measured over four cameras the floor
now takes no pixel of the sea at all, and the ground pass keeps every pixel it
had: its shore chunks stand 0.0016 over the plate, which is under the buffer's
resolution at that range either way, and they are submitted after the floor too,
so the step moves that tie the way the board already moved it.

What it costs is a rim. On the Flying Carpet, Mushroom Hill, Dynamite Plant and
Giant Wing, a hairline where the plate meets the surface around it — 2,035 pixels
at worst, on Giant Wing — now goes to that surface. That is the same answer for
the same reason: everything is submitted after the floor.

A depth unit only settles ties, though, and the plate loses more than ties. It is
one surface hundreds of units across sorted by its own farthest corner, so on the
board everything standing on it wins over it outright — the same case as the open
water, and it takes the same concede. The depth unit stays on top of that to part
the floor from the sea, which concedes the same amount.

Model-table entry `i` lives at `main_data + 0x0E0004 + i*16`:

| offset | meaning |
|--------|---------|
| `+0x00` | UV stream, word index into the texture ROM |
| `+0x04` | material records, half-word index into the texture ROM |
| `+0x08` | mesh pointer; ROM offset is `ptr*4 - 0x02000010 + 0x10` |

#### Which side the board draws

A Model 2 polygon is drawn from one side unless it says otherwise.
`model2_v.cpp`'s `check_culling` throws a polygon out when bit 17 of its attribute
word is clear and `geo_parse` has set the rear bit on it, and the rear bit is set
when `dot(normal, point) < 0` — the ROM normal and the first point the link itself
brings, both through the same matrix and before the perspective divide. Four in
five polygons in both games leave bit 17 clear.

The viewer drew every face from both sides until this, on the argument that a
free camera inside a shell should see a wall. What that cost only showed once the
far-corner recede met it: a face stepped back to its far corner lands on the back
faces that share that corner, and whichever is drawn last shows through. Fighting
Vipers is where it was plain — a sawtooth along the tops of the graffiti arena's
walls, the underside of stage 8's ring apron standing up through the ring —
alongside the plates in the next section.

`js/model.js` now carries bit 17 as face flag bit 7 and the link's first new point
per face, and the vertex shader collapses a face whose test fails. Three things
are worth knowing about it:

- **It is the ROM normal, not the winding.** The two agree in every model checked
  in both games, and the normal points *away* from the side that is drawn. The
  test is taken against one point per polygon, which matters only on a quad whose
  normal is not its plane's.
- **A face with no normal of its own is drawn from both sides.** Its dot product
  is zero, which the board counts as the front.
- **Picking takes the same test**, so a click does not land on a face nobody can
  see (`boardDrawsFace`).

Measured against the renders before it, over all sixteen stages of both games at
six cameras each: in Sonic The Fighters the large changes are cameras outside a
sky shell, under a ground plate or inside a drum, which now see through it — the
board's answer, and the one this file used to trade away. Inside the arena
the changes are inside-out boxes closing (Mushroom Hill's tree trunks, Death Egg's
hanging monitors showing their backs from outside the ring), and on the
characters a few hundred pixels at most, among them Fang's smile, which the back
of his head had been covering. In Fighting Vipers some geometry built only for the
game's low camera disappears from above: stage 1's gantry is one-sided with its
drawn side facing down, exactly as the board would cull it. The `backface cull`
checkbox turns the test off.

#### Fighting Vipers takes no recede

The bounded far-corner recede above is a Sonic The Fighters rule, and the bound is
a per-game setting (`depth.recede` in `js/games.js`). Fighting Vipers sets it to
zero.

Its stages are several plates in one plane — road, floor, ring, building bases,
all at `y = 0` — cut at sizes that have nothing to do with each other. The bounded
recede steps a face back by its own depth up to twelve units, and not at all past
twelve, so plates in one plane part by how they were cut, and the parting moves
with the camera. The western arena is the clearest case: its dirt 581 is a plate
forty-eight units across with faces deeper than the bound, which keep their depth,
and the wood ring 583 is faces of six to ten, which all sink under the dirt. What
came out was a wood octagon floating in dirt, redrawn a polygon at a time as the
camera moved. A capture of that stage has wood from fence to fence, and with the
recede off so does the viewer. Turning it off changed a fifth to a third of the
screen on that stage and up to a sixth on the graffiti arena, and every view
compared came out as the capture shows it. The plate biases `buildFlatDisplayList`
hands out are what settle the plane then, by submission order, which is the
board's answer — the recede had simply been larger than them.

What the recede exists for is a surface modelled behind one it shows through, and
this game has none. Searching every stage for a face lying under an opaque face
within 0.3 finds only things resting on the ground — porch boards 0.002 over the
dirt, a lip 0.27 over the floor — which the depth buffer puts on top unaided.

What it does have is lettering 0.002 in *front* of its sign, which a 24-bit buffer
at `near = 0.02` stops separating about twenty-six units out. So the same profile
raises the near plane's floor to 0.1 (`depth.nearMin`); at one camera across the
western arena that took the shimmer from 2,982 pixels to 2. The arena is twelve
units wide, so the plane standing a tenth of a unit off is not something a flying
camera runs into.

The near plane only moves the distance out, though. A sign across the town
still shimmered, the UFO Diner's Pepsi board lost half its letters to the board
under them, and a phone's depth buffer, coarser than 24 bits, lost them sooner.
The stages also lay shadows and stains on the ground in its own plane, and
plates of one layer over each other. So Fighting Vipers takes `depth.layers`
as well: each face lying on another in its plane is put over it in the order
the board's sort gives (see "Faces laid on faces" and `js/layers.js`), at any
distance. Its cost did not show in the frame time on any stage. The one change
seen that is not a fix is behind the Western's bank, outside the town, where
the sort puts the board over the lettering; the game's camera never stands
there.

### Stages (`js/stages.js`, `js/display.js`)

`change_scene()` indexes a 256-byte record per stage from `stage_data` at
`0x0008F3D0` in the program ROM, and copies 64 words of it to `0x504800`.
`js/stages.js` reads that record; `js/display.js` turns it into a draw list.

The draw list matters, because only one of the game's stage draw functions uses
the identity matrix. `camera_init` calls, in order:

| function | what it draws | transform |
|----------|---------------|-----------|
| `camera_init` | `stage_floor` | scale 1.6 |
| `ground_disp` → `area_clip` | the 16 scenery chunks | identity — they are pre-placed in world space |
| `stage_dsp` | `stage_platform`, plus per-stage extras | scale `(floor_stage_size_0, 1.6, …)` |
| `cage_sub_disp` | `stage_extra` | ×4 at quarter turns, or one offset ramp on South Island |
| `cage_display` → `cage_clip_m` | the cage panels | 4 walls, quarter turns, `+6` on Z, scale `(stage_x/6, cage_height/3.1, …)` |
| `pole_disp` | the corner posts | ×4 at quarter turns |
| `object_control` | the stage's own objects | each routine's own — see [The stage's own objects](#the-stages-own-objects) |

Each entry composes as `M = S · Ry · T`, the order the coprocessor display list
applies `0x3800707` / `0x4800909` / `0x3000606`. Drawing these at the origin
instead — as an earlier version of this viewer did — collapses the cage, its
posts and the ring ramp into the middle of the arena.

The angles cross into the viewer with their sense intact, which is worth saying
because two reversals are involved and they cancel. `ang_x`, `ang_y` and `ang_z`
each post-multiply by the *transpose* of the matrix that angle names in a
right-handed system — `ang_y` builds columns `(c,0,s)` and `(-s,0,c)` where
three's `makeRotationY` builds `(c,0,-s)` and `(s,0,c)` — which is what a Z
running into the screen means. `js/model.js` then negates Z on read to bring the
geometry out the other way, and conjugating a rotation by that flip transposes
it a second time. So an `ang_x` or an `ang_y` is handed to three unchanged; a
translation loses its Z, and an `ang_z` — the one axis the flip leaves alone —
would have to be negated.

`stage_x` is 8.0 on every stage; `floor_stage_size_0` is the stage record's
`+0xD0` float; `cage_height` is its `+0xCC` float times 1.6.

Two of those rows do not fire on every stage. `camera_init` reads `stage_floor`
only when flag bit 2 is clear, and `stage_dsp` returns on slot 2 before it draws
anything at all — both of which land on Aurora Icefield, the one arena whose
floor is entirely its own object's business. See
[Aurora Icefield draws its own ring](#aurora-icefield-draws-its-own-ring-and-nothing-else-does).

South Island (slots 0, 13 and 14) additionally runs `sub_26604` for its cage
shadow, four palm trees at `(±6.25, ±6.25) × floor_stage_size_0`, and takes a
separate `cage_sub_disp` branch that puts a single ramp at `x = -6.5 ×
floor_stage_size_0` rather than a ring of four.

#### The Final Eggman Boss draws its parent stage

Slot 10's record is the Death Egg's, copied: the same sixteen ground chunks, the
same backdrop, the same post at `+0x1C`. None of it is what is on screen. Flag
bit 13 makes `ground_disp` skip `area_clip`, `doom_cnt` returns on the slot
before it reads a backdrop, `stage_floor` is zero, and `pole_disp` branches on
the slot before it reaches the record. What the stage actually stands in comes
out of `sub_2731C`, the routine `stage_dsp` runs for it the way it runs
`sub_26604` for South Island — and that routine is its parent stage's. Death
Egg's Eye reaches the same code by falling out of `sub_26830` once its own
transition has finished, which is what makes the two slots show the same arena
across the hand-off.

Every part of it but the floor is drawn in one frame: scale
`(floor_stage_size_0, 1.6, floor_stage_size_0)`, then a translate of 35 in Y.
The scale is emitted first, so the offset is scaled with it and the hangar hangs
56 up — which is what the models want, since they are all modelled around
`y = -35`.

| part | model | drawn |
|------|-------|-------|
| "E-MECH ACTIVATED floor" | 2709 | once, at `(fs, 1, fs)` and no lift — it sits under the ring, inside the drum, and takes no `groundPlate` |
| "Deathegg II ceiling" | 2449 | once |
| "Inside of Eggman hangar" | 2426 | ×3, at 0°, 180° and 270° — the quarter it leaves out is the door wall |
| the standing hangar doors | 2446, 2447, 2448 | once each |
| "The four tubes" | 2450 | once |
| "Model surrounding the hangar doors" | 2429 | ×4 on quarter turns |
| "Bridge from hangar to ring" | 2425 | ×4 on quarter turns |
| the ceiling iris | `circular_door_open_close_anim` | once, walking its table a frame at a time |
| the corner posts | 2428 | ×4 on quarter turns, in place of the record's 1208 |

Nearly every branch in the routine reads `0x500498`, the word `bossm_init`
zeroes when Death Egg's Eye loads and the transition then fills in a bit at a
time — the elevator arriving, the shutter going up, the floor activating. None
of that is this stage: by the time slot 10 is loaded the sequence has finished
and `bossm_cont` has set bit 31, the bit that says so. That is the state
`js/display.js` builds, and two things settle it rather than leaving it a guess.
Bit 31 is what makes the parent stage jump straight into this routine, so the
two slots agree across the hand-off. And it is the bit that turns off
`sub_27E3C`, the continuation that walks a fighter out of the hangar door and
would otherwise still be running with the round in progress. So the shutter is
up — `bossm_shutter_up_cnt` returns without drawing one — and the floor is at
full size rather than partway along the scale table it grows through.

The one thing left to the player is which door is open. `bossm_shutter_up_cnt`
raises 2445 for player 1 and 2447 for player 2, and the block that draws the
standing doors names the other three to match; the viewer has no player, so it
takes the player 1 arrangement.

#### Tails' lab is the attract movie's, not the record's

Slot 15, `ADV_MOV2`, is the stage the attract movie runs on: `ADV_SEGA_PIC_INT`
sets `stage_num` to 15 before `ADV_MOVIE_INT`. Its record draws next to nothing.
Flag bit 2 turns off `camera_init`'s floor (the record's 224 is never drawn
from there), bit 13 turns off `area_clip`, stage_dsp's branch for the slot
(`adv_mov2_stage_dsp_sub`) is a bare `ret`, and no cage, post or ramp bit is
set. All that is left is `doom_cnt`'s backdrop ring, 225 and 226.

The lab comes from the movie. `adv_movie_cont` runs one scene at a time through
`adv_movie_cont_ex`/`adv_movie_disp_ex`: Death Egg, Eggman's lab, then
`adv_movie_snc_init`, which installs `adv_movie_snc_disp` for the outside and,
once the first cut has run, `adv_movie_snc_disp2` for the inside. Neither
routine pushes the arena's 1.6; each opens a matrix on the camera and draws at
the models' own size:

| part | model | drawn |
|------|-------|-------|
| sea | 74 | `set_obj_thd` through `send_st15_sea_thd`'s header: nine quads, lumabase walked 7..70 at half rate, as South Island's |
| ground, area under the lab, hangar walls, doors | 224, 78, 3798, 3489, 3490, 3491 | at the identity |
| the Tornado | 2945 | translate (-60, 1, -37), ang_y 0x4000 |
| roof dish | 80 | translate (-14, 71.8, -17.18), ang_y `am_cntr << 8` (turns once a frame) |
| the room, its doors, its floor piece | 3473, 3490, 3491, 227 | translate (0, -2, 0) |
| monitor | `tails_display_screen[movie_flags]` | 81..84, 30 frames each from `am_cntr` 64, the last held to the end of a 256-frame lap; one frame in eight by `rand` it is 1201, black |
| ON AIR sign, control panel, Chaos Emerald machine | 2817, 3482, 3481 | in the room's frame |
| Lunar Fox rocket, and its dome | 230, 231 | (23, 23.6, 0) on the room, then (0, 8.967, 2.88) on the rocket, no push between |

`js/display.js` draws both routines, the outside on the `outside` layer and the
inside on `inside`. The board never shows them in the same frame. The room sits
inside the hangar walls, so turn `outside` off to look in. The two layers name
the same doors 2 units apart, so with both on the doors are there twice. The
monitor's black flicker is random and left out.

`adv_movie_snc_init` also stores `VECTER_Y` = 0xA400 over the record's 0xF400.
`camera_init` builds the light out of the global each frame, so the viewer
lights the slot with the movie's value. Sonic and Tails stand at the control
panel during the scene (`fa_rob0` at (-12, 0, -25), `fa_rob1` at (-9.2, 0, -28));
they are not drawn here.

#### Eggman's lab, the movie's second scene

The movie runs every scene on slot 15, so Eggman's lab (`adv_movie_egg_init`,
`adv_movie_egg`, `adv_movie_egg_disp`) draws its room at the origin of the same
world as Tails' lab. `js/stages.js` lists it as a seventeenth stage, "Eggman's
Lab (ADV_MOVIE)", a copy of slot 15's record with `scene: 'eggLab'`, and
`js/display.js` draws it in place of the Tails' lab routines.

| part | model | drawn |
|------|-------|-------|
| the room | 3333 | at the identity, on the camera's matrix, at its own size |
| the three monitor panels | 3770, `eggman_lab_viewscreens[am_cntr & 3]` (85..88, a new one each frame), 3771 | each once its inset window has opened |

`movie_flags`, `dword_5004D8` and `dword_5004DC` start at 16, 40 and 64 and count
down once a frame through the second cut (`am_num` 1, `am_cntr` 128..320). Each
one's window opens as it runs down (`amed_open_window`), and the panel under it
is drawn once it reaches zero. The viewer loops the second cut: its clock is
`t = frame % 384` and `am_cntr = 128 + t`, so the screens switch on during the
first 64 frames, the footage plays to t = 192 (the cut's own length), and the
footage keeps playing for the rest of the loop.

The windows (`word_978FC`, `word_97914`, `word_9792C`, as y1, x0, y0, x1) are
what the monitors show during the second cut. Each loads the identity (op 3)
and draws in view space at BRIGHT 1.0: two Egg Robos (2681) flying across, four
dark ones (3851..3853) standing about, and an upper body (223) whose head
rises through `egg_robo_head_rising_anim` (2981..2991). Each window's
projection centres on the rectangle's own centre at focal 280, and from the
cut-1 camera each rectangle lies exactly over its panel (win1 over 3770, win2
over the viewscreens, win3 over 3771).

- While a counter `n = S - t - 1` is between 0 and 16, `amed_open_window` draws
  the giant square (3769) at view (0, 0.22·n, 2.5): a white card that slides
  down the window, the screen "switching on".
- Once it reaches zero the footage plays, until the cut ends.

The viewer draws each window into its own render target, through an off-axis
lens built from the rectangle, cleared transparent, and lays the target on a
quad 0.02 in front of its panel (`buildEggLabFootage` in `js/app.js`;
`eggLabFootage` in `js/display.js` gives the draws for a frame). The footage
shares the room's material, so it flickers with the room's light, as the
board's does: BRIGHT 1.0 is written after the light is built. From any
camera the footage stays on the panels, like a picture on a monitor. Checked
against MAME snapshots at t = 8, 30, 58, 100, 150 and 172. Eggman (`fa_rob0`,
at the origin) and the Egg Robo beside him (`fa_rob1`, at (6.5, 0, -2.5),
turned 0x2000) are left out.

The scene's camera and light:

- `adv_movie_egg_init` sets `fa_camera` bit 17, and `camera_init` then skips
  `doom_cnt`, so the record's backdrop is not drawn. The screen clears to colour
  0 (`change_bg_color` with g0 = 0).
- It stores `VECTER_X` 0xF000, `VECTER_Y` 0x8000 and BRIGHT 2.0.
- `adv_movie_egg` rewrites BRIGHT every frame as
  `2 + sin(am_cntr * 0x1300) + cos(am_cntr * 0x500)`. It runs before
  `camera_init` builds the light, so the room's light flickers from 0 to 4.
  `adv_movie_egg_disp`'s 1.0 for the windows comes after the light is built.
  The viewer takes `am_cntr` from the stage clock (`stageBright`).
- The cuts' cameras: cut 0 flies the spline at `0x97398`; cut 1 stands at
  (0, 4.5, -6) facing +Z, square on to the monitors; cut 2 stands at
  (-1.2, 1.7, 1.8) and looks at (0, 2, 0), that is, at Eggman.

Stages are named from the decompilation's own branch comments, which key off the
stage SLOT (the `stage_num` byte the draw functions compare against), not off
`stage_NUM`. Slots the listing does not name show their slot number — add a line
to `STAGE_NAMES` in `js/stages.js` to name one.

### Stage animation

A Model 2 draw function does not interpolate anything. It animates a stage by
naming a **different model** each frame, out of a table of pre-modelled poses in
the program ROM, indexed by the global `frame_counter`. Every one of them has
the same shape —

```
model = table[((frame_counter >> shift) + phase) & (length - 1)]
```

— where `shift` slows the table down and `phase` offsets one instance of a
repeated object from the next, so the four palms do not sway in lockstep.

| what | function | table | frames | rate | phase |
|------|----------|-------|--------|------|-------|
| South Island's palms | `sub_26604` | `south_island_palm_tree` `0x267B0` | 32 | 30 Hz | `8i` per tree |
| … and their shadow | `sub_26604` | `south_island_palm_tree_shadow` `0x267F0` | 32 | 30 Hz | 16 |
| the Flying Carpet's floor | `animate_flying_carpet` | `flying_carpet_floor_anim` `0x28060` | 64 | 30 Hz | — |
| its corner flames | `pole_disp` | `flying_carpet_cage_flames` `0x28100` | 64 | 30 Hz | `4i` per corner |
| its ring rope | `cage_clip_m` | `flying_carpet_ring_anim` `0x90E8C` | 64 | 30 Hz | — |
| the Final Eggman Boss's fence | `cage_clip_m` | `electric_fence_anim` `0x90DEC` | 64 | 60 Hz | — |
| … and its ceiling iris | `sub_2731C` | `circular_door_open_close_anim` `0x90CCC` | 128 | 60 Hz | — |

The tables are read from ROM rather than transcribed, which is how their quirks
survive: the palm's last entry repeats 552 where the run wanted 553, and
`electric_fence_anim` is assembled as longs but read as halfwords, so every
other entry is the zero half of one — the fence goes dark on alternate frames,
which is the strobe.

Five things move without a table:

- **The flames pulse.** `pole_disp` emits an extra uniform 1.25 scale on the
  frames where bit 0 of the counter is clear, and nothing on the others. It
  faces each flame at the camera first (op 16, `0x253D4`), which also drops
  the post's 1.6, so a flame is drawn at its own size or 1.25 of it. The posts
  under them are turned to the camera's heading (`0x25388`, the yaw at
  `fa_camera+0x26`), which the viewer takes from its own camera.
- **The horizon drifts.** `doom_cnt` keeps a 16-bit yaw at `0x500464` and adds 2
  to it every frame on the stages whose flag bit `0x1B` is set (South Island,
  its two alternates, and the Flying Carpet). That is a shade under 0.011° a
  frame — a full turn takes about nine minutes. It also returns before it draws
  anything at all on two slots whose records name a backdrop regardless —
  Mushroom Hill, whose canopy its own object draws instead, and the Final Eggman
  Boss, which is indoors — so neither gets the ring. Death Egg's Eye is a third,
  but it drops its backdrop partway through its transition rather than on the
  slot, so it keeps the one it starts with.
- **The ocean scrolls**, by changing which luma band its faces read.
- **The shoreline and the waterfall scroll**, by rotating a colorxlat row.
- **The Flying Carpet flies**, and the desert goes past it.

The ocean and the shoreline look the same on screen and are not the same thing
at all.

`cage_clip_m` also branches on the stage *before* it reaches the record's panel
list, so on four stages the cage panels in `stage_data` are never drawn: the
Flying Carpet's rope and the Final Eggman Boss's fence are the tables above, and
Canyon Cruise's boat ring is a table of four — one model per wall, which is why
the record carries only the first of them. Death Egg's Eye branches too, but on
elevator state the viewer does not model, so its record panels are left standing.

#### The Flying Carpet's flight

The Flying Carpet is the one stage whose draw list depends on where the stage
itself has got to. `flying_carpet_stage_setup` hands `object_move` two objects,
and the first runs `flying_carpet_init` once a frame. It keeps a 16-bit heading
at `+0x26` of the object, steps it by 32, and puts the carpet on a circle:

```
stage_xpos = 60·cos t     stage_zpos = 60·sin t     stage_ypos = 4 + 4·sin 4t
```

Four rises and falls to the lap, and a lap every 2048 frames — a little over
half a minute. It writes the heading to `0x50A022` and an `ang_x` to `0x50A020`
built out of the frame's own movement: the `asin` of the vertical part of
`position - last position` over that vector's length, so the carpet noses up as
it climbs. `0x50A024`, the roll, is never written on this stage.

**Nothing about the arena moves.** `camera_init`'s floor draw, `ground_disp`'s
scenery chunks and `doom_cnt`'s backdrop ring each push the same prologue before
they draw — `ang_z`, `ang_x` and `ang_y` by the three negated angles, then a
translate by the negated position — and that prologue is the world seen from the
carpet. The carpet stays where it is on screen and the desert flies past
underneath it, which is both what the stage looks like and the reason
`stage_dsp`, `cage_display` and `pole_disp` do not push it: they draw the arena,
and the arena is what the frame is pinned to. On every other stage all four
values are still the zeros `change_scene` wrote, so the prologue is the identity
and those draws come out where they always did.

`flying_carpet_init` rewrites `VECTER_Y` in the same breath, as a fixed `0x271C`
less the heading it has just advanced. The light is built in the stage's own
frame and the stage's frame is the one turning, so subtracting the heading is
what holds the sun still in the world while the carpet flies out from under it.
`VECTER_X` is left alone: the nose-up angle is not compensated, only the
heading.

#### The sphynx head

The stage's second object is `draw_sphynx_head`, and it is the only draw in the
game that *aims* at something. The sphynx's body is one of the sixteen scenery
chunks and stands still; model 322 is the head, drawn separately at
`(-7.85, 7, 52)` — on the body's neck — and yawed and pitched to face the
midpoint of the two fighters, so it turns to watch the carpet go round.

Working those angles out needs the head's own position in the frame the
fighters' coordinates live in, and the routine gets it by handing the
coprocessor a matrix built for the purpose — identity, translate by the negated
stage position, scale 1.6 — and asking it to transform that point (`0x14802929`,
model→world). The draw is at that same 1.6, though it builds no scale of its
own: before its translate it sends `0x44` with 8, loading inner slot 8 over the
prologue, and slot 8 is what `camera_init` stored at `0x1FC7C` — the prologue
again, scaled 1.6. So the head stands where the probe measured it and is drawn
at 1.6× its model's size, like the body under it. An earlier reading missed the
load, took the 1.6 for a bug in the probe, and drew the head at its model's own
size. `m2-hle2`'s `tools/grade-stages.mjs` is what caught it: the head only
matched the board's draws with the scale put back. `stf-tools/test-carpet.mjs`
pins that the model's `+Z` follows the look-at exactly.

The same function draws two more things the stage record does not carry: four
corner pieces on the carpet at `stage_x / 6`, a quarter turn apart, and one flat
plate under it at `floor_stage_size_0`. Neither moves with the world — they are
drawn after the prologue is popped.

#### The ocean: a texture header per frame

The sea plate is model 555, and `ground_disp` does not draw it with `set_obj`
like everything else — it uses `set_obj_thd`, which takes a block of
**texture-header overrides** as its second argument. `send_st01_sea_thd` builds
that block once a frame: `move_tpd_req` queues it and `transmap_change` writes
twelve four-word quads — one per face of the model — into geometry program
memory at `GEO_PROGRAM_START + 0x1000`.

Each quad is the model's own header *verbatim* —

```
th0 0x40DA   textured, 128x256      th2 0x0A0C   tile at (384, 256), sheet 0
th1  ...     lumabase               th3 0x03C0   colorbase 15
```

— except for `th1`, which the game replaces with `((frame_counter >> 1) & 63) +
7`. Nothing else about the sea changes: not the tile, not the colour, not a
vertex. **Its faces are simply moved from one luma band to the next**, 7 through
70, twice a second per band.

That works because of how luma RAM is laid out, which is a finding already in
[Textures](#textures): the sixty-four bands past the first few are the same
sixteen palette slots rotated one step further each. Walking the band is
therefore walking the rotation, and the band count in ROM says so out loud —
`essential_color_handling` uploads exactly **71** bands, which is 7 plus the 64
the sea asks for.

The viewer applies it by rewriting the water mesh's `aLumaBase` attribute, on a
copy of the decoder's array so the shared decode of model 555 is not disturbed.

#### The shoreline and the waterfall: a palette row per frame

This one is unrelated, and rotates the colours rather than the band. `sub_2435C`
runs once a frame out of the interrupt and rewrites a few rows of **colorxlat**
in place. Each stage record carries a pointer at `+0xB8` to a list of `(row,
shift)` pairs; for each one, `sub_243AC` refills that row's sixteen palette slots
(luma 48..63) from the stage colour block read at an offset of `(frame_counter
>> shift) & 15`.

So a face keeps its colorbase, its lumabase and its texel, and still changes
colour. Four stages carry a list:

| stages | rows | rate |
|--------|------|------|
| South Island (0, 13, 14) and Canyon Cruise (4) | 18 (÷4), 19 (÷1) | 15 Hz / 60 Hz |
| slot 5 | 14, 16, 19 (÷2) | 30 Hz |

On South Island that is rows 18 and 19 — the colours the water's edge and the
waterfall in the ground chunks name. The sea plate itself names row 14 and is
untouched by this, which is why it needs the header trick above.

A dropped colour-table dump pins the tables and is left exactly as captured; the
rotation is only applied to tables built from ROM.

The **animate** checkbox pauses the whole thing. Everything above is a pure
function of `frame_counter`, and the viewer derives that from elapsed time
rather than counting rendered frames, so the palms sway at 30 Hz whatever the
monitor is doing. So is everything in the next section: the stage's objects run
off the same clock, and pause with it.

### The stage's own objects

A stage animates more than its draw list. `change_scene` hands the pointer at
`+0xB4` of the record to `object_init`, which walks a table of **objects** and
gives each one a pair of routines: an `init` that runs on the frame the stage
loads and is free to replace itself with a per-frame continuation, and a `disp`
that `object_control` calls once a frame, *after* the arena is drawn. Nine of
the sixteen records point at one:

| slot | stage | routines | what they are |
|------|-------|----------|---------------|
| 1 | Flying Carpet | `flying_carpet_init`, `draw_sphynx_head` | the flight, and the head that watches it |
| 2 | Aurora Icefield | `aurora_init` / `aurora_disp` | the curtain and its reflection, the sky and its own, the walrus statues and theirs, the floor, eight ice pillars |
| 3 | Mushroom Hill | `mushroom_init` / `mushroom_disp` | the canopy, the cap, the four cage rings |
| 4 | Canyon Cruise | `canyon_init` / `canyon_disp`, `canyon_env_*` | the boat's flight and the scenery it passes |
| 5 | Casino Night | `pinball_init` / `pinball_disp` | the blimp, the roulette, the slot machine, the cards |
| 6 | Dynamite Plant | `dynamite_init` / `dynamite_disp` | two chimneys, two gears, a swinging pair, a conveyor |
| 7 | Giant Wing | `giant_wing_*`, `propeller_dsp` | the plane's roll, its clouds, its propellers |
| 8 | slot 8 | `boss_init` / `boss_disp` | the Earth, a floor whose texture crawls, five panels wobbling |
| 9 | Death Egg's Eye | `post_metal_stage_init` | nothing: it is a bare `ret` |

`js/display.js` registers a port of each `disp` under **the ROM address the
setup table names it at**, not under a stage number, so a stage runs the
routines its own record asks for. They come out on their own `objects` layer,
which the panel toggles like any other.

Three clocks are involved, and telling them apart is most of the work:

- `object_cont` steps a counter at `+6` of every object once a frame, *after*
  calling that object's routine. An `init` that falls straight through into its
  own continuation therefore gets one step of it on the frame the stage loads,
  which is why every angle here stands at `frame + 1`.
- `pinball_init`'s continuation steps that same counter a second time, so Casino
  Night's `disp` reads `2(frame + 1)`. Read as a frame count, the blimp orbits
  at half speed.
- `dynamite_disp` and `boss_cont` keep counters of their own, and the tables the
  conveyor, the floating cards and the ice diamonds walk are indexed by the
  global `frame_counter` instead.

What the routines do, in the same terms as the frame tables above:

| what | how it moves | period |
|------|--------------|--------|
| Casino Night's blimp | `ang_y` then a translate, which is an orbit: radius 40 at height 20 | 2048 frames |
| its roulette wheel | stood up by an `ang_z` of `0xD000`, spun about its own Y | 128 frames |
| its three slot reels | `ang_x` at `0x400` a frame, starting `0`, `0x6000`, `0xB000` | 64 frames |
| its floating cards | one of 32 models a frame | 32 frames |
| Dynamite Plant's gears | two `ang_z` at ±250 a frame, turning opposite ways, starting `0` and `0x800` | 262 frames |
| its swinging pair | a float walking 0..5.4 in steps of 0.05, pinned at each end | 216 frames |
| its conveyor | one of 32 models every other frame | 64 frames |
| Aurora Icefield's diamonds | `ang_y` at `0x100` a frame | 256 frames |
| its aurora | not the model but its texture points: `v` back four raw units a frame | 512 frames |
| Giant Wing's propellers | `ang_z` at `0xD80` a frame, the blade drawn on alternate frames | 19 frames |
| its clouds | six Z positions walking in at 12.5 or 7.5 a frame, restarted at the far limit | 960 / 800 frames |

`stf-tools/test-objects.mjs` checks those rates, that the values that walk a range
come back to where they started, and that every model the routines name carries
geometry.

#### The aurora: texture points per frame

The curtain is model 1604, and it never moves. What moves is the texture on it,
and the mechanism is the ocean's one field over. `set_obj_thd` replaces a
model's texture **headers**, and walking the sea's lumabase carries its faces
from one luma band to the next; `set_obj_tpd` replaces its texture **points**,
and walking those carries the texture across the faces.

`aurora_init` installs a continuation that calls `move_tpd_req` once a frame
with the block at `0x758FC` and one 16-bit offset:

```
offset = ((0 - frame_counter) << 2) & 0x7FF
```

The handler that request selects is `tpd_move`, which copies the block into
geometry program memory adding that offset to the *first* short of every pair,
and `aurora_disp` hands what comes back to `set_obj_tpd` for both draws — the
standing curtain and its reflection. A texture point is `(v, u)` in that order,
the same order the model's own UV stream is in, so what slides is `v`: four raw
units a frame, which is **half a texel**. The wrap at `0x800` is one whole
256-texel tile, so it is seamless, and the cycle is 512 frames. On this model
`v` runs *along* the curtain rather than up it — hence a light that travels
sideways rather than a curtain that ripples.

The block is nearly a copy of the model's own thirty-six points, and where it is
not is the interesting part: on two of the nine panels the model's `v` runs the
other way, and the block turns them round. Left alone those two would scroll
against the other seven. So the viewer loads the override and decodes the model
against it, rather than sliding what the model carries — which also stands the
two panels the right way up on frame 0, before anything has moved.

#### Aurora Icefield draws its own ring, and nothing else does

The stage takes two skips no other record does, and between them the arena's
whole floor is `aurora_disp`'s business rather than the generic draw functions'.

`camera_init` reads `stage_floor` only when flag bit 2 is clear, and Aurora is
the only arena that sets it — the other of the two records that do is slot 15,
the attract movie's `ADV_MOV2` (Tails' lab) — so its 558, a 660-unit octagon with a square hole
in the middle of it, is never drawn. And `stage_dsp` compares the
slot against 2 on its second instruction and returns, before the per-stage
branches and before it has done anything with the `stage_platform` it has just
read out of the record. So 559 is not drawn there either.

What is left is `cage_sub_disp`'s four copies of `stage_extra` — model 1602, a
wedge that runs from an inner edge at `z = -6` out to a tip at `-264`, so four of
them on quarter turns tile the plane and leave a square hole of ±6 where the
fight happens — and, inside that hole, `aurora_disp`'s own 559 at
`(fs, 1.6, fs)`. Which is sixteen small quads of cracks and nothing else: the
ring has no surface of its own, and what shows between the cracks is the sky and
the curtain the same routine draws again through a negative Y. The ice is a
mirror because there is nothing there to be anything else.

Drawing 559 on the platform layer as well as on the objects one, as this viewer
did, only put those cracks in a fight with themselves.

#### The walrus statues

Model 1601 is a pair of ice-carved walruses on plinths, standing outside the ring
on the `+Z` side at `z = 13.6..20`, and 2319 is their reflection — the same shape
over the same bounds in 243 vertices against the standing pair's 447 — drawn
through the same negative Y as the sky's. Neither is scaled: both go up at the
matrix `object_control` leaves on the stack.

`aurora_disp` draws them only when bit 0 of `0x500288` is set, which reads like
game state and is not: that byte is the per-frame camera mask described under
[What is left out](#what-is-left-out), and bit 0 is the barrier panel the
walruses stand behind. They are drawn exactly when it is. From a camera that can
be anywhere the cull is left out, the same way the ice pillars' is.

#### The Death Egg: a card of the Earth, and a floor that crawls

`boss_disp` draws two things besides the five wobbling panels, and neither is a
model standing where it is modelled.

**The Earth is a card.** Model 1124 is a flat 16x16 quad — fifteen faces, no
depth at all — carrying one 256x256 tile off set 9. The routine hangs it at
`(-5750, -3190, 42000)` and scales it a thousand times, so what is on screen is
eleven thousand units of Earth forty-two thousand out, and it only reads as a
globe because of the command the transform ends with:

```
push
op 3          load the identity
ang_z/x/y     the arena's three angles, negated
translate     -5750, -3190, 42000
op 16         face the camera
scale         1000, 1000, 1000
set_obj 1124
pop
```

Two of those are ops nothing else in the viewer needed. **Op 3 loads the
identity** — the same one `draw_sphynx_head` builds its probe matrix with, which
is what pins it: the probe's answer is compared against where the two fighters
are standing, so it has to come back in the world's frame rather than the
camera's. **Op 16 faces the camera**, throwing away whatever rotation the matrix
has reached and putting the view's there instead. The code at `0x8A604` is what
names it: it tests one flag and emits op 16, tests another and emits an explicit
`ang_y` instead, so the two are alternatives. It is also what the Flying Carpet's
flames and Casino Night's floating cards are drawn through — flat things that
have to look round.

Op 3 means the board draws this in *view* space: a backdrop in the strict sense,
in the same place on screen whatever the arena does. The board's camera never
turns far enough for that to differ from a card standing in the world at the same
offset, and a free camera has to be able to turn away from it, so the viewer puts
it in the world. The billboard is kept — 8000 units of card seen edge-on is
nothing — and is the one transform in the viewer that cannot be composed when the
stage is built, since it depends on where the camera is standing.

**And it goes behind the horizon, which a depth buffer will not do for you.**
`doom_cnt` stands the horizon up as a ring of flat panels 120 units out, and on
every other stage that is the far wall — everything the game draws is inside it,
so the depth buffer sorts it correctly and the distance never signifies. The
Death Egg is the one stage with something beyond it, and 42000 loses to 120: the
starfield buries the Earth outright. What fixes it is saying to the depth buffer
what op 3 says to the board — that this draw is background rather than scenery.
It is submitted straight after the shells, ignores the depth they wrote, and
writes its own, so the shell cannot cover it and the arena still can.

Making the *shell* depth-neutral instead is the obvious alternative and it is
wrong: the shells really do stand around the arena at 120, and from a free camera
outside one, the near half of South Island's cloud ring is supposed to pass in
front of its island. Ordering the shells ahead of the rest is itself only an
ordering change — opaque draws that test and write depth come out the same in any
order — except where two of them tie exactly, and three stages have about sixty
pixels of seam where a shell's lower edge meets the ground at the same depth. So
the reorder is applied only on a stage that has something behind the shells,
which leaves every other stage's picture identical to the pixel.

**The floor's texture crawls.** Model 1165 never moves. `boss_init` installs a
continuation that calls `move_tpd_req` once a frame with the block at `0x72FC4`,
and `boss_disp` hands what comes back to `set_obj_tpd` — the aurora's mechanism
exactly, with one field moved. A request carries two 16-bit offsets, and
`tpd_move` adds the first to the first short of every `(v, u)` pair and the
second to the second. The aurora fills in the first and walks `v`; this one
fills in the second:

```
offset = ((frame_counter >> 3) << 5) & 0x7FF
```

so what walks is `u`, 32 raw units — **four texels** — every eighth frame. The
block's 192 points are the plate's 48 faces at four corners each, and the plate
is a 6x8 grid: `u` runs across the six panels in `z` and `v` across the eight in
`x`, one whole tile laid over the floor exactly once. So sliding `u` carries the
pattern along the plate, and the wrap at `0x800` — one whole tile, as the
aurora's is — lands where it started rather than on a seam. 512 frames, the same
cycle as the aurora's by a different route.

**And the far plane has to be told.** Framing a stage deliberately leaves the
backdrop layers out of its bounds, because a stage framed on those is an arena a
few pixels across — but the far plane comes off the same radius, and on this
stage that puts it at four thousand units and throws the Earth away entirely.
`Viewer.setReach` carries the whole draw list's bounds separately, and the far
plane covers those. Precision is governed by the near plane rather than the far
one, so this costs nothing that shows.

`stf-tools/test-objects.mjs` checks the card's transform and that it is a card, that
the block is the plate's own point count, and that `u` steps four texels every
eighth frame and comes back inside the tile.

#### Giant Wing banks the world

The plane is the second stage whose world moves, and it moves it the way the
Flying Carpet does — through the prologue, not through the arena.
`giant_wing_init`'s continuation keeps a counter at `0x50A026` and writes an
`ang_z` to `0x50A024` out of two sine terms:

```
roll = 411·sin(128n) + 133·sin(192n + 0x1234)      (16-bit angle units)
```

— about three degrees at the extremes, the two terms beating against each other
over 1024 frames. `0x50A024` is the roll every world-space draw's prologue picks
up, so on the board the horizon tips under a camera riding the wing. A free
camera wants the horizon, so the viewer hangs the scene on the roll's inverse and
the plane banks under it instead — the same argument, and the same
`stageWorldFrame`, as the carpet's.

`giant_wing_disp` draws the floor at `floor_stage_size_0`, pops it, and draws
everything after — the body, its haze and the six clouds — from inner slot 8
(`0x44` with 8, at `0x76E3C`), which `camera_init` stores as the world's
prologue at 1.6. So those take the roll the floor does not, and the clouds'
offsets are in that frame too, 1.6× as far out as their numbers.

#### Canyon Cruise flies the canyon

Canyon Cruise is the third stage whose world moves, and the only one that flies
a path rather than an equation. Its record hands `object_init` two objects: the
boat, whose `canyon_init` installs a continuation that runs `object_move` once a
frame, and the environment, whose `canyon_env_disp` draws the canyon itself. The
record carries no ground chunks and no floor at all — `stage_floor` and the
sixteen scenery slots are empty — so *everything* below the boat is the second
object's.

**The path.** `canyon_setup`'s third field points at a script of twenty keys, 28
bytes each: a type, the count the key starts on, a position, and an angle triple
that is zero all the way down. `object_move` walks it for the key the timeline is
inside and hands the coprocessor's `0x19003232` six numbers per axis — the
segment's length and how far into it the count has got, this key's value and the
next one's, and a slope at each end. That op is a cubic Hermite. `sub_71BCC`
measures each slope as `(P[k+1] - P[k-1]) / ((t[k+1] - t[k-1]) >> 5)` — a
thirty-second of the frames it spans, and an integer shift, so a 75-frame gap and
a 95-frame gap both count as two thirty-seconds — and the op scales both slopes
by a **thirtieth** of the segment it is running.

Thirty, not thirty-two, and it is worth pinning down rather than assuming: 32
there and 32 here would cancel to exactly the Catmull-Rom spline the keys look
like they are asking for, and that is not what the board does. Solving for the
scale against a recording of `stage_xpos` — `stf-tools/mame-canyon-path.py`, which
drives MAME into the stage and writes down what the game itself puts in the
prologue — gives 30.00 on every segment, to every digit the capture has. The
tangents come out a fifteenth long and the curve bows that much wider: with 32 in
its place the boat is up to half a unit off the board through every bend. With 30
the port reproduces the board's own position and heading exactly — to every digit
the capture carries — frame for frame, over every count it covers.

The timeline counts 1..0x784 and `canyon_init` snaps it back to 0x7E, so the ride
is 1924 frames — thirty-two seconds — and it rejoins *mid-canyon* rather than at
the start: the boat cuts 644 units back up the river on every lap. That is the
board's own loop, not an approximation of one.

**The heading is a table, not a calculation.** The continuation does build one —
the same `asin` of a normalised vertical part the carpet noses up by — and then
throws the result away an instruction later, overwriting it with a 16-bit angle
read from a table of one per count at `0x020D5BC4` in the *data* ROM and stored
negated into `0x50A022`. `0x50A024`, the roll, is never written.

**The fall.** `sub_71FD0` writes the `ang_x`: thirty frames of nose-down at 160
units a frame from count 0x5FA, twenty held, then thirty back up, landing exactly
on zero. The height itself comes off the curve at the same point — from 0x60F
`sub_71ED8` takes it over and falls it, and from 0x62A `sub_71F28` bounces it
four times as the boat lands, both by adding half a constant times the square of
a counter they step once a frame. That counter stands at ten when the fall
begins, on the first lap because `canyon_init` left it there and on every lap
after because the last bounce runs exactly ten frames.

**The canyon.** `canyon_env_disp` is the one routine in the game that draws in
the world's frame rather than the arena's: it loads the matrix `camera_init`
saved in the coprocessor's eighth slot — the prologue with the ground pass's 1.6
already on it — and hangs each piece off that with a translate. Its object list
is nineteen runs of `(model, position)` ended by `-1`, and `word_9D394` is
eighteen counts saying when one run gives way to the next, so the board draws
only the stretch of canyon it is passing and winds the list on as it goes. On the
loop it rewinds to the second run rather than the first.

A camera that can be anywhere wants the canyon whole, so the viewer draws the
**union** of the runs — a strict superset of any one frame's draws, and only
nineteen pieces: fourteen chunks about the origin and five more from the
stretches of canyon either side, offset by `±(330, ∓21.2, ±230)` inside the 1.6.
They come out on the `ground` layer, and the three river plates `canyon_env_disp`
draws through a per-frame texture header — `canyon_env_init` calls `move_tpd_req`
with band `7 + ((frame_counter >> 1) & 63)`, which is `send_st01_sea_thd` to the
letter — come out on `water`, walking the same luma bands South Island's sea
does. That is why the river flows.

**The boat goes into shadow.** The continuation keeps a scale at `0x530200`:
`canyon_init` puts `0x100` there, it walks two down a frame over counts
`0x4CE..0x513` and two back up over `0x596..0x5DB`, and every frame it hands the
current value to `material_part_chg` for material slots 4, 7, 13, 18 and 21.
`stage_dsp` does the sixth, 29, around the platform draw and puts `0xFFFF` back
afterwards — which on this stage is the same thing, because 29 is the boat's own
material, nothing else names it, and `0xFFFF` is what the record has in it.
`material_part_chg` interpolates each byte of a slot towards a base it is handed,
and the base here is zero, so a slot comes out `(byte * scale) >> 8` and `0x100`
is exactly the identity.

What dims is everything riding the boat, and not the canyon. Slots 4, 7 and 13
are the fighters — 13 is what 33030 of the 41818 faces in the character models
are drawn with, 7 and 4 the second colours of about half of them — and 18, 21 and
29 are the deck, its ring and its rail, with 13 again on sixty of the deck's own
faces. 52 of the canyon's 2520 faces are drawn with 18 and go with them;
everything else the canyon is made of is 19, 20, 22 and 31, and stays lit. So for
a hundred and thirty counts in the middle of the ride the boat and everyone on it
drop to 116/256 of themselves and come back — the shadow of what it passes under,
thrown on the boat and the fight rather than on the canyon. With no fighters in
the viewer, what shows is the boat.

**The backdrop rides along.** `doom_cnt` compares `stage_num` against 4 and skips
the translate outright on this one stage, pushing the three angles and nothing
else, so the horizon turns with the boat but travels with it. It has to: the boat
crosses six hundred units of canyon, and a ring left standing at the world's
origin would be off to one side by the end of the run.

`stf-tools/test-canyon.mjs` checks that the tables read as the routines index them,
that the curve passes through every key it is not falling through, that the speed
across a key does not jump — a kink there is the one way the Hermite's two
scalings could have come apart — that the loop rejoins where `canyon_init` snaps
back to, and that the world prologue really is the boat's frame inverted, the
same check `stf-tools/test-carpet.mjs` makes of the other stage that flies.

#### Two framings, and a checkbox between them

The prologue is the whole difference between the board's picture and the
viewer's, and it is one rigid transform, so both are available for the price of
deciding where to put it. The board draws these stages from the arena's frame —
the carpet still, the desert wheeling past — because its camera rides the
carpet. A camera that can go anywhere wants the opposite: the desert is the
thing worth standing on, so `setWorldFrame` hangs the whole scene on the
prologue's **inverse**, the world's draws cancel it and come to rest, and the
arena's pick it up and fly. No draw is rebuilt either way and nothing moves
relative to anything else.

**`ride the carpet` is the other choice, left at the identity.** The prologue
then stands where the ROM put it, the arena comes to rest and the world wheels —
the machine's own framing exactly. It is not a nicety: a moving arena cannot be
read from a fixed camera, because there is nothing to fix it to. The carpet flies
a lap every 2048 frames and crosses the whole frame doing it, so its ripple
could only be chased, never watched; held still it is plainly a travelling wave.
The checkbox appears only on the three stages that have a prologue at all —
`ride the carpet`, `ride the boat`, and Giant Wing's roll, which has no vehicle
to name.

Switching it carries the camera across. A point standing at `p` under the old
root stands at `D · p` under the new one for `D = new · old⁻¹`, and putting that
same `D` through the camera position, its orientation and the orbit target
leaves every pixel where it was. Turning it *off* is exactly that and no more:
back on the sand, looking at what you were looking at. Turning it *on* then
frames the camera on the arena — from the direction `D` has just carried it to,
so the angle is the one being looked from — because a toggle whose point is to
hold one thing still should leave you looking at that thing, and not at the
oasis sixty units away that is now the thing moving.

What the arena *is*, for that framing, is the `platform`, `cage` and `poles`
layers: the surface fought on and the ring round it, which on both flying stages
is the part carried along rather than the part flown over. Framing on the rest
would put the camera six hundred units out on the desert and leave the carpet a
speck.

#### What is left out

The routines also draw things out of state a viewer with no fight in it does not
have, and those draws are skipped rather than guessed at:

- **Mushroom Hill's spore puffs.** `mushroom_disp` walks a queue of twenty
  positions around the ring, filled by `sub_74680` from where the two fighters
  are standing.
- **The Death Egg's arms coming away.** Keyed to `0x500288`, which is not game
  state but a cull: the frame's own display function fills that byte in at
  `0x24E00` each frame, handing `0x24ED4` four `(x, z)` offsets at `(0, ±6)` and
  `(±6, 0)`, which transforms each into the camera's frame and sets that offset's
  bit on a sign test. `cage_clip_m` draws the barrier panel whose bit is set, and
  the second pass over Mushroom Hill's rings draws the ones whose bit is clear.
  `boss_disp` is the one routine that tests the whole byte rather than a bit,
  against 9 and 13 and the rest, and what it drops on those values is a panel at
  a time. A camera that can go anywhere wants all of them, so none of the culls
  are reproduced — the same call the ice pillars get.
- **Canyon Cruise's third river plate.** The override `canyon_env_init` builds
  for it does not only walk the band: it also moves that plate's tile from
  `0x700` to `0x03C0`, onto the same water the other two use. Only the band is
  reproduced, and the viewer draws the plate on its own tile.


### Fighting Vipers' stage objects (`js/fvobjects.js`)

Fighting Vipers keeps the same object table at `+0xB4` of the record and the same
`object_init` (`0x6AC74`) walking it, 24-byte entries `{type, RAM size, init,
disp, arg, address}`. Two things differ from the other game, and the port follows
them:

- **One clock.** There is no per-object counter at `+6`. Every routine reads a
  single u16 at `mod_fa_obj0+6`, stepped once a frame after the routines run and
  reset by `ROUND_INT`, which runs once a match (it sets round 1; the later
  rounds start at `SET_INT`). The viewer starts it over every 3600 frames, so
  the trucks and the planes come back.
- **One turn.** `object_control` draws all the objects under `ang_y` of
  `-word_50A022`, the stage's yaw. On the two Westerns (flags bit 16) `0x1EFA8`
  takes 10 off that word a frame, so the ground (`sub_238E4`), the `0x24` list
  (`ground_upper_disp`) and the objects turn by `10·f` while the platform
  (`sub_235BC` skips the turn on that bit) and the cage stand still: the town
  goes round the arena. That is the town seen from a camera that rides with
  the arena; the viewer's camera stands in the town, so it holds the town
  still and turns the platform, the cage and the poles the other way
  (`stageWorldFrame` in `js/display.js`), the light with them. The routines'
  culls see the camera turned into that frame.

The paths are `object_move_int`'s: 0x1C-byte keys `{u16 type, u16 frame, f32
pos[3], f32 ang[3]}`, read from the entry's `arg`. Type 0 holds, 1 is linear, 2
is Hermite (tangents from the neighbouring keys, scaled by span/30 with the
board's `>>5` integer divisor), 3 coasts on the last slope, and 4 stops.

| disp | stage | what it draws |
|------|-------|---------------|
| `0x6B260`, `0x6B4F4` | Factory | the machinery (`0x1B5` only while the camera is past `x = 8`), and four walls pushed out to the arena, each shown while the camera is outside it |
| `0x6B7BC`, `0x6C198` | Airport | two planes on paths, one taxiing with its gear down, one taking off over the arena and folding its gear; their shadows and the arena decal, all skipped while the plane is off screen; the still buildings |
| `0x6C49C`, `0x6C400` | Western, Western 2 | the bear on its integer pendulum, culled when it faces away, and its hop |
| `0x6C67C` | City Hall Elevator | the lights outside, a three-group flipbook on `f & 0x7F`, and the shaft's walls, both sliding down 0.017 a frame so the car seems to rise |
| `0x6CAF8` | Bay Side | sixteen still models |
| `0x6CCE0` | Observation Deck | a still model and two spinners, `0x60` a frame |
| `0x6CF38`, `0x6E908` | Tower | the lights on four sides (fade up, hold, fade down), and the helicopter, its glass sliding a reflection |
| `0x6D0C4`, `0x6D2FC`, `0x6D6E4`, `0x6DAC0`, `0x6E3F8` | UFO Diner | the sign blinking and flickering, the cab and the Pepsi trailer on their paths with steered and turning wheels, the trucks passing on the road, the UFO turning |

A few signs and the trucks' cabs are picked by the test menu's COUNTRY byte
(backup `+0x3350`): 0 is Japan's, anything else the overseas model. The panel's
Region sets it.

The helicopter is the one routine with state of its own: `0x6E5BC` picks the
heading on a circle of radius 15 that puts it in front of the camera, and a
bang-bang controller steps the turn rate towards it, banking and leaning as it
goes. The port is the same integers, run forward from the match's start with the
camera as it stands. `sub_6EC0C` then slides the glass's texture points by where
the helicopter sits in the camera's view, a fake reflection.

The bear's hop is a fight's: `kuma_int` fires it when a fighter is knocked out
into the wall segment in front of it (`finish_wall_flag` bit 23, segment 20).
Here the camera coming within 4 of the bear while it is drawn stands in for
the fighter, once a session; the hop is the board's single-precision bounce,
217 frames.

The draws land in the geometry processor's window slots (`0x50183C +
8·(w-1)`), as the other game's do: most objects in window 2, the plane decal and
the elevator lights in 1, the plane's shadow in 3, the bear's second model in 5.
With no flat plane between them a depth buffer orders those the same, so the
viewer keeps its depth sort and only the Airport's decal and shadow, which lie
in the ground, take a plane bias for their window: the decal over the floor, the
shadow over the `0x24` list.

#### What the stage does round the objects (`js/fvstages.js`)

`camera_control` builds the light every frame from `VECTER_Y`, and four stages
move it: the Westerns turn it 10 a frame with the town; Bay Side takes the
camera's yaw; the UFO Diner swings it to whichever truck's headlights face the
arena, and scales material slot 26 with them; and the Observation Deck points it
at its lit corner. That deck lights one corner at a time, a new one every 128
frames with a 12-frame fade out and a 9-frame fade in (`hall_stage_cont`), and
the corner picks the platform (`0x2369C`), the poles (`0x23014`), the cage
panels (`0x22908`, or `0x22948` while it fades) and which colour channels of
colorxlat go a shade down (`change_color_table`).

The City Hall Elevator's ride is `stage_ypos`, 0.017 a frame, and every reader
of it is drawn: the ground sixteen; the shaft `tou_disp_all` builds from two
tables of heights and wall models (`0x6CE2654`, `0x6CE3214`), each side shown
while the camera is inside its plane; and the four city panels `tex_move_poly`
draws, whose texture `set_tpd_data` slides by the tangent of the camera's
bearing off the panel's, a parallax. The board never resets `stage_ypos` but at
`change_scene`; the viewer starts it over with the objects' clock.

In the fight the shaft is a band, not the whole of it (read from the ROM,
checked against MAME). Stage 6's branch of `ground_upper_disp` (`0x23ACC`)
takes `tou_disp_all` (`0x23B2C`) unless the game mode is GAME (`0x50002C` =
`1 << 0x50002A`, bits 8-9: GAME_INT, GAME_DSP) and the sub-mode is FIGHT_INT
to JUDGE_DSP (`0x500034` = `1 << 0x500030`, `& 0x3F00`). Then `0x23E08`
draws instead, with no clip tests and without `tou_disp_all`'s
`0x23784(0x6CE2C40)` call, which the explorer never drew:

- four wall rows (`0x6CE2654`), from the last one at or below
  `stage_ypos - 14`, searched from entry 1 and at most to entry 27;
- two pillar rows (`0x6CE3218`), from the first whose `+0x28` is above
  `stage_ypos - 42`, at most entry 7.

Each row keeps its side test (`tower_check`, `hashira_check2`). `stage_ypos` is
`0x50A018`, which `0x1EFC0` steps by 0.017 (the same word the shaft is moved
down by). The round's intro, the replay and the win draw the whole shaft, and
so does the attract demo, which runs in mode ADV. The explorer treats the fight as
under way, so `shaftBand` in `js/fvstages.js` hides every row outside the band
at the viewer's `stage_ypos`. From inside the shaft the camera now sees four
wall rows and two pillar rows round the arena, not the whole 224-unit tower.

The check:

- MAME (`fvipers`, coined game, `0x500064` forced to 6, 200 s) took
  `0x23E08` on every FIGHT_DSP and JUDGE frame, and `tou_disp_all` on the
  others. The starting rows it picked, logged with `stage_ypos` at the draw,
  match `shaftBand` on all 2487 draws (`stage_ypos` 3.38 to 26.91, wall
  rows 0-2, pillar rows 0-1). In 240 s of attract on stage 6, every draw
  was `tou_disp_all`.
- In the headless explorer on the City Hall Elevator, from frames 397 to 1135,
  20 of the 132 shaft draws are shown, at the heights the band gives: rows
  1-3 and pillar rows 0-1, then rows 1-4 and pillar rows 1-2 once
  `stage_ypos` passes 14.

The stage music is `level_music_list`'s song, and the stage sounds are
`sound_queue_output`'s: the loop each stage starts with and, on the Airport and
the UFO Diner, cues on the objects' clock.

The Airport's jet is set by the planes' routine, behind its screen test, so it
goes off only if a plane is on the screen on that frame. `0x6B7BC` projects
four points round the plane, ANDs their outcodes into `r3`, and at `0x6BAE0`
branches to its end (`0x6C194`) if they are all off one side; only past that
does it read the objects' clock (`[0x500870]+6`) and, on 448 (`7 << 6`), set
bit 15 of the sound flags at `[0x50085C]` (`0x6BAF8`), which `sqo_airport`
turns into `0xAE1159`. Both planes run the routine, so either one on the
screen sets it; with both off there is no jet that round. The explorer
already has that test (`planeOnScreen`, the one that hides the planes, their
shadows and the arena decal), so the decal's draw carries `jetCue`, and the
stage sounds ask it (`jetShown` in `js/app.js`) on frame 448 with the camera
as it stands, before sending the cue (`FV_SCREEN_CUES`,
`js/sound/ambience.js`).

The check:

- MAME (`fvipers`, coined game, `0x500064` set to 3 at `change_scene`'s read
  of it, `0x21750`, so the fight's objects are the Airport's; the clock put
  back from 470 to 380 so 448 comes round again under a later fight
  camera), 36 passes of 448: `0x6BAF8` was reached by exactly the planes
  whose test passed (`r3` = 0). Both planes on the screen 3 times, only the
  taxiing one (type 0) 18, only the one taking off (type 1) 6, and neither 9
  times (`r3` 1, 2, 5 or `0x1F`), with no jet set.
- Headless explorer on the Airport, camera at the arena turned eight ways at
  clock 448: two planes carry the gate; turned five and six eighths round
  neither is on the screen, and the others show one or both. With a stand-in
  sound board, facing away sends only the stage loop (`0xAE115A`) through
  frame 481; facing the planes sends the loop and `0xAE1159` at 448 (seen on
  the first timer tick after it, 453). No page errors.

Left out:

- the per-entry clip tests of the shaft and the panels, which are culls.

### Character rigs (`js/characters.js`, `js/pose.js`)

`CHAR_PARTS` at `0x000C5268` points at one 48-byte record per fighter:

| offset | meaning |
|--------|---------|
| `+0x00` | part table — 32 model ids, 16 normal + 16 hammer-squished |
| `+0x04` | skeleton table — 16 `(x, y, z)` float offsets, but see below |
| `+0x0C` | animation table — 52 motion ids |

The second sixteen are not a distance LOD. They are the flattened meshes the
fighter wears after a hammer hit, which is why the Animation panel's **hammer
squished** checkbox swaps the whole rig at once rather than fading in with
distance.

#### The skeleton is a state, not a field

`calc_rob_angle_int` at `0x2EF38` does not read the record's `+0x04`. It reads
`SKELETON_TYPE_DATA` at `0x000C2068` — four per-character skeleton tables — and
indexes it with the fighter's current skeleton type, `p1_skeleton_type` at
`P1_PARTS+0x84C`, before it takes a single offset:

```
skel  = SKELETON_TYPE_DATA[type][char]
parts = type <= 1 ? record[0] : type == 2 ? record[0] + 64 : record[0x08]
```

so the meshes and the skeleton switch together. **Type 2, the squished form, is
a whole second skeleton and not a scale on the first**: every bone length is
halved while the lateral offsets stay where they are, which is what flattens a
fighter without narrowing him. Sixteen of the seventeen are halved along every
bone to within 1%.

The type reaches that byte from a motion — `set_mot_dat` copies byte `0x0C` of
the `mot_list` record into it — but it is a property of the **fighter** and not
of the move. The two bytes IDA names `sonic_skeleton_type` and
`bark_skeleton_type` sit on the records of motion 278 and motion 128, which are
Sonic's own stance and Bark's, so `js/characters.js` reads the type once off
each fighter's stance — action slot 0 of its own animation table — and keeps it.

That lookup is what gives every roster entry its own rig, which matters most for
the ones that are not fighters: the Final Eggman Boss lands on `model_floats_8`,
its own and nothing else's. Whether 0 or 1 comes back barely matters — those two
tables in `SKELETON_TYPE_DATA` are byte-identical across all 52 entries — but
going through the array at all does, since the record's own `+0x04` sends
Knuckles to Sonic's bones and the separate array at `0xC2058`, which a type-0
*motion* drops `calc_rob_angle_cont` onto, has a type-0 table that sends
*everybody* there. That fallback is real, and it reaches 43 of the boss's 52
action slots — the other nine being the type-2 squished ones every entry
carries. But the viewer plays any motion on any entry, which is what it is for,
so it resolves the type once off the stance and draws each fighter on its own
bones whatever is playing; following the motion's type instead would put most of
the cast on Sonic's.

The record's own `+0x04` is not a substitute for the type-0 entry either. It
agrees for most of the cast and not for **Knuckles**, whose record points at
Sonic's skeleton at `0xC2558` while his type-0 entry is his own, `0xC2AF8` —
narrower hips, and every offset rounded differently. `stf-tools/test-motion.mjs`
pins that one by name, since a rig built from the record alone looks right and
is somebody else's.

A fighter is sixteen parts on sixteen slots, and the two tables share that
numbering: part `i` is drawn on slot `i`. Slots 0 and 9 — the waist and the
pelvis — carry no mesh of their own.

| slot | | slot | | slot | |
|---|---|---|---|---|---|
| 0 | waist | 6 | right upper arm | 12 | left foot |
| 1 | chest | 7 | right forearm | 13 | right thigh |
| 2 | head | 8 | right hand | 14 | right shin |
| 3 | left upper arm | 9 | pelvis | 15 | right foot |
| 4 | left forearm | 10 | left thigh | | |
| 5 | left hand | 11 | left shin | | |

The skeleton table is read on the same numbering, and what a slot's entry means
depends on where it sits in the chain: slot 1 is the chest-to-head step along
the chest's own `+X`, slots 2, 5, 9 and 12 are the pivots the four limbs hang
from, and the rest are bone lengths — which is why every limb mesh is as long
along `+X` as the slot before it says it should be.

The eyes are not on the skeleton. Each fighter has a default face record, from
`FACE_TABLE` at `0x000C533C`, and the record packs its model ids as `u16` pairs:
`+0x04` the head, `+0x08` the two eyes. Sonic's are 217 and 218, Tails' 209 and
210, Honey's 3520 and 3521; Eggman and the robots have zero there and no
separate eye objects at all. They are ordinary models drawn on the head's own
matrix, in the head's space, so they follow it with no slot of their own — which
is why `js/app.js` hangs them off slot 2 alongside the head's mesh. Super
Sonic's record carries `0x8000` rather than a model index, so anything outside
the model table reads as "no object" rather than a lookup.

The record carries the eyes' texture points as well as their model ids: `+0x10`
and `+0x14` point at blocks in the shape `move_tpd_req` uses — a count, a word
length, then (v, u) pairs — each exactly as long as the stream its eye model
walks, and the eyes are drawn from those rather than from the points inside the
model. Mostly the two are the same data: of the 668 (record, eye) pairs the
variant tables reach, 602 are byte-identical. Sixty-six are not. Amy's move by
1.9 texels on average and Bark's by under one, but Espio's second eye, model
1183, keeps every u and shifts v by 30 texels on average and 124 at the worst,
which is a different part of the eye sheet rather than a nudge. A block belongs
to an eye model and not to an expression — a record naming the same eye names
the same block, and a fighter changes expression by swapping the model. The
routine that hands one to `set_obj_tpd` has not been read; what says they are
the eyes' points is that each sits in the eye's own record, is the eye's length,
and agrees with the eye everywhere it has nothing to correct.

That record is one of twenty-one. `0x000C540C` is an array of pointers to face
tables, each the same 52 entries indexed by character, and `FACE_TABLE` is a
copy of entry 0 — the routine at `0x1B2FC` picks a variant with `ld
0xc540c[r3*4], r5`, indexes it with the character number, and reads the ids from
`+0x04` on. So the base table is not a twenty-second: it is entry 0 under another
name, and the other twenty name heads and eyes that appear in no part table:
model 3580 is Honey's head with her mouth open, reached only through variant 12.
The viewer does not draw them — it reads them, in `faceVariantModels`, to know
they are the rig's, because a head the fighters wear is in texture set 1 like
the rest of the rig and should be shaded through the ramp rather than flat. All
324 of them decode, and 233 are named by no part table.

### The animations that are not bodies

A body is a tree of parts played by a baked motion, and everything in
`js/bodies.js` is about that. The game's other animations — the blood, the
breaking glass, the water, the drifting rubbish — are not that at all. They are
*objects*, and this section is what has been read of them so far. None of it is
implemented; it is written down because finding it was the work.

#### What they are

An effect animation is a **run of consecutive model numbers stepped one a
frame**. The same trick the draw callback plays for Tom's coat and the Devilons'
wings is how the whole effect system works, and the model names give the runs
away — a family ending in three digits, contiguous in the table:

| models | count | name | what it is |
|---|---|---|---|
| 6–35 | 30 | `PN_akabushu###a` | 赤 *aka* red + ブシュ *bushu* spurt — the blood spray |
| 1417–1446 | 30 | `PN_shoubushu###a` | 小 *shou* small — the lesser spurt |
| 1130–1187 | 57 | `PN_nikubaan###a` | 肉 *niku* flesh + バーン burst |
| 4529–4648 | 120 | `PN_niku_###` | the flesh chunks |
| 2602–2632 | 31 | `PN_suiteki###a` | 水滴 *suiteki* water droplet |
| 2250–2309 | 60 | `PN_hamon###a` | 波紋 *hamon* ripple |
| 3451–3549 | 99 | `PN_gara6_###a` | ガラス *garasu* glass, shattering |
| 3092–3191 | 100 | `PN_madogaa###a` | a window going in |
| 736–785 | 50 | `PN_item_kira###a` | キラキラ *kirakira*, an item's sparkle |
| 4802–4901 | 100 | `PN_fuuu###a` | |
| 522–611 | 90 | `PN_gee0a###a` | |
| 879–948 | 70 | `PN_kibako_dam###a` | 木箱 *kibako* crate, breaking |
| 1674–1743, 1744–1813 | 70 each | `PN_taru_yoko_###a`, `PN_tarun_dam_###a` | 樽 *taru* barrel |

The gore colour finds the bloody ones on its own. Palette index 1023 is the one
the test menu switches between red and green, and 1520 models name a colour in
its range — among them every `_dam` body part's wound, and `akabushu`,
`shoubushu` and `nikubaan` whole.

#### How one is spawned

The stage scripts already carry them. `js/placements.js` walks a script for the
two opcodes it needs and steps over the rest; four of the ones it steps over —
9, 10, 11 and 12 — are spawn lists. Each is the opcode, a `-1`-terminated list
of pointers, and each pointer names a **40-byte record**.

The record's shape is the spawner's, not what the fields look like from outside.
`sub_30670` reads it whole:

```
ld   (r9), g4             ; +0x00 is the object's CLASS
ld   off_AFDD0[g4*4], g0  ; which picks the routine that opens the task
call _TaskOpen
ld   4(r9), g4
st   g4, 0x58(r8)         ; +0x04 is flags
ldob 0x24(r9), g4
stos g4, 0xCC(r8)         ; +0x24, a byte, is the object type
ldos 0x20(r9), g4         ; whose low two bits say how the position reads
addo r9, 8, g13           ; the position is three floats at +0x08
ld   0x14(r9), g4
st   g4, 0x2C(r8)         ; and +0x14, +0x18, +0x1C are the angles
```

Two fields decide whether a record stands a prop anywhere, and they are not the
same field.

**+0x00 is the class.** It indexes `off_AFDD0`, a table of the routines that
open a task, and only one of them — `sub_389E0`, at index 0x80 — is the generic
object that goes on to draw a type's model out of the tables below. The rest are
the doors, the bodies, the effects and the waves, each with its own task. Every
other field is filled in the same way whatever the class, which is exactly why
they all looked like props: a record of class 0x8B has a perfectly good type
byte and a perfectly good position, and stands nothing. Of the 993 records the
four chapters' scripts reach, **238 are of the generic class and 181 of those
are props**.

That one gate is what put the two bookcases in the courtyard. `PN_book_tana` is
a bank-6 model and the courtyard is set 1, so it could not have been drawn there
at all; the records that named it were of another class entirely. With the gate
in, every prop of every stage is either from the shared bank 0 or from a bank
whose own set is the one it stands under — 182 and 146 of 328, and none left
over. That is the check the hardware makes on its own: sheet 0 holds the shared
bank always, sheet 1 holds one set at a time.

**+0x24 is the type.** The first word is not it — which is why its values range
to 191 while no object table holds that many types, and why reading it as the
type made a third of the spawns look like they belonged to a type space nobody
could find. There was no such space.

**+0x14, +0x18 and +0x1C are the angles**, copied word for word to the task and
counted as the scenery's turns are, a whole circle to 0x10000. All but six of
the props that carry one carry yaw alone, and nearly all of those are a quarter
turn: the corpses on the courtyard lawn lie at 281° and 56°, which is what puts
them across the path rather than along it.

The position reads three ways by the low bits of +0x20, and **every prop record
uses mode 0** — three plain floats at +0x08 — so the other two are the effects'
and need not be implemented to stand the furniture up.

Reading it right puts the props on the floor. Over the first chapter the median
prop stands at y = -20.8 against a floor at -24.5; taken from the first word the
median was 0. The prototype says the same: 331 props where the wrong field gave
109, and they come out as barrels, chairs, tables and pots rather than
forty-two ladles.

Over the finished game's four chapters there are **1246 such records naming 118
distinct types**, and the counts are the shape of a game: 273 of one type, 170
of another, and a long tail of ones and twos.

#### The object table

The type indexes a table at **0xAC2D0 on a 76-byte stride**, which the object's
own init reaches with `ldos 0xCC(r4), g6 / mulo g4, 0x4C, g4 / ld unk_AC2FC(g4),
g4` — the base plus 0x2C. Its first word is a model number, and read that way types
0 to about 122 come out as exactly what a house is full of — `PN_isu` chairs,
`PN_tabul` tables, `PN_tokei` a clock, `PN_sitai` a corpse, `PN_sara` plates,
`PN_nabe` pots, `PN_tarun_dam` a breaking barrel, `PN_niku_001` the flesh, and
at type 59 `PN_moon`. (The moon turned to the camera is another class, 0x13;
see **Standing the props up**.)

Every type resolves there. The ones that appeared not to were records of another
class, whose first word was never a type at all.

#### The size a prop is drawn at

A prop is not drawn at the size its model decodes to. `sub_417F0`, which every
generic object runs first, copies the type's float at **+0x28** into the task at
+0x94, and the draw hands it to the matrix on all three axes:

```
lda  0x9801313, g9       ; the command
ld   0x94(r4), g4        ; the type's scale
st   g9, 0x80(fp)
st   g4, 0x84(fp)        ; x
st   g4, 0x88(fp)        ; y
st   g4, 0x8C(fp)        ; z
ldq  0x80(fp), g8
stq  g8, 0x884000
ld   0x54(r4), g0        ; the model
call sub_14120           ; draw
```

Which is the same shape as the effects' own draws — the small blood spurt builds
the identical command with `lda 0x3E800000, r5 / mov r5, r6 / mov r5, r7`, a
quarter on each axis, and that constant is what named the field.

Across the seventy-three prop types the scale runs **0.25 to 1.5** and fifty of
them are exactly 1.0, which is why it hid for so long: the corpses, the crates
and the chairs are all 1.0 and looked right. The ones that are not are the ones
that showed — `PN_test_tubo01a` at 0.5 and `PN_test_tubo02a` at 1.4, the vases
that stood as tall as the corridor they line; `PN_honeatama` at 1.5;
`PN_book_tana` at 0.8; and `PN_moon` at 0.25, which takes the moon from a radius
of 170 to 42 and out of the audit's "bigger than a quarter of the room".

The field was found the way the class was: `sub_417F0` reaches it with a
register-relative `ld 0x28(g4), g4` after `lda unk_AC2D0(g4), g4`, so unlike the
absolute forms it leaves no literal in the ROM to search for — it only turns up
by reading the routine.

#### An object, and what animates it

An object is a task. Its handler is the task function, the model it draws this
frame is the word at **+0x54**, and its type is the halfword at **+0xCC** — the
same field a body uses for its body number, which is why the draw callback and
these read the same offset.

The small blood spurt is the whole system in two routines. `sub_429A0` opens a
task on `sub_44250` and writes 1417, `PN_shoubushu000a`, into +0x54. Then every
frame:

```
lda  0x54(g0), g0      ; the current-model field
ld   (g0), g4
addo g4, 1, g4         ; one model on
lda  unk_5A7, g7       ; 1447, one past PN_shoubushu029a
st   g4, (g0)
cmpibne g4, g7, ...
call loc_150D0         ; the end: close the task
```

Thirty frames and it is gone — a one-shot, not a loop. It draws at a quarter
scale (`lda 0x3E800000`) on the position it reads out of its parent object, and
what spawns it is the flesh-chunk handler: a chunk lands, and a spurt is opened
where it landed.

The chunks themselves loop instead. Their handler steps +0x54 the same way from
4529 and wraps at 4649 — `lda loc_11B0+1` and `lda 0x78(g6)`, the base and the
base plus 120 — so they tumble for as long as the chunk lives.

#### Standing the props up

The furniture is not placements and never was, which is why a room read as an
empty shell. A placement is a chapter's scenery table; a chair is an object the
stage scripts spawn, and the four spawn opcodes were the ones the script walk
stepped over.

So the walk reads them now. It already visits every opcode and already tracks
which texture set is loaded as it goes — the same variable the zones are grouped
by — so a prop lands in the stage whose section spawned it, under the set that
section had loaded, with no new traversal. The type goes through the object
table for its model, the position is taken from the record, and nothing is
turned, because the word that looked like an angle is a flag.

Where the table is, and what is in an entry, is worth getting from the routine
that builds an object rather than from what the fields look like. `sub_417F0`:

```
ldis 0xCC(g0), g4      ; the type
mulo g4, 0x4C, g4      ; 76 bytes an entry
lda  unk_AC2D0(g4), g4 ; the table
ld   (g4), g5          ; the model is its first word
st   g5, 0x54(g0)      ; and becomes the object's current model
```

The model is at 0 and the sound is at 68 — and 68 is why the handlers are seen
reaching the table as `unk_AC314`, which is its sound field, not its head.
Reading the head as the sound and the model as 8 past it is off by exactly one
entry: every type then draws the *next* type's model, which is how the first
chapter's courtyard came to be full of room 4's walls.

Type 0 is nothing: its entry names `PN_space` and its slot in the handler table
is a null pointer.

Not every type is a prop, either. Each has a handler, and 77 of the finished
game's 125 share one — the routine that draws the table's model where the object
stands and does nothing else. The rest are their own things, and only the types
on the shared handler are stood up, and only for records of the generic class.
The others are left out rather than guessed at, but for seventeen handlers.

The first is room 4's walls and shutters: types 97 to 101 (models
`PN_r4_04_00a`, `_01a`, `_01b`, `_02a`, `_02b`) share the handler 0x3E510 in
the first revision (`hotdo`). Its init clears the byte 0x53E871. Its task closes
as a prop's does (0x3ED60), switches on `type - 97`, and draws through 0x413B0,
the prop's own draw command for command: place +0x20, turns +0x2C, +0x30 and
+0x34, scale +0x94, model +0x54. Before the draw:

| type | model | what it does |
|---|---|---|
| 97 | `PN_r4_04_00a` | +0x30 (the yaw) += 0x80 every frame; once 0x53E871 is set, y drops 0.4 a frame to 54 |
| 98 | `PN_r4_04_01a` | once 0x53E871 is set, z rises 0.25 a frame to 2077.6 |
| 99 | `PN_r4_04_01b` | once 0x53E871 is set, z falls 0.25 a frame to 1977.6 |
| 100 | `PN_r4_04_02a` | while 0x53E871 is clear and event flag 0x70 (0x51E330) is set, yaw += 0x50 a frame; past 0x9FFF it sets 0x53E871 |
| 101 | `PN_r4_04_02b` | while 0x53E871 is clear and flag 0x70 is set, yaw -= 0x50 a frame |

Flag 0x70 is one byte of the event flags at 0x51E2C0, which objects set when
the player sets them off (0x48AC), and two scripts set it with op 88 (0x67830).
The one at 0xFD1BC is the script that spawns the five, chapter 4's section 4,
script 1, which the walk reaches: but it comes some 0x5AA camera frames into
zone 8, after the op 83 and op 84 waits, and the explorer runs no clock inside a
zone. The one at 0xF94BC is in chapter 3 (section 3, script 11, and section 4,
script 8), which spawns none of the five. So the explorer stands the five where
they are spawned, and turns 97 0x80 a frame while animate is ticked; the gate
opening after the flag is left out. Chapter 4's section 4,
script 1 spawns them (records 0xFD8D0 to 0xFD990), and so does the attract
demo's. Checked in MAME (`hotdo`, attract, a breakpoint on 0x413B0 for these
types): all five drawn 1448 frames each at their records' places and turns,
97's yaw stepping 0x80 a frame from 0x80, and flag 0x70 never set. Revision A
moved the handler, and its program chips are not to hand, so its profile leaves
these out. The prototype's table stops at 77 types and has no such handler.

The second is the glass cases and the roof pieces: types 30 and 31 (both
`PN_case00a`, 0x13CD) and 86 (`PN_s3_rf_kop01a`, 0x1922, scale 0.7) share the
handler 0x3B050. Its task closes as a prop's does (0x3ED60) and draws through
0x413B0 with the model and scale 0x417F0 gave them, so standing they are props.
Each watches an event flag: 31 flag 5, 30 flag 6, and 86 one of 0x50 to 0x54,
picked by its x (505, 515, 532, 549, 557.9). Once its flag is set it throws
shards (0x3F210) and draws its second model: 30 `PN_case01a` (0x13CE), 31
`PN_case02a` (0x13CF), 86 `PN_s3_rf_kop_dam01a` (0x1923). Flags 5 and 6 are set
by an object (0x90848), never by a script. Chapter 3 spawns the roof pieces in
zone 14, and script op 88 sets 0x52 to 0x54 later in that zone; 0x50 and 0x51
come only from shots. The explorer runs no clock inside a zone, so all seven
stand as they are spawned and the break is left out. The cases are chapter 2's
section 5 and 6 records 0xEF000 and 0xEF030 (Stage 2 · set 7); the roof pieces
are chapter 3's section 3 and 4 records 0xF9A80 to 0xF9B40 (Stage 3 · set 9).
Checked in MAME (`hotdo`, the attract demo's scene table at 0xAB0D0 pointed at
each scene, a breakpoint on 0x413B0 for these types): both cases drawn 1000
frames each at (902.5, -5.2, 435.2) and (902.5, -5.2, 461.2), turns 0 and
0xC000; all five roof pieces drawn at their records' places, turn 0, scale 0.7,
for 31800 frames into section 5 with their flags clear, so the demo never breaks
them. Revision A's profile leaves them out, as it does room 4's; the prototype
has no such handler.

The third and fourth are two props that animate: type 104 on 0x3E8B0 and type
108 on 0x3E8F0. Each closes as a prop's does (0x3ED60), adds one to the model
at +0x54 and draws through 0x413B0. 104 goes back to 0x1859 once the model it
stepped from is past 0x185B, so it loops `PN_kakaaa01a` to `04a` (0x1859 to
0x185C), four frames; 108 goes back to 0x10E4 past 0x1114, so it loops
`PN_pushukeke00a` to `49a` (0x10E4 to 0x1115), fifty. Nothing stops them,
so the explorer steps them a model a frame while animate is ticked. Chapter 4's
section 0, script 1 spawns two 108s (records 0xFBF80 and 0xFBFB0, Stage 4 ·
set 4: steam rising from a vent), and sections 2 and 3, script 2 spawn five
104s (0xFCB00 to 0xFCBC0, Stage 4 · set 9: flames standing on the floor's
lit pads). Checked in MAME (`hotdo`, the attract scene table pointed at chapter
4's sections 0 and 2, a breakpoint on 0x413B0 for these types): the two 108s
drawn at (-1.5, 18, -15) and (-1, 24, 74) and the five 104s at x -126, y 0, z
1461.4 to 1866.0, all turned 0 at scale 1, as the explorer has them. Every
draw is the model before it plus one, wrapping where the handlers say, over
1619 draws of each 108 and 1062 of each 104; the five 104s keep in step.
The 108s do not start together: after 0x417F0, the spawn's per-type cases
(0x38A1C) give type 0x6C the number 0x33B00 returns, rem 49 (0x38AE4), added to
its model, so each steam starts somewhere in its loop. In MAME both spawns write
0x10E4 and the store at 0x38AF8 then makes one 0x10E4 and the other 0x110E; another run gave
them 8 apart. Type 0x68 has no case there, so the five 104s all start from
0x1859, as drawn. The explorer has no such number to take, so it starts both
108s from the type's model, in step.

The fifth is type 69 on 0x3D860, which steps +0x54 the same way, back to 0xA06
once the model it stepped from is past 0xA21: it loops `PN_powa00a` to `29a`
(0xA06 to 0xA22), twenty-nine frames, and draws through 0x413B0. It does not
close as a prop does. It closes (0x150D0) once the zone's clock at 0x51E51C
passes the float at +0x30C, which the spawn's per-type cases set by section
(0x38A7C): 99 in section 3, 268 in 9, 1048 in 11 and 12. Those are the sections
that spawn one: chapter 1's section 3, script 5 (record 0xE1750), section 9,
script 7 (0xE69E0) and the script sections 11 and 12 share (0xE7FD0), all in
Stage 1 · set 1. The explorer runs no clock inside a zone, so the three stand
and loop as spawned, while animate is ticked. Checked in MAME (`hotdo`, the
attract scene table pointed at chapter 1's sections 3, 9 and 11, a breakpoint
on 0x413B0 for type 69): each drawn at its record's place, (18, -23, -576),
(-126.6, -73, -91.7) and (-343, -76.5, 537), turn 0, scale 1, for 68, 503 and
177 frames, every draw the model before it plus one and wrapping at 0xA22, until
the clock passed 99, 268 and 1048 and the task closed. The board's first draw
is 0xA07, the handler having stepped once; the explorer's is the type's model.

The sixth is type 96 on 0x3E4A0, `PN_koba01a` (0x15C2), a fan. It closes as a
prop's does (0x3ED60) and draws through 0x413B0 with the type's model, but
first turns its third angle: +0x34 += +0x31C. While the zone's clock (0x51E51C)
is short of 1440 it sets +0x31C to 0x800; after that, an object standing past
x 500 takes 4 off it a frame until it stops, and one short of 500 keeps
turning. The spawn's per-type cases (0x38A1C) have none for it. Chapter 3's
section 1, script 8 spawns two (records 0xF7000 and 0xF7030, Stage 3 · set 8),
at x 443.7 and 545.7, the second a turn of 0x2000 on. The explorer runs no
clock inside a zone, so both turn 0x800 a frame while animate is ticked, as
they do from their spawn; the second's slowing down is left out. Checked in
MAME (`hotdo`): the attract demo's path through that section never runs
script 8, so with the scene table pointed at chapter 3's section 1 and the
section's script 1 read as script 8 (0xF5BC4), a breakpoint on 0x413B0 for type
96 showed both at (443.7, -240.7, 850) and (545.7, -240.7, 850), scale 1, the
third angle 0x2000 apart and 0x800 more on every one of 1226 draws, the clock
going from 731 to 870. The board's first draw is the record's turn plus 0x800,
the handler having turned once; the explorer's is the record's turn.

The seventh is type 77 on 0x3D930, `PN_r2_05_kabe01a` (0x1236), a wall. It
does not close as a prop does. It draws through 0x413B0 with the type's model,
and only the zone's clock (0x51E51C) changes it: once the clock passes 458 a
model still 0x1236 becomes `PN_r2_05_kabe_dam01a` (0x1237) and 0x39E10 throws
its pieces, and once the clock passes 723 it closes (0x150D0). Chapter 2's
section 12, script 2 (0xF19A8) spawns one, record 0xF27A0, Stage 2 · set 5.
The explorer runs no clock inside a zone, so it stands whole as spawned; the
break and the close are left out. Checked in MAME (`hotdo`, the attract scene
table pointed at chapter 2's section 12, a breakpoint on 0x413B0 for type 77):
drawn 1389 times at (405.7, -82.2, 33.7), turn 0, scale 1, as 0x1236, until
the clock reached 459; then 0x1237 with twelve pieces (0x122A to 0x1235) flying
from it, which closed at 701, and the wall itself at 724.

The prototype (`hotdp`) has the same wall, type 77 on 0x33000, at its own
models: `PN_r2_05_kabe01a` (0x113E, the type's own) and `PN_r2_05_kabe_dam01a`
(0x113F), drawn through 0x35AD0. It takes the finished game's two numbers off
the camera frame (0x51E788) rather than the zone's clock: past 458 a model
still 0x113E becomes 0x113F and 0x30460 throws its pieces, and past 723 it
closes (0x10D60). It never calls 0x33320, and the generic init (0x2EDD8) has a
case for type 69 only. The camera frame is the clock `propZones` runs, so the
wall keeps the zones it is drawn in, up to 723, as the prototype's `PN_powa`
do. Chapter 2's section 12 spawns the only one, record 0xF11A0, at the finished
game's place, (405.7, -82.2, 33.7), turn 0, scale 1. It is drawn in zones 29
and 31, whole; the break and the pieces are left out. Stage 2 · set 5 goes
from 10 props to 11, and `hotdp` set props from 111 to 112. Read from the ROM,
not checked in MAME.

The eighth is type 84 on 0x3DE20, `PN_niku_001` (0x11B1), a body hanging on a
rope. It closes as a prop's does (0x3ED60) and draws through 0x413B0 with the
type's model. Once bit 1 or 2 of its flags word (+0x58) is set while it shows
0x11B1, it queues the type's sound (0x154D0), calls 0x429A0 and takes 0x11B2;
from there it steps a model a frame through `PN_niku_120` (0x1228) and then
stands at 0x11B1 again. What sets those bits is not traced, and MAME's attract
demo never sets them, so it stands at 0x11B1 and the animation is left out.
Chapter 2's section 12, script 3 (0xF1A6C), the one after the wall's, spawns
two, records 0xF2980 and 0xF29B0 (Stage 2 · set 5). Checked in MAME (`hotdo`,
the attract scene table pointed at chapter 2's section 12, a breakpoint on
0x413B0 for type 84): both drawn 2128 times as 0x11B1 at (338.5, -95.3, 69) and (332.5, -91.3,
61), turns 0xB000 and 0xD000, scale 1, the flags word 0x1401 throughout, until
both closed as props do at clock 750.

The ninth is type 93 on 0x3E180, `PN_eneene00a` (0xD58). The handler is shared
with types 87, 88 and 95, which stand as props (below). For 93 it closes
as a prop's does (0x3ED60), and closes (0x150D0) once the zone's clock
(0x51E51C) reaches 430; then it steps +0x54 back to 0xD58 once the model it
stepped from is past 0xD79, so it loops `PN_eneene00a` to `34a` (0xD58 to
0xD7A), thirty-five frames, and draws through 0x413B0. Chapter 4's record
0xFC010 spawns one, Stage 4 · set 4. The explorer runs no clock inside a zone,
so it loops as spawned while animate is ticked, and the close is left out.
Checked in MAME (`hotdo`, the attract scene table pointed at chapter 4's
section 0, a breakpoint on 0x413B0 for type 93): drawn 2075 times at (0, 18.9,
0.5), turn 0, scale 1, every draw the model before it plus one and wrapping at
0xD7A, the clock going from 197 to 429, and closed as the clock reached 430.
The board's first draw is 0xD59, the handler having stepped once; the
explorer's is the type's model.

The other three on 0x3E180 are props. All three close as props do (0x3ED60)
and draw the type's model through 0x413B0. Type 95 (`PN_sekom01a`, 0x16CE)
also closes (0x150D0) once the zone's clock passes 601 while the section
byte (0x51F350) is 0, or 338 while it is 3, and in section 3 it takes
`PN_sekom02a` (0x16CF) before it draws. For types 87 (`PN_st3_card01a`,
0x16D0) and 88 (`PN_sousa00a`, 0x1120), a model of 0x1120, so 88's, becomes
0x1121 (`PN_sousa01a`) once the clock passes 311, and once a shot sets bit 1
or 2 of +0x58 they queue the type's sound and are shaken by 0x33B00's numbers
for 20 frames. 0x41890, called
after the draw, clears those bits every frame. Chapter 3's section 0, script
6 (0xF4194) spawns an 87 and a 95 (records 0xF57C0 and 0xF57F0), and section
3 a 95 (0xF8F70), all Stage 3 · set 8. Chapter 4's section 0 spawns an 88
(0xFBFE0), Stage 4 · set 4. The explorer stands all four as spawned, the
third 95 as `PN_sekom02a`, the section that spawns it being the walk's own.
The clock and the shots are left out. Checked in MAME (`hotdo`, the attract
scene table pointed at each section, a breakpoint on both draws in
0x3E180): in chapter 3's section 0, with script 1 pointed at script 6 because
the demo does not reach it, the 87 at (-39, -24.7, 209), turn 0, and the 95
as 0x16CE at (-38, -16.7, 209), turns 0, 0xA000 and 0x1300, each drawn 4022
times; in section 3 the 95 as 0x16CF at (348.5, -183.5, 1010), turn 0x4000,
1619 times; in chapter 4's section 0 the 88 as 0x1120 at (-87.7, 5, 325.9),
turn 0, its clock closing before 311. All at scale 1. The demo's player
shoots the 88, so MAME's draws are shaken about that place; the explorer
draws it still.

The tenth is type 122 on 0x3C5A0, whose own entry in the object table is
empty (`PN_space`, scale 0). It is the routine a shot prop calls to drop a
life (0x3A700), run as a task: it opens an item on 0x3C310 with
`PN_item_life` (0x312) at +0x54, scale 2.2, the spawner's x and z, its y
less the type's floor offset plus 2, and of its angles only +0x30. Outside
chapter 4 it then turns the item to face the camera; in chapter 4 (0x51F351
= 3) it keeps the record's yaw and closes its own task, so each record drops
one item. The item closes as a prop's does (0x3ED60) and draws every frame
until a shot sets bit 28 of +0x58; then it blinks and closes 120 frames on,
which the explorer, with no shots, leaves out. Chapter 4's records 0xFCD00,
0xFCD90, 0xFCE80 and 0xFCEB0 stand four, Stage 4 · set 9. Checked in MAME
(`hotdo`, the attract scene table pointed at chapter 4's section 3, a
breakpoint on the item's draw at 0x3C570): drawn at (-163, 2, 1574.3) and
(-162.6, 2, 1550.5) turned 0x4000, (-84.2, 2, 1457.8) and (-91.7, 2,
1451.3) turned 0xC000, scale 2.2, 580 frames each until they closed with
the props at clock 580; the attract player shot the first, which blinked
and closed at 253.

The eleventh is type 123 on 0x3C9D0, whose entry is empty too. It drops a coin
the same way: an item on 0x3C730 with `PN_kinka00a` (0x3B5, a disc of radius
0.55) at +0x54, scale 1.4, the spawner's x and z, y the float at `0x51E3C0`
plus 0.22, +0x2C 0x4000 and +0x30 and +0x34 0. In chapter 4 it closes its own
task. The coin closes as a prop does (0x3ED60) and, until a shot sets bit 28 of
+0x58, adds 0x1000 to +0x30 every frame and draws: 0x15 with +0x30, then 0x14
with +0x2C, which is the explorer's yaw then pitch, so it stands on its edge
and spins about the upright. It then draws the model a second time after
command 0x77 and calls to 0x2320 and 0x1A80; the explorer draws it once. A shot
sets bit 28, and the coin stops turning and closes 180 frames on; that is left
out. Chapter 4's records 0xFCCD8, 0xFCD60, 0xFCDF0, 0xFCE20 and 0xFCE50 stand
five, Stage 4 · set 9, each at yaw 0 whatever its record's, turning 0x1000 a
frame in step while animate is ticked. Checked in MAME (`hotdo`, the attract
scene table pointed at chapter 4's section 3, a breakpoint on the coin's draw
at 0x3C95C): all five drawn 580 times at the records' x and z, y 0.22 (the
float at `0x51E3C0` was 0), +0x2C 0x4000, scale 1.4, +0x30 stepping 0x1000 a
draw in step from 0x1000, until they closed with the props at clock 580. The
board's first draw is 0x1000 on, the coin having turned once; the explorer's is
0. The coin's lower 0.55 is below y 0. The board draws it whole over the floor
(MAME's snapshots show it whole), because it sorts polygons rather than testing
depth. The explorer's depth buffer hides that part (see `ZSORT_RECEDE` in
`js/viewer.js`). Type 124 on 0x3CBE0 opens a type-91 object on 0x41A60 and
stays out.

The twelfth is type 121 on 0x3EB30, `PN_kikai_b` (0x15BE), scale 1. Its
init closes the task at once if its event flag is already up: 0x56
(0x51E316), or 0x55 (0x51E315) when bit 5 of +0x58 is set, where 0x55 at 1
drops a life (0x3C5A0) first. A camera window (+0x64 not 0) skips the test.
Then it closes as a prop does (0x3ED60) and draws through 0x413B0 until a shot
sets bit 1 or 2 of +0x58, when it breaks and sets its flag (0x55 to 1 with bit
5, else 0x56 to 1). Only this handler and the life item (0x3C3D4, 0x55 to 2)
write those two flags; no script does. Chapter 3's section 0 spawns two in
script 8 (0xF59E0, 0xF5A40) with window row 0x1F of 0xAE830, `0x159, 0xFFFF`,
which closes them at 0x159 on the zone's clock, and two in script 10 (0xF5A10,
0xF5A70) at the same places, yaw 0x3000 and scale: the same two machines,
handed to objects that know whether the first were shot. The explorer stands
one at each place, (227.9, -24.7, 131) and (231.7, -24.7, 137.5), Stage 3 ·
set 8, which goes from 43 props to 45; `hotdo` set props go from 205 to 207.
The shot and the life are left out. Read from the ROM, not checked in MAME.

The thirteenth is type 67 on 0x3E010, `PN_r2_01_futa` (0x514), scale 1, a lid
held down by chains. The generic init (0x389E0) has no case for it. Each frame
it closes as a prop does (0x3ED60), draws its current model through 0x413B0
and offers itself as a target (0x41890, 0x44530). Only once a shot sets bit 1
or 2 of +0x58 (with bit 0, the shootable bit, up) does it step through its
entry's list, `PN_r2_02_futa` and `PN_r2_03_futa`, open the two halves
`PN_r2_04a_futa` and `PN_r2_04b_futa` as tasks of their own (0x41360, on
0x41F70) and set 0x51EBF0. Chapter 2's section 0 (list 0xEC380) spawns one,
record 0xEC720, at (28.4, -6.8, 0.4), yaw 0x4000. The explorer stands it there,
Stage 2 · set 5, which goes from 19 props to 20; `hotdo` set props go from 207
to 208. The shot and the break are left out. Read from the ROM, not checked in
MAME.

The fourteenth is type 78 on 0x3DA60, whose entry names `PN_r2do_01a`
(0x51A), scale 1. While the section byte (0x51F350) is 1 it is a door: once
event flag 0x0E (0x51E2CE) is up it sets its swing and hands itself to
0x3DC40. In any other section it closes as a prop does (0x3ED60) and then
issues 0x413B0's commands itself, with two changes: the model is
`PN_door_n4a` (0x165), not +0x54, and the scale command takes 0.9, 1.4 and
1.0 for x, y and z, not +0x94 three times. The spawn's per-type cases
(0x38A1C) have none for it. Chapter 2's section 9 (list 0xF00B4) spawns the
only one, record 0xF05A0, at (1263.8, -65.5, 295.5), yaw 0x4000. So it stands
there as `PN_door_n4a`, stretched, Stage 2 · set 7, which goes from 8 props
to 9; `hotdo` set props go from 208 to 209. No section 1 spawns one, so the
door and its flag are left out. Read from the ROM, not checked in MAME.

The fifteenth is type 14 on 0x3B550, `PN_jinmengyo_01` (0x1352), scale 0.3,
a fish with a man's face. Its record stands at the origin, because the
handler places it itself. Each frame it closes as a prop does (0x3ED60),
then puts the fish at t along segment s (+0x2F8) of a uniform quadratic
B-spline through the twelve-byte points at 0xAE7F0: 0.5(1-t)², t(1-t)+0.5
and 0.5t² of points s, s+1 and s+2. t (+0x30C) goes up 0.01 a frame, and
past 1 it goes back to 0 and s to the next segment, back to 0 past 3. The
six points end on the first two again, so the path closes, and in single
precision it comes round every 404 frames. The step from the last place goes
to coprocessor function 0x0F (`0xF0F`), which hands back the pitch, put in
+0x2C, and the heading, put negated in +0x30; on a frame where t has just
come back to 0.01 the old angles are kept. It draws through 0x413B0 only
while +0x2F0 is set and +0x2E6 is clear, as 0x417F0 leaves them, with model
0x1352 plus +0x50 rem 40, +0x50 counting its draws: `PN_jinmengyo_01` to
`_40`. The spawn's per-type cases (0x38A1C) have none for it, and no flag,
shot or clock reaches it. Chapter 2's section 4, script 6 (0xEE49C) spawns
the only one, record 0xEEB00. It swims in a fish tank, Stage 2 ·
set 6, which goes from 20 props to 21; `hotdo` set props go from 209 to 210.
The explorer works the handler's arithmetic in single precision, and the
coprocessor's angles with `atan2`, and steps it a frame while animate is
ticked. Checked in MAME (`hotdo`, the attract scene table pointed at chapter
2's section 4, a breakpoint on the fish's draw at 0x3B758): 727 draws, every
place the explorer's to the bit, every model the same, and every angle within
2 of 0x10000. The board's first draw has angles 0, and so has the explorer's.

The prototype (`hotdp`) has the same fish, on 0x312B0. That handler is 0x3B550
instruction for instruction, with its own field offsets: t at +0x2F4, the
segment at +0x2F0, and the draw flags at +0x2E8 and +0x2E0. The six points at
0x85900 are 0xAE7F0's, float for float. The model is `PN_jinmengyo_01`
(0x121E, the type's own) plus +0x50 rem 40, `_01` to `_40`, at the type's
scale, 0.3. It closes as the prototype's props do (0x33320) and draws through
0x35AD0. That routine sends 0x413B0's commands in the same order: the place,
the three turns, and the scale (+0x90 here) on all three axes. It also loads a
light from 0x52A2B0 by +0x68, which the explorer does not read. Chapter 2's
section 4 spawns the only one, record 0xED950, at the origin. It is drawn in
zones 14 and 15 with the tank's other pieces. Stage 2 · set 6 goes from 18
props to 19, and `hotdp` set props from 107 to 108. Read from the ROM, not
checked in MAME.

The prototype's three `PN_powa` are type 69 on 0x32F30, 0x3D860's loop at
the prototype's models: +0x54 steps a frame, back to 0x935 (`PN_powa00a`) once
the model it stepped from is past 0x950, so `00a` to `29a` again, at the
type's scale, 1, drawn through 0x35AD0. It does not call 0x33320. It closes
(0x10D60) once the camera frame (0x51E788, the float the sweep above compares
with 170) passes the float at +0x2F4, which the generic init sets by section
(0x2EDD8): 99 in section 3, 268 in 9, 1048 in 11 and 12, the finished game's
numbers. That is the clock `propZones` runs, so each keeps the zones it is
drawn in rather than the prop rules: chapter 1's section 3 (record 0xE1600,
zone 7), section 9 (0xE6050, zone 15) and section 12 (0xE7470, zone 20), at
the finished game's three places. Stage 1 · set 1 goes from 31 props to 34,
and `hotdp` set props from 108 to 111. Read from the ROM, not checked in MAME.

The sixteenth is type 68 on 0x3D6E0, `PN_furukagi00a` (0xBA5), scale 1. It
does not close as a prop does: once the zone's clock (0x51E51C) passes 521 it
counts +0x50 up a frame, and past 226 queues a sound and closes (0x150D0).
Each frame it draws through 0x413B0 with the type's model, and offers itself
as a target (0x41890). It swings once a shot sets bit 1 or 2 of +0x58, or
once the byte 0x51EFB0 has stayed 1 for 45 frames (+0x2EC counting from -14):
it then sets bit 28 of +0x58, and each frame sets +0x34 to +0x31C times what
the coprocessor hands back for +0x320, which goes up 0x1000 a frame; +0x31C
starts at 0x1200 and loses 0x100 each time +0x320 passes 0xFFFE, and at 0 bit
28 clears and the swing stops. 0x51EFB0 is a word many
routines write, and the explorer opens none of them, nor any shot. The
spawn's per-type cases (0x38A1C) have none for it. Chapter 1's section 13
spawns the only one, record 0xE92C0, at (133.83, 42.5, 358.8), yaw 0x4000.
So it stands there still, Stage 1 · set 3, which goes from 43 props to 44;
`hotdo` set props go from 218 to 219. The swing and the close are left out.
Checked in MAME (`hotdo`, the attract scene table at 0xAB0D0 pointed at
chapter 1's section 13, a breakpoint on the draw at 0x3D844): drawn 1409
times as 0xBA5 at the record's place, turns 0, 0x4000 and 0, scale 1, flags
0x1401 throughout, the clock going from 292 to 589. 0x51EFB0 was 1 on the
last 33 draws, too few to start the swing, and the run ended before the close.

The prototype (`hotdp`) has its own type 68 on 0x32E80, `PN_furukagi00a`
(0x1AA, the type's own), scale 1, drawn through 0x35AD0. It never calls
0x33320, and it does not wait on a clock: from its spawn it counts +0x50 up a
frame, and past 190 (0xBE) it queues a sound and closes (0x10D60). It has no
shot and no 0x51EFB0. Its swing is a spring on +0x34, +0x304 its speed: each
frame +0x34 takes the speed and the speed loses a tenth of +0x34. The spring
is kicked (+0x34 to 0, the speed to 0x400) only once the camera frame
(0x51E788) is past 593 and +0x2E4, which the generic init (0x2EDD8) sets to
the script index, has counted past 55 from there, and again each 32 frames
after. Chapter 1's section 8, script 7 spawns the only one, record 0xE8620,
at the finished game's place, (133.83, 42.5, 358.8), turn 0x4000 in yaw
only, so +0x34 and the speed start at 0 and it stands still until kicked.
The close is `lda 0xBE, g3` and `cmpible g4, g3` at 0x32E90: +0x50, counted
up first, past 190 closes it, on its 191st frame. The walk `propZones` runs
has the spawn at camera frame 506, the camera then plays 507 to 595 over the
object's first 89 frames, and the script's op 81 waits 220 frames with nothing
queued, the camera held at 595. So frame 191 lands at camera frame 595, in
that wait, before op 20 makes zone 36 current. It keeps the zones its 190
frames are drawn in (`frames`): zone 35. With the camera at 594 from its 88th
frame and +0x2E4 starting at 7, the spring is kicked on its 137th and 169th
frames, so on the board it swings for its last 54; the explorer stands it
still throughout, and the swing is left out. Stage 1 · set 3 goes from 45
props to 46, and `hotdp` set props from 112 to 113. Read from the ROM, not
checked in MAME.

The prototype (`hotdp`) also stands types 78 and 79 on 0x33130, the two halves
of a door: `PN_r2do_01a` (0x4DA) and `PN_r2do_01b` (0x4DE), the types' own
models, scale 1. Each frame the handler reads the byte 0x51E50E; while it is
0 it draws through 0x35AD0 and does nothing else, never calling 0x33320. Once
it is set, the half takes a push (+0x74, +0x78, +0x7C) and a spin (+0x2E4,
+0x2E8), one way for 0x4DA and the other for 0x4DE, queues a sound and goes
over to 0x331E0, which moves it, takes 0.1 off its rise each frame, draws it
every other frame and closes it (0x10D60) once y is below -35. Only three routines write
0x51E50E: two states of an enemy's action table at 0x94830 (0x57B90 and
0x57FC0, dispatched by 0x568B0 on +0x5C) and 0x3A6FC. No script op does.
Chapter 2's section 1 spawns the pair, records 0xEBBE0 and 0xEBC10, at
(256.71, -6.76, ±10.39), turned 0. The explorer opens no enemy, so they stand
shut and never close (`stays`): the walk credits them every zone from their
spawn to the chapter's end, which in Stage 2 · set 5 is zones 2, 3, 40, 41,
29 and 31. The burst is left out. Stage 2 · set 5 goes from 11 props to 13,
and `hotdp` set props from 113 to 115. Read from the ROM, not checked in MAME.

The seventeenth is type 94 on 0x3E450, `PN_r3_01a_mad11a` (0x166F), scale 1,
a window pane. It closes as a prop does (0x3ED60) and draws through 0x413B0
with the type's model. Once the byte 0x51E300 (event flag 0x40) is set while
it shows 0x166F, it queues 0xA01101, throws its pieces (0x411F0) and takes
`PN_r3_01a_mad12a` (0x1670) for good. The spawn's per-type cases (0x38A1C)
have none for it. Only two things write that flag: a chapter 1 script (op 88
at 0xE96B0), and an object's step at 0x47900 after a coprocessor distance
test: 0x47740, which 0x46ED4 calls on a state in +0x66, in the step of a task
that 0x46010 opens (the init of entry 0x27A in the table at 0xC9784). The
section start (0x21650) clears the event flags (0x67480) after it starts the
section's script, so chapter 1's flag is gone by chapter 3. Chapter 3's
section 0, script 4 (0xF3F90) spawns the only one, record 0xF5820, at (-30.6,
2.2, 93.7), turned 0. The explorer opens no such object, so it stands whole
there, Stage 3 · set 8, which goes from 45 props to 46; `hotdo` set props go
from 270 to 271. The break is left out. Read from the ROM, not checked in
MAME.

The walk reaches three more types on handlers of their own, and none is
stood. Type 64 on 0x3D6A0 is `PN_space` and draws nothing: it closes as a
prop does and offers itself as a target (0x41890). Type 83 on 0x3DEB0
(`PN_kyochuub06a`, 0x11AA) draws through 0x413B0, but the spawn's case for it
(0x38AD0) sets a step of 1 and a hold of 5, so it never stands: it rocks
0x11AA, 0x11AB, 0x11AA, 0x11A9, and each hold at 0x11A9 after the first is 3
plus 0x33B00's number rem 21. Type 120 on 0x3E930 (`PN_kami00a`) closes
itself unless the byte 0x51F111 is 3, which the boot fills from 0x1F050 with
the settings (0x13D2C).

One spawn class stands props of its own. A record's first word picks the task
the spawn opens (the class table at 0xAFDD0), and class 131's task, 0x39B50,
is not the generic object: it opens eight tasks on the shared prop handler
0x3A210, gives each type 51 and runs 0x417F0 on it (so the type's scale, 1,
and +0x2EC the script index), then sets model 0x149C + 2i, `PN_kenita00a` to
`07a`, x 1210.341 and y -59.011 (its immediates 0x44974AEA and 0xC26C0B43), and
z the float at 0xAFBB0 + 4i less 14 plus 249.749, and copies its own +0x70
(the life) and +0x64 (the window) to each. Then it closes its own task. The
record's place and turns are not read, so the eight stand in a row, unturned,
and close as a prop on that record would. Chapter 2's section 9 spawns the
only one, record 0xF0570, in spawn list 0xF00B4. Stage 2 · set 7
goes from 9 props to 17; `hotdo` set props go from 210 to 218. The explorer
stands them in `standRow` (`js/placements.js`, the profile's `rows`). The
handler's shot and break are left out, as for every prop. Checked in MAME
(`hotdo`, the attract scene table pointed at chapter 2's section 9, a
breakpoint in 0x3A210 for type 51): the init ran once with life 3 and no
window, and all eight were drawn 342 times each, every model and place the
explorer's to the bit, turns 0, scale 1, from clock 64 to 127.

Class 0x8A stands a room's furniture out of a table. Its task, 0x39830
(`hotdo`; 0x2FDD0 in `hotdp`), reads the block of 0x16C bytes at 0xAA378
(`hotdp` 0x81448) picked by the record's type, 28-byte entries until one whose
word is -1: +0x00 the type (a halfword), +0x04/+0x08/+0x0C x, y and z, and
+0x10/+0x14/+0x18 the turns, which go to +0x2C/+0x30/+0x34. For each it opens a
task on the shared prop handler (0x3A210; `hotdp` 0x30670), runs 0x417F0 for the
type's model and scale, adds the type's +0x2C offset to y, and copies the
record's +0x70 and +0x64 (`hotdp` +0x6C and +0x64), so each closes as a prop on
that record would. The record's own place is not read. Chapter 1's section 8,
which section 13 shares, spawns two: `hotdo` records 0xE91A0 (type 54, 8 props:
a jar, two chairs, a table, a bookcase, two cups and a pot) and 0xE91D0 (type
55, 11 props: a lamp, three bookcases, two chests, two chairs, a table and two
cups); `hotdp` records 0xE8500 and 0xE8530, the same layout, in zones 35 and
35-36. Stage 1 · set 3 goes from 44 props to 63 in `hotdo` and from 46 to 65 in
`hotdp`; set props go from 219 to 238 and from 115 to 134. The explorer stands
them in `standTable` (`js/placements.js`, the profile's `tables`). Left out:
bit 30 (unbreakable), which every type but 2, 3, 34, 35 and 43 is given, and
the bookcases at x 82.9 and 97.3 also when event flag 35 or 36 is set; and the
shot and break, as for every prop. Its two chests (type 26) take the lid the
plain draw adds (see below). Read from the ROM, not checked in MAME.

The plain draw adds a second model to two types. After the prop's own model,
the shared handler's draw (0x3A800, reached by every standing prop on
0x3A210) switches on the type, on the same matrix:

```
ld   0x54(r4), g0       ; the prop's own model
call 0x14120
ldis 0xCC(r4), g4
lda  0x13A0, g0         ; type 11: PN_sara_dai00a
call 0x14120
...                     ; type 26: translate (0, 3.5, 2.0) (0x9001212)
lda  0xD0D, g0          ; and PN_takara_box01a
call 0x14120
```

Type 11 is `PN_sara01a`, a plate, and 0x13A0 its stand; type 26 is
`PN_takara_box01b`, a chest, and 0xD0D its lid, 3.5 up and 2 along the chest's
own z. No flag, clock or shot gates either. The prototype's 0x30670 does the
same after its draw (0x30C74): `PN_sara_dai00a` (0x126C) on type 11, and
`PN_takara_box01a` (0xC7A) moved (0, 3.5, 2) on type 26 while +0x314 is 0, the
chest unbroken, which it always is here. It also draws 0x126C on any prop whose
+0x6C (the record's life) is 12, which no spawned prop has, and 0x114A at
twice the size over type 73, which stays out with the finished game's 0x1241.
The explorer draws the second model with its prop (`seconds` and `withSecond`
in `js/placements.js`, the profile's `seconds`): the two chests of class 0x8A's
second table, Stage 1 · set 3, and chapter 2's one type-11 plate, at (618,
-9.6, 348), scale 1.2, Stage 2 · set 6, in both builds. Prop counts do not
change; each build draws three models more. Revision A's profile leaves them
out. Read from the ROM, not checked in MAME.

Classes 0x93 and 0x98 each stand a fixed group of props about their own place.
Their tasks, 0x394B0 and 0x395B0 (`hotdo`), open 15 and 12 tasks, on handlers
0x3A9C0 and 0x3ACF0, from the 28-byte entries at 0xAED40 and 0xAF620: +0x00 the
type (a halfword), run through 0x417F0 for its model and scale; the spawner's
place plus +0x04/+0x08/+0x0C; the spawner's turns plus +0x10/+0x14/+0x18; the
spawner's +0x70 and +0x64 copied. No -1 ends the list, and no +0x2C offset is
added. Class 0x93 also sets bit 30 on type 4, and a child whose third turn
comes out nonzero gets a third turn of 0 and window row 28; five of its entries
carry a 1 there. Both handlers set or clear bit 30 by the zone's clock and
otherwise close and draw as the plain prop does: place, turns, scale +0x94 and
model +0x54. 0x3ACF0 also draws 0x1241 at twice the size over type 73: left
out. Each spawns once. 0x93 at 0xE4980 is
chapter 1's section 6 (Stage 1 · set 3), at (109.5, 0, 200): a laid table,
`PN_tabul_02a` with six `PN_isu_02a`, six `PN_sara03a`, `PN_kabin_01a` and
`PN_honeatama`. 0x98 at 0xF27D0 is chapter 2's section 12 (Stage 2 · set 5), at
the origin: three `PN_maru_01a`, the middle one `PN_fruit_01a` instead, six
`PN_sara03ab` and three `PN_syokudai01a`.

The prototype has one routine for both, class 0x93's 0x2FA20. It picks its
table by the chapter number (0x51E4C0): 15 entries at 0x85E10 in chapter 0, 12
at 0x866F0 in chapter 1. The places and types are the same, except a third type
73 where the finished game has its 85, and no third turn is set. Its children
run the plain prop handler (0x30670), and in chapter 0 all but types 3 and 4
get window row 26. Its records are 0xE4340 and 0xF11D0, in the same sets, and
stand in zones 28-29 and 31. The explorer stands both in `standGroup`
(`js/placements.js`, the profile's `groups`). Stage 1 · set 3 goes from 63
props to 78 in `hotdo` and from 65 to 80 in `hotdp`; Stage 2 · set 5 from 20 to
32 and from 13 to 25. Read from the ROM, not checked in MAME.

Class 0x94 stands models of its own at places of its own. Its routine, 0x38F50
(`hotdo`; 0x2F3B0 in the prototype), opens four tasks on 0x3C240 (0x32110) from
the 28-byte entries at 0xAEA30 (0x85B00), then closes itself. Each child runs
0x417F0 for the record's type, then overwrites the model with the entry's +0x00,
which is a model, not a type. It copies the spawner's +0x70, sets scale 1.0 and
takes +0x04/+0x08/+0x0C as its place and +0x10/+0x14/+0x18 as its turns. The
record's own place and turns are not read. The handler closes as a prop does.
Before the draw it works on the model it holds: `PN_haguuu` and `PN_haguuu01a`
(0x8C6, 0x8C7) add 0x80 to the third turn every frame, `PN_haguuu02a` (0x8C8)
takes 0x80 off it, and any other model steps one, going back to `PN_hagumizu00a`
(0x8A8) once it is past 0x8C4, so the water's 30 frames loop. The prototype does
the same with its own models (0x83E-0x840; 0x820-0x83D). The one record of the
class, 0xE7030 (0xE6660), is chapter 1's section 10 (Stage 1 · set 1): three
gears and the running water, at the same places in both builds, with all turns
0. The first gear's turn is also stored for another object at 0x53E4C0. Around
the water's draw, a block of 32 words at 0x7A0 is rescaled by 0xC8/256 and sent
to the coprocessor. The explorer follows neither. The explorer stands the four
in `standFixed` (`js/placements.js`, the profile's `fixed`), the gears as `spin`
and the water as a `cycle`. Revision A is not covered: its profile has no
groups either. Read from the ROM, not checked in MAME.

Class 0x13 is a second moon, not the type-59 `PN_moon` prop: one flat quad
turned to the camera. Its task, 0x2F740 (`hotdo`; 0x27D70 in the prototype),
sets its own model, `PN_moon22` (0x14AC; the prototype's `PN_moonc`, 0x13A2),
and every frame sends the camera's place (0x51EBD0) less its own (+0x20) to
the coprocessor's 0xF0F, which returns the vector's heading (kept at +0x30)
and then its pitch (+0x2C):

```
ldq  0x51EBD0, g0        ; the camera
ld   0x20(r4), g4 ...    ; less the moon's place
lda  0xF0F, r5
st   r5, 0x8800F0
st   g6/g5/g4, 0x884000  ; the vector
ld   0x884000, g4        ; heading -> +0x30
ld   0x884000, g0        ; pitch   -> +0x2C
```

A pitch past a right angle either way is taken from 0x8000 and the heading
turned half round. The draw is the prop's commands with its own numbers: the
place, the heading (0xA801515), the pitch less 0x4000 (0xA001414), the
record's third angle (0xB001616) and scale 5.0 (0x40A00000) on every axis.
It never calls `sub_33320`; it closes only when byte 0x51E3BD (0x51E5FD) is
1, which no store in either program names, so it stays up to the chapter's
end. The one record of the class, 0xF3D70 (0xF23C0), stands at (2550, 1120,
-425) in Stage 2 · set 7, which now stands 18 props in the finished game
(17 before) and 4 in the prototype (3), where it is drawn from zone 22 on.
The explorer stands it in `standFacing` (`js/placements.js`, the profile's
`facing`) as a `live` draw that works the same heading and pitch from its own
camera each frame. Read from the ROM, not checked in MAME.

They come out as their own layer, so they can be switched off and so the camera
frames the room rather than them. The first chapter stands 38 in the courtyard
and 78 in the mansion (44 before class 0x8A's furniture, 63 before class 0x93's
table); the prototype, whose table is the same one 78 types long, stands 38
and 80 (46, 65).

The prototype's table was found by its own shape and then held against the
finished game's: **73 of the 77 types both carry name the same model, type for
type** — `PN_test_tubo01a`, `PN_tokei`, `PN_book_tana`, `PN_sika_atama01a`, and
`PN_moon` at 59 in both.

And Revision A moved it, as it moved everything. The three addresses a prop
needs, per build:

| | object table | handlers | classes | generic class |
|---|---|---|---|---|
| prototype | 0x84140 | 0x86990 | 0x86C10 | 0x2ECC0 |
| first revision | 0xAC2D0 | 0xAF950 | 0xAFDD0 | 0x389E0 |
| Revision A | 0xAC2E0 | 0xAF960 | 0xAFDE0 | 0x39930 |

The entry's own fields are the same in all three: the model at **+0x00**, a
radius at **+0x14**, the **scale at +0x28**, a floor offset at **+0x2C**, a
short array of further offsets from **+0x30**, and the sound at **+0x44**.

The class table was found the way IDA finds anything: the generic init is the
only routine that indexes the handler table, so the literal of the handler
table's address locates it, and the pointer *to* that routine locates the class
table — in the prototype the instruction is at 0x2EE70, the pointer to its
function at 0x86E10, and 0x86E10 less 0x80 entries is the base.

#### Taking the props down

No script opcode removes a prop. Each prop closes itself, in `sub_33320`, which
the prop handler (0x30670) calls every frame before it draws. In the prototype
there are two rules:

- **Script count.** Each spawn opcode copies a halfword of the record to
  obj+0x6C (opcodes 10 and 12 from +0x22, 9 from +0x20, 11 from +0x04). The
  object keeps the script index (0x520089) it last saw at obj+0x2E4. Each frame
  it sees a different index, it adds one to obj+0x318. Once that count passes
  the halfword, it calls `sub_10D60`, which closes the current task.
- **Camera window.** Opcodes 10 and 12 copy the record's byte +0x25 to obj+0x64.
  A non-zero value picks a 16-byte row of 0x85940: camera frames, ending in
  0xFFFF. When the camera frame (0x51E788) equals the next entry, the routine
  flips obj+0x2E8, the flag the handler draws under. When the row ends with the
  object hidden, the object closes.

One more case is hard-coded. In the first chapter, section 7, script 2, every
object except type 7 closes once the camera passes frame 170. The handler can
also close a prop itself (0x30B40) once its type's model list reaches a zero
entry. Which props get there, and whether only shot ones do, was not traced, so
`propZones` leaves that rule out.

Both rules count time, not zones. So `propZones` (js/placements.js) runs the
interpreter's clock over the scripts:

- Opcode 60's type-0 commands queue camera stretches.
- 83, 84 and 81 wait on them. Nothing else takes a frame.
- 93 moves to the next script. A section's end goes where `off_83290` says, at
  script 1 (`sub_51490`). Where the table offers a choice, both sections are
  followed.
- A prop is in a zone if it is drawn on a frame while that zone is current.

Scripts that pass in the same frame count as one change, as they do on the
board. The Zone picker draws only those props, and "every zone at once" draws
all of them. In Stage 1, set 1, zone 1 keeps 2 of the set's 34 props, zone 3
none, and zone 14 keeps 17. The finished game's profiles carry none of these
fields, so it still draws every prop in every zone.

#### Auditing the props

The same questions the bodies were swept with, asked of every prop of every
stage: does its model decode, does it name colours the stage's set resolves, is
it from a bank the stage's scenery uses, does it stand where the room is, and is
it the size of a prop rather than a piece of the room?

What comes back is clean on the classes that have bitten before. Across the
finished game's eighteen stages there are **35 distinct prop models**, every one
of them between 1.3 and 25.5 units across and between 4 and 602 triangles — no
model that fails to decode, none from a bank the stage never uses, and none a
quarter of the room across, which is the check that would have caught room 4's
walls standing in the courtyard. They read as what they are: `PN_test_tubo02a`
a jar forty times, `PN_honeatama` a pile of bones thirty-six, `PN_kibako01a` a
crate twenty, corpses, tables, chairs, pots, plates, a billiard table, a deer's
head — and `PN_book_tana` a bookcase six times, in the library rather than out
on the lawn.

The audit's earlier run turned up four kinds of oddity, and **the class gate
accounted for all four**. They were not the game being strange; they were
records of other classes being stood up as furniture:

- **Models naming a colour past the end of their section's set** — gone. Every
  prop now resolves every colour it names under the set it is drawn under. The
  fourteen that did not were bank-6 and bank-3 models being drawn under set 1.
- **Props at the origin** — gone. A record at exactly (0, 0, 0) turned out to be
  the signature of a class that positions itself: the nine `PN_tarun_dam_01a`
  at the origin were all class 0x8B, a rolling barrel, not a standing one.
- **The prop a long way out** — gone with it.
- **Props doubled at one spot** — down from 26 to five, and the five that remain
  are two models the mansion's own set genuinely lists twice.

What was left after that was one flag in both builds — `PN_moon` a prop of
radius 170 in a room 486 across — and it turned out to be the next field rather
than an oddity. See **The size a prop is drawn at** below. With the scale in and
the room bounded by its geometry rather than by its placement origins, **328
props across eighteen stages flag nothing at all**, and the prototype's 214
across eight likewise.

#### The order the sets are loaded in

The first of those is the palette carrying between sets, and the order it
carries in can be read rather than guessed. Each section starts with a set of
its own and a script may load another part way through, so walking the sections
in order and noting each set the first time it appears gives the order the game
loads them. Done to the prototype it gives **[1, 3, 4, 5, 6, 7]**, which is the
line its profile already carries — so the method is the one that wrote it. Done
to the finished game it gives **[1, 3, 4, 5, 6, 7, 8, 10, 9, 11, 12]**, the same
for both revisions. Set 2 is absent because no chapter loads it, which is what
the prototype's notes say of its own bank 2.

That it cannot break anything is worth measuring rather than arguing. Building
every set's palette with the order and without it changes **1970 entries across
the thirteen sets, and every one of them was unset before** — not one colour
that already had a value moved. It could not: a set's own table is written last
and over the top, so the order can only reach entries above where that table
stops.

The stages agree. Every stage without a sky renders pixel for pixel identically;
the ones with a sky differ only because the dome is at a different point in its
drift, and the lit sky pixels come to the same mean colour to a tenth and the
same count exactly. What does change is what had no colour at all: six lamps in
the mansion, a plate, two tables, and one piece of scenery under set 6 that
names 837 and had been falling back to grey.

No prop is left without a colour. The two that were — `PN_tabul_maru01a` and
`PN_ose_cup_01a`, naming 786 and 831 under set 1, which nothing precedes — were
not props of set 1 at all.

#### What handles a type

A second table, at **0xAF950**, gives each type its handler, and the dispatch is
three instructions:

```
shlo 0x10, g5, g4        ; the type,
shri 0x10, g4, g4        ; sign-extended from sixteen bits
ld   unk_AF950[g4*4], g4 ; and straight into the table
```

No mask, and no bounds check. The table holds **125 entries, types 0 to 124**,
and behind them are zeros and then floats. Nothing ever indexes it past 124,
because the dispatch only runs for objects of the generic class, whose type came
from the record's +0x24 — a byte, so it cannot exceed 255, and in the data it
never exceeds 124.

`+0xCC` does carry two things, but the class says which. For a generic object it
is a type into the tables above; for an enemy it is a body index. The draw
callback reads it as a body number, and so does the routine that scatters an
enemy's parts: `ldis 0xCC(g5)` into a table at **0x14BA80** whose entries are
lists of that body's `_DD` models — `dog_akos_DD`, `ff_mune_DD`, `hyum_kao_DD`,
`boss4_mune_DD`, the spider's `taraba_bodya_DD`. That table runs to index 189 and
ends in -1, but only its first 94 entries name anything: 94 is the body count,
and 94 to 189 all point at lists of nothing.

**0xAED40** and **0xAF620** were once read here as enemy waves, their first
halfwords taken for body indices. They are not: the routines that read them,
classes 0x93 and 0x98, take that halfword as an object type and stand props
(see class 0x93 and 0x98 above).

Most of the 125 entries are one of two routines: `sub_3A210` takes 77 of them
and `sub_3B1A0` several more, which is what a table of furniture should look
like. The distinct ones are the objects with behaviour.

#### The runs, from the routines that step them

Every effect start can be enumerated rather than guessed: find each `st reg,
0x54(reg)` and walk back for the `lda` that fed it, and the function handed to
`_TaskOpen` just before is the routine that will step it. That is **122 spawn
sites**, each naming its first model and its stepper — and it checks out against
what was already known, finding the Devilons' wing beats at 5121 and 6495 and
Sophie's blink at 1468, which the draw callback carries independently.

Three are read out fully:

| effect | models | frames | ends |
|---|---|---|---|
| `PN_shoubushu###a` | 1417 → 1446 | 30 | closes itself; quarter scale |
| `PN_nikubaan###a` | 1130 → 1187 | 58 | closes itself; 0.4 scale |
| `PN_niku_###` | 4529 → 4648 | 120 | wraps and keeps going |

The spurt is opened twice over, by `sub_429A0` on `sub_44250` and by `sub_3D640`
and `sub_3E960` on `sub_41B60`, and the two steppers are the same seven
instructions. The flesh burst is `sub_425C0` on `sub_43F20`. Only the chunks
loop; the other two are one-shots that call the task-close themselves at the top
of the run.

Three more tables turned up on the way: **0xAA378**, **0xAED40** and
**0xAF620**, all indexed with a 28-byte stride whose first halfword is an object
type. 0xAA378 is class 0x8A's furniture, and 0xAED40 and 0xAF620 classes 0x93
and 0x98's groups (see above).

## Animation

Motion playback is implemented, and checked against the board — see
[Holding it against the machine](#holding-it-against-the-machine).

A motion id indexes `offset_list_motions` at `0x06400004`, which is in
`XTRA_DATA` — a window that mirrors `main_data + 0x01000000`, repeated every
megabyte, and `js/romset.js` exposes `xtraToMainData()` for it. Each entry is
the address of one keyframe block: the low motions sit in the data ROM at
`0x02xxxxxx` and the high ones, mostly Honey's, in the `0x064xxxxx` bank. 518 of
the table's 519 slots hold a real block.

### The keyframe block

```
+0x00  u16   frame count
+0x02  20    control bytes, one per object
+0x16  n     one key-count byte per keyed channel, in channel order
       pad   to the next multiple of four, measured from the block start
       ...   key times:  4 bytes per key, per keyed channel, in order
       ...   key values: per channel, in order
```

Twenty objects carry three channels each. A control byte packs all three of its
object's channel types, and `calc_rob_angle_int` at `0x2EF38` is the header
walk:

- **bits 6-7 nonzero** — every axis of the object takes type `(bits 6-7) - 1`,
  which is 0, 1 or 2: a constant the game latches once and skips thereafter,
  four bytes an axis.
- **bits 6-7 zero** — axis `a` takes type `((byte >> 2a) & 3) + 3`: **3** zero
  with no data at all, **4** one constant float, **5** linear keys of one float
  each, **6** cubic-Hermite keys of three floats each.

Only types 5 and 6 spend a key-count byte, which is what makes the count stream
shorter than 60 and why it has to be walked in step with the types.

`get_fcurve_value_f` at `0x30C28` walks the three streams in lockstep, comparing
the frame against each key time in turn; the interpolation itself goes to the
geometry coprocessor as op `0x18803131` (lerp) and `0x19003232` (Hermite), which
is why a Hermite key carries a pair of tangents — the previous key's out-tangent
and this key's in-tangent bracket a span.

Key times may repeat. A pair of keys at one time is how the data steps, and both
the ROM and the viewer take the first of such a pair.

### The tangent scale

Hermite tangents are **rates per authored second, at 30 fps**, so a span scales
them by `dt / 30` rather than by `dt`. The data states this twice over, in two
different tangent conventions, and both agree on exactly 30:

- where a key's in- and out-tangent match, the stored value is the Catmull-Rom
  slope through its neighbours times thirty — 25494 of 30074 such keys hit
  30.0000 exactly;
- where a segment is drawn straight, both its ends carry that segment's own
  secant times thirty.

Reading the tangents at face value turns a typical one per cent of overshoot
past a channel's own keys into a hundred and forty, and it is the one thing in
the format that a plain reading of the microcode does not give you.

### The pose

The rig is not a chain of joint angles. `calc_rob_angle_cont` at `0x2FF2C`
hands the coprocessor a body matrix, two look-at aims and four two-bone IK
chains, so most of the skeleton is placed by solving towards a point:

- **slot 0** the waist — op `0x62` builds its matrix from the motion's own euler
  (object 4) and the fighter's facing, at the position object 12 gives.
- **slot 1** the chest — the body turned by object 5, then aimed so its `+X`
  runs at the neck target, float object 13.
- **slot 2** the head — a step along the chest's `+X` by the skeleton's spine
  offset, turned by object 6, then aimed at the face target, object 14.

#### The head's aim

The head block is `0x30FE8` with `g1 == 2`. It emits the spine translate, op
`0x3F` carrying object 6 sent back to front (motion 278's `(-180, -90, 0)`
arrives as `(0, -90, -180)`), and the euler at `+0xC0C`, which is zero. Then it
aims: op `0x6A` takes the target at `+0xB0C` into the head's frame, op `0x27`
and op `0x2D` turn that into an `ang_z` and an `ang_y`, and the two go out as
ops `0x0A` and `0x09`. The chest takes the same path (`g1 == 1`, target
`+0xB00`) without the head's limits:

- **pitch** — `ang_y` is clamped to ±`0x2000` (`0x312A8`), so a head never
  looks more than 45 degrees up or down off the frame object 6 leaves it in;
- **the -Y side** — a target with a negative local y is taken as having none
  (`0x311A4`), so the turn stops at 0 or `0x8000`, and with the target within
  0.5 of the head the last frame's turn is held;
- **steps** — each angle moves only so far a frame from the last one
  (`0x31220`, `0x3128C`): `0x800` and `0x400` while the head is tracking the
  opponent, `0x2000` otherwise.

`js/pose.js` (`aimHead`) has the first two. A pose solved on its own has no
last frame, so it takes the angles the steps settle on.

**What the target is.** `0x307F8` copies the motion's float objects into
`+0xAF4`, so `+0xB0C` starts as the motion's face target, object 14. Then,
unless the fighter is in one of a long list of states (`0x30820`-`0x308C4`:
attacks, throws, falls), it sets `+0x7D3` and overwrites `+0xB0C` with the
opponent's head (`+0x20C` of the other fighter), taken into the fighter's own
frame by op `0x63`. So in a fight a head mostly looks at the other fighter, and
the motion's face target only counts in those states. In the explorer the head
aims at object 14 on its own, and at the opponent's head when there is one
(see the Virtua Fighter 2 pose's Opponent).

**The four on Bean's table.** The Final Eggman Boss, the Egg UFO, the Egg
Minion and Rocket Metal have no action table of their own: there are thirteen
tables of 106 bytes from `0xD9908` for seventeen fighters, and those four point
at Bean's. The head block has no case for them. They are aimed at Bean's face
target like anyone else, and since their heads sit far higher up the spine (1.466
for the boss and 1.316 for the minion, against Sonic's 0.361), that target lands
below the head and the pitch clamp holds them at `0x2000`. The explorer used to
drop the aim for them and turn the head a constant quarter turn about its own Z
instead (`HEAD_FACE`).

Checked against MAME (pinboard #262): the attract replay (Sonic against Bean),
taken over at its jump by `m2-hle2/tools/mame/match-replay.lua`, with fighter 0
pinned to the boss (13 for the minion) and its skeleton type held at 1, the
per-character rig a fight uses. On every frame where the board aimed at the
motion's own target (`+0x7D3` clear), outside a motion's first eight frames and
not mirrored, the head's stored angles (`+0x14E` ang_y, `+0x150` ang_z) were
compared with the angles the explorer turns the head by:

| run | frames | explorer before | explorer now |
|---|---|---|---|
| boss | 468 | pitch off by `0x2000` on all; yaw by up to `0x3126` | pitch exact; yaw within 2 |
| minion | 59 | pitch off by `0x2000` on all; yaw by up to `0x2FD3` | pitch exact; yaw within 2 |
| Sonic | 283 | pitch over `0x100` out on 52 (the clamp), yaw on 1 | pitch on none, yaw on the same 1 |
| Bean | 383 | pitch over `0x100` out on 63, yaw on 11 | pitch on 6, yaw on the same 11 |

`0x14E`/`0x150` hold the board's own `ang_z` convention, which is the negative
of the angle `js/pose.js` hands `rotZ`. What is left is not the clamp. Five of
Bean's six pitch frames are motion frame 11, the first one past the held-back
blend, where the board is still short of the clamp. The yaw frames (at most
`0x286` out, and `0xC01` on Sonic's one) were out before this change too, and
their cause is not pinned down: the per-frame step and the held turn are the
candidates.

- **slot 9** the pelvis — the body turned by object 9, then rolled a quarter
  turn.
- **the four limbs** — op `0x6B`, each hanging off its pivot, taking a base
  euler from objects 7, 8, 10 and 11, and reaching for its own target: objects
  15, 16, 18 and 19. Only the hand or foot takes an angle of its own after that,
  from objects 0 to 3. Object 17 is unused.

Everything then takes a quarter turn about Y, which is where the fighter ends up
facing once the parts are drawn.

The first twelve objects are joint angles, rounded to 16-bit binary radians
(`cvtri`/`stis`, and `set_mirror` reflects a yaw by taking it from `0x8000`).
The last eight stay floats. The coprocessor takes an angle's sine and cosine
from tables in its data ROM (`mpr-19015`/`mpr-19016`, which the SHARC sees at DM
`0x1C00000`): sine at word `0x10000 + a` for the signed angle, cosine at
`0x30000 + a`. There is an entry for every one of the 65536 angles, so nothing
is quantised. Those two chips hold 56,711 distinct cosines, each within 2e-6 of
the true value and rounded to six decimals, which makes `cos(0x4000)` exactly 0.
An earlier reading here took a 256-entry table indexed by the angle's top byte;
that is up to 0.024 out, about 1.4°, and m2-hle2's pose grader puts the cost at
3.0e-2 of rotation and 9.6e-3 of position on a real fight's angles. Rounding
libm's answers to six decimals misses about 26,000 entries, so the viewer loads
the start of that ROM and reads the tables themselves, falling back to libm when
a set does not carry the chips. Nothing in the solve needs a transcendental
beyond those tables and a square root.

Both the aim and the IK derive their cosine and sine from ratios — the law of
cosines, then `sin = sqrt(1 - c^2)` — so a limb that cannot span the distance to
its target simply comes out straight, and the sign chosen for that square root
is what makes an arm and a leg bend opposite ways.

### The viewer's frame

`buildPose` works in the board's frame, which is what a display list captured
out of a machine can be checked against. The viewer's is not the same one:
`js/model.js` negates Z as it reads geometry, so a part's mesh is already
mirrored by F = diag(1, 1, -1) before any transform reaches it, and the matrix
that places it has to be F·M·F rather than M. That is the same convention
`js/display.js` states for the stage draw lists, so both views agree, and
`poseMatrices` is the one place it is applied.

Nothing about the pose on its own catches getting this wrong: the conjugate of a
rotation is still a rotation, bones still keep their lengths, feet still reach
their targets, and the fighter still stands on the ground the right way up. It
only shows against the geometry — every part reflected through the XY plane,
which reads as heads upside down and feet pointing backwards. So it is checked
where it shows: `test-motion.mjs` puts each part's own bounding box through the
matrix the viewer would use and requires the head to end up over the waist,
which 17 of the 32 posed heads would fail if the board's matrix were applied
straight.

### Sway chains (`js/osage.js`)

揺れ物, "swaying things". Five fighters carry parts that are not on the sixteen
slots at all — they hang off a bone and trail behind it.
`osage_per_character` at `0x68D64` maps a character to a definition table, and
`osage_dsp` at `0x67640` walks it as a stream of typed records: `MATRIX` (the
frame the chains are simulated in), `COLI` (the volumes a segment is kept out
of), `ETC` (whether those apply, and the damping), `TSUKENE` (a new chain: its
root mode, attach bone and offset) and `OSAGE` (one segment: its model, length
and two bias vectors).

| fighter | chains |
|---------|--------|
| Fang | one of three on the chest — his tail |
| Bark | one segment on the head |
| Espio | one segment on the chest |
| Bean | four on the chest |
| Honey | two of three on the head — her pigtails — and one on the chest |

Everyone else points at the same empty table at `0x69DE4`.

#### The main CPU builds the stream; the coprocessor sways the chains

The main CPU does not simulate the chains. Each record's handler (the table at
`0x679A8`) writes a matching record into bufferram, sized by the table at
`0x67520`, and `osage_copro` at `0x687C4` hands the whole stream to the
coprocessor as one command, `Fn_osage` (`0x4A`). The coprocessor answers each
segment with the matrix it is drawn with, and writes the segment's new point
and carry back into its record. Those two survive into the next frame, so the
chains have memory and they swing.

| record | main CPU handler | what goes into bufferram |
|--------|------------------|--------------------------|
| `MATRIX` | `os_set_matrix` `0x67D28` | the frame `F = bone · Rz · Ry · Rx · T(offset)`; `M1 = F⁻¹ · F_prev`, which carries last frame's points into this frame's frame; `M2`, the same rotation with gravity (turned into `F`) as its translation |
| `COLI` | `os_set_coli` `0x6829C` | the floor as a plane in `F`, two spheres whose centres sit in the bone's XZ plane, a cylinder, and two lines taken off a second bone's X axis |
| `ETC` | `0x68758` | whether the body limits apply, and the damping (`0.8` while airborne) |
| `TSUKENE` | `os_set_tsukene` `0x680E0` | the chain root `P = F⁻¹ · bone · offset` |
| `OSAGE` | `os_set_osage` `0x685FC` | the bias: the second vector while bit 1 of the flags is set, which the last segment's side of `F`'s X decides (`0x6878C`), and none while airborne |

The coprocessor then does, for each segment (cpres1 PM `0x207BD`, ported in
m2-hle2's `sharc_osage` and matched word for word against MAME):

```
a     = M1 · point                  where last frame's point is now
aim   = a + M2 · carry + bias       plus momentum, gravity and the bias
aim   → onto the floor if below it, else out of the body's lines and spheres
u     = unit(aim − P)
draw  F · [X, u, Z | P]             X = (u.y, −u.x, 0) / √(1 − u.z²), Z = X × u
point = P + length · u,   carry = (point − a) · damping,   P = point
```

The segment meshes run along their own +Y for their length, which is why they
lie end to end. The frame is exact; the half turn about Z the viewer used to add
by eye is what that formula gives for a segment hanging straight down.

Bit 0 of the chain's flag word is not a sway switch. `osage_init` at `0x67600`
sets it and runs `osage_dsp` once, and `0x67D1C` clears it at the end of the
pass: it marks the first frame. What it gates is the initialisation — gravity
stored at `0x114`, each point started one length down `unit(gravity + bias)`
from `0x108`, and the `COLI` constants.

Behind it all is a wind oscillator that is dead. The routine at
`0x68AA4` steps a phase at `0x130`, turns it to a heading at `0x134` and writes
a vector to `0x138`, with magnitude `gravity * amplitude / (sin(phase) + 2)`.
The amplitude comes from a per-character table at `0x68914` whose 52 entries
all point at one record, `0x689E4`, whose amplitude is `0.0f` — so the vector
is always zero while the phase goes on stepping `0x11C7` a frame under it. A
populated table of real speeds and amplitudes (1.32, 0.206, 1.084, …) sits
unreferenced at `0x68A04`. The wind was authored and then switched off.

`js/osage.js` ports both halves. The viewer keeps the chains' points and
carries between display ticks, so a motion that plays, or is stepped one frame
at a time, swings them; anything else (a new motion, a scrub backwards, a jump
of more than eight frames) starts them again and runs them until they stop
moving, which is what a pose held still shows. The pose with every channel at
zero has its waist at the origin, so it takes the board's own "no floor"
(`-999.9`, loaded at `0x678C8`).

#### Holding the chains against the machine

An earlier reading of this module took bit 0 for a sway switch that was never
set, and `stf-tools/test-osage-mame.mjs` confirmed its predictions on 36 frames
of Honey walking: bit 0 clear, `0x108` and `0x114` bit-identical throughout. All
of that holds, and none of it is about the chains — those two fields are the
first frame's, and the state that moves is in bufferram. The records there are
what `stf-tools/osage-fang-segments.json` reads as `out_pos` and `out_0c`: each
of Fang's three points sits exactly its own length from the one before (1.000,
1.000, 0.800), and the carries change from frame to frame.

The port was graded against m2-hle2, whose `Fn_osage` matches MAME, on the
attract replay fight: each frame's struct, bufferram stream and unit-matrix
cache recorded, then for every pair of frames the port starts from frame N's
state, runs one frame on frame N+1's bones, and is compared with frame N+1's
records. Fang's, Honey's and Espio's tables were swapped into Sonic's empty
chain struct mid-fight, with bit 0 set so the game initialised them on his
bones.

| table | frame pairs | worst point | worst carry | limits reached |
|-------|-------------|-------------|-------------|----------------|
| Bean | 300 | 2.0e-6 | 1.8e-6 | floor, lines below the origin |
| Fang (root mode 2) | 600 | 2.4e-6 | 1.4e-6 | floor |
| Honey | 600 | 2.1e-6 | 1.3e-6 | floor, lines, spheres |
| Espio | 400 | 1.2e-6 | 0.9e-6 | floor, lines |

Airborne frames are among them, and bit 1 as the port leaves it matches the
struct on every pair. The residue is float32 rounding: the port runs in
doubles. Taking the bones from frame N instead of N+1 puts the points up to
1.58 out, so the chains run after the frame's rig. No table in the game uses
root modes 1 or 3, the cylinder never pushed, and Bark's table, whose records
have the same shape as Espio's, lost its swap before it could be graded.

#### Fighting Vipers

FV runs the same chains. Its main-CPU handlers are STF's moved by `+0x4ED4`,
and its own coprocessor program carries `Fn_osage` (`0x4A`) at PM `0x20733`:
compared word for word with cpres1's at `0x2076E`, the two differ only in
relocated jumps and one data address, and `Fn_sin`, `Fn_sinx` and `Fn_cosx`,
which it calls, match too. So `js/osage.js` steps FV's chains with the STF port
and only the data around it changes, in the `osage` block of the game's entry
in `js/games.js`.

The table at `0x63E34` has 26 entries, one per **record**, not per character.
P2 costumes and the bosses are records of their own, so Honey (`0x64810`) and
Honey P2 (`0x64AD4`) each have their eight twintail segments, and Mahler and
B.M. their tails. Jane's earrings and chain, Sonic P2's two tails and the rest
come out of the same table. Grace is the exception: the routine at `0x62860`
skips her table entry and picks one of two streams on her armour. If bit 2 of
`+0x7F4` is set (upper armour broken), it uses `0x63FCC`: the ponytail and the
earrings. Otherwise it uses `0x64154`, which is the first part of the same
stream, the ponytail only, with the earrings cut off. The explorer takes that
bit from the armour panel.

Gravity is `0.0052222` (`0x50A000`, stored at `0x7284`), about a fifth of STF's.
A KO slow-motion swaps in a smaller one, which the explorer leaves out.

FV's wind is switched on. `0x63B80` blows on five stages, picked by the stage
byte `0x500064`:

| stage | angle | entry |
|-------|-------|-------|
| 0 | `0xF000` | 0 |
| 1 | `0x8000` | 1 |
| 4 | `0xF000` | 0 |
| 5 | `0xC000` | 1 |
| 8 | `0x7000` | 0 |

The entry is one of two `{int16 speed, float amplitude}` pairs at
`0x63A58 + record*4` (entry 1 is 8 bytes on). Each frame the phase steps by the
speed, `s = amplitude * (sin(phase) + 2) * gravity`, and the vector is
`(cos(angle) * s, min(s, gravity), sin(angle) * s)` in world axes. The MATRIX
record adds it to gravity before turning both into the chain's frame:
`[wx, wy - gravity * scale, wz]`. There is no wind, and the phase and vector are
cleared, when there is no floor, or when the head (slot 2) is less than 0.5
above the floor. A low motion keeps the chains calm for that reason. Any other
stage blows only in modes 16 and 17, from the side `0x500065` names, and never
on Grace. The explorer leaves that case out. The Animation tab's sway panel has
a wind picker for the five stages.

#### Virtua Fighter 2

VF2 has the same chains a game earlier. Its handler table at `0x64524` (MATRIX
`0x64864`, COLI `0x64E5C`, ETC `0x65318`, TSUKENE `0x64CA0`, OSAGE `0x651BC`)
writes the same records, and the size table at `0x640C0` is FV's. `0x65384`
sends the stream as command `0x4A` and reads it back through `0x653D4`. On
Model 2A the coprocessor is the TGP, and the game uploads its program. There
`0x4A` jumps to `0xCFA`, which runs the record table at `0xD08`, and the
segment's keep-out at `0xDF2`-`0xEAE` is `keepOut` in `js/osage.js` branch for
branch.

The table at `0x658A4` has 26 records, like FV's: the 13 characters and their
P2 looks. Dural, Mue and Kojacky have none. Akira has his headband tails and
belt, Jacky fifteen strands of hair, Sarah her ponytail and earrings, Pai her
braid. Lion has his straps and hair. Shun has the gourd on his belt (bone 9)
and his hair. Gravity is `0x3B32674F`, `0.0027222`. The wind is FV's code on
`0x654E0`'s entries:

| stage | angle | entry |
|-------|-------|-------|
| 0 | `0x8000` | 1 |
| 1 | `0xF000` | 0 |
| 5 | `0xC000` | 1 |
| 8 | `0x7000` | 0 |
| 14 | `0xF000` | 0 |

The explorer leaves out:

- Game modes `0xE`/`0xF` (`0x50002B`) swap in the table at `0x696D4` for the
  player `0x50004C` doesn't name.
- A Lau-against-Lau fight in mode 2 picks from `0x697E8`.
- The replay draws the segment's `+0x20` model.
- A per-player switch, bit 1 or 2 of the word `0x500814` points at, hides every
  chain (`0x64348`). With Shun's gourd in hand (`+0` bit 27, script op 17), it
  instead draws only his first chain, the gourd's (`0x65458` stops at the
  record `0x69520`).

The TGP was graded in MAME (`vf2`, 60 s of attract). Every `0x4A` command's
stream was taken in bufferram as the i960 issued it and after the readback,
and the TGP's own copy of each COLI was taken at `0xD27`. Then `runCoprocessor`
ran each stream: 43,136 segments over Akira, Sarah, Kage, Lau, Jeffry, Pai,
Wolf, Shun and Lion. The worst point was 2.0e-6 (Shun), and under 2e-7 for the
rest. The TGP's COLI copy is needed because the bufferram copy is not final when
the command is sent. Pai's sphere centre (word 5) still read 0 there, while the
TGP read 0.2409. With the bufferram limits the same check is off by up to 0.08.

### Tails' tails

Tails' two tails are not on the sixteen-slot skeleton, and they are not a sway
chain either — his `osage_per_character` entry is the shared empty table. They
are a display routine of their own, `tails_tail_disp` at `0x1AB58`, ported in
`js/tails.js`, with two entry points that differ only in which tables they
load:

| entry | cycle table | pair | character |
|-------|-------------|------|-----------|
| `0x1AB34` | `0x1AE34` | `0x1AF34` | 1, Tails |
| `0x1AB48` | `0x1AEB4` | `0x1AF38` | 27, Tails (mirror) |

and the caller at `0x64504` picks between them on the character index at
`0x1B0(g7)`, so nothing else in the roster reaches this code.

The cycle table is 64 `u16` model ids: one tail modelled in 64 poses. There is
no interpolation and no bone — the pose *is* the mesh. Tails' are models
108..171 in order; the mirror character's are 1396..1459 **not** in order, and
putting the two tables side by side gives 64 pairs that are identical vertex for
vertex, so the shuffled order is exactly the remap that puts the second set back
into the same animation. Both tables close: the 64th pose is the 1st again, so
the loop does not jump.

`rob_disp` walks the sixteen slots and, after drawing each one's mesh,
dispatches on the slot through the table at `0x1A184`. Slot 9 — the pelvis — is
the entry that calls this routine, so the pelvis matrix is what is current when
it runs, and everything below is in that frame:

```
set_pos  0.1, -0.25, 0        where the pair hangs from
ang_z    0xC000               the roll that lays a tail mesh along it
ang_y    +0x1000 ; draw cycle[i]
ang_y    -0x2000 ; draw cycle[(i + 8) % 64]
```

The ops accumulate, so the second tail's own turn is `-0x1000`: the two splay
±22.5° about the hang axis. The eight-entry lead is what makes the pair read as
turning rather than as two tails waving in lockstep — one is always a
frame-and-a-bit ahead of the other through the same wave.

`i` comes from a counter at `0x2198(g7)` that the routine steps itself, once per
displayed frame, wrapping at 64. It is not the motion frame, and the viewer
keeps it apart for that reason: most of Tails' motions are shorter than 64
frames, and folding the cycle into one would show only its first few poses
forever. `state.motion.tick` is the counter — the same clock the motion frame
comes off, before it is folded — so playing steps both at 60 Hz and a scrub
steps both by the same amount.

Two more branches of the routine are decided outside the keyframe block.

**The propeller.** Bit 16 of `0x7F0(g7)` swaps the cycle for the pair beside it
— 1221 and 1222 for Tails — alternating on the frame parity and turned by
`0x500020 * 0xD80` about Y, which is 19° a frame: the blurred disc his flight
moves are drawn with. The motion script sets it: op `0x27` sets the bit and
stores its signed byte at `0x7F4(g7)`, op `0x28` clears both, and `set_mot_dat`
clears the bit when a motion starts (see [Afterimages](#afterimages-jszanzoujs)
for the script). Nine motions use it. `tails_shippo_func_exec` (`0x1AC38`)
picks a routine by `(0x7F4 - 1) & 1`:

- `1`, `tails_heli_disp` (`0x1AC58`): the view matrix at `0x5010F8`, `set_pos` by
  `0x1F4(g7)`, `ang_y` by the facing at `0x26(g7)`, then `set_pos 0.14, 0.18,
  -0.17`. `0x1F4` is the waist: `calc_unit_mat` stores it from `0x07800F0F`
  straight after placing slot 0. So the disc rides the waist, turned with him
  but not with the body's lean — the flying moves 301, 466 and 495, which carry
  him eight units up.
- `2`, `tails_screw_disp` (`0x1AD84`): on the pelvis's matrix, `set_pos 0.15,
  -0.2, -0.15`, `ang_z 0xF000`, `ang_x 0x8000` — the dashes 365, 366 and 396–399.

Either replaces the pair: the tails are not drawn while it is up. The viewer
reads the script, draws it on the frames it is on, and the panel says which.

**The `0x8000` roll.** `ang_z` is `0x8000` rather than `0xC000` when bit 16 of
`0x1A4(g7)` is set. That word is initialised per motion, at `0x1B4EC`, where bit
16 is set from bits 8 and 15 of the motion record's own flag word — but no
motion in the table has both bits, so it is only ever set later by game logic
the viewer does not run. `0xC000` is the roll for every motion as it starts.

The routine also returns without drawing anything when the skeleton type at
`0x84C(g7)` is 3. Type 2, the hammer-squished form, still gets its tails, which
is why the **hammer squished** checkbox does not take them away.

### Metal Sonic's jet exhaust

The same slot dispatch has a second entry with a fighter behind it. Slot 1, the
chest — `unit_efc_mune` — reads the character byte at `0x1B1(g7)` and branches
twice:

```
cmpobne 4, r4, loc_1A274 ; call efc_fang_gun_disp        Fang
cmpobne 3, r4, loc_1A27C ; call efc_metalsonic_disp      Metal Sonic
```

That byte is the roster index folded onto the base half, which is why character
29, Metal Sonic (mirror), gets the flame as well. `efc_metalsonic_disp` at
`0x1AABC` is ported in `js/exhaust.js` and is short enough to quote whole:

```
ld    0x0(g7), r3
bbs   29, r3, ret            not while the fighter is on display
ldos  0x40(g7)[1*4], r3      the chest object currently installed
cmpobe 0x18D, r3, ret        397  — the closed chest
cmpobe 0x7E4, r3, ret        2020 — the closed chest, recoloured
ld    frame_counter, r3
shro  1, r3, r5 ; and 3, r5, r5
bbs   0, r3, burst
ldos  yellow_cone_exhaust[r5*2], r4  ; set_obj r4 ; ret
burst:
ldos  yellow_burst_exhaust[r5*2], r4 ; set_obj r4
```

`set_obj` draws at the matrix that is current and nothing moves it first, so the
plume is drawn on the chest's own matrix with no `set_pos` and no turn: it is
the mesh that puts it behind him, and the chest's `+Y` is the axis it runs down.
Over 3088 plumes across every one of his own motions the far end of the flame is
behind the head's `+X` — the same forward the tails are checked against, and
checked the same way, off the end of the head the eye models sit at.

Two tables of four `u16` sit at `0x1AB24` and `0x1AB2C`, immediately before
Tails' two entry points. The frame counter picks a table on its bottom bit and
an entry on the two above it, so the cycle is eight frames long and alternates
the two shapes:

| frame | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|-------|---|---|---|---|---|---|---|---|
| cone `0x1AB24` | 2453 | | 2454 | | 2455 | | 2456 | |
| burst `0x1AB2C` | | 2534 | | 2535 | | 2536 | | 2537 |

The cone stretches from 0.50 to 1.49 along the axis it runs down and the burst
widens from 0.77 to 1.55 across it, so each table is in order as well as read at
the right stride. And the reading does not have to be argued: the same eight ids
appear a second time, in that interleaved order, as `u32` at `0x97568` —
`metal_and_lunar_fox_exhaust`. Getting the stride, the base or which table goes
with an even frame wrong fails against it.

**When is the script's.** The flame is gated on the chest object, and the
chest is swapped by op `0x10` in the per-motion script (see
[Afterimages](#afterimages-jszanzoujs)):
`player_body_change_action` at `0x33308` reads `player_body_animation[char]` at
`0xC6710` and stores the entry the command's byte names into `0x40(g7)[slot*4]`
— the same sixteen-entry array `rob_disp` draws each slot from, which
`calc_rob_angle_int` fills from the part table when a rig is installed. Metal
Sonic is the only entry in that 52-character table with a body list at all, and
his is two ids long:

| | model | |
|-|-------|-|
| closed | 397 | the chest his part table holds |
| open | 2461 | the same chest, reaching 0.06 further along the flame's axis |

So the pair is one effect — the vent opens and the flame lights together — and
2020, the guard's other rejection, is 397's mesh and texture points under a
second set of face colours. Op `0x10` is `[slot][entry]`: `load_action_from_list`
(`0x330D0`) indexes `player_action_list` by the slot byte, and slot 1's handler
is this one. 86 commands name slot 1 — about eighty generic motions close the
vent on their first frame, and 320, 326, 327, 328 and 459 open it. The chest is
**not** reset when a motion starts (`set_mot_dat` resets only the two hands), so
a motion that says nothing keeps whatever the last one left. The viewer follows
the script on the frames after its command, and **vent open coming in** on the
Animation tab stands for the chest before that; the flame follows by the
routine's own test, and the panel says which of the two decided it.

One consequence of implementing that test rather than the switch: the
hammer-squished chest is 1652, which is neither of the two ids the guard rejects,
so a squished Metal Sonic flames whatever the switch says. That is what the ROM
does — the squished set is installed into the same array, by the same routine —
and the panel says so rather than hiding it.

### The Egg robots' timed animations (`js/eggrobo.js`)

Two more things `rob_disp` draws that are in no keyframe block. Both are stepped
by the board's own `frame_counter` at `0x500020` and gated on the character
byte, so — like Tails' tails and the jet — they keep running on a motion held at
one frame, and the viewer steps them off the display counter for the same
reason.

**The Final Eggman Boss's arms.** `efc_eggrob_mune_chg` at `0x33758`, called
from `rob_disp` at `0x1A264`:

```
ldob  0x1B0(g7), r3        ; the character
mov   0xB, r4              ; 11, the boss
addo  0x1F, 6, r5          ; 37, its mirror
cmpobe  r3, r4, +          ; nobody else reaches this
cmpobne r3, r5, ret
ld    0x1A4(g7), r3        ; p1_mot_kind
bbs   14, r3, hold         ; that bit pins it mid-swing, at model 4130
ld    frame_counter, r4
shro  1, r4, r4            ; a new model every second frame
and   0xF, r4, r4          ; sixteen of them
ldos  egg_mech_arms[r4*2], r4
call  set_obj
```

`egg_mech_arms` at `0x34E96` is nine models, 4126–4134, and then the same nine
back down without repeating either end: a sixteen-entry ping-pong, so the arms
swing out and back over 32 displayed frames and the cycle closes. "mune" is the
chest, which is the matrix `rob_disp` has current when it calls — so this is an
extra object hung on the chest rather than one of the sixteen slots, and the
viewer draws it at slot 1's matrix with nothing moving it first, the same way
the jet is drawn.

**The Egg Minion's head.** `rob_disp` again, at `0x1A024`, on slot 2 and
character 13:

```
cmpibne 2, r8, +           ; the head slot only
ldob    0x1B1(g7), r14
cmpobne 0xD, r14, +        ; the Egg Minion only
ld      frame_counter, r4
bbs     7, r4, +           ; both bits clear, so it runs for 64 frames
bbs     6, r4, +           ; out of every 256 and is still the rest
shro    4, r4, r5
and     3, r5, r5          ; which quarter of those 64
and     0xF, r4, r6        ; the step inside it
ld      egg_robo_anims[r5*4], r5
bx      (r5)
```

The four quarters are `nobi` (stretch), `gururi` (spin), `tizimi` (shrink) and
`ex`, which draws nothing — the head stretches, spins, shrinks and then holds,
48 frames of movement in every 256, the fourth quarter as idle as the 192 frames
outside the window. Stretch walks `egg_robo_head_anim` (models 2981–2991)
forward and clamps at its last entry; shrink walks the same table with the step
read backwards. Spin holds the last model and turns it instead:

```
mov  0xA, r5                       ; the eleventh model
bbs  8, r4, +                      ; bit 8 flips which way it goes round
shlo 0xC, 1, r5   -> 0x1000
+ shlo 0xC, 0xF, r5 -> 0xF000      ; which is -0x1000 in binary radians
mulo r6, r5, r6                    ; step x that, so sixteen steps close
```

A full turn either way over the quarter's sixteen frames, and the direction
alternates every 256 frames because bit 8 is the next one up from the window.
The op it writes the angle with is `0x5000A0A` — opcode `0x0A`, `ang_z` — so the
turn is about the **head's own Z**, the axis the head's aim turns it by first.
`js/eggrobo.js` reads
`egg_robo_anims` rather than assuming the order, so a table edited in the ROM is
followed rather than the four routines being hardcoded in sequence.

There is no capture of either to check against — `stf-tools/` has nothing that
drives a machine to a boss or a minion — so what stands in for one is the
instruction stream itself. `stf-tools/test-motion.mjs` walks both routines with
`stf-tools/i960dis.mjs` and holds the port's constants against the operands the
board's own code carries: the shift and mask that step each cycle, the window
bits, the clamp, the spin's step and its direction bit, the two character
indices, and the `ang_z` op word. The three tables are pinned without an
address being named at all — every address a routine's instructions mention is
collected, and the table the port produced has to be readable at exactly one of
them, which sixteen exact model ids do not survive being wrong about. On top of
that the arithmetic is checked on its own terms: the arms fold and close, the
held pose is the middle of the ramp and not of the sixteen, 48 of every 256
frames move the head, the spin closes a full turn and reverses on bit 8, and
the fourth quarter draws nothing because its routine *is* the address the
guards branch to when the robot is not the minion at all.

### Afterimages (`js/zanzou.js`)

A fast hand, a spin kick or a dash leaves a streak of copies behind it. None of
it is in the keyframe block, and almost none of it is the main CPU's: the
coprocessor keeps the trail. The viewer runs the same machinery from the three
places it is decided.

**The motion script turns it on.** The 13-byte record `mot_list` points at is
only a head. `set_mot_dat` walks on through a setup byte-code (dispatch at
`0x1B558`, 25 handlers at `0x1B568`, each moving `r11` on by its own length)
until op 0, no script, or op 8, whose next byte is where `P1+0x82C` is left. The
play script behind it is what `play_motion` walks each frame from `0x1C088`:

```
[op][frame u16][operands...]      ; runs once P1+0x1AA reaches the frame
ld   _uk_player_actions[r3*4], r5 ; 44 handlers at 0x1D1AC
bx   (r5)
ldob byte_1D01F(r3), r7           ; a command passed over skips by this
```

Every handler adds to `g4` exactly what `byte_1D01F` says for its op, so that
one table walks any script (`readMotionScript` in `js/motion.js`). All 518
motions walk cleanly to their terminators. Action **0x26** is the trail:

```
[0x26|0x80][frame][mask u16 -> P1+0xC60][step s16 -> +0xC62]
                  [turn u16 -> +0xA1E][spacing f32 -> zanzou_ma]
```

The mask is the sixteen rig slots (`0x20` the left hand, `0x100` the right,
`0x9000` both feet, `0x200` the pelvis); zero turns the trail off, and
`set_mot_dat` zeroes it whenever a motion starts. 134 of them sit in 50 motions,
every one inside its motion's length. Only 322 and 323 (Metal and Super Sonic)
are in an action table; the rest are attacks, which is why the motion list marks
them.

**`zanzou_control` (`0x8AA38`) feeds the coprocessor** once a frame: the spacing,
`Fn_zanzou_inc` (0x82) to age every copy, then per fighter
`Fn_zanzou_kill_timer_buffer` (0x86) if its mask is zero or
`Fn_zanzou_reserve` (0x80) if not. The reserve carries the mask (left and right
swapped for a fighter facing the other way), the step, a bone length from
`0xB5258[skeleton][char]` — 0.5 for everyone — and for each part in the mask the
three models its copies fade through, u16s at `table[char] + part * 8`, where
the table is `0xB540C[skeleton]`, or `0xB55BC` while the fighter holds an option
(`P1+0` bit 27, which changes nothing but the mirror Sonic's). The models are
single streak cards: Sonic's hands are 2220–2222.

**The coprocessor's ring** is ported from m2-hle2's `sharc_zanzou.h`
(cpres1 PM `0x208E1`–`0x20A8E`). The firmware measures the farthest any trailing
part moved since last frame — its joint, and a point one bone length out along
its own +X — and lays one copy per `spacing` of that into a 128-slot ring, each a
linear blend of last frame's matrix towards this one's, at most 100 a part.
More than 13 squared units is a teleport and lays nothing. A part's first copy
starts at life 0 — `send_zanzou_data` writes 3 there at boot, but
`Fn_zanzou_init` clears it when a fight sets up and nothing writes it again —
and life climbs by one per copy while the trail runs; the
step takes it back down each frame, and the model is picked by what is left.
The matrices are the unit cache's, the ones each part is drawn with, so the ring
runs on `buildPose` as it stands.

**`zanzou_disp` (`0x8ACD0`) draws.** For each ring slot with life left:

```
ld    frame_counter, r4
addo  r3, r4, r4              ; + the slot
bbc   0, r4, skip             ; drawn on odd sums only
push; 0x84 slot matrix; ang_x(mod_fa_tobi+0x5C); set_obj(model); pop
```

There is no translucency: a trail fades by flickering, neighbouring copies out
of step. The X turn is a halfword of the projectile module's header that no
instruction writes; read live in m2-hle2 through attract and its fight it is 0.

The ring remembers, so the viewer steps it a frame at a time and replays the
motion from its first frame after a scrub back or a jump; playing and stepping
give the same copies.

It is held against the board by `stf-tools/test-zanzou-mame.mjs`, on a MAME
capture of a coined fight (attract never brings up the projectile module
`zanzou_control` belongs to). A fight lays too few trails of its own, so the
capture writes P1's trail fields case by case; what the i960 sends and what the
SHARC lays are the board's. Before each reserve it snapshots the SHARC's data
memory at the firmware's first store to the part-model table — header done,
nothing laid — so the snapshots chain: the port is started from one, aged a
frame at a time and held against the next. All 900 reserves of a 900-frame
capture reproduce the firmware's next ring exactly, matrices to 4e-7; all 901
reserves carry the mask, step, turn, spacing, bone length and models the tables
here say; and the script's trail command and propeller agree with work RAM on
every fighter-frame. That first run is what showed a fight's first copy starts
at life 0 rather than the boot value of 3.

### Holding it against the machine

`stf-tools/mame-motion.py` drives a real fight under MAME and records every word the
i960 writes to the coprocessor, with the motion number (`p1_motion_num`) and the
motion frame (`p1_motion_coma`, which starts at 1) beside each frame's slice.
The `0x62` and `0x6B` arguments in that stream *are* the sampled channels, so
they can be held against what the viewer decodes for the same motion at the same
frame. Both fighters are in the stream; an `ik_2bone` names the pair of TGP
slots it writes into, and those words are per player and per limb, so a command
says which fighter and which limb it is without depending on emission order.

Over 300 frames and 1200 IK chains of two motions on two characters, the joint
angles come back **bit-identical** — nought binary radians of difference — and
the waist position and the four IK targets agree to float32 rounding (`2.4e-7`
and `7.2e-7` worst). The limb pivots, the bone lengths and the bend direction
match outright. That is the check on the whole format at once: a Hermite channel
only lands on the same 16-bit angle every frame if the header walk, the key
streams, the interpolation and the tangent scale are all right.

`stf-tools/motion-pose.csv` is one such recording, kept so the check runs without a
MAME, exactly as `canyon-path.csv` is for Canyon Cruise.

### What a motion leaves out

When the game starts a new motion it does not cut to it: `play_motion` calls
`smooth_int` at `0x2F2B0`, which eases out of the pose the fighter was already
in over the first eight frames. The capture shows it plainly — the gap between
board and viewer is widest on the frame after a motion starts and falls away to
nothing by the eighth, after which the two agree to float precision for the rest
of the motion. A motion picked on its own is cut to, since there is no pose
before it to ease out of, so those eight frames are reported by
`test-motion-mame.mjs` rather than asserted on. A string of moves does ease —
see [Moves and strings](#moves-and-strings-jsmovesjs).

One more thing the board does with a motion and the viewer does not: the replay
path's half-frame sampling, which is how slow motion works. It changes *which*
frame is asked for, not what a frame decodes to. The frame remap table at
`0x854(g7)`, a per-move timing curve `get_frame_dat` would interpolate the frame
through, turns out to change nothing: only setup op `0x10` sets it (`0x1BB1C`,
pairs of bytes, the motion's length taken from the last), `set_mot_dat` clears
it at every motion start, and none of the 519 motions carries that op.

### Moves and strings (`js/moves.js`)

The 52 action slots are how a fighter stands, walks, is hit and gets up. The
attacks are not in them: the game reaches those through the input matcher, and
the Animation tab now lists a fighter's moves the way the matcher has them —
under the buttons that do them — and plays a string the way the game strings
it. The two tables and their readings come from the stf-fly project
(`flystf/matcher.py`, `combos.py`, `moves.py`), which typed the decoded inputs on
a running board and read back the motion each one started.

**The matcher.** `MOVESET_ARRAY` (`0x1EFAC`) holds a pointer per character id
(the `CHAR_PARTS` index; the mirror half takes 26 off) into a byte-code program
that `_uk_execute_move` (`0x1E458`) runs over the fighter's input ring every
frame. A table is a run of 7-byte headers, opcode `0x0E`: a u16 key — the
buttons in the low byte (P 1, K 2, G 4) and a context in the high byte, 0 on
the ground — and the address of the script that key runs. The handlers are at
`COMMANDS_BEGIN` (`0x1F00C`), 64 of them, and each steps the program counter by
its own `addo N, g4, g4`, which is where the operand lengths come from. A
script is a run of blocks, each opened by a fallback (`0x0F`, `0x27`: where to
go if anything in the block fails) and closed by a commit (`0x05`, `0x06`) that
writes a word to `p1_command`; its low sixteen bits are the motion that plays.
Inside a block the tests are direction states walked backwards through the
input ring (`0x00`–`0x03`, `0x1E`), a three-way branch on whether the stick is
forward, back or neither (`0x28`, `0x1EB5C`), bits of the fighter's state
(`0x08`: `P1+0x000`), of `p1_en_flag` (`0x07`: `+0x5B8`), of the motion kind
(`0x09`: `+0x1A4`) and of the opponent's (`0x2A`), and the distance between the
two (`0x1A`, `0x1B`).

So the first block whose tests pass is the move, and walking the script depth
first with a stack of fallbacks visits the commits in exactly the engine's
order: the main path, then the innermost fallback, then the one outside it. That
order matters, because one button has many entries. Sonic's P is one move with
state bit 29 up, half a dozen with bit 30 up, one each with motion-kind bit 27
and with `en_flag` bit 0 — and, with none of those, the neutral branch's plain
jab, motion 249. The viewer shows moves in one
situation: standing, facing a standing opponent at an ordinary distance, out of
hyper, every flag clear. An entry is *reachable* when typing its own input into
its table lands on it rather than on something ahead of it; the list gives each
motion under the plainest reachable input, and the motions only another
situation reaches go in a second group with the bits they need. What most of
those bits mean is not read yet, so they are named by number.

**Strings.** Just before a commit, `0x0D` parks the address of another table of
the same shape in `p1_pc_command` (`P1+0x1218`): the moves that may follow this
one. A string is that, repeated — Sonic's jab parks `0x8233C`, whose P is the
second punch, whose table's P is the third. The follow-up's commit waits
(`0x12`, `0x1E7D4`) until `p1_motion_coma + 1 >= p1_follow1 + n`, and
`p1_follow1` is the motion's **cancel frame**: setup op 2 (`0x1B628`) copies
three u16s into `p1_info`, `p1_follow1` and `p1_follow2` — the frame the attack
can first connect, the cancel frame, and the frame the fighter comes free. So
the old motion's last frame on screen is the one before cancel plus `n`, and
the animators knew it: the joint angles Sonic's second punch opens on are the
ones his jab holds at frame 15, one short of its cancel frame of 16, to the
last binary radian — and the third punch picks up the second's frame 11 the
same way. A move that is not a
follow-up waits for the fighter to be free, at `p1_follow2`. 333 of the 519
motions carry op 2; the rest keep their length in all three.

**Names.** `debug_cpu_movesets` (`0xDE278`) is the table the CPU opponent is
driven from: 0x2C-byte records, a pointer to the move's name (`SNC_hataki`),
which hit of a string it is, the damage, and the input the CPU types — a stick
and button byte per step, `0x7F` ending it, and a frame count per step
(`stick_control_normal`, `0x3E588`). Each record's input is cut at its presses
and typed into the tree, a string's later presses into the tables the earlier
ones park, and the entry it lands on takes the name with the character's prefix
off. The table covers characters 0–10; 11–15 point at a copy of Sonic's, so the
Final Eggman Boss, the robots, Honey and Super Sonic have their moves listed by
motion number rather than borrowing names that are not theirs. A record that
jumps before its first press is an air attack and is left out.

**The ease.** `smooth_int` keeps the pose the fighter was in as a new motion
starts, and `calc_rob_angle_cont` adds back a share of the difference for the
first frames (`0x305B0`): the difference over N a frame, times N minus the
motion frame. N follows the new motion's length — none for two frames or fewer,
then 1 up to 4 frames, 2 up to 8, 4 up to 16, and 8 for anything longer — and
the angle share is an arithmetic shift of the difference, the float share a
multiply by 1/N. The board takes the angle difference as a rotation, composing
the old joint rotation with the inverse of the new on the coprocessor
(`0x2A005454`) and reading three angles back; the viewer takes it channel by
channel, which agrees for the small turns an ease usually spans and not
exactly for large ones. There is a checkbox to cut instead.

The string panel under the frame slider shows the chain as chips, the follow-ups
the last move's table offers as buttons, and a list to put any move after it
once the fighter is free. Changing fighter retypes the string: each press goes
through the new fighter's tree, so Sonic's P, K and half-circle P become
Knuckles' own. A view link carries the string as its entries' table addresses.

## Textures

The sheets are not in ROM in a readable form: the game unpacks them into
texture RAM on every scene change. `js/texture.js` is a port of the routines
that do that, so the viewer builds them from the ROM alone — no dump, no
emulator. Tracing `send_tex_stage` through `unp_send_tex_para_sub` gives the
layout:

- `main_data + 0x30000C` holds a table of per-texture-set descriptors, indexed
  by the texture number a stage names in its record (`+0x0C` / `+0x0E`, 0–0x11).
- A descriptor is `{ index, page pointer × 24 }`; each page is 256×256 texels,
  with its destination in texture RAM decoded against the page table at
  `0x4B394` — 24 pages of a logical 2048×1024 sheet, `x >= 1024` folding to
  `y + 1024`, which is the same fold `atlas.js` undoes on the way back out.
- A page whose first word is `1` is raw texels (`send_beta_data`). A page whose
  first word is `0` is compressed (`unpack_lod_data`) — about 85% of them.

The codec is an LSB-first bitstream driving a Huffman tree, decoded eight bits
at a time through the 256-entry table `make_huf_8bit` builds and walked by hand
for longer codes. Leaves carry a 4-bit tag: literals come from a 256-entry ROM
table, from a per-page indexed table, or inline in the stream; runs repeat the
current texel. A texel is a delta on a running 4-bit value, and each decoded
halfword is that value smeared across all four nibbles (`i * 0x1111`) plus a
payload — so a flat block costs almost nothing. `send_lod_data` expands the
runs into the full-size level and `send_lod_data_q` box-filters the mip chain,
which alternates banks at every level.

Two details are worth keeping, because both are load-bearing and neither is
obvious from the listing: the `cmpdeco` loops are bottom-tested, so a run count
of 256 masks to a byte of zero and still writes one element; and the tree walk
advances its bit index *before* testing for a leaf, which is what makes the
eight bits the fast table already matched come out of the stream.

### The mip chain

Unpacking a page writes more than the full-size level: `send_lod_data_q` box
filters the whole chain down to 2x2 and scatters it through texture RAM, so the
atlas has always held it. Only the addressing was missing, and without it the
viewer sampled the full-size level at every distance — which is what turned
4-bit dithered art into static as soon as a surface got small. Measured against
the bridge, neighbour-pixel difference climbed from 24 at four units away to 52
at sixty-four; that climb *is* the aliasing.

Level L of a tile sits at `((texx - 2048) >> L) & 2047`, `((texy - 1024) >> L) &
1023`, halving in size, on the sheet that alternates with L
(`model2rd.ipp fetch_bilinear_texel`). The arithmetic is unsigned because the
board's is — the subtraction wraps, and the wrap is what puts the mips where they
are. At L = 0 it reduces to the tile itself. Each level checks out as a 2x2 box
filter of the one above it to within 0.4 on a 0-15 texel scale, which is the
rounding in the board's own integer `sum >> 2`.

Which level to use is the one place this departs from the hardware. The board is
handed a `texlod` the geometry engine computed from the polygon's distance
(`coef[attr>>27] * |dotp| * lod`, the coefficients in ROM at `0x90BA0`), and that
number is calibrated to 496x384. This viewer runs at whatever size the window is,
so it asks the same question with screen-space derivatives instead: how many
texels does this pixel cover, at the resolution actually being drawn. With that
in, the same measurement runs 27 to 36 rather than 24 to 52.

`node stf-tools/test-texram.mjs` checks the port against a MAME capture of the real
board, and it reproduces all 2 MB byte for byte. The capture itself is not in
the tree — see [Checking against the board without carrying its
data](#checking-against-the-board-without-carrying-its-data) below. (Set 16 has
to be unpacked first: the attract and character-select screens leave it
resident, and a stage's sets overwrite everything except the deepest corner of
its mip chain.)

## Colour tables (`js/colors.js`)

A 4-bit texel is neither a colour nor a brightness on its own. It indexes a
128-entry band of luma RAM picked by the face's `lumabase`; that value, scaled
by the face's lighting term, indexes colorxlat against the face's 5-bit palette
colour. Both tables are RAM, and the game fills them from `main_data` on every
scene change. `js/colors.js` is a port of the routines that do it, so the viewer
builds them from the ROM alone, like the sheets:

| routine | what it writes |
|---------|----------------|
| `essential_color_handling` | luma RAM, copied straight from `main_data + 0x0D000C` |
| `chg_pol_color_req` / `_send` | the ramp, luma 1–47 of colorxlat rows 0–27 |
| `chg_scr_color_req` | one flat value per row, luma 64–127 |
| `send_tex_col_stage` | the scene's own sixteen colours, luma 48–63 of rows 14–27 |
| `send_tex_col_part` | a fighter's own five rows: 0–4 for player 1, 7–11 for player 2 |
| `send_tex_col_skin` | a fighter's skin, luma 0–63 of rows 28–29 / 30–31 |
| `0x7b4` | rows 5–6 and 12–13, out of two tables of their own, once at boot |

The ramp is `((84 · colorbase · luma) >> 8) + 22`, where 84 is `TST_RED_MUL ·
28 / 18` and 22 is `TST_RED_ADD` — the test-menu colour settings, which
`check_sram_all` defaults to 22 / 54 / 31 and `stage_disp` then trims per
channel by `stage_RED/GREEN/BLUE`. That trim is why the viewer no longer applies
a stage tint in the shader: it is already in the table.

`send_tex_col_stage` is the interesting one. It picks a block of sixteen
colours with the stage record's *second* texture number, runs each through
`color_intensity` — `(x - 116) · 54 / 37 + 22`, clamped, trimmed — and writes
them over the top of the ramp. So rows 14–26 stop being a brightness ramp above
luma 48 and become a palette, and a face that lands there is palettised: its
grey `colorbase` is a row, and its texel is which of the sixteen.

#### Four uploads, one loop

The last four rows of that table are the same routine. `send_tex_col_loop` at
`0x858` — `0x84c` for the stage's wider block — takes a first row, a row count, a
block index and a table pointer, and lays sixteen colours per row into colorxlat
through `color_intensity`, three channels `0x20` apart with `0x60` to a group.
Only where each caller reads from and which rows it writes differ, so
`js/colors.js` has it once, as `sendTexCol`.

Reading it settled the stage block's own row count as well. The loop is bottom
tested — `cmpinco g2, r5; bg` runs `g2 + 1` times — and `send_tex_col_stage`
passes 13, which is the fourteen rows the port had already had to infer from a
capture to stop the Flying Carpet's planters coming out black.

**Two of the four are per fighter, and that is what the rows below 14 are for.**
`send_tex_col_part` is handed a player number, turns it into a row base of 0 or
7, and reads the character out of `p1_parts` / `p2_parts` `+0x1B0`; a character
at or past 26 indexes a second table with 26 taken off. `send_tex_col_skin` is
the same shape with two differences: sixty-four colours over luma 0–63 rather
than sixteen over 48–63, so a skin row is a ramp of its own rather than a
palette laid over one, and its second half is the same table `0x2400` further on
rather than a second pointer. Between them and the boot pair, every row a face
can name is written: of the 4404 models that carry geometry, the ones with a
face on a palette band name rows 0–27 and nothing outside them.

Rows 0–13 were the ones nothing wrote, and a face that landed there read zero
and came out black. **Model 793 is Eggman's head.** Its lenses are two quads
emitted a second time over the frame's, on the transparent renderer, at luma
band 1 with a `colorbase` of zero — so their sixteen colours are row 0 at luma
49–63, which is Eggman's own blue-to-white ramp and was black. 210 models have
such a face; 155 of them name the boot pair, which is fixed for every scene, and
the rest name a fighter's, which is why `js/app.js` carries the character that
owns a mesh alongside the scene that draws it.

Almost nothing names player 2's rows — one model in the ROM names row 7 and none
names 8–11 — so a part both sides wear reads player 1's block whoever is wearing
it. 793 is one of those: Eggman and his second-half twin are the same mesh, and
the twin's own block has a black row 0. That is the board's answer rather than
an approximation of it, and it is why the viewer uploads one character rather
than two.

`node stf-tools/test-colors.mjs` checks both tables against the same capture, row by
row — which is the unit every one of its comparisons was already made in, so
holding it to hashes rather than to the capture costs it nothing. Luma RAM
matches byte for byte, and so now does every colorxlat entry bar the two rows
the game is animating. The capture does not record who
was on screen, so the fighter rows are checked the other way round: some
character has to reproduce all seven of player 1's exactly, and the set that
does has to be the twelve fighters, who share one part block and one skin block
between them. One character matching would be luck; twelve is the tables.

### Microtextures

The other end of the chain. A face can name a 128x128 detail square, and the
board blends it into the texel wherever the face is magnified past its full-size
level, by `min(-mml >> minlod, 127) / 256` — never quite half — with mml the
level in 128ths (`model2rd.ipp draw_scanline_tex`). Header 0 bit 12 turns it on
and bits 10-11 are its minimum LOD; header 2 bit 13 is its column and bits 14-15
its row, in 128s, on the sheet the face's own tile is *not* on
(`model2_v.cpp`). It is addressed by the face's own coordinate shifted left by
`1 << minlod`, so it is two to 256 times finer than the texture it sits on.

The House of the Dead is the game that uses it, and uses it as the pattern
rather than as a detail: the mansion's wallpaper and its floor tiles are the
microtextures, and the textures underneath are grime. Without it those rooms
are plain smears up close. The prototype sets it on 1,093 triangles in 27 room
models of the first half of its model table and the final game on 1,623 in 43
(PN_room_n1a's floor is model 3315 there, 3169 in the prototype); Sonic The
Fighters and Fighting Vipers never set it.

The prototype's second half sets the bit on 66,000 triangles, and that is
noise. Its uv and material pointers are the first half's with every one at
word 0x400000 or above moved down 0x200000: the table relocated for a texture
ROM whose second pair starts at byte 0x400000, chips half the size of the 4MB
flash the prototype has. On that flash the moved pointers land in the first
pair's upper half, which is bank 7's records and then erased bytes (`ffff`,
`00ff`, `ff00`), so 46% of those faces read the enable bit as set, against
under 1% in the first half. The game never reads the second half: all
thirteen `lda 0x2C5D1F0[...*16]` index by the model number, nothing adds 5049,
and a MAME read tap on it stayed at zero through ten minutes of attract and
ten of Chapter 2, which read a moved-pointer bank of the first half 1.8 million
times. It is not the green blood option either: that swaps single models (0x593
or 0x594, sub at 0x486A8, test-menu byte 0x51E49E).

The board samples the square at full size however fine the shift makes it,
which at 256 times is noise. Texture RAM holds no mip chain for the squares, so
`microAtlas` (js/atlas.js) copies the corner they live in (256x512 of each
sheet) into a texture of its own, which WebGL mipmaps; each square is a power of
two on a power-of-two boundary, so its levels never mix with a neighbour's. The
shader reads it at the pixel's own footprint, and the blend fraction off the
same screen-space level the mip chain uses. The *microtextures* switch turns it
off.

### Ramp bands and palette bands

Luma RAM decides which of the two a face gets, and the split is clean:

- bands 0, 2, 3, 5 and 6 start at zero and climb — a lit surface, where the
  texel is how bright the pixel is;
- every other band lies wholly in 49–63 — the sixteen palette slots.

A palette band cannot be shaded. Multiply it by anything below one and the face
drops out of the palette rows into the grey ramp underneath, which is exactly
what South Island's sea, palm fronds, waterfall and ring floor looked like
before any of this was in. Such a face has to reach the fill path at a luma of
255, and it does: they all name material slot 31, which the stage uploads as
diffuse 0 and ambient 255. See [Lighting and colour](#lighting-and-colour) — the
band split is a consequence of the material table, not an input to the viewer.

The 64 palette bands past the first two are the same sixteen slots rotated one
step further each: that is the scrolling water, animated by moving a face from
one band to the next — see [The ocean](#the-ocean-a-texture-header-per-frame)
for the code that moves it. The waterfall runs on a different mechanism, and the
capture caught two of the stage's colour rows mid-cycle, which is why
`test-colors.mjs` compares those two as a rotation.

## Checking against the board without carrying its data

Both of those checks are only worth anything because they measure against
hardware. `js/texture.js` and `js/colors.js` are ports, and a port that is
graded by its own output is not being graded at all — so the reference has to be
something the board produced, not something this code produced.

For a long time that reference was the capture itself: `texram0.bin`,
`texram1.bin`, `lumaram.bin` and `colorxlat.bin`, 2.2 MB of Sonic The Fighters'
texture RAM, tracked in git. That is the game's data, and it does not belong in
this repository any more than a ROM does.

What the checks actually need from those bytes is not the bytes. It is the
statement *the board held exactly this*, and a hash makes that statement in 32
bytes without being the data. So `stf-tools/texram-ref.json` holds SHA-256 over the
capture, cut at the granularity each comparison is made at:

| slice | why that unit |
|-------|---------------|
| each sheet whole | the assertion: 1 MB, byte for byte |
| each sheet in 64 kB blocks | localisation only, truncated to 64 bits — a digest otherwise cannot say *where* it went wrong |
| luma RAM whole | it has to match outright |
| colorxlat per row, all three channels | the colour check was always per row: some rows are a character's, some the stage's |
| colorxlat per row over luma 0..63 | the fighter rows, which are searched over all 52 characters |
| each cycled row's 16-slot palette band | searched over all 16 rotations, so it is hashed apart from its row |

`stf-tools/texref.mjs` defines those slices once and both the manifest writer and
the two checks import them, so the two can never drift into hashing different
things. The result is 4 kB in place of 2.2 MB, and it asserts exactly what it
did before: a single wrong texel fails. What is lost is only the byte offset in
the failure message — a wrong sheet now reports the 64 kB block and a wrong
colorxlat the row. Point `$STF_TEXRAM` at a real capture and `test-texram.mjs`
adds the byte offset back.

### The trap in doing this

There is an obvious way to get rid of the tracked capture that quietly destroys
both checks: rebuild the four files from the ROM with the ported routines and
call *that* the reference. It costs nothing to write, it passes, and it is
worthless — the port would be measuring itself, and every bug in it would be in
the reference too, agreeing perfectly.

So the two paths are kept apart and the boundary is enforced rather than
documented:

- **`stf-tools/extract-texram.mjs`** rebuilds the binaries from a ROM set. This is
  the honest use of the port: about 85% of the pages are compressed, so a ROM
  plus these routines is the only way to get readable sheets short of an
  emulator. It is what `stf-tools/dump-atlas.mjs` reads and what the **Textures**
  panel accepts. It writes a `PROVENANCE.txt` beside its output saying what made
  it, and it writes to a temp directory rather than into the checkout, so 2.2 MB
  of the game's data is never sitting where a stray `git add -A` can sweep it up.
- **`stf-tools/make-texref.mjs`** builds the manifest, and **refuses any directory
  carrying that `PROVENANCE.txt`**. A reference can only come from a real
  capture.

That the checks still bite was confirmed the only way it can be — by breaking
the port and watching them fail. One flipped byte in `buildTexram` gives
`texram0: FAIL, 1 of 16 64kB blocks differ, first at 0x50000`; a flipped byte in
luma RAM fails outright; a flipped entry in colorxlat row 20 gives `row 20
differs`.

Running the extractor over `sfight.zip` and diffing against the capture it
replaced is the other half of the argument: `texram0.bin`, `texram1.bin` and
`lumaram.bin` come back byte-identical, and `colorxlat.bin` differs only inside
the two bands `sub_2435C` was mid-rotation on when the capture was taken.

## Loading a capture instead

A dump is still accepted and still wins, because it captures one real moment of
a real machine — including whatever a previous scene left resident. A dump that
brings `lumaram.bin` and `colorxlat.bin` pins those too; one that brings only
the sheets leaves the ROM-built tables in place.

**`stf-tools/mame-dump-texram.lua`** captures from MAME:

```
cd <mame>
TEXRAM_OUT=<any directory outside the checkout> \
  ./mame.exe sfight -rompath <dir-with-only-the-zips> -nodrc \
             -autoboot_script <stf-tools>/mame-dump-texram.lua \
             -video none -sound none -nothrottle -skip_gameinfo
```

Two flags there are load-bearing, and getting either wrong gives you a dump that
looks fine and is from the wrong place:

- **`-rompath` must point at a directory holding only the zips.** MAME prefers a
  loose `roms/sfight/` folder over `sfight.zip`, so if that folder holds hacked
  program ROMs you will silently capture a different game. Check that
  `-verifyroms sfight` says *good*.
- **`-nodrc` is required.** Without it the SHARC recompiler fails the game's
  coprocessor self-test and it sits on a blue "CO-PROCESSOR ERROR!! 50E000 =
  error status" screen having uploaded nothing. Interpreting the SHARC is much
  slower, so capture early rather than driving the game deep into a match.

For a chosen stage, **`stf-tools/mame-drive.py`** is the one that works: it drives
MAME live over claude_mame's bridge, coining up and walking character select
into a real fight, then dumps from inside Lua. STF keeps its stage textures
resident, so the set it captures is the same one the boot screens use — only the
intro movie swaps them out.

The autoboot scripts below are the earlier, blind approach.

It hashes texture RAM each frame and writes a pair of 1 MB sheets whenever the
contents settle on something new, plus the two colour LUTs and a snapshot of the
screen that set belongs to. To capture a *specific* stage, run MAME normally and
press a key instead — scripted inputs are not reliable at walking the game to a
chosen arena:

```
TEXRAM_OUT=<any directory> TEXRAM_KEY=KEYCODE_F12 \
  ./mame.exe sfight -rompath <dir-with-only-the-zips> -nodrc \
             -autoboot_script <stf-tools>/mame-dump-texram.lua
```

Drop the resulting files onto **Textures** in the sidebar. Four are recognised
by name or size:

| file | address | size | role |
|------|---------|------|------|
| `*texram0*` | `0x11000000` | 1 MB | sheet 0 (atlas top half) |
| `*texram1*` | `0x11200000` | 1 MB | sheet 1 (atlas bottom half) |
| `lumaram.bin` | `0x11400000` | 128 KB | per-texel brightness ramps |
| `colorxlat.bin` | `0x01810000` | 48 KB | ramp + palette colour → RGB |

Either way the fill shader runs MAME's own pipeline (`model2rd.ipp`): the 4-bit
texel indexes the lumaram band named by the face's `lumabase`, that is scaled by
the face's lighting term, clamped to 6 bits, and used to index colorxlat per
channel against the face's 5-bit palette colour. The tables the dump brings and
the tables `js/colors.js` builds agree, which is what `stf-tools/test-colors.mjs`
asserts — the dump is worth loading for the sheets, and as a check.

The **luma** slider is now a debug multiplier on the computed luma rather than a
stand-in for anything, and sits at 1.0.

### A lone model's sheets

The ramp reads a texel and looks it up, so it is only meaningful against the
sheets the same scene loaded. A model drawn against another stage's pages comes
out confidently wrong rather than obviously approximate — and sampling the atlas
cannot tell the two apart, because stages *share* page slots. That is why
loading the wrong set replaces a stage's scenery instead of leaving a hole, and
why a model whose pages were never unpacked still finds somebody's texture
sitting in them.

What can be answered is which scene draws the model, and then its pages are
exactly the ones that scene uploads. `modelScenes()` asks it of all sixteen
stages at once — sixteen display lists, about two milliseconds, once per ROM set
— plus every mesh the rig can put up: the sixteen parts in both forms, the faces
and eyes the face records name across all twenty-one variant tables, the sway
chains and Tails' pose cycle. So the
**Models** tab loads the scene a model belongs to (its sets, its colour tables,
its light and its material slots) and shades it the way that stage does, rather
than shading it flat against whichever stage happened to be up. Giant Wing's
floor, model 2660, is a dark sea under bright cloud on any tab now instead of
the near-white the flat approximation made of it; Aurora Icefield's ground,
model 481, is the reverse.

A fighter's part belongs to no one stage. Its sheets are in set 1, which every
stage uploads, so they are resident whichever stage was loaded — the board could
not draw a fighter otherwise — and it takes the scene that is up. That is what
the **Animation** tab has always done; the Models tab now agrees with it, so
clicking a part to identify it no longer changes how it is shaded.

Two fifths of the models that carry geometry are covered between the two. The
rest are drawn by nothing the viewer runs — the attract mode, the menus, the
endings — and are shaded against whichever stage is loaded. The model panel says
which case a model is in.

What the scene decides is which sheets and which colour tables a model is read
against. It does not decide *how* it is shaded: every model goes through the
ramp. It used to be that a model no scene claimed fell back to
`colour × texel × 2`, and that is not a smaller version of the same thing — it
is a different lighting model, and it put two heads out of one family side by
side in the list lit two different ways. Model 2230 is Bark's head with its
colours in the mesh; model 3554 is the same head with the colours left to the
table, every one of its faces naming a neutral row. 2303 of the 4404 models that
carry geometry name nothing but rows, because that is how the game colours
things — and the flat stand-in read those rows as the greys they literally are
and doubled them, which for the fighters' flat white tile is `colour × 2`. Row
22 is `(137,137,137)` at luma 16 and `(253,253,253)` at 32 before it jumps to an
orange at 48; doubled, it is white at every luma. 3554 came out a white blob.

A rig model needs one more answer than a scene: *whose* it is. Five rows of
colorxlat are a fighter's own colours and two more are its skin, and
`send_tex_col_part` puts the character on screen into them — so `modelScenes()`
carries the character that owns a mesh alongside the scenes that draw it, taking
the first in roster order where several wear the same part. The Models tab
uploads that character's block before it draws, the Animation tab uploads the
one it has up, and a stage on its own uploads neither, because no stage model
names those rows. The model panel says which fighter it settled on for the same
reason it says which scene: a head read against the wrong block is a different
colour, not a slightly different one.

## Lighting and colour

The board lights every polygon in the geometry engine, before the fill path ever
sees it. On a Model 2A that is the TGP and MAME reproduces it in
`geo_parse_np_ns`; Sonic The Fighters is a 2B, so it is the game's own SHARC
program `cpres2` — and the disassembly of that program computes exactly the same
thing:

```
    f13 = f5 * f7                  dotl * dotp
    if ms  f13 = f13 - f13         opposite signs -> luminance 0
    if not ms f13 = abs f5         otherwise |dotl|
    f0  = f13 * f2                 * diffuse
    f0  = f0 + f5                  + ambient
    r0  = fix f0 ; r0 = clip r0    -> 0..255
    r4  = lshift r4 by 0xf         luma << 15, out to the rasterizer
```

Every input to that is in ROM:

| input | where |
|-------|-------|
| `N`, the polygon's normal | the mesh record, `+0x1C` |
| the material slot | bits 18–22 of the same record's attribute word |
| `diffuse`, `ambient` | 32 slots the game uploads with GEO command 6; `sub_29110` picks the table with the stage slot, from the pointers at `0x909E0` |
| `L`, the light vector | `camera_init` rotates `(0, 0, stage_bright)` by `stage_vecter_y` then `stage_vecter_x` |

The light needs two observations to be usable here. The coprocessor builds it in
camera space — but it transforms every normal by that same camera matrix too, so
the camera cancels out of the dot product and the light is world-fixed, which is
what lets a free camera fly without the lighting swinging with it. And the
fighters' Z rotation, applied last, cannot move a vector that lies along Z, so it
drops out entirely. What is left is the stage record: South Island's light comes
out at `(-0.547, 0.707, -0.449)` — 45° up, which is where every stage but the
Eggman ones puts it.

The material table is what the shading actually turns on. South Island's sea,
its ring floor, the palm fronds and the clouds all name slot 31, which the stage
uploads as **diffuse 0, ambient 255**: unlit, full brightness, landing exactly on
the sixteen palette slots their luma band holds. The ground and the posts name
slots with diffuse 128 and ambient 176, which saturate at 255 by `|N·L| = 0.62`
and carry real variation below it — 68% of the stage's faces sit at 255 and the
rest spread down to 176. That is why the arcade image reads as flat, painted
texture rather than shaded geometry.

An earlier pass here inferred the unlit surfaces instead, by noticing that a face
whose luma band lies wholly in 49–63 cannot be shaded without falling out of the
palette. That inference was right, and it is gone: the material table says it
outright.

Two deliberate differences, both learned by comparing against a capture of the
real game:

**The normal is transformed to world space, not view space.** m2-hle2's light is
a camera-space vector, which is right for the game's fixed camera but would
swing the lighting around as you fly a free camera.

**The light direction is the stage's own,** read out of its record rather than
tuned. The viewer used to hand-tune it to `(0.2, 1.0, 0.3)` to reach a colour
band that, it turns out, material 31 reaches on its own.

The reason it was ever load-bearing is that **colorxlat is not monotone**. Take
South Island's ring canvas. Its faces use colorbases 24 and 25, which the palette
gives as `23/23/23` and `24/24/24` — flat greys. Yet the game renders the canvas
as a green-and-yellow checkerboard. The reason is in the table:

| luma | colorxlat for c5 = 23 |
|------|------------------------|
| 16 | 142, 142, 142 → grey |
| 32 | 255, 255, 255 → white |
| 40 | 255, 255, 255 → white |
| **48** | **93, 146, 22 → green** |
| 63 | 113, 172, 27 → green |

The ramp climbs to white and then *jumps* to a completely different colour band
above luma ~44. A grey palette entry is not grey — it is a row of a table whose
top sixteen slots hold the scene's real colours, written there by
`send_tex_col_stage`. Anything that pulls the luma below 48 loses them, which an
oblique light does and any diffuse term at all does. Tilting the light overhead
was the first way that band was reached; reading the material's own choice off
the luma band, which is what the viewer does now, is the right one.

Two things this ruled out along the way, both worth not re-investigating:

- **Palette RAM is not the missing piece.** MAME reads a face's colour from
  `palram[colorbase + 0x1000]` rather than the table in the data ROM, so that
  looked like a likely culprit. Dumping palram and comparing all 1024 entries
  against `main_data + 0x100000`: identical. The ROM read is correct.
- **It was never saturation.** The white surfaces looked blown out, so the
  obvious move was to scale the luma down — which only made everything dark and
  *still* grey, because white is the middle of the ramp, not the top. The luma
  scale defaults to 1.0, which is exactly m2-hle2's `poly = shade × 255`.
- **The tables were the missing piece all along.** They are RAM, the game fills
  them from `main_data` on every scene change, and until `js/colors.js` there was
  nothing to fill them from without a capture.

### Colour space

No sRGB/linear conversion is needed on the geometry, and adding one would be
wrong. The fill shader's output is already display-referred: it comes straight
out of colorxlat and the gamma approximation, which is where MAME's own pixels
come from. three.js does not touch it either — `colorspace_fragment` is only
injected into three's built-in materials, not a custom `ShaderMaterial`. Sampled
against a MAME capture of South Island, the ring canvas comes out
`rgb(48,120,0)` and `rgb(168,192,0)` in both.

The backdrop was a different matter, and did need fixing. MAME's `palette_w`
never shows a BGR555 value directly — it runs each 5-bit component through
colorxlat at luma 0x40 and then the gamma table, the same path a face takes at
full brightness. Feeding the raw value to `THREE.Color` was wrong twice over: it
skipped that transform, and `THREE.Color` reads its arguments as working-space
(linear) by default, so the output encode brightened them again. South Island's
`0xF0C0` came out `rgb(0,120,240)` against MAME's `rgb(0,0,184)`. Routed through
`palette555ToRGB` and tagged `SRGBColorSpace`, it now matches exactly.

The **luma** slider remains only as a debug multiplier on the luma the geometry
engine's arithmetic produces. At 1.0 nothing is being stood in for.

## Music (`js/sound/`)

The **music** switch on the Stages tab plays the stage's own song, and nothing
about it is a recording. The Model 2 sound board is a 68000 running the game's
sound driver out of `epr-19021`, playing the four sample ROMs (`mpr-19022`–
`mpr-19025`, 8 MB) through a Yamaha SCSP, and the i960 only ever tells it what
to play: three-byte MIDI-framed commands down a UART. m2-hle2 emulates that
board — the 68000, the SCSP and its DSP, the UART's timing — and grades it
against MAME's, song by song and key-on by key-on (its `tools/README.md`, "The
sound board"). `board.wasm` is that emulation, built from m2-hle2's
`src/board/sound.h` with a thin surface over it (`tools/sound/board.c`):
load the ROMs, send a byte, render samples.

**What it sends.** The song is the one `stage_bgm_select` picks:
`ld 0xDBFDC[r3*4], g0` at `0x3F6A8`, `r3` the `stage_num` byte masked to four
bits, and the long it loads (`STAGE_MUSIC_IN_ORDER`) goes to the board as it
is — `0xAE1004` is status `0xAE`, data `0x10 0x04`, South Island's. Slots 0–10
have a song and the rest hold 0, which the panel reports as no music of its
own. The routine's special cases ahead of the table — North Wind whenever Sonic
fights Knuckles, South Island on Canyon Cruise and Casino Night in a
two-player game — depend on who is fighting, so a stage on its own takes the
table. Before any song the board gets what the game sends first (`A0 00 01`,
`A0 00 03`, `A0 03 60`), and each stage change sends `A0 00 01`, all sound
off, then the new song, as `ROUND_INT` does. The driver takes about two
seconds from reset to its first note, as on the board.

**Where it runs.** On the audio thread, in an `AudioWorkletProcessor`, one
render quantum at a time: the board is asked for exactly the samples the
speakers are about to take, so there is no buffer between them to fill or to
starve, and its clock is the audio clock. The context is asked for at 44.1 kHz,
the board's rate; a browser that gives another rate gets the board's output
stepped across by a linear blend. The page hands the worklet the wasm's bytes
rather than a compiled module — Chrome drops a `WebAssembly.Module` posted to a
worklet without an error on either side.

**What it costs.** Nothing until the switch is ticked: the sound ROMs are not
read with the set (`rom.readChip` fetches a member on demand). Ticking it reads
8.5 MB out of the zips once — about three seconds to the first note, most of it
the driver's own boot — and the board then makes a second of sound in about
30 ms of one core (34× real time under Node; bit-identical to a native build of
the same source). Unticked, the audio context is suspended, which stops the
board.

**Rebuilding.** `tools/sound/build.sh` with Emscripten on the path (or `EMCC`
pointing at it) and m2-hle2 checked out beside this repository (or `M2HLE2`
pointing at it). The wasm is committed because the site has no build step; a
change to m2-hle2's `sound.h`, `scsp.h` or `m68k*.h` is picked up by rebuilding
it, and the commit should name the m2-hle2 commit it was built from. The first
build is from `c4ed74f`, then `f797c4b`, which has the 68000 fix The House of
the Dead's driver needs (below); the current one, and `model1.wasm`, are from
`cd73efd`, with the 68000's bit-op fix (`3d283a3f`) and, for the Model 1 board,
#1006's. The build stubs out
`clock_gettime`: the board times its own work for m2-hle2's status display,
which a page never reads, and libc's clock would have the module import WASI.

### Virtua Fighter 2's stage sounds (`js/sound/ambience.js`)

Virtua Fighter 2 runs Sonic the Fighters' sound board, and the round start
(`0xE418`) sends the song from sixteen codes at data `0x1E900`. Beside the song,
a task (`0x43ABC`) plays the stage's own sounds through the same queue
(`0x43888`): flag bits in its work ask for the scene-start, round-start and
round-end codes (tables at data `0x1E940`, `0x1E980`, `0x1E9C0`), and bit 29,
while a round runs, jumps through `0x44044` by stage to an ambient player. The
five players with sounds (`0x43B50`, `0x43B80`, `0x43B98`, `0x43BFC`,
`0x43C38`) are ported one for one: each counts frames since it last played and
throws the game's 16-bit random number every frame, which in the page is
`Math.random`, so the timing is the game's in kind but not frame for frame.
The **stage sounds** switch sends the scene and round codes when a stage opens
and runs its player at 60 Hz.

### Daytona USA's car on the Animation tab (`js/daytonacar.js`)

The Animation tab's bodies are the player's car: a body, four wheels and a
shadow, all placed by code from the car's state. Daytona has no motion data
for them; what plays is the attract runs recorded in the data ROM.

**The runs.** The data ROM's 0x2880000 opens "D.K.", followed by a pointer to
each run. A run holds 20 bytes a frame: x, y and z as floats, then the pitch,
heading and roll as halfwords (0x10000 to a turn). A linked cabinet's attract
gives the player's car the handler 0xD104, which takes the car's models,
zeroes the clock 0x501AAC and moves on to 0xD1B8. Each frame that handler:

- reads (0xD3E4) the clock's frame of run 34 + n + 0x231B34[course], where
  n is the car's place in the link (+0x6D, 0x12860) and the course table
  holds 0, 8 and 4. The car's y is the run's y, stored as the course's height
  0x231C44 (+0x20) and the run's y plus 0x231C54 (+0x5C); the second course
  has 5.6 and -5.6 there;
- turns the wheels (0xD330) by the frame's motion to the next record:
  |dx| + |dz| times 10000, rounded, held to 0..0xAAA and taken off the spin
  +0x5A. Car n = 2 instead adds 0x200 a frame from clock 0x8D to 0x19A, so
  its wheels spin back;
- steers (0xD2D4): cars 0 and 1 take the front wheels' turn from runs 46 and
  47, the heading of the clock's frame halved. The others keep their wheels
  straight;
- counts the clock up to the run's length 0x231B44[n] (0x11D, 0x1BD, 0x19D,
  0x27C), where it stays, still reading that frame.

A lone cabinet's attract never plays the runs: its car follows a lane
(0xD4F0).

**The draw.** With the clock running, 0x7598 goes to 0x78C8. It translates
to the car, then turns by the roll, heading and pitch (TGP 0x1616, 0x1515,
0x1414). The body (0x7D38) is three models:

- the car's model +0x14;
- the glass, model 2139, which the boot builds in polygon RAM;
- the second model 0x281E39C[0x501488].

With 0x501488 = 2, the car's number plate +0x258 is drawn as well.

The wheels (0x7DA4) first take off the tilt +0x52 and +0x56, which is 0 in
every run measured. Each wheel is then a push, a translate to its place in
0x230D54, the steer (front two only), the spin, and its model from the
unaligned list at 0x230496 (805 left, 806 right). The shadow, model 791,
comes from the car's x and z at +0x20's height, scaled to 0.01 on Y before
the same three turns.

**Which body.** 0x501488 is 2 on a linked cabinet (0xEBF0). There +0x258 is
0x281E3B4 picked by the cabinet's number 0x5FE604 (models 1794 to 1801), so
the tab lists the linked car once per cabinet. Otherwise 0x501488 is
0x501464, which 0x25C54 sets; the tab lists both values.

The TGP turns each axis the other way from a right-handed rotation. On the
board's axes the body is T(x, y, z) · Rz(-roll) · Ry(-heading) · Rx(-pitch),
and a wheel, against the body, is T(place) · Ry(-steer) · Rx(-spin). In the
viewer, whose Z is the board's negated, these are Rz(-roll), Ry(heading) and
Rx(pitch). Without root travel the car stands at the run's start with its
heading taken off. With it, the car drives the run and the camera follows.

**Graded on MAME.** I graded `daytonaCarPose` against the matrices the TGP
sends the geometrizer, read with a Lua tap on the shared build. At the first
frame after 600 where the car's handler +0xC is 0xD770, I set the car's place
+0x6D and the handler to 0xD104, which starts the recorded run. Three runs:

| Run | Course, car | Frames |
| --- | --- | --- |
| 34 | Three-Seven Speedway, car 1 | 284 |
| 36 | Three-Seven Speedway, car 3, the back-spin | 412 |
| 43 | Seaside Street Galaxy, car 2 | 444 |

On these frames the parts are far from rest: the pitch reaches -70 degrees,
the steer about ±4000, and the spin wraps through the whole turn many times.
Results:

- The state the module reads (x, y, z, the three angles, the steer and the
  spin) is the car's, exact, on every frame.
- The body's matrix is exact (0.0036 on the second course, at coordinates in
  the thousands).
- Each wheel against the body is within 2e-5. The one exception is a frame of
  run 43 at the spin's ±32768 wrap, at 0.014, from the TGP's sine.
- The shadow is within 1.6e-4.

Frames after a run's clock stops are left out of the grade. MAME's wheels
start with whatever spin the attract's previous handler left; the tab starts
it at 0. The SE and Saturn-ads builds move the tables (`rig` in `js/games.js`),
and their runs read frame for frame what Revision A's do. The 1993 build has
no "D.K." runs and no car on the tab.

### Daytona USA's music: the Model 1 sound board

Daytona runs on the original Model 2, which kept Model 1's sound board rather
than the SCSP one: a 68000 at 10 MHz running the driver out of `epr-16720` and
`epr-16721`, two MultiPCM sample chips (315-5560) with 4 MB of samples each
(`mpr-16491`/`16492` and `mpr-16493`/`16494`, the upper megabyte of each
banked by the 68000), and a YM3438. The i960 talks to it the same way, bytes
down an 8251 at 31250 baud. m2-hle2 has no emulation of this board, so
`model1.wasm` is put together here (`tools/sound/model1.c`): m2-hle2's 68000,
MAME's memory map for the board (`segam1audio.cpp`), and the two chips as MAME
runs them — its MultiPCM (`gew.cpp`, `multipcm.cpp`), carried over line for
line, and ymfm, MAME's YM3438 core, used as it is. The mix is MAME's: the
YM3438 at 0.30, each MultiPCM at 0.5. The driver keeps its tempo by polling the
YM3438's timers; its only interrupt is the UART's, on level 2.

It makes MultiPCM's own rate, 10 MHz / 224 = 44642.857 Hz, and says so through
`snd_rate()`, which the worklet uses to step it across to the context's rate.

**Graded against MAME.** MAME (`daytona`, 0.289) was run through 70 s of
attract with every byte the i960 wrote to the UART logged and the sound written
to a WAV; the same bytes at the same times through `model1` natively gave a
loudness envelope that follows MAME's at a correlation of 0.997 (quarter-second
windows) at the same level to within a few per cent, the same spectrum to
within 0.5 dB up to 10 kHz, and a waveform that lines up to 0.6–0.9 correlation
in 0.3 s windows, with a steady 17 ms offset and a drift of 56 ppm, which is
MAME's sample rates being whole numbers. The wasm's output is bit-identical to
the native build's, and it makes 20 s of sound in about 0.6 s.

**Which song.** `start_setting` (0x3BF0 in the Saturn-ads build, labelled) is
what sends the race's song:

    ldob    sel_course, r3
    cmpibe  0, r9, loc_3C8C      ; r9: the held buttons, & 0x100E0
    bbs     5, r9, ... mov 0     ; VR1
    bbs     6, r9, ... mov 2     ; VR2
    bbs     7, r9, ... mov 1     ; VR3
    mov     3, r3                ; VR4
    st      r3, dword_501A98
    ld      0x28050F0[r3*4], g0
    call    sub_1A554            ; three bytes down the UART

So a race plays its course's song, unless a VR button is held as it starts,
which picks the song instead — and VR4 picks a fourth that no course has. The
table is at data `0x8050F0` in every build but the 1993 one (program ROM
`0x231E70` there) and reads `0xAE1007`, `0xAE1009`, `0xAE1004`, `0xAE100E`
in all of them. The **Song** list under the music switch is that choice: the
course's own, or what each button picks. The fourth course, the test square,
has sel_course 3 and so gets the fourth song, as the routine would.

What goes with a song is what the game sends with it: `0xB70700` after the
third (the routine's `cmpi r3, 2`), and `0xBE1700`, `0xBE1900` after every one
(the race's scene set-up, 0x23E74). To stop a song the page sends what
`sound_refresh` does, `0xF8F8FF`, and then the settings the boot path sends
after it (the run at 0x19958); the same bytes open the board.

Two more four-song tables are read with the same pick, `0x501A98` (data
`0x280EEB8`: `0xAE1006`, `0xAE100A`, `0xAE1003`, `0xAE1011`; data `0x2810D58`:
`0xAE100C`, `0xAE100D`, `0xAE100B`, `0xAE1012`, in Revision A), but only after
the race is won. The game's state byte `0x5010A4` (dispatch table 0x1994, with
`0x501090 = 1 << state`) goes from the race, 22, to 23 only when the car
finishes (0x4234, after the time is shown). State 23 starts the task at 0x23D80,
which sends the first table's song. Then come 24 and 27, and 27's step into 28
(0x4C50) starts the task at 0x245A4, which sends the second table's song and
`0xAE211C` while `0x501090` still has bit 27 set. State 28 runs for 1600 frames
and then goes to 25. A race that runs out of time goes 22, 25, 26, 29, 30 and
never reaches these states. MAME (`daytona`, coined, no input, 240 s) confirms it:
the only songs sent are `0xAE1007` for the race and `0xAE1002` after time runs out (state 26).
The explorer has no race to finish, so these songs are not offered.

The 1993 build has its own sound program (`epr-16489`/`16490`) on the same
four sample chips. Its race start (0x3008) is Revision A's: the same pick by
course or held VR button (stored at `0x501A94`), the same table, read at
0x30C8 from program ROM `0x231E70`, and `0xB70700` after the third song unless
Start is held (the raw input word `0x53E120`, bit 4). It sends `0xBE1A10`
just before the song, as Revision A does elsewhere in its race set-up (0x3804).
The boot run is byte for byte the one above: MAME (`daytona93`, 120 s of
attract) sent exactly those bytes, then `0xAE1008` and `0xBE1700`, `0xBE1900`.
So the page plays it the same way with the build's own program. Played through
`model1` natively from the same bytes, the four songs follow Revision A's
program's loudness envelopes at 0.98 to 1.00 (quarter-second windows), at
about half the level: that is how this program mixes them. A `daytona93.zip`
without the two chips loads as before; switching the music on says which chip
is missing.

### Virtua Cop's music

Virtua Cop is on the same board as Daytona, with its own driver (`epr-17170`/
`17171`) and four sample chips (`mpr-17172` to `17175`). The first pair is
1 MB a chip, and MAME loads each at the start of its 2 MB half, which is where
the page puts every chip anyway.

It has no song table. The play mode's stage start (0xA464, sub-state 6 of the
table at 0xA6F0) tests the stage byte `0x50F2A8` and sends a constant:
`0xAE1F06` for stage 1, `0xAE1F0C` for stage 2, `0xAE1F07` for stage 3, each
followed by `0xBE2101`, `0xBE2102` or `0xBE2103`. Channel 0x1F is the music,
and `0xAE1F00` stops it. To stop a song the page sends what the boot (0xA6C)
sends: that, then the run at 0x2BB20, which stops channels 0x21 and 0x22 and
keys off the rest. The same bytes open the board. A game spec's `songs` gives
each stage its code when there is no table to read it from.

**Graded against MAME.** MAME (`vcop`, the shared build) was coined and held
to each stage with a breakpoint on the stage start that sets `0x50F2A8`.
Before the song it sent only `0xAE1F00`, and at the stage start (frame 1311)
exactly the bytes above. Every byte it wrote to the UART was then replayed
at the same times through `model1` natively. Over stage 1's song the loudness
envelope follows MAME's at a correlation of 0.963 in 50 ms windows and 0.997
in quarter-second ones, at no offset and the same level to within 1%. In the
page, all three stages play at an RMS of about 2,700–5,500.

### Virtua Cop's enemies

The enemies are not objects. `0x2864860[stage]` lists a stage's sections,
each the rail counts its waves start at (ending at -1). 0x141D0 starts the
next wave when the rail's count (`0x50F490`) reaches it. A wave's enemies are
the 0x2C-byte records at `0x282C2D0[stage][section][wave]`, ending at a zero
first byte: kind (+0, 4 is a wait with no one in it), position (+4), turn
about Y in tenths of a degree (+0x10), body (+0x13, `0x281EDF0`), script
(+0x14, `0x2820D40`), the object it stands on (+0x18, -1 none) and its group
(+0x1E). 0x13A90 puts each in one of nine slots at `0x50F510`, 0x9F4 bytes
each.

The explorer does not copy any of this. For each record it runs the game's own
code in `doaMachine` (`js/doa.js`): the boot's pose copy (0x23090), the spawn,
then the enemy task 0x14AD0 once. The task reads the script's first step
(0x14118), plays the motion (0x1EAD0), builds a matrix per joint (0x1F258)
and draws a model on each (0x21A70), with shadow 0xAC under it (0x21C10). The
copro calls it makes are recorded as the draws. Two things the interpreters
lacked were added: the i960's `cpysre` (0x6E2), and Virtua Cop's copro
command 0x03, a divide, passed in as an extra command so Dead or Alive's
table is unchanged. All of a stage's enemies take about a second, so they are
built the first time a stage's objects are asked for.

The joints are left out of the stage's face layering (`layered: false`, see
`js/layers.js`). Enemies of different waves stand on the same spots, and
pairing all their faces turned a stage switch into minutes. The shadow lies
on the ground and stays in.

Waves whose first record has bit 0x20 go to 0x708C0 instead; stage 2's last
section has one, and it is left out. So are the 22 records standing on an
object: they move in the object's frame, on its own clock. Everything after
the first frame goes by the clock and the player's shots, which the explorer
does not have.

**Graded against MAME.** MAME (`vcop`, the shared build) was coined, with a
Lua tap dumping each new slot. Stage 1's first record, and the first record
of the fourth table entry, which MAME played next, both match the explorer's
run to 7.6e-6 over all sixteen joint matrices, on the first frame. The later dumps in that run were taken after the slot had already
played tens of frames, so they were not compared. All the drawn models are
ROM models below 0x4D2; none is built in RAM.

### Virtua Cop's people on the Animation tab

`js/vcopbodies.js`. The bodies are the ones the wave records name (+0x13),
55 of the 67 in `0x281EDF0`, read from every wave of every stage
(`stageWaves(rom, s, { all: true })`, which also keeps the waves after the
first and the records on objects). A body's row has the skeleton first and the
model list third, a model per joint. The spawn copies that list into the slot
at +0x42C and swaps in the record's variant: body 49's joint 5 draws 1089, not
the table's 56, and its root draws 45. So the parts are read back from the
slot after a spawn, joint by joint, root included.

The motions are `0x28188DC[1..170]`, the length first (motion 0 is none; 169
have frames). A body lists first the motions its records' scripts name. A
script (`0x2820D40[script]`, read by 0x14118) is two header words (to +0x740
and +0x74C), then steps of four words: the action (+0x634), the motion
(+0x5F8), a mirror flag (+0x8A0) and a turn. A sequence ends at an action of -1
and one more word, and the next one's header follows. Scripts share tails, so
the walk runs on into the ones after it.

A frame is the game's own. From the booted RAM the explorer writes the body's
first record to 0x5E0000 at the origin, unturned and on no object, runs the
spawn (0x13A90), puts the motion at +0x5F8 and the mirror flag at +0x8A0, and
then calls the enemy's draw, 0x21A20, once a frame. That calls 0x1EAD0 (the
motion, clock at +0x4C), 0x1F258 (a matrix per joint at +0x12C, 0x30 each),
0x21A70 (a model on each joint in the list, -1 skipped) and 0x21C10 (shadow
0xAC). The draw keeps no parent table, so the skeleton the view draws is worked
out from the frames (`jointsOf`, `js/doafighters.js`) over the six longest
motions the body's scripts ask for. A short one bends too few joints to tell.

The draw needed copro commands Dead or Alive never sends: 0x00 to 0x03 (add,
subtract, multiply, divide), 0x2D (1/sqrt) and 0x43 (the distance between two
points). They are in `VCOP_COPRO`; the stage enemies come out the same with
them.

**The aim.** 0x15FC0 is called from the script's actions. It puts the bearing
from the enemy (+0x478, +0x480) to the camera (0x50F418, 0x50F420) at +0x61C,
and the tilt to the camera's height (0x50F41C) at +0x618, and then goes by the
record's +0x1D (kept at +0x744):

- 1 turns the whole body: +0x24 becomes the bearing, and the tilt goes to +0x20
  and +0x28 by the sine and cosine of +0x628.
- 2 sets +0x630 to 1.
- 3 sets +0x630 to 2, and anything else to 0.

With +0x630 at 1, 0x1F258 roots the chain differently. After the root's place
and turns, it turns Y by +0x61C less +0x24 and X by +0x618 less +0x20. The
result is that joints 1 to 8 (the hips and legs) turn under joints 9 to 15
(the upper body), which stay where they were. The **Aim** sliders give those
two differences. The explorer sets +0x630, +0x61C and +0x618 before each draw,
as the aim would have.

**Graded against MAME.** The shared build ran the attract mode for 5000 frames
with a Lua tap (stub `hd44780_a00.bin`, a zero file, on the rompath). When a
slot's root matrix is written, the tap notes the body, motion, clock, mirror
flag, +0x630, +0x20, +0x24, +0x618 and +0x61C. When joint 15's last word is
written, it takes all sixteen matrices.

Taking the matrices at the end of the frame instead gave a mix: the frame
notifier can fire midway through 0x1F258, so some joints were from the next
clock.

The explorer ran each body and motion with the same mirror flag and aim and
was compared at the same clock, every joint against the first part's in both:

| Rows | Count |
| --- | --- |
| Graded | 745 |
| Mirrored | 178 |
| Aiming (+0x630 = 1) | 153 |
| More than 10° from the motion's first frame | 683 |

Those rows cover 24 body and motion pairs over bodies 0, 1, 8, 10, 12 and 49
(a boss).

- Worst angle: 0.053°.
- Worst place: 1.3e-5.

The aiming twists seen ran from -17.5° to +10° in yaw.

64 rows were bodies 53 and 55, which no wave record names. They were not
graded then; they are graded under the cut scenes, next.

### Virtua Cop's cut scenes on the Animation tab

The cut scenes add three bodies to the tab: 53 and 55, and 57, which only
the ending uses. There are three tables, each run by a mode routine:

| Set | Run by | Scene index | Records | Chains | Lengths |
| --- | --- | --- | --- | --- | --- |
| Attract (mode 6) | 0x10400, step 0x10960 | 0x515B98, 0..9 | `0x2817220[scene]` | `0x2817320` | `0x28173B0` |
| Stage 1 and 2 | 0x5A780, step 0x5AD70 | 0..4 | `0x283A1D8[stage][scene]` | `0x283A3A8` | `0x283A488` |
| Ending | 0x74400 | 0x5C99E4, 0..6 | `0x28713F0[stage][scene]` | `0x2871550[scene]` | `0x2871610[scene]` |

The stage scenes exist for stages 1 and 2 only. After a stage's scene 4,
0x5AD70 sets `0x5C9930[stage]` to 1. 0x5A2E0 multiplies the three flags,
and when the product is 1, 0x5A3A8 calls the ending (through 0x71D90).
The ending then goes to mode 12. The ending's records are per stage; its
chains and lengths are per scene only.

A scene's records are the same 0x2C-byte spawn records the waves use. The
body is at +0x13, and they go through the same spawn, 0x13A90. Each actor has
a chain of motion steps, starting after the chains of the actors before it in
the scene's list. A step is either:

- a motion number;
- -1, which asks again for +0x640 (the last motion asked for);
- -2, which holds.

The chain moves on when the slot's +0x3C is clear (0x1EED0 clears it when the
clock reaches +0x610).

The scenes draw an actor with 0x1EAD0, 0x1F258 (reached by `bal`, so it
returns through g14), 0x21A70 and 0x21C10. They skip the enemy draw's hit and
gun routines (0x21220, 0x14E30, 0x21090 and 0x221F0), and so does the
explorer, for a body no wave names. Such a body is listed as "cut scenes:"
followed by its sets, and it leads with the motions its chains name:

| Body | Motions its cut scenes play |
| --- | --- |
| 53 | 102 119 135 139 60 9 86 79 1 45 97 152 169 161 8 13 |
| 55 | 120 8 13 60 79 144 149 145 161 10 12 |
| 57 | 161 96 151 150 159 60 167 109 79 |

A body that also has waves lists its scene motions after its scripts' motions.

**The scene hooks.** Each attract scene also runs a per-frame hook from
`0x2817410[scene]`. Scene 7's hook (0xFFC0) pins clocks at fixed slot
addresses after the draw: slot 0 and slot 2 to 15, slot 5 to 13. Body 55,
in slot 2 on motion 120, therefore decodes clock 1, then 2, then 16 on every
following frame. 0x1EF10 refetches its keys only on a new motion (+0x40
against +0x44) or past +0x48, and the jump leaves joint 5's (the head's)
channels interpolated from the segment fetched at clock 2. For 299 frames the head is turned 69° from the
motion's own frame 16. The tab plays motion 120 from its start, so it shows
the motion's own head.

**Graded against MAME.** I ran the attract mode for 9000 frames with the
same tap. Joint 15's slot block is written three times per frame: the full
matrix, then an identity, then a rotation only, because the slot is reused as
scratch after 0x1F258. So the tap now takes the matrices at the second +0x20
write after +0x2C. The earlier grade's "last word" rule happened to fall on
the right write.

| Rows | Count |
| --- | --- |
| Graded, mode 6 | 2582 |
| Bodies 53 and 55, scenes 5, 6, 7, 9 | 1008 |
| More than 10° from the motion's first frame | 542 |

- Worst angle: 0.086°, leaving out scene 7's pinned hold.
- Worst place: 1.2e-3 (body 53, motion 119); the others are within 1.3e-5.
- Scene 7's 299 held rows of body 55: when the explorer's machine is given
  the same pin (clock 15 written after each draw), they agree to 0.011°.

Body 57 appears only in the ending, which the attract mode never reaches, so
it is not graded. It is spawned and drawn by the same routines as 53 and 55.

### The House of the Dead's music

The finished House of the Dead (`hotd`, `hotdo`) is a Model 2C game on the
Model 2 board, the SCSP board the fighting games use, with its own driver
(`epr-19720`) and two sample chips of 4 MB each (`mpr-19721`, `mpr-19722`).
A game spec's `sampleChip` gives that spacing; the default is 2 MB.

The i960 sends through a queue: 0x154D0 adds a command (only while the mode
byte `0x51EE14` is 4 or 5, or flag `0x51F341` is set), 0x15540 drains it, and
0x15590 writes the UART. The boot (0x15344) sends `A0 00 01`. Every scene change
(0xD144, 0x15CE0) clears the queue (0x15630) and then sends `A0 00 02`, `BE 50
00`, which is what the page sends to stop a song.

There is no song table. The stage scripts at 0xE0000 start the music
themselves. Op 90 (its handler is 0x67860, entry 90 of the table at 0xC6500)
puts the word after the opcode in the queue. Most of these words are sound
effects. Those on channel 0x10, `A0 10 xx`, are the music; the `A0 11 xx`
ones are jingles (`A0 11 02` on a death). The sound test's list at 0xA8CD4
holds `A0 10 00` (the title) to `A0 10 0E`, and these jingles.
`readPlacementStages` keeps the song the walk has started when a set's first
zone is made current. If none has started yet, it keeps the first song started
while that set is up: a chapter's first section makes its zone current before
it starts the song. The "all placements" entry takes the song of its widest
set. That gives chapter 1 `A0 10 01`, chapter 2 `A0 10 02`, chapter 3
`A0 10 08` and chapter 4 `A0 10 0E`.

**A 68000 bug, fixed in m2-hle2.** The first native runs were silent or
clipped. m2-hle2's 68000 decoded `and.l Dn,<ea>` in group C as `exg`, and this
driver is the first to use that instruction. m2-hle2 fixed it in `e3205e3`;
`board.wasm` is now built from `f797c4b`, which includes it. The other games
play as they did before (checked in the page on Sonic The Fighters, Fighting
Vipers, Virtua Fighter 2 and Dead or Alive).

**Graded against MAME.** MAME (`hotdo`) was coined into chapter 1 with a Lua
tap logging every UART byte at its emulated time. Those bytes were then
replayed at the same times through the board natively. Over chapter 1's song
(35–59 s), the loudness envelope follows MAME's at a correlation of 0.993 in
50 ms windows and 0.996 in quarter-second ones, at no offset and within 1% of
its level. Over the title song (15–33 s) the correlations are 0.998 and 0.999,
within 3.3% of its level. The driver listens from reset, so the spec has no
`warmup`. Chapters 3 and 4 are read from the scripts but were not played in
MAME. In the page, every stage of the four chapters plays at an RMS of about
200–1,400.

**The prototype's own.** `hotdp` has a sound program of its own
(`sndpgm0.31`) and four 2 MB sample chips (`sound1.32`–`sound4.35`), on the same
board. Its i960 side is the finished game's at other addresses: 0x11160 queues a
word (while the mode word `0x51F218` is 4, or flag `0x51E49C` is set), 0x11210
writes one to the UART at once, and the boot (0x10FDC) sends `A0 00 01`. The
stage scripts' op 90 is entry 90 of the table at 0x94550 (0x51260) and queues
the word after it, so the same walk reads the songs: chapter 1 `A0 10 01`,
chapter 2 `A0 10 02`. The scripts also start `A0 10 04` and `A0 10 05`, in
sections no stage opens with. Every scene change MAME showed in play queues `A0
00 02` and then the effect `A0 13 56` (0xAF00); `A0 00 02` is the stop. (0x1B50C
and 0x51590 send `A0 00 03` before it, but MAME never reached them in play.)

Graded the same way as the finished game. MAME (`hotdp`) was coined, and a tap
logged every UART byte for 100 s: the title `A0 10 00` at 15.8 s, then chapter 1's
`A0 10 01` at 54.0 s as its first section starts. Those bytes were replayed at
the same times through the board natively (m2-hle2 `f797c4b`, the build of
`board.wasm`). Over the title (16–34 s) the loudness envelope follows MAME's at
0.994 in 50 ms windows and 0.999 in quarter-second ones. Over chapter 1's song
(54.5–76 s) it follows at 0.994 and 0.998. Both are within 3% of MAME's level.
Chapter 2's song is read from the scripts and was not played in MAME. In the
page, the four Stage 1 entries play `A0 10 01` and the four Stage 2 entries play
`A0 10 02`, at an RMS of about 270–1,000.

### The music of the later games

Sega Rally Championship, Virtual-On, Dynamite Cop and Power Sled run the
Model 2 sound board (`board.wasm`) with their own programs and samples; the
specs are in js/games.js. A game whose program names its songs gives the
list as `music.list` (js/sound/sound.js `listedSongs`), read out of the ROM:

- **Virtual-On** (`named`): the sound test's records at 0xEFF62 in vonj
  (0xF0BA2 in vonu), 35 of 0x22 bytes: the song number, the command's middle
  byte and the name (SDB_...). A song is `AE 10 nn`, after `A0 00 01`. Which
  field plays which song is the fight code's and is not read yet, so a stage
  has none of its own (`own: 'none'`).
- **Dynamite Cop** (`codes`): thirty 12-byte records, a song's command
  (`A0 10 nn`) and two more, the first of them `A0 01 nn`, sent right after
  it (`then`). The table moves between builds (0xBC8B0 in the 2A export
  build, 0xBC8A0 in dyndeka2, 0xC92D0 in dyndeka2b), so it is found by its
  bytes; the debug names (S_BGM_...) are pointers at 0x1AD394, the same in
  every build. Word +0x1C of an area descriptor is the area's song, which
  0x4B6A8 sends as the area starts; the stage's details list it.
- **Sega Rally** (`ids`): the program runs from RAM, 0x59F000 above its ROM
  address. By ROM address, 0x261B0 sends sound ID g0 as the 3-byte command at
  0x24CE0 + 3 * ID, named by the pointer at 0x258C0 + 4 * ID; IDs 0x9B to 0xAB
  are the sound test's B.G.M list, all `AE 10 nn`, and 0x9A (`AE 10 00`,
  "Off") stops them. The race start, 0x1D0E8, takes the course's song ID
  from 0x1C6E0 (the championship) or 0x1C700 (practice), indexed by the
  course at work RAM 0x214354. The championship's are ConditionedReflex,
  DesertLand, GettingMuddyRef and Ignition, the songs [Sega Retro's
  credits](https://segaretro.org/Sega_Rally_Championship/Production_credits)
  give Desert, Forest, Mountain and Lakeside. That is the course records'
  order too, so the explorer's course 1 is the forest and course 2 the
  mountain (they were the other way round before); their skies agree, the
  Alps over a forest road and a village on the cliffs.
- **Power Sled** (`groups`): the program names nothing. Its driver is
  CRX_drv 3.0.6 (by HiroF, 1996; Dynamite Cop's is 3.2.8). The UART handler
  (0x600486) is a MIDI parser with running status; status A0 with a middle
  byte from 0x10 to 0x5F (0x601B1A) starts entry `last` of group `middle` -
  0x10 of the table the long at 0x60801C points to. Group 0x10 is empty, and
  0x11 to 0x14 hold 16, 6, 4 and 5 sounds, all started in the effect slots
  (first byte bit 7 set), none in the music slot. On the board, 11 0A, 11 0C,
  12 04, 13 00, 13 02 and 14 01 hold their level; 12 04 and 13 00 have a flat
  spectrum (wind and snow), and 13 02 is the loudest tonal one, likely the
  song [Sega Retro](https://segaretro.org/Power_Sled) says Sega Racing Best
  carries. The attract sends `A0 00 01`, `A0 13 03`, `A0 13 01` and
  `A0 70 00`, each byte twice.

A game without stages (Power Sled) has the music fields on the Models tab,
and plays nothing until a song is picked.

Air Walkers has no music yet. Its sound program (`10-18_ic30_30f2.30`) is Data
East's, not Sega's driver, and in m2-hle2's attract the i960 sent it only a
reset (`FF`); its command set is not read.
