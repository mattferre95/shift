fn main() {
    // Sidecars are named `<binary>-<target-triple>` by the Tauri bundler; the
    // runtime resolver needs the same triple to find them in a dev checkout.
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=SHIFT_TARGET_TRIPLE={triple}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("src/media/pdf_native.m").flag("-fobjc-arc").compile("shift_pdf_native");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=PDFKit");
    }
    tauri_build::build()
}
