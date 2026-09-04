/*
 * motion.js — the fighter motion format.
 *
 * A motion id indexes `offset_list_motions` at `0x06400004`, in the XTRA_DATA
 * window (`js/romset.js` folds that back to main data). Each entry is the
 * address of one keyframe block; the low motions sit in the data ROM at
 * `0x02xxxxxx` and the high ones (Honey's, mostly) in the `0x064xxxxx` bank.
 *
 * A block is:
 *
 *   +0x00  u16   frame count
 *   +0x02  20    control bytes, one per object
 *   +0x16  n     one key-count byte per keyed channel, in channel order
 *          pad   to the next multiple of four, measured from the block start
 *          ...   key times:  4 bytes per key, per keyed channel, in order
 *          ...   key values: per channel, in order
 *
 * Twenty objects carry three channels each — the three rotation axes, or for
 * the eight float objects the three components of a point. A control byte packs
 * all three of its object's channel types:
 *
 *   bits 6-7 nonzero   every axis of the object takes type (bits 6-7) - 1,
 *                      which is 0, 1 or 2: a constant the game latches once in
 *                      `calc_rob_angle_int` and skips here, four bytes an axis.
 *   bits 6-7 zero      axis a takes type ((byte >> 2a) & 3) + 3:
 *                        3  zero, no data
 *                        4  one constant float
 *                        5  linear keys, one float each
 *                        6  cubic-Hermite keys, three floats each
 *
 * Types 5 and 6 are the ones that spend a key-count byte. `get_fcurve_value_f`
 * at `0x30C28` walks the three streams in lockstep exactly this way, comparing
 * the frame against each key time in turn; the interpolation itself is handed
 * to the geometry coprocessor as op `0x18803131` (lerp) and `0x19003232`
 * (Hermite), which is why the tangents arrive as a pair per key.
 *
 * The first twelve objects are joint angles and the ROM rounds them to 16-bit
 * binary radians (`cvtri`/`stis`, and `set_mirror` reflects a yaw by taking it
 * from 0x8000). The last eight stay floats: a position and the aim and IK
 * targets the pose engine solves against — see `js/pose.js`.
 */

import { xtraToMainData, XTRA_DATA_BASE } from './romset.js';

export const MOTION_LIST_ADDR = 0x06400004;
export const MOTION_COUNT = 519;

/*
 * A motion carries its own skeleton type, and that is what decides which rig
 * poses it. `mot_list` is a second table indexed by motion id, of pointers to
 * 13-byte records, and `set_mot_dat` at `0x1B3C0` copies byte `0x0C` of one
 * straight into `p1_skeleton_type`:
 *
 *     ldib  0xC(r11), r15
 *     stib  r15, 0x84C(g7)      ; p1_skeleton_type
 *     cmpobe 0, r15, +          ; a zero type stops here
 *     setbit 0xC, r15, r15      ; else bit 12 of P1+0x860
 *     addo  0xD, r11, r11       ; the records are 13 bytes
 *
 * That bit is the one `calc_rob_angle_cont` tests at `0x2FFBC` before taking
 * the rig from `P1+0x8C` — the copy `action_init` loads there, 45 words of it,
 * from the character record's `+0x04`. With the bit clear it falls back to the
 * array at `0xC2058` instead, whose type-0 table points every character at
 * Sonic. So a type-0 motion is posed on Sonic's bones whoever is playing it,
 * and any other type is posed on the fighter's own.
 *
 * Of the 519 motions, 372 are type 0, 123 type 1, 7 type 2 and 16 type 3.
 */
const MOT_LIST_ADDR = 0x000ce380;

/**
 * The skeleton type one motion asks for.
 * @param {object} rom
 * @param {number} id motion id
 * @returns {number} 0-3, or 0 if the record does not resolve
 */
export function motionSkeletonType(rom, id) {
    const dv = rom.mainCpuView;
    if (id < 0 || id >= MOTION_COUNT) return 0;
    const rec = dv.getUint32(MOT_LIST_ADDR + id * 4, true);
    if (!rec || rec + 0x0d > rom.maincpu.length) return 0;
    return dv.getUint8(rec + 0x0c);
}

export const OBJECT_COUNT = 20;      /* 12 angle objects + 8 float objects */
export const ANGLE_OBJECTS = 12;
export const FLOAT_OBJECTS = 8;
export const CHANNEL_COUNT = OBJECT_COUNT * 3;

/* Channel types, numbered as the control byte yields them. 0-2 are the
 * latched-constant forms; the viewer reads them as zero, as the ROM does. */
export const ZERO = 3, CONST = 4, LINEAR = 5, HERMITE = 6;

/* Hermite tangents are stored per authored second, and the curves were keyed at
 * 30 fps. Two independent tangent conventions in the data agree on it: where a
 * key's in- and out-tangent match, the value is the Catmull-Rom slope through
 * its neighbours times thirty, and where a segment is drawn straight, both its
 * ends carry that segment's own secant times thirty. */
export const TANGENT_RATE = 30;

/* Where a block address lands in the assembled main-data region, or -1. */
function blockOffset(addr) {
    if (addr >= 0x02000000 && addr < 0x03000000) return addr - 0x02000000;
    if (addr >= XTRA_DATA_BASE) return xtraToMainData(addr);
    return -1;
}

/** The raw `offset_list_motions` entry for a motion id. */
export function motionBlockAddress(rom, motionId) {
    if (!(motionId > 0 && motionId < MOTION_COUNT)) return 0;
    const off = xtraToMainData(MOTION_LIST_ADDR) + motionId * 4;
    return rom.mainDataView.getUint32(off, true);
}

/**
 * Decode one motion's channel table. Key data is left in the ROM and addressed
 * by offset — a motion is a few hundred keys and nothing needs copying.
 *
 * @returns {?{id:number, address:number, offset:number, frames:number,
 *             channels:Array<{type:number,count:number,times:number,values:number}>}}
 */
export function decodeMotion(rom, motionId) {
    const address = motionBlockAddress(rom, motionId);
    const off = blockOffset(address);
    /* Slot 0 and the empty slots point at the table's own tail rather than a
     * block; a real one has room for a header and says it has frames. */
    if (off < 0 || off + 22 > rom.mainData.length) return null;
    const frames = rom.mainDataView.getUint16(off, true);
    if (frames === 0) return null;

    const types = new Uint8Array(CHANNEL_COUNT);
    for (let j = 0; j < OBJECT_COUNT; j++) {
        const b = rom.mainData[off + 2 + j];
        const top2 = (b >> 6) & 3;
        for (let a = 0; a < 3; a++) {
            types[j * 3 + a] = top2 === 0 ? ((b >> (a * 2)) & 3) + 3 : top2 - 1;
        }
    }

    /* One count byte per keyed channel, then the streams, four-aligned from the
     * block start — the block itself is only two-aligned in the ROM. */
    const counts = new Uint8Array(CHANNEL_COUNT);
    let n = 0;
    for (let i = 0; i < CHANNEL_COUNT; i++) {
        if (types[i] === LINEAR || types[i] === HERMITE) counts[i] = rom.mainData[off + 22 + n++];
    }

    let p = off + ((22 + n + 3) & ~3);
    const times = new Int32Array(CHANNEL_COUNT).fill(-1);
    for (let i = 0; i < CHANNEL_COUNT; i++) {
        if (types[i] === LINEAR || types[i] === HERMITE) { times[i] = p; p += counts[i] * 4; }
    }

    const values = new Int32Array(CHANNEL_COUNT).fill(-1);
    for (let i = 0; i < CHANNEL_COUNT; i++) {
        switch (types[i]) {
            case ZERO: break;                                   /* no data at all */
            case CONST: values[i] = p; p += 4; break;
            case LINEAR: values[i] = p; p += counts[i] * 4; break;
            case HERMITE: values[i] = p; p += counts[i] * 12; break;
            default: values[i] = p; p += 4; break;              /* latched constant */
        }
    }
    if (p > rom.mainData.length) return null;

    const channels = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) {
        channels.push({ type: types[i], count: counts[i], times: times[i], values: values[i] });
    }
    return { id: motionId, address, offset: off, frames, end: p, channels };
}

/** Every motion id that resolves to a real block, for browsing. */
export function listMotions(rom) {
    const out = [];
    for (let m = 1; m < MOTION_COUNT; m++) {
        const d = decodeMotion(rom, m);
        if (d) out.push({ id: m, frames: d.frames, address: d.address });
    }
    return out;
}

/** One channel at frame `f`, held flat outside its first and last key. */
export function evalChannel(rom, ch, f) {
    const dv = rom.mainDataView;
    if (ch.type === ZERO) return 0;
    if (ch.type === CONST) return dv.getFloat32(ch.values, true);
    if (ch.type < ZERO) return 0;              /* latched constant: not ours to read */

    const n = ch.count;
    if (n === 0) return 0;
    const stride = ch.type === HERMITE ? 12 : 4;
    const t0 = dv.getFloat32(ch.times, true);
    if (f <= t0) return dv.getFloat32(ch.values, true);
    const tn = dv.getFloat32(ch.times + (n - 1) * 4, true);
    if (f >= tn) return dv.getFloat32(ch.values + (n - 1) * stride, true);

    let i = 0;
    while (i < n && dv.getFloat32(ch.times + i * 4, true) < f) i++;
    const ti = dv.getFloat32(ch.times + i * 4, true);
    if (ti === f) return dv.getFloat32(ch.values + i * stride, true);
    const tp = dv.getFloat32(ch.times + (i - 1) * 4, true);
    const dt = ti - tp;
    const s = (f - tp) / dt;

    if (ch.type === LINEAR) {
        const v0 = dv.getFloat32(ch.values + (i - 1) * 4, true);
        const v1 = dv.getFloat32(ch.values + i * 4, true);
        return v0 + (v1 - v0) * s;
    }
    /* Hermite: the previous key's out-tangent and this key's in-tangent. Both
     * are rates per authored second rather than per frame — the curves come out
     * of a 30 fps tool, and a segment the data draws as a straight line stores
     * exactly thirty times its own secant — so they scale by the span over
     * TANGENT_RATE. */
    const bp = ch.values + (i - 1) * 12, bi = ch.values + i * 12;
    const p0 = dv.getFloat32(bp, true), p1 = dv.getFloat32(bi, true);
    const k = dt / TANGENT_RATE;
    const m0 = dv.getFloat32(bp + 8, true) * k, m1 = dv.getFloat32(bi + 4, true) * k;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0
         + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

/* The ROM rounds an angle channel to a 16-bit binary radian. */
function toAngle(v) {
    const n = v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
    return n & 0xffff;
}

/**
 * Sample every channel at frame `f`.
 *
 * @returns {{angles:Uint16Array, targets:Float32Array, targetUsed:Uint8Array}}
 *   `angles` is 12 objects x 3 axes of binary radians, `targets` the 8 float
 *   objects x 3 components, and `targetUsed` marks the ones the motion actually
 *   writes — an object whose every axis is a latched constant is not ours.
 */
export function sampleMotion(rom, motion, f) {
    const angles = new Uint16Array(ANGLE_OBJECTS * 3);
    const targets = new Float32Array(FLOAT_OBJECTS * 3);
    const targetUsed = new Uint8Array(FLOAT_OBJECTS);
    const ch = motion.channels;

    for (let i = 0; i < ANGLE_OBJECTS * 3; i++) angles[i] = toAngle(evalChannel(rom, ch[i], f));

    for (let j = 0; j < FLOAT_OBJECTS; j++) {
        const base = (ANGLE_OBJECTS + j) * 3;
        const held = ch[base].type < ZERO && ch[base + 1].type < ZERO && ch[base + 2].type < ZERO;
        if (held) continue;
        targetUsed[j] = 1;
        for (let a = 0; a < 3; a++) targets[j * 3 + a] = evalChannel(rom, ch[base + a], f);
    }
    return { angles, targets, targetUsed };
}
