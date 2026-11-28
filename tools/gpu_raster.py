"""WebGPU version of the refine rasterizer (prototype).

Same inputs and outputs as splat_fit.cpp's raster_refine. The CPU builds screen
footprints and per-tile splat lists in draw order; one compute pass blends each
16x16 tile front to back and a second pass replays the blend to accumulate
per-splat gradients.
"""
import numpy as np

TILE = 16
FOOTPRINT_FLOATS = 24

SHADER = """
struct Settings { width: u32, height: u32, tiles_x: u32, has_target: u32,
                  cutoff: f32, support: f32, clip_error: f32, pad: f32 };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> footprints: array<f32>;
@group(0) @binding(2) var<storage, read> tile_start: array<u32>;
@group(0) @binding(3) var<storage, read> entries: array<u32>;
@group(0) @binding(4) var<storage, read_write> image: array<f32>;
@group(0) @binding(5) var<storage, read> reference: array<f32>;
@group(0) @binding(6) var<storage, read_write> gradient: array<atomic<u32>>;

fn field(i: u32, k: u32) -> f32 { return footprints[i*24u + k]; }

fn add_gradient(index: u32, value: f32) {
    if (value == 0.0) { return; }
    var old = atomicLoad(&gradient[index]);
    loop {
        let next = bitcast<u32>(bitcast<f32>(old) + value);
        let result = atomicCompareExchangeWeak(&gradient[index], old, next);
        if (result.exchanged) { break; }
        old = result.old_value;
    }
}

@compute @workgroup_size(16, 16)
fn forward(@builtin(workgroup_id) tile: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
    let x = tile.x*16u + local.x;
    let y = tile.y*16u + local.y;
    if (x >= settings.width || y >= settings.height) { return; }
    let t = tile.y*settings.tiles_x + tile.x;
    var color = vec3<f32>(0.0);
    var transmittance = 1.0;
    for (var e = tile_start[t]; e < tile_start[t+1u]; e++) {
        if (transmittance < 0.001) { break; }
        let i = entries[e];
        let dx = f32(x) - field(i, 0u);
        let dy = f32(y) - field(i, 1u);
        let u = field(i, 2u)*dx + field(i, 3u)*dy;
        let v = field(i, 3u)*dx + field(i, 4u)*dy;
        let d = u*dx + v*dy;
        if (d > settings.support) { continue; }
        let kernel = exp(-0.5*d);
        let alpha = min(0.999, field(i, 5u)*kernel);
        if (alpha < settings.cutoff) { continue; }
        color += transmittance*alpha*vec3<f32>(field(i, 6u), field(i, 7u), field(i, 8u));
        transmittance *= 1.0 - alpha;
    }
    let k = (y*settings.width + x)*4u;
    image[k] = color.x; image[k+1u] = color.y; image[k+2u] = color.z; image[k+3u] = transmittance;
}

@compute @workgroup_size(16, 16)
fn backward(@builtin(workgroup_id) tile: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
    let x = tile.x*16u + local.x;
    let y = tile.y*16u + local.y;
    if (x >= settings.width || y >= settings.height) { return; }
    let t = tile.y*settings.tiles_x + tile.x;
    let k = (y*settings.width + x)*4u;
    let out = vec3<f32>(image[k], image[k+1u], image[k+2u]);
    var image_gradient = vec3<f32>(0.0);
    for (var c = 0u; c < 3u; c++) {
        let residual = min(out[c], 1.0) - reference[k+c];
        var g = clamp(residual, -settings.clip_error, settings.clip_error);
        if (out[c] > 1.0 && residual > 0.0) { g *= 0.1; }
        image_gradient[c] = g;
    }
    var prefix = vec3<f32>(0.0);
    var transmittance = 1.0;
    for (var e = tile_start[t]; e < tile_start[t+1u]; e++) {
        if (transmittance < 0.001) { break; }
        let i = entries[e];
        let dx = f32(x) - field(i, 0u);
        let dy = f32(y) - field(i, 1u);
        let u = field(i, 2u)*dx + field(i, 3u)*dy;
        let v = field(i, 3u)*dx + field(i, 4u)*dy;
        let d = u*dx + v*dy;
        if (d > settings.support) { continue; }
        let kernel = exp(-0.5*d);
        let alpha = min(0.999, field(i, 5u)*kernel);
        if (alpha < settings.cutoff) { continue; }
        let rgb = vec3<f32>(field(i, 6u), field(i, 7u), field(i, 8u));
        let contribution = transmittance*alpha;
        var opacity_gradient = 0.0;
        let row = field(i, 21u);
        let base = u32(row)*10u;
        for (var c = 0u; c < 3u; c++) {
            prefix[c] += contribution*rgb[c];
            let behind = (out[c] - prefix[c])/(1.0 - alpha);
            opacity_gradient += image_gradient[c]*(transmittance*rgb[c] - behind);
            if (rgb[c] > 0.0 || image_gradient[c] < 0.0) {
                add_gradient(base + 7u + c, image_gradient[c]*contribution);
            }
        }
        transmittance *= 1.0 - alpha;
        add_gradient(base + 3u, opacity_gradient*kernel);
        for (var a = 0u; a < 3u; a++) {
            let direction = field(i, 9u + a)*u + field(i, 12u + a)*v;
            add_gradient(base + a, opacity_gradient*alpha*direction*direction);
            add_gradient(base + 4u + a, opacity_gradient*alpha*(field(i, 15u + a)*u + field(i, 18u + a)*v));
        }
    }
}
"""


def footprints(data, params, filter=.3, cutoff=1/255, support=9.):
    """Screen footprints, matching raster_refine's setup loop."""
    data = np.asarray(data, dtype="f4").reshape(len(params), -1)
    x, y = data[:, 0], data[:, 1]
    jx, jy, rgb = data[:, 2:5], data[:, 5:8], data[:, 8:11]
    size = np.exp(params[:, :3])
    vx, vy = jx*size, jy*size
    x = x + np.sum(jx*params[:, 4:7], axis=1)
    y = y + np.sum(jy*params[:, 4:7], axis=1)
    xx = filter + np.sum(vx*vx, axis=1)
    xy = np.sum(vx*vy, axis=1)
    yy = filter + np.sum(vy*vy, axis=1)
    det = xx*yy-xy*xy
    thin = det <= 1e-5*xx*yy
    if thin.any():
        gram = filter*(xx+yy-filter)
        for j, k in ((0, 1), (0, 2), (1, 2)):
            gram = gram + (vx[:, j]*vy[:, k]-vx[:, k]*vy[:, j])**2
        det = np.where(thin, gram, det)
    inv = 1/det
    i00, i01, i11 = yy*inv, -xy*inv, xx*inv
    opacity = params[:, 3]
    with np.errstate(divide="ignore", invalid="ignore"):
        limit = np.where(opacity > cutoff, np.minimum(support, 2*np.log(opacity/cutoff))*1.001+1e-3, -1)
    out = np.zeros((len(params), FOOTPRINT_FLOATS), dtype="f4")
    out[:, 0], out[:, 1], out[:, 2], out[:, 3], out[:, 4] = x, y, i00, i01, i11
    out[:, 5] = opacity
    out[:, 6:9] = np.maximum(0, rgb+params[:, 7:10])
    out[:, 9:12], out[:, 12:15], out[:, 15:18], out[:, 18:21] = vx, vy, jx, jy
    out[:, 21] = np.arange(len(params))
    return out, limit


def tile_lists(fp, limit, width, height):
    """Per-tile splat indices in draw order, as CSR offsets and entries."""
    tiles_x, tiles_y = -(-width//TILE), -(-height//TILE)
    i00, i01, i11 = fp[:, 2], fp[:, 3], fp[:, 4]
    det = i00*i11-i01*i01
    ok = (limit > 0) & (det > 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        ex = np.sqrt(np.where(ok, limit*i11/det, 0))+1
        ey = np.sqrt(np.where(ok, limit*i00/det, 0))+1
    tx0 = np.clip(np.floor((fp[:, 0]-ex)/TILE), 0, tiles_x-1).astype(np.int64)
    tx1 = np.clip(np.floor((fp[:, 0]+ex)/TILE), 0, tiles_x-1).astype(np.int64)
    ty0 = np.clip(np.floor((fp[:, 1]-ey)/TILE), 0, tiles_y-1).astype(np.int64)
    ty1 = np.clip(np.floor((fp[:, 1]+ey)/TILE), 0, tiles_y-1).astype(np.int64)
    inside = ok & (fp[:, 0]+ex >= 0) & (fp[:, 0]-ex < width) & (fp[:, 1]+ey >= 0) & (fp[:, 1]-ey < height)
    nx, ny = np.where(inside, tx1-tx0+1, 0), np.where(inside, ty1-ty0+1, 0)
    counts = nx*ny
    splat = np.repeat(np.arange(len(fp)), counts)
    local = np.arange(len(splat))-np.repeat(np.cumsum(counts)-counts, counts)
    tile = (ty0[splat]+local//nx[splat])*tiles_x+tx0[splat]+local % nx[splat]
    order = np.argsort(tile, kind="stable")
    entries = splat[order].astype("u4")
    start = np.zeros(tiles_x*tiles_y+1, dtype="u4")
    np.cumsum(np.bincount(tile, minlength=tiles_x*tiles_y), out=start[1:])
    return tiles_x, tiles_y, start, entries


class GpuRefine:
    def __init__(self):
        import wgpu
        self.wgpu = wgpu
        adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
        self.name = adapter.info.get("device", "GPU")
        limits = adapter.limits
        self.device = adapter.request_device_sync(required_limits={
            "max-storage-buffer-binding-size": limits["max-storage-buffer-binding-size"],
            "max-buffer-size": limits["max-buffer-size"]})
        module = self.device.create_shader_module(code=SHADER)
        self.forward = self.device.create_compute_pipeline(layout="auto", compute={"module": module, "entry_point": "forward"})
        self.backward = self.device.create_compute_pipeline(layout="auto", compute={"module": module, "entry_point": "backward"})

    def _buffer(self, array, extra=0):
        wgpu = self.wgpu
        array = np.ascontiguousarray(array)
        if array.nbytes == 0:
            array = np.zeros(4, dtype="f4")
        return self.device.create_buffer_with_data(
            data=array, usage=wgpu.BufferUsage.STORAGE | wgpu.BufferUsage.COPY_SRC | wgpu.BufferUsage.COPY_DST | extra)

    def render(self, data, params, width, height, target=None, filter=.3, cutoff=1/255, support=9., clip_error=.15):
        wgpu = self.wgpu
        fp, limit = footprints(data, params, filter, cutoff, support)
        tiles_x, tiles_y, start, entries = tile_lists(fp, limit, width, height)
        settings = np.zeros(8, dtype="u4")
        settings[:4] = width, height, tiles_x, target is not None
        settings[4:8] = np.array([cutoff, support, clip_error, 0], dtype="f4").view("u4")
        uniform = self.device.create_buffer_with_data(data=settings, usage=wgpu.BufferUsage.UNIFORM)
        image = self._buffer(np.zeros(width*height*4, dtype="f4"))
        target_buffer = self._buffer(np.zeros(4, "f4") if target is None else target.reshape(-1).astype("f4"))
        grad = self._buffer(np.zeros(len(params)*10, dtype="f4"))
        buffers = [uniform, self._buffer(fp), self._buffer(start), self._buffer(entries), image, target_buffer, grad]
        passes = [self.forward] + ([self.backward] if target is not None else [])
        encoder = self.device.create_command_encoder()
        for pipeline in passes:
            layout = pipeline.get_bind_group_layout(0)
            used = (0, 1, 2, 3, 4) if pipeline is self.forward else (0, 1, 2, 3, 4, 5, 6)
            group = self.device.create_bind_group(layout=layout, entries=[
                {"binding": b, "resource": {"buffer": buffers[b]}} for b in used])
            compute = encoder.begin_compute_pass()
            compute.set_pipeline(pipeline)
            compute.set_bind_group(0, group)
            compute.dispatch_workgroups(tiles_x, tiles_y)
            compute.end()
        self.device.queue.submit([encoder.finish()])
        out = np.frombuffer(self.device.queue.read_buffer(image), dtype="f4").reshape(height, width, 4).copy()
        gradient = (np.frombuffer(self.device.queue.read_buffer(grad), dtype="f4").reshape(len(params), 10).copy()
                    if target is not None else np.empty(0, dtype="f4"))
        return out, gradient
