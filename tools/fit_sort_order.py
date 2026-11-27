"""Reduce the visual changes caused by choosing a different splat draw order."""
import tempfile

import numpy as np

from view_cache import ViewCache

from convert_spz import C0, basis
from finish_footprints import camera_model
from fit_splats import cached_reference, compile_raster
from refine_splats import refine_projection, render_refined, wide_cameras


def distance_order(points, ids, camera):
    distance = np.sum((points[ids]-camera[:3])**2, axis=1)
    return np.argsort(distance, kind="stable")


def render_orders(lib, data, params, order, width, height):
    first, _ = render_refined(lib, data, params, width, height)
    second, _ = render_refined(lib, data[order], params[order], width, height)
    return np.clip(first[:, :, :3], 0, 1), np.clip(second[:, :, :3], 0, 1)


def measure_sort_effect(lib, teacher, student, cameras, width):
    """Rank changes to opacity on pixels explained better by distance order."""
    score = np.zeros(len(student[0]))
    height = round(width*9/16)
    for camera in cameras:
        data, ids, _ = refine_projection(student, camera, width, height)
        if not len(ids):
            continue
        order = distance_order(student[0], ids, camera)
        params = np.zeros((len(ids), 10), dtype="f4")
        params[:, 3] = student[3][ids]
        depth, radial = render_orders(lib, data, params, order, width, height)
        target = cached_reference(lib, teacher, camera, (width, height))
        reference = target[:, :, :3]
        advantage = np.sum((depth-reference)**2-(radial-reference)**2, axis=2)
        weight = np.clip(advantage/.012, 0, 1)[:, :, None]
        target[:, :, :3] = depth+weight*(radial-depth)
        _, near = render_refined(lib, data, params, width, height, target)
        target[:, :, :3] = radial+weight*(depth-radial)
        _, far = render_refined(lib, data[order], params[order], width, height, target)
        importance = abs(near[:, 3])+np.bincount(order, weights=abs(far[:, 3]), minlength=len(ids))
        score[ids] += importance*params[:, 3]
    active = np.flatnonzero(score > 0)
    return active[np.argsort(score[active], kind="stable")[-7000:]]


def sort_gradient(lib, data, params, order, target):
    height, width = target.shape[:2]
    depth, radial = render_orders(lib, data, params, order, width, height)
    difference = np.max(abs(depth-radial), axis=2, keepdims=True)
    weight = .20+.80*np.clip(difference/.075, 0, 1)
    pseudo = target.copy()
    pseudo[:, :, :3] = depth+(target[:, :, :3]-depth)*weight
    _, near = render_refined(lib, data, params, width, height, pseudo)
    pseudo[:, :, :3] = radial+(target[:, :, :3]-radial)*weight
    _, far = render_refined(lib, data[order], params[order], width, height, pseudo)
    gradient = .72*near
    gradient[order] += .28*far
    return gradient


def optimize(lib, cache, count, points, opacity, selected, terms):
    lut = np.full(len(opacity), -1, dtype="i4")
    lut[selected] = np.arange(len(selected))
    params = np.zeros((len(selected), 4), dtype="f4")
    params[:, 3] = opacity[selected]
    prior = params.copy()
    color = np.zeros((len(selected), 3, terms), dtype="f4")
    mean, variance = np.zeros_like(params), np.zeros_like(params)
    rgb_mean, rgb_variance = np.zeros_like(color), np.zeros_like(color)
    age = np.zeros(len(selected), dtype="i4")
    rng = np.random.default_rng(11030)
    steps = 320
    for step in range(steps):
        if step % count == 0:
            sequence = rng.permutation(count)
        index = sequence[step % count]
        item = cache.load(index)
        data, ids, targets, order, eye = (item[key] for key in ("data", "ids", "target", "order", "eye"))
        active = lut[ids] >= 0
        rows = lut[ids[active]]
        if not len(rows):
            continue
        dirs = points[ids[active]]-eye
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        functions = np.ones((len(rows), terms), dtype="f4")
        functions[:, 1:] = basis(dirs)[:, :terms-1]
        view = np.zeros((len(ids), 10), dtype="f4")
        view[:, 3] = opacity[ids]
        view[active, :4] = params[rows]
        view[active, 7:] = np.einsum("nct,nt->nc", color[rows], functions)
        gradient = sort_gradient(lib, data, view, order, targets)[active]

        age[rows] += 1
        n = age[rows, None]
        first, second = 1-.9**n, 1-.99**n
        rate = .010*(1-.55*step/steps)
        update = gradient[:, :4]+.07*(params[rows]-prior[rows])
        mean[rows] = m = .9*mean[rows]+.1*update
        variance[rows] = v = .99*variance[rows]+.01*update**2
        adjusted = params[rows]-rate*(m/first)/(np.sqrt(v/second)+1e-6)
        adjusted = np.clip(adjusted, prior[rows]-.20, prior[rows]+.20)
        adjusted[:, 3] = np.clip(adjusted[:, 3], 0, 1)
        params[rows] = adjusted

        update = gradient[:, 7:, None]*functions[:, None, :]+.042*color[rows]
        rgb_mean[rows] = m = .9*rgb_mean[rows]+.1*update
        rgb_variance[rows] = v = .99*rgb_variance[rows]+.01*update**2
        adjusted = color[rows]-.32*rate*(m/first[:, :, None])/(np.sqrt(v/second[:, :, None])+1e-6)
        color[rows] = np.clip(adjusted, -.10, .10)
        if (step+1) % 64 == 0:
            print(f"Sort-order fit {step+1}/{steps}", flush=True)
    return params, color


def fit_sort_order(source, fitted, log_size, opacity, cameras, width):
    points, scales, quats, _, dc, sh = fitted
    logs = log_size.reshape(len(opacity), -1)
    student = camera_model((points, scales+logs, quats, opacity, dc, sh))
    teacher = camera_model(source)
    cameras = wide_cameras(cameras)
    with tempfile.TemporaryDirectory(prefix="hyperscape-sort-fit-") as scratch:
        lib = compile_raster(scratch)
        selected = measure_sort_effect(lib, teacher, student, cameras[::2], min(width, 416))
        if not len(selected):
            return fitted, log_size, opacity
        print(f"Refitting {len(selected):,} order-sensitive splats", flush=True)
        def prepare_view(index):
            camera = cameras[index]
            frame_width = max(128, round(width*13/16)) if index % 2 else width
            size = frame_width, round(frame_width*9/16)
            data, ids, _ = refine_projection(student, camera, *size)
            order = distance_order(points, ids, camera)
            target = cached_reference(lib, teacher, camera, size)
            return dict(data=data, ids=ids, order=order, target=target, eye=camera[:3])

        cache = ViewCache(scratch, prepare_view)
        # This stage has no per-view initialization. Render views only when
        # the optimizer actually visits them.
        params, color = optimize(lib, cache, len(cameras), points, opacity, selected, sh.shape[2]+1)


    # Use half the update to preserve quality with either compositor.
    result_size = np.broadcast_to(logs, scales.shape).copy()
    result_size[selected] += .5*params[:, :3]
    result_opacity = opacity.copy()
    result_opacity[selected] = .5*(opacity[selected]+params[:, 3])
    result_dc, result_sh = dc.copy(), sh.copy()
    result_dc[selected] += .5*color[:, :, 0]/C0
    result_sh[selected] += .5*color[:, :, 1:]
    return (points, scales, quats, opacity, result_dc, result_sh), result_size, result_opacity
