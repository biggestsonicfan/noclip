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

/* The inverse of m, a turn and a move. */
function invert(m) {
    const r = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    return [...r, ...apply([...r, 0, 0, 0], m.slice(9)).map((v) => -v)];
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

/* An angle as the copro's arctangent gives it: a little short (about 6e-5 of
 * the angle, so straight back is 0x7FFE) and rounded down, as MAME's answers
 * to 0x0A and 0x0F are, to a unit either way. */
function boardAngle(rad) {
    return (Math.floor((rad / ANGLE_RAD) * (1 - 6e-5)) << 16) >> 16;
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
    0x0a: [2, (cp, a) => cp.outInt(boardAngle(Math.atan2(a[1], a[0])))],
    0x1b: [1, (cp, a) => cp.out([Math.sin(((a[0] << 16) >> 16) * ANGLE_RAD)])],
    0x1c: [1, (cp, a) => cp.out([Math.cos(((a[0] << 16) >> 16) * ANGLE_RAD)])],
    /* An angle and a distance (a single): the step along that heading. */
    0x1e: [2, (cp, a) => cp.out([Math.cos(((a[0] << 16) >> 16) * ANGLE_RAD) * bitsToFloat(a[1])])],
    0x1d: [2, (cp, a) => cp.out([Math.sin(((a[0] << 16) >> 16) * ANGLE_RAD) * bitsToFloat(a[1])])],
    0x07: [12, (cp, a) => { cp.m = a.slice(); }],
    0x09: [12, (cp, a) => { cp.m = compose(cp.m, a); }],
    /* The camera task's first word: the matrices from here on are the
     * camera's (js/doa.js fightFrame takes them back to the stage's). */
    0x08: [0, (cp) => { cp.stack = []; cp.m = IDENTITY; cp.camera = true; }],
    0x10: [0, (cp) => { cp.m = IDENTITY; }],
    0x19: [0, (cp) => cp.outInt(0)],
    0x1a: [3, (cp, a) => cp.out(apply(cp.m, a))],
    0x1f: [6, (cp, a) => cp.out([Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2])])],
    0x0f: [6, (cp, a) => {
        const dx = a[3] - a[0], dy = a[4] - a[1], dz = a[5] - a[2];
        cp.outInt(boardAngle(Math.atan2(0 - dx, dz)));
        cp.outInt(boardAngle(Math.atan2(dy, Math.hypot(dx, dz))));
    }],
};
/* Commands whose words are integers rather than singles. */
const INT_ARGS = new Set([0x14, 0x15, 0x16, 0x1b, 0x1c, 0x1d, 0x1e]);

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
/* The program the routines run, with the game's own slips fixed (the
 * game's `fixes`: [address, word the ROM holds, word put there]). A fix is
 * left out if the ROM doesn't hold what it expects. */
const fixedPrograms = new WeakMap();
function fixedProgram(rom) {
    const fixes = rom.game.doa?.fixes ?? [];
    if (!fixes.length) return rom.mainCpuView;
    let cv = fixedPrograms.get(rom);
    if (cv) return cv;
    const src = rom.mainCpuView;
    cv = new DataView(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    if (fixes.every(([a, was]) => cv.getUint32(a, true) === was)) {
        for (const [a, , now] of fixes) cv.setUint32(a, now, true);
    } else console.warn('doa: the program differs from what its fixes expect; left as it is');
    fixedPrograms.set(rom, cv);
    return cv;
}

function makeBus(rom, ram, copro, geo, models) {
    const cv = fixedProgram(rom), dv = rom.mainDataView;
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
 * @param {object} [opts] ram: bytes to poke first, as [[addr, u8], ...];
 *        init: a routine, or a list of them, to run first (the stage setup);
 *        frames: the passes of the routine, the last one's draws returned;
 *        clock: the board's frame count (0x54B158) on the last pass, counted
 *        up a pass at a time to it, for the routines that read it;
 *        tick: the stage task's own count-up, run after each pass
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

export function runStageRoutine(rom, entry, opts = {}) {
    const run = stageRun(rom, entry, opts);
    return { draws: run.draws, unknown: run.unknown, done: run.done, run };
}

/*
 * A stage routine set up and run to its frame, that goes on running: `step()`
 * is one more pass (the board's next frame), with the frame count one on.
 * `rewind()` puts RAM back as the first run left it. `most` is the most
 * pieces any pass drew; `ram` is the board RAM it runs in.
 */
function stageRun(rom, entry, { ram: pokes = [], maxSteps, init, frames = 1, clock, tick } = {}) {
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
    /* A stage that moves keeps its state in RAM and steps it each time it is
     * drawn: the stage setup (`init`) clears it, then each pass of the
     * routine is a frame, and the last pass's draws are the ones shown. */
    for (const at of [init ?? []].flat()) cpu.call(at, [], { maxSteps: 5_000_000 });
    const run = { draws: [], unknown: [], done: true, most: 0, ram };
    let n = clock === undefined ? undefined : (clock - frames) >>> 0;
    run.step = () => {
        geo.draws = [];
        if (n !== undefined) rv.setUint32(FRAME_COUNT - RAM_BASE, (n = (n + 1) >>> 0), true);
        run.done = cpu.call(entry, [], { maxSteps });
        if (tick) cpu.call(tick, [], { maxSteps });
        run.draws = geo.draws;
        run.most = Math.max(run.most, run.draws.length);
        return run.draws;
    };
    for (let k = 0; k < frames; k++) run.step();
    run.unknown = [...unknown];
    const saved = { ram: ram.slice(), n, draws: run.draws };
    run.rewind = () => {
        ram.set(saved.ram);
        n = saved.n;
        run.draws = saved.draws;
    };
    return run;
}

/* ---- the fighters: the game's own skeleton code on a posed player ---- */

/* RAM the fight code keeps per player (p = 0, 1). */
const PLAYER = 0x54fbe0, PLAYER_SIZE = 88;
const FACING = 0x550124;
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
/* The fight loop opens each frame with 0x4DF20, which works out the push on
 * the hair and ribbon, which is also the way the shadows fall, from the
 * stage's light (0x5555B0) and the stage number,
 * and closes it with 0x4DDC0, which copies the fight's state for the next
 * frame and the low bit of the frame count (0x54B158) to 0x589DB1: the chains
 * swing only on frames of their parity, so every other frame. */
const LIGHT = 0x5555b0, FRAME_COUNT = 0x54b158;

/* A player record as the round start leaves it: character, costume, where it
 * stands (y 1.0 is the floor), three angles (the body faces the first; the
 * other two turn the head) and drawn. */
function placePlayer(rv, p, f) {
    const at = PLAYER + p * PLAYER_SIZE - RAM_BASE;
    rv.setUint8(at + 1, f.char);
    rv.setUint8(at + 2, f.costume ?? 0);
    f.pos.forEach((v, k) => rv.setFloat32(at + 4 + 4 * k, v, true));
    rv.setFloat32(at + RATE, 1, true);
    setAngles(rv, p, f.angles);
    rv.setUint8(at + 0x48, 1);
}

function setAngles(rv, p, angles) {
    angles.forEach((v, k) => rv.setUint16(PLAYER + p * PLAYER_SIZE + 0x14 + 4 * k - RAM_BASE, v, true));
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
    /* The setup turns the player toward where the other one stood. */
    setAngles(rv, p, f.angles);
    rv.setInt16(FACING - RAM_BASE + 2 * p, 1, true);
    rv.setUint32(HEADING - RAM_BASE + 4 * p, f.angles[0], true);
    rv.setFloat32(SPEED - RAM_BASE + 4 * p, 1, true);
    for (const s of BODY_SCALES) rv.setFloat32(s - RAM_BASE + 4 * p, 1, true);
    /* Which of the character's face models the body routine draws. */
    rv.setInt16(EXPRESSION - RAM_BASE + 2 * p, f.expression ?? 0, true);
}

/* What the fight's first frame finds in a player's record: `angles` and
 * `state`, [offset, byte ...] (the action it starts, +0x28, and +0x36 1 to
 * start it). */
function openPlayer(rv, p, { angles, state = [] }) {
    if (angles) setAngles(rv, p, angles);
    for (let k = 0; k < state.length; k += 2) rv.setUint8(PLAYER + p * PLAYER_SIZE + state[k] - RAM_BASE, state[k + 1]);
}

/* What the stage setup (0x70764) copies for the stage: a grid of 14 x 14
 * cells, two singles a cell (0x5A6F00) and a byte (0x5A7520), that the
 * ribbon's swing reads under the player's feet. */
function copyStageGrid(M, G, stage) {
    const { bus } = M.cpu;
    const [cells, bytes] = G.alt.stages.includes(stage) ? G.alt.from : G.from;
    for (let i = 0; i < 14 * 14; i++) {
        bus.write32(G.cells + 8 * i, bus.read32(cells + 8 * i));
        bus.write32(G.cells + 8 * i + 4, bus.read32(cells + 8 * i + 4));
        bus.write8(G.bytes + i, bus.read8(bytes + i));
    }
}

/* Run a task from `entry` until its `waits`-th wait for the next frame
 * (0x8240). The tasks loop forever, waiting at the loop's head, so the camera
 * task (0x7D1B0) runs a frame from its start to its second wait, the AI's
 * (`ai.start`) sets up to its first, and a pass of the AI's loop runs from
 * the loop's head (`ai.frame`, which waits first) to the next wait. */
function taskFrame(M, F, entry, waits) {
    let seen = 0;
    M.cpu.hooks.set(F.frameWait, () => {
        if (++seen >= waits) throw new Error('task done');
    });
    try {
        M.cpu.call(entry, [], { maxSteps: 5_000_000 });
    } catch (e) {
        if (e.message !== 'task done') throw e;
    } finally {
        M.cpu.frames.length = 0;
        M.cpu.hooks.delete(F.frameWait);
    }
}

/* The boot's and the fight's settings, the stage and its light. */
function setScene(rom, M, scene) {
    const F = rom.game.doa.fighters;
    const { rv } = M;
    for (const [a, v] of F.boot) rv.setFloat32(a - RAM_BASE, v, true);
    M.cpu.call(F.roundStart, [], { maxSteps: 5_000_000 });
    for (const [a, v] of F.pokes) rv.setUint8(a - RAM_BASE, v);
    rv.setUint8(rom.game.doa.stageByte - RAM_BASE, scene.stage);
    scene.light.forEach((v, k) => rv.setFloat32(LIGHT - RAM_BASE + 4 * k, v, true));
}

/* Set the fight up the way the round start does, before its first frame. */
function startFight(rom, M, fighters, scene) {
    const F = rom.game.doa.fighters;
    const { rv } = M;
    const call = (at, args = []) => M.cpu.call(at, args, { maxSteps: 50_000_000 });
    setScene(rom, M, scene);
    for (let c = 0; c < F.tables.count; c++) call(F.tables.at, [c]);
    copyStageGrid(M, F.grid, scene.stage);
    fighters.forEach((f, p) => call(F.roundReset, [p]));
    fighters.forEach((f, p) => startPlayer(M, F, p, f));
    for (const [a, v] of scene.camera) rv.setUint32(a - RAM_BASE, v, true);
    call(F.moversStart);
}

/**
 * Play the fight a profile names and return what the body (0x457C0) and
 * ribbon (0x4FEB0) routines draw on its last frame, in the stage's frame.
 * Each frame runs what the board's fight loop runs, in its order: the frame
 * start, each player (0x41A50: its action script, motion and body), each
 * player's chains, the frame end, the hit and push checks (`collision`), the
 * camera task, then the fight's tasks (`fight`: the hits, the reactions, the
 * throws and the ring) and the movers that push the players apart (the
 * knockback at 0x2F5E0, the push of fighters in contact at 0x2F670 and the
 * rest of the task at 0x2F4F0's). The attract's AI is a task of its own
 * (`ai`), which gives each computer player its command (+0x2C) and guard
 * (+0x3A); it starts once the fight is set up and the bytes the attract's
 * script sets before the fight are in (`scene.ai`), then runs a pass each
 * frame after the camera task, as on the board. The hair and
 * ribbon are chains the code swings from frame to frame, so how they hang
 * depends on everything before.
 *
 * @param {object} rom
 * @param {{char:number, costume?:number, base:number, pos:number[], angles:number[],
 *          expression?:number, open:object}[]} fighters
 *        `pos` where the round starts the player, `open` its record on the
 *        first frame (openPlayer)
 * @param {{stage:number, light:number[], first:number, frame:number, camera:number[][],
 *          ai:number[][]}} scene
 *        the stage, its light (0x5555B0), the board's frame count (0x54B158)
 *        on the fight's first and last frames, the camera task's state on the
 *        first ([address, word] ...) and the bytes the attract's script sets
 *        for the AI ([address, byte] ...)
 * @returns {{draws: {model:number, m:number[]}[], unknown: string[]}}
 */
export function runDoaFighters(rom, fighters, scene) {
    const F = rom.game.doa.fighters;
    const M = doaMachine(rom);
    const { rv } = M;
    const call = (at) => M.cpu.call(at, [], { maxSteps: 5_000_000 });
    startFight(rom, M, fighters, scene);
    endFrame(M, F, scene.first);
    fighters.forEach((f, p) => openPlayer(rv, p, f.open));
    for (const [a, v] of scene.ai) rv.setUint8(a - RAM_BASE, v);
    taskFrame(M, F, F.ai.start, 1);
    let byPlayer = [];
    for (let n = scene.first; n <= scene.frame; n++) {
        byPlayer = fighters.map(() => []);
        fightFrame(M, F, byPlayer);
        endFrame(M, F, n);
        for (const r of F.collision) call(r);
        taskFrame(M, F, F.camera, 2);
        taskFrame(M, F, F.ai.frame, 2);
        for (const r of [...F.fight, ...F.movers]) call(r);
    }
    return { draws: byPlayer.flat(), unknown: [...M.unknown] };
}

/* One frame of the fight loop's drawing: each player moves and draws its
 * body, then each draws its chains. The camera task left the camera as the
 * copro's matrix, so the draws are in the camera's frame; they go back to
 * the stage's through its inverse. */
function fightFrame(M, F, byPlayer) {
    const call = (at, ...args) => M.cpu.call(at, args, { maxSteps: 5_000_000 });
    const camera = M.copro.camera ? M.copro.m : IDENTITY;
    call(F.frameStart);
    byPlayer.forEach((draws, p) => {
        M.geo.draws = draws;
        call(F.player, p);
    });
    byPlayer.forEach((draws, p) => {
        M.geo.draws = draws;
        call(F.ribbon, p);
    });
    const back = invert(camera);
    for (const d of byPlayer.flat()) d.m = compose(back, d.m);
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
            run = runStageRoutine(rom, entry, { ram: [[D.stageByte, n], ...(D.pokes ?? [])], ...stageClock(rom, n) });
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

/* The attract fight's stage runs from its setup to the frame drawn, so that
 * what swings is where it was. The other stages that move run the same way,
 * through the game's own setups (the common one, then the stage's from the
 * table the round start calls), for as many frames and to the same frame
 * count; tools/doa-stages grades them against MAME's attract. The rest are
 * drawn once, at rest. */
function stageClock(rom, n) {
    const D = rom.game.doa, A = D.attract, S = D.stageSetup;
    if (A?.stage === n && A.stageInit) return { init: A.stageInit, frames: A.stageFrames, tick: S?.tick };
    if (!S?.moving.includes(n)) return {};
    const own = rom.mainCpuView.getUint32(S.table + 4 * n, true);
    return { init: [S.common, own], frames: S.frames, clock: S.clock, tick: S.tick };
}

function stageMoves(rom, n) {
    const D = rom.game.doa;
    return D.attract?.stage === n || !!D.stageSetup?.moving.includes(n);
}

/*
 * A moving stage goes on moving in the viewer: the routine runs on a pass a
 * frame from the one baked, and each piece is the piece the pass drew in its
 * place in the list. A pass can draw fewer pieces than another (stage 4's
 * belt), so the list has a slot for the most any pass drew, and a slot the
 * pass leaves empty is hidden. Going back in time (the clock starting over)
 * rewinds RAM to the baked pass; a long gap is caught up a few hundred passes
 * a frame.
 */
const CATCH_UP = 300;

function liveScenery(scenery, run) {
    let pass = 0;
    const at = (f) => {
        if (f < pass) { run.rewind(); pass = 0; }
        for (const end = Math.min(f, pass + CATCH_UP); pass < end; pass++) run.step();
        return run.draws;
    };
    const last = scenery[scenery.length - 1];
    while (scenery.length < run.most) scenery.push({ ...last });
    scenery.forEach((d, i) => {
        d.live = (f) => {
            const p = at(f)[i];
            return p ? { model: p.model, ops: boardToOps(p.m) } : { model: d.model, ops: d.ops, hidden: true };
        };
    });
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
    const scenery = run.draws.map(placed('scenery'));
    if (stageMoves(rom, n)) liveScenery(scenery, run.run);
    const draws = [...scenery, ...(fight?.run.draws.map(placed('fighters')) ?? [])];
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
