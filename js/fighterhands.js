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
 * same eased picker, is off: the +0x6AC it reads is record +0x28, always 0.
 *
 * So mirroring moves the shapes, not the models: each slot keeps its own
 * hand's table, and the shape a motion names for one hand goes to the other.
 * The two tables are mirror images (every pair checked is), as are the part
 * list's left and right parts.
 *
 * A hand keeps its shape from one motion into the next: only op 18 and VF2's
 * step write it (MAME watchpoints over a 100-second attract run), and a
 * motion's setup leaves it be. VF2 never resets it after power on; FV's round
 * start copies the part list back. So a motion with nothing live before it
 * starts cold (VF2 shape 0, FV the part list's); only a motion the explorer
 * has just shown carries over, as the opponent's stance does into the
 * reaction when the move lands, mid-ease if it is. A motion the game loops
 * (+0x802 0xFFFF) carries its hands from one pass into the next.
 *
 * No other move-script op touches a hand (TECHNICAL.md lists what else
 * bears on one: op 23, slow motion, FV's armour, none of it reachable here).
 *
 * The head (slot 2, player +0x48) is the script's the same way, by op 16
 * (TECHNICAL.md, "The face"), and keeps its model from one motion into the
 * next by the same rules, so the same runs carry it. Fighting Vipers' op
 * writes it outright (0x2DDB0). Virtua Fighter 2's starts a chain of timed
 * records that 0x4B640 steps every frame after the script, easing a value
 * that picks the model; a voice (op 9) switches the chain as it runs out.
 */
import { resolveData } from './motion.js';

const OP_END = 0, OP_NEXT = 1, OP_LAST = 8, OP_TABLE = 0x10, OP_NEXT_PAIR = 0x13, OP_HAND = 18;
const LOOP = 0xffff;
const MOTION_ID = 0x1fff;
const HANDS = 2, SLOTS = [5, 8], HEAD = 2;
const SHAPE_MASK = 31, FV_SHAPES = 4;

function dataAt(rom, addr) {
    const r = resolveData(rom, addr);
    return r && r.off + 4 <= r.data.length ? r : null;
}

const u32At = (rom, addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };

/* Past the setup ops (rig.reactions' walk), where the script starts: op 0
 * ends the setup on itself, op 8 just past it. Op 1's u16 (and FV op 0x13's
 * first) is the motion that follows, +0x802; 0xFFFF plays this one again. */
function scriptStart(rom, R, dv, at) {
    let next = 0;
    for (;;) {
        const op = dv.getUint8(at);
        if (op === OP_END) return { at, next };
        if (op === OP_LAST) return { at: at + 1, next };
        if (op >= R.ops) return { at: -1, next };
        const len = op === OP_TABLE ? 2 + 2 * dv.getUint8(at + 1) : rom.mainCpuView.getUint8(R.lengths + op);
        if (!len || at + len >= dv.byteLength) return { at: -1, next };
        if (op === OP_NEXT || op === OP_NEXT_PAIR) next = dv.getUint16(at + 1, true);
        at += len;
    }
}

/* Motion `id`'s op 18s, in script order, as {frame, hand, shape, end}; its
 * face ops (`rig.fighters.face`: op 16 and VF2's op 9) as {frame, op, arg};
 * its item ops (`rig.fighters.item`, VF2's op 17) as {frame, on}; and
 * whether the game loops it. */
function handOps(rom, id) {
    const R = rom.game.rig.reactions, lengths = rom.game.rig.script;
    const { face: F, item: I } = rom.game.rig.fighters ?? {};
    const ptr = u32At(rom, R.setups + (id & MOTION_ID) * 4);
    const r = ptr && dataAt(rom, ptr);
    if (!r) return { ops: [], faces: [], items: [], loops: false };
    const dv = r.view, ops = [], faces = [], items = [];
    let { at, next } = scriptStart(rom, R, dv, r.off + R.head);
    while (at >= 0 && at + 7 <= dv.byteLength) {
        const op = dv.getUint8(at);
        if (op === OP_END || op >= lengths.length) break;
        const frame = dv.getUint16(at + 1, true);
        if (op === OP_HAND) {
            ops.push({ frame, hand: dv.getUint8(at + 3), shape: dv.getUint8(at + 4), end: dv.getUint16(at + 5, true) });
        }
        if (F && (op === F.op || op === F.talk?.op)) faces.push({ frame, op, arg: dv.getUint8(at + 3) });
        if (op === I?.op) items.push({ frame, on: dv.getUint8(at + 3) === 1 });
        at += lengths[op];
    }
    return { ops, faces, items, loops: next === LOOP };
}

/** Whether the game plays motion `id` over and over (+0x802 0xFFFF). */
export function gameLoops(rom, id) {
    return Boolean(rom.game.rig?.reactions && rom.game.rig.script && id != null) && handOps(rom, id).loops;
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

const shapeOf = (h) => ((h.now & 0xffff) >> 8) & SHAPE_MASK;

/* VF2: both hands' bytes through frames 1 to `last` of a motion, from
 * `start`; `shapes[f]` each hand's shape on frame f, `end` the bytes after. */
function easeRun(ops, last, start) {
    const hands = start.map((h) => ({ ...h }));
    const shapes = [];
    let next = 0;
    for (let f = 1; f <= last; f++) {
        for (; next < ops.length && ops[next].frame <= f; next++) {
            const h = hands[ops[next].hand];
            if (h) easeOp(h, ops[next], f);
        }
        for (const h of hands) {
            if (h.count) { h.count--; h.now = s16(h.now + h.step); }
        }
        shapes[f] = hands.map(shapeOf);
    }
    return { shapes, end: hands };
}

/* VF2: slot 5 takes hand 1's shape and slot 8 hand 0's, the other way round
 * when mirrored; each from its own table. Power on leaves the bytes 0. */
const VF2 = {
    table: (rom, body, H) => u32At(rom, body.root + H.at),
    powerOn: () => [0, 1].map(() => ({ count: 0, now: 0, step: 0 })),
    run(rom, table, H, ops, last, mirrored, start) {
        const { shapes, end } = easeRun(ops, last, start);
        const models = shapes.map((pair) => SLOTS.map((slot, k) => {
            const hand = (k === 0) !== mirrored ? 1 : 0;
            return u32At(rom, table + (k === 0 ? 0 : H.other) + pair[hand] * 4) || null;
        }));
        return { models, end };
    },
};

/* The slot (0 for 5, 1 for 8) and model a FV op writes: the other hand's
 * when mirrored, as 0x1C718 turns it. */
function fvModel(r, op, mirrored) {
    const k = mirrored ? (op.hand === 1 ? 0 : 1) : op.hand;
    const at = r.off + (k * FV_SHAPES + op.shape) * 2;
    const model = k < HANDS && at + 2 <= r.data.length ? r.view.getInt16(at, true) : 0;
    return { k, model };
}

/* FV: each op writes a model to one slot, which keeps it. A round's start
 * (0x12554) copies the part list to +0x40, so that is what a slot holds
 * before any op. */
const FV = {
    table(rom, body, H) {
        const table = u32At(rom, H.table + body.index * 4);
        return (table && dataAt(rom, table)) || null;
    },
    powerOn: (body) => SLOTS.map((slot) => body.parts[slot]?.model ?? null),
    run(rom, r, H, ops, last, mirrored, start) {
        const written = ops.map((op) => fvModel(r, op, mirrored));
        const now = [...start], models = [];
        let next = 0;
        for (let f = 1; f <= last; f++) {
            for (; next < ops.length && ops[next].frame <= f; next++) {
                const { k, model } = written[next];
                if (k < HANDS && model) now[k] = model;
            }
            models[f] = [...now];
        }
        return { models, end: now };
    },
};

/* Fighting Vipers' face: op 16 writes slot 2 (0x2DDB0) with the first of
 * 0x640D31C[op][record]'s two models; the second, for a broken helmet
 * (+0x1F48 bit 2), only a hit's armour break selects, so it is not read.
 * Before any op the slot keeps the round start's (null: the part list's). */
const FV_FACE = {
    powerOn: () => ({ model: null }),
    run(ctx, ops, last, start) {
        const now = { ...start }, models = [];
        let next = 0;
        for (let f = 1; f <= last; f++) {
            for (; next < ops.length && ops[next].frame <= f; next++) {
                const pair = u32At(ctx.rom, u32At(ctx.rom, ctx.F.table + ops[next].arg * 4) + ctx.body.index * 4);
                const r = pair && dataAt(ctx.rom, pair);
                if (r) now.model = r.view.getInt16(r.off, true);
            }
            models[f] = now.model;
        }
        return { models, end: now };
    },
};

/* Virtua Fighter 2's face records (0x4B604): u16 +0 the frames, s16 +4 the
 * value aimed at (+6, a second, only times the voice), u32 +8 the model
 * picker, +0x10 the next record (0: the chain stops). The picker: u16 +2
 * steps, +4 the models (16 bytes each, +0 the one drawn), +8 a step's
 * entry. */
const FACE_SCALE = 1001, FACE_ENTRY = 16;

function faceLoad(rom, s, at) {
    if (!at) return;
    const r = dataAt(rom, at);
    if (!r) return;
    Object.assign(s, {
        record: at, count: r.view.getUint16(r.off, true), aim: r.view.getInt16(r.off + 4, true),
        picker: r.view.getUint32(r.off + 8, true), next: r.view.getUint32(r.off + 0x10, true),
    });
}

const faceChain = (ctx, table, op) => u32At(ctx.rom, u32At(ctx.rom, table + op * 4) + (ctx.body.char ?? ctx.body.index) * 4);

/* The model the picker gives for value `v`: entry trunc(v · steps / 1001). */
function facePick(rom, picker, v) {
    const r = dataAt(rom, picker);
    if (!r) return null;
    const steps = r.view.getUint16(r.off + 2, true);
    const k = Math.floor(((v * steps) >>> 0) / FACE_SCALE);
    const e = dataAt(rom, picker + 8 + k);
    return e ? u32At(rom, r.view.getUint32(r.off + 4, true) + e.view.getUint8(e.off) * FACE_ENTRY) : null;
}

/* One frame's script ops: op 16 starts its chain; op 9 on its own frame
 * sets the voice's time left (0x1B05C), if the table names a voice. */
function faceOp(ctx, s, op, f) {
    const { F, rom } = ctx, T = F.talk;
    if (op.op === F.op) faceLoad(rom, s, faceChain(ctx, F.table, op.arg));
    else if (op.frame === f && faceChain(ctx, T.voices, op.arg)) {
        const r = dataAt(rom, u32At(rom, T.times + op.arg * 4) + (ctx.body.char ?? ctx.body.index) * 2);
        const t = r ? r.view.getUint16(r.off, true) : 0;
        if (t) s.timer = t;
    }
}

/* 0x4B640, after the script: the voice's switch, then a step of the value
 * toward the aim (all the way on the last), the model it picks, and at the
 * record's end the next one. A chain that has stopped leaves the model. */
function faceStep(ctx, s) {
    const T = ctx.F.talk;
    if (s.timer === T.at && s.record !== faceChain(ctx, ctx.F.table, T.keep)) faceLoad(ctx.rom, s, faceChain(ctx, ctx.F.table, T.to));
    if (!s.count) return;
    const n = --s.count;
    s.value = n ? s.value + Math.trunc((s.aim - s.value) / n) : s.aim;
    s.model = facePick(ctx.rom, s.picker, s.value) ?? s.model;
    if (!n) faceLoad(ctx.rom, s, s.next);
}

/* VF2: action_init (0x4B5D0) zeroes the value and starts the fighter's own
 * chain; the voice's time left (+0x770) counts down before the script. */
const VF2_FACE = {
    powerOn(ctx) {
        const s = { record: 0, count: 0, aim: 0, picker: 0, next: 0, value: 0, timer: 0, model: null };
        faceLoad(ctx.rom, s, u32At(ctx.rom, ctx.F.cold + (ctx.body.char ?? ctx.body.index) * 4));
        return s;
    },
    run(ctx, ops, last, start) {
        const s = { ...start }, models = [];
        let next = 0;
        for (let f = 1; f <= last; f++) {
            if (s.timer > 0) s.timer--;
            for (; next < ops.length && ops[next].frame <= f; next++) faceOp(ctx, s, ops[next], f);
            faceStep(ctx, s);
            models[f] = s.model;
        }
        return { models, end: s };
    },
};

/* VF2's item (op 17, 0x1B2D0): +0 bit 27, set or cleared by an op on its
 * own frame only, and clear from the fighter's load. */
const ITEM = {
    powerOn: () => false,
    run(ops, last, start) {
        const shown = [];
        let on = start, next = 0;
        for (let f = 1; f <= last; f++) {
            for (; next < ops.length && ops[next].frame <= f; next++) if (ops[next].frame === f) on = ops[next].on;
            shown[f] = on;
        }
        return { shown, end: on };
    },
};

/* What a run starts from, cold: the hands', the face's and the item's. */
const coldStart = (ctx) => ({
    hands: ctx.G?.powerOn(ctx.body) ?? null, face: ctx.Face?.powerOn(ctx) ?? null, item: ctx.I ? ITEM.powerOn() : null,
});

/* One pass from `start`: per frame [slot 5's, slot 8's, slot 2's model,
 * whether the item shows], and where it ends. */
function runPass(ctx, list, motion, mirrored, start, last = motion.frames) {
    const hands = ctx.G ? ctx.G.run(ctx.rom, ctx.table, ctx.H, list.ops, last, mirrored, start.hands) : null;
    const face = ctx.Face ? ctx.Face.run(ctx, list.faces, last, start.face) : null;
    const item = ctx.I ? ITEM.run(list.items, last, start.item) : null;
    return { models: frameModels(hands, face, item, last), end: { hands: hands?.end ?? null, face: face?.end ?? null, item: item?.end ?? null } };
}

/* Each frame's [slot 5 hand, slot 8 hand, face, item shown]. */
function frameModels(hands, face, item, last) {
    const models = [];
    for (let f = 1; f <= last; f++) models[f] = [...(hands?.models[f] ?? [null, null]), face?.models[f] ?? null, item?.shown[f] ?? false];
    return models;
}

/* A motion's passes, one run each, from `start`: a motion the game loops
 * (+0x802 0xFFFF: VF2 0x1ABD8, FV 0x1C160 put the frame back to 1 and the
 * script to its start, and leave the hands and face be) starts each pass
 * where the last one ended; any other only ever plays its first. Kept per
 * motion and start, and grown to the pass asked for, until one ends where it
 * began. */
function passes(rom, motion, key, start) {
    const cache = (rom.fighterHands ??= new Map());
    if (!cache.has(key)) {
        cache.set(key, { ...handOps(rom, motion.id), runs: [], next: start });
    }
    return cache.get(key);
}

function passAt(ctx, list, motion, mirrored, pass) {
    while (list.runs.length <= pass && list.next) {
        const start = list.next;
        const run = runPass(ctx, list, motion, mirrored, start);
        const last = list.runs.at(-1);
        // A pass that looks as the last one did shares its frames.
        if (last && JSON.stringify(last.models) === JSON.stringify(run.models)) run.models = last.models;
        list.runs.push({ start, ...run });
        const settled = !list.loops || JSON.stringify(run.end) === JSON.stringify(start);
        list.next = settled ? null : run.end;
    }
    return list.runs[Math.min(pass, list.runs.length - 1)];
}

const handsKey = (body, motion, mirrored, after) =>
    `${body.index}:${motion.id}:${mirrored ? 1 : 0}:${after}`;

/* What a motion starts from: the hands and face motion `from.motion` has on
 * its frame `from.frame` of its pass `from.pass`, itself started cold; or,
 * without one, the cold ones (VF2's power on and action_init, FV's round
 * start). */
function startHands(ctx, from) {
    const cold = coldStart(ctx);
    if (!from?.motion || !(from.frame > 0)) return cold;
    const mirrored = Boolean(from.mirrored);
    const list = passes(ctx.rom, from.motion, handsKey(ctx.body, from.motion, mirrored, ''), cold);
    const { start } = passAt(ctx, list, from.motion, mirrored, from.pass ?? 0);
    return runPass(ctx, list, from.motion, mirrored, start, Math.min(from.frame, from.motion.frames)).end;
}

const fromKey = (from) => (from?.motion ? `${from.motion.id}@${from.pass ?? 0}.${from.frame}${from.mirrored ? 'm' : ''}` : '');

/* The hands' game and table, the face's and the item's, for this fighter;
 * null if it has none of them. */
function scriptContext(rom, body) {
    const { hands: H, face: F, item: I } = rom.game.rig?.fighters ?? {};
    const G = H ? (H.eased ? VF2 : FV) : null;
    const table = G ? G.table(rom, body, H) : null;
    const Face = F ? (F.eased ? VF2_FACE : FV_FACE) : null;
    if (!table && !Face && !I) return null;
    return { rom, body, H, G: table ? G : null, table, F, Face, I };
}

/**
 * The models a motion's script gives slots 5, 8 and 2 on each frame, and
 * whether its item shows: index = frame, each [slot 5's, slot 8's, slot 2's,
 * item], a model null where the part list's stands. Null when the game has
 * no hands (`rig.fighters.hands`), face (`rig.fighters.face`) or item
 * (`rig.fighters.item`) for the fighter.
 *
 * A hand keeps its shape from one motion into the next: nothing but op 18
 * (and VF2's step) writes it, and a motion's setup does not reset it; the
 * head the same with op 16 (and VF2's face step), and VF2's item with op 17.
 * So the motion starts from
 * `from` ({motion, frame, pass, mirrored}: the motion on show just before,
 * as a reaction starts from the stance frame the opponent was caught on), or
 * else from the game's cold ones. `pass` counts the times the motion has
 * played over on screen: one the game loops carries them from each pass into
 * the next; any other starts each one afresh.
 */
export function handModels(rom, body, motion, mirrored = false, from = null, pass = 0) {
    if (motion?.id == null || !rom.game.rig?.reactions || !rom.game.rig.script) return null;
    const ctx = scriptContext(rom, body);
    if (!ctx) return null;
    const key = handsKey(body, motion, mirrored, fromKey(from));
    const list = rom.fighterHands?.get(key) ?? passes(rom, motion, key, startHands(ctx, from));
    return passAt(ctx, list, motion, mirrored, pass).models;
}

/** Whether the item (`rig.fighters.item`) shows on the frame. */
export function itemAt(models, frame) {
    return Boolean(models?.[Math.max(1, Math.min(frame, models.length - 1))]?.[3]);
}

/** Slot → model for the frame, for the slots the motion sets. */
export function handsAt(models, frame) {
    const set = models?.[Math.max(1, Math.min(frame, models.length - 1))];
    if (!set) return null;
    return [...SLOTS, HEAD].map((slot, k) => [slot, set[k]]).filter(([, model]) => model != null);
}
