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
 * model/palette data region, the polygon ROM and the texture ROM. Sound and
 * coprocessor regions are skipped. */
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

export const GAMES = [sfight, fvipers];

/**
 * Pick the profile a set of zip member names belongs to.
 *
 * Members are looked at across every supplied zip at once, so a parent/clone
 * split spread over two archives identifies the same as one self-contained set.
 *
 * @param {Set<string>|string[]} names  every member name across the zips
 * @returns {null|object} the profile, or null if none matches
 */
export function detectGame(names) {
    const have = names instanceof Set ? names : new Set(names);
    return GAMES.find((g) => g.identify.every((m) => have.has(m))) || null;
}
