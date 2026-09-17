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
    /* Stage records here are read by js/stages.js out of the program ROM, and
     * carry the draw list too, so there is no separate scene table. */
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
     * ZSORT_RECEDE in js/viewer.js is where these numbers come from. */
    depth: { recede: 12, nearMin: 0.02 },
    scenes: null,
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
         * Which set is resident behind the others is not known for this game,
         * so nothing is forced in ahead of the chosen one. */
        residentSet: null,
    },
    /*
     * The colour tables, which turned out to be the same machinery again.
     * send_tex_col_go here is instruction for instruction the other game's
     * send_tex_col_loop, the ramp in chg_pol_color_req uses the same 0x1C/0x12,
     * and sub_74C builds the intensity curve on the same pivot and divisor
     * (`shlo 2, 0x1D` and `addo 0x1F, 6` — 116 and 37). check_sram_all ships
     * add 22, multiply 54 and brightness 31, which are the other game's numbers
     * too, though this one keeps a pair per channel at 0x500234..0x500239
     * rather than one for all three.
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
        add: [22, 22, 22],
        mul: [54, 54, 54],
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
     * The scene records, which carry everything about a scene except its draw
     * list. change_scene indexes them with `shlo 8, r12, r4` off stage_num, so
     * the stride is 0x100 like the other game's, and the fields below are the
     * ones it and stage_disp read out: the brightness and the two rotations
     * that build the light vector, the pair of texture numbers it hands
     * send_tex_stage, and the three bytes stage_disp copies to 0x5000E0 as the
     * per-channel trim. The material table is a second array indexed the same
     * way — sub_24878 walks 32 slots out of `off_6CE33A4[stage_num*4]`.
     *
     * Sixteen records read as real scenes. This is not stage support: what a
     * stage is made of is a draw list, and that has not been located. It is
     * enough to light and colour a model the way a scene would.
     */
    /*
     * The stage records, which are the other game's record exactly.
     *
     * `stage_data` is a label in this program ROM, at 0x06CE1048 in the second
     * bank, and change_scene indexes it with `shlo 8, r12, r4` off stage_num.
     * Every field the other game's reader knows is at the same offset: the
     * flags word at 0, the brightness at 4, the two rotations at 8 and 0x0A,
     * the texture pair at 0x0C, the trim at 0x10, the four single models from
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
        materials: { source: 'xtra', ptrs: 0x06ce33a4 },
        /* change_scene hands both numbers to send_tex_stage. */
        texPair: 'literal',
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
            roles: 0xdc0380, skins: 0xd80000, hitMotions: 0xde5150,
        },
        /* `flatAnkles` is a byte per motion: set, the ankles are turned from the
         * body's own frame instead of the shin's (sub_2BA50). */
        motions: { names: 0x96130, count: 508, data: 0x95040, frames: 0x95830, flatAnkles: 0x5e880 },
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
                [0x1800000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1900000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1a00000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1b00000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1c00000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1d00000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1e00000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
                [0x1f00000, 'epr-19698.5', 0xe7a7b6ea, 'epr-19699.6', 0x8160b3d9],
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
     * entry at 212 and 500. No `loadOrder`: nothing here depends on what an
     * earlier set left behind, which is the one thing the prototype needed it
     * for.
     */
    palette: {
        source: 'maincpu', tables: 0xa98f0, split: 500, sets: 13,
        top: 0xa35b8, fixed: [[1023, 0x801f]],
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
    },
};

export const GAMES = [sfight, fvipers, hotdp, hotdo, hotd];

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
    const have = names instanceof Set ? names : new Set(names);
    const has = (m) => have.has(m);
    return GAMES.find((g) => g.identify.every((m) => has(m) && !nested?.has(m)))
        || GAMES.find((g) => g.identify.every(has))
        || null;
}
