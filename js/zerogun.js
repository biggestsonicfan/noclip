/*
 * zerogun.js — Zero Gunner's stages, read from the scene records.
 *
 * The course table (0x6EE28 in `zerogun`, 0x6EFA8 in `zerogunj`, 0x6E1E8 in
 * `zeroguna`; the program runs from RAM at 0x500000, so its pointers are
 * 0x500000 past the ROM offset) holds five words: a list of scene records for
 * each course the title screen offers. The strings at 0x26DD0 name them:
 * the Asia, America and Europe courses of five stages each (全5ステージ),
 * the expert course (上級者コース) of ten, which takes the first two stages of
 * each and four of the rest, and a fifth list of scenes with no scenery of
 * their own (the demo and the ending). A scene record is 0x28 bytes and then
 * its script; 0x62EB0, 0x63010 and 0x63130 set it up:
 *
 * - +4/+8/+0xC: the camera's start, floats, to 0x502520;
 * - +0x10/+0x12: two of its turns, to 0x502564 and 0x502504;
 * - +0x20/+0x22: the two terrain blocks, to 0x502512 and 0x502510;
 * - +0x24/+0x26: the texture loads of kind 1 and 2 (0x62F6C), the pair
 *   games.js's sets list by.
 *
 * 0x4367C calls 0x42FC0 every frame both blocks are 0 or more (0x7390 and
 * 0x4B300 set them to -1). It walks the list the word at 0x20C70D0 + 8 * block
 * points at, model numbers until a negative one, for the first block and
 * then the second; each is culled by the sphere at +0x30 of the record the
 * word at 0x2078700 + 4 * model points at (copro function 0x27) and drawn by
 * 0x4D3A0 with no translation of its own, only the camera's. The numbers are
 * the model table's, so a stage is those models at the origin. The second
 * word of a block's entry is 1 for the first block and 0 for the second; the
 * first is the ground and water, the second what stands on it.
 *
 * The rest of a scene (the huts, boats and enemies its script places) is not
 * read here.
 */
import { gameLighting, stageLight } from './stages.js';

const BLOCKS = 0x20c70d0;
const SPHERES = 0x2078700;
const COURSE_NAMES = ['Asia', 'America', 'Europe'];
/* The light's two turns, 0x2000 and 0x8000 at 0x502566/0x502568 in the
 * scenes MAME has shown; copro function 0x2B turns them by the camera and the
 * frame's function 0xA sends the result (0x4362C). How the copro reads them
 * is not worked out: the vector they make here, reversed, lights the Asia
 * course's first scene as MAME's attract does, and that is all it is. */
const LIGHT_TURNS = [0x2000, 0x8000];

function reader(rom) {
    const cv = rom.mainCpuView, dv = rom.mainDataView;
    const u32 = (a) => (a >= 0x2000000 ? dv.getUint32(a - 0x2000000, true)
        : cv.getUint32(a >= 0x500000 ? a - 0x500000 : a, true));
    return {
        u32,
        i32: (a) => u32(a) | 0,
        u16: (a) => cv.getUint16(a >= 0x500000 ? a - 0x500000 : a, true),
        f32: (a) => (a >= 0x2000000 ? dv.getFloat32(a - 0x2000000, true)
            : cv.getFloat32(a >= 0x500000 ? a - 0x500000 : a, true)),
    };
}

/* A block's models (0x42FC0). */
function blockModels(r, block) {
    const out = [];
    for (let a = r.u32(BLOCKS + block * 8); r.i32(a) >= 0 && out.length < 4096; a += 4) out.push(r.u32(a));
    return out;
}

function readScene(rom, r, lit, rec, slot, name, used) {
    const sets = rom.game.texture.raw.sets;
    const load = [r.u16(rec + 0x24), r.u16(rec + 0x26)];
    const set = Math.max(0, sets.findIndex((p) => p[0] === load[0] && p[1] === load[1]));
    const ground = r.u16(rec + 0x20), above = r.u16(rec + 0x22);
    const draws = [];
    for (const [block, layer] of [[ground, 'ground'], [above, 'scenery']]) {
        for (const model of blockModels(r, block)) {
            draws.push({ model, pos: [0, 0, 0], set, layer, zones: new Set([0]) });
        }
    }
    const start = [r.f32(rec + 4), r.f32(rec + 8), r.f32(rec + 0xc)];
    return {
        slot,
        placements: true,
        mixedSets: false,
        num: slot + 1,
        name,
        chapter: 0,
        draws,
        objects: [],
        sky: null,
        panorama: null,
        zones: [{ zone: 0, set, label: `${draws.length} pieces` }],
        views: [['all', 'The whole scene']],
        view: 'all',
        union: 'all',
        texSets: [set],
        texSet: [set, set],
        tint: [1, 1, 1],
        bright: 1,
        light: stageLight(1, LIGHT_TURNS[0], LIGHT_TURNS[1]).map((v) => -v),
        materials: lit?.materials ?? [],
        colorCycles: [],
        flags: 0,
        floorSize: 0,
        meta: [['record', `0x${(rec - 0x500000).toString(16).toUpperCase()}`],
            ['blocks', `0x${ground.toString(16).toUpperCase()} (ground), 0x${above.toString(16).toUpperCase()}`],
            ['texture loads', `${load[0]}, ${load[1]} (set ${set})`],
            ['camera start', start.map((v) => v.toFixed(1)).join(', ')],
            ['courses', used.join('; ')]],
    };
}

/**
 * Zero Gunner's fifteen scenes, the three five-stage courses in order; the
 * expert course plays ten of the same records, which each one's notes list.
 */
export function readZerogunStages(rom) {
    const r = reader(rom);
    const lit = gameLighting(rom);
    const table = rom.game.stageTable.zerogun.courses;
    const used = new Map();
    const order = [];
    for (let c = 0; c < 4; c++) {
        const list = r.u32(table + c * 4);
        const n = c === 3 ? 10 : 5;
        for (let k = 0; k < n; k++) {
            const rec = r.u32(list + k * 4);
            if (!used.has(rec)) { used.set(rec, { course: c, stage: k, in: [] }); order.push(rec); }
            used.get(rec).in.push(c === 3 ? `expert stage ${k + 1}` : `${COURSE_NAMES[c]} stage ${k + 1}`);
        }
    }
    return order.filter((rec) => used.get(rec).course < 3).map((rec, slot) => {
        const u = used.get(rec);
        return readScene(rom, r, lit, rec, slot, `${COURSE_NAMES[u.course]} course · Stage ${u.stage + 1}`, u.in);
    });
}
