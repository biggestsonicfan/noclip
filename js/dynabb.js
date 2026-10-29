/*
 * dynabb.js — Dynamite Baseball 97 (Sega, 1997, Model 2B CRX; MAME's
 * `dynabb97`), its texture RAM.
 *
 * The game's texture loader is the one Jaleco's racers have (js/jaleco.js),
 * grown into a dispatcher: 0x81420 takes a data address (g0), a sheet (g1)
 * and a layout (g2), and jumps through the table at 0x81464. Layout 0
 * (0x81530) is the racers' whole page and its ten mip rectangles (blit
 * 0x819C0, without their extra quad); the others copy packed rectangles,
 * row after row of halfwords, into parts of the sheets (blit 0x81A00):
 * 32 (0x81668), 33 and 50 (0x81728), 48 (0x817F0), 49 (0x818C0). So the
 * viewer runs 0x81420 itself, with js/i960.js, as js/colors.js runs the
 * colour routines, and keeps what it writes.
 *
 * The boot (0x80C28) clears both sheets (0x80DE0) and loads
 *     0x29AA900 sheet 0, layout 32   the stadium (table 0x809A0, entry 1)
 *     0x2855500 sheet 0, layout 33
 *     0x22AA800 sheet 1, layout 48   a team's first half (table 0x80920)
 *     0x20FFF00 sheet 1, layout 50   a team's second half (table 0x80960)
 *     0x2800000 sheet 1, layout 49
 * A game reloads the stadium (0x84790, `0x809A0[0x138840[n]]`, three
 * stadiums) and the two team halves (0x84550 and 0x84670, twelve teams, the
 * same index into both tables).
 *
 * The colours are the game's own routines run the same way (dynabbColors):
 * the boot's 0x82040 (colorxlat's 32 rows, a curve of k sqrt(x) + (1 - k) x^2
 * with k 0.7 from 0x82034, scaled by 1.1 when the byte at 0x5CA37B is not 1),
 * 0x82430 (odd rows from the table at data 0x2BAE830) and 0x82620 (luma, from
 * data 0x2BA0B50); then the game's palette set-up 0x99DB0 (blocks of {count,
 * colours} at data 0x2BA94D2, 0x2BA8D6C, 0x2BA8E48, 0x2BA8B9E and 0x2BA8B16
 * to entries 0, 0x100, 0x200, 0x300 and 0x37A, copied by 0x844D0); then the
 * colour halves of the three loads, 0x84570 (team A, 0x5B961C: rows 1, 3 and
 * 5 from 0xD82E0, palette 0xD8370 to entry 0x100), 0x84690 (team B,
 * 0x5B95F4: rows 7, 9 and 11 from 0xD8320, palette 0xD83B0 to entry 0x200)
 * and 0x847D0 (the stadium, 0x5B9628: row 15 from 0xD8360, palette 0xD83F0 to
 * entry 0). Their rows go through 0x82200, the same curve with the
 * stadium's flags from 0x82470. The square root is the coprocessor's: the
 * i960 writes a command (0x16802D2D) and x to its FIFO at 0x884000 and reads
 * the answer back, so the bus answers with a float sqrt.
 *
 * Checked against MAME's RAM in the attract mode: texture RAM (the boot at
 * frame 300; teams 0 and 10 at stadium 1, frames 1500 and 3000; 0 and 6,
 * frame 4500), and at frames 1500 and 4500 colorxlat, luma and the face
 * palette, no byte different. Sheet 0 differs at 0xFC3C0 by 119 halfwords
 * that 0x848E0 copies within texture RAM at run time.
 */

import { I960 } from './i960.js';
import { MAIN_DATA_BASE, readModelName } from './romset.js';

const SHEET_BYTES = 0x100000;
const TEX_RAM = 0x11000000;
const LOADER = 0x81420;

/**
 * The loads set `set` stands for: `raw.stadiums` (data addresses, layout 32
 * on sheet 0) by set / teams, `raw.teams` ([layout 48, layout 50] data
 * addresses on sheet 1) by set % teams, the fixed loads in `raw.fixed` with
 * them in the boot's order.
 */
export function dynabbLoads(raw, set) {
    const nt = raw.teams.length;
    const stadium = raw.stadiums[Math.floor(set / nt) % raw.stadiums.length];
    const [a, b] = raw.teams[set % nt];
    return [[stadium, 0, 32], ...raw.fixed.slice(0, 1), [a, 1, 48], [b, 1, 50], ...raw.fixed.slice(1)];
}

/** Texture RAM with set `texSets` (the last one named) loaded. */
export function buildDynabbTexram(rom, texSets) {
    const raw = rom.game.texture.raw;
    const nSets = rom.game.texture.sets;
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < nSets);
    const set = sets.length ? sets[sets.length - 1] : rom.game.texture.defaultSet;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const prog = rom.maincpu;
    const data = rom.mainData;
    const work = new Uint8Array(0x100000);
    /* The 2B's sheets are 0x11000000 and 0x11200000, each mirrored 1 MB on. */
    const where = (a) => {
        if (a < prog.length) return [prog, a];
        if (a >= 0x500000 && a < 0x600000) return [work, a - 0x500000];
        if (a >= 0x02000000 && a < 0x02000000 + data.length) return [data, a - 0x02000000];
        if (a >= TEX_RAM && a < TEX_RAM + 0x400000) {
            return [tex, (a & 0x200000 ? SHEET_BYTES : 0) + (a & 0xfffff)];
        }
        throw new Error(`texture loader touched 0x${a.toString(16)}`);
    };
    const read = (a, n) => {
        const [b, o] = where(a);
        let v = 0;
        for (let k = n - 1; k >= 0; k--) v = (v << 8) | b[o + k];
        return v >>> 0;
    };
    const write = (a, v, n) => {
        const [b, o] = where(a);
        for (let k = 0; k < n; k++) b[o + k] = (v >>> (8 * k)) & 0xff;
    };
    const cpu = new I960({
        read8: (a) => read(a, 1), read16: (a) => read(a, 2), read32: (a) => read(a, 4),
        write8: (a, v) => write(a, v, 1), write16: (a, v) => write(a, v, 2), write32: (a, v) => write(a, v, 4),
    });
    /* The boot's clear (0x80DE0) stores g14, zero, which the sheets are. */
    for (const args of dynabbLoads(raw, set)) {
        if (!cpu.call(LOADER, args, { maxSteps: 20_000_000 })) {
            throw new Error(`texture load 0x${args[0].toString(16)} did not return`);
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages: 2 };
}

/** The stadium and team set `set` stands for. */
export function dynabbScene(rom, set) {
    const raw = rom.game.texture.raw;
    const nt = raw.teams.length;
    return { stadium: Math.floor(set / nt) % raw.stadiums.length, team: set % nt };
}

/* Palette RAM (0x1800000), colorxlat's three channels in it from 0x10000. */
const PAL_RAM = 0x01800000;
const PAL_BYTES = 0x20000;
const LUMA_RAM = 0x11400000;
const COPRO_FIFO = 0x884000;

/**
 * Colorxlat, luma (a byte every halfword, as js/colors.js keeps it) and the
 * face palette (1024 BGR555 colours) of set `set`, both teams the set's.
 */
export function dynabbColors(rom, set) {
    rom.dynabbColors ??= new Map();
    if (rom.dynabbColors.has(set)) return rom.dynabbColors.get(set);
    const { stadium, team } = dynabbScene(rom, set);
    const prog = rom.maincpu;
    const data = rom.mainData;
    const work = new Uint8Array(0x100000);
    const pal = new Uint8Array(PAL_BYTES);
    const luma = new Uint8Array(0x20000);
    const where = (a) => {
        if (a < prog.length) return [prog, a];
        if (a >= 0x500000 && a < 0x600000) return [work, a - 0x500000];
        if (a >= PAL_RAM && a < PAL_RAM + PAL_BYTES) return [pal, a - PAL_RAM];
        if (a >= MAIN_DATA_BASE && a < MAIN_DATA_BASE + data.length) return [data, a - MAIN_DATA_BASE];
        throw new Error(`colour routine touched 0x${a.toString(16)}`);
    };
    const f = new DataView(new ArrayBuffer(4));
    let fifo = [];
    const read = (a, n) => {
        if (a === COPRO_FIFO) {
            f.setUint32(0, fifo[1] ?? 0, true);
            f.setFloat32(0, Math.sqrt(f.getFloat32(0, true)), true);
            fifo = [];
            return f.getUint32(0, true);
        }
        const [b, o] = where(a);
        let v = 0;
        for (let k = n - 1; k >= 0; k--) v = (v << 8) | b[o + k];
        return v >>> 0;
    };
    const write = (a, v, n) => {
        if (a === COPRO_FIFO || a === COPRO_FIFO + 4) { fifo.push(v >>> 0); return; }
        if (a >= LUMA_RAM && a < LUMA_RAM + luma.length) { luma[a - LUMA_RAM] = v & 0xff; return; }
        const [b, o] = where(a);
        for (let k = 0; k < n; k++) b[o + k] = (v >>> (8 * k)) & 0xff;
    };
    const cpu = new I960({
        read8: (a) => read(a, 1), read16: (a) => read(a, 2), read32: (a) => read(a, 4),
        write8: (a, v) => write(a, v, 1), write16: (a, v) => write(a, v, 2), write32: (a, v) => write(a, v, 4),
    });
    const wv = new DataView(work.buffer);
    /* What MAME's RAM holds there; 1 would leave the curve unscaled. */
    work[0x5ca37b - 0x500000] = 2;
    const run = (entry) => {
        if (!cpu.call(entry, [], { maxSteps: 5_000_000 })) {
            throw new Error(`colour routine 0x${entry.toString(16)} did not return`);
        }
    };
    /* The boot's three run with stadium 0, as at power-on. */
    for (const e of [0x82040, 0x82430, 0x82620, 0x99db0]) run(e);
    wv.setUint32(0x5b9628 - 0x500000, stadium, true);
    wv.setUint32(0x5b961c - 0x500000, team, true);
    wv.setUint32(0x5b95f4 - 0x500000, team, true);
    for (const e of [0x84570, 0x84690, 0x847d0]) run(e);
    const palette = new Int32Array(1024);
    const pv = new DataView(pal.buffer);
    for (let i = 0; i < 1024; i++) palette[i] = pv.getUint16(0x2000 + i * 2, true);
    const out = { cxlat: pal.slice(0x10000, 0x1c000), luma, palette };
    rom.dynabbColors.set(set, out);
    return out;
}

/* The teams in the order of their tables (0x80920), which is the order of
 * their models' name prefixes in the table: Swallows, Carp, Giants, BayStars,
 * Dragons, Tigers, BlueWave, Marines, Lions, Fighters, Hawks, Buffaloes. */
const TEAM_PREFIXES = ['SW', 'CA', 'GI', 'BA', 'DR', 'TI', 'BL', 'MA', 'LI', 'FI', 'HA', 'BU'];

/**
 * The set a model is drawn under, read off its name: a team's players are
 * `<team><H|V>...` (home and visitor kits) and a stadium's pieces
 * `Q<stadium + 1>_...`. The other half of the set stays the default's.
 */
export function dynabbModelSets(rom, index, decoded, textured) {
    if (decoded && !textured) return { sets: [], how: 'untextured' };
    const name = readModelName(rom, index) ?? '';
    const nt = TEAM_PREFIXES.length;
    const def = rom.game.texture.defaultSet;
    const q = /^q([123])_/i.exec(name);
    if (q) return { sets: [(q[1] - 1) * nt + (def % nt)], how: 'stadium' };
    const t = /^..[HV]/.test(name) ? TEAM_PREFIXES.indexOf(name.slice(0, 2)) : -1;
    if (t >= 0) return { sets: [def - (def % nt) + t], how: 'team' };
    return null;
}
