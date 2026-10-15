/*
 * fbx.mjs — a binary FBX 7.4 writer, and the node tree of one skinned mesh.
 *
 * Binary rather than ASCII because Blender's importer reads only binary. The
 * layout follows what Blender's own exporter writes (io_scene_fbx,
 * encode_bin.py and export_fbx_bin.py): the same header, the same fixed file
 * id and creation time, the same footer, and the same objects for a mesh
 * bound to a skeleton — Geometry and Model, a Skin with a Cluster per bone,
 * LimbNode models with their NodeAttributes, and a BindPose.
 */

/* ---- Encoding ------------------------------------------------------------ */

/* A property is a tagged value: {t: 'I', v: 1}. The helpers below build them. */
export const I = (v) => ({ t: 'I', v });
export const L = (v) => ({ t: 'L', v: BigInt(v) });
export const D = (v) => ({ t: 'D', v });
export const S = (v) => ({ t: 'S', v });
export const C = (v) => ({ t: 'C', v });
export const R = (v) => ({ t: 'R', v });
export const Da = (v) => ({ t: 'd', v });
export const Ia = (v) => ({ t: 'i', v });

/* A node: name, its properties, its children. */
export const N = (name, props = [], children = []) => ({ name, props, children });

/* Plain values take their usual tags, so most nodes can be written as
 * N('Version', [232]) rather than N('Version', [I(232)]). */
function tag(p) {
    if (p && typeof p === 'object' && 't' in p) return p;
    if (typeof p === 'string') return S(p);
    if (typeof p === 'boolean') return C(p);
    if (typeof p === 'bigint') return L(p);
    if (Number.isInteger(p)) return I(p);
    return D(p);
}

function encodeProp(p) {
    const { t, v } = tag(p);
    let b;
    switch (t) {
        case 'C': b = Buffer.alloc(2); b[0] = 0x43; b[1] = v ? 1 : 0; return b;
        case 'I': b = Buffer.alloc(5); b[0] = 0x49; b.writeInt32LE(v, 1); return b;
        case 'L': b = Buffer.alloc(9); b[0] = 0x4c; b.writeBigInt64LE(v, 1); return b;
        case 'D': b = Buffer.alloc(9); b[0] = 0x44; b.writeDoubleLE(v, 1); return b;
        case 'S': case 'R': {
            const s = t === 'S' ? Buffer.from(v, 'latin1') : Buffer.from(v);
            b = Buffer.alloc(5); b[0] = t.charCodeAt(0); b.writeUInt32LE(s.length, 1);
            return Buffer.concat([b, s]);
        }
        case 'd': case 'i': {
            const size = t === 'd' ? 8 : 4;
            b = Buffer.alloc(13 + v.length * size);
            b[0] = t.charCodeAt(0);
            b.writeUInt32LE(v.length, 1);
            b.writeUInt32LE(0, 5);              /* not compressed */
            b.writeUInt32LE(v.length * size, 9);
            v.forEach((x, k) => (t === 'd' ? b.writeDoubleLE(x, 13 + k * 8) : b.writeInt32LE(x, 13 + k * 4)));
            return b;
        }
    }
    throw new Error(`fbx: no encoding for property type ${t}`);
}

const SENTINEL = Buffer.alloc(13);

/* A node record at `offset` in the file: its end offset comes first, so the
 * record is built before it is placed. */
function encodeNode(node, offset) {
    const props = Buffer.concat(node.props.map(encodeProp));
    const name = Buffer.from(node.name, 'latin1');
    const head = Buffer.alloc(13 + name.length);
    let at = offset + head.length + props.length;
    const kids = [];
    for (const c of node.children) {
        const k = encodeNode(c, at);
        kids.push(k);
        at += k.length;
    }
    /* A node with children, or with nothing at all, ends on a null record. */
    if (node.children.length || !node.props.length) {
        kids.push(SENTINEL);
        at += SENTINEL.length;
    }
    head.writeUInt32LE(at, 0);
    head.writeUInt32LE(node.props.length, 4);
    head.writeUInt32LE(props.length, 8);
    head[12] = name.length;
    name.copy(head, 13);
    return Buffer.concat([head, props, ...kids]);
}

const VERSION = 7400;
/* Blender's: a file id and a footer id that go with its fixed creation time. */
const FILE_ID = Buffer.from('28b32aebb624ccc2bfc8b02aa92bfcf1', 'hex');
const FOOT_ID = Buffer.from('fabcab09d0c8d466b176fb831cf7267e', 'hex');
const FOOT_MAGIC = Buffer.from('f85a8c6adef5d97eece90ce3758f290b', 'hex');
const TIME = '1970-01-01 10:00:00:000';

/** The top-level nodes, as a file. */
export function encodeFbx(nodes) {
    const parts = [Buffer.concat([Buffer.from('Kaydara FBX Binary  \0', 'latin1'), Buffer.from([0x1a, 0])])];
    const ver = Buffer.alloc(4); ver.writeUInt32LE(VERSION);
    parts.push(ver);
    let at = 27;
    for (const n of nodes) {
        const b = encodeNode(n, at);
        parts.push(b);
        at += b.length;
    }
    parts.push(SENTINEL, FOOT_ID, Buffer.alloc(4));
    at += SENTINEL.length + FOOT_ID.length + 4;
    const pad = ((at + 15) & ~15) - at || 16;
    parts.push(Buffer.alloc(pad), ver, Buffer.alloc(120), FOOT_MAGIC);
    return Buffer.concat(parts);
}

/* ---- Properties70 -------------------------------------------------------- */

const P = (...v) => N('P', v.map((x, k) => (k >= 4 && typeof x === 'number' && !Number.isInteger(x) ? D(x) : x)));
const Pd = (name, type, flags, ...v) => N('P', [name, type, '', flags, ...v.map(D)]);
const P70 = (...ps) => N('Properties70', [], ps);

/* ---- Matrices ------------------------------------------------------------ */

/* Column-major 4x4, as three.js and FBX both store them. */
export function mul4(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}

/* The inverse of a rigid transform with a scale per axis, which is all a
 * fighter's matrices are. */
export function invertAffine(m) {
    const r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];   /* columns */
    const len2 = r.map((c) => c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
    const o = new Array(16).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[j * 4 + i] = r[i][j] / len2[i];
    for (let i = 0; i < 3; i++) o[12 + i] = -(o[i] * m[12] + o[4 + i] * m[13] + o[8 + i] * m[14]);
    o[15] = 1;
    return o;
}

/* A local matrix as FBX's Lcl Translation, Rotation (degrees, XYZ order:
 * R = Rz Ry Rx) and Scaling. */
export function decompose(m) {
    const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    const r = (row, col) => m[col * 4 + row] / [sx, sy, sz][col];
    const deg = 180 / Math.PI;
    const y = Math.asin(Math.max(-1, Math.min(1, -r(2, 0))));
    let x, z;
    if (Math.abs(r(2, 0)) < 0.9999999) {
        x = Math.atan2(r(2, 1), r(2, 2));
        z = Math.atan2(r(1, 0), r(0, 0));
    } else {
        x = Math.atan2(-r(1, 2), r(1, 1));
        z = 0;
    }
    return { t: [m[12], m[13], m[14]], r: [x * deg, y * deg, z * deg], s: [sx, sy, sz] };
}

/* ---- The document -------------------------------------------------------- */

const name2 = (name, cls) => `${name}\0\x01${cls}`;

function modelNode(id, name, type, local, extra = []) {
    const { t, r, s } = decompose(local);
    return N('Model', [L(id), name2(name, 'Model'), type], [
        N('Version', [232]),
        P70(
            Pd('Lcl Translation', 'Lcl Translation', 'A', ...t),
            Pd('Lcl Rotation', 'Lcl Rotation', 'A', ...r),
            Pd('Lcl Scaling', 'Lcl Scaling', 'A', ...s),
            P('DefaultAttributeIndex', 'int', 'Integer', '', 0),
            P('InheritType', 'enum', '', '', 1),
            ...extra,
        ),
        N('Shading', [C(true)]),
        N('Culling', ['CullingOff']),
    ]);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * One mesh skinned rigidly to a skeleton, with one textured material.
 *
 * @param {object} doc
 *   name       the character's name, for every object's name
 *   positions  bind-pose points, xyz, in the skeleton's world
 *   polygons   per polygon, its point indices
 *   normals, uvs  per polygon corner, in polygon order (xyz, uv)
 *   bones      [{name, parent, matrix (world, column-major), points: indices}]
 *   texture    {file, png} the diffuse map, embedded and named beside
 */
export function skinnedMeshFbx(doc) {
    const s = newScene();
    /* The root: an empty the armature and the mesh hang from, which Blender
     * makes the armature object. */
    const rootId = s.id();
    s.objects.push(modelNode(rootId, doc.name, 'Null', IDENTITY));
    s.link(rootId, 0);

    const { geoId, meshId } = addMesh(s, doc, rootId);
    addMaterial(s, doc, meshId);
    const boneIds = addSkeleton(s, doc, rootId);
    addSkin(s, doc, { geoId, meshId, boneIds });
    return encodeFbx(fileNodes(s, doc));
}

/** The objects and connections a file is being built from, and ids for them. */
function newScene() {
    let next = 1000000;
    const s = { objects: [], links: [], id: () => next++ };
    s.link = (child, parent, prop) => s.links.push(prop
        ? N('C', ['OP', L(child), L(parent), prop])
        : N('C', ['OO', L(child), L(parent)]));
    return s;
}

/* A layer element written per polygon corner, the way Blender writes them. */
const layerElement = (name, version, label, ref, ...data) => N(name, [0], [
    N('Version', [version]), N('Name', [label]),
    N('MappingInformationType', [name === 'LayerElementMaterial' ? 'AllSame' : 'ByPolygonVertex']),
    N('ReferenceInformationType', [ref]),
    ...data,
]);

function addMesh(s, doc, rootId) {
    const geoId = s.id(), meshId = s.id();
    const index = [];
    const uvIndex = [];
    doc.polygons.forEach((poly) => poly.forEach((p, k) => {
        index.push(k === poly.length - 1 ? ~p : p);
        uvIndex.push(uvIndex.length);
    }));
    const layer = (type) => N('LayerElement', [], [N('Type', [type]), N('TypedIndex', [0])]);
    s.objects.push(N('Geometry', [L(geoId), name2(doc.name, 'Geometry'), 'Mesh'], [
        N('Vertices', [Da(doc.positions)]),
        N('PolygonVertexIndex', [Ia(index)]),
        N('GeometryVersion', [124]),
        layerElement('LayerElementNormal', 102, '', 'Direct', N('Normals', [Da(doc.normals)])),
        layerElement('LayerElementUV', 101, 'UVMap', 'IndexToDirect',
            N('UV', [Da(doc.uvs)]), N('UVIndex', [Ia(uvIndex)])),
        layerElement('LayerElementMaterial', 101, '', 'IndexToDirect', N('Materials', [Ia([0])])),
        N('Layer', [0], [
            N('Version', [100]),
            layer('LayerElementNormal'), layer('LayerElementUV'), layer('LayerElementMaterial'),
        ]),
    ]));
    s.objects.push(modelNode(meshId, doc.name, 'Mesh', IDENTITY));
    s.link(meshId, rootId);
    s.link(geoId, meshId);
    return { geoId, meshId };
}

/* The material and its map, the image carried in the file as well. */
function addMaterial(s, doc, meshId) {
    const matId = s.id(), texId = s.id(), vidId = s.id();
    const file = doc.texture.file;
    s.objects.push(N('Material', [L(matId), name2(doc.name, 'Material'), ''], [
        N('Version', [102]), N('ShadingModel', ['lambert']), N('MultiLayer', [0]),
        P70(
            Pd('DiffuseColor', 'Color', 'A', 1, 1, 1),
            Pd('DiffuseFactor', 'Number', 'A', 1),
            Pd('AmbientColor', 'Color', 'A', 0, 0, 0),
            Pd('EmissiveFactor', 'Number', 'A', 0),
        ),
    ]));
    s.objects.push(N('Video', [L(vidId), name2(file, 'Video'), 'Clip'], [
        N('Type', ['Clip']),
        P70(P('Path', 'KString', 'XRefUrl', '', file)),
        N('UseMipMap', [0]),
        N('Filename', [file]),
        N('RelativeFilename', [file]),
        N('Content', [R(doc.texture.png)]),
    ]));
    s.objects.push(N('Texture', [L(texId), name2(file, 'Texture'), ''], [
        N('Type', ['TextureVideoClip']), N('Version', [202]),
        N('TextureName', [name2(file, 'Texture')]),
        P70(P('UVSet', 'KString', '', '', 'UVMap'), P('UseMaterial', 'bool', '', '', 1)),
        N('Media', [name2(file, 'Video')]),
        N('FileName', [file]),
        N('RelativeFilename', [file]),
        N('ModelUVTranslation', [D(0), D(0)]),
        N('ModelUVScaling', [D(1), D(1)]),
        N('Texture_Alpha_Source', ['None']),
        N('Cropping', [0, 0, 0, 0]),
    ]));
    s.link(matId, meshId);
    s.link(texId, matId, 'DiffuseColor');
    s.link(vidId, texId);
}

/* The skeleton: a LimbNode per bone, placed in its parent's frame. */
function addSkeleton(s, doc, rootId) {
    const boneIds = doc.bones.map(() => s.id());
    doc.bones.forEach((b, k) => {
        const attrId = s.id();
        const parentWorld = b.parent >= 0 ? doc.bones[b.parent].matrix : IDENTITY;
        const local = mul4(invertAffine(parentWorld), b.matrix);
        s.objects.push(N('NodeAttribute', [L(attrId), name2(b.name, 'NodeAttribute'), 'LimbNode'], [
            N('TypeFlags', ['Skeleton']),
            P70(P('Size', 'double', 'Number', '', D(100))),
        ]));
        s.objects.push(modelNode(boneIds[k], b.name, 'LimbNode', local));
        s.link(attrId, boneIds[k]);
        s.link(boneIds[k], b.parent >= 0 ? boneIds[b.parent] : rootId);
    });
    return boneIds;
}

/* The skin: every point on exactly one bone, at full weight. */
function addSkin(s, doc, { geoId, meshId, boneIds }) {
    const skinId = s.id();
    s.objects.push(N('Deformer', [L(skinId), name2(doc.name, 'Deformer'), 'Skin'], [
        N('Version', [101]), N('Link_DeformAcuracy', [D(50)]),
    ]));
    s.link(skinId, geoId);
    doc.bones.forEach((b, k) => {
        const clusterId = s.id();
        s.objects.push(N('Deformer', [L(clusterId), name2(b.name, 'SubDeformer'), 'Cluster'], [
            N('Version', [100]),
            N('UserData', ['', '']),
            N('Indexes', [Ia(b.points)]),
            N('Weights', [Da(b.points.map(() => 1))]),
            N('Transform', [Da(invertAffine(b.matrix))]),
            N('TransformLink', [Da(b.matrix)]),
        ]));
        s.link(clusterId, skinId);
        s.link(boneIds[k], clusterId);
    });

    const poseId = s.id();
    s.objects.push(N('Pose', [L(poseId), name2(doc.name, 'Pose'), 'BindPose'], [
        N('Type', ['BindPose']), N('Version', [100]),
        N('NbPoseNodes', [doc.bones.length + 1]),
        N('PoseNode', [], [N('Node', [L(meshId)]), N('Matrix', [Da(IDENTITY)])]),
        ...doc.bones.map((b, k) => N('PoseNode', [], [N('Node', [L(boneIds[k])]), N('Matrix', [Da(b.matrix)])])),
    ]));
}

/* The file's top level around the scene: header, axes and units, counts. */
function fileNodes(s, doc) {
    const count = (type) => s.objects.filter((o) => o.name === type).length;
    const types = ['Model', 'Geometry', 'Material', 'Texture', 'Video', 'Deformer', 'NodeAttribute', 'Pose'];
    const axis = (name, v) => [P(name, 'int', 'Integer', '', v), P(`${name}Sign`, 'int', 'Integer', '', 1)];
    const scale = D(doc.unitScale ?? 100);
    return [
        N('FBXHeaderExtension', [], [
            N('FBXHeaderVersion', [1003]),
            N('FBXVersion', [VERSION]),
            N('EncryptionType', [0]),
            N('CreationTimeStamp', [], [
                N('Version', [1000]), N('Year', [1970]), N('Month', [1]), N('Day', [1]),
                N('Hour', [10]), N('Minute', [0]), N('Second', [0]), N('Millisecond', [0]),
            ]),
            N('Creator', ['noclip tools/fbx']),
        ]),
        N('FileId', [R(FILE_ID)]),
        N('CreationTime', [TIME]),
        N('Creator', ['noclip tools/fbx']),
        N('GlobalSettings', [], [
            N('Version', [1000]),
            P70(
                ...axis('UpAxis', 1), ...axis('FrontAxis', 2), ...axis('CoordAxis', 0), ...axis('OriginalUpAxis', 1),
                P('UnitScaleFactor', 'double', 'Number', '', scale),
                P('OriginalUnitScaleFactor', 'double', 'Number', '', scale),
            ),
        ]),
        N('Documents', [], [
            N('Count', [1]),
            N('Document', [L(s.id()), '', 'Scene'], [N('RootNode', [L(0)])]),
        ]),
        N('References'),
        N('Definitions', [], [
            N('Version', [100]),
            N('Count', [types.reduce((n, t) => n + count(t), 0) + 1]),
            N('ObjectType', ['GlobalSettings'], [N('Count', [1])]),
            ...types.filter(count).map((t) => N('ObjectType', [t], [N('Count', [count(t)])])),
        ]),
        N('Objects', [], s.objects),
        N('Connections', [], s.links),
    ];
}
