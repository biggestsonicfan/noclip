/*
 * osage.js — the sway chains: Honey's pigtails, Fang's tail and the rest.
 *
 * 揺れ物 — "swaying things". Five fighters carry parts that are not on the
 * sixteen-slot skeleton at all: they hang off a bone and trail behind it.
 * `osage_per_character` at `0x68D64` maps a character to a definition table,
 * and `osage_dsp` at `0x67640` walks that table as a stream of typed records:
 *
 *   1  MATRIX    0x24  the frame the segments are drawn in: a bone, then a
 *                      Z, Y and X angle to turn it by
 *   2  COLI      0x40  collision volumes the sway is kept out of
 *   3  ETC       0x0C  damping
 *   4  TSUKENE   0x18  a new chain: a root mode (+0x04), the bone it attaches
 *                      to (+0x08) and the offset it hangs from (+0x0C)
 *   5  OSAGE     0x44  one segment: its model (+0x1C) and length (+0x28)
 *   0  END
 *
 * The table says who has what:
 *
 *   Fang    one chain of three on the chest — his tail
 *   Bark    one segment on the head
 *   Espio   one segment on the chest
 *   Bean    four chains on the chest
 *   Honey   two chains of three on the head — her pigtails — and one on the chest
 *
 * Everyone else points at the same empty table, `0x69DE4`. Tails is one of
 * them: his tails are not sway chains but a display routine of their own,
 * `tails_tail_disp` at `0x1AB58`, which is not read here.
 *
 * `os_set_tsukene` at 0x680E0 dispatches the root on the mode at +0x04 —
 * `ost_norm`, `ost_same`, `ost_save` — and the fighters do not agree on it:
 * Honey's chains are mode 0, Fang's is mode 2. Mode 0 walks the attach bone,
 * then pushes the result through the osage frame a second time; mode 2 loads
 * the frame first and multiplies the bone into it. Only the frame's own turn is
 * applied here, which is what puts a tail behind its owner instead of in front,
 * and the difference between the modes is not yet reproduced.
 *
 * What is drawn here is the chain at rest, under gravity. `os_set_matrix` at
 * 0x67D28 builds the frame — load the attach bone's matrix, then ang_z, ang_y,
 * ang_x from the MATRIX record — and then adds the engine's own gravity,
 * `flt_50A000` divided by the record's own factor, to the Y of the hang axis
 * before renormalising it. So a resting chain does not follow its bone: it is
 * pulled towards vertical, which is why the pigtails fall behind the head
 * rather than sticking out along it.
 *
 * There is no sway to reproduce. The engine has an integrator for it and never
 * runs it: both halves are gated on bit 0 of the chain's flag word, and the end
 * of `osage_dsp` at 0x67D1C clears that bit on every pass. Nowhere in the
 * module is there a matching `setbit 0`.
 *
 *   os_set_matrix  0x67E74   bbc 0 -> the sway direction at 0x114 is not stored
 *   os_set_osage   0x68600   bbc 0 -> the static path at 0x686EC runs instead,
 *                                     which never advances 0x108, the running
 *                                     position
 *
 * So the chain state that would carry momentum is frozen: 0x114 holds whatever
 * `osage_init` left in it and 0x108 never leaves the root. There is a wind
 * oscillator behind it that is dead the same way — `0x68AA4` reads its
 * amplitude from a per-character table at 0x68914 whose 52 entries all point at
 * one record, and that record's amplitude is 0.0f, so the vector at 0x138 is
 * always zero while the phase at 0x130 goes on stepping 0x11C7 a frame under
 * it. A populated table of real speeds and amplitudes sits unreferenced at
 * 0x68A04: the wind was authored and then switched off.
 *
 * `stf-tools/test-osage-mame.mjs` holds all of that against a capture of a real
 * fight. Over 36 frames of Honey walking, across two motions, her chest bone
 * moves 0.388 and her head 0.124 while every one of those chain values stays
 * bit-identical. So the rest pose here is not an approximation of a simulation
 * that was too hard to port — it is what the board draws.
 */

import { turnedBy } from './pose.js';

/* Turn a frame by the shortest rotation that carries `from` onto `to`, both
 * unit vectors. Used to stand a chain vertical without disturbing the roll it
 * already has about its own axis. Rodrigues, with the half-turn case split out
 * because the axis is undefined there. */
function alignFrame(m, from, to) {
    const c = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
    let ax = [from[1] * to[2] - from[2] * to[1],
        from[2] * to[0] - from[0] * to[2],
        from[0] * to[1] - from[1] * to[0]];
    let sn = Math.hypot(ax[0], ax[1], ax[2]);
    if (sn < 1e-9) {
        if (c > 0) return m.slice();
        /* Opposite: any perpendicular axis will do. */
        const t = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        ax = [from[1] * t[2] - from[2] * t[1],
            from[2] * t[0] - from[0] * t[2],
            from[0] * t[1] - from[1] * t[0]];
        sn = Math.hypot(ax[0], ax[1], ax[2]);
    }
    const k = [ax[0] / sn, ax[1] / sn, ax[2] / sn];
    const ct = Math.max(-1, Math.min(1, c)), st = Math.sqrt(Math.max(0, 1 - ct * ct));
    const rot = (v) => {
        const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
        const kx = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
        return [0, 1, 2].map((i) => v[i] * ct + kx[i] * st + k[i] * kv * (1 - ct));
    };
    const o = new Array(9);
    for (let col = 0; col < 3; col++) {
        const r = rot([m[col * 3], m[col * 3 + 1], m[col * 3 + 2]]);
        o[col * 3] = r[0]; o[col * 3 + 1] = r[1]; o[col * 3 + 2] = r[2];
    }
    return o;
}

const OSAGE_PER_CHARACTER = 0x00068d64;
const RECORD_SIZE = { 1: 0x24, 2: 0x40, 3: 0x0c, 4: 0x18, 5: 0x44 };
const MATRIX = 1, TSUKENE = 4, SEGMENT = 5;

/* The engine's gravity, `flt_50A000`, written as 0x3CCE9ED5 at 0x6BA4. */
export const GRAVITY = 0.02522222138941288;

/* The half turn about Z the sway frame needs on top of the record's own angles.
 * Found by eye against all five fighters rather than read out of the ROM — see
 * the note in osageParts. */
export const FRAME_ROLL = 0x8000;


/**
 * Read a fighter's sway chains, or null if it has none.
 *
 * @returns {?{table:number, frame:{bone:number,ax:number,ay:number,az:number},
 *             chains:Array<{bone:number, offset:number[],
 *                           segments:Array<{model:number,length:number}>}>}}
 */
export function readOsage(rom, charIndex) {
    const dv = rom.mainCpuView;
    const table = dv.getUint32(OSAGE_PER_CHARACTER + charIndex * 4, true);
    if (!table || table + 4 > rom.maincpu.length) return null;

    let frame = null;
    const chains = [];
    let chain = null;
    let a = table;
    /* The stream is terminated by a zero type; the bound is only so a table
     * that is not one cannot run away. */
    for (let n = 0; n < 512; n++) {
        if (a + 4 > rom.maincpu.length) return null;
        const type = dv.getUint32(a, true);
        if (type === 0) break;
        const size = RECORD_SIZE[type];
        if (!size || a + size > rom.maincpu.length) return null;
        if (type === MATRIX) {
            frame = {
                bone: dv.getUint32(a + 0x04, true),
                /* `op 0x06 set_pos` is additive — T += rot * this — so the
                 * frame sits offset from the bone it is built on. */
                offset: [
                    dv.getFloat32(a + 0x14, true),
                    dv.getFloat32(a + 0x18, true),
                    dv.getFloat32(a + 0x1c, true),
                ],
                /* The record's own gravity divisor, at +0x20. `os_set_matrix`
                 * at 0x67E2C divides by it — `divr` computes src2/src1 — and
                 * every fighter's is 1.0, so it has never shown. */
                scale: dv.getFloat32(a + 0x20, true),
                az: dv.getUint32(a + 0x08, true) & 0xffff,
                ay: dv.getUint32(a + 0x0c, true) & 0xffff,
                ax: dv.getUint32(a + 0x10, true) & 0xffff,
            };
        } else if (type === TSUKENE) {
            chain = {
                /* `os_set_tsukene` at 0x680E0 dispatches on this: 0 ost_norm,
                 * 1 ost_same, 2 ost_save, 3 ost_load. */
                mode: dv.getUint32(a + 0x04, true),
                bone: dv.getUint32(a + 0x08, true),
                offset: [
                    dv.getFloat32(a + 0x0c, true),
                    dv.getFloat32(a + 0x10, true),
                    dv.getFloat32(a + 0x14, true),
                ],
                segments: [],
            };
            chains.push(chain);
        } else if (type === SEGMENT && chain) {
            chain.segments.push({
                model: dv.getUint32(a + 0x1c, true),
                length: dv.getFloat32(a + 0x28, true),
                /* Added to the hang direction before it is normalised — the
                 * `R` of the sway integration. Honey's is a rounding-sized
                 * nudge; Fang's is what swings his tail off the vertical. */
                bias: [
                    dv.getFloat32(a + 0x2c, true),
                    dv.getFloat32(a + 0x30, true),
                    dv.getFloat32(a + 0x34, true),
                ],
            });
        }
        a += size;
    }
    if (!chains.length) return null;
    return { table, frame, chains };
}

/**
 * Place a fighter's sway chains on a solved pose, at rest.
 *
 * A chain hangs from its attach bone: the root is that bone's own position
 * stepped by the offset in the bone's frame, and each segment sits one length
 * further down the hang axis than the one before it.
 *
 * Two things here are read off the hardware rather than derived. The step from
 * one segment to the next is the *next* segment's length, not its own — a
 * capture of Honey's pigtails steps 0.513 twice where the first segment's own
 * length is 0.402. And the chain hangs along the negative of the osage frame's
 * second column, which in that capture sits about eleven degrees off the
 * direction the segments actually ran; the remainder is sway, which is not
 * reproduced.
 *
 * @param {Array<{r:number[],t:number[]}>} pose  from buildPose(), board frame
 * @param {object} osage from readOsage()
 * @returns {Array<{model:number, r:number[], t:number[], chain:number, segment:number}>}
 */
export function osageParts(pose, osage, { turn = null } = {}) {
    if (!osage) return [];
    const out = [];
    const f = osage.frame;
    /* `os_set_matrix` at 0x67D28 builds the frame every segment is drawn in:
     * load the attach bone's matrix, then ang_z, ang_y and ang_x from the
     * MATRIX record. One frame serves every chain — the chest's, for all five
     * fighters that have one. */
    /* Then a half turn about Z, which is not in the record and is not yet
     * accounted for: read literally the frame is the attach bone turned by the
     * record's three angles and nothing more. But the chains only sit on their
     * fighters with it, and it is a clean half turn rather than a fitted angle.
     * A half turn about Y and one about Z commute into one about X, so this is
     * the same as `bone . Rz(az) . Rx(180)` — the record's Y angle standing in
     * for a roll the chain meshes are modelled with.
     *
     * A segment mesh runs along its own +Y for exactly its length — Fang's
     * three tail pieces span 1.04, 1.00 and 0.83 against lengths of 1.0, 1.0
     * and 0.8 — so a right frame lays them end to end with no gap or overlap.
     *
     * `turn` is a viewer-side knob on top of all this, for finding the rest by
     * eye; zero is the frame as described. */
    const built = f && pose[f.bone] ? turnedBy(pose[f.bone].r, f.ax, f.ay, f.az) : null;
    const frame = built ? turnedBy(built, 0, 0, FRAME_ROLL) : null;
    const base = frame && turn && (turn[0] || turn[1] || turn[2])
        ? turnedBy(frame, turn[0], turn[1], turn[2])
        : frame;
    /* Gravity. A chain at rest hangs vertically, so the axis is world-down and
     * not the frame's — the frame leans with the chest, which would tilt the
     * pigtails off the vertical by however far she is leaning and swing them
     * about as she turns. The frame still sets the roll about that axis: the
     * chain is stood upright by the shortest turn that carries the frame's own
     * hang column onto the vertical, which leaves everything else alone.
     *
     * `os_set_matrix` does add the engine's own gravity, `flt_50A000` scaled by
     * the record's factor, to the frame's local Y before rotating it out — but
     * at rest the chain's own axis is zero (`osage_init` clears 0x138), so that
     * term is the whole of the direction and its size cancels in the
     * normalise. What is left is the direction, which is down. */
    const down = [0, -1, 0];
    const pull = f && f.scale ? GRAVITY / f.scale : GRAVITY;
    const g = base ? alignFrame(base, [base[3], base[4], base[5]], down) : null;

    /* The frame's own translation, from the frame before it was stood upright.
     * `set_pos` adds `rot * offset` to the bone's position rather than
     * replacing it. Nothing reads it yet — the roots come off the attach bone —
     * but it is what the record carries. */
    const gT = base && f ? [
        pose[f.bone].t[0] + base[0] * f.offset[0] + base[3] * f.offset[1] + base[6] * f.offset[2],
        pose[f.bone].t[1] + base[1] * f.offset[0] + base[4] * f.offset[1] + base[7] * f.offset[2],
        pose[f.bone].t[2] + base[2] * f.offset[0] + base[5] * f.offset[1] + base[8] * f.offset[2],
    ] : [0, 0, 0];
    void gT;

    osage.chains.forEach((chain, ci) => {
        const b = pose[chain.bone];
        if (!b) return;
        /* The root is the offset in the attach bone's own frame, and the
         * offset's own axes say so: its first component runs along the bone,
         * and every chain's sign is anatomical — negative, toward the hips, for
         * the four tails, positive, toward the head, for Bean's head feathers.
         *
         * `os_set_tsukene` reads as something more involved — `ost_norm` is
         * `frame . (bone . offset)` and `ost_save` is `(bone . frame) . offset`
         * — but neither reproduces. Both put the frame's half turn about Y into
         * the root, which inverts that first component: Fang's tail root moves
         * from his tailbone, 0.24 below the chest, to 0.17 above it, between
         * his shoulder blades. Measured against a forward axis taken from the
         * eyes — they sit at the +X end of every head mesh, so the head's first
         * column is the face — the plain bone frame puts all ten chains where
         * they belong: every tail behind and below, Bean's feathers behind and
         * above, and Honey's two pigtails at one depth and height, split left
         * and right. So whatever those routines are composing, PM slot 1 does
         * not hold the frame by the time they run. */
        const o = chain.offset;
        const root = [
            b.t[0] + b.r[0] * o[0] + b.r[3] * o[1] + b.r[6] * o[2],
            b.t[1] + b.r[1] * o[0] + b.r[4] * o[1] + b.r[7] * o[2],
            b.t[2] + b.r[2] * o[0] + b.r[5] * o[1] + b.r[8] * o[2],
        ];
        let [x, y, z] = root;

        chain.segments.forEach((seg, si) => {
            /* Where this segment goes, and which way it lies.
             *
             * Settled against the board. A capture reads the chain out in the
             * osage frame's own space — `ost_norm` maps the root into it with
             * the frame's inverse, which is what PM slot 1 holds — and putting
             * those numbers back through the frame lands them on the fighter:
             * the captured root comes out at (-0.153, 0.832, -0.113) against
             * the (-0.154, 0.833, -0.113) this file computes from the attach
             * bone, and Fang's three segments at (-0.281,-0.140,-0.305),
             * (-0.653,+0.785,-0.377) and (-0.952,+1.525,-0.435).
             *
             * The rule that reproduces them: every segment steps, the first
             * included, by its own length along its own +0x2C words turned by
             * the frame. Gravity is added but decides nothing where the words
             * are large — Fang's chain flag is 0x80000414, bit 0 clear, so the
             * sway never integrates and gravity never moves his tail. It is
             * what aims Honey's, whose words are 0.0045 and carry no direction.
             *
             * A segment lies along its own step rather than along one shared
             * axis, which is what makes the chain read as a tail instead of a
             * row of loose pieces: the meshes run +Y for their own length, so
             * the frame each is drawn in has its second column on that step. */
            const rb = seg.bias;
            const w = [
                built[0] * rb[0] + built[3] * rb[1] + built[6] * rb[2] + down[0] * pull,
                built[1] * rb[0] + built[4] * rb[1] + built[7] * rb[2] + down[1] * pull,
                built[2] * rb[0] + built[5] * rb[1] + built[8] * rb[2] + down[2] * pull,
            ];
            const wl = Math.hypot(w[0], w[1], w[2]) || 1;
            const dir = [w[0] / wl, w[1] / wl, w[2] / wl];

            /* The mesh spans its own step, so it is drawn where the step
             * begins and reaches the position the step ends at — the meshes run
             * +Y for exactly their own length, so hanging one off the far end
             * instead leaves the chain in loose pieces trailing past itself. */
            const px = x, py = y, pz = z;
            x += dir[0] * seg.length;
            y += dir[1] * seg.length;
            z += dir[2] * seg.length;

            const segFrame = base
                ? alignFrame(base, [base[3], base[4], base[5]], dir)
                : g;
            if (seg.model) {
                out.push({
                    model: seg.model, chain: ci, segment: si,
                    r: (segFrame ?? pose[chain.bone].r).slice(), t: [px, py, pz],
                    /* Where the step ends, which is what the board records. */
                    end: [x, y, z],
                });
            }
        });
    });
    return out;
}
