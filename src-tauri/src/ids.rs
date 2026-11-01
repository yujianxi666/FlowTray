//! Identifier + time helpers.

use rand::RngCore;

pub fn create_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut random = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut random);
    let random_hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{prefix}{millis:09}{random_hex}")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
