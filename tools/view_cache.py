"""Bound the temporary space for prepared views without quantizing them."""
import errno
from pathlib import Path
import shutil

import numpy as np


class ViewCache:
    # Cache up to half the free space (at least 256 MB, at most 16 GB).
    byte_limit = None

    def __init__(self, directory, prepare):
        self.directory = Path(directory)
        self.prepare = prepare
        self.bytes_written = 0
        self.paths = {}
        if self.byte_limit is None:
            free = shutil.disk_usage(self.directory).free
            self.byte_limit = int(min(16 * 1024**3, max(256 * 1024**2, free // 2)))

    def store(self, index, view):
        # Reserve a conservative allowance for the ZIP and array headers.
        size = sum(array.nbytes + 1024 for array in view.values())
        if size > self.byte_limit - self.bytes_written:
            return
        # Keep at least 1 GB free for the output and other programs.
        if size + 1024**3 > shutil.disk_usage(self.directory).free:
            return
        path = self.directory / f"view-{index}.npz"
        try:
            np.savez(path, **view)
        except OSError as error:
            if error.errno not in (errno.ENOSPC, errno.EDQUOT):
                raise
            path.unlink(missing_ok=True)
            return
        self.paths[index] = path
        self.bytes_written += path.stat().st_size

    def load(self, index):
        path = self.paths.get(index)
        if path is None:
            view = self.prepare(index)
            self.store(index, view)
            return view
        with np.load(path) as view:
            return {key: view[key] for key in view.files}
