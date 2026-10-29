/*
 * Ski Super G (MAME `skisuprg`, Model 2C). See README's Ski Super G section
 * and TECHNICAL.md.
 *
 * Every scene the game sets up makes the same three calls in a row: a texture
 * bank onto sheet 1 (0x43830), a {count, colours} block onto the face palette
 * from entry 500 (0x460D0) and a colour table into colorxlat (0x44260). The
 * menus and the attract's in-between screens name theirs in the code (0x22398,
 * 0x25E80, 0x278E8, 0x28D60, 0x3615C, 0x60E54); a course takes them from its
 * 40-byte record at 0xA4700 + course * 40 (+0x18, +0x1C and +0x20, read at
 * 0x3DEB4 with the course in work RAM 0x51A190). A texture set here is one such
 * scene, and the palette and colour tables follow it.
 */
import { MAIN_DATA_BASE } from './romset.js';
import { uploadRawBank } from './texture.js';
import { SHEET_BYTES } from './atlas.js';
import { I960 } from './i960.js';

/** The scenes, as {name, bank, palette, colors}: program offsets, bank as a main_data address. */
export function skisuprgScenes(rom) {
    if (rom.skisuprgScenes) return rom.skisuprgScenes;
    const S = rom.game.skisuprg;
    const cv = rom.mainCpuView;
    const out = S.scenes.map((s) => ({ ...s }));
    for (let c = 0; c < S.courses.count; c++) {
        const at = S.courses.at + c * S.courses.stride;
        out.push({
            name: `course ${c + 1}`,
            bank: cv.getUint32(at + 0x18, true),
            palette: cv.getUint32(at + 0x1c, true),
            colors: cv.getUint32(at + 0x20, true),
        });
    }
    return (rom.skisuprgScenes = out);
}

function scene(rom, set) {
    const scenes = skisuprgScenes(rom);
    return scenes[set] ?? scenes[rom.game.texture.defaultSet];
}

/*
 * The sheets. The boot (0x43470) puts bank 0x2000000 on sheet 0 with 0x436C0,
 * and nothing after it touches sheet 0 but 0x11660, which puts 0x2500000 there
 * instead when 0x5111AC is set (not seen in MAME's attract). A scene's bank
 * goes on sheet 1 with 0x43830. Both are HOTD's upload: the bank's first half
 * straight onto the sheet, and the mip levels of its second half dealt between
 * the two sheets by 0x43AF0, the same rectangle copy (uploadRawBank).
 */
export function buildSkisuprgTexram(rom, texSets) {
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    uploadRawBank(md, rom.game.skisuprg.bootBank - MAIN_DATA_BASE, tex, false);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    let pages = 1;
    if (sets.length) {
        const bank = scene(rom, sets[sets.length - 1]).bank - MAIN_DATA_BASE;
        if (bank >= 0 && bank + SHEET_BYTES <= md.length) {
            uploadRawBank(md, bank, tex, true);
            pages++;
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * The face palette: the boot's {count, colours} at 0x47DA8 from entry 0
 * (0x11900), then the scene's block from entry 500 (0x460D0, which writes
 * from 0x18023E8).
 */
export function skisuprgPalette(rom, set) {
    const cv = rom.mainCpuView;
    const len = rom.maincpu.length;
    const out = new Int32Array(1024).fill(-1);
    const block = (at, first) => {
        if (!at || at + 2 > len) return;
        const n = cv.getUint16(at, true);
        for (let i = 0; i < n && first + i < 1024 && at + 4 + i * 2 <= len; i++) {
            out[first + i] = cv.getUint16(at + 2 + i * 2, true);
        }
    };
    block(rom.game.palette.base, 0);
    block(scene(rom, set).palette, rom.game.palette.first);
    return out;
}

/*
 * Colorxlat, by running the program's own routines with js/i960.js, as the
 * boot does (0x43454): 0x43DF0 works out the ramps (floating point, a square
 * root) into a shadow at work RAM 0x5121B0 and writes entries 64..255 of each
 * row straight to colorxlat; 0x44260 lays the scene's table of 64 {r, g, b}
 * bytes a row over the shadow's odd rows. The vblank routine then copies the
 * shadow's 64 entries a row to colorxlat, even rows and row 31 on one frame
 * (0x13AD0) and odd rows 1..29 on the next (0x13BD0): channel c, row r is
 * 0x80 bytes at 0x5121B0 + c * 0x1000 + r * 0x80. Matches MAME's colorxlat
 * RAM in the attract byte for byte.
 */
export const COLOR_RAM = 0x01800000;
export const CXLAT_AT = 0x10000;
export const CXLAT_BYTES = 0xc000;
const SHADOW = 0x5121b0;

/*
 * Run program routines over a bus of the program ROM, work RAM 0x500000 and
 * the palette/colorxlat RAM at 0x1800000 (and the data ROM, read only by
 * the callers' routines); js/waverunr.js runs its colour routines through
 * this too. Returns the work RAM and the palette RAM.
 */
export function runRoutines(rom, calls, what) {
    const prog = rom.maincpu;
    const ram = new Uint8Array(0x100000);
    const pal = new Uint8Array(0x20000);
    const where = (a) => {
        if (a < prog.length) return [prog, a];
        if (a >= 0x500000 && a < 0x600000) return [ram, a - 0x500000];
        if (a >= COLOR_RAM && a < COLOR_RAM + pal.length) return [pal, a - COLOR_RAM];
        /* Behind Enemy Lines' routines read their tables from the data ROM. */
        if (a >= MAIN_DATA_BASE && a < MAIN_DATA_BASE + rom.mainData.length) return [rom.mainData, a - MAIN_DATA_BASE];
        throw new Error(`${what} colour routine at 0x${a.toString(16)}`);
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
    for (const [entry, args] of calls) {
        if (!cpu.call(entry, args, { maxSteps: 2_000_000 })) {
            throw new Error(`colour routine 0x${entry.toString(16)} did not return`);
        }
    }
    return { ram, pal };
}

export function buildSkisuprgColorxlat(rom, colorSet) {
    const S = rom.game.colors.skisuprg;
    const table = scene(rom, colorSet).colors;
    rom.skisuprgColors ??= new Map();
    const have = rom.skisuprgColors.get(table);
    if (have) return have.slice();
    const { ram, pal } = runRoutines(rom, [[S.ramps, []], [S.table, [table]]], 'Ski Super G');
    const out = pal.slice(CXLAT_AT, CXLAT_AT + CXLAT_BYTES);
    const sh = SHADOW - 0x500000;
    for (let ch = 0; ch < 3; ch++) {
        for (let row = 0; row < 32; row++) {
            const s = sh + ch * 0x1000 + row * 0x80;
            out.set(ram.subarray(s, s + 0x80), ch * 0x4000 + row * 0x200);
        }
    }
    rom.skisuprgColors.set(table, out);
    return out.slice();
}
