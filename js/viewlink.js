/*
 * viewlink.js — a link that puts the explorer back where a report was filed.
 *
 * A bug report carries the diagnostics, but "stage 3, noclip, somewhere over
 * the ring" still has to be found again by hand, and the angle a depth-order
 * fault shows at is exactly the thing prose gets wrong. So the report carries a
 * link as well: the build, the tab, what it was showing, the panel's switches
 * and the camera to the third decimal.
 *
 * The ROM set is not in it and cannot be — the page never fetches one. What the
 * link does is name the build, so the loading screen can say which zips to drop,
 * and once they are dropped it loads that build of them and opens on the view.
 *
 * The view goes in the fragment rather than the query, for two reasons. The
 * query is the layout's: ?mobile and ?desktop are read by the inline detector in
 * index.html and rewritten by the layout switch, which would throw anything else
 * there away. And a fragment is never sent to the server, which is in keeping
 * with a page that sends nothing anywhere.
 *
 * Only what differs from the page's defaults is written, so a link from a fresh
 * load is short and one from a long session says what was changed.
 */

import { GAMES } from './games.js';

/** Where a link points: the published site, whatever the reporter was on. */
export const SITE = 'https://noclip.sonicthefighte.rs/';

/*
 * The panel's switches, by the key they go into the link under.
 *
 * Grouped by tab, because a control belongs to the view it is on: the Animation
 * tab's squish checkbox rebuilds the rig when it changes, and replayed on the
 * Stages tab it would draw one into the arena. `def` is the value a fresh load
 * shows where the markup does not say — a select filled in at runtime has no
 * option marked as the default.
 */
const CONTROLS = {
    all: [
        { key: 'shade', sel: '#shade-mode', def: '0' },
        { key: 'transfer', sel: '#transfer-mode', def: '0' },
        { key: 'animate', sel: '#opt-anim' },
        { key: 'wire', sel: '#opt-wire' },
        { key: 'grid', sel: '#opt-grid' },
        { key: 'axes', sel: '#opt-axes' },
        { key: 'cull', sel: '#opt-cull' },
        { key: 'luma', sel: '#tex-luma' },
    ],
    stage: [
        { key: 'ride', sel: '#opt-ride' },
    ],
    model: [
        { key: 'q', sel: '#model-search' },
        { key: 'mesh', sel: '#model-only-mesh' },
        { key: 'texset', sel: '#model-texset', def: 'auto' },
        { key: 'fighter', sel: '#model-fighter', def: '0' },
    ],
    anim: [
        { key: 'skel', sel: '#char-skel' },
        { key: 'squish', sel: '#char-squish' },
        { key: 'travel', sel: '#char-travel' },
        { key: 'vent', sel: '#exhaust-open' },
    ],
};

const controlsFor = (tab) => [...CONTROLS.all, ...(CONTROLS[tab] ?? [])];

/* A control's value as it goes into the link, and the value it started at. */
const valueOf = (n) => (n.type === 'checkbox' ? (n.checked ? '1' : '0') : n.value);
const defaultOf = (n, c) => (n.type === 'checkbox' ? (n.defaultChecked ? '1' : '0')
    : c.def ?? n.defaultValue);

const num = (v, n) => Number(v.toFixed(n));
const triple = (p, n = 3) => `${num(p.x, n)},${num(p.y, n)},${num(p.z, n)}`;

/**
 * The link to this moment, or the bare site before a set is loaded — there is
 * no view to go back to on the loading screen.
 */
export function viewLink(state) {
    const url = new URL(SITE);
    url.search = document.documentElement.classList.contains('mobile') ? '?mobile' : '?desktop';
    const rom = state?.rom;
    const v = state?.viewer;
    if (!rom || !v) return url.href;

    const p = new URLSearchParams();
    p.set('game', rom.game.id);
    p.set('tab', state.tab);
    if (state.tab === 'stage') {
        p.set('stage', state.stageIndex);
        const off = Object.entries(state.layerOn).filter(([, on]) => !on).map(([k]) => k);
        if (off.length) p.set('off', off.join(','));
        /* The stage clock: which frame of the palms, the carpet and the sea.
         * -1 is a stage that has not stepped yet, which is where a load starts. */
        if (state.anim.frame >= 0) p.set('t', state.anim.frame);
    } else if (state.tab === 'model') {
        p.set('model', state.modelIndex);
    } else if (state.tab === 'anim') {
        const m = state.motion;
        p.set('char', state.charIndex);
        /* A slot is what a fighter's action table names, and it stays the same
         * move across a change of fighter; the id is for a motion browsed out
         * of the table directly, and for a body, which has no slots. */
        if (m.slot >= 0) p.set('slot', m.slot);
        else p.set('motion', m.id);
        /* The display counter rather than the frame: the frame is the counter
         * folded into the motion's length, and Tails' tails run off the
         * counter unfolded. */
        p.set('tick', m.tick);
        if (!m.playing) p.set('paused', '1');
    }

    for (const c of controlsFor(state.tab)) {
        const n = document.querySelector(c.sel);
        /* A control the loaded game does not show is not a choice anyone made. */
        if (!n || n.closest('[hidden]')) continue;
        const val = valueOf(n);
        if (val !== defaultOf(n, c)) p.set(c.key, val);
    }

    /* Orbit is its target and where the eye stands; noclip is where it stands
     * and which way it faces, since it looks at nothing in particular. Both
     * are written either way, so a switch of rig after the link opens does not
     * lose the other one. */
    p.set('cam', v.mode);
    p.set('pos', triple(v.camera.position));
    p.set('target', triple(v.orbit.target));
    p.set('look', `${num(v.fly.yaw, 4)},${num(v.fly.pitch, 4)}`);
    p.set('speed', num(v.fly.speed, 2));

    url.hash = p.toString();
    return url.href;
}

/**
 * The view a link asks for, or null when the page was opened without one. Only
 * shape is checked here; whether stage 40 exists is a question for the build.
 */
export function readViewLink(hash = location.hash) {
    const p = new URLSearchParams(hash.replace(/^#/, ''));
    if (!p.get('game')) return null;
    const vec = (s, n) => {
        const a = (s ?? '').split(',').map(Number);
        return a.length === n && a.every(Number.isFinite) ? a : null;
    };
    const int = (s) => (s !== null && /^-?\d+$/.test(s) ? Number(s) : null);
    return {
        game: p.get('game'),
        tab: ['stage', 'model', 'anim'].includes(p.get('tab')) ? p.get('tab') : null,
        stage: int(p.get('stage')),
        model: int(p.get('model')),
        char: int(p.get('char')),
        slot: int(p.get('slot')),
        motion: int(p.get('motion')),
        tick: int(p.get('tick')),
        paused: p.get('paused') === '1',
        off: (p.get('off') ?? '').split(',').filter(Boolean),
        t: int(p.get('t')),
        cam: p.get('cam') === 'fly' ? 'fly' : 'orbit',
        pos: vec(p.get('pos'), 3),
        target: vec(p.get('target'), 3),
        look: vec(p.get('look'), 2),
        speed: Number(p.get('speed')) || null,
        controls: p,
    };
}

/**
 * Put the panel's switches where the link has them, by setting each control
 * and firing the event its handler listens for — so a switch restored this way
 * does exactly what a click would, and nothing here has to know what that is.
 * Only a control that differs is touched, since some of them rebuild the scene.
 */
export function applyLinkControls(link, tab) {
    for (const c of controlsFor(tab)) {
        const n = document.querySelector(c.sel);
        const want = link.controls.get(c.key) ?? (n ? defaultOf(n, c) : null);
        if (!n || n.closest('[hidden]') || want === null || valueOf(n) === want) continue;
        if (n.type === 'checkbox') n.checked = want === '1';
        else n.value = want;
        /* A value the control has no option for leaves it where it was. */
        if (valueOf(n) !== want) continue;
        const live = n.type === 'range' || n.type === 'search';
        n.dispatchEvent(new Event(live ? 'input' : 'change', { bubbles: true }));
    }
}

/** A line for the loading screen: which game the link wants, and what to drop. */
export function describeViewLink(link) {
    const g = GAMES.find((x) => x.id === link.game);
    const where = {
        stage: link.stage !== null ? `stage ${link.stage}` : 'the Stages tab',
        model: link.model !== null ? `model ${link.model}` : 'the Models tab',
        anim: 'the Animation tab',
    }[link.tab] ?? 'a view';
    const cam = link.cam === 'fly' ? 'noclip' : 'orbit';
    if (!g) {
        return `This link was made on a build this version of the explorer does not know `
            + `(<code>${escape(link.game)}</code>), so it will open on the default view.`;
    }
    return `This link reopens <b>${g.name}</b> on ${where}, ${cam} camera. Drop the `
        + `<code>${g.id}</code> set &mdash; <code>${g.id}.zip</code>, with its parent's zip `
        + `if yours is split &mdash; and it opens where the link left off.`;
}

function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
