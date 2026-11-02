#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Reply-target parsing parity.

use zyquor_core::parse_reply_target_url;

#[test]
fn parses_canonical_x_status_urls() {
    let target = parse_reply_target_url("https://x.com/someone/status/1234567890").unwrap();
    assert_eq!(target.tweet_id, "1234567890");
    assert_eq!(target.author_handle, "someone");
    assert_eq!(target.url, "https://x.com/someone/status/1234567890");
}

#[test]
fn accepts_twitter_com_and_trailing_slash() {
    let target = parse_reply_target_url("https://twitter.com/a_b1/status/42/").unwrap();
    assert_eq!(target.author_handle, "a_b1");
    assert_eq!(target.tweet_id, "42");
}

#[test]
fn rejects_non_status_and_non_https_urls() {
    assert!(parse_reply_target_url("http://x.com/someone/status/1").is_none());
    assert!(parse_reply_target_url("https://example.com/someone/status/1").is_none());
    assert!(parse_reply_target_url("https://x.com/someone").is_none());
    assert!(parse_reply_target_url("not a url").is_none());
}

#[test]
fn rejects_credentials_and_non_default_ports() {
    assert!(parse_reply_target_url("https://user:pass@x.com/someone/status/1").is_none());
    assert!(parse_reply_target_url("https://x.com:8443/someone/status/1").is_none());

    // The WHATWG URL parser drops a default port, so `:443` is indistinguishable
    // from no port. The TypeScript implementation behaves the same way.
    assert!(parse_reply_target_url("https://x.com:443/someone/status/1").is_some());
}

#[test]
fn rejects_bad_handles_and_non_numeric_ids() {
    assert!(parse_reply_target_url("https://x.com/handle-that-is-way-too-long/status/1").is_none());
    assert!(parse_reply_target_url("https://x.com/someone/status/abc").is_none());
}
