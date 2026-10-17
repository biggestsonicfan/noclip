/*
 * Fighting Vipers' flying armour pieces (TECHNICAL.md, "The flying pieces").
 * A hit that breaks a slot throws that stage's pieces (0x640EDAC's records,
 * readArmourPieces) off it: 0x2D614 gives each a velocity from the hit,
 * 0x2D390 puts it in one of eight shared slots at the broken slot's point, and
 * 0x2CE68 moves it every frame (out of the fighters' bodies, gravity, a bounce
 * on its floor, the ring's walls, a spin that settles on the record's target
 * angles). 0x2E17C draws it.
 * A piece 0x2D390 turns into the flipbook effect instead goes to one of two
 * effect slots (0x2D254), which 0x2D2F4 runs and 0x2E17C draws after them.
 *
 * The explorer runs them in the pose's board frame (forward +x, y up), the
 * fighter's facing taken as 0 and the attacker straight ahead of it, so the
 * attacker's facing is 0x8000 and a heading `h` the routine works in is the
 * board frame's (-cos d, -sin d) with d = h - 0x8000.
 */
import { turnedInOrder } from './pose.js';

const f = Math.fround;
const word = new Uint32Array(1), real = new Float32Array(word.buffer);
const fromBits = (u) => { word[0] = u; return real[0]; };
const bitsOf = (x) => { real[0] = x; return word[0]; };
const short = (v) => (v << 16) >> 16;
const ANGLE = Math.PI / 0x8000;

/*
 * The one hit every piece is thrown by: move 128's setup script (0x641E26B)
 * op 4 at 0x641E27E, the attack the move makes. Its +3 is the damage (player
 * +0x83D), +5 the direction (+0x82A) and +10 the kind (+0x843), which is what
 * 0x2D614 reads off the attacker.
 */
export const SAMPLE_HIT = { damage: 60, kind: 0, direction: 0, move: 128, at: 0x0641e27e };

/* 0x2D614's limits: the damage is capped at 70 and taken over 60, and every
 * piece rises 0.06 more than its kind's share. */
const DAMAGE_CAP = 70, DAMAGE_UNIT = 60, RISE = fromBits(0x3d75c28f);

/* The shared slots (mod_fa_effect +0x88, 0x48 bytes each). */
export const DEBRIS_SLOTS = 8;

/* The per-frame constants. Gravity is what 0x50A000 holds at normal speed;
 * the rest are 0x2CF24's immediates, the half-width 0x50A00C's, the height
 * past which no wall applies 0x50027C's, and the drop of a piece out of the
 * ring 0x50A010's default (0x6CE3564 sets it per stage). */
const GRAVITY = fromBits(0x3bab1f2d), DRAG = fromBits(0x3f7ae148), SKID = fromBits(0x3f666666);
const BOUNCE = fromBits(0x3e4ccccd), STILL = fromBits(0x3a83126f), WALL = fromBits(0xbe99999a);
const HALF = f(5), OUT = f(0.5), WALL_TOP = fromBits(0x40466666), OUT_DROP = f(-0.5);

/* The flipbook effect (0x2D254, 0x2D2F4; mod_fa_effect +0x508, 0x24 bytes a
 * slot): two slots, each shown for 54 frames, its speed the piece's throw
 * times these, X, Y and Z. */
export const EFFECT_SLOTS = 2;
const EFFECT_FRAMES = 54, EFFECT_SPEED = [fromBits(0x3e4ccccd), fromBits(0x3c23d70a), fromBits(0x3e4ccccd)];

/* Flag bits: 1 and 3 pick between a piece and the flipbook effect, 7 resting,
 * 11 in flight, 12 and 14 spin about X and Z, 19 out of the ring. */
const FLAG = { one: 1 << 1, three: 1 << 3, rest: 1 << 7, live: 1 << 11, spinX: 1 << 12, spinZ: 1 << 14, out: 1 << 19 };

/** 0x2D614's tables and 0x2D390's spins, from the profile's `debris`. */
export function readDebrisTables(rom, D, dataAt) {
    const list = (addr, n, read) => {
        const r = dataAt(rom, addr);
        return r ? Array.from({ length: n }, (_, k) => read(r.view, r.off, k)) : null;
    };
    const float = (dv, o, k) => dv.getFloat32(o + k * 4, true);
    const half = (dv, o, k) => dv.getInt16(o + k * 2, true);
    const t = {
        out: list(D.out, 6, float), rise: list(D.rise, 6, float), jitter: list(D.jitter, 16, float),
        heading: list(D.heading, 16, half), spin: list(D.spin, 16, half),
    };
    return Object.values(t).every(Boolean) ? t : null;
}

/** `flipbook` is 0x6421760[record]'s models, the effect's frames (null:
 * none). */
export function createDebrisSim(centre, flipbook = null) {
    return {
        slots: Array.from({ length: DEBRIS_SLOTS }, () => null),
        effects: Array.from({ length: EFFECT_SLOTS }, () => null), flipbook, frame: 0, centre,
    };
}

/* 0x2D614 for one piece: its velocity in the board frame. */
function throwOf(T, hit, piece) {
    const d = f(Math.min(hit.damage, DAMAGE_CAP) / DAMAGE_UNIT);
    const i = (hit.direction + piece.slot + piece.model + piece.weightBits) & 15;
    const out = f(f(d * T.out[hit.kind]) + T.jitter[i]);
    const rise = f(f(f(d * T.rise[hit.kind]) + RISE) + f(2 * T.jitter[i]));
    const a = (hit.direction - T.heading[i]) * ANGLE;
    return [f(-out * Math.cos(a)), rise, f(-out * Math.sin(a))];
}

/* 0x2D390's choice: a bit-3 piece is the flipbook effect instead
 * unless bit 1 is set and fewer than two slots hold a bit-3 piece (0x2D8D4). */
function isEffect(sim, flags) {
    if (!(flags & FLAG.three)) return false;
    if (!(flags & FLAG.one)) return true;
    const both = FLAG.three | FLAG.live;
    return sim.slots.filter((s) => s && (s.flags & both) === both).length >= 2;
}

/**
 * Throw one broken slot's stage of pieces (0x2D390's loop): each into the
 * first free slot, at the broken slot's point of `pose`. The loop ends at the
 * first piece that is the effect instead (launched, if an effect slot is
 * free), or when the slots run out. A record
 * with model 0 takes a slot all the same, which nothing moves, draws or frees
 * (0x2CE68 and 0x2E17C skip it). `half` tags them so the half's switch can
 * take them back.
 */
export function launchDebris(sim, T, hit, pieces, pose, half) {
    for (const p of pieces) {
        if (isEffect(sim, p.flags)) { launchEffect(sim, p.slot, throwOf(T, hit, p), pose[p.slot].t, half); return; }
        const k = sim.slots.indexOf(null);
        if (k < 0) return;
        const at = pose[p.slot].t.map(f);
        /* The spin is picked by the position's float bits, the board world's;
         * the board frame's stand in for them. */
        const spin = T.spin[(bitsOf(at[0]) + bitsOf(at[1]) + bitsOf(at[2]) + p.weightBits) & 15];
        sim.slots[k] = {
            half, model: p.model, slot: p.slot, flags: p.flags | FLAG.live,
            p: at, v: throwOf(T, hit, p), from: at.slice(),
            angles: [short(p.angles[0]), short(p.angles[1]), short(p.angles[2])], targets: p.targets.map(short),
            spin, weight: p.weight, radius: p.radius, floor: p.floor, shadow: p.shadow ?? 0, frames: 0, bounces: 0,
        };
    }
}

/* 0x2D254: the first free effect slot (+0x1E, the model shown, 0) takes the
 * broken slot's point and a fraction of the piece's throw, and shows the
 * record's first frame. The seed it keeps at +0x1A is never read again. */
function launchEffect(sim, slot, v, at, half) {
    const k = sim.effects.indexOf(null);
    /* A first frame of 0 would leave the slot free, as here. */
    if (k < 0 || !sim.flipbook?.[0]) return;
    sim.effects[k] = {
        half, slot, model: sim.flipbook[0], frames: 0,
        p: at.map(f), v: v.map((x, i) => f(x * EFFECT_SPEED[i])), from: at.map(f),
    };
}

/* 0x2D2F4: on to the next frame; the 54th, or a frame of model 0, frees the
 * slot. Then it falls, with no floor, drag or wall. */
function stepEffect(sim, k) {
    const e = sim.effects[k];
    if (!e) return;
    if (++e.frames >= EFFECT_FRAMES || !sim.flipbook[e.frames]) { sim.effects[k] = null; return; }
    e.model = sim.flipbook[e.frames];
    e.v[1] = f(e.v[1] - GRAVITY);
    for (let i = 0; i < 3; i++) e.p[i] = f(e.p[i] + e.v[i]);
}

/* 0x2CF24's fall and bounce. The resting piece's on-screen test (0x316F0,
 * which removes it when it leaves the picture) is not followed. */
function fall(s) {
    const { p, v } = s;
    if (s.flags & FLAG.rest) return;
    v[1] = f(v[1] - GRAVITY);
    v[0] = f(v[0] * DRAG);
    v[2] = f(v[2] * DRAG);
    for (let k = 0; k < 3; k++) p[k] = f(p[k] + v[k]);
    const floor = s.flags & FLAG.out ? f(s.floor + OUT_DROP) : s.floor;
    if (p[1] > floor) return;
    s.bounces++;
    p[1] = f(p[1] - v[1]);
    v[1] = -f(v[1] * f(BOUNCE + f(BOUNCE / s.weight)));
    if (Math.abs(v[1]) > STILL) {
        v[0] = f(v[0] * SKID);
        v[2] = f(v[2] * SKID);
        return;
    }
    s.flags |= FLAG.rest;
    v.fill(0);
}

/* The ring's walls, the board's x then z (the frame's z then x), about the
 * ring's centre: past half + 0.5 a piece is out (bit 19, a lower floor),
 * past half less its radius it is put back and its speed turned back. */
function walls(s, centre) {
    const { p, v } = s;
    if (p[1] > WALL_TOP) return;
    const lim = f(HALF - s.radius);
    for (const k of [2, 0]) {
        const at = f(p[k] - centre[k]), a = Math.abs(at);
        if (a > f(HALF + OUT)) s.flags |= FLAG.out;
        else if (a > lim) {
            v[k] = f(v[k] * WALL);
            p[k] = f(centre[k] + Math.sign(at) * lim);
        }
    }
}

/* 0x2D118: spin while flying and for three bounces, then step each angle with
 * a target onto it. The ROM's two bounds are r11 and r14, and Y's stretch
 * leaves r14 its divisor, which Z then compares against; kept as it is. */
function turn(s) {
    const a = s.angles, t = s.targets;
    if (!(s.flags & FLAG.rest) && s.bounces < 4) {
        if (s.flags & FLAG.spinX) a[0] = short(a[0] + s.spin);
        a[1] = short(a[1] + s.spin);
        if (s.flags & FLAG.spinZ) a[2] = short(a[2] + s.spin);
        return;
    }
    let r11 = s.flags & FLAG.rest ? 0x1000 : 0x800, r14 = -r11;
    const toward = (k, stretch) => {
        if (!t[k] || t[k] === a[k]) return;
        const d = a[k] - t[k];
        if (d <= r11 && d >= r14) { a[k] = t[k]; return; }
        if (stretch) { r14 = s.bounces + 1; r11 = Math.trunc(r11 / r14); }
        a[k] = short(d > 0 ? a[k] - r11 : a[k] + r11);
    };
    toward(0, false);
    toward(1, true);
    toward(2, false);
}

/*
 * 0x2CEA0 (epc_oidasi), the push out of the fighters' bodies. Every frame,
 * before the fall, each piece sends TGP op 0x77 (copro 0x20936) its point and
 * radius; the copro tests it against player 1's 32 body balls, then, if none
 * touched, player 2's, and 0x2CEA0 adds 0.16 of the two sums it returns to
 * x and z. The balls are calc_unit_mat's (0x18304 sends each slot's through
 * op 0x39, the slot's matrix on the ball's point), table entry i holding ball
 * 0x292AC[i] and its radius (0x1B90). A body further than 1.4 from entry 13
 * (ball 3, slot 9) is skipped; otherwise each ball within d <= r + radius adds
 * (ball - piece) * (1 - q), q the copro's d / (r + radius). Its reciprocal
 * refines RECIPS three times against the 3.0 the length routine (0x20281)
 * leaves in F11, not 2.0, so q comes out near 2d / (r + radius): a piece
 * inside half that is drawn in, one beyond it pushed out.
 */
const PUSH = fromBits(0x3e23d70a), BODY_NEAR = fromBits(0x3fb33333), BODY_TEST = 13, BODY_BALLS = 32;
const NEWTON = f(3);
/* The SHARC's RECIPS seed by the mantissa's top seven bits (MAME's
 * recips_mantissa_lookup), shifted down 15. */
const RECIPS = [
    255, 252, 248, 244, 240, 236, 232, 228, 224, 222, 218, 214, 212, 208, 204, 202, 198, 194, 192, 188, 186, 182, 180, 178,
    174, 172, 168, 166, 164, 160, 158, 156, 152, 150, 148, 146, 142, 140, 138, 136, 134, 130, 128, 126, 124, 122, 120, 118,
    116, 114, 112, 110, 108, 106, 104, 102, 100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 80, 78, 76, 74, 72, 70, 70, 68, 66,
    64, 62, 62, 60, 58, 56, 56, 54, 52, 50, 50, 48, 46, 46, 44, 42, 40, 40, 38, 36, 36, 34, 32, 32, 30, 30, 28, 26, 26, 24,
    24, 22, 20, 20, 18, 18, 16, 14, 14, 12, 12, 10, 10, 8, 8, 6, 6, 4, 4, 2, 2, 0,
];

function recips(x) {
    const b = bitsOf(x), e = -(((b >>> 23) & 0xff) - 127) - 1;
    if (e > 125 || e < -126) return fromBits(b & 0x80000000);
    return fromBits((b & 0x80000000) | ((e + 127) << 23) | (RECIPS[(b & 0x7fffff) >> 16] << 15));
}

/** The body balls by table entry (0x292AC, `order`): each one's slot, point
 * in that slot's frame and radius, or null for an entry no slot sends. `B` is
 * the slots' lists (the profile's shadow `balls`). */
export function readBodyBalls(rom, order, B, dataAt) {
    const byte = (a) => { const r = dataAt(rom, a); return r.view.getUint8(r.off); };
    const real = (a) => { const r = dataAt(rom, a); return r.view.getFloat32(r.off, true); };
    const slotOf = new Map();
    for (let s = 1; s < 16; s++) {
        const n = byte(B.counts + s);
        for (let k = 0; k < n; k++) slotOf.set(byte(B.lists + B.inline * (s - 1) + k) >> 2, s);
    }
    return Array.from({ length: BODY_BALLS }, (_, i) => {
        const k = rom.mainCpuView.getUint8(order + i);
        if (!slotOf.has(k)) return null;
        const at = B.points + 16 * k;
        return { slot: slotOf.get(k), point: [0, 4, 8].map((o) => real(at + o)), radius: f(real(at + 12)) };
    });
}

/** Where a fighter's body balls are on `pose` (board frame): { at, radius }
 * by table entry. */
export function bodyBallsAt(balls, pose) {
    return balls.map((b) => {
        if (!b) return null;
        const { r, t } = pose[b.slot], [x, y, z] = b.point;
        return { at: [0, 1, 2].map((i) => f(r[i] * x + r[3 + i] * y + r[6 + i] * z + t[i])), radius: b.radius };
    });
}

/* Copro 0x20955 for one body: adds to `sum`, and the last ball's 1 - q (its
 * bits, as the copro tests them; 0 for none) says whether one touched. */
function pushFrom(p, radius, balls, sum) {
    /* 0x2031F's sum; its square root (0x20281, RSQRTS refined) is taken
     * exactly. */
    const length = (e) => {
        const [x, y, z] = [0, 1, 2].map((i) => f(e[i] - p[i]));
        return f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
    };
    const test = balls[BODY_TEST];
    if (!test || length(test.at) > BODY_NEAR) return 0;
    let hit = 0;
    for (const b of balls) {
        if (!b || !bitsOf(b.radius)) continue;
        const d = length(b.at), reach = f(b.radius + radius);
        if (d > reach) continue;
        let r = recips(reach), m = reach, q = d;
        for (let k = 0; k < 3; k++) {
            m = f(r * m);
            q = f(q * r);
            r = f(NEWTON - m);
        }
        const k = f(1 - f(q * r));
        sum[0] = f(sum[0] + f(f(b.at[0] - p[0]) * k));
        sum[1] = f(sum[1] + f(f(b.at[2] - p[2]) * k));
        hit = bitsOf(k);
    }
    return hit;
}

function pushOut(s, bodies) {
    const sum = [0, 0];
    for (const balls of bodies) if (balls && pushFrom(s.p, s.radius, balls, sum)) break;
    s.p[0] = f(s.p[0] + f(PUSH * sum[0]));
    s.p[2] = f(s.p[2] + f(PUSH * sum[1]));
}

/** One board frame of 0x2CE68 for every piece in flight or at rest.
 * `bodies` are the fighters' body balls (bodyBallsAt), player 1's first;
 * the push is skipped once the finishing blow lands (+0x7D6 bit 0), which
 * the explorer's fight never reaches. */
export function stepDebris(sim, bodies = []) {
    sim.frame++;
    for (const s of sim.slots) {
        if (!s?.model) continue;
        s.frames++;
        pushOut(s, bodies);
        fall(s);
        walls(s, sim.centre);
        turn(s);
    }
    for (let k = 0; k < EFFECT_SLOTS; k++) stepEffect(sim, k);
}

/** A piece's board-frame transform as 0x2E17C draws it: translate, then Y
 * (the facing, 0 here, plus the record's), X and Z, in the pose's frame,
 * which is the board's turned a quarter about Y. */
export function debrisPlace(s) {
    const [x, y, z] = s.angles;
    return { r: turnedInOrder([1, 0, 0, 0, 1, 0, 0, 0, 1], [[1, y - 0x4000], [0, x], [2, z]]), t: s.p };
}

/** An effect's board-frame transform as 0x2E17C draws it: translate, then a
 * turn about Y by the slot (0x8000 the first, 0x4000 the second), whatever
 * the fighter faces, and a scale of 1. The second model it draws, +0x18, is
 * always 0. */
export function effectPlace(e, k) {
    return { r: turnedInOrder([1, 0, 0, 0, 1, 0, 0, 0, 1], [[1, ((EFFECT_SLOTS - k) << 14) - 0x4000]]), t: e.p };
}

/* 0x78384's floor shadows: from 0x76A70, on a stage whose flags
 * (0x6442BA8 + 12 x stage) have bit 9 or bit 31, the Factory and Bay Side. */
const SHADOW_STAGES = (1 << 9) | (1 << 31);
const SHADOW_ABOVE = fromBits(0x3e99999a), SHADOW_SCALE = fromBits(0x3fa00000);

/** Whether 0x76A70 calls 0x78384 on a stage with these flags. */
export function debrisShadowsOn(stageFlags) {
    return (stageFlags & SHADOW_STAGES) !== 0;
}

/**
 * 0x78384: under each piece (model +0x22 not 0) at most 0.3 above its floor
 * (0, or 0x50A010 once out of the ring, the same stand-in fall() drops it
 * by), the slot's +0x44 laid on that floor: T(x, floor, z) S(1, 0, 1), the
 * piece's own Y, X and Z turns, then S(1.25). { model, r, t } in the board
 * frame; the effects get none.
 */
export function debrisShadowDraws(sim) {
    const out = [];
    for (const s of sim.slots) {
        if (!s?.model || !s.shadow) continue;
        const floor = s.flags & FLAG.out ? OUT_DROP : 0;
        if (f(floor + SHADOW_ABOVE) < s.p[1]) continue;
        const { r } = debrisPlace(s);
        out.push({ model: s.shadow, r: r.map((v, i) => (i % 3 === 1 ? 0 : v * SHADOW_SCALE)), t: [s.p[0], floor, s.p[2]] });
    }
    return out;
}
