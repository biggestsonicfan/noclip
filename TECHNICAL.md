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
  viewer.js      three.js scene, shader, orbit + noclip cameras
  app.js         UI wiring
```

The tools this document keeps citing are not in the tree. They live in
[stf-tools](https://github.com/biggestsonicfan/stf-tools) — the dev server, the
headless screenshots, the ROM inspection, `i960dis.mjs` (read the program ROM's
own routines), `mame-dump-texram.lua` (texture RAM capture) and every
`test-*.mjs` named below. That repository carries this one as a submodule and
decodes the ROM through the `js/` modules above, so a check there measures this
code rather than a copy of it. A `stf-tools/x` path below is a file at the root
of that repository.

Nothing is vendored and there is no build step. `index.html`'s import map pins
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
Its callback is the larger of the two and may treat bodies of its own apart;
those have not been read yet.

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

What is missing is motion. The object list at `0xB4` is what animates a stage,
and walking it is not written, so a stage here stands still.

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
faces: the water planes at sea level and the waterfall.

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
  frames where bit 0 of the counter is clear, and nothing on the others.
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
model→world). The 1.6 is the quirk: the draw itself never applies one, so the
head is aimed as though it stood 1.6× further out than where it is drawn, and
lags what it is aiming at by as much as 162° as the carpet passes closest.
`stf-tools/test-carpet.mjs` pins both halves — that some fixed axis of the model
follows the look-at exactly (it is the model's `+Z`), and how far that look-at
then falls behind the arena.

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
| Dynamite Plant's gears | two `ang_z` at ±250 a frame, turning opposite ways | 262 frames |
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
the attract-mode `ADV_MOV2` — so its 558, a 660-unit octagon with a square hole
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
at type 59 `PN_moon`, which is the moon the prototype's notes say is billboarded
at the camera from the script's own object lists.

Every type resolves there. The ones that appeared not to were records of another
class, whose first word was never a type at all.

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
stands and does nothing else. The rest are their own things: type 97 is a
distance trigger against a global, drawing nothing, and 98 to 102 switch on
`type - 98` into four behaviours whose models are room 4's walls and shutters.
Only the types on the shared handler are stood up, and only for records of the
generic class. The others are left out rather than guessed at.

They come out as their own layer, so they can be switched off and so the camera
frames the room rather than them. The first chapter stands 31 in the courtyard
and 43 in the mansion; the prototype, whose table is the same one 78 types long,
stands 31 and 45.

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

The class table was found the way IDA finds anything: the generic init is the
only routine that indexes the handler table, so the literal of the handler
table's address locates it, and the pointer *to* that routine locates the class
table — in the prototype the instruction is at 0x2EE70, the pointer to its
function at 0x86E10, and 0x86E10 less 0x80 entries is the base.

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

What is left is one flag, in both builds: **`PN_moon` is a prop**, type 59,
radius 170 in a room 486 across. It is the moon, billboarded at the camera by
its own handler, and it is not wrong so much as not yet special-cased.

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

The enemy waves are their own tables. **0xAED40** and **0xAF620** hold 28-byte
records whose first halfword is a *body* index and whose next three floats are a
position — 0xAED40 is six of `BO_ebita`, one of `BO_ebitb` and three of
`BO_tetuman`; 0xAF620 is six of `BO_boss4` with `BO_mummy2c`, `BO_burnerb` and
`BO_hiru_b` behind them, which is a boss fight written out.

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

Three more tables turned up on the way and are not read: **0xAA378**, **0xAED40**
and **0xAF620**, all indexed with a 28-byte stride whose first halfword is an
object type, which is what a wave of spawns would look like.

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

#### The head, where the motion is not the fighter's own

Aiming the head only makes sense while the face target belongs to the fighter
wearing it. All 518 motions key object 14 with real curve data, so there is no
motion *without* head data — but there are four roster entries with no head data
**of their own**: the Final Eggman Boss, the Egg UFO, the Egg Minion and Rocket
Metal all point at Bean's animation table, because there are thirteen tables of
106 bytes from `0xD9908` for seventeen fighters and those four were left sharing
one. `js/characters.js` derives that from the ROM rather than naming the four,
and the mirror half repeats it from index 26.

For those eight entries the viewer drops the aim, lets object 6 place the head,
and then squares it up with a quarter turn back about the head's own `Z`.
Object 6 on its own stands the head off the spine but leaves the face looking
along the chest's lateral, which reads as facing right; the quarter turn brings
it round to forward. That is the same axis `rd_kao_rob_gururi` spins the Egg
Minion's head about, which the ROM writes with op `0x0A`. What comes out is the
face pointing the way the chest does — down `-X`, which is the way a fighter
faces.

In play a fighter is looking at its opponent, and the aim is how the authored
motion says
where that is; a fighter given someone else's motions is being told to look at a
point measured for a body that is not its shape. Their heads sit far enough up
the spine — 1.466 for the boss and 1.316 for the minion, against Sonic's 0.361 —
that a target authored for a shorter fighter lands *below* the head, and the aim
turns it face-down. Sharing the chest's angle is the honest fallback: it is
where the fighter is facing, which is where it would be looking.

What the board does here is not settled. Its head block — `0x30FE8` emits the
spine translate, then op `0x3F` carrying object 6 sent back to front, so motion
278's `(-180, -90, 0)` arrives as `(0, -90, -180)` — is followed by three angles
that are zero on every head block of every capture taken so far. That is where
an aim would land and it never does. But every one of those captures is a stance
(278, 128, 68) held for the whole run, and a stance is exactly where the head
data is baked, so none of them could show a fighter turning to track an
opponent. Settling it needs a capture of a real exchange, with the fighters
apart and off their idle motions.
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

Two branches of the routine are not reproduced, and cannot be from a motion
alone.

**The propeller.** Bit 16 of `0x7F0(g7)` swaps the cycle for the pair beside it
— 1221 and 1222 for Tails — alternating on the frame parity and turned by
`0x500020 * 0xD80` about Y, which is 19° a frame: the blurred disc his flight
moves are drawn with. `0x7F4(g7)` picks between drawing it at the fighter's
world root (`0x1AC58`, which rebuilds from the view matrix at `0x5010F8`, his
world position at `0x1F4(g7)` and his facing at `0x26(g7)`) and on the hip like
the cycle (`0x1AD84`). Both are turned on by an opcode at `0x1C970` in the
per-motion **script** — `motion_flags[id]` at `0xCE380`, whose record is
thirteen bytes of flags followed by a byte-code stream the action interpreter at
`0x1C090` walks a command at a time. Nothing in the keyframe block says the flag
is set or on which frame, so the viewer, which plays a motion and not an action,
has no way to know. The panel names the two models and says they are not drawn.

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

**What the viewer cannot know is *when*.** The flame is gated on the chest
object, and the chest is swapped by an opcode in the per-motion script:
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
second set of face colours. Nothing in the keyframe block says which frames the
script fires it on, so the viewer, which plays a motion and not an action, makes
it a switch: **vent open** on the Animation tab picks which chest slot 1 is
drawn with, and the flame follows by the routine's own test.

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
turn is about the **head's own Z** — the same axis the four entries on a
borrowed motion take their quarter turn back about. `js/eggrobo.js` reads
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
of the motion. The viewer cuts to a motion instead, so those eight frames are
reported by `test-motion-mame.mjs` rather than asserted on.

Two more things the board does with a motion and the viewer does not: the frame
remap table at `0x854(g7)`, a per-move timing curve `get_frame_dat` interpolates
the frame through, and the replay path's half-frame sampling, which is how slow
motion works. Both change *which* frame is asked for, not what a frame decodes
to.

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
