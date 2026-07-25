//! Contract-side bindings for the Mordecai contract ABI.
//!
//! Contracts compile to wasm32-unknown-unknown, export one
//! `extern "C" fn <action>() -> i32` per action (0 = success), and talk to
//! the chain exclusively through these imports. The same ABI is the target
//! for the Pythonic DSL later — nothing here is Rust-specific on the wire.

mod abi {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        pub fn storage_get(key_ptr: *const u8, key_len: i32) -> i64;
        pub fn storage_read(dst_ptr: *mut u8);
        pub fn storage_set(key_ptr: *const u8, key_len: i32, val_ptr: *const u8, val_len: i32);
        pub fn storage_del(key_ptr: *const u8, key_len: i32);
        pub fn caller_addr(dst_ptr: *mut u8);
        pub fn attached_value() -> i64;
        pub fn block_height() -> i64;
        pub fn block_time_ms() -> i64;
        pub fn arg_len() -> i32;
        pub fn arg_read(dst_ptr: *mut u8);
        pub fn set_return(ptr: *const u8, len: i32);
        pub fn emit(ptr: *const u8, len: i32);
        pub fn abort(ptr: *const u8, len: i32);
        pub fn transfer(to_ptr: *const u8, amount: i64) -> i32;
        pub fn call(
            contract_ptr: *const u8,
            action_ptr: *const u8,
            action_len: i32,
            args_ptr: *const u8,
            args_len: i32,
            value: i64,
        ) -> i32;
    }
}

pub fn storage_get(key: &[u8]) -> Option<Vec<u8>> {
    let len = unsafe { abi::storage_get(key.as_ptr(), key.len() as i32) };
    if len < 0 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    unsafe { abi::storage_read(buf.as_mut_ptr()) };
    Some(buf)
}

pub fn storage_set(key: &[u8], value: &[u8]) {
    unsafe { abi::storage_set(key.as_ptr(), key.len() as i32, value.as_ptr(), value.len() as i32) }
}

pub fn storage_del(key: &[u8]) {
    unsafe { abi::storage_del(key.as_ptr(), key.len() as i32) }
}

/// The transaction sender, or the calling contract id for sub-calls.
pub fn caller() -> [u8; 32] {
    let mut addr = [0u8; 32];
    unsafe { abi::caller_addr(addr.as_mut_ptr()) };
    addr
}

/// Native currency units attached to this call (already credited to the
/// contract's account before the action runs).
pub fn attached_value() -> u64 {
    (unsafe { abi::attached_value() }) as u64
}

/// Height of the block containing this transaction.
pub fn block_height() -> u64 {
    (unsafe { abi::block_height() }) as u64
}

/// Timestamp (ms since epoch) of the block containing this transaction.
pub fn block_time_ms() -> u64 {
    (unsafe { abi::block_time_ms() }) as u64
}

pub fn args() -> Vec<u8> {
    let len = unsafe { abi::arg_len() };
    let mut buf = vec![0u8; len as usize];
    if len > 0 {
        unsafe { abi::arg_read(buf.as_mut_ptr()) };
    }
    buf
}

pub fn set_return(data: &[u8]) {
    unsafe { abi::set_return(data.as_ptr(), data.len() as i32) }
}

pub fn emit(event: &[u8]) {
    unsafe { abi::emit(event.as_ptr(), event.len() as i32) }
}

/// Abort the action with a message; all state effects revert.
pub fn fail(message: &str) -> ! {
    unsafe { abi::abort(message.as_ptr(), message.len() as i32) };
    unreachable!()
}

/// Pay out from the contract's own balance. False = insufficient funds.
#[must_use]
pub fn transfer(to: &[u8; 32], amount: u64) -> bool {
    (unsafe { abi::transfer(to.as_ptr(), amount as i64) }) == 0
}

/// Cross-contract message (spec §12). Returns the callee's status (0 = ok).
pub fn call_contract(contract: &[u8; 32], action: &str, args: &[u8], value: u64) -> i32 {
    unsafe {
        abi::call(
            contract.as_ptr(),
            action.as_ptr(),
            action.len() as i32,
            args.as_ptr(),
            args.len() as i32,
            value as i64,
        )
    }
}

// ------------------------------------------------------- small conveniences

pub fn storage_get_u64(key: &[u8]) -> Option<u64> {
    storage_get(key).map(|v| {
        let mut b = [0u8; 8];
        b.copy_from_slice(&v[..8]);
        u64::from_le_bytes(b)
    })
}

pub fn storage_set_u64(key: &[u8], value: u64) {
    storage_set(key, &value.to_le_bytes());
}

/// Args cursor for the length-prefixed argument encoding used by the SDK
/// (little-endian u32 length + bytes, u64 as 8 LE bytes).
pub struct ArgReader {
    data: Vec<u8>,
    offset: usize,
}

impl ArgReader {
    pub fn new() -> Self {
        Self { data: args(), offset: 0 }
    }

    pub fn u64(&mut self) -> u64 {
        if self.offset + 8 > self.data.len() {
            fail("args: u64 out of bounds");
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[self.offset..self.offset + 8]);
        self.offset += 8;
        u64::from_le_bytes(b)
    }

    pub fn bytes(&mut self) -> Vec<u8> {
        if self.offset + 4 > self.data.len() {
            fail("args: length out of bounds");
        }
        let mut l = [0u8; 4];
        l.copy_from_slice(&self.data[self.offset..self.offset + 4]);
        let len = u32::from_le_bytes(l) as usize;
        self.offset += 4;
        if self.offset + len > self.data.len() {
            fail("args: bytes out of bounds");
        }
        let out = self.data[self.offset..self.offset + len].to_vec();
        self.offset += len;
        out
    }

    pub fn address(&mut self) -> [u8; 32] {
        let bytes = self.bytes();
        if bytes.len() != 32 {
            fail("args: expected 32-byte address");
        }
        let mut addr = [0u8; 32];
        addr.copy_from_slice(&bytes);
        addr
    }
}

impl Default for ArgReader {
    fn default() -> Self {
        Self::new()
    }
}
