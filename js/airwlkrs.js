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
export function courtMaterials(rom) {
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

/* ---- the players ----------------------------------------------------------- */

/*
 * A player is drawn by code, with no tree of parts to read: 0x23600 places
 * the object (its spot, scale `+0x58, +0x5C, +0x58`, a lift `+0xB0` and its
 * facing `+0x14` about Y), then calls 0x214A0 for the legs and 0x21A70 for
 * the rest, or 0x20850 for both when the object's team (`+0xC`) is 34. Each
 * pushes and pops the coprocessor's stack down fifteen joints with their bone
 * lengths in the code, turning every joint by three angles of the pose at
 * 0x5214C0 (6 bytes a joint: Z, then Y, then X) and drawing one model of the
 * sixteen at `+0x120..+0x15C` on each. The explorer runs those routines
 * (js/doa.js's machine), so a part is a place in their draw order.
 *
 * In draw order: the hips (joint 8), the two legs (12-14 and 9-11) from them,
 * then the trunk (joint 0) from the object's own frame, the head's two models
 * on joint 1, and the two arms (5-7 and 2-4) from the trunk.
 */
const PLAYER_PARTS = [
    // [object field, parent part, joint]
    [0x144, -1, 8], [0x154, 0, 12], [0x158, 1, 13], [0x15c, 2, 14],
    [0x148, 0, 9], [0x14c, 4, 10], [0x150, 5, 11],
    [0x140, -1, 0], [0x120, 7, 1], [0x124, 7, 1],
    [0x134, 7, 5], [0x138, 10, 6], [0x13c, 11, 7],
    [0x128, 7, 2], [0x12c, 13, 3], [0x130, 14, 4],
];

/* Where a part's model sits in the player record (0x1F3F0 copies it to the
 * object): +0 the trunk, +4 the head, +8.. the arms, +0x20 the hips, +0x24..
 * the legs, +0x3C the head's second model. */
const RECORD_WORD = { 0x140: 0, 0x120: 1, 0x128: 2, 0x12c: 3, 0x130: 4, 0x134: 5, 0x138: 6, 0x13c: 7,
    0x144: 8, 0x148: 9, 0x14c: 10, 0x150: 11, 0x154: 12, 0x158: 13, 0x15c: 14, 0x124: 15 };

/* Board matrix (3x3 by columns, then the place) to three.js, Z negated. */
function toThree(m) {
    return [m[0], m[1], -m[2], 0, m[3], m[4], -m[5], 0, -m[6], -m[7], m[8], 0, m[9], m[10], -m[11], 1];
}

/**
 * The players, as bodies of sixteen parts: each team's five, in its home
 * kit (teams 0..16) and its away kit (17..33), and the three of team 34.
 *
 * The player set-up 0x1F3F0 (object, team, player) takes the player's record
 * at `0xF4B20 + 0x190 * team + 0x50 * player`, sixteen model numbers, and
 * copies them to the object. Team 34 is no team: the set-up swaps a player
 * for it when a cheat bit (0x5214A4) is set and the team record's byte for
 * that player is 0, and its three records are bodies of another build,
 * drawn by 0x20850.
 */
export function readAirwlkrsBodies(rom) {
    const R = rom.game.rig;
    const dv = rom.mainCpuView;
    const out = [];
    const add = (team, player, name) => {
        const record = R.players + team * R.teamStride + player * R.playerStride;
        const parts = PLAYER_PARTS.map(([field, parent, joint], k) => {
            let depth = 0;
            for (let p = parent; p >= 0; p = PLAYER_PARTS[p][1]) depth++;
            return {
                index: k, parent, depth, joint, field, flags: 0, offset: [0, 0, 0], record,
                model: dv.getUint32(record + RECORD_WORD[field] * 4, true),
            };
        });
        out.push({
            index: out.length, name, team, player, joints: 15, scale: 1, roles: [], skin: -1,
            hitMotions: [], start: -1, root: record, parts,
            /* The team's page and its colour rows (js/texture.js, js/colors.js). */
            playerSet: team < R.specialTeam ? team : 0,
            /* Lit as on court: the frame start's material slots and a light
             * down the view. The skin of the shared arms and legs is slots 6
             * and 7, all diffuse and little ambient, so a light from anywhere
             * else leaves it black. */
            materials: courtMaterials(rom), headlight: true,
        });
    };
    for (let team = 0; team < R.specialTeam; team++) {
        const t = airwlkrsTeam(rom, team % (R.specialTeam / 2));
        const name = t.city === t.nickname ? t.city : `${t.city} ${t.nickname}`;
        const kit = team < R.specialTeam / 2 ? '' : ', away';
        for (let p = 0; p < 5; p++) add(team, p, `${name} ${p + 1}${kit}`);
    }
    for (let p = 0; p < R.specials; p++) add(R.specialTeam, p, `Team ${R.specialTeam}, player ${p + 1}`);
    return out;
}

/**
 * Every motion the player's motion start (0x1F1B0) can find. Motion m's
 * angles are `ld 0x26E3CA0[m*4]` and its root's track `ld 0x25BF740[m*4]`,
 * unless the byte at `0xF2C68 + 12 * m` is set: then they are entry
 * byte - 1 of the tables at 0x2CE9750 and 0x2CE96C0, in the EPROM pair (35
 * motions, ten of them ones the first table has no frames for). 0x23F94 keeps
 * the number at or under 0x285.
 *
 * A motion is a halfword n, then n + 1 frames of the fifteen joints' three
 * angles (0x5A bytes). The player's clock (`+0xE0`) is 8.8 fixed point, and
 * 0x201B0 eases each angle from frame `t >> 8` to the next by
 * `(t & 0xFF) / 256`. The root's track is a float triple a frame, the hips'
 * place under the object: 0x22618 eases it into `+0xAC..+0xB4`, and 0x23600
 * lifts the player by its height. An entry whose n is 0xFFFF, a pointer to
 * the end of the motion before, is no motion.
 */
export function readAirwlkrsMotions(rom) {
    const M = rom.game.rig.motions;
    const dv = rom.mainDataView;
    const word = (table, k) => dv.getUint32(table - MAIN_DATA + k * 4, true);
    const list = [];
    for (let i = 0; i < M.count; i++) {
        const alt = rom.maincpu[M.alternate + i * 12];
        const address = alt ? word(M.altTable, alt - 1) : word(M.table, i);
        const root = (alt ? word(M.altRoots, alt - 1) : word(M.roots, i)) - MAIN_DATA;
        const offset = address - MAIN_DATA;
        if (offset < 0 || offset + 2 > rom.mainData.length) continue;
        const n = dv.getUint16(offset, true);
        if (n === 0xffff || offset + 2 + (n + 1) * FRAME_BYTES > rom.mainData.length) continue;
        list[i] = {
            index: i, name: `motion ${i}`, address, offset: offset + 2, frames: n + 1, joints: 15,
            root: root >= 0 && root + (n + 1) * 12 <= rom.mainData.length ? root : -1,
        };
    }
    return list;
}

const MAIN_DATA = 0x02000000;
const FRAME_BYTES = 0x5a;

/** Any motion plays on any player: one skeleton, one table. */
export function airwlkrsMotionList(rom, body, motions) {
    const fits = motions.filter(Boolean);
    return { fits, lead: fits, label: 'Every motion in the table' };
}

const machines = new WeakMap();
function playerMachine(rom) {
    if (!machines.has(rom)) machines.set(rom, doaMachine(rom));
    return machines.get(rom);
}

/**
 * Pose a player on one frame of a motion: the frame's angles at 0x521520,
 * copied to 0x5214C0 by the game's own routine (mirrored when asked), the
 * player's models in an object, and the game's draw routines run on them.
 * The model offset 0x5215F0 is 0, the near models: 0x23600 sets it to -1, the
 * model before each in the table, when the camera is 35 units off or more.
 */
export function poseAirwlkrs(rom, body, motion, frame, { travel = false, mirrored = false } = {}) {
    const R = rom.game.rig;
    const M = playerMachine(rom);
    const obj = R.object - RAM_BASE;
    M.ram.fill(0, obj, obj + 0x170);
    for (const p of body.parts) M.rv.setUint32(obj + p.field, p.model, true);
    for (const at of [0x58, 0x5c, 0x60, 0x64, 0x68, 0x6c]) M.rv.setFloat32(obj + at, 1, true);
    M.rv.setUint32(obj + 0x0c, body.team, true);
    /* The hands the motion holds: 0x21A70 draws `+0x13C` plus the byte at
     * `+0x11E` and `+0x130` plus `+0x11F`, which the motion start (0x1F374)
     * takes from bytes 4 and 5 of the motion's record, `0xF2C60 + 12 * m`
     * (the other way round when `+0xF4` plays it mirrored). Team 34's
     * routine adds nothing. */
    if (motion) {
        const at = R.motions.records + motion.index * 12;
        M.ram[obj + 0x11e] = rom.maincpu[at + (mirrored ? 5 : 4)];
        M.ram[obj + 0x11f] = rom.maincpu[at + (mirrored ? 4 : 5)];
    }
    /* Whoever starts a motion says whether it plays mirrored: in a game,
     * 0x66FA0 takes a player's next step from its move sequence (six
     * halfwords each at 0x5A300), the motion in the low 12 bits and `+0xF4`
     * set by bit 12 or 14. 0x1FD10 then copies the eased frame at `eased`
     * to the pose words as it is or mirrored: the arms and legs change
     * sides with their turns negated, which is why the hands swap. */
    M.rv.setUint32(obj + 0xf4, mirrored ? 1 : 0, true);
    M.rv.setInt32(R.modelOffset - RAM_BASE, 0, true);
    const pose = R.eased - RAM_BASE;
    M.ram.fill(0, pose, pose + FRAME_BYTES);
    /* The hips stand at the root's height, and go where it goes when the
     * travel is asked for. */
    const place = [0, 0, 0];
    if (motion?.offset) {
        const f = Math.max(1, Math.min(frame, motion.frames)) - 1;
        const at = motion.offset + f * FRAME_BYTES;
        M.ram.set(rom.mainData.subarray(at, at + FRAME_BYTES), pose);
        if (motion.root >= 0) {
            for (let k = 0; k < 3; k++) place[k] = rom.mainDataView.getFloat32(motion.root + f * 12 + k * 4, true);
            if (!travel) place[0] = place[2] = 0;
            /* 0x22800 flips the root's x for a mirrored motion. */
            if (mirrored) place[0] = -place[0];
        }
    }
    M.cpu.call(R.mirror, [R.object], { maxSteps: 20_000 });
    M.copro.stack = [];
    M.copro.m = [1, 0, 0, 0, 1, 0, 0, 0, 1, ...place];
    M.geo.draws = [];
    for (const at of body.team === R.specialTeam ? R.drawSpecial : R.draw) {
        M.cpu.call(at, [R.object], { maxSteps: 200_000 });
    }
    const draws = M.geo.draws;
    const matrices = body.parts.map((p, k) => toThree(draws[k]?.m ?? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
    return {
        matrices,
        origins: matrices.map((e) => [e[12], e[13], e[14]]),
        draws: body.parts.map((p, k) => (draws[k] ? [draws[k].model] : [])),
        parents: body.parts.map((p) => p.parent),
        joined: body.parts.map((p, k) => k === 9),
        /* The coprocessor's read-backs: the two feet, the head and the hands. */
        ends: R.ends.map((at) => [0, 4, 8].map((k) => M.rv.getFloat32(at - RAM_BASE + k, true))),
    };
}
