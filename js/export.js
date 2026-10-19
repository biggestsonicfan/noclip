/*
 * export.js — what is on screen, as a .glb that Blender opens.
 *
 * The models are the reader's own ROM set, drawn at the frame they are paused
 * on: every draw in the view, at the pose and the place it stands this frame.
 * Free, and done entirely in the page like everything else here.
 *
 * glTF rather than .blend because .blend is Blender's memory dump: its layout
 * changes with each release and nothing outside Blender writes it reliably.
 * Blender imports glTF out of the box (File > Import > glTF 2.0), and from there
 * Save As is a .blend.
 *
 * The colours are the hard part. Nothing on the board is an RGB texture: a face
 * names a 4-bit tile, a luma band, a material slot and a palette row, and the
 * fill shader turns those into a colour with the stage's light already in it.
 * No material Blender knows can say that, so the shader says it once more,
 * into a texture: each face gets a cell of its own in one sheet, drawn flat
 * into it by the same fill path (BAKE in js/viewer.js) with the uniforms of
 * this frame, and the face's UVs point at its cell. The material is unlit, so
 * Blender shows the pixels the board would. A cell holds a face at a pixel to a
 * texel where the sheet has room, so the board's half-texel offset lands each
 * pixel exactly on one texel and Blender's own bilinear filter reproduces the
 * board's.
 *
 * A face that repeats its tile -- a stage's ground and water, thousands of
 * texels across -- would not fit a cell at that scale, and squeezed into one it
 * came out a blur. Its light is one value for the whole face, so its colour
 * repeats with the tile: one period of it is baked into a texture of its own,
 * which Blender repeats, and every repeating face with the same tile, palette
 * and light shares it.
 *
 * What it leaves out: the sky panorama and the scroll layers, which are not
 * models, and the camera, which is not the game's.
 */

import { THREE, createBakeMaterial } from './viewer.js';
import { coplanarLayers, rankLayers } from './layers.js';

const GUTTER = 2;       // px round each cell, grown out of its face
const CELL_CAP = 512;   // the longest side one face's cell may take, at full scale
const FLAT_CELL = 6;    // a face whose texels have no area: one colour, or near it
const MAX_SHEET = 4096;

/* aFlags bits (see VERT_SHADER in js/viewer.js). */
const F_HOLES = 1, F_CHECKER = 2, F_MIRROR_X = 8, F_MIRROR_Y = 16, F_BOTH_SIDES = 128;

/* Every model draw that is showing. The sky and the scroll layers are drawn
 * with other materials, which have no uAtlas. */
function collectDraws(viewer) {
    const draws = [];
    viewer.scene.updateMatrixWorld();
    viewer.root.traverseVisible((o) => {
        if (!o.isMesh || Array.isArray(o.material) || !o.material?.uniforms?.uAtlas) return;
        const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
        if (!src.getAttribute('aTexel')) return;
        const count = Math.min(src.getAttribute('position').count,
            Number.isFinite(src.drawRange.count) ? src.drawRange.start + src.drawRange.count : Infinity);
        const tris = Math.floor(count / 3);
        if (tris) draws.push({ mesh: o, geom: src, tris });
    });
    return draws;
}

const faceFlags = (draw, tri) => Math.round(draw.geom.getAttribute('aFlags').getX(tri * 3));

/* The period of a face's texture, in its texels, when the face repeats it, or
 * null. A mirrored tile repeats every second copy. */
function facePeriod(draw, tri) {
    const g = draw.geom, i = tri * 3;
    if (g.getAttribute('aLumaBase').getX(i) < 0) return null;
    const tile = g.getAttribute('aTile'), texel = g.getAttribute('aTexel');
    const flags = faceFlags(draw, tri);
    const pu = Math.round(tile.getZ(i)) * (flags & F_MIRROR_X ? 2 : 1);
    const pv = Math.round(tile.getW(i)) * (flags & F_MIRROR_Y ? 2 : 1);
    if (pu < 1 || pv < 1) return null;
    const u = [texel.getX(i), texel.getX(i + 1), texel.getX(i + 2)];
    const v = [texel.getY(i), texel.getY(i + 1), texel.getY(i + 2)];
    const du = Math.ceil(Math.max(...u)) - Math.floor(Math.min(...u));
    const dv = Math.ceil(Math.max(...v)) - Math.floor(Math.min(...v));
    return du > pu || dv > pv ? { w: pu, h: pv } : null;
}

/* What a repeating face's colour depends on besides the texel: everything the
 * fill path reads off the face, and the light, which is its normal through the
 * draw's matrix and, for a two-sided face, the side the camera sees. Faces with
 * the same key share one period. */
function periodKey(draw, tri, period, eye) {
    const g = draw.geom, i = tri * 3;
    const parts = [period.w, period.h, draw.mesh.material.id];
    for (const name of ['aTile', 'aLumaBase', 'aFlags', 'aMaterial', 'aColor']) {
        const a = g.getAttribute(name);
        for (let c = 0; c < a.itemSize; c++) parts.push(a.getComponent(i, c));
    }
    const { n, front } = boardFacing(draw, tri, eye);
    parts.push(n.x.toFixed(5), n.y.toFixed(5), n.z.toFixed(5), front);
    return parts.join(',');
}

/* The face's normal through the draw's matrix as the board lights it, and
 * whether it is seen from the side the board calls the front, where the normal
 * points away from the eye (boardDrawsFace in js/viewer.js): always, for a
 * one-sided face, and for a two-sided one when the view's camera sees it so. */
function boardFacing(draw, tri, eye) {
    const g = draw.geom, i = tri * 3;
    const m = new THREE.Matrix3().setFromMatrix4(draw.mesh.matrixWorld);
    const n = new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'), i).applyMatrix3(m);
    const pt = g.getAttribute('aFacePt');
    const p = pt ? new THREE.Vector3().fromBufferAttribute(pt, i).applyMatrix4(draw.mesh.matrixWorld).sub(eye)
                 : null;
    const both = faceFlags(draw, tri) & F_BOTH_SIDES;
    return { n, front: !both || !p || n.dot(p) >= 0 };
}

/* One face's cell at scale g: its corners in pixels from the cell's corner,
 * and its size. A cell is laid out in the face's own texels, floored to a whole
 * one, so at full scale a pixel centre is a texel centre. */
function faceCell(texel, tri, g) {
    const i = tri * 3;
    const u = [texel.getX(i), texel.getX(i + 1), texel.getX(i + 2)];
    const v = [texel.getY(i), texel.getY(i + 1), texel.getY(i + 2)];
    const u0 = Math.floor(Math.min(...u)), v0 = Math.floor(Math.min(...v));
    const sx = Math.min(1, CELL_CAP / Math.max(Math.ceil(Math.max(...u)) - u0, 1)) * g;
    const sy = Math.min(1, CELL_CAP / Math.max(Math.ceil(Math.max(...v)) - v0, 1)) * g;
    let p = [0, 1, 2].flatMap((k) => [(u[k] - u0) * sx, (v[k] - v0) * sy]);
    const area = Math.abs((p[2] - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (p[3] - p[1])) / 2;
    if (area < 1) p = [0, 0, FLAT_CELL, 0, 0, FLAT_CELL];
    return {
        p,
        w: Math.max(1, Math.ceil(Math.max(p[0], p[2], p[4]))),
        h: Math.max(1, Math.ceil(Math.max(p[1], p[3], p[5]))),
    };
}

/* Shelves, tallest cells first, `gutter` px round each. Returns the height. */
function packCells(cells, width, gutter = GUTTER) {
    const order = cells.map((_, i) => i).sort((a, b) => cells[b].h - cells[a].h);
    let x = 0, y = 0, row = 0;
    for (const i of order) {
        const c = cells[i];
        const w = c.w + 2 * gutter, h = c.h + 2 * gutter;
        if (x + w > width) { x = 0; y += row; row = 0; }
        c.x = x + gutter;
        c.y = y + gutter;
        x += w;
        row = Math.max(row, h);
    }
    return Math.ceil((y + row) / 4) * 4;
}

/* The sheet's width for cells of this much area. */
const sheetWidth = (area, maxSize) =>
    Math.min(maxSize, Math.max(256, 2 ** Math.ceil(Math.log2(Math.sqrt(area * 1.15)))));

/* Lay every face that is not a period's out, at full scale if the sheet holds
 * them and smaller until it does. cells[d][t] is null for a face that repeats. */
function planSheet(draws, periodic, maxSize) {
    let g = 1;
    for (let attempt = 0; attempt < 24; attempt++) {
        const cells = draws.map((d, di) => {
            const texel = d.geom.getAttribute('aTexel');
            return Array.from({ length: d.tris }, (_, t) => periodic[di][t] ? null : faceCell(texel, t, g));
        });
        const flat = cells.flat().filter(Boolean);
        const area = flat.reduce((a, c) => a + (c.w + 2 * GUTTER) * (c.h + 2 * GUTTER), 0);
        const width = sheetWidth(area, maxSize);
        const height = flat.length ? packCells(flat, width) : 4;
        if (height <= maxSize) return { cells, width, height };
        g *= Math.max(0.5, Math.min(0.9, Math.sqrt(maxSize * maxSize / (area * 1.2))));
    }
    throw new Error('Too many faces in view to fit one texture sheet.');
}

/* The periods, shelved into as many sheets as they take. A period is drawn
 * whole and Blender wraps it, so it needs no gutter. */
function planPeriods(periods, maxSize) {
    const sheets = [];
    let rest = periods.slice().sort((a, b) => b.h - a.h);
    while (rest.length) {
        const area = rest.reduce((a, p) => a + p.w * p.h, 0);
        const width = Math.max(sheetWidth(area, maxSize), ...rest.map((p) => p.w));
        const here = [];
        let x = 0, y = 0, row = 0;
        const left = [];
        for (const p of rest) {
            if (x + p.w > width) { x = 0; y += row; row = 0; }
            if (y + p.h > maxSize) { left.push(p); continue; }
            p.x = x; p.y = y; p.sheet = sheets.length;
            x += p.w;
            row = Math.max(row, p.h);
            here.push(p);
        }
        sheets.push({ width, height: Math.ceil((y + row) / 4) * 4, periods: here });
        rest = left;
    }
    return sheets;
}

/* A copy of the draw for the sheet: its attributes, and where each corner
 * lands in the sheet in clip space. A face with no cell is put off the sheet. */
function bakeGeometry(draw, cells, width, height) {
    const g = new THREE.BufferGeometry();
    /* Copies, not the draw's own: disposing a geometry frees its attributes'
     * buffers, and the live draw would lose them. */
    for (const [name, attr] of Object.entries(draw.geom.attributes)) g.setAttribute(name, attr.clone());
    const at = new Float32Array(draw.tris * 6).fill(4);
    cells.forEach((c, t) => {
        if (!c) return;
        for (let k = 0; k < 3; k++) {
            at[t * 6 + k * 2] = (c.x + c.p[k * 2]) / width * 2 - 1;
            at[t * 6 + k * 2 + 1] = (c.y + c.p[k * 2 + 1]) / height * 2 - 1;
        }
    });
    g.setAttribute('aBake', new THREE.BufferAttribute(at, 2));
    g.setDrawRange(0, draw.tris * 3);
    return g;
}

/* One period of a repeating face: two triangles over texels [0, w] x [0, h],
 * carrying everything else of the face, at the period's place in its sheet. */
const QUAD = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
function periodGeometry(period, sheet) {
    const { draw, tri } = period.face;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(draw.geom.attributes)) {
        const n = attr.itemSize;
        const a = new attr.array.constructor(6 * n);
        for (let k = 0; k < 6; k++) {
            for (let c = 0; c < n; c++) a[k * n + c] = attr.getComponent(tri * 3 + (k % 3), c);
        }
        g.setAttribute(name, new THREE.BufferAttribute(a, n, attr.normalized));
    }
    const texel = g.getAttribute('aTexel');
    const at = new Float32Array(12);
    QUAD.forEach(([qu, qv], k) => {
        texel.setXY(k, qu * period.w, qv * period.h);
        at[k * 2] = (period.x + qu * period.w) / sheet.width * 2 - 1;
        at[k * 2 + 1] = (period.y + qv * period.h) / sheet.height * 2 - 1;
    });
    g.setAttribute('aBake', new THREE.BufferAttribute(at, 2));
    return g;
}

/* What the fill path covered, faces' holes included: a pixel no face drew is
 * gutter, and is grown into from its neighbours so Blender's filter never
 * reaches the clear colour along a seam. */
function maskMaterial() {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: 'in vec2 aBake; void main() { gl_Position = vec4(aBake, 0.0, 1.0); }',
        fragmentShader: 'out vec4 c; void main() { c = vec4(1.0); }',
        side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
}

/* Drawn through the view's camera, though nothing lands where it looks: the
 * light's front/back test of a two-sided face is taken in its space. */
function renderSheet(renderer, scene, camera, width, height) {
    const target = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, generateMipmaps: false,
    });
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(scene, camera);
    const px = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, px);
    target.dispose();
    return px;
}

/* Draw each job's faces into the sheet: jobs are { draw, geom }, a bake
 * geometry and the draw it came from. With `withMask`, again as plain coverage. */
function bakeSheet(viewer, jobs, width, height, withMask) {
    const r = viewer.renderer;
    const saved = {
        target: r.getRenderTarget(), clear: r.getClearColor(new THREE.Color()),
        alpha: r.getClearAlpha(), autoClear: r.autoClear,
    };
    const scene = new THREE.Scene();
    const bakeMats = new Map();
    const meshes = jobs.map(({ draw, geom }) => {
        const src = draw.mesh.material;
        if (!bakeMats.has(src)) bakeMats.set(src, createBakeMaterial(src));
        const m = new THREE.Mesh(geom, bakeMats.get(src));
        /* Placed where the draw stands: the shader lights a face by its normal
         * through this matrix, and with none every part was lit as if unposed
         * and unturned. Where the face lands in the sheet is aBake's alone. */
        m.matrixAutoUpdate = false;
        m.matrix.copy(draw.mesh.matrixWorld);
        m.frustumCulled = false;
        scene.add(m);
        return m;
    });
    r.autoClear = false;
    try {
        const rgba = renderSheet(r, scene, viewer.camera, width, height);
        if (!withMask) return { rgba };
        const mask = maskMaterial();
        for (const m of meshes) m.material = mask;
        const covered = renderSheet(r, scene, viewer.camera, width, height);
        mask.dispose();
        return { rgba, covered };
    } finally {
        for (const m of meshes) m.geometry.dispose();
        for (const m of bakeMats.values()) m.dispose();
        r.setRenderTarget(saved.target);
        r.setClearColor(saved.clear, saved.alpha);
        r.autoClear = saved.autoClear;
    }
}

/* Grow each cell into its gutter: an uncovered pixel takes a covered
 * neighbour's colour, a ring at a time. The gutter is wider than the growth
 * reaches from any face but its own. */
function growIntoGutters(rgba, covered, width, height) {
    const done = new Uint8Array(width * height);
    for (let i = 0; i < done.length; i++) done[i] = covered[i * 4] > 127 ? 1 : 0;
    const step = [1, -1, width, -width];
    for (let ring = 0; ring < GUTTER; ring++) {
        const grown = [];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1, i = y * width + 1; x < width - 1; x++, i++) {
                if (done[i]) continue;
                for (const s of step) {
                    if (done[i + s] === 1) { grown.push(i, i + s); break; }
                }
            }
        }
        for (let k = 0; k < grown.length; k += 2) {
            rgba.copyWithin(grown[k] * 4, grown[k + 1] * 4, grown[k + 1] * 4 + 4);
            done[grown[k]] = 2;
        }
        for (let k = 0; k < grown.length; k += 2) done[grown[k]] = 1;
    }
}

/* A rectangle of GL pixels (rows bottom up) as an image's (top row first). */
function cropRows(rgba, sheetWidth, x, y, w, h) {
    const out = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) {
        const src = ((y + h - 1 - r) * sheetWidth + x) * 4;
        out.set(rgba.subarray(src, src + w * 4), r * w * 4);
    }
    return out;
}

async function encodePng(pixels, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    img.data.set(pixels);
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('The browser would not encode the texture sheet.');
    return new Uint8Array(await blob.arrayBuffer());
}

/* The same pixels, so the same image: faces whose keys differ only by a light
 * that rounds to the same luma share one. */
function samePixels(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function hashPixels(px) {
    let h = 0x811c9dc5;
    for (let i = 0; i < px.length; i += 4) {
        h = Math.imul(h ^ (px[i] | px[i + 1] << 8 | px[i + 2] << 16 | px[i + 3] << 24), 0x01000193);
    }
    return h >>> 0;
}

/* Faces that lie on others in their plane, in the order the view shows them.
 * The explorer parts them in its depth test (FACE_LAYERS in js/viewer.js, the
 * layers from js/layers.js, ranked for the view's camera); Blender has only the
 * geometry, and with two faces at one depth it shows whichever its rounding
 * favours -- a pillar's yellow top under the green one it was laid on. So a
 * face of a group is put on the group's plane, and lifted off it toward the
 * camera's side by its layer: a step a layer of a two-thousandth of the draw's
 * size, within bounds, which a depth buffer keeps from the distances a draw of
 * that size is looked at from and is not seen as a gap. Works in the draw's
 * own space, on a triangle's three corners.
 *
 * Moved face by face, a lifted face came off the faces it shares an edge
 * with, and Blender showed the background through every such edge: cracks
 * across Honey's face and gloves. So a corner moves as the highest face on it
 * moves, and every face on that corner goes with it; only a face lying on a
 * higher one corner for corner (a copy) keeps its own, or the two would meet
 * again. A corner on the open edge of a lower face stays put, for all the
 * faces on it: across that edge is another draw (Sonic's shoe meets his leg
 * there), which does not move with them. */
const LAYER_LIFT = 5e-4, LIFT_MIN = 0.004, LIFT_MAX = 0.05;
function layerPlacer(draw, eye) {
    const g = draw.geom;
    const layer = g.getAttribute('aLayer') ?? draw.layers?.layer, plane = g.getAttribute('aPlane') ?? draw.layers?.plane;
    if (!layer) return { place() {} };
    if (!g.boundingSphere) g.computeBoundingSphere();
    const lift = Math.min(LIFT_MAX, Math.max(LIFT_MIN, LAYER_LIFT * g.boundingSphere.radius));
    const local = eye.clone().applyMatrix4(draw.mesh.matrixWorld.clone().invert());
    const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    /* Where one face alone would put its corners: true if it moves them. */
    const shift = (i, p) => {
        const L = layer.getX(i);
        let w = 0;
        if (plane) n.set(plane.getX(i), plane.getY(i), plane.getZ(i)), w = plane.getW(i);
        if (plane && n.lengthSq() > 0) {
            const s = 1 / n.length();
            n.multiplyScalar(s);
            w *= s;
            for (const q of p) q.addScaledVector(n, w - n.dot(q));
        } else {
            if (L < 0.5) return false;
            n.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0]));
            if (n.lengthSq() === 0) return false;
            n.normalize();
            w = n.dot(p[0]);
        }
        if (L < 0.5) return true;
        const toward = n.dot(local) >= w ? 1 : -1;
        for (const q of p) q.addScaledVector(n, toward * L * lift);
        return true;
    };
    const pos = g.getAttribute('position');
    const keyOf = (q) => `${q.x},${q.y},${q.z}`;
    const rankOf = (i, moved) => Math.round(layer.getX(i)) * 2 + (moved ? 1 : 0);
    /* Per corner: the highest face's rank and the sum of its moves (ties are
     * averaged). Per face's three corners: the highest rank there. */
    const corners = new Map(), copies = new Map();
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const q0 = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const own = [], ranks = [], edges = new Map();
    for (let t = 0; t < draw.tris; t++) {
        for (let k = 0; k < 3; k++) q0[k].fromBufferAttribute(pos, t * 3 + k), p[k].copy(q0[k]);
        const moved = shift(t * 3, p);
        const keys = q0.map(keyOf);
        const d = p.map((q, k) => q.clone().sub(q0[k]));
        own.push(d);
        const rank = rankOf(t * 3, moved);
        ranks.push(rank);
        keys.forEach((key, k) => {
            const c = corners.get(key);
            if (!c || rank > c.rank) corners.set(key, { rank, d: d[k].clone(), count: 1 });
            else if (rank === c.rank) c.d.add(d[k]), c.count++;
        });
        const face = [...keys].sort().join('|');
        copies.set(face, Math.max(copies.get(face) ?? -Infinity, rank));
        keys.forEach((key, k) => {
            const edge = [key, keys[(k + 1) % 3]].sort().join('|');
            const e = edges.get(edge);
            if (e) e.count++;
            else edges.set(edge, { count: 1, rank });
        });
    }
    for (const [edge, e] of edges) {
        if (e.count > 1) continue;
        for (const key of edge.split('|')) {
            const c = corners.get(key);
            if (c.rank > e.rank) c.d.set(0, 0, 0);
        }
    }
    return {
        place(tri, p) {
            const keys = p.map(keyOf);
            const rank = ranks[tri];
            if (copies.get([...keys].sort().join('|')) > rank) {
                p.forEach((q, k) => q.add(own[tri][k]));
                return;
            }
            p.forEach((q, k) => {
                const c = corners.get(keys[k]);
                q.addScaledVector(c.d, 1 / c.count);
            });
        },
    };
}

/* Layers for the draws the explorer has none for: a posed fighter's parts,
 * whose decals -- Sonic's shoe straps and buckles -- the explorer keeps over
 * the faces they are laid on by its recede (ZSORT_RECEDE in js/viewer.js),
 * which is depth and not geometry. Ranked here as js/layers.js ranks a
 * stage's, from the view's camera, in world space scaled back to the models'
 * own units: its gaps are in those, and a fighter posed a hundredth of his
 * size has his legs' faces within half a unit of each other, which flattened
 * them. Only the layers are kept, each face lifted off its own plane: taking
 * the group's plane, as a stage's faces do, moved shins and quills that are
 * no decal onto faces of the next part. */
function rankUnlayered(draws, camera) {
    const list = draws.filter((d) => !d.geom.getAttribute('aLayer'));
    if (!list.length) return;
    const attr = (d, name, size) => {
        const a = d.geom.getAttribute(name);
        return a ? a.array.subarray(0, d.tris * 3 * size) : null;
    };
    const inputs = list.map((d) => {
        /* A face's triangles share its facing point. */
        const pt = d.geom.getAttribute('aFacePt');
        const faces = new Int32Array(d.tris);
        for (let t = 1; t < d.tris; t++) {
            const a = (t - 1) * 3, b = t * 3;
            const same = pt.getX(a) === pt.getX(b) && pt.getY(a) === pt.getY(b) && pt.getZ(a) === pt.getZ(b);
            faces[t] = same ? faces[t - 1] : faces[t - 1] + 1;
        }
        const decoded = {
            positions: attr(d, 'position', 3), normals: attr(d, 'normal', 3), flags: attr(d, 'aFlags', 1), faces,
            zCorners: [0, 1, 2, 3].map((c) => attr(d, `aZc${c}`, 3)),
        };
        return { decoded, matrix: null };
    });
    const unit = 1 / Math.max(...list.map((d) => d.mesh.matrixWorld.getMaxScaleOnAxis()));
    const scale = new THREE.Matrix4().makeScale(unit, unit, unit);
    list.forEach((d, i) => { inputs[i].matrix = scale.clone().multiply(d.mesh.matrixWorld).elements; });
    if (inputs.some(({ decoded: x }) => !x.positions || !x.normals || !x.flags || x.zCorners.some((z) => !z))) return;
    const out = coplanarLayers(inputs);
    if (!out.ranking) return;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const eye = camera.getWorldPosition(new THREE.Vector3());
    rankLayers(out.ranking, [dir.x / unit, dir.y / unit, dir.z / unit, -dir.dot(eye)]);
    list.forEach((d, i) => {
        d.layers = { layer: new THREE.BufferAttribute(out[i].layer, 1), plane: null };
    });
}

/* One draw in world space, its faces split by material (see materialKey), with
 * UVs on their cells or, for a repeating face, in periods of its tile.
 *
 * The board's normals point away from the side it shows: it draws a one-sided
 * face when its normal and the eye-to-face line agree. Blender's front is the
 * other way, so each face is turned to face the side the board shows -- for a
 * two-sided face, the side the view's camera sees -- winding and normals both.
 * Turned the board's way, Blender's solid view lit every face from behind. */
function worldPart(draw, cells, faceImage, imageSize, eye, index) {
    const { mesh, geom, tris } = draw;
    const pos = geom.getAttribute('position'), nrm = geom.getAttribute('normal');
    const texel = geom.getAttribute('aTexel');
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const layered = layerPlacer(draw, eye);
    const groups = new Map();
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (let t = 0; t < tris; t++) {
        const flags = faceFlags(draw, t);
        const image = faceImage[t];
        const key = materialKey(image.index, flags);
        if (!groups.has(key)) groups.set(key, { key, positions: [], normals: [], uvs: [] });
        const out = groups.get(key);
        const { n: boardN, front } = boardFacing(draw, t, eye);
        const toward = boardN.clone().multiplyScalar(front ? -1 : 1);
        for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, t * 3 + k);
        layered.place(t, p);
        for (let k = 0; k < 3; k++) p[k].applyMatrix4(mesh.matrixWorld);
        const wound = e1.subVectors(p[1], p[0]).cross(e2.subVectors(p[2], p[0])).dot(toward);
        const order = wound < 0 ? [0, 2, 1] : [0, 1, 2];
        for (const k of order) {
            const src = t * 3 + k;
            p[k].toArray(out.positions, out.positions.length);
            n.fromBufferAttribute(nrm, src).applyMatrix3(normalMatrix).normalize();
            if (front) n.negate();
            n.toArray(out.normals, out.normals.length);
            if (image.period) {
                out.uvs.push(texel.getX(src) / image.period.w, 1 - texel.getY(src) / image.period.h);
            } else {
                const c = cells[t];
                out.uvs.push((c.x + c.p[k * 2]) / imageSize.width, 1 - (c.y + c.p[k * 2 + 1]) / imageSize.height);
            }
        }
    }
    return {
        name: mesh.name || `part${index}`,
        primitives: [...groups.values()].map((g) => ({
            key: g.key,
            positions: new Float32Array(g.positions),
            normals: new Float32Array(g.normals),
            uvs: new Float32Array(g.uvs),
        })),
    };
}

/* A face's material: its image, whether the board draws it from both sides,
 * and how it lets through what is behind it -- not at all, through the holes
 * in its tile, or by half (the checker). */
function materialKey(image, flags) {
    const alpha = flags & F_CHECKER ? 'BLEND' : flags & F_HOLES ? 'MASK' : 'OPAQUE';
    return `${image}/${flags & F_BOTH_SIDES ? 2 : 1}/${alpha}`;
}

/* ---- GLB ------------------------------------------------------------------ */

function pad4(n) { return (n + 3) & ~3; }

/* A binary glTF: one node and mesh per part, a primitive per material it uses.
 * images[0] is the sheet; the rest are periods, which repeat. */
export function buildGlb(parts, images) {
    const chunks = [];
    const views = [];
    let offset = 0;
    const addView = (bytes) => {
        views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
        chunks.push({ bytes, offset });
        offset = pad4(offset + bytes.byteLength);
        return views.length - 1;
    };
    const accessors = [];
    const addAccessor = (array, type, extra = {}) => {
        const size = type === 'VEC3' ? 3 : 2;
        accessors.push({
            bufferView: addView(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)),
            componentType: 5126, count: array.length / size, type, ...extra,
        });
        return accessors.length - 1;
    };
    const bounds = (a) => {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < a.length; i++) {
            min[i % 3] = Math.min(min[i % 3], a[i]);
            max[i % 3] = Math.max(max[i % 3], a[i]);
        }
        return { min, max };
    };
    const materials = [];
    const materialIndex = new Map();
    const materialFor = (key) => {
        if (!materialIndex.has(key)) {
            const [image, sides, alpha] = key.split('/');
            materialIndex.set(key, materials.length);
            materials.push({
                name: (+image ? `board tile ${image}` : 'board')
                    + (sides === '2' ? ' two-sided' : '')
                    + (alpha === 'MASK' ? ' cut-out' : alpha === 'BLEND' ? ' half' : ''),
                pbrMetallicRoughness: { baseColorTexture: { index: +image }, metallicFactor: 0, roughnessFactor: 1 },
                alphaMode: alpha,
                ...(alpha === 'MASK' ? { alphaCutoff: 0.5 } : {}),
                doubleSided: sides === '2',
                extensions: { KHR_materials_unlit: {} },
            });
        }
        return materialIndex.get(key);
    };
    const meshes = parts.map((part) => ({
        name: part.name,
        primitives: part.primitives.map((prim) => ({
            attributes: {
                POSITION: addAccessor(prim.positions, 'VEC3', bounds(prim.positions)),
                NORMAL: addAccessor(prim.normals, 'VEC3'),
                TEXCOORD_0: addAccessor(prim.uvs, 'VEC2'),
            },
            material: materialFor(prim.key),
            mode: 4,
        })),
    }));
    const gltfImages = images.map((png) => ({ bufferView: addView(png), mimeType: 'image/png' }));
    const json = {
        asset: { version: '2.0', generator: 'noclip (Sega Model 2 explorer)' },
        extensionsUsed: ['KHR_materials_unlit'],
        scene: 0,
        scenes: [{ nodes: parts.map((_, i) => i) }],
        nodes: parts.map((part, i) => ({ name: part.name, mesh: i })),
        meshes,
        materials,
        textures: images.map((_, i) => ({ source: i, sampler: i ? 1 : 0 })),
        /* The sheet point-sampled: its cells are a few texels each, and filtered
         * (Blender mipmaps a linear texture) every triangle's edge took in its
         * neighbours' colours, a grey seam down each of Sonic's gloves. A
         * period has only itself to blend with and stays smooth far off. */
        samplers: [
            { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 },
            { magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 },
        ],
        images: gltfImages,
        accessors,
        bufferViews: views,
        buffers: [{ byteLength: offset }],
    };
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jsonLen = pad4(text.length);
    const out = new Uint8Array(12 + 8 + jsonLen + 8 + offset);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true);          // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, out.length, true);
    dv.setUint32(12, jsonLen, true);
    dv.setUint32(16, 0x4E4F534A, true);         // 'JSON'
    out.fill(0x20, 20, 20 + jsonLen);
    out.set(text, 20);
    const bin = 20 + jsonLen;
    dv.setUint32(bin, offset, true);
    dv.setUint32(bin + 4, 0x004E4942, true);    // 'BIN\0'
    for (const c of chunks) out.set(c.bytes, bin + 8 + c.offset);
    return out;
}

/* ---- The whole of it ---------------------------------------------------- */

/** The view at this frame as GLB bytes, or null when nothing is showing. */
export async function exportView(viewer) {
    const draws = collectDraws(viewer);
    if (!draws.length) return null;
    const maxSize = Math.min(MAX_SHEET, viewer.renderer.capabilities.maxTextureSize);
    const eye = viewer.camera.getWorldPosition(new THREE.Vector3());
    rankUnlayered(draws, viewer.camera);

    /* The repeating faces, one period per key. */
    const periods = [];
    const byKey = new Map();
    const periodic = draws.map((d) => Array.from({ length: d.tris }, (_, t) => {
        const period = facePeriod(d, t);
        if (!period) return null;
        const key = periodKey(d, t, period, eye);
        if (!byKey.has(key)) {
            byKey.set(key, periods.length);
            periods.push({ ...period, face: { draw: d, tri: t } });
        }
        return periods[byKey.get(key)];
    }));

    const plan = planSheet(draws, periodic, maxSize);
    const sheetJobs = draws.map((d, i) => ({ draw: d, geom: bakeGeometry(d, plan.cells[i], plan.width, plan.height) }));
    const { rgba, covered } = bakeSheet(viewer, sheetJobs, plan.width, plan.height, true);
    growIntoGutters(rgba, covered, plan.width, plan.height);
    const images = [await encodePng(cropRows(rgba, plan.width, 0, 0, plan.width, plan.height), plan.width, plan.height)];

    /* Each period baked into a sheet of them, then cut out as its own image. */
    const seen = new Map();
    for (const sheet of planPeriods(periods, maxSize)) {
        const jobs = sheet.periods.map((p) => ({ draw: p.face.draw, geom: periodGeometry(p, sheet) }));
        const px = bakeSheet(viewer, jobs, sheet.width, sheet.height, false).rgba;
        for (const p of sheet.periods) {
            const pixels = cropRows(px, sheet.width, p.x, p.y, p.w, p.h);
            const hash = hashPixels(pixels);
            const same = (seen.get(hash) ?? []).find((o) => samePixels(o.pixels, pixels));
            if (same) { p.image = same.image; continue; }
            p.image = images.length;
            images.push(await encodePng(pixels, p.w, p.h));
            seen.set(hash, [...(seen.get(hash) ?? []), { pixels, image: p.image }]);
        }
    }

    const parts = draws.map((d, i) => {
        const faceImage = periodic[i].map((p) => (p ? { index: p.image, period: p } : { index: 0 }));
        return worldPart(d, plan.cells[i], faceImage, plan, eye, i);
    });
    return buildGlb(parts, images);
}
