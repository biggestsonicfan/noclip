# Sega Model 2 — 3D Explorer

A browser-based explorer for Sega Model 2 arcade games. It reads the arcade ROM
set directly in the page — no server-side conversion, no pre-baked asset dump —
and renders the game's geometry with three.js. Drop a set on it and it works out
which game it is from the program ROM inside.

*Sonic The Fighters* (Model 2B) is the game it goes deepest on, and the three
views below are its. *Fighting Vipers* has stages, models and motions — see
[Fighting Vipers](#fighting-vipers) — and *Daytona USA*, the one title here on
the original Model 2 board, has its models, its courses and the animated
trackside objects in all eight of the builds it shipped as — see
[Daytona USA](#daytona-usa). *Virtua Cop*, on the same board, has its three
stages, its models and its cells — see [Virtua Cop](#virtua-cop). *Dead or Alive* has its
twelve stages and its models on both its boards — see
[Dead or Alive](#dead-or-alive).

Three views, and a fourth for the 2D art:

- **Stages** — every arena from the game's own `stage_data` table, assembled
  from its ground chunks, floor, platform, cage and sky shells, with per-layer
  toggles, and running at the board's 60 Hz: the palms sway, the Flying Carpet
  ripples, its flames flicker, the ocean scrolls. Each stage also runs the
  objects its own record asks for — Casino Night's blimp and slot machine,
  Giant Wing's clouds and propellers, Aurora Icefield's turning diamonds, its
  walrus statues and the light running along its aurora, the Death Egg's Earth and the pattern
  crawling across its floor — and the two stages that fly: the Flying Carpet
  round its desert, and Canyon Cruise's boat down the canyon its own object
  list builds. Fly through it with a noclip camera — and on the three stages
  that carry a world prologue, **ride the arena** instead: the same stage in the
  board's own frame, the carpet or the boat standing still and the world
  wheeling past, which is the only way to hold a moving arena in view long
  enough to read it. See
  [Stage animation](TECHNICAL.md#stage-animation),
  [Two framings](TECHNICAL.md#two-framings-and-a-checkbox-between-them) and
  [The stage's own objects](TECHNICAL.md#the-stages-own-objects).
- **Models** — all 5103 model-table entries (4404 of which carry geometry),
  browsable and searchable. A model some scene draws is shaded the way that
  scene shades it: picking one loads its stage's texture sets and colour tables,
  so Giant Wing's floor is a dark sea under bright cloud and Aurora Icefield's
  ground is snow, whichever stage was up. See
  [A lone model's sheets](TECHNICAL.md#a-lone-models-sheets).
- **Animation** — the cast, moving, and not only the fighters. The list is the
  seventeen `CHAR_PARTS` names, so the Final Eggman Boss, the Egg UFO, the Egg
  Minion, Rocket Metal and Super Sonic are in it too, and a **P2 colours**
  switch shows the half that repeats them from index 26: the look player 2
  wears when both pick the same fighter. Each one's sixteen part
  meshes are assembled onto **its own** skeleton — the rig `SKELETON_TYPE_DATA`
  gives it, read off its own stance, rather than the one its record points at,
  which for several of them is somebody else's — and posed by the game's own
  motion data: pick any of its 52 action slots or browse all 518 motions in the
  table, and play it at the board's 60 Hz or scrub a frame at a time. The
  attacks are listed too, the way the game's input matcher has them: each under
  the buttons that do it (*punch · P*, *hataki · back . back+down . down .
  fwd+down . fwd+P*) and named from the table the CPU opponent is driven from.
  A string plays as the game strings it — punch, punch, punch, each follow-up
  taking over at its motion's cancel frame and eased in the way the board eases
  into a new motion — and can be built up by hand from the follow-ups each move
  allows, or any move once the fighter is free. The rig is
  the game's, not a guess at it — a body matrix, a chest and head that aim at a
  target, four two-bone IK chains that reach for one, and each fighter's own eye
  models on the head. The four entries that borrow Bean's motions aim at Bean's
  face target too, as the board does, held at its 45-degree pitch limit.

  The parts that hang off the skeleton come with it: Honey's pigtails, Fang's
  tail and the other three fighters' sway chains, drawn where the ROM's own
  tables put them, and Tails' two tails — sixty-four modelled poses drawn twice
  off his pelvis, splayed and eight frames apart. So do the things that are in
  no keyframe block at all, each stepped by the display counter the way the ROM
  steps it: Metal Sonic's jet plume and the chest that opens to light it, the
  Final Eggman Boss's arms swinging through their sixteen-model ping-pong, and
  the Egg Minion's head stretching, spinning and shrinking for 48 frames out of
  every 256. The afterimage trails a punch or a spin kick leaves come from the
  motion's own script and run on a port of the coprocessor's trail ring, marked
  in the motion list. The hammer-squished form is a checkbox: a second skeleton with
  every bone halved, and the second sixteen meshes in the part table to go on
  it. It is checked against a real machine: over 300 frames captured out of
  MAME, the joint angles come back bit-identical.
  See [Animation](TECHNICAL.md#animation), [Sway chains](TECHNICAL.md#sway-chains-jsosagejs),
  [Tails' tails](TECHNICAL.md#tails-tails), [Metal Sonic's jet
  exhaust](TECHNICAL.md#metal-sonics-jet-exhaust), [The Egg robots' timed
  animations](TECHNICAL.md#the-egg-robots-timed-animations-jseggrobojs) and
  [Afterimages](TECHNICAL.md#afterimages-jszanzoujs) and [Moves and
  strings](TECHNICAL.md#moves-and-strings-jsmovesjs).
- **Cells** — the game's 2D pictures, the title screens, portraits, name
  plates and fonts it lays out on the tile chip: all 535 of the cells
  `dsp_pattern_new` draws, each with the CG (`_Scroll_Initialize`'s tile pixels
  and colours) that writes every tile it names picked for it — 530 of them have
  one — and any other CG, or a second one loaded under it, to choose. The
  program never draws 124 of them (126 in Sonic Championship, with a
  Fighting Vipers logo and an STF title of its own): a "50% Version for AOU
  Show" notice, a location test one, ROBOEGG silhouettes, the staff roll's
  text and more. The list marks them, and searching for `unused` lists only
  those. The camera button saves the cell itself at its own size, transparent where pen 0
  is, as `noclip-sfight-cell<N>-cg<M>-<time>.png`. See
  [`js/cells.js`](js/cells.js).

And the stages have their music: tick **music** on the Stages tab and each
arena plays the song the game plays on it, on the game's own sound board — its
68000 sound driver and the SCSP it drives, emulated in the page by m2-hle2's
board compiled to WebAssembly, and sent the same command the game sends when a
round starts. It reads the sound ROMs only when switched on and runs at a few
per cent of one core. See [Music](TECHNICAL.md#music-jssound).

## Fighting Vipers

Drop `fvipers.zip` and the explorer loads *Fighting Vipers* instead, with the
Stages, Models, Animation and Cells tabs — sixteen arenas and 5413 table entries, 3601 of which
carry geometry, textured and lit from the ROM.

It works because the two games are built on the same Sega library, and that went
further than the model table. Fighting Vipers' program ROM carries the same
official labels, its `set_obj` reaches for the model table the same way, and the
palette, the texture pipeline and the colour tables are all the same machinery
at different addresses. The reasoning for each is written down beside the
profile in [`js/games.js`](js/games.js) and in [TECHNICAL.md](TECHNICAL.md).

The stage records went furthest of all: `stage_data` is a label in this program
ROM, and every field the other game's reader knows is at the same offset — the
flags word, the brightness and two rotations that build the light vector, the
texture pair, the four single models, the sixteen parts, the cage and the object
list pointer. They were checked one at a time against the routine that reads
each. The records live in a second data bank, which is what ROM sockets .5 and
.6 turn out to be for, reached only through the top half of the mirror window.

Two differences change what the viewer does with them. The geometry is already
in world space: where the other game scales its arena and gives the cage, poles
and platform a transform each, this one hands each list to `area_clip`, which is
a cull and not a transform — it reads a visibility bitmap and calls `set_obj`
with no matrix. So the draw list is the lists themselves.

The object list a record points at is what animates, and it is walked: the
Airport's planes taxi and take off, the Tower's helicopter keeps itself in
view, the trucks come and go at the UFO Diner, the elevator rises through its
shaft past the city, and on both Westerns the arena and its cage turn inside
a town that stands still. The light moves as the board moves it: with the
camera on Bay Side,
to the trucks' headlights at the diner, and round the Observation Deck's four
corners, which also change its platform, poles, cage and colours. Take the
camera up to the Western's bear and it hops, once. The panel's Region picks the
signs and truck cabs the test menu's COUNTRY setting would. See
[Fighting Vipers' stage objects](TECHNICAL.md#fighting-vipers-stage-objects-jsfvobjectsjs)
for what each routine draws and what is left out.

The Animation tab poses the fighters: Fighting Vipers' pose and draw routines
are Virtua Fighter 2's, so the same rig reads its fourteen records and 1054
motions, with the same opponent, which can play the game's reaction to the
fighter's strike or throw. Each fighter's moves are listed under the input
that does them, read from its input program the way Sonic the Fighters' are
(*fwd+down . fwd+P*, the strings as their presses, *P , P , K*), and the ones
a fighter standing in front of its opponent does not reach that way say what
they need. They play one at a time: a string is listed by the motion its last
press plays, and the strings themselves are not played yet. The game's names
for its moves are not found, so they go by number. With the **Armour** switch's
upper half broken, a helmet that comes off stays off: the face a move changes
to is the bare-headed one the game's table gives (Bahn, Picky, Mahler and five
others). The stages carry their names, from the sound test's song list, and
play their music and stage sounds on the emulated sound board.

The **Cells** tab has the game's 2D pictures, from the same two tables the stage
skies come from: 473 cells, the title's backdrop and SEGA mark, the game-over
picture and the Fighting Vipers logo among them, each opened on a CG that writes
every tile it names (472 have one; cell 22's pointer leads to no record). The
game's own pairs agree where its code loads a CG and draws a cell straight
after: the title's backdrop, cell 93, on CG 13, and cell 111 on CG 55. The cells
the game never draws are not marked yet, so searching for `unused` lists none.
See [Fighting Vipers' cells](TECHNICAL.md#fighting-vipers-cells-jscellsjs).

## Daytona USA

Drop a Daytona set and the explorer loads it with the Models tab. All eight of
MAME's builds are recognised — the 1994 parent and its seven clones — and a
merged archive carrying the lot is read as all eight at once: the panel grows a
**Build** picker and swapping between them reassembles the set without the zips
being handed over again.

Each build opens on the Stages tab with its four course grids — and what stands
along them, moving: see [The trackside objects](#the-trackside-objects) — and
the Models tab has the rest. There are
two sets of models behind those eight names, though, and the profiles say so
rather than implying otherwise. The 1993 Deluxe version (`daytona93`) has
its own data, its own fourth polygon pair and its own second texture pair: 2822
table entries, 2817 of them with geometry. Every build after it — Revision A,
the Special Edition, the Saturn-advert version and the four Kyle Hodgetts hacks
— carries a **byte-identical** model table and palette: 3190 entries, 3163 with
geometry. They differ in their program ROM and half a megabyte of data, not in
what they draw. What comes out either way is the grid of stock cars in their
liveries, the three courses' track sections, and the scenery along them.

The courses have their music too: tick **music** on the Stages tab and each
course plays the song its race starts with, on Daytona's own sound board — the
68000 driver, two MultiPCMs and a YM3438, emulated in the page. The game lets
the player pick the song by holding a VR button as the race starts, and a
fourth song is only reachable that way; the **Song** list under the switch is
the same choice. Every build has it; the 1993 one plays on its own sound
program, which its `daytona93.zip` carries. See [Daytona USA's
music](TECHNICAL.md#daytona-usas-music-the-model-1-sound-board).

The **Cells** tab is here too, in every build: the title, the course and car
select, the HUD's dials and lamps, the rankings, the courses' START YOUR
ENGINES pictures and the EPA notice, 224 cells (148 in the 1993 build, 235 with
the Saturn advert's eleven), each opened on the CG the game draws it with. All
but one have a CG that writes every tile they name, and the program ROM's
© SEGA 1994 line, whose 4 comes from CG 7 over CG 0. The game never draws 18 of
them (5 in 1993), among them a big 0-9: the list marks them, and searching
for `unused` lists only those. The tile chip is Sonic The
Fighters', the tables are not: see `DAYTONA_CELLS` in
[`js/games.js`](js/games.js). Their colours go through colorxlat as the sky's
do, so they follow the cabinet.

It is the only set here that is not on a 2A or 2B board. This is the original
Model 2: a Fujitsu TGP beside the i960 where the later titles have a SHARC,
texture RAM at `0x12000000` rather than `0x11000000`, and AM2's library two
years younger than Sonic The Fighters'. Not one address carried across, and
neither did the shape of some of the tables. What did carry across is the board
— the polygon format, the texture sheets, the 10-bit colorbase and the
colorxlat/luma pair are the geometry engine's and the rasteriser's — so the
decoders are used unchanged and only the numbers in
[`js/games.js`](js/games.js) are this game's own.

There was no symbol table for this one and no decompilation to read, so every
number was taken off the program ROM's own instructions — and, with eight of
them to read, not by hand. stf-tools' `daytona-tables.mjs` finds each routine by
the instruction that names its table and prints the profile block; `--check`
holds what it finds against what `js/games.js` carries, and all eight pass. It
was written against the 1993 build, whose numbers had already been read by hand,
and reproduced every one of them before it was pointed at the other seven.

Three signatures fix the rest:

- `0x1134` sets `g10 = 0x00800000` and `g11 = 0x00880000`, which is what makes a
  store to `0x60(g10)` readable as geometry-engine function 6 and a store to
  `0x10(g11)` as a TGP maths call. Every upload below was found by its function
  number after that.
- `0x1786c` is the draw routine. It reads four words off a model record — the
  object address, the texture-point address, the texture-header address and a
  polygon count — and stops on a zero, so a record is 20 bytes: those four and
  the terminator. The three addresses go to the engine as tpa, tha, oba, which
  is the same three the 1995 games keep in a different order.
- `0x5418` is the palette upload, and it states its own source, destination and
  length: 1007 colours from data `0x8955A0` to palette RAM at colorbase 0.

The model table is not indexed by the program — it names each entry by address.
1959 words of the program ROM point into it, every one of them a multiple of 20
from `0x887928`, the lowest at entry 3 and the highest at entry 2822, which is
where the palette starts. That fixes the base, the stride and the count at once,
and the palette confirms it from the other end: the highest colorbase any face
in the game names is 1006, which is the last colour the upload writes.

The sheets are raw here rather than compressed. The routine at `0x1388` copies
0x60000 halfwords of a megabyte bank straight into one sheet and then deals the
last 0x20000 out between the two, a run at a time, as nine mip levels; it is
called twice a scene, once for the bank every course shares and once for the
course's own, so the two banks' mip halves come out complementary. Tile coverage
cannot say which course's bank a model is drawn against when every bank fills
the whole sheet; the courses can, since a course's bank is its own number (see
below), so a model a course draws — a block or an object along it — takes that
course's, and for the rest the panel's picker decides and it opens on set 0.

colorxlat is not uploaded at all: the routine at `0xA74` computes all 32 rows
from four constants, and [`js/colors.js`](js/colors.js) is a transcription of
it. Luma RAM is 66 bands copied out of the program ROM. The material table is
uploaded whole at boot by `0x4FEC`, out of two parallel arrays rather than the
interleaved one the other games use; the light is the vector in the view record
the main view uses, which on the board is a headlight in the engine's own frame
and is applied here as a world light so a model keeps one lit side as the camera
moves.

### The courses

The courses are a table after all, and a very plain one. This was written up
once as *not* being one — the routine that hands a model to the geometry engine
has 75 call sites, 28 of them naming a model outright, which looked like a game
that draws its scenery in code. It was the wrong conclusion drawn from the right
evidence: those call sites are the cars and the trackside objects, and the
course is somewhere else entirely. What found it was a symbol table — the
board's own names, 243 of them, in an IDA database of the Saturn-advert build —
and three of those names are the whole answer:

- `get_m_block` cuts the world into a 16x16 grid of 128-unit blocks and indexes
  it `(z << 4) | x` off the camera position;
- `set_area_block` turns that into the list of blocks in view;
- `dsp_area_block` draws one model per block — `ld (g0)[r9*4], g0` then
  `set_obj_cont` — **with no matrix of any kind**.

So a block's geometry is already in world space, as Fighting Vipers' arenas are,
and a course is simply its 256 models drawn where they lie. The grid is a
visibility index and nothing else, which is why the viewer does not reproduce
it: it draws all 256.

`set_course_parms` picks the table with `ld <array>[sel_course*4]`, and the
array names four of them. Three are the courses the game lets you pick — the
Three-Seven Speedway oval at 10,290 triangles, Seaside Street Galaxy at 46,585
and Dinosaur Canyon at 25,163 — and the fourth is a flat square of coloured
lane stripes with sample objects scattered over it, a test track. The
Saturn-advert build points its fourth slot back at the third, which is the
clearest statement that the fourth is not a course.

Which course is which is read off the lap counts, since the ROM carries no
names: the same routine loads the race's laps from a table indexed by
`sel_course`, and on the normal setting it reads 8, 2, 4 — Beginner eight laps,
Expert two, Advanced four. The second and third were named the other way round
until the trackside objects below put the Jeffry statue and a row of traffic
cones in the city street of the second.

The same `sel_course` indexes the texture bank in `send_tex_map`, so a course's
texture set is its own number. That is what finally answers which sheets a
model is drawn against: every one of the 1024 block models now takes its
course's, and only the models no course claims still need the picker.

What is still missing is the track *surface* as the game drives on it — the
collision and height data is not in the polygon ROM but in the 4MB coprocessor
data ROM, four megabytes that open on a 4x4 identity matrix and are a third
plausible floats. The viewer does not need it to draw the course, and does not
read it.

There are no character animations. This game has no rig and no motion tables —
nothing like the `BO_`/`MO_` arrays The House of the Dead carries — so there is
nothing of that kind to play, and the cars do not move. What does move is the
course's own furniture, below.

### The trackside objects

Everything that stands along a course besides its blocks — the slot machine and
the lucky dice on the Three-Seven Speedway, the horses, gulls, crowds, cones and
the Jeffry statue on Seaside Street Galaxy, the wind farm, boat, water and
check-point banners of Dinosaur Canyon — is drawn on the **objects** layer, and
moves the way the board moves it. [`js/daytona.js`](js/daytona.js) is the
port.

These have names. Sega Racing Classic, the 2009 Ringwide release, ships a PC
emulator whose `d1a.exe` still carries the board's own symbol table — 651
addresses — and its program ROM is a later build of the same one. The object
routines are all named: `ship`, `slot`, `jeffly`, `tori` (birds), `uma`
(horses), `z_kaitenn` (Z rotation), `hata_3` (flags), `ctykya`, `wing`,
`pylon2` and a dozen more.

They are kept the way the course is, by grid block. `set_course_parms` stores
the course's table at `0x501444`, and at the start of a race one routine walks
all 256 blocks of it; a non-null block is a count and that many 24-byte
records — `{x, y, z, angle, id, init, arg}` — and each becomes a task whose
init routine installs a display routine. Every display routine is small: it
checks its block is in view, pushes the TGP's matrix, builds a transform out of
translate (function `0x12`), scale (`0x13`) and the three turns (`0x14`–`0x16`),
draws a model or one of a list of them, and pops. A good third of them draw no
matrix at all, because their models are in world space like the blocks, and
move only by drawing the next model in a list each frame — the boat is 64
models at half speed, the flags 32, the water and the lights 64.

The rest are a line or two of arithmetic each, ported as they stand: the slot
machine's three reels stepping at a half, one and two a frame; the dice
turning `-0x100` a frame about Y and the roulette `+0x100` about Z; the horses
galloping round an ellipse 25 across and 35 deep, TGP functions `0x1D` and
`0x1E` being the sine and cosine of the phase, turned to run along it; the
gulls orbiting at 15 with a wing table indexed for three beats and a glide; the
wind farm's blades walking 64 models beside two parts that do not.

Which way the TGP turns was settled by the slot machine: its reels are turned
`0x382D`, and with the sign the other way they face into the rock behind the
housing. The horses then confirm both the orbit and the heading, since they
only run forwards if both come out right.

Each build's numbers — where the table is, which routine each record starts in,
and the tables the routines read — are in [`js/games.js`](js/games.js), found
per build by stf-tools' `daytona-tables.mjs` out of the instructions that use
them and held against the profile with `--check`. The routine names travel by
record rather than by address: all eight builds place the same 130 records in
the same order, so the Nth record's routine is the same routine in each.
Revision A and the five sets built on it share one layout; the Special Edition
moved its tables and put back a second crowd. The 1993 version writes several
routines its own way — each check point is a routine with its scale and list
inline rather than an id into a table, the dice turn the other way, and the
crowd routine draws both crowds an instruction at a time, which the tool traces
into a list of groups — and all of it is in its profile too.

**The horses bolt.** On the board a horse that the car comes within 8 of takes
the car's heading and half again its speed, runs straight along it over the
ground until its block is out of view, and is back on its ellipse 2560 frames
later. In the explorer the camera is the car: fly at a horse and it runs the
way you are going. The camera can stand still or jump, so the speed it lends a
horse is kept between 1 and 6 units a frame — the explorer's numbers, not the
board's — and "out of view" is the 5×5 blocks round the camera that
`set_area_block` marks, less the heading clip it takes off them.

**Blocks drawn.** The board never draws a whole course. `set_area_block`
marks the 5×5 blocks round the camera's block, and only those are drawn. The
**Blocks drawn** picker on the Stages panel draws a course either way: every
block a car can come within two blocks of, which is the whole course as far as
anyone racing it sees, or the board's own window round the explorer's camera,
which follows it as it flies. Drawn the second way, a horse whose block is out
of the window also stops on its ellipse, as it does on the board.

**Game state.** The routines test two things besides the course: the mode
(`M_mode` is `1 << B_mode`, so `0x10000000` is `STAFF_DSP`, the ending) and a
flag `gear_select` sets when a button is held at the transmission select,
which `entry_car_event_open` reads to enter no rival cars — time attack. So a
picker on the Stages panel draws a course as a race, in attract mode (which
differs in the windmill: in a race it shows on a stretch of road, in attract
mode while its block is in view; and in the windows below, which hold still),
in time attack — six more flocks of
gulls that grow as the race goes on, a third group over the first, and the rank
board showing your own number — or in the ending, with the third group of gulls
and the horses' curtain call.

**Windows.** The grandstand's glass and the covered walkway's each carry 64
frames of reflected sky, and the board picks one every frame by where the car
stands, so the reflection slides as you drive past. The grandstand's frame is
the heading from a point behind it to the car (TGP function 0x0F); the
walkway's is how high a point 220 up stands from the car, by its distance
across the ground (functions 0x43 and 0x0A). In the explorer the camera is the
car. In attract mode the board's car stays at (0, 0), so the frame holds:
27 on the grandstand, 57 on the walkway. Checked in MAME, with the car's place
swapped for random ones as the board read it: the grandstand matched on all
156 frames drawn, the walkway on 119 of 121, and the two misses sit within
0.006 of a frame's edge, the TGP's own arctangent. The walkway's routine has a
second point, which it takes when a flag bit no MAME run set is on; that case is
left out.

What is left out: the cones stand where they are placed and are not knocked
flying, stood on the road the course draws rather than on the collision
polygons the board asks the TGP about, which are in its own ROM and not read;
and the Jeffry statue's turn, which the board saves for a player who stops
beside it and presses the view button.

### The sky

The sky is not geometry. It is the tile chip's panorama, the same machinery as
Fighting Vipers' sky: a course's four-course table row names its sky, which is
a CG list, a palette list and eight patterns of 32 tiles, 256 tiles round the
full turn. The board streams it into the 64-tile tilemap a column at a time as
the car turns (`heading >> 13` picks the pattern, `heading >> 5` is the X
scroll), and [`js/scroll.js`](js/scroll.js) lays all eight side by side and
puts them on a cylinder. Unlike Fighting Vipers' strips, these carry what lies
below the horizon too — the grass round the Speedway, the sea off Seaside
Street Galaxy, the floor of cloud under Dinosaur Canyon — and panorama row 144
goes on the eye line, the row the board's scroll arithmetic puts there on
every course. Graded against the tile chip's RAM captured from MAME in the
attract race: the characters are byte-identical, and every one of the 64
columns in the name table is a whole column of the decoded panorama, starting
at the tilemap row this assumes. Which compass direction each part of the sky
faces has not been checked against the board.

### Mip levels

The texture sheets are graded against texture RAM captured from MAME running
the game — Revision A and 1993, all three courses — and match byte for byte,
full size and all nine mip levels (stf-tools' `test-daytona-texram.mjs`). The
first mip level had been dealt onto the wrong sheet, which is why a distant
tree could show a shrunken piece of some other texture.

And one thing is missing from the checking. Sonic The Fighters' texture and
colour ports are held against a capture of the real board; this one is not,
because the game cannot be made to reach its own uploads here. It boots in MAME
and then spins at `0x228240` on `ldob 0x1C00040` — the dual-port RAM the Model 1
I/O board answers on, and that board's MCU ROM is not in the sets to hand, so
texture RAM and colorxlat stay empty however long it runs. What the board did
confirm is smaller but real: the sixteen-entry palette init the boot sequence
copies from program ROM `0xCCC` lands byte for byte at palram 0 *and* at palram
`0x2000`, which is the face-palette base this profile uploads to. The rest rests
on the instructions the addresses were read out of, on the 2817 meshes that
decode, and on the highest colorbase in the game being 1006 against a palette
upload of 1007.

## Virtua Cop

`vcop.zip` (Revision B) loads with the Stages, Models and Cells tabs. Virtua Cop is Daytona USA's
library a year on — the texture-bank upload, the colorxlat and luma builds and
the material upload are Daytona's routines instruction for instruction, with
their tables moved into the data ROM — so it is a Daytona profile with its own
numbers ([`js/games.js`](js/games.js)). The model table has 1234 entries, every
one with geometry.

The Stages tab has the three stages — the harbour, the construction site and the
high-rise — read from the table the board draws them from
([`js/vcop.js`](js/vcop.js)). A stage is a run of segments, each a list of
placed models; the board draws one segment at a time and steps to the next as
the rail camera passes a mark, and neighbouring segments repeat most of their
pieces. The **Zone** list shows one segment or all of them at once. Each stage
is drawn under its own texture set, the one the board loads for it.

The sky is the tile chip's layer, not geometry: the stage's sky and sea images
and its colours, as the stage start lays them down ([`js/vcopsky.js`](js/vcopsky.js)).
The objects layer holds what stands in a stage besides its pieces — cars, vans,
drums, crates, glass — from a second per-segment table, each object built from
its type's parts at their offsets, and objects that ride on others under them.
Breakables stand whole. The cars' windows reflect the sky, and the reflection
slides as the camera turns: each window's routine slides its texture points by
the camera's yaw and pitch every frame, and the explorer slides them by its own
camera, as the routine would (checked against the points MAME uploads). The boot sets ten palette entries by hand after loading the table —
the drums' teal among them — and the explorer does the same.

The stages have their music: tick **music** on the Stages tab and each stage
plays the song the game starts it with, on the game's own sound board, the same
board as Daytona USA's, with Virtua Cop's driver and samples. See [Virtua Cop's
music](TECHNICAL.md#virtua-cops-music).

The light is the game's own: each stage's light table, by how far along the
rail the eye is, and out of play the fixed light 0x1E1C8 sets.

The enemies stand where each wave puts them, on the **fighters** layer, in the
pose of the first frame the board draws them: the explorer runs the game's own
spawn and enemy task for each one, and the joints match MAME's to 1e-5. Each
comes up with the segment its wave starts on. Enemies standing on a moving
object are left out. See [Virtua Cop's enemies](TECHNICAL.md#virtua-cops-enemies).

The game builds no models in RAM. Entries 0x4D2 on (crate shadows, the WHARF
sign, the stage 3 panels) are ROM meshes in a second table at 0x8693F0, and the
explorer draws them. In MAME, on all three stages, every object the board draws
points at polygon ROM, and the game never writes polygons into RAM.

The **Cells** tab has the game's 2D art: the title logos, the instruction
panels in Japanese and English, the detective badge, CONTINUE?, GAME OVER,
RELOAD, the stage select, NAME ENTRY and RANKING, the boss lines, the
AM2 and SEGA logos, the EPA notice, and the fonts. There are 282 cells, each drawn
on the CGs the game builds: the boot's (its tiles, its palette in the order the
boot writes it) and one for each stage, which puts that stage's sky colours in
the sky's group. Every cell has a CG that writes every tile it names. No aligned
word in the program or data ROM names 68 of them, so they are marked unused,
and searching for `unused` lists only those. The cells are records in the
data ROM: columns, rows, then a halfword per tile. The draw adds a halfword
to every entry: 0x8000 for most of them, 0xC000 for some, and 0 for the sky
and the sea. See `VCOP_CELLS` in [`js/games.js`](js/games.js) and [Virtua
Cop's cells](TECHNICAL.md#virtua-cops-cells-jscellsjs).

## Virtua Fighter 2

`vf2.zip` (Version 2.1) loads with the Stages, Models, Animation and Cells tabs. Virtua Fighter 2 is AM2's library
the year before Fighting Vipers: the model table, the face palette and the
colour uploads are at the same addresses, and what moved is in the program ROM,
each number read off the instruction that uses it ([`js/games.js`](js/games.js)).

The Stages tab has the twelve stages the record table holds once each
([`js/vf2.js`](js/vf2.js)), named as the game's own debug menu names them —
Ikada, the raft; Ban-ri, the Great Wall; Yuki-yama, the snow mountain; and
the rest — and the Colosseum's second look, which the record carries as a
second set of lists. As in Fighting Vipers, the pieces are modelled where they
stand, so a stage is its lists drawn at the origin; the ring floor is the one
piece scaled, by the operator's ring size (8, the default). The raft is drawn
whole, as it floats before a fighter nears its edge, and Dural's stage has its
mirror floor. With that stage picked under **Fought on** in the Animation tab,
the fighters show in the floor, and Kage's hood band and Pai's ornament show in
it with them, each in the cut-down model the game keeps for its reflection.

The **music** switch plays the stage's song on the emulated sound board, the
same board as Sonic the Fighters'. Beside it, **stage sounds** plays what the
stage plays by itself: the crowd in the Colosseum and the calls and cues of
four others, ported from the game's per-frame task.

Each stage has its sky, the tile chip's layer as in Fighting Vipers, read out
of the game's own per-stage record and scrolled the way the board scrolls it.
On Ikada the raft rocks on its two swells and the river bank slides past it,
as the stage's own per-frame routines move them. The logs drifting apart is
left out: the game does it when a fighter nears the edge, so it belongs to the
fight.

The stages' own effects run too, from the routines the game runs every frame.
Leaves blow across Tou-rin. Lightning strikes the Colosseum: the clouds and
the mountain flash, a bolt splits the sky, and the arena flashes white with
its lit second look. The game times the strikes off hardware counters, so the
explorer keeps their odds but not their moments. Under the mirror stage's
water the sky ripples line by line, as the sea shimmers on four others, and
each stage takes its colour cast from its record, the mirror stage's blue-green
the strongest. The bubbles rising from a fighter are left out with the fighters.

The Animation tab has the **fighters** — Akira, Jacky, Sarah, Kage, Lau,
Jeffry, Pai, Wolf, Shun, Dural and Lion, named from the game's own tables —
each on its own texture sets, with a **P2 colours** switch for the look player
2 wears when both pick the same fighter (Akira's white gi among them, and
Sarah's, Kage's and Jeffry's own faces, which the game's face step picks for
that look) — and
every one of the
1359 motions in the game's table plays on any of them
([`js/vf2fighters.js`](js/vf2fighters.js)). Each fighter's list opens on its
moves, the motions its own input program can start, as Fighting Vipers' does
([Virtua Fighter 2's moves](TECHNICAL.md#the-motion-list-the-fighters-own-motions-first)),
each under its input: Jacky's *P , P , back+P*, Pai's *P , P , P , down+K*,
the throws on *G+P*. The motions are Sonic the Fighters' keyframe format a year early, and the pose is solved as
the game solves it: on one standard rig for everyone, then placed on the
fighter's own skeleton. Played on, a fighter blends from one motion into the
next, turns its head toward the motion's face target a step at a time and
crouches as the game crouches it, all checked against the board. An opponent
(off by default) can stand where a round starts the other fighter, with each
head turning toward the other's on every frame. It is the same fighter unless
the panel picks another, and it plays the fighter's motion or the **reaction**
the game would give it: the hit, counter hit, guard or knock-down motion the
fighter's strike calls for, from the frame the strike lands, or the motion of
the one thrown with a throw ([The opponent's reaction](TECHNICAL.md#the-opponents-reaction-jsreactionsjs)). The game turns the head only when fight state allows, which the explorer
does not track, so with the opponent on, a head can be wrong. The chest's
twist toward the opponent is left out: the move record says when it may run,
but the branches that then hold it at 0 (`0x29198`, `0x291B0`) test the angle
to the face target `+0xB0C`, which the fight writes.

The **Cells** tab has the game's 2D pictures: 268 cells on 21 CGs, the title
logo, the player select with its portraits, the profiles, the ranking
certificates, the fight's messages, the staff roll and the screens the test
menu draws among them. There is no table of cells: the draw takes the
record's address, as Daytona's does, so a cell is a record in the runs the
game's own pointers lead to, and a CG is a pair of lists one routine loads
(the boot pair, the stage skies, and the screens' own). Every cell has a CG
that writes every tile it names, and where the code loads a CG and draws a
cell straight after (the title, the player select, the test screens) the tab
opens it on that CG. Searching for `unused` lists the 12 records nothing in
the program or data ROM points at. The timer's digits and the other strips
of frames are drawn by another routine a frame at a time, and are left out.
See [Virtua Fighter 2's cells](TECHNICAL.md#virtua-fighter-2s-cells-jscellsjs).

### What each game has

The games share one explorer, but not every feature reaches every game: some
need a table found in that game's ROM first. Where they stand:

| | Sonic the Fighters | Fighting Vipers | Virtua Fighter 2 | Dead or Alive |
|---|---|---|---|---|
| Opponent, picked from the roster | | yes | yes | |
| Opponent plays the reaction | | yes | yes | |
| Mirrored fighter, and the one it throws | | yes | yes | |
| Hand shapes from the move script | | yes | yes | |
| Moves by input | yes | yes | yes | |
| Strings played | yes | | | |
| Fighter's own motions grouped | yes | yes | yes | |
| Sway chains | yes | yes | yes | |
| Hit flash | | yes | | |
| Afterimages | yes | | | |
| Stage sounds | | yes | yes | |
| Cells tab | yes | yes | yes | yes |

The rest are the next ones to do: an opponent for Sonic the Fighters (its
characters are posed through a rig of their own) and Dead or Alive (whose
fight code already runs both players), stage sounds for Sonic the Fighters
and Dead or Alive, and playing Fighting Vipers' and Virtua Fighter 2's
strings, whose tables are read but whose hand-over frames are not yet. Virtua Fighter 2 has no hit flash to show: every fighter
draw goes through `0x7C60` with the colour left as it is.

## Dead or Alive

Every build MAME has loads: `doa.zip` (Revision C, Model 2B), `doab.zip`
(Revision B), and the Model 2A builds `doaa.zip` (Revision A), `doaab.zip` and
`doaae.zip` (export). The 2B builds have all four tabs, fighters included; the
2A builds the Stages, Models and Cells tabs. A merged set, or several zips dropped at
once, opens as Revision C, and the Build list at the top of the sidebar picks
another. Tecmo's game keeps no
stage records: each stage is a routine of its own that places its pieces and
hands them to the geometry engine, so the explorer runs those routines on an
i960 interpreter and keeps what they draw ([`js/doa.js`](js/doa.js)). That
gives twelve stages, numbered as the game numbers them (the ROM has no names
for them), with their banners and ropes, their textures and their colours.

The textures are the game's own slabs, copied into texture RAM as the game
copies them, and they carry no smaller levels; the explorer draws them at full
size at every distance, as the board does.

The sky behind the outdoor stages is the board's tile layer: four pictures a
stage, laid round the arena as one ring and placed as the game scrolls them,
which a MAME frame and the explorer from the same camera agree on. The indoor
stages have none.

On Revisions B and C, stage 1 has the two fighters of the attract fight MAME shows
there, Zack against Tina, played from the round's start by the game's own
fight code, hits, camera, attract AI and all: textured, coloured, with their shadows, and posed as MAME has them
at that frame, Tina's ribbon included. The stage's ropes and banners hang as
they swing at that frame too. They hold that one pose; the 2A builds' fighters
are not read yet.

Stages 0, 2, 3, 4, 8, 10 and 11 have pieces of their own that move (stage 4 is
a conveyor). The game's own stage code runs them from its setup to the same
moment of a fight, on both revisions, and keeps running them a frame at a time
while you watch, as it does stage 1's ropes. Checked against MAME's attract
(with the stages swapped in), they move as the board moves them, word for
word over 300 frames, except where they follow the game's camera (0, 2 and
10) or scroll the sky (11). Stage 4's code has a
copy-paste slip that leaves one row of the belt hanging far below the rest for
part of each cycle; the explorer fixes it, so the belt stays whole.

The **Cells** tab has the game's 242 pictures: the Tecmo logo and warnings,
the fighters' profiles, portraits and name plates, the stage skies, the
fight's messages and fonts, the rankings, the endings, the staff roll and the
title logos. Tecmo's format is not Sega's: each picture brings its own tiles
and colours, so each cell opens on a CG of its own with the same number (see
[TECHNICAL.md](TECHNICAL.md#dead-or-alives-pictures-jscellsjs)).

## Running it

Tick the acknowledgement on the loading screen — the project was generated with
assistive AI, and the page asks you to say you know that before it will take a
ROM set — and drop the zips on.

On a phone or tablet the page lays itself out for one instead: the view fills
the screen and the panel becomes a sheet along the bottom of it — tap a tab or
the handle to open it, drag on the view to orbit, and tap a part to identify it.
The noclip camera is a stick and two lift buttons there, with a drag on the
view to look. It is the user agent that decides, not the window's width, so a
narrow desktop window keeps its sidebar; `?mobile` and `?desktop` on the URL
force one or the other, and the link at the foot of the panel switches in place
without dropping the ROM.

Sonic The Fighters comes in two builds, and the viewer reads both: Sonic The
Fighters itself (`sfight`, program EPROMs `epr-19001`–`epr-19004`) and the
export build, Sonic Championship (`schamp`, `epr-19141`–`epr-19144`), MAME's
parent set. They share every mask ROM (`mpr-19005`–`mpr-19020`), so the models
and textures are the same; Sonic Championship's program has its own English
text and nine more cells (its title logo among them). Which zips depends on
how your set is organised:

- **non-merged** — `sfight.zip` on its own carries both builds and loads as
  Sonic The Fighters; `schamp.zip` on its own loads as Sonic Championship.
- **split** — `sfight.zip` *and* `schamp.zip` together: the program EPROMs come
  from the first, the data ROMs from the second.
- **merged** — `schamp.zip` on its own; the clone's EPROMs are inside it, and
  it loads as Sonic Championship.

Where a set holds both builds, the other is offered as a variant.

For Fighting Vipers it is `fvipers.zip` on its own, which carries everything.

Daytona USA is easiest as one merged `daytona.zip`, which carries the parent and
all seven clones and loads as any of them. Split sets work too: the 1993 version
wants `daytona93.zip` for the ten chips it has of its own (twelve, with its
sound program, which the music needs) and `daytona.zip` for the rest, which MAME keeps in the parent. Member names are matched by checksum
where the label does not match, so a set spelling those chips the way an older
MAME did — `epr-16526.8` for `mpr-16526.8`, `.23` for `.ic23` — loads just the
same.

So is `hotdp.zip` for the House of the Dead prototype: its two playable stages,
assembled from the game's own placement tables and split by the texture set each
part is drawn under, every model by its development name, with the textures,
palette and colour tables of the part of the game that draws it, and its 68
enemy bodies playing the 507 motions baked for their joint counts.

The finished game takes `hotd.zip`, in either revision — MAME's `hotd`
(Revision A) or `hotdo`. Its 7477 models come out under their development names,
each drawn with the textures and palette of the chapter that draws it, across
thirteen texture sets against the prototype's eleven, and its four chapters come
out as eighteen stages — every zone a chapter's scripts reach while one texture
set is loaded, plus the whole of each chapter's table, with its 94 enemy bodies
playing the 674 motions baked for their joint counts. `BO_devilonx` beats its
own hundred wings (`PN_devilonx_hane01` on), as the game's draw callback gives
it `BO_devilon`'s case.

A stage opens in the first zone its scripts make current, and the **Zone**
picker steps through the rest in the order the scripts reach them. That is what
the board draws: one zone at a time, the one the section script last made
current. The tables hold several versions of one piece at one spot (the
mansion's front with its doors shut, nearer, and open), and each zone lists
one of them. "Every zone at once" draws all the zones together, versions and
all, so they overlap where they share a spot.

The props the scripts spawn stand in their rooms on the **objects** layer. In
`hotdo` that includes chapter 4's gate (room 4's walls and shutters), standing
as it does before the player opens it, its top piece turning as the board turns
it. Chapter 2's two glass cases and chapter 3's five roof pieces stand there
too, whole. Chapter 4's steam vents and floor flames are props that loop
their models, and so are chapter 1's three `PN_powa` props and chapter 4's
`PN_eneene` prop; they loop here while animate is ticked. Chapter 3's two
fans spin while animate is ticked, as they do once spawned, and chapter 2's
breaking wall stands whole, and two hanging bodies (`PN_niku_001`) beside it
hang still. Chapter 3's `PN_st3_card01a`, `PN_sekom01a` and `PN_sekom02a`
and chapter 4's `PN_sousa00a` stand as props, and so do chapter 3's two
`PN_kikai_b` machines and chapter 2's chained lid (`PN_r2_01_futa`), until a
shot breaks them.
Chapter 2's section 9 stands a door (`PN_door_n4a`), drawn taller and
narrower than its model, as the board draws it there.
A fish with a man's face (`PN_jinmengyo`) swims its loop in chapter 2's fish
tank while animate is ticked, along the path the board gives it. The prototype
(`hotdp`) has the same fish in the same tank, and it swims there too.
Its chapter 1 has the three `PN_powa` too, looping in the zones the board
draws them in.
Its chapter 2 has the breaking wall too, standing whole in the zones the board
draws it in.
In chapter 2's section 9, one spawn stands a row of eight props of
its own (`PN_kenita00a` to `07a`), where the board puts them.
In chapter 1's section 8, two spawns stand a room's furniture out of a
table (chairs, tables, cups, a pot, bookcases, a lamp and chests), in both
builds.
Chapter 1's section 6 lays a dining table (a table, six chairs, six plates, a
vase and a skull) and chapter 2's section 12 a banquet (three round tables,
plates, fruit and candlesticks), each one spawn standing a group of props
about its own place, in both builds.
Chapter 1's section 13 stands `PN_furukagi00a` still, as the board draws it
until a shot or the game swings it. The prototype stands it at the same place,
still, in the zone its section 8 draws it in before it closes; the swing it
starts just before then is left out.
The prototype's chapter 2 also stands a double door in its section 1
(`PN_r2do_01a` and `01b`), shut, as the board draws it until an enemy bursts
it open; the explorer opens no enemy, so the burst is left out.
Chapter 4's four life items stand in their corridor, as they do
until a shot takes them, and five gold coins spin on its floor while animate
is ticked. Opening the gate, breaking the cases, pieces and wall, closing the
`PN_powa` and `PN_eneene` props, swinging `PN_furukagi00a` and slowing the
second fan wait on flags that shots set or on the zone's own clock, so those
are left out, and so is the bodies' animation, which waits on two bits of
their own flags.

The finished game's stages have their music too: tick **music** on the Stages
tab and each chapter plays the song its own scripts start, on the game's Model 2
sound board with its driver and samples. See [The House of the Dead's
music](TECHNICAL.md#the-house-of-the-deads-music). The prototype (`hotdp`) plays
its own: its own sound program and samples, and the songs its own scripts start
for its two chapters.

`hotdo` has a **Cells** tab too: its 630 pictures, the title logo's layers, the
EPA notice, the house map, the weak-point cards, the colour bars and FREE PLAY
among them. Each picture brings its own tiles and colours, as Dead or Alive's
do. Revision A moved the table, and it has not been found yet, so `hotd` has
no Cells tab. See [The House of the Dead's
cells](TECHNICAL.md#the-house-of-the-deads-cells-jscellsjs).

A merged archive carrying the parent and its clones together works too, and
loads as the parent: the chips at the top level are the parent's, and the ones
in a directory are a clone's, which is how MAME writes them.

Then serve the directory over HTTP — the page is ES modules, so opening
`index.html` off the filesystem will not work. The dev server moved out with the
rest of the tooling, into
[stf-tools](https://github.com/biggestsonicfan/stf-tools), which carries this
repository as a submodule and serves it:

```
git clone --recursive https://github.com/biggestsonicfan/stf-tools.git
cd stf-tools && npm start      # http://localhost:8173
```

That serves the explorer commit stf-tools is pinned to. To see the checkout you
are editing, point it there — `STF_SITE=/path/to/noclip npm start`.

Any static server will serve the site, but that one refuses a `.zip` per
request, and a working checkout is exactly where the zips sit — so a plain
`python -m http.server` in this directory would hand your ROM to anything that
asks for it. Serve it from something that will not.

There is no build step and no dependency install, and nothing of three.js is
carried here: the library comes from cdnjs and its one addon from jsDelivr, both
pinned to a version and integrity-checked by the import map, so what arrives is
the build named there or nothing at all. The page therefore wants a network on
first load; a checkout that has to run air-gapped can point those two import-map
entries back at local copies.

The ROM set is always supplied by you. The page never fetches one, and
stf-tools' `serve.mjs` refuses `.zip` outright — a working checkout does have
the zips sitting in it, so the dev server is told in as many words never to hand
one out. A ROM sitting in this directory is not something the app can reach. Zips
are read with `FileReader` and decoded in the tab; nothing is uploaded anywhere.

Nor is any of the game's data carried here. The checks that hold the decoders to
a real machine used to measure against 2.2 MB of captured texture RAM kept in
the tree; they now measure against `stf-tools/texram-ref.json`, SHA-256 over
that capture, which asserts the same thing — a single wrong texel still fails —
without being the game's bytes. stf-tools' `extract-texram.mjs` rebuilds the
binaries from your own ROM set when they are wanted, and writes them outside the
checkout. The reasoning, and the trap of letting a port grade itself, are in
[TECHNICAL.md](TECHNICAL.md#checking-against-the-board-without-carrying-its-data).

### The loading screen's clips

The reel on the loading screen plays clips the explorer itself drew:
stf-tools' `record-previews.mjs` loads a set into this page in headless Chrome,
takes the camera off the mouse, flies it along a scripted path one fixed step
at a time and hands the frames to ffmpeg. Each shot is a few lines in that
script's `SHOTS` table, and pointed at this checkout it writes
`media/previews/<game>-<shot>.mp4` here with a poster beside it. A clip appears
on the page once its card in `index.html` lists it; a game with no clips takes
its turn on the reel as a card saying so.

```
# in stf-tools, after npm install there
export STF_SITE=../noclip
node record-previews.mjs --game stf --list sfight.zip   # what the shots index
node record-previews.mjs --game stf sfight.zip          # record them all
node record-previews.mjs --game stf --only carpet sfight.zip
node record-previews.mjs --game hotdp --build hotdp hotd.zip   # a merged set
```

It wants Chrome or Edge (`$CHROME` names one) and ffmpeg with libx264. The ROM
set goes to the page through its file input and nowhere else; the script's own
server refuses a `.zip` like `serve.mjs` does. The clips are pictures of what
the explorer draws, not the ROM's bytes: nothing in them loads back into it.
Sonic The Fighters and the House of the Dead prototype have clips so far;
Daytona USA, the finished House of the Dead and Fighting Vipers have shot tables
still to be written on a machine with those sets.

## Reporting something wrong

Four buttons sit in the top right of the window, over everything: **Copy
diagnostics and file an issue**, a camera, a cube, and **GitHub**. The cube is
the model export, below.

The camera saves what the view is showing as a PNG, at the canvas's own
resolution and without the panel or the hud over it, named after the build, what
was on screen and the time. It appears once a ROM set has loaded. It is there
for anyone who just wants a picture, and for dragging into an issue — the
template asks for one.

The report button exists because of how this thing runs. Everything happens in
your browser, against your ROM set, on your GPU — so from the other end a report that
says "the road flickers" cannot be acted on. The button gathers what it would
take to sit down and reproduce it: which of the thirteen builds is loaded and
which zips it was assembled out of, every complaint `loadRomSet` made about
them, the tab and the stage or model on screen, the texture set, the shading
switches, where the camera is, the renderer string, and the last forty lines the
console saw. It puts that on your clipboard and opens a new issue with the
template already in it.

It works before anything has loaded, too, which is the report worth most: a set
that will not open carries the names of the zips you dropped and the error the
loader gave. Nothing is read off the ROM but the profile it matched and the
names of the files, and nothing is sent anywhere — the text goes to your
clipboard, for you to read before you paste it.

The report also carries a link, **Open this view**, to
`https://noclip.sonicthefighte.rs/` with the view in the fragment after the `#`:
the build, the tab, the stage, model or fighter and motion (its frame, and
whether it was paused), the stage clock, the layers switched off, the panel's
switches, the phone or desktop layout, orbit or noclip, and the camera to the
third decimal. A ROM set cannot travel in a link, so opening one puts the build
it wants on the loading screen — drop that set's zips and the explorer loads
that build out of them and opens where the report was filed. Zips that turn out
to be another game still load, on the default view, with a note saying so. The
link lives in the fragment because the fragment never goes to the server, and
because the query string belongs to the `?mobile` / `?desktop` switch.

The one thing worth adding by hand is a screenshot. Drag it into the issue.

## Exporting models

The cube in the top right saves the models in view as a `.glb`, at the frame
they are on: pause a motion or a stage where you want it and every draw is
written at that pose and in that place, one object each, in world space. It
costs nothing and needs nothing but the ROM set already loaded; like the rest,
it is done in the tab.

Blender opens it with **File > Import > glTF 2.0**, and **Save As** makes it a
`.blend`. The page writes glTF rather than `.blend` itself because `.blend` is
Blender's own memory layout, which changes from release to release.

The board has no RGB textures to hand over (a face names a 4-bit tile, a luma
band, a material slot and a palette row, and the fill path turns those into a
colour with the light in it), so the export runs the fill shader once more into
a texture sheet: each face gets a cell of its own, drawn flat at a pixel to a
texel, with this frame's palette and light, and its UVs point at that cell. The
material is unlit, so what Blender shows is what the view showed, lighting
included. A half-transparent (checker) face comes out at half alpha. The sky
panorama and the scroll layers are not models and are not in it.

### The game's own camera (Sonic the Fighters)

On a Sonic the Fighters stage the panel has a **Game camera (SKY EYE)** field:
where the board's own camera would have to stand to see what the explorer sees,
in the numbers the game's debug menu uses. SKY EYE is the page of STF's debug
menu that flies the game's camera record by hand; the readout is that record,
`Xpos`/`Ypos`/`Zpos` in board units and `Xang`/`Yang` as the 16-bit angles the
page edits (0x10000 a turn), with the stage numbered as CAMERA POSITION 2 numbers
it. **Copy** puts it on the clipboard. **board lens** sets the explorer's field
of view to the board's (68.9° vertical, focal length 280 on 496×384), so a
picture taken here lines up with one taken on the board.

A Sonic the Fighters stage link carries the same camera as `eye=x,y,z` and
`ang=xang,yang,zang`, beside the explorer's own `pos`. A link with only `eye` and
`ang` opens on that camera. m2-hle2 reads the link the other way: its `sky_eye`
command (or `--sky-eye`, or its SKY EYE window) goes to the link's stage, waits
until the stage's textures have finished loading, and holds the board's camera
there, so a picture of the board can be laid over the explorer's. Its
`sky_eye_link` command writes the board's camera back out as one of these links.
`js/skyeye.js` has the conversion.

## Deploying

The site is static, so publishing it is a copy. A push to `master` runs
[`.github/workflows/pages.yml`](.github/workflows/pages.yml), which stages
`index.html`, `style.css`, `js/` and `CNAME`, and hands those to GitHub Pages.
There is nothing to build and nothing to install; what is served is what is in
the tree, which is why a change to a shader or the decoder is live as soon as
the run finishes.

**Settings → Pages → Source** has to be set to **GitHub Actions** once. After
that a `git push` is the whole deploy, and the workflow also takes a manual run
from the Actions tab, for republishing without a commit.

The custom domain is the `CNAME` file at the root of the repo — copied into the
published site, because that is where Pages looks for it. It wants a DNS record
to match:

```
noclip    CNAME    biggestsonicfan.github.io.
```

Then tick **Enforce HTTPS** in the Pages settings, once GitHub has issued the
certificate for the name. Moving the site to another hostname is those two
things and nothing else.

What ends up public is the viewer and nothing else. The workflow names four
paths, so nothing else in the checkout can be served even by accident — not a
dump some tool has left lying about, and not a ROM: the zips are
gitignored, so they are not in the checkout the workflow runs against, and an
artifact cannot serve a file it does not carry. Visitors bring their own, read
in their own tab.

That is the one thing the deploy needs no server of ours for. Locally
stf-tools' `serve.mjs` still refuses a `.zip` per request, and still should — a
working checkout is exactly where the zips do sit.

## Support

noclip is free and stays free, exports included. Behind it are hardware and
hours: a serial link to the Model 2B board that I reverse engineered and built,
EPROMs and a ZIF adapter to run test code on real hardware, a twin stick, the
Dreamcast research, and a lot of AI time.

Support, if there is ever a way to give it, will pay for that research, never
for the models. The games' art is Sega's, and an export is yours for nothing.

## How it works

The decoder, the stage and animation tables, the texture and colour pipeline,
the lighting model and the MAME capture tools are written up in
[TECHNICAL.md](TECHNICAL.md), which also carries the source layout.

## Credits

This viewer is the browser end of two other projects of mine, and most of what
it knows about the board and the game comes from them:

- [`m2-hle2`](https://github.com/biggestsonicfan/m2-hle2) — my Model 2 HLE
  emulator, in C11, with *Sonic The Fighters* as its reference game. The polygon
  decoder, material format and ROM layout here are ports of its
  implementations, and the in-page music is its sound board compiled to
  WebAssembly. It plays *Sonic The Fighters* (arcade and console versions),
  *Sega Rally Championship* and *Cyber Troopers Virtual-On* in the browser at
  [arcade.sonicthefighte.rs](https://arcade.sonicthefighte.rs), *Sonic The
  Fighters* online too, and *Fighting Vipers* on the desktop build. *Virtua
  Cop*, *Daytona USA* and *The House of the Dead*, which this explorer opens,
  are prepared profiles there that do not run yet; they take their model tables
  from `js/games.js`. It carries this repository as a submodule
  (`vendor/noclip`), and its graders (`tools/grade-stages.mjs`,
  `grade-models.mjs` and the rest) check what the explorer draws against its own
  decoder and the display lists the board builds. Nothing here needs it to run.
- [`stfdecomp`](https://github.com/biggestsonicfan) — my *Sonic The Fighters*
  decompilation, reversed and written by hand, source of the stage table,
  `CHAR_PARTS`, the bone tables, the motion-table addresses, the frame and
  palette-cycle tables, and the texture and colour upload routines.

The outside work this leans on is MAME, whose Model 2 driver is the ground truth
the two of them are checked against — the fill path in `model2rd.ipp` and the
geometry lighting in `geo_parse_np_ns` are what the shader here reproduces, and
[stf-tools](https://github.com/biggestsonicfan/stf-tools) drives MAME to capture
texture RAM and to diff against a real machine.
Daytona's sound board plays through two of MAME's sound cores, compiled into
`js/sound/model1.wasm`: its MultiPCM (`gew.cpp`, `multipcm.cpp`, Miguel Angel
Horna) and [ymfm](https://github.com/aaronsgiles/ymfm) (Aaron Giles), both
BSD-3-Clause.
Rendering is [three.js](https://threejs.org), loaded at a pinned version with
its hashes in the import map rather than kept in the tree — the library from
cdnjs, OrbitControls from jsDelivr.

Special credits also go to [Tim Ritiau | egregiousguy](https://x.com/egregiousguy) 
- For collaboration, direct research, and dedication in their own Model2 journey.

## AI usage

Written up from the commit log rather than from memory. That log is not this
repository's, though: every commit before the last carried 2 MB of the game's
own texture RAM, so rather than publish it, what is here starts at a single
commit and the per-commit record stays where it was written.

**What AI did.** All 35 commits, 2026-08-31 through 2026-09-03, carry a
`Co-Authored-By: Claude Opus 5` trailer — there is not one that does not. Every
line of `js/`, the shader, the scripts now in stf-tools and both of these
documents was written in a Claude Code session. The subjects show the shape of
it: porting decoders (*Sample the mip chain instead of the full-size level*),
chasing rendering bugs to their cause (*Make the per-face varyings flat*, an
NVIDIA-only artifact traced to perspective-correct interpolation of a constant),
building the MAME capture and diff tooling (*Capture the board's display list
and check the stage against it*), and the animation and object work the later
half of the log is made of. The companion emulator this ports from is the same
way — 580 of its 583 commits (merges aside) are AI co-authored — so the code
on both sides of that port is AI-written, and only the layer under it is not.

**What AI did not provide.**

- *The reverse engineering.* This is the part no model touched. `stfdecomp` is
  100% human reversed and written — every ROM address, table layout and routine
  in it was worked out by hand, and it predates this repo. When TECHNICAL.md
  says the sea steps its lumabase 7..70, or that `cage_clip_m` branches before
  it reaches the record's panel list, that is hand-decompiled code being ported,
  not a model inferring a format from bytes. Everything AI wrote here stands on
  that; take it away and there is no viewer.
- *The verdict on whether any of it is right.* MAME is the arbiter, not the
  model. Texture RAM and both colour tables are compared byte-exact against a
  running machine; stf-tools holds thirteen `test-*.mjs` plus `dl-verify.mjs`
  and `verify-stage.mjs`, which check the viewer's draw list against display lists
  captured off the board. The log is partly a record of that catching things —
  *Put the sphynx head where its own probe says it goes*, *Put the ground chunks
  at 1.6*, *Draw South Island's sea at the 1.6 the rest of the ground pass
  gets* — each a plausible first answer that measurement refused.
- *Anything you see on screen.* No asset here is generated. Every polygon,
  texel, palette entry and animation frame is decoded from the ROM set you
  supply; none ships with the repo, and the viewer has no way to invent one.
- *Direction.* Which stage looked wrong, which explanation was worth accepting
  and what to build next was mine.
