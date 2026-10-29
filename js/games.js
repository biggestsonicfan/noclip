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

/* Sonic The Fighters' cells the program never draws: see sfight.cells. */
const SFIGHT_UNUSED_CELLS = [
    12, 19, 20, 23, 61, 75, 79, 81, 87, 93, 95, 97, 104, 111, 112, 123, 124,
    129, 131, 133, 135, 137, 139, 141, 143, 145, 147, 149, 151, 153, 170,
    176, 177, 178, 193, 195, 196, 198, 200, 203, 205, 206, 208, 210, 212,
    214, 216, 218, 223, 226, 228, 229, 231, 233, 235, 237, 239, 241, 243,
    245, 247, 249, 251, 259, 260, 303, 305, 330, 343, 344, 345, 346, 347,
    348, 349, 356, 364, 365, 366, 369, 374, 388, 389, 407, 409, 410, 411,
    412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425,
    426, 427, 428, 429, 430, 431, 432, 433, 434, 436, 498, 499, 503, 504,
    505, 506, 507, 508, 509, 510, 511, 512, 514,
];

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
    /* The 2D cells and the CGs that colour them (js/cells.js): the pointer
     * arrays _ScrollCG_Initialize (cg_offsets) and dsp_pattern_new
     * (texture_palette_offsets) index, in the XTRA_DATA window. The character
     * RAM is 0x1080000-0x10FFFFF, room for every 14-bit character.
     *
     * `cards` are the character cards' tables in the program ROM, one entry
     * per character: a cell table and the _Scroll_Initialize argument (2x the
     * CG) that goes with it. The VS screen (round_mask_routines) reads
     * P1_CHAR_CARDS with CG_PLAYER_CARDS and P2_CHAR_CARDS with
     * CG_PLAYER2_CARDS: the colour cards 129-152 on CGs 10-21. The table after
     * each holds the greyscale cards 229-252 on CGs 36-47, the same tiles in
     * other colours.
     *
     * `portraits` is CHAR_SELECT_PORTRAITS, which sel_mini_face_disp reads:
     * a pointer per select-screen slot to that fighter's animated face, seven
     * cells. sel_disp_init loads CG 7 (_Scroll_Initialize(14)) for them.
     *
     * `tips` are the continue screen's tip cards: the cell tables
     * conti_mes_select picks from, continue_tips_japan through dword_AEE88,
     * one after another. MES_CONTINUE_INT loads CG 83
     * (_Scroll_Initialize(166)) for them.
     *
     * `names` are NAME_CELL_AND_CG_JPN and _USA, the name plates sel_disp_init
     * and the versus screen draw: a record of 8 bytes, 2x the CG for
     * _Scroll_Initialize2 and then the cell. The cell after each one is its
     * greyscale twin, on the CG after.
     *
     * `screens` are cells the game draws right after the screen loads a CG,
     * read off the calls: sel_disp_init and select_init
     * (CG 7), name_entry (2), prep_adv_movie and adv_movie_cont (71, 5, 87, 88,
     * 89), bossm_init (86), MES_ROUND_INT and sub_7B380 (35),
     * MES_CONTINUE_INT (83), the versus screen's results (24) and the logos
     * before the attract (3, 25). 59, 125-128 and 201 are from the owner's
     * check against the game (1, 9, 22).
     *
     * `unused` are the cells nothing in the program draws (js/cells.js
     * unusedCells). Every draw routine takes its cell by number: from an
     * `lda`/`mov` (traced back through the branches that reach the call),
     * from a table (the cards, portraits, tips, name plates, staff credits,
     * barrier, timer and win-star animations, stage cards, movie script,
     * big digits), as a font (0, 13 and the HUD's digit cells) or as an
     * absolute pointer into the pattern table (121, 308). What is left
     * includes the odd-numbered cards, a "50% Version for AOU Show" and a
     * "Location Test Version" notice (228, 349), four control-method menus,
     * K.O. (the game writes it in polygons), the ROBOEGG and ROCKET METAL
     * silhouettes and the staff roll's text. Cells only the dead
     * adv_movie_cont_fv (a Fighting Vipers leftover) or the debug viewer
     * would draw count as unused; an attract run in MAME drew nothing
     * outside the used set. */
    cells: {
        cgTable: 0x06480000, patternTable: 0x06480300, charBytes: 0x80000,
        cards: {
            count: 26,
            tables: [
                [0x0007d9b4, 0x0007da84], [0x0007da1c, 0x0007daec],
                [0x0007d9e8, 0x0007dab8], [0x0007da50, 0x0007db20],
            ],
        },
        portraits: { list: 0x000daf3c, count: 12, frames: 7, cg: 7 },
        tips: { list: 0x000aec78, count: 156, cg: 83 },
        names: { tables: [0x000f1e34, 0x000f1fd4], count: 30 },
        screens: [
            { cg: 7, cells: [113, 114, 115, 116, 309, 310, 311, 312, 313, 314, 315, 316, 318, 332, 352] },
            { cg: 2, cells: [77] },
            { cg: 71, cells: [390, 405] },
            { cg: 5, cells: [353, 354, 355, 357, 358, 359, 360, 361, 367, 368, 370, 371, 372, 373, 386, 387] },
            { cg: 87, cells: [513] }, { cg: 88, cells: [517, 518] }, { cg: 89, cells: [525] },
            { cg: 86, cells: [501, 502, 515] },
            { cg: 35, cells: [220, 342, 382] },
            { cg: 83, cells: [437, 439, 440, 441, 496] },
            { cg: 24, cells: [154, 155, 156, 168, 169, 171, 172, 174] },
            { cg: 3, cells: [88] }, { cg: 25, cells: [175] },
            { cg: 1, cells: [59] }, { cg: 9, cells: [125, 126, 127, 128] }, { cg: 22, cells: [201] },
        ],
        unused: SFIGHT_UNUSED_CELLS,
    },
    /* What the viewer knows how to do with this game beyond drawing a model.
     * Stages, rigs and motions are read out of tables this repo has only
     * located for Sonic The Fighters. */
    /* skyEye: the Stages tab reads the camera out as the game's own record
     * (js/skyeye.js), the one both builds of the game keep. */
    features: { stages: true, characters: true, motions: true, cells: true, skyEye: true },
};

/* ---- Sonic Championship -------------------------------------------------- */

/*
 * The `schamp` set: the export build, and MAME's parent of `sfight`. Its mask
 * ROMs are sfight's, chip for chip, so the models, the textures, the palette
 * and the copro tables are the same bytes. What it has of its own is the
 * program pair (epr-19141/19142) and the XTRA_DATA pair (epr-19143/19144).
 *
 * The program is sfight's program with code put in or taken out in a few
 * places, so everything after such a place sits a little further on. Matched
 * 16 bytes at a time, the two ROMs line up in the runs below: from each
 * sfight address, this far later in schamp, up to the next. Everything the
 * viewer reads out of the program ROM falls inside a run, well clear of an
 * edge — the routines, the frame tables, the stage records and the tables at
 * 0xC0000 and on (+0x138). Pointers held in those tables are read out of this
 * ROM, so they come out schamp's own; only the addresses the viewer itself
 * names go through `relocate`.
 *
 * Its XTRA_DATA is the English text: cells 441 to 529 are drawn again in it
 * and CGs 81 to 91 are new lists, and it has nine cells and two CGs sfight
 * does not — 535 to 543, CGs 90 and 91. The cells tab reads them out of the
 * pattern and CG tables, which run to their own ends, so nothing names them.
 */
const SCHAMP_RELOCATION = [
    [0x00000, 0x000], [0x036a0, 0x008], [0x03c50, 0x000], [0x08c50, 0x00c],
    [0x099f0, 0x02c], [0x52720, 0x034], [0x53250, 0x03c], [0x554f0, 0x044],
    [0x561d0, 0x05c], [0x562d0, 0x074], [0x56890, 0x08c], [0x7b340, 0x094],
    [0x7b460, 0x0ac], [0x7b5d0, 0x0c4], [0x7b6c0, 0x0dc], [0x7ce80, 0x0e4],
    [0x7d4f0, 0x108], [0x7d610, 0x13c], [0x8e3d0, 0x138],
];

/**
 * Where a build keeps what sfight keeps at `addr` in the program ROM: `addr`
 * itself for every game without a `relocation` table.
 */
export function relocate(game, addr) {
    const runs = game.relocation;
    if (!runs) return addr;
    let delta = 0;
    for (const [from, d] of runs) {
        if (addr < from) break;
        delta = d;
    }
    return addr + delta;
}

/** The other way: the sfight address of what this build keeps at `addr`. */
export function unrelocate(game, addr) {
    const runs = game.relocation;
    if (!runs) return addr;
    let delta = 0;
    for (const [from, d] of runs) {
        if (addr < from + d) break;
        delta = d;
    }
    return addr - delta;
}

const schampAt = (addr) => relocate({ relocation: SCHAMP_RELOCATION }, addr);

const schamp = {
    ...sfight,
    id: 'schamp',
    name: 'Sonic Championship',
    identify: ['epr-19141.15', 'epr-19142.16'],
    relocation: SCHAMP_RELOCATION,
    regions: {
        ...sfight.regions,
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19141.15', 0xb942ef21, 'epr-19142.16', 0x2d54bd76]],
        },
        mainData: {
            ...sfight.regions.mainData,
            parts: [
                ...sfight.regions.mainData.parts.slice(0, 2),
                [0x1000000, 'epr-19143.7', 0xf97176fd, 'epr-19144.8', 0xd040202a],
            ],
        },
    },
    texture: { ...sfight.texture, pageTable: schampAt(sfight.texture.pageTable) },
    stageTable: {
        ...sfight.stageTable,
        at: schampAt(sfight.stageTable.at),
        materials: { ...sfight.stageTable.materials, ptrs: schampAt(sfight.stageTable.materials.ptrs) },
    },
    sound: { ...sfight.sound, stageMusic: schampAt(sfight.sound.stageMusic) },
    cells: {
        ...sfight.cells,
        cards: {
            ...sfight.cells.cards,
            tables: sfight.cells.cards.tables.map((t) => t.map(schampAt)),
        },
        portraits: { ...sfight.cells.portraits, list: schampAt(sfight.cells.portraits.list) },
        tips: { ...sfight.cells.tips, list: schampAt(sfight.cells.tips.list) },
        names: { ...sfight.cells.names, tables: sfight.cells.names.tables.map(schampAt) },
        /* The same, and two of its own nine: a Fighting Vipers logo (535)
         * and a Sonic The Fighters title with the SEGA mark (536). The rest
         * are the English titles the export build draws in place of
         * sfight's: 537, 538, 539, 541 and 542 from an `lda` beside the
         * Japanese one, the staff roll's 540 from a second table, and
         * ROBOTNIK (543) in player_names_usa. */
        unused: [...SFIGHT_UNUSED_CELLS, 535, 536],
    },
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
const FV_NAMES = [
    'Jane', 'Grace', 'Honey', 'Tokio', 'Bahn', 'Picky', 'Raxel', 'Sanman', 'Mahler', 'B.M.',
    'Sonic', 'Dummy (11)', 'Dummy (12)',
];
/* Player 2's records are the fighters' own names with (P2), but for Sonic's:
 * record 23 draws Tails. */
FV_NAMES[23] = 'Tails (Sonic, P2)';

const fvipers = {
    id: 'fvipers',
    name: 'Fighting Vipers',
    identify: ['epr-18606d.15', 'epr-18607d.16'],
    /* The test menu's COUNTRY (backup +0x3350), which picks a few signs and
     * the trucks' cabs (js/fvobjects.js kanbanDsp): the panel's Region.
     * sram_clear sets 0. */
    countries: ['Japan', 'USA', 'Export'],
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
    /* Texture RAM is not copied from data here: at boot 0x12154 fills five
     * 0x1000-word blocks (0x800000, 0x801000 .. 0x804000), each with one
     * four-halfword material header over and over, read from the program ROM
     * at 0x12240, eight bytes a block. A pointer into a block gives every face
     * that header; the fighters' hit flash draws with two of them
     * (js/vf2fighters.js, flashMaterial). */
    modelTable: {
        offset: 0x000e0004, count: 5413, stride: 16,
        textureRamFill: { headers: 0x12240, blocks: 5, words: 0x1000 },
    },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: 0x00100000,
    /* The stage setup (0x21664) stores the stage record's u16 at +0x16 over
     * entry 247, the colour of the fighters' shadow cards (models 0xE4 to
     * 0xF2, the only ones that name it). Every one of the sixteen records
     * holds black there, and MAME's palette RAM has it black from frame 600
     * on, the one entry that differs from the table; the table's own 0x9970 drew the shadows brown. */
    paletteFixes: [[247, 0x8000]],
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
         * characters 0-10; 11 and 12 have 0 and no textured part. Records
         * 13-25 are the same fighters as player 2 wears them (js/vf2fighters.js
         * readFighter), Honey's on set 81 and Picky's on 87. */
        fighters: { records: 0x640d2b0, count: 26, parts: 0x00, partCount: 16, set: 0x20 },
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
        /*
         * The names, by slot. The sound test lists the stage songs at
         * 0x68EAB8x in slot order — western, factory, ufo_diner, airport,
         * western2, bay_side, elevator, observation_deck, tower — and the ROM
         * agrees wherever else it names a stage: the stage-sound table at
         * 0x6425680 (sqo_western, sqo_factory, sqo_ufo, sqo_airport by
         * stage_num), the object lists (ufo_int on slot 2), and the debug
         * menu's FACTORY, WESTERN, AIRPORT and CUTYHALL, which go by the
         * record's stage_NUM (1, 2, 3 and 4 on slots 1, 0, 3 and 6). Slots 9
         * to 11 are the airport's record again with no objects, and 13 is the
         * name entry (stage_NUM 99). 12, 14 and 15 are not named anywhere.
         */
        names: {
            0: 'Western', 1: 'Factory', 2: 'UFO Diner', 3: 'Airport', 4: 'Western 2',
            5: 'Bay Side', 6: 'City Hall Elevator', 7: 'Observation Deck', 8: 'Tower',
            9: 'Airport (copy)', 10: 'Airport (copy)', 11: 'Airport (copy)', 13: 'Name Entry',
        },
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
     * What it does have is lettering 0.002 in front of its sign, shadows and
     * stains laid on the ground in its own plane, and plates of one layer
     * overlapping each other. The near plane alone held the lettering close
     * up and lost it across the arena, and on a phone's depth buffer sooner;
     * `layers` puts each such face over the one under it the way the board's
     * sort does (js/layers.js), whatever the distance.
     */
    depth: { recede: 0, nearMin: 0.1, layers: true },
    scenes: null,
    /*
     * The fighters, on Virtua Fighter 2's rig: calc_rob_angle (0x2AA84) is
     * VF2's 0x27CE0 instruction for instruction once the addresses are taken
     * out, calc_unit_1 (0x2BBE0) its 0x2901C, and calc_unit_mat (0x17160) its
     * draw placement, stepping each part out along the fighter's own skeleton
     * (player +0x8C). So js/vf2fighters.js poses them, on this game's tables.
     *
     * `motionTable` is offset_list_motions, `ld 0x6C00004[g0*4]` in
     * set_mot_dat (0x1B880), calc_rob_angle_int and get_kamae_value: in the
     * second bank, the XTRA window's high half. Entry 0 points at the table's
     * end, 1055 entries on; every one of the other 1054 is a block of
     * Sonic The Fighters' format, in the data ROM or the second bank.
     *
     * `standardRig` is the table calc_rob_angle_cont hands op 0x6B
     * (`lda 0x2C194, g6`). The records are `ld 0x640D2B0[char*4]` in
     * action_init (0x1243C), with the parts at +0 and the skeleton at +4 as in
     * VF2, but the texture set at +0x20.
     *
     * The roster is in the order of the profile cards in the data ROM at
     * 0x3023A1C — JANE, GRACE, HONEY, TOKIO, BAHN, PICKY, RAXEL, SANMAN,
     * MAHLER, B.M. — which the records bear out: their +0x1C (72, 55, 40, 69,
     * 85, 48, 54, 120, 95, 95) runs with the cards' weights, Picky's hair is
     * drawn for character 5 (pky_kami_disp), and Mahler and B.M. share texture
     * set 17. 10 is Sonic, on a set of its own (93) and drawn at 0.56 of his
     * motions' height; the card after B.M.'s is SONIC & TAILS, and the
     * models are plainly him. 11 and 12 have no card: one set of untextured
     * stand-in parts on Honey's and Jane's skeletons. Records 13-25 are the
     * thirteen again in player 2's colours (`p2`): 0xA0A8 adds 13 to player
     * 2's number when both pick the same fighter. Some are other models too,
     * Jane's in jeans for the fatigues; Mahler's is his first record again,
     * so only his colours change.
     *
     * The crouch is adj_taikaku (0x2BF4C), VF2's 0x29414 with other
     * constants: character 9, B.M., stands at 1.1 and 10, Sonic, at 0.56.
     *
     * The table's end, where entry 0 points (0x6C01080), is the motions'
     * names: 1055 more pointers, one per id, into the data ROM (0x2E421CC on)
     * and the second bank (0x6C95438 on).
     */
    motionTable: { list: 0x06c00004, count: 1055, names: true },
    /*
     * The sway chains (js/osage.js), Sonic The Fighters' records and code on
     * this game's data. The definitions by record, `0x63E34[+0x1B0*4]` at
     * 0x627E8, 26 of them before the empty table at 0x63E9C. Grace's switched
     * on her upper armour every frame (0x62860). Gravity as 0x7284 stores it.
     * The wind (0x63B80): each record's two entries at 0x63A58, and the
     * stages it blows on, by 0x500064, with the direction and which entry
     * (the second where flag 10 is clear). The head is slot 2.
     */
    osage: {
        table: 0x00063e34, count: 26, gravity: 0.005222222302109003, head: 2,
        byArmour: { char: 1, broken: 0x00063fcc, whole: 0x00064154 },
        wind: {
            table: 0x00063a58,
            stages: {
                0: { angle: 0xf000, entry: 0 }, 1: { angle: 0x8000, entry: 1 },
                4: { angle: 0xf000, entry: 0 }, 5: { angle: 0xc000, entry: 1 },
                8: { angle: 0x7000, entry: 0 },
            },
        },
    },
    /*
     * The sound board is Sonic The Fighters', the ROMs laid out the same way
     * and the same three boot commands (0x8574, 0x8B9C, 0x8BAC). FIGHT_INT
     * sends the stage's song in round 1 (0xD5B4) out of level_music_list at
     * XTRA 0x6425E14, by stage_num & 15: AE1005-AE100D for slots 0-8, then 0.
     *
     * `ambience` is sound_queue_output's (0x420B4), js/sound/ambience.js: a
     * 16-byte record a stage, the loop the match starts with at +0, and a
     * player, picked through the jump table at 0x6425680, that plays the
     * stage objects' cues on their clock.
     */
    sound: {
        program: ['epr-18628.31', 0xaa7dd79f],
        samples: [
            ['mpr-18629.32', 0x5d0006cc], ['mpr-18630.33', 0x9d405615],
            ['mpr-18631.34', 0x9dae5b45], ['mpr-18632.35', 0x39da6805],
        ],
        stageMusic: 0x1025e14,
        stageMusicRegion: 'mainData',
        ambience: { kind: 'fv', table: 0x1025e5c, stride: 16, count: 12, players: 0x1025680 },
    },
    rig: {
        kind: 'vf2',
        standardRig: 0x2c194,
        fighters: {
            records: 0x0640d2b0, count: 13, p2: 13, names: FV_NAMES, texSet: 0x20,
            /* The action table, record +0x14, and the input programs by
             * character (0x1EBE0, the matcher's opcodes at 0x1EC34);
             * js/vf2fighters.js, fighterMotionList. `handover` is the
             * mot_list table set_mot_dat reads (0x1B880), for the motions
             * one hands over to as it ends. */
            actions: { at: 0x14, count: 55 }, commands: { table: 0x0001ebe0 },
            handover: { table: 0x06411e94, head: 12 },
            /* The intro, win, time-up and attract showcase poses; readPoses. */
            poses: {
                intro: 0x0641f81e, wins: 0x0641f78a, timeUp: 0x0641f7f2, count: 11,
                showcase: [
                    [0x06ce759e, 0x06ce767a], [0x06ce7466, 0x06ce7546], [0x06ce7826, 0x06ce7902],
                    [0x06ce76ca, 0x06ce77a6], [0x06ce7a36, 0x06ce7b12], [0x06ce795a, 0x06ce7996],
                ],
            },
            /* The break table (0x640EDAC), mune_unit_change's chests
             * (0x6421F80) and koshi_unit_change's hips (0x6422400);
             * js/vf2fighters.js, readArmour, readHips. The shoulder pads
             * (kata_pat_disp's 0x642147C) and the skirt (kosi_mino_disp's
             * 0x6421DE0, drawn for the characters it compares against;
             * 14 is past the roster); readPads, readSkirt. koshi_unit_change's
             * hips (0x6422400) for the win streak's hips; readHips. Picky's
             * hair, pky_kami_disp's, for the characters rob_disp names (18 is
             * his P2 record); its models are immediates, HAIR_PIECES. */
            armour: {
                table: 0x0640edac, chest: 0x06421f80, rest: 15, hips: 0x06422400,
                pads: 0x0642147c, skirt: { table: 0x06421de0, chars: [0, 1, 13, 14] }, hair: [5, 18],
                /* set_mot_dat's setup scripts, 0x6411E94[motion]: the move
                 * flags (+0x1A4) the chest's per-frame list is gated on;
                 * js/vf2fighters.js, moveFlags. */
                setups: 0x06411e94,
                /* A jump's flight, for the hips in the air: g, which the boot
                 * leaves at 0x50A000 (0x7284), and rob_disp's runs a frame;
                 * js/vf2fighters.js, flightClocks. */
                flight: { gravity: 0x3bab1f2d, draws: 2 },
                /* The flying pieces: 0x2D614's outward and upward speeds by
                 * attack kind, its sixteen headings and speed jitters, and
                 * 0x2D390's sixteen spins; js/fvdebris.js. `flipbook` is
                 * 0x2D254's effect, 54 models a record (+0x1B0). `gates`
                 * are the stage flags 0x76A70 tests for their floor
                 * shadows (0x78384). `bodies` is the program ROM's order
                 * of the body balls (0x292AC) the push out of the fighters'
                 * bodies (0x2CEA0) tests; the balls are the shadows'. */
                debris: {
                    out: 0x064216d0, rise: 0x064216e8, heading: 0x06421700, jitter: 0x06421720, spin: 0x0640f924,
                    flipbook: 0x06421760, gates: 0x06442ba8, bodies: 0x000292ac,
                },
            },
            /* The midriff, record +0x24, and the one a broken chest draws
             * with (rob_disp, 0x1A2D8); js/vf2fighters.js, readMidriff. */
            midriff: { at: 0x24, broken: 0x0642f9ec },
            /* The motions' setup scripts, set_mot_dat's 0x6411E94[motion]:
             * their first two words become the move flags (+0x1A4) and
             * +0x720, which every draw of the fighter tests for the flash
             * (js/vf2fighters.js, flashMaterial). */
            flash: { setups: 0x06411e94 },
            /* rob_disp's part loop (0x1A02C) draws a part model from `from`
             * to `to` with material `material` when it does not flash: Jane
             * player 2's broken chest and its bounce, which take model
             * 0x62D's material over their own. */
            recolour: { from: 0x62e, to: 0x64c, material: 0x68cbc },
            /* Move-script op 18's hand models, 0x640EBF4[record]: four a
             * hand; js/fighterhands.js. */
            hands: { table: 0x0640ebf4 },
            /* Move-script op 16's heads (0x2DDB0), 0x640D31C[op][record]:
             * a pair of s16 models, of which the explorer reads the first
             * (the second is the broken helmet's); js/fighterhands.js. */
            face: { op: 16, table: 0x0640d31c },
        },
        /* What the one hit plays; js/reactions.js. set_mot_dat's setups
         * past their 12-byte head, the lengths at 0x1CE86; op 4 (sub_1BB20)
         * keeps the kind at +7, and the picker (0x26978) reads
         * 0x641F834[kind], 22 kinds. */
        reactions: { setups: 0x06411e94, head: 12, lengths: 0x1ce86, ops: 25, strike: 7, table: 0x0641f834, kinds: 22 },
        /* The move script's op lengths, by the handlers 0x1C24C runs
         * (table 0x1D028); js/fighterhands.js. */
        script: [0, 3, 3, 13, 7, 4, 4, 4, 4, 4, 9, 7, 4, 4, 7, 3, 4, 4, 7, 5, 4, 4, 5, 6, 12, 4, 4, 4, 6, 3, 4],
        /* Script op 28's trails; js/fvtrails.js. 0x7C178's tables by life:
         * the feet's models by stage (0x500064) and sizes, the hands', the
         * floor puff's, and the waist's models (one set for every stage). */
        trails: {
            op: 28,
            feet: { models: 0x064445f0, sizes: 0x06444690 },
            hands: { models: 0x06444430, sizes: 0x06444490 },
            floor: { models: 0x06444520, sizes: 0x064445c0 },
            waist: 0x064446c0,
        },
        /* Script op 30's throw spark; js/fvhitspark.js. 0x2DB78's flipbooks
         * for a record with flag bit 8: +0x1E's by age, +0x20's by half. */
        hitSpark: { op: 30, books: [{ at: 0x064212b4 }, { at: 0x064211e0, halved: true }] },
        /* 0x21E40's burst; js/fvburst.js. Frames 0..15 of the u16 table
         * name the models, drawn at 0.5 while +0x720 has `lightBit` or
         * +0x1A4 has bit `flag`. */
        burst: { table: 0x06ce35e4, last: 15, scale: 0.5, lightBit: 10, flag: 26 },
        /* The carried item rob_disp draws (0x1A4B4); js/fvitem.js. Fighter
         * record +0x2C's item records, `size` bytes each with the mirrored
         * one `mirror` in, script op 17's byte picks one; `ring` copies. */
        carried: { op: 17, records: 0x2c, size: 0x70, mirror: 0x38, ring: 4 },
        /* Each fighter's own light (0x1F1FC); js/fvstrobe.js. +0x720 starts
         * as the setup's second word (0x1B98C); script ops 25 and 26 set and
         * clear a bit of it, op 27 sets bit 3 or clears it. While it has
         * `bits`, or +0x1A4 has bit `flag`, the light strobes. */
        strobe: {
            set: 25, clear: 26, bit3: 27, bits: 0x420, flag: 26,
            /* The scale by record (+0x1B0) where it is not 1.0, by stage
             * (0x500064), as the scene's start (0x21614, 0x21794) writes
             * 0x50A0E0, in the board's single-precision bits. */
            stages: {
                2: { 17: 0x3f0f5c29, 18: 0x3ef0a3d7 },
                9: {
                    1: 0x3f0a3d71, 2: 0x3f0a3d71, 4: 0x3f6b851f, 6: 0x3f5eb852, 8: 0x3f028f5c,
                    14: 0x3f0a3d71, 15: 0x3f0a3d71, 17: 0x3f07ae14, 18: 0x3f28f5c3, 19: 0x3f11eb85,
                    21: 0x3f028f5c,
                },
            },
        },
        /* The floor shadows (js/fightershadow.js): 0x60640's tables by
         * +0x1B0; the balls the boot (0x1950) copies to 0x506000 and the
         * coprocessor tests each slot's first of; the light VECTER_X/Y,
         * copied from the stage record (0x5FA08); the ring 5 (0xB658) and
         * the ground by stage (0x248FC). The stage flags (0x6442BA8) can
         * stop them, 0x60B98 makes the test round, and 0x5FA6C lights them
         * from four lamps 0x60620 at heights 0x6CE35A4 (0x60468). */
        shadow: {
            tables: 0x60bc8, count: 26, by: 'record', ring: 5, grounds: 0x06ce3564,
            leave: { x: 1, z: 2 }, skip: { slot: 9, flags: (1 << 14) | (1 << 16) },
            balls: { counts: 0x0640e914, lists: 0x0640e89c, inline: 8, points: 0x0640e4fc, first: true },
            stages: { at: 0x06ce1048, stride: 256, light: 0x08 },
            gates: 0x06442ba8, round: 0x60b98,
            lamps: { stages: 0x5fa6c, at: 0x60620, heights: 0x06ce35a4 },
            /* The flying armour pieces' shadows, 0x608B8 and 0x609B0, which
             * 0x602F0 goes on to unless the stage has flag bit 9. */
            pieces: true,
        },
        /* The wall shadows (js/fvwallshadow.js): rob_kabe_kage_disp
         * (0x76944) under stage flag bit 31, the tables by +0x1B0, each
         * slot's height (0x6443EDC) over the stage's top (0x6CE35A4,
         * 0x248FC). */
        wallShadow: { tables: 0x06442c68, count: 26, heights: 0x06443edc, tops: 0x06ce35a4, gates: 0x06442ba8 },
        crouch: { 9: 1.1, 10: 0.56 },
        /* The move flags (+0x1A4) as the motion sets them; js/vf2fighters.js,
         * moveFlags. 0x1C180 drops bits 26, 16 and 8 at the second of setup
         * op 2's frames; script op 13 sets or clears bit 25. */
        flags: { drop: 0x4010100, op13: 25 },
        /* The head looks at the other fighter only while +0x1A4 has none of
         * 0x6C119 (0x2B2FC), else it follows the motion's target, stepping
         * as far again (`own`). */
        look: { own: 0x2000, gate: 0x6c119 },
        /* Which ways a switch blends (js/vf2fighters.js, blendMode): the
         * setup record's byte +10 (+0x814) and u32 +4 (+0x860), 0x29F50;
         * setup word bit 18 blends both ways, 19 in only, and +0x1A4 bit 26
         * both ways where 0x6600 would have it in only. */
        blendIn: { stance: 10, held: 4, both: 1 << 18, inOnly: 1 << 19, flagsBoth: 1 << 26 },
        /* The five stance poses a blend out goes to, by action table slot
         * (0x29EEC). */
        blendOut: [0, 1, 8, 12, 42],
        note: 'fv',
    },
    /* The Cells tab (js/cells.js): the tables stageTable.scroll reads the sky
     * from. dsp_pattern (0x6744) loads off_6450300[g0] and _ScrollCG_Initialize
     * (0x2934C) off_6450000[g0], neither with a bound, so the CGs run up to
     * the pattern table and the cells to its terminating zero, 473 of them.
     * The halfword at 0x02 of a record would pick byte entries where it is 0
     * (0x677C); none is. Cell 22's pointer, 0x2A32EF0, leads to no record. */
    cells: {
        cgTable: 0x06450000, patternTable: 0x06450300, charBytes: 0x100000,
        cgEntries: 0xc0,
    },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
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
     * The table is two copies of 5049 entries. Empty entries split each half
     * into eight banks: the enemies and effects every chapter shares, then a
     * set per part of the game.
     *
     * The game reads only the first copy. The second has the same meshes, and
     * its uv and material pointers are the first's with everything at word
     * 0x400000 or above moved down by 0x200000, as if the second texture pair
     * began at byte 0x400000 and not 0x800000: the table relocated for
     * texture chips half the size. On these chips that lands in the first
     * pair's upper half, which holds bank 7's records and then erased flash,
     * so banks 3 to 7 of the second copy draw in junk colours with junk header
     * bits (the microtexture bit on 46% of their faces, against under 1% in
     * the first copy). Nothing reaches it: every `lda 0x2C5D1F0[...*16]`
     * indexes by the model number, no code adds 5049, and a MAME read tap on
     * the second copy saw nothing in ten minutes of attract or ten of Chapter
     * 2. Green blood is not it either: the game swaps single models for that
     * (0x593 or 0x594 at 0x486A8, by the byte at 0x51E49E).
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
     * The moon is not part of this. It is a flat quad, PN_moonc, that a
     * spawn of class 0x13 turns to the camera (`objects.facing` below).
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
        /* The same two second models, drawn by 0x30670 after the prop's own
         * (0x30C74): PN_sara_dai00a (0x126C) on type 11, and on type 26, while
         * +0x314 is 0 (the chest unbroken), PN_takara_box01a (0xC7A) moved
         * (0, 3.5, 2). The routine also draws 0x126C on any prop whose +0x6C
         * is 12, and no prop the scripts spawn has that; and 0x114A at twice
         * the size over type 73, the extra plate, which stays out. */
        seconds: { 11: { model: 0x126c }, 26: { model: 0xc7a, at: [0, 3.5, 2] } },
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
        /* Type 14's fish, on 0x312B0: the finished game's 0x3B550
         * instruction for instruction, with t at +0x2F4, the segment at
         * +0x2F0, the same six points at 0x85900, and PN_jinmengyo_01
         * (0x121E, the type's own model) plus +0x50 rem 40, drawn through
         * 0x35AD0. It closes as a prop does (0x33320). */
        swimmers: [{ handler: 0x312b0, points: 0x85900, segments: 4, step: 0.01, models: 40 }],
        /* Type 69, PN_powa00a to 29a on 0x32F30: the finished game's 0x3D860
         * at the prototype's models (0x935, back to it past 0x950), drawn
         * through 0x35AD0. It never calls 0x33320; it closes once the camera
         * frame (0x51E788) passes +0x2F4, which the generic init (0x2EDD8)
         * sets by section: `until` (see propZones in js/placements.js). */
        cycles: [{ handler: 0x32f30, last: 0x951, until: { 3: 99, 9: 268, 11: 1048, 12: 1048 } }],
        /* Type 77, PN_r2_05_kabe01a on 0x33000: the finished game's 0x3D930
         * on the camera frame (0x51E788). Past 458 it takes
         * PN_r2_05_kabe_dam01a (0x113F) and throws its pieces (0x30460), left
         * out; past 723 it closes (0x10D60), never calling 0x33320. */
        clocked: { handler: 0x33000, until: 723 },
        /* Type 68, PN_furukagi00a on 0x32E80: counts +0x50 a frame from its
         * spawn and closes (0x10D60) past 190, never calling 0x33320. Its
         * swing (+0x34, kicked only past camera frame 593) starts on its
         * 137th frame, with the camera held at 595; left out. */
        plain: [{ handler: 0x32e80, types: [68], frames: 190 },
            /* Types 78 and 79, the halves of a door (PN_r2do_01a and 01b), on
             * 0x33130: they draw through 0x35AD0 and never close until the
             * byte 0x51E50E is set, which only enemies' own routines (0x57B90,
             * 0x57FC0, 0x3A6FC) do; then they fly off and close below y -35.
             * The explorer opens no enemy, so they stand (`stays`). */
            { handler: 0x33130, types: [78, 79], stays: true }],
        /* Class 0x8A's task, 0x2FDD0: the finished game's 0x39830 on the
         * prototype's table, 0x81448 (see standTable in js/placements.js). */
        tables: [{ init: 0x2fdd0, at: 0x81448, block: 0x16c, lift: 0x2c }],
        /* Class 0x93's task, 0x2FA20, which stands a group about its own
         * place out of a table it picks by chapter: 0x85E10 in chapter 0,
         * where all but types 3 and 4 get window row 26, and 0x866F0 in
         * chapter 1 (see standGroup in js/placements.js). */
        groups: [{ init: 0x2fa20, chapters: [{ at: 0x85e10, count: 15, window: 26, keep: [3, 4] },
            { at: 0x866f0, count: 12 }] }],
        /* Class 0x94's task, 0x2F3B0, which stands four models at the places
         * of 0x85B00 on 0x32110: three gears turning their third angle and
         * the water looping 0x820 to 0x83D (see standFixed in
         * js/placements.js). */
        fixed: [{ init: 0x2f3b0, at: 0x85b00, count: 4, first: 0x820, last: 0x83d,
            spins: { 0x83e: 0x80, 0x83f: 0x80, 0x840: -0x80 } }],
        /* Class 0x13's task, 0x27D70, which turns PN_moonc to the camera
         * at five times its size (see standFacing in js/placements.js). */
        facing: [{ init: 0x27d70, model: 0x13a2, scale: 5 }],
    },
    /*
     * The prototype's own sound program and samples: a driver of its own
     * (`sndpgm0.31`) and four 2 MB sample chips, on the same Model 2 board.
     * The i960 side is the finished game's, at other addresses: 0x11160 queues
     * a word (while the mode word 0x51F218 is 4 or flag 0x51E49C is set),
     * 0x11210 writes it to the UART at once, and the stage scripts' opcode 90
     * (0x51260, entry 90 of the table at 0x94550) queues the word after it.
     * So js/placements.js reads the songs as it does for the finished game:
     * 0xA01001 for chapter 1, 0xA01002 for chapter 2.
     *
     * The boot (0x10FDC) sends A00001. Every scene change MAME showed in play
     * queues A00002 and then the effect A01356 (0xAF00), so A00002 is the stop.
     * (0x1B50C and 0x51590 send A00003 before it; MAME never reached them.)
     * MAME, a coined game: the title A01000 after the coin, chapter 1's A01001
     * as its first section starts, 54 s in.
     */
    sound: {
        program: ['sndpgm0.31', 0x30accd2e],
        samples: [['sound1.32', 0xe0a8dd56], ['sound2.33', 0xa517834f],
            ['sound3.34', 0xf0c529bb], ['sound4.35', 0x3ad48d53]],
        boot: [0xA0, 0x00, 0x01],
        stop: [0xA0, 0x00, 0x02],
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
                spider: 34, samson: 35, sophie: 39, devilon: 59, devilonM: 64, devilonX: null,
                moody: null, moodyB: null, moodyC: null,
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
                sophieRun: 1469, devilonWing: 4814, devilonMWing: 1886, devilonXWing: null,
                moodyCape: null, moodyBCape: null, moodyCCape: null,
            },
        },
    },
    /* The 2D pictures (js/cells.js): hotdo's table a year early, 341 of them
     * at 0x7EFC0, read by the same routines at other addresses (the draw
     * 0x13160, the loads 0x12E94, 0x12FE8 and 0x13088). Floats end it, as
     * they end hotdo's. */
    cells: { pictures: { table: 0x7efc0, count: 341 }, charBytes: 0x80000, programAt0: true, colorxlat: true },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
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
     * a copy relocated for smaller texture chips that it never reads. Nothing
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
        /* The second model the shared handler's draw (0x3A800) adds, on the
         * prop's own matrix, for two types: type 11's plate stands on
         * PN_sara_dai00a (0x13A0), and type 26's chest takes its lid,
         * PN_takara_box01a (0xD0D), moved (0, 3.5, 2). Nothing gates either
         * (see seconds in js/placements.js). */
        seconds: { 11: { model: 0x13a0 }, 26: { model: 0xd0d, at: [0, 3.5, 2] } },
        /* Room 4's walls and shutters, types 97 to 101 on one handler; the
         * first turns 0x80 a frame (see spawnProps in js/placements.js). */
        room4: { handler: 0x3e510, first: 97, spin: 0x80 },
        /* The glass cases and the roof pieces, types 30, 31 and 86, which
         * stand as props until they break (see spawnProps). */
        cases: { handler: 0x3b050 },
        /* Type 77, PN_r2_05_kabe01a, which stands as a prop on 0x3D930 until
         * the zone's clock passes 458 (see spawnProps). */
        clocked: { handler: 0x3d930 },
        /* Type 84, PN_niku_001, which stands as a prop on 0x3DE20 until bit 1
         * or 2 of its flags (+0x58) is set (see spawnProps). */
        meat: { handler: 0x3de20 },
        /* The rest of 0x3E180, types 87, 88 and 95, which stand as props;
         * 95 takes PN_sekom02a in section 3 (see spawnProps). And type 121,
         * PN_kikai_b on 0x3EB30, which stands as a prop until a shot; the
         * second pair at a place takes over from the first, so only one is
         * stood there. Type 67, PN_r2_01_futa on 0x3E010, stands the same
         * way until a shot. Type 78 on 0x3DA60 is a door in section 1;
         * anywhere else it closes as a prop does and draws PN_door_n4a in
         * place of its own model, at 0.9, 1.4 and 1 on the three axes. Type
         * 68, PN_furukagi00a on 0x3D6E0, stands as a prop until a shot or
         * the byte 0x51EFB0 swings it. Type 94, PN_r3_01a_mad11a on 0x3E450,
         * stands as a prop until event flag 0x40, which in chapter 3 only an
         * object in play sets. */
        plain: [{ handler: 0x3e180, types: [87, 88] },
            { handler: 0x3e180, types: [95], sections: { 3: 0x16cf } },
            { handler: 0x3eb30, types: [121], onePerPlace: true },
            { handler: 0x3e010, types: [67] },
            { handler: 0x3da60, types: [78], model: 0x165, axes: [0.9, 1.4, 1], door: 1 },
            { handler: 0x3d6e0, types: [68] },
            { handler: 0x3e450, types: [94] }],
        /* Four props that step their model a frame (see spawnProps): type
         * 104 PN_kakaaa01a to 04a, type 108 PN_pushukeke00a to 49a, type 69
         * PN_powa00a to 29a and type 93 PN_eneene00a to 34a, each back to its
         * type's model past `last`. 93 shares 0x3E180 with 87, 88 and 95,
         * which do other things, so only it is taken. */
        cycles: [{ handler: 0x3e8b0, last: 0x185c }, { handler: 0x3e8f0, last: 0x1115 },
            { handler: 0x3d860, last: 0xa22 }, { handler: 0x3e180, last: 0xd7a, types: [93] }],
        /* Type 96, PN_koba01a, which turns its third angle (+0x34) 0x800 a
         * frame on 0x3E4A0 while the zone's clock is short of 1440 (see
         * spawnProps). */
        spinners: [{ handler: 0x3e4a0, axis: 2, rate: 0x800 }],
        /* Type 14, PN_jinmengyo_01 on 0x3B550, a fish that swims the four
         * B-spline segments through the six points at 0xAE7F0, t 0.01 a
         * frame, and steps through 40 models (see spawnProps). */
        swimmers: [{ handler: 0x3b550, points: 0xae7f0, segments: 4, step: 0.01, models: 40 }],
        /* Type 122, whose handler 0x3C5A0 drops one PN_item_life in chapter
         * 4 and closes (see spawnProps); its own entry in the table is
         * empty, so the model, scale and lift are the handler's. Type 123's
         * 0x3C9D0 drops a PN_kinka00a the same way, at y 0.22 (0x51E3C0, 0
         * there, plus 0.22), on its edge, from yaw 0 and turning 0x1000 a
         * frame. */
        items: [{ handler: 0x3c5a0, model: 0x312, scale: 2.2, lift: 2 },
            { handler: 0x3c9d0, model: 0x3b5, scale: 1.4, y: 0.22, tip: 0x4000, yaw: 0,
                spin: 0x1000 }],
        /* Class 131's task, 0x39B50, which stands eight type-51 props in a
         * row, PN_kenita00a to 07a (see standRow in js/placements.js). x and
         * y are its immediates 0x44974AEA and 0xC26C0B43; z is the float at
         * 0xAFBB0 + 4i, less 14 (0x41600000), plus 0x4379BFBE. */
        rows: [{ init: 0x39b50, type: 51, model: 0x149c, step: 2, count: 8,
            x: 1210.341064453125, y: -59.0109977722168, z: 0xafbb0, less: 14, plus: 249.74899291992188 }],
        /* Class 0x8A's task, 0x39830, which stands a room's furniture out of
         * the table at 0xAA378: a block of 0x16C bytes per spawning type, of
         * 28-byte entries (see standTable in js/placements.js). */
        tables: [{ init: 0x39830, at: 0xaa378, block: 0x16c, lift: 0x2c }],
        /* Classes 0x93 and 0x98, 0x394B0 and 0x395B0, which stand fifteen and
         * twelve props about their own place out of 0xAED40 and 0xAF620; the
         * first gives a child with a third turn window row 28 (see standGroup
         * in js/placements.js). */
        groups: [{ init: 0x394b0, at: 0xaed40, count: 15, marked: 28 },
            { init: 0x395b0, at: 0xaf620, count: 12 }],
        /* Class 0x94's task, 0x38F50, which stands four models at the places
         * of 0xAEA30 on 0x3C240: PN_haguuu, 01a and 02a turning their third
         * angle and PN_hagumizu00a to 29a looping (see standFixed in
         * js/placements.js). */
        fixed: [{ init: 0x38f50, at: 0xaea30, count: 4, first: 0x8a8, last: 0x8c5,
            spins: { 0x8c6: 0x80, 0x8c7: 0x80, 0x8c8: -0x80 } }],
        /* Class 0x13's task, 0x2F740, which turns PN_moon22 to the camera
         * at five times its size (see standFacing in js/placements.js). */
        facing: [{ init: 0x2f740, model: 0x14ac, scale: 5 }],
    },
    /* Its rooms are built the same way the prototype's are, large faces with
     * smaller ones laid on them in the same plane, so they want the same
     * ranking and the same absent recede. */
    /*
     * The sound board is the Model 2 board, its UART at 0x01C80000 on the 2C
     * (sends queued at 0x154D0 or 0x15540, sent at once by 0x15590). The
     * samples are two 4 MB chips where the fighting games have four of 2 MB.
     *
     * There is no song table: a chapter's stage scripts start its music with
     * opcode 90, which queues the word after it (js/placements.js), and the
     * explorer plays the song the scripts have started when each stage's
     * first zone is made current — 0xA01001 for chapter 1, 0xA01002 for 2.
     * The boot (0x15344) sends A00001; every scene change (0xD144, 0x15CE0)
     * clears the queue and sends A00002 and BE5000, which is the stop.
     * MAME, a coined game: the title A01000 after the coin, chapter 1's
     * A01001 as its first section starts.
     */
    sound: {
        program: ['epr-19720.31', 0xb367d21d],
        samples: [['mpr-19721.32', 0xf5d8fa9a], ['mpr-19722.34', 0xa56fa539]],
        sampleChip: 0x400000,
        boot: [0xA0, 0x00, 0x01],
        stop: [0xA0, 0x00, 0x02, 0xBE, 0x50, 0x00],
    },
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
         * The wounds a shot part takes (readWounds), read off sub_68010: the
         * joint records it takes the zone and the first count from
         * (`lda 0x1184E0[g4*8]` with g4 = body * 31), the models (`lda
         * 0x11DFF0(g4)[g5]`, body << 9 and zone << 5), the counts after each
         * wound (`ldob 0x129BF0(g4)[g6]`, body << 8) and the one model it
         * never stores (`lda 0x7B0` before `cmpibe g7, g13`). All four are in
         * the second program pair, epr-19694/19695, which Revision A shares.
         */
        wounds: { parts: 0x1184e0, models: 0x11dff0, shots: 0x129bf0, kept: 0x7b0 },
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
         * (0x9CE50; its body switch at 0x9D240 is `0x9D24C[body - 2]`). Its own
         * bodies there: BO_devilonx (69) shares BO_devilon's case (0x9DABC),
         * which takes 0x1401 for body 50 and 0x195F, 6495, PN_devilonx_hane01,
         * for the other. BO_moody (59, 0x9DFD4), BO_moodyb (70, 0x9E000) and
         * BO_moodyc (88, 0x9E018) draw, on their role-2 joint, 0x1618, 0x1895
         * or 0x1A56 plus [0x51EDA0] rem 50 in place of the part's own model:
         * PN_moody_katar_01-50 and the B and C capes. Bodies 92 and 93 reach
         * the same runs but have no role-2 joint, so they draw none. Cases for
         * bodies 48, 60, 64, 76, 78 and 84 have not been read yet.
         */
        callback: {
            bodies: {
                tom: 2, hand: null, gman: null, gmanKihon: 13, haride: 14, staje: 15,
                spider: null, samson: 30, sophie: 34, devilon: 50, devilonM: 55, devilonX: 69,
                moody: 59, moodyB: 70, moodyC: 88,
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
                sophieRun: 1552, devilonWing: 5121, devilonMWing: 1997, devilonXWing: 6495,
                moodyCape: 0x1618, moodyBCape: 0x1895, moodyCCape: 0x1A56,
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
    /* The 2D pictures (js/cells.js): 630 of them at 0xA6580, three pointers
     * each, tiles, colours and map, Dead or Alive's shape. The draw (0x17D80)
     * takes the picture's number, finds the first block of the run 0x17B20
     * gave its slot (0xA9B50, a halfword a picture) and adds it to every
     * entry, so the group is the block; 0x17CB0 and 0x17C10 load each chunk
     * of tiles from a block of its own, with its 16 colours. The table ends
     * where the floats at 0xA8308 start. Colours go through colorxlat. */
    cells: { pictures: { table: 0xa6580, count: 630 }, charBytes: 0x80000, programAt0: true, colorxlat: true },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
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
        /* Room 4's handler moved with the rest, and this build's program
         * chips are not to hand to read where to, so it is left out. */
        room4: null,
        cases: null,
        clocked: null,
        meat: null,
        plain: null,
        cycles: null,
        items: null,
        rows: null,
        tables: null,
        groups: null,
        seconds: null,
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
        /* In the program pair the two revisions share. */
        wounds: hotdo.rig.wounds,
        bodyMotions: hotdo.rig.bodyMotions,
        bodyMotionsLabel: hotdo.rig.bodyMotionsLabel,
    },
    /* Revision A moved its tables, and its picture table has not been found. */
    cells: undefined,
    features: { ...hotdo.features, cells: false },
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
 * Every build carries these same chips but the 1993 one, which has a sound
 * program of its own.
 *
 * `music` is how start_setting (0x3BF0 in the Saturn-ads build) picks the
 * race's song: `ld 0x28050F0[r3*4], g0` and on to the UART, with r3 the
 * course — unless a VR button is held as the race starts, which picks
 * the song itself: VR1 the first, VR3 the second, VR2 the third, VR4 the
 * fourth, which no course has of its own. The table is at data 0x8050F0 in
 * every build here but the 1993 one (program ROM 0x231E70), and says 0xAE1007, 0xAE1009, 0xAE1004,
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
        hint: 'The song the race starts with. The game plays the course\'s own unless a VR button is held as the race starts, which picks one itself — this is that choice',
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
        /* This build's own program pair, which no other Daytona set carries,
         * and their checksums, for a zip that spells the labels otherwise
         * (`daytonas.zip` drops the `ic` from both). */
        identify: [spec.program[1], spec.program[3]],
        identifyCrc: [spec.program[2], spec.program[4]],
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
         * The light is a world light: Revision A keeps it at program 0x232DC4
         * and every frame turns it into camera space through geometry-engine
         * function 0x1A (0x722C) before sending it, as Virtua Cop does at
         * 0x1D0CC. It is not unit length (1.094) and the board lights with it
         * as it is. Z is negated for the decoder's convention, as stageLight
         * does for the other games.
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
         * The tables set_area_block cuts the 5x5 round the camera by:
         * `heading`, the four record pointers its heading cut picks between
         * by quarter turn, `clip`, extra_clip's range table per course, and
         * `order`, the order it walks the cells in, which picks the near set.
         * See courseArea in js/daytona.js.
         */
        area: spec.area ?? null,
        /*
         * The sky, which is not geometry but the tile layer's panorama: 256
         * tiles round the full turn, eight patterns of 32, streamed into the
         * tilemap as the car turns (js/scroll.js, buildCourseSky). `table` is
         * the four-course table change_course_bank indexes by sel_course; the
         * first word of each row is that course's sky. Found by daytona-tables.mjs
         * by the shape of what it points at.
         */
        sky: spec.sky ?? null,
        /* The 2D pictures and their CGs, for the Cells tab — DAYTONA_CELLS. */
        cells: spec.cells ? { ...DAYTONA_CELLS, ...spec.cells } : null,
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
        /* The player's car and the attract mode's recorded runs, for a build
         * whose addresses were found (js/daytonacar.js). */
        rig: spec.car ? { kind: 'daytona', ...spec.car } : null,
        features: { stages: true, characters: false, motions: Boolean(spec.car), bodies: Boolean(spec.car), cells: Boolean(spec.cells) },
    };
}

/*
 * The 2D pictures (js/cells.js): the title, the course and car select, the
 * HUD's dials and lamps, the rankings. The tile chip and the list formats are
 * Sonic The Fighters', and the tables are laid out differently.
 *
 * The draw routine (0x19304 in Revision A; 0x18E2C in 1993, 0x19784 in the
 * Special Edition, 0x197F4 in the Saturn build) takes a record's address and
 * a tilemap address: a halfword added to every entry, a halfword that is 0
 * for byte entries and 1 for halfword ones, the row count, the column count,
 * then the entries row by row onto 0x80-byte tilemap rows. Nothing indexes the
 * records; they lie end to end, from the lowest one any call names to the
 * model table (`records`, a run [first, end) per run), and a cell is its
 * place in that run. Every record a call names directly lands on a record
 * start, in every build. A few records lie elsewhere, each a run of its own
 * after the main one so the numbers before them stay: one or two in the
 * program ROM, through its alias at 0x200000, and in the Saturn build the
 * advert's.
 *
 * Every word of the program and data ROMs was searched for each record's
 * address (js/cells.js unusedCells): a record no word names is one the game
 * never draws, since every call takes its record from an `lda` or from a
 * table of absolute pointers. A search of every halfword for a record header
 * outside the runs finds nothing else. 18 records are unused in every build
 * since Revision A, among them a big 0-9 that 1993 does not have, and 5 in
 * 1993. All but one draw whole on CG 0 or 7. The odd one (64; 23 in 1993) is
 * a 30x4 banner over characters 0xF00-0xF60, which the shipped CG 0 gives to
 * cell 62's "Choose one!" box. Its own tiles are in no CG list and in no run
 * of tile data the lists don't name, so the picture is lost, not swizzled.
 *
 * The CG loader (0x1DD70) takes a CG list, its partner (0x1DDE0) a palette
 * list, and the game hands them both halves of a pair it finds through one
 * of two tables (`cgTables`, [table, count]): the bank at 0x2600000 (the
 * 1993 build's 0x2800000), seven pairs, of which the code loads 0 at boot, 1
 * when a race starts and 5 and 6 on their own, and 0x2700000 (0x2900000),
 * two pairs loaded over the bank's 0 (7) and 1 (8). Before CG 7 the loader
 * puts in one more CG list out of the program ROM (`cgExtra`, by CG number).
 *
 * Bank pairs 2, 3 and 4 are the courses' START YOUR ENGINES pictures, which
 * the race start streams in (0x1DE40) from a table by course (`courses.cgs`)
 * and draws (0x26BF0) from another (`courses.cells`), a record per course;
 * a cell in that table opens on its course's CG. Their colours come from the
 * race start's palette cycle (`courses.flash`), not their palette lists.
 *
 * The tile layer's palette goes through colorxlat as Daytona's sky's does
 * (`colorxlat`), so the cells take the cabinet's colours.
 *
 * CG 0's list (0x2073FC4) also loads 593 leftover tiles, the DaytonaGP
 * art (a purple-to-cyan DAYTONA, a pink streak and a flag), at 0x20A7B08, 0x20A96EC
 * and 0x20A9BF0, to characters 0x1200-0x14CA, and a recoloured copy
 * (0x20AC534) to 0x1800-0x1ACA (`leftover`). CG 7 writes the TRY IT AGAIN
 * text and the DAYTONA USA logos over the same characters, so cells 13, 14
 * and 55, and the small 15-27 (11-14 in 1993), land on these tiles when
 * CG 0 is loaded.
 */
/* The race start's palette cycle, laid out around a build's course picture
 * table: see flashCourse in js/cells.js. */
const courseFlash = (cells) => ({ table: cells - 0x50, also: [[cells + 0x10, 0x01800e80, 2]], step: 9 });

const DAYTONA_CELLS = {
    cgTables: [[0x02600000, 7], [0x02700000, 2]],
    cgNames: ['boot', 'race', 'Three Seven Speedway', 'Dinosaur Canyon', 'Seaside Street Galaxy', null, null, 'over 0', 'over 1'],
    courses: { count: 4, cells: 0x002389ac, cgs: 0x0023899c, flash: courseFlash(0x002389ac) },
    charBytes: 0x80000,
    colorxlat: true,
    leftover: { cg: 0, chars: [[0x1200, 0x14cb], [0x1800, 0x1acb]] },
};

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
 * had, and the Saturn advertisements set is the Special Edition's code with
 * its tables moved on again. The 1993 version writes several routines its own
 * way — see DAYTONA_OBJECTS_93.
 *
 * `shown` names the routines that decide whether to draw other than as
 * SHOWN in js/daytona.js has their kind: the two lights that look at fixed
 * blocks — 0x7A or 0x6A in the area, 0x99 or 0x89 near — and the wall, drawn
 * while the player is between points 520 and 576 (the halfwords at Rev A
 * 0x2207C). Each crowd carries its own (`shown`): the shuttle's points
 * 760-830, the plaza's 149-193.
 */
const DAYTONA_KINDS_A = {
    0x20118: 'static', 0x201bc: 'cycle', 0x202c4: 'ship', 0x20364: 'slot',
    0x20698: 'light', 0x20730: 'light', 0x207c8: 'spinZ', 0x20898: 'spinY',
    0x20948: 'crowd', 0x20a54: 'world', 0x20b08: 'rank', 0x20d34: 'windmill',
    0x20e54: 'jeffry', 0x210a0: 'checkpoint', 0x211fc: 'flags', 0x212a4: 'light',
    0x212e4: 'none', 0x21618: 'runs', 0x21664: 'pylon', 0x21698: 'pylon',
    0x216cc: 'pylon', 0x21700: 'pylon', 0x21e40: 'standWindow', 0x21ef8: 'arcadeWindow',
    0x22018: 'world', 0x22080: 'flock', 0x22314: 'birds', 0x224f8: 'bigBird',
    0x22608: 'horse', 0x22a20: 'curtainCall',
};
const DAYTONA_OBJECTS_A = {
    at: 0x33bfc, kinds: DAYTONA_KINDS_A,
    cycles: 0x236b40, checkpoints: 0x236d60, spinY: -0x100,
    rankBoard: 0x23607c, rankCars: 0x2360b8,
    windmill: { sails: 0x2361b0, still: [0x2843e6c, 0x2843e80] },
    birds: 0x233b7c, horses: 0x233afc, jeffry: 0x28478a0,
    crowds: [{ list: 0x236e38, count: 12, shown: { road: [0x2f8, 0x33e] } }],
    pylons: { 0x21664: 0x2850ce0, 0x21698: 0x2850cf0, 0x216cc: 0x2850d00, 0x21700: 0x2850cd0 },
    /* The point each window's reflection is taken against: the lda in its
     * display routine (Rev A 0x21e88, 0x21f58) — see `window` in js/daytona.js. */
    windows: { 0x21e40: 0x235bb4, 0x21ef8: 0x222000 },
    shown: { 0x20698: { area: [0x7a, 0x6a] }, 0x20730: { near: [0x99, 0x89] }, 0x22018: { road: [0x208, 0x240] } },
};
const DAYTONA_KINDS_SE = {
    0x20118: 'static', 0x201bc: 'cycle', 0x202c4: 'ship', 0x20364: 'slot',
    0x20698: 'light', 0x20730: 'light', 0x207c8: 'spinZ', 0x20898: 'spinY',
    0x20948: 'crowd', 0x20a6c: 'world', 0x20b48: 'rank', 0x20dd8: 'windmill',
    0x20ef8: 'jeffry', 0x21144: 'checkpoint', 0x212a0: 'flags', 0x21348: 'light',
    0x213b0: 'none', 0x216e4: 'runs', 0x21730: 'pylon', 0x21764: 'pylon',
    0x21798: 'pylon', 0x217cc: 'pylon', 0x21f0c: 'standWindow', 0x21fc4: 'arcadeWindow',
    0x220e4: 'world', 0x2214c: 'flock', 0x223e0: 'birds', 0x225c4: 'bigBird',
    0x226d4: 'horse', 0x22aec: 'curtainCall',
};
const DAYTONA_SHOWN_SE = {
    0x20698: { area: [0x7a, 0x6a] }, 0x20730: { near: [0x99, 0x89] }, 0x220e4: { road: [0x208, 0x240] },
};
const DAYTONA_OBJECTS_SE = {
    at: 0x348c8, kinds: DAYTONA_KINDS_SE, shown: DAYTONA_SHOWN_SE,
    cycles: 0x23780c, checkpoints: 0x237a2c, spinY: -0x100,
    rankBoard: 0x236d48, rankCars: 0x236d84,
    windmill: { sails: 0x236e7c, still: [0x2843e6c, 0x2843e80] },
    birds: 0x234848, horses: 0x2347c8, jeffry: 0x28478a0,
    crowds: [
        { list: 0x237c44, count: 9, shown: { road: [0x95, 0xc1] } },
        { list: 0x237b24, count: 12, shown: { road: [0x2f8, 0x33e] } },
    ],
    pylons: { 0x21730: 0x2850ce0, 0x21764: 0x2850cf0, 0x21798: 0x2850d00, 0x217cc: 0x2850cd0 },
    windows: { 0x21f0c: 0x236880, 0x21fc4: 0x2220cc },
};
/* The Saturn advertisements set: the Special Edition's routines at the same
 * places, its tables 0x510 on and its pylons' models 0x400 back. */
const DAYTONA_OBJECTS_S = {
    at: 0x34dd8, kinds: DAYTONA_KINDS_SE, shown: DAYTONA_SHOWN_SE,
    cycles: 0x237d1c, checkpoints: 0x237f3c, spinY: -0x100,
    rankBoard: 0x237258, rankCars: 0x237294,
    windmill: { sails: 0x23738c, still: [0x2843e6c, 0x2843e80] },
    birds: 0x234d58, horses: 0x234cd8, jeffry: 0x28478a0,
    crowds: [
        { list: 0x238154, count: 9, shown: { road: [0x95, 0xc1] } },
        { list: 0x238034, count: 12, shown: { road: [0x2f8, 0x33e] } },
    ],
    pylons: { 0x21730: 0x28508e0, 0x21764: 0x28508f0, 0x21798: 0x2850900, 0x217cc: 0x28508d0 },
    windows: { 0x21f0c: 0x236d90, 0x21fc4: 0x2220cc },
};

/*
 * The 1993 build, which writes the same routines its own way: every check point
 * is a routine of its own with its scale and list inline (`checkpointsAt`), one
 * of its two prop routines walks a list of its own (`lists`), the dice turn the
 * other way, and the crowd routine draws both crowds an instruction at a time,
 * traced by daytona-tables.mjs into `groups`. Its two plain prop routines and
 * three of its check points test the near set where Revision A's test the
 * area (`shown`).
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
        0x230e0: 'pylon', 0x23114: 'pylon', 0x23b08: 'standWindow', 0x23bc0: 'arcadeWindow',
        0x23ce0: 'world', 0x23d48: 'flock', 0x2430c: 'birds', 0x24730: 'bigBird',
        0x24854: 'horse', 0x24cd0: 'curtainCall',
    },
    lists: { 0x2024c: 0x238b04 },
    shown: {
        0x203a4: 'near', 0x20450: 'near', 0x209e4: { area: [0x7a, 0x6a] }, 0x20a7c: { near: [0x99, 0x89] },
        0x22030: 'near', 0x22090: 'near', 0x2214c: 'near', 0x23ce0: { road: [0x208, 0x240] },
    },
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
    windows: { 0x23b08: 0x2388f8, 0x23bc0: 0x223cc8 },
    crowds: [{
        /* The plaza's, while the crowd's own block is near. */
        shown: 'near',
        groups: [
            { at: [-798, 33.58, 176.8], turns: [['y', 23301]], list: 0x238d20 },
            { at: [-813, 33.58, 187.7], turns: [['y', 21845]], list: 0x238d30 },
            { at: [-804, 33.58, 174], turns: [['y', 22573]], list: 0x238d50 },
            { at: [-804.5, 33.58, 186.4], turns: [['y', 21845]], list: 0x238d60 },
            { at: [-810, 33.58, 196], turns: [['y', 21116]], list: 0x238d70 },
            { at: [-788.5, 33.58, 165], turns: [['y', 25667]], list: 0x238d80 },
            { at: [-783.5, 33.58, 162], turns: [['y', 26942]], list: 0x238d90 },
            { at: [-807, 33.58, 191], turns: [['y', 22027]], list: 0x238da0 },
            { at: [-802, 33.58, 182.5], turns: [['y', 22209]], list: 0x238db0 },
        ],
    }, {
        /* The shuttle's, while the player is on its stretch. */
        shown: { road: [0x2f8, 0x33e] },
        groups: [
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
    modelTable: {
        offset: 0x887928, count: 2822,
        /* The boot's copies, as Revision A's (DAYTONA_REV_A): 0x1580, 0x15EC, 0x164C. */
        textureRam: [{ from: 0, at: 0x9e0000 }, { from: 0x5000, at: 0x9ea000 }], polygonRam: 0x9c0000,
    },
    paletteOffset: 0x8955a0, paletteCount: 1007,
    bankTable: 0x14bc, bootBank: 0x2500000, texSets: 4,
    luma: { source: 'maincpu', count: 0x2fd34, data: 0x2fd38 },
    cabinets: DAYTONA_CABINETS_93,
    materials: { source: 'maincpu', at: 0x5050, count: 32, stride: 4 },
    light: [-0.45, -0.89, 0.45],
    courses: { source: 'maincpu', at: 0x39b0 },
    sky: { table: 0x3a48 },
    cells: {
        records: [[0x028729b0, 0x02887928], [0x0023265c, 0x0023267a]],
        cgTables: [[0x02800000, 7], [0x02900000, 2]],
        cgExtra: { 7: 0x0023c530 },
        courses: { count: 4, cells: 0x0023aff4, cgs: 0x0023afe4, flash: courseFlash(0x0023aff4) },
    },
    objects: DAYTONA_OBJECTS_93,
    area: { heading: 0x17658, clip: 0x17150, order: 0x17104 },
    /* Its own sound program, on the same samples. The song table is in the
     * program ROM (0x231E70, read at 0x30C8) and holds the same four songs;
     * the pick, the VR buttons and 0xB70700 after the third are Revision A's,
     * and so is the boot run (graded in MAME, byte for byte). */
    sound: {
        ...DAYTONA_SOUND,
        program: [['epr-16489.7', 0xc20e543e], ['epr-16490.8', 0xc24edaab]],
        music: { ...DAYTONA_SOUND.music, region: 'mainCpu', table: 0x31e70 },
    },
});

/*
 * The player's car as the linked attract draws it (js/daytonacar.js), Revision
 * A's addresses. `car`: the body tables 0x7D38 and 0xD104 read by 0x501488
 * (`bodies`, `seconds`), the number plates by cabinet (`plates`), the glass
 * and shadow models, the wheels' model list and places (0x7DA4). `runs`: the
 * "D.K." header in the data ROM, then the tables 0xD3E4 reads by course
 * (`course`, `height`, `lift`) and by the car's place (`lengths`), and the
 * two runs 0xD2D4 steers cars 0 and 1 by. The turbo, Maxx and GTX programs
 * have every one at the same address.
 */
const DAYTONA_COURSE_NAMES = ['Three-Seven Speedway', 'Seaside Street Galaxy', 'Dinosaur Canyon'];
const DAYTONA_CAR_A = {
    car: { bodies: 0x281e390, seconds: 0x281e39c, plates: 0x281e3b4, glass: 0x284a2d0, shadow: 0x2843980, wheels: 0x230496, places: 0x230d54 },
    runs: { at: 0x2880000, first: 34, course: 0x231b34, lengths: 0x231b44, height: 0x231c44, lift: 0x231c54, steer: [46, 47], courses: DAYTONA_COURSE_NAMES },
};

/* What the Revision A program and every build made from it share: the data
 * ROM pair the tables sit in, and the tables. A build lists what it changes. */
const DAYTONA_REV_A = {
    data8: [0x800000, 'epr-16724a.6', 0x469f10fd, 'epr-16725a.7', 0xba0df8db],
    modelTable: {
        offset: 0x83fbb4, count: 3190,
        /* The cars' glass and the 1P to 8P markers, models 2139 to 2165, are
         * built in the board's RAMs: the boot copies texture RAM 0 on from
         * here (0x1664), 0x5000 on, the texture points, from 0x8F5000
         * (0x16D0), and polygon RAM from 0x8E0000 (0x1730). See textureAt in
         * js/model.js. */
        textureRam: [{ from: 0, at: 0x8f0000 }, { from: 0x5000, at: 0x8f5000 }], polygonRam: 0x8e0000,
    },
    paletteOffset: 0x84f4ec, paletteCount: 1007,
    bankTable: 0x15a0, bootBank: 0x2500000, texSets: 4,
    luma: { source: 'mainData', count: 0x802fc4, data: 0x802fc8 },
    cabinets: DAYTONA_CABINETS,
    materials: { source: 'mainData', at: 0x805128, count: 32, stride: 4 },
    light: [-0.45, -0.89, 0.45],
    courses: { source: 'mainData', at: 0x805298 },
    sky: { table: 0x4770 },
    cells: {
        records: [[0x02823c4c, 0x0283fbb4], [0x00230a4c, 0x00230a6a], [0x00239ff0, 0x0023a04a]],
        cgExtra: { 7: 0x0023a270 },
    },
    objects: DAYTONA_OBJECTS_A,
    area: { heading: 0x17908, clip: 0x175e0, order: 0x17594 },
};

const daytona = daytonaBuild({
    ...DAYTONA_REV_A,
    car: DAYTONA_CAR_A,
    id: 'daytona',
    name: 'Daytona USA (Revision A)',
    program: [0x00000, 'epr-16722a.12', 0x48b94318, 'epr-16723a.13', 0x8af8b32d],
});

const daytonase = daytonaBuild({
    ...DAYTONA_REV_A,
    car: {
        car: { ...DAYTONA_CAR_A.car, bodies: 0x2818664, seconds: 0x2818670, plates: 0x2818688, wheels: 0x231136, places: 0x231a40 },
        runs: { ...DAYTONA_CAR_A.runs, course: 0x232800, lengths: 0x232810, height: 0x232910, lift: 0x232920 },
    },
    id: 'daytonase',
    name: 'Daytona USA Special Edition (Revision A)',
    program: [0x00000, 'epr-17369a.12', 0x3bc6ca62, 'epr-17370a.13', 0x5d1c74e4],
    data8: [0x800000, 'epr-17371.6', 0x7478f0d2, 'epr-17372.7', 0x308a06a9],
    bankTable: 0x15b4,
    cabinets: DAYTONA_CABINETS_SE,
    sky: { table: 0x47c8 },
    cells: {
        records: [[0x0281df20, 0x02839e88], [0x002316ec, 0x0023170a], [0x0023adb0, 0x0023ae0a]],
        cgExtra: { 7: 0x0023b030 },
        courses: { count: 4, cells: 0x00239770, cgs: 0x00239760, flash: courseFlash(0x00239770) },
    },
    objects: DAYTONA_OBJECTS_SE,
    area: { heading: 0x17d84, clip: 0x17a5c, order: 0x17a10 },
});

const daytonas = daytonaBuild({
    ...DAYTONA_REV_A,
    car: {
        car: { ...DAYTONA_CAR_A.car, bodies: 0x2818664, seconds: 0x2818670, plates: 0x2818688, wheels: 0x231646, places: 0x231f50 },
        runs: { ...DAYTONA_CAR_A.runs, at: 0x2886000, course: 0x232d10, lengths: 0x232d20, height: 0x232e20, lift: 0x232e30 },
    },
    id: 'daytonas',
    name: 'Daytona USA (with Saturn advertisements)',
    program: [0x00000, 'epr-17965.ic12', 0xf022b3da, 'epr-17966.ic13', 0xf9e4ece5],
    data8: [0x800000, 'epr-17967.ic6', 0xa94d8690, 'epr-17968.ic7', 0x9d5a92c6],
    bankTable: 0x15b4,
    sky: { table: 0x4838 },
    /* The Saturn advertisement is a CG of its own, which 0x28860 loads
     * straight from the pair at 0x23B2D4, and eleven pictures: two scripts
     * (0x23B1D4, 0x23B254) of steps {records, frames, scroll}, each record
     * {address, tilemap address, first and end column}, drawn a column slice
     * at a time by 0x28B48. One is the last of the main run; the rest are
     * runs of their own, two of them after a gap in the main run, one in the
     * program ROM and six far out in the data ROM (`screens`). */
    cells: {
        records: [
            [0x0281df20, 0x0283a820], [0x0283a840, 0x0283b108], [0x0283b128, 0x0283b81c],
            [0x0023b568, 0x0023c570], [0x0286fe2c, 0x02870a00], [0x02870a20, 0x028712e8],
            [0x02871308, 0x02871bd0], [0x02871bf0, 0x02872040], [0x02872060, 0x02874f34],
            [0x00231bfc, 0x00231c1a], [0x0023c800, 0x0023c85a],
        ],
        cgExtra: { 7: 0x0023ca80 },
        courses: { count: 4, cells: 0x00239c80, cgs: 0x00239c70, flash: courseFlash(0x00239c80) },
        cgPairs: [[0x0023b2d4, 'Saturn advert']],
        screens: [{ cg: 9, cells: [222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232] }],
    },
    objects: DAYTONA_OBJECTS_S,
    area: { heading: 0x17df4, clip: 0x17acc, order: 0x17a80 },
});

const daytonat = daytonaBuild({
    ...DAYTONA_REV_A,
    car: DAYTONA_CAR_A,
    id: 'daytonat',
    name: 'Daytona USA (Turbo hack, set 1)',
    program: [0x00000, 'turbo1.12', 0x4b41a341, 'turbo2.13', 0x6ca580fa],
});

const daytonata = daytonaBuild({
    ...DAYTONA_REV_A,
    car: DAYTONA_CAR_A,
    id: 'daytonata',
    name: 'Daytona USA (Turbo hack, set 2)',
    program: [0x00000, 'dayturbo.12', 0xaec6857a, 'dayturbo.13', 0xcb657edc],
});

const daytonam = daytonaBuild({
    ...DAYTONA_REV_A,
    car: DAYTONA_CAR_A,
    id: 'daytonam',
    name: 'Daytona USA (To The MAXX)',
    program: [0x00000, 'maxx.12', 0x604ef2d9, 'maxx.13', 0x7d319970],
});

const daytonagtx = daytonaBuild({
    ...DAYTONA_REV_A,
    car: DAYTONA_CAR_A,
    id: 'daytonagtx',
    name: 'Daytona USA (GTX 2004 Edition)',
    program: [0x00000, 'gtx.12', 0x08283a6f, 'gtx.13', 0xf9b356ae],
});

/* ---- Virtua Cop ----------------------------------------------------------- */

/*
 * Virtua Cop (Revision B), the second game on the original Model 2 board and
 * AM2's, a year after Daytona USA. It is Daytona's library: the texture bank
 * upload, the colorxlat build, the luma upload and the material upload are the
 * same routines instruction for instruction, with their tables moved into the
 * data ROM. So the profile is Daytona's with this game's numbers, every one of
 * them read off the instruction that uses it:
 *
 *   0x23F70   the bank upload, Daytona's 0x146C; its mip run lengths are the
 *             table at data 0x8190C0 rather than in the program ROM, and its
 *             callers are 0x23E44 (`ld 0x28190E8[r5*4], g5`, the bank table)
 *             and 0x23E5C (`lda 0x2300000, g5`, the bank every scene keeps)
 *   0x23CD0   colorxlat. Daytona's routine without the cabinet test: the one
 *             set of constants, which are Daytona's DELUXE ones
 *   0x24070   luma RAM, 0x28190F8 bands of 128 bytes from 0x28190FC
 *   0x2A28    the boot palette: 1024 colours from data 0x4C0000 into palette
 *             RAM, each channel scaled by a brightness on the way
 *   0x51E50   one of the draw routines, and the reason the model table is
 *             found from the program rather than the other way round: this
 *             game names a model by number. `lda 0x24C8000[g0*16]` for up to
 *             0x4D1 and `lda 0x28693F0[g0*16]` past it, the second table
 *             starting where the first stops counting (`past`), up to 0x4E2.
 */

/*
 * Virtua Cop's sound board is Daytona's (js/sound/sound.js, board 'model1')
 * with its own driver (epr-17170/17171) and samples. The first sample pair is
 * 1 MB a chip, each at the start of its 2 MB half as MAME loads them.
 *
 * There is no song table: the play mode's stage start (0xA464, sub-state 6 of
 * the table at 0xA6F0) tests the stage byte 0x50F2A8 and sends a constant —
 * 0xAE1F06 for stage 1, 0xAE1F0C for 2, 0xAE1F07 for 3 — each followed by
 * 0xBE2101, 0xBE2102 or 0xBE2103. Channel 0x1F is the music; 0xAE1F00 stops
 * it. `stop` is what the boot (0xA6C) sends: that, then 0x2BB20's run, which
 * stops channels 0x21 and 0x22 and keys off the rest. MAME, coined and
 * pinned to each stage, sent exactly these at the stage start (frame 1311).
 */
const VCOP_SOUND_STOP = [
    0xAE, 0x1F, 0x00,
    0xAE, 0x21, 0x2F, 0xAE, 0x21, 0x30, 0xAE, 0x21, 0x31,
    0xAE, 0x22, 0x2F, 0xAE, 0x22, 0x30, 0xAE, 0x22, 0x31, 0xAE, 0x22, 0x32,
    0x8E, 0x2E, 0x60, 0x8E, 0x2F, 0x60,
];
const VCOP_SOUND = {
    board: 'model1',
    program: [['epr-17170.7', 0x06a38ae2], ['epr-17171.8', 0xb5e436f8]],
    samples: [
        ['mpr-17172.32', 0xab22cac3], ['mpr-17173.33', 0x3cb4005c],
        ['mpr-17174.4', 0xa50369cc], ['mpr-17175.5', 0x9136d43c],
    ],
    boot: VCOP_SOUND_STOP,
    stop: VCOP_SOUND_STOP,
    songs: [0xAE1F06, 0xAE1F0C, 0xAE1F07],
    after: { song: { 0: [0xBE, 0x21, 0x01], 1: [0xBE, 0x21, 0x02], 2: [0xBE, 0x21, 0x03] } },
};

/*
 * The 2D pictures (js/cells.js): the title, the HUD, the gun and life marks,
 * the rankings, the stage's sky. The draw is 0x55A0 (0x5610 the same but for
 * skipping zero entries): the record's address in g0, the tilemap's in g1
 * and in g2 a halfword it adds to every entry. The record is the width and
 * the height as halfwords, then halfword entries row by row onto 0x80-byte
 * tilemap rows. Nothing indexes the records; they lie end to end in two runs
 * of the data ROM (`records`), some with zero halfwords between them, and a
 * cell is its place in those runs. Every record a call names is a record
 * start. The first run starts where the boot palette's runs (0x2801C00) end
 * and stops at the second palette's (0x28113E0); the second stops at the
 * pointer 0x28143E0.
 *
 * Most calls add 0x8000 (`base`). Bit 15 picks no colour, so a 0 is drawn
 * the same; bit 14 moves the palette group on by 0x80. `bases` are the
 * records every call draws with something other than 0x8000. Three records
 * are drawn both ways and take 0x8000 here: 0x2802A10, 0x2807DC0 and
 * 0x2808640 with 0xC000 as well, and 0x2812C90 with 0x4000 (0x67080).
 *
 * The boot (0x49B0) fills the tile chip once. 0x4A38 copies 0x2400000 into
 * characters 0x80 to 0x37FF and 0x4AA8 0x28E0000 into 0x3300 to 0x3FFF, each
 * halfword's bytes swapped. 0x4B10 and 0x4CE0 build the palette: runs from
 * 0x2801C00 into groups 1 on until 0x7F groups are written, group 0x2B from
 * 0x2814780, groups 1-0x7F copied to 0x81-0xFF, then 0x2814680 over 0x81-0x83,
 * 0x28146A0 over 0x84, 0x28148A0 and 0x28148C0 over 0xAE and 0xAF, six runs
 * from 0x28113E0 into 0x66 on and again into 0xE6 on, and 0x2814940 over
 * 0xFB-0xFF. 0x5080 also draws a 1-bit font into characters 0-0x7F, which no
 * record names, so it is left out. The stage start puts the stage's own
 * sixteen colours (`stages.table`) into group 0x10, the sky's (js/vcopsky.js).
 * So CG 0 is the boot, and CGs 1 to 3 are the boot with each stage's group.
 */
const VCOP_CELLS = {
    sized: true,
    records: [[0x028022e8, 0x028113d4], [0x028114d0, 0x028143d4]],
    base: 0x8000,
    bases: {
        [0x028022e8]: 0xc000, [0x02802300]: 0xc000, [0x02807d70]: 0xc000, [0x02807da0]: 0xc000,
        [0x02802f00]: 0, [0x02803790]: 0, [0x02810c40]: 0, [0x02811150]: 0,
    },
    boot: {
        chars: [[0x02400000, 0x80, 0x3780], [0x028e0000, 0x3300, 0xd00]],
        palette: [
            { runs: 0x02801c00, group: 1, until: 0x7f },
            { colours: 0x02814780, group: 0x2b, groups: 1 },
            { copy: [1, 0x81, 0x7f] },
            { colours: 0x02814680, group: 0x81, groups: 3 },
            { colours: 0x028146a0, group: 0x84, groups: 1 },
            { colours: 0x028148a0, group: 0xae, groups: 1 },
            { colours: 0x028148c0, group: 0xaf, groups: 1 },
            { runs: 0x028113e0, group: 0x66, lists: 6 },
            { runs: 0x028113e0, group: 0xe6, lists: 6 },
            { colours: 0x02814940, group: 0xfb, groups: 5 },
        ],
        stages: { table: 0x02814990, group: 0x10, count: 3 },
    },
    charBytes: 0x80000,
    colorxlat: true,
};

const vcop = {
    ...daytonaBuild({
        id: 'vcop',
        name: 'Virtua Cop (Revision B)',
        program: [0x00000, 'epr-17166b.12', 0xa5647c59, 'epr-17167b.13', 0xf5dde26a],
        data8: [0x800000, 'epr-17168a.6', 0x59091a37, 'epr-17169a.7', 0x0495808d],
        modelTable: { offset: 0x4c8000, count: 0x4d2 },
        paletteOffset: 0x4c0000, paletteCount: 1024,
        bankTable: 0x28190e8, bootBank: 0x2300000, texSets: 3,
        luma: { source: 'mainData', count: 0x8190f8, data: 0x8190fc },
        cabinets: DAYTONA_CABINETS,
        /* Not Daytona's table at 0x81B294, which this build never sends: 0x6F90
         * sends 0x94D0 (or 0x95D0, the same but for slots 16, 17 and 19, when
         * 0x5016FC is 0), parameter and coefficient interleaved. Slot 15 is
         * the car windows', a flat 255 that puts them on the blue of the band. */
        materials: { source: 'maincpu', at: 0x94d0, count: 32, stride: 8 },
        /* Out of play, 0x1E1C8's (0.14, -0.7, -0.7), which 0x25890 normalises;
         * z negated for the explorer. In play the stage's own table takes over
         * (js/vcop.js, railLight). */
        light: [0.140028, -0.700140, 0.700140],
        courses: {},
        sound: VCOP_SOUND,
    }),
    /* Straight after the table, the boot (0x38B58) stores these by hand: the
     * drums' teal over the table's red, and a duller tan. */
    paletteFixes: [
        [0xe1, 0xb245], [0xe2, 0xb245], [0xe3, 0xb245], [0xe4, 0xb245], [0xe5, 0xb245],
        [0x173, 0xa1b2], [0x174, 0xba96], [0x175, 0xba96], [0x176, 0xba96], [0x177, 0xa1d2],
    ],
    regions: {
        /* Two pairs, 512KB; the second half of the first is the one the board
         * also maps at 0x00220000, as on Daytona. */
        maincpu: {
            size: 0x80000,
            parts: [
                [0x00000, 'epr-17166b.12', 0xa5647c59, 'epr-17167b.13', 0xf5dde26a],
                [0x40000, 'epr-17160a.14', 0x267f3242, 'epr-17161a.15', 0xf7126876],
            ],
        },
        /* The model table and the palette are in the second pair, the banks in
         * the first and second, the tables the program reads in the third. */
        mainData: {
            size: 0x900000,
            parts: [
                [0x000000, 'mpr-17164.10', 0xac5fc501, 'mpr-17165.11', 0x82296d00],
                [0x400000, 'mpr-17162.8', 0x60ddd41e, 'mpr-17163.9', 0x8c1f9dc8],
                [0x800000, 'epr-17168a.6', 0x59091a37, 'epr-17169a.7', 0x0495808d],
            ],
        },
        polygons: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-17159.16', 0xe218727d, 'mpr-17156.20', 0xc4f4aabf]],
        },
        textures: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-17158.25', 0x1108d1ec, 'mpr-17157.24', 0xcf31e33d]],
        },
    },
    /* Four words and no terminator: {oba, tpa, tha, count}, written to the
     * engine as tpa, tha, oba, count like Daytona's. Model 0, the van, has its
     * texture records at the very start, so a tha of 0 is one. */
    modelTable: {
        offset: 0x4c8000, count: 0x4e3, stride: 16, fields: { mesh: 0, uv: 4, mat: 8 }, matAtZero: true,
        past: { from: 0x4d2, offset: 0x8693f0 },
        /* The 0x800 words uploaded to texture RAM 0x4000 at game start. */
        textureRam: [{ from: 0x4000, at: 0x81d3de }],
    },
    /* The band over luma 48..63, one table per stage (0x4170, by the stage
     * number at 0x50F2A8). A fourth, 0x801800, is taken when 0x5016D4 is 10.
     * Before it, 0x43B0 shifts the ramp by the same stage number: `top` is the
     * highest red entry it moves and `add` what each channel gains. 0x5016D4
     * being 10 takes { top: 0xe7, add: [15, -4, -7] } instead. */
    colors: {
        luma: { source: 'mainData', count: 0x8190f8, data: 0x8190fc }, ramp: RAMP_DELUXE, solid: true,
        band: { tables: [0x800c00, 0x801000, 0x801400] },
        shift: [
            { top: 0xf7, add: [8, 8, 8] },
            { top: 0xef, add: [13, -2, -2] },
            { top: 0xf7, add: [8, 8, 8] },
        ],
    },
    patches: [],
    /* js/vcop.js: 0x28390D0[stage] is the stage's segment array. */
    stageTable: { flat: true, segments: { at: 0x28390d0, count: 4 } },
    cells: VCOP_CELLS,
    /* The wave records' bodies, playing the motion table through the enemy's
     * own draw (js/vcopbodies.js). */
    rig: { kind: 'vcop' },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};

/* ---- Virtua Cop 2 --------------------------------------------------------- */

/*
 * Virtua Cop 2 (MAME's `vcop2`, Model 2A) runs Virtua Cop's library, moved up
 * the program ROM to 0x16xxx: the same bank upload, ramp, band and luma copy,
 * called in the same order at boot (0x1EDC..0x1F2C). What differs is listed
 * on the fields below.
 */
const vcop2 = {
    ...daytonaBuild({
        id: 'vcop2',
        name: 'Virtua Cop 2',
        program: [0x000000, 'epr-18524.12', 0x1858988b, 'epr-18525.13', 0x0c13df3f],
        data8: [0x800000, 'mpr-18522.6', 0x61d18536, 'mpr-18523.7', 0x61d08dc4],
        modelTable: { offset: 0x4c8004, count: 0xbb2 },
        /* 0x164A0: 1024 colours from data 0x4C0000 to the face palette. */
        paletteOffset: 0x4c0000, paletteCount: 1024,
        /* 0x165AC, Daytona's upload with the 2A board's sheets (0x12200000 and
         * 0x12600000) and its run table at 0x18CEC. The boot (0x1657C) puts
         * 0x2300000 on sheet 1; 0x16594 puts the scene's, `ld 0x18d14[g0*4]`,
         * on sheet 0: 0x2000000, 0x2100000, 0x2200000, then 0x2000000 three
         * times. g0 is the stage number 0x502010 (0x5028). */
        bankTable: 0x18d14, bootBank: 0x2300000, texSets: 3,
        luma: { source: 'maincpu', count: 0x16bd8, data: 0x16bdc },
        cabinets: DAYTONA_CABINETS,
        /* 0x16250 sends geometry function 6 from the header at 0x163E0 (start
         * 0, count 32): parameters from 0x163E8, coefficients (all 100.0)
         * from 0x16360. */
        materials: { source: 'maincpu', at: 0x163e8, count: 32, stride: 4 },
        /* No world light in ROM: every scene sends its own through function
         * 0xA (0x15FC4), most of them worked out by the copro. This is the
         * constant one 0x5648 sends, (-0.14, -0.7, 0.7), normalised; z negated
         * for the explorer. */
        light: [-0.140028, -0.700140, -0.700140],
        courses: {},
        sound: null,
    }),
    regions: {
        /* Two pairs of 1MB. */
        maincpu: {
            size: 0x200000,
            parts: [
                [0x000000, 'epr-18524.12', 0x1858988b, 'epr-18525.13', 0x0c13df3f],
                [0x100000, 'epr-18518.14', 0x7842951b, 'epr-18519.15', 0x31a30edc],
            ],
        },
        /* The banks in the first pair, the model table and the palette in the
         * second. The zip calls the last pair mpr-; MAME, epr-. */
        mainData: {
            size: 0xd00000,
            parts: [
                [0x000000, 'mpr-18516.10', 0xa3928ff0, 'mpr-18517.11', 0x4bd73da4],
                [0x400000, 'mpr-18514.8', 0x791283c5, 'mpr-18515.9', 0x6ba1ffec],
                [0x800000, 'mpr-18522.6', 0x61d18536, 'mpr-18523.7', 0x61d08dc4],
                [0xc00000, 'epr-18520.4', 0x1d4ec5e8, 'epr-18521.5', 0xb8b3781c],
            ],
        },
        polygons: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-18513.16', 0x777a3633, 'mpr-18510.20', 0xe83de997]],
        },
        textures: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-18512.25', 0xd9bc7e71, 'mpr-18511.24', 0xcae77a4f]],
        },
    },
    /* 0xBB2 entries at data 0x4C8004, after their count less one (0xBB1, at
     * 0x4C8000), in the 1995 games' order: tpa, tha, oba, count. The draws
     * (0x160E0, 0x16178, 0x1620C) read `0x24c8004[g0*16]` from the copy
     * the boot makes at RAM 0x200000 (0x21D4). Model 0's headers start the
     * texture ROM, so a tha of 0 is one. */
    modelTable: { offset: 0x4c8004, count: 0xbb2, stride: 16, matAtZero: true },
    /*
     * The ramp is Virtua Cop's (0x164D0, the deluxe constants). Then 0x168B8
     * lifts the low byte of every channel of rows 1..31, luma 1..63, by 8,
     * held at 0xFF (`lift`; 0x168C4 is the same with the three adds in g1-g3,
     * which two scenes call with (12, 4, 2) and (12, 6, 4)), and 0x16758 lays
     * one band over luma 48..63 of every row from program 0x18D2C. Its blue
     * takes bit 15 for its low bit, where Virtua Cop's takes bit 14.
     */
    colors: {
        luma: { source: 'maincpu', count: 0x16bd8, data: 0x16bdc }, ramp: RAMP_DELUXE, solid: true,
        lift: [8, 8, 8],
        band: { source: 'maincpu', tables: [0x18d2c, 0x18d2c, 0x18d2c], blueBit: 15 },
    },
    patches: [],
    paletteFixes: [],
    /* The stage draw's table 0x63374, by stage, route and segment (js/vcop2.js). */
    stageTable: { flat: true, vcop2: { count: 4 } },
    objects: null,
    area: null,
    sky: null,
    cells: null,
    rig: null,
    features: { stages: true, characters: false, motions: false, bodies: false, cells: false },
};

/* ---- Virtua Striker ------------------------------------------------------- */

/*
 * Virtua Striker (MAME's `vstriker`, Revision A, and `vstrikero`, the first
 * release), Model 2B. Its library is Daytona's and Virtua Cop's, a year on: the
 * same model-table entry, mesh pointer and bank upload. The colours are not:
 * the boot's colour routine (0x9210 in Revision A) dims the face palette and
 * builds colorxlat out of floats and data-ROM tables, so the explorer runs that
 * routine itself (js/colors.js runColorRoutines) rather than port it.
 *
 * The test menu's MONITOR setting (backup RAM 0x1D0001A: 0 PROJECTER, 1 CRT,
 * which a fresh board has) picks the colorxlat constants, so it is the panel's
 * cabinet choice here.
 */
const VSTRIKER_MONITORS = [{ name: 'PROJECTER' }, { name: 'CRT' }];
const VSTRIKER_SHARED = {
    /* 0x2000000-0x2800000; the third pair, each build's own, follows. */
    data0: [0x000000, 'mpr-18055.11', 0x5aba9fc0, 'mpr-18056.12', 0x017f0c55],
    data4: [0x400000, 'mpr-18053.9', 0x46c770c8, 'mpr-18054.10', 0x437af66e],
    polygons: {
        size: 0x800000,
        parts: [
            [0x000000, 'mpr-18057.17', 0x890d8806, 'mpr-18059.21', 0xc5cdf534],
            [0x400000, 'mpr-18058.18', 0xd4cbdf7c, 'mpr-18060.22', 0x93d5c95f],
        ],
    },
    textures: {
        size: 0x400000,
        parts: [[0x000000, 'mpr-18062.27', 0x126e7de3, 'mpr-18061.25', 0xc37f1c67]],
    },
};
/*
 * One build: `program` the two pairs, `data8` the third data pair, `colors` the
 * colour routine and the RAM word its ramp reads MONITOR from. Every table the
 * explorer reads is at the same data ROM address in both.
 */
function vstrikerBuild({ id, name, program, data8, colors, monitorRam, texRoutine }) {
    return {
        ...daytonaBuild({
            id, name,
            program: program[0], data8,
            modelTable: { offset: 0x180800, count: 1537 },
            paletteOffset: null, paletteCount: 1024,
            bankTable: null, bootBank: 0x2400000, texSets: 1,
            luma: {}, cabinets: VSTRIKER_MONITORS,
            /* 0x8448 (Revision A) sends geometry function 6 from data
             * 0x825E30: start 0, count 31, a parameter word and a distance
             * coefficient each. */
            materials: { source: 'mainData', at: 0x825e30, count: 31, stride: 8 },
            /* 0x42A4 sends the one fixed light, (0, -0.87, 0.5), every frame
             * (the display list's function 0xA in MAME); normalised, z negated
             * for the explorer. */
            light: [0, -0.867019, -0.498286],
            courses: {},
            sound: null,
        }),
        regions: {
            /* Two pairs of 128KB. */
            maincpu: { size: 0x80000, parts: program },
            /* The banks and the model table in the first pair, the palette
             * at 0x180000; the colour, luma and material tables in the third. */
            mainData: { size: 0x900000, parts: [VSTRIKER_SHARED.data0, VSTRIKER_SHARED.data4, data8] },
            polygons: VSTRIKER_SHARED.polygons,
            textures: VSTRIKER_SHARED.textures,
        },
        /* 1537 entries of {oba, tpa, tha, count} at data 0x180800 — Daytona's
         * order, four words and no terminator — which 0xA940 copies to RAM
         * 0x522910. Entry 0's tha is 0, the first texture header. The draw
         * (0x8390) reads `0x522910[g0*16]`. */
        modelTable: { offset: 0x180800, count: 1537, stride: 16, fields: { mesh: 0, uv: 4, mat: 8 }, matAtZero: true },
        /* What the colour routine leaves in palette RAM 0x1802000: 1024
         * colours from data 0x180000, all but the indices listed at data
         * 0x82E440 scaled by 0.83871 a channel. */
        palette: { layout: 'i960' },
        /*
         * 0x9E60 (Revision A) is Daytona's bank upload with the 2B board's
         * sheets: 0x60000 halfwords to one, then the mip levels dealt between
         * both from the run table at data 0x82E594 (0x100, 0x80 ... 1), the
         * same runs as Daytona's. The boot calls it twice (0x10A0, 0x10B0):
         * data 0x2400000 onto sheet 1 and 0x2500000 onto sheet 0. Nothing
         * uploads another bank. Then 0x9F70 (0x10C4) halves a patch of sheet
         * 1 into sheet 0, which is run as it is (js/texture.js
         * runTextureRoutine).
         */
        texture: {
            raw: { layout: 'daytona', banks: [0x2500000], bootBank: 0x2400000, run: [[texRoutine, 1]] },
            sets: 1,
            residentSet: null,
            defaultSet: 0,
        },
        colors: {
            i960: { board: '2b', data: true, run: colors, settings: [[0x1d0001a, 1], [monitorRam, 2]] },
            cabinets: VSTRIKER_MONITORS,
            cabinet: 1,
            solid: true,
        },
        patches: [],
        paletteFixes: [],
        /* The match draw's stadium, 0x64D10 and 0x65070 (js/vstriker.js). */
        stageTable: { flat: true, vstriker: true },
        objects: null,
        area: null,
        sky: null,
        cells: null,
        rig: null,
        features: { stages: true, characters: false, motions: false, bodies: false, cells: false },
    };
}

/*
 * Revision A: 0x9210 dims the palette and calls 0x93F0, which builds
 * colorxlat (ramp 0x7F10, which reads MONITOR at RAM 0x5D4210, then
 * 0x93FC..0x97B0); 0x806C copies luma, `ld 0x282DC1C` bands of 128 from data
 * 0x82DC20. Both are the boot's (0x842C, 0x1098).
 */
const vstriker = vstrikerBuild({
    id: 'vstriker',
    name: 'Virtua Striker (Revision A)',
    program: [
        [0x000000, 'epr-18068a.15', 0xafc69b54, 'epr-18069a.16', 0x0243250c],
        [0x040000, 'epr-18066a.13', 0xe658b33a, 'epr-18067a.14', 0x49e94047],
    ],
    data8: [0x800000, 'epr-18070a.7', 0x1961e2fc, 'epr-18071a.8', 0xb2492dca],
    colors: [0x9210, 0x806c],
    monitorRam: 0x5d4210,
    texRoutine: 0x9f70,
});
/* The first release: the same routines further up (0x93E0, 0x811C, 0xA160),
 * and MONITOR at RAM 0x5D4020. Its own six chips; the rest are vstriker's. */
const vstrikero = vstrikerBuild({
    id: 'vstrikero',
    name: 'Virtua Striker',
    program: [
        [0x000000, 'epr-18068.15', 0x74a47795, 'epr-18069.16', 0xf6c3fcbf],
        [0x040000, 'epr-18066.13', 0xe774229e, 'epr-18067.14', 0x7dfd950c],
    ],
    data8: [0x800000, 'epr-18070.7', 0xf52e4db5, 'epr-18071.8', 0x1be63a7d],
    colors: [0x93e0, 0x811c],
    monitorRam: 0x5d4020,
    texRoutine: 0xa160,
});

/* ---- Virtua Fighter 2 ----------------------------------------------------- */

/*
 * Virtua Fighter 2 (Version 2.1), the `vf2` set: Model 2A, and AM2's library
 * the year before Fighting Vipers. The model table is at the same 0x0E0004
 * (`lda 0x20E0004[g0*16]` in the draw at 0x7CB8), the face palette at the same
 * 0x100000, and the colour uploads name the same tables at the same data
 * offsets: 0x109700 for the scene, 0x105800 and 0x107780 for a fighter's parts
 * with the split at 13, and 0x101000 for skin.
 *
 * What moved is in the program ROM, and every number below was read off the
 * instruction that uses it:
 *
 *   0x4BD70   unp_send_tex_para_sub: `ld 0x230000C` for the data header and
 *             `ldos 0x4C120[g0*4]` for the page grid
 *   0x4B9B8   unp_send_tex_req: `lda 0x56, r3 / cmpoble g0, r3`, so texture
 *             numbers run 0..0x56
 *   0x4B3E0   send_tex_default: `addo 31, 9, g0` and the request, set 40
 *   0x1171C   essential_color_handling: luma straight out of the program ROM,
 *             `lda 0x78D10` and `ld 0x78D0C`
 *   0x73C     send_tex_col_stage: rows 14 on, seven of them (`mov 6, g2`) in
 *             blocks of 0x2A0 (0x7FC), where Fighting Vipers takes fourteen in
 *             blocks of 0x540
 */
/* The roster in record order, as the game's own name tables give it: the
 * pointer tables at 0x2980C and 0x509E8 name 0-10, and the ones at 0x5CB28
 * and 0x46298 (the debug menu's, with the development names SUI, ACHO and TOU
 * for Shun, Dural and Lion) go on to MUE and KOJACKY for 11 and 12. The record
 * table holds the one pointer 0x20032A8, Lion's, at 10, 11 and 12, so those
 * two slots draw Lion. Records 13-25 are the thirteen again as player 2
 * wears them: 0xBDE4 adds 13 to player 2's character when both pick the same
 * fighter (0xCED4 to the arcade opponent's when it is the player's), the
 * records are read by that number (0x13F10) and the part colours of 13 and up
 * out of the second table. They are on their fighters' own texture sets;
 * Akira's is the white gi, and Dural's is the same record as 9, so only the
 * colours change. */
const VF2_NAMES = [
    'Akira', 'Jacky', 'Sarah', 'Kage', 'Lau', 'Jeffry', 'Pai', 'Wolf', 'Shun', 'Dural',
    'Lion', "Mue (Lion's record)", "Kojacky (Lion's record)",
];

const vf2 = {
    id: 'vf2',
    name: 'Virtua Fighter 2 (Version 2.1)',
    identify: ['epr-18385.12', 'epr-18386.13'],
    regions: {
        maincpu: {
            size: 0x80000,
            parts: [
                [0x00000, 'epr-18385.12', 0x78ed2d41, 'epr-18386.13', 0x3418f428],
                [0x40000, 'epr-18387.14', 0x124a8453, 'epr-18388.15', 0x8d347980],
            ],
        },
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-17560.10', 0xd1389864, 'mpr-17561.11', 0xb98d0101],
                [0x400000, 'mpr-17558.8', 0x4b15f5a6, 'mpr-17559.9', 0xd3264de6],
                [0x800000, 'mpr-17566.6', 0xfb41ef98, 'mpr-17567.7', 0xc3396922],
                [0xc00000, 'mpr-17564.4', 0xd8062489, 'mpr-17565.5', 0x0517c6e9],
            ],
        },
        polygons: {
            size: 0xc00000,
            parts: [
                [0x000000, 'mpr-17554.16', 0x27896d82, 'mpr-17548.20', 0xc95facc2],
                [0x400000, 'mpr-17555.17', 0x4df2810b, 'mpr-17549.21', 0xe0bce0e6],
                [0x800000, 'mpr-17556.18', 0x41a47616, 'mpr-17550.22', 0xc36ff3f5],
            ],
        },
        /* Two pairs at the same two offsets the later games use, leaving
         * 0x400000-0x800000 empty. */
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-17553.25', 0x5da1c5d3, 'mpr-17552.24', 0xe91e7427],
                [0x800000, 'mpr-17547.27', 0xbe940431, 'mpr-17546.26', 0x042a194b],
            ],
        },
    },
    /* The table runs to entry 5124, and a run of 0xFF at 0xF4054 ends it. */
    modelTable: { offset: 0x000e0004, count: 5125, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: 0x00100000,
    texture: {
        header: 0x300000, pageTable: 0x4c120, sets: 0x57,
        residentSet: null,
        bootSet: 40,
        /* The fighters' sets: character set-up reads the record
         * `ld 0x200620C[char*4]` and hands its +0x30 to the request at
         * 0x4B838 (0x10720, 0x39F4C). See js/vf2fighters.js. */
        fighters: { records: 0x200620c, count: 26, parts: 0x00, partCount: 16, set: 0x30 },
    },
    /* Fighting Vipers' tables and settings: the program reads its settings
     * out of the same backup RAM bytes (0x3356..0x335C) into the same
     * 0x500234..0x50023A (0x97E4), and builds the ramp from them with the
     * same routine. */
    colors: {
        luma: { source: 'maincpu', count: 0x78d0c, data: 0x78d10 },
        add: [64, 64, 64],
        mul: [37, 37, 37],
        bright: 31,
        stage: { at: 0x109700, indirect: false, row0: 14, rows: 7, block: 0x2a0, blocks: 13 },
        fixed: [],
        part: {
            at: 0x105800, atHi: 0x107780, indirect: false,
            block: 0x2a0, rows: 7, row0: [0, 7], split: 13, blocks: 13,
        },
        skin: {
            at: 0x101000, indirect: false,
            block: 0x300, hiOffset: 0x2400, rows: 2, row0: [28, 30],
        },
        /* The untextured faces go through colorxlat, as MAME's
         * draw_scanline_solid has them: a fighter's hands are untextured, and
         * their palette colour (colorbase 29) is 28 in all three channels,
         * the first skin row send_tex_col_skin fills, so drawn flat they came
         * out white. */
        solid: true,
    },
    /* js/vf2.js reads the records and draws them the way the board does. */
    /* One material table for every stage: 0x117F8 uploads the 32 slots at
     * 0x118F0 (the count and first slot are the two words before them). The
     * light is per stage — see js/vf2.js — and the fighters take it too: in
     * MAME's Colosseum fight each frame sends one light, the record's (length
     * 1.2, or its lightning's 9999), to every draw. `vecter` is only for a
     * model no stage is loaded under. */
    lighting: {
        vecter: [0xe000, 0xc000],
        stageLit: true,
        materials: { at: 0x118f0, count: 32, stride: 4 },
    },
    /* ringSize: stage_x (0x50A00C) at the factory setting. Stage setup (0xCF64)
     * takes it from 0x11540, 7.5 first; 8.0 is 0x11530's, the table the attract
     * demos cycle through (8.0, 7.5, 7.0 in MAME). */
    stageTable: { vf2: { at: 0x6ee38, stride: 256, count: 16, ringSize: 7.5 }, flat: true },
    /*
     * The sound board is Sonic The Fighters' — the same Model 2 board, the
     * chips laid out the same way, the same three boot commands (0x8574,
     * 0x8B9C, 0x8BAC). The round start (0xE418) sends the stage's song out of
     * the sixteen codes at data 0x1E900, by stage_num & 15; `ambience` is the
     * stage's own sound effects, js/sound/ambience.js.
     */
    sound: {
        program: ['epr-17574.30', 0x4d4c3a55],
        samples: [
            ['mpr-17573.31', 0xe43557fe], ['mpr-17572.32', 0x4febecc8],
            ['mpr-17571.36', 0x51caa584], ['mpr-17570.37', 0xbccd324b],
        ],
        stageMusic: 0x1e900,
        stageMusicRegion: 'mainData',
        ambience: { scene: 0x1e940, round: 0x1e980, end: 0x1e9c0, players: 0x44044 },
    },
    /* `layers` for the Great Wall's banners, painted in the wall's own plane:
     * the brick showed through their edges (issue 87). See TECHNICAL.md,
     * "Faces laid on faces". */
    depth: { recede: 0, nearMin: 0.1, layers: true },
    scenes: null,
    /* The fighters, posed out of Sonic The Fighters' motion format on a rig of
     * this game's own; js/vf2fighters.js. `standardRig` is the table every
     * fighter is solved on, `fighters` the roster's records. */
    motionTable: { list: 0x2120004, count: 1360 },
    /*
     * The sway chains (js/osage.js): Fighting Vipers' code a game earlier,
     * the same records, and the coprocessor's Fn_osage (0x4A, TGP 0xCFA)
     * the same keep-out to the float. The definitions by record,
     * `0x658A4[+0x1B0*4]`, 26 of them; Dural, Mue and Kojacky have none,
     * nor do their 2P looks. Gravity 0x3B32674F. The wind is 0x654E0's two
     * entries a record, by 0x500064 as Fighting Vipers' is. Left out: the
     * tables the game modes 0xE/0xF and a Lau-against-Lau fight switch to
     * (0x696D4, 0x697E8), and the per-player switch at *0x500814 under
     * which only Shun's first chain draws, and only with the gourd in hand
     * (0x64348, 0x65458).
     */
    osage: {
        table: 0x000658a4, count: 26, gravity: 0.002722222125157714, head: 2,
        wind: {
            table: 0x000654e0,
            stages: {
                0: { angle: 0x8000, entry: 1 }, 1: { angle: 0xf000, entry: 0 },
                5: { angle: 0xc000, entry: 1 }, 8: { angle: 0x7000, entry: 0 },
                14: { angle: 0xf000, entry: 0 },
            },
        },
    },
    rig: {
        kind: 'vf2',
        standardRig: 0x296a0,
        /* The floor shadows (js/fightershadow.js): 0x61BA0's tables by
         * +0x1B1 mod 13, 0x176A0's balls, the light from the stage records'
         * +0x70 and +0x72 (0xCE1C), the ring's half-width at the factory setting (0x50A00C, 7.5)
         * and the ground (0x50A010, 0x99CC). */
        shadow: {
            tables: 0x61cfc, count: 13, ring: 7.5, ground: -0.5, leave: { x: 1 },
            balls: { counts: 0x2007c68, lists: 0x2007bee, points: 0x20078a8 },
            stages: { at: 0x6ee38, stride: 256, light: 0x70 },
        },
        /* The fighters in the Mirror stage's floor (js/vf2reflection.js):
         * 0x20488 under stage flag bit 5, 0x19C94 from record +0x34; the
         * head piece's (0x193CC) while the head is at or above the floor
         * and within the ring (0x50A00C, 7.5) less 1. */
        reflection: { list: 0x34, bit: 5, stages: { at: 0x6ee38, stride: 256, flags: 0x68 }, piece: { ring: 7.5, less: 1 } },
        /* The action table is record +0x14 as in Fighting Vipers:
         * action_init (0x13F1C) puts it at player +0x1A0, and the action
         * code reads it to +0xA6, 84 motion ids, the stance first. */
        fighters: {
            records: 0x200620c, count: 13, p2: 13, names: VF2_NAMES, actions: { at: 0x14, count: 84 },
            /* The input programs by +0x1B1 (`ld 0x1D1FC[r15*4]` at 0x1BBD4;
             * the handlers at 0x1D250). Fighting Vipers' opcodes, to 0x33:
             * 0x32 and 0x33 jump to their u32 while bit 6 of the settings'
             * byte `[0x50016C]+0x3351` is set and clear, else step 5. MAME's
             * vf2 has it clear, so 0x33 is the one that jumps. */
            commands: { table: 0x0001d1fc, isa: { ops: 0x34, jumps: { 0x32: false, 0x33: true }, length: 5 } },
            /* The hands' 32 shapes each, record +0x3C: slot 5's at +0,
             * slot 8's at +0x180 (0x19E34); js/fighterhands.js. */
            hands: { at: 0x3c, other: 0x180, eased: true },
            /* The face (js/fighterhands.js): script op 16 (0x1B2B0) starts
             * the chain 0x2006278[op][char], action_init (0x4B5D0) the one
             * at 0x20062A0[char], and 0x4B640 steps it after the script.
             * Script op 9 (0x1B05C) sets the voice's time left, +0x770,
             * from 0x201E498[op][char] when 0x201E44C names a voice; at
             * `talk.at` left the chain switches to 0x2006278[talk.to]
             * unless it is already on [talk.keep]'s. The picker's entry
             * gives its word at `p2` while +0x1B0 is not +0x1B1 (0x4B74C),
             * player 2's look; +8 under +0x700 bit 4, which the fighter's
             * load clears (0x1408C) and nothing in a motion sets, is left
             * out. */
            face: {
                op: 16, table: 0x02006278, cold: 0x020062a0, eased: true, p2: 4,
                talk: { op: 9, voices: 0x0201e44c, times: 0x0201e498, at: 25, keep: 1, to: 2 },
            },
            /* Script op 17 (0x1B2D0), on its own frame, sets +0 bit 27 when
             * its byte is 1 and clears it otherwise; the fighter's load
             * (0x14098) clears it. While it is set rob_disp's part loop
             * (0x19530, 0x19544) draws `model` on slot 8, or slot 5 when
             * mirrored (+0 bit 6, z negated), moved by `offset` and turned
             * `turn` about Z: Shun's gourd. */
            item: { op: 17, model: 0x98a, slots: [8, 5], offset: [0.15, 0.01, 0.03], turn: 0x9df0 },
            /* The midriff, record +0x38: Fighting Vipers' struct, built at
             * 0x16F3C and drawn on slot 9 at 0x195F8; no broken one. */
            midriff: { at: 0x38 },
            /* The same struct's word +0xC: rob_disp (0x19090) draws it on
             * slot 9 while the waist (+0x1F8) is under `under`, or `bit15`
             * with move flag 15. Lau's and Shun's differ from slot 9's. */
            lowHips: { at: 0x38, model: 0xc, under: 0.2, bit15: 0.4 },
            /* Record +0x40: the fighter's load (0x13FF8) copies its model
             * to +0x704 and its offset (+0x10) to +0x708, and sets +0x700
             * bit 0 when the model is not 0. rob_disp's slot 2 (0x19298)
             * then draws it on the head, moved by the offset and turned Z
             * then X by `turns`, or by `own[+0x1B0]`'s (0x192F8). Kage's
             * and Pai's. The struct's +8 (+0x75C) is its reflection's
             * model, which 0x193CC draws in the Mirror stage's floor. */
            headPiece: { at: 0x40, offset: 0x10, reflection: 8, turns: [[2, 0x4000], [0, 0x4000]], own: { 6: [[2, 0x4000], [0, 0x8000]] } },
        },
        /* What the one hit plays; js/reactions.js. set_mot_dat (0x1A1E4)
         * reads 0x200D34C[motion] past an 8-byte head with the lengths at
         * 0x1B7F6 (ops to 0x11); op 4 keeps the kind at +0xA, and the
         * picker (0x230D4) reads 0x201CCFC[kind], 30 kinds. */
        reactions: { setups: 0x0200d34c, head: 8, lengths: 0x1b7f6, ops: 0x12, strike: 0xa, table: 0x0201ccfc, kinds: 30 },
        /* The move script's op lengths, by the handlers 0x1AD5C runs
         * (table 0x1B910); js/fighterhands.js. */
        script: [0, 3, 3, 13, 7, 4, 4, 4, 4, 4, 9, 7, 4, 4, 7, 3, 4, 4, 7, 5, 7, 4, 5, 6],
        /* The move flags as Fighting Vipers', but 0x1AC14 drops bit 28 where
         * it drops 26, script op 13 is bit 27 (0x1B23C), and set_mot_dat
         * gives two motions a third frame of their own (0x1A49C, 0x1A4A8). */
        flags: { drop: 0x10010100, op13: 27, ends: { 0x12e: 0x49, 0x375: 46 } },
        /* The look's gate, 0x28668. */
        look: { gate: 0x6c111 },
        /* The same, 0x27130: the record's byte +6 is +0x814, a word before
         * with bit 23 does not blend either, and bits 18 and 19 both blend
         * in only. */
        blendIn: { stance: 6, before: 1 << 23, inOnly: 3 << 18 },
        /* The stance poses, 0x270D4. */
        blendOut: [0, 1, 8, 10, 31],
    },
    /* The Cells tab (js/cells.js), on Daytona's terms: no pattern table.
     * The draw (0x8F1C) takes the record's address from an lda or from a
     * table of absolute pointers, and reads the halfword at 0x02 as Daytona's
     * does. The records lie end to end in `records`; each run stops at a
     * strip of frames 0x8FE0 draws one frame of (the timer's digits, the
     * round marks), whose header has a frame count Daytona's has not, or
     * where the next words are no record. The loaders are two: 0x23EE8 takes
     * a CG list and 0x23F30 a palette list, each by its own lda, so a CG is
     * the pair one routine loads (`cgLists`): the boot pair (through the
     * pointer at 0x2800000), the stage skies (0x24314, the stage record's
     * +0x08 and +0x0C, `cgPairs`), the fight's own on top of a sky (0x10838),
     * and the rest. 0x31A34 loads two: they are two CGs here, the second
     * under the first. Some lists and records are in the program ROM, named
     * at their own addresses (`programAt0`). The tile layer goes through
     * colorxlat as the sky's does. */
    cells: {
        records: [
            [0x13d3c, 0x13f08], [0x345ec, 0x346b6], [0x763f0, 0x76974],
            [0x2a67d0c, 0x2a67d84], [0x2a67e44, 0x2a67e66], [0x2a6845a, 0x2a69f82],
            [0x2a6a22e, 0x2a719c2], [0x2a71a4a, 0x2a7905a], [0x2aa8346, 0x2ab03ce],
            [0x2ab0906, 0x2ab488e], [0x2ab587e, 0x2ab596e], [0x2ab5be6, 0x2ab5d7c],
        ],
        cgPairs: [
            [0x280000c, 'boot'],
            [0x25034, 'stage 0 sky'],
            [0x25054, 'stage 1 sky'],
            [0x25074, 'stage 2 sky'],
            [0x25094, 'stage 3 sky'],
            [0x250b4, 'stage 4 sky'],
            [0x250d4, 'stages 5, 15 sky'],
            [0x250f4, 'stage 6 sky'],
            [0x25114, 'stage 7 sky'],
            [0x25134, 'stage 8 sky'],
            [0x25154, 'stages 9, 12, 13, 14 sky'],
            [0x25174, 'stages 10, 11 sky'],
        ],
        cgLists: [
            [0x0001256c, 0x00012520, '0x11B70'],
            [0x02800380, 0x02805abc, '0xAF54'],
            [0x02800394, 0x02805890, '0xB424'],
            [0x02800280, 0x02804160, '0x10388'],
            [0x000734a4, 0x00073418, 'fight, 0x10838'],
            [0x028002d4, 0x02805224, '0x2DB94'],
            [0x028000d0, 0x02800b38, '0x31A34'],
            [0x00033f1c, 0x00033ef0, '0x31A34, second'],
            [0x028003b0, 0x02805c28, '0x60624'],
        ],
        /* Cells a routine draws straight after it loads a CG: 0x11B70's
         * (CG 12) at 0xBBF4, 0xAF54's (13) at 0xAF94, 0x2DB94's (17) at
         * 0x2DC00-0x2DC3C, 0x31A34's (18) at 0x31A8C and 0x60624's (20) at
         * 0x6064C-0x60688. */
        screens: [
            { cg: 12, cells: [0] }, { cg: 13, cells: [260] }, { cg: 17, cells: [152, 155, 156] },
            { cg: 18, cells: [87] }, { cg: 20, cells: [255, 256, 257, 258] },
        ],
        charBytes: 0x80000,
        colorxlat: true,
        programAt0: true,
    },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};

/* Dead or Alive's stage 4 conveyor fix (doab's `doa.fixes`), for a program
 * `shift` bytes below Revision B's. */
function doaConveyorFix(shift) {
    return [
        [0x6a0b4, 0x5a7628, 0x5a761c], // ld row 2's height, g4
        [0x6a0bc, 0x5a761c, 0x5a7628], // ld row 3's height, g7
        [0x6a0c0, 0x6805e294, 0x68052297], // cmpr g7, g4
        [0x6a0cc, 0x5a7620, 0x5a762c], // ld row 3's z
        [0x6a0dc, 0x5a7618, 0x5a7624], // ld row 3's x
    ].map(([a, was, now]) => [a - shift, was, now]);
}

/*
 * Dead or Alive, Revision B: the Model 2B board.
 *
 * The program does not keep its stages as tables. Each stage is a routine
 * (`ld 0x719E0[stage]`, called from 0x71BC0 with the stage number in RAM byte
 * 0x5555BE) that builds its matrices on the coprocessor and draws piece by
 * piece, so js/doa.js runs it: an i960 interpreter (js/i960.js) and a
 * coprocessor that does the routines' arithmetic. `visible` are the two cull
 * tests the routines call, answered "in front"; `pokes` is RAM the routines
 * read — 0x54FCDD is set, which draws the Danger Zone's banners and ropes
 * (0x65F70) as the attract mode's fights do. 0x5A75F4 is 2: the round start
 * (0x7086C calls 0x70950) sets it from the float at 0x54FCE8, which boot leaves
 * at 10.0 (0x44D8), and nine stages index short model tables with it (stage
 * 1's floor at 0x65F08 and 0x66AF8), so it picks which version of two
 * pieces they send. MAME holds 2 there through the attract.
 */
const doab = {
    id: 'doab',
    name: 'Dead or Alive (Model 2B, Revision B)',
    identify: ['epr-19379b.15', 'epr-19380b.16'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x00000, 'epr-19379b.15', 0x8a10a944, 'epr-19380b.16', 0x766c1ec8]],
        },
        /* MAME copies the last pair up to 0x1C00000 as well; nothing read
         * here comes from that copy. */
        mainData: {
            size: 0x1c00000,
            parts: [
                [0x0000000, 'mpr-19318.11', 0xab431bfe, 'mpr-19319.12', 0xc5cb694d],
                [0x0800000, 'mpr-19316.9', 0x2d2d1b1a, 'mpr-19317.10', 0x96b17bcf],
                [0x1000000, 'mpr-19314.7', 0xa8d963fb, 'mpr-19315.8', 0x90ae5682],
                [0x1800000, 'mpr-19312.5', 0x1dcedb10, 'mpr-19313.6', 0x8c63055e],
            ],
        },
        polygons: {
            size: 0x1800000,
            parts: [
                [0x0000000, 'mpr-19322.17', 0xd0e6ecf0, 'mpr-19325.21', 0x7cbe432d],
                [0x0800000, 'mpr-19323.18', 0x453d3f4a, 'mpr-19326.22', 0xb976da02],
                [0x1000000, 'mpr-19324.19', 0x0d6bf454, 'mpr-19327.23', 0x6a75634c],
            ],
        },
        /* The material and texture-point streams the model table points at. */
        textures: {
            size: 0x800000,
            parts: [[0x000000, 'mpr-19321.27', 0x9c49e845, 'mpr-19320.25', 0x190c017f]],
        },
    },
    modelTable: { offset: 0x0003a160, count: 19330, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* The boot copies 484 colours out of the program ROM to palette RAM
     * 0x1802000 (0x70D80): a count and then the colours. `tables` points at
     * the `ldos 0x62A40` operand that names them. */
    palette: { tables: 0x70d84, sets: 1, split: 0 },
    /* Raw sheets, filled from slabs (js/texture.js buildDoaTexram): a stage's
     * set is its number. The slabs carry no mip chain -- MAME's texture RAM
     * leaves rows 768-1023 empty on both sheets and still draws the far walls
     * -- so the viewer stays on the full-size level (Viewer.setMipLevels). */
    texture: {
        raw: { layout: 'doa', stageSlabs: 0xcada0, charSlabs: 0xcade0 },
        sets: 16,
        residentSet: null,
        defaultSet: 1,
        mips: false,
    },
    /* Luma is 0x4000 bytes from data 0xFC0000 (0x10D0); colorxlat is a grey
     * ramp with the stage's colours over rows 21-29 and the attract fighters'
     * over rows 1-9 and 11-19 (js/colors.js buildDoaColorxlat). Both match
     * MAME's RAM byte for byte. */
    colors: {
        luma: { data: 0xfc0000, bytes: 0x4000 },
        doa: {
            stages: 0x7a7e0, count: 16, row0: 21, rows: 5,
            fighters: { table: 0x7a760, perCostume: 15, rows: [1, 11] },
        },
    },
    /*
     * The boot uploads 31 material slots from program 0x6B0 (geometry-engine
     * function 6). The light is the fighter's — a point the routine at
     * 0x16760 takes through the camera each frame — and for a stage alone it
     * is this fixed one, what MAME's display list holds with the camera
     * square on: down and away from the viewer.
     */
    lighting: {
        light: [0, -Math.SQRT1_2, -Math.SQRT1_2],
        materials: { at: 0x6b0, count: 32 },
    },
    doa: {
        routines: 0x719e0,
        count: 16,
        stageByte: 0x5555be,
        /* RAM js/doa.js sets by hand: the view vector the culls dot with,
         * the board's frame count, the stage's light, and the fight code's
         * per-player records and tables (js/doa.js startPlayer). */
        ram: {
            viewVector: 0x5b9870, frameCount: 0x54b158, light: 0x5555b0,
            player: 0x54fbe0, facing: 0x550124, bodyScales: [0x56ac50, 0x588ee0],
            modelBase: 0x5a6ed0, expression: 0x58828c,
            speed: 0x56ada0, heading: 0x56ac28, height: 0x589b80,
        },
        visible: [0x72600, 0x72680],
        pokes: [[0x54fcdd, 1], [0x5a75f4, 2]],
        /* Stage 4's conveyor (rows of x y z, 12 bytes each from 0x5A7600)
         * draws a copy of the row that has just wrapped, a lap lower, so it
         * reads as one belt. The fourth of those copies (0x6A0B0) tests row 3
         * against row 2 but then draws row 2's place: a copy-paste slip that
         * leaves a row hanging 80 below the rest for a quarter of the cycle.
         * The fix loads the two heights the other way round (g7 = row 3's,
         * the one drawn) and row 3's x and z. Only with "fix errors" on,
         * as DAYTONA_PATCHES (doa.js fixedProgram). */
        fixes: doaConveyorFix(0),
        /* The sky: four scroll pictures a stage, named in the program, out of
         * the table of pictures in the data (js/scroll.js buildDoaSky).
         * `lines`: the stages whose sky the tile chip scrolls line by line
         * (11: the sky routine sets bit 15 of layer 2's scroll, 0x6FE70), from
         * the line table the stage's `after` routine fills (layer 2's, tile RAM
         * 0x1008800, a short a screen line), with the layer's vertical scroll
         * (0x54F950, the program's copy of the register) and the scroll the
         * routine keeps for every line (0x5A0140). js/doa.js doaLineShift. */
        sky: {
            pictures: 0x20c0000, stages: 0xc7660, skyless: [4, 5, 6, 7, 9, 12, 13, 14, 15],
            lines: { stages: [11], table: 0x1008800, count: 384, vscroll: 0x54f950, scroll: 0x5a0140 },
        },
        /* The stages whose routines move pieces of them each pass (state at
         * 0x5A0000-0x5A7667, stage 8's one piece also by the frame count),
         * and the game's setups for them: the stage task's common one
         * (0x70480, 0x64640 runs it) and each stage's own, from the table
         * the round start (0x705F0) calls by stage number. Those stages are
         * run as many passes as the attract's stage, to the same frame
         * count (attract.frame). `tick` is the stage task's count-up after
         * each pass (0x5A75F0 +0x80 and the byte 0x5A6EDD +1): stage 4's
         * belt and stage 10's turn run on it. `after` are a stage's own
         * routines the stage task runs before the tick (0x71130): stage 11's
         * sky scroll 0x702E0, which steps its wave (0x5A0144, a byte a pass
         * and 0x5A0145 every fourth) and keeps the camera's sky scroll
         * (0x54F948) in 0x5A0140. Stage 1's ropes and banners swing the
         * same way; on doab the attract's own run of it comes first, and
         * doaa, which has no attract, runs it from here. Graded against
         * MAME's attract (tools/doa-stages): 1, 3, 4, 5, 6, 7 and 8 match it
         * word for word over 299 frames; 0, 2, 10 and 11 (0x5A0140 alone)
         * differ only where they follow the camera. */
        stageSetup: { common: 0x70480, table: 0x70440, moving: [0, 1, 2, 3, 4, 8, 10, 11], frames: 924, clock: 0x75f, after: { 11: [0x702e0] }, tick: 0x71138 },
        /* The fight code (js/doa.js runDoaFighters), run a frame at a time
         * as the board's fight loop runs it. `heights` is the table of one
         * float a character the skeleton scales the hips' lift by. `boot` is
         * floats the boot sets (0x44B8): the ring's size, which the round
         * start halves into the bounds a shadow lands on the floor inside.
         * The pokes are what the fight sets: 0x54FCDD/0x54FC93 pick the body
         * path, 0x54FC94 4 takes the shadows' slant from the stage, 0x589DB0
         * lets the ribbon swing. The round start also fills the fight's
         * tables (`tables`, 0x25870 for each of 13), copies the stage's grid
         * (`grid`, what 0x70764 does: the singles and bytes the ribbon reads
         * under the feet, from a second table on stages 2 and 5) and resets
         * each player (`roundReset`: its health, 0xFF, and the round's
         * counts). `camera` is the camera task, `frameWait` the wait for the
         * next frame it loops on, `ai` the attract's AI task: its start and
         * the head of its loop. `headCheck` is what the body routine asks
         * before it draws the head and face (0x45FA8): no while the player's
         * +0x2D is 0 and its +0x2A at most 17 and not 5, as a record stands
         * that no action script has run on. `commands` is the table of
         * each character's commands (js/doafighters.js moveCommand). */
        fighters: {
            heights: 0xc1e80, load: 0x407a0, clearRibbon: 0x4f930, setup: 0x41900,
            player: 0x41a50, ribbon: 0x4feb0,
            motion: 0x420c0, headCheck: 0x51dc0, commands: 0x91c60,
            roundStart: 0x54660, frameStart: 0x4df20, frameEnd: 0x4ddc0,
            tables: { at: 0x25870, count: 13 },
            grid: { cells: 0x5a6f00, bytes: 0x5a7520, from: [0xc7ca0, 0xc88e0], alt: { stages: [2, 5], from: [0xc82c0, 0xc89a4] } },
            roundReset: 0x1b430,
            camera: 0x7d1b0, frameWait: 0x8240, ai: { start: 0x25bd0, frame: 0x25cf4 },
            /* The hit and push checks, then the fight's tasks: the hits
             * (0x1FDD0), the reactions to them (0x24FD0) and the rest. */
            collision: [0x3e1e0],
            fight: [0x1fdd0, 0x24fd0, 0x21400, 0x22ef0, 0x231d0, 0x1fe80, 0x23c80],
            moversStart: 0x2f550, movers: [0x2f5e0, 0x2f670, 0x2fb40, 0x2fd50, 0x2ff70],
            boot: [[0x54fd5c, 24], [0x54fd60, 24]],
            pokes: [[0x54fcdd, 1], [0x54fc93, 2], [0x54fc94, 4], [0x589db0, 1]],
        },
        /* The attract fight MAME shows at frame 2000 on stage 1: Zack against
         * Tina, from the round's start. `base` is the player's model bank
         * (0x5A6ED0), `pos` and `angles` where the round starts it,
         * `expression` the face model (0x58828C) and `open` its record on the
         * fight's first frame. `light` is the
         * stage's light, `first` and `frame` the board's frame count
         * (0x54B158) on the fight's first frame and on the one drawn: the
         * board shows a frame's display list on the next, so MAME's frame
         * 2000 is loop 0x75F's. `camera` is the camera task's state on the
         * first frame, from MAME's RAM. `ai` is what the attract's script
         * sets for the AI before the fight: its op 0x1A370 each player's start
         * flag (0x5555F2/F3) and pattern (0x5555F4/F5, from the table at
         * 0x90E50: Zack 0, Tina 1), its op 0x1AEE0 0x5555CB. The stage's
         * ropes and banners swing in RAM the stage routine steps each time it
         * draws (0x74460, a pendulum, and a 32-frame ring of its angles down
         * each rope), from what the stage setup (`stageInit`, 0x70480) clears:
         * `stageFrames` is the routine's passes from the setup to the frame
         * drawn, 924, which is when MAME's RAM is the routine's own byte for
         * byte. */
        attract: {
            stage: 1,
            stageInit: 0x70480,
            stageFrames: 924,
            light: [0.2387, 0.8988, -0.3677],
            first: 0x6b0,
            frame: 0x75f,
            camera: [
                [0x5bf840, 0x11000000], [0x5bf844, 0x11200000], [0x5bf870, 0x10a],
                [0x5bf880, 0x3fef6f83], [0x5bf884, 0x40083127], [0x5bf888, 0x3db9b7a7],
                [0x5bf88c, 0x3ff09dc2], [0x5bf890, 0x400dc87c], [0x5bf894, 0x3f8bde4e],
                [0x5bf898, 0x38b], [0x5bf89c, 0x7f9f], [0x5bf8a4, 0x3f80c0c1],
                [0x5bf8b0, 0x3fef6f83], [0x5bf8b8, 0x3f800000], [0x5bf8c0, 0x22],
                [0x5bf8c8, 0x3fef6f83], [0x5bf8d0, 0x3f800000], [0x5bf8d8, 0x3db9b7a7],
                [0x5bf8e0, 0x3db9b7a7], [0x5bf8e8, 0x2201], [0x5bf8f8, 0xcc9b4],
                [0x555584, 0x3fde613e], [0x555588, 0xffff85aa], [0x55558c, 0x23],
                [0x555590, 0x38b], [0x555594, 0x7f9f], [0x555598, 0x3ff09dc2],
                [0x55559c, 0x400dc87c], [0x5555a0, 0x3f8bde4e], [0x5555a4, 0x3fef6f83],
                [0x5555a8, 0x40083127], [0x5555ac, 0x3db9b7a7],
            ],
            /* The words of `camera` that hold a program address (the path
             * the camera follows), for a build whose program has moved. */
            programWords: [0x5bf8f8],
            ai: [[0x5555f2, 1], [0x5555f3, 1], [0x5555f4, 0], [0x5555f5, 1], [0x5555cb, 2]],
            fighters: [
                {
                    char: 0, base: 80, pos: [5.5, 1, 0.5], angles: [0, 0, 0],
                    open: { state: [0x28, 0, 0x29, 0, 0x2d, 0, 0x36, 1] },
                },
                {
                    char: 1, base: 798, pos: [6.5, 1, 0.5], angles: [0x9f48, 0x9f48, 0x9f48], expression: 1,
                    open: { angles: [0x8000, 0x9f48, 0x9f48], state: [0x29, 8, 0x36, 1] },
                },
            ],
        },
    },
    /*
     * The sound board is the Model 2 board, its UART at 0x9C0000 on the 2B
     * (sends queued at 0x94C0, sent at once by 0x9590). The round start
     * (0x18480) sends the stage's song straight from the table at 0x90C10,
     * by stage number: A01001-A01010, or A00001, all sound off, for stages
     * 6, 7, 9 and 15. The song names are in the data ROM at 0x9C860: stage
     * 5's A01010 is BGM_BOSS, and stage 9 is the name entry, whose setup
     * (0x1C6F8) sends A0100E, BGM_NAME, itself. The attract skips the table (0x54FC94
     * is 4 there) and plays A0100A on every stage. MAME, a coined game:
     * stage 5 starts A01010, 6 A00001, 11 A01002.
     *
     * The boot sends A00001. The driver takes its first command about four
     * seconds after a reset (`warmup`; MAME's i960 sends it nine seconds in).
     * The 0xFF the i960 writes as it sets the UART up comes long before that
     * and is never heard; sent once the driver listens, it eats the next
     * command, so it is left out.
     */
    sound: {
        program: ['epr-19328.31', 0x400bdbfb],
        samples: [
            ['mpr-19329.32', 0x8fd2708a], ['mpr-19330.33', 0x0c69787d],
            ['mpr-19331.34', 0xc18ea0b8], ['mpr-19332.35', 0x2877f96f],
        ],
        boot: [0xA0, 0x00, 0x01],
        stop: [0xA0, 0x00, 0x01],
        warmup: 5,
        stageMusic: 0x90c10,
        none: 0xa00001,
        songs: { 9: 0xa0100e },
        replaces: true,
        /* The fight only goes to nine stages, the fighters' own (the orders at
         * 0x90BE0 and 0x90BF0: 11 3 8 10 0 2 1 4 5), each with its fighter's
         * theme, which the table by character at 0x90C40 also names; 6 and 7
         * are never fought on and have none. The explorer lets any theme play
         * on any stage. */
        music: {
            region: 'mainCpu', table: 0x90c40, own: "the stage's own",
            picks: [[0, 'Zack'], [1, 'Tina'], [2, 'Jann Lee'], [4, 'Ryu'], [5, 'Kasumi'], [6, 'Genfu'],
                [8, 'Bayman'], [11, 'Raidou'], [12, 'Leifang']],
            hint: 'The song the stage plays. The game plays the stage\'s own, its fighter\'s theme; stages 6 and 7 are never fought on and have none. This plays any fighter\'s theme instead',
        },
    },
    stageTable: { doa: true, flat: true },
    depth: { recede: 0, nearMin: 0.1, layers: true },
    scenes: null,
    /* The fighters on the animation tab, posed by the fight code itself
     * (js/doafighters.js): the roster (character number, name), the model
     * banks and the loads that pick a row of them, the two motion tables
     * ([pointer, first id, count]), the action scripts and the group
     * everyone shares. */
    rig: {
        kind: 'doa',
        note: 'doa',
        roster: [
            [0, 'Zack'], [1, 'Tina'], [2, 'Jann Lee'], [4, 'Ryu'], [5, 'Kasumi'],
            [6, 'Genfu'], [8, 'Bayman'], [11, 'Raidou'], [12, 'Leifang'],
        ],
        banks: 0xc59d2,
        loads: 0xc3380,
        motions: [[0x6000000, 0, 0x552], [0x6c00004, 0x552, 249]],
        scripts: 0xd8000,
        common: 13,
    },
    /* The 2D pictures (js/cells.js): the 242 pictures of data 0xC0000, three
     * pointers each, tiles, colours and map, the table the sky's pictures
     * come from too. Each brings its own tiles, so a cell's CG is its own.
     * The loader (0x9000) keeps a bitmap of the 128 blocks of character RAM
     * (0x54F980) and puts each picture in the first free run, so pictures on
     * screen together never share tiles. The data is the same in every
     * build. */
    cells: { pictures: { table: 0x020c0000, count: 242 }, charBytes: 0x80000 },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};

/*
 * The 2A board seats the same data, model, texture and sound chips in other
 * sockets, so MAME's 2A sets name them by those: Revision B's name, the 2A's.
 * A 2A set and a 2B set dropped together find each other's by checksum.
 */
const DOA_2A_SOCKETS = {
    'mpr-19318.11': 'mpr-19318.10', 'mpr-19319.12': 'mpr-19319.11', 'mpr-19316.9': 'mpr-19316.8',
    'mpr-19317.10': 'mpr-19317.9', 'mpr-19314.7': 'mpr-19314.6', 'mpr-19315.8': 'mpr-19315.7',
    'mpr-19312.5': 'mpr-19312.4', 'mpr-19313.6': 'mpr-19313.5', 'mpr-19322.17': 'mpr-19322.16',
    'mpr-19325.21': 'mpr-19325.20', 'mpr-19323.18': 'mpr-19323.17', 'mpr-19326.22': 'mpr-19326.21',
    'mpr-19324.19': 'mpr-19324.18', 'mpr-19327.23': 'mpr-19327.22', 'mpr-19321.27': 'mpr-19321.25',
    'mpr-19320.25': 'mpr-19320.24', 'epr-19328.31': 'epr-19328.30', 'mpr-19329.32': 'mpr-19329.31',
    'mpr-19330.33': 'mpr-19330.32', 'mpr-19331.34': 'mpr-19331.36', 'mpr-19332.35': 'mpr-19332.37',
};
const doa2A = (chip) => chip.map((x) => DOA_2A_SOCKETS[x] ?? x);
const doa2ARegions = (regions) => Object.fromEntries(Object.entries(regions)
    .map(([k, r]) => [k, { ...r, parts: r.parts.map(doa2A) }]));

/* The fight code's routines: every one a program address. */
const DOA_FIGHT_CODE = ['load', 'clearRibbon', 'setup', 'player', 'ribbon', 'motion', 'headCheck',
    'roundStart', 'frameStart', 'frameEnd', 'roundReset', 'camera', 'frameWait', 'moversStart', 'heights',
    'commands'];

/*
 * Revision A's fight code, from Revision B's. Revision A is an older program,
 * not B moved: the fight code between 0x40000 and 0x56000 differs in many
 * small places, so these runs are not the whole program's. Each was found by
 * looking for 24-byte windows round one of the addresses the fighters'
 * profile names (routines, tables, the attract's camera path) and taking the
 * shift on which they matched once; every named address falls in the run it
 * is shifted by, and the routines' first instructions are Revision B's but
 * for their call targets. The frame start (0x4DF20, 0x46660 here) is the
 * same code with moved calls. The RAM is the same.
 */
const DOAA_FIGHT_PROGRAM = [
    [0x00000, 0x0], [0x08000, 0x20], [0x1b000, -0x7430], [0x40000, -0x7490],
    [0x41800, -0x74b0], [0x4dd00, -0x78c0], [0x51d00, -0x79d0], [0x54000, -0x7a40],
    [0x7d000, -0x7a20], [0x89000, -0x79c0], [0xd8000, 0x0],
];
const doaaFight = (a) => relocate({ relocation: DOAA_FIGHT_PROGRAM }, a);

/*
 * The `doaa` set: Revision A on the Model 2A board. Only the program differs;
 * the data, model and texture chips are doab's, in the 2A's sockets. The
 * model table is in those data chips, so it has not moved;
 * the stage code and the program's tables sit 0x7A40 lower than Revision B's
 * (the sky's stage table 0x79C0), and its RAM is laid out the same.
 */
const doaa = {
    ...doab,
    id: 'doaa',
    name: 'Dead or Alive (Model 2A, Revision A)',
    identify: ['epr-19310a.12', 'epr-19311a.13'],
    identifyCrc: [0x06486f7a, 0x1be62912],
    regions: {
        ...doa2ARegions(doab.regions),
        maincpu: {
            size: 0x100000,
            parts: [[0x00000, 'epr-19310a.12', 0x06486f7a, 'epr-19311a.13', 0x1be62912]],
        },
    },
    palette: { ...doab.palette, tables: 0x69344 },
    texture: { ...doab.texture, raw: { layout: 'doa', stageSlabs: 0xc33e0, charSlabs: 0xc3420 } },
    colors: {
        ...doab.colors,
        doa: { ...doab.colors.doa, stages: 0x72da0, fighters: { ...doab.colors.doa.fighters, table: 0x72d20 } },
    },
    doa: {
        ...doab.doa, routines: 0x69fa0, visible: [0x6abc0, 0x6ac40], fixes: doaConveyorFix(0x7a40),
        sky: { ...doab.doa.sky, stages: 0xbfca0 },
        stageSetup: { ...doab.doa.stageSetup, common: 0x68a40, table: 0x68a00, after: { 11: [0x688a0] }, tick: 0x696f8 },
        fighters: relocateDoaFighters(doab.doa.fighters, doaaFight, (a) => a),
        /* Revision B's attract scene, for the Animation tab's fighters: its
         * stage, light, frame count and camera. Revision A's own attract
         * fight has not been checked against MAME, so stage 1 is drawn
         * without it (`onStage`), from the stage setup as before. */
        attract: { ...relocateDoaAttract(doab.doa.attract, doaaFight, (a) => a), onStage: false },
    },
    rig: {
        ...doab.rig,
        banks: doaaFight(doab.rig.banks), loads: doaaFight(doab.rig.loads), scripts: doaaFight(doab.rig.scripts),
    },
    /* The same songs, the table 0x79C0 lower; the name entry's at 0x152D0. */
    sound: {
        ...doab.sound, program: doa2A(doab.sound.program), samples: doab.sound.samples.map(doa2A),
        stageMusic: 0x89250, music: { ...doab.sound.music, table: 0x89280 },
    },
};

/*
 * The other Dead or Alive builds MAME knows, each a build above with its
 * program moved: code put in or taken out in places, so what follows sits
 * further on (or back), as with Sonic Championship. The runs were found the
 * same way, matching the two programs 16 bytes at a time; each run starts at
 * the first block that matched with that shift, and everything the explorer
 * names falls well inside one (checked address by address). Revision C also
 * moved its RAM: the runs `ram` gives, found by pairing the RAM addresses the
 * two programs' matched instructions name. The 2A builds keep doaa's RAM but
 * for a few globals (below).
 */
const DOA_C_PROGRAM = [
    [0x00000, 0x0], [0x02780, 0x10], [0x08430, 0x20], [0x09370, 0x30],
    [0x1a9f0, 0x70], [0x1b530, 0x80], [0x1bb50, 0xd0], [0x288f0, 0xb0],
    [0x91280, 0xd0], [0x91b80, 0x3af0], [0xd8000, 0x0],
];
const DOA_C_RAM = [[0x500000, 0x0], [0x5420d0, 0x20], [0x557c60, 0x30], [0x600000, 0x0]];
const DOAAB_PROGRAM = [
    [0x003d0, 0x1c0], [0x04560, 0xe0], [0x06520, -0x14], [0x06990, -0x34],
    [0x06be0, -0x30], [0x11150, -0x70], [0x820e0, -0x180], [0x82750, -0x18c],
    [0x82890, -0x190], [0x82ba0, -0x1f0], [0x83550, -0x340], [0x88cb0, -0x370],
    [0xd8000, 0x0],
];
const DOAAE_PROGRAM = [
    [0x003d0, 0x1c0], [0x03020, 0x180], [0x04490, 0xa0], [0x06520, -0x54],
    [0x06990, -0x74], [0x06be0, -0x70], [0x0f7c0, -0xd0], [0x10b40, -0x140],
    [0x11150, -0x180], [0x309c0, -0xb0], [0x3bdc0, -0x8c], [0x3c8d0, -0x60],
    [0x814c0, 0x1b0], [0x81750, 0x1c0], [0x81bb0, 0x150], [0x820e0, 0x40],
    [0x82750, 0x34], [0x82890, 0x30], [0x82ba0, -0x30], [0x83550, -0x180],
    [0x88cb0, -0x1b0], [0xd8000, 0x0],
];

function relocateDoaFighters(F, at, ram) {
    if (!F) return F;
    const out = { ...F };
    for (const k of DOA_FIGHT_CODE) out[k] = at(F[k]);
    const ramPairs = (l) => l.map(([a, v]) => [ram(a), v]);
    return {
        ...out,
        tables: { ...F.tables, at: at(F.tables.at) },
        grid: {
            cells: ram(F.grid.cells), bytes: ram(F.grid.bytes), from: F.grid.from.map(at),
            alt: { ...F.grid.alt, from: F.grid.alt.from.map(at) },
        },
        ai: { start: at(F.ai.start), frame: at(F.ai.frame) },
        collision: F.collision.map(at), fight: F.fight.map(at), movers: F.movers.map(at),
        boot: ramPairs(F.boot), pokes: ramPairs(F.pokes),
    };
}

function relocateDoaAttract(A, at, ram) {
    if (!A) return A;
    return {
        ...A,
        stageInit: at(A.stageInit),
        camera: A.camera.map(([a, v]) => [ram(a), A.programWords.includes(a) ? at(v) : v]),
        programWords: A.programWords.map(ram),
        ai: A.ai.map(([a, v]) => [ram(a), v]),
    };
}

function relocateDoaStages(D, at, ram) {
    const S = D.stageSetup;
    const after = Object.fromEntries(Object.entries(S.after).map(([k, l]) => [k, l.map(at)]));
    return {
        ...D,
        routines: at(D.routines),
        stageByte: ram(D.stageByte),
        ram: Object.fromEntries(Object.entries(D.ram).map(([k, v]) => [k, Array.isArray(v) ? v.map(ram) : ram(v)])),
        visible: D.visible.map(at),
        pokes: D.pokes.map(([a, v]) => [ram(a), v]),
        fixes: D.fixes.map(([a, was, now]) => [at(a), ram(was), ram(now)]),
        sky: { ...D.sky, stages: at(D.sky.stages), lines: { ...D.sky.lines, vscroll: ram(D.sky.lines.vscroll), scroll: ram(D.sky.lines.scroll) } },
        stageSetup: { ...S, common: at(S.common), table: at(S.table), after, tick: at(S.tick) },
        fighters: relocateDoaFighters(D.fighters, at, ram),
        attract: relocateDoaAttract(D.attract, at, ram),
    };
}

/**
 * `base` with its program moved by the `program` runs and its RAM by `ram`:
 * every address the profile names, and nothing else, goes through them.
 */
function relocateDoa(base, { id, name, maincpu, program, ram: ramRuns = [] }) {
    const at = (a) => relocate({ relocation: program }, a);
    const ram = (a) => relocate({ relocation: ramRuns }, a);
    const { palette, texture, colors, sound, rig } = base;
    return {
        ...base,
        id, name,
        identify: [maincpu[1], maincpu[3]],
        identifyCrc: [maincpu[2], maincpu[4]],
        regions: { ...base.regions, maincpu: { size: 0x100000, parts: [maincpu] } },
        palette: { ...palette, tables: at(palette.tables) },
        texture: { ...texture, raw: { ...texture.raw, stageSlabs: at(texture.raw.stageSlabs), charSlabs: at(texture.raw.charSlabs) } },
        colors: {
            ...colors,
            doa: { ...colors.doa, stages: at(colors.doa.stages), fighters: { ...colors.doa.fighters, table: at(colors.doa.fighters.table) } },
        },
        lighting: { ...base.lighting, materials: { ...base.lighting.materials, at: at(base.lighting.materials.at) } },
        doa: relocateDoaStages(base.doa, at, ram),
        sound: { ...sound, stageMusic: at(sound.stageMusic), music: { ...sound.music, table: at(sound.music.table) } },
        rig: rig && { ...rig, banks: at(rig.banks), loads: at(rig.loads), scripts: at(rig.scripts) },
    };
}

/* Revision C, Jan 10 1997: MAME's parent set, so the one a merged set holds
 * at the top. Revision B moved, fighters and all. */
const doa = relocateDoa(doab, {
    id: 'doa',
    name: 'Dead or Alive (Model 2B, Revision C)',
    maincpu: [0x00000, 'epr-19379c.15', 0x5cc62fbe, 'epr-19380c.16', 0x58cfeaa9],
    program: DOA_C_PROGRAM,
    ram: DOA_C_RAM,
});

/* The two other 2A builds: Nov 3 1996, the Japanese one and the export.
 * Their RAM is doaa's but for a few globals, found by pairing the RAM
 * addresses matched instructions name (three or more pairs each): both move
 * the words at 0x54FD84-0x54FD97 down 4, and the export also moves the bytes
 * 0x54FC91-0x54FC94 down one (the fight's body-path and slant pokes,
 * 0x54FC93 and 0x54FC94, are 0x54FC92 and 0x54FC93 there), 0x54FCF3-F7 up
 * one, 0x54FC90 past them, and swaps the words 0x588288 and 0x58828C (the
 * face model). */
const DOAAB_RAM = [[0x500000, 0x0], [0x54fd84, -0x4], [0x54fd98, 0x0], [0x600000, 0x0]];
const DOAAE_RAM = [
    [0x500000, 0x0], [0x54fc90, 0x63], [0x54fc91, -0x1], [0x54fc95, 0x0], [0x54fcf3, 0x1],
    [0x54fcf8, 0x0], [0x54fd84, -0x4], [0x54fd98, 0x0], [0x588288, 0x4], [0x58828c, -0x4],
    [0x588290, 0x0], [0x600000, 0x0],
];
const doaab = relocateDoa(doaa, {
    id: 'doaab',
    name: 'Dead or Alive (Model 2A)',
    maincpu: [0x00000, 'epr-19310.12', 0x3c571e75, 'epr-19311.13', 0x8818363d],
    program: DOAAB_PROGRAM,
    ram: DOAAB_RAM,
});
const doaae = relocateDoa(doaa, {
    id: 'doaae',
    name: 'Dead or Alive (Export, Model 2A, Revision A)',
    maincpu: [0x00000, 'epr-19383a.12', 0x42e61481, 'epr-19384a.13', 0x034a3ab9],
    program: DOAAE_PROGRAM,
    ram: DOAAE_RAM,
});

/*
 * Cyber Troopers Virtual-On (Model 2B, Japan, Revision B). MAME's `vonj` is a
 * clone of `von`: its zip holds the program pair and takes the rest from the
 * parent's (MAME model2.cpp, ROM_START( vonj )). Routine names are the ones in
 * rokuYAMP's docs/von-rom-symbols.md.
 */
const VON_CHIPS = {
    mainData: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-18648.11', 0x2edbe489, 'mpr-18649.12', 0xe68c5aa6],
            [0x800000, 'mpr-18650.9', 0x89a855b9, 'mpr-18651.10', 0xf4c23107],
        ],
    },
    polygons: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-18654.17', 0x6a0caf29, 'mpr-18655.21', 0xa4293e78],
            [0x800000, 'mpr-18656.18', 0xb4f51e76, 'mpr-18657.22', 0xa9be4674],
        ],
    },
    /* The texture point and header streams the object triples point at. */
    textures: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-18660.27', 0xe53663e5, 'mpr-18658.25', 0x3d0fcd01],
            [0x800000, 'mpr-18661.28', 0x52b50410, 'mpr-18659.26', 0x27aa8ae2],
        ],
    },
};

/*
 * Virtual On's tile pictures. The maps are bare halfword entries, with no
 * header: each draw routine takes the map, its width and its height from the
 * caller and writes the entries to a tilemap with bits set, so the bits come
 * from the routine. 0x1DC10 (layer A), 0x1DD80, 0x1DE00 and 0x1DE80 (the
 * other three tilemaps) set 0x8000; 0x1DC90 and 0x1DD10 set 0xC000, which
 * takes the colours from the upper half of the palette; 0x1BC90 copies the
 * map as it is. VON_MAPS is every call with a constant map, as [map, width,
 * height, bits, call site in vonj], the largest where a map is drawn twice;
 * 0x2FDA1D0, the 64 by 64 zeros the game clears a layer with, is left out,
 * and so are the calls that index a table of digit glyphs (0x2EA1E50 to
 * 0x2EA2090, 0x2EA289C), 1 or 2 by 2 tiles of a counter each.
 * The robot table (program 0x20B50 in vonj, 0x68 bytes a robot) holds each
 * robot's 31 by 35 portrait (+0, drawn by 0x211F0) and its name plate (+0x4C,
 * with its width and height at +0x50 and +0x54, drawn by 0x1DC90); 0x211B0
 * holds ten 20 by 15 plans of the stages, which 0x21EB8 draws.
 *
 * The tile chip is filled by InitScroll (0x1C220: the 1bpp font from data
 * 0x2EA0BB8 as characters 0 to 0x7F, pen 1, through 0x1C730) and
 * SetScrolldata (0x1BDA0), whose argument picks the attract mode's characters
 * and colours (0, from InitAll 0x18970 and InitAdvertize 0x2B508) or the
 * game's (1, from InitGameMain 0x190E4); the rest it copies either way. The
 * characters are stored byte-swapped. The colours are stored with each
 * component's low bit apart (SetScrollcol, 0x1BB90): two copies of each set,
 * from group 1 and group 0x81, and four groups from tables in the program.
 */
const VON_MAPS = [
    [0x2fd8170, 14, 2, 0xc000, 0x1e0f0],
    [0x2fd81a8, 16, 2, 0xc000, 0x1e128],
    [0x2fd8872, 1, 2, 0xc000, 0x1e490],
    [0x2fd8876, 1, 2, 0x8000, 0x1e544],
    [0x2fd887a, 15, 2, 0x8000, 0x1e774],
    [0x2fd88b6, 15, 4, 0x8000, 0x1e79c],
    [0x2fe158c, 1, 1, 0xc000, 0x1e908],
    [0x2fd8996, 6, 2, 0x8000, 0x1ea14],
    [0x2fd898e, 1, 2, 0x8000, 0x1ea98],
    [0x2fd8992, 1, 2, 0x8000, 0x1eb1c],
    [0x2fd89ae, 15, 1, 0x8000, 0x1eba8],
    [0x2fead34, 54, 6, 0xc000, 0x1ec4c],
    [0x2fe277c, 39, 10, 0x8000, 0x1ec80],
    [0x2fd89d0, 64, 48, 0x0, 0x1ec9c],
    [0x2fe2d0c, 23, 14, 0x8000, 0x1ecf8],
    [0x2fe2f90, 23, 14, 0x8000, 0x1edf4],
    [0x2fd6d20, 32, 6, 0xc000, 0x1efa8],
    [0x2fd0cd4, 19, 2, 0xc000, 0x1f048],
    [0x2fd2520, 64, 48, 0x0, 0x1f078],
    [0x2fe077e, 23, 5, 0xc000, 0x1f0b8],
    [0x2fd8238, 41, 3, 0xc000, 0x1f124],
    [0x2fd832e, 58, 3, 0xc000, 0x1f204],
    [0x2fd848a, 58, 3, 0xc000, 0x1f2e4],
    [0x2fe01d4, 56, 5, 0x8000, 0x1f4f8],
    [0x2fde9d0, 55, 8, 0x8000, 0x1f584],
    [0x2fe1606, 34, 2, 0x8000, 0x1f5d8],
    [0x2fe158e, 30, 2, 0xc000, 0x1f61c],
    [0x2fded40, 6, 8, 0xc000, 0x1f650],
    [0x2fdeda0, 6, 8, 0xc000, 0x1f670],
    [0x2fe321c, 30, 3, 0xc000, 0x1f768],
    [0x2fe350e, 36, 3, 0xc000, 0x1f7ac],
    [0x2fe35e6, 36, 3, 0xc000, 0x1f7f0],
    [0x2fe343c, 35, 3, 0xc000, 0x1f834],
    [0x2fe37fa, 31, 3, 0xc000, 0x1f878],
    [0x2fe33b4, 34, 2, 0xc000, 0x1f8bc],
    [0x2fe32d0, 38, 3, 0xc000, 0x1f900],
    [0x2fe3746, 30, 3, 0xc000, 0x1f944],
    [0x2fe053a, 58, 5, 0x8000, 0x1fa68],
    [0x2fe099a, 45, 5, 0xc000, 0x1fab8],
    [0x2fe1350, 43, 5, 0x8000, 0x1fafc],
    [0x2fe1170, 48, 5, 0xc000, 0x1fb40],
    [0x2fe0d42, 53, 5, 0x8000, 0x1fb88],
    [0x2fe0404, 31, 5, 0x8000, 0x1fbd0],
    [0x2fe17ec, 20, 3, 0x8000, 0x1fbf8],
    [0x2fe14fe, 31, 2, 0x8000, 0x1fc94],
    [0x2fe158a, 1, 1, 0x8000, 0x1fd48],
    [0x2fe157a, 4, 2, 0x8000, 0x1fde8],
    [0x2fd892e, 7, 2, 0xc000, 0x1fe20],
    [0x2fd894a, 7, 2, 0x8000, 0x1fe54],
    [0x2fe0cb0, 20, 2, 0x8000, 0x1fe74],
    [0x2fe0b5c, 34, 5, 0x8000, 0x1ff34],
    [0x2fe0f54, 54, 5, 0xc000, 0x1ffcc],
    [0x2fdff54, 40, 8, 0xc000, 0x20028],
    [0x2fdfc00, 13, 2, 0x8000, 0x2010c],
    [0x2fdfbfc, 1, 2, 0x8000, 0x2013c],
    [0x2fd5520, 64, 48, 0x0, 0x20208],
    [0x2fefee8, 64, 30, 0x8000, 0x20238],
    [0x2ff16e8, 64, 39, 0x8000, 0x20264],
    [0x2ff1568, 64, 4, 0x8000, 0x20294],
    [0x2fd0d20, 64, 48, 0x0, 0x203a8],
    [0x2fe0864, 31, 5, 0xc000, 0x203c0],
    [0x2fd3d20, 64, 48, 0x0, 0x203ec],
    [0x2fdc9d0, 64, 48, 0x0, 0x20478],
    [0x2fcf468, 8, 4, 0x8000, 0x204ac],
    [0x2fcf2c8, 8, 4, 0x8000, 0x204fc],
    [0x2fcf528, 12, 4, 0x8000, 0x2054c],
    [0x2fcf828, 12, 4, 0x8000, 0x2059c],
    [0x2fcf628, 12, 4, 0x8000, 0x205ec],
    [0x2fcf928, 12, 4, 0x8000, 0x2063c],
    [0x2fcf9e4, 16, 4, 0x8000, 0x20674],
    [0x2fcf308, 16, 4, 0x8000, 0x206a4],
    [0x2fcf388, 28, 4, 0x8000, 0x206d4],
    [0x2fcf4a8, 16, 4, 0x8000, 0x20704],
    [0x2fcf7a8, 16, 4, 0x8000, 0x20734],
    [0x2fcf688, 16, 4, 0x8000, 0x20764],
    [0x2fcf588, 20, 4, 0x8000, 0x20794],
    [0x2fcf888, 20, 4, 0x8000, 0x207c4],
    [0x2fcf708, 20, 4, 0x8000, 0x207f4],
    [0x2fcf988, 23, 2, 0xc000, 0x20824],
    [0x2fcfa64, 24, 8, 0xc000, 0x20854],
    [0x2fcfbe4, 31, 8, 0xc000, 0x20884],
    [0x2fcfdd4, 36, 8, 0xc000, 0x208b4],
    [0x2fd0014, 34, 4, 0xc000, 0x208e4],
    [0x2fd0124, 28, 8, 0xc000, 0x20914],
    [0x2fd02e4, 24, 8, 0xc000, 0x20944],
    [0x2fd0464, 29, 8, 0xc000, 0x20974],
    [0x2fd0634, 29, 8, 0xc000, 0x209a4],
    [0x2fd09a4, 28, 8, 0xc000, 0x209d4],
    [0x2fd07f4, 27, 8, 0xc000, 0x20a04],
    [0x2fe8fc4, 64, 8, 0x8000, 0x219a0],
    [0x2feab34, 64, 4, 0x8000, 0x21a10],
    [0x2fe8ec2, 43, 3, 0x8000, 0x21fe8],
    [0x2fecbec, 41, 3, 0x8000, 0xd41a8],
    [0x2fece6e, 33, 3, 0x8000, 0xd41e8],
    [0x2fecce2, 33, 6, 0x8000, 0xd421c],
    [0x2fed024, 49, 2, 0x8000, 0xd4a28],
    [0x2fecf34, 24, 5, 0x8000, 0xd4a84],
];

/* The robot table's order, as its name plates spell it. */
const VON_ROBOTS = ['Temjin', 'Viper II', 'Belgdor', 'Raiden', 'Dorkas', 'Fei-Yen', 'Apharmd', 'Bal-Bas-Bow', 'Jaguarandi', 'Z-Gradt'];

/* `robots`, `select` and `shuffled` are the program tables, which the US
 * build moves; `site` heads each call site's name. */
const vonCells = ({ robots, select, shuffled, site }) => ({
    maps: VON_MAPS.map(([at, cols, rows, or, call]) => [at, cols, rows, or, `drawn at ${site}0x${call.toString(16).toUpperCase()}`]),
    mapTables: [
        { table: robots, stride: 0x68, count: 10, cols: 31, rows: 35, or: 0x8000, what: 'portrait', names: VON_ROBOTS },
        { table: robots + 0x4c, stride: 0x68, count: 10, or: 0xc000, what: 'name plate', names: VON_ROBOTS },
        { table: select, stride: 4, count: 10, cols: 20, rows: 15, or: 0x8000, what: `stage plan (${site}0x21EB8)` },
    ],
    boot: {
        font: { src: 0x02ea0bb8, first: 0, count: 0x80, pen: 1 },
        modes: [
            {
                name: 'attract (SetScrolldata 0)',
                chars: [[0x02ea2a74, 0x80, 0x1880], [0x02ed3054, 0x1900, 0x1700], [0x02f4db14, 0x3000, 0x680]],
                palette: [
                    { shuffled: [[0x02fdef20, 0x31], [0x02fd6ea0, 0x2e], [0x02ff7568, 0xd]], group: 1 },
                    { shuffled: [[0x02fdf540, 0x31], [0x02fd7460, 0x2e], [0x02ff7568, 0xd]], group: 0x81 },
                ],
            },
            {
                name: 'game (SetScrolldata 1)',
                chars: [[0x02ea2a74, 0x80, 0x1880], [0x02f000d4, 0x1900, 0x2700]],
                palette: [
                    { shuffled: [[0x02fdef20, 0x31], [0x02fed0e8, 0x4e]], group: 1 },
                    { shuffled: [[0x02fdf540, 0x31], [0x02fedaa8, 0x4e]], group: 0x81 },
                ],
            },
        ],
        chars: [
            [0x144cc4, 0x1488, 0x77], [0x146324, 0x3db0, 0x48], [0x144184, 0x3d10, 0x5a],
            [0x145ba4, 0x3f40, 0x3c], [0x146c24, 0x37c, 2], [0x146c64, 0x37e, 2],
        ],
        fill: [[0x1570, 1, 0x9999]],
        palette: [
            { shuffled: [[shuffled[0], 1]], group: 0xa9 },
            { shuffled: [[shuffled[1], 1]], group: 0xfa },
            { shuffled: [[shuffled[1], 1]], group: 0xfb },
            { shuffled: [[shuffled[1], 1]], group: 0xfe },
        ],
    },
    programAt0: true,
    charBytes: 0x80000,
    colorxlat: true,
});

const vonj = {
    id: 'vonj',
    name: 'Cyber Troopers Virtual-On (Japan, Revision B)',
    identify: ['epr-18664b.15', 'epr-18665b.16'],
    identifyCrc: [0x27d0172c, 0x2f0142ee],
    regions: {
        /* The second megabyte is the data pair every build shares. */
        maincpu: {
            size: 0x200000,
            parts: [
                [0x000000, 'epr-18664b.15', 0x27d0172c, 'epr-18665b.16', 0x2f0142ee],
                [0x100000, 'epr-18666.13', 0x66edb432, 'epr-18667.14', 0xb593d31f],
            ],
        },
        ...VON_CHIPS,
    },
    /* No table: the program and data ROMs hold the object triples it sends
     * (js/romset.js scanModelTable), one model a mesh. */
    modelTable: {
        scan: { sources: [['mainData', 0, 0x1000000], ['maincpu', 0, 0x200000]] },
        count: 7097,
    },
    meshPtr: { subtract: 0x02000000, add: 0 },
    /*
     * The boot copies the face palette out of the program ROM (`tables`
     * names the `ldos` operand at 0x29A98 that points at it, 0xF48D0). The 24
     * entries from 8 on are the ones the game cycles (data 0xBF83C4, records
     * of a shift, a mask and a pointer to the colours); still, they hold the
     * first colour of each.
     */
    palette: { tables: 0x29a9c, sets: 1, split: 0, cycles: { table: 0xbf83c4, first: 8, count: 24 } },
    /* LZ banks, a full sheet each (js/texture.js buildVonTexram). A set is a
     * field: 0-9 the ten stages, 10-13 the rest (title, select, ending). */
    texture: {
        raw: {
            layout: 'von', boot: 0xc00008, banks: 0x280c0, deal: 0x27c50, fieldBanks: 0xc8ed0,
            keepBank0: [13],
        },
        sets: 14,
        residentSet: null,
        defaultSet: 0,
        mips: true,
    },
    /* Luma: two grey ramps of 128 (0x28548), then 0x2080 bytes from data
     * 0xFB1D10 at entry 0x800. Colorxlat: js/colors.js buildVonColorxlat.
     * Both match MAME's RAM after each field's start. */
    colors: {
        luma: { data: 0xfb1d10, bytes: 0x2080, at: 0x800, ramps: 2 },
        von: {
            gamma: 0.55,
            rows: [
                [1, 0x2fb3d90], [3, 0x2fb3e50], [5, 0x2fb4990], [7, 0x2fb4a50], [9, 0x2fb7510],
                [11, 0x2fb75d0], [13, 0x2fb7690], [15, 0x2fb7750], [17, 0x2fb7810], [19, 0x2fb7990],
                [21, 0x2fb6cd0], [25, 0x2fb7e10], [27, 0x2bfed8c], [29, 0x2fb6fd0],
            ],
            fields: [
                [[11, 0x2fb75d0], [21, 0x2fb5b90], [23, 0x2fb5c50], [25, 0x2fb5d10]],
                [[11, 0x2fb75d0]],
                [[11, 0x2fb75d0], [21, 0x2fb5dd0], [23, 0x2fb5e90], [25, 0x2fb5f50], [27, 0x2fb6010], [29, 0x2fb60d0]],
                [[11, 0x2fb75d0], [21, 0x2fb6190], [23, 0x2fb6250], [25, 0x2fb6310], [27, 0x2fb63d0], [29, 0x2fb6490]],
                [[11, 0x2fb75d0], [23, 0x2fb6550], [25, 0x2fb6610], [27, 0x2fb66d0], [29, 0x2fb6790]],
                [[11, 0x2fb75d0], [23, 0x2fb6850], [25, 0x2fb6910], [27, 0x2fb69d0], [29, 0x2fb6a90]],
                [[11, 0x2fb75d0], [27, 0x2fb6b50], [29, 0x2fb6c10]],
                [[11, 0x2fb75d0], [21, 0x2fb6cd0], [23, 0x2fb6d90], [25, 0x2fb6e50], [27, 0x2fb6f10], [29, 0x2fb6fd0]],
                [[11, 0x2fb75d0]],
                [[11, 0x2fb75d0], [29, 0x2fb7450]],
                [[25, 0x143704], [27, 0x1437c4], [29, 0x2fb8590]],
                [[1, 0x2fb4e10, true], [3, 0x2fb4ed0, true]],
                [[21, 0x2fb6cd0], [25, 0x2fb7e10], [27, 0x2bfed8c], [29, 0x2fb6fd0]],
                [[11, 0x2fb75d0, true], [1, 0x2fb7a50, true], [3, 0x2fb7b10, true], [5, 0x2fb7bd0, true],
                    [7, 0x2fb7c90, true], [21, 0x2fb6cd0, true], [25, 0x2fb7e10, true], [27, 0x2bfed8c, true],
                    [29, 0x2fb6fd0, true]],
            ],
            robots: { table: 0x142e94, rows: [[1, 3], [5, 7]] },
        },
    },
    /* The boot uploads 32 material slots from program 0x293B0 (geometry
     * function 6, 0x292D8); each field sets its light from 0x142FD4 + 12 *
     * field (initField, stored at 0xC9030). The model view takes field 0's. */
    lighting: {
        light: [-0.296198, -0.5, -0.813798],
        materials: { at: 0x293b0, count: 32 },
    },
    von: { fieldRoutines: 0xc8e10, fields: 14, lights: 0x142fd4, names: 0x21060, named: 10 },
    /* The robots: ten pointers to their records (`ld 0x19360[g3*4]`), the
     * lists of parts and the motion pairs in each (js/von.js readVonBodies).
     * `random` is the game's random draw (bal 0xF5058), which a win asks
     * for its pose (js/von.js runVonAction).
     *
     * The last, Zig-Raht, is drawn by its own routine (0x3A510): its legs
     * list alone, 26 parts, through the same part draw (0x8DD40). Its record's
     * pairs are other robots' legs; the records it plays are set by its own
     * code (0x37FC4-0x399A0), as literals or out of a table at 0x382F0, each
     * a 26-part record stored at 0x51ACFC. `boss.records` are those, with
     * where each is set or loaded. The data ROM is the same in vonu, and
     * its code the same, 0xC30 on (the table at 0x38F20). */
    rig: {
        kind: 'von', robots: 0x19360, count: 10, random: 0xf5058,
        boss: {
            robot: 9,
            records: [
                [0x37fc4, 0x2b1d9dc], [0x3808c, 0x2b2257c], [0x380ac, 0x2b22304], [0x3819c, 0x2b227f4],
                [0x381cc, 0x2b2711c], [0x38224, 0x2b2ba44], [0x38284, 0x2adc154], [0x39994, 0x2ac7824],
                [0x38350, 0x2ae22e4], [0x38350, 0x2adf21c], [0x38350, 0x2ae53ac], [0x38350, 0x2ae8474],
                [0x384a0, 0x2afa904], [0x384a0, 0x2af16bc], [0x384a0, 0x2b03b4c], [0x384a0, 0x2b0cd94],
                [0x38610, 0x2b12f24], [0x38610, 0x2b0fe5c], [0x38610, 0x2b15fec], [0x38610, 0x2b190b4],
                [0x386cc, 0x2acc14c], [0x386cc, 0x2ace5e4], [0x388f4, 0x2ad2f0c],
            ],
        },
    },
    /*
     * The Model 2B's sound board, with two 4 MB sample chips (von.zip's). The
     * sound test's list is 0xEFF62: 35 records of 0x22 bytes, the song number,
     * the command's middle byte (0x10) and the name, so a song is AE 10 nn.
     * The attract starts the demo song as AE 10 1B and the title's as AE 10 1A,
     * after A0 00 01. Which field plays which song is the fight code's, and is
     * not read yet: the explorer plays the one picked.
     */
    sound: {
        program: ['epr-18670.31', 0x3e715f76],
        samples: [['mpr-18652.32', 0x037eee53], ['mpr-18653.34', 0x9ec3e7bf]],
        sampleChip: 0x400000,
        boot: [0xA0, 0x00, 0x01],
        stop: [0xA0, 0x00, 0x01],
        music: {
            list: { named: true, at: 0xeff62, count: 35, stride: 0x22, status: 0xae, strip: 'SDB_' },
            own: 'none',
            hint: 'A song from the sound test\'s list, by the name it gives it. Which field plays which is in the fight code, not read yet',
        },
    },
    stageTable: { von: true, flat: true },
    scenes: null,
    cells: vonCells({ robots: 0x20b50, select: 0x211b0, shuffled: [0x1bb50, 0x1bb70], site: '' }),
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};

/* The US build (`vonu`, von.zip's vo-prog0.usa and vo-prog1.usa, which MAME
 * calls epr-18828b.15 and epr-18829b.16). Its program moves the tables by
 * 0x610 to 0xC30; the second megabyte and the data ROMs are the same. */
const vonu = {
    ...vonj,
    id: 'vonu',
    name: 'Cyber Troopers Virtual-On (USA, Revision B)',
    identify: ['epr-18828b.15', 'epr-18829b.16'],
    identifyCrc: [0x6499cc59, 0x0053b10f],
    regions: {
        ...vonj.regions,
        maincpu: {
            ...vonj.regions.maincpu,
            parts: [
                [0x000000, 'epr-18828b.15', 0x6499cc59, 'epr-18829b.16', 0x0053b10f],
                vonj.regions.maincpu.parts[1],
            ],
        },
    },
    palette: { ...vonj.palette, tables: 0x2a6ac },
    texture: { ...vonj.texture, raw: { ...vonj.texture.raw, banks: 0x28cd0, deal: 0x28860, fieldBanks: 0xc9b00 } },
    lighting: { ...vonj.lighting, materials: { ...vonj.lighting.materials, at: 0x29fc0 } },
    von: { ...vonj.von, fieldRoutines: 0xc9a40, names: 0x21aa0 },
    /* The robot records sit 0xF0 lower, and their table with them. */
    rig: {
        ...vonj.rig, robots: 0x19270, random: 0xf5c98,
        /* Zig-Raht's code sits 0xC30 later; its records are the same. */
        boss: { ...vonj.rig.boss, records: vonj.rig.boss.records.map(([at, rec]) => [at + 0xc30, rec]) },
    },
    sound: { ...vonj.sound, music: { ...vonj.sound.music, list: { ...vonj.sound.music.list, at: 0xf0ba2 } } },
    /* The same tables, found by their bytes; the colour tables sit 0xF0
     * lower, the robot and select tables 0xA40 higher. The maps are data. */
    cells: vonCells({ robots: 0x21590, select: 0x21bf0, shuffled: [0x1ba60, 0x1ba80], site: 'vonj ' }),
};

/*
 * Sega Rally Championship, Revision C: a Model 2A, so a TGP with its program
 * uploaded by the i960, and the same geometrizer and texture RAM as the
 * other games here. None of its tables is named by a debug table or a
 * symbol; each was found by watching the board draw (m2-hle2 running the set,
 * its watchpoints and memory dumps) and following the program back to the
 * ROM. See README's Sega Rally section and TECHNICAL.md.
 *
 * The program copies itself to RAM at boot, ROM 0x1000..0x61000 to 0x5A0000,
 * and runs there, so a RAM address in the code is the ROM offset plus
 * 0x59F000.
 */
/* The cars by their record's slot: the two the player picks from (bodies 110
 * and 96). The rest are the CPU cars' liveries, named by slot. */
const RALLY_CARS = ['Toyota Celica', 'Lancia Delta'];

/*
 * The runs the attract scenes play (0x10A9C on, by the scene in 0x20A800),
 * each handed to 0x28990 as a main_data address with the frame clock
 * 0x20A7FC. The tables lie end to end, 0xF830 and 0x10754 bytes apart, and a
 * scene's clock runs a sample or two past its run's end into the next, so a
 * run's length is the clock's last value in MAME's attract plus one, not the
 * gap. `car` is the slot of the car that drives it; the third scene plays its
 * one run with either car. `shift`: the scene moves the flags' low halfword up a
 * bit, all but the low three (0x10AE0, 0x116F4), puts `high` over the top one
 * and clears `clear`; the other scenes draw the run's flags as they are.
 */
const RALLY_RUNS = [
    { name: 'scene 1, Celica', at: 0x201f410, car: 0, frames: 1580, flags: { shift: true, high: 0x2222, clear: 0 } },
    { name: 'scene 1, Delta', at: 0x203e420, car: 1, frames: 1580, flags: { shift: true, high: 0x2222, clear: 0 } },
    { name: 'scene 2', at: 0x290a100, car: [0, 1], frames: 1522 },
    { name: 'scene 3, Celica', at: 0x28e9258, car: 0, frames: 3065 },
    { name: 'scene 3, Delta', at: 0x28f99ac, car: 1, frames: 3065 },
    { name: 'scene 4, Celica', at: 0x200fbe0, car: 0, frames: 2896, flags: { shift: true, high: 0, clear: 0x10 } },
    { name: 'scene 4, Delta', at: 0x202ebf0, car: 1, frames: 2896, flags: { shift: true, high: 0, clear: 0x10 } },
];

const srallyc = {
    id: 'srallyc',
    name: 'Sega Rally Championship (Revision C)',
    identify: ['epr-17888c.12', 'epr-17889c.13'],
    identifyCrc: [0x3d6808aa, 0xf43c7802],
    regions: {
        maincpu: {
            size: 0x200000,
            parts: [[0x000000, 'epr-17888c.12', 0x3d6808aa, 'epr-17889c.13', 0xf43c7802]],
        },
        /* MAME's region is 0x2400000; it is cut where the chips end. The
         * first pair holds texture banks 0 and 1 from 0x200000, the second
         * banks 2 to 5, and the third the model table. */
        mainData: {
            size: 0xc00000,
            parts: [
                [0x000000, 'mpr-17746.10', 0x8fe311f4, 'mpr-17747.11', 0x543593fd],
                [0x400000, 'mpr-17744.8', 0x71fed098, 'mpr-17745.9', 0x8ecca705],
                [0x800000, 'mpr-17884.6', 0x4cfc95e1, 'mpr-17885.7', 0xa08d2467],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-17748.16', 0x3148a2b2, 'mpr-17750.20', 0x232aec29],
                [0x400000, 'mpr-17749.17', 0x0838d184, 'mpr-17751.21', 0xed87ac62],
            ],
        },
        /* The UV and material streams only: the sheets are raw in the data
         * ROM, as Daytona's are. */
        textures: {
            size: 0x1000000,
            parts: [[0x000000, 'mpr-17753.25', 0x6db0eb36, 'mpr-17752.24', 0xd6aa86ce]],
        },
        /* The TGP's data ROM. Nothing here reads it yet. */
        copro: {
            size: 0x800000,
            optional: true,
            parts: [[0x000000, 'mpr-17754.28', 0x81a84f67, 'mpr-17755.29', 0x2a6e7da4]],
        },
    },
    /*
     * The model table: 1508 entries of 16 bytes at main_data 0x864B40, the
     * three words geo_object_data takes (tpa, tha, oba) and a polygon count.
     * Every draw routine reads it the same way, `ldq 0x2864B40[g5*16]` and the
     * four words straight on to the TGP's FIFO at 0x804000 (0x23CEC is one of
     * 34 such sites), with the model number out of +4 of an object record.
     * The entries run in order through the ROMs, and the "CGM 1.0 " block
     * after the last one (0x86A980) is where they stop.
     */
    modelTable: { offset: 0x864b40, count: 1508, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* 541 colours, in the program ROM: the boot routine at 0x267B0 reads the
     * count, `ldos 0x5FB89C` (ROM 0x5C89C), and copies that many halfwords
     * from 0x5C89E to palette RAM 0x1802000, colorbase 0. The courses do not
     * change it. */
    paletteSource: 'maincpu',
    paletteOffset: 0x5c89e,
    paletteCount: 541,
    /*
     * The sheets, raw in the data ROM and dealt out by 0x3940 (see
     * uploadSrallycBank in js/texture.js): the boot's bank 0, then the bank
     * the course variant picks out of the table at 0x3DCF0. The variant is
     * work RAM 0x214354, 0 to 3, and the banks 2, 3, 4 and 5: the desert,
     * the mountain, the forest, and the fourth, which the attract mode never
     * shows and is taken to be the lakeside.
     */
    texture: {
        raw: { layout: 'srallyc', runTable: 0x3880, bankTable: 0x3dcf0, bootBank: 0 },
        sets: 4,
        residentSet: null,
        defaultSet: 0,
    },
    /* Both tables are made by running the program's own routines (see
     * runColorRoutines in js/colors.js). `solid` as Daytona's: an untextured
     * face goes through colorxlat as well. */
    colors: {
        i960: { copy: [0x1000, 0x61000, 0x5a0000], run: [0x5a2c80, 0x5a3350, 0x5a3590] },
        solid: true,
    },
    /*
     * The materials go up once a scene, as the TGP's function 6, from 0x4AC0:
     * `mov 0, g0; mov 22, g1; lda 0x5A39C0, g2` and `bal 0x4958`, the same
     * (parameter, coefficient) pairs as the other 1995 games, 22 of them at
     * ROM 0x49C0, every coefficient 1.0.
     *
     * The light is function 0xA. The attract scenes send a world light of
     * (-0.707, -0.707, 0.707) through the TGP into camera space before it
     * (0x13914, 0x17450, 0x1F858, 0x4AC34). Z is negated, as for Daytona.
     */
    lighting: {
        light: [-0.707, -0.707, -0.707],
        materials: { source: 'maincpu', at: 0x49c0, count: 22, stride: 8 },
    },
    /*
     * The courses (readRallyStages in js/stages.js): a 12-byte record a course
     * at ROM 0x3DA00, which 0x3BCC0 reads as `lda 0x5DCA00[g0*4]` on course*3,
     * and the low-detail copy's at 0x3DA60. The pointers are into the copy of
     * the program in RAM, ROM + 0x59F000. The models are in world space.
     */
    stageTable: {
        rally: { near: 0x3da00, far: 0x3da60, stride: 12, count: 4, segments: 60, ramBase: 0x59f000 },
        flat: true,
    },
    /* Daytona's depth arrangement, for the same reason: no depth buffer, and
     * a road made of plates laid on plates. */
    depth: { recede: 0, nearMin: 0.02, layers: true },
    /*
     * The Model 2A's sound board, with four 2 MB sample chips. The program
     * names every sound it sends. The program runs from RAM, 0x59F000
     * above its ROM address; by ROM address, 0x261B0 sends sound ID g0 as
     * the 3-byte command at 0x24CE0 + 3 * ID, and the pointer at
     * 0x258C0 + 4 * ID names it (the sound test's B.G.M list, IDs 0x9B to
     * 0xAB, all AE 10 nn; ID 0x9A, AE 10 00, is "Off"). As a race starts,
     * 0x1D0E8 sends the course's song out of one of two tables of IDs
     * indexed by the course (work RAM 0x214354): 0x1C6E0 for the
     * championship, 0x1C700 for practice. The explorer plays the
     * championship's, the songs Sega Retro's credits give each course.
     */
    sound: {
        program: ['epr-17890a.30', 0x5bac3fa1],
        samples: [
            ['mpr-17756.31', 0x7725f111], ['mpr-17757.32', 0x1616e649],
            ['mpr-17886.36', 0x54a72923], ['mpr-17887.37', 0x38c31fdd],
        ],
        boot: [0xAE, 0x10, 0x00],
        stop: [0xAE, 0x10, 0x00],
        stageMusic: 0x1c6e0,
        music: {
            list: { ids: true, at: 0x24ce0, names: 0x258c0, ramBase: 0x59f000, first: 0x9b, count: 17 },
            own: "the course's own",
            hint: 'The song the course plays. The game plays the championship\'s song for the course (practice has its own for some); this plays any of the sound test\'s, by the names the program gives them',
        },
    },
    /*
     * The 2D pictures are AM3's "CGM 1.0" files (js/cells.js, `cgm`): the
     * loader 0x5C8EB0 (ROM 0x29EB0) takes a file's address, g2, compares its
     * first eight bytes with the string at 0x5C8E60, loads its blocks from
     * the free palette group (work RAM 0x20C950, which the reset 0x5C8A60
     * sets to 9: groups 0-8 hold the font 0x5C5690 loads) and files its
     * patterns in the table at 0x20B950; the draw 0x5C8C10 adds the group
     * << 7 to each entry. Its 96 callers name the files directly, `lda
     * 0x28AE89C, g2` (the attract's PUSH START, 0x5AB074) and the like. The
     * files are in the data ROM and, 16 of them, the program ROM past the copy
     * (0x61004 on). The third data pair is 2MB, which the region repeats up
     * to 0xC00000 as the board's decoding does, so the scan stops at
     * 0xA00000 (`dataEnd`). Every colour goes through colorxlat, as MAME's
     * palette_w puts every tile colour.
     */
    cells: { cgm: { dataEnd: 0xa00000 }, programAt0: true, charBytes: 0x80000, colorxlat: true },
    /*
     * The people by the course (js/srally.js): three figures of 5, 8 and 12
     * parts, 30 key frames each, all drawn by 0x5CA290. `figures.table` is
     * the four figure pointers at ROM 0x2B280 (RAM 0x5CA280) that object
     * classes 5 and 7 pick from; class 6 draws the first.
     */
    rig: {
        kind: 'srallyc',
        figures: { table: 0x2b280, count: 4, ramBase: 0x59f000 },
        /* What each one does; the game has no names for them. */
        names: ['fist pump', 'overhead clap', 'jump, arms up'],
        /* The cars' records, 0x30 bytes each at ROM 0x23780, which 0x24800
         * picks by +0x50 & 15 (see carRecords in js/srally.js). */
        cars: { table: 0x23780, count: 12, ramBase: 0x59f000, names: RALLY_CARS },
        /* The attract mode's recorded runs (readRallyRuns). */
        runs: { list: RALLY_RUNS },
        /* The desert's animals, figures drawn by 0x5C70D0 (see the animals in
         * js/srally.js): the figure records each handler names, as RAM
         * addresses. A body is what one handler draws at once, a motion one
         * thing it plays; `swing` for the figures it plays there and back. */
        animals: {
            ramBase: 0x59f000,
            bodies: [
                { name: 'zebra', figures: [0x5e2890, 0x5e2900] },
                { name: 'ostrich', figures: [0x5e2920] },
                { name: 'bird', figures: [0x5e2830] },
                { name: 'bird, flying', figures: [0x5e2840] },
                { name: 'elephant', figures: [0x5e2960], extra: [{ model: 118, place: [0, 0.1, 0] }] },
                { name: 'small bird', figures: [0x5e2870], scale: 0.3 },
            ],
            motions: [
                { name: 'zebra', body: 'zebra', figures: [0x5e2890, 0x5e2900], swing: true },
                { name: 'ostrich', body: 'ostrich', figures: [0x5e2920] },
                { name: 'bird hopping', body: 'bird', figures: [0x5e2830] },
                { name: 'bird pecking', body: 'bird', figures: [0x5e2860] },
                { name: 'bird flying', body: 'bird, flying', figures: [0x5e2840] },
                { name: 'elephant', body: 'elephant', figures: [0x5e2960] },
                { name: 'small bird', body: 'small bird', figures: [0x5e2870] },
            ],
        },
        /* The desert's start-line flags, class 17 (see the flags in
         * js/srally.js): one model a frame out of a table of model numbers
         * (RAM addresses), the variant, +0x5C, picking the table. */
        flags: {
            ramBase: 0x59f000,
            tables: [
                { name: 'red AM3 flag', at: 0x5e3b90 },
                { name: 'blue flag', at: 0x5e3cc0 },
            ],
        },
    },
    /* The courses but not the cars' placement on them, nor the trackside
     * objects. The cars are bodies whose wheels turn as 0x5C2A80 turns them,
     * playing the attract mode's recorded runs; the animals play their
     * figures as 0x5C70D0 does; the flags wave as 0x5E4380 swaps them. */
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};

/* ---- Dynamite Cop / Dynamite Deka 2 (Pinboard #1286) --------------------- */

/* Bank k of each copy is set k's. The table holds two copies of 25 banks;
 * the second copy's enemy banks name their texture records 4MB lower in the
 * texture ROMs. */
const DYNAMCOP_BANK_SETS = [...Array(25).keys(), ...Array(25).keys()];

/*
 * AM1's 1998 game, on all three boards: the 2A export and Japanese builds, the
 * same two on 2B, and the US build on 2C. The data, polygon and texture ROMs
 * are one set of chips for all five, and so is the program's upper pair; only
 * the lower pair differs, and it is what tells the builds apart. The 2B and 2C
 * zips name it `progrom0.15` and `progrom1.16`, so it is found by checksum.
 *
 * Read off a running board (MAME, the shared build, with Lua dumps of palette,
 * colorxlat, luma and texture RAM at three attract scenes) and the program's
 * set loaders: boot is 0x7D450, a stage 0x7D3F0 or 0x7D490, an enemy set
 * 0x7D420 or 0x7D4D0, all handed the set number. Every table they read is a
 * pointer array indexed by it. js/dynamcop.js has the scene this makes.
 *
 * The addresses are the 2A export build's. The other builds' were found by
 * searching each program for the same table bytes. The 2B and 2C programs
 * keep the same tables in another order.
 */
const DYNAMCOP_DATA = {
    mainData: {
        size: 0x2000000,
        parts: [
            [0x0000000, 'mpr-20797.10', 0x87bab1e4, 'mpr-20798.11', 0x40dd752b],
            [0x0800000, 'mpr-20795.8', 0x0ef85e12, 'mpr-20796.9', 0x870139cb],
            [0x1000000, 'mpr-20793.6', 0x42ea08f8, 'mpr-20794.7', 0x8e5cd1db],
            [0x1800000, 'mpr-20791.4', 0x4883d0df, 'mpr-20792.5', 0x47becfa2],
        ],
    },
    polygons: {
        size: 0x2000000,
        parts: [
            [0x0000000, 'mpr-20799.16', 0x424571bf, 'mpr-20803.20', 0x61a8ad52],
            [0x0800000, 'mpr-20800.17', 0x3c2ee808, 'mpr-20804.21', 0x03b35cb8],
            [0x1000000, 'mpr-20801.18', 0xc6914173, 'mpr-20805.22', 0xf6605ede],
            [0x1800000, 'mpr-20802.19', 0xd11b5267, 'mpr-20806.23', 0x0c942073],
        ],
    },
    textures: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-20809.25', 0x3b7b4622, 'mpr-20807.24', 0x1241e0f2],
            [0x800000, 'mpr-20810.27', 0x838a10a7, 'mpr-20808.26', 0x706bd495],
        ],
    },
};

/* The program's own tables, per build. */
const DYNAMCOP_AT = {
    dynamcop: {
        tables: 0x42840, top: 0x428e0, extra: 0x42920, ramps: 0x42930, banks: 0x429d0,
        flags: 0x756b0, luma: 0x36b40, weights: 0x70270, rects: 0xe4390, patches: 0xe4440,
        materials: 0x6ecc0, missions: 0xe9a70, pictures: 0xe9b10, offsets: 0xe1890, models: 0xe1a10, shadows: 0xed140,
        quad: { copy: 0x169e0, skeleton: 0x16bc0 },
    },
};
DYNAMCOP_AT.dyndeka2 = { ...DYNAMCOP_AT.dynamcop, flags: 0x756a0, weights: 0x70260, rects: 0xe4380, patches: 0xe4430, materials: 0x6ecb0,
    missions: 0xe9a60, pictures: 0xe9b00, offsets: 0xe1880, models: 0xe1a00, shadows: 0xed130,
};
DYNAMCOP_AT.dynamcopb = {
    tables: 0x10ba0, top: 0x10c40, extra: 0x10c80, ramps: 0x10c90, banks: 0x10d30,
    flags: 0x62330, luma: 0x4ea0, weights: 0x191e0, rects: 0xfa5b0, patches: 0xd5ca0,
    materials: 0x17c40, missions: 0xf9370, pictures: 0xc9880, offsets: 0xcfe90, models: 0xd0010, shadows: 0xfa400,
    quad: { copy: 0x32da0, skeleton: 0x32f80 },
};
DYNAMCOP_AT.dyndeka2b = { ...DYNAMCOP_AT.dynamcopb, flags: 0x62320, weights: 0x191d0, rects: 0xfa5a0, patches: 0xd5c90, materials: 0x17c30,
    missions: 0xf9360, pictures: 0xc9870, offsets: 0xcfe80, models: 0xd0000, shadows: 0xfa3f0,
    quad: { copy: 0x32d90, skeleton: 0x32f70 },
};
DYNAMCOP_AT.dynamcopc = {
    tables: 0x42e30, top: 0x42ed0, extra: 0x42f10, ramps: 0x42f20, banks: 0x42fc0,
    flags: 0x75ef0, luma: 0x37130, weights: 0x70a20, rects: 0xf4ab0, patches: 0xf4b60,
    materials: 0x6f3b0, missions: 0xfa190, pictures: 0xfa230, offsets: 0xf2260, models: 0xf23e0, shadows: 0xfd860,
    quad: { copy: 0x16e50, skeleton: 0x17030 },
};

/*
 * The sound board is the Model 2A's (epr-20811.30 and four 2 MB sample
 * chips). The program's song table is thirty 12-byte records, each the song's
 * command (A0 10 nn) and two more; the area descriptors name a record
 * (js/dynamcop.js), and 0x4B6A8 sends its command as the area starts. The
 * debug names are a table of pointers in the second megabyte, the same in
 * every build, S_MUSIC_CLEAR and then one a record. Before a song, the
 * attract sends A0 00 02 and A0 00 03; the boot, A0 00 01.
 */
const DYNAMCOP_SOUND = {
    program: ['epr-20811.30', 0xa154b83e],
    samples: [
        ['mpr-20812.31', 0x695b6088], ['mpr-20813.32', 0x1908679c],
        ['mpr-20814.36', 0xe8ebc74c], ['mpr-20815.37', 0x1b5aaae4],
    ],
    boot: [0xA0, 0x00, 0x01],
    stop: [0xA0, 0x00, 0x02, 0xA0, 0x00, 0x03],
    music: {
        list: { first: 0xa01000, count: 30, stride: 12, then: 4, names: 0x1ad394, strip: 'S_BGM_' },
        own: "the area's own",
        hint: 'The song the area plays. The game plays the one its area descriptor names; this plays any of the thirty in its song table, by the names its debug table gives them',
    },
};

function dynamcopBuild({ id, name, low, high }) {
    const A = DYNAMCOP_AT[id];
    return {
        id, name,
        identify: [low[1], low[3]],
        identifyCrc: [low[2], low[4]],
        regions: {
            maincpu: { size: 0x200000, parts: [low, high] },
            ...DYNAMCOP_DATA,
        },
        /* Set 5's stage bank is 0x06755500, through XTRA_DATA. */
        xtra: { window: 0x1000000, banks: [{ region: 'mainData', base: 0x1000000 }] },
        /*
         * 19432 entries at data 0xD40000, HOTD's 16-byte layout and mesh
         * pointers. Fifty empty entries split it into 51 banks. There is no
         * name table. The texture blocks follow it at 0xD8BE80.
         */
        modelTable: { offset: 0xd40000, count: 19432, stride: 16 },
        meshPtr: { subtract: 0x02000010, add: 0x10 },
        paletteOffset: null,
        /* js/dynamcop.js dynamcopPalette: `tables` is a count-prefixed table
         * per set, `top` one per stage written down from the top, `extra` one
         * more boot writes in two runs. */
        palette: { layout: 'dynamcop', tables: A.tables, top: A.top, extra: A.extra, sets: 25 },
        texture: {
            /* `bankTable[set]` is a data address: boot's packed (byte pair
             * encoding, laid out by `bootRects`), the others raw halfwords.
             * `patchTable[stage]` is eight 64x64 blocks for sheet 0. */
            raw: { layout: 'dynamcop', bankTable: A.banks, bootRects: A.rects, patchTable: A.patches },
            sets: 25,
            residentSet: null,
            bankSets: DYNAMCOP_BANK_SETS,
        },
        /*
         * The HOTD curve with other weights (`weights`: 0.7, then 0.85), and
         * fifteen ramps over the odd rows 1..29 with no gain: the first eleven
         * from boot's list, the last four from the stage's (`shared`). Luma RAM
         * is 0x7F80 bytes of the program ROM (0x70EB0 copies it). Both match
         * MAME's RAM exactly in all three scenes, but for row 17, which the
         * game animates.
         */
        colors: {
            luma: { source: 'maincpu', data: A.luma, bytes: 0x7f80 },
            curve: { weights: A.weights, sets: { ptrs: A.ramps, rows: 15, row0: 1, step: 2, gain: null, shared: 11 } },
            solid: true,
        },
        /* Boot uploads 31 material slots from `materials` (0x6EE74, the same
         * call as The House of the Dead's), and the table is HOTD's but for
         * slots 4 and 13. The light and plane normals are carried over from
         * HOTD, not read from this program. */
        lighting: {
            vecter: [0xe000, 0xc000],
            materials: { at: A.materials, count: 31 },
            planeNormals: true,
        },
        /* js/dynamcop.js readDynamcopStages: `missions` is the table 0x2B960
         * reads, three pointers a mission to runs of area descriptors. */
        stageTable: { dynamcop: { missions: A.missions, enemySets: 14 }, flat: true },
        sound: DYNAMCOP_SOUND,
        /* The 2D pictures (js/cells.js): The House of the Dead's, 971 of them
         * at `pictures` (0xE9B10 in the 2A export build), three pointers
         * each, tiles, colours and map, into the program's upper pair and
         * the data ROM; the table is the same bytes in every build, and a
         * zero entry ends it. The routines are HOTD's: 0xA3F30 loads a
         * picture into free blocks the first time it is drawn (0xA3C50 finds
         * the run, 0xA3E70 copies each chunk of tiles to a block of its own,
         * 0xA3DE0 and 0xA3D40 its 16 colours a block), and the draw (0xA3F90)
         * adds the first block to every map entry, so the group is the
         * block. Colours go through colorxlat. */
        cells: { pictures: { table: A.pictures, count: 971 }, charBytes: 0x80000, programAt0: true, colorxlat: true },
        /*
         * The characters (js/dynamcop.js readDynamcopBodies, bodies.js for the
         * motions). Ninety-six of them in two parallel tables, `offsets` the
         * skeleton sub_15210 reads and `models` the fifteen models sub_18FC0
         * draws; the skeleton itself is in the code. The motion tables are in
         * the program's upper half, which every build shares: 2284 motions,
         * data 0x15FA00 (sub_15000 steps a frame pointer through them), frames
         * 0x161DB0, and the flag byte 0x164160 the wrists and ankles test.
         * A frame is HOTD's size, `((48*16+127)>>5)*4`, angles first.
         */
        rig: {
            kind: 'dynamcop',
            bodies: { count: 96, offsets: A.offsets, models: A.models },
            motions: { count: 2284, data: 0x15fa00, frames: 0x161db0, flatAnkles: 0x164160, layout: 'dynamcop' },
            /* The hands a motion turns (dynamcopHands): two table pointers a
             * motion at `frames`, in the shared upper half, and the list of
             * hands that have turned models, 0x5B0 past `offsets`. */
            hands: { frames: 0x164a50, swaps: A.offsets + 0x5b0 },
            /* No table of motions per character: the list leads with the
             * ones the areas' cut scenes play (dynamcopSceneMotions). */
            bodyMotionsLabel: 'Played in its cut scenes',
            /* The shadow pieces (dynamcopShadows): a table a character at
             * `tables`, each six pointers (one a player) to sixteen models,
             * one a joint; the joints that draw one at `joints`, how many at
             * `count`. Each build's code loads its own three. */
            shadows: { tables: A.shadows, joints: A.shadows + 0x180, count: A.shadows + 0x1a8 },
            /* Character 79's own frame copy and skeleton (js/dynamcop.js
             * poseDynamcopQuad). */
            quad: A.quad,
        },
        features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
        dynamcop: { stages: 14, enemies: 11, enemyFlags: A.flags, defaultStage: 1, defaultEnemy: 0 },
    };
}

const DYNAMCOP_HIGH = [0x100000, 'epr-20932.14', 0x618a68bf, 'epr-20933.15', 0x13abe49c];
const dynamcop = dynamcopBuild({
    id: 'dynamcop', name: 'Dynamite Cop (Export, Model 2A)',
    low: [0x000000, 'epr-20930.12', 0xb8fc8ff7, 'epr-20931.13', 0x89d13f88],
    high: DYNAMCOP_HIGH,
});
const dyndeka2 = dynamcopBuild({
    id: 'dyndeka2', name: 'Dynamite Deka 2 (Japan, Model 2A)',
    low: [0x000000, 'epr-20922.12', 0x0a8b5604, 'epr-20923.13', 0x83be73d4],
    high: [0x100000, 'epr-20924.14', 0x618a68bf, 'epr-20925.15', 0x13abe49c],
});
const dynamcopb = dynamcopBuild({
    id: 'dynamcopb', name: 'Dynamite Cop (Export, Model 2B)',
    low: [0x000000, 'epr-20944.15', 0x29b142f2, 'epr-20945.16', 0xc495912e],
    high: [0x100000, 'epr-20942.13', 0x618a68bf, 'epr-20943.14', 0x13abe49c],
});
const dyndeka2b = dynamcopBuild({
    id: 'dyndeka2b', name: 'Dynamite Deka 2 (Japan, Model 2B)',
    low: [0x000000, 'epr-20936.15', 0x23ef98f2, 'epr-20937.16', 0x25a14e00],
    high: [0x100000, 'epr-20934.13', 0x618a68bf, 'epr-20935.14', 0x13abe49c],
});
const dynamcopc = dynamcopBuild({
    id: 'dynamcopc', name: 'Dynamite Cop (USA, Model 2C)',
    low: [0x000000, 'epr-20952.15', 0xec8bc896, 'epr-20953.16', 0xa8276ffd],
    high: [0x100000, 'epr-20950.13', 0x618a68bf, 'epr-20951.14', 0x13abe49c],
});
/* ---- Air Walkers ---------------------------------------------------------- */

/*
 * Data East's basketball game on Model 2A (m2-hle2's src/profiles/airwlkrs.h,
 * MAME's `airwlkrs`). Its program keeps nothing in the shapes the other games
 * use: the textures are loaded by the program's own copy routines and the
 * colours are a ramp it works out, so js/texture.js and js/colors.js each have
 * a section for it.
 */
const airwlkrs = {
    id: 'airwlkrs',
    name: 'Air Walkers',
    identify: ['j_2-14_ic12_fe7e.12', 'j_2-14_ic13_d539.13', 'mpr-19235.16', 'mpr-19234.25'],
    regions: {
        maincpu: {
            size: 0x200000,
            parts: [[0x000000, 'j_2-14_ic12_fe7e.12', 0x8851a8d7, 'j_2-14_ic13_d539.13', 0x72287ee0]],
        },
        /*
         * An 8MB mask pair and a 1MB EPROM pair, which MAME repeats up to 16MB
         * (the ROM_COPY run in `airwlkrs`). The model table is in the mask pair;
         * the teams' texture pages run into the repeats.
         */
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19236.10', 0x3c26e978, 'mpr-19237.11', 0x961328b1],
                ...Array.from({ length: 8 }, (_, i) =>
                    [0x800000 + i * 0x100000, '11-7_ic8_d400.8', 0x37f300bd, '11-7_ic9_6e4a.9', 0x454e4a09]),
            ],
        },
        polygons: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-19235.16', 0xeaad8f92, 'mpr-19232.20', 0xfd153001]],
        },
        textures: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-19234.25', 0xd7d69493, 'mpr-19233.24', 0x7a2e51f1]],
        },
    },
    /*
     * 2026 entries of 16 bytes at data 0x58DD50: texture word, material word,
     * mesh pointer, polygon count. The draw routine at 0x1E8D8 indexes it with
     * `lda 0x258DD50[g0*16]` and reads the mesh pointer at +8. Model 555 runs
     * past the decoder's usual cap of 4096 vertex pairs.
     */
    modelTable: { offset: 0x58dd50, count: 2026, stride: 16, maxVertexPairs: 8192 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: null,
    /*
     * Laid in blocks, not tables. Boot writes {count, colours} from entry 0 at
     * 0x1E8F8 (0x162E4); the title lays the block at 0x1EBA0 and the court
     * set-up the one at 0x1EAF0, both {first, count, colours} (0x16370). A
     * team's block is `ld 0xF18A0[n*4]`, laid by 0x1F0E0. The game's 34 team
     * numbers are 17 teams twice: 0..16 for the home side, 17..33 for the away.
     */
    palette: { base: 0x1e8f8, blocks: [0x1eba0, 0x1eaf0], tables: 0xf18a0, sets: 34, titleSet: 34 },
    /*
     * Raw pages, copied by the program (js/texture.js): two boot pages of kind
     * 0x20, then a team's page from `ld 0xF1810[n*4]`. Sets 0..33 are the team
     * numbers; set 34 is the title's page (0x256B8), which the attract arena,
     * model 555, is drawn from.
     */
    texture: {
        raw: {
            layout: 'airwlkrs',
            boot: [[0x02000000, 0, 0x20], [0x020aaa00, 1, 0x20]],
            teamPages: 0xf1810,
            title: [0x02155400, 1, 0x31],
            titleSet: 34,
            titleModels: [539, 555],
        },
        sets: 35,
        residentSet: null,
        defaultSet: 0,
    },
    /*
     * The luma table is the 2A library's, 0x4000 bytes at 0x54C0 in the program
     * ROM. The rest is js/colors.js's Air Walkers section: the ramp, the
     * boot's and the title's runs, the court's five tables, the five fixed
     * ones, the variant's two, then the team's. A home team (0..16) brings its
     * own court and variant; the away side's numbers take court 0 and variant
     * 1, the one MAME's game played on court 0.
     */
    colors: {
        luma: { source: 'maincpu', data: 0x54c0, bytes: 0x4000 },
        airwlkrs: {
            floor: 0x1b9c0, slots: 0xf17f0, runs: [0x41f0, 0x4d31],
            stages: 0xd440, stageSlots: 0xf1980,
            fixed: [[0x4731, 7], [0x47f1, 8], [0x48b1, 9], [0x4971, 10], [0x4a31, 11]],
            variants: [0xd484, 0xd494],
            teams: 0x11a64, teamCount: 34, variant: 1, titleSet: 34,
        },
        solid: true,
    },
    /* The 2D pictures (js/cells.js): The House of the Dead's format, Data
     * East's own copy of it. 492 entries of three pointers, tiles, colours and
     * map, at data 0xC15220 (the 1MB EPROM pair's third repeat, as the code
     * names it); the next word is no pointer, and nothing bounds the table.
     * 0xC3CD0 loads a picture into free blocks the first time it is drawn,
     * each chunk of tiles to a 128-tile block of its own and its 16 colours to
     * every block it takes; the draw (0xC3F10) adds `(g2 << 15) + (g3 << 14)
     * + (firstBlock << 7)` to the map's entries, so the group is the block.
     * Colours go through colorxlat. */
    cells: { pictures: { table: 0x02c15220, count: 492 }, charBytes: 0x80000, colorxlat: true },
    /*
     * The courts (js/airwlkrs.js): the set-up 0x247D0 (court, variant) and
     * the draw 0x24DA0 (court) run on js/i960.js. The team records are 20
     * bytes at 0xFBA80, the city's name, the nickname's, the court variant at
     * +12. The draw's players (0x23850), the colour and palette uploads
     * (0x1BAD0, 0x16370) and the page copies (0x1D430) are skipped; 0x24470
     * puts both hoops' detail in 0x521768/9. The frame start's material
     * slots are 31 at 0x1B3C0.
     */
    airwlkrs: {
        setup: 0x247d0, draw: 0x24da0, courts: 17, teams: 0xfba80,
        skip: [0x23850, 0x1bad0, 0x16370, 0x1d430], hoops: 0x24470, hoopShown: 0x521768,
        materials: { at: 0x1b3c0, count: 31 },
    },
    stageTable: { airwlkrs: true, flat: true },
    /*
     * The players (js/airwlkrs.js): sixteen models a player at `players`,
     * five players a team, 34 teams and the three of team 34; the legs'
     * routine and the rest's run on an object at `object` with the pose at
     * `pose`, which `mirror` copies from `eased`, mirrored or not. The read-backs are the feet's, the head's and the hands' ends.
     * Each motion has a 12-byte record at `motions.records`: the hands it
     * holds (+4, +5), its flags (+3) and its second-table entry (+8).
     */
    rig: {
        kind: 'airwlkrs',
        players: 0xf4b20, teamStride: 0x190, playerStride: 0x50, specialTeam: 34, specials: 3,
        draw: [0x214a0, 0x21a70], drawSpecial: [0x20850],
        object: 0x510b40, pose: 0x5214c0, modelOffset: 0x5215f0, eased: 0x521520, mirror: 0x1fd10,
        ends: [0x5215e0, 0x521600, 0x521610, 0x521620, 0x521630],
        motions: {
            table: 0x026e3ca0, roots: 0x025bf740, count: 0x286,
            records: 0xf2c60, alternate: 0xf2c68, altTable: 0x02ce9750, altRoots: 0x02ce96c0,
        },
    },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};

/* ---- Power Sled ----------------------------------------------------------- */

/*
 * Power Sled's 2D pictures (js/cells.js `scripts`): the attract's panels,
 * the entry and course select, the ranking, drawn by 0x4EE0 from tilemap
 * scripts in the data ROM. Its callers load g0 with the tilemap address and g1
 * with the script, both by `lda`, and set bit 15 of g2; 0x52D0 erases what a
 * script drew by walking it again. The scripts lie end to end from data
 * 0x322500 to 0x323108, thirty of them; there a table of thirty offsets
 * from itself names the same thirty starts, though nothing reads it. No call
 * names eight of them (`unused`).
 *
 * The tile chip is filled once, at boot (0x46F0):
 *   0x48B0   expands the 1bpp font at 0x33F0 into characters 0-255, pen 1;
 *   0x4EA0   copies data 0x300000, 0x22500 bytes, to character 256 on,
 *            straight (no byte swap);
 *   0xF100   fills groups 0-127 with the 16 colours at 0xF0C0 and 128-255
 *            with 0xF0E0 (white and grey on black, the font's), then copies
 *            0x230 colours from data 0x323180 to group 2 on (0xF17C).
 * The characters match m2-hle2's character RAM in the attract byte for byte,
 * and the palette all but colour 0 of group 0. The palette goes through
 * colorxlat, as every Model 2 tile palette does.
 */
const POWSLED_CELLS = {
    scripts: [0x02322500, 0x02323108],
    unused: [0, 1, 3, 4, 9, 10, 17, 18],
    boot: {
        font: { src: 0x33f0, first: 0, count: 256, pen: 1 },
        chars: [[0x02300000, 0x100, 0x1128]],
        straight: true,
        palette: [
            { colours: 0xf0c0, group: 0, groups: 128 },
            { colours: 0xf0e0, group: 128, groups: 128 },
            { block: 0x02323180, group: 2, groups: 35 },
        ],
    },
    charBytes: 0x80000,
    programAt0: true,
    colorxlat: true,
};

/*
 * Sega's sled racer on Model 2B CRX (m2-hle2's src/profiles/powsled.h,
 * MAME's `powsled`, the Slave unit's program, Revision A). Like Air Walkers it
 * keeps nothing in the AM2 shapes: it has no model table, its colours are a
 * curve it works out, and its textures are one straight copy.
 */
const powsled = {
    id: 'powsled',
    name: 'Power Sled (Slave, Revision A)',
    identify: ['epr-19470a.15', 'epr-19471a.16', 'fpr-19455.17', 'fpr-19458.27'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19470a.15', 0x8f28cc09, 'epr-19471a.16', 0x01a013e3]],
        },
        mainData: {
            size: 0x800000,
            parts: [[0x000000, 'fpr-19468.11', 0x56fae4e2, 'fpr-19469.12', 0x5579c922]],
        },
        polygons: {
            size: 0x800000,
            parts: [[0x000000, 'fpr-19455.17', 0x165ee345, 'fpr-19456.21', 0xc3b2e2c5]],
        },
        textures: {
            size: 0x800000,
            parts: [[0x000000, 'fpr-19458.27', 0xf24acca2, 'fpr-19457.25', 0x79d7e6fa]],
        },
    },
    /*
     * No table: js/powsled.js lists every {texture word, material word, mesh}
     * triple the program hands the geometry engine, out of the data ROM's
     * placement records, the program's named records and its immediates.
     * 494 of them, sorted by mesh.
     */
    modelTable: { list: 'powsled', count: 494, offset: 0 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* {count, colours}: 0x20A colours at 0x128EE, copied to the face palette
     * (0x1802000) by 0xF1B0. */
    paletteProgram: 0x128ec,
    paletteOffset: null,
    /* And then 0xF1F8 greys entries 8 to 63 (0x39CE) over the table's zeros,
     * as m2-hle2's palette RAM holds them through the race. */
    paletteFixes: Array.from({ length: 56 }, (_, k) => [8 + k, 0x39ce]),
    /* Data 0x600000 on sheet 0 and 0x700000 on sheet 1, by 0xC540. */
    texture: {
        raw: { layout: 'copy', sheets: [0x02600000, 0x02700000] },
        sets: 1,
        residentSet: null,
        defaultSet: 0,
    },
    /* js/colors.js's Power Sled section: luma from 0xC8F0, colorxlat from
     * 0xE2D0 and 0xE1D0 with the odd rows' colours at 0xCB50. */
    colors: {
        luma: { halfRamp: true },
        powsled: { table: 0xcb50, rows: 15 },
        solid: true,
    },
    /* Daytona's depth arrangement too: the banners at the finish are a plain
     * face with its lettering laid on it as a second, cut-out one (the flag's
     * stripes, 1996 KEROLYMPIC), which without the layering fight. */
    depth: { recede: 0, nearMin: 0.02, layers: true },
    /*
     * The Model 2B's sound board with one 4 MB sample chip, and Sega's
     * CRX_drv 3.0.6 (by HiroF, 7 May 1996, the string at 0x10 of the program;
     * Dynamite Cop's is 3.2.8). Its UART handler (0x600486) is a MIDI parser
     * with running status, and status A0 with a middle byte 0x10 to 0x5F
     * (0x601B1A) starts entry `last` of group `middle` - 0x10 in the table
     * 0x60801C points to. That table has five groups: 0x10 is empty (count
     * -1), 0x11 to 0x14 hold 16, 6, 4 and 5 sounds, and every one of them
     * starts in the effect slots (first byte bit 7 set), none in the music
     * slot; A0 00 01 stops them. Nothing names them. Measured on the board,
     * 11 0A, 11 0C, 12 04, 13 00, 13 02 and 14 01 hold their level; 12 04
     * and 13 00 are noise (wind and snow, by their flat spectrum), and 13 02
     * is the loudest tonal one, likely the song Sega Racing Best carries.
     * The attract mode sends A0 00 01, A0 13 03, A0 13 01 and A0 70 00.
     */
    sound: {
        program: ['epr-19466.31', 0xc42892a5],
        samples: [['fpr-19459.32', 0xa424743f]],
        sampleChip: 0x400000,
        boot: [0xA0, 0x00, 0x01],
        stop: [0xA0, 0x00, 0x01],
        music: {
            list: { groups: [[0x11, 16], [0x12, 6], [0x13, 4], [0x14, 5]], status: 0xa0 },
            own: 'none',
            hint: 'Every sound in the sound driver\'s table, by its command: the program names none of them. A0 13 02 is the loudest tune among them, likely the song; A0 12 04 and A0 13 00 are wind',
        },
    },
    /*
     * The race's light goes to the geometrizer as it is (function 0xA,
     * 0x3672C and 0x3740C): (0.1, -1, 0.01), near enough straight down.
     * Z is negated, as for Daytona. The materials are the 32 pairs at
     * 0xEBC0 that 0xED04 sends with function 6 at boot (0xEB70, count
     * 31 + 1): the rocks are lit by slot 25, which the first 16 left black.
     */
    lighting: {
        light: [0.1, -1, -0.01],
        materials: { source: 'maincpu', at: 0xebc0, count: 32, stride: 8 },
    },
    /* The one course, run out of the race's own scene routines
     * (readPowsledStages in js/powsled.js). */
    stageTable: { powsled: true, flat: true },
    cells: POWSLED_CELLS,
    /*
     * The figures (js/powsled.js): tables in the data ROM of every part's
     * matrix a frame, drawn by 0xE1D70. `at` is the table's data ROM offset.
     * The ride scenes (0xE44B0 on, `rides` below) play 0x4770, 0x3FF34,
     * 0x13E018, 0x18E4C0 and 0x1DE968; 0xE7034 and 0x285A68 are named by two records
     * at 0x3B2A0 whose player is not found; no address in the program names
     * the other three, found by their layout. The game names none: the names
     * say what they show.
     */
    rig: {
        kind: 'powsled',
        figures: [
            { at: 0x4770, name: 'crane with a sled' },
            { at: 0x260c0, name: 'crane with a sled, lowering it' },
            { at: 0x32f70, name: 'crane arm and claw' },
            { at: 0x3ff34, name: 'woman in a yellow suit' },
            { at: 0xe7034, name: 'three-part object' },
            { at: 0xedb70, name: 'two riders on a sled' },
            { at: 0x13e018, name: 'two riders on a sled, second take' },
            { at: 0x18e4c0, name: 'two riders on a sled, third take' },
            { at: 0x1de968, name: 'woman in a yellow suit, second take' },
            { at: 0x285a68, name: 'three-part object, mirrored' },
        ],
        /*
         * The ride scenes of mode 5 (js/powsled.js, rideScenes): `ride` is
         * the number at 0x5293F0 that 0x33780 picks the task by, and the
         * colour 0xE1F30 dresses the sled in; `waiting` the task's handler
         * until Entry and `scene` the one after; `layout` a for the camera
         * 0xE2830, b for 0xE2E00.
         */
        rides: [
            { ride: 1, name: 'ride 1, red', waiting: 0xe5760, scene: 0xe44b0, layout: 'a' },
            { ride: 2, name: 'ride 2, black', waiting: 0xe5aa0, scene: 0xe4820, layout: 'b' },
            { ride: 3, name: 'ride 3, yellow', waiting: 0xe6190, scene: 0xe4be0, layout: 'a' },
            { ride: 0, name: 'ride 0', waiting: 0xe5e30, scene: 0xe4f50, layout: 'b' },
        ],
    },
    features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
};
/* ---- Last Bronx ----------------------------------------------------------- */

/*
 * Sega's 1996 fighter on Model 2B CRX (MAME's `lastbrnx`, Revision A Export,
 * and its Japan clone `lastbrnxj`). Its program keeps nothing in the AM2
 * shapes: the stages' textures are an LZ stream it deals onto the sheets, the
 * fighters' pages are raw, and its colour tables are worked out from the test
 * menu's settings and keyframes, so js/texture.js and js/colors.js each have a
 * section for it. The two builds keep the same tables at the same program
 * offsets, except the program's data section, which the Japan build has
 * 0x120 further on, and what follows it.
 */
function lastbronxBuild(build) {
    const { id, name, program, data, chars, settings, code, located } = build;
    return {
        id,
        name,
        settle: located ? (rom) => settleLastbronx(build, rom) : undefined,
        identify: [program[1], program[3], 'mpr-19052.17', 'mpr-19055.27'],
        regions: {
            maincpu: { size: 0x200000, parts: [program] },
            mainData: {
                size: 0x1000000,
                parts: [
                    [0x000000, 'mpr-19050.11', 0xe6af2b61, 'mpr-19051.12', 0x14b88961],
                    [0x800000, 'mpr-19048.9', 0x02180215, 'mpr-19049.10', 0xdb7eecd6],
                ],
            },
            polygons: {
                size: 0x800000,
                parts: [[0x000000, 'mpr-19052.17', 0xd7f27216, 'mpr-19053.21', 0x1f328465]],
            },
            textures: {
                size: 0x400000,
                parts: [[0x000000, 'mpr-19055.27', 0x85a57d49, 'mpr-19054.25', 0x05366277]],
            },
        },
        /*
         * 2544 entries of 16 bytes in the program ROM at 0x189B0: texture
         * word, material word, mesh pointer, polygon count, up to the byte
         * table at 0x229B0. The draws at 0x4370C and 0xAD930 send an entry as
         * it is (`ld 0x189B0..0x189BC`, `stq g0, 0x804000` after
         * `st 0x101, 0x800010`). Entries 1691, 1692, 1772 and 1773 name a
         * mesh at polygon RAM word 0x4000, which the program fills itself,
         * and are not shown.
         */
        modelTable: { source: 'maincpu', offset: 0x189b0, count: 2544, stride: 16 },
        meshPtr: { subtract: 0x02000010, add: 0x10 },
        /* {count, colours}: 318 colours at 0x1872E, copied to the face palette
         * (0x1802000) by 0x157F0. Entries 8 to 19 and 40 to 48 cycle on some
         * stages (js/lastbrnx.js, paletteCycles); the table holds a frame. */
        paletteProgram: 0x1872c,
        paletteOffset: null,
        /*
         * js/texture.js's Last Bronx section. Sets 0..8 are the stages; a
         * stage picks one of three banks (`stageBanks`). Sets 9..26 are a
         * fighter alone, 9 + 2 * char + costume (lastbrnxScene in
         * js/colors.js). `pages` are the fighters' pages, page 0 the common
         * one; `chars` the fighter records, 128 bytes each, word 7 the page
         * and words `lists` its model lists, `listLength` model pointers each.
         * `fighters` are the attract's first fight, Yoko (costume 0) against
         * Zaimoku (costume 1), on Cross Street (stage 2).
         */
        texture: {
            raw: {
                layout: 'lastbrnx',
                data: { ram: 0x500000, rom: data },
                deal: 0x8320,
                banks: 0x500010,
                stageBanks: 0x5042b0,
                pages: 0x500030,
                chars,
                charStride: 128,
                fighters: [{ char: 0, costume: 0 }, { char: 7, costume: 1 }],
                stages: 9,
                lists: [1, 2, 3, 4, 5, 10, 11],
                listLength: 28,
            },
            sets: 27,
            residentSet: null,
            defaultSet: 2,
        },
        /*
         * Luma from 0x1A50, two bands of divisors 120 and 112. The rest is
         * js/colors.js's Last Bronx section: the ramps and the flat band from
         * the colour settings, then the stage's, the two common and the
         * fighters' keyframe tables.
         */
        colors: {
            luma: { bands: [120, 112] },
            lastbrnx: {
                data: { ram: 0x500000, rom: data },
                settings,
                chars,
                charCount: 9,
                stages: 0x504310,
                stageLists: { pairs: 0x502aa0, dst: 0x5534d0, size: 0x20, count: 5 },
                common: 0x502a08,
                fighterLists: { pairs: 0x502a10, dst: 0x5533b0, size: 0x10, count: 4 },
            },
            solid: true,
        },
        /*
         * The light geometrizer function 0x0A gets at boot (0x801C), with Z
         * negated as for Daytona USA, and the 32 material pairs at 0x7E00
         * that 0x7D98 sends with function 6.
         */
        lighting: {
            light: [0.5, -0.7, -0.5],
            materials: { source: 'maincpu', at: 0x7e00, count: 32, stride: 8 },
        },
        /* The depth buffer, with faces laid on others ranked over them
         * (js/layers.js), and no z-sort. The stages are rooms of whole
         * models standing on one another, and the board's keys only hold
         * from its own camera: from beside the Java Tea machine in the
         * parking lot, the 15 m kerb it stands on (model 493) sorts by its
         * near corner and was painted over the machine's side (issue 205). */
        depth: { recede: 0, nearMin: 0.02, layers: true },
        /*
         * js/lastbrnx.js: the stage task's own draw (0x71AC0) and ring walls
         * (0x72640) run on a stage byte (0x57DEC0), the camera (0x71DB0) left
         * out and every placement kept (0x5D2E60 = 2), after the moving
         * pieces' setup (0x941E0), the Export build's addresses; the Japan
         * build's code is `code` further on there. `names` the stage names'
         * pointers (RAM, in the data section `dataSize` long the boot copies).
         * `cycles` the face palette's colour cycles: the round start (0x17950)
         * takes a list of them by the stage's object kind (`kinds`).
         */
        stageTable: {
            lastbrnx: {
                count: 9, stageByte: 0x57dec0, cullAll: 0x5d2e60, camera: 0x71db0 + code,
                init: 0x941e0 + code, draw: 0x71ac0 + code, walls: 0x72640 + code,
                names: 0x504250, dataSize: 0x2d080, cycles: { lists: 0x502b00, kinds: 0x5042e0 },
                /* The stage skies (js/cells.js lastbrnxSky): CG directories, block
                 * lists, scroll records; Cross Street stretches its own. */
                sky: { cgs: 0x504340, lists: 0x5043a0, scroll: 0x504820, focal: 506.25, stretch: 2 },
            },
            flat: true,
        },
        /*
         * js/lastbrnxfighters.js: the fighters, drawn by the fight code with
         * the copro's own program run beside it. `boot` is the boot's set-up
         * (0x1380, 0x1520) as far as the fight needs, [routine, args, steps];
         * 'sync' is the 8 the boot pushes the copro. `upload` (0x98D8) is
         * answered by loading the program. `names` the fighter names, 9 bytes
         * each (data section); `motions` the tables per motion set, the set
         * word `setWord` of the fighter's record in `chars`. From `codeFrom`
         * the Japan build's code is `code` further on.
         */
        rig: {
            kind: 'lastbrnx', note: 'lastbrnx', code, codeFrom: 0x2a680,
            fighters: 8, names: 0x503f90, chars, setWord: 12,
            motions: { names: 0x52cea0, data: 0x511ba0, heads: 0x52b4d0 },
            sharc: { at: 0x99f8, halfwords: 19698 },
            upload: 0x98d8,
            boot: [
                [0x12c0], [0x9110], [0x13490], [0x97d0], [0x154d0], [0x17870], [0x72e0, [], 100_000],
                [0x15b0], [0x3e570], [0x366c0], [0x17cb0], [0x3f410], [0xd60], [0x1330], [0x13420],
                [0x9b130], [0x39070], ['sync'], [0x4bc80], [0x452d0], [0x54a40], [0xb71c0],
                [0xc7760, [0x1e240]], [0x231f0, [0x1e240]], [0x4f400],
            ],
            setup: 0xb5e10, start: 0x49540, step: 0x49820, draw: 0x4a940,
            /* The skins between the parts (waists, sleeves): 0x9B3B0 builds
             * them on the copro, 0x9B5E0 draws them. */
            skin: { build: 0x9b3b0, draw: 0x9b5e0 },
        },
        /*
         * The Model 2B's sound board with two 4 MB sample chips, and Sega's
         * CRX_drv 3.1.1 (by HiroF, 6 June 1996, the string at 0x100 of the
         * program). The i960 talks to it through the 2B's UART at 0x9C0000:
         * 0x17EA0 queues a three-byte command, and the wrappers 0x18120 and
         * 0x18150 drop it in a silent attract (mode 4 with 0x56CBDD clear),
         * which is why MAME's attract sends nothing but the volume.
         *
         * The songs are A0 10 00 to A0 10 0F, and the sound test names all
         * sixteen: records of a command and a name pointer, `bgmcc` to
         * `bgmrankout` (0x364D8 Export, 0x365F8 Japan). The round start
         * (0x277E0) sends the stage's song out of nine commands (0x26910
         * Export, 0x26A20 Japan) by the index it also takes the stage byte
         * from, through the data section's table 0x504280: so stage 0 plays
         * bgmnun, 1 bgmbok, 2 bgmkon, 3 bgmtomp, 4 bgmssk, 5 bgmham,
         * 6 bgmsai, 7 bgmkan and 8 bgmbonus. Boot sends A0 0D 3E, MASTER
         * VOLUME (0x56CBE6, 0..7, 3 at the factory) as A0 0D 3B + volume;
         * the songs are quieter than other games' for it, as on the board.
         */
        sound: {
            program: ['mpr-19056.31', 0x22a22918],
            samples: [['mpr-19057.32', 0x64809438], ['mpr-19058.34', 0xe237c11c]],
            sampleChip: 0x400000,
            boot: [0xA0, 0x00, 0x01, 0xA0, 0x0D, 0x3E],
            stop: [0xA0, 0x00, 0x01],
            stageSongs: { first: 0xa01000, count: 9, order: data + 0x4280 },
            music: {
                list: { first: 0xa01000, count: 16, stride: 8, nameAt: 4, strip: 'bgm' },
                own: "the stage's own",
                hint: 'The song the stage plays. The game plays its stage\'s own at the round start; this plays any of the sixteen its sound test lists, by the names the sound test gives them',
            },
        },
        /* The Cells tab (js/cells.js `groups`): the tilemap scripts Power
         * Sled's draw runs, as Last Bronx's draw (0x14CD0) runs them, and the
         * CGs its loader (0x149F0) reads. Fourteen records of a CG, a list of
         * its cells and their count sit beside the sound test's songs (0x36560
         * Export, 0x36680 Japan): 508 cells, each written wholly by its CG and
         * the boot's (data 0xA00000, loaded at boot by 0x14740 and never
         * unloaded). Every script the code draws by `lda` is in one of them. */
        cells: {
            groups: { table: 0x36560 + code, count: 14, boot: 0x02a00000 },
            script: { bias: 0, last: 0x8e, wideMove: true },
            charBytes: 0x80000,
            programAt0: true,
            colorxlat: true,
        },
        features: { stages: true, characters: false, motions: true, bodies: true, cells: true },
    };
}

const lastbrnx = lastbronxBuild({
    id: 'lastbrnx', name: 'Last Bronx (Export, Revision A)',
    program: [0x000000, 'epr-19061a.15', 0xc0aebab2, 'epr-19062a.16', 0xcdf597e8],
    data: 0xc9100, chars: 0xb53b0, settings: 0x3d4bb, code: 0,
});
/*
 * The USA build is not in the container, so its offsets are not measured: the
 * Export build's stand in until the set is loaded, then `settleLastbronx`
 * moves them by as much as the program's data section has moved. The boot
 * copies that section from the address it keeps at 0x83C (0xC9100 Export,
 * 0xC9220 Japan); in the Japan build the code the stages run and the tables
 * moved by the same 0x120. Each routine is checked by its first word, and a
 * build where one is not there gets no Stages tab.
 */
const LASTBRONX_EXPORT = { data: 0xc9100, chars: 0xb53b0, settings: 0x3d4bb, code: 0 };
const LASTBRONX_FIRST_WORDS = [[0x71ac0, 0x80a03000], [0x72640, 0x80a03000], [0x71db0, 0x59084810], [0x941e0, 0x5ca81e00]];
/* The CG table's first list, which the Cells tab needs where it is. */
const LASTBRONX_CELLS_WORD = [0x36564, 0x02a00024];
/* And the fighters' set-up, motion start, step, draw and skins, for the Fighters tab. */
const LASTBRONX_FIGHTER_WORDS = [[0xb5e10, 0x5c601618], [0x49540, 0x8cb800b8], [0x49820, 0x8c086080], [0x4a940, 0x8ce800b8],
    [0x9b3b0, 0x8cb8004f], [0x9b5e0, 0x8ce80707]];

function settleLastbronx(build, rom) {
    const cv = rom.mainCpuView;
    const shift = cv.getUint32(0x83c, true) - LASTBRONX_EXPORT.data;
    const at = (o) => o + shift;
    const there = ([o, w]) => at(o) >= 0 && at(o) + 4 <= cv.byteLength && cv.getUint32(at(o), true) === w;
    const fits = LASTBRONX_FIRST_WORDS.every(there);
    const g = lastbronxBuild({
        ...build, located: false, data: at(build.data), chars: at(build.chars),
        settings: at(build.settings), code: build.code + shift,
    });
    if (!fits) {
        g.features = { ...g.features, stages: false };
        console.warn(`${g.name}: the stage routines are not ${shift} bytes on from the Export build's; no Stages tab`);
    }
    if (!there(LASTBRONX_CELLS_WORD)) {
        g.features = { ...g.features, cells: false };
        g.cells = undefined;
        console.warn(`${g.name}: the CG table is not ${shift} bytes on from the Export build's; no Cells tab`);
    }
    if (!LASTBRONX_FIGHTER_WORDS.every(there)) {
        g.features = { ...g.features, motions: false, bodies: false };
        console.warn(`${g.name}: the fight routines are not ${shift} bytes on from the Export build's; no fighters`);
    }
    return g;
}

const lastbrnxu = lastbronxBuild({
    id: 'lastbrnxu', name: 'Last Bronx (USA, Revision A)',
    program: [0x000000, 'epr-19059a.15', 0x25478257, 'epr-19060a.16', 0xc48906b2],
    ...LASTBRONX_EXPORT, located: true,
});
const lastbrnxj = lastbronxBuild({
    id: 'lastbrnxj', name: 'Last Bronx (Japan, Revision A)',
    program: [0x000000, 'epr-19046a.15', 0x75be7b7a, 'epr-19047a.16', 0x1f5541e2],
    data: 0xc9220, chars: 0xb54d0, settings: 0x3d5db, code: 0x120,
});

/* ---- Pilot Kids ----------------------------------------------------------- */

/*
 * The Cells tab (js/cells.js): Virtua Cop's records, the width and the
 * height then the entries, which the draws store with bit 15 set (`base`).
 * Nothing numbers them but a viewer in the check menu beside the model
 * check (0x10390), which steps through the zero-ended table at data
 * 0xE850C, 74 records. The two words before it are the files the boot
 * (0x596E0) loads through 0x5A820:
 * a first block, a block count, a table of colour pointers, then the
 * blocks' characters, copied straight from character first * 128, each
 * block taking its own pointer's 16 colours as its group (0x5A770). Before
 * them the boot draws 128 characters of 1bpp font in pen 1 (0x599D0) and
 * fills character 1 with pen 15; 0x51B10 stores white in colour 1.
 */
const PLTKIDS_CELLS = {
    sized: true,
    patternTable: 0x020e850c,
    base: 0x8000,
    boot: {
        font: { src: 0x02041600, first: 0, count: 128, pen: 1 },
        chars: [[0x02063f28, 4 << 7, 15 << 7], [0x02074158, 20 << 7, 104 << 7]],
        straight: true,
        fill: [[1, 1, 0xffff]],
        palette: [
            { set: [[1, 0xffff]] },
            { pointers: 0x02072f50, group: 4, groups: 15 },
            { pointers: 0x020dc740, group: 20, groups: 104 },
        ],
    },
    charBytes: 0x80000,
    colorxlat: true,
};

/*
 * Psikyo's 1998 shooter on Model 2B CRX (MAME's `pltkids`, Revision A) and
 * its Model 2A build (`pltkidsa`, a clone: its zip holds the program and the
 * 2A board's TGP and sound chips, and the data, polygon and texture chips are
 * read from pltkids.zip beside it). Nothing of the AM2 library: the program
 * deals its pages out of the data ROM itself and works its colour tables
 * out, so js/texture.js and js/colors.js each have a section for it. The two
 * programs keep their tables at the same offsets, but for the colour table
 * list (`colorTables`), which the 2A build has 0x80 sooner.
 */
function pilotKidsBuild({ id, name, program, extra = [], colorTables }) {
    return {
        id,
        name,
        identify: [program[1], program[3], ...extra],
        regions: {
            maincpu: { size: 0x100000, parts: [program] },
            mainData: {
                size: 0x800000,
                parts: [[0x000000, 'mpr-21262.da0', 0xaa71353e, 'mpr-21263.da1', 0xd55d4509]],
            },
            polygons: {
                size: 0x2000000,
                parts: [
                    [0x0000000, 'mpr-21264.tp0', 0x6b35204d, 'mpr-21268.tp1', 0x16ce2147],
                    [0x0800000, 'mpr-21265.tp2', 0xf061e639, 'mpr-21269.tp3', 0x8c06255e],
                    [0x1000000, 'mpr-21266.tp4', 0xf9c32021, 'mpr-21270.tp5', 0xb61f81c3],
                    [0x1800000, 'mpr-21267.tp6', 0xc42cc938, 'mpr-21271.tp7', 0xa5325c75],
                ],
            },
            textures: {
                size: 0x1000000,
                parts: [
                    [0x000000, 'mpr-21274.tx1', 0xf045e3d1, 'mpr-21272.tx0', 0xdd605c21],
                    [0x800000, 'mpr-21275.tx3', 0xc4870b7c, 'mpr-21273.tx2', 0x722ec8a2],
                ],
            },
        },
        /*
         * 4185 entries of 24 bytes in the data ROM at 0x28D90, up to the
         * zeros before the font at 0x41708: texture word, material word, mesh
         * pointer, polygon count, then two more texture words. Every one of
         * the program's 13 references to 0x2028D90 is a draw (0x5DEE0 to
         * 0x5F0DC in the 2B build) that sends four words of an entry
         * (`lda 0x2028d90[g0*8]`, `st 0x101, 0x800010`, `stq` to 0x804000):
         * words 0, 1, 2, 3, or with word 4 or 5 for word 1 (0x5DF40, 0x5DF80).
         */
        modelTable: { offset: 0x28d90, count: 4185, stride: 24 },
        meshPtr: { subtract: 0x02000010, add: 0x10 },
        /* {count, colours}: 674 colours at 0x19E32, copied to the face palette
         * (0x1802000) by 0x51B10. */
        paletteProgram: 0x19e30,
        paletteOffset: null,
        /*
         * js/texture.js's Pilot Kids section: the ten loads at 0x5BF30, load
         * 0 common and set s the common one with scene load s + 1 over it.
         * Set 7 (load 8) is the title's, the one the game opens on.
         */
        texture: {
            raw: { layout: 'pltkids', loads: 0x5bf30 },
            sets: 9,
            residentSet: null,
            defaultSet: 7,
        },
        /*
         * Luma: 0x5C9F0 copies the 0x8000 bytes at 0x6650. Colorxlat:
         * js/colors.js's Pilot Kids section.
         * `scenes` by texture set, as m2-hle2 shows the loads paired: loads
         * 1, 2 and 3 with tables 4, 3 and 1 (the attract's three demos), load
         * 4 with table 7 (the first stage played), load 8 with table 8 (the
         * title). Loads 5, 6, 7 and 9 were not reached.
         */
        colors: {
            luma: { source: 'maincpu', data: 0x6650, bytes: 0x8000 },
            pltkids: { tables: colorTables, counts: 0x65f0, scenes: [4, 3, 1, 7, null, null, null, 8, null] },
            solid: true,
        },
        cells: PLTKIDS_CELLS,
        /* No stage, fighter or motion data is read yet. */
        features: { stages: false, characters: false, motions: false, bodies: false, cells: true },
    };
}

const pltkids = pilotKidsBuild({
    id: 'pltkids', name: 'Pilot Kids (Model 2B, Revision A)',
    program: [0x000000, 'epr-21285a.15', 0xbdde5b41, 'epr-21286a.16', 0xc8092e0e],
    extra: ['mpr-21262.da0', 'mpr-21264.tp0'],
    colorTables: 0x82300,
});
/* Known by its program alone, so that pltkids.zip missing is said as such. */
const pltkidsa = pilotKidsBuild({
    id: 'pltkidsa', name: 'Pilot Kids (Model 2A)',
    program: [0x000000, 'epr-21281.pr0', 0x293ead5d, 'epr-21282.pr1', 0xed0e7b9e],
    colorTables: 0x82280,
});

/*
 * Sega's 1997 bike race on Model 2A CRX (MAME's `motoraid`). Not of the AM2
 * library: the model table is in the program
 * ROM, the sheets are raw banks the program copies in itself, and its colour
 * tables are its own routines, run (js/motoraid.js).
 */
const motoraid = {
    id: 'motoraid',
    name: 'Motor Raid',
    identify: ['epr-20007.12', 'epr-20008.13', 'mpr-20023.16', 'mpr-20022.25'],
    regions: {
        maincpu: {
            size: 0x200000,
            parts: [[0x000000, 'epr-20007.12', 0xf040c108, 'epr-20008.13', 0x78976e1a]],
        },
        /* The EPROM pair is a megabyte, repeated to fill its 8 MB slot. */
        mainData: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-20019.10', 0x49053727, 'mpr-20020.11', 0xcc5ddb15],
                [0x0800000, 'mpr-20017.8', 0x4e206acd, 'mpr-20018.9', 0xe7ed0e85],
                [0x1000000, 'mpr-20015.6', 0x23427339, 'mpr-20016.7', 0xc99a83f4],
                ...Array.from({ length: 8 }, (_, i) =>
                    [0x1800000 + i * 0x100000, 'epr-20013.4', 0xa4478f52, 'epr-20014.5', 0x1aa541be]),
            ],
        },
        polygons: {
            size: 0x1800000,
            parts: [
                [0x0000000, 'mpr-20023.16', 0x016be8d6, 'mpr-20026.20', 0x20044a30],
                [0x0800000, 'mpr-20024.17', 0x62fd2d5b, 'mpr-20027.21', 0xb2504ea6],
                [0x1000000, 'mpr-20025.18', 0xd4ecd0be, 'mpr-20028.22', 0x3147e0e1],
            ],
        },
        textures: {
            size: 0x800000,
            parts: [[0x000000, 'mpr-20022.25', 0x9e47b3c2, 'mpr-20021.24', 0x3cbf36cb]],
        },
    },
    /*
     * 7671 entries of 16 bytes in the program ROM at 0x4F500 (`lda 0x4F500`
     * at 0x4F4E0), up to the data-pointer table at 0x6D480: texture word,
     * material word, mesh pointer, polygon count. Entries 0 and 1 are empty.
     */
    modelTable: { source: 'maincpu', offset: 0x4f500, count: 7671, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* XTRA_DATA (0x06000000) is main_data from 0x1000000; set 6's bank is
     * 0x06700000. */
    xtra: { window: 0x1000000, banks: [{ region: 'mainData', base: 0x1000000 }] },
    /* Laid by the boot and the scene's set-up, run (js/motoraid.js). */
    paletteOffset: null,
    palette: { layout: 'motoraid' },
    /*
     * Raw banks, copied by 0x2F990 (HOTD's arrangement, uploadRawBank): the
     * boot (0x2FB00) puts 0x02000000 on sheet 0 and 0x02100000 on sheet 1,
     * and a scene's set-up (0x21C9B0) bank 0x21C910[n] on sheet 1, n the
     * scene number at 0x517AE0. The program's copy of that table is 0xCC910.
     * Set 1 is the attract's second scene, checked against MAME.
     */
    texture: {
        raw: { bankTable: 0xcc910, bootBank: 0x02000000 },
        sets: 8,
        residentSet: null,
        defaultSet: 1,
    },
    /*
     * Luma: 0x30060 clears the 0x8000 entries and copies the 0x2800 bytes at
     * data 0x98DD40 from entry 0x3200 on (0x19050 animates 0x3200..0x327F,
     * still here). Colorxlat: js/motoraid.js.
     */
    colors: {
        luma: { source: 'mainData', data: 0x98dd40, bytes: 0x2800, at: 0x3200 },
        motoraid: {
            /* ROM 0xB0000.. is RAM 0x200000.. */
            copy: 0xb0000,
            boot: [[0x2fc70], [0x2fe40, 0], [0x31270, 0, 0x0297a0f4], [0x31270, 0x1f4, 0x0297a366], [0x2ffa0, 0]],
            sceneSlot: 0x517ae0,
            sceneSetup: 0x21c930,
            taskSlots: [0x37630, 0x37660],
        },
        solid: true,
    },
    /* No course, rider or motion data is read yet. */
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Manx TT Superbike (Revision D, the DX cabinet's program; MAME manxtt), a
 * Model 2A AM3 game on Sega Rally's engine: the same 16-byte model table, the
 * same texture deal and colour code the program runs itself, and the same
 * "CGM 1.0" pictures. What moves is where each table is.
 */
const manxtt = {
    id: 'manxtt',
    name: 'Manx TT Superbike (Revision D)',
    identify: ['epr-18822d.12', 'epr-18823d.13', 'epr-18824d.14', 'epr-18825d.15'],
    identifyCrc: [0x4f435990, 0xb8eddb5c, 0xaca9f61f, 0x5a1d7799],
    regions: {
        /* Two pairs of 128 KB chips; MAME mirrors them to 0x200000, which
         * nothing here reads. */
        maincpu: {
            size: 0x80000,
            parts: [
                [0x000000, 'epr-18822d.12', 0x4f435990, 'epr-18823d.13', 0xb8eddb5c],
                [0x040000, 'epr-18824d.14', 0xaca9f61f, 'epr-18825d.15', 0x5a1d7799],
            ],
        },
        /* Luma and the pictures in the first pair, the texture banks in the
         * second, a third that is not textures, and a 1 MB pair of pictures
         * at 0xC00000. */
        mainData: {
            size: 0xd00000,
            parts: [
                [0x000000, 'mpr-18751.10', 0x773ad43d, 'mpr-18752.11', 0x4da3719e],
                [0x400000, 'mpr-18749.8', 0xc3fe0eea, 'mpr-18750.9', 0x40b55494],
                [0x800000, 'mpr-18747.6', 0xa65ec1e8, 'mpr-18748.7', 0x375e3748],
                [0xc00000, 'epr-18862.4', 0x9adc3a30, 'epr-18863.5', 0x603742e9],
            ],
        },
        polygons: {
            size: 0xc00000,
            parts: [
                [0x000000, 'mpr-18753.16', 0x33ddaa0d, 'mpr-18756.20', 0x28713617],
                [0x400000, 'mpr-18754.17', 0x09aabde5, 'mpr-18757.21', 0x25fc92e9],
                [0x800000, 'mpr-18755.18', 0xbf094d9e, 'mpr-18758.22', 0x1b5473d0],
            ],
        },
        /* The UV and material streams; the sheets are raw in the data ROM. */
        textures: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-18760.25', 0x4e3a4a89, 'mpr-18759.24', 0x278d8742]],
        },
        copro: {
            size: 0x400000,
            optional: true,
            parts: [[0x000000, 'mpr-18761.28', 0x4e39ec05, 'mpr-18762.29', 0x4ab165d8]],
        },
    },
    /*
     * 3532 entries of 16 bytes in the program ROM at 0xBB00, tpa, tha, oba
     * and a polygon count, up to 0x197B0. The draws read it 105 times as
     * `lda 0xBB00[gN*16]` and send the four words to the TGP's FIFO.
     */
    modelTable: { source: 'maincpu', offset: 0xbb00, count: 3532, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* {count, colours} at 0x7A404, copied to the face palette (0x1802000) by
     * 0x6770 in the boot's 0x6830. Verified against MAME's palette RAM. */
    paletteProgram: 0x7a404,
    paletteOffset: null,
    /*
     * Sega Rally's deal (uploadSrallycBank in js/texture.js) at 0x3A20 (g0
     * the bank, g1 the flag; g0 = -1 goes on with the upload in progress,
     * a slice a frame), with its run table at 0x3960 and its banks from
     * main_data 0x400000 (`shlo 20; lda 0x2400000(g0)`). The boot (0x3720,
     * 0x3750) deals bank 0 with the flag 0, then bank 1 with the flag 1;
     * 0x8480 deals bank 2, 0x274F4 bank 1, 0x6532C cycles 0..3, and the
     * attract scripts (0x19960, 0x199F0, through 0x1D8E0) deal 3, 2 and 1.
     * A set is the bank laid over bank 0. Set 0, bank 1, is MAME's texture
     * RAM after the boot halfword for halfword.
     */
    texture: {
        raw: { layout: 'srallyc', runTable: 0x3960, bankBase: 0x400000, banks: [1, 2, 3], bootBank: 0 },
        sets: 3,
        residentSet: null,
        defaultSet: 0,
    },
    /*
     * colorxlat by the boot's own 0x6830 (0x68B0's gamma ramp and the rows
     * 0x76B0 and 0x7754 lay over it), run out of the ROM, which matches
     * MAME's byte for byte. Luma is 0x3828's copy: main_data bytes 0..0x407F
     * to luma RAM 0x12800000.
     */
    colors: {
        i960: { run: [0x6830] },
        luma: { data: 0, bytes: 0x4080 },
        solid: true,
    },
    depth: { recede: 0, nearMin: 0.02, layers: true },
    /*
     * The materials go up with the TGP's function 6 as Sega Rally's do:
     * `mov 22, g1; lda 0x4140, g2; bal 0x40D8` (0x4280). The light is a
     * stand-in, Sega Rally's world light; the race's own was not read.
     */
    lighting: {
        light: [-0.707, -0.707, -0.707],
        materials: { source: 'maincpu', at: 0x4140, count: 22, stride: 8 },
    },
    /* The two courses (js/racers.js), the race's records 1 and 2. */
    stageTable: {
        racer: {
            kind: 'manxtt',
            records: 0x401e0,
            courses: [
                { record: 1, set: 2, name: 'Laxey Coast' },
                { record: 2, set: 0, name: 'T.T. Course' },
            ],
        },
        flat: true,
    },
    features: { stages: true, characters: false, motions: false, cells: false },
};

/*
 * INDY 500 (Revision A; MAME indy500to, the Twin, and indy500d, the Deluxe),
 * a Model 2B AM5 game. Nothing of Sega Rally's survives but the board: a
 * 20-byte model table in the data ROM, texture banks dealt by a rectangle
 * table, and colour tables the program builds per course. The Deluxe is the
 * Twin's data with its program moved about; the addresses it changes are
 * `program`'s.
 */
function indy500Build({ id, name, program, data, rects, lumaOver, top, colorRun, courses, materials }) {
    const prog = [program[1], program[3]];
    return {
        id, name,
        identify: prog,
        identifyCrc: [program[2], program[4]],
        regions: {
            maincpu: { size: 0x100000, parts: [program] },
            /* Two 8 MB pairs of banks, luma, the palette and the model table,
             * then a 1 MB pair seen through XTRA 0x6400000. */
            mainData: {
                size: 0x1100000,
                parts: [
                    [0x000000, 'mpr-18237.11', 0x37e4255a, 'mpr-18238.12', 0xbf837bac],
                    [0x800000, 'mpr-18239.9', 0x9a2db86e, 'mpr-18240.10', 0xab46a35f],
                    data,
                ],
            },
            polygons: {
                size: 0x1000000,
                parts: [
                    [0x000000, 'mpr-18233.17', 0x48a024d3, 'mpr-18234.21', 0x1178bfc8],
                    [0x800000, 'mpr-18235.18', 0xe7d70d59, 'mpr-18236.22', 0x6ca29e0e],
                ],
            },
            /* One 8 MB pair, repeated as the board's mirror has it. */
            textures: {
                size: 0x1000000,
                parts: [
                    [0x000000, 'mpr-18232.27', 0xf962347d, 'mpr-18231.25', 0x673d5338],
                    [0x800000, 'mpr-18232.27', 0xf962347d, 'mpr-18231.25', 0x673d5338],
                ],
            },
            copro: {
                size: 0x100000,
                optional: true,
                parts: [[0x000000, 'epr-18249.29', 0xa399f023, 'epr-18250.30', 0x7479ad52]],
            },
        },
        /*
         * 3571 entries of 20 bytes in the data ROM at 0xC00460: tpa, tha, oba,
         * a polygon count and an info pointer. Entry 0 is empty. An oba is a
         * word index with bit 23 set, which `subtract` takes off. The boot's
         * copy to RAM 0x200000 (0x3BC20) takes 0x200000 off a tpa or tha
         * with bit 22 set (`texBit22`): the course-0 models' pointers.
         */
        modelTable: { offset: 0xc00460, count: 3571, stride: 20, fields: { uv: 0, mat: 4, mesh: 8 }, texBit22: true },
        meshPtr: { subtract: 0x02000000, add: 0 },
        /* {count, colours} at data 0xC11B5C, 961 of them, to 0x1802000
         * (0x2F0D0), and 0x2DFB0's table of 19 laid down from entry 1023:
         * table 0x53C40C & 7 of the eight at 0x6CBF0, which is 0 in the
         * attract mode and the races MAME was run to. */
        paletteOffset: 0xc11b5e,
        paletteCount: 961,
        paletteTop: top,
        /*
         * A set is a course: the record at 0x6A5B0 + 24 * course names its two
         * banks at +0x10 and +0x14 (0x16F50), (4, 5) for course 0, (0, 1) for
         * 1 and (2, 3) for 2. The boot deals (0, 1) and the attract mode the
         * course it shows; 0x36B9C and 0x63D44 deal (6, 7), and 0x56320 the
         * colour table 3 that goes with it.
         */
        texture: {
            raw: { layout: 'indy500', rects, rectCount: 37, pairs: [[4, 5], [0, 1], [2, 3], [6, 7]] },
            sets: 4,
            residentSet: null,
            defaultSet: 0,
        },
        /*
         * colorxlat by the program's own 0x2DD80 (the base ramp) and 0x2DE70
         * (g0 = k, the rows of the table data[0xC3CE5C + 4k] points at), k the
         * course (0x16F78). Luma is 0x2E010's copy, data 0xC122E0..+0x4000,
         * and then 0x180 bytes over the start of it.
         */
        colors: {
            i960: { run: colorRun, sets: 4 },
            luma: { data: 0xc122e0, bytes: 0x4000, over: [lumaOver] },
            solid: true,
        },
        depth: { recede: 0, nearMin: 0.02, layers: true },
        /* Function 6, 31 pairs (Twin: 0x2D728 through 0x2E3D0). The light is
         * a stand-in, Sega Rally's. */
        lighting: {
            light: [-0.707, -0.707, -0.707],
            materials: { source: 'maincpu', at: materials, count: 31, stride: 8 },
        },
        /* The course records (js/racers.js); set k is course k. The attract's
         * course 0 race is under its "BAY SIDE STREET" leaderboard. */
        stageTable: {
            racer: {
                kind: 'indy500',
                records: courses,
                courses: ['Bayside Street', 'Indianapolis Motor Speedway', 'Highland Raceway']
                    .map((name, record) => ({ record, set: record, name })),
            },
            flat: true,
        },
        features: { stages: true, characters: false, motions: false, cells: false },
    };
}

const indy500 = indy500Build({
    id: 'indy500', name: 'INDY 500 Twin (Revision A)',
    program: [0x000000, 'epr-18254a.15', 0xad0f1fc5, 'epr-18255a.16', 0x784daab8],
    data: [0x1000000, 'epr-18389.7', 0xd22ea019, 'epr-18390.8', 0x38e796e5],
    rects: 0x6c860,
    lumaOver: { data: 0x10b0850, bytes: 0x180 },
    top: { at: 0x1048de0 },
    colorRun: [0x2dd80, [0x2de70, 'set']],
    courses: 0x6a5b0,
    materials: 0x2d590,
});
/* MAME calls its data pair epr-18245/18246; the dumps in the wild are named
 * epr-18345/18346. The CRCs find either. */
const indy500d = indy500Build({
    id: 'indy500d', name: 'INDY 500 Deluxe (Revision A)',
    program: [0x000000, 'epr-18251a.15', 0xfdabb40b, 'epr-18252a.16', 0x4935832a],
    data: [0x1000000, 'epr-18345.7', 0x854b1037, 'epr-18346.8', 0x1a68acdc],
    rects: 0xb1fd0,
    lumaOver: { source: 'maincpu', data: 0xa8d94, bytes: 0x180 },
    top: { source: 'maincpu', at: 0x1b3a4 },
    colorRun: [0x34230, [0x34320, 'set']],
    courses: 0xafe90,
    materials: 0x33a40,
});

/*
 * Sega Touring Car Championship (Revision A; MAME stcca), a Model 2C AM
 * Annex game. Sega Rally's board code under it: the model table in the program
 * ROM, Sega Rally's texture deal with a run-length source (js/texture.js
 * buildStccTexram), and colour tables the boot works out on the i960.
 */
const stcc = {
    id: 'stcc',
    name: 'Sega Touring Car Championship (Revision A)',
    identify: ['epr-19272a.15', 'epr-19273a.16'],
    identifyCrc: [0x20cedd05, 0x1b0ab4d6],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19272a.15', 0x20cedd05, 'epr-19273a.16', 0x1b0ab4d6]],
        },
        /* An 8 MB pair, then a 1 MB pair the board repeats to 0xFFFFFF; the
         * boot's patch list is read at 0xC4BCEC, so the repeat at 0xC00000 is
         * kept and the ones nothing reads are not. */
        mainData: {
            size: 0xd00000,
            parts: [
                [0x000000, 'mpr-19257.11', 0xac28ee24, 'mpr-19258.12', 0xf5ba7d78],
                [0x800000, 'epr-19270.9', 0x7bd1d04e, 'epr-19271.10', 0xd2d74f85],
                [0xc00000, 'epr-19270.9', 0x7bd1d04e, 'epr-19271.10', 0xd2d74f85],
            ],
        },
        /* An 8 MB pair and a 1 MB pair repeated through 0x800000..0xFFFFFF,
         * which the table's oba reaches all of. */
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19251.17', 0xe06ff7ba, 'mpr-19252.21', 0x68509993],
                [0x800000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0x900000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0xa00000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0xb00000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0xc00000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0xd00000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0xe00000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
                [0xf00000, 'epr-19266.18', 0x41464ee2, 'epr-19267.22', 0x780f994d],
            ],
        },
        /* A 4 MB pair at 0 and 0x400000, a 1 MB pair repeated from 0x800000. */
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19254.27', 0x1ec49c02, 'mpr-19253.25', 0x41ba79fb],
                [0x400000, 'mpr-19254.27', 0x1ec49c02, 'mpr-19253.25', 0x41ba79fb],
                [0x800000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0x900000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0xa00000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0xb00000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0xc00000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0xd00000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0xe00000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
                [0xf00000, 'epr-19269.28', 0x01881121, 'epr-19268.26', 0xbc4e081c],
            ],
        },
        copro: {
            size: 0x400000,
            optional: true,
            parts: [[0x000000, 'mpr-19255.29', 0xd78bf030, 'mpr-19256.30', 0xcb2b2d9e]],
        },
    },
    /*
     * 2811 entries of 16 bytes in the program ROM at 0x32490 (tpa, tha, oba
     * and a polygon count), read as `lda 0x32490[gN*16]` (0x6B80, 0xAE38,
     * 0xB1E8 and on) and `ld 0x3249C[gN*16]` for the count.
     */
    modelTable: { source: 'maincpu', offset: 0x32490, count: 2811, stride: 16 },
    meshPtr: { subtract: 0x02000000, add: 0 },
    /* {count, colours} at 0x65660, 495 of them, copied to the face palette
     * (0x1802000) by 0x1C8C0, which 0x696C0 runs from the frame's hook.
     * 0x1C950, 0x1C9F0 and 0x1CA90 copy it ANDed with 0x801F, 0x83E0 or
     * 0xFC00 for a moment of the attract mode. */
    paletteProgram: 0x65660,
    paletteOffset: null,
    /*
     * A set is the pair a course record names (0xBEB0 + 0x3F4 * k: records
     * 0, 1 and 4 share the first, 2 and 5 the second, 3 and 6 the third, 7
     * has its own), then the title's. All are dealt over the boot's
     * {0x400000, 0xC4BCEC}. Offsets in the data ROM.
     */
    texture: {
        raw: {
            layout: 'stcc',
            runTable: 0x6a300,
            boot: [0x400000, 0xc4bcec],
            sets: [[0x4771ec, 0xc4c34c], [0x4fe190, 0], [0x5e1814, 0], [0x6bb5d8, 0xc4df40], [0x708d08, 0]],
        },
        sets: 5,
        residentSet: null,
        defaultSet: 0,
    },
    /*
     * colorxlat by the boot's own routines (0x6A1F0): 0x6AC60 the gamma ramp
     * in every row, then 0x6AE50 the odd rows from the ramp keys at 0x32120
     * (0x1350). Luma is 0x730F0's, worked out, written to 0x11400000 a byte
     * every two (the 2B/2C map). Both match MAME's byte for byte.
     */
    colors: {
        i960: { run: [0x6ac60, [0x6ae50, 0x32120], 0x730f0], lumaRam: 0x11400000, lumaStep: 2 },
        solid: true,
    },
    depth: { recede: 0, nearMin: 0.02, layers: true },
    /* Function 6 from 0x736B0, 32 pairs (0x1BA4, 0x10FA4, 0x7C2B0, through
     * 0x73648). The light is a stand-in, Sega Rally's. */
    lighting: {
        light: [-0.707, -0.707, -0.707],
        materials: { source: 'maincpu', at: 0x736b0, count: 32, stride: 8 },
    },
    /*
     * The course records (js/racers.js), in the order of the course menu's
     * labels at 0x15B80 (0x15C10 points at them) and of the course table at
     * 0x57460, {record, ?, list} by choice: NOVICE, INTERMEDIATE, EXPERT,
     * the three again as SS (records 4 to 6, the same courses on copies of
     * their models) and OMAKE, the bonus course (record 7). Record 0 is
     * record 4 again. The attract runs records 1, 2, 3 in turn (0x202630).
     */
    stageTable: {
        racer: {
            kind: 'stcc',
            records: 0xbeb0,
            stride: 0x3f4,
            courses: [
                { record: 1, set: 0, name: 'Country Circuit (Novice)' },
                { record: 2, set: 1, name: 'Grunwald Circuit (Intermediate)' },
                { record: 3, set: 2, name: 'Brickwall Town (Expert)' },
                { record: 4, set: 0, name: 'Country Circuit (Novice SS)' },
                { record: 5, set: 1, name: 'Grunwald Circuit (Intermediate SS)' },
                { record: 6, set: 2, name: 'Brickwall Town (Expert SS)' },
                { record: 7, set: 3, name: 'Omake (the bonus course)' },
            ],
        },
        flat: true,
    },
    features: { stages: true, characters: false, motions: false, cells: false },
};

/* ---- Super GT 24h and Over Rev (Jaleco) ----------------------------------- */

/*
 * Jaleco's two racers share one framework (js/jaleco.js has the texture
 * loader both run): the model table is 16-byte entries in the data ROM,
 * texture word, material word, mesh pointer and polygon count, sent to the
 * geometry engine four words at a time (`st 0x101, 0x800010`, `ldq`, `stq` to
 * 0x804000); the face palette is {count, colours} in the program ROM, copied
 * to 0x1802000; and three boot routines, run here by js/i960.js as
 * js/colors.js does for Sega Rally, build colorxlat (a ramp worked out by
 * one, odd rows laid over it by the next) and copy luma RAM out of the
 * program ROM, a byte every halfword from 0x11400000.
 */
function jalecoBuild({ id, name, identify, regions, table, palette, texture, colors }) {
    return {
        id,
        name,
        identify,
        regions,
        modelTable: { offset: table[0], count: table[1], stride: 16 },
        meshPtr: { subtract: 0x02000010, add: 0x10 },
        paletteProgram: palette,
        paletteOffset: null,
        texture,
        colors: { i960: { lumaRam: 0x11400000, lumaStep: 2, run: colors }, solid: true },
        /* No stage, fighter or motion data is read yet. */
        features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
    };
}

/*
 * Super GT 24h (MAME's `sgt24h`, Model 2B CRX, 1996).
 *
 * The table: 2238 entries at data 0x80F480, up to 0x818060, where the list of
 * pointers into it starts; 0x72C30, 0x72C60 and 0x72C90 draw from it.
 *
 * Colours: 0x72000 copies the 0x1B7 colours at 0x72CF6 to the face palette.
 * The boot (0x5A120) then runs 0x5A920 (every row a ramp out of the byte
 * table at 0x5A900), 0x5AA10 (odd rows from the table at 0x67CA4) and 0x5AB10
 * (luma, the 0x8000 bytes at 0x687E5). A scene lays more rows over them
 * through the queue at 0x530370, drained by 0x3CAF0: a record is {rows,
 * destination list, variants, source}, and variant v's rows are 16 bytes
 * each, each byte four colorxlat entries. The title and the races queue data
 * 0x2BEB860 variant 128 (rows 1 and 3, 0x3DF30; its 640 variants are the
 * race's hours) and 0xCB2B0 variant 0 (rows 5, 7, 9, 11, 21, 23 and 29,
 * 0x3DF60), which run here after the boot's three. Colorxlat, luma and palette RAM match MAME's at the
 * title and in the attract race (frames 300 and 1800), no byte different.
 *
 * Textures: sheet 0 from data 0x0 and sheet 1 from data 0x100000 at boot
 * (0x5A13C); a course reloads sheet 1 from the program's table at 0xED8B0
 * (0x3F4C0: data 0x100000, 0x200000, 0x300000, 0x400000, then the four
 * again), and 0x77850 loads data 0x500000 (set 4). Set 0 is the boot's, the
 * one MAME's attract shows.
 */
const sgt24h = jalecoBuild({
    id: 'sgt24h',
    name: 'Super GT 24h',
    identify: ['epr-19155.15', 'epr-19156.16', 'mpr-19146.11', 'mpr-19150.17'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19155.15', 0x593952fd, 'epr-19156.16', 0xa91fc4ee]],
        },
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19146.11', 0xd66b5b0f, 'mpr-19147.12', 0xd5558f48],
                [0x800000, 'mpr-19148.9', 0xa14c86db, 'mpr-19149.10', 0x94ef5849],
            ],
        },
        polygons: {
            size: 0x800000,
            parts: [[0x000000, 'mpr-19150.17', 0xe0ad870e, 'mpr-19151.21', 0xe2a1b125]],
        },
        textures: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-19153.27', 0x136adfd0, 'mpr-19152.25', 0x363769a2]],
        },
    },
    table: [0x80f480, 2238],
    palette: 0x72cf4,
    texture: {
        raw: {
            layout: 'jaleco',
            sheet0: 0x02000000,
            sets: [0x02100000, 0x02200000, 0x02300000, 0x02400000, 0x02500000],
        },
        sets: 5,
        residentSet: null,
        defaultSet: 0,
    },
    colors: [0x5a920, 0x5aa10, 0x5ab10, [0x3caf0, 0x02beb860, 128], [0x3caf0, 0xcb2b0, 0]],
});

/*
 * Over Rev (MAME's `overrev`, Model 2C CRX, Revision A, 1997) and its Model
 * 2B build (`overrevb`, Revision B: its zip holds the program alone, and the
 * rest is read from overrev.zip beside it). One data ROM, so one table: 1893
 * entries at data 0x80CEC0, up to 0x814510.
 *
 * The two programs run the same boot at the same addresses (0x11F64 on):
 * 0x12760, 0x12850 and 0x12950 for colorxlat and luma (luma the 0x8000
 * bytes at 0x37F09), 0x12080 for the fill and 0x120F0 for sheet 0 (data 0x0),
 * then sheet 1 (0x122B0, data 0x100000). They differ in where the palette
 * table is: {count, colours} at 0x2A7A4 in the 2B build, 0x32A44 in the 2C,
 * 769 colours, copied by 0x177F0 (0x17800).
 *
 * A course loads sheet 1 from its record in the program's table at 0xCD8B0,
 * {texture source, ...} and the course's name, 0x1C bytes each: Tsukuba
 * (data 0x200000), Shibuya (0x400000), Touge (0x600000), Futou (0x500000),
 * Shibuya and Touge's other versions (0x300000, 0x700000). Set 0 is the
 * boot's data 0x100000, then the six in data order.
 *
 * Checked against MAME on both boards: colorxlat and luma at the title
 * (frame 400) no byte different. Colorxlat does not change in the attract
 * race; luma bands 129 to 196 do (0x13AC0 queues band copies at run time),
 * and these are the boot's.
 */
const OVERREV_DATA = {
    mainData: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-19996.11', 0x21928a00, 'mpr-19997.12', 0x2a169cab],
            [0x800000, 'mpr-19994.9', 0xe691fbd5, 'mpr-19995.10', 0x82a7828e],
        ],
    },
    polygons: {
        size: 0x400000,
        parts: [[0x000000, 'mpr-19998.17', 0x6a834574, 'mpr-19999.21', 0xff590a2d]],
    },
    textures: {
        size: 0x400000,
        parts: [[0x000000, 'mpr-20001.27', 0x6ca236aa, 'mpr-20000.25', 0x894d8ded]],
    },
};
const overRevTexture = (window) => ({
    raw: {
        layout: 'jaleco',
        sheet0: 0x02000000,
        sets: [0x02100000, 0x02200000, 0x02300000, 0x02400000, 0x02500000, 0x02600000, 0x02700000],
        fill: true,
        /* The 2C's texture RAM is two 2 MB shares with no mirror. */
        window,
    },
    sets: 7,
    residentSet: null,
    defaultSet: 0,
});
const overrev = jalecoBuild({
    id: 'overrev',
    name: 'Over Rev (Model 2C, Revision A)',
    identify: ['epr-20124a.15', 'epr-20125a.16', 'mpr-19996.11', 'mpr-19998.17'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-20124a.15', 0x74beb8d7, 'epr-20125a.16', 0xdef64456]],
        },
        ...OVERREV_DATA,
    },
    table: [0x80cec0, 1893],
    palette: 0x32a44,
    texture: overRevTexture(0x200000),
    colors: [0x12760, 0x12850, 0x12950],
});
/* Known by its program alone, so that overrev.zip missing is said as such. */
const overrevb = jalecoBuild({
    id: 'overrevb',
    name: 'Over Rev (Model 2B, Revision B)',
    identify: ['epr-19992b.15', 'epr-19993b.16'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19992b.15', 0x6d3e78d5, 'epr-19993b.16', 0x765dc9ce]],
        },
        ...OVERREV_DATA,
    },
    table: [0x80cec0, 1893],
    palette: 0x2a7a4,
    texture: overRevTexture(0x100000),
    colors: [0x12760, 0x12850, 0x12950],
});

/* ---- Dynamite Baseball 97 ------------------------------------------------- */

/*
 * Dynamite Baseball 97 (MAME's `dynabb97`, Sega, Model 2B CRX, Revision A,
 * 1997; the container's dynabb.zip carries it). The framework is the Jaleco
 * racers' again, a version on: the same 16-byte model table entries sent the
 * same way (the draw 0xA5280, `lda 0x2AFFD00[g0*16]`), 7890 of them at data
 * 0xAFFD00, and the same texture loader grown into a dispatcher that copies
 * packed rectangles (js/dynabb.js). The names are a table of its own:
 * {model, name pointer} pairs at data 0xB5C400 (7887 of them, to a pointer of
 * 0xFFFFFFFF), each name 32 bytes padded with spaces (read by 0xC2F40);
 * models 0 to 2 have none.
 *
 * A set is one of the three stadiums and one of the twelve teams, set
 * stadium * 12 + team, both sides of the field the team's: texture RAM, the
 * colorxlat rows and the face palette are each the stadium's and the two
 * sides' (js/dynabb.js runs the routines that load them). Set 12, stadium 1
 * and team 0, is the one MAME's attract opens on.
 */
const DYNABB_TEAMS = Array.from({ length: 12 }, (_, t) => [0x02000000 + t * 0xaaa00, 0x02055500 + t * 0xaaa00]);
const dynabb97 = {
    id: 'dynabb97',
    name: 'Dynamite Baseball 97 (Revision A)',
    identify: ['epr-19833a.15', 'epr-19834a.16', 'mpr-19841.11', 'mpr-19843.17'],
    regions: {
        maincpu: {
            size: 0x200000,
            parts: [
                [0x000000, 'epr-19833a.15', 0xd99ed1b2, 'epr-19834a.16', 0x24192bb1],
                [0x100000, 'epr-19831a.13', 0x0527ea40, 'epr-19832a.14', 0x2f380a40],
            ],
        },
        mainData: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19841.11', 0x989309af, 'mpr-19842.12', 0xeec54070],
                [0x0800000, 'mpr-19839.9', 0xd5a74cf4, 'mpr-19840.10', 0x45704e95],
                [0x1000000, 'mpr-19837.7', 0xc02187d9, 'mpr-19838.8', 0x546b61cd],
                [0x1800000, 'mpr-19835.5', 0xa3b0a37c, 'mpr-19836.6', 0xd70a32aa],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19843.17', 0x019bc583, 'mpr-19845.21', 0x2d23e73a],
                [0x800000, 'mpr-19844.18', 0x150198d6, 'mpr-19846.22', 0xfe53cd17],
            ],
        },
        textures: {
            size: 0x800000,
            parts: [[0x000000, 'mpr-19848.27', 0x4c0526b7, 'mpr-19847.25', 0xfe55edbd]],
        },
    },
    modelTable: { offset: 0xaffd00, count: 7890, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    modelNames: { pairs: 0xb5c400 },
    palette: { layout: 'dynabb' },
    paletteOffset: null,
    texture: {
        raw: {
            layout: 'dynabb',
            /* 0x809A0, layout 32 on sheet 0. */
            stadiums: [0x028fff00, 0x029aa900, 0x02a55300],
            /* 0x80920 (layout 48) and 0x80960 (layout 50), on sheet 1. */
            teams: DYNABB_TEAMS,
            /* The boot's other two: [source, sheet, layout]. */
            fixed: [[0x02855500, 0, 33], [0x02800000, 1, 49]],
        },
        sets: 36,
        residentSet: null,
        defaultSet: 12,
    },
    colors: { dynabb: true, solid: true },
    /* No stage, player or motion data is read yet. */
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Sega AM3's 1995 shooter on Model 2B CRX (MAME's `gunblade`). Its library
 * is Virtual-On's: no model table, the object triples sit in the program and
 * data ROMs, the luma is the same two ramps plus a block, and the boot draws
 * with `st 0x101, 0x800010` and the triple to 0x804000. Its texture banks are
 * raw rather than LZ and its colour tables key-framed, so js/texture.js and
 * js/colors.js each have a section for it.
 */
const gunblade = {
    id: 'gunblade',
    name: 'Gunblade NY (Revision A)',
    identify: ['epr-18988a.15', 'epr-18989a.16', 'mpr-18974.11', 'mpr-18980.17'],
    identifyCrc: [0xf63f1ad2, 0xc1c84d65],
    regions: {
        maincpu: { size: 0x100000, parts: [[0x000000, 'epr-18988a.15', 0xf63f1ad2, 'epr-18989a.16', 0xc1c84d65]] },
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-18974.11', 0xe29ecaff, 'mpr-18975.12', 0xd8187582],
                [0x800000, 'mpr-18976.9', 0xc95c15eb, 'mpr-18977.10', 0xdb8f5b6f],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-18980.17', 0x22345534, 'mpr-18981.21', 0x2544a33d],
                [0x800000, 'mpr-18982.18', 0xd0a92b2a, 'mpr-18983.22', 0x1b4af982],
            ],
        },
        textures: { size: 0x800000, parts: [[0x000000, 'mpr-18985.27', 0xad6166e3, 'mpr-18984.25', 0x756f6f37]] },
    },
    /*
     * Virtual-On's scan (js/romset.js scanModelTable), but the meshes lie end
     * to end in four runs, one from the start of each pair of polygon chips
     * (polygon words 0, 0x100000, 0x200000, 0x300000). 1528 of the 1529
     * objects the attract draws in its first 6000 frames are triples the scan
     * finds on a mesh start; the other is a bare mesh 0xA with no texture.
     */
    modelTable: {
        scan: {
            runs: [0, 0x100000, 0x200000, 0x300000],
            sources: [['maincpu', 0, 0x100000], ['mainData', 0, 0x1000000]],
        },
        count: 5452,
    },
    meshPtr: { subtract: 0x02000000, add: 0 },
    /*
     * {count, colours}: 962 colours at 0xC57CE, which 0x155D0 copies to the
     * face palette (0x1802000). Then 0x15C30 sets entries 18..53 by the
     * cabinet flags at 0x5039C0..0x5039CC, all 1 after the boot; those are
     * the `paletteFixes`. 0x159CC rewrites 8..28 every frame for the HUD.
     */
    paletteProgram: 0xc57cc,
    paletteOffset: null,
    paletteFixes: [
        [18, 0x83ff], [19, 0x83e0], [20, 0xfc00], [21, 0xfc1f], [22, 0xffe0], [23, 0x821f], [24, 0x801f],
        [25, 0xc210], [26, 0xa94a], [27, 0x9990], [28, 0x83ff], [29, 0x99da], [30, 0x8014], [31, 0xc084],
        [32, 0x8254], [34, 0x899f], [35, 0x834e], [37, 0x801f], [38, 0x83e0], [39, 0xfc00], [41, 0xd210],
        [42, 0xfe10], [43, 0xd292], [44, 0xc84e], [45, 0xbad4], [46, 0x8256], [48, 0xaa1e], [49, 0x8c63],
        [50, 0xa25f], [51, 0xa908], [52, 0x8256], [53, 0xaa5e],
    ],
    /*
     * js/texture.js's Gunblade section. A set is bank 0 then a scene's bank
     * (`sets`: [bank, colour table]); 8 is the title's, the one the game
     * opens on, 0 the attract's city and 6 the stage film.
     */
    texture: {
        raw: {
            layout: 'gunblade', groups: 0x5b040, bootSet: 8,
            sets: [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [8, 8]],
        },
        sets: 9,
        residentSet: null,
        defaultSet: 8,
    },
    /* Luma: two grey ramps of 128, then 0x2080 bytes from 0xF2200 at entry
     * 0x800 (0x6A388). Colorxlat: js/colors.js's Gunblade section. Both match
     * MAME's after the city, the stage film and the title. */
    colors: {
        luma: { source: 'maincpu', data: 0xf2200, bytes: 0x2080, at: 0x800, ramps: 2 },
        gunblade: { keys: 0xc75c0 },
        solid: true,
    },
    /* No stage or object record is read yet. */
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Psikyo's 1997 shooter: Zero Gunner on Model 2B CRX, the export build
 * (`zerogun`, MAME's parent) and the Japanese one (`zerogunj`), and the
 * export build on Model 2A (`zeroguna`). The clones' zips hold only their
 * programs (and the 2A board's own chips); the data, polygon and texture
 * chips are read from zerogun.zip beside them. It is Pilot Kids' engine a
 * year sooner: the same model table, the same texture loader and colour
 * scheme, so js/texture.js's Pilot Kids section reads it and js/colors.js has
 * a short section of its own. The three programs keep every table at the
 * same offset but the texture load list (`loads`).
 */
function zeroGunnerBuild({ id, name, program, extra = [], loads }) {
    return {
        id,
        name,
        identify: [program[1], program[3], ...extra],
        identifyCrc: [program[2], program[4]],
        regions: {
            maincpu: { size: 0x100000, parts: [program] },
            mainData: {
                size: 0x1000000,
                parts: [
                    [0x000000, 'mpr-20296.11', 0x072d8a5e, 'mpr-20297.12', 0xba6a825b],
                    [0x800000, 'mpr-20294.9', 0xa0bd1474, 'mpr-20295.10', 0xc548cced],
                ],
            },
            polygons: { size: 0x800000, parts: [[0x000000, 'mpr-20298.17', 0x8ab782fc, 'mpr-20299.21', 0x90e20cdb]] },
            textures: { size: 0x400000, parts: [[0x000000, 'mpr-20301.27', 0x52010fb2, 'mpr-20300.25', 0x6f042792]] },
        },
        /*
         * 7712 entries of 32 bytes in the data ROM at 0x7FF80, up to the
         * {4, -1, 0, 0} after them: texture word, material word, mesh pointer,
         * polygon count, two more texture words. The program's draws (0x4D3A0
         * to 0x4DB48 in `zerogun`) send words 0 to 3 of an entry after
         * `st 0x101, 0x800010`, as Pilot Kids' do.
         */
        modelTable: { offset: 0x7ff80, count: 7712, stride: 32 },
        meshPtr: { subtract: 0x02000000, add: 0 },
        /* {count, colours}: 615 colours at 0x87F6, which 0x4DFA8 copies to
         * the face palette. MAME's matches; entry 26 is animated later. */
        paletteProgram: 0x87f4,
        paletteOffset: null,
        /*
         * js/texture.js's Pilot Kids section. Load 0 is the common one, and a
         * scene puts in a load of kind 1 and one of kind 2 over it, by the
         * two numbers at +0x24 of its record (0x62F6C). The records are listed
         * at 0x6EE28 by stage. `sets` are the pairs they name: 0 is what
         * MAME's attract has in at frame 600, 1 at frame 1500, 2 a load on its
         * own; 3-7 are the first stage's five areas (the attract's frame
         * 3000 is set 3), 8-12 the second's and 13-17 the third's.
         */
        texture: {
            raw: {
                layout: 'pltkids', loads,
                sets: [[20, 21], [22, 23], [19], [8, 16], [3, 16], [10, 16], [4, 16], [1, 16],
                    [2, 17], [9, 17], [11, 17], [12, 17], [13, 17], [5, 18], [6, 18], [14, 18], [15, 18], [7, 18]],
            },
            sets: 18,
            residentSet: null,
            defaultSet: 0,
        },
        /* Luma: 0x48B60 copies the 0x600 bytes at 0x1A20 (0x48C10 can lay
         * another band over band 0; the attract's fade does). Colorxlat:
         * js/colors.js's Zero Gunner section, the same in every scene. */
        colors: {
            luma: { source: 'maincpu', data: 0x1a20, bytes: 0x600 },
            zerogun: { table: 0x1050, count: 0x1a10 },
            solid: true,
        },
        /* No stage, cell or motion data is read yet. */
        features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
    };
}

const zerogun = zeroGunnerBuild({
    id: 'zerogun', name: 'Zero Gunner (Export, Model 2B)',
    program: [0x000000, 'epr-20439.15', 0x10125381, 'epr-20440.16', 0xce872747],
    extra: ['mpr-20296.11', 'mpr-20298.17'],
    loads: 0x48080,
});
/* The clones are known by their programs alone, so that zerogun.zip missing
 * is said as such. */
const zerogunj = zeroGunnerBuild({
    id: 'zerogunj', name: 'Zero Gunner (Japan, Model 2B)',
    program: [0x000000, 'epr-20290.15', 0x9ce3ad21, 'epr-20291.16', 0x7267a03d],
    loads: 0x480d0,
});
const zeroguna = zeroGunnerBuild({
    id: 'zeroguna', name: 'Zero Gunner (Export, Model 2A)',
    program: [0x000000, 'epr-20437.12', 0xfad30cc0, 'epr-20438.13', 0xca364408],
    loads: 0x47fa0,
});

/*
 * Sega's 1995 flight shooter on Model 2A CRX. Its own engine, nothing shared
 * with the AM2 games beyond the board's draw: `st 0x101, 0x800010` and the
 * table entry's first three words to 0x804000. Its data ROM's last megabyte
 * (epr-18404/18405) is what the program reads through the XTRA_DATA mirror at
 * 0x6400000 for its colour, luma and palette tables. A stage is a 24-byte
 * record at 0xF6578 (the index in RAM at 0x5290C0; set up by 0xD1C90):
 * +0 texture bank, +4 colour row list, +8 palette table, +0xC row-21 list,
 * +0x10 a data pointer not yet read. The sets here are its twelve records
 * and the boot (12), which is what the title shows.
 */
const skytargt = {
    id: 'skytargt',
    name: 'Sky Target',
    identify: ['epr-18406.12', 'epr-18407.13', 'mpr-18415.10', 'mpr-18413.16'],
    identifyCrc: [0xfde9c00a, 0x35f8b529],
    regions: {
        maincpu: { size: 0x100000, parts: [[0x000000, 'epr-18406.12', 0xfde9c00a, 'epr-18407.13', 0x35f8b529]] },
        mainData: {
            size: 0x1100000,
            parts: [
                [0x0000000, 'mpr-18415.10', 0xd7a1bbd7, 'mpr-18416.11', 0xb77c9243],
                [0x0800000, 'mpr-18417.8', 0xa0d03f63, 'mpr-18418.9', 0xc7a6f97f],
                [0x1000000, 'epr-18404.6', 0xf1407ec4, 'epr-18405.7', 0x00b40f9e],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-18413.16', 0x1c4d416c, 'mpr-18409.20', 0x666037ef],
                [0x800000, 'mpr-18414.17', 0x858885ba, 'mpr-18410.21', 0xb821a695],
            ],
        },
        textures: { size: 0x800000, parts: [[0x000000, 'mpr-18412.25', 0x4db52f8b, 'mpr-18411.24', 0x9c2dc40c]] },
    },
    /*
     * 24204 entries of 16 bytes in the data ROM at 0xDE3D00: texture word,
     * material word, mesh pointer, polygon count. All 217 distinct objects
     * MAME's attract draws in its first 3000 frames are entries of it.
     */
    modelTable: { offset: 0xde3d00, count: 24204, stride: 16 },
    meshPtr: { subtract: 0x02000000, add: 0 },
    /* js/romset.js's `records` layout: {count, colours} at 0x640FB5C from
     * entry 0 (0x232D0), then the stage record's +8 table from entry 500
     * (0x39060). MAME's matches for every stage it showed. */
    palette: { layout: 'records', base: 0x640fb5c, records: 0xf6578, stride: 24, field: 8, first: 500, sets: 12 },
    /* js/texture.js's Sky Target section: the boot bank, then the record's. */
    texture: {
        raw: { layout: 'skytargt', bootBank: 0x2000000, records: 0xf6578, stride: 24, boot: 12 },
        sets: 13,
        residentSet: null,
        defaultSet: 0,
    },
    /* Luma: 0x376E0 copies 0x4000 bytes from 0x6400000; the texture copy's
     * spill then zeroes entries 0..7. Colorxlat: js/colors.js's section. */
    colors: {
        luma: { source: 'mainData', data: 0x1000000, bytes: 0x4000, spill: { data: 0x100000, entries: 8 } },
        skytargt: {
            records: 0xf6578, stride: 24, stages: 12, bootList: 0x6410580,
            gain: Math.fround(1.1), flat: [5, 8], fixed: 0x640f85c,
        },
        solid: true,
    },
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/* ---- Ski Super G ---------------------------------------------------------- */

/*
 * Sega's 1996 skiing game on Model 2C (MAME `skisuprg`). Its program is the
 * same generation as Sega Rally's: the model table is Rally's 16-byte one,
 * and the sheets are raw banks in the data ROM, uploaded as The House of the
 * Dead uploads them. js/skisuprg.js has the scenes, the sheets, the face
 * palette and colorxlat; README's Ski Super G section and TECHNICAL.md say
 * how each was found.
 */
const skisuprg = {
    id: 'skisuprg',
    name: 'Sega Ski Super G',
    identify: ['epr-19489.15', 'epr-19490.16', 'mpr-19494.11'],
    regions: {
        maincpu: {
            size: 0x200000,
            parts: [
                [0x000000, 'epr-19489.15', 0x1df948a7, 'epr-19490.16', 0xe6fc24d3],
                [0x100000, 'epr-19551.13', 0x3ee8f0d5, 'epr-19552.14', 0xbaa2e49a],
            ],
        },
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19494.11', 0xf19cdb5c, 'mpr-19495.12', 0xd42e5ef2],
                [0x800000, 'mpr-19492.9', 0x4805318f, 'mpr-19493.10', 0x39daa909],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19496.17', 0x0e9aef4e, 'mpr-19497.21', 0x5397efe9],
                [0x800000, 'mpr-19498.18', 0x32e5ae60, 'mpr-19499.22', 0x2b9f5b48],
            ],
        },
        textures: {
            size: 0x800000,
            parts: [[0x000000, 'mpr-19501.27', 0x66d7b02e, 'mpr-19500.25', 0x905f5798]],
        },
    },
    /*
     * 5519 entries of 16 bytes in the program ROM at 0x195900: tpa, tha,
     * 0x800000 | polygon word, polygon count, as Sega Rally's. The draws
     * (0x47900 and 29 more sites) set function 0x101 at 0x800010 and send an
     * entry whole, `lda 0x195900[g0*16]`, `ldq` and `stq` to 0x804000. The
     * table ends at 0x1AB1F0, where 0xFFFFFFFF fill starts. Program 0x180000 has an older copy, the same for its first 4871
     * entries, and data 0xE45460 another; no code reads either.
     */
    modelTable: { offset: 0x195900, count: 5519, stride: 16, source: 'maincpu' },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* The face palette by scene (skisuprgPalette): the boot's block at
     * 0x47DA8 from 0, the scene's from 500. */
    palette: { layout: 'skisuprg', base: 0x47da8, first: 500 },
    paletteOffset: null,
    /*
     * A set is a scene (skisuprgScenes): the menus' two, the attract's
     * in-between screens (0x43454's bank 0x2400000, the default), then the
     * four courses' records.
     */
    skisuprg: {
        bootBank: 0x02000000,
        scenes: [
            { name: 'menus', bank: 0x02300000, palette: 0x48108, colors: 0x9ee60 },
            { name: 'menus, second colours', bank: 0x02300000, palette: 0x48108, colors: 0x9ef20 },
            { name: 'attract', bank: 0x02400000, palette: 0x47eea, colors: 0x9ede0 },
        ],
        courses: { at: 0xa4700, stride: 40, count: 4 },
    },
    texture: {
        raw: { layout: 'skisuprg' },
        sets: 7,
        residentSet: null,
        defaultSet: 2,
    },
    /* Luma: 0x44580 copies the 0x7F80 bytes at 0x3970, one a halfword.
     * Colorxlat: the ramps (0x43DF0) and the scene's table (0x44260), run. */
    colors: {
        luma: { source: 'maincpu', data: 0x3970, bytes: 0x7f80 },
        skisuprg: { ramps: 0x43df0, table: 0x44260 },
        solid: true,
    },
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Sega's 1996 jet-ski game on Model 2C (MAME `waverunr`, Revision A). The
 * program is Ski Super G's generation and Sega Water Ski's, which runs the
 * same code; js/waverunr.js has the scenes, the sheets, the face palette and
 * colorxlat for both. README's Wave Runner section and TECHNICAL.md say how
 * each was found.
 */
const waverunr = {
    id: 'waverunr',
    name: 'Wave Runner',
    identify: ['epr-19282a.15', 'epr-19283a.16', 'mpr-19291.11'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19282a.15', 0x5df58604, 'epr-19283a.16', 0xbca188e1]],
        },
        mainData: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19291.11', 0x54431d67, 'mpr-19292.12', 0x9152d979],
                [0x0800000, 'mpr-19293.9', 0xb168bea9, 'mpr-19294.10', 0xc731e659],
                ...Array.from({ length: 16 }, (_, i) =>
                    [0x1000000 + i * 0x100000, 'epr-19278.7', 0x29ed421d, 'epr-19279.8', 0x6ae9f899]),
            ],
        },
        polygons: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19287.17', 0x203b9e45, 'mpr-19288.21', 0x4a488e4d],
                [0x0800000, 'mpr-19289.18', 0x35361cb3, 'mpr-19290.22', 0x67300826],
                ...Array.from({ length: 15 }, (_, i) =>
                    [0x1000000 + i * 0x100000, 'epr-19304.19', 0x1a7d9521, 'epr-19305.23', 0x00412412]),
            ],
        },
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19286.27', 0x3ccc33cb, 'mpr-19285.25', 0xa070fbd0],
                ...Array.from({ length: 8 }, (_, i) =>
                    [0x800000 + i * 0x100000, 'epr-19303.28', 0xfcffc8a0, 'epr-19302.26', 0xbd00933a]),
            ],
        },
    },
    /*
     * 3457 entries of 16 bytes in the program ROM at 0x6A7C0: tpa, tha,
     * 0x800000 | polygon word, polygon count, as Ski Super G's. The draws (53
     * sites) send an entry whole, `lda 0x6a7c0[gX*16]`, `ldq` and `stq` to
     * 0x804000 after `st 0x101, 0x800010`.
     */
    modelTable: { offset: 0x6a7c0, count: 3457, stride: 16, source: 'maincpu' },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    palette: { layout: 'waverunr' },
    paletteOffset: null,
    /* A set is a scene (waverunrScenes): the four courses by their tables,
     * then the two scenes that name theirs in the code. */
    waverunr: {
        bootBank: 0x02000000,
        fill: 0xbbbb,
        ramps: 0x34ec0,
        palette: { top: 0x10080, blocks: [[0x2858b60, 0], [0x84350, 300]], first: 500 },
        courses: {
            count: 4, palettes: 0x973e0, banks: 0x973f0,
            colorTable: 0x35040, colorIndex: [0, 1, 2, 3], patches: 0x2848b60,
        },
        scenes: [
            { name: 'scene 0x4AF60', bank: 0x02200000, palette: 0x2858fda, colors: 0xa2bd7 },
            { name: 'scene 0x2CBE0', bank: 0x02500000, palette: 0x2859556, colors: 0xa2bd7 },
        ],
        /* The Stages tab (readWaverunrStages): the grids by course, the two
         * object lists 0xBF7B0 hands each course, the backdrop maker, the
         * task makers and the culled draw (in the copy of 0xB0000 the boot
         * puts at 0x200000), the course in work RAM, the sea. */
        stages: {
            count: 4, grids: 0x285e110, course: 0x511f60, backdrop: 0x60f0,
            objects: [[0xaad0, 0xab40], [0xabb0, 0xac40], [0xaca0, 0xace0], [0xadb0, 0xadd0]],
            code: { ram: 0x200000, rom: 0xb0000, size: 0x20000 },
            makers: [0x20f230, 0x20f350], draw: 0x210200, sea: 1907, seaSize: 700,
        },
    },
    texture: { raw: { layout: 'waverunr' }, sets: 6, residentSet: null, defaultSet: 0 },
    colors: {
        /* 0x35220: luma RAM cleared, then 0x4000 bytes of the data ROM at
         * 0x85C408 to the entries from 0x3200. */
        luma: { data: 0x85c408, bytes: 0x4000, at: 0x3200 },
        waverunr: true,
        solid: true,
    },
    /* The courses, from their grids and object lists (readWaverunrStages in
     * js/waverunr.js). */
    stageTable: { waverunr: true, flat: true },
    features: { stages: true, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Sega Water Ski (MAME `segawski`, Revision A), Model 2C, 1997: Wave Runner's
 * program carried on, its routines about 0x1A960 further in and its tables
 * in the data ROM, read through the XTRA window at 0x6000000. js/waverunr.js
 * serves both.
 */
const segawski = {
    id: 'segawski',
    name: 'Sega Water Ski',
    identify: ['epr-19963a.15', 'epr-19964a.16', 'mpr-19980.11'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19963a.15', 0x89c9cb0d, 'epr-19964a.16', 0xc382cefe]],
        },
        mainData: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19980.11', 0x709804f2, 'mpr-19981.12', 0xa1e8ec09],
                [0x0800000, 'mpr-19982.9', 0x41c398bb, 'mpr-19983.10', 0xe210dea2],
                [0x1000000, 'mpr-19984.7', 0x14b967d1, 'mpr-19985.8', 0x57827677],
                ...Array.from({ length: 8 }, (_, i) =>
                    [0x1800000 + i * 0x100000, 'epr-19961.5', 0xcc34ecaf, 'epr-19962.6', 0xe8a30e5e]),
            ],
        },
        polygons: {
            size: 0x2000000,
            parts: [
                [0x0000000, 'mpr-19972.17', 0x493c0f8f, 'mpr-19973.21', 0x01b6f8e1],
                [0x0800000, 'mpr-19974.18', 0x2bd947d3, 'mpr-19975.22', 0x07e6b699],
                [0x1000000, 'mpr-19976.19', 0xf9496566, 'mpr-19977.23', 0xb3dbf54b],
                [0x1800000, 'mpr-19978.20', 0xc80f4ed7, 'mpr-19979.24', 0x1c0db4d2],
            ],
        },
        textures: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19969.27', 0xc0c33d39, 'mpr-19968.25', 0xb8d2f04f],
                [0x800000, 'mpr-19971.28', 0xc8708096, 'mpr-19970.26', 0xc59d8d36],
            ],
        },
    },
    /*
     * 13331 entries of 16 bytes in the data ROM at 0x1291D60, Wave Runner's
     * layout; the draws name it through the XTRA window, `lda 0x6291d60`.
     */
    modelTable: { offset: 0x1291d60, count: 13331, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    palette: { layout: 'waverunr' },
    paletteOffset: null,
    /* A set is a course (0x909B0, 0x90A00, 0x909F0 by work RAM 0x56E094):
     * palette 0x90970, bank 0x90990, colour table 0x4F990. The tables run to
     * seven, but only the first four differ; the boot and 0x7B690 use the
     * first's and the fourth's. */
    waverunr: {
        bootBank: 0x02000000,
        fill: 0xbbbb,
        ramps: 0x4f810,
        /* 0x90A90 takes three rows of a course's colour table from here, by
         * work RAM 0x56E090 (a player choice? 0 in the attract). */
        rowSwap: { table: 0xa1ed0, select: 0 },
        palette: { blocks: [[0x62c5e94, 0]], first: 500 },
        courses: {
            count: 4, palettes: 0x90970, banks: 0x90990,
            colorTable: 0x4f990, colorIndex: [0, 1, 2, 3], patches: 0x622c390,
        },
        /* The Stages tab (readWaverunrStages): the near grids by course
         * (0x9BA10 hands 0x56580 these and a far copy, 0x62E8B90, that drops
         * some cells), the race's object lists from 0xBB0, the task maker and
         * the culled draw, the course in work RAM, the sea (0x2D5A0). No
         * code copy and no backdrop maker. */
        stages: {
            count: 4, grids: 0x62e8b70, course: 0x56e094, backdrop: 0,
            objects: [[0xb320, 0xb910], [0xba80, 0xc130], [0xc150, 0xc970], [0xcca0, 0xccc0]],
            code: null, makers: [0x91fb0], draw: 0x18f0, sea: 358, seaSize: 1360,
        },
    },
    texture: { raw: { layout: 'waverunr' }, sets: 4, residentSet: null, defaultSet: 0 },
    colors: {
        /* 0x4FB80: luma RAM cleared, then 0x4000 bytes of the data ROM at
         * 0x12C984C (`lda 0x62c984c`) to the entries from 0x3200. */
        luma: { data: 0x12c984c, bytes: 0x4000, at: 0x3200 },
        waverunr: true,
        solid: true,
    },
    /* The courses, read as Wave Runner's (js/waverunr.js). */
    stageTable: { waverunr: true, flat: true },
    features: { stages: true, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Top Skater (MAME `topskatr`, Revision A, Export), Model 2C, 1997. Its own
 * engine, not Wave Runner's: js/topskatr.js. See README and TECHNICAL.md.
 */
const topskatr = {
    id: 'topskatr',
    name: 'Top Skater',
    identify: ['epr-19755a.15', 'epr-19756a.16', 'mpr-19735.11'],
    regions: {
        maincpu: {
            size: 0x100000,
            parts: [[0x000000, 'epr-19755a.15', 0xb80633b9, 'epr-19756a.16', 0x472046a2]],
        },
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-19735.11', 0x8e509266, 'mpr-19736.12', 0x094e0a0d],
                [0x800000, 'mpr-19737.9', 0x281a7dde, 'mpr-19738.10', 0xf688327e],
            ],
        },
        polygons: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-19741.17', 0x111a6e29, 'mpr-19742.21', 0x28510aff]],
        },
        textures: {
            size: 0x800000,
            parts: [[0x000000, 'mpr-19740.27', 0xb20f508b, 'mpr-19739.25', 0x8120cfd8]],
        },
    },
    /*
     * 1901 entries of 16 bytes in the program ROM at 0x8F390: tpa, tha,
     * 0x800000 | polygon word, polygon count, Wave Runner's layout. The
     * draws name parts of it (`lda 0x90c70[g7*16]` at 0x1A564, 0x90CD0 at
     * 0x30F14, 0x932E0 and 0x945F0 at 0x1628/0x3A044), and a course record
     * (0x2A66C + 36 * n, +0x14) names its own run of it (0x94600, 0x932F0,
     * 0x96A50).
     */
    modelTable: { offset: 0x8f390, count: 1901, stride: 16, source: 'maincpu', packed: true },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: null,
    /* A set is a scene: its bank on sheet 1 and its colour key points
     * (js/topskatr.js). Set 1 is the attract's. */
    topskatr: {
        banks: 0x02000000,
        bootBank: 0,
        sets: [{ bank: 1, colors: 0 }, { bank: 2, colors: 1 }],
        ramps: [[0x20da0, []], [0x213d0, [7, 0xffffffff]]],
        scene: 0x9c1b0,
        copy: 0x9d3b0,
    },
    /* {count, colours} at 0x98D5C onto the face palette from entry 0 (0x20AD0). */
    paletteProgram: 0x98d5c,
    texture: { raw: { layout: 'topskatr' }, sets: 2, residentSet: null, defaultSet: 1 },
    colors: {
        /* The boot's 0x47F30: two bands of (k + 1) >> 1, then 0x2080 bytes
         * of the program ROM at 0xB7D84 from entry 0x800 (0x11401000). */
        luma: { source: 'maincpu', ramps: 2, data: 0xb7d84, bytes: 0x2080, at: 0x800 },
        topskatr: true,
        solid: true,
    },
    /* The courses (js/topskatr.js, readTopskatrStages): the records at
     * 0x2A660 + 36 * n, the object lists at 0x198D0 + 12 * n, and the two sky
     * domes 0x3A044 picks between. */
    stageTable: { topskatr: { records: 0x2a660, count: 3, objects: 0x198d0, skies: [0x945f0, 0x932e0] } },
    features: { stages: true, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Behind Enemy Lines (MAME `bel`), Model 2C, Sega / EPL Productions, 1997.
 * Its own engine: js/bel.js. See README and TECHNICAL.md.
 */
const bel = {
    id: 'bel',
    name: 'Behind Enemy Lines',
    identify: ['epr-20225.15', 'epr-20226.16', 'mpr-20233.11'],
    regions: {
        maincpu: {
            size: 0x80000,
            parts: [
                [0x000000, 'epr-20225.15', 0x4abc6b59, 'epr-20226.16', 0x43e05b3a],
                [0x040000, 'epr-20223.13', 0x61b1be98, 'epr-20224.14', 0xeb2d7dbf],
            ],
        },
        mainData: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-20233.11', 0x3e079a3b, 'mpr-20234.12', 0x58bde826],
                [0x400000, 'mpr-20231.9', 0xb3393e93, 'mpr-20232.10', 0xda4a2e11],
                [0x800000, 'mpr-20229.7', 0xcdec7bf4, 'mpr-20230.8', 0xa166fa87],
                [0xc00000, 'mpr-20227.5', 0x1277686e, 'mpr-20228.6', 0x49cb5568],
            ],
        },
        polygons: {
            size: 0x1000000,
            parts: [
                [0x000000, 'mpr-20244.17', 0x9d2a8660, 'mpr-20240.21', 0x51615908],
                [0x400000, 'mpr-20243.18', 0x48671f7c, 'mpr-20239.22', 0x6cd8d8a5],
                [0x800000, 'mpr-20242.19', 0xe7f86ac7, 'mpr-20238.23', 0x0a480c7c],
                [0xc00000, 'mpr-20241.20', 0x51974b98, 'mpr-20237.24', 0x89b5d8b6],
            ],
        },
        textures: {
            size: 0xc00000,
            parts: [
                [0x000000, 'mpr-20247.27', 0x00b0417d, 'mpr-20245.25', 0x36490a08],
                [0x800000, 'mpr-20248.28', 0x0ace6bef, 'mpr-20246.26', 0x250d6ca1],
            ],
        },
    },
    /*
     * The data ROM's table at 0x8B7C78, 20 bytes a record: {object, tpa, tha,
     * count, 0x28Cxxxx}. The game sends the first three to the geometry
     * engine as they stand (0x120A4..0x120B0, with the count + 1). The object
     * directory at 0x973748 (js/bel.js) points at it, 0x28B7C78 its first.
     * After 3183 records the table goes on with 2D pieces in polygon RAM.
     */
    modelTable: { offset: 0x8b7c78, count: 3183, stride: 20, fields: { mesh: 0, uv: 4, mat: 8 } },
    meshPtr: { subtract: 0x02000000, add: 0 },
    modelNames: { directory: true },
    /* 0x71D60 copies the 906 colours at data 0x8CDB78 (to 0x8CE28C) from entry 0. */
    paletteOffset: 0x8cdb78,
    paletteCount: 906,
    /* Sheet banks by scene (js/bel.js): 3 scenes of 3 sheet-0 entries. */
    bel: {
        sheet0: 0x020647a0,
        sheet1: 0x02064780,
        scenes: 3,
        entries: 3,
        twoScene: 2,
        objects: { at: 0x973748, count: 538 },
    },
    texture: { raw: { layout: 'bel' }, sets: 9, residentSet: null, defaultSet: 6 },
    colors: {
        luma: { bel: true, band: 0x64320, first: 0x64420, firstBands: 3 },
        bel: { ramps: 0x62a70, table: 0x62dd0, scene: 2 },
        solid: true,
    },
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/*
 * Desert Tank (MAME's `desert`), Sega and Martin Marietta's 1994 tank game on
 * the original Model 2. MAME calls it not working, but it boots and runs its
 * attract mode, the textures and colours in. The program is built on
 * Daytona USA's library: the same texture upload, luma copy and colour ramp,
 * at other addresses.
 */
const desert = {
    id: 'desert',
    name: 'Desert Tank',
    identify: ['epr-16976.12', 'epr-16977.13', 'mpr-16968.16'],
    regions: {
        maincpu: {
            size: 0x80000,
            parts: [
                [0x00000, 'epr-16976.12', 0xd036dff0, 'epr-16977.13', 0xe91194bd],
                [0x40000, 'epr-16970.14', 0x4ea12d1f, 'epr-16971.15', 0xd630b220],
            ],
        },
        /* MAME's region is 32MB; the chips end at 9MB. */
        mainData: {
            size: 0x900000,
            parts: [
                [0x000000, 'mpr-16974.10', 0x2ab491c5, 'mpr-16975.11', 0xe24fe7d3],
                [0x400000, 'mpr-16972.8', 0x23e53748, 'mpr-16973.9', 0x77d6f509],
                [0x800000, 'epr-16978.6', 0x38b3e574, 'epr-16979.7', 0xc314eb8b],
            ],
        },
        /* MAME's names; dumps label 16964 and 16965 with each other's
         * socket (.21 and .20), so the CRCs find them. */
        polygons: {
            size: 0x800000,
            parts: [
                [0x000000, 'mpr-16968.16', 0x4a16f465, 'mpr-16964.20', 0xd4a769b6],
                [0x400000, 'mpr-16969.17', 0x887380ac, 'mpr-16965.21', 0x9ba7645f],
            ],
        },
        textures: {
            size: 0x400000,
            parts: [[0x000000, 'mpr-16967.25', 0xb8b84c9d, 'mpr-16966.24', 0x7484efe9]],
        },
    },
    /*
     * Daytona's records: oba, tpa, tha, polygon count and the zero that ends
     * the one-entry list. 2092 of them at data 0x88357C, up to the palette;
     * the program names records by address (`lda 0x2883914` at 0x136E8,
     * 0x2883BE4 at 0x1DAA8), every one on a 20-byte step from there.
     */
    modelTable: { offset: 0x88357c, count: 2092, stride: 20, fields: { mesh: 0, uv: 4, mat: 8 } },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    /* 0x375C0 copies data 0x288D8EC..0x288DEB2, 739 colours, to the face
     * palette at 0x1802000. */
    paletteOffset: 0x88d8ec,
    paletteCount: 739,
    /*
     * Daytona's upload, instruction for instruction (0x1544, its run table
     * 0x1650): the boot (0x152C) puts bank 0x2400000 on sheet 1, and a
     * mission's set-up (0x1510, called at 0x6A4C, 0x8108, 0x8260 and 0x2FEB0)
     * the bank `ld 0x1678[n*4]` on sheet 0, n the byte at 0x52106F. The
     * table is 0x2500000, 0x2600000, 0x2700000 and 0x2500000 again, so three
     * sets. The attract runs with n = 1.
     */
    texture: {
        raw: { layout: 'daytona', bankTable: 0x1678, bootBank: 0x2400000 },
        sets: 3,
        residentSet: null,
        defaultSet: 1,
    },
    /*
     * Luma: 0x14D0 copies `ld 0x3A44` bands of 128 bytes from 0x3A48 in the
     * program ROM. Colorxlat: 0x37150 works the 32 rows out of fixed numbers,
     * Daytona's ramp with the 1993 upright's constants (step 9, bias
     * 0xE8 << 5, flat 0xE8), but a value of exactly 0x100 is kept
     * (`cmpible`), where Daytona's routine as ported here cuts it to 0xFFFF.
     * No cabinet setting reaches it.
     */
    colors: {
        luma: { source: 'maincpu', count: 0x3a44, data: 0x3a48 },
        ramp: { step: 9, span: 0x240, bias: 0x1d00, flat: 0xe8, top: 0x100 },
        solid: true,
    },
    /* No mission, tank or motion data is read yet. */
    features: { stages: false, characters: false, motions: false, bodies: false, cells: false },
};

/* Revision C first: a merged set is MAME's parent with its clones beside it,
 * and the parent is the one it is named for. Then the build with the most to
 * show, and the 2A builds, which have no fighters yet. The INDY 500 Deluxe
 * goes ahead of the Twin, since its zip opens with the Twin's beside it. */
export const GAMES = [sfight, schamp, fvipers, hotdp, hotdo, hotd,
    daytona, daytona93, daytonase, daytonas, daytonat, daytonata, daytonam, daytonagtx, vcop, vcop2, vstrikero, vstriker, vf2,
    doa, doab, doaa, doaab, doaae, vonj, vonu, srallyc,
    dynamcop, dyndeka2, dynamcopb, dyndeka2b, dynamcopc, airwlkrs, powsled, lastbrnx, lastbrnxu, lastbrnxj,
    pltkids, pltkidsa, motoraid, manxtt, indy500d, indy500, stcc, sgt24h, overrev, overrevb, dynabb97,
    gunblade, zerogun, zerogunj, zeroguna, skytargt,
    skisuprg, waverunr, segawski, topskatr, bel, desert];

/*
 * Sets the viewer recognises but cannot open yet (Pinboard #660, parity with
 * m2-hle2): the chips in the same `regions` shape as a game's and with MAME's
 * names, CRCs and offsets, and `lacks` saying what is missing, so a drop of
 * the set is named and told so rather than called unrecognised. A prepared
 * profile becomes a game by finding what `lacks` lists and moving it into
 * GAMES. Sega Rally Championship was the first, and moved (Pinboard #1286);
 * the list is empty until the next.
 *
 * m2-hle2 keeps the same list the other way round: a set this viewer opens and
 * the emulator cannot run yet is a prepared profile there, taking its model
 * table from this file. Since m2-hle2's #1034 and #1035 (The House of the Dead
 * and Daytona USA run) that is Virtua Cop alone.
 */
export const PREPARED = [];

/** The prepared profile these member names are, or null. */
export function detectPrepared(names, byCrc = null) {
    const have = names instanceof Set ? names : new Set(names);
    return PREPARED.find((g) => g.identify.every((m, i) => have.has(m)
        || (g.identifyCrc && byCrc?.has(g.identifyCrc[i])))) ?? null;
}

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
 * @param {Map<number, string>} [byCrc]  a member's name by its checksum, for
 *   a profile whose `identifyCrc` lets a chip go by another label
 * @returns {object[]} the profiles, the top-level one first
 */
export function detectGames(names, nested = null, byCrc = null) {
    const have = names instanceof Set ? names : new Set(names);
    /* The labels a profile is known by, as these zips spell them; null where
     * one is missing. */
    const labels = (g) => g.identify.map((m, i) => (have.has(m)
        ? m
        : (g.identifyCrc && byCrc?.get(g.identifyCrc[i])) ?? null));
    const all = GAMES.filter((g) => labels(g).every((m) => m !== null));
    const top = all.filter((g) => labels(g).every((m) => !nested?.has(m)));
    return [...top, ...all.filter((g) => !top.includes(g))];
}
