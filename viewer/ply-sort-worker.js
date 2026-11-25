let points;
let indices;
let keys;

self.onmessage = ({data}) => {
    if (data.points) {
        points = data.points;
        indices = new Uint32Array(data.count);
        keys = new Float64Array(data.count);
        return;
    }
    const {eye, forward, right, down, limits, distance, frame} = data;
    let count = 0;
    for (let i = 0; i < indices.length; i++) {
        const offset = i * 4;
        const x = points[offset] - eye[0];
        const y = points[offset + 1] - eye[1];
        const z = points[offset + 2] - eye[2];
        const depth = x * forward[0] + y * forward[1] + z * forward[2];
        if (depth <= .12 || depth >= 80 || points[offset + 3] < 1 / 255) continue;
        if (Math.abs(x * right[0] + y * right[1] + z * right[2]) >= limits[0] * depth ||
            Math.abs(x * down[0] + y * down[1] + z * down[2]) >= limits[1] * depth) continue;
        indices[count++] = i;
        keys[i] = distance ? x * x + y * y + z * z : depth;
    }
    const sorted = indices.slice(0, count).sort((a, b) => keys[b] - keys[a] || b - a);
    self.postMessage({frame, sorted}, [sorted.buffer]);
};
