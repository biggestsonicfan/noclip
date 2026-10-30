/*
 * mpeg.js — MPEG-1 Layer II audio, decoded the way MAME's mpeg_audio does it.
 *
 * The Digital Sound Boards (dsb.js) play their music out of MPEG ROMs: plain
 * Layer II frames, 32 kHz stereo at 128 kbit/s in the games here. This is a
 * port of MAME's decoder (src/devices/sound/mpeg_audio.cpp, BSD-3-Clause,
 * Olivier Galibert), Layer II only, as MAME builds it for the DSBs: the same
 * sync search, tables, naive IDCT and window, so it gives MAME's samples.
 *
 * `decode(pos, limit, out)` reads one frame from bit `pos`, stopping short of
 * bit `limit`, writes its samples interleaved as 16-bit integers into `out`
 * (1152 a channel at most) and returns { pos, samples, channels, rate }, or
 * null when the frame would run past `limit` (the board's end of stream).
 *
 * license:BSD-3-Clause, copyright-holders:Olivier Galibert (MAME's file).
 */

const SAMPLE_RATES = [44100, 48000, 32000, 0];

/* Which allocation table a frame uses, by channel count, sample rate and
 * bitrate index (ISO 11172-3 B.2). */
const PARAM_INDEX = [
    [
        [1, 2, 2, 0, 0, 0, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1],
        [0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, -1, -1, -1],
        [1, 3, 3, 0, 0, 0, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1],
    ],
    [
        [1, -1, -1, -1, 2, -1, 2, 0, 0, 0, 1, 1, 1, 1, 1, -1],
        [0, -1, -1, -1, 2, -1, 2, 0, 0, 0, 0, 0, 0, 0, 0, -1],
        [1, -1, -1, -1, 3, -1, 3, 0, 0, 0, 1, 1, 1, 1, 1, -1],
    ],
];

/* Each table's quantizer classes, a band at a time: runs of [classes,
 * bands], the classes indexed by the band's allocation field. */
const BAND_RUNS = [
    [[[0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], 3], [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17], 8],
        [[0, 1, 2, 3, 4, 5, 6, 17], 12], [[0, 1, 2, 17], 4], [[0], 5]],
    [[[0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], 3], [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17], 8],
        [[0, 1, 2, 3, 4, 5, 6, 17], 12], [[0, 1, 2, 17], 7], [[0], 2]],
    [[[0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 2], [[0, 1, 2, 4, 5, 6, 7, 8], 6], [[0], 24]],
    [[[0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 2], [[0, 1, 2, 4, 5, 6, 7, 8], 10], [[0], 20]],
    [[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 4], [[0, 1, 2, 4, 5, 6, 7, 8], 7], [[0, 1, 2, 4], 19], [[0], 2]],
];
const BAND_CLASSES = BAND_RUNS.map((runs) => runs.flatMap(([classes, n]) => Array(n).fill(classes)));
/* The allocation field's width, a band at a time; the count of bands. */
const BAND_BITS = [
    [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 0, 0, 0, 0, 0],
    [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 0, 0],
    [4, 4, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0],
];
const TOTAL_BANDS = [27, 30, 8, 12, 30];
const JOINT_BANDS = [4, 8, 12, 16];

/* The quantizer classes: steps (`modulo`), bits a sample, bits a grouped
 * triplet, and MAME's scale and offset. Classes 1, 2 and 4 group three
 * samples in one code. */
const CLASSES = [null];
for (const [modulo, bits, cube, num, den, offset] of [
    [3, 2, 5, 1, 4, 1 / 2], [5, 3, 7, 3, 8, 1 / 2], [7, 3, 9, 1, 8, 1 / 4], [9, 4, 10, 7, 16, 1 / 2], [15, 4, 12, 1, 16, 1 / 8],
]) CLASSES.push({ modulo, bits, cube, scale: 1 / (1 - num / den), offset, grouped: cube !== 3 * bits });
for (let bits = 5; bits <= 16; bits++) {
    CLASSES.push({ modulo: (1 << bits) - 1, bits, cube: 3 * bits, scale: 1 / (1 - 1 / (1 << bits)), offset: 1 / (1 << (bits - 1)), grouped: false });
}

const SCALEFACTORS = Float64Array.from({ length: 64 }, (_, i) => (i === 63 ? 0 : 2 * 2 ** (-i / 3)));

/* The synthesis window, MAME's copy of the standard's. */
const WINDOW = new Float64Array([
    .000000000, -.000015259, -.000015259, -.000015259, -.000015259, -.000015259, -.000015259, -.000030518,
    -.000030518, -.000030518, -.000030518, -.000045776, -.000045776, -.000061035, -.000061035, -.000076294,
    -.000076294, -.000091553, -.000106812, -.000106812, -.000122070, -.000137329, -.000152588, -.000167847,
    -.000198364, -.000213623, -.000244141, -.000259399, -.000289917, -.000320435, -.000366211, -.000396729,
    -.000442505, -.000473022, -.000534058, -.000579834, -.000625610, -.000686646, -.000747681, -.000808716,
    -.000885010, -.000961304, -.001037598, -.001113892, -.001205444, -.001296997, -.001388550, -.001480103,
    -.001586914, -.001693726, -.001785278, -.001907349, -.002014160, -.002120972, -.002243042, -.002349854,
    -.002456665, -.002578735, -.002685547, -.002792358, -.002899170, -.002990723, -.003082275, -.003173828,
    .003250122, .003326416, .003387451, .003433228, .003463745, .003479004, .003479004, .003463745,
    .003417969, .003372192, .003280640, .003173828, .003051758, .002883911, .002700806, .002487183,
    .002227783, .001937866, .001617432, .001266479, .000869751, .000442505, -.000030518, -.000549316,
    -.001098633, -.001693726, -.002334595, -.003005981, -.003723145, -.004486084, -.005294800, -.006118774,
    -.007003784, -.007919312, -.008865356, -.009841919, -.010848999, -.011886597, -.012939453, -.014022827,
    -.015121460, -.016235352, -.017349243, -.018463135, -.019577026, -.020690918, -.021789550, -.022857666,
    -.023910522, -.024932861, -.025909424, -.026840210, -.027725220, -.028533936, -.029281616, -.029937744,
    -.030532837, -.031005860, -.031387330, -.031661987, -.031814575, -.031845093, -.031738280, -.031478880,
    .031082153, .030517578, .029785156, .028884888, .027801514, .026535034, .025085450, .023422241,
    .021575928, .019531250, .017257690, .014801025, .012115479, .009231567, .006134033, .002822876,
    -.000686646, -.004394531, -.008316040, -.012420654, -.016708374, -.021179200, -.025817871, -.030609130,
    -.035552980, -.040634155, -.045837402, -.051132202, -.056533813, -.061996460, -.067520140, -.073059080,
    -.078628540, -.084182740, -.089706420, -.095169070, -.100540160, -.105819700, -.110946655, -.115921020,
    -.120697020, -.125259400, -.129562380, -.133590700, -.137298580, -.140670780, -.143676760, -.146255500,
    -.148422240, -.150115970, -.151306150, -.151962280, -.152069090, -.151596070, -.150497440, -.148773200,
    -.146362300, -.143264770, -.139450070, -.134887700, -.129577640, -.123474120, -.116577150, -.108856200,
    .100311280, .090927124, .080688480, .069595340, .057617188, .044784546, .031082153, .016510010,
    .001068115, -.015228271, -.032379150, -.050354004, -.069168090, -.088775635, -.109161380, -.130310060,
    -.152206420, -.174789430, -.198059080, -.221984860, -.246505740, -.271591200, -.297210700, -.323318480,
    -.349868770, -.376800540, -.404083250, -.431655880, -.459472660, -.487472530, -.515609740, -.543823240,
    -.572036740, -.600219700, -.628295900, -.656219500, -.683914200, -.711318970, -.738372800, -.765029900,
    -.791214000, -.816864000, -.841949460, -.866363500, -.890090940, -.913055400, -.935195900, -.956481930,
    -.976852400, -.996246340, -1.014617900, -1.031936600, -1.048156700, -1.063217200, -1.077117900, -1.089782700,
    -1.101211500, -1.111373900, -1.120224000, -1.127746600, -1.133926400, -1.138763400, -1.142211900, -1.144287100,
    +1.144989000, +1.144287100, +1.142211900, +1.138763400, +1.133926400, +1.127746600, +1.120224000, +1.111373900,
    +1.101211500, +1.089782700, +1.077117900, +1.063217200, +1.048156700, +1.031936600, +1.014617900, .996246340,
    .976852400, .956481930, .935195900, .913055400, .890090940, .866363500, .841949460, .816864000,
    .791214000, .765029900, .738372800, .711318970, .683914200, .656219500, .628295900, .600219700,
    .572036740, .543823240, .515609740, .487472530, .459472660, .431655880, .404083250, .376800540,
    .349868770, .323318480, .297210700, .271591200, .246505740, .221984860, .198059080, .174789430,
    .152206420, .130310060, .109161380, .088775635, .069168090, .050354004, .032379150, .015228271,
    -.001068115, -.016510010, -.031082153, -.044784546, -.057617188, -.069595340, -.080688480, -.090927124,
    .100311280, .108856200, .116577150, .123474120, .129577640, .134887700, .139450070, .143264770,
    .146362300, .148773200, .150497440, .151596070, .152069090, .151962280, .151306150, .150115970,
    .148422240, .146255500, .143676760, .140670780, .137298580, .133590700, .129562380, .125259400,
    .120697020, .115921020, .110946655, .105819700, .100540160, .095169070, .089706420, .084182740,
    .078628540, .073059080, .067520140, .061996460, .056533813, .051132202, .045837402, .040634155,
    .035552980, .030609130, .025817871, .021179200, .016708374, .012420654, .008316040, .004394531,
    .000686646, -.002822876, -.006134033, -.009231567, -.012115479, -.014801025, -.017257690, -.019531250,
    -.021575928, -.023422241, -.025085450, -.026535034, -.027801514, -.028884888, -.029785156, -.030517578,
    .031082153, .031478880, .031738280, .031845093, .031814575, .031661987, .031387330, .031005860,
    .030532837, .029937744, .029281616, .028533936, .027725220, .026840210, .025909424, .024932861,
    .023910522, .022857666, .021789550, .020690918, .019577026, .018463135, .017349243, .016235352,
    .015121460, .014022827, .012939453, .011886597, .010848999, .009841919, .008865356, .007919312,
    .007003784, .006118774, .005294800, .004486084, .003723145, .003005981, .002334595, .001693726,
    .001098633, .000549316, .000030518, -.000442505, -.000869751, -.001266479, -.001617432, -.001937866,
    -.002227783, -.002487183, -.002700806, -.002883911, -.003051758, -.003173828, -.003280640, -.003372192,
    -.003417969, -.003463745, -.003479004, -.003479004, -.003463745, -.003433228, -.003387451, -.003326416,
    .003250122, .003173828, .003082275, .002990723, .002899170, .002792358, .002685547, .002578735,
    .002456665, .002349854, .002243042, .002120972, .002014160, .001907349, .001785278, .001693726,
    .001586914, .001480103, .001388550, .001296997, .001205444, .001113892, .001037598, .000961304,
    .000885010, .000808716, .000747681, .000686646, .000625610, .000579834, .000534058, .000473022,
    .000442505, .000396729, .000366211, .000320435, .000289917, .000259399, .000244141, .000213623,
    .000198364, .000167847, .000152588, .000137329, .000122070, .000106812, .000106812, .000091553,
    .000076294, .000076294, .000061035, .000061035, .000045776, .000045776, .000030518, .000030518,
    .000030518, .000030518, .000015259, .000015259, .000015259, .000015259, .000015259, .000015259,
]);

const COS = Array.from({ length: 32 }, (_, i) => Float64Array.from({ length: 32 }, (__, j) => Math.cos(i * (2 * j + 1) * Math.PI / 64)));

const LIMIT = {};

export class MpegAudio {
    constructor(rom) {
        this.rom = rom;
        this.bandParam = [new Int32Array(32), new Int32Array(32)];
        this.scfsi = [new Int32Array(32), new Int32Array(32)];
        this.scf = [0, 1].map(() => [0, 1, 2].map(() => new Int32Array(32)));
        this.amp = [0, 1].map(() => [0, 1, 2].map(() => new Float64Array(32)));
        this.bdata = [0, 1].map(() => [0, 1, 2].map(() => new Float64Array(32)));
        this.audio = [new Float64Array(32 * 32), new Float64Array(32 * 32)];
        this.resynth = new Float64Array(32);
        this.clear();
    }

    /* Forget the filter's history, as a board reset does. */
    clear() {
        this.audio[0].fill(0);
        this.audio[1].fill(0);
        this.audioPos = [16 * 32, 16 * 32];
    }

    bits(count) {
        const rom = this.rom;
        let v = 0;
        for (let i = 0; i < count; i++) {
            const p = this.pos;
            v = (v << 1) | ((rom[p >> 3] >> (7 - (p & 7))) & 1);
            this.pos = p + 1;
        }
        return v;
    }

    gb(count) {
        if (this.pos + count > this.limit) throw LIMIT;
        return this.bits(count);
    }

    decode(pos, limit, out) {
        if (limit - pos < 16) return null;
        this.pos = pos;
        this.limit = limit;
        let sync = this.bits(12);
        for (;;) {
            while (sync !== 0xfff && this.pos < limit) sync = ((sync << 1) | this.bits(1)) & 0xfff;
            if (limit - this.pos < 4) return null;
            /* Layer II, MPEG-1: the only variant the boards' decoder takes. */
            if (this.bits(3) === 6) break;
            this.pos -= 3;
            sync = ((sync << 1) | this.bits(1)) & 0xfff;
        }
        let samples;
        try {
            this.readHeader();
            this.readData();
            samples = this.synthesize(out);
        } catch (e) {
            if (e === LIMIT) return null;
            throw e;
        }
        return { pos: this.pos, samples, channels: this.channels, rate: SAMPLE_RATES[this.rate] };
    }

    readHeader() {
        const prot = this.gb(1);
        const bitrate = this.gb(4);
        this.rate = this.gb(2);
        this.gb(2); // padding, private
        const mode = this.gb(2);
        const ext = this.gb(2);
        this.gb(4); // copyright, original, emphasis
        if (!prot) this.gb(16);
        this.channels = mode !== 3 ? 2 : 1;
        this.param = PARAM_INDEX[this.channels - 1][this.rate][bitrate];
        if (this.param === undefined || this.param < 0) throw LIMIT;
        this.total = TOTAL_BANDS[this.param];
        this.joint = mode === 1 ? Math.min(JOINT_BANDS[ext], this.total) : this.total;
    }

    bandParamOf(band) {
        return BAND_CLASSES[this.param][band][this.gb(BAND_BITS[this.param][band])];
    }

    readData() {
        const { bandParam: bp, scfsi, scf } = this;
        const ch = this.channels;
        for (let band = 0; band < 32; band++) {
            if (band < this.joint) {
                for (let c = 0; c < ch; c++) bp[c][band] = this.bandParamOf(band);
            } else if (band < this.total) {
                bp[0][band] = bp[1][band] = this.bandParamOf(band);
            } else {
                bp[0][band] = bp[1][band] = 0;
            }
        }
        scfsi[0].fill(0);
        scfsi[1].fill(0);
        for (let band = 0; band < this.total; band++)
            for (let c = 0; c < ch; c++) if (bp[c][band]) scfsi[c][band] = this.gb(2);
        for (const s of scf) for (const a of s) a.fill(0);
        for (let band = 0; band < this.total; band++) {
            for (let c = 0; c < ch; c++) {
                if (!bp[c][band]) continue;
                const s = scf[c];
                switch (scfsi[c][band]) {
                case 0: s[0][band] = this.gb(6); s[1][band] = this.gb(6); s[2][band] = this.gb(6); break;
                case 1: s[0][band] = s[1][band] = this.gb(6); s[2][band] = this.gb(6); break;
                case 2: s[0][band] = s[1][band] = s[2][band] = this.gb(6); break;
                case 3: s[0][band] = this.gb(6); s[1][band] = s[2][band] = this.gb(6); break;
                }
            }
        }
    }

    triplet(c, band) {
        const d = this.bdata[c];
        const idx = this.bandParam[c][band];
        if (!idx) {
            d[0][band] = d[1][band] = d[2][band] = 0;
            return;
        }
        const k = CLASSES[idx];
        let a, b, e;
        if (k.grouped) {
            let v = this.gb(k.cube);
            a = v % k.modulo; v = Math.floor(v / k.modulo);
            b = v % k.modulo; v = Math.floor(v / k.modulo);
            e = v % k.modulo;
        } else {
            a = this.gb(k.bits); b = this.gb(k.bits); e = this.gb(k.bits);
        }
        const half = 1 << (k.bits - 1);
        d[0][band] = ((a - half) / half + k.offset) * k.scale;
        d[1][band] = ((b - half) / half + k.offset) * k.scale;
        d[2][band] = ((e - half) / half + k.offset) * k.scale;
    }

    nextSegments(step) {
        const ch = this.channels;
        const { bdata, amp } = this;
        for (let band = 0; band < 32; band++) {
            if (band < this.joint) {
                for (let c = 0; c < ch; c++) this.triplet(c, band);
            } else if (band < this.total) {
                this.triplet(0, band);
                for (let s = 0; s < 3; s++) bdata[1][s][band] = bdata[0][s][band];
            } else {
                for (let s = 0; s < 3; s++) bdata[0][s][band] = bdata[1][s][band] = 0;
                continue;
            }
            for (let c = 0; c < ch; c++) {
                const g = amp[c][step][band];
                for (let s = 0; s < 3; s++) bdata[c][s][band] *= g;
            }
        }
    }

    synthesize(out) {
        const ch = this.channels;
        for (let c = 0; c < 2; c++) for (let s = 0; s < 3; s++) {
            const a = this.amp[c][s];
            a.fill(0);
            if (c >= ch) continue;
            for (let band = 0; band < this.total; band++) if (this.bandParam[c][band]) a[band] = SCALEFACTORS[this.scf[c][s][band]];
        }
        let n = 0;
        for (let upper = 0; upper < 3; upper++) {
            for (let middle = 0; middle < 4; middle++) {
                this.nextSegments(upper);
                for (let lower = 0; lower < 3; lower++) {
                    for (let c = 0; c < ch; c++) {
                        const buf = this.audio[c];
                        const at = this.audioPos[c];
                        const sub = this.bdata[c][lower];
                        for (let i = 0; i < 32; i++) {
                            const cs = COS[i];
                            let s = 0;
                            for (let j = 0; j < 32; j++) s += sub[j] * cs[j];
                            buf[at + i] = s;
                        }
                        this.resynthesis(buf, at + 16, out, n * ch + c, ch);
                        this.audioPos[c] -= 32;
                        if (this.audioPos[c] < 0) {
                            buf.copyWithin(17 * 32, 0, 15 * 32);
                            this.audioPos[c] = 16 * 32;
                        }
                    }
                    n += 32;
                }
            }
        }
        return n;
    }

    resynthesis(input, base, out, at, step) {
        const o = this.resynth;
        o.fill(0);
        const w = WINDOW;
        for (let j = 0; j < 512; j += 64) {
            const b = base + j;
            for (let i = 0; i < 16; i++) o[i] += input[b + i] * w[i + j] - input[b + 32 - i] * w[32 + i + j];
            o[16] -= input[b + 16] * w[48 + j];
            for (let i = 17; i < 32; i++) o[i] -= input[b + 32 - i] * w[i + j] + input[b + i] * w[32 + i + j];
        }
        for (let i = 0; i < 32; i++) {
            const v = o[i] * 32768 + 0.5;
            out[at + i * step] = v <= -32768 ? -32768 : v >= 32767 ? 32767 : Math.trunc(v);
        }
    }
}
