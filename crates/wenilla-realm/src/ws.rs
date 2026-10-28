//! Authenticated, fixed-destination, account-bound Vanilla relay.
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{routing::get, Router};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::{accounts, handshake::Guard, session::Session, AppState};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/ws/{port}", get(upgrade))
        .route_layer(middleware::from_fn(origin))
}

// Run before the upgrade extractor: even malformed upgrades must pass the same origin gate.
async fn origin(req: Request, next: Next) -> Response {
    // The handler checks Origin with application state before accepting the upgrade.
    let port = req
        .uri()
        .path()
        .strip_prefix("/ws/")
        .and_then(|p| p.parse::<u16>().ok());
    if !matches!(port, Some(3724 | 8085)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

async fn upgrade(
    State(state): State<Arc<AppState>>,
    session: Session,
    Path(port): Path<u16>,
    headers: axum::http::HeaderMap,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let origin = headers.get_all(header::ORIGIN).iter().collect::<Vec<_>>();
    if origin.len() != 1 || origin[0].to_str().ok() != Some(state.cfg.public_url.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    let account = match accounts::get(&state.db, session.user.id).await {
        Ok(Some(account)) => account.game_username,
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    if !state
        .limiter
        .allow(&format!("ws:{}", session.user.id), 20, 60)
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let upstream = if port == 3724 {
        state.cfg.realmd_host.clone()
    } else {
        state.cfg.mangosd_host.clone()
    };
    ws.max_message_size(65536)
        .on_upgrade(move |socket| async move {
            if let Err(error) = relay(socket, &upstream, port, &account).await {
                tracing::warn!(%error, port, "account-bound relay ended");
            }
        })
}

async fn relay(ws: WebSocket, upstream: &str, port: u16, account: &str) -> anyhow::Result<()> {
    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect((upstream, port)),
    )
    .await??;
    tcp.set_nodelay(true)?;
    let (mut reader, mut writer) = tcp.into_split();
    let (mut tx, mut rx) = ws.split();
    let to_browser = async {
        let mut buf = [0; 65536];
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            tx.send(Message::binary(buf[..n].to_vec())).await?;
        }
        Ok::<_, anyhow::Error>(())
    };
    let to_core = async {
        let mut guard = Guard::new(port, account);
        loop {
            let message =
                tokio::time::timeout(std::time::Duration::from_secs(120), rx.next()).await?;
            match message {
                Some(Ok(Message::Binary(bytes))) => {
                    let verified = guard.push(&bytes).map_err(anyhow::Error::msg)?;
                    if !verified.is_empty() {
                        writer.write_all(&verified).await?;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => break,
                _ => anyhow::bail!("binary game packets required"),
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    // Terminate both directions on rejection/EOF; an idle upstream must not keep a rejected
    // identity's socket alive. Dropping the socket/TCP halves closes both transports.
    tokio::select! { r = to_browser => r, r = to_core => r }
}
