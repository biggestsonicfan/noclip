/*
 * sound.js — the game's music, played by the game's own sound board.
 *
 * Nothing here is a recording or a guess at one. Each game's sound board runs
 * the game's own sound driver out of its program ROM, and the page runs an
 * emulation of that board, built to WebAssembly, on the audio thread
 * (worklet.js). It is told what to play the way the i960 tells it: commands
 * down its UART. There are two boards (`game.sound.board`):
 *
 * - 'model2', the Model 2 board: a 68000 and a Yamaha SCSP. m2-hle2 emulates
 *   it and grades it against MAME's, and board.wasm is that emulation
 *   (tools/sound/board.c). Sonic The Fighters.
 * - 'model1', the board the original Model 2 kept from Model 1: a 68000, two
 *   MultiPCM sample chips and a YM3438. model1.wasm is MAME's own chips on
 *   m2-hle2's 68000 (tools/sound/model1.c). Daytona USA.
 *
 * It costs nothing until it is switched on. Then it reads the sound ROMs out of
 * the zips — the program and 8 MB of samples, which the views never touch —
 * and runs the board at a few per cent of one core. Switched off, the audio
 * context is suspended and the board stops with it.
 */

/* What the Model 2 board is sent. ROUND_INT and the boot path send all sound
 * off and two settings the driver wants from the game first (m2-hle2
 * tools/snd_stimuli.py opens every capture with the same three); each new
 * stage starts with all sound off again. A game on the Model 1 board names its
 * own, in games.js. */
const MODEL2 = {
    wasm: 'board.wasm',
    boot: [0xA0, 0x00, 0x01, 0xA0, 0x00, 0x03, 0xA0, 0x03, 0x60],
    stop: [0xA0, 0x00, 0x01],
};

function boardOf(spec) {
    if (spec.board !== 'model1') return MODEL2;
    return { wasm: 'model1.wasm', boot: spec.boot, stop: spec.stop };
}

/* A command as the i960 sends it: the status byte and two 7-bit data bytes. */
export function commandBytes(code) {
    return [(code >>> 16) & 0xFF, (code >>> 8) & 0x7F, code & 0x7F];
}

/* The songs the game can start a stage with, when it lets the player pick one
 * (Daytona's VR buttons): [{ code, label }], or null. */
export function musicChoices(rom) {
    const m = rom.game.sound?.music;
    if (!m) return null;
    return m.buttons.map((label, i) => ({ label, code: songAt(rom, i) }));
}

function songAt(rom, index) {
    const m = rom.game.sound.music;
    return rom[`${m.region}View`].getUint32(m.table + index * 4, true);
}

/* The song a stage slot starts with — its own, or `pick` (an index into
 * musicChoices) where the game lets the player choose — as { code, index },
 * code 0 for none. */
export function stageMusic(rom, slot, pick = -1) {
    const spec = rom.game.sound;
    if (spec?.music) {
        const index = pick >= 0 ? pick : slot & spec.music.slotMask;
        return { code: songAt(rom, index), index };
    }
    const at = spec?.stageMusic;
    if (at === undefined) return { code: 0, index: -1 };
    return { code: rom.mainCpuView.getUint32(at + (slot & 0xF) * 4, true), index: slot & 0xF };
}

export function soundSupported(game) {
    return !!game.sound && typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined';
}

export class SoundBoard {
    constructor() {
        this.ctx = null;
        this.node = null;
        this.gain = null;
        this.starting = null;
        this.game = null;
    }

    /* Read the ROMs and boot the board, once per ROM set. */
    start(rom, onProgress = () => {}) {
        if (this.game === rom.game.id && this.starting) return this.starting;
        this.close();
        this.game = rom.game.id;
        this.starting = this.boot(rom, onProgress).catch((err) => {
            this.close();
            throw err;
        });
        return this.starting;
    }

    async boot(rom, onProgress) {
        const spec = rom.game.sound;
        this.kind = boardOf(spec);
        this.spec = spec;
        /* Asked for at the board's own rate so nothing resamples it; a browser
         * that will not is caught up in the worklet. Created here, inside the
         * click that switched the music on, which is what lets it start. */
        let ctx;
        try {
            ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
        } catch {
            ctx = new AudioContext({ latencyHint: 'playback' });
        }
        this.ctx = ctx;
        const resumed = ctx.resume();
        const [wasm] = await Promise.all([
            fetch(new URL(`./${this.kind.wasm}`, import.meta.url)).then((r) => {
                if (!r.ok) throw new Error(`${this.kind.wasm}: ${r.status}`);
                return r.arrayBuffer();
            }),
            ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url)),
        ]);

        onProgress('reading the sound program');
        /* One program chip, or several laid end to end as the region
         * loads them. */
        const chips = typeof spec.program[0] === 'string' ? [spec.program] : spec.program;
        const parts = [];
        for (const chip of chips) parts.push(await rom.readChip(...chip));
        const program = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        parts.reduce((at, p) => (program.set(p, at), at + p.length), 0);
        const size = spec.samples.length * 0x200000;
        const samples = new Uint8Array(size);
        for (let i = 0; i < spec.samples.length; i++) {
            onProgress(`reading sample ROM ${i + 1} of ${spec.samples.length}`);
            samples.set(await rom.readChip(...spec.samples[i]), i * 0x200000);
        }

        const node = new AudioWorkletNode(ctx, 'model2-sound', {
            numberOfInputs: 0, outputChannelCount: [2],
        });
        const ready = new Promise((resolve, reject) => {
            node.port.onmessage = (e) => {
                if (e.data.type === 'ready') resolve();
                else if (e.data.type === 'error') reject(new Error(e.data.message));
            };
        });
        const prog = program.slice().buffer;
        node.port.postMessage({ type: 'init', wasm, program: prog, samples: samples.buffer },
            [wasm, prog, samples.buffer]);
        await ready;
        this.gain = new GainNode(ctx, { gain: this.volume ?? 2 });
        node.connect(this.gain).connect(ctx.destination);
        this.node = node;
        this.send(this.kind.boot);
        await resumed;
    }

    send(bytes) {
        this.node?.port.postMessage({ type: 'send', bytes });
    }

    /* Stop what is playing and start `code`, or just stop for 0. `index`
     * is the song's place in the game's table, for a game that sends more
     * than the song for some of them (game.sound.after). */
    play(code, index = -1) {
        const stop = this.kind.stop;
        if (!code) { this.send(stop); return; }
        const after = this.spec.after;
        this.send([...stop, ...commandBytes(code),
            ...(after?.song?.[index] ?? []), ...(after?.every ?? [])]);
    }

    setVolume(v) {
        this.volume = v;
        if (this.gain) this.gain.gain.value = v;
    }

    suspend() { return this.ctx?.suspend(); }
    resume() { return this.ctx?.resume(); }

    close() {
        this.node?.disconnect();
        this.ctx?.close();
        this.ctx = this.node = this.gain = this.starting = null;
        this.game = null;
    }
}
