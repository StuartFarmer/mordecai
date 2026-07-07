# compiler/ — hssnc, the Pythonic contract compiler (spec §21)

Pipeline: `.pysc` source → parse → typecheck → generated Rust against
`contracts/runtime-rs` → wasm32 → deploy.

```sh
./compiler/hssnc check compiler/examples/land.pysc
./compiler/hssnc build compiler/examples/land.pysc -o build/land --wasm
```

- `hssndsl/` — pure-stdlib Python package: `parser.py` (tokenizer +
  recursive descent) and `typecheck.py` (static verifier) are ported from
  the mordsl compiler (mordecai project); `codegen.py` targets the HSSN
  contract ABI. Guarantees regardless of source: checked arithmetic
  (overflow aborts), per-map key prefixes, atomic revert via abort,
  write-once config through the generated `init` action.
- `examples/land.pysc` — tile-claiming example exercising config, state
  maps, defaults, require, and the `height`/`sender` builtins.
- `tests/` — `python3 -m unittest discover compiler/tests`
- End-to-end proof: `packages/chain/test/dsl-e2e.test.ts` compiles the
  example and asserts on-chain behavior (skipped without cargo/python3).

Language v1 (spec §21): int (u64) / str / bool / address scalars, state
maps keyed by int or address, config, actions, require, if/elif/else,
checked +/-, comparisons, and/or/not, exists(), `sender`, `height`,
`time` (block timestamp in ms — the clock behind deadline/forfeit logic).
