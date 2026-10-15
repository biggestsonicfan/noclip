/*
 * vf2fighters.js — Virtua Fighter 2's fighters, and the motions they play.
 *
 * The rig is Sonic The Fighters' a year early: sixteen part slots, the same
 * keyframe blocks (js/motion.js), and a pose routine at 0x27CE0 that is
 * calc_rob_angle_cont nearly op for op. So the pose comes out of js/pose.js,
 * and what is here is where Virtua Fighter 2 keeps things and the three places
 * it solves differently.
 *
 * The roster. Character set-up (0x13F08) reads the record
 * `ld 0x200620C[char*4]`, with the character number at player +0x1B0:
 *
 *   +0x00  the sixteen part models, copied to player +0x40, which the part
 *          loop at 0x18FE8 draws slot by slot
 *   +0x04  the skeleton: fifteen (x, y, z) offsets copied to player +0x8C, entry
 *          j slot j+1's place in its parent's frame
 *   +0x30  the texture set, handed to the request at 0x4B838; its handler loads
 *          it and the next, as Fighting Vipers' does
 *   +0x3C  thirty-two hand models to the slot (0x19E34 picks the fists and open
 *          hands from it); the part list's own are the ones a motion starts on
 *
 * Fourteen records. Entries 10, 11 and 12 are the one pointer, Lion's record;
 * the name tables call 11 and 12 MUE and KOJACKY, slots the record table fills
 * with Lion. 13 is the first fighter's again with other parts, and no name
 * table reaches it.
 *
 * The motions. A motion id indexes the pointer table at data 0x2120004
 * (`ld 0x2120004[g0*4]` in set-up, 0x1A21C, and in the curve walk, 0x27B5C).
 * Entry 0 points at the table's own end, 1360 entries on, which is its length.
 *
 * The pose differs from Sonic The Fighters' in three places:
 *
 *   - It is solved on one standard rig for everyone, the table at program ROM
 *     0x296A0 (`g6` through 0x2901C and op 0x6B), not on the fighter's own
 *     skeleton: the chest and head offsets, then per limb its pivot and the two
 *     bone lengths op 0x6B reaches with.
 *   - A motion can hold a slot's look as angles instead of a point: a float
 *     object keyed with channel type 1 (13, 14 or 17) is latched by 0x26FAC,
 *     rounded into an angle and flagged at player +0xBDC, and the draw turns
 *     Rz then Ry by it. All but one motion hold the pelvis (17) at
 *     (0, 0, 0x4000) this way, a quarter roll.
 *   - A foot turns from the floor: 0x171B0 loads the matrix the draw saved at
 *     0x501024 — the fighter's place and facing, before any of the pose — and
 *     turns object 2's (or 3's) euler from there.
 *
 * Then the draw (0x16504-0x176A0) places the parts, and only there does the
 * fighter's own skeleton come in: each slot steps out from its parent by the
 * record's offset, turned by its parent's solved matrix, and takes its own
 * rotation from the solve (op 0x69 on the coprocessor address op 0x6B left it
 * at). A fighter whose arms are longer than the standard rig's has hands a
 * little past where the solve put them, as on the board.
 *
 * What the fight adds, played frame after frame:
 *
 *   - The blend (set up at 0x27630): at a motion switch, each angle object's
 *     residual E(new)^T E(old) B, as Y, X, Z angles, is shifted down to a
 *     step at player +0xBE8; the draw turns by it times (N - frame). N comes
 *     from the new motion's length, 8 frames for one longer than 16. The hand
 *     and foot targets blend the same way (0x27730), x and z measured from
 *     the body position. A loop blends into itself. Whether a switch blends
 *     at all, and the blend out some moves end with, are the fight's.
 *   - The head (0x2922C) turns toward the face target at most 0x800 a frame
 *     in yaw and 0x400 in pitch, the pitch held to +-0x2000.
 *   - The crouch (0x29414): characters 6 and 10 draw their body at 0.97 of
 *     its height, 8 at 0.92 (player +0xC50).
 *
 *   - The face target (0x2867C): the fight writes the other fighter's head,
 *     where the draw left it (+0x20C, 0x168A0), over the motion's own at
 *     +0xB0C, moved into this fighter's frame by its place (+0x18) and facing
 *     (+0x26). Player 1 is posed and drawn first, so it looks at player 2's
 *     head of the frame before, and player 2 at player 1's of this one. The
 *     explorer stands an opponent where a round starts it (poseBout).
 *
 * Fighting Vipers poses its fighters with the same routines (its profile's
 * `rig` names the addresses, and the three things it does its own way: the
 * texture set's field, the crouch table and how far the head steps).
 *
 * Left out: when the fight lets the head look at the other fighter (0x500034,
 * +0 and +0x1A4's move flags), as the explorer's opponent is always looked
 * at; and the chest's twist toward it (+0xBE6, 0x2912C), which is the move's.
 */

import { buildPose, poseMatrices, viewerMatrix, turnedBy, SLOT_COUNT, SLOT_PARENT } from './pose.js';
import { decodeMotion, sampleMotion, resolveData } from './motion.js';

/* The record's fields. Fighting Vipers keeps the texture set at +0x20 and
 * names its own (`rig.fighters.texSet`). */
const PARTS = 0x00, SKELETON = 0x04, TEXTURE_SET = 0x30;

/* The standard rig at 0x296A0: chest and head, 12 bytes each, then per limb a
 * pivot and its upper and lower lengths, 20 bytes; the pelvis between the arms
 * and the legs. */
const RIG_LIMBS = [24, 44, 76, 96];
const RIG_HEAD = 12;

/* A data address as {view, off}, in main data or through the XTRA window;
 * null where it does not land. */
function dataAt(rom, addr) {
    const r = resolveData(rom, addr);
    return r && r.off + 4 <= r.data.length ? r : null;
}

const vec = (dv, at) => [0, 4, 8].map((k) => dv.getFloat32(at + k, true));

/** The standard rig every fighter is solved on, in js/pose.js's shape. */
export function standardRig(rom) {
    const dv = rom.mainCpuView;
    const at = rom.game.rig.standardRig;
    return {
        spine: vec(dv, at + RIG_HEAD),
        pivot: RIG_LIMBS.map((o) => vec(dv, at + o)),
        upper: RIG_LIMBS.map((o) => dv.getFloat32(at + o + 12, true)),
        lower: RIG_LIMBS.map((o) => dv.getFloat32(at + o + 16, true)),
    };
}

/* Each slot's place in its parent's frame: slot 0 at the body's own origin,
 * the rest out of the record's fifteen. */
function readOffsets(rom, at) {
    const out = [[0, 0, 0]];
    const r = dataAt(rom, at);
    for (let j = 1; j < SLOT_COUNT; j++) out.push(r ? vec(r.view, r.off + (j - 1) * 12) : [0, 0, 0]);
    return out;
}

function depthOf(slot) {
    let d = 0;
    for (let p = SLOT_PARENT[slot]; p >= 0; p = SLOT_PARENT[p]) d++;
    return d;
}

/**
 * The roster, as the bodies the rig panel lists (see js/bodies.js for the
 * shape): one part per slot, hung off the slot the draw steps out from.
 *
 * @returns {object[]} {index, name, joints, scale, root, texSet, offsets, parts, ...}
 */
export function readFighters(rom) {
    const F = rom.game.rig.fighters;
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const out = [];
    for (let i = 0; i < F.count; i++) {
        const root = u32(F.records + i * 4);
        const list = u32(root + PARTS);
        const offsets = readOffsets(rom, u32(root + SKELETON));
        out.push({
            index: i,
            name: F.names[i] ?? `character ${i}`,
            joints: SLOT_COUNT,
            scale: 1,
            roles: [],
            skin: -1,
            hitMotions: [],
            start: -1,
            root,
            texSet: u32(root + (F.texSet ?? TEXTURE_SET)),
            armour: F.armour ? readArmour(rom, F.armour, i) : null,
            extras: F.armour ? [...readPads(rom, F.armour, i), ...readSkirt(rom, F.armour, i)] : [],
            offsets,
            parts: offsets.map((offset, s) => ({
                index: s, model: u32(list + s * 4), offset, joint: s,
                parent: SLOT_PARENT[s], depth: depthOf(s), flags: 0,
            })),
        });
    }
    return out;
}

/*
 * Fighting Vipers' armour (TECHNICAL.md, "Armour breaking"). `table` is
 * 0x640EDAC[char]: sixteen 8-byte entries, one a slot, bytes 0-3 the pieces
 * each stage throws off (0 ends the list) and +4 the pieces, 0x28 bytes each.
 * efc_crush_parts_set writes a stage's first piece's +4 into the slot (player
 * +0x40), so that is the model the slot shows from then on. `chest` is
 * mune_unit_change's 0x6421F80[char]: for the four fighters it names, a
 * broken chest is one of 31 models (its +4, signed halfwords) a spring picks,
 * 15 + round(spring + 0.5); at rest that is entry `rest`.
 */
const ARMOUR_ENTRY = 8, ARMOUR_PIECE = 0x28, ARMOUR_STAGES = 4;

/* Per slot, the model each stage leaves on it, in order; empty for a slot
 * that never breaks. */
function readArmourSlots(rom, table) {
    const slots = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
        const r = table && dataAt(rom, table + s * ARMOUR_ENTRY);
        const stages = [];
        if (r) {
            const pieces = r.view.getUint32(r.off + 4, true);
            let k = 0;
            for (let st = 0; st < ARMOUR_STAGES; st++) {
                const n = r.view.getUint8(r.off + st);
                if (!n) break;
                const p = dataAt(rom, pieces + k * ARMOUR_PIECE);
                if (!p) break;
                stages.push(p.view.getInt16(p.off + 4, true));
                k += n;
            }
        }
        slots.push(stages);
    }
    return slots;
}

/* The broken chest's model at rest, or null for a fighter with no spring. */
function readRestingChest(rom, A, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const rec = A.chest ? u32(A.chest + i * 4) : 0;
    const list = rec ? u32(rec + 4) : 0;
    const r = list ? dataAt(rom, list + A.rest * 2) : null;
    return r ? r.view.getInt16(r.off, true) : null;
}

function readArmour(rom, A, i) {
    const r = dataAt(rom, A.table + i * 4);
    const table = r ? r.view.getUint32(r.off, true) : 0;
    const slots = readArmourSlots(rom, table);
    if (!slots.some((x) => x.length)) return null;
    return { table, slots, chest: readRestingChest(rom, A, i) };
}

/* damage_unit's halves: slots 0-8 are the upper body, 9-15 the lower. */
const LOWER_FIRST = 9, CHEST = 1;

/*
 * Shoulder pads and skirt (TECHNICAL.md, "Shoulder pads and skirt"). Each is
 * drawn on a slot's matrix as rob_disp leaves it: translate, ang_z, ang_y,
 * ang_x, set_obj; a pad's second model is translated again on the pad's own
 * matrix. The swing each routine adds from the arms or thighs is left out:
 * this is the standing fighter. `hiddenBy` is the slot whose bit in +0x1F48
 * skips the piece. A model of 0 (or -1) is no model, as for the parts.
 *
 * kata_pat_disp (slot 1): 0x642147C[char] points at a left and a right
 * record, 0x24 bytes: +0 model, +4 translate, +0x10/+0x12/+0x14 the X/Y/Z
 * turns (the left's Y negated), +0x16 a second model, +0x18 its translate.
 * The left goes when slot 6 breaks, the right when slot 3 does.
 */
const PAD_SIDES = [{ hiddenBy: 6, flipY: true }, { hiddenBy: 3, flipY: false }];

function readPads(rom, A, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const list = A.pads ? u32(A.pads + i * 4) : 0;
    const out = [];
    PAD_SIDES.forEach(({ hiddenBy, flipY }, side) => {
        const r = list ? dataAt(rom, u32(list + side * 4)) : null;
        if (!r || r.off + 0x24 > r.data.length) return;
        const dv = r.view, o = r.off;
        const model = dv.getInt16(o, true);
        if (model <= 0) return;
        const y = dv.getUint16(o + 0x12, true);
        const pad = {
            slot: CHEST, hiddenBy, model, offset: vec(dv, o + 4),
            turn: [dv.getUint16(o + 0x10, true), flipY ? -y & 0xffff : y, dv.getUint16(o + 0x14, true)],
        };
        out.push(pad);
        const second = dv.getInt16(o + 0x16, true);
        if (second > 0) out.push({ ...pad, model: second, then: vec(dv, o + 0x18) });
    });
    return out;
}

/*
 * kosi_mino_disp (slot 9), for the characters it names: four panels from
 * 0x6421DE0[char * 16] (models at +0..+6, a float at +8), placed by the
 * constants action_init writes to 0x50A324..0x50A378, the same for everyone.
 * Panels 3 and 4 step a further +8 / -(+8) along Z. A thigh has to lift past
 * a panel's limit before it swings, so standing they hang at these turns.
 */
const SKIRT_PANELS = [
    { at: 4, offset: [0.013, 0.087, 0], z: 0 },
    { at: 6, offset: [0.013, -0.088, 0], z: 0 },
    { at: 2, offset: [0, -0.017, 0.107], z: 1 },
    { at: 0, offset: [0, -0.017, -0.107], z: -1 },
];
const SKIRT_TURN = [0x4000, 0xc000, 0], HIPS = 9;

function readSkirt(rom, A, i) {
    const r = A.skirt?.chars.includes(i) ? dataAt(rom, A.skirt.table + i * 16) : null;
    if (!r) return [];
    const dv = r.view, f = dv.getFloat32(r.off + 8, true);
    return SKIRT_PANELS.map(({ at, offset, z }) => ({
        slot: HIPS, hiddenBy: HIPS, model: dv.getInt16(r.off + at, true),
        offset: [offset[0], offset[1], offset[2] + z * f], turn: SKIRT_TURN,
    })).filter((e) => e.model > 0);
}

/* A pad or panel's board-frame transform on its slot's. */
function placeExtra(slot, e) {
    const at = (r, t, o) => [0, 1, 2].map((k) => t[k] + r[k] * o[0] + r[3 + k] * o[1] + r[6 + k] * o[2]);
    const t = at(slot.r, slot.t, e.offset);
    const r = turnedBy(slot.r, e.turn[0], e.turn[1], e.turn[2]);
    return { r, t: e.then ? at(r, t, e.then) : t };
}

export const ARMOUR_STATES = [
    { id: 'intact', label: 'Intact', upper: false, lower: false },
    { id: 'upper', label: 'Upper broken', upper: true, lower: false },
    { id: 'lower', label: 'Lower broken', upper: false, lower: true },
    { id: 'all', label: 'All broken', upper: true, lower: true },
];

/**
 * The fighter as a hit that breaks a half leaves it: in the board one hit runs
 * every slot of the half through all its stages, so each broken slot shows
 * its last stage's model, and a chest with a spring its resting model.
 *
 * @param {object} body from readFighters
 * @param {string} state one of ARMOUR_STATES' ids
 * @returns {object} the body, or a copy with its parts' models swapped
 */
export function armouredFighter(body, state) {
    const A = body.armour;
    const which = ARMOUR_STATES.find((x) => x.id === state);
    if (!A || !which || (!which.upper && !which.lower)) return body;
    const broken = (s) => (s < LOWER_FIRST ? which.upper : which.lower) && A.slots[s].length > 0;
    const extras = body.extras.filter((e) => !broken(e.hiddenBy));
    const parts = body.parts.map((p) => {
        if (!broken(p.index)) return p;
        const last = A.slots[p.index][A.slots[p.index].length - 1];
        const model = p.index === CHEST && A.chest != null ? A.chest : last;
        return { ...p, model: model > 0 ? model : 0 };
    });
    return { ...body, parts, extras };
}

/**
 * Every motion in the table, decoded, indexed by id (holes are null).
 */
export function readFighterMotions(rom) {
    const M = rom.game.motionTable;
    const list = [];
    for (let id = 0; id < M.count; id++) {
        const d = decodeMotion(rom, id);
        list.push(d ? { ...d, index: id, name: `motion ${id}`, joints: SLOT_COUNT } : null);
    }
    return list;
}

/** Any motion plays on any fighter; nothing in the record names its own. */
export function fighterMotionList(rom, body, motions) {
    return { fits: motions.filter(Boolean), lead: [], label: '', every: 'Every motion in the table' };
}

const REST = {
    angles: new Uint16Array(36),
    targets: new Float32Array(24),
    targetUsed: new Uint8Array(8),
};

/*
 * Step the solved slots out along the fighter's own skeleton, parent first:
 * each keeps its rotation and moves to its parent's place plus the parent's
 * matrix times its offset. The board's frame turns both sides alike, so this
 * works on buildPose's output as it stands.
 */
function onOwnSkeleton(pose, offsets) {
    for (let s = 1; s < SLOT_COUNT; s++) {
        const { r, t } = pose[SLOT_PARENT[s]];
        const o = offsets[s];
        pose[s].t = [0, 1, 2].map((k) => t[k] + r[k] * o[0] + r[k + 3] * o[1] + r[k + 6] * o[2]);
    }
    return pose;
}

/*
 * Float objects a motion holds as angles instead of keying as a point. The
 * set-up at 0x26FAC takes an object whose channels are latched type 1, rounds
 * its three floats into the player's angle table (0x29724) and sets the
 * object's bit at +0xBDC; 0x2901C then turns the part by them, Z then Y, in
 * place of the aim. All but one of the 1359 motions hold the pelvis, float
 * object 17, at (0, 0, 0x4000): the quarter-turn roll of Sonic the Fighters,
 * given as data. The chest (13) and head (14) could be held the same way.
 */
const HELD = [[13, 1], [14, 2], [17, 9]];
const LATCHED_ANGLES = 1;

function heldAngles(rom, motion) {
    const held = {};
    for (const [obj, slot] of HELD) {
        const ch = motion.channels.slice(obj * 3, obj * 3 + 3);
        if (ch.some((c) => c.type !== LATCHED_ANGLES)) continue;
        const v = ch.map((c) => Math.round(c.view.getFloat32(c.values, true)));
        held[slot] = [v[1], v[2]];
    }
    return held;
}

/*
 * The crouch (0x29414): three fighters stand lower than their motions, the
 * body's height scaled by a constant; the draw adds the difference (+0xC50).
 * Keyed by character, so Lion's other two slots stand at full height. A game
 * with its own table names it as `rig.crouch`.
 */
const CROUCH = { 6: 0.97, 8: 0.92, 10: 0.97 };

/*
 * The blend between motions. When a motion takes over, the set-up at 0x27630
 * works out, for each of the twelve angle objects, the turn that takes the
 * new motion's first frame back to the pose last drawn (op 0x2A005454, as Y, X
 * and Z angles), and an eighth of it is the step. The pose routine adds what
 * is left after each object's euler (+0xBE8), seven steps on the first frame,
 * one fewer each frame after, none from the eighth. Measured against MAME's
 * attract mode, the steps are the residual shifted right three, exactly. The
 * eight points blend the same way, an eighth of old less new a step, with
 * each point's x and z measured from the body's (0x272A4), so the body keeps
 * its place on the floor and only its height blends.
 *
 * How long is the new motion's to say: set-up (0x27130) takes its frame count
 * (+0x800) and blends 8 frames into one longer than 16, 4 into one of 9 to
 * 16, 2 into 5 to 8, 1 into 3 or 4, and none into a shorter one; the step is
 * the residual shifted by 3, 2 or 1 (0x2760C). Whether a switch blends at all
 * is the fight's (move flags at +0x1A4, +0xC30 and +0x814), as is the blend
 * out toward a stance pose some moves end with; the explorer blends every
 * switch in and none out.
 */
const blendLength = (frames) => (frames > 16 ? 8 : frames > 8 ? 4 : frames > 4 ? 2 : frames > 2 ? 1 : 0);
const blendShift = (n) => (n === 8 ? 3 : n === 4 ? 2 : 1);

const rad = (a) => (a * Math.PI) / 0x8000;
const brad = (r) => Math.round((r * 0x8000) / Math.PI);
const mul3 = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
function turn(axis, a) {
    const c = Math.cos(rad(a)), s = Math.sin(rad(a));
    if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
    if (axis === 1) return [[c, 0, -s], [0, 1, 0], [s, 0, c]];
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
const eulerOf = ([x, y, z]) => mul3(mul3(turn(2, z), turn(1, y)), turn(0, x));
const blendOf = ([x, y, z]) => mul3(mul3(turn(1, y), turn(0, x)), turn(2, z));

/* The (x, y, z) that blendOf turns back into `m`. */
function yxzOf(m) {
    return [brad(Math.asin(-m[1][2])), brad(Math.atan2(-m[0][2], m[2][2])), brad(Math.atan2(m[1][0], m[1][1]))];
}

const tripleAt = (angles, obj) => [0, 1, 2].map((k) => (angles[obj * 3 + k] << 16) >> 16);

/* Per object, the step that walks from the last pose drawn to the new one. */
function blendSteps(fromAngles, fromBlend, toAngles, shift) {
    return Array.from({ length: 12 }, (_, obj) => {
        const was = mul3(eulerOf(tripleAt(fromAngles, obj)), blendOf(fromBlend[obj]));
        const now = eulerOf(tripleAt(toAngles, obj));
        const back = mul3(now.map((_, i) => now.map((row) => row[i])), was);
        return yxzOf(back).map((v) => v >> shift);
    });
}

/* The same for the points, x and z taken from the body's. */
function pointSteps(from, to, shift) {
    const rel = (t, i) => t[i] - (i % 3 === 1 ? 0 : t[i % 3]);
    return Array.from(from, (_, i) => (rel(from, i) - rel(to, i)) / (1 << shift));
}

/*
 * The head's look (0x2922C): it turns toward the face target at most 0x800 a
 * frame and pitches at most 0x400, the pitch kept within 0x2000 of level. A
 * target behind the head's plane is brought level with it, and one just
 * behind and to the side leaves a head turned fully one way as it is. Under
 * playback the explorer steps; on a frame picked on its own the head is where
 * the steps would end.
 */
const LOOK_TURN = 0x800, LOOK_PITCH = 0x400, LOOK_PITCH_LIMIT = 0x2000;
const LOOK = { turn: LOOK_TURN, pitch: LOOK_PITCH };
const s16 = (v) => (v << 16) >> 16;
const stepTo = (from, to, max) => from + Math.max(-max, Math.min(max, to - from));

export function headStep([ay, az], [d0, d1, d2], free = false, { turn, pitch } = LOOK) {
    let keep = false;
    if (d1 < 0) {
        d1 = 0;
        keep = d0 >= 0 ? d0 <= 0.5 && (az & 0xffff) === 0x8000 : d0 >= -0.5 && (az & 0xffff) === 0;
    }
    const turnTo = -brad(Math.atan2(d1, d0)), pitchTo = brad(Math.atan2(d2, Math.hypot(d0, d1)));
    const z = keep ? az : s16(free ? turnTo : stepTo(az, turnTo, turn));
    const y = free ? pitchTo : stepTo(ay, pitchTo, pitch);
    return [Math.max(-LOOK_PITCH_LIMIT, Math.min(LOOK_PITCH_LIMIT, y)), z];
}

/*
 * Fighting Vipers steps the head as far again when it is following the
 * motion's own target: 0x2B274 clears player +0x7D7, sets it only where the
 * fight writes the other fighter's head over the target (the same tests as
 * 0x286A0 here), and 0x2BE0C steps 0x2000 in both while it is clear. Its
 * profile gives that as `rig.look.own`; the explorer's fighter alone looks at
 * its own target, one in a bout at the opponent's head.
 */
function lookLimits(rom, faceTarget) {
    const own = rom.game.rig.look?.own;
    return own && !faceTarget ? { turn: own, pitch: own } : LOOK;
}

/* What each fighter carries from one frame to the next under playback: the
 * last frame's sample, the blend then and its steps, and the head's look. */
const LIVE = new WeakMap();
const ZERO_BLEND = Array.from({ length: 12 }, () => [0, 0, 0]);

function liveFor(body) {
    let live = LIVE.get(body);
    if (!live) {
        live = { motion: null, frame: 0, last: null, blend: ZERO_BLEND, steps: null, points: null, length: 0, look: [0, 0] };
        LIVE.set(body, live);
    }
    return live;
}

/* The blend for this frame, added to the sample's points in place: a new
 * motion takes its steps from the last frame drawn; they run out on the
 * eighth frame or when the motion loops. */
function startBlend(live, rom, motion) {
    live.length = motion ? blendLength(motion.frames) : 0;
    const first = live.last && live.length ? sampleMotion(rom, motion, 1) : null;
    const shift = blendShift(live.length);
    live.steps = first && blendSteps(live.last.angles, live.blend, first.angles, shift);
    live.points = first && pointSteps(live.last.targets, first.targets, shift);
}

function blendFor(live, rom, motion, frame, sample) {
    /* A motion that loops, back to its first frame from its last, blends into
     * itself as into a new one; one cut short and started again does not. */
    if (motion !== live.motion || (frame === 1 && motion && live.frame === motion.frames)) {
        startBlend(live, rom, motion);
    } else if (frame < live.frame) {
        live.steps = live.points = null;
    }
    const left = live.length - frame;
    const blending = live.steps && left > 0;
    // The next switch blends out of the targets as drawn, this blend included.
    if (blending) live.points.forEach((v, i) => { sample.targets[i] += v * left; });
    if (motion !== live.motion || frame !== live.frame) live.last = { angles: sample.angles, targets: sample.targets.slice() };
    return (live.blend = blending ? live.steps.map((t) => t.map((v) => v * left)) : ZERO_BLEND);
}

/**
 * Pose a fighter on one frame of a motion, in the viewer's frame. The body
 * position is the motion's, step and all: the hand and foot targets are in the
 * same space, so taking the step out of one would leave the limbs reaching for
 * where the other went.
 *
 * Played frame after frame, the fighter blends into each new motion and its
 * head turns toward the face target a step at a time, as on the board. On its
 * own the head follows the motion's own target; poseBout gives it an opponent
 * to look at. The chest does not twist.
 *
 * @param {{faceTarget?: number[]}} [opts]  `faceTarget` takes the place of
 *   the motion's (float object 2, in the targets' space), as the fight writes
 *   the other fighter's head over it at player +0xB0C.
 * @returns {{matrices: number[][], origins: number[][], extras: number[][]}}
 *   `extras` places body.extras (the pads and skirt), one each.
 */
export function poseFighter(rom, body, motion, frame, { faceTarget } = {}) {
    rom.vf2Rig ??= standardRig(rom);
    const live = liveFor(body);
    const sample = motion ? sampleMotion(rom, motion, frame) : REST;
    /* Playback moves on a frame, or starts the next motion or loop at 1. */
    const stepped = live.motion !== null && (frame === live.frame + 1 || frame === 1);
    const fresh = motion !== live.motion || frame !== live.frame;
    const fight = {
        held: motion ? heldAngles(rom, motion) : {},
        blend: blendFor(live, rom, motion, frame, sample),
        look: (local) => (fresh ? (live.look = headStep(live.look, local, !stepped, lookLimits(rom, faceTarget))) : live.look),
    };
    live.motion = motion; live.frame = frame;
    if (faceTarget && motion) faceTarget.forEach((v, i) => { sample.targets[6 + i] = v; });
    const pose = onOwnSkeleton(buildPose(rom.vf2Rig, sample, { levelFeet: true, fight }), body.offsets);
    const crouch = (rom.game.rig.crouch ?? CROUCH)[body.index];
    if (crouch) for (const s of pose) s.t[1] += sample.targets[1] * (crouch - 1);
    const matrices = poseMatrices(pose);
    const origins = matrices.map((m) => [m[12], m[13], m[14]]);
    live.head = origins[2];
    const extras = (body.extras ?? []).map((e) => viewerMatrix(placeExtra(pose[e.slot], e)));
    return { matrices, origins, extras };
}

/*
 * The opponent. A round starts the fighters at x = -1 and +1 (the stores of
 * -1.0 and 1.0 to player +0x18), facing each other, so the explorer stands one
 * 2 ahead of the fighter, turned half round. Ahead is the motions' +z, which
 * is the viewer's +x (js/pose.js turns the one into the other), so in the
 * fighter's viewer frame the opponent's (x, y, z) is (2 - x, y, -z), and
 * the other way round the same.
 *
 * Ahead is where the fight mostly has it, not where a motion says it is. The
 * move script turns a fighter round (0x1B454: with move flag +0x1A4 bit 20
 * set, it flips bit 15 of the facing at +0x26), and a back-turned fighter
 * plays its motions with the other one behind: measured over MAME's attract
 * mode, the opponent stands at the motions' -z through sixteen of the
 * motions played, and the motions' own face target does not tell those from
 * the rest. So the explorer can stand it behind as well, 2 back along -z and
 * facing the fighter's back: (x - 2, y, z).
 */
export const OPPONENT_DISTANCE = 2;

/** Where the opponent's parts go: its viewer frame into the fighter's. */
export function opponentMatrix({ behind = false, distance = OPPONENT_DISTANCE } = {}) {
    return behind
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -distance, 0, 0, 1]
        : [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, distance, 0, 0, 1];
}

/* A point through a placement (column-major 4x4), or back through it: the
 * placement is a turn and a step, so its inverse is the turn transposed. */
function placed(P, [x, y, z]) {
    return [0, 1, 2].map((k) => P[k] * x + P[k + 4] * y + P[k + 8] * z + P[k + 12]);
}
function unplaced(P, v) {
    const d = [0, 1, 2].map((k) => v[k] - P[k + 12]);
    return [0, 1, 2].map((k) => P[k * 4] * d[0] + P[k * 4 + 1] * d[1] + P[k * 4 + 2] * d[2]);
}

/* The other fighter's head, as last posed, in the motions' space of the one
 * looking at it: across to the looker's viewer frame, then as (z, y, x). */
function headSeenFrom(other, across) {
    const h = LIVE.get(other)?.head;
    if (!h) return undefined;
    const [x, y, z] = across(h);
    return [z, y, x];
}

/**
 * Pose a fighter and an opponent facing it, each head turning toward the
 * other's as the fight turns it: the first, player 1, looks at where the
 * opponent's head was last drawn, and the opponent then at the first's of
 * this frame. Each is {body, motion, frame}; the opponent's body has to be an
 * object of its own, as it carries its own playback.
 *
 * Checked against MAME's attract mode at the places and facings the board had:
 * the target matches the board's +0xB0C to 0.00001 wherever the fight looks at
 * the other fighter. When it looks is fight state, which this does not have:
 * the store at 0x286A0 is skipped by the round state (0x500034), the
 * fighter's status (+0 & 0xA00000) and the move flags (+0x1A4 & 0x6C111),
 * which the move script sets as the move plays. This looks on every frame, so
 * where the game keeps the motion's own target the head turns where the
 * game's doesn't.
 *
 * @param {number[]} [place]  where the second stands, opponentMatrix()'s
 * @returns {Array<{matrices: number[][], origins: number[][]}>} each in its
 *   own viewer frame; `place` puts the second in the first's.
 */
export function poseBout(rom, [first, second], place = opponentMatrix()) {
    const one = poseFighter(rom, first.body, first.motion, first.frame,
        { faceTarget: headSeenFrom(second.body, (h) => placed(place, h)) });
    const two = poseFighter(rom, second.body, second.motion, second.frame,
        { faceTarget: headSeenFrom(first.body, (h) => unplaced(place, h)) });
    return [one, two];
}
