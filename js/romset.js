/*
 * romset.js — Sonic The Fighters ROM set assembly.
 *
 * Mirrors the MAME `sfight` region layout (see m2-hle2 src/profiles/sfight.h):
 * each region is built by interleaving two 16-bit ROM halves into 32-bit words
 * (MAME's ROM_LOAD32_WORD). Only the regions the viewer reads are assembled —
 * program code, the model/palette data region, the polygon ROM and the texture
 * ROM. Sound and coprocessor regions are skipped.
 */

import { readZipDirectory, extractZipEntry, crc32 } from './zip.js';

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

/* Region recipes: [destOffset, loName, loCrc, hiName, hiCrc] */
const REGIONS = {
    maincpu: {
        size: 0x100000,
        parts: [[0x000000, 'epr-19001.15', 0x9b088511, 'epr-19002.16', 0x46f510da]],
    },
    /* 0x000000  model table (0x0E0004) + the global face palette (0x100000)
     * 0x800000  second data bank
     * 0x1000000 the window XTRA_DATA (0x06000000) mirrors — the motion tables
     *           live here. The game mirrors it every 1MB up to 0x2000000; the
     *           viewer folds those addresses instead of materialising 32MB. */
    mainData: {
        size: 0x1100000,
        parts: [
            [0x0000000, 'mpr-19007.11', 0x8b8ff751, 'mpr-19008.12', 0xa94654f5],
            [0x0800000, 'mpr-19005.9', 0x98cd1127, 'mpr-19006.10', 0xe79f0a26],
            [0x1000000, 'epr-19003.7', 0x63bae5c5, 'epr-19004.8', 0xc10c9f39],
        ],
    },
    polygons: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-19009.17', 0xfd410350, 'mpr-19012.21', 0x9bb7b5b6],
            [0x800000, 'mpr-19010.18', 0x6fd94187, 'mpr-19013.22', 0x9e232fe5],
        ],
    },
    textures: {
        size: 0x1000000,
        parts: [
            [0x000000, 'mpr-19019.27', 0x59121896, 'mpr-19017.25', 0x7b298379],
            [0x800000, 'mpr-19020.28', 0x9540dba0, 'mpr-19018.26', 0x3b7e7a12],
        ],
    },
};

/**
 * Build the ROM set from one or more zip buffers. Members are looked up across
 * every supplied zip, so passing sfight.zip alone works (it is self-contained)
 * and adding schamp.zip covers the MAME parent/clone split.
 *
 * @param {ArrayBuffer[]} zipBuffers
 * @param {(msg:string, frac:number)=>void} [onProgress]
 */
export async function loadRomSet(zipBuffers, onProgress = () => {}) {
    const sources = zipBuffers.map((buf) => ({ buf, dir: readZipDirectory(buf) }));

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

    const totalParts = Object.values(REGIONS).reduce((a, r) => a + r.parts.length * 2, 0);
    let done = 0;

    const out = {};
    for (const [key, spec] of Object.entries(REGIONS)) {
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
    onProgress('ROM set ready', 1);

    out.warnings = warnings;
    out.mainDataView = new DataView(out.mainData.buffer);
    out.mainCpuView = new DataView(out.maincpu.buffer);
    out.polygonsView = new DataView(out.polygons.buffer);
    out.texturesView = new DataView(out.textures.buffer);
    return out;
}

/* ---- Model table --------------------------------------------------------- */

/* From sfight_profile.quirks. Each 16-byte entry is
 *   +0x00 uv_ptr    word index into the texture ROM (UV stream)
 *   +0x04 mat_ptr   half-word index into the texture ROM (material records)
 *   +0x08 mesh_ptr  encoded pointer into the polygon ROM
 *   +0x0C unused
 */
export const MODEL_TABLE_OFFSET = 0x000e0004;
export const MODEL_TABLE_COUNT = 5103;
export const MODEL_ENTRY_SIZE = 16;
export const MESH_PTR_SUBTRACT = 0x02000010;
export const MESH_PTR_ADD = 0x10;
/* Global face-colour palette (BGR555 LE) indexed by a face's colorbase. */
export const PALETTE_OFFSET = 0x00100000;

export function readModelEntry(rom, index) {
    const off = MODEL_TABLE_OFFSET + index * MODEL_ENTRY_SIZE;
    const dv = rom.mainDataView;
    return {
        uvPtr: dv.getUint32(off + 0, true),
        matPtr: dv.getUint32(off + 4, true),
        meshPtr: dv.getUint32(off + 8, true),
    };
}

/* ---- i960 address translation -------------------------------------------- */

/* XTRA_DATA (0x06000000, 16MB) mirrors main_data from 0x01000000 on, and that
 * 1MB window is itself repeated every megabyte. Motion tables are addressed
 * through it, so fold such a pointer back to the one real copy. */
export const XTRA_DATA_BASE = 0x06000000;

export function xtraToMainData(addr) {
    return 0x01000000 + ((addr - XTRA_DATA_BASE) & 0x000fffff);
}
