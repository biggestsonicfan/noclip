#!/usr/bin/env node
/*
 * export.mjs — a fighter out of the ROM set as an FBX file.
 *
 *   node tools/fbx/export.mjs fvipers.zip --fighter Grace --motion 73 --frame 1 \
 *       --out grace.fbx
 *
 * The fighter is the one the Animation tab shows: its sixteen parts placed by
 * the game's own pose (js/vf2fighters.js) on the motion and frame asked for,
 * textured and coloured from the ROM as the board colours them. In the file it
 * is one mesh skinned to a sixteen-bone skeleton, each part's points wholly on
 * its slot's bone, so it can be posed again in whatever opens it. The atlas is
 * embedded in the FBX and written beside it as a PNG.
 *
 * Only the solved rig (Virtua Fighter 2's, which Fighting Vipers uses) is read
 * here; see README.md beside this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadRomSet } from '../../js/romset.js';
import { decodeModel } from '../../js/model.js';
import { readFighters, poseFighter } from '../../js/vf2fighters.js';
import { SLOT_NAMES, SLOT_PARENT, turnedBy, viewerMatrix } from '../../js/pose.js';
import { decodeMotion, resolveData } from '../../js/motion.js';
import { readOsage, osageParts } from '../../js/osage.js';
import { buildTexram, programTextureSets } from '../../js/texture.js';
import { buildAtlas } from '../../js/atlas.js';
import { buildLumaram, buildColorxlat } from '../../js/colors.js';
import { readStageTable } from '../../js/stages.js';
import { facesOf, bakeFaces } from './bake.mjs';
import { skinnedMeshFbx, mul4 } from './fbx.mjs';
import { encodePng } from './png.mjs';

const USAGE = `usage: export.mjs <set.zip>... --fighter <name|index> [--motion <id>] [--frame <n>]
                 [--stage <index>] --out <file.fbx>`;

function parseArgs(argv) {
    const o = { zips: [], motion: null, frame: 1, stage: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--fighter') o.fighter = argv[++i];
        else if (a === '--motion') o.motion = Number(argv[++i]);
        else if (a === '--frame') o.frame = Number(argv[++i]);
        else if (a === '--stage') o.stage = Number(argv[++i]);
        else if (a === '--out') o.out = argv[++i];
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
        else o.zips.push(a);
    }
    if (!o.zips.length || o.fighter == null || !o.out) throw new Error(USAGE);
    return o;
}

async function loadRom(zips) {
    const bufs = zips.map((z) => {
        const b = fs.readFileSync(z);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    });
    const rom = await loadRomSet(bufs);
    if (rom.game.rig?.kind !== 'vf2') throw new Error(`${rom.game.name}: no solved fighter rig to export`);
    return rom;
}

function pickFighter(rom, which) {
    const all = readFighters(rom);
    const f = /^\d+$/.test(which) ? all[Number(which)]
        : all.find((x) => x.name.toLowerCase() === which.toLowerCase());
    if (!f) throw new Error(`no fighter ${which}; the roster is ${all.map((x) => x.name).join(', ')}`);
    return f;
}

/*
 * What Fighting Vipers draws on the hips besides the sixteen parts, out of its
 * rob_disp (0x19f10). After slot 9 it draws the model in field +8 of the
 * record's +0x24 block, in the hip's own frame, and then (0x31e54) the skirt
 * of the fighters that wear one (0, 1, 13 and 14): four plates out of the
 * 16-bit list at 0x6421de0 + 16 * fighter. Each is the hip's frame moved by
 * its own offset (set at 0x12768) and turned Z, Y, X; the angles are where its
 * spring rests, read off the board's RAM (0x50a354..0x50a37a) mid-fight.
 */
const SKIRT_TABLE = 0x6421de0;
const SKIRT_WEARERS = [0, 1, 13, 14];
const SKIRT_PLATES = [   /* list entry, offset, angle x, y, z */
    { entry: 2, t: [0.013, 0.087, 0], a: [0x4000, -0x4000, 0] },
    { entry: 3, t: [0.013, -0.088, 0], a: [0x4000, -0x4000, 0] },
    { entry: 1, t: [0, -0.017, 0.107], a: [0x4000, -0x4000, 0] },
    { entry: 0, t: [0, -0.017, -0.107], a: [0x4000, -0x4000, 0] },
];
const HIPS = 9;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function hipExtras(rom, body) {
    if (rom.game.id !== 'fvipers') return [];
    const u32 = (a) => { const r = resolveData(rom, a); return r ? r.view.getUint32(r.off, true) : 0; };
    const u16 = (a) => { const r = resolveData(rom, a); return r ? r.view.getUint16(r.off, true) : 0; };
    const out = [];
    const block = u32(body.root + 0x24);
    const piece = block ? u32(block + 8) : 0;
    if (piece) out.push({ index: HIPS, model: piece });
    if (SKIRT_WEARERS.includes(body.index)) {
        for (const { entry, t, a } of SKIRT_PLATES) {
            const model = u16(SKIRT_TABLE + body.index * 16 + entry * 2);
            if (model) out.push({ index: HIPS, model, place: viewerMatrix({ r: turnedBy(IDENTITY, ...a), t }) });
        }
    }
    return out;
}

/* The board's texture RAM and colour tables while this fighter is on screen:
 * the boot set and the fighter's pair, and its own rows of colorxlat over the
 * stage's. */
function sceneTables(rom, body, decoded, stage) {
    const sets = new Set();
    for (const [model, d] of decoded) {
        for (const s of programTextureSets(rom, model, d)?.sets ?? []) sets.add(s);
    }
    const { sheet0, sheet1 } = buildTexram(rom, [...sets]);
    return {
        atlas: buildAtlas(sheet0, sheet1),
        luma: buildLumaram(rom),
        cxlat: buildColorxlat(rom, { colorSet: stage.texSet[1], tint: [1, 1, 1], fighters: [body.index] }),
    };
}

/* The viewer's frame has the fighter looking down +x. The file has it facing
 * +z, FBX's front, with its lowest point on the floor. */
function placeInFile(matrices, decoded, body) {
    const turn = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];   /* +x to +z */
    let floor = Infinity;
    for (const p of body.parts) {
        const d = decoded.get(p.model);
        if (!d) continue;
        const m = mul4(turn, matrices[p.index]);
        for (let i = 0; i < d.positions.length; i += 3) {
            const [x, y, z] = [d.positions[i], d.positions[i + 1], d.positions[i + 2]];
            floor = Math.min(floor, m[1] * x + m[5] * y + m[9] * z + m[13]);
        }
    }
    /* The motion carries the body off along its step; the file stands it over
     * the origin, on the floor. */
    const root = mul4(turn, matrices[0]);
    const lift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -root[12], Number.isFinite(floor) ? -floor : 0, -root[14], 1];
    return matrices.map((m) => mul4(lift, mul4(turn, m)));
}

const apply = (m, [x, y, z], w = 1) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
const sub = (a, b) => a.map((v, k) => v - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

/* The bones: the sixteen slots, then a bone for each segment of the sway
 * chains (js/osage.js), hung off the slot its chain starts from or the segment
 * before it. A segment's mesh runs along its own +y. */
function rigOf(body, osage, sway) {
    const rig = body.parts.map((p) => ({
        name: SLOT_NAMES[p.index] ?? `slot${p.index}`, parent: SLOT_PARENT[p.index],
    }));
    for (const p of sway) {
        const from = osage.chains[p.chain].bone;
        const name = `${rig[from].name}_SWAY${p.chain + 1}_${p.segment + 1}`;
        const parent = p.segment ? rig.length - 1 : from;
        rig.push({ name, parent, sway: true, axis: [0, 1, 0] });
    }
    return rig;
}

/* A decal is the surface's own polygon drawn again, corner for corner, and on
 * the board the later one wins. A depth buffer cannot tell them apart, so each
 * repeat stands a hair further out along its face than the one under it. */
const DECAL_STEP = 0.0005;

/* The faces of every part in the file's frame, as triangles of points that
 * share an index where they are the same point of the same part and layer. */
function buildMesh(rig, matrices, faces, baked) {
    const positions = [], polygons = [], normals = [], uvs = [];
    const bones = rig.map((b, k) => ({ ...b, matrix: matrices[k], points: [] }));
    const pointIndex = new Map();
    const layers = new Map();
    const key = (v) => v.map((x) => Math.round(x * 1e5)).join(',');
    for (const f of faces) {
        const m = f.place ? mul4(matrices[f.part], f.place) : matrices[f.part];
        /* The model's normals point into the body; a file's point out of it,
         * or an engine that culls back faces draws the fighter inside out. */
        const corners = [0, 1, 2].map((c) => {
            const v = f.first + c;
            const d = f.decoded;
            return {
                p: apply(m, [d.positions[v * 3], d.positions[v * 3 + 1], d.positions[v * 3 + 2]]),
                n: unit(apply(m, [d.normals[v * 3], d.normals[v * 3 + 1], d.normals[v * 3 + 2]], 0)).map((x) => -x),
                uv: baked.uvOf(f, c),
            };
        });
        const tri = corners.map((c) => key(c.p)).sort().join('|');
        const layer = layers.get(tri) ?? 0;
        layers.set(tri, layer + 1);
        /* Wound so the face's own normal is its front. */
        const plane = cross(sub(corners[1].p, corners[0].p), sub(corners[2].p, corners[0].p));
        if (dot(plane, corners[0].n) < 0) corners.reverse();
        const lift = unit(plane).map((v) => v * DECAL_STEP * layer * Math.sign(dot(plane, corners[0].n) || 1));
        const poly = corners.map((c) => {
            const p = layer ? c.p.map((v, k) => v + lift[k]) : c.p;
            const k = `${f.part}:${layer}:${key(p)}`;
            if (!pointIndex.has(k)) {
                pointIndex.set(k, positions.length / 3);
                bones[f.part].points.push(positions.length / 3);
                positions.push(...p);
            }
            normals.push(...c.n);
            uvs.push(...c.uv);
            return pointIndex.get(k);
        });
        polygons.push(poly);
    }
    return { positions, polygons, normals, uvs, bones };
}

/* The game's limbs run down each part's local +x, but its frames point the
 * other axes wherever the art was modelled, and a rig built from them has
 * bones sticking out sideways. The skin is rigid, so any frame at the same
 * pivot will do: each bone gets one whose y (Blender's bone axis) runs to its
 * child's pivot, with x across the body. An end bone runs along its part:
 * the head up its local +z, a hand on along +x, a foot forward along -z. BODY,
 * whose children sit on its own pivot, points straight up. */
const END_AXIS = { HEAD: [0, 0, 1], LHAND: [1, 0, 0], RHAND: [1, 0, 0], LFOOT: [0, 0, -1], RFOOT: [0, 0, -1] };

function restFrame(head, y) {
    const ref = Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const x = unit(cross(y, ref));
    return [...x, 0, ...y, 0, ...cross(x, y), 0, ...head, 1];
}

/* An end bone's direction, and its tip: as far along it as its part reaches. */
function endOf(b, positions) {
    const head = b.matrix.slice(12, 15);
    const y = unit(apply(b.matrix, b.axis ?? END_AXIS[b.name] ?? [1, 0, 0], 0));
    let reach = 0;
    for (const q of b.points) reach = Math.max(reach, dot(sub(positions.slice(q * 3, q * 3 + 3), head), y));
    return { y, tip: head.map((v, i) => v + y[i] * Math.max(reach, 0.01)) };
}

/* js/pose.js names the sides as the viewer sees them, facing the fighter; a
 * rig names them as the body's own. In the file the fighter faces +z, so its
 * left is +x: if the L shoulder and hip sit on -x, the names swap. */
function sideNames(bones) {
    const x = (name) => bones.find((b) => b.name === name)?.matrix[12] ?? 0;
    const body = x('BODY');
    if (x('LUARM') + x('LTHIGH') - 2 * body >= 0) return bones;
    const other = { L: 'R', R: 'L' };
    return bones.map((b) => ({ ...b, name: b.name.replace(/^[LR](?=(UARM|FARM|HAND|THIGH|SHIN|FOOT))/, (c) => other[c]) }));
}

function restFrames(bones, positions) {
    const at = (b) => b.matrix.slice(12, 15);
    const out = bones.map((b, k) => {
        const head = at(b);
        /* A slot's direction is its skeleton's: the sway chains hanging off it
         * do not pull it round. */
        const children = bones.filter((c) => c.parent === k && c.sway === b.sway);
        const ends = children.map(at).filter((p) => Math.hypot(...sub(p, head)) > 1e-3);
        if (ends.length) {
            const mid = ends.reduce((a, p) => a.map((v, i) => v + p[i] / ends.length), [0, 0, 0]);
            return { ...b, matrix: restFrame(head, unit(sub(mid, head))) };
        }
        if (children.length) return { ...b, matrix: restFrame(head, [0, 1, 0]) };
        const { y, tip } = endOf(b, positions);
        return { ...b, matrix: restFrame(head, y), tip };
    });
    /* A bone with no child gets an unskinned one at its tip, as Mixamo's
     * rigs have, so that Blender, which sizes a bone by its children, draws
     * it as long as its part. */
    for (const b of out.filter((x) => x.tip)) {
        const k = out.indexOf(b);
        out.push({ name: `${b.name}_end`, parent: k, points: [], matrix: restFrame(b.tip, b.matrix.slice(4, 7)) });
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const rom = await loadRom(opts.zips);
    const body = pickFighter(rom, opts.fighter);
    const stage = readStageTable(rom)[opts.stage];
    if (!stage) throw new Error(`no stage ${opts.stage}`);

    const motion = opts.motion == null ? null : decodeMotion(rom, opts.motion);
    if (opts.motion != null && !motion) throw new Error(`motion ${opts.motion} has no data`);
    /* Played up to the frame, so the head has turned as far as it would. */
    let pose;
    for (let f = 1; f <= Math.max(1, opts.frame); f++) pose = poseFighter(rom, body, motion, f);

    const osage = readOsage(rom, body.index);
    const sway = osageParts(pose.pose, osage);
    const rig = rigOf(body, osage, sway);
    const drawn = [...body.parts, ...hipExtras(rom, body),
        ...sway.map((p, k) => ({ index: body.parts.length + k, model: p.model }))];
    const decoded = new Map();
    for (const p of drawn) {
        const d = p.model ? decodeModel(rom, p.model) : null;
        if (d?.positions.length) decoded.set(p.model, d);
    }
    const tables = sceneTables(rom, body, decoded, stage);
    const faces = drawn.flatMap((p) => (decoded.has(p.model)
        ? facesOf(decoded.get(p.model), p.index, stage.materials).map((f) => ({ ...f, place: p.place })) : []));
    const baked = bakeFaces(faces, tables);
    const matrices = placeInFile([...pose.matrices, ...sway.map(viewerMatrix)], decoded, body);
    const mesh = buildMesh(rig, matrices, faces, baked);
    mesh.bones = restFrames(sideNames(mesh.bones), mesh.positions);

    const base = opts.out.replace(/\.fbx$/i, '');
    const pngName = `${path.basename(base)}.png`;
    const png = encodePng(baked.size, baked.size, baked.rgba);
    fs.writeFileSync(`${base}.png`, png);
    fs.writeFileSync(opts.out, skinnedMeshFbx({
        name: body.name.replace(/[^\w.-]+/g, '_'), unitScale: 100, ...mesh, texture: { file: pngName, png },
    }));
    console.log(`${body.name}: ${mesh.polygons.length} triangles, ${mesh.positions.length / 3} points, `
        + `${baked.blocks} texture blocks in a ${baked.size}x${baked.size} atlas -> ${opts.out}`);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
