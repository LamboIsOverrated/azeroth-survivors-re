//! JSON for the play page. Same-origin only: mutations (none yet) would require the
//! `X-Requested-With: wenilla` header; reads are gated by the session like everything else.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::session::Session;
use crate::{accounts, AppError, AppState};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/play", get(play))
        .route("/api/me", get(me))
        .route("/api/identity", get(identity))
        .route("/api/character-balances", get(character_balances))
}

fn no_store(body: serde_json::Value) -> Response {
    let mut response = Json(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn identity(session: Session) -> Response {
    use sha2::{Digest, Sha256};
    // A stable, opaque binding for short-lived wallet orders. Cookie rotation preserves
    // the nonce; logout/password replacement changes it. Never return either raw secret.
    let binding = hex::encode(Sha256::digest(
        format!("realm-wallet-session:{}:{}", session.id, session.csrf_token).as_bytes(),
    ));
    no_store(
        serde_json::json!({"id": session.user.id, "username": session.user.username, "isAdmin": session.user.is_admin(), "sessionId": binding}),
    )
}

async fn character_balances(
    session: Session,
    State(state): State<Arc<AppState>>,
) -> Result<Response, AppError> {
    let characters = match accounts::get(&state.db, session.user.id).await? {
        Some(account) => {
            crate::realmdb::character_balances(&state.realmdb, &account.game_username).await?
        }
        None => Vec::new(),
    };
    Ok(no_store(
        serde_json::json!({"characters": characters, "snapshot": "last-saved", "nonredeemable": true}),
    ))
}

async fn play(session: Session, State(state): State<Arc<AppState>>) -> Result<Response, AppError> {
    if !state.limiter.allow(&format!("play:{}", session.id), 30, 60) {
        return Err(AppError::TooMany);
    }
    let acct = match accounts::get(&state.db, session.user.id).await? {
        Some(a) => a,
        None => {
            accounts::provision(&state.db, &state.soap, &state.secrets, session.user.id).await?
        }
    };
    let pass = accounts::password(&state.secrets, &acct)?;
    let mut body = serde_json::json!({
        "user": acct.game_username,
        "pass": pass,
        "host": state.cfg.public_host(),
        "realm": state.realm_name().await,
        "transport_profile": state.cfg.transport_profile,
    });
    // A dungeon-preset character: the client skips the login and character screens into it.
    if let Some(name) = crate::presets::character_of(&state.db, session.user.id).await? {
        body["char"] = serde_json::Value::String(name);
    }
    if state.cfg.dev_query_creds {
        body["dev_query_creds"] = serde_json::Value::String("1".into());
    }
    let mut resp = (StatusCode::OK, Json(body)).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

async fn me(session: Session) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({ "username": session.user.username, "display_name": session.user.display_name, "role": session.user.role }),
    )
}
