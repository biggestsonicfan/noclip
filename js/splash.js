/*
 * splash.js — the reel on the loading screen.
 *
 * The clips are the explorer's own pictures, recorded from real sets by
 * stf-tools' record-previews.mjs into media/previews, and listed in index.html under
 * the card of the game they are from. Left alone the reel plays through every
 * game's clips in turn. Hovering a card, focusing it or tapping it hands the
 * reel to that game until the pointer leaves the row of cards; on a phone,
 * where nothing hovers, a tap does it and another tap on the same card lets go.
 * A game with no clips yet takes its turn as a card saying so.
 *
 * Only the clip on screen and the one after it are fetched, and nothing plays once a set has
 * loaded and the loading screen is gone, or while the tab is in the background.
 * Asked for less motion, the reel shows the poster and waits for a click.
 */

const $ = (q) => document.querySelector(q);
const DIR = './media/previews/';
/* How long a game with no clip holds the reel, and one of the others' still
 * frames if its clip will not play. */
const HOLD_MS = 3500;

const loader = $('#loader');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Each game and its clips, off the cards. */
const games = [...document.querySelectorAll('#games .game')].map((card) => ({
    card,
    key: card.dataset.game,
    zip: card.dataset.zip,
    name: card.querySelector('.g-name').textContent.trim(),
    clips: [...card.querySelectorAll('.clips li')].map((li) => ({ src: li.dataset.clip, html: li.innerHTML })),
}));

/* One entry per clip, and one for each game with none, in card order. */
const reelOf = (list) => list.flatMap((g) => (g.clips.length
    ? g.clips.map((c) => ({ game: g, clip: c }))
    : [{ game: g, clip: null }]));
const everything = reelOf(games);

for (const g of games) {
    const first = g.clips[0];
    if (first) g.card.querySelector('.thumb').style.backgroundImage = `url(${DIR}${first.src}.jpg)`;
    else g.card.classList.add('no-clip');
}

let playlist = everything;
let at = 0;
let pinned = null;
let holdTimer = 0;
let paused = reduced;

/*
 * Two video layers, the clip on screen in front. The next clip is fetched into
 * the one behind while the current one plays, and is only brought up once it
 * has a frame to show, fading in over the old one, which runs on under it. So
 * nothing cuts to black while a clip loads, and the caption changes with the
 * picture rather than ahead of it. A change starts FADE_MS before a clip ends,
 * so the fade covers moving pictures instead of a frozen last frame.
 */
const FADE_MS = 600;
const layers = [...document.querySelectorAll('#reel video')];
let front = layers[0];
const other = (v) => (v === layers[0] ? layers[1] : layers[0]);
/* Bumped by every change, so a clip that finishes loading after the reel has
 * moved on does not come up over the one it moved on to. */
let turn = 0;
let fadeTimer = 0;
let capTimer = 0;
const empty = $('#reel-empty');
empty.hidden = false;
empty.classList.add('gone');

/* Point a layer at a clip, fetching it unless the reel is paused. */
function aim(v, clip) {
    const src = `${DIR}${clip.src}.mp4`;
    v.preload = paused ? 'none' : 'auto';
    if (v.dataset.src !== src) {
        v.dataset.src = src;
        v.src = src;
        v.load();
    }
    /* A paused reel shows the poster; a playing one never does, since it is
     * the middle of the clip and would flash up before its first frame. */
    if (paused) v.poster = `${DIR}${clip.src}.jpg`;
    else v.removeAttribute('poster');
}

function caption(game, clip) {
    const cap = $('.reel-cap');
    cap.classList.add('swap');
    clearTimeout(capTimer);
    capTimer = setTimeout(() => {
        $('#reel-game').textContent = game.name;
        $('#reel-text').innerHTML = clip ? clip.html : '';
        cap.classList.remove('swap');
    }, reduced ? 0 : 250);
}

/* Bring layer `v` (or the no-clip card, for null) up over whatever is showing. */
function reveal(v, entry) {
    const old = front;
    $('#reel').classList.toggle('empty', !entry.clip);
    empty.classList.toggle('gone', !!entry.clip);
    if (!entry.clip) {
        empty.querySelector('#reel-empty-name').textContent = entry.game.name;
        $('#reel-empty-zip').textContent = entry.game.zip;
    }
    caption(entry.game, entry.clip);
    if (v) { v.classList.add('front'); front = v; }
    if (old !== v) old.classList.remove('front');
    /* Once the old layer has faded out it stops, and fetches the clip after
     * this one so the next change is ready too. */
    clearTimeout(fadeTimer);
    const mine = turn;
    fadeTimer = setTimeout(() => {
        if (mine !== turn) return;
        /* With no clip up, neither layer is showing; the next change uses
         * the one that was not in front. */
        const spare = other(front);
        if (!v) front.pause();
        spare.pause();
        const after = playlist[(at + 1) % playlist.length];
        if (!paused && playlist.length > 1 && after.clip) aim(spare, after.clip);
    }, reduced ? 0 : FADE_MS);
}

function show(i) {
    at = (i + playlist.length) % playlist.length;
    const entry = playlist[at];
    const { game, clip } = entry;
    const mine = ++turn;
    clearTimeout(holdTimer);
    for (const g of games) g.card.classList.toggle('active', g === game);
    renderDots();
    if (!clip) {
        reveal(null, entry);
        if (!paused) holdTimer = setTimeout(next, HOLD_MS);
        return;
    }
    const src = `${DIR}${clip.src}.mp4`;
    /* The clip already on screen (a pinned game going round, or the reel
     * picking up again) carries on in place; any other goes to the back layer. */
    const same = front.dataset.src === src && front.classList.contains('front');
    const v = same ? front : other(front);
    aim(v, clip);
    /* A pinned game with a single clip just goes round it. */
    v.loop = playlist.length === 1;
    if (!same && v.currentTime) v.currentTime = 0;
    v.dataset.turn = String(mine);
    let went = false;
    const go = () => {
        if (mine !== turn || went) return;
        went = true;
        if (!same) reveal(v, entry);
        if (!paused && running()) v.play().catch(() => { if (mine === turn) holdTimer = setTimeout(next, HOLD_MS); });
    };
    /* Paused, there is no clip to wait for: the poster comes up at once. */
    /* Whichever says so first: a layer fetched ahead has had its loadeddata
     * already, and a rewind to the start reports seeked instead. */
    if (same || paused || v.readyState >= 2) go();
    else for (const e of ['loadeddata', 'canplay', 'seeked']) v.addEventListener(e, go, { once: true });
}

const next = () => show(at + 1);

function renderDots() {
    const dots = $('#reel-dots');
    dots.replaceChildren(...playlist.map((e, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = i === at ? 'on' : '';
        b.setAttribute('aria-label', `Clip ${i + 1} of ${playlist.length}: ${e.game.name}`);
        b.addEventListener('click', (ev) => { ev.stopPropagation(); show(i); });
        return b;
    }));
}

/* Hand the reel to one game, or back to all of them. */
function pin(game) {
    if (game === pinned) return;
    pinned = game;
    const cur = playlist[at];
    playlist = game ? reelOf([game]) : everything;
    for (const g of games) g.card.classList.toggle('pinned', g === game);
    /* Letting go carries on from where the pinned game had got to. */
    const back = game ? 0 : Math.max(0, playlist.findIndex((e) => e.game === cur.game && e.clip === cur.clip));
    show(back);
}

const running = () => !loader.hidden && !document.hidden;

for (const v of layers) {
    /* Only the layer in front moves the reel on, and only once a turn. */
    const mine = () => v === front && v.dataset.turn === String(turn);
    const onward = () => { if (mine() && !v.loop) { v.dataset.turn = ''; next(); } };
    v.addEventListener('timeupdate', () => {
        if (!reduced && v.duration && v.currentTime >= v.duration - FADE_MS / 1000) onward();
    });
    v.addEventListener('ended', onward);
    /* A clip that cannot be fetched should not stop the reel on a black frame. */
    v.addEventListener('error', () => {
        if (v.dataset.turn === String(turn) && v.getAttribute('src')) holdTimer = setTimeout(next, HOLD_MS);
    });
}

/* A mouse over a card hands it the reel for as long as the pointer is over the
 * cards at all, so moving from one card to the next does not flick back to the
 * full reel. A touch has no hover, so a tap hands it over and a second tap on
 * the same card lets go. The pointer's type is read off pointerdown because not
 * every browser's click says what made it. Keyboard focus counts as a hover. */
const row = $('#games');
let touch = false;
row.addEventListener('pointerdown', (e) => { touch = e.pointerType !== 'mouse'; });
for (const g of games) {
    g.card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') pin(g); });
    g.card.addEventListener('focus', () => { if (g.card.matches(':focus-visible')) pin(g); });
    g.card.addEventListener('click', () => {
        if (touch && pinned === g) pin(null);
        else pin(g);
        /* On a phone the reel may be scrolled out of sight by now. */
        if (touch) $('#reel').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    });
    g.card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); touch = false; g.card.click(); }
    });
}
row.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !row.contains(document.activeElement)) pin(null);
});
row.addEventListener('focusout', (e) => {
    if (!touch && !row.contains(e.relatedTarget) && !row.matches(':hover')) pin(null);
});

/* Asked for less motion, or paused by a click: the play button starts it. */
function setPaused(p) {
    paused = p;
    $('#reel-play').hidden = !p;
    if (p) { front.pause(); clearTimeout(holdTimer); } else show(at);
}
$('#reel-play').addEventListener('click', (e) => { e.stopPropagation(); setPaused(false); });
$('#reel').addEventListener('click', () => setPaused(!paused));

/* Stop for good once a set is up, and hold while the tab is out of sight. */
new MutationObserver(() => {
    if (loader.hidden) { for (const v of layers) v.pause(); clearTimeout(holdTimer); } else if (!paused) show(at);
}).observe(loader, { attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('visibilitychange', () => {
    if (document.hidden) front.pause();
    else if (!paused && running() && playlist[at].clip) front.play().catch(() => {});
});

$('#reel-play').hidden = !paused;
show(0);
