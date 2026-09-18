/*
 * placements.js — The House of the Dead's stages, read the way its program reads
 * them.
 *
 * There is no stage record. A chapter's scenery is a table of placements in the
 * program ROM — a model and a world position each — and a set of zone lists
 * that say which placements are drawn while that zone is current. What makes a
 * zone current, and which texture set is loaded while it is, is a script: the
 * chapter runs a list of sections, each a list of scripts in a small bytecode
 * the interpreter at loc_50700 walks. So a stage here is assembled out of three
 * tables:
 *
 *   off_92DB0[chapter]  placements: 24-byte records {model, x, y, z, cycle, far}
 *   off_92D90[chapter]  zones: 50 bytes each, placement indices ending in 0xFF
 *   off_E0000[chapter]  sections -> scripts, whose opcodes 20 and 79 set the
 *                       zone and load a texture set
 *
 * with `off_83360[chapter][section]`, the set each section loads as it starts.
 *
 * The courtyard and the mansion of the first chapter are drawn under different
 * texture sets, and one atlas can hold only one, so a stage in the list is a
 * chapter and a set: every zone the chapter's scripts make current while that
 * set is loaded, and every placement those zones draw. That also puts the model
 * under the colours the game shows it with, which is what the Models tab reads
 * back out of it.
 */

import { gameLighting } from './stages.js';

/* The draw loop at 0x3DB10 reads a placement 24 bytes wide and a zone 50. */
const PLACEMENT_BYTES = 24;
const ZONE_BYTES = 50;
const END = 0xffffffff;

/*
 * How many words each opcode of the stage script takes, read off its handler
 * in the table at 0x94550. The walk only needs to step over an instruction to
 * reach the next, so an opcode's meaning matters here only for the two it
 * reads — 20, which makes a zone current (sub_50890), and 79, which loads a
 * texture set (sub_50EE0 -> sub_2B720).
 */
const OP_ZONE = 20;
const OP_LOAD_SET = 79;
const OP_CAMERA = 60;
/* Which sky shell is behind the arena, and whether it is drawn — see `sky` in
 * js/games.js. 70 takes an index into the profile's table, 71 an enable whose
 * 1 drifts the dome and 2 holds it still. */
const OP_SKY = 70;
const OP_SKY_ON = 71;
const ONE_WORD = new Set([16, 34, 83]);
const TWO_WORDS = new Set([13, 14, 15, 20, 32, 33, 40, 69, 70, 71, 72, 73, 74, 75, 77, 78, 79,
    80, 81, 82, 84, 85, 88, 89, 90, 91]);
const THREE_WORDS = new Set([26, 68, 76, 87]);
/* Spawns and two list setters: the opcode, pointers, and a -1. */
const LISTS = new Set([9, 10, 11, 12, 50, 51]);
/* Of those, the four whose entries are pointers to a spawn record. 50 and 51
 * carry plain numbers and are not read. */
const SPAWN_OPS = new Set([9, 10, 11, 12]);
const SPAWN_BYTES = 20;
/* 92 halts and 93 moves on to the next script. */
const ENDS = new Set([92, 93]);

function inRom(rom, p, bytes = 4) {
    return p > 0 && p !== END && p + bytes <= rom.maincpu.length;
}

/*
 * Walk one script, handing each instruction to `visit` as (opcode, pointer).
 *
 * Opcode 60 queues a camera command whose payload follows it inline, and its
 * argument packs the payload's length in words above the low four bits. A -1
 * on its own closes an inline block and is stepped over.
 */
function walkScript(rom, at, visit) {
    const dv = rom.mainCpuView;
    for (let p = at, n = 0; inRom(rom, p) && n < 4096; n++) {
        const op = dv.getUint32(p, true);
        visit(op, p);
        if (ENDS.has(op)) return;
        if (op === END || ONE_WORD.has(op)) p += 4;
        else if (TWO_WORDS.has(op)) p += 8;
        else if (THREE_WORDS.has(op)) p += 12;
        else if (op === OP_CAMERA) p += 8 + (dv.getUint32(p + 4, true) >>> 4) * 4;
        else if (LISTS.has(op)) {
            let q = p + 4;
            while (inRom(rom, q) && dv.getUint32(q, true) !== END) q += 4;
            p = q + 4;
        } else {
            return;     /* nothing the table decodes: stop rather than guess */
        }
    }
}

/*
 * The props a spawn list puts in the room, as the object table names them.
 *
 * A record is {type, flags, x, y, z}. The type indexes the table in the profile,
 * whose entry carries a sound and, at `model`, the model to draw. The word after
 * the type is not a turn: 1219 of the game's 1246 records carry 0x80000000 there
 * and 25 carry 0x40000000, and nothing in the field reads as an angle — so a
 * prop stands where it is put, unturned, which is also how the draw loop treats
 * a placement.
 *
 * Only the types the game treats as an ordinary standing object are put up.
 * Each type also has a handler, and 77 of the finished game's 125 share one —
 * the routine that draws the table's model where the object was spawned and
 * does nothing else. The rest have handlers of their own and are not props at
 * all: type 97 is a distance trigger that draws nothing, 98 to 102 switch on
 * `type - 98` into four behaviours of their own, and their models are room 4's
 * walls and shutters, which is what filled the first chapter's courtyard with
 * PN_r4_04 pieces when every type was stood up. What those handlers do has not
 * been read, so nothing is guessed at: they are left out.
 *
 * Type 0 is nothing at all — its entry names PN_space and its handler slot is a
 * null pointer — so the table's own shape excludes it.
 *
 * Records are keyed by their own address, because a script listed by two
 * sections is walked twice and would otherwise stand its props up twice.
 */
function spawnProps(rom, at, set, out) {
    const O = rom.game.objects;
    if (!O) return;
    const dv = rom.mainCpuView;
    for (let q = at + 4; inRom(rom, q); q += 4) {
        const rec = dv.getUint32(q, true);
        if (rec === END) break;
        if (!inRom(rom, rec, SPAWN_BYTES)) continue;
        if (out.has(rec)) continue;
        const type = dv.getUint32(rec, true);
        if (!(type > 0 && type < O.count)) continue;
        if (dv.getUint32(O.handlers + type * 4, true) !== O.prop) continue;
        const model = dv.getUint32(O.table + type * O.stride + O.model, true);
        if (!model || model >= rom.game.modelTable.count) continue;
        out.set(rec, {
            type,
            model,
            set,
            pos: [dv.getFloat32(rec + 8, true), dv.getFloat32(rec + 12, true),
                dv.getFloat32(rec + 16, true)],
        });
    }
}

/* A -1-terminated list of pointers, as the section and script tables are. */
function pointerList(rom, at) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let p = at; inRom(rom, p) && out.length < 256; p += 4) {
        const v = dv.getUint32(p, true);
        if (!inRom(rom, v)) break;
        out.push(v);
    }
    return out;
}

/* Section numbers as runs: 0-4, 9-12. */
function runs(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        out.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
        i = j;
    }
    return out.join(', ');
}

function readPlacement(rom, map, index) {
    const dv = rom.mainCpuView;
    const at = map + index * PLACEMENT_BYTES;
    if (!inRom(rom, at, PLACEMENT_BYTES)) return null;
    /* A non-zero cycle pointer overrides the model: the loop draws the next
     * entry of that -1-terminated list each time, and goes back to the first
     * past the end. Which of the record's two tail words holds it moved between
     * the prototype and the finished game — 0x10 there, 0x14 here, with the
     * other word carrying something the viewer does not read — so the profile
     * says. Each game has exactly one placement that uses it, and it is the
     * same one: the rain in the mansion corridor's windows, cycling 32 frames.
     */
    const cycleAt = dv.getUint32(at + (rom.game.stageTable.placements.cycle ?? 0x10), true);
    const cycle = cycleAt ? modelList(rom, cycleAt) : null;
    return {
        index,
        model: dv.getUint32(at, true),
        pos: [dv.getFloat32(at + 4, true), dv.getFloat32(at + 8, true), dv.getFloat32(at + 12, true)],
        cycle: cycle?.length ? cycle : null,
        turn: rom.game.stageTable.placements.turns?.[index] ?? 0,
    };
}

/* A -1-terminated list of model numbers. */
function modelList(rom, at) {
    const dv = rom.mainCpuView;
    const out = [];
    for (let p = at; inRom(rom, p) && out.length < 256; p += 4) {
        const v = dv.getUint32(p, true);
        if (v === END) break;
        out.push(v);
    }
    return out;
}

/*
 * How many placements a chapter's table holds. The program never says — the
 * draw loop only ever reaches a record through a zone — but a table ends in a
 * record no zone names, and nothing is placed as model 0. The prototype's
 * chapters close on a zero model; the finished game's close on a -1 model and a
 * zero one behind it, so both words end the walk. Stopping only on zero there
 * would take the -1 for a placement and index the model tables with it.
 */
function placementCount(rom, map) {
    const dv = rom.mainCpuView;
    let n = 0;
    while (n < 256 && inRom(rom, map + n * PLACEMENT_BYTES, PLACEMENT_BYTES)) {
        const model = dv.getUint32(map + n * PLACEMENT_BYTES, true);
        if (model === 0 || model === END) break;
        n++;
    }
    return n;
}

/*
 * Versions of one piece: placements standing at the same spot that no zone
 * draws together. The chapter's tables are full of them — PN_niwa01_03a, 03b
 * and 03c, PN_room_1b and 1bb, PN_hashi01_00a and 00b — and each zone lists
 * one, so which a player sees depends on where the camera is. A stage made of
 * every zone a set reaches would stand them all in one place, and they are
 * modelled on top of each other: three copies of a wall, its window glow and
 * its window frame, each window showing whichever copy the depth buffer
 * happened to keep. One is drawn and the rest are kept apart, so the Models tab
 * still knows the stage draws them.
 *
 * The one drawn is the one the stage opens with: of the zones that list it, the
 * first any script makes current. These are states, not levels of detail —
 * PN_niwa01_03c is the mansion with its doors shut, 03b the same front from
 * nearer, and 03a has the doorway standing open, which is what the player is
 * shown once the doors have opened in front of them. Zones 11 and 12 list it,
 * in section 4; zone 1 lists 03c, in section 0. Keeping the most detailed
 * version instead took the doors off the house. Same for the bridge, where 00a
 * is a single zone at the end of the chapter and 00b is the eight before it.
 *
 * Sharing a spot is not enough on its own: Chapter 2's rooms are modelled in
 * world space and several are placed at the same origin, PN_room2_04a and 06a
 * among them, without a cubic unit in common. So versions must also fill much
 * the same space — their bounding boxes, from the table the sphere cull reads
 * (`bounds`: a pointer per model to max xyz, min xyz, radius), overlapping by
 * at least a quarter of their union. The bridge's a and b halves overlap by a
 * third; rooms that merely share an origin do not overlap at all.
 */
function resolveAlternates(rom, draws, zonesOf, zoneOrder) {
    const T = rom.game.modelTable;
    const model = (d) => (d.cycle ? d.cycle[0] : d.model);
    /* How early the piece is first standing there: the least script order of
     * any zone that lists it. */
    const opens = (d) => Math.min(...[...(zonesOf.get(d.index) ?? [])]
        .map((z) => zoneOrder.get(z) ?? Infinity), Infinity);
    const polygons = (d) => rom.mainDataView.getUint32(T.offset + model(d) * T.stride + 12, true);
    const boundsAt = rom.game.stageTable.placements.bounds;
    const box = (d) => {
        const md = rom.mainDataView;
        const p = boundsAt ? md.getUint32(boundsAt + model(d) * 4, true) - 0x02000000 : -1;
        if (p < 0 || p + 28 > rom.mainData.length) return null;
        const f = (o) => md.getFloat32(p + o, true);
        return { max: [f(0), f(4), f(8)], min: [f(12), f(16), f(20)] };
    };
    const overlap = (a, b) => {
        const A = box(a), B = box(b);
        if (!A || !B) return true;
        let inter = 1, va = 1, vb = 1;
        for (let k = 0; k < 3; k++) {
            inter *= Math.max(0, Math.min(A.max[k], B.max[k]) - Math.max(A.min[k], B.min[k]));
            va *= Math.max(1e-6, A.max[k] - A.min[k]);
            vb *= Math.max(1e-6, B.max[k] - B.min[k]);
        }
        return inter / (va + vb - inter) >= 0.25;
    };
    const spots = new Map();
    for (const d of draws) {
        const k = d.pos.map((v) => v.toFixed(2)).join(',');
        if (!spots.has(k)) spots.set(k, []);
        spots.get(k).push(d);
    }
    const drop = new Set();
    for (const here of spots.values()) {
        if (here.length < 2) continue;
        const together = (a, b) => [...(zonesOf.get(a.index) ?? [])].some((z) => zonesOf.get(b.index)?.has(z));
        const exclusive = here.every((a) => here.every((b) => a === b || (!together(a, b) && overlap(a, b))));
        if (!exclusive) continue;
        const keep = [...here].sort((a, b) => opens(a) - opens(b)
            || (zonesOf.get(b.index)?.size ?? 0) - (zonesOf.get(a.index)?.size ?? 0)
            || polygons(b) - polygons(a) || a.index - b.index)[0];
        for (const d of here) if (d !== keep) drop.add(d);
    }
    return { draws: draws.filter((d) => !drop.has(d)), alternates: draws.filter((d) => drop.has(d)) };
}

/*
 * The two shells behind the arena, where the scripts turn the sky on: the dome
 * the index picks, lowered by its own float, and the cut-out band every sky
 * draws over it. The dome's drift is an angle per frame rather than a fixed
 * turn, which is what carrying `ops` as a function of the frame is for.
 */
function skyDraws(rom, sky) {
    const S = rom.game.sky;
    if (!S || !sky?.on || sky.index >= S.count) return null;
    const dv = rom.mainCpuView;
    /* The prototype keeps the model and the height in two arrays of their own
     * and the drift rate in the code; the finished game folds all three into a
     * record per sky, so the profile gives a stride and, where the rate is in
     * the data, where to read it. */
    const stride = S.stride ?? 4;
    const dome = dv.getUint32(S.models + sky.index * stride, true);
    const y = dv.getFloat32(S.heights + sky.index * stride, true);
    if (!dome) return null;
    /* Angle units of 65536 a frame, as the task's own counter counts. */
    const rate = S.spins != null ? dv.getUint32(S.spins + sky.index * stride, true) : S.spin;
    return {
        index: sky.index, dome, band: S.band, y,
        spin: sky.spin ? rate : 0,
    };
}

/* A stage entry in the shape the viewer's stage list takes. The set is the
 * atlas, the palette and the colour tables at once — sub_2B720 loads all three
 * from the one number. */
function placementStage(stages, lit, chapter, { name, set, draws, objects = [], sky = null, alternates = [], meta, mixedSets = false }) {
    stages.push({
        slot: stages.length,
        placements: true,
        mixedSets,
        num: chapter + 1,
        name,
        chapter,
        draws,
        objects,
        sky,
        alternates,
        texSets: [set],
        texSet: [set, set],
        tint: [1, 1, 1],
        bright: 1,
        light: lit.light,
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['stage', chapter + 1], ...meta],
    });
}

/**
 * Every stage the placement tables make: one per chapter and texture set, and
 * one per chapter with every placement in its table.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stage objects in the shape the viewer's stage list takes
 */
export function readPlacementStages(rom) {
    const T = rom.game.stageTable.placements;
    const dv = rom.mainCpuView;
    const lit = gameLighting(rom);
    const stages = [];

    for (let chapter = 0; chapter < T.chapters; chapter++) {
        const map = dv.getUint32(T.maps + chapter * 4, true);
        const zoneTable = dv.getUint32(T.zones + chapter * 4, true);
        const sectionSets = dv.getUint32(T.sectionSets + chapter * 4, true);
        const sections = pointerList(rom, dv.getUint32(T.scripts + chapter * 4, true));

        /* Zones in the order the scripts reach them, each under the set loaded
         * when it is made current: the section's own set as it starts, then any
         * set a script loads part way through. That order is also what says
         * which of two versions of a piece the stage opens with — see
         * resolveAlternates. */
        const groups = new Map();
        const zoneOrder = new Map();
        const zoneSet = new Map();
        /* The sky is a pair of bytes the scripts write and the drawing task
         * reads, so it carries across sections exactly as it does on the
         * machine: a set's sky is what is standing when its first zone is made
         * current, and whatever its own sections then ask for. */
        const sky = { index: 0, on: 0, spin: false };
        /* The props the chapter's scripts spawn, each under the set that was
         * loaded when its list ran — the same rule the zones are grouped by. */
        const props = new Map();
        sections.forEach((section, number) => {
            let set = dv.getUint32(sectionSets + number * 4, true);
            for (const script of pointerList(rom, section)) {
                walkScript(rom, script, (op, p) => {
                    if (op === OP_LOAD_SET) set = dv.getUint32(p + 4, true);
                    if (op === OP_SKY || op === OP_SKY_ON) {
                        if (op === OP_SKY) sky.index = rom.maincpu[p + 4];
                        else { sky.on = rom.maincpu[p + 4]; sky.spin = sky.spin || sky.on === 1; }
                        const g = groups.get(set);
                        if (g) {
                            g.sky.index = sky.index;
                            g.sky.on = g.sky.on || sky.on !== 0;
                            g.sky.spin = g.sky.spin || sky.on === 1;
                        }
                        return;
                    }
                    if (SPAWN_OPS.has(op)) { spawnProps(rom, p, set, props); return; }
                    if (op !== OP_ZONE) return;
                    if (!groups.has(set)) {
                        groups.set(set, {
                            zones: new Set(), sections: new Set(),
                            sky: { index: sky.index, on: sky.on !== 0, spin: sky.on === 1 },
                        });
                    }
                    const g = groups.get(set);
                    const zone = dv.getUint32(p + 4, true);
                    g.zones.add(zone);
                    g.sections.add(number);
                    if (!zoneOrder.has(zone)) { zoneOrder.set(zone, zoneOrder.size); zoneSet.set(zone, set); }
                });
            }
        });

        /* Which zones list each placement, over every zone the chapter reaches. */
        const zonesOf = new Map();
        for (const g of groups.values()) {
            for (const zone of g.zones) {
                const at = zoneTable + zone * ZONE_BYTES;
                if (!inRom(rom, at, ZONE_BYTES)) continue;
                for (let i = 0; i < ZONE_BYTES && rom.maincpu[at + i] !== 0xff; i++) {
                    const p = rom.maincpu[at + i];
                    if (!zonesOf.has(p)) zonesOf.set(p, new Set());
                    zonesOf.get(p).add(zone);
                }
            }
        }

        /* And the set each placement is drawn under: the one loaded while the
         * first zone that lists it is current. A stage made of every zone the
         * chapter reaches needs it per placement, because it spans every set
         * the chapter loads. */
        const setOf = new Map();
        for (const [index, zones] of zonesOf) {
            const first = [...zones].reduce((a, b) =>
                ((zoneOrder.get(b) ?? Infinity) < (zoneOrder.get(a) ?? Infinity) ? b : a));
            if (zoneSet.has(first)) setOf.set(index, zoneSet.get(first));
        }

        const reached = new Set();
        let widest = null;
        for (const [set, g] of groups) {
            const indices = new Set();
            for (const zone of g.zones) {
                const at = zoneTable + zone * ZONE_BYTES;
                if (!inRom(rom, at, ZONE_BYTES)) continue;
                for (let i = 0; i < ZONE_BYTES && rom.maincpu[at + i] !== 0xff; i++) {
                    indices.add(rom.maincpu[at + i]);
                }
            }
            const listed = [...indices].sort((a, b) => a - b)
                .map((i) => readPlacement(rom, map, i))
                .filter((d) => d && (d.model || d.cycle));
            for (const d of listed) { reached.add(d.index); d.set = set; }
            const { draws, alternates } = resolveAlternates(rom, listed, zonesOf, zoneOrder);
            if (!widest || draws.length > widest.count) widest = { set, count: draws.length };

            const sky = skyDraws(rom, g.sky);
            const objects = [...props.values()].filter((o) => o.set === set);
            placementStage(stages, lit, chapter, {
                name: `Stage ${chapter + 1} · set ${set}`,
                set,
                draws,
                objects,
                sky,
                alternates,
                meta: [
                    ['texture set', set],
                    ['sections', runs(g.sections)],
                    ['zones', g.zones.size],
                    ['placements', draws.length],
                    ...(objects.length ? [['props', objects.length]] : []),
                    ['sky', sky ? `${sky.dome}${sky.spin ? ', drifting' : ', held'}` : 'off'],
                    ...(alternates.length ? [['other versions', `${alternates.length}, not drawn`]] : []),
                ],
            });
        }

        /*
         * The whole table, including what no zone the scripts reach draws: a
         * few pieces no zone lists at all, and a few listed only in zones no
         * script makes current.
         *
         * It spans every set the chapter loads, and texture RAM holds one set
         * at a time, so each placement carries the set it is drawn under and
         * the viewer builds the sheets and colour tables of each — one material
         * per set (see materialForSet in js/app.js). A piece no reached zone
         * lists has no set to carry, and takes the one that draws the most of
         * the chapter. It stays out of the Models tab's answer to which scene
         * draws a model, which wants the one scene a model belongs to.
         */
        const count = placementCount(rom, map);
        const table = [];
        for (let i = 0; i < count; i++) {
            const d = readPlacement(rom, map, i);
            if (!d) continue;
            d.set = setOf.get(i) ?? widest?.set;
            table.push(d);
        }
        const { draws: all, alternates } = resolveAlternates(rom, table, zonesOf, zoneOrder);
        if (all.length && widest) {
            placementStage(stages, lit, chapter, {
                name: `Stage ${chapter + 1} · all placements`,
                set: widest.set,
                draws: all,
                /* The sky of the set that draws most of the chapter, since that
                 * is the set this stage is framed as. */
                sky: skyDraws(rom, groups.get(widest.set)?.sky),
                objects: [...props.values()],
                alternates,
                mixedSets: true,
                meta: [
                    ['texture set', `${[...new Set(all.map((d) => d.set))].sort((a, b) => a - b).join(', ')}, per part`],
                    ['placements', table.length],
                    ...(props.size ? [['props', props.size]] : []),
                    ['in no reached zone', table.filter((d) => !reached.has(d.index)).length],
                    ...(alternates.length ? [['other versions', `${alternates.length}, not drawn`]] : []),
                ],
            });
        }
    }
    return stages;
}

/*
 * The draw list: every placement where it stands, which is the whole of what
 * the draw loop does besides the cull. It pushes the placement's position as a
 * translate and draws the model, with no scale and a turn for the one placement
 * the loop singles out (see `turns` in the profile). A cycling placement walks
 * its list a model a frame.
 *
 * The board turns Y by the negated angle and its Z is the viewer's reversed,
 * which leaves a board turn of +a as an ordinary Y turn of +a here.
 */
export function buildPlacementDisplayList(stage) {
    const sky = [];
    if (stage.sky) {
        const { dome, band, y, spin } = stage.sky;
        const at = (turn) => [['t', [0, y, 0]], ...(turn ? [['r', turn]] : [])];
        /* The dome first and the band over it, the order the task draws them. */
        sky.push({
            model: dome,
            layer: 'sky',
            ops: spin ? (frame) => at(((frame * spin) % 0x10000) * (360 / 0x10000)) : at(0),
        });
        sky.push({ model: band, layer: 'sky', ops: at(0) });
    }
    /* The props go in under their own layer, so they can be turned off and so
     * the camera frames on the room rather than on them. */
    const objects = (stage.objects ?? []).map((o) => ({
        model: o.model,
        layer: 'objects',
        set: o.set,
        ops: [['t', [o.pos[0], o.pos[1], -o.pos[2]]]],
    }));
    return sky.concat(objects, stage.draws.map((d) => ({
        model: d.cycle ? d.cycle[0] : d.model,
        anim: d.cycle ? { frames: d.cycle, shift: 0, phase: 0 } : null,
        layer: 'scenery',
        /* Which texture set the piece is drawn under, for a stage that spans
         * several — see the all-placements stage in readPlacementStages. */
        set: d.set,
        ops: [['t', [d.pos[0], d.pos[1], -d.pos[2]]],
            ...(d.turn ? [['r', (d.turn * 360) / 0x10000]] : [])],
    })));
}
