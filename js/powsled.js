/*
 * powsled.js — Power Sled's model list.
 *
 * The game has no model table. A model is the three words the geometry
 * engine's object command takes, texture point address, texture header
 * address and object address (MAME model2_v.cpp geo_object_data), and the
 * program hands them over from three kinds of place:
 *
 * - 64-byte placement records in the data ROM: the three words, a zero, then a
 *   3x4 float matrix. The grid at data 0x4770 is {ptr, 33, 33 offsets} of
 *   them, read by 0xE47AC through 0xE1F30; there are longer runs at 0x40534,
 *   0xEDD98, 0x13E240, 0x18E6E8, 0x1DEF68 and 0x285CA4.
 * - 28-byte named records in the program ROM, about 0xD8EA0..0xE19E8: two
 *   words, the three words, a zero and a pointer to a name such as
 *   HONBAN_sce2_course_N_4_1_0.
 * - Immediates in the code: `lda tpa,g6 ; st g6,0x804000 ; lda d(g6),g6 ;
 *   st ; lda oba,g6 ; st`, the FIFO stores at 0xE3F9C and the routines round
 *   it. A model with no texture stores g6 twice, so its header is its point
 *   address.
 *
 * What is listed is every distinct triple those three hold, in mesh order. A
 * frame's display list from m2-hle2 (bufferram, the 0x00800101 commands) names
 * nothing that is not here.
 */

/* An object address with bit 23 set is a word index into the polygon ROM. */
const POLY_BIT = 0x00800000;
/* The texture ROM is 4M halfwords. A model's material block follows its point
 * block, and none is more than 0xD84 words on; a wider gap is two words that
 * only look like a pair. */
const TEX_WORDS = 0x400000;
const MAT_SPAN = 0x1000;

/* i960 words: `lda <32-bit>, reg` (MEMB, absolute), `st reg, <32-bit>` and
 * `lda off(reg), reg` (MEMA, offset plus base). */
const isLdaLiteral = (w) => (w & 0xff003fff) >>> 0 === 0x8c003000;
const isStore = (w) => w >>> 24 === 0x92;
const isLdaOffset = (w) => w >>> 24 === 0x8c && (w & 0x3000) === 0x2000;
const FIFO = 0x00804000;

/** Where the polygon ROM's data ends, in words: it is padded with 0xFF. */
function polygonWords(rom) {
    const p = rom.polygons;
    let end = p.length;
    while (end > 0 && p[end - 1] === 0xff) end--;
    return Math.ceil(end / 4);
}

/**
 * Every model the program can draw, as {uvPtr, matPtr, meshPtr}, sorted by
 * mesh and then texture.
 */
export function powsledModels(rom) {
    const words = polygonWords(rom);
    const isMesh = (o) => (o & 0xff800000) >>> 0 === POLY_BIT && (o & 0x7fffff) < words;
    const seen = new Map();
    const add = (u, m, o) => {
        const key = `${u}/${m}/${o}`;
        if (!seen.has(key)) seen.set(key, { uvPtr: u, matPtr: m, meshPtr: o });
    };

    /* Records: the three words side by side, in either ROM. */
    for (const bytes of [rom.mainData, rom.maincpu]) {
        const w = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
        for (let i = 0; i + 2 < w.length; i++) {
            const u = w[i], m = w[i + 1], o = w[i + 2];
            if (isMesh(o) && u > 0 && u <= m && m < TEX_WORDS && m - u < MAT_SPAN) add(u, m, o);
        }
    }

    /* Immediates: walk back from each `lda oba` that is followed by its store. */
    const w = new Uint32Array(rom.maincpu.buffer, rom.maincpu.byteOffset, rom.maincpu.length >> 2);
    const st = (k) => w[k] === FIFO && isStore(w[k - 1]);
    for (let k = 9; k < w.length; k++) {
        if (!isMesh(w[k]) || !isLdaLiteral(w[k - 1]) || !st(k - 2)) continue;
        if (isLdaOffset(w[k - 4]) && st(k - 5) && isLdaLiteral(w[k - 8])) {
            add(w[k - 7], w[k - 7] + (w[k - 4] & 0xfff), w[k]);
        } else if (st(k - 4) && isLdaLiteral(w[k - 7])) {
            add(w[k - 6], w[k - 6], w[k]);
        }
    }

    return [...seen.values()].sort((a, b) => a.meshPtr - b.meshPtr || a.uvPtr - b.uvPtr || a.matPtr - b.matPtr);
}
