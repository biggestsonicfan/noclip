/*
 * worklet.js — the sound board on the audio thread.
 *
 * board.js holds the Model 2 board or the Model 1 one as sound.js says,
 * running the game's own sound driver on the 68000. This runs it one render
 * quantum at a time, so the board only ever runs as fast as the speakers take
 * its samples and there is no buffer between the two to fill or starve. The
 * page hands over the ROMs, and after that the only traffic is command bytes,
 * the ones the i960 would send.
 *
 * Both boards make 44.1 kHz; the page asks for a context at that rate, and
 * every current browser gives it one. Where it does not, this steps the
 * board's output across to the context's rate with a linear blend, which is
 * enough for a preview and keeps the pitch right.
 */

import { SoundBoardChip } from './board.js';

const BOARD_RATE = 44100;
const BLOCK = 256;

class Model2Sound extends AudioWorkletProcessor {
    constructor() {
        super();
        this.board = null;
        this.step = BOARD_RATE / sampleRate;
        /* The blend's two board samples and how far between them we are. */
        this.pos = 1;
        this.prev = [0, 0];
        this.next = [0, 0];
        this.bufL = new Float32Array(BLOCK);
        this.bufR = new Float32Array(BLOCK);
        this.bufAt = BLOCK;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        if (m.type === 'init') {
            try {
                this.start(m);
                this.port.postMessage({ type: 'ready' });
            } catch (err) {
                this.port.postMessage({ type: 'error', message: String(err) });
            }
        } else if (m.type === 'send' && this.board) {
            for (const b of m.bytes) this.board.send(b);
        }
    }

    start({ model1, program, samples, warmup }) {
        const board = new SoundBoardChip(model1);
        if (!board.init(new Uint8Array(program), new Uint8Array(samples))) throw new Error('the sound program did not load');
        /* A driver deaf for a while after reset (sound.js `warmup`) runs
         * through it here, unheard, ahead of the first command. */
        for (let left = Math.round(warmup * BOARD_RATE); left > 0; left -= BLOCK)
            board.render(this.bufL, this.bufR, 0, Math.min(left, BLOCK));
        this.board = board;
    }

    /* The next board sample, rendering a block of them when the last is used. */
    pull(into) {
        if (this.bufAt >= BLOCK) {
            this.board.render(this.bufL, this.bufR, 0, BLOCK);
            this.bufAt = 0;
        }
        into[0] = this.bufL[this.bufAt];
        into[1] = this.bufR[this.bufAt];
        this.bufAt++;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!this.board || out.length < 2) return true;
        const l = out[0];
        const r = out[1];
        if (this.step === 1) {
            this.board.render(l, r, 0, l.length);
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
