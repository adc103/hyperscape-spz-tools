"""Check portable splat coverage from real captured viewpoints."""
import tempfile

import numpy as np

from export_bundle import capture_pose_cameras
from finish_footprints import camera_model
from fit_splats import compile_raster, prepare_reference
from fit_sort_order import distance_order
from refine_splats import refine_projection, render_refined


def source_images(lib, model, camera, size, visibility):
    width, height = size
    data, ids, focal = prepare_reference(model, camera, size)
    variants = [data]
    if visibility is not None:
        views, masks = visibility
        cluster = np.argmin(np.sum((views-camera[:3])**2, axis=1))
        bit = cluster*len(model[0])+ids
        variants.append(data[(masks[bit//8] & (1 << (bit % 8))) != 0])
    targets = []
    for rows in variants:
        target = np.zeros((height, width, 4), dtype="f4")
        target[:, :, 3] = 1
        lib.draw_native_quad(len(rows), rows, width, height, focal, target)
        if np.any(target[:, :, 3] < 1):
            targets.append(np.minimum(target[:, :, :3], 1))
    return targets


def validation_views(poses_file, cluster_cameras):
    poses = capture_pose_cameras(poses_file)
    recorded = poses[np.linspace(0, len(poses)-1, min(len(poses),12), dtype=int)]
    if cluster_cameras is None or not len(cluster_cameras):
        return recorded, len(recorded)
    rng = np.random.default_rng(92641)
    nearby = cluster_cameras[np.linspace(0,len(cluster_cameras)-1,min(len(cluster_cameras),8),dtype=int)].copy()
    nearby += rng.uniform(-1.,1.,nearby.shape)*[.12,.12,.08,19,12,7,4]
    nearby[:,5] = np.clip(nearby[:,5],20,130)
    return np.concatenate((recorded,nearby)), len(recorded)


def mean_groups(rows):
    return np.concatenate([np.mean(bucket,axis=0) for bucket in rows if bucket],axis=1)


def choose_strength(source, log_size, opacity, poses_file, visibility=None, cluster_cameras=None):
    cameras, split = validation_views(poses_file, cluster_cameras)
    source = camera_model(source)
    variants = (1., .8, 1.15)
    width, height = 448, 252
    errors = ([], [])
    with tempfile.TemporaryDirectory(prefix="hyperscape-verify-") as scratch:
        lib = compile_raster(scratch)
        for i, camera in enumerate(cameras):
            targets = source_images(lib, source, camera, (width,height), visibility)
            if not targets:
                continue
            data, ids, _ = refine_projection(source, camera, width, height)
            order = distance_order(source[0], ids, camera)
            params = np.zeros((len(ids),10),dtype="f4")
            original = source[3][ids]
            row = []
            for factor in variants:
                params[:, :3] = factor * log_size[ids, None]
                params[:, 3] = np.clip(original + factor*(opacity[ids]-original),0,1)
                scores = []
                for geometry, values in ((data, params),(data[order], params[order])):
                    out,_ = render_refined(lib, geometry, values, width, height)
                    rgb = np.minimum(out[:, :, :3],1)
                    scores.extend(np.mean((rgb-target)**2) for target in targets)
                row.append(scores)
            # Keep constant columns if a particular masked frame sees no geometry.
            if len(targets) == (1 if visibility is None else 2):
                errors[i >= split].append(row)
    if not any(errors):
        return 1.
    scores = mean_groups(errors)
    ratio = (scores+1e-12)/(scores[0]+1e-12)
    eligible = np.max(ratio, axis=1) <= 1.005
    index = np.argmin(np.where(eligible, np.mean(ratio, axis=1), np.inf))
    return variants[index] if np.mean(ratio[index]) < .998 else 1.


def patch_error(error):
    """Score the worst 5% of image patches rather than isolated pixels."""
    edge = 16
    h, w = error.shape
    ys, xs = np.arange(0,h,edge), np.arange(0,w,edge)
    sums = np.add.reduceat(np.add.reduceat(error,ys,axis=0),xs,axis=1)
    blocks = sums/(np.diff(np.r_[ys,h])[:,None]*np.diff(np.r_[xs,w]))
    flat = blocks.ravel()
    tail = max(1, int(np.ceil(.05*flat.size)))
    return np.partition(flat, -tail)[-tail:].mean()


def retain_refinement(source, initial, refined, poses_file, visibility, cluster_cameras=None):
    """Reject a refinement that regresses at recorded capture viewpoints."""
    cameras, split = validation_views(poses_file, cluster_cameras)
    teacher = camera_model(source)
    models = []
    for (xyz,sizes,rotation,_,dc,sh), logs, opacity in (initial, refined):
        models.append(camera_model((xyz,sizes+logs.reshape(len(xyz),-1),rotation,opacity,dc,sh)))
    width, height = 448, 252
    rows = ([], [])
    with tempfile.TemporaryDirectory(prefix="hyperscape-refinement-check-") as scratch:
        lib = compile_raster(scratch)
        for i, camera in enumerate(cameras):
            targets = source_images(lib,teacher,camera,(width,height),visibility)
            if len(targets) != (1 if visibility is None else 2):
                continue
            row = []
            for model in models:
                data,ids,_ = refine_projection(model,camera,width,height)
                order = distance_order(model[0],ids,camera)
                params = np.zeros((len(ids),10),dtype="f4")
                params[:,3] = model[3][ids]
                scores = []
                for geometry,values in ((data,params),(data[order],params[order])):
                    out,_ = render_refined(lib,geometry,values,width,height)
                    rgb = np.minimum(out[:,:,:3],1)
                    for target in targets:
                        error = np.mean((rgb-target)**2, axis=2)
                        scores.extend((error.mean(), patch_error(error)))
                row.append(scores)
            rows[i >= split].append(row)
    if not any(rows):
        return True
    before,after = mean_groups(rows)
    ratios = (after+1e-12)/(before+1e-12)
    whole, patches = ratios[::2], ratios[1::2]
    for label, group in (("Frame", whole), ("Patch", patches)):
        print(f"{label} refinement error ratios:", " ".join(f"{ratio:.3f}" for ratio in group), flush=True)
    return bool(np.max(whole) <= 1.03 and np.mean(whole) <= 1.0 and np.max(patches) <= 1.03)
