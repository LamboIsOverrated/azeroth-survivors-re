"""Fail-closed Vanilla ADT checks for operator-owned private input repair.

No game content is included. A repair is permitted only when an unreadable
patch entry is the exact prefix of a complete, structurally valid lower entry
with the same declared full size. Unknown corruption requires different input.
"""
import struct


def valid_adt(data):
    def integer(offset):
        return struct.unpack_from('<I', data, offset)[0]

    def chunk(offset, magic, minimum=8):
        return (0 <= offset <= len(data) - minimum and data[offset:offset + 4] == magic
                and integer(offset + 4) >= minimum - 8
                and integer(offset + 4) <= len(data) - offset - 8)

    try:
        if len(data) < 84 or data[:4] != b'REVM' or integer(4) != 4 or integer(8) != 18:
            return False
        if not chunk(12, b'RDHM', 72):
            return False
        mcin = 20 + integer(24)
        # The pinned decoder assumes this canonical placement as well.
        if mcin != 84 or not chunk(mcin, b'NICM', 4104):
            return False
        for cell in range(256):
            offset, size, _, _ = struct.unpack_from('<IIII', data, mcin + 8 + 16 * cell)
            if not offset:
                continue
            if size < 136 or offset > len(data) - size or not chunk(offset, b'KNCM', 136):
                return False
            height = integer(offset + 28)
            if height and not chunk(offset + height, b'TVCM', 588):
                return False
            liquid, liquid_size = integer(offset + 104), integer(offset + 108)
            if liquid:
                # Vanilla files can store zero in the MCLQ chunk header while
                # MCNK.sizeMCLQ carries the complete usable liquid payload size.
                minimum = 728 if liquid_size > 8 else 8
                position = offset + liquid
                if (liquid_size < minimum or position > len(data) - liquid_size
                        or data[position:position + 4] != b'QLCM'):
                    return False
        return True
    except (struct.error, OverflowError):
        return False


def verified_prefix(prefix, complete, declared_size):
    return (0 < len(prefix) < len(complete) == declared_size
            and complete.startswith(prefix) and valid_adt(complete))
