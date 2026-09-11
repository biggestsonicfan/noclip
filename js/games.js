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
    modelTable: { offset: 0x000e0004, count: 5103, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: 0x00100000,
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
    modelTable: { offset: 0x000e0004, count: 5413, stride: 16 },
    meshPtr: { subtract: 0x02000010, add: 0x10 },
    paletteOffset: 0x00100000,
    /* Nothing but the model explorer yet: the stage, rig and motion tables are
     * this game's own and have not been located. */
    features: { stages: false, characters: false, motions: false },
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
