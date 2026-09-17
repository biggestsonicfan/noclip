/*
 * zip.js — minimal ZIP central-directory reader.
 *
 * Enough of the format to pull named members out of a MAME ROM set: reads the
 * end-of-central-directory record, walks the central directory, then inflates
 * (or copies) each requested member. Deflate goes through DecompressionStream,
 * which exists both in browsers and in Node >= 18, so this module runs
 * unchanged on either side.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CDH = 0x02014b50;

async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const chunks = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}

/* Locate the end-of-central-directory record by scanning back from the tail. */
function findEOCD(dv, size) {
    const max = Math.min(size, 0xffff + 22);
    for (let i = 22; i <= max; i++) {
        const p = size - i;
        if (dv.getUint32(p, true) === SIG_EOCD) return p;
    }
    return -1;
}

/**
 * Parse a zip's central directory.
 * @param {ArrayBuffer} buffer
 * @returns {Map<string, {offset:number, compSize:number, size:number, method:number, crc:number}>}
 */
export function readZipDirectory(buffer) {
    const dv = new DataView(buffer);
    const size = buffer.byteLength;
    const eocd = findEOCD(dv, size);
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

    let count = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);

    /* Zip64: the 32-bit fields saturate, real values live in the zip64 EOCD. */
    if (cdOffset === 0xffffffff || count === 0xffff) {
        const loc = eocd - 20;
        if (loc >= 0 && dv.getUint32(loc, true) === SIG_EOCD64_LOC) {
            const z64 = Number(dv.getBigUint64(loc + 8, true));
            if (dv.getUint32(z64, true) === SIG_EOCD64) {
                count = Number(dv.getBigUint64(z64 + 32, true));
                cdOffset = Number(dv.getBigUint64(z64 + 48, true));
            }
        }
    }

    const dec = new TextDecoder();
    const entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (dv.getUint32(p, true) !== SIG_CDH) break;
        const method = dv.getUint16(p + 10, true);
        const crc = dv.getUint32(p + 16, true);
        const compSize = dv.getUint32(p + 20, true);
        const uncompSize = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localOffset = dv.getUint32(p + 42, true);
        const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
        /* MAME sets are flat, but tolerate paths: key on the basename.
         *
         * A merged set is the one place paths carry meaning. It holds the
         * parent and every clone at once, the parent's chips at the top level
         * and each clone's differing ones in a directory named for it — so a
         * chip inside a directory must never displace the top-level one of the
         * same name, and callers are told which is which. */
        const base = name.substring(name.lastIndexOf('/') + 1);
        const nested = base !== name;
        if (base) {
            const had = entries.get(base);
            if (!had || (had.nested && !nested)) {
                entries.set(base, { localOffset, compSize, size: uncompSize, method, crc, nested });
            }
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * Extract one member by name. Returns null when the member is absent.
 */
export async function extractZipEntry(buffer, entries, name) {
    const e = entries.get(name);
    if (!e) return null;
    const dv = new DataView(buffer);
    /* The local header repeats the name/extra with possibly different lengths,
     * so the data offset must be computed from the local header, not the CD. */
    const nameLen = dv.getUint16(e.localOffset + 26, true);
    const extraLen = dv.getUint16(e.localOffset + 28, true);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    const raw = new Uint8Array(buffer, dataStart, e.compSize);
    if (e.method === 0) return raw.slice();
    if (e.method === 8) return await inflateRaw(raw);
    throw new Error(`${name}: unsupported compression method ${e.method}`);
}

/** CRC32 (the zip/MAME polynomial), used to verify ROM identity. */
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
        t[i] = c >>> 0;
    }
    return t;
})();

export function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
