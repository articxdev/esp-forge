#![no_std]
#![no_main]

use esp_backtrace as _;

/// Minimal no_std ESP32 firmware template
///
/// This is the absolute minimum boilerplate to get something running on
/// an ESP32 chip with Rust. No HAL layer, no RTOS, just raw hardware.
///
/// Great for learning how embedded Rust works from the ground up.
///
/// Build: cargo build --target xtensa-esp32s3-espidf
#[no_mangle]
extern "C" fn app_main() {
    esp_println::println!("ESP Forge: Minimal no_std firmware!");
    esp_println::println!("Running on bare metal.");

    let mut counter: u32 = 0;

    loop {
        esp_println::println!("Iteration: {}", counter);
        counter = counter.wrapping_add(1);

        // Busy-wait loop (no HAL timer available in minimal setup)
        for _ in 0..10_000_000u32 {
            core::hint::spin_loop();
        }
    }
}
