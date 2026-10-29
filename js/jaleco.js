/*
 * jaleco.js — Jaleco's Model 2B/2C racers, Super GT 24h (1996) and Over Rev
 * (1997), built on one framework: the same "../h/globl.h" and "define.h"
 * fault strings, the same model table export (16-byte entries, then a list of
 * 0x1C-stride pointers into data 0x800000), and the same texture loader,
 * which is what this file is.
 *
 * Nothing is packed. A loader (sgt24h 0x5A2B0 for sheet 0 and 0x5A470 for
 * sheet 1, Over Rev 0x120F0 and 0x122B0) takes a data ROM address and blits
 * (sgt24h 0x5A630, Over Rev 0x12470) its first 0x80000 bytes, 512 by 512
 * halfwords, to the sheet's first half, then the next 0x80000 bytes as ten
 * mip rectangles split between the two sheets' second halves, 0x11080000 and
 * 0x11280000 (sheet 1's loader the other way round from sheet 0's), so the two
 * chains interleave. The blit's source offset is its destination offset, a
 * row of 512 halfwords; its loop (`cmpible`) copies one 16-byte quad past
 * each row's end, and on the Model 2B, where 0x11100000 mirrors 0x11000000,
 * a quad past the end of a sheet lands at its start. After it the loader sets
 * the first eight halfwords of 0x11000000 to 0xFFFF.
 *
 * Over Rev first runs 0x12080, which copies the data ROM's first 0x100000
 * halfwords to 0x11000000 a halfword every four bytes, through all four MB
 * of the two sheets and their mirrors. The loads go over most of it; what
 * they leave shows.
 *
 * Checked against MAME's texture RAM: Super GT 24h in the attract (frames
 * 300 to 2700, set 0) and Over Rev on both boards at the title (sheet 0 and
 * the fill only) and in the attract race (data 0x200000 on sheet 1), no
 * halfword different but sixteen bytes Over Rev's attract writes over the
 * start of sheet 0 and at sheet 1 0xC0000 later, by code not traced.
 */

import { gameLighting } from './stages.js';

const SHEET_BYTES = 0x100000;
const ROW = 0x400;                    /* 512 halfwords */
const HALF = 0x80000;
const MAIN_DATA_BASE = 0x02000000;

/* [quarter, x0, y0, x1, y1] for sheet 0's loader; A is 0x11080000 (sheet 0's
 * second half) and B 0x11280000. Sheet 1's loader swaps A and B. */
const A = 0, B = 1;
const MIPS = [
    [A, 0, 0, 511, 255], [B, 0, 256, 255, 511], [B, 256, 256, 511, 383], [A, 256, 384, 383, 511],
    [A, 384, 384, 511, 447], [B, 384, 448, 447, 511], [B, 448, 448, 511, 479], [A, 448, 480, 479, 511],
    [A, 480, 480, 511, 495], [B, 480, 496, 511, 511],
];

/* `window` is how far a write can run before it wraps: the 2B's 1 MB sheet
 * (the mirror), the 2C's 2 MB share, of which the renderer reads the first. */
function blit(md, src, sheet, base, [x0, y0, x1, y1], window) {
    const n = ((((x1 + 1 - x0) * 2) >> 4) + 1) << 4;
    for (let y = y0; y <= y1; y++) {
        const o = (y * 512 + x0) * 2;
        for (let k = 0; k < n; k++) {
            const at = (base + o + k) % window;
            if (at < SHEET_BYTES && src + o + k < md.length) sheet[at] = md[src + o + k];
        }
    }
}

function load(md, sheets, src, which, window) {
    blit(md, src, sheets[which], 0, [0, 0, 511, 511], window);
    for (const [q, ...rect] of MIPS) {
        blit(md, src + HALF, sheets[which ? q ^ 1 : q], HALF, rect, window);
    }
    sheets[0].fill(0xff, 0, 16);
}

/**
 * Texture RAM with set `texSets` (the last one named) on sheet 1.
 * `raw`: {sheet0, sets: [data address for sheet 1 by set], fill, window}.
 */
export function buildJalecoTexram(rom, texSets) {
    const raw = rom.game.texture.raw;
    const md = rom.mainData;
    const sets = [].concat(texSets).filter((s) => s >= 0 && s < raw.sets.length);
    const set = sets.length ? sets[sets.length - 1] : rom.game.texture.defaultSet;
    const tex = new Uint8Array(SHEET_BYTES * 2);
    const sheets = [tex.subarray(0, SHEET_BYTES), tex.subarray(SHEET_BYTES)];
    const window = raw.window ?? SHEET_BYTES;
    if (raw.fill) {
        /* 0x12080: halfword i to 0x11000000 + 4i, i of 0..0xFFFFF. */
        for (let i = 0; i < 0x100000; i++) {
            const a = i * 4;
            const s = a >= 0x200000 ? 1 : 0;
            const at = (a & 0x1fffff) % window;
            if (at < SHEET_BYTES) {
                sheets[s][at] = md[i * 2];
                sheets[s][at + 1] = md[i * 2 + 1];
            }
        }
    }
    load(md, sheets, raw.sheet0 - MAIN_DATA_BASE, 0, window);
    load(md, sheets, raw.sets[set] - MAIN_DATA_BASE, 1, window);
    return { sheet0: sheets[0], sheet1: sheets[1], pages: 2 };
}

/*
 * The courses (Stages tab). Both games draw a course the same way: a course
 * is a few grid records, {cell width, cell depth (floats, 50 in Super GT 24h,
 * 75 in Over Rev), columns, rows, first column, last column, first row, last
 * row, grid}, and the grid is a word a cell, the model drawn there or 0. The
 * camera's cell picks a list of 6-byte records {column, row, kind} ended by
 * 0xFF (the potentially visible cells round it, by distance band), and every
 * record draws, out of each grid record of that kind, the model in the cell
 * it names, under the camera's matrix and nothing more: the models are in
 * world space, as Daytona USA's blocks are, and a course is its grids drawn
 * where they lie.
 *
 * Super GT 24h: 0x46B4 calls the band routine (one of fourteen at 0xEC6A0,
 * 0x2450 the one the attract runs) that 0x11C0's tables pick for the cell,
 * and it draws through 0x72C90 out of `(0x517B20[course])[kind]`, a list of
 * `0x517AF0[course][kind]` grid records; 0x2FC0 points them at the program's
 * lists at 0xEC66C (twelve bytes a course) and counts at 0xEC630 (sixteen).
 * All three kinds name the same record (0x282A360, 0x284A3C0, 0x286A420,
 * 0x288A480), a 128 by 128 grid. Over Rev's code runs from RAM, ROM +
 * 0x480000: 0xCD660 (RAM 0x54D660) draws through 0x60060 out of
 * `0x5A16B0[course]`, which 0xCC6D0 points at the lists at 0xEDF90, 0xEDFA0,
 * 0xEDFC0 and 0xEDFD8, the counts at 0xEDF50 (sixteen bytes a course). There
 * kind 0 lists two or three records, the near cells' (a course and its
 * trackside), kinds 1 and 2 the far cells' with less in them (Shibuya's
 * 0x2817C40 is 0x2818120 with one model fewer); kind 0 is read here.
 *
 * `courses`: per course {name, list, count, set}, or {records, count} where
 * the program has a table of them: Over Rev's 0x1C-byte records at 0xCD8B0,
 * {texture source, course, luma variant, name}. The course set-up (RAM
 * 0x54D960) loads sheet 1 from +0 (0x122B0) and runs 0x564EF0 on +8, which
 * copies the course's own luma bands (js/games.js); it takes record 4 or 5
 * for course 1 or 2 when 0x590DD0 is set, so two of the six (Shibuya and
 * Touge's other versions) draw the same grids on their own sheet.
 */
function courseList(rom) {
    const C = rom.game.stageTable.jaleco;
    const cv = rom.mainCpuView;
    const raw = rom.game.texture.raw;
    const setOf = (src) => raw.sets.indexOf(src);
    if (!C.records) return C.courses.map((c, i) => ({ ...c, set: setOf(cv.getUint32(C.textures + i * 4, true)), course: i }));
    const out = [];
    for (let i = 0; i < C.records.count; i++) {
        const r = C.records.at + i * C.records.stride;
        let name = '';
        for (let k = 12; k < C.records.stride; k++) {
            const b = rom.maincpu[r + k];
            if (!b) break;
            name += String.fromCharCode(b);
        }
        const course = cv.getUint32(r + 4, true);
        out.push({ name: name.trim(), ...C.courses[course], course, set: setOf(cv.getUint32(r, true)), luma: cv.getUint32(r + 8, true) });
    }
    return out;
}

/* The grid records course `c` draws its near cells from: the list's
 * `count` pointers into the data ROM. */
function gridRecords(rom, c) {
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const n = cv.getUint32(c.count, true);
    const out = [];
    for (let i = 0; i < n; i++) {
        const g = cv.getUint32(c.list + i * 4, true) - MAIN_DATA_BASE;
        out.push({
            at: g + MAIN_DATA_BASE,
            cols: dv.getUint32(g + 8, true),
            rows: dv.getUint32(g + 12, true),
            grid: dv.getUint32(g + 0x20, true) - MAIN_DATA_BASE,
        });
    }
    return out;
}

/* Every model a course draws: the grids' cells, then the trackside pieces
 * the game draws by course (Super GT 24h: the course's own of the sixteen
 * {model, course} pairs at 0xEFE60, which 0x4AC10 draws when the camera's
 * cell has their bit in 0xEDF60, and the one 0x4CDE0 draws every frame out
 * of 0xF0120[course] at the start of the race). */
function courseModels(rom, c) {
    const C = rom.game.stageTable.jaleco;
    const dv = rom.mainDataView, cv = rom.mainCpuView;
    const count = rom.game.modelTable.count;
    const models = [];
    for (const g of gridRecords(rom, c)) {
        for (let i = 0; i < g.cols * g.rows; i++) {
            const m = dv.getUint32(g.grid + i * 4, true);
            if (m && m < count) models.push({ model: m, cell: i, grid: g.at });
        }
    }
    for (const t of C.trackside ?? []) {
        for (let i = 0; i < t.count; i++) {
            const m = cv.getUint32(t.at + i * t.stride, true);
            const on = t.stride === 8 ? cv.getUint32(t.at + i * 8 + 4, true) === c.course : i === c.course;
            if (on && m && m < count) models.push({ model: m, trackside: t.at });
        }
    }
    return models;
}

/** The courses, one stage each, on the set the game loads for it. */
export function readJalecoStages(rom) {
    const lit = gameLighting(rom);
    return courseList(rom).map((c, slot) => {
        const models = courseModels(rom, c);
        const draws = models.map((m) => ({ model: m.model, pos: [0, 0, 0], set: c.set }));
        const grids = new Set(models.filter((m) => m.grid).map((m) => m.grid.toString(16)));
        return {
            slot,
            placements: true,
            mixedSets: false,
            num: slot,
            name: c.name,
            chapter: slot,
            draws,
            objects: [],
            sky: null,
            panorama: null,
            views: null,
            texSets: [c.set],
            /* The colour set is the course's luma variant (Over Rev); Super
             * GT 24h's courses keep the boot's. */
            texSet: [c.set, c.luma ?? 0],
            tint: [1, 1, 1],
            bright: 1,
            /* The material table is not read yet: every face at full
             * ambient, as the Models tab draws them. */
            light: lit?.light ?? [0, 1, 0],
            materials: lit?.materials ?? Array.from({ length: 32 }, () => ({ diffuse: 0, ambient: 255 })),
            colorCycles: [],
            flags: 0,
            floorSize: 0,
            bgColor555: 0,
            meta: [['course', c.course], ['texture set', c.set], ...(c.luma != null ? [['luma variant', c.luma]] : []), ['grids', [...grids].join(', ')],
                ['cells', models.filter((m) => m.grid).length], ['trackside', models.filter((m) => m.trackside).length]],
        };
    });
}

/*
 * Which set a model is drawn under, for the Models tab: the course whose
 * grids or trackside name it. A model on two courses' lists (Over Rev's
 * Shibuya and Touge, drawn on two sheets each) takes the first.
 */
let courseSetsFor = null, courseSetsMap = null;
export function jalecoCourseSets(rom) {
    if (courseSetsFor === rom) return courseSetsMap;
    const map = new Map();
    if (rom.game.stageTable?.jaleco) {
        for (const c of courseList(rom)) {
            for (const m of courseModels(rom, c)) if (!map.has(m.model)) map.set(m.model, c.set);
        }
    }
    courseSetsFor = rom;
    courseSetsMap = map;
    return map;
}
