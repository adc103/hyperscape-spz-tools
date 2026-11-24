# Viewers

| Feature | Desktop and 2D preview | Quest immersive |
|---|---|---|
| SPZ v2, RayQuadratic, Mip-Splatting, SH | Yes | Yes |
| Distance-based detail, 16-bit and 32-bit sorting | Yes | Yes |
| Stereo | Simulated or calibrated | Headset pose and per-eye projection |
| Two-resolution composition, frame reuse, GPU timer tuning | Optional | No |
| Color conversion | Per splat or composite | Per splat. WebGL also supports composite conversion. |

The Quest viewer prefers WebGPU when the browser exposes the WebXR binding. Otherwise it uses immersive WebGL. If WebGPU setup fails, select **Enter VR** again to use WebGL. The status line shows the active backend.

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
