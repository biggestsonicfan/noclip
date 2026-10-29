/*
 * Behind Enemy Lines (MAME `bel`, Model 2C, Sega / EPL Productions, 1997).
 * Not a Sega AM engine: its own model table, named objects, sheets and
 * colours. See README's Behind Enemy Lines section and TECHNICAL.md.
 */
import { MAIN_DATA_BASE } from './romset.js';
import { SHEET_BYTES } from './atlas.js';
import { runRoutines, CXLAT_AT, CXLAT_BYTES } from './skisuprg.js';

/*
 * The object directory at data 0x973748: {name, first record} pairs, the name
 * a 32-byte string (`o_1cntain1_100`), the record one of the model table's.
 * An object runs on to the next one's first record. A model is named by the
 * object it starts, or by the one it is part of with its place in it.
 */
export function belModelName(rom, index) {
    const B = rom.game.bel;
    if (!rom.belNames) {
        const dv = rom.mainDataView;
        const t = rom.game.modelTable;
        const starts = [];
        for (let i = 0; i < B.objects.count; i++) {
            const at = B.objects.at + i * 8;
            const name = dv.getUint32(at, true) - MAIN_DATA_BASE;
            const rec = dv.getUint32(at + 4, true) - MAIN_DATA_BASE - t.offset;
            if (rec < 0 || rec % t.stride || name < 0 || name >= rom.mainData.length) continue;
            let end = name;
            while (end < name + 32 && rom.mainData[end] > 0x20) end++;
            starts.push([rec / t.stride, String.fromCharCode(...rom.mainData.subarray(name, end))]);
        }
        starts.sort((a, b) => a[0] - b[0]);
        rom.belNames = starts;
    }
    const s = rom.belNames;
    let lo = 0, hi = s.length - 1, at = -1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (s[m][0] <= index) { at = m; lo = m + 1; } else hi = m - 1;
    }
    if (at < 0) return null;
    const [first, name] = s[at];
    return index === first ? name : `${name} +${index - first}`;
}

/*
 * The sheets. 0x72190(sheet, entry) copies a megabyte bank onto a sheet: the
 * bank is 0x2064780[scene * 8 + entry * 4] for sheet 1 (g0 = 0) or
 * 0x20647A0[scene * 12 + entry * 4] for sheet 0, the scene the byte at work
 * RAM 0x5A17C0 (2 from the boot, 0x10AC). The first 0x60000 halfwords go
 * straight onto the sheet; the rest are eight mip levels of 0x80, 0x40 ... 1
 * rows, dealt between the sheets in runs from the table at data 0x98F8F0
 * (0x200 >> k, the first run 0x100, run k doubled while k is past the level),
 * as Daytona's 0x1388 deals them. MAME's texture RAM has every mip row on the
 * other sheet from the one the routine addresses, Daytona's too
 * (uploadDaytonaBank), so they go there. The boot (0x1168, 0x1174) loads
 * entry 0 onto both sheets; a scene's set-up (0x727D0) puts entry +0xCC of
 * its record onto sheet 0 and entry 1 onto sheet 1 for scene 2, entry 0 for
 * the others (0x72818). A texture set here is one {scene, sheet-0 entry}.
 */
const DEAL = [0x200, 0x100, 0x80, 0x40, 0x20, 0x10, 8, 4, 2, 1, 0, 0];
const FULL = 0xc0000;

function uploadBelBank(md, base, tex, toSheet0) {
    if (base < 0 || base + SHEET_BYTES > md.length) return false;
    const own = toSheet0 ? 0 : SHEET_BYTES;
    tex.set(md.subarray(base, base + FULL), own);
    let src = base + FULL;
    let pos = FULL;
    let rows = 0x80;
    for (let level = 0; level < 8; level++) {
        for (let r = 0; r < rows; r++) {
            let onOwn = true;
            let k = 1;
            let left = DEAL[1];
            for (let x = 0; x < 0x200; x++, src += 2, pos += 2) {
                const at = (onOwn ? SHEET_BYTES - own : own) + pos;
                tex[at] = md[src];
                tex[at + 1] = md[src + 1];
                if (level === 0 || --left > 0) continue;
                onOwn = !onOwn;
                k++;
                left = DEAL[k] << (level < k ? 1 : 0);
            }
        }
        if (rows > 1) rows >>= 1;
    }
    return true;
}

function sceneOf(rom, set) {
    const B = rom.game.bel;
    const n = B.scenes * B.entries;
    const s = set >= 0 && set < n ? set : rom.game.texture.defaultSet;
    return { scene: Math.floor(s / B.entries), entry: s % B.entries };
}

/** The bank addresses a texture set puts on sheets 0 and 1. */
export function belBanks(rom, set) {
    const B = rom.game.bel;
    const dv = rom.mainDataView;
    const { scene, entry } = sceneOf(rom, set);
    return {
        sheet0: dv.getUint32(B.sheet0 - MAIN_DATA_BASE + scene * 12 + entry * 4, true),
        sheet1: dv.getUint32(B.sheet1 - MAIN_DATA_BASE + scene * 8 + (scene === B.twoScene ? 4 : 0), true),
    };
}

export function buildBelTexram(rom, texSets) {
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    const { sheet0, sheet1 } = belBanks(rom, sets.length ? sets[sets.length - 1] : rom.game.texture.defaultSet);
    let pages = 0;
    /* The order the scene's set-up goes in: sheet 0's bank, then sheet 1's. */
    if (uploadBelBank(md, sheet0 - MAIN_DATA_BASE, tex, true)) pages++;
    if (uploadBelBank(md, sheet1 - MAIN_DATA_BASE, tex, false)) pages++;
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * Luma: 0x719C0 writes the 128 signed bytes at data 0x64320 into every one
 * of the 256 bands, then the 384 at 0x64420 over the first three.
 */
export function buildBelLuma(rom, bytes) {
    const L = rom.game.colors.luma;
    const md = rom.mainData;
    const luma = new Uint8Array(bytes);
    for (let b = 0; b < 256; b++) {
        const src = b < L.firstBands ? L.first + b * 128 : L.band;
        for (let k = 0; k < 128; k++) luma[(b * 128 + k) * 2] = md[src + k];
    }
    return luma;
}

/*
 * Colorxlat, by running the boot's two routines (0x1008, 0x1010) with
 * js/i960.js: 0x62A70 works out the grey ramps of rows 0..31 (48 entries
 * rising with the row, then 64 at the row's level), and 0x62DD0(2) lays 16
 * entries a row from entry 48 on, rows 0..27, out of 0x60-byte rows of
 * {r, g, b} bytes at data 0x21F0000 + 2 * 0x1000 (b - 0x74 + 0x40, then
 * times 0xA1 >> 7, held to 0..0xFF). The game
 * keeps a copy in work RAM (0x5AC850, 0x5AA850, 0x5A8850) and fades from it
 * (0x620C0); in MAME's attract it does not change.
 */
export function buildBelColorxlat(rom) {
    if (rom.belColors) return rom.belColors.slice();
    const C = rom.game.colors.bel;
    const { pal } = runRoutines(rom, [[C.ramps, []], [C.table, [C.scene]]], rom.game.name);
    rom.belColors = pal.slice(CXLAT_AT, CXLAT_AT + CXLAT_BYTES);
    return rom.belColors.slice();
}
