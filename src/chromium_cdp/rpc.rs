//! JSON-RPC over Chrome DevTools WebSocket.

use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub(super) type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

static CDP_MSG_ID: AtomicU64 = AtomicU64::new(1);

pub(super) async fn cdp_send_recv(
    write: &mut futures_util::stream::SplitSink<Ws, Message>,
    read: &mut futures_util::stream::SplitStream<Ws>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = CDP_MSG_ID.fetch_add(1, Ordering::Relaxed);
    let cmd = json!({"id": id, "method": method, "params": params});
    write
        .send(Message::Text(cmd.to_string()))
        .await
        .map_err(|e| format!("CDP send: {e}"))?;

    loop {
        let msg = read
            .next()
            .await
            .ok_or_else(|| "CDP: соединение закрыто".to_string())?
            .map_err(|e| format!("CDP read: {e}"))?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(_) => continue,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => return Err("CDP: Close".into()),
            Message::Frame(_) => continue,
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("CDP JSON: {e}"))?;
        if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
            continue;
        }
        if let Some(err) = v.get("error") {
            return Err(format!("CDP {method}: {}", err));
        }
        return v
            .get("result")
            .cloned()
            .ok_or_else(|| format!("CDP {method}: нет result"));
    }
}
