/*
 * pose.js — the pose the game solves a motion into.
 *
 * A fighter is sixteen parts on sixteen slots, and the slot a part sits on is
 * its index in the character's part table. The slots are not a plain chain: the
 * game runs `calc_rob_angle_cont` at `0x2FF2C`, which hands the coprocessor a
 * body matrix, two look-at aims and four two-bone IK chains, so most of the
 * skeleton is placed by solving towards a point rather than by concatenating
 * joint angles.
 *
 *   0  BODY     the waist. Coprocessor op 0x62 builds its matrix straight from
 *               the motion's own euler (object 4) and the fighter's facing.
 *   1  CHEST    body, turned by object 5, then aimed so its +X runs at the neck
 *               target (float object 13).
 *   2  HEAD     a step along the chest's +X by the skeleton's spine offset,
 *               turned by object 6, then aimed at the face target (object 14).
 *   3  4  5     left upper arm, forearm, hand
 *   6  7  8     right upper arm, forearm, hand
 *   9  PELVIS   body, turned by object 9, then rolled a quarter turn
 *   10 11 12    left thigh, shin, foot
 *   13 14 15    right thigh, shin, foot
 *
 * Each limb is one IK chain: it hangs off a pivot on the chest or the pelvis,
 * takes a base euler, and reaches for its own float target (objects 15, 16, 18
 * and 19). Only the hand and foot take an angle of their own after that —
 * objects 0 to 3. Object 12 is the body's position and object 17 is unused.
 *
 * The skeleton table the character record points at (`bonesPtr`) is sixteen
 * (x, y, z) floats on the same slot numbering, read here as the four pivots,
 * the eight bone lengths and the chest's spine offset.
 *
 * Angles are 16-bit binary radians, and the coprocessor takes their sine and
 * cosine from tables in its data ROM, one entry for every angle. Nothing here
 * uses a transcendental beyond those tables and a square root, which is what
 * the hardware has.
 *
 * Matrices are column-major three-by-threes, `m[col * 3 + row]`, with the
 * translation kept beside them — the coprocessor's own layout. `poseMatrices`
 * hands back the flat 16-element form three.js wants.
 */

/* ---- the coprocessor's trig table ---------------------------------------- */

/*
 * The firmware's sine and cosine (_L202C1 in m2-hle2's reading of it) index
 * the coprocessor's data ROM by the signed angle: sine at word 0x10000 + a,
 * cosine 0x20000 words further on. That is a table for every one of the 65536
 * angles, not a coarse table with the angle rounded into it. This file used to
 * truncate the angle to its top byte and read 256 entries, which is up to
 * 0.024 out, about 1.4 degrees, and always on the same side.
 *
 * The table's values are rounded to six decimals, so cos(0x4000) is exactly 0
 * and cos(-0x4000) is -1e-6. Rounding libm's answers the same way does not
 * give the same table (about 26,000 entries differ), so the exact values come
 * from the ROM. Until useCoproTrig has seen one, the table is filled from libm
 * at the same resolution, which is within 2e-6 of it.
 */
const COS = new Float32Array(0x10000);
const SIN = new Float32Array(0x10000);
for (let i = 0; i < 0x10000; i++) {
    COS[i] = Math.fround(Math.cos((i * 2 * Math.PI) / 0x10000));
    SIN[i] = Math.fround(Math.sin((i * 2 * Math.PI) / 0x10000));
}
const cosA = (a) => COS[a & 0xffff];
const sinA = (a) => SIN[a & 0xffff];

const COPRO_SIN = 0x10000;
const COPRO_COS = 0x30000;

/**
 * Take the sine and cosine tables out of a loaded set's coprocessor ROM. A set
 * without that region keeps the computed tables.
 *
 * @param {object} rom  from loadRomSet()
 * @returns {boolean}   whether the ROM's tables are now in use
 */
export function useCoproTrig(rom) {
    const dv = rom?.coproView;
    if (!dv || dv.byteLength < (COPRO_COS + 0x8000) * 4) return false;
    for (let i = 0; i < 0x10000; i++) {
        const a = i < 0x8000 ? i : i - 0x10000;
        SIN[i] = dv.getFloat32((COPRO_SIN + a) * 4, true);
        COS[i] = dv.getFloat32((COPRO_COS + a) * 4, true);
    }
    return true;
}

/* ---- column-major post-multiplies, one per axis --------------------------- */

function rotZ(m, c, s) {
    for (let i = 0; i < 3; i++) {
        const x = m[i], y = m[i + 3];
        m[i] = c * x - s * y; m[i + 3] = s * x + c * y;
    }
}
function rotY(m, c, s) {
    for (let i = 0; i < 3; i++) {
        const x = m[i], z = m[i + 6];
        m[i] = c * x + s * z; m[i + 6] = c * z - s * x;
    }
}
function rotX(m, c, s) {
    for (let i = 0; i < 3; i++) {
        const y = m[i + 3], z = m[i + 6];
        m[i + 3] = c * y - s * z; m[i + 6] = s * y + c * z;
    }
}

/* The joint order the coprocessor applies: Z, then Y, then X. */
function eulerZYX(m, ax, ay, az) {
    rotZ(m, cosA(az), sinA(az));
    rotY(m, cosA(ay), sinA(ay));
    rotX(m, cosA(ax), sinA(ax));
}

const clip = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

/* ---- the skeleton --------------------------------------------------------- */

export const SLOT_NAMES = [
    'BODY', 'CHEST', 'HEAD',
    'LUARM', 'LFARM', 'LHAND',
    'RUARM', 'RFARM', 'RHAND',
    'PELVIS',
    'LTHIGH', 'LSHIN', 'LFOOT',
    'RTHIGH', 'RSHIN', 'RFOOT',
];

/* Which slot each one hangs off, for the skeleton overlay. */
export const SLOT_PARENT = [-1, 0, 1, 1, 3, 4, 1, 6, 7, 0, 9, 10, 11, 9, 13, 14];

export const SLOT_COUNT = 16;

/* The slot the eyes are drawn on: they are head-local models, not skeleton
 * slots of their own. */
export const HEAD_SLOT = 2;

/* The turn that squares a chest-angled head up with the way the body faces.
 * Object 6 stands the head off the spine but leaves it looking along the
 * chest's own lateral, which reads as facing right; this brings it round to
 * forward. Only reached when the head is not aimed -- see buildPose. */
export const HEAD_FACE = 0xc000;

/* Per-chain slots and the objects that drive them: left arm, right arm, left
 * leg, right leg. `pivotSlot` is where the chain hangs, `baseAngle` the motion
 * object holding its root euler, `target` the float object it reaches for, and
 * `endAngle` the object the hand or foot turns by once it lands. */
const CHAINS = [
    { pivotSlot: 2, upperSlot: 3, lowerSlot: 4, endSlot: 5, baseAngle: 7, target: 3, endAngle: 0, flip: 0, arm: 1 },
    { pivotSlot: 5, upperSlot: 6, lowerSlot: 7, endSlot: 8, baseAngle: 8, target: 4, endAngle: 1, flip: 0, arm: 1 },
    { pivotSlot: 9, upperSlot: 10, lowerSlot: 11, endSlot: 12, baseAngle: 10, target: 6, endAngle: 2, flip: 1, arm: 0 },
    { pivotSlot: 12, upperSlot: 13, lowerSlot: 14, endSlot: 15, baseAngle: 11, target: 7, endAngle: 3, flip: 1, arm: 0 },
];

/**
 * Read a fighter's skeleton out of its bone table.
 *
 * @param {object} rom
 * @param {number} bonesPtr  the character record's `+0x04`
 */
export function readSkeleton(rom, bonesPtr) {
    const dv = rom.mainCpuView;
    const slot = (i) => [
        dv.getFloat32(bonesPtr + i * 12 + 0, true),
        dv.getFloat32(bonesPtr + i * 12 + 4, true),
        dv.getFloat32(bonesPtr + i * 12 + 8, true),
    ];
    const offsets = [];
    for (let i = 0; i < SLOT_COUNT; i++) offsets.push(slot(i));
    return {
        offsets,
        /* Chest to head, along the chest's own +X. */
        spine: offsets[1],
        /* Per chain: where it hangs, and the two bone lengths it reaches with. */
        pivot: CHAINS.map((c) => offsets[c.pivotSlot]),
        upper: CHAINS.map((c) => offsets[c.upperSlot][0]),
        lower: CHAINS.map((c) => offsets[c.lowerSlot][0]),
    };
}

/* ---- the pieces the coprocessor solves ------------------------------------ */

/* Op 0x62: the body matrix, from the motion's euler and the fighter's facing. */
function setBody(m, t, pos, a3, a4, a5, ay, ax, az) {
    const c3 = cosA(a3), s3 = sinA(a3);
    const c4 = cosA(a4), s4 = sinA(a4);
    const c5 = cosA(a5), s5 = sinA(a5);
    m[0] = c4 * c3;              m[1] = -c4 * s3;             m[2] = s4;
    m[3] = s3 * c5 + c3 * s4 * s5; m[4] = c3 * c5 - s3 * s4 * s5; m[5] = -c4 * s5;
    m[6] = s3 * s5 - c3 * s4 * c5; m[7] = c3 * s5 + s3 * s4 * c5; m[8] = c4 * c5;
    rotY(m, cosA(ay), sinA(ay));
    rotX(m, cosA(ax), sinA(ax));
    rotZ(m, cosA(az), sinA(az));
    t[0] = pos[0]; t[1] = pos[1]; t[2] = pos[2];
}

/* Turn `m` so its +X column points from `t` at `tgt`. Both the cosine and the
 * sine come out of ratios, so there is no arc-tangent anywhere. */
function aim(m, t, tgt) {
    const dx = tgt[0] - t[0], dy = tgt[1] - t[1], dz = tgt[2] - t[2];
    const d0 = dx * m[0] + dy * m[1] + dz * m[2];
    const d1 = dx * m[3] + dy * m[4] + dz * m[5];
    const d2 = dx * m[6] + dy * m[7] + dz * m[8];
    const dxy2 = d0 * d0 + d1 * d1;
    const dxy = Math.sqrt(dxy2);
    const dTot = Math.sqrt(dxy2 + d2 * d2);
    if (dxy > 1e-9) rotZ(m, clip(d0 / dxy), clip(-d1 / dxy));
    if (dTot > 1e-9) rotY(m, clip(dxy / dTot), clip(d2 / dTot));
}

/*
 * Op 0x6B: a two-bone chain from `pivot` reaching for `tgt`.
 *
 * The chain is aimed at the target first, and if it cannot span the distance it
 * simply stays straight. Otherwise the law of cosines gives the two angles, and
 * because only the cosine is needed the sine comes back as a square root — the
 * sign of which is what `flip` chooses, and is why an arm and a leg bend
 * opposite ways.
 */
function solveIK(pR, pT, pivot, ang, tgt, lower, upper, flip, out) {
    const m = pR.slice();
    const t = [pT[0], pT[1], pT[2]];

    t[0] += pivot[0] * m[0] + pivot[1] * m[3] + pivot[2] * m[6];
    t[1] += pivot[0] * m[1] + pivot[1] * m[4] + pivot[2] * m[7];
    t[2] += pivot[0] * m[2] + pivot[1] * m[5] + pivot[2] * m[8];

    eulerZYX(m, ang[0], ang[1], ang[2]);

    const dx = tgt[0] - t[0], dy = tgt[1] - t[1], dz = tgt[2] - t[2];
    const d0 = dx * m[0] + dy * m[1] + dz * m[2];
    const d1 = dx * m[3] + dy * m[4] + dz * m[5];
    const d2 = dx * m[6] + dy * m[7] + dz * m[8];
    const dxy2 = d0 * d0 + d1 * d1;
    const dTot2 = dxy2 + d2 * d2;
    const dxy = Math.sqrt(dxy2);
    const dTot = Math.sqrt(dTot2);
    if (dxy > 1e-7) rotZ(m, clip(d0 / dxy), clip(-d1 / dxy));
    if (dTot > 1e-7) rotY(m, clip(dxy / dTot), clip(d2 / dTot));

    if (lower + upper <= dTot) {                 /* out of reach: straight at it */
        out.upperR = m.slice(); out.lowerR = m.slice();
        out.upperT = [t[0], t[1], t[2]];
        out.lowerT = [t[0] + upper * m[0], t[1] + upper * m[1], t[2] + upper * m[2]];
        out.endT = [out.lowerT[0] + lower * m[0], out.lowerT[1] + lower * m[1],
                    out.lowerT[2] + lower * m[2]];
        return out;
    }

    const c1 = (lower * lower + dTot2 - upper * upper) / (2 * lower * dTot);
    let s1 = Math.sqrt(Math.max(0, 1 - c1 * c1));
    if (!flip) s1 = -s1;
    rotZ(m, clip(c1), clip(s1));
    out.lowerR = m.slice();

    const ci = (lower * lower + upper * upper - dTot2) / (2 * lower * upper);
    let s2 = Math.sqrt(Math.max(0, 1 - ci * ci));
    if (flip) s2 = -s2;
    rotZ(m, clip(-ci), clip(s2));
    out.upperR = m.slice();

    out.upperT = [t[0], t[1], t[2]];
    out.lowerT = [t[0] + upper * out.upperR[0], t[1] + upper * out.upperR[1],
                  t[2] + upper * out.upperR[2]];
    out.endT = [out.lowerT[0] + lower * out.lowerR[0], out.lowerT[1] + lower * out.lowerR[1],
                out.lowerT[2] + lower * out.lowerR[2]];
    return out;
}

/**
 * Solve one sampled frame into sixteen world transforms.
 *
 * @param {object} skel     from readSkeleton()
 * @param {object} sample   from sampleMotion()
 * @param {{world?:number[]}} [opts]  the fighter's facing in binary radians,
 *   (ry, rx, rz) — the arena's, which a fighter on its own does not have.
 * @returns {Array<{r:number[], t:number[]}>} column-major 3x3 and translation
 */
export function buildPose(skel, sample, { world = [0, 0, 0], headAim = true } = {}) {
    const { angles, targets } = sample;
    const A = (obj, axis) => angles[obj * 3 + axis];
    const T = (obj) => [targets[obj * 3], targets[obj * 3 + 1], targets[obj * 3 + 2]];

    const R = new Array(SLOT_COUNT);
    const P = new Array(SLOT_COUNT);

    /* Slot 0: the waist, placed by float object 12 and turned by object 4. */
    R[0] = new Array(9).fill(0); P[0] = [0, 0, 0];
    setBody(R[0], P[0], T(0), A(4, 2), A(4, 1), A(4, 0), world[0], world[1], world[2]);

    /* Slot 1: the chest looks at the neck target, and stays at the waist. */
    const chest = R[0].slice();
    eulerZYX(chest, A(5, 0), A(5, 1), A(5, 2));
    aim(chest, P[0], T(1));
    R[1] = chest.slice(); P[1] = [P[0][0], P[0][1], P[0][2]];

    /* Slot 2: a step up the chest's +X, object 6's euler, and a look at the
     * face target -- float object 14, which every one of the 518 motions keys
     * with real curve data.
     *
     * `headAim` false drops that last part, and then object 6 alone is left:
     * the rotation that turns the head model off the spine and forward, so the
     * face points the way the chest does. That is for the four roster entries
     * that borrow another fighter's action table -- the Final Eggman Boss, the
     * Egg UFO, the Egg Minion and Rocket Metal. Every motion has head data, but
     * none of it was authored for them, and their heads sit far enough up the
     * spine (1.466 and 1.316, against Sonic's 0.361) that a target meant for a
     * shorter fighter lands below the head and the aim turns it face-down. */
    const s1 = skel.spine;
    const headT = [
        P[0][0] + chest[0] * s1[0] + chest[3] * s1[1] + chest[6] * s1[2],
        P[0][1] + chest[1] * s1[0] + chest[4] * s1[1] + chest[7] * s1[2],
        P[0][2] + chest[2] * s1[0] + chest[5] * s1[1] + chest[8] * s1[2],
    ];
    const head = chest.slice();
    eulerZYX(head, A(6, 0), A(6, 1), A(6, 2));
    if (headAim) aim(head, headT, T(2));
    else rotZ(head, cosA(HEAD_FACE), sinA(HEAD_FACE));
    R[2] = head; P[2] = headT;

    /* Slot 9: the pelvis, turned by object 9 and rolled a quarter turn. */
    const pelvis = R[0].slice();
    eulerZYX(pelvis, A(9, 0), A(9, 1), A(9, 2));
    rotZ(pelvis, 0, 1);
    R[9] = pelvis.slice(); P[9] = [P[0][0], P[0][1], P[0][2]];

    /* The four limbs. Arms hang off the chest, legs off the pelvis, and both
     * measure their pivot from the waist. */
    const out = {};
    for (let k = 0; k < CHAINS.length; k++) {
        const c = CHAINS[k];
        const parent = k < 2 ? chest : pelvis;
        const base = [A(c.baseAngle, 0), A(c.baseAngle, 1), A(c.baseAngle, 2)];
        solveIK(parent, P[0], skel.pivot[k], base, T(c.target),
                skel.lower[k], skel.upper[k], c.flip, out);
        R[c.upperSlot] = out.upperR; P[c.upperSlot] = out.upperT;
        R[c.lowerSlot] = out.lowerR; P[c.lowerSlot] = out.lowerT;
        /* A hand carries on from the forearm; a foot stays level with the body. */
        R[c.endSlot] = (c.arm ? out.lowerR : R[0]).slice();
        eulerZYX(R[c.endSlot], A(c.endAngle, 0), A(c.endAngle, 1), A(c.endAngle, 2));
        P[c.endSlot] = out.endT;
    }

    /* Facing: a quarter turn about Y on every slot, which is where the fighter
     * ends up pointing once the parts are drawn. */
    const pose = [];
    for (let b = 0; b < SLOT_COUNT; b++) {
        const r = new Array(9);
        for (let c = 0; c < 3; c++) {
            const x = R[b][c * 3], y = R[b][c * 3 + 1], z = R[b][c * 3 + 2];
            r[c * 3] = z; r[c * 3 + 1] = y; r[c * 3 + 2] = -x;
        }
        pose.push({ r, t: [P[b][2], P[b][1], -P[b][0]] });
    }
    return pose;
}

/*
 * `buildPose` works in the board's own frame, which is what the display list
 * captured out of a machine can be checked against. The viewer's is not the
 * same one: `js/model.js` negates Z as it reads geometry, so a part's mesh is
 * already mirrored by F = diag(1, 1, -1) before any transform reaches it, and
 * the matrix that places it has to be F·M·F rather than M. Conjugating that way
 * is what keeps a rotation a rotation — the two sign flips cancel in the
 * determinant — and it comes out as negating whichever elements have exactly
 * one index on the Z axis, plus the Z of the translation. Applying M straight
 * leaves every part reflected through the XY plane: heads upside down, feet
 * pointing the wrong way.
 *
 * This is the same convention `js/display.js` states for the stage draw lists —
 * see the note above ANGLE_DEG there — so both views agree.
 */
function toViewer({ r, t }) {
    return {
        r: [
            r[0], r[1], -r[2],
            r[3], r[4], -r[5],
            -r[6], -r[7], r[8],
        ],
        t: [t[0], t[1], -t[2]],
    };
}

/** One board-frame transform as the flat column-major 4x4 three.js wants. */
export function viewerMatrix(slot) {
    const { r, t } = toViewer(slot);
    return [
        r[0], r[1], r[2], 0,
        r[3], r[4], r[5], 0,
        r[6], r[7], r[8], 0,
        t[0], t[1], t[2], 1,
    ];
}

/** The pose as flat column-major 4x4s, ready for `THREE.Matrix4.fromArray`. */
export function poseMatrices(pose) {
    return pose.map(viewerMatrix);
}

/**
 * `r` turned by Z, then Y, then X, in the coprocessor's own order and its
 * 16-bit binary radians. The sway chains need it to build their frame from a
 * bone's, so it is shared rather than repeated.
 */
export function turnedBy(r, ax, ay, az) {
    const m = r.slice();
    eulerZYX(m, ax, ay, az);
    return m;
}

/** Line segments tracing the slot tree, for the skeleton overlay. */
export function skeletonLines(pose) {
    const pts = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
        const p = SLOT_PARENT[i];
        if (p < 0) continue;
        const a = toViewer(pose[p]).t, b = toViewer(pose[i]).t;
        pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    return new Float32Array(pts);
}
