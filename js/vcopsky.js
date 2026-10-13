/*
 * vcopsky.js — Virtua Cop's sky, which is the tile chip's layer 1 and not
 * geometry.
 *
 * Every stage start fills both halves of layer 1 (1s and 1w, 64x64 tiles each)
 * with one tile, the stage's entry of the halfword table 0x28149B0 (0x6CD0).
 * Then 0x6C10 blits images into them with 0x55A0. An image is two halfwords,
 * width and height in tiles, then its tilemap entries row by row, and 0x55A0
 * puts row r at the destination plus r * 0x80, the tilemap's own stride:
 *
 *   0x2803790, 32x30   to 1s at row 34, columns 0 and 32: the sky, which pales
 *                      to the horizon at the layer's foot
 *   0x2802F00, 32x34   to 1w at row 0, columns 0 and 32: the sea, on stages 1
 *                      and 4 only (the table's fourth entry is the first
 *                      stage again); the others keep the fill
 *
 * and queues the stage's sixteen colours from 0x2814990[stage] for palette
 * group 0x10, the group the sky's tiles name. The rest of the palette is
 * the boot's (0x4B10): from 0x2801C00, a run count and sixteen colours, that
 * group repeated count times, from group 1 on, 0x7F groups in all. The tiles'
 * pixels are 0x2400000 on, which the boot (0x4A38) copies into character RAM
 * from character 0x80, swapping each halfword's bytes.
 *
 * Every frame, 0x5790 scrolls the layer from the camera's turns at 0x50F450:
 *
 *   hscroll = heading * -0x600 >> 15 & 0x3FF     (0 within 0xFE of ahead)
 *   vscroll = 0x140 + (pitch * -0x1E00 >> 15),   clamped to 0..0x140
 *
 * and sets the layer's split mode (bit 13 of its control word). MAME's
 * segaic24 then shows 1s above line (-vscroll) & 0x1FF and 1w below it, and
 * row y + vscroll of each on line y. Level, that is line 192, the middle of the
 * 384-line picture: 1s's last row sits on the eye line and 1w's first just
 * under it. So the panorama is 1s with 1w beneath, the eye line between.
 *
 * Across, the layer scrolls by -hscroll, so screen column x shows layer column
 * x + heading * 3072 / 0x10000. A turn is 3072 pixels, six of the 512-pixel
 * layer, and the heading turns the same way as the explorer's yaw (a MAME run
 * at two frames: 0x7F8C against 179.4 degrees, 0x8215 against -177.1). With
 * the camera dead ahead the middle of the 496-pixel picture is column 248.
 */

import { MAIN_DATA_BASE } from './romset.js';
import { palette555ToBytes } from './atlas.js';

const FILL_TABLE = 0x28149b0;
const SKY_IMAGE = 0x2803790;
const SKY_ROW = 34;
const SEA_IMAGE = 0x2802f00;
const SEA_STAGES = [0, 3];
const STAGE_COLOURS = 0x2814990;
const STAGE_GROUP = 0x10;
const BOOT_PALETTE = 0x2801c00;
const BOOT_GROUPS = 0x7f;
const CHAR_ROM = 0x2400000;
const CHAR_FIRST = 0x80;

const LAYER_TILES = 64;
const TILE_BYTES = 32;
/* Of 1w, only what can come up under the eye line: 192 lines at level, and
 * the board never scrolls the layer further up than level. */
const SEA_ROWS = 32;
const TURN_LAYERS = 6;
const VIEW_CENTRE_COL = 248;
const CHAR_MASK = 0x3fff;
/* The 3D's focal in pixels, as 0x1CE30 works it out for the GEO's focal
 * command each frame: 248 / tan(fov / 2), half the 496-pixel width over the
 * field of view across at 0x50F3F4. That rests at 30 degrees (0x1CD0C, and
 * 0x10700 sets the same 925.5 outright), which a MAME run of the attract
 * holds from frame 240 on except while the demo zooms onto a target. */
const BOARD_FOV = 30;
const BOARD_FOCAL = VIEW_CENTRE_COL / Math.tan((BOARD_FOV / 2) * (Math.PI / 180));

function u16(rom, addr) {
    const o = addr - MAIN_DATA_BASE;
    return o >= 0 && o + 2 <= rom.mainData.length ? rom.mainDataView.getUint16(o, true) : 0;
}

function u32(rom, addr) {
    const o = addr - MAIN_DATA_BASE;
    return o >= 0 && o + 4 <= rom.mainData.length ? rom.mainDataView.getUint32(o, true) : 0;
}

/* 0x55A0: an image into a 64-wide tilemap at (row, col). */
function blit(rom, map, image, row, col) {
    const w = u16(rom, image), h = u16(rom, image + 2);
    for (let y = 0; y < h && row + y < LAYER_TILES; y++) {
        for (let x = 0; x < w && col + x < LAYER_TILES; x++) {
            map[(row + y) * LAYER_TILES + col + x] = u16(rom, image + 4 + (y * w + x) * 2);
        }
    }
}

/* Layers 1s and 1w as the stage start leaves them. */
function stageLayers(rom, stage) {
    const fill = u16(rom, FILL_TABLE + stage * 2);
    const sky = new Uint16Array(LAYER_TILES * LAYER_TILES).fill(fill);
    const sea = new Uint16Array(LAYER_TILES * LAYER_TILES).fill(fill);
    for (const col of [0, 32]) {
        blit(rom, sky, SKY_IMAGE, SKY_ROW, col);
        if (SEA_STAGES.includes(stage)) blit(rom, sea, SEA_IMAGE, 0, col);
    }
    return { sky, sea };
}

/* The tile palette: the boot's groups, then the stage's own group 0x10. */
function stagePalette(rom, stage) {
    const pal = new Uint16Array(0x100 * 16);
    let src = BOOT_PALETTE, group = 1;
    for (let left = BOOT_GROUPS; left >= 0;) {
        const count = u16(rom, src);
        for (let n = 0; n < count && group < 0x100; n++, group++) {
            for (let i = 0; i < 16; i++) pal[group * 16 + i] = u16(rom, src + 2 + i * 2);
        }
        src += 34;
        left -= count;
        if (!count) break;
    }
    const own = u32(rom, STAGE_COLOURS + stage * 4);
    for (let i = 0; i < 16; i++) pal[STAGE_GROUP * 16 + i] = u16(rom, own + i * 2);
    return pal;
}

/* A character's pixel: the ROM holds each halfword byte-swapped from the
 * chip's RAM, and the RAM a halfword's left pixels in its second byte, so the
 * two swaps cancel and the ROM reads left to right. */
function pixel(rom, char, px, py) {
    const o = CHAR_ROM - MAIN_DATA_BASE + (char - CHAR_FIRST) * TILE_BYTES + py * 4 + (px >> 1);
    if (char < CHAR_FIRST || o >= rom.mainData.length) return 0;
    const b = rom.mainData[o];
    return px & 1 ? b & 15 : b >> 4;
}

/* Paint `rows` tile rows of a layer into the strip from tile row `y0` down,
 * once per layer width across the turn. */
function paintLayer(rom, out, map, rows, y0, colour) {
    const width = LAYER_TILES * 8 * TURN_LAYERS;
    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < LAYER_TILES; tx++) {
            const entry = map[ty * LAYER_TILES + tx];
            const group = (entry >> 7) & 0xff;
            for (let py = 0; py < 8; py++) {
                for (let px = 0; px < 8; px++) {
                    const v = colour(group * 16 + pixel(rom, entry & CHAR_MASK, px, py));
                    for (let k = 0; k < TURN_LAYERS; k++) {
                        const x = k * LAYER_TILES * 8 + tx * 8 + px;
                        out.set(v, (((y0 + ty) * 8 + py) * width + x) * 4);
                    }
                }
            }
        }
    }
}

/* The mean colour of a run of pixels. */
function meanColour(px) {
    const sum = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += px[i + k];
    return sum.map((v) => Math.round((v * 4) / px.length));
}

/**
 * The sky panorama of one stage: layer 1s over the first rows of 1w, one turn
 * across.
 *
 * @param {object} rom loaded ROM set
 * @param {number} stage the stage number the board keeps at 0x50F2A8
 * @param {?Uint8Array} cxlat the scene's colour tables, as for js/scroll.js
 * @returns {object} what app.js addSkyPanorama takes
 */
export function buildVcopSky(rom, stage, cxlat = null) {
    const { sky, sea } = stageLayers(rom, stage);
    const pal = stagePalette(rom, stage);
    const cache = new Map();
    const colour = (pen) => {
        if (!cache.has(pen)) cache.set(pen, [...palette555ToBytes(cxlat, pal[pen] & 0x7fff), 255]);
        return cache.get(pen);
    };
    const width = LAYER_TILES * 8 * TURN_LAYERS;
    const height = (LAYER_TILES + SEA_ROWS) * 8;
    const rgba = new Uint8Array(width * height * 4);
    paintLayer(rom, rgba, sky, LAYER_TILES, 0, colour);
    paintLayer(rom, rgba, sea, SEA_ROWS, LAYER_TILES, colour);
    return {
        width, height, rgba,
        horizon: LAYER_TILES * 8,
        /* Up at the board's focal: the layer is in screen space, a line a
         * row, with the eye line where the 3D's is. The lens the 3D has at
         * rest; the layer's scroll doesn't follow the zoom. */
        focal: BOARD_FOCAL,
        centre: VIEW_CENTRE_COL,
        topColor: Array.from(rgba.subarray(0, 3)),
        /* What the sea's last tile row comes to, for below it. */
        footColor: meanColour(rgba.subarray((height - 8) * width * 4)),
    };
}
