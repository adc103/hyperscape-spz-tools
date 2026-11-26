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

An export ZIP enables visibility masks on both viewers. On Quest, the exported GLB supplies the collision geometry and walkable surfaces. The viewer projects the exported spawn points onto walkable floor.

Push the left stick forward to aim. Release when the landing ring is visible. A red arc marks an invalid landing. Flick the right stick to turn 30°. Press Menu or Y on the left controller to exit. Menu requires browser support.

A standalone SPZ uses floor and obstacle estimates on Quest. ZIP-based navigation uses a browser-generated Recast navmesh. Exact agreement with the app needs headset testing.
