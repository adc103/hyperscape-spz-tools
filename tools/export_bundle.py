"""Read the official export folder and its portable ZIP form."""
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
import json
import re
import shutil
import tempfile
from zipfile import ZipFile

import numpy as np


SIDECARS = {"cluster_centroids.json": 4 << 20, "od_cluster_centroids.json": 4 << 20,
            "camera_poses.json": 32 << 20, "cluster_masks.bin": 64 << 20,
            "od_cluster_masks.bin": 64 << 20}


@contextmanager
def open_bundle(path):
    if not path.is_dir() and path.suffix.lower() != ".zip":
        yield path, None
        return
    with tempfile.TemporaryDirectory(prefix="hyperscape-export-") as temp:
        folder = Path(temp) if path.is_file() else path
        if folder != path:
            with ZipFile(path) as archive:
                entries = {}
                for item in archive.infolist():
                    if item.is_dir():
                        continue
                    name = PurePosixPath(item.filename.replace("\\", "/")).name
                    if name not in SIDECARS and not re.fullmatch(r"[^/]+\.spz", name, re.I):
                        continue
                    # The legacy archive carries a second copy inside the device folder.
                    if "/device_visibility_clusters/" in "/" + item.filename.replace("\\", "/"):
                        continue
                    if name in entries:
                        raise ValueError(f"Duplicate export entry {name}")
                    entries[name] = item
                for name, item in entries.items():
                    if item.file_size > SIDECARS.get(name, 512 << 20):
                        raise ValueError(f"Export entry exceeds the supported size: {name}")
                    with archive.open(item) as source, (folder/name).open("wb") as output:
                        shutil.copyfileobj(source, output)
        scans = [item for item in folder.iterdir() if item.suffix.lower() == ".spz" and item.is_file()]
        if len(scans) != 1:
            raise ValueError("An export must contain exactly one SPZ")
        yield scans[0], folder


def bundle_centroids(folder):
    for name in ("cluster_centroids.json", "od_cluster_centroids.json"):
        path = folder/name
        if path.is_file():
            return path
    raise ValueError("The export needs cluster_centroids.json beside the SPZ")


def capture_pose_cameras(path):
    data = json.loads(path.read_text())
    matrices = np.asarray(data["input_poses"], dtype="f8")
    intrinsics = np.asarray(data["intrinsics"], dtype="f8")
    if matrices.ndim != 3 or matrices.shape[1:] != (4, 4) or intrinsics.shape != (len(matrices), 4):
        raise ValueError("Unexpected capture camera dimensions")
    valid = np.isfinite(matrices).all(axis=(1, 2)) & np.isfinite(intrinsics).all(axis=1)
    valid &= (intrinsics[:, 0] > 0) & (intrinsics[:, 2] > 0)
    matrices, intrinsics = matrices[valid], intrinsics[valid]
    # The capture cameras are y-up and look along -Z (OpenGL/OpenXR convention).
    forward = -matrices[:, :3, 2]
    horizontal = np.hypot(forward[:, 0], forward[:, 1])
    yaw = np.arctan2(forward[:, 1], forward[:, 0])
    pitch = np.arctan2(forward[:, 2], horizontal)
    # Use the optical axis and level the fitting frame. The capture camera
    # may store portrait or inverted image axes.
    roll = np.zeros(len(yaw))
    fov = 2*np.arctan(intrinsics[:, 2]/intrinsics[:, 0])
    poses = np.column_stack((matrices[:, :3, 3], np.rad2deg(np.stack((yaw, pitch, fov, roll), axis=1))))
    usable = (abs(poses[:, 4]) <= 55) & (abs(poses[:, 6]) <= 35) & (poses[:, 5] >= 45) & (poses[:, 5] <= 125)
    return poses[usable]


def read_visibility(path, count):
    if path.name not in ("cluster_centroids.json", "od_cluster_centroids.json"):
        return None
    mask = path.with_name(path.name.replace("centroids.json", "masks.bin"))
    if not mask.is_file():
        return None
    data = json.loads(path.read_text())
    views = np.asarray(data["views"], dtype="f8")
    size = 4*((len(views)*count+31)//32)
    if mask.stat().st_size != size:
        raise ValueError("The visibility mask length does not match the export")
    return views, np.fromfile(mask, dtype="u1")
