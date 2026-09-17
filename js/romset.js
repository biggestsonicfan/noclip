/*
 * romset.js — Model 2 ROM set assembly.
 *
 * Each region is built by interleaving two 16-bit ROM halves into 32-bit words
 * (MAME's ROM_LOAD32_WORD). Which chips go where, and where the tables sit once
 * they are assembled, is the game's business and lives in games.js; this module
 * only carries out the recipe and hands back the regions plus the profile it
 * used, so everything downstream can read the numbers off the ROM set it was
 * given rather than off a constant.
 */

import { readZipDirectory, extractZipEntry, crc32 } from './zip.js';
import { detectGame } from './games.js';

/* MAME's ROM_LOAD32_WORD: dest[n*4..] = lo[n*2..], hi[n*2..] */
function interleave32(dest, lo, hi, baseOffset) {
    const n = Math.min(lo.length, hi.length);
    for (let i = 0; i < n; i += 2) {
        const d = baseOffset + i * 2;
        if (d + 3 >= dest.length) break;
        dest[d] = lo[i];
        dest[d + 1] = lo[i + 1];
        dest[d + 2] = hi[i];
        dest[d + 3] = hi[i + 1];
    }
}

/**
 * Build a ROM set from one or more zip buffers.
 *
 * The game is worked out from the member names rather than asked for: a set is
 * whatever its program ROM says it is. Members are looked up across every
 * supplied zip, so passing one self-contained archive works and so does adding
 * a second to cover a MAME parent/clone split.
 *
 * @param {ArrayBuffer[]} zipBuffers
 * @param {(msg:string, frac:number)=>void} [onProgress]
 */
export async function loadRomSet(zipBuffers, onProgress = () => {}) {
    const sources = zipBuffers.map((buf) => ({ buf, dir: readZipDirectory(buf) }));

    const names = new Set();
    for (const s of sources) for (const n of s.dir.keys()) names.add(n);

    const game = detectGame(names);
    if (!game) throw new Error('unrecognised ROM set — no supported game found in these zips');

    const warnings = [];
    const cache = new Map();
    async function member(name, expectCrc) {
        if (cache.has(name)) return cache.get(name);
        for (const s of sources) {
            if (!s.dir.has(name)) continue;
            const data = await extractZipEntry(s.buf, s.dir, name);
            const actual = crc32(data);
            if (actual !== expectCrc) {
                warnings.push(`${name}: CRC ${actual.toString(16)} != ${expectCrc.toString(16)}`);
            }
            cache.set(name, data);
            return data;
        }
        throw new Error(`ROM member not found in any supplied zip: ${name}`);
    }

    const regions = Object.entries(game.regions);
    const totalParts = regions.reduce((a, [, r]) => a + r.parts.length * 2, 0);
    let done = 0;

    const out = { game };
    for (const [key, spec] of regions) {
        /* A region the viewer can do without is left null rather than failing
         * the whole set when a zip does not carry its chips. */
        if (spec.optional && !spec.parts.every(([, lo, , hi]) => names.has(lo) && names.has(hi))) {
            warnings.push(`${key}: chips not in the supplied zips, skipped`);
            out[key] = null;
            done += spec.parts.length * 2;
            continue;
        }
        const dest = new Uint8Array(spec.size);
        for (const [off, loName, loCrc, hiName, hiCrc] of spec.parts) {
            onProgress(`decompressing ${loName}`, done / totalParts);
            const lo = await member(loName, loCrc);
            done++;
            onProgress(`decompressing ${hiName}`, done / totalParts);
            const hi = await member(hiName, hiCrc);
            done++;
            interleave32(dest, lo, hi, off);
        }
        out[key] = dest;
    }
    onProgress(`${game.name} ROM set ready`, 1);

    out.warnings = warnings;
    /* A view per region, named for it, so a profile that adds one — Fighting
     * Vipers' second bank — gets a view without this list being touched.
     * mainCpuView keeps its old spelling because the callers use it. */
    for (const [key] of regions) out[`${key}View`] = out[key] ? new DataView(out[key].buffer) : null;
    out.mainCpuView = out.maincpuView;
    return out;
}

/* ---- Model table --------------------------------------------------------- */

/* Each 16-byte entry is
 *   +0x00 uv_ptr    word index into the texture ROM (UV stream)
 *   +0x04 mat_ptr   half-word index into the texture ROM (material records)
 *   +0x08 mesh_ptr  encoded pointer into the polygon ROM
 *   +0x0C unused by Sonic The Fighters; Fighting Vipers puts a pair of
 *         half-words here that the viewer does not read.
 *
 * Where the table starts and how many entries it has is per-game — both titles
 * happen to keep it at data offset 0x0E0004, because both are built on the same
 * Sega library, but the count differs. */

export function readModelEntry(rom, index) {
    const t = rom.game.modelTable;
    const off = t.offset + index * t.stride;
    const dv = rom.mainDataView;
    return {
        uvPtr: dv.getUint32(off + 0, true),
        matPtr: dv.getUint32(off + 4, true),
        meshPtr: dv.getUint32(off + 8, true),
    };
}

/**
 * A model's name, for a game whose ROM carries them; null otherwise.
 *
 * `modelNames.ptrs` is a table of pointers to C strings, `skip` entries in, one
 * per model; entries past `count` are the second half of a table that repeats
 * the first and take the same names.
 */
export function readModelName(rom, index) {
    const n = rom.game.modelNames;
    if (!n || index < 0) return null;
    const dv = rom.mainDataView;
    const at = n.ptrs + (n.skip + (index % n.count)) * 4;
    if (at + 4 > rom.mainData.length) return null;
    const off = dv.getUint32(at, true) - 0x02000000;
    if (off < 0 || off >= rom.mainData.length) return null;
    let end = off;
    while (end < rom.mainData.length && end - off < 64 && rom.mainData[end] !== 0) end++;
    return String.fromCharCode(...rom.mainData.subarray(off, end));
}

/*
 * The face palette, as the 1024 colours a material record's 10-bit colorbase
 * can name: BGR555, or -1 where the ROM has nothing to say.
 *
 * Two layouts. The AM2 games keep one table in the data ROM at `paletteOffset`.
 * The House of the Dead writes palette RAM from the program ROM in parts — a
 * shared table below `split`, the loaded set's table from `split` on, and a
 * fixed table down from the top — so its palette depends on `rom.paletteSet`,
 * which the caller moves when it moves the texture set. Built once per set and
 * kept.
 */
export function facePalette(rom) {
    const p = rom.game.palette;
    const set = p ? (rom.paletteSet ?? 0) : 0;
    rom.facePalettes ??= new Map();
    if (rom.facePalettes.has(set)) return rom.facePalettes.get(set);

    const out = new Int32Array(1024).fill(-1);
    if (!p) {
        const md = rom.mainData;
        for (let i = 0; i < 1024; i++) {
            const o = rom.game.paletteOffset + i * 2;
            if (o + 2 > md.length) break;
            out[i] = md[o] | (md[o + 1] << 8);
        }
    } else {
        const cv = rom.mainCpuView;
        const table = (s, first) => {
            const t = cv.getUint32(p.tables + s * 4, true);
            if (!t || t + 2 > rom.maincpu.length) return;
            const count = cv.getUint16(t, true);
            for (let i = 0; i < count && first + i < 1024 && t + 4 + i * 2 <= rom.maincpu.length; i++) {
                out[first + i] = cv.getUint16(t + 2 + i * 2, true);
            }
        };
        table(0, 0);
        /* A set's table overwrites only as many entries as it holds, and nothing
         * clears the rest, so what sits above it is whatever the sets loaded
         * before it left there. Where the game has an order of play, lay those
         * down first. */
        const order = p.loadOrder ?? [];
        const before = order.includes(set) ? order.slice(0, order.indexOf(set)) : order.slice(0, 1);
        for (const s of before) table(s, p.split);
        if (set >= 0 && set < p.sets) table(set, p.split);
        /* The top of the palette, filled downward from 1023 by its own table,
         * then single entries a setting decides. */
        if (p.top) {
            const count = cv.getUint16(p.top, true);
            for (let i = 0; i < count && i < 1024; i++) out[1023 - i] = cv.getUint16(p.top + 2 + i * 2, true);
        }
        for (const [index, color] of p.fixed ?? []) out[index] = color;
    }
    rom.facePalettes.set(set, out);
    return out;
}

/** Byte offset into the polygon ROM of a table entry's mesh, or -1 if it has none. */
export function meshOffsetOf(rom, entry) {
    if (entry.meshPtr === 0) return -1;
    const m = rom.game.meshPtr;
    return (entry.meshPtr * 4 - m.subtract + m.add) >>> 0;
}

/* ---- i960 address translation -------------------------------------------- */

/* XTRA_DATA (0x06000000, 16MB) mirrors main_data from 0x01000000 on, and that
 * 1MB window is itself repeated every megabyte. Motion tables are addressed
 * through it, so fold such a pointer back to the one real copy. Both games map
 * the window the same way — Fighting Vipers' program ROM has it as the
 * XTRADATABASE segment over the same range. */
export const XTRA_DATA_BASE = 0x06000000;

export function xtraToMainData(addr) {
    return 0x01000000 + ((addr - XTRA_DATA_BASE) & 0x000fffff);
}

/**
 * Resolve an XTRA_DATA address to the region it mirrors and an offset in it.
 *
 * The window is a mirror, not storage: a bank is repeated across it every
 * megabyte, and a game may put more than one bank in the window and pick
 * between them with an address bit. Sonic The Fighters mirrors one bank through
 * the whole window; Fighting Vipers mirrors the data region's last megabyte in
 * the low half and a second bank of its own in the high half.
 *
 * @returns {{data: Uint8Array, view: DataView, off: number}}
 */
export function xtraResolve(rom, addr) {
    const x = rom.game.xtra;
    const rel = (addr - XTRA_DATA_BASE) >>> 0;
    const bank = x.select ? x.banks[(rel & x.select) ? 1 : 0] : x.banks[0];
    const off = bank.base + (rel & (x.window - 1));
    const data = rom[bank.region];
    return { data, view: rom[`${bank.region}View`], off };
}
