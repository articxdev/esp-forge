use esp_idf_svc::sys::EspError;

/// ESP-IDF std firmware template
///
/// This template uses the ESP-IDF framework with full Rust std support.
/// ESP-IDF is downloaded and managed automatically by the esp-idf-sys build crate.
///
/// Features demonstrated:
/// - ESP-IDF initialization and logger setup
/// - std threads for concurrent tasks
/// - Graceful error handling with ? operator
///
/// Build for ESP32-S3: cargo build --target xtensa-esp32s3-espidf
/// Build for ESP32-C3: cargo build --target riscv32imc-esp-espidf
fn main() -> Result<(), EspError> {
    // Required: link IDF patches and initialize std adapter
    esp_idf_svc::sys::link_patches();

    // Initialize the ESP-IDF logger (outputs to UART0 / serial monitor)
    esp_idf_svc::log::EspLogger::initialize_default();

    log::info!("ESP Forge: ESP-IDF std firmware starting!");
    log::info!("IDF version: {}", esp_idf_svc::sys::esp_idf_version_str().to_str().unwrap_or("unknown"));

    // Spawn a background thread for periodic work
    std::thread::spawn(|| {
        let mut counter = 0u32;
        loop {
            log::info!("[background] Heartbeat: {}", counter);
            counter = counter.wrapping_add(1);
            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
    });

    // Main loop
    let mut tick = 0u32;
    loop {
        log::info!("[main] Running... tick={}", tick);
        tick = tick.wrapping_add(1);
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
}
