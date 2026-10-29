/*
 * gunbladeplayers.js — Gunblade NY's figures (MAME's `gunblade`): the
 * soldiers, gangsters and hostages the street scenes put up, posed by the
 * game's motion table and drawn by its own draw routine run on the i960.
 *
 * A figure is an object (0x502340 is one the attract uses) with
 *     +0x00 the place (three floats), +0x0E the heading (the draw sends
 *           it less 0x8000), +0x58 the distance (the level of detail),
 *     +0x60 the animation record, +0x94 the figure type, +0x98 the kind
 *           (which draw routine, the table at 0x24E30, 16 bytes a kind),
 *     +0xB8 the scale (1.2 for the attract's), +0x118 the hand's scale,
 *     +0x158 + 0x3C l the part lists of detail level l (word k = part k's
 *           mesh triple; the nearest list when the object is *0x508BF0).
 * The type picks two pointers from 0x9D670 + 8 type: the mesh triples
 * (12 bytes a part, part 0 unused) and the skeleton (a float triple a
 * part, 12 bytes; part k's is its bone at +12 k). 0x9DB10 + 4 type scales
 * the root's place.
 *
 * The animation record (0x96EF0 starts a step, 0x96D40 is the tick, which
 * the boot copies to RAM 0x532E50 and runs there):
 *     +0x00 the motion's entry, +0x04 the step's, +0x08 the motion,
 *     +0x0C the step, +0x10 the frame in the step, +0x14 the step's frames,
 *     +0x18 done, +0x1C 17 (triples), +0x20 the speed (1.0),
 *     +0x24 + 12 k the values now, +0x114 + 12 k the step a frame,
 *     +0x204 + 12 k the step's target (its key).
 * Triple 0 is the root's turn, 1..15 the parts' X, Y and Z turns (floats,
 * 0x10000 a turn) and 16 the root's place.
 *
 * A motion is `0x95E80 + 8 n`: {steps, u8 count, u8 flags}; flags 1 plays
 * once and holds the last key, 0 loops. A step is {key, u8 frames}: the
 * values go from where they are to the key in straight lines over the
 * frames (frames times the speed when over 1), and land on it exactly. A
 * key is 17 float triples (0xCC bytes), in the program or the data ROM
 * (0x2000000 on); the last motions' keys are built in RAM at run time and
 * are left out. 0x97020 (record, motion) starts a motion from all values 0.
 *
 * The draw 0x9DC70 (the people) or 0xA3140 (types 32 and 33): push; the
 * object (copro 0x87: heading, place, scale); the root (0x2C: triple 0's
 * turns, triple 16 times the type's scale); then each part a 0x2C of its
 * Z, Y and X turns (the values truncated) and its bone, the matrix to the
 * list (0x39) and its mesh. 0x2C is M = M T(bone) Rz(-z) Ry(-y) Rx(-x) in
 * the board's matrices (three columns then the place). The hand is scaled
 * by +0x118 (copro 0x2A). Checked against MAME's matrices for the attract's
 * five figures at frame 1500: every part's frame relative to the hips
 * within 2e-5.
 */

import { I960 } from './i960.js';
import { readModelEntry } from './romset.js';

const RAM_BASE = 0x500000;
const RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000;
const COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const GEO_OBJECT = 0x800010, GEO_PORT = 0x804000, GEO_END = 0x808000;

const MOTIONS = 0x95e80;
const MOTION_COUNT = 472;
const TYPES = 0x9d670;
const TYPE_COUNT = 120;
const JOINTS = 17;
const KEY_BYTES = JOINTS * 12;

const OBJ = 0x502340;
const ANIM = 0x508308;
const NEAREST = 0x508bf0;
const DRAW_PEOPLE = 0x9dc70;
const DRAW_OTHER = 0xa3140;
/* Types 32 and 33 go through 0xA3140 (the attract draws them so); the
 * rest through the people's draw. */
const OTHER_TYPES = new Set([32, 33]);

/* The people's draw's parts in the order it sends them, by the triple each
 * takes; −X and +X are the board's sides (the figure faces −Z unturned). */
const PEOPLE_PARTS = [
    [1, 'hips'], [2, 'chest'], [6, 'upper arm −X'], [7, 'forearm −X'], [8, 'hand −X'],
    [3, 'upper arm +X'], [4, 'forearm +X'], [5, 'hand +X'], [15, 'head'],
    [12, 'thigh −X'], [13, 'shin −X'], [14, 'foot −X'], [9, 'thigh +X'], [10, 'shin +X'], [11, 'foot +X'],
];

/* Types and motions MAME's attract shows (its first 6500 frames). */
const ATTRACT = {
    2: [0x16, 0x18, 0x19, 0x23, 0x26, 0x29, 0x2d, 0x2e, 0x3b, 0x3d, 0x48, 0x83, 0xa7, 0xac, 0xc0, 0xc7, 0xc8, 0xe7, 0x127, 0x132, 0x143, 0x144, 0x14e, 0x171, 0x174, 0x175],
    4: [0x23, 0x26, 0x3c, 0x3f, 0x43, 0x83, 0x95, 0xa6, 0xc7, 0xc8, 0xdc, 0x138, 0x13a, 0x150, 0x151, 0x176, 0x1a5, 0x1a6, 0x1b5, 0x1b6, 0x1c3],
    6: [0x26, 0x29, 0x3c, 0x3f, 0x43, 0x67, 0xa6, 0xa7, 0xc7, 0xdc, 0x132, 0x13a, 0x150],
    12: [0x43, 0x1a3, 0x1b5, 0x1c2],
    18: [0x10d, 0x188, 0x194],
    20: [0x196], 21: [0x167, 0x197], 22: [0x18c, 0x1a7], 23: [0x195], 24: [0x15a], 29: [0x155],
    32: [0x189, 0x191, 0x1b7], 33: [0x189, 0x18d, 0x191],
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const f32 = Math.fround;
const bitsF = new DataView(new ArrayBuffer(4));
const toFloat = (w) => { bitsF.setUint32(0, w >>> 0, true); return bitsF.getFloat32(0, true); };
const s16 = (w) => (w << 16) >> 16;

/* ---- board matrices: three columns, then the place ---- */
function mul(a, b) {
    const r = new Array(12);
    for (let c = 0; c < 4; c++) {
        for (let i = 0; i < 3; i++) {
            let v = a[i] * b[c * 3] + a[3 + i] * b[c * 3 + 1] + a[6 + i] * b[c * 3 + 2];
            if (c === 3) v += a[9 + i];
            r[c * 3 + i] = v;
        }
    }
    return r;
}
const ANGLE = (2 * Math.PI) / 0x10000;
function turn(axis, a) {
    const c = Math.cos(a * ANGLE), s = Math.sin(a * ANGLE);
    if (axis === 0) return [1, 0, 0, 0, c, s, 0, -s, c, 0, 0, 0];
    if (axis === 1) return [c, 0, -s, 0, 1, 0, s, 0, c, 0, 0, 0];
    return [c, s, 0, -s, c, 0, 0, 0, 1, 0, 0, 0];
}
const place = (t) => [1, 0, 0, 0, 1, 0, 0, 0, 1, t[0], t[1], t[2]];
const scaled = (s) => [s, 0, 0, 0, s, 0, 0, 0, s, 0, 0, 0];

/* The copro commands the figure draws send: {words, run}. */
const COPRO = {
    0x05: [0, (cp) => cp.stack.push(cp.top)],
    0x06: [0, (cp) => { cp.top = cp.stack.pop() ?? cp.root(); }],
    0x2b: [0, () => {}],
    /* The object: heading (short), place, scale. */
    0x87: [5, (cp, a) => {
        cp.top = { m: mul(mul(place(a.slice(1, 4).map(toFloat)), turn(1, s16(a[0]))), scaled(toFloat(a[4]))), part: -1 };
    }],
    /* Z, Y and X turns (shorts) after a move. */
    0x2c: [6, (cp, a) => {
        let m = mul(cp.top.m, place(a.slice(3).map(toFloat)));
        m = mul(m, turn(2, -s16(a[0])));
        m = mul(m, turn(1, -s16(a[1])));
        m = mul(m, turn(0, -s16(a[2])));
        cp.top = { m, part: cp.top.part };
    }],
    0x2a: [1, (cp, a) => { cp.top = { m: mul(cp.top.m, scaled(toFloat(a[0]))), part: cp.top.part }; }],
    0x39: [1, (cp) => {
        cp.parts.push({ m: cp.top.m, parent: cp.top.part });
        cp.top = { m: cp.top.m, part: cp.parts.length - 1 };
    }],
    0x51: [13, () => {}],
};

class Copro {
    constructor() { this.reset(); }
    root() { return { m: IDENTITY, part: -1 }; }
    reset() {
        this.top = this.root();
        this.stack = [];
        this.parts = [];
        this.pending = null;
        this.args = [];
        this.unknown = new Set();
    }
    data(w) {
        if (this.pending === null) {
            if (!COPRO[w]) { this.unknown.add(w); return; }
            this.pending = w;
            this.args = [];
        } else this.args.push(w >>> 0);
        const [n, run] = COPRO[this.pending];
        if (this.args.length < n) return;
        const cmd = this.pending;
        this.pending = null;
        run(this, this.args, cmd);
    }
}

/* The model a mesh triple is, out of the scanned table. */
const meshMaps = new WeakMap();
function modelOf(rom, w) {
    let byMesh = meshMaps.get(rom);
    if (!byMesh) {
        byMesh = new Map();
        for (let i = rom.game.modelTable.count - 1; i >= 0; i--) byMesh.set(readModelEntry(rom, i).meshPtr, i);
        meshMaps.set(rom, byMesh);
    }
    const i = byMesh.get(w[2]);
    if (i === undefined) return null;
    const e = readModelEntry(rom, i);
    return e.uvPtr === w[0] && e.matPtr === w[1] ? { model: i } : { model: i, uv: w[0], mat: w[1] };
}

function makeBus(rom, ram, copro, geo) {
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const rv = new DataView(ram.buffer);
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE - 3;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) return cv.getUint32(a, true);
        if (inRam(a)) return rv.getUint32(a - RAM_BASE, true);
        if (a >= DATA_BASE && a - DATA_BASE < dv.byteLength - 3) return dv.getUint32(a - DATA_BASE, true);
        return 0;
    };
    const write32 = (a, v) => {
        if (inRam(a)) rv.setUint32(a - RAM_BASE, v, true);
        else if (a >= COPRO_PORT && a < COPRO_END) copro.data(v >>> 0);
        else if (a === GEO_OBJECT) { if (v === 0x101) geo.words = []; }
        else if (a >= GEO_PORT && a < GEO_END && geo.words) {
            geo.words.push(v >>> 0);
            if (geo.words.length === 3) { geo.draws.push({ part: copro.parts.length - 1, words: geo.words }); geo.words = null; }
        }
    };
    /* A short store to a port is the value in its lane (MAME's handlers take
     * the whole bus word). */
    const lane = (a, bytes) => [a & ~3, (a & 3) * 8, bytes === 1 ? 0xff : 0xffff];
    const writeLane = (a, v, bytes) => {
        const [w, s, mask] = lane(a, bytes);
        if (inRam(w)) write32(w, (read32(w) & ~(mask << s)) | ((v & mask) << s));
        else write32(w, ((v & mask) << s) >>> 0);
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

const machines = new WeakMap();
function machine(rom) {
    if (!machines.has(rom)) {
        const ram = new Uint8Array(RAM_SIZE);
        const copro = new Copro();
        const geo = { words: null, draws: [] };
        const cpu = new I960(makeBus(rom, ram, copro, geo));
        machines.set(rom, { ram, rv: new DataView(ram.buffer), copro, geo, cpu });
    }
    return machines.get(rom);
}

/* A key's 17 triples, or null when it is not in a ROM. */
function readKey(rom, at) {
    if (at > 0 && at + KEY_BYTES <= rom.mainCpuView.byteLength) {
        return Array.from({ length: JOINTS * 3 }, (_, i) => rom.mainCpuView.getFloat32(at + 4 * i, true));
    }
    const off = at - DATA_BASE;
    if (off >= 0 && off + KEY_BYTES <= rom.mainDataView.byteLength) {
        return Array.from({ length: JOINTS * 3 }, (_, i) => rom.mainDataView.getFloat32(off + 4 * i, true));
    }
    return null;
}

/** The 472 motions' table; motions whose keys are built in RAM are left out. */
export function readGunbladeMotions(rom) {
    const v = rom.mainCpuView;
    const list = [];
    for (let i = 0; i < MOTION_COUNT; i++) {
        const entry = MOTIONS + 8 * i;
        const steps = v.getUint32(entry, true), count = v.getUint8(entry + 4), flags = v.getUint8(entry + 5);
        if (!count || steps + 8 * count > v.byteLength) continue;
        const keys = [];
        for (let s = 0; s < count; s++) {
            const key = readKey(rom, v.getUint32(steps + 8 * s, true));
            const frames = v.getUint8(steps + 8 * s + 4);
            if (!key || !frames) { keys.length = 0; break; }
            keys.push({ address: v.getUint32(steps + 8 * s, true), frames, values: key });
        }
        if (!keys.length) continue;
        const frames = keys.reduce((n, k) => n + k.frames, 0);
        list[i] = {
            index: i, name: `motion ${i} (0x${i.toString(16)})`, address: entry, steps: keys,
            loop: flags !== 1, frames, keys: count, joints: JOINTS,
        };
    }
    return list;
}

/*
 * The values a motion has after `ticks` frames (0x96EF0 and 0x96D40, in
 * float32). `start`: 'zero' is the game's own start (0x97020, every value
 * 0); 'key' starts on the first key, and 'loop' (the default) on the last
 * key for a looping motion, as if it had gone round once, and on the first
 * for one that plays once. `step` starts at a later step, from the key
 * before it.
 */
export function gunbladeValues(motion, ticks, { start = 'loop', speed = 1, step: first = 0 } = {}) {
    const n = motion.steps.length;
    let cur = start === 'zero' ? new Array(JOINTS * 3).fill(0)
        : first > 0 ? motion.steps[first - 1].values.map(f32)
            : (start === 'loop' && motion.loop ? motion.steps[n - 1] : motion.steps[0]).values.map(f32);
    let step = first, count = 0, frames = 0, delta = null, target = null, done = false;
    const begin = () => {
        let f = motion.steps[step].frames;
        if (f > 1) f = f32(f * speed);
        frames = Math.trunc(f);
        target = motion.steps[step].values.map(f32);
        delta = target.map((t, i) => f32(f32(t - cur[i]) / f));
        count = 0;
    };
    begin();
    for (let t = 0; t < ticks && !done; t++) {
        count++;
        if (count < frames) cur = cur.map((c, i) => f32(c + delta[i]));
        else {
            cur = target.slice();
            step++;
            if (step >= n) {
                step = 0;
                if (!motion.loop) { done = true; break; }
            }
            begin();
        }
    }
    return cur;
}

/* Run a type's draw on the values; the matrices it sends and its meshes. */
function draw(rom, type, values) {
    const M = machine(rom);
    const o = OBJ - RAM_BASE, a = ANIM - RAM_BASE;
    M.ram.fill(0, o, o + 0x300);
    M.ram.fill(0, a, a + 0x300);
    M.rv.setUint32(NEAREST - RAM_BASE, OBJ, true);
    M.rv.setUint16(o + 0x0e, 0x8000, true);
    M.rv.setUint32(o + 0x60, ANIM, true);
    M.rv.setUint32(o + 0x94, type, true);
    M.rv.setUint32(o + 0x98, 0x0a, true);
    M.rv.setFloat32(o + 0xb8, 1, true);
    M.rv.setFloat32(o + 0x118, 1, true);
    /* No shadow (0x9F2F0 draws it while *0x52A154 > +0xC0). */
    M.rv.setFloat32(o + 0xc0, 1e30, true);
    const meshes = rom.mainCpuView.getUint32(TYPES + 8 * type, true);
    for (let l = 0; l < 4; l++) {
        for (let k = 1; k < 16; k++) M.rv.setUint32(o + 0x158 + 0x3c * l + 4 * k, meshes + 12 * k, true);
    }
    M.rv.setUint32(a + 0x1c, JOINTS, true);
    M.rv.setFloat32(a + 0x20, 1, true);
    values.forEach((v, i) => M.rv.setFloat32(a + 0x24 + 4 * i, v, true));
    M.copro.reset();
    M.geo.draws = [];
    M.geo.words = null;
    const entry = OTHER_TYPES.has(type) ? DRAW_OTHER : DRAW_PEOPLE;
    if (!M.cpu.call(entry, [OBJ], { maxSteps: 200_000 })) throw new Error(`gunblade draw 0x${entry.toString(16)} did not return`);
    const draws = M.copro.parts.map(() => []);
    for (const d of M.geo.draws) {
        const named = d.part >= 0 && modelOf(rom, d.words);
        if (named) draws[d.part].push(named.model);
    }
    return { parts: M.copro.parts, draws, unknown: [...M.copro.unknown] };
}

/** The figure types of 0x9D670: their meshes, skeleton and parts. */
export function readGunbladeBodies(rom) {
    const v = rom.mainCpuView;
    const out = [];
    for (let type = 0; type < TYPE_COUNT; type++) {
        const meshes = v.getUint32(TYPES + 8 * type, true), skeleton = v.getUint32(TYPES + 8 * type + 4, true);
        if (!meshes || !skeleton || meshes >= v.byteLength || skeleton >= v.byteLength) continue;
        let run;
        try { run = draw(rom, type, new Array(JOINTS * 3).fill(0)); } catch { continue; }
        if (!run.parts.length || run.draws.every((d) => !d.length)) continue;
        const people = !OTHER_TYPES.has(type) && run.parts.length === PEOPLE_PARTS.length;
        const parts = run.parts.map((p, k) => {
            let depth = 0;
            for (let q = p.parent; q >= 0; q = run.parts[q].parent) depth++;
            const joint = people ? PEOPLE_PARTS[k][0] : k + 1;
            return {
                index: k, name: people ? PEOPLE_PARTS[k][1] : `part ${k + 1}`, parent: p.parent, depth, joint, flags: 0,
                offset: [0, 1, 2].map((i) => v.getFloat32(skeleton + 12 * joint + 4 * i, true)),
                record: meshes + 12 * joint, model: run.draws[k][0] ?? null,
            };
        });
        out.push({
            index: out.length, name: `type ${type}${ATTRACT[type] ? ' (attract)' : ''}`, type, meshes, skeleton,
            draw: OTHER_TYPES.has(type) ? DRAW_OTHER : DRAW_PEOPLE,
            scale: v.getFloat32(0x9db10 + 4 * type, true),
            joints: JOINTS, roles: [], skin: -1, hitMotions: [], start: -1, root: TYPES + 8 * type, parts,
            /* The stage film's sheets (bank 7), where MAME's attract shows them. */
            playerSet: 6,
        });
    }
    return out;
}

/** Every motion plays on every type (one table, 17 triples); the attract's
 * own for a type lead. */
export function gunbladeMotionList(rom, body, motions) {
    const fits = motions.filter(Boolean);
    const seen = new Set(ATTRACT[body.type] ?? []);
    const lead = fits.filter((m) => seen.has(m.index));
    return lead.length
        ? { fits, lead, label: 'The motions the attract plays on this type' }
        : { fits, lead: fits, label: 'Every motion in the table' };
}

/* Board matrix to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/** A figure at a whole frame of a motion (1 the first); `start` as
 * gunbladeValues. No motion: every value 0 (the bind pose). Without
 * travel the root stays over the origin. */
export function poseGunblade(rom, body, motion, frame, { start = 'loop', speed = 1, travel = true } = {}) {
    const values = motion
        ? gunbladeValues(motion, Math.max(1, Math.min(frame, motion.frames)) - 1, { start, speed })
        : new Array(JOINTS * 3).fill(0);
    /* On the spot: the root's place over the ground (triple 16) left out. */
    if (!travel) { values[48] = 0; values[50] = 0; }
    const run = draw(rom, body.type, values);
    const three = run.parts.map((p) => toThree(p.m));
    return {
        matrices: three,
        origins: three.map((e) => [e[12], e[13], e[14]]),
        draws: run.draws,
        parents: run.parts.map((p) => p.parent),
    };
}

/* For the checks: the board matrices for given values (test/MAME). */
export function gunbladeBoardMatrices(rom, type, values) {
    return draw(rom, type, values);
}
