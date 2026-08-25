fn main() {
    // Sidecars are named `<binary>-<target-triple>` by the Tauri bundler; the
    // runtime resolver needs the same triple to find them in a dev checkout.
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=SHIFT_TARGET_TRIPLE={triple}");
    tauri_build::build()
}
