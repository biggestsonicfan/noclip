/*
 * Last Bronx (js/games.js `lastbronxBuild`): what its own stage code draws,
 * run on js/i960.js the way js/doa.js runs Dead or Alive's.
 *
 * The stage task (0x71070) draws the stage with 0x71AC0, then the shadows,
 * the ring walls (0x72640), the fighters and the effects. 0x71AC0 reads the
 * stage number (0x57DEC0) and walks that stage's descriptor in the program
 * ROM (0x795E0, 32 bytes a stage: item list, item count, cull kind...). An
 * item is 12 bytes {type, value, pointer}:
 *   0  a model entry, drawn under the matrix the stage task set up;
 *   1  a placement list (0x72110): 24-byte records, the model entry pointer
 *      at +0x14, in world space, culled against the camera unless 0x5D2E60
 *      is 2, which keeps every one;
 *   3  an animated piece (0x71C68, which dispatches on the stage's object
 *      kind through 0x94190): a crane, a train, the airport's planes, each
 *      with its own matrix and state in RAM that each pass steps;
 *   2  the ring walls, four models at rest.
 * The camera (0x71DB0) is left out, so the matrix every piece goes out under
 * is the stage's own frame; the pieces' state is set up first by 0x941E0,
 * which the round start calls.
 *
 * The draw itself is the board's: geometrizer command 0x01 with the model
 * entry's four words (`ldq` from the table at 0x189B0 in the program ROM),
 * under the matrix the copro last handed out (copro 0x11, geo 0x0B). The copro
 * runs a program the i960 uploads (m2-hle2 PR #543); the commands the stage
 * code sends are Dead or Alive's numbers (js/doa.js Copro), with three of its
 * own: 0x0F a box cull (5 words in, one out, answered "in view"), 0x17 (2 in,
 * one out) and 0x6A (1 in).
 */
import { I960 } from './i960.js';
import { Copro, Geo, boardToOps } from './doa.js';
import { gameLighting } from './stages.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const RAM_BASE = 0x500000, RAM_SIZE = 0x100000;
const DATA_BASE = 0x2000000;
const COPRO_CMD = 0x880000, COPRO_PORT = 0x884000, COPRO_END = 0x888000;
const GEO_CMD = 0x800000, GEO_PORT = 0x804000, GEO_END = 0x808000;

const EXTRA = {
    0x0f: [5, (cp) => cp.outInt(1)],
    0x17: [2, (cp) => cp.outInt(0)],
    0x6a: [1, () => {}],
};

/* The model an object command names: the table entry its words were last read
 * from (the routines `ldq` an entry, or `ld` its words one by one, and send it
 * on), if the mesh it sends is that entry's. One frame in 21 Cross Street's
 * circling piece sends words that are no entry's (0, 0x30000000, 0x20000007,
 * 0xFFFFF8) after the street's own entry was read; naming that entry flashed
 * the street in at the piece's matrix (issue 214). */
function modelTracker(table, cv) {
    let last = null;
    return {
        noteRead(a) {
            if (a >= table.offset && a < table.offset + table.count * table.stride) last = Math.floor((a - table.offset) / table.stride);
        },
        lastIndex(w) {
            const i = last;
            last = null;
            if (i === null || cv.getUint32(table.offset + table.stride * i + 8, true) !== w[2]) return null;
            return { model: i };
        },
    };
}

/* The board as the stage code sees it: program ROM at 0, its data section
 * copied to RAM at 0x500000 as the boot does, the data ROMs at 0x2000000, and
 * the two ports. Anything else reads back what was last written to it. */
export function lastbrnxMachine(rom, { copro: extra = {} } = {}) {
    const L = rom.game.stageTable.lastbrnx;
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const ram = new Uint8Array(RAM_SIZE), rv = new DataView(ram.buffer);
    const D = rom.game.texture.raw.data;
    ram.set(new Uint8Array(cv.buffer, cv.byteOffset + D.rom, L.dataSize));
    const unknown = new Set();
    const copro = new Copro(unknown, { ...EXTRA, ...extra });
    const models = modelTracker(rom.game.modelTable, cv);
    const geo = new Geo(copro, models);
    const other = new Map();
    const inRam = (a) => a >= RAM_BASE && a < RAM_BASE + RAM_SIZE;
    const read32 = (a) => {
        if (a < cv.byteLength - 3) { models.noteRead(a); return cv.getUint32(a, true); }
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
    const lane = (a) => [a & ~3, (a & 3) * 8];
    /* A byte or halfword store to a port pushes the whole word (js/doa.js). */
    const isPort = (a) => (a >= COPRO_CMD && a < COPRO_END) || (a >= GEO_CMD && a < GEO_END);
    const writeLane = (a, v, mask) => {
        const [w, s] = lane(a);
        if (isPort(w)) write32(w, ((v & mask) << s) >>> 0);
        else write32(w, (read32(w) & ~(mask << s)) | ((v & mask) << s));
    };
    const bus = {
        other, read32, write32,
        read8: (a) => { const [w, s] = lane(a); return (read32(w) >>> s) & 0xff; },
        read16: (a) => { const [w, s] = lane(a); return (read32(w) >>> s) & 0xffff; },
        write8: (a, v) => { if (inRam(a)) ram[a - RAM_BASE] = v; else writeLane(a, v, 0xff); },
        write16: (a, v) => { if (inRam(a)) rv.setUint16(a - RAM_BASE, v, true); else writeLane(a, v, 0xffff); },
    };
    const cpu = new I960(bus);
    return { ram, rv, bus, unknown, copro, geo, cpu, L };
}

/*
 * One stage's routines set up and run once, that go on running: `step()` is
 * the next pass (the board's next frame), `rewind()` puts RAM back as the
 * first pass left it; `most` is the most pieces any pass drew.
 */
function stageRun(rom, n) {
    const M = lastbrnxMachine(rom);
    const { L, cpu, geo, ram, rv, bus } = M;
    ram[L.stageByte - RAM_BASE] = n;
    ram[L.cullAll - RAM_BASE] = 2;
    cpu.hooks.set(L.camera, () => {});
    cpu.call(L.init, [], { maxSteps: 5_000_000 });
    const run = { draws: [], done: true, most: 0, ram, rv };
    run.step = () => {
        geo.draws = [];
        run.done = cpu.call(L.draw, [], { maxSteps: 5_000_000 });
        const scenery = geo.draws;
        /* The walls go out under the stage task's matrix as the draw found
         * it, not as the draw leaves it. */
        geo.draws = [];
        M.copro.m = IDENTITY;
        M.copro.stack = [];
        cpu.call(L.walls, [], { maxSteps: 1_000_000 });
        run.walls = geo.draws;
        run.draws = scenery;
        run.most = Math.max(run.most, scenery.length);
        return scenery;
    };
    run.step();
    run.unknown = [...M.unknown];
    const saved = { ram: ram.slice(), other: new Map(bus.other), draws: run.draws };
    run.rewind = () => {
        ram.set(saved.ram);
        bus.other.clear();
        for (const [a, v] of saved.other) bus.other.set(a, v);
        run.draws = saved.draws;
    };
    return run;
}

/* The stage's name, from the table the round banner reads (0x2A190). */
function stageName(rom, n) {
    const L = rom.game.stageTable.lastbrnx;
    const D = rom.game.texture.raw.data;
    const cv = rom.mainCpuView;
    const ptr = cv.getUint32(D.rom + L.names - RAM_BASE + 4 * n, true);
    let at = ptr < RAM_BASE ? ptr : D.rom + ptr - RAM_BASE, s = '';
    for (let c; at < cv.byteLength && (c = cv.getUint8(at)) !== 0 && s.length < 40; at++) s += String.fromCharCode(c);
    return s.trim() || `Stage ${n}`;
}

/*
 * The face palette entries the stage cycles. The round start (0x17950) takes
 * the list for the stage's object kind (0x5042E0, the kinds past 8 taking 8's)
 * from 0x502B00: 12-byte records {entry, frames, colours} up to one of no
 * frames. An entry under 16 is face palette entry 8 + entry, stepped by
 * 0x17AA0's first loop, one at 16 or over the same, by its second; both step
 * every channel a frame, from the vblank (0x944), back to the first colour
 * after the last. The colour table is two halfwords a frame, the second the
 * one taken while 0x567140 is set, which nothing in a fight sets.
 */
export function lastbrnxPaletteCycles(rom, n) {
    const C = rom.game.stageTable.lastbrnx.cycles;
    const D = rom.game.texture.raw.data;
    const cv = rom.mainCpuView;
    const at = (a) => (a < RAM_BASE ? a : D.rom + a - RAM_BASE);
    const kind = Math.min(cv.getUint32(at(C.kinds + 4 * n), true), 8);
    const cycles = [];
    for (let p = cv.getUint32(at(C.lists + 4 * kind), true); cycles.length < 64; p += 12) {
        const frames = cv.getUint32(at(p + 4), true);
        if (!frames) break;
        const entry = cv.getUint32(at(p), true) + 8, t = at(cv.getUint32(at(p + 8), true));
        const colors = [];
        for (let f = 0; f < frames && t + 4 * f + 2 <= cv.byteLength; f++) colors.push(cv.getUint16(t + 4 * f, true) & 0x7fff);
        cycles.push({ entry, colors });
    }
    return cycles;
}

/*
 * The pieces that move go on moving in the viewer: a pass a frame from the
 * first, each piece the one its pass drew in its place in the list
 * (js/doa.js liveScenery). Going back in time rewinds.
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
            if (!p) return { model: d.model, ops: d.ops, hidden: true };
            return { model: p.model, ops: boardToOps(p.m) };
        };
    });
}

/* Whether a second pass moves anything: the stages with no moving piece are
 * drawn once. */
function moves(run) {
    const first = run.draws.map((d) => `${d.model}:${d.m.join(',')}`).join(';');
    for (let k = 0; k < 4; k++) run.step();
    const later = run.draws.map((d) => `${d.model}:${d.m.join(',')}`).join(';');
    run.rewind();
    return first !== later;
}

/** The nine stages, as explorer stages. */
export function readLastbrnxStages(rom) {
    const L = rom.game.stageTable.lastbrnx;
    const lit = gameLighting(rom);
    const stages = [];
    for (let n = 0; n < L.count; n++) {
        let run;
        try {
            run = stageRun(rom, n);
        } catch (e) {
            console.warn(`lastbrnx: stage ${n}: ${e.message}`);
            continue;
        }
        if (!run.draws.length) continue;
        const placed = (layer) => (d) => ({ model: d.model, pos: [d.m[9], d.m[10], d.m[11]], set: n, layer, ops: boardToOps(d.m) });
        const scenery = run.draws.map(placed('scenery'));
        if (moves(run)) liveScenery(scenery, run);
        const draws = [...scenery, ...run.walls.map(placed('walls'))];
        stages.push({
            slot: stages.length,
            placements: true,
            mixedSets: false,
            num: n,
            name: stageName(rom, n),
            chapter: n,
            draws,
            objects: [],
            sky: null,
            zones: [],
            views: [['all', 'Everything']],
            view: 'all',
            union: 'all',
            texSets: [n],
            /* The texture set and the colour block are both the stage number
             * (js/texture.js and js/colors.js, Last Bronx). */
            texSet: [n, n],
            fighters: [],
            tint: [1, 1, 1],
            bright: 1,
            light: lit?.light,
            materials: lit?.materials,
            colorCycles: [],
            paletteCycles: lastbrnxPaletteCycles(rom, n),
            floorSize: 0,
            meta: [['stage', n], ['routine', `0x${L.draw.toString(16)}`], ['pieces', draws.length],
                ['colour cycles', lastbrnxPaletteCycles(rom, n).map((c) => c.entry).join(' ')],
                ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
        });
    }
    return stages;
}
