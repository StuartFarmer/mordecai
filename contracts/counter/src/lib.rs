//! Test contract: exercises storage, args, returns, events, value,
//! aborts, payouts, and runaway loops (fuel).

use mordecai_contract as c;

#[unsafe(no_mangle)]
pub extern "C" fn increment() -> i32 {
    let next = c::storage_get_u64(b"count").unwrap_or(0) + 1;
    c::storage_set_u64(b"count", next);
    c::set_return(&next.to_le_bytes());
    c::emit(format!("count={next}").as_bytes());
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn add() -> i32 {
    let mut args = c::ArgReader::new();
    let amount = args.u64();
    let next = c::storage_get_u64(b"count").unwrap_or(0) + amount;
    c::storage_set_u64(b"count", next);
    c::set_return(&next.to_le_bytes());
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn whoami() -> i32 {
    c::set_return(&c::caller());
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn deposit() -> i32 {
    let total = c::storage_get_u64(b"deposits").unwrap_or(0) + c::attached_value();
    c::storage_set_u64(b"deposits", total);
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn refund() -> i32 {
    let amount = c::attached_value();
    if !c::transfer(&c::caller(), amount) {
        c::fail("refund failed");
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn boom() -> i32 {
    // Writes first, then aborts — the write must revert.
    c::storage_set_u64(b"count", 999_999);
    c::fail("boom: deliberate abort")
}

#[unsafe(no_mangle)]
pub extern "C" fn bad_code() -> i32 {
    7
}

#[unsafe(no_mangle)]
pub extern "C" fn spin() -> i32 {
    let mut n: u64 = 0;
    loop {
        n = n.wrapping_add(1);
        core::hint::black_box(n);
    }
}
