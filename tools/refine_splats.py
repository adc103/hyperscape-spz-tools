"""Refit a portable 3DGS model to RayQuadratic images from multiple viewpoints."""
import tempfile

import numpy as np

from view_cache import ViewCache
from scipy.spatial.transform import Rotation

from convert_spz import C0
from fit_splats import cached_reference, compile_raster, depth_fade, mip_filter, prefetch_references, prepare_projection


# Pull toward the starting fit. Larger values generalize to unseen views more cautiously.
REGULARIZATION = 1.0


def refine_projection(model, camera, width, height):
    screen, jx, jy, color, ids, harmonics = prepare_projection(model, camera, width, height)
    packed = np.ascontiguousarray(np.column_stack((screen, jx, jy, color)), dtype="f4")
    return packed, ids, np.ascontiguousarray(harmonics[:, :3], dtype="f4")


def render_refined(lib, data, params, width, height, target=None):
    """Render or differentiate through the reference standard Gaussian renderer."""
    out = np.zeros((height, width, 4), dtype="f4")
    out[:, :, 3] = 1
    gradient = np.empty_like(params) if target is not None else np.empty(0, dtype="f4")
    lib.raster_refine(len(data), data, width, height, params,
                      None if target is None else target.ctypes.data,
                      out, gradient, .3, 1/255, 9., .15)
    return out, gradient



def wide_cameras(cameras):
    rng = np.random.default_rng(539)
    extra = cameras.copy()
    extra[:, :3] += rng.uniform([-.20, -.20, -.17], [.20, .20, .17], (len(cameras), 3))
    extra[:, 3:5] += rng.uniform([-50., -13.], [50., 13.], (len(cameras), 2))
    extra[:, 5] = rng.uniform(68, 105, len(cameras))
    return np.concatenate((cameras, extra))


def reference_opacity(model, camera, ids, width):
    """Estimate native opacity with the same Mip filter and depth fade."""
    positions, scales, rotations, opacity, _, _ = model
    direction = positions[ids]-camera[:3]
    local = np.einsum("nji,nj->ni", rotations[ids], direction)
    scale = np.exp(scales[ids])
    focal = width/(2*np.tan(np.deg2rad(camera[5])*.5))
    _, _, _, corrected = mip_filter(opacity[ids], local, scale, focal)
    yaw, pitch = np.deg2rad(camera[3:5])
    forward = np.array([np.cos(pitch)*np.cos(yaw), np.cos(pitch)*np.sin(yaw), np.sin(pitch)])
    depth = direction @ forward
    corrected = depth_fade(corrected, depth)
    return np.where(corrected >= .0625, corrected, 0)


def blend_refinements(first, second):
    model1, scale1, alpha1 = first
    model2, scale2, alpha2 = second
    positions, scales, rotations, alpha, dc, sh = model1
    # Average in scene coordinates, log scale, and linear opacity.
    blended = ((positions+model2[0])*.5, scales, rotations, alpha,
               (dc+model2[4])*.5, (sh+model2[5])*.5)
    return blended, (scale1+scale2)*.5, (alpha1+alpha2)*.5

def refine(model, cameras, log_size, opacity, steps, width, wide=False):
    points, scales, quats, alpha, dc, sh = model
    rotations = Rotation.from_quat(quats).as_matrix().astype("f4")
    reference = points, scales, rotations, alpha, dc, sh
    params = np.zeros((len(alpha), 7), dtype="f4")
    params[:, :3] = log_size.reshape(len(alpha), -1)
    params[:, 3] = opacity
    if wide:
        cameras = wide_cameras(cameras)
        exposure = np.zeros_like(alpha)
        opacity_sum = np.zeros_like(alpha)
    terms = 1 + min(3, sh.shape[2])
    color = np.zeros((len(alpha), 3, terms), dtype="f4")
    first_moment, second_moment = np.zeros_like(params), np.zeros_like(params)
    color_first, color_second = np.zeros_like(color), np.zeros_like(color)
    observations = np.zeros(len(alpha), dtype="i4")
    regularization = REGULARIZATION*np.array([.003]*3 + [.002] + [.018]*3, dtype="f4")
    color_regularization = REGULARIZATION*np.array([.018, .038, .038, .038])[:terms]
    lower = [-1.25]*3 + [0] + [-.55]*3
    upper = [.85]*3 + [1] + [.55]*3

    with tempfile.TemporaryDirectory(prefix="hyperscape-refine-") as scratch:
        lib = compile_raster(scratch)
        sizes = [max(128, round(width*5/8)) if wide and i % 2 else width for i in range(len(cameras))]
        prefetch_references(reference, [(camera, (w, round(w*9/16))) for camera, w in zip(cameras, sizes)])
        def prepare_view(index):
            camera = cameras[index]
            frame_width = max(128, round(width*5/8)) if wide and index % 2 else width
            frame_height = round(frame_width*9/16)
            data, ids, harmonics = refine_projection(reference, camera, frame_width, frame_height)
            target = cached_reference(lib, reference, camera, (frame_width, frame_height)) if len(ids) else None
            return dict(data=data, ids=ids, harmonics=harmonics, target=target)

        cache = ViewCache(scratch, prepare_view)
        view_indices = []
        for i, camera in enumerate(cameras):
            view = prepare_view(i)
            data, ids, target = view["data"], view["ids"], view["target"]
            if target is None:
                continue
            if wide:
                frame_height, frame_width = target.shape[:2]
                x, y = data[:, :2].T
                on_screen = (x >= 0) & (x < frame_width) & (y >= 0) & (y < frame_height)
                visible_ids = ids[on_screen]
                exposure[visible_ids] += 1
                opacity_sum[visible_ids] += reference_opacity(reference, camera, visible_ids, frame_width)
            if np.any(target[:, :, :3]):
                cache.store(i, view)
                view_indices.append(i)
        if not view_indices:
            raise ValueError("The selected cameras did not see the scan")
        if wide:
            seen = exposure > 0
            native_alpha = np.clip(1.18*opacity_sum[seen]/exposure[seen], 0, 1)
            params[seen, 3] = .30*params[seen, 3]+.70*native_alpha
            params[seen, :3] = np.clip(params[seen, :3]+.10, -1.25, .85)
        prior = params.copy()
        print(f"Refining {len(view_indices)} camera views", flush=True)
        rng = np.random.default_rng(716)
        for step in range(steps):
            if step % len(view_indices) == 0:
                order = rng.permutation(view_indices)
            view = cache.load(order[step % len(view_indices)])
            ids, data, target = view["ids"], view["data"], view["target"]
            functions = np.ones((len(ids), terms), dtype="f4")
            functions[:, 1:] = view["harmonics"]
            current = np.empty((len(ids), 10), dtype="f4")
            current[:, :7] = params[ids]
            current[:, 7:] = np.einsum("nct,nt->nc", color[ids], functions)
            frame_height, frame_width = target.shape[:2]
            _, gradient = render_refined(lib, data, current, frame_width, frame_height, target)
            observations[ids] += 1
            age = observations[ids, None]
            first_bias, second_bias = 1-.9**age, 1-.99**age
            rate = .022*(1-.7*step/steps)

            trainable = current[:, :7]
            delta = gradient[:, :7] + regularization*(trainable-prior[ids])
            first_moment[ids] = mean = .9*first_moment[ids] + .1*delta
            second_moment[ids] = variance = .99*second_moment[ids] + .01*delta**2
            trainable -= rate*(mean/first_bias)/(np.sqrt(variance/second_bias)+1e-6)
            params[ids] = np.clip(trainable, lower, upper)

            rgb = color[ids]
            delta = gradient[:, 7:, None]*functions[:, None, :] + rgb*color_regularization
            color_first[ids] = mean = .9*color_first[ids] + .1*delta
            color_second[ids] = variance = .99*color_second[ids] + .01*delta**2
            rgb -= .25*rate*(mean/first_bias[:, :, None])/(np.sqrt(variance/second_bias[:, :, None])+1e-6)
            color[ids] = np.clip(rgb, -.16, .16)
            if (step+1) % 64 == 0 or step+1 == steps:
                print(f"Refine step {step+1}/{steps}", flush=True)

    # Offsets use local splat axes and units to bound the movement of fine detail.
    fitted_points = points + np.einsum("nij,nj->ni", rotations, np.exp(scales)*params[:, 4:7])
    fitted_dc = dc + color[:, :, 0]/C0
    fitted_sh = sh.copy()
    fitted_sh[:, :, :terms-1] += color[:, :, 1:]
    return (fitted_points, scales, quats, alpha, fitted_dc, fitted_sh), params[:, :3], params[:, 3]
