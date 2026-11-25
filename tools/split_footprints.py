"""Approximate large, flat quadratic footprints with compact Gaussian groups."""
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

from fit_splats import prepare_projection, prepare_reference


OFFSETS = np.array([(x, y) for x in (-1, 0, 1) for y in (-1, 0, 1)])
OFFSET_KIND = np.count_nonzero(OFFSETS, axis=1)


def fit_kernel():
    """Fit an isolated quadratic kernel for a range of center opacities."""
    grid = np.linspace(-4, 4, 65)
    x, y = np.meshgrid(grid, grid)
    parameters = []
    for opacity in np.linspace(.05, 1, 20):
        target = opacity*np.maximum(0, 1-(x*x+y*y)/9)

        def residual(values):
            offset, size = values[:2]
            distance = (x[:, :, None]-offset*OFFSETS[:, 0])**2 + (y[:, :, None]-offset*OFFSETS[:, 1])**2
            coverage = values[2+OFFSET_KIND]*np.exp(-distance/(2*size**2))
            return (1-np.prod(1-coverage, axis=2)-target).ravel()

        seed = [1.4, .8, opacity*.8, opacity*.5, opacity*.15]
        bounds = ([.5, .4, 0, 0, 0], [3, 2, .999, .999, .999])
        parameters.append(least_squares(residual, seed, bounds=bounds).x)
    return np.asarray(parameters)


def project(model, camera, width, height):
    center, jx, jy, _, ids, _ = prepare_projection(model, camera, width, height)
    projection = np.zeros((len(model[0]), 8), dtype="f4")
    projection[ids] = np.column_stack((center, jx, jy))
    visible = np.zeros(len(projection), dtype=bool)
    visible[ids] = True
    return projection, visible


def gaussian_alpha(projected, opacity, x, y):
    jx, jy = projected[:, 2:5], projected[:, 5:8]
    xx = np.sum(jx**2, axis=1)+.3
    xy = np.sum(jx*jy, axis=1)
    yy = np.sum(jy**2, axis=1)+.3
    dx = x-projected[:, 0, None]
    dy = y-projected[:, 1, None]
    distance = (yy[:, None]*dx**2+xx[:, None]*dy**2-2*xy[:, None]*dx*dy)/(xx*yy-xy*xy)[:, None]
    alpha = opacity[:, None]*np.exp(-.5*distance)
    return np.where((distance <= 9) & (alpha >= 1/255), alpha, 0)


def quadratic_alpha(packed, x, y, focal, width, height):
    rays = np.stack(((x+.5-width*.5)/focal, (y+.5-height*.5)/focal, np.ones_like(x)), axis=1)
    u, v, z = np.moveaxis(packed[:, 8:17].reshape(-1, 3, 3) @ rays, 1, 0)
    uv = (u*u+v*v)/np.maximum(z*z, 1e-9)
    alpha = packed[:, 4, None]*(1-uv/(1+packed[:, 18, None]*uv)/9)
    extent = packed[:, 17, None]*z
    visible = (z > 0) & (abs(u) <= extent) & (abs(v) <= extent)
    return np.where(visible & (alpha >= 1/255), alpha, 0)


def select_groups(teacher, centers, children, cameras):
    """Compare each isolated footprint across views before making any change."""
    count = len(centers[0])
    error = np.zeros((2, count))
    samples = np.linspace(-1, 1, 21)
    dx, dy = (grid.ravel() for grid in np.meshgrid(samples, samples))
    width, height = 448, 252
    # Batch sample grids to bound peak memory on scans with many flat splats.
    for camera in cameras:
        native, native_ids, focal = prepare_reference(teacher, camera, (width, height))
        packed = np.zeros((count, native.shape[1]), dtype="f4")
        packed[native_ids] = native
        center, on_screen = project(centers, camera, width, height)
        projected, visible_children = project(children, camera, width, height)
        idx = np.flatnonzero(on_screen)
        for first in range(0, len(idx), 128):
            ids = idx[first:first+128]
            data = center[ids]
            extents = 3*np.sqrt(.3+np.column_stack((np.sum(data[:, 2:5]**2, axis=1),
                                                   np.sum(data[:, 5:8]**2, axis=1))))
            low = np.maximum(data[:, :2]-extents, [0, 0])
            high = np.minimum(data[:, :2]+extents, [width-1, height-1])
            span = np.maximum(high-low, 0)
            mid = (high+low)*.5
            x = mid[:, 0, None]+span[:, 0, None]*.5*dx
            y = mid[:, 1, None]+span[:, 1, None]*.5*dy
            reference = quadratic_alpha(packed[ids], x, y, focal, width, height)
            single = gaussian_alpha(data, centers[3][ids], x, y)
            group = (ids[:, None]*9+np.arange(9)).ravel()
            alpha = children[3][group]*visible_children[group]
            tiles = gaussian_alpha(projected[group], alpha, np.repeat(x, 9, axis=0), np.repeat(y, 9, axis=0))
            mixture = 1-np.prod(1-tiles.reshape(len(ids), 9, -1), axis=1)
            weight = np.sqrt(np.prod(span, axis=1))
            error[0, ids] += weight*np.mean((reference-single)**2, axis=1)
            error[1, ids] += weight*np.mean((reference-mixture)**2, axis=1)
    return error[1]+1e-6 < .75*(error[0]+1e-6)


def split_footprints(source, fitted, log_size, opacity, cameras):
    points, scales, quats, _, dc, sh = fitted
    scales = scales+log_size.reshape(len(opacity), -1)
    sizes = np.exp(scales)
    order = np.argsort(sizes, axis=1)
    thin, mid, wide = np.take_along_axis(sizes, order, axis=1).T
    ids = np.flatnonzero((thin < .04*mid) & (mid > .11) & (wide > .18) & (opacity > .25))
    if not len(ids):
        return fitted, log_size, opacity

    rotations = Rotation.from_quat(quats[ids]).as_matrix().astype("f4")
    fitted_centers = points[ids], scales[ids], rotations, opacity[ids], dc[ids], sh[ids]
    native_centers = source[0][ids], source[1][ids], rotations, source[3][ids], source[4][ids], source[5][ids]
    lookup = np.clip(np.rint((opacity[ids]-.05)/.05).astype("i4"), 0, 19)
    kernel = fit_kernel()[lookup]
    # Account for the wider scale of the fitted Gaussian relative to the quadratic.
    offset = np.repeat(kernel[:, 0]/1.30, 9)
    shrink = np.repeat(np.log(kernel[:, 1]/1.30), 9)
    parents = np.repeat(ids, 9)
    local_rows = np.arange(len(parents))[:, None]
    axes = order[parents, 1:]
    translation = np.zeros((len(parents), 3), dtype="f4")
    translation[local_rows, axes] = np.tile(OFFSETS, (len(ids), 1))*offset[:, None]*sizes[parents[:, None], axes]
    child_rotations = np.repeat(rotations, 9, axis=0)
    child_points = points[parents]+np.einsum("nij,nj->ni", child_rotations, translation)
    child_scales = scales[parents].copy()
    child_scales[local_rows, axes] += shrink[:, None]
    child_alpha = kernel[:, 2+OFFSET_KIND].ravel().astype("f4")
    children = child_points, child_scales, child_rotations, child_alpha, dc[parents], sh[parents]

    split = select_groups(native_centers, fitted_centers, children, cameras)
    if not np.any(split):
        return fitted, log_size, opacity
    keep = np.ones(len(points), dtype=bool)
    keep[ids[split]] = False
    use_child = np.repeat(split, 9)
    output_points = np.concatenate((points[keep], child_points[use_child]))
    output_scales = np.concatenate((scales[keep], child_scales[use_child]))
    selection = np.r_[np.flatnonzero(keep), parents[use_child]]
    alpha = np.r_[opacity[keep], child_alpha[use_child]]
    result = output_points, output_scales, quats[selection], alpha, dc[selection], sh[selection]
    print(f"Replaced {split.sum():,} broad footprints with compact groups", flush=True)
    return result, np.zeros_like(alpha), alpha
