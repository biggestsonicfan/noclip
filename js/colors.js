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
 * stf-tools/test-colors.mjs.
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

/*
 * Everything below is shape, not address.
 *
 * Both games build colorxlat with the same code — the same ramp, the same flat
 * band, the same four uploads ending in the same loop, and the same intensity
 * curve with the same pivot and divisor. Fighting Vipers' `send_tex_col_go` is
 * instruction for instruction the other game's `send_tex_col_loop`. What moves
 * is where each upload reads from and which rows it writes, and that is in
 * js/games.js as the profile's `colors` block.
 *
 * The one structural difference is how a source is named. Sonic The Fighters
 * keeps a pointer block at data offset 0x101000 and every upload loads its
 * table out of it; Fighting Vipers names each table by address in the
 * instruction — `lda unk_2109700, g3` for the scene's, `lda unk_2105800, g3`
 * for a fighter's parts. A source descriptor carries `indirect` to say which.
 */

/* Groups of sixteen colours, three 16-bit channels 0x20 apart, 0x60 per group.
 * Shared by the scene, the fixed tables and the part tables in both games. */
const GROUP_STRIDE = 0x60;
const GROUP_CHANNEL = 0x20;
const GROUP_COLORS = 16;

/* The skin upload is the odd one out in both games, and identically so: sixty-
 * four colours over luma 0..63 rather than sixteen over 48..63, so a skin row is
 * a ramp of its own rather than a palette laid over one. */
const SKIN_COLORS = 64;
const SKIN_LUMA0 = 0;
const SKIN_GROUP = 0x180;
const SKIN_CHANNEL = 0x80;

/* Rows the ramp covers, and the luma it runs to. */
const POL_ROWS = 28;
const POL_LUMA = 48;

/* The flat band, luma 64..127. MAME's palette_w reads a flat palette colour out
 * of it at luma 0x40, which is why the backdrop needs it too. */
const SCR_LUMA0 = 64;
const SCR_LUMA_COUNT = 64;

/*
 * The test-menu colour settings, as check_sram_all writes them when the
 * battery-backed copy does not check out — so what a machine in its shipped
 * state runs with. Sonic The Fighters keeps one add and one multiply for all
 * three channels; Fighting Vipers keeps a pair per channel (0x500234..0x500239)
 * and ships all three at the same numbers, which are also the other game's. So
 * the arithmetic below is per-channel for both and comes out identical.
 */
export const TST_ADD = 22;
export const TST_MUL = 54;
export const TST_BRIGHT = 31;

/* chg_pol_color_req's fixed rational, applied to the multiply before the ramp:
 * with the default 54 the product is exactly 84. Both games use 0x1C/0x12. */
const POL_MUL_NUM = 0x1c;
const POL_MUL_DEN = 0x12;

/* color_intensity's curve: (x - PIVOT) * mul / DIV + add. sub_74C in Fighting
 * Vipers builds it with `shlo 2, 0x1D` for the pivot and `addo 0x1F, 6` for the
 * divisor — 116 and 37, the same two numbers. */
const INTENSITY_PIVOT = 116;
const INTENSITY_DIV = 37;

/* RED / GREEN / BLUE (0x5000E0..2), the per-channel trim. 128 is unity — the
 * code applies it as `* c >> 7`. */
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
    /* The House of the Dead states no count: sub_1610 copies a fixed 0x4000
     * bytes, data 0xC8EB40..0xC92B3F, to the even addresses. */
    if (rom.game.colors.luma.bytes) {
        const { data, bytes } = rom.game.colors.luma;
        const luma = new Uint8Array(LUMA_BYTES);
        for (let i = 0; i < Math.min(bytes, LUMA_BYTES / 2); i++) luma[i * 2] = md[data + i];
        return luma;
    }
    /* essential_color_handling reads a block count and then that many 128-byte
     * bands, one per lumabase. Fighting Vipers reaches its pair through the
     * XTRA_DATA mirror -- `lda unk_64266E0` -- which folds to a data offset like
     * any other, so both games are the same two reads. */
    const { count, data } = rom.game.colors.luma;
    const src = data;
    const bands = dv.getUint32(count, true);

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
function sendTexCol(dv, put, rgb, add, mul, {
    src, row0, rows, luma0, count, groupStride, channelStride,
}) {
    for (let g = 0; g < rows; g++) {
        for (let ch = 0; ch < 3; ch++) {
            for (let i = 0; i < count; i++) {
                const v = dv.getUint16(src + groupStride * g + ch * channelStride + i * 2, true);
                put(ch, row0 + g, luma0 + i, intensity(v, rgb[ch], add[ch], mul[ch]));
            }
        }
    }
}

/*
 * A source descriptor's table, as a main_data offset.
 *
 * `indirect` is the whole difference between the two games: Sonic The Fighters
 * keeps a pointer block and loads the table out of it, Fighting Vipers names
 * the table in the instruction itself.
 */
function colorTable(dv, src) {
    return src.indirect ? dv.getUint32(src.at, true) - MAIN_DATA_BASE : src.at;
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
    if (rom.game.colors.curve) return buildCurveColorxlat(rom, colorSet);
    const dv = rom.mainDataView;
    const C = rom.game.colors;
    const out = new Uint8Array(CXLAT_BYTES);
    const view = new DataView(out.buffer);
    const rgb = tint.map((t) => Math.round(t * TINT_UNITY));
    const add = C.add, mul = C.mul;

    const put = (ch, row, luma, v) => {
        view.setUint16(ch * CXLAT_CHANNEL + row * CXLAT_ROW + luma * 2, v, true);
    };
    /* Every upload lays sixteen colours over luma 48..63, so only the source
     * and the rows change between them. */
    const palette = (src, row0, rows) => sendTexCol(dv, put, rgb, add, mul, {
        src, row0, rows, luma0: PALETTE_LUMA0, count: GROUP_COLORS,
        groupStride: GROUP_STRIDE, channelStride: GROUP_CHANNEL,
    });

    /* ---- chg_pol_color_req / _send: the ramp, luma 1..47 of rows 0..27 ----
     * The row is walked with an accumulator rather than a multiply, so the
     * truncation compounds; row 0 is left at zero, and so is luma 0. Both games
     * start the row loop at 1 — `mov 1, r5` right before it. */
    for (let row = 1; row < POL_ROWS; row++) {
        for (let ch = 0; ch < 3; ch++) {
            const step = Math.trunc((POL_MUL_NUM * (mul[ch] * row)) / POL_MUL_DEN);
            let acc = 0;
            for (let luma = 1; luma < POL_LUMA; luma++) {
                acc += step;
                put(ch, row, luma, trim(clampEntry((acc >>> 8) + add[ch]), rgb[ch]));
            }
        }
    }

    /* ---- chg_scr_color_req: one flat value per row, luma 64..127 ----
     * This one is the ramp evaluated at a single brightness and is not trimmed,
     * which is what makes it the row MAME's palette_w reads a flat colour from. */
    for (let row = 0; row < 32; row++) {
        const p = row * C.bright;
        for (let ch = 0; ch < 3; ch++) {
            const v = p === 0 ? 0 : clampEntry(((mul[ch] * p) >>> 8) + add[ch]);
            for (let luma = SCR_LUMA0; luma < SCR_LUMA0 + SCR_LUMA_COUNT; luma++) {
                put(ch, row, luma, v);
            }
        }
    }

    /* ---- send_tex_col_stage: the scene's sixteen colours, luma 48..63 ----
     * Those rows stop being a brightness ramp here and become a palette: a face
     * with a grey colorbase and a lumabase that lands in this band is a
     * palettised surface, and its texel picks one of these sixteen. */
    palette(colorTable(dv, C.stage) + C.stage.block * colorSet,
        C.stage.row0, C.stage.rows);

    /* ---- Tables written once at boot and never touched again ----
     * Sonic The Fighters has two, covering rows 5..6 and 12..13, which its
     * other uploads leave alone; 155 models have a palette-band face naming one
     * of the four. Fighting Vipers has none, because its part rows run 0..6 and
     * 7..13 and leave no gap for them. */
    for (const f of C.fixed) palette(colorTable(dv, f), f.row0, f.rows);

    /* ---- send_tex_col_part and send_tex_col_skin: whoever is on screen ----
     * A character at or past the split indexes a second table with the split
     * taken off — 26 in one game, 13 in the other, each the `subo` the routine
     * does right after comparing the character number at +0x1B0. */
    fighters.slice(0, 2).forEach((charIndex, player) => {
        if (!(charIndex >= 0)) return;
        const part = C.part, skin = C.skin;
        const hi = charIndex >= part.split;
        const n = hi ? charIndex - part.split : charIndex;

        palette(colorTable(dv, hi ? { ...part, at: part.atHi } : part) + part.block * n,
            part.row0[player], part.rows);

        sendTexCol(dv, put, rgb, add, mul, {
            src: colorTable(dv, skin) + skin.block * n + (hi ? skin.hiOffset : 0),
            row0: skin.row0[player], rows: skin.rows, luma0: SKIN_LUMA0,
            count: SKIN_COLORS, groupStride: SKIN_GROUP, channelStride: SKIN_CHANNEL,
        });
    });

    return out;
}

/* ---- The House of the Dead ----------------------------------------------- */

/*
 * The AM1 library's colorxlat: a curve rather than a ramp, and set colours that
 * are ramps of their own rather than sixteen palette slots.
 *
 * sub_1180, once at boot, walks all 32 rows. A row's brightness is
 * y = ½√x + ½x² with x = (8·row + row>>2) / 255, which runs 0 to 1 over the 32
 * rows. Luma 0..63 of the row take the same curve again at z = y·luma/63, times
 * 255, into a RAM staging copy; luma 64..255 take the flat y·255 and go straight
 * into colorxlat. The three channels are identical.
 *
 * sub_1330, on every change of set, overwrites the staging copy's odd rows
 * 1, 3 .. 27 with the set's fourteen tables — 64 RGB byte triples each, named by
 * `dword_820D0[set]` — times a gain of 1.1 (1.0 on stages 5 and 8, which this
 * prototype never reaches). The gain is `dword_7FFC0[byte_51E49A & 1]`, and that
 * byte is a test-menu setting the EEPROM defaults to 0. So a palette colour whose
 * three channels are the same odd number names a coloured ramp, and one whose
 * channels are even names a grey.
 *
 * The staging copy reaches colorxlat unchanged: sub_15900 copies the even rows
 * and row 31, sub_15A00 the odd rows 1..29, 64 entries each.
 *
 * The arithmetic is float, mixed single and double as the i960 does it — a `real`
 * operation rounds to single, a `long real` one to double — and every result is
 * truncated toward zero and capped at 255.
 */
function buildCurveColorxlat(rom, colorSet) {
    const C = rom.game.colors;
    const cv = rom.mainCpuView;
    const out = new Uint8Array(CXLAT_BYTES);
    const view = new DataView(out.buffer);
    const put = (ch, row, luma, v) => {
        view.setUint16(ch * CXLAT_CHANNEL + row * CXLAT_ROW + luma * 2, v, true);
    };
    const f = Math.fround;
    const cap = (v) => Math.min(Math.trunc(v), 255);
    /* ½√v + ½v²: the square root and its half in single, the square in double,
     * the sum rounded back to single. */
    const curve = (v) => f(f(f(Math.sqrt(v)) * 0.5) + (0.5 * v) * v);

    for (let row = 0; row < 32; row++) {
        const y = curve(f(((row << 3) + (row >> 2)) / 255));
        for (let luma = 0; luma < 64; luma++) {
            const v = cap(f(curve(f(y * f(luma / 63))) * 255));
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
        const flat = cap(f(y * 255));
        for (let luma = 64; luma < 256; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, flat);
        }
    }

    const { ptrs, rows, row0, step, gain } = C.curve.sets;
    const table = colorSet >= 0 ? cv.getUint32(ptrs + colorSet * 4, true) : 0;
    if (table && table + rows * 4 <= rom.maincpu.length) {
        const g = f(cv.getFloat32(gain, true));
        for (let r = 0; r < rows; r++) {
            const src = cv.getUint32(table + r * 4, true);
            if (!src || src + 64 * 3 > rom.maincpu.length) continue;
            for (let luma = 0; luma < 64; luma++) {
                for (let ch = 0; ch < 3; ch++) {
                    put(ch, row0 + r * step, luma, cap(f(rom.maincpu[src + luma * 3 + ch] * g)));
                }
            }
        }
    }
    return out;
}

/*
 * color_intensity — the 256-entry curve make_lay_col_256_tbl builds into
 * ARRAY_NUM_RED/GREEN/BLUE, evaluated at one point. Everything below the pivot
 * is black, which is what keeps the unused half of a scene's colour table from
 * showing up as dark grey.
 */
function intensity(x, tint, add, mul) {
    const v = Math.trunc(((x - INTENSITY_PIVOT) * mul) / INTENSITY_DIV) + add;
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
    const st = rom.game.colors.stage;
    if (row < st.row0 || row >= st.row0 + st.rows) return;
    const dv = rom.mainDataView;
    const view = new DataView(cxlat.buffer, cxlat.byteOffset, cxlat.byteLength);
    const rgb = tint.map((t) => Math.round(t * TINT_UNITY));

    const C = rom.game.colors;
    const table = colorTable(dv, C.stage);
    const group = table + C.stage.block * colorSet + GROUP_STRIDE * (row - C.stage.row0);
    for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < GROUP_COLORS; i++) {
            const src = dv.getUint16(group + ch * GROUP_CHANNEL + ((phase + i) & 15) * 2, true);
            view.setUint16(
                ch * CXLAT_CHANNEL + row * CXLAT_ROW + (PALETTE_LUMA0 + i) * 2,
                intensity(src, rgb[ch], C.add[ch], C.mul[ch]), true);
        }
    }
}
