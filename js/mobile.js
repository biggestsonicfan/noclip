/*
 * mobile.js — the phone site: a bottom sheet where the sidebar was, and a
 * touch rig for the noclip camera.
 *
 * Which site this is was decided before the stylesheet applied, by the inline
 * script in index.html; the class it puts on <html> is what the mobile rules in
 * style.css key on and what isMobile() reads back, so the layout and the code
 * never disagree. Everything here is wired on both sites — the sheet's header
 * is only a toggle when the CSS makes it one — which is what lets setMobile
 * flip between them in place instead of reloading and losing the ROM.
 */

const $ = (sel) => document.querySelector(sel);

export function isMobile() {
    return document.documentElement.classList.contains('mobile');
}

/**
 * Switch sites without a reload, and put the choice in the URL so a reload
 * keeps it — the inline detector reads ?mobile and ?desktop ahead of the user
 * agent.
 */
export function setMobile(on) {
    document.documentElement.classList.toggle('mobile', on);
    const url = new URL(location.href);
    url.search = on ? '?mobile' : '?desktop';
    history.replaceState(null, '', url);
}

/**
 * The sidebar as a bottom sheet. Collapsed, it is the title and the tab strip
 * along the bottom edge; open, it climbs over the lower part of the view and
 * scrolls. The handle and title toggle it; a tab both switches and opens, which
 * the tab handler in app.js does.
 *
 * The collapsed height is published as --peek on <html>, so the things that
 * have to stand clear of the sheet — the noclip stick — can.
 */
export function wireSheet() {
    const sheet = $('#sidebar');
    const header = sheet.querySelector('header');
    header.addEventListener('click', (e) => {
        if (e.target.closest('#tabs')) return;
        sheet.classList.toggle('open');
    });

    const publish = () => {
        document.documentElement.style.setProperty('--peek', `${header.offsetHeight}px`);
    };
    new ResizeObserver(publish).observe(header);
    publish();

    return {
        open() { sheet.classList.add('open'); },
        close() { sheet.classList.remove('open'); },
    };
}

/**
 * A stick and two buttons for the fly rig, standing in for WASD and Q/E. The
 * stick is analog — its throw is the speed — and looking around is a drag on
 * the view, which FlyControls handles itself.
 */
export function wireTouchFly(fly) {
    const pad = $('#touch-fly');
    const stick = $('#stick');
    const knob = stick.querySelector('.knob');
    let active = null;
    let cx = 0, cy = 0;

    const set = (dx, dy) => {
        const r = stick.clientWidth / 2;
        const len = Math.hypot(dx, dy);
        if (len > r) { dx *= r / len; dy *= r / len; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        fly.pad.move.set(dx / r, dy / r);
    };
    stick.addEventListener('pointerdown', (e) => {
        if (active !== null) return;
        active = e.pointerId;
        stick.setPointerCapture(e.pointerId);
        const b = stick.getBoundingClientRect();
        cx = b.left + b.width / 2;
        cy = b.top + b.height / 2;
        set(e.clientX - cx, e.clientY - cy);
        e.preventDefault();
    });
    stick.addEventListener('pointermove', (e) => {
        if (e.pointerId === active) set(e.clientX - cx, e.clientY - cy);
    });
    const release = (e) => {
        if (e.pointerId !== active) return;
        active = null;
        set(0, 0);
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);

    for (const b of pad.querySelectorAll('[data-up]')) {
        const dir = +b.dataset.up;
        b.addEventListener('pointerdown', (e) => {
            fly.pad.up = dir;
            b.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        const lift = () => { if (fly.pad.up === dir) fly.pad.up = 0; };
        b.addEventListener('pointerup', lift);
        b.addEventListener('pointercancel', lift);
        /* A held button is a long press, and a long press is a context menu. */
        b.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    return {
        show(on) {
            pad.hidden = !on;
            if (!on) {
                fly.pad.move.set(0, 0);
                fly.pad.up = 0;
            }
        },
    };
}
