"""Bound the temporary space for prepared views without quantizing them."""
import errno
from pathlib import Path
import shutil

import numpy as np


class ViewCache:
    byte_limit = 256 * 1024**2

    def __init__(self, directory, prepare):
        self.directory = Path(directory)
        self.prepare = prepare
        self.bytes_written = 0
        self.paths = {}

    def store(self, index, view):
        # Reserve a conservative allowance for the ZIP and array headers.
        size = sum(array.nbytes + 1024 for array in view.values())
        if size > self.byte_limit - self.bytes_written:
            return
        if size + 16 * 1024**2 > shutil.disk_usage(self.directory).free:
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
