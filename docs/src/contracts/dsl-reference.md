# DSL Language Reference

The HSSN contract language is a small, deliberately constrained,
Python-like language (spec §21). Source files use the `.pysc` extension and
compile through `hssnc`: **parse → static verification → generated Rust →
wasm32**. Only verified deterministic code reaches the chain; the compiler
guarantees checked arithmetic (overflow aborts), per-map storage prefixes,
atomic revert on failure, and write-once config — regardless of what the
source does.

## File structure

```python
contract Name:

    config:                     # optional; at most one block
        field: type

    state MapName[key_type]:    # any number of maps
        field: type
        field: type = default   # literal defaults for int/str/bool

    action name(param: type, ...):
        ...statements...
```

## Types

Exactly four scalars: `int` (u64, checked), `str` (UTF-8), `bool`,
`address` (a 32-byte key). No floats, ever. State-map keys may be `int` or
`address`. Address fields cannot have defaults.

## Builtins

| Name     | Type    | Meaning                                                      |
| -------- | ------- | ------------------------------------------------------------ |
| `sender` | address | the transaction signer, or the calling contract in sub-calls |
| `value`  | int     | native currency attached to this call                        |
| `height` | int     | height of the block being executed                           |

All three are read-only.

## Statements

```python
require(cond)                       # abort with "requirement failed"
require(cond, "message")            # abort with your message; all effects revert

x = expr                            # bind a local (type fixed at first assignment)
x += expr / x -= expr               # int only, checked

m = Map[key]                        # bind a state handle
m.field = expr                      # field writes persist immediately
Map[key] = Map(field=expr, ...)     # construct/overwrite an entry
Map[key].field += expr              # in-place entry update

transfer(to_addr, amount)           # pay from the CONTRACT's balance; aborts on failure
emit("message")                     # append a receipt event

if cond: ... elif cond: ... else: ...
```

There are **no loops, no functions, no imports, no recursion, no
randomness, no clock** (v1 keeps deterministic bounds trivially). `while`,
`for`, `def`, `return`, `class`, floats, and f-strings are rejected at
parse time.

## Expressions

- Arithmetic: `+`, `-` (int, checked — overflow/underflow aborts).
- Comparison: `==`, `!=` on any scalar; `<`, `<=`, `>`, `>=` on int only.
  No chained comparisons.
- Boolean: `and`, `or`, `not`.
- `exists(Map[key])` → bool.
- `config.field` — read-only access to config.
- `Map[key].field` — read a field without binding.

## State semantics

- Reading a missing entry of a map whose fields **all have defaults**
  yields the default instance. Reading a missing entry otherwise aborts
  (`no such <Map> entry`).
- Constructing an entry requires every field without a default.
- State handles (`m = Map[k]`) cannot be reassigned, compared, or passed
  around as values — access their fields.

## Config and `init`

If a `config:` block exists, the compiler generates an `init(...)` action
taking the config fields in declaration order. It can be called exactly
once (anyone may call it — deploy and init in one breath); every other
action that touches `config` aborts until then. Config is immutable after.

## Action ABI

Each action becomes an exported WASM function. Callers encode arguments in
declaration order with the SDK's `ContractArgs` (u64 LE for int, u64 0/1
for bool, length-prefixed UTF-8 for str, length-prefixed 32 bytes for
address). Match ids and similar values your contract creates are best
emitted as events or made derivable (e.g. sequential).

## Compiler CLI

```sh
./compiler/hssnc check  contract.pysc          # parse + verify only
./compiler/hssnc build  contract.pysc -o out/  # emit the cargo project
./compiler/hssnc build  contract.pysc -o out/ --wasm   # …and compile it
```

Reserved words you can't use as identifiers include the statement keywords,
the builtins, and names the generated Rust uses (`config`, `key`, `storage`,
Rust keywords). The verifier reports collisions with line numbers.
