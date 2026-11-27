"""Fit standard splats to RayQuadratic views using a CPU rasterizer."""
import ctypes as ct
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

import numpy as np

from view_cache import ViewCache
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

from convert_spz import C0, basis

FLOAT = np.ctypeslib.ndpointer(np.float32, flags="C_CONTIGUOUS")
INT = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")


def compile_raster(directory):
    source = Path(__file__).with_name("splat_fit.cpp")
    binary = Path(directory) / "splat_fit.so"
    compiler = shlex.split(os.environ.get("CXX", "c++"))
    subprocess.run([*compiler, "-std=c++17", "-O3", "-shared", "-fPIC", str(source), "-o", str(binary)], check=True)
    lib = ct.CDLL(str(binary))
    lib.draw_native_quad.argtypes = [ct.c_int, FLOAT, ct.c_int, ct.c_int, ct.c_float, FLOAT]
    lib.draw_native_quad.restype = None
    lib.raster_fit.argtypes = [ct.c_int, FLOAT, INT, ct.c_int, ct.c_int, FLOAT, FLOAT, ct.c_void_p, FLOAT, FLOAT, FLOAT]
    lib.raster_fit.restype = None
    lib.raster_refine.argtypes = [
        ct.c_int, FLOAT, ct.c_int, ct.c_int, FLOAT, ct.c_void_p, FLOAT, FLOAT,
        ct.c_float, ct.c_float, ct.c_float, ct.c_float,
    ]
    lib.raster_refine.restype = None
    return lib


def validate_cameras(cameras):
    values = np.asarray(cameras, dtype="f8")
    if values.ndim != 2 or values.shape[1] != 7 or not 1 <= len(values) <= 64:
        raise ValueError("Expected 1–64 camera poses with seven values each")
    if not np.isfinite(values).all() or np.any((values[:, 5] < 20) | (values[:, 5] > 130)):
        raise ValueError("Camera values must be finite and horizontal FOV must be 20–130 degrees")
    return values


def cluster_cameras(path, splat_count, headings=4, target_views=512, jitter=.3, pitch=(-30, 12)):
    """Build fitting views around the app's visibility cluster centroids.

    The app writes one centroid per visibility cluster at standing eye height. Each one
    gets `headings` evenly spaced views. The views are repeated until there are about
    `target_views`, and each copy moves the eye up to `jitter` meters and varies the
    pitch, so the fit holds up wherever the viewer stands and looks.
    """
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict) or data.get("splat_count") != splat_count:
        raise ValueError("The cluster file does not match this scan's splat count")
    views = np.asarray(data.get("views"), dtype="f8")
    if views.ndim != 2 or views.shape[1] != 3 or not len(views) or not np.isfinite(views).all():
        raise ValueError("Expected cluster centroids as [x, y, z] rows")
    offset = np.random.default_rng(5).uniform(0, 360, len(views))
    cameras = np.zeros((len(views), headings, 7))
    cameras[..., :3] = views[:, None]
    cameras[..., 3] = (offset[:, None]+np.arange(headings)*360/headings) % 360
    cameras[..., 4] = -5
    cameras[..., 5] = 88
    cameras = cameras.reshape(-1, 7)
    copies = max(1, round(target_views/len(cameras)))
    if not jitter:
        return cameras
    rng = np.random.default_rng(11)
    cameras = np.repeat(cameras, copies, axis=0)
    cameras[:, :2] += rng.uniform(-jitter, jitter, (len(cameras), 2))
    cameras[:, 2] += rng.uniform(-jitter/3, jitter/3, len(cameras))
    cameras[:, 3] = (cameras[:, 3]+rng.uniform(-45/copies, 45/copies, len(cameras))) % 360
    cameras[:, 4] = rng.uniform(*pitch, len(cameras))
    return cameras


def auto_cameras(model):
    points, _, _, opacity, _, _ = model
    points = points[opacity >= .18]
    if len(points) < 20:
        raise ValueError("Too little scan coverage to choose cameras. Supply --cameras or use --attributes-only.")
    step = .25
    low, high = np.quantile(points[:, 2], [.01, .55])
    band_size = max(.06, (high-low)/512)
    bands = np.arange(low, max(low+band_size, high), band_size)
    # Count XY coverage, so a densely splatted tabletop cannot win by point count alone.
    floor_sample = points[::max(1, len(points)//100000)]
    gx, gy = np.floor(floor_sample[:, :2]/step).astype("i8").T
    gz = np.floor((floor_sample[:, 2]-low)/band_size).astype("i8")
    valid = (gz >= 0) & (gz < len(bands))
    counts = np.bincount(np.unique(np.column_stack((gz[valid],gx[valid],gy[valid])),axis=0)[:,0],
                         minlength=len(bands))
    if counts.max() == 0:
        raise ValueError("Could not find a floor. Supply --cameras or use --attributes-only.")
    floor = bands[int(np.argmax(counts))] + band_size/2
    floor_points = points[np.abs(points[:,2]-floor) < .12, :2]
    cells, coverage = np.unique(np.floor(floor_points/step).astype("i8"), axis=0, return_counts=True)
    candidates = (cells[coverage>=3]+.5)*step
    solid = points[(points[:,2]>floor+.85)&(points[:,2]<floor+1.85), :2]
    if len(solid) and len(candidates):
        occupied, samples = np.unique(np.floor(solid/step).astype("i8"),axis=0,return_counts=True)
        occupied = (occupied[samples>=6]+.5)*step
        if len(occupied):
            clearance = cKDTree(occupied).query(candidates)[0]
            clear = candidates[clearance>=.35]
            if len(clear):
                candidates = clear
    if not len(candidates):
        raise ValueError("Could not place cameras on the inferred floor. Supply --cameras or use --attributes-only.")
    # Prefer measured interior coverage and spread camera positions across it.
    support_points = (cells+.5)*step
    vicinity = cKDTree(support_points).query_ball_point(candidates, 1.25)
    density = np.array([np.sqrt(coverage[neighbors]).sum() for neighbors in vicinity])
    score = density / density.max()
    return np.asarray(sample_cameras(candidates, floor, score))


def sample_cameras(candidates, floor, score):
    cameras, extra = [], []
    # A core sweep establishes detail. A second sweep adds angle, height and
    # lens variation and gives lower-density floor areas more weight.
    for wide in (False, True):
        rng = np.random.default_rng(54)
        priority = np.sqrt(score) if wide else score
        first = int(np.argmax(priority))
        nearest = np.full(len(candidates), np.inf)
        for i in range(min(16 if wide else 10, len(candidates))):
            x, y = candidates[first]
            heading = rng.uniform(0, 90) if wide else rng.uniform(-24, 24)
            for direction, angle in enumerate((0, 90, 180, 270)):
                if wide:
                    height = rng.uniform(1.3, 1.78)
                    pitch = rng.uniform(-17, 1)
                    fov = rng.uniform(74, 100)
                    if direction != i % 4 and (i >= 8 or direction != (i + 2) % 4):
                        continue
                else:
                    height, pitch, fov = rng.uniform(1.45, 1.75), -7, 88
                camera = [x, y, floor + height, heading + angle, pitch, fov, 0]
                if wide and direction != i % 4:
                    extra.append(camera)
                else:
                    cameras.append(camera)
            nearest = np.minimum(nearest, np.sum((candidates - candidates[first])**2, axis=1))
            first = int(np.argmax(np.minimum(nearest, 2.0**2) * priority))
    return cameras + extra



def mip_filter(alpha, center, scale, focal):
    bias = .1*np.sum(center**2, axis=1)/focal**2
    filtered = np.sqrt(scale**2+bias[:, None])
    whitened = center/filtered
    magnitude = np.linalg.norm(whitened, axis=1)
    projected_area = np.linalg.norm(center*scale[:, [1, 2, 0]]*scale[:, [2, 0, 1]], axis=1)
    compensated = alpha*projected_area/(np.prod(filtered, axis=1)*magnitude)
    return filtered, whitened, magnitude, compensated


def depth_fade(opacity, depth):
    fade = (depth > 5) & (opacity < .2)
    return opacity*(1-np.where(fade, np.clip((depth-5)/4, 0, 1), 0))


def prepare_reference(model, cam, size):
    positions, scales, rotations, alpha, dc, sh = model
    w,h=size
    eye=cam[:3]
    yaw,pitch,roll=np.deg2rad(cam[[3,4,6]])
    forward=np.array([np.cos(pitch)*np.cos(yaw),np.cos(pitch)*np.sin(yaw),np.sin(pitch)])
    right=np.array([np.sin(yaw),-np.cos(yaw),0.])
    down=np.cross(forward,right)
    axes=np.stack((np.cos(roll)*right+np.sin(roll)*down,
                   np.cos(roll)*down-np.sin(roll)*right,forward),axis=1)
    direction=positions-eye
    p=direction@axes
    loc=np.flatnonzero((p[:,2]>.12)&(p[:,2]<80)&(np.abs(p[:,0])<p[:,2]*1.6)&(np.abs(p[:,1])<p[:,2]))
    loc=loc[np.argsort(np.linalg.norm(p[loc],axis=1),kind="stable")]
    center=p[loc]
    rotation=axes.T@rotations[loc]
    scale=np.exp(scales[loc])
    focal=w/(2*np.tan(np.deg2rad(cam[5])/2))
    original_whitened_center=np.einsum('nji,nj->ni',rotation,center)
    filtered,whitened,magnitude,compensated=mip_filter(alpha[loc],original_whitened_center,scale,focal)

    # Build the tangent basis in the same whitened space as precomputeRayGS.
    normal=whitened/magnitude[:,None]
    sign=np.where(normal[:,2]>0,1.,-1.)
    householder=normal.copy()
    householder[:,2]+=sign
    basis_vectors=2*householder[:,:,None]*householder[:,None,:2]/np.sum(householder**2,axis=1)[:,None,None]
    basis_vectors[:,:2,:]-=np.eye(2)
    basis_vectors[:,:,0]*=sign[:,None]
    tangent=(rotation*filtered[:,None,:])@basis_vectors
    _,axes2=np.linalg.eigh(tangent.transpose(0,2,1)@tangent)
    tangent=tangent@axes2

    # The shader stores T and the whitened center length in FP16.
    T=np.concatenate((tangent,center[:,:,None]),axis=-1).astype('f2').astype('f8')
    c=np.minimum(magnitude,65504).astype('f2').astype('f8')
    c_sq=c*c
    # The vertex stage builds the quad before applying the alpha fade.
    half_opacity=compensated.astype('f2').astype('f8')
    k=9-2*(4.5/255)/np.maximum(half_opacity,1e-10)
    valid=(half_opacity>=.0625)&(k>0)&(c_sq>k)
    loc,center,T,c_sq,k,half_opacity=(arr[valid] for arr in (loc,center,T,c_sq,k,half_opacity))
    opacity=depth_fade(half_opacity,center[:,2])
    valid=(opacity>=.0625)&(np.linalg.det(T)!=0)
    loc,center,T,c_sq,k,opacity=(arr[valid] for arr in (loc,center,T,c_sq,k,opacity))
    support=np.sqrt(k*c_sq/(c_sq-k))
    corners=T[:,:,2,None]+(T[:,:,:2]@np.array([[-1.,-1.,1.,1.],[-1.,1.,-1.,1.]]))*support[:,None,None]
    front=np.all(corners[:,2,:]>0,axis=1)
    pixels=focal*corners[:,:2,:]/np.maximum(corners[:,2,None,:],1e-6)+np.array([w/2,h/2])[None,:,None]-.5
    low=np.where(front[:,None],np.min(pixels,axis=-1),0)
    high=np.where(front[:,None],np.max(pixels,axis=-1),np.array([w-1,h-1]))
    low=np.clip(low,-2e4,2e4)
    high=np.clip(high,-2e4,2e4)

    d=direction[loc]
    functions=basis(d/np.linalg.norm(d,axis=1,keepdims=True))[:, :sh.shape[2]]
    rgb=np.maximum(dc[loc]*C0+.5+np.einsum('nck,nk->nc',sh[loc],functions),0)
    rgb=rgb.astype('f2').astype('f4')
    packed=np.ascontiguousarray(np.column_stack((low[:,0],high[:,0],low[:,1],high[:,1],opacity,rgb,np.linalg.inv(T).reshape(-1,9),support,1/c_sq)),dtype='f4')
    return packed,loc,focal


def render_reference(lib, model, cam, size):
    packed,_,focal=prepare_reference(model,cam,size)
    w,h=size
    image=np.zeros((h,w,4),dtype='f4');image[:,:,3]=1
    lib.draw_native_quad(len(packed),packed,w,h,focal,image)
    np.clip(image[:,:,:3],0,1,out=image[:,:,:3])
    return image


def prepare_projection(model, cam, w, h):
    positions, scales, rotations, _, dc, sh = model
    yaw,pitch,roll=np.deg2rad(cam[[3,4,6]])
    forward=np.array([np.cos(pitch)*np.cos(yaw),np.cos(pitch)*np.sin(yaw),np.sin(pitch)])
    right=np.array([np.sin(yaw),-np.cos(yaw),0.])
    down=np.cross(forward,right)
    axes=np.stack((np.cos(roll)*right+np.sin(roll)*down,np.cos(roll)*down-np.sin(roll)*right,forward),axis=1)
    direction=positions-cam[:3]
    p=direction@axes
    visible=np.flatnonzero((p[:,2]>.12)&(p[:,2]<80)&(np.abs(p[:,0])<p[:,2]*1.6)&(np.abs(p[:,1])<p[:,2]))
    ids=np.ascontiguousarray(visible[np.argsort(p[visible,2],kind="stable")],dtype="i4")
    x,y,z=p[ids].T
    f=w/(2*np.tan(np.deg2rad(cam[5])*.5))
    u,v=x/z,y/z
    camera=(axes.T@rotations[ids])*np.exp(scales[ids])[:,None,:]
    j0=(f/z)[:,None]*(camera[:,0]-u[:,None]*camera[:,2])
    j1=(f/z)[:,None]*(camera[:,1]-v[:,None]*camera[:,2])
    direction=direction[ids]
    funcs=basis(direction/np.linalg.norm(direction,axis=1,keepdims=True))[:, :sh.shape[2]]
    color=dc[ids]*C0+.5+np.einsum("nck,nk->nc",sh[ids],funcs)
    screen=np.column_stack((w/2+f*u-.5,h/2+f*v-.5))
    return screen,j0,j1,color,ids,funcs


def prepare(model, cam, w, h):
    screen,j0,j1,color,ids,_=prepare_projection(model,cam,w,h)
    data=np.column_stack((screen,np.sum(j0*j0,axis=1),np.sum(j0*j1,axis=1),np.sum(j1*j1,axis=1),
                          np.maximum(color,0)))
    return np.ascontiguousarray(data,dtype="f4"),ids


def render(lib, data, ids, w, h, scale, opacity, target, grad_scale, grad_opacity):
    out=np.zeros((h,w,4),dtype="f4")
    out[:,:,3]=1
    lib.raster_fit(len(ids),data,ids,w,h,scale,opacity,None if target is None else target.ctypes.data,
                   out,grad_scale,grad_opacity)
    return out


def fit(model, cameras, steps, width):
    positions, scales, quats, alpha, dc, sh = model
    model = positions, scales, Rotation.from_quat(quats).as_matrix().astype("f4"), alpha, dc, sh
    height = round(width*9/16)
    with tempfile.TemporaryDirectory(prefix="hyperscape-fit-") as scratch:
        lib = compile_raster(scratch)
        def prepare_view(index):
            camera = cameras[index]
            data, ids = prepare(model, camera, width, height)
            target = render_reference(lib, model, camera, (width, height))
            return dict(data=data, ids=ids, target=target)

        cache = ViewCache(scratch, prepare_view)
        prepared = []
        for i in range(len(cameras)):
            view = prepare_view(i)
            if view["ids"].size and np.any(view["target"][:, :, :3]):
                cache.store(i, view)
                prepared.append(i)
        if not prepared:
            raise ValueError("The selected cameras did not see the scan")
        print(f"Fitting {len(prepared)} camera views", flush=True)
        view_order = np.random.default_rng(31).permutation(prepared)
        log_size = np.zeros_like(alpha)
        opacity = alpha.copy()
        gs,ga = np.zeros_like(alpha),np.zeros_like(alpha)
        state = [(np.zeros_like(alpha),np.zeros_like(alpha)) for _ in range(2)]
        for step in range(steps):
            data = cache.load(view_order[step % len(view_order)])
            gs.fill(0)
            ga.fill(0)
            render(lib,data["data"],data["ids"],width,height,log_size,opacity,data["target"],gs,ga)
            rate = .019 if step < steps*4/7 else .009
            for param,grad,center,(m,v),lower,upper in [
                (log_size,gs,0,state[0],-.5,.5), (opacity,ga,alpha,state[1],0,1)
            ]:
                g = grad+.035*(param-center)
                m*=.9
                m+=.1*g
                v*=.99
                v+=.01*g*g
                param-=rate*(m/(1-.9**(step+1)))/(np.sqrt(v/(1-.99**(step+1)))+1e-6)
                np.clip(param,lower,upper,out=param)
            if (step+1)%32==0 or step+1==steps:
                print(f"Fit step {step+1}/{steps}", flush=True)
        return log_size, opacity
