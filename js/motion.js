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

/*
 * The motion's script: what the game does on which frame of it.
 *
 * The 13 bytes above are only the record's head. `set_mot_dat` walks on from
 * there through a setup byte-code — its dispatch at `0x1B558`, 25 handlers at
 * `0x1B568` — each handler moving `r11` on by its own length. Op 0 ends it with
 * no script to play; op 8 ends it and the play script starts on the next byte,
 * which is where `P1+0x82C` is left pointing.
 *
 * `play_motion` then walks that pointer every frame from `0x1C088`. A command is
 * an opcode byte, then the frame it fires on as a u16, then its own operands;
 * it runs once `p1_frame` (`P1+0x1AA`) has reached its frame, and the walk stops
 * at the first one that has not. The 44 handlers are at `_uk_player_actions`
 * (`0x1D1AC`), and a command that is passed over rather than run skips by
 * `byte_1D01F[op]` — which is also, handler by handler, exactly what each one
 * adds to `g4`, so that one table is enough to walk the whole script. An opcode
 * whose low seven bits are zero ends it.
 */
const SETUP_LENGTH = {
    0x01: 3, 0x02: 7, 0x03: 14, 0x04: 18, 0x05: 14, 0x06: 6, 0x07: 3, 0x09: 15,
    0x0a: 6, 0x0b: 11, 0x0c: 4, 0x0d: 3, 0x0e: 15, 0x0f: 3, 0x11: 7, 0x12: 7,
    0x13: 7, 0x14: 3, 0x15: 6, 0x16: 5, 0x17: 3, 0x18: 13,
};
/* Op 0x10 is a count byte and that many u16s: `lda (r4)[r3*2], r11`. */
const SETUP_LIST = 0x10;
const SETUP_END = 0x00, SETUP_PLAY = 0x08;
const PLAY_LENGTHS = 0x0001d01f;
const PLAY_OPS = 0x2c;
const MOT_RECORD_HEAD = 0x0d;

/**
 * The play script of one motion, in order.
 * @returns {Array<{op:number, frame:number, at:number}>} `at` is the command's
 *   address in the program ROM, where its operands start three bytes on. Empty
 *   when the motion has none or it does not walk.
 */
export function readMotionScript(rom, id) {
    const m = rom.maincpu, dv = rom.mainCpuView;
    if (id < 0 || id >= MOTION_COUNT) return [];
    const rec = dv.getUint32(MOT_LIST_ADDR + id * 4, true);
    if (!rec || rec + MOT_RECORD_HEAD >= m.length) return [];

    let p = rec + MOT_RECORD_HEAD;
    for (;;) {
        if (p >= m.length) return [];
        const op = m[p];
        if (op === SETUP_END) return [];
        if (op === SETUP_PLAY) { p++; break; }
        if (op === SETUP_LIST) { p += 2 + m[p + 1] * 2; continue; }
        if (!SETUP_LENGTH[op]) return [];
        p += SETUP_LENGTH[op];
    }

    const out = [];
    while (p + 3 <= m.length) {
        const op = m[p] & 0x7f;
        if (op === 0 || op >= PLAY_OPS) break;
        out.push({ op, frame: dv.getUint16(p + 1, true), at: p });
        p += m[PLAY_LENGTHS + op];
    }
    return out;
}

/**
 * The commands of a script that have run by `frame`, in order. The walk stops
 * at the first command whose frame has not come, as `play_motion` does, so a
 * command out of frame order waits for the one ahead of it.
 */
export function commandsBy(script, frame) {
    let n = 0;
    while (n < script.length && script[n].frame <= frame) n++;
    return script.slice(0, n);
}

/* Op 0x10 hands `[slot][entry]` to `load_action_from_list` (`0x330D0`), which
 * indexes `player_action_list` by the slot byte — 1 the body, 2 the head, 5 and
 * 8 the hands — and the handler stores `table[char][entry]` into `0x40(g7)` for
 * that slot, the array `rob_disp` draws each slot from. */
const OP_PART_CHANGE = 0x10;
/* Ops 0x27 and 0x28 set and clear bit 16 of `P1+0x7F0`, the first also storing
 * its signed byte at `P1+0x7F4`; `set_mot_dat` clears the bit when a motion
 * starts. */
const OP_PROPELLER_ON = 0x27, OP_PROPELLER_OFF = 0x28;

/**
 * What the script has switched by `frame`.
 * @returns {{propeller:number, parts:Object<number,number>}} `propeller` is 0,
 *   or the byte `0x7F4` holds while it is on; `parts` maps a slot to the entry
 *   the script last installed on it, for the slots it has touched this motion.
 */
export function scriptStateAt(rom, script, frame) {
    const m = rom.maincpu;
    let propeller = 0;
    const parts = {};
    for (const c of commandsBy(script, frame)) {
        if (c.op === OP_PART_CHANGE) parts[m[c.at + 3]] = m[c.at + 4];
        else if (c.op === OP_PROPELLER_ON) propeller = (m[c.at + 3] << 24) >> 24;
        else if (c.op === OP_PROPELLER_OFF) propeller = 0;
    }
    return { propeller, parts };
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
