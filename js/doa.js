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
    0x1b: [1, (cp, a) => cp.out([Math.sqrt(Math.abs(a[0]))])],
};
/* Commands whose words are integers rather than singles. */
const INT_ARGS = new Set([0x14, 0x15, 0x16]);

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

function stageOf(rom, n, entry, run) {
    const D = rom.game.doa;
    const lit = gameLighting(rom);
    const set = n;
    const draws = run.draws.map((d) => ({
        model: d.model, pos: [d.m[9], d.m[10], d.m[11]], set, layer: 'scenery', ops: boardToOps(d.m),
    }));
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
        tint: [1, 1, 1],
        bright: 1,
        light: lit?.light,
        materials: lit?.materials,
        colorCycles: [],
        floorSize: 0,
        meta: [['stage', n], ['routine', `0x${entry.toString(16)}`], ['pieces', draws.length],
            ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
    };
}
