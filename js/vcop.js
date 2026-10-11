/*
 * vcop.js — Virtua Cop's stages.
 *
 * The board draws a stage as a run of segments, one at a time, and moves on to
 * the next as the rail camera passes a mark. Rev B's stage routine (0xB400):
 *
 *     ld   0x50F2A8, g4            ; the stage
 *     ld   0x2839170[g4*4], g4     ; its marks
 *     ld   (g4)[0x5158C0*4], g4    ; the next one
 *     cmpibne 0x50F490, g4, ...    ; the rail's count reached it:
 *     ...  0x50F50C += 1           ;   the next segment
 *     lda  0x28390D0, g0
 *     call 0xB470
 *
 * and 0xB470 walks `0x28390D0[stage][segment]`, a list of 24-byte records
 *
 *     +0x00  u32   model         -1 ends the list
 *     +0x04  f32   x, y, z
 *     +0x10  s16   turns about X, Y and Z, 0x10000 to the circle
 *     +0x16  s16   (unused)
 *
 * each drawn under TGP function 5 (the push), 0x12 (translate), then 0x16,
 * 0x15 and 0x14 — the turns about Z, Y and X, in that order, the functions
 * Daytona USA's own display routines use (js/daytona.js) — before the matrix
 * goes to the geometry engine and the model is drawn with 0xBA70.
 *
 * Neighbouring segments share most of their pieces, at the same spot, so the
 * whole stage is every record once, and each segment is a view of its own.
 * Every record is in the one world frame: the segments overlap and line up.
 *
 * The texture set is the stage: the stage start (0x59C4C) loads 0x50F2A8 and
 * hands it to the bank switch at 0x6FE0, which indexes the bank table with it.
 */

import { MAIN_DATA_BASE } from './romset.js';
import { gameLighting } from './stages.js';

const RECORD_BYTES = 24;
const END = 0xffffffff;
const MAX_SEGMENTS = 64;
const MAX_RECORDS = 256;
const ANGLE_DEG = 360 / 65536;

const STAGE_NAMES = ['Stage 1 · Beginner', 'Stage 2 · Medium', 'Stage 3 · Expert'];

/* The TGP's frame against the viewer's, as js/daytona.js sets it out: Z is
 * mirrored, which leaves a board turn about X or Y as the same turn here and
 * one about Z reversed. */
function recordOps(r) {
    return [['t', [r.x, r.y, -r.z]],
        ['rz', -r.az * ANGLE_DEG], ['r', r.ay * ANGLE_DEG], ['rx', r.ax * ANGLE_DEG]];
}

function dataU32(rom, addr) {
    const off = addr - MAIN_DATA_BASE;
    if (off < 0 || off + 4 > rom.mainData.length) return null;
    return rom.mainDataView.getUint32(off, true);
}

/* One segment's records, up to the -1. */
function readSegment(rom, addr) {
    const dv = rom.mainDataView;
    const out = [];
    for (let off = addr - MAIN_DATA_BASE; out.length < MAX_RECORDS; off += RECORD_BYTES) {
        if (off < 0 || off + RECORD_BYTES > rom.mainData.length) break;
        const model = dv.getUint32(off, true);
        if (model === END) break;
        out.push({
            model,
            x: dv.getFloat32(off + 4, true), y: dv.getFloat32(off + 8, true), z: dv.getFloat32(off + 12, true),
            ax: dv.getInt16(off + 16, true), ay: dv.getInt16(off + 18, true), az: dv.getInt16(off + 20, true),
        });
    }
    return out;
}

/* A stage's segment lists, up to the null that ends its array. */
function readSegments(rom, arr) {
    const segs = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) {
        const p = dataU32(rom, arr + i * 4);
        if (!p || p < MAIN_DATA_BASE) break;
        segs.push(readSegment(rom, p));
    }
    return segs;
}

/* Every record of the stage once, with the segments that draw it. */
function mergeSegments(segs, modelCount) {
    const byKey = new Map();
    segs.forEach((recs, s) => {
        for (const r of recs) {
            if (r.model >= modelCount) continue;
            const key = [r.model, r.x, r.y, r.z, r.ax, r.ay, r.az].join();
            if (!byKey.has(key)) byKey.set(key, { ...r, zones: new Set() });
            byKey.get(key).zones.add(s);
        }
    });
    return [...byKey.values()];
}

function stageOf(rom, lit, n, segs) {
    const t = rom.game.modelTable;
    const set = n % rom.game.texture.sets;
    const draws = mergeSegments(segs, t.count).map((r) => ({
        model: r.model, pos: [r.x, r.y, r.z], set, zones: r.zones, ops: recordOps(r),
    }));
    const zones = segs.map((recs, s) => ({ zone: s, set, label: `segment ${s + 1} · ${recs.length} pieces` }));
    return {
        slot: n,
        placements: true,
        mixedSets: false,
        num: n + 1,
        name: STAGE_NAMES[n] ?? `Stage ${n + 1}`,
        chapter: n,
        draws,
        objects: [],
        sky: null,
        zones,
        views: [['all', 'Every segment at once'], ...zones.map((z, i) => [`zone:${i}`, z.label])],
        view: 'all',
        union: 'all',
        texSets: [set],
        texSet: [set, set],
        tint: [1, 1, 1],
        bright: 1,
        light: lit.light,
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['stage', n + 1], ['texture set', set], ['segments', segs.length], ['pieces', draws.length]],
    };
}

/**
 * Virtua Cop's stages, one per entry of the segment table.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stage objects in the shape the viewer's stage list takes
 */
export function readSegmentStages(rom) {
    const S = rom.game.stageTable.segments;
    const lit = gameLighting(rom);
    const stages = [];
    const seen = new Set();
    for (let n = 0; n < S.count; n++) {
        const arr = dataU32(rom, S.at + n * 4);
        /* The table's fourth entry is the first stage again. */
        if (!arr || seen.has(arr)) continue;
        seen.add(arr);
        stages.push(stageOf(rom, lit, stages.length, readSegments(rom, arr)));
    }
    return stages;
}
