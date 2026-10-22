/*
 * powsled.js — Power Sled's model list.
 *
 * The game has no model table. A model is the three words the geometry
 * engine's object command takes, texture point address, texture header
 * address and object address (MAME model2_v.cpp geo_object_data), and the
 * program hands them over from three kinds of place:
 *
 * - 64-byte placement records in the data ROM: the three words, a zero, then a
 *   3x4 float matrix. The grid at data 0x4770 is {ptr, 33, 33 offsets} of
 *   them, read by 0xE47AC through 0xE1F30; there are longer runs at 0x40534,
 *   0xEDD98, 0x13E240, 0x18E6E8, 0x1DEF68 and 0x285CA4.
 * - 28-byte named records in the program ROM, about 0xD8EA0..0xE19E8: two
 *   words, the three words, a zero and a pointer to a name such as
 *   HONBAN_sce2_course_N_4_1_0.
 * - Immediates in the code: `lda tpa,g6 ; st g6,0x804000 ; lda d(g6),g6 ;
 *   st ; lda oba,g6 ; st`, the FIFO stores at 0xE3F9C and the routines round
 *   it. A model with no texture stores g6 twice, so its header is its point
 *   address.
 *
 * What is listed is every distinct triple those three hold, in mesh order. A
 * frame's display list from m2-hle2 (bufferram, the 0x00800101 commands) names
 * nothing that is not here.
 */

import { I960 } from './i960.js';
import { boardToOps } from './doa.js';
import { gameLighting } from './stages.js';
import { readModelEntry } from './romset.js';
import { decodeModel } from './model.js';

/* An object address with bit 23 set is a word index into the polygon ROM. */
const POLY_BIT = 0x00800000;
/* The texture ROM is 4M halfwords. A model's material block follows its point
 * block, and none is more than 0xD84 words on; a wider gap is two words that
 * only look like a pair. */
const TEX_WORDS = 0x400000;
const MAT_SPAN = 0x1000;

/* i960 words: `lda <32-bit>, reg` (MEMB, absolute), `st reg, <32-bit>` and
 * `lda off(reg), reg` (MEMA, offset plus base). */
const isLdaLiteral = (w) => (w & 0xff003fff) >>> 0 === 0x8c003000;
const isStore = (w) => w >>> 24 === 0x92;
const isLdaOffset = (w) => w >>> 24 === 0x8c && (w & 0x3000) === 0x2000;
const FIFO = 0x00804000;

/** Where the polygon ROM's data ends, in words: it is padded with 0xFF. */
function polygonWords(rom) {
    const p = rom.polygons;
    let end = p.length;
    while (end > 0 && p[end - 1] === 0xff) end--;
    return Math.ceil(end / 4);
}

/**
 * Every model the program can draw, as {uvPtr, matPtr, meshPtr}, sorted by
 * mesh and then texture.
 */
export function powsledModels(rom) {
    const words = polygonWords(rom);
    const isMesh = (o) => (o & 0xff800000) >>> 0 === POLY_BIT && (o & 0x7fffff) < words;
    const seen = new Map();
    const add = (u, m, o) => {
        const key = `${u}/${m}/${o}`;
        if (!seen.has(key)) seen.set(key, { uvPtr: u, matPtr: m, meshPtr: o });
    };

    /* Records: the three words side by side, in either ROM. */
    for (const bytes of [rom.mainData, rom.maincpu]) {
        const w = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
        for (let i = 0; i + 2 < w.length; i++) {
            const u = w[i], m = w[i + 1], o = w[i + 2];
            if (isMesh(o) && u > 0 && u <= m && m < TEX_WORDS && m - u < MAT_SPAN) add(u, m, o);
        }
    }

    /* Immediates: walk back from each `lda oba` that is followed by its store. */
    const w = new Uint32Array(rom.maincpu.buffer, rom.maincpu.byteOffset, rom.maincpu.length >> 2);
    const st = (k) => w[k] === FIFO && isStore(w[k - 1]);
    for (let k = 9; k < w.length; k++) {
        if (!isMesh(w[k]) || !isLdaLiteral(w[k - 1]) || !st(k - 2)) continue;
        if (isLdaOffset(w[k - 4]) && st(k - 5) && isLdaLiteral(w[k - 8])) {
            add(w[k - 7], w[k - 7] + (w[k - 4] & 0xfff), w[k]);
        } else if (st(k - 4) && isLdaLiteral(w[k - 7])) {
            add(w[k - 6], w[k - 6], w[k]);
        }
    }

    return [...seen.values()].sort((a, b) => a.meshPtr - b.meshPtr || a.uvPtr - b.uvPtr || a.matPtr - b.matPtr);
}

/* ---- the course ---- */

/*
 * The race draws the course by how far down it the sled is (the routine at
 * 0x30AF4 and its two twins, 0x2A01C and 0x35CD0): a scene routine for each
 * span of that progress, handed what is left of it past the span's start.
 * The routines draw the pieces of the named 28-byte records whose
 * {first, last} span holds it (0xD8B50: g0 the records, g1 their count, g2
 * the progress), each in world space under the camera, and a few with a
 * matrix of their own. Past 0x347 nothing more changes: that is the goal.
 *
 * The scenes are named for the records they draw, HONBAN_sce2_course_N and
 * on ("honban", the run proper), the start's sce1 and sce2 by the one
 * routine; the game names no course, as there is only one.
 */
const SCENES = [
    { entry: 0xdb0c0, from: 0, to: 0xdb, label: 'sce1 and sce2 · the start' },
    { entry: 0xdbfd0, from: 0xdc, to: 0x171, label: 'sce3' },
    { entry: 0xdcbf0, from: 0x172, to: 0x1b7, label: 'sce4 · the tunnel' },
    { entry: 0xdd250, from: 0x1b8, to: 0x1c6, label: 'sce5' },
    { entry: 0xde200, from: 0x1c7, to: 0x267, label: 'sce7 · the bridges' },
    /* 0x2A034's sce8 is 0xE1C80, the same less the goal (0xE04B0). */
    { entry: 0xe1af0, from: 0x268, to: 0x347, label: 'sce8 · the goal' },
];

const RAM_BASE = 0x500000, RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000;
const COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const GEO_CMD = 0x800000, GEO_PORT = 0x804000, GEO_END = 0x808000;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const ANGLE_RAD = (2 * Math.PI) / 0x10000;

/* a * b, both 3x4 with columns X, Y, Z, then the translation. */
function compose(a, b) {
    const out = [];
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 3; r++) {
            out[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2] + (c === 3 ? a[9 + r] : 0);
        }
    }
    return out;
}

/*
 * Power Sled's coprocessor program is not the TGP's the other games here
 * use. A command is one word to the port, the opcode in its low byte, and
 * its singles after it. What the course and the riders send:
 *
 *   0x04  push the matrix          0x05  pop it
 *   0x1D  translate (3 singles)    0x1F  times a 3x4 (12 singles)
 *   0x07  hand the matrix over, the twelve words the geometrizer's 0x0B
 *         then reads back
 *   0x2C  scale (1 single)         0x21  turn (1 word; about Y, taken)
 *
 * 0x2C and 0x21 come only from the goal's sign (0xE04B0), which the race
 * turns and scales by the progress; the stage takes its first frame.
 * Anything else is noted and its words skipped.
 */
class Copro {
    constructor() {
        this.m = IDENTITY;
        this.stack = [];
        this.op = null;
        this.args = [];
        this.out = [];
        this.unknown = new Set();
    }

    word(w) {
        if (this.op === null) {
            this.op = w & 0xff;
            this.args = [];
        } else this.args.push(w);
        const need = { 0x1d: 3, 0x1f: 12, 0x2c: 1, 0x21: 1 }[this.op] ?? 0;
        if (this.args.length < need) return;
        const op = this.op, a = this.args;
        this.op = null;
        const f = (i) => bitsToFloat(a[i]);
        if (op === 0x04) this.stack.push(this.m);
        else if (op === 0x05) this.m = this.stack.pop() ?? IDENTITY;
        else if (op === 0x1d) this.m = compose(this.m, [1, 0, 0, 0, 1, 0, 0, 0, 1, f(0), f(1), f(2)]);
        else if (op === 0x1f) this.m = compose(this.m, a.map((_, i) => f(i)));
        else if (op === 0x2c) this.m = compose(this.m, [f(0), 0, 0, 0, f(0), 0, 0, 0, f(0), 0, 0, 0]);
        else if (op === 0x21) {
            const c = Math.cos(((a[0] << 16) >> 16) * ANGLE_RAD), s = Math.sin(((a[0] << 16) >> 16) * ANGLE_RAD);
            this.m = compose(this.m, [c, 0, -s, 0, 1, 0, s, 0, c, 0, 0, 0]);
        } else if (op === 0x07) this.out = this.m.slice();
        else this.unknown.add(`copro 0x${op.toString(16)}`);
    }
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function bitsToFloat(w) { u32[0] = w; return f32[0]; }

/* The geometrizer's side: 0x0B (twelve words) takes the copro's matrix, 0x01
 * (four) draws an object under it. The rest are counted past. */
const GEO_WORDS = { 0x01: 4, 0x03: 6, 0x0b: 12, 0x0c: 3 };
class Geo {
    constructor(copro) {
        this.copro = copro;
        this.m = IDENTITY;
        this.cmd = null;
        this.words = [];
        this.draws = [];
    }

    command(cmd) { this.cmd = cmd; this.words = []; }

    data(w) {
        if (this.cmd === null) { this.command((w >>> 23) & 0x1f); return; }
        this.words.push(w >>> 0);
        if (this.words.length < (GEO_WORDS[this.cmd] ?? 1)) return;
        if (this.cmd === 0x0b) this.m = this.copro.out;
        else if (this.cmd === 0x01) this.draws.push({ words: this.words.slice(0, 3), m: this.m });
        this.cmd = null;
    }
}

function machine(rom) {
    const ram = new Uint8Array(RAM_SIZE), rv = new DataView(ram.buffer);
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const copro = new Copro(), geo = new Geo(copro);
    const other = new Map();
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE - 3;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) return cv.getUint32(a, true);
        if (inRam(a)) return rv.getUint32(a - RAM_BASE, true);
        if (a >= DATA_BASE && a - DATA_BASE < dv.byteLength - 3) return dv.getUint32(a - DATA_BASE, true);
        if (a >= COPRO_PORT && a < COPRO_END) return 0;
        return other.get(a) ?? 0;
    };
    const write32 = (a, v) => {
        if (inRam(a)) rv.setUint32(a - RAM_BASE, v, true);
        else if (a >= COPRO_PORT && a < COPRO_END) copro.word(v >>> 0);
        else if (a >= GEO_PORT && a < GEO_END) geo.data(v);
        else if (a >= GEO_CMD && a < GEO_PORT) geo.command((a >>> 4) & 0x1f);
        else other.set(a, v);
    };
    const lane = (a, bytes) => [a & ~3, (a & 3) * 8, bytes === 1 ? 0xff : 0xffff];
    const cpu = new I960({
        read32,
        write32,
        read8: (a) => { const [w, s] = lane(a, 1); return (read32(w) >>> s) & 0xff; },
        read16: (a) => { const [w, s] = lane(a, 2); return (read32(w) >>> s) & 0xffff; },
        write8: (a, v) => { if (inRam(a)) ram[a - RAM_BASE] = v; },
        write16: (a, v) => { if (inRam(a)) rv.setUint16(a - RAM_BASE, v, true); },
    });
    return { cpu, copro, geo };
}

/* The model a triple is: the list's own, or its mesh's drawn with the
 * material sent (the goal sign steps its material by the progress). */
function tripleModels(rom) {
    const byTriple = new Map(), byMesh = new Map();
    for (let i = rom.game.modelTable.count - 1; i >= 0; i--) {
        const e = readModelEntry(rom, i);
        byTriple.set(`${e.uvPtr}/${e.matPtr}/${e.meshPtr}`, i);
        byMesh.set(e.meshPtr, i);
    }
    return ([u, m, o]) => {
        const i = byTriple.get(`${u}/${m}/${o}`);
        if (i !== undefined) return i;
        const j = byMesh.get(o);
        return j === undefined ? null : `${j}#${m.toString(16)}`;
    };
}

/**
 * Run every scene routine over its span of the progress and keep each piece
 * once, at the first place it is drawn, with the scenes that draw it and the
 * first and last progress that does.
 */
export function runPowsledCourse(rom, { maxSteps = 3_000_000 } = {}) {
    const { cpu, copro, geo } = machine(rom);
    const model = tripleModels(rom);
    const pieces = new Map();
    let failed = 0;
    SCENES.forEach((s, zone) => {
        for (let p = s.from; p <= s.to; p++) {
            geo.draws = [];
            geo.m = IDENTITY;
            copro.m = IDENTITY;
            copro.stack = [];
            if (!cpu.call(s.entry, [p - s.from], { maxSteps })) failed++;
            for (const d of geo.draws) {
                const at = model(d.words);
                if (at === null) continue;
                const key = `${String(at).split('#')[0]}@${d.m.slice(9).map(Math.round).join(',')}`;
                let piece = pieces.get(key);
                if (!piece) pieces.set(key, (piece = { model: at, m: d.m, zones: new Set(), first: p, last: p }));
                piece.zones.add(zone);
                piece.last = p;
            }
        }
    });
    return { pieces: [...pieces.values()], unknown: [...copro.unknown], failed };
}

/* A piece's box in the board's frame, as [lo, hi]; null for an empty mesh. */
function pieceBounds(rom) {
    const bounds = new Map();
    const local = (p) => {
        const i = +String(p.model).split('#')[0];
        if (!bounds.has(i)) {
            const pos = decodeModel(rom, i)?.positions ?? [];
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (let k = 0; k < pos.length; k += 3) {
                for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[k + a]); hi[a] = Math.max(hi[a], pos[k + a]); }
            }
            bounds.set(i, pos.length ? [lo, hi] : null);
        }
        return bounds.get(i);
    };
    return (p) => {
        const b = local(p);
        if (!b) return null;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let c = 0; c < 8; c++) {
            /* The decode's Z is the board's negated. */
            const v = [b[c & 1][0], b[(c >> 1) & 1][1], -b[(c >> 2) & 1][2]];
            const w = [0, 1, 2].map((k) => p.m[k] * v[0] + p.m[3 + k] * v[1] + p.m[6 + k] * v[2] + p.m[9 + k]);
            for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], w[a]); hi[a] = Math.max(hi[a], w[a]); }
        }
        return [lo, hi];
    };
}

/*
 * The start's first frame draws six pieces of ground by the gate that the run
 * then swaps for others on the same spot (in m2-hle2's race, 0x8401B6 up to
 * frame 4601 and 0x822070 from 4731 on, never both): what the start camera
 * sees, and what the sled rides over. Both at once fight, so the one the
 * race keeps stays: a piece whose progress ends before another's starts and
 * whose box is that one's.
 */
function dropReplaced(rom, pieces) {
    const box = pieceBounds(rom);
    const boxes = pieces.map(box);
    const vol = (lo, hi) => [0, 1, 2].reduce((v, a) => v * Math.max(0, hi[a] - lo[a]), 1);
    const same = (a, b) => {
        const lo = [0, 1, 2].map((k) => Math.max(a[0][k], b[0][k]));
        const hi = [0, 1, 2].map((k) => Math.min(a[1][k], b[1][k]));
        const both = vol(lo, hi);
        return both > 0.9 * (vol(...a) + vol(...b) - both);
    };
    return pieces.filter((p, i) => !boxes[i] || !pieces.some((q, j) =>
        boxes[j] && p.last < q.first && same(boxes[i], boxes[j])));
}

/* Where each view's camera stands: off the scene's pieces, the way the stage
 * is framed when it opens (loadStage in js/app.js), since the views keep the
 * camera where none is given and the course is 25000 across. */
function sceneCameras(rom, pieces) {
    const box = pieceBounds(rom);
    const camera = (list) => {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const p of list) {
            const b = box(p);
            if (!b) continue;
            for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[0][a]); hi[a] = Math.max(hi[a], b[1][a]); }
        }
        if (lo[0] === Infinity) return null;
        /* Into the explorer's frame, Z negated. */
        const at = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, -(lo[2] + hi[2]) / 2];
        const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
        /* Out along the framing's direction, as far as it would stand. */
        const d = (1.8 * r) / Math.hypot(0.45, 0.36, 0.72);
        return { eye: [at[0] + d * 0.45, at[1] + d * 0.36, at[2] + d * 0.72], at };
    };
    const cameras = { all: camera(pieces) };
    SCENES.forEach((_, i) => { cameras[`zone:${i}`] = camera(pieces.filter((p) => p.zones.has(i))); });
    return cameras;
}

/*
 * The sky and the mountains round the course: 0xD8890, which the race loops
 * call through the words at 0x2A144, 0x30C0C and 0x35A4C, stands at the eye
 * unturned and draws the sky 500 above it at three times its size (0xD88E4,
 * 0xD890C) and the mountains 2600 below it (0xD8A48). Each is a triple of its
 * own, so neither is ever got nearer to; they go in every view. The sky is
 * the shell, drawn first; the mountains go over it with no depth test, since
 * their floor runs under the course, which the board's z sort puts in front
 * of it but a depth test would not.
 */
/*
 * Stand where the camera stands: a translation to the eye, unturned, so what
 * comes after it is carried along with the camera and never got nearer to.
 * Power Sled's sky and mountains go round the sled this way (0xD8890). It
 * lives here, not beside display.js's other camera ops, because display.js
 * imports romset.js, which imports this module: an import back would leave
 * it unset when display.js is loaded first.
 */
const AT_EYE = ['ce'];

const BACKDROP = [
    { words: [0x7C864, 0x7C954, 0x8AB219], ops: [AT_EYE, ['t', [0, 500, 0]], ['s', [3, 3, 3]]] },
    { words: [0x72A62, 0x72B5A, 0x89DAE0], ops: [AT_EYE, ['t', [0, -2600, 0]]], backdrop: true },
];

/*
 * The four cranes over the start that hold the sleds before the drop:
 * 0xE6DA0 runs r4 from 0 to 3 through 0xE6560, which draws
 * {0xA244, 0xA798, 0x811E36} for an even r4 and {0xA7C8, 0xAD24, 0x8124FF}
 * for an odd one, each at a matrix the copro works out. Where they stand is
 * read off m2-hle2's race (the geometry engine's matrices through the start
 * camera, frames 3561 to 4900): unturned, and still while the race runs. The
 * sleds hanging from them are the players', which are not the course's.
 */
const START_CRANES = [
    { words: [0xA244, 0xA798, 0x811E36], at: [6.959, 1783.965, 5527.939] },
    { words: [0xA7C8, 0xAD24, 0x8124FF], at: [-9.041, 1790.465, 5567.939] },
    { words: [0xA244, 0xA798, 0x811E36], at: [6.959, 1796.965, 5607.939] },
    { words: [0xA7C8, 0xAD24, 0x8124FF], at: [-9.041, 1803.465, 5647.939] },
];

function backdrop(rom) {
    const model = tripleModels(rom);
    const sky = BACKDROP.map((b) => ({ model: model(b.words), layer: 'sky', layered: false, backdrop: b.backdrop, set: 0, ops: b.ops }));
    const start = START_CRANES.map((b) => ({
        model: model(b.words), pos: b.at, set: 0, zones: new Set([0]), ops: boardToOps([1, 0, 0, 0, 1, 0, 0, 0, 1, ...b.at]),
    }));
    return sky.concat(start).filter((o) => o.model !== null);
}

/** The course, as one stage with a view for each scene. */
export function readPowsledStages(rom) {
    const lit = gameLighting(rom);
    const run = runPowsledCourse(rom);
    const pieces = dropReplaced(rom, run.pieces);
    let cameras = null;
    const draws = pieces.map((p) => ({
        model: p.model, pos: [p.m[9], p.m[10], p.m[11]], set: 0, zones: p.zones, ops: boardToOps(p.m),
    }));
    const zones = SCENES.map((s, i) => ({
        zone: i, set: 0, label: `${s.label} · ${draws.filter((d) => d.zones.has(i)).length} pieces`,
    }));
    return [{
        slot: 0,
        placements: true,
        mixedSets: false,
        num: 1,
        name: 'The course',
        chapter: 0,
        draws,
        objects: backdrop(rom),
        sky: null,
        panorama: null,
        zones,
        /* Decoded when the stage is first drawn. */
        get cameras() { return (cameras ??= sceneCameras(rom, pieces)); },
        views: [['all', 'Every scene at once'], ...zones.map((z, i) => [`zone:${i}`, z.label])],
        view: 'all',
        union: 'all',
        texSets: [0],
        texSet: [0, 0],
        tint: [1, 1, 1],
        bright: 1,
        light: lit.light,
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['scenes', SCENES.length], ['pieces', draws.length],
            ...(run.failed ? [['unfinished runs', run.failed]] : []),
            ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
    }];
}

/*
 * The figures (Animation tab). Each is a table in the data ROM,
 * { frame list, parts }, the frame list one data offset a frame, ended by
 * 0xFFFFFFFF; a frame is a 64-byte record a part: the part's tpa, tha and
 * oba, a zero, then at +0x10 nine floats of a 3x3 (columns X, Y, Z) and at
 * +0x34 its place. 0xE1D70 (and 0xE1F30, the same with the ride's colour)
 * draws a frame: per part push, translate (+0x34), times the 3x3 with no
 * translation (copro op 1F), output, draw, pop. So a frame is every part's
 * matrix baked, with no hierarchy; the ride scenes (below) pick the frame
 * from their own clock.
 */
const tableCache = new WeakMap();
function figureTables(rom) {
    if (tableCache.has(rom)) return tableCache.get(rom);
    const dv = rom.mainDataView;
    const tables = (rom.game.rig.figures ?? []).map((f) => {
        const list = dv.getUint32(f.at, true), parts = dv.getUint32(f.at + 4, true);
        const frames = [];
        for (let o; (o = dv.getUint32(list + frames.length * 4, true)) !== 0xffffffff;) frames.push(o);
        return { ...f, list, parts, frames };
    });
    tableCache.set(rom, tables);
    return tables;
}

const PART_BYTES = 64;

/* One part on one frame, as a board 3x4: T(place) · R. */
function partMatrix(dv, at) {
    const f = (i) => dv.getFloat32(at + 0x10 + i * 4, true);
    return compose([1, 0, 0, 0, 1, 0, 0, 0, 1, f(9), f(10), f(11)], [f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8), 0, 0, 0]);
}

/** The figures, as bodies whose parts are each placed on their own. */
export function readPowsledBodies(rom) {
    const dv = rom.mainDataView;
    const model = tripleModels(rom);
    const tables = figureTables(rom);
    const part = (at, j, index) => {
        const m = partMatrix(dv, at);
        return {
            index,
            parent: -1,
            depth: 0,
            model: model([0, 1, 2].map((w) => dv.getUint32(at + w * 4, true))),
            offset: [m[9], m[10], -m[11]],
            flags: 0,
            joint: index,
            record: at,
        };
    };
    const figures = tables.map((t, i) => ({
        index: i,
        name: t.name ?? `figure ${i}`,
        joints: t.parts,
        scale: 1,
        roles: [],
        skin: -1,
        hitMotions: [],
        start: i,
        root: t.at,
        parts: Array.from({ length: t.parts }, (_, j) => part(t.frames[0] + j * PART_BYTES, j, j)),
    }));
    /* A ride's scene: its woman's, riders' and crane's parts, then the
     * crane's colour piece. */
    const rides = rideScenes(rom).map((r, k) => {
        const parts = [];
        for (const g of r.groups) {
            for (let j = 0; j < g.table.parts; j++) parts.push(part(g.table.frames[0] + j * PART_BYTES, j, parts.length));
        }
        const piece = model(PIECES[r.colour]);
        parts.push({ ...parts[r.groups[2].first + 2], index: parts.length, joint: parts.length, model: piece, record: r.scene });
        const index = figures.length + k;
        return {
            index,
            name: r.name,
            ride: r,
            joints: parts.length,
            scale: 1,
            roles: [],
            skin: -1,
            hitMotions: [],
            start: tables.length + k * 2,
            root: r.scene,
            parts,
        };
    });
    return figures.concat(rides);
}

/** One motion a figure: its frames, played one a frame; then each ride's
 * two clocks, the wait for the riders and the scene that starts on Entry. */
export function readPowsledMotions(rom) {
    const tables = figureTables(rom);
    const own = tables.map((t, i) => ({
        index: i,
        name: `motion ${i}`,
        address: t.at,
        offset: t.frames[0],
        view: rom.mainDataView,
        keys: t.frames.length,
        frames: t.frames.length,
        frameSize: t.parts * PART_BYTES,
        joints: t.parts,
        layout: 'powsled',
    }));
    const rides = rideScenes(rom).flatMap((r, k) => [
        { clock: 'waiting', phase: 'the wait, t & 1', address: r.waiting, frames: 2, name: `${r.name} · waiting` },
        { clock: 'scene', phase: 'after Entry, t from 0', address: r.scene, frames: SCENE_FRAMES, name: `${r.name} · after Entry` },
    ].map((c, n) => ({
        ...c,
        index: tables.length + k * 2 + n,
        ride: k,
        offset: c.address,
        keys: c.frames,
        joints: r.groups.reduce((s, g) => s + g.table.parts, 1),
        layout: 'powsled',
    })));
    return own.concat(rides);
}

export function powsledMotionList(rom, body, motions) {
    if (body.ride) {
        const fits = motions.filter((m) => m.ride !== undefined);
        const lead = fits.filter((m) => m.ride === body.ride.index);
        return { fits: lead, lead, label: 'Played by its scene' };
    }
    const fits = motions.filter((m) => m.index === body.index);
    return { fits, lead: fits, label: 'Played by its scene' };
}

/* A board 3x4 in the explorer's frame (z negated), as a 4x4. */
function explorerMatrix(m) {
    return [
        m[0], m[1], -m[2], 0,
        m[3], m[4], -m[5], 0,
        -m[6], -m[7], m[8], 0,
        m[9], m[10], -m[11], 1,
    ];
}

/** Every part's matrix on one frame, in the explorer's frame (z negated). */
export function posePowsledBody(rom, body, motion, frame) {
    if (body.ride) return poseRide(rom, body, motion, frame);
    const dv = rom.mainDataView;
    const t = figureTables(rom)[body.index];
    const f = motion?.index === body.index ? Math.max(1, Math.min(frame, t.frames.length)) - 1 : 0;
    const origins = [];
    const matrices = body.parts.map((_, j) => {
        const m = partMatrix(dv, t.frames[f] + j * PART_BYTES);
        origins.push([m[9], m[10], -m[11]]);
        return explorerMatrix(m);
    });
    /* Its own draws, as model 0 is a part here (the sled's first). */
    return { matrices, origins, draws: body.parts.map((p) => (p.model == null ? [] : [p.model])) };
}

/*
 * The ride scenes (Animation tab). Mode 5 (0x32F40) is the ride's own screen
 * before the race: 0x33780 picks a task handler by the ride's number
 * (0x5293F0), which waits until Entry (0x529368 & 0x500) and then plays the
 * scene, its clock at +0xC0 counting a frame from 0 (the wait's wraps at
 * 0xE11). Both draw, under the camera, the woman, the two riders and the
 * crane, each with 0xE1D70 at a frame the clock picks; the crane through
 * 0xE1F30, which dresses the sled in the ride's colour.
 *
 * Rides 1 and 3 (0xE44B0, 0xE4BE0) use the camera 0xE2830 and the woman
 * 0x1DE968 at T(0.85, 0, 0) and riders 0x18E4C0 at none; rides 2 and 0
 * (0xE4820, 0xE4F50) the camera 0xE2E00, the woman 0x3FF34 turned 0x7000
 * about Y (copro op 0x21) and then at T(1.4, 0, 0), the riders 0x13E018 at
 * T(0, 0, -0.1), and the crane slides the other way. The clocks:
 *
 *   woman   t up to 0x17C, then 0x138 + (t - 0x137) % 0x45 over and over
 *   riders  t up to 0x86, then 0x86; not drawn past 0xC7
 *   crane   0 up to 0x86, then t - 0x87 (the lift) up to 0xC7, then 64
 *   slide   none up to 0xDB, then X (t - 0xDC) / 10 up to 0x18F, then 18
 *           (0xE2510; 0xE2670 the negative)
 *
 * The wait draws the woman and the crane at frame 0 and the riders at
 * t & 1, which is their bob.
 */
const SCENE_FRAMES = 0x190 + 0x45;

/* The colour piece 0xE1F30 draws for crane part 2 at T(0, -0.32, -4.1)
 * under the part, a colour each. */
const PIECES = [
    [0x30d62, 0x30ea6, 0x8459cb],
    [0x30aaa, 0x30bee, 0x845625],
    [0x30c06, 0x30d4a, 0x8457f8],
    [0x30ebe, 0x31002, 0x845b9e],
];
const PIECE_AT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -0.32, -4.1];
/* What crane part 2 draws instead of its own model: the sled's body in the
 * colour, the black and ride 0 with {0x9C0C, 0x9D44, 0x81166F} over it. */
const SLED_BODY = [
    [[0x36372, 0x36876, 0x84d714], [0x9c0c, 0x9d44, 0x81166f]],
    null,
    [[0x35e16, 0x3631a, 0x84d05f], [0x9c0c, 0x9d44, 0x81166f]],
    [[0x368ce, 0x36dd2, 0x84ddc9]],
];

const rideCache = new WeakMap();
function rideScenes(rom) {
    if (rideCache.has(rom)) return rideCache.get(rom);
    const tables = figureTables(rom);
    const table = (at) => tables.find((t) => t.at === at);
    const translate = (x, y, z) => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
    /* Op 0x21 as MAME's draws have it, the other way from the Copro
     * class's (whose one use, a spinning piece on the course, is unchecked). */
    const turnY = (w) => {
        const a = ((w << 16) >> 16) * ANGLE_RAD, c = Math.cos(a), s = Math.sin(a);
        return [c, 0, s, 0, 1, 0, -s, 0, c, 0, 0, 0];
    };
    const LAYOUTS = {
        a: [
            { at: 0x1de968, base: translate(0.85, 0, 0) },
            { at: 0x18e4c0, base: IDENTITY },
            { at: 0x4770, base: IDENTITY },
        ],
        b: [
            { at: 0x3ff34, base: compose(turnY(0x7000), translate(1.4, 0, 0)) },
            { at: 0x13e018, base: translate(0, 0, -0.1) },
            { at: 0x4770, base: IDENTITY },
        ],
    };
    const rides = (rom.game.rig.rides ?? []).map((r, index) => {
        let first = 0;
        const groups = LAYOUTS[r.layout].map((g) => {
            const out = { ...g, table: table(g.at), first };
            first += out.table.parts;
            return out;
        });
        return { ...r, index, colour: r.ride, slide: r.layout === 'a' ? 1 : -1, groups };
    });
    rideCache.set(rom, rides);
    return rides;
}

/* The frame each figure shows at the clock, and whether the riders are drawn. */
function rideClock(motion, frame) {
    const n = motion?.frames ?? 2;
    const t = Math.max(1, Math.min(frame, n)) - 1;
    if (motion?.clock !== 'scene') return { t, woman: 0, riders: t & 1, crane: 0, slide: 0 };
    return {
        t,
        woman: t <= 0x17c ? t : 0x138 + (t - 0x137) % 0x45,
        riders: t <= 0xc7 ? Math.min(t, 0x86) : null,
        crane: t <= 0x86 ? 0 : t <= 0xc7 ? t - 0x87 : 64,
        slide: t <= 0xdb ? 0 : t <= 0x18f ? (t - 0xdc) / 10 : 18,
    };
}

/** A ride's scene at a clock, under its camera (board 3x4s, z negated). */
export function rideMatrices(rom, body, motion, frame) {
    const dv = rom.mainDataView;
    const model = tripleModels(rom);
    const r = body.ride, c = r.colour;
    const clock = rideClock(motion?.ride === r.index ? motion : null, frame);
    const boards = [], draws = [], words = [];
    r.groups.forEach((g, n) => {
        const f = [clock.woman, clock.riders, clock.crane][n];
        const base = n === 2 ? compose([1, 0, 0, 0, 1, 0, 0, 0, 1, r.slide * clock.slide, 0, 0], g.base) : g.base;
        for (let j = 0; j < g.table.parts; j++) {
            const at = g.table.frames[Math.min(f ?? 0, g.table.frames.length - 1)] + j * PART_BYTES;
            boards.push(compose(base, partMatrix(dv, at)));
            let w = [[0, 1, 2].map((k) => dv.getUint32(at + k * 4, true))];
            if (f === null) w = [];
            else if (n === 2 && j === 2 && SLED_BODY[c]) w = SLED_BODY[c];
            else if (n === 2 && j >= 4 && j <= 11 && c !== 1) w = [];
            else if (n === 2 && j === 0 && (c === 0 || c === 2)) w = [];
            words.push(w);
            draws.push(w.map(model).filter((m) => m != null));
        }
    });
    const sled = boards[r.groups[2].first + 2];
    boards.push(compose(sled, PIECE_AT));
    words.push([PIECES[c]]);
    draws.push([model(PIECES[c])].filter((m) => m != null));
    return { boards, draws, words, clock };
}

function poseRide(rom, body, motion, frame) {
    const { boards, draws } = rideMatrices(rom, body, motion, frame);
    return {
        matrices: boards.map(explorerMatrix),
        origins: boards.map((m) => [m[9], m[10], -m[11]]),
        draws,
    };
}
