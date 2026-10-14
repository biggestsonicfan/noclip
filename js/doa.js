/*
 * doa.js — Dead or Alive's stages, read by running the game's own draw code.
 *
 * Each stage is drawn by a routine of its own, which the table at 0x719E0
 * names by stage (the program at 0x719E0 + stage * 4 on Revision B). They place
 * their pieces with coprocessor commands rather than out of a table — a
 * command is a store to 0x88NNN0, NNN the command, and its words go to the
 * port at 0x884000 — and hand each piece to the geometrizer the same way
 * (0x8000N0 and the port at 0x804000). So the explorer runs each routine on
 * js/i960.js, against a bus whose coprocessor keeps the matrix stack the
 * commands describe and whose geometrizer records what it is told to draw.
 *
 * The coprocessor commands the stage code sends (the board's copro program is
 * the game's own, uploaded at boot; these are what the routines do with them):
 *
 *   0x05  push              0x06  pop
 *   0x12  translate x y z   0x57  push, then translate
 *   0x13  scale x y z       0x14 / 0x15 / 0x16  turn about X / Y / Z, an
 *                                  integer angle, 0x10000 to the turn
 *   0x11  the matrix out (12 words, for geometrizer command 0x0B)
 *   0x20  the translation out (3 words, for 0x0C, which keeps the rotation the
 *         last 0x0B gave: the camera's, so the piece stands square to the world)
 *   0x0C  a point through the matrix (culling)
 *   0x0A  the turn toward a point (dz, dx in; billboards)
 *
 * A data word sent with no command waiting is itself a command header: the
 * routines chain 0x57 into 0x15 by writing 0x0A801515 after the translation.
 *
 * The camera is the matrix the coprocessor holds when the routine starts. Here
 * it holds none, so what the geometrizer is handed is each piece's place in
 * the world. The routines cull against the camera (0x555598) and the view
 * vector (0x5B9870); the culling helpers are answered "visible" so a stage
 * comes out whole.
 */

import { I960, bitsToFloat, floatToBits } from './i960.js';
import { gameLighting } from './stages.js';
import { buildDoaSky } from './scroll.js';

const RAM_BASE = 0x500000;
const RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000;
/* The upper half of the data ROMs again, as 0x6000000 (the motion tables). */
const XTRA_BASE = 0x6000000, XTRA_FROM = 0x1000000;
const COPRO_CMD = 0x880000, COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const GEO_CMD = 0x800000, GEO_PORT = 0x804000, GEO_END = 0x808000;
const VIEW_VECTOR = 0x5b9870;
const ANGLE_RAD = (2 * Math.PI) / 0x10000;

/* The geometrizer's commands, by the words each takes after its header. A
 * function is a count that depends on the words already in. */
const GEO_WORDS = {
    0x00: 0, 0x01: 4, 0x03: 6, 0x07: 1, 0x08: 1, 0x09: 2, 0x0a: 3,
    0x0b: 12, 0x0c: 3, 0x0d: 2, 0x0f: 0, 0x10: 1, 0x16: 1,
    0x04: (w) => (w.length < 2 ? 2 : 2 + w[1]),
    0x05: (w) => (w.length < 2 ? 2 : 2 + w[1]),
    0x06: (w) => (w.length < 2 ? 2 : 2 + 2 * w[1]),
    0x14: (w) => (w.length < 2 ? 2 : 2 + w[1]),
};

/* ---- 3x4 matrices: columns X, Y, Z, then the translation, as the board's
 * geometrizer reads them (m[0..2] is where X goes). ---- */

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function mulRot(m, r) {
    /* m * r, r a 3x3 in the same column order. */
    const out = m.slice();
    for (let c = 0; c < 3; c++) {
        for (let row = 0; row < 3; row++) {
            out[c * 3 + row] = m[row] * r[c * 3] + m[3 + row] * r[c * 3 + 1] + m[6 + row] * r[c * 3 + 2];
        }
    }
    return out;
}

/* m * a, both 3x4: a's frame placed in m's. */
function compose(m, a) {
    return [...mulRot(m, a).slice(0, 9), ...apply(m, a.slice(9))];
}

function apply(m, [x, y, z]) {
    return [0, 1, 2].map((k) => m[k] * x + m[3 + k] * y + m[6 + k] * z + m[9 + k]);
}

function rotation(axis, a) {
    const c = Math.cos(a * ANGLE_RAD), s = Math.sin(a * ANGLE_RAD);
    if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
    if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
    return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/* What each command takes in, and does; `out` pushes its answers. */
const COPRO = {
    0x05: [0, (cp) => cp.stack.push(cp.m)],
    0x06: [0, (cp) => { cp.m = cp.stack.pop() ?? IDENTITY; }],
    0x12: [3, (cp, a) => cp.translate(a)],
    0x57: [3, (cp, a) => { cp.stack.push(cp.m); cp.translate(a); }],
    0x13: [3, (cp, a) => { cp.m = mulRot(cp.m, [a[0], 0, 0, 0, a[1], 0, 0, 0, a[2]]); }],
    0x14: [1, (cp, a) => cp.turn('x', a[0])],
    0x15: [1, (cp, a) => cp.turn('y', a[0])],
    0x16: [1, (cp, a) => cp.turn('z', a[0])],
    0x11: [0, (cp) => { cp.out(cp.m); cp.lastOut = { m: cp.m }; }],
    0x20: [0, (cp) => { cp.out(cp.m.slice(9)); cp.lastOut = { t: cp.m.slice(9) }; }],
    /* Only the culls send it, and they keep what is in front of the camera:
     * a point ahead along every axis, against the view vector `cullAll` sets. */
    0x0c: [3, (cp) => cp.out([1, 1, 1])],
    0x0a: [2, (cp, a) => cp.outInt(Math.round(Math.atan2(a[1], a[0]) / ANGLE_RAD))],
    0x1b: [1, (cp, a) => cp.out([Math.sin(((a[0] << 16) >> 16) * ANGLE_RAD)])],
    0x1c: [1, (cp, a) => cp.out([Math.cos(((a[0] << 16) >> 16) * ANGLE_RAD)])],
    0x07: [12, (cp, a) => { cp.m = a.slice(); }],
    0x09: [12, (cp, a) => { cp.m = compose(cp.m, a); }],
    0x10: [0, (cp) => { cp.m = IDENTITY; }],
    0x19: [0, (cp) => cp.outInt(0)],
    0x1a: [3, (cp, a) => cp.out(apply(cp.m, a))],
    0x1f: [6, (cp, a) => cp.out([Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2])])],
    0x0f: [6, (cp, a) => {
        const dx = a[3] - a[0], dy = a[4] - a[1], dz = a[5] - a[2];
        cp.outInt(Math.round(Math.atan2(dx, dz) / ANGLE_RAD) & 0xffff);
        cp.outInt(Math.round(Math.atan2(-dy, Math.hypot(dx, dz)) / ANGLE_RAD) & 0xffff);
    }],
};
/* Commands whose words are integers rather than singles. */
const INT_ARGS = new Set([0x14, 0x15, 0x16, 0x1b, 0x1c]);

class Copro {
    constructor(log) {
        this.m = IDENTITY;
        this.stack = [];
        this.pending = null;
        this.args = [];
        this.outQ = [];
        this.lastOut = null;
        this.log = log;
    }

    translate([x, y, z]) {
        const t = apply(this.m, [x, y, z]);
        this.m = [...this.m.slice(0, 9), ...t];
    }

    turn(axis, a) { this.m = mulRot(this.m, rotation(axis, (a << 16) >> 16)); }

    out(vals) { for (const v of vals) this.outQ.push(floatToBits(v)); }

    outInt(v) { this.outQ.push(v >>> 0); }

    command(cmd) {
        this.pending = cmd;
        this.args = [];
        this.maybeRun();
    }

    data(w) {
        if (this.pending === null) { this.command(w & 0xff); return; }
        this.args.push(INT_ARGS.has(this.pending) ? w | 0 : bitsToFloat(w));
        this.maybeRun();
    }

    maybeRun() {
        const spec = COPRO[this.pending];
        if (!spec) {
            this.log.add(`copro 0x${this.pending.toString(16)}`);
            this.pending = null;
            return;
        }
        if (this.args.length < spec[0]) return;
        const cmd = this.pending;
        this.pending = null;
        COPRO[cmd][1](this, this.args);
    }

    read() { return this.outQ.length ? this.outQ.shift() : 0; }
}

/* The geometrizer's side: a draw for every object command, under the matrix
 * the last 0x0B or 0x0C left. */
class Geo {
    constructor(copro, models) {
        this.copro = copro;
        this.models = models;
        this.m = IDENTITY;
        this.pending = null;
        this.words = [];
        this.draws = [];
    }

    command(cmd) {
        this.pending = cmd;
        this.words = [];
        this.maybeRun();
    }

    data(w) {
        if (this.pending === null) { this.command((w >>> 23) & 0x1f); return; }
        this.words.push(w >>> 0);
        this.maybeRun();
    }

    maybeRun() {
        const n = GEO_WORDS[this.pending];
        const need = typeof n === 'function' ? n(this.words) : n ?? 0;
        if (this.words.length < need) return;
        const cmd = this.pending;
        this.pending = null;
        if (cmd === 0x0b) this.m = this.copro.lastOut?.m ?? this.words.map(bitsToFloat);
        else if (cmd === 0x0c) this.m = [...this.m.slice(0, 9), ...this.words.map(bitsToFloat)];
        else if (cmd === 0x01) this.object();
    }

    object() {
        const model = this.models.lastIndex(this.words);
        if (model !== null) this.draws.push({ model, m: this.m.slice() });
    }
}

/* The bus: program ROM at 0, the data ROMs at 0x2000000, work RAM, and the
 * two ports. Anything else reads back what was last written to it. */
function makeBus(rom, ram, copro, geo, models) {
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const rv = new DataView(ram.buffer);
    const other = new Map();
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) return cv.getUint32(a, true);
        if (inRam(a)) return rv.getUint32(a - RAM_BASE, true);
        if (a >= DATA_BASE && a - DATA_BASE < dv.byteLength - 3) {
            models.noteRead(a - DATA_BASE);
            return dv.getUint32(a - DATA_BASE, true);
        }
        if (a >= XTRA_BASE && a < XTRA_BASE + XTRA_FROM) {
            /* The board's data region is 0x2000000 long; the last 4 MB
             * repeat the 4 MB before them. */
            let off = a - XTRA_BASE + XTRA_FROM;
            if (off >= dv.byteLength) off -= 0x400000;
            if (off < dv.byteLength - 3) return dv.getUint32(off, true);
        }
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
    return {
        read32,
        write32,
        read8: (a) => { const [w, s] = lane(a, 1); return (read32(w) >>> s) & 0xff; },
        read16: (a) => { const [w, s] = lane(a, 2); return (read32(w) >>> s) & 0xffff; },
        write8: (a, v) => {
            if (inRam(a)) { ram[a - RAM_BASE] = v; return; }
            const [w, s, mask] = lane(a, 1);
            write32(w, (read32(w) & ~(mask << s)) | (v << s));
        },
        write16: (a, v) => {
            if (inRam(a)) { rv.setUint16(a - RAM_BASE, v, true); return; }
            const [w, s, mask] = lane(a, 2);
            write32(w, (read32(w) & ~(mask << s)) | (v << s));
        },
    };
}

/* Which model an object command names: the model table entry its four words
 * were last read from (the routines `ldq` the entry and `stq` it on). */
function modelTracker(table) {
    let last = null;
    return {
        noteRead(off) {
            const i = Math.floor((off - table.offset) / table.stride);
            if (off >= table.offset && i < table.count) last = i;
        },
        lastIndex() {
            const i = last;
            last = null;
            return i;
        },
    };
}

/* ---- a board matrix as explorer ops ---- */

/* The explorer reads Z negated, so a board matrix M is S M S there. A pure
 * turn about Y comes out as one 'r'; anything else as the whole matrix. */
export function boardToOps(m) {
    const t = [m[9], m[10], -m[11]];
    /* S R S: negate the entries that mix Z with X or Y. */
    const r = [m[0], m[1], -m[2], m[3], m[4], -m[5], -m[6], -m[7], m[8]];
    const eps = 1e-5;
    const flatY = Math.abs(r[1]) < eps && Math.abs(r[3]) < eps && Math.abs(r[5]) < eps
        && Math.abs(r[7]) < eps && Math.abs(r[4] - 1) < eps
        && Math.abs(r[0] - r[8]) < eps && Math.abs(r[2] + r[6]) < eps
        && Math.abs(Math.hypot(r[0], r[2]) - 1) < eps;
    if (!flatY) return [['t', t], ['m', r]];
    /* Columns: X goes to (r0, r1, r2); a three.js Y turn by a sends X to
     * (cos a, 0, -sin a). */
    const deg = (Math.atan2(-r[2], r[0]) * 180) / Math.PI;
    return Math.abs(deg) < 1e-3 ? [['t', t]] : [['t', t], ['r', deg]];
}

/**
 * Run one stage's draw routine and return what it drew, in the board's frame.
 *
 * @param {object} rom
 * @param {number} entry  the routine
 * @param {object} [opts] ram: bytes to poke first, as [[addr, u8], ...]
 * @returns {{draws: {model:number, m:number[]}[], unknown: string[], done: boolean}}
 */
export function doaMachine(rom) {
    const ram = new Uint8Array(RAM_SIZE);
    const unknown = new Set();
    const copro = new Copro(unknown);
    const models = modelTracker({ ...rom.game.modelTable, offset: rom.game.modelTable.offset });
    const geo = new Geo(copro, models);
    const cpu = new I960(makeBus(rom, ram, copro, geo, models));
    return { ram, rv: new DataView(ram.buffer), unknown, copro, geo, cpu };
}

export function runStageRoutine(rom, entry, { ram: pokes = [], maxSteps } = {}) {
    const D = rom.game.doa;
    const ram = new Uint8Array(RAM_SIZE);
    for (const [a, v] of pokes) ram[a - RAM_BASE] = v;
    /* The view vector the culls dot with (0x71BA0): (1, 1, 1), so that every
     * piece is in front. */
    const rv = new DataView(ram.buffer);
    for (let k = 0; k < 3; k++) rv.setFloat32(VIEW_VECTOR - RAM_BASE + 4 * k, 1, true);
    const unknown = new Set();
    const copro = new Copro(unknown);
    const models = modelTracker({ ...rom.game.modelTable, offset: rom.game.modelTable.offset });
    const geo = new Geo(copro, models);
    const cpu = new I960(makeBus(rom, ram, copro, geo, models));
    /* The culling helpers: "in view", as a dot product well in front. */
    for (const at of D.visible ?? []) cpu.hooks.set(at, (c) => { c.setReg(16, floatToBits(1000)); });
    for (const at of D.skip ?? []) cpu.hooks.set(at, () => {});
    const done = cpu.call(entry, [], { maxSteps });
    return { draws: geo.draws, unknown: [...unknown], done };
}

/* ---- the fighters: the game's own skeleton code on a posed player ---- */

/* RAM the fight code keeps per player (p = 0, 1). */
const PLAYER = 0x54fbe0, PLAYER_SIZE = 88;
const FACING = 0x550124, START_FRAME = 0x56ac64;
const BODY_SCALES = [0x56ac50, 0x588ee0], MODEL_BASE = 0x5a6ed0, EXPRESSION = 0x58828c;
/* The motion step (0x44840) plays the motion 0x420C0 started: each call it
 * moves the motion's clock on by the speed at 0x56ADA0 times the record's
 * rate (+0x10), and takes the joint angles (0x56AA40) and the hips' place
 * (0x56AD50, x y z a player) from the frame the clock has reached, a mirrored
 * player's (facing -1) mirrored. The skeleton (0x47810) lifts the hips by
 * that y times the character's height (0x589B80, which 0x4DAE0 copies from a
 * table of one float a character); the body routine turns x and z by the
 * heading at 0x56AC28 into the player's spot and clears them, so a fighter
 * steps as its motion does. */
const SPEED = 0x56ada0, HEADING = 0x56ac28, HEIGHT = 0x589b80, RATE = 0x10;
/* A move can ease in from the pose before it: the fight code sets a count of
 * frames at 0x56AC04, 0x4A5B0 works out a step per joint toward the move's
 * first frame, and 0x4A8D0 takes one step a frame and counts down, in place
 * of the motion step, until the count runs out. */
const BLEND = 0x56ac04;
/* The fight loop opens each frame with 0x4DF20, which works out the push on
 * the hair and ribbon, which is also the way the shadows fall, from the
 * stage's light (0x5555B0) and the stage number,
 * and closes it with 0x4DDC0, which copies the fight's state for the next
 * frame and the low bit of the frame count (0x54B158) to 0x589DB1: the chains
 * swing only on frames of their parity, so every other frame. */
const LIGHT = 0x5555b0, FRAME_COUNT = 0x54b158;

/* A player record as the fight loop leaves it: character, costume, where it
 * stands (y 1.0 is the floor), three angles (the body faces the first; the
 * other two turn the head), +0x2D (which head the body routine picks; its
 * meaning is not known) and drawn. */
function placePlayer(rv, p, f) {
    const at = PLAYER + p * PLAYER_SIZE - RAM_BASE;
    rv.setUint8(at + 1, f.char);
    rv.setUint8(at + 2, f.costume ?? 0);
    f.pos.forEach((v, k) => rv.setFloat32(at + 4 + 4 * k, v, true));
    rv.setFloat32(at + RATE, 1, true);
    f.angles.forEach((v, k) => rv.setUint16(at + 0x14 + 4 * k, v, true));
    rv.setUint8(at + 0x2d, f.head);
    rv.setUint8(at + 0x48, 1);
}

/* Set a player up the way the fight start does. */
function startPlayer(M, F, p, f) {
    const { cpu, rv } = M;
    const call = (at, args) => cpu.call(at, args, { maxSteps: 5_000_000 });
    placePlayer(rv, p, f);
    rv.setUint32(HEIGHT - RAM_BASE + 4 * p, cpu.bus.read32(F.heights + 4 * f.char), true);
    rv.setUint32(MODEL_BASE - RAM_BASE + 4 * p, f.base, true);
    call(F.load, [f.char, p]);
    call(F.clearRibbon, [p]);
    call(F.setup, [p, f.char]);
    rv.setInt16(FACING - RAM_BASE + 2 * p, f.mirror ? -1 : 1, true);
    rv.setUint32(HEADING - RAM_BASE + 4 * p, f.angles[0], true);
    rv.setFloat32(SPEED - RAM_BASE + 4 * p, 1, true);
    for (const s of BODY_SCALES) rv.setFloat32(s - RAM_BASE + 4 * p, 1, true);
    /* Which of the character's face models the body routine draws. */
    rv.setInt16(EXPRESSION - RAM_BASE + 2 * p, f.expression ?? 0, true);
}

/* Start one of a player's moves: [motion, frames, rate, blend, from], `from`
 * the motion frame it starts on (1 if not given). */
function startMove(M, F, p, [motion, , rate, blend, from]) {
    const { cpu, rv } = M;
    rv.setInt16(START_FRAME - RAM_BASE + 2 * p, from ?? 1, true);
    cpu.call(F.motion, [p, motion], { maxSteps: 5_000_000 });
    rv.setFloat32(PLAYER + p * PLAYER_SIZE + RATE - RAM_BASE, rate ?? 1, true);
    rv.setInt16(BLEND - RAM_BASE + 2 * p, blend ?? 0, true);
    if (blend) cpu.call(F.blendStart, [p], { maxSteps: 5_000_000 });
}

/* Move a player on a frame: a step of its blend while one runs, else of its motion. */
function stepPlayer(M, F, p) {
    const blending = M.rv.getInt16(BLEND - RAM_BASE + 2 * p, true) !== 0;
    M.cpu.call(blending ? F.blend : F.step, [p], { maxSteps: 5_000_000 });
}

/* Which move a player starts at each of its frames, and how many it plays. */
function moveStarts(f) {
    const starts = new Map();
    let n = 0;
    for (const move of f.moves) {
        starts.set(n, move);
        n += move[1];
    }
    return { starts, frames: n };
}

/* Move a player's draws so that it stands at `pos` (x, z): the motion has
 * walked it from there while it played. */
function standAt(draws, rv, p, pos) {
    const at = PLAYER + p * PLAYER_SIZE - RAM_BASE;
    const dx = pos[0] - rv.getFloat32(at + 4, true), dz = pos[2] - rv.getFloat32(at + 12, true);
    return draws.map((d) => ({ ...d, m: [...d.m.slice(0, 9), d.m[9] + dx, d.m[10], d.m[11] + dz] }));
}

/**
 * Pose the fighters a profile names and return what the body (0x457C0) and
 * ribbon (0x4FEB0) routines draw, in the board's frame. Each fighter plays
 * its moves, a step (0x44840) and a draw a frame, the way the fight loop
 * does: the hair and ribbon are chains the code swings from frame to frame,
 * so how they hang depends on the moves before. The round start (0x54660)
 * sets the floor and the ring the shadows fall on. The fighters end together;
 * only that last frame's draws are kept, moved to where the profile puts each
 * player.
 *
 * @param {object} rom
 * @param {{char:number, costume?:number, base:number, pos:number[], angles:number[],
 *          mirror?:boolean, moves:number[][]}[]} fighters
 *        `moves`: [motion, frames, rate?, blend?, from?] in order
 * @param {{stage?:number, light?:number[], frame?:number}} [scene] the stage,
 *        its light (0x5555B0) and the board's frame count on the last frame
 * @returns {{draws: {model:number, m:number[]}[], unknown: string[]}}
 */
export function runDoaFighters(rom, fighters, scene = {}) {
    const F = rom.game.doa.fighters;
    const M = doaMachine(rom);
    const { rv } = M;
    for (const [a, v] of F.boot ?? []) rv.setFloat32(a - RAM_BASE, v, true);
    M.cpu.call(F.roundStart, [], { maxSteps: 5_000_000 });
    for (const [a, v] of F.pokes ?? []) rv.setUint8(a - RAM_BASE, v);
    rv.setUint8(rom.game.doa.stageByte - RAM_BASE, scene.stage ?? 0);
    (scene.light ?? []).forEach((v, k) => rv.setFloat32(LIGHT - RAM_BASE + 4 * k, v, true));
    fighters.forEach((f, p) => startPlayer(M, F, p, f));
    const plans = fighters.map(moveStarts);
    const last = Math.max(...plans.map((s) => s.frames));
    /* The frame count's parity on the last frame is the board's. */
    const frame = (t) => t - last + (scene.frame ?? 0);
    endFrame(M, F, frame(-1));
    let byPlayer = [];
    for (let t = 0; t < last; t++) {
        byPlayer = fighters.map(() => []);
        const playing = plans.map((s, p) => [p, s.starts.get(t - (last - s.frames)), t >= last - s.frames]);
        fightFrame(M, F, playing.filter(([, , on]) => on), byPlayer);
        endFrame(M, F, frame(t));
    }
    const draws = fighters.flatMap((f, p) => standAt(byPlayer[p], rv, p, f.pos));
    return { draws, unknown: [...M.unknown] };
}

/* One frame of the fight loop for the players playing ([p, the move it
 * starts on the frame if any]): each moves and draws its body, then each
 * draws its chains. */
function fightFrame(M, F, playing, byPlayer) {
    const call = (at, ...args) => M.cpu.call(at, args, { maxSteps: 5_000_000 });
    call(F.frameStart);
    for (const [p, move] of playing) {
        if (move) startMove(M, F, p, move);
        stepPlayer(M, F, p);
        M.geo.draws = byPlayer[p];
        call(F.body, p);
    }
    for (const [p] of playing) {
        M.geo.draws = byPlayer[p];
        call(F.ribbon, p);
    }
}

/* Close frame `n` of the board's frame count. */
function endFrame(M, F, n) {
    M.rv.setUint32(FRAME_COUNT - RAM_BASE, n >>> 0, true);
    M.cpu.call(F.frameEnd, [], { maxSteps: 5_000_000 });
}

/** Every stage the table names, as explorer stages. */
export function readDoaStages(rom) {
    const D = rom.game.doa;
    const cv = rom.mainCpuView;
    const stages = [];
    const seen = new Set();
    for (let n = 0; n < D.count; n++) {
        const entry = cv.getUint32(D.routines + n * 4, true);
        if (seen.has(entry)) continue;
        seen.add(entry);
        let run;
        try {
            run = runStageRoutine(rom, entry, { ram: [[D.stageByte, n], ...(D.pokes ?? [])] });
        } catch (e) {
            console.warn(`doa: stage ${n} (0x${entry.toString(16)}): ${e.message}`);
            continue;
        }
        if (!run.draws.length) continue;
        stages.push(stageOf(rom, n, entry, run));
    }
    stages.forEach((s, i) => { s.slot = i; });
    return stages;
}

/* The attract fight's two fighters, posed, if this is its stage. */
function attractOf(rom, n) {
    const A = rom.game.doa.attract;
    if (!A || A.stage !== n || !rom.game.doa.fighters) return null;
    try {
        return { fighters: A.fighters, run: runDoaFighters(rom, A.fighters, A) };
    } catch (e) {
        console.warn(`doa: fighters: ${e.message}`);
        return null;
    }
}

function stageOf(rom, n, entry, run) {
    const D = rom.game.doa;
    const lit = gameLighting(rom);
    const set = n;
    const placed = (layer) => (d) => ({
        model: d.model, pos: [d.m[9], d.m[10], d.m[11]], set, layer, ops: boardToOps(d.m),
    });
    const fight = attractOf(rom, n);
    const draws = [...run.draws.map(placed('scenery')), ...(fight?.run.draws.map(placed('fighters')) ?? [])];
    return {
        slot: n,
        placements: true,
        mixedSets: false,
        num: n,
        name: D.names?.[n] ?? `Stage ${n}`,
        chapter: n,
        draws,
        objects: [],
        sky: null,
        /* The tile layer's panorama (js/scroll.js); its colours are raw. */
        panorama: () => buildDoaSky(rom, n),
        zones: [],
        views: [['all', 'Everything']],
        view: 'all',
        union: 'all',
        texSets: [set],
        /* The texture set and the colour block: both are the stage number. */
        texSet: [set, set],
        fighters: fight?.fighters ?? [],
        tint: [1, 1, 1],
        bright: 1,
        light: lit?.light,
        materials: lit?.materials,
        colorCycles: [],
        floorSize: 0,
        meta: [['stage', n], ['routine', `0x${entry.toString(16)}`], ['pieces', draws.length],
            ...(fight ? [['fighters', fight.fighters.map((f) => f.char).join(' vs ')]] : []),
            ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
    };
}
