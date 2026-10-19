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
