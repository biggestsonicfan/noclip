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
 * Fourteen records; 10, 11 and 12 are the same one (Lion), and 13 is the first
 * fighter's again with other parts.
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
 *   - The pelvis is aimed at its target, float object 17, as the chest is at
 *     its own (0x2901C with g1 = 3, the results at +0x170/+0x172), where the
 *     later game rolls it a quarter turn.
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
 * Left out, all game-side and zero in a motion played on its own: the lean at
 * player +0xBE6, the additive eulers at +0xBA8, the hand and foot turns at
 * +0x15A and +0x17C, and the crouch offset at +0xC50.
 */

import { buildPose, poseMatrices, SLOT_COUNT, SLOT_PARENT } from './pose.js';
import { decodeMotion, sampleMotion } from './motion.js';
import { MAIN_DATA_BASE } from './romset.js';

/* The record's fields. */
const PARTS = 0x00, SKELETON = 0x04, TEXTURE_SET = 0x30;

/* The standard rig at 0x296A0: chest and head, 12 bytes each, then per limb a
 * pivot and its upper and lower lengths, 20 bytes; the pelvis between the arms
 * and the legs. */
const RIG_LIMBS = [24, 44, 76, 96];
const RIG_HEAD = 12;

function dataView(rom, addr) {
    const off = addr - MAIN_DATA_BASE;
    return off >= 0 && off + 4 <= rom.mainData.length ? off : -1;
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
    const off = dataView(rom, at);
    for (let j = 1; j < SLOT_COUNT; j++) out.push(off < 0 ? [0, 0, 0] : vec(rom.mainDataView, off + (j - 1) * 12));
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
    const md = rom.mainDataView;
    const u32 = (addr) => { const o = dataView(rom, addr); return o < 0 ? 0 : md.getUint32(o, true); };
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
            texSet: u32(root + TEXTURE_SET),
            offsets,
            parts: offsets.map((offset, s) => ({
                index: s, model: u32(list + s * 4), offset, joint: s,
                parent: SLOT_PARENT[s], depth: depthOf(s), flags: 0,
            })),
        });
    }
    return out;
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

/**
 * Pose a fighter on one frame of a motion, in the viewer's frame. The body
 * position is the motion's, step and all: the hand and foot targets are in the
 * same space, so taking the step out of one would leave the limbs reaching for
 * where the other went.
 *
 * @returns {{matrices: number[][], origins: number[][]}}
 */
export function poseFighter(rom, body, motion, frame) {
    rom.vf2Rig ??= standardRig(rom);
    const sample = motion ? sampleMotion(rom, motion, frame) : REST;
    const pose = onOwnSkeleton(buildPose(rom.vf2Rig, sample, { pelvisAim: true, levelFeet: true }), body.offsets);
    const matrices = poseMatrices(pose);
    return { matrices, origins: matrices.map((m) => [m[12], m[13], m[14]]) };
}
