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

/*
 * Where a texel is in texture RAM: the byte offset of the halfword holding its
 * 2x2 block, from its place in the atlas (y >= SHEET_H is sheet 1, at
 * SHEET_BYTES). The one statement of the fold: texture.js writes the sheets
 * through it and buildAtlas reads them back through it.
 */
export function texelByte(x, y) {
    const sheet = y >= SHEET_H ? 1 : 0;
    y -= sheet * SHEET_H;
    if (x >= 1024) { x -= 1024; y ^= 1024; }
    return sheet * SHEET_BYTES + (y >> 1) * 0x400 + (x >> 1) * 2;
}

/*
 * Where level L of the mip chain keeps the texel at (x, y), in atlas space:
 * ((x - 2048) >> L) & 2047 across and ((y - 1024) >> L) & 1023 down, on the
 * sheet that alternates with L (model2rd.ipp fetch_bilinear_texel). At L = 0
 * that is the texel itself. The arithmetic is unsigned because the board's
 * is: the subtraction wraps, and that wrap is what puts the mips where they
 * are. texture.js writes the mips through this, and the fill shader reads them
 * through the same arithmetic in GLSL (levelTile in js/viewer.js), so the two
 * cannot disagree about where a level is; change them together.
 */
export function levelOrigin(x, y, L) {
    const sheet = y >= SHEET_H ? 1 : 0;
    return {
        x: ((x - ATLAS_W) >>> L) & (ATLAS_W - 1),
        y: (((y - sheet * SHEET_H - SHEET_H) >>> L) & (SHEET_H - 1)) + ((sheet + L) & 1) * SHEET_H,
    };
}

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
            /* The fold moves whole half-rows, so it is taken once for each. */
            const left = texelByte(0, y), right = texelByte(1024, y);
            for (let x = 0; x < ATLAS_W; x++) {
                const off = (x < 1024 ? left + x : right + x - 1024) & ~1;
                let word = words[off >> 2];
                if (off & 2) word >>>= 16;
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
    const c5 = split555(bgr555);
    if (!hasCxlat(cxlat)) return c5.map((v) => v / 31);
    return c5.map((v, ch) => Math.max(cxlatAt(cxlat, ch, v) - 64, 0) * (255 / 191) / 255);
}

const split555 = (bgr555) => [bgr555 & 0x1f, (bgr555 >> 5) & 0x1f, (bgr555 >> 10) & 0x1f];
const hasCxlat = (cxlat) => cxlat && cxlat.length >= 0xc000;
/* Channel bases are 0x0000 / 0x4000 / 0x8000 in bytes; the index within a
 * channel is (c5 << 8) + luma, in 16-bit units, and a palette colour reads
 * luma 0x40. */
const cxlatAt = (cxlat, ch, c5) => cxlat[ch * 0x4000 + (((c5 << 8) + 0x40) * 2)];

/* The same, as the bytes MAME's pen gets: its gamma table is u8, so the value
 * is floored rather than rounded. For an image built pixel by pixel out of
 * palette colours — the scroll layer's sky — where a capture can be compared
 * with it exactly.
 *
 * @returns {[number, number, number]} components in 0..255
 */
export function palette555ToBytes(cxlat, bgr555) {
    const c5 = split555(bgr555);
    if (!hasCxlat(cxlat)) return c5.map((v) => Math.round(v * 255 / 31));
    return c5.map((v, ch) => Math.floor(Math.max(cxlatAt(cxlat, ch, v) - 64, 0) * 255 / 191));
}
