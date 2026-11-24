# Hyperscape SPZ tools

Open a Hyperscape room scan locally, study how the APK renders it, or walk through it in a Quest browser. Both viewers read the original SPZ in the browser. Scan files, visibility masks, and camera settings stay on the device.

[Open the hosted viewers](https://adc103.github.io/hyperscape-spz-tools/)

| Viewer | Start here |
|---|---|
| Desktop | Open [viewer/desktop.html](viewer/desktop.html) from a local checkout or the extracted ZIP, then select an SPZ. Drag to look, use WASD to move, and Q/E to change height. |
| Quest | Serve this directory over HTTPS. In the Quest browser, open [viewer/quest.html](viewer/quest.html), select an SPZ already on the headset, position the preview camera, and select **Enter VR**. Use the left thumbstick to move and the right thumbstick to turn. |

GitHub's source-file view displays the HTML as source. Use an HTTPS static host for the live Quest page. With a local checkout, `python3 -m http.server 8000` serves the desktop and Quest previews at `http://localhost:8000/viewer/` for desktop development.

## Files and rendering

- [Preparing an exported scan](docs/scan-files.md) describes the expected SPZ, validation, optional visibility files, and the headset-to-browser handoff.
- [How the Hyperscape APK renders the scan](docs/rendering.md) covers the custom SPZ fields, Mip-Splatting, RayQuadratic projection and blending, visibility, sorting, stereo, and temporal composition. It includes build-specific disassembly anchors.
- [Viewer feature coverage](docs/viewers.md) explains which controls are available in each path and what still needs a headset test.

The repository contains source code and documentation.
