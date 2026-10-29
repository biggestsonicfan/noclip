/*
 * skytargt.js — Sky Target's stages, read from the stage records.
 *
 * A stage is a 24-byte record at 0xF6570 + 24 * s, s the number in RAM at
 * 0x5290C0: +0 the object list, +4 a height every object stands on (0.0 in
 * all of them), +8 the texture bank, +0xC the colour row list, +0x10 the
 * face palette and +0x14 the row-21 list (games.js's sets read the same
 * table from +8). 0x31220 picks s off the route table at 0xE67B0, nine words
 * a route, by the route at 0x5245D4 and the step at 0x5245C0: step 0 is the
 * briefing (EXPLAIN), then stages 1 to 7; the four routes share stages 1, 2,
 * 4 and 7 and part at 3, 5 and 6. The debug stage
 * select's 0x79744 names each record out of 0xEDD70, ten bytes a name
 * (UMI, TOSHI, HOKKAIDO, ...), and those are the names given here.
 *
 * The game draws three things a frame round the camera (the struct at
 * 0x528780: +0x44/+0x48/+0x4C its place, +0x2C/+0x30/+0x34 its turns):
 *
 * - the object grid. 0xD1D10 (or 0xD1E30 a block a frame) walks the object
 *   list, 12 bytes a block {A, B, P} until P is 0; P is {rows, columns,
 *   offsets, limits, +0x20 count} and then count nodes of 20 bytes from
 *   P + 0x24: int x, y, z, +0x0C a model list, +0x10 a word for the frame's
 *   hit list. 0xD24B0 files each node in the 256-unit cell (x >> 8) + A,
 *   (z >> 8) + B; 0xD2790 draws each filed node at its cell's corner, at the
 *   node's y. A model list is {count, then 20 bytes an entry: x, y, z floats
 *   off its parent, the model, a child list or 0}, which 0xD29F0 walks down
 *   with the offsets added up: the copro turns the point (op 0x1A) and the
 *   geometrizer takes it as a translation (0x0C) with no turn of its own. A
 *   model nearer than 1000 is table entry 0x2DE3D00 + model * 16, a farther
 *   one the next entry (0xD2AC0), so the model given is the near one.
 * - the ground. 0xD2B90 draws the grid whose header is the word at
 *   0xF6770 + 4 * s: {columns, rows, x, z, y, then a model a cell}, cells
 *   1024 across, from (x, z). Stages 4 and 12 raise it by 390. Model 0 is
 *   empty, which is how a cell with nothing in it is drawn. 0xD34A0 draws a
 *   coarser grid out of 0xF67D0 + 4 * s past 3072, the far ring of the same
 *   ground, which is not drawn here.
 * - the sky: 0x31AF0 turns by the camera and nothing else and draws the
 *   model at 0xE5E80 + 4 * s, one below the eye; stages 0 and 1 first lay
 *   0x815 fifty below it. Stage 14 draws its sky from 0xE5F50, one of seven
 *   a frame (lightning), and stage 3 a snowfall from 0xE5ED0 over it.
 *
 * Everything is in one space, so the stage is the walk's own places, with
 * the cells along the flight split into views of 8192 (the game never draws
 * past 1800 ahead), since a whole stage is up to 33000 draws.
 */
import { gameLighting, stageLight } from './stages.js';

const RECORDS = 0xf6570;
const STRIDE = 24;
const GROUND = 0xf6770;
const SKY = 0xe5e80;
const SKY_STORM = 0xe5f50;
const ROUTES = 0xe67b0;
const NAMES = 0xedd70;
/* Two light angles a stage, read by 0x86A68 (and 0x8B480) into the struct
 * the camera's +0xA8 points at; 0x89C40 copies them to the camera's
 * +0x68/+0x6C and the frame's function 0xA sends the vector they make. */
const LIGHTS = 0xe6970;
/* The steps a route has, and the routes. The ninth word repeats the eighth,
 * the last stage. */
const STEPS = 8;
const ROUTE_COUNT = 4;
/* The attract mode's stage, set by 0x17F18: the first stage's scenery with
 * colours of its own. */
const ATTRACT = 9;
const CELL = 256;
const GROUND_CELL = 1024;
/* How much of the flight a view holds. */
const SECTION = 8192;

/* A word anywhere the program reads one: its own ROM, the data ROM at
 * 0x2000000, or the data ROM's last megabyte through the 0x6400000 mirror. */
function reader(rom) {
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const off = (a) => (a >= 0x6000000 ? 0x1000000 + (a & 0xfffff) : a - 0x2000000);
    const u32 = (a) => (a < 0x2000000 ? cv.getUint32(a, true) : dv.getUint32(off(a), true));
    return {
        u32,
        i32: (a) => u32(a) | 0,
        f32: (a) => (a < 0x2000000 ? cv.getFloat32(a, true) : dv.getFloat32(off(a), true)),
    };
}

/* The record's name out of the stage select's table. */
function stageName(rom, s) {
    let name = '';
    for (let i = 0; i < 10; i++) {
        const c = rom.mainCpuView.getUint8(NAMES + s * 10 + i);
        if (!c) break;
        name += String.fromCharCode(c);
    }
    return name.trim();
}

/* Which step of which routes plays each record (0x31220). */
function routeSteps(rom) {
    const r = reader(rom);
    const at = new Map();
    for (let route = 0; route < ROUTE_COUNT; route++) {
        for (let step = 0; step < STEPS; step++) {
            const s = r.u32(ROUTES + (route * 9 + step) * 4);
            if (!at.has(s)) at.set(s, { step, routes: [] });
            at.get(s).routes.push(route);
        }
    }
    return at;
}

/* A model list and its children, the offsets added up (0xD29F0). */
function walkModels(r, list, x, y, z, out, depth = 0) {
    if (!list || depth > 16) return;
    const n = r.u32(list);
    for (let i = 0; i < n; i++) {
        const e = list + 4 + i * 20;
        const px = x + r.f32(e), py = y + r.f32(e + 4), pz = z + r.f32(e + 8);
        out.push({ model: r.u32(e + 12), pos: [px, py, pz] });
        walkModels(r, r.u32(e + 16), px, py, pz, out, depth + 1);
    }
}

/* The object grid: every node of every block, at its cell's corner
 * (0xD24B0, 0xD2790). */
function objectDraws(r, s) {
    const out = [];
    const list = r.u32(RECORDS + s * STRIDE);
    if (!list) return out;
    const base = r.f32(RECORDS + s * STRIDE + 4);
    for (let e = list; r.u32(e + 8); e += 12) {
        const a = r.i32(e), b = r.i32(e + 4), p = r.u32(e + 8);
        const count = r.u32(p + 0x20);
        for (let k = 0; k < count; k++) {
            const q = p + 0x24 + k * 20;
            /* shri rounds toward zero, which Math.trunc does too. */
            const x = (Math.trunc(r.i32(q) / CELL) + a) * CELL;
            const z = (Math.trunc(r.i32(q + 8) / CELL) + b) * CELL;
            walkModels(r, r.u32(q + 12), x, r.i32(q + 4) + base, z, out);
        }
    }
    return out;
}

/* The ground grid (0xD2B90), less its empty cells. */
function groundDraws(r, s) {
    const out = [];
    const h = r.u32(GROUND + s * 4);
    if (!h) return out;
    const cols = r.u32(h), rows = r.u32(h + 4);
    const x0 = r.f32(h + 8), z0 = r.f32(h + 12);
    const y = r.f32(h + 16) + (s === 4 || s === 12 ? 390 : 0);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const model = r.u32(h + 0x14 + (row * cols + col) * 4);
            if (model) out.push({ model, pos: [x0 + col * GROUND_CELL, y, z0 + row * GROUND_CELL] });
        }
    }
    return out;
}

/* The sky, carried along with the camera and turned with it (0x31AF0). */
function skyObjects(r, s) {
    const at = (model, y) => ({ model, layer: 'sky', layered: false, ops: [['ce'], ['t', [0, y, 0]]] });
    const sky = [];
    if (s === 0 || s === 1) sky.push(at(0x815, -50));
    sky.push(at(s === 14 ? r.u32(SKY_STORM) : r.u32(SKY + s * 4), -1));
    return sky;
}

function readStage(rom, lit, s, slot, name) {
    const r = reader(rom);
    const pieces = objectDraws(r, s).map((d) => ({ ...d, layer: 'scenery' }))
        .concat(groundDraws(r, s).map((d) => ({ ...d, layer: 'ground' })));
    /* The views: the flight cut every SECTION along z, from the stage's start. */
    const z0 = Math.min(...pieces.map((d) => d.pos[2]));
    const draws = pieces.map((d) => ({
        model: d.model, pos: d.pos, set: s, layer: d.layer,
        zones: new Set([Math.floor((d.pos[2] - z0) / SECTION)]),
    }));
    const count = draws.reduce((n, d) => Math.max(n, ...d.zones), 0) + 1;
    const zones = Array.from({ length: count }, (_, i) => {
        const n = draws.filter((d) => d.zones.has(i)).length;
        const from = Math.round(z0 + i * SECTION);
        return { zone: i, set: s, label: `${from} to ${from + SECTION} · ${n} pieces` };
    }).filter((z) => !z.label.endsWith(' 0 pieces'));
    return {
        slot,
        placements: true,
        mixedSets: false,
        num: slot + 1,
        name,
        chapter: 0,
        draws,
        objects: skyObjects(r, s),
        sky: null,
        panorama: null,
        zones,
        views: [...zones.map((z) => [`zone:${z.zone}`, z.label]), ['all', 'The whole stage']],
        view: zones.length ? `zone:${zones[0].zone}` : 'all',
        union: 'all',
        texSets: [s],
        texSet: [s, s],
        tint: [1, 1, 1],
        bright: 1,
        light: stageLight(1, r.u32(LIGHTS + s * 8), r.u32(LIGHTS + s * 8 + 4)),
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['record', `${s} (0x${(RECORDS + s * STRIDE).toString(16).toUpperCase()})`],
            ['objects', draws.filter((d) => d.layer === 'scenery').length],
            ['ground cells', draws.filter((d) => d.layer === 'ground').length]],
    };
}

/**
 * Sky Target's stages, in the order the routes play them, and the attract
 * mode's last.
 */
export function readSkytargtStages(rom) {
    const lit = gameLighting(rom);
    const steps = routeSteps(rom);
    const order = [...steps.entries()]
        .sort((a, b) => a[1].step - b[1].step || a[1].routes[0] - b[1].routes[0]);
    const stages = order.map(([s, { step, routes }], slot) => {
        const which = routes.length === ROUTE_COUNT ? ''
            : ` (route${routes.length > 1 ? 's' : ''} ${routes.map((x) => x + 1).join(', ')})`;
        /* Step 0 is the briefing flight, and the steps after it are the
         * STAGE 1 to STAGE 7 of the strings at 0x82F68. */
        const label = step ? `Stage ${step}` : 'Briefing';
        return readStage(rom, lit, s, slot, `${label} · ${stageName(rom, s)}${which}`);
    });
    stages.push(readStage(rom, lit, ATTRACT, stages.length, `Attract · ${stageName(rom, ATTRACT)}`));
    return stages;
}
