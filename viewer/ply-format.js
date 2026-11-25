const SH_TERMS = [0, 3, 8, 15];
const TEXTURE_WIDTH = 1024;

export function decodePly(buffer) {
    const bytes = new Uint8Array(buffer);
    const prefix = new TextDecoder().decode(bytes.subarray(0, 16384));
    const end = /(?:^|\n)end_header\r?\n/.exec(prefix);
    if (!end) throw new Error("The PLY header is missing or too large.");
    const body = new TextEncoder().encode(prefix.slice(0, end.index + end[0].length)).length;
    const lines = prefix.slice(0, end.index).split(/\r?\n/);
    if (lines[0] !== "ply" || lines[1] !== "format binary_little_endian 1.0") {
        throw new Error("Use a binary little-endian Gaussian splat PLY.");
    }
    let count = 0;
    const columns = new Map();
    for (const line of lines.slice(2)) {
        const [kind, type, name] = line.trim().split(/\s+/);
        if (kind === "comment" || kind === "obj_info" || !kind) continue;
        if (kind === "element" && type === "vertex" && !count && /^\d+$/.test(name)) {
            count = Number(name);
        } else if (kind === "property" && count && ["float", "float32"].includes(type) && name && !columns.has(name)) {
            columns.set(name, columns.size * 4);
        } else {
            throw new Error("Expected one vertex element with float32 Gaussian attributes.");
        }
    }
    const stride = columns.size * 4;
    const required = ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
        "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2"];
    const shCount = Array.from(columns.keys()).filter(name => name.startsWith("f_rest_")).length;
    const terms = shCount / 3;
    if (count < 1 || count > 4_000_000 || body + count * stride !== buffer.byteLength ||
        !required.every(name => columns.has(name)) || !SH_TERMS.includes(terms)) {
        throw new Error("The PLY vertex data or Gaussian attributes are invalid.");
    }
    const harmonics = Array.from({length: shCount}, (_, i) => columns.get(`f_rest_${i}`));
    if (harmonics.some(offset => offset === undefined)) throw new Error("The PLY is missing spherical harmonic coefficients.");

    const height = Math.ceil(count / TEXTURE_WIDTH);
    const slots = TEXTURE_WIDTH * height;
    const points = new Float32Array(slots * 4);
    const scales = new Float32Array(slots * 4);
    const rotations = new Float32Array(slots * 4);
    const dc = new Float32Array(slots * 4);
    const sh = new Float32Array(Math.max(1, terms) * slots * 4);
    const view = new DataView(buffer, body);
    const offsets = required.map(name => columns.get(name));
    for (let i = 0; i < count; i++) {
        const row = i * stride, p = i * 4;
        for (let axis = 0; axis < 3; axis++) {
            points[p + axis] = view.getFloat32(row + offsets[axis], true);
            scales[p + axis] = Math.exp(view.getFloat32(row + offsets[4 + axis], true));
            dc[p + axis] = view.getFloat32(row + offsets[11 + axis], true);
        }
        const logit = view.getFloat32(row + offsets[3], true);
        points[p + 3] = 1 / (1 + Math.exp(-logit));
        const w = view.getFloat32(row + offsets[7], true);
        const x = view.getFloat32(row + offsets[8], true);
        const y = view.getFloat32(row + offsets[9], true);
        const z = view.getFloat32(row + offsets[10], true);
        const norm = Math.hypot(x, y, z, w);
        if (!Number.isFinite(logit) || !(norm > 0) || !Number.isFinite(norm)) throw new Error("Invalid opacity or rotation in PLY.");
        rotations[p] = x / norm;
        rotations[p + 1] = y / norm;
        rotations[p + 2] = z / norm;
        rotations[p + 3] = w / norm;
        for (let axis = 0; axis < 3; axis++) {
            if (!Number.isFinite(points[p + axis]) || !Number.isFinite(scales[p + axis]) ||
                !(scales[p + axis] > 0) || !Number.isFinite(dc[p + axis])) {
                throw new Error("Invalid position, scale, or color in PLY.");
            }
            for (let term = 0; term < terms; term++) {
                const value = view.getFloat32(row + harmonics[axis * terms + term], true);
                if (!Number.isFinite(value)) throw new Error("Invalid spherical harmonic coefficient in PLY.");
                sh[term * slots * 4 + p + axis] = value;
            }
        }
    }
    return {count, terms, width: TEXTURE_WIDTH, height, points, scales, rotations, dc, sh};
}
