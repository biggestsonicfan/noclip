/*
 * jaleco.js — Jaleco's Model 2B/2C racers, Super GT 24h (1996) and Over Rev
 * (1997), built on one framework: the same "../h/globl.h" and "define.h"
 * fault strings, the same model table export (16-byte entries, then a list of
 * 0x1C-stride pointers into data 0x800000), and the same texture loader,
 * which is what this file is.
 *
 * Nothing is packed. A loader (sgt24h 0x5A2B0 for sheet 0 and 0x5A470 for
 * sheet 1, Over Rev 0x120F0 and 0x122B0) takes a data ROM address and blits
 * (sgt24h 0x5A630, Over Rev 0x12470) its first 0x80000 bytes, 512 by 512
 * halfwords, to the sheet's first half, then the next 0x80000 bytes as ten
 * mip rectangles split between the two sheets' second halves, 0x11080000 and
 * 0x11280000 (sheet 1's loader the other way round from sheet 0's), so the two
 * chains interleave. The blit's source offset is its destination offset, a
 * row of 512 halfwords; its loop (`cmpible`) copies one 16-byte quad past
 * each row's end, and on the Model 2B, where 0x11100000 mirrors 0x11000000,
 * a quad past the end of a sheet lands at its start. After it the loader sets
 * the first eight halfwords of 0x11000000 to 0xFFFF.
 *
 * Over Rev first runs 0x12080, which copies the data ROM's first 0x100000
 * halfwords to 0x11000000 a halfword every four bytes, through all four MB
 * of the two sheets and their mirrors. The loads go over most of it; what
 * they leave shows.
 *
 * Checked against MAME's texture RAM: Super GT 24h in the attract (frames
 * 300 to 2700, set 0) and Over Rev on both boards at the title (sheet 0 and
 * the fill only) and in the attract race (data 0x200000 on sheet 1), no
 * halfword different but sixteen bytes Over Rev's attract writes over the
 * start of sheet 0 and at sheet 1 0xC0000 later, by code not traced.
 */

const SHEET_BYTES = 0x100000;
const ROW = 0x400;                    /* 512 halfwords */
const HALF = 0x80000;
const MAIN_DATA_BASE = 0x02000000;

/* [quarter, x0, y0, x1, y1] for sheet 0's loader; A is 0x11080000 (sheet 0's
 * second half) and B 0x11280000. Sheet 1's loader swaps A and B. */
const A = 0, B = 1;
const MIPS = [
    [A, 0, 0, 511, 255], [B, 0, 256, 255, 511], [B, 256, 256, 511, 383], [A, 256, 384, 383, 511],
    [A, 384, 384, 511, 447], [B, 384, 448, 447, 511], [B, 448, 448, 511, 479], [A, 448, 480, 479, 511],
    [A, 480, 480, 511, 495], [B, 480, 496, 511, 511],
];

/* `window` is how far a write can run before it wraps: the 2B's 1 MB sheet
 * (the mirror), the 2C's 2 MB share, of which the renderer reads the first. */
function blit(md, src, sheet, base, [x0, y0, x1, y1], window) {
    const n = ((((x1 + 1 - x0) * 2) >> 4) + 1) << 4;
    for (let y = y0; y <= y1; y++) {
        const o = (y * 512 + x0) * 2;
        for (let k = 0; k < n; k++) {
            const at = (base + o + k) % window;
            if (at < SHEET_BYTES && src + o + k < md.length) sheet[at] = md[src + o + k];
        }
    }
}

function load(md, sheets, src, which, window) {
    blit(md, src, sheets[which], 0, [0, 0, 511, 511], window);
    for (const [q, ...rect] of MIPS) {
        blit(md, src + HALF, sheets[which ? q ^ 1 : q], HALF, rect, window);
    }
    sheets[0].fill(0xff, 0, 16);
}

/**
 * Texture RAM with set `texSets` (the last one named) on sheet 1.
 * `raw`: {sheet0, sets: [data address for sheet 1 by set], fill, window}.
 */
export function buildJalecoTexram(rom, texSets) {
    const raw = rom.game.texture.raw;
    const md = rom.mainData;
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < raw.sets.length);
    const set = sets.length ? sets[sets.length - 1] : rom.game.texture.defaultSet;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const sheets = [tex.subarray(0, SHEET_BYTES), tex.subarray(SHEET_BYTES)];
    const window = raw.window ?? SHEET_BYTES;
    if (raw.fill) {
        /* 0x12080: halfword i to 0x11000000 + 4i, i of 0..0xFFFFF. */
        for (let i = 0; i < 0x100000; i++) {
            const a = i * 4;
            const s = a >= 0x200000 ? 1 : 0;
            const at = (a & 0x1fffff) % window;
            if (at < SHEET_BYTES) {
                sheets[s][at] = md[i * 2];
                sheets[s][at + 1] = md[i * 2 + 1];
            }
        }
    }
    load(md, sheets, raw.sheet0 - MAIN_DATA_BASE, 0, window);
    load(md, sheets, raw.sets[set] - MAIN_DATA_BASE, 1, window);
    return { sheet0: sheets[0], sheet1: sheets[1], pages: 2 };
}
