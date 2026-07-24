use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn browser_tools_prefer_the_live_inherited_port_over_a_stale_discovery_file() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let impala_dir = home.join(".impala");
    fs::create_dir_all(&impala_dir).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let inherited_port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "inherited hook port was not contacted"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("failed to accept inherited hook connection: {error}"),
            }
        };
        let mut request = [0_u8; 4096];
        let bytes_read = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..bytes_read]);
        assert!(request.starts_with("GET /browser/page_info?"));

        let body = r#"{"ok":true,"url":"http://localhost:3000","title":"Impala","ready_state":"complete"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });

    let stale_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stale_port = stale_listener.local_addr().unwrap().port();
    drop(stale_listener);
    fs::write(impala_dir.join("hook-port"), stale_port.to_string()).unwrap();

    let data_dir = temp.path().join("data");
    #[cfg(target_os = "macos")]
    let app_data_dir = home
        .join("Library")
        .join("Application Support")
        .join("be.kodeus.impala");
    #[cfg(not(target_os = "macos"))]
    let app_data_dir = data_dir.join("be.kodeus.impala");
    fs::create_dir_all(&app_data_dir).unwrap();
    fs::write(app_data_dir.join("impala.db"), []).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_impala-mcp"))
        .env("HOME", &home)
        .env("XDG_DATA_HOME", &data_dir)
        .env("IMPALA_HOOK_PORT", inherited_port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    writeln!(
        child.stdin.as_mut().unwrap(),
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "browser_page_info",
                "arguments": {
                    "worktree_path": "/worktree"
                }
            }
        })
    )
    .unwrap();

    let mut response = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut response)
        .unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();

    child.kill().unwrap();
    child.wait().unwrap();
    server.join().unwrap();

    assert_eq!(
        response["result"]["content"][0]["text"],
        serde_json::to_string_pretty(&json!({
            "url": "http://localhost:3000",
            "title": "Impala",
            "ready_state": "complete"
        }))
        .unwrap()
    );
    assert_ne!(response["result"]["isError"], true);
}
