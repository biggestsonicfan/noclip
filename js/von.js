/*
 * von.js — Virtual On's stages, read by running the game's own field code.
 *
 * A field (0x5770F0: 0-9 the ten stages, 10-13 the title, the select and the
 * ending) has three routines in the table at 0xC8E10, 12 bytes a field: the
 * one initField (0xC8FA0) calls once, the floor's that execFieldFloor
 * (0xC8F10) calls each frame, and the rest's that execField (0xC8F60) calls
 * after it. They place their pieces with coprocessor commands, sent as words
 * to the port at 0x884000, the same commands js/doa.js keeps (push 0x05,
 * pop 0x06, translate 0x12, turns 0x14-0x16) and one more, 0x2A, a scale.
 * They hand each piece to the geometrizer as an object (command 1,
 * 0x800010, then the texture point, header and mesh words to 0x804000).
 * Between the two the field code sends
 * 0x3A and the geometrizer's list address (0x802008): the copro writes the
 * matrix it holds straight into the list, so the pieces after it are drawn
 * under that one.
 *
 * So the explorer runs the field's routines on js/i960.js against that bus,
 * as js/doa.js does Dead or Alive's, from the identity: the camera is the
 * matrix the copro holds when the field code starts, so what comes out is
 * each piece's place in the field. A piece is found by its mesh word, as the
 * scanned model table (js/romset.js scanModelTable) has one model a mesh.
 */
import { I960 } from './i960.js';
import { Copro, Geo, boardToOps } from './doa.js';
import { gameLighting } from './stages.js';
import { readModelEntry, addModelTriples } from './romset.js';

const RAM_BASE = 0x500000;
const RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000;
const COPRO_CMD = 0x880000, COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const GEO_CMD = 0x800000, GEO_PORT = 0x804000, GEO_END = 0x808000;
/* The field number and the frame count execField counts up. */
const FIELD = 0x5770f0;
const FRAME = 0x577114;

function makeBus(rom, ram, copro, geo) {
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const rv = new DataView(ram.buffer);
    const other = new Map();
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE - 3;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) return cv.getUint32(a, true);
        if (inRam(a)) return rv.getUint32(a - RAM_BASE, true);
        if (a >= DATA_BASE && a - DATA_BASE < dv.byteLength - 3) return dv.getUint32(a - DATA_BASE, true);
        if (a >= COPRO_PORT && a < COPRO_END) return copro.read();
        return other.get(a) ?? 0;
    };
    const write32 = (a, v) => {
        if (inRam(a)) rv.setUint32(a - RAM_BASE, v, true);
        else if (a >= COPRO_PORT && a < COPRO_END) copro.data(v);
        else if (a >= COPRO_CMD && a < COPRO_PORT) copro.command((a >>> 4) & 0xff);
        else if (a >= GEO_PORT && a < GEO_END) geo.data(v);
        else if (a >= GEO_CMD && a < GEO_PORT) geo.command((a >>> 4) & 0x1f);
        else other.set(a, v);
    };
    const lane = (a, bytes) => [a & ~3, (a & 3) * 8, bytes === 1 ? 0xff : 0xffff];
    const isPort = (a) => (a >= COPRO_CMD && a < COPRO_END) || (a >= GEO_CMD && a < GEO_END);
    const writeLane = (a, v, bytes) => {
        const [w, s, mask] = lane(a, bytes);
        if (isPort(w)) write32(w, ((v & mask) << s) >>> 0);
        else write32(w, (read32(w) & ~(mask << s)) | (v << s));
    };
    return {
        read32,
        write32,
        read8: (a) => { const [w, s] = lane(a, 1); return (read32(w) >>> s) & 0xff; },
        read16: (a) => { const [w, s] = lane(a, 2); return (read32(w) >>> s) & 0xffff; },
        write8: (a, v) => { if (inRam(a)) ram[a - RAM_BASE] = v; else writeLane(a, v, 1); },
        write16: (a, v) => { if (inRam(a)) rv.setUint16(a - RAM_BASE, v, true); else writeLane(a, v, 2); },
    };
}

/* The model a mesh word is, out of the scanned table; the texture points
 * go with the draw where they are not that model's own. */
function meshModels(rom) {
    const byMesh = new Map();
    for (let i = rom.game.modelTable.count - 1; i >= 0; i--) byMesh.set(readModelEntry(rom, i).meshPtr, i);
    return {
        sent: [],
        lastIndex(w) {
            const i = byMesh.get(w[2]);
            if (i === undefined) return null;
            this.sent.push([w[0], w[1], w[2]]);
            const e = readModelEntry(rom, i);
            return e.uvPtr === w[0] && e.matPtr === w[1] ? { model: i } : { model: i, uv: w[0], mat: w[1] };
        },
    };
}

const routines = (rom, field) => [0, 1, 2].map((k) =>
    rom.mainCpuView.getUint32(rom.game.von.fieldRoutines + (field * 3 + k) * 4, true));

/**
 * Run one field's routines: the init, then `frames` frames of the floor's
 * and the rest's. Returns the last frame's draws, in the field's frame.
 */
export function runVonField(rom, field, { frames = 2, maxSteps = 4_000_000 } = {}) {
    const ram = new Uint8Array(RAM_SIZE);
    const rv = new DataView(ram.buffer);
    rv.setUint32(FIELD - RAM_BASE, field, true);
    const unknown = new Set();
    let geo = null;
    const copro = new Copro(unknown, {
        /* The matrix into the geometrizer's list, at the address sent. */
        0x3a: [1, (cp) => { geo.m = cp.m.slice(); }],
        /* One single, the same scale on all three axes: fields 3 and 4
         * draw their floors (0xC6EB0, 0xC7120) at 2. */
        0x2a: [1, (cp, [s]) => { cp.m = cp.m.map((v, i) => (i < 9 ? v * s : v)); }],
    });
    const models = meshModels(rom);
    geo = new Geo(copro, models);
    const cpu = new I960(makeBus(rom, ram, copro, geo));
    const [init, floor, rest] = routines(rom, field);
    cpu.call(init, [], { maxSteps });
    let draws = [], done = true;
    for (let f = 0; f < frames; f++) {
        geo.draws = [];
        copro.m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        copro.stack = [];
        const frame = rv.getUint32(FRAME - RAM_BASE, true);
        done = cpu.call(floor, [frame], { maxSteps }) && done;
        done = cpu.call(rest, [frame], { maxSteps }) && done;
        rv.setUint32(FRAME - RAM_BASE, frame + 1, true);
        draws = geo.draws;
    }
    return { draws, unknown: [...unknown], done, sent: models.sent };
}

/* The stage's name as the fight's start prints it, "   - AIRPORT -" and
 * on: `lda 0x21060[field * 18]` (0x21EE4). */
function stageName(rom, n) {
    const at = rom.game.von.names + n * 18;
    let s = '';
    for (let p = at; p < at + 18 && rom.maincpu[p]; p++) s += String.fromCharCode(rom.maincpu[p]);
    return s.replace(/^[\s-]+|[\s-]+$/g, '') || null;
}

/**
 * The fields that draw something, as stages. The triples the field code
 * sends go into the model table first (js/romset.js addModelTriples): some
 * of its meshes have no triple anywhere else.
 */
export function readVonStages(rom) {
    const V = rom.game.von;
    const lit = gameLighting(rom);
    const runs = [];
    for (let n = 0; n < V.fields; n++) {
        try {
            runs[n] = runVonField(rom, n);
        } catch (e) {
            console.warn(`von: field ${n}: ${e.message}`);
        }
    }
    addModelTriples(rom, runs.flatMap((r) => r?.sent ?? []));
    const stages = [];
    const seen = new Set();
    for (let n = 0; n < V.fields; n++) {
        const run = runs[n];
        if (!run?.draws.length) continue;
        /* 13 runs 10's routines. */
        const key = routines(rom, n).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const draws = run.draws.map((d) => ({
            model: d.model, pos: [d.m[9], d.m[10], d.m[11]], set: n, layer: 'scenery', ops: boardToOps(d.m),
        }));
        stages.push({
            slot: stages.length,
            placements: true,
            mixedSets: false,
            num: n,
            name: (n < V.named ? stageName(rom, n) : null) ?? `Field ${n}`,
            chapter: n,
            draws,
            objects: [],
            sky: null,
            zones: [],
            views: [['all', 'Everything']],
            view: 'all',
            union: 'all',
            texSets: [n],
            /* The texture bank and the colour rows: both go by the field. */
            texSet: [n, n],
            fighters: [],
            tint: [1, 1, 1],
            bright: 1,
            light: [0, 1, 2].map((k) => rom.mainCpuView.getFloat32(V.lights + n * 12 + k * 4, true)),
            materials: lit?.materials,
            colorCycles: [],
            floorSize: 0,
            meta: [['field', n], ['pieces', draws.length],
                ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
        });
    }
    return stages;
}

/* ---- the robots ------------------------------------------------------------ */

/*
 * A robot is a record in the program (`rig.robots`, ten pointers; the name is
 * at +0x6BC), and the draw (0x33xxx, the legs 0x8DD40 and the body 0x8DFC0)
 * reads three part lists out of it, each a pointer and a count:
 *
 *   +0x00 the weapons    +0x08 the upper body    +0x10 the legs
 *
 * A list entry is 8 bytes. A nonzero first word means the entry is drawn, and
 * the second points at its variants, 16 bytes each: the texture point, the
 * header, a second header (for a flag at +0x1AA of the robot's object) and the
 * mesh word. Which variant is a halfword of the object's per part; the
 * explorer draws variant 0. A zero first word with -1 is a part that is not
 * drawn, and with 0-5 a slot: the part's frame entry is kept (0x562430 + slot
 * * 12) for what is drawn off it later. Slot 0 is the waist, which the legs
 * list ends on, and slot 1 the hand the weapon list's entry 1 is drawn in.
 *
 * Zig-Raht's record, the last (`rig.boss`), has no upper body list: its own
 * draw (0x3A510) sends its legs list alone, 26 parts, to the same part draw,
 * its variants by the object's +0xB0. Its slot 0 is where the draw hangs its
 * effects (0x2BE31DC), which are not drawn here.
 */
const ROBOT_WEAPONS = 0x00, ROBOT_BODY = 0x08, ROBOT_LEGS = 0x10;
const ROBOT_MOTIONS = 0x70, ROBOT_PAIRS = 103;
const ROBOT_NAME = 0x6bc;
/* Nonzero where the weapon turns with the aim (0x34124); Fei-Yen's and
 * Bal-Bas-Bow's are 0. */
const ROBOT_AIMS = 0x484;
/* The robot whose weapon is drawn 0.3 up from its hand (the object's +0x64,
 * its index in the table, 5: Fei-Yen; 0x340E4). */
const RAISED_WEAPON = 5;

/* The data ROM's view of an address, or null off its end. */
function dataAt(rom, a) {
    const off = a - DATA_BASE;
    return off >= 0 && off < rom.mainDataView.byteLength ? off : null;
}

function readList(rom, struct, at) {
    const dv = rom.mainCpuView;
    const ptr = dv.getUint32(struct + at, true), count = dv.getUint32(struct + at + 4, true);
    if (!ptr || count > 64 || ptr + count * 8 > rom.maincpu.length) return [];
    return Array.from({ length: count }, (_, i) => {
        const drawn = dv.getUint32(ptr + i * 8, true), word = dv.getUint32(ptr + i * 8 + 4, true);
        if (!drawn) return { slot: word <= 5 ? word : -1 };
        const v = (k) => dv.getUint32(word + k * 4, true);
        return { slot: -1, variants: word, triple: word + 16 <= rom.maincpu.length ? [v(0), v(1), v(3)] : null };
    });
}

/**
 * The robots, as bodies.js bodies: the legs' parts hung off a base, the upper
 * body's off the waist, the weapon off the hand. A part's `joint` is its entry
 * in its list (`list` says which); the matrices come from `poseVonRobot`.
 * The triples the draw sends go into the model table first, as the field
 * code's do (js/romset.js addModelTriples).
 */
export function readVonBodies(rom) {
    const R = rom.game.rig;
    const dv = rom.mainCpuView;
    const robots = [];
    for (let i = 0; i < R.count; i++) {
        const struct = dv.getUint32(R.robots + i * 4, true);
        if (struct + ROBOT_NAME + 16 > rom.maincpu.length) continue;
        const legs = readList(rom, struct, ROBOT_LEGS), upper = readList(rom, struct, ROBOT_BODY);
        const weapons = readList(rom, struct, ROBOT_WEAPONS);
        const boss = i === R.boss?.robot;
        if (!legs.length || (!upper.length && !boss)) continue;
        let name = '';
        for (let p = struct + ROBOT_NAME; rom.maincpu[p] && name.length < 16; p++) name += String.fromCharCode(rom.maincpu[p]);
        const aims = dv.getUint32(struct + ROBOT_AIMS, true) !== 0;
        robots.push({ i, struct, name, legs, upper: boss ? [] : upper, aims,
            weapon: boss ? null : weapons[1]?.triple ?? null, weaponVariants: weapons[1]?.variants });
    }
    addModelTriples(rom, robots.flatMap((r) => [...r.legs, ...r.upper].map((e) => e.triple)
        .concat([r.weapon]).filter(Boolean)));
    const byMesh = new Map();
    for (let k = rom.game.modelTable.count - 1; k >= 0; k--) byMesh.set(readModelEntry(rom, k).meshPtr, k);
    const model = (e) => (e?.triple ? byMesh.get(e.triple[2]) ?? 0 : 0);
    return robots.map((r) => {
        const parts = [{ list: 'base', joint: 0, parent: -1, model: 0 }];
        r.legs.forEach((e, j) => parts.push({ list: 'legs', joint: j, parent: 0, model: model(e), slot: e.slot, variants: e.variants }));
        const waist = parts.findIndex((p) => p.list === 'legs' && p.slot === 0);
        r.upper.forEach((e, j) => parts.push({ list: 'body', joint: j, parent: waist, model: model(e), slot: e.slot, variants: e.variants }));
        const hand = parts.findIndex((p) => p.list === 'body' && p.slot === 1);
        if (r.weapon && hand >= 0) parts.push({ list: 'weapon', joint: 0, parent: hand, model: model({ triple: r.weapon }), variants: r.weaponVariants });
        return {
            index: r.i,
            name: r.name,
            joints: r.legs.length + r.upper.length,
            scale: 1,
            roles: [],
            skin: -1,
            hitMotions: [],
            start: -1,
            root: r.struct,
            /* The weapon turns with the aim (record +0x484). */
            aims: r.aims,
            /* Player 1's colour rows, SetRoboRamp's for the robot's first
             * costume (js/colors.js buildVonColorxlat). */
            colours: { char: r.i, costume: 0 },
            parts: parts.map((p, index) => ({
                ...p, index, depth: p.parent < 0 ? 0 : p.list === 'body' ? 2 : p.list === 'weapon' ? 3 : 1,
                offset: [0, 0, 0], flags: 0, record: r.struct,
            })),
        };
    });
}

/* A record: the data's address, the frames and the parts, negative where the
 * frames run backwards from the address (the draw steps by the signed count
 * and loops over its size). */
function readRecord(rom, a) {
    const off = dataAt(rom, a);
    if (off === null || off + 8 > rom.mainDataView.byteLength) return null;
    const dv = rom.mainDataView;
    const data = dataAt(rom, dv.getUint32(off, true));
    const frames = dv.getUint16(off + 4, true), parts = dv.getInt16(off + 6, true);
    if (data === null || !frames || !parts) return null;
    return { address: a, data, frames, parts };
}

/* The object a robot's own routines are run on (player 1's), and what they
 * read and write besides it: the game's frame count, the scene, the robot's
 * record, and the pair and frames the draw takes (legs, upper body). */
const OBJECT = 0x503ad0;
const OBJ_ROBOT = 0x6c, OBJ_ACTION = 0x172, OBJ_STATE = 0x170, OBJ_SECTOR = 0x188;
const GAME_FRAME = 0x5024e8, SCENE = 0x503a00, ROBOT = 0x51ab14;
const POSE_LEGS = 0x51ab08, POSE_UPPER = 0x51ab0c, POSE_LEGS_FRAME = 0x51ab10, POSE_UPPER_FRAME = 0x51ab12;
/* A part's variant, a halfword of the object (the draws at 0x8DF3C, 0x8E28C
 * and 0x3428C): the legs' from +0xDA, the upper body's from +0xB6, the
 * weapon's at +0xB2. */
const VARIANTS = { legs: 0xda, body: 0xb6, weapon: 0xb2 };
/* The record's routines: the one the draw calls first (0x33C40), which steps
 * the parts' variants, and the actions 42 and 41 call (0x32540, 0x324E0). */
const ROBOT_PARTS = 0x434, ROBOT_WIN = 0x43c, ROBOT_LOSS = 0x440;
/* The attack's routines (action 16, 0x2FB20) the record holds for a robot on
 * the move, by the object's +0x170: 2 dashing (+0x3AC), 3 jumping (+0x3B4).
 * The fight picks one of four by where its opponent is (+0x188, set from the
 * angle at +0x102 at 0x36578-0x365E8). */
const ATTACK = 16;
const MOVING_ATTACKS = [['dash attack', 2, 0x3ac], ['jump attack', 3, 0x3b4]];
const SECTORS = 4;
/* 0x503A00 in a played fight (the attract's is 7): Temjin's loss and others
 * pose their parts only in it. */
const FIGHT_SCENE = 12;

/**
 * Run one of a robot's action routines as the fight does, a call a frame on
 * player 1's object, then its parts routine as the draw does. `choice` is
 * what the game's random draw (rig.random) answers: a win picks one of two
 * pairs by it on its first frame. `state` and `sector` start the object's
 * +0x170 and +0x188; with `state`, the run lasts until the routine moves the
 * object out of it or out of the action. Returns per frame the pair, the
 * frames and each part's variant.
 */
function runVonAction(rom, body, routine, action, { choice = 0, scene = FIGHT_SCENE, frames = 0, state = 0, sector = 0, maxSteps = 200_000 } = {}) {
    const ram = new Uint8Array(RAM_SIZE);
    const rv = new DataView(ram.buffer);
    const copro = new Copro(new Set());
    const cpu = new I960(makeBus(rom, ram, copro, new Geo(copro, meshModels(rom))));
    cpu.hooks.set(rom.game.rig.random, (c) => { c.setReg(16, choice); });
    const put = (a, v) => rv.setUint32(a - RAM_BASE, v, true);
    const u32 = (a) => rv.getUint32(a - RAM_BASE, true), u16 = (a) => rv.getUint16(a - RAM_BASE, true);
    put(OBJECT + OBJ_ROBOT, body.root);
    rv.setUint16(OBJECT + OBJ_ACTION - RAM_BASE, action, true);
    rv.setUint16(OBJECT + OBJ_STATE - RAM_BASE, state, true);
    rv.setUint16(OBJECT + OBJ_SECTOR - RAM_BASE, sector, true);
    put(ROBOT, body.root);
    put(SCENE, scene);
    const parts = rom.mainCpuView.getUint32(body.root + ROBOT_PARTS, true);
    const out = [];
    for (let f = 0; f === 0 || f < frames; f++) {
        put(GAME_FRAME, f);
        if (!cpu.call(routine, [OBJECT], { maxSteps })) return null;
        if (parts && !cpu.call(parts, [OBJECT], { maxSteps })) return null;
        out.push({
            legs: u32(POSE_LEGS), upper: u32(POSE_UPPER),
            legsFrame: u16(POSE_LEGS_FRAME), upperFrame: u16(POSE_UPPER_FRAME),
            variants: body.parts.map((p) => (p.list === 'base' ? 0 : u16(OBJECT + VARIANTS[p.list] + 2 * p.joint))),
        });
        if (state) {
            if (u16(OBJECT + OBJ_STATE) !== state || u16(OBJECT + OBJ_ACTION) !== action) break;
            if (f >= 1000) return null;
            frames = f + 2;
        } else if (!frames) frames = readRecord(rom, out[0].legs)?.frames ?? 1;
    }
    return out;
}

/* The model a part's variant draws, 0 for none (its mesh word is 0). */
function variantTriple(rom, part, v) {
    if (!part.variants) return null;
    const at = part.variants + v * 16, dv = rom.mainCpuView;
    if (at + 16 > rom.maincpu.length) return null;
    const mesh = dv.getUint32(at + 12, true);
    return mesh ? [dv.getUint32(at, true), dv.getUint32(at + 4, true), mesh] : null;
}

/**
 * Each robot's motions: 103 pairs of records from +0x70, the upper body's then
 * the legs', played together on one frame count. The draw (0x2EE70) reads them
 * as 0x1D8[n * 40] and 0x1DC[n * 40], groups of five pairs. Repeats of a pair
 * are dropped; the game names none, so a motion is its first pair's number.
 */
export function readVonMotions(rom, bodies) {
    const dv = rom.mainCpuView;
    const boss = rom.game.rig.boss;
    const out = [];
    for (const body of bodies) {
        /* Zig-Raht plays the records its own code sets (rig.boss), its legs
         * list's alone; where each is set stands in for a pair. */
        if (body.index === boss?.robot) {
            for (const [routine, at] of boss.records) {
                const legs = readRecord(rom, at);
                if (!legs) continue;
                out.push({
                    index: out.length, robot: body.index, pair: -1, routine, name: `0x${at.toString(16)}`,
                    joints: body.joints, frames: legs.frames, address: at, upper: null, legs, view: rom.mainDataView,
                });
            }
            continue;
        }
        const seen = new Set();
        for (let n = 0; n < ROBOT_PAIRS; n++) {
            const at = body.root + ROBOT_MOTIONS + n * 8;
            const upper = readRecord(rom, dv.getUint32(at, true)), legs = readRecord(rom, dv.getUint32(at + 4, true));
            if (!upper || !legs) continue;
            const key = `${upper.address},${legs.address}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                index: out.length,
                robot: body.index,
                pair: n,
                name: `motion ${n}`,
                joints: body.joints,
                frames: Math.max(upper.frames, legs.frames),
                address: upper.address,
                upper,
                legs,
                view: rom.mainDataView,
            });
        }
        const runs = [
            ['win 1', ROBOT_WIN, 42, { choice: 0 }],
            ['win 2', ROBOT_WIN, 42, { choice: 1 }],
            ['loss', ROBOT_LOSS, 41, {}],
        ];
        for (const [name, state, routine] of MOVING_ATTACKS) {
            for (let sector = 0; sector < SECTORS; sector++) runs.push([`${name} ${sector}`, routine, ATTACK, { state, sector }]);
        }
        /* A routine that ignores the sector plays the same run for each:
         * one is kept. */
        const played = new Set();
        for (const [name, routine, action, opts] of runs) {
            const at = dv.getUint32(body.root + routine, true);
            const script = at ? runVonAction(rom, body, at, action, opts) : null;
            if (!script) continue;
            const key = `${at}:${script.map((s) => [s.legs, s.upper, s.legsFrame, s.upperFrame, ...s.variants].join()).join(';')}`;
            if (played.has(key)) continue;
            played.add(key);
            const upper = readRecord(rom, script[0].upper), legs = readRecord(rom, script[0].legs);
            if (!upper || !legs) continue;
            out.push({
                index: out.length, robot: body.index, pair: -1, routine: at, name, joints: body.joints,
                frames: script.length, address: upper.address, upper, legs, view: rom.mainDataView, script,
            });
        }
    }
    /* The variants the runs show go into the model table as the rest do. */
    const scripted = out.filter((m) => m.script);
    const triples = [];
    for (const m of scripted) {
        const body = bodies.find((b) => b.index === m.robot);
        for (const s of m.script) {
            s.triples = body.parts.map((p, i) => variantTriple(rom, p, s.variants[i]));
            triples.push(...s.triples.filter(Boolean));
        }
    }
    addModelTriples(rom, triples);
    const byMesh = new Map();
    for (let k = rom.game.modelTable.count - 1; k >= 0; k--) byMesh.set(readModelEntry(rom, k).meshPtr, k);
    for (const m of scripted) {
        for (const s of m.script) {
            s.models = s.triples.map((t) => (t ? byMesh.get(t[2]) ?? 0 : 0));
            s.upper = readRecord(rom, s.upper);
            s.legs = readRecord(rom, s.legs);
            delete s.triples;
        }
    }
    return out;
}

/** A robot plays its own record's motions and nothing else's. */
export function vonMotionList(rom, body, motions) {
    const fits = motions.filter((m) => m.robot === body.index);
    return { fits, lead: fits, label: 'Its motions, in its record\'s order' };
}

/* An IEEE half, as the copro's 0x2F reads the low 16 bits of each word. */
function half(h) {
    const e = (h >> 10) & 0x1f, f = h & 0x3ff, s = h & 0x8000 ? -1 : 1;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
}

/* One part's frame entry, 12 bytes: three s16 angles (x, y, z) and three
 * half-float offsets. Frame 0 is the record's first; past the end it holds
 * the last. */
function readEntry(motion, rec, frame, j) {
    if (!rec || j >= Math.abs(rec.parts)) return null;
    const at = rec.data + (Math.min(frame, rec.frames - 1) * rec.parts + j) * 12;
    const v = motion.view;
    if (at < 0 || at + 12 > v.byteLength) return null;
    return {
        r: [0, 2, 4].map((k) => v.getInt16(at + k, true)),
        t: [6, 8, 10].map((k) => half(v.getUint16(at + k, true))),
    };
}

/* T(t)·Rz·Ry·Rx, the order every part is drawn in; and its inverse. */
function local(cp, e) {
    cp.translate(e.t);
    cp.turn('z', e.r[2]); cp.turn('y', e.r[1]); cp.turn('x', e.r[0]);
}
function unlocal(cp, e) {
    cp.turn('x', -e.r[0]); cp.turn('y', -e.r[1]); cp.turn('z', -e.r[2]);
    cp.translate(e.t.map((x) => -x));
}

/**
 * Pose a robot on one frame (from 1) of one of its motions.
 *
 * Each leg part is drawn at T·Rz·Ry·Rx of its entry from the robot's place.
 * Then the waist (the legs' slot 0) the same way, turned on y by the twist
 * the fight gives the upper body (the object's +0x36, `aim.twist`; 0x33F70);
 * then the inverse of the upper body's entry 0, its root; then each upper
 * body part at its entry. The weapon is drawn at the hand's (slot 1) entry,
 * under the upper body's root, Fei-Yen's 0.3 up from it (0x340E4), and then,
 * where the record lets it (+0x484), turned on y by the aim's turn (+0x3A)
 * and on x by its tilt (+0x38) (0x3412C). The fight sets the three as the
 * robot turns toward its opponent; `aim` holds them, 0x10000 a turn.
 *
 * The draw loops over the record's own count of parts, so a list entry past
 * it is not drawn on that motion: Temjin's upper body list has 17 entries,
 * its records 15, and Dorkas has records of 13 among its 17s.
 *
 * @returns {{matrices: number[][], origins: number[][], draws: number[][]}}
 *   column-major 4x4s, z the board's negated, and the models on each part
 */
export function poseVonRobot(rom, body, motion, frame, { aim = null } = {}) {
    const own = motion?.robot === body.index ? motion : null;
    const f = Math.max(0, frame - 1);
    /* A run's frame names its own pair, frames and variants. */
    const run = own?.script?.[Math.min(f, own.script.length - 1)];
    const entry = (list, j) => {
        if (!own) return null;
        if (run) return list === 'legs' ? readEntry(own, run.legs, run.legsFrame, j) : readEntry(own, run.upper, run.upperFrame, j);
        return readEntry(own, list === 'legs' ? own.legs : own.upper, f, j);
    };
    const cp = new Copro(new Set());
    const at = (m) => { cp.m = m.slice(); };
    const base = cp.m.slice();
    const waist = body.parts.find((p) => p.list === 'legs' && p.slot === 0);
    at(base);
    const w = waist && entry('legs', waist.joint);
    if (w) local(cp, w);
    if (aim?.twist) cp.turn('y', aim.twist);
    const root = entry('body', 0);
    if (root) unlocal(cp, root);
    const upper = cp.m.slice();
    const shown = [];
    const mats = body.parts.map((p, i) => {
        if (p.list === 'base') return base;
        const hand = p.list === 'weapon' ? body.parts[p.parent] : p;
        at(hand.list === 'legs' ? base : upper);
        const e = entry(hand.list, hand.joint);
        if (e) local(cp, e);
        if (p.list === 'weapon') {
            if (body.index === RAISED_WEAPON) cp.translate([0, 0.3, 0]);
            if (body.aims && aim) { cp.turn('y', aim.turn ?? 0); cp.turn('x', aim.tilt ?? 0); }
        }
        shown[i] = Boolean(e) || !own;
        return cp.m;
    });
    return {
        draws: body.parts.map((p, i) => {
            const m = run && p.list !== 'base' ? run.models[i] : p.model;
            return m && shown[i] ? [m] : [];
        }),
        matrices: mats.map((m) => [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1]),
        origins: mats.map((m) => [m[9], m[10], -m[11]]),
    };
}
