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
 * scrolls the layer by `-heading >> 4` and streams in column pair
 * `-heading >> 8 & 0xFF` from the strip, so a full turn is 4096 pixels, 512
 * tiles, sixteen patterns. Patterns 16 and 17 repeat 0 and 1 on every stage and
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
const LIST_SCROLL_Y = 2;
const LIST_PATTERNS = 4;
/* The fight camera's focal length and the view's centre row (see above). */
const FIGHT_FOCAL = 480;
const VIEW_CENTRE_ROW = 192;

/* A pointer in this game lands either in the data region or in the mirror
 * window, and both appear in the same lists, so every read goes through here. */
function at(rom, addr) {
    if (addr >= 0x06000000 && addr < 0x07000000) {
        const r = xtraResolve(rom, addr);
        return { view: r.view, u8: r.data, off: r.off };
    }
    return { view: rom.mainDataView, u8: rom.mainData, off: addr - MAIN_DATA_BASE };
}

function ptrOk(rom, addr) {
    if (addr >= 0x06000000 && addr < 0x07000000) return true;
    const o = addr - MAIN_DATA_BASE;
    return o >= 0 && o < rom.mainData.length;
}

/**
 * Decode the sky panorama for one stage.
 *
 * @param {object} rom    loaded ROM set
 * @param {number} slot   stage slot
 * @param {?Uint8Array} cxlat  the scene's colorxlat, which the palette goes
 *                         through as it does on the board; null for raw colour
 * @returns {null|{width:number, height:number, rgba:Uint8Array,
 *            horizon:number, focal:number}}  horizon is the panorama row on
 *            the eye line, focal the pixels per unit of tangent up the strip
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
    }
    return pano;
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
function decodePanorama(rom, cgList, palList, patternPtrs, charBytes, cxlat) {
    /* ---- the tile pixels ---- */
    const chars = new Uint8Array(charBytes);
    {
        let a = cgList, guard = 0;
        while (ptrOk(rom, a) && guard++ < 32) {
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
            }
            a += 8;
        }
    }

    /* ---- the palette ---- */
    const pal = new Uint16Array(0x8000);
    let written = 0;
    {
        let a = palList, guard = 0;
        while (ptrOk(rom, a) && guard++ < 32) {
            const e = at(rom, a);
            const dest = e.view.getUint32(e.off, true);
            if (!dest) break;
            /* The count is halved into a dword count, so it is halfwords. */
            const words = e.view.getUint32(e.off + 4, true) >> 1;
            const first = (dest - PAL_BASE) >> 1;
            written += words;
            for (let i = 0; i < words * 2; i++) {
                const d = first + i;
                if (d >= 0 && d < pal.length) pal[d] = e.view.getUint16(e.off + 8 + i * 2, true);
            }
            a += 8 + words * 4;
        }
    }
    if (!written) return null;

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
    const cols = [];
    let rows = 0;
    for (const pr of patternPtrs) {
        if (!pr || !ptrOk(rom, pr)) { cols.push(null); continue; }
        const R = at(rom, pr);
        const h = R.view.getUint32(R.off + 4, true);
        if (h > 128) { cols.push(null); continue; }
        rows = Math.max(rows, h);
        cols.push({ R, h });
    }
    if (!rows) return null;

    const width = cols.length * PATTERN_TILES * 8;
    const height = rows * 8;
    const rgba = new Uint8Array(width * height * 4);

    for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        if (!col) continue;
        for (let ty = 0; ty < col.h; ty++) {
            for (let tx = 0; tx < PATTERN_TILES; tx++) {
                const entry = col.R.view.getUint16(
                    col.R.off + 0x0c + ty * PATTERN_STRIDE + tx * 2, true);
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
    const counts = new Map();
    for (let x = 0; x < width; x++) {
        const o = x * 4;
        const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let top = 0, best = -1;
    for (const [k, n] of counts) if (n > best) { best = n; top = k; }

    return {
        width, height, rgba,
        topColor: [(top >> 16) & 255, (top >> 8) & 255, top & 255],
    };
}
