/*
 * desert.js — Desert Tank's missions, read by running the game's own object
 * code.
 *
 * A mission is the byte at 0x52106F. Its set-up (0x37860) takes everything
 * from tables by that number:
 *
 *   0x521170  the map, `ld 0x43204[n*4]` (0x5DA8, 0xA4D4, 0x6B34): 0x2200000,
 *             0x2300000 or 0x2380000. map + 0x60000 holds, per camera block,
 *             the blocks in view (a count, then block numbers).
 *   0x521174  the block table, `ld 0x285A528[n*4]`: 256 model records, one
 *             per block of Daytona's 16x16 grid of 128-unit blocks
 *             (get_m_block: ((z + 0x400) >> 7 & 15) << 4 | ((x + 0x400) >> 7
 *             & 15)). 0xEF50..0xF120 draws them through 0xF300 under a bare
 *             push, so a block is already in world space.
 *   0x521188  the objects, `ld 0x28573B4[n*4]`: a null-ended list of lists of
 *             28-byte records.
 *
 * and the mission's texture bank is `ld 0x1678[n*4]` (see the game's entry).
 *
 * The spawner 0x16C60 walks the object lists: each record is x, y, z
 * (singles), three angles about X, Y and Z (halfwords, +0xC..+0x10), a type
 * (+0x14) and two halfwords (+0x18, +0x1A), and a list ends at the record
 * whose type has no routine at +0x18. It fills one 0x5C-byte task a record
 * (the place at +0x24, the angles at +0x1E, +0x20, +0x22, the type at +0x30,
 * the type's first model at +0x34) and points the task's routine (+0xC) at
 * the type's. The type is six model pointers (the object and its damage),
 * the routine, and the rest of its constants.
 *
 * The explorer runs that spawner on js/i960.js over the mission's tables,
 * then each task's routine with the task in 0x521038, as the task loop does,
 * and again once the routine has put its draw routine in +0xC. Most objects
 * are 0x17110's: it works out the object's grid block into +0x3C and hands
 * over to 0x17010, which, when that block is in view (0x520100[block]),
 * pushes, translates to the place and turns by Y, then X, then Z (copro 0x15,
 * 0x14, 0x16) and draws the first model through 0xF300. Every block is put
 * in view here. 0xF300 sends the matrix out (copro 0x11) to the geometrizer
 * and then each 16-byte {oba, tpa, tha, count} entry of the list it is given,
 * up to a zero; the explorer stands in for it, naming each entry's model and
 * keeping the copro's matrix (js/doa.js's Copro) at the time.
 *
 * The board draws few of the 256 blocks: 0xEDE0 (from 0xDCC8, with the camera
 * task's block and the camera's heading, 0x5211A0) looks up the blocks in
 * view at `ld (map + 0x60000)` + (block * 16 + heading / 0x1000) * 4, a count
 * then block numbers, marks them in 0x520100 and draws them; a few blocks
 * look theirs up in tables of their own instead (0xEE30's jump table on the
 * canyon, 0x285AE50 for block 0xA7 on the desert). The stage's 'camera' view
 * does the same round the explorer's camera, objects included: 0x17010 draws
 * an object only when its block is marked.
 */
import { doaMachine, boardToOps } from './doa.js';
import { gameLighting } from './stages.js';

const RAM_BASE = 0x500000;
const DATA_BASE = 0x2000000;

/* Where the mission set-up and the object code keep things. */
const MISSION = 0x52106f;
const MAP = 0x521170, BLOCKS = 0x521174, OBJECTS = 0x521188;
const CAMERA = 0x521200, TASKS = 0x520058, TASK = 0x521038, IN_VIEW = 0x520100;
const MAPS = 0x43204, BLOCK_TABLES = 0x285a528, OBJECT_TABLES = 0x28573b4;
const SPAWN = 0x16c60, DRAW = 0xf300;
const TASK_SIZE = 0x5c;
/* A free stretch of RAM for the tasks; the board's is at 0x50E368. */
const TASK_RAM = 0x5a0000;
/* 0x168A0 is the routine the spawner leaves in the slot after the last. */
const END_TASK = 0x168a0;

/* Copro commands Desert Tank's program has beyond js/doa.js's: 0x43
 * (0x23060) takes two points (x, z, x, z) and gives the distance between them,
 * which the object grid (0x16A20, under the spawner) measures each cell's
 * corner with. */
/* 0xEDE0's own tables, by mission and camera block: 16 lists each, one a
 * heading sector. */
const OWN_LISTS = {
    2: { 0x68: 0x285aac4, 0x69: 0x285ab04, 0x75: 0x285ab44, 0x78: 0x285ab84, 0x79: 0x285abc4 },
    1: { 0xa7: 0x285ae50 },
};

const COPRO = {
    0x43: [4, (cp, a) => cp.out([Math.hypot(a[0] - a[2], a[1] - a[3])])],
};

/* The missions the attract and the high-score table name (the strings
 * "DESERT MISSION" and "CANYON MISSION" in the program). Mission 0 is a third
 * map with blocks but no objects, which the attract never reaches. */
const MISSIONS = [
    { n: 1, name: 'Desert Mission' },
    { n: 2, name: 'Canyon Mission' },
    { n: 0, name: 'Mission 0 (no objects)' },
];

/* The model a 16-byte entry names: the table's record at that address, or
 * one with the same three words. */
function modelNamer(rom) {
    const t = rom.game.modelTable, dv = rom.mainDataView;
    const base = DATA_BASE + t.offset;
    const byWords = new Map();
    for (let i = t.count - 1; i >= 0; i--) {
        const at = t.offset + i * t.stride;
        byWords.set([0, 4, 8].map((k) => dv.getUint32(at + k, true)).join(','), i);
    }
    return (addr) => {
        const i = (addr - base) / t.stride;
        if (Number.isInteger(i) && i >= 0 && i < t.count) return i;
        const off = addr - DATA_BASE;
        if (off < 0 || off + 12 > rom.mainData.length) return -1;
        return byWords.get([0, 4, 8].map((k) => dv.getUint32(off + k, true)).join(',')) ?? -1;
    };
}

/** Run mission n's object spawner and every object's routine; the draws. */
export function runDesertObjects(rom, n, { maxSteps = 2_000_000 } = {}) {
    const M = doaMachine(rom, { copro: COPRO });
    const dv = rom.mainDataView, cv = rom.mainCpuView;
    const data = (a) => dv.getUint32(a - DATA_BASE, true);
    const w32 = (a, v) => M.rv.setUint32(a - RAM_BASE, v >>> 0, true);
    const r32 = (a) => M.rv.getUint32(a - RAM_BASE, true);
    const name = modelNamer(rom);
    M.ram[MISSION - RAM_BASE] = n;
    w32(MAP, cv.getUint32(MAPS + n * 4, true));
    w32(BLOCKS, data(BLOCK_TABLES + n * 4));
    w32(OBJECTS, data(OBJECT_TABLES + n * 4));
    w32(TASKS, TASK_RAM);
    M.ram.fill(1, IN_VIEW - RAM_BASE, IN_VIEW - RAM_BASE + 256);
    /* Some objects (0x194A0's) start from the camera's matrix, copro 0x07 off
     * 0x521200: the identity here, so they too come out in the world. */
    for (const k of [0, 4, 8]) M.rv.setFloat32(CAMERA - RAM_BASE + k * 4, 1, true);
    const draws = [];
    let task = 0;
    M.cpu.hooks.set(DRAW, (c) => {
        for (let p = c.reg(16); p && data(p); p += 16) {
            const model = name(p);
            if (model >= 0) {
                /* The task's place (+0x24, +0x2C) gives its block, as 0x17110 works it out. */
                const x = M.rv.getFloat32(task + 0x24 - RAM_BASE, true), z = M.rv.getFloat32(task + 0x2c - RAM_BASE, true);
                draws.push({ model, m: M.copro.m.slice(), task, kind: r32(task + 0x30), block: gridBlock(x, z) });
            }
        }
    });
    if (!data(OBJECT_TABLES + n * 4)) return { draws, tasks: 0, failed: 0, unknown: [] };
    if (!M.cpu.call(SPAWN, [], { maxSteps })) return { draws, tasks: 0, failed: 1, unknown: [] };
    let tasks = 0, failed = 0;
    for (let t = TASK_RAM; ; t += TASK_SIZE) {
        const routine = r32(t + 0xc);
        if (!routine || routine === END_TASK || (r32(t) & 0x80000000) === 0) break;
        tasks++;
        task = t;
        w32(TASK, t);
        /* The routine the spawner set, then whatever it handed over to. */
        let ok = true, at = routine;
        for (let pass = 0; pass < 3 && ok; pass++) {
            const before = draws.length;
            M.copro.m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
            M.copro.stack = [];
            ok = M.cpu.call(at, [], { maxSteps });
            const next = r32(t + 0xc);
            if (draws.length > before || next === at) break;
            at = next;
        }
        if (!ok) failed++;
    }
    return { draws, tasks, failed, unknown: [...M.unknown] };
}

/* get_m_block: the grid block a board x, z is in. */
const gridBlock = (x, z) => ((((z | 0) + 0x400) >> 7 & 15) << 4) | (((x | 0) + 0x400) >> 7 & 15);

/* The blocks 0xEDE0 draws for mission n round a camera; with no list, the
 * camera's block and the four beside it (0xF068's). */
function missionArea(rom, n) {
    const dv = rom.mainDataView;
    const data = (a) => dv.getUint32(a - DATA_BASE, true);
    const index = data(rom.mainCpuView.getUint32(MAPS + n * 4, true) + 0x60000);
    let key = null, last = null;
    return (cam) => {
        const block = gridBlock(cam.x, cam.z), sector = (cam.heading & 0xffff) >> 12;
        const k = `${block},${sector}`;
        if (k === key) return last;
        const own = OWN_LISTS[n]?.[block];
        const list = own ? data(own + sector * 4) : data(index + (block * 16 + sector) * 4);
        const area = new Set();
        if (list) {
            for (let i = 0, c = dv.getUint8(list - DATA_BASE); i < c; i++) area.add(dv.getUint8(list - DATA_BASE + 1 + i));
        } else {
            area.add(block);
            if (block & 15) area.add(block - 1);
            if ((block & 15) !== 15) area.add(block + 1);
            if (block >= 16) area.add(block - 16);
            if (block < 240) area.add(block + 16);
        }
        key = k;
        last = { area, near: area };
        return last;
    };
}

/**
 * The missions, as stages: the 256 blocks of the mission's grid where they
 * are, and the objects its lists place, each on the mission's texture bank.
 */
export function readDesertStages(rom) {
    const t = rom.game.modelTable, dv = rom.mainDataView;
    const base = DATA_BASE + t.offset;
    const lit = gameLighting(rom);
    const stages = [];
    for (const { n, name } of MISSIONS) {
        const draws = [];
        const table = dv.getUint32(BLOCK_TABLES - DATA_BASE + n * 4, true) - DATA_BASE;
        for (let b = 0; b < 256; b++) {
            const idx = (dv.getUint32(table + b * 4, true) - base) / t.stride;
            if (!Number.isInteger(idx) || idx < 0 || idx >= t.count) continue;
            draws.push({ model: idx, pos: [0, 0, 0], set: n, layer: 'ground', block: b, ops: [] });
        }
        const blocks = draws.length;
        let run = { draws: [], tasks: 0, failed: 0, unknown: [] };
        try {
            run = runDesertObjects(rom, n);
        } catch (e) {
            console.warn(`desert: mission ${n}: ${e.message}`);
        }
        for (const d of run.draws) {
            draws.push({ model: d.model, pos: [d.m[9], d.m[10], d.m[11]], set: n, layer: 'scenery', block: d.block, ops: boardToOps(d.m) });
        }
        stages.push({
            slot: stages.length,
            placements: true,
            mixedSets: false,
            num: n,
            name,
            chapter: n,
            draws,
            objects: [],
            sky: null,
            zones: [],
            views: [['all', 'Everything'], ['camera', 'The blocks the board draws round the camera']],
            area: missionArea(rom, n),
            view: 'all',
            union: 'all',
            texSets: [n],
            texSet: [n, n],
            tint: [1, 1, 1],
            bright: 1,
            light: lit?.light ?? [0, 0, 1],
            materials: lit?.materials,
            colorCycles: [],
            flags: 0,
            floorSize: 0,
            meta: [['mission', n], ['blocks', blocks], ['objects', run.tasks], ['pieces', draws.length - blocks],
                ...(run.failed ? [['objects not run', run.failed]] : []),
                ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
        });
    }
    return stages;
}
