/*
 * vstriker.js — Virtua Striker's stadium.
 *
 * The game has one ground, and its match draw places it with code rather than
 * a table: Rev A's 0x64D00 calls 0x64D10 and 0x65070 each frame. 0x64D10 takes
 * the camera's matrix back from the copro (0x80AC, then function 0x11 and the
 * geometrizer's 0xB0B), draws the pitch 0x148 and its markings 0x151 under it,
 * and the backdrop 0x5F6 in a window of its own (0x303). 0x65070 draws the
 * stands a side at a time: the copro turns the camera's matrix by the side's
 * quarter turn (function 0x15) and 0x65C00's jump table picks the side's
 * models — 0x5FB, 0x5FC and 0x162 on one long side, 0x5FD and 0x5FE on the
 * other, 0x5F4 and 0x5F5 behind each goal. The two goals follow (0x65D00,
 * ±52.38 along the pitch, the frame 0x14F, its other half 0x29B mirrored,
 * the net 0x150 and its back 0x164). Flags 0x52CD88..0x52CD8D say which
 * sides the camera can see; a side it can't is not drawn.
 *
 * The copro builds those matrices from the commands; nothing in the explorer
 * runs that program (js/doa.js's Copro speaks Model 2A's), so the pieces' turns
 * and places below are the ones the copro sent, taken from MAME's geometrizer
 * stream over 1200 frames of the attract match and taken back to the pitch's
 * frame through the camera matrix 0x148 is drawn under. All of them come out
 * as quarter turns and mirrors, and each was drawn at the same place in every
 * frame that drew it.
 */

import { gameLighting } from './stages.js';

/* Each piece: model, its place on the board (metres, the pitch's centre at
 * 0) and its matrix by columns (X's image first), in the TGP's frame. */
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const TURN_LEFT = [0, 0, -1, 0, 1, 0, 1, 0, 0];
const TURN_RIGHT = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const HALF_TURN = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
const MIRROR_X = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const GOAL = 52.38;

const PIECES = [
    /* 0x64D10: under the camera alone. */
    [0x148, 'pitch', [0, 0, 0], I],
    [0x151, 'pitch', [0, 0, 0], I],
    [0x5f6, 'backdrop', [0, 0, 0], I],
    /* 0x65070, 0x65C00: the four sides. */
    [0x5fb, 'stands', [0, 0, 0], TURN_RIGHT],
    [0x5fc, 'stands', [0, 0, 0], TURN_RIGHT],
    [0x162, 'stands', [0, 0, 0], TURN_RIGHT],
    [0x5fd, 'stands', [0, 0, 0], TURN_RIGHT],
    [0x5fe, 'stands', [0, 0, 0], TURN_RIGHT],
    [0x5f4, 'stands', [0, 0, 0], TURN_LEFT],
    [0x5f5, 'stands', [0, 0, 0], TURN_LEFT],
    [0x5f4, 'stands', [0, 0, 0], TURN_RIGHT],
    [0x5f5, 'stands', [0, 0, 0], TURN_RIGHT],
    /* 0x65D00: the goals. */
    [0x14f, 'goals', [0, 0, GOAL], I],
    [0x29b, 'goals', [0, 0, GOAL], MIRROR_X],
    [0x150, 'goals', [0, 0, GOAL], I],
    [0x164, 'goals', [0, 0, GOAL], MIRROR_X],
    [0x14f, 'goals', [0, 0, -GOAL], HALF_TURN],
    [0x29b, 'goals', [0, 0, -GOAL], HALF_TURN],
    [0x150, 'goals', [0, 0, -GOAL], HALF_TURN],
    [0x164, 'goals', [0, 0, -GOAL], HALF_TURN],
];

/* The attract match's camera at frame 3000 (MAME), pitch frame, explorer z. */
const MATCH_CAMERA = { eye: [-14.0, 0.7, -17.0], at: [-2.79, 0.7, -0.43] };

/* The TGP's frame against the viewer's: Z mirrored, on the place and on both
 * sides of the matrix. */
function pieceOps([, , pos, m]) {
    const cols = [m[0], m[1], -m[2], m[3], m[4], -m[5], -m[6], -m[7], m[8]];
    return [['t', [pos[0], pos[1], -pos[2]]], ['m', cols]];
}

/**
 * Virtua Striker's one stadium.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stage objects in the shape the viewer's stage list takes
 */
export function readVstrikerStages(rom) {
    const lit = gameLighting(rom);
    const count = rom.game.modelTable.count;
    const draws = PIECES.filter(([model]) => model < count).map((p) => ({
        model: p[0], pos: [p[2][0], p[2][1], -p[2][2]], set: 0, ops: pieceOps(p),
    }));
    return [{
        slot: 0,
        placements: true,
        mixedSets: false,
        num: 1,
        name: 'The stadium',
        chapter: 0,
        draws,
        objects: [],
        sky: null,
        zones: [],
        cameras: { all: MATCH_CAMERA },
        views: [['all', 'The whole ground']],
        view: 'all',
        union: 'all',
        texSets: [0],
        texSet: [0, 0],
        tint: [1, 1, 1],
        bright: 1,
        light: lit.light,
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['pieces', draws.length], ['goal line', `±${GOAL} m`]],
    }];
}
