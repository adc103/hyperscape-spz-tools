# How Hyperscape loads and renders an SPZ scan

Meta Hyperscape Capture 17.0.0.1.262 (1015808524). The saved-scan path uses custom SPZ rotation and color encoding and the RayQuadratic kernel.

## 1. Saved-scan loading

The saved-scan path runs through the following managed methods in `HHC.dll`.

1. `CaptureViewerManager` collects the SPZ and, when present, camera poses, scene mesh, visibility centroids, and visibility masks. It processes the camera poses and scene mesh separately.
2. `CaptureViewerManager.FinalizeSplatLoad` calls `HyperscapeViewer.AddHyperscape` with format **4** and kernel **7**. The managed enum tables identify these as `Spz` and `RayQuadratic`. The native kernel name table also maps 7 to `rayquad`.
3. `HyperscapeViewer` writes visibility cluster files keyed by the model name, creates a preloaded renderer, and passes the byte buffer, format, and kernel into `SplatModel`.
4. `SplatRenderer.SetModel` leads to `ConstellusRenderer.RegisterModel`. The native loader in `libConstellusUnityPlugin.so` decodes the SPZ, prepares GPU buffers, and keeps the selected kernel for the rendering pass.

Hyperscape handles a glTF scene mesh separately through `MeshManager.LoadGltfFile`. The importer disables the mesh's renderer. The mesh builder sets up collision and navigation, with visible rendering controlled by `_showMeshForDebug` through a shader-warmup coroutine. The serialized production splat feature disables camera-depth testing.

## 2. SPZ format and decoding

The gzip stream starts with a 16-byte little-endian header.

| Offset | Field | Value |
|---|---|---|
| 0 | Magic | `NGSP` |
| 4 | Version, uint32 | 2 |
| 8 | Gaussian count, uint32 | `N` |
| 12 | Spherical harmonic degree | `D` |
| 13 | Position fractional bits | `F` |
| 14 | Flags | `0x0C` |
| 15 | Reserved | 0 |

Offsets below start after the header. Let `T = (D + 1)² − 1`.

| Offset | Length | Decode |
|---|---:|---|
| `0` | `9N` | Three signed little-endian 24-bit coordinates per splat. Divide by `2^F`. Coordinates are Z-up. |
| `9N` | `N` | Alpha. Byte divided by `255`. Keep alpha exact in native-style processing. Use an opacity logit when writing 3DGS PLY. |
| `10N` | `3N` | RGB DC coefficients. Decode each byte as `(byte / 255 − 0.5) / 0.15`. |
| `13N` | `3N` | Three log-scale values. Decode as `byte / 16 − 10`. The native buffer-loading path exponentiates these for rendering with a model load scale of `1.0`. |
| `16N` | `3N` | Axis-angle rotation-vector bytes, selected by flag `0x04`. Decode each component as `byte × (2π / 255) − π`. Convert the vector to a unit quaternion with a small-angle guard. Native order is XYZW. 3DGS PLY uses WXYZ. |
| `19N` | `3NT` | Higher-order SH coefficients, selected by flag `0x08`. Three contiguous Y, U, V byte planes, each containing `N × T` values. Decode them using the equations below. |

For each higher-order coefficient, first normalize each input byte with `(byte − 128) / 128`. Then apply the float32 color constants below.

```text
R = Y + 1.5748 × V
G = Y − 0.1873 × U − 0.4681 × V
B = Y + 1.8556 × U

SH_RGB = (RGB − 0.5) / 0.2820948064
```

The 8-bit GPU path repacks DC as `clamp(round(38.25 × DC + 127.5), 0, 255)` and higher-order terms as `clamp(round(128 × SH + 128), 0, 255)`. The shader reverses both transforms.

## 3. Selection, visibility and continuous level of detail

Preserve the original Gaussian order through decoding. The same original index identifies the Gaussian in the visibility bitstream and determines eligibility in the continuous level-of-detail shader.

- **Visibility clusters.** Hyperscape can pick the nearest centroid and read a packed mask at bit `clusterIndex × N + gaussianIndex`.
- **Frustum and depth.** The culling shader can combine masks with clip-space tests and an optional scene-depth test.
- **Distance-based detail.** The multiview culling shader averages the left and right camera-space positions, measures the resulting distance, and normalizes it between the near and far distances. It interpolates the retained fraction between the two detail settings. A Gaussian is eligible when its original index is at most that fraction times the original count. Optional flags apply distance contraction or multiply the fraction by a peripheral-view factor. Projection has a separate opacity fade near a detail boundary. A budget-driven branch and a pass that caps the surviving count are also present.
- **Adaptive budget.** The native creation path seeds near and far detail at `0.95` and `0.60`, with distances of `2 m` and `6 m`. The bundled renderer settings expose that distance range and a `10.5 ms` default tuning budget. The packaged SplatRenderer prefab has a custom detail configuration with `1.0` near detail, `0.60` far detail, `2–6 m`, and a `13.8 ms` budget. These are initialization and serialized values. On an enabled adaptive path, the renderer measures GPU render duration, adjusts a bounded quality multiplier against its target, and caps a single multiplier change at 10% of its current value. The headset's effective quality factors are frame-dependent.

## 4. Projection and the RayQuadratic kernel

The bundled render graph uses the `HyperscapeODProd` profile, render resolution scale `0.90`, and Mip-Splatting enabled. The native setup enables sorting by **camera distance**. The multiview projection shader averages the two eyes' depth keys before sorting. With the distance flag enabled, each eye's key is the Euclidean distance to the Gaussian center.

### Stereo camera and focal length

Unity obtains the view and projection matrices for eye indices 0 and 1 from the XR pass. It converts each projection with `GL.GetGPUProjectionMatrix(P, false)`. The model draw path also reads the model's local-to-world transform. Keep each eye's projection and view distinct, including off-axis projection terms.

The Unity render graph scales the camera target dimensions by `0.90` in the bundled profile. `GetRTDimensionsForCamera` rounds to the nearest integer, with ties to even, and clamps each dimension to `128–4096` pixels. With those intermediate dimensions `W, H` and the left eye's GPU projection matrix `Pleft`, the native view data computes the **shared** base focal vector `(W × Pleft[0,0] / 2, H × Pleft[1,1] / 2)`. The multiview ray shader reads that one vector for both eyes before applying any per-eye peripheral adjustment.

### Depth-sort precision

The native scene setup supplies a **0.1–1500 m** sort-key range. These constants belong to sort-key normalization and are separate from the camera clip planes. In the projection shader's 16-bit branch, normalize the averaged depth to that range, clamp it to `[0, 1]`, raise it to the power `0.4`, and convert with `floor(value × 65534 + 0.5)`. The reverse-order flag complements the powered value before conversion. The wider-key branch bitcasts a positive float depth, using `1 / (depth + 1e-7)` for reverse order.

The 16-bit curve gives roughly **0.7 mm** depth bins at 1 m, **1.4 mm** at 3 m, and **2.1 mm** at 6 m. Gaussians can tie within a bin, so reproducing tie order matters for exact overlapping-splat blending if that branch is active. The production initialization path selects **32-bit keys**. The `HyperscapeODProd` branch of `InitSplatRenderer` clears the width selector (`AppParams + 106`). Scene creation maps zero to 32 bits and a nonzero selector to 16 bits, then passes that width to the splatter constructor. The constructor uses four bytes for the production key. Its `is16BitSorting` getter returns true only for the two-byte case.

The culling shader uses workgroup and global atomics to compact visible indices. Equal sort keys can retain GPU emission order.

### Per-splat evaluation

1. **Expand the Gaussian for the current pixel footprint.** Let `p` be the camera-space center in the Gaussian's rotated frame and `s` its render scale. With covariance bias `b = 0.1`, the filtered scale is `s' = sqrt(s² + b × dot(p,p) / abs(fx × fy))` componentwise. Let `c = length(p / s')`. The projected opacity is the input opacity multiplied by `length(p × (sy × sz, sz × sx, sx × sy)) / (s'x × s'y × s'z × c)`. Use the effective focal vector after any peripheral adjustment.
2. **Build ray support.** Set `n = (p / s') / c`, `sign = +1` when `n.z > 0` and `−1` otherwise, and `v = n + sign × (0,0,1)`. Take the first two columns of `2 × v × transpose(v) / dot(v,v) − I` and multiply the first column by `sign`. Scale both columns componentwise by `s'` and rotate them into camera space. If the resulting two-column matrix is `Q`, multiply it on the right by the eigenvector matrix of `transpose(Q) × Q`. The projection shader packs those two final columns, the camera-space center, and `min(c,65504)` as FP16. It separately packs projected RGBA, including opacity, as FP16. Native radius trim defaults to `0.0`. For packed peak opacity `A` before vertex fading and packed whitened center length `c`, the vertex shader uses the following support extent.

```text
k = 9 − 9 / (255 × A)
supportHalfExtent = sqrt(k × c² / (c² − k))
```

It uses the finite support extent only when `k > 0` and `c² > k`. Otherwise it zeros the splat's opacity and extent. The vertex shader applies the depth fade and opacity cutoff afterward. Quad support and the fragment threshold should be implemented together, since widening a fixed Gaussian footprint changes their coverage.
3. **Evaluate view-dependent color.** The shader computes the direction from the camera to the center in model space. It evaluates DC with `C0 = 0.2820948064` and the degree 1 through 3 terms, then floors RGB at zero. When foveated SH is enabled, the shader progressively reduces higher-order terms toward the periphery. The packaged configuration uses tangent-space thresholds `0.5` and `1.0`.
4. **Apply opacity thresholds.** The bundled fade configuration fades splats with opacity below `0.20` over the camera-depth interval `5–9 m`. The vertex culling threshold is `0.0625` in the serialized configuration. The fragment shader separately discards samples below `1/255`.
5. **Apply the actual RayQuadratic falloff.** For interpolated support coordinate `uv` and whitened-center length `c`, the fragment shader evaluates the following function and outputs premultiplied color.

```text
d = 1 / (1 / c² + 1 / dot(uv, uv))
fragmentAlpha = splatOpacity × (1 − d / 9)
discard if fragmentAlpha < 1 / 255
fragmentColor = (RGB × fragmentAlpha, fragmentAlpha)
```

## 5. Temporal reprojection and compositing

The serialized feature enables **back-to-front rendering**. For the RayQuadratic fragment's premultiplied color, the corresponding color recurrence is `C = RGB × alpha + Cbehind × (1 − alpha)`. The native blend helper also has a front-to-back accumulation mode with destination-alpha-dependent source weight. Both recurrences agree in exact arithmetic when they traverse the same ordered samples in opposite directions.

The renderer feature's serialized `_enableDepthTest` is `false` and its opacity-peeling layer count is `0`. `CopyCameraDepthToIntermediateBuffer` returns before copying when its depth-test flag is false and also requires valid source and destination textures when enabled.

The bundled renderer feature stores `FramesToReproject = 3`. The native setup passes this setting into the reprojection scheduler. The compute path first updates device buffers, then skips the full cull, indirect preparation, projection, and depth-sorting work when its unsigned frame test `(counter − 1) % (framesToReproject + 1) != 0` selects the reuse path. At the bundled value, that is a four-frame cadence when the optimization is active. Runtime conditions can affect when the counter is reset or which composition path is used.

The two-pass foveation compositor can draw the low-resolution and full-resolution layers at different times. In the inspected multiview shader:

- Mode 1 samples the previous frame for the low-resolution layer. Mode 2 does so for the full-resolution layer. Other modes sample both current layers.
- Reprojection maps the current UV into clip space, transforms through the current inverse view-projection and the previous view-projection, and samples the previous frame at the resulting UV. This shader uses a fixed clip depth of `0.01` or `0.99` selected by depth convention. It falls back to the original UV for out-of-bounds results.
- The compositor blends the two layers radially with a smooth transition centered separately for each eye.

### Output color and the camera-target blit

The projection shader has a `kOutputLinearRgb` specialization constant (ID 6, shader default 0). When set to 1, it applies `pow(RGB, 2.2)` to the evaluated color before FP16 packing and per-splat premultiplication. A separate native opaque-scene composition shader has its own conversion control and applies the same power to the sampled composite's RGB. Keep those two conversion points distinct when reproducing blend results.

The opaque-scene shader samples color and depth with scaled UVs. If alpha correction is enabled and sampled alpha is positive, it divides RGB by alpha, raises alpha to the configured power, optionally replaces it above the configured threshold with `clamp(boost × alpha − offset, 0, 1)`, and multiplies RGB by the corrected alpha. The native constructor initializes alpha correction off. The shader also has alpha-threshold and unpremultiplication branches and writes the sampled depth.

The Unity render graph requests `R8G8B8A8_UNorm` for the color intermediate and explicitly sets the descriptor's `sRGB` flag to false. `BlitToTarget` binds the camera color target and can bind depth alongside it. It uses Unity's texture blitter, with an alternate overload for a supplied material. The intermediate format describes storage at that stage. The final camera target, headset compositor, and screenshot capture determine later color transfer.

## 6. Quest teleport and floor

Hyperscape builds a Unity navigation mesh from the scene geometry and injects its surface into the teleport interactable. The agent radius is 0.4 m, the height is 2 m, and the climb limit is 0.04 m. The controller pointer supplies the arc origin. The packaged gravity arc samples 30 points over one second, multiplies gravity by 2.3, and maps horizontal head-to-pointer distance and controller pitch through serialized curves. Candidate selection checks blockers between the head and the arc origin, then tests the arc segments for a surface hit. The spawn controller tracks floor height separately from eye height.

The browser uses the same arc curves and blocks invalid hits. The SPZ supplies the points for an inferred single-level floor and obstacle map. Quest's floor-relative tracking supplies standing and crouching height. The browser shows a landing ring and uses its inferred map in place of the native mesh.

## 7. Code locations

Addresses below are virtual addresses in this build. Shader paths are relative to `Constellus/spv`.

| Evidence | Location |
|---|---|
| Saved-scan format and kernel selection | `HHC.dll` / `CaptureViewerManager.FinalizeSplatLoad`, call at `0x5a2dc18` in `libil2cpp.so`. |
| Separate mesh rendering and navigation | `<LoadGltfFile>d__20.MoveNext` disables the renderer at `0x5a34acc`. `<MeshBuilderCoroutine>d__26.MoveNext` at `0x5a34d9c` handles collision, navigation, and the visibility flag passed to the shader-warmup coroutine. |
| Teleport surface and agent settings | `CaptureViewerManager.BuildNavMesh` at `0x5a2e2a0`, `SetupTeleportInteractable` at `0x5a2e85c`, and `SceneNavigation.CreateNavMeshBuildSettings` at `0x5a562d8`. |
| Quest controller teleport | `TeleportArcGravity.PointAtIndex` at `0x5fc6f5c`, `CalculateSpeed` at `0x5fc71e0`, `RemapPitch` at `0x5fc74d0`, and `TeleportCandidateComputer.ComputeCandidate` at `0x5fc7d5c`. Both controller arc components in `level0` carry the same parameters. |
| Floor and spawn | `PlayerSpawnController.PositionAtSpawn` at `0x59d10e4` and `FinalizeTeleport` at `0x59d0f94`. |
| SPZ header flags and attribute unpacking | `libConstellusUnityPlugin.so`, `hyperscape::spz::loadSpz` at `0x2d61bc` and `unpackGaussians` at `0x2d3a90`. |
| Native buffer loader and SH repacking | `loadSpzGaussianSplattingDataFromBuffer` at `0x2cf8d8`, model conversion at `0x2ce364`, and 8-bit SH packing at `0x2d0984`. |
| Production renderer feature | `globalgamemanagers.assets`, serialized object 5083. Optional per-model settings appear in `sharedassets0.assets`, SplatRenderer object 2598. |
| Cluster indexing, depth tests, and distance detail | `culling/variants/frustum_culling_clusters_depth_hyperscape_clod_multiview.comp.spv` and native `VisibilityCache::findClosestCluster` at `0x33d72c`. |
| Visibility sidecar handoff | Managed `WriteVisibilityClusterFiles` at `0x59d21ec` and native `loadVisibilityCache` at `0x260408`, with the bitstream size calculation at `0x260758–0x260768`. |
| Frame-time-driven detail tuning | Native `CLodAutoTune::update` at `0x29086c` and `adjustLodParams` at `0x290984`. |
| Ray projection, support, and fragments | `paracosma/project_raygs_sh8b_multiview.comp.spv`, `hw_rast/splat_quad_raygs_multiview.vert.spv`, `rasterization/splat_quad_raygs.frag.spv`. |
| Output texture dimensions and optional camera depth | `libil2cpp.so`, `GetRTDimensionsForCamera` at `0x359a304` and `CopyCameraDepthToIntermediateBuffer` at `0x359ad9c`. Serialized values in `globalgamemanagers.assets` object 5083. |
| Stereo transforms and base focal | Managed `GetViewMatrices` at `0x35996e4` and model transform call at `0x359b3a4`. Native `updateFocalLength` at `0x37724c`. |
| Depth-sort width and encoding | Selector cleared at `0x242e9c`, width chosen at `0x218e10–0x218e4c`, bytes per key set at `0x27c0f0–0x27c104`, and sort range set at `0x21c02c`. The projection shader's `encodeDepth` and `storeDepth` implement the key formats. |
| Equal-key ordering and compositing | Visibility compaction in the clustered CLoD shader, native `BlendMode::premultipliedAlpha` at `0x29d8c0`, and serialized `_backToFrontRendering` in object 5083. |
| Temporal reuse and compositing | Native `executeCompute` at `0x27fb00` and `configureReprojectionOptimization` at `0x285f80`, plus `hw_rast/compose_foveation_multiview.frag.spv` and `hw_rast/composite_opaque_scene.frag.spv`. |
| Output color and camera-target transfer | `kOutputLinearRgb` in `paracosma/project_raygs_sh8b_multiview.comp.spv`, the separate controls in `hw_rast/composite_opaque_scene.frag.spv`, managed color intermediate allocation at `0x3598664–0x359869c`, and `BlitToTarget` at `0x359bbb0`. |
