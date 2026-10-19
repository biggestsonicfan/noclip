/*
 * scroll.js — the board's 2D scroll layer, which is where one game keeps its sky.
 *
 * Sonic The Fighters draws its skies as ordinary models listed in the stage
 * record. Fighting Vipers has no sky geometry at all — no record carries a
 * shell, and nothing on any stage reaches high enough to stand in for one. Its
 * sky is a tilemap, and this decodes it.
 *
 * The chain, all of it per stage:
 *
 *   sub_29728          takes stage_num, indexes a 32-byte record, and hands the
 *                      number at its 0x0C to _Scroll_Initialize
 *   _Scroll_Initialize calls _ScrollCG_Initialize with that number for the tile
 *                      graphics, then _ScrollColor_Initialize with it plus one
 *                      for the palette — two entries of one pointer array
 *   sub_29728 again    walks eighteen patterns named by a second pointer at
 *                      0x14 and lays them side by side into a work buffer
 *
 * Eighteen patterns of 32 tiles each is 576 tiles across, and the tilemap the
 * hardware actually shows is 64 wide. So what is built is a panorama wider than
 * the screen, windowed by the scroll registers as the camera turns. That is why
 * it is decoded here as one wide strip and put on a cylinder rather than
 * blitted as a flat backdrop.
 *
 * Only sixteen of the eighteen are ever on screen. The routine that runs the
 * sky each frame (0x29A40, which ends by calling the stage's own routine out
 * of the record's 0x08) takes the camera's heading — 0x10000 to the turn —
 * scrolls the layer by `heading >> 4` (as `0 - (-heading >> 4)`) and
 * streams in column pair `-heading >> 8 & 0xFF` from the strip, so a full turn
 * is 4096 pixels, 512 tiles, sixteen patterns. Patterns 16 and 17 repeat 0 and 1 on every stage and
 * nothing reads them. Decoding all eighteen put a 64-tile seam into each turn
 * and squeezed the rest by an eighth.
 *
 * The same routine sets the vertical scroll to `list[2] - 480 * tan(pitch)`
 * (0x29AD8): list[2] is the second halfword of the stage's pattern list, and
 * 480 is the focal length the fight's camera is set to (0x501084, stored at
 * 0x1ED64) and the same one the 3D is projected with. MAME's segaic24 puts
 * tilemap row `screen y + scroll` on screen row y, and the 384-line view is
 * centred on row 192 (window_data_init's table at 0x5F5C), so level, the eye
 * line is panorama row 192 + list[2], and a row sits `focal` pixels per unit of
 * tangent from it. buildSkyPanorama hands the viewer both.
 *
 * The heading the routine scrolls by is not the camera's alone. It adds the
 * camera's Yang (+0x26) to sixteen times list[0] (0x503040, which sub_29728
 * copies from the list) and to 0x50A022, a turn of the whole arena that the 3D
 * takes too and the explorer has no need of. Screen column x then shows strip
 * column x - heading / 16: in a MAME run of the attract, the columns the board
 * shows matched the decoded strip at exactly that offset, unmirrored, on every
 * frame tried. So list[0] is each stage's turn of its sky against the arena,
 * up to half a turn (slot 2's 2059 is 181 degrees), and with the camera at
 * Yang 0 the centre of the 496-pixel picture is column 248 - list[0].
 *
 * The routine also clamps the pitch it scrolls by to list+0x4C and list+0x4E,
 * 45 degrees either way (43 up on four stages), so that the layer never scrolls
 * its 512-row tilemap round. Past it the board's sky stops following the
 * camera. That is a limit of a flat layer, and the cylinder has nothing to wrap,
 * so it is not copied: the explorer's sky stays on the horizon at any pitch.
 *
 * Formats, each read off the routine that walks it:
 *
 *   CG list      pairs of (source, destination) until the source is zero. A
 *                source is a count followed by that many 32-byte tiles, which
 *                is 8x8 at four bits a pixel. The tile chip is a 16-bit
 *                big-endian part (System 24's) on the i960's little-endian
 *                bus, so a halfword's left pixels are in its second byte:
 *                pixels 0 and 1 are byte 1's high and low nibble, 2 and 3
 *                byte 0's. Reading the bytes in address order swapped every
 *                pair of pixels, which combed Daytona's clouds and sea into
 *                vertical streaks and broke up Fighting Vipers' dithering.
 *   palette list blocks of (destination, halfword count, data) until the
 *                destination is zero.
 *   pattern      a header whose 0x04 is the row count, then rows of 32 tilemap
 *                entries on a 64-byte stride.
 *
 * A tilemap entry is read the way the System 24 tile chip reads one (MAME
 * segaic24 get_tile_info): the character is the low 14 bits, the palette group
 * is bits 7-14, and bit 15 is the category — behind the 3D when clear, in front
 * when set. The character and the group share bits 7-13, which is why no split
 * of the entry into separate fields worked. The game packs its characters so
 * that the overlap is the group it wants: the sky's start at 7680, which is
 * group 60, where each stage's palette list starts writing. `0x1080000 + char *
 * 32` is the pixels, and 0x1080000 is the address clr_first_group_cg clears.
 *
 * The group does change from tile to tile. On all sixteen stages every tile
 * names a group its palette list writes, and each list writes 19 to 67 of them.
 * Colouring the whole sky from the first group gets 6% to 80% of its pixels
 * wrong: slot 4's sunset breaks into banded clouds with black holes, and slot
 * 0's hills come out as a white stripe. Every sky tile is category 0, behind
 * the arena.
 */

import { xtraResolve, MAIN_DATA_BASE } from './romset.js';
import { palette555ToBytes } from './atlas.js';

const CHAR_BASE = 0x01080000;
const PAL_BASE = 0x01800000;
const CHAR_MASK = 0x3fff;       /* the character field of a tilemap entry */
const TILE_BYTES = 32;          /* 8x8 at 4bpp */
const PATTERN_TILES = 32;       /* tiles across one pattern */
const PATTERN_STRIDE = 64;      /* bytes per pattern row */
/* The patterns one turn reads; the list holds two more. See above. */
const TURN_PATTERNS = 16;
/* The pattern list: a heading offset, the vertical scroll at level, then the
 * pattern numbers. */
const LIST_HEADING = 0;
const LIST_SCROLL_Y = 2;
const LIST_PATTERNS = 4;
/* The fight camera's focal length and the view's centre row (see above). */
const FIGHT_FOCAL = 480;
const VIEW_CENTRE_ROW = 192;
const VIEW_CENTRE_COL = 248;

/* A pointer in this game lands either in the data region or in the mirror
 * window, and both appear in the same lists, so every read goes through here. */
function at(rom, addr) {
    if (addr >= 0x06000000 && addr < 0x07000000) {
        const r = xtraResolve(rom, addr);
        return { view: r.view, u8: r.data, off: r.off };
    }
    if (inProgram(rom, addr)) return { view: rom.mainCpuView, u8: rom.maincpu, off: addr - PROGRAM_ALIAS };
    if (inProgramLow(rom, addr)) return { view: rom.mainCpuView, u8: rom.maincpu, off: addr };
    return { view: rom.mainDataView, u8: rom.mainData, off: addr - MAIN_DATA_BASE };
}

function ptrOk(rom, addr) {
    if (addr >= 0x06000000 && addr < 0x07000000) return true;
    if (inProgram(rom, addr) || inProgramLow(rom, addr)) return true;
    const o = addr - MAIN_DATA_BASE;
    return o >= 0 && o < rom.mainData.length;
}

/* Daytona USA keeps a few of its lists in the program ROM, which its own
 * pointers name through the alias at 0x200000. */
const PROGRAM_ALIAS = 0x00200000;
const inProgram = (rom, addr) => addr >= PROGRAM_ALIAS && addr - PROGRAM_ALIAS < rom.maincpu.length;
/* Virtua Fighter 2 names them at their own addresses (js/games.js vf2.cells). */
const inProgramLow = (rom, addr) => rom.game.cells?.programAt0 && addr > 0 && addr < rom.maincpu.length;

/* For js/cells.js, which reads the same tables. */
export { at as scrollAt, ptrOk as scrollPtrOk, CHAR_MASK, TILE_BYTES };

/**
 * Decode the sky panorama for one stage.
 *
 * @param {object} rom    loaded ROM set
 * @param {number} slot   stage slot
 * @param {?Uint8Array} cxlat  the scene's colorxlat, which the palette goes
 *                         through as it does on the board; null for raw colour
 * @returns {null|{width:number, height:number, rgba:Uint8Array,
 *            horizon:number, focal:number, centre:number}}  horizon is the
 *            panorama row on the eye line, focal the pixels per unit of tangent
 *            up the strip, centre the column ahead of a camera at Yang 0
 */
export function buildSkyPanorama(rom, slot, cxlat = null) {
    const S = rom.game.stageTable.scroll;
    if (!S) return null;

    const rec = at(rom, S.records + slot * S.stride);
    const cg = rec.view.getUint32(rec.off + S.fields.cg, true);
    const listPtr = rec.view.getUint32(rec.off + S.fields.patterns, true);
    if (!ptrOk(rom, listPtr)) return null;

    /* _ScrollCG_Initialize and _ScrollColor_Initialize take two neighbouring
     * entries of one pointer array: the tile pixels and then the palette. */
    const word = (addr) => { const t = at(rom, addr); return t.view.getUint32(t.off, true); };
    const cgList = word(S.cgTable + cg * 4);
    const palList = word(S.cgTable + (cg + 1) * 4);

    /* The patterns one turn shows, by number through the pattern table. */
    const L = at(rom, listPtr);
    const patterns = [];
    for (let i = 0; i < TURN_PATTERNS; i++) {
        const p = L.view.getUint32(L.off + LIST_PATTERNS + i * 4, true);
        patterns.push(word(S.patternTable + p * 4));
    }
    const pano = decodePanorama(rom, cgList, palList, patterns, S.charBytes, cxlat);
    if (pano) {
        pano.horizon = VIEW_CENTRE_ROW + L.view.getInt16(L.off + LIST_SCROLL_Y, true);
        pano.focal = FIGHT_FOCAL;
        const turn = pano.width;
        pano.centre = ((VIEW_CENTRE_COL - L.view.getInt16(L.off + LIST_HEADING, true)) % turn + turn) % turn;
    }
    return pano;
}

/**
 * Daytona USA's sky for one course.
 *
 * The same tile chip and the same three formats, reached another way.
 * `change_course_bank` takes a row of a four-course table, `<table>[sel_course
 * * 4]`, and the first word of that row is the course's sky: the CG list, the
 * palette list, and eight patterns. The routine that runs the sky each frame
 * picks the pattern by `heading >> 13 & 7` and the column within it by
 * `heading >> 8 & 31`, and scrolls the layer by `heading >> 5` — so the eight
 * are 45 degrees each, 32 tiles to the pattern and 256 round the full turn,
 * streamed into the 64-tile tilemap a column at a time as the car turns.
 *
 * @param {object} rom     loaded ROM set
 * @param {number} course  sel_course
 * @param {?Uint8Array} cxlat  as for buildSkyPanorama
 */
export function buildCourseSky(rom, course, cxlat = null) {
    const T = rom.game.sky;
    if (!T) return null;
    const word = (addr) => {
        if (addr >= MAIN_DATA_BASE) {
            const o = addr - MAIN_DATA_BASE;
            return o >= 0 && o + 4 <= rom.mainData.length ? rom.mainDataView.getUint32(o, true) : 0;
        }
        const o = addr >= 0x00200000 ? addr - 0x00200000 : addr;
        return o >= 0 && o + 4 <= rom.maincpu.length ? rom.mainCpuView.getUint32(o, true) : 0;
    };
    const row = word(T.table + course * 4);
    const sky = row && word(row);
    if (!sky || !ptrOk(rom, sky)) return null;
    const patterns = [];
    for (let i = 0; i < DAYTONA_PATTERNS; i++) patterns.push(word(sky + 8 + i * 4));
    const pano = decodePanorama(rom, word(sky), word(sky + 4), patterns, DAYTONA_CHAR_BYTES, cxlat);
    if (pano) {
        pano.horizon = DAYTONA_LEVEL_ROW;
        pano.distance = DAYTONA_SKY_DISTANCE;
        /* Up at the drawing camera's focal, not one of its own. */
        pano.lensFocal = true;
        /* The heading here is the camera's own: 0x5FE11A is the Yang of
         * js/skyeye.js (0 down +Z, a quarter turn to -X at 0xC000), and in
         * MAME screen column x shows strip column x - heading / 32,
         * unmirrored, as Fighting Vipers' does at its own scale. */
        pano.centre = VIEW_CENTRE_COL;
    }
    return pano;
}

/*
 * Virtua Fighter 2's sky for one stage.
 *
 * The same tile chip and the same three formats as Fighting Vipers', a year
 * earlier and laid out more plainly. 0x24314 indexes a 32-byte record at
 * 0x2502C in the program ROM by stage_num << 5: +0x00 and +0x04 are the
 * stage's own routines for stage start and every frame (palette work), +0x08
 * the CG list, +0x0C the palette list, +0x10 the pattern list. The list is
 * not Fighting Vipers' either: a halfword row count, the vertical offset's
 * byte, then eighteen pointers straight at pattern rows with no header —
 * 0x24378 copies `rows` rows of 64 bytes from each.
 *
 * The per-frame routine (0x24534) is Fighting Vipers' 0x29A40 without the
 * arena turn: the same column streaming by `-Yang >> 8`, the same horizontal
 * scroll, so a turn is sixteen patterns and the column ahead at Yang 0 is
 * 248. Up, it takes no tangent. The vertical scroll is
 *
 *   V = 8 * list[2] - (pitch - 0x2E0) / 16
 *
 * linear in the pitch at the same sixteen units a pixel as the heading, so the
 * strip is one turn across at square pixels — the cylinder's own scale, and
 * no focal. The 3D's view is centred on row 192 as Fighting Vipers' is (the
 * window table at 0x7F64), so level, the eye line shows row 238 + 8 * list[2].
 * The 3D's focal is 600 (0x1D344) where the strip's is 652 pixels a radian,
 * so on the board the two part a little as the camera pitches: under four
 * rows at the fight camera's four degrees.
 *
 * Below the strip, 0x243E0 fills the tilemap's remaining rows with the start
 * of its last row, so the ground runs on in that row's colour.
 */
const VF2_SKY = { records: 0x2502c, stride: 32, frame: 0x04, cg: 0x08, pal: 0x0c, list: 0x10 };
const VF2_PITCH_ROWS = 0x2e0 >> 4;
const VF2_CHAR_BYTES = 0x80000;

/*
 * The per-frame routines that bend the sky.
 *
 * Three of them turn on the layer's line scroll (0x8000 to 0x100A004) and
 * write the line table at 0x1008800, one h-scroll a screen line, the base
 * scroll plus a shift. The table is indexed by screen line from the top
 * (MAME's segaic24.cpp), its entry for line l at (g6 + l), and the layer's
 * V is 8 * list[2] - g6, so line l shows the panorama's row 8 * list[2] + l
 * whatever the pitch: the bend belongs to the picture, not the screen. The
 * loops run l from -0x2E up.
 *
 *   0x24DBC (stages 10 and 11, the mirror stage) shifts every line by the
 *     s16 at 0x24E30[(frame + l + 0x2E) & 127]: two sines of ±4 pixels
 *     interleaved, so alternate lines sway a quarter turn apart and the whole
 *     picture ripples as if seen through water.
 *   0x24D8C (9, 12-14) and 0x24DA4 (7) call 0x24F90 with a band, lines
 *     [g1, 0xF0), shifted by the s8 at 0x25024[((frame >> 2) + l - g1) & 7]
 *     — the sea's shimmer, a few pixels, stepping every four frames.
 */
const VF2_WOBBLE = 0x24dbc;
const VF2_WOBBLE_TABLE = 0x24e30;
const VF2_WOBBLE_LEN = 128;
const VF2_BANDS = { 0x24d8c: 0x96, 0x24da4: 100 };
const VF2_BAND_END = 0xf0;
const VF2_BAND_TABLE = 0x25024;
const VF2_BAND_LEN = 8;
const VF2_BAND_SHIFT = 2;
const VF2_FIRST_LINE = -0x2e;

/* A function of the frame giving each panorama row's shift in pixels, right
 * positive; null for a stage whose sky holds still. */
function vf2LineShift(cpu, routine, top, rows) {
    const out = new Float32Array(rows);
    if (routine === VF2_WOBBLE) {
        const table = Array.from({ length: VF2_WOBBLE_LEN }, (_, i) => cpu.getInt16(VF2_WOBBLE_TABLE + i * 2, true));
        return (frame) => {
            for (let p = 0; p < rows; p++) {
                const l = p - top;
                out[p] = l < VF2_FIRST_LINE ? 0 : table[(frame + l - VF2_FIRST_LINE) & (VF2_WOBBLE_LEN - 1)];
            }
            return out;
        };
    }
    const g1 = VF2_BANDS[routine];
    if (g1 === undefined) return null;
    const table = Array.from({ length: VF2_BAND_LEN }, (_, i) => cpu.getInt8(VF2_BAND_TABLE + i));
    return (frame) => {
        for (let p = 0; p < rows; p++) {
            const l = p - top;
            out[p] = l >= g1 && l < VF2_BAND_END ? table[((frame >> VF2_BAND_SHIFT) + l - g1) & (VF2_BAND_LEN - 1)] : 0;
        }
        return out;
    };
}

/**
 * @param {object} rom   loaded ROM set
 * @param {number} num   stage_num, the stage record's index
 * @param {?Uint8Array} cxlat  as for buildSkyPanorama
 */
export function buildVf2Sky(rom, num, cxlat = null, patch = null) {
    const cpu = rom.mainCpuView;
    const rec = VF2_SKY.records + num * VF2_SKY.stride;
    const list = cpu.getUint32(rec + VF2_SKY.list, true);
    if (list + 4 + TURN_PATTERNS * 4 > rom.maincpu.length) return null;
    const rows = cpu.getUint16(list, true);
    const patterns = [];
    for (let i = 0; i < TURN_PATTERNS; i++) patterns.push(cpu.getUint32(list + 4 + i * 4, true));
    const pano = decodePanorama(rom, cpu.getUint32(rec + VF2_SKY.cg, true),
        cpu.getUint32(rec + VF2_SKY.pal, true), patterns, VF2_CHAR_BYTES, cxlat, rows, patch);
    if (pano) {
        pano.horizon = VIEW_CENTRE_ROW + VF2_PITCH_ROWS + 8 * cpu.getUint8(list + 2);
        pano.centre = VIEW_CENTRE_COL;
        pano.footColor = commonestColour(pano.rgba, (pano.height - 1) * pano.width, pano.width);
        pano.lineShift = vf2LineShift(cpu, cpu.getUint32(rec + VF2_SKY.frame, true),
            8 * cpu.getUint8(list + 2), pano.height);
    }
    return pano;
}

/*
 * The Colosseum's storm in its sky.
 *
 * The stage's per-frame routine, 0x2468C, runs four channels off the
 * timeline at 0x24D70 (js/vf2.js has the timing). Each turns a write on and
 * off; every off write puts back what the stage's own palette list and
 * pattern hold, so a channel's state is all there is to the picture.
 *
 *   0  flashes the cloud: groups 59-95 all take the sixteen colours at
 *      0x24C6C, and entries 1-4 of groups 100-111 and 112-117 four of them.
 *   1  lights the lower cloud: eleven entries of the same groups, from 5 and
 *      from 6, from 0x24CB6 and 0x24CF8.
 *   2  the bolt: eight 2x18-tile blocks (0x8F1C's format: a value added to
 *      every entry, a mode, the rows, the width) from 0x2AA8346, 0x54 bytes
 *      apart, over the stream's columns 24-31 from tile row 8. The routine
 *      writes a column only while it is in the tilemap; here it is always.
 *
 * Channel 3 is the arena's: the light and the second look (js/vf2.js).
 */
const VF2_STORM_PAL = [
    [[0x3b0, 37, 16, 0x24c6c], [0x641, 12, 4, 0x24c76], [0x701, 6, 4, 0x24c78]],
    [[0x645, 12, 11, 0x24cb6], [0x706, 6, 11, 0x24cf8]],
];
const VF2_BOLT = { data: 0x2aa8346, step: 0x54, columns: 8, col: 24, row: 8 };

function vf2StormPatch(rom, bits) {
    const cpu = rom.mainCpuView;
    const writes = VF2_STORM_PAL.flatMap((w, ch) => (bits & (1 << ch) ? w : []));
    const tiles = new Map();
    if (bits & 4) {
        for (let i = 0; i < VF2_BOLT.columns; i++) {
            const R = at(rom, VF2_BOLT.data + i * VF2_BOLT.step);
            const add = R.view.getInt16(R.off, true);
            const rows = R.view.getUint32(R.off + 4, true);
            const width = R.view.getUint32(R.off + 8, true);
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < width; x++) {
                    const v = R.view.getInt16(R.off + 12 + (y * width + x) * 2, true) + add;
                    tiles.set(((VF2_BOLT.row + y) << 16) | ((VF2_BOLT.col + i) * 2 + x), v & 0xffff);
                }
            }
        }
    }
    return {
        pal: (pal) => {
            for (const [first, groups, count, src] of writes) {
                for (let g = 0; g < groups; g++) {
                    for (let k = 0; k < count; k++) pal[first + g * 16 + k] = cpu.getUint16(src + k * 2, true);
                }
            }
        },
        tiles,
    };
}

/** The Colosseum's sky with storm channels `bits` (bit n for channel n) on. */
export function buildVf2StormSky(rom, num, cxlat, bits) {
    return buildVf2Sky(rom, num, cxlat, vf2StormPatch(rom, bits));
}

/*
 * Where the sky stands against the eye line.
 *
 * Like Fighting Vipers' strips, these carry what lies below the horizon too —
 * the grass round the Three-Seven Speedway, the sea off Seaside Street Galaxy,
 * a floor of cloud under Dinosaur Canyon — so the strip's foot is not the eye
 * line. camd_99, the tail every camera mode ends in (0x70C0-0x71C0 in Rev A),
 * sets the layer's Y scroll, and only from the camera:
 *
 *   A = atan2(eye height, 2048)                          TGP 0x0A
 *   a = view pitch, down positive, minus A               camera +0x52, +0x28
 *   V = cy + focal * sin a / cos a                       TGP 0x1B, 0x1C, 0x24-0x29, 0x25
 *
 * cy and focal are the view record's (0x501730, 0x501734), the same two the 3D
 * view takes: its centre is 320 + cy up the frame (the table at 0x17E68), and
 * with the vertical sync register at -2 that is screen line 192 - cy. The
 * streamer writes a panorama's first row into tilemap row 6, 48 pixels down,
 * so row p shows on line 48 + p - V. Put together, cy cancels, the pitch moves
 * the sky with the 3D at the focal's pixels per unit of tangent, and the row
 * on the eye line is 192 - 48 = 144 less focal * tan A. That is the sky as if
 * its row 144 stood on the ground 2048 units off: the camera rising looks down
 * on it. The board does this on every course; Seaside Street Galaxy paints its
 * sea line at row 185, so the sea sits that much below the eye line.
 */
const DAYTONA_LEVEL_ROW = VIEW_CENTRE_ROW - 48;
const DAYTONA_SKY_DISTANCE = 2048;
const DAYTONA_PATTERNS = 8;
/* The tile chip's character RAM, 0x1080000 to 0x10FFFFF. */
const DAYTONA_CHAR_BYTES = 0x80000;
/* Both lists end with a zero; this only stops a walk that misses it. Sonic
 * The Fighters' CG 0 has 35 tile entries, so it is not small. */
const MAX_LIST_ENTRIES = 256;

/*
 * Dead or Alive's sky for one stage.
 *
 * The same tile chip, with a format of Tecmo's own. Data 0xC0000 is a table
 * of 242 scroll pictures, three pointers each: the tiles, the palette and the
 * map. The tiles are chunks of a count and that many 32-byte tiles until a
 * count of 0; the game hands each chunk whole 128-tile blocks of character
 * RAM, and each chunk's 16 colours go to every block it took. The map is a
 * width and height, then entries whose low 13 bits are the picture's own
 * tile; the loader (0x9250) adds the slot's first block, so the group, bits
 * 7-14, is the block the tile landed in and so its chunk's colours.
 *
 * 0x6F558 builds the sky as the stage starts: four pictures, named by stage
 * in the table at program 0xC7660 (four halfwords a stage), each 64 tiles by
 * 48, laid side by side into a 2048-pixel ring. Stages 4, 5, 7 and 9 clear
 * the layer instead, and 6 and 12-15 fill it with one plain tile, so those
 * stand under the backdrop alone. In MAME the four go round in order: stage
 * 1's attract loads pictures 125-128.
 *
 * Each frame 0x6FE00 scrolls the layer by `yaw >> 5`, so a turn is the whole
 * ring and screen column x shows ring column x - (yaw >> 5) + 8: at yaw 0
 * the centre of the 496-pixel picture is column 256. Vertically it is linear
 * in the pitch, not its tangent (0x70090):
 *
 *   V = 200 * (pitch + 0xE39) / 0x238E,  held to 0..200
 *
 * 0x238E is 50 degrees of the 0x10000 turn, so the strip moves 229 rows a
 * radian, and level (pitch 0) is V = 80, which centres row 192 + 80 on the
 * eye line. Fitting the decoded ring to MAME frames of the attract at known
 * yaw and pitch put it at exactly those offsets. The palette is the raw
 * colour, as MAME shows it: no colorxlat.
 */
const DOA_PICTURES = 4;
const DOA_LEVEL_ROW = VIEW_CENTRE_ROW + 80;
const DOA_FOCAL = 200 / (0x238e / 0x10000 * 2 * Math.PI);
const DOA_CENTRE_COL = VIEW_CENTRE_COL + 8;
const DOA_BLOCK = 128;          /* tiles to a block of character RAM */
const DOA_TILE_MASK = 0x1fff;

/**
 * @param {object} rom    loaded ROM set
 * @param {number} stage  the stage number (0x5555BE)
 */
export function buildDoaSky(rom, stage) {
    const S = rom.game.doa?.sky;
    if (!S || S.skyless.includes(stage)) return null;
    const pictures = [];
    for (let k = 0; k < DOA_PICTURES; k++) {
        const pic = doaPicture(rom, S.pictures, rom.mainCpuView.getInt16(S.stages + stage * 8 + k * 2, true));
        if (!pic) return null;
        pictures.push(pic);
    }
    const width = pictures.reduce((w, p) => w + p.width, 0);
    const height = Math.max(...pictures.map((p) => p.height));
    const rgba = new Uint8Array(width * height * 4);
    let x0 = 0;
    for (const p of pictures) {
        for (let y = 0; y < p.height; y++) {
            rgba.set(p.rgba.subarray(y * p.width * 4, (y + 1) * p.width * 4), (y * width + x0) * 4);
        }
        x0 += p.width;
    }
    return {
        width, height, rgba, topColor: commonestColour(rgba, 0, width),
        horizon: DOA_LEVEL_ROW, focal: DOA_FOCAL, centre: DOA_CENTRE_COL,
    };
}

/* One scroll picture of the table at `table`, as RGBA. */
function doaPicture(rom, table, n) {
    const word = (addr) => { const t = at(rom, addr); return t.view.getUint32(t.off, true); };
    const [tiles, colours] = doaTiles(rom, word(table + n * 12), word(table + n * 12 + 4));
    const M = at(rom, word(table + n * 12 + 8));
    const w = M.view.getUint16(M.off, true);
    const h = M.view.getUint16(M.off + 2, true);
    const width = w * 8;
    const rgba = new Uint8Array(width * h * 8 * 4);
    for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
            const t = M.view.getUint16(M.off + 4 + (ty * w + tx) * 2, true) & DOA_TILE_MASK;
            const pal = colours[t >> 7];
            if (!pal || t >= tiles.length) continue;
            drawDoaTile(rgba, width, tx * 8, ty * 8, tiles[t], pal);
        }
    }
    return { width, height: h * 8, rgba };
}

/* The picture's tiles, as character RAM holds them from its first block, and
 * each block's 16 colours as [r, g, b]. */
function doaTiles(rom, tileList, palList) {
    const tiles = [];
    const colours = [];
    let t = at(rom, tileList);
    let p = at(rom, palList);
    for (let i = 0; i < MAX_LIST_ENTRIES; i++) {
        const count = t.view.getUint32(t.off, true);
        if (!count) break;
        const blocks = Math.ceil(count / DOA_BLOCK);
        for (let k = 0; k < count; k++) tiles.push(t.u8.subarray(t.off + 4 + k * TILE_BYTES, t.off + 4 + (k + 1) * TILE_BYTES));
        while (tiles.length < (colours.length + blocks) * DOA_BLOCK) tiles.push(null);
        const pal = [];
        for (let c = 0; c < 16; c++) pal.push(palette555ToBytes(null, p.view.getUint16(p.off + c * 2, true) & 0x7fff));
        for (let b = 0; b < blocks; b++) colours.push(pal);
        t = { ...t, off: t.off + 4 + count * TILE_BYTES };
        p = { ...p, off: p.off + 32 };
    }
    return [tiles, colours];
}

function drawDoaTile(rgba, width, x0, y0, tile, pal) {
    if (!tile) return;
    for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
            const byte = tile[py * 4 + ((px >> 1) ^ 1)];
            const [r, g, b] = pal[(px & 1) ? (byte & 15) : (byte >> 4)];
            const o = ((y0 + py) * width + x0 + px) * 4;
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
        }
    }
}

/**
 * What _ScrollCG_Initialize and _ScrollColor_Initialize leave in the tile
 * chip's character RAM and palette, starting from both clear.
 *
 * @returns {{chars: Uint8Array, pal: Uint16Array, written: number,
 *            charRuns: Array<[number, number]>, palRuns: Array<[number, number]>}}
 *   `charRuns` are the characters each source wrote, `palRuns` the palette
 *   entries, both as [first, count]; `written` is the palette entries in all.
 */
export function loadScrollCG(rom, cgList, palList, charBytes) {
    /* ---- the tile pixels ---- */
    const chars = new Uint8Array(charBytes);
    const charRuns = [];
    {
        let a = cgList, guard = 0;
        while (ptrOk(rom, a) && guard++ < MAX_LIST_ENTRIES) {
            const e = at(rom, a);
            const src = e.view.getUint32(e.off, true);
            if (!src || !ptrOk(rom, src)) break;
            const dst = e.view.getUint32(e.off + 4, true);
            const Sr = at(rom, src);
            const tiles = Sr.view.getUint32(Sr.off, true);
            const base = dst - CHAR_BASE;
            const n = tiles * TILE_BYTES;
            if (base >= 0 && base + n <= chars.length && Sr.off + 4 + n <= Sr.u8.length) {
                chars.set(Sr.u8.subarray(Sr.off + 4, Sr.off + 4 + n), base);
                charRuns.push([base / TILE_BYTES, tiles]);
            }
            a += 8;
        }
    }

    /* ---- the palette ---- */
    const pal = new Uint16Array(0x8000);
    const palRuns = [];
    let written = 0;
    {
        let a = palList, guard = 0;
        while (ptrOk(rom, a) && guard++ < MAX_LIST_ENTRIES) {
            const e = at(rom, a);
            const dest = e.view.getUint32(e.off, true);
            if (!dest) break;
            /* The count is halved into a dword count, so it is halfwords. */
            const words = e.view.getUint32(e.off + 4, true) >> 1;
            const first = (dest - PAL_BASE) >> 1;
            written += words;
            palRuns.push([first, words * 2]);
            for (let i = 0; i < words * 2; i++) {
                const d = first + i;
                if (d >= 0 && d < pal.length) pal[d] = e.view.getUint16(e.off + 8 + i * 2, true);
            }
            a += 8 + words * 4;
        }
    }
    return { chars, pal, written, charRuns, palRuns };
}

/*
 * The panorama from a CG list, a palette list and the patterns laid side by
 * side, each 32 tiles across.
 *
 * The tile chip does not show its palette entries as they are. palette_w
 * (MAME model2.cpp) puts each through colorxlat at luma 0x40 and the gamma
 * table, the same path a textured face takes at full brightness, so the sky's
 * colours are the scene's colour tables as much as its own. Shown raw,
 * Seaside Street Galaxy's sky is (0,74,165) where the board's is (0,108,181);
 * through the tables every sky pixel the overlay and the 3D leave uncovered in
 * a MAME snapshot of the attract race matches exactly.
 */
function decodePanorama(rom, cgList, palList, patternPtrs, charBytes, cxlat, fixedRows = 0, patch = null) {
    const { chars, pal, written } = loadScrollCG(rom, cgList, palList, charBytes);
    if (!written) return null;
    /* What a stage's own routine writes over the list's palette and tiles. */
    patch?.pal?.(pal);

    /* Each palette entry's colour, worked out the first time a pixel uses it. */
    const rgb = new Int32Array(0x8000).fill(-1);
    const colour = (v) => {
        if (rgb[v] < 0) {
            const [r, g, b] = palette555ToBytes(cxlat, v);
            rgb[v] = (r << 16) | (g << 8) | b;
        }
        return rgb[v];
    };

    /* ---- the patterns, side by side ---- */
    const { cols, rows } = patternColumns(rom, patternPtrs, fixedRows);
    if (!rows) return null;

    const width = cols.length * PATTERN_TILES * 8;
    const height = rows * 8;
    const rgba = new Uint8Array(width * height * 4);

    for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        if (!col) continue;
        for (let ty = 0; ty < col.h; ty++) {
            for (let tx = 0; tx < PATTERN_TILES; tx++) {
                const own = col.R.view.getUint16(
                    col.R.off + col.head + ty * PATTERN_STRIDE + tx * 2, true);
                const entry = patch?.tiles?.get((ty << 16) | (c * PATTERN_TILES + tx)) ?? own;
                const base = (entry & CHAR_MASK) * TILE_BYTES;
                const group = (entry >> 7) & 0xff;
                if (base + TILE_BYTES > chars.length) continue;
                for (let py = 0; py < 8; py++) {
                    for (let px = 0; px < 8; px++) {
                        const byte = chars[base + py * 4 + ((px >> 1) ^ 1)];
                        const nib = (px & 1) ? (byte & 15) : (byte >> 4);
                        const v = colour(pal[group * 16 + nib] & 0x7fff);
                        const x = (c * PATTERN_TILES + tx) * 8 + px;
                        const o = ((ty * 8 + py) * width + x) * 4;
                        rgba[o] = v >> 16;
                        rgba[o + 1] = (v >> 8) & 255;
                        rgba[o + 2] = v & 255;
                        rgba[o + 3] = 255;
                    }
                }
            }
        }
    }
    /*
     * What continues above the strip.
     *
     * The panorama is a band, not a dome: above its top row the hardware shows
     * the backdrop, and the two have to agree or there is a seam across the sky.
     * The commonest colour along the top row is what the sky is doing where it
     * runs out, so that is the backdrop this stage wants — and it is per stage,
     * which the boot-time constant is not.
     */
    return { width, height, rgba, topColor: commonestColour(rgba, 0, width) };
}

/* Each pattern's rows, or null where its pointer leads nowhere. A pattern with
 * no header of its own (Virtua Fighter 2's) takes its row count from the list
 * and starts at its first row. */
function patternColumns(rom, patternPtrs, fixedRows) {
    const cols = [];
    let rows = 0;
    for (const pr of patternPtrs) {
        if (!pr || !ptrOk(rom, pr)) { cols.push(null); continue; }
        const R = at(rom, pr);
        const h = fixedRows || R.view.getUint32(R.off + 4, true);
        if (h > 128) { cols.push(null); continue; }
        rows = Math.max(rows, h);
        cols.push({ R, h, head: fixedRows ? 0 : 0x0c });
    }
    return { cols, rows };
}

/* The commonest colour of `count` pixels from pixel `first`, as [r, g, b]. */
function commonestColour(rgba, first, count) {
    const counts = new Map();
    for (let x = first; x < first + count; x++) {
        const o = x * 4;
        const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let top = 0, best = -1;
    for (const [k, n] of counts) if (n > best) { best = n; top = k; }
    return [(top >> 16) & 255, (top >> 8) & 255, top & 255];
}
