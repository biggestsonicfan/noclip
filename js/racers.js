/*
 * racers.js — the courses of Manx TT Superbike, Sega Touring Car
 * Championship and INDY 500, read straight from their ROMs.
 *
 * All three keep Sega Rally's idea (js/stages.js readRallyStages): a course
 * is a run of segment models, each drawn with no matrix (`st 0x101,
 * 0x800010` before the model's four words go to 0x804000), so the geometry
 * is in world space and a course is its list drawn where it lies. The
 * game's draw only walks a window of the list round the car; here every
 * segment is drawn. Each keeps its own record for the list:
 *
 * Manx TT (game.stageTable.racer.kind 'manxtt'): 20-byte records at 0x401E0,
 *   picked by 0x40258 (g0 the record) into 0x579640: +0 the segment list,
 *   +4 and +8 the first and last segment the walk may start from, +0xC the
 *   sky model (0x40520 draws it, `ld 0x401EC[k*20]`), +0x10 the list's
 *   length. The draw is 0x40280: from the car's segment (0x3AA08) forward
 *   and back while the polygon budget lasts. A race's course is 0x513FF0:
 *   0 is record 1, 1 is record 2 (0x1B56C, and the attract's 0x274FC);
 *   record 3 is record 2 again and record 4 is record 1 under sky 2125.
 *
 * STCC ('stcc'): 0x3F4-byte records at 0xBEB0, set up by 0xAA10 into
 *   0x202630 (the number) and 0x202634 (the pointer); +0 and +4 the texture
 *   pair it deals, +8 a table of 20-byte {first, last, routine, ?, argument}
 *   entries the draw calls by segment range (the trackside scenes), +0xC the
 *   sixty segments, +0x100 their low-detail copies (drawn every so often
 *   when +0xFC is set), and +0x1F4 a second model per segment drawn with
 *   the first when +0x1F0 is set. The draw is 0xAEA0 (`remi 60`, a lap is
 *   sixty segments).
 *
 * INDY 500 ('indy500'): 24-byte records at 0x6A5B0 by course (0x16C68,
 *   0x16E38) into 0x5447AC; +0 and +4 point at {count, list} pairs in the
 *   data ROM, +0x10 and +0x14 the texture banks (0x16F50). The draw is
 *   0x4DD10: the TGP's command 0x4D finds the car's segment, and that one
 *   and the two beside it come from +4's list, the rest from +0's (the
 *   low-detail ones). Model numbers index the model table the boot copies
 *   to RAM 0x200000 (0x3BC20), the data ROM's at 0xC00460, entry for entry.
 */
import { gameLighting } from './stages.js';
import { MAIN_DATA_BASE } from './romset.js';

function stage(rom, lit, { num, name, draws, set, colorSet = set, meta }) {
    return {
        slot: num,
        placements: true,
        mixedSets: false,
        num,
        name,
        chapter: num,
        draws,
        objects: [],
        sky: null,
        panorama: null,
        views: null,
        texSets: [set],
        texSet: [set, colorSet],
        tint: [1, 1, 1],
        bright: 1,
        light: lit.light,
        materials: lit.materials,
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        bgColor555: 0,
        meta,
    };
}

/* The list's models, each where it lies; 0 is an empty segment. */
function segments(rom, word, at, n, set, out = []) {
    for (let i = 0; i < n; i++) {
        const m = word(at + i * 4);
        if (!m || m >= rom.game.modelTable.count) continue;
        out.push({ model: m, pos: [0, 0, 0], set, block: i });
    }
    return out;
}

function readManxCourses(rom, C) {
    const cv = rom.mainCpuView;
    const word = (a) => cv.getUint32(a, true);
    const lit = gameLighting(rom);
    return C.courses.map((c, num) => {
        const rec = C.records + c.record * 20;
        const draws = segments(rom, word, word(rec), word(rec + 0x10), c.set);
        const sky = word(rec + 0xc);
        draws.unshift({ model: sky, pos: [0, 0, 0], set: c.set, layer: 'sky', layered: false });
        return stage(rom, lit, {
            num, name: c.name, draws, set: c.set,
            meta: [['record', c.record], ['segments', draws.length - 1], ['sky', sky]],
        });
    });
}

function readStccCourses(rom, C) {
    const cv = rom.mainCpuView;
    const word = (a) => cv.getUint32(a, true);
    const lit = gameLighting(rom);
    return C.courses.map((c, num) => {
        const rec = C.records + c.record * C.stride;
        const draws = segments(rom, word, rec + 0xc, 60, c.set);
        /* 0xB10C: the second model goes with its segment when +0x1F0 is set. */
        if (word(rec + 0x1f0)) segments(rom, word, rec + 0x1f4, 60, c.set, draws);
        return stage(rom, lit, {
            num, name: c.name, draws, set: c.set,
            meta: [['record', c.record], ['segments', `${word(rec + 0xc)}..${word(rec + 0xc + 59 * 4)}`],
                ['second', word(rec + 0x1f0) ? word(rec + 0x1f4) : '-']],
        });
    });
}

function readIndyCourses(rom, C) {
    const cv = rom.mainCpuView;
    const dv = rom.mainDataView;
    const word = (a) => (a >= MAIN_DATA_BASE ? dv.getUint32(a - MAIN_DATA_BASE, true) : cv.getUint32(a, true));
    const lit = gameLighting(rom);
    return C.courses.map((c, num) => {
        const rec = C.records + c.record * 24;
        /* +4's list is the full-detail one (0x4DE10). */
        const pair = word(rec + 4);
        const n = word(pair);
        const draws = segments(rom, word, word(pair + 4), n, c.set);
        return stage(rom, lit, {
            num, name: c.name, draws, set: c.set,
            meta: [['course', c.record], ['segments', n], ['list', `0x${word(pair + 4).toString(16)}`]],
        });
    });
}

/**
 * The courses of the racers that keep a segment list per course.
 *
 * @param {object} rom loaded ROM set
 * @returns {object[]} stages
 */
export function readRacerStages(rom) {
    const C = rom.game.stageTable.racer;
    if (C.kind === 'manxtt') return readManxCourses(rom, C);
    if (C.kind === 'stcc') return readStccCourses(rom, C);
    return readIndyCourses(rom, C);
}

/**
 * Which course's set each course model is drawn under, for the Models tab:
 * a model in a course's lists opens on that course's texture set.
 *
 * @param {object} rom loaded ROM set
 * @returns {Map<number, number>} model -> texture set
 */
export function racerCourseModels(rom) {
    if (rom.racerCourses) return rom.racerCourses;
    const map = new Map();
    for (const s of readRacerStages(rom)) {
        for (const d of s.draws) if (!map.has(d.model)) map.set(d.model, d.set);
    }
    rom.racerCourses = map;
    return map;
}
