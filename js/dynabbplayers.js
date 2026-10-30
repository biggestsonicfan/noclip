/*
 * dynabbplayers.js — Dynamite Baseball 97's players (MAME's `dynabb97`), the
 * game's own skeleton and draw run on the i960 (js/doa.js's machine).
 *
 * A player is an object of 0x618 bytes at 0x5F4800 + 0x618 n. The set-up
 * 0xCDBE0 (object, team, kit, player) fills it:
 *     +0x410 the team (0..11, 12 the umpires), +0x414 the kit (0 home,
 *            1 visitor), +0x418 the player (0..35)
 *     +0x424 the player's model table, `0x1A1670[team * 2 + kit] + 0x1CC *
 *            player` (115 model numbers, then words the face and the hands
 *            read)
 *     +0x428 the draw's part list, 0x1A0AA0 (16 bytes a list)
 *     +0x434 the bone offsets, 17 float triples: work RAM 0x5DB430, which
 *            the boot (0xCD780) copies from `*0x1A0A60`; the umpires' away
 *            kit takes `*0x1A0A64` instead
 * and calls 0x9AFF0, the face (`0x5DC100 + 12 n`: its model, from the face
 * script `0x1A0B50[1]` and the player's words at +0x1B8 and +0x1C0), and
 * 0x849B0, the hands (`0x5D6500 + 16 n`: a role byte, then the gloved
 * hands, from `0x1A0A10[1]` and the word at +0x1C4). When 0x5B9528 is 0 a
 * team's player goes through a roster table at data 0x1D00042 first; the
 * explorer sets it, so the player number is the model table's.
 *
 * A frame is 0x857E0 (object): the hips (0x84EE0) from the place +0x3C4,
 * the heading +0x3D2, the root's track `0x6D54A50[motion]` (a float triple
 * a frame) and the first three angles of the frame record
 * `0x6D56800[motion] + 0x62 * frame`, then the rest of the skeleton by its
 * type +0x3D8 (0 for every player, 0x860D0, which runs 0x85800: push/pop
 * chains of a bone's move and its Z, Y and X turns). The 19 matrices land at
 * +4 + 0x30 k: the hips (0), the joints (1..17) and the base (18).
 * `0x6D52CA0[motion]` is the motion's frame count; 0x28AC0 holds the frame
 * under it. There are 1900 motions, one table for every player.
 *
 * The draw (0xCF7D0, the near models; 0xD0C60 and 0xD1C90 are the farther
 * ones) sends each joint's matrix and the models its list names: the
 * number plate, chest and back on joint 1, the face from the face record
 * and the cap on joint 2, the hands through 0x84D60 and 0x84DE0 (bare or
 * gloved by the role byte), the belt on the hips, the neck last. Checked
 * against MAME's RAM at attract frame 1500 (player 7, motion 377 frame 36):
 * every joint matrix within 0.0006, the same 22 models.
 */

import { doaMachine } from './doa.js';

const RAM = 0x500000;
const OBJ = 0x5f4800;
const OBJ_BYTES = 0x618;
const SETUP = 0xcdbe0;
const SKELETON = 0x857e0;
const DRAW = 0xcf7d0;
const BONES = 0x5db430;
const BONE_SOURCE = 0x1a0a60;
const ROSTER_OFF = 0x5b9528;
const TEAM_TABLE = 0x1a1670;
const PLAYER_BYTES = 0x1cc;
const COUNTS = 0x6d52ca0;
const ROOTS = 0x6d54a50;
const FRAMES = 0x6d56800;
const MOTIONS = 1900;
const FRAME_BYTES = 0x62;
const JOINTS = 17;
/* XTRA (0x6000000) reads the data ROMs from 0x1000000 on. */
const XTRA = 0x6000000 - 0x1000000;

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function invert(m) {
    const r = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    const t = m.slice(9);
    return [...r, ...[0, 1, 2].map((k) => -(r[k] * t[0] + r[3 + k] * t[1] + r[6 + k] * t[2]))];
}

/* The copro commands this game's program has beyond js/doa.js's: 0x21 the
 * identity, 0x7F a whole matrix, 0x87 the turn alone (the feet), 0x7A the
 * inverse (0xA4B70's skin points). */
const COPRO = {
    0x21: [0, (cp) => { cp.m = IDENTITY; }],
    0x7f: [12, (cp, a) => { cp.m = a.slice(); }],
    0x87: [9, (cp, a) => { cp.m = [...a, ...cp.m.slice(9)]; }],
    0x7a: [0, (cp) => { cp.m = invert(cp.m); }],
};

const machines = new WeakMap();
function machine(rom) {
    if (!machines.has(rom)) {
        const M = doaMachine(rom, { copro: COPRO });
        const src = new DataView(rom.maincpu.buffer, rom.maincpu.byteOffset).getUint32(BONE_SOURCE, true);
        M.ram.set(rom.maincpu.subarray(src, src + JOINTS * 12), BONES - RAM);
        M.rv.setUint32(ROSTER_OFF - RAM, 1, true);
        machines.set(rom, M);
    }
    return machines.get(rom);
}

/* The teams, by the code their models' names start with: SWVLMM_R4_J_MUNE
 * is the Swallows' visitor (V) chest; H is the home kit. Team 12's are the
 * umpire (UN_L) and, in its second kit, a figure named GALL. */
const TEAM_NAMES = ['Yakult Swallows', 'Hiroshima Carp', 'Yomiuri Giants', 'Yokohama BayStars',
    'Chunichi Dragons', 'Hanshin Tigers', 'Orix BlueWave', 'Chiba Lotte Marines',
    'Seibu Lions', 'Nippon-Ham Fighters', 'Daiei Hawks', 'Kintetsu Buffaloes'];

/*
 * The part list a player is drawn with, 0xCDCD0 (object, g1, g2): +0x428 is
 * `0x1A0AA0 + 16 (g1 * 2 + g2)` (the near, middle and far lists), +0x430
 * `(*0x1A0A90)[g1]`. The lists change the head (cap, helmet or mask) and
 * the hands; the game's calls use g1 1 (0x2E8E0, 0x479FC) and 3 (0x2E898,
 * 0x46CC4), g2 0, and the set-up 0. By the models' names: the batter's
 * hands are COMLM__B (MAME's batting player 7 at attract frame 1500), the
 * pitcher's left COMLM__P and the catcher's COMLM__C; g2 swaps the hands
 * and the head's side.
 */
export const DYNABB_ROLES = ['fielder', 'fielder, left-handed', 'batter', 'batter, left-handed',
    'pitcher', 'pitcher, left-handed', 'catcher', 'catcher, left-handed'];
const PART_LISTS = 0xcdcd0;

/* The joints by their models' names (J_MUNE and so on). */
const JOINT_NAMES = ['chest', 'head', 'upper arm R', 'forearm R', 'hand R', 'upper arm L', 'forearm L',
    'hand L', 'hips', 'thigh R', 'knee R', 'foot R', 'toes R', 'thigh L', 'knee L', 'foot L', 'toes L'];

/* A player set up in the object: the game's own set-up, the face and hands
 * it calls for in their tables. */
function setUp(M, body) {
    M.ram.fill(0, OBJ - RAM, OBJ - RAM + OBJ_BYTES);
    if (!M.cpu.call(SETUP, [OBJ, body.team, body.kit, body.player], { maxSteps: 200_000 })) {
        throw new Error(`player set-up ${body.team}/${body.kit}/${body.player} did not return`);
    }
}

/* Each draw's joint: the one whose matrix it is. */
function jointOf(M, m) {
    for (let j = 1; j <= JOINTS; j++) {
        const at = OBJ - RAM + 4 + j * 0x30;
        let d = 0;
        for (let i = 0; i < 12 && d < 1e-4; i++) d = Math.max(d, Math.abs(M.rv.getFloat32(at + i * 4, true) - m[i]));
        if (d < 1e-4) return j;
    }
    return -1;
}

/* Pose the object at a motion's frame (0 the first) and draw it. Without
 * the travel, the place cancels the root track's x and z (the heading is 0,
 * so the hips are at the place plus the track). */
function run(rom, body, motion, frame, role, travel) {
    const M = machine(rom);
    setUp(M, body);
    const o = OBJ - RAM;
    if (role) M.cpu.call(PART_LISTS, [OBJ, role >> 1, role & 1], { maxSteps: 1000 });
    M.rv.setUint32(o + 0x3dc, motion?.index ?? 0, true);
    M.rv.setUint32(o + 0x3e4, frame, true);
    if (motion && !travel && motion.root >= 0) {
        const dv = rom.mainDataView;
        M.rv.setFloat32(o + 0x3c4, -dv.getFloat32(motion.root + frame * 12, true), true);
        M.rv.setFloat32(o + 0x3cc, -dv.getFloat32(motion.root + frame * 12 + 8, true), true);
    }
    M.copro.stack = [];
    M.copro.m = IDENTITY;
    if (!M.cpu.call(SKELETON, [OBJ], { maxSteps: 2_000_000 })) throw new Error('0x857E0 did not return');
    M.copro.stack = [];
    M.copro.m = IDENTITY;
    M.geo.draws = [];
    M.cpu.call(DRAW, [OBJ], { maxSteps: 2_000_000 });
    const matrices = [];
    for (let j = 0; j < 19; j++) {
        matrices.push(Array.from({ length: 12 }, (_, i) => M.rv.getFloat32(o + 4 + j * 0x30 + i * 4, true)));
    }
    const draws = Array.from({ length: JOINTS }, () => []);
    for (const d of M.geo.draws) {
        const j = jointOf(M, d.m);
        if (j > 0) draws[j - 1].push(d.model);
    }
    return { matrices, draws };
}

/*
 * The joints' parents (matrix numbers, 1..17; a part is joint - 1),
 * measured: the joint whose frame holds a joint's place still through
 * four motions. The chest and the hips both hang from the hips' matrix
 * (0), at its origin; the hips carry the legs, the chest the head and arms.
 */
const PARENT_JOINT = {
    1: 0, 2: 1, 3: 1, 4: 3, 5: 4, 6: 1, 7: 6, 8: 7,
    9: 0, 10: 9, 11: 10, 12: 11, 13: 12, 14: 9, 15: 14, 16: 15, 17: 16,
};

/** The players: every team in both kits, 36 each, then the umpires. */
export function readDynabbPlayers(rom) {
    const pv = new DataView(rom.maincpu.buffer, rom.maincpu.byteOffset);
    const out = [];
    const add = (team, kit, player, name) => {
        const table = pv.getUint32(TEAM_TABLE + (team * 2 + kit) * 4, true) + player * PLAYER_BYTES;
        const parts = Array.from({ length: JOINTS }, (_, k) => {
            const joint = k + 1;
            let depth = 0;
            for (let p = PARENT_JOINT[joint]; p > 0; p = PARENT_JOINT[p]) depth++;
            return { index: k, name: JOINT_NAMES[k], parent: PARENT_JOINT[joint] - 1, depth, joint, flags: 0, offset: [0, 0, 0], record: table, model: null };
        });
        out.push({
            index: out.length, name, team, kit, player, joints: JOINTS, scale: 1, roles: [], skin: -1,
            hitMotions: [], start: -1, root: table, parts,
            /* Stadium 1 with the player's team on both sides (js/games.js). */
            playerSet: 12 + (team % 12),
        });
    };
    for (let team = 0; team < 12; team++) {
        for (let kit = 0; kit < 2; kit++) {
            for (let p = 0; p < 36; p++) add(team, kit, p, `${TEAM_NAMES[team]} ${p + 1}${kit ? ', visitor' : ''}`);
        }
    }
    add(12, 0, 0, 'Umpire');
    add(12, 1, 0, 'GALL');
    return out;
}

/** The 1900 motions: a frame count, the root's track, then the frames. */
export function readDynabbMotions(rom) {
    const dv = rom.mainDataView;
    const word = (table, i) => dv.getUint32(table - XTRA + i * 4, true);
    const list = [];
    for (let i = 0; i < MOTIONS; i++) {
        const frames = word(COUNTS, i);
        const offset = word(FRAMES, i) - XTRA;
        if (!frames || offset < 0 || offset + frames * FRAME_BYTES > rom.mainData.length) continue;
        list[i] = { index: i, name: `motion ${i}`, address: word(FRAMES, i), offset, frames, keys: frames, joints: JOINTS, root: word(ROOTS, i) - XTRA };
    }
    return list;
}

/** Every motion plays on every player: one skeleton, one table. */
export function dynabbMotionList(rom, body, motions) {
    const fits = motions.filter(Boolean);
    return { fits, lead: fits, label: 'Every motion in the table' };
}

/* Board matrix to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/** A player at a whole frame of a motion (1 the first), in a role's part
 * list (DYNABB_ROLES), its root's travel shown or not. */
export function poseDynabbPlayer(rom, body, motion, frame, { role = 0, travel = false } = {}) {
    const f = motion ? Math.max(1, Math.min(frame, motion.frames)) - 1 : 0;
    const { matrices, draws } = run(rom, body, motion, f, body.team < 12 ? role : 0, travel);
    const three = body.parts.map((p) => toThree(matrices[p.joint]));
    return {
        matrices: three,
        origins: three.map((e) => [e[12], e[13], e[14]]),
        draws,
        parents: body.parts.map((p) => p.parent),
    };
}
