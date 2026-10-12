/*
 * vf2.js — Virtua Fighter 2's stages.
 *
 * A stage is one 256-byte record in the program ROM, at 0x6EE38 + stage * 256,
 * the stage being the byte at 0x500064. The draw routine, 0x20708, reads it:
 *
 *   +0x00  u16[32]  the floor and the scenery round it, in camera cells:
 *                   0x20AFC draws the ones the cell's mask (0x70058) lets through
 *   +0x40  u16[16]  the backdrop, by which way the camera faces (0x207E0)
 *   +0x60  u16      one more piece, under flag bit 8 (0x20840)
 *   +0x62  u16      the ring's floor, under the ring scale (0x20264)
 *   +0x64  u16      Dural's mirror floor, under flag bit 5 and the same scale
 *   +0x68  u32      flags
 *   +0x6C  f32      the light's brightness, and +0x70, +0x72 its two angles —
 *                   0xCE1C copies them to 0x501098 and 0x501020, as Fighting
 *                   Vipers' change_scene does from its own record
 *   +0x78  u32      texture set, and +0x7C its colour block (0xCE38 -> 0x4B410)
 *   +0x84  u16[6]   the ground round the ring, one per ring size (0x208B4)
 *
 * None of them is drawn under a matrix of its own — every piece is modelled
 * where it stands — so the whole stage is every piece at the origin. -1 is an
 * empty slot. Flag bit 6 swaps the lists for the ones at 0x6FE38, a second
 * look of the same stage, while the byte at 0xDF of the stage state says so.
 *
 * The ring is sized by the operator: 0x50A00C, the setting, is doubled and
 * rounded, and 12 and up pick entries 0..4 (capped), anything less entry 5.
 * The floor inside it is one model scaled (size/6, 1, size/6).
 *
 * Flag bit 3 is the raft (0x20054): eight logs under the ring scale, from a
 * list the fight breaks up as fighters near the edge (0x1D6D0 fills it whole),
 * and ten more planks from 0x150 of the stage state (0x1D824), 2.2 apart,
 * then model 0x764. Flag bit 12 draws model 0x8FF and nothing else (stage 15).
 *
 * The stage's name is in the debug menu's list (0x71AF4), which the pointers
 * at 0x46108 index by the colour block plus one.
 */

import { gameLighting, stageLight } from './stages.js';

const RECORD_BYTES = 256;
const EMPTY = 0xffff;
const SCENERY = { at: 0x00, count: 32 };
const BACKDROP = { at: 0x40, count: 16 };
const EXTRA = 0x60;
const RING_FLOOR = 0x62;
const MIRROR_FLOOR = 0x64;
const FLAGS = 0x68;
const BRIGHT = 0x6c;
const VECTER = 0x70;
const TEX_SET = 0x78;
const COLOR_BLOCK = 0x7c;
const RINGS = 0x84;
const RING_COUNT = 6;
const FLAG_EXTRA = 1 << 8;
const FLAG_RING = 1 << 2;
const FLAG_ALT = 1 << 6;
const FLAG_RAFT = 1 << 3;
const FLAG_MIRROR = 1 << 5;
const FLAG_ONLY = 1 << 12;
/* The second look's lists, which the alternate reads index without the stage. */
const ALT_LISTS = 0x6fe38;

const NAMES = 0x46108;
const NAME_BYTES = 13;
/* What the romanised names mean, for the ones that are Japanese. */
const GLOSS = {
    'BAN-RI': 'Great Wall', IKADA: 'raft', 'YUKI-YAMA': 'snow mountain', 'BUDOU-JOU': 'dojo',
};

/* The intact raft: the logs (0x1D6D0) and the planks (0x1D824), as listed. */
const RAFT_LOGS = [0x68e, 0x6bf, 0x6df, 0x6bf, 0x6df, 0x6bf, 0x6df, 0x68e];
/* Where the walk at 0x200E4 leaves each log: 5.4, less 1.4, then 1.6 a step,
 * and the first one 0.2 back. */
const RAFT_LOG_X = [-5.4, -4.0, -2.4, -0.8, 0.8, 2.4, 4.0, 5.4];
const RAFT_PLANKS = [0x765, 0x765, 0x765, 0x791, 0x791, 0x791, 0x791, 0x765, 0x765, 0x765];
const RAFT_PLANK_X0 = 9.9;
const RAFT_PLANK_STEP = 2.2;
const RAFT_TAIL = 0x764;
/* The ring scale's divisor: the setting over 6.0. */
const RING_UNIT = 6;

function u16(rom, a) { return rom.mainCpuView.getUint16(a, true); }
function u32(rom, a) { return rom.mainCpuView.getUint32(a, true); }

function modelList(rom, at, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(u16(rom, at + i * 2));
    return out;
}

/* Which of the six ring models the default setting picks. */
function ringIndex(size) {
    const n = Math.trunc(size * 2 + 0.5);
    return n <= 11 ? 5 : Math.min(n - 12, 4);
}

/* The stage's name from the debug list, with its meaning where it has one. */
function stageName(rom, colors) {
    const at = u32(rom, NAMES + (colors + 1) * 4);
    const bytes = new Uint8Array(rom.mainCpuView.buffer, rom.mainCpuView.byteOffset + at, NAME_BYTES);
    const text = String.fromCharCode(...bytes.slice(0, bytes.indexOf(0))).split(':')[1]?.trim();
    if (!text) return null;
    const word = text.charAt(0) + text.slice(1).toLowerCase();
    return GLOSS[text] ? `${word} (${GLOSS[text]})` : word;
}

const scaled = (s, x = 0) => [['s', [s, 1, s]], ['t', [x, 0, 0]]];

/* The raft's logs, under the ring scale, and its planks after them. */
function raftPieces(s) {
    return [
        ...RAFT_LOGS.map((m, i) => [m, 'platform', scaled(s, RAFT_LOG_X[i])]),
        ...RAFT_PLANKS.map((m, i) => [m, 'platform', [['t', [RAFT_PLANK_X0 - i * RAFT_PLANK_STEP, 0, 0]]]]),
        [RAFT_TAIL, 'platform'],
    ];
}

/* The pieces of one look of a stage: scenery, backdrop, the extras, the ring.
 * Each is [model, layer, ops?]; without ops it stands at the origin. */
function stagePieces(rom, base, lists, ringSize) {
    const flags = u32(rom, base + FLAGS);
    /* Stage 15's one model has nothing to see in it; it is left out. */
    if (flags & FLAG_ONLY) return [];
    const s = ringSize / RING_UNIT;
    const pieces = [
        ...modelList(rom, lists + SCENERY.at, SCENERY.count).map((m) => [m, 'scenery']),
        ...modelList(rom, lists + BACKDROP.at, BACKDROP.count).map((m) => [m, 'sky']),
    ];
    if (flags & FLAG_EXTRA) pieces.push([u16(rom, lists + EXTRA), 'extra']);
    if (flags & FLAG_RAFT && u16(rom, lists + EXTRA) !== EMPTY) pieces.push(...raftPieces(s));
    pieces.push([u16(rom, lists + RING_FLOOR), 'floor', scaled(s)]);
    if (flags & FLAG_MIRROR) pieces.push([u16(rom, base + MIRROR_FLOOR), 'floor', scaled(s)]);
    if (flags & FLAG_RING) pieces.push([u16(rom, base + RINGS + ringIndex(ringSize) * 2), 'ground']);
    return pieces;
}

function stageOf(rom, lit, n, { alt = false, ringSize } = {}) {
    const T = rom.game.stageTable.vf2;
    const base = T.at + n * RECORD_BYTES;
    const set = u32(rom, base + TEX_SET);
    const colors = u32(rom, base + COLOR_BLOCK);
    const t = rom.game.modelTable;
    const pieces = stagePieces(rom, base, alt ? ALT_LISTS : base, ringSize)
        .filter(([m]) => m !== EMPTY && m < t.count);
    const draws = pieces.map(([model, layer, ops]) => ({ model, pos: [0, 0, 0], set, layer, ...(ops ? { ops } : {}) }));
    const name = stageName(rom, colors) ?? `Stage ${n}`;
    return {
        slot: n,
        placements: true,
        mixedSets: false,
        num: n,
        /* The number the song and stage-sound tables are indexed by. */
        soundSlot: n,
        name: alt ? `${name} (second look)` : name,
        chapter: n,
        draws,
        objects: [],
        sky: null,
        zones: [],
        views: [['all', 'Everything']],
        view: 'all',
        union: 'all',
        texSets: [set],
        texSet: [set, colors],
        tint: [1, 1, 1],
        bright: 1,
        light: stageLight(rom.mainCpuView.getFloat32(base + BRIGHT, true),
            rom.mainCpuView.getInt16(base + VECTER, true), rom.mainCpuView.getInt16(base + VECTER + 2, true)),
        materials: lit.materials,
        colorCycles: [],
        flags: u32(rom, base + FLAGS),
        floorSize: 0,
        meta: [['stage', n], ['texture set', set], ['colour block', colors],
            ['pieces', draws.length], ['flags', `0x${u32(rom, base + FLAGS).toString(16)}`]],
    };
}

/* What a stage draws, to tell the copies (11 of 10, 13 of 9, 14 of 1) from
 * the stages: they differ only in bytes the draw never reads. */
function drawKey(stage) {
    return `${stage.texSet}|${stage.draws.map((d) => d.model).join()}`;
}

/**
 * Virtua Fighter 2's stages: every record in the table once, the copies
 * dropped, and the second look of the one stage that has one.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stage objects in the shape the viewer's stage list takes
 */
export function readVf2Stages(rom) {
    const T = rom.game.stageTable.vf2;
    const lit = gameLighting(rom);
    const opts = { ringSize: T.ringSize };
    const seen = new Set();
    const stages = [];
    for (let n = 0; n < T.count; n++) {
        const stage = stageOf(rom, lit, n, opts);
        if (!stage.draws.length || seen.has(drawKey(stage))) continue;
        seen.add(drawKey(stage));
        stages.push(stage);
        if (stage.flags & FLAG_ALT) stages.push(stageOf(rom, lit, n, { ...opts, alt: true }));
    }
    stages.forEach((s, i) => { s.slot = i; });
    return stages;
}
