/*
 * dsbworklet.js — a Digital Sound Board's MPEG player on the audio thread.
 *
 * The page hands over the MPEG ROM once, then a song at a time as dsb.js
 * reads it out of the board's table. This decodes a frame whenever the last
 * one is used up, so it only ever runs as fast as the speakers take it, and
 * goes from part to part as the board's program would have the decoder do.
 * The board makes 32 kHz; this steps it across to the context's rate with a
 * linear blend, as worklet.js does.
 */

import { MpegAudio } from './mpeg.js';

class DsbSound extends AudioWorkletProcessor {
    constructor() {
        super();
        this.mpeg = null;
        this.song = null;
        this.rate = 32000;
        this.pos = 1;
        this.prev = [0, 0];
        this.next = [0, 0];
        this.buf = new Int16Array(1152 * 2);
        this.bufAt = 0;
        this.bufLen = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        if (m.type === 'init') {
            this.mpeg = new MpegAudio(new Uint8Array(m.rom));
            this.port.postMessage({ type: 'ready' });
        } else if (m.type === 'play') {
            this.song = m.song;
            this.part = 0;
            this.bit = m.song ? m.song.parts[0][0] * 8 : 0;
            this.bufAt = this.bufLen = 0;
            /* A part that gives no frame at all, twice running, would spin. */
            this.empty = 0;
        }
    }

    /* The next frame of the song, going on to the next part at the end of
     * one; false once it has stopped. */
    decode() {
        const s = this.song;
        while (s) {
            const r = this.mpeg.decode(this.bit, s.parts[this.part][1] * 8, this.buf);
            if (r) {
                this.bit = r.pos;
                this.bufLen = r.samples;
                this.bufAt = 0;
                this.rate = r.rate;
                this.empty = 0;
                return true;
            }
            if (++this.empty > 2) break;
            this.part++;
            if (this.part >= s.parts.length) {
                if (s.loop < 0) break;
                this.part = s.loop;
            }
            this.bit = s.parts[this.part][0] * 8;
        }
        this.song = null;
        return false;
    }

    pull(into) {
        if (this.bufAt >= this.bufLen && !this.decode()) {
            into[0] = into[1] = 0;
            return;
        }
        const s = this.song, b = this.buf, i = this.bufAt++ * 2;
        const k = s.volume / 32768;
        const l = s.pan === 2 ? b[i + 1] : b[i];
        const r = s.pan === 1 ? b[i] : b[i + 1];
        into[0] = l * k;
        into[1] = r * k;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!this.mpeg || out.length < 2) return true;
        const l = out[0], r = out[1];
        const step = this.rate / sampleRate;
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
            this.pos += step;
        }
        return true;
    }
}

registerProcessor('dsb-sound', DsbSound);
