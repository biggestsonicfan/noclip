/*
 * splash.js — the reel on the loading screen.
 *
 * The clips are the explorer's own pictures, recorded from real sets by
 * tools/record-previews.mjs into media/previews, and listed in index.html under
 * the card of the game they are from. Left alone the reel plays through every
 * game's clips in turn. Hovering a card, focusing it or tapping it hands the
 * reel to that game until the pointer leaves the row of cards; on a phone,
 * where nothing hovers, a tap does it and another tap on the same card lets go.
 * A game with no clips yet takes its turn as a card saying so.
 *
 * Only the clip on screen is ever fetched, and nothing plays once a set has
 * loaded and the loading screen is gone, or while the tab is in the background.
 * Asked for less motion, the reel shows the poster and waits for a click.
 */

const $ = (q) => document.querySelector(q);
const DIR = './media/previews/';
/* How long a game with no clip holds the reel, and one of the others' still
 * frames if its clip will not play. */
const HOLD_MS = 3500;

const loader = $('#loader');
const video = $('#reel-video');
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

function show(i) {
    at = (i + playlist.length) % playlist.length;
    const { game, clip } = playlist[at];
    clearTimeout(holdTimer);
    for (const g of games) g.card.classList.toggle('active', g === game);
    $('#reel-game').textContent = game.name;
    $('#reel').classList.toggle('empty', !clip);
    $('#reel-empty').hidden = !!clip;
    if (clip) {
        $('#reel-text').innerHTML = clip.html;
        video.poster = `${DIR}${clip.src}.jpg`;
        video.src = `${DIR}${clip.src}.mp4`;
        /* A pinned game with a single clip just goes round it. */
        video.loop = playlist.length === 1;
        if (!paused && running()) video.play().catch(() => { holdTimer = setTimeout(next, HOLD_MS); });
    } else {
        video.removeAttribute('src');
        video.removeAttribute('poster');
        video.load();
        $('#reel-text').textContent = '';
        $('#reel-empty-name').textContent = game.name;
        $('#reel-empty-zip').textContent = game.zip;
        if (!paused) holdTimer = setTimeout(next, HOLD_MS);
    }
    renderDots();
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

video.addEventListener('ended', () => { if (!video.loop) next(); });
/* A clip that cannot be fetched should not stop the reel on a black frame. */
video.addEventListener('error', () => { if (video.getAttribute('src')) holdTimer = setTimeout(next, HOLD_MS); });

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
    if (p) { video.pause(); clearTimeout(holdTimer); } else show(at);
}
$('#reel-play').addEventListener('click', (e) => { e.stopPropagation(); setPaused(false); });
$('#reel').addEventListener('click', () => setPaused(!paused));

/* Stop for good once a set is up, and hold while the tab is out of sight. */
new MutationObserver(() => {
    if (loader.hidden) { video.pause(); clearTimeout(holdTimer); } else if (!paused) show(at);
}).observe(loader, { attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else if (!paused && running() && playlist[at].clip) video.play().catch(() => {});
});

$('#reel-play').hidden = !paused;
show(0);
