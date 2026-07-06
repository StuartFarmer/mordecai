"""hssndsl: the HSSN Pythonic contract language compiler.

Pipeline (spec §21): .pysc source -> parse -> typecheck -> Rust codegen
against the hssn-contract ABI -> wasm32 (cargo).

Parser and typechecker are ported from the mordsl compiler (mordecai
project); codegen targets the HSSN contract ABI instead of CosmWasm.
"""

from hssndsl.parser import parse
from hssndsl.typecheck import check
from hssndsl.codegen import generate

__all__ = ["parse", "check", "generate"]
