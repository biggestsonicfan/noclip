/*
 * Wave Runner (MAME `waverunr`) and Sega Water Ski (`segawski`), Model 2C.
 * Both run one program, Water Ski's moved about 0x1A960 on; the addresses in
 * these comments are Wave Runner's, and the profiles (`rom.game.waverunr`)
 * carry each game's own. See README and TECHNICAL.md.
 *
 * A scene is three things the game names together: a texture bank onto sheet
 * 1 (0x34BF0 with g1 = 1), a {count, colours} block onto the face palette from
 * entry 500 (0x36360) and a colour table (0x35060, or 0x97500 a row a frame).
 * The boot sets up the first course's three (0x34DC8, 0xB5CC, 0x344E8). A
 * course takes its three from the tables at 0x973E0 (palette), 0x973F0
 * (bank) and 0x35040 (colours), indexed by the course in work RAM 0x511F60
 * (0x97410, 0x97460, 0x97470); two more scenes name theirs in the code
 * (0x4AF60 with 0x4AFF4, 0x2CBE0 with 0x2CD2C). A texture set here is one
 * scene, and the palette and colour tables follow it.
 */
import { MAIN_DATA_BASE } from './romset.js';
import { uploadRawBank } from './texture.js';
import { SHEET_BYTES, SHEET_H } from './atlas.js';
import { runRoutines, CXLAT_AT, CXLAT_BYTES } from './skisuprg.js';
import { I960 } from './i960.js';
import { Copro, Geo, boardToOps } from './doa.js';
import { gameLighting } from './stages.js';
import { readModelEntry } from './romset.js';

/* A data address as the program names it: the program ROM below its end, the
 * data ROM at 0x2000000, or its second half through the XTRA window, 0x6000000
 * being data 0x1000000 (Water Ski's model table, 0x6291D60, is 0x1291D60). */
function bytesAt(rom, a) {
    if (a < rom.maincpu.length) return [rom.maincpu, a];
    const o = a >= 0x6000000 ? a - 0x6000000 + 0x1000000 : a - MAIN_DATA_BASE;
    return [rom.mainData, o];
}

/** The scenes, as {name, bank, palette, colors, patches}. */
export function waverunrScenes(rom) {
    if (rom.waverunrScenes) return rom.waverunrScenes;
    const W = rom.game.waverunr;
    const cv = rom.mainCpuView;
    const out = [];
    const C = W.courses;
    for (let c = 0; c < C.count; c++) {
        out.push({
            name: C.names?.[c] ?? `course ${c + 1}`,
            bank: cv.getUint32(C.banks + c * 4, true),
            palette: cv.getUint32(C.palettes + c * 4, true),
            colors: C.colorTable ? cv.getUint32(C.colorTable + C.colorIndex[c] * 4, true) : C.colors[c],
            patches: C.patches,
        });
    }
    for (const s of W.scenes ?? []) out.push({ ...s });
    return (rom.waverunrScenes = out);
}

function scene(rom, set) {
    const scenes = waverunrScenes(rom);
    return scenes[set] ?? scenes[rom.game.texture.defaultSet];
}

/*
 * The sheets. The boot (0x34DC8) puts bank 0x2000000 on sheet 0 and a scene
 * puts its bank on sheet 1, both with 0x34BF0: House of the Dead's upload, the
 * bank's first half straight onto its sheet and the mip levels of the second
 * half dealt between the sheets by the rectangle copy 0x345C0
 * (uploadRawBank). After a scene's bank, 0x3F570 fills the 16 x 8 halfwords at
 * (0x1F0, 0x1F8) of both sheets' mip half with 0xBBBB, and a course pastes
 * eight blocks of 64 halfwords square onto sheet 1 (0x4AAC0, each 0x2000
 * bytes from 0x2848B60 on, through 0x3EC50: the same places as House of the
 * Dead's, the source packed 64 rows of 128 bytes).
 */
const PATCH_AT = [[0, 0], [64, 0], [0, 64], [64, 64], [0, 128], [64, 128], [0, 192], [64, 192]];

export function buildWaverunrTexram(rom, texSets) {
    const W = rom.game.waverunr;
    const md = rom.mainData;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    uploadRawBank(md, W.bootBank - MAIN_DATA_BASE, tex, false);
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < rom.game.texture.sets);
    let pages = 1;
    if (sets.length) {
        const sc = scene(rom, sets[sets.length - 1]);
        const bank = sc.bank - MAIN_DATA_BASE;
        if (bank >= 0 && bank + SHEET_BYTES <= md.length) {
            uploadRawBank(md, bank, tex, true);
            pages++;
        }
        for (const sheet of [0, SHEET_BYTES]) {
            for (let y = 0x1f8; y <= 0x1ff; y++) {
                for (let x = 0x1f0; x <= 0x1ff; x++) {
                    const at = sheet + 0x80000 + ((y << 9) + x) * 2;
                    tex[at] = W.fill & 0xff;
                    tex[at + 1] = W.fill >> 8;
                }
            }
        }
        if (sc.patches) {
            const [src, o] = bytesAt(rom, sc.patches);
            PATCH_AT.forEach(([x, y], i) => {
                for (let r = 0; r < 64; r++) {
                    const s = o + i * 0x2000 + r * 128;
                    if (s + 128 <= src.length) tex.set(src.subarray(s, s + 128), SHEET_BYTES + (((y + r) << 9) + x) * 2);
                }
            });
        }
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * The face palette: 0x351C0 writes the block at 0x10080 down from entry 1023
 * (once, at the boot), then every scene writes the {count, colours} blocks at
 * 0x2858B60 from entry 0 and 0x84350 from 300 and its own from 500
 * (0x36360, which stops at entry 1023). Water Ski has the top block's routine
 * (0x4FB20) but never calls it, and no block at 300.
 */
export function waverunrPalette(rom, set) {
    const W = rom.game.waverunr;
    const out = new Int32Array(1024).fill(-1);
    if (W.palette.top) {
        const [b, o] = bytesAt(rom, W.palette.top);
        const n = b[o] | (b[o + 1] << 8);
        for (let i = 0; i < n && i < 1024; i++) out[1023 - i] = b[o + 2 + i * 2] | (b[o + 3 + i * 2] << 8);
    }
    const block = (at, first) => {
        const [b, o] = bytesAt(rom, at);
        if (o < 0 || o + 2 > b.length) return;
        const n = b[o] | (b[o + 1] << 8);
        for (let i = 0; i < n && first + i < 1024; i++) out[first + i] = b[o + 2 + i * 2] | (b[o + 3 + i * 2] << 8);
    };
    for (const [at, first] of W.palette.blocks) block(at, first);
    block(scene(rom, set).palette, W.palette.first);
    return out;
}

/*
 * Colorxlat: the ramps by running the program's 0x34EC0 with js/i960.js
 * (floating point, square roots; every entry of every row), then the scene's
 * table as 0x35060 lays it: a row count byte, then per row 64 {r, g, b} bytes,
 * the rows going to 1, 3, 5... of the three channels (0x1810200 on, 0x400
 * apart). The grey switch at 0x513334 is left off, as in MAME's attract.
 * Water Ski's writer (0x90A90, a row a frame) takes the rows that come with
 * four, three and two rows left from elsewhere: pointer table 0xA1ED0, three
 * to a selector in work RAM 0x56E090 (`rowSwap`; 0 in the attract, which is
 * the one taken here).
 */
export function buildWaverunrColorxlat(rom, colorSet) {
    const W = rom.game.waverunr;
    const table = scene(rom, colorSet).colors;
    rom.waverunrColors ??= new Map();
    const have = rom.waverunrColors.get(table);
    if (have) return have.slice();
    rom.waverunrRamps ??= runRoutines(rom, [[W.ramps, []]], rom.game.name).pal.slice(CXLAT_AT, CXLAT_AT + CXLAT_BYTES);
    const out = rom.waverunrRamps.slice();
    const [b, o] = bytesAt(rom, table);
    const rows = b[o];
    const swap = W.rowSwap;
    for (let r = 0; r < rows && r < 16; r++) {
        let [src, p] = [b, o + 1 + r * 192];
        const left = rows - r;
        if (swap && left >= 2 && left <= 4) {
            [src, p] = bytesAt(rom, rom.mainCpuView.getUint32(swap.table + (swap.select * 3 + 4 - left) * 4, true));
        }
        for (let i = 0; i < 64; i++, p += 3) {
            for (let ch = 0; ch < 3; ch++) {
                const at = ch * 0x4000 + (1 + 2 * r) * 0x200 + i * 2;
                out[at] = src[p + ch];
                out[at + 1] = 0;
            }
        }
    }
    rom.waverunrColors.set(table, out);
    return out.slice();
}

/*
 * The Stages tab: a course as the game lays it out.
 *
 * The water and the land are a grid of world-space models, drawn under the
 * camera with no matrix of their own (0x49A80, called from 0xA38B0 with
 * `ld 0x285e110[course*4]`). A grid record is {cell width, cell depth (both
 * 64.0), columns, rows, first column, last, first row, last, cell list}; the
 * list is a word a cell, row by row, the model, or 0 for open water. The
 * fourth course has the third's grid.
 *
 * The things standing on it (windmills, the check gates, the palms, the
 * boats) are tasks the course start makes (0xBF840 calls 0xBF7B0 with the
 * course): two lists a course of 28-byte records {x, y, z, word, yaw, word,
 * maker}, ended by a maker of 0, which 0xBFAA0 walks, calling each maker for
 * a task and copying the record into it (0xBFA60: x, y and z to +0x24, the
 * yaw, 0x10000 to the turn, to +0x34). A maker is `lda handler, g0; call
 * 0x20F230`; the handler is the task's draw. Here each handler runs once on
 * js/i960.js, as its first frame, against the copro and geometrizer of
 * js/doa.js with no camera, so what it draws comes out where it stands in the
 * world: push, translate, turn about Y, out to the geometrizer, then the
 * model through 0x210200 (the copy of 0xC0200 that tests it against the view
 * first, answered here as a draw) or sent straight.
 *
 * 0x60F0 makes the course's backdrop tasks the same way: the first course's
 * clouds (0x6190, models from 2098, drawn at the origin). The sea is one
 * 700-wide model the race keeps under the camera (0x28520, model 1907); it is
 * laid here in tiles over the grid. Checked against MAME's attract (the
 * first course): its geometrizer matrices, taken back through the camera's
 * (the grid's), put the gate, the windmill and the boat exactly at their
 * records, and turned by the yaw as js/doa.js's turn about Y does.
 */
const RAM_BASE = 0x500000, RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000, XTRA_BASE = 0x6000000;
const COPRO_CMD = 0x880000, COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const GEO_CMD = 0x800000, GEO_PORT = 0x804000, GEO_END = 0x808000;
const TASKS = 0x5c0000;

function stageMachine(rom) {
    const S = rom.game.waverunr.stages;
    const ram = new Uint8Array(RAM_SIZE), rv = new DataView(ram.buffer);
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const unknown = new Set();
    const copro = new Copro(unknown);
    const geo = new Geo(copro, null);
    const draws = [];
    /* A model as the words of its table entry: the one the routine sent. */
    const byWords = new Map();
    for (let i = rom.game.modelTable.count - 1; i >= 0; i--) {
        const e = readModelEntry(rom, i);
        byWords.set(`${e.uvPtr}/${e.matPtr}/${e.meshPtr}`, i);
    }
    const t = rom.game.modelTable;
    const entry = (i) => {
        const [b, o] = t.source === 'maincpu' ? [cv, t.offset + i * 16] : [dv, t.offset + i * 16];
        return [0, 1, 2].map((k) => b.getUint32(o + k * 4, true));
    };
    geo.object = function object() {
        const [u, m, o] = this.words;
        const model = byWords.get(`${u}/${m}/${o}`);
        if (model !== undefined) draws.push({ model, m: this.m.slice() });
    };
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE - 3;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) return cv.getUint32(a, true);
        if (inRam(a)) return rv.getUint32(a - RAM_BASE, true);
        if (S.code && a >= S.code.ram && a < S.code.ram + S.code.size) return cv.getUint32(a - S.code.ram + S.code.rom, true);
        if (a >= DATA_BASE && a - DATA_BASE < dv.byteLength - 3) return dv.getUint32(a - DATA_BASE, true);
        if (a >= XTRA_BASE && a - XTRA_BASE + 0x1000000 < dv.byteLength - 3) return dv.getUint32(a - XTRA_BASE + 0x1000000, true);
        if (a >= COPRO_PORT && a < COPRO_END) return copro.read();
        return 0;
    };
    const write32 = (a, v) => {
        if (inRam(a)) rv.setUint32(a - RAM_BASE, v, true);
        else if (a >= COPRO_PORT && a < COPRO_END) copro.data(v);
        else if (a >= COPRO_CMD && a < COPRO_PORT) copro.command((a >>> 4) & 0xff);
        else if (a >= GEO_PORT && a < GEO_END) geo.data(v);
        else if (a >= GEO_CMD && a < GEO_PORT) geo.command((a >>> 4) & 0x1f);
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
    /* The task makers (0x20F230, 0x20F350: handler in g0, size in g1) give
     * a fresh zeroed task, noted to run after; the culled draw sends the
     * model in g0 under the matrix the copro holds. */
    let next = TASKS;
    const made = [];
    const make = (c) => {
        const task = next;
        next += (c.r[17] + 15) & ~15;
        made.push({ handler: c.r[16], task });
        c.r[16] = task;
    };
    for (const a of S.makers) cpu.hooks.set(a, make);
    cpu.hooks.set(S.draw, (c) => {
        if (c.r[16] < t.count) draws.push({ model: c.r[16], m: copro.m.slice() });
    });
    return { cpu, rv, copro, draws, made, unknown, entry };
}

/* Run what a maker made, a frame each, and what those make in turn. */
function runMade(M) {
    for (let i = 0; i < M.made.length && i < 256; i++) {
        const { handler, task } = M.made[i];
        M.copro.m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        M.copro.stack = [];
        M.cpu.call(handler, [task], { maxSteps: 200_000 });
    }
}

export function courseScenery(rom, c) {
    const S = rom.game.waverunr.stages;
    const M = stageMachine(rom);
    const cv = rom.mainCpuView;
    M.rv.setUint32(S.course - RAM_BASE, c, true);
    /* The backdrop: 0x60F0 with a task of its own. */
    if (S.backdrop) M.cpu.call(S.backdrop, [TASKS - 0x100], { maxSteps: 100_000 });
    runMade(M);
    const backdrop = M.draws.splice(0);
    const objects = [];
    for (const list of S.objects[c] ?? []) {
        for (let r = list; cv.getUint32(r + 0x18, true); r += 28) {
            const from = M.made.length;
            M.cpu.call(cv.getUint32(r + 0x18, true), [], { maxSteps: 100_000 });
            const mine = M.made.slice(from);
            for (const { task } of mine) {
                for (let k = 0; k < 6; k++) M.rv.setUint32(task - RAM_BASE + 0x24 + k * 4, cv.getUint32(r + k * 4, true), true);
            }
            M.made.length = from;
            M.made.push(...mine);
            const at = M.draws.length;
            const was = M.made.length;
            for (let i = from; i < M.made.length; i++) {
                const { handler, task } = M.made[i];
                M.copro.m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
                M.copro.stack = [];
                M.cpu.call(handler, [task], { maxSteps: 200_000 });
            }
            M.made.length = was;
            objects.push({ record: r, draws: M.draws.slice(at) });
        }
    }
    return { backdrop, objects, unknown: [...M.unknown] };
}

/* A course's grid, or its grids: Water Ski draws two layers a course, from
 * two tables (0x56580). */
function courseGrid(rom, c, table) {
    const word = (a) => { const [b, o] = bytesAt(rom, a); return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); };
    const rec = word(table + c * 4) >>> 0;
    if (rec === 0xffffffff || !rec) return null;
    const [cols, rows, x0, x1, z0, z1] = [8, 12, 16, 20, 24, 28].map((k) => word(rec + k));
    const list = word(rec + 32) >>> 0;
    const fl = (a) => { const [b, o] = bytesAt(rom, a); return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true); };
    const models = [];
    for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
            const m = word(list + ((z - z0) * cols + (x - x0)) * 4);
            if (m > 0 && m < rom.game.modelTable.count) models.push(m);
        }
    }
    return { rec, cols, rows, x0, x1, z0, z1, cell: [fl(rec), fl(rec + 4)], models };
}

/* The game's light and material slots are not read yet: every face at full
 * ambient, as the Models tab shows them. */
export const UNLIT = { light: [0, 1, 0], materials: Array.from({ length: 32 }, () => ({ diffuse: 0, ambient: 255 })) };

export function readWaverunrStages(rom) {
    const S = rom.game.waverunr.stages;
    const scenes = waverunrScenes(rom);
    const lit = gameLighting(rom) ?? UNLIT;
    const stages = [];
    for (let c = 0; c < S.count; c++) {
        const grids = [].concat(S.grids).map((t) => courseGrid(rom, c, t)).filter(Boolean);
        if (!grids.length) continue;
        const grid = grids[0];
        const run = courseScenery(rom, c);
        const draws = grids.flatMap((g) => g.models.map((model) => ({ model, pos: [0, 0, 0], set: c })));
        /* The sea, one model tiled over the grid, under everything. Cell 64
         * is the one east and south of the origin (the grid models' own
         * coordinates say so), rows running south: explorer z. */
        const [w, d] = grid.cell;
        const lo = [(grid.x0 - 64) * w, (grid.z0 - 64) * d], hi = [(grid.x1 - 63) * w, (grid.z1 - 63) * d];
        for (let z = lo[1] + S.seaSize / 2; S.sea && z - S.seaSize / 2 < hi[1]; z += S.seaSize) {
            for (let x = lo[0] + S.seaSize / 2; x - S.seaSize / 2 < hi[0]; x += S.seaSize) {
                draws.unshift({ model: S.sea, pos: [x, 0, z], set: c, layer: 'sky', layered: false });
            }
        }
        for (const p of run.backdrop) draws.push({ model: p.model, pos: [p.m[9], p.m[10], -p.m[11]], set: c, ops: boardToOps(p.m), layered: false });
        let pieces = 0;
        for (const o of run.objects) {
            for (const p of o.draws) {
                draws.push({ model: p.model, pos: [p.m[9], p.m[10], -p.m[11]], set: c, ops: boardToOps(p.m) });
                pieces++;
            }
        }
        stages.push({
            slot: stages.length,
            placements: true,
            mixedSets: false,
            num: c,
            name: scenes[c]?.name ?? `Course ${c + 1}`,
            chapter: c,
            draws,
            objects: [],
            sky: null,
            panorama: null,
            views: null,
            texSets: [c],
            texSet: [c, c],
            tint: [1, 1, 1],
            bright: 1,
            light: lit.light,
            materials: lit.materials,
            colorCycles: [],
            flags: 0,
            floorSize: 0,
            bgColor555: 0,
            meta: [['course', c + 1], ['grid', grids.map((g) => `0x${g.rec.toString(16)}, ${g.cols} x ${g.rows}`).join('; ')],
                ['ground models', grids.reduce((n, g) => n + g.models.length, 0)], ['objects', run.objects.length], ['object pieces', pieces],
                ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
        });
    }
    return stages;
}

/*
 * Which set a model is drawn under (programTextureSets in js/texture.js). The
 * boot's bank is on sheet 0 and no course replaces it (0x34DC8); a course puts
 * its own on sheet 1. A model on sheet 0 alone is the boot's; one on sheet 1
 * is the first course whose stage (above) draws it. The rest are left to the
 * picker.
 */
export function waverunrModelSets(rom, index, decoded) {
    if (!decoded) return null;
    let sheet0 = false, sheet1 = false;
    for (let i = 0; i < decoded.tiles.length; i += 4) {
        if (!decoded.tiles[i + 2]) continue;
        if (decoded.tiles[i + 1] >= SHEET_H) sheet1 = true; else sheet0 = true;
    }
    if (!sheet0 && !sheet1) return { sets: [], how: 'untextured' };
    if (!sheet1) return { sets: [], how: 'boot' };
    if (!rom.game.waverunr.stages) return null;
    if (!rom.waverunrCourseModels) {
        const first = new Map();
        for (const s of readWaverunrStages(rom)) {
            for (const d of s.draws) if (!first.has(d.model)) first.set(d.model, s.num);
        }
        rom.waverunrCourseModels = first;
    }
    const course = rom.waverunrCourseModels.get(index);
    return course != null ? { sets: [course], how: 'course' } : null;
}
