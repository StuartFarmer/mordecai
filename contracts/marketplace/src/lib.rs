//! Marketplace contract (spec Phase 4 milestone).
//!
//! Items have an owner, a price, and a for-sale flag. Buying escrows
//! nothing: the buyer attaches the exact price as call value (credited to
//! the contract before the action runs), the contract pays the seller and
//! flips ownership atomically — any failure reverts the whole call,
//! including the attached value.

use mordecai_contract as c;

const NEXT_ID: &[u8] = b"next_id";

struct Item {
    owner: [u8; 32],
    price: u64,
    for_sale: bool,
}

fn item_key(id: u64) -> Vec<u8> {
    let mut key = b"item:".to_vec();
    key.extend_from_slice(&id.to_le_bytes());
    key
}

fn load_item(id: u64) -> Item {
    let Some(raw) = c::storage_get(&item_key(id)) else {
        c::fail("no such item");
    };
    if raw.len() != 41 {
        c::fail("corrupt item record");
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&raw[0..32]);
    let mut price = [0u8; 8];
    price.copy_from_slice(&raw[32..40]);
    Item { owner, price: u64::from_le_bytes(price), for_sale: raw[40] == 1 }
}

fn store_item(id: u64, item: &Item) {
    let mut raw = Vec::with_capacity(41);
    raw.extend_from_slice(&item.owner);
    raw.extend_from_slice(&item.price.to_le_bytes());
    raw.push(if item.for_sale { 1 } else { 0 });
    c::storage_set(&item_key(id), &raw);
}

/// list(price: u64) -> item id (u64 LE)
#[unsafe(no_mangle)]
pub extern "C" fn list() -> i32 {
    let price = c::ArgReader::new().u64();
    if price == 0 {
        c::fail("price must be positive");
    }
    let id = c::storage_get_u64(NEXT_ID).unwrap_or(0);
    c::storage_set_u64(NEXT_ID, id + 1);
    store_item(id, &Item { owner: c::caller(), price, for_sale: true });
    c::set_return(&id.to_le_bytes());
    c::emit(format!("listed:{id}:{price}").as_bytes());
    0
}

/// buy(item_id: u64), attached value must equal the price.
#[unsafe(no_mangle)]
pub extern "C" fn buy() -> i32 {
    let id = c::ArgReader::new().u64();
    let item = load_item(id);
    let buyer = c::caller();
    if !item.for_sale {
        c::fail("item not for sale");
    }
    if buyer == item.owner {
        c::fail("cannot buy your own item");
    }
    if c::attached_value() != item.price {
        c::fail("attached value must equal price");
    }
    if !c::transfer(&item.owner, item.price) {
        c::fail("payout failed");
    }
    store_item(id, &Item { owner: buyer, price: item.price, for_sale: false });
    c::emit(format!("sold:{id}:{}", item.price).as_bytes());
    0
}

/// cancel(item_id: u64) — owner takes the item off sale.
#[unsafe(no_mangle)]
pub extern "C" fn cancel() -> i32 {
    let id = c::ArgReader::new().u64();
    let item = load_item(id);
    if item.owner != c::caller() {
        c::fail("only the owner can cancel");
    }
    store_item(id, &Item { for_sale: false, ..item });
    0
}

/// relist(item_id: u64, price: u64) — owner puts the item back on sale.
#[unsafe(no_mangle)]
pub extern "C" fn relist() -> i32 {
    let mut args = c::ArgReader::new();
    let id = args.u64();
    let price = args.u64();
    if price == 0 {
        c::fail("price must be positive");
    }
    let item = load_item(id);
    if item.owner != c::caller() {
        c::fail("only the owner can relist");
    }
    store_item(id, &Item { owner: item.owner, price, for_sale: true });
    0
}

/// get_item(item_id: u64) -> owner(32) ‖ price(8 LE) ‖ for_sale(1)
#[unsafe(no_mangle)]
pub extern "C" fn get_item() -> i32 {
    let id = c::ArgReader::new().u64();
    let item = load_item(id);
    let mut out = Vec::with_capacity(41);
    out.extend_from_slice(&item.owner);
    out.extend_from_slice(&item.price.to_le_bytes());
    out.push(if item.for_sale { 1 } else { 0 });
    c::set_return(&out);
    0
}
