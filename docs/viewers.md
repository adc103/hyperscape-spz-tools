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
