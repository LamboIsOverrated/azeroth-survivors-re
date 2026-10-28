//! Headless verification of the actual app login sequencer and its real SRP/wire fixture.
//! Run: cargo test --manifest-path crates/benilla-app/tests/io-fixture/Cargo.toml
#![allow(dead_code, unused_imports)]
extern crate self as benilla_assets;
extern crate self as bevy;

pub mod log {
    pub use tracing::{debug, error, info, warn};
}
pub mod trace {
    pub fn enabled() -> bool {
        false
    }
    pub fn line(_: &str, _: &str) {}
}
pub trait LockRecover<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T>;
}
impl<T> LockRecover<T> for std::sync::Mutex<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap()
    }
}

#[cfg(test)]
mod net {
    include!(concat!(env!("OUT_DIR"), "/actual_io.rs"));
}

// Exercise the exact dependency-free browser policies in the existing headless CI gate.
#[cfg(test)]
#[path = "../../../src/player/browser_entry_state.rs"]
mod browser_entry_state;
#[cfg(test)]
#[path = "../../../src/player/browser_movement_clock.rs"]
mod browser_movement_clock;
