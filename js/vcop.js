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
 * The type picks an entry by the pointer table at 0x28690E0 — the spawn
 * (0x318A0) keeps `0x28690E0[type]` in the slot — whose first three words
 * point at the object's parts: their models up to a -1, each part's offset
 * (three floats), each part's turns (three s32), copied into the slot by
 * 0x31F18, 0x31E98 and 0x31E18. The entries sit in a run at 0x2868620 but not in type
 * order from 0x18 on: read as a 32-byte array, the small thing on a desk
 * (0x3D) came out as a door. The slot's draw (0x326D0) gives every part its
 * own matrix and draws it with 0xBA70 if its bit of the slot's mask is set.
 * A part stands at its offset under its object's matrix, and an object on
 * another at its place under that one's: a car's windows are six records of
 * their own (types 0x18-0x1D on stage 1's first car, 0x4F-0x54 on its second),
 * each standing on the car at (0,0,0), drawn on its matrix (0x40190, 0x404C0).
 * Their texture points are the routine's own; see GLASS.
 */
const OBJECT_TABLE = 0x286e100;
const OBJECT_BYTES = 52;
const TYPE_TABLE = 0x28690e0;
const MAX_PARTS = 32;
/* A car window's texture points, which its routine (the record's +0x30) writes
 * to texture RAM every frame and draws the window with in place of the
 * model's (MAME's draws of the six name 0x805000 on, with bit 23 set): a table
 * of (v, u) words from 0x281D9CA, each v slid by the camera's yaw and each u by
 * its pitch, the turns at 0x50F458 and 0x50F454:
 *
 *     dv = scale * trunc(sign * 0x900 * yaw / 0x8000)
 *     du = scale * trunc(-0x300 * pitch / 0x8000)
 *
 * and 0x38930 lifts a column whose least word is below zero by whole tiles
 * (0x400) to the first that is not. So the glass shows a reflection that
 * slides as the camera turns; the ROM's own points, unslid, are the white of
 * it. Slot word +0x11B8 is set in play and the attract both (with it zero the
 * routine passes no offsets). Per routine: its table, words, the sign on the
 * yaw and the scale; the second car's six (0x40B20 on) are the first's again.
 * Checked against the words MAME sends at yaw -0x8000 and 16790. */
const GLASS_TABLES = [
    [0x281d9ca, 42, 1, 3],      /* windscreen */
    [0x281da1e, 8, -1, 3],      /* rear window */
    [0x281da2e, 8, -1, 4],      /* the side windows */
    [0x281da3e, 8, 1, 4],
    [0x281da4e, 8, -1, 4],
    [0x281da5e, 8, 1, 4],
];
const GLASS = new Map([
    ...[0x407f0, 0x40870, 0x40900, 0x40990, 0x40a10, 0x40aa0].map((r, i) => [r, GLASS_TABLES[i]]),
    ...[0x40b20, 0x40ba0, 0x40c30, 0x40cc0, 0x40d40, 0x40dd0].map((r, i) => [r, GLASS_TABLES[i]]),
]);
const GLASS_TILE = 0x400;
const TURN = 0x10000;

/* The board's turns for a camera, in its own axes (z the explorer's negated):
 * yaw about Y from +Z towards +X, pitch up; half a turn is -0x8000. */
function cameraTurns({ eye, at }) {
    const dx = at[0] - eye[0], dy = at[1] - eye[1], dz = -(at[2] - eye[2]);
    const turn = (rad) => {
        const t = Math.round(rad / (2 * Math.PI) * TURN);
        return t >= TURN / 2 ? t - TURN : t;
    };
    return { yaw: turn(Math.atan2(dx, dz)), pitch: turn(Math.atan2(dy, Math.hypot(dx, dz))) };
}

function glassPoints(rom, [table, words, sign, scale], { yaw, pitch }) {
    const dv = rom.mainDataView, off = table - MAIN_DATA_BASE;
    const slide = [scale * Math.trunc(sign * 0x900 * yaw / 0x8000), scale * Math.trunc(-0x300 * pitch / 0x8000)];
    const out = [];
    for (let i = 0; i < words; i++) out.push(dv.getUint16(off + i * 2, true) + slide[i & 1]);
    for (const c of [0, 1]) {
        const least = Math.min(...out.filter((_, i) => (i & 1) === c));
        if (least < 0) for (let i = c; i < words; i += 2) out[i] += Math.ceil(-least / GLASS_TILE) * GLASS_TILE;
    }
    return out;
}

/* A window record's points, from the rail's camera nearest the car it is on. */
function glassOf(rom, rail, s, list, k) {
    const glass = GLASS.get(list[k].routine);
    const car = list[list[k].parent];
    const cam = glass && car && rail ? railNearest(rail, s, [car.x, -car.z]) : null;
    return cam ? glassPoints(rom, glass, cameraTurns(cam)) : null;
}

/* The objects that break, and how many of their parts stand whole: the rest
 * are the pieces they fly into, which the routine hides until then. A segment's
 * loader (0x31600) sets the mask of types 0, 1 and 3 to 3 after the spawn
 * (0x31768, 0x317A8, 0x317EC): a drum is its body and its shadow, 18 parts in
 * all, which its routine (0x33370) later turns to 6. The slab on stage 3's
 * roof (0x26) is its first part, the 24 bits of it hidden (0x44D40's mask, 1);
 * and 0x27 up there its first ten (0x453C0's mask once it comes, 0x3FF). The other types a MAME run of the attract spawns keep every part
 * (0x31CA0's mask). */
const INTACT = new Map([[0x00, 2], [0x01, 2], [0x03, 2], [0x26, 1], [0x27, 10]]);
/* The scripts: a record that stands for an event — the helicopter that comes
 * over (0x38F10 spawns it at 0x4F060) — and draws none of its own parts where
 * it stands, in mid-air, in MAME's draws of all three stages. */
const SCRIPTS = new Set([0x4d]);
/* The objects whose parts' offsets are where they stand in the world, not on
 * the record: the double doors, each leaf its own spot, the first the
 * record's. Stage 3's (0x25), whose 0x2DE and 0x396 MAME draws at 3,90,-49.5,
 * their offsets; stage 2's (0x4B, two 0xA9 at -8.37,0,-76.29 and
 * -10.57,0,-74.45); and 0x24, a pair no list places. */
const IN_WORLD = new Set([0x24, 0x25, 0x4b]);
/* And the ones that come to rest elsewhere as soon as the rail nears: the crate
 * on stage 1's crane, which 0x37500 lowers from 14.45 to 6.45 once the rail
 * passes 0x4E6, where MAME draws it the rest of the stage. */
const REST_Y = new Map([[0x16, 6.45]]);

function readObjectRecord(rom, addr) {
    const dv = rom.mainDataView, off = addr - MAIN_DATA_BASE;
    const type = dv.getUint32(off, true);
    return {
        type,
        x: dv.getFloat32(off + 4, true), y: REST_Y.get(type) ?? dv.getFloat32(off + 8, true),
        z: dv.getFloat32(off + 12, true),
        ax: dv.getInt32(off + 16, true), ay: dv.getInt32(off + 20, true), az: dv.getInt32(off + 24, true),
        parent: dv.getInt32(off + 32, true),
        routine: dv.getUint32(off + 48, true),
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
    const at = dataU32(rom, TYPE_TABLE + type * 4);
    if (!at) return [];
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

/* Every part of every object of the stage once, with the segments that list it.
 * A window takes its points from the camera that passes its car nearest. */
function stageObjects(rom, n, set, segments, rail) {
    const arr = dataU32(rom, OBJECT_TABLE + n * 4);
    const count = rom.game.modelTable.count;
    const byKey = new Map();
    for (let s = 0; arr && s < segments; s++) {
        /* A segment that brings nothing new has a null. */
        const p = dataU32(rom, arr + s * 4);
        if (!p || p < MAIN_DATA_BASE) continue;
        const list = readObjectList(rom, p);
        list.forEach((r, k) => {
            if (SCRIPTS.has(r.type)) return;
            const ops = IN_WORLD.has(r.type) ? [] : objectOps(list, k);
            const points = glassOf(rom, rail, s, list, k);
            for (const part of typeParts(rom, r.type)) {
                if (part.model >= count) continue;
                const partOps = [...ops, ...recordOps(part)];
                const key = JSON.stringify([part.model, partOps]);
                if (!byKey.has(key)) {
                    byKey.set(key, { model: part.model, pos: [r.x, r.y, r.z], set, ops: partOps, zones: new Set() });
                    if (points) byKey.get(key).points = { words: points, key: `glass@${set}:${points.join(',')}` };
                }
                byKey.get(key).zones.add(s);
            }
        });
    }
    return [...byKey.values()];
}

/* ---- the clouds -------------------------------------------------------------
 *
 * The sky behind is the tile chip's (js/vcopsky.js); the clouds in front of it
 * are geometry. At the stage start 0xB760 copies 24 records of five floats from
 * 0x2833AB0 — the model (0x7E or 0x7F), x, y, z and a turn about Y, 0x10000 to
 * the circle — and every frame 0xB8E0 draws each one translated, turned and
 * scaled by 2 (TGP 0x12, 0x15, 0x13), whatever the stage. The same ring for
 * all three, around the origin; only the high-rise (stage 3) drops it from its
 * third segment on, where the rail climbs above them.
 */
const CLOUD_TABLE = 0x2833ab0;
const CLOUD_COUNT = 24;
const CLOUD_BYTES = 20;
const CLOUD_SCALE = 2;
const CLOUDLESS_STAGE = 2;
const CLOUDLESS_FROM = 2;

function stageClouds(rom, n, set, segments) {
    const dv = rom.mainDataView;
    const zones = new Set([...Array(segments).keys()]
        .filter((s) => n !== CLOUDLESS_STAGE || s < CLOUDLESS_FROM));
    const out = [];
    for (let i = 0; i < CLOUD_COUNT; i++) {
        const off = CLOUD_TABLE - MAIN_DATA_BASE + i * CLOUD_BYTES;
        const [model, x, y, z, turn] = [0, 4, 8, 12, 16].map((o) => dv.getFloat32(off + o, true));
        out.push({
            model, pos: [x, y, z], set, zones, layer: 'sky',
            ops: [['t', [x, y, -z]], ['r', turn * ANGLE_DEG], ['s', [CLOUD_SCALE, CLOUD_SCALE, CLOUD_SCALE]]],
        });
    }
    return out;
}

/* ---- the rail ----------------------------------------------------------------
 *
 * Where the camera stands. The stage start (0xC474) takes the stage's 24-byte
 * record at `0x28642B0[stage]` and keeps its first word, the eye's path, at
 * 0x50F498 and its third, the path of the point it looks at, at 0x50F4A0, and
 * zeroes the rail's count (0x50F490): each path is a point of three floats per
 * count. The segment marks of the stage routine above are counts on the same
 * rail, so a segment comes up with the camera at its mark, and the stage opens
 * at the first point. The set is dressed for that rail and little else: seen
 * from beside the quay, the gate and the van are behind the containers (issue
 * 96), so the explorer opens a stage, and a segment picked on its own, there.
 */
const RAIL_TABLE = 0x28642b0;
const RAIL_BYTES = 24;
const RAIL_POINT = 12;
const MARK_TABLE = 0x2839170;

function railPoint(rom, path, i) {
    const off = path - MAIN_DATA_BASE + i * RAIL_POINT;
    const dv = rom.mainDataView;
    return [dv.getFloat32(off, true), dv.getFloat32(off + 4, true), -dv.getFloat32(off + 8, true)];
}

/* The stage's rail: the camera at each count, how many there are (the
 * record's +0x10), and where each segment starts on it. */
function stageRail(rom, n, segments) {
    const eyes = dataU32(rom, RAIL_TABLE + n * RAIL_BYTES);
    const ats = dataU32(rom, RAIL_TABLE + n * RAIL_BYTES + 8);
    const count = dataU32(rom, RAIL_TABLE + n * RAIL_BYTES + 16);
    const marks = dataU32(rom, MARK_TABLE + n * 4);
    if (!eyes || !ats || !count || !marks) return null;
    const starts = [0];
    for (let s = 1; s < segments; s++) {
        const mark = dataU32(rom, marks + (s - 1) * 4);
        if (mark === null || mark === END) break;
        starts.push(mark);
    }
    const at = (i) => ({ eye: railPoint(rom, eyes, i), at: railPoint(rom, ats, i) });
    return { at, count, starts };
}

/* The camera at the rail's start, and at each segment's mark, by view. */
function stageCameras(rail) {
    if (!rail) return {};
    const cameras = { all: rail.at(0) };
    rail.starts.forEach((i, s) => { cameras[`zone:${s}`] = rail.at(i); });
    return cameras;
}

/* The camera on a segment's stretch of rail that passes nearest a point (the
 * explorer's axes): where the player sees what stands there. */
function railNearest(rail, s, [x, z]) {
    const from = rail.starts[s] ?? 0, to = rail.starts[s + 1] ?? rail.count;
    let best = null, bestD = Infinity;
    for (let i = from; i < to; i++) {
        const cam = rail.at(i);
        const d = Math.hypot(cam.eye[0] - x, cam.eye[2] - z);
        if (d < bestD) { best = cam; bestD = d; }
    }
    return best;
}

function stageOf(rom, lit, n, segs) {
    const t = rom.game.modelTable;
    const set = n % rom.game.texture.sets;
    const draws = mergeSegments(segs, t.count).map((r) => ({
        model: r.model, pos: [r.x, r.y, r.z], set, zones: r.zones, ops: recordOps(r),
    }));
    const rail = stageRail(rom, n, segs.length);
    const objects = stageObjects(rom, n, set, segs.length, rail);
    const clouds = stageClouds(rom, n, set, segs.length);
    const zones = segs.map((recs, s) => ({ zone: s, set, label: `segment ${s + 1} · ${recs.length} pieces` }));
    return {
        slot: n,
        placements: true,
        mixedSets: false,
        num: n + 1,
        name: STAGE_NAMES[n] ?? `Stage ${n + 1}`,
        chapter: n,
        draws,
        objects: [...clouds, ...objects],
        sky: null,
        /* The tile layer's, not geometry (js/vcopsky.js). */
        panorama: (cxlat) => buildVcopSky(rom, n, cxlat),
        zones,
        cameras: stageCameras(rail),
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
