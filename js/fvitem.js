/*
 * fvitem.js — Fighting Vipers' carried item (TECHNICAL.md, "The carried
 * item"): Picky's skateboard, Raxel's guitar, Bahn's hat, which rob_disp
 * draws on a slot of the fighter and, while it is held, leaves copies of.
 *
 * Every frame 0x1CB2C copies an item record into player +0x784: fighter
 * record +0x2C, plus 0x70 * (+0xAFC - 1) when +0xAFC is not 0, plus 0x38
 * when the fighter is mirrored (+0 bit 6). Script op 17 (0x1C6E4), on its own
 * frame, with a byte other than 0 sets +0xAFC to it and +0 bit 27; a byte of
 * 0 clears both. Loading a fighter clears +0xAFC, so a motion played cold
 * starts on record 0 with bit 27 clear.
 *
 * rob_disp (0x1A4B4) draws while the record's first model (+0x78A) is not 0:
 * the first half's (slot +0x788, model +0x78A), or with bit 27 the second's
 * (+0x7A0, +0x7A2), moved by the half's offset and turned Y, X, Z. It reads
 * the matrix back into a ring of four at +0xF34, stepping the index +0xF00
 * first, with the entry's +0x30 set while bit 27 is and +0x1A4 bit 2 is not,
 * then draws the record's copy model (+0x7F8) at every entry whose +0x30 is
 * set. The explorer's ring holds only the motion's own frames: one played
 * cold starts empty.
 *
 * Everything here is in the pose's board frame (y up).
 */
import { resolveData } from './motion.js';
import { turnedInOrder } from './pose.js';
import { carriedScript, moveFlags } from './vf2fighters.js';

const HOLDING = 1 << 2;           /* +0x1A4 bit 2 keeps the copies off */
const HALF_B = 0x1c, COPY = 0x34;
const Y = 1, X = 0, Z = 2;

/** The fighter's item records, or null for a game or fighter without them. */
export function readCarried(rom, body) {
    const C = rom.game.rig?.carried;
    if (!C || body?.root == null) return null;
    const r = resolveData(rom, body.root + C.records);
    const base = r?.view.getUint32(r.off, true);
    return base ? { ...C, base } : null;
}

/* One half of a record at `at`: slot, model, offset and turns. */
function readHalf(v, at) {
    return {
        slot: v.getInt16(at, true), model: v.getUint16(at + 2, true),
        offset: [0, 1, 2].map((k) => v.getFloat32(at + 4 + 4 * k, true)),
        turns: [[Y, v.getUint16(at + 0x12, true)], [X, v.getUint16(at + 0x10, true)], [Z, v.getUint16(at + 0x14, true)]],
    };
}

/** The record 0x1CB2C copies for item `item` (+0xAFC), mirrored or not. */
export function itemRecord(rom, carried, item, mirrored) {
    const at = carried.base + (item ? (item - 1) * carried.size : 0) + (mirrored ? carried.mirror : 0);
    const r = resolveData(rom, at);
    if (!r) return null;
    return { first: readHalf(r.view, r.off + 4), second: readHalf(r.view, r.off + HALF_B), copy: r.view.getUint16(r.off + COPY, true) };
}

/* +0xAFC on each frame 1..last of motion `id`; +0 bit 27 is set while it
 * is not 0. */
function carriedStates(rom, id, last) {
    const ops = carriedScript(rom, id)?.ops ?? [];
    const out = [];
    let item = 0, k = 0;
    for (let f = 1; f <= last; f++) {
        for (; k < ops.length && ops[k].frame <= f; k++) item = ops[k].item;
        out[f] = item;
    }
    return out;
}

/* The half's matrix on `slot` of `pose`: moved, then turned. */
function placeHalf(pose, half) {
    const s = pose[half.slot];
    if (!s) return null;
    const o = half.offset;
    const t = [0, 1, 2].map((k) => s.t[k] + s.r[k] * o[0] + s.r[3 + k] * o[1] + s.r[6 + k] * o[2]);
    return { r: turnedInOrder(s.r, half.turns), t };
}

/* The half drawn on frame `last` and the ring as it stands after it: walks
 * frames 1..last, stepping the ring on each frame the item draws. */
function walkRing(rom, carried, motion, last, mirrored) {
    const items = carriedStates(rom, motion.id, last);
    const flags = moveFlags(rom, motion);
    const ring = Array(carried.ring).fill(null);
    let index = 0, now = null;
    for (let f = 1; f <= last; f++) {
        const rec = itemRecord(rom, carried, items[f], mirrored);
        if (!rec?.first.model) continue;
        const held = items[f] !== 0, half = held ? rec.second : rec.first;
        index = (index + 1) % carried.ring;
        ring[index] = held && !((flags?.[f] ?? 0) & HOLDING) ? { f, half, copy: rec.copy } : null;
        if (f === last) now = half;
    }
    return { now, ring };
}

/*
 * What rob_disp draws for the item on `frame` of `motion`: the record's model
 * on this frame's `pose`, and the copies the ring holds from the frames
 * before it, each on `poseAt(f)`, that frame's pose.
 */
export function carriedDraws(rom, carried, motion, frame, { pose, poseAt, mirrored }) {
    if (motion?.id == null) return [];
    const last = Math.min(frame, motion.frames ?? frame);
    const { now, ring } = walkRing(rom, carried, motion, last, mirrored);
    const draws = [];
    const at = now?.model ? placeHalf(pose, now) : null;
    if (at) draws.push({ model: now.model, ...at });
    for (const e of ring.filter((x) => x?.copy)) {
        const p = placeHalf(e.f === last ? pose : poseAt(e.f), e.half);
        if (p) draws.push({ model: e.copy, ...p });
    }
    return draws;
}
