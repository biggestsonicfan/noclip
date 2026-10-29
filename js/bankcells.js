/*
 * bankcells.js — INDY 500's cells (js/cells.js `banks`).
 *
 * The game keeps its 2D in banks, each three tables the program indexes by
 * number: a table of CGs, {offset of the tiles from the bank's data, tile
 * count}; a table of pointers to cells, each Virtua Cop's record (the width
 * and the height as halfwords, then halfword entries); and, after the cells,
 * a table of each CG's palette. The loader (0x53790 for the data ROM's bank,
 * 0x53890 for XTRA's, in the Twin) hands a CG whole 128-tile blocks of
 * character RAM from a free list, copies its tiles there straight, and
 * notes the first block; its palette call (0x55F10) gives every block it took
 * its own group, the block's number, 16 colours each from the CG's list in
 * order. The draws (0x53E60, 0x548A0, 0x54300 and their siblings) take a
 * cell and a CG and add the CG's first block << 7 to every entry, so a cell
 * numbers its own CG's tiles from 0, and its groups from 0 too.
 *
 * So the panel loads a CG from block 0, as it does a Dead or Alive picture,
 * and a cell is drawn with the CG the program draws it with: `screens`,
 * from the calls that name both, or else the one around it in the table
 * that fits it (rankBankCGs).
 */

import { scrollAt, scrollPtrOk, TILE_BYTES } from './scroll.js';

const BLOCK = 128;              /* tiles to a block of character RAM */

const word = (rom, addr) => { const t = scrollAt(rom, addr); return t.view.getUint32(t.off, true); };

/* Every cell, {at, bank}, and every CG, {tiles, count, pal, bank, number},
 * banks one after another, worked out once per ROM set. */
const cache = new WeakMap();
export function bankTables(rom) {
    let out = cache.get(rom);
    if (out) return out;
    out = { cells: [], cgs: [] };
    rom.game.cells.banks.forEach((B, bank) => {
        out.cells.push(...Array.from({ length: B.cellCount }, (_, i) => ({ at: word(rom, B.cells + i * 4), bank, number: i })));
        for (let n = 0; n < B.cgCount; n++) {
            const off = word(rom, B.cgs + n * 8), count = word(rom, B.cgs + n * 8 + 4);
            const pal = word(rom, B.pals + n * 4);
            out.cgs.push(count && scrollPtrOk(rom, B.data + off) && pal && scrollPtrOk(rom, pal)
                ? { tiles: B.data + off, count, pal, bank, number: n, name: `${B.name} ${n}` }
                : null);
        }
    });
    /* `recolours`, after every bank's own: a CG's tiles with the colours
     * another palette call gives them (0x55F10 with g2 bit 0 writes the
     * groups 128 on, which a draw with g2 bit 14 picks), for the cells it
     * names. */
    let first = 0;
    rom.game.cells.banks.forEach((B, bank) => {
        for (const R of B.recolours ?? []) {
            const L = out.cgs[first + R.cg];
            if (L && scrollPtrOk(rom, R.pal)) {
                out.cgs.push({ ...L, pal: R.pal, recolour: R, name: `${B.name} ${R.cg}, ${R.name}` });
            }
        }
        first += B.cgCount;
    });
    cache.set(rom, out);
    return out;
}

/** A CG loaded from block 0: its tiles straight from character 0, and
 * (count >> 7) + 1 groups of colours from group 0, as 0x53790 and 0x55F10
 * count them. */
export function loadBankCG(rom, L, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const count = Math.min(L.count, charBytes / TILE_BYTES);
    const T = scrollAt(rom, L.tiles);
    chars.set(T.u8.subarray(T.off, Math.min(T.off + count * TILE_BYTES, T.u8.length)));
    const groups = (L.count >> 7) + 1;
    const P = scrollAt(rom, L.pal);
    for (let i = 0; i < groups * 16 && P.off + i * 2 + 2 <= P.u8.length; i++) pal[i] = P.view.getUint16(P.off + i * 2, true);
    return { chars, pal, written: groups * 16, charRuns: [[0, count]], palRuns: [[0, groups * 16]] };
}

/* Whether CG L holds every tile and group cell c names. */
function fits(c, L) {
    if (!L) return false;
    const groups = (L.count >> 7) + 1;
    for (const e of c.entries) {
        const ch = e & 0x3fff;
        if (ch && (ch >= L.count || ((e >> 7) & 0x7f) >= groups)) return false;
    }
    return true;
}

/** The CGs for a cell, best first. The program names one for some cells
 * (`screens`), and a few with two (INDY 500's cell 124 is "NAME" with CG 15
 * and "BAY SIDE STREET" with CG 46): the first named leads, the rest follow.
 * The tables keep a CG's cells together, in CG order, so any other cell takes
 * a CG of its own bank between the ones named for the cells before and after
 * it that holds all its tiles: the nearest after the CG before, as the tables
 * run; js/cells.js picks among those by their seams. */
export function rankBankCGs(rom, cell, c, named) {
    const { cells, cgs } = bankTables(rom);
    const own = named.get(cell);
    const recoloured = cgs.flatMap((L, cg) => (L?.recolour?.cells.includes(cell) ? [cg] : []));
    if (own !== undefined) {
        const also = (rom.game.cells.screens ?? []).filter((s) => s.cg !== own && s.cells.includes(cell));
        return [...recoloured, own, ...new Set(also.map((s) => s.cg))].map((cg) => ({ cg, cover: 1 }));
    }
    const bank = cells[cell]?.bank;
    const mine = (L) => L?.bank === bank && !L.recolour;
    const first = cgs.findIndex(mine), last = cgs.findLastIndex(mine);
    let lo = first, hi = last;
    for (let i = cell - 1; i >= 0 && cells[i].bank === bank; i--) if (named.has(i)) { lo = named.get(i); break; }
    for (let i = cell + 1; i < cells.length && cells[i].bank === bank; i++) if (named.has(i)) { hi = named.get(i); break; }
    const out = [];
    for (let cg = lo; cg <= hi; cg++) if (fits(c, cgs[cg])) out.push({ cg, cover: 1, window: true });
    for (let cg = first; cg <= last; cg++) if ((cg < lo || cg > hi) && fits(c, cgs[cg])) out.push({ cg, cover: 1 });
    return out;
}
