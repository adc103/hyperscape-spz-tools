# Convert a scan to standard Gaussian splats

The converter reads Hyperscape SPZ v2 with flags `0x0C` and writes binary float32 3DGS PLY. The default fit adjusts scale and opacity against RayQuadratic renders. Add `--refine` to also fit each scale axis, small position offsets, and low-order color. The regular fits keep the original splat count, rotations, and spherical harmonic degree.

## Run locally

Use Python 3 with NumPy and SciPy, and a C++ compiler. The fit runs on the CPU and was tested on Linux. On Windows, use WSL. Set `CXX` to choose a compiler.

```sh
python -m pip install numpy scipy
python tools/convert_spz.py capture.zip
```

The capture ZIP uses its centroids for fitting and writes the PLY next to the ZIP. When present, recorded poses and visibility masks help validate the fit. Validation checks both full frames and the worst image patches. It runs the first fit, the refinement, the wide fit, and the final footprint fit. Each native reference is rendered once and shared by every pass, the temporary cache uses up to half the free disk while keeping 1 GB free, and the fitting kernels use every CPU core. Set `HYPERSCAPE_THREADS` to limit the core count.

## Fit from the app's viewpoints

For the closest match, give the converter the app's cluster file. See [extraction step 5](extract.md#5-get-the-cluster-file-for-converting) to get it.

```sh
python tools/convert_spz.py scan.spz scan.ply --clusters cluster_centroids.json
```

The app saves one centroid per visibility cluster, at standing eye height. These are the spots it places you in. The converter fits four headings from each one, renders references at 1280 px, and keeps the full fitted result. It works with every pass below, for example `--clusters cluster_centroids.json --fit-sort-order`.

Measured on one room scan against native RayQuadratic renders, in PSNR (higher is closer). The scored views are 64 views at 1280 px from cluster positions the fit did not use. For this test the fit used the other half of the centroids. The converter uses all of them.

| Export | Depth order | Distance order |
|---|---|---|
| `--attributes-only` | 28.6 dB | 29.7 dB |
| Automatic cameras, `--fit-sort-order` | 34.2 dB | 35.2 dB |
| `--clusters`, first fit only | 35.0 dB | 36.7 dB |
| `--clusters --fit-sort-order` | 39.1 dB | 40.1 dB |

Distance order matches the app more closely in every case, so use it in viewers that let you choose. The full chain at 1280 px took about 1 h 45 min on two CPU cores with 128 views. The converter fits all centroids, so expect a longer run. Use `--width` to trade detail for time.

## Refine the fit

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

To reduce spill around sharp edges, try the footprint pass:

```sh
python tools/convert_spz.py scan.spz refined-edges.ply --split-footprints
```

It runs the wide fit, then replaces some large, flat splats with compact groups. A group must improve the projected opacity match by at least 25% across the sampled views. The file can contain more splats, and individual views can still favor the wide fit alone.

Open the PLY in SuperSplat or another standard 3DGS viewer. Keep the SPZ for native RayQuadratic rendering.

```sh
python tools/convert_spz.py scan.spz decoded.ply --attributes-only
```

`--attributes-only` writes the decoded splat parameters directly and needs no C++ compiler. Use it to compare the decoded and fitted results.

## Run the final footprint fit

```sh
python tools/convert_spz.py scan.spz finished.ply --finish-footprints
```

This runs the wide fit, then fits scale and opacity once more. The extra 320 updates leave positions, rotations, colors, and splat count as they were. Add `--split-footprints` to replace large, flat splats with compact groups first. Capture ZIPs run this pass by default.

## Fit for both draw orders

```sh
python tools/convert_spz.py scan.spz fitted.ply --fit-sort-order
```

This adds a pass after `--finish-footprints` that fits scale, opacity, and color on the splats most affected by draw order. On capture fits it changes the result very little and adds noticeable time, so captures skip it unless you ask for it. It compares depth and distance sorting and leaves splat positions and count intact. Use either export in a standard viewer. The viewer still chooses the draw order.

## Set custom camera views

By default the converter samples camera positions on the inferred floor and renders up to 64 views at different headings, heights, and fields of view. A second sweep gives less densely scanned areas more coverage. The automatic fit keeps some of the original scale and opacity to limit changes in areas the sampled views miss. For scans that cover multiple levels or have unreliable floor estimates, use `--clusters` or supply a JSON array of cameras with `--cameras cameras.json`. Each row contains `[x, y, z, yaw, pitch, horizontal_fov, roll]` in the source scan's Z-up coordinates. Use degrees for angles. Include views from different positions and distances for the areas that matter.

`--steps` controls the number of fitting updates and `--width` controls the reference render width. Larger values take more CPU time. The output keeps its original SH degree at every setting.

The automatic fit defaults to `--width 448 --steps 512`. With `--clusters` the defaults are `--width 1280 --steps 512`.

## Check a PLY for regressions

Compare two converter exports from the same capture.

```sh
python tools/compare_ply.py capture.zip previous.ply candidate.ply
```

The tool renders recorded and nearby views at 448, 960, and 1280 pixels.
It checks whole frames and the worst image patches in both draw orders,
with and without visibility masks when available. The report identifies
the view, order, and reference for the largest increase in error at each
resolution. The command exits with status 1 if a comparison exceeds the
error tolerance, or 2 if it cannot complete the check.

Use `--cameras cameras.json` to check specific views or to use a standalone
SPZ. Use `--widths` to choose render widths. The PLY inputs must use the
converter’s binary float32 Gaussian layout and orientation.

## Compare draw orders in the browser

Open the [PLY viewer](https://adc103.github.io/hyperscape-spz-tools/viewer/ply.html) on desktop and load a converted PLY. Use **Draw order** to switch between distance and depth at the same camera pose. Distance is the default. The viewer opens the file locally.

To reproduce a converter camera, load its JSON with **Load camera**. The viewer accepts one pose or uses the first row from a pose list. The camera convention matches converter exports.

## Rendering differences

The converter fits a Gaussian footprint to a quadratic footprint. Standard PLY stores one opacity per splat. RayQuadratic adjusts opacity and visibility for the current view, and blends by distance from the camera. A viewer can blend the same PLY differently depending on its sorting and filtering settings.


