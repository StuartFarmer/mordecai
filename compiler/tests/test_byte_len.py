import unittest
from test_compiler import compile_ok
from mordecaidsl.errors import DslError


class TestByteLen(unittest.TestCase):
    def test_string_length_and_config_dependency(self):
        rust = compile_ok('contract A:\n    config:\n        label: str\n    action f(text: str):\n        require(byte_len(text) <= 8192, "large")\n        require(byte_len(config.label) > 0, "empty")\n')
        self.assertIn('text.clone().len() as u64', rust)
        self.assertIn('let config = load_config();', rust)
        self.assertIn('config.label.clone().len() as u64', rust)

    def test_rejects_non_string_and_wrong_arity(self):
        for expression in ['byte_len(1)', 'byte_len(True)', 'byte_len(sender)', 'byte_len()', 'byte_len("a", "b")']:
            with self.subTest(expression=expression), self.assertRaises(DslError):
                compile_ok(f'contract A:\n    action f():\n        n = {expression}\n')
