//! qpdf is C++. On Android it links the NDK's static libc++ (`CXXSTDLIB_*=c++_static`, set in
//! .cargo/config.toml) so the app ships one .so; the static libc++ needs libc++abi as well.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=static=c++abi");
    }
}
