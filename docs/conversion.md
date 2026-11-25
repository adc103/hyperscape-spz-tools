# Convert a scan to standard Gaussian splats

The converter reads Hyperscape SPZ v2 with flags `0x0C` and writes binary float32 3DGS PLY. The fitted export adjusts each splat’s scale and opacity against RayQuadratic reference views. It keeps the source splat count, positions, orientations, and all spherical harmonics through degree 3.

## Run locally

Use Python 3 with NumPy and SciPy, and a C++ compiler. The fit runs on the CPU and was tested on Linux. On Windows, use WSL. Set `CXX` to choose a compiler.

```sh
python -m pip install numpy scipy
python tools/convert_spz.py scan.spz scan.ply
```

Open the resulting PLY in SuperSplat or another standard 3DGS viewer. Keep the original SPZ for RayQuadratic rendering.

```sh
python tools/convert_spz.py scan.spz decoded.ply --attributes-only
```

`--attributes-only` writes the decoded splat parameters directly and needs no C++ compiler. Use it to compare the two exports. The fitted export approximates the reference renderer, and the match can vary with the camera angle and the target viewer.

## Set custom camera views

By default the converter samples camera positions on the inferred floor and renders up to 64 views at different headings, heights, and fields of view. A second sweep gives less densely scanned areas more coverage. The automatic fit keeps some of the original scale and opacity to limit changes in areas the sampled views miss. For scans that cover multiple levels or have unreliable floor estimates, supply a JSON array of cameras with `--cameras cameras.json`. Each row contains `[x, y, z, yaw, pitch, horizontal_fov, roll]` in the source scan's Z-up coordinates. Use degrees for angles. Include views from different positions and distances for the areas that matter.

`--steps` controls the number of fitting updates and `--width` controls the reference render width. Larger values take more CPU time. The output keeps its original Gaussian count and SH degree at every setting.

The automatic fit defaults to `--width 448 --steps 512`. For a finer fit, try `--width 640 --steps 640` and compare the result from the viewpoints you care about.
