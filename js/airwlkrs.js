/*
 * airwlkrs.js — Air Walkers' courts, read by running the game's own court
 * code.
 *
 * A court is the home team's: the match set-up (0xD048C) takes the court
 * from the home side's team byte (0x5136D0) and the variant from that team's
 * record, byte +12 of `0xFBA80 + 20 * team` (+0 the city's name, +4 the
 * nickname's). Seventeen teams, so seventeen courts; the debug cycler at
 * 0x29C88 steps the same 0..16.
 *
 * Two routines make one:
 *   0x247D0 (court, variant)  the set-up: the court's colours and palette
 *            block, the boot pages again, and the variant's two models
 *            (0x521774 = `ld 0xF8280[v*4]` the hoops' padding, 0x52178C =
 *            `ld 0xF8290[v*4]` the court's) for the draw to use;
 *   0x24DA0 (court)  the draw, each frame (0xBA4): the arena, the stands'
 *            crowd (`ld 0xF19C0` / `0xF19A0` by the frame 0x521784 counts),
 *            the variant's model, the players (0x23850, once each), the
 *            floor `ld 0xF8230[court*4]`, the two hoops (0x24640, the second
 *            turned 0x8000 about Y) with the scoreboards over them (0x24940),
 *            and the ball and the rest the play has out (0x25B90).
 *
 * The draws go through 0x1E890 to the model table (0x1E8D8), with the
 * coprocessor commands js/doa.js keeps, so js/doa.js's machine runs them
 * from the identity and each piece comes out in the court's frame. The
 * players, the colours, the palette and the page copies are left out (the
 * explorer builds those from the same tables); 0x24470, which works out from
 * the camera whether each hoop is near (1), far (3, a plainer one) or out of
 * view (0) into 0x521768 and 0x521769, is answered "near" for both.
 */
import { doaMachine, boardToOps } from './doa.js';

const RAM_BASE = 0x500000;

/* The geometry's lighting, as the frame start sends it (0x1C240): function 6
 * loads the 31 material slots from 0x1B3C0, {parameter word, distance
 * coefficient} each, and function 0x0A the light, (0, 0, 1) in the camera's
 * frame, so the light is the eye's own and runs down the view. */
function courtMaterials(rom) {
    const A = rom.game.airwlkrs;
    const cv = rom.mainCpuView;
    return Array.from({ length: 32 }, (_, i) => {
        if (i >= A.materials.count) return { diffuse: 0, ambient: 0 };
        const w = cv.getUint32(A.materials.at + i * 8, true);
        return { diffuse: w & 0xff, ambient: (w >> 8) & 0xff };
    });
}

function text(rom, at) {
    let s = '';
    for (let p = at; p > 0 && p < rom.maincpu.length && rom.maincpu[p] && s.length < 32; p++) {
        s += String.fromCharCode(rom.maincpu[p]);
    }
    return s;
}

/** A team's record: its city and nickname, and the court variant it plays on. */
export function airwlkrsTeam(rom, n) {
    const A = rom.game.airwlkrs;
    const at = A.teams + n * 20;
    const cv = rom.mainCpuView;
    const title = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return {
        city: title(text(rom, cv.getUint32(at, true))),
        nickname: title(text(rom, cv.getUint32(at + 4, true))),
        variant: rom.maincpu[at + 12],
    };
}

/** Run one court's set-up and one frame of its draw. */
export function runCourt(rom, court, variant, { maxSteps = 5_000_000 } = {}) {
    const A = rom.game.airwlkrs;
    const M = doaMachine(rom);
    for (const at of A.skip) M.cpu.hooks.set(at, () => {});
    M.cpu.hooks.set(A.hoops, () => {
        M.ram[A.hoopShown - RAM_BASE] = 1;
        M.ram[A.hoopShown + 1 - RAM_BASE] = 1;
    });
    let done = M.cpu.call(A.setup, [court, variant], { maxSteps });
    M.geo.draws = [];
    done = M.cpu.call(A.draw, [court], { maxSteps }) && done;
    return { draws: M.geo.draws, unknown: [...M.unknown], done };
}

/**
 * The seventeen courts, as stages. Each is drawn under its home team's
 * texture set and colour set (js/texture.js, js/colors.js): the team's page,
 * and the court's own colour tables with them.
 */
export function readAirwlkrsStages(rom) {
    const A = rom.game.airwlkrs;
    const materials = courtMaterials(rom);
    const stages = [];
    for (let n = 0; n < A.courts; n++) {
        const team = airwlkrsTeam(rom, n);
        let run;
        try {
            run = runCourt(rom, n, team.variant);
        } catch (e) {
            console.warn(`airwlkrs: court ${n}: ${e.message}`);
            continue;
        }
        if (!run.draws.length) continue;
        const draws = run.draws.map((d) => ({
            model: d.model, pos: [d.m[9], d.m[10], d.m[11]], set: n, layer: 'scenery', ops: boardToOps(d.m),
        }));
        stages.push({
            slot: stages.length,
            placements: true,
            mixedSets: false,
            num: n,
            name: team.city === team.nickname ? team.city : `${team.city} ${team.nickname}`,
            chapter: n,
            draws,
            objects: [],
            sky: null,
            zones: [],
            views: [['all', 'Everything']],
            view: 'all',
            union: 'all',
            texSets: [n],
            /* The team's page and its colours; the court's go by the home
             * team too (js/colors.js). */
            texSet: [n, n],
            fighters: [],
            tint: [1, 1, 1],
            bright: 1,
            light: [0, 0, 1],
            headlight: true,
            materials,
            colorCycles: [],
            floorSize: 0,
            meta: [['court', n], ['variant', team.variant], ['pieces', draws.length],
                ...(run.unknown.length ? [['unread', run.unknown.join(', ')]] : [])],
        });
    }
    return stages;
}
