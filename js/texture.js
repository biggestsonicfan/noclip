/*
 * texture.js — generate the texture sheets from ROM, the way the game does.
 *
 * The sheets are not in ROM in a readable form: about 85% of the pages are
 * compressed with a custom codec, and the game unpacks them into texture RAM
 * on every scene change. m2-hle2 gets its sheets by emulating the i960 and
 * letting the game's own code do that; this is a direct port of the routines
 * that code runs, so the viewer can build the same sheets from the ROM alone.
 *
 * Ported from the Sonic The Fighters decompilation (stfdecomp, rom_code1.s):
 *
 *   unp_send_tex_para_sub  0x4AF48   walks the per-set page list
 *   sub_4C444              0x4C444   page (x, y, bank) -> texram destinations
 *   send_beta_data         0x4BC70   raw page upload
 *   unpack_lod_data        0x4B408   Huffman page -> halfword + nibble streams
 *   make_huf_8bit          0x4BBC0   8-bit fast-decode table
 *   send_lod_data          0x4BE40   halfword stream -> texram, RLE expanded
 *   send_lod_data_q        0x4BFF0   box-filter the nibble stream into the mips
 *
 * The hardware handshake those routines interleave — the coprocessor busy
 * flags at 0x550080/0x5500F4, the RAMBASE self-test, the DSP FIFO at 0x5D0000
 * and the frame-timer yields — is all resumption bookkeeping for a job spread
 * across frames. None of it changes the bytes produced, so the port runs the
 * whole set in one pass and keeps only the data path.
 *
 * Terminology note: the game's own field names call the page dimensions W and
 * H, but they count 2x2 texel blocks, not texels. A 256x256 page is W=128,
 * H=128: W rows of block-pairs, H halfwords each.
 */

import { MAIN_DATA_BASE, xtraResolve } from './romset.js';
import { courseNamedModels } from './daytona.js';
import { doaLoadId, lastbrnxScene } from './colors.js';
import { buildDynamcopTexram } from './dynamcop.js';
import { SHEET_BYTES, SHEET_H, texelByte, levelOrigin } from './atlas.js';
import { I960 } from './i960.js';

export { SHEET_BYTES };

/* Texture RAM: two 1 MB sheets, each stored 1024x2048 and read as a logical
 * 2048x1024 (x >= 1024 folds back with y ^= 1024; atlas.js has the layout).
 * One halfword is a 2x2 block of 4-bit texels, so a texel row is 512 bytes and
 * a row-pair is 0x400. */
const SHEET0 = 0;
const SHEET1 = SHEET_BYTES;
const ROW_PAIR = 0x400;


/* Symbol-space partition used when the code table is built (unpack_lod_data
 * +0x28C). Below LITERAL the symbol indexes the 256-entry ROM table; the four
 * boundaries above it select the escape, raw-literal and two run forms. */
const SYM_LITERAL = 0x100;   /* 0x000..0x0FF  ROM literal table          */
const SYM_TABLE   = 0x101;   /* 0x100         indexed literal (tag 9)    */
const SYM_RAW     = 0x102;   /* 0x101         inline literal  (tag 0xA)  */
const SYM_RUN     = 0x122;   /* 0x102..0x121  run            (tag 0xB)   */
const SYM_RUN2    = 0x142;   /* 0x122..0x141  short literal  (tag 0xD)   */
                             /* 0x142..       reference to a table node  */

/* shader_fil_test at 0x4A324: entry i is i * 0x1111, one texel value smeared
 * across all four nibbles of a halfword. Every decoded halfword is this solid
 * base plus a delta from the literal tables. */
const SOLID = new Uint16Array(16);
for (let i = 0; i < 16; i++) SOLID[i] = (i * 0x1111) & 0xffff;

/* ---- Bit reader ---------------------------------------------------------- */

/*
 * The codec's bitstream (unpack_lod_data): LSB first, refilled 16 bits at a
 * time from little-endian halfwords. The i960 keeps the buffer in r13, the
 * count in r14 and the next halfword prefetched in g11, and refills whenever
 * the count drops to 16 or below — so the buffer never needs more than 32 bits.
 */
class BitReader {
    constructor(bytes, byteOffset) {
        this.b = bytes;
        this.p = byteOffset;
        this.buf = 0;
        this.cnt = 0;
        this.cur = this._short();
        /* The routine primes the buffer with two refills before its first read. */
        this._refill();
        this._refill();
    }

    _short() {
        const v = this.b[this.p] | (this.b[this.p + 1] << 8);
        this.p += 2;
        return v;
    }

    _refill() {
        if (this.cnt <= 16) {
            this.buf = (this.buf | (this.cur << this.cnt)) >>> 0;
            this.cur = this._short();
            this.cnt += 16;
        }
    }

    /** Consume n bits (n <= 16) and return them. */
    take(n) {
        const v = this.buf & ((1 << n) - 1);
        this.cnt -= n;
        this.buf = this.buf >>> n;
        this._refill();
        return v;
    }

    /** Consume n bits without returning them — the decode loop peeks first. */
    skip(n) {
        this.cnt -= n;
        this.buf = this.buf >>> n;
        this._refill();
    }

    /** The next 8 bits, not consumed: the index into the fast-decode table. */
    peek8() { return this.buf & 0xff; }

    /** Bit i of the buffer, for the >8-bit tree walk. */
    bit(i) { return (this.buf >>> i) & 1; }
}

/* ---- Page destinations (sub_4C444) --------------------------------------- */

/*
 * Turn a page's logical (y, x) origin and bank bit into the list of texram
 * addresses its levels are written to: entry 0 is the full-size page, entries
 * 1.. are the mip chain. Each level goes where the board looks for it when it
 * samples (levelOrigin in atlas.js), so the sheets are written by the same
 * arithmetic the shader reads them with. sub_4C444 gets there by a running
 * offset from +0xC0000 instead, halving x and y to an even texel at every
 * level; that lands on the same bytes for every even origin, and a page
 * origin is always a multiple of 32.
 */
function pageDestinations(y, x, bank) {
    let sheet = pageSheet(bank);
    let first = 0;
    if ((x & 0x400) && (y & 0x200)) {
        /* An origin inside the mip area: a page with no full-size level, only
         * mips. They are the mips of the page at twice the distance on the
         * other sheet, so the chain starts at that page's level 1. */
        x = (x & ~0x400) << 1;
        y = (y & ~0x200) << 1;
        sheet ^= 1;
        first = 1;
    }
    const dest = [];
    for (let L = first; L <= 9; L++) {
        const at = levelOrigin(x, y + sheet * SHEET_H, L);
        dest.push(texelByte(at.x, at.y));
    }
    return dest;
}

/* Bank bit 0 set puts a page's full-size level on sheet 0, clear on sheet 1;
 * its mips then alternate from there. */
function pageSheet(bank) {
    return (bank & 1) ? 0 : 1;
}

/* ---- Raw pages (send_beta_data) ------------------------------------------ */

/*
 * An uncompressed page: a 3-byte header, then every level's texels already in
 * texram halfword order, 16 bytes at a time. The 16-byte group is four 32-bit
 * words whose low halves come first and high halves second — the i960 reads
 * them with a quad load and stores eight halfwords.
 */
function sendBetaData(md, ptr, tex, dest) {
    let w = md[ptr++] + 1;
    let h = md[ptr++] + 1;
    ptr += md[ptr];                     /* skip the variable-length header */
    if (ptr & 0xf) throw new Error('Send Tex Align Error!!');

    for (let level = 0; level < dest.length; level++) {
        let row = dest[level];
        w >>= 1;
        h >>= 1;
        if (w < 1 || h < 8) return;

        for (let i = 0; i < w; i++) {
            let o = row;
            row += ROW_PAIR;
            for (let g = h >> 3; g > 0; g--) {
                for (let half = 0; half < 2; half++) {
                    for (let k = 0; k < 4; k++) {
                        const s = ptr + k * 4 + half * 2;
                        tex[o] = md[s];
                        tex[o + 1] = md[s + 1];
                        o += 2;
                    }
                }
                ptr += 16;
            }
        }
    }
}

/* ---- Code table (unpack_lod_data + 0x214, make_huf_8bit) ----------------- */

/*
 * The code table is a flat array: at position p, a negative value is a leaf and
 * a non-negative one means p is a branch whose 1-child is at that position and
 * whose 0-child is at p + 1. Leaves carry a 4-bit tag in the top nibble that
 * selects how the symbol is decoded, and the payload below it.
 */
function buildCodeTable(r, nsym, symBits, lut) {
    const nodes = nsym * 2 - 1;
    const tree = new Int32Array(nodes);

    for (let i = 0; i < nodes; i++) {
        const s = r.take(symBits);
        let v;
        if (s >= SYM_RUN2) {
            v = s - SYM_RUN2;                       /* branch: child position */
        } else if (s < SYM_RAW) {
            if (s < SYM_LITERAL) {
                const e = lut[s];
                /* A literal whose low nibble is zero moves the running texel
                 * value by nothing, so it skips the accumulator update. */
                v = (e & 0xf) ? (0x80000000 | e) : (0xc0000000 | (e >>> 8));
            } else {
                v = (s === SYM_LITERAL) ? 0x90000000 : 0xa0000000;
            }
        } else if (s < SYM_RUN) {
            v = 0xb0000000 | runLength(s - SYM_RAW + 1);
        } else {
            v = 0xd0000000 | runLength(s - SYM_RUN + 1);
        }
        tree[i] = v | 0;
    }
    return tree;
}

/* Run and short-literal symbols encode 1..16 directly and 17.. as a scaled
 * step, so a 5-bit field reaches 256. */
function runLength(v) {
    return (v >= 0x11) ? ((v - 0x10) << 4) : v;
}

/*
 * Fast-decode table: 256 entries, one per possible next 8 bits. An entry is
 * either a leaf value with its code length in bits 24..27, or — when the code
 * is longer than 8 bits — the tree position to keep walking from, which is
 * non-negative and so tells the two apart.
 */
function makeHuf8(tree) {
    const fast = new Int32Array(0x100);

    const walk = (depth, node, code) => {
        if (depth === 8) { fast[code] = node; return; }
        const len = depth + 1;

        /* 0-child sits inline at node + 1, 1-child is pointed to by node. */
        for (const [child, bit] of [[node + 1, 0], [tree[node], 1]]) {
            const c = code | (bit << depth);
            const v = tree[child];
            if (v < 0) {
                const entry = (v | (len << 24)) | 0;
                for (let i = c; i < 0x100; i += (1 << len)) fast[i] = entry;
            } else {
                walk(len, child, c);
            }
        }
    };

    walk(0, 0, 0);
    return fast;
}

/* ---- Compressed pages (unpack_lod_data) ---------------------------------- */

/*
 * Decode one Huffman page into the two streams the upload routines consume:
 *
 *   halfwords — the full-size level's texels, still RLE-coded (a halfword
 *               equal to the page's escape value introduces a run)
 *   nibbles   — one 4-bit texel value per block, written downward in two
 *               interleaved parities so that a 32-bit read picks up a 2x2
 *               group. send_lod_data_q box-filters these into the mips.
 */
function unpackLodData(md, ptr, lut) {
    const r = new BitReader(md, ptr);

    const w = (r.take(8) + 1) >> 1;
    const h = (r.take(8) + 1) >> 1;
    const symBits = r.take(8);
    const nsym = r.take(16);
    r.take(16);                        /* compressed length, unused here */
    const nIndexed = r.take(16);
    const indexBits = r.take(4);
    const escape = r.take(16);

    const tree = buildCodeTable(r, nsym, symBits, lut);

    /* The indexed-literal table: 16-bit payload and 4-bit delta packed the
     * same way as the ROM literal table, so tag 9 can share tag 8's path. */
    const indexed = new Int32Array(nIndexed);
    for (let i = 0; i < nIndexed; i++) {
        const hi = r.take(16);
        const lo = r.take(4);
        indexed[i] = (hi << 8) | lo;
    }

    const fast = makeHuf8(tree);
    const indexMask = (1 << indexBits) - 1;

    /* Output streams. The nibble buffer is written downward from its top in
     * two parities that swap every row, so a word read four bytes down covers
     * one 2x2 group of blocks; size it for the whole page plus the leading
     * word send_lod_data_q reads from. */
    const halfwords = new Uint16Array(w * h * 2);
    let hi_ = 0;
    const nib = new Uint8Array(w * h + 16);
    let odd = nib.length - 1;           /* 0x55C2EF */
    let even = nib.length - 2;          /* 0x55C2EE */

    let texel = 0;                      /* running 4-bit value (r8) */
    let solid = SOLID[0];               /* its smeared halfword (r7) */

    for (let row = w; row > 0; row--) {
        let left = h;

        while (left > 0) {
            let v = fast[r.peek8()];

            if (v >= 0) {
                /* Code longer than 8 bits: keep walking the table by hand from
                 * the position the fast entry gave, consuming one bit per step
                 * and stopping as soon as a leaf is in reach. The bit index
                 * advances before the leaf is tested — the step that lands on
                 * a leaf still counts, which is what makes the 8 bits the fast
                 * table already matched come out of the stream. */
                let p = v, n = 8;
                for (;;) {
                    /* A walk that leaves the table never finds a leaf. Most of
                     * Fighting Vipers' sets 71 and 72 do it on their first
                     * code; give up on the page rather than spin. */
                    if (p >= tree.length) return null;
                    const t = tree[p];
                    const bit = r.bit(n);
                    n++;
                    if (t < 0) { v = t; break; }
                    p = bit ? t : p + 1;
                }
                r.skip(n - 1);
            } else {
                r.skip((v >>> 24) & 0xf);
            }

            const tag = v >>> 28;
            let payload;

            if (tag === 0x9) {
                v = indexed[r.take(indexBits)];    /* indexed literal */
            }
            if (tag === 0x8 || tag === 0x9) {
                texel = (texel + v) & 0xf;
                solid = SOLID[texel];
                payload = (v >>> 8) & 0xffff;
            } else if (tag === 0xa) {
                /* Inline literal: payload and delta straight from the stream. */
                payload = r.take(16);
                texel = (texel + r.take(4)) & 0xf;
                solid = SOLID[texel];
            } else if (tag === 0xb) {
                /* Run: emit the escape pair and repeat the current texel. */
                halfwords[hi_++] = escape;
                const n = v & 0xff;
                left -= n;
                /* The count is a byte, so a run of 256 masks to zero — and the
                 * loop is bottom-tested, so that still writes one. */
                for (let k = Math.max(n, 1); k > 0; k--) { nib[odd] = texel; odd -= 2; }
                halfwords[hi_++] = ((solid & 0xff) << 8) | n;
                continue;
            } else {
                payload = v & 0xffff;              /* tags 0xC and 0xD */
            }

            nib[odd] = texel;
            odd -= 2;
            halfwords[hi_++] = (solid + payload) & 0xffff;
            left--;
        }

        [odd, even] = [even, odd];
    }

    return { w, h, escape, halfwords, nib };
}

/* ---- Full-size level (send_lod_data) ------------------------------------- */

/*
 * Copy the halfword stream into texram, expanding runs. A halfword equal to
 * the page's escape value is followed by one that packs the repeated value in
 * its high byte and the count in its low byte.
 */
function sendLodData(tex, base, page) {
    const { w, h, escape, halfwords } = page;
    let s = 0;
    let g2 = halfwords[s++];

    for (let i = 0; i < w; i++) {
        let o = base + i * ROW_PAIR;
        let left = h;

        while (left > 0) {
            if (g2 === escape) {
                const packed = halfwords[s++];
                const value = ((packed >>> 8) | (packed & 0xff00)) & 0xffff;
                const n = packed & 0xff;
                left -= n;
                for (let k = Math.max(n, 1); k > 0; k--) {
                    tex[o] = value & 0xff;
                    tex[o + 1] = value >>> 8;
                    o += 2;
                }
            } else {
                left--;
                tex[o] = g2 & 0xff;
                tex[o + 1] = g2 >>> 8;
                o += 2;
            }
            g2 = halfwords[s++];
        }
    }
}

/* ---- Mip chain (send_lod_data_q) ----------------------------------------- */

/*
 * Build every smaller level by box-filtering the nibble stream: four 4-bit
 * texels arrive as one 32-bit read, their average becomes the next level's
 * nibble, and the four packed together become this level's halfword. Each pass
 * rewrites the buffer it just read, so the chain runs in place.
 */
function sendLodDataQ(tex, dest, page) {
    let { w, h, nib } = page;
    const top = nib.length - 4;         /* 0x55C2EC */

    for (let level = 1; level < dest.length; level++) {
        w >>= 1;
        h >>= 1;
        if (w === 0 || h === 0) return;

        let read = top;
        let odd = nib.length - 1;
        let even = nib.length - 2;
        let out = dest[level];

        /* The i960 caches the last input word and its two outputs, so a run of
         * identical blocks costs one arithmetic pass. Kept because it also
         * pins down the exact read order. */
        let last = -1, lastHalf = 0, lastNib = 0;
        let word = readWord(nib, read);

        for (let i = 0; i < w; i++) {
            let o = out;
            out += ROW_PAIR;

            for (let j = 0; j < h; j++) {
                if (word !== last) {
                    read -= 4;
                    lastHalf = (word | (word >>> 12)) & 0xffff;
                    last = word;
                    let sum = (word + (word >>> 16)) >>> 0;
                    word = readWord(nib, read);
                    sum = (sum + (sum >>> 8)) >>> 0;
                    lastNib = (sum >>> 2) & 0xf;
                } else {
                    read -= 4;
                    word = readWord(nib, read);
                }
                tex[o] = lastHalf & 0xff;
                tex[o + 1] = lastHalf >>> 8;
                o += 2;
                nib[odd] = lastNib;
                odd -= 2;
            }
            [odd, even] = [even, odd];
        }
    }
}

function readWord(b, i) {
    return ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0);
}

/* ---- Driver (unp_send_tex_para_sub) -------------------------------------- */

/*
 * Where a texture set's full-size pages land, without unpacking any of them.
 *
 * Every page is 256x256 at a known place on a known sheet, and that is decided
 * by the origin word and the page grid alone — the codec never enters into it.
 * So which set holds the tiles a model asks for can be answered by arithmetic,
 * which matters because a game whose stage table is not known has nothing to
 * say which set to load, and unpacking all of them to find out costs seconds.
 *
 * Coordinates are the logical atlas ones a face's tx/ty are already in: x runs
 * 0..2047 across the sheet, y runs 0..1023 within it, and sheet 1 sits at
 * y + 1024. A page folded into the lower half carries no full-size level and is
 * left out, since nothing samples it at full size.
 *
 * @returns {{x:number, y:number}[]} page origins in atlas space
 */
export function texturePages(rom, texSet) {
    return setPages(rom, texSet)
        .filter(({ x, y }) => !((x & 0x400) && (y & 0x200)))   /* mips only, no full size */
        .map(({ x, y, origin }) => ({ x, y: y + pageSheet(origin) * SHEET_H }));
}

/*
 * Walk one texture set's page list: { pagePtr, origin, x, y } per page, in the
 * order the game sends them, with x and y the page's place on the ROM page
 * grid.
 *
 * Every pointer is checked before it is followed. The game never checks
 * because it only ever reads set numbers its own tables name; the viewer will
 * happily be asked for any number at all, and Fighting Vipers' page-list array
 * has no terminator to stop a walk off the end.
 */
function setPages(rom, texSet) {
    const md = rom.mainData;
    const dv = rom.mainDataView;
    const cv = rom.mainCpuView;
    const off = (a) => a - MAIN_DATA_BASE;
    /* TEX_HEADER is the main_data header, 0x300000 in both games: +0x08 and
     * +0x0C point to the destination-list and page-list arrays, and +0x10 is
     * the 256-entry literal table the Huffman symbols below 0x100 index. Both
     * games reach it the same way — `ld off_230000C, r4` in
     * unp_send_tex_para_sub — but it is read off the profile with everything
     * else. PAGE_TABLE is the page grid in the program ROM, which is the one
     * address of the two that moves between games. See js/games.js. */
    const TEX_HEADER = rom.game.texture.header;
    const PAGE_TABLE = rom.game.texture.pageTable;
    const ptrOk = (p, need = 4) => p >= MAIN_DATA_BASE && off(p) + need <= md.length;

    const destTable = dv.getUint32(TEX_HEADER + 0x08, true);
    const pageTable = dv.getUint32(TEX_HEADER + 0x0c, true);

    const out = [];
    const setAddr = off(pageTable) + texSet * 4;
    if (texSet < 0 || setAddr + 4 > md.length) return out;
    const setPtr = dv.getUint32(setAddr, true);
    if (!ptrOk(setPtr)) return out;

    /* The set's first word selects which destination list its pages use;
     * the list starts with a count and then one packed origin per page. */
    const listIdx = dv.getUint32(off(setPtr), true);
    const listAddr = off(destTable) + listIdx * 4;
    if (listAddr + 4 > md.length) return out;
    const listPtr = dv.getUint32(listAddr, true);
    if (!ptrOk(listPtr)) return out;
    const count = dv.getUint32(off(listPtr), true);

    for (let i = 0; i < count; i++) {
        if (!ptrOk(setPtr + 4 + i * 4) || !ptrOk(listPtr + 4 + i * 4)) break;
        const pagePtr = dv.getUint32(off(setPtr) + 4 + i * 4, true);
        if (!ptrOk(pagePtr)) continue;
        /* Origin word: a page slot in its low half plus a byte offset in each
         * of the top two bytes, resolved against the ROM page grid. */
        const origin = dv.getUint32(off(listPtr) + 4 + i * 4, true);
        const slot = (origin & 0xffff) >>> 1;
        if (PAGE_TABLE + slot * 4 + 4 > rom.maincpu.length) continue;
        const y = cv.getInt16(PAGE_TABLE + slot * 4, true) + (origin >>> 24);
        const x = cv.getInt16(PAGE_TABLE + slot * 4 + 2, true) + ((origin >>> 16) & 0xff);
        out.push({ pagePtr, origin, x, y });
    }
    return out;
}

/**
 * Which texture set best covers the tiles a decoded model samples.
 *
 * A face names a 32-pixel tile in the atlas; a set either uploads a page
 * covering that tile or it does not. Scoring every set on how many of the
 * model's tiles it covers picks the one the game would have had resident, and
 * costs a walk of the page lists rather than 99 Huffman decodes.
 *
 * @returns {{set:number, covered:number, tiles:number}|null} null if untextured
 */
export function bestTextureSet(rom, decoded, setCount) {
    /* Coverage cannot answer it for a game whose sheets are raw banks — every
     * bank fills the whole sheet, so every set covers every tile — and such a
     * game has no page lists to walk in the first place. See bankTextureSet. */
    if (rom.game.texture.raw) return null;
    const want = sampledTiles(decoded);
    if (!want.length) return null;

    let best = -1, bestN = -1;
    for (let s = 0; s < setCount; s++) {
        if (!texturePages(rom, s).length) continue;
        const n = tilesCovered(rom, want, [s]);
        if (n > bestN) { bestN = n; best = s; }
    }
    return best < 0 ? null : { set: best, covered: bestN, tiles: want.length / 2 };
}

/* The atlas tiles a decoded model samples, once each, as x, y pairs. A face
 * whose width is 0 is untextured and samples none. */
function sampledTiles(decoded) {
    const want = [];
    if (!decoded?.tiles?.length) return want;
    const seen = new Set();
    for (let i = 0; i < decoded.tiles.length; i += 4) {
        if (!decoded.tiles[i + 2]) continue;           /* untextured face */
        const tx = decoded.tiles[i], ty = decoded.tiles[i + 1];
        const key = ty * 4096 + tx;
        if (seen.has(key)) continue;
        seen.add(key);
        want.push(tx, ty);
    }
    return want;
}

/* How many of those tiles some page of the given sets covers. */
function tilesCovered(rom, want, sets) {
    const pages = sets.flatMap((s) => texturePages(rom, s));
    let n = 0;
    for (let i = 0; i < want.length; i += 2) {
        const tx = want[i], ty = want[i + 1];
        for (const p of pages) {
            if (tx >= p.x && tx < p.x + 256 && ty >= p.y && ty < p.y + 256) { n++; break; }
        }
    }
    return n;
}

/**
 * Which of a list of set combinations covers most of a model's tiles: the
 * fallback for a model the program names nowhere, narrowed to what the board
 * can have resident at once rather than any one of a hundred sets.
 *
 * @param {number[][]} combos  each a list of sets loaded together
 * @returns {{sets:number[], covered:number, tiles:number}|null} the first best
 */
export function bestTextureCombo(rom, decoded, combos) {
    if (rom.game.texture.raw) return null;
    const want = sampledTiles(decoded);
    if (!want.length) return null;
    let best = null, bestN = -1;
    for (const sets of combos) {
        const n = tilesCovered(rom, want, sets);
        if (n > bestN) { bestN = n; best = sets; }
    }
    return best && { sets: best, covered: bestN, tiles: want.length / 2 };
}

/* ---- Raw banks (The House of the Dead) ----------------------------------- */

/*
 * The second half of a raw bank, dealt out between the sheets.
 *
 * Each row is a rectangle of the bank's mip half in halfword columns and rows
 * (x0, y0, x1, y1), and whether it lands on the sheet that took the bank's
 * full-size half or on the other one. Read off sub_D40, which loads a bank onto
 * sheet 0, and sub_EB0, which loads one onto sheet 1 with every destination
 * swapped. The pattern is the mip chain alternating sheets level by level, the
 * same arrangement pageDestinations builds for a compressed page.
 */
const RAW_MIP_RECTS = [
    [0x000, 0x000, 0x1ff, 0x0ff, true],
    [0x000, 0x100, 0x0ff, 0x1ff, false],
    [0x100, 0x100, 0x1ff, 0x17f, false],
    [0x100, 0x180, 0x17f, 0x1ff, true],
    [0x180, 0x180, 0x1ff, 0x1bf, true],
    [0x180, 0x1c0, 0x1bf, 0x1ff, false],
    [0x1c0, 0x1c0, 0x1ff, 0x1df, false],
    [0x1c0, 0x1e0, 0x1df, 0x1ff, true],
    [0x1e0, 0x1e0, 0x1ff, 0x1ef, true],
    [0x1e0, 0x1f0, 0x1ff, 0x1ff, false],
];

/* Where sub_489F0 pastes a set's eight blocks on sheet 0, in halfword columns
 * and rows; each is 64 halfwords square, full-size level only, and the block
 * index picks the place — a null entry leaves that place alone. */
const RAW_PATCH_AT = [[0, 0], [64, 0], [0, 64], [64, 64], [0, 128], [64, 128], [0, 192], [64, 192]];

/* sub_1030: copy a rectangle of halfwords between two sheet-shaped images. A
 * row is 0x400 bytes, so a halfword (x, y) is at byte ((y << 9) + x) * 2 in
 * both. */
function copyRect(src, srcBase, dst, dstBase, x0, y0, x1, y1) {
    for (let y = y0; y <= y1; y++) {
        const a = ((y << 9) + x0) * 2;
        const b = ((y << 9) + x1 + 1) * 2;
        if (srcBase + b > src.length) return;
        dst.set(src.subarray(srcBase + a, srcBase + b), dstBase + a);
    }
}

function uploadRawBank(md, base, tex, toSheet1) {
    const near = toSheet1 ? SHEET1 : SHEET0;
    const far = toSheet1 ? SHEET0 : SHEET1;
    copyRect(md, base, tex, near, 0, 0, 0x1ff, 0x1ff);
    for (const [x0, y0, x1, y1, same] of RAW_MIP_RECTS) {
        copyRect(md, base + 0x80000, tex, (same ? near : far) + 0x80000, x0, y0, x1, y1);
    }
}

/* ---- Raw banks, Daytona USA's arrangement -------------------------------- */

/*
 * Daytona keeps its sheets raw too, but deals a bank out with a routine of its
 * own — the one at 0x1388 in its program ROM, which this is a port of.
 *
 * A bank is a megabyte, and a sheet is a megabyte read as 1024 rows of 0x200
 * halfwords. The first 0x60000 halfwords of the bank go straight into one
 * sheet, filling its rows 0..767: the full-size area, and the loop that does it
 * writes nothing to the other sheet. The remaining 0x20000 halfwords are nine
 * mip levels of 0x80, 0x40, 0x20, 0x10, 8, 4, 2, 1 and 1 rows, and *those* are
 * dealt between the two sheets: both sheet pointers advance on every halfword
 * and only one of them is written, so what one sheet does not take the other
 * does.
 *
 * Where it switches is the table at 0x1494, which is 0x200 >> k. Within a row
 * the first run is always 0x100 halfwords; run k after that is 0x200 >> k,
 * doubled while k is past the level number, which is what makes every level's
 * runs add up to exactly one row:
 *
 *     level 0   0x200                                  (no switching at all)
 *     level 1   0x100 0x100
 *     level 2   0x100 0x80 0x80
 *     level 3   0x100 0x80 0x40 0x40                   ... and so on
 *
 * The game calls it twice a scene: the bank at data 0x500000 onto sheet 1, and
 * the course's bank onto sheet 0, each starting its mip runs on the sheet the
 * other one did not take.
 */

/* One level's runs, as [halfwords, onTheStartingSheet] pairs.
 *
 * Level 0 is the one whole run the table above says it is: every row of the
 * first mip level goes to the starting sheet, none to the other. This used to
 * start it with a run of 0x100 like the rest, which dealt the second half of
 * each of those 128 rows onto the wrong sheet; graded against texture RAM
 * captured from a running board (stf-tools' mame-daytona-texram.lua), that was
 * the only difference in either sheet, and it put the other bank's art where
 * every texture's first mip should be. */
function daytonaRuns(level) {
    if (level === 0) return [[0x200, true]];
    const out = [[0x100, true]];
    let on = false;
    let left = 0x100;
    for (let k = 2; left > 0; k++) {
        const n = Math.min((0x200 >> k) * (k > level ? 2 : 1), left);
        out.push([n, on]);
        left -= n;
        on = !on;
    }
    return out;
}

const DAYTONA_LEVEL_ROWS = [0x80, 0x40, 0x20, 0x10, 8, 4, 2, 1, 1];
/* Where the mip half starts: 0x60000 halfwords in, which is row 0x300. */
const DAYTONA_FULL_ROWS = 0x300;

function uploadDaytonaBank(md, base, tex, toSheet1) {
    const near = toSheet1 ? SHEET1 : SHEET0;
    const far = toSheet1 ? SHEET0 : SHEET1;
    /* The full-size half, one sheet only. */
    const full = DAYTONA_FULL_ROWS * ROW_PAIR;
    if (base + full > md.length) return;
    tex.set(md.subarray(base, base + full), near);

    /* The mip half, which starts on the sheet the full-size half did not take. */
    let src = base + full;
    let row = DAYTONA_FULL_ROWS;
    for (let level = 0; level < DAYTONA_LEVEL_ROWS.length; level++) {
        const runs = daytonaRuns(level);
        for (let r = 0; r < DAYTONA_LEVEL_ROWS[level]; r++, row++) {
            let x = 0;
            for (const [n, onFar] of runs) {
                const dst = (onFar ? far : near) + row * ROW_PAIR + x * 2;
                if (src + n * 2 > md.length) return;
                tex.set(md.subarray(src, src + n * 2), dst);
                src += n * 2;
                x += n;
            }
        }
    }
}

/*
 * Texture RAM for Daytona: the boot bank on sheet 1, the course's bank on
 * sheet 0, and their mip halves complementary. Which course a lone model
 * belongs to is not known, so the set is whatever the caller asked for.
 */
function buildDaytonaTexram(rom, texSets) {
    const md = rom.mainData;
    const cv = rom.mainCpuView;
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const off = (a) => a - MAIN_DATA_BASE;

    uploadDaytonaBank(md, off(raw.bootBank), tex, true);

    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const set = sets.length ? sets[sets.length - 1] : null;
    let pages = 1;
    if (set !== null) {
        /* Daytona keeps the table in the program ROM; Virtua Cop names it by
         * its data ROM address; Virtua Striker has no table, only its one bank
         * (`banks`). */
        const bank = raw.banks ? raw.banks[set]
            : raw.bankTable >= MAIN_DATA_BASE
            ? rom.mainDataView.getUint32(off(raw.bankTable) + set * 4, true)
            : cv.getUint32(raw.bankTable + set * 4, true);
        if (bank >= MAIN_DATA_BASE && off(bank) + SHEET_BYTES <= md.length) {
            uploadDaytonaBank(md, off(bank), tex, false);
            pages++;
        }
    }
    for (const [entry, ...args] of raw.run ?? []) runTextureRoutine(rom, tex, entry, args);
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * A boot routine that works on texture RAM once the banks are in, run as the
 * game's own code (js/i960.js) against these sheets: the 2B board's texture
 * RAM, 0x11000000 (sheet 0, mirrored at 0x11100000) and 0x11200000 (sheet 1,
 * mirrored at 0x11300000). Virtua Striker's 0x9F70 (called at 0x10C4 with
 * g0 1) averages a 32x64-texel patch of sheet 1 down to half size on sheet 0.
 */
function runTextureRoutine(rom, tex, entry, args) {
    const prog = rom.maincpu;
    const ram = new Uint8Array(0x100000);
    const where = (a) => {
        if (a < prog.length) return [prog, a];
        if (a >= 0x500000 && a < 0x600000) return [ram, a - 0x500000];
        if (a >= 0x11000000 && a < 0x11400000) return [tex, ((a >> 21) & 1) * SHEET_BYTES + (a & 0xfffff)];
        throw new Error(`texture routine read 0x${a.toString(16)}`);
    };
    const read = (a, n) => {
        const [b, o] = where(a);
        let v = 0;
        for (let k = n - 1; k >= 0; k--) v = (v << 8) | b[o + k];
        return v >>> 0;
    };
    const write = (a, v, n) => {
        const [b, o] = where(a);
        if (b === prog) throw new Error(`texture routine wrote ROM 0x${a.toString(16)}`);
        for (let k = 0; k < n; k++) b[o + k] = (v >>> (8 * k)) & 0xff;
    };
    const cpu = new I960({
        read8: (a) => read(a, 1), read16: (a) => read(a, 2), read32: (a) => read(a, 4),
        write8: (a, v) => write(a, v, 1), write16: (a, v) => write(a, v, 2), write32: (a, v) => write(a, v, 4),
    });
    if (!cpu.call(entry, args, { maxSteps: 2_000_000 })) throw new Error(`texture routine 0x${entry.toString(16)} did not return`);
}

/* ---- Raw banks, Sega Rally's arrangement --------------------------------- */

/*
 * Sega Rally deals a bank out with a routine of its own as well, 0x3940 in
 * its program ROM (run from RAM at 0x5A2940), which this is a port of. It is
 * called with a bank number and a sheet flag; the bank is the megabyte at
 * main_data 0x200000 + bank * 0x100000.
 *
 * It keeps two sheet cursors, A and B. A starts on sheet 0 when the flag is 0
 * and on sheet 1 when it is not, and B on the other. The run table at 0x3880
 * is six entries of eight words: a repeat count, then runs, then a word that
 * ends them. For each run of n halfwords, B steps on n, n halfwords are copied
 * to A and A steps on n, and the two cursors swap. An end word of -1 swaps
 * them once more, 0 does not. So both cursors advance on every halfword and
 * only one of them is written, as in Daytona's.
 *
 *     1 x    0x60000  0x10000                          the full size, level 0
 *     0x40 x 0x100 0x100
 *     0x20 x 0x100 0x80 0x80                (and a swap)
 *     0x10 x 0x100 0x80 0x40 0x40                      ... and so on
 *
 * The first 0x60000 halfwords (rows 0..767) go to A's sheet alone and level 0
 * (rows 768..895) to the other one. The table is read out of the program ROM
 * rather than copied here, so this is the routine and not its numbers.
 *
 * The boot uploads bank 0 with the flag 0 (0x5A2170), so its full-size area
 * is on sheet 0; a course uploads the bank `ld 0x3DCF0[variant*4]` names with
 * the flag 1 (0x3DCF0: 2, 3, 4, 5), so its full-size area is on sheet 1 and
 * the two banks' mip runs come out complementary. Graded against texture RAM
 * dumped from m2-hle2 running the game, whose Sega Rally profile does no
 * texture upload of its own: both sheets, every halfword, on the desert, the
 * mountain and the forest.
 */
function uploadSrallycBank(rom, base, tex, flag) {
    const md = rom.mainData;
    const cv = rom.mainCpuView;
    const table = rom.game.texture.raw.runTable;
    const word = (i) => cv.getInt32(table + i * 4, true);
    let a = { sheet: flag ? SHEET1 : SHEET0, at: 0 };
    let b = { sheet: flag ? SHEET0 : SHEET1, at: 0 };
    let src = base;
    for (let e = 0; e < 48; e += 8) {
        const reps = word(e);
        let p = e + 1;
        for (let r = 0; r < reps; r++) {
            p = e + 1;
            while (word(p) > 0) {
                const n = word(p++);
                b.at += n;
                if (src + n * 2 > md.length) return;
                tex.set(md.subarray(src, src + n * 2), a.sheet + a.at * 2);
                src += n * 2;
                a.at += n;
                [a, b] = [b, a];
            }
            if (word(p) < 0) [a, b] = [b, a];
        }
    }
}

/*
 * Texture RAM for Sega Rally: the boot bank, then the set's course bank. A set
 * is a course variant, an index into the bank table.
 */
function buildSrallycTexram(rom, texSets) {
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const bank = (n) => MAIN_DATA_BANKS + n * SHEET_BYTES;
    uploadSrallycBank(rom, bank(raw.bootBank), tex, 0);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    let pages = 1;
    if (sets.length) {
        const n = rom.mainCpuView.getUint32(raw.bankTable + sets[sets.length - 1] * 4, true);
        if (bank(n) + SHEET_BYTES <= rom.mainData.length) {
            uploadSrallycBank(rom, bank(n), tex, 1);
            pages++;
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}
/* Where Sega Rally's bank 0 starts: 0x2200000 on the i960. */
const MAIN_DATA_BANKS = 0x200000;

/*
 * Texture RAM for Dead or Alive. The program copies 128-row strips out of
 * 0xC0000-byte slabs in the data ROMs (0x7CBA0): a slab's first and last
 * quarters are a fighter's, two strips side by side, and its middle half is
 * a stage's. Rows 0-255 and 512-767 of a sheet take the two fighters' strips,
 * rows 256-511 the stage's. The stage's slab is `stageSlabs[stage]`. A
 * fighter's is `charSlabs[id & 0x7F]` and its strip the second when bit 7 of
 * `id` is set, `id` its load id (js/colors.js doaLoadId): costume 0's Jann
 * Lee is 0x82, slab 2's second strip, its first being costume 2's. The game
 * writes the strips to one sheet, whichever the double buffer is on; the
 * explorer writes both, so a model reads them on either page. The fighters
 * are `fighters` (player 1 first), by default the first two in costume 0,
 * which the attract mode loads at boot.
 */
function buildDoaTexram(rom, texSets, fighters = [{ char: 0 }, { char: 1 }]) {
    const md = rom.mainData;
    const cv = rom.mainCpuView;
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const slab = (table, k) => cv.getUint32(table + k * 4, true) - MAIN_DATA_BASE;
    const copy = (src, sheet, row, rows) => {
        if (src >= 0 && src + rows * ROW_PAIR <= md.length) {
            tex.set(md.subarray(src, src + rows * ROW_PAIR), sheet * SHEET_BYTES + row * ROW_PAIR);
        }
    };
    for (let half = 0; half < 2; half++) {
        const id = doaLoadId(rom, fighters[half] ?? { char: half });
        const src = slab(raw.charSlabs, id & 0x7f) + 0x20000 * (id >> 7);
        for (let sheet = 0; sheet < 2; sheet++) {
            copy(src, sheet, 128 * half, 128);
            copy(src + 0x80000, sheet, 512 + 128 * half, 128);
        }
    }
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    if (sets.length) {
        const src = slab(raw.stageSlabs, sets[sets.length - 1]) + 0x40000;
        for (let sheet = 0; sheet < 2; sheet++) copy(src, sheet, 256, 256);
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages: 2 };
}

/* ---- Air Walkers ---------------------------------------------------------- */

/*
 * Air Walkers keeps its texels raw in the data ROMs and writes them through the
 * Model 2A window (0x12000000 sheet 0, 0x12400000 sheet 1, each mirrored
 * 0x200000 on), where dword n of the window is halfword n of the sheet
 * (model2.cpp tex0_w). Three routines do all of it:
 *
 *   0x1DCC0  copy a rectangle out of a sheet-shaped source, 0x200 halfwords a
 *            row: copyRect
 *   0x1DD20  copy a rectangle out of a packed source, the rectangle's own
 *            width a row, from row `at` of 0x200 halfwords on
 *   0x1DA80  make a mip level out of the one above it on the other sheet
 *
 * 0x1D430 (source, sheet, kind) loads a page of `kind`, a switch of 51 cases
 * at 0x1D474 of which the game calls two, and 0x1D9B0 (source, sheet) loads a
 * fighter's page and makes its mips. A list below is one case: its packed
 * rectangles as [at, sheet, x0, y0, x1, y1], `sheet` 0 the one named and 1
 * the other, rows counted from row 512 (`lda 0x100000(r6)`) where `low` is set.
 */
const AW_PAGES = {
    /* Case 0x20 (0x1D678): a full-size half sheet straight, then its mips. The
     * boot pages, 0x2000000 on sheet 0 and 0x20AAA00 on sheet 1 (0x248DC). */
    0x20: {
        full: true,
        rects: [
            [0x00, 1, 0x000, 0x100, 0x0ff, 0x1ff, true],
            [0x80, 0, 0x100, 0x180, 0x17f, 0x1ff, true],
            [0xa0, 1, 0x180, 0x1c0, 0x1bf, 0x1ff, true],
            [0xa8, 0, 0x1c0, 0x1e0, 0x1df, 0x1ff, true],
            [0xaa, 1, 0x1e0, 0x1f0, 0x1ef, 0x1ff, true],
        ],
    },
    /* Case 0x31 (0x1D8D0): rows 256..511 of the sheet and their mips. The
     * title's page, 0x2155400 on sheet 1 (0x256C8). */
    0x31: {
        full: false,
        rects: [
            [0x000, 0, 0x000, 0x100, 0x1ff, 0x1ff, false],
            [0x100, 1, 0x000, 0x180, 0x0ff, 0x1ff, true],
            [0x140, 0, 0x100, 0x1c0, 0x17f, 0x1ff, true],
            [0x150, 1, 0x180, 0x1e0, 0x1bf, 0x1ff, true],
            [0x154, 0, 0x1c0, 0x1f0, 0x1df, 0x1ff, true],
            [0x155, 1, 0x1e0, 0x1f0, 0x1ef, 0x1ff, true],
        ],
    },
};

/* 0x1D9B0's five mip levels: [from, x, y, w, h], `from` the sheet read (0 the
 * team's, 1 the other), the level written to the other one. The third is
 * 0x3F wide where the rest halve, as the code has it (`lda 0x3f, g4`). */
const AW_TEAM_MIPS = [
    [0, 0x200, 0x000, 0x100, 0x80],
    [1, 0x300, 0x100, 0x80, 0x40],
    [0, 0x380, 0x180, 0x3f, 0x20],
    [1, 0x3c0, 0x1c0, 0x20, 0x10],
    [0, 0x3e0, 0x1e0, 0x10, 8],
];

/* 0x1DD20: `rows` x `cols` halfwords, back to back from `src`. */
function awPacked(md, src, tex, base, x0, y0, x1, y1) {
    const w = (x1 - x0 + 1) * 2;
    for (let y = y0; y <= y1; y++, src += w) {
        if (src + w > md.length) return;
        tex.set(md.subarray(src, src + w), base + ((y << 9) + x0) * 2);
    }
}

/*
 * 0x1DA80: one mip level. A halfword is a 2x2 block of texels, so a 2x2 block
 * of halfwords becomes one: each input halfword gives one texel, its low texel
 * plus three times the next, over four (`addo` three times, `shro 2`). The
 * top-left input lands in the top nibble. x past 0x1FF folds onto rows 512 on,
 * for the source and the destination alike, and the destination is where the
 * level halves towards (0x400, 0x200).
 */
function awMip(tex, from, to, sx, sy, w, h) {
    let dx = 0x400 - ((0x400 - sx) >> 1);
    let dy = 0x200 - ((0x200 - sy) >> 1);
    if (sx > 0x1ff) { sx -= 0x200; sy += 0x200; }
    if (dx > 0x1ff) { dx -= 0x200; dy += 0x200; }
    const at = (base, x, y) => base + ((y << 9) + x) * 2;
    const hw = (base, x, y) => tex[at(base, x, y)] | (tex[at(base, x, y) + 1] << 8);
    const t = (v) => ((v & 15) + 3 * ((v >> 4) & 15)) >> 2;
    for (let j = 0; j < h; j++) {
        const y = sy + 2 * j;
        for (let i = 0; i < w; i++) {
            const x = sx + 2 * i;
            const v = t(hw(from, x + 1, y + 1)) | (t(hw(from, x, y + 1)) << 4)
                | (t(hw(from, x + 1, y)) << 8) | (t(hw(from, x, y)) << 12);
            const o = at(to, dx + i, dy + j);
            tex[o] = v & 0xff;
            tex[o + 1] = v >> 8;
        }
    }
}

/* 0x1D430: a page of `kind` out of `src` (a data offset) onto `sheet`. */
function awPage(md, tex, src, sheet, kind) {
    const near = sheet ? SHEET1 : SHEET0, far = sheet ? SHEET0 : SHEET1;
    const page = AW_PAGES[kind];
    let at = src;
    if (page.full) {
        copyRect(md, src, tex, near, 0, 0, 0x1ff, 0x1ff);
        at += 0x80000;
    }
    for (const [row, other, x0, y0, x1, y1, low] of page.rects) {
        awPacked(md, at + row * ROW_PAIR, tex, (other ? far : near) + (low ? 0x80000 : 0), x0, y0, x1, y1);
    }
}

/* 0x1D9B0: a team's page, rows 512..767, and its mips made from it. */
function awTeamPage(md, tex, src, sheet) {
    const near = sheet ? SHEET1 : SHEET0, far = sheet ? SHEET0 : SHEET1;
    awPacked(md, src, tex, near + 0x80000, 0, 0, 0x1ff, 0xff);
    for (const [from, x, y, w, h] of AW_TEAM_MIPS) {
        awMip(tex, from ? far : near, from ? near : far, x, y, w, h);
    }
}

/*
 * Texture RAM for Air Walkers. The stage set-up (0x247D0) loads the same two
 * boot pages for every court; then 0x1F0E0 loads a team's page,
 * `ld 0xF1810[team*4]`, onto sheet 0 for the home side's numbers 0..16 and
 * sheet 1 for the away side's 17..33, which is where each side's models look
 * for it. The set past the teams is the title's: the boot pages with the
 * title's page over them (0x256C8), which the attract screens draw against.
 */
function buildAirwlkrsTexram(rom, texSets) {
    const md = rom.mainData;
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const off = (a) => a - MAIN_DATA_BASE;
    for (const [src, sheet, kind] of raw.boot) awPage(md, tex, off(src), sheet, kind);
    let pages = raw.boot.length;
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const set = sets.length ? sets[sets.length - 1] : -1;
    if (set === raw.titleSet) {
        const [src, sheet, kind] = raw.title;
        awPage(md, tex, off(src), sheet, kind);
        pages++;
    } else if (set >= 0) {
        const src = rom.mainCpuView.getUint32(raw.teamPages + set * 4, true);
        if (src >= MAIN_DATA_BASE && off(src) + 0x40000 <= md.length) {
            awTeamPage(md, tex, off(src), set > 16 ? 1 : 0);
            pages++;
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * Texture RAM that is one straight copy of the data ROM: Power Sled's 0xC540
 * copies 0x80000 halfwords from data 0x600000 into sheet 0 and the next
 * 0x80000 into sheet 1, and nothing loads over them. m2-hle2's sheets match
 * the ROM byte for byte.
 */
function buildCopyTexram(rom) {
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    rom.game.texture.raw.sheets.forEach((src, i) => {
        const at = src - MAIN_DATA_BASE;
        tex.set(md.subarray(at, Math.min(at + SHEET_BYTES, md.length)), i * SHEET_BYTES);
    });
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages: 2 };
}

/*
 * Pilot Kids' pages are not packed for the 315-5881 chip: the program deals
 * them out of the data ROM itself (0x5C2A0 in the Revision A build, run from
 * its RAM copy). `raw.loads` is the program's table of {source, kind}, ten
 * loads: load 0 the common one the boot puts in (kind 1), loads 1 to 9 a
 * scene's (kind 0), which go in over it. A kind is a list of rectangles, each
 * `blit(base, row, col, h, w)` (0x5C610), the source running on from one to
 * the next; `base` here is the quarter of texture RAM, 0 and 1 the two halves
 * of sheet 0 (0x11000000, 0x11080000), 2 and 3 those of sheet 1 (0x11200000,
 * 0x11280000). A rectangle starts at byte (row >> 1) * 0x400 + (col >> 2) * 4
 * of its quarter and is h / 2 row pairs of w bytes; each row pair is a run of
 * halfword headers, n = low byte and m = high byte (0 meaning 256), each
 * followed by n halfwords written again and again until m are out. Kind 1
 * ends with a 16 by 32 rectangle of halfword 0x8888 (0x5C6F0). Kind 2 is in
 * the program but no load names it. m2-hle2's sheets match byte for byte, at
 * the title (load 8) and in the first stage (load 4).
 */
const PLTKIDS_KINDS = [
    [[0, 0, 0, 1024, 1024], [3, 0x200, 0, 512, 512], [1, 0x300, 0x200, 256, 256],
        [3, 0x380, 0x300, 128, 128], [1, 0x3c0, 0x380, 64, 64], [3, 0x3e0, 0x3c0, 32, 32]],
    [[2, 0, 0, 1024, 1024], [3, 0, 0, 512, 1024], [1, 0x200, 0, 512, 512], [1, 0x200, 0x200, 256, 512],
        [3, 0x300, 0x200, 256, 256], [3, 0x300, 0x300, 128, 256], [1, 0x380, 0x300, 128, 128],
        [1, 0x380, 0x380, 64, 128], [3, 0x3c0, 0x380, 64, 64], [3, 0x3c0, 0x3c0, 32, 64],
        [1, 0x3e0, 0x3c0, 32, 32], [1, 0x3e0, 0x3e0, 16, 32]],
];
const PLTKIDS_QUARTER = SHEET_BYTES / 2;

function pltkidsLoad(rom, tex, load) {
    const cv = rom.mainCpuView;
    const md = rom.mainData;
    const at = rom.game.texture.raw.loads + load * 8;
    const kind = cv.getUint32(at + 4, true);
    let src = cv.getUint32(at, true) - MAIN_DATA_BASE;
    const rects = PLTKIDS_KINDS[kind];
    if (!rects) return;
    for (const [base, row, col, h, w] of rects) {
        const start = base * PLTKIDS_QUARTER + (row >> 1) * ROW_PAIR + (col >> 2) * 4;
        for (let rp = 0; rp < h >> 1; rp++) {
            let d = start + rp * ROW_PAIR;
            const end = d + w;
            while (d < end && src + 2 <= md.length) {
                const head = md[src] | (md[src + 1] << 8);
                src += 2;
                const n = (head & 0xff) || 256, m = (head >> 8) || 256;
                const run = md.subarray(src, src + n * 2);
                for (let k = 0; k < m && d + run.length <= tex.length; k += n, d += n * 2) tex.set(run, d);
                src += n * 2;
            }
        }
    }
    if (kind === 1) {
        const start = 3 * PLTKIDS_QUARTER + (0x3f0 >> 1) * ROW_PAIR + (0x3e0 >> 2) * 4;
        for (let rp = 0; rp < 8; rp++) tex.fill(0x88, start + rp * ROW_PAIR, start + rp * ROW_PAIR + 32);
    }
}

/* Set s is the common load with scene load s + 1 over it. */
function buildPltkidsTexram(rom, texSets) {
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const tex = new Uint8Array(SHEET_BYTES * 2);
    pltkidsLoad(rom, tex, 0);
    pltkidsLoad(rom, tex, (sets.length ? sets[sets.length - 1] : rom.game.texture.defaultSet) + 1);
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages: 2 };
}

/*
 * Virtual On's banks are LZSS: a big-endian byte count, then flag bytes read
 * low bit first, a set bit a literal, a clear one a 12-bit window offset and
 * a 4-bit length less 3, out of a 4096-byte window whose writes start at
 * 0xFEE (vonj 0x27E50, which deals the halfwords out as it goes).
 */
function vonUnpack(md, src) {
    if (src < 0 || src + 4 > md.length) return null;
    const need = (((md[src] << 24) | (md[src + 1] << 16) | (md[src + 2] << 8) | md[src + 3]) >>> 0) & ~1;
    if (need > SHEET_BYTES) return null;
    const out = new Uint8Array(need);
    const win = new Uint8Array(0x1000);
    let r = 0xfee, p = src + 4, n = 0, flags = 0;
    while (n < need && p < md.length) {
        flags >>= 1;
        if (!(flags & 0x100)) flags = md[p++] | 0xff00;
        if (flags & 1) {
            const b = md[p++];
            out[n++] = b; win[r] = b; r = (r + 1) & 0xfff;
        } else {
            const b0 = md[p], b1 = md[p + 1];
            p += 2;
            const at = b0 | ((b1 & 0xf0) << 4);
            for (let k = 0; k < (b1 & 0xf) + 3 && n < need; k++) {
                const b = win[(at + k) & 0xfff];
                out[n++] = b; win[r] = b; r = (r + 1) & 0xfff;
            }
        }
    }
    return out;
}

/*
 * The unpacked halfwords go to the same place in one sheet or the other.
 * The first 0x60000 go to the first sheet; past that a 512-byte table in
 * the program (vonj 0x27C50, read at 0x2801C) gives each a pair of numbers,
 * one for the low byte of the index and one for the high, and the pair picks
 * the sheet: the mip rectangles live on the other one.
 */
function vonDeal(page, deal, a, b) {
    for (let i = 0; i < page.length >> 1; i++) {
        let other = false;
        if (i > 0x5ffff) {
            const g5 = deal[i & 0x1ff], g4 = deal[(i >> 8) & 0x1fe];
            other = g4 === 1 || g5 === 1;
            for (let k = 3; k <= 9 && !other; k += 2) {
                other = (g4 === k && g5 > k - 1) || (g5 === k && g4 > k);
            }
        }
        const dst = other ? b : a;
        dst[2 * i] = page[2 * i];
        dst[2 * i + 1] = page[2 * i + 1];
    }
}

/*
 * Virtual On's texture RAM for one field. At boot the game unpacks the font
 * and common bank (main_data 0xC00008) with sheet 0 first, then bank 0 with
 * sheet 1 first; each field then unpacks its own bank (`ld fieldBanks[field]`
 * into the five-pointer `banks` table) with sheet 1 first. Every bank is a
 * full sheet. Field 13 unpacks none and keeps the last field's (MAME, after
 * field 3, holds bank 1 there); the viewer gives it bank 0. Byte-for-byte against
 * MAME's texture RAM after each field's start.
 */
function buildVonTexram(rom, texSets) {
    const md = rom.mainData;
    const cv = rom.mainCpuView;
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const s0 = tex.subarray(0, SHEET_BYTES), s1 = tex.subarray(SHEET_BYTES);
    const deal = rom.maincpu.subarray(raw.deal, raw.deal + 512);
    const bank = (k) => cv.getUint32(raw.banks + k * 4, true) - MAIN_DATA_BASE;
    let pages = 0;
    const load = (src, a, b) => {
        const page = vonUnpack(md, src);
        if (page) { vonDeal(page, deal, a, b); pages++; }
    };
    load(raw.boot, s0, s1);
    load(bank(0), s1, s0);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const field = sets.length ? sets[sets.length - 1] : null;
    if (field !== null && !raw.keepBank0.includes(field)) {
        load(bank(cv.getUint32(raw.fieldBanks + field * 4, true)), s1, s0);
    }
    return { sheet0: s0, sheet1: s1, pages };
}

/*
 * Texture RAM for a game that keeps it raw: the boot bank on sheet 0, the set's
 * bank on sheet 1, the set's patches over sheet 0. The two banks' mip
 * rectangles are complementary, so each sheet's mip half is half one bank and
 * half the other.
 */
function buildRawTexram(rom, texSets) {
    const md = rom.mainData;
    const cv = rom.mainCpuView;
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const off = (a) => a - MAIN_DATA_BASE;

    uploadRawBank(md, off(raw.bootBank), tex, false);

    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const set = sets.length ? sets[sets.length - 1] : null;
    let pages = 1;
    if (set !== null) {
        const bank = cv.getUint32(raw.bankTable + set * 4, true);
        if (bank >= MAIN_DATA_BASE && off(bank) + SHEET_BYTES <= md.length) {
            uploadRawBank(md, off(bank), tex, true);
            pages++;
        }
        for (let i = 0; i < RAW_PATCH_AT.length; i++) {
            const src = cv.getUint32(raw.patchTable + set * 32 + i * 4, true);
            if (!src || off(src) + 0x2000 > md.length) continue;
            /* The source is packed: 64 rows of 128 bytes, back to back. */
            const [x, y] = RAW_PATCH_AT[i];
            for (let r = 0; r < 64; r++) {
                const s = off(src) + r * 128;
                tex.set(md.subarray(s, s + 128), SHEET0 + (((y + r) << 9) + x) * 2);
            }
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * The set a model's own bank is drawn under, for a game that says.
 *
 * Tile coverage cannot answer this for raw banks: they are dense, and nearly
 * every tile of every set holds something. What does answer it is the stage
 * data. Each section names the set it loads and the zones it shows, and the
 * zones name the models, so every placed model can be put under the set it is
 * drawn with — and they sort by bank. The table's empty entries divide it into
 * banks, bank k is drawn under set k, and bank 0, the shared one, textures only
 * from sheet 0 and so takes whichever set `bankSets[0]` names.
 *
 * @returns {number|null} the set, or null for a game without banks
 */
export function bankTextureSet(rom, index) {
    const bankSets = rom.game.texture.bankSets;
    if (!bankSets) return null;
    /* A table that repeats itself repeats its banks, so count the first copy. */
    const half = rom.game.modelNames?.count ?? rom.game.modelTable.count;
    if (!rom.modelBanks) {
        const t = rom.game.modelTable;
        const dv = rom.mainDataView;
        const starts = [0];
        for (let i = 0; i < half; i++) {
            const o = t.offset + i * t.stride;
            let empty = true;
            for (let k = 0; k < t.stride && empty; k += 4) empty = dv.getUint32(o + k, true) === 0;
            if (empty) starts.push(i + 1);
        }
        rom.modelBanks = starts;
    }
    const i = index % half;
    let bank = 0;
    for (let b = 0; b < rom.modelBanks.length && rom.modelBanks[b] <= i; b++) bank = b;
    return bankSets[Math.min(bank, bankSets.length - 1)];
}

/* ---- Last Bronx ----------------------------------------------------------- */

/*
 * Last Bronx keeps its texels in the data ROMs, a stage's in one LZ stream and
 * a fighter's page raw, and writes both itself. The program's own data section,
 * the RAM 0x500000 on, is copied out of the program ROM at boot (`data`), so a
 * RAM address the routines read is a program ROM offset here.
 *
 *   0x81C0  the stage's stream: a 16-bit flag word, its top bit first, then a
 *           literal halfword for a set bit, or for a clear one a signed
 *           halfword t naming (t & 15) + 2 halfwords of the 4096 last written
 *           from window position t >> 4 (the write position starts at 1)
 *   0x8320  where the stream goes: rows of 0x20 bytes, a repeat count then
 *           runs, each run written to the current sheet at that sheet's own
 *           offset while the other sheet's offset skips the same length, and
 *           the sheets swapping after each run; a negative run swaps them
 *           once more. A row with no repeats ends the table.
 *   0x8620  a raw rectangle and its mips (0x8920), each level from where the
 *           last one ended in the source, on the other sheet
 *
 * The stage set-up loads the stage's bank, `ld 0x500010[ld 0x5042B0[stage*4]*4]`,
 * three for nine stages, then three rectangles on sheet 1: the common page
 * `ld 0x500030` at row 0x100, player 1's page at row 0 and player 2's at
 * row 512, a page being `ld 0x500030[n*4]` for the fighter record's word 7
 * (0x1C). Checked against MAME's texture RAM: no byte differs.
 */
function lbRam(raw, addr) {
    return addr - raw.data.ram + raw.data.rom;
}

/* 0x81C0's stream, a halfword a call. */
function lbStream(md, at) {
    const win = new Uint16Array(4096);
    let wi = 1, flags = 0, bits = 0, run = 0, from = 0;
    const hw = () => {
        if (at + 2 > md.length) { at += 2; return 0; }
        const v = md[at] | (md[at + 1] << 8);
        at += 2;
        return v;
    };
    return () => {
        let v;
        if (run) {
            v = win[from++ & 0xfff];
            run--;
        } else {
            if (!bits) { flags = hw(); bits = 16; }
            const lit = flags & 0x8000;
            flags = (flags << 1) & 0xffff;
            bits--;
            if (lit) {
                v = hw();
            } else {
                const t = (hw() << 16) >> 16;
                from = t >> 4;
                run = (t & 15) + 1;
                v = win[from++ & 0xfff];
            }
        }
        win[wi] = v;
        wi = (wi + 1) & 0xfff;
        return v;
    };
}

/* 0x8320's deal: the stage bank's stream across the two sheets. */
function lbBank(rom, tex, src) {
    const raw = rom.game.texture.raw;
    const cv = rom.mainCpuView;
    const next = lbStream(rom.mainData, src);
    const off = [0, 0];
    let cur = 0;
    for (let t = raw.deal; t + 4 <= rom.maincpu.length; t += 0x20) {
        const rows = cv.getInt32(t, true);
        if (rows <= 0) break;
        for (let r = 0; r < rows; r++) {
            let n = 0;
            for (let q = t + 4; q + 4 <= rom.maincpu.length; q += 4) {
                n = cv.getInt32(q, true);
                if (n <= 0) break;
                off[cur ^ 1] += n * 2;
                const base = cur ? SHEET1 : SHEET0;
                for (let i = 0; i < n; i++, off[cur] += 2) {
                    const v = next();
                    if (off[cur] + 2 > SHEET_BYTES) continue;
                    tex[base + off[cur]] = v & 0xff;
                    tex[base + off[cur] + 1] = v >> 8;
                }
                cur ^= 1;
            }
            if (n < 0) cur ^= 1;
        }
    }
}

/*
 * 0x8620 (sheet, y, x, h, w, source): y and x in 16-row and 16-halfword steps,
 * h and w in texels. x past 0x1FF folds onto rows 512 on. Each mip goes on
 * the other sheet, towards (0x400, 0x200) and folded the same way.
 */
function lbRect(md, tex, sheet, y, x, h, w, src) {
    y = (y & 31) << 4;
    x = (x & 63) << 4;
    let near = sheet ? SHEET1 : SHEET0, far = sheet ? SHEET0 : SHEET1;
    const copy = (base, d) => {
        for (let r = 0; r < h; r++, src += w * 2) {
            const at = d + r * ROW_PAIR;
            if (src + w * 2 > md.length || at + w * 2 > SHEET_BYTES) return;
            tex.set(md.subarray(src, src + w * 2), base + at);
        }
    };
    h >>= 1;
    w >>= 1;
    copy(near, (x > 0x1ff ? 0x7fc00 + x * 2 : x * 2) + (y << 10));
    h >>= 1;
    w >>= 1;
    while (h || w) {
        y = 0x200 - ((0x200 - y) >> 1);
        x = 0x400 - ((0x400 - x) >> 1);
        [near, far] = [far, near];
        copy(near, 0x7fc00 + x * 2 + (y << 10));
        h >>= 1;
        w >>= 1;
    }
}

/* A fighter's page number, its record's word 7. */
function lbFighterPage(rom, f) {
    const raw = rom.game.texture.raw;
    return rom.mainCpuView.getUint32(raw.chars + f.char * raw.charStride + 0x1c, true);
}

/*
 * Texture RAM for Last Bronx: a stage's bank, with the common page and the
 * two fighters' pages over it (what a set stands for: lastbrnxScene).
 */
function buildLastbrnxTexram(rom, texSets, wanted) {
    const raw = rom.game.texture.raw;
    const cv = rom.mainCpuView;
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const { stage, fighters } = lastbrnxScene(rom, sets.length ? sets[sets.length - 1] : -1, wanted);
    const word = (addr) => cv.getUint32(lbRam(raw, addr), true);
    const page = (n) => word(raw.pages + n * 4) - MAIN_DATA_BASE;
    lbBank(rom, tex, word(raw.banks + word(raw.stageBanks + stage * 4) * 4) - MAIN_DATA_BASE);
    const [p1, p2] = fighters;
    lbRect(md, tex, 1, 48, 0, 0x200, 0x400, page(0));
    if (p1) lbRect(md, tex, 1, 32, 0, 0x200, 0x400, page(lbFighterPage(rom, p1)));
    if (p2) lbRect(md, tex, 1, 32, 32, 0x200, 0x400, page(lbFighterPage(rom, p2)));
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages: 4 };
}

/*
 * Whose part each Last Bronx model is, by the fighter records' model lists
 * (words `lists`, pointers into the model table). A fighter's body models run
 * on from the first its list names to the next fighter's first, the copies
 * for player 2's page among them, and the ones no list names in that run
 * (alternate hands and faces) are the fighter's too.
 */
function lastbrnxOwners(rom) {
    if (rom.lastbrnxOwners) return rom.lastbrnxOwners;
    const raw = rom.game.texture.raw;
    const t = rom.game.modelTable;
    const cv = rom.mainCpuView;
    const len = rom.maincpu.length;
    const owner = new Map();
    const chars = (rom.game.texture.sets - raw.stages) >> 1;
    const first = [];
    let last = -1;
    for (let c = 0; c < chars; c++) {
        let lo = Infinity;
        for (const w of raw.lists) {
            const list = lbRam(raw, cv.getUint32(raw.chars + c * raw.charStride + w * 4, true));
            for (let k = 0; k < raw.listLength && list >= 0 && list + k * 4 + 4 <= len; k++) {
                const p = cv.getUint32(list + k * 4, true) - t.offset;
                if (p < 0 || p % t.stride || p / t.stride >= t.count) continue;
                const m = p / t.stride;
                if (!owner.has(m)) owner.set(m, c);
                if (w === raw.lists[0]) lo = Math.min(lo, m);
                last = Math.max(last, m);
            }
        }
        first.push(lo);
    }
    for (let c = 0; c < chars; c++) {
        const end = c + 1 < chars ? first[c + 1] : last + 1;
        for (let m = first[c]; m < end; m++) if (!owner.has(m)) owner.set(m, c);
    }
    return (rom.lastbrnxOwners = owner);
}

/*
 * A lone Last Bronx model. A fighter's part (lastbrnxOwners) takes the set of
 * that fighter alone, costume 0. Another one that samples only the fighters'
 * and the common pages (sheet 1, rows 0..511, and player 2's rows 512..767)
 * is the same under every stage. The rest are on a stage's bank, and nothing
 * found says which stage's.
 */
function lastbrnxModelSets(rom, index, decoded) {
    if (!decoded) return null;
    let any = false, bank = false;
    for (let i = 0; i < decoded.tiles.length; i += 4) {
        if (!decoded.tiles[i + 2]) continue;
        any = true;
        const x = decoded.tiles[i], y = decoded.tiles[i + 1];
        if (y < SHEET_H || (x >= 1024 && y - SHEET_H >= 512)) bank = true;
    }
    if (!any) return { sets: [], how: 'untextured' };
    const c = lastbrnxOwners(rom).get(index);
    if (c !== undefined) return { sets: [rom.game.texture.raw.stages + 2 * c], how: 'lbfighter', char: c };
    return bank ? null : { sets: [rom.game.texture.defaultSet], how: 'pages' };
}

/* ---- The sets the program loads for a lone model ------------------------- */

/*
 * Air Walkers: a model on a team's page (rows 512..767, x past 1023 in the
 * atlas) is on the home side's sheet 0 or the away side's sheet 1, and opens
 * on team 0 of that side. The intro's city and dome, `titleModels` (MAME's
 * draw log at 0x1E8E4, 15 to 30 seconds after boot), are drawn on the title's
 * page. The rest sample the boot pages, which every court has.
 */
function airwlkrsModelSets(raw, index, decoded) {
    if (!decoded) return null;
    let home = false, away = false, any = false;
    for (let i = 0; i < decoded.tiles.length; i += 4) {
        if (!decoded.tiles[i + 2]) continue;
        any = true;
        if (decoded.tiles[i] < 1024 || (decoded.tiles[i + 1] & 1023) >= 512) continue;
        if (decoded.tiles[i + 1] >= SHEET_H) away = true; else home = true;
    }
    if (!any) return { sets: [], how: 'untextured' };
    const [lo, hi] = raw.titleModels;
    if (index >= lo && index <= hi) return { sets: [raw.titleSet], how: 'title' };
    if (home) return { sets: [0], how: 'home' };
    if (away) return { sets: [17], how: 'away' };
    return { sets: [0], how: 'boot' };
}

/*
 * The fighters' own sets, model by model: Fighting Vipers' player set-up
 * (0x1243C) takes the character record `ld 0x640D2B0[char*4]`, copies the
 * sixteen part models listed at its +0 into the player, and hands its +0x20 to
 * the texture request at 0x4B0FC; the handler (0x4B1C0) loads that set and the
 * next one into the player's slot. Set 0 is the untextured characters'.
 * Virtua Fighter 2 keeps its records in the data region proper, where there is
 * no extra window to read them through.
 */
function fighterSets(rom) {
    if (rom.fighterSets) return rom.fighterSets;
    const F = rom.game.texture.fighters;
    const rd = rom.game.xtra
        ? (a) => { const r = xtraResolve(rom, a); return r.view.getUint32(r.off, true); }
        : (a) => rom.mainDataView.getUint32(a - MAIN_DATA_BASE, true);
    const owners = new Map();
    for (let c = 0; c < F.count; c++) {
        const rec = rd(F.records + c * 4);
        const set = rd(rec + F.set);
        if (!set) continue;
        const list = rd(rec + F.parts);
        for (let k = 0; k < F.partCount; k++) {
            const m = rd(list + k * 4);
            if (!owners.has(m)) owners.set(m, new Set());
            owners.get(m).add(set);
        }
    }
    rom.fighterSets = owners;
    return owners;
}

/** The set each fighter's pair starts at, in character order, without repeats. */
export function fighterSetList(rom) {
    if (!rom.game.texture.fighters) return [];
    return [...new Set([...fighterSets(rom).values()].flatMap((s) => [...s]))].sort((a, b) => a - b);
}

/* Sega Rally's course lists, model -> course: the sky and the near and far
 * segment lists out of each course's records (stageTable.rally). */
function rallyCourseModels(rom) {
    if (rom.rallyCourses) return rom.rallyCourses;
    const C = rom.game.stageTable?.rally;
    const map = new Map();
    if (C) {
        const v = rom.mainCpuView;
        const word = (a) => v.getUint32(a, true);
        for (let c = 0; c < C.count; c++) {
            map.set(word(word(C.near + c * C.stride) - C.ramBase + 4), c);
            for (const t of [C.near, C.far]) {
                const list = word(t + c * C.stride + 8) - C.ramBase;
                for (let i = 0; i < C.segments; i++) {
                    const m = word(list + i * 4);
                    if (!m) break;
                    map.set(m, c);
                }
            }
        }
    }
    rom.rallyCourses = map;
    return map;
}

/**
 * The sets the board has resident when it draws a model no stage record
 * names, where the program says which.
 *
 * - A model that samples no texture needs none; `how` 'untextured'.
 * - A fighter's part (above) is drawn on the boot set and its pair, N and N+1.
 * - A model whose every tile lies on the boot set's pages is drawn on the
 *   boot set, which send_tex_default loads before anything else and no
 *   request asks for again.
 * - Daytona USA: a model on sheet 1 alone is on the bank boot uploads there
 *   (0x1454) and no course replaces, so every course draws it the same. One on
 *   sheet 0 takes the bank sel_course picks (0x1438, `ld 0x15A0[course*4]`),
 *   and the course is the one whose object records name it.
 * - Air Walkers: see airwlkrsModelSets.
 * - Last Bronx: see lastbrnxModelSets.
 * - Power Sled: there is one texture RAM, so a model that samples any is on it.
 * - Pilot Kids: an untextured model only; nothing yet ties a model to a scene.
 *
 * @returns {{sets:number[], how:string}|null} null where nothing says
 */
export function programTextureSets(rom, index, decoded) {
    const T = rom.game.texture;
    if (T.raw?.layout === 'daytona') {
        if (!decoded) return null;
        let sheet0 = false, sheet1 = false;
        for (let i = 0; i < decoded.tiles.length; i += 4) {
            if (!decoded.tiles[i + 2]) continue;
            if (decoded.tiles[i + 1] >= SHEET_H) sheet1 = true; else sheet0 = true;
        }
        if (!sheet0 && !sheet1) return { sets: [], how: 'untextured' };
        if (!sheet0) return { sets: [], how: 'boot' };
        const courses = courseNamedModels(rom).get(index);
        return courses?.size === 1 ? { sets: [...courses], how: 'course' } : null;
    }
    if (T.raw?.layout === 'airwlkrs') return airwlkrsModelSets(T.raw, index, decoded);
    if (T.raw?.layout === 'lastbrnx') return lastbrnxModelSets(rom, index, decoded);
    /* Pilot Kids: nothing read yet says which scene a model is drawn in, so
     * only an untextured one is answered; the rest open on the title's set. */
    if (T.raw?.layout === 'pltkids') {
        return decoded && !sampledTiles(decoded).length ? { sets: [], how: 'untextured' } : null;
    }
    if (T.raw?.layout === 'copy') {
        if (!decoded) return null;
        return { sets: sampledTiles(decoded).length ? [0] : [], how: sampledTiles(decoded).length ? 'only' : 'untextured' };
    }
    /* Sega Rally the other way round: the boot bank's full size is on sheet 0
     * and a course's on sheet 1. A sheet-1 model in one of the course lists
     * (readRallyStages in js/stages.js) takes that course's bank; the cars and
     * the rest of what is on sheet 1 are left to the picker. */
    if (T.raw?.layout === 'srallyc') {
        if (!decoded) return null;
        let sheet0 = false, sheet1 = false;
        for (let i = 0; i < decoded.tiles.length; i += 4) {
            if (!decoded.tiles[i + 2]) continue;
            if (decoded.tiles[i + 1] >= SHEET_H) sheet1 = true; else sheet0 = true;
        }
        if (!sheet0 && !sheet1) return { sets: [], how: 'untextured' };
        if (!sheet1) return { sets: [], how: 'boot' };
        const course = rallyCourseModels(rom).get(index);
        return course != null ? { sets: [course], how: 'course' } : null;
    }
    if (T.raw || T.bankSets) return null;
    if (!decoded) return null;
    const want = sampledTiles(decoded);
    if (!want.length) return { sets: [], how: 'untextured' };
    const boot = T.bootSet;
    if (T.fighters) {
        const sets = fighterSets(rom).get(index);
        if (sets?.size === 1) {
            const n = [...sets][0];
            return { sets: [boot, n, n + 1], how: 'fighter' };
        }
    }
    if (boot != null && tilesCovered(rom, want, [boot]) === want.length / 2) {
        return { sets: [boot], how: 'boot' };
    }
    return null;
}

/**
 * Unpack one or more texture sets into a pair of sheets.
 *
 * A stage names two texture numbers (its record's +0x0C and +0x0E) and the
 * game queues both, so they land in the same texture RAM — one set's full-size
 * pages share a sheet with the other's mip chain. Pass both to reproduce what
 * the hardware actually holds while that stage is on screen.
 *
 * @param {object} rom              loaded ROM set
 * @param {number|number[]} texSets texture number(s), each 0..0x11
 * @param {{char:number, costume?:number}[]} [fighters]  the fighters on
 *                                  screen, player 1 first
 *                                  (Dead or Alive's sheets hold theirs)
 * @returns {{sheet0: Uint8Array, sheet1: Uint8Array, pages: number}}
 */
export function buildTexram(rom, texSets, fighters) {
    if (rom.game.texture.raw) {
        const layout = rom.game.texture.raw.layout;
        if (layout === 'daytona') return buildDaytonaTexram(rom, texSets);
        if (layout === 'doa') return buildDoaTexram(rom, texSets, fighters);
        if (layout === 'airwlkrs') return buildAirwlkrsTexram(rom, texSets);
        if (layout === 'lastbrnx') return buildLastbrnxTexram(rom, texSets, fighters);
        if (layout === 'copy') return buildCopyTexram(rom);
        if (layout === 'pltkids') return buildPltkidsTexram(rom, texSets);
        if (layout === 'von') return buildVonTexram(rom, texSets);
        if (layout === 'srallyc') return buildSrallycTexram(rom, texSets);
        if (layout === 'dynamcop') {
            const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
            return buildDynamcopTexram(rom, sets.length ? sets[sets.length - 1] : 0);
        }
        return buildRawTexram(rom, texSets);
    }
    const md = rom.mainData;
    const dv = rom.mainDataView;
    const off = (a) => a - MAIN_DATA_BASE;
    const TEX_HEADER = rom.game.texture.header;

    const tex = new Uint8Array(SHEET_BYTES * 2);

    const lut = new Int32Array(0x100);
    for (let i = 0; i < 0x100; i++) lut[i] = dv.getInt32(TEX_HEADER + 0x10 + i * 4, true);

    let pages = 0;
    for (const texSet of [].concat(texSets)) {
        for (const { pagePtr, origin, x, y } of setPages(rom, texSet)) {
            const dest = pageDestinations(y, x, origin & 1);
            const type = dv.getUint32(off(pagePtr), true);
            const body = off(pagePtr) + 4;

            if (type !== 0) {
                sendBetaData(md, body, tex, dest);
            } else {
                const page = unpackLodData(md, body, lut);
                if (!page) continue;
                sendLodData(tex, dest[0], page);
                sendLodDataQ(tex, dest, page);
            }
            pages++;
        }
    }

    return {
        sheet0: tex.subarray(0, SHEET_BYTES),
        sheet1: tex.subarray(SHEET_BYTES),
        pages,
    };
}
