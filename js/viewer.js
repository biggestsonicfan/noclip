/*
 * viewer.js — the three.js scene, materials and camera rigs.
 *
 * Two camera rigs share one scene: an orbit rig for inspecting a single model
 * and a noclip-style fly rig (pointer lock + WASD) for walking a stage. Model 2
 * geometry arrives as flat-shaded triangle soup with a per-face colour from the
 * ROM palette, so the material is a small custom shader rather than one of the
 * stock three.js materials: it needs vertex colours, a two-sided |N.L| term
 * (the board lights polygons two-sided) and an optional texture-atlas path.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* Model 2 geometry is Y-up but the polygon decoder negates Z on read, which
 * leaves meshes in a right-handed space matching three.js directly. */

const VERT_SHADER = /* glsl */`
    in vec3 aColor;
    in vec2 aTexel;      // tile-relative texel coords
    in vec4 aTile;       // atlas tile rect: x, y, w, h (pixels)
    in float aLumaBase;  // lumaram band for this face, -1 when untextured
    in float aFlags;     // 1 = transparent, 2 = checker, 4 = sheet, 8/16 = mirror X/Y
                         // bits 5-6 = the face's z source, see below
    in float aMaterial;  // which of the 32 material slots lights this face
    in vec3 aZc0;        // the four corners of the polygon this face is sorted
    in vec3 aZc1;        // by; a triangle repeats one, and a face that asked
    in vec3 aZc2;        // for the previous polygon's z carries that polygon's
    in vec3 aZc3;        // corners instead of its own

    // Everything the decoder writes once per face and copies to all three of
    // its vertices is flat, and has to be: the fill path truncates vTile and
    // vLumaBase with int(), and a smooth varying only reproduces its constant
    // to within the interpolator's rounding. (a/w)/(1/w) is the constant in
    // exact arithmetic and a hair under it in float, which differs by vendor —
    // a tile width of 32 arriving as 31.99999 makes tileTexel wrap modulo 31,
    // and a lumabase one short reads a neighbouring palette colour. Only the
    // texel coordinate and the normals vary across a face.
    flat out vec3 vColor;
    out vec3 vNormal;
    out vec2 vTexel;
    flat out vec4 vTile;
    flat out float vLumaBase;
    flat out float vFlags;
    flat out float vMaterial;
    out vec3 vViewNormal;
    out vec3 vViewPos;

    void main() {
        vColor = aColor;
        vTexel = aTexel;
        vTile = aTile;
        vLumaBase = aLumaBase;
        vFlags = aFlags;
        vMaterial = aMaterial;
        // World space, not view space: m2-hle2 shades against a light the
        // coprocessor supplies in camera space, which is right for the game's
        // fixed camera but would swing the lighting around as you fly here.
        vNormal = mat3(modelMatrix) * normal;
        // The board's front/back test is taken in camera space, against the
        // polygon's own point, so the view-space normal is needed too.
        vViewNormal = mat3(modelViewMatrix) * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;

        // The board has no depth buffer. model2_3d_process_polygon gives a
        // whole polygon one z -- the nearest or the farthest of its corners,
        // per the attribute word -- sorts on that into 65536 buckets drawn
        // near-first, and the fill writes a pixel only if nothing has written
        // it yet. So a *polygon* wins a pixel, whatever the geometry does
        // between it and the next: Casino Night's platform carries its emerald
        // 0.087 under the near-black plate it is painted on, and the plate asks
        // to be sorted by its farthest corner, which is how the board draws the
        // emerald over it and a depth buffer does not.
        //
        // Only half of that rule is taken here, and the half is the point. A
        // polygon may take its own depth when that pushes it *back*, never when
        // it pulls it forward. Pushing back is what the artists used it for --
        // a big backing plane stands out of the way of the small faces painted
        // on it. Pulling forward is the same instruction read the other way: a
        // surface claims every pixel it covers at the depth of its nearest
        // corner, which under the game's own camera is harmless and under a
        // free one turns a floor into a wall, hiding the posts standing on it.
        // The board can afford that; a viewer whose whole point is to fly
        // around cannot, so what a polygon would gain is left to the depth
        // buffer and only what it gives up is honoured.
        int zmode = (int(aFlags + 0.5) >> 5) & 3;
        float z0 = (modelViewMatrix * vec4(aZc0, 1.0)).z;
        float z1 = (modelViewMatrix * vec4(aZc1, 1.0)).z;
        float z2 = (modelViewMatrix * vec4(aZc2, 1.0)).z;
        float z3 = (modelViewMatrix * vec4(aZc3, 1.0)).z;
        // View z runs negative into the screen, so the board's min_z -- its
        // nearest corner -- is the greatest of these and its max_z the least.
        float zNear = max(max(z0, z1), max(z2, z3));
        float zFar = min(min(z0, z1), min(z2, z3));
        float zb = zmode == 2 ? zFar
                 : zmode == 3 ? -1e10                 // the board's error case
                 : zNear;
        // And what it gives up is bounded, which the board does not bound. A
        // recede is safe while it lands behind the things the polygon is meant
        // to be behind, and it is the board's own camera that makes that true:
        // it sits close to what it draws, so a plane stepping back to its far
        // corner steps behind everything. From a camera that can be anywhere it
        // does not. Canyon Cruise is the case that shows it: the river runs from
        // under the lens to forty units out, and a face of it taken back to its
        // own far corner lands in the middle of the boat and paints water over
        // the deck. So each vertex may recede, by its own polygon's depth but no
        // further than ZSORT_RECEDE -- which keeps the slope of a polygon lying
        // along the view, and still separates the flat-against-each-other faces
        // the rule exists for, because those are shallow and recede in full.
        //
        // And the bound alone is not enough, because what it bounds is still a
        // sink: a ground plane pushed back by twelve units passes below
        // anything modelled under it within them. So the measure of whether to
        // recede at all is the face's own depth -- how far its near corner
        // stands in front of its far one along the view. A face turned toward
        // the camera is a few units deep whatever its size, and stepping it
        // back by that is the whole of what the rule was for: two faces lying
        // flat against each other are shallow together, so the backing one
        // recedes in full and the decal keeps the pixel. A face raked along the
        // view is deep, and stepping it back by its far corner sinks its near
        // end through whatever stands under it. A face deeper than
        // ZSORT_RECEDE therefore keeps the depth the projection gave it, which
        // for real geometry is the right answer and one the depth buffer can
        // resolve.
        //
        // Aurora Icefield is what that is for. Its ground is four wedges
        // hundreds of units deep at any grazing angle, and receding them sank
        // the ice below the walruses' reflection and the lower half of the
        // cage, both of which hang under it -- so they showed from outside the
        // ring, where the board only ever shows them through it.
        //
        // It is not free either, and what it costs is everything the sinking
        // floor was covering up. A floor that keeps its own depth tells the
        // truth about the models, and the models were built for a machine that
        // sorted whole polygons and never had to be truthful.
        //
        // Mushroom Hill's forest floor genuinely interpenetrates the stump it
        // surrounds. Sinking the floor hid that; leaving it where it is shows
        // the intersection, as wedges of grass cutting into the bark. The
        // repair is depth precision -- near sits at 0.02 against a far of
        // 2000 -- and not a smaller bound, which would have to stay above the
        // 0.139 Casino Night's emerald is modelled behind its plate and so
        // cannot go small enough to stop the sink mattering.
        //
        // South Island's sea-level plates are the other side of it, and they
        // needed an answer of their own. The sea 555, the floor plate 517 and
        // ground chunks 506 and 511 are modelled 0.01 apart, which at this near
        // plane is under the depth buffer's resolution a hundred units out, and
        // what had been holding them apart was the differing shear the bounded
        // recede put across them. Worse, the island 518 standing on all four is
        // not deep and does recede, so it sank into the water it stands in.
        // Neither is a tie a depth test can be asked to break, and neither is
        // the bound's fault: the board sorts the two plates by a corner
        // hundreds of units out and everything standing in them wins. So they
        // are told to say that -- see waterMaterial and floorMaterial.
        const float ZSORT_RECEDE = 12.0;
        float zf = (zNear - zFar) <= ZSORT_RECEDE
            ? clamp(zb, mv.z - ZSORT_RECEDE, mv.z)
            : mv.z;
#ifdef ZSORT_CONCEDE
        // And a draw that is the floor of the world stands the whole bound back
        // whether its faces are shallow or not, because it is the one kind of
        // surface the deep-face rule leaves stranded in front of things that
        // are standing on it -- see waterMaterial.
        zf = min(zf, mv.z - ZSORT_RECEDE);
#endif
        // Carried as z/w rather than as a depth, so the clipper keeps it: it
        // interpolates z and w together and their ratio is what survives.
        //
        // And only for a vertex the camera is actually in front of. Behind the
        // lens gl_Position.w is negative, and there the substitute is not a
        // depth at all: the clamp hands back +/-1 whatever the corners say, so
        // z comes out as -w exactly -- the near plane -- and the clipper, which
        // finds where an edge crosses it by interpolating z against w, is told
        // the crossing is at the vertex it should be cutting away. The polygon
        // is thrown out whole rather than trimmed. Aurora Icefield is where
        // that shows: its ground is four wedges three hundred units across, and
        // whichever of them the camera stands over loses every corner behind
        // the lens and vanishes, taking a quadrant of the icefield with it.
        // A vertex the camera cannot see needs no help sorting, so it keeps the
        // depth the projection gave it and the clipper cuts the edge where it
        // really crosses.
        if (gl_Position.w > 0.0) {
            float zc = projectionMatrix[2][2] * zf + projectionMatrix[3][2];
            float zw = projectionMatrix[2][3] * zf + projectionMatrix[3][3];
            gl_Position.z = clamp(zc / max(zw, 1e-6), -1.0, 1.0) * gl_Position.w;
        }
    }
`;

/* The textured path reproduces MAME's model2 fill exactly (model2rd.ipp, and
 * m2-hle2's port of it in ui/game_render.h): the 4-bit texel indexes a band of
 * lumaram chosen by the face's lumabase, that is scaled by the per-face
 * lighting term, and the result indexes colorxlat per channel against the
 * face's 5-bit palette colour. Without those two RAM tables loaded it falls
 * back to m2-hle2's flat approximation, colour x luma x 2. */
const FRAG_SHADER = /* glsl */`
    precision highp float;
    precision highp int;

    uniform vec3 uLightDir;
    uniform float uAmbient;
    uniform float uDiffuse;
    uniform vec3 uTint;
    uniform float uBright;
    uniform int uShadeMode;     // 0 = lit palette, 1 = flat palette, 2 = normals, 3 = tile id
    uniform sampler2D uAtlas;
    uniform vec2 uAtlasSize;
    uniform float uUseAtlas;
    uniform sampler2D uLuma;
    uniform sampler2D uCxlat;
    uniform float uUseRamp;
    uniform float uLumaScale;
    // Set for a game whose colour tables have not been located: see the note in
    // the untextured branch below.
    uniform float uFlatTexel;
    uniform vec3 uLight;         // the stage's light vector, world space
    uniform vec2 uMaterial[32];  // per slot: (diffuse, ambient), 0..255
    uniform int uTransfer;      // 0 = none, 1 = linear->gamma, 2 = gamma->linear
    uniform float uFogDensity;
    uniform vec3 uFogColor;

    flat in vec3 vColor;
    in vec3 vNormal;
    in vec2 vTexel;
    flat in vec4 vTile;
    flat in float vLumaBase;
    flat in float vFlags;
    flat in float vMaterial;
    in vec3 vViewNormal;
    in vec3 vViewPos;

    out vec4 fragColor;

    // Stable pseudo-colour for a tile rect, so distinct textures read as
    // distinct surfaces even when the atlas is unavailable.
    vec3 tileHue(vec4 tile) {
        float h = fract(sin(dot(tile.xy, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 k = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
        return clamp(abs(fract(h + k) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    }

    // The sRGB transfer function and its inverse, component-wise. These are the
    // exact piecewise curves, not the 2.2 power approximation, so a round trip
    // through both is lossless and the switch below can be trusted as a probe
    // rather than adding a bias of its own.
    vec3 linearToGamma(vec3 c) {
        return mix(1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                   12.92 * c,
                   step(c, vec3(0.0031308)));
    }
    vec3 gammaToLinear(vec3 c) {
        return mix(pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4)),
                   c / 12.92,
                   step(c, vec3(0.04045)));
    }
    vec3 transfer(vec3 c) {
        if (uTransfer == 1) return linearToGamma(c);
        if (uTransfer == 2) return gammaToLinear(c);
        return c;
    }

    float lumaByte(int i) {
        return texelFetch(uLuma, ivec2(i & 255, i >> 8), 0).r * 255.0;
    }
    float cxlatByte(int i) {
        return texelFetch(uCxlat, ivec2(i & 255, i >> 8), 0).r * 255.0;
    }

    // The geometry engine's per-polygon luma, as cpres2 computes it (and as
    // MAME's geo_parse_np_ns does for the boards that keep the TGP):
    //
    //   luminance = (N.L * N.P < 0) ? 0 : |N.L|
    //   luma      = clamp(luminance * diffuse + ambient, 0, 255)
    //
    // N is the polygon's own normal out of ROM, L the stage's light vector, and
    // diffuse/ambient the material slot the polygon's attribute word names. The
    // sign test is the board's own: a polygon lit from the far side gets its
    // ambient term and nothing else.
    float polyLuma() {
        vec3 n = normalize(vNormal);
        float dotl = dot(n, uLight);
        float dotp = dot(normalize(vViewNormal), vViewPos);
        float luminance = (dotl * dotp < 0.0) ? 0.0 : abs(dotl);
        vec2 m = uMaterial[int(vMaterial + 0.5)];
        return clamp(luminance * m.x + m.y, 0.0, 255.0);
    }

    bool flags(int bit) {
        return (int(vFlags + 0.5) & bit) != 0;
    }

    // ---- The mip chain --------------------------------------------------
    //
    // The board does not sample the full-size level at every distance, and the
    // smaller levels are already in the atlas: send_lod_data_q box-filters them
    // into texture RAM as part of unpacking a page, and atlas.js brings the
    // whole of both sheets across. Only the addressing was missing.
    //
    // Level L of a tile lives at ((texx - 2048) >> L) & 2047 and
    // ((texy - 1024) >> L) & 1023, halving in size, on the sheet that alternates
    // with L (model2rd.ipp fetch_bilinear_texel). At L = 0 that reduces to the
    // tile itself. The arithmetic is unsigned because the board's is: the
    // subtraction wraps, and that wrap is what puts the mips where they are.
    ivec4 levelTile(int L) {
        int sheet = flags(4) ? 1 : 0;
        uint x = (uint(int(vTile.x)) - 2048u) >> uint(L);
        uint y = (uint(int(vTile.y) - sheet * 1024) - 1024u) >> uint(L);
        return ivec4(int(x & 2047u), int(y & 1023u) + ((sheet + L) & 1) * 1024,
                     max(int(vTile.z) >> L, 1), max(int(vTile.w) >> L, 1));
    }

    // A texel of one level, wrapped within that level the way the board's index
    // mask does, and folded to the sheet like get_texel. The offset keeps the
    // modulo away from negatives, which GLSL leaves undefined; eight copies is
    // an even number, so it does not disturb which copy is a reflected one.
    //
    // Mirroring is the board's u = ~u (model2rd.ipp fetch_bilinear_texel): a
    // coordinate that has run into an odd copy of the tile is inverted, so that
    // copy reads back to front. Inverting the index is the same mapping,
    // texel q of an odd copy becoming size-1-q.
    float tileTexel(ivec4 tile, ivec2 p) {
        ivec2 size = tile.zw;
        ivec2 s = p + size * 8;
        ivec2 q = s % size;
        ivec2 copy = s / size;
        if (flags(8) && (copy.x & 1) != 0) q.x = size.x - 1 - q.x;
        if (flags(16) && (copy.y & 1) != 0) q.y = size.y - 1 - q.y;
        return texelFetch(uAtlas, (tile.xy + q) & 2047, 0).r;
    }

    // Filtered texel of one level, as vec2(value, coverage).
    //
    // Coverage only means anything on the transparent renderer, where a texel of
    // 15 is a hole: it carries no colour of its own, so it takes a neighbour's,
    // and the four holes' weights blend into a coverage that has to reach half a
    // texel for the pixel to survive. That is what keeps a cut-out edge smooth
    // rather than stepped, and keeps the key from bleeding into the surface.
    const float KEY = 15.0 / 15.0;
    vec2 sampleLevel(int L) {
        ivec4 tile = levelTile(L);
        vec2 t = vTexel / exp2(float(L)) - 0.5;   // the board's half-texel offset
        ivec2 i0 = ivec2(floor(t));
        vec2 f = fract(t);

        float t00 = tileTexel(tile, i0);
        float t10 = tileTexel(tile, i0 + ivec2(1, 0));
        float t01 = tileTexel(tile, i0 + ivec2(0, 1));
        float t11 = tileTexel(tile, i0 + ivec2(1, 1));

        float a = 1.0;
        if (flags(1)) {
            vec4 cover = 1.0 - step(KEY, vec4(t00, t10, t01, t11));
            a = mix(mix(cover.x, cover.y, f.x), mix(cover.z, cover.w, f.x), f.y);
            // Substitution, in the board's order: a hole borrows from the texel
            // it is paired with, first along the row, then between the rows.
            if (t00 == KEY) t00 = t10;
            if (t10 == KEY) t10 = t00;
            if (t01 == KEY) t01 = t11;
            if (t11 == KEY) t11 = t01;
        }
        float row0 = mix(t00, t10, f.x);
        float row1 = mix(t01, t11, f.x);
        if (flags(1)) {
            if (row0 == KEY) row0 = row1;
            if (row1 == KEY) row1 = row0;
        }
        return vec2(mix(row0, row1, f.y), a);
    }

    void main() {
        // The checker bit is the board's half-transparency: the polygon is drawn
        // on every other screen pixel and whatever is behind it shows through
        // the rest (model2rd.ipp steps x by 2 and skips the opposite parity).
        // South Island uses it on the water planes and the waterfall.
        if (flags(2) && ((int(gl_FragCoord.x) ^ int(gl_FragCoord.y)) & 1) == 0) discard;

        vec3 n = normalize(vNormal);

        if (uShadeMode == 2) {
            fragColor = vec4(n * 0.5 + 0.5, 1.0);
            return;
        }

        // Same term m2-hle2 computes per face (geo3d.h), approximating MAME's
        // model2_v.cpp geo_parse: two-sided |N.L|, ambient 0.45 + diffuse 0.55,
        // clamped at 1 so a face never brightens past its palette colour.
        float shade = 1.0;
        if (uShadeMode == 0) {
            shade = min(uAmbient + uDiffuse * abs(dot(n, normalize(uLightDir))), 1.0);
        }

        vec3 base = vColor * uTint * uBright;
        vec3 rgb;

        if (uShadeMode == 3) {
            rgb = (vTile.z > 0.0 ? tileHue(vTile) : vec3(0.15)) * shade;
        } else if (uUseAtlas > 0.5 && vTile.z > 0.0) {
            // Pick the level the way a GPU does rather than the way the board
            // does. The board is handed a texlod the geometry engine computed
            // from the polygon's distance, and that number is calibrated to
            // 496x384; this viewer runs at whatever size the window is. Screen
            // space derivatives ask the same question — how many texels does
            // this pixel cover — against the resolution actually being drawn.
            float lod = clamp(log2(max(length(dFdx(vTexel)), length(dFdy(vTexel)))),
                              0.0, log2(min(vTile.z, vTile.w)) - 1.0);
            int L0 = int(floor(lod));
            vec2 texel = mix(sampleLevel(L0), sampleLevel(L0 + 1), fract(lod));
            if (flags(1) && texel.y < 0.5) discard;
            float al = texel.x;

            if (uUseRamp > 0.5 && vLumaBase >= 0.0) {
                // MAME filters the texel first and indexes the band with the
                // filtered value, which is why a band holds 128 entries for 16
                // texels: lumaram[lumabase + (t >> 1)], t being the texel in
                // 8.4. Indexing by the nearest of the sixteen instead would
                // quantise every blended pixel onto a neighbouring palette
                // slot, which on a palette band is a different colour rather
                // than a slightly different brightness.
                int lbyte = 2 * (int(vLumaBase) + int(al * 120.0));
                float lram = lumaByte(lbyte);
                // The board's own per-polygon luma. The sea, the ring floor,
                // the palm fronds and the clouds all name material 31, which
                // this stage uploads as diffuse 0, ambient 255 — so they come
                // out at a flat 255 and land exactly on the sixteen palette
                // slots their luma band holds. Nothing infers that any more;
                // the material table says it.
                float poly = polyLuma() * uLumaScale;
                int li = int(min(lram * poly / 256.0, 63.0) + 0.5);
                // The colorxlat index is the face's raw 5-bit palette colour;
                // the stage tint and brightness are viewer-side and must not
                // move which table row is read.
                int r5 = int(vColor.r * 31.0 + 0.5);
                int g5 = int(vColor.g * 31.0 + 0.5);
                int b5 = int(vColor.b * 31.0 + 0.5);
                vec3 c = vec3(cxlatByte(((r5 << 8) + li) * 2),
                              cxlatByte(0x4000 + ((g5 << 8) + li) * 2),
                              cxlatByte(0x8000 + ((b5 << 8) + li) * 2));
                rgb = clamp(max(c - 64.0, 0.0) * (255.0 / 191.0) / 255.0, 0.0, 1.0);
                rgb *= uTint * uBright;
            } else {
                rgb = base * shade;
                if (al > 0.0) {
                    rgb = clamp(base * al * 2.0 * shade, 0.0, 1.0);
                    // A face does not have to name a colour: it can name a row
                    // of the colour table, and that row reads black until the
                    // game fills it. Multiplying the texel by black throws away
                    // a sheet that unpacked perfectly, so where there is no
                    // colour table to fill the row, show the texel's own value
                    // instead. This is not what the board puts out -- the real
                    // colour is in colorxlat and is not being read -- it is the
                    // only way to see the texture at all until it is.
                    if (uFlatTexel > 0.5 && dot(base, vec3(1.0)) < 0.02) {
                        rgb = vec3(al * shade);
                    }
                }
            }
        } else {
            rgb = base * shade;
        }

        // The fill path's output is display-referred: it comes straight out of
        // colorxlat and the gamma approximation, which is where MAME's own
        // pixels come from, so the default is to pass it through untouched.
        // The switch is here because that is a claim about the hardware, and
        // being able to put the alternative on screen next to a capture is how
        // it stays a checked claim rather than a remembered one.
        rgb = transfer(rgb);

        // Fog is a flat palette colour, display-referred like the surface, so
        // it takes the same transfer — otherwise the switch would silently
        // blend two different colour spaces.
        float d = length(vViewPos) * uFogDensity;
        rgb = mix(rgb, transfer(uFogColor), clamp(1.0 - exp(-d * d), 0.0, 1.0));

        fragColor = vec4(rgb, 1.0);
    }
`;

/* A sampler uniform left at null is bound to whatever three.js has lying around,
 * and texelFetch on an incomplete texture is undefined behaviour on some
 * drivers. The ramp path is gated at runtime, but the samplers still have to
 * resolve to something real, so give them 1x1 placeholders. */
function placeholderTexture() {
    const t = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
    t.needsUpdate = true;
    return t;
}

export function createModelMaterial() {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT_SHADER,
        fragmentShader: FRAG_SHADER,
        side: THREE.DoubleSide,
        /* Stated rather than left to the default, because a decal depends on
         * it. A decal here is the surface's own faces emitted again with a
         * cut-out texture, at the same depth to the bit, and the board draws
         * such a pair newest-first into a fill that keeps the first writer --
         * so the later face wins the pixel. `LessEqual` is the depth test that
         * says the same thing: at equal depth the later draw replaces the
         * earlier. `Less` would hand every decal to the face underneath it.
         * js/model.js keeps the two triangulations identical so that the depths
         * really are equal. */
        depthFunc: THREE.LessEqualDepth,
        uniforms: {
            /* geo3d.h's ambient/diffuse verbatim. The light direction is not
             * its (0.3, 0.5, 1.0) default: that is the coprocessor's fallback,
             * and the game overwrites it per frame with a much more overhead
             * vector. It matters more than it looks — colorxlat is not monotone,
             * and the ring canvas's green only appears above luma 48, which an
             * oblique light never reaches. This one reproduces the reference
             * capture of South Island. */
            uLightDir: { value: new THREE.Vector3(0.2, 1.0, 0.3) },
            uAmbient: { value: 0.45 },
            uDiffuse: { value: 0.55 },
            uTint: { value: new THREE.Vector3(1, 1, 1) },
            uBright: { value: 1 },
            uShadeMode: { value: 0 },
            uAtlas: { value: placeholderTexture() },
            uAtlasSize: { value: new THREE.Vector2(2048, 2048) },
            uUseAtlas: { value: 0 },
            uLuma: { value: placeholderTexture() },
            uCxlat: { value: placeholderTexture() },
            uUseRamp: { value: 0 },
            uLumaScale: { value: 1.0 },
            uFlatTexel: { value: 0 },
            uLight: { value: new THREE.Vector3(0, 1, 0) },
            uMaterial: { value: Array.from({ length: 32 }, () => new THREE.Vector2(0, 255)) },
            uTransfer: { value: 0 },
            uFogDensity: { value: 0.0 },
            uFogColor: { value: new THREE.Vector3(0.05, 0.06, 0.09) },
        },
    });
}

/** Build a three.js BufferGeometry from a decoded model. */
export function buildGeometry(decoded) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(decoded.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(decoded.normals, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(decoded.colors, 3));
    g.setAttribute('aTexel', new THREE.BufferAttribute(decoded.uvs, 2));
    g.setAttribute('aTile', new THREE.BufferAttribute(decoded.tiles, 4));
    g.setAttribute('aLumaBase', new THREE.BufferAttribute(decoded.lumaBases, 1));
    g.setAttribute('aFlags', new THREE.BufferAttribute(decoded.flags, 1));
    g.setAttribute('aMaterial', new THREE.BufferAttribute(decoded.mats, 1));
    for (let c = 0; c < 4; c++) {
        g.setAttribute(`aZc${c}`, new THREE.BufferAttribute(decoded.zCorners[c], 3));
    }
    g.computeBoundingSphere();
    return g;
}

export function buildEdgeGeometry(decoded) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(decoded.edges, 3));
    return g;
}

/* ---- Fly (noclip) camera ------------------------------------------------- */

/**
 * Fly camera: WASD to move, mouse to look under pointer lock, Q/E for down/up,
 * shift to sprint, ctrl to crawl. On a touchscreen the same rig is driven by
 * `pad` — an analog stick and a lift that js/mobile.js wires up — and a
 * one-finger drag on the view turns the camera. Speed is exposed so the stage
 * view can scale it to the arena.
 */
class FlyControls {
    constructor(camera, domElement) {
        this.camera = camera;
        this.dom = domElement;
        this.enabled = false;
        this.speed = 40;
        this.yaw = 0;
        this.pitch = 0;
        this.keys = new Set();
        this.sensitivity = 0.0022;
        /* A finger travels less than a mouse does for the same turn. */
        this.touchSensitivity = 0.005;
        /* The touch rig's input. `move` is the stick — x right and y down, as
         * on the screen, unit length at full throw; `up` is -1, 0 or 1. */
        this.pad = { move: new THREE.Vector2(), up: 0 };
        this._look = null;
        this._velocity = new THREE.Vector3();

        this._onMouseMove = (e) => {
            if (!this.enabled || document.pointerLockElement !== this.dom) return;
            this._turn(e.movementX * this.sensitivity, e.movementY * this.sensitivity);
        };
        this._onKeyDown = (e) => {
            if (!this.enabled) return;
            this.keys.add(e.code);
            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'].includes(e.code)) {
                e.preventDefault();
            }
        };
        this._onKeyUp = (e) => this.keys.delete(e.code);
        this._onBlur = () => this.keys.clear();

        /* The look drag. A mouse is the pointer-lock path above; a finger or
         * a pen turns the camera by how far it moved. One at a time — a second
         * finger is left alone. The orbit rig is disabled whenever this one is
         * enabled, so the two never fight over a touch. */
        this._onPointerDown = (e) => {
            if (!this.enabled || e.pointerType === 'mouse' || this._look) return;
            this._look = { id: e.pointerId, x: e.clientX, y: e.clientY };
            this.dom.setPointerCapture(e.pointerId);
        };
        this._onPointerMove = (e) => {
            const l = this._look;
            if (!l || e.pointerId !== l.id) return;
            this._turn((e.clientX - l.x) * this.touchSensitivity,
                (e.clientY - l.y) * this.touchSensitivity);
            l.x = e.clientX;
            l.y = e.clientY;
        };
        this._onPointerUp = (e) => {
            if (this._look && e.pointerId === this._look.id) this._look = null;
        };

        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('blur', this._onBlur);
        domElement.addEventListener('pointerdown', this._onPointerDown);
        domElement.addEventListener('pointermove', this._onPointerMove);
        domElement.addEventListener('pointerup', this._onPointerUp);
        domElement.addEventListener('pointercancel', this._onPointerUp);
    }

    /** Turn by so many radians, keeping the pitch short of straight up or down. */
    _turn(dYaw, dPitch) {
        this.yaw -= dYaw;
        this.pitch -= dPitch;
        const lim = Math.PI / 2 - 0.001;
        this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
        this._apply();
    }

    /** Adopt the current camera orientation so switching rigs does not snap. */
    syncFromCamera() {
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.yaw = e.y;
        this.pitch = e.x;
    }

    _apply() {
        this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    }

    lock() { this.dom.requestPointerLock(); }

    update(dt) {
        if (!this.enabled) return;
        const k = this.keys, p = this.pad;
        let f = 0, r = 0, u = 0;
        if (k.has('KeyW')) f += 1;
        if (k.has('KeyS')) f -= 1;
        if (k.has('KeyD')) r += 1;
        if (k.has('KeyA')) r -= 1;
        if (k.has('KeyE') || k.has('Space')) u += 1;
        if (k.has('KeyQ')) u -= 1;
        /* Stick up is forward, and screen y grows downward. */
        f -= p.move.y;
        r += p.move.x;
        u += p.up;
        if (f === 0 && r === 0 && u === 0) {
            this._velocity.multiplyScalar(Math.exp(-dt * 14));
        } else {
            let mult = 1;
            if (k.has('ShiftLeft') || k.has('ShiftRight')) mult = 4;
            if (k.has('ControlLeft') || k.has('ControlRight')) mult = 0.25;
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
            const target = new THREE.Vector3()
                .addScaledVector(fwd, f)
                .addScaledVector(right, r)
                .add(new THREE.Vector3(0, u, 0));
            /* Clamped to full speed rather than normalised to it: keys are all
             * or nothing and land there either way, but the stick's throw is
             * its speed. */
            if (target.lengthSq() > 1) target.normalize();
            target.multiplyScalar(this.speed * mult);
            this._velocity.lerp(target, 1 - Math.exp(-dt * 12));
        }
        this.camera.position.addScaledVector(this._velocity, dt);
        this._apply();
    }

    dispose() {
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('blur', this._onBlur);
        this.dom.removeEventListener('pointerdown', this._onPointerDown);
        this.dom.removeEventListener('pointermove', this._onPointerMove);
        this.dom.removeEventListener('pointerup', this._onPointerUp);
        this.dom.removeEventListener('pointercancel', this._onPointerUp);
    }
}

/* ---- Viewer -------------------------------------------------------------- */

export class Viewer {
    constructor(canvas, { touch = false } = {}) {
        this.canvas = canvas;
        /* On a touchscreen the fly rig is driven by the stick and a look drag
         * rather than pointer lock, which a tap could not release. */
        this.touch = touch;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        /* The fill shader is GLSL ES 3.00 — it integer-indexes the luma and
         * colour-translate tables with texelFetch, which GLSL ES 1.00 has no
         * equivalent for. Without WebGL2 nothing would draw at all, so say so
         * rather than showing an empty canvas. */
        if (!this.renderer.capabilities.isWebGL2) {
            throw new Error(
                'This browser gave a WebGL 1 context; the renderer needs WebGL 2. ' +
                'Check that hardware acceleration is enabled.');
        }

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b0d12);

        this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 20000);
        this.camera.position.set(0, 12, 45);

        this.orbit = new OrbitControls(this.camera, canvas);
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = 0.09;

        this.fly = new FlyControls(this.camera, canvas);
        this.fly.enabled = false;

        this.root = new THREE.Group();
        this.reach = null;      /* see setReach */
        /* Driven by hand: see setWorldFrame in app.js. */
        this.root.matrixAutoUpdate = false;
        this.scene.add(this.root);

        this.material = createModelMaterial();
        /*
         * The same material for a draw that belongs *behind* the horizon.
         *
         * `doom_cnt` stands the horizon up as a ring of flat panels at a radius
         * the art picked to clear the arena — 120 units on most stages — and
         * everything else the game draws stands inside that ring, so the shell
         * is genuinely the far wall and the depth buffer sorts it correctly. The
         * Death Egg is the one stage with something further out: `boss_disp`
         * hangs a card of the Earth at forty-two thousand, which the shell then
         * buries.
         *
         * The board has no such problem, because it does not draw that card in
         * the world at all — it resets the matrix to the identity first, so the
         * Earth is background rather than scenery. This material says the same
         * thing to a depth buffer: painted over whatever the shell put down,
         * before anything in the world is drawn, and writing its own depth so
         * that the arena still covers it. Making the *shell* depth-neutral
         * instead was tried, and it costs every other stage the near half of its
         * own horizon — South Island's cloud ring stands around its island and
         * is supposed to pass in front of it.
         *
         * It shares the uniforms object rather than a clone of it, so every
         * per-stage uniform the panel and the colour pipeline write lands on
         * both; `side` is the one piece of state that has to be mirrored, which
         * backfaceCull does.
         */
        this.backdropMaterial = createModelMaterial();
        this.backdropMaterial.uniforms = this.material.uniforms;
        this.backdropMaterial.depthTest = false;
        /*
         * And the same material again for camera_init's floor plate, which
         * concedes every tie it is in.
         *
         * The board has no depth buffer and no per-pixel tie-break. A polygon
         * carries one z, polygons bucket on it, and a bucket is rasterized
         * newest-first — model2_v.cpp prepends to the list — into a fill that
         * writes a pixel only where nothing has (`if (fill[x] == 0)`). So the
         * *last* submission over a bucket keeps the pixel, and `camera_init`
         * draws `stage_floor` before any other pass: the floor is the one
         * surface in the arena that loses every tie it is in.
         *
         * South Island is where that decides a picture rather than a seam. The
         * floor plate 517 and the sea 555 carry the same four quads over the
         * same ground — not merely coplanar but sorted on the *same four
         * corners*, so they resolve to one z at every camera that exists and no
         * depth test anywhere can separate them (stf-tools/dl-order.mjs). Which of
         * them showed was three.js's answer rather than the board's: the opaque
         * sort keys on the geometry's bounding-sphere centre, and the sea's
         * plate is lopsided enough — x -94.5..318.8 against the floor's ±24 —
         * that its centre lands the sea before or after the floor depending on
         * where the camera stands. Standing over the island it landed the sea
         * first, and the floor took the whole ring off it: 222,389 pixels of
         * still plate through the scrolling sea at one frame.
         *
         * So the floor states the concession itself: one depth unit and one
         * slope unit back. That settles the shallow tie by the unit and the
         * raked one by the slope, where two triangulations of the same flat
         * quad — the sea cuts three of these four along the other diagonal —
         * round apart and speckle. Measured over four cameras the floor takes no
         * pixel of the sea at all, and the ground pass keeps the ones it had: its
         * shore chunks sit 0.0016 over the plate, which is under the buffer's
         * resolution at this range either way, and they are submitted after the
         * floor too, so the step moves that tie the way the board already
         * moved it.
         *
         * It costs a rim. On the Flying Carpet, Mushroom Hill, Dynamite Plant
         * and Giant Wing a hairline where the plate meets the surface around it
         * — 2,035 pixels at worst — now goes to that surface, which is the same
         * answer for the same reason: everything is submitted after the floor.
         *
         * And a depth unit only settles ties. The plate loses more than ties —
         * everything standing in it wins over it outright on the board, because
         * `stage_floor` is one plate hundreds of units across sorted by its own
         * farthest corner. That is the concede below, and the floor takes it for
         * the same reason the water does; the depth unit stays on top of it to
         * part the floor from the sea, which concedes the same amount.
         */
        this.floorMaterial = createModelMaterial();
        this.floorMaterial.uniforms = this.material.uniforms;
        this.floorMaterial.polygonOffset = true;
        this.floorMaterial.polygonOffsetFactor = 1;
        this.floorMaterial.polygonOffsetUnits = 1;
        this.floorMaterial.defines = { ZSORT_CONCEDE: '1' };
        /*
         * And the same material again for the open water, which takes the
         * board's sort in full instead of being left out of it.
         *
         * The recede is bounded, and a face deeper than the bound is left at
         * the depth the projection gave it — right for scenery, and wrong for
         * exactly one kind of surface. South Island's sea 555 is one plate six
         * hundred units across: deep from every camera, so it never moves,
         * while the island 518 standing in it is a box of bumpy rock faces a
         * few units deep that recede in full. The board sorts both by their
         * farthest corner and the island wins by hundreds of units. Here the
         * island stepped back its own three or four and the sea, standing
         * still, took the difference — a flat waterline slicing a third off the
         * rock wall and riding up and down it as the camera moved, which is how
         * the bug was reported. Canyon Cruise has it too, and worse: its river
         * swallowed the boat's hull and left the cabin floating.
         *
         * So the water concedes the whole bound whether its faces are shallow
         * or not. What that can cost is whatever is modelled under the water
         * within twelve units, and in this game nothing is — the sea plate and
         * the river are the lowest surfaces their stages have, which is the
         * same fact that makes the board's own unbounded sort safe on them.
         *
         * Measured over 216 cameras around South Island's arena, the sea and
         * the floor plate together took 1,975,304 of the island's 30,490,191
         * pixels and now take 202,172 — and what is left is the stipple edge of
         * the island's own shadow plate, which is modelled in the sea's plane,
         * drawn after it, and comes back with the rock. Across the sixteen
         * stages at six cameras each the change is 5,234 pixels, all of it
         * water meeting something standing in it.
         */
        this.waterMaterial = createModelMaterial();
        this.waterMaterial.uniforms = this.material.uniforms;
        this.waterMaterial.defines = { ZSORT_CONCEDE: '1' };
        this.edgeMaterial = new THREE.LineBasicMaterial({
            color: 0x63e0ff, transparent: true, opacity: 0.28, depthTest: true,
        });
        /* Bone chain overlay: drawn through the meshes so the rig stays readable. */
        this.skeletonMaterial = new THREE.LineBasicMaterial({
            color: 0xffb454, depthTest: false, transparent: true, opacity: 0.9,
        });

        this.grid = new THREE.GridHelper(400, 40, 0x2a3550, 0x18202f);
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.5;
        this.grid.material.depthWrite = false;
        this.grid.renderOrder = -1;
        this.grid.visible = false;
        this.scene.add(this.grid);

        this.axes = new THREE.AxesHelper(12);
        this.axes.visible = false;
        this.scene.add(this.axes);

        this._lastTime = performance.now();
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
        this.resize();

        canvas.addEventListener('click', () => {
            if (this.mode === 'fly' && !this.touch && document.pointerLockElement !== canvas) {
                this.fly.lock();
            }
        });
        document.addEventListener('pointerlockchange', () => {
            this._pointerLocked = document.pointerLockElement === canvas;
            if (this.onPointerLockChange) this.onPointerLockChange(this._pointerLocked);
        });

        this.mode = 'orbit';
        this.stats = { drawCalls: 0, triangles: 0 };
    }

    setMode(mode) {
        this.mode = mode;
        this.orbit.enabled = mode === 'orbit';
        this.fly.enabled = mode === 'fly';
        if (mode === 'fly') this.fly.syncFromCamera();
        if (mode === 'orbit' && document.pointerLockElement === this.canvas) {
            document.exitPointerLock();
        }
    }

    resize() {
        const w = this.canvas.clientWidth || 1;
        const h = this.canvas.clientHeight || 1;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    /** Cull back faces, or draw both sides — on the backdrop shells too. */
    backfaceCull(on) {
        for (const m of [this.material, this.backdropMaterial, this.floorMaterial,
            this.waterMaterial]) {
            m.side = on ? THREE.FrontSide : THREE.DoubleSide;
            m.needsUpdate = true;
        }
    }

    /*
     * A sphere the far plane has to reach, whatever the camera is framed on.
     *
     * frame() sets the far plane from the radius it was handed, and what it is
     * handed on a stage leaves the backdrop layers out — a stage framed on
     * those is an arena a few pixels across. Something has to carry them
     * anyway, or the plane that keeps the arena crisp is the plane that throws
     * away Giant Wing's clouds and the card of the Earth the Death Egg hangs
     * forty-two thousand units out. Precision is governed by the near plane
     * rather than this one, so covering the whole draw list costs nothing that
     * shows.
     */
    setReach(center, radius) {
        this.reach = { center: new THREE.Vector3(...center), radius };
        this.frameFar();
    }

    /** Push the far plane out to whatever setReach asked for, from where the
     *  camera stands now. */
    frameFar() {
        if (!this.reach) return;
        const need = (this.camera.position.distanceTo(this.reach.center)
            + this.reach.radius) * 1.02;
        if (need > this.camera.far) {
            this.camera.far = need;
            this.camera.updateProjectionMatrix();
        }
    }

    /** Clear everything currently under the scene root, and un-tilt the root. */
    clear() {
        /* A stage whose arena moves hangs the scene on a per-frame matrix; the
         * next thing loaded must not inherit it. */
        this.root.matrix.identity();
        this.root.matrixWorldNeedsUpdate = true;
        this.reach = null;
        for (const child of [...this.root.children]) {
            this.root.remove(child);
            child.traverse?.((o) => {
                if (o.geometry) o.geometry.dispose();
            });
        }
    }

    /** Frame the camera on a bounding sphere. */
    frame(center, radius, { fly = false, dir = [0.55, 0.42, 0.75] } = {}) {
        const r = Math.max(radius, 0.5);
        const dist = r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.15;
        const c = new THREE.Vector3(center[0], center[1], center[2]);
        this.orbit.target.copy(c);
        this.camera.position.set(c.x + dist * dir[0], c.y + dist * dir[1], c.z + dist * dir[2]);
        this.camera.lookAt(c);
        this.orbit.update();
        this.fly.syncFromCamera();
        this.camera.near = Math.max(0.02, r / 4000);
        this.camera.far = Math.max(2000, r * 60);
        this.camera.updateProjectionMatrix();
        this.frameFar();
        this.fly.speed = fly ? Math.max(8, r * 0.5) : Math.max(2, r * 0.6);
        this.grid.scale.setScalar(Math.max(0.05, r / 100));
    }

    render() {
        const now = performance.now();
        const dt = Math.min((now - this._lastTime) / 1000, 0.1);
        this._lastTime = now;
        if (this.mode === 'orbit') this.orbit.update();
        else this.fly.update(dt);
        this.renderer.render(this.scene, this.camera);
        const info = this.renderer.info.render;
        this.stats.drawCalls = info.calls;
        this.stats.triangles = info.triangles;
    }
}

export { THREE };
