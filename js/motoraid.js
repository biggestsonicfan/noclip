/*
 * motoraid.js — Motor Raid's colour tables, made by running the game's own
 * routines (js/i960.js) the way js/colors.js does Sega Rally's.
 *
 * The boot (0x2F1E8..0x2F1F8) builds colorxlat's 32 rows with float
 * arithmetic and a gamma (0x2FC70), lays the first of the eight scene tables
 * over its odd rows (0x2FE40 with 0) and loads both texture sheets (0x2FB00).
 * The face palette is laid by 0x13B48: {count, colours} at data 0x297A0F4
 * from entry 0, again through 0x31270(0, 0x297A0F4), then 0x31270(0x1F4,
 * 0x297A366); 0x2FFA0(0) fills the top downward from entry 1023 out of
 * 0x16350.
 *
 * A scene is the number at 0x517AE0, 0..7. Its set-up, 0x21C930 (the program
 * copies 0xB0000.. to RAM 0x200000, so this is ROM 0xCC930), lays the scene's
 * palette with 0x31270(0x1F4, table 0x21C8F0[n]) and its colours:
 *   scenes 0 and 1  0x21C990: 0x519048 = 1, then 0x21CBE0(n), which rebuilds
 *                   every row, the odd ones out of table n scaled (scene 1
 *                   takes red x1.25, 0x21CE70) and the even ones a ramp again
 *   scene 5         0x21CA50(5)
 *   the rest        0x21CA50(n): table n over the odd rows as the boot does
 * and 0x21C9B0 loads bank 0x21C910[n] onto sheet 1 (games.js `bankTable`).
 * The colour routines lay one row a frame through the task slots 0x37630
 * (next frame) and 0x37660 (this one's continuation); here those two are
 * hooks that queue the task, and the queue is run until it is empty.
 *
 * Checked against MAME: the boot alone is colorxlat and the face palette at
 * attract frame 600 byte for byte, and scene 1 is colorxlat at frame 1800 byte
 * for byte, with its face palette all but entries 0x306..0x313 (left there by
 * an earlier scene's longer table, 0x297AC3A) and 0x3F7 (0x16E38 animates it).
 */

import { I960 } from './i960.js';
import { MAIN_DATA_BASE } from './romset.js';

const COLOR_RAM = 0x01800000;
const COLOR_RAM_BYTES = 0x20000;
const FACE = 0x2000;
const CXLAT = 0x10000;
const CXLAT_BYTES = 0xc000;

function runScene(rom, scene) {
    const M = rom.game.colors.motoraid;
    const prog = rom.maincpu;
    const data = rom.mainData;
    const ram200 = new Uint8Array(0x40000);
    ram200.set(prog.subarray(M.copy, M.copy + ram200.length));
    const work = new Uint8Array(0x100000);
    const pal = new Uint8Array(COLOR_RAM_BYTES);
    const faceWritten = new Uint8Array(1024);
    const where = (a) => {
        if (a < prog.length) return [prog, a];
        if (a >= 0x200000 && a < 0x240000) return [ram200, a - 0x200000];
        if (a >= 0x500000 && a < 0x600000) return [work, a - 0x500000];
        if (a >= COLOR_RAM && a < COLOR_RAM + COLOR_RAM_BYTES) return [pal, a - COLOR_RAM];
        if (a >= MAIN_DATA_BASE && a < MAIN_DATA_BASE + data.length) return [data, a - MAIN_DATA_BASE];
        throw new Error(`Motor Raid colour routine read 0x${a.toString(16)}`);
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
        const f = a - COLOR_RAM - FACE;
        if (f >= 0 && f < 0x800) faceWritten[f >> 1] = 1;
    };
    const cpu = new I960({
        read8: (a) => read(a, 1), read16: (a) => read(a, 2), read32: (a) => read(a, 4),
        write8: (a, v) => write(a, v, 1), write16: (a, v) => write(a, v, 2), write32: (a, v) => write(a, v, 4),
    });
    let tasks = [];
    for (const slot of M.taskSlots) cpu.hooks.set(slot, (c) => tasks.push(c.reg(16)));
    const run = (entry, args = []) => {
        if (!cpu.call(entry, args, { maxSteps: 2_000_000 })) {
            throw new Error(`Motor Raid colour routine 0x${entry.toString(16)} did not return`);
        }
    };
    for (const [entry, ...args] of M.boot) run(entry, args);
    if (scene != null) {
        write(M.sceneSlot, scene, 4);
        run(M.sceneSetup);
        for (let round = 0; tasks.length && round < 256; round++) {
            const now = tasks;
            tasks = [];
            for (const t of now) run(t);
        }
    }
    const face = new Int32Array(1024).fill(-1);
    for (let i = 0; i < 1024; i++) if (faceWritten[i]) face[i] = pal[FACE + i * 2] | (pal[FACE + i * 2 + 1] << 8);
    return { cxlat: pal.slice(CXLAT, CXLAT + CXLAT_BYTES), face };
}

/**
 * colorxlat and the face palette while texture set `set` (the scene number,
 * 0..7) is loaded; anything else is the boot's.
 * @returns {{cxlat: Uint8Array, face: Int32Array}}
 */
export function motoraidScene(rom, set) {
    const scene = Number.isInteger(set) && set >= 0 && set < rom.game.texture.sets ? set : null;
    rom.motoraidScenes ??= new Map();
    if (!rom.motoraidScenes.has(scene)) rom.motoraidScenes.set(scene, runScene(rom, scene));
    return rom.motoraidScenes.get(scene);
}
