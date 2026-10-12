//! End-to-end: manual match id → broadcast url → SSE rows → LiveState events, against a mock API.

use std::time::Duration;

use deadlock_live::{Command, Config, EngineEvent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

async fn mock_api(spectate_down: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                if path == "/v1/matches/live/urls" && spectate_down {
                    let body = r#"[{"match_id":1,"broadcast_url":"http://tv.example/1"},{"match_id":777,"broadcast_url":"http://tv.example/777"}]"#;
                    let resp = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body);
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if path.starts_with("/v1/matches/777/live/url") && spectate_down {
                    let body = r#"{"status":503,"error":"Failed to fetch data from Steam."}"#;
                    let resp = format!("HTTP/1.1 503 Service Unavailable\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body);
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if path.starts_with("/v1/matches/777/live/url") {
                    let body = r#"{"broadcast_url":"http://tv.example/777"}"#;
                    let resp = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body);
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if path.starts_with("/v1/matches/demo/live/query") {
                    assert!(
                        path.contains("broadcast_url=http%3A%2F%2Ftv.example%2F777"),
                        "{path}"
                    );
                    let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").await;
                    // route by the table each default query selects from
                    let rows: Vec<&str> = if path.contains("CCitadelPlayerController") {
                        vec![
                            r#"data: {"account_id":76561198012345678,"slot":0,"team":2,"hero_id":6,"net_worth":5000,"souls":700,"kills":1,"deaths":0,"assists":2,"level":5}"#,
                            r#"data: [{"account_id":76561197960266729,"slot":1,"team":3,"hero_id":13,"net_worth":7000},{"account_id":76561197960266730,"slot":2,"team":3,"hero_id":25,"net_worth":4000}]"#,
                            r#"data: {"account_id":76561198012345678,"slot":0,"net_worth":6200}"#,
                        ]
                    } else if path.contains("CCitadelGameRulesProxy") {
                        vec![r#"data: {"tick":1,"game_time_s":420.0}"#]
                    } else if path.contains("ItemPurchaseNotificationEvent") {
                        vec![
                            r#"data: {"tick":5,"purchase_slot":0,"item_id":1001,"sold":false}"#,
                            r#"data: {"tick":6,"purchase_slot":1,"item_id":2002,"sold":false}"#,
                        ]
                    } else if path.contains("ObjectiveMaskEvent") {
                        vec![r#"data: {"tick":7,"obj_mask_0":65535,"obj_mask_1":65531}"#]
                    } else if path.contains("GameOverEvent") {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        vec![r#"data: {"tick":9,"winning_team":2}"#]
                    } else {
                        panic!("unexpected query {path}")
                    };
                    for r in rows {
                        let _ = sock.write_all(format!("{r}\n\n").as_bytes()).await;
                        tokio::time::sleep(Duration::from_millis(30)).await;
                    }
                    let _ = sock.write_all(b"event: end\ndata: done\n\n").await;
                } else if path.starts_with("/v1/matches/active") {
                    let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n[]").await;
                } else {
                    let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
                }
            });
        }
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn manual_match_streams_live_state() {
    run_case(false).await;
}

/// Spectate returns 503 (as seen in the wild) but the match is in the public live-URL list.
#[tokio::test]
async fn falls_back_to_public_live_url_list() {
    run_case(true).await;
}

async fn run_case(spectate_down: bool) {
    let base = mock_api(spectate_down).await;
    let cfg = Config {
        api_base: base,
        account_id: Some(52_079_950),
        process_names: vec!["definitely-not-running.exe".into()],
        console_log: Some(std::env::temp_dir().join("no-such-console.log")),
        live: deadlock_live::config::LiveQuery {
            emit_every_ms: 0,
            ..Default::default()
        },
        ..Default::default()
    };
    let (ev_tx, mut ev_rx) = mpsc::channel(64);
    let (cmd_tx, cmd_rx) = mpsc::channel(4);
    let engine = tokio::spawn(deadlock_live::run(cfg, ev_tx, cmd_rx));
    cmd_tx.send(Command::SetMatch(777)).await.unwrap();

    let mut last_state = None;
    let mut saw_connected = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let ev = tokio::time::timeout_at(deadline, ev_rx.recv())
            .await
            .expect("timed out")
            .expect("engine stopped");
        match ev {
            EngineEvent::LiveConnected { match_id } => {
                assert_eq!(match_id, 777);
                saw_connected = true;
            }
            EngineEvent::LiveState(s) => last_state = Some(s),
            EngineEvent::LiveEnded { match_id } => {
                assert_eq!(match_id, 777);
                break;
            }
            EngineEvent::Error { message } => panic!("engine error: {message}"),
            EngineEvent::Status { message } => assert!(
                !message.contains("503"),
                "listing should win before spectate: {message}"
            ),
            _ => {}
        }
    }
    cmd_tx.send(Command::Shutdown).await.unwrap();
    engine.await.unwrap();

    assert!(saw_connected);
    let s = last_state.expect("no live state");
    assert_eq!(s.match_id, Some(777));
    assert_eq!(s.my_account_id, 52_079_950);
    assert_eq!(s.players.len(), 3);
    let me = s
        .players
        .iter()
        .find(|p| p.account_id == 52_079_950)
        .unwrap();
    assert_eq!(
        (me.team, me.hero_id, me.net_worth, me.souls),
        (0, 6, 6200, Some(700))
    );
    assert_eq!(me.item_ids, vec![1001]);
    let enemy = s.players.iter().find(|p| p.account_id == 1001).unwrap();
    assert_eq!((enemy.team, enemy.item_ids.clone()), (1, vec![2002]));
    assert_eq!(s.game_time_s, 420.0);
    assert_eq!(s.winning_team, Some(0));
    assert_eq!(s.objective_masks, Some([65535, 65531]));
    // JSON shape matches packages/core LiveState
    let j = serde_json::to_value(&s).unwrap();
    assert!(j.get("myAccountId").is_some() && j["players"][0].get("netWorth").is_some());
}
