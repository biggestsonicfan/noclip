/*
 * osage.js — the sway chains: Honey's pigtails, Fang's tail and the rest.
 *
 * 揺れ物 — "swaying things". Five fighters carry parts that are not on the
 * sixteen-slot skeleton at all: they hang off a bone and trail behind it.
 * `osage_per_character` at `0x68D64` maps a character to a definition table,
 * and `osage_dsp` at `0x67640` walks that table as a stream of typed records:
 *
 *   1  MATRIX    0x24  the frame the chains are simulated in: a bone, a Z, Y
 *                      and X angle to turn it by, an offset and a gravity scale
 *   2  COLI      0x40  the volumes a segment is kept out of
 *   3  ETC       0x0C  whether those apply, and the damping
 *   4  TSUKENE   0x18  a new chain: a root mode, the bone it attaches to and
 *                      the offset it hangs from
 *   5  OSAGE     0x44  one segment: its model, length and two bias vectors
 *   0  END
 *
 * The table says who has what:
 *
 *   Fang    one chain of three on the chest — his tail
 *   Bark    one segment on the head
 *   Espio   one segment on the chest
 *   Bean    four chains on the chest
 *   Honey   two chains of three on the head — her pigtails — and one on the chest
 *
 * Everyone else points at the same empty table, `0x69DE4`. Tails is one of
 * them: his tails are not sway chains but a display routine of their own,
 * `tails_tail_disp` at `0x1AB58`, which is not read here.
 *
 * ## The work is split between the two processors
 *
 * The main CPU does not simulate anything. Each record's handler (the table at
 * 0x679A8) builds a matching record in bufferram, sized by the table at
 * 0x67520, and `osage_copro` at 0x687C4 hands the whole stream to the
 * coprocessor as one command, Fn_osage (0x4A). The coprocessor walks it, answers
 * each segment with the matrix it is drawn with, and writes the segment's new
 * point and carry back into its record. Those two survive into the next frame,
 * so the chains have memory, and they sway.
 *
 * Everything happens in the MATRIX record's frame F. The main CPU hands over
 * two more matrices beside it: M1 = F⁻¹·F_prev, which carries last frame's
 * points into this frame's frame, and M2, the same rotation with gravity as its
 * translation. A segment then does, in the coprocessor (cpres1 PM 0x207BD, as
 * m2-hle2's sharc_osage ports it word for word against MAME):
 *
 *   a     = M1 · point              where last frame's point is now
 *   aim   = a + M2 · carry + bias   plus momentum, gravity and the bias
 *   aim   → pushed out of the floor, or out of the body's planes and spheres
 *   u     = unit(aim − P)           P: the chain root, or the last segment's end
 *   point = P + length · u,  carry = (point − a) · damping,  P = point
 *
 * and is drawn at F · [X, u, Z | P], where u is the segment's Y axis, X is u
 * turned flat in the frame's XY plane, (u.y, −u.x, 0)/√(1−u.z²), and Z is X × u.
 * The meshes run along their own +Y for their length, which is why they lie end
 * to end.
 *
 * Bit 0 of the chain's flag word is not a sway switch. `osage_init` at 0x67600
 * sets it and runs `osage_dsp` once, and the end of that pass clears it: it
 * marks the first frame. The paths it gates are the initialisation — storing
 * gravity at 0x114, starting each point one length down `unit(gravity + bias)`
 * from 0x108, and the COLI constants — and the stream built on every later frame
 * does the real work. So 0x108 and 0x114 staying put while a fighter walks, as
 * `stf-tools/test-osage-mame.mjs` measured, is what the code predicts, and says
 * nothing about the chains, whose state lives in bufferram. The capture in
 * `stf-tools/osage-fang-segments.json` reads those records: each of Fang's
 * three points sits exactly its own length from the one before (1.000, 1.000,
 * 0.800), and their carries move from frame to frame.
 *
 * The wind is dead, as before: `0x68AA4` reads its amplitude from a table at
 * 0x68914 whose 52 entries all point at one record with an amplitude of 0.0f, so
 * the vector at 0x138 added to gravity is always zero.
 */

import { turnedBy, coproSin, coproCos } from './pose.js';

const OSAGE_PER_CHARACTER = 0x00068d64;
const RECORD_SIZE = { 1: 0x24, 2: 0x40, 3: 0x0c, 4: 0x18, 5: 0x44 };
const MATRIX = 1, COLI = 2, ETC = 3, TSUKENE = 4, SEGMENT = 5;

/* The engine's gravity, `flt_50A000`, written as 0x3CCE9ED5 at 0x6BA4. */
export const GRAVITY = 0.02522222138941288;

/* The damping `os_set_etc` substitutes while the fighter is off the ground. */
const AIRBORNE_DAMPING = Math.fround(0.8);

/* The floor `osage_dsp` sets when there is none to stop at (0x678C8), for a
 * pose with no ground under it, such as every channel at zero, whose waist is
 * at the origin. */
export const NO_FLOOR = Math.fround(-999.9);

/* The smallest normal float32. The coprocessor's "less than zero" after a float
 * operation is the sign flag without the zero flag, and an underflow sets zero. */
const FLT_MIN = 1.1754943508222875e-38;

/* ---- 3x4 matrices: `r` column-major, `t` the translation, as pose.js has them */

const xform = (m, v) => [
    m.t[0] + m.r[0] * v[0] + m.r[3] * v[1] + m.r[6] * v[2],
    m.t[1] + m.r[1] * v[0] + m.r[4] * v[1] + m.r[7] * v[2],
    m.t[2] + m.r[2] * v[0] + m.r[5] * v[1] + m.r[8] * v[2],
];
const rotate = (r, v) => [
    r[0] * v[0] + r[3] * v[1] + r[6] * v[2],
    r[1] * v[0] + r[4] * v[1] + r[7] * v[2],
    r[2] * v[0] + r[5] * v[1] + r[8] * v[2],
];
function compose(a, b) {
    const r = new Array(9);
    for (let c = 0; c < 3; c++) {
        const col = rotate(a.r, [b.r[c * 3], b.r[c * 3 + 1], b.r[c * 3 + 2]]);
        r[c * 3] = col[0]; r[c * 3 + 1] = col[1]; r[c * 3 + 2] = col[2];
    }
    return { r, t: xform(a, b.t) };
}
/* Fn_inv_matrix, which is a whole inverse rather than a transpose. */
function invert(m) {
    const [a, b, c, d, e, f, g, h, i] = m.r;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const k = det ? 1 / det : 0;
    const r = [
        A * k, (c * h - b * i) * k, (b * f - c * e) * k,
        B * k, (a * i - c * g) * k, (c * d - a * f) * k,
        C * k, (b * g - a * h) * k, (a * e - b * d) * k,
    ];
    const t = rotate(r, m.t);
    return { r, t: [-t[0], -t[1], -t[2]] };
}
const IDENTITY = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
/* The firmware's 1/√x hands back zero for a zero input. */
const rsqrt = (x) => (x === 0 ? 0 : 1 / Math.sqrt(x));
const ltZero = (f) => f < -FLT_MIN;

/**
 * Read a fighter's sway chains, or null if it has none.
 *
 * @returns {?{table:number, records:object[],
 *             chains:Array<{bone:number, offset:number[],
 *                           segments:Array<{model:number,length:number}>}>}}
 */
export function readOsage(rom, charIndex) {
    const dv = rom.mainCpuView;
    const table = dv.getUint32(OSAGE_PER_CHARACTER + charIndex * 4, true);
    if (!table || table + 4 > rom.maincpu.length) return null;

    const records = [];
    const chains = [];
    let chain = null;
    let a = table;
    /* The stream is terminated by a zero type; the bound is only so a table
     * that is not one cannot run away. */
    for (let n = 0; n < 512; n++) {
        if (a + 4 > rom.maincpu.length) return null;
        const type = dv.getUint32(a, true);
        if (type === 0) break;
        const size = RECORD_SIZE[type];
        if (!size || a + size > rom.maincpu.length) return null;
        /* Offsets from here on are the record's own, past its type word, which
         * is how the handlers address it through g9. */
        const u = (o) => dv.getUint32(a + 4 + o, true);
        const f = (o) => dv.getFloat32(a + 4 + o, true);
        const v3 = (o) => [f(o), f(o + 4), f(o + 8)];
        if (type === MATRIX) {
            /* `os_set_matrix` at 0x67D28: the bone, then Fn_z_rot, Fn_y_rot and
             * Fn_x_rot, then Fn_trans by the offset, which steps along the
             * turned axes. */
            records.push({ type, bone: u(0x00), az: u(0x04) & 0xffff, ay: u(0x08) & 0xffff,
                ax: u(0x0c) & 0xffff, offset: v3(0x10), scale: f(0x1c) });
        } else if (type === COLI) {
            /* `os_set_coli` at 0x6829C. Two spheres whose centres sit in the
             * bone's XZ plane, a cylinder about the frame's Y, and two lines in
             * the frame's XY plane taken off a second bone's X axis. */
            records.push({ type, bone: u(0x00),
                sphere1: [f(0x04), f(0x08)], radius1: f(0x0c),
                sphere2: [f(0x10), f(0x14)], radius2: f(0x18),
                cylinder: f(0x1c), angle1: u(0x20), angle2: u(0x24),
                bone2: u(0x28), turn1: u(0x2c) & 0xffff, offset1: f(0x30),
                turn2: u(0x34) & 0xffff, offset2: f(0x38) });
        } else if (type === ETC) {
            records.push({ type, noLimits: u(0x00), damping: f(0x04) });
        } else if (type === TSUKENE) {
            /* `os_set_tsukene` at 0x680E0 dispatches on the mode: 0 ost_norm,
             * 1 ost_same, 2 ost_save, 3 ost_load. */
            chain = { mode: u(0x00), bone: u(0x04), offset: v3(0x08), segments: [] };
            chains.push(chain);
            records.push({ type, mode: chain.mode, bone: chain.bone, offset: chain.offset });
        } else if (type === SEGMENT) {
            const seg = {
                model: u(0x18), length: f(0x24),
                /* The carry a chain starts with. */
                carry: v3(0x0c),
                /* Added to the aim every frame. `os_set_osage` takes the second
                 * while bit 1 of the chain's flags is set, which the last
                 * segment's side of the frame's X decides. */
                bias: v3(0x28), biasAlt: v3(0x34),
            };
            records.push({ type, ...seg });
            if (chain) chain.segments.push(seg);
        }
        a += size;
    }
    if (!chains.length) return null;
    return { table, records, chains };
}

/**
 * The state one fighter's chains carry from frame to frame: the frame each
 * MATRIX record was built in last time, each segment's point and carry, and the
 * few words of the chain struct the handlers keep.
 */
export function createOsageSim(osage) {
    return {
        osage,
        /* The struct's frame counter at +0x06, and bit 0 / bit 1 of its flags. */
        frames: 0,
        init: true,
        altBias: false,
        prev: [],
        coli: [],
        segments: [],
        gravityInit: [0, 0, 0],   /* +0x114 */
        root: [0, 0, 0],          /* +0xFC */
        running: [0, 0, 0],       /* +0x108 */
        saved: IDENTITY,          /* inner matrix 2, which ost_save leaves */
    };
}

/**
 * Run one board frame of a fighter's chains on a pose.
 *
 * @param {object} sim  from createOsageSim()
 * @param {Array<{r:number[],t:number[]}>} pose  from buildPose(), board frame
 * @param {{floorY?:number, airborne?:boolean}} [board]  the fighter's own state:
 *   the floor the chains stop at (0 in the ring, -0.5 outside it) and whether
 *   the fighter is off the ground, which drops the bias and the damping
 * @returns {Array<{model:number, r:number[], t:number[], end:number[],
 *                  chain:number, segment:number}>}
 */
export function stepOsage(sim, pose, { floorY = 0, airborne = false } = {}) {
    const stream = buildStream(sim, pose, { floorY, airborne });
    const placed = runCoprocessor(sim, stream);
    /* `osage_copro`, as it reads each segment back: the chain's first two
     * frames lose their carry, and the last segment's X picks next frame's
     * bias (0x6878C). A negative float compares below zero as an integer. */
    for (const s of stream) {
        if (s.type !== SEGMENT) continue;
        if (sim.frames < 2) s.state.c = [0, 0, 0];
        sim.altBias = s.state.p[0] < 0 || Object.is(s.state.p[0], -0);
    }
    sim.frames = (sim.frames + 1) & 0xffff;
    sim.init = false;
    return placed;
}

/**
 * Settle a fighter's chains on a pose that is held still: start them as the
 * game does and run frames until nothing moves.
 */
export function settleOsage(sim, pose, board = {}, { maxFrames = 2000, epsilon = 1e-7 } = {}) {
    let placed = stepOsage(sim, pose, board);
    for (let n = 1; n < maxFrames; n++) {
        const before = placed.map((p) => p.end);
        placed = stepOsage(sim, pose, board);
        let moved = 0;
        placed.forEach((p, i) => {
            for (let k = 0; k < 3; k++) moved = Math.max(moved, Math.abs(p.end[k] - before[i][k]));
        });
        if (moved < epsilon) break;
    }
    return placed;
}

/** A fighter's chains at rest on a pose, with no history. */
export function osageParts(pose, osage, board = {}) {
    if (!osage) return [];
    return settleOsage(createOsageSim(osage), pose, board);
}

/* ---- the main CPU: what each handler puts in bufferram -------------------- */

function buildStream(sim, pose, { floorY, airborne }) {
    const stream = [];
    let F = IDENTITY, Finv = IDENTITY;
    let matrices = 0, colis = 0, segments = 0;
    for (const rec of sim.osage.records) {
        const bone = (i) => pose[i] ?? IDENTITY;
        if (rec.type === MATRIX) {
            const b = bone(rec.bone);
            const r = turnedBy(b.r, rec.ax, rec.ay, rec.az);
            F = { r, t: xform({ r, t: b.t }, rec.offset) };
            Finv = invert(F);
            /* Gravity (plus the dead wind) turned into the frame, with the
             * inverse's translation zeroed first (Fn_base_point). */
            const g = rotate(Finv.r, [0, -GRAVITY * rec.scale, 0]);
            if (sim.init) sim.gravityInit = g;
            const prev = sim.prev[matrices];
            const M1 = sim.init || !prev ? IDENTITY : compose(Finv, prev);
            sim.prev[matrices++] = F;
            stream.push({ type: MATRIX, F, M1, M2: { r: M1.r, t: g },
                /* The floor, as a plane in the frame: the world's up axis read
                 * into it (Fn_get_y_axis), and how far the floor is below F. */
                up: [Finv.r[3], Finv.r[4], Finv.r[5]], floor: floorY - F.t[1] });
        } else if (rec.type === COLI) {
            let k = sim.coli[colis];
            if (!k) {
                /* Computed once, on the first frame, and left in the record. */
                const a1 = (rec.angle1 - 0x4000) & 0xffff, a2 = (rec.angle2 + 0x4000) & 0xffff;
                const c1 = coproCos(a1), c2 = coproCos(a2);
                k = sim.coli[colis] = {
                    r1: rec.radius1, r2: rec.radius2, rc: rec.cylinder,
                    line1: [c1, coproSin(a1), c1 * rec.cylinder],
                    line2: [c2, coproSin(a2), -(c2 * rec.cylinder)],
                };
            }
            colis++;
            const b = bone(rec.bone);
            const c1 = xform(Finv, xform(b, [rec.sphere1[0], 0, rec.sphere1[1]]));
            const c2 = xform(Finv, xform(b, [rec.sphere2[0], 0, rec.sphere2[1]]));
            /* The second bone's X axis in the frame, flattened onto its XY
             * plane, turned by each record angle and pushed out to the bone. */
            const C = compose(Finv, bone(rec.bone2));
            const n = rsqrt(C.r[0] * C.r[0] + C.r[1] * C.r[1]);
            const nx = C.r[0] * n, ny = C.r[1] * n;
            const plane = (turn, offset) => {
                const s = coproSin(turn), c = coproCos(turn);
                const px = nx * c - ny * s, py = nx * s + ny * c;
                return [px, py, px * C.t[0] + py * C.t[1] + offset];
            };
            const p1 = plane(rec.turn1, rec.offset1), p2 = plane(rec.turn2, rec.offset2);
            const cross = (line, p) =>
                (p[2] * line[0] - p[0] * line[2]) / (line[0] * p[1] - p[0] * line[1]);
            const m = stream.findLast((s) => s.type === MATRIX);
            stream.push({ type: COLI, limits: [
                ...(m ? m.up : [0, 1, 0]), m ? m.floor : 0,
                ...c1, k.r1, k.r1 * k.r1,
                ...c2, k.r2, k.r2 * k.r2,
                k.rc, k.rc * k.rc,
                ...k.line1, ...k.line2,
                cross(k.line1, p1), cross(k.line2, p2),
                ...p1, ...p2,
            ] });
        } else if (rec.type === ETC) {
            stream.push({ type: ETC, noLimits: rec.noLimits,
                damping: airborne ? AIRBORNE_DAMPING : rec.damping });
        } else if (rec.type === TSUKENE) {
            let P;
            if (rec.mode === 1) {
                P = sim.root;
            } else if (rec.mode === 3) {
                P = xform(sim.saved, rec.offset);
            } else {
                /* ost_norm walks the bone and then the inverse; ost_save
                 * composes them first and keeps the product. Same point. */
                const C = compose(Finv, bone(rec.bone));
                if (rec.mode === 2) sim.saved = C;
                P = xform(C, rec.offset);
            }
            sim.root = P;
            sim.running = P;
            stream.push({ type: TSUKENE, P });
        } else if (rec.type === SEGMENT) {
            let state = sim.segments[segments];
            if (sim.init || !state) {
                /* The first frame's static path (0x68604): one length down
                 * gravity plus the bias from where the chain has got to. */
                const w = [0, 1, 2].map((i) => sim.gravityInit[i] + rec.bias[i]);
                const k = rsqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
                const p = [0, 1, 2].map((i) => sim.running[i] + rec.length * w[i] * k);
                sim.running = p;
                state = sim.segments[segments] = { p, c: rec.carry.slice() };
            }
            segments++;
            stream.push({ type: SEGMENT, state, model: rec.model, length: rec.length,
                bias: airborne ? [0, 0, 0] : sim.altBias ? rec.biasAlt : rec.bias });
        }
    }
    return stream;
}

/* ---- the coprocessor: Fn_osage ------------------------------------------- */

function runCoprocessor(sim, stream) {
    const placed = [];
    let W = IDENTITY, M1 = IDENTITY, M2 = IDENTITY;
    let limits = null, noLimits = 1, damping = 1;
    let P = [0, 0, 0];
    let chain = -1, segment = 0;
    for (const s of stream) {
        if (s.type === MATRIX) {
            W = s.F; M1 = s.M1; M2 = s.M2;
        } else if (s.type === COLI) {
            limits = s.limits;
        } else if (s.type === ETC) {
            noLimits = s.noLimits; damping = s.damping;
        } else if (s.type === TSUKENE) {
            P = s.P; chain++; segment = 0;
        } else if (s.type === SEGMENT) {
            const a = xform(M1, s.state.p);
            const b = xform(M2, s.state.c);
            const aim = [0, 1, 2].map((i) => a[i] + b[i] + s.bias[i]);
            if (limits) keepOut(aim, limits, noLimits);

            const v = [aim[0] - P[0], aim[1] - P[1], aim[2] - P[2]];
            const k = rsqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
            const u = [v[0] * k, v[1] * k, v[2] * k];
            const h2 = 1 - u[2] * u[2];
            const ih = rsqrt(h2);
            const frame = {
                r: [ih * u[1], -ih * u[0], 0,
                    u[0], u[1], u[2],
                    -ih * u[0] * u[2], -ih * u[1] * u[2], h2 * ih],
                t: P,
            };
            const drawn = compose(W, frame);

            const end = [0, 1, 2].map((i) => u[i] * s.length + P[i]);
            s.state.p = end;
            s.state.c = [0, 1, 2].map((i) => (end[i] - a[i]) * damping);
            if (s.model) {
                placed.push({ model: s.model, chain, segment, r: drawn.r, t: drawn.t,
                    end: xform(W, end) });
            }
            P = end;
            segment++;
        }
    }
    return placed;
}

/* The limits, in the coprocessor's order (_L2084B on). The floor first: an aim
 * below it is put back on it, and only an aim above it meets the body. */
function keepOut(aim, L, noLimits) {
    const t = L[3] - (L[0] * aim[0] + L[1] * aim[1] + L[2] * aim[2]);
    if (!ltZero(t)) {
        aim[0] += L[0] * t; aim[1] += L[1] * t; aim[2] += L[2] * t;
        return;
    }
    if (noLimits === 1) return;
    if (aim[1] < 0) {
        /* Below the frame's origin, a line for each side and height. */
        const q = aim[0] < 0
            ? (!(aim[1] <= L[23]) ? 19 : 27)
            : (!(aim[1] <= L[22]) ? 16 : 24);
        const u = L[q + 2] - (L[q] * aim[0] + L[q + 1] * aim[1]);
        if (!ltZero(u)) { aim[0] += L[q] * u; aim[1] += L[q + 1] * u; }
        return;
    }
    if (!(aim[1] <= L[14])) {
        sphere(aim, L, 4);
    } else {
        const s = aim[0] * aim[0] + aim[1] * aim[1];
        if (!(L[15] < s)) {
            const k = L[14] * rsqrt(s);
            aim[0] *= k; aim[1] *= k;
        }
    }
    sphere(aim, L, 9);
}

function sphere(aim, L, o) {
    const e = [aim[0] - L[o], aim[1] - L[o + 1], aim[2] - L[o + 2]];
    const s = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    if (L[o + 4] < s) return;
    const k = L[o + 3] * rsqrt(s);
    aim[0] = L[o] + e[0] * k; aim[1] = L[o + 1] + e[1] * k; aim[2] = L[o + 2] + e[2] * k;
}
