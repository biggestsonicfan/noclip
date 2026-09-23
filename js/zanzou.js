/*
 * zanzou.js — the afterimage trails a fighter's hand, feet or hips leave on a
 * move ("zanzou", 残像).
 *
 * The main CPU keeps no trail at all. The coprocessor does: it remembers where
 * each body part's matrix was last frame, lays blended copies of it into a ring
 * of 128 slots in its own data memory, ages them, and hands each back to be
 * drawn. The i960's part in it is three small routines:
 *
 *   The motion script turns it on. Action 0x26 in `play_motion` (`0x1C8FC`) is a
 *   13-byte command, `[op][frame u16][mask u16][life step s16][turn u16][spacing
 *   f32]`, which stores the part mask at `P1+0xC60`, the step at `+0xC62`, the
 *   turn at `+0xA1E` and the spacing into the global `zanzou_ma`. A mask of zero
 *   turns it off, and `set_mot_dat` clears the mask whenever a motion starts, so
 *   a trail nobody turns off lasts to the end of its motion. 134 of these are
 *   spread through 50 motions; every one is marked to run even on a skipped
 *   frame. The spacing only ever changes the global — `send_zanzou_data` sets it
 *   to 0.1 at boot, and every command that turns a trail off writes 0.1 back.
 *
 *   `zanzou_control` (`0x8AA38`) talks to the coprocessor once a frame: the
 *   spacing into its DM, `Fn_zanzou_inc` (0x82) to age every copy, and then per
 *   fighter either `Fn_zanzou_kill_timer_buffer` (0x86) when its mask is zero,
 *   or `Fn_zanzou_reserve` (0x80) — the mask, the step, the bone length from
 *   `0xB5258[skeleton][char]`, and for each part in the mask the three models
 *   the copies fade through, u16s at `table[char] + part * 8`. The table is
 *   `0xB540C[skeleton]`, or `0xB55BC` while the fighter holds an option (bit 27
 *   of `P1+0`, which only changes anything for the mirror Sonic). A fighter
 *   facing the other way has the mask's left and right swapped; the viewer's
 *   never does.
 *
 *   `zanzou_disp` (`0x8ACD0`, from `tobi_disp`) draws. For each of the 128 ring
 *   slots it asks `Fn_zanzou_get_info` (0x85) for the copy's life and model and
 *   skips a dead one — and skips a live one on every other frame, by the parity
 *   of `frame_counter + slot`. That is the whole of the fade: there is no
 *   translucency, the copies flicker, and neighbouring copies flicker out of
 *   step. A drawn copy is push, `Fn_zanzou_mul_matrix_inner` (0x84) composing
 *   the copy's stored matrix onto the current one, an X turn by a halfword of
 *   the projectile module's header that nothing writes (0 on the board, read
 *   live), `set_obj`, pop.
 *
 * The ring itself is ported from m2-hle2's `sharc_zanzou.h`, which has it from
 * cpres1 PM 0x208E1..0x20A8E. Each frame the firmware measures how far the
 * trailing parts moved — the joint, and a point one bone length out along the
 * part's own +X — and lays one copy per `spacing` units of the farthest, each
 * a linear blend of last frame's matrix towards this frame's, capped at 100 a
 * part. More than 13 squared units in one frame is a teleport and lays none.
 *
 * The copies are the matrices of the unit cache, which are the matrices each
 * part is drawn with, in world space — the same thing `buildPose` answers — so
 * the ring runs on the pose as it is. It keeps history, so it can only be
 * stepped forward: a scrub backwards or a jump replays the motion from its
 * first frame.
 *
 * Graded against the board: stf-tools/test-zanzou-mame.mjs runs this ring from
 * snapshots of MAME's SHARC data memory, each taken with a reserve's header done
 * and nothing laid, and holds it against the next. On 900 chained reserves of a
 * fight — one hand, both hands, both feet, the pelvis, a turning trail, a wide
 * spacing — every one reproduces the firmware's next ring exactly, matrices to
 * float32 rounding.
 */

import { readMotionScript, motionSkeletonType, commandsBy } from './motion.js';
import { coproSin, coproCos } from './pose.js';

const TRAIL_OP = 0x26;
/* `send_zanzou_data` sets zanzou_ma to 0.1 and writes 3 into DM 0x32182, the
 * life a part's first copy starts from — at boot. Fn_zanzou_init clears 0x5480
 * words from 0x32180 when a fight sets up, that one included, and only the
 * spacing beside it is written again (by zanzou_control, every frame). So in a
 * fight a first copy starts at 0: MAME's SHARC holds 0 there at every one of
 * 901 captured reserves (stf-tools/test-zanzou-mame.mjs). */
const SPACING_BOOT = 0.1;
const LIFE0_IN_FIGHT = 0;

const RING_SLOTS = 128;
const PART_COUNT = 16;
const MAX_COPIES = 100;       /* spacing clamped to 0.01 of the move */
const TELEPORT = 13.0;        /* squared world units in one frame */

/* `zanzou_control`'s tables, indexed by `P1+0x84C` (the motion's skeleton type)
 * and then by the character byte `P1+0x1B0`. */
const BONE_LENGTH_TABLES = 0x000b5258;
const MODEL_TABLES = 0x000b540c;
const MODEL_ENTRY = 8;

/**
 * The trail commands in one motion's script, and the models and bone length
 * the fighter's reserve would send with them. Null when the motion lays none.
 */
export function readTrails(rom, motionId, charIndex, { squished = false } = {}) {
    const dv = rom.mainCpuView;
    const records = [];
    for (const c of readMotionScript(rom, motionId)) {
        if (c.op !== TRAIL_OP) continue;
        records.push({
            frame: c.frame,
            mask: dv.getUint16(c.at + 3, true),
            step: dv.getInt16(c.at + 5, true),
            turn: dv.getUint16(c.at + 7, true),
            spacing: dv.getFloat32(c.at + 9, true),
        });
    }
    if (!records.length) return null;

    /* The squished form is skeleton type 2, which shares type 0's tables. */
    const skel = squished ? 2 : motionSkeletonType(rom, motionId);
    return { records, ...trailTables(rom, charIndex, skel), skeletonType: skel };
}

/**
 * What `zanzou_control` sends for a fighter whatever the motion: the bone length
 * and, per part, the three models its copies fade through.
 */
export function trailTables(rom, charIndex, skel) {
    const dv = rom.mainCpuView;
    const inRom = (a) => a > 0 && a + 4 <= rom.maincpu.length;
    const boneTable = dv.getUint32(BONE_LENGTH_TABLES + skel * 4, true);
    const bone = inRom(boneTable) ? dv.getFloat32(boneTable + charIndex * 4, true) : 0;
    const modelTable = dv.getUint32(MODEL_TABLES + skel * 4, true);
    const entries = inRom(modelTable) ? dv.getUint32(modelTable + charIndex * 4, true) : 0;
    const models = [];
    for (let p = 0; p < PART_COUNT; p++) {
        const at = entries + p * MODEL_ENTRY;
        models.push(inRom(entries) && at + 6 <= rom.maincpu.length
            ? [0, 2, 4].map((o) => dv.getUint16(at + o, true))
            : [0, 0, 0]);
    }
    return { bone, models };
}

/** Every model a motion's trails can draw, for uploading ahead of time. */
export function trailModels(trails) {
    const ids = new Set();
    for (const r of trails.records) {
        for (let p = 0; p < PART_COUNT; p++) {
            if (r.mask >> p & 1) for (const id of trails.models[p]) if (id) ids.add(id);
        }
    }
    return [...ids];
}

/* What the motion's script has left in `P1+0xC60` and friends by `frame`. */
function commandAt(trails, frame) {
    return commandsBy(trails.records, frame).at(-1) ?? null;
}

/** The trail command in effect at `frame`, or null before the first. */
export function trailCommandAt(trails, frame) {
    return commandAt(trails, frame);
}

/** The trail the script has on at `frame`: its mask, or 0. */
export function trailMaskAt(trails, frame) {
    return commandAt(trails, frame)?.mask ?? 0;
}

function newRing() {
    return Array.from({ length: RING_SLOTS }, () => ({
        part: 0, life: 0, step: 0, turnOwed: false, objs: [0, 0, 0],
        m: new Float64Array(12),
    }));
}

/**
 * A fresh coprocessor state for one fighter: an empty ring, no timers, and no
 * last frame yet.
 */
export function createTrailSim(trails) {
    return {
        trails,
        ring: newRing(),
        write: 0,
        timers: new Int32Array(PART_COUNT),
        lastMask: 0,
        attr: Array.from({ length: PART_COUNT }, () => [0, 0, 0]),
        life0: LIFE0_IN_FIGHT,
        prev: null,          /* last frame's 16 unit matrices */
        frame: 0,            /* the motion frame last stepped */
        spacing: SPACING_BOOT,
    };
}

/* A pose slot as the coprocessor's twelve words: col0, col1, col2, T. */
function unitWords(slot) {
    const w = new Float64Array(12);
    w.set(slot.r, 0);
    w[9] = slot.t[0]; w[10] = slot.t[1]; w[11] = slot.t[2];
    return w;
}

/* Fn_zanzou_inc (PM 0x20911): every live copy ages by its own step, and one that
 * crosses zero is dead. Exported, with `reserve`, so a capture of the board's
 * own ring can be run through them one command at a time. */
export function age(sim) {
    for (const s of sim.ring) {
        if (s.life === 0) continue;
        s.life += s.step;
        if (s.life < 0) s.life = 0;
    }
}

/* One part's run of copies (PM 0x20A17). */
function spawn(sim, part, stepf, cur, prv, cmd) {
    const t0 = sim.timers[part];
    let life = t0 !== 0 ? t0 - 1 : sim.life0;
    const delta = new Float64Array(12);
    for (let k = 0; k < 12; k++) delta[k] = cur[k] - prv[k];
    let t = 0;
    for (;;) {
        const s = sim.ring[sim.write];
        s.part = part;
        s.life = life;
        s.step = cmd.step;
        s.turnOwed = cmd.turn !== 0;
        s.objs = sim.attr[part];
        for (let k = 0; k < 12; k++) s.m[k] = delta[k] * t + prv[k];
        life++;
        sim.write = (sim.write + 1) % RING_SLOTS;
        if (!(stepf > 0)) break;
        t += stepf;
        if (!(t < 1)) break;
    }
    sim.timers[part] = life;
}

/* PM 0x20A6D: each copy laid this frame is turned once about its own X. */
function turnOwed(sim, turn) {
    const c = coproCos(turn & 0xffff), s = coproSin(turn & 0xffff);
    for (const slot of sim.ring) {
        if (!slot.turnOwed) continue;
        slot.turnOwed = false;
        const m = slot.m;
        for (let k = 0; k < 3; k++) {
            const a = m[3 + k], b = m[6 + k];
            m[3 + k] = c * a - s * b;
            m[6 + k] = s * a + c * b;
        }
    }
}

/* Fn_zanzou_reserve (PM 0x20961), header to terminator: `cmd` is the mask, step
 * and turn, `units` this frame's sixteen unit matrices, `sim.prev` last frame's. */
export function reserve(sim, cmd, units) {
    const { mask } = cmd;
    const changed = mask ^ sim.lastMask;
    for (let b = 0; b < PART_COUNT; b++) if (changed >> b & 1) sim.timers[b] = 0;
    sim.lastMask = mask;
    for (let b = 0; b < PART_COUNT; b++) {
        if (mask >> b & 1) sim.attr[b] = sim.trails.models[b];
    }

    /* PM 0x209AE: the farthest any trailing part moved since last frame. */
    const s = sim.trails.bone;
    let far2 = 0;
    for (let b = 0; b < PART_COUNT; b++) {
        if (!(mask >> b & 1)) continue;
        const c = units[b], p = sim.prev[b];
        let d0 = c[9] - p[9], d1 = c[10] - p[10], d2 = c[11] - p[11];
        far2 = Math.max(far2, d0 * d0 + d1 * d1 + d2 * d2);
        d0 = (c[9] + s * c[0]) - (p[9] + s * p[0]);
        d1 = (c[10] + s * c[1]) - (p[10] + s * p[1]);
        d2 = (c[11] + s * c[2]) - (p[11] + s * p[2]);
        far2 = Math.max(far2, d0 * d0 + d1 * d1 + d2 * d2);
    }
    if (far2 >= TELEPORT) return;

    let stepf = sim.spacing / Math.sqrt(far2);
    if (stepf === 0) stepf = 1;
    if (!(stepf > 1 / MAX_COPIES)) stepf = 1 / MAX_COPIES;

    for (let b = 0; b < PART_COUNT; b++) {
        if (mask >> b & 1) spawn(sim, b, stepf, units[b], sim.prev[b], cmd);
        else sim.timers[b] = 0;
    }
    turnOwed(sim, cmd.turn);
}

/**
 * Run the coprocessor through one board frame of the motion.
 * @param {object} sim    from createTrailSim
 * @param {number} frame  the motion frame `pose` is at
 * @param {Array<{r:number[], t:number[]}>} pose  from buildPose
 */
export function stepTrails(sim, frame, pose) {
    const units = pose.map(unitWords);
    /* 0x7F leaves last frame's unit matrices behind at the top of a frame; on
     * the first frame there is no last frame, and nothing has moved. */
    if (!sim.prev) sim.prev = units;
    const cmd = commandAt(sim.trails, frame);
    /* The script runs before the frame is drawn, so a command on this frame
     * already counts; a motion starting again has had its mask cleared. */
    const mask = cmd?.mask ?? 0;
    sim.spacing = cmd ? cmd.spacing : SPACING_BOOT;

    age(sim);
    if (mask === 0) sim.timers.fill(0);
    else reserve(sim, cmd, units);

    sim.prev = units;
    sim.frame = frame;
}

/* Fn_zanzou_get_info (PM 0x208E6): the model by how much life is left — two
 * thresholds built off the step, in the firmware's own unsigned arithmetic. */
function pickModel(slot) {
    const mag = Math.abs(slot.step) >>> 0;
    const t1 = ((mag >>> 1) + mag) | 0;
    const q = ((mag >>> 2) - 1) >>> 0;
    const t0 = (Math.imul(q, 7) + 0x28) | 0;
    if (t0 < slot.life) return slot.objs[0];
    if (t1 < slot.life) return slot.objs[1];
    return slot.objs[2];
}

/**
 * What `zanzou_disp` draws on display frame `tick`: every live copy whose slot
 * and the counter make an odd sum.
 * @returns {Array<{model:number, r:number[], t:number[], slot:number}>}
 */
export function trailDraws(sim, tick) {
    const out = [];
    sim.ring.forEach((s, n) => {
        if (s.life <= 0 || !((tick + n) & 1)) return;
        const model = pickModel(s);
        if (!model) return;
        out.push({
            model, slot: n,
            r: Array.from(s.m.subarray(0, 9)),
            t: [s.m[9], s.m[10], s.m[11]],
        });
    });
    return out;
}

/** How many copies are alive — what 0x82 answers. */
export function liveCopies(sim) {
    return sim.ring.reduce((n, s) => n + (s.life > 0 ? 1 : 0), 0);
}
