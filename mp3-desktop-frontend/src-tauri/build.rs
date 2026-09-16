fn main() {
    // The sidecar binary carries a Rust target-triple suffix so the same
    // source tree can produce macOS, Windows and Linux bundles.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo always sets TARGET for build scripts")
    );
    tauri_build::build()
}
