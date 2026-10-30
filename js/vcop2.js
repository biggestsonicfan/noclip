/*
 * vcop2.js — Virtua Cop 2's stages.
 *
 * Virtua Cop 2 keeps Virtua Cop's way of building a stage — a run of
 * segments, drawn one at a time, the next coming up as the rail camera passes
 * a mark — with two things added: the tables are in the program ROM, and each
 * stage forks. Partway in, the player shoots one of two signs and the rail
 * takes one of two routes (the shot object's +0x10, less 10 or 27, goes to
 * 0x5060EC: 0x22668, 0x431E8), and every table is by stage and route. The
 * stage's draw (0x1D6B8, every frame in play):
 *
 *     ld   0x502010, r3           ; the stage
 *     ld   0x63374[r3*4], r5      ; its two routes
 *     ld   (r5)[0x5060EC*4], r5   ; the route's segment lists
 *     ld   (r5)[0x50A06C*4], r3   ; the segment's
 *
 * and then the list's 24-byte records, -1 ending it:
 *
 *     +0x00  u32   model
 *     +0x04  s16   turn about X       0x10000 to the circle
 *     +0x06  s16   turn about Y
 *     +0x08  s32   turn about Z       (its low half)
 *     +0x0C  f32   x, y, z
 *
 * each drawn as push, translate by x, y, z (command word 0x3000606), the
 * turns of +8, +6 and +4 (0x5000A0A, 0x4800909, 0x4000808, each sent only
 * when not 0), the model (0x160A4), pop: Virtua Cop's record with its fields
 * moved, and its order of turns. Rendered from the rail, the pieces line up
 * with MAME's pictures of all four stages.
 *
 * The segment goes on when the rail's count (0x5060C8) reaches the route's
 * next mark, `0xCA378[stage][route][0x50A070]` (0x68C8, 0x719C), and a
 * mark of 20000 is never reached; the segment's objects come up then too
 * (0x1D7B8). Neighbouring segments share most of their pieces at the same
 * spot, and the two routes share their first segments and their last, so the
 * stage is every record of both once, with each route's segments as views.
 *
 * The texture set is the stage: 0x16594 puts `0x18D14[stage]` on sheet 0 at
 * the stage start.
 */

import { gameLighting } from './stages.js';

const STAGES = 0x63374;
const MARKS = 0xca378;
const RAIL = 0xc9d08;
const BANK_TABLE = 0x18d14;
const RECORD_BYTES = 24;
const END = 0xffffffff;
/* A mark the rail never reaches: the route has no more segments. */
const NEVER = 20000;
const MAX_SEGMENTS = 64;
const MAX_RECORDS = 512;
const ANGLE_DEG = 360 / 65536;
const PROGRAM_END = 0x200000;
const DATA_BASE = 0x2000000;

/*
 * The four stages the draw's table has, by what they show: the game has no
 * names for them in ROM. 0x502010 is 0, 1 or 2 for the three the select
 * screen offers (0x3EE28..0x3EE88, each picked by where the gun points), and
 * 3 is set by 0x5820 when scene 0xD's 120 frames (0x5758) run out; the
 * attract's 4 and 5 (0x8CC4, 0x2E2C) play the first stage's tables.
 */
const STAGE_NAMES = ['City streets and the bay', 'Virtua City subway', 'Pier 10 and the liner', 'Cranes at sunset'];
const ROUTE_NAMES = ['route A', 'route B'];

/* A word at a board address: the program ROM from 0, the data ROM from
 * 0x2000000. */
function u32(rom, a) {
    if (a >= 0 && a + 4 <= Math.min(PROGRAM_END, rom.maincpu.length)) return rom.mainCpuView.getUint32(a, true);
    const off = a - DATA_BASE;
    if (off >= 0 && off + 4 <= rom.mainData.length) return rom.mainDataView.getUint32(off, true);
    return null;
}

function f32(rom, a) {
    const w = u32(rom, a);
    if (w === null) return NaN;
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, w, true);
    return dv.getFloat32(0, true);
}

const s16 = (w) => (w << 16) >> 16;

/* The TGP's frame against the viewer's (js/vcop.js): Z is mirrored, which
 * leaves a board turn about X or Y as the same turn here and one about Z
 * reversed. */
function recordOps(r) {
    return [['t', [r.x, r.y, -r.z]],
        ['rz', -r.az * ANGLE_DEG], ['r', r.ay * ANGLE_DEG], ['rx', r.ax * ANGLE_DEG]];
}

/* One segment's records, up to the -1. */
function readSegment(rom, at) {
    const out = [];
    for (let a = at; out.length < MAX_RECORDS; a += RECORD_BYTES) {
        const model = u32(rom, a);
        if (model === null || model === END) break;
        const turns = u32(rom, a + 4);
        out.push({
            model, ax: s16(turns), ay: s16(turns >>> 16), az: s16(u32(rom, a + 8)),
            x: f32(rom, a + 12), y: f32(rom, a + 16), z: f32(rom, a + 20),
        });
    }
    return out;
}

/* A route's marks, up to the first it never reaches: one fewer than its
 * segments. */
function routeMarks(rom, n, route) {
    const list = u32(rom, u32(rom, MARKS + n * 4) + route * 4);
    const marks = [];
    for (let i = 0; list && i < MAX_SEGMENTS - 1; i++) {
        const m = u32(rom, list + i * 4) | 0;
        if (m < 0 || m >= NEVER) break;
        marks.push(m);
    }
    return marks;
}

/* A route's segment lists, as many as its marks call up. */
function routeSegments(rom, n, route) {
    const lists = u32(rom, u32(rom, STAGES + n * 4) + route * 4);
    const count = routeMarks(rom, n, route).length + 1;
    const segs = [];
    for (let s = 0; lists && s < count; s++) {
        const p = u32(rom, lists + s * 4);
        if (!p) break;
        segs.push(readSegment(rom, p));
    }
    return segs;
}

/* ---- the rail ----------------------------------------------------------------
 *
 * Where the camera stands. The stage start (0x1B884) takes `0xC9D08[stage]`,
 * four 12-byte pieces of rail — the path of the point the camera looks at, the
 * eye's path (three floats a count, either in the program or the data ROM) and
 * how many counts the piece has — and starts on the first. (The look-at path
 * comes first: with the paths the other way round the camera at the first
 * stop looks away from the street MAME shows there.) When the count (0x5060C8)
 * comes to the end of a piece (0x5060CC), 0x1BC4C moves to the next: from the
 * first to 1 + route, from either of those to the fourth. The count runs on
 * across pieces, and the route's marks are on it.
 */
function stageRail(rom, n) {
    const at = u32(rom, RAIL + n * 4);
    if (!at) return null;
    const pieces = [0, 1, 2, 3].map((k) => ({
        ats: u32(rom, at + k * 12), eyes: u32(rom, at + k * 12 + 4), count: u32(rom, at + k * 12 + 8),
    }));
    const point = (path, i) => [f32(rom, path + i * 12), f32(rom, path + i * 12 + 4), -f32(rom, path + i * 12 + 8)];
    return (route) => {
        const run = [pieces[0], pieces[1 + route], pieces[3]].filter((p) => p.count > 0);
        const count = run.reduce((k, p) => k + p.count, 0);
        return {
            count,
            at(i) {
                for (const p of run) {
                    if (i < p.count) return { eye: point(p.eyes, i), at: point(p.ats, i) };
                    i -= p.count;
                }
                const p = run[run.length - 1];
                return { eye: point(p.eyes, p.count - 1), at: point(p.ats, p.count - 1) };
            },
        };
    };
}

/* Every record of the stage once, with the views (route, segment) that draw
 * it. */
function mergeRoutes(routes, modelCount) {
    const byKey = new Map();
    routes.forEach((segs, route) => segs.forEach((recs, s) => {
        for (const r of recs) {
            if (r.model >= modelCount) continue;
            const key = [r.model, r.x, r.y, r.z, r.ax, r.ay, r.az].join();
            if (!byKey.has(key)) byKey.set(key, { ...r, zones: new Set() });
            byKey.get(key).zones.add(zoneOf(route, s));
        }
    }));
    return [...byKey.values()];
}

const zoneOf = (route, s) => route * MAX_SEGMENTS + s;

function stageOf(rom, lit, n) {
    const count = rom.game.modelTable.count;
    const bank = u32(rom, BANK_TABLE + n * 4);
    const set = bank === null ? 0 : Math.max(0, Math.min(rom.game.texture.sets - 1, (bank - DATA_BASE) >> 20));
    const routes = [0, 1].map((route) => routeSegments(rom, n, route));
    /* A route the stage does not fork into repeats the other's lists. */
    const same = JSON.stringify(routes[0]) === JSON.stringify(routes[1]);
    if (same) routes.pop();
    const draws = mergeRoutes(routes, count).map((r) => ({
        model: r.model, pos: [r.x, r.y, r.z], set, zones: r.zones, ops: recordOps(r),
    }));
    const railOf = stageRail(rom, n);
    const zones = [];
    const cameras = {};
    routes.forEach((segs, route) => {
        const marks = routeMarks(rom, n, route);
        const rail = railOf?.(route);
        segs.forEach((recs, s) => {
            const zone = zoneOf(route, s);
            const label = `${routes.length > 1 ? `${ROUTE_NAMES[route]} · ` : ''}segment ${s + 1} · ${recs.length} pieces`;
            zones.push({ zone, set, label });
            if (rail) cameras[`zone:${zone}`] = rail.at(s ? marks[s - 1] : 0);
        });
    });
    if (railOf) cameras.all = railOf(0).at(0);
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
        cameras,
        views: [['all', 'Every segment at once'], ...zones.map((z) => [`zone:${z.zone}`, z.label])],
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
        meta: [['stage', n + 1], ['texture set', set], ['routes', routes.length],
            ['segments', routes.map((r) => r.length).join(' + ')], ['pieces', draws.length]],
    };
}

/**
 * Virtua Cop 2's stages, one per entry of the draw's table.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stage objects in the shape the viewer's stage list takes
 */
export function readVcop2Stages(rom) {
    const lit = gameLighting(rom);
    const stages = [];
    for (let n = 0; n < rom.game.stageTable.vcop2.count; n++) stages.push(stageOf(rom, lit, n));
    nameModelSets(rom, stages);
    return stages;
}

/*
 * The Models tab's texture set for a stage model: the stage's, where only one
 * stage draws it. The Daytona-layout rule (programTextureSets in
 * js/texture.js) takes a model on sheet 0 to the one course that names it, from
 * courseNamedModels' map, which is empty for this game (it has no Daytona
 * object table); the stages fill it in.
 */
function nameModelSets(rom, stages) {
    const named = rom.courseNamed ?? (rom.courseNamed = new Map());
    for (const st of stages) {
        for (const d of st.draws) {
            if (!named.has(d.model)) named.set(d.model, new Set());
            named.get(d.model).add(d.set);
        }
    }
}
