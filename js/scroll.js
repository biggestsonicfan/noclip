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
 *                is 8x8 at four bits a pixel.
 *   palette list blocks of (destination, halfword count, data) until the
 *                destination is zero.
 *   pattern      a header whose 0x04 is the row count, then rows of 32 tilemap
 *                entries on a 64-byte stride.
 *
 * A tilemap entry is the character number whole: `0x1080000 + entry * 32` is
 * its pixels, and 0x1080000 is the address clr_first_group_cg clears. There is
 * no palette field in an entry — the layer takes one 16-colour group, and the
 * group the sky uses is the first the palette list writes.
 */

import { xtraResolve } from './romset.js';

const CHAR_BASE = 0x01080000;
const PAL_BASE = 0x01800000;
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
 * @returns {null|{width:number, height:number, rgba:Uint8Array}}
 */
export function buildSkyPanorama(rom, slot) {
    const S = rom.game.stageTable.scroll;
    if (!S) return null;

    const rec = at(rom, S.records + slot * S.stride);
    const cg = rec.view.getUint32(rec.off + S.fields.cg, true);
    const listPtr = rec.view.getUint32(rec.off + S.fields.patterns, true);
    if (!ptrOk(rom, listPtr)) return null;

    /* ---- _ScrollCG_Initialize: the tile pixels ---- */
    const chars = new Uint8Array(S.charBytes);
    {
        const t = at(rom, S.cgTable + cg * 4);
        let a = t.view.getUint32(t.off, true), guard = 0;
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

    /* ---- _ScrollColor_Initialize: the palette, and where it starts ---- */
    const pal = new Uint16Array(0x8000);
    let group = -1;
    {
        const t = at(rom, S.cgTable + (cg + 1) * 4);
        let a = t.view.getUint32(t.off, true), guard = 0;
        while (ptrOk(rom, a) && guard++ < 32) {
            const e = at(rom, a);
            const dest = e.view.getUint32(e.off, true);
            if (!dest) break;
            /* The count is halved into a dword count, so it is halfwords. */
            const words = e.view.getUint32(e.off + 4, true) >> 1;
            const first = (dest - PAL_BASE) >> 1;
            if (group < 0) group = first >> 4;
            for (let i = 0; i < words * 2; i++) {
                const d = first + i;
                if (d >= 0 && d < pal.length) pal[d] = e.view.getUint16(e.off + 8 + i * 2, true);
            }
            a += 8 + words * 4;
        }
    }
    if (group < 0) return null;

    /* ---- the eighteen patterns, side by side ---- */
    const L = at(rom, listPtr);
    const cols = [];
    let rows = 0;
    for (let i = 0; i < PATTERNS; i++) {
        const p = L.view.getUint32(L.off + 4 + i * 4, true);
        const t = at(rom, S.patternTable + p * 4);
        const pr = t.view.getUint32(t.off, true);
        if (!ptrOk(rom, pr)) { cols.push(null); continue; }
        const R = at(rom, pr);
        const h = R.view.getUint32(R.off + 4, true);
        if (h > 128) { cols.push(null); continue; }
        rows = Math.max(rows, h);
        cols.push({ R, h });
    }
    if (!rows) return null;

    const width = PATTERNS * PATTERN_TILES * 8;
    const height = rows * 8;
    const rgba = new Uint8Array(width * height * 4);

    for (let c = 0; c < PATTERNS; c++) {
        const col = cols[c];
        if (!col) continue;
        for (let ty = 0; ty < col.h; ty++) {
            for (let tx = 0; tx < PATTERN_TILES; tx++) {
                const entry = col.R.view.getUint16(
                    col.R.off + 0x0c + ty * PATTERN_STRIDE + tx * 2, true);
                const base = entry * TILE_BYTES;
                if (base + TILE_BYTES > chars.length) continue;
                for (let py = 0; py < 8; py++) {
                    for (let px = 0; px < 8; px++) {
                        const byte = chars[base + py * 4 + (px >> 1)];
                        const nib = (px & 1) ? (byte & 15) : (byte >> 4);
                        const v = pal[group * 16 + nib];
                        const x = (c * PATTERN_TILES + tx) * 8 + px;
                        const o = ((ty * 8 + py) * width + x) * 4;
                        rgba[o] = Math.round((v & 31) * 255 / 31);
                        rgba[o + 1] = Math.round(((v >> 5) & 31) * 255 / 31);
                        rgba[o + 2] = Math.round(((v >> 10) & 31) * 255 / 31);
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
