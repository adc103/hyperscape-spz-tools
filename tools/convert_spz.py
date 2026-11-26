"""Convert Hyperscape SPZ v2 to portable 3D Gaussian Splatting PLY."""
import argparse
import gzip
import json
import os
from pathlib import Path
import subprocess
import tempfile
from zipfile import BadZipFile

import numpy as np
from scipy.spatial.transform import Rotation

from check_spz import read_header

C0 = np.float32(0.2820948064)


def decode(path):
    with gzip.open(path, "rb") as file:
        n, degree, bits, size = read_header(file)
        terms = (degree + 1) ** 2 - 1
        payload = file.read(size + 1)
        if len(payload) != size:
            raise ValueError("SPZ payload length differs from the header")
    raw = np.frombuffer(payload, dtype=np.uint8)
    signed = raw[:9*n].reshape(n, 3, 3).astype("i4") @ np.array([1, 256, 65536], dtype="i4")
    points = ((signed ^ 0x800000) - 0x800000).astype("f4") * np.float32(2.0**-bits)
    alpha = raw[9*n:10*n].astype("f4") / 255
    dc = (raw[10*n:13*n].astype("f4").reshape(n, 3) / 255 - .5) / .15
    scales = raw[13*n:16*n].astype("f4").reshape(n, 3) / 16 - 10
    angles = raw[16*n:19*n].astype("f4").reshape(n, 3) * np.float32(2*np.pi/255) - np.float32(np.pi)
    quats = Rotation.from_rotvec(angles).as_quat().astype("f4")
    y, u, v = (raw[19*n:].reshape(3, n, terms).astype("f4") - 128) / 128
    sh = (np.stack((y + 1.5748*v, y - .1873*u - .4681*v, y + 1.8556*u), axis=1) - .5) / C0
    return points, scales, quats, alpha, dc, sh


def basis(d):
    x, y, z = d.T
    return np.stack((
        -.4886025119*y, .4886025119*z, -.4886025119*x,
        1.0925484306*x*y, -1.0925484306*y*z, .3153915653*(2*z*z-x*x-y*y),
        -1.0925484306*x*z, .5462742153*(x*x-y*y),
        -.5900435899*y*(3*x*x-y*y), 2.8906114426*x*y*z,
        -.4570457995*y*(4*z*z-x*x-y*y), .3731763326*z*(2*z*z-3*x*x-3*y*y),
        -.4570457995*x*(4*z*z-x*x-y*y), 1.4453057213*z*(x*x-y*y),
        -.5900435899*x*(x*x-3*y*y)), axis=1)


def write_ply(output, model, log_size, opacity, overwrite=False):
    points, scales, quats, _, dc, sh = model
    n, _, terms = sh.shape
    # Match the orientation used by SuperSplat. Rotate the SH basis with the scene.
    upright = Rotation.from_rotvec([np.pi/2, 0, 0])
    if terms:
        directions = np.random.default_rng(717).normal(size=(96, 3))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        transform = np.linalg.lstsq(basis(directions)[:, :terms],
                                    basis(upright.inv().apply(directions))[:, :terms], rcond=None)[0]
        transform[np.abs(transform) < 1e-12] = 0
        transform = transform.T.astype("f4")
    names = ["x", "y", "z", "nx", "ny", "nz"]
    names += [f"f_dc_{i}" for i in range(3)] + [f"f_rest_{i}" for i in range(3*terms)]
    names += ["opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)]
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n"
    header += "".join(f"property float {name}\n" for name in names) + "end_header\n"
    # Publish a complete file atomically. Keep allocations bounded for large scans.
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(header.encode("ascii"))
            for first in range(0, n, 65536):
                part = slice(first, first+65536)
                colors = sh[part] @ transform if terms else sh[part]
                rgb_sh = colors.reshape(len(colors), 3*terms)
                alpha = np.clip(opacity[part], np.exp(-18), np.nextafter(np.float32(1), np.float32(0)))
                alpha_logit = np.where(opacity[part] == 1, 18, np.log(alpha/(1-alpha)))
                q = (upright * Rotation.from_quat(quats[part])).as_quat()[:, [3, 0, 1, 2]]
                log_adjustment = log_size[part].reshape(len(q), -1)
                row = np.column_stack((upright.apply(points[part]), np.zeros((len(q), 3)),
                                       dc[part], rgb_sh, alpha_logit, scales[part]+log_adjustment, q))
                row.astype("<f4").tofile(file)
            file.close()
            if overwrite:
                os.replace(temporary, output)
            else:
                os.link(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="SPZ file, export folder, or export ZIP")
    parser.add_argument("output", type=Path, nargs="?", help="PLY path (defaults to the SPZ name with .ply)")
    parser.add_argument("--attributes-only", action="store_true", help="Decode attributes without refitting appearance")
    views = parser.add_mutually_exclusive_group()
    views.add_argument("--clusters", type=Path,
                       help="The app's cluster_centroids.json. Fits from the spots where the app places the viewer")
    views.add_argument("--cameras", type=Path, help="Optional array of [x,y,z,yaw,pitch,horizontal_fov,roll] poses in scan coordinates")
    parser.add_argument("--steps", type=int, help="Fitting updates (512 automatic or with clusters, 320 with custom cameras)")
    parser.add_argument("--width", type=int,
                        help="Reference render width (448 automatic, 1280 with clusters, 480 with custom cameras)")
    parser.add_argument("--refine", nargs="?", const=768, type=int, metavar="STEPS",
                        help="Refine scale axes, position and color after the first fit (768 extra steps)")
    parser.add_argument("--refine-wide", action="store_true",
                        help="Blend refinement with a wider camera sweep and estimated native opacity")
    parser.add_argument("--split-footprints", action="store_true",
                        help="Reduce spill at edges by replacing selected large, flat splats")
    parser.add_argument("--finish-footprints", action="store_true",
                        help="Split wide footprints, then refit their scale and opacity against rendered views")
    parser.add_argument("--fit-sort-order", action="store_true",
                        help="Refit order-sensitive coverage and color for depth and distance sorting")
    parser.add_argument("--force", action="store_true", help="Replace an existing output")
    args = parser.parse_args()
    from export_bundle import open_bundle

    try:
        with open_bundle(args.input) as (scan, folder):
            convert(args, scan, folder)
    except (OSError, EOFError, ValueError, BadZipFile, subprocess.CalledProcessError, np.linalg.LinAlgError) as error:
        parser.exit(1, f"{error}\n")


def convert(args, scan, folder):
    from export_bundle import bundle_centroids, read_visibility

    if folder is not None and not args.attributes_only and args.cameras is None and args.clusters is None:
        args.clusters = bundle_centroids(folder)
    if args.output is None:
        args.output = args.input.with_suffix(".ply") if args.input.suffix.lower() == ".zip" else scan.with_suffix(".ply")
    if args.output.resolve() in (scan.resolve(), args.input.resolve()):
        raise ValueError("Input and output must be different files")
    if args.output.exists() and not args.force:
        raise ValueError("Output exists. Use --force to replace it.")
    steps = args.steps if args.steps is not None else (320 if args.cameras else 512)
    width = args.width if args.width is not None else (1280 if args.clusters else 480 if args.cameras else 448)
    if folder is not None and not args.attributes_only:
        args.fit_sort_order = True
    if args.fit_sort_order:
        args.finish_footprints = True
    if args.finish_footprints:
        args.split_footprints = True
    if args.split_footprints:
        args.refine_wide = True
    if args.refine_wide and args.refine is None:
        args.refine = 768
    if args.refine is not None and (args.attributes_only or args.refine < 1):
        raise ValueError("--refine needs positive steps and a fitted export")
    if steps < 1 or not 128 <= width <= 1920:
        raise ValueError("Use positive steps and a width of 128–1920")
    model = decode(scan)
    opacity = model[3]
    log_size = np.zeros_like(opacity)
    if not args.attributes_only:
        from fit_splats import auto_cameras, cluster_cameras, fit, validate_cameras
        if args.clusters:
            cameras = cluster_cameras(args.clusters, len(opacity))
        elif args.cameras:
            cameras = validate_cameras(json.loads(args.cameras.read_text()))
        else:
            cameras = auto_cameras(model)
        log_size, opacity = fit(model, cameras, steps, width)
        verification = None
        if folder is not None and args.clusters is not None:
            poses = folder / "camera_poses.json"
            if poses.is_file():
                from verify_fit import choose_strength
                try:
                    visibility = read_visibility(args.clusters, len(opacity))
                    print("Checking coverage from captured viewpoints", flush=True)
                    strength = choose_strength(model, log_size, opacity, poses, visibility, cameras)
                    verification = (poses, visibility, cameras)
                    log_size *= strength
                    opacity = np.clip(model[3] + strength*(opacity-model[3]),0,1)
                    print(f"Coverage fit strength: {strength:g}", flush=True)
                except (KeyError, TypeError, ValueError) as error:
                    print(f"Using the cluster fit: {error}", flush=True)
        if args.cameras is None and args.clusters is None:
            # Automatic views may miss parts of the scan. Keep some of the original
            # appearance in the fitted output to limit regressions on unseen views.
            log_size *= .8
            opacity = model[3] + .8*(opacity-model[3])
        if args.refine is not None:
            from refine_splats import blend_refinements, refine
            refined = refine(model, cameras, log_size, opacity, args.refine, width)
            if args.refine_wide:
                wide_width = min(1920, round(width*8/7))
                wide = refine(model, cameras, log_size, opacity, round(args.refine*1.5), wide_width, wide=True)
                refined = blend_refinements(refined, wide)
            if args.split_footprints:
                from split_footprints import split_footprints
                refined = split_footprints(model, *refined, cameras)
            if args.finish_footprints:
                from finish_footprints import finish_footprints
                refined = finish_footprints(model, *refined, cameras, wide_width)
            if args.fit_sort_order:
                from fit_sort_order import fit_sort_order
                refined = fit_sort_order(model, *refined, cameras, wide_width)
            if verification:
                from verify_fit import retain_refinement
                initial = model, log_size, opacity
                if not retain_refinement(model, initial, refined, *verification):
                    refined = initial
                    print("Keeping the fit that scored better on captured views", flush=True)
            model, log_size, opacity = refined
    write_ply(args.output, model, log_size, opacity, args.force)
    print(f"Wrote {len(opacity):,} standard Gaussians to {args.output}")


if __name__ == "__main__":
    main()

