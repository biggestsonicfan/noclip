/*
 * cells.js — the big 2D pictures the game lays out on the tile chip: title
 * screens, portraits, the character select, the win poses. The game calls them
 * cells; a cell is a block of tilemap, and the pixels and colours it names come
 * from a CG, so what a cell looks like depends on which CG was loaded with it.
 *
 * The two routines, read off the program ROM:
 *
 *   _Scroll_Initialize(g0)  loads CG list cgTable[g0] into the character RAM
 *                           and palette list cgTable[g0 + 1] into the palette
 *                           (js/scroll.js loadScrollCG). Callers always pass an
 *                           even number — "Set CG for Sega Logo (2x value of
 *                           CG)" — so CG n is entries 2n and 2n + 1, and the
 *                           routine ignores g0 >= 0xB8, which is 92 CGs.
 *   dsp_pattern_new(g0)     copies cell g0, patternTable[g0], to the tilemap
 *                           at g9. The record: a halfword added to every entry
 *                           (0x8000, the category bit, on all of them), the
 *                           row count at 0x04, the column count at 0x08, then
 *                           the entries row by row; each row goes 0x80 bytes
 *                           (64 entries) on in the tilemap. It ignores g0 >=
 *                           1023, and the table ends with a zero.
 *
 * A tilemap entry is read as js/scroll.js reads one: the character is the low
 * 14 bits and the palette group bits 7-14. Pen 0 is transparent, as it is over
 * the 3D on the board.
 *
 * The game often loads one CG on top of another — the game-over screen loads
 * CG 1 and then CG 81 — so a cell can need two. A CG fits a cell when it
 * writes every character and every colour the cell uses; `rankCGs` puts
 * those first, and the panel's second picker loads another CG under it.
 *
 * Daytona USA has the same tile chip and the same list formats, but no
 * pattern table: its draw routine (0x19304 in Revision A) takes the record's
 * address, and the records lie end to end in one run of the data ROM
 * (`records`), so a cell is the record's place in that run. Its halfword at
 * 0x02 says how wide an entry is: 0 a byte, anything else a halfword. Its CGs
 * are pointers to a pair of (CG list, palette list), in two tables
 * (`cgTables`); `cgExtra` names a CG list the loader puts in before one of
 * them, and `cgPairs` pairs the code names directly. See js/games.js
 * DAYTONA_CELLS.
 *
 * Virtua Fighter 2 draws the same records by address too (0x8F1C), some of
 * them in the program ROM (`programAt0`), in runs its pointers lead to. Its
 * CGs are pairs of lists the code hands the loaders directly: `cgPairs` for a
 * pointer to a pair, `cgLists` for the two lists themselves. See js/games.js
 * vf2.cells.
 *
 * Fighting Vipers keeps Sonic The Fighters' two tables, a year earlier and
 * without the bounds: its dsp_pattern (0x6744) takes any cell number and its
 * _ScrollCG_Initialize (0x2934C) any CG, so the CG table runs up to the
 * pattern table, 0xC0 entries (`cgEntries`). Its draw reads the halfword at
 * 0x02 as Daytona's does, a byte entry where it is 0, but no record of its
 * has a 0 there. See js/games.js fvipers.cells.
 *
 * Virtua Cop's draw (0x55A0, and 0x5610, which skips zero entries) takes the
 * record's address as Daytona's does, but its record is Dead or Alive's
 * shape a year early (`sized`): the width and the height as halfwords, then
 * halfword entries, and the caller hands it the halfword to add (`base`,
 * `bases`). The records lie in two runs of the data ROM with zero halfwords
 * between some of them. The tile chip is filled once, at boot (`boot`): the
 * characters copied out of the data ROM a halfword at a time with its bytes
 * swapped, and the palette built by hand; the stage start adds one group.
 * See js/games.js VCOP_CELLS.
 *
 * Dead or Alive's format is Tecmo's own (`pictures`): a table of pictures,
 * each three pointers, its tiles, its colours and its map, so a picture is a
 * cell that brings its own CG, and CG n is picture n's tiles and colours. The
 * loader (0x9000 in Revision B) hands each chunk of tiles whole 128-tile
 * blocks of character RAM and each block its chunk's 16 colours; the map's
 * entries are the picture's own tiles, which the draw (0x9250) moves on by the
 * first block, so the group is the block. The panel loads a picture from
 * block 0. Every map's highest tile is its own list's last: no picture is
 * drawn over another's tiles. See js/games.js doab.cells and js/scroll.js
 * buildDoaSky, which reads the same table.
 *
 * Sky Target (1995) has the same pictures two years early, in its program
 * ROM (`programAt0`, table 0xEBFB0): the loaders 0x78A90 (tiles) and 0x789F0
 * (colours) put a picture from a block its "scroll group" names, and the draw
 * (0x78BB0) adds block << 7 to the entries. See js/games.js skytargt.cells.
 * Wave Runner (waverunr), Sega Water Ski (segawski) and Ski Super G (skisuprg)
 * have the same library (tables 0x8E1B0, 0x724F0, 0xB05C0).
 *
 * Behind Enemy Lines (bel) draws Daytona's records (0x76FC0) from one run
 * and loads Daytona's CG pairs (0x645F0) from two tables. See js/games.js
 * bel.cells.
 *
 * Top Skater (topskatr) draws Last Bronx's scripts (0xA88E0) from four data
 * ROM banks; each bank is a Last Bronx CG directory (0xA9420) and then its
 * scripts with zero bytes between them (`scriptPad`). A bank is a run of
 * `scripts` and its CG (`scriptDirs`), and a cell is drawn with its run's.
 * See js/games.js topskatr.cells.
 *
 * The House of the Dead (hotdo) has the same pictures a year early, in its
 * program ROM (`programAt0`): the draw (0x17D80) loads a picture into free
 * blocks the first time it is drawn (0x17B20, 0x17CB0, 0x17C10) and moves its
 * entries on by the first block, as Dead or Alive's does. Its colours go
 * through colorxlat. See js/games.js hotdo.cells.
 *
 * Sega Rally Championship's are AM3's own files (`cgm`): a file starts with
 * "CGM 1.0 ", the string its loader (0x5C8EB0, in the RAM copy of the
 * program) compares before it reads anything, so a scan of the ROMs for it
 * finds every file. A file is its blocks, each 16 colours and up to 128
 * tiles, then its patterns, each a 16-byte name, the width and the height and
 * the entries, which number the file's own tiles. The loader gives block k
 * group g + k and the 128 characters from (g + k) * 128, from the free group
 * g, which the reset (0x5C8A60) sets to 9 above the font; the draw (0x5C8C10)
 * adds g << 7 to each entry. So a file is a CG, loaded from group 9, and each
 * of its patterns a cell with its name. See js/games.js srallyc.cells.
 * Manx TT and Touring Car run the same routines at their own addresses
 * (js/games.js manxtt.cells, stcc.cells).
 *
 * Virtual On's maps are bare halfword entries: the draw routines (0x1DC10
 * and its siblings) take the map's address, its width and its height from
 * the caller, so a cell is a call site's `maps` entry, or one of a table's
 * (`mapTables`). The tile chip is filled once, as Virtua Cop's is (`boot`),
 * but the game has two fills, the attract mode's and the game's (`modes`),
 * and its colours are stored with each component's low bit apart
 * (`shuffled`). See js/games.js vonCells.
 *
 * Power Sled keeps no map at all (`scripts`): its draw (0x4EE0) walks a
 * byte script that writes the entries one run at a time, and the scripts lie
 * end to end in one run of the data ROM, each ending with a byte above 0x8D.
 * The cell is what a script writes, cropped to the entries it touches. Its
 * tile chip is filled once, at boot, as Virtua Cop's is, but with a 1bpp font
 * expanded first (`boot.font`) and the characters copied straight. See
 * js/games.js POWSLED_CELLS.
 *
 * Last Bronx draws Power Sled's scripts with a year-later draw (`script`, see
 * runScript), but loads its tile chip a CG at a time (`groups`). A CG is a
 * directory: entries of an offset from the directory and a first character,
 * ending with a zero offset. Each leads to a chain of blocks, a size (the
 * colours' offset), a tile count, 16 colours and the tiles, until a zero size;
 * the loader (0x149F0) copies the tiles straight from the first character and
 * gives every 128-character group the block takes its 16 colours. The game's
 * table of CGs (`groups.table`) holds a CG, a list of its cells' offsets
 * from the list and their count; CG 0 is the boot's (`groups.boot`), which
 * stays loaded, so a cell is drawn with it under its own. See js/games.js
 * lastbronxBuild.
 *
 * Pilot Kids draws Virtua Cop's records (`sized`): the width and the height
 * as halfwords, then halfword entries, which its draws (0x5A890, and 0x5AA50
 * from the vblank queue) store with bit 15 set. A viewer in its check menu
 * steps through a zero-ended table of them (`patternTable`), and every one
 * names characters the boot loaded (`boot`): Power Sled's font, then two
 * files of whole
 * 128-character blocks, each block taking its own group's colours from a
 * table of pointers. See js/games.js PLTKIDS_CELLS.
 *
 * INDY 500 loads a CG at a time into free 128-character blocks, as The
 * House of the Dead does, but keeps its CGs, its cells (Virtua Cop's
 * records) and its palettes in three tables a bank (`banks`), and its draws
 * take a cell and a CG by number. See js/bankcells.js and js/games.js
 * INDY500_CELLS.
 *
 * Virtua Cop 2 keeps Virtua Cop's records and boot, moved: its draw (0x7928)
 * ORs the caller's bits into each entry rather than adding them (`orBase`),
 * its font is copied straight where the rest is swapped (a fourth element of
 * a `chars` entry), and a run count of 0 fills to the end (`zeroFills`). The
 * game refills the middle and the end of the chip for the title and for each
 * stage, so its CGs are `modes`. See js/games.js VCOP2_CELLS.
 *
 * Desert Tank draws Daytona's records (`records`) and loads Daytona's pairs
 * of lists, but never clears the chip between them: every CG lands on what
 * the boot left (`stacked`, js/stackcells.js). Its pointer tables lie on
 * halfword steps (`pointerStep`). See js/games.js DESERT_CELLS.
 *
 * Gunblade NY runs Power Sled's scripts as Last Bronx does, from two runs
 * with zero padding between scripts (`scriptPad`), and loads one Last Bronx
 * directory at the boot with a font over it; each scene copies colours and
 * characters over that by hand (`dirs`, js/stackcells.js applyCopies). See
 * js/games.js, the gunblade entry.
 *
 * Zero Gunner is Pilot Kids' records and files a year sooner; the check
 * menu's viewer loads one file of fourteen over the boot's, so each is a
 * boot `mode`, and each record opens on the file it lies after (`screens`).
 * See js/games.js ZEROGUN_CELLS.
 */

import { loadScrollCG, scrollAt, scrollPtrOk, CHAR_MASK, TILE_BYTES } from './scroll.js';
import { palette555ToBytes } from './atlas.js';
import { MAIN_DATA_BASE } from './romset.js';
import { bankTables, loadBankCG, rankBankCGs } from './bankcells.js';
import { stackCGs, loadStacked, applyCopies } from './stackcells.js';
import { jalecoCells, jalecoCellName, jalecoCGs, jalecoCellCG, loadJalecoCG, readJalecoCell } from './jalecocells.js';
import { dynabbCells, dynabbCGs, dynabbCellCG, loadDynabbCG, readDynabbCell } from './dynabbcells.js';

const PAL_BASE = 0x01800000;    /* the tile chip's palette RAM */
const MAX_CELLS = 1023;         /* dsp_pattern_new's bound */
const CG_ENTRIES = 0xb8;        /* _ScrollCG_Initialize's bound */
const ROW_BYTES = 0x80;         /* the tilemap's row, 64 entries */
const MAX_SIDE = 64;            /* the tilemap is 64 entries square */
const MAX_PICTURE_SIDE = 128;   /* Dead or Alive's tallest picture is 69 rows */
const DOA_BLOCK = 128;          /* tiles to a block of character RAM */

const word = (rom, addr) => { const t = scrollAt(rom, addr); return t.view.getUint32(t.off, true); };
const byteAt = (rom, addr) => { const t = scrollAt(rom, addr); return t.u8[t.off]; };

/* Each cell's record address, worked out once per ROM set. */
const recordCache = new WeakMap();
function cellRecords(rom) {
    let out = recordCache.get(rom);
    if (out) return out;
    const C = rom.game.cells;
    out = [];
    if (C.cgm || C.maps) {
        out = listedCells(rom).map((c) => c.at);
    } else if (C.banks) {
        out = bankTables(rom).cells.map((c) => c.at);
    } else if (C.files) {
        out = jalecoCells(rom).map((c) => c.at);
    } else if (C.slots) {
        out = dynabbCells(rom).map((c) => c.at);
    } else if (C.pictures) {
        for (let n = 0; n < C.pictures.count; n++) out.push(word(rom, C.pictures.table + n * 12 + 8));
    } else if (C.groups) {
        out = groupCells(rom).map((c) => c.at);
    } else if (C.scripts) {
        for (const [first, end] of scriptRuns(C)) {
            for (let a = first; a < end && out.length < MAX_CELLS;) {
                if (C.scriptPad) a = pastZeros(rom, a, end);
                if (a >= end) break;
                const next = runScript(rom, a)?.end;
                if (!next) break;
                out.push(a);
                a = next;
            }
        }
    } else if (C.records) {
        for (const [first, end] of C.records) {
            for (let a = first; a < end && out.length < MAX_CELLS;) {
                if (C.sized) a = pastPadding(rom, a, end);
                if (a >= end) break;
                const size = recordSize(rom, a);
                if (!size) break;
                out.push(a);
                a += size;
            }
        }
    } else {
        while (out.length < MAX_CELLS && scrollPtrOk(rom, C.patternTable + out.length * 4)) {
            const p = word(rom, C.patternTable + out.length * 4);
            if (!p || !scrollPtrOk(rom, p)) break;
            out.push(p);
        }
    }
    recordCache.set(rom, out);
    return out;
}

/* Power Sled's one run of scripts, or Top Skater's runs, one a CG
 * (`scriptDirs`), with zero bytes between the scripts (`scriptPad`). */
function scriptRuns(C) {
    return Array.isArray(C.scripts[0]) ? C.scripts : [C.scripts];
}
function pastZeros(rom, a, end) {
    while (a < end && byteAt(rom, a) === 0) a++;
    return a;
}

/* The cells whose size is not in a record header: Sega Rally's patterns and
 * Virtual On's maps, each {at, cols, rows, head, base, or, name, file}. */
const listedCache = new WeakMap();
function listedCells(rom) {
    let out = listedCache.get(rom);
    if (out) return out;
    const C = rom.game.cells;
    out = [];
    if (C.cgm) {
        cgmFiles(rom).forEach((f, file) => {
            for (const p of f.patterns) out.push({ ...p, head: 0x14, base: CGM_GROUP << 7, or: 0, file });
        });
    } else {
        const seen = new Set();
        const add = (at, cols, rows, or, name) => {
            if (seen.has(at) || !scrollPtrOk(rom, at)) return;
            seen.add(at);
            out.push({ at, cols, rows, head: 0, base: 0, or, name });
        };
        for (const T of C.mapTables ?? []) {
            for (let i = 0; i < T.count; i++) {
                const r = T.table + i * T.stride;
                const cols = T.cols ?? word(rom, r + 4), rows = T.rows ?? word(rom, r + 8);
                add(word(rom, r), cols, rows, T.or, T.names ? `${T.what}, ${T.names[i]}` : `${T.what} ${i}`);
            }
        }
        for (const [at, cols, rows, or, name] of C.maps) add(at, cols, rows, or, name);
    }
    listedCache.set(rom, out);
    return out;
}

/* Last Bronx's cells, each {at, group}: the table's lists in order, each
 * offset added to its list's own address. A record whose list is not in the
 * data ROM ends the table. */
const groupCache = new WeakMap();
function groupCells(rom) {
    let out = groupCache.get(rom);
    if (out) return out;
    const G = rom.game.cells.groups;
    out = [];
    for (let group = 0; group < G.count; group++) {
        const list = word(rom, G.table + group * 12 + 4);
        const count = word(rom, G.table + group * 12 + 8);
        if (list < MAIN_DATA_BASE || !scrollPtrOk(rom, list) || count > MAX_CELLS) break;
        for (let k = 0; k < count && out.length < MAX_CELLS; k++) {
            const at = list + word(rom, list + k * 4);
            if (scrollPtrOk(rom, at)) out.push({ at, group });
        }
    }
    groupCache.set(rom, out);
    return out;
}

/* Sega Rally's CGM files, in the program ROM and then the data ROM up to
 * `cgm.dataEnd`, or in the data ROM's runs `cgm.data` ([from, to] offsets;
 * Touring Car's skip a repeat the program never names): each file's blocks
 * {pal, tiles, count} and patterns {at, name, cols, rows}. The loader (0x5C8EB0) refuses a file whose blocks would
 * run past group 0x80; so does this. */
const CGM_MAGIC = [...'CGM 1.0 '].map((ch) => ch.charCodeAt(0));
const CGM_GROUP = 9;            /* the first free group after the reset, 0x5C8A60 */
const cgmCache = new WeakMap();
function cgmFiles(rom) {
    let out = cgmCache.get(rom);
    if (out) return out;
    out = [];
    const G = rom.game.cells.cgm;
    const runs = (G.data ?? [[0, G.dataEnd ?? rom.mainData.length]])
        .map(([from, to]) => [rom.mainData.subarray(from, to), MAIN_DATA_BASE + from]);
    for (const [u8, base] of [[rom.maincpu, 0], ...runs]) {
        for (let o = u8.indexOf(CGM_MAGIC[0]); o >= 0 && o + 10 <= u8.length; o = u8.indexOf(CGM_MAGIC[0], o + 1)) {
            if (!CGM_MAGIC.every((b, i) => u8[o + i] === b)) continue;
            const f = readCgm(u8, o, base);
            if (f) out.push(f);
        }
    }
    cgmCache.set(rom, out);
    return out;
}

/* One file: 0x5C9050 loads block k from P (16 colours, a halfword it doesn't
 * read at 0x20, the tile count at 0x22, the tiles from 0x24); 0x5C90F0 steps
 * over a pattern (the name, the width at 0x10, the height at 0x12, the
 * entries). */
function readCgm(u8, o, base) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const at = o;
    const nblocks = dv.getUint16(o + 8, true);
    if (!nblocks || CGM_GROUP + nblocks > 0x80) return null;
    o += 10;
    const blocks = [];
    for (let k = 0; k < nblocks; k++) {
        if (o + 0x24 > u8.length) return null;
        const count = dv.getUint16(o + 0x22, true);
        blocks.push({ pal: base + o, tiles: base + o + 0x24, count });
        o += 0x24 + count * TILE_BYTES;
    }
    if (o + 2 > u8.length) return null;
    const npatterns = dv.getUint16(o, true);
    o += 2;
    const patterns = [];
    for (let k = 0; k < npatterns; k++) {
        if (o + 0x14 > u8.length) return null;
        const cols = dv.getInt16(o + 0x10, true), rows = dv.getInt16(o + 0x12, true);
        if (cols <= 0 || rows <= 0 || cols > MAX_SIDE || rows > MAX_SIDE) return null;
        /* Printable ASCII only, as the name goes into the page's HTML. */
        let name = '';
        for (let i = 0; i < 16 && u8[o + i]; i++) {
            const ch = u8[o + i];
            name += ch >= 0x20 && ch < 0x7f && !'<>&"'.includes(String.fromCharCode(ch)) ? String.fromCharCode(ch) : '?';
        }
        patterns.push({ at: base + o, name, cols, rows });
        o += 0x14 + cols * rows * 2;
    }
    if (o > u8.length) return null;
    return { at: base + at, blocks, patterns };
}

/** A cell's name, where the game gives it one: a Sega Rally pattern's own,
 * or what a Virtual On map shows; or a Jaleco item's greyed copy. */
export function cellName(rom, cell) {
    const C = rom.game.cells;
    if (C?.files) return jalecoCellName(rom, cell);
    return C?.cgm || C?.maps ? listedCells(rom)[cell]?.name ?? '' : '';
}

/* Virtua Cop's zero halfwords between records. */
function pastPadding(rom, a, end) {
    while (a < end && scrollPtrOk(rom, a)) {
        const R = scrollAt(rom, a);
        if (R.view.getUint16(R.off, true)) break;
        a += 2;
    }
    return a;
}

/* A record's header: the base, the entry width, the rows and the columns.
 * Null where it is no record. */
function recordHeader(rom, p) {
    if (!scrollPtrOk(rom, p)) return null;
    const R = scrollAt(rom, p);
    const C = rom.game.cells;
    if (C.pictures) return pictureHeader(R, 0);
    if (C.sized) return pictureHeader(R, C.bases?.[p] ?? C.base);
    if (R.off + 0x0c > R.u8.length) return null;
    const rows = R.view.getUint32(R.off + 4, true);
    const cols = R.view.getUint32(R.off + 8, true);
    if (!rows || !cols || rows > MAX_SIDE || cols > MAX_SIDE) return null;
    const wide = !rom.game.cells.records || R.view.getUint16(R.off + 2, true) !== 0;
    const bytes = 0x0c + rows * cols * (wide ? 2 : 1);
    if (R.off + bytes > R.u8.length) return null;
    return { R, base: R.view.getUint16(R.off, true), wide, rows, cols, bytes, head: 0x0c };
}

/* A Dead or Alive map, or a Virtua Cop record: the width and the height,
 * then halfword entries. */
function pictureHeader(R, base) {
    const cols = R.view.getUint16(R.off, true);
    const rows = R.view.getUint16(R.off + 2, true);
    if (!rows || !cols || rows > MAX_PICTURE_SIDE || cols > MAX_PICTURE_SIDE) return null;
    const bytes = 4 + rows * cols * 2;
    if (R.off + bytes > R.u8.length) return null;
    return { R, base, wide: true, rows, cols, bytes, head: 4 };
}

const recordSize = (rom, p) => recordHeader(rom, p)?.bytes ?? 0;

/** How many cells there are: up to the pattern table's terminating zero, or
 * every record in the game's runs of them. */
export function cellCount(rom) {
    return rom.game.cells ? cellRecords(rom).length : 0;
}

/** The cells the game never draws. Daytona's draw calls take their record
 * from an `lda` or from a table of absolute pointers (js/games.js
 * DAYTONA_CELLS), so a record no aligned word of the program or data ROM
 * holds is one of them. Sonic The Fighters' cells all come through its
 * pattern table by number, which no scan of the ROM can follow, so its
 * game entry lists them (`cells.unused`). */
const unusedCache = new WeakMap();
export function unusedCells(rom) {
    let out = unusedCache.get(rom);
    if (out) return out;
    out = new Set(rom.game.cells?.unused);
    if (rom.game.cells?.cgm) {
        /* Sega Rally hands the loader a file's address (`lda` in the RAM
         * copy of the program): a file no aligned word names is never
         * loaded, and its patterns never drawn. */
        const files = cgmFiles(rom);
        const index = new Map(files.map((f, i) => [f.at, i]));
        const named = new Set();
        for (const v of [rom.mainCpuView, rom.mainDataView]) {
            for (let o = 0; o + 4 <= v.byteLength; o += 4) {
                const i = index.get(v.getUint32(o, true));
                if (i !== undefined) named.add(i);
            }
        }
        listedCells(rom).forEach((c, i) => { if (!named.has(c.file)) out.add(i); });
    } else if (rom.game.cells?.records) {
        const records = cellRecords(rom);
        const index = new Map(records.map((a, i) => [a, i]));
        const named = new Set();
        /* Desert Tank keeps pointer tables on halfword steps (`pointerStep`). */
        const step = rom.game.cells.pointerStep ?? 4;
        for (const v of [rom.mainCpuView, rom.mainDataView]) {
            for (let o = 0; o + 4 <= v.byteLength; o += step) {
                const i = index.get(v.getUint32(o, true));
                if (i !== undefined) named.add(i);
            }
        }
        records.forEach((_, i) => { if (!named.has(i)) out.add(i); });
    }
    unusedCache.set(rom, out);
    return out;
}

/** How many of a cell's entries fall on the leftover tiles of the game's
 * `leftover` CG, when that CG is the one on top; 0 otherwise. Daytona's boot
 * CG loads the DaytonaGP tiles, and the cells whose entries name the same
 * characters land on them (js/games.js DAYTONA_CELLS). */
export function leftoverTiles(rom, cell, cgs) {
    const L = rom.game.cells?.leftover;
    if (!L || cgs[cgs.length - 1] !== L.cg) return 0;
    const c = readCell(rom, cell);
    let n = 0;
    for (const e of c?.entries ?? []) {
        const ch = e & CHAR_MASK;
        if (L.chars.some(([a, b]) => ch >= a && ch < b)) n++;
    }
    return n;
}

/* Every CG's lists: the tile lists, loaded in order, and the palette list. */
const cgCache = new WeakMap();
function cgListsAll(rom) {
    let all = cgCache.get(rom);
    if (all) return all;
    const C = rom.game.cells;
    all = [];
    if (C.cgm) {
        for (const f of cgmFiles(rom)) {
            const where = f.at < MAIN_DATA_BASE ? 'program' : 'data';
            all.push({ cgm: f, name: `${f.patterns[0]?.name || 'no patterns'}…, ${where} 0x${f.at.toString(16).toUpperCase()}` });
        }
        cgCache.set(rom, all);
        return all;
    }
    if (C.banks) {
        all = bankTables(rom).cgs.map((L) => L && { banked: L, name: L.name });
        cgCache.set(rom, all);
        return all;
    }
    if (C.dirs) {
        /* Gunblade NY's: the boot's directory (Last Bronx's format), its
         * fonts and copies, then each scene's copies over that (`dirs`). */
        const D = C.dirs;
        const boot = { dirs: [D.boot], fonts: D.fonts ?? [], copies: D.copies ?? [] };
        all.push({ ...boot, name: D.name });
        for (const S of D.scenes ?? []) all.push({ ...boot, fonts: S.fonts ?? boot.fonts, copies: [...boot.copies, ...S.copies], name: S.name });
        cgCache.set(rom, all);
        return all;
    }
    if (C.files || C.slots) {
        all = C.files ? jalecoCGs(rom) : dynabbCGs(rom);
        cgCache.set(rom, all);
        return all;
    }
    if (C.groups) {
        const hex = (a) => `0x${(a - MAIN_DATA_BASE).toString(16).toUpperCase()}`;
        for (let group = 0; group < C.groups.count; group++) {
            const dir = word(rom, C.groups.table + group * 12) || C.groups.boot;
            const dirs = group ? [C.groups.boot, dir] : [dir];
            all.push({ dirs, name: group ? `data ${hex(dir)} over the boot's` : `the boot's, data ${hex(dir)}` });
        }
        cgCache.set(rom, all);
        return all;
    }
    if (C.scriptDirs) {
        const hex = (a) => `0x${a.toString(16).toUpperCase()}`;
        for (const dirs of C.scriptDirs) all.push({ dirs, name: dirs.map(hex).join(' + ') });
        cgCache.set(rom, all);
        return all;
    }
    if (C.pictures) {
        const skies = skyNames(rom);
        for (let n = 0; n < C.pictures.count; n++) {
            const at = C.pictures.table + n * 12;
            all.push({ tiles: [word(rom, at)], pal: word(rom, at + 4), picture: true, name: skies.get(n) });
        }
        cgCache.set(rom, all);
        return all;
    }
    if (C.boot?.modes) {
        C.boot.modes.forEach((m, mode) => all.push({ boot: true, mode, name: m.name }));
        cgCache.set(rom, all);
        return all;
    }
    if (C.boot) {
        all.push({ boot: true, name: 'boot' });
        for (let stage = 0; stage < (C.boot.stages?.count ?? 0); stage++) {
            all.push({ boot: true, stage, name: `stage ${stage + 1}` });
        }
        cgCache.set(rom, all);
        return all;
    }
    const pairAt = (pair, name, extra) => ({
        tiles: [extra, word(rom, pair)].filter(Boolean), pal: word(rom, pair + 4), name, pair,
    });
    if (C.cgTables || C.cgPairs || C.cgLists) {
        for (const [table, count] of C.cgTables ?? []) {
            for (let i = 0; i < count; i++) {
                const n = all.length;
                all.push(pairAt(word(rom, table + i * 4), C.cgNames?.[n], C.cgExtra?.[n]));
            }
        }
        for (let course = (C.courses?.count ?? 0) - 1; course >= 0; course--) {
            const L = all[courseCG(rom, course)];
            if (L) L.course = course;
        }
        for (const [pair, name] of C.cgPairs ?? []) all.push(pairAt(pair, name));
        for (const [tiles, pal, name] of C.cgLists ?? []) all.push({ tiles: [tiles], pal, name });
        if (C.stacked) stackCGs(rom, all);
    } else {
        for (let cg = 0; cg < (C.cgEntries ?? CG_ENTRIES) / 2; cg++) {
            const tiles = word(rom, C.cgTable + cg * 8);
            all.push(tiles ? { tiles: [tiles], pal: word(rom, C.cgTable + cg * 8 + 4) } : null);
        }
    }
    cgCache.set(rom, all);
    return all;
}

/* Dead or Alive's sky pictures, four a stage (js/scroll.js buildDoaSky):
 * picture number to its name, "stage 1 sky 2". */
function skyNames(rom) {
    const S = rom.game.doa?.sky;
    const out = new Map();
    for (let stage = 0; S && stage < rom.game.doa.count; stage++) {
        if (S.skyless.includes(stage)) continue;
        for (let k = 0; k < 4; k++) {
            const n = rom.mainCpuView.getInt16(S.stages + stage * 8 + k * 2, true);
            out.set(n, [out.get(n), `stage ${stage} sky ${k + 1}`].filter(Boolean).join(', '));
        }
    }
    return out;
}

/** How many CGs there are: entry pairs below _ScrollCG_Initialize's bound, or
 * the game's tables of them. */
export function cgCount(rom) {
    return rom.game.cells ? cgListsAll(rom).length : 0;
}

/** What the panel calls CG n: its number, and the game's name for it if the
 * profile has one. */
export function cgLabel(rom, cg) {
    const name = rom.game.cells ? cgLists(rom, cg)?.name : null;
    return name ? `CG ${cg} (${name})` : `CG ${cg}`;
}

/**
 * A cell's record: its size in tiles and its entries, base added.
 * @returns {null|{cols:number, rows:number, entries:Uint16Array}}
 */
export function readCell(rom, cell) {
    if (rom.game.cells.cgm || rom.game.cells.maps) return readListed(rom, cell);
    if (rom.game.cells.files) return readJalecoCell(rom, cell);
    if (rom.game.cells.slots) return readDynabbCell(rom, cell);
    const p = cellRecords(rom)[cell];
    if (p !== undefined && (rom.game.cells.scripts || rom.game.cells.groups)) return scriptCell(rom, p);
    const h = p === undefined ? null : recordHeader(rom, p);
    if (!h) return null;
    const { R, base, wide, rows, cols, head } = h;
    const entries = new Uint16Array(rows * cols);
    for (let i = 0; i < entries.length; i++) {
        const v = wide ? R.view.getUint16(R.off + head + i * 2, true) : R.u8[R.off + head + i];
        entries[i] = (rom.game.cells.orBase ? v | base : v + base) & 0xffff;
    }
    return { cols, rows, entries };
}

/* A Sega Rally pattern or a Virtual On map: halfword entries after `head`,
 * `base` added (the draw's g << 7) or `or` set (the bits the map draws set). */
function readListed(rom, cell) {
    const c = listedCells(rom)[cell];
    if (!c || !scrollPtrOk(rom, c.at)) return null;
    const R = scrollAt(rom, c.at);
    const entries = new Uint16Array(c.rows * c.cols);
    if (R.off + c.head + entries.length * 2 > R.u8.length) return null;
    for (let i = 0; i < entries.length; i++) {
        entries[i] = ((R.view.getUint16(R.off + c.head + i * 2, true) + c.base) | c.or) & 0xffff;
    }
    return { cols: c.cols, rows: c.rows, entries };
}

/* Power Sled's tilemap script, as its draw (0x4EE0) runs it: g0 the tilemap
 * address, g1 the script, g2 the halfword ORed into the entries it builds
 * (0x8000, the category bit, from every caller). A byte up to 0x7F writes
 * entry b of the script's dictionary; 0x80 and above are commands, and one
 * above 0x8D ends the script. A character is built from two bytes as
 * (0x100 + lo + hi * 256) & 0x3FFF: the font's 256 characters are never named
 * this way.
 *
 *   80 x y        go to entry y * 256 + x of the layer
 *   81 s          move s entries (signed)
 *   82 n lo hi    n copies of the character, rightwards
 *   83 n lo hi    n entries counting up from it; 84, counting down
 *   85 n hi b..   n entries, (0x100 + hi * 256) | b each
 *   86 n (lo hi)..  n characters; 87 the same, each added to the dictionary
 *   88 k          clear layer k & 3 (no script here uses it)
 *   89/8A n lo hi n copies downwards; 8B/8C upwards
 *   8D a b        move (a + b) * 256 entries, the sum a signed byte
 *
 * Last Bronx's draw (0x14CD0) is the same routine a year on (`script`): no
 * 0x100 on the character (`bias` 0), 8D moves by a + b * 256 entries, a
 * signed halfword (`wideMove`), and 8E lo hi writes one character, so a byte
 * above 0x8E (`last`) ends the script.
 *
 * Entries are numbered as the layer's are, 64 to a row. Returns them by
 * entry number, and the address past the end; null where the script runs off
 * the ROM. */
function runScript(rom, start) {
    const V = rom.game.cells.script ?? {};
    const bias = V.bias ?? 0x100, last = V.last ?? 0x8d;
    const S = scrollAt(rom, start);
    const b = S.u8;
    let o = S.off, at = 0, dict = [];
    const out = new Map();
    const s8 = (v) => (v << 24) >> 24;
    const s16 = (v) => (v << 16) >> 16;
    const ch = (lo, hi) => ((bias + lo + (hi << 8)) & CHAR_MASK) | 0x8000;
    for (;;) {
        if (o + 4 > b.length) return null;
        const op = b[o++];
        if (op < 0x80) { out.set(at++, dict[op] ?? 0); continue; }
        if (op > last) break;
        switch (op) {
        case 0x80: at = b[o] + (b[o + 1] << 8); o += 2; break;
        case 0x81: at += s8(b[o++]); break;
        case 0x8e: out.set(at++, ch(b[o], b[o + 1])); o += 2; break;
        case 0x85: {
            const n = b[o], base = ch(0, b[o + 1]); o += 2;
            for (let i = 0; i < n; i++) out.set(at++, base | b[o++]);
            break;
        }
        case 0x86: case 0x87: {
            const n = b[o++];
            for (let i = 0; i < n; i++, o += 2) {
                const e = ch(b[o], b[o + 1]);
                out.set(at++, e);
                if (op === 0x87) dict.push(e);
            }
            break;
        }
        case 0x88: o++; break;
        case 0x8d: at += V.wideMove ? s16(b[o] + (b[o + 1] << 8)) : s8(b[o] + b[o + 1]) * 256; o += 2; break;
        default: {
            const n = b[o];
            let e = ch(b[o + 1], b[o + 2]);
            o += 3;
            const step = op <= 0x84 ? 1 : op <= 0x8a ? 64 : -64;
            for (let i = 0; i < n; i++, at += step) {
                out.set(at, e & 0xffff);
                if (op === 0x83) e++;
                if (op === 0x84) e--;
            }
        }
        }
        if (o > b.length) return null;
    }
    return { out, end: start + (o - S.off) };
}

/* A script's cell: the box round the entries it writes. Entries it leaves
 * alone are 0, the font's blank character. */
function scriptCell(rom, p) {
    const r = runScript(rom, p);
    if (!r || !r.out.size) return null;
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const at of r.out.keys()) {
        const row = Math.floor(at / 64), col = at - row * 64;
        top = Math.min(top, row); bottom = Math.max(bottom, row);
        left = Math.min(left, col); right = Math.max(right, col);
    }
    const cols = right - left + 1, rows = bottom - top + 1;
    const entries = new Uint16Array(rows * cols);
    for (const [at, e] of r.out) {
        const row = Math.floor(at / 64), col = at - row * 64;
        entries[(row - top) * cols + col - left] = e;
    }
    return { cols, rows, entries };
}

/* The lists of CG n, or null for an empty slot. */
function cgLists(rom, cg) {
    return cg >= 0 ? cgListsAll(rom)[cg] ?? null : null;
}

/* The bank CG a Daytona course's race start streams in. */
function courseCG(rom, course) {
    const C = rom.game.cells;
    return (word(rom, C.courses.cgs + course * 4) - C.cgTables[0][0]) / 4;
}

/* What loading CG n leaves in the tile chip: its tile lists one after
 * another, then its palette, and a course CG's flash over that. */
function loadCG(rom, L) {
    const out = loadTiles(rom, L);
    if (L.course !== undefined) flashCourse(rom, out, L.course);
    return out;
}

function loadTiles(rom, L) {
    const charBytes = rom.game.cells.charBytes;
    if (L.picture) return loadPicture(rom, L, charBytes);
    if (L.banked) return loadBankCG(rom, L.banked, charBytes);
    if (L.cgm) return loadCgm(rom, L.cgm, charBytes);
    if (L.jaleco) return loadJalecoCG(rom, L, charBytes);
    if (L.dynabb !== undefined) return loadDynabbCG(rom, L, charBytes);
    if (L.boot) return loadBoot(rom, L, charBytes);
    if (L.stack) return loadStacked(rom, L, charBytes);
    if (L.dirs && (L.fonts || L.copies)) {
        const out = loadDirs(rom, L.dirs, charBytes);
        for (const F of L.fonts) bootFont(rom, F, out.chars, out.charRuns);
        applyCopies(rom, out, L.copies);
        return out;
    }
    if (L.dirs) return loadDirs(rom, L.dirs, charBytes);
    if (L.tiles.length === 1) return loadScrollCG(rom, L.tiles[0], L.pal, charBytes);
    const parts = L.tiles.map((t, i) => loadScrollCG(rom, t, i === L.tiles.length - 1 ? L.pal : 0, charBytes));
    const out = parts[parts.length - 1];
    for (const r of parts.slice(0, -1)) {
        for (const [first, n] of r.charRuns) {
            out.chars.set(r.chars.subarray(first * TILE_BYTES, (first + n) * TILE_BYTES), first * TILE_BYTES);
        }
        out.charRuns = r.charRuns.concat(out.charRuns);
    }
    return out;
}

/* A Dead or Alive picture's tiles and colours, loaded from block 0: each
 * chunk, a count and that many tiles, starts on a block of its own, and every
 * block it takes gets its chunk's 16 colours. A count of 0 ends the list. */
function loadPicture(rom, L, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    let t = L.tiles[0], p = L.pal, block = 0;
    for (;;) {
        const T = scrollAt(rom, t);
        const count = T.view.getUint32(T.off, true);
        const blocks = Math.ceil(count / DOA_BLOCK);
        if (!count || (block + blocks) * DOA_BLOCK * TILE_BYTES > charBytes || T.off + 4 + count * TILE_BYTES > T.u8.length) break;
        chars.set(T.u8.subarray(T.off + 4, T.off + 4 + count * TILE_BYTES), block * DOA_BLOCK * TILE_BYTES);
        charRuns.push([block * DOA_BLOCK, count]);
        const P = scrollAt(rom, p);
        for (let b = block; b < block + blocks; b++) {
            for (let c = 0; c < 16; c++) pal[b * 16 + c] = P.view.getUint16(P.off + c * 2, true);
        }
        palRuns.push([block * 16, blocks * 16]);
        block += blocks;
        t += 4 + count * TILE_BYTES;
        p += 32;
    }
    return { chars, pal, written: block * 16, charRuns, palRuns };
}

/* Last Bronx's CG directories, one after another, as 0x149F0 loads each:
 * see the top of the file. */
function loadDirs(rom, dirs, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    const maxChars = charBytes / TILE_BYTES;
    for (const dir of dirs) {
        for (let e = 0; ; e++) {
            const off = word(rom, dir + e * 8);
            if (!off) break;
            let first = word(rom, dir + e * 8 + 4), b = dir + off;
            for (let size; scrollPtrOk(rom, b) && (size = word(rom, b)); ) {
                const count = word(rom, b + 4);
                const groups = (count + DOA_BLOCK - 1) >> 7;
                const P = scrollAt(rom, b + size), T = scrollAt(rom, b + size + 0x20);
                if (first + count > maxChars || T.off + count * TILE_BYTES > T.u8.length) break;
                for (let g = first >> 7; g < (first >> 7) + groups; g++) {
                    for (let c = 0; c < 16; c++) pal[g * 16 + c] = P.view.getUint16(P.off + c * 2, true);
                }
                palRuns.push([(first >> 7) * 16, groups * 16]);
                chars.set(T.u8.subarray(T.off, T.off + count * TILE_BYTES), first * TILE_BYTES);
                charRuns.push([first, count]);
                b += size + 0x20 + count * TILE_BYTES;
                first += groups * DOA_BLOCK;
            }
        }
    }
    return { chars, pal, written: 0, charRuns, palRuns };
}

/* A Sega Rally file as its loader (0x5C8EB0) leaves it, from group 9: block
 * k's colours to group 9 + k, and its tiles, as they are, from character
 * (9 + k) * 128. A block of more than 128 tiles runs on into the next
 * block's characters, which that block then writes over, as on the board. */
function loadCgm(rom, f, charBytes) {
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    f.blocks.forEach((b, k) => {
        const group = CGM_GROUP + k;
        const P = scrollAt(rom, b.pal);
        for (let c = 0; c < 16; c++) pal[group * 16 + c] = P.view.getUint16(P.off + c * 2, true);
        palRuns.push([group * 16, 16]);
        const T = scrollAt(rom, b.tiles);
        const first = group * DOA_BLOCK;
        const n = Math.min(b.count, (charBytes / TILE_BYTES) - first);
        if (n <= 0) return;
        chars.set(T.u8.subarray(T.off, T.off + n * TILE_BYTES), first * TILE_BYTES);
        charRuns.push([first, n]);
    });
    return { chars, pal, written: 0, charRuns, palRuns };
}

/* Virtual On's colours (SetScrollcol, 0x1BB90): each component's four high
 * bits in a nibble, red lowest, and the three low bits in 12-14. */
const unshuffle = (v) => ((v >> 12) & 1) | ((v & 15) << 1) | (((v >> 13) & 1) << 5)
    | (((v >> 4) & 15) << 6) | (((v >> 14) & 1) << 10) | (((v >> 8) & 15) << 11);

/* What Virtua Cop's boot leaves in the tile chip, and a stage's group over
 * it (js/games.js VCOP_CELLS). The characters are copied a halfword at a
 * time with the bytes swapped, unless `straight` (for all of them, or as a
 * fourth element for one list, Virtua Cop 2's font). The palette steps, in the
 * boot's order: `runs`, a count and sixteen colours, that group repeated
 * count times, until `until` groups are written or for `lists` such entries
 * (with `zeroFills`, Virtua Cop 2's, a count of 0 repeats its group to the
 * end, or once in a single entry);
 * `colours`, sixteen colours over `groups` groups; `block`, `groups` groups'
 * colours copied as they are; `copy`, groups copied to others; `shuffled`,
 * Virtual On's lists of [colours, groups], one group after another;
 * `pointers`, a table of `groups` pointers, each to one group's colours
 * (Pilot Kids'); `set`, [palette entry, colour] pairs the code stores itself.
 *
 * `font` is a 1bpp font drawn first, 8 bytes a character, the top bit the
 * left pixel, a set bit pen `pen` (Virtual On's, Power Sled's). Virtual On's
 * boot has two fills (`modes`): SetScrolldata (0x1BDA0) takes the mode, and
 * each puts its own characters and colours in before the ones both share
 * (`chars`, `fill`, `palette`). */
function loadBoot(rom, L, charBytes) {
    const B = rom.game.cells.boot;
    const M = L.mode !== undefined ? B.modes[L.mode] : {};
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    const charRuns = [], palRuns = [];
    if (B.font) bootFont(rom, B.font, chars, charRuns);
    for (const [src, first, count, straight] of [...(M.chars ?? []), ...B.chars]) {
        const S = scrollAt(rom, src);
        const n = Math.min(count * TILE_BYTES, S.u8.length - S.off, charBytes - first * TILE_BYTES) & ~1;
        const swap = B.straight || straight ? 0 : 1;
        for (let i = 0; i < n; i += 2) {
            chars[first * TILE_BYTES + i] = S.u8[S.off + i + swap];
            chars[first * TILE_BYTES + i + 1] = S.u8[S.off + i + 1 - swap];
        }
        charRuns.push([first, n / TILE_BYTES]);
    }
    for (const [first, count, v] of B.fill ?? []) {
        for (let i = first * TILE_BYTES; i < (first + count) * TILE_BYTES; i += 2) {
            chars[i] = v & 255;
            chars[i + 1] = v >> 8;
        }
        charRuns.push([first, count]);
    }
    const put = (group, src, groups) => {
        const S = scrollAt(rom, src);
        for (let g = group; g < Math.min(group + groups, 0x100); g++) {
            for (let i = 0; i < 16; i++) pal[g * 16 + i] = S.view.getUint16(S.off + i * 2, true);
        }
        palRuns.push([group * 16, groups * 16]);
    };
    for (const op of [...(M.palette ?? []), ...B.palette]) {
        if (op.shuffled) {
            let group = op.group;
            for (const [src, groups] of op.shuffled) {
                const S = scrollAt(rom, src);
                for (let i = 0; i < groups * 16 && group * 16 + i < pal.length; i++) {
                    pal[group * 16 + i] = unshuffle(S.view.getUint16(S.off + i * 2, true));
                }
                palRuns.push([group * 16, groups * 16]);
                group += groups;
            }
        } else if (op.runs) {
            let src = op.runs, group = op.group;
            for (let k = 0; k < 0x100 && (op.lists ? k < op.lists : group - op.group < op.until); k++) {
                const S = scrollAt(rom, src);
                let count = S.view.getUint16(S.off, true);
                if (!count && B.zeroFills) count = op.lists ? 1 : op.until - (group - op.group);
                put(group, src + 2, count);
                group += count;
                src += 34;
            }
        } else if (op.colours) {
            put(op.group, op.colours, op.groups);
        } else if (op.block) {
            const S = scrollAt(rom, op.block);
            const n = Math.min(op.groups * 16, (S.u8.length - S.off) >> 1, pal.length - op.group * 16);
            for (let i = 0; i < n; i++) pal[op.group * 16 + i] = S.view.getUint16(S.off + i * 2, true);
            palRuns.push([op.group * 16, n]);
        } else if (op.copy) {
            const [from, to, groups] = op.copy;
            pal.copyWithin(to * 16, from * 16, (from + groups) * 16);
            palRuns.push([to * 16, groups * 16]);
        } else if (op.pointers) {
            for (let k = 0; k < op.groups; k++) put(op.group + k, word(rom, op.pointers + k * 4), 1);
        } else if (op.set) {
            for (const [i, v] of op.set) {
                pal[i] = v;
                palRuns.push([i, 1]);
            }
        }
    }
    if (L.stage !== undefined) put(B.stages.group, word(rom, B.stages.table + L.stage * 4), 1);
    return { chars, pal, charRuns, palRuns };
}

/* Virtual On's font (InitScroll, 0x1C220, through 0x1C730): `count`
 * characters from `first`, a byte a row, bit 7 the left pixel, each set pixel
 * pen `pen`. */
function bootFont(rom, F, chars, charRuns) {
    const S = scrollAt(rom, F.src);
    for (let ch = 0; ch < F.count; ch++) {
        for (let row = 0; row < 8; row++) {
            const bits = S.u8[S.off + ch * 8 + row];
            for (let px = 0; px < 8; px++) {
                if (!(bits & (0x80 >> px))) continue;
                const o = (F.first + ch) * TILE_BYTES + row * 4 + ((px >> 1) ^ 1);
                chars[o] |= (px & 1) ? F.pen : F.pen << 4;
            }
        }
    }
    charRuns.push([F.first, F.count]);
}

/* A course CG's palette list writes nothing into the groups its picture
 * uses: the race start's palette cycle fills them (0x26C20 in Revision A),
 * from a record per course in `flash.table`, {group count, colours, first
 * group's address}, every group taking the same 16 colours, the step's.
 * `flash.also` are blocks the same for every course, [colours, address,
 * groups]. Before the first frame the game shows step `flash.step`, and so
 * does the panel. */
function flashCourse(rom, out, course) {
    const F = rom.game.cells.courses.flash;
    const t = F.table + course * 16;
    for (const [src, dest, groups] of [[word(rom, t + 4), word(rom, t + 8), word(rom, t)], ...F.also]) {
        const s = scrollAt(rom, src + F.step * 32);
        const first = (dest - PAL_BASE) >> 1;
        for (let i = 0; i < groups * 16; i++) out.pal[first + i] = s.view.getUint16(s.off + (i & 15) * 2, true);
        out.palRuns.push([first, groups * 16]);
    }
}

/* What each CG writes, worked out once per ROM set: the character RAM it
 * fills, and the palette entries. */
const coverCache = new WeakMap();
function cgCover(rom) {
    let all = coverCache.get(rom);
    if (all) return all;
    all = [];
    for (let cg = 0; cg < cgCount(rom); cg++) {
        const L = cgLists(rom, cg);
        if (!L) { all.push(null); continue; }
        const { charRuns, palRuns } = loadCG(rom, L);
        all.push({ charRuns, palRuns });
    }
    coverCache.set(rom, all);
    return all;
}

const inRuns = (runs, i) => runs.some(([first, n]) => i >= first && i < first + n);

/* The CG the game itself draws a cell with, where its tables or its code say
 * (js/games.js cells.cards, .portraits, .tips, .names and .screens). A colour
 * card and its greyscale twin are the same tiles, so both CGs fit either one,
 * and only the tables tell them apart. Each card table names a player's small
 * card; the big one is the cell before it (129 and 130, 245 and 246) and takes
 * the same CG. Each name plate's twin is the cell and the CG after it. The
 * first table to name a cell wins. */
const gameCache = new WeakMap();
function gameCGs(rom) {
    let map = gameCache.get(rom);
    if (map) return map;
    map = new Map();
    const C = rom.game.cells;
    /* Each table's [cell, CG] pairs, in the order they win. */
    const pairs = [
        ...cardCGs(rom, C.cards), ...portraitCGs(rom, C.portraits), ...tipCGs(rom, C.tips),
        ...plateCGs(rom, C.names), ...courseCGs(rom, C.courses),
        ...(C.screens ?? []).flatMap(({ cg, cells }) => cells.map((cell) => [cell, cg])),
    ];
    for (const [cell, cg] of pairs) if (!map.has(cell)) map.set(cell, cg);
    gameCache.set(rom, map);
    return map;
}

const u16 = (rom, addr) => rom.mainCpuView.getUint16(addr, true);

function cardCGs(rom, K) {
    const out = [];
    for (const [cells, cgs] of K?.tables ?? []) {
        for (let i = 0; i < K.count; i++) {
            const cell = u16(rom, cells + i * 2);
            const cg = u16(rom, cgs + i * 2) >> 1;
            out.push([cell, cg], [cell - 1, cg]);
        }
    }
    return out;
}

function portraitCGs(rom, P) {
    const out = [];
    for (let i = 0; i < (P?.count ?? 0); i++) {
        const frames = rom.mainCpuView.getUint32(P.list + i * 4, true);
        for (let f = 0; f < P.frames; f++) out.push([u16(rom, frames + f * 2), P.cg]);
    }
    return out;
}

function tipCGs(rom, T) {
    const out = [];
    for (let i = 0; i < (T?.count ?? 0); i++) out.push([rom.mainCpuView.getUint32(T.list + i * 4, true), T.cg]);
    return out;
}

/* Every plate first, then every twin. */
function plateCGs(rom, N) {
    const plates = [];
    for (const table of N?.tables ?? []) {
        for (let i = 0; i < N.count; i++) plates.push([u16(rom, table + i * 8 + 2), u16(rom, table + i * 8) >> 1]);
    }
    return plates.concat(plates.map(([cell, cg]) => [cell + 1, cg + 1]));
}

/* Daytona's course pictures: a cell per course, on that course's CG. */
function courseCGs(rom, R) {
    const out = [];
    const records = R ? cellRecords(rom) : [];
    for (let course = 0; course < (R?.count ?? 0); course++) {
        const cell = records.indexOf(word(rom, R.cells + course * 4));
        if (cell >= 0) out.push([cell, courseCG(rom, course)]);
    }
    return out;
}

/**
 * How much of a cell each CG draws on its own, best first: the share of the
 * cell's tiles whose character and colours that CG writes. A cell's blank
 * tiles are character 0, which no CG writes, so they are not counted. A CG at
 * 1 fits the cell; one that draws none of it is left out. Among CGs that draw
 * equally much, the one the game uses for the cell comes first; among CGs
 * that fit and the game doesn't name, the one whose picture holds together
 * (seamScore).
 *
 * @returns {Array<{cg:number, cover:number}>}
 */
export function rankCGs(rom, cell) {
    const c = readCell(rom, cell);
    if (!c) return [];
    /* A Dead or Alive picture brings its own tiles and colours. */
    if (rom.game.cells.pictures) return [{ cg: cell, cover: 1 }];
    /* A Sega Rally pattern is drawn with its own file. */
    if (rom.game.cells.cgm) return [{ cg: listedCells(rom)[cell].file, cover: 1 }];
    /* Top Skater's script is drawn with its run's CG. */
    if (rom.game.cells.scriptDirs) {
        const p = cellRecords(rom)[cell];
        const run = scriptRuns(rom.game.cells).findIndex(([a, b]) => p >= a && p < b);
        return [{ cg: run, cover: 1 }];
    }
    /* Power Sled's one CG, the boot's, holds every character and colour;
     * Gunblade NY's scenes are ranked like any shared CGs. */
    if (rom.game.cells.scripts && !rom.game.cells.dirs) return [{ cg: 0, cover: 1 }];
    /* A Last Bronx cell is drawn with the CG its list goes with. */
    if (rom.game.cells.groups) return [{ cg: groupCells(rom)[cell].group, cover: 1 }];
    /* An INDY 500 cell is drawn with a CG of its own bank (js/bankcells.js). */
    if (rom.game.cells.banks) return bySeams(rom, cell, rankBankCGs(rom, cell, c, gameCGs(rom)));
    /* A Jaleco cell is drawn with its own file (js/jalecocells.js). */
    if (rom.game.cells.files) return [{ cg: jalecoCellCG(rom, cell), cover: 1 }];
    if (rom.game.cells.slots) return [{ cg: dynabbCellCG(rom, cell), cover: 1 }];
    return rankSharedCGs(rom, cell, c);
}

/* A bank cell's candidates (js/bankcells.js): those in its window first,
 * re-ranked among themselves by the picture that holds together best
 * (seamScore), within NEAR_TIE keeping the table's order. */
function bySeams(rom, cell, full) {
    const win = full.filter((r) => r.window);
    if (win.length < 2) return full;
    const score = new Map(win.map((r) => [r.cg, seamScore(renderCell(rom, cell, [r.cg]))]));
    const best = Math.min(...score.values());
    const near = (r) => (score.get(r.cg) <= best * NEAR_TIE ? 0 : 1);
    win.sort((a, b) => near(a) - near(b) || (near(a) ? score.get(a.cg) - score.get(b.cg) : 0) || a.cg - b.cg);
    return win.concat(full.filter((r) => !r.window));
}

function rankSharedCGs(rom, cell, c) {
    const cover = cgCover(rom);
    const used = new Map();
    for (const e of c.entries) {
        if (e & CHAR_MASK) used.set(e & 0x7fff, (used.get(e & 0x7fff) || 0) + 1);
    }
    let total = 0;
    for (const n of used.values()) total += n;
    const out = [];
    for (let cg = 0; cg < cover.length; cg++) {
        const k = cover[cg];
        if (!k || !total) continue;
        let hit = 0;
        for (const [e, n] of used) {
            const group = (e >> 7) & 0xff;
            if (inRuns(k.charRuns, e & CHAR_MASK) && inRuns(k.palRuns, group * 16 + 1)) hit += n;
        }
        if (hit) out.push({ cg, cover: hit / total });
    }
    const game = gameCGs(rom).get(cell);
    const own = (r) => (r.cg === game ? 0 : 1);
    out.sort((a, b) => b.cover - a.cover || own(a) - own(b) || a.cg - b.cg);
    const full = out.filter((r) => r.cover === 1);
    if (full.length < 2 || full[0].cg === game) return out;
    /* No table names one: the picture that holds together best. */
    const score = new Map(full.map((r) => [r.cg, seamScore(renderCell(rom, cell, [r.cg]))]));
    const best = Math.min(...score.values());
    const near = (r) => (score.get(r.cg) <= best * NEAR_TIE ? 0 : 1);
    full.sort((a, b) => near(a) - near(b) || (near(a) ? score.get(a.cg) - score.get(b.cg) : 0) || a.cg - b.cg);
    return full.concat(out.slice(full.length));
}

/* A CG that writes a cell's characters with another picture's tiles still
 * "fits" it, but draws a jumble: its tiles don't run on into each other. The
 * score is how much colour changes across the edges between tiles, against
 * how much it changes inside them; a right picture is near 1 or below, a
 * jumble well above. Almost no bright pixels is a starfield that one CG lays
 * over another picture's characters, and scores low only because it is dark;
 * it counts as a jumble. Scores within NEAR_TIE of the best are the same
 * picture in other colours (a colour card and its greyscale twin), and the
 * lower CG wins. */
const NEAR_TIE = 1.1;
function seamScore({ width: w, height: h, rgba: p }) {
    let lit = 0, opaque = 0;
    for (let k = 0; k < p.length; k += 4) {
        if (!p[k + 3]) continue;
        opaque++;
        if (Math.max(p[k], p[k + 1], p[k + 2]) > 96) lit++;
    }
    if (!opaque) return Infinity;
    const diff = (a, b) => {
        if (!p[a + 3] && !p[b + 3]) return -1;
        if (p[a + 3] !== p[b + 3]) return 255;
        return Math.abs(p[a] - p[b]) + Math.abs(p[a + 1] - p[b + 1]) + Math.abs(p[a + 2] - p[b + 2]);
    };
    let edge = 0, edges = 0, inner = 0, inners = 0;
    const add = (v, onEdge) => {
        if (v < 0) return;
        if (onEdge) { edge += v; edges++; } else { inner += v; inners++; }
    };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (x + 1 < w) add(diff(o, o + 4), (x & 7) === 7);
            if (y + 1 < h) add(diff(o, o + w * 4), (y & 7) === 7);
        }
    }
    const score = (edge / Math.max(edges, 1)) / (1 + inner / Math.max(inners, 1));
    return score + (lit < opaque * 0.05 ? 1 : 0);
}

/**
 * Draw a cell as the tile chip would with these CGs loaded, in order.
 *
 * @param {object} rom
 * @param {number} cell
 * @param {number[]} cgs     CG numbers, loaded one after another as the game
 *                           does; a later one overwrites what it shares
 * @param {?Uint8Array} cxlat  colour tables to put the palette through, as
 *                           palette_w does; null for the raw colours
 * @returns {null|{width:number, height:number, rgba:Uint8ClampedArray}}
 */
export function renderCell(rom, cell, cgs, cxlat = null) {
    const c = readCell(rom, cell);
    if (!c) return null;
    const charBytes = rom.game.cells.charBytes;
    const chars = new Uint8Array(charBytes);
    const pal = new Uint16Array(0x8000);
    for (const cg of cgs) {
        const L = cgLists(rom, cg);
        if (!L) continue;
        const r = loadCG(rom, L);
        for (const [first, n] of r.charRuns) {
            chars.set(r.chars.subarray(first * TILE_BYTES, (first + n) * TILE_BYTES), first * TILE_BYTES);
        }
        for (const [first, n] of r.palRuns) {
            const a = Math.max(first, 0), b = Math.min(first + n, pal.length);
            if (b > a) pal.set(r.pal.subarray(a, b), a);
        }
    }

    const width = c.cols * 8, height = c.rows * 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const rgb = new Int32Array(0x8000).fill(-1);
    for (let ty = 0; ty < c.rows; ty++) {
        for (let tx = 0; tx < c.cols; tx++) {
            const entry = c.entries[ty * c.cols + tx];
            const base = (entry & CHAR_MASK) * TILE_BYTES;
            const group = (entry >> 7) & 0xff;
            if (base + TILE_BYTES > chars.length) continue;
            for (let py = 0; py < 8; py++) {
                for (let px = 0; px < 8; px++) {
                    /* A halfword's left pixels are in its second byte; see
                     * js/scroll.js. */
                    const byte = chars[base + py * 4 + ((px >> 1) ^ 1)];
                    const nib = (px & 1) ? (byte & 15) : (byte >> 4);
                    if (!nib) continue;
                    const v = pal[group * 16 + nib] & 0x7fff;
                    if (rgb[v] < 0) {
                        const [r, g, b] = palette555ToBytes(cxlat, v);
                        rgb[v] = (r << 16) | (g << 8) | b;
                    }
                    const o = ((ty * 8 + py) * width + tx * 8 + px) * 4;
                    rgba[o] = rgb[v] >> 16;
                    rgba[o + 1] = (rgb[v] >> 8) & 255;
                    rgba[o + 2] = rgb[v] & 255;
                    rgba[o + 3] = 255;
                }
            }
        }
    }
    return { width, height, rgba };
}

/*
 * Last Bronx's stage sky (games.js `stageTable.lastbrnx.sky`): tilemap B, its
 * two layers joined top to bottom, behind the 3D. The stage's set-up (0x44CD0)
 * loads CG directory `cgs[stage]` and has 0x44910 build a panorama in RAM
 * (0x56DDC0), 256 columns of 128 entries; each frame 0x44EC0 scrolls it and
 * 0x44DE0 streams the columns that came into view into the tile RAM. One turn
 * of the camera is the panorama's 2048 pixels.
 *
 * The builder takes `lists[stage]`, 128 bytes: two halves (rows 0-63 and
 * 64-127), each four blocks of 64 columns, each block four cell scripts
 * (0x14CD0, `runScript`) at its corners: +0 the top left of a 64 by 64
 * scratch tilemap, +4 32 rows down, +8 32 columns on, +0xC both; a 0 is none.
 * A half whose first block is all 0 ends the build, or for the second half
 * repeats each column's first entry down it. Cross Street (`stretch`) then
 * copies each column's row 96 over its rows 32 to 95.
 */
const SKY_COLS = 256, SKY_ROWS = 128;

function skyBlock(rom, scripts) {
    const scratch = new Uint16Array(64 * 64);
    [0, 32 * 64, 32, 32 * 64 + 32].forEach((base, k) => {
        const r = scripts[k] ? runScript(rom, scripts[k]) : null;
        for (const [at, e] of r?.out ?? []) {
            const i = base + at;
            if (i >= 0 && i < scratch.length) scratch[i] = e;
        }
    });
    return scratch;
}

/* The panorama's entries, column by column, as 0x44910 leaves them. */
function lastbrnxSkyMap(rom, S, ram, stage) {
    const map = new Uint16Array(SKY_COLS * SKY_ROWS);
    const list = S.lists + stage * 128;
    for (let half = 0; half < 2; half++) {
        const words = Array.from({ length: 16 }, (_, k) => ram(list + half * 64 + k * 4));
        if (words.slice(0, 4).every((w) => !w)) {
            for (let c = 0; half && c < SKY_COLS; c++) map.fill(map[c * SKY_ROWS], c * SKY_ROWS + 64, (c + 1) * SKY_ROWS);
            break;
        }
        for (let block = 0; block < 4; block++) {
            const scratch = skyBlock(rom, words.slice(block * 4, block * 4 + 4));
            for (let c = 0; c < 64; c++) {
                for (let r = 0; r < 64; r++) map[(block * 64 + c) * SKY_ROWS + half * 64 + r] = scratch[r * 64 + c];
            }
        }
    }
    if (stage === S.stretch) {
        for (let c = 0; c < SKY_COLS; c++) map.fill(map[c * SKY_ROWS + 96], c * SKY_ROWS + 32, c * SKY_ROWS + 96);
    }
    return map;
}

/* Draws the panorama's entries with the stage's CG. */
function drawSkyMap(map, cg, cxlat) {
    const width = SKY_COLS * 8, height = SKY_ROWS * 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const rgb = new Int32Array(0x8000).fill(-1);
    for (let i = 0; i < map.length; i++) {
        const entry = map[i], base = (entry & CHAR_MASK) * TILE_BYTES, group = (entry >> 7) & 0xff;
        if (base + TILE_BYTES > cg.chars.length) continue;
        const x0 = Math.floor(i / SKY_ROWS) * 8, y0 = (i % SKY_ROWS) * 8;
        for (let p = 0; p < 64; p++) {
            const py = p >> 3, px = p & 7;
            const byte = cg.chars[base + py * 4 + ((px >> 1) ^ 1)];
            const nib = (px & 1) ? (byte & 15) : (byte >> 4);
            if (!nib) continue;
            const v = cg.pal[group * 16 + nib] & 0x7fff;
            if (rgb[v] < 0) {
                const [r, g, b] = palette555ToBytes(cxlat, v);
                rgb[v] = (r << 16) | (g << 8) | b;
            }
            const o = ((y0 + py) * width + x0 + px) * 4;
            rgba[o] = rgb[v] >> 16;
            rgba[o + 1] = (rgb[v] >> 8) & 255;
            rgba[o + 2] = rgb[v] & 255;
            rgba[o + 3] = 255;
        }
    }
    return { width, height, rgba };
}

/* The mean colour of the panorama's top row, which the sky shows above it. */
function topRowColor({ width, rgba }) {
    const sum = [0, 0, 0];
    let n = 0;
    for (let x = 0; x < width; x++) {
        if (!rgba[x * 4 + 3]) continue;
        for (let k = 0; k < 3; k++) sum[k] += rgba[x * 4 + k];
        n++;
    }
    return n ? sum.map((s) => Math.round(s / n)) : [0, 0, 0];
}

/**
 * Last Bronx stage `stage`'s sky as a panorama (app.js addSkyPanorama), or
 * null for a stage with none. Level, 0x44EC0's vertical scroll is the stage's
 * `scroll` word (+0xC of its 16 bytes), so the eye line, screen line 192,
 * shows row scroll + 192; tilting moves it by `focal` pixels a unit of
 * tangent. Its horizontal scroll is 0x800 - heading / 32 with a turn 0x10000,
 * so at heading 0 the screen's middle, column 248, shows column 248.
 */
export function lastbrnxSky(rom, stage, cxlat = null) {
    const S = rom.game.stageTable.lastbrnx?.sky;
    const D = rom.game.texture?.raw?.data;
    if (!S || !D || !rom.game.cells?.groups) return null;
    const ram = (a) => rom.mainCpuView.getUint32(D.rom + a - D.ram, true);
    const dir = ram(S.cgs + stage * 4);
    if (!dir) return null;
    const cg = loadDirs(rom, [rom.game.cells.groups.boot, dir], rom.game.cells.charBytes);
    const pano = drawSkyMap(lastbrnxSkyMap(rom, S, ram, stage), cg, cxlat);
    /* The layer wraps top to bottom, and the scroll is held within 512 lines
     * of the stage's either way: so the strip is the 1024 rows from 512
     * above the eye line's, and what shows over the top is its top row. */
    const half = pano.height / 2;
    const first = (ram(S.scroll + stage * 16 + 12) + 192 - half) & (pano.height - 1);
    const row = pano.width * 4;
    const rgba = new Uint8ClampedArray(pano.rgba.length);
    rgba.set(pano.rgba.subarray(first * row));
    rgba.set(pano.rgba.subarray(0, first * row), (pano.height - first) * row);
    const out = { ...pano, rgba };
    return { ...out, horizon: half, focal: S.focal, centre: 248, topColor: topRowColor(out) };
}
