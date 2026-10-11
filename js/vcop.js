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
import { buildVcopSky } from './vcopsky.js';

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

/* ---- the objects ------------------------------------------------------------
 *
 * What stands in a stage besides its pieces — the cars, drums, crates and
 * glass — is a second list per segment, `0x286E100[stage][segment]`, which the
 * board walks (0x9BC0, 0x15424) when the segment comes up, a slot each from
 * 0x559840 on. A 52-byte record, -1 ending the list:
 *
 *     +0x00  u32   type
 *     +0x04  f32   x, y, z
 *     +0x10  s32   turns about X, Y and Z, 0x10000 to the circle
 *     +0x20  s32   the record it stands on, by its place in the list; -1 none
 *     +0x30  u32   the routine that runs it
 *
 * The type is a 32-byte entry of 0x2868620, whose first three words point at
 * the object's parts: their models up to a -1, each part's offset (three
 * floats), each part's turns (three s32). The slot's draw (0x326D0) gives every
 * part its own matrix and draws it with 0xBA70 if its bit of the slot's mask
 * is set. A part stands at its offset under its object's matrix, and an object
 * on another at its place under that one's: a lorry's windows ride on it.
 */
const OBJECT_TABLE = 0x286e100;
const OBJECT_BYTES = 52;
const TYPE_TABLE = 0x2868620;
const TYPE_BYTES = 32;
const MAX_PARTS = 32;
/* The glints on a car's glass: whose routines (0x407F0 on) place them by the
 * camera's turns at 0x50F450 each frame, nothing that stands anywhere. */
const GLINTS = new Set([0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54]);
/* The objects that break, and how many of their parts stand whole: the rest
 * are the pieces they fly into, which the routine hides until then. A drum is
 * its body and its shadow (a MAME run's mask, 3, 18 parts). */
const INTACT = new Map([[0x00, 2], [0x01, 2], [0x03, 2], [0x29, 10]]);

function readObjectRecord(rom, addr) {
    const dv = rom.mainDataView, off = addr - MAIN_DATA_BASE;
    return {
        type: dv.getUint32(off, true),
        x: dv.getFloat32(off + 4, true), y: dv.getFloat32(off + 8, true), z: dv.getFloat32(off + 12, true),
        ax: dv.getInt32(off + 16, true), ay: dv.getInt32(off + 20, true), az: dv.getInt32(off + 24, true),
        parent: dv.getInt32(off + 32, true),
    };
}

/* One segment's object records, up to the -1. */
function readObjectList(rom, addr) {
    const out = [];
    for (let a = addr; out.length < MAX_RECORDS; a += OBJECT_BYTES) {
        const t = dataU32(rom, a);
        if (t === null || t === END) break;
        out.push(readObjectRecord(rom, a));
    }
    return out;
}

/* A type's parts, as records of their own: model, offset and turns. */
function typeParts(rom, type) {
    const at = TYPE_TABLE + type * TYPE_BYTES;
    const models = dataU32(rom, at), offs = dataU32(rom, at + 4), turns = dataU32(rom, at + 8);
    const dv = rom.mainDataView;
    const out = [];
    for (let i = 0; i < (INTACT.get(type) ?? MAX_PARTS); i++) {
        const model = dataU32(rom, models + i * 4);
        if (model === null || model === END) break;
        const o = offs - MAIN_DATA_BASE + i * 12, t = turns - MAIN_DATA_BASE + i * 12;
        out.push({
            model,
            x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true),
            ax: dv.getInt32(t, true), ay: dv.getInt32(t + 4, true), az: dv.getInt32(t + 8, true),
        });
    }
    return out;
}

/* A record's matrix, its parent's first. */
function objectOps(list, k, depth = 0) {
    const r = list[k];
    const up = r.parent >= 0 && r.parent < list.length && depth < 8 ? objectOps(list, r.parent, depth + 1) : [];
    return [...up, ...recordOps(r)];
}

/* Every part of every object of the stage once, with the segments that list it. */
function stageObjects(rom, n, set, segments) {
    const arr = dataU32(rom, OBJECT_TABLE + n * 4);
    const count = rom.game.modelTable.count;
    const byKey = new Map();
    for (let s = 0; arr && s < segments; s++) {
        /* A segment that brings nothing new has a null. */
        const p = dataU32(rom, arr + s * 4);
        if (!p || p < MAIN_DATA_BASE) continue;
        const list = readObjectList(rom, p);
        list.forEach((r, k) => {
            if (GLINTS.has(r.type)) return;
            const ops = objectOps(list, k);
            for (const part of typeParts(rom, r.type)) {
                if (part.model >= count) continue;
                const partOps = [...ops, ...recordOps(part)];
                const key = JSON.stringify([part.model, partOps]);
                if (!byKey.has(key)) byKey.set(key, { model: part.model, pos: [r.x, r.y, r.z], set, ops: partOps, zones: new Set() });
                byKey.get(key).zones.add(s);
            }
        });
    }
    return [...byKey.values()];
}

function stageOf(rom, lit, n, segs) {
    const t = rom.game.modelTable;
    const set = n % rom.game.texture.sets;
    const draws = mergeSegments(segs, t.count).map((r) => ({
        model: r.model, pos: [r.x, r.y, r.z], set, zones: r.zones, ops: recordOps(r),
    }));
    const objects = stageObjects(rom, n, set, segs.length);
    const zones = segs.map((recs, s) => ({ zone: s, set, label: `segment ${s + 1} · ${recs.length} pieces` }));
    return {
        slot: n,
        placements: true,
        mixedSets: false,
        num: n + 1,
        name: STAGE_NAMES[n] ?? `Stage ${n + 1}`,
        chapter: n,
        draws,
        objects,
        sky: null,
        /* The tile layer's, not geometry (js/vcopsky.js). */
        panorama: (cxlat) => buildVcopSky(rom, n, cxlat),
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
        meta: [['stage', n + 1], ['texture set', set], ['segments', segs.length], ['pieces', draws.length], ['object parts', objects.length]],
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
