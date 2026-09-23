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
 * hardware actually shows is 64 wide. So what is built is a panorama nine times
 * wider than the screen, windowed by the scroll registers as the camera turns:
 * 576 tiles to the full turn, 64 of them in view, which is the board's own
 * horizontal field. That is why it is decoded here as one wide strip and put on
 * a cylinder rather than blitted as a flat backdrop.
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

import { xtraResolve } from './romset.js';
import { palette555ToBytes } from './atlas.js';

const CHAR_BASE = 0x01080000;
const PAL_BASE = 0x01800000;
const CHAR_MASK = 0x3fff;       /* the character field of a tilemap entry */
const TILE_BYTES = 32;          /* 8x8 at 4bpp */
const PATTERN_TILES = 32;       /* tiles across one pattern */
const PATTERN_STRIDE = 64;      /* bytes per pattern row */
const PATTERNS = 18;

/* A pointer in this game lands either in the data region or in the mirror
 * window, and both appear in the same lists, so every read goes through here. */
function at(rom, addr) {
    if (addr >= 0x06000000 && addr < 0x07000000) {
        const r = xtraResolve(rom, addr);
        return { view: r.view, u8: r.data, off: r.off };
    }
    return { view: rom.mainDataView, u8: rom.mainData, off: addr - 0x02000000 };
}

function ptrOk(rom, addr) {
    if (addr >= 0x06000000 && addr < 0x07000000) return true;
    const o = addr - 0x02000000;
    return o >= 0 && o < rom.mainData.length;
}

/**
 * Decode the sky panorama for one stage.
 *
 * @param {object} rom    loaded ROM set
 * @param {number} slot   stage slot
 * @param {?Uint8Array} cxlat  the scene's colorxlat, which the palette goes
 *                         through as it does on the board; null for raw colour
 * @returns {null|{width:number, height:number, rgba:Uint8Array}}
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

    /* The eighteen patterns, by number through the pattern table. */
    const L = at(rom, listPtr);
    const patterns = [];
    for (let i = 0; i < PATTERNS; i++) {
        const p = L.view.getUint32(L.off + 4 + i * 4, true);
        patterns.push(word(S.patternTable + p * 4));
    }
    return decodePanorama(rom, cgList, palList, patterns, S.charBytes, cxlat);
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
        if (addr >= 0x02000000) {
            const o = addr - 0x02000000;
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
    if (pano) pano.horizon = DAYTONA_HORIZON_ROW;
    return pano;
}

/*
 * The panorama row that sits on the eye line.
 *
 * Unlike Fighting Vipers' strips, which end at the horizon, these carry what
 * lies below it too — the grass round the Three-Seven Speedway, the sea off
 * Seaside Street Galaxy, a floor of cloud under Dinosaur Canyon — so the
 * strip's foot is not the eye line. Which row is comes out of two things the
 * board does the same way on every course: the streamer writes a panorama's
 * first row into tilemap row 6, 48 pixels down, and camd_99 sets the layer's Y
 * scroll from nothing but the camera — its height and pitch and the view
 * record — through TGP functions that are not ported. Level, that scroll
 * hovers round zero (MAME, the attract race), which puts tilemap pixel 192,
 * the middle of the 384-line screen, on the eye line: panorama row 144,
 * eighteen tiles down. It is where the Speedway and the Canyon paint their
 * horizons; Seaside Street Galaxy paints its sea line at row 185, and on the
 * board it sits that much below the eye line, as it does here.
 */
const DAYTONA_HORIZON_ROW = 144;
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
