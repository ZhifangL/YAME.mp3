fn main() {
    // The engine binary carries a Rust target-triple suffix so the same source
    // tree can produce macOS, Windows and Linux bundles, and it is *embedded*
    // into the executable when a real one is present — that is what lets the
    // portable build ship as a single file.
    //
    // The file is optional: with nothing staged the crate still compiles,
    // `sidecar_path()` falls through to its other two locations, and no engine
    // is embedded. The cfg is therefore set only for a *non-empty* file, so the
    // zero-byte stub `scripts/placeholder-sidecar.mjs` leaves behind can never
    // be baked in and fail at runtime instead of at compile time.
    let target = std::env::var("TARGET").expect("cargo always sets TARGET for build scripts");
    let suffix = if target.contains("windows") { ".exe" } else { "" };
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("cargo always sets CARGO_MANIFEST_DIR for build scripts");
    let sidecar = std::path::PathBuf::from(&manifest_dir)
        .join("binaries")
        .join(format!("yame-engine-{target}{suffix}"));

    println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    println!("cargo:rerun-if-changed={}", sidecar.display());
    println!("cargo:rustc-check-cfg=cfg(embed_sidecar)");
    // Absolute on purpose: `include_bytes!` resolves a relative path against the
    // *source file's* directory, not the crate root, so a relative one here
    // would be searched for under `src/`.
    println!("cargo:rustc-env=YAME_SIDECAR_PATH={}", sidecar.display());

    if std::fs::metadata(&sidecar).map(|meta| meta.len() > 0).unwrap_or(false) {
        println!("cargo:rustc-cfg=embed_sidecar");
    }

    tauri_build::build()
}
