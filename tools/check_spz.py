"""Validate an already-exported Hyperscape SPZ model."""
import argparse
import gzip
import struct


def read_header(scan):
    header = scan.read(16)
    if len(header) != 16:
        raise ValueError("Incomplete SPZ header")
    magic, version, count, degree, fractional_bits, flags, reserved = struct.unpack("<4sIIBBBB", header)
    if magic != b"NGSP" or version != 2 or flags != 0x0C or reserved != 0:
        raise ValueError("Expected a Hyperscape SPZ v2 header with flags 0x0C")
    if not 0 < count <= 4_000_000 or degree > 3 or fractional_bits > 24:
        raise ValueError("The model exceeds the viewer's supported dimensions")
    size = count * (19 + 3 * ((degree + 1) ** 2 - 1))
    return count, degree, fractional_bits, size


def inspect(path):
    with gzip.open(path, "rb") as scan:
        count, degree, fractional_bits, size = read_header(scan)
        remaining = size
        while remaining:
            block = scan.read(min(1 << 20, remaining))
            if not block:
                raise ValueError("Incomplete SPZ attribute data")
            remaining -= len(block)
        if scan.read(1):
            raise ValueError("Unexpected data after the SPZ attributes")
        print(f"{count:,} splats, degree {degree}, {fractional_bits} position bits, {size + 16:,} decoded bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    args = parser.parse_args()
    try:
        inspect(args.path)
    except (OSError, EOFError, ValueError) as error:
        parser.exit(1, f"{error}\n")
