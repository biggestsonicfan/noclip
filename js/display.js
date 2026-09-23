/*
 * display.js — reconstructs the per-stage draw list the game emits.
 *
 * `camera_init` draws a stage by calling, in order: ground_disp, stage_dsp,
 * cage_sub_disp, cage_disp and pole_disp. Every one of them pushes a transform
 * before it draws — ground_disp's scenery chunks are pre-placed in world space
 * but still go up at 1.6, the same flat scale camera_init gives the floor — so
 * drawing any of these models at the origin puts the cage, its corner posts and
 * the ramp into the middle of the arena.
 *
 * Transforms are kept as an ordered op list rather than a fixed scale/rotate/
 * translate triple, because the order genuinely varies between draw functions
 * and the two orders do not agree. cage_display emits scale then translate
 * (`S·T`, so the offset is scaled); the South Island ramp and the palm trees
 * emit translate then scale (`T·S`, so the offset is not). Each op
 * post-multiplies the running matrix, which is what the coprocessor display
 * list does with 0x3800707 (scale), 0x4800909 (ang_y) and 0x3000606 (translate).
 *
 * Ops:  ['s', [x,y,z]]   scale
 *       ['r', degrees]   Y rotation
 *       ['rx', degrees]  X rotation
 *       ['rz', degrees]  Z rotation
 *       ['t', [x,y,z]]   translate
 *
 * Ops are in the viewer's space, not the board's, and the two differ in exactly
 * one place: the decoder negates Z when it reads geometry, so the viewer's
 * matrix is F·M·F for F = diag(1,1,-1). That leaves scales and X/Y rotations
 * alone and flips the Z of a translation — which is why every ['t'] below
 * carries the negation of the Z the display list emits. See ANGLE_DEG for the
 * rotation half of the same argument.
 *
 * stf-tools/verify-stage.mjs holds this file against a display list captured off
 * the board, part by part, which is how the scales and offsets here are known
 * rather than inferred.
 *
 * A draw that moves carries that instead of a fixed model or a fixed op list:
 * `anim` names a frame table and how the game's frame_counter indexes it, and
 * `ops` may be a function of the frame rather than an array. Nothing here holds
 * a clock — every animated quantity is a pure function of frame_counter, which
 * is what lets the viewer scrub or pause one. See readFrameTables below.
 */

/* stage_x is set to 8.0 wherever the game enters a stage, and never varies. */
const STAGE_X = 8.0;
/* cage_display divides cage_height by this to get its Y scale; cage_height is
 * itself stage_height * 1.6, so the two cancel to 1.6 on every stage. */
const CAGE_HEIGHT_DIV = 3.1;

/* Slots the code special-cases by name in the decompilation. */
export const SOUTH_ISLAND_SLOTS = [0, 13, 14];
const FLYING_CARPET_SLOT = 1;
const AURORA_ICEFIELD_SLOT = 2;
const MUSHROOM_HILL_SLOT = 3;
const CANYON_CRUISE_SLOT = 4;
const GIANT_WING_SLOT = 7;
const FINAL_EGGMAN_SLOT = 10;

/*
 * The frame tables, at their addresses in the program ROM.
 *
 * Each is a run of model ids a draw function indexes with the global
 * frame_counter. They are read rather than transcribed so the quirks come
 * across as written — the palm's last entry repeats 552 where the run wanted
 * 553, and electric_fence_anim is assembled as longs but read as halfwords, so
 * every other entry is the zero half and the fence goes dark on odd frames.
 *
 *   [address, entries, element size]
 */
const FRAME_TABLES = {
    palm: [0x000267b0, 32, 2],          /* south_island_palm_tree */
    palmShadow: [0x000267f0, 32, 2],    /* south_island_palm_tree_shadow */
    carpetFloor: [0x00028060, 64, 2],   /* flying_carpet_floor_anim */
    carpetFlame: [0x00028100, 64, 2],   /* flying_carpet_cage_flames */
    carpetRing: [0x00090e8c, 64, 4],    /* flying_carpet_ring_anim */
    fence: [0x00090dec, 64, 2],         /* electric_fence_anim */
    hangarIris: [0x00090ccc, 128, 2],   /* circular_door_open_close_anim */
    canyonRing: [0x00024aac, 4, 4],     /* canyon_cruise_ring_objects */
    /* ... and the tables the stage objects walk. */
    cards: [0x0007451c, 32, 4],         /* floating_cards_objects */
    conveyor: [0x00076184, 32, 2],      /* dynamite_bg_bombs_conveyor_belt */
    exhaust: [0x000761c4, 4, 4],        /* dynamite_bg_factory_exhaust */
    canyonRail: [0x00076658, 64, 4],    /* canyon_disp's own, unnamed in the listing */
};

/* propeller_dsp has no table: it names one model or the other out of two
 * immediates, on the frame counter's low bit. Written as a table of two so it
 * animates the way every other swap does. */
const PROPELLER_BLADE = [2863, 2846];

/** Read every frame table out of the program ROM. Call once per ROM set. */
export function readFrameTables(rom) {
    const dv = rom.mainCpuView;
    const out = {};
    for (const [name, [addr, count, size]] of Object.entries(FRAME_TABLES)) {
        out[name] = Array.from({ length: count }, (_, i) => (size === 4
            ? dv.getUint32(addr + i * 4, true)
            : dv.getUint16(addr + i * 2, true)));
    }
    out.blade = PROPELLER_BLADE.slice();
    /* Not a run of model ids but the records the ice pillars are built from —
     * read here so a stage is still built out of one pass over the ROM. */
    out.pillars = readIcePillars(rom);
    /* Nor are these: the texture points the two overrides replace outright —
     * see AURORA_SCROLL and BOSS_FLOOR_SCROLL. */
    out.auroraPoints = readTexturePoints(rom, AURORA_POINTS);
    out.bossFloorPoints = readTexturePoints(rom, BOSS_FLOOR_POINTS);
    /* Nor is this: the script Canyon Cruise flies, the heading it flies at and
     * the canyon it flies through — see readCanyonFlight. */
    out.canyon = readCanyonFlight(rom);
    return out;
}

/**
 * The model an animated draw shows at a given frame_counter value.
 *
 * Nearly every one of them is the same shape — `table[((frame >> shift) +
 * phase) & (length - 1)]` — because that is how the draw functions write it: a
 * shift to slow the table down, and a phase that offsets one instance of a
 * repeated object from the next, so the four palms do not sway in lockstep.
 *
 * The stage objects are the exception. They index their tables off clocks of
 * their own — Casino Night's cards off a counter that steps twice a frame,
 * Canyon Cruise's rail off the boat's timeline — so an `index` may stand in for
 * the shift and the phase and work the entry out itself. The wrap to the
 * table's length is applied either way.
 */
export function frameModel(anim, frame) {
    const t = anim.frames;
    const i = anim.index ? anim.index(frame) : (frame >> anim.shift) + anim.phase;
    /* A true modulo, which is the mask for the power-of-two tables the fighting
     * games use and still right for a cycle of any other length. */
    return t[((i % t.length) + t.length) % t.length];
}

/**
 * The frame the arena is pinned to, as an op list — null on a stage that stays
 * put. It is exactly the prologue the world-space draws already carry.
 *
 * The board draws the Flying Carpet from the carpet's own frame: the arena
 * holds still on screen and the desert wheels past it, because the board's
 * camera rides the carpet and never looks anywhere else. A camera that can go
 * anywhere wants the opposite — the desert still and the carpet flying round
 * it — and the two differ by exactly this transform. Handing it out lets the
 * viewer hang the whole scene on its inverse, so nothing in the draw list has
 * to change and every part stays where the board puts it relative to the rest.
 *
 * Three stages move. The Flying Carpet and Canyon Cruise both write a position
 * and two angles — one flies a circle it computes, the other a keyframed path
 * out of ROM, which is why the canyon needs the tables and stands still without
 * them. Giant Wing writes only the roll, and the same argument carries: the
 * board tips the horizon under a camera riding the plane, and inverting that
 * banks the plane under a horizon that stays where it is.
 */
export function stageWorldFrame(stage, frame, frames = null) {
    /* The slots below are Sonic The Fighters'; a placement stage has none. */
    if (stage.placements) return null;
    if (stage.slot === FLYING_CARPET_SLOT) return worldPrologue(carpetAt(frame));
    if (stage.slot === CANYON_CRUISE_SLOT) {
        return frames?.canyon ? worldPrologue(canyonAt(frames.canyon, frame)) : null;
    }
    /* ground_disp emits the negation of what the object wrote, and an ang_z is
     * the one angle that changes sign again on the way into the viewer, so the
     * two negations cancel and the roll goes in as it stands. */
    if (stage.slot === GIANT_WING_SLOT) {
        return [['rz', giantWingRoll(frame) * ANGLE_DEG]];
    }
    return null;
}

/** The op list a draw uses at a given frame; a static draw ignores the frame. */
export function opsAt(entry, frame) {
    return typeof entry.ops === 'function' ? entry.ops(frame) : entry.ops;
}

/*
 * Face the camera — the coprocessor's 0x08001010, which throws away whatever
 * rotation the matrix has accumulated and puts the view's own there instead,
 * leaving the position it has reached and anything pushed after it alone. The
 * game uses it for the things that are flat and have to look round: the Flying
 * Carpet's flames, Casino Night's floating cards, and the card of the Earth
 * over the Death Egg.
 *
 * It is the one op whose value is not known when a stage is built, because it
 * depends on where the camera is standing — see the note on stepBillboards in
 * app.js, which is where a draw carrying one gets its matrix.
 */
export const BILLBOARD = ['b'];

/*
 * Turn to the camera's heading — an ang_y by the angle the game keeps at
 * +0x26 of fa_camera. Unlike the billboard it throws nothing away: it is an
 * ordinary yaw post-multiplied onto what the matrix has reached, whose angle
 * happens to be the camera's, so it cancels the view's own yaw and leaves its
 * pitch. What it draws turns about its own Y to keep one side to the camera.
 *
 * The camera here is the viewer's, so the angle is its heading, taken the way
 * stepBillboards takes the billboard's rotation.
 */
export const CAMERA_YAW = ['cy'];

/* cage_corners — the four posts pole_disp puts around South Island, alternating
 * between two models. */
const SOUTH_ISLAND_CAGE_CORNERS = [519, 554, 519, 554];
/* sub_26604's palm trees: four ground positions scaled by floor_stage_size_0,
 * each walking the palm table at half the frame rate and eight frames on from
 * the one before. The shadow is a single draw sixteen frames out of phase. */
const PALM_POSITIONS = [[6.25, 6.25], [-6.25, 6.25], [-6.25, -6.25], [6.25, -6.25]];
const PALM_SHIFT = 1;
const PALM_TREE_PHASE = 8;
const PALM_SHADOW_PHASE = 16;
const SOUTH_ISLAND_CAGE_SHADOW = 2833;
const SOUTH_ISLAND_WATER = 555;

/*
 * The Final Eggman Boss's hangar — sub_2731C, the routine stage_dsp runs for
 * slot 10 the way it runs sub_26604 for South Island.
 *
 * The record for this stage is a copy of the Death Egg's, right down to the
 * sixteen ground chunks, and none of it is what is on screen: flag bit 13 makes
 * ground_disp skip area_clip, doom_cnt returns before it reaches the backdrop,
 * and the record names no floor at all. Everything the arena stands in comes
 * from this one routine, and it is its parent stage's — Death Egg's Eye reaches
 * the same code by falling out of sub_26830 once its own sequence has run — so
 * what the slot needs is that geometry with the transformations sub_2731C
 * applies to it.
 *
 * Those transformations are one frame shared by every part but the floor: the
 * flat (fs, 1.6, fs) of the rest of the stage, then a translate of 35 in Y.
 * Scale is emitted first, so the offset is scaled with it (S·T) and the hangar
 * hangs 56 units up — which is exactly what the models ask for, since they are
 * all modelled around y = -35 and come back down to the arena's own floor.
 *
 * Three of the parts repeat on quarter turns pushed between the draws. The
 * hangar shell is the one that does not go all the way round: it is drawn at 0,
 * 180 and 270 degrees, and the quarter it leaves out is the wall the doors are
 * in.
 */
const EGGMAN_HANGAR_LIFT = 35.0;    /* 0x420C0000 */
const EGGMAN_FLOOR = 2709;          /* "E-MECH ACTIVATED floor" */
const EGGMAN_CEILING = 2449;        /* "Deathegg II ceiling" */
const EGGMAN_HANGAR = 2426;         /* "Inside of Eggman hangar" */
const EGGMAN_HANGAR_TURNS = [0, 180, 270];
const EGGMAN_TUBES = 2450;          /* "The four tubes" */
const EGGMAN_DOOR_SURROUND = 2429;  /* "Model surrounding the hangar doors" */
const EGGMAN_BRIDGE = 2425;         /* "Bridge from hangar to ring" */
/* pole_disp branches on the slot before it reaches the record, so the 1208 at
 * +0x1C is never drawn here: the Death Egg's own post is. */
const EGGMAN_POLE = 2428;
/*
 * The four hangar doors, of which three are drawn.
 *
 * The odd one out is the shutter Eggman comes through, and which one that is
 * depends on the side the player is on: bossm_shutter_up_cnt raises 2445 for
 * player 1 and 2447 for player 2, and the block that draws the standing doors
 * names the other three to match. The viewer has no player, so it takes the
 * player 1 arrangement, which is the branch `gameprogram` falls through to.
 */
const EGGMAN_DOORS = [2446, 2447, 2448];

/*
 * The sea, which is neither a model swap nor a palette rotation.
 *
 * send_st01_sea_thd calls move_tpd_req once a frame, and transmap_change writes
 * twelve four-word quads into geometry program memory — one per face of model
 * 555 — which ground_disp then hands to set_obj_thd as a texture-header
 * override for the whole model. Each quad is the model's own header verbatim
 * (0x40DA, 0x0A0C, 0x03C0: 128x256 at 384,256, colorbase 15) except for th1,
 * the lumabase byte, which steps 7..70 at half the frame rate.
 *
 * That is the whole animation. Luma RAM holds exactly 71 bands and the sea uses
 * the sixty-four past the first few, which are the same sixteen palette slots
 * rotated one step further each — so walking the band scrolls the water. The
 * band count in ROM is not a coincidence: it is sized for this.
 */
const SEA_BAND = { first: 7, count: 64, shift: 1 };

/** The luma band a texture-header override gives its faces at a frame. */
export function frameBand(band, frame) {
    return band.first + ((frame >> band.shift) & (band.count - 1));
}

/* pole_disp's Flying Carpet branch: four corners from float_9p6, scaled by
 * stage_x / 9.6, each carrying a flame on top 4.1 above the post's own frame.
 *
 * The flame runs its table at half the frame rate, four frames on per corner,
 * and is drawn a quarter over size on every other frame — a one-frame pulse the
 * board gets for the cost of one extra scale, which reads as a flicker. */
const CARPET_CORNER_DIV = 9.6;
const CARPET_CORNERS = [[-9.6, 9.6], [-9.6, -9.6], [9.6, -9.6], [9.6, 9.6]];
const CARPET_FLAME_Y = 4.1;
const CARPET_FLAME_SHIFT = 1;
const CARPET_FLAME_PHASE = 4;
const CARPET_FLAME_FLICKER = [1.25, 1.25, 1.25];

/*
 * The carpet's flight, and the world going past it.
 *
 * flying_carpet_stage_setup hands object_move two objects for this stage, and
 * the first of them runs flying_carpet_init once a frame. It keeps a 16-bit
 * heading at +0x26 of the object, steps it by 32, and puts the carpet on a
 * circle of radius 60:
 *
 *     stage_xpos = 60·cos t    stage_zpos = 60·sin t    stage_ypos = 4 + 4·sin 4t
 *
 * — four rises and falls to the lap, and a lap every 2048 frames. It writes the
 * heading to 0x50A022 and an ang_x to 0x50A020 built out of the frame's own
 * movement: the asin of the vertical part of (position - last position) over
 * that vector's length, so the carpet noses up as it climbs. 0x50A024, the
 * roll, is never written on this stage and keeps the zero change_scene left in
 * it, which is why nothing below emits one.
 *
 * Nothing about the arena moves. camera_init's floor draw, ground_disp's
 * scenery chunks and doom_cnt's backdrop ring each push the same prologue
 * first — ang_z, ang_x and ang_y by the three negated angles, then a translate
 * by the negated position — and that prologue is the world seen from the
 * carpet. The carpet stays where it is on screen and the desert flies past
 * underneath it, which is both what the stage looks like and the reason
 * stage_dsp, cage_display and pole_disp do not push it: they draw the arena,
 * and the arena is the thing the frame is pinned to.
 *
 * On every other stage all four are still the zeros change_scene wrote, so the
 * prologue is the identity and those draws come out exactly where they did.
 */
const CARPET_RADIUS = 60.0;         /* 0x42700000 */
const CARPET_RISE = 4.0;            /* 0x40800000 — both the height and the swing */
const CARPET_RISES_PER_LAP = 4;     /* the heading is shifted left two for the bob */
const CARPET_YAW_STEP = 32;         /* 16-bit angle units added per frame */

/*
 * Board angles are 16-bit — 0x10000 is a full turn — and they cross into the
 * viewer with their sense intact, which is worth saying because two reversals
 * are involved and they cancel.
 *
 * The board's ang_x, ang_y and ang_z each post-multiply by the transpose of the
 * matrix the same angle names in a right-handed system: ang_y builds columns
 * (c,0,s) and (-s,0,c) where three's makeRotationY builds (c,0,-s) and (s,0,c).
 * That is a left-handed frame, which is what a Z running into the screen means.
 * The decoder then negates Z on read to bring the geometry out the other way,
 * and conjugating a rotation by that flip transposes it a second time. So an
 * ang_x or an ang_y is handed to three unchanged; only a translation loses its
 * Z, and an ang_z — the one axis the flip leaves alone — has to be negated.
 * Nothing the arena draws emits one; the stage objects do, and every ['rz']
 * below carries that sign.
 */
const ANGLE_DEG = 360 / 65536;
const TO_ANGLE = 65536 / (2 * Math.PI);

/** stage_xpos/ypos/zpos at a frame, in the board's own coordinates. */
function carpetPos(frame) {
    const t = frame * CARPET_YAW_STEP * ANGLE_DEG * (Math.PI / 180);
    return [
        Math.cos(t) * CARPET_RADIUS,
        CARPET_RISE + Math.sin(t * CARPET_RISES_PER_LAP) * CARPET_RISE,
        Math.sin(t) * CARPET_RADIUS,
    ];
}

/** Position, heading and nose-up angle at a frame — all as the board keeps them. */
export function carpetAt(frame) {
    const pos = carpetPos(frame);
    /* The object's fields are zero when it is allocated, so the first frame
     * measures its movement from the origin rather than from the circle. */
    const prev = frame > 0 ? carpetPos(frame - 1) : [0, 0, 0];
    const d = [pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    return {
        pos,
        /* The heading is stored after it is stepped, so what the display list
         * reads leads the position it was drawn from by one frame. */
        yaw: (frame + 1) * CARPET_YAW_STEP,
        pitch: len ? Math.asin(d[1] / len) * TO_ANGLE : 0,
    };
}

/**
 * The prologue a world-space draw pushes: the arena's frame, inverted. Both
 * flights build it — the angles the object wrote are emitted negated, and the
 * position with them, which is the world seen from the thing that is moving.
 */
function worldPrologue(at) {
    return [
        ['rx', -at.pitch * ANGLE_DEG],
        ['r', -at.yaw * ANGLE_DEG],
        ['t', [-at.pos[0], -at.pos[1], at.pos[2]]],
    ];
}

/*
 * The sphynx head — the stage's second object, and the only draw in the game
 * that aims at something.
 *
 * draw_sphynx_head stands the head at one fixed point in the world and yaws and
 * pitches it to face the midpoint of the two fighters. It needs the head's own
 * world position to work those angles out, and gets it by handing the
 * coprocessor a matrix built for the purpose — identity, translate by the
 * negated stage position, scale 1.6 — and asking it to transform the point
 * (0x14802929, model→world). The look-at is measured without the orientation
 * the draw applies, which is reproduced as written.
 *
 * There are no fighters here, so the target is the middle of the carpet — where
 * they stand, and where their midpoint sits whenever they are not moving. That
 * leaves the head turning to watch the carpet go round, which is what it does.
 *
 * The same function draws two more things the stage record does not carry: four
 * corner pieces on the carpet itself at stage_x / 6, a quarter turn apart, and
 * one flat plate under it at floor_stage_size_0. Neither moves with the world —
 * they are drawn after the prologue is popped.
 *
 * The probe and the draw agree. The draw does not build its own scale: it
 * loads inner slot 8 over the prologue it has just emitted, and slot 8 is what
 * camera_init stored there (0x1FC7C) — the same prologue, scaled 1.6:
 *
 *   0x72214  scale 1.6, 1.6, 1.6          the probe matrix
 *   0x72244  cop 0x29, (-7.85, 7, 52)     transform that point to world
 *   0x7225C  read it back into g0,g1,g2   the head's world position
 *   0x72274  ... used for the two angles
 *   0x7235C  cop 0x44, 8                  the arena frame, at 1.6
 *   0x7237C  translate r4, r5, r6         the same constants, in that frame
 *
 * So the head stands at 1.6x the constants, where the probe measured it, and is
 * drawn at 1.6x its model's size, like the body it sits on. Leaving out the load
 * leaves it a head at 1/1.6 the size, half its width off the neck.
 */
const SPHYNX_HEAD = 322;
const SPHYNX_AT = [-7.85, 7.0, 52.0];   /* 0xC0FB3333, 0x40E00000, 0x42500000 */
/* The scale of the probe, and of inner slot 8 the draw loads. */
const SPHYNX_SCALE = 1.6;
const SPHYNX_CORNER = 1287;
const SPHYNX_PLATE = 3332;

function sphynxOps(at) {
    /* The probe: 1.6 × the fixed point, less the carpet's position. */
    const h = SPHYNX_AT.map((v, i) => v * SPHYNX_SCALE - at.pos[i]);
    /* COP 0x27 is atan2(y, x) with x pushed first. The yaw is handed
     * (head.z - mid.z) then (mid.x - head.x), the pitch the horizontal distance
     * between them and then (head.y - mid.y), and the midpoint is the origin. */
    const yaw = Math.atan2(-h[0], h[2]) * TO_ANGLE;
    const pitch = Math.atan2(h[1], Math.hypot(h[0], h[2])) * TO_ANGLE;
    return [
        ...worldPrologue(at),
        /* Inner slot 8: the prologue again, at 1.6. */
        ['s', [SPHYNX_SCALE, SPHYNX_SCALE, SPHYNX_SCALE]],
        ['t', [SPHYNX_AT[0], SPHYNX_AT[1], -SPHYNX_AT[2]]],
        ['r', yaw * ANGLE_DEG],
        ['rx', pitch * ANGLE_DEG],
    ];
}

/*
 * The Y angle camera_init builds the stage light out of, at a frame — or null
 * on a stage that leaves it where change_scene put it.
 *
 * flying_carpet_init rewrites VECTER_Y every frame as a fixed base less the
 * heading it has just advanced. The light is built in the stage's own frame and
 * the stage's frame is the one turning, so subtracting the heading is what
 * holds the sun still in the world while the carpet flies out from under it.
 * VECTER_X is left as the record wrote it: the nose-up angle is not
 * compensated, only the heading.
 *
 * canyon_init does the same thing one frame late. It reads 0x50A022 at the top
 * of the continuation, before object_move has moved the boat and before it has
 * written this frame's heading, so the sun is held still against where the boat
 * was pointing last frame; and it adds its base to the stored heading rather
 * than subtracting, because what the canyon stores there is already negated.
 */
const CARPET_LIGHT_BASE = 0x271c;
const CANYON_LIGHT_BASE = 0x20 - 0x12000;

export function stageLightYaw(stage, frame, frames = null) {
    if (stage.placements) return null;
    if (stage.slot === FLYING_CARPET_SLOT) return CARPET_LIGHT_BASE - carpetAt(frame).yaw;
    if (stage.slot === CANYON_CRUISE_SLOT && frames?.canyon) {
        return CANYON_LIGHT_BASE + canyonAt(frames.canyon, frame - 1).yaw;
    }
    return null;
}

/* doom_cnt lays the backdrop out as a ring: it steps a Y rotation by 1<<0xC of
 * a 16-bit angle — 22.5 degrees — sixteen times, drawing sky_texture[i & 3] at
 * each step. Drawing the four models once at the origin, as this used to, loses
 * fifteen sixteenths of the horizon. */
const SKY_SEGMENTS = 16;
const SKY_STEP_DEG = 360 / SKY_SEGMENTS;
/* Before the ring is laid out, doom_cnt yaws the whole backdrop by an angle it
 * keeps at 0x500464 and, on the stages whose flag bit 0x1B is set, adds two to
 * every frame. Two of a 16-bit angle is a hair under 0.011 degrees, so the
 * horizon takes about nine minutes to come round — slow enough to read as
 * drift rather than rotation, which is presumably the point. */
const SKY_DRIFT_BIT = 0x1b;
const SKY_DRIFT_STEP = (2 * 360) / 65536;

/* cage_clip_m picks a panel-spacing table from the stage flags; only its length
 * matters here, since each panel model carries its own X position. */
function cagePanelCount(flags) {
    let n = 8;
    if (flags & (1 << 0x13)) n = 4;
    if (flags & (1 << 0x15)) n = 2;
    if (flags & (1 << 0x1d)) n = 3;
    if (flags & (1 << 0x16)) n = 1;
    return n;
}

/* ---- the stage's own objects ----------------------------------------------
 *
 * `object_control` runs a second draw list after the arena's, out of the
 * routines the stage record names — see readStageObjects in stages.js. Six
 * stages put something in it, and between them it is most of what moves in the
 * game away from South Island and the Flying Carpet: Casino Night's blimp,
 * roulette and slot machine, Mushroom Hill's canopy and rings, Aurora
 * Icefield's ice pillars and its mirrored sky, Dynamite Plant's gears and
 * conveyor, Giant Wing's clouds and propellers — and the roll that banks the
 * whole plane.
 *
 * Each routine below is a port of one `disp`, and of the per-frame continuation
 * its `init` installs where the two share state. They are registered under the
 * ROM address the setup table names them at rather than under a stage number,
 * so a stage runs the routines its own record asks for.
 *
 * Three clocks turn up, and telling them apart is most of what these ports are:
 *
 * - `object_cont` steps a counter at +6 of every object once a frame, *after*
 *   calling that object's routine. An `init` that falls straight through into
 *   its own continuation therefore gets one step of it on the frame the stage
 *   loads, which is why the angles below stand at (frame + 1) and not at frame.
 * - pinball_init's continuation steps that same counter a second time, so
 *   Casino Night's disp reads 2(frame + 1). Taking it for a frame count leaves
 *   the blimp orbiting at half speed.
 * - dynamite_disp and boss_cont keep counters of their own, and the tables the
 *   conveyor, the floating cards and the ice diamonds walk are indexed by the
 *   global frame_counter instead.
 *
 * What is not modelled is the state a viewer with no fight in it does not have:
 * Mushroom Hill's spore puffs, queued out of where the two fighters are
 * standing. One per-frame texture override is also still missing: the canyon's
 * eyes walk luma bands the way the sea does, and are drawn with the model's own
 * instead. And one thing is modelled deliberately differently — the Death Egg's
 * Earth, which the board pins to the view and this places in the world, since a
 * camera that can turn away from it has to find it somewhere; see BOSS_EARTH.
 */

const OBJECT_LAYER = 'objects';

/* ---- pinball_disp: Casino Night ---- */
const CASINO_BLIMP = 2670;
const CASINO_ROULETTE = 2671;
const CASINO_REEL = 177;            /* the slot machine's three wheels */
const CASINO_LEVER = 328;
const CASINO_FLOOR = 1712;
/* pinball_init lays the three reels out: an x each, and a starting angle each.
 * The x of the first is `lda system_address_table` — that table is at zero, so
 * the constant is a float 0.0 the disassembler has resolved to a label. */
const CASINO_REELS = [[0.0, 0x0000], [9.6, 0x6000], [-9.6, 0xb000]];
const CASINO_REEL_AT = [21.12, 97.76];   /* the y and z all three share */
const CASINO_REEL_STEP = 0x400;          /* 64 frames to the turn */
const CASINO_BLIMP_STEP = 0x10;
const CASINO_BLIMP_AT = [0, 20, -40];
const CASINO_ROULETTE_STEP = 0x100;
const CASINO_ROULETTE_AT = [103.6, 25.8, 22.4];
const CASINO_ROULETTE_TILT = 0xd000;

function pinballDisp({ push, pushAnim, fs }) {
    /* Its own continuation steps the counter, and so does object_cont. */
    const clock = (f) => 2 * (f + 1);
    /* A Y rotation and then an offset is an orbit: the blimp rides a circle of
     * radius 40 at height 20, a lap every 2048 frames. */
    push(CASINO_BLIMP, (f) => [
        ['r', clock(f) * CASINO_BLIMP_STEP * ANGLE_DEG],
        ['t', [CASINO_BLIMP_AT[0], CASINO_BLIMP_AT[1], -CASINO_BLIMP_AT[2]]],
    ]);
    /* The wheel is stood up by a Z roll and then spun about its own Y. */
    push(CASINO_ROULETTE, (f) => [
        ['t', [CASINO_ROULETTE_AT[0], CASINO_ROULETTE_AT[1], -CASINO_ROULETTE_AT[2]]],
        ['rz', -CASINO_ROULETTE_TILT * ANGLE_DEG],
        ['r', clock(f) * CASINO_ROULETTE_STEP * ANGLE_DEG],
        ['s', [1.6, 1.6, 1.6]],
    ]);
    /* (counter >> 1) & 31 of a counter that steps twice is one card a frame. */
    pushAnim('cards', { index: (f) => f + 1 }, [['s', [1.6, 1.6, 1.6]]]);
    /* The reels are on the continuation's own clock, which steps once a frame,
     * and turn about X — the axis a slot wheel rolls on. */
    for (const [x, base] of CASINO_REELS) {
        push(CASINO_REEL, (f) => [
            ['t', [x, CASINO_REEL_AT[0], -CASINO_REEL_AT[1]]],
            ['rx', (base + (f + 1) * CASINO_REEL_STEP) * ANGLE_DEG],
            ['s', [1.6, 1.6, 1.6]],
        ]);
    }
    push(CASINO_LEVER, [['s', [1.6, 1.6, 1.6]], ['t', [20, 7, -48]]]);
    push(CASINO_FLOOR, [['s', [fs, fs, fs]]]);
}

/* ---- mushroom_disp: Mushroom Hill ----
 * The canopy and the cap are drawn at the matrix object_control leaves on the
 * stack, which is the identity. The four rings are the cage's own: the second
 * pass over them, the one that leaves out whichever the fighters have broken,
 * draws nothing this pass has not. */
const MUSHROOM_CANOPY = 3350;
const MUSHROOM_CAP = 324;
const MUSHROOM_RINGS = [2400, 2402, 2401, 2399];

function mushroomDisp({ push, sx }) {
    push(MUSHROOM_CANOPY, []);
    push(MUSHROOM_CAP, []);
    for (const m of MUSHROOM_RINGS) push(m, [['s', [sx, 1.6, sx]]]);
}

/* ---- aurora_disp: Aurora Icefield ----
 * Half of this stage is drawn twice: once standing and once through a negative
 * Y scale, which is the ice reflecting it. */
const AURORA_BOREALIS = 1604;
const AURORA_SKY = 3200;
const AURORA_FLOOR = 559;
const AURORA_WALRUSES = 1601;
const AURORA_WALRUSES_REFLECTED = 2319;
const MIRROR_Y = ['s', [1, -1, 1]];

/*
 * The aurora, which does not move: its texture runs along it.
 *
 * This is the sea's trick one field over. `set_obj_thd` replaces a model's
 * texture *headers*, and walking the sea's lumabase moves its faces from one
 * luma band to the next; `set_obj_tpd` replaces its texture *points*, and
 * walking those moves the texture across the faces.
 *
 * aurora_init installs a continuation that calls move_tpd_req once a frame with
 * the block at AURORA_POINTS and one 16-bit offset, `((0 - frame_counter) << 2)
 * & 0x7FF`. The handler that request selects is tpd_move, which copies the
 * block into geometry program memory adding that offset to the *first* short of
 * every pair, and aurora_disp hands what comes back to set_obj_tpd for both
 * draws — the standing curtain and its reflection. A pair is (v, u), the order
 * the UV stream itself is in, so what slides is v: four raw units a frame,
 * which is half a texel, wrapping at 0x800. That wrap is one whole 256-texel
 * tile, so it is seamless, and the cycle is 512 frames. On this model v runs
 * along the curtain rather than up it, which is why what it looks like is the
 * light travelling sideways.
 *
 * The block is nearly a copy of model 1604's own thirty-six points, and it is
 * worth saying where it is not: on two of the nine panels the model's v runs
 * the other way, and the block turns them round. Left alone those two would
 * scroll against the seven — so the override is loaded rather than a slide
 * applied to what the model carries, and the two panels stand the right way up
 * even on frame 0.
 */
const AURORA_POINTS = 0x000758fc;   /* `lda aurora_borealis_data, g0` */
const AURORA_SCROLL = { axis: 'v', step: -4, shift: 0, mask: 0x7ff };
/* Texture points are in eighths of a texel; the decoder divides by the same. */
const UV_UNIT = 8;

/** A move_tpd_req block's texture points: a count, a word length, then (v, u). */
export function readTexturePoints(rom, addr) {
    const dv = rom.mainCpuView;
    const count = dv.getUint16(addr, true);
    const out = new Uint16Array(count * 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(addr + 4 + i * 2, true);
    return out;
}

/*
 * The texel offset a texture-point override slides by at a frame.
 *
 * A request carries two 16-bit offsets, and tpd_move adds the first to the
 * first short of every (v, u) pair and the second to the second — so which
 * coordinate a scroll walks is which of the two its routine fills in. The
 * aurora puts its offset in g1 and walks v; the Death Egg's floor puts its own
 * in g2 and walks u. `shift` is the divider the routine applies to
 * frame_counter before it steps: the aurora steps every frame, the floor every
 * eighth.
 */
export function frameScroll(scroll, frame) {
    const step = (frame >> (scroll.shift ?? 0)) * scroll.step;
    return (step & scroll.mask) / UV_UNIT;
}

/** Frames a scroll takes to come back to where it started. */
export function scrollPeriod(scroll) {
    return ((scroll.mask + 1) / Math.abs(scroll.step)) * (1 << (scroll.shift ?? 0));
}
/* aurora_ice_pillar_init's eight records, at their address in the program ROM.
 * There are nine in the run: the eighth is written out in full and never
 * called, so the order is read rather than assumed. */
const ICE_PILLARS = 0x000754f8;
const ICE_PILLAR_STRIDE = 0x20;
const ICE_PILLAR_ORDER = [0, 1, 2, 3, 4, 5, 6, 8];
const ICE_DIAMOND_SPIN = 0x100;     /* per frame_counter frame */

/** The ice pillar records, in the order aurora_ice_pillar_init draws them. */
export function readIcePillars(rom) {
    const dv = rom.mainCpuView;
    return ICE_PILLAR_ORDER.map((i) => {
        const b = ICE_PILLARS + i * ICE_PILLAR_STRIDE;
        return {
            /* The record carries an x and a z; the y pushed between them is
             * another `lda system_address_table`, so a pillar stands on the
             * floor. */
            x: dv.getFloat32(b, true),
            z: dv.getFloat32(b + 4, true),
            scale: [dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true),
                dv.getFloat32(b + 16, true)],
            height: dv.getFloat32(b + 20, true),
            pillar: dv.getUint16(b + 24, true),
            dark: dv.getUint16(b + 26, true),
            light: dv.getUint16(b + 28, true),
            angle: dv.getUint16(b + 30, true),
        };
    });
}

function auroraDisp({ push, pushTpd, fs, frames }) {
    const scroll = { ...AURORA_SCROLL, points: frames?.auroraPoints ?? null };
    pushTpd(AURORA_BOREALIS, scroll, []);
    push(AURORA_SKY, []);
    push(AURORA_SKY, [MIRROR_Y]);
    /* The walrus statues, which stand outside the ring on the +Z side, and
     * their own reflection — a separate, lighter model, 243 vertices against
     * the standing pair's 447, over the same bounds. Both are drawn at the
     * matrix object_control leaves on the stack, the reflection through the
     * same negative Y as the sky's.
     *
     * The routine draws them only when bit 0 of 0x500288 is set, and that byte
     * is not game state: the frame's own display function fills it in at
     * 0x24E00, handing 0x24ED4 four (x, z) offsets at (0, ±6) and (±6, 0),
     * which transforms each into the camera's frame and sets that offset's bit
     * on a sign test. It is the mask cage_clip_m then draws its four barrier
     * panels from — a bit set means that side is drawn — so the walruses come
     * out exactly when the barrier they stand behind does. That is a cull
     * against the board's own camera, and this viewer's can be anywhere, so it
     * is left out here the same way the ice pillars' is below.
     */
    push(AURORA_WALRUSES, []);
    push(AURORA_WALRUSES_REFLECTED, [MIRROR_Y]);
    push(AURORA_FLOOR, [['s', [fs, 1.6, fs]]]);
    pushTpd(AURORA_BOREALIS, scroll, [MIRROR_Y]);
    /* Each pillar carries a diamond: a dark one held still, and a light one
     * turning inside it. The routine culls a pillar whose projected centre
     * leaves the screen; a camera that can go anywhere wants all eight. */
    for (const p of frames?.pillars ?? []) {
        const stand = [['t', [p.x, 0, -p.z]], ['r', p.angle * ANGLE_DEG]];
        push(p.pillar, [...stand, ['s', p.scale]]);
        const top = [...stand, ['t', [0, p.height, 0]]];
        push(p.dark, [...top, ['s', [2, 2, 2]]]);
        push(p.light, (f) => [...top, ['r', f * ICE_DIAMOND_SPIN * ANGLE_DEG],
            ['s', [1.2, 1.2, 1.2]]]);
    }
}

/* ---- dynamite_disp: Dynamite Plant ---- */
const DYNAMITE_EXHAUST_AT = [2.4, 22.56, 45.0];
const DYNAMITE_EXHAUST_GAP = 4.8;
const DYNAMITE_BOMB = 1862;         /* 0x746 — the pair that swing */
const DYNAMITE_GEAR = 2265;         /* 0x8D9 */
const DYNAMITE_GEAR_YAW = 0xe000;
const DYNAMITE_GEAR_STEP = 250;     /* 0xFF06 one way, 0xFA the other */
/* dynamite_init starts the first gear's angle (+0x40) at 0 and the second's
 * (+0x42) at 1 << 11, so their teeth are an eighth of a turn apart. */
const DYNAMITE_GEARS = [
    { at: [-10.64, 2.7, 24.11], step: -DYNAMITE_GEAR_STEP, start: 0, tail: [] },
    { at: [-13.56, 6.7, 22.45], step: DYNAMITE_GEAR_STEP, start: 0x800, tail: [['s', [1.2, 1.2, 1.2]]] },
];
/* The swinging pair: one rides the value up and the other rides 5.4 minus it
 * down, and each turns 16384 angle units per unit of height. */
const DYNAMITE_SWING = { speed: 0.05, limit: 5.4, turn: 16384 };
const DYNAMITE_SWING_AT = [[23.1, -1.7], [26.3, 1.6]];

/*
 * The swing, one whole cycle of it.
 *
 * dynamite_disp adds a step to a float, and where the sum runs past either end
 * it is pinned *to* that end rather than reflected through it. That pin is what
 * makes the cycle come out even — 0.05 is not 0.05 in a 32-bit float, so the
 * hundred and eighth step overshoots 5.4 and is set back to it exactly, and the
 * hundred and eighth step down undershoots zero and is set to zero — so it is
 * run once at the board's own precision rather than reasoned about.
 */
let swingCache = null;
function swingCycle() {
    if (swingCache) return swingCache;
    const { speed, limit } = DYNAMITE_SWING;
    const out = [];
    let v = 0, s = Math.fround(speed);
    for (let n = 0; n < 4096; n++) {
        v = Math.fround(v + s);
        if (v < 0) { v = 0; s = Math.fround(speed); }
        else if (v > limit) { v = limit; s = Math.fround(-speed); }
        /* Closed once the step that opened it comes round again — which is the
         * step after the last one belonging to the cycle. */
        if (n && v === out[0] && s > 0) break;
        out.push(v);
    }
    swingCache = out;
    return out;
}

function dynamiteDisp({ push, pushAnim }) {
    /* dynamite_disp steps a counter of its own before reading it. */
    const clock = (f) => f + 1;
    const at = [DYNAMITE_EXHAUST_AT[0], DYNAMITE_EXHAUST_AT[1], -DYNAMITE_EXHAUST_AT[2]];
    /* Two chimneys out of one four-frame table, the second mirrored in X and
     * half the table on from the first. */
    pushAnim('exhaust', { index: (f) => clock(f) >> 2 }, [['t', at]]);
    pushAnim('exhaust', { index: (f) => (clock(f) >> 2) + 2 },
        [['t', at], ['s', [-1, 1, 1]], ['t', [DYNAMITE_EXHAUST_GAP, 0, 0]]]);

    const swing = (f) => {
        const c = swingCycle();
        return c[clock(f) % c.length];
    };
    DYNAMITE_SWING_AT.forEach(([x, z], i) => {
        push(DYNAMITE_BOMB, (f) => {
            const v = i === 0 ? swing(f) : DYNAMITE_SWING.limit - swing(f);
            return [
                ['s', [1.6, 1.6, 1.6]],
                ['t', [x, 0.5 + v, z]],
                ['r', Math.round(v * DYNAMITE_SWING.turn) * ANGLE_DEG],
            ];
        });
    });

    /* Two gears on the same face, turning opposite ways. */
    for (const g of DYNAMITE_GEARS) {
        push(DYNAMITE_GEAR, (f) => [
            ['s', [1.6, 1.6, 1.6]],
            ['t', g.at],
            ['r', DYNAMITE_GEAR_YAW * ANGLE_DEG],
            ['rz', -(g.start + g.step * clock(f)) * ANGLE_DEG],
            ...g.tail,
        ]);
    }
    pushAnim('conveyor', { shift: 1, phase: 0 }, [['s', [1.6, 1.6, 1.6]]]);
}

/* ---- giant_wing_disp and propeller_dsp: Giant Wing ----
 *
 * The plane banks, and it banks the world rather than itself: its continuation
 * writes an ang_z to 0x50A024, which is the roll every world-space draw's
 * prologue picks up. On the board that tips the horizon while the wing the
 * fight is on holds still under the camera; here the horizon is the thing worth
 * standing on, so the scene hangs on the roll's inverse and the plane banks
 * instead. The same stage, seen from the air rather than from the deck.
 */
const GIANT_WING_FLOOR = 3706;
const GIANT_WING_BODY = 2947;
const GIANT_WING_HAZE = [3321, 3322];
const GIANT_WING_ENGINE = 259;
const GIANT_WING_SPINNER = [3888, 3889];
/* The blade is swapped for an invisible square on every other frame — one
 * frame on and one frame gone, which is the blur. */
const GIANT_WING_BLADE = [2863, 2846];
const GIANT_WING_BLADE_AT = [35.34, 8.2, 10.55];
const GIANT_WING_BLADE_SPIN = 0x1b << 7;
/* Two sine terms: a rate in 16-bit angle units per frame, an amplitude in the
 * same units, and a phase. */
const GIANT_WING_ROLL = [[128, 411.0, 0], [192, 133.0, 0x1234]];
/* Six cloud draws, each a Z that walks toward the plane and starts over at the
 * far limit. The continuation steps two more of these that nothing draws. */
const GIANT_WING_CLOUDS = [
    { model: 3086, x: 0, start: 6000, step: 12.5, limit: 6000 },
    { model: 3087, x: 0, start: 3000, step: 12.5, limit: 6000 },
    { model: 3086, x: 0, start: 0, step: 12.5, limit: 6000 },
    { model: 3087, x: 0, start: -3000, step: 12.5, limit: 6000 },
    { model: 3673, x: 1000, start: 1500, step: 7.5, limit: 3000 },
    { model: 3673, x: -1000, start: -1500, step: 7.5, limit: 3000 },
];

/** The plane's roll at a frame, in the board's 16-bit angle units. */
export function giantWingRoll(frame) {
    /* giant_wing_init returns rather than falling through into its own
     * continuation, so the frame the stage loads on is drawn with the zero
     * change_scene left at 0x50A024 and the roll starts a frame later. */
    if (frame <= 0) return 0;
    const turn = (2 * Math.PI) / 65536;
    let a = 0;
    for (const [rate, amp, phase] of GIANT_WING_ROLL) {
        a += Math.sin((frame * rate + phase) * turn) * amp;
    }
    return Math.round(a);
}

/** A cloud's Z after n steps: it walks toward -limit and restarts at +limit. */
function cloudAt(c, n) {
    const v = c.start - c.step * n;
    if (v > -c.limit) return v;
    /* The step it first restarts on, and how many a pass takes from there. */
    const first = Math.ceil((c.start + c.limit) / c.step);
    const span = Math.ceil((2 * c.limit) / c.step);
    return c.limit - c.step * ((n - first) % span);
}

function giantWingDisp({ push, pushWorld, fs }) {
    push(GIANT_WING_FLOOR, [['s', [fs, fs, fs]]]);
    /* Everything after the floor is drawn from inner slot 8 (0x76E3C), which
     * camera_init stores as the world's prologue at 1.6 — so these take the
     * roll the floor does not, and the clouds' offsets are scaled too. */
    const arena = ['s', [1.6, 1.6, 1.6]];
    pushWorld(GIANT_WING_BODY, OBJECT_LAYER, [arena]);
    /* Both of these are offset by a field the continuation never touches, so
     * they sit where object_init left them. */
    for (const m of GIANT_WING_HAZE) pushWorld(m, OBJECT_LAYER, [arena]);
    for (const c of GIANT_WING_CLOUDS) {
        pushWorld(c.model, OBJECT_LAYER, (f) => [arena, ['t', [c.x, 0, -cloudAt(c, f)]]]);
    }
}

function propellerDsp({ push, pushAnim, fs }) {
    const scale = ['s', [fs, fs, fs]];
    push(GIANT_WING_ENGINE, [scale]);
    push(GIANT_WING_ENGINE, [scale, ['s', [-1, 1, 1]]]);
    for (const m of GIANT_WING_SPINNER) push(m, [scale]);
    for (const side of [1, -1]) {
        pushAnim('blade', { shift: 0, phase: 0 }, (f) => [
            scale,
            ['t', [side * GIANT_WING_BLADE_AT[0], GIANT_WING_BLADE_AT[1],
                -GIANT_WING_BLADE_AT[2]]],
            ['rz', -(f * GIANT_WING_BLADE_SPIN) * ANGLE_DEG],
        ]);
    }
}

/* ---- canyon_disp / canyon_env_disp: Canyon Cruise ----
 * The boat's own timeline, which object_cont steps and the continuation snaps
 * back at the end of the run: the first pass counts 1..0x784 and every pass
 * after it 0x7E..0x784. The table index is read off it two ways — the low six
 * bits, except on the counts whose bit 7 is set, where it is the low five
 * doubled, so half the table is skipped a hundred and twenty-eight frames at a
 * time. */
const CANYON_LOOP = [0x7e, 0x784];

function canyonClock(frame) {
    const c = frame + 1;
    if (c <= CANYON_LOOP[1]) return c;
    const span = CANYON_LOOP[1] - CANYON_LOOP[0] + 1;
    return CANYON_LOOP[0] + ((c - CANYON_LOOP[1] - 1) % span);
}

/*
 * object_cont steps that counter after it has called the object's routine and
 * before object_control calls the object's draw, so the two stand one frame
 * apart: canyon_disp reads the count above, and the flight below is flown at
 * the one before it. The first frame is the object's init, on which nothing has
 * moved the boat yet — change_scene left the position and all three angles at
 * zero and the continuation has not run — which is what a count of zero means.
 */
function canyonMoveClock(frame) {
    return frame < 1 ? 0 : canyonClock(frame - 1);
}

/*
 * The flight, and the canyon it goes through: four runs of ROM, one of which
 * the stage record names and three of which are the routines' own.
 *
 * canyon_setup's third field is the script object_move flies the boat along —
 * twenty keys of (type, frame, position, angles), 28 bytes each. canyon_init
 * reads a heading off a table indexed by the timeline. canyon_env_disp holds
 * the scenery as runs of (model, position) ended by -1, and word_9D394 says
 * which count each run gives way to the next on.
 *
 * The heading is the one not in the program ROM: it is in the data ROM, which
 * the i960 sees from 0x02000000, so its 0x020D5BC4 is 0x0D5BC4 here.
 */
const CANYON_SCRIPT = 0x0009d164;           /* canyon_setup's third field */
const CANYON_SCRIPT_KEYS = 20;
const CANYON_KEY_SIZE = 28;
const CANYON_TRIGGERS = 0x0009d394;         /* word_9D394 */
const CANYON_TRIGGER_COUNT = 18;
const CANYON_ENV_OBJECTS = 0x0009d41c;      /* canyon_env_objects */
const CANYON_HEADING = 0x000d5bc4;          /* in the data ROM, not the program */
const CANYON_END = 4;                       /* the last key: object_move stops there */
const CANYON_HOLD = 3;                      /* a key the curve arrives at flat */

/*
 * The river: three plates at the origin and one more from each of the stretches
 * of canyon either side of it. canyon_env_disp draws all five through a texture
 * header canyon_env_init rebuilds every frame — move_tpd_req off frame_counter,
 * band 7 plus six bits of half the frame rate, which is South Island's sea to
 * the letter. Same call, same walk, and it is why they read as flowing water.
 */
const CANYON_WATER = [
    { model: 2559, at: [0, 0, 0] },
    { model: 2560, at: [0, 0, 0] },
    { model: 2561, at: [0, 0, 0] },
    { model: 2561, at: [-330.0, 21.2, -230.0] },
    { model: 2559, at: [330.0, -21.2, 230.0] },
];

/** The script, the heading table and the scenery, read out of the ROM. */
export function readCanyonFlight(rom) {
    const dv = rom.mainCpuView;

    const keys = [];
    for (let i = 0; i < CANYON_SCRIPT_KEYS; i++) {
        const at = CANYON_SCRIPT + i * CANYON_KEY_SIZE;
        keys.push({
            type: dv.getInt16(at, true),
            frame: dv.getInt16(at + 2, true),
            pos: [0, 1, 2].map((k) => dv.getFloat32(at + 4 + k * 4, true)),
            /* The key's second triple is its angles, and every key in this
             * script carries zero — object_move interpolates them into the
             * object's own ang fields, which nothing on this stage reads. */
        });
    }

    const triggers = Array.from({ length: CANYON_TRIGGER_COUNT },
        (_, i) => dv.getInt16(CANYON_TRIGGERS + i * 2, true));

    const groups = [];
    let at = CANYON_ENV_OBJECTS;
    while (groups.length <= CANYON_TRIGGER_COUNT) {
        const group = [];
        for (; dv.getInt32(at, true) !== -1; at += 16) {
            group.push({
                model: dv.getInt32(at, true),
                at: [1, 2, 3].map((k) => dv.getFloat32(at + k * 4, true)),
            });
        }
        at += 4;                            /* past the -1 that ended the run */
        groups.push(group);
    }

    /* Each group is the set of chunks on screen at that point of the run, and
     * the boat's own progress is what retires one for the next: as much of the
     * canyon as the board can afford to draw from where its camera is. A camera
     * that can be anywhere wants the canyon whole, so what goes in the display
     * list is the union of the groups, in the order they first name each piece.
     * That is a strict superset of any one frame's draws, and it comes to
     * nineteen: fourteen chunks about the origin and five more from the
     * stretches of canyon either side of it. */
    const seen = new Set();
    const scenery = [];
    for (const group of groups) {
        for (const o of group) {
            const key = `${o.model}@${o.at.join(',')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            scenery.push(o);
        }
    }

    const heading = new Uint16Array(CANYON_LOOP[1] + 1);
    for (let i = 0; i < heading.length; i++) {
        heading[i] = rom.mainDataView.getUint16(CANYON_HEADING + i * 2, true);
    }

    return { keys, triggers, groups, scenery, heading };
}

/*
 * One axis of one segment of object_move's curve.
 *
 * sub_71BCC hands the coprocessor's 0x19003232 six numbers: how long the
 * segment is and how far into it the count has got, this key's value and the
 * next one's, and a slope at each end. The op is a cubic Hermite, and it scales
 * both slopes by a thirtieth of the segment's length.
 *
 * A thirtieth, not a thirty-second — which is worth pinning down, because the
 * i960 divides each slope by a *thirty-second* of the frames it measured over
 * (below), and 32 there and 32 here would cancel to exactly the Catmull-Rom
 * spline the shape is. It does not: solving for the scale against a recording
 * of stage_xpos off the board — stf-tools/mame-canyon-path.py — gives 30.00 on
 * every segment, to every digit the capture has, and the tangents come out a
 * fifteenth long. The curve bows that much wider than a Catmull-Rom would: with
 * 32 in its place the boat is up to half a unit off the board's own position
 * through every bend, and with 30 it is the board's position to the digit.
 */
const CANYON_SLOPE_DIV = 30;

function canyonCurve(span, t, v0, v1, m0, m1) {
    if (span <= 0) return v0;
    const u = t / span;
    const u2 = u * u;
    const u3 = u2 * u;
    const k = span / CANYON_SLOPE_DIV;
    return (2 * u3 - 3 * u2 + 1) * v0
        + (u3 - 2 * u2 + u) * (m0 * k)
        + (-2 * u3 + 3 * u2) * v1
        + (u3 - u2) * (m1 * k);
}

/*
 * The slope between two keys, as sub_71BCC measures it: the distance over a
 * thirty-second of the frames between them, and the shift is an integer one.
 * Seventy-five frames and ninety-five frames both count as two thirty-seconds,
 * so the curve is not quite the smooth one the arithmetic suggests — carrying
 * that truncation across is worth a good deal of the boat's line. The same fit
 * that pins the scale above pins this: solved with the shift, the scale comes
 * out at exactly 30 on every segment; solved without it, at anything from 25 to
 * 30 depending on which segment is asked, which is the truncation showing up as
 * the inconsistency it is.
 */
function canyonSlope(keys, a, b) {
    const span = (keys[b].frame - keys[a].frame) >> 5;
    return keys[b].pos.map((v, i) => (v - keys[a].pos[i]) / span);
}

/*
 * The drop at the end of the run — the one place the boat's height is not the
 * curve's. From count 0x60F sub_71ED8 takes the height over and falls it, and
 * from 0x62A sub_71F28 bounces it four times as the boat lands. Both keep a
 * counter of their own, step it once a frame, and add half a constant times its
 * square to a running height; sub_71F28 restarts that counter at each of its
 * four turns and flips the constant at three of them.
 *
 * The height it starts from is the curve's, read once on the count the fall
 * begins; from there the running height is the board's own and the curve is not
 * consulted again until the bouncing stops. The counter stands at ten when the
 * fall begins — canyon_init leaves it there, and so does every lap after the
 * first: the last bounce runs exactly ten frames and nothing resets it again
 * before the fall comes round.
 */
const CANYON_FALL = { from: 0x60f, accel: -0.0020000000949949026 };
const CANYON_BOUNCE = [
    { from: 0x62a, accel: 0.004999999888241291 },
    { from: 0x636, accel: -0.004999999888241291 },
    { from: 0x640, accel: 0.004999999888241291 },
    { from: 0x64a, accel: -0.004999999888241291 },
];
const CANYON_BOUNCE_END = 0x654;
const CANYON_FALL_COUNT = 10;

function canyonFall(y, c) {
    let n = CANYON_FALL_COUNT;
    let out = y;
    for (let i = CANYON_FALL.from; i <= c; i++) {
        let accel = CANYON_FALL.accel;
        for (const b of CANYON_BOUNCE) {
            if (i === b.from) n = 0;
            if (i >= b.from) accel = b.accel;
        }
        n += 1;
        out += 0.5 * accel * n * n;
    }
    return out;
}

/*
 * sub_71FD0's ang_x: thirty frames of nose down as the boat goes over the fall,
 * twenty held, then thirty back up. It is written into 0x50A020 a step of 160
 * at a time and lands exactly back on zero, which is what lets the counts it
 * runs over stand in for the state it is really kept as.
 */
const CANYON_DIVE = { from: 0x5fa, hold: 0x618, back: 0x62c, to: 0x64a, step: 160 };

function canyonPitch(c) {
    const d = CANYON_DIVE;
    const down = -d.step * (d.hold - d.from);
    if (c < d.from) return 0;
    if (c < d.hold) return -d.step * (c - d.from + 1);
    if (c < d.back) return down;
    if (c < d.to) return down + d.step * (c - d.back + 1);
    return 0;
}

/*
 * The curve at one count: object_move walks the script for the key the count is
 * inside — the last one whose own count it has reached — and runs the segment
 * out of it.
 */
function canyonSpline(keys, c) {
    let k = 0;
    while (k + 1 < keys.length && c >= keys[k + 1].frame) k++;
    const next = keys[k + 1];
    /* object_move counts the segments it has started, and the slope it enters a
     * segment on is zero until it has started one, and the run out of the first
     * key is the one that is never started: it has no key behind it to measure
     * against, and the loop rejoins at the second key rather than the first, so
     * it is flown once and only once. The slope it leaves on is measured either
     * way, so the curve is still smooth across that key. */
    const m0 = k > 0 ? canyonSlope(keys, k - 1, k + 1) : [0, 0, 0];
    const m1 = next.type === CANYON_END ? [0, 0, 0]
        : next.type === CANYON_HOLD ? canyonSlope(keys, k, k + 1)
            : canyonSlope(keys, k, k + 2);

    const span = next.frame - keys[k].frame;
    return keys[k].pos.map((v, i) => canyonCurve(
        span, c - keys[k].frame, v, next.pos[i], m0[i], m1[i]));
}

/**
 * Where the boat is at a frame, in the board's own coordinates and angle units.
 *
 * The heading is not computed from the path: the continuation builds one out of
 * the frame's own movement — the same asin of a normalised vertical part the
 * Flying Carpet noses up by — and then throws it away, reading a 16-bit angle
 * off a table of one per count instead and storing its negation. The dead
 * arithmetic is left out here; the table is what the stage flies by.
 */
export function canyonAt(canyon, frame) {
    const c = canyonMoveClock(frame);
    if (c < 1) return { pos: [0, 0, 0], yaw: 0, pitch: 0 };
    const pos = canyonSpline(canyon.keys, c);
    if (c >= CANYON_FALL.from && c < CANYON_BOUNCE_END) {
        pos[1] = canyonFall(canyonSpline(canyon.keys, CANYON_FALL.from)[1], c);
    }
    return { pos, yaw: -canyon.heading[c], pitch: canyonPitch(c) };
}

/*
 * The tunnel light.
 *
 * The continuation keeps a scale at 0x530200 — canyon_init puts 0x100 there,
 * and it walks two down a frame over counts 0x4CE..0x513 and two back up over
 * 0x596..0x5DB, so the boat is at 116/256 of itself for the hundred and thirty
 * counts between and back to full either side. Every frame it hands that scale
 * to material_part_chg for five of the geometry engine's thirty-two material
 * slots — 4, 7, 13, 18 and 21 — and stage_dsp does a sixth, 29, around the
 * platform draw, putting 0xFFFF back afterwards. On this stage those are the
 * same thing: 29 is the boat's own material, nothing else on the stage names
 * it, and 0xFFFF is what the record has in it.
 *
 * material_part_chg interpolates each byte of a slot towards a base it is
 * handed, and the base here is zero, so a slot comes out `(byte * scale) >> 8`
 * — an integer multiply and shift, which is why 0x100 is exactly the identity.
 *
 * What darkens is everything riding the boat. Slots 4, 7 and 13 are the
 * fighters' — 13 is what nearly every part of every character is drawn with,
 * and 4 and 7 are the second colours of about half of them — and 18, 21 and 29
 * are the deck, its ring and its rail, 13 again for sixty of the deck's faces.
 * Fifty-two faces of the canyon are drawn with 18 and go with it; everything
 * else the canyon is made of is 19, 20, 22 and 31 and stays lit. So the run is
 * the shadow of what the boat passes under, thrown on the boat and the fight
 * rather than on the canyon — and with no fighters here, on the boat alone.
 */
const CANYON_TUNNEL = { into: 0x4ce, dark: 0x514, out: 0x596, lit: 0x5dc, step: 2 };
const CANYON_TUNNEL_SLOTS = [4, 7, 13, 18, 21, 29];
const MATERIAL_UNIT = 0x100;

function canyonTunnelScale(c) {
    const t = CANYON_TUNNEL;
    const deep = MATERIAL_UNIT - t.step * (t.dark - t.into);
    if (c < t.into) return MATERIAL_UNIT;
    if (c < t.dark) return MATERIAL_UNIT - t.step * (c - t.into + 1);
    if (c < t.out) return deep;
    if (c < t.lit) return deep + t.step * (c - t.out + 1);
    return MATERIAL_UNIT;
}

/**
 * The material slots a stage rewrites at a frame — null on a stage that leaves
 * the record's own alone, which is every stage but this one.
 *
 * The board keeps the whole 32-slot table in RAM and uploads it; only these
 * slots ever differ from the record, so only these are handed back.
 */
export function stageMaterials(stage, frame, frames = null) {
    if (stage.placements || stage.slot !== CANYON_CRUISE_SLOT || !frames?.canyon) return null;
    const k = canyonTunnelScale(canyonMoveClock(frame));
    return CANYON_TUNNEL_SLOTS.map((slot) => {
        const m = stage.materials[slot];
        return { slot, diffuse: (m.diffuse * k) >> 8, ambient: (m.ambient * k) >> 8 };
    });
}

/* An env object's place. The matrix camera_init saved for the world already
 * carries the 1.6 the ground pass draws at, and canyon_env_disp's translate
 * goes on after it — so this offset is scaled where a ground chunk's own
 * placement is not. */
function canyonPlace(at) {
    return [['s', [1.6, 1.6, 1.6]], ['t', [at[0], at[1], -at[2]]]];
}

function canyonDisp({ pushAnim, sx, cageY }) {
    pushAnim('canyonRail', {
        index: (f) => {
            const c = canyonClock(f);
            return (c & 0x80) ? (c % 32) * 2 : c % 64;
        },
    }, [['s', [sx, cageY, sx]]]);
}

/*
 * The stage's second object, and the only routine in the game that draws in the
 * world's frame rather than the arena's: it loads the matrix camera_init put in
 * the coprocessor's eighth slot, which is the prologue with the ground pass's
 * 1.6 already on it, and hangs each piece off that.
 *
 * What it draws is the stage's scenery in every sense but which routine happens
 * to draw it — Canyon Cruise's record carries no ground chunks and no floor at
 * all, the whole canyon is here — so it comes out on the ground and water
 * layers rather than in with the objects, and the camera frames on it.
 */
function canyonEnvDisp({ pushWorld, frames }) {
    const canyon = frames?.canyon;
    if (!canyon) return;
    for (const o of canyon.scenery) pushWorld(o.model, 'ground', canyonPlace(o.at));
    for (const o of CANYON_WATER) pushWorld(o.model, 'water', canyonPlace(o.at), SEA_BAND);
}

/* ---- boss_disp: the Death Egg's hangar ----
 * The Earth hung in the sky, the floor, whose texture is rebuilt every frame,
 * and five panels each wobbling about X on its own phase of one triangle wave.
 * The wave is 0..63 folded out of the counter's low seven bits and then shifted
 * up four, so the whole swing is five and a half degrees. */
const BOSS_FLOOR = 1165;
/*
 * The floor, which does not move: its texture crawls across it.
 *
 * This is the aurora's trick one coordinate over. boss_init installs a
 * continuation that calls move_tpd_req once a frame with the block at
 * BOSS_FLOOR_POINTS, and puts the offset in g2 where the aurora puts its own in
 * g1 — so what tpd_move walks is the *second* short of every pair, which is u.
 *
 * The block's 192 points are the plate's 48 faces at four corners each, and the
 * plate is a 6x8 grid: u runs across the six panels in z and v across the eight
 * in x, one whole tile laid over the floor exactly once. So sliding u carries
 * the pattern along the plate in z, and because the tile is laid once the wrap
 * lands where it started.
 *
 * The offset is `((frame_counter >> 3) << 5) & 0x7FF`: 32 raw units — four
 * texels — every eighth frame, wrapping at one whole 256-texel tile, so it is
 * seamless. That is 512 frames to come round, the same as the aurora's by a
 * different route.
 */
const BOSS_FLOOR_POINTS = 0x00072fc4;
const BOSS_FLOOR_SCROLL = { axis: 'u', step: 32, shift: 3, mask: 0x7ff };
/*
 * The Earth, which is not a globe: model 1124 is a flat 16x16 card carrying one
 * 256x256 tile, hung 42000 units out and blown up a thousand times.
 *
 * boss_disp draws it with the matrix reset to the identity rather than built on
 * the camera's, so on the board it is a backdrop in the strict sense — pinned
 * to the view, in the same place on screen whatever else happens. The board's
 * camera never turns far enough for that to differ from a card standing in the
 * world at the same offset, and a free camera has to be able to turn away from
 * it, so it is placed in the world here.
 *
 * What is kept is the billboard. The routine ends the transform with the
 * coprocessor's face-the-camera command, and that is the half a flat card
 * cannot do without: leave it out and the Earth is edge-on from anywhere but
 * the one direction the board happened to look from.
 */
const BOSS_EARTH = 1124;
const BOSS_EARTH_AT = [-5750.0, -3190.0, 42000.0];
const BOSS_EARTH_SCALE = 1000.0;
const BOSS_PANELS = [
    { model: 1171, phase: null },
    { model: 1205, phase: 40 },
    { model: 1206, phase: 0 },
    { model: 1170, phase: 30 },
    { model: 1209, phase: 10 },
    { model: 1210, phase: 20 },
];

function bossWobble(c) {
    const t = c & 0x7f;
    return ((t & 0x40) ? 63 - (t & 63) : t) << 4;
}

function bossDisp({ push, pushBackdrop, pushTpd, sx, frames }) {
    pushBackdrop(BOSS_EARTH, [
        /* The translate is emitted before the scale, so the card is a thousand
         * times its own size where it stands rather than a thousand times as
         * far out. */
        ['t', [BOSS_EARTH_AT[0], BOSS_EARTH_AT[1], -BOSS_EARTH_AT[2]]],
        BILLBOARD,
        ['s', [BOSS_EARTH_SCALE, BOSS_EARTH_SCALE, BOSS_EARTH_SCALE]],
    ]);
    pushTpd(BOSS_FLOOR,
        { ...BOSS_FLOOR_SCROLL, points: frames?.bossFloorPoints ?? null },
        [['s', [sx, 1.6, sx]]]);
    for (const p of BOSS_PANELS) {
        const scale = ['s', [sx, sx, sx]];
        if (p.phase === null) { push(p.model, [scale]); continue; }
        push(p.model, (f) => [scale, ['rx', bossWobble(f + 1 + p.phase) * ANGLE_DEG]]);
    }
}

/* ---- draw_sphynx_head: the Flying Carpet's second object ----
 * See the note above sphynxOps for where the head belongs, and the one above
 * carpetWorld for why it alone of these three carries the arena's frame. */
function sphynxDisp({ push, sx, fs }) {
    push(SPHYNX_HEAD, (f) => sphynxOps(carpetAt(f)));
    for (let i = 0; i < 4; i++) {
        push(SPHYNX_CORNER, [['s', [sx, sx, sx]], ['r', i * 90]]);
    }
    push(SPHYNX_PLATE, [['s', [fs, fs, fs]]]);
}

/*
 * The routines the viewer runs, by the address the stage record names them at.
 *
 * A routine that is a bare `ret` draws nothing and is listed as null, so that a
 * stage asking for one is not mistaken for a stage the viewer has failed to
 * cover: flying_carpet_disp, aurora_nothing and post_metal_stage_init are each
 * a single instruction. Every other address in the table has one.
 */
const OBJECT_ROUTINES = new Map([
    [0x00072160, sphynxDisp],       /* draw_sphynx_head */
    [0x00072904, null],             /* flying_carpet_disp — ret */
    [0x00072a64, bossDisp],
    [0x00073f30, pinballDisp],
    [0x00074758, mushroomDisp],
    [0x00074e58, auroraDisp],
    [0x00075618, null],             /* aurora_nothing — ret */
    [0x00075a24, dynamiteDisp],
    [0x000763c8, canyonDisp],
    [0x00076758, canyonEnvDisp],
    [0x00076d30, giantWingDisp],
    [0x000771a4, propellerDsp],
    [0x000774c4, null],             /* post_metal_stage_init — ret */
]);

/**
 * Build the draw list for one stage.
 * @param {object} stage  from readStageTable()
 * @param {object} frames from readFrameTables(); without it a stage is built
 *                        at rest, with every animated draw held on frame 0.
 */
/*
 * The draw list of a stage whose geometry is already in world space.
 *
 * Sonic The Fighters scales its arena by 1.6 and gives the cage, the poles, the
 * ring ramp and the platform a transform each, which is what the long function
 * below is mostly about. Fighting Vipers does none of that: change_scene pushes
 * the stage position once and then hands each list to `area_clip`, which is a
 * cull and not a transform — it reads four indices per model out of a
 * visibility bitmap and calls set_obj with no matrix at all. So the draw list is
 * the lists themselves, at the identity.
 *
 * What is not optional is the flags word. Every one of the draw functions opens
 * by testing a bit of it and returning if the bit says this stage does not draw
 * that list, and the bits are not decoration — the first stage sets bit 13,
 * which skips the sixteen parts entirely. Drawing them anyway puts models in the
 * arena the board never puts there: a figure standing on a fence post, a wedge
 * lying in the dirt. The bit each function tests is named beside it below.
 *
 * Still missing is the object list at 0xB4, which animates: a stage built here
 * is the stage standing still.
 */
export function buildFlatDisplayList(stage) {
    const out = [];
    const f = stage.flags;
    const push = (m, layer, extra = {}) => {
        if (m) out.push({ model: m, layer, ops: [], ...extra });
    };

    /*
     * Three lists share the ground plane, and the order they are submitted in
     * is the only thing that separates them.
     *
     * On a stage like the night parking lot every road plate, the arena floor
     * and the platform sit at exactly y = 0. The board has no depth buffer:
     * they land in one z bucket, the bucket is drawn newest first, and the fill
     * writes a pixel only where nothing has, so the last one submitted is the
     * one you see. A depth test has no such rule — two surfaces at the same z
     * give an undefined winner that swaps as the camera moves, which is the
     * flicker along a road marking lying in the road.
     *
     * So each list takes a depth bias for where it falls in that order. The
     * draw functions run: sub_238E4 first, which area_clips the sixteen at 0x64
     * and then draws the single model at 0x18, and ground_upper_disp after it,
     * which area_clips the list at 0x24. Later submitted wins, so the sixteen
     * go furthest back, the floor sits between, and the 0x24 list keeps the
     * front.
     *
     * This is not the other game's arrangement and must not borrow its floor
     * material. There, camera_init lays the floor down before every other pass
     * and it concedes to everything; here the floor is submitted in the middle
     * and only concedes to what comes after it.
     */
    /* ground_upper_disp: `bbs 0xB, r11` returns before the list at 0x24. */
    if (!(f & (1 << 0xb))) {
        for (const m of stage.layers.upper ?? []) push(m, 'upper', { planeBias: 0 });
    }

    /* sub_238E4: `bbs 0xD, r3` skips the area_clip over the sixteen at 0x64,
     * but the single model at 0x18 is drawn either way — it is past the branch
     * target, not inside it. */
    if (!(f & (1 << 0xd))) {
        for (const m of stage.layers.ground ?? []) push(m, 'ground', { planeBias: 2 });
    }

    for (const m of stage.layers.floor ?? []) push(m, 'floor', { planeBias: 1 });

    /* sub_235BC: no flag of its own, but stages 7 and 14 return before the
     * read at 0x1A. It runs after both of the ground passes, so the platform
     * keeps the front of the plane like the 0x24 list. */
    if (stage.slot !== 7 && stage.slot !== 14) {
        for (const m of stage.layers.platform ?? []) push(m, 'platform', { planeBias: 0 });
    }

    /* cage_sub_disp: `bbc 0xE, r3` returns unless bit 14 is set. */
    if (f & (1 << 0xe)) for (const m of stage.layers.extra ?? []) push(m, 'extra');

    /*
     * The cage, which is eight wall panels and a rail over them.
     *
     * cage_clip_m walks the eight models at 0x84 and pushes the same translate
     * before each — `lda 0x40C00000` into the third slot of a 0x3000606, six
     * units — then pushes its negation after, so each wall is drawn six out
     * from the arena centre and the next starts from the centre again. No
     * rotation: the eight models are already oriented, one per side. Drawing
     * them at the identity is what stacked them in the middle.
     *
     * The 24 entries at 0x84 are three groups of eight and the group is chosen
     * by a damage state, not a ring — the table cage_clip_m indexes with the
     * wall's hit timer gives group 0 at rest, and on every stage the three
     * groups hold the same eight models anyway. The reader keeps the first.
     */
    const CAGE_PUSH = [['t', [0, 0, 6.0]]];
    for (const m of stage.layers.cage ?? []) push(m, 'cage', { ops: CAGE_PUSH });

    /* cage_clip_m: `bbc 0x14, r3` skips the model at 0x20, which it draws under
     * the same six-unit push — the cage's top rail. */
    if (f & (1 << 0x14)) push(stage.cageTop, 'cage', { ops: CAGE_PUSH });

    /* pole_disp: `bbc 0x12, r3` returns unless bit 18 is set, and stage 7
     * returns before that. */
    if ((f & (1 << 0x12)) && stage.slot !== 7) push(stage.cagePole, 'poles');

    /*
     * The railing round the arena.
     *
     * sub_24224 tests flags bit 17 and calls sub_24294 four times with the Y
     * rotation stepped a quarter turn each — 0, 0x4000, 0x8000, 0xC000 in the
     * binary radians the board uses — and each pushes the same six units out
     * before drawing, so the four panels make the ring. The scale sub_24294
     * also pushes is built from two runtime values that are both unity with the
     * numbers the board sets at stage load, so it is left out.
     */
    const rail = stage.rail;
    if (rail && (f & (1 << rail.flagBit))) {
        const model = rail.bySlot[stage.slot] ?? rail.model;
        for (let i = 0; i < rail.turns; i++) {
            push(model, 'cage', {
                ops: [['r', (i * 360) / rail.turns], ['t', [0, 0, rail.push]]],
            });
        }
    }

    return out;
}

export function buildStageDisplayList(stage, frames = null) {
    const out = [];
    const flags = stage.flags;
    const slot = stage.slot;
    const sx = STAGE_X / 6.0;                                  /* 1.333… */
    const fs = stage.floorSize;                                /* floor_stage_size_0 */
    const cageY = (stage.height * 1.6) / CAGE_HEIGHT_DIV;      /* 1.6 on every stage */
    const southIsland = SOUTH_ISLAND_SLOTS.includes(slot);

    /* The three draws that push the world prologue first. On a stage that does
     * not move there is no prologue, so this hands the op list back untouched
     * and the draw stays static. */
    const moves = stageWorldFrame(stage, 0, frames) !== null;
    const inWorld = !moves ? (ops) => ops : (ops) => (
        typeof ops === 'function'
            ? (f) => [...stageWorldFrame(stage, f, frames), ...ops(f)]
            : (f) => [...stageWorldFrame(stage, f, frames), ...ops]);

    const push = (model, layer, ops) => {
        if (model) out.push({ model, layer, ops });
    };
    /* An animated draw is pushed under the model it shows at rest, so a stage
     * built without a frame table is exactly the stage this used to build. */
    const pushAnim = (table, shift, phase, layer, ops) => {
        if (!frames) return;
        const anim = { frames: frames[table], shift, phase };
        out.push({ model: frameModel(anim, 0), anim, layer, ops });
    };

    /* ---- camera_init: the ground plate, at a flat 1.6 scale ----
     *
     * This draw, and only this draw, carries `groundPlate`. The concession
     * js/viewer.js hands it — the whole z-sort bound, whether its faces are
     * shallow or not — is an argument about `stage_floor` in particular: one
     * plate hundreds of units across, sorted by its own farthest corner, that
     * camera_init lays down before every other pass so that everything standing
     * in it wins outright. It is not an argument about the layer, which is a
     * grouping for the sidebar's checkboxes and collects one draw that is no
     * such plate — see the Final Eggman Boss below. */
    if (!(flags & (1 << 2))) {
        for (const m of stage.layers.floor) {
            if (m) {
                out.push({
                    model: m, layer: 'floor', groundPlate: true,
                    ops: inWorld([['s', [1.6, 1.6, 1.6]]]),
                });
            }
        }
    }

    /* ---- ground_disp / area_clip: scenery chunks, pre-placed in world space ---- */
    if (!(flags & (1 << 0xd))) {
        for (const m of stage.layers.ground) push(m, 'ground', inWorld([['s', [1.6, 1.6, 1.6]]]));
    }
    /* ground_disp draws the sea through set_obj_thd, whose second argument is
     * the per-frame texture header above. The sea is the one part of the arena
     * the i960 hands straight to the geometry processor rather than through the
     * coprocessor, so it does not appear in the coprocessor's draw list at all —
     * but the transform it is drawn under does, pushed between the last ground
     * chunk and the pop that ends the pass, and it is the flat 1.6 the rest of
     * ground_disp's chunks get. Nothing translates or rotates it.
     *
     * The plate is off-centre in its own right: twelve faces at y = -6.4,
     * spanning x -94.5..318.8 and z -180.8..286.9. That lopsidedness is the
     * model's, not the transform's, which is why it still reads as a lopsided
     * plate once placed. It keeps its own layer and stays out of camera
     * framing, because from a free camera its edge is visible where the board's
     * camera never goes. */
    if (southIsland) {
        out.push({
            model: SOUTH_ISLAND_WATER, layer: 'water', band: SEA_BAND,
            ops: inWorld([['s', [1.6, 1.6, 1.6]]]),
        });
    }

    /* ---- doom_cnt: the backdrop ring ----
     * The rotation is applied before each draw and accumulates, so segment i
     * sits at (i+1) steps. Every stage but Aurora Icefield also scales it 1.6.
     *
     * doom_cnt pushes the prologue like the rest of the world, and on one stage
     * it pushes only half of it: it compares stage_num against 4 and skips the
     * translate outright, so on Canyon Cruise the backdrop turns with the boat
     * but travels along with it. That is the only thing that could work there —
     * the boat crosses six hundred units of canyon, and a horizon left standing
     * at the world's origin would be somewhere off to one side by the end. */
    const inBackdrop = !(moves && slot === CANYON_CRUISE_SLOT) ? inWorld : (ops) => {
        const world = inWorld(ops);
        const n = stageWorldFrame(stage, 0, frames).length;
        return (f) => world(f).filter((op, i) => i >= n || op[0] !== 't');
    };
    /* Two records carry a backdrop the stage never shows: doom_cnt returns on
     * the slot before it reads one, on Mushroom Hill — whose canopy is drawn by
     * its own object instead — and on the Final Eggman Boss, which is indoors.
     * Death Egg's Eye is the third, but it drops its backdrop partway through
     * its transition rather than on the slot, so it keeps the one it starts
     * with. */
    const backdrop = slot !== MUSHROOM_HILL_SLOT && slot !== FINAL_EGGMAN_SLOT;
    if (backdrop && stage.sky.length) {
        const drifts = (flags >>> SKY_DRIFT_BIT) & 1;
        for (let i = 0; i < SKY_SEGMENTS; i++) {
            const model = stage.sky[i % stage.sky.length];
            const seg = (i + 1) * SKY_STEP_DEG;
            /* Both are Y rotations, so the drift and the segment's own quarter
             * of a quarter turn simply add. */
            const tail = slot !== AURORA_ICEFIELD_SLOT ? [['s', [1.6, 1.6, 1.6]]] : [];
            push(model, 'sky', inBackdrop(drifts
                ? (f) => [['r', seg + f * SKY_DRIFT_STEP], ...tail]
                : [['r', seg], ...tail]));
        }
    }

    /* ---- stage_dsp ---- */
    if (southIsland) {
        /* sub_26604 */
        push(SOUTH_ISLAND_CAGE_SHADOW, 'extra', [['s', [sx, 1.6, sx]]]);
        pushAnim('palmShadow', PALM_SHIFT, PALM_SHADOW_PHASE, 'extra',
            [['s', [fs, 1.6, fs]]]);
        PALM_POSITIONS.forEach(([px, pz], i) => {
            /* 0x2F005E5E scales the position by floor_stage_size_0, and the
             * translate is emitted before the scale, so the tree stands at
             * fs·p — not fs²·p. The four corners are symmetric about both axes,
             * so only the phase gives the Z negation away: get it wrong and each
             * tree sways to its mirror corner's beat. */
            pushAnim('palm', PALM_SHIFT, PALM_TREE_PHASE * i, 'extra',
                [['t', [fs * px, 0, -fs * pz]], ['s', [fs, 1.6, fs]]]);
        });
    }
    if (slot === FINAL_EGGMAN_SLOT) {
        /*
         * sub_2731C, at the one state the stage is ever in.
         *
         * Nearly every branch here reads 0x500498, the word bossm_init zeroes
         * on the frame the Death Egg's Eye loads and the transition then fills
         * in a bit at a time — the elevator arriving, the shutter going up, the
         * floor activating. None of that is this stage: by the time slot 10 is
         * loaded the sequence has finished, and bossm_cont has set bit 31, the
         * bit that says so. Two things settle that it is the state to draw
         * rather than a guess at one. Bit 31 is what makes the parent stage
         * jump straight into this routine, so the two slots show the same arena
         * across the hand-off — which is the point of the hand-off. And it is
         * the bit that turns off sub_27E3C, the continuation that walks a
         * fighter out of the hangar door and would otherwise still be running
         * with the round in progress.
         *
         * So the shutter is up — bossm_shutter_up_cnt returns without drawing
         * one — and the floor is at full size rather than partway through the
         * scale table it grows along.
         */
        /*
         * The message panel, and the one draw on the `floor` layer that is not
         * camera_init's ground plate: slot 10's `stage_floor` is zero, so
         * camera_init lays down nothing here and this is sub_2731C's own draw,
         * grouped with the floor because that is what it reads as. It carries
         * no `groundPlate`, so it keeps its own depth rather than conceding the
         * z-sort bound — the concession is the ground plate's, and taking it
         * sank this panel through the drum it is lying inside, which stood the
         * arch of 1122's inner wall up through the lettering.
         */
        push(EGGMAN_FLOOR, 'floor', [['s', [fs, 1.0, fs]]]);
        /* The frame the rest of it is drawn in. Anything repeated takes its
         * quarter turns after the translate, the order the display list pushes
         * them in. */
        const inHangar = (turn) => [
            ['s', [fs, 1.6, fs]], ['t', [0, EGGMAN_HANGAR_LIFT, 0]],
            ...(turn === undefined ? [] : [['r', turn]]),
        ];
        push(EGGMAN_CEILING, 'ground', inHangar());
        for (const turn of EGGMAN_HANGAR_TURNS) push(EGGMAN_HANGAR, 'ground', inHangar(turn));
        for (const door of EGGMAN_DOORS) push(door, 'ground', inHangar());
        push(EGGMAN_TUBES, 'ground', inHangar());
        for (let i = 0; i < 4; i++) push(EGGMAN_DOOR_SURROUND, 'ground', inHangar(i * 90));
        for (let i = 0; i < 4; i++) push(EGGMAN_BRIDGE, 'ground', inHangar(i * 90));
        /* The iris in the ceiling, and the one part of the hangar that moves.
         * Its table is a run out and the same run back, walked a frame at a
         * time, so the door opens and shuts once every 128 frames. */
        pushAnim('hangarIris', 0, 0, 'ground', inHangar());
    }
    const platformScale = slot === 7 ? [fs, fs, fs] : [fs, 1.6, fs];
    if (slot === AURORA_ICEFIELD_SLOT) {
        /* stage_dsp compares the slot against 2 on its second instruction and
         * returns — before the per-stage branches and before it has done
         * anything with the model it has just read out of the record. So Aurora
         * Icefield's stage_platform is not drawn here at all; the 559 on screen
         * is the one aurora_disp draws for itself, at the same (fs, 1.6, fs),
         * and drawing it twice only put the ice's cracks in a fight with
         * themselves. It is the second of two skips the stage takes on its own
         * account: flag bit 2 has already turned off camera_init's floor above,
         * and Aurora is the only record that sets it. */
    } else if (slot === FLYING_CARPET_SLOT) {
        /* animate_flying_carpet hands stage_dsp a frame of its own table in
         * place of stage_platform, so the record's 581 is never drawn: the
         * carpet ripples through all sixty-four frames instead. */
        pushAnim('carpetFloor', 1, 0, 'platform', [['s', platformScale]]);
    } else {
        for (const m of stage.layers.platform) push(m, 'platform', [['s', platformScale]]);
    }

    /* ---- cage_sub_disp ---- */
    if (flags & (1 << 0xe)) {
        if (southIsland) {
            /* loc_250D4: one ramp off the -X side of the ring, not a ring of
             * four. The X scale is derived, not read: (14.5*1.6 - 6.5*fs) / 8.
             * Nothing here is symmetric, so this is the one place on the stage
             * where a translate's Z sign moves a part rather than relabelling
             * it — the board puts the ramp at +1.0, which is -1.0 here. */
            const scaleX = (14.5 * 1.6 - 6.5 * fs) / 8.0;
            push(stage.layers.extra[0], 'extra',
                [['t', [fs * -6.5, -0.2, -1.0]], ['s', [scaleX, fs, fs]]]);
        } else if (slot !== FLYING_CARPET_SLOT) {
            for (let i = 0; i < 4; i++) {
                for (const m of stage.layers.extra) {
                    push(m, 'extra', [['s', [sx, 1.0, sx]], ['r', i * 90]]);
                }
            }
        }
    }

    /* ---- cage_display: four walls, each a quarter turn on from the last ----
     *
     * cage_clip_m branches on the stage before it reaches the record's panel
     * list, so on four stages those panels are never drawn. Three of the four
     * are reproduced here: the Flying Carpet's ring rope and the Final Eggman
     * Boss's electric fence are frame tables, and Canyon Cruise's boat ring is
     * a table of four, one model per wall — which is why the record carries
     * only the first of them. The fourth is Death Egg's Eye, below. */
    {
        const panels = cagePanelCount(flags);
        for (let wall = 0; wall < 4; wall++) {
            /* Every panel of a wall is drawn at the same offset — +6 on the
             * board, so -6 here; the models themselves carry the X span they
             * cover, which is what lets the game destroy them individually. The
             * ring of four is symmetric, so the wrong sign leaves every panel in
             * a real wall's place, just spun to face the way it came. */
            const at = [['s', [sx, cageY, sx]], ['r', wall * 90], ['t', [0, 0, -6.0]]];
            for (let i = 0; i < panels; i++) {
                if (slot === FLYING_CARPET_SLOT) {
                    pushAnim('carpetRing', 1, 0, 'cage', at);
                } else if (slot === FINAL_EGGMAN_SLOT) {
                    /* The fence steps its table once a frame rather than once
                     * every two, and half of that table is the zero half of a
                     * long — so it strobes, on one frame and gone the next. */
                    pushAnim('fence', 0, 0, 'cage', at);
                } else if (slot === CANYON_CRUISE_SLOT && frames) {
                    push(frames.canyonRing[wall], 'cage', at);
                } else {
                    /* Death Egg's Eye (slot 9) takes the fence too, but only
                     * once its elevator has arrived; before that it draws a
                     * wall of its own at a height read out of RAM. Neither is
                     * stage-record state, so its own panels stay standing. */
                    push(stage.cagePanels[i], 'cage', at);
                }
            }
        }
    }

    /* ---- pole_disp ---- */
    if (southIsland) {
        for (let i = 0; i < 4; i++) {
            push(SOUTH_ISLAND_CAGE_CORNERS[i], 'poles', [['s', [sx, 1.6, sx]], ['r', i * 90]]);
        }
    } else if (slot === FLYING_CARPET_SLOT) {
        /* loc_25300: corners sit at fixed coordinates rather than on quarter
         * turns, are yawed to the camera's heading (0x25388, fa_camera+0x26),
         * scaled uniformly, and each carries a flame. */
        const k = STAGE_X / CARPET_CORNER_DIV;
        CARPET_CORNERS.forEach(([cx, cz], i) => {
            /* The board puts these at (-8,+8), (-8,-8), (+8,-8), (+8,+8) in its
             * own space, so the Z is negated on the way in like every other
             * translate here. The four are symmetric, so getting it wrong left
             * each post standing in a real post's place and only moved which
             * flame phase burned on which corner. */
            const at = [['t', [cx * k, 0, -cz * k]], CAMERA_YAW, ['s', [1.6, 1.6, 1.6]]];
            push(stage.cagePole, 'poles', at);
            /* The flame goes up 4.1 in the post's scaled frame, then faces the
             * camera (0x253D4) — which also drops the post's 1.6, so the flame
             * is drawn at its own size, or 1.25 of it on a pulse. */
            const lift = [...at, ['t', [0, CARPET_FLAME_Y, 0]], BILLBOARD];
            const big = [...lift, ['s', CARPET_FLAME_FLICKER]];
            pushAnim('carpetFlame', CARPET_FLAME_SHIFT, CARPET_FLAME_PHASE * i, 'poles',
                (f) => (f & 1 ? lift : big));
        });
    } else if (slot === FINAL_EGGMAN_SLOT) {
        /* loc_2613C: the same ring of four on quarter turns as the general
         * case, but the model is an immediate rather than the record's. The
         * record does carry a post — 1208, the one slot 8 draws — and this
         * branch is taken before the flag test that would reach it, so the
         * Death Egg's own 2428 is what stands here. */
        for (let i = 0; i < 4; i++) {
            push(EGGMAN_POLE, 'poles', [['s', [sx, 1.6, sx]], ['r', i * 90]]);
        }
    } else if (flags & (1 << 0x12)) {
        for (let i = 0; i < 4; i++) {
            push(stage.cagePole, 'poles', [['s', [sx, 1.6, sx]], ['r', i * 90]]);
        }
    }

    /* ---- object_control: the stage's own objects, drawn after the arena ----
     * An object is drawn in the arena's frame, which is what keeps the Flying
     * Carpet's corner pieces riding round with it. canyon_env_disp and
     * giant_wing_disp ask for the world's instead, by loading a matrix
     * camera_init saved there — pushWorld. */
    for (const object of stage.objects ?? []) {
        const routine = OBJECT_ROUTINES.get(object.disp);
        if (!routine) continue;
        routine({
            stage,
            frames,
            sx,
            fs,
            cageY,
            push: (model, ops) => push(model, OBJECT_LAYER, ops),
            /* A draw the routine makes with the matrix reset to the identity
             * rather than built on the camera's, which is the board's way of
             * saying background rather than scenery: it goes behind the horizon
             * shells, whatever distance it names. */
            pushBackdrop: (model, ops) => {
                if (model) out.push({ model, layer: OBJECT_LAYER, backdrop: true, ops });
            },
            pushAnim: (table, anim, ops) => {
                if (!frames) return;
                const a = { frames: frames[table], shift: 0, phase: 0, ...anim };
                out.push({ model: frameModel(a, 0), anim: a, layer: OBJECT_LAYER, ops });
            },
            /* A draw whose texture points are rebuilt every frame. At frame 0
             * the offset is zero, so a stage built at rest is unchanged. */
            pushTpd: (model, scroll, ops) => {
                if (model) out.push({ model, layer: OBJECT_LAYER, scroll, ops });
            },
            /* A draw the routine makes in the world's frame rather than the
             * arena's, on a layer of its own choosing — and optionally through
             * a texture header rebuilt every frame, as the river is. */
            pushWorld: (model, layer, ops, band = null) => {
                if (!model) return;
                const entry = { model, layer, ops: inWorld(ops) };
                if (band) entry.band = band;
                out.push(entry);
            },
        });
    }

    return out;
}

/** Short human-readable form of an op list, for the parts panel. */
export function describeOps(ops) {
    return ops.map(([kind, v]) => {
        if (kind === 'b') return 'billboard';
        if (kind === 'cy') return 'camera yaw';
        if (kind === 's') return `×${v.map((n) => n.toFixed(2)).join('/')}`;
        if (kind === 'r') return `${Math.round(v)}°`;
        if (kind === 'rx') return `${Math.round(v)}°x`;
        if (kind === 'rz') return `${Math.round(v)}°z`;
        return `@${v.map((n) => n.toFixed(1)).join(',')}`;
    }).join(' ');
}

/* `scenery` is a placement stage's one layer: its draws are all the same kind
 * of thing, a model where the table puts it. */
export const DISPLAY_LAYER_ORDER =
    ['sky', 'water', 'upper', 'ground', 'floor', 'platform', 'extra', 'cage', 'poles', 'objects', 'scenery'];

/* Layers the camera's framing bounds leave out. The backdrop, because it sits
 * hundreds of units past the arena; the objects, because they reach further
 * still — Giant Wing's clouds sweep six thousand units in and out, and framing
 * on those would leave the stage a speck. */
export const BACKDROP_LAYERS = new Set(['sky', 'water', 'objects']);
