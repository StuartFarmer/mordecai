"""mordecaidsl: the Mordecai Pythonic contract language compiler.

Pipeline (spec §21): .pysc source -> parse -> typecheck -> Rust codegen
against the mordecai-contract ABI -> wasm32 (cargo).

Parser and typechecker are ported from the mordsl compiler (the original
CosmWasm mordecai); codegen targets the Mordecai contract ABI instead of
CosmWasm.
"""

from mordecaidsl.parser import parse
from mordecaidsl.typecheck import check
from mordecaidsl.codegen import generate

__all__ = ["parse", "check", "generate"]
