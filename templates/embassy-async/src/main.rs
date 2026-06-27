#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};
use esp_hal::{
    clock::ClockControl,
    gpio::{Io, Level, Output},
    peripherals::Peripherals,
    prelude::*,
    system::SystemControl,
    timer::timg::TimerGroup,
};

/// Embassy async firmware for ESP32-S3 / ESP32-C3
///
/// Demonstrates:
/// - Embassy executor setup
/// - Async tasks with embassy-time timers
/// - GPIO control from async context
/// - Multi-task concurrency
///
/// Build: cargo build --target xtensa-esp32s3-espidf
#[esp_hal_embassy::main]
async fn main(spawner: Spawner) {
    // Initialize peripherals
    let peripherals = Peripherals::take();
    let system = SystemControl::new(peripherals.SYSTEM);
    let clocks = ClockControl::max(system.clock_control).freeze();

    // Initialize embassy timer
    let timg0 = TimerGroup::new(peripherals.TIMG0, &clocks);
    esp_hal_embassy::init(&clocks, timg0.timer0);

    let io = Io::new(peripherals.GPIO, peripherals.IO_MUX);
    let led = Output::new(io.pins.gpio2, Level::Low);

    esp_println::println!("ESP Forge: Embassy async firmware starting!");
    esp_println::println!("Spawning tasks...");

    // Spawn background tasks
    spawner.spawn(blink_task(led)).unwrap();
    spawner.spawn(logger_task()).unwrap();

    // Main async loop
    let mut counter = 0u32;
    loop {
        Timer::after(Duration::from_secs(5)).await;
        counter += 1;
        esp_println::println!("[main] Heartbeat #{}", counter);
    }
}

/// Background task: blinks an LED asynchronously
#[embassy_executor::task]
async fn blink_task(mut led: Output<'static, esp_hal::gpio::GpioPin<2>>) {
    let mut state = false;
    loop {
        state = !state;
        if state {
            led.set_high();
        } else {
            led.set_low();
        }
        Timer::after(Duration::from_millis(500)).await;
    }
}

/// Background task: periodic log output
#[embassy_executor::task]
async fn logger_task() {
    let mut tick = 0u32;
    loop {
        Timer::after(Duration::from_millis(2000)).await;
        tick += 1;
        esp_println::println!("[logger] Tick: {}", tick);
    }
}
