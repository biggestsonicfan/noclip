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

/* Texture RAM: two 1 MB sheets, each stored 1024x2048 and read as a logical
 * 2048x1024 (x >= 1024 folds back with y ^= 1024). One halfword is a 2x2 block
 * of 4-bit texels, so a texel row is 512 bytes and a row-pair is 0x400. */
export const SHEET_BYTES = 0x100000;
const SHEET0 = 0;
const SHEET1 = SHEET_BYTES;
const ROW_PAIR = 0x400;

/* main_data header at 0x300000. +0x08 and +0x0C are pointers to the
 * destination-list and page-list arrays; +0x10 is the 256-entry literal table
 * the Huffman symbols below 0x100 index. */
const TEX_HEADER = 0x300000;
const LUT_OFFSET = TEX_HEADER + 0x10;
const MAIN_DATA_BASE = 0x02000000;

/* Page origins in logical sheet coordinates, from the table at 0x4B394 in the
 * program ROM: 24 pages of 256x256, as (y, x) pairs. Read from the ROM rather
 * than hard-coded, since that is where the game reads it. */
const PAGE_TABLE = 0x4b394;

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
 * 1.. are the mip chain, which lives at +0xC0000 and alternates banks at every
 * level. A byte address in a sheet is y * 512 + x, and x >= 1024 folds to
 * y + 1024 — the same fold atlas.js undoes when it reads the sheets back.
 */
function pageDestinations(y, x, bank) {
    /* Bank bit 0 picks which sheet holds the full-size level; the mip chain
     * then alternates, so the two run in opposite phase. */
    let near = (bank & 1) ? SHEET0 : SHEET1;
    let far = (bank & 1) ? SHEET1 : SHEET0;

    const dest = [];

    if ((x & 0x400) && (y & 0x200)) {
        /* Folded page in the lower half: no full-size level, only mips. */
        x = (x & ~0x400) << 1;
        y = (y & ~0x200) << 1;
    } else {
        const off = (x & 0x400)
            ? (((y + 0x400) << 9) + (x & ~0x400))   /* fold x into y */
            : ((y << 9) + x);
        dest.push(near + off);
        [near, far] = [far, near];
    }

    near += 0xc0000;
    far += 0xc0000;

    let oy = 0, ox = 0;
    for (let level = 9; level >= 1; level--) {
        y = (y >> 1) & ~1;
        x = (x >> 1) & ~1;
        dest.push(near + (((oy + y) << 9) + (ox + x)));
        [near, far] = [far, near];
        const step = 1 << level;
        ox += step;
        oy += step >> 1;
    }
    return dest;
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
 * @returns {{sheet0: Uint8Array, sheet1: Uint8Array, pages: number}}
 */
export function buildTexram(rom, texSets) {
    const md = rom.mainData;
    const dv = rom.mainDataView;
    const cv = rom.mainCpuView;
    const off = (a) => a - MAIN_DATA_BASE;

    const tex = new Uint8Array(SHEET_BYTES * 2);

    const destTable = dv.getUint32(TEX_HEADER + 0x08, true);
    const pageTable = dv.getUint32(TEX_HEADER + 0x0c, true);

    const lut = new Int32Array(0x100);
    for (let i = 0; i < 0x100; i++) lut[i] = dv.getInt32(LUT_OFFSET + i * 4, true);

    let pages = 0;
    for (const texSet of [].concat(texSets)) {
        const setPtr = dv.getUint32(off(pageTable) + texSet * 4, true);
        if (!setPtr) continue;

        /* The set's first word selects which destination list its pages use;
         * the list starts with a count and then one packed origin per page. */
        const listIdx = dv.getUint32(off(setPtr), true);
        const listPtr = dv.getUint32(off(destTable) + listIdx * 4, true);
        const count = dv.getUint32(off(listPtr), true);

        for (let i = 0; i < count; i++) {
            const pagePtr = dv.getUint32(off(setPtr) + 4 + i * 4, true);
            if (!pagePtr) continue;

            /* Origin word: a page slot in its low half plus a byte offset in
             * each of the top two bytes, resolved against the ROM page grid. */
            const origin = dv.getUint32(off(listPtr) + 4 + i * 4, true);
            const slot = (origin & 0xffff) >>> 1;
            const y = cv.getInt16(PAGE_TABLE + slot * 4, true) + (origin >>> 24);
            const x = cv.getInt16(PAGE_TABLE + slot * 4 + 2, true) + ((origin >>> 16) & 0xff);

            const dest = pageDestinations(y, x, origin & 1);
            const type = dv.getUint32(off(pagePtr), true);
            const body = off(pagePtr) + 4;

            if (type !== 0) {
                sendBetaData(md, body, tex, dest);
            } else {
                const page = unpackLodData(md, body, lut);
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
