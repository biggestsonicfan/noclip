/*
 * topskatrplayers.js — Top Skater's skaters (MAME's `topskatr`), the game's
 * own animator, skeleton and draw run on the i960 (js/doa.js's machine).
 *
 * The motions: 718 pointers at 0xC0038 (index 0 is null) into the data ROM
 * (0x28xxxxx..0x2Bxxxxx). The game finds one through 0x5019DC, as
 * `table[(id >> 10) & 15][id & 0x3FF]`; only bank 0 is used. A motion
 * starts with three halfwords, the first and last frame and a heading
 * (0x10000 a turn), then 15 group masks (bytes 6..0x14) and the key
 * streams from byte 22. 0x339D0 (motion, state) loads it into a state of
 * 0x1FE0 bytes (+0x1D80 first frame, +0x1D84 last, +0x1D88 heading, +0x1D8C
 * the length in seconds); 0x343D0 (state, t seconds, pose) brings every
 * channel to t and writes the pose. A key is a time halfword (the frame
 * through 0x57E490, its low bits the type: hold, linear, Hermite through
 * copro command 71) and a value halfword (an exponent through 0x582490 and
 * 11 bits of mantissa); 0x34550 builds both tables, and 0x500A40 holds the
 * type map {1, 2, 3, 0}. The game's motion viewer, 0x6C1E0, runs exactly
 * this: 0x339D0, 0x343D0, then the skeleton.
 *
 * The skeleton: 0x52DD0 (pose, skeleton, out) turns the pose into a
 * quaternion and a place a bone at out (0x5CA900 + 572 n). Each limb is
 * IK (the pose's mode bits 2: an aim at the end point, copro 72, and the
 * bend from the bone lengths, 73) or FK (1: Euler turns, 58, then the
 * hinge, 49). The skeleton is the bone lengths and offsets, 0xA0 bytes:
 * `0x6D570[k] = {part list in RAM, skeleton}`, 0x99E80 + 0xA0 k for skater
 * k + 1. 0x537B0 (out, skeleton, 12 * slot) makes the 19 slot matrices at
 * 0x58C540 + 48 n, skater-local: the board, the hips, the legs, the chest,
 * the head and the arms.
 *
 * The draw 0x565D0 (_, part list) draws 18 parts from the slots, the
 * board's from slot 0 (scaled by 0x5CE8B8, 1.0) and the rest from slot 2
 * on; the shins and forearms (j02) turn a quarter about Z and move back a
 * bone length first. The lists are in the program ROM at 0xC8AB8 + 0x50 k
 * (skater k + 1; the boot copies them to 0x509920 + 0x50 k), 18 model
 * records of 16 bytes (a copy of the model table's words; 0xC8A68 repeats
 * skater 5 and 0xC8D38 is the shadow, skater_kage). +0x48 is a record the
 * draw passes to 0x6F4C0.
 *
 * The board draw (0x545C0) turns the board's up axis into the camera's
 * frame and, if it points away by more than 0.2, draws the skater's
 * underside (RAM 0x500DF0[k], from ROM 0xBFF88) instead of the list's top.
 * Some parts' points go by the geometrizer's second matrix (skinning): the
 * chest's waist ring is drawn in the hips' frame turned half about Z, and
 * skaters 2, 3 and 6's ankle rings on their shins in the foot's frame,
 * moved back the shin length the skeleton at 0x5D52B4 gives. The viewer
 * lays those parts out again each frame.
 *
 * Checked against MAME's RAM at attract frame 3000 (skater 2): the
 * skeleton's out within 4e-6, the 19 slot matrices within 0.0033 (all but
 * the right arm's within 5e-6), the draw's 279 copro results within 7e-5
 * of the board's, and the same 18 models; the animator gives the states of
 * motions 553 and 189 in MAME's RAM exactly. Every motion's first and last
 * frame on all eight skaters draws with no unknown copro command, and every
 * bent point lands on a point of the part it joins (skater 8's waist ring
 * has one point 0.058 off the hips' ring in the models themselves). The
 * attract also runs a
 * spring on some channels after the animator (0x6F8C0), which the viewer
 * and this module leave out.
 */

import { doaMachine } from './doa.js';
import { topskatrMesh } from './topskatr.js';

const RAM = 0x500000;
const MOTIONS = 0xc0038;
const MOTION_COUNT = 719;
const TABLES = 0x34550;
const KEY_TYPES = 0x500a40;
const BOARD_SCALE = 0x5ce8b8;
const SKELETON_AT = 0x5d52b4;
/* The boards' undersides, one model record a skater: the boot copies the
 * eight words at 0xBFF88 to 0x500DF0 with the rest of the data section
 * (the part lists at 0xC8AB8 go to 0x509920 the same way). */
const UNDERSIDES = 0xbff88;
const UNDERSIDES_AT = 0x500df0;
/* The board draw's test (0x545C0): the board's up axis, turned into the
 * camera's frame, deeper than this draws the underside. */
const UNDERSIDE_OVER = 0.2;
const LOAD = 0x339d0;
const ANIMATE = 0x343d0;
const SKELETON = 0x52dd0;
const SLOTS = 0x537b0;
const DRAW = 0x565d0;
const STATE = 0x5b4a40;
const STATE_BYTES = 0x1fe0;
const POSE = 0x5be9a0;
const OUT = 0x5ca900;
const SKATERS = 0x6d570;
const PART_LISTS = 0xc8ab8;
const LIST_BYTES = 0x50;
const PARTS = 18;
const MODEL_TABLE = 0x8f390;
const MODEL_COUNT = 1901;
const NAMES = 0x72c70;
const NAME_BYTES = 23;

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ANGLE = (2 * Math.PI) / 65536;

/* ---- the matrices: columns X, Y, Z, then the place, as js/doa.js. ---- */

function mulRot(m, r) {
    const o = m.slice();
    for (let c = 0; c < 3; c++) {
        for (let k = 0; k < 3; k++) o[c * 3 + k] = m[k] * r[c * 3] + m[3 + k] * r[c * 3 + 1] + m[6 + k] * r[c * 3 + 2];
    }
    return o;
}

function apply(m, [x, y, z]) {
    return [0, 1, 2].map((k) => m[k] * x + m[3 + k] * y + m[6 + k] * z + m[9 + k]);
}

function rot(axis, a) {
    const c = Math.cos(a), s = Math.sin(a);
    if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
    if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
    return [c, -s, 0, s, c, 0, 0, 0, 1];
}

const turn3 = (a, b) => mulRot([...a, 0, 0, 0], b).slice(0, 9);
const transpose = (r) => [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];

/* A quaternion (x, y, z, w), as the copro takes and gives them. */
function quatRot([x, y, z, w]) {
    return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
        2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
        2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

function rotQuat(r) {
    const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r;
    const t = m00 + m11 + m22;
    if (t > 0) {
        const s = Math.sqrt(t + 1) * 2;
        return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    }
    if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    }
    if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

const clamp = (v) => Math.max(-1, Math.min(1, v));

/*
 * Top Skater's copro program (its own; the numbers clash with js/doa.js's
 * table). Every turn also goes into a running turn (`acc`) that 65 clears,
 * 66 reads back as a quaternion and 56 takes back off the matrix. Each was
 * replayed against MAME's copro reads (0x52DD0's 345 results within 2e-4);
 * 49 is the FK hinge, read as a turn about Z like the IK bend (52 with 73's
 * cosine and sine), not seen in MAME's frame.
 */
function turn(cp, r) {
    cp.m = mulRot(cp.m, r);
    cp.acc = turn3(cp.acc ?? I3, r);
}
const euler = ([x, y, z]) => turn3(turn3(rot('z', z), rot('y', y)), rot('x', x));
const intAngle = (w) => ((w << 16) >> 16) * ANGLE;
/* 72's turn: the bone's X onto the direction u (local), Z then Y. */
const aim = (u) => turn3(rot('z', Math.atan2(-u[1], u[0])), rot('y', Math.asin(clamp(u[2]))));
function hermite([t0, t1, t, v0, v1, s0, s1]) {
    const d = t1 - t0, u = d ? (t - t0) / d : 0, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * v0 + (3 * u2 - 2 * u3) * v1 + (u3 - 2 * u2 + u) * s0 * d + (u3 - u2) * s1 * d;
}
/* Commands whose word is a 16-bit angle (0x10000 a turn), not a single. */
const INT_ANGLES = new Set([44, 45, 46]);

const COPRO = {
    0: [0, () => {}],
    9: [0, (cp) => { cp.m = IDENTITY; }],
    10: [0, (cp) => cp.stack.push(cp.m)],
    11: [0, (cp) => { cp.m = cp.stack.pop() ?? IDENTITY; }],
    12: [12, (cp, a) => { cp.m = [...mulRot(cp.m, a).slice(0, 9), ...apply(cp.m, a.slice(9))]; }],
    13: [12, (cp, a) => { cp.m = a.slice(); }],
    14: [0, (cp) => cp.out(cp.m)],
    36: [3, (cp, a) => cp.out(apply(cp.m, a))],
    37: [0, (cp) => cp.out(cp.m.slice(9))],
    39: [3, (cp, a) => {
        const m = cp.m, d = [0, 1, 2].map((k) => a[k] - m[9 + k]);
        cp.out([0, 1, 2].map((c) => m[c * 3] * d[0] + m[c * 3 + 1] * d[1] + m[c * 3 + 2] * d[2]));
    }],
    41: [1, (cp, a) => { cp.m = [...cp.m.slice(0, 9).map((v) => v * a[0]), ...cp.m.slice(9)]; }],
    42: [3, (cp, a) => { cp.m = [...cp.m.slice(0, 9), ...apply(cp.m, a)]; }],
    43: [1, (cp, a) => { cp.m = [...cp.m.slice(0, 9), ...apply(cp.m, [a[0], 0, 0])]; }],
    44: [1, (cp, a) => turn(cp, rot('x', intAngle(a[0])))],
    45: [1, (cp, a) => turn(cp, rot('y', intAngle(a[0])))],
    46: [1, (cp, a) => turn(cp, rot('z', intAngle(a[0])))],
    47: [1, (cp, a) => turn(cp, rot('x', a[0]))],
    48: [1, (cp, a) => turn(cp, rot('y', a[0]))],
    49: [1, (cp, a) => turn(cp, rot('z', a[0]))],
    52: [2, (cp, a) => turn(cp, [a[0], -a[1], 0, a[1], a[0], 0, 0, 0, 1])],
    56: [0, (cp) => { cp.m = [...mulRot(cp.m, transpose(cp.acc ?? I3)).slice(0, 9), ...cp.m.slice(9)]; }],
    58: [3, (cp, a) => turn(cp, euler(a))],
    /* The turn back to none, the place kept: before a limb's Euler turns
     * when its mode bits are 1 (0x519C0, 0x5290C), as 60 sets the turn from
     * a matrix when they are 2. Read from the code, not seen in MAME. */
    59: [0, (cp) => { cp.m = [...I3, ...cp.m.slice(9)]; }],
    60: [9, (cp, a) => { cp.m = [...a, ...cp.m.slice(9)]; }],
    65: [0, (cp) => { cp.acc = I3; }],
    66: [0, (cp) => cp.out(rotQuat(cp.acc ?? I3))],
    67: [4, (cp, a) => turn(cp, quatRot(a))],
    68: [4, (cp, a) => { cp.m = [...quatRot(a), ...cp.m.slice(9)]; }],
    71: [7, (cp, a) => cp.out([hermite(a)])],
    /* The distance to a point, then the turn that aims X at it. */
    72: [3, (cp, a) => {
        const m = cp.m, w = [0, 1, 2].map((k) => a[k] - m[9 + k]), n = Math.hypot(...w);
        cp.out([n]);
        const u = [0, 1, 2].map((c) => (m[c * 3] * w[0] + m[c * 3 + 1] * w[1] + m[c * 3 + 2] * w[2]) / (n || 1));
        turn(cp, aim(u));
    }],
    /* Two bones b and c reaching d: the bend's cosine and sine, then the
     * first bone's turn off the line. */
    73: [3, (cp, [d, b, c]) => {
        const k = clamp((b * b + c * c - d * d) / (2 * b * c));
        cp.out([-k, Math.sqrt(1 - k * k)]);
        turn(cp, rot('z', -Math.acos(clamp((d * d + b * b - c * c) / (2 * d * b)))));
    }],
};

const floatBits = (x) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, x, true);
    return b.getUint32(0, true);
};

/* The model table index of a drawn record: its polygon word, then its
 * texture word among models that share the polygons. */
const modelIndices = new WeakMap();
function modelIndex(rom) {
    if (!modelIndices.has(rom)) {
        const pv = new DataView(rom.maincpu.buffer, rom.maincpu.byteOffset);
        const map = new Map();
        for (let i = 0; i < MODEL_COUNT; i++) {
            const at = MODEL_TABLE + 16 * i, key = pv.getUint32(at + 8, true);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push([pv.getUint32(at, true), i]);
        }
        modelIndices.set(rom, map);
    }
    return modelIndices.get(rom);
}

const machines = new WeakMap();
function machine(rom) {
    if (machines.has(rom)) return machines.get(rom);
    const M = doaMachine(rom);
    M.copro.table = { ...COPRO };
    /* The 16-bit angles go in as they are (js/doa.js would read them as
     * singles); the draw's object command is 0x11 at 0x800110. */
    const data = M.copro.data.bind(M.copro);
    M.copro.data = function (w) {
        if (this.pending !== null && INT_ANGLES.has(this.pending)) {
            this.args.push(w | 0);
            this.maybeRun();
        } else data(w);
    };
    /* Top Skater's geometrizer program has a second matrix (m2-hle2's
     * geo_vertex_matrix, after m2emulator's "tops" table): 0x1B writes it,
     * 0x1C copies the matrix into it and reads nothing, and a point whose x
     * word has bit 0 set is drawn by it. It outlives the object. The draw
     * object is 0x11, whose polygons carry no normals (js/topskatr.js). */
    const command = M.geo.command.bind(M.geo);
    M.geo.command = (c) => command(c === 0x11 ? 0x01 : c);
    const maybeRun = M.geo.maybeRun.bind(M.geo);
    M.geo.maybeRun = function () {
        if (this.pending === 0x1c) {
            this.pending = null;
            this.m2 = this.m.slice();
        } else if (this.pending === 0x1b) {
            if (this.words.length < 12) return;
            this.pending = null;
            this.m2 = this.words.map((w) => new Float32Array(new Uint32Array([w]).buffer)[0]);
        } else maybeRun();
    };
    M.geo.m2 = IDENTITY;
    M.drawn = [];
    M.geo.object = () => M.drawn.push({ words: M.geo.words.slice(), m: M.geo.m.slice(), m2: M.geo.m2.slice() });
    if (!M.cpu.call(TABLES, [], { maxSteps: 5_000_000 })) throw new Error('0x34550 did not return');
    [1, 2, 3, 0].forEach((v, i) => M.rv.setUint32(KEY_TYPES - RAM + 4 * i, v, true));
    M.rv.setFloat32(BOARD_SCALE - RAM, 1, true);
    for (let k = 0; k < 8; k++) M.rv.setUint32(UNDERSIDES_AT - RAM + 4 * k, rom.mainCpuView.getUint32(UNDERSIDES + 4 * k, true), true);
    machines.set(rom, M);
    return M;
}

function resetCopro(M) {
    M.copro.stack = [];
    M.copro.m = IDENTITY;
    M.copro.acc = I3;
    M.copro.pending = null;
    M.copro.outQ = [];
}

/* The parts in the lists' order, by their models' names (skater1_mdl_koshi
 * and so on), and the part each hangs from, measured: the part whose frame
 * holds a part's origin still through eight motions (the hips and chest
 * share theirs; the board is a part of its own). */
const PART_NAMES = ['board', 'hips', 'thigh L', 'shin L', 'foot L', 'thigh R', 'shin R', 'foot R', 'chest',
    'head', 'upper arm L', 'forearm L', 'hand L', 'fingers L', 'upper arm R', 'forearm R', 'hand R', 'fingers R'];
const PARENTS = [-1, -1, 1, 2, 3, 1, 5, 6, 1, 8, 8, 10, 11, 12, 8, 14, 15, 16];

/* Pose a skater at t seconds of a motion and draw it: the matrices each
 * part is drawn with (skater-local) and its model. */
function run(rom, body, motion, t) {
    const M = machine(rom);
    const step = (addr, args, what) => {
        if (!M.cpu.call(addr, args, { maxSteps: 5_000_000 })) throw new Error(`${what} did not return`);
    };
    M.geo.m2 = IDENTITY;
    /* The skater's skeleton, as the game's pick (0x6D5B0) leaves it: the
     * draw moves the ankles' second matrix back a shin's length from it. */
    M.rv.setUint32(SKELETON_AT - RAM, body.skeleton, true);
    M.ram.fill(0, STATE - RAM, STATE - RAM + STATE_BYTES);
    M.ram.fill(0, POSE - RAM, POSE - RAM + STATE_BYTES);
    if (motion) {
        step(LOAD, [motion.address, STATE], '0x339D0');
        step(ANIMATE, [STATE, floatBits(t), POSE], '0x343D0');
    }
    resetCopro(M);
    step(SKELETON, [POSE, body.skeleton, OUT], '0x52DD0');
    resetCopro(M);
    step(SLOTS, [OUT, body.skeleton, 0], '0x537B0');
    resetCopro(M);
    M.drawn = [];
    step(DRAW, [0, body.list], '0x565D0');
    const index = modelIndex(rom);
    return M.drawn.flatMap(({ words, m, m2 }) => {
        const c = index.get(words[2]) ?? [];
        const hit = c.find((e) => e[0] === words[0]) ?? c[0];
        return hit ? [{ model: hit[1], m, m2 }] : [];
    });
}

/* The inverse of a rigid 3x4 (a turn and a place). */
function invert(m) {
    const r = transpose(m.slice(0, 9));
    return [...r, ...apply([...r, 0, 0, 0], m.slice(9)).map((v) => -v)];
}

/*
 * A part whose points pick the second matrix, laid out again in the part's
 * own frame: each such point through the second matrix, then back through
 * the inverse of the part's. Null when no point picks it, or the two
 * matrices are the same. The chests' waists are drawn by the hips' matrix
 * (turned half about Z), and some skaters' shins' ankles by the foot's.
 */
function bentMesh(rom, model, m, m2) {
    if (m.every((v, k) => Math.abs(v - m2[k]) < 1e-6)) return null;
    const mesh = topskatrMesh(rom, model);
    if (!mesh) return null;
    const bytes = mesh.bytes.slice();
    const dv = new DataView(bytes.buffer);
    const to = mulMat(invert(m), m2);
    let bent = 0;
    for (let r = 0; r + 40 <= bytes.length; r += 40) {
        for (const o of [r, r + 12]) {
            if (!(dv.getUint32(o, true) & 1)) continue;
            const q = apply(to, [0, 4, 8].map((k) => dv.getFloat32(o + k, true)));
            q.forEach((v, k) => dv.setFloat32(o + 4 * k, v, true));
            bent++;
        }
    }
    return bent ? { ...mesh, bytes } : null;
}

/* a * b, both 3x4. */
function mulMat(a, b) {
    return [...mulRot(a, b).slice(0, 9), ...apply(a, b.slice(9))];
}

/* The model a part list record names: the record is a copy of its model
 * table entry. */
function partModel(rom, record) {
    const pv = new DataView(rom.maincpu.buffer, rom.maincpu.byteOffset);
    const c = modelIndex(rom).get(pv.getUint32(record + 8, true)) ?? [];
    const hit = c.find((e) => e[0] === pv.getUint32(record, true)) ?? c[0];
    return hit ? hit[1] : -1;
}

/* A skater's board underside (s1_ita_ura...; skaters 7 and 8 name their one
 * board again). */
function underside(rom, body) {
    return partModel(rom, rom.mainCpuView.getUint32(UNDERSIDES + 4 * body.index, true));
}

function modelName(rom, i) {
    const b = rom.maincpu.subarray(NAMES + NAME_BYTES * i, NAMES + NAME_BYTES * (i + 1));
    return String.fromCharCode(...b).replace(/\0.*$/s, '').trim();
}

/** The eight skaters: the game's skater table, the part list and skeleton. */
export function readTopskatrBodies(rom) {
    const pv = new DataView(rom.maincpu.buffer, rom.maincpu.byteOffset);
    const out = [];
    for (let k = 0; k < 8; k++) {
        const list = PART_LISTS + LIST_BYTES * k;
        const skeleton = pv.getUint32(SKATERS + 8 * k + 4, true);
        const parts = PART_NAMES.map((name, i) => {
            let depth = 0;
            for (let p = PARENTS[i]; p >= 0; p = PARENTS[p]) depth++;
            return { index: i, name, parent: PARENTS[i], depth, joint: i, flags: 0, offset: [0, 0, 0], record: pv.getUint32(list + 4 * i, true), model: null };
        });
        out.push({
            index: k, name: `Skater ${k + 1}`, list, skeleton, joints: PARTS, scale: 1, roles: [], skin: -1,
            hitMotions: [], start: -1, root: list, parts,
            /* The attract's sheets (bank 1, colours 0). */
            playerSet: rom.game.texture.defaultSet,
        });
    }
    return out;
}

/** The 718 motions: the first and last frame and the heading from each
 * header. A frame is 1/60 s. */
export function readTopskatrMotions(rom) {
    const pv = new DataView(rom.maincpu.buffer, rom.maincpu.byteOffset);
    const dv = rom.mainDataView ?? new DataView(rom.mainData.buffer, rom.mainData.byteOffset, rom.mainData.byteLength);
    const list = [];
    for (let i = 1; i < MOTION_COUNT; i++) {
        const address = pv.getUint32(MOTIONS + 4 * i, true);
        const offset = address - 0x2000000;
        if (!address || offset < 0 || offset + 22 > dv.byteLength) continue;
        const first = dv.getUint16(offset, true), last = dv.getUint16(offset + 2, true);
        if (last < first) continue;
        list[i] = {
            index: i, name: `motion ${i}`, address, offset, first, last, frames: last - first + 1, keys: last - first + 1,
            heading: dv.getUint16(offset + 4, true), joints: PARTS,
        };
    }
    return list;
}

/** Every motion plays on every skater: one format, one table. */
export function topskatrMotionList(rom, body, motions) {
    const fits = motions.filter(Boolean);
    return { fits, lead: fits, label: 'Every motion in the table' };
}

/* Board matrix to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/** A skater at a whole frame of a motion (1 the first); without a motion,
 * the skeleton at rest. */
export function poseTopskatr(rom, body, motion, frame) {
    const f = motion ? Math.max(1, Math.min(frame, motion.frames)) - 1 : 0;
    /* The board comes first (0x545C0); the rest are matched to the parts by
     * model. */
    const left = run(rom, body, motion, f / 60);
    const board = left.shift();
    const drawn = body.parts.map((p, i) => {
        if (i === 0) return board ?? null;
        const at = left.findIndex((d) => d.model === partModel(rom, p.record));
        return at < 0 ? null : left.splice(at, 1)[0];
    });
    const three = drawn.map((d) => toThree(d?.m ?? IDENTITY));
    /* The parts with points on the second matrix are rebuilt each frame. */
    const bent = drawn.map((d, i) => i > 0 && d && bentMesh(rom, d.model, d.m, d.m2));
    /* The board's top and its underside: the game draws one or the other by
     * which way the board faces the camera, so the viewer picks (viewSides). */
    const sides = [...new Set([partModel(rom, body.parts[0].record), underside(rom, body)])].filter((x) => x >= 0);
    return {
        matrices: three,
        origins: three.map((e) => [e[12], e[13], e[14]]),
        draws: drawn.map((d, i) => (i === 0 ? (d ? sides : []) : d && !bent[i] ? [d.model] : [])),
        skins: bent.flatMap((mesh, i) => (mesh ? [{ ...mesh, matrix: three[i] }] : [])),
        viewSides: sides.length > 1 ? [{ part: 0, axis: [0, 1, 0], over: UNDERSIDE_OVER }] : [],
        parents: body.parts.map((p) => p.parent),
    };
}

export { modelName as topskatrModelName };

/** Copro commands the machine met and doesn't know (empty when all is well). */
export function topskatrUnknown(rom) {
    return machines.has(rom) ? [...machines.get(rom).unknown] : [];
}
