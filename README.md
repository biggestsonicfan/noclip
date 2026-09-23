# Sega Model 2 — 3D Explorer

A browser-based explorer for Sega Model 2 arcade games. It reads the arcade ROM
set directly in the page — no server-side conversion, no pre-baked asset dump —
and renders the game's geometry with three.js. Drop a set on it and it works out
which game it is from the program ROM inside.

*Sonic The Fighters* (Model 2B) is the game it goes deepest on, and the three
views below are its. *Fighting Vipers* has stages and models — see
[Fighting Vipers](#fighting-vipers) — and *Daytona USA*, the one title here on
the original Model 2 board, has models in all eight of the builds it shipped as
— see [Daytona USA](#daytona-usa).

Three views:

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
- **Animation** — the cast, moving, and not only the fighters. The list is all
  34 roster entries: the seventeen `CHAR_PARTS` names and the mirror half that
  repeats them from index 26, so the Final Eggman Boss, the Egg UFO, the Egg
  Minion, Rocket Metal and Super Sonic are in it too. Each one's sixteen part
  meshes are assembled onto **its own** skeleton — the rig `SKELETON_TYPE_DATA`
  gives it, read off its own stance, rather than the one its record points at,
  which for several of them is somebody else's — and posed by the game's own
  motion data: pick any of its 52 action slots or browse all 518 motions in the
  table, and play it at the board's 60 Hz or scrub a frame at a time. The rig is
  the game's, not a guess at it — a body matrix, a chest and head that aim at a
  target, four two-bone IK chains that reach for one, and each fighter's own eye
  models on the head. The four entries that carry no head data of their own
  share the chest's angle instead of aiming at a target measured for a body that
  is not their shape.

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
  [Afterimages](TECHNICAL.md#afterimages-jszanzoujs).

## Fighting Vipers

Drop `fvipers.zip` and the explorer loads *Fighting Vipers* instead, with the
Stages and Models tabs — sixteen arenas and 5413 table entries, 3601 of which
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
with no matrix. So the draw list is the lists themselves. And a stage here
stands still: the object list a record points at is what animates, and walking
it is not written yet.

What else is missing: the character rigs and the motion tables, so there is no
Animation tab; and the stage names, so an arena is shown by the `stage_NUM` in
its own record until someone identifies it.

## Daytona USA

Drop a Daytona set and the explorer loads it with the Models tab. All eight of
MAME's builds are recognised — the 1994 parent and its seven clones — and a
merged archive carrying the lot is read as all eight at once: the panel grows a
**Build** picker and swapping between them reassembles the set without the zips
being handed over again.

Each build opens on the Stages tab with its four course grids, and the Models
tab has the rest. There are two sets of models behind those eight names, though,
and the profiles say so rather than implying otherwise. The 1993 Deluxe version (`daytona93`) has
its own data, its own fourth polygon pair and its own second texture pair: 2822
table entries, 2817 of them with geometry. Every build after it — Revision A,
the Special Edition, the Saturn-advert version and the four Kyle Hodgetts hacks
— carries a **byte-identical** model table and palette: 3190 entries, 3163 with
geometry. They differ in their program ROM and half a megabyte of data, not in
what they draw. What comes out either way is the grid of stock cars in their
liveries, the three courses' track sections, and the scenery along them.

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
course's own, so the two banks' mip halves come out complementary. Which of the
three courses a given model is drawn against is *not* known — the course data
has not been read, and tile coverage cannot answer it when every bank fills the
whole sheet — so the panel's picker decides and it opens on set 0.

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
Three-Seven Speedway oval at 10,290 triangles, Dinosaur Canyon at 46,585 and
Seaside Street Galaxy at 25,163 — and the fourth is a flat square of coloured
lane stripes with sample objects scattered over it, a test track. The
Saturn-advert build points its fourth slot back at the third, which is the
clearest statement that the fourth is not a course.

The same `sel_course` indexes the texture bank in `send_tex_map`, so a course's
texture set is its own number. That is what finally answers which sheets a
model is drawn against: every one of the 1024 block models now takes its
course's, and only the models no course claims still need the picker.

What is still missing is the track *surface* as the game drives on it — the
collision and height data is not in the polygon ROM but in the 4MB coprocessor
data ROM, four megabytes that open on a 4x4 identity matrix and are a third
plausible floats. The viewer does not need it to draw the course, and does not
read it.

Nor are there animations. This game has no rig and no motion tables — nothing
like the `BO_`/`MO_` arrays The House of the Dead carries — so there is nothing
of that kind to play. The cars do not move.

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

Which zips depends on how your set is organised. The viewer reads Sonic The
Fighters' own program EPROMs (`epr-19001`–`epr-19004`) and the mask ROMs
(`mpr-19005`–`mpr-19020`) that MAME shares with the parent set, Sonic
Championship (`schamp`), so a combined set is the least fuss:

- **non-merged** — `sfight.zip` on its own; it carries everything.
- **split** — `sfight.zip` *and* `schamp.zip` together: the program EPROMs come
  from the first, the data ROMs from the second.
- **merged** — `schamp.zip` on its own; the clone's EPROMs are inside it.

For Fighting Vipers it is `fvipers.zip` on its own, which carries everything.

Daytona USA is easiest as one merged `daytona.zip`, which carries the parent and
all seven clones and loads as any of them. Split sets work too: the 1993 version
wants `daytona93.zip` for the ten chips it has of its own and `daytona.zip` for
the rest, which MAME keeps in the parent. Member names are matched by checksum
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
playing the 674 motions baked for their joint counts.

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

## Reporting something wrong

Two buttons sit in the top right of the window, over everything: **GitHub**, and
**Copy diagnostics and file an issue**.

The second one exists because of how this thing runs. Everything happens in your
browser, against your ROM set, on your GPU — so from the other end a report that
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

The one thing worth adding by hand is a screenshot. Drag it into the issue.

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

## How it works

The decoder, the stage and animation tables, the texture and colour pipeline,
the lighting model and the MAME capture tools are written up in
[TECHNICAL.md](TECHNICAL.md), which also carries the source layout.

## Credits

This viewer is the browser end of two other projects of mine, and most of what
it knows about the board and the game comes from them:

- `m2-hle2` — my Model 2 HLE emulator, in C11, with *Sonic The Fighters* as its
  reference game. The polygon decoder, material format and ROM layout here are
  ports of its implementations. It is unreleased — there is no public repo to
  link, and nothing here depends on having it.
- [`stfdecomp`](https://github.com/biggestsonicfan) — my *Sonic The Fighters*
  decompilation, reversed and written by hand, source of the stage table,
  `CHAR_PARTS`, the bone tables, the motion-table addresses, the frame and
  palette-cycle tables, and the texture and colour upload routines.

The outside work this leans on is MAME, whose Model 2 driver is the ground truth
the two of them are checked against — the fill path in `model2rd.ipp` and the
geometry lighting in `geo_parse_np_ns` are what the shader here reproduces, and
[stf-tools](https://github.com/biggestsonicfan/stf-tools) drives MAME to capture
texture RAM and to diff against a real machine.
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
way — 35 of 35 commits AI co-authored — so the code on both sides of that port
is AI-written, and only the layer under it is not.

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
