# Sonic The Fighters — 3D Explorer

A browser-based explorer for *Sonic The Fighters* (Sega Model 2B). It reads the
arcade ROM set directly in the page — no server-side conversion, no pre-baked
asset dump — and renders the game's geometry with three.js.

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
  every 256. The hammer-squished form is a checkbox: a second skeleton with
  every bone halved, and the second sixteen meshes in the part table to go on
  it. It is checked against a real machine: over 300 frames captured out of
  MAME, the joint angles come back bit-identical.
  See [Animation](TECHNICAL.md#animation), [Sway chains](TECHNICAL.md#sway-chains-jsosagejs),
  [Tails' tails](TECHNICAL.md#tails-tails), [Metal Sonic's jet
  exhaust](TECHNICAL.md#metal-sonics-jet-exhaust) and [The Egg robots' timed
  animations](TECHNICAL.md#the-egg-robots-timed-animations-jseggrobojs).

## Running it

Tick the acknowledgement on the loading screen — the project was generated with
assistive AI, and the page asks you to say you know that before it will take a
ROM set — and drop the zips on.

Which zips depends on how your set is organised. The viewer reads Sonic The
Fighters' own program EPROMs (`epr-19001`–`epr-19004`) and the mask ROMs
(`mpr-19005`–`mpr-19020`) that MAME shares with the parent set, Sonic
Championship (`schamp`), so a combined set is the least fuss:

- **non-merged** — `sfight.zip` on its own; it carries everything.
- **split** — `sfight.zip` *and* `schamp.zip` together: the program EPROMs come
  from the first, the data ROMs from the second.
- **merged** — `schamp.zip` on its own; the clone's EPROMs are inside it.

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
