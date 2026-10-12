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
 *   +0x76  u8       the stage's kind, which picks its effects (0x31408)
 *   +0x78  u32      texture set, and +0x7C its colour block (0xCE38 -> 0x4B410)
 *   +0x80  u8[3]    red, green and blue scales, 0x80 for one, which go to
 *                   0x5000E0 for the colour tables (0x2C38), as Fighting
 *                   Vipers' stage_RED: the mirror stage's 50 70 80 is its
 *                   water, Souseiji's and the stones' a warmer dusk
 *   +0x84  u16[6]   the ground round the ring, one per ring size (0x208B4)
 *
 * None of them is drawn under a matrix of its own — every piece is modelled
 * where it stands — so the whole stage is every piece at the origin. -1 is an
 * empty slot. Flag bit 6 swaps the lists for the ones at 0x6FE38, a second
 * look of the same stage, while the byte at 0xDF of the stage state says so;
 * its rings are at +0x64 there, not +0x84. That is the Colosseum's lightning
 * (see stormSchedule).
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
 * The raft also moves, and the frame counts kept for it start at zero when the
 * stage is set up (0x1FE78). Under flag bit 3 the river goes by: 0x1D530 takes
 * 0.037 off 0x50A014 every frame, and the stage draw (0x20740) pushes the
 * negated vector before the scenery, so the bank slides along +X past a raft
 * that stays put. Under flag bit 4 the raft rocks: 0x1D550 counts frames at
 * 0x50A026 and sets the roll at 0x50A024 to
 *
 *   411 sin(128 t) + 133 sin(192 t + 0x1234)      (angles 0x10000 to the turn)
 *
 * — about three degrees at most, an 8.5 and a 5.7 second swell — and after
 * the scenery 0x1DD8C rolls the view by its negation, an ang_z (0x37006E6E,
 * the camera's own), under everything drawn after it: the raft, the ring floor
 * and the fighters. 0x1D4E4 keeps the camera above x sin(roll), so the roll is
 * about the raft's centre line and lifts +X.
 *
 * The stage's name is in the debug menu's list (0x71AF4), which the pointers
 * at 0x46108 index by the colour block plus one.
 */

import { gameLighting, stageLight } from './stages.js';
import { buildVf2Sky, buildVf2StormSky } from './scroll.js';

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
const KIND = 0x76;
const TINT = 0x80;
const UNIT_TINT = 0x80;
const RING_COUNT = 6;
const FLAG_EXTRA = 1 << 8;
const FLAG_RING = 1 << 2;
const FLAG_ALT = 1 << 6;
const FLAG_RAFT = 1 << 3;
const FLAG_MIRROR = 1 << 5;
const FLAG_ONLY = 1 << 12;
/* The second look's lists, which the alternate reads index without the stage. */
const ALT_LISTS = 0x6fe38;
const ALT_RINGS = 0x64;

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

const FLAG_ROCK = 1 << 4;
/* What 0x1D530 adds to 0x50A014 a frame, and the two swells of the roll. */
const RIVER_STEP = -0.037;
const ROLL_SWELLS = [[411, 128, 0], [133, 192, 0x1234]];
/* The counts start again with the stage, which the game sets up for every
 * round; the explorer starts them again every round of the default thirty
 * seconds, or the bank would slide off into the distance. */
const ROUND_FRAMES = 30 * 60;
const ANGLE_DEG = 360 / 0x10000;
/* What the stage draw puts under the river's push, and what goes under the roll. */
const WORLD_LAYERS = new Set(['scenery', 'sky', 'extra', 'ground']);
const RAFT_LAYERS = new Set(['platform', 'floor']);

const boardSin = (a) => Math.sin(((a & 0xffff) * 2 * Math.PI) / 0x10000);

/* The roll at 0x50A024 on the board's frame t, in board angle units. */
export function raftRoll(t) {
    return Math.trunc(ROLL_SWELLS.reduce((sum, [k, step, phase]) => sum + k * boardSin(t * step + phase), 0));
}

/* A piece's ops with the raft's motion in front of them, as a function of the
 * frame; ops unchanged where the stage does not move. The roll is an ang_z by
 * the negated angle, which the viewer takes as it stands (see angZ in
 * js/display.js), and the push is the negated river, along +X. */
function raftMotion(flags, layer, ops = []) {
    if (flags & FLAG_RAFT && WORLD_LAYERS.has(layer)) {
        return (f) => [['t', [-RIVER_STEP * ((f % ROUND_FRAMES) + 1), 0, 0]], ...ops];
    }
    if (flags & FLAG_ROCK && RAFT_LAYERS.has(layer)) {
        return (f) => [['rz', raftRoll((f % ROUND_FRAMES) + 1) * ANGLE_DEG], ...ops];
    }
    return ops.length ? ops : null;
}

/*
 * Tou-rin's wind (kind 12). After the fighters, under the camera, the kind's
 * hook 0x30E74 draws one model at the stage's origin: the u16 at
 * 0x70FBC[(frame >> 1) & 0xFF], 256 frames of blown leaves and dust drawn
 * once each, so the gust takes 512 frames to come round; -1 draws nothing.
 * The same kind's 0x30EAC is a burst the fight sets off, left out.
 */
const KIND_TOURIN = 12;
const WIND = { at: 0x70fbc, count: 256, shift: 1 };

/*
 * The Colosseum's lightning. Its sky's per-frame routine, 0x2468C, takes the
 * low byte of the random number at 0x94D0 every frame, and if it is 0 to 3
 * and that channel is idle (0xFF at 0x503040 + n), starts the channel; it
 * draws again rather than run 0 and 2 together. Every running channel then
 * steps once through the timeline at 0x24D70 a frame: 0 turns its write on,
 * 1 off, 0xFF stops, anything else waits. On the timeline a channel is on
 * for frames 0-2, 4-5, 8-10, 12-17, 20-22 and 24-25 of its 27. Channels 0
 * to 2 are the sky's (js/scroll.js); channel 3 sets bit 0 of the stage
 * state's 0xDF, which turns the second look on, and 0x1FC00 sees it rise and
 * sets the light to 9999 at angles 0x9D00 and 0xBF00 (0x501098, 0x501020-22)
 * — every face that turns towards it full white — and sees it fall and puts
 * the record's light back.
 *
 * The random number adds up hardware counters (0xF00000), so when a channel
 * starts cannot be had from the ROM; a seeded generator stands in for it,
 * with the board's odds of one in 256 a frame.
 */
const STORM_SKY = 0x2468c;
const SKY_FRAME_ROUTINE = (n) => 0x2502c + n * 32 + 4;
const STORM_TIMELINE = 0x24d70;
const STORM_ON = 0, STORM_OFF = 1, STORM_END = 0xff;
const STORM_CHANNELS = 4;
const STORM_ARENA = 1 << 3;
const STORM_SEED = 0x693;
const FLASH_LIGHT = [9999, 0x9d00 - 0x10000, 0xbf00 - 0x10000];

/* A small fixed generator, so the storm is the same every visit. */
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) & 0xff;
    };
}

/* Which channel this frame's draw starts, or -1; 0 and 2 never run together. */
function stormStart(at, rand) {
    for (;;) {
        const r = rand();
        if (r >= STORM_CHANNELS || at[r] !== STORM_END) return -1;
        const other = r === 0 ? 2 : r === 2 ? 0 : -1;
        if (other < 0 || at[other] === STORM_END) return r;
    }
}

/**
 * The storm's channels, frame by frame: bit n is set while channel n's write
 * is on. One round of the explorer's frames, which the caller wraps.
 *
 * @param {object} rom loaded ROM set
 * @returns {Uint8Array} the bits for each frame of the round
 */
export function stormSchedule(rom) {
    const step = (i) => rom.mainCpuView.getUint8(STORM_TIMELINE + i);
    const at = new Array(STORM_CHANNELS).fill(STORM_END);
    const rand = seeded(STORM_SEED);
    const out = new Uint8Array(ROUND_FRAMES);
    let bits = 0;
    for (let f = 0; f < ROUND_FRAMES; f++) {
        const ch = stormStart(at, rand);
        if (ch >= 0) at[ch] = 0;
        for (let c = 0; c < STORM_CHANNELS; c++) {
            if (at[c] === STORM_END) continue;
            const v = step(at[c]);
            if (v === STORM_ON) bits |= 1 << c;
            else if (v === STORM_OFF) bits &= ~(1 << c);
            at[c] = v === STORM_END ? STORM_END : at[c] + 1;
        }
        out[f] = bits;
    }
    return out;
}

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
function stagePieces(rom, base, lists, ringSize, rings = base + RINGS) {
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
    if (flags & FLAG_RING) pieces.push([u16(rom, rings + ringIndex(ringSize) * 2), 'ground']);
    return pieces;
}

/* One look's pieces: the stage's own lists, or the second look's. */
function lookPieces(rom, base, ringSize, alt) {
    return alt
        ? stagePieces(rom, base, ALT_LISTS, ringSize, ALT_LISTS + ALT_RINGS)
        : stagePieces(rom, base, base, ringSize);
}

/* The two looks piece by piece, each a model that swaps to its lit twin while
 * the arena's channel is on. The lists run in step, so pieces pair by place. */
function stormPieces(rom, base, ringSize, storm) {
    const lit = lookPieces(rom, base, ringSize, true);
    const index = (f) => (storm[f % ROUND_FRAMES] & STORM_ARENA ? 1 : 0);
    return lookPieces(rom, base, ringSize, false).map(([m, layer, ops], i) => {
        const frames = [m, lit[i][0]].map((x) => (x === EMPTY ? 0 : x));
        return [frames.find((x) => x) ?? EMPTY, layer, ops, frames[0] === frames[1] ? null : { frames, index }];
    });
}

/* The kind's own draws after the fighters, as [model, layer, ops, anim]. */
function kindPieces(rom, kind) {
    if (kind !== KIND_TOURIN) return [];
    const frames = modelList(rom, WIND.at, WIND.count).map((m) => (m === EMPTY ? 0 : m));
    return [[frames.find((m) => m), 'scenery', undefined, { frames, shift: WIND.shift, phase: 0 }]];
}

function stageOf(rom, lit, n, { alt = false, ringSize } = {}) {
    const T = rom.game.stageTable.vf2;
    const base = T.at + n * RECORD_BYTES;
    const set = u32(rom, base + TEX_SET);
    const colors = u32(rom, base + COLOR_BLOCK);
    const t = rom.game.modelTable;
    const flags = u32(rom, base + FLAGS);
    const storm = !alt && flags & FLAG_ALT && u32(rom, SKY_FRAME_ROUTINE(n)) === STORM_SKY
        ? stormSchedule(rom) : null;
    const pieces = [
        ...(storm ? stormPieces(rom, base, ringSize, storm) : lookPieces(rom, base, ringSize, alt)),
        ...kindPieces(rom, rom.mainCpuView.getUint8(base + KIND)),
    ].filter(([m]) => m !== EMPTY && m < t.count);
    const draws = pieces.map(([model, layer, ops, anim]) => {
        const moved = raftMotion(flags, layer, ops);
        if (anim) anim.frames = anim.frames.map((m) => (m < t.count ? m : 0));
        return { model, pos: [0, 0, 0], set, layer, ...(moved ? { ops: moved } : {}), ...(anim ? { anim } : {}) };
    });
    const tint = [0, 1, 2].map((i) => rom.mainCpuView.getUint8(base + TINT + i) / UNIT_TINT);
    const light = stageLight(rom.mainCpuView.getFloat32(base + BRIGHT, true),
        rom.mainCpuView.getInt16(base + VECTER, true), rom.mainCpuView.getInt16(base + VECTER + 2, true));
    const flash = alt || storm ? stageLight(...FLASH_LIGHT) : null;
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
        /* The tile layer's panorama (js/scroll.js). */
        panorama: (cxlat) => vf2Panorama(rom, n, cxlat, storm),
        zones: [],
        views: [['all', 'Everything']],
        view: 'all',
        union: 'all',
        texSets: [set],
        texSet: [set, colors],
        tint,
        bright: 1,
        /* The second look is the flash's, so it stands in the flash's light. */
        light: alt ? flash : light,
        ...(storm ? { lightAt: (f) => (storm[f % ROUND_FRAMES] & STORM_ARENA ? flash : light) } : {}),
        materials: lit.materials,
        colorCycles: [],
        flags,
        floorSize: 0,
        meta: [['stage', n], ['texture set', set], ['colour block', colors],
            ['pieces', draws.length], ['flags', `0x${flags.toString(16)}`]],
    };
}

/* A stage's sky, and on the Colosseum the storm's: the sky at each frame's
 * channels, decoded the first time they come up. */
function vf2Panorama(rom, n, cxlat, storm) {
    const pano = buildVf2Sky(rom, n, cxlat);
    if (!pano || !storm) return pano;
    const skyBits = (STORM_ARENA - 1);
    pano.imageAt = (f) => storm[f % ROUND_FRAMES] & skyBits;
    pano.image = (bits) => (bits ? buildVf2StormSky(rom, n, cxlat, bits)?.rgba : pano.rgba);
    return pano;
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
