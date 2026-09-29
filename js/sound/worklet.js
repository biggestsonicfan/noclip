/*
 * worklet.js — the sound board on the audio thread.
 *
 * board.wasm is m2-hle2's Model 2 sound board (tools/sound/board.c): the
 * game's own 68000 driver and the SCSP it plays through. This runs it one
 * render quantum at a time, so the board only ever runs as fast as the
 * speakers take its samples and there is no buffer between the two to fill or
 * starve. The page hands over the wasm's bytes with the ROMs — not a compiled
 * module, which Chrome drops on the way to a worklet without a word — and
 * after that the only traffic is command bytes, the ones the i960 would send.
 *
 * The board makes 44.1 kHz. The page asks for a context at that rate, and
 * every current browser gives it one; where it gets another, this steps the
 * board's output across to it with a linear blend, which is enough for a
 * preview and keeps the pitch right.
 */

const BOARD_RATE = 44100;

class Model2Sound extends AudioWorkletProcessor {
    constructor() {
        super();
        this.board = null;
        this.step = BOARD_RATE / sampleRate;
        /* The blend's two board samples and how far between them we are. */
        this.pos = 1;
        this.prev = [0, 0];
        this.next = [0, 0];
        this.buf = null;
        this.bufAt = 0;
        this.bufLen = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        if (m.type === 'init') {
            this.start(m).then(
                () => this.port.postMessage({ type: 'ready' }),
                (err) => this.port.postMessage({ type: 'error', message: String(err) }));
        } else if (m.type === 'send' && this.board) {
            for (const b of m.bytes) this.board.snd_send(b);
        }
    }

    async start({ wasm, program, samples }) {
        /* One import, and only if the heap ever has to grow — it does not:
         * the build's initial memory holds the sample ROMs outright. */
        const { instance: inst } = await WebAssembly.instantiate(wasm, {
            env: { emscripten_notify_memory_growth: () => {} },
        });
        const e = inst.exports;
        e._initialize();
        const prog = new Uint8Array(program);
        const smp = new Uint8Array(samples);
        const pp = e.snd_alloc(prog.length);
        const sp = e.snd_alloc(smp.length);
        new Uint8Array(e.memory.buffer, pp, prog.length).set(prog);
        new Uint8Array(e.memory.buffer, sp, smp.length).set(smp);
        if (!e.snd_init(pp, prog.length, sp, smp.length)) throw new Error('the sound program did not load');
        this.board = e;
    }

    /* The next board sample, rendering a block of them when the last is used. */
    pull(into) {
        if (this.bufAt >= this.bufLen) {
            const e = this.board;
            this.bufLen = e.snd_render(256);
            this.buf = new Float32Array(e.memory.buffer, e.snd_out(), this.bufLen * 2);
            this.bufAt = 0;
        }
        into[0] = this.buf[this.bufAt * 2];
        into[1] = this.buf[this.bufAt * 2 + 1];
        this.bufAt++;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!this.board || out.length < 2) return true;
        const l = out[0];
        const r = out[1];
        const e = this.board;
        if (this.step === 1) {
            const n = e.snd_render(l.length);
            const f = new Float32Array(e.memory.buffer, e.snd_out(), n * 2);
            for (let i = 0; i < n; i++) {
                l[i] = f[i * 2];
                r[i] = f[i * 2 + 1];
            }
            return true;
        }
        for (let i = 0; i < l.length; i++) {
            while (this.pos >= 1) {
                this.prev[0] = this.next[0];
                this.prev[1] = this.next[1];
                this.pull(this.next);
                this.pos -= 1;
            }
            const t = this.pos;
            l[i] = this.prev[0] + (this.next[0] - this.prev[0]) * t;
            r[i] = this.prev[1] + (this.next[1] - this.prev[1]) * t;
            this.pos += this.step;
        }
        return true;
    }
}

registerProcessor('model2-sound', Model2Sound);
