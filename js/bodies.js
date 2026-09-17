/*
 * bodies.js — The House of the Dead's enemies: jointed bodies, and the motions
 * baked for them.
 *
 * Nothing here is solved. A body is a tree of parts, each a model hung off its
 * parent at a fixed offset and turned by three angles, and a motion is those
 * angles written out for every frame — no keys, no curves, no IK. The program
 * keeps two parallel sets of tables, one indexed by body and one by motion:
 *
 *   0x96020   body names (BO_zom, BO_frog_ct, ...)   0x96130   motion names
 *   0x94F30   joints per body                         0x95040   motion data
 *   0x94E20   the body's root part                    0x95830   frames
 *   data 0xDC0050  the body's scale
 *
 * A part record, as sub_2DFD0 builds the drawn tree out of it:
 *
 *   +0x00 model        0 for a part with nothing on it (PN_space)
 *   +0x04 offset       x, y, z from the parent, floats
 *   +0x10 flags        a byte; bit 0 is set on the ankles
 *   +0x14 joint        which three angles of the frame turn this part
 *   +0x18 child count
 *   +0x1C children     that many part pointers
 *
 * A motion frame is the root's position, three floats, then three 16-bit angles
 * per joint (x, y, z), the whole padded to a word — `((48*joints+127)>>5)*4`
 * bytes, the arithmetic sub_2CEE0 steps the frame pointer with. A motion does
 * not say how many joints it was written for; the body it is played on does.
 *
 * sub_2CEE0 draws the body: translate to the root position, turn by joint 0,
 * then sub_2BA50 per part — translate (x, y, -z), turn by coprocessor function
 * 0x86 with (-z angle, y angle, x angle), draw, recurse. Function 0x86 turns Z
 * then Y then X, each post-multiplied and each the standard rotation by the
 * negated angle; with the viewer's Z flipped against the board's, that works
 * out to T(offset)·Rz(z)·Ry(y)·Rx(x) with ordinary matrices and ordinary signs.
 *
 * Three things are drawn differently from that, all in the same two routines:
 *
 *   - An ankle (flag bit 0) under a motion that asks for it drops the turns of
 *     every part above it. Its frame starts again from the body's own, at the
 *     point the chain had reached, so a foot keeps its angle to the floor
 *     whatever the leg does. `partDraws` does not decide this; `poseBody` does.
 *
 *   - The part's model is not drawn by the tree walk. sub_2BA50 hands each part
 *     to a callback (sub_764C0), which draws it — and for some bodies draws
 *     something else, or more: Tom's coat, the hand's fingers, the spider's
 *     legs and Devilon's wings are runs of models stepped by the frame, and a
 *     gun hand is swapped for the one holding a magazine. `partDraws`.
 *
 *   - Twenty-six skins join a body's chest to its hips (`readSkin`): a mesh in
 *     the hips' space whose points on the chest side are moved every frame.
 */

import { coproSin, coproCos } from './pose.js';
import { xtraResolve } from './romset.js';

/* A C string out of the program ROM. */
function cString(rom, at) {
    let s = '';
    for (let p = at; p < rom.maincpu.length && rom.maincpu[p] && s.length < 64; p++) {
        s += String.fromCharCode(rom.maincpu[p]);
    }
    return s;
}

/** Bytes in one frame of a motion written for `joints` joints. */
export function frameBytes(joints) {
    return ((48 * joints + 127) >> 5) * 4;
}

/*
 * The part tree, flattened parent-first. The drawing recursion visits parts in
 * this same order, so a part's parent is always earlier in the list.
 */
function readParts(rom, root) {
    const dv = rom.mainCpuView;
    const parts = [];
    const walk = (at, parent, depth) => {
        if (parts.length >= 64 || at <= 0 || at + 0x1c > rom.maincpu.length) return;
        const index = parts.length;
        const children = Math.min(dv.getUint32(at + 0x18, true), 16);
        parts.push({
            index,
            parent,
            depth,
            model: dv.getUint32(at, true),
            offset: [dv.getFloat32(at + 4, true), dv.getFloat32(at + 8, true), dv.getFloat32(at + 12, true)],
            flags: rom.maincpu[at + 0x10],
            joint: dv.getUint32(at + 0x14, true),
            record: at,
        });
        for (let k = 0; k < children; k++) walk(dv.getUint32(at + 0x1c + k * 4, true), index, depth + 1);
    };
    walk(root, -1, 0);
    return parts;
}

/**
 * Every body in the table.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} {index, name, joints, scale, roles, skin, parts}
 */
export function readBodies(rom) {
    const B = rom.game.rig.bodies;
    const dv = rom.mainCpuView;
    const md = rom.mainDataView;
    const out = [];
    for (let i = 0; i < B.count; i++) {
        const root = dv.getUint32(B.trees + i * 4, true);
        const joints = dv.getUint32(B.joints + i * 4, true);
        /* What each joint is to the callback: 8 the chest and 9 the hips a skin
         * joins, 6 and 7 the hands, 1 the head. sub_764C0 reads byte 3 of an
         * eight-byte record per joint, 31 joints to a body. */
        const roles = [];
        for (let j = 0; j < joints; j++) roles.push(rom.mainData[B.roles + (i * 31 + j) * 8 + 3]);
        out.push({
            index: i,
            name: cString(rom, dv.getUint32(B.names + i * 4, true)),
            joints,
            scale: md.getFloat32(B.scales + i * 4, true),
            roles,
            /* Which skin joins this body's chest to its hips, or -1. The
             * prototype keeps the table in the data ROM; the finished game
             * moved it into the program ROM, where `ldis word_63C60[g4*2]`
             * reads it. */
            skin: (B.skinsSource === 'maincpu' ? dv : md).getInt16(B.skins + i * 2, true),
            hitMotions: readHitMotions(rom, i),
            root,
            parts: readParts(rom, root),
        });
    }
    return out;
}

/*
 * The motions a body reacts to a shot with: 0x2DE5150[body] points at ten pairs
 * of motion numbers, one pair per hit region. It is the one place the data ties
 * a body to motions, and it names families rather than moves — the zombies all
 * share MO_z_a_*hit, the monkeys MO_saru*dam, the dogs MO_ddoggdam.
 */
function readHitMotions(rom, body) {
    const at = rom.game.rig.bodies.hitMotions;
    if (!at) return [];
    const md = rom.mainDataView;
    const p = md.getUint32(at + body * 4, true);
    const off = p - 0x02000000;
    if (!p || off < 0 || off + 80 > rom.mainData.length) return [];
    const out = new Set();
    for (let k = 0; k < 20; k++) {
        const m = md.getUint32(off + k * 4, true);
        if (m) out.add(m);
    }
    return [...out];
}

/* A root position the game could have written: finite, and not the tiny or
 * enormous numbers angle bytes make when read as a float. */
function saneFloat(v) {
    return Number.isFinite(v) && Math.abs(v) < 1e4 && (v === 0 || Math.abs(v) > 1e-6);
}

function rootsSane(view, off, frames, joints, end) {
    const step = frameBytes(joints);
    if (off + frames * step > end) return false;
    for (let f = 0; f < frames; f++) {
        for (let a = 0; a < 12; a += 4) {
            if (!saneFloat(view.getFloat32(off + f * step + a, true))) return false;
        }
    }
    return true;
}

/**
 * Every motion in the table, with the joint count it was written for.
 *
 * The motions are stored end to end in table order, each padded to 16 bytes,
 * so a motion's length is the distance to the next and its frame count divides
 * it into frames of one size — which names the joint count. Taken over the
 * joint counts the bodies have, that fits exactly one for all but two motions:
 * one written for a twelve-joint body no table entry has, and the last, which
 * has nothing after it to measure to. That one is read by which joint count
 * leaves every frame's root position a plausible float.
 *
 * @param {object} rom loaded ROM set
 * @param {object[]} bodies from readBodies, for the joint counts to fit
 * @returns {object[]} {index, name, address, offset, frames, joints (null if none fits)}
 */
export function readMotions(rom, bodies) {
    const M = rom.game.rig.motions;
    const dv = rom.mainCpuView;
    const counts = [...new Set(bodies.map((b) => b.joints))].sort((a, b) => a - b);
    const list = [];
    for (let i = 0; i < M.count; i++) {
        const address = dv.getUint32(M.data + i * 4, true);
        const r = xtraResolve(rom, address);
        list.push({
            index: i,
            name: cString(rom, dv.getUint32(M.names + i * 4, true)),
            address,
            offset: r.off,
            view: r.view,
            frames: dv.getUint32(M.frames + i * 4, true),
            flatAnkles: rom.maincpu[M.flatAnkles + i] !== 0,
            joints: null,
        });
    }
    const starts = [...new Set(list.map((m) => m.offset))].sort((a, b) => a - b);
    for (const m of list) {
        const next = starts.find((s) => s > m.offset);
        const end = next ?? m.view.byteLength;
        const fits = next === undefined
            ? counts.filter((j) => rootsSane(m.view, m.offset, m.frames, j, end))
            : counts.filter((j) => ((m.frames * frameBytes(j) + 15) & ~15) === next - m.offset);
        if (fits.length === 1) m.joints = fits[0];
    }
    return list;
}

/*
 * Whether a motion's name looks like it belongs to a body. Nothing in the
 * tables pairs the two: an enemy's routine picks its body and then its motions
 * by number, one call at a time. The names are the only hint. A motion's first
 * word is often the body's family, a letter for the big ones (MO_z_walk_a for
 * the zombies, MO_k_ for the researchers) or the name itself (MO_mrg_aruki for
 * BO_mr_g). So a motion is kin to a body when that first word starts the body's
 * name, or when the two names share their first three letters (MO_handra for
 * BO_handrb). It is a guess about the names and only orders the list: 29 of the
 * 68 bodies have kin, and the zombies with names of their own (BO_neil,
 * BO_mummy) find none.
 */
export function motionKin(body, motion) {
    const stem = (s) => s.replace(/^(BO|MO)_/, '').toLowerCase();
    const b = stem(body.name).replace(/_/g, '');
    const m = stem(motion.name);
    if (b.startsWith(m.split('_')[0])) return true;
    const flat = m.replace(/_/g, '');
    let i = 0;
    while (i < b.length && i < flat.length && b[i] === flat[i]) i++;
    return i >= 3;
}

/* A motion's family: the first word of its name, or its first four letters
 * where the name has no words (MO_ddoggaruki00a, MO_ddogghashiru). */
function motionFamily(motion) {
    const s = motion.name.replace(/^MO_/, '').toLowerCase();
    return s.includes('_') ? s.split('_')[0] : s.slice(0, 4);
}

/**
 * The motions a body can play, and the ones most likely written for it.
 *
 * Any motion of the body's joint count plays on it, but one keyed on another
 * skeleton bends it out of shape: BO_zonbi_b_2 has the dogs' joint count and
 * none of their build. Nothing in the data pairs a body with its motions but
 * the hit reactions, so the lead is worked out in steps, and each only orders
 * the list and picks where to start:
 *
 *   1. Motions named like the body lead (motionKin).
 *   2. Otherwise motions go by family (their first word), and each family is
 *      scored by the skeleton: posed on a motion its own, a body stands on the
 *      floor, so the score is how far its lowest joint sits from height 0
 *      through the motion, as a share of its size, the median over the family.
 *      Families of fewer than three are passed over while a larger one is left.
 *   3. The family holding the body's own hit reactions (readHitMotions) is
 *      taken if it scores near the best.
 *   4. Failing that, a family named for another body of the same joint count
 *      (MO_mrg_* for BO_mr_g) is passed over while one named for no body is
 *      left: a flyer never touches the floor, and Devilon would otherwise stand
 *      on Mr. G's motions rather than fly on MO_b2_*.
 *   5. The best score of what remains.
 *
 * A family starts on its first motion in the table, usually the walk or the
 * stance, not its best-scoring one, which is as often a body lying down.
 *
 * @param {object} body from readBodies
 * @param {object[]} motions from readMotions
 * @param {object[]} bodies every body, for which families other bodies name
 * @returns {{fits: object[], lead: object[], label: string}}
 */
export function rankMotions(body, motions, bodies = []) {
    const fits = motions.filter((m) => m.joints === body.joints);
    const kin = fits.filter((m) => motionKin(body, m));
    if (kin.length || !fits.length) return { fits, lead: kin, label: `Named like ${body.name}` };

    let size = 0;
    for (const o of poseBody(body, null, 1).origins) size = Math.max(size, Math.hypot(o[0], o[1], o[2]));
    const score = new Map();
    for (const m of fits) {
        const lows = [];
        const step = Math.max(1, Math.floor(m.frames / 12));
        for (let f = 1; f <= m.frames; f += step) {
            let low = Infinity;
            for (const o of poseBody(body, m, f).origins) low = Math.min(low, o[1]);
            lows.push(Math.abs(low));
        }
        lows.sort((a, b) => a - b);
        score.set(m, lows[lows.length >> 1] / (size || 1));
    }
    const families = new Map();
    for (const m of fits) {
        const k = motionFamily(m);
        if (!families.has(k)) families.set(k, []);
        families.get(k).push(m);
    }
    const median = (list) => {
        const s = list.map((m) => score.get(m)).sort((a, b) => a - b);
        return s[s.length >> 1];
    };
    const byScore = (list) => [...list].sort((a, b) => median(a) - median(b));
    const all = [...families.values()];
    const big = all.filter((f) => f.length >= 3);
    const pool = byScore(big.length ? big : all);
    const top = median(pool[0]);

    const hits = (f) => f.filter((m) => body.hitMotions.includes(m.index)).length;
    const own = pool.filter((f) => hits(f) && median(f) <= Math.max(1.5 * top, top + 0.05))
        .sort((a, b) => hits(b) - hits(a))[0];
    const others = bodies.filter((b) => b !== body && b.joints === body.joints);
    const unclaimed = pool.filter((f) => !others.some((b) => f.some((m) => motionKin(b, m))));
    const best = own ?? unclaimed[0] ?? pool[0];
    const why = own ? 'its hit reactions' : unclaimed.includes(best) && unclaimed.length < pool.length
        ? 'named for no other body' : 'stands it on the floor';
    const lead = [...best].sort((a, b) => a.index - b.index);
    return { fits, lead, label: `${motionFamily(best[0])} family, ${why}` };
}

/* ---- posing -------------------------------------------------------------- */

/* Column-major 3x3 post-multiplies by the standard rotations. */
function turnZ(r, c, s) {
    for (let i = 0; i < 3; i++) {
        const x = r[i], y = r[i + 3];
        r[i] = c * x + s * y; r[i + 3] = c * y - s * x;
    }
}
function turnY(r, c, s) {
    for (let i = 0; i < 3; i++) {
        const x = r[i], z = r[i + 6];
        r[i] = c * x - s * z; r[i + 6] = s * x + c * z;
    }
}
function turnX(r, c, s) {
    for (let i = 0; i < 3; i++) {
        const y = r[i + 3], z = r[i + 6];
        r[i + 3] = c * y + s * z; r[i + 6] = c * z - s * y;
    }
}
function turn(r, ax, ay, az) {
    turnZ(r, coproCos(az), coproSin(az));
    turnY(r, coproCos(ay), coproSin(ay));
    turnX(r, coproCos(ax), coproSin(ax));
}

/*
 * One frame's numbers: the root position and each joint's three angles. Frame
 * numbers are the game's, from 1; a body with no motion reads every angle as 0
 * and stands at the origin, which is the tree as modelled.
 */
function readFrame(motion, frame, joints) {
    const angles = new Int16Array(joints * 3);
    const root = [0, 0, 0];
    if (!motion || motion.joints !== joints) return { root, angles };
    const at = motion.offset + (Math.max(1, Math.min(frame, motion.frames)) - 1) * frameBytes(joints);
    const v = motion.view;
    for (let a = 0; a < 3; a++) root[a] = v.getFloat32(at + a * 4, true);
    for (let i = 0; i < joints * 3; i++) angles[i] = v.getInt16(at + 12 + i * 2, true);
    return { root, angles };
}

/**
 * Pose a body on one frame of a motion.
 *
 * The game draws the root's height from the motion and leaves its travel to
 * the object — sub_2CEE0 subtracts the frame's own x and z back out — so a walk
 * is posed on the spot unless `travel` asks for the path the motion carries.
 *
 * An ankle under a motion flagged in the table at 0x5E880 does not inherit the
 * leg's turns. sub_2BA50 reads the matrix back once it has stepped out to the
 * ankle, reloads the one sub_2CEE0 saved before turning joint 0 (the body's
 * position, facing and scale, nothing of the pose), and steps back out to the
 * same point in it. The ankle's own angles then turn it from there, so they are
 * the foot's angle to the body rather than to the shin. Eighty-two motions ask
 * for it, among them every walk the zombies take with their feet flat.
 *
 * @param {object} body from readBodies
 * @param {object|null} motion from readMotions
 * @param {number} frame 1-based
 * @param {{travel?: boolean}} [opts]
 * @returns {{matrices: number[][], origins: number[][]}} per part, column-major 4x4s and positions
 */
export function poseBody(body, motion, frame, { travel = false } = {}) {
    const { root, angles } = readFrame(motion, frame, body.joints);
    const k = body.scale;
    const flat = Boolean(motion?.flatAnkles && motion.joints === body.joints);
    const rot = [];
    const pos = [];
    body.parts.forEach((p, i) => {
        const a = p.joint * 3;
        const [ax, ay, az] = p.joint < body.joints ? [angles[a], angles[a + 1], angles[a + 2]] : [0, 0, 0];
        if (p.parent < 0) {
            const r = [k, 0, 0, 0, k, 0, 0, 0, k];
            turn(r, ax, ay, az);
            rot[i] = r;
            pos[i] = [travel ? k * root[0] : 0, k * root[1], travel ? k * root[2] : 0];
            return;
        }
        const pr = rot[p.parent], pt = pos[p.parent], o = p.offset;
        pos[i] = [0, 1, 2].map((row) => pt[row] + pr[row] * o[0] + pr[row + 3] * o[1] + pr[row + 6] * o[2]);
        const r = flat && (p.flags & 1) ? [k, 0, 0, 0, k, 0, 0, 0, k] : pr.slice();
        turn(r, ax, ay, az);
        rot[i] = r;
    });
    return {
        matrices: rot.map((r, i) => [
            r[0], r[1], r[2], 0,
            r[3], r[4], r[5], 0,
            r[6], r[7], r[8], 0,
            pos[i][0], pos[i][1], pos[i][2], 1,
        ]),
        origins: pos,
    };
}

/* ---- what each part draws ------------------------------------------------- */

/* Motions and models the callback names, for the bodies it treats apart. */
const TOM = 2, HAND = 6, GMAN = 14, GMAN_KIHON = 17, HARIDE = 18, STAJE = 19;
const SPIDER = 34, SAMSON = 35, SOPHIE = 39, DEVILON = 59, DEVILON_M = 64;
const ROLE_HEAD = 1, ROLE_GUN_HAND = 6, ROLE_OTHER_HAND = 7, ROLE_CHEST = 8, ROLE_HIPS = 9;

/**
 * The models the game draws on each part this frame, as sub_764C0 picks them.
 *
 * Most parts draw their own model and nothing else. The exceptions, all keyed
 * on the body number and then on the joint or its role:
 *
 *   Tom, G, gman_kihon   the gun hand holds a magazine or an empty hand through
 *                        a reload (MO_gman_soten, 124), and the plain gun hand
 *                        for stretches of the dashes and shots; Tom's chest
 *                        also draws his coat, PN_cococo000a-099a, a model every
 *                        second frame over two loops of the motion
 *   BO_handrb            the fingers on joint 3, one model a frame
 *   the spider           its legs on joint 3, PN_tara_asi, one model a frame
 *   Samson               his right hand, swapped every vsync for PN_samson_ter2
 *   Sophie               her head: eyes shut three vsyncs in ninety, or a run
 *                        of PN_sofatama_CT through MO_s_tatiaga
 *   the two Devilons     a hundred-model wing beat, drawn with the chest
 *
 * The muzzle flashes of the firing motions are left out: they are drawn along
 * a matrix sub_FE90 keeps, not along the part.
 *
 * @param {object} body from readBodies
 * @param {object|null} motion from readMotions
 * @param {number} frame the motion frame, from 1
 * @param {number} tick the vsync counter (0x51EFE8), which also counts loops
 * @returns {number[][]} per part, the model numbers drawn on it
 */
export function partDraws(body, motion, frame, tick) {
    const id = motion?.index ?? -1;
    const frames = Math.max(1, motion?.frames ?? 1);
    /* The game's frame counter runs 1 to frames - 1 and names models by it, so
     * a run of models is one shorter than the motion it plays with. */
    const f = Math.max(1, Math.min(frame, frames - 1));
    const loops = Math.floor(tick / frames);
    const b = body.index;
    return body.parts.map((p) => {
        const own = p.model ? [p.model] : [];
        const role = body.roles[p.joint] ?? 0;
        if (b === TOM || b === GMAN || b === GMAN_KIHON) {
            if (role === ROLE_OTHER_HAND && id === 124 && f > 29) return [1728];
            if (role === ROLE_GUN_HAND) {
                if (id === 244) return [795];
                if (id === 124) return [2445];
                if (id === 118 && f > 19 && f <= 40) return [1734];
                if (id === 232 && f >= 1 && f <= 18) return [1734];
                if ((id === 332 || id === 337) && f >= 1 && f <= 9) return [1734];
                if (id === 333 && ((f > 45 && f <= 54) || (f > 77 && f <= 86) || (f > 108 && f <= 117))) return [1734];
            }
            if (role === ROLE_CHEST && b === TOM && id !== 244) {
                return [...own, 162 + (((f >> 1) + 50 * (loops % 2)) % 100)];
            }
        }
        if ((b === HARIDE || b === STAJE) && role === ROLE_GUN_HAND && id === 337 && f >= 1 && f <= 9) return [1734];
        if (b === HAND && p.joint === 3) return [(id === 126 ? 2452 : 2493) + f];
        if (b === SPIDER && p.joint === 3) return [4157 + f];
        if (b === SAMSON && p.joint === 5) return [1300 + (tick & 1)];
        if (b === SOPHIE && role === ROLE_HEAD) {
            if (id === 262 || id === 267 || id === 269) return [1467];
            if (id === 268 && f > 55 && f <= 70) return [1469 + ((f - 56) % 15)];
            return [tick % 90 > 2 ? 1468 : 1467];
        }
        if (b === DEVILON && p.joint === 1) return [...own, 4814 + (tick % 100)];
        if (b === DEVILON_M && p.joint === 1) return [...own, 1886 + (tick % 100)];
        return own;
    });
}

/* ---- skins ----------------------------------------------------------------- */

/**
 * The skin joining a body's chest to its hips, or null.
 *
 * sub_4DEF0 copies a template out of the data ROM when the body is made — the
 * same 40-byte records as a model's mesh, `count` of them and a closing one —
 * and every frame sub_4DF90 moves some of its points: up to twelve, given in
 * the chest's space, carried into the hips' by inverse(hips)·chest and written
 * over the template's point at the slot two lookup tables name. One slot is
 * written twice, once more at a second place, where two records share a point.
 * The result is drawn on the hips' matrix with the texture pointers stored
 * beside the template, as any model is.
 *
 * The chest and hips are the joints the callback captures matrices on: role 8
 * and role 9.
 *
 * @param {object} rom loaded ROM set
 * @param {object} body from readBodies
 * @returns {null|object}
 */
export function readSkin(rom, body) {
    const S = rom.game.rig.skins;
    if (!S || body.skin < 0) return null;
    const hips = body.parts.find((p) => body.roles[p.joint] === ROLE_HIPS);
    const chest = body.parts.find((p) => body.roles[p.joint] === ROLE_CHEST);
    if (!hips || !chest) return null;
    const dv = rom.mainDataView;
    const i = body.skin;
    /* The texture records the skin is drawn with. They moved with the skin
     * index: the prototype keeps one pair per skin beside it in the data ROM,
     * and the finished game one pair per body in the program ROM, which
     * `ldl 0x63D20[g4*8]` reads with the body number the draw was given. Bodies
     * sharing a skin carry the same pair there. */
    const pv = S.pointersSource === 'maincpu' ? rom.mainCpuView : dv;
    const pi = S.pointersBy === 'body' ? body.index : i;
    const count = dv.getUint32(S.counts + i * 4, true);
    /* 10 * count + 7 words: the records, and the closing one up to its attribute. */
    const used = 40 * count + 28;
    if (count < 1 || used > S.templateBytes) return null;
    const at = S.templates + i * S.templateBytes;
    const template = new Uint8Array(40 * (count + 1));
    template.set(rom.mainData.subarray(at, at + used));

    const shared = dv.getInt32(S.shared + i * 8, true);
    const sharedTo = dv.getInt32(S.shared + i * 8 + 4, true);
    const points = [];
    for (let k = 0; k < Math.min(count >> 1, 12); k++) {
        const order = dv.getUint32(S.order + i * 48 + k * 4, true);
        const slot = dv.getUint32(S.slots + i * 96 + order * 4, true);
        const to = [slot * 40];
        if (slot === shared) to.push(sharedTo === -1 ? 12 : sharedTo * 40);
        points.push({
            p: [0, 1, 2].map((c) => dv.getFloat32(S.points + i * 144 + k * 12 + c * 4, true)),
            to: to.filter((o) => o >= 0 && o + 12 <= template.length),
        });
    }
    return {
        index: i,
        count,
        template,
        uvPtr: pv.getUint32(S.pointers + pi * 8, true),
        matPtr: pv.getUint32(S.pointers + pi * 8 + 4, true),
        hips: hips.index,
        chest: chest.index,
        points,
    };
}

/**
 * The skin's mesh on one pose, in the hips' space: the bytes model.js decodes.
 *
 * @param {object} skin from readSkin
 * @param {number[][]} matrices from poseBody
 * @returns {{bytes: Uint8Array, uvPtr: number, matPtr: number}}
 */
export function skinMesh(skin, matrices) {
    const A = matrices[skin.hips], B = matrices[skin.chest];
    const bytes = skin.template.slice();
    const view = new DataView(bytes.buffer);
    /* Both matrices carry the body's scale, so the inverse is the transpose over
     * the scale squared and the scales cancel. */
    const k2 = A[0] * A[0] + A[1] * A[1] + A[2] * A[2];
    for (const { p, to } of skin.points) {
        /* The board's z is the viewer's negated, going in and coming out. */
        const v = [p[0], p[1], -p[2]];
        const d = [0, 1, 2].map((r) => B[r] * v[0] + B[4 + r] * v[1] + B[8 + r] * v[2] + B[12 + r] - A[12 + r]);
        const l = [0, 1, 2].map((c) => (A[c * 4] * d[0] + A[c * 4 + 1] * d[1] + A[c * 4 + 2] * d[2]) / k2);
        for (const o of to) {
            view.setFloat32(o, l[0], true);
            view.setFloat32(o + 4, l[1], true);
            view.setFloat32(o + 8, -l[2], true);
        }
    }
    return { bytes, uvPtr: skin.uvPtr, matPtr: skin.matPtr };
}

/** Line segments from each part to its parent, for the skeleton overlay. */
export function bodySkeletonLines(body, origins) {
    const out = new Float32Array(Math.max(0, body.parts.length - 1) * 6);
    let n = 0;
    for (const p of body.parts) {
        if (p.parent < 0) continue;
        out.set(origins[p.parent], n);
        out.set(origins[p.index], n + 3);
        n += 6;
    }
    return out;
}
