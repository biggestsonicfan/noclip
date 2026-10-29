/*
 * CGs that load over one another (js/cells.js, `stacked`): Desert Tank's.
 *
 * Desert Tank's loader (0x3C6F0) is Daytona USA's pair of lists, a CG list
 * and a palette list, but the game never clears the tile chip between them.
 * The boot (0x3C7F0) loads the first pair of its table and a second pair of
 * its own, then copies a few colours and characters in by hand; every CG
 * loaded after that lands on what the boot left. So a CG here is the boot's
 * lists, the boot's copies, then its own pair (`stacked.base`, `.after`,
 * `.copies`; see js/games.js DESERT_CELLS).
 *
 * Gunblade NY's scenes do the same over Last Bronx's directories: the boot
 * loads one directory and a font, and each scene copies colours and
 * characters over it by hand (js/cells.js `dirs`, `applyCopies`).
 */
import { loadScrollCG, scrollAt, TILE_BYTES } from './scroll.js';

const PAL_BASE = 0x01800000;
const CHAR_BASE = 0x01080000;
const u32 = (rom, a) => { const t = scrollAt(rom, a); return t.view.getUint32(t.off, true); };

/* Give each CG its stack: the lists to load in order, and the copies after
 * the base CG's. `all` is cgListsAll's list, each entry's own pair in
 * `pair`. */
export function stackCGs(rom, all) {
    const S = rom.game.cells.stacked;
    const pairs = (n) => [all[n].pair, ...(S.after?.[n] ?? [])].map((p) => [u32(rom, p), u32(rom, p + 4)]);
    const base = { lists: pairs(S.base), copies: S.copies ?? [] };
    all.forEach((L, n) => {
        if (!L) return;
        L.stack = n === S.base ? [base] : [base, { lists: pairs(n), copies: [] }];
    });
}

/* What a stacked CG leaves in the tile chip. */
export function loadStacked(rom, L, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    for (const { lists, copies } of L.stack) {
        for (const [tiles, palList] of lists) {
            const r = loadScrollCG(rom, tiles, palList, charBytes);
            for (const [first, n] of r.charRuns) {
                chars.set(r.chars.subarray(first * TILE_BYTES, (first + n) * TILE_BYTES), first * TILE_BYTES);
                charRuns.push([first, n]);
            }
            for (const [first, n] of r.palRuns) {
                pal.set(r.pal.subarray(first, first + n), first);
                palRuns.push([first, n]);
            }
        }
        applyCopies(rom, { chars, pal, charRuns, palRuns }, copies);
    }
    return { chars, pal, charRuns, palRuns };
}

/* Copies made by hand into a loaded CG `out`: [source, destination,
 * halfwords, times], a palette or a character RAM address, copied as it
 * lies, `times` times end to end (1 if left out). */
export function applyCopies(rom, out, copies) {
    for (const [src, dest, count, times = 1] of copies) {
        const T = scrollAt(rom, src);
        for (let t = 0; t < times; t++) {
            if (dest >= PAL_BASE) {
                const first = ((dest - PAL_BASE) >> 1) + t * count;
                for (let i = 0; i < count && first + i < out.pal.length; i++) out.pal[first + i] = T.view.getUint16(T.off + i * 2, true);
                out.palRuns.push([first, count]);
            } else {
                const at = dest - CHAR_BASE + t * count * 2;
                const n = Math.min(count * 2, out.chars.length - at, T.u8.length - T.off);
                out.chars.set(T.u8.subarray(T.off, T.off + n), at);
                out.charRuns.push([Math.floor(at / TILE_BYTES), Math.ceil(n / TILE_BYTES)]);
            }
        }
    }
}
