fn main() {
    tauri_build::build();

    // `screencapturekit` emits these link args from its own build script, but
    // Cargo does not always propagate dependency `rustc-link-arg` values onto
    // the final app binary. Without an LC_RPATH, debug runs fail to resolve
    // `@rpath/libswift_Concurrency.dylib` while bundled release builds can.
    #[cfg(target_os = "macos")]
    add_swift_runtime_rpaths();
}

#[cfg(target_os = "macos")]
fn add_swift_runtime_rpaths() {
    use std::process::Command;

    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    match Command::new("xcode-select").arg("-p").output() {
        Ok(output) if output.status.success() => {
            let xcode_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let swift_lib_path = format!(
                "{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx"
            );
            println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib_path}");
        }
        Ok(output) => {
            println!(
                "cargo:warning=`xcode-select -p` exited non-zero (status={:?}); \
                 Swift Concurrency rpaths were not added. `bun run tauri dev` may fail with \
                 `dyld: Library not loaded: @rpath/libswift_Concurrency.dylib`.",
                output.status.code()
            );
        }
        Err(err) => {
            println!(
                "cargo:warning=`xcode-select` could not be invoked ({err}); \
                 Swift Concurrency rpaths were not added."
            );
        }
    }
}
