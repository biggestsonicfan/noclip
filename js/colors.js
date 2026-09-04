/*
 * colors.js — build the two colour lookup tables the fill path needs, the way
 * the game builds them.
 *
 * A Model 2 texel is 4 bits. It is not a colour and it is not a brightness: it
 * indexes a 128-entry band of luma RAM chosen by the face's `lumabase`, and
 * that value — scaled by the face's lighting term — indexes colorxlat against
 * the face's 5-bit palette colour. Both tables live in RAM, and the game fills
 * them on every scene change, which is why so much of South Island reads as
 * flat grey without them: the palette entry for the sea, the palm fronds, the
 * waterfall and the ring floor really is grey, and their actual colours only
 * exist in the top sixteen rows of colorxlat.
 *
 * Ported from the Sonic The Fighters decompilation (stfdecomp, rom_code1.s):
 *
 *   chg_pol_color_req       0x31BC   base ramp, luma 1..47, into a RAM staging
 *   chg_pol_color_send      0x3460   ... and out to colorxlat rows 0..27
 *   chg_scr_color_req       0x31BC   the flat band, luma 64..127, all 32 rows
 *   send_tex_col_stage      0x0800   the stage's own 16 colours, luma 48..63
 *   send_tex_col_loop       0x0868   ... through the intensity curve
 *   color_intensity         0x0758   ARRAY_NUM_RED/GREEN/BLUE
 *   essential_color_handling 0x11DD4 luma RAM, straight out of main_data
 *
 * The staging buffer at 0x546008 and the frame-by-frame handshake that dribbles
 * it into colorxlat 27 rows at a time are resumption bookkeeping — they do not
 * change the bytes produced — so the two halves are fused here.
 *
 * Verified byte-for-byte against a MAME capture of the real board: see
 * tools/test-colors.mjs.
 */

/* Sizes as the hardware presents them, so a build and a capture are
 * interchangeable. colorxlat (0x01810000) is three 0x4000-byte channels of
 * 16-bit entries, 32 palette rows of 256 luma slots each. Luma RAM
 * (0x11400000) is byte-wide but sits in the low half of each 16-bit unit, so a
 * dump of it has the bytes on even addresses — MAME's lumaram[i] is the byte at
 * 2i, and both this build and atlas.js index it that way. */
export const CXLAT_BYTES = 0xc000;
export const LUMA_BYTES = 0x20000;
/* One band per lumabase: 128 entries, and a face's lumabase is band * 128. */
export const LUMA_BAND = 128;
/* Where a row stops being a brightness ramp and becomes the scene's palette. */
export const PALETTE_LUMA0 = 48;
const CXLAT_CHANNEL = 0x4000;
const CXLAT_ROW = 0x200;                /* bytes per palette row: 256 entries */

/* main_data addresses, as the i960 sees them. */
const MAIN_DATA_BASE = 0x02000000;
/* essential_color_handling reads a block count and then that many 128-byte
 * luma bands, one per lumabase. */
const LUMA_COUNT = 0x020d0008;
const LUMA_DATA = 0x020d000c;
/* The pointer block at 0x02101000 holds the source of every colour upload the
 * game makes. send_tex_col_stage takes 0x02101010; the other three are below. */
const STAGE_COLOR_PTR = 0x02101010;

/* The stage block: 13 palette rows of sixteen colours, three 16-bit channels
 * each, and one block per texture set. */
const STAGE_ROW0 = 14;
/* The block is 0x540 and a group 0x60, so it holds fourteen of them — rows 14
 * through 27. Reading thirteen left row 27's sixteen colours unwritten, and a
 * face that lands there read zero and came out black: the two planters at the
 * Flying Carpet's oasis, among others. Each group matches exactly one board row
 * in a captured table, which is how the count was settled. */
const STAGE_ROWS = 14;
const STAGE_LUMA0 = PALETTE_LUMA0;      /* +0x60 bytes into the row */
const STAGE_COLORS = 16;
const STAGE_BLOCK = 0x540;
const STAGE_GROUP = 0x60;

/*
 * The three uploads besides the stage's, which all end in the same loop.
 *
 * `send_tex_col_stage` is one of four callers of `send_tex_col_loop` (0x858,
 * and 0x84c for the stage's own wider block): each walks a table of sixteen
 * colours per row, three 16-bit channels a fixed stride apart, and lays each
 * one into colorxlat through `color_intensity`. Only where they read from and
 * which rows they write differ, so `sendTexCol` below is all four of them.
 *
 * Between them they cover every row a face can name. The scan that says so is
 * the models themselves: of the 4404 that carry geometry, the ones with a face
 * on a palette luma band name rows 0..27 and nothing else, and rows 0..13 are
 * exactly the ones no upload here used to write. Model 793 — Eggman's head — is
 * where that showed. Its lenses are two quads on the transparent renderer at
 * luma band 1 with a colorbase of zero, so their sixteen colours are row 0 at
 * luma 49..63, and row 0 was black.
 */

/* 0x7b4, run once at boot rather than per scene: two tables of their own, block
 * 0 of each, two rows apiece. Nothing writes their luma 48..63 afterwards — the
 * ramp stops at 47 and the stage block starts at row 14 — so they are simply
 * part of the table however the scene changes. */
const FIXED_COLOR_PTRS = [0x02101014, 0x02101018];
const FIXED_ROW0 = [5, 12];
const FIXED_ROWS = 2;

/*
 * `send_tex_col_part` (0x800): five rows of a fighter's own colours, indexed by
 * that fighter's character number. Player 1 gets rows 0..4 and player 2 rows
 * 7..11 — the routine takes the player in g0 and turns it into the row base,
 * reading the character out of `p1_parts`/`p2_parts` +0x1B0.
 *
 * Almost nothing names player 2's rows: one model in the whole ROM names row 7
 * and none names 8..11, so a part shared between the two sides — 793 is on both
 * Eggman and his second-half twin — reads player 1's block whoever is wearing
 * it. That is the board's own answer, not an approximation of it, and it is why
 * the viewer asks for one character rather than two.
 *
 * A character at or past 26 indexes a second table with 26 taken off, and that
 * table's entries are the first one's from 12 on: 34, Eggman's second-half
 * form, lands on entry 20 and takes a block whose row 0 is black.
 */
const PART_COLOR_PTR = 0x02101008;
const PART_COLOR_PTR_HI = 0x0210100c;
const PART_BLOCK = 0x2a0;
const PART_ROWS = 5;
const PART_ROW0 = [0, 7];               /* player 1, player 2 */
const CHAR_SPLIT = 26;

/* `send_tex_col_skin` (0x93c): two rows per player, and the odd one out in
 * shape — sixty-four colours over luma 0..63 rather than sixteen over 48..63,
 * so a skin row is a ramp of its own rather than a palette laid over one. Its
 * table is the first pointer in the block, and a character past 26 indexes it
 * 0x2400 further on, which is entry 12: the same fold the part table makes with
 * a second pointer. */
const SKIN_COLOR_PTR = 0x02101000;
const SKIN_BLOCK = 0x300;
const SKIN_HI_OFFSET = 0x2400;
const SKIN_ROWS = 2;
const SKIN_ROW0 = [28, 30];             /* player 1, player 2 */
const SKIN_COLORS = 64;
const SKIN_LUMA0 = 0;
const SKIN_GROUP = 0x180;
const SKIN_CHANNEL = 0x80;

/* Rows chg_pol_color_send covers. 28..31 are the fighters' skin colours, which
 * send_tex_col_skin writes per character — see SKIN_COLOR_PTR above. */
const POL_ROWS = 28;
const POL_LUMA = 48;

/* The flat band, luma 64..127. MAME's palette_w reads a flat palette colour out
 * of it at luma 0x40, which is why the backdrop needs it too. */
const SCR_LUMA0 = 64;
const SCR_LUMA_COUNT = 64;

/*
 * check_sram_all's defaults for the test-menu colour settings. They live in
 * backup RAM, so an operator can move them; these are the values the game
 * writes when the battery-backed copy does not check out, and so what a machine
 * in its shipped state runs with.
 */
export const TST_ADD = 22;
export const TST_MUL = 54;
export const TST_BRIGHT = 31;

/* chg_pol_color_req's fixed rational, applied to TST_MUL before the ramp: with
 * the default 54 the product is exactly 84. */
const POL_MUL_NUM = 0x1c;
const POL_MUL_DEN = 0x12;

/* color_intensity's curve: (x - PIVOT) * TST_MUL / SLOPE_DIV + TST_ADD. */
const INTENSITY_PIVOT = 116;
const INTENSITY_DIV = 37;

/* RED / GREEN / BLUE (0x5000E0..2), the per-channel trim stage_disp copies out
 * of the stage record. 128 is unity — the code applies it as `* c >> 7`. */
const TINT_UNITY = 128;

/*
 * A value that overflows the 8-bit table is stored as -1 and read back as 0xff,
 * so the clamp has to happen before the trim multiply, not after.
 */
function clampEntry(v) {
    return v >= 0x100 ? 0xffff : v;
}

function trim(v, tint) {
    /* The i960 multiplies the 32-bit -1 through and keeps the low halfword,
     * which for any trim value leaves the entry saturated. */
    if (v === 0xffff) return 0xffff;
    return ((tint * v) >>> 7) & 0xffff;
}

/**
 * Luma RAM for the whole game — it is not per-scene, and the game uploads it
 * once at boot.
 *
 * @param {object} rom loaded ROM set
 * @returns {Uint8Array} LUMA_BYTES, bytes on even addresses like a dump
 */
export function buildLumaram(rom) {
    const dv = rom.mainDataView;
    const md = rom.mainData;
    const src = LUMA_DATA - MAIN_DATA_BASE;
    const bands = dv.getUint32(LUMA_COUNT - MAIN_DATA_BASE, true);

    const luma = new Uint8Array(LUMA_BYTES);
    const n = Math.min(bands * LUMA_BAND, LUMA_BYTES / 2);
    for (let i = 0; i < n; i++) luma[i * 2] = md[src + i];
    return luma;
}

/*
 * send_tex_col_loop — the routine all four colour uploads end in.
 *
 * `rows` consecutive colorxlat rows take one group of `count` colours each,
 * starting at luma `luma0`; the three channels of a group sit `channelStride`
 * apart and each group `groupStride` on from the last. Every entry goes through
 * color_intensity, which is where the per-channel trim is applied — the same
 * ARRAY_NUM_RED/GREEN/BLUE tables `make_lay_col_256_tbl` builds once and all
 * four uploads read.
 */
function sendTexCol(dv, put, rgb, {
    src, row0, rows, luma0, count, groupStride, channelStride,
}) {
    for (let g = 0; g < rows; g++) {
        for (let ch = 0; ch < 3; ch++) {
            for (let i = 0; i < count; i++) {
                const v = dv.getUint16(src + groupStride * g + ch * channelStride + i * 2, true);
                put(ch, row0 + g, luma0 + i, intensity(v, rgb[ch]));
            }
        }
    }
}

/** One of the pointers in the block at 0x02101000, as a main_data offset. */
function colorTable(dv, addr) {
    return dv.getUint32(addr - MAIN_DATA_BASE, true) - MAIN_DATA_BASE;
}

/**
 * colorxlat for one scene.
 *
 * @param {object} rom            loaded ROM set
 * @param {object} [opts]
 * @param {number} [opts.colorSet]  the stage record's second texture number,
 *                                  which is what stage_disp hands the upload
 * @param {number[]} [opts.tint]    stage_RED/GREEN/BLUE as 0..1, i.e. the
 *                                  `tint` readStageTable already divides by 128
 * @param {number[]} [opts.fighters] the character numbers on screen, player 1
 *                                  first — whose part and skin rows to write.
 *                                  An empty list leaves those rows at zero,
 *                                  which is what a scene with no fighter in it
 *                                  shows: no stage model names one.
 * @returns {Uint8Array} CXLAT_BYTES, laid out like a dump of 0x01810000
 */
export function buildColorxlat(rom, { colorSet = 0, tint = [1, 1, 1], fighters = [] } = {}) {
    const dv = rom.mainDataView;
    const out = new Uint8Array(CXLAT_BYTES);
    const view = new DataView(out.buffer);
    const rgb = tint.map((t) => Math.round(t * TINT_UNITY));

    const put = (ch, row, luma, v) => {
        view.setUint16(ch * CXLAT_CHANNEL + row * CXLAT_ROW + luma * 2, v, true);
    };

    /* ---- chg_pol_color_req / _send: the ramp, luma 1..47 of rows 0..27 ----
     * The row is walked with an accumulator rather than a multiply, so the
     * truncation compounds; row 0 is left at zero, and so is luma 0. */
    for (let row = 1; row < POL_ROWS; row++) {
        for (let ch = 0; ch < 3; ch++) {
            const step = Math.trunc((POL_MUL_NUM * (TST_MUL * row)) / POL_MUL_DEN);
            let acc = 0;
            for (let luma = 1; luma < POL_LUMA; luma++) {
                acc += step;
                put(ch, row, luma, trim(clampEntry((acc >>> 8) + TST_ADD), rgb[ch]));
            }
        }
    }

    /* ---- chg_scr_color_req: one flat value per row, luma 64..127 ----
     * This one is the ramp evaluated at a single brightness and is not trimmed,
     * which is what makes it the row MAME's palette_w reads a flat colour from. */
    for (let row = 0; row < 32; row++) {
        const p = row * TST_BRIGHT;
        const v = p === 0 ? 0 : clampEntry(((TST_MUL * p) >>> 8) + TST_ADD);
        for (let luma = SCR_LUMA0; luma < SCR_LUMA0 + SCR_LUMA_COUNT; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
    }

    /* ---- send_tex_col_stage: the scene's sixteen colours, luma 48..63 ----
     * Rows 14..26 stop being a brightness ramp here and become a palette: a
     * face with a grey colorbase and a lumabase that lands in this band is a
     * palettised surface, and its texel picks one of these sixteen. */
    sendTexCol(dv, put, rgb, {
        src: colorTable(dv, STAGE_COLOR_PTR) + STAGE_BLOCK * colorSet,
        row0: STAGE_ROW0, rows: STAGE_ROWS, luma0: STAGE_LUMA0,
        count: STAGE_COLORS, groupStride: STAGE_GROUP, channelStride: 0x20,
    });

    /* ---- 0x7b4: rows 5..6 and 12..13, block 0 of two tables of their own ----
     * Written once at boot on the board and never touched again, so from a
     * scene's point of view they are as fixed as the ramp. 155 models have a
     * palette-band face that names one of the four. */
    FIXED_COLOR_PTRS.forEach((ptr, i) => {
        sendTexCol(dv, put, rgb, {
            src: colorTable(dv, ptr),
            row0: FIXED_ROW0[i], rows: FIXED_ROWS, luma0: STAGE_LUMA0,
            count: STAGE_COLORS, groupStride: STAGE_GROUP, channelStride: 0x20,
        });
    });

    /* ---- send_tex_col_part and send_tex_col_skin: whoever is on screen ---- */
    fighters.slice(0, 2).forEach((charIndex, player) => {
        if (!(charIndex >= 0)) return;
        const hi = charIndex >= CHAR_SPLIT;
        sendTexCol(dv, put, rgb, {
            src: colorTable(dv, hi ? PART_COLOR_PTR_HI : PART_COLOR_PTR)
                + PART_BLOCK * (hi ? charIndex - CHAR_SPLIT : charIndex),
            row0: PART_ROW0[player], rows: PART_ROWS, luma0: STAGE_LUMA0,
            count: STAGE_COLORS, groupStride: STAGE_GROUP, channelStride: 0x20,
        });
        sendTexCol(dv, put, rgb, {
            src: colorTable(dv, SKIN_COLOR_PTR)
                + SKIN_BLOCK * (hi ? charIndex - CHAR_SPLIT : charIndex)
                + (hi ? SKIN_HI_OFFSET : 0),
            row0: SKIN_ROW0[player], rows: SKIN_ROWS, luma0: SKIN_LUMA0,
            count: SKIN_COLORS, groupStride: SKIN_GROUP, channelStride: SKIN_CHANNEL,
        });
    });

    return out;
}

/*
 * color_intensity — the 256-entry curve make_lay_col_256_tbl builds into
 * ARRAY_NUM_RED/GREEN/BLUE, evaluated at one point. Everything below the pivot
 * is black, which is what keeps the unused half of a scene's colour table from
 * showing up as dark grey.
 */
function intensity(x, tint) {
    const v = Math.trunc(((x - INTENSITY_PIVOT) * TST_MUL) / INTENSITY_DIV) + TST_ADD;
    if (v <= 0) return 0;
    return trim(clampEntry(v), tint);
}

/* ---- The animated palette rows ------------------------------------------- */

/*
 * sub_243AC — one row of the scene palette, rotated.
 *
 * The stage colour block holds sixteen colours per row per channel, and
 * send_tex_col_stage lays them into luma slots 48..63 in order. Once a frame
 * sub_2435C rewrites a handful of those rows from the same block read at an
 * offset, so a face keeps its colorbase and its texel and still changes colour:
 * slot i takes colour (phase + i) & 15. That is how South Island's sea and its
 * waterfall move, and it is why the sixty-four bands past the first two look
 * like the same sixteen slots rotated one step further each — they are.
 *
 * Rotating by zero writes back exactly what buildColorxlat wrote, so this is
 * also how a paused stage is restored.
 *
 * @param {object} rom
 * @param {Uint8Array} cxlat  the table to patch, in place
 * @param {object} opts       row: colorxlat row 14..26; phase: 0..15
 */
export function cycleStageColors(rom, cxlat, { colorSet = 0, tint = [1, 1, 1], row, phase }) {
    if (row < STAGE_ROW0 || row >= STAGE_ROW0 + STAGE_ROWS) return;
    const dv = rom.mainDataView;
    const view = new DataView(cxlat.buffer, cxlat.byteOffset, cxlat.byteLength);
    const rgb = tint.map((t) => Math.round(t * TINT_UNITY));

    const table = dv.getUint32(STAGE_COLOR_PTR - MAIN_DATA_BASE, true) - MAIN_DATA_BASE;
    const group = table + STAGE_BLOCK * colorSet + STAGE_GROUP * (row - STAGE_ROW0);
    for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < STAGE_COLORS; i++) {
            const src = dv.getUint16(group + ch * 0x20 + ((phase + i) & 15) * 2, true);
            view.setUint16(
                ch * CXLAT_CHANNEL + row * CXLAT_ROW + (STAGE_LUMA0 + i) * 2,
                intensity(src, rgb[ch]), true);
        }
    }
}
