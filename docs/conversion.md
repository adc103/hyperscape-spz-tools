# Convert a scan to standard Gaussian splats

The converter reads Hyperscape SPZ v2 with flags `0x0C` and writes binary float32 3DGS PLY. The default fit adjusts scale and opacity against RayQuadratic renders. Add `--refine` to also fit each scale axis, small position offsets, and low-order color. The exports keep the original splat count, rotations, and spherical harmonic degree.

## Run locally

Use Python 3 with NumPy and SciPy, and a C++ compiler. The fit runs on the CPU and was tested on Linux. On Windows, use WSL. Set `CXX` to choose a compiler.

```sh
python -m pip install numpy scipy
python tools/convert_spz.py scan.spz scan.ply
```

For a closer match, run the refinement pass:

```sh
python tools/convert_spz.py scan.spz refined.ply --refine
```

`--refine` adds 768 fitting updates by default. Use `--refine STEPS` to change that count. It uses the same source SPZ and camera poses as the first pass.

For the most detailed fit, run:

```sh
python tools/convert_spz.py scan.spz refined.ply --refine-wide
```

This also fits a second set of cameras at two resolutions, starting from an estimate of the source renderer’s view-dependent opacity. It blends the two fits into one standard PLY. Expect a longer CPU run.

Open the PLY in SuperSplat or another standard 3DGS viewer. Keep the SPZ for native RayQuadratic rendering.

```sh
python tools/convert_spz.py scan.spz decoded.ply --attributes-only
```

`--attributes-only` writes the decoded splat parameters directly and needs no C++ compiler. Use it to compare the decoded and fitted results.

## Set custom camera views

By default the converter samples camera positions on the inferred floor and renders up to 64 views at different headings, heights, and fields of view. A second sweep gives less densely scanned areas more coverage. The automatic fit keeps some of the original scale and opacity to limit changes in areas the sampled views miss. For scans that cover multiple levels or have unreliable floor estimates, supply a JSON array of cameras with `--cameras cameras.json`. Each row contains `[x, y, z, yaw, pitch, horizontal_fov, roll]` in the source scan's Z-up coordinates. Use degrees for angles. Include views from different positions and distances for the areas that matter.

`--steps` controls the number of fitting updates and `--width` controls the reference render width. Larger values take more CPU time. The output keeps its original Gaussian count and SH degree at every setting.

The automatic fit defaults to `--width 448 --steps 512`.

## Rendering differences

The converter fits a Gaussian footprint to a quadratic footprint. Standard PLY stores one opacity per splat. RayQuadratic adjusts opacity and visibility for the current view, and blends by distance from the camera. A viewer can blend the same PLY differently depending on its sorting and filtering settings.
