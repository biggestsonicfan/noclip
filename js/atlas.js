/*
 * atlas.js — build the texture atlas and colour LUTs from a texture-RAM dump.
 *
 * The board's texture sheets do not exist in ROM in a form this viewer can
 * read: the game unpacks them into texture RAM on every scene change
 * (unp_send_tex_para -> unpack_lod_data, a custom Huffman codec). What this
 * module takes is the *result* — a dump of that RAM — and turns it into the
 * textures the fill shader samples.
 *
 * Sheet layout, per MAME's model2 get_texel: logically 2048x1024 of 4-bit luma,
 * stored 1024x2048, so x >= 1024 folds back with y ^= 1024. Each 32-bit word
 * holds a 2x2 block of nibbles picked out by the low bits of x and y. The two
 * sheets stack into one 2048x2048 atlas, sheet 0 on top.
 */

export const ATLAS_W = 2048;
export const SHEET_H = 1024;
export const ATLAS_H = 2048;
export const SHEET_BYTES = 0x100000;

/* The colour pipeline needs two more RAM tables besides the sheets: lumaram
 * (0x11400000, 0x20000 bytes) picks a brightness ramp per texel, and colorxlat
 * (0x01810000, 0xC000 bytes) turns ramp + palette colour into the final RGB. */
export const LUMA_W = 256, LUMA_H = 512;
export const CXLAT_W = 256, CXLAT_H = 192;

/**
 * @param {Uint8Array|null} sheet0
 * @param {Uint8Array|null} sheet1
 * @returns {Uint8Array} ATLAS_W * ATLAS_H single-channel texels
 */
export function buildAtlas(sheet0, sheet1) {
    const atlas = new Uint8Array(ATLAS_W * ATLAS_H);
    const sheets = [sheet0, sheet1];

    for (let s = 0; s < 2; s++) {
        const bytes = sheets[s];
        if (!bytes || bytes.length < SHEET_BYTES) continue;
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, SHEET_BYTES / 4);
        for (let y = 0; y < SHEET_H; y++) {
            const row = (s * SHEET_H + y) * ATLAS_W;
            for (let x = 0; x < ATLAS_W; x++) {
                let x2 = x, y2 = y;
                if (x2 >= 1024) { x2 -= 1024; y2 ^= 1024; }
                const off = ((y2 >> 1) * 512) + (x2 >> 1);
                let word = words[off >> 1];
                if (off & 1) word >>>= 16;
                if ((y & 1) === 0) word >>>= 8;
                if ((x & 1) === 0) word >>>= 4;
                atlas[row + x] = (word & 0xf) * 17;    /* 0..15 -> 0..255 */
            }
        }
    }
    return atlas;
}

/**
 * Sort dropped files into the four roles: name first, then size (sheets are
 * 1 MB, lumaram 128 KB, colorxlat 48 KB), then the order given.
 * @returns {{sheet0:File|null, sheet1:File|null, luma:File|null, cxlat:File|null}}
 */
export function classifyDump(files) {
    const out = { sheet0: null, sheet1: null, luma: null, cxlat: null };
    const rest = [];

    for (const f of files) {
        const name = f.name.toLowerCase();
        if (name.includes('luma') || f.size === 0x20000) {
            out.luma = out.luma || f;
        } else if (name.includes('xlat') || f.size === 0xc000) {
            out.cxlat = out.cxlat || f;
        } else if (/(?:texram|sheet)[^01]*0/.test(name)) {
            out.sheet0 = out.sheet0 || f;
        } else if (/(?:texram|sheet)[^01]*1/.test(name)) {
            out.sheet1 = out.sheet1 || f;
        } else {
            rest.push(f);
        }
    }

    for (const f of rest) {
        if (!out.sheet0) out.sheet0 = f;
        else if (!out.sheet1) out.sheet1 = f;
    }
    return out;
}

/* ---- Flat palette colours ------------------------------------------------ */

/* MAME's palette_w (model2.cpp) does not show a BGR555 value directly: it runs
 * each 5-bit component through colorxlat at luma 0x40 and then the gamma table,
 * the same path a textured face takes at full brightness. Anything the viewer
 * draws as a flat palette colour — the stage backdrop — has to go through it
 * too, or it comes out far too bright and the wrong hue.
 *
 * Gamma is m2-hle2's approximation of MAME's table: max(c - 64, 0) * 255/191.
 *
 * @param {Uint8Array|null} cxlat  colorxlat dump, or null for the raw value
 * @param {number} bgr555
 * @returns {[number, number, number]} components in 0..1
 */
export function palette555ToRGB(cxlat, bgr555) {
    const c5 = [bgr555 & 0x1f, (bgr555 >> 5) & 0x1f, (bgr555 >> 10) & 0x1f];
    if (!cxlat || cxlat.length < 0xc000) return c5.map((v) => v / 31);

    /* Channel bases are 0x0000 / 0x4000 / 0x8000 in bytes; the index within a
     * channel is (c5 << 8) + luma, in 16-bit units. */
    return c5.map((v, ch) => {
        const raw = cxlat[ch * 0x4000 + (((v << 8) + 0x40) * 2)];
        return Math.max(raw - 64, 0) * (255 / 191) / 255;
    });
}
