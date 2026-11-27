"""Temporary storage for prepared views and native reference renders.

Native references depend only on the scan, camera and size, so each one is rendered
once and shared by every stage. They are kept as half-precision RGBA, which is far
below the fitting error, and every caller gets its own float32 copy.
"""
import atexit
import errno
import hashlib
from pathlib import Path
import shutil
import tempfile
import weakref

import numpy as np

RESERVE = 1024**3  # keep this much disk free for the output and other programs


def _save(path, **arrays):
    try:
        np.savez(path, **arrays)
    except OSError as error:
        if error.errno not in (errno.ENOSPC, errno.EDQUOT):
            raise
        Path(path).unlink(missing_ok=True)
        return False
    return True


class ReferenceStore:
    def __init__(self):
        self.directory = None
        self.paths = {}
        self.issued = {}

    def fingerprint(self, model):
        """Hash everything that shapes a reference render except rotation layout."""
        positions, scales, rotations, alpha, dc, sh = model
        arrays = (positions, scales, rotations, alpha, dc, sh)
        memo = self.__dict__.setdefault("fingerprints", {})
        token = tuple(id(array) for array in arrays)
        entry = memo.get(token)
        if entry and all(ref() is array for ref, array in zip(entry[0], arrays)):
            return entry[1]
        digest = hashlib.sha1()
        for array in (positions, scales, alpha, dc, sh):
            digest.update(np.ascontiguousarray(array).tobytes())
        rotation = np.asarray(rotations)
        # Quaternions and matrices describe the same scan, so hash it as matrices.
        if rotation.ndim == 2 and rotation.shape[1] == 4:
            from scipy.spatial.transform import Rotation
            rotation = Rotation.from_quat(rotation).as_matrix()
        digest.update(np.ascontiguousarray(rotation, dtype="f4").round(5).tobytes())
        value = digest.hexdigest()
        memo[token] = (tuple(weakref.ref(array) for array in arrays), value)
        return value

    def key(self, model, camera, size):
        return (self.fingerprint(model), np.asarray(camera, "f8").round(9).tobytes(), tuple(int(v) for v in size))

    def _issue(self, target, key):
        self.issued = {i: entry for i, entry in self.issued.items() if entry[0]() is not None}
        self.issued[id(target)] = (weakref.ref(target), key)
        return target

    def key_of(self, target):
        entry = self.issued.get(id(target))
        return entry[1] if entry and entry[0]() is target else None

    def load(self, key):
        with np.load(self.paths[key]) as stored:
            return self._issue(stored["rgba"].astype("f4"), key)

    def get(self, lib, model, camera, size, render):
        key = self.key(model, camera, size)
        if key in self.paths:
            return self.load(key)
        target = render(lib, model, camera, size)
        half = target.astype("f2")
        target[...] = half
        if self.directory is None:
            self.directory = Path(tempfile.mkdtemp(prefix="hyperscape-references-"))
            atexit.register(shutil.rmtree, self.directory, True)
        if half.nbytes + RESERVE < shutil.disk_usage(self.directory).free:
            path = self.directory / f"reference-{len(self.paths)}.npz"
            if _save(path, rgba=half):
                self.paths[key] = path
        return self._issue(target, key) if key in self.paths else target


REFERENCES = ReferenceStore()


class ViewCache:
    # Cache up to half the free space (at least 256 MB, at most 16 GB).
    byte_limit = None

    def __init__(self, directory, prepare):
        self.directory = Path(directory)
        self.prepare = prepare
        self.bytes_written = 0
        self.paths = {}
        self.references = {}
        if self.byte_limit is None:
            free = shutil.disk_usage(self.directory).free
            self.byte_limit = int(min(16 * 1024**3, max(256 * 1024**2, free // 2)))

    def store(self, index, view):
        view = dict(view)
        target = view.get("target")
        reference = REFERENCES.key_of(target) if isinstance(target, np.ndarray) else None
        if reference is not None:
            del view["target"]
        elif isinstance(target, np.ndarray) and target.dtype == np.float32:
            view["target"] = target.astype("f2")
        # Reserve a conservative allowance for the ZIP and array headers.
        size = sum(array.nbytes + 1024 for array in view.values())
        if size > self.byte_limit - self.bytes_written:
            return
        if size + RESERVE > shutil.disk_usage(self.directory).free:
            return
        path = self.directory / f"view-{index}.npz"
        if not _save(path, **view):
            return
        self.paths[index] = path
        self.references[index] = reference
        self.bytes_written += path.stat().st_size

    def load(self, index):
        path = self.paths.get(index)
        if path is None:
            view = self.prepare(index)
            self.store(index, view)
            return view
        with np.load(path) as stored:
            view = {key: stored[key] for key in stored.files}
        if self.references[index] is not None:
            view["target"] = REFERENCES.load(self.references[index])
        elif "target" in view and view["target"].dtype == np.float16:
            view["target"] = view["target"].astype("f4")
        return view
