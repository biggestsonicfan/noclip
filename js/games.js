/*
 * games.js — the per-game facts the rest of the viewer is parameterised by.
 *
 * Everything in here is what changes between one Model 2 title and the next:
 * which ROM chips make up each region, where the model table sits, and how a
 * table entry's mesh pointer turns into a polygon ROM offset. The decoders
 * themselves do not change — the polygon format, the texture headers and the
 * face palette are the board's, not the game's — so model.js takes these
 * numbers off the loaded ROM set rather than baking them in.
 *
 * A region recipe is a list of [destOffset, loName, loCrc, hiName, hiCrc]:
 * MAME's ROM_LOAD32_WORD, which interleaves two 16-bit halves into 32-bit
 * words. The destination offsets are the ones MAME loads at, holes included —
 * both games leave 0x400000 of the texture region empty between its two pairs,
 * and nothing addresses it.
 */

/* ---- Sonic The Fighters -------------------------------------------------- */

/* Mirrors the MAME `sfight` region layout (see m2-hle2 src/profiles/sfight.h).
 * Only the regions the viewer reads are assembled — program code, the
 * model/palette data region, the polygon ROM, the texture ROM and the start of
 * the coprocessor's data ROM. Sound is skipped. */
const sfight = {
    id: 'sfight',
    name: 'Sonic The Fighters',
    /* Members that say the set is this game and not the other. Both halves of
     * the program ROM's first pair, so a set missing one is not mistaken for a
     * set of the other game. */
    identify: ['epr-19001.15', 'epr-19002.16'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19001.15', 0x9b088511, 'epr-19002.16', 0x46f510da]],
        },
        /* 0x000000  model table (0x0E0004) + the global face palette (0x100000)
         * 0x800000  second data bank
         * 0x1000000 the window XTRA_DATA (0x06000000) mirrors — the motion
         *           tables live here. The game mirrors it every 1MB up to
         *           0x2000000; the viewer folds those addresses instead of
         *           materialising 32MB. */
        mainData: {
            size: 0x1100000,
            parts: [
                [0x0000000, 'mpr-19007.11', 0x8b8ff751, 'mpr-19008.12', 0xa94654f5],
                [0x0800000, 'mpr-19005.9', 0x98cd1127, 'mpr-19006.10', 0xe79f0a26],
                [0x1000000, 'epr-19003.7', 0x63bae5c5, 'epr-19004.8', 0xc10c9f39],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19009.17', 0xfd410350, 'mpr-19012.21', 0x9bb7b5b6],
                [0x800000, 'mpr-19010.18', 0x6fd94187, 'mpr-19013.22', 0x9e232fe5],
            ],
        },
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19019.27', 0x59121896, 'mpr-19017.25', 0x7b298379],
                [0x800000, 'mpr-19020.28', 0x9540dba0, 'mpr-19018.26', 0x3b7e7a12],
            ],
        },
        /* The coprocessor's data ROM, as the SHARC reads it at DM 0x1C00000,
         * one float a word. Only the first megabyte is kept: it holds the
         * sine and cosine tables the rig's rotations come from (js/pose.js).
         * Optional, because the viewer falls back to computing them. */
        copro: {
            size: 0x100000,
            optional: true,
            parts: [[0x000000, 'mpr-19015.29', 0xc74d99e3, 'mpr-19016.30', 0x746ae931]],
        },
    },
    /* The XTRA_DATA window at 0x06000000. This game mirrors one bank through
     * the whole of it — the last megabyte of the data region — repeated every
     * megabyte, so there is nothing to select between. */
    xtra: { window: 0x100000, banks: [{ region: 'mainData', base: 0x1000000 }] },
    modelTable: { offset: 0x000e0004, count: 5103, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: 0x00100000,
    /* `header` is the data-region texture header both games keep at 0x300000;
     * `pageTable` is the 24-entry (y, x) page grid in the program ROM, which is
     * the address that moves. `sets` is how many texture numbers the page-list
     * array holds. */
    texture: {
        header: 0x300000, pageTable: 0x4b394, sets: 0x12,
        /* Set 16 goes in ahead of whatever a stage names: the attract and
         * character-select screens leave it resident, and the stage sets do not
         * overwrite its deepest mip levels. */
        residentSet: 16,
        /* send_tex_default ends `send_tex_rob(1, 0, 0)` (0x4A994), and every
         * stage uploads beside it. See resolveTexSets in js/stages.js. */
        bootSet: 1,
    },
    /* Where each colour upload reads from. `at` is a main_data offset, and
     * `indirect` says it holds a pointer to the table rather than being it —
     * this game keeps a pointer block at 0x101000 and loads every table out of
     * it. `split` is the character number at which the part and skin tables
     * fold onto a second block. See js/colors.js for the shapes these fill. */
    colors: {
        luma: { count: 0x0d0008, data: 0x0d000c },
        add: [22, 22, 22],
        mul: [54, 54, 54],
        bright: 31,
        stage: { at: 0x101010, indirect: true, row0: 14, rows: 14, block: 0x540, blocks: 17 },
        /* Rows 5..6 and 12..13, written once at boot from two tables of their
         * own — the rows this game's other uploads leave alone. */
        fixed: [
            { at: 0x101014, indirect: true, row0: 5, rows: 2 },
            { at: 0x101018, indirect: true, row0: 12, rows: 2 },
        ],
        part: {
            at: 0x101008, atHi: 0x10100c, indirect: true,
            block: 0x2a0, rows: 5, row0: [0, 7], split: 26, blocks: 34,
        },
        skin: {
            at: 0x101000, indirect: true,
            block: 0x300, hiOffset: 0x2400, rows: 2, row0: [28, 30],
        },
    },
    /* Where the stage records are and how they are shaped. This game keeps
     * them in the program ROM at a fixed address and the material tables
     * beside them; the field offsets inside a record are the same for both
     * games and live in js/stages.js. */
    stageTable: {
        source: 'maincpu', at: 0x0008f3d0, stride: 256, count: 16,
        lists: { ground: [0x64, 16], cage: [0x84, 24], sky: [0xc0, 4] },
        materials: { source: 'maincpu', ptrs: 0x000909e0 },
    },
    /* How a polygon's board depth is carried into the depth buffer — the bound
     * on the far-corner recede, and the least the near plane may be. The note on
     * ZSORT_RECEDE in js/viewer.js is where these numbers come from.
     *
     * `layers` as well, because the recede alone cannot part a decal from a
     * face it lies on when that face is too deep to recede or seen square on.
     * Flying Carpet's floor, model 580, carries the pyramids' shadows as
     * checker polygons in the floor's own plane, and the floor's faces are a
     * hundred units deep, so they keep their depth and the shadows came out in
     * shards. Casino Night's slot machine, model 188, has its two JACKPOT
     * panels 0.02 and 0.03 in front of the faces they are painted on, which is
     * under the depth buffer's resolution at the stage's own framing, and the
     * cabinet's orange showed through them. js/layers.js ranks both the way
     * the board's sort does. Faces it ranks do not recede; everything else
     * still does.
     *
     * The order is the board's sort from the camera, worked out every frame.
     * Graded against MAME's pictures on Casino Night, it moved four pixels in
     * five that it changed nearer the board than the old three-in-four vote
     * did: the blue disc it laid over the floor is gone, as on the board. */
    depth: {
        recede: 12, nearMin: 0.02, layers: true,
    },
    scenes: null,
    /* The sound board's ROMs, read only once the music is switched on
     * (js/sound/sound.js): the 68000's program, loaded word-swapped as MAME
     * does, and the four sample ROMs end to end — the same layout m2-hle2's
     * profiles/sfight.h builds.
     *
     * `stageMusic` is STAGE_MUSIC_IN_ORDER, the table stage_bgm_select reads
     * the stage's song from: `ld 0xDBFDC[r3*4], g0` at 0x3F6A8, with r3 the
     * stage_num byte masked to its low four bits, and the long it loads sent
     * to the board as it is — 0xAE1004, South Island's, is status 0xAE and
     * the data bytes 0x10 0x04. Slots 0-10 have one; the rest are 0. What the
     * routine does ahead of the table — North Wind for Sonic against Knuckles,
     * South Island on Canyon Cruise and Casino Night in a two-player game — is
     * about who is fighting, which a stage on its own does not have. */
    sound: {
        program: ['epr-19021.31', 0x0b9f7583],
        samples: [
            ['mpr-19022.32', 0x4381869b], ['mpr-19023.33', 0x07c67f88],
            ['mpr-19024.34', 0x15ff76d3], ['mpr-19025.35', 0x6ad8fb70],
        ],
        stageMusic: 0x000dbfdc,
    },
    /* What the viewer knows how to do with this game beyond drawing a model.
     * Stages, rigs and motions are read out of tables this repo has only
     * located for Sonic The Fighters. */
    features: { stages: true, characters: true, motions: true },
};

/* ---- Fighting Vipers ----------------------------------------------------- */

/*
 * The `fvipers` set, worked out against the game's own program ROM.
 *
 * The two games share Sega's Model 2 library — Fighting Vipers carries the same
 * official labels in its program ROM (set_obj, set_obj_tpd, send_tex_col_*) —
 * so the table that matters sits in the same place. set_obj indexes it as
 * `lda unk_20E0004[g0*16], g0`: MAIN_DATA is based at 0x02000000 on the i960,
 * which puts the model table at 0x0E0004 of the data region with a 16-byte
 * stride, exactly where Sonic The Fighters keeps its own. The mesh pointer is
 * encoded the same way too, and the global face palette is the labelled
 * unk_2100000 — data offset 0x100000, a BGR555 table that opens on a linear
 * grey ramp.
 *
 * The entry count is the one thing the program does not state outright. Entries
 * run in banks separated by runs of zeros, and every entry up to 5412 has a
 * mesh pointer inside the polygon ROM and uv/material pointers inside the
 * texture ROM, while nothing above 8190 does — that upper stretch is other data
 * that happens to follow the table. 5413 is where the last populated bank ends.
 *
 * The chip assignments were settled by decoding with each candidate and keeping
 * the one whose polygon normals come out unit length and whose texture headers
 * name sane tile sizes. The sockets then line up with the other game: the
 * program pair at .15/.16, data at .11/.12 and .9/.10, polygons .17/.18/.19
 * against .21/.22/.23, and textures taking their low half from the higher
 * socket — .27 over .25, .28 over .26. Sockets .29 and .30 hold neither
 * polygons nor anything the model table points at, and are left out.
 */
const fvipers = {
    id: 'fvipers',
    name: 'Fighting Vipers',
    identify: ['epr-18606d.15', 'epr-18607d.16'],
    regions: {
        /* Half the size of the other game's: four 128KB EPRs in two pairs
         * rather than one pair of 512KB ones. The second pair carries the
         * lower-numbered chips, which is the order the board reads them in. */
        maincpu: {
            size: 0x80000,
            parts: [
                [0x00000, 'epr-18606d.15', 0x7334de7d, 'epr-18607d.16', 0x700d2ade],
                [0x40000, 'epr-18604d.13', 0x704fdfcf, 'epr-18605d.14', 0x7dddf81f],
            ],
        },
        mainData: {
            size: 0x1100000,
            parts: [
                [0x0000000, 'mpr-18614.11', 0x0ebc899f, 'mpr-18615.12', 0x018abdb7],
                [0x0800000, 'mpr-18612.9', 0x1f174cd1, 'mpr-18613.10', 0xf057cdf2],
                [0x1000000, 'epr-18610d.7', 0xa1871703, 'epr-18611d.8', 0x39a75fee],
            ],
        },
        /* Three pairs of 2MB chips laid end to end, so the polygon ROM is 12MB
         * of the 16MB region with no hole in it — the meshes run continuously
         * to 9.9MB, which is past anything two pairs could hold. */
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-18616.17', 0x15a239be, 'mpr-18619.21', 0x9d5e8e2b],
                [0x400000, 'mpr-18617.18', 0xa62cab7d, 'mpr-18620.22', 0x4d432afd],
                [0x800000, 'mpr-18618.19', 0xadab589f, 'mpr-18621.23', 0xf5eeaa95],
            ],
        },
        /* The second data bank, and what sockets .5 and .6 are for. It is not
         * part of the data region the i960 sees at 0x02000000 — it is reached
         * only through the top half of the XTRA_DATA window, which is where the
         * per-stage material table and the tables around it live. */
        xtraBank: {
            size: 0x100000,
            parts: [[0x00000, 'epr-18608d.5', 0x5bc11881, 'epr-18609d.6', 0xcd426035]],
        },
        /* Two pairs at the same two offsets the other game uses, which on 2MB
         * chips leaves 0x400000-0x800000 empty. Nothing points into it. */
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-18626.27', 0x9df0a961, 'mpr-18624.25', 0x1d74433e],
                [0x800000, 'mpr-18627.28', 0x946175a0, 'mpr-18625.26', 0x182fd572],
            ],
        },
    },
    /*
     * The XTRA_DATA window, which this game splits in two.
     *
     * The low half mirrors the last megabyte of the data region, as the other
     * game's whole window does. The high half — anything with 0x800000 set —
     * mirrors the second bank instead, and both halves repeat every megabyte.
     * The split was read off the board's own addresses: `lda unk_64266E0` for
     * luma lands in the low half and matches the data region byte for byte,
     * while `ld off_6CE33A4[r12*4]` for the material table lands in the high
     * half and matches the .5/.6 pair, which nothing else in the set uses.
     */
    xtra: {
        window: 0x100000,
        select: 0x800000,
        banks: [{ region: 'mainData', base: 0x1000000 }, { region: 'xtraBank', base: 0 }],
    },
    modelTable: { offset: 0x000e0004, count: 5413, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: 0x00100000,
    /* The whole texture pipeline carried across: every routine texture.js ports
     * is in this program ROM under the same official label, and
     * unp_send_tex_para_sub reaches the data header through the same
     * `ld off_230000C, r4`. Only the page grid moved, to unk_4B9C0 — read off
     * the same `ldos unk_4B9C0[g0*4]` pair that gives the y and x. */
    texture: {
        header: 0x300000, pageTable: 0x4b9c0, sets: 100,
        /* 100 because unp_send_tex_req rejects anything above it:
         * `lda unk_63, r3 / cmpoble g0, r3` — texture numbers run 0..0x63.
         * No capture says what the attract screens leave behind the others,
         * so nothing is forced in ahead of the chosen one. */
        residentSet: null,
        /* send_tex_default ends `addo 0x1F, 5, g0` and asks unp_send_tex_req
         * for it (0x4ACBC); every stage uploads beside it. See resolveTexSets
         * in js/stages.js. */
        bootSet: 36,
        /* The fighters' sets. Player set-up (0x1243C) reads the character
         * record `ld 0x640D2B0[char*4]`: sixteen part models listed at +0,
         * copied into the player at 0x12554, and the set at +0x20, handed to
         * the request at 0x4B0FC (0x12AF8), whose handler 0x4B1C0 loads it
         * and the next into the player's slot. Sets 1, 3 ... 17 and 93 for
         * characters 0-10 and 13; 11 and 12 have 0 and no textured part. */
        fighters: { records: 0x640d2b0, count: 14, parts: 0x00, partCount: 16, set: 0x20 },
    },
    /*
     * The colour tables, which turned out to be the same machinery again.
     * send_tex_col_go here is instruction for instruction the other game's
     * send_tex_col_loop, the ramp in chg_pol_color_req uses the same 0x1C/0x12,
     * and sub_74C builds the intensity curve on the same pivot and divisor
     * (`shlo 2, 0x1D` and `addo 0x1F, 6` — 116 and 37). The settings are not
     * the other game's, though: this one keeps a pair per channel at
     * 0x500234..0x500239, and a boot on empty NVRAM in MAME leaves 0x40, 0x25
     * in each pair and 31 at 0x50023A. With those, colorxlat comes out as
     * MAME's dump byte for byte; with the other game's 22 and 54, the flat
     * band ran 28..224 where MAME's runs 68..202.
     *
     * What differs is naming and rows. There is no pointer block: each upload
     * names its table outright — `lda unk_2109700` for the scene's,
     * `lda unk_2105800` and `lda unk_2107780` for a fighter's parts, and
     * `lda unk_2101000` for skin. And the parts take seven rows a side rather
     * than five, so rows 0..6 and 7..13 are both spoken for and there is no gap
     * left for the pair of boot-time tables the other game needs.
     */
    colors: {
        /* essential_color_handling reads these through the XTRA_DATA mirror as
         * unk_64266DC and unk_64266E0, which fold to these data offsets. */
        luma: { count: 0x10266dc, data: 0x10266e0 },
        add: [64, 64, 64],
        mul: [37, 37, 37],
        bright: 31,
        /* Nine scene blocks carry colours and the rest are empty, which is
         * the arena count; thirteen character blocks do, which is the roster.
         * Both counts are what the blocks hold, not a number the program
         * states — they are here so the panel can offer the real range. */
        stage: { at: 0x109700, indirect: false, row0: 14, rows: 14, block: 0x540, blocks: 9 },
        fixed: [],
        part: {
            at: 0x105800, atHi: 0x107780, indirect: false,
            block: 0x2a0, rows: 7, row0: [0, 7], split: 13, blocks: 13,
        },
        skin: {
            at: 0x101000, indirect: false,
            block: 0x300, hiOffset: 0x2400, rows: 2, row0: [28, 30],
        },
    },
    /*
     * The stage records, which are the other game's record exactly.
     *
     * `stage_data` is a label in this program ROM, at 0x06CE1048 in the second
     * bank, and change_scene indexes it with `shlo 8, r12, r4` off stage_num.
     * Every field the other game's reader knows is at the same offset: the
     * flags word at 0, the brightness at 4, the two rotations at 8 and 0x0A,
     * the texture set and colour block at 0x0C, the trim at 0x10, the four single models from
     * 0x18, the sixteen parts at 0x64, the cage at 0x84 and the object list
     * pointer at 0xB4. They were checked one at a time against the routine that
     * reads each — change_scene, stage_disp, pole_disp, cage_clip_m,
     * ground_upper_disp, object_init — and every single-model field resolves to
     * a table entry that carries geometry.
     *
     * The one list the other game has no equivalent for is the 32 entries at
     * 0x24, which ground_upper_disp draws.
     */
    stageTable: {
        source: 'xtra', at: 0x06ce1048, stride: 256, count: 16,
        lists: { upper: [0x24, 32], ground: [0x64, 16], cage: [0x84, 24] },
        /* A second array indexed the same way: sub_24878 walks 32 slots out
         * of `off_6CE33A4[stage_num*4]`. */
        materials: { source: 'xtra', ptrs: 0x06ce33a4 },
        /*
         * The backdrop colour, which is not the sky.
         *
         * There is no sky geometry in this game. No record carries a shell —
         * every byte past 0xB8 is zero on all sixteen, where the other game
         * keeps a four-entry list at 0xC0 — and no stage has anything
         * enclosing to stand in for one; the tallest thing on the western
         * arena reaches seven units and the largest is its own floor. The two
         * models sub_24224 draws four times round the arena are both railings.
         *
         * The sky is the board's 2D scroll layer, and it is per stage.
         * sub_29728 takes stage_num, indexes a 32-byte record at 0x6CE3600,
         * and hands the number at its 0x0C to _Scroll_Initialize, which loads
         * that stage's tile graphics from off_6450000[n] and that stage's
         * palette from off_6450000[n + 1]. A second pointer at 0x14 feeds a
         * per-stage tile blit that ends up in text RAM at 0x1004000. The
         * palettes are visibly skies and visibly differ. js/scroll.js decodes
         * the layer, and the backdrop below is only the fallback: what the
         * viewer normally shows behind an arena is the commonest colour along
         * the top row of that stage's own panorama, which is what the sky is
         * doing where the band runs out.
         *
         * The constant is the board's backdrop register. init_fix sets it once
         * in the boot sequence by handing bg_col_set this value, and
         * bg_col_set writes it into colour 0 of the first twenty-four palette
         * groups. In BGR555 it is R2 G8 B31 — a deep blue, and close to the
         * blue the top of the screen shows on the two daytime stages captured
         * out of the emulator, but one colour for all sixteen stages.
         *
         * The record's own 0x16, which change_scene writes to 0x18021EE, is a
         * single entry in the middle of a group and holds 0x8000 on every
         * stage. It is one tile's colour, not the sky.
         */
        backdrop: 0xfd02,
        /*
         * Where the scroll layer's per-stage sky comes from. sub_29728 indexes
         * `records` with stage_num << 5; `cg` is the entry it hands
         * _Scroll_Initialize, which takes the tile pixels from cgTable[cg] and
         * the palette from cgTable[cg + 1]; `patterns` points at the eighteen
         * pattern numbers it lays side by side, each looked up in patternTable.
         * See js/scroll.js for the formats.
         */
        scroll: {
            records: 0x06ce3600, stride: 32,
            fields: { cg: 0x0c, patterns: 0x14 },
            cgTable: 0x06450000, patternTable: 0x06450300,
            charBytes: 0x100000,
        },
        /*
         * The railing sub_24224 draws round the arena, four panels at quarter
         * turns behind a test of flags bit 17. The model is not a field of the
         * record: sub_24294 picks between two indices off the stage number
         * outright — `lda loc_444+6` for stages 0 and 4, `lda loc_AD8+1` for
         * the rest — and hands one to set_obj. Both are bars, twelve wide and
         * three tall, so it is part of the cage and not a backdrop.
         */
        rail: {
            model: 2777, bySlot: { 0: 1098, 4: 1098 }, turns: 4, flagBit: 17,
            /* sub_24294 pushes rotate, then translate (0, 0, dword_50A00C),
             * then scale by that same value over 6.0 — so with the 6.0 the
             * board sets at stage load the push is six units and the scale is
             * unity. Each panel is twelve wide and three tall, so four of them
             * pushed out six make the box round the arena. */
            push: 6.0,
        },
        /*
         * Every model in a list is drawn where it already is.
         *
         * The other game scales its arena by 1.6 and gives the cage, the poles
         * and the platform a transform each. This one pushes the stage position
         * once and then hands `area_clip` a list, and area_clip is a cull and
         * not a transform: it reads four indices per model out of a visibility
         * bitmap and calls set_obj with no matrix at all. So the geometry is
         * already in world space and the draw list is the lists themselves.
         */
        flat: true,
    },
    /*
     * No far-corner recede, and a near plane five times further off.
     *
     * The recede is what stood the textures against each other. Every stage
     * lays several plates in the one plane — road, floor, ring, the bases of the
     * buildings — cut at sizes that have nothing to do with each other, and a
     * bounded recede steps each face back by its own depth up to twelve units,
     * or not at all past twelve. So plates in one plane part by how they were
     * cut, and the parting moves with the camera. On the western arena the dirt
     * has faces deeper than the bound and keeps its depth while the wood ring's
     * faces of six to ten sink under it, leaving a wood octagon in the dirt; a
     * capture has wood from fence to fence. The same thing notched the wall tops
     * and ate the platform on the graffiti arena. With the recede off, the
     * plate biases buildFlatDisplayList hands out settle the plane by
     * submission order, which is the board's answer. See "Fighting Vipers takes
     * no recede" in TECHNICAL.md for the measurements.
     *
     * What the recede exists for is a surface modelled behind one it shows
     * through, and this game has none: searching every stage for a face lying
     * under an opaque face within 0.3 finds only things resting on the ground —
     * porch boards 0.002 over the dirt, a lip 0.27 over the floor — and the depth
     * buffer puts those on top unaided.
     *
     * What it does have is lettering 0.002 in front of its sign, and that is the
     * near plane's to hold: see setDepthProfile in js/viewer.js.
     */
    depth: { recede: 0, nearMin: 0.1 },
    scenes: null,
    /* The stage table is read, so the Stages tab is on. Rigs and motions are
     * still this game's own and not located, and neither is the object list a
     * record points at — a stage here stands still. */
    features: { stages: true, characters: false, motions: false },
};

/* ---- The House of the Dead (prototype) ----------------------------------- */

/*
 * The `hotdp` set: a Model 2C prototype on flash modules rather than mask ROMs,
 * and a game from AM1 rather than AM2. That second fact is the one that matters.
 * The program ROM carries none of the official labels the other two share, its
 * library is a different one (`_TaskOpen`, `_GeoWriteTex2`, `_TransMapLoadNow`),
 * and where the geometry is the board's own format and carries straight across,
 * the texture and colour pipelines do not.
 *
 * The chip order is MAME's, and it holds: every mesh the model table points at
 * opens on a unit normal across all five polygon bands, and every material
 * record names a sane tile.
 */
const hotdp = {
    id: 'hotdp',
    name: 'The House of the Dead (prototype)',
    /* prg0/prg1 are the program pair and no other Model 2 set uses the names,
     * but they are generic enough to want company. */
    identify: ['prg0.15', 'prg1.16', 'tgp0.17', 'tex1.27'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'prg0.15', 0x548ed10a, 'prg1.16', 0xf43bb51f]],
        },
        /* Three pairs of 4MB flash, laid end to end with no hole. The model
         * table, the name tables and the luma curves sit in the second pair;
         * the raw texture banks fill the first 11MB. */
        mainData: {
            size: 0x1800000,
            parts: [
                [0x0000000, 'dat0.11', 0x8d40fc82, 'dat1.12', 0x63e04c15],
                [0x0800000, 'dat2.9', 0x2aa9e4b9, 'dat3.10', 0x356d348b],
                [0x1000000, 'dat4.7', 0x7ec403f6, 'dat5.8', 0x592fac50],
            ],
        },
        polygons: {
            size: 0x1800000,
            parts: [
                [0x0000000, 'tgp0.17', 0xb458ec9b, 'tgp1.21', 0x4b250500],
                [0x0800000, 'tgp2.18', 0x17f68d25, 'tgp3.22', 0xcaff1d48],
                [0x1000000, 'tgp4.19', 0x8854f204, 'tgp5.23', 0x29f311f3],
            ],
        },
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'tex1.27', 0xeea00bdf, 'tex0.25', 0xfb10366a],
                [0x800000, 'tex3.28', 0x9a61d7e8, 'tex2.26', 0x84ec2923],
            ],
        },
    },
    /* A capture of the machine's address space has the whole last bank at
     * 0x06000000, not a megabyte of it repeated. The game reaches through the
     * window (`lda 0x6000C0C`) but nothing the viewer reads does. */
    xtra: { window: 0x800000, banks: [{ region: 'mainData', base: 0x1000000 }] },
    /*
     * set_obj is sub_FDB0, and it indexes `lda 0x2C5D1F0[g0*16]` — the same
     * 16-byte entry and the same mesh pointer encoding as the other two, in a
     * different place.
     *
     * The table is two copies of 5049 entries. Where the halves differ, only the
     * uv and material pointers do — the same meshes wearing a second set of
     * texture records, most likely the green blood the test menu offers. Empty
     * entries split each half into eight banks: the enemies and effects every
     * chapter shares, then a set per part of the game.
     */
    modelTable: { offset: 0x00c5d1f0, count: 10097, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: null,
    /*
     * The face palette is not in the data ROM, and it is not one table.
     *
     * The board reads a polygon's colour out of palette RAM at 0x1802000 +
     * colorbase * 2. Boot writes `off_820A0[0]` there, and every change of set
     * writes `off_820A0[set]` from colorbase 500 on (sub_1FA0, `lda 0x18023E8`),
     * so the first 500 entries are shared and the rest belong to the set. Each
     * table is a halfword count and then that many BGR555 colours.
     *
     * Straight after, sub_1A250 fills the top of the palette downward from 1023
     * out of the table at 0x7C004 — a hundred colours, down to 924, which is
     * exactly where the largest set's table stops — and then writes 1023 once
     * more from the test menu's blood colour: 0x801F for red, 0xB340 for green.
     * The EEPROM default is red. 1023 is the gore colour: the sprays, the flesh
     * chunks and the wound on every `_dam` body part name it. sub_1A380 cycles a
     * few entries under it every frame, starting from the same values.
     *
     * Neither routine clears what it does not write. Boot (sub_11FB0) puts set
     * 1's table at 500 as well as table 0 at 0, and each set after writes its
     * own length and no more, so the entries above a short table keep the last
     * longer one's colours. Each model bank names colours up to exactly the end
     * of its own set's table (bank 2 to 571, set 2's last; bank 3 to 923; bank 7
     * to 844) with one exception: the spiders and BO_tetuman in bank 4 name
     * 764-767, past set 4's end at 623, and get them from set 3, which Chapter 1
     * loads just before. `loadOrder` is the order the chapters' scripts load
     * sets in; a set outside it is laid over boot's set 1 alone.
     */
    palette: {
        source: 'maincpu', tables: 0x820a0, split: 500, sets: 11,
        top: 0x7c004, fixed: [[1023, 0x801f]],
        loadOrder: [1, 3, 4, 5, 6, 7],
    },
    /*
     * Every model has its artist's name, which is the difference between browsing
     * 10097 numbers and browsing `PN_hashi01_00a`.
     *
     * A debug table at 0xCD7990 points at names: 1384 texture file names first,
     * then one `PN_` name per model in table order, a null where the table has
     * an empty entry. The null runs line up with the table's empty entries one
     * for one, which is what pins the offset. The second half of the table reuses
     * the first half's names.
     */
    modelNames: { ptrs: 0x00cd7990, skip: 1384, count: 5049 },
    /*
     * Textures are not compressed at all: the data ROM holds texture RAM itself.
     *
     * At boot sub_D40 copies the megabyte at data 0 into sheet 0, and on every
     * change of set sub_EB0 copies the megabyte `off_82100[set]` names into
     * sheet 1. The first half of a bank is the sheet's full-size half; the second
     * half is dealt out in rectangles between the two sheets, the mip chain
     * alternating between them level by level. sub_489F0 then pastes up to eight
     * 64x64 blocks per set over the corner of sheet 0 from `0x93420[set * 32]`.
     * texture.js carries the rectangles.
     */
    texture: {
        raw: { bankTable: 0x82100, bootBank: 0x02000000, patchTable: 0x93420 },
        sets: 11,
        residentSet: null,
        /* Which set each bank of the model table is drawn under, read off the
         * stage data: every model a Chapter 1 courtyard section shows is in bank
         * 1 and drawn under set 1, the mansion's are bank 3 under set 3, and
         * Chapter 2's are banks 5, 6 and 7 under sets 5, 6 and 7. Bank 4's two
         * placed models, PN_room_6b and 6bb, are drawn by Chapter 1's last
         * section, which loads set 4; the bank's enemies (BO_syndy, BO_hyum,
         * BO_disiprin) come out whole under set 4 and in another set's patches
         * under set 3. The palettes say the same of every bank at once: a bank's
         * models name colours up to exactly the last entry its set's table
         * writes — bank 1 to 780, 2 to 571, 3 to 923, 4 to 622, 5 to 731, 6 to
         * 698, 7 to 844 — and past no other set's end but the four colours in
         * `palette.loadOrder`. Nothing places bank 2, but PN_pfuta_amun names
         * 571, set 2's last colour. BO_tom2 is in it all the same and wears Mr.
         * G's muscles under set 2: its texture points were made for sheets this
         * set does not hold. Bank 0 is the shared one and textures from sheet 0
         * alone, so its set decides only the colours from 500 up, which it does
         * not use. See bankTextureSet. */
        bankSets: [1, 1, 2, 3, 4, 5, 6, 7],
    },
    /*
     * The colour pipeline is AM1's own, and js/colors.js carries it as
     * buildCurveColorxlat: colorxlat is a curve computed at boot (sub_1180) with
     * a set's fourteen colour ramps laid over its odd rows (sub_1330), and luma
     * RAM is a straight copy (sub_1610).
     *
     * `solid` says the untextured faces go through colorxlat too, as MAME's
     * draw_scanline_solid has every board's do. Here it is not optional: nine
     * faces in ten are untextured, and their palette colours are row numbers —
     * 0x94A5 is row 5 in all three channels, which is the set's third ramp,
     * not a grey.
     */
    colors: {
        luma: { data: 0xc8eb40, bytes: 0x4000 },
        curve: { sets: { ptrs: 0x820d0, rows: 14, row0: 1, step: 2, gain: 0x7ffc0 } },
        solid: true,
    },
    /*
     * One light and one material table for the whole game, not one per stage.
     *
     * The camera update, sub_1FAE0, rebuilds the light every frame without
     * reading anything: sub_54EE0 loads the view matrix, zeroes its translation,
     * turns it by coprocessor function 0x15 with 0xC000 and 0x14 with 0xE000,
     * and transforms (0, 0, 1), and the first of three such vectors goes to GEO
     * command 0x0A. The coprocessor program is not Sonic The Fighters' cpres1,
     * but its translate and three rotations sit at the same place in the table
     * twelve on — 0x12, 0x14, 0x15, 0x16 against Fn_trans, Fn_x_rot, Fn_y_rot,
     * Fn_z_rot at 0x06, 0x08, 0x09, 0x0A — and the camera update itself uses
     * 0x15 for the heading and 0x14 for the pitch. So it is camera_init's
     * construction exactly: a Y turn of 0xC000 and an X turn of 0xE000, which is
     * 45 degrees up. Enemies may pick the second vector, (0x4000, 0xC000), which
     * is vertical.
     *
     * The boot sequence uploads the material table at 0x7A0 with GEO command 6,
     * slots 0-30, and sub_2350 later rescales that same table by a brightness
     * per enemy draw — 200 is common, 0 blacks it out, 255 leaves it. The
     * scenery is drawn against the table as uploaded. No mesh in the ROM names a
     * slot above 15. Nearly all of the rooms name slot 0 — diffuse 0, ambient
     * 255, unlit — because their light is painted into the textures; the lit
     * slots are the enemies' (2 and 11) and a third of the courtyard (12).
     *
     * And the normal in ROM is not what gets lit. Boot sets GEO mode 2 (the
     * `mov 2` after `st 0x707, 0x800070`), which is MAME's geo_parse_nn_ns:
     * skip the stored normal, take the plane of the polygon's first three
     * points. That plane agrees in sign with the stored normal on 99.2% of the
     * game's triangles and differs where the art smoothed a curve.
     */
    lighting: {
        vecter: [0xe000, 0xc000],
        materials: { at: 0x7a0, count: 31 },
        planeNormals: true,
    },
    /*
     * The stages are a placement table and zone lists in the program ROM, driven
     * by the stage script — nothing like a stage record. js/placements.js reads
     * them; the addresses are the tables the draw loop and the interpreter index
     * with the chapter number, which is `dword_51E4C0`. Only chapters 0 and 1
     * have scripts in this prototype: 2 and 3 set a zone and stop, and 4 is one
     * camera move.
     *
     * The geometry is in world space, which is what `flat` says to the rest of
     * the viewer. What shows behind it is the scroll layer, which is not read, so
     * the backdrop is palette black.
     *
     * `turns` is the one exception the draw loop at 0x3DB10 makes to drawing a
     * placement where it stands: after the translate it compares the zone's
     * placement index with 55 (`addo 0x1F, 0x18`) and, on a match, turns the
     * matrix by coprocessor function 0x15, the Y rotation, a quarter turn. 55 is
     * the rain in the mansion corridor's windows, PN_room5a_CT00a, modelled as a
     * plane across X for a corridor that runs along Z. The test does not look at
     * the chapter; Chapter 2's table stops at 27.
     */
    stageTable: {
        placements: {
            chapters: 2,
            maps: 0x92db0, zones: 0x92d90, scripts: 0xe0000, sectionSets: 0x83360,
            /* off_83290[chapter]: 16 bytes a section, what follows it — 0 goes
             * to the section at +4, 1 picks +4 or +8 by the byte at 0x51EFE4,
             * 2 goes on to the next section or ends the chapter (sub_51490). */
            branches: 0x83290,
            turns: { 55: 0x4000 },
            bounds: 0xcdde20,
        },
        flat: true,
        backdrop: 0x8000,
    },
    /*
     * The sky is geometry here, not the board's scroll layer.
     *
     * The scroll layer exists — `_ScrollTable` at 0x7EFC0 holds a tile set, a
     * palette and a tilemap per entry, and sub_13120/sub_13220 upload them —
     * but every caller is the attract mode, the test menu or the HUD, and no
     * stage script opcode touches any of it. What is behind the arena is two
     * shells drawn by the task `_TaskOpen(loc_2A920, 0x58)` registers:
     *
     *   - `models[index]`, a dome 1800 across and 1100 tall (PN_skyuv for the
     *     first chapter, three PN_r2skyuv* for the second), turned about Y by a
     *     counter the task advances `spin` units of 65536 a frame;
     *   - `band`, PN_skyuv02a, a cut-out ring 1673 across and 132 tall that
     *     every sky draws over its dome, and that does not turn.
     *
     * Both are lowered by the float at `heights[index]`, and both are drawn
     * only while the byte at 0x51F306 is non-zero. Two script opcodes set the
     * pair: 70 the index, 71 the enable, whose value 1 drifts and 2 holds the
     * dome still (the task skips the counter on 2). js/placements.js reads them
     * along the scripts, the same walk the zones and the texture sets come out
     * of, so a stage carries the sky the chapter turns on while its set is
     * loaded — the courtyard's, and none for the mansion, which is indoors.
     *
     * The moons (PN_moon, PN_moonb, PN_moonc) are not part of this. They are
     * flat quads an object handler billboards at the camera, spawned from the
     * script's own object lists, which are not read.
     */
    sky: { models: 0x840e0, heights: 0x840f0, count: 4, band: 1462, spin: 4 },
    /*
     * The props the scripts spawn, in the same 76-byte table the finished game
     * keeps them in — a sound at 0 and the model at 8. Found by its own shape
     * and then held against the other build: 73 of the 77 types both tables
     * carry name the same model, type for type, PN_test_tubo01a through
     * PN_tokei, PN_book_tana, PN_sika_atama01a and PN_moon at 59.
     *
     * It stops at 78 where the finished game's runs to 122, which is the
     * prototype being the smaller game.
     */
    objects: {
        table: 0x84140, stride: 76, model: 0, count: 125, handlers: 0x86990,
        prop: 0x30670, type: 0x24, classes: 0x86c10, generic: 0x2ecc0,
        scale: 0x28,
        /*
         * What takes a prop down again, read in sub_33320, which the prop's
         * handler calls before it draws (see propZones in js/placements.js).
         * Each spawn opcode copies a halfword of its record to obj+0x6C, at
         * `life`: how many times the script index (0x520089) may change
         * before the object closes itself. Opcodes 10 and 12 also copy the
         * byte at `window` to obj+0x64, a row of `windows` (16 bytes a row,
         * camera frames ending in 0xFFFF) at whose frames the object is hidden
         * or shown again, and which closes it when it ends hidden. `sweep` is
         * the one case the routine hard-codes: in the first chapter, section 7,
         * script 2, every object but type 7 closes once the camera is past
         * frame 170.
         */
        spawns: {
            9: { life: 0x20 }, 10: { life: 0x22, window: 0x25 },
            11: { life: 0x04 }, 12: { life: 0x22, window: 0x25 },
        },
        windows: 0x85940,
        sweep: { chapter: 0, section: 7, script: 2, after: 170, spare: 7 },
    },
    /*
     * `layers`: the rooms and grounds are large faces with smaller ones laid on
     * them in the same plane, and a depth buffer cannot tell which of two equal
     * depths to keep — js/layers.js ranks them the way the board's polygon sort
     * does.
     *
     * With that done there is nothing left for the recede to do, and what it
     * does do is wrong here. Almost every polygon in this game sorts by its far
     * corner, and the recede only lets a face step back when it is shallow — so
     * a short stretch of the mansion corridor's wall steps back twelve units,
     * behind the rain 2 units outside it, while the rain, 200 units long, keeps
     * its depth and shows through the wall between the windows. The board gives
     * that pixel to the wall, whose far corner is nearer.
     */
    depth: { recede: 0, nearMin: 0.02, layers: true },
    scenes: null,
    /*
     * The enemies are jointed bodies played by baked motions — see js/bodies.js.
     * Both name tables are pointer tables in the program ROM, and each ends
     * where the next begins: 68 bodies, then 508 motions. The scale table is in
     * the data ROM, one float per body.
     */
    rig: {
        /* `roles` is eight bytes per joint, 31 joints per body, with the role
         * sub_764C0 switches on in byte 3; `skins` is a halfword per body naming
         * its skin, or -1. */
        bodies: {
            names: 0x96020, count: 68, joints: 0x94f30, trees: 0x94e20, scales: 0xdc0050,
            roles: 0xdc0380, skins: 0xd80000, hitMotions: 0xde5150, starts: 0x22f70,
        },
        /* `flatAnkles` is a byte per motion: set, the ankles are turned from the
         * body's own frame instead of the shin's (sub_2BA50). */
        motions: { names: 0x96130, count: 508, data: 0x95040, frames: 0x95830, flatAnkles: 0x5e880 },
        /* The motions each body's routines play, by body: every motion number
         * that reaches a setter (sub_2DFD0, sub_2E570, sub_2D870...) in the
         * code its routine runs, and what the body-indexed tables at 0x94940,
         * 0x94C00, 0x94D10 and 0x59FA0 hold. Written by
         * tools/hotd-motions/body_motions.py, which says how; it lists motions
         * of any joint count, and bodyMotionList keeps the body's. */
        bodyMotions: [
            /* 0 BO_dkiller_kihon */
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 19, 20, 21, 35, 36, 37, 38, 39, 40, 41, 42,
             43, 45, 47, 48, 108, 109, 111, 115, 117, 129, 130, 131, 139, 172, 208, 210, 211, 212, 213,
             214, 218, 262, 264, 266, 267, 268, 269, 371],
            /* 1 BO_mon_kihon */
            [53, 55, 57, 62, 63, 65, 66, 68, 271, 277, 278, 281, 284, 285, 286, 292, 293, 295, 296, 298,
             301, 302, 307, 313, 314, 316, 371],
            /* 2 BO_tom */
            [108, 109, 111, 115, 117, 331],
            /* 3 BO_ebita */
            [176, 344, 346, 355, 368, 371, 374, 376, 378, 379, 382, 385, 398, 428, 429, 431, 432, 433, 437,
             438, 439, 453, 477, 478, 489, 490, 491, 494, 495],
            /* 4 BO_ebitb */
            [73, 74, 75, 76, 77, 78, 80, 81, 82, 85, 86, 88, 93, 94, 97, 98],
            /* 5 BO_mr_g */
            [226],
            /* 6 BO_handrb */
            [126],
            /* 7 BO_molb */
            [208, 209, 210, 211, 212, 213, 214, 218, 371],
            /* 8 BO_frog_ct */
            [108, 109, 111, 115, 117],
            /* 9 BO_mon_boss */
            [278],
            /* 10 BO_dkiller_black */
            [35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 48, 129, 130, 131],
            /* 11 BO_mon_black */
            [53, 55, 57, 62, 63, 65, 66, 68, 271, 277, 278, 281, 284, 285, 286, 292, 293, 295, 296, 298,
             301, 302, 307, 313, 314, 316, 371],
            /* 12 BO_tom2 */
            [329],
            /* 13 BO_syndy */
            [118, 125, 232, 244, 248, 250, 320, 331],
            /* 14 BO_gman */
            [329],
            /* 15 BO_zom */
            [176, 229, 330, 334, 344, 346, 348, 349, 351, 355, 356, 361, 368, 369, 371, 374, 376, 378, 379,
             385, 393, 394, 397, 398, 410, 411, 428, 429, 431, 432, 433, 468, 477, 478, 487, 489, 490, 491,
             494, 495, 504],
            /* 16 BO_debu */
            [344, 346, 349, 350, 368, 371, 373, 374, 376, 378, 379, 401, 402, 405, 408, 416, 428, 429, 431,
             432, 433],
            /* 17 BO_gman_kihon */
            [329],
            /* 18 BO_haride */
            [337],
            /* 19 BO_staje */
            [332],
            /* 20 BO_zonbiman */
            [176, 344, 346, 355, 368, 371, 374, 376, 378, 379, 397, 398, 410, 411, 416, 428, 429, 431, 432,
             433, 468, 473, 474, 475, 476, 477, 489, 490, 491, 494, 495],
            /* 21 BO_kenkyu */
            [119, 135, 137, 138, 139, 140, 141, 147, 148, 152, 155, 156, 165, 166, 172, 180, 181, 185, 186,
             190, 194, 197, 204, 253, 329],
            /* 22 BO_semu */
            [53, 55, 57, 62, 63, 65, 66, 68, 271, 277, 278, 281, 284, 285, 286, 292, 293, 295, 296, 298,
             301, 302, 307, 313, 314, 316, 371],
            /* 23 BO_kenkyu_c */
            [119, 135, 137, 138, 139, 140, 141, 147, 148, 152, 155, 156, 165, 166, 172, 180, 181, 185, 186,
             190, 194, 197, 204, 329],
            /* 24 BO_kenkyu_h */
            [119, 135, 137, 138, 139, 140, 141, 147, 148, 152, 155, 156, 165, 166, 172, 180, 181, 185, 186,
             190, 194, 197, 204, 329],
            /* 25 BO_kenkyu_m */
            [119, 134, 135, 137, 138, 139, 140, 141, 144, 147, 148, 151, 152, 155, 156, 165, 166, 168, 172,
             174, 178, 179, 180, 181, 185, 186, 190, 191, 194, 197, 204, 329],
            /* 26 BO_kenkyu_s */
            [329],
            /* 27 BO_lady_o */
            [119, 135, 137, 138, 139, 140, 141, 147, 148, 152, 155, 156, 165, 166, 172, 180, 181, 185, 186,
             190, 194, 197, 204, 329],
            /* 28 BO_mummy */
            [176, 344, 346, 349, 350, 351, 355, 357, 368, 371, 374, 376, 378, 379, 385, 398, 428, 429, 431,
             432, 433, 477, 489, 490, 491, 494, 495],
            /* 29 BO_lady_l */
            [119, 134, 135, 137, 138, 139, 140, 141, 144, 147, 148, 151, 152, 155, 156, 165, 166, 168, 172,
             174, 178, 179, 180, 181, 185, 186, 190, 191, 194, 197, 204, 329],
            /* 30 BO_lady_m */
            [134, 138, 141, 144, 151, 156, 168, 172, 174, 178, 179, 186, 190, 191, 204, 329],
            /* 31 BO_lady_n */
            [119, 135, 137, 138, 139, 140, 141, 147, 148, 152, 155, 156, 165, 166, 172, 180, 181, 185, 186,
             190, 194, 197, 204, 329],
            /* 32 BO_neil */
            [176, 344, 346, 349, 350, 351, 355, 357, 368, 371, 374, 376, 378, 379, 385, 397, 398, 410, 411,
             428, 429, 431, 432, 433, 468, 477, 489, 490, 491, 494, 495],
            /* 33 BO_siriru */
            [176, 229, 230, 344, 346, 348, 349, 351, 355, 360, 361, 368, 369, 371, 374, 376, 378, 379, 385,
             397, 398, 410, 411, 428, 429, 431, 432, 433, 461, 464, 465, 468, 469, 470, 489, 490, 491, 494,
             495],
            /* 34 BO_tarab */
            [321],
            /* 35 BO_samson */
            [176, 229, 231, 344, 346, 348, 349, 350, 355, 357, 371, 372, 379, 380, 383, 385, 397, 410, 411,
             417, 420, 421, 422, 424, 428, 429, 431, 432, 433, 446, 448, 449, 450, 451, 468, 489, 490, 491,
             494, 495],
            /* 36 BO_haris */
            [344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 397, 398, 428, 477],
            /* 37 BO_gilmoa */
            [176, 344, 346, 355, 368, 371, 374, 376, 378, 379, 385, 398, 428, 429, 431, 432, 433, 440, 441,
             442, 443, 444, 445, 473, 474, 475, 476, 477, 489, 490, 491, 494, 495],
            /* 38 BO_bentry */
            [176, 344, 346, 349, 350, 368, 371, 373, 374, 376, 378, 379, 397, 401, 402, 405, 408, 416, 428,
             429, 431, 432, 433, 489, 490, 491, 494, 495],
            /* 39 BO_sophi */
            [139, 172, 262, 264, 266, 267, 268, 269, 329],
            /* 40 BO_hyum */
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 19, 20, 21, 40, 349, 350, 351, 355, 357, 371,
             373, 385, 398, 477],
            /* 41 BO_harid2 */
            [337, 371],
            /* 42 BO_staj2 */
            [337],
            /* 43 BO_kenkenkyu */
            [329],
            /* 44 BO_hyumhada */
            [355, 371, 398, 477],
            /* 45 BO_mickyb */
            [205],
            /* 46 BO_dreik */
            [53, 55, 57, 62, 63, 65, 66, 68, 271, 277, 278, 281, 284, 285, 286, 292, 293, 295, 296, 298,
             301, 302, 307, 313, 314, 316, 371],
            /* 47 BO_kage */
            [53, 55, 57, 62, 63, 65, 66, 68, 271, 277, 278, 281, 284, 285, 286, 292, 293, 295, 296, 298,
             301, 302, 307, 313, 314, 316, 371],
            /* 48 BO_lubin */
            [278],
            /* 49 BO_dkillerb */
            [35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 48, 129, 130, 131],
            /* 50 BO_neopetit */
            [176, 344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429,
             431, 432, 433, 477, 489, 490, 491, 492, 493, 494, 495],
            /* 51 BO_neopetit2 */
            [176, 344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429,
             431, 432, 433, 477, 489, 490, 491, 492, 493, 494, 495],
            /* 52 BO_neopetit3 */
            [176, 344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429,
             431, 432, 433, 477, 489, 490, 491, 492, 493, 494, 495],
            /* 53 BO_pkenb */
            [344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429, 431,
             432, 433, 477, 490, 492, 493, 494],
            /* 54 BO_bentryb */
            [176, 344, 346, 349, 350, 368, 371, 373, 374, 376, 378, 379, 397, 401, 402, 405, 408, 416, 428,
             429, 431, 432, 433, 489, 490, 491, 494, 495],
            /* 55 BO_pdolob */
            [176, 344, 346, 355, 368, 371, 374, 376, 378, 379, 385, 398, 428, 429, 431, 432, 433, 477, 478,
             489, 490, 491, 494, 495],
            /* 56 BO_harisb */
            [344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 477],
            /* 57 BO_taraba_b */
            [322],
            /* 58 BO_kenkyu_j */
            [329],
            /* 59 BO_devilon */
            [22, 26, 27, 29, 32, 329],
            /* 60 BO_bentryc */
            [176, 344, 346, 349, 350, 368, 371, 373, 374, 376, 378, 379, 397, 401, 402, 405, 408, 416, 428,
             429, 431, 432, 433, 489, 490, 491, 494, 495],
            /* 61 BO_disiprin */
            [344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429, 431,
             432, 433, 477],
            /* 62 BO_tetuman */
            [344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429, 431,
             432, 433, 477],
            /* 63 BO_zonbi_b_2 */
            [344, 346, 349, 350, 351, 355, 357, 368, 371, 373, 374, 376, 378, 379, 385, 398, 428, 429, 431,
             432, 433, 477],
            /* 64 BO_devilonm */
            [22, 26, 27, 29, 32, 371],
            /* 65 BO_neozom */
            [344, 346, 355, 368, 371, 374, 376, 378, 379, 385, 428, 429, 431, 432, 433, 477, 478, 491],
            /* 66 BO_mummy2 */
            [176, 344, 346, 349, 350, 351, 355, 357, 368, 371, 374, 376, 378, 379, 385, 398, 428, 429, 431,
             432, 433, 477, 489, 490, 491, 494, 495],
            /* 67 BO_gilmoab */
            [176, 344, 346, 355, 368, 371, 374, 376, 378, 379, 385, 398, 428, 429, 431, 432, 433, 440, 441,
             442, 443, 444, 445, 473, 474, 475, 476, 477, 489, 490, 491, 494, 495],
        ],
        /* The polygons joining chest to hips (sub_4DEF0, sub_4DF90), all in the
         * data ROM and indexed by skin: a template of 0x640 bytes, its texture
         * point and header pointers, its polygon count, twelve points in the
         * chest's space, and which of the template's points each one fills. */
        skins: {
            templates: 0xd80160, templateBytes: 0x640, pointers: 0xd80090, counts: 0xd8c120,
            points: 0xd8a3e0, order: 0xd8bc40, slots: 0xd8b280, shared: 0xd8c190,
        },
        /*
         * The bodies sub_764C0 draws something other than the part's own model
         * for, and what it names doing it. Every number is an index into the
         * body, motion or model table, and all three renumber between builds,
         * so they live here rather than in js/bodies.js.
         */
        callback: {
            bodies: {
                tom: 2, hand: 6, gman: 14, gmanKihon: 17, haride: 18, staje: 19,
                spider: 34, samson: 35, sophie: 39, devilon: 59, devilonM: 64,
            },
            motions: {
                gmanDash: 118, soten: 124, handra: 126, pDash: 232, kousya: 244,
                sButt: 262, sSinderu: 267, sTatiaga: 268, sUneune: 269,
                tombaan: 332, tombanban: 333, tompaan: 337,
            },
            models: {
                magazine: 1728, gunHand: 1734, kousyaHand: 795, sotenHand: 2445,
                coat: 162, fingersA: 2452, fingersB: 2493, spiderLegs: 4157,
                samsonHand: 1300, sophieHead: 1467, sophieBlink: 1468,
                sophieRun: 1469, devilonWing: 4814, devilonMWing: 1886,
            },
        },
    },
    features: { stages: true, characters: false, motions: true, bodies: true },
};

/* ---- The House of the Dead ----------------------------------------------- */

/*
 * The `hotdo` set: the finished game the prototype above became, in the
 * revision that shipped first. Revision A is the profile after this one, and
 * takes everything here but the addresses its patched program moved.
 *
 * It is the same program grown up — AM1's library, the board's geometry, the
 * raw texture banks and the curve colour pipeline all carry across — but not
 * one address does. The two program ROMs diverge 196 bytes in and share 5.5% of
 * their 4KB blocks, so every table here was found again rather than adjusted,
 * each by a signature the prototype's own tables supplied. What did carry over
 * verbatim is noted where it happens.
 *
 * Four things changed shape:
 *
 *   - the program ROM is two pairs, not one, and 2MB rather than 1;
 *   - the polygon ROM is four pairs where the prototype had three, and every
 *     band of it is addressed: the fourth's 623 meshes all open on a unit
 *     normal, which is what says the pairing is right;
 *   - the data ROM ends in a 1MB EPROM pair MAME mirrors to 0x2000000, and the
 *     XTRA_DATA window is the whole top 16MB rather than 8;
 *   - there are thirteen texture sets and thirteen model banks, against eleven
 *     and eight, and here they correspond one for one.
 *
 * This is MAME's `hotdo`. Its identity is both halves of its own program pair,
 * which is what separates it from Revision A, plus a chip from each of the two
 * regions whose layout changed, so a prototype zip renamed to these labels does
 * not pass.
 */
const hotdo = {
    id: 'hotdo',
    name: 'The House of the Dead',
    identify: ['epr-19696.15', 'epr-19697.16', 'mpr-19715.17', 'mpr-19718.27'],
    regions: {
        /* Two pairs. The second holds no table the viewer reads, but the region
         * is addressed whole and the program's own pointers reach into it. */
        maincpu: {
            size: 0x200000,
            parts: [
                [0x000000, 'epr-19696.15', 0x03da5623, 'epr-19697.16', 0xa9722d87],
                [0x100000, 'epr-19694.13', 0xe85ca1a3, 'epr-19695.14', 0xcd52b461],
            ],
        },
        /*
         * Three 8MB mask pairs and then a 1MB EPROM pair, which MAME repeats
         * every megabyte up to 0x2000000 (the ROM_COPY run in `hotd`). The
         * repeats are listed rather than copied because the XTRA_DATA window
         * maps the top 16MB straight through and the program's pointers land in
         * every megabyte of it — 0x06C330D0, the one beside the colour gain, is
         * in the thirteenth.
         *
         * The model table, the name tables and the luma curve are in the second
         * pair; the raw texture banks fill the first 13MB.
         */
        mainData: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19704.11', 0xaa80dbb0, 'mpr-19705.12', 0xf906843b],
                [0x0800000, 'mpr-19702.9', 0xfc8aa3b7, 'mpr-19703.10', 0x208d993d],
                [0x1000000, 'mpr-19700.7', 0x0558cfd3, 'mpr-19701.8', 0x224a8929],
                /* The 1MB EPROM pair, once per megabyte to the end. */
                ...Array.from({ length: 8 }, (_, i) =>
                    [0x1800000 + i * 0x100000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9]),
            ],
        },
        polygons: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19715.17', 0x3ff7dda7, 'mpr-19711.21', 0x080d13f1],
                [0x0800000, 'mpr-19714.18', 0x3e55ab49, 'mpr-19710.22', 0x80df1036],
                [0x1000000, 'mpr-19713.19', 0x4d092cd3, 'mpr-19709.23', 0xd08937bf],
                [0x1800000, 'mpr-19712.20', 0x41577943, 'mpr-19708.24', 0x5cb790f2],
            ],
        },
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19718.27', 0xa9de5924, 'mpr-19716.25', 0x45c7dcce],
                [0x800000, 'mpr-19719.28', 0x838f8343, 'mpr-19717.26', 0x393e440b],
            ],
        },
    },
    /* The whole top half of the data region, not the 8MB the prototype mapped:
     * the program's XTRA_DATA pointers spread across all sixteen megabytes of
     * the window, where the prototype's stop at the eighth. The upper half of
     * what they reach is the mirrored EPROM pair. */
    xtra: { window: 0x1000000, banks: [{ region: 'mainData', base: 0x1000000 }] },
    /*
     * One copy of 7477 entries, where the prototype carried two — the second
     * being the same meshes wearing a second set of texture records. Nothing
     * here repeats: the table ends at 7476 and the string pool starts in the
     * next entry.
     *
     * Found by the holes. The debug name table below has a null wherever the
     * model table has an empty entry, and only one 16-byte-strided base in the
     * data ROM is zero at all twelve of this game's null indices and non-zero
     * on either side of each. 99.54% of its meshes open on a unit normal, and
     * every normal that is not unit is exactly zero rather than noise — the
     * same shape the prototype's table has, one band deeper.
     */
    modelTable: { offset: 0x00e73530, count: 7477, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: null,
    /*
     * The same two-part palette the prototype has: a shared table below `split`
     * written once, the loaded set's table from `split` on, and a table filled
     * downward from 1023 for the gore.
     *
     * The set tables are packed end to end and the top table follows the last
     * of them — 0xA34A2 + 2 + 138*2 is 0xA35B8 — exactly as they are in the
     * prototype, which is how both were found: every one of them opens on the
     * same four colours (0x8000, 0xFC00, 0x83E0, 0xFFE0), and the top table's
     * first hundred are the prototype's byte for byte.
     *
     * `split` is 500 again, and the models say so without the instruction being
     * read. Nine of the thirteen banks name a colour exactly at the end of
     * 500 + their set's count, none names one past its own set's end, and not
     * one face in the game names anything between the shared table's last
     * entry at 212 and 500.
     *
     * `loadOrder` is the order the chapters first load each set, read off the
     * sections themselves: each section's own set as it starts and every set a
     * script loads part way through, in the order the walk meets them. The same
     * reading of the prototype gives [1, 3, 4, 5, 6, 7], which is what its
     * profile carries, so the method is the one that wrote that line.
     *
     * No model bank needs it — each names colours only up to its own set's end.
     * The props do: a set writes as many entries from `split` as its table
     * holds and clears nothing above them, so a lamp that names 832 under set 6,
     * whose table stops at 698, is wearing what set 3 left there, 3 being loaded
     * two chapters earlier and reaching 933. Because every set's own table is
     * written last and over the top, this can only fill in entries above a set's
     * end and cannot move a colour any scenery uses.
     *
     * Set 2 is not in the order because no chapter loads it, which is the same
     * thing the prototype's notes say of its own bank 2.
     */
    palette: {
        source: 'maincpu', tables: 0xa98f0, split: 500, sets: 13,
        top: 0xa35b8, fixed: [[1023, 0x801f]],
        loadOrder: [1, 3, 4, 5, 6, 7, 8, 10, 9, 11, 12],
    },
    /*
     * The debug name table, in the same shape and at the same offset into
     * itself: 1384 texture file names, then one `PN_` name per model, a null
     * where the table has an empty entry. Its pointers are data addresses, and
     * the run of them beginning "GG07.dgt" is unique in the region.
     */
    modelNames: { ptrs: 0x00ee3910, skip: 1384, count: 7477 },
    /*
     * Raw texture banks, as in the prototype: thirteen megabytes of the data
     * ROM are texture RAM itself, one per set, and js/texture.js deals the
     * second half of each out between the two sheets. The three tables sit
     * where the prototype's do relative to each other — the set palettes'
     * pointers, then the colour curves', then these — and the patch table's
     * first set is all zeros with the second's eight blocks behind it, which is
     * the shape that pins its base.
     */
    texture: {
        raw: { bankTable: 0xa9970, bootBank: 0x02000000, patchTable: 0xc15e0 },
        sets: 13,
        residentSet: null,
        /*
         * Bank k under set k, for all thirteen — which the prototype's tables
         * did not do, and which is read here off the colours rather than off
         * stage data that has not been located yet.
         *
         * A bank's models name colours up to exactly the last entry its set's
         * table writes: bank 1 to 780 against set 1's 780, bank 2 to 683, 4 to
         * 668, 6 to 698, 7 to 863, 8 to 839, 9 to 765, 10 to 659, 11 to 615,
         * and banks 3, 5 and 12 stop a few short of theirs. No bank reaches
         * past its own set's end, and no other set's end fits.
         *
         * Bank 0 is the shared one — the enemies every chapter draws — and it
         * is the exception, as it is in the prototype. It names no colour above
         * 212, the shared table's own last entry, and one of its 98985 textured
         * faces sits on sheet 1 where every other bank's do, so neither the
         * palette nor the sheets pick a set for it.
         *
         * The colour ramps do. Set 0 is not a set the game ever loads: its slot
         * in the ramp array is a zero placeholder, and sub_1330 dereferences
         * what it is handed without checking. What boot installs instead is
         * `lda off_A95F0, g0 / call sub_1330` — the table at slot 1 — so the
         * ramps a shared body is drawn under, before any chapter has loaded a
         * set of its own, are set 1's. Drawing bank 0 under set 0 leaves the
         * bare grey curve, which is what blacked out BO_samson's head and arms.
         */
        bankSets: [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    },
    /*
     * AM1's curve pipeline again: a curve computed at boot with a set's
     * fourteen ramps laid over its odd rows, and luma RAM copied straight out
     * of the data ROM.
     *
     * The luma table is 0x4000 bytes of nothing above 63, and its first
     * thirty-two bytes match the prototype's exactly — one hit in 32MB. The
     * gain is still 1.1, and still followed by 1.0 with the same run of
     * 0x80008000 behind it; that pair occurs once in the program ROM.
     *
     * The pointer array opens on a zero: set 0, the boot set, has no ramps and
     * keeps the bare curve, and sets 1 to 12 have one each. That leading zero
     * is part of the table, not padding in front of it — sub_1330 is handed
     * `ld unk_A9930[r4*4]` with the same set number that indexes the bank
     * table at 0xA9970 and the palette tables at 0xA98F0 two instructions
     * earlier. Starting the array after the zero instead gives every set the
     * next one's ramps and set 12 none at all, which is the bare grey curve.
     */
    colors: {
        luma: { data: 0xe9aac0, bytes: 0x4000 },
        curve: { sets: { ptrs: 0xa9930, rows: 14, row0: 1, step: 2, gain: 0xa8308 } },
        solid: true,
    },
    /*
     * The material table is the prototype's, at the prototype's address: all
     * 31 slots byte for byte at 0x7A0, in a program ROM that is otherwise 94%
     * different. It was not edited and it did not move.
     *
     * `vecter` and `planeNormals` are carried across on the strength of that
     * — the light the camera update builds, and GEO mode 2 taking the plane of
     * the first three points over the stored normal — and are the two numbers
     * here that this set's own code has not been read for.
     */
    lighting: {
        vecter: [0xe000, 0xc000],
        materials: { at: 0x7a0, count: 31 },
        planeNormals: true,
    },
    /*
     * The stages, in the prototype's three tables and found by their shapes.
     *
     * A placement is 24 bytes — a model, three world floats, a cycle list and a
     * far model — and a table of them ends on a zero model, so a run of records
     * whose model is in range, whose floats are sane and whose far word is zero
     * is a placement table and nothing else is. Four such runs are in this
     * program ROM, against the prototype's two, and the models they open on say
     * which chapter each belongs to: 2333 in bank 1, then PN_room2_00a,
     * PN_room3_00a and one more. A zone list is 50 bytes of placement indices
     * ending in 0xFF with zeros behind it, which is as distinctive, and there
     * are four of those too.
     *
     * `maps` and `zones` are then the arrays that name them, and they sit 0x20
     * apart exactly as the prototype's do. Both carry seven entries and a zero:
     * chapters 0-3 have tables of their own and 4-6 reuse them.
     *
     * `scripts` did not move at all — still 0xE0000, still a header of chapter
     * pointers, a -1 and a 0x5C, with chapter 0's section array behind it. Only
     * the header is longer, seven chapters against five.
     *
     * `sectionSets` is the one array of four pointers to arrays of nothing but
     * set numbers, and it reads as the game plays: chapter 0 is
     * 1,1,1,1,1,3,3,3,3,1,1,1 — the courtyard, then the mansion, then out —
     * which is the prototype's chapter 0 section for section.
     *
     * The sky is not carried: which shell a chapter shows is a script opcode's
     * argument against a table of models and heights, and that table has not
     * been found here.
     */
    stageTable: {
        placements: {
            chapters: 4,
            maps: 0xc0bc0, zones: 0xc0ba0, scripts: 0xe0000, sectionSets: 0xab0a0,
            /* The cycle list is in the record's second tail word here, not its
             * first. One placement in the game has one, and it is the same
             * placement as the prototype's — index 55, PN_room5a_CT00a, the
             * rain in the mansion corridor's windows, cycling PN_room5a_CT01
             * through CT32. Which is also why `turns` is carried across: the
             * draw loop's quarter turn is a compare against placement 55, and
             * 55 is still that plane, still modelled across X for a corridor
             * that runs along Z. */
            cycle: 0x14,
            turns: { 55: 0x4000 },
            /*
             * The sphere cull's box per model, which `resolveAlternates` needs
             * to tell versions of one piece from rooms that merely share an
             * origin. It follows the name table, as the prototype's does, and
             * the base is not guessed: only one puts a null at each of the five
             * dummy models and at each of the model table's twelve holes, and
             * nowhere else.
             */
            bounds: 0xeec390,
        },
        flat: true,
        backdrop: 0x8000,
    },
    /*
     * The sky, which is geometry here as it is in the prototype — a dome a
     * script opcode picks and turns, and PN_skyuv02a, the cut-out band, drawn
     * over whichever dome it is.
     *
     * Eight models have `sky` in their name; six of them are domes, and the one
     * array in the program ROM that names any of them names all six, sixteen
     * bytes apart, each followed by its height and its drift rate. Where the
     * prototype keeps model and height in two arrays and the rate as a constant
     * in the code, this build folds the three into a record — so `stride` and
     * `spins`. The heights agree with the prototype's model for model:
     * PN_r2skyuvb hangs at -200 in both and every other dome at -9.
     */
    sky: { models: 0xac1e0, heights: 0xac1e4, spins: 0xac1e8, stride: 16, count: 6, band: 1544 },
    /*
     * The props a room is furnished with — the barrels and crates that break,
     * the bookcases, the tables and what is laid on them — are not placements.
     * They are objects the stage scripts spawn, and the four spawn opcodes the
     * script walk used to step over carry a -1-terminated list of pointers to a
     * record of {type, flags, x, y, z}.
     *
     * The type indexes this table, and sub_417F0, which builds an object, says
     * where it is and what is in it exactly:
     *
     *     ldis 0xCC(g0), g4      ; the type
     *     mulo g4, 0x4C, g4      ; 76 bytes an entry
     *     lda  unk_AC2D0(g4), g4 ; the table
     *     ld   (g4), g5          ; the model is the first word
     *     st   g5, 0x54(g0)      ; and becomes the object's current model
     *
     * So the model is at 0 and the sound the handlers play is at 68 — which is
     * what `unk_AC314` is in `ld unk_AC314(g4)`, the same table reached at its
     * sound field rather than its head. Read from the head its entries are what
     * a house is full of: PN_isu chairs, PN_tabul tables, PN_tokei a clock,
     * PN_sitai a corpse, PN_sara plates, PN_book_tana a bookcase, PN_tantansu a
     * chest, PN_kibako a crate, PN_tarun_dam a breaking barrel.
     *
     * Type 0 names PN_space and its slot in the handler table is a null
     * pointer, so it is nothing at all and is skipped.
     *
     * The spawns whose type is 128 or more are not objects in this space — see
     * the note on +0xCC in TECHNICAL.md — and are left alone rather than looked
     * up here.
     */
    objects: {
        table: 0xac2d0, stride: 76, model: 0, count: 125, handlers: 0xaf950,
        prop: 0x3a210, type: 0x24, classes: 0xafdd0, generic: 0x389e0,
        scale: 0x28,
    },
    /* Its rooms are built the same way the prototype's are, large faces with
     * smaller ones laid on them in the same plane, so they want the same
     * ranking and the same absent recede. */
    depth: { recede: 0, nearMin: 0.02, layers: true },
    scenes: null,
    /*
     * The rig: 94 jointed bodies playing 674 baked motions, against the
     * prototype's 68 and 508.
     *
     * The program ROM keeps all six index tables in one run, each followed by
     * two words of padding, and the run is found from either end: the body
     * names are the only long array of pointers to `BO_` strings, the motion
     * names the only one to `MO_` strings, and the motion data the only long
     * increasing run of XTRA_DATA addresses. Every boundary then falls out at
     * 94 or 674 entries plus eight bytes —
     *
     *   trees 0xC7230, joints 0xC73B0, data 0xC7530, frames 0xC7FC0,
     *   body names 0xC8A50, motion names 0xC8BD0
     *
     * — and the frame counts it lands on open 156, 66, 31, 61, 89, 116, which
     * is the prototype's opening frame for frame.
     *
     * `flatAnkles` is `ldob unk_7C6E0(g4)` on the motion number, 674 bytes of
     * 0 and 1 and a zero behind them, opening on the same run of 22 the
     * prototype's does.
     *
     * The data-ROM tables were read against the prototype over the 59 bodies
     * that share a name and a joint count between the builds: `roles` is the
     * one base where 55 of them match role for role (the next scores 20), and
     * `scales` the one where 58 match value for value (next 45). `hitMotions`
     * was the only per-body pointer array in 32MB whose targets are all valid
     * motion numbers, and it reads as the prototype's does — the dogs get
     * MO_ddoggdam, the zombies MO_z_a_*hit, the monkeys MO_saru*dam.
     */
    rig: {
        bodies: {
            names: 0xc8a50, count: 94, joints: 0xc73b0, trees: 0xc7230,
            scales: 0xfc0060, roles: 0xfc04b0, hitMotions: 0xff264c,
            /* This one is in the program ROM here, not the data ROM. There is
             * a stale copy of it at data 0xF80000, left over beside the skin
             * block the prototype kept it in; the two agree for the first
             * forty bodies and then do not, and the copy the code reads is
             * this one. */
            skins: 0x63c60, skinsSource: 'maincpu',
        },
        motions: { names: 0xc8bd0, count: 674, data: 0xc7530, frames: 0xc7fc0, flatAnkles: 0x7c6e0 },
        /*
         * 28 skins, every stride read straight off the routine at 0x64020:
         * `ld 0x2F8D220[g1*4]` is the count, `g1 * 0x640` from 0x2F803A0 the
         * template, `g1 * 144` from 0x2F8B2A0 the points, `g1 * 96` from
         * 0x2F8C260 the slots, `g1 * 48` from 0x2F8CCE0 the order, and
         * 0x2F8D290/4 on an 8-byte stride the shared pair. Each table ends
         * exactly where the next begins at 28 entries, which is also the
         * highest index the skin table names.
         */
        skins: {
            templates: 0xf803a0, templateBytes: 0x640, counts: 0xf8d220,
            points: 0xf8b2a0, order: 0xf8cce0, slots: 0xf8c260, shared: 0xf8d290,
            pointers: 0x63d20, pointersSource: 'maincpu', pointersBy: 'body',
        },
        /*
         * The same routine's bodies, read across by name rather than by number:
         * every index below renumbered, and taking the prototype's would not be
         * a near miss. Its body 34 is the spider and this build's is BO_sophi,
         * so she drew the spider's legs; its 35 is Samson and this build's is
         * BO_hyum, so he drew Samson's hand.
         *
         * The mapping is confirmed where the code states it: the callback
         * compares the body number against 2, 34 and 50, which are BO_tom,
         * BO_sophi and BO_devilon here, and reaches the Devilons' wing beats
         * with `lda 0x1401` and `lda 0x7CD` — 5121 and 1997, the numbers
         * PN_devilon_hane01 and PN_devilonm_hane01 carry in this build's model
         * table.
         *
         * Three of the prototype's are null because this game has no such body:
         * there is no BO_gman, no BO_handrb and no BO_tarab, and the rules that
         * name them cannot fire. This build's callback is the larger of the two
         * and may treat bodies of its own apart; those have not been read yet.
         */
        callback: {
            bodies: {
                tom: 2, hand: null, gman: null, gmanKihon: 13, haride: 14, staje: 15,
                spider: null, samson: 30, sophie: 34, devilon: 50, devilonM: 55,
            },
            motions: {
                gmanDash: 188, soten: 195, handra: null, pDash: 339, kousya: 360,
                sButt: 386, sSinderu: 391, sTatiaga: 399, sUneune: 401,
                tombaan: 462, tombanban: 463, tompaan: 466,
            },
            models: {
                magazine: 1814, gunHand: 1819, kousyaHand: 875, sotenHand: null,
                coat: 181, fingersA: null, fingersB: null, spiderLegs: null,
                samsonHand: 1367, sophieHead: 1550, sophieBlink: 1551,
                sophieRun: 1552, devilonWing: 5121, devilonMWing: 1997,
            },
        },
        /* The prototype's bodyMotions, carried over by name. This build's code
         * was rewritten too far for body_motions.py to read it the same way:
         * the per-body tables moved into the data ROM behind pointers in RAM.
         * So each body that kept its prototype name takes the motions that
         * body's routine plays there, renumbered by motion name, and those
         * named for the first time here (36 of them: BO_moody, BO_kyurian, the
         * mummies, the later bosses...) have none. Written by
         * `body_motions.py hotdp.zip hotd.zip`. */
        bodyMotions: [
            /* 0 BO_dkiller_kihon */
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 19, 20, 21, 100, 101, 102, 103, 104, 105,
             106, 107, 108, 110, 112, 113, 178, 179, 181, 185, 187, 206, 207, 208, 220, 255, 302, 304, 305,
             306, 307, 308, 312, 386, 388, 390, 391, 399, 401, 497],
            /* 1 BO_mon_kihon */
            [118, 120, 122, 128, 129, 131, 135, 137, 404, 410, 411, 414, 417, 418, 419, 425, 426, 428, 429,
             430, 433, 434, 439, 445, 446, 448, 497],
            /* 2 BO_tom */
            [178, 179, 181, 185, 187, 461],
            /* 3 BO_ebita */
            [259, 472, 474, 483, 494, 497, 500, 502, 504, 505, 509, 512, 519, 560, 561, 563, 564, 565, 569,
             570, 571, 594, 621, 626, 643, 644, 645, 648, 649],
            /* 4 BO_ebitb */
            [142, 143, 144, 145, 146, 147, 149, 150, 151, 154, 156, 158, 163, 164, 167, 168],
            /* 5 BO_mr_g */
            [333],
            /* 6 BO_molb */
            [302, 303, 304, 305, 306, 307, 308, 312, 497],
            /* 7 BO_frog_ct */
            [178, 179, 181, 185, 187],
            /* 8 BO_dkiller_black */
            [100, 101, 102, 103, 104, 105, 106, 107, 108, 110, 112, 113, 206, 207, 208],
            /* 9 BO_mon_black */
            [118, 120, 122, 128, 129, 131, 135, 137, 404, 410, 411, 414, 417, 418, 419, 425, 426, 428, 429,
             430, 433, 434, 439, 445, 446, 448, 497],
            /* 10 BO_syndy */
            [188, 196, 339, 360, 370, 371, 452, 461],
            /* 11 BO_zom */
            [259, 336, 460, 472, 474, 476, 477, 479, 483, 484, 487, 494, 495, 497, 500, 502, 504, 505, 512,
             516, 517, 518, 519, 534, 535, 560, 561, 563, 564, 565, 612, 621, 626, 641, 643, 644, 645, 648,
             649, 658],
            /* 12 BO_debu */
            [472, 474, 477, 478, 494, 497, 499, 500, 502, 504, 505, 523, 524, 529, 532, 540, 560, 561, 563,
             564, 565],
            /* 13 BO_gman_kihon */
            [459],
            /* 14 BO_haride */
            [466],
            /* 15 BO_staje */
            [462],
            /* 16 BO_zonbiman */
            [259, 472, 474, 483, 494, 497, 500, 502, 504, 505, 518, 519, 534, 535, 540, 560, 561, 563, 564,
             565, 612, 617, 618, 619, 620, 621, 643, 644, 645, 648, 649],
            /* 17 BO_kenkyu */
            [189, 212, 217, 218, 220, 221, 222, 228, 229, 232, 235, 236, 245, 246, 255, 264, 266, 270, 271,
             274, 278, 281, 288, 374, 459],
            /* 18 BO_semu */
            [118, 120, 122, 128, 129, 131, 135, 137, 404, 410, 411, 414, 417, 418, 419, 425, 426, 428, 429,
             430, 433, 434, 439, 445, 446, 448, 497],
            /* 19 BO_kenkyu_c */
            [189, 212, 217, 218, 220, 221, 222, 228, 229, 232, 235, 236, 245, 246, 255, 264, 266, 270, 271,
             274, 278, 281, 288, 459],
            /* 20 BO_kenkyu_h */
            [189, 212, 217, 218, 220, 221, 222, 228, 229, 232, 235, 236, 245, 246, 255, 264, 266, 270, 271,
             274, 278, 281, 288, 459],
            /* 21 BO_kenkyu_m */
            [189, 211, 212, 217, 218, 220, 221, 222, 225, 228, 229, 231, 232, 235, 236, 245, 246, 248, 255,
             257, 262, 263, 264, 266, 270, 271, 274, 276, 278, 281, 288, 459],
            /* 22 BO_kenkyu_s */
            [459],
            /* 23 BO_lady_o */
            [189, 212, 217, 218, 220, 221, 222, 228, 229, 232, 235, 236, 245, 246, 255, 264, 266, 270, 271,
             274, 278, 281, 288, 459],
            /* 24 BO_mummy */
            [259, 472, 474, 477, 478, 479, 483, 485, 494, 497, 500, 502, 504, 505, 512, 519, 560, 561, 563,
             564, 565, 621, 643, 644, 645, 648, 649],
            /* 25 BO_lady_l */
            [189, 211, 212, 217, 218, 220, 221, 222, 225, 228, 229, 231, 232, 235, 236, 245, 246, 248, 255,
             257, 262, 263, 264, 266, 270, 271, 274, 276, 278, 281, 288, 459],
            /* 26 BO_lady_m */
            [211, 218, 222, 225, 231, 236, 248, 255, 257, 262, 263, 271, 274, 276, 288, 459],
            /* 27 BO_lady_n */
            [189, 212, 217, 218, 220, 221, 222, 228, 229, 232, 235, 236, 245, 246, 255, 264, 266, 270, 271,
             274, 278, 281, 288, 459],
            /* 28 BO_neil */
            [259, 472, 474, 477, 478, 479, 483, 485, 494, 497, 500, 502, 504, 505, 512, 518, 519, 534, 535,
             560, 561, 563, 564, 565, 612, 621, 643, 644, 645, 648, 649],
            /* 29 BO_siriru */
            [259, 336, 337, 472, 474, 476, 477, 479, 483, 486, 487, 494, 495, 497, 500, 502, 504, 505, 512,
             518, 519, 534, 535, 560, 561, 563, 564, 565, 604, 608, 609, 612, 613, 614, 643, 644, 645, 648,
             649],
            /* 30 BO_samson */
            [259, 336, 338, 472, 474, 476, 477, 478, 483, 485, 497, 498, 505, 507, 510, 512, 518, 534, 535,
             542, 549, 550, 552, 554, 560, 561, 563, 564, 565, 587, 589, 590, 591, 592, 612, 643, 644, 645,
             648, 649],
            /* 31 BO_haris */
            [472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 518, 519, 560, 621],
            /* 32 BO_gilmoa */
            [259, 472, 474, 483, 494, 497, 500, 502, 504, 505, 512, 519, 560, 561, 563, 564, 565, 572, 575,
             576, 584, 585, 586, 617, 618, 619, 620, 621, 643, 644, 645, 648, 649],
            /* 33 BO_bentry */
            [259, 472, 474, 477, 478, 494, 497, 499, 500, 502, 504, 505, 518, 523, 524, 529, 532, 540, 560,
             561, 563, 564, 565, 643, 644, 645, 648, 649],
            /* 34 BO_sophi */
            [220, 255, 386, 388, 390, 391, 399, 401, 459],
            /* 35 BO_hyum */
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 19, 20, 21, 105, 477, 478, 479, 483, 485,
             497, 499, 512, 519, 621],
            /* 36 BO_hyumhada */
            [483, 497, 519, 621],
            /* 37 BO_dreik */
            [118, 120, 122, 128, 129, 131, 135, 137, 404, 410, 411, 414, 417, 418, 419, 425, 426, 428, 429,
             430, 433, 434, 439, 445, 446, 448, 497],
            /* 38 BO_kage */
            [118, 120, 122, 128, 129, 131, 135, 137, 404, 410, 411, 414, 417, 418, 419, 425, 426, 428, 429,
             430, 433, 434, 439, 445, 446, 448, 497],
            /* 39 BO_lubin */
            [411],
            /* 40 BO_dkillerb */
            [100, 101, 102, 103, 104, 105, 106, 107, 108, 110, 112, 113, 206, 207, 208],
            /* 41 BO_neopetit */
            [259, 472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561,
             563, 564, 565, 621, 643, 644, 645, 646, 647, 648, 649],
            /* 42 BO_neopetit2 */
            [259, 472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561,
             563, 564, 565, 621, 643, 644, 645, 646, 647, 648, 649],
            /* 43 BO_neopetit3 */
            [259, 472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561,
             563, 564, 565, 621, 643, 644, 645, 646, 647, 648, 649],
            /* 44 BO_pkenb */
            [472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561, 563,
             564, 565, 621, 644, 646, 647, 648],
            /* 45 BO_bentryb */
            [259, 472, 474, 477, 478, 494, 497, 499, 500, 502, 504, 505, 518, 523, 524, 529, 532, 540, 560,
             561, 563, 564, 565, 643, 644, 645, 648, 649],
            /* 46 BO_pdolob */
            [259, 472, 474, 483, 494, 497, 500, 502, 504, 505, 512, 519, 560, 561, 563, 564, 565, 621, 626,
             643, 644, 645, 648, 649],
            /* 47 BO_harisb */
            [472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 621],
            /* 48 BO_taraba_b */
            [],
            /* 49 BO_kenkyu_j */
            [459],
            /* 50 BO_devilon */
            [22, 27, 29, 32, 35, 459],
            /* 51 BO_bentryc */
            [259, 472, 474, 477, 478, 494, 497, 499, 500, 502, 504, 505, 518, 523, 524, 529, 532, 540, 560,
             561, 563, 564, 565, 643, 644, 645, 648, 649],
            /* 52 BO_disiprin */
            [472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561, 563,
             564, 565, 621],
            /* 53 BO_tetuman */
            [472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561, 563,
             564, 565, 621],
            /* 54 BO_zonbi_b_2 */
            [472, 474, 477, 478, 479, 483, 485, 494, 497, 499, 500, 502, 504, 505, 512, 519, 560, 561, 563,
             564, 565, 621],
            /* 55 BO_devilonm */
            [22, 27, 29, 32, 35, 497],
            /* 56 BO_neozom */
            [472, 474, 483, 494, 497, 500, 502, 504, 505, 512, 560, 561, 563, 564, 565, 621, 626, 645],
            /* 57 BO_mummy2 */
            [259, 472, 474, 477, 478, 479, 483, 485, 494, 497, 500, 502, 504, 505, 512, 519, 560, 561, 563,
             564, 565, 621, 643, 644, 645, 648, 649],
            /* 58 BO_gilmoab */
            [259, 472, 474, 483, 494, 497, 500, 502, 504, 505, 512, 519, 560, 561, 563, 564, 565, 572, 575,
             576, 584, 585, 586, 617, 618, 619, 620, 621, 643, 644, 645, 648, 649],
            /* 59 BO_moody */
            [],
            /* 60 BO_kyurian */
            [],
            /* 61 BO_mummyb */
            [],
            /* 62 BO_mummy2b */
            [],
            /* 63 BO_gilmoac */
            [],
            /* 64 BO_boss3 */
            [],
            /* 65 BO_bentryd */
            [],
            /* 66 BO_pbaba */
            [],
            /* 67 BO_zsophi */
            [],
            /* 68 BO_kage2 */
            [],
            /* 69 BO_devilonx */
            [],
            /* 70 BO_moodyb */
            [],
            /* 71 BO_harisc */
            [],
            /* 72 BO_bentrye */
            [],
            /* 73 BO_mummy2c */
            [],
            /* 74 BO_gilmoad */
            [],
            /* 75 BO_hiru_b */
            [],
            /* 76 BO_boss4 */
            [],
            /* 77 BO_harisd */
            [],
            /* 78 BO_kyurianb */
            [],
            /* 79 BO_dkiller_jp */
            [],
            /* 80 BO_dkiller_bl_jp */
            [],
            /* 81 BO_dkillerb_jp */
            [],
            /* 82 BO_taalu */
            [],
            /* 83 BO_taalub */
            [],
            /* 84 BO_burner */
            [],
            /* 85 BO_burnerb */
            [],
            /* 86 BO_mummyc */
            [],
            /* 87 BO_kage2b */
            [],
            /* 88 BO_moodyc */
            [],
            /* 89 BO_bentryf */
            [],
            /* 90 BO_tarabab */
            [],
            /* 91 BO_gfrog */
            [],
            /* 92 BO_moodybb */
            [],
            /* 93 BO_moodycc */
            [],
        ],
        bodyMotionsLabel: 'Played by its routine in the prototype',
    },
    features: { stages: true, characters: false, motions: true, bodies: true },
};

/* ---- The House of the Dead (Revision A) ---------------------------------- */

/*
 * The `hotd` set: the same game as `hotdo`, with a patched program pair.
 *
 * Only epr-19696a.15/epr-19697a.16 differ — the first megabyte of the program
 * ROM, which is where every table the viewer reads out of it lives. The second
 * pair and every mask ROM are the same chips, so the model table, the names,
 * the bounds, the roles, the scales, the hit motions, the luma curve and the
 * whole skin block are at the addresses above, untouched.
 *
 * The patch is an insertion, not a rewrite. 28.5% of that megabyte's bytes
 * differ across 408 clusters, but what the differences do is push things along:
 * every table below sits exactly sixteen bytes later than `hotdo`'s, the colour
 * block a hundred and twelve, and the contents are the same bytes wherever they
 * are not themselves pointers — the joint counts, the frame counts, the flat
 * ankles, the top palette, the gain, the sky records, the texture patches and
 * the bank table are all byte for byte what they were.
 *
 * Two things do not simply shift, so neither is assumed:
 *
 *   - the skin index and the skin's texture pointers are not sixteen bytes on
 *     but a quarter of a megabyte back, at 0x20E40 and 0x20F00. Their contents
 *     are byte for byte `hotdo`'s, all 94 indices and all 28 skins.
 *   - the stage scripts did not move at all. `scripts` is still 0xE0000 and its
 *     header still names the same seven chapters; only the last of the seven
 *     points anywhere new.
 *
 * Every address here was found by running the same finders over this program
 * ROM that found `hotdo`'s over its own — the `BO_`/`MO_` name runs, the
 * increasing XTRA_DATA run, the palette tables' four opening colours, the
 * 24-byte placement records and the 50-byte zone lists, the sky's dome
 * numbers — not by adding sixteen to the profile above. The shift is what came
 * out, not what went in.
 */
const hotd = {
    ...hotdo,
    id: 'hotd',
    name: 'The House of the Dead (Revision A)',
    /* The `a` suffix is the whole difference, so identify on both halves of the
     * pair that carries it. */
    identify: ['epr-19696a.15', 'epr-19697a.16', 'mpr-19715.17', 'mpr-19718.27'],
    regions: {
        ...hotdo.regions,
        maincpu: {
            size: 0x200000,
            parts: [
                [0x000000, 'epr-19696a.15', 0x42adc32e, 'epr-19697a.16', 0x1e247cd5],
                [0x100000, 'epr-19694.13', 0xe85ca1a3, 'epr-19695.14', 0xcd52b461],
            ],
        },
    },
    /* +0x70, with the set tables' own chain — each ending where the next
     * begins, the top table behind the last — intact. */
    palette: { ...hotdo.palette, tables: 0xa9960, top: 0xa35c8 },
    texture: {
        ...hotdo.texture,
        raw: { ...hotdo.texture.raw, bankTable: 0xa99e0, patchTable: 0xc15f0 },
    },
    colors: {
        ...hotdo.colors,
        curve: { sets: { ...hotdo.colors.curve.sets, ptrs: 0xa99a0, gain: 0xa8318 } },
    },
    stageTable: {
        ...hotdo.stageTable,
        placements: {
            ...hotdo.stageTable.placements,
            maps: 0xc0bd0, zones: 0xc0bb0, sectionSets: 0xab0b0,
            /* Unmoved, and `bounds` is in the shared data ROM. Placement 55 is
             * still PN_room5a_CT00a with its 32-frame cycle in the record's
             * second tail word, so `cycle` and `turns` carry over as they are. */
            scripts: 0xe0000,
        },
    },
    sky: { ...hotdo.sky, models: 0xac1f0, heights: 0xac1f4, spins: 0xac1f8 },
    /* The props' table moved with everything else, and the handler further
     * than the tables did — the tables are 0x10 on and the routine is at
     * 0x3B160 rather than 0x3A220. It is worth saying that the reader failed
     * safe when the table had not moved: at 0xAC314 this build reads PN_space
     * for every type, so every prop was dropped rather than drawn wrong. */
    objects: {
        ...hotdo.objects,
        table: 0xac2e0, handlers: 0xaf960, prop: 0x3b160,
        classes: 0xafde0, generic: 0x39930,
    },
    rig: {
        bodies: {
            ...hotdo.rig.bodies,
            names: 0xc8a60, joints: 0xc73c0, trees: 0xc7240,
            skins: 0x20e40,
        },
        motions: { ...hotdo.rig.motions, names: 0xc8be0, data: 0xc7540, frames: 0xc7fd0, flatAnkles: 0x7c6f0 },
        skins: { ...hotdo.rig.skins, pointers: 0x20f00 },
        /* Body and motion indices, so the same for both revisions: the two name
         * tables are the same names in the same order, and only the tables'
         * addresses moved. */
        callback: hotdo.rig.callback,
        bodyMotions: hotdo.rig.bodyMotions,
        bodyMotionsLabel: hotdo.rig.bodyMotionsLabel,
    },
};

/* ---- Daytona USA --------------------------------------------------------- */

/*
 * Daytona USA, which shipped in eight builds, and the only game here that is
 * not on a 2A or 2B board.
 *
 * This is the original Model 2 — a Fujitsu TGP beside the i960 where the later
 * titles have a SHARC, texture RAM at 0x12000000 rather than 0x11000000, and
 * AM2's library two years younger. None of the addresses the other profiles
 * carry survive that, and neither does the shape of some of the tables. What
 * does survive is the board: the polygon format, the texture sheets, the
 * 10-bit colorbase and the colorxlat/luma pair belong to the geometry engine
 * and the rasteriser rather than to the game, so the decoders are used
 * unchanged and only the numbers below are this game's own.
 *
 * There is no symbol table for this title and no decompilation, so every
 * address here was read off an instruction. Reading eight program ROMs by hand
 * would be eight chances to transcribe a number wrongly, so they were not read
 * by hand: stf-tools' `daytona-tables.mjs` finds each routine by the
 * instruction that names its table and prints the block, and `--check` holds
 * what it finds against what is written here. The signatures it goes by:
 *
 *   0x1134    g10 = 0x00800000 (the geometry engine), g11 = 0x00880000 (the
 *             TGP's function port) and g12 = 0x4000, which is what makes a
 *             store to `0x60(g10)` readable as engine function 6
 *   the draw routine   walks a model's records and hands the engine tpa, tha,
 *             oba and a count — four words and a zero that ends the list
 *   `lda 0x1802000`    the face palette upload, which states its own source,
 *             destination and length
 *   `lda 0x12200000` beside `lda 0x12600000`   the texture bank upload; its
 *             callers give the bank table and the bank every build shares
 *   `lda 0x12800000`   the luma RAM upload
 *   a store at +0x10000 from 0x1800000   the colorxlat build
 *   a store at +0x60 from the engine's base   the material upload
 *
 * The model table is not indexed by the program — it names each entry by
 * address — so it is found from the other end: it ends where the palette
 * begins, and stepping back from there a stride at a time while the record is
 * still a model record gives the base and the count. Every one of the program
 * ROM's own pointers into that range then has to land on an entry, and does.
 *
 * The courses are `courses` below, a 16x16 grid of block models; what stands
 * along them is `objects`, read in js/daytona.js. Neither was found by the
 * first pass over this game, and this paragraph used to say there were no
 * stages.
 */

/* The chips the builds share, which is most of them. Daytona's 1993 version is
 * the one that differs deepest — its own data pair, its own fourth polygon pair
 * and its own second texture pair — and everything after it is the same board
 * with a patched program and a patched half-megabyte of data. */
const DAYTONA_DATA0 = [0x000000, 'mpr-16528.10', 0x9ce591f6, 'mpr-16529.11', 0xf7095eaf];
const DAYTONA_DATA4 = [0x400000, 'mpr-16808.8', 0x44f1f5a0, 'mpr-16809.9', 0x37a2dd12];
const DAYTONA_POLY = [
    [0x000000, 'mpr-16523.ic16', 0x2f484d42, 'mpr-16518.ic20', 0xdf683bf7],
    [0x400000, 'mpr-16524.ic17', 0x34658bd7, 'mpr-16519.ic21', 0xfacd1c81],
    [0x800000, 'mpr-16525.ic18', 0xfb517521, 'mpr-16520.ic22', 0xd66bd9bd],
];
const DAYTONA_POLYC = [0xc00000, 'mpr-16772.ic19', 0x770ed912, 'mpr-16771.ic23', 0xa2205124];
const DAYTONA_TEX0 = [0x000000, 'mpr-16522.25', 0x55d39a57, 'mpr-16521.24', 0xaf1934fb];
const DAYTONA_TEX8 = [0x800000, 'mpr-16770.27', 0xf9fa7bfb, 'mpr-16769.26', 0xe57429e9];

/*
 * Fixes to the texture ROM's UV and material streams, carried over from the
 * Lua cheats m2emulator ships for Daytona (`Romset_PatchWord/DWord(4, ...)`:
 * its area 4 is this `textures` region, word-interleaved the same way and read
 * little-endian). Every build shares the chip pair they land in, DAYTONA_TEX0.
 *
 * Each edit is [offset, was, now]: the loader only writes where it finds
 * `was`, so a set whose bytes differ is left alone. A set loads without them;
 * the explorer's "fix errors" switch puts them in (setRomPatches in romset.js).
 */
const DAYTONA_PATCHES = [
    {
        /* 64 frames of the flag animation, 0x640 bytes apart: two words in
         * each, whose high half goes from 0x100 to 0x200. */
        name: 'flag animation',
        region: 'textures',
        size: 4,
        edits: Array.from({ length: 64 }, (_, n) => [
            [0x2e49c8 + n * 0x640, 0x01000100, 0x02000100],
            [0x2e49cc + n * 0x640, 0x01000080, 0x02000080],
        ]).flat(),
    },
    {
        name: 'tree',
        region: 'textures',
        size: 2,
        edits: [[0x0bad96, 0x0350, 0x0000]],
    },
    {
        /* The four UV pairs of the banner pole's face. */
        name: 'banner pole',
        region: 'textures',
        size: 4,
        edits: [
            [0x0d77c8, 0x01ed0055, 0x0800003f],
            [0x0d77cc, 0x01ed00d5, 0x080000bf],
            [0x0d77d0, 0x0f1500d5, 0x0fe700bf],
            [0x0d77d4, 0x0f150055, 0x0f37003f],
        ],
    },
];

/*
 * colorxlat's four constants, which are two sets rather than one.
 *
 * The routine that computes the table (0xA74 in every build) tests the test
 * menu's CABINET setting — backup RAM 0x1D0001A, 0 DELUXE, 1 TWIN, 2 UPRIGHT,
 * copied to work RAM 0x5FE5E2 — and takes the first set for DELUXE and the
 * second for the other two. The Special Edition tests bit 0 of its own copy
 * at 0x5FE602 instead; the 1993 build tests 0x53E5D0 and has a second set of
 * its own. The twin set starts every row brighter and climbs it more gently:
 * a monitor calibration, and it moves every colour on screen, the sky's among
 * them, since the tile chip's palette goes through this table too.
 *
 * Each build's list is its own test menu's, in its order, so the index is the
 * value the setting holds: Rev A and its clones offer DELUXE, TWIN and UPRIGHT,
 * the Special Edition DELUXE and TWIN, the 1993 build DELUXE and UPRIGHT
 * (spelled UPLIGHT in the ROM's own menu text, corrected here). The
 * panel's Cabinet switch picks among them (`rom.cabinet`).
 *
 * `DAYTONA_CABINET` is the one it opens on: the first that is not DELUXE,
 * because MAME's backup RAM holds TWIN and a MAME capture is what the explorer
 * is graded against. Dumped from the attract race with the Rev A ROMs, the
 * whole of colorxlat, all 0xC000 bytes, is the twin set's arithmetic exactly.
 */
const RAMP_DELUXE = { step: 12, span: 0x300, bias: 0x1160, flat: 0x8b };
const RAMP_TWIN = { step: 10, span: 0x280, bias: 0x1920, flat: 0xc9 };
const RAMP_UPRIGHT_93 = { step: 9, span: 0x240, bias: 0x1d00, flat: 0xe8 };
const DAYTONA_CABINETS = [
    { name: 'DELUXE', ramp: RAMP_DELUXE },
    { name: 'TWIN', ramp: RAMP_TWIN },
    /* The same table as TWIN: the routine only asks whether the setting is 0. */
    { name: 'UPRIGHT', ramp: RAMP_TWIN, same: 'TWIN' },
];
const DAYTONA_CABINETS_SE = DAYTONA_CABINETS.slice(0, 2);
const DAYTONA_CABINETS_93 = [
    { name: 'DELUXE', ramp: RAMP_DELUXE },
    { name: 'UPRIGHT', ramp: RAMP_UPRIGHT_93 },
];
const DAYTONA_CABINET = 1;

/*
 * The sound board, the one the original Model 2 kept from Model 1: a 68000
 * (the program pair, word-swapped as MAME loads it), two MultiPCMs with a
 * pair of sample ROMs each, and a YM3438 — js/sound/sound.js, board 'model1'.
 * Every build but the 1993 one carries these same chips.
 *
 * `music` is how start_setting (0x3BF0 in the Saturn-ads build) picks the
 * race's song: `ld 0x28050F0[r3*4], g0` and on to the UART, with r3 the
 * course — unless a VR button is held as the race starts, which picks
 * the song itself: VR1 the first, VR3 the second, VR2 the third, VR4 the
 * fourth, which no course has of its own. The table is at data 0x8050F0 in
 * every build here but the 1993 one, and says 0xAE1007, 0xAE1009, 0xAE1004,
 * 0xAE100E in all of them.
 *
 * What goes with it, as the game sends it: `boot` is sound_refresh's
 * 0xF8F8FF, which silences the board, and the settings the boot path sends
 * after it (the run at 0x19958); a new course stops the song the same way.
 * After the third song start_setting sends 0xB70700 as well, and the race's
 * scene set-up (0x23E74) follows every song with 0xBE1700 and 0xBE1900.
 */
const DAYTONA_SOUND_SETUP = [
    0xF8, 0xF8, 0xFF,
    0xBE, 0x14, 0x1F, 0xBE, 0x16, 0x02, 0xBE, 0x1B, 0x06, 0xBE, 0x1C, 0x03,
    0xBE, 0x1D, 0x01, 0xBE, 0x1E, 0x02, 0xBE, 0x1F, 0x05, 0xBE, 0x36, 0x09,
    0xBE, 0x17, 0x00, 0xBE, 0x18, 0x04, 0xBE, 0x35, 0x00, 0xBE, 0x34, 0x00,
];
const DAYTONA_SOUND = {
    board: 'model1',
    program: [['epr-16720.7', 0x8e73cffd], ['epr-16721.8', 0x1bb3b7b7]],
    samples: [
        ['mpr-16491.32', 0x89920903], ['mpr-16492.33', 0x459e701b],
        ['mpr-16493.4', 0x9990db15], ['mpr-16494.5', 0x600e1d6c],
    ],
    boot: DAYTONA_SOUND_SETUP,
    stop: DAYTONA_SOUND_SETUP,
    after: { song: { 2: [0xB7, 0x07, 0x00] }, every: [0xBE, 0x17, 0x00, 0xBE, 0x19, 0x00] },
    music: {
        region: 'mainData', table: 0x8050f0, slotMask: 3,
        buttons: ['VR1 (red)', 'VR3 (yellow)', 'VR2 (blue)', 'VR4 (green)'],
    },
};

/*
 * One build.
 *
 * `program` and `data8` are the pair that is this build's own; everything else
 * defaults to the chips above. The table block is what daytona-tables.mjs found
 * in that program ROM, and the fields that do not vary — the mesh-pointer
 * arithmetic, the record layout, the sheet layout — are the board's and are set
 * here once.
 */
function daytonaBuild(spec) {
    return {
        id: spec.id,
        name: spec.name,
        /* This build's own program pair, which no other Daytona set carries. */
        identify: [spec.program[1], spec.program[3]],
        regions: {
            /* Two 128KB EPROMs, and the board maps the second half twice: at
             * 0x20000 like any other and again at 0x00220000, which is the
             * alias the program's own pointers use. Offsets here are the
             * region's, so that alias is just 0x200000 subtracted. */
            maincpu: { size: 0x40000, parts: [spec.program] },
            /* Three pairs. MAME's region is 32MB with the last one mirrored up
             * through it; nothing the viewer reads is in the mirrors, so the
             * region is cut where the chips end. The first pair is not
             * addressed by anything here, the second holds the texture banks,
             * and the third the model table and the palette. */
            mainData: {
                size: spec.dataSize ?? 0x900000,
                parts: [spec.data0 ?? DAYTONA_DATA0, spec.data4 ?? DAYTONA_DATA4, spec.data8],
            },
            /* Four pairs, 13MB of the 16MB region. The model table's mesh
             * pointers open a new band at each pair, which is what says the
             * pairing is right: a mesh straddling a boundary would not open on
             * a unit normal. */
            polygons: {
                size: 0x1000000,
                parts: [...DAYTONA_POLY, spec.polyC ?? DAYTONA_POLYC],
            },
            /* Two pairs at the two offsets every game here uses, which on 2MB
             * chips leaves 0x400000-0x800000 empty. This region is the UV and
             * material streams only: the sheets are raw in the data ROM. */
            textures: {
                size: 0x1000000,
                parts: [DAYTONA_TEX0, spec.tex8 ?? DAYTONA_TEX8],
            },
            /* The TGP's data ROM, one float a word, the same chips in every
             * build: the collision polygons get_y_position asks it about, for
             * the road under the pylons and horses (courseGround in
             * js/daytona.js). Optional: without it they keep their records'
             * heights. */
            copro: {
                size: 0x400000,
                optional: true,
                parts: [[0x000000, 'mpr-16537.ic28', 0x36b7c35a, 'mpr-16536.ic29', 0x6d6afed9]],
            },
        },
        /* An entry is the four words the draw routine reads — oba, tpa, tha and
         * a polygon count — and then the zero that ends the list, which is what
         * makes the stride 20. Every model in this game is a one-entry list.
         * The order the three addresses reach the geometry engine is tpa, tha,
         * oba (model2_v.cpp geo_object_data), the same three the 1995 games
         * keep in the other order, so only `fields` changes. */
        modelTable: { ...spec.modelTable, stride: 20, fields: { mesh: 0, uv: 4, mat: 8 } },
        /* The board's arithmetic, not the game's: an object address with bit 23
         * set is a word index into the polygon ROM (geo_object_data's
         * `polygon_rom[oba & mask]`), and this is that index in bytes. */
        meshPtr: { subtract: 0x02000010, add: 0x10 },
        /* Where the model table ends. The entries above the count are never
         * written — the boot clear leaves 0xFC00 in them — so they are left as
         * no colour rather than read on past the table. */
        paletteOffset: spec.paletteOffset,
        paletteCount: spec.paletteCount,
        /*
         * The sheets are raw, as The House of the Dead's are, but dealt out by
         * a routine of Daytona's own: 0x60000 halfwords straight into one sheet
         * — its first 0xC0000 bytes, the full-size area — and then nine mip
         * levels of 0x80, 0x40 ... 1 rows alternating between the two sheets.
         * It is called twice a scene, once for the bank every course shares and
         * once for the course's own, so the two banks' mip halves come out
         * complementary.
         *
         * Coverage cannot say which bank a model is drawn against, because
         * every bank fills the whole sheet. A model a course draws takes that
         * course's (see `stageTable` below); for the rest the panel's picker
         * decides, and `defaultSet` is what it opens on.
         */
        texture: {
            raw: { layout: 'daytona', bankTable: spec.bankTable, bootBank: spec.bootBank },
            sets: spec.texSets,
            residentSet: null,
            defaultSet: 0,
        },
        /*
         * Luma is a straight copy out of the program ROM: a band count and that
         * many 128-byte bands. colorxlat is not copied from anywhere — the
         * routine computes all 32 rows from four constants, which of two sets
         * depending on the cabinet (DAYTONA_CABINETS):
         *
         *   v = row * i * step ; if (v) v += bias ; v >>= 6 ; if (v >= 0x100) v = -1
         *   tail = (step * row) ? (flat + step * row) >> 1 : 0
         *
         * 64 ramp entries and 192 flat ones is a whole 256-entry row, and all
         * three channels get the same value because on this board the row is
         * the palette colour's own five bits for that channel. There is no
         * per-channel trim and no stage tint in it at all.
         *
         * `solid` because an untextured face really does go through this table
         * here: draw_scanline_solid indexes the row with the polygon's own luma
         * cut to six bits, which is what js/viewer.js's uSolidRamp does.
         */
        colors: {
            luma: { ...spec.luma },
            ramp: spec.cabinets[DAYTONA_CABINET].ramp,
            cabinets: spec.cabinets,
            cabinet: DAYTONA_CABINET,
            solid: true,
        },
        /*
         * The material table, uploaded whole at boot as geometry-engine
         * function 6 out of two parallel arrays rather than one interleaved
         * table, which is why `stride` is 4 here and 8 in the other profiles.
         *
         * The light is three floats out of a view record. On the board that
         * vector is in the engine's post-transform frame, so it is a headlight
         * rather than a world light; applied here as a world light it shades a
         * model consistently from one side instead of following the camera,
         * which is what a model viewer wants. Z is negated for the decoder's
         * convention, as stageLight does for the other games.
         *
         * The stored normal is lit rather than the polygon's plane: the mode
         * calls set geometry mode 3 and then 1, and 1 is geo_parse_np_s.
         */
        lighting: { light: spec.light, materials: spec.materials },
        /* ROM fixes the explorer applies — see DAYTONA_PATCHES. */
        patches: DAYTONA_PATCHES,
        /*
         * The courses, which are a grid rather than a placement list: the world
         * is cut into a 16x16 grid of 128-unit blocks and each block is one
         * model, drawn with no matrix at all. `courses` is the array that names
         * one 256-entry block table per course — in the data ROM for every build
         * but the 1993 one, which keeps it in the program ROM. See
         * readCourseStages in js/stages.js for the routines this is read off.
         *
         * `flat` because the geometry really is already in world space, as
         * Fighting Vipers' arenas are — and because it keeps the Models tab's
         * texture picker, which the models no course claims still need.
         */
        stageTable: {
            courses: { ...spec.courses, count: 4, blocks: 256 },
            flat: true,
        },
        /* What stands along the courses — see DAYTONA_OBJECTS_A. */
        objects: spec.objects ?? null,
        /*
         * The sky, which is not geometry but the tile layer's panorama: 256
         * tiles round the full turn, eight patterns of 32, streamed into the
         * tilemap as the car turns (js/scroll.js, buildCourseSky). `table` is
         * the four-course table change_course_bank indexes by sel_course; the
         * first word of each row is that course's sky. Found by daytona-tables.mjs
         * by the shape of what it points at.
         */
        sky: spec.sky ?? null,
        /*
         * The same depth arrangement The House of the Dead wants, and for the
         * same reason: this board has no depth buffer, and a course is large
         * plates with smaller ones laid on them in the one plane — the lane
         * markings on the road, the kerbs against it, the infield grass
         * against the apron. A depth test finds the same depth on both and
         * hands the pixel to whichever the rounding favours, which is what
         * broke the infield into mismatched patches of green.
         *
         * `recede: 0` for Fighting Vipers' reason as well: a bounded recede
         * steps each face back by its own depth, so plates in one plane part
         * by how they were cut and the parting moves with the camera. Nothing
         * here is modelled behind a surface it shows through, which is what a
         * recede is for. */
        depth: { recede: 0, nearMin: 0.02, layers: true },
        /* The music, off until switched on — see DAYTONA_SOUND. */
        sound: spec.sound === undefined ? DAYTONA_SOUND : spec.sound,
        /* Stages, but no rig: this game has no motion tables of any kind. */
        features: { stages: true, characters: false, motions: false, bodies: false },
    };
}

/*
 * The trackside objects, which js/daytona.js reads and draws: where each
 * course's table of object records is, what each routine a record starts in
 * draws, and the tables those routines read. Every number here is an operand of
 * the instruction in the routine that uses it, and stf-tools'
 * `daytona-tables.mjs` finds them that way and holds them against these with
 * `--check`. The names in the comments are the board's own, out of the symbol
 * table Sega Racing Classic's d1a.exe carries.
 *
 * Revision A and the five sets built on it share one layout; the Special
 * Edition moved its tables and put back the second crowd the 1993 version
 * had. The 1993 version writes several routines its own way — see
 * DAYTONA_OBJECTS_93.
 */
const DAYTONA_KINDS_A = {
    0x20118: 'static', 0x201bc: 'cycle', 0x202c4: 'ship', 0x20364: 'slot',
    0x20698: 'light', 0x20730: 'light', 0x207c8: 'spinZ', 0x20898: 'spinY',
    0x20948: 'crowd', 0x20a54: 'world', 0x20b08: 'rank', 0x20d34: 'windmill',
    0x20e54: 'jeffry', 0x210a0: 'checkpoint', 0x211fc: 'flags', 0x212a4: 'light',
    0x212e4: 'none', 0x21618: 'runs', 0x21664: 'pylon', 0x21698: 'pylon',
    0x216cc: 'pylon', 0x21700: 'pylon', 0x21e40: 'window', 0x21ef8: 'window',
    0x22018: 'world', 0x22080: 'flock', 0x22314: 'birds', 0x224f8: 'bigBird',
    0x22608: 'horse', 0x22a20: 'curtainCall',
};
const DAYTONA_OBJECTS_A = {
    at: 0x33bfc, kinds: DAYTONA_KINDS_A,
    cycles: 0x236b40, checkpoints: 0x236d60, spinY: -0x100,
    rankBoard: 0x23607c, rankCars: 0x2360b8,
    windmill: { sails: 0x2361b0, still: [0x2843e6c, 0x2843e80] },
    birds: 0x233b7c, horses: 0x233afc, jeffry: 0x28478a0,
    crowds: [{ list: 0x236e38, count: 12 }],
    pylons: { 0x21664: 0x2850ce0, 0x21698: 0x2850cf0, 0x216cc: 0x2850d00, 0x21700: 0x2850cd0 },
};
const DAYTONA_OBJECTS_SE = {
    at: 0x348c8,
    kinds: {
        0x20118: 'static', 0x201bc: 'cycle', 0x202c4: 'ship', 0x20364: 'slot',
        0x20698: 'light', 0x20730: 'light', 0x207c8: 'spinZ', 0x20898: 'spinY',
        0x20948: 'crowd', 0x20a6c: 'world', 0x20b48: 'rank', 0x20dd8: 'windmill',
        0x20ef8: 'jeffry', 0x21144: 'checkpoint', 0x212a0: 'flags', 0x21348: 'light',
        0x213b0: 'none', 0x216e4: 'runs', 0x21730: 'pylon', 0x21764: 'pylon',
        0x21798: 'pylon', 0x217cc: 'pylon', 0x21f0c: 'window', 0x21fc4: 'window',
        0x220e4: 'world', 0x2214c: 'flock', 0x223e0: 'birds', 0x225c4: 'bigBird',
        0x226d4: 'horse', 0x22aec: 'curtainCall',
    },
    cycles: 0x23780c, checkpoints: 0x237a2c, spinY: -0x100,
    rankBoard: 0x236d48, rankCars: 0x236d84,
    windmill: { sails: 0x236e7c, still: [0x2843e6c, 0x2843e80] },
    birds: 0x234848, horses: 0x2347c8, jeffry: 0x28478a0,
    crowds: [{ list: 0x237c44, count: 9 }, { list: 0x237b24, count: 12 }],
    pylons: { 0x21730: 0x2850ce0, 0x21764: 0x2850cf0, 0x21798: 0x2850d00, 0x217cc: 0x2850cd0 },
};

/*
 * The 1993 build, which writes the same routines its own way: every check point
 * is a routine of its own with its scale and list inline (`checkpointsAt`), one
 * of its two prop routines walks a list of its own (`lists`), the dice turn the
 * other way, and the crowd routine draws both crowds an instruction at a time,
 * traced by daytona-tables.mjs into `groups`.
 */
const DAYTONA_OBJECTS_93 = {
    at: 0x36940,
    kinds: {
        0x2024c: 'cycle4', 0x20304: 'ship', 0x203a4: 'static', 0x20450: 'static',
        0x204fc: 'slot', 0x209e4: 'light', 0x20a7c: 'light', 0x20b14: 'spinZ',
        0x20be4: 'spinY', 0x20d44: 'cycle', 0x2108c: 'crowd', 0x21d24: 'world',
        0x21dd8: 'rank', 0x21f10: 'windmill', 0x22030: 'checkpointAt', 0x22090: 'checkpointAt',
        0x2214c: 'checkpointAt', 0x22264: 'jeffry', 0x22594: 'checkpointAt', 0x22678: 'checkpointAt',
        0x2275c: 'checkpointAt', 0x22840: 'checkpointAt', 0x22c48: 'flags', 0x22cf0: 'light',
        0x22d30: 'none', 0x2302c: 'runs', 0x23078: 'pylon', 0x230ac: 'pylon',
        0x230e0: 'pylon', 0x23114: 'pylon', 0x23b08: 'window', 0x23bc0: 'window',
        0x23ce0: 'world', 0x23d48: 'flock', 0x2430c: 'birds', 0x24730: 'bigBird',
        0x24854: 'horse', 0x24cd0: 'curtainCall',
    },
    lists: { 0x2024c: 0x238b04 },
    cycles: 0x220e7c,
    checkpointsAt: {
        0x22030: { scale: 1, list: null, world: true },
        0x22090: { scale: 1, list: 0x2391b8, world: true },
        0x2214c: { scale: 0.69, list: 0x239548, world: false },
        0x22594: { scale: 0.75, list: null, world: false },
        0x22678: { scale: 1.2, list: null, world: false },
        0x2275c: { scale: 1, list: null, world: false },
        0x22840: { scale: 1.1, list: null, world: false },
    },
    spinY: 0x100,
    rankBoard: 0x238dc0, rankCars: 0x238dfc,
    windmill: { sails: 0x238eb8, still: [0x288bbe0, 0x288bbf4] },
    birds: 0x2368c0, horses: 0x236840, jeffry: 0x288f614,
    crowds: [{
        groups: [
            /* The plaza's, while its block is in view. */
            { at: [-798, 33.58, 176.8], turns: [['y', 23301]], list: 0x238d20 },
            { at: [-813, 33.58, 187.7], turns: [['y', 21845]], list: 0x238d30 },
            { at: [-804, 33.58, 174], turns: [['y', 22573]], list: 0x238d50 },
            { at: [-804.5, 33.58, 186.4], turns: [['y', 21845]], list: 0x238d60 },
            { at: [-810, 33.58, 196], turns: [['y', 21116]], list: 0x238d70 },
            { at: [-788.5, 33.58, 165], turns: [['y', 25667]], list: 0x238d80 },
            { at: [-783.5, 33.58, 162], turns: [['y', 26942]], list: 0x238d90 },
            { at: [-807, 33.58, 191], turns: [['y', 22027]], list: 0x238da0 },
            { at: [-802, 33.58, 182.5], turns: [['y', 22209]], list: 0x238db0 },
            /* The shuttle's, while the player is on its stretch. */
            { at: [491.8, 14.5, -923], turns: [['z', -1094], ['y', -24577], ['x', -730]], list: 0x238d20 },
            { at: [390, 13.7, -970.8], turns: [['z', 0], ['y', 31675], ['x', 0]], list: 0x238d30 },
            { at: [479.5, 13.9, -935], turns: [['z', -548], ['y', -24577], ['x', -366]], list: 0x238d50 },
            { at: [397.3, 13.7, -971.5], turns: [['z', 0], ['y', 32221], ['x', 0]], list: 0x238d60 },
            { at: [473.9, 13.8, -940.4], turns: [['z', -1094], ['y', -24577], ['x', -366]], list: 0x238d70 },
            { at: [497.2, 15, -917.6], turns: [['z', -1094], ['y', -24577], ['x', -730]], list: 0x238d80 },
            { at: [485, 14, -929.7], turns: [['z', -548], ['y', -24577], ['x', -366]], list: 0x238d90 },
            { at: [500.7, 15.3, -914], turns: [['z', -1094], ['y', -24577], ['x', -730]], list: 0x238db0 },
            { at: [381.3, 13.7, -969.6], turns: [['z', 0], ['y', 30765], ['x', 0]], list: 0x238da0 },
            { at: [536.5, 18.7, -873], turns: [['z', -912], ['y', -24577], ['x', -728]], list: 0x238d20 },
            { at: [523, 17.5, -886.5], turns: [['z', -912], ['y', -24577], ['x', -728]], list: 0x238d30 },
            { at: [528, 18, -881], turns: [['z', -912], ['y', -24577], ['x', -728]], list: 0x238da0 },
        ],
    }],
    pylons: { 0x23078: 0x2896d94, 0x230ac: 0x2896da4, 0x230e0: 0x2896db4, 0x23114: 0x2896d84 },
};

const daytona93 = daytonaBuild({
    id: 'daytona93',
    name: 'Daytona USA (1993)',
    program: [0x00000, 'epr-16530a.12', 0x39e962b5, 'epr-16531a.13', 0x693126eb],
    data4: [0x400000, 'mpr-16526.8', 0x5273b8b5, 'mpr-16527.9', 0xfc4cb0ef],
    data8: [0x800000, 'epr-16534a.6', 0x1bb0d72d, 'epr-16535a.7', 0x459a8bfb],
    dataSize: 0xa00000,
    polyC: [0xc00000, 'epr-16646.ic19', 0x7ba9fd6b, 'epr-16645.ic23', 0x78fe0b8a],
    tex8: [0x800000, 'mpr-16517.27', 0x4705d3dd, 'mpr-16516.26', 0xa260d45d],
    modelTable: { offset: 0x887928, count: 2822 },
    paletteOffset: 0x8955a0, paletteCount: 1007,
    bankTable: 0x14bc, bootBank: 0x2500000, texSets: 4,
    luma: { source: 'maincpu', count: 0x2fd34, data: 0x2fd38 },
    cabinets: DAYTONA_CABINETS_93,
    materials: { source: 'maincpu', at: 0x5050, count: 32, stride: 4 },
    light: [-0.45, -0.89, 0.45],
    courses: { source: 'maincpu', at: 0x39b0 },
    sky: { table: 0x3a48 },
    objects: DAYTONA_OBJECTS_93,
    /* Its own sound program (epr-16489/16490 in MAME), which the dumps this
     * was worked out on do not carry; its song table is in the program ROM,
     * at 0x231E70. */
    sound: null,
});

/* What the Revision A program and every build made from it share: the data
 * ROM pair the tables sit in, and the tables. A build lists what it changes. */
const DAYTONA_REV_A = {
    data8: [0x800000, 'epr-16724a.6', 0x469f10fd, 'epr-16725a.7', 0xba0df8db],
    modelTable: { offset: 0x83fbb4, count: 3190 },
    paletteOffset: 0x84f4ec, paletteCount: 1007,
    bankTable: 0x15a0, bootBank: 0x2500000, texSets: 4,
    luma: { source: 'mainData', count: 0x802fc4, data: 0x802fc8 },
    cabinets: DAYTONA_CABINETS,
    materials: { source: 'mainData', at: 0x805128, count: 32, stride: 4 },
    light: [-0.45, -0.89, 0.45],
    courses: { source: 'mainData', at: 0x805298 },
    sky: { table: 0x4770 },
    objects: DAYTONA_OBJECTS_A,
};

const daytona = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytona',
    name: 'Daytona USA (Revision A)',
    program: [0x00000, 'epr-16722a.12', 0x48b94318, 'epr-16723a.13', 0x8af8b32d],
});

const daytonase = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytonase',
    name: 'Daytona USA Special Edition (Revision A)',
    program: [0x00000, 'epr-17369a.12', 0x3bc6ca62, 'epr-17370a.13', 0x5d1c74e4],
    data8: [0x800000, 'epr-17371.6', 0x7478f0d2, 'epr-17372.7', 0x308a06a9],
    bankTable: 0x15b4,
    cabinets: DAYTONA_CABINETS_SE,
    sky: { table: 0x47c8 },
    objects: DAYTONA_OBJECTS_SE,
});

const daytonas = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytonas',
    name: 'Daytona USA (with Saturn advertisements)',
    program: [0x00000, 'epr-17965.ic12', 0xf022b3da, 'epr-17966.ic13', 0xf9e4ece5],
    data8: [0x800000, 'epr-17967.ic6', 0xa94d8690, 'epr-17968.ic7', 0x9d5a92c6],
    bankTable: 0x15b4,
});

const daytonat = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytonat',
    name: 'Daytona USA (Turbo hack, set 1)',
    program: [0x00000, 'turbo1.12', 0x4b41a341, 'turbo2.13', 0x6ca580fa],
});

const daytonata = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytonata',
    name: 'Daytona USA (Turbo hack, set 2)',
    program: [0x00000, 'dayturbo.12', 0xaec6857a, 'dayturbo.13', 0xcb657edc],
});

const daytonam = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytonam',
    name: 'Daytona USA (To The MAXX)',
    program: [0x00000, 'maxx.12', 0x604ef2d9, 'maxx.13', 0x7d319970],
});

const daytonagtx = daytonaBuild({
    ...DAYTONA_REV_A,
    id: 'daytonagtx',
    name: 'Daytona USA (GTX 2004 Edition)',
    program: [0x00000, 'gtx.12', 0x08283a6f, 'gtx.13', 0xf9b356ae],
});

export const GAMES = [sfight, fvipers, hotdp, hotdo, hotd,
    daytona, daytona93, daytonase, daytonas, daytonat, daytonata, daytonam, daytonagtx];

/**
 * Pick the profile a set of zip member names belongs to.
 *
 * Members are looked at across every supplied zip at once, so a parent/clone
 * split spread over two archives identifies the same as one self-contained set.
 *
 * A merged set is the awkward case: it carries the parent and every clone in
 * one archive, so by basename alone all three House of the Dead profiles match
 * it at once and the answer would come down to the order of this list. MAME's
 * own convention settles it — the parent's chips are the ones at the top level,
 * and a clone's are in a directory named for it — so a profile whose members
 * are all top-level is preferred, and basenames decide only when none is.
 *
 * @param {Set<string>|string[]} names  every member name across the zips
 * @param {Set<string>} [nested]  those of them that exist only inside a
 *   clone's directory
 * @returns {null|object} the profile, or null if none matches
 */
export function detectGame(names, nested = null) {
    return detectGames(names, nested)[0] ?? null;
}

/**
 * Every profile a set of zip member names matches, best first.
 *
 * One archive can be more than one game. A merged MAME set carries the parent
 * and every clone at once, and where the clones are separate *games* rather
 * than revisions of one — Daytona USA ships as eight builds, three of them with
 * their own courses and cars — there is no single right answer to which one was
 * dropped. So the caller is told all of them and can offer the choice; `nested`
 * still decides the default, because MAME's convention is that the parent's
 * chips are the ones at the top level.
 *
 * @param {Set<string>|string[]} names  every member name across the zips
 * @param {Set<string>} [nested]  those of them that exist only inside a
 *   clone's directory
 * @returns {object[]} the profiles, the top-level one first
 */
export function detectGames(names, nested = null) {
    const have = names instanceof Set ? names : new Set(names);
    const has = (m) => have.has(m);
    const all = GAMES.filter((g) => g.identify.every(has));
    const top = all.filter((g) => g.identify.every((m) => !nested?.has(m)));
    return [...top, ...all.filter((g) => !top.includes(g))];
}
