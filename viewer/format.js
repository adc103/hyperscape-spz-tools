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

async function zipSidecars(file, stem) {
    const dv = new DataView(await file.arrayBuffer());
    let end = dv.byteLength - 22;
    while (end >= Math.max(0, dv.byteLength - 65557) && dv.getUint32(end, true) !== 0x06054b50) --end;
    if (end < Math.max(0, dv.byteLength - 65557)) throw Error('ZIP directory not found.');
    let off = dv.getUint32(end+16,true);
    const pairs = new Map();
    for (let i = 0; i < dv.getUint16(end+10,true); ++i) {
        if (dv.getUint32(off,true) !== 0x02014b50) throw Error('Invalid ZIP directory.');
        const nameLength = dv.getUint16(off+28,true);
        const path = new TextDecoder().decode(new Uint8Array(dv.buffer,off+46,nameLength));
        const basename = path.split('/').pop();
        if (['cluster_centroids.json','cluster_masks.bin'].includes(basename)) {
            const dir = path.slice(0,-basename.length);
            const group = pairs.get(dir) || {};
            group[basename] = off;
            pairs.set(dir,group);
        }
        off += 46 + nameLength + dv.getUint16(off+30,true) + dv.getUint16(off+32,true);
    }
    const complete = [...pairs.entries()].filter(([,p]) => Object.keys(p).length === 2);
    const match = complete.find(([dir]) => dir.endsWith('/'+stem+'_visibility_clusters/')) ||
        complete.find(([dir]) => dir === stem+'_visibility_clusters/') || (complete.length === 1 ? complete[0] : null);
    if (!match) throw Error('Select the matching centroid JSON and mask BIN.');
    const result = [];
    for (const name of ['cluster_centroids.json','cluster_masks.bin']) {
        const entry = match[1][name];
        const method = dv.getUint16(entry+10,true), size = dv.getUint32(entry+24,true);
        const local = dv.getUint32(entry+42,true);
        const maximum = name.endsWith('.json') ? 1_000_000 : 100_000_000;
        if (size > maximum || dv.getUint32(local,true) !== 0x04034b50) throw Error('Unsupported ZIP entry.');
        const start = local + 30 + dv.getUint16(local+26,true) + dv.getUint16(local+28,true);
        const compressed = new Uint8Array(dv.buffer,start,dv.getUint32(entry+20,true));
        if (method !== 0 && method !== 8) throw Error('ZIP requires stored or deflate entries.');
        const decoded = method === 0 ? compressed.slice() : await inflate(compressed,'deflate-raw',size);
        if (decoded.length !== size) throw Error('ZIP entry has an invalid size.');
        result.push(decoded);
    }
    return result;
}

async function decodeSidecars(files, model, stem) {
    const zip = files.find(f => /\.zip$/i.test(f.name));
    const json = files.find(f => /\.json$/i.test(f.name));
    const bin = files.find(f => /\.bin$/i.test(f.name));
    if (!zip && (!json || !bin)) throw Error('Choose both centroid JSON and mask BIN together.');
    const [centroids, mask] = zip ? await zipSidecars(zip,stem) :
        await Promise.all([json.bytes(), bin.bytes()]);
    const {splat_count: count, views} = JSON.parse(new TextDecoder().decode(centroids));
    if (count !== model.n || !Array.isArray(views) || !views.length ||
        !views.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) ||
        mask.byteLength !== 4 * Math.ceil(count * views.length / 32)) throw Error('Visibility sidecars do not match this scan.');
    const dv = new DataView(mask.buffer,mask.byteOffset,mask.byteLength);
    const words = Uint32Array.from({length:mask.byteLength/4},(_,i)=>dv.getUint32(i*4,true));
    return {views, words};
}
