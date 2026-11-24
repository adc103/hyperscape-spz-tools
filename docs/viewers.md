# Viewer feature coverage

| Feature | Desktop and 2D preview | Quest immersive WebGPU | Quest immersive WebGL |
|---|---|---|---|
| Custom SPZ v2 decoding, visibility masks, original splat scales | Yes | Yes | Yes |
| RayQuadratic, Mip-Splatting, SH and optional 8-bit quantization | Yes | Yes | Yes |
| 16-bit and 32-bit sort keys, distance-based detail | Yes | Yes | Yes |
| Eye transforms | Mono or simulated stereo, with optional calibration JSON | Headset pose and per-eye projection | Headset pose and per-eye projection |
| Two-resolution composition and temporal reuse | Optional | — | — |
| GPU timer adaptation and calibration depth image | Optional | — | — |
| Per-splat color conversion | Optional | Optional | Optional |
| Composite conversion and alpha controls | Optional | — | Optional |

The Quest page checks for immersive WebXR and requests the WebGPU binding only when the browser exposes that API. A session with the `webgpu` feature renders the WGSL RayQuadratic shader directly into the XR projection layer. If the feature is unavailable, the app uses WebXR with a WebGL 2 projection layer. If native WebGPU setup fails after session creation, select **Enter VR** again to use the WebGL path. The status line identifies the active backend.

The viewers use browser-side culling and sorting and preserve the scan's original indices. The Quest page uses the real stereo projections. It leaves the application compositor, navigation mesh, headset quality controller, and native GPU ordering to Hyperscape. Browser blend precision, shader packing, and the Quest compositor can affect the final image.

The decoder and WebGL projection were exercised with a private 390,563-splat capture. Physical-headset WebXR behavior, native WebGPU pixel output, and sustained Quest frame rate are pending device testing.

[Meta Browser specifications](https://developers.meta.com/vr/documentation/web/browser-specs/) · [Immersive Web WebGPU binding draft](https://github.com/immersive-web/webxr-webgpu-binding/blob/main/index.bs)
