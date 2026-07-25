#!/usr/bin/env bash
# Build the VM runtime and all contracts to wasm32 and copy the artifacts
# into the tree (they are committed so JS-only development needs no Rust).
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --target wasm32-unknown-unknown \
  --manifest-path packages/vm/runtime/Cargo.toml
mkdir -p packages/vm/wasm
cp packages/vm/runtime/target/wasm32-unknown-unknown/release/mordecai_vm_runtime.wasm \
  packages/vm/wasm/

cargo build --release --target wasm32-unknown-unknown \
  --manifest-path contracts/Cargo.toml
mkdir -p contracts/dist
cp contracts/target/wasm32-unknown-unknown/release/counter.wasm contracts/dist/
cp contracts/target/wasm32-unknown-unknown/release/marketplace.wasm contracts/dist/

ls -la packages/vm/wasm/*.wasm contracts/dist/*.wasm

# DSL example contracts (compiler/examples/*.pysc) — also committed.
for src in compiler/examples/*.pysc; do
  name=$(basename "$src" .pysc)
  ./compiler/mordecaic build "$src" -o "compiler/build/$name" --wasm >/dev/null
  cp "compiler/build/$name/$name.wasm" contracts/dist/
done
ls -la contracts/dist/*.wasm
