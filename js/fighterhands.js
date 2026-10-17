/*
 * The fighters' hands (TECHNICAL.md, "The hands"). Virtua Fighter 2 and
 * Fighting Vipers open and close a fighter's hands from the move script, the
 * ops set_mot_dat leaves at player +0x82C past a motion's setup: op 18, seven
 * bytes, names a hand (byte 3) and a shape (byte 4) from frame u16 +1 on.
 *
 * Virtua Fighter 2 eases the shape (handler 0x1B2F4). Each hand keeps six
 * bytes at +0x6C4 (hand 0) and +0x6CA (hand 1): a count, the shape aimed at,
 * the shape now as 8.8 and a step. The op takes the frames to its u16 +5,
 * n = end - frame: with n > 0, n + 1 steps of ((shape << 8) - now) / (n + 1);
 * otherwise it sets the shape outright with one step left, of whatever step
 * the hand last had. After the script, each frame, 0x1B4E8 adds the step to
 * a hand with steps left. The draw (0x1907C) asks 0x19E34 for slots 5 and 8:
 * the slot takes the high byte, & 31, of hand 1's shape if it is slot 5 (slot
 * 8 when the fighter is mirrored, +0 bit 6) and hand 0's otherwise, as an
 * index into the record's +0x3C table, at +0 for slot 5 and +0x180 for 8.
 *
 * Fighting Vipers sets it outright (handler 0x1C718): 0x640EBF4[record] is
 * four s16 models per hand, and the op writes hand h's model for its shape
 * over the part list's (player +0x40) for slot 5 + 3h, unless it is 0. A
 * mirrored fighter has h turned to the other hand first. Its 0x1AC80, the
 * same eased picker, reads a +0x6AC that nothing writes.
 *
 * So mirroring moves the shapes, not the models: each slot keeps its own
 * hand's table, and the shape a motion names for one hand goes to the other.
 * The two tables are mirror images (every pair checked is), as are the part
 * list's left and right parts.
 *
 * Which shape a hand has when a motion starts is the motion before's, which is
 * fight state; the explorer starts each hand the motion names on the first
 * shape it names, and leaves a hand it never names as the part list has it.
 */
import { resolveData } from './motion.js';

const OP_END = 0, OP_LAST = 8, OP_TABLE = 0x10, OP_HAND = 18;
const MOTION_ID = 0x1fff;
const HANDS = 2, SLOTS = [5, 8];
const SHAPE_MASK = 31, FV_SHAPES = 4;

function dataAt(rom, addr) {
    const r = resolveData(rom, addr);
    return r && r.off + 4 <= r.data.length ? r : null;
}

const u32At = (rom, addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };

/* Past the setup ops (rig.reactions' walk), where the script starts: op 0
 * ends the setup on itself, op 8 just past it. */
function scriptStart(rom, R, dv, at) {
    for (;;) {
        const op = dv.getUint8(at);
        if (op === OP_END) return at;
        if (op === OP_LAST) return at + 1;
        if (op >= R.ops) return -1;
        const len = op === OP_TABLE ? 2 + 2 * dv.getUint8(at + 1) : rom.mainCpuView.getUint8(R.lengths + op);
        if (!len || at + len >= dv.byteLength) return -1;
        at += len;
    }
}

/* Motion `id`'s op 18s, in script order, as {frame, hand, shape, end}. */
function handOps(rom, id) {
    const R = rom.game.rig.reactions, lengths = rom.game.rig.script;
    const ptr = u32At(rom, R.setups + (id & MOTION_ID) * 4);
    const r = ptr && dataAt(rom, ptr);
    if (!r) return [];
    const dv = r.view, ops = [];
    let at = scriptStart(rom, R, dv, r.off + R.head);
    while (at >= 0 && at + 7 <= dv.byteLength) {
        const op = dv.getUint8(at);
        if (op === OP_END || op >= lengths.length) break;
        if (op === OP_HAND) {
            ops.push({ frame: dv.getUint16(at + 1, true), hand: dv.getUint8(at + 3), shape: dv.getUint8(at + 4), end: dv.getUint16(at + 5, true) });
        }
        at += lengths[op];
    }
    return ops;
}

const s16 = (v) => (v << 16) >> 16;

/* One op on a VF2 hand's six bytes, then the frame's step (0x1B4E8). */
function easeOp(h, { shape, end }, frame) {
    const n = end - frame;
    if (n > 0) {
        h.count = n + 1;
        h.step = s16(Math.trunc(((shape << 8) - h.now) / h.count));
    } else {
        h.count = 1;
        h.now = shape << 8;
    }
}

/* A VF2 hand as the motion starts: on the first shape it names, if any. */
function startHand(ops, k) {
    const first = ops.find((o) => o.hand === k);
    return first ? { count: 0, now: first.shape << 8, step: 0 } : null;
}

const shapeOf = (h) => (h ? ((h.now & 0xffff) >> 8) & SHAPE_MASK : null);

/* Per frame (index = frame), each hand's shape index, or null if the motion
 * never names that hand. */
function easedShapes(ops, frames) {
    const hands = [0, 1].map((k) => startHand(ops, k));
    const out = [];
    let next = 0;
    for (let f = 1; f <= frames; f++) {
        for (; next < ops.length && ops[next].frame <= f; next++) {
            const h = hands[ops[next].hand];
            if (h) easeOp(h, ops[next], f);
        }
        for (const h of hands) {
            if (h?.count) { h.count--; h.now = s16(h.now + h.step); }
        }
        out[f] = hands.map(shapeOf);
    }
    return out;
}

/* VF2: slot 5 takes hand 1's shape and slot 8 hand 0's, the other way round
 * when mirrored; each from its own table. */
function vf2Hands(rom, body, H, ops, frames, mirrored) {
    const table = u32At(rom, body.root + H.at);
    if (!table) return null;
    const shapes = easedShapes(ops, frames);
    return shapes.map((pair) => SLOTS.map((slot) => {
        const hand = (slot === SLOTS[0]) !== mirrored ? 1 : 0;
        if (pair[hand] == null) return null;
        return u32At(rom, table + (slot === SLOTS[0] ? 0 : H.other) + pair[hand] * 4) || null;
    }));
}

/* The slot (0 for 5, 1 for 8) and model a FV op writes: the other hand's
 * when mirrored, as 0x1C718 turns it. */
function fvModel(r, op, mirrored) {
    const k = mirrored ? (op.hand === 1 ? 0 : 1) : op.hand;
    const at = r.off + (k * FV_SHAPES + op.shape) * 2;
    const model = k < HANDS && at + 2 <= r.data.length ? r.view.getInt16(at, true) : 0;
    return { k, model };
}

/* A FV hand as the motion starts: on the first model it is given, if any. */
function fvStart(written, k) {
    return written.find((w) => w.k === k && w.model)?.model ?? null;
}

/* FV: each op writes a model to one slot, which keeps it. */
function fvHands(rom, body, H, ops, frames, mirrored) {
    const table = u32At(rom, H.table + body.index * 4);
    const r = table && dataAt(rom, table);
    if (!r) return null;
    const written = ops.map((op) => fvModel(r, op, mirrored));
    const now = [0, 1].map((k) => fvStart(written, k));
    const out = [];
    let next = 0;
    for (let f = 1; f <= frames; f++) {
        for (; next < ops.length && ops[next].frame <= f; next++) {
            const { k, model } = written[next];
            if (k < HANDS && model) now[k] = model;
        }
        out[f] = [...now];
    }
    return out;
}

/**
 * The hand models a motion gives slots 5 and 8 on each frame: index = frame,
 * each [slot 5's, slot 8's], null where the part list's stands. Null when
 * the game has no hands (`rig.fighters.hands`) or the motion names none.
 */
export function handModels(rom, body, motion, mirrored = false) {
    const H = rom.game.rig?.fighters?.hands;
    if (!H || motion?.id == null) return null;
    const cache = (rom.fighterHands ??= new Map());
    const key = `${body.index}:${motion.id}:${mirrored ? 1 : 0}`;
    if (!cache.has(key)) {
        const ops = handOps(rom, motion.id);
        const read = H.eased ? vf2Hands : fvHands;
        cache.set(key, ops.length ? read(rom, body, H, ops, motion.frames, mirrored) : null);
    }
    return cache.get(key);
}

/** Slot → model for the frame, for the slots the motion sets. */
export function handsAt(models, frame) {
    const pair = models?.[Math.max(1, Math.min(frame, models.length - 1))];
    if (!pair) return null;
    return SLOTS.map((slot, k) => [slot, pair[k]]).filter(([, model]) => model != null);
}
