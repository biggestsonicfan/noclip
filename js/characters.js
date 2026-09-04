/*
 * characters.js — the fighter roster, their part meshes and their skeletons.
 *
 * action_init() indexes `CHAR_PARTS`, a table of pointers to one 48-byte record
 * per fighter. The three fields the viewer needs are:
 *
 *   +0x00  model-part table   32 model ids: 16 normal, then 16 hammer-squished
 *   +0x04  skeleton table     16 (x, y, z) float offsets — but see below
 *   +0x0C  animation table    52 motion ids, one per action slot
 *
 * A fighter is sixteen parts on sixteen slots and the two tables share that
 * numbering: part `i` is drawn on slot `i`, and slot `i`'s entry in the
 * skeleton table is the offset that slot contributes — a pivot for the four
 * limbs, a bone length for the links inside them, the chest-to-head step for
 * the spine. Slots 0 and 9, the waist and the pelvis, carry no mesh of their
 * own. `js/pose.js` has the slot layout and what solves each one.
 *
 * Which skeleton, though, is a per-fighter *state* rather than a field of the
 * record — see SKELETON_TYPE_DATA below.
 */

import { SLOT_NAMES, SLOT_PARENT, SLOT_COUNT, readSkeleton } from './pose.js';
import { readTexturePoints } from './display.js';
import { motionSkeletonType } from './motion.js';

const CHAR_PARTS_ADDR = 0x000c5268;

/*
 * A fighter's skeleton is not the one its own record points at. `SKELETON_TYPE_DATA`
 * is a table of four per-character skeleton tables, and `calc_rob_angle_int` at
 * `0x2EF38` picks one with the fighter's current skeleton type — `p1_skeleton_type`,
 * which is `P1_PARTS+0x84C` — before it reads a single offset:
 *
 *     skel  = SKELETON_TYPE_DATA[type][char]
 *     parts = type <= 1 ? record[0]      : type == 2 ? record[0] + 64
 *                                        : record[0x08]
 *
 * Type 2 is the hammer-squished form, and it is a whole second skeleton rather
 * than a scale on the first: every bone length is halved while the lateral
 * offsets stay put, which is what flattens a fighter without narrowing it. The
 * squished meshes are the second sixteen in the part table, so the two switch
 * together.
 *
 * The record's own `+0x04` is *not* a substitute for the type-0 entry. It agrees
 * for most of the cast but not for Knuckles, whose record points at Sonic's
 * skeleton while his type-0 entry has his own — narrower hips, and every offset
 * rounded differently.
 */
const SKELETON_TYPE_DATA_ADDR = 0x000c2068;
export const SKELETON_NORMAL = 0;
export const SKELETON_SQUISHED = 2;


function skeletonPtr(rom, charIndex, type) {
    const dv = rom.mainCpuView;
    const table = dv.getUint32(SKELETON_TYPE_DATA_ADDR + type * 4, true);
    if (!table || table + charIndex * 4 + 4 > rom.maincpu.length) return 0;
    const ptr = dv.getUint32(table + charIndex * 4, true);
    return ptr && ptr + SLOT_COUNT * 12 <= rom.maincpu.length ? ptr : 0;
}

/* Each fighter's default face record. The eyes are not part of the skeleton:
 * they are two ordinary models drawn on the head's matrix, in the head's own
 * space, which is why they follow it without a slot of their own. The record
 * packs its model ids as `u16` pairs — `+0x04` the head, `+0x08` the eyes — and
 * a fighter with no separate eye objects, which is Eggman and the robots, has
 * zero there. */
const FACE_TABLE_ADDR = 0x000c533c;
const MODEL_COUNT = 5103;

/*
 * The record does not stop at the model ids: `+0x10` and `+0x14` are texture-
 * point blocks, one per eye, in the shape `move_tpd_req`'s blocks are — a count,
 * a word length, then (v, u) pairs — and each is exactly as long as the stream
 * the eye model itself walks. The eyes are drawn from those points rather than
 * from the ones in the model.
 *
 * Which of the two is used mostly does not matter, because mostly they are the
 * same data: of the 668 (record, eye) pairs the roster's variant tables reach,
 * 602 are byte-identical to the model's own points. Sixty-six are not, and one
 * of those is visible. Amy's move by 1.9 texels on average and Bark's by less
 * than one, but Espio's second eye, model 1183, keeps every u and shifts v by 30
 * texels on average and 124 at the worst — a different part of the eye sheet,
 * not a nudge.
 *
 * A block belongs to an eye model rather than to an expression: a record that
 * names the same eye names the same block, and a fighter changes expression by
 * swapping the model. What has not been read is the routine that hands a block
 * to `set_obj_tpd`, so this is the record's own arrangement rather than a call
 * traced through the code: the block sits in the eye's record, is the eye's
 * length, and agrees with the eye everywhere it has nothing to correct.
 */
const EYE_POINTS_OFFSET = 0x10;

function readFace(rom, charIndex) {
    const dv = rom.mainCpuView;
    const rec = dv.getUint32(FACE_TABLE_ADDR + charIndex * 4, true);
    if (!rec || rec + 0x0c > rom.maincpu.length) return { eyes: [], heads: [], eyePoints: [] };
    /* Super Sonic's entries carry 0x8000 rather than a model index, so anything
     * outside the model table is "no object" rather than a lookup. */
    const ok = (id) => (id > 0 && id < MODEL_COUNT ? id : 0);
    const pair = (off) => {
        const w = dv.getUint32(rec + off, true);
        return [ok(w & 0xffff), ok((w >>> 16) & 0xffff)];
    };

    /* Kept index for index with `eyes`, so a fighter whose record names one eye
     * object does not take the other one's points. */
    const eyes = [], eyePoints = [];
    pair(0x08).forEach((id, i) => {
        if (!id) return;
        const ptr = rec + EYE_POINTS_OFFSET + i * 4 + 4 <= rom.maincpu.length
            ? dv.getUint32(rec + EYE_POINTS_OFFSET + i * 4, true) : 0;
        eyes.push(id);
        eyePoints.push(ptr && ptr + 4 <= rom.maincpu.length ? readTexturePoints(rom, ptr) : null);
    });

    return { record: rec, heads: pair(0x04).filter(Boolean), eyes, eyePoints };
}

/*
 * The faces the roster's own table does not reach.
 *
 * `FACE_TABLE_ADDR` is one of twenty-one: `FACE_VARIANT_TABLES` is an array of
 * pointers to face tables, each the same 52 entries indexed by character, and
 * the base table is a copy of entry 0. The routine at `0x1B2FC` walks it —
 *
 *     ld    0xc540c[r3*4], r5     ; r3 picks the variant
 *     ldob  0x1b0(g7), r4         ; the character number
 *     ld    (r5)[r4*4], r5        ; that character's record
 *     ldos  0x0(r5), r3           ; the record's two counts, then
 *     ldos  0x2(r5), r4           ; the ids from +0x04 on
 *
 * — so the other twenty tables name heads and eyes that appear in no part
 * table at all: model 3580 is Honey's head with her mouth open, reached only
 * through variant 12. Nothing here is drawn yet; what it settles is which
 * sheets a model belongs to, since a head the fighters wear is in texture set
 * 1 like the rest of the rig and should be shaded through the ramp rather than
 * flat. Every id the twenty-one tables give decodes, and every one of their
 * tiles is in set 1 and in no other set.
 */
const FACE_VARIANT_TABLES = 0x000c540c;
const FACE_VARIANT_COUNT = 21;
const FACE_TABLE_ENTRIES = 52;

/**
 * Every head and eye model the variant tables name, against the character whose
 * column names it — the lowest, where several do, so a face the roster itself
 * carries is attributed to the fighter wearing it rather than to a padding
 * entry further down the table. The character is what picks a fighter's rows of
 * the colour table (`send_tex_col_part`), so a lone head needs one to be shaded
 * the way the fighter wearing it is.
 *
 * @param {object} rom
 * @returns {Map<number, number>} model -> character number
 */
export function faceVariantOwners(rom) {
    const dv = rom.mainCpuView;
    const out = new Map();
    for (let c = 0; c < FACE_TABLE_ENTRIES; c++) {
        for (let v = 0; v < FACE_VARIANT_COUNT; v++) {
            const table = dv.getUint32(FACE_VARIANT_TABLES + v * 4, true);
            if (!table || table + FACE_TABLE_ENTRIES * 4 > rom.maincpu.length) continue;
            const rec = dv.getUint32(table + c * 4, true);
            if (!rec || rec + 0x0c > rom.maincpu.length) continue;
            /* Same two pairs readFace takes, and the same guard: Super Sonic's
             * head field carries 0x8000 rather than a model index. */
            for (const off of [0x04, 0x08]) {
                const w = dv.getUint32(rec + off, true);
                const a = w & 0xffff, b = (w >>> 16) & 0xffff;
                if (a > 0 && a < MODEL_COUNT && !out.has(a)) out.set(a, c);
                if (b > 0 && b < MODEL_COUNT && !out.has(b)) out.set(b, c);
            }
        }
    }
    return out;
}

/**
 * Every head and eye model the variant tables name, for the whole roster.
 * @param {object} rom
 * @returns {Set<number>}
 */
export function faceVariantModels(rom) {
    return new Set(faceVariantOwners(rom).keys());
}

/* Roster order from the CHAR_PARTS listing. Entries 17-25 repeat SONIC as
 * padding; the "_I" entries from 26 are the roster's mirror half, the same
 * seventeen again -- the half `send_tex_col_part` reaches by taking 26 off the
 * character before it indexes its second table. */
export const CHARACTERS = [
    { index: 0, name: 'Sonic' },
    { index: 1, name: 'Tails' },
    { index: 2, name: 'Amy' },
    { index: 3, name: 'Metal Sonic' },
    { index: 4, name: 'Fang' },
    { index: 5, name: 'Bark' },
    { index: 6, name: 'Knuckles' },
    { index: 7, name: 'Espio' },
    { index: 8, name: 'Eggman' },
    { index: 9, name: 'Eggman B' },
    { index: 10, name: 'Bean' },
    { index: 11, name: 'Eggman (boss)' },
    { index: 12, name: 'Egg UFO' },
    { index: 13, name: 'Egg Minion' },
    { index: 14, name: 'Rocket Metal' },
    { index: 15, name: 'Honey' },
    { index: 16, name: 'Super Sonic' },
    { index: 26, name: 'Sonic (mirror)' },
    { index: 27, name: 'Tails (mirror)' },
    { index: 28, name: 'Amy (mirror)' },
    { index: 29, name: 'Metal Sonic (mirror)' },
    { index: 30, name: 'Fang (mirror)' },
    { index: 31, name: 'Bark (mirror)' },
    { index: 32, name: 'Knuckles (mirror)' },
    { index: 33, name: 'Espio (mirror)' },
    { index: 34, name: 'Eggman (mirror)' },
    { index: 35, name: 'Eggman B (mirror)' },
    { index: 36, name: 'Bean (mirror)' },
    { index: 37, name: 'Eggman boss (mirror)' },
    { index: 38, name: 'Egg UFO (mirror)' },
    { index: 39, name: 'Egg Minion (mirror)' },
    { index: 40, name: 'Rocket Metal (mirror)' },
    { index: 41, name: 'Honey (mirror)' },
    { index: 42, name: 'Super Sonic (mirror)' },
];

/*
 * A character's own skeleton type.
 *
 * `calc_rob_angle_int` resolves the rig as `SKELETON_TYPE_DATA[type][char]` --
 * the type from `P1+0x84C`, the character from `P1+0x1B0`. The type reaches
 * that byte from the motion (`set_mot_dat` copies byte `0x0C` of the `mot_list`
 * record into it), but it is a property of the fighter rather than of the move:
 * the two bytes IDA names are `sonic_skeleton_type` and `bark_skeleton_type`,
 * and they sit on the records of motion 278 and motion 128 -- Sonic's own
 * stance and Bark's. So the type is read once, off the fighter's own stance,
 * and belongs to the character from then on.
 *
 * It barely matters which of 0 and 1 comes back: those two tables in
 * `SKELETON_TYPE_DATA` are byte-identical across all 52 entries. What matters
 * is that the lookup goes through this array at all, since it is the one that
 * gives every character its own rig -- `model_floats_8` for the Final Eggman
 * Boss, which is its own and nothing else's.
 */
const STANCE_SLOT = 0;

/**
 * The skeleton type a fighter carries, read off its own stance motion.
 * @param {object} rom
 * @param {number} animPtr the record's `+0x0C`
 * @returns {number} 0-3
 */
function characterSkeletonType(rom, animPtr) {
    const dv = rom.mainCpuView;
    if (!animPtr || animPtr + 2 > rom.maincpu.length) return SKELETON_NORMAL;
    const stance = dv.getUint16(animPtr + STANCE_SLOT * 2, true);
    const type = motionSkeletonType(rom, stance);
    /* Type 2 is the squished form, which a stance never asks for; anything that
     * lands there would pick the flattened rig for a fighter standing up. */
    return type === SKELETON_SQUISHED ? SKELETON_NORMAL : type;
}

/*
 * Whether a fighter's animation table is its own.
 *
 * There are thirteen tables, 106 bytes each from `0xD9908`, for seventeen
 * fighters: 0-10 take their own, Super Sonic and Honey the last two, and the
 * Final Eggman Boss, the Egg UFO, the Egg Minion and Rocket Metal are all left
 * pointing at Bean's. Nothing else in the roster shares one, and the mirror
 * half repeats the base roster from index 26, so this reads off the ROM rather
 * than naming the four indices.
 *
 * What it settles is the head. Every motion carries head data, but a borrowed
 * table's was authored for whoever owns it, so `js/pose.js` leaves these four
 * pointing the way their chest does instead of aiming them at a face target
 * that was never theirs.
 */
const MIRROR_BASE = 26;
function borrowsAnimTable(rom, charIndex) {
    const dv = rom.mainCpuView;
    const base = charIndex >= MIRROR_BASE ? charIndex - MIRROR_BASE : charIndex;
    const animOf = (i) => {
        const rec = dv.getUint32(CHAR_PARTS_ADDR + i * 4, true);
        return rec && rec + 0x10 <= rom.maincpu.length ? dv.getUint32(rec + 0x0c, true) : 0;
    };
    const mine = animOf(base);
    if (!mine) return false;
    for (let i = 0; i < base; i++) if (animOf(i) === mine) return true;
    return false;
}

/**
 * Read one fighter's parts, skeleton and motion list out of the program ROM.
 * @param {object} rom
 * @param {number} charIndex index into CHAR_PARTS
 */
export function readCharacter(rom, charIndex) {
    const dv = rom.mainCpuView;
    const record = dv.getUint32(CHAR_PARTS_ADDR + charIndex * 4, true);
    if (!record || record + 0x30 > rom.maincpu.length) return null;

    const partsPtr = dv.getUint32(record + 0x00, true);
    const bonesPtr = dv.getUint32(record + 0x04, true);
    const animPtr = dv.getUint32(record + 0x0c, true);
    const height = dv.getFloat32(record + 0x14, true);

    const partsNormal = [];
    const partsSquished = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
        partsNormal.push(dv.getUint32(partsPtr + i * 4, true));
        partsSquished.push(dv.getUint32(partsPtr + (i + SLOT_COUNT) * 4, true));
    }

    /* The type-0 entry is the fighter's own skeleton; the record's `+0x04` only
     * usually agrees with it. Falling back to the record keeps a character the
     * table has no entry for from losing its rig entirely. */
    const skeletonType = characterSkeletonType(rom, animPtr);
    const normalPtr = skeletonPtr(rom, charIndex, skeletonType) || bonesPtr;
    const squishedPtr = skeletonPtr(rom, charIndex, SKELETON_SQUISHED) || normalPtr;
    const skeleton = readSkeleton(rom, normalPtr);
    const skeletonSquished = readSkeleton(rom, squishedPtr);

    const slots = SLOT_NAMES.map((name, i) => ({
        name,
        parent: SLOT_PARENT[i],
        offset: skeleton.offsets[i],
        offsetSquished: skeletonSquished.offsets[i],
        model: partsNormal[i] || 0,
        modelSquished: partsSquished[i] || 0,
    }));

    const face = readFace(rom, charIndex);
    const ownAnimTable = !borrowsAnimTable(rom, charIndex);

    const motions = [];
    for (let i = 0; i < ACTION_SLOT_COUNT; i++) motions.push(dv.getUint16(animPtr + i * 2, true));

    return {
        charIndex,
        name: CHARACTERS.find((c) => c.index === charIndex)?.name ?? `char ${charIndex}`,
        record, partsPtr, bonesPtr, animPtr, normalPtr, squishedPtr, skeletonType,
        height, skeleton, skeletonSquished, slots, face, ownAnimTable,
        partsNormal, partsSquished, motions,
    };
}

/* Action-slot names for the 52-entry per-character animation table. The order
 * is stable across every fighter (each character's table maps the same slot to
 * its own motion id) but the slots are not labelled in the ROM, so only the
 * count is authoritative here. */
export const ACTION_SLOT_COUNT = 52;
