# Preparing an exported Hyperscape scan

Start with a scan you own and an SPZ file that you already obtained through an authorized export or received from its owner. The verified capture in the rendering reference was a Meta Quest 3 scan read at model-load time by Hyperscape Capture 17.0.0.1.262. This guide starts at the exported model buffer. It does not establish an in-app SPZ export command for that build.

## Verify the original file

1. Keep the file compressed and give it the extension `.spz`.
2. Run `python3 tools/check_spz.py path/to/scan.spz` from the repository root, or open it in the desktop viewer.
3. The supported format is gzip-compressed SPZ v2 with an `NGSP` header and flags `0x0C`. Those flags select Hyperscape's axis-angle rotation encoding and planar YUV spherical harmonics. See the [rendering reference](rendering.md#2-spz-format-and-decoding) for the complete byte layout.

## Optional visibility files

If your export includes `cluster_centroids.json` and `cluster_masks.bin`, select both with **Add companion files**. You can also select a ZIP containing the matching pair. If a ZIP contains multiple scans, put each pair in its `<scan-stem>_visibility_clusters/` directory so the viewer can find the correct one.

The viewer picks the nearest centroid and consults its mask before drawing splats. The SPZ contains the positions, scales, rotations, opacity, and color. Visibility files can reduce rendering work or remove stray splats. RayQuadratic rendering works with the SPZ alone.

## Bring the file into the Quest browser

Transfer the SPZ using a file-sharing method you already use and save it where the Quest browser's file picker can see it. Open the HTTPS page, select **Open SPZ**, and choose the local file. The app-directory dump and APK are unnecessary for viewing.
