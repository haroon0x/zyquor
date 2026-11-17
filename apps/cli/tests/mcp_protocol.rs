//! Protocol tests for `zyquor mcp` (the agent-native MCP stdio server).
//!
//! These spawn the real binary and speak newline-delimited JSON-RPC, so the
//! framing, capability negotiation, safety-tier tool exposure and graceful
//! API-unreachable error path stay covered without needing a running app.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use serde_json::{Value, json};

struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl Server {
    fn start(args: &[&str], env: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_zyquor"));
        command
            .arg("mcp")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("spawn zyquor mcp");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => return,
                }
            }
        });
        Server {
            child,
            stdin,
            lines: rx,
        }
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write request");
        self.stdin.flush().expect("flush request");
    }

    fn recv(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(10))
            .expect("server should answer within 10s");
        serde_json::from_str(&line).expect("valid JSON response")
    }

    fn initialize(&mut self) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" }
            }
        }));
        let response = self.recv();
        assert_eq!(response["result"]["serverInfo"]["name"], "zyquor");
    }

    fn shutdown(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

fn tool_names(server: &mut Server) -> Vec<String> {
    server.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    let response = server.recv();
    response["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn initializes_and_lists_the_safe_tools_by_default() {
    let mut server = Server::start(&[], &[("ZYQUOR_API_URL", "http://127.0.0.1:9")]);
    server.initialize();

    // Notifications never get a response: the next reply must belong to ping.
    server.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    server.send(json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }));
    let pong = server.recv();
    assert_eq!(pong["id"], 7);
    assert_eq!(pong["result"], json!({}));

    let names = tool_names(&mut server);
    for expected in [
        "status",
        "list_accounts",
        "list_jobs",
        "create_draft",
        "generate_draft",
        "select_candidate",
        "approve_draft",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "missing tool {expected} in {names:?}"
        );
    }
    // Posting-adjacent tools stay hidden unless the server is explicitly opened.
    assert!(!names.iter().any(|name| name == "prepare_job"), "{names:?}");
    assert!(!names.iter().any(|name| name == "post_job"), "{names:?}");

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 8,
        "method": "resources/read",
        "params": { "uri": "zyquor://guide" }
    }));
    let guide = server.recv();
    let text = guide["result"]["contents"][0]["text"]
        .as_str()
        .expect("guide text");
    assert!(
        text.contains("Zyquor"),
        "guide should carry the operating skill"
    );

    server.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "not-a-method" }));
    let error = server.recv();
    assert_eq!(error["error"]["code"], -32601);
    server.shutdown();
}

#[test]
fn exposes_browser_and_post_tools_only_when_allowed() {
    let mut server = Server::start(
        &["--allow-browser", "--allow-post"],
        &[("ZYQUOR_API_URL", "http://127.0.0.1:9")],
    );
    server.initialize();
    let names = tool_names(&mut server);
    assert!(names.iter().any(|name| name == "prepare_job"), "{names:?}");
    assert!(names.iter().any(|name| name == "post_job"), "{names:?}");

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/list"
    }));
    let tools = server.recv()["result"]["tools"].clone();
    let post = tools
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "post_job")
        .expect("post_job");
    assert_eq!(post["annotations"]["destructiveHint"], true);
    server.shutdown();
}

#[test]
fn unreachable_api_is_a_graceful_tool_error() {
    let mut server = Server::start(&[], &[("ZYQUOR_API_URL", "http://127.0.0.1:9")]);
    server.initialize();
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": { "name": "status", "arguments": {} }
    }));
    let response = server.recv();
    assert_eq!(response["result"]["isError"], true, "{response}");
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("error text");
    assert!(text.contains("127.0.0.1:9"), "{text}");
    assert!(text.contains("API"), "{text}");
    server.shutdown();
}
