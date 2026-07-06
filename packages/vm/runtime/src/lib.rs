//! HSSN contract execution runtime.
//!
//! This crate compiles to wasm32-unknown-unknown and runs *inside* the
//! node's JS WebAssembly host. It embeds the wasmi interpreter to execute
//! contract modules with deterministic fuel metering, bridging contract
//! host functions ("env.*") out to the JS host ("host.*"), which services
//! storage, transfers, events, and cross-contract calls.
//!
//! Nothing here may be nondeterministic: no clocks, no randomness, no
//! floats (rejected at validation), fixed memory limits.

#![allow(clippy::missing_safety_doc)]

use wasmi::{Caller, Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};

// ---------------------------------------------------------------- JS host

#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn host_storage_get(key_ptr: *const u8, key_len: u32) -> i64;
    fn host_storage_read(dst_ptr: *mut u8);
    fn host_storage_set(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    fn host_storage_del(key_ptr: *const u8, key_len: u32);
    fn host_transfer(to_ptr: *const u8, amount: u64) -> u32;
    fn host_emit(ptr: *const u8, len: u32);
    fn host_call(
        contract_ptr: *const u8,
        action_ptr: *const u8,
        action_len: u32,
        args_ptr: *const u8,
        args_len: u32,
        value: u64,
        fuel: u64,
    ) -> i64;
}

// ------------------------------------------------------------- allocator

static mut ARENA: Vec<Vec<u8>> = Vec::new();

/// JS-visible allocator: allocate a buffer the host can write into.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: u32) -> u32 {
    let mut buf = vec![0u8; len as usize];
    let ptr = buf.as_mut_ptr() as u32;
    #[allow(static_mut_refs)]
    unsafe {
        ARENA.push(buf);
    }
    ptr
}

/// Drop all alloc() buffers and outputs (call between executions).
#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    #[allow(static_mut_refs)]
    unsafe {
        ARENA.clear();
    }
    set_output(Vec::new(), Vec::new(), 0);
}

// ----------------------------------------------------------- exec output

static mut RET: Vec<u8> = Vec::new();
static mut ERR: Vec<u8> = Vec::new();
static mut FUEL_USED: u64 = 0;

fn set_output(ret: Vec<u8>, err: Vec<u8>, fuel_used: u64) {
    unsafe {
        RET = ret;
        ERR = err;
        FUEL_USED = fuel_used;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ret_ptr() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        RET.as_ptr() as u32
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ret_len() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        RET.len() as u32
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn err_ptr() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        ERR.as_ptr() as u32
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn err_len() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        ERR.len() as u32
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn fuel_used() -> u64 {
    unsafe { FUEL_USED }
}

// ------------------------------------------------------------ validation

pub const OK: u32 = 0;
pub const ERR_PARSE: u32 = 1;
pub const ERR_FORBIDDEN_FEATURE: u32 = 2;
pub const ERR_BAD_IMPORT: u32 = 3;
pub const ERR_NO_MEMORY: u32 = 4;

const ALLOWED_IMPORTS: &[&str] = &[
    "storage_get",
    "storage_read",
    "storage_set",
    "storage_del",
    "caller_addr",
    "attached_value",
    "block_height",
    "arg_len",
    "arg_read",
    "set_return",
    "emit",
    "abort",
    "transfer",
    "call",
];

fn features() -> wasmparser::WasmFeatures {
    use wasmparser::WasmFeatures as F;
    // Everything a plain wasm32-unknown-unknown Rust build needs — and no
    // floats, SIMD, threads, or other nondeterminism vectors.
    F::MUTABLE_GLOBAL
        | F::SIGN_EXTENSION
        | F::SATURATING_FLOAT_TO_INT
        | F::BULK_MEMORY
        | F::MULTI_VALUE
        | F::REFERENCE_TYPES
        | F::TAIL_CALL
}

/// Validate a contract module: parses under the restricted feature set
/// (float opcodes are rejected wholesale), imports only the contract ABI,
/// and exports a memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn validate(code_ptr: *const u8, code_len: u32) -> u32 {
    let code = unsafe { core::slice::from_raw_parts(code_ptr, code_len as usize) };

    let mut validator = wasmparser::Validator::new_with_features(features());
    if validator.validate_all(code).is_err() {
        // Distinguish "uses a forbidden feature" from garbage best-effort.
        let mut permissive = wasmparser::Validator::new();
        return if permissive.validate_all(code).is_ok() {
            ERR_FORBIDDEN_FEATURE
        } else {
            ERR_PARSE
        };
    }

    let mut has_memory_export = false;
    for payload in wasmparser::Parser::new(0).parse_all(code) {
        match payload {
            Ok(wasmparser::Payload::ImportSection(imports)) => {
                for group in imports {
                    let Ok(group) = group else {
                        return ERR_PARSE;
                    };
                    // Compact import groups belong to a disabled proposal.
                    let wasmparser::Imports::Single(_, import) = group else {
                        return ERR_BAD_IMPORT;
                    };
                    if import.module != "env" || !ALLOWED_IMPORTS.contains(&import.name) {
                        return ERR_BAD_IMPORT;
                    }
                }
            }
            Ok(wasmparser::Payload::ExportSection(exports)) => {
                for export in exports {
                    let Ok(export) = export else {
                        return ERR_PARSE;
                    };
                    if export.kind == wasmparser::ExternalKind::Memory {
                        has_memory_export = true;
                    }
                }
            }
            Ok(_) => {}
            Err(_) => return ERR_PARSE,
        }
    }
    if !has_memory_export {
        return ERR_NO_MEMORY;
    }
    OK
}

// -------------------------------------------------------------- execution

pub const EXEC_OK: u32 = 0;
pub const EXEC_TRAP: u32 = 1;
pub const EXEC_OUT_OF_FUEL: u32 = 2;
pub const EXEC_ACTION_FAILED: u32 = 3;
pub const EXEC_NO_ACTION: u32 = 4;
pub const EXEC_INVALID_MODULE: u32 = 5;
pub const EXEC_ABORTED: u32 = 6;

struct Ctx {
    caller: [u8; 32],
    value: u64,
    height: u64,
    args: Vec<u8>,
    ret: Vec<u8>,
    aborted: Option<Vec<u8>>,
    last_get_len: i64,
    limits: StoreLimits,
}

const MAX_KEY: usize = 256;
const MAX_VALUE: usize = 64 * 1024;
const MAX_EVENT: usize = 4 * 1024;
const MAX_RETURN: usize = 64 * 1024;
const MEMORY_LIMIT: usize = 4 * 1024 * 1024;

fn memory_of(caller: &mut Caller<'_, Ctx>) -> Result<wasmi::Memory, wasmi::Error> {
    caller
        .get_export("memory")
        .and_then(wasmi::Extern::into_memory)
        .ok_or_else(|| wasmi::Error::new("contract has no exported memory"))
}

fn read_inner(
    caller: &mut Caller<'_, Ctx>,
    ptr: i32,
    len: i32,
    max: usize,
) -> Result<Vec<u8>, wasmi::Error> {
    if len < 0 || len as usize > max {
        return Err(wasmi::Error::new("buffer length out of bounds"));
    }
    let memory = memory_of(caller)?;
    let mut buf = vec![0u8; len as usize];
    memory
        .read(&caller, ptr as usize, &mut buf)
        .map_err(|_| wasmi::Error::new("out-of-bounds contract memory read"))?;
    Ok(buf)
}

fn write_inner(caller: &mut Caller<'_, Ctx>, ptr: i32, data: &[u8]) -> Result<(), wasmi::Error> {
    let memory = memory_of(caller)?;
    memory
        .write(&mut *caller, ptr as usize, data)
        .map_err(|_| wasmi::Error::new("out-of-bounds contract memory write"))
}

fn link_env(linker: &mut Linker<Ctx>) -> Result<(), wasmi::Error> {
    linker.func_wrap(
        "env",
        "storage_get",
        |mut caller: Caller<'_, Ctx>, kp: i32, kl: i32| -> Result<i64, wasmi::Error> {
            let key = read_inner(&mut caller, kp, kl, MAX_KEY)?;
            let len = unsafe { host_storage_get(key.as_ptr(), key.len() as u32) };
            caller.data_mut().last_get_len = len;
            Ok(len)
        },
    )?;
    linker.func_wrap(
        "env",
        "storage_read",
        |mut caller: Caller<'_, Ctx>, dst: i32| -> Result<(), wasmi::Error> {
            let len = caller.data().last_get_len;
            if len < 0 || len as usize > MAX_VALUE {
                return Err(wasmi::Error::new("storage_read without a prior get"));
            }
            let mut buf = vec![0u8; len as usize];
            unsafe { host_storage_read(buf.as_mut_ptr()) };
            write_inner(&mut caller, dst, &buf)
        },
    )?;
    linker.func_wrap(
        "env",
        "storage_set",
        |mut caller: Caller<'_, Ctx>,
         kp: i32,
         kl: i32,
         vp: i32,
         vl: i32|
         -> Result<(), wasmi::Error> {
            let key = read_inner(&mut caller, kp, kl, MAX_KEY)?;
            let value = read_inner(&mut caller, vp, vl, MAX_VALUE)?;
            unsafe {
                host_storage_set(
                    key.as_ptr(),
                    key.len() as u32,
                    value.as_ptr(),
                    value.len() as u32,
                )
            };
            Ok(())
        },
    )?;
    linker.func_wrap(
        "env",
        "storage_del",
        |mut caller: Caller<'_, Ctx>, kp: i32, kl: i32| -> Result<(), wasmi::Error> {
            let key = read_inner(&mut caller, kp, kl, MAX_KEY)?;
            unsafe { host_storage_del(key.as_ptr(), key.len() as u32) };
            Ok(())
        },
    )?;
    linker.func_wrap(
        "env",
        "caller_addr",
        |mut caller: Caller<'_, Ctx>, dst: i32| -> Result<(), wasmi::Error> {
            let addr = caller.data().caller;
            write_inner(&mut caller, dst, &addr)
        },
    )?;
    linker.func_wrap("env", "attached_value", |caller: Caller<'_, Ctx>| -> i64 {
        caller.data().value as i64
    })?;
    linker.func_wrap("env", "block_height", |caller: Caller<'_, Ctx>| -> i64 {
        caller.data().height as i64
    })?;
    linker.func_wrap("env", "arg_len", |caller: Caller<'_, Ctx>| -> i32 {
        caller.data().args.len() as i32
    })?;
    linker.func_wrap(
        "env",
        "arg_read",
        |mut caller: Caller<'_, Ctx>, dst: i32| -> Result<(), wasmi::Error> {
            let args = caller.data().args.clone();
            write_inner(&mut caller, dst, &args)
        },
    )?;
    linker.func_wrap(
        "env",
        "set_return",
        |mut caller: Caller<'_, Ctx>, ptr: i32, len: i32| -> Result<(), wasmi::Error> {
            let data = read_inner(&mut caller, ptr, len, MAX_RETURN)?;
            caller.data_mut().ret = data;
            Ok(())
        },
    )?;
    linker.func_wrap(
        "env",
        "emit",
        |mut caller: Caller<'_, Ctx>, ptr: i32, len: i32| -> Result<(), wasmi::Error> {
            let event = read_inner(&mut caller, ptr, len, MAX_EVENT)?;
            unsafe { host_emit(event.as_ptr(), event.len() as u32) };
            Ok(())
        },
    )?;
    linker.func_wrap(
        "env",
        "abort",
        |mut caller: Caller<'_, Ctx>, ptr: i32, len: i32| -> Result<(), wasmi::Error> {
            let message = read_inner(&mut caller, ptr, len, MAX_EVENT)?;
            caller.data_mut().aborted = Some(message);
            Err(wasmi::Error::new("contract abort"))
        },
    )?;
    linker.func_wrap(
        "env",
        "transfer",
        |mut caller: Caller<'_, Ctx>, to: i32, amount: i64| -> Result<i32, wasmi::Error> {
            let to = read_inner(&mut caller, to, 32, 32)?;
            let status = unsafe { host_transfer(to.as_ptr(), amount as u64) };
            Ok(status as i32)
        },
    )?;
    linker.func_wrap(
        "env",
        "call",
        |mut caller: Caller<'_, Ctx>,
         contract: i32,
         ap: i32,
         al: i32,
         argp: i32,
         argl: i32,
         value: i64|
         -> Result<i32, wasmi::Error> {
            let contract = read_inner(&mut caller, contract, 32, 32)?;
            let action = read_inner(&mut caller, ap, al, MAX_KEY)?;
            let args = read_inner(&mut caller, argp, argl, MAX_VALUE)?;
            let fuel_before = caller.get_fuel().unwrap_or(0);
            let outcome = unsafe {
                host_call(
                    contract.as_ptr(),
                    action.as_ptr(),
                    action.len() as u32,
                    args.as_ptr(),
                    args.len() as u32,
                    value as u64,
                    fuel_before,
                )
            };
            if outcome >= 0 {
                // outcome = fuel used by the sub-call; charge it here.
                let used = (outcome as u64).min(fuel_before);
                caller.set_fuel(fuel_before - used).ok();
                Ok(0)
            } else {
                Ok((-outcome) as i32)
            }
        },
    )?;
    Ok(())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn execute(
    code_ptr: *const u8,
    code_len: u32,
    action_ptr: *const u8,
    action_len: u32,
    args_ptr: *const u8,
    args_len: u32,
    caller_ptr: *const u8,
    value: u64,
    height: u64,
    fuel: u64,
) -> u32 {
    let code = unsafe { core::slice::from_raw_parts(code_ptr, code_len as usize) };
    let action = unsafe { core::slice::from_raw_parts(action_ptr, action_len as usize) };
    let args = unsafe { core::slice::from_raw_parts(args_ptr, args_len as usize) }.to_vec();
    let mut caller_addr = [0u8; 32];
    caller_addr.copy_from_slice(unsafe { core::slice::from_raw_parts(caller_ptr, 32) });

    let Ok(action) = core::str::from_utf8(action) else {
        set_output(Vec::new(), b"invalid action name".to_vec(), 0);
        return EXEC_NO_ACTION;
    };

    let mut config = Config::default();
    config.consume_fuel(true);
    let engine = Engine::new(&config);

    let Ok(module) = Module::new(&engine, code) else {
        set_output(Vec::new(), b"invalid module".to_vec(), 0);
        return EXEC_INVALID_MODULE;
    };

    let ctx = Ctx {
        caller: caller_addr,
        value,
        height,
        args,
        ret: Vec::new(),
        aborted: None,
        last_get_len: -1,
        limits: StoreLimitsBuilder::new().memory_size(MEMORY_LIMIT).build(),
    };
    let mut store = Store::new(&engine, ctx);
    store.limiter(|ctx| &mut ctx.limits);
    if store.set_fuel(fuel).is_err() {
        set_output(Vec::new(), b"fuel not enabled".to_vec(), 0);
        return EXEC_TRAP;
    }

    let mut linker = Linker::new(&engine);
    if link_env(&mut linker).is_err() {
        set_output(Vec::new(), b"linker setup failed".to_vec(), 0);
        return EXEC_TRAP;
    }

    let fuel_spent = |store: &Store<Ctx>| fuel.saturating_sub(store.get_fuel().unwrap_or(0));

    let instance = match linker.instantiate_and_start(&mut store, &module) {
        Ok(instance) => instance,
        Err(err) => {
            let out_of_fuel = is_out_of_fuel(&err);
            set_output(
                Vec::new(),
                format_err("instantiate", &err),
                fuel_spent(&store),
            );
            return if out_of_fuel {
                EXEC_OUT_OF_FUEL
            } else {
                EXEC_INVALID_MODULE
            };
        }
    };

    let Ok(func) = instance.get_typed_func::<(), i32>(&mut store, action) else {
        set_output(Vec::new(), b"unknown action".to_vec(), fuel_spent(&store));
        return EXEC_NO_ACTION;
    };

    match func.call(&mut store, ()) {
        Ok(0) => {
            let ret = core::mem::take(&mut store.data_mut().ret);
            set_output(ret, Vec::new(), fuel_spent(&store));
            EXEC_OK
        }
        Ok(code) => {
            let mut err = b"action failed with code ".to_vec();
            err.extend_from_slice(code.to_string().as_bytes());
            set_output(Vec::new(), err, fuel_spent(&store));
            EXEC_ACTION_FAILED
        }
        Err(err) => {
            let spent = fuel_spent(&store);
            if let Some(message) = store.data_mut().aborted.take() {
                set_output(Vec::new(), message, spent);
                return EXEC_ABORTED;
            }
            if is_out_of_fuel(&err) {
                set_output(Vec::new(), b"out of fuel".to_vec(), spent);
                return EXEC_OUT_OF_FUEL;
            }
            set_output(Vec::new(), format_err("trap", &err), spent);
            EXEC_TRAP
        }
    }
}

fn is_out_of_fuel(err: &wasmi::Error) -> bool {
    matches!(err.as_trap_code(), Some(wasmi::TrapCode::OutOfFuel))
}

fn format_err(stage: &str, err: &wasmi::Error) -> Vec<u8> {
    let mut s = format!("{stage}: {err}");
    s.truncate(512);
    s.into_bytes()
}
