#![no_std]
#![no_main]

use esp_backtrace as _;
use esp_hal::{
    clock::ClockControl,
    delay::Delay,
    gpio::{Io, Level, Output},
    peripherals::Peripherals,
    prelude::*,
    system::SystemControl,
};

/// Entry point for the bare-metal ESP32 firmware.
///
/// This template demonstrates:
/// - Clock initialization
/// - GPIO output control
/// - Simple delay loop
///
/// Compile for ESP32-S3: cargo build --target xtensa-esp32s3-espidf
/// Compile for ESP32-C3: cargo build --target riscv32imc-esp-espidf
#[entry]
fn main() -> ! {
    // Take ownership of chip peripherals
    let peripherals = Peripherals::take();
    let system = SystemControl::new(peripherals.SYSTEM);

    // Initialize clocks at maximum frequency
    let clocks = ClockControl::max(system.clock_control).freeze();
    let delay = Delay::new(&clocks);

    // Initialize I/O pins
    let io = Io::new(peripherals.GPIO, peripherals.IO_MUX);

    // Configure GPIO 2 as output (LED on most dev boards)
    let mut led = Output::new(io.pins.gpio2, Level::Low);

    esp_println::println!("ESP Forge: Bare-metal firmware starting!");
    esp_println::println!("Chip: ESP32-S3");

    let mut counter: u32 = 0;

    loop {
        // Blink LED
        led.set_high();
        delay.delay_millis(500u32);
        led.set_low();
        delay.delay_millis(500u32);

        counter = counter.wrapping_add(1);
        esp_println::println!("Loop count: {}", counter);
    }
}
