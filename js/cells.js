/*
 * cells.js — the big 2D pictures the game lays out on the tile chip: title
 * screens, portraits, the character select, the win poses. The game calls them
 * cells; a cell is a block of tilemap, and the pixels and colours it names come
 * from a CG, so what a cell looks like depends on which CG was loaded with it.
 *
 * The two routines, read off the program ROM:
 *
 *   _Scroll_Initialize(g0)  loads CG list cgTable[g0] into the character RAM
 *                           and palette list cgTable[g0 + 1] into the palette
 *                           (js/scroll.js loadScrollCG). Callers always pass an
 *                           even number — "Set CG for Sega Logo (2x value of
 *                           CG)" — so CG n is entries 2n and 2n + 1, and the
 *                           routine ignores g0 >= 0xB8, which is 92 CGs.
 *   dsp_pattern_new(g0)     copies cell g0, patternTable[g0], to the tilemap
 *                           at g9. The record: a halfword added to every entry
 *                           (0x8000, the category bit, on all of them), the
 *                           row count at 0x04, the column count at 0x08, then
 *                           the entries row by row; each row goes 0x80 bytes
 *                           (64 entries) on in the tilemap. It ignores g0 >=
 *                           1023, and the table ends with a zero.
 *
 * A tilemap entry is read as js/scroll.js reads one: the character is the low
 * 14 bits and the palette group bits 7-14. Pen 0 is transparent, as it is over
 * the 3D on the board.
 *
 * The game often loads one CG on top of another — the game-over screen loads
 * CG 1 and then CG 81 — so a cell can need two. A CG fits a cell when it
 * writes every character and every colour the cell uses; `rankCGs` puts
 * those first, and the panel's second picker loads another CG under it.
 */

import { loadScrollCG, scrollAt, scrollPtrOk, CHAR_MASK, TILE_BYTES } from './scroll.js';
import { palette555ToBytes } from './atlas.js';

const MAX_CELLS = 1023;         /* dsp_pattern_new's bound */
const CG_ENTRIES = 0xb8;        /* _ScrollCG_Initialize's bound */
const ROW_BYTES = 0x80;         /* the tilemap's row, 64 entries */
const MAX_SIDE = 64;            /* the tilemap is 64 entries square */

const word = (rom, addr) => { const t = scrollAt(rom, addr); return t.view.getUint32(t.off, true); };

/** How many cells the pattern table holds: up to its terminating zero. */
export function cellCount(rom) {
    const C = rom.game.cells;
    if (!C) return 0;
    let n = 0;
    while (n < MAX_CELLS && scrollPtrOk(rom, C.patternTable + n * 4)) {
        const p = word(rom, C.patternTable + n * 4);
        if (!p || !scrollPtrOk(rom, p)) break;
        n++;
    }
    return n;
}

/** How many CGs there are: entry pairs below _ScrollCG_Initialize's bound. */
export function cgCount(rom) {
    return rom.game.cells ? CG_ENTRIES / 2 : 0;
}

/**
 * A cell's record: its size in tiles and its entries, base added.
 * @returns {null|{cols:number, rows:number, entries:Uint16Array}}
 */
export function readCell(rom, cell) {
    const C = rom.game.cells;
    const p = word(rom, C.patternTable + cell * 4);
    if (!p || !scrollPtrOk(rom, p)) return null;
    const R = scrollAt(rom, p);
    const base = R.view.getUint16(R.off, true);
    const rows = R.view.getUint32(R.off + 4, true);
    const cols = R.view.getUint32(R.off + 8, true);
    if (!rows || !cols || rows > MAX_SIDE || cols > MAX_SIDE) return null;
    if (R.off + 0x0c + rows * cols * 2 > R.u8.length) return null;
    const entries = new Uint16Array(rows * cols);
    for (let i = 0; i < entries.length; i++) {
        entries[i] = (R.view.getUint16(R.off + 0x0c + i * 2, true) + base) & 0xffff;
    }
    return { cols, rows, entries };
}

/* The list pointers of CG n, or null for an empty slot. */
function cgLists(rom, cg) {
    const C = rom.game.cells;
    if (cg < 0 || cg * 2 + 1 >= CG_ENTRIES) return null;
    const tiles = word(rom, C.cgTable + cg * 8);
    const pal = word(rom, C.cgTable + cg * 8 + 4);
    return tiles ? { tiles, pal } : null;
}

/* What each CG writes, worked out once per ROM set: the character RAM it
 * fills, and the palette entries. */
const coverCache = new WeakMap();
function cgCover(rom) {
    let all = coverCache.get(rom);
    if (all) return all;
    all = [];
    for (let cg = 0; cg < cgCount(rom); cg++) {
        const L = cgLists(rom, cg);
        if (!L) { all.push(null); continue; }
        const { charRuns, palRuns } = loadScrollCG(rom, L.tiles, L.pal, rom.game.cells.charBytes);
        all.push({ charRuns, palRuns });
    }
    coverCache.set(rom, all);
    return all;
}

const inRuns = (runs, i) => runs.some(([first, n]) => i >= first && i < first + n);

/* The CG the game itself draws a cell with, where its tables or its code say
 * (js/games.js cells.cards, .portraits, .tips, .names and .screens). A colour
 * card and its greyscale twin are the same tiles, so both CGs fit either one,
 * and only the tables tell them apart. Each card table names a player's small
 * card; the big one is the cell before it (129 and 130, 245 and 246) and takes
 * the same CG. Each name plate's twin is the cell and the CG after it. The
 * first table to name a cell wins. */
const gameCache = new WeakMap();
function gameCGs(rom) {
    let map = gameCache.get(rom);
    if (map) return map;
    map = new Map();
    const K = rom.game.cells.cards;
    for (const [cells, cgs] of K?.tables ?? []) {
        for (let i = 0; i < K.count; i++) {
            const cell = rom.mainCpuView.getUint16(cells + i * 2, true);
            const cg = rom.mainCpuView.getUint16(cgs + i * 2, true) >> 1;
            for (const c of [cell, cell - 1]) if (!map.has(c)) map.set(c, cg);
        }
    }
    const P = rom.game.cells.portraits;
    for (let i = 0; i < (P?.count ?? 0); i++) {
        const frames = rom.mainCpuView.getUint32(P.list + i * 4, true);
        for (let f = 0; f < P.frames; f++) {
            const cell = rom.mainCpuView.getUint16(frames + f * 2, true);
            if (!map.has(cell)) map.set(cell, P.cg);
        }
    }
    const T = rom.game.cells.tips;
    for (let i = 0; i < (T?.count ?? 0); i++) {
        const cell = rom.mainCpuView.getUint32(T.list + i * 4, true);
        if (!map.has(cell)) map.set(cell, T.cg);
    }
    const N = rom.game.cells.names;
    const plates = [];
    for (const table of N?.tables ?? []) {
        for (let i = 0; i < N.count; i++) {
            const cg = rom.mainCpuView.getUint16(table + i * 8, true) >> 1;
            const cell = rom.mainCpuView.getUint16(table + i * 8 + 2, true);
            plates.push([cell, cg]);
        }
    }
    for (const [cell, cg] of plates) if (!map.has(cell)) map.set(cell, cg);
    for (const [cell, cg] of plates) if (!map.has(cell + 1)) map.set(cell + 1, cg + 1);
    for (const { cg, cells } of rom.game.cells.screens ?? []) {
        for (const cell of cells) if (!map.has(cell)) map.set(cell, cg);
    }
    gameCache.set(rom, map);
    return map;
}

/**
 * How much of a cell each CG draws on its own, best first: the share of the
 * cell's tiles whose character and colours that CG writes. A cell's blank
 * tiles are character 0, which no CG writes, so they are not counted. A CG at
 * 1 fits the cell; one that draws none of it is left out. Among CGs that draw
 * equally much, the one the game uses for the cell comes first; among CGs
 * that fit and the game doesn't name, the one whose picture holds together
 * (seamScore).
 *
 * @returns {Array<{cg:number, cover:number}>}
 */
export function rankCGs(rom, cell) {
    const c = readCell(rom, cell);
    if (!c) return [];
    const cover = cgCover(rom);
    const used = new Map();
    for (const e of c.entries) {
        if (e & CHAR_MASK) used.set(e & 0x7fff, (used.get(e & 0x7fff) || 0) + 1);
    }
    let total = 0;
    for (const n of used.values()) total += n;
    const out = [];
    for (let cg = 0; cg < cover.length; cg++) {
        const k = cover[cg];
        if (!k || !total) continue;
        let hit = 0;
        for (const [e, n] of used) {
            const group = (e >> 7) & 0xff;
            if (inRuns(k.charRuns, e & CHAR_MASK) && inRuns(k.palRuns, group * 16 + 1)) hit += n;
        }
        if (hit) out.push({ cg, cover: hit / total });
    }
    const game = gameCGs(rom).get(cell);
    const own = (r) => (r.cg === game ? 0 : 1);
    out.sort((a, b) => b.cover - a.cover || own(a) - own(b) || a.cg - b.cg);
    const full = out.filter((r) => r.cover === 1);
    if (full.length < 2 || full[0].cg === game) return out;
    /* No table names one: the picture that holds together best. */
    const score = new Map(full.map((r) => [r.cg, seamScore(renderCell(rom, cell, [r.cg]))]));
    const best = Math.min(...score.values());
    const near = (r) => (score.get(r.cg) <= best * NEAR_TIE ? 0 : 1);
    full.sort((a, b) => near(a) - near(b) || (near(a) ? score.get(a.cg) - score.get(b.cg) : 0) || a.cg - b.cg);
    return full.concat(out.slice(full.length));
}

/* A CG that writes a cell's characters with another picture's tiles still
 * "fits" it, but draws a jumble: its tiles don't run on into each other. The
 * score is how much colour changes across the edges between tiles, against
 * how much it changes inside them; a right picture is near 1 or below, a
 * jumble well above. Almost no bright pixels is a starfield that one CG lays
 * over another picture's characters, and scores low only because it is dark;
 * it counts as a jumble. Scores within NEAR_TIE of the best are the same
 * picture in other colours (a colour card and its greyscale twin), and the
 * lower CG wins. */
const NEAR_TIE = 1.1;
function seamScore({ width: w, height: h, rgba: p }) {
    let lit = 0, opaque = 0;
    for (let k = 0; k < p.length; k += 4) {
        if (!p[k + 3]) continue;
        opaque++;
        if (Math.max(p[k], p[k + 1], p[k + 2]) > 96) lit++;
    }
    if (!opaque) return Infinity;
    const diff = (a, b) => {
        if (!p[a + 3] && !p[b + 3]) return -1;
        if (p[a + 3] !== p[b + 3]) return 255;
        return Math.abs(p[a] - p[b]) + Math.abs(p[a + 1] - p[b + 1]) + Math.abs(p[a + 2] - p[b + 2]);
    };
    let edge = 0, edges = 0, inner = 0, inners = 0;
    const add = (v, onEdge) => {
        if (v < 0) return;
        if (onEdge) { edge += v; edges++; } else { inner += v; inners++; }
    };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (x + 1 < w) add(diff(o, o + 4), (x & 7) === 7);
            if (y + 1 < h) add(diff(o, o + w * 4), (y & 7) === 7);
        }
    }
    const score = (edge / Math.max(edges, 1)) / (1 + inner / Math.max(inners, 1));
    return score + (lit < opaque * 0.05 ? 1 : 0);
}

/**
 * Draw a cell as the tile chip would with these CGs loaded, in order.
 *
 * @param {object} rom
 * @param {number} cell
 * @param {number[]} cgs     CG numbers, loaded one after another as the game
 *                           does; a later one overwrites what it shares
 * @param {?Uint8Array} cxlat  colour tables to put the palette through, as
 *                           palette_w does; null for the raw colours
 * @returns {null|{width:number, height:number, rgba:Uint8ClampedArray}}
 */
export function renderCell(rom, cell, cgs, cxlat = null) {
    const c = readCell(rom, cell);
    if (!c) return null;
    const charBytes = rom.game.cells.charBytes;
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    for (const cg of cgs) {
        const L = cgLists(rom, cg);
        if (!L) continue;
        const r = loadScrollCG(rom, L.tiles, L.pal, charBytes);
        for (const [first, n] of r.charRuns) {
            chars.set(r.chars.subarray(first * TILE_BYTES, (first + n) * TILE_BYTES), first * TILE_BYTES);
        }
        for (const [first, n] of r.palRuns) {
            const a = Math.max(first, 0), b = Math.min(first + n, pal.length);
            if (b > a) pal.set(r.pal.subarray(a, b), a);
        }
    }

    const width = c.cols * 8, height = c.rows * 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const rgb = new Int32Array(0x8000).fill(-1);
    for (let ty = 0; ty < c.rows; ty++) {
        for (let tx = 0; tx < c.cols; tx++) {
            const entry = c.entries[ty * c.cols + tx];
            const base = (entry & CHAR_MASK) * TILE_BYTES;
            const group = (entry >> 7) & 0xff;
            if (base + TILE_BYTES > chars.length) continue;
            for (let py = 0; py < 8; py++) {
                for (let px = 0; px < 8; px++) {
                    /* A halfword's left pixels are in its second byte; see
                     * js/scroll.js. */
                    const byte = chars[base + py * 4 + ((px >> 1) ^ 1)];
                    const nib = (px & 1) ? (byte & 15) : (byte >> 4);
                    if (!nib) continue;
                    const v = pal[group * 16 + nib] & 0x7fff;
                    if (rgb[v] < 0) {
                        const [r, g, b] = palette555ToBytes(cxlat, v);
                        rgb[v] = (r << 16) | (g << 8) | b;
                    }
                    const o = ((ty * 8 + py) * width + tx * 8 + px) * 4;
                    rgba[o] = rgb[v] >> 16;
                    rgba[o + 1] = (rgb[v] >> 8) & 255;
                    rgba[o + 2] = rgb[v] & 255;
                    rgba[o + 3] = 255;
                }
            }
        }
    }
    return { width, height, rgba };
}
