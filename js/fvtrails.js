/*
 * fvtrails.js — Fighting Vipers' move trails (TECHNICAL.md, "Move trails"):
 * the sparks a move sheds from the feet, the hands or the waist.
 *
 * Script op 28 (0x1C8CC) writes a kind to player +0xA25 and a life to +0xA24;
 * set_mot_dat clears the kind as a motion starts. Every frame 0x7BDC0 drops a
 * spark for each player whose kind asks for one into one of two shared rings
 * of sixteen (0x500890 and 0x500894): the waist's and the floor's into the
 * first (0x7BE10), the feet's and hands' into the second (0x7BEDC). 0x7C178
 * then picks each live spark's model and size by its life from the tables
 * and counts the life down, and 0x21FAC draws what it picked on the next
 * frame, turned to face the camera.
 *
 * Everything here is in the pose's board frame (y up); a spark's point is the
 * slot's place in it, player +0x1F4 + 12 * slot, read on the frame it drops.
 */
import { turnedInOrder } from './pose.js';
import { resolveData } from './motion.js';

const f = Math.fround;
export const RING_SLOTS = 16;

const BODY = 0, LHAND = 5, RHAND = 8, LFOOT = 12, RFOOT = 15;
/* 0x7BE10: the waist's spark sits 0.2 under the body (0xBE4CCCCD added),
 * lives 15 frames whatever +0xA24 says. */
const WAIST_DROP = f(-0.2), RING1_LIFE = 15;
/* 0x7C178 shrinks the feet's sizes by 0.35 (0x3EB33333). */
const FEET_SHRINK = f(0.35);
/* 0x21FAC turns the second ring's sparks a quarter more than the first's. */
const QUARTER = 0x4000;

/* +0xA25's bits: 0 lets the first ring drop, 1 the waist's spark and 2 the
 * floor's; 5 and 4 the left and right foot, 7 and 6 the left and right hand. */
const K_ON = 1, K_WAIST = 2, K_FLOOR = 4, K_LFOOT = 0x20, K_RFOOT = 0x10, K_LHAND = 0x80, K_RHAND = 0x40;
const K_HANDS = K_LHAND | K_RHAND;
/* The second ring stays empty while the setup word has bit 8 and +0x1A4 bit 2;
 * +0x1A4 bit 27 puts the feet's sparks on the floor. */
const WORD_HELD = 1 << 8, FLAG_HELD = 1 << 2, FLAG_FLOOR = 1 << 27;

const view = (rom, at) => resolveData(rom, at);
const u32 = (rom, at) => { const r = view(rom, at); return r.view.getUint32(r.off, true); };
const s16s = (rom, at) => { const r = view(rom, at); return Array.from({ length: RING_SLOTS }, (_, i) => r.view.getInt16(r.off + i * 2, true)); };
const f32s = (rom, at) => { const r = view(rom, at); return Array.from({ length: RING_SLOTS }, (_, i) => r.view.getFloat32(r.off + i * 4, true)); };

/**
 * 0x7C178's tables on one stage (0x500064 & 15): by life, the model and size
 * of each kind of spark.
 */
export function readTrailTables(rom, stage) {
    const T = rom.game.rig?.trails;
    if (!T) return null;
    const byStage = (t) => s16s(rom, u32(rom, t.models + (stage & 15) * 4));
    return {
        feet: { models: byStage(T.feet), sizes: f32s(rom, T.feet.sizes).map((s) => f(s * FEET_SHRINK)) },
        hands: { models: byStage(T.hands), sizes: f32s(rom, T.hands.sizes) },
        floor: { models: byStage(T.floor), sizes: f32s(rom, T.floor.sizes) },
        waist: { models: s16s(rom, T.waist), sizes: Array(RING_SLOTS).fill(1) },
    };
}

/** Every model the tables can pick, to build before they are needed. */
export function trailModels(tables) {
    return [...new Set(Object.values(tables).flatMap((t) => t.models).filter((m) => m > 0))];
}

const ring = () => ({
    next: 0, live: 0, at: Array(RING_SLOTS).fill(null),
    kind: new Uint8Array(RING_SLOTS), life: new Int8Array(RING_SLOTS),
    model: new Int16Array(RING_SLOTS), size: new Float32Array(RING_SLOTS),
});

/** The two rings, empty. */
export function createTrailRings() {
    return [ring(), ring()];
}

/* One spark in the ring's next slot, which takes over whatever was there. */
function drop(r, at, kind, life) {
    const s = r.next = (r.next + 1) & (RING_SLOTS - 1);
    r.at[s] = at;
    r.live |= 1 << s;
    r.kind[s] = kind;
    r.life[s] = life;
}

/*
 * One player's sparks for the frame (0x7BE10, then 0x7BEDC). `p` is what the
 * routines read off the player: kind (+0xA25), life (+0xA24), flags (+0x1A4),
 * word (+0x804), mirrored (+0 bit 6) and pose, its slots in the board frame.
 * `counter` is the frame counter at 0x500020: with bit 1 set, a kind without
 * bit 1 drops nothing into the first ring.
 */
export function dropTrails(rings, p, counter) {
    const { kind, life, flags, word, mirrored, pose } = p;
    const point = (slot) => pose[slot].t.slice();
    if ((kind & K_ON) && ((kind & K_WAIST) || !(counter & 2))) {
        const at = point(BODY);
        if (kind & K_WAIST) at[1] = f(at[1] + WAIST_DROP);
        else at[1] = 0;
        if (kind & (K_WAIST | K_FLOOR)) drop(rings[0], at, kind, RING1_LIFE);
    }
    if ((word & WORD_HELD) && (flags & FLAG_HELD)) return;
    /* Mirrored, each side reads the other's slot. */
    const [lf, rf, lh, rh] = mirrored ? [RFOOT, LFOOT, RHAND, LHAND] : [LFOOT, RFOOT, LHAND, RHAND];
    const foot = (slot) => {
        const at = point(slot);
        if (flags & FLAG_FLOOR) at[1] = 0;
        return at;
    };
    if (kind & K_LFOOT) drop(rings[1], foot(lf), kind, life);
    if (kind & K_RFOOT) drop(rings[1], foot(rf), kind, life);
    if (kind & K_LHAND) drop(rings[1], point(lh), kind, life);
    if (kind & K_RHAND) drop(rings[1], point(rh), kind, life);
}

/* The table a spark's kind reads, in 0x7C178's order of tests. */
function tableFor(tables, kind) {
    if (kind & K_FLOOR) return tables.floor;
    if (kind & K_WAIST) return tables.waist;
    return kind & K_HANDS ? tables.hands : tables.feet;
}

/*
 * 0x7C178 on one ring: each live spark takes its life's model and size and
 * loses a frame of life, and is gone once that falls below 0; a free slot
 * draws nothing.
 */
export function ageTrails(r, tables) {
    for (let s = 0; s < RING_SLOTS; s++) {
        if (!(r.live >> s & 1)) { r.model[s] = 0; continue; }
        const t = tableFor(tables, r.kind[s]), n = r.life[s];
        r.model[s] = t.models[n] ?? 0;
        r.size[s] = t.sizes[n] ?? 0;
        if (n - 1 < 0) {
            r.live &= ~(1 << s);
            r.kind[s] = 0;
        } else {
            r.life[s] = n - 1;
        }
    }
}

/** One board frame: every player's sparks dropped, in player order, then both
 * rings aged. */
export function stepTrailRings(rings, tables, players, counter) {
    for (const p of players) dropTrails(rings, p, counter);
    for (const r of rings) ageTrails(r, tables);
}

/*
 * What 0x21FAC draws from the rings: for each slot with a model, translate to
 * its point, scale by its size, turn about y by the camera's yaw (a quarter
 * more in the second ring). The board draws them on the frame after they are
 * picked. `yaw` is a board angle: a model turned by it has its +z along the
 * camera's view, (sin, 0, cos) in the board frame.
 */
export function trailDraws(rings, yaw) {
    const out = [];
    rings.forEach((r, k) => {
        const turn = turnedInOrder([1, 0, 0, 0, 1, 0, 0, 0, 1], [[1, (yaw + k * QUARTER) & 0xffff]]);
        for (let s = 0; s < RING_SLOTS; s++) {
            if (!r.model[s] || !r.at[s]) continue;
            out.push({ model: r.model[s], ring: k, slot: s, r: turn.map((v) => v * r.size[s]), t: r.at[s].slice() });
        }
    });
    return out;
}

/** +0xA25 and +0xA24 on frame `frame` of a motion: the last op 28 at or
 * before it (set_mot_dat clears the kind; nothing before the first sets a life). */
export function trailStateAt(script, frame) {
    let kind = 0, life = 0;
    for (const o of script?.ops ?? []) {
        if (o.frame > frame) break;
        kind = o.kind;
        life = o.life;
    }
    return { kind, life };
}

/*
 * One fighter's motion run through the rings frame by frame, as the board
 * would run it played from frame 1: the display counter's tick `t` is motion
 * frame 1 + t mod `frames`, so a motion that loops drops its sparks again
 * from the top, onto what the last pass left. `poseAt(frame)` gives the
 * board-frame pose and must be called in order (it may blend from the frame
 * before); `flags` is +0x1A4 by frame (or null).
 */
export function createTrailRun({ script, tables, frames, flags, mirrored, poseAt }, tick) {
    return { script, tables, frames, flags, mirrored, poseAt, rings: createTrailRings(), done: tick };
}

/** Step the run through every tick before `tick`: what 0x21FAC draws on
 * `tick` is what the frame before picked. */
export function runTrailsTo(run, tick) {
    const { script, frames } = run;
    for (; run.done < tick; run.done++) {
        const t = run.done, frame = 1 + (((t % frames) + frames) % frames);
        const player = {
            ...trailStateAt(script, frame), word: script.word, flags: run.flags?.[frame] ?? 0,
            mirrored: run.mirrored, pose: run.poseAt(frame),
        };
        stepTrailRings(run.rings, run.tables, [player], t);
    }
    return run;
}
