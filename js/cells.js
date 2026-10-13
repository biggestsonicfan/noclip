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
 *
 * Daytona USA has the same tile chip and the same list formats, but no
 * pattern table: its draw routine (0x19304 in Revision A) takes the record's
 * address, and the records lie end to end in one run of the data ROM
 * (`records`), so a cell is the record's place in that run. Its halfword at
 * 0x02 says how wide an entry is: 0 a byte, anything else a halfword. Its CGs
 * are pointers to a pair of (CG list, palette list), in two tables
 * (`cgTables`); `cgExtra` names a CG list the loader puts in before one of
 * them, and `cgPairs` pairs the code names directly. See js/games.js
 * DAYTONA_CELLS.
 */

import { loadScrollCG, scrollAt, scrollPtrOk, CHAR_MASK, TILE_BYTES } from './scroll.js';
import { palette555ToBytes } from './atlas.js';

const PAL_BASE = 0x01800000;    /* the tile chip's palette RAM */
const MAX_CELLS = 1023;         /* dsp_pattern_new's bound */
const CG_ENTRIES = 0xb8;        /* _ScrollCG_Initialize's bound */
const ROW_BYTES = 0x80;         /* the tilemap's row, 64 entries */
const MAX_SIDE = 64;            /* the tilemap is 64 entries square */

const word = (rom, addr) => { const t = scrollAt(rom, addr); return t.view.getUint32(t.off, true); };

/* Each cell's record address, worked out once per ROM set. */
const recordCache = new WeakMap();
function cellRecords(rom) {
    let out = recordCache.get(rom);
    if (out) return out;
    const C = rom.game.cells;
    out = [];
    if (C.records) {
        for (const [first, end] of C.records) {
            for (let a = first; a < end && out.length < MAX_CELLS;) {
                const size = recordSize(rom, a);
                if (!size) break;
                out.push(a);
                a += size;
            }
        }
    } else {
        while (out.length < MAX_CELLS && scrollPtrOk(rom, C.patternTable + out.length * 4)) {
            const p = word(rom, C.patternTable + out.length * 4);
            if (!p || !scrollPtrOk(rom, p)) break;
            out.push(p);
        }
    }
    recordCache.set(rom, out);
    return out;
}

/* A record's header: the base, the entry width, the rows and the columns.
 * Null where it is no record. */
function recordHeader(rom, p) {
    if (!scrollPtrOk(rom, p)) return null;
    const R = scrollAt(rom, p);
    if (R.off + 0x0c > R.u8.length) return null;
    const rows = R.view.getUint32(R.off + 4, true);
    const cols = R.view.getUint32(R.off + 8, true);
    if (!rows || !cols || rows > MAX_SIDE || cols > MAX_SIDE) return null;
    const wide = !rom.game.cells.records || R.view.getUint16(R.off + 2, true) !== 0;
    const bytes = 0x0c + rows * cols * (wide ? 2 : 1);
    if (R.off + bytes > R.u8.length) return null;
    return { R, base: R.view.getUint16(R.off, true), wide, rows, cols, bytes };
}

const recordSize = (rom, p) => recordHeader(rom, p)?.bytes ?? 0;

/** How many cells there are: up to the pattern table's terminating zero, or
 * every record in the game's runs of them. */
export function cellCount(rom) {
    return rom.game.cells ? cellRecords(rom).length : 0;
}

/** The cells the game never draws: those whose record's address no aligned
 * word of the program or data ROM holds. Daytona's draw calls take their
 * record from an `lda` or from a table of absolute pointers (js/games.js
 * DAYTONA_CELLS). Sonic The Fighters' cells all come through its pattern
 * table, so none of its count. */
const unusedCache = new WeakMap();
export function unusedCells(rom) {
    let out = unusedCache.get(rom);
    if (out) return out;
    out = new Set();
    if (rom.game.cells?.records) {
        const records = cellRecords(rom);
        const index = new Map(records.map((a, i) => [a, i]));
        const named = new Set();
        for (const v of [rom.mainCpuView, rom.mainDataView]) {
            for (let o = 0; o + 4 <= v.byteLength; o += 4) {
                const i = index.get(v.getUint32(o, true));
                if (i !== undefined) named.add(i);
            }
        }
        records.forEach((_, i) => { if (!named.has(i)) out.add(i); });
    }
    unusedCache.set(rom, out);
    return out;
}

/* Every CG's lists: the tile lists, loaded in order, and the palette list. */
const cgCache = new WeakMap();
function cgListsAll(rom) {
    let all = cgCache.get(rom);
    if (all) return all;
    const C = rom.game.cells;
    all = [];
    const pairAt = (pair, name, extra) => ({
        tiles: [extra, word(rom, pair)].filter(Boolean), pal: word(rom, pair + 4), name,
    });
    if (C.cgTables) {
        for (const [table, count] of C.cgTables) {
            for (let i = 0; i < count; i++) {
                const n = all.length;
                all.push(pairAt(word(rom, table + i * 4), C.cgNames?.[n], C.cgExtra?.[n]));
            }
        }
        for (let course = (C.courses?.count ?? 0) - 1; course >= 0; course--) {
            const L = all[courseCG(rom, course)];
            if (L) L.course = course;
        }
        for (const [pair, name] of C.cgPairs ?? []) all.push(pairAt(pair, name));
    } else {
        for (let cg = 0; cg < CG_ENTRIES / 2; cg++) {
            const tiles = word(rom, C.cgTable + cg * 8);
            all.push(tiles ? { tiles: [tiles], pal: word(rom, C.cgTable + cg * 8 + 4) } : null);
        }
    }
    cgCache.set(rom, all);
    return all;
}

/** How many CGs there are: entry pairs below _ScrollCG_Initialize's bound, or
 * the game's tables of them. */
export function cgCount(rom) {
    return rom.game.cells ? cgListsAll(rom).length : 0;
}

/** What the panel calls CG n: its number, and the game's name for it if the
 * profile has one. */
export function cgLabel(rom, cg) {
    const name = rom.game.cells ? cgLists(rom, cg)?.name : null;
    return name ? `CG ${cg} (${name})` : `CG ${cg}`;
}

/**
 * A cell's record: its size in tiles and its entries, base added.
 * @returns {null|{cols:number, rows:number, entries:Uint16Array}}
 */
export function readCell(rom, cell) {
    const p = cellRecords(rom)[cell];
    const h = p === undefined ? null : recordHeader(rom, p);
    if (!h) return null;
    const { R, base, wide, rows, cols } = h;
    const entries = new Uint16Array(rows * cols);
    for (let i = 0; i < entries.length; i++) {
        const v = wide ? R.view.getUint16(R.off + 0x0c + i * 2, true) : R.u8[R.off + 0x0c + i];
        entries[i] = (v + base) & 0xffff;
    }
    return { cols, rows, entries };
}

/* The lists of CG n, or null for an empty slot. */
function cgLists(rom, cg) {
    return cg >= 0 ? cgListsAll(rom)[cg] ?? null : null;
}

/* The bank CG a Daytona course's race start streams in. */
function courseCG(rom, course) {
    const C = rom.game.cells;
    return (word(rom, C.courses.cgs + course * 4) - C.cgTables[0][0]) / 4;
}

/* What loading CG n leaves in the tile chip: its tile lists one after
 * another, then its palette, and a course CG's flash over that. */
function loadCG(rom, L) {
    const out = loadTiles(rom, L);
    if (L.course !== undefined) flashCourse(rom, out, L.course);
    return out;
}

function loadTiles(rom, L) {
    const charBytes = rom.game.cells.charBytes;
    if (L.tiles.length === 1) return loadScrollCG(rom, L.tiles[0], L.pal, charBytes);
    const parts = L.tiles.map((t, i) => loadScrollCG(rom, t, i === L.tiles.length - 1 ? L.pal : 0, charBytes));
    const out = parts[parts.length - 1];
    for (const r of parts.slice(0, -1)) {
        for (const [first, n] of r.charRuns) {
            out.chars.set(r.chars.subarray(first * TILE_BYTES, (first + n) * TILE_BYTES), first * TILE_BYTES);
        }
        out.charRuns = r.charRuns.concat(out.charRuns);
    }
    return out;
}

/* A course CG's palette list writes nothing into the groups its picture
 * uses: the race start's palette cycle fills them (0x26C20 in Revision A),
 * from a record per course in `flash.table`, {group count, colours, first
 * group's address}, every group taking the same 16 colours, the step's.
 * `flash.also` are blocks the same for every course, [colours, address,
 * groups]. Before the first frame the game shows step `flash.step`, and so
 * does the panel. */
function flashCourse(rom, out, course) {
    const F = rom.game.cells.courses.flash;
    const t = F.table + course * 16;
    for (const [src, dest, groups] of [[word(rom, t + 4), word(rom, t + 8), word(rom, t)], ...F.also]) {
        const s = scrollAt(rom, src + F.step * 32);
        const first = (dest - PAL_BASE) >> 1;
        for (let i = 0; i < groups * 16; i++) out.pal[first + i] = s.view.getUint16(s.off + (i & 15) * 2, true);
        out.palRuns.push([first, groups * 16]);
    }
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
        const { charRuns, palRuns } = loadCG(rom, L);
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
    const C = rom.game.cells;
    /* Each table's [cell, CG] pairs, in the order they win. */
    const pairs = [
        ...cardCGs(rom, C.cards), ...portraitCGs(rom, C.portraits), ...tipCGs(rom, C.tips),
        ...plateCGs(rom, C.names), ...courseCGs(rom, C.courses),
        ...(C.screens ?? []).flatMap(({ cg, cells }) => cells.map((cell) => [cell, cg])),
    ];
    for (const [cell, cg] of pairs) if (!map.has(cell)) map.set(cell, cg);
    gameCache.set(rom, map);
    return map;
}

const u16 = (rom, addr) => rom.mainCpuView.getUint16(addr, true);

function cardCGs(rom, K) {
    const out = [];
    for (const [cells, cgs] of K?.tables ?? []) {
        for (let i = 0; i < K.count; i++) {
            const cell = u16(rom, cells + i * 2);
            const cg = u16(rom, cgs + i * 2) >> 1;
            out.push([cell, cg], [cell - 1, cg]);
        }
    }
    return out;
}

function portraitCGs(rom, P) {
    const out = [];
    for (let i = 0; i < (P?.count ?? 0); i++) {
        const frames = rom.mainCpuView.getUint32(P.list + i * 4, true);
        for (let f = 0; f < P.frames; f++) out.push([u16(rom, frames + f * 2), P.cg]);
    }
    return out;
}

function tipCGs(rom, T) {
    const out = [];
    for (let i = 0; i < (T?.count ?? 0); i++) out.push([rom.mainCpuView.getUint32(T.list + i * 4, true), T.cg]);
    return out;
}

/* Every plate first, then every twin. */
function plateCGs(rom, N) {
    const plates = [];
    for (const table of N?.tables ?? []) {
        for (let i = 0; i < N.count; i++) plates.push([u16(rom, table + i * 8 + 2), u16(rom, table + i * 8) >> 1]);
    }
    return plates.concat(plates.map(([cell, cg]) => [cell + 1, cg + 1]));
}

/* Daytona's course pictures: a cell per course, on that course's CG. */
function courseCGs(rom, R) {
    const out = [];
    const records = R ? cellRecords(rom) : [];
    for (let course = 0; course < (R?.count ?? 0); course++) {
        const cell = records.indexOf(word(rom, R.cells + course * 4));
        if (cell >= 0) out.push([cell, courseCG(rom, course)]);
    }
    return out;
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
        const r = loadCG(rom, L);
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
