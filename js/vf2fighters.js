/*
 * vf2fighters.js — Virtua Fighter 2's fighters, and the motions they play.
 *
 * The rig is Sonic The Fighters' a year early: sixteen part slots, the same
 * keyframe blocks (js/motion.js), and a pose routine at 0x27CE0 that is
 * calc_rob_angle_cont nearly op for op. So the pose comes out of js/pose.js,
 * and what is here is where Virtua Fighter 2 keeps things and the three places
 * it solves differently.
 *
 * The roster. Character set-up (0x13F08) reads the record
 * `ld 0x200620C[char*4]`, with the character number at player +0x1B0:
 *
 *   +0x00  the sixteen part models, copied to player +0x40, which the part
 *          loop at 0x18FE8 draws slot by slot
 *   +0x04  the skeleton: fifteen (x, y, z) offsets copied to player +0x8C, entry
 *          j slot j+1's place in its parent's frame
 *   +0x30  the texture set, handed to the request at 0x4B838; its handler loads
 *          it and the next, as Fighting Vipers' does
 *   +0x3C  thirty-two hand models to the slot (0x19E34 picks the fists and open
 *          hands from it); the part list's own are the ones a motion starts on
 *
 * Fourteen records. Entries 10, 11 and 12 are the one pointer, Lion's record;
 * the name tables call 11 and 12 MUE and KOJACKY, slots the record table fills
 * with Lion. 13 is the first fighter's again with other parts, and no name
 * table reaches it.
 *
 * The motions. A motion id indexes the pointer table at data 0x2120004
 * (`ld 0x2120004[g0*4]` in set-up, 0x1A21C, and in the curve walk, 0x27B5C).
 * Entry 0 points at the table's own end, 1360 entries on, which is its length.
 *
 * The pose differs from Sonic The Fighters' in three places:
 *
 *   - It is solved on one standard rig for everyone, the table at program ROM
 *     0x296A0 (`g6` through 0x2901C and op 0x6B), not on the fighter's own
 *     skeleton: the chest and head offsets, then per limb its pivot and the two
 *     bone lengths op 0x6B reaches with.
 *   - A motion can hold a slot's look as angles instead of a point: a float
 *     object keyed with channel type 1 (13, 14 or 17) is latched by 0x26FAC,
 *     rounded into an angle and flagged at player +0xBDC, and the draw turns
 *     Rz then Ry by it. All but one motion hold the pelvis (17) at
 *     (0, 0, 0x4000) this way, a quarter roll.
 *   - A foot turns from the floor: 0x171B0 loads the matrix the draw saved at
 *     0x501024 — the fighter's place and facing, before any of the pose — and
 *     turns object 2's (or 3's) euler from there.
 *
 * Then the draw (0x16504-0x176A0) places the parts, and only there does the
 * fighter's own skeleton come in: each slot steps out from its parent by the
 * record's offset, turned by its parent's solved matrix, and takes its own
 * rotation from the solve (op 0x69 on the coprocessor address op 0x6B left it
 * at). A fighter whose arms are longer than the standard rig's has hands a
 * little past where the solve put them, as on the board.
 *
 * What the fight adds, played frame after frame:
 *
 *   - The blend (set up at 0x27630): at a motion switch, each angle object's
 *     residual E(new)^T E(old) B, as Y, X, Z angles, is shifted down to a
 *     step at player +0xBE8; the draw turns by it times (N - frame). N comes
 *     from the new motion's length, 8 frames for one longer than 16. The hand
 *     and foot targets blend the same way (0x27730), x and z measured from
 *     the body position. A loop blends into itself. A motion that blends
 *     out (blendMode) eases its last N frames toward a stance pose (0x2776C).
 *   - The head (0x2922C) turns toward the face target at most 0x800 a frame
 *     in yaw and 0x400 in pitch, the pitch held to +-0x2000.
 *   - The crouch (0x29414): characters 6 and 10 draw their body at 0.97 of
 *     its height, 8 at 0.92 (player +0xC50).
 *
 *   - The face target (0x2867C): the fight writes the other fighter's head,
 *     where the draw left it (+0x20C, 0x168A0), over the motion's own at
 *     +0xB0C, moved into this fighter's frame by its place (+0x18) and facing
 *     (+0x26). Player 1 is posed and drawn first, so it looks at player 2's
 *     head of the frame before, and player 2 at player 1's of this one. The
 *     explorer stands an opponent where a round starts it (poseBout).
 *
 * Fighting Vipers poses its fighters with the same routines (its profile's
 * `rig` names the addresses, and the three things it does its own way: the
 * texture set's field, the crouch table and how far the head steps).
 *
 * Left out: the part of when the fight lets the head look at the other
 * fighter that is not the motion's move flags (0x500034 and +0), as the
 * explorer's fight is always under way; and the chest's twist toward it
 * (+0xBE6, 0x2912C), which is the move's.
 */

import { buildPose, poseMatrices, viewerMatrix, turnedBy, turnedInOrder, SLOT_COUNT, SLOT_PARENT } from './pose.js';
import { decodeMotion, sampleMotion, resolveData } from './motion.js';
import { readModelEntry } from './romset.js';
import { readDebrisTables } from './fvdebris.js';
import { commandMotions } from './moves.js';
import { handModels, handsAt, itemAt, gameLoops } from './fighterhands.js';
import { setupWord } from './reactions.js';

/* The record's fields. Fighting Vipers keeps the texture set at +0x20 and
 * names its own (`rig.fighters.texSet`). */
const PARTS = 0x00, SKELETON = 0x04, TEXTURE_SET = 0x30;

/* The standard rig at 0x296A0: chest and head, 12 bytes each, then per limb a
 * pivot and its upper and lower lengths, 20 bytes; the pelvis between the arms
 * and the legs. */
const RIG_LIMBS = [24, 44, 76, 96];
const RIG_HEAD = 12;

/* A data address as {view, off}, in main data or through the XTRA window;
 * null where it does not land. */
function dataAt(rom, addr) {
    const r = resolveData(rom, addr);
    return r && r.off + 4 <= r.data.length ? r : null;
}

const vec = (dv, at) => [0, 4, 8].map((k) => dv.getFloat32(at + k, true));

/** The standard rig every fighter is solved on, in js/pose.js's shape. */
export function standardRig(rom) {
    const dv = rom.mainCpuView;
    const at = rom.game.rig.standardRig;
    return {
        spine: vec(dv, at + RIG_HEAD),
        pivot: RIG_LIMBS.map((o) => vec(dv, at + o)),
        upper: RIG_LIMBS.map((o) => dv.getFloat32(at + o + 12, true)),
        lower: RIG_LIMBS.map((o) => dv.getFloat32(at + o + 16, true)),
    };
}

/* Each slot's place in its parent's frame: slot 0 at the body's own origin,
 * the rest out of the record's fifteen. */
function readOffsets(rom, at) {
    const out = [[0, 0, 0]];
    const r = dataAt(rom, at);
    for (let j = 1; j < SLOT_COUNT; j++) out.push(r ? vec(r.view, r.off + (j - 1) * 12) : [0, 0, 0]);
    return out;
}

function depthOf(slot) {
    let d = 0;
    for (let p = SLOT_PARENT[slot]; p >= 0; p = SLOT_PARENT[p]) d++;
    return d;
}

/**
 * The roster, as the bodies the rig panel lists (see js/bodies.js for the
 * shape): one part per slot, hung off the slot the draw steps out from.
 *
 * @returns {object[]} {index, name, joints, scale, root, texSet, offsets, parts, ...}
 */
export function readFighters(rom) {
    const F = rom.game.rig.fighters;
    const out = [];
    for (let i = 0; i < F.count; i++) {
        const body = readFighter(rom, F, i, i);
        if (F.p2) {
            const p2 = readFighter(rom, F, i + F.p2, i);
            body.p2 = { ...p2, name: F.names[i + F.p2] ?? `${body.name} (P2)` };
        }
        out.push(body);
    }
    return out;
}

/*
 * Record `record`, as fighter `char` wears it. Fighting Vipers keeps a second
 * record per fighter, `rig.fighters.p2` on: player +0x1B0 indexes the records,
 * the colour tables and the armour's, and 0xA0A8 adds 13 to player 2's when
 * both pick the same fighter, so that is the second player's look. +0x1B1, the
 * fighter less those 13 (0xA0D8), is what the crouch reads.
 */
function readFighter(rom, F, record, char) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const root = u32(F.records + record * 4);
    const list = u32(root + PARTS);
    const offsets = readOffsets(rom, u32(root + SKELETON));
    const actions = F.actions ? readActions(rom, F.actions, u32(root + F.actions.at)) : [];
    return {
        index: record,
        char,
        name: F.names[record] ?? `character ${record}`,
        joints: SLOT_COUNT,
        scale: 1,
        roles: [],
        skin: -1,
        hitMotions: [],
        start: actions[0] ?? -1,
        actions,
        commands: F.commands ? readCommands(rom, F.commands, char) : [],
        poses: F.poses ? readPoses(rom, F.poses, char) : [],
        root,
        texSet: u32(root + (F.texSet ?? TEXTURE_SET)),
        armour: F.armour ? readArmour(rom, F.armour, record) : null,
        extras: F.armour ? [...readPads(rom, F.armour, record), ...readSkirt(rom, F.armour, record)] : F.item ? [itemExtra(F.item)] : [],
        midriff: F.midriff ? readMidriff(rom, F.midriff, root, record) : null,
        offsets,
        parts: offsets.map((offset, s) => ({
            index: s, model: u32(list + s * 4), offset, joint: s,
            parent: SLOT_PARENT[s], depth: depthOf(s), flags: 0,
        })),
    };
}

/*
 * Fighting Vipers' armour (TECHNICAL.md, "Armour breaking"). `table` is
 * 0x640EDAC[char]: sixteen 8-byte entries, one a slot, bytes 0-3 the pieces
 * each stage throws off (0 ends the list) and +4 the pieces, 0x28 bytes each.
 * efc_crush_parts_set writes a stage's first piece's +4 into the slot (player
 * +0x40), so that is the model the slot shows from then on. `chest` is
 * mune_unit_change's 0x6421F80[char]: for the four fighters it names, a
 * broken chest is one of 31 models (its +4, signed halfwords) a spring picks,
 * 15 + trunc(position + 0.5) (see bounceStep); at rest that is entry `rest`.
 */
const ARMOUR_ENTRY = 8, ARMOUR_PIECE = 0x28, ARMOUR_STAGES = 4;

/* One piece record as 0x2D390 copies it into a flying slot (fvdebris.js):
 * +6 the model thrown (0 throws nothing), +8/+0xA/+0xC its X, Y and Z turns,
 * +0xE/+0x10/+0x12 the turns it settles on (0 none), +0x14 its weight (a
 * float, whose bits also pick its spin and heading), +0x18 its radius against
 * the walls, +0x1C its flags, +0x20 its floor. */
function readArmourPiece(dv, o, slot, stage) {
    const h = (k) => dv.getInt16(o + k, true);
    return {
        slot, stage, model: h(6), angles: [h(8), h(0xa), h(0xc)], targets: [h(0xe), h(0x10), h(0x12)],
        weight: dv.getFloat32(o + 0x14, true), weightBits: dv.getUint32(o + 0x14, true),
        radius: dv.getFloat32(o + 0x18, true), flags: dv.getUint32(o + 0x1c, true), floor: dv.getFloat32(o + 0x20, true),
    };
}

/* Per slot, the model each stage leaves on it, in order (empty for a slot
 * that never breaks), and every piece its stages throw off. */
function readArmourSlots(rom, table) {
    const slots = [], pieces = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
        const r = table && dataAt(rom, table + s * ARMOUR_ENTRY);
        const stages = [], thrown = [];
        if (r) {
            const list = r.view.getUint32(r.off + 4, true);
            let k = 0;
            for (let st = 0; st < ARMOUR_STAGES; st++) {
                const n = r.view.getUint8(r.off + st);
                const p = n ? dataAt(rom, list + k * ARMOUR_PIECE) : null;
                if (!p || p.off + n * ARMOUR_PIECE > p.data.length) break;
                stages.push(p.view.getInt16(p.off + 4, true));
                for (let j = 0; j < n; j++) thrown.push(readArmourPiece(p.view, p.off + j * ARMOUR_PIECE, s, st));
                k += n;
            }
        }
        slots.push(stages);
        pieces.push(thrown);
    }
    return { slots, pieces };
}

/* A chest spring: 0x6421F80[char] +4 points at 31 signed halfwords, the
 * models the spring picks by index. Null for a fighter with no spring. */
const BOUNCE_MODELS = 31;

function readChestModels(rom, A, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const rec = A.chest ? u32(A.chest + i * 4) : 0;
    const list = rec ? u32(rec + 4) : 0;
    const r = list ? dataAt(rom, list) : null;
    if (!r || r.off + BOUNCE_MODELS * 2 > r.data.length) return null;
    return Array.from({ length: BOUNCE_MODELS }, (_, k) => r.view.getInt16(r.off + k * 2, true));
}

/* The chest's per-frame list, 0x6421F80[char] +0: a count word, then that
 * many 16-bit models (mune_unit_change, 0x318B4). Null with none. */
function readChestList(rom, A, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const rec = A.chest ? u32(A.chest + i * 4) : 0;
    const at = rec ? u32(rec) : 0;
    const n = at ? u32(at) : 0;
    const r = n ? resolveData(rom, at + 4) : null;
    if (!r || r.off + n * 2 > r.data.length) return null;
    return Array.from({ length: n }, (_, k) => r.view.getUint16(r.off + k * 2, true));
}

/*
 * The hips a long win streak leaves: koshi_unit_change (0x31ADC) draws slot 9
 * for a fighter with a record at 0x6422400[char], and where that record's
 * +0x18 is set, the streak (0x5000A2) is at least 100 and the hips are broken
 * (+0x1F48 bit 9), it draws the model at +0x18's first halfword instead of
 * any it would swing through (0x31B94, 0x31D58). The streak is the versus
 * one: 0xE06C counts it up while the same side keeps winning and sets it back
 * to 1 when the other side wins. readHips reads it as `broken`.
 */
export const STREAK_WINS = 100;

/*
 * koshi_unit_change's 0x6422400[char] (Honey and Bahn): eight pointers.
 * +0 the standing and the low pair, +0xC motion 0x31's list (41 halfwords),
 * +0x10 motion 0x180's (indexed by frame, unbounded: read for the motion's
 * frames), +0x18 Honey's broken hips, +0x1C a list of (motion, list) ending
 * in motion 0, each list a count and then that many pairs. A pair is the
 * intact model and the broken one. +4, +8 and +0x14 need move flags or fight
 * state the explorer lacks (TECHNICAL.md, "The hips"), so they are not read.
 */
const HIPS_M31 = 0x31, HIPS_M180 = 0x180, HIPS_M31_LAST = 40;

function readHalves(rom, addr, n) {
    const r = addr ? dataAt(rom, addr) : null;
    if (!r || r.off + n * 2 > r.data.length) return null;
    return Array.from({ length: n }, (_, k) => r.view.getInt16(r.off + k * 2, true));
}

const toPairs = (flat) => flat && Array.from({ length: flat.length >> 1 }, (_, k) => [flat[2 * k], flat[2 * k + 1]]);

function readHips(rom, A, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const t = A.hips ? u32(A.hips + i * 4) : 0;
    if (!t) return null;
    const [base, low] = toPairs(readHalves(rom, u32(t), 4)) ?? [];
    const byMotion = new Map();
    for (let e = u32(t + 0x1C); e && u32(e); e += 8) {
        const list = u32(e + 4), n = u32(list);
        const got = n ? toPairs(readHalves(rom, list + 4, n * 2)) : null;
        if (got) byMotion.set(u32(e), got);
    }
    const m180 = decodeMotion(rom, HIPS_M180);
    return {
        base, low, byMotion,
        m31: readHalves(rom, u32(t + 0xC), HIPS_M31_LAST + 1),
        m180: m180 ? readHalves(rom, u32(t + 0x10), m180.frames + 1) : null,
        broken: readHalves(rom, u32(t + 0x18), 1)?.[0] ?? null,
    };
}

/* Every model readHips can pick, for the roster's model list. */
export function hipModels(H) {
    if (!H) return [];
    const out = [...(H.base ?? []), ...(H.low ?? []), ...(H.m31 ?? []), ...(H.m180 ?? [])];
    for (const list of H.byMotion.values()) for (const p of list) out.push(...p);
    if (H.broken != null) out.push(H.broken);
    return [...new Set(out)].filter((m) => m > 0);
}

function readArmour(rom, A, i) {
    const r = dataAt(rom, A.table + i * 4);
    const table = r ? r.view.getUint32(r.off, true) : 0;
    const { slots, pieces } = readArmourSlots(rom, table);
    if (!slots.some((x) => x.length)) return null;
    const bounce = readChestModels(rom, A, i);
    const hips = readHips(rom, A, i);
    return {
        table, slots, pieces, bounce, chest: bounce ? bounce[A.rest] : null, hips, streakHips: hips?.broken ?? null,
        bounceList: bounce ? readChestList(rom, A, i) : null,
        hair: A.hair?.includes(i) ? HAIR_PIECES.map((p, k) => ({ ...p, slot: HEAD_SLOT, offset: HAIR_OFFSET, hair: k })) : null,
        flipbook: readFlipbook(rom, A.debris, i),
    };
}

/* The flipbook effect a piece with flag bit 3 becomes (0x2D254): the
 * record's 0x6421760 entry, 54 halfword models, one a frame. */
const FLIPBOOK_FRAMES = 54;

function readFlipbook(rom, D, i) {
    const at = (addr) => (D?.flipbook ? dataAt(rom, addr) : null);
    const r = at(D?.flipbook + i * 4);
    const list = r && at(r.view.getUint32(r.off, true));
    if (!list || list.off + FLIPBOOK_FRAMES * 2 > list.data.length) return null;
    return Array.from({ length: FLIPBOOK_FRAMES }, (_, k) => list.view.getUint16(list.off + k * 2, true));
}

/*
 * Picky's hair (TECHNICAL.md, "Picky's hair"). pky_kami_disp (0x1ADDC) draws
 * it on the head's matrix, for the characters rob_disp names (0x1A1C0), once
 * the helmet (slot 2, +0x1F48 bit 2) has broken. The models, the translate
 * and the turns are the immediates pky_kami_init (0x1AD08) writes to player
 * +0xA70..+0xAA4, the same for anyone: three models, each drawn twice, at
 * the swing (`s`, +0xA98) and at half of it (`s >> 1`), with the turns sent
 * in the order listed after the translate.
 */
const HAIR_OFFSET = [0, 0, Math.fround(-0.2510)];
const HAIR_PIECES = [
    { model: 680, turns: (s) => [[1, 0x4000], [0, 0x8000], [2, -s]] },
    { model: 680, turns: (s) => [[1, 0x4000], [0, 0x8000], [2, -(s >> 1)]] },
    { model: 908, turns: (s) => [[1, 0xc000], [2, s]] },
    { model: 908, turns: (s) => [[1, 0xc000], [2, s >> 1]] },
    { model: 909, turns: (s) => [[1, s + 0x8000], [2, 0x4000]] },
    { model: 909, turns: (s) => [[1, (s >> 1) + 0x8000], [2, 0x4000]] },
];

/*
 * The hair's swing, stepped once a frame after the draw (0x1B18C), so a frame
 * draws the swing the frame before left. It is kicked by the head's height
 * (+0x210, slot 2's y): v is this frame's rise, the kick 180000 times its
 * change from last frame's v (+0xA88 = 180.0, times 1000.0), negated unless
 * last frame's v was negative (its sign bit), truncated to an integer. The
 * swing's speed (+0xA9A) gains the kick, loses 48 (+0xA9C; three times that
 * with move flags +0x1A4 bit 16 set and bit 15 clear, which the explorer
 * never has), and is held to at most 0x300 (+0xA9E). The swing gains the
 * speed; at 0x3000 or more it stops there, at 0 or less it rests at 0, and
 * either way the speed is cleared. pky_kami_init starts all of it at 0, the
 * last height too.
 */
const HAIR_KICK = Math.fround(180000), HAIR_DAMP = 48, HAIR_SPEED = 0x300, HAIR_TOP = 0x3000;

export function hairStep(h, y) {
    const v = f32(y - h.y);
    let dv = f32(v - h.v);
    if (!(h.v < 0 || Object.is(h.v, -0))) dv = -dv;
    let w = Math.min(h.w + Math.trunc(f32(HAIR_KICK * dv)) - HAIR_DAMP, HAIR_SPEED);
    let s = h.s + w;
    if (s >= HAIR_TOP) { s = HAIR_TOP; w = 0; }
    if (s <= 0) { s = 0; w = 0; }
    Object.assign(h, { s, w, y, v });
    return h;
}

/* damage_unit's halves: slots 0-8 are the upper body, 9-15 the lower. */
const LOWER_FIRST = 9, CHEST = 1;

/*
 * Shoulder pads and skirt (TECHNICAL.md, "Shoulder pads and skirt"). Each is
 * drawn on a slot's matrix as rob_disp leaves it: translate, ang_z, ang_y,
 * ang_x, set_obj; a pad's second model is translated again on the pad's own
 * matrix. Each routine adds a swing from the arms or thighs (padSwings,
 * skirtSwings). `hiddenBy` is the slot whose bit in +0x1F48 skips the piece.
 * A model of 0 (or -1) is no model, as for the parts.
 *
 * kata_pat_disp (slot 1): 0x642147C[char] points at a left and a right
 * record, 0x24 bytes: +0 model, +2 the swing's limit, +4 translate,
 * +0x10/+0x12/+0x14 the X/Y/Z turns (the left's Y negated), +0x16 a second
 * model, +0x18 its translate. The left goes when slot 6 breaks, the right
 * when slot 3 does; each swings with that upper arm, the left's added to its
 * X turn and the right's taken off.
 */
const PAD_SIDES = [
    { hiddenBy: 6, flipY: true, arm: 6, sign: 1 },
    { hiddenBy: 3, flipY: false, arm: 3, sign: -1 },
];

function readPads(rom, A, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const list = A.pads ? u32(A.pads + i * 4) : 0;
    const out = [];
    PAD_SIDES.forEach(({ hiddenBy, flipY }, side) => {
        const r = list ? dataAt(rom, u32(list + side * 4)) : null;
        if (!r || r.off + 0x24 > r.data.length) return;
        const dv = r.view, o = r.off;
        const model = dv.getInt16(o, true);
        if (model <= 0) return;
        const y = dv.getUint16(o + 0x12, true);
        const pad = {
            slot: CHEST, hiddenBy, model, offset: vec(dv, o + 4), pad: side, limit: dv.getInt16(o + 2, true),
            turn: [dv.getUint16(o + 0x10, true), flipY ? -y & 0xffff : y, dv.getUint16(o + 0x14, true)],
        };
        out.push(pad);
        const second = dv.getInt16(o + 0x16, true);
        if (second > 0) out.push({ ...pad, model: second, then: vec(dv, o + 0x18) });
    });
    return out;
}

/*
 * kosi_mino_disp (slot 9), for the characters it names: four panels from
 * 0x6421DE0[char * 16] (models at +0..+6, a float at +8), placed by the
 * constants action_init writes to 0x50A324..0x50A378, the same for everyone.
 * Panels 3 and 4 step a further +8 / -(+8) along Z. Each swings about one
 * axis (`swing`: the turn it adds to, and which way) once a thigh lifts it
 * past its limit; skirtSwings works out how far.
 */
const SKIRT_PANELS = [
    { at: 4, offset: [0.013, 0.087, 0], z: 0, swing: [0, 1], limit: 0x3000 },
    { at: 6, offset: [0.013, -0.088, 0], z: 0, swing: [0, -1], limit: 0x1e00 },
    { at: 2, offset: [0, -0.017, 0.107], z: 1, swing: [1, 1], limit: 0x1000 },
    { at: 0, offset: [0, -0.017, -0.107], z: -1, swing: [1, -1], limit: 0x1000 },
];
const SKIRT_TURN = [0x4000, 0xc000, 0], HIPS = 9;

function readSkirt(rom, A, i) {
    const r = A.skirt?.chars.includes(i) ? dataAt(rom, A.skirt.table + i * 16) : null;
    if (!r) return [];
    const dv = r.view, f = dv.getFloat32(r.off + 8, true);
    return SKIRT_PANELS.map(({ at, offset, z }, panel) => ({
        slot: HIPS, hiddenBy: HIPS, model: dv.getInt16(r.off + at, true), panel,
        offset: [offset[0], offset[1], offset[2] + z * f], turn: SKIRT_TURN,
    })).filter((e) => e.model > 0);
}

/*
 * How far each panel swings this frame (kosi_mino_disp, 0x31E54; TECHNICAL.md,
 * "The skirt"). calc_unit_mat reads back each matrix's roll, Fn_get_glo_ang's
 * third angle, atan2(col0.y, col1.y): the hips' less a half turn (+0xAD4), the
 * thighs' (slot 13 +0xADA, slot 10 +0xAE0). A thigh's spread is hips + thigh +
 * a half turn: from 0 up it pushes panels 1 and 3 (or 1 and 4), below 0 panels
 * 2 and 3 (2 and 4). Its lift (+0xAD8, +0xADE) is atan2(x, sin(hips) z +
 * cos(hips) y) of the thigh's bone vector as the motion turns it, before the
 * facing's quarter turn. The board takes slot 13's lift for slot 10's share
 * of panel 4, and so does this. Measured against MAME's attract mode, the
 * thighs' rolls and lifts come out as the board's, and the hips' roll as the
 * board's negated, so it is taken that way round.
 */
const SKIRT_THIGHS = [13, 10];
const roll = (s) => brad(Math.atan2(s.r[1], s.r[4]));

function thighLift(r, o, hips) {
    // The explorer's (x, y, z) is the board's (z, y, -x): undo the facing.
    const [z, y, x] = [0, 1, 2].map((k) => r[k] * o[0] + r[k + 3] * o[1] + r[k + 6] * o[2]);
    return brad(Math.atan2(-x, Math.sin(rad(hips)) * z + Math.cos(rad(hips)) * y));
}

function skirtSwings(pose, offsets) {
    const hips = s16(0x8000 - roll(pose[HIPS]));
    const [a, b] = SKIRT_THIGHS.map((slot) => {
        const d = s16(hips + roll(pose[slot]) + 0x8000);
        return { lift: thighLift(pose[slot].r, offsets[slot + 1], hips), out: Math.max(d, 0), back: Math.max(-d, 0) };
    });
    const cos = (w) => Math.cos(rad(w)), sin = (w) => Math.sin(rad(w));
    const by = (spread, f) => (f >= 0 ? Math.trunc(spread * f) : 0);
    const reach = [
        [by(a.out, cos(a.lift + 0x8000)), by(b.out, cos(b.lift + 0x8000))],
        [by(a.back, cos(a.lift)), by(b.back, cos(b.lift))],
        [by(a.out, sin(a.lift + 0x8000)), by(a.back, sin(a.lift + 0x8000))],
        [by(b.out, -sin(b.lift + 0x8000)), by(b.back, sin(a.lift + 0x8000))],
    ];
    return reach.map((r, k) => Math.max(0, Math.max(...r) - SKIRT_PANELS[k].limit));
}

/*
 * How far each pad swings this frame (kata_pat_disp, 0x32A90; TECHNICAL.md,
 * "The shoulder pads"). The lean is the head's origin less the waist's
 * (player +0x20C less +0x1F4, slots 2 and 0); p is the upper arm's reach to
 * the elbow (slot 7's offset, +0xD4, turned by slot 6; slot 4's, +0xB0, by
 * slot 3) along it. The swing is atan2(p, sqrt(L^2 - p^2)), asin(p / L) with
 * L that offset's x: 0 while p is below 0, at most the pad's limit. Facing
 * turns the lean and the arm alike, so the explorer's frame does as well.
 */
function padSwing(pose, offsets, arm, limit) {
    const { r } = pose[arm], o = offsets[arm + 1];
    const v = [0, 1, 2].map((k) => r[k] * o[0] + r[k + 3] * o[1] + r[k + 6] * o[2]);
    const lean = [0, 1, 2].map((k) => pose[2].t[k] - pose[0].t[k]);
    const p = (v[0] * lean[0] + v[1] * lean[1] + v[2] * lean[2]) / Math.hypot(...lean);
    if (!(p >= 0)) return 0;
    const L = o[0];
    return Math.min(p < L ? brad(Math.atan2(p, Math.sqrt(L * L - p * p))) : 0x4000, limit);
}

/* A pad, panel or lock of hair turned by its swing; one with none, as it is. */
function swungExtra(e, swings, pose, offsets, hair) {
    if (e.hair !== undefined) return { ...e, turns: e.turns(hair) };
    if (e.pad !== undefined) {
        const { arm, sign } = PAD_SIDES[e.pad];
        const s = padSwing(pose, offsets, arm, e.limit);
        return { ...e, swing: s, turn: [(e.turn[0] + sign * s) & 0xffff, e.turn[1], e.turn[2]] };
    }
    if (e.panel === undefined || !swings) return e;
    const [axis, sign] = SKIRT_PANELS[e.panel].swing;
    return { ...e, turn: e.turn.map((v, k) => (k === axis ? (v + sign * swings[e.panel]) & 0xffff : v)) };
}

/*
 * The midriff (TECHNICAL.md, "The midriff"): a strip of triangles from a ring
 * on the hips to a ring on the chest, in the hips' frame, which calc_unit_mat
 * (0x17A30) writes into polygon RAM every frame and rob_disp (0x1A2D8) draws
 * on the hips' matrix. `at` is the record's pointer to it: +8 the model whose
 * texture points and material it is drawn with, +0x70 the chest's ring, +0xD0
 * the link count and +0xD4 the links, 0x28 bytes each (an attribute, a normal,
 * two points), then a closing word and two index bytes a link. An index from 8
 * up is chest point index - 8, put in the hips' frame; below 8 the link's own
 * point, already in it. The draw starts 4 words in, past the first attribute
 * and normal, so the bytes are model.js's records as they stand. A broken
 * chest (+0x1F48 bit 1) takes `broken[char]`'s model: same points, other
 * material. It is drawn in geometrizer mode 3 (0x58F0), which skips the stored
 * normals and lights each face by its plane, so the band shades as it bends.
 */
const MIDRIFF = { model: 8, ring: 0x70, count: 0xd0, links: 0xd4, link: 0x28, first: 8, ringPoints: 16 };

function midriffLook(rom, dv, at) {
    const model = dv.getInt32(at + MIDRIFF.model, true);
    const { uvPtr, matPtr } = readModelEntry(rom, model);
    return { model, uvPtr, matPtr };
}

function readMidriff(rom, M, root, i) {
    const u32 = (addr) => { const r = dataAt(rom, addr); return r ? r.view.getUint32(r.off, true) : 0; };
    const r = dataAt(rom, u32(root + M.at));
    if (!r) return null;
    const dv = r.view, o = r.off, count = dv.getUint32(o + MIDRIFF.count, true);
    const links = o + MIDRIFF.links, index = links + (10 * count + 1) * 4;
    if (count < 1 || index + 2 * count > r.data.length) return null;
    const template = new Uint8Array(MIDRIFF.link * count);
    template.set(r.data.subarray(links + 16, links + MIDRIFF.link * count + 4));
    const byPoint = new Map();
    for (let k = 0; k < 2 * count; k++) {
        const n = r.data[index + k] - MIDRIFF.first;
        if (n < 0 || n >= MIDRIFF.ringPoints) continue;
        if (!byPoint.has(n)) byPoint.set(n, { p: vec(dv, o + MIDRIFF.ring + n * 12), to: [] });
        byPoint.get(n).to.push(MIDRIFF.link * (k >> 1) + 12 * (k & 1));
    }
    const b = dataAt(rom, u32(u32(M.broken + i * 4) ? M.broken + i * 4 : root + M.at));
    return {
        template, points: [...byPoint.values()], hips: HIPS, chest: CHEST, planeNormals: true,
        ...midriffLook(rom, dv, o), broken: midriffLook(rom, (b ?? r).view, (b ?? r).off),
    };
}

/* A pad or panel's board-frame transform on its slot's. */
/* VF2's item (games.js `item`), an extra that shows only while the motion
 * has it out. */
const itemExtra = (I) => ({ item: true, slot: I.slots[0], model: I.model, offset: I.offset, turns: [[2, I.turn]] });

/* The item's place when mirrored: the other hand, z negated (0x19544). */
function mirroredItem(e, I) {
    return { ...e, slot: I.slots[1], offset: [e.offset[0], e.offset[1], -e.offset[2]] };
}

function placeExtra(slot, e) {
    const at = (r, t, o) => [0, 1, 2].map((k) => t[k] + r[k] * o[0] + r[3 + k] * o[1] + r[6 + k] * o[2]);
    const t = at(slot.r, slot.t, e.offset);
    const r = e.turns ? turnedInOrder(slot.r, e.turns) : turnedBy(slot.r, e.turn[0], e.turn[1], e.turn[2]);
    return { r, t: e.then ? at(r, t, e.then) : t };
}

/** The tables the flying pieces are thrown by, from the profile's
 * `armour.debris`; null in a game without them. */
export function fighterDebrisTables(rom) {
    const D = rom.game.rig?.fighters?.armour?.debris;
    return D ? readDebrisTables(rom, D, dataAt) : null;
}

/** Which halves of a fighter have a slot that breaks: damage_unit breaks one
 * half at a time, so each is a switch of its own. */
export function armourHalves(body) {
    const A = body.armour;
    const has = (from, to) => !!A && A.slots.slice(from, to).some((x) => x.length > 0);
    return { upper: has(0, LOWER_FIRST), lower: has(LOWER_FIRST, SLOT_COUNT) };
}

/**
 * The fighter as a hit that breaks a half leaves it: in the board one hit runs
 * every slot of the half through all its stages, so each broken slot shows
 * its last stage's model, and a chest with a spring its resting model, which
 * `bounce` (the 31 models) lets the spring change frame by frame.
 *
 * @param {object} body from readFighters
 * @param {{upper: boolean, lower: boolean, streak?: boolean}} which the
 *        halves that are broken, and whether the fighter is on a win streak
 *        of STREAK_WINS or more (readHips' `broken`)
 * @returns {object} the body, or a copy with its parts' models swapped
 */
export function armouredFighter(body, which) {
    const A = body.armour;
    if (!A || (!which.upper && !which.lower)) return body;
    const broken = (s) => (s < LOWER_FIRST ? which.upper : which.lower) && A.slots[s].length > 0;
    const extras = body.extras.filter((e) => !broken(e.hiddenBy));
    /* Picky's hair shows once the helmet is off (+0x1F48 bit 2). */
    if (A.hair && broken(HEAD_SLOT)) extras.push(...A.hair);
    const parts = body.parts.map((p) => {
        if (!broken(p.index)) return p;
        const last = A.slots[p.index][A.slots[p.index].length - 1];
        const model = p.index === CHEST && A.chest != null ? A.chest
            : p.index === HIPS && which.streak && A.streakHips > 0 ? A.streakHips : last;
        return { ...p, model: model > 0 ? model : 0 };
    });
    /* Only a broken chest bounces (+0x1F48 bit 1); an intact one keeps its
     * slot model, as mune_unit_change returns it unchanged. */
    const bounce = broken(CHEST) && A.bounce ? A.bounce : null;
    /* The per-frame list, and the model the break left in the slot (+0x44),
     * which mune_unit_change hands back on a frame it leaves both alone. */
    const bounceList = bounce ? A.bounceList : null;
    const chestSlot = bounce ? A.slots[CHEST][A.slots[CHEST].length - 1] : null;
    const midriff = broken(CHEST) && body.midriff ? { ...body.midriff, ...body.midriff.broken } : body.midriff;
    /* The fight's +0x7F4 bit 2, which Grace's sway chains are switched on
     * (js/osage.js) whether or not a slot of the half breaks. */
    const upperBroken = Boolean(which.upper);
    /* What each broken half throws off, in damage_unit's order: its slots
     * ascending, each slot's stages in turn (fvdebris.js). */
    const thrown = (from, to) => A.pieces.slice(from, to).flat().filter((p) => broken(p.slot));
    const debris = { upper: thrown(0, LOWER_FIRST), lower: thrown(LOWER_FIRST, SLOT_COUNT) };
    return { ...body, parts, extras, bounce, bounceList, chestSlot, midriff, debris, hipsBroken: broken(HIPS), upperBroken, streak: Boolean(which.streak) };
}

/**
 * Every motion in the table, decoded, indexed by id (holes are null).
 */
export function readFighterMotions(rom) {
    const M = rom.game.motionTable;
    const list = [];
    for (let id = 0; id < M.count; id++) {
        const d = decodeMotion(rom, id);
        list.push(d ? { ...d, index: id, name: `motion ${id}`, joints: SLOT_COUNT } : null);
    }
    return list;
}

/*
 * A fighter's own motions, where the game names them (`rig.fighters.actions`,
 * both games', and `commands`, Fighting Vipers'). Record +0x14 is the action table,
 * action_init's `ld 0x14(g5)` to player +0x1A0, which the action code reads as
 * `ldos n(g6)`: 55 motion ids, the stance first (set_mot_dat, 0x1B5B0, plays
 * slot 0 as a round starts, 0x12AB8, and as a move winds back to neutral). The
 * commands are the input program the matcher runs for the fighter,
 * `ld 0x1EBE0[+0x1B1*4]` at 0x1D360, through js/moves.js. set_mot_dat keeps an
 * id's low 13 bits; bit 15 turns the fighter round.
 */
const MOTION_ID = 0x1fff;

function readActions(rom, A, at) {
    const r = at && dataAt(rom, at);
    if (!r) return [];
    const out = [];
    for (let i = 0; i < A.count && r.off + i * 2 + 2 <= r.data.length; i++) out.push(r.view.getUint16(r.off + i * 2, true) & MOTION_ID);
    return out;
}

/*
 * The motions a motion hands over to when it ends. set_mot_dat (0x1B880) runs
 * the set-up half of the motion's mot_list record (`rig.fighters.handover`,
 * 0x6411E94[id], twelve bytes of head) through the handlers at 0x1B9A4: op 1's
 * u16 and op 0x13's two go to +0x802 and +0x86C, which 0x1C114 plays as the
 * motion runs out in place of the stance. Op 0xA's {key, frame, motion} is a
 * switch (+0x838): a command of type 20 sets +0x60C to the key, and 0x1CC4C
 * plays the motion once the frame comes. The lengths are each handler's
 * `addo n, r11, r11`; 0x10 is a count and that many u16s; 0 and 8 end it.
 */
const SETUP_LENGTH = {
    0x01: 3, 0x02: 7, 0x03: 14, 0x04: 19, 0x05: 14, 0x06: 6, 0x07: 3, 0x09: 15,
    0x0a: 6, 0x0b: 11, 0x0c: 4, 0x0d: 3, 0x0e: 15, 0x0f: 3, 0x11: 7, 0x12: 7,
    0x13: 7, 0x14: 3, 0x15: 6, 0x16: 5, 0x17: 3, 0x18: 13,
};
const SETUP_LIST = 0x10, SETUP_NEXT = 0x01, SETUP_NEXT_PAIR = 0x13, SETUP_SWITCH = 0x0a;

/*
 * After set-up op 8 comes the play half, which 0x1C24C runs as the motion's
 * frame passes each op's u16 (handlers 0x1D028; the lengths are their
 * `addo n, g4, g4`). Ops 0xA, 0xB (at random: Honey's and Sanman's stances
 * fidget) and 0x17 switch to the motion at the offset in PLAY_SWITCH, through
 * +0x852 and 0x1CCA4.
 */
const PLAY_LENGTH = [
    0, 3, 3, 13, 7, 4, 4, 4, 4, 4, 9, 7, 4, 4, 7, 3,
    4, 4, 7, 5, 4, 4, 5, 6, 12, 4, 4, 4, 6, 3, 4,
];
const PLAY_SWITCH = { 0x0a: 5, 0x0b: 5, 0x17: 4 };
const SETUP_PLAY = 0x08;

function handovers(rom, H, id) {
    const rec = dataAt(rom, H.table + id * 4);
    const r = rec && dataAt(rom, rec.view.getUint32(rec.off, true) + H.head);
    if (!r) return [];
    const out = [];
    const u8 = (k) => r.view.getUint8(r.off + k), u16 = (k) => r.view.getUint16(r.off + k, true);
    const fits = (k) => r.off + k + 8 <= r.data.length;
    let k = 0;
    while (fits(k)) {
        const op = u8(k);
        if (op === SETUP_LIST) { k += 2 + u8(k + 1) * 2; continue; }
        if (!SETUP_LENGTH[op]) break;
        if (op === SETUP_NEXT || op === SETUP_NEXT_PAIR) out.push(u16(k + 1));
        if (op === SETUP_NEXT_PAIR) out.push(u16(k + 3));
        if (op === SETUP_SWITCH) out.push(u16(k + 4));
        k += SETUP_LENGTH[op];
    }
    if (u8(k) === SETUP_PLAY) {
        for (k++; fits(k) && PLAY_LENGTH[u8(k)]; k += PLAY_LENGTH[u8(k)]) {
            if (PLAY_SWITCH[u8(k)]) out.push(u16(k + PLAY_SWITCH[u8(k)]));
        }
    }
    return out.map((n) => n & MOTION_ID).filter((n) => n && n !== MOTION_ID);
}

/* Every motion `ids` hand over to, and those hand over to, not in `ids`. */
function handedOver(rom, H, ids) {
    const have = new Set(ids);
    const todo = [...ids];
    const out = [];
    while (todo.length) {
        for (const n of handovers(rom, H, todo.shift())) {
            if (have.has(n)) continue;
            have.add(n);
            out.push(n);
            todo.push(n);
        }
    }
    return out;
}

/* The program table is the program ROM's, where the matcher runs. */
function readCommands(rom, C, char) {
    const at = C.table + char * 4;
    if (at + 4 > rom.maincpu.length) return [];
    return commandMotions(rom, rom.mainCpuView.getUint32(at, true)).map((id) => id & MOTION_ID);
}

/*
 * The poses round flow and the attract mode give a fighter, by +0x1B1. At
 * round start 0xC77C commands `intro`'s u16; the win pick 0x3CCB8 takes one
 * of `wins`' four u16 tables, by the button held or the time and life left;
 * 0x3CD98 plays `timeUp`'s u32, 21 for all. The attract showcase (0x52628)
 * runs two scripts a player: 0x529BC's twenty-byte records swap the fighter
 * (+0x10) at the frame in +0xE, 0x52BF8's eight-byte ones command the u32 at
 * +0 at the frame in +4. A frame no later than the one before ends a script.
 */
function readPoses(rom, P, char) {
    if (char >= P.count) return [];
    const u16 = (a) => { const r = dataAt(rom, a); return r ? r.view.getUint16(r.off, true) : 0; };
    const u32 = (a) => { const r = dataAt(rom, a); return r ? r.view.getUint32(r.off, true) : 0; };
    const out = [u16(P.intro + char * 2)];
    for (let k = 0; k < 4; k++) out.push(u16(u32(P.wins + k * 4) + char * 2));
    out.push(u32(P.timeUp + char * 4));
    for (const [fighters, poses] of P.showcase) {
        const who = scriptRows(rom, fighters, 20, 0xe).map(([at, r]) => [at, r.view.getUint8(r.off + 0x10)]);
        for (const [at, r] of scriptRows(rom, poses, 8, 4)) {
            if (who.findLast(([from]) => from <= at)?.[1] === char) out.push(r.view.getUint32(r.off, true));
        }
    }
    return out.map((id) => id & MOTION_ID).filter(Boolean);
}

function scriptRows(rom, at, size, frame) {
    const rows = [];
    for (let prev = -1; ; at += size) {
        const r = dataAt(rom, at);
        const f = r ? r.view.getUint16(r.off + frame, true) : -1;
        if (f <= prev) return rows;
        rows.push([f, r]);
        prev = f;
    }
}

/**
 * The stance, then the fighter's moves, then the rest of its action table,
 * what those hand over to, its round and attract poses, then every other
 * motion. Virtua Fighter 2 has no input tables, so its fighters' own are the
 * action table's; any motion still plays on any fighter.
 */
export function fighterMotionList(rom, body, motions) {
    const fits = motions.filter(Boolean);
    const every = 'Every motion in the table';
    if (!body.actions.length) return { fits, lead: [], label: '', every };
    const taken = new Set();
    const own = (ids) => ids.map((id) => motions[id]).filter((m) => m && !taken.has(m) && taken.add(m));
    const groups = [
        { label: 'Idle', list: own(body.actions.slice(0, 1)) },
        { label: 'Its moves, by the input table', list: own(body.commands) },
        { label: 'The rest of its action table', list: own(body.actions) },
    ];
    const H = rom.game.rig.fighters.handover;
    if (H) groups.push({ label: 'What those hand over to', list: own(handedOver(rom, H, [...body.actions, ...body.commands])) });
    if (body.poses?.length) {
        const poses = H ? [...body.poses, ...handedOver(rom, H, body.poses)] : body.poses;
        groups.push({ label: 'Its intro, win and show poses', list: own(poses) });
    }
    return { fits, lead: groups.flatMap((g) => g.list), groups, label: '', every, other: 'Every other motion' };
}

const REST = {
    angles: new Uint16Array(36),
    targets: new Float32Array(24),
    targetUsed: new Uint8Array(8),
};

/*
 * Step the solved slots out along the fighter's own skeleton, parent first:
 * each keeps its rotation and moves to its parent's place plus the parent's
 * matrix times its offset. The board's frame turns both sides alike, so this
 * works on buildPose's output as it stands.
 */
function onOwnSkeleton(pose, offsets) {
    for (let s = 1; s < SLOT_COUNT; s++) {
        const { r, t } = pose[SLOT_PARENT[s]];
        const o = offsets[s];
        pose[s].t = [0, 1, 2].map((k) => t[k] + r[k] * o[0] + r[k + 3] * o[1] + r[k + 6] * o[2]);
    }
    return pose;
}

/*
 * Float objects a motion holds as angles instead of keying as a point. The
 * set-up at 0x26FAC takes an object whose channels are latched type 1, rounds
 * its three floats into the player's angle table (0x29724) and sets the
 * object's bit at +0xBDC; 0x2901C then turns the part by them, Z then Y, in
 * place of the aim. All but one of the 1359 motions hold the pelvis, float
 * object 17, at (0, 0, 0x4000): the quarter-turn roll of Sonic the Fighters,
 * given as data. The chest (13) and head (14) could be held the same way.
 */
const HELD = [[13, 1], [14, 2], [17, 9]];
const LATCHED_ANGLES = 1;

function heldAngles(rom, motion) {
    const held = {};
    for (const [obj, slot] of HELD) {
        const ch = motion.channels.slice(obj * 3, obj * 3 + 3);
        if (ch.some((c) => c.type !== LATCHED_ANGLES)) continue;
        const v = ch.map((c) => Math.round(c.view.getFloat32(c.values, true)));
        held[slot] = [v[1], v[2]];
    }
    return held;
}

/*
 * The crouch (0x29414): three fighters stand lower than their motions, the
 * body's height scaled by a constant; the draw adds the difference (+0xC50).
 * Keyed by character, so Lion's other two slots stand at full height. A game
 * with its own table names it as `rig.crouch`.
 */
const CROUCH = { 6: 0.97, 8: 0.92, 10: 0.97 };

/*
 * The blend between motions. When a motion takes over, the set-up at 0x27630
 * works out, for each of the twelve angle objects, the turn that takes the
 * new motion's first frame back to the pose last drawn (op 0x2A005454, as Y, X
 * and Z angles), and an eighth of it is the step. The pose routine adds what
 * is left after each object's euler (+0xBE8), seven steps on the first frame,
 * one fewer each frame after, none from the eighth. Measured against MAME's
 * attract mode, the steps are the residual shifted right three, exactly. The
 * eight points blend the same way, an eighth of old less new a step, with
 * each point's x and z measured from the body's (0x272A4), so the body keeps
 * its place on the floor and only its height blends.
 *
 * How long is the new motion's to say: set-up (0x27130) takes its frame count
 * (+0x800) and blends 8 frames into one longer than 16, 4 into one of 9 to
 * 16, 2 into 5 to 8, 1 into 3 or 4, and none into a shorter one; the step is
 * the residual shifted by 3, 2 or 1 (0x2760C). Which ways a switch blends
 * comes from move flags at +0x1A4, +0xC30 and +0x814 (blendMode); the blend
 * out toward a stance pose is blendOutFor's.
 *
 * The first frame is sampled as it will be drawn: 0x28780 mirrors it when
 * the fighter is mirrored (+0 bit 6, 0x28840), so a mirrored fighter's blend
 * starts from its own mirrored frame.
 *
 * A motion whose setup word has bit 20 turns the fighter round (op 0's tail
 * at 0x1B444 flips the facing), and one after a motion whose word had bit 6
 * was played turned; the new motion is drawn in the turned frame. There the
 * set-up (0x27384-0x27558; FV 0x2A1C4) does not walk the hands, feet and
 * body back (objects 0-4's steps zeroed, 0x27660; FV 0x2A3FC) but turns the
 * old points' x and z by the new body's turn less the old one as drawn,
 * E(new 4) (E(old 4) B(old 4))^-1, before taking the steps. The loop restart
 * (0x1ABD8) reloads neither word, so each pass of a looping motion turns only
 * if the motion before its first did with bit 6.
 */
const blendLength = (frames) => (frames > 16 ? 8 : frames > 8 ? 4 : frames > 4 ? 2 : frames > 2 ? 1 : 0);
const blendShift = (n) => (n === 8 ? 3 : n === 4 ? 2 : 1);

const rad = (a) => (a * Math.PI) / 0x8000;
const brad = (r) => Math.round((r * 0x8000) / Math.PI);
const mul3 = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
function turn(axis, a) {
    const c = Math.cos(rad(a)), s = Math.sin(rad(a));
    if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
    if (axis === 1) return [[c, 0, -s], [0, 1, 0], [s, 0, c]];
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
const eulerOf = ([x, y, z]) => mul3(mul3(turn(2, z), turn(1, y)), turn(0, x));
const blendOf = ([x, y, z]) => mul3(mul3(turn(1, y), turn(0, x)), turn(2, z));

/* The (x, y, z) that blendOf turns back into `m`. */
function yxzOf(m) {
    return [brad(Math.asin(-m[1][2])), brad(Math.atan2(-m[0][2], m[2][2])), brad(Math.atan2(m[1][0], m[1][1]))];
}

const tripleAt = (angles, obj) => [0, 1, 2].map((k) => (angles[obj * 3 + k] << 16) >> 16);
const transpose = (m) => m.map((_, i) => m.map((row) => row[i]));
const MOVE_TURN = 1 << 20, TURNED_BEFORE = 1 << 6, BODY = 4;

/* Per object, the step that walks from the last pose drawn to the new one;
 * none for the hands, feet and body (0-4) when the fighter turns. */
function blendSteps(fromAngles, fromBlend, toAngles, shift, turned = false) {
    return Array.from({ length: 12 }, (_, obj) => {
        if (turned && obj <= BODY) return [0, 0, 0];
        const was = mul3(eulerOf(tripleAt(fromAngles, obj)), blendOf(fromBlend[obj]));
        const now = eulerOf(tripleAt(toAngles, obj));
        const back = mul3(now.map((_, i) => now.map((row) => row[i])), was);
        return yxzOf(back).map((v) => v >> shift);
    });
}

/* The same for the points, x and z taken from the body's. */
function pointSteps(from, to, shift) {
    const rel = (t, i) => t[i] - (i % 3 === 1 ? 0 : t[i % 3]);
    return Array.from(from, (_, i) => (rel(from, i) - rel(to, i)) / (1 << shift));
}

/* The old points turned into the new body's frame (0x27388): x and z about
 * the body's, height kept. */
function turnPoints(from, fromAngles, fromBlend, toAngles) {
    const was = mul3(eulerOf(tripleAt(fromAngles, BODY)), blendOf(fromBlend[BODY]));
    const m = mul3(eulerOf(tripleAt(toAngles, BODY)), transpose(was));
    const out = from.slice();
    for (let i = 0; i < from.length; i += 3) {
        const x = from[i] - from[0], z = from[i + 2] - from[2];
        out[i] = from[0] + m[0][0] * x + m[0][2] * z;
        out[i + 2] = from[2] + m[2][0] * x + m[2][2] * z;
    }
    return out;
}

/*
 * The head's look (0x2922C): it turns toward the face target at most 0x800 a
 * frame and pitches at most 0x400, the pitch kept within 0x2000 of level. A
 * target behind the head's plane is brought level with it, and one just
 * behind and to the side leaves a head turned fully one way as it is. Under
 * playback the explorer steps; on a frame picked on its own the head is where
 * the steps would end.
 */
const LOOK_TURN = 0x800, LOOK_PITCH = 0x400, LOOK_PITCH_LIMIT = 0x2000;
const LOOK = { turn: LOOK_TURN, pitch: LOOK_PITCH };
const s16 = (v) => (v << 16) >> 16;
const stepTo = (from, to, max) => from + Math.max(-max, Math.min(max, to - from));

export function headStep([ay, az], [d0, d1, d2], free = false, { turn, pitch } = LOOK) {
    let keep = false;
    if (d1 < 0) {
        d1 = 0;
        keep = d0 >= 0 ? d0 <= 0.5 && (az & 0xffff) === 0x8000 : d0 >= -0.5 && (az & 0xffff) === 0;
    }
    const turnTo = -brad(Math.atan2(d1, d0)), pitchTo = brad(Math.atan2(d2, Math.hypot(d0, d1)));
    const z = keep ? az : s16(free ? turnTo : stepTo(az, turnTo, turn));
    const y = free ? pitchTo : stepTo(ay, pitchTo, pitch);
    return [Math.max(-LOOK_PITCH_LIMIT, Math.min(LOOK_PITCH_LIMIT, y)), z];
}

/*
 * Fighting Vipers steps the head as far again when it is following the
 * motion's own target: 0x2B274 clears player +0x7D7, sets it only where the
 * fight writes the other fighter's head over the target (the same tests as
 * 0x286A0 here), and 0x2BE0C steps 0x2000 in both while it is clear. Its
 * profile gives that as `rig.look.own`; the explorer's fighter alone looks at
 * its own target, one in a bout at the opponent's head.
 */
function lookLimits(rom, faceTarget) {
    const own = rom.game.rig.look?.own;
    return own && !faceTarget ? { turn: own, pitch: own } : LOOK;
}

/*
 * The other fighter's head `other` where the fight writes it over the target
 * on this frame, else undefined. Of the tests before the store (VF2
 * 0x28634-0x286A0, FV 0x2B274-0x2B310) the move flags are the ones a motion sets: none of
 * `rig.look.gate` may be up (the strike, the crouch, the air, the throws).
 * The rest are the round and the fighter's state, which the explorer has as
 * a fight under way.
 */
function looksAtOther(rom, motion, frame, other) {
    const gate = rom.game.rig.look?.gate;
    if (!other || !motion) return undefined;
    return !gate || !((moveFlags(rom, motion)?.[frame] ?? 0) & gate) ? other : undefined;
}

/* What each fighter carries from one frame to the next under playback: the
 * last frame's sample, the blend then and its steps, and the head's look. */
const LIVE = new WeakMap();
const ZERO_BLEND = Array.from({ length: 12 }, () => [0, 0, 0]);

function liveFor(body) {
    let live = LIVE.get(body);
    if (!live) {
        live = {
            motion: null, frame: 0, last: null, blend: ZERO_BLEND, steps: null, points: null, length: 0, look: [0, 0],
            spring: null, before: 0, mode: 0, out: null, outDone: false,
        };
        LIVE.set(body, live);
    }
    return live;
}

/*
 * Which ways the switch into `motion` blends: the mode the blend set-up (VF2
 * 0x27130, FV 0x29F50) stores at +0xBDD, bit 0 in (BLEND_IN) and bit 1 out
 * (BLEND_OUT). Before the fight's own tests it is the motion's, in the game's
 * order: Fighting Vipers blends neither way where the record's u32 at `held`
 * (+0x860) has bit 2; a new +0x1A4 (the setup word as set_mot_dat keeps it)
 * with bit 17 blends out only; a setup word with `rig.blendIn.both` blends
 * both ways, one with `inOnly` in only; else the word before (+0xC30) with
 * bits 15 and 6 both, or with `before`, or the record's byte at `stance`
 * (+0x814) at 4, does not blend; that byte at 0x7F blends in only, as does a
 * +0x1A4 with any of 0x6600 (unless, in Fighting Vipers, it has bit 26:
 * both); the rest blend both ways. A motion of 2 frames or fewer does not
 * blend; one whose first of setup op 2's frames (+0x808) comes after the
 * blend out would start does not blend out; and the switch after a blend out
 * that ran to its end (+0xBE5 bit 1, `outDone`) does not blend in. Unless it
 * is now out only, the turn set-up (VF2 0x2756C, FV 0x2A308) cancels the
 * blend when the word before and the new +0x1A4 both have bit 10. A pass of a
 * motion the game loops runs the set-up again (VF2 0x1ABE8) on +0x1A4 as the
 * pass left it. The rest is the fight's (TECHNICAL.md, "Which switches blend
 * in").
 */
const BLEND_IN = 1, BLEND_OUT = 2, BLEND_BOTH = 3;
const OUT_ONLY = 1 << 17, TURNED = 1 << 10, NO_BLEND_PAIR = 0x8040, NO_BLEND = 4, IN_ONLY_STANCE = 0x7f;
const IN_ONLY_FLAGS = 0x6600, HELD_NO_BLEND = 1 << 2;

/* The tests after the setup word's: the word before and the stance byte. */
function stanceMode(rom, motion, before, flags) {
    const B = rom.game.rig.blendIn, stance = setupWord(rom, motion.id, B.stance) & 0xff;
    if (before & (B.before ?? 0) || (before & NO_BLEND_PAIR) === NO_BLEND_PAIR || stance === NO_BLEND) return 0;
    if (stance === IN_ONLY_STANCE) return BLEND_IN;
    if (flags & (B.flagsBoth ?? 0)) return BLEND_BOTH;
    return flags & IN_ONLY_FLAGS ? BLEND_IN : BLEND_BOTH;
}

function motionMode(rom, motion, before, flags) {
    const B = rom.game.rig.blendIn, word = setupWord(rom, motion.id);
    if (B.held !== undefined && setupWord(rom, motion.id, B.held) & HELD_NO_BLEND) return 0;
    if (flags & OUT_ONLY) return BLEND_OUT;
    if (word & (B.both ?? 0)) return BLEND_BOTH;
    if (word & B.inOnly) return BLEND_IN;
    return stanceMode(rom, motion, before, flags);
}

function blendMode(rom, motion, live, again) {
    if (!rom.game.rig.blendIn) return BLEND_IN;
    const before = live.before, length = blendLength(motion.frames);
    const flags = again ? moveFlags(rom, motion)?.[motion.frames] ?? setupWord(rom, motion.id) : setupWord(rom, motion.id);
    let mode = length ? motionMode(rom, motion, before, flags) : 0;
    const first = moveSetup(rom, motion.id)?.times?.[0];
    if (first !== undefined && first > motion.frames - length) mode &= ~BLEND_OUT;
    if (live.outDone && live.mode & BLEND_OUT) mode &= ~BLEND_IN;
    return mode !== BLEND_OUT && before & flags & TURNED ? 0 : mode;
}

/* The blend for this frame, added to the sample's points in place: a new
 * motion takes its steps from the last frame drawn; they run out on the
 * eighth frame or when the motion loops. */
function startBlend(live, rom, motion, mirrored, again) {
    live.mode = motion ? blendMode(rom, motion, live, again) : 0;
    live.outDone = false;
    live.out = null;
    live.length = motion ? blendLength(motion.frames) : 0;
    const first = live.last && live.mode & BLEND_IN ? sampleFor(rom, motion, 1, mirrored) : null;
    if (!first) return void (live.steps = live.points = null);
    const shift = blendShift(live.length), { angles, targets } = live.last;
    const turned = Boolean(setupWord(rom, motion.id) & MOVE_TURN || live.before & TURNED_BEFORE);
    const from = turned ? turnPoints(targets, angles, live.blend, first.angles) : targets;
    live.steps = blendSteps(angles, live.blend, first.angles, shift, turned);
    live.points = pointSteps(from, first.targets, shift);
}

/* The word +0xC30 holds when `motion` starts: the one before's, kept over a
 * pass of a motion the game loops. */
function wordBefore(live, rom, motion, again) {
    return again ? live.before : live.motion ? setupWord(rom, live.motion.id) : 0;
}

/*
 * The blend out (VF2 0x2776C, FV 0x2A53C), on the last N frames of a motion
 * that blends out, N its blend length: on the first of them the board takes
 * the motion's last frame (0x28848, mirrored as the fighter is) and the stance
 * pose the record's byte at +0x814 picks, one of five the fighter's action
 * table gives as it is loaded (VF2 0x270D4, FV 0x29EEC: `rig.blendOut`), each
 * the first frame of its motion; another byte leaves the motion not blending
 * out. The stance pose is mirrored when the fighter is or the setup word has
 * bit 21, but not both. With +0x1A4 bit 6 up (the motion ends turned), the
 * stance's points are turned about the body by +0x812 and its angle added to
 * the feet's and body's y (objects 2-4). The steps are the turn from the last
 * frame to the stance, E(last)^T E(stance) as Y, X and Z (op 0x2A805555), and
 * the points' (stance - last) with x and z from the body, both shifted as the
 * blend in's are; frame `from + k` adds k steps, so the last frame is drawn
 * at the stance. The game sets +0xBE5 bit 1 on the next to last.
 */
const STANCE_BYTES = [0, 0x80, 3, 0x83, 4], MOVE_FLIP = 1 << 21, STANCE_TURNS = [2, 3, 4];

/* +0x812 on `frame`: the setup's turn (0x8000 for a word with bit 6), the
 * other way for a mirrored fighter (0x1A3A4), unless script op 22 has since
 * set its own (0x1B3D8). */
function turnAt(rom, motion, frame, mirrored) {
    const m = moveSetup(rom, motion.id);
    let turn = m?.turn ?? (setupWord(rom, motion.id) & TURNED_BEFORE ? 0x8000 : 0);
    if (mirrored) turn = -turn;
    for (const o of m?.ops ?? []) if (o.op === OP_BIT_6 && o.frame <= frame) turn = o.value;
    return turn;
}

function turnStance({ angles, targets, targetUsed }, by) {
    const a = Uint16Array.from(angles), t = Float32Array.from(targets), m = turn(1, by);
    for (const obj of STANCE_TURNS) a[obj * 3 + 1] += by;
    for (let i = 0; i < t.length; i += 3) {
        const x = t[i] - targets[0], z = t[i + 2] - targets[2];
        t[i] = m[0][0] * x + m[0][2] * z;
        t[i + 2] = m[2][0] * x + m[2][2] * z;
    }
    return { angles: a, targets: t, targetUsed };
}

function stancePose(rom, body, motion, from, mirrored) {
    const slot = STANCE_BYTES.indexOf(setupWord(rom, motion.id, rom.game.rig.blendIn.stance) & 0xff);
    const id = slot < 0 ? undefined : body.actions?.[rom.game.rig.blendOut[slot]];
    const stance = id === undefined ? null : decodeMotion(rom, id);
    if (!stance) return null;
    const flip = mirrored !== Boolean(setupWord(rom, motion.id) & MOVE_FLIP);
    const pose = sampleFor(rom, stance, 1, flip);
    const flags = moveFlags(rom, motion)?.[from + 1] ?? 0;
    return flags & TURNED_BEFORE ? turnStance(pose, turnAt(rom, motion, from + 1, mirrored)) : pose;
}

function outSteps(rom, body, motion, from, mirrored) {
    const to = stancePose(rom, body, motion, from, mirrored);
    if (!to) return null;
    const last = sampleFor(rom, motion, motion.frames, mirrored);
    const shift = blendShift(motion.frames - from);
    const steps = Array.from({ length: 12 }, (_, obj) => {
        const back = mul3(transpose(eulerOf(tripleAt(last.angles, obj))), eulerOf(tripleAt(to.angles, obj)));
        return yxzOf(back).map((v) => v >> shift);
    });
    return { steps, points: pointSteps(to.targets, last.targets, shift) };
}

/* The blend out on `frame`, or null before it starts. */
function blendOutFor(live, rom, body, motion, frame, sample, mirrored) {
    const from = motion.frames - live.length, k = frame - from;
    if (!(live.mode & BLEND_OUT) || k <= 0) return null;
    live.out ??= outSteps(rom, body, motion, from, mirrored);
    if (!live.out) return void (live.mode &= ~BLEND_OUT);
    if (k === live.length - 1) live.outDone = true;
    live.out.points.forEach((v, i) => { sample.targets[i] += v * k; });
    return live.out.steps.map((t) => t.map((v) => v * k));
}

/* A motion that loops, back to its first frame from its last, blends into
 * itself as into a new one; one cut short and started again does not. */
function switchBlend(live, rom, motion, frame, mirrored) {
    if (motion !== live.motion || (frame === 1 && motion && live.frame === motion.frames)) {
        const again = Boolean(motion) && motion === live.motion && gameLoops(rom, motion.id);
        if (motion) live.before = wordBefore(live, rom, motion, again);
        startBlend(live, rom, motion, mirrored, again);
    } else if (frame < live.frame) {
        live.steps = live.points = null;
    }
}

function blendFor(live, rom, body, motion, frame, sample, mirrored) {
    switchBlend(live, rom, motion, frame, mirrored);
    const left = live.length - frame;
    const blending = live.steps && left > 0;
    // The next switch blends out of the targets as drawn, this blend included.
    if (blending) live.points.forEach((v, i) => { sample.targets[i] += v * left; });
    const out = !blending && motion ? blendOutFor(live, rom, body, motion, frame, sample, mirrored) : null;
    if (motion !== live.motion || frame !== live.frame) live.last = { angles: sample.angles, targets: sample.targets.slice() };
    return (live.blend = out ?? (blending ? live.steps.map((t) => t.map((v) => v * left)) : ZERO_BLEND));
}

/*
 * The chest bounce (TECHNICAL.md, "The chest bounce"): mune_unit_change
 * (0x31888) swaps a broken chest's model on the chest's own matrix, picked by
 * a spring, +0xC6C the position and +0xC68 the velocity, floats. It is driven
 * by the distance from the head (+0x20C, this frame's) to +0xC7C, the waist
 * (+0x1F4) as calc_unit_mat found it before storing this frame's; +0xC64 is
 * the distance it measured last frame. The per-frame list (0x6421F80 +0)
 * takes over on the frames chestFromList says, with the move flags the
 * motion's own setup and script give (moveFlags).
 *
 * The spring starts at 0/0 whenever the fighter is loaded or its armour
 * switched, the explorer's round start. That reset is the explorer's choice:
 * the ROM was not found to clear these at a round start. So is the first
 * distance being taken as the last one, which starts the spring without a
 * kick.
 */
const f32 = Math.fround;
const KICK = f32(160), KICK_CAP = f32(4.2), DAMP = f32(0.935);
const WALL = 15, BOUNCE_BACK = f32(0.78), PULL_UP = f32(0.14), PULL_DOWN = f32(-0.1);
const BOUNCE_REST = 15;

/* One frame of the spring, the five steps from loc_3191C, in floats. */
export function bounceStep(s, d) {
    const k = Math.min(f32(Math.abs(f32(s.last - d)) * KICK), KICK_CAP);
    s.last = d;
    let v = s.v;
    if (v === 0) v = k;
    else if (k >= Math.abs(v)) v = v < 0 ? -k : k;
    let p = f32(s.p + v);
    v = f32(v * DAMP);
    if (p >= WALL || p <= -WALL) {
        p = p >= WALL ? WALL : -WALL;
        v = f32(-v * BOUNCE_BACK);
    }
    const negative = p < 0 || Object.is(p, -0);
    s.v = f32(v + (negative ? PULL_UP : PULL_DOWN));
    s.p = p;
    return s;
}

/* The index into the 31: fix truncates toward zero (MODE1 TRUNC). */
export function bounceIndex(p) {
    return BOUNCE_REST + Math.trunc(f32(p + 0.5));
}

const WAIST_SLOT = 0, HEAD_SLOT = 2;

/*
 * The move flags (+0x1A4) on each frame of a motion, as far as the motion
 * itself sets them (TECHNICAL.md, "The per-frame list"). set_mot_dat (FV
 * 0x1B880, VF2 0x1A1E4) takes the setup script's first word (the profile's
 * `reactions.setups`), clears bit 21 and moves bit 15 to 16 when bit 8 is set
 * too; setup op 2 sets bit 1 and gives three frames (+0x808, +0x80A, +0x80C)
 * that FV 0x1C180 (VF2 0x1AC14) steps through; then the script after the
 * setup (FV 0x1C24C, VF2 0x1AD5C, ops by frame) sets, clears and flips bits,
 * and once it has run the frame's tail (FV 0x1C94C, VF2 0x1B43C) clears bit
 * 20 and moves the setup word's bit 7 into bit 5. The games differ where
 * `rig.flags` says. What the fight does to the word besides (a hit, the air,
 * fix_hara's bit 4) is fight state, left out, and so are VF2's frames that a
 * backup RAM setting moves for a few motions (0x1A448, 0x1A4BC, 0x1A4F4).
 */
const SETUP_END = 0, SETUP_LAST = 8, SETUP_TIMES = 2, SETUP_WINDOW = 3, SETUP_TABLE = 16;
const OP_FLIP_21 = 1, OP_SET = 5, OP_CLEAR = 6, OP_FLIP = 7, OP_BIT = 13, OP_BIT_6 = 22;
const WORD_TAIL = 1 << 7, FLAG_TAIL = 1 << 5;

/* The setup ops after the head: op 2's three frames, op 3's +0x850, the
 * turn ops 5, 6 and 7 leave at +0x812 (null where none does), and where the
 * script starts. */
const SETUP_TURN = { 5: 8, 6: 3, 7: 1 };

function readMoveSetup(rom, R, dv, at) {
    const len = (op) => rom.mainCpuView.getUint8(R.lengths + op);
    const out = { times: null, window: 0, turn: null };
    for (let op = dv.getUint8(at); ; op = dv.getUint8(at)) {
        if (op === SETUP_END) return { ...out, script: at };
        if (op === SETUP_LAST) return { ...out, script: at + 1 };
        if (op >= R.ops) return null;
        if (op === SETUP_TIMES) out.times = [1, 3, 5].map((k) => dv.getInt16(at + k, true));
        if (op === SETUP_WINDOW) out.window = dv.getUint16(at + 12, true);
        if (SETUP_TURN[op]) out.turn = dv.getInt16(at + SETUP_TURN[op], true);
        at += op === SETUP_TABLE ? 2 + 2 * dv.getUint8(at + 1) : len(op);
    }
}

function readScriptOps(lengths, dv, at) {
    const ops = [];
    for (let op = dv.getUint8(at); op !== 0 && op < lengths.length; op = dv.getUint8(at)) {
        ops.push({
            frame: dv.getUint16(at + 1, true), op, arg: dv.getUint8(at + 3), value: dv.getInt16(at + 3, true),
            third: lengths[op] > 5 ? dv.getInt8(at + 5) : 0,
        });
        at += lengths[op];
    }
    return ops;
}

/* One frame of 0x1C180's walk through op 2's frames. It enters at the step
 * +0xA00 names and falls through the later ones; past the third it starts
 * again from the first every frame. The second drops `rig.flags.drop`. */
function moveTimesStep(m, st, f, w) {
    const [t0, t1, t2] = m.times, raised = (m.word >> 8 & 1) && (m.word >> 15 & 1);
    let at = st.stage === 2 ? 2 : st.stage === 3 ? 3 : 1;
    if (at === 1) {
        if (raised && f >= t0) w &= ~0x10000;
        if (f < t0) return w;
        w &= ~2; st.stage++; at = 2;
    }
    if (at === 2) {
        if (f < t1) return w;
        if (w & 0x100) w &= ~0x8000;
        w = (w & ~m.drop) | 4; st.stage++;
    }
    if ((w & 0x1010) === 0x1010 && m.window && f >= m.window) w &= ~1;
    if (f < t2) return w;
    st.stage++;
    return w & ~0x1001;
}

function scriptOp(w, { op, arg }, bit) {
    if (op === OP_SET) return w | (1 << arg);
    if (op === OP_CLEAR) return w & ~(1 << arg);
    if (op === OP_FLIP) return w ^ (1 << arg);
    if (op === OP_FLIP_21) return w ^ (1 << 21);
    if (op === OP_BIT) return arg ? w & ~(1 << bit) : w | (1 << bit);
    if (op === OP_BIT_6) return w | (1 << 6);
    return w;
}

/* The setup and its script for motion `id`: the word, op 2's frames (with
 * the third set_mot_dat gives some motions outright), +0x850 and the ops. */
function moveSetup(rom, id) {
    const { reactions: R, script, flags } = rom.game.rig;
    const ptr = dataAt(rom, R.setups + id * 4);
    const r = ptr && dataAt(rom, ptr.view.getUint32(ptr.off, true));
    const setup = r && r.off + R.head < r.data.length ? readMoveSetup(rom, R, r.view, r.off + R.head) : null;
    if (!setup) return null;
    const end = flags.ends?.[id];
    const times = setup.times && end !== undefined ? [setup.times[0], setup.times[1], end] : setup.times;
    const ops = readScriptOps(script, r.view, setup.script);
    return { ...setup, times, ops, word: r.view.getUint32(r.off, true), drop: flags.drop };
}

function playMoveFlags(m, frames, bit) {
    const st = { stage: m.times ? 1 : 0 }, out = new Uint32Array(frames + 1);
    let w = m.word & ~(1 << 21), k = 0;
    if ((m.word >> 8 & 1) && (m.word >> 15 & 1)) w = (w & ~0x8000) | 0x10000;
    if (m.times) w |= 2;
    for (let f = 1; f <= frames; f++) {
        if (st.stage) w = moveTimesStep(m, st, f, w);
        for (; k < m.ops.length && m.ops[k].frame <= f; k++) w = scriptOp(w, m.ops[k], bit);
        if (m.word & WORD_TAIL) w |= FLAG_TAIL;
        out[f] = (w & ~(1 << 20) & ~WORD_TAIL) >>> 0;
        w = out[f];
    }
    return out;
}

/*
 * Fighting Vipers' script op 28 (0x1C8CC) on motion `id`, for its trails
 * (js/fvtrails.js): each one's frame, the kind it writes to +0xA25 (byte +3,
 * byte +4 shifted up a nibble) and the life to +0xA24 (byte +5); with the
 * setup word (+0x804). Null for a motion with none, or a game without it.
 */
export function trailScript(rom, id) {
    const op = rom.game.rig?.trails?.op;
    const m = op && id != null ? moveSetup(rom, id) : null;
    const ops = m?.ops.filter((o) => o.op === op)
        .map((o) => ({ frame: o.frame, kind: (o.arg | (o.value >> 8) << 4) & 0xff, life: o.third }));
    return ops?.length ? { word: m.word, ops } : null;
}

/** +0x1A4 on frames 1..frames of a motion (index = frame), or null. */
export function moveFlags(rom, motion) {
    const rig = rom.game.rig;
    if (!rig?.flags || !rig.reactions || motion?.id == null) return null;
    const cache = (rom.moveFlags ??= new Map());
    if (cache.has(motion.id)) return cache.get(motion.id);
    const m = moveSetup(rom, motion.id);
    const out = m && playMoveFlags(m, motion.frames, rig.flags.op13);
    cache.set(motion.id, out);
    return out;
}

/*
 * mune_unit_change's per-frame list (0x318B4): with move flag bit 9 set and
 * bits 14 and 16 clear, the list may take the chest from the spring. It does
 * when it is already on it (+0xC90), or when list[frame mod count] is the
 * model the spring last picked (+0xC94) and the spring is all but still
 * (|velocity| <= 0.8). On the list the spring is not stepped, and the chest is
 * the list's model while the flags are exactly 0x200, else the slot's own.
 * Returns that model, or null for the spring.
 */
const LIST_BIT = 1 << 9, LIST_OFF = (1 << 14) | (1 << 16), LIST_ONLY = 0x200, LIST_STILL = f32(0.8);

function chestFromList(body, s, flags, frame) {
    const list = body.bounceList;
    if (!list?.length || !(flags & LIST_BIT) || (flags & LIST_OFF)) return (s.onList = false, null);
    const entry = list[frame % list.length];
    if (!s.onList && !(entry === s.picked && Math.abs(s.v) <= LIST_STILL)) return null;
    s.onList = true;
    return flags === LIST_ONLY ? entry : body.chestSlot;
}

/*
 * The hips (TECHNICAL.md, "The hips"): koshi_unit_change (0x31ADC) swaps slot
 * 9's model on the hips' own matrix, as mune_unit_change does the chest's.
 * In its order, with the move flags (+0x1A4) all clear, as the explorer has
 * them: Honey's win-streak hips, where the streak switch asks for them
 * (STREAK_WINS); motion 0x31's list by frame (to 40); motion 0x180's by
 * frame, also only on the streak switch (it needs a streak of 10); the
 * motion's own list by frame (to its last), taken only when it differs from the slot's model; then the standing
 * pair, or the low one while the waist (+0x1F8) is under 0.4. A missing list
 * leaves the slot's model. The frame is +0x1AA, which set_motion starts at 1,
 * as the explorer does.
 */
const HIPS_LOW = 0.4;

function hipsModel(body, motion, frame, waistY) {
    const H = body.armour.hips, k = body.hipsBroken ? 1 : 0;
    const own = body.parts[HIPS].model;
    const id = motion?.id;
    if (k && body.streak && H.broken > 0) return H.broken;
    if (id === HIPS_M31) return H.m31 ? H.m31[Math.min(frame, HIPS_M31_LAST)] : own;
    if (id === HIPS_M180) return (body.streak && H.m180?.[frame]) || own;
    const list = H.byMotion.get(id);
    const listed = list ? list[Math.min(frame, list.length - 1)][k] : own;
    if (listed !== own) return listed;
    if (!H.base) return own;
    return (waistY < HIPS_LOW ? H.low : H.base)[k];
}

/*
 * The hit flash (TECHNICAL.md, "The flash"). Every routine that draws a
 * fighter's models (rob_disp's slots at 0x1A094, the hips, the midriff, the
 * pads, skirt, hair and sway chains) sends the model with its material
 * pointer swapped while the motion is in its first four frames (+0x1AA, which
 * set_motion starts at 1, at most 4): for `1 << 23` when move flag +0x1A4
 * bit 26 is set, else for 0x802000 on the odd ones when +0x720 bit 2 is.
 * set_mot_dat (0x1B880) copies both from the first two words of the motion's
 * setup script, 0x6411E94[motion], so they are the motion's own. Both
 * pointers are texture RAM blocks the boot fills (games.js, textureRamFill).
 */
const FLASH_FRAMES = 4, FLASH_BIT = 26, BLINK_BIT = 2;
const FLASH = 0x800000, BLINK = 0x802000;

/** The material pointer a fighter is drawn with on this frame of a motion,
 * or null for its own. */
export function flashMaterial(rom, motion, frame) {
    const F = rom.game.rig?.fighters?.flash;
    if (!F || motion?.id == null || frame < 0 || frame > FLASH_FRAMES) return null;
    const ptr = dataAt(rom, F.setups + motion.id * 4);
    const setup = ptr && dataAt(rom, ptr.view.getUint32(ptr.off, true));
    if (!setup || setup.off + 8 > setup.data.length) return null;
    const flags = setup.view.getUint32(setup.off, true), word720 = setup.view.getUint32(setup.off + 4, true);
    if ((flags >>> FLASH_BIT) & 1) return FLASH;
    if ((word720 >>> BLINK_BIT) & 1 && frame & 1) return BLINK;
    return null;
}

const distance = (a, b) => f32(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));

/* The chest's model this frame, stepping the spring once when playback has
 * moved on a frame. A frame picked on its own holds the spring and takes its
 * distances afresh, so a jump does not kick it. */
function bounceChest(body, live, pose, frame, stepped, flags) {
    const head = pose[HEAD_SLOT].t, waist = pose[WAIST_SLOT].t.slice();
    let s = live.spring;
    if (!s) s = live.spring = { p: 0, v: 0, last: distance(head, waist), waist, onList: false, picked: null };
    const before = s.waist;
    /* calc_unit_mat copies the waist (+0xC7C) on every frame, list or not. */
    s.waist = waist;
    s.flags = flags;
    const listed = chestFromList(body, s, flags, frame);
    if (listed != null) return (s.model = listed);
    /* A motion starting (or looping) stands the explorer's fighter back where
     * its motion starts, a jump the board's fighter does not make, so on that
     * frame the waist is this frame's. */
    if (stepped) bounceStep(s, distance(head, frame === 1 ? waist : before));
    else s.last = distance(head, waist);
    s.index = bounceIndex(s.p);
    return (s.model = s.picked = body.bounce[s.index]);
}

/* The hair's swing to draw this frame: the one the last step left, then a
 * step on this frame's head height when playback has moved on a frame. A
 * frame picked on its own holds the swing and takes the height afresh. */
function hairSwing(live, pose, stepped, fresh) {
    const y = pose[HEAD_SLOT].t[1];
    const h = (live.hair ??= { s: 0, w: 0, y: 0, v: 0 });
    const drawn = fresh ? (live.hairDrawn = h.s) : live.hairDrawn;
    if (stepped && fresh) hairStep(h, y);
    else if (fresh) Object.assign(h, { y, v: 0 });
    return drawn;
}

/* The chest's and hips' models this frame, for the fighters whose chest
 * bounces or whose hips koshi_unit_change names. */
function swappedModels(rom, body, live, pose, { motion, frame, stepped, fresh }) {
    const held = !fresh && live.spring?.model != null;
    const flags = () => moveFlags(rom, motion)?.[frame] ?? 0;
    const chest = body.bounce ? (held ? live.spring.model : bounceChest(body, live, pose, frame, stepped, flags())) : undefined;
    const hips = body.armour?.hips ? hipsModel(body, motion, frame, pose[WAIST_SLOT].t[1]) : undefined;
    return { chest, hips, spring: live.spring };
}

/*
 * A mirrored fighter (player +0 bit 6) plays every motion the other way round.
 * Once a frame is sampled and its twelve angle objects rounded, the pose code
 * (VF2 0x28AF4, FV 0x2B778, the same instructions) swaps the left and right
 * objects and reflects them, each word in the sixty-word frame by index:
 * angles 13 and 14 negated, 15, 17, 27 and 29 taken from 0x8000; the pairs
 * 0/3, 1/4, 7/10, 8/11, 21/24, 22/25, 30/33 and 31/34 swapped and negated,
 * 2/5, 6/9, 23/26 and 32/35 swapped; float objects 12, 13 and 14 have X
 * negated, 15/16 and 18/19 swap with X negated. Objects 6 and 17 stay.
 * set_motion (VF2 0x1A1E4, FV 0x1B5A8) flips the bit when the motion before
 * ends with move flag 21 set or the new one's id has bit 15; 0x184F0 (FV
 * 0x18F14) keeps +0 bit 10 as bit 6 xor flag 21 every frame, the way the
 * fighter will stand once its motion ends.
 */
const MIRROR_NEGATE = [13, 14], MIRROR_FROM_HALF = [15, 17, 27, 29];
const MIRROR_SWAP_NEGATE = [[0, 3], [1, 4], [7, 10], [8, 11], [21, 24], [22, 25], [30, 33], [31, 34]];
const MIRROR_SWAP = [[2, 5], [6, 9], [23, 26], [32, 35]];
const MIRROR_TARGET_X = [0, 1, 2], MIRROR_TARGET_PAIRS = [[3, 4], [6, 7]];
const HALF_TURN = 0x8000;

function mirrorSample({ angles, targets, targetUsed }) {
    const a = Uint16Array.from(angles), t = Float32Array.from(targets), used = Uint8Array.from(targetUsed);
    for (const i of MIRROR_NEGATE) a[i] = -a[i];
    for (const i of MIRROR_FROM_HALF) a[i] = HALF_TURN - a[i];
    for (const [i, j] of MIRROR_SWAP_NEGATE) [a[i], a[j]] = [-a[j], -a[i]];
    for (const [i, j] of MIRROR_SWAP) [a[i], a[j]] = [a[j], a[i]];
    for (const j of MIRROR_TARGET_X) t[j * 3] = -t[j * 3];
    for (const [i, j] of MIRROR_TARGET_PAIRS) {
        for (let k = 0; k < 3; k++) [t[i * 3 + k], t[j * 3 + k]] = [t[j * 3 + k], t[i * 3 + k]];
        [t[i * 3], t[j * 3]] = [-t[i * 3], -t[j * 3]];
        [used[i], used[j]] = [used[j], used[i]];
    }
    return { angles: a, targets: t, targetUsed: used };
}

function sampleFor(rom, motion, frame, mirrored) {
    if (!motion) return REST;
    const sample = sampleMotion(rom, motion, frame);
    return mirrored ? mirrorSample(sample) : sample;
}

/**
 * Pose a fighter on one frame of a motion, in the viewer's frame. The body
 * position is the motion's, step and all: the hand and foot targets are in the
 * same space, so taking the step out of one would leave the limbs reaching for
 * where the other went.
 *
 * Played frame after frame, the fighter blends into each new motion and its
 * head turns toward the face target a step at a time, as on the board. On its
 * own the head follows the motion's own target; poseBout gives it an opponent
 * to look at. The chest does not twist.
 *
 * @param {{faceTarget?: number[], mirrored?: boolean, handsFrom?: object}} [opts]
 *   `faceTarget` takes the place of the motion's (float object 2, in the
 *   targets' space), as the fight writes the other fighter's head over it at
 *   player +0xB0C; `mirrored` plays the motion the other way round
 *   (mirrorSample); `handsFrom`, {motion, frame, mirrored}, is what the
 *   fighter played before, whose hands this motion starts with (else the
 *   game's cold hands; js/fighterhands.js).
 * @returns {{matrices: number[][], origins: number[][], extras: number[][]}}
 *   `extras` places body.extras (the pads and skirt, VF2's item), one each,
 *   and `shown` says whether each is drawn this frame; `skirt`, for
 *   a fighter with one, is each panel's swing this frame, and `pads` each
 *   shoulder pad's (left, right); `hair`, Picky's hair's swing; `chest`,
 *   for a broken chest that bounces, is the model the spring picks; `hips`,
 *   for a fighter koshi_unit_change names, is the hips' model this frame;
 *   `hands`, [slot, model] for the hands, as the motion's script shapes
 *   them (js/fighterhands.js), which go to the other side when mirrored;
 *   `pose`, the bones in the board's frame, which the sway chains hang off
 *   (js/osage.js).
 */
export function poseFighter(rom, body, motion, frame, { faceTarget: other, mirrored = false, handsFrom = null, handsPass = 0 } = {}) {
    rom.vf2Rig ??= standardRig(rom);
    const faceTarget = looksAtOther(rom, motion, frame, other);
    const live = liveFor(body);
    const sample = sampleFor(rom, motion, frame, mirrored);
    /* Playback moves on a frame, or starts the next motion or loop at 1. */
    const stepped = live.motion !== null && (frame === live.frame + 1 || frame === 1);
    const fresh = motion !== live.motion || frame !== live.frame;
    const fight = {
        held: motion ? heldAngles(rom, motion) : {},
        blend: blendFor(live, rom, body, motion, frame, sample, mirrored),
        look: (local) => (fresh ? (live.look = headStep(live.look, local, !stepped, lookLimits(rom, faceTarget))) : live.look),
    };
    live.motion = motion; live.frame = frame;
    if (faceTarget) faceTarget.forEach((v, i) => { sample.targets[6 + i] = v; });
    const pose = onOwnSkeleton(buildPose(rom.vf2Rig, sample, { levelFeet: true, fight }), body.offsets);
    const crouch = (rom.game.rig.crouch ?? CROUCH)[body.char ?? body.index];
    if (crouch) for (const s of pose) s.t[1] += sample.targets[1] * (crouch - 1);
    const matrices = poseMatrices(pose);
    const origins = matrices.map((m) => [m[12], m[13], m[14]]);
    live.head = origins[2];
    const swings = body.extras?.some((e) => e.panel !== undefined) ? skirtSwings(pose, body.offsets) : null;
    const hair = body.extras?.some((e) => e.hair !== undefined) ? hairSwing(live, pose, stepped, fresh) : null;
    const I = rom.game.rig.fighters?.item;
    const swung = (body.extras ?? []).map((e) => (e.item && mirrored ? mirroredItem(e, I) : swungExtra(e, swings, pose, body.offsets, hair)));
    const extras = swung.map((e) => viewerMatrix(placeExtra(pose[e.slot], e)));
    const pads = swung.some((e) => e.pad !== undefined) ? PAD_SIDES.map((_, k) => swung.find((e) => e.pad === k)?.swing ?? 0) : null;
    const scripted = handModels(rom, body, motion, mirrored, handsFrom, handsPass);
    const hands = handsAt(scripted, frame);
    const item = itemAt(scripted, frame);
    const shown = swung.map((e) => !e.item || item);
    return { matrices, origins, extras, shown, pose, skirt: swings, pads, hair, hands, ...swappedModels(rom, body, live, pose, { motion, frame, stepped, fresh }) };
}

/*
 * The opponent. A round starts the fighters at x = -1 and +1 (the stores of
 * -1.0 and 1.0 to player +0x18), facing each other, so the explorer stands one
 * 2 ahead of the fighter, turned half round. Ahead is the motions' +z, which
 * is the viewer's +x (js/pose.js turns the one into the other), so in the
 * fighter's viewer frame the opponent's (x, y, z) is (2 - x, y, -z), and
 * the other way round the same.
 *
 * Ahead is where the fight mostly has it, not where a motion says it is. The
 * move script turns a fighter round (0x1B454: with move flag +0x1A4 bit 20
 * set, it flips bit 15 of the facing at +0x26), and a back-turned fighter
 * plays its motions with the other one behind: measured over MAME's attract
 * mode, the opponent stands at the motions' -z through sixteen of the
 * motions played, and the motions' own face target does not tell those from
 * the rest. So the explorer can stand it behind as well, 2 back along -z and
 * facing the fighter's back: (x - 2, y, z).
 */
export const OPPONENT_DISTANCE = 2;

/*
 * In a throw the pair share one place and facing: the thrower's action 0x10
 * (FV 0x1570C, VF2 0x15F48) steps it halfway to the other's place every frame
 * while move flag 1 is up, then, as the throw's +0x808 frame comes and the
 * flag drops, copies the other's place (+0x18..+0x20) and facing (+0x26)
 * outright. Both motions are authored in that frame: the thrown one's root
 * starts where the throw holds it (FV 31 and 32, VF2 15 and 16).
 */
const SHARED_PLACE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Where the opponent's parts go: its viewer frame into the fighter's. */
export function opponentMatrix({ behind = false, distance = OPPONENT_DISTANCE, thrown = false } = {}) {
    if (thrown) return SHARED_PLACE;
    return behind
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -distance, 0, 0, 1]
        : [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, distance, 0, 0, 1];
}

/* A point through a placement (column-major 4x4), or back through it: the
 * placement is a turn and a step, so its inverse is the turn transposed. */
function placed(P, [x, y, z]) {
    return [0, 1, 2].map((k) => P[k] * x + P[k + 4] * y + P[k + 8] * z + P[k + 12]);
}
function unplaced(P, v) {
    const d = [0, 1, 2].map((k) => v[k] - P[k + 12]);
    return [0, 1, 2].map((k) => P[k * 4] * d[0] + P[k * 4 + 1] * d[1] + P[k * 4 + 2] * d[2]);
}

/* The other fighter's head, as last posed, in the motions' space of the one
 * looking at it: across to the looker's viewer frame, then as (z, y, x). */
function headSeenFrom(other, across) {
    const h = LIVE.get(other)?.head;
    if (!h) return undefined;
    const [x, y, z] = across(h);
    return [z, y, x];
}

/**
 * Pose a fighter and an opponent facing it, each head turning toward the
 * other's as the fight turns it: the first, player 1, looks at where the
 * opponent's head was last drawn, and the opponent then at the first's of
 * this frame. Each is {body, motion, frame}; the opponent's body has to be an
 * object of its own, as it carries its own playback.
 *
 * Checked against MAME's attract mode at the places and facings the board had:
 * the target matches the board's +0xB0C to 0.00001 wherever the fight looks at
 * the other fighter. It does not look while the motion's move flags have any
 * of the profile's `look.gate` up (looksAtOther); then the head follows the
 * motion's own target. The rest of the gate is the round (0x500034) and the
 * fighter's status (+0 & 0xA00000), fight state the explorer does not have:
 * it takes the round as under way and the fighter as on its feet.
 *
 * @param {number[]} [place]  where the second stands, opponentMatrix()'s
 * @returns {Array<{matrices: number[][], origins: number[][]}>} each in its
 *   own viewer frame; `place` puts the second in the first's.
 */
export function poseBout(rom, [first, second], place = opponentMatrix()) {
    const one = poseFighter(rom, first.body, first.motion, first.frame,
        { faceTarget: headSeenFrom(second.body, (h) => placed(place, h)), mirrored: first.mirrored, handsPass: first.handsPass });
    const two = poseFighter(rom, second.body, second.motion, second.frame,
        { faceTarget: headSeenFrom(first.body, (h) => unplaced(place, h)), mirrored: second.mirrored, handsFrom: second.handsFrom, handsPass: second.handsPass });
    return [one, two];
}
