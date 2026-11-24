# SPZ files

Both viewers accept gzip-compressed Hyperscape SPZ v2 files with the `NGSP` header and flags `0x0C`. Those flags select axis-angle rotation and planar YUV color coefficients.

To check an exported file from the command line:

```sh
python3 tools/check_spz.py scan.spz
```

To open a scan on Quest, copy the SPZ to the headset and select it with **Open SPZ** in the [Quest viewer](https://adc103.github.io/hyperscape-spz-tools/viewer/quest.html).

See the [rendering reference](rendering.md#2-spz-format-and-decoding) for the byte layout and decode formulas.
