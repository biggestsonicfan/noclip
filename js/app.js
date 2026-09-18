/*
 * app.js — entry point: ROM acquisition, the three view modes and the UI wiring.
 */

import { loadRomSet, readModelEntry, readModelName } from './romset.js';
import { GAMES } from './games.js';
import { decodeModel } from './model.js';
import { readStageTable, stageLight, gameLighting } from './stages.js';
import { readPlacementStages, buildPlacementDisplayList } from './placements.js';
import { coplanarLayers } from './layers.js';
import { buildSkyPanorama } from './scroll.js';
import {
    buildStageDisplayList, buildFlatDisplayList, describeOps, opsAt, frameModel, frameBand, frameScroll,
    scrollPeriod, readFrameTables,
    stageLightYaw, stageMaterials, stageWorldFrame,
    DISPLAY_LAYER_ORDER as LAYER_ORDER, BACKDROP_LAYERS,
} from './display.js';
import { CHARACTERS, readCharacter, faceVariantOwners, ACTION_SLOT_COUNT } from './characters.js';
import { buildPose, poseMatrices, viewerMatrix, skeletonLines, turnedBy,
    useCoproTrig, SLOT_COUNT, SLOT_NAMES, HEAD_SLOT } from './pose.js';
import { readOsage, osageParts, createOsageSim, stepOsage, settleOsage, NO_FLOOR } from './osage.js';
import {
    readTails, tailParts, PELVIS_SLOT as TAILS_PELVIS_SLOT, LEAD as TAILS_LEAD,
} from './tails.js';
import {
    readMechArms, readRoboHead, readRoboAnims, armModel, headFrame,
    BOSS_CHARS, MINION_CHARS, CHEST_SLOT as EGG_CHEST_SLOT,
    HEAD_SLOT as EGG_HEAD_SLOT, ARM_SHIFT, ARM_COUNT,
} from './eggrobo.js';
import {
    readExhaust, exhaustPart, chestModel, exhaustDrawn,
    CHEST_SLOT as EXHAUST_CHEST_SLOT, CYCLE_LENGTH as EXHAUST_CYCLE_LENGTH,
} from './exhaust.js';
import { decodeMotion, sampleMotion, listMotions } from './motion.js';
import {
    readBodies, readMotions, poseBody, bodySkeletonLines, frameBytes, rankMotions, partDraws, readSkin, skinMesh,
} from './bodies.js';
import { Viewer, buildGeometry, buildEdgeGeometry, boardDrawsFace, THREE } from './viewer.js';
import { isMobile, setMobile, wireSheet, wireTouchFly } from './mobile.js';
import { buildAtlas, classifyDump, palette555ToRGB, ATLAS_W, ATLAS_H, LUMA_W, LUMA_H, CXLAT_W, CXLAT_H, SHEET_BYTES } from './atlas.js';
import { buildTexram, bestTextureSet, bankTextureSet } from './texture.js';
import { buildLumaram, buildColorxlat, cycleStageColors, LUMA_BAND } from './colors.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
};

const state = {
    rom: null,
    /* The zips as they were handed over, so a build swap can assemble the set
     * again without asking for them twice — see switchBuild. */
    romBuffers: null,
    stages: [],
    viewer: null,
    /* The phone site's bottom sheet and noclip stick — see js/mobile.js. */
    sheet: null,
    touchFly: null,
    tab: 'stage',
    stageIndex: 0,
    modelIndex: 517,
    charIndex: 0,
    character: null,
    /* A game whose enemies are jointed bodies rather than a fighter roster —
     * see js/bodies.js. `travel` poses a motion along the path it carries
     * instead of on the spot, where the game draws it. */
    bodies: null,
    motionRanks: null,
    travel: false,
    useSquished: false,
    showSkeleton: true,
    /* Metal Sonic's jet. The board draws the flame whenever his chest object is
     * not one of the two closed ones, and the chest is swapped by an opcode in
     * the per-motion script — which the viewer does not run, so which chest he
     * stands in is a switch here. See js/exhaust.js. */
    jetExhaust: true,
    /* The fighter's motion. `frame` is the game's own: an integer that starts
     * at 1 and is stepped once a vsync until it passes the motion's length, so
     * it is derived from elapsed time the way the stage clock is. `slot` is
     * which of the 52 action slots the id came from, or -1 when browsing the
     * motion table directly.
     *
     * `tick` is the display counter beside it — the same clock, but not folded
     * back into the motion's length. Tails' tails run a 64-frame cycle of their
     * own that a shorter motion would otherwise never finish, so they are
     * stepped by this rather than by `frame`. The two move together: playing
     * derives both from elapsed time, and a scrub moves both by the same step,
     * so `tick` stays congruent to `frame - 1` and resuming does not jump. */
    motion: {
        id: 0, slot: 0, decoded: null, frame: 1, tick: 0, playing: true, start: 0,
        parts: [], skeleton: null, list: null,
    },
    layerOn: Object.fromEntries(LAYER_ORDER.map((k) => [k, true])),
    wireframe: false,
    modelCache: new Map(),
    /* The scroll layer's sky, decoded once per stage and kept. */
    sky: null,
    skyTextures: new Map(),
    skyPanoAspect: new Map(),
    skyTopColor: new Map(),
    /* The Models tab's texture picker, for a game with no stage table to name
     * a texture number. null is "work it out from the model"; a number is the
     * set the user chose. `texSetCache` memoises the worked-out answer. */
    texSetChoice: null,
    texSetCache: new Map(),
    /* For a game with no stage record: which scene colour block fills the
     * scene rows of colorxlat, which character's blocks fill the part and skin
     * rows, and the light vector, since none of the three is in a table the
     * viewer can read. -1 for the fighter leaves those rows at zero. */
    /* Whose part and skin colours to fill colorxlat's fighter rows with, for a
     * game the viewer has no roster for. A stage record does not say who is
     * standing in it, so it is a choice on the panel; -1 leaves those rows at
     * zero, which is what a scene with nobody in it shows. */
    colorFighter: 0,
    frames: null,       /* the animation frame tables, read once per ROM set */
    animate: true,
    /* Which of the two framings the moving stages are shown in — see
     * setWorldFrame. False stands the scene on the world, which is what a free
     * camera wants; true stands it on the arena, which is what the board does
     * and what reading a moving arena needs. */
    rideStage: false,
    /* Everything a stage animates is a pure function of the game's frame
     * counter, so the whole clock is one number. It is derived from elapsed
     * time rather than counted per rendered frame: the board ran at 60 Hz and
     * the palms should not sway 2.4x too fast on a 144 Hz monitor. */
    anim: {
        start: 0, frame: -1, entries: [], phases: [], geom: new Map(),
        /* Draws carrying a BILLBOARD op. They are kept apart from `entries`
         * because what moves them is the camera rather than the frame counter,
         * so they have to be stepped whether the stage is animating or not. */
        billboards: [],
    },
    cxlat: null,        /* colorxlat bytes, whether built or dumped */
    /* A dropped texture-RAM dump pins the sheets: it is a capture of one
     * moment in a real machine, so rebuilding per stage from ROM would throw
     * away what the user deliberately loaded. The two colour tables pin
     * separately, since a dump may hold the sheets and not them. */
    texramPinned: false,
    lutsPinned: false,
    texramKey: null,    /* which sets the current sheets were built from */
    modelScenes: null,  /* model -> the scenes that draw it; see modelScenes */
    rigOwners: null,    /* model -> the character carrying it; filled alongside */
    lutKey: null,       /* which scene the colour tables were built for */
    transfer: 0,        /* 0 = none, 1 = linear->gamma, 2 = gamma->linear */
    bgRGB: [0, 0, 0],   /* the stage backdrop, before any transfer */
};

/* ---- Colour transfer ------------------------------------------------------ */

/* The sRGB transfer function and its inverse, matching the shader's. The
 * backdrop is drawn by three.js rather than the fill shader, so switching
 * modes has to move it here or it would stay in the space the geometry left.
 * The fog colour is NOT transformed here — the shader does that one, and
 * doing it in both places would apply the curve twice. */
function applyTransfer(c, mode) {
    const f = (v) => {
        if (mode === 1) return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        if (mode === 2) return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        return v;
    };
    return c.map((v) => Math.min(Math.max(f(v), 0), 1));
}

function applyBackdropTransfer() {
    const bg = applyTransfer(state.bgRGB, state.transfer);
    state.viewer.scene.background = new THREE.Color()
        .setRGB(bg[0], bg[1], bg[2], THREE.SRGBColorSpace);
}

/* ---- ROM acquisition ----------------------------------------------------- */

/* The ROM set is supplied by the user, never fetched: the page has no idea what
 * is on the server and never asks for it. Zips are read with FileReader and
 * decoded in this tab, so nothing leaves the machine. */

function setStatus(msg, frac) {
    $('#loader-progress').hidden = false;
    $('#loader-status').textContent = msg;
    if (frac !== undefined) $('#loader-bar').style.width = `${Math.round(frac * 100)}%`;
}

async function bootWithBuffers(buffers) {
    $('#loader-error').hidden = true;
    /* Kept so a build swap can assemble the set again without asking for the
     * zips a second time — see switchBuild. */
    state.romBuffers = buffers;
    try {
        state.rom = await loadRomSet(buffers, (msg, frac) => setStatus(msg, frac));
        useCoproTrig(state.rom);
    } catch (err) {
        return failToLoad(err, romHint(err));
    }
    /* Kept separate from the ROM decode: a failure in here is a renderer
     * problem, and swapping to the app shell first would hide the message. */
    try {
        start();
    } catch (err) {
        return failToLoad(err, 'the ROM set loaded, but the 3D view could not start');
    }
}

/*
 * What to try next when a set will not load, which is two different things.
 *
 * If loadRomSet got as far as identifying the game, the zips are the right
 * game's and one of them is missing — a MAME set is not always one archive, and
 * a clone keeps only the chips that are its own, the rest being in the parent.
 * Naming the game and the chip is the whole of the answer there. If it did not,
 * nothing here recognised the program ROM, and the thing to say is what would
 * be recognised; the list comes off the profiles so it cannot go stale.
 */
function romHint(err) {
    if (err.game) {
        return `that chip is in another zip of this set — a MAME clone carries only `
            + `the chips that are its own and keeps the rest in the parent, so drop `
            + `the parent's zip on as well`;
    }
    return `check that these are the ROM zips of a game the viewer knows: `
        + `${GAMES.map((g) => g.name).join(', ')}`;
}

/*
 * Load the same zips as a different build.
 *
 * MAME keeps a game's revisions and its hacks as clones of one parent, and a
 * merged archive is all of them at once — Daytona USA is eight. Which one a
 * drop "is" has no single right answer there, so the set reports every profile
 * it matches and this swaps between them without the zips being handed over
 * again. Only what the build decides is rebuilt: the renderer, the canvas and
 * the wiring outlive the swap, so nothing is disposed and nothing is wired
 * twice.
 */
async function switchBuild(id) {
    if (!state.romBuffers || !state.rom || id === state.rom.game.id) return;
    $('#loader').hidden = false;
    $('#loader-error').hidden = true;
    try {
        state.rom = await loadRomSet(state.romBuffers, (m, f) => setStatus(m, f), { game: id });
        useCoproTrig(state.rom);
    } catch (err) {
        return failToLoad(err, romHint(err));
    }
    resetRomState();
    loadGameContent();
}

/*
 * Everything in `state` that is about the ROM set rather than about the page.
 *
 * All of it is indexed by, or decoded from, the build that was loaded — a model
 * cache keyed on a table index, sheets keyed on a texture number, the stage
 * list, the rig — so a swap has to throw the lot away. What survives is the
 * renderer, the panel's own switches and where the camera is pointing.
 */
function resetRomState() {
    state.stages = [];
    state.modelCache.clear();
    state.texSetCache.clear();
    state.skyTextures.clear();
    state.skyPanoAspect.clear();
    state.skyTopColor.clear();
    state.modelScenes = null;
    state.rigOwners = null;
    state.frames = null;
    state.bodies = null;
    state.motionRanks = null;
    state.motion.list = null;
    state.motion.decoded = null;
    state.motion.parts = [];
    state.motion.skeleton = null;
    state.sky = null;
    state.cxlat = null;
    state.texramKey = null;
    state.lutKey = null;
    /* A dropped texture-RAM dump is a capture of one build's RAM, so it does
     * not carry over to another. */
    state.texramPinned = false;
    state.lutsPinned = false;
    state.texSetChoice = null;
    state.stageIndex = 0;
    state.charIndex = 0;
    state.anim.frame = -1;
    state.anim.entries = [];
    state.anim.phases = [];
    state.anim.geom.clear();
    state.anim.billboards = [];
    state.viewer.clear();
    state.viewer.clearSetMaterials();
}

/*
 * The builds this archive could be loaded as, when there is more than one.
 *
 * Every Daytona build after 1993 carries a byte-identical model table and
 * palette — they differ in their program ROM and half a megabyte of data, not
 * in their models — so the list is longer than the number of distinct things
 * there are to look at. It names them anyway: which build a set is is a fact
 * about the set, and a picker that hid seven of them would be deciding for the
 * person which one they dropped.
 */
function renderBuildPicker() {
    const field = $('#build-field');
    if (!field) return;
    const variants = state.rom.variants ?? [];
    if (variants.length < 2) { field.hidden = true; return; }
    const sel = $('#build-select');
    sel.innerHTML = '';
    for (const v of variants) {
        const o = el('option');
        o.value = v.id;
        o.textContent = v.name;
        sel.appendChild(o);
    }
    sel.value = state.rom.game.id;
    if (!sel.dataset.wired) {
        sel.dataset.wired = '1';
        sel.addEventListener('change', () => switchBuild(sel.value));
    }
    field.hidden = false;
}

function failToLoad(err, hint) {
    console.error(err);
    $('#loader').hidden = false;
    $('#app').hidden = true;
    $('#loader-error').textContent = `${err.message || err} — ${hint}.`;
    $('#loader-error').hidden = false;
    $('#loader-progress').hidden = true;
    $('#loader-bar').style.width = '0';
}

async function readRomFiles(zips) {
    setStatus(`reading ${zips.map((f) => f.name).join(', ')}…`, 0);
    try {
        bootWithBuffers(await Promise.all(zips.map((f) => f.arrayBuffer())));
    } catch (err) {
        failToLoad(err, 'the file could not be read');
    }
}

/**
 * Route dropped files by what they are, not by where they landed.
 *
 * The drop target is the whole document, so once the viewer is up a dropped
 * texture dump used to be handed to the ROM loader, which discarded it for not
 * being a .zip and reported that onto the hidden loading screen — silently
 * doing nothing. Zips are the ROM set, anything else is a texture dump.
 */
function routeDroppedFiles(files) {
    const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
    const rest = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));

    if (!state.rom) {
        /* The file picker is disabled until the box is ticked, but a drop
         * bypasses it, so the gate is checked here too. */
        if (!$('#loader-ack').checked) {
            $('#loader-error').textContent =
                'Tick the acknowledgement above before loading a ROM set.';
            $('#loader-error').hidden = false;
            return;
        }
        if (zips.length) readRomFiles(zips);
        else {
            $('#loader-error').textContent = 'That is not a .zip — drop the ROM set archive.';
            $('#loader-error').hidden = false;
        }
        return;
    }

    if (rest.length) loadTexramFiles(rest);
    if (zips.length && !rest.length) {
        /* Re-initialising the whole viewer in place is more trouble than it is
         * worth; a reload is one keystroke. */
        $('#tex-status').textContent = 'ROM set already loaded — reload the page to switch it.';
    }
}

function wireDropTarget() {
    const drop = $('#loader-drop');

    /* Nothing is submitted anywhere — the gate is an acknowledgement, not a
     * transfer. Disabling the input is what stops the label from opening the
     * picker; the class is only how that reads. */
    const ack = $('#loader-ack');
    const applyAck = () => {
        $('#loader-file').disabled = !ack.checked;
        drop.classList.toggle('disabled', !ack.checked);
        if (ack.checked) $('#loader-error').hidden = true;
    };
    ack.addEventListener('change', applyAck);
    applyAck();

    /* Clearing the value matters: picking the same file twice does not fire a
     * change event otherwise, so a retry after a failure looks like the page
     * has stopped responding. */
    $('#loader-file').addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        routeDroppedFiles(files);
    });

    /* Drag anywhere on the page. The document-level dragover default has to be
     * cancelled or the browser navigates to the dropped file instead of handing
     * it over. */
    let dragDepth = 0;
    const hotTarget = () => (state.rom ? $('#tex-drop') : drop);
    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (dragDepth++ === 0) hotTarget().classList.add('hot');
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('dragleave', () => {
        if (--dragDepth <= 0) {
            dragDepth = 0;
            drop.classList.remove('hot');
            $('#tex-drop').classList.remove('hot');
        }
    });
    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        drop.classList.remove('hot');
        $('#tex-drop').classList.remove('hot');
        if (e.dataTransfer?.files?.length) routeDroppedFiles([...e.dataTransfer.files]);
    });
}

/* ---- Texture RAM ---------------------------------------------------------- */

/* These three textures must stay at the Texture default of NoColorSpace. None
 * of them holds a colour: the atlas is a 4-bit texel that indexes lumaram, and
 * the LUTs are integer-fetched. Tagging any of them SRGBColorSpace would apply
 * a transfer function to an index and read the wrong row. */
function makeDataTexture(data, w, h) {
    const t = new THREE.DataTexture(data, w, h, THREE.RedFormat);
    t.needsUpdate = true;
    return t;
}

/** Point the fill shader's atlas path at a pair of texture-RAM sheets. */
function setAtlasSheets(sheet0, sheet1) {
    const u = state.viewer.material.uniforms;
    const atlas = makeDataTexture(buildAtlas(sheet0, sheet1), ATLAS_W, ATLAS_H);
    atlas.magFilter = THREE.LinearFilter;
    atlas.minFilter = THREE.LinearFilter;
    u.uAtlas.value?.dispose?.();
    u.uAtlas.value = atlas;
    u.uUseAtlas.value = 1;
}

/* The sheets do not exist in ROM in a readable form — about 85% of the pages
 * are compressed — so the game unpacks them into texture RAM on every scene
 * change. js/texture.js is a port of the routines that do that, which means
 * the viewer can build the sheets a stage needs from the ROM alone. Verified
 * byte-for-byte against a MAME capture of texture RAM.
 *
 * A stage names two texture numbers and the game queues both. Set 16 goes in
 * first because the attract and character-select screens leave it resident,
 * and the stage sets do not overwrite its deepest mip levels — without it the
 * corner of the mip chain is blank rather than what the hardware holds. */
function useRomTexram(texSets) {
    /* Where a game ties its face palette to the texture set, the palette moves
     * with the set asked for — before the pinned and repeat checks, since a
     * dumped sheet says nothing about which palette is in RAM. */
    if (state.rom.game.palette && texSets.length) state.rom.paletteSet = texSets[texSets.length - 1];
    if (state.texramPinned) return;
    const key = texSets.join(',');
    if (key === state.texramKey) return;

    /* Which set sits behind the named ones is the game's own arrangement, so it
     * comes off the profile; a game with none named just gets what was asked. */
    const resident = state.rom.game.texture.residentSet;
    const queue = resident == null ? texSets : [resident, ...texSets];
    const { sheet0, sheet1 } = buildTexram(state.rom, queue);
    setAtlasSheets(sheet0, sheet1);
    state.texramKey = key;

    const status = $('#tex-status');
    if (status) {
        status.textContent = `sheets unpacked from ROM (sets ${texSets.join(', ')})`;
        status.title = 'js/texture.js — the game\'s own unpack routines, ported';
    }
}

/* Bind one pair of colour tables, however they were come by. Both are
 * integer-fetched, so they must stay unfiltered — which is what the Texture
 * default of NoColorSpace and nearest filtering give. */
function setLumaTables(luma, cxlat) {
    const u = state.viewer.material.uniforms;
    for (const name of ['uLuma', 'uCxlat']) u[name].value?.dispose?.();
    u.uLuma.value = makeDataTexture(luma, LUMA_W, LUMA_H);
    u.uCxlat.value = makeDataTexture(cxlat, CXLAT_W, CXLAT_H);
    u.uUseRamp.value = 1;
    state.cxlat = cxlat;
    $('#tex-luma-row').hidden = false;
}

/* The two colour tables are RAM as well, and the game fills them on every scene
 * change out of main_data. Without them a 4-bit texel has nowhere to become a
 * colour, and the fill path falls back to smearing the face's palette entry by
 * the texel — which for South Island's sea, palm fronds, waterfall and ring
 * floor means grey, because their palette entries genuinely are grey. The
 * colour those surfaces show on the board lives in the top sixteen luma slots
 * of colorxlat, and js/colors.js is the port of the routines that put it there.
 *
 * The tables are per scene: send_tex_col_stage picks its block of sixteen
 * colours with the stage record's second texture number, and stage_disp trims
 * every channel by stage_RED/GREEN/BLUE first.
 *
 * They are also per fighter. Five rows are the character's own colours and two
 * more are its skin, uploaded by send_tex_col_part and send_tex_col_skin for
 * whoever is on screen, and a face on a palette luma band reads them like any
 * other row — Eggman's lenses are row 0. No stage model names one, so a stage
 * on its own passes no fighter and those rows stay at zero, which is what a
 * scene with nobody in it holds.
 *
 * @param {object} stage      the stage whose sets and trim the tables take
 * @param {?number} fighter   the character on screen, as player 1
 */
function useRomColorLuts(stage, fighter = null) {
    const u = state.viewer.material.uniforms;
    if (state.lutsPinned) { u.uUseRamp.value = 1; return; }
    /* A game whose colour pipeline is not ported has no tables to build, and
     * without them the ramp would read zeros: shade flat on the palette. */
    if (!state.rom.game.colors || !stage) { u.uUseRamp.value = 0; return; }
    const key = `${stage.texSet[1]}:${stage.tint.join(',')}:${fighter}`;
    /* Still re-arm: the model and rig views turn the ramp off behind us. */
    if (key === state.lutKey) { u.uUseRamp.value = 1; return; }

    const luma = buildLumaram(state.rom);
    const cxlat = buildColorxlat(state.rom, {
        colorSet: stage.texSet[1],
        tint: stage.tint,
        fighters: fighter == null ? [] : [fighter],
    });
    setLumaTables(luma, cxlat);
    state.lutKey = key;
}

/*
 * The sheets and colour tables of one texture set, as a material of its own.
 *
 * A stage assembled out of every zone a chapter reaches draws parts loaded
 * under different sets (see the all-placements stage in js/placements.js), and
 * a set is what one texture RAM — and so one atlas — holds. Each is built the
 * way the scene's own is, by the game's unpack and table routines, and cached
 * on the viewer until the ROM changes. The face palette is not a uniform but
 * something the decode bakes in, so the caller sets `rom.paletteSet` to match
 * before it decodes the part.
 */
function materialForSet(set, stage) {
    const v = state.viewer;
    const key = `${set}:${stage.tint.join(',')}`;
    const have = v.setMaterials.get(key);
    if (have) return have;
    const resident = state.rom.game.texture.residentSet;
    const { sheet0, sheet1 } = buildTexram(state.rom, resident == null ? [set] : [resident, set]);
    const atlas = makeDataTexture(buildAtlas(sheet0, sheet1), ATLAS_W, ATLAS_H);
    atlas.magFilter = THREE.LinearFilter;
    atlas.minFilter = THREE.LinearFilter;
    /* Pinned tables are a capture of a real machine and stand for every part;
     * a game with no colour pipeline ported has none to build. */
    const cxlat = state.rom.game.colors && !state.lutsPinned
        ? makeDataTexture(buildColorxlat(state.rom, {
            colorSet: set, tint: stage.tint, fighters: [],
        }), CXLAT_W, CXLAT_H)
        : null;
    return v.setMaterial(key, { atlas, cxlat });
}

/* A dump is still accepted, and still wins: it captures one real moment of a
 * real machine, including whatever a previous scene left resident. */
async function loadTexramFiles(files) {
    const bins = [...files].filter((f) => !f.name.toLowerCase().endsWith('.zip'));
    if (!bins.length) return;
    const status = $('#tex-status');
    status.textContent = 'decoding sheets…';
    try {
        const parts = classifyDump(bins);
        const read = async (f) => (f ? new Uint8Array(await f.arrayBuffer()) : null);
        const [s0, s1, luma, cxlat] = await Promise.all(
            [parts.sheet0, parts.sheet1, parts.luma, parts.cxlat].map(read));

        /* A sheet shorter than 1 MB decodes to a blank atlas rather than
         * failing, so say so instead of reporting a successful load of
         * nothing. */
        if (!(s0?.length >= SHEET_BYTES) && !(s1?.length >= SHEET_BYTES)) {
            status.textContent =
                `no 1 MB texture sheet among those ${bins.length} file(s) — ` +
                'expected texram0 / texram1';
            return;
        }

        setAtlasSheets(s0, s1);
        state.texramPinned = true;
        /* The dump stands for every part of a mixed-set stage, so the sheets
         * built per set go — see materialForSet. */
        state.viewer.clearSetMaterials();

        /* A dump that brings both tables pins them too; one that brings only
         * the sheets leaves the ROM-built pair in place. */
        if (luma && cxlat) {
            setLumaTables(luma, cxlat);
            state.lutsPinned = true;
        }

        const loaded = [parts.sheet0, parts.sheet1, parts.luma, parts.cxlat]
            .filter(Boolean).map((f) => f.name);
        /* The backdrop is derived from colorxlat, so redraw once it is in. */
        if (state.tab === 'stage') loadStage(state.stageIndex, { keepCamera: true });

        $('#tex-drop').classList.add('loaded');
        status.textContent = state.lutsPinned
            ? `atlas + colour tables from the dump (${loaded.length} files)`
            : `atlas from the dump, colour tables still built from ROM`;
        status.title = loaded.join(', ');
    } catch (err) {
        console.error(err);
        status.textContent = `could not read that dump: ${err.message || err}`;
    }
}

/*
 * The draw list for the loaded stage.
 *
 * A game whose geometry is already in world space takes the flat builder; the
 * long one is about the transforms the other game's draw functions apply, and
 * there are none to apply here.
 */
function stageDisplayList(stage) {
    if (stage.placements) return buildPlacementDisplayList(stage);
    return state.rom.game.stageTable.flat
        ? buildFlatDisplayList(stage)
        : buildStageDisplayList(stage, state.frames);
}

/*
 * Whether the Models tab picks a model's sheets itself.
 *
 * A game whose stages name every texture set between them lets the stage that
 * draws a model decide. One whose stage records are flat and name a hundred
 * sets, or that has no stage table read at all, has to ask the model.
 */
function modelsPickTextures() {
    const t = state.rom.game.stageTable;
    return !t || !!t.flat;
}

/* ---- Colour and light for a game with no stage table --------------------- */

/* ---- Texture set for a lone model ---------------------------------------- */

/*
 * Which texture number to unpack for a model, when no stage record names one.
 *
 * `null` from the picker means work it out from the model; any other value is
 * the set the user chose and is used as given, including when it covers
 * nothing — seeing a model against the wrong sheets is a legitimate thing to
 * want to do while working out which sheets are the right ones.
 *
 * The answer is cached per model because the search walks every set's page
 * list, which is cheap but not free, and clicking down the list would repeat it
 * on every row.
 */
function modelTextureSet(idx) {
    if (state.texSetChoice !== null) return state.texSetChoice;
    if (state.texSetCache.has(idx)) return state.texSetCache.get(idx);
    /* A game that says which set each bank of its model table is drawn under
     * is taken at its word; see bankTextureSet for why tile coverage cannot
     * answer it there. */
    const banked = bankTextureSet(state.rom, idx);
    const found = banked === null
        ? bestTextureSet(state.rom, getModel(idx), state.rom.game.texture.sets)
        : { set: banked };
    /* Neither can answer for a game whose sheets are raw banks and which has no
     * table saying which bank goes with which set — Daytona USA, whose course
     * data is unread. It opens on the set its profile names and the picker
     * moves it. */
    const set = found ? found.set : (state.rom.game.texture.defaultSet ?? null);
    state.texSetCache.set(idx, set);
    return set;
}

/* ---- Model cache --------------------------------------------------------- */

/* How many entries the loaded game's model table has. Read through a call
 * rather than imported, because it is not known until a ROM set is in hand. */
function modelCount() {
    return state.rom ? state.rom.game.modelTable.count : 0;
}

/* A game whose face palette changes with the loaded set bakes different colours
 * into the same mesh under each, so the set is part of the key. */
function getModel(idx) {
    const key = state.rom.game.palette ? `${idx}@${state.rom.paletteSet ?? 0}` : idx;
    if (state.modelCache.has(key)) return state.modelCache.get(key);
    const m = decodeModel(state.rom, idx);
    state.modelCache.set(key, m);
    return m;
}

/* A draw whose texture points set_obj_tpd replaces gets a decode of its own,
 * under a key the model's own decode cannot take: the override is not always a
 * copy of what it replaces, so the two are different meshes. */
function getTpdModel(idx, points, tag = 'tpd') {
    const key = `${idx}:${tag}`;
    if (state.modelCache.has(key)) return state.modelCache.get(key);
    const m = decodeModel(state.rom, idx, points);
    state.modelCache.set(key, m);
    return m;
}

/* ---- Scene building ------------------------------------------------------ */

/*
 * Where the horizon and the thing behind it go in the draw order.
 *
 * A backdrop draw ignores the depth buffer (see backdropMaterial), so for it to
 * land over the horizon rather than under it the shells have to be submitted
 * first — which is what `shellFirst` asks for, and only a stage that has such a
 * draw asks. Reordering opaque draws that all test and write depth cannot change
 * the picture except where two of them tie exactly, and there it decides the
 * tie: the Flying Carpet, Dynamite Plant and Giant Wing each have about sixty
 * pixels of seam where a shell's lower edge meets the ground at the same depth.
 * Neither answer to a tie is the right one, but the stages that gain nothing
 * from the reorder should not be made to pay it either.
 */
const SHELL_ORDER = -2;
const BACKDROP_ORDER = -1;

/* The arena proper: what is stood on and the ring around it, which on the two
 * stages that fly is the part carried along rather than the part flown over —
 * the Flying Carpet's rug, its rope and corner posts, and Canyon Cruise's deck.
 * Everything else on those stages is the world going past. */
const ARENA_LAYERS = new Set(['platform', 'cage', 'poles']);

function addModelToScene(decoded, {
    layer = null, matrix = null, geom = null, backdrop = false, shellFirst = false,
    groundPlate = false, planeBias = 0, material = null,
} = {}) {
    const v = state.viewer;
    /* The ground plate takes the material that stands one step back, because
     * camera_init draws it before every other pass and so it is the one arena
     * surface the board lets everything else overwrite — see floorMaterial.
     * It is the draw that asks for it and not the layer it is filed under: the
     * `floor` layer is the sidebar's grouping, and the Final Eggman Boss files
     * a message panel there that camera_init never drew and that has nothing
     * standing in it to concede to.
     * The open water takes the one that stands the whole bound back, because
     * the board sorts it by a corner hundreds of units out and nothing in the
     * arena is modelled under it — see waterMaterial.
     * A draw that names a material of its own is one whose texture set is not
     * the scene's — see materialForSet. */
    const mesh = new THREE.Mesh(geom ? geom.mesh : buildGeometry(decoded),
        material ?? (backdrop ? v.backdropMaterial
            : groundPlate ? v.floorMaterial
                : layer === 'water' ? v.waterMaterial
                    : planeBias ? v.planeMaterials[planeBias]
                        : v.material));
    if (backdrop) mesh.renderOrder = BACKDROP_ORDER;
    else if (shellFirst && layer === 'sky') mesh.renderOrder = SHELL_ORDER;
    mesh.userData.layer = layer;
    mesh.userData.modelIndex = decoded.index;
    if (matrix) { mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix); }
    v.root.add(mesh);

    /* An animated draw always gets its wire overlay, even on a frame with no
     * edges to show, because there is nowhere to add one later. */
    let lines = null;
    const edges = geom ? geom.edges : (decoded.edges.length ? buildEdgeGeometry(decoded) : null);
    if (edges) {
        lines = new THREE.LineSegments(edges, v.edgeMaterial);
        lines.visible = state.wireframe;
        lines.userData.isWire = true;
        lines.userData.layer = layer;
        if (matrix) { lines.matrixAutoUpdate = false; lines.matrix.copy(matrix); }
        v.root.add(lines);
    }
    return { mesh, lines };
}

/* Each op post-multiplies, exactly as the coprocessor display list accumulates
 * 0x3800707 (scale) / 0x4800909 (ang_y) / 0x3000606 (translate). */
const OP_SCRATCH = new THREE.Matrix4();
function composeOps(out, ops) {
    out.identity();
    for (const [kind, v] of ops) {
        /* A billboard needs the camera, which composing does not have. It is
         * the identity here, which leaves the draw standing where it stands
         * unrotated — what the parts panel and the camera bounds want, and what
         * stepBillboards then replaces once a frame with the real thing. */
        if (kind === 'b') continue;
        if (kind === 's') OP_SCRATCH.makeScale(v[0], v[1], v[2]);
        else if (kind === 'r') OP_SCRATCH.makeRotationY((v * Math.PI) / 180);
        else if (kind === 'rx') OP_SCRATCH.makeRotationX((v * Math.PI) / 180);
        else if (kind === 'rz') OP_SCRATCH.makeRotationZ((v * Math.PI) / 180);
        else OP_SCRATCH.makeTranslation(v[0], v[1], v[2]);
        out.multiply(OP_SCRATCH);
    }
    return out;
}

/* Geometry for one frame of an animated draw, kept for the life of the stage.
 * A palm walks 32 models and a carpet flame 64, so each is decoded and uploaded
 * once rather than once a frame; a table is only paid for as it is reached. */
function frameGeometry(index) {
    let g = state.anim.geom.get(index);
    if (!g) {
        const d = getModel(index);
        g = d
            ? { mesh: buildGeometry(d), edges: buildEdgeGeometry(d) }
            : { mesh: new THREE.BufferGeometry(), edges: new THREE.BufferGeometry() };
        state.anim.geom.set(index, g);
    }
    return g;
}

function unionBounds(list, fallbackRadius = 20) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const d of list) {
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], d.bounds.min[a]);
            max[a] = Math.max(max[a], d.bounds.max[a]);
        }
    }
    if (!isFinite(min[0])) return { center: [0, 0, 0], radius: fallbackRadius };
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return {
        center,
        radius: Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]) || fallbackRadius,
    };
}

/* ---- Which scene a model belongs to -------------------------------------- */

/* Every model one display list draws. An animated draw contributes every frame
 * of its table, since any of them can be the one up. */
function modelsInDisplayList(list) {
    const out = new Set(list.map((e) => e.model));
    for (const e of list) if (e.anim) for (const m of e.anim.frames) out.add(m);
    out.delete(0);
    return out;
}

/*
 * Every mesh the Animation tab can put on screen: the sixteen parts in both
 * forms, the faces and eyes the face record names, the sway chains' segments,
 * Tails' sixty-four-pose cycle and Metal Sonic's eight plumes and open chest —
 * each against the character that carries it, the first in roster order where
 * more than one does.
 *
 * The character is not bookkeeping. Five rows of colorxlat are a fighter's own
 * colours, `send_tex_col_part` uploads whoever is on screen into them, and a
 * face on a palette luma band reads them: Eggman's lenses are row 0, which is
 * black until his block is in it. So a lone part has to say whose it is before
 * it can be shaded, and the roster answers that for 210 of the models the
 * scan finds with such a face.
 */
function rigModels() {
    const out = new Map();
    /* The roster and every table it leads to are one game's. Read against
     * another's ROMs the pointers land wherever they land, so a game without
     * them has no rig models rather than a mapful of wrong ones. */
    if (!state.rom.game.features.characters) return out;
    const add = (m, index) => { if (m && !out.has(m)) out.set(m, index); };
    for (const { index } of CHARACTERS) {
        const c = readCharacter(state.rom, index);
        if (!c) continue;
        for (const m of c.partsNormal) add(m, index);
        for (const m of c.partsSquished) add(m, index);
        for (const m of c.face.heads) add(m, index);
        for (const m of c.face.eyes) add(m, index);
        for (const chain of readOsage(state.rom, index)?.chains ?? []) {
            for (const seg of chain.segments) add(seg.model, index);
        }
        for (const m of readTails(state.rom, index)?.cycle ?? []) add(m, index);
        const jet = readExhaust(state.rom, index);
        for (const m of jet?.cycle ?? []) add(m, index);
        for (const m of jet?.bodies ?? []) add(m, index);
    }
    /* Read for the whole roster at once rather than per character: the variant
     * tables are indexed by character inside, and the roster's padding entries
     * would walk the same tables again. The roster's own parts are added first,
     * so a head both reach keeps the fighter that wears it. */
    for (const [m, c] of faceVariantOwners(state.rom)) add(m, c);
    out.delete(0);
    return out;
}

/* A fighter's part belongs to no one stage: its sheets are in set 1, which
 * every stage uploads, so they are resident whichever stage was loaded — the
 * board could not draw a fighter otherwise. */
const SCENE_ANY = -1;
/* The Models and Animation tabs draw against this rather than a stage backdrop:
 * a lone model is not standing in a scene, and saying so is the point. */
const NEUTRAL_BG = 0x0b0d12;

/*
 * Which scenes draw each model.
 *
 * The ramp reads a texel and looks it up, so it is only meaningful against the
 * sheets the same scene loaded. Sampling the atlas cannot answer which those
 * are: stages share page slots — that is why loading the wrong set replaces a
 * stage's scenery rather than leaving a hole — so a model whose pages were
 * never unpacked still finds another stage's texture sitting in them, and comes
 * out confidently wrong instead of obviously flat.
 *
 * What can be answered is which stage draws the model: then its pages are
 * exactly the ones that stage uploads, by construction. Asking that of the
 * loaded stage alone was too narrow — Giant Wing's floor is Giant Wing's floor
 * whichever stage happens to be up, and Giant Wing's sets are one ROM unpack
 * away. So the question is put to all sixteen at once. Sixteen display lists is
 * about two milliseconds, and it is asked once per ROM set.
 *
 * Two fifths of the models that carry geometry are covered, between the stages
 * and the rig. The rest are drawn by nothing the viewer runs — the attract
 * mode, the menus, the endings — and take the tables of whatever stage is up.
 * What the answer decides is which sheets and which tables a model is shaded
 * against, not whether it is shaded the way the board shades: every model goes
 * through the ramp, or two heads out of one family would be lit two different
 * ways side by side in the same list.
 */
function modelScenes() {
    if (state.modelScenes) return state.modelScenes;
    const owner = new Map();
    const add = (model, slot) => {
        if (owner.has(model)) owner.get(model).push(slot);
        else owner.set(model, [slot]);
    };
    state.stages.forEach((stage, slot) => {
        /* A view that mixes texture sets under one says nothing about which
         * set draws a model. */
        if (stage.mixedSets) return;
        for (const m of modelsInDisplayList(stageDisplayList(stage))) {
            add(m, slot);
        }
        /* The versions of a piece a stage leaves out are still its models. */
        for (const d of stage.alternates ?? []) {
            for (const m of d.cycle ?? [d.model]) if (m && !owner.get(m)?.includes(slot)) add(m, slot);
        }
    });
    /* Disjoint from the stages in this ROM set, so the order of the two passes
     * does not decide anything; `has` is here because nothing guarantees that. */
    state.rigOwners = rigModels();
    for (const m of state.rigOwners.keys()) if (!owner.has(m)) add(m, SCENE_ANY);
    state.modelScenes = owner;
    return owner;
}

/* Which fighter's colour rows a model should be read against: the character
 * that carries it, or the one the Animation tab has up for a model no fighter
 * claims. A model belonging to neither gets none, and its part rows stay at the
 * zero a scene with nobody in it leaves them. */
function modelFighter(idx) {
    modelScenes();
    const owner = state.rigOwners.get(idx);
    if (owner !== undefined) return owner;
    /* With no roster to say which fighter carries a part, the panel says. */
    if (state.rom.game.colors?.part && modelsPickTextures()) {
        return state.colorFighter >= 0 ? state.colorFighter : null;
    }
    return null;
}

/*
 * The uniforms a scene contributes to a face's colour: the geometry engine's
 * two lighting inputs, both straight out of the stage record — the light vector
 * camera_init builds and the 32 material slots set_material uploads — and the
 * pair the fill path scales its output by.
 *
 * stage_RED/GREEN/BLUE trim the colour tables themselves — chg_pol_color_req
 * applies them as it builds the ramp — so with tables built from ROM the trim
 * is already in the numbers the shader reads, and applying it again here would
 * square it. A dumped table arrives with it baked in too, but for whichever
 * stage was on screen when the dump was taken, so the uniform is still the only
 * way to tint the rest.
 */
function applyStageShading(stage) {
    const u = state.viewer.material.uniforms;
    u.uLight.value.set(...stage.light);
    for (let i = 0; i < stage.materials.length; i++) {
        u.uMaterial.value[i].set(stage.materials[i].diffuse, stage.materials[i].ambient);
    }
    u.uTint.value.set(...(state.lutsPinned ? stage.tint : [1, 1, 1]));
    u.uBright.value = stage.bright > 0 && stage.bright < 8 ? stage.bright : 1;
}

/*
 * Stand a lone model in the scene that draws it.
 *
 * With the scene's own sheets and tables in, the model is shaded the way the
 * stage that owns it shades it — which for Giant Wing's floor is a dark sea
 * under bright cloud rather than the near-white the flat approximation made of
 * it, and for Aurora Icefield's ground the reverse. Without them the flat
 * approximation at least shows the model's own palette colour rather than
 * another stage's texture read under this one's ramp.
 */
function useModelScene(idx) {
    const u = state.viewer.material.uniforms;
    u.uFogDensity.value = 0;
    state.viewer.scene.background = new THREE.Color(NEUTRAL_BG);

    const slots = modelScenes().get(idx);
    if (!slots || slots[0] === SCENE_ANY) {
        u.uTint.value.set(1, 1, 1);
        u.uBright.value = 1;
        /* A game that lights everything the same way needs no scene to say how. */
        const lit = gameLighting(state.rom);
        if (lit) {
            u.uLight.value.set(...lit.light);
            lit.materials.forEach((m, i) => u.uMaterial.value[i].set(m.diffuse, m.ambient));
        }
        /*
         * Which sheets to stand a model on that no stage draws.
         *
         * The other game answers this with the loaded stage, because every one
         * of its scenes holds the fighters' set. A game whose stages name a
         * hundred sets between them does not have that property, so the model
         * is asked instead: a face names a 32-pixel tile, and the set whose
         * pages cover those tiles is the one the game would have had resident.
         * The picker on the panel overrides it.
         */
        let set = null;
        if (modelsPickTextures()) {
            set = modelTextureSet(idx);
            if (set != null) useRomTexram([set]);
        }
        /* A fighter takes whichever scene is loaded, since every scene holds
         * its sheets. A model no scene claims takes it too, and for the same
         * reason the ramp exists: the colour it shows is not a colour but a row
         * of the colour table, and the ramp is the arithmetic that turns a row
         * into one. 2303 of the 4404 models that carry geometry name nothing
         * but rows — the flat stand-in below reads them as the greys they
         * literally are and doubles them into white, which is what left Bark's
         * second head, model 3554, a white blob beside model 2230, the same
         * head with its colours in the mesh. Whose tables they are read
         * against is a separate question, and the panel says which. */
        /* The sheets stay whichever stage is loaded — every scene holds set 1 —
         * but the fighter rows of the colour table do not: they are the
         * character's, and a part read without them shows black where its own
         * palette should be. */
        /* Where one set number is the sheets, the palette and the colour tables
         * at once, the tables are the set just picked for the sheets, whatever
         * stage is up — building them from the loaded stage would read a model
         * against another set's colours. A game with colour tables and no stage
         * table has the same answer for want of any other. */
        const ownSet = set != null && state.rom.game.colors
            ? { texSet: [set, set], tint: [1, 1, 1] } : null;
        const scene = state.rom.game.palette
            ? ownSet
            : state.stages[state.stageIndex] ?? ownSet;
        useRomColorLuts(scene, modelFighter(idx));
        u.uUseRamp.value = state.cxlat && scene ? 1 : 0;
        return;
    }
    /* Several stages draw some of these — South Island's chunks are on three
     * slots. Staying on the loaded one keeps clicking a part to identify it
     * from swapping the sheets out from under the stage it was clicked in. */
    const stage = state.stages[
        slots.includes(state.stageIndex) ? state.stageIndex : slots[0]];
    useRomTexram(stage.texSets);
    useRomColorLuts(stage, null);
    applyStageShading(stage);
}

/*
 * The scroll layer's sky, on a cylinder round the arena.
 *
 * A game that keeps its sky as a tilemap rather than as models gets it here —
 * see js/scroll.js for the decode. The panorama is 576 tiles round where the
 * hardware shows 64 of them, so the strip is a full turn and goes on a cylinder
 * at that scale: turning the camera walks it exactly as the scroll registers
 * walk the tilemap.
 *
 * Vertically it is an estimate and not the board's arithmetic. The board draws
 * the layer in screen space at one tile to eight pixels, so how much sky is in
 * frame depends on the projection rather than on anything in the data. The
 * height below puts the panorama's foot on the horizon and scales the rest by
 * the same pixels-per-degree the horizontal mapping implies, which lands the
 * cloud band where the captures put it.
 */
const SKY_RADIUS = 600;

function addSkyPanorama(slot) {
    const v = state.viewer;
    if (!state.rom.game.stageTable.scroll) return;

    state.sky = null;
    let tex = state.skyTextures.get(slot);
    if (tex === undefined) {
        const pano = buildSkyPanorama(state.rom, slot);
        /* Not makeDataTexture: that one is for the single-channel lookup
         * tables the fill shader reads, and this is an image. */
        tex = pano
            ? new THREE.DataTexture(pano.rgba, pano.width, pano.height, THREE.RGBAFormat)
            : null;
        if (tex) {
            /* The panorama's first row is the top of the sky, and a DataTexture
             * puts its first row at the bottom unless told otherwise. */
            tex.flipY = true;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearFilter;
            tex.wrapS = THREE.RepeatWrapping;
            tex.needsUpdate = true;
            state.skyPanoAspect.set(slot, pano.height / pano.width);
            state.skyTopColor.set(slot, pano.topColor.map((c) => c / 255));
        }
        state.skyTextures.set(slot, tex);
    }
    if (!tex) return;

    /* One turn across, and the same pixels-per-radian up. */
    const aspect = state.skyPanoAspect.get(slot);
    const height = 2 * Math.PI * SKY_RADIUS * aspect;
    const geom = new THREE.CylinderGeometry(
        SKY_RADIUS, SKY_RADIUS, height, 64, 1, true);
    const mat = new THREE.MeshBasicMaterial({
        map: tex, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = BACKDROP_ORDER;
    mesh.userData.layer = 'sky';
    mesh.frustumCulled = false;
    v.root.add(mesh);
    state.sky = { mesh, height };
    stepSky();
}

/*
 * Keep the sky at infinity.
 *
 * The board draws this layer in screen space, so its horizon is wherever the
 * camera is looking level — it does not come nearer or go by as the camera
 * moves through the arena. A cylinder standing in the world would do both, so
 * it is carried on the camera instead, with the foot of the strip on the eye
 * line. That is the same thing a skybox does, and here it is not a convention
 * but the behaviour being reproduced.
 */
function stepSky() {
    const sky = state.sky;
    if (!sky) return;
    const c = state.viewer.camera;
    sky.mesh.position.set(c.position.x, c.position.y + sky.height / 2, c.position.z);
}

/* ---- Stage view ---------------------------------------------------------- */

function loadStage(slot, { keepCamera = false } = {}) {
    const v = state.viewer;
    const stage = state.stages[slot];
    if (!stage) return;
    state.stageIndex = slot;
    resetStageAnimation();
    v.clear();

    /* Same two sets change_scene hands to send_tex_stage, unpacked from ROM,
     * and the colour tables the same scene change fills. */
    useRomTexram(stage.texSets);
    useRomColorLuts(stage, null);
    addSkyPanorama(slot);

    const list = stageDisplayList(stage);
    const visible = [];   /* everything but the sky shells frames the camera */
    const drawn = [];     /* and everything at all, which the far plane covers */
    /* And the arena on its own — the surface fought on and the ring round it.
     * On the two stages that move, this is the part that comes to rest when the
     * board's framing is up, so it is what `ride the carpet` frames on. The
     * world's own draws are no use for that: the desert is six hundred units
     * across and framing on it would leave the carpet a speck. */
    const arena = [];
    /* Only a stage with something behind the horizon needs the shells ordered
     * ahead of the rest — see SHELL_ORDER. */
    const shellFirst = list.some((e) => e.backdrop);
    const counts = {};
    const totals = {};
    for (const layer of LAYER_ORDER) { counts[layer] = 0; totals[layer] = 0; }

    const m = new THREE.Matrix4();
    const layered = [];
    /* A stage whose parts are loaded under different texture sets draws each
     * under its own — sheets, colour tables and face palette (materialForSet).
     * A pinned dump is one machine's texture RAM and stands for all of them. */
    const perPart = stage.mixedSets && !state.texramPinned;
    const sceneSet = state.rom.paletteSet;
    const partSets = new Set();
    for (const entry of list) {
        totals[entry.layer]++;
        const partMaterial = perPart && entry.set != null ? materialForSet(entry.set, stage) : null;
        if (partMaterial) { state.rom.paletteSet = entry.set; partSets.add(entry.set); }
        const d = entry.scroll?.points
            ? getTpdModel(entry.model, entry.scroll.points)
            : getModel(entry.model);
        if (!d) continue;
        composeOps(m, opsAt(entry, 0));

        /* A draw that moves gets its geometry from the frame cache from the
         * start, so swapping a frame in is a pointer assignment. */
        const moves = Boolean(entry.anim || entry.band || entry.scroll) ||
            typeof entry.ops === 'function';
        const geom = entry.anim ? frameGeometry(entry.model) : null;
        const { mesh, lines } = addModelToScene(d, {
            layer: entry.layer, matrix: m, geom, backdrop: entry.backdrop, shellFirst,
            groundPlate: entry.groundPlate,
            planeBias: entry.planeBias,
            material: partMaterial,
        });
        /* buildGeometry hands the decoder's own array straight to the attribute,
         * so a draw whose header is rewritten per frame takes a copy first —
         * otherwise it would write a band into the shared decode and every
         * later view of that model would show it. */
        if (entry.band) {
            mesh.geometry.setAttribute('aLumaBase',
                new THREE.BufferAttribute(Float32Array.from(d.lumaBases), 1));
        }
        /* And the same for a texture-point override, which rewrites the UVs. */
        if (entry.scroll) {
            mesh.geometry.setAttribute('aTexel',
                new THREE.BufferAttribute(Float32Array.from(d.uvs), 2));
        }
        mesh.visible = state.layerOn[entry.layer] !== false;
        layered.push({ decoded: d, matrix: m.clone().elements, mesh, entry });
        counts[entry.layer]++;
        const box = transformedBounds(d, m);
        drawn.push(box);
        if (!BACKDROP_LAYERS.has(entry.layer)) visible.push(box);
        if (ARENA_LAYERS.has(entry.layer)) arena.push(box);
        /* The decoded UVs stay the offset's origin: the copy above is written
         * from them every frame rather than walked on from where it stands. */
        if (moves) {
            state.anim.entries.push({
                entry, mesh, lines, model: entry.model,
                uvs: entry.scroll ? d.uvs : null,
            });
        }
        if (opsAt(entry, 0).some((op) => op[0] === 'b')) {
            state.anim.billboards.push({ entry, mesh, lines });
        }
    }
    /* Back to the scene's own set, which is what the Models tab and anything
     * else decoding after this expects to be loaded. */
    state.rom.paletteSet = sceneSet;
    if (partSets.size) {
        const status = $('#tex-status');
        const sets = [...partSets].sort((a, b) => a - b).join(', ');
        if (status) status.textContent = `sheets unpacked from ROM (sets ${sets}, one per part)`;
    }
    applyFaceLayers(layered);
    applyWireVisibility();

    const u = v.material.uniforms;
    /* The light, the material slots and the two output scales, which between
     * them replace the ambient/diffuse guesswork the viewer used to shade with.
     * The Models tab applies the same four from the stage a model belongs to. */
    applyStageShading(stage);
    /* And the slots the stage rewrites as it runs, at the frame it opens on. */
    stepStageMaterials(0);
    u.uFogDensity.value = 0;
    /* Both the clear colour and the fog tint are flat palette colours, so they
     * take the same colorxlat path a face does.
     *
     * The explicit SRGBColorSpace is load-bearing. THREE.Color is asymmetric:
     * setHex defaults to SRGBColorSpace, but setRGB — which the three-float
     * constructor routes to — defaults to the working space, i.e. linear. So
     * passing display-referred floats without the tag leaves three to encode
     * them a second time on output, which is what made this backdrop
     * rgb(0,120,240) instead of rgb(0,0,184). */
    /*
     * The backdrop, which is whatever shows where the sky does not reach.
     *
     * A game whose sky is a tilemap band has the answer in the band itself:
     * addSkyPanorama takes the commonest colour along its top row, which is
     * what the sky is doing where it runs out, and it is per stage. Falling
     * back to the profile's boot-time constant covers a stage whose panorama
     * would not decode; falling back to the record's own field is the other
     * game, where the backdrop is a field and there is no tilemap at all.
     */
    const top = state.skyTopColor.get(slot);
    if (top) {
        state.bgRGB = top;
    } else {
        const bg555 = state.rom.game.stageTable.backdrop ?? stage.bgColor555;
        state.bgRGB = palette555ToRGB(state.cxlat, bg555);
    }
    applyBackdropTransfer();
    /* Left untransformed on purpose: the fill shader applies the transfer to
     * this uniform itself, so the surface and the fog it blends into stay in
     * one space. Transforming it here too would run the curve twice. */
    u.uFogColor.value.set(...state.bgRGB);

    /* The arena's own bounds, in the board's frame — which is the frame it is
     * shown in whenever `ride the carpet` is up, since that is the framing
     * where it stands still. Kept for the toggle rather than recomputed. */
    state.stageArena = arena.length ? unionBounds(arena) : null;

    /* Stand the scene in the world's frame before framing the camera on it, so
     * a stage whose arena moves is not framed on where its arena was. */
    const worldFrame = setWorldFrame(0);

    /* The far plane has to cover everything the stage draws, not just what the
     * camera framed on — see setReach. Set before the framing, so the framing's
     * own far plane is pushed out with it. */
    const reach = unionBounds(drawn.length ? drawn : visible);
    const rc = new THREE.Vector3(...reach.center).applyMatrix4(worldFrame);
    v.setReach([rc.x, rc.y, rc.z], reach.radius);

    if (!keepCamera) {
        /* Frame the scenery but not the backdrop layers: those sit hundreds of
         * units out and would shrink the arena to a few pixels. */
        const b = unionBounds(visible.length ? visible : [{ bounds: { min: [-25, 0, -25], max: [25, 15, 25] } }]);
        /* The bounds were taken from the draw matrices, which are in the board's
         * frame; the scene is shown in the world's. */
        const c = new THREE.Vector3(...b.center).applyMatrix4(worldFrame);
        v.frame([c.x, c.y, c.z], b.radius, { fly: true, dir: [0.45, 0.36, 0.72] });
    }

    /* Two stages can share a colour table — South Island and its two alternates
     * all name texture set 0 — in which case useRomColorLuts leaves the one
     * already built in place, rotation and all. Put it back to phase 0, which
     * is what buildColorxlat would have written. */
    stepStageColors(0);

    renderStagePanel(stage, counts, totals, list);
    updateHud();
}

/* ---- Stage animation ------------------------------------------------------
 *
 * The board animates a stage by swapping which model a draw names, once per
 * frame, out of a table in the program ROM — the palms sway through 32 poses,
 * the Flying Carpet's floor ripples through 64, its ring rope and corner flames
 * likewise, and the Final Eggman Boss's fence strobes. A few draws also move
 * their transform: the flames pulse a quarter over size on alternate frames and
 * the backdrop ring drifts.
 *
 * Four things are not model swaps. The backdrop drift is just an op that reads
 * the frame. The palette rows sub_2435C rotates once a frame are what make
 * South Island's waterfall and its shoreline run. The sea proper is a
 * texture-header override: its faces are handed a different lumabase every
 * other frame, which walks them along the rotated bands of luma RAM. And Aurora
 * Icefield's curtain is a texture-*point* override, which slides the texture
 * along the faces instead of the faces along the bands.
 */

/* The board's frame rate — the unit every frame table is indexed in. */
const GAME_HZ = 60;
const ANIM_SCRATCH = new THREE.Matrix4();
const FRAME_SCRATCH = new THREE.Matrix4();

/*
 * Which frame the scene is shown in.
 *
 * The board draws the Flying Carpet from the carpet's frame — the arena still,
 * the desert wheeling past — because its camera rides the carpet. Here the
 * camera goes where it likes, so the desert is the thing worth standing on and
 * the carpet is the thing that should fly. The two framings differ by one rigid
 * transform, the prologue every world-space draw already carries, so the whole
 * scene hangs on its inverse: the world's draws cancel it and come to rest, the
 * arena's pick it up and orbit. No draw is rebuilt and nothing moves relative
 * to anything else — it is the same stage, seen from the sand instead of the rug.
 *
 * `rideStage` is the other half of that sentence, and costs nothing to offer
 * because the transform is already here: leave the root at the identity and the
 * prologue stands where the ROM put it, so the arena comes to rest and the
 * world wheels — the board's own framing exactly. A moving arena held still is
 * the only way to read one: the carpet flies its circle every 2048 frames and
 * a fixed camera cannot hold it, so its ripple can be watched from one angle
 * rather than chased. Which framing is up decides nothing about the stage — it
 * is one rigid transform either way, and `opt-ride` carries the camera across
 * it so the picture does not jump at the moment it is switched.
 */
function setWorldFrame(frame) {
    const v = state.viewer;
    const stage = state.stages[state.stageIndex];
    const ops = stage ? stageWorldFrame(stage, frame, state.frames) : null;
    if (ops && !state.rideStage) composeOps(FRAME_SCRATCH, ops).invert();
    else FRAME_SCRATCH.identity();
    v.root.matrix.copy(FRAME_SCRATCH);
    v.root.matrixWorldNeedsUpdate = true;
    return FRAME_SCRATCH;
}

/** Whether this stage has a prologue at all, and so whether riding it means anything. */
function stageMoves(stage) {
    return Boolean(stage && stageWorldFrame(stage, 0, state.frames));
}

/*
 * Switch framings, carrying the camera across.
 *
 * The two differ by one rigid transform, so a point that stood at `p` under the
 * old root stands at `D · p` under the new one for `D = new · old⁻¹`. Putting
 * that same `D` through the camera and the orbit target leaves every pixel
 * where it was, and what changes from the next frame on is only which half of
 * the pair is the one that moves. That is the whole of switching it off: you
 * are put back on the sand looking at what you were looking at.
 *
 * Switching it *on* is a request to look at the thing that has just come to
 * rest, so the camera is then framed on the arena — but from the direction the
 * delta has just carried it to, so the angle is the one being looked from
 * rather than an arbitrary one. Without that the toggle leaves you aimed at
 * wherever the world happened to be, which on the Flying Carpet is the oasis
 * sixty units away, wheeling.
 */
const RIDE_EYE = new THREE.Vector3();
/* What the arena is, on the stages that carry a prologue, so the checkbox names
 * the thing it is about to hold still. Giant Wing's prologue is a roll and
 * nothing else, so there is no vehicle there to name. */
const RIDE_LABEL = { 1: 'ride the carpet', 4: 'ride the boat' };

const RIDE_OLD = new THREE.Matrix4();
const RIDE_DELTA = new THREE.Matrix4();
const RIDE_TURN = new THREE.Quaternion();
function setRideStage(on) {
    state.rideStage = on;
    const v = state.viewer;
    RIDE_OLD.copy(v.root.matrix);
    const frame = state.anim.frame > 0 ? state.anim.frame : 0;
    RIDE_DELTA.copy(setWorldFrame(frame)).multiply(RIDE_OLD.invert());
    v.camera.position.applyMatrix4(RIDE_DELTA);
    v.camera.quaternion.premultiply(RIDE_TURN.setFromRotationMatrix(RIDE_DELTA));
    v.orbit.target.applyMatrix4(RIDE_DELTA);
    /* The fly rig keeps its own yaw and pitch and would snap the camera back to
     * them on the next update, so it takes the turn the delta just made. */
    v.fly.syncFromCamera();
    v.orbit.update();

    const a = on ? state.stageArena : null;
    if (!a) return;
    RIDE_EYE.copy(v.camera.position).sub(new THREE.Vector3(...a.center));
    if (RIDE_EYE.lengthSq() < 1e-6) RIDE_EYE.set(0.55, 0.42, 0.75);
    RIDE_EYE.normalize();
    v.frame(a.center, a.radius, { dir: [RIDE_EYE.x, RIDE_EYE.y, RIDE_EYE.z] });
}

/* Drop the animation state, and the frames it decoded, whenever the scene is
 * torn down — the other two views clear the same root. */
function resetStageAnimation() {
    const a = state.anim;
    for (const g of a.geom.values()) { g.mesh.dispose(); g.edges.dispose(); }
    a.geom.clear();
    a.entries = [];
    a.billboards = [];
    a.phases = [];
    a.start = performance.now();
    a.frame = -1;
}

/*
 * Point every billboard draw at the camera, once per rendered frame.
 *
 * The op splits its own list: what comes before it has been applied by the time
 * the coprocessor reads it, and only the position that has reached survives —
 * the rotation is thrown away and the view's put there instead — after which
 * the rest of the list goes on as usual. So the matrix is (position so far) x
 * (camera rotation) x (the ops after the op), rebuilt here rather than when the
 * stage was built, because the camera was not standing anywhere in particular
 * then and does not stay where it was put now.
 */
const BB_HEAD = new THREE.Matrix4();
const BB_TAIL = new THREE.Matrix4();
const BB_POS = new THREE.Vector3();
const BB_ONE = new THREE.Vector3(1, 1, 1);
function stepBillboards() {
    const list = state.anim.billboards;
    if (!list.length) return;
    const camera = state.viewer.camera;
    camera.updateMatrixWorld();
    for (const it of list) {
        const ops = opsAt(it.entry, state.anim.frame > 0 ? state.anim.frame : 0);
        const at = ops.findIndex((op) => op[0] === 'b');
        composeOps(BB_HEAD, ops.slice(0, at));
        composeOps(BB_TAIL, ops.slice(at + 1));
        BB_POS.setFromMatrixPosition(BB_HEAD);
        BB_HEAD.compose(BB_POS, camera.quaternion, BB_ONE);
        it.mesh.matrix.multiplyMatrices(BB_HEAD, BB_TAIL);
        if (it.lines) it.lines.matrix.copy(it.mesh.matrix);
    }
}

/** Advance every animated draw on this stage to whatever frame we are on. */
function stepStageAnimation(now) {
    const a = state.anim;
    const frame = Math.max(0, Math.floor(((now - a.start) / 1000) * GAME_HZ));
    if (frame === a.frame) return;
    a.frame = frame;

    for (const it of a.entries) {
        const { entry } = it;
        if (entry.anim) {
            const model = frameModel(entry.anim, frame);
            if (model !== it.model) {
                it.model = model;
                const g = frameGeometry(model);
                it.mesh.geometry = g.mesh;
                if (it.lines) it.lines.geometry = g.edges;
            }
            /* A frame table can name model 0 — the fence's dark frames are the
             * zero halves of its longs — and that draws nothing. Set every
             * frame, not just on a change, so a layer toggled back on cannot
             * leave a dark frame showing. */
            it.mesh.visible = model !== 0 && state.layerOn[entry.layer] !== false;
        }
        if (entry.band) {
            /* set_obj_thd's override covers every face of the model — the quad
             * count in the table is the model's face count — so the whole
             * attribute takes the band. */
            const v = frameBand(entry.band, frame) * LUMA_BAND;
            if (v !== it.band) {
                it.band = v;
                const a = it.mesh.geometry.getAttribute('aLumaBase');
                a.array.fill(v);
                a.needsUpdate = true;
            }
        }
        if (entry.scroll) {
            /* tpd_move offsets every texture point in the block, and the block
             * is the whole model's, so this is one slide of the UV attribute.
             * The attribute is (u, v) pairs, so which half of each takes the
             * offset is which short of the point the request fills in. */
            const dv = frameScroll(entry.scroll, frame);
            if (dv !== it.scroll) {
                it.scroll = dv;
                const a = it.mesh.geometry.getAttribute('aTexel');
                const first = entry.scroll.axis === 'u' ? 0 : 1;
                for (let i = first; i < a.array.length; i += 2) a.array[i] = it.uvs[i] + dv;
                a.needsUpdate = true;
            }
        }
        if (typeof entry.ops === 'function') {
            composeOps(ANIM_SCRATCH, entry.ops(frame));
            it.mesh.matrix.copy(ANIM_SCRATCH);
            if (it.lines) it.lines.matrix.copy(ANIM_SCRATCH);
        }
    }

    setWorldFrame(frame);
    stepStageColors(frame);
    stepStageLight(frame);
    stepStageMaterials(frame);
}

/*
 * The material slots the stage rewrites, at this frame.
 *
 * Only Canyon Cruise does, and what it rewrites is the boat's own lighting
 * rather than the canyon's — see stageMaterials. The record's own values are
 * uploaded when the stage is built, and only the slots that differ are written
 * over the top, once a frame.
 */
function stepStageMaterials(frame) {
    const stage = state.stages[state.stageIndex];
    const slots = stage ? stageMaterials(stage, frame, state.frames) : null;
    if (!slots) return;
    const u = state.viewer.material.uniforms.uMaterial.value;
    for (const { slot, diffuse, ambient } of slots) u[slot].set(diffuse, ambient);
}

/*
 * The stage light, at this frame.
 *
 * Only the Flying Carpet moves it, and it moves it to stand still: the angle it
 * rewrites is the one the light is built in the stage's own frame from, so
 * taking the carpet's heading back out again is what leaves the sun where it is
 * in the world. Rebuilt from the record each time rather than rotated in place,
 * because that is the arithmetic camera_init does.
 */
function stepStageLight(frame) {
    const stage = state.stages[state.stageIndex];
    const yaw = stage ? stageLightYaw(stage, frame, state.frames) : null;
    if (yaw === null) return;
    state.viewer.material.uniforms.uLight.value.set(
        ...stageLight(stage.bright, stage.vecter[0], yaw));
}

/*
 * The palette rows sub_2435C rewrites, at this frame's rotation.
 *
 * A dropped colour-table dump pins the tables: it is one real moment of a real
 * machine, so it is left exactly as captured rather than having rows rebuilt
 * from ROM over the top of it.
 */
function stepStageColors(frame) {
    const stage = state.stages[state.stageIndex];
    const cycles = stage?.colorCycles ?? [];
    if (state.lutsPinned || !cycles.length || !state.cxlat) return;

    let dirty = false;
    cycles.forEach((c, i) => {
        const phase = (frame >>> c.shift) & 15;
        if (phase === state.anim.phases[i]) return;
        state.anim.phases[i] = phase;
        cycleStageColors(state.rom, state.cxlat, {
            colorSet: stage.texSet[1], tint: stage.tint, row: c.row, phase,
        });
        dirty = true;
    });
    if (dirty) state.viewer.material.uniforms.uCxlat.value.needsUpdate = true;
}

/* Axis-aligned bounds of a decoded model after a display-list matrix, for
 * camera framing. Corner-transforming the box is enough here: it is exact for
 * the scales, quarter turns and translations most draws carry, and merely loose
 * for the Flying Carpet's arbitrary heading. */
function transformedBounds(d, matrix) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const p = new THREE.Vector3();
    for (let c = 0; c < 8; c++) {
        p.set(
            (c & 1) ? d.bounds.max[0] : d.bounds.min[0],
            (c & 2) ? d.bounds.max[1] : d.bounds.min[1],
            (c & 4) ? d.bounds.max[2] : d.bounds.min[2],
        ).applyMatrix4(matrix);
        const v = [p.x, p.y, p.z];
        for (let a = 0; a < 3; a++) {
            if (v[a] < min[a]) min[a] = v[a];
            if (v[a] > max[a]) max[a] = v[a];
        }
    }
    return { bounds: { min, max } };
}

/*
 * Put each face lying on another in its plane over it, for a game whose art
 * depends on that (see js/layers.js). The layers are for the draws as they
 * stand when the scene is built; a draw that swaps models through a cycle takes
 * the first frame's, which every frame of such a cycle shares the shape of --
 * the depth planes only where a frame's points are the first frame's, since a
 * face that has moved off its plane would be drawn at a depth it is not at.
 */
function applyFaceLayers(draws) {
    if (!state.rom.game.depth?.layers || !draws.length) return;
    const layers = coplanarLayers(draws);
    draws.forEach(({ mesh, entry, decoded }, i) => {
        const { layer, plane } = layers[i];
        const set = (geometry, d) => {
            if (d.positions.length / 3 !== layer.length) return;
            geometry.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
            const still = d === decoded || d.positions.every((v, k) => Math.abs(v - decoded.positions[k]) < 1e-3);
            if (still) geometry.setAttribute('aPlane', new THREE.BufferAttribute(plane, 4));
            else geometry.deleteAttribute('aPlane');
        };
        set(mesh.geometry, decoded);
        for (const frame of entry?.anim?.frames ?? []) {
            const d = getModel(frame);
            if (d) set(frameGeometry(frame).mesh, d);
        }
    });
}

/* ---- Model view ---------------------------------------------------------- */

function loadModel(idx, { keepCamera = false } = {}) {
    const v = state.viewer;
    state.modelIndex = idx;
    resetStageAnimation();
    v.clear();

    /* The scene first: where the palette follows the texture set, the set it
     * picks is what the decode's colours come from. */
    useModelScene(idx);
    const d = getModel(idx);
    if (d) {
        const { mesh } = addModelToScene(d);
        applyFaceLayers([{ decoded: d, matrix: new THREE.Matrix4().elements, mesh }]);
        applyWireVisibility();
        if (!keepCamera) v.frame(d.bounds.center, d.bounds.radius);
    }
    renderModelInfo(idx, d);
    updateHud();
}

/* ---- Character rig view -------------------------------------------------- */

function loadCharacter(charIndex, { keepCamera = false, keepMotion = false } = {}) {
    if (state.bodies) return loadBody(charIndex, { keepCamera, keepMotion });
    state.charIndex = charIndex;
    const c = readCharacter(state.rom, charIndex);
    state.character = c;

    /* Each fighter's action table maps the same slot to its own motion id, so
     * holding the slot across a change of character shows the same move. */
    const m = state.motion;
    const slot = keepMotion && m.slot >= 0 ? m.slot : 0;
    if (!m.list) m.list = listMotions(state.rom);
    if (keepMotion && m.slot < 0) setMotion(m.id, -1, { rebuild: false });
    else setMotion(c.motions[slot], slot, { rebuild: false });

    rebuildRig({ keepCamera });
    renderAnimPanel();
    updateHud();
}

/** Point the rig at a motion id, from an action slot or from the table itself. */
function setMotion(id, slot, { rebuild = true } = {}) {
    const m = state.motion;
    m.id = id;
    m.slot = slot;
    m.decoded = state.bodies ? m.list[id] ?? null : decodeMotion(state.rom, id);
    m.frame = 1;
    m.tick = 0;
    m.start = performance.now();
    if (rebuild) { poseRig(); renderMotionPanel(); updateHud(); }
}

/*
 * Decode and upload every entry of a baked cycle — Tails' sixty-four poses,
 * Metal Sonic's eight plumes. Null if any one of them does not decode, since a
 * cycle with a hole in it would stall on that entry.
 */
function buildCycle(ids) {
    const cycle = ids.map((id) => {
        const d = getModel(id);
        return d ? {
            decoded: d,
            mesh: buildGeometry(d),
            edges: d.edges.length ? buildEdgeGeometry(d) : null,
        } : null;
    });
    return cycle.every(Boolean) ? cycle : null;
}

/* Step a part built on such a cycle to another entry. One mesh swaps geometry,
 * the way the head swaps between its two faces — sixty-four meshes on screen
 * would be sixty-three of them hidden. */
function stepCycle(part, phase) {
    if (part.phase === phase) return;
    part.phase = phase;
    const g = part.cycle[phase];
    part.mesh.geometry = g.mesh;
    /* Picking reads the mesh's own index, so it has to follow the swap or a
     * click would name whichever pose was built first. */
    part.mesh.userData.modelIndex = g.decoded.index;
    if (part.lines) {
        part.lines.geometry = g.edges ?? part.lines.geometry;
        part.lines.visible = state.wireframe && Boolean(g.edges);
    }
}

/*
 * The model on one slot.
 *
 * The part table's, in whichever of its two halves the squished switch names —
 * except Metal Sonic's chest, which the jet switch swaps for the one whose vent
 * is open. The game's own swap goes through `0x40(g7)`, the same array
 * `rob_disp` draws each slot from, so it belongs here beside the part table
 * rather than beside the flame. It only reaches the normal form: the body table
 * names normal-form chests, and putting one on a halved rig would stand an
 * un-squished chest on a squished fighter.
 */
function slotModel(c, i) {
    const id = state.useSquished ? c.slots[i].modelSquished : c.slots[i].model;
    if (i !== EXHAUST_CHEST_SLOT || state.useSquished) return id;
    return chestModel(state.motion.exhaust, state.jetExhaust, id);
}

function rebuildRig({ keepCamera = true } = {}) {
    if (state.bodies) return rebuildBody({ keepCamera });
    const v = state.viewer;
    const c = state.character;
    if (!c) return;
    resetStageAnimation();
    v.clear();
    /* The fighters are drawn on every stage out of whatever is in texture RAM,
     * so their sheets are resident whichever stage was loaded — the board could
     * not draw them otherwise. Every mesh the rig puts up is a rig model, so
     * this is the same answer useModelScene gives each of them one at a time.
     * The colour tables are not the same either way: five of their rows are the
     * fighter's own colours, and send_tex_col_part puts them there for whoever
     * is on screen. */
    const u = v.material.uniforms;
    u.uTint.value.set(1, 1, 1);
    u.uBright.value = 1;
    u.uFogDensity.value = 0;
    useRomColorLuts(state.stages[state.stageIndex], c.charIndex);
    u.uUseRamp.value = state.cxlat ? 1 : 0;
    v.scene.background = new THREE.Color(NEUTRAL_BG);

    const m = state.motion;
    /* Metal Sonic's jet, read before the parts because it is what says which
     * chest he is standing in. */
    m.exhaust = readExhaust(state.rom, c.charIndex);
    /* The sixteen parts are built once and re-posed in place: a motion runs at
     * 60 Hz and rebuilding the scene per frame would rebuild every mesh. */
    m.parts = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
        const id = slotModel(c, i);
        if (!id) continue;
        const d = getModel(id);
        if (!d) continue;
        const { mesh, lines } = addModelToScene(d, { matrix: new THREE.Matrix4() });
        if (lines) { lines.matrixAutoUpdate = false; }
        m.parts.push({ slot: i, mesh, lines, bounds: d.bounds });
    }

    /* Some fighters' faces are not symmetric — Fang has a fang showing on one
     * side and a smile on the other — and the face record carries the two heads
     * for it, at +0x04. Where they differ, both are built here and `faceCamera`
     * picks between them as the view moves; where the record names the same
     * model twice the face reads the same from either side and there is nothing
     * to choose. */
    const headPart = m.parts.find((p) => p.slot === HEAD_SLOT);
    const [hA, hB] = c.face.heads;
    if (headPart && hA && hB && hA !== hB) {
        const a = getModel(hA), b = getModel(hB);
        if (a && b) headPart.sides = [buildGeometry(a), buildGeometry(b)];
    }

    /* The eyes are two more models on the head's matrix, in the head's own
     * space — not a slot of their own, so they ride it like anything drawn on
     * it. The hammer-squished set has no eyes of its own; the face record is
     * the same either way. */
    c.face.eyes.forEach((id, i) => {
        /* The record's own texture points where it carries them. For most
         * fighters they are a copy of the model's; Espio's second eye is the
         * one where the two are a different part of the sheet. */
        const points = c.face.eyePoints[i];
        const d = points ? getTpdModel(id, points, 'eye') : getModel(id);
        if (!d) return;
        const { mesh, lines } = addModelToScene(d, { matrix: new THREE.Matrix4() });
        if (lines) { lines.matrixAutoUpdate = false; }
        m.parts.push({ slot: HEAD_SLOT, mesh, lines, bounds: d.bounds, eye: true });
    });
    /* Sway chains — Honey's pigtails, Fang's tail — are not on the skeleton, so
     * they are kept apart from the slot parts and placed from the pose each
     * frame. The squished form has no chains of its own; the table is the
     * fighter's either way. */
    m.osage = readOsage(state.rom, c.charIndex);
    m.osageSim = null;
    m.osageParts = [];
    for (const p of osageParts(restPoseFor(c), m.osage, { floorY: NO_FLOOR })) {
        const d = getModel(p.model);
        if (!d) continue;
        const { mesh, lines } = addModelToScene(d, { matrix: new THREE.Matrix4() });
        if (lines) { lines.matrixAutoUpdate = false; }
        m.osageParts.push({ mesh, lines, bounds: d.bounds });
    }

    /* Tails' two tails are not a sway chain and not on the skeleton either:
     * they are a baked 64-pose cycle drawn twice off the pelvis, eight entries
     * apart. Two meshes carry the pair and swap geometry as the counter steps,
     * the way the head swaps between its two faces — sixty-four meshes on
     * screen would be sixty-two of them hidden. */
    m.tails = readTails(state.rom, c.charIndex);
    m.tailParts = [];
    if (m.tails) {
        const cycle = buildCycle(m.tails.cycle);
        if (cycle) {
            for (const p of tailParts(restPoseFor(c), m.tails, 0)) {
                const g = cycle[p.phase];
                const { mesh, lines } = addModelToScene(g.decoded,
                    { matrix: new THREE.Matrix4(), geom: g });
                if (lines) { lines.matrixAutoUpdate = false; }
                m.tailParts.push({ mesh, lines, cycle, phase: p.phase });
            }
        }
    }

    /* Metal Sonic's flame is a cycle of eight on the chest's own matrix, and
     * whether it is drawn at all is the routine's own test on the chest object
     * — which `slotModel` has just answered by installing one. */
    m.exhaustPart = null;
    if (m.exhaust && exhaustDrawn(slotModel(c, EXHAUST_CHEST_SLOT))) {
        const cycle = buildCycle(m.exhaust.cycle);
        const p = cycle && exhaustPart(restPoseFor(c), m.exhaust, 0);
        if (p) {
            const g = cycle[p.phase];
            const { mesh, lines } = addModelToScene(g.decoded,
                { matrix: new THREE.Matrix4(), geom: g });
            if (lines) { lines.matrixAutoUpdate = false; }
            m.exhaustPart = { mesh, lines, cycle, phase: p.phase };
        }
    }
    /* The Egg robots' two timed animations, neither of them in the motion: the
     * boss's arms swing on an extra object hung off the chest, and the minion's
     * head swaps and turns on its own slot. Both are stepped by the display
     * counter, so they keep moving on a motion held at one frame. */
    m.eggArms = null;
    if (BOSS_CHARS.includes(c.charIndex)) {
        const arms = readMechArms(state.rom);
        const cycle = arms && buildCycle(arms);
        if (cycle) {
            const g = cycle[0];
            const { mesh, lines } = addModelToScene(g.decoded,
                { matrix: new THREE.Matrix4(), geom: g });
            if (lines) { lines.matrixAutoUpdate = false; }
            m.eggArms = { mesh, lines, cycle, phase: 0, arms };
        }
    }
    m.eggHead = null;
    if (MINION_CHARS.includes(c.charIndex)) {
        const heads = readRoboHead(state.rom);
        const cycle = heads && buildCycle(heads);
        if (cycle) {
            const g = cycle[0];
            const { mesh, lines } = addModelToScene(g.decoded,
                { matrix: new THREE.Matrix4(), geom: g });
            if (lines) { lines.matrixAutoUpdate = false; }
            m.eggHead = { mesh, lines, cycle, phase: 0, heads,
                          anims: readRoboAnims(state.rom) };
        }
    }
    applyWireVisibility();

    /* One line list for the whole skeleton, rewritten in place each frame. */
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SLOT_COUNT - 1) * 6), 3));
    m.skeleton = new THREE.LineSegments(g, v.skeletonMaterial);
    m.skeleton.renderOrder = 2;
    m.skeleton.frustumCulled = false;
    v.root.add(m.skeleton);

    poseRig();

    if (!keepCamera) {
        /* Frame the fighter on the pose it starts in rather than on its meshes'
         * own spaces, which is where the motion has actually put them. */
        const placed = m.parts.map((p) => {
            const q = new THREE.Vector3().setFromMatrixPosition(p.mesh.matrix);
            return {
                bounds: {
                    min: [q.x + p.bounds.min[0], q.y + p.bounds.min[1], q.z + p.bounds.min[2]],
                    max: [q.x + p.bounds.max[0], q.y + p.bounds.max[1], q.z + p.bounds.max[2]],
                },
            };
        });
        const b = unionBounds(placed, 2);
        v.frame(b.center, b.radius * 1.25, { dir: [-0.45, 0.18, -0.9] });
    }
}

/*
 * The rig a motion is posed on.
 *
 * A fighter is drawn on its own skeleton — the boss on `model_floats_8`, which
 * is its own and nothing else's. The board has one more wrinkle the viewer does
 * not follow: the skeleton type is a property of the *motion* rather than the
 * character (`motionSkeletonType` in js/motion.js has the routine), and a
 * type-0 motion leaves bit 12 of `P1+0x860` clear, which drops
 * `calc_rob_angle_cont` onto the array at `0xC2058` whose type-0 table points
 * every character at Sonic. Captured out of MAME that is real and it is not
 * boss-specific: the Egg UFO ran 179 frames of the generic stance 278 on
 * Sonic's 0.39173 arm and 23 frames of motion 68 on its own 0.446 inside one
 * capture. But it reaches 43 of the Final Eggman Boss's 52 action slots and 26
 * of Bark's, and a rig browser that answers "what is this fighter's skeleton"
 * with Sonic's for half the roster's moves is answering the wrong question. So
 * the type is read and reported, and the rig stays the fighter's own.
 *
 * The hammer-squished form is the exception, because there the second skeleton
 * is the point: type 2 picks the flattened meshes and the halved bones
 * together, so the checkbox overrides whatever the motion asked for.
 */
function rigForMotion(c) {
    return state.useSquished ? c.skeletonSquished : c.skeleton;
}

/* The pose a fighter reads as with every channel at zero — enough to know which
 * chain segments exist before the first frame is solved. */
function restPoseFor(c) {
    return buildPose(rigForMotion(c), {
        headAim: c.ownAnimTable,
        angles: new Uint16Array(36),
        targets: new Float32Array(24),
        targetUsed: new Uint8Array(8),
    });
}

/* How many board frames the chains are run to catch up with a display counter
 * that has moved on by more than one. Past that the gap is a jump, not a slow
 * frame, and the chains start again from rest. */
const OSAGE_CATCH_UP = 8;

/*
 * Run the sway chains on to the current frame. They keep their points and
 * carries from one board frame to the next, as the coprocessor keeps them in
 * bufferram, so a pose that moves one frame on moves them one frame on and they
 * swing. Anything else — a new motion, a scrub backwards, a jump — starts them
 * again and settles them on the pose, which is what a pose held still shows.
 */
function placeOsage(m, pose, board) {
    const step = m.tick - m.osageTick;
    if (m.osageSim?.osage === m.osage && step >= 1 && step <= OSAGE_CATCH_UP) {
        let placed = [];
        for (let i = 0; i < step; i++) placed = stepOsage(m.osageSim, pose, board);
        m.osageTick = m.tick;
        return placed;
    }
    m.osageSim = createOsageSim(m.osage);
    m.osageTick = m.tick;
    return settleOsage(m.osageSim, pose, board);
}

/** Solve the current frame of the current motion onto the parts on screen. */
function poseRig() {
    if (state.bodies) return poseBodyRig();
    const c = state.character;
    const m = state.motion;
    if (!c || !m.parts.length) return;

    /* The hammer-squished form is a second skeleton, not a scale on the first:
     * the game switches `p1_skeleton_type` to 2, which picks both the flattened
     * meshes and the halved bone lengths that go with them. Posing the squished
     * meshes on the normal skeleton would leave them strung out along limbs
     * twice the length they are modelled for. */
    const skeleton = rigForMotion(c);
    /* A fighter with a borrowed animation table has no head data of its own,
     * so its head takes the chest's direction rather than a face target meant
     * for whoever owns the table. */
    const opts = { headAim: c.ownAnimTable };
    const pose = m.decoded
        ? buildPose(skeleton, sampleMotion(state.rom, m.decoded, m.frame), opts)
        /* A slot with no motion still has to draw something, so solve the pose
         * every channel reads as zero — which is the game's own rest. */
        : buildPose(skeleton, {
            angles: new Uint16Array(36),
            targets: new Float32Array(24),
            targetUsed: new Uint8Array(8),
        }, opts);

    const mats = poseMatrices(pose);
    for (const p of m.parts) {
        p.mesh.matrix.fromArray(mats[p.slot]);
        if (p.lines) p.lines.matrix.fromArray(mats[p.slot]);
    }
    /* The sway chains hang off the pose, so they follow it frame by frame. */
    if (m.osage) {
        /* With no motion the pose has its waist at the origin and no ground
         * under it, so there is no floor for the chains to stop at. */
        const placed = placeOsage(m, pose, m.decoded ? {} : { floorY: NO_FLOOR });
        for (let i = 0; i < m.osageParts.length && i < placed.length; i++) {
            const mat = viewerMatrix(placed[i]);
            m.osageParts[i].mesh.matrix.fromArray(mat);
            if (m.osageParts[i].lines) m.osageParts[i].lines.matrix.fromArray(mat);
        }
    }
    /* Tails' pair: placed from the pose, but stepped through their own cycle by
     * the display counter, which is why the tails keep turning on a motion held
     * on one frame only if that frame is being stepped. */
    if (m.tails) {
        const placed = tailParts(pose, m.tails, m.tick);
        for (let i = 0; i < m.tailParts.length && i < placed.length; i++) {
            const part = m.tailParts[i];
            const mat = viewerMatrix(placed[i]);
            part.mesh.matrix.fromArray(mat);
            if (part.lines) part.lines.matrix.fromArray(mat);
            stepCycle(part, placed[i].phase);
        }
    }
    /* Metal Sonic's flame: the chest's matrix as `rob_disp` leaves it, with no
     * step of its own, and the plume on it stepped by the same counter. */
    if (m.exhaustPart) {
        const part = m.exhaustPart;
        const placed = exhaustPart(pose, m.exhaust, m.tick);
        const mat = viewerMatrix(placed);
        part.mesh.matrix.fromArray(mat);
        if (part.lines) part.lines.matrix.fromArray(mat);
        stepCycle(part, placed.phase);
    }

    /* The boss's arms ride the chest exactly as `rob_disp` leaves it — the
     * routine adds no transform of its own, only a model. */
    if (m.eggArms) {
        const mat = viewerMatrix(pose[EGG_CHEST_SLOT]);
        m.eggArms.mesh.matrix.fromArray(mat);
        if (m.eggArms.lines) m.eggArms.lines.matrix.fromArray(mat);
        /* The table repeats models on the way back down, so step the cycle by
         * the table index the counter gives rather than by the model id. */
        stepCycle(m.eggArms, (m.tick >>> ARM_SHIFT) & (ARM_COUNT - 1));
    }
    /* The minion's head: the slot's own matrix, turned about the head's +X by
     * the spin phase, with the slot's normal mesh hidden while it is up. */
    if (m.eggHead) {
        const h = headFrame(m.eggHead.heads, m.eggHead.anims, m.tick);
        const shown = Boolean(h);
        m.eggHead.mesh.visible = shown && !state.wireframe;
        if (m.eggHead.lines) m.eggHead.lines.visible = shown && state.wireframe;
        const slotPart = m.parts.find((p) => p.slot === EGG_HEAD_SLOT && !p.eye);
        if (slotPart) {
            slotPart.mesh.visible = !shown && !state.wireframe;
            if (slotPart.lines) slotPart.lines.visible = !shown && state.wireframe;
        }
        if (h) {
            /* `rd_kao_rob_gururi` emits 0x5000A0A -- op 0x0A, ang_z -- so the
             * head turns about its own Z, not across it. */
            const turned = { r: turnedBy(pose[EGG_HEAD_SLOT].r, 0, 0, h.spin),
                             t: pose[EGG_HEAD_SLOT].t };
            const mat = viewerMatrix(turned);
            m.eggHead.mesh.matrix.fromArray(mat);
            if (m.eggHead.lines) m.eggHead.lines.matrix.fromArray(mat);
            stepCycle(m.eggHead, m.eggHead.heads.indexOf(h.model));
        }
    }

    if (m.skeleton) {
        const a = m.skeleton.geometry.getAttribute('position');
        a.array.set(skeletonLines(pose));
        a.needsUpdate = true;
        m.skeleton.visible = state.showSkeleton;
    }
}

/**
 * Show the head that faces the camera.
 *
 * The two heads in the face record are the same face seen from either side, so
 * which one is right depends on which side of the fighter the camera is on. The
 * head's second column is its lateral axis — the axis Honey's two pigtails
 * split along — so the sign of the camera's offset along it says which side is
 * being looked at. It is checked every frame rather than on a pose change,
 * because it is the camera that moves, not the fighter.
 */
function faceCamera() {
    const m = state.motion;
    const part = m.parts.find((p) => p.sides);
    if (!part) return;
    const e = part.mesh.matrix.elements;
    const lateral = new THREE.Vector3(e[4], e[5], e[6]);
    const toCamera = state.viewer.camera.position.clone()
        .sub(new THREE.Vector3(e[12], e[13], e[14]));
    const side = toCamera.dot(lateral) >= 0 ? 0 : 1;
    if (side === part.side) return;
    part.side = side;
    part.mesh.geometry = part.sides[side];
}

/* ---- Jointed bodies ------------------------------------------------------ */

/* The motions a body can play: those written for its joint count. A motion
 * names no body — the game picks one per enemy — so any body with the same
 * count plays it, every angle landing on the joint it was written for. */
function bodyMotions(body) {
    state.motionRanks ??= new Map();
    if (!state.motionRanks.has(body.index)) state.motionRanks.set(body.index, rankMotions(body, state.motion.list, state.bodies));
    return state.motionRanks.get(body.index);
}

function loadBody(index, { keepCamera = false, keepMotion = false } = {}) {
    const body = state.bodies[index] ?? state.bodies[0];
    state.charIndex = body.index;
    state.character = body;
    const m = state.motion;
    /* Start on a motion likely written for the body: a body can play any
     * motion of its joint count, but one keyed on another skeleton bends its
     * parts in ways they were not modelled for. A motion carried over from the
     * last body stays if it is among them. */
    const { fits, lead } = bodyMotions(body);
    const held = keepMotion && m.decoded?.joints === body.joints ? m.decoded : null;
    const pick = held && lead.includes(held) ? held : lead[0] ?? fits[0];
    setMotion(pick?.index ?? -1, -1, { rebuild: false });
    rebuildBody({ keepCamera });
    renderAnimPanel();
    updateHud();
}

function rebuildBody({ keepCamera = true } = {}) {
    const v = state.viewer;
    const body = state.character;
    if (!body) return;
    resetStageAnimation();
    v.clear();
    /* The sheets, palette, colour tables and light the Models tab shows the
     * body's models under. A body's parts are all in one bank, so its first
     * part answers for the rest. */
    const first = body.parts.find((p) => p.model)?.model;
    if (first != null) useModelScene(first);

    const m = state.motion;
    /* A part can draw more than one model, and which ones changes with the
     * frame, so each keeps a slot per model it has drawn so far and swaps their
     * geometry — the coat alone is a hundred models. */
    m.parts = body.parts.map((p) => ({ part: p.index, slots: [] }));
    m.skin = readSkin(state.rom, body);
    m.skinMesh = null;
    applyWireVisibility();

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array(Math.max(1, body.parts.length - 1) * 6), 3));
    m.skeleton = new THREE.LineSegments(g, v.skeletonMaterial);
    m.skeleton.renderOrder = 2;
    m.skeleton.frustumCulled = false;
    v.root.add(m.skeleton);

    poseRig();

    if (!keepCamera) {
        const drawn = m.parts.flatMap((p) => p.slots.filter((x) => x.decoded)
            .map((x) => transformedBounds(x.decoded, x.mesh.matrix)));
        const b = unionBounds(drawn, 10);
        v.frame(b.center, b.radius * 1.25, { dir: [-0.45, 0.18, -0.9] });
    }
}

/* Point a part's slot at a model, or at nothing. */
const IDENTITY_MATRIX = new THREE.Matrix4().elements;

/*
 * Rank a body part's coplanar faces, for a game whose art lays one on another
 * in the same plane (see js/layers.js). A part is rigid — a pose moves its
 * matrix and never its points — so the ranking is its own, computed once per
 * model in the part's own space, and the vertex shader carries the plane into
 * view through the normal matrix like any other direction. Without it a face
 * laid on another fights it: BO_neil wears his wounds that way, and the depth
 * buffer picked between them by rounding.
 *
 * The geometry cache is shared with the stage path, which ranks the same models
 * against a whole scene instead. They do not have to agree, because switching
 * tabs rebuilds whichever view is showing.
 */
function rankBodyPart(slot) {
    if (!slot?.decoded || !slot.mesh) return;
    applyFaceLayers([{ decoded: slot.decoded, matrix: IDENTITY_MATRIX, mesh: slot.mesh }]);
}

function setBodySlot(slot, model) {
    if (slot.model === model) return;
    slot.model = model;
    const d = model == null ? null : getModel(model);
    slot.decoded = d?.positions.length ? d : null;
    const hidden = !slot.decoded;
    slot.mesh.visible = !hidden;
    if (slot.lines) slot.lines.userData.hidden = hidden;
    if (hidden) {
        if (slot.lines) slot.lines.visible = false;
        return;
    }
    const geom = frameGeometry(model);
    slot.mesh.geometry = geom.mesh;
    slot.mesh.userData.modelIndex = model;
    if (slot.lines) {
        slot.lines.geometry = geom.edges;
        slot.lines.visible = state.wireframe;
    }
    rankBodyPart(slot);
}

function poseBodyRig() {
    const body = state.character;
    const m = state.motion;
    if (!body) return;
    const v = state.viewer;
    const { matrices, origins } = poseBody(body, m.decoded, m.frame, { travel: state.travel });
    const draws = partDraws(state.rom, body, m.decoded, m.frame, m.tick);
    for (const p of m.parts) {
        const models = draws[p.part];
        for (let k = 0; k < Math.max(models.length, p.slots.length); k++) {
            if (k >= p.slots.length) {
                const d = getModel(models[k]);
                if (!d?.positions.length) continue;
                const { mesh, lines } = addModelToScene(d,
                    { matrix: new THREE.Matrix4(), geom: frameGeometry(models[k]) });
                if (lines) { lines.matrixAutoUpdate = false; }
                p.slots.push({ mesh, lines, model: models[k], decoded: d });
                rankBodyPart(p.slots[p.slots.length - 1]);
                continue;
            }
            setBodySlot(p.slots[k], k < models.length ? models[k] : null);
        }
        for (const x of p.slots) {
            x.mesh.matrix.fromArray(matrices[p.part]);
            if (x.lines) x.lines.matrix.fromArray(matrices[p.part]);
        }
    }

    /* The skin is rebuilt every frame, as the board rebuilds it: its points on
     * the chest side move with the pose. */
    if (m.skin) {
        const d = decodeModel(state.rom, null, null, skinMesh(m.skin, matrices));
        if (d) {
            d.index = null;
            if (!m.skinMesh) {
                const { mesh, lines } = addModelToScene(d, { matrix: new THREE.Matrix4() });
                if (lines) { lines.matrixAutoUpdate = false; }
                m.skinMesh = { mesh, lines };
            } else {
                m.skinMesh.mesh.geometry.dispose();
                m.skinMesh.mesh.geometry = buildGeometry(d);
                if (m.skinMesh.lines) {
                    m.skinMesh.lines.geometry.dispose();
                    m.skinMesh.lines.geometry = buildEdgeGeometry(d);
                }
            }
            m.skinMesh.mesh.matrix.fromArray(matrices[m.skin.hips]);
            if (m.skinMesh.lines) m.skinMesh.lines.matrix.fromArray(matrices[m.skin.hips]);
        }
    }

    if (m.skeleton) {
        const a = m.skeleton.geometry.getAttribute('position');
        a.array.set(bodySkeletonLines(body, origins));
        a.needsUpdate = true;
        m.skeleton.visible = state.showSkeleton;
    }
}

/** Advance the motion to whatever frame elapsed time puts us on, and loop. */
function stepMotion(now) {
    const m = state.motion;
    if (!m.decoded || !m.playing) return;
    const len = m.decoded.frames;
    /* The game starts a motion at frame 1 and plays until the frame passes its
     * length, so the cycle is `len` frames long. The display counter under it
     * does not fold, and it is what steps the tails — so it, not the frame, is
     * what says whether anything has moved. */
    const tick = Math.floor(((now - m.start) / 1000) * GAME_HZ);
    if (tick === m.tick) return;
    m.tick = tick;
    m.frame = 1 + (tick % len);
    poseRig();
    updateMotionFrameReadout();
}

function applyWireVisibility() {
    for (const o of state.viewer.root.children) {
        if (!o.userData.isWire) continue;
        const layer = o.userData.layer;
        o.visible = state.wireframe && !o.userData.hidden && (layer == null || state.layerOn[layer]);
    }
}

/* ---- Panels -------------------------------------------------------------- */

function renderStageSelect() {
    const sel = $('#stage-select');
    sel.innerHTML = '';
    state.stages.forEach((st, i) => {
        const opt = el('option');
        opt.value = String(i);
        opt.textContent = `${String(i).padStart(2, '0')} · ${st.name}`;
        sel.appendChild(opt);
    });
    sel.value = String(state.stageIndex);
}

function renderStagePanel(stage, counts, totals, list) {
    const totalTris = state.viewer.root.children
        .filter((c) => c.isMesh)
        .reduce((a, m) => a + m.geometry.attributes.position.count / 3, 0);
    /* A stage built from placements has no record fields to show, and says what
     * it was assembled from instead. */
    $('#stage-meta').innerHTML = stage.meta ? `
        ${stage.meta.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}
        <span>draws</span><b>${list.length}</b>
        <span>triangles</span><b>${totalTris.toLocaleString()}</b>
    ` : `
        <span>stage_NUM</span><b>${stage.num}</b>
        <span>flags</span><b>0x${stage.flags.toString(16).toUpperCase()}</b>
        <span>floor size</span><b>${stage.floorSize.toFixed(3)}</b>
        <span>texture set</span><b>${stage.texSet[0]}, ${stage.texSet[1]}</b>
        <span>brightness</span><b>${stage.bright.toFixed(2)}</b>
        <span>draws</span><b>${list.length}</b>
        <span>triangles</span><b>${totalTris.toLocaleString()}</b>
    `;

    /* Only a stage with a prologue has two framings to choose between; on the
     * other thirteen the checkbox would be a control over nothing. */
    const rides = stageMoves(stage);
    $('#ride-field').hidden = !rides;
    if (rides) {
        $('#ride-label').textContent = RIDE_LABEL[stage.slot] ?? 'ride the arena';
        $('#opt-ride').checked = state.rideStage;
    }

    const layers = $('#stage-layers');
    layers.innerHTML = '';
    for (const key of LAYER_ORDER) {
        if (!totals[key]) continue;
        const on = state.layerOn[key] !== false;
        const row = el('label', 'layer',
            `<input type="checkbox" ${on ? 'checked' : ''}>
             <span>${key}</span><span class="n">${counts[key]}/${totals[key]}</span>`);
        row.querySelector('input').addEventListener('change', (e) => {
            state.layerOn[key] = e.target.checked;
            for (const o of state.viewer.root.children) {
                if (o.userData.layer !== key) continue;
                o.visible = o.userData.isWire ? state.wireframe && e.target.checked : e.target.checked;
            }
        });
        layers.appendChild(row);
    }

    const parts = $('#stage-parts');
    parts.innerHTML = '';
    $('#stage-part-count').textContent = `${list.length} draws`;
    for (const entry of list) {
        const d = getModel(entry.model);
        const xform = describeOps(opsAt(entry, 0));
        /* An animated draw is listed under the model it rests on, with the
         * length of the table it walks; the id is what clicking opens. */
        const frames = entry.anim ? ` · ${entry.anim.frames.length}f`
            : entry.band ? ` · ${entry.band.count} bands`
            : entry.scroll ? ` · scrolls ${scrollPeriod(entry.scroll)}f` : '';
        const row = el('div', 'row-item',
            `<span class="id">${entry.model}</span><span>${entry.layer}</span>
             <span class="info">${xform || (d ? `${d.faceCount} faces` : 'empty')}${frames}</span>`);
        row.addEventListener('click', () => { switchTab('model'); selectModel(entry.model); });
        parts.appendChild(row);
    }
}

function renderModelList() {
    const list = $('#model-list');
    const q = $('#model-search').value.trim();
    const onlyMesh = $('#model-only-mesh').checked;

    let lo = 0, hi = modelCount() - 1;
    const range = q.match(/^(\d+)\s*-\s*(\d+)$/);
    const single = q.match(/^(\d+)$/);
    if (range) { lo = +range[1]; hi = +range[2]; }
    else if (single) { lo = Math.max(0, +single[1] - 8); hi = +single[1] + 60; }
    lo = Math.max(0, lo); hi = Math.min(modelCount() - 1, hi);
    /* Anything else is a name to look for, in a game whose models have them. */
    const named = !!state.rom.game.modelNames;
    const needle = named && !range && !single && q ? q.toLowerCase() : null;

    const rows = [];
    for (let i = lo; i <= hi && rows.length < 1500; i++) {
        if (onlyMesh && readModelEntry(state.rom, i).meshPtr === 0) continue;
        if (needle && !(readModelName(state.rom, i) ?? '').toLowerCase().includes(needle)) continue;
        rows.push(i);
    }
    $('#model-count').textContent = `${rows.length} shown of ${modelCount()} table entries`;

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const i of rows) {
        const row = el('div', 'row-item' + (i === state.modelIndex ? ' sel' : ''),
            `<span class="id">${i}</span><span class="info" data-info>…</span>`);
        row.dataset.index = String(i);
        row.addEventListener('click', () => selectModel(i));
        frag.appendChild(row);
    }
    list.appendChild(frag);
    fillModelInfoLazily(list);

    /* An exact index in the box selects it outright. */
    if (single && rows.includes(+single[1])) selectModel(+single[1]);
}

/* Decoding 4400 meshes eagerly would stall the UI, so face counts fill in as
 * rows scroll into view. */
function fillModelInfoLazily(list) {
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            const d = getModel(+e.target.dataset.index);
            const name = readModelName(state.rom, +e.target.dataset.index);
            const faces = d ? `${d.faceCount} faces` : 'no mesh';
            e.target.querySelector('[data-info]').textContent = name ? `${name} · ${faces}` : faces;
        }
    }, { root: list, rootMargin: '240px' });
    for (const row of list.children) io.observe(row);
}

function selectModel(idx) {
    for (const row of $('#model-list').children) {
        row.classList.toggle('sel', +row.dataset.index === idx);
    }
    loadModel(idx);
}

function renderModelInfo(idx, d) {
    const entry = readModelEntry(state.rom, idx);
    const name = readModelName(state.rom, idx);
    $('#model-info').innerHTML = d
        ? `<b>model ${idx}</b>${name ? ` <span class="mono">${name}</span>` : ''} — ${d.faceCount} faces · ${d.positions.length / 9} tris ·
           ${d.vertexPairs} vertex pairs · ${d.texturedFaces} textured<br>
           <span class="mono">mesh ${entry.meshPtr} · mat ${entry.matPtr} · uv ${entry.uvPtr}</span><br>
           <span class="mono">${describeModelScene(idx)}</span>`
        : `<b>model ${idx}</b> — no geometry at this table entry`;
}

/* Which sheets the model is being drawn against, and why — the difference
 * between a face shaded through the ramp and one shaded flat is large enough
 * that it should not have to be guessed at from the picture. */
function describeModelScene(idx) {
    const slots = modelScenes().get(idx);
    if (!slots) {
        /* With no stage table located there is no scene to name and no ramp in
         * play, so say what is actually on screen: the model's own palette. */
        if (state.rom.game.palette) {
            return `drawn by no stage — sheets, palette and colour tables of set ${state.rom.paletteSet ?? 0}`;
        }
        if (!state.stages.length) {
            /* A game with colour tables but no stage table has one set of them
             * for the whole game, so there is no scene to name — only which
             * sheets the model is standing on. */
            if (state.rom.game.colors) {
                const set = modelTextureSet(idx);
                return `drawn by no stage — the game's own colour tables, sheets of set ${set ?? 0}`;
            }
            return 'shaded flat, on the face palette in the ROM';
        }
        const stage = state.stages[state.stageIndex];
        return `drawn by no stage — shaded against ${stage ? stage.name : 'the loaded stage'}'s tables`;
    }
    if (slots[0] === SCENE_ANY) {
        /* Whose it is decides five rows of the colour table, so say it: a head
         * read against the wrong fighter's block is a different colour, not a
         * slightly different one. */
        const who = CHARACTERS.find((c) => c.index === modelFighter(idx))?.name;
        return `a fighter's part${who ? ` — ${who}` : ''} — set 1, resident on every stage`;
    }
    const names = slots.map((n) => state.stages[n].name);
    return `drawn by ${names.join(', ')}`;
}

function renderCharacterSelect() {
    const sel = $('#char-select');
    sel.innerHTML = '';
    if (state.bodies) {
        for (const b of state.bodies) {
            const opt = el('option');
            opt.value = String(b.index);
            opt.textContent = `${String(b.index).padStart(2, '0')} · ${b.name}`;
            sel.appendChild(opt);
        }
        sel.value = String(state.charIndex);
        return;
    }
    for (const c of CHARACTERS) {
        const opt = el('option');
        opt.value = String(c.index);
        opt.textContent = c.name;
        sel.appendChild(opt);
    }
    sel.value = String(state.charIndex);
}

function renderAnimPanel() {
    if (state.bodies) return renderBodyPanel();
    const c = state.character;
    if (!c) return;

    $('#char-meta').innerHTML = `
        <span>CHAR_PARTS</span><b>#${c.charIndex}</b>
        <span>part table</span><b>0x${c.partsPtr.toString(16)}</b>
        <span>skeleton table</span><b>0x${(state.useSquished ? c.squishedPtr : c.normalPtr).toString(16)}${state.useSquished ? ' (squished)' : ''}</b>
        <span>motion table</span><b>0x${c.animPtr.toString(16)}</b>
        <span>reach</span><b>${c.height.toFixed(1)}</b>
    `;

    const slots = $('#slot-list');
    slots.innerHTML = '';
    c.slots.forEach((b, i) => {
        const row = el('div', 'joint');
        const id = slotModel(c, i);
        const modelLabel = id ? `model ${id}` : 'no mesh';
        const off = state.useSquished ? b.offsetSquished : b.offset;
        row.innerHTML = `<div class="joint-head"><b>${i}. ${b.name}</b>
            <span class="dim">${modelLabel} · ${off[0].toFixed(3)}</span></div>`;
        if (id) {
            row.querySelector('.joint-head').addEventListener('click', () => {
                switchTab('model');
                selectModel(id);
            });
        }
        slots.appendChild(row);
    });

    renderTailsPanel();
    renderExhaustPanel();
    renderOsagePanel();
    renderMotionPanel();
}

/* What Tails' pair is made of, shown only for the two characters that have it. */
function renderTailsPanel() {
    const t = state.motion.tails;
    const field = $('#tails-field');
    field.hidden = !t;
    if (!t) return;
    const ids = t.cycle;
    /* The mirror set is the same animation in a different model order, so its
     * range is worth naming as a range and saying so. */
    const run = ids.every((id, i) => i === 0 || id === ids[0] + i);
    const span = run
        ? `${ids[0]}–${ids[ids.length - 1]}`
        : `${Math.min(...ids)}–${Math.max(...ids)}, reordered`;
    $('#tails-readout').innerHTML =
        `cycle 0x${t.cycleAddr.toString(16)} — ${ids.length} poses, models ${span}`
        + `<br>drawn twice off slot ${TAILS_PELVIS_SLOT}, ±22.5° and ${TAILS_LEAD} entries apart`
        + `<br>propeller 0x${t.blurAddr.toString(16)} — models ${t.blur.join(', ')}, not drawn`;
}

/* Metal Sonic's jet, shown only for the two roster entries that carry it. The
 * switch is on the chest rather than on the flame, because that is what the
 * board's own test reads. */
function renderExhaustPanel() {
    const m = state.motion;
    const field = $('#exhaust-field');
    field.hidden = !m.exhaust;
    if (!m.exhaust) return;
    const e = m.exhaust;
    const chest = slotModel(state.character, EXHAUST_CHEST_SLOT);
    $('#exhaust-open').checked = state.jetExhaust;
    $('#exhaust-open').disabled = state.useSquished;
    /* Why the flame is up or down, in the routine's own terms: it is the chest
     * object that decides, and in the squished form neither chest is installed
     * — which is a state the guard has no case for, so the flame stays lit. */
    const why = state.useSquished
        ? `squished chest ${chest} is neither closed chest — flame always up`
        : exhaustDrawn(chest) ? 'vent open — flame up' : 'chest closed — no flame';
    $('#exhaust-readout').innerHTML =
        `cone 0x${e.coneAddr.toString(16)} — models ${e.cone.join(', ')}`
        + `<br>burst 0x${e.burstAddr.toString(16)} — models ${e.burst.join(', ')}`
        + `<br>${EXHAUST_CYCLE_LENGTH} frames, one a frame off slot ${EXHAUST_CHEST_SLOT}, alternating`
        + `<br>chests 0x${e.bodyAddr.toString(16)} — ${e.bodies.join(' closed, ')} open`
        + `<br>${why}`;
}

/* What the sway chains are made of, shown only for the five fighters that have
 * them: each chain's attach bone, its segments and the damping it runs with. */
function renderOsagePanel() {
    const m = state.motion;
    const field = $('#osage-field');
    field.hidden = !m.osage;
    if (!m.osage) return;

    const lines = [`table 0x${m.osage.table.toString(16)}`];
    let damping = null, limits = null, chain = 0;
    for (const r of m.osage.records) {
        if (r.type === 3) { damping = r.damping; limits = r.noLimits !== 1; }
        if (r.type !== 4) continue;
        const c = m.osage.chains[chain++];
        const lengths = c.segments.map((s) => s.length.toFixed(2)).join(' + ');
        lines.push(`chain ${chain} on ${SLOT_NAMES[c.bone] ?? `slot ${c.bone}`}: `
            + `${c.segments.length} × (${lengths})`
            + (damping === null ? '' : `, damping ${damping.toFixed(2)}${limits ? '' : ', no body limits'}`));
    }
    $('#osage-readout').innerHTML = lines.join('<br>');
}

function renderBodyPanel() {
    const body = state.character;
    if (!body) return;
    const drawn = body.parts.filter((p) => p.model).length;
    $('#char-meta').innerHTML = `
        <span>body</span><b>${body.index}</b>
        <span>root part</span><b>0x${body.root.toString(16)}</b>
        <span>joints</span><b>${body.joints}</b>
        <span>parts</span><b>${body.parts.length}, ${drawn} with a model</b>
        <span>scale</span><b>${body.scale.toFixed(3)}</b>
        <span>motions that fit</span><b>${bodyMotions(body).fits.length}</b>
    `;

    const list = $('#slot-list');
    list.innerHTML = '';
    for (const p of body.parts) {
        const row = el('div', 'joint');
        const name = p.model ? readModelName(state.rom, p.model) : '';
        const label = p.model ? `model ${p.model}${name ? ` · ${name}` : ''}` : 'no mesh';
        const off = p.offset.map((x) => x.toFixed(2)).join(', ');
        row.innerHTML = `<div class="joint-head"><b>${'\u2003'.repeat(p.depth)}joint ${p.joint}</b>
            <span class="dim">${label} · ${off}</span></div>`;
        if (p.model) {
            row.querySelector('.joint-head').addEventListener('click', () => {
                switchTab('model');
                selectModel(p.model);
            });
        }
        list.appendChild(row);
    }
    renderMotionPanel();
}

/* The motions written for the body's joint count, by name. */
function renderBodyMotionPanel() {
    const body = state.character;
    const m = state.motion;
    if (!body) return;
    const sel = $('#motion-select');
    sel.innerHTML = '';
    const { fits, lead, label } = bodyMotions(body);
    const group = (label, list) => {
        if (!list.length) return;
        const g = el('optgroup');
        g.label = label;
        for (const x of list) {
            const o = el('option');
            o.value = `id:${x.index}`;
            o.textContent = `${x.name} · ${x.frames}f`;
            g.appendChild(o);
        }
        sel.appendChild(g);
    };
    group(`${label} (${lead.length})`, lead);
    group(lead.length ? `Every other motion for ${body.joints} joints (${fits.length - lead.length})`
        : `Motions for ${body.joints} joints (${fits.length})`, fits.filter((x) => !lead.includes(x)));
    if (m.decoded) sel.value = `id:${m.decoded.index}`;

    const d = m.decoded;
    $('#motion-meta').innerHTML = d ? `
        <span>motion</span><b>${d.index}</b>
        <span>data</span><b>0x${d.address.toString(16)}</b>
        <span>frames</span><b>${d.frames}</b>
        <span>frame size</span><b>${frameBytes(d.joints)} bytes</b>
    ` : '<span>motion</span><b>none fits this body</b>';

    const scrub = $('#motion-frame');
    scrub.max = String(d ? d.frames : 1);
    scrub.value = String(m.frame);
    scrub.disabled = !d;
    $('#motion-play').textContent = m.playing ? 'Pause' : 'Play';
    $('#motion-play').disabled = !d;
    updateMotionFrameReadout();
}

/* The 52 action slots, then the whole motion table for browsing. */
function renderMotionPanel() {
    if (state.bodies) return renderBodyMotionPanel();
    const c = state.character;
    const m = state.motion;
    if (!c) return;

    const sel = $('#motion-select');
    sel.innerHTML = '';
    const actions = el('optgroup');
    actions.label = 'This fighter\'s action slots';
    for (let i = 0; i < ACTION_SLOT_COUNT; i++) {
        const id = c.motions[i];
        const d = decodeMotion(state.rom, id);
        const o = el('option');
        o.value = `slot:${i}`;
        o.textContent = `${String(i).padStart(2)} · motion ${id}` + (d ? ` · ${d.frames}f` : ' · empty');
        actions.appendChild(o);
    }
    sel.appendChild(actions);

    const all = el('optgroup');
    all.label = `Every motion in the table (${m.list.length})`;
    for (const e of m.list) {
        const o = el('option');
        o.value = `id:${e.id}`;
        o.textContent = `motion ${e.id} · ${e.frames}f`;
        all.appendChild(o);
    }
    sel.appendChild(all);
    sel.value = m.slot >= 0 ? `slot:${m.slot}` : `id:${m.id}`;

    const d = m.decoded;
    $('#motion-meta').innerHTML = d ? `
        <span>motion</span><b>${d.id}</b>
        <span>block</span><b>0x${d.address.toString(16)}</b>
        <span>frames</span><b>${d.frames}</b>
        <span>keyed channels</span><b>${d.channels.filter((x) => x.type >= 5).length} of 60</b>
        <span>keys</span><b>${d.channels.reduce((a, x) => a + x.count, 0)}</b>
    ` : '<span>motion</span><b>empty slot</b>';

    const scrub = $('#motion-frame');
    scrub.max = String(d ? d.frames : 1);
    scrub.value = String(m.frame);
    scrub.disabled = !d;
    $('#motion-play').textContent = m.playing ? 'Pause' : 'Play';
    $('#motion-play').disabled = !d;
    updateMotionFrameReadout();
}

function updateMotionFrameReadout() {
    const m = state.motion;
    const n = m.decoded ? m.decoded.frames : 0;
    $('#motion-frame-val').textContent = m.decoded ? `${m.frame} / ${n}` : '—';
    const scrub = $('#motion-frame');
    if (scrub && document.activeElement !== scrub) scrub.value = String(m.frame);
}

/* ---- HUD / options ------------------------------------------------------- */

function updateHud() {
    const v = state.viewer;
    let label;
    if (state.tab === 'stage') {
        const st = state.stages[state.stageIndex];
        label = `<b>${st?.name ?? ''}</b> · stage slot ${state.stageIndex}`;
    } else if (state.tab === 'model') {
        label = `<b>model ${state.modelIndex}</b>`;
    } else {
        const m = state.motion;
        label = `<b>${state.character?.name ?? ''}</b> · `
            + (m.decoded ? m.decoded.name || `motion ${m.decoded.id}` : 'no motion');
    }
    $('#hud').innerHTML = `${label} · ${v.mode === 'fly' ? 'noclip' : 'orbit'} camera`
        + (v.mode === 'orbit' ? ` · ${isMobile() ? 'tap' : 'click'} a part to identify it` : '');
}

/* ---- Picking -------------------------------------------------------------- */

/*
 * Click a part to find out which model it is.
 *
 * Every mesh already carries the table index it was decoded from, so this is a
 * raycast and a lookup. Orbit only: the fly rig holds the pointer for looking
 * around, where a click is a camera move rather than a choice. Orbiting uses
 * the same button as picking, so a pointer that travelled is a drag and not a
 * click — hence the slop, in pixels.
 */
const PICK_SLOP = 4;

/** Show a model in the Models tab, and put its row on screen. */
function revealModel(idx) {
    state.modelIndex = idx;
    switchTab('model');
    /* On the phone the sheet may be down, with the answer inside it. */
    state.sheet.open();
    $('#model-search').value = String(idx);
    renderModelList();
    const row = [...$('#model-list').children].find((r) => +r.dataset.index === idx);
    row?.scrollIntoView({ block: 'center' });
}

function wirePicking() {
    const v = state.viewer;
    const canvas = v.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let from = null;

    canvas.addEventListener('pointerdown', (e) => {
        from = e.button === 0 ? [e.clientX, e.clientY] : null;
    });
    canvas.addEventListener('pointerup', (e) => {
        const at = from;
        from = null;
        if (!at || e.button !== 0 || v.mode !== 'orbit') return;
        if (Math.hypot(e.clientX - at[0], e.clientY - at[1]) > PICK_SLOP) return;

        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
                -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, v.camera);
        /* Nearest first out of intersectObjects, so the first hit that is a
         * visible mesh is the one under the cursor — the wire overlays, any
         * layer toggled off and any face the board does not draw from this side
         * are not it. */
        const hit = ray.intersectObjects(v.root.children, false).find(
            (h) => h.object.isMesh && h.object.visible
                && h.object.userData.modelIndex != null
                && boardDrawsFace(h.object, h.faceIndex, v.camera));
        if (hit) revealModel(hit.object.userData.modelIndex);
    });
}

function switchTab(tab) {
    state.tab = tab;
    for (const b of $('#tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of document.querySelectorAll('.tabpanel')) p.hidden = p.dataset.tab !== tab;
    if (tab === 'stage') loadStage(state.stageIndex);
    else if (tab === 'model') loadModel(state.modelIndex);
    else loadCharacter(state.charIndex, { keepPose: true });
    updateHud();
}

function wireOptions() {
    const v = state.viewer;

    /* The phone site's sheet and stick are wired on both sites, so the layout
     * switch below can flip between them in place rather than reloading. */
    state.sheet = wireSheet();
    state.touchFly = wireTouchFly(v.fly);
    const syncTouchFly = () => state.touchFly.show(isMobile() && v.mode === 'fly');

    wirePicking();

    $('#tabs').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        switchTab(b.dataset.tab);
        state.sheet.open();
    });

    $('#stage-select').addEventListener('change', (e) => loadStage(+e.target.value));
    $('#model-search').addEventListener('input', renderModelList);
    $('#model-only-mesh').addEventListener('change', renderModelList);

    $('#char-select').addEventListener('change', (e) =>
        loadCharacter(+e.target.value, { keepMotion: true }));
    $('#char-squish').addEventListener('change', (e) => {
        state.useSquished = e.target.checked;
        rebuildRig({ keepCamera: true });
        renderAnimPanel();
    });
    $('#exhaust-open').addEventListener('change', (e) => {
        state.jetExhaust = e.target.checked;
        rebuildRig({ keepCamera: true });
        renderAnimPanel();
    });
    $('#char-travel').addEventListener('change', (e) => {
        state.travel = e.target.checked;
        poseRig();
    });
    $('#char-skel').addEventListener('change', (e) => {
        state.showSkeleton = e.target.checked;
        if (state.motion.skeleton) state.motion.skeleton.visible = e.target.checked;
    });

    $('#motion-select').addEventListener('change', (e) => {
        const [kind, n] = e.target.value.split(':');
        if (kind === 'slot') setMotion(state.character.motions[+n], +n);
        else setMotion(+n, -1);
    });
    $('#motion-play').addEventListener('click', () => {
        const m = state.motion;
        m.playing = !m.playing;
        /* Pick the clock up where the counter already is, so play resumes from
         * wherever a scrub left it rather than jumping. The counter is where a
         * scrub left the frame too, so neither the pose nor the tails move. */
        if (m.playing) m.start = performance.now() - (m.tick / GAME_HZ) * 1000;
        $('#motion-play').textContent = m.playing ? 'Pause' : 'Play';
    });
    $('#motion-frame').addEventListener('input', (e) => {
        const m = state.motion;
        m.playing = false;
        $('#motion-play').textContent = 'Play';
        /* A scrub is a step of the whole clock, not just of the motion: moving
         * one frame on moves Tails' tails one entry on with it. */
        m.tick += +e.target.value - m.frame;
        m.frame = +e.target.value;
        poseRig();
        updateMotionFrameReadout();
    });

    $('#camera-mode').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        for (const x of $('#camera-mode').children) x.classList.toggle('active', x === b);
        v.setMode(b.dataset.mode);
        $('#fly-hint').hidden = b.dataset.mode !== 'fly';
        syncTouchFly();
        updateHud();
    });

    $('#shade-mode').addEventListener('change', (e) => {
        v.material.uniforms.uShadeMode.value = +e.target.value;
    });
    /* The backdrop is a flat palette colour like the fog, so it takes whatever
     * transfer the surfaces take — otherwise switching modes would leave the
     * sky sitting in the space the geometry just left. */
    $('#transfer-mode').addEventListener('change', (e) => {
        state.transfer = +e.target.value;
        v.material.uniforms.uTransfer.value = state.transfer;
        applyBackdropTransfer();
    });
    $('#opt-wire').addEventListener('change', (e) => {
        state.wireframe = e.target.checked;
        applyWireVisibility();
    });
    /* Pausing leaves the stage on whatever frame it had reached; resuming
     * restarts the clock from there rather than snapping back to the pose. */
    $('#opt-anim').addEventListener('change', (e) => {
        state.animate = e.target.checked;
        if (state.animate) {
            state.anim.start = performance.now() - (state.anim.frame / GAME_HZ) * 1000;
        }
    });
    $('#opt-grid').addEventListener('change', (e) => { v.grid.visible = e.target.checked; });
    $('#opt-axes').addEventListener('change', (e) => { v.axes.visible = e.target.checked; });
    $('#opt-cull').addEventListener('change', (e) => v.backfaceCull(e.target.checked));
    $('#opt-ride').addEventListener('change', (e) => setRideStage(e.target.checked));

    $('#tex-file').addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        loadTexramFiles(files);
    });
    $('#tex-luma').addEventListener('input', (e) => {
        v.material.uniforms.uLumaScale.value = +e.target.value;
        $('#tex-luma-val').textContent = (+e.target.value).toFixed(2);
    });

    v.onPointerLockChange = (locked) => { $('#fly-hint').hidden = locked || v.mode !== 'fly'; };

    /* Between the sidebar and the sheet, in place: the ROM stays loaded and
     * the camera stays where it is. The canvas changes size under the viewer,
     * and the fly rig changes from pointer lock to the stick. */
    $('#layout-switch').addEventListener('click', (e) => {
        e.preventDefault();
        setMobile(!isMobile());
        v.touch = isMobile();
        v.resize();
        syncTouchFly();
        updateHud();
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, select, textarea')) return;
        if (state.tab === 'model' && e.code === 'BracketRight') selectModel(Math.min(modelCount() - 1, state.modelIndex + 1));
        if (state.tab === 'model' && e.code === 'BracketLeft') selectModel(Math.max(0, state.modelIndex - 1));
        if (e.code === 'KeyF') {
            if (state.tab === 'stage') loadStage(state.stageIndex);
            else if (state.tab === 'model') loadModel(state.modelIndex);
            else rebuildRig({ keepCamera: false });
        }
    });
}

/* ---- Boot ---------------------------------------------------------------- */

/*
 * Show only the tabs the loaded game has tables for.
 *
 * The stage list, the rigs and the motions are each read out of a table located
 * in one game's program ROM, and a second game keeps its own somewhere else. So
 * a title the repo has only the model table for gets the Models tab and nothing
 * else, rather than three panels where two are empty or, worse, full of another
 * game's addresses read against these ROMs.
 */
/* The Models tab's texture picker. Shown only when no stage record is going to
 * name a texture number, which is the same condition that hides the Stages tab.
 * "From the model" is the default and is what the auto search does. */
function renderTextureSetPicker() {
    const sel = $('#model-texset');
    sel.innerHTML = '';
    const auto = el('option');
    auto.value = 'auto';
    auto.textContent = 'From the model (auto)';
    sel.appendChild(auto);
    for (let s = 0; s < state.rom.game.texture.sets; s++) {
        const o = el('option');
        o.value = String(s);
        o.textContent = `set ${s}`;
        sel.appendChild(o);
    }
    sel.value = 'auto';
    sel.addEventListener('change', () => {
        state.texSetChoice = sel.value === 'auto' ? null : Number(sel.value);
        /* The sheets are keyed on the set, so a change has to invalidate that
         * key or the rebuild is skipped as a repeat. */
        state.texramKey = null;
        loadModel(state.modelIndex, { keepCamera: true });
    });
    $('#model-texset-field').hidden = false;

    /* Scene colours and whose parts to read, the two a stage record would name.
     * Both are written on every rebuild, since a model names rows in one range
     * or the other and nothing says in advance which. A game with no colour
     * tables ported has neither to offer. */
    const C = state.rom.game.colors;
    if (!C?.part) return;
    const fill = (id, n, label, first) => {
        const s = $(id);
        s.innerHTML = '';
        if (first) {
            const o = el('option');
            o.value = '-1';
            o.textContent = first;
            s.appendChild(o);
        }
        for (let i = 0; i < n; i++) {
            const o = el('option');
            o.value = String(i);
            o.textContent = `${label} ${i}`;
            s.appendChild(o);
        }
        return s;
    };
    const rebuild = () => {
        state.lutKey = null;
        loadModel(state.modelIndex, { keepCamera: true });
    };
    const fighter = fill('#model-fighter', C.part.blocks, 'fighter', 'none');
    fighter.value = String(state.colorFighter);
    fighter.addEventListener('change', () => {
        state.colorFighter = Number(fighter.value);
        rebuild();
    });
    $('#model-colour-field').hidden = false;
}

function applyGameFeatures() {
    const f = state.rom.game.features;
    $('#game-title').textContent = state.rom.game.name;
    document.title = `${state.rom.game.name} — 3D Explorer`;
    const on = { stage: f.stages, model: true, anim: (f.characters && f.motions) || Boolean(f.bodies) };
    /* The panel's controls are the roster's. A game of jointed bodies keeps the
     * ones that mean something for it, under names for what it has. */
    const bodies = Boolean(f.bodies);
    $('#char-label').textContent = bodies ? 'Body' : 'Fighter';
    $('#char-squish-field').hidden = bodies;
    $('#char-travel-field').hidden = !bodies;
    $('#anim-note').hidden = bodies;
    $('#anim-note-bodies').hidden = !bodies;
    for (const b of $('#tabs').children) b.hidden = !on[b.dataset.tab];
    /* One tab left is not a choice; the panel says which game is loaded. */
    $('#tabs').hidden = Object.values(on).filter(Boolean).length < 2;
    return on;
}

/*
 * Everything the loaded build decides, as against everything the page decides.
 *
 * A ROM set can be more than one build — a merged Daytona archive is eight —
 * and swapping between them replaces the tables, the models and the sheets but
 * not the renderer, the canvas or the wiring. So the two are separated: start()
 * runs once and this runs again on every swap.
 */
function loadGameContent() {
    state.viewer.setDepthProfile(state.rom.game.depth);
    state.viewer.material.uniforms.uSolidRamp.value = state.rom.game.colors?.solid ? 1 : 0;
    const on = applyGameFeatures();
    if (on.stage) {
        state.stages = state.rom.game.stageTable.placements
            ? readPlacementStages(state.rom)
            : readStageTable(state.rom);
    }
    if (on.anim && state.rom.game.features.characters) state.frames = readFrameTables(state.rom);
    if (on.anim && state.rom.game.rig) {
        state.bodies = readBodies(state.rom);
        state.motion.list = readMotions(state.rom, state.bodies);
    }
    /* The model the panel opens on is a hand-picked one, and it is only
     * hand-picked for the game it was picked in — in another the same index is
     * as likely to be one of the table's empty entries, which opens the viewer
     * on nothing at all. Fall forward to the first index that draws something.
     * A pointer is not enough to go on: the first entries of both tables carry
     * one and still decode to no geometry. */
    if (!getModel(state.modelIndex)?.positions.length) {
        for (let i = 0; i < Math.min(modelCount(), 512); i++) {
            if (getModel(i)?.positions.length) { state.modelIndex = i; break; }
        }
    }
    $('#loader').hidden = true;

    if (on.stage) renderStageSelect();
    /* The texture picker is for models no stage draws — see useModelScene. A
     * game whose stages carry every set between them does not need it. */
    if (modelsPickTextures()) renderTextureSetPicker();
    if (state.rom.game.modelNames) $('#model-search').placeholder = 'Model index, range (500-520) or name';
    if (on.anim) renderCharacterSelect();
    renderBuildPicker();
    renderModelList();
    switchTab(on.stage ? 'stage' : 'model');
}

function start() {
    /* Build the viewer before swapping panels, so a renderer failure still has
     * the loading screen to report itself on. */
    $('#app').hidden = false;
    state.viewer = new Viewer($('#view'), { touch: isMobile() });
    state.viewer.backfaceCull($('#opt-cull').checked);
    loadGameContent();
    wireOptions();
    state.viewer.resize();

    let frames = 0;
    const tick = () => {
        /* Ahead of the draw, so a swapped frame lands in the same picture as
         * the transform that goes with it. */
        if (state.tab === 'stage' && state.animate) stepStageAnimation(performance.now());
        else if (state.tab === 'anim') {
            if (state.animate) stepMotion(performance.now());
            faceCamera();
        }
        /* Not behind `animate`: a billboard turns with the camera, and the
         * camera moves whether the stage is running or held. */
        if (state.tab === 'stage') { stepBillboards(); stepSky(); }
        state.viewer.render();
        if ((frames++ & 15) === 0) {
            const s = state.viewer.stats;
            $('#stats').textContent = `${s.drawCalls} draws · ${s.triangles.toLocaleString()} tris`;
        }
        requestAnimationFrame(tick);
    };
    tick();

    if (state.rom.warnings.length) console.warn('ROM warnings:', state.rom.warnings);

    /* Handy from the console when checking placements against the real game. */
    window.stf = state;
}

wireDropTarget();
