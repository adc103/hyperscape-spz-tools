# Viewers

| Feature | Desktop and 2D preview | Quest immersive |
|---|---|---|
| SPZ v2, RayQuadratic, Mip-Splatting, SH | Yes | Yes |
| Distance-based detail, 16-bit and 32-bit sorting | Yes | Yes |
| Stereo | Simulated or calibrated | Headset pose and per-eye projection |
| Two-resolution composition and frame reuse | Optional | Optional |
| Adaptive quality | GPU timer queries when available | GPU timer queries when available |
| Color conversion | Per splat or composite | Per splat or composite |

The Quest viewer prefers WebGPU when the browser exposes the WebXR binding. Otherwise it uses immersive WebGL. If WebGPU setup fails, select **Enter VR** again to use WebGL. The status line shows the active backend.

In VR, the headset supplies eye poses, projections, and render size. Frame JSON camera calibration and depth images apply to the preview.

## Quest performance

Performance, Balanced, and High use 50%, 65%, and 85% render scale. They share the same distance-based detail settings. A worker culls and sorts splats. The GPU projects, shades, and blends both eyes. Two-resolution rendering and frame reuse are optional.

The rendering reference also covers native visibility masks, navigation meshes, and compositor behavior. The SPZ-only viewer uses browser frustum culling and the WebXR compositor. It has no visibility-mask loader or navigation mesh.

Push the left stick forward to aim the controller. Release when the landing ring is visible to teleport. Walls and gaps in scan coverage cancel the landing. Flick the right stick to turn 30°. Press Menu or Y on the left controller to exit. Menu requires browser support.

VR aligns the estimated scan floor with Quest's tracked floor. The viewer uses one floor level and may move the starting point to nearby clear floor. It derives walkable areas from the SPZ and fills a missing 20 cm cell when all eight neighboring cells contain clear, measured floor. Larger gaps and sparse scans can limit teleporting.

Physical-headset testing is pending.

[Meta Browser specifications](https://developers.meta.com/vr/documentation/web/browser-specs/) · [WebXR WebGPU binding draft](https://github.com/immersive-web/webxr-webgpu-binding/blob/main/index.bs)

## Frame JSON

Load a JSON object under **Advanced rendering**. Fields are optional.

| Fields | Meaning |
|---|---|
| `eyes` | One or two calibrated views. Each has `position`, `right`, `down`, `forward`, and `tan` (positive horizontal and vertical half-FOV tangents). Optional `shift` and `fovea` are 2D normalized device coordinates. |
| `eyes[].depth`, `depthOffset` | A depth image with `width`, `height`, and `meters` in row order from the top. Zero means unknown. `depthOffset` is in meters. |
| `near`, `far`, `width`, `height` | Clip planes and intermediate render size per eye. |
| `detailNear`, `detailFar`, `distanceNear`, `distanceFar`, `detailFade`, `maxSplats`, `gpuBudgetMs` | Detail fractions, their distances in meters, fade width, splat limit, and GPU time target. |
| `foveationRadius`, `mipFadePercent`, `clipDepth`, `frontToBack` | Peripheral Mip filter, reprojection clip depth, and blend direction. |
| `alpha` | Optional composite controls `power`, `threshold`, `boost`, `offset`, `cutoff`, and `unpremultiply`. |
