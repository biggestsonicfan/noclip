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
const SPAWN_BYTES = 0x28;
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
 * The record's shape is the spawn opcode's handler's, not a guess at it. It
 * reads
 *
 *     ld   (r9), g4            ; +0x00 picks the task the object runs
 *     ld   off_AFDD0[g4*4], g0
 *     call _TaskOpen
 *     ldob 0x24(r9), g4
 *     stos g4, 0xCC(r8)        ; +0x24, a byte, is the object type
 *     ldos 0x20(r9), g4        ; whose low two bits say how the position reads
 *     addo r9, 8, g13          ; and the position is at +0x08
 *
 * So the type is the byte at 0x24 — the first word is which task it runs, which
 * is why it ranges past any type the object table holds — and the position is
 * three floats at 0x08 in every mode. The two modes past 1 interpolate a
 * position between two points rather than standing one still; their first three
 * floats are still where the object starts.
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
        /*
         * The word the spawner reads first is not the type: it is the object's
         * class, an index into a table of the routines that open a task —
         * `ld off_AFDD0[g4*4], g0 / call _TaskOpen`. Only one of them, the one
         * the profile names, is the generic object that goes on to draw the
         * type's model; the rest are the doors, the bodies and the effects,
         * which stand nothing here. Every other field is filled the same way
         * whatever the class, which is why they all looked like props.
         */
        const cls = dv.getUint32(rec, true);
        if (!inRom(rom, O.classes + cls * 4)) continue;
        if (dv.getUint32(O.classes + cls * 4, true) !== O.generic) continue;
        const type = rom.maincpu[rec + O.type];
        if (!(type > 0 && type < O.count)) continue;
        if (dv.getUint32(O.handlers + type * 4, true) !== O.prop) continue;
        const model = dv.getUint32(O.table + type * O.stride + O.model, true);
        if (!model || model >= rom.game.modelTable.count) continue;
        /* The size it is drawn at: the handler loads the type's float at
         * +0x28 into the task and hands it to the draw on all three axes --
         * `ld 0x94(r4), g4` written to 0x84, 0x88 and 0x8C of the matrix
         * command. Fifty of the seventy-three types are 1.0, which is why only
         * the ones that are not showed up: the vases at 0.5 and 1.4, the moon
         * at 0.25, the pile of bones at 1.5. */
        const scale = O.scale === undefined ? 1
            : dv.getFloat32(O.table + type * O.stride + O.scale, true);
        /* The three words after the position are the angles, copied straight
         * across to the task: `ld 0x14(r9), g4 / st g4, 0x2C(r8)` and the two
         * that follow. They are the turn the scenery uses, a whole circle to
         * 0x10000, and they are almost all a quarter turn of yaw. */
        out.set(rec, {
            type,
            model,
            set,
            scale: scale > 0 ? scale : 1,
            pos: [dv.getFloat32(rec + 8, true), dv.getFloat32(rec + 12, true),
                dv.getFloat32(rec + 16, true)],
            turn: [dv.getUint32(rec + 20, true) & 0xffff,
                dv.getUint32(rec + 24, true) & 0xffff,
                dv.getUint32(rec + 28, true) & 0xffff],
        });
    }
}

/*
 * Which zones each prop is drawn in, by running the board's clock over the
 * scripts.
 *
 * A prop does not belong to a zone. It is a task the spawn opcode opens, and
 * it stays up until it closes itself, which only sub_33320 makes it do — the
 * routine its handler (0x30670) calls each frame before it draws:
 *
 *     ldib 0x520089, g7        ; the section's script index
 *     ld   0x2E4(r4), g4       ; against the one the object last saw;
 *     ...                      ; a change is counted at obj+0x318,
 *     ldis 0x6C(r4), g6        ; and once past the record's halfword
 *     cmpible g5, g6, ...
 *     call sub_10D60           ; the task closes itself
 *
 * and then, for a record with a window row, flips obj+0x2E8 — the flag the
 * handler draws under — each time the camera frame (0x51E788) equals the
 * row's next entry, closing once the row ends with it hidden. So what decides
 * a prop's zones is time: how many scripts have gone by, and how far the
 * camera has played, when each opcode 20 runs. That is walked here the way
 * the interpreter runs it. Opcode 60's type-0 command queues a camera stretch
 * {start, end, path, flags}; 83 waits for the queue to play out, 84 for a
 * frame past its argument, 81 for that many frames; the rest take no time.
 * 93 moves to the next script, and the end of a section goes where the branch
 * table says, at script 1 (sub_51490; script 0 is the start the game takes
 * in its other mode). A prop is in a zone if it is drawn on a frame while
 * that zone is current. A choice between two sections takes both.
 *
 * Returns a Map from spawn record to a Set of zones, or null where the profile
 * does not say how a prop closes.
 */
const OP_WAIT_FRAMES = 81;
const OP_WAIT_CAMERA = 83;
const OP_WAIT_PAST = 84;
const WINDOW_END = 0xffff;

function propZones(rom, chapter, sections, props) {
    const O = rom.game.objects;
    const branches = rom.game.stageTable.placements.branches;
    if (!O?.spawns || branches == null) return null;
    const dv = rom.mainCpuView;
    const scripts = sections.map((section) => pointerList(rom, section).map((script) => {
        const ops = [];
        walkScript(rom, script, (op, p) => ops.push([op, p]));
        return ops;
    }));
    const table = dv.getUint32(branches + chapter * 4, true);
    /* The sections that can follow one, as sub_51490 picks them. A section
     * with no script 1 ends the chapter. */
    const after = (s) => {
        const at = table + s * 16;
        const kind = rom.maincpu[at];
        const next = [];
        if (kind === 0) next.push(rom.maincpu[at + 4]);
        else if (kind === 2) next.push(s + 1);
        else if (kind === 1) {
            for (let q = at + 4; q < at + 16 && dv.getUint32(q, true) !== END; q += 4) next.push(rom.maincpu[q]);
        }
        return next.filter((n) => scripts[n]?.length > 1);
    };
    const sweep = O.sweep?.chapter === chapter ? O.sweep : null;
    const out = new Map();

    /*
     * Run the interpreter from script `i`, instruction `e` of section `s`,
     * with `c` the camera and the current zone, and `t` the object, if one is
     * up yet. Without one it stops at `stop` = [script, instruction] and hands
     * back the state there; with one, it runs until the object closes or the
     * chapter ends, crediting zones as it goes.
     */
    function run(s, i, e, c, t, stop = null, seen = new Set()) {
        /* One frame of the object's task: sub_33320, in its order. */
        const frame = () => {
            if (!t) return true;
            if (sweep && s === sweep.section && i === sweep.script && t.type !== sweep.spare
                && c.frame > sweep.after) return false;
            if (i !== t.seen) {
                t.seen = i;
                if (++t.count > t.life) return false;
            }
            if (t.window) {
                if (c.frame === t.window[t.w]) { t.drawn = !t.drawn; t.w++; }
                if (!t.drawn && t.window[t.w] === WINDOW_END) return false;
            }
            if (t.drawn && c.zone != null) out.get(t.rec).add(c.zone);
            return true;
        };
        /* The camera's next frame, or the one it holds when nothing is queued. */
        const tick = () => {
            const q = c.queue[0];
            if (q) {
                c.frame = q[0]++;
                if (q[0] > q[1]) c.queue.shift();
            }
            return frame();
        };
        for (let sections = 0; sections < 64; sections++) {
            const list = scripts[s];
            for (; i < list.length; i++, e = 0) {
                for (; e < list[i].length; e++) {
                    if (stop && i === stop[0] && e === stop[1]) return c;
                    const [op, p] = list[i][e];
                    const arg = dv.getUint32(p + 4, true);
                    if (op === OP_ZONE) c.zone = arg;
                    else if (op === OP_CAMERA && (arg & 15) === 0 && arg >>> 4 >= 2) {
                        const start = dv.getUint32(p + 8, true);
                        const last = c.queue.length ? c.queue[c.queue.length - 1][1] : c.frame;
                        c.queue.push([start === END ? last + 1 : start, dv.getInt32(p + 12, true)]);
                    } else if (op === OP_WAIT_CAMERA) {
                        while (c.queue.length) if (!tick()) return null;
                    } else if (op === OP_WAIT_PAST && arg) {
                        while (c.queue.length && !(c.frame > arg)) if (!tick()) return null;
                    } else if (op === OP_WAIT_FRAMES) {
                        for (let k = 0; k < Math.min(arg, 3600); k++) if (!tick()) return null;
                    }
                }
            }
            if (stop) return c;
            /* The section is done: on to each that can follow, at script 1. A
             * branch already taken in the same state adds nothing. */
            const next = after(s).filter((n) => {
                const key = `${n}:${t.count}:${t.w}:${t.drawn}:${c.zone}:${c.frame}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (!next.length) return null;
            for (const n of next.slice(1)) {
                run(n, 1, 0, { ...c, queue: c.queue.map((q) => [...q]) }, { ...t }, null, seen);
            }
            [s, i, e] = [next[0], 1, 0];
        }
        return null;
    }

    scripts.forEach((list, s) => list.forEach((ops, i) => ops.forEach(([op, p], e) => {
        const form = SPAWN_OPS.has(op) && O.spawns[op];
        if (!form) return;
        for (let q = p + 4; inRom(rom, q); q += 4) {
            const rec = dv.getUint32(q, true);
            if (rec === END) break;
            const prop = props.get(rec);
            if (!prop) continue;
            if (!out.has(rec)) out.set(rec, new Set());
            const row = form.window != null ? rom.maincpu[rec + form.window] : 0;
            const window = [];
            for (let k = 0; row && k < 8; k++) {
                window.push(dv.getUint16(O.windows + row * 16 + k * 2, true));
                if (window[k] === WINDOW_END) break;
            }
            /* The interpreter as it stands at the spawn, then the object. */
            const c = run(s, 0, 0, { zone: null, frame: 0, queue: [] }, null, [i, e]);
            run(s, i, e + 1, c, {
                rec, type: prop.type, life: dv.getInt16(rec + form.life, true),
                seen: i, count: 0, drawn: true, window: row ? window : null, w: 0,
            });
        }
    })));
    return out;
}

/* A prop's three angles, in the order and the sign the scenery's single turn
 * already uses. Yaw is all but six of them carry. */
function propTurn([x, y, z]) {
    const deg = (v) => (v * 360) / 0x10000;
    const out = [];
    if (y) out.push(['r', deg(y)]);
    if (x) out.push(['rx', deg(x)]);
    if (z) out.push(['rz', -deg(z)]);
    return out;
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
 * Which placements are standing while one zone is current.
 *
 * The chapter's tables are full of versions of one piece at one spot —
 * PN_niwa01_03a, 03b and 03c, PN_room_1b and 1bb, PN_hashi01_00a and 00b — and
 * each zone lists one: PN_niwa01_03c is the mansion with its doors shut, which
 * zone 1 lists in section 0, and 03a has the doorway standing open, which zones
 * 11 and 12 list in section 4, once the doors have opened in front of the
 * player. A stage made of every zone a set reaches stands them all in one place,
 * modelled on top of each other. The board never does: it draws the one zone
 * the section script last made current (opcode 20), and nothing else. So a stage
 * carries its zones in the order the scripts reach them, and the viewer draws
 * whichever one is picked, opening on the first. Every zone at once stays as a
 * view of its own, versions and all.
 */
function zoneViews(zones, zoneOrder, zoneSections, set = null, zoneSet = null) {
    return [...zones]
        .sort((a, b) => (zoneOrder.get(a) ?? Infinity) - (zoneOrder.get(b) ?? Infinity))
        .map((zone) => ({
            zone,
            set: set ?? zoneSet.get(zone),
            label: `zone ${zone} · section ${runs(zoneSections.get(zone) ?? [])}`,
        }));
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
function placementStage(stages, lit, chapter, { name, set, draws, objects = [], sky = null, zones = [], meta, mixedSets = false }) {
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
        zones,
        /* The view the stage opens in: its first zone, or every placement
         * where it has no zones to choose between. See zoneViews. */
        views: [...zones.map((z, i) => [`zone:${i}`, z.label]),
            ['all', zones.length ? 'Every zone at once' : 'Every placement']],
        view: zones.length ? 'zone:0' : 'all',
        union: 'all',
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
         * which zone the stage opens in — see zoneViews. */
        const groups = new Map();
        const zoneOrder = new Map();
        const zoneSet = new Map();
        const zoneSections = new Map();
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
                            zones: new Set(), sections: new Set(), zoneSections: new Map(),
                            sky: { index: sky.index, on: sky.on !== 0, spin: sky.on === 1 },
                        });
                    }
                    const g = groups.get(set);
                    const zone = dv.getUint32(p + 4, true);
                    g.zones.add(zone);
                    g.sections.add(number);
                    for (const m of [g.zoneSections, zoneSections]) {
                        if (!m.has(zone)) m.set(zone, new Set());
                        m.get(zone).add(number);
                    }
                    if (!zoneOrder.has(zone)) { zoneOrder.set(zone, zoneOrder.size); zoneSet.set(zone, set); }
                });
            }
        });

        /* And which zones each prop is drawn in, for the zone picker. */
        const lives = propZones(rom, chapter, sections, props);
        if (lives) for (const [rec, o] of props) o.zones = lives.get(rec) ?? new Set();

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
            for (const d of listed) {
                reached.add(d.index);
                d.set = set;
                d.zones = zonesOf.get(d.index) ?? new Set();
            }
            const draws = listed;
            if (!widest || draws.length > widest.count) widest = { set, count: draws.length };

            const sky = skyDraws(rom, g.sky);
            const objects = [...props.values()].filter((o) => o.set === set);
            placementStage(stages, lit, chapter, {
                name: `Stage ${chapter + 1} · set ${set}`,
                set,
                draws,
                objects,
                sky,
                zones: zoneViews(g.zones, zoneOrder, g.zoneSections, set),
                meta: [
                    ['texture set', set],
                    ['sections', runs(g.sections)],
                    ['zones', g.zones.size],
                    ['placements', draws.length],
                    ...(objects.length ? [['props', objects.length]] : []),
                    ['sky', sky ? `${sky.dome}${sky.spin ? ', drifting' : ', held'}` : 'off'],
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
            d.zones = zonesOf.get(i) ?? new Set();
            table.push(d);
        }
        const all = table;
        if (all.length && widest) {
            placementStage(stages, lit, chapter, {
                name: `Stage ${chapter + 1} · all placements`,
                set: widest.set,
                draws: all,
                /* The sky of the set that draws most of the chapter, since that
                 * is the set this stage is framed as. */
                sky: skyDraws(rom, groups.get(widest.set)?.sky),
                objects: [...props.values()],
                /* Each zone under the set loaded when it is first made
                 * current, which is the set its pieces are drawn under. */
                zones: zoneViews(zoneOrder.keys(), zoneOrder, zoneSections, null, zoneSet),
                mixedSets: true,
                meta: [
                    ['texture set', `${[...new Set(all.map((d) => d.set))].sort((a, b) => a - b).join(', ')}, per part`],
                    ['placements', table.length],
                    ...(props.size ? [['props', props.size]] : []),
                    ['in no reached zone', table.filter((d) => !reached.has(d.index)).length],
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
export function buildPlacementDisplayList(stage, getModel = null, mode = undefined, view = stage.view) {
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
    /* The zone picked, if one is: only what it lists, under the set it is
     * drawn with (see zoneViews). */
    const zone = /^zone:/.test(view ?? '') ? stage.zones?.[+view.slice(5)] : null;
    /* The props go in under their own layer, so they can be turned off and so
     * the camera frames on the room rather than on them. Under a zone, only
     * those still standing while it is current (see propZones). */
    const objects = (stage.objects ?? [])
        .filter((o) => !zone || !o.zones || o.zones.has(zone.zone)).map((o) => ({
        model: o.model,
        layer: 'objects',
        set: o.set,
        ops: [['t', [o.pos[0], o.pos[1], -o.pos[2]]],
            ...propTurn(o.turn),
            ...(o.scale === 1 ? [] : [['s', [o.scale, o.scale, o.scale]]])],
    }));
    /* Objects a stage builds itself, already in the draw list's own shape —
     * Daytona USA's, whose routines are in js/daytona.js. */
    const built = (stage.objectDraws?.(getModel, mode, view) ?? [])
        .map((d) => ({ layer: 'objects', set: stage.texSets?.[0], ...d }));
    /* And a course left to the camera's window keeps every block, which the
     * window then hides and shows; otherwise only the ones a car reaches. */
    const draws = stage.draws.filter((d) => (zone ? d.zones?.has(zone.zone)
        : view === 'camera' || d.reach !== false));
    return sky.concat(objects, built, draws.map((d) => ({
        model: d.cycle ? d.cycle[0] : d.model,
        anim: d.cycle ? { frames: d.cycle, shift: 0, phase: 0 } : null,
        layer: 'scenery',
        /* Which texture set the piece is drawn under, for a stage that spans
         * several — see the all-placements stage in readPlacementStages. */
        set: zone ? zone.set : d.set,
        ...(d.block != null ? { block: d.block } : {}),
        ops: [['t', [d.pos[0], d.pos[1], -d.pos[2]]],
            ...(d.turn ? [['r', (d.turn * 360) / 0x10000]] : [])],
    })));
}
