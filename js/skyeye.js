/*
 * skyeye.js — the explorer's camera as the game's own camera, and back.
 *
 * Sonic the Fighters has a debug menu, and one of its pages is SKY EYE
 * (DEBUG_SKY_EYE, 0x4A0A4): it stops camera_work (debug_flag bit 5) and lets
 * the pad fly the game's camera record, fa_camera, by hand. The record is
 *
 *   +0x18 / +0x1C / +0x20   Xpos, Ypos, Zpos   float, board units
 *   +0x24 / +0x26 / +0x28   Xang, Yang, Zang   int16, 0x10000 a turn
 *
 * and camera_control (0x1F62C) builds the view from it with the coprocessor's
 * ang_z(-Zang), ang_x(-Xang), ang_y(-Yang) and then trans(-pos): a camera at
 * pos, pitched by Xang and turned by Yang. Nothing else goes into the view, so
 * these five numbers put the board's camera anywhere — and m2-hle2's SKY EYE
 * mode takes exactly them, from the link this module writes.
 *
 * The explorer stands its scene in the decoder's frame, which is the board's
 * with Z negated, under `root` — the identity, or on a stage that flies, the
 * inverse of the world prologue (app.js, setWorldFrame). The board's camera is
 * in the arena's frame, so it is read through the root's inverse, as the
 * `live` draws read it (app.js, liveCamera). The direction is the one
 * m2-hle2's grade-carpet places the explorer at from MAME's camera record, and
 * registers there against MAME's pictures:
 *
 *   forward = (-sin Yang cos Xang, sin Xang, cos Yang cos Xang)   (board frame)
 *
 * so Xang > 0 looks up, and Yang = 0 looks down +Z. The board does not roll the
 * fight camera and the explorer's rigs cannot, so Zang is always 0.
 *
 * The board's lens is not the explorer's: camera_init gives the GEO a focal
 * length of 280 (focus_dist, 0x501084) on a 496x384 picture, a vertical field
 * of view of 68.9 degrees. A picture meant to be laid over the board's wants the
 * explorer's camera at that.
 */

import * as THREE from 'three';

/** A turn, in the board's angle units. */
const TURN = 0x10000;

/** The board's picture and the focal length camera_init gives the GEO. */
export const BOARD_W = 496;
export const BOARD_H = 384;
export const BOARD_FOCAL = 280;
export const BOARD_FOV = (2 * Math.atan(BOARD_H / 2 / BOARD_FOCAL) * 180) / Math.PI;

const INV = new THREE.Matrix4();
const POS = new THREE.Vector3();
const FWD = new THREE.Vector3();

/** Radians to a board angle, as the int16 the record holds. */
export function boardAngle(rad) {
    const a = Math.round((rad / (2 * Math.PI)) * TURN) & 0xffff;
    return a >= 0x8000 ? a - TURN : a;
}

/** A board angle (any integer) to radians. */
export const angleRad = (a) => (((a << 16) >> 16) / TURN) * 2 * Math.PI;

/**
 * Where the game's camera would have to be to see what the explorer's sees:
 * { pos: [x, y, z], xang, yang, zang } in the board's frame and units.
 */
export function boardCamera(camera, root) {
    camera.updateMatrixWorld();
    root.updateMatrixWorld();
    INV.copy(root.matrixWorld).invert();
    POS.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(INV);
    camera.getWorldDirection(FWD).transformDirection(INV);
    /* Back into the board's frame: the decoder negated Z on the way in. */
    const fx = FWD.x, fy = FWD.y, fz = -FWD.z;
    return {
        pos: [POS.x, POS.y, -POS.z],
        xang: boardAngle(Math.atan2(fy, Math.hypot(fx, fz))),
        yang: boardAngle(Math.atan2(-fx, fz)),
        zang: 0,
    };
}

/**
 * The other way: stand the explorer's camera where a board camera record puts
 * it. Returns the explorer-frame eye and a point one unit ahead of it, for a
 * caller that also has an orbit target or a fly rig to keep in step.
 */
export function placeFromBoard(camera, root, { pos, xang, yang }) {
    const p = angleRad(xang), y = angleRad(yang);
    const ahead = [-Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
    root.updateMatrixWorld();
    const eye = new THREE.Vector3(pos[0], pos[1], -pos[2]).applyMatrix4(root.matrixWorld);
    const at = new THREE.Vector3(pos[0] + ahead[0], pos[1] + ahead[1], -(pos[2] + ahead[2]))
        .applyMatrix4(root.matrixWorld);
    camera.position.copy(eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(at);
    return { eye, at };
}

const hex16 = (a) => '0x' + (a & 0xffff).toString(16).toUpperCase().padStart(4, '0');
const deg = (a) => `${((((a << 16) >> 16) * 360) / TURN).toFixed(1)}°`;

/**
 * The record as the debug menu's pages show it: the stage as CAMERA_POSITION 2
 * numbers it (stage_num + 1), the position in board units, the angles as the
 * int16 SKY EYE edits and in degrees.
 */
export function describeBoardCamera(cam, stage) {
    const p = cam.pos.map((v) => v.toFixed(3).padStart(9));
    return [
        `STAGE NUMBER ${stage + 1}  (stage_num ${stage})`,
        `Xpos ${p[0]}  Ypos ${p[1]}  Zpos ${p[2]}`,
        `Xang ${hex16(cam.xang)} ${deg(cam.xang).padStart(7)}  ` +
            `Yang ${hex16(cam.yang)} ${deg(cam.yang).padStart(7)}`,
    ].join('\n');
}

/** The link fields: `eye=x,y,z` and `ang=xang,yang,zang`, angles as signed ints. */
export function boardCameraParams(cam) {
    return {
        eye: cam.pos.map((v) => Number(v.toFixed(4))).join(','),
        ang: `${cam.xang},${cam.yang},${cam.zang}`,
    };
}

/** The board camera a link carries, or null. */
export function readBoardCameraParams(p) {
    const eye = (p.get('eye') ?? '').split(',').map(Number);
    const ang = (p.get('ang') ?? '').split(',').map(Number);
    if (eye.length !== 3 || !eye.every(Number.isFinite)) return null;
    if (ang.length < 2 || !ang.every(Number.isInteger)) return null;
    return { pos: eye, xang: ang[0], yang: ang[1], zang: ang[2] ?? 0 };
}
