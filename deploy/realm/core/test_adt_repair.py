import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('adt_repair', Path(__file__).with_name('adt_repair.py'))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def synthetic_adt():
    start = 84 + 4104
    data = bytearray(start + 256 * 724)
    struct.pack_into('<4sII', data, 0, b'REVM', 4, 18)
    struct.pack_into('<4sI', data, 12, b'RDHM', 64)
    struct.pack_into('<I', data, 24, 64)
    struct.pack_into('<4sI', data, 84, b'NICM', 4096)
    for cell in range(256):
        offset = start + cell * 724
        struct.pack_into('<IIII', data, 92 + cell * 16, offset, 724, 0, 0)
        struct.pack_into('<4sI', data, offset, b'KNCM', 716)
        struct.pack_into('<I', data, offset + 28, 136)
        struct.pack_into('<4sI', data, offset + 136, b'TVCM', 580)
    return bytes(data)


class RepairTests(unittest.TestCase):
    def test_valid_complete_adt_and_truncated_prefix(self):
        data = synthetic_adt()
        self.assertTrue(repair.valid_adt(data))
        self.assertFalse(repair.valid_adt(data[:len(data) // 2]))

    def test_repair_requires_byte_identical_prefix_declared_size_and_valid_base(self):
        full = synthetic_adt()
        prefix = full[:len(full) // 2]
        self.assertTrue(repair.verified_prefix(prefix, full, len(full)))
        self.assertFalse(repair.verified_prefix(b'wrong' + prefix[5:], full, len(full)))
        self.assertFalse(repair.verified_prefix(prefix, full, len(full) + 1))
        self.assertFalse(repair.verified_prefix(prefix[:100], prefix, len(prefix)))

    def test_out_of_bounds_mcnk_and_height_offsets_fail_closed(self):
        data = bytearray(synthetic_adt())
        struct.pack_into('<I', data, 92, len(data) + 100)
        self.assertFalse(repair.valid_adt(data))

    def test_vanilla_liquid_uses_parent_size_even_if_chunk_size_is_zero(self):
        data = bytearray(synthetic_adt())
        offset = len(data)
        data.extend(b'QLCM' + bytes(808))
        first_cell = 84 + 4104
        struct.pack_into('<II', data, first_cell + 104, offset - first_cell, 812)
        self.assertTrue(repair.valid_adt(data))
        data = bytearray(synthetic_adt())
        struct.pack_into('<I', data, 84 + 4104 + 28, len(data))
        self.assertFalse(repair.valid_adt(data))


if __name__ == '__main__':
    unittest.main()
