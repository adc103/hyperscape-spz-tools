"""Refine scale and opacity of the final splats against source renders."""
from pathlib import Path
import tempfile

import numpy as np
from scipy.spatial.transform import Rotation

from fit_splats import compile_raster, render_reference
from refine_splats import refine_projection, render_refined, wide_cameras


def camera_model(model):
    positions, scales, quaternions, alpha, dc, sh = model
    rotations = Rotation.from_quat(quaternions).as_matrix().astype("f4")
    return positions, scales, rotations, alpha, dc, sh


def finish_footprints(source, fitted, log_size, opacity, cameras, width):
    """Retain centers and color while correcting how the final splats blend."""
    positions, scales, quaternions, _, dc, sh = fitted
    student = camera_model((positions, scales+log_size.reshape(len(opacity), -1),
                            quaternions, opacity, dc, sh))
    teacher = camera_model(source)
    cameras = wide_cameras(cameras)
    prior = np.zeros((len(opacity), 4), dtype="f4")
    prior[:, 3] = opacity
    current = prior.copy()
    first = np.zeros_like(current)
    second = np.zeros_like(current)
    observations = np.zeros(len(opacity), dtype="i4")
    regularization = np.array([.018, .018, .018, .017], dtype="f4")
    bounds = np.array([.32, .32, .32, .29], dtype="f4")
    steps = 320

    with tempfile.TemporaryDirectory(prefix="hyperscape-finish-") as scratch:
        lib = compile_raster(scratch)
        paths = []
        for i, camera in enumerate(cameras):
            frame_width = max(128, round(width*13/16)) if i % 2 else width
            frame_height = round(frame_width*9/16)
            data, ids, _ = refine_projection(student, camera, frame_width, frame_height)
            if not len(ids):
                continue
            target = render_reference(lib, teacher, camera, (frame_width, frame_height))
            if np.any(target[:, :, :3]):
                path = Path(scratch)/f"{i}.npz"
                np.savez(path, data=data, ids=ids, target=target)
                paths.append(path)
        if not paths:
            return fitted, log_size, opacity

        rng = np.random.default_rng(218)
        for step in range(steps):
            if step % len(paths) == 0:
                order = rng.permutation(len(paths))
            with np.load(paths[order[step % len(paths)]]) as view:
                data, ids, target = view["data"], view["ids"], view["target"]
            frame_height, frame_width = target.shape[:2]
            params = np.zeros((len(ids), 10), dtype="f4")
            params[:, :4] = current[ids]
            _, gradient = render_refined(lib, data, params, frame_width, frame_height, target)
            values = params[:, :4]
            delta = gradient[:, :4]+regularization*(values-prior[ids])
            observations[ids] += 1
            age = observations[ids, None]
            first[ids] = mean = .9*first[ids]+.1*delta
            second[ids] = variance = .99*second[ids]+.01*delta*delta
            rate = .012*(1-.65*step/steps)
            values -= rate*(mean/(1-.9**age))/(np.sqrt(variance/(1-.99**age))+1e-6)
            values = np.clip(values, prior[ids]-bounds, prior[ids]+bounds)
            values[:, 3] = np.clip(values[:, 3], 0, 1)
            current[ids] = values
            if (step+1) % 64 == 0:
                print(f"Final footprint fit {step+1}/{steps}", flush=True)
    return fitted, log_size.reshape(len(opacity), -1)+current[:, :3], current[:, 3]
