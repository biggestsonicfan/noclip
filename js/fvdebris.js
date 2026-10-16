/*
 * Fighting Vipers' flying armour pieces (TECHNICAL.md, "The flying pieces").
 * A hit that breaks a slot throws that stage's pieces (0x640EDAC's records,
 * readArmourPieces) off it: 0x2D614 gives each a velocity from the hit,
 * 0x2D390 puts it in one of eight shared slots at the broken slot's point, and
 * 0x2CE68 moves it every frame (gravity, a bounce on its floor, the ring's
 * walls, a spin that settles on the record's target angles). 0x2E17C draws it.
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

export function createDebrisSim(centre) {
    return { slots: Array.from({ length: DEBRIS_SLOTS }, () => null), frame: 0, centre };
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

/* 0x2D390's choice: a bit-3 piece is the flipbook effect instead (not drawn)
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
 * first piece that is the effect instead, or when the slots run out. A record
 * with model 0 takes a slot all the same, which nothing moves, draws or frees
 * (0x2CE68 and 0x2E17C skip it). `half` tags them so the half's switch can
 * take them back.
 */
export function launchDebris(sim, T, hit, pieces, pose, half) {
    for (const p of pieces) {
        if (isEffect(sim, p.flags)) return;
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
            spin, weight: p.weight, radius: p.radius, floor: p.floor, frames: 0, bounces: 0,
        };
    }
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

/** One board frame of 0x2CE68 for every piece in flight or at rest. The
 * push out of the fighters' bodies (TGP 0x77) is not followed. */
export function stepDebris(sim) {
    sim.frame++;
    for (const s of sim.slots) {
        if (!s?.model) continue;
        s.frames++;
        fall(s);
        walls(s, sim.centre);
        turn(s);
    }
}

/** A piece's board-frame transform as 0x2E17C draws it: translate, then Y
 * (the facing, 0 here, plus the record's), X and Z, in the pose's frame,
 * which is the board's turned a quarter about Y. */
export function debrisPlace(s) {
    const [x, y, z] = s.angles;
    return { r: turnedInOrder([1, 0, 0, 0, 1, 0, 0, 0, 1], [[1, y - 0x4000], [0, x], [2, z]]), t: s.p };
}
