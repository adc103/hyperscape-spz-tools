"""Check two converter PLYs against matching RayQuadratic renders."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
from zipfile import BadZipFile

import numpy as np
from scipy.spatial.transform import Rotation
from scipy.special import expit

from convert_spz import basis, decode
from export_bundle import bundle_centroids, open_bundle, read_visibility
from finish_footprints import camera_model
from fit_sort_order import distance_order
from fit_splats import cluster_cameras, compile_raster, validate_cameras
from refine_splats import refine_projection, render_refined
from verify_fit import patch_error, source_images, validation_views


def read_ply(path):
    """Read a binary float32 vertex-only converter PLY in scan coordinates."""
    with path.open("rb") as stream:
        if stream.readline(16).strip() != b"ply":
            raise ValueError(f"{path}: missing PLY signature")
        if stream.readline(80).split() != [b"format", b"binary_little_endian", b"1.0"]:
            raise ValueError(f"{path}: expected a binary little-endian PLY")
        properties = []
        count = 0
        for _ in range(256):
            fields = stream.readline(4096).split()
            if fields == [b"end_header"]:
                break
            if not fields:
                raise ValueError(f"{path}: incomplete PLY header")
            if fields[0] in (b"comment", b"obj_info"):
                continue
            if len(fields) == 3 and fields[:2] == [b"element", b"vertex"] and not count:
                count = int(fields[2])
                if count < 1:
                    raise ValueError(f"{path}: expected at least one vertex")
            elif len(fields) == 3 and fields[0] == b"property" and fields[1] in (b"float", b"float32") and count:
                properties.append(fields[2])
            else:
                raise ValueError(f"{path}: expected only float32 vertex properties")
        else:
            raise ValueError(f"{path}: PLY header is too long")
        if not count or len(set(properties)) != len(properties):
            raise ValueError(f"{path}: invalid vertex properties")
        if path.stat().st_size - stream.tell() != 4 * count * len(properties):
            raise ValueError(f"{path}: vertex data length differs from the header")
        values = np.fromfile(stream, dtype="<f4").reshape(count, len(properties))

    fields = {name.decode(): index for index, name in enumerate(properties)}
    rest = sum(name.startswith("f_rest_") for name in fields)
    if rest not in (0, 9, 24, 45) or not np.isfinite(values).all():
        raise ValueError(f"{path}: invalid spherical harmonics or nonfinite vertex data")

    def columns(*names):
        try:
            return values[:, [fields[name] for name in names]]
        except KeyError as error:
            raise ValueError(f"{path}: missing property {error.args[0]}") from error

    undo = Rotation.from_rotvec([-np.pi/2, 0, 0])
    xyz = undo.apply(columns("x", "y", "z")).astype("f4")
    quat = Rotation.from_quat(columns("rot_1", "rot_2", "rot_3", "rot_0"))
    rotation = (undo * quat).as_matrix().astype("f4")
    opacity = expit(columns("opacity").ravel())
    sizes = columns("scale_0", "scale_1", "scale_2")
    dc = columns("f_dc_0", "f_dc_1", "f_dc_2")
    sh = columns(*(f"f_rest_{i}" for i in range(rest))).reshape(count, 3, rest//3)
    if rest:
        directions = np.random.default_rng(717).normal(size=(96, 3))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        harmonics = basis(directions)[:, :rest//3]
        rotated = basis(undo.inv().apply(directions))[:, :rest//3]
        matrix = np.linalg.lstsq(harmonics, rotated, rcond=None)[0]
        sh = sh @ matrix.T.astype("f4")
    return xyz, sizes, rotation, opacity, dc, sh


def render_orders(lib, model, camera, width, height):
    data, ids, _ = refine_projection(model, camera, width, height)
    params = np.zeros((len(ids), 10), dtype="f4")
    params[:, 3] = model[3][ids]
    radial = distance_order(model[0], ids, camera)
    for packed, settings in ((data, params), (data[radial], params[radial])):
        colors, _ = render_refined(lib, packed, settings, width, height)
        yield colors[:, :, :3].clip(0, 1)


def scores(rgb, target):
    error = np.mean((rgb - target)**2, axis=2, dtype="f8")
    return np.array([error.mean(), patch_error(error)])


def compare(lib, source, models, cameras, widths, visibility, tolerance):
    failed = False
    names = ("frame", "worst patches")
    for width in widths:
        height = round(width * 9 / 16)
        count = 0
        worst = np.full(2, -np.inf)
        location = [None, None]
        regressions = 0
        for index, camera in enumerate(cameras, 1):
            targets = source_images(lib, source, camera, (width, height), visibility)
            # The renderer omits empty targets. Skip unlabelled pairs instead
            # of confusing a masked-only reference with the unmasked image.
            if len(targets) != (2 if visibility is not None else 1):
                continue
            count += 1
            baseline, candidate = (render_orders(lib, model, camera, width, height) for model in models)
            for order, (old, new) in zip(("depth", "distance"), zip(baseline, candidate)):
                for reference, target in zip(("unmasked", "masked"), targets):
                    change = scores(new, target) - scores(old, target)
                    if not np.isfinite(change).all():
                        raise ValueError("The PLY produced nonfinite render scores")
                    regressions += int(np.any(change > tolerance))
                    for metric in np.flatnonzero(change > worst):
                        worst[metric] = change[metric]
                        location[metric] = f"camera {index}, {order}, {reference}"
        if not count:
            raise ValueError(f"No nonempty RayQuadratic reference views at width {width}")
        failed |= regressions > 0
        print(f"{width} × {height}: {count}/{len(cameras)} cameras, {regressions} regressing comparisons")
        for name, change, label in zip(names, worst, location):
            print(f"  Largest {name} MSE change: {change:+.6g} ({label})")
    return int(failed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="Export ZIP, folder or SPZ")
    parser.add_argument("baseline", type=Path, help="Current converter PLY")
    parser.add_argument("candidate", type=Path, help="Converter PLY to check")
    parser.add_argument("--cameras", type=Path, help="Use converter-format camera JSON instead of capture poses")
    parser.add_argument("--widths", type=int, nargs="+", default=(448, 960, 1280),
                        help="Render widths from 128 to 1920 (default: 448 960 1280)")
    parser.add_argument("--mse-tolerance", type=float, default=5e-10,
                        help="Allowed increase in normalized RGB MSE per comparison (default: 5e-10)")
    args = parser.parse_args()
    if not all(128 <= width <= 1920 for width in args.widths):
        parser.error("Widths must be 128–1920")
    if not np.isfinite(args.mse_tolerance) or args.mse_tolerance < 0:
        parser.error("MSE tolerance must be finite and nonnegative")
    try:
        with open_bundle(args.capture) as (scan, folder):
            source = camera_model(decode(scan))
            visibility = None
            clusters = None
            if folder is not None and any((folder/name).is_file() for name in
                                          ("cluster_centroids.json", "od_cluster_centroids.json")):
                path = bundle_centroids(folder)
                visibility = read_visibility(path, len(source[0]))
                clusters = cluster_cameras(path, len(source[0]))
            if args.cameras:
                cameras = validate_cameras(json.loads(args.cameras.read_text()))
            elif folder is not None and (folder/"camera_poses.json").is_file():
                cameras, _ = validation_views(folder/"camera_poses.json", clusters)
            else:
                raise ValueError("Include camera_poses.json in the export or pass --cameras")
            models = [read_ply(path) for path in (args.baseline, args.candidate)]
            with tempfile.TemporaryDirectory(prefix="hyperscape-compare-") as scratch:
                return compare(compile_raster(scratch), source, models, cameras,
                               args.widths, visibility, args.mse_tolerance)
    except (OSError, EOFError, KeyError, ValueError, BadZipFile,
            subprocess.CalledProcessError, np.linalg.LinAlgError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
