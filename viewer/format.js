const limit = 4_000_000;
async function inflate(bytes, format, maximum) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maximum) throw Error('Decompressed file exceeds the supported size.');
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

async function decodeSpz(file) {
    const bytes = await inflate(await file.arrayBuffer(), 'gzip', 16 + 64 * limit);
    const dv = new DataView(bytes.buffer);
    if (bytes.length < 16 || dv.getUint32(0, true) !== 0x5053474e || dv.getUint32(4, true) !== 2)
        throw Error('This viewer expects gzip-compressed SPZ version 2.');
    const n = dv.getUint32(8, true), degree = bytes[12], fractional = bytes[13], flags = bytes[14];
    const terms = (degree + 1) ** 2 - 1;
    if (degree > 3 || !n || n > limit || fractional > 24 || flags !== 12 || bytes[15] !== 0)
        throw Error('Expected Hyperscape SPZ flags 0x0C with SH degree 0–3.');
    if (bytes.length !== 16 + n * (19 + 3 * terms)) throw Error('SPZ attribute lengths do not match the header.');
    const raw = bytes.subarray(16);
    const width = 1024, height = Math.ceil(n / width), slots = width * height;
    const points = new Float32Array(slots * 4), scales = new Float32Array(slots * 4);
    const rotations = new Float32Array(slots * 4), dc = new Float32Array(slots * 4);
    const sh = new Float32Array(Math.max(terms, 1) * slots * 4);
    const pivot = [0, 0, 0], stride = n * terms, posScale = 2 ** -fractional, c0 = .2820948064;
    for (let i = 0; i < n; ++i) {
        const k = i * 4;
        for (let axis = 0; axis < 3; ++axis) {
            const j = i * 9 + axis * 3, a = i * 3 + axis;
            const p = raw[j] | raw[j + 1] << 8 | raw[j + 2] << 16;
            points[k + axis] = (p << 8 >> 8) * posScale;
            pivot[axis] += points[k + axis] / n;
            dc[k + axis] = (raw[10 * n + a] / 255 - .5) / .15;
            scales[k + axis] = Math.exp(raw[13 * n + a] / 16 - 10);
            rotations[k + axis] = raw[16 * n + a] * (2 * Math.PI / 255) - Math.PI;
        }
        points[k + 3] = raw[9 * n + i] / 255;
        const theta = Math.hypot(rotations[k], rotations[k+1], rotations[k+2]);
        const weight = theta > 1e-7 ? Math.sin(theta / 2) / theta : .5;
        for (let axis = 0; axis < 3; ++axis) rotations[k + axis] *= weight;
        rotations[k+3] = Math.cos(theta / 2);
        for (let term = 0; term < terms; ++term) {
            const off = 19 * n + i * terms + term;
            const y = (raw[off] - 128) / 128, u = (raw[off + stride] - 128) / 128;
            const v = (raw[off + stride * 2] - 128) / 128;
            const dest = term * slots * 4 + k;
            sh[dest] = (y + 1.5748 * v - .5) / c0;
            sh[dest+1] = (y - .1873 * u - .4681 * v - .5) / c0;
            sh[dest+2] = (y + 1.8556 * u - .5) / c0;
        }
    }
    return {n, degree, terms, width, height, points, scales, rotations, dc, sh, pivot};
}
