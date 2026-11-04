//! Prints `perProfileCdpUrl` results for the parity script.
//!
//! Run: `cargo run -p zyquor-core --example cdp_parity`

use zyquor_core::paths::per_profile_cdp_url;

fn main() {
    let base = "http://127.0.0.1:9223";
    let profiles = [
        "profiles/personal-main",
        "profiles/another-account",
        "profiles/third-account",
        "profiles/willainotice",
        "profiles/Reply-Loop-Test",
        "C:\\Users\\example\\zyquor-profiles\\Reply-Loop-Test",
        "profiles/skywalker",
        "profiles/acct-0",
        "profiles/acct-1",
        "profiles/acct-2",
        "/home/user/zyquor/profiles/Some_Account",
    ];

    for profile in profiles {
        println!("{profile}|{}", per_profile_cdp_url(Some(base), profile));
    }
}
