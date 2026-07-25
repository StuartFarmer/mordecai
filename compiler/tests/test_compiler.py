"""Compiler unit tests: parse/check rejections and codegen shape.

Run: python3 -m unittest discover compiler/tests  (PYTHONPATH=compiler)
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from mordecaidsl import check, generate, parse
from mordecaidsl.errors import DslError

LAND = (pathlib.Path(__file__).parent.parent / "examples" / "land.pysc").read_text()


def compile_ok(source: str) -> str:
    program = parse(source)
    check(program)
    return generate(program, "/tmp/runtime")["src/lib.rs"]


class TestCompiler(unittest.TestCase):
    def test_land_compiles(self):
        rust = compile_ok(LAND)
        for needle in [
            'pub extern "C" fn init() -> i32',
            'pub extern "C" fn claim_tile() -> i32',
            'pub extern "C" fn harvest() -> i32',
            "c::block_height()",
            "c::caller()",
            'c::fail("tile is off the map")',
            "checked_add",
        ]:
            self.assertIn(needle, rust)

    def test_no_config_no_init(self):
        rust = compile_ok(
            "contract Tiny:\n"
            "    state Box[int]:\n"
            "        n: int = 0\n"
            "    action bump(k: int):\n"
            "        Box[k].n += 1\n"
        )
        self.assertNotIn("fn init()", rust)

    def test_reject_unknown_name(self):
        with self.assertRaises(DslError):
            check(parse("contract A:\n    action f():\n        x = missing\n"))

    def test_reject_type_mismatch(self):
        with self.assertRaises(DslError):
            check(parse('contract A:\n    action f():\n        x = 1\n        x = "s"\n'))

    def test_reject_assign_to_builtin(self):
        with self.assertRaises(DslError):
            check(parse("contract A:\n    action f():\n        sender = 1\n"))

    def test_reject_write_to_config(self):
        with self.assertRaises(DslError):
            check(parse(
                "contract A:\n"
                "    config:\n        cap: int\n"
                "    action f():\n        config.cap = 2\n"
            ))

    def test_reject_missing_required_field(self):
        with self.assertRaises(DslError):
            check(parse(
                "contract A:\n"
                "    state Item[int]:\n        owner: address\n"
                "    action f(k: int):\n        Item[k] = Item()\n"
            ))


if __name__ == "__main__":
    unittest.main()
