/*
 * Virtua Cop's people on the Animation tab: the enemies and hostages of the
 * waves (js/vcop.js), each playing any of the game's motions, as the game's
 * own per-frame routine draws it.
 *
 * A wave record names a body, `0x281EDF0[body]`: a row whose first word is the
 * skeleton (a place per joint) and whose third is the model list, a model per
 * joint. The spawn copies the list into the slot and swaps in the record's
 * variant (a gun, a hat), so the parts are read back from the slot. 55 of the
 * 67 bodies are in a record.
 *
 * A motion is `0x28188DC[motion]`, 1 to 170: its length in frames, then its
 * events. Whoever plays it, the enemy's draw, 0x21A20, does the rest a frame:
 * 0x1EAD0 starts the motion asked for at +0x5F8 and steps its clock (+0x4C,
 * from 1 to the length at +0x610) through the poses 0x23090 copies at boot,
 * 0x1F258 turns the joints' angles into a matrix per joint, 0x21A70 draws a
 * model on each and 0x21C10 the shadow (0xAC) under it. The explorer does
 * what the spawn does with one of the body's records (0x13A90), at the origin
 * and unturned, asks for the motion, and runs 0x21A20 a frame at a time.
 *
 * The enemy's script (0x2820D40[script], read by 0x14118) is what asks for
 * the motions in play: after two words, steps of four (the action, the
 * motion, a mirror flag, a turn), a sequence ending at an action of -1 and
 * another word. Its sequences pick by the shots and the clock, which the
 * explorer has not got, so the body lists the motions its records' scripts
 * name first, and the rest after.
 *
 * A script step can ask for its motion mirrored (+0x8A0), and an enemy
 * whose record's +0x1D is 2 aims: the aim (0x15FC0) puts the bearing and
 * the tilt toward the player at +0x61C and +0x618 and sets +0x630, and the
 * joints (0x1F258) then turn the hips and legs (joints 1 to 8) by how far
 * those are past the body's own (+0x24, +0x20), under an upper body (9 to
 * 15) left as it was. The explorer sets the same.
 *
 * The draw keeps its skeleton to itself, as Dead or Alive's does: the parts'
 * parents are worked out from the frames (js/doafighters.js jointsOf).
 */

import { doaMachine } from './doa.js';
import { jointsOf } from './doafighters.js';
import { MAIN_DATA_BASE } from './romset.js';
import { stageWaves, VCOP_COPRO } from './vcop.js';

const BODY_TABLE = 0x281edf0;
const BODY_COUNT = 67;
const MOTION_TABLE = 0x28188dc;
const MOTION_COUNT = 170;
const SCRIPT_TABLE = 0x2820d40;
const STAGES = 3;
const RAM_BASE = 0x500000;
const ENEMY_SLOTS = 0x50f510;
const ENEMY_SLOT = 0x9f4;
const STAGE_NOW = 0x50f2a8;
const POSE_COPY = 0x23090;
const SPAWN = 0x13a90;
const ENEMY_DRAW = 0x21a20;
const SHADOW = 0xac;
const MIRROR = 0x8a0;
/* The aim's mode (1 turns the upper body, 0x1F258), and its yaw and pitch. */
const AIMING = 0x630;
const AIM_YAW = 0x61c;
const AIM_PITCH = 0x618;
/* Where the explorer writes its copy of a record, out of the game's way. */
const RECORD_AT = 0x5e0000;
const RECORD_BYTES = 0x2c;
/* The slot's model per joint, -1 for none. */
const MODEL_LIST = 0x42c;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const END = 0xffffffff;

/* The record's kinds (+0x00): an enemy, a hostage, and the bosses' four. */
const KIND_NAMES = { 1: 'enemy', 2: 'hostage', 16: 'boss', 32: 'boss', 64: 'boss', 128: 'boss' };

function u32(rom, addr) {
    const off = addr - MAIN_DATA_BASE;
    return off < 0 || off + 4 > rom.mainData.length ? null : rom.mainDataView.getUint32(off, true);
}

/* The motions a script's steps ask for, sequence by sequence, to the first
 * word that is no step. Scripts share their tails, so this runs on into the
 * ones after it, which its sequences jump to. */
function scriptMotions(rom, script) {
    const out = new Set();
    let p = u32(rom, SCRIPT_TABLE + script * 4);
    for (let seq = 0; p && seq < 64; seq++) {
        p += 8;
        let ended = false;
        for (let k = 0; k < 64; k++) {
            const action = u32(rom, p) | 0;
            if (action === -1) {
                p += 8;
                ended = true;
                break;
            }
            const motion = u32(rom, p + 4) | 0;
            if (action < 0 || action > 63 || motion < 0 || motion > MOTION_COUNT) return out;
            if (motion > 0) out.add(motion);
            p += 16;
        }
        if (!ended) break;
    }
    return out;
}

/** Every body a wave record names, with the records' kinds and scripts. */
export function readVcopBodies(rom) {
    const uses = new Map();
    for (let s = 0; s < STAGES; s++) {
        for (const wave of stageWaves(rom, s, { all: true })) {
            for (const rec of wave.records) {
                const kind = rom.mainData[rec - MAIN_DATA_BASE];
                const body = rom.mainData[rec + 0x13 - MAIN_DATA_BASE];
                if (body >= BODY_COUNT) continue;
                const u = uses.get(body) ?? { records: [], kinds: new Set(), stages: new Set(), scripts: new Set(), aims: false };
                u.records.push({ rec, stage: s });
                u.kinds.add(kind);
                u.stages.add(s);
                u.scripts.add(rom.mainData[rec + 0x14 - MAIN_DATA_BASE]);
                /* +0x1D 2 has the aim turn the upper body. */
                if (rom.mainData[rec + 0x1d - MAIN_DATA_BASE] === 2) u.aims = true;
                uses.set(body, u);
            }
        }
    }
    return [...uses.keys()].sort((a, b) => a - b).map((index) => {
        const u = uses.get(index);
        const row = u32(rom, BODY_TABLE + index * 4);
        const kind = [...new Set([...u.kinds].map((k) => KIND_NAMES[k] ?? `kind ${k}`))].join(', ');
        const stages = [...u.stages].sort().map((s) => s + 1).join(', ');
        /* The first record off any object, for the spawn. */
        const first = u.records[0];
        const body = {
            index,
            name: `body ${index} (${kind}, stage ${stages})`,
            joints: 16,
            scale: 1,
            roles: [],
            skin: -1,
            hitMotions: [],
            start: 0,
            root: row,
            record: first.rec,
            stage: first.stage,
            scripts: [...u.scripts],
            aims: u.aims,
        };
        body.parts = [];
        slotModels(rom, body).forEach((model, joint) => {
            if (model >= 0) body.parts.push({ index: body.parts.length, joint, parent: -1, depth: 0, model, offset: [0, 0, 0], flags: 0 });
        });
        return body;
    });
}

/** The motion table, indexed by motion number (0 is none). */
export function readVcopMotions(rom) {
    const list = [null];
    for (let i = 1; i <= MOTION_COUNT; i++) {
        const at = u32(rom, MOTION_TABLE + i * 4);
        const frames = at && at !== END ? u32(rom, at) : 0;
        list[i] = frames > 0 && frames < 0x1000
            ? { index: i, name: `motion ${i}`, address: at, frames, joints: 16, frameSize: 0 }
            : null;
    }
    return list;
}

/** The motions the body's scripts ask for, then the rest. */
export function vcopMotionList(rom, body, motions) {
    const ids = new Set(body.scripts.flatMap((s) => [...scriptMotions(rom, s)]));
    const fits = motions.filter(Boolean);
    return {
        fits,
        lead: fits.filter((m) => ids.has(m.index)),
        label: 'Motions its scripts ask for',
        every: 'Every motion in the table',
        other: 'Every other motion in the table',
    };
}

/* One machine a ROM, booted, with its RAM kept to start each run from. */
const machines = new WeakMap();
function machineOf(rom) {
    if (!machines.has(rom)) {
        const machine = doaMachine(rom, { copro: VCOP_COPRO });
        machine.cpu.call(POSE_COPY);
        machines.set(rom, { machine, boot: machine.ram.slice() });
    }
    return machines.get(rom);
}

/* The spawn (0x13A90) with the body's record, at the origin, unturned and
 * on no object, in a fresh copy of the booted RAM: the slot it took. */
function spawn(rom, body) {
    const { machine, boot } = machineOf(rom);
    const { cpu, ram, rv, copro } = machine;
    ram.set(boot);
    const rec = RECORD_AT - RAM_BASE;
    ram.set(rom.mainData.subarray(body.record - MAIN_DATA_BASE, body.record - MAIN_DATA_BASE + RECORD_BYTES), rec);
    ram.fill(0, rec + 4, rec + 0x12);
    rv.setInt32(rec + 0x18, -1, true);
    rv.setUint32(STAGE_NOW - RAM_BASE, body.stage, true);
    Object.assign(copro, { m: IDENTITY.slice(), stack: [], outQ: [], pending: null });
    cpu.call(SPAWN, [RECORD_AT]);
    const slot = cpu.reg(16) | 0;
    return slot < 0 || slot > 8 ? null : ENEMY_SLOTS + slot * ENEMY_SLOT;
}

/* The models the draw (0x21A70) puts on the joints, from the list the spawn
 * left at +0x42C: the body table's, the root's own among them, with the
 * record's variant swapped in. */
function slotModels(rom, body) {
    const at = spawn(rom, body);
    if (at === null) return [];
    const { rv } = machineOf(rom).machine;
    return Array.from({ length: 16 }, (_, j) => rv.getInt32(at - RAM_BASE + MODEL_LIST + j * 4, true));
}

/**
 * The body's draws a frame through the motion, as 0x21A20 makes them: the
 * spawn with the body's record, then the draw once a frame. Each frame is its
 * parts' draws (model, board 3x4) in order, and the shadow's apart.
 */
export function runVcopMotion(rom, body, motion, frames, { aim = null, mirror = false } = {}) {
    const at = spawn(rom, body);
    if (at === null) return [];
    const { cpu, rv, geo } = machineOf(rom).machine;
    const o = at - RAM_BASE;
    /* The motion asked for, and the script step's mirror flag (the left
     * hand's motion played by the right). */
    rv.setUint32(o + 0x5f8, motion, true);
    rv.setUint32(o + MIRROR, mirror ? 1 : 0, true);
    const out = [];
    for (let f = 0; f < frames; f++) {
        geo.draws = [];
        if (aim) {
            /* Aiming as the aim (0x15FC0) leaves it for a record whose +0x1D
             * is 2: the yaw and pitch toward the player past the body's own,
             * in 65536ths of a turn. */
            rv.setUint32(o + AIMING, 1, true);
            rv.setInt32(o + AIM_YAW, rv.getInt32(o + 0x24, true) + aim.yaw, true);
            rv.setInt32(o + AIM_PITCH, rv.getInt32(o + 0x20, true) + aim.pitch, true);
        }
        if (!cpu.call(ENEMY_DRAW, [at], { maxSteps: 5_000_000 })) break;
        const draws = geo.draws.filter((d) => d.m && d.m.every(Number.isFinite)).map((d) => ({ model: d.model, m: d.m }));
        const parts = draws.filter((d) => d.model !== SHADOW);
        parts.shadows = draws.filter((d) => d.model === SHADOW);
        parts.clock = rv.getUint32(o + 0x4c, true);
        out.push(parts);
    }
    return out;
}

const runs = new WeakMap();
function framesOf(rom, body, motion, opts) {
    if (!runs.has(rom)) runs.set(rom, new Map());
    const cache = runs.get(rom);
    const key = `${body.index}:${motion.index}:${opts.mirror}:${opts.aim?.yaw}:${opts.aim?.pitch}`;
    if (!cache.has(key)) {
        /* One run at a time is kept. */
        cache.clear();
        cache.set(key, runVcopMotion(rom, body, motion.index, motion.frames, opts));
    }
    return cache.get(key);
}

/* A body's skeleton is the same whatever it plays, but a short motion bends
 * too few joints to tell it, so it is worked out once from the longest
 * motions its scripts ask for together. */
const SKELETON_MOTIONS = 6;
const skeletons = new WeakMap();
function skeletonOf(rom, body) {
    if (!skeletons.has(rom)) skeletons.set(rom, new Map());
    const cache = skeletons.get(rom);
    if (!cache.has(body.index)) {
        const { lead, fits } = vcopMotionList(rom, body, readVcopMotions(rom));
        const longest = (lead.length ? lead : fits).slice().sort((a, b) => b.frames - a.frames).slice(0, SKELETON_MOTIONS);
        const frames = longest.flatMap((m) => runVcopMotion(rom, body, m.index, m.frames));
        cache.set(body.index, jointsOf(rom, frames));
    }
    return cache.get(body.index);
}

/* Board matrix (3x3 by columns, then the place) to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/** The frame's draws, a part a place in the draw order, and the shadow;
 * mirrored, and aiming the upper body (65536ths of a turn), as asked. */
export function poseVcopBody(rom, body, motion, frame, { mirrored = false, aim = null } = {}) {
    const aiming = aim && (aim.yaw || aim.pitch) ? aim : null;
    const run = motion ? framesOf(rom, body, motion, { mirror: mirrored, aim: aiming }) : [];
    const at = Math.max(0, Math.min(frame, run.length) - 1);
    const draws = run[at] ?? [];
    const matrices = body.parts.map((p) => toThree(draws[p.index]?.m ?? IDENTITY));
    const joints = skeletonOf(rom, body);
    return {
        matrices,
        origins: matrices.map((e) => [e[12], e[13], e[14]]),
        draws: body.parts.map((p) => (draws[p.index] ? [draws[p.index].model] : [])),
        parents: body.parts.map((p) => joints.parents[p.index] ?? -1),
        joined: body.parts.map((p) => joints.joined[p.index] ?? false),
        shadows: (draws.shadows ?? []).map((d) => ({ model: d.model, r: d.m.slice(0, 9), t: d.m.slice(9, 12) })),
    };
}
