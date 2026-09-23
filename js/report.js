/*
 * report.js — the diagnostics a bug report needs, and the issue to paste them
 * into.
 *
 * Everything this explorer does happens in the reader's own browser against the
 * reader's own ROM set, so a report that says only "the road flickers" cannot be
 * acted on: which of the thirteen builds, assembled out of which zips, drawn by
 * which GPU, standing where. None of that is visible from the other end, and
 * none of it is something a reader should be expected to dig out by hand.
 *
 * So the button gathers it. What goes in is what would be needed to sit down and
 * reproduce the thing:
 *
 *   - the build, the tab, the stage or model on screen, the texture set and the
 *     shading switches — the state a reader would otherwise have to describe in
 *     prose and would describe incompletely;
 *   - the zips as they were handed over, by name and size, and every complaint
 *     loadRomSet made about them, since a set that is not the bytes the profile
 *     was written against explains a whole class of report on its own;
 *   - where the camera is, because a depth-order fault is a fault at one angle
 *     and not at another;
 *   - the renderer string and whether the context is WebGL 2, since the fill
 *     path is GLSL ES 3.00 and its output is not identical on every driver;
 *   - whatever went to the console, out of the ring buffer index.html installs
 *     before any module loads — a module that fails to parse leaves no other
 *     trace.
 *
 * What does not go in: nothing is read off the ROM but the profile it matched
 * and the labels of the files, nothing is sent anywhere by this module, and the
 * text is put on the clipboard for the reader to read before it is pasted.
 */

const REPO = 'https://github.com/biggestsonicfan/noclip';

/** The build the page was published from, stamped into the head at deploy. */
export function buildStamp() {
    return document.querySelector('meta[name="build"]')?.content || 'unknown';
}

const round = (v, n = 1) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(n)) : v);
const vec = (v, n = 1) => (v ? `${round(v.x, n)}, ${round(v.y, n)}, ${round(v.z, n)}` : '—');

/* The GPU behind the context, where the driver will say. WEBGL_debug_renderer_info
 * is hidden in some browsers; the plain strings are the fallback and are usually
 * just "WebKit WebGL", which is still worth saying rather than nothing. */
function rendererInfo(gl) {
    if (!gl) return { webgl2: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
        webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
}

/**
 * Everything worth knowing about this moment, as plain data.
 *
 * Written to survive a half-loaded page: every read is guarded, because the
 * report is most wanted exactly when something did not come up.
 */
export function collectDiagnostics(state) {
    const d = { site: {}, build: {}, romset: {}, view: {}, renderer: {}, browser: {}, log: [] };

    d.site.url = location.href;
    d.site.stamp = buildStamp();
    d.site.layout = document.documentElement.classList.contains('mobile') ? 'phone' : 'desktop';

    const rom = state?.rom;
    if (rom) {
        d.build.id = rom.game.id;
        d.build.name = rom.game.name;
        d.build.variants = (rom.variants ?? []).map((v) => v.id).join(', ');
        d.build.modelTable = `${rom.game.modelTable.count} entries at 0x${rom.game.modelTable.offset.toString(16)}`;
        d.romset.warnings = rom.warnings ?? [];
    }
    d.romset.files = (state?.romFiles ?? []).map((f) => `${f.name} (${f.size.toLocaleString()} bytes)`);

    /* Which tab, and what it was showing. Only once a set is up: before that
     * the fields are the state the panel starts in, which is about nothing. */
    if (rom) d.view.tab = state?.tab;
    if (rom && state?.tab === 'stage') {
        const st = state.stages?.[state.stageIndex];
        d.view.stage = st ? `${state.stageIndex} · ${st.name}` : String(state.stageIndex);
        d.view.texSets = st?.texSets?.join(', ');
        d.view.layers = Object.entries(state.layerOn ?? {})
            .filter(([, on]) => !on).map(([k]) => k).join(', ') || 'all on';
    } else if (rom && state?.tab === 'model') {
        d.view.model = state.modelIndex;
        d.view.texSetChoice = state.texSetChoice === null ? 'from the model (auto)' : state.texSetChoice;
    } else if (rom && state?.tab === 'anim') {
        d.view.character = state.charIndex;
        d.view.motion = `${state.motion?.id} frame ${state.motion?.frame}`;
    }
    /* Read off the panel, so only worth saying once a set is up: before that
     * these are the markup's own placeholders and not a state anything was in. */
    if (rom) {
        d.view.sheets = document.getElementById('tex-status')?.textContent || undefined;
        d.view.shading = document.getElementById('opt-shading')?.value;
    } else {
        d.view.loaded = 'no ROM set — the report is about the loading screen';
        d.view.loaderError = document.getElementById('loader-error')?.hidden === false
            ? document.getElementById('loader-error').textContent : undefined;
    }
    d.view.transfer = state?.transfer;
    d.view.wireframe = !!state?.wireframe;
    d.view.animate = !!state?.animate;
    d.view.texramPinned = !!state?.texramPinned;
    d.view.lutsPinned = !!state?.lutsPinned;

    const v = state?.viewer;
    if (v) {
        d.view.camera = v.mode;
        d.view.position = vec(v.camera?.position);
        d.view.target = vec(v.orbit?.target);
        d.view.nearFar = `${round(v.camera?.near, 3)} / ${round(v.camera?.far, 0)}`;
        d.view.depth = JSON.stringify(rom?.game?.depth ?? null);
        d.view.stats = `${v.stats?.drawCalls} draws, ${v.stats?.triangles} triangles`;
        d.renderer = rendererInfo(v.renderer?.getContext?.());
        d.renderer.pixelRatio = window.devicePixelRatio;
        d.renderer.canvas = `${v.canvas?.width}x${v.canvas?.height}`;
    }

    d.browser.userAgent = navigator.userAgent;
    d.browser.platform = navigator.userAgentData?.platform ?? navigator.platform;
    d.browser.cores = navigator.hardwareConcurrency;
    d.browser.memory = navigator.deviceMemory;
    d.browser.viewport = `${innerWidth}x${innerHeight}`;

    d.log = (window.__explorerLog ?? []).slice(-40);
    return d;
}

/* A section of `key: value` lines, skipping what there was nothing to say
 * about — an absent field is a fact, but an empty one is noise. */
function section(title, obj) {
    const lines = Object.entries(obj)
        .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`);
    return lines.length ? `**${title}**\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n` : '';
}

/** The issue body: the parts only the reader can write, then the diagnostics. */
export function issueBody(d) {
    const diag = [
        section('Site', d.site),
        section('Build', d.build),
        section('ROM set', { files: d.romset.files, warnings: d.romset.warnings }),
        section('View', d.view),
        section('Renderer', d.renderer),
        section('Browser', d.browser),
        d.log.length ? `**Console**\n\`\`\`\n${d.log.join('\n')}\n\`\`\`\n` : '',
    ].filter(Boolean).join('\n');

    return `### What happened

<!-- What you saw. A screenshot helps more than anything else here — drag one in. -->

### What you expected instead

<!-- -->

### How to get back to it

<!-- Which zips you dropped, which build, which stage or model, and where you
     had to put the camera. The diagnostics below already say where it was when
     you pressed the button. -->

<details>
<summary>Diagnostics</summary>

${diag}
</details>
`;
}

/**
 * Put the report on the clipboard and open the issue form.
 *
 * Both, in that order, and the clipboard is the one that matters: GitHub will
 * not take an arbitrarily long prefilled body — a few kB of URL is as much as
 * it reliably accepts — so a long report is carried by the paste and not by the
 * link. The form is opened either way so there is one click between noticing a
 * fault and reporting it.
 */
export async function fileIssue(state, button) {
    const d = collectDiagnostics(state);
    const body = issueBody(d);
    const title = d.build.name ? `[${d.build.name}] ` : '';

    let copied = false;
    try {
        await navigator.clipboard.writeText(body);
        copied = true;
    } catch {
        /* Denied, or an insecure origin. Fall back to a selection the reader
         * can copy by hand rather than losing the report. */
        const ta = document.createElement('textarea');
        ta.value = body;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
            + 'width:min(720px,90vw);height:60vh;z-index:99;';
        document.body.appendChild(ta);
        ta.select();
        try { copied = document.execCommand('copy'); } catch { copied = false; }
        if (copied) ta.remove();
        else ta.addEventListener('blur', () => ta.remove(), { once: true });
    }

    const url = new URL(`${REPO}/issues/new`);
    url.searchParams.set('title', title);
    /* Prefill only while it fits; past that the link is refused or truncated,
     * and a truncated report is worse than an empty form beside a full
     * clipboard. */
    const withBody = new URL(url);
    withBody.searchParams.set('body', body);
    window.open(withBody.href.length < 6000 ? withBody.href : url.href, '_blank', 'noopener');

    if (button) {
        const was = button.textContent;
        button.textContent = copied ? 'Copied — paste into the issue' : 'Copy it from the box, then paste';
        button.classList.add('done');
        setTimeout(() => { button.textContent = was; button.classList.remove('done'); }, 4000);
    }
    return { copied, body };
}

/** Wire the two buttons in the corner of the view. */
export function wireReportButtons(state) {
    const link = document.getElementById('tool-repo');
    if (link) link.href = REPO;
    const button = document.getElementById('tool-report');
    if (button) button.addEventListener('click', () => fileIssue(state, button));
}
