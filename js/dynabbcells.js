/*
 * dynabbcells.js — Dynamite Baseball 97's tile-chip pictures, for js/cells.js
 * (`slots` in the game's cells).
 *
 * A picture is a record of the table at data 0xBB0000, 12 bytes each, 0x938
 * of them (the last eleven are not pictures): the tile chain, the colours and
 * the pattern. A byte table in the program (0xAF680, one per record) says
 * which record's tiles a picture is drawn with: a record of kind 0 or 2 owns
 * its tiles, one of kind 1 or 3 takes those of the nearest owner before it
 * (0xAB680 and the boot's 0xAB6E0, into slot +0xC).
 *
 * 0xABF60 loads an owner's tiles where it finds room: it counts the chain's
 * 128-character blocks, takes that many free blocks from the byte map at
 * 0x5DDE40 (127 blocks), and copies the chain there. A link of the chain
 * is a tile count and the tiles (32 bytes each), and the next starts on the
 * next block; a zero count ends it. The colours are one 16-colour group per
 * link, given to every block of that link, as groups numbered like the blocks
 * (through the buffers 0x5B1F30 and 0x5B58B0, copied on to palette RAM).
 *
 * The pattern is the width and the height as halfwords, then the entries row
 * by row; the draw (0xACD80, and 0xACE70 beside it) adds the first block (as `block << 7`, which moves the
 * character and the group alike) and 0x8000, and lays the rows 64 apart. So
 * a picture loaded at block 0 is its entries as they stand, and that is how
 * the explorer lays every CG: one owner's chain from block 0.
 */

import { scrollAt, scrollPtrOk, TILE_BYTES } from './scroll.js';

const RECORD = 12;
const MAX_SIDE = 64;
const MAX_LINKS = 128;
const BLOCK = 128;

const word = (rom, a) => { const t = scrollAt(rom, a); return t.view.getUint32(t.off, true); };
const half = (rom, a) => { const t = scrollAt(rom, a); return t.view.getUint16(t.off, true); };

/* Every picture: {at, record, owner}; the owners' list is the CGs. */
const cache = new WeakMap();
function slots(rom) {
    let out = cache.get(rom);
    if (out) return out;
    const S = rom.game.cells.slots;
    const kinds = rom.maincpu;
    const cells = [], owners = [], cgOf = new Map();
    let owner = -1;
    for (let n = 0; n < S.count; n++) {
        const k = kinds[S.kinds + n];
        if (k === 0 || k === 2) owner = n;
        const rec = S.table + n * RECORD;
        const pattern = word(rom, rec + 8);
        if (owner < 0 || !scrollPtrOk(rom, pattern) || !scrollPtrOk(rom, word(rom, S.table + owner * RECORD))) continue;
        if (!cgOf.has(owner)) { cgOf.set(owner, owners.length); owners.push(owner); }
        cells.push({ at: pattern, record: n, owner, cg: cgOf.get(owner) });
    }
    out = { cells, owners };
    cache.set(rom, out);
    return out;
}

export const dynabbCells = (rom) => slots(rom).cells;

/** A cell's size and entries, the draw's 0x8000 set. */
export function readDynabbCell(rom, cell) {
    const c = slots(rom).cells[cell];
    if (!c) return null;
    const R = scrollAt(rom, c.at);
    const cols = R.view.getUint16(R.off, true), rows = R.view.getUint16(R.off + 2, true);
    if (!cols || !rows || cols > MAX_SIDE || rows > MAX_SIDE) return null;
    if (R.off + 4 + cols * rows * 2 > R.u8.length) return null;
    const entries = new Uint16Array(cols * rows);
    for (let i = 0; i < entries.length; i++) entries[i] = R.view.getUint16(R.off + 4 + i * 2, true) | 0x8000;
    return { cols, rows, entries };
}

/** CG n is the nth owner's chain, laid from block 0. */
export function dynabbCGs(rom) {
    const hex = (a) => `0x${(a - 0x02000000).toString(16).toUpperCase()}`;
    const S = rom.game.cells.slots;
    return slots(rom).owners.map((n) => ({ dynabb: n, name: `record ${n}, tiles data ${hex(word(rom, S.table + n * RECORD))}` }));
}

export const dynabbCellCG = (rom, cell) => slots(rom).cells[cell]?.cg ?? -1;

/** What 0xABF60 leaves in the tile chip for the CG's owner, at block 0. */
export function loadDynabbCG(rom, L, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    const rec = rom.game.cells.slots.table + L.dynabb * RECORD;
    let t = word(rom, rec), p = word(rom, rec + 4), block = 0;
    for (let k = 0; k < MAX_LINKS && scrollPtrOk(rom, t); k++) {
        const count = word(rom, t);
        if (!count) break;
        const blocks = Math.ceil(count / BLOCK);
        const T = scrollAt(rom, t + 4);
        const fit = Math.min(count, charBytes / TILE_BYTES - block * BLOCK);
        if (fit <= 0 || T.off + fit * TILE_BYTES > T.u8.length) break;
        chars.set(T.u8.subarray(T.off, T.off + fit * TILE_BYTES), block * BLOCK * TILE_BYTES);
        charRuns.push([block * BLOCK, fit]);
        const P = scrollAt(rom, p);
        for (let b = 0; b < blocks; b++) {
            for (let c = 0; c < 16; c++) pal[(block + b) * 16 + c] = P.view.getUint16(P.off + c * 2, true);
            palRuns.push([(block + b) * 16, 16]);
        }
        block += blocks;
        t += 4 + count * TILE_BYTES;
        p += 32;
    }
    return { chars, pal, written: 0, charRuns, palRuns };
}
