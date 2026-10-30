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

import { MAIN_DATA_BASE } from './romset.js';
import { dynamcopScene } from './dynamcop.js';
import { motoraidScene } from './motoraid.js';
import { I960 } from './i960.js';
import { dynabbColors } from './dynabb.js';
import { buildSkisuprgColorxlat } from './skisuprg.js';
import { buildWaverunrColorxlat } from './waverunr.js';
import { buildTopskatrColorxlat } from './topskatr.js';
import { buildBelColorxlat, buildBelLuma } from './bel.js';

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

/* A writer for one colorxlat entry, by channel, palette row and luma slot. */
function cxlatWriter(cxlat) {
    const view = new DataView(cxlat.buffer, cxlat.byteOffset, cxlat.byteLength);
    return (ch, row, luma, v) => view.setUint16(ch * CXLAT_CHANNEL + row * CXLAT_ROW + luma * 2, v, true);
}

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
 * state runs with. These are Sonic The Fighters', one add and one multiply for
 * all three channels. Fighting Vipers keeps a pair per channel
 * (0x500234..0x500239) and ships its own numbers, add 0x40 and multiply 0x25
 * (js/games.js). The arithmetic below is per-channel for both, and with each
 * game's numbers the ramp, the flat band and the palette band all come out as
 * MAME's colorxlat holds them after a boot on empty NVRAM.
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
 * Luma RAM for the whole game — for most games it is not per-scene, and the
 * game uploads it once at boot. A game whose own colour routines take a set
 * (`colors.i960.sets`) runs them for `colorSet`: Over Rev's courses copy luma
 * bands of their own.
 *
 * @param {object} rom loaded ROM set
 * @param {number} [colorSet] the scene's colour set
 * @returns {Uint8Array} LUMA_BYTES, bytes on even addresses like a dump
 */
export function buildLumaram(rom, colorSet = 0) {
    /* Power Sled works its table out (0xC8F0): two bands of 128, entry i
     * (i + 1) >> 1, so a texel's luma halves onto the row's 64 entries. */
    if (rom.game.colors.luma?.halfRamp) {
        const luma = new Uint8Array(LUMA_BYTES);
        for (let i = 0; i < 256; i++) luma[i * 2] = ((i & 127) + 1) >> 1;
        return luma;
    }
    /* A game that names its luma table copies it rather than working it out,
     * whatever it runs for colorxlat (Manx TT's 0x3828). */
    if (rom.game.colors.i960 && !rom.game.colors.luma) return runColorRoutines(rom, colorSet).luma.slice();
    /* Dynamite Baseball 97's is the boot's, whichever set (js/dynabb.js). */
    if (rom.game.colors.dynabb) return dynabbColors(rom, rom.game.texture.defaultSet).luma.slice();
    /* Behind Enemy Lines repeats one band (js/bel.js). */
    if (rom.game.colors.luma?.bel) return buildBelLuma(rom, LUMA_BYTES);
    /* Last Bronx works its out too (0x1A50): band b of divisor d takes
     * ((k + 1) & 0x7E) * 64 / d for k of 0..d, and 0x40 past it. */
    const bands = rom.game.colors.luma?.bands;
    if (bands) {
        const luma = new Uint8Array(LUMA_BYTES);
        bands.forEach((d, b) => {
            for (let k = 0; k < LUMA_BAND; k++) {
                luma[(b * LUMA_BAND + k) * 2] = k <= d ? Math.trunc((((k + 1) & 0x7e) << 6) / d) : 0x40;
            }
        });
        return luma;
    }
    /* Daytona USA keeps both the count and the bands in its program ROM, where
     * the other games keep them in the data ROM — `lda 0x22FD38` and
     * `ld 0x22FD34` in the upload at 0x1314, which are that region's own
     * offsets once the 0x00220000 alias is subtracted. Only the region the two
     * reads come from changes; the two reads do not. */
    const src = rom.game.colors.luma.source ?? 'mainData';
    const dv = src === 'maincpu' ? rom.mainCpuView : rom.mainDataView;
    const md = src === 'maincpu' ? rom.maincpu : rom.mainData;
    /* essential_color_handling reads a block count and then that many 128-byte
     * bands, one per lumabase. Fighting Vipers reaches its pair through the
     * XTRA_DATA mirror -- `lda unk_64266E0` -- which folds to a data offset like
     * any other, so both games are the same two reads. The House of the Dead
     * states no count: sub_1610 copies a fixed 0x4000 bytes, data
     * 0xC8EB40..0xC92B3F, to the even addresses. */
    const { count, data, bytes, at = 0, ramps = 0 } = rom.game.colors.luma;
    const n = Math.min(bytes ?? dv.getUint32(count, true) * LUMA_BAND, LUMA_BYTES / 2 - at);

    const luma = new Uint8Array(LUMA_BYTES);
    /* Virtual On (0x28548) computes its first bands, (k + 1) >> 1 for k of
     * 0..127, and copies the ROM's from entry `at` on. */
    for (let i = 0; i < ramps * LUMA_BAND; i++) luma[i * 2] = ((i % LUMA_BAND) + 1) >> 1;
    for (let i = 0; i < n; i++) luma[(at + i) * 2] = md[data + i];
    /* INDY 500 copies its table and then a second over the start of it
     * (0x2E010: 0x180 bytes from XTRA 0x64B0850, the Deluxe's 0x3442C from
     * its program ROM). */
    for (const o of rom.game.colors.luma.over ?? []) {
        const from = o.source === 'maincpu' ? rom.maincpu : rom.mainData;
        for (let i = 0; i < o.bytes; i++) luma[i * 2] = from[o.data + i];
    }
    /* Sky Target's texture copier runs past the last sheet into the first
     * entries (js/texture.js), after the table is in: the low bytes of the
     * halfwords at data `spill.data`. */
    const spill = rom.game.colors.luma.spill;
    for (let i = 0; spill && i < spill.entries; i++) luma[i * 2] = rom.mainData[spill.data + i * 2];
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

/*
 * colorxlat for a game that computes it rather than uploading one — Daytona
 * USA, whose routine at 0xA74 is short enough to be a transcription:
 *
 *     for row in 0..31:
 *       r6 = 0
 *       do  r7 = row * r6 ; if (r7) r7 += bias ; r7 >>= 6
 *           if (r7 >= 0x100) r7 = -1            ; saturate, stored as 0xFFFF
 *           write r7 to all three channels ; r6 += step
 *       while (r6 < span)                       ; span / step = 64 entries
 *       r6 = step * row
 *       r8 = r6 ? (flat + r6) >> 1 : 0
 *       write r8 to all three channels 192 times
 *
 * 64 ramp entries and 192 flat ones is a whole 256-entry row, and the same
 * value goes to all three channels because on this board the row is the
 * palette colour's own five bits for that channel (model2rd.ipp indexes
 * colortable_r by the red five, colortable_g by the green five and so on). So
 * there is no scene, no tint and no ROM table in it at all: the whole of
 * colorxlat is these four constants.
 *
 * Only luma 0..63 is ever read back — js/viewer.js caps the index at 63, as
 * draw_scanline_tex does at 0x3F — so the flat tail is written for the sake of
 * being what the board holds rather than because anything samples it.
 *
 * Virtua Cop then lays a scene palette over luma 48..63 of every row, as the
 * texture-mapped games do: 0x4170 copies sixteen colours a row out of the
 * table its `band` names for the stage, and 0x4328 spreads each one into the
 * three channels. A channel is four bits of the colour and one of the top
 * three (red 0-3 and 12, green 4-7 and 13, blue 8-11 and 14), times 8. It is
 * what turns a car's windows blue: their texels land in that band, on the
 * white row.
 */
function buildRampColorxlat(rom, colorSet) {
    /* Which set is the test menu's CABINET setting (see DAYTONA_CABINETS in
     * js/games.js); the panel's switch puts its choice on the ROM set. */
    const C = rom.game.colors;
    const { step, span, bias, flat, top = 0xff } = C.cabinets?.[rom.cabinet ?? C.cabinet]?.ramp ?? C.ramp;
    const out = new Uint8Array(CXLAT_BYTES);
    const set = cxlatWriter(out);
    const put = (row, luma, v) => {
        for (let ch = 0; ch < 3; ch++) set(ch, row, luma, v);
    };
    const entries = Math.ceil(span / step);
    for (let row = 0; row < 32; row++) {
        for (let i = 0; i < entries; i++) {
            let v = row * i * step;
            if (v) v += bias;
            v >>>= 6;
            /* Desert Tank's 0x37150 keeps a 0x100 (`cmpible`): its `top`. */
            put(row, i, v > top ? 0xffff : v);
        }
        const t = step * row;
        const tail = t ? (flat + t) >>> 1 : 0;
        for (let luma = entries; luma < CXLAT_ROW / 2; luma++) put(row, luma, tail);
    }
    const shift = C.shift?.[colorSet];
    if (shift) shiftRamp(out, shift);
    if (C.lift) liftRamp(out, C.lift);
    const band = C.band?.tables[colorSet];
    if (band !== undefined) {
        writeBand(C.band.source === 'maincpu' ? rom.maincpu : rom.mainData, band, set, C.band.blueBit);
    }
    return out;
}

/* ---- Power Sled ------------------------------------------------------------
 *
 * Two passes, both through the same curve: v = 255 * (x / 255) ^ (10 / 17),
 * truncated, worked in the FPU with logr, expr and scaler (0xE354..0xE3B4).
 *
 * - 0xE2D0, at boot: every row is a ramp. Row r's top is a = 8r + (r >> 2),
 *   so row 31 reaches 255; luma l takes x = (a * (l + 1)) >> 6, and luma 64 on
 *   holds the value at 63. The three channels are the same.
 * - 0xE1D0, straight after: the odd rows 1..29 get 64 colours each instead,
 *   {r, g, b} halfwords from `table`, 0x180 bytes a row, through 0xC960. Luma
 *   64 on keeps the ramp's last value.
 *
 * Checked against m2-hle2's colorxlat RAM: no entry differs. */
function powsledCurve(x) {
    return x <= 0 ? 0 : Math.trunc(Math.exp(Math.log(x / 255) * (10 / 17)) * 255);
}

function buildPowsledColorxlat(rom) {
    const P = rom.game.colors.powsled;
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);
    for (let row = 0; row < 32; row++) {
        const a = row * 8 + (row >> 2);
        for (let luma = 0; luma < CXLAT_ROW / 2; luma++) {
            const v = powsledCurve((a * (Math.min(luma, 63) + 1)) >> 6);
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
    }
    const cv = rom.mainCpuView;
    for (let k = 0; k < P.rows; k++) {
        const row = 1 + k * 2;
        const at = P.table + k * 0x180;
        for (let luma = 0; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, powsledCurve(cv.getUint16(at + (luma * 3 + ch) * 2, true)));
        }
    }
    return out;
}

/*
 * Pilot Kids. The boot (0x5C890) makes every row of all three channels a
 * ramp: slot l of 0..63 is r * (8l + 72) / 72 for row r, floored at r (the
 * byte table at 0x5C870 is 0..31), and slots 64 on keep slot 63's value.
 * Then 0x5C960 lays the colours of table 0 over the first 64 slots of odd
 * rows 1 to 9, and a scene its own table over odd rows 11 to 29 (0x54A20, the
 * table chosen by the scene script's op 144). `tables` is the program's list
 * of the tables' offsets, `counts` their row counts, a row 64 {r, g, b} byte
 * triples. `scenes` is the table each texture set's scene picks, as far as
 * m2-hle2 has shown it; null keeps the ramp on rows 11 to 29. In m2-hle2's
 * RAM row 31's first 64 slots are row 30's, by code not found; that is
 * copied. Checked against m2-hle2's colorxlat RAM at the title and in the
 * first stage: no entry differs.
 */
function buildPltkidsColorxlat(rom, colorSet) {
    const P = rom.game.colors.pltkids;
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);
    const ramp = (r, slot) => Math.max(Math.trunc((r * (8 * slot + 72)) / 72), r);
    for (let row = 0; row < 32; row++) {
        for (let luma = 0; luma < CXLAT_ROW / 2; luma++) {
            const v = ramp(row === 31 && luma < 64 ? 30 : row, Math.min(luma, 63));
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
    }
    const md = rom.maincpu;
    const cv = rom.mainCpuView;
    const table = (k, row0) => {
        let at = cv.getUint32(P.tables + k * 4, true);
        for (let i = 0; i < md[P.counts + k]; i++) {
            for (let luma = 0; luma < 64; luma++) {
                for (let ch = 0; ch < 3; ch++) put(ch, row0 + i * 2, luma, md[at++]);
            }
        }
    };
    table(0, 1);
    const scene = P.scenes[colorSet];
    if (scene) table(scene, 11);
    return out;
}

/* ---- Zero Gunner ---- */

/*
 * Zero Gunner's colorxlat, the same in every scene: Pilot Kids' scheme with
 * another ramp (0x489E0). Row r of all three channels is, for slot l of
 * 0..63, ((6r + r / 6 + 64) * (l + 1)) >> 6, row 0 zero, floored at r (the
 * byte table at 0x489C0); slots 64 on keep slot 63's. Then 0x48AD0 lays the
 * program's table over the first 64 slots of odd rows 1, 3, ...: `count`
 * (0x1A10) rows of 64 {r, g, b} bytes from `table` (0x1050). MAME's matches
 * it entry for entry, from the boot (frame 51) to the attract's end.
 */
function buildZerogunColorxlat(rom) {
    const Z = rom.game.colors.zerogun;
    const md = rom.maincpu;
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);
    for (let row = 0; row < 32; row++) {
        const a = row ? 6 * row + Math.trunc(row / 6) + 64 : 0;
        for (let luma = 0; luma < CXLAT_ROW / 2; luma++) {
            const v = Math.max((a * (Math.min(luma, 63) + 1)) >> 6, row);
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
    }
    let at = Z.table;
    for (let k = 0; k < md[Z.count] && 2 * k + 1 < 32; k++) {
        for (let luma = 0; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, 2 * k + 1, luma, md[at++]);
        }
    }
    return out;
}

/* ---- Sky Target ---- */

/*
 * Sky Target's colorxlat, all three channels from one RAM staging (0x51FA10,
 * 0x520A10, 0x521A10; 0x2D350 copies it up every frame). Row r is
 * a = 6r + r / 6 + 64 (row 0 zero) in slots 64 on (0x37120), and in slots
 * 0..63 max((a * (l + 1)) >> 6, r) (0x37290, the byte table at 0x37100).
 * Then 0x37390 lays 14 tables of 64 {r, g, b} bytes over odd rows 1..27,
 * from the list a stage record's +4 points at (`records`, 24 bytes each), or
 * the boot's list (`bootList`) for the boot set. Each byte is scaled by the
 * single float at 0xE6AE8 the brightness setting picks (1.1 on fresh NVRAM,
 * `gain`), truncated and held at 255; stages 5 and 8 take 1.0 (`flat`).
 * A stage's 0x374D0 lays a row 21 from the list at record +0xC, and 0x37590
 * then the four rows of 0xC0 bytes at `fixed` (0x640F85C) over rows 19, 21,
 * 23 and 25, so record +0xC never shows. The 0x64 addresses are the data
 * ROM's last megabyte through the XTRA_DATA mirror. MAME's matches entry for
 * entry at the title and in the first stage.
 */
function buildSkytargtColorxlat(rom, colorSet) {
    const S = rom.game.colors.skytargt;
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);
    const cv = rom.mainCpuView;
    const md = rom.mainData;
    const at = (a) => (a >= 0x6000000 ? 0x1000000 + (a & 0xfffff) : a - 0x2000000);
    const u32 = (a) => md[a] | (md[a + 1] << 8) | (md[a + 2] << 16) | (md[a + 3] * 0x1000000);
    for (let row = 0; row < 32; row++) {
        const a = row ? 6 * row + Math.trunc(row / 6) + 64 : 0;
        for (let luma = 0; luma < CXLAT_ROW / 2; luma++) {
            const v = luma < 64 ? Math.max((a * (luma + 1)) >> 6, row) : a;
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
    }
    const boot = colorSet < 0 || colorSet >= S.stages;
    const rec = S.records + (boot ? 0 : colorSet) * S.stride;
    const gain = !boot && S.flat.includes(colorSet) ? 1 : S.gain;
    const list = at(boot ? S.bootList : cv.getUint32(rec + 4, true));
    for (let k = 0; k < 14; k++) {
        const t = at(u32(list + k * 4));
        for (let luma = 0; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, 1 + 2 * k, luma, Math.min(Math.trunc(md[t + luma * 3 + ch] * gain), 255));
        }
    }
    if (boot) return out;
    for (let k = 0; k < 4; k++) {
        const t = at(S.fixed) + k * 0xc0;
        for (let luma = 0; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, 19 + 2 * k, luma, md[t + luma * 3 + ch]);
        }
    }
    return out;
}

/* ---- Gunblade NY ---- */

/*
 * Gunblade NY's colorxlat, all three channels alike. Luma 64..127 of row r
 * hold (215r / 31) + 40, row 0 zero (the boot's 0x16020). Luma 0..63 of the
 * even rows and row 31 are what 0x16800 lays over them at the attract's start
 * in curve 7, the one it takes while the byte at 0x54C0EE is 0, as it is on
 * fresh NVRAM (0x6BAA8): v = r * a / 31, a running from 64 by 6.4 - l / 10 a
 * step (l the luma, the quotient truncated), single floats, at most 255.
 *
 * The odd rows 1..29 are the scene's, key-framed (0xC84E0, from 0xC88C0 with
 * the scene's table number): `ld 0xC75C0[(table * 15 + (row - 1) / 2) * 4]`
 * points at {count, then count keys of position, red, green, blue}, all
 * single floats of 0..1. A key goes in slot trunc(position * 63 + 0.1) as
 * trunc(c * 255 + 0.1) a channel; each slot up to a key is the line from the
 * last key (slot 0's zeros before the first), slots past the last stay 0.
 * A slot's value v writes sqrt(v / 255) * 255, row 3's (sqrt(v / 255) * 3 /
 * 4 + 0.25) * 255. The texture profile's `raw.sets` gives the table each
 * set's scene picks (`keys` is 0xC75C0).
 * No entry differs from MAME's colorxlat in the attract's city (table 0), its
 * stage film (6) and the title (8).
 */
function buildGunbladeColorxlat(rom, colorSet) {
    const C = rom.game.colors.gunblade;
    const cv = rom.mainCpuView;
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);
    const f32 = Math.fround;
    const all = (row, luma, v) => { for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v); };
    for (let row = 0; row < 32; row++) {
        const k = row ? Math.trunc((215 * row) / 31) + 40 : 0;
        for (let luma = 64; luma < 128; luma++) all(row, luma, k);
    }
    for (let row = 0; row < 32; row += row === 30 ? 1 : 2) {
        let a = 64;
        for (let luma = 0; luma < 64; luma++) {
            a = f32(a + f32(Math.trunc(-luma / 10) + f32(6.4)));
            all(row, luma, row ? Math.min(Math.trunc(f32(f32(row * a) / 31)), 255) : 0);
        }
    }
    const raw = rom.game.texture.raw;
    const table = (raw.sets[colorSet] ?? raw.sets[raw.bootSet])[1];
    for (let row = 1; row < 31; row += 2) {
        let p = cv.getUint32(C.keys + (table * 15 + ((row - 1) >> 1)) * 4, true);
        if (p + 4 > rom.maincpu.length) continue;
        const keys = Math.trunc(cv.getFloat32(p, true));
        const slots = Array.from({ length: 64 }, () => [0, 0, 0, 0]);
        for (let i = 0; i < keys && p + 20 <= rom.maincpu.length; i++, p += 16) {
            const at = Math.trunc(f32(cv.getFloat32(p + 4, true) * 63) + 0.1);
            if (at < 0 || at > 63) continue;
            slots[at] = [1, ...[8, 12, 16].map((o) => Math.trunc(f32(cv.getFloat32(p + o, true) * 255) + 0.1) & 0xffff)];
        }
        let last = 0;
        for (let at = 0; at < 64; at++) {
            if (!slots[at][0]) continue;
            const d = at - last;
            for (let j = 1; j <= d; j++) {
                for (let c = 1; c < 4; c++) {
                    const from = slots[last][c], to = slots[at][c];
                    slots[last + j][c] = (from + Math.trunc(((to - from) * j) / d)) & 0xffff;
                }
            }
            last = at;
        }
        for (let at = 0; at < 64; at++) {
            for (let ch = 0; ch < 3; ch++) {
                let x = f32(Math.sqrt(f32(slots[at][ch + 1] / 255)));
                if (row === 3) x = f32(f32(f32(x * 3) / 4) + 0.25);
                put(ch, row, at, Math.trunc(f32(x * 255)));
            }
        }
    }
    return out;
}

/**
 * A Dead or Alive fighter's load id, the byte at the rig's `loads` + 13 *
 * costume + char (0x70F40). The game loads everything of a fighter's by it,
 * not by the character number: its model bank row, its colours (0x5D710) and
 * its texture strips (0x7CBA0), the low bits naming the entry and bit 7 the
 * second half of each. Without the table (Revision A's fight code is not
 * mapped), the character number, which is the id of costume 0's first two.
 * @param {{char:number, costume?:number}} f
 */
export function doaLoadId(rom, { char, costume = 0 }) {
    const loads = rom.game.rig?.loads;
    return loads ? rom.mainCpuView.getUint8(loads + 13 * costume + char) : char;
}

/*
 * Dead or Alive's colorxlat: a grey ramp the boot computes (0xFB0) and, over
 * its odd rows, colours copied whole out of the program ROM (0x5D710). Row r
 * of the ramp is k * (i + 1) >> 6 for luma i < 64, k = 0x40 + 6r + r / 6, and
 * never under r; luma 64 on holds the last of it. The copies are 64 entries a
 * row, three bytes an entry (red, green, blue), five rows two apart: the
 * stage's at row 21 out of `stages[stage]`, the two fighters' at rows 1 and 11
 * out of `fighters[(id >> 7) * perCostume + (id & 15)]`, `id` the fighter's
 * load id (doaLoadId). With no fighter in the scene those rows stay grey.
 *
 * @param {{char:number, costume?:number}[]} fighters  player 1 first
 */
function buildDoaColorxlat(rom, stage, fighters) {
    const C = rom.game.colors.doa;
    const cv = rom.mainCpuView;
    const out = new Uint8Array(CXLAT_BYTES);
    const set = cxlatWriter(out);
    for (let row = 0; row < 32; row++) {
        const k = row ? 0x40 + 6 * row + Math.trunc(row / 6) : 0;
        let v = 0;
        for (let luma = 0; luma < CXLAT_ROW / 2; luma++) {
            if (luma < 64) v = Math.max((k * (luma + 1)) >> 6, row);
            for (let ch = 0; ch < 3; ch++) set(ch, row, luma, v);
        }
    }
    const copyRows = (src, row0) => {
        if (!src || src + C.rows * 64 * 3 > rom.maincpu.length) return;
        for (let r = 0; r < C.rows; r++) {
            for (let luma = 0; luma < 64; luma++) {
                for (let ch = 0; ch < 3; ch++) set(ch, row0 + 2 * r, luma, cv.getUint8(src + (r * 64 + luma) * 3 + ch));
            }
        }
    };
    copyRows(stage >= 0 && stage < C.count ? cv.getUint32(C.stages + stage * 4, true) : 0, C.row0);
    const F = C.fighters;
    if (F) fighters.forEach((f, p) => {
        const id = doaLoadId(rom, f);
        copyRows(cv.getUint32(F.table + ((id >> 7) * F.perCostume + (id & 15)) * 4, true), F.rows[p]);
    });
    return out;
}

/*
 * Virtual On's colorxlat. MakeRGBTable (0x28840) computes a grey curve for
 * all 32 rows: row r, luma i of 1..64, is
 *
 *     (x ** gamma * 0.85 + 0.15) * 255,  x = ((8r + r / 4) * i >> 6) / 255
 *
 * in single floats, 0 where x is, entry i - 1 of the row's front half
 * (0..127) and of its back half (128..255); luma 0 stays 0 and 64..127 hold
 * the last value. `gamma` is one of ten picked by the setting byte at backup
 * RAM 0x1D00027, the default 0.55 when it is out of range, as it is on
 * fresh NVRAM. The odd rows then take colours copied out of the ROMs, 64
 * entries of red, green, blue bytes (SetRampRGB_TBL_BOTH 0xE2040 writes both
 * halves, SetRampRGB_TBL 0xE1F20 the front only), through a 256-entry
 * intensity table that is the identity at the default setting (0xE1E00):
 *
 * - `rows`: InitRampSet's (0xE2130), at boot.
 * - `fields[field]`: RampSet's case for the field (0xE2330, its jump table
 *   0xE23B4 indexed by 0x577590, which initField sets to the field).
 * - `robots`: SetRoboRamp (0xE2120) for the two players, rows 1 and 3 for
 *   player 1 and 5 and 7 for player 2, out of `ld 0x142E94[robot * 4 + n]`,
 *   n 0, 1 for player 1's colours and 2, 3 for player 2's (0x19F30).
 *
 * The rows match MAME's colorxlat after each field's start; what MAME also
 * holds is what an earlier field left in the back halves.
 *
 * @param {{char:number, costume?:number}[]} robots  player 1 first
 */
function buildVonColorxlat(rom, field, robots) {
    const C = rom.game.colors.von;
    const out = new Uint8Array(CXLAT_BYTES);
    const set = cxlatWriter(out);
    const f32 = Math.fround;
    const gamma = f32(C.gamma);
    for (let row = 0; row < 32; row++) {
        const k = 8 * row + (row >> 2);
        for (let luma = 1; luma < 128; luma++) {
            const x = f32(f32((k * Math.min(luma + 1, 64)) >> 6) / 255);
            const v = x === 0 ? 0 : Math.trunc((2 ** (Math.log2(x) * gamma) * 0.85 + 0.15) * 255);
            for (let ch = 0; ch < 3; ch++) {
                set(ch, row, luma, v);
                set(ch, row, luma + 128, v);
            }
        }
    }
    const copy = (row, addr, front = false) => {
        const view = addr >= MAIN_DATA_BASE ? rom.mainDataView : rom.mainCpuView;
        const at = addr >= MAIN_DATA_BASE ? addr - MAIN_DATA_BASE : addr;
        if (at + 64 * 3 > view.byteLength) return;
        for (let luma = 0; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) {
                const v = view.getUint8(at + luma * 3 + ch);
                set(ch, row, luma, v);
                if (!front) set(ch, row, luma + 128, v);
            }
        }
    };
    for (const [row, addr] of C.rows) copy(row, addr);
    for (const [row, addr, front] of C.fields[field] ?? []) copy(row, addr, front);
    const R = C.robots;
    if (R) robots.slice(0, 2).forEach((r, p) => {
        const n = r.char * 4 + 2 * ((r.costume ?? p) & 1);
        R.rows[p].forEach((row, j) => copy(row, rom.mainCpuView.getUint32(R.table + (n + j) * 4, true)));
    });
    return out;
}

/*
 * Sega Rally's tables, made by running the game's own routines rather than a
 * port of them: js/i960.js runs each entry in `i960.run` against a bus of the
 * program ROM, its copy in RAM, a zeroed work RAM and the two colour RAMs, and
 * the tables are what they leave behind.
 *
 * The boot copies program ROM 0x1000..0x61000 to RAM 0x5A0000 and runs it
 * there (`i960.copy`). 0x5A2C80 (ROM 0x3C80) builds colorxlat's 32 rows with
 * float arithmetic and a gamma, and 0x5A3350 (0x4350) lays rows out of a
 * keyframe table over them; 0x5A3590 (0x4590) writes luma RAM, a byte every
 * four bytes from 0x12800000 (MAME's model2o/2a map, umask 0xff). Both tables
 * came out byte for byte as m2-hle2's board holds them in the attract mode,
 * and neither changes from course to course. The routines take about 220,000
 * instructions between them, once per ROM set.
 *
 * Virtua Striker (Model 2B) runs from its program ROM, so there is no `copy`.
 * Its routines read tables out of the data ROM (mapped at 0x2000000) and the
 * test menu's MONITOR setting out of backup RAM 0x1D00000, which the boot
 * also copies into work RAM: `settings` are the addresses that get the
 * panel's cabinet choice (0 PROJECTER, 1 CRT). Its luma RAM is the 2B board's,
 * a byte every halfword from 0x11400000 (`board: '2b'`), which is the layout a
 * dump has, so it is stored as it is written. The palette RAM the routines
 * leave is kept too: the face palette is read out of it (i960Palette).
 *
 * INDY 500's change with the course: an entry may be [entry, ...args], an
 * argument of 'set' standing for the colour set asked for (0x2DE70's g0, the
 * course; see js/games.js indy500). The tables are kept per set and setting.
 */
const COLOR_RAM = 0x01800000;
const COLOR_RAM_BYTES = 0x20000;
const LUMA_RAM = 0x12800000;
const LUMA_RAM_2B = 0x11400000;
const BACKUP_RAM = 0x01d00000;
const BACKUP_BYTES = 0x4000;
function runColorRoutines(rom, colorSet = 0) {
    const C = rom.game.colors.i960;
    const setting = rom.cabinet ?? rom.game.colors.cabinet ?? 0;
    const set = C.sets ? Math.min(Math.max(colorSet | 0, 0), C.sets - 1) : 0;
    const key = `${setting}:${set}`;
    rom.i960Colors ??= new Map();
    if (rom.i960Colors.has(key)) return rom.i960Colors.get(key);
    const prog = rom.maincpu;
    /* Manx TT and Virtua Striker run their colour routines straight out of
     * the ROM: no `copy`. */
    const ram = new Uint8Array(0x100000);
    if (C.copy) {
        const [from, to, at] = C.copy;
        ram.set(prog.subarray(from, to), at - 0x500000);
    }
    /* Luma RAM: Model 2A's a byte every four bytes from 0x12800000, 2B's and
     * 2C's (0x11400000, umask 0x00ff) one every two: `lumaRam`, `lumaStep`. */
    const lumaRam = C.lumaRam ?? LUMA_RAM;
    const lumaStep = C.lumaStep ?? 4;
    const work = new Uint8Array(0x40000);
    const pal = new Uint8Array(COLOR_RAM_BYTES);
    const luma = new Uint8Array(LUMA_BYTES);
    const backup = new Uint8Array(BACKUP_BYTES);
    const data = rom.mainData;
    const b2 = C.board === '2b';
    const where = (a) => {
        if (a < prog.length) return [prog, a];
        if (a >= 0x200000 && a < 0x240000) return [work, a - 0x200000];
        if (a >= 0x500000 && a < 0x600000) return [ram, a - 0x500000];
        if (a >= COLOR_RAM && a < COLOR_RAM + COLOR_RAM_BYTES) return [pal, a - COLOR_RAM];
        if (a >= BACKUP_RAM && a < BACKUP_RAM + BACKUP_BYTES) return [backup, a - BACKUP_RAM];
        if (b2 && a >= LUMA_RAM_2B && a < LUMA_RAM_2B + LUMA_BYTES) return [luma, a - LUMA_RAM_2B];
        if (a >= MAIN_DATA_BASE && a < MAIN_DATA_BASE + data.length) return [data, a - MAIN_DATA_BASE];
        throw new Error(`colour routine read 0x${a.toString(16)}`);
    };
    const read = (a, n) => {
        const [b, o] = where(a);
        let v = 0;
        for (let k = n - 1; k >= 0; k--) v = (v << 8) | b[o + k];
        return v >>> 0;
    };
    const write = (a, v, n) => {
        /* One byte lane of a 32-bit unit, stored here as the even byte of a
         * halfword the way a luma dump has it (buildLumaram). */
        if (!b2 && a >= lumaRam && a < lumaRam + (LUMA_BYTES / 2) * lumaStep) {
            luma[Math.floor((a - lumaRam) / lumaStep) * 2] = v & 0xff;
            return;
        }
        const [b, o] = where(a);
        if (b === prog || b === data) throw new Error(`colour routine wrote ROM 0x${a.toString(16)}`);
        for (let k = 0; k < n; k++) b[o + k] = (v >>> (8 * k)) & 0xff;
    };
    for (const [at, n] of C.settings ?? []) write(at, setting, n);
    const cpu = new I960({
        read8: (a) => read(a, 1), read16: (a) => read(a, 2), read32: (a) => read(a, 4),
        write8: (a, v) => write(a, v, 1), write16: (a, v) => write(a, v, 2), write32: (a, v) => write(a, v, 4),
    });
    /* An entry is a routine's address, or [address, g0, g1, ...]; an
     * argument of 'set' stands for the colour set asked for. */
    for (const step of C.run) {
        const [entry, ...args] = [step].flat();
        const g = args.map((v) => (v === 'set' ? set : v));
        if (!cpu.call(entry, g, { maxSteps: 4_000_000 })) throw new Error(`colour routine 0x${entry.toString(16)} did not return`);
    }
    const cxlat = pal.slice(0x10000, 0x10000 + CXLAT_BYTES);
    const out = { cxlat, luma, pal };
    rom.i960Colors.set(key, out);
    return out;
}

/**
 * The face palette a game's own colour routines leave in palette RAM 0x1802000
 * (runColorRoutines), as 1024 BGR555 colours.
 *
 * @param {object} rom loaded ROM set
 * @returns {Int32Array} 1024 colours
 */
export function i960Palette(rom) {
    const { pal } = runColorRoutines(rom);
    const out = new Int32Array(1024);
    for (let i = 0; i < 1024; i++) out[i] = pal[0x2000 + i * 2] | (pal[0x2001 + i * 2] << 8);
    return out;
}

/*
 * Virtua Cop's 0x43B0, run on the fresh ramp before the band goes over it:
 * rows 1..31, luma 1..63, every entry whose red is not zero and at most `top`
 * gains `add` in each channel. The test is on red alone, and the channels are
 * 16-bit words, so a green or blue below what is taken off wraps as it does
 * on the board.
 */
function shiftRamp(cxlat, { top, add }) {
    const view = new DataView(cxlat.buffer, cxlat.byteOffset, cxlat.byteLength);
    for (let row = 1; row < 32; row++) {
        for (let luma = 1; luma < 64; luma++) {
            const at = row * CXLAT_ROW + luma * 2;
            const red = view.getUint16(at, true) & 0xff;
            if (red === 0 || red > top) continue;
            for (let ch = 0; ch < 3; ch++) {
                const o = ch * CXLAT_CHANNEL + at;
                view.setUint16(o, (view.getUint16(o, true) + add[ch]) & 0xffff, true);
            }
        }
    }
}

/*
 * Virtua Cop 2's 0x168B8, run on the fresh ramp before the band: rows 1..31,
 * luma 1..63, the low byte of each channel gains add[ch], held at 0xFF. A
 * 0xFFFF entry keeps its 0xFF.
 */
function liftRamp(cxlat, add) {
    for (let row = 1; row < 32; row++) {
        for (let luma = 1; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) {
                const o = ch * CXLAT_CHANNEL + row * CXLAT_ROW + luma * 2;
                cxlat[o] = Math.min(cxlat[o] + add[ch], 0xff);
            }
        }
    }
}

/* Sixteen colours a row, 32 rows, over luma 48..63 (Virtua Cop's 0x4170).
 * Blue's low bit is bit 14 there and bit 15 in Virtua Cop 2's (0x16758). */
function writeBand(md, band, set, blueBit = 14) {
    for (let row = 0; row < 32; row++) {
        for (let i = 0; i < GROUP_COLORS; i++) {
            const o = band + (row * GROUP_COLORS + i) * 2;
            const c = md[o] | (md[o + 1] << 8);
            for (let ch = 0; ch < 3; ch++) {
                const v = (((c >> (4 * ch)) & 0xf) << 1) | ((c >> (ch === 2 ? blueBit : 12 + ch)) & 1);
                set(ch, row, PALETTE_LUMA0 + i, v << 3);
            }
        }
    }
}

/* ---- send_tex_col_part and send_tex_col_skin: whoever is on screen ----
 * A character at or past the split indexes a second table with the split
 * taken off — 26 in one game, 13 in the other, each the `subo` the routine
 * does right after comparing the character number at +0x1B0. */
function sendFighterColors(dv, put, rgb, C, fighters, palette) {
    const { add, mul } = C;
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
 *                                  first — whose part and skin rows to write
 *                                  (Dead or Alive: {char, costume} records).
 *                                  An empty list leaves those rows at zero,
 *                                  which is what a scene with no fighter in it
 *                                  shows: no stage model names one.
 * @returns {Uint8Array} CXLAT_BYTES, laid out like a dump of 0x01810000
 */
export function buildColorxlat(rom, { colorSet = 0, tint = [1, 1, 1], fighters = [] } = {}) {
    if (rom.game.colors.airwlkrs) return buildAirwlkrsColorxlat(rom, colorSet);
    if (rom.game.colors.lastbrnx) return buildLastbrnxColorxlat(rom, colorSet, fighters);
    if (rom.game.colors.powsled) return buildPowsledColorxlat(rom);
    if (rom.game.colors.pltkids) return buildPltkidsColorxlat(rom, colorSet);
    /* Motor Raid: its boot and scene routines, run (js/motoraid.js). */
    if (rom.game.colors.motoraid) return motoraidScene(rom, colorSet).cxlat.slice();
    if (rom.game.colors.gunblade) return buildGunbladeColorxlat(rom, colorSet);
    if (rom.game.colors.zerogun) return buildZerogunColorxlat(rom);
    if (rom.game.colors.skytargt) return buildSkytargtColorxlat(rom, colorSet);
    if (rom.game.colors.skisuprg) return buildSkisuprgColorxlat(rom, colorSet);
    if (rom.game.colors.waverunr) return buildWaverunrColorxlat(rom, colorSet);
    if (rom.game.colors.topskatr) return buildTopskatrColorxlat(rom, colorSet);
    if (rom.game.colors.bel) return buildBelColorxlat(rom);
    /* Dynamite Cop's ramps are the stage's, whichever of its sets is asked for. */
    if (rom.game.dynamcop) return buildCurveColorxlat(rom, dynamcopScene(rom, colorSet).stage);
    if (rom.game.colors.curve) return buildCurveColorxlat(rom, colorSet);
    if (rom.game.colors.ramp) return buildRampColorxlat(rom, colorSet);
    if (rom.game.colors.doa) return buildDoaColorxlat(rom, colorSet, fighters);
    if (rom.game.colors.von) return buildVonColorxlat(rom, colorSet, fighters);
    if (rom.game.colors.i960) return runColorRoutines(rom, colorSet).cxlat.slice();
    if (rom.game.colors.dynabb) return dynabbColors(rom, colorSet).cxlat.slice();
    const dv = rom.mainDataView;
    const C = rom.game.colors;
    const out = new Uint8Array(CXLAT_BYTES);
    const rgb = tint.map((t) => Math.round(t * TINT_UNITY));
    const add = C.add, mul = C.mul;

    const put = cxlatWriter(out);
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

    sendFighterColors(dv, put, rgb, C, fighters, palette);

    return out;
}

/* ---- Air Walkers ---------------------------------------------------------- */

/*
 * Air Walkers' colorxlat, all of it out of the program ROM.
 *
 * 0x1B9E0, once at boot, writes all 32 rows with the same value in the three
 * channels. Luma 1..64 of row r run v = (6r + r/6 + 64) * luma >> 6 (row 0
 * stays 0), floored at r (the byte table at 0x1B9C0 is 0..31); the last value
 * fills the other 192 entries.
 *
 * 0x1BAD0 (table, slot) then lays 64 RGB byte triples over luma 0..63 of one
 * row: slot k is row 1 + 2k (the halfword offsets at 0xF17F0). 0x1BB90 lays
 * a run of them, a count byte and then the tables, over slots 0, 1, 2 and on:
 * boot sends 15 from 0x41F0 (0x1B5DC) and the title 10 from 0x4D31 (0x256AC).
 * The stage set-up at 0x247D0 then sends five of the stage's tables, 0xC0
 * apart from `ld 0xD440[stage*4]`, to the slots `ld 0xF1980..0xF1990` name;
 * five fixed ones (0x4731 on, slots 7..11); and the variant's two
 * (`ld 0xD484[v*4]` to slot 0, `ld 0xD494[v*4]` to slot 14). 0x1F0E0 sends a
 * team's, `ld 0x11A64[n*4]`, to slot 5 for the home side's numbers 0..16 or
 * slot 6 for the away side's 17..33. The other side's slot keeps the title's.
 *
 * `colorSet` is the team, or the profile's `titleSet` for the intro's and the
 * title's colours, the two runs alone. A home team's number is its court too:
 * the match set-up (0xD048C) takes the court from the home side's team and the
 * variant from byte +12 of the team's record (`0xFBA80 + 20 * team`). The away
 * side's numbers keep the profile's court and variant.
 */
function buildAirwlkrsColorxlat(rom, colorSet) {
    const A = rom.game.colors.airwlkrs;
    const cv = rom.mainCpuView;
    const cpu = rom.maincpu;
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);

    for (let row = 0; row < 32; row++) {
        const k = row ? 6 * row + Math.trunc(row / 6) + 0x40 : 0;
        let v = 0;
        for (let luma = 1; luma <= 64; luma++) {
            v = Math.max((k * luma) >> 6, cpu[A.floor + row]);
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma - 1, v);
        }
        for (let luma = 64; luma < 256; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
    }

    const send = (src, slot) => {
        if (!src || src + 192 > cpu.length) return;
        const row = cv.getUint16(A.slots + slot * 2, true) / CXLAT_ROW;
        for (let luma = 0; luma < 64; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, cpu[src + luma * 3 + ch]);
        }
    };
    const run = (at) => {
        for (let k = 0; k < cpu[at]; k++) send(at + 1 + k * 192, k);
    };
    for (const at of A.runs) run(at);
    /* The intro and the title stop there: nothing else is sent until a
     * court is set up. */
    if (colorSet === A.titleSet) return out;
    const home = colorSet >= 0 && colorSet < A.teamCount / 2;
    const stage = home ? colorSet : A.stage ?? 0;
    const variant = home ? cpu[rom.game.airwlkrs.teams + colorSet * 20 + 12] : A.variant ?? 0;
    const base = cv.getUint32(A.stages + stage * 4, true);
    for (let i = 0; i < 5; i++) send(base + i * 0xc0, cv.getUint32(A.stageSlots + i * 4, true));
    for (const [src, slot] of A.fixed) send(src, slot);
    send(cv.getUint32(A.variants[0] + variant * 4, true), 0);
    send(cv.getUint32(A.variants[1] + variant * 4, true), 14);
    if (colorSet >= 0 && colorSet < A.teamCount) {
        send(cv.getUint32(A.teams + colorSet * 4, true), colorSet > 16 ? 6 : 5);
    }
    return out;
}

/* ---- Last Bronx ----------------------------------------------------------- */

/*
 * Last Bronx's colorxlat, worked out by its program out of the test menu's
 * colour settings and keyframed tables in its data section (RAM 0x500000 on,
 * a copy of the program ROM from `data.rom`).
 *
 * The settings are nine (add, multiply) pairs, the defaults at `settings`
 * that a machine with empty backup RAM copies to 0x56CBEB. Each makes a
 * 256-entry table (0x90D0): 0 at 0, then min(255, add + (mul * i >> 6)).
 * Pairs 0..2 are the red, green and blue of the ramps, 3..5 of the flat band.
 *
 * - 0x6D40, every row r: luma l of 0..63 takes entry
 *   (0x1F80 + l * (r * 0xFF00 / 31)) / 0x3F00 of the channel's ramp table.
 * - 0x6DF0, every row: luma 64..127 takes entry ((r * 0xFF00 / 31) + 0x80) >> 8
 *   of the channel's flat table.
 * - 0x92D0 (slot, table) then lays luma 0..63 of row 1 + 2 * (slot >> 1) out
 *   of a table of keyframes: a float count, then (position, red, green, blue)
 *   floats. Luma i reads the colour at i / 64 between the two keyframes about
 *   it, times 255, through the channel's ramp table. Single precision, as
 *   the board's FPU works it.
 * - The stage's five go to rows 1, 3, 5, 7 and 9 (0x9590), from the list the
 *   stage's entry of 0x504310 names: its destination list is the j-th of 0x20
 *   bytes from 0x5534D0 and its source list `ld 0x502AA0[j*8]`.
 * - The two common ones, `ld 0x502A08`, go to rows 11 and 13 (0x9620).
 * - A fighter's four (0x94E0) go to rows 15..21 for player 1 and 23..29 for
 *   player 2, from the fighter record's list for its costume (+0x20, +0x24):
 *   the j-th of 0x10 bytes from 0x5533B0, sources `ld 0x502A10[j*8]`.
 *
 * A null entry sends nothing and the row keeps its ramp. Checked against
 * MAME's colorxlat on the attract's fights: no entry differs.
 */

/*
 * What a Last Bronx set stands for. Sets 0..8 are the stages, with `fighters`
 * ({char, costume} records, player 1 first) or, none given, the attract's
 * first fight. The sets past them are a fighter alone, 2 * char + costume on
 * from `stages`, on both sides of the default stage: a lone part is drawn
 * with its own page and colours whichever side's copy it is.
 */
export function lastbrnxScene(rom, set, fighters) {
    const T = rom.game.texture;
    if (set >= T.raw.stages && set < T.sets) {
        const f = { char: (set - T.raw.stages) >> 1, costume: (set - T.raw.stages) & 1 };
        return { stage: T.defaultSet, fighters: [f, f] };
    }
    const stage = set >= 0 && set < T.raw.stages ? set : T.defaultSet;
    return { stage, fighters: fighters?.length ? fighters : T.raw.fighters };
}

function buildLastbrnxColorxlat(rom, colorSet, wanted) {
    const B = rom.game.colors.lastbrnx;
    const { stage: s, fighters: who } = lastbrnxScene(rom, colorSet, wanted);
    const cv = rom.mainCpuView;
    const len = rom.maincpu.length;
    const ram = (a) => a - B.data.ram + B.data.rom;
    const word = (a) => (a + 4 <= len ? cv.getUint32(a, true) : 0);
    const out = new Uint8Array(CXLAT_BYTES);
    const put = cxlatWriter(out);

    const lut = [];
    for (let k = 0; k < 9; k++) {
        const add = cv.getUint8(B.settings + k * 2), mul = cv.getUint8(B.settings + k * 2 + 1);
        const t = new Uint16Array(256);
        for (let i = 1; i < 256; i++) t[i] = Math.min(255, add + ((mul * i) >> 6));
        lut.push(t);
    }

    for (let r = 0; r < 32; r++) {
        const step = Math.trunc((r * 0xff00) / 31);
        for (let l = 0, g = 0x1f80; l < 64; l++, g += step) {
            const i = Math.trunc(g / 0x3f00);
            for (let ch = 0; ch < 3; ch++) put(ch, r, l, lut[ch][i]);
        }
        const i = (Math.trunc((r * 255 * 256) / 31) + 0x80) >> 8;
        for (let l = 64; l < 128; l++) {
            for (let ch = 0; ch < 3; ch++) put(ch, r, l, lut[3 + ch][i]);
        }
    }

    const F = Math.fround;
    const send = (slot, table) => {
        if (!table) return;
        const at = ram(table);
        if (at < 0 || at + 4 > len) return;
        const n = Math.trunc(cv.getFloat32(at, true));
        if (n < 2 || at + 4 + n * 16 > len) return;
        const key = (k) => [0, 1, 2, 3].map((j) => cv.getFloat32(at + 4 + k * 16 + j * 4, true));
        const row = 1 + 2 * (slot >> 1);
        let cur = key(0), next = key(1), k = 2;
        for (let i = 0; i < 64; i++) {
            const x = F(i / 64);
            while (x > next[0] && k < n) { cur = next; next = key(k++); }
            const t = F(F(x - cur[0]) / F(next[0] - cur[0]));
            for (let ch = 0; ch < 3; ch++) {
                const v = Math.trunc(F(F(F(F(next[1 + ch] - cur[1 + ch]) * t) + cur[1 + ch]) * 255));
                put(ch, row, i, lut[ch][Math.max(0, Math.min(255, v))]);
            }
        }
    };
    const list = (at, count) => Array.from({ length: count }, (_, k) => word(at + k * 4));
    const lists = (L, dst) => {
        const j = (dst - L.dst) / L.size;
        if (!Number.isInteger(j) || j < 0) return [];
        return list(ram(word(ram(L.pairs + j * 8))), L.count);
    };

    lists(B.stageLists, word(ram(B.stages) + s * 4)).forEach((t, k) => send(2 * k + 1, t));
    list(ram(B.common), 2).forEach((t, k) => send(2 * k + 11, t));
    who.slice(0, 2).forEach((one, p) => {
        const f = typeof one === 'number' ? { char: one } : one;
        if (!f || !(f.char >= 0 && f.char < B.charCount)) return;
        const dst = word(B.chars + f.char * 128 + 0x20 + 4 * (f.costume ?? 0));
        lists(B.fighterLists, dst).forEach((t, k) => send(0x17 + 2 * k - (p ? 0 : 8), t));
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
    const put = cxlatWriter(out);
    const f = Math.fround;
    const cap = (v) => Math.min(Math.trunc(v), 255);
    /* ½√v + ½v²: the square root and its half in single, the square in double,
     * the sum rounded back to single. Dynamite Cop weighs it a√v + (1-a)v²,
     * with a read from its program ROM: 0.85 for the rows, 0.7 for the luma. */
    const weight = (k) => (C.curve.weights ? f(cv.getFloat32(C.curve.weights + k * 4, true)) : 0.5);
    const [aRow, aLuma] = [weight(1), weight(0)];
    const curve = (v, a) => f(f(f(Math.sqrt(v)) * a) + (v * (1 - a)) * v);

    for (let row = 0; row < 32; row++) {
        const y = curve(f(((row << 3) + (row >> 2)) / 255), aRow);
        for (let luma = 0; luma < 64; luma++) {
            const v = cap(f(curve(f(y * f(luma / 63)), aLuma) * 255));
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, v);
        }
        const flat = cap(f(y * 255));
        for (let luma = 64; luma < 256; luma++) {
            for (let ch = 0; ch < 3; ch++) put(ch, row, luma, flat);
        }
    }

    const { ptrs, rows, row0, step, gain, shared = 0 } = C.curve.sets;
    const table = colorSet >= 0 ? cv.getUint32(ptrs + colorSet * 4, true) : 0;
    /* Dynamite Cop takes its first `shared` ramps from set 0's list, which boot
     * loads (0x70810), and the rest from the stage's (0x70CA0); it has no gain. */
    const boot = shared ? cv.getUint32(ptrs, true) : 0;
    if (table && table + rows * 4 <= rom.maincpu.length) {
        const g = gain ? f(cv.getFloat32(gain, true)) : 1;
        for (let r = 0; r < rows; r++) {
            const src = cv.getUint32((r < shared ? boot : table) + r * 4, true);
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
    const put = cxlatWriter(cxlat);
    const rgb = tint.map((t) => Math.round(t * TINT_UNITY));

    const C = rom.game.colors;
    const table = colorTable(dv, C.stage);
    const group = table + C.stage.block * colorSet + GROUP_STRIDE * (row - C.stage.row0);
    for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < GROUP_COLORS; i++) {
            const src = dv.getUint16(group + ch * GROUP_CHANNEL + ((phase + i) & 15) * 2, true);
            put(ch, row, PALETTE_LUMA0 + i, intensity(src, rgb[ch], C.add[ch], C.mul[ch]));
        }
    }
}
