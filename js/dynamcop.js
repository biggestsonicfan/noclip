/*
 * dynamcop.js — Dynamite Cop's scenes: what texture RAM and the face palette
 * hold while a stage and two enemy sets are loaded.
 *
 * The game numbers 25 sets. Set 0 is boot, sets 1-13 are stages and 14-24 are
 * enemy sets (enemy n is set 14 + n). Three RAM slots name the loaded ones:
 * 0x543024 the stage, 0x543028 and 0x54302C the two enemy sets. The two enemy
 * sets always have opposite flags in `enemyFlags`, and the flag decides which
 * half of texture RAM and of the palette each one takes. So a scene is a stage
 * and an enemy pair, and a set number the explorer asks for is turned into one
 * here (`dynamcopScene`).
 *
 * Addresses below are the 2A export build's (dynamcop); games.js gives each
 * build its own.
 */

import { MAIN_DATA_BASE, xtraResolve } from './romset.js';
import { SHEET_BYTES } from './atlas.js';
import { bankTextureSet } from './texture.js';
import { gameLighting } from './stages.js';
import { musicChoices } from './sound/sound.js';

const SHEET0 = 0;
const SHEET1 = SHEET_BYTES;
/* The full-size half of a sheet is rows 0-511; the mip half starts at row 512,
 * 0x40000 halfwords in. */
const MIP = 0x80000;

/** The stage and enemy pair loaded with `set`. */
export function dynamcopScene(rom, set) {
    const D = rom.game.dynamcop;
    const flag = (n) => rom.mainCpuView.getUint32(D.enemyFlags + n * 4, true);
    /* An enemy set's partner: the first enemy set with the other flag. */
    const partner = (n) => {
        for (let k = 0; k < D.enemies; k++) if (flag(k) !== flag(n)) return k;
        return n;
    };
    const s = Number.isInteger(set) ? set : 0;
    if (s >= D.stages && s < D.stages + D.enemies) {
        const n = s - D.stages;
        return { stage: D.defaultStage, enemies: [n, partner(n)], flag };
    }
    const n = D.defaultEnemy;
    return { stage: s > 0 && s < D.stages ? s : 0, enemies: [n, partner(n)], flag };
}

/* A data address as an offset into main_data. XTRA_DATA (0x06000000) is
 * main_data from 0x1000000 on; set 5's stage bank is 0x06755500. */
function dataOffset(a) {
    if (a >= 0x06000000) return a - 0x06000000 + 0x1000000;
    return a - MAIN_DATA_BASE;
}

/* Copy halfwords packed end to end into the rectangle (x0,y0)-(x1,y1) of a
 * sheet image, row 0x200 halfwords. 0x6FF60 does this, one halfword per
 * texture RAM word. Returns the source position after it. */
function packedRect(md, src, tex, base, x0, y0, x1, y1) {
    const n = (x1 - x0 + 1) * 2;
    for (let y = y0; y <= y1; y++) {
        if (src + n > md.length) return md.length;
        tex.set(md.subarray(src, src + n), base + ((y << 9) + x0) * 2);
        src += n;
    }
    return src;
}

/* 0x6F9A0: zero a rectangle of the mip half. Both bank loaders clear
 * (0x1F0,0x1F8)-(0x1FF,0x1FF) of the far sheet's mip half when they are done. */
function clearMipCorner(tex, base) {
    for (let y = 0x1f8; y <= 0x1ff; y++) tex.fill(0, base + MIP + ((y << 9) + 0x1f0) * 2, base + MIP + ((y << 9) + 0x200) * 2);
}

/*
 * The boot bank (0x978C0): byte pair encoding, Gage's, in blocks. A block is a
 * pair table and then a 16-bit big-endian count of packed bytes. The table is
 * read as runs: a count byte c over 127 skips c - 127 codes and reads none, and
 * otherwise c + 1 codes follow, each a left byte and, when the left byte is not
 * the code itself, a right byte. It ends when the code reaches 256. Packed bytes
 * expand through a stack. The output pairs into halfwords, first byte low, and
 * goes into the rectangles of the table at `rects` (24 bytes each: sheet, word
 * offset, x0, y0, x1, y1; -1 ends it). Sheet 0 of that table is texture RAM 0.
 */
function bootBank(rom, md, src, tex) {
    const cv = rom.mainCpuView;
    const R = rom.game.texture.raw.bootRects;
    const rects = [];
    for (let o = R; cv.getInt32(o, true) !== -1 && rects.length < 64; o += 24) {
        rects.push([0, 1, 2, 3, 4, 5].map((k) => cv.getInt32(o + k * 4, true)));
    }
    if (!rects.length) return;
    let ri = 0;
    let [sel, off, x0, y0, x1, y1] = rects[0];
    let x = x0, y = y0, lo = -1;
    const left = new Uint8Array(256), right = new Uint8Array(256);
    const stack = [];
    let p = src;
    while (ri < rects.length && p < md.length) {
        for (let i = 0; i < 256; i++) left[i] = i;
        let code = 0;
        let c = md[p++];
        for (;;) {
            if (c > 127) { code += c - 127; c = 0; }
            if (code === 256) break;
            for (let k = 0; k <= c && code < 256; k++, code++) {
                left[code] = md[p++];
                if (left[code] !== code) right[code] = md[p++];
            }
            if (code === 256) break;
            c = md[p++];
        }
        let size = (md[p] << 8) | md[p + 1];
        p += 2;
        while (ri < rects.length) {
            let ch;
            if (stack.length) ch = stack.pop();
            else if (size-- > 0) ch = md[p++];
            else break;
            if (left[ch] !== ch) { stack.push(right[ch], left[ch]); continue; }
            if (lo < 0) { lo = ch; continue; }
            const at = (sel ? SHEET1 : SHEET0) + (off + (y << 9) + x) * 2;
            tex[at] = lo;
            tex[at + 1] = ch;
            lo = -1;
            if (++x > x1) {
                x = x0;
                if (++y > y1 && ++ri < rects.length) {
                    [sel, off, x0, y0, x1, y1] = rects[ri];
                    x = x0; y = y0;
                }
            }
        }
    }
    clearMipCorner(tex, SHEET1);
}

/* A stage's bank (0x6F9E0, called with g1 = 1): 0xAAA00 bytes, the full-size
 * half onto sheet 1 and its mips dealt between the two. */
function stageBank(md, src, tex) {
    const near = SHEET1, far = SHEET0;
    let p = packedRect(md, src, tex, near, 0, 0, 0x1ff, 0x1ff);
    p = packedRect(md, p, tex, far + MIP, 0x000, 0x100, 0x0ff, 0x1ff);
    p = packedRect(md, p, tex, near + MIP, 0x100, 0x180, 0x17f, 0x1ff);
    p = packedRect(md, p, tex, far + MIP, 0x180, 0x1c0, 0x1bf, 0x1ff);
    p = packedRect(md, p, tex, near + MIP, 0x1c0, 0x1e0, 0x1df, 0x1ff);
    packedRect(md, p, tex, far + MIP, 0x1e0, 0x1f0, 0x1ef, 0x1ff);
    clearMipCorner(tex, far);
}

/* An enemy set's bank (0x6F8D0): 0x55500 bytes, all in the mip halves, in the
 * rectangles the stage leaves free. The flag picks which sheet takes which. */
function enemyBank(md, src, tex, flag) {
    const a = flag ? SHEET1 : SHEET0, b = flag ? SHEET0 : SHEET1;
    let p = packedRect(md, src, tex, a + MIP, 0x000, 0x000, 0x1ff, 0x0ff);
    p = packedRect(md, p, tex, b + MIP, 0x100, 0x100, 0x1ff, 0x17f);
    p = packedRect(md, p, tex, a + MIP, 0x180, 0x180, 0x1ff, 0x1bf);
    p = packedRect(md, p, tex, b + MIP, 0x1c0, 0x1c0, 0x1ff, 0x1df);
    p = packedRect(md, p, tex, a + MIP, 0x1e0, 0x1e0, 0x1ff, 0x1ef);
    packedRect(md, p, tex, b + MIP, 0x1f0, 0x1f0, 0x1ff, 0x1f7);
}

/* Where 0x97D10 puts a stage's eight 64x64 blocks on sheet 0, as in The House
 * of the Dead; a null entry leaves the place alone. */
const PATCH_AT = [[0, 0], [64, 0], [0, 64], [64, 64], [0, 128], [64, 128], [0, 192], [64, 192]];

/*
 * Texture RAM for a scene, in the order the game loads it: boot (0x7D450), the
 * stage (0x7D3F0: its bank, then its blocks) and the two enemy sets (0x7D420).
 * Checked against texture RAM read out of MAME (dynamcop, three attract
 * scenes): sheet 1 matches exactly. Sheet 0 matches outside the eight block
 * places, which hold the blocks of every stage played before, as nothing puts
 * boot's back; here they hold boot's and the stage's own.
 */
export function buildDynamcopTexram(rom, set, scene = dynamcopScene(rom, set)) {
    const md = rom.mainData;
    const cv = rom.mainCpuView;
    const raw = rom.game.texture.raw;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const bank = (k) => dataOffset(cv.getUint32(raw.bankTable + k * 4, true));
    bootBank(rom, md, bank(0), tex);
    let pages = 1;
    if (scene.stage > 0) {
        stageBank(md, bank(scene.stage), tex);
        for (let i = 0; i < PATCH_AT.length; i++) {
            const src = cv.getUint32(raw.patchTable + scene.stage * 32 + i * 4, true);
            if (!src) continue;
            const s0 = dataOffset(src);
            if (s0 + 0x2000 > md.length) continue;
            const [x, y] = PATCH_AT[i];
            for (let r = 0; r < 64; r++) {
                tex.set(md.subarray(s0 + r * 128, s0 + r * 128 + 128), SHEET0 + (((y + r) << 9) + x) * 2);
            }
        }
        pages++;
    }
    const D = rom.game.dynamcop;
    for (const n of scene.enemies) {
        enemyBank(md, bank(D.stages + n), tex, scene.flag(n));
        pages++;
    }
    return { sheet0: tex.subarray(0, SHEET_BYTES), sheet1: tex.subarray(SHEET_BYTES), pages };
}

/*
 * The face palette for a scene. Each table is a count and that many BGR555
 * colours, written up from a start (0x318E0 and the like) or down from one.
 * In the order boot and the set loaders write them:
 *
 *   boot table `tables[0]`             up from 0
 *   top table `top[0]`                 down from 1023
 *   `extra`: its first 50              down from 983, the rest down from 873
 *   the stage's `tables[s]`            up from 400
 *   the stage's `top[s]`               down from 933
 *   enemy n's `tables[14 + n]`         up from 550 (flag 0) or 600 (flag 1)
 *
 * Checked against palette RAM read out of MAME in three attract scenes: only
 * a few entries the game animates differ. Entries nothing writes are 0.
 */
export function dynamcopPalette(rom, set, scene = dynamcopScene(rom, set)) {
    const p = rom.game.palette;
    const cv = rom.mainCpuView;
    const len = rom.maincpu.length;
    const out = new Int32Array(1024).fill(0);
    const put = (t, first, down, from = 0, to = Infinity) => {
        if (!t || t + 2 > len) return;
        const count = Math.min(cv.getUint16(t, true), to);
        for (let i = from; i < count; i++) {
            const j = down ? first - (i - from) : first + (i - from);
            if (j < 0 || j > 1023 || t + 4 + i * 2 > len) break;
            out[j] = cv.getUint16(t + 2 + i * 2, true);
        }
    };
    const ptr = (a, k) => cv.getUint32(a + k * 4, true);
    put(ptr(p.tables, 0), 0, false);
    put(ptr(p.top, 0), 1023, true);
    put(ptr(p.extra, 0), 983, true, 0, 50);
    put(ptr(p.extra, 0), 873, true, 50);
    if (scene.stage > 0) {
        put(ptr(p.tables, scene.stage), 400, false);
        put(ptr(p.top, scene.stage), 933, true);
    }
    const D = rom.game.dynamcop;
    for (const n of scene.enemies) put(ptr(p.tables, D.stages + n), scene.flag(n) ? 600 : 550, false);
    return out;
}

/* ---- Stages: the areas the mission table lists -------------------------- */

/*
 * 0x2B960 starts an area. `missions` is twelve pointers, three per mission
 * (the mission in 0x51F4A0, the variant in 0x51F49C), each to a run of area
 * descriptors, 40 bytes apiece; the area number is 0x51F4A4. Word +0x10 of a
 * descriptor is its object list: 32-byte records, ended by the first record
 * after the first whose type (+0x14) is 0. Word +0x1C is the area's song, a
 * record of the song table (0x4B6A8 sends it as the area starts, unless it is
 * the one already playing).
 *
 *   +0x02  s16    model, an index into the whole model table
 *   +0x04  float  x, y, z
 *   +0x10  s16    yaw, 0x4000 a quarter turn
 *   +0x14  u32    type
 *
 * The first record sets the area up (0x1D970 by its type). The others are
 * spawned through 0x1D9A0[type]. Type 2 is the room itself (0x1F0D0, whose
 * task 0x1DFD0 draws its model where it stands), and the rest are props,
 * the sea and sky, and the things a cut scene moves. Each area is a room in
 * its own frame, round the origin.
 *
 * The runs have no count. One ends where the next starts, and the last one
 * ends at the mission table. A descriptor whose list is outside the data the
 * lists live in (0x1D0000-0x200000) is past the end.
 */
const LISTS = [0x1d0000, 0x200000];

function areaRuns(rom) {
    const D = rom.game.stageTable.dynamcop;
    const cv = rom.mainCpuView;
    const runs = [...new Set([...Array(12).keys()].map((k) => cv.getUint32(D.missions + k * 4, true)))]
        .sort((a, b) => a - b);
    const out = new Map();
    runs.forEach((p, i) => {
        const end = runs[i + 1] ?? D.missions;
        const areas = [];
        for (let d = p; d + 40 <= end; d += 40) {
            const list = cv.getUint32(d + 0x10, true);
            if (list < LISTS[0] || list >= LISTS[1]) break;
            areas.push({ list, song: cv.getUint32(d + 0x1c, true) });
        }
        out.set(p, areas);
    });
    return out;
}

function areaRecords(rom, list) {
    const cv = rom.mainCpuView;
    const count = rom.game.modelTable.count;
    const out = [];
    for (let i = 0, o = list; i < 512 && o + 32 <= LISTS[1]; i++, o += 32) {
        const type = cv.getUint32(o + 0x14, true);
        if (i > 0 && type === 0) break;
        if (i === 0) continue;
        const model = cv.getInt16(o + 2, true);
        if (model <= 0 || model >= count) continue;
        out.push({
            model, type,
            pos: [cv.getFloat32(o + 4, true), cv.getFloat32(o + 8, true), cv.getFloat32(o + 12, true)],
            yaw: cv.getUint16(o + 0x10, true),
        });
    }
    return out;
}

/* A model's set: its bank's (bankTextureSet), with boot's models drawn under
 * whatever the area is. */
function areaSet(rom, records) {
    const votes = new Map();
    for (const r of records) {
        const s = bankTextureSet(rom, r.model);
        if (s) votes.set(s, (votes.get(s) ?? 0) + 1);
    }
    let best = 0, most = 0;
    for (const [s, n] of votes) if (n > most) { best = s; most = n; }
    return best;
}

/**
 * One stage per area the missions reach. An area two variants share is
 * listed once, under the first that reaches it. A model of an enemy set is
 * drawn under that set, the rest under the area's stage.
 */
export function readDynamcopStages(rom) {
    const D = rom.game.stageTable.dynamcop;
    const cv = rom.mainCpuView;
    const lit = gameLighting(rom);
    const runs = areaRuns(rom);
    const seen = new Set();
    const stages = [];
    for (let k = 0; k < 12; k++) {
        const mission = Math.floor(k / 3), variant = k % 3;
        const areas = runs.get(cv.getUint32(D.missions + k * 4, true)) ?? [];
        areas.forEach(({ list, song }, area) => {
            if (seen.has(list)) return;
            seen.add(list);
            const records = areaRecords(rom, list);
            if (!records.length) return;
            const set = areaSet(rom, records);
            const setOf = (m) => {
                const s = bankTextureSet(rom, m);
                return s >= D.enemySets ? s : set;
            };
            const draws = [], objects = [];
            for (const r of records) {
                const s = setOf(r.model);
                if (r.type === 2) draws.push({ model: r.model, pos: r.pos, turn: r.yaw, set: s, layer: 'scenery' });
                else objects.push({ model: r.model, pos: r.pos, turn: [0, r.yaw, 0], scale: 1, set: s });
            }
            const sets = [...new Set([...draws, ...objects].map((d) => d.set))].sort((a, b) => a - b);
            stages.push({
                slot: stages.length,
                placements: true,
                mixedSets: sets.length > 1,
                num: mission + 1,
                name: `Course ${mission + 1}-${variant + 1}, area ${area}`,
                chapter: mission,
                draws,
                objects,
                song: musicChoices(rom)?.[song]?.code,
                sky: null,
                zones: [],
                views: [['all', 'Everything']],
                view: 'all',
                union: 'all',
                texSets: [set],
                texSet: [set, set],
                tint: [1, 1, 1],
                bright: 1,
                light: lit?.light,
                materials: lit?.materials,
                colorCycles: [],
                flags: 0,
                floorSize: 0,
                meta: [['course', `${mission + 1}-${variant + 1}`], ['area', area],
                    ['list', `0x${list.toString(16)}`], ['set', sets.join(', ')],
                    ['pieces', draws.length + objects.length],
                    ...(musicChoices(rom) ? [['song', musicChoices(rom)[song]?.label ?? song]] : [])],
            });
        });
    }
    return stages;
}

/* ---- characters ------------------------------------------------------------ */

/*
 * The skeleton every character is drawn on, as sub_15210 builds it. There is
 * no tree of part records as in The House of the Dead: the routine walks
 * sixteen joints in a fixed order, pushing and popping the coprocessor's
 * matrix stack, and reads back each joint's matrix to 0x6A4 + 48 * joint of
 * the object. Joint 0 is the root and draws nothing; 1 is the chest, 2 the
 * head, 3-5 and 6-8 the arms, 9 the hips, 10-12 and 13-15 the legs. These
 * parents were fitted against those read-back matrices in MAME (offset and
 * turn exact for every joint, over a dozen attract frames).
 */
const DYNAMCOP_PARENTS = [-1, 0, 1, 1, 3, 4, 1, 6, 7, 0, 9, 10, 11, 9, 13, 14];

/*
 * The joints a motion's flag byte (0x164160[motion]) can stand back up: the
 * routine reads the matrix back, puts the body's own turn (the one it held
 * before joint 0) in place of its rotation, and turns the joint from there.
 * Bit 0 does both ankles, bits 1 and 2 one wrist each (`2 << arm`).
 */
const DYNAMCOP_FLAT = { 5: 2, 8: 4, 12: 1, 15: 1 };

/* The skeletons that are not this one: character 75's table is not sixteen
 * offsets and 79's is laid out for another body. */
const DYNAMCOP_OTHER_SKELETONS = new Set([75, 79]);

const DYNAMCOP_NAMES = ['Bruno Delinger', 'Jean Ivy', 'Eddie Brown'];

/**
 * Every character in the program's two parallel tables, as bodies.js bodies.
 *
 * `rig.bodies.offsets[char]` points at sixteen float triples, the offset of
 * joint k + 1 from its parent (sub_15210 reads it with `ld 0xE1890[g4*4]` on
 * the object's +0xDC); `rig.bodies.models[char]` at fifteen model numbers, one
 * for each of joints 1-15 in order, which sub_18FC0 draws off the object's
 * +0xE4 with sub_9A980. The offsets are the board's; the viewer's z is the
 * board's negated.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]}
 */
export function readDynamcopBodies(rom) {
    const B = rom.game.rig.bodies;
    const dv = rom.mainCpuView;
    const out = [];
    for (let i = 0; i < B.count; i++) {
        if (DYNAMCOP_OTHER_SKELETONS.has(i)) continue;
        const skel = dv.getUint32(B.offsets + i * 4, true);
        const list = dv.getUint32(B.models + i * 4, true);
        if (skel + 16 * 12 > rom.maincpu.length || list + 15 * 4 > rom.maincpu.length) continue;
        const parts = DYNAMCOP_PARENTS.map((parent, j) => {
            const at = skel + (j ? j - 1 : 0) * 12;
            const offset = j ? [dv.getFloat32(at, true), dv.getFloat32(at + 4, true), -dv.getFloat32(at + 8, true)] : [0, 0, 0];
            let depth = 0;
            for (let p = parent; p >= 0; p = DYNAMCOP_PARENTS[p]) depth++;
            return {
                index: j,
                parent,
                depth,
                model: j ? dv.getUint32(list + (j - 1) * 4, true) : 0,
                offset,
                flags: 0,
                flatBits: DYNAMCOP_FLAT[j] ?? 0,
                joint: j,
                record: skel,
            };
        });
        out.push({
            index: i,
            name: DYNAMCOP_NAMES[i] ?? `character ${i}`,
            joints: 16,
            scale: 1,
            roles: [],
            skin: -1,
            hitMotions: [],
            start: -1,
            root: skel,
            parts,
        });
    }
    return out;
}

/*
 * The hand each motion frame asks for (sub_192E0 and sub_19580; sub_19350,
 * sub_19600, sub_1D3C0 and sub_1D4B0 are the same code). The draw loop
 * (sub_18FC0) hands joint 8 to the first and joint 5 to the second when the
 * motion has a table at `rig.hands.frames` + 8 * motion (+4 for joint 8):
 * a halfword a frame, indexed by the object's +0x2C8 (the frame from 0, the
 * one sub_14FD0 points the pose at). Its top five bits pick the hand:
 *
 *   n = halfword >> 11, joint 8 r = n, joint 5 r = 32 - n
 *   alt = sub_7F0A0(base): the pair list at `rig.hands.swaps`
 *         ({base, alt} words, ending with -1), else base itself
 *   alt == base: base;  r <= 0 or r > 23: alt;  r <= 15: alt + r;  else base
 *
 * The models after alt are the hand turned through fifteen steps (open
 * and flat); a hand the list does not name keeps its own model. The
 * halfword's lower bits are never read.
 */
function handTable(rom, address) {
    if (!address) return null;
    if ((address >>> 24) === 0x06) return xtraResolve(rom, address);
    if (address < rom.maincpu.length) return { view: rom.mainCpuView, off: address };
    const off = address - MAIN_DATA_BASE;
    return off >= 0 && off < rom.mainData.length ? { view: rom.mainDataView, off } : null;
}

function handSwap(rom, base) {
    const dv = rom.mainCpuView;
    for (let at = rom.game.rig.hands.swaps; dv.getInt32(at, true) !== -1; at += 8) {
        if (dv.getInt32(at, true) === base) return dv.getInt32(at + 4, true);
    }
    return base;
}

/**
 * The hand models a Dynamite Cop body draws on one frame of a motion.
 *
 * @param {object} rom loaded ROM set
 * @param {object} body from readDynamcopBodies
 * @param {object|null} motion from readMotions
 * @param {number} frame 1-based
 * @returns {[number, number][]} [joint, model] for each hand the motion sets
 */
export function dynamcopHands(rom, body, motion, frame) {
    const H = rom.game.rig.hands;
    if (!H || !motion) return [];
    const out = [];
    for (const [joint, side] of [[5, 0], [8, 1]]) {
        const t = handTable(rom, rom.mainCpuView.getUint32(H.frames + motion.index * 8 + side * 4, true));
        if (!t) continue;
        const f = Math.max(1, Math.min(frame, motion.frames)) - 1;
        if (t.off + 2 * f + 2 > t.view.byteLength) continue;
        const n = t.view.getUint16(t.off + 2 * f, true) >> 11;
        const r = side ? n : 32 - n;
        const base = body.parts[joint].model;
        const alt = handSwap(rom, base);
        let model = base;
        if (alt !== base) {
            if (r <= 0 || r > 23) model = alt;
            else if (r <= 15) model = alt + r;
        }
        out.push([joint, model]);
    }
    return out;
}

/*
 * The shadow under each character (sub_197E0 at 0x19B70, past the parts):
 * unless the object's +0x54 has bit 5, the draw multiplies by the matrix at
 * 0x54ECF0 and then, for each joint in the list at `rig.shadows.joints`
 * (`count` long: 1, 3, 4, 6, 7, 9, 10, 11, 13 and 14), pushes the joint's
 * matrix and draws `table[joint]`, where
 *
 *   t = rig.shadows.tables[char]           (char = +0xDC)
 *   table = t[+0xBC] if +0xBC <= 5, else t[0]
 *
 * +0xBC is a hero's player number, or an enemy's spawn record's +0x18; it
 * only picks which of six copies of the pieces (each its own textures) is
 * drawn. The matrix at 0x54ECF0 is built once, from two constant angles
 * (sub_A6850, then sub_A68D0): it zeroes world y, so each piece is its
 * joint laid flat on the floor, the light straight down.
 */
function shadowTable(rom, body, variant) {
    const S = rom.game.rig.shadows;
    const dv = rom.mainCpuView;
    const inRom = (a) => a > 0 && a + 4 <= rom.maincpu.length;
    const at = S.tables + body.index * 4;
    const group = inRom(at) ? dv.getUint32(at, true) : 0;
    const pick = group + (variant <= 5 ? variant : 0) * 4;
    const table = inRom(pick) ? dv.getUint32(pick, true) : 0;
    return inRom(table + 15 * 4) ? table : 0;
}

/**
 * The shadow pieces a Dynamite Cop body draws.
 *
 * @param {object} rom loaded ROM set
 * @param {object} body from readDynamcopBodies
 * @param {number} [variant] the object's +0xBC (0: player 1's)
 * @returns {[number, number][]} [joint, model] for each piece
 */
export function dynamcopShadows(rom, body, variant = 0) {
    const S = rom.game.rig.shadows;
    if (!S || !body) return [];
    const table = shadowTable(rom, body, variant);
    if (!table) return [];
    const dv = rom.mainCpuView;
    const count = dv.getUint32(S.count, true);
    const out = [];
    for (let i = 0; i < Math.min(count, 16); i++) {
        const joint = dv.getUint32(S.joints + i * 4, true);
        if (joint >= 16) continue;
        const model = dv.getUint32(table + joint * 4, true);
        if (model) out.push([joint, model]);
    }
    return out;
}
