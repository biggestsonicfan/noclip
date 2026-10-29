/*
 * jalecocells.js — the tile chip's pictures in Jaleco's framework (Super GT
 * 24h, Over Rev), for js/cells.js (`files` in a game's cells).
 *
 * The data ROM holds a directory of CG files, a zero-ended list of pointers
 * (sgt24h data 0xE00000, Over Rev 0xD00000). The boot loads the first (sgt24h
 * 0x3CF8C, `ld 0x2E00000`; Over Rev 0x200FDC, in the RAM copy of the
 * program), and a scene loads another by its address (`lda`) through the
 * same loader (sgt24h 0x3C7B0, Over Rev 0x2007E0). A file:
 *
 *   +0x00  the tile list: a halfword it skips, a halfword block count, then
 *          the blocks, each a character RAM address, a tile count and the
 *          tiles, 32 bytes each, copied as they are
 *   +0x04  the palette list: a count of 16-colour groups, a palette RAM
 *          address and the colours
 *   +0x08  how many patterns the file has
 *   +0x0C  0, or a palette variant record, which the loader hands to
 *          0x3C0B0 (Over Rev 0x2000E0) with variant 0: a group count, a list
 *          of group numbers (halfwords), the variant count and the colours,
 *          16 to a group, variant v's `count * 32` bytes on from the first
 *   +0x10  the patterns' pointers
 *
 * A pattern is the width and the height as halfwords, a word the draw does
 * not read, then the entries row by row. The draw (sgt24h 0x3D370, Over Rev
 * 0x2013C0) takes the column and row, the pattern, the tilemap and a halfword
 * it ORs into every entry, and lays the rows 64 entries apart. Most callers
 * pass 0x8000, the category bit, and the cells are drawn so; 0xC000 (bit 14,
 * the group + 128) draws a menu item greyed, out of the variant record's
 * groups, and a few pass 0.
 *
 * The boot's file fills characters 0 up and groups 0 up; every scene's but
 * one starts at character 0x2000, group 64, so it is loaded over the boot's,
 * and the boot's stays. Each block is a 128-character group's worth and its
 * entries name that group, so a cell's colours are its own file's.
 *
 * The greyed items follow the files' cells: every pattern of a file with a
 * variant record whose groups, each + 128, are all in the record is offered
 * a second time, drawn with 0xC000 (sgt24h's course and lap buttons, Over
 * Rev's 6 x 7 mode icons).
 */

import { scrollAt, scrollPtrOk, TILE_BYTES } from './scroll.js';

const MAX_FILES = 64;
const MAX_PATTERNS = 1023;
const MAX_SIDE = 64;            /* the draw clips to the 64-entry tilemap */
const PAL_BASE = 0x01800000;
const CHAR_BASE = 0x01080000;
const PATTERN_HEAD = 8;

const word = (rom, a) => { const t = scrollAt(rom, a); return t.view.getUint32(t.off, true); };
const half = (rom, a) => { const t = scrollAt(rom, a); return t.view.getUint16(t.off, true); };

/* Every file: {at, tiles, pal, variant, patterns}. A pointer off the ROM
 * ends the directory. */
const fileCache = new WeakMap();
export function jalecoFiles(rom) {
    let out = fileCache.get(rom);
    if (out) return out;
    out = [];
    const dir = rom.game.cells.files.dir;
    for (let i = 0; i < MAX_FILES; i++) {
        const at = word(rom, dir + i * 4);
        if (!at || !scrollPtrOk(rom, at)) break;
        const count = Math.min(word(rom, at + 8), MAX_PATTERNS);
        const patterns = [];
        for (let k = 0; k < count; k++) patterns.push(word(rom, at + 0x10 + k * 4));
        out.push({ at, tiles: word(rom, at), pal: word(rom, at + 4), variant: word(rom, at + 12), patterns });
    }
    fileCache.set(rom, out);
    return out;
}

/* Every cell, {at, file, pattern, grey}: the files' patterns in directory
 * order, then the greyed ones, each with `of`, the cell it greys. */
const cellCache = new WeakMap();
export function jalecoCells(rom) {
    let out = cellCache.get(rom);
    if (out) return out;
    out = [];
    jalecoFiles(rom).forEach((f, file) => {
        f.patterns.forEach((at, pattern) => { if (scrollPtrOk(rom, at)) out.push({ at, file, pattern, grey: false }); });
    });
    cellCache.set(rom, out);
    const files = jalecoFiles(rom);
    const plain = out.length;
    for (let of = 0; of < plain; of++) {
        const c = out[of], v = files[c.file].variant;
        if (!v || !scrollPtrOk(rom, v)) continue;
        const groups = new Set();
        for (let g = word(rom, v) - 1; g >= 0; g--) groups.add(half(rom, word(rom, v + 4) + g * 2));
        const cell = readJalecoCell(rom, of);
        if (cell && cell.entries.every((e) => groups.has(((e >> 7) & 0x7f) + 128))) out.push({ ...c, grey: true, of });
    }
    return out;
}

/** A cell's size and entries, the draw's 0x8000 set (0xC000 when greyed). */
export function readJalecoCell(rom, cell) {
    const c = jalecoCells(rom)[cell];
    if (!c) return null;
    const R = scrollAt(rom, c.at);
    const cols = R.view.getUint16(R.off, true), rows = R.view.getUint16(R.off + 2, true);
    if (!cols || !rows || cols > MAX_SIDE || rows > MAX_SIDE) return null;
    if (R.off + PATTERN_HEAD + cols * rows * 2 > R.u8.length) return null;
    const entries = new Uint16Array(cols * rows);
    for (let i = 0; i < entries.length; i++) entries[i] = R.view.getUint16(R.off + PATTERN_HEAD + i * 2, true) | (c.grey ? 0xC000 : 0x8000);
    return { cols, rows, entries };
}

/** A greyed cell's name. */
export function jalecoCellName(rom, cell) {
    const c = jalecoCells(rom)[cell];
    return c?.grey ? `greyed ${c.of}` : '';
}

/** CG n is file n, over the boot's (file 0) for every other one. */
export function jalecoCGs(rom) {
    const hex = (a) => `data 0x${(a - 0x02000000).toString(16).toUpperCase()}`;
    return jalecoFiles(rom).map((f, n) => ({
        jaleco: n ? [0, n] : [0],
        name: n ? `${hex(f.at)} over the boot's` : `the boot's, ${hex(f.at)}`,
    }));
}

/** The CG a cell is drawn with: its own file's. */
export const jalecoCellCG = (rom, cell) => jalecoCells(rom)[cell]?.file ?? -1;

/** What loading the CG's files leaves in the tile chip, as the loader does. */
export function loadJalecoCG(rom, L, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    const files = jalecoFiles(rom);
    for (const n of L.jaleco) {
        const f = files[n];
        /* The tiles. */
        let b = f.tiles + 4;
        for (let k = half(rom, f.tiles + 2); k > 0 && scrollPtrOk(rom, b); k--) {
            const first = (word(rom, b) - CHAR_BASE) / TILE_BYTES, count = word(rom, b + 4);
            const T = scrollAt(rom, b + 8);
            const fit = Math.min(count, charBytes / TILE_BYTES - first);
            if (first < 0 || fit <= 0 || T.off + fit * TILE_BYTES > T.u8.length) break;
            chars.set(T.u8.subarray(T.off, T.off + fit * TILE_BYTES), first * TILE_BYTES);
            charRuns.push([first, fit]);
            b += 8 + count * TILE_BYTES;
        }
        /* The colours. */
        const groups = word(rom, f.pal), first = (word(rom, f.pal + 4) - PAL_BASE) / 2;
        const P = scrollAt(rom, f.pal + 8);
        const n16 = Math.min(groups * 16, pal.length - first, (P.u8.length - P.off) >> 1);
        for (let i = 0; i < n16; i++) pal[first + i] = P.view.getUint16(P.off + i * 2, true);
        if (n16 > 0) palRuns.push([first, n16]);
        /* Variant 0 over them. */
        if (f.variant && scrollPtrOk(rom, f.variant)) {
            const count = word(rom, f.variant), list = word(rom, f.variant + 4);
            const variants = word(rom, f.variant + 8), data = word(rom, f.variant + 12);
            for (let g = 0; variants > 0 && g < count; g++) {
                const group = half(rom, list + g * 2);
                const C = scrollAt(rom, data + g * 32);
                if (group * 16 + 16 > pal.length) continue;
                for (let c = 0; c < 16; c++) pal[group * 16 + c] = C.view.getUint16(C.off + c * 2, true);
                palRuns.push([group * 16, 16]);
            }
        }
    }
    return { chars, pal, written: 0, charRuns, palRuns };
}
