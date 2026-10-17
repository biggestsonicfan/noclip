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
 * What it leaves out: the sky panorama and the scroll layers, which are not
 * models, and the camera, which is not the game's.
 */

import { THREE, createBakeMaterial } from './viewer.js';

const GUTTER = 2;       // px round each cell, grown out of its face
const CELL_CAP = 128;   // the longest side one face's cell may take, at full scale
const FLAT_CELL = 6;    // a face whose texels have no area: one colour, or near it
const MAX_SHEET = 4096;

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

/* Shelves, tallest cells first. Returns the sheet's height. */
function packCells(cells, width) {
    const order = cells.map((_, i) => i).sort((a, b) => cells[b].h - cells[a].h);
    let x = 0, y = 0, row = 0;
    for (const i of order) {
        const c = cells[i];
        const w = c.w + 2 * GUTTER, h = c.h + 2 * GUTTER;
        if (x + w > width) { x = 0; y += row; row = 0; }
        c.x = x + GUTTER;
        c.y = y + GUTTER;
        x += w;
        row = Math.max(row, h);
    }
    return Math.ceil((y + row) / 4) * 4;
}

/* Lay every face out, at full scale if the sheet holds them and smaller until
 * it does. */
function planSheet(draws, maxSize) {
    let g = 1;
    for (let attempt = 0; attempt < 24; attempt++) {
        const cells = draws.map((d) => {
            const texel = d.geom.getAttribute('aTexel');
            return Array.from({ length: d.tris }, (_, t) => faceCell(texel, t, g));
        });
        const flat = cells.flat();
        const area = flat.reduce((a, c) => a + (c.w + 2 * GUTTER) * (c.h + 2 * GUTTER), 0);
        const width = Math.min(maxSize, Math.max(256, 2 ** Math.ceil(Math.log2(Math.sqrt(area * 1.15)))));
        const height = packCells(flat, width);
        if (height <= maxSize) return { cells, width, height };
        g *= Math.max(0.5, Math.min(0.9, Math.sqrt(maxSize * maxSize / (area * 1.2))));
    }
    throw new Error('Too many faces in view to fit one texture sheet.');
}

/* A copy of the draw for the sheet: its attributes, and where each corner
 * lands in the sheet in clip space. */
function bakeGeometry(draw, cells, width, height) {
    const g = new THREE.BufferGeometry();
    /* Copies, not the draw's own: disposing a geometry frees its attributes'
     * buffers, and the live draw would lose them. */
    for (const [name, attr] of Object.entries(draw.geom.attributes)) g.setAttribute(name, attr.clone());
    const at = new Float32Array(draw.tris * 6);
    cells.forEach((c, t) => {
        for (let k = 0; k < 3; k++) {
            at[t * 6 + k * 2] = (c.x + c.p[k * 2]) / width * 2 - 1;
            at[t * 6 + k * 2 + 1] = (c.y + c.p[k * 2 + 1]) / height * 2 - 1;
        }
    });
    g.setAttribute('aBake', new THREE.BufferAttribute(at, 2));
    g.setDrawRange(0, draw.tris * 3);
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

/* Draw every face into its cell, then again as plain coverage. */
function bakeSheet(viewer, draws, plan) {
    const r = viewer.renderer;
    const saved = {
        target: r.getRenderTarget(), clear: r.getClearColor(new THREE.Color()),
        alpha: r.getClearAlpha(), autoClear: r.autoClear,
    };
    const scene = new THREE.Scene();
    const bakeMats = new Map();
    const meshes = draws.map((d, i) => {
        const src = d.mesh.material;
        if (!bakeMats.has(src)) bakeMats.set(src, createBakeMaterial(src));
        const m = new THREE.Mesh(bakeGeometry(d, plan.cells[i], plan.width, plan.height), bakeMats.get(src));
        /* Placed where the draw stands: the shader lights a face by its normal
         * through this matrix, and with none every part was lit as if unposed
         * and unturned. Where the face lands in the sheet is aBake's alone. */
        m.matrixAutoUpdate = false;
        m.matrix.copy(d.mesh.matrixWorld);
        m.frustumCulled = false;
        scene.add(m);
        return m;
    });
    r.autoClear = false;
    try {
        const rgba = renderSheet(r, scene, viewer.camera, plan.width, plan.height);
        const mask = maskMaterial();
        for (const m of meshes) m.material = mask;
        const covered = renderSheet(r, scene, viewer.camera, plan.width, plan.height);
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

/* The sheet as a PNG, top row first as an image is; GL's rows run bottom up. */
async function sheetPng(rgba, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
        img.data.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('The browser would not encode the texture sheet.');
    return new Uint8Array(await blob.arrayBuffer());
}

/* One draw in world space, with its UVs on its cells. A mirrored draw has its
 * winding turned back so its faces still face out. */
function worldPart(draw, cells, width, height, index) {
    const { mesh, geom, tris } = draw;
    const pos = geom.getAttribute('position'), nrm = geom.getAttribute('normal');
    const mirrored = mesh.matrixWorld.determinant() < 0;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const positions = new Float32Array(tris * 9);
    const normals = new Float32Array(tris * 9);
    const uvs = new Float32Array(tris * 6);
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < tris; t++) {
        const c = cells[t];
        for (let k = 0; k < 3; k++) {
            const src = t * 3 + k;
            const dst = t * 3 + (mirrored && k ? 3 - k : k);
            p.fromBufferAttribute(pos, src).applyMatrix4(mesh.matrixWorld).toArray(positions, dst * 3);
            n.fromBufferAttribute(nrm, src).applyMatrix3(normalMatrix).normalize().toArray(normals, dst * 3);
            uvs[dst * 2] = (c.x + c.p[k * 2]) / width;
            uvs[dst * 2 + 1] = 1 - (c.y + c.p[k * 2 + 1]) / height;
        }
    }
    return { name: mesh.name || `part${index}`, positions, normals, uvs };
}

/* ---- GLB ------------------------------------------------------------------ */

function pad4(n) { return (n + 3) & ~3; }

/* A binary glTF: one node and mesh per part, all on one unlit material whose
 * texture is the sheet. */
export function buildGlb(parts, png, { blend = false } = {}) {
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
    const meshes = parts.map((part) => ({
        name: part.name,
        primitives: [{
            attributes: {
                POSITION: addAccessor(part.positions, 'VEC3', bounds(part.positions)),
                NORMAL: addAccessor(part.normals, 'VEC3'),
                TEXCOORD_0: addAccessor(part.uvs, 'VEC2'),
            },
            material: 0,
            mode: 4,
        }],
    }));
    const image = addView(png);
    const json = {
        asset: { version: '2.0', generator: 'noclip (Sega Model 2 explorer)' },
        extensionsUsed: ['KHR_materials_unlit'],
        scene: 0,
        scenes: [{ nodes: parts.map((_, i) => i) }],
        nodes: parts.map((part, i) => ({ name: part.name, mesh: i })),
        meshes,
        materials: [{
            name: 'board',
            pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
            alphaMode: blend ? 'BLEND' : 'MASK',
            ...(blend ? {} : { alphaCutoff: 0.5 }),
            doubleSided: true,
            extensions: { KHR_materials_unlit: {} },
        }],
        textures: [{ source: 0, sampler: 0 }],
        samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }],
        images: [{ bufferView: image, mimeType: 'image/png' }],
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
    const plan = planSheet(draws, maxSize);
    const { rgba, covered } = bakeSheet(viewer, draws, plan);
    growIntoGutters(rgba, covered, plan.width, plan.height);
    const png = await sheetPng(rgba, plan.width, plan.height);
    const parts = draws.map((d, i) => worldPart(d, plan.cells[i], plan.width, plan.height, i));
    const blend = draws.some((d) => {
        const f = d.geom.getAttribute('aFlags');
        for (let t = 0; t < d.tris; t++) if (Math.round(f.getX(t * 3)) & 2) return true;
        return false;
    });
    return buildGlb(parts, png, { blend });
}
