# Architecture

The authoritative architecture documents are, in order:

1. `SPEC_PT_01.md` — philosophy, state categories, networking layer.
2. `SPEC_PT_02.md` — settlement layer, contracts, application model.
3. `SPEC_PT_03.md` — contract language, APIs, security model, roadmap.
4. `IMPLEMENTATION_PLAN.md` — the concrete v1 decisions (D1–D8) and
   milestones (M0–M7) this repository is executing.

## Layer map → packages

| Layer (spec §25)     | Package(s)                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| L0 Cryptography      | `packages/crypto` (M1)                                                        |
| L1 Holepunch network | `packages/networking` (M2)                                                    |
| L2 Settlement chain  | `packages/protocol`, `state`, `chain`, `consensus`, `node`, `rpc` (M0, M3–M4) |
| L3 Smart contracts   | `packages/vm`, `contracts/*` (M5)                                             |
| L4 SDKs              | `packages/wallet`, `sdk`, `pear-integration` (M1, M7)                         |
| L5 Applications      | `apps/*` (M6–M7)                                                              |

## Wire format

`packages/protocol` defines the canonical encoding for every consensus-visible
structure. Rules:

- Fixed-width little-endian integers; u64 values are bigints end to end.
- Variable-length fields carry a u32 byte-length prefix and a hard maximum.
- Strings are UTF-8, decoded in fatal mode.
- Decode consumes every byte or fails — each structure has exactly one valid
  byte representation, which is what gets hashed and signed.
- Signing preimages are prefixed with a domain tag (`hssn:tx:v1`,
  `hssn:block:v1`, `hssn:vote:v1`).

Golden vectors in `packages/protocol/test/vectors/golden.json` pin the exact
bytes; changing them is a consensus-breaking protocol change.
