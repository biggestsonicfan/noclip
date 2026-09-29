/*
 * sound.js — the game's music, played by the game's own sound board.
 *
 * Nothing here is a recording or a guess at one. The Model 2 sound board is a
 * 68000 running the game's sound driver out of its program ROM, playing the
 * sample ROMs through a Yamaha SCSP; m2-hle2 emulates that board and grades it
 * against MAME's, and board.wasm is that emulation built for the page
 * (tools/sound/board.c). It runs on the audio thread (worklet.js) and is told
 * what to play the way the i960 tells it: three-byte commands down its UART.
 *
 * It costs nothing until it is switched on. Then it reads the sound ROMs out of
 * the zips — the program and 8 MB of samples, which the views never touch —
 * and runs the board at about 3% of one core: the wasm makes a second of sound
 * in 30 ms. Switched off, the audio context is suspended and the board stops
 * with it.
 */

/* What ROUND_INT and the boot path send before any music: all sound off, and
 * two settings the driver wants from the game first (m2-hle2
 * tools/snd_stimuli.py opens every capture with the same three). */
const BOOT = [0xA0, 0x00, 0x01, 0xA0, 0x00, 0x03, 0xA0, 0x03, 0x60];
/* All sound off — the first thing ROUND_INT sends, before the new stage's song. */
const STOP = [0xA0, 0x00, 0x01];

/* A command as the i960 sends it: the status byte and two 7-bit data bytes. */
export function commandBytes(code) {
    return [(code >>> 16) & 0xFF, (code >>> 8) & 0x7F, code & 0x7F];
}

/* The song stage_bgm_select plays on a stage slot, or 0 for none. */
export function stageMusic(rom, slot) {
    const at = rom.game.sound?.stageMusic;
    if (at === undefined) return 0;
    return rom.mainCpuView.getUint32(at + (slot & 0xF) * 4, true);
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
            fetch(new URL('./board.wasm', import.meta.url)).then((r) => {
                if (!r.ok) throw new Error(`board.wasm: ${r.status}`);
                return r.arrayBuffer();
            }),
            ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url)),
        ]);

        onProgress('reading the sound program');
        const program = await rom.readChip(...spec.program);
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
        this.send(BOOT);
        await resumed;
    }

    send(bytes) {
        this.node?.port.postMessage({ type: 'send', bytes });
    }

    /* Stop what is playing and start `code`, or just stop for 0. */
    play(code) {
        this.send(code ? [...STOP, ...commandBytes(code)] : STOP);
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
