use wenilla_realm::{db, session};

#[tokio::test]
async fn concurrent_rotation_keeps_inflight_requests_and_only_issues_one_cookie() {
    let dir = tempfile::tempdir().unwrap();
    let pool = db::open_sqlite(&dir.path().join("test.sqlite"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, username, display_name, role, created_at) VALUES (1, 'player', 'Player', 'player', 0)").execute(&pool).await.unwrap();
    let old = session::create(&pool, 1, None, None).await.unwrap();
    sqlx::query("UPDATE sessions SET rotated_at = 0")
        .execute(&pool)
        .await
        .unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let pool = pool.clone();
        let old = old.clone();
        tasks.spawn(async move { session::lookup(&pool, &old).await.unwrap().unwrap() });
    }
    let mut tokens = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Some(token) = result.unwrap().fresh_token {
            tokens.push(token);
        }
    }
    assert_eq!(tokens.len(), 1);
    let new = &tokens[0];
    assert!(session::lookup(&pool, new).await.unwrap().is_some());
    assert!(session::lookup(&pool, &old).await.unwrap().is_some());
    sqlx::query("UPDATE sessions SET previous_valid_until = 0")
        .execute(&pool)
        .await
        .unwrap();
    assert!(session::lookup(&pool, &old).await.unwrap().is_none());
    assert!(session::lookup(&pool, new).await.unwrap().is_some());
    sqlx::query("UPDATE users SET disabled = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert!(session::lookup(&pool, new).await.unwrap().is_none());
}

#[tokio::test]
async fn logout_with_previous_cookie_revokes_rotated_session() {
    let dir = tempfile::tempdir().unwrap();
    let pool = db::open_sqlite(&dir.path().join("test.sqlite"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, username, display_name, role, created_at) VALUES (1, 'player', 'Player', 'player', 0)").execute(&pool).await.unwrap();
    let old = session::create(&pool, 1, None, None).await.unwrap();
    sqlx::query("UPDATE sessions SET rotated_at = 0")
        .execute(&pool)
        .await
        .unwrap();
    let fresh = session::lookup(&pool, &old)
        .await
        .unwrap()
        .unwrap()
        .fresh_token
        .unwrap();
    session::delete_by_token(&pool, &old).await.unwrap();
    assert!(session::lookup(&pool, &fresh).await.unwrap().is_none());
}

#[tokio::test]
async fn socket_session_validation_survives_rotation_and_refuses_revocation() {
    let d = tempfile::tempdir().unwrap();
    let pool = wenilla_realm::db::open_sqlite(&d.path().join("realm.sqlite"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id,username,display_name,role,created_at) VALUES (1,'test','Test','player',0)").execute(&pool).await.unwrap();
    let token = wenilla_realm::session::create(&pool, 1, None, None)
        .await
        .unwrap();
    let session = wenilla_realm::session::lookup(&pool, &token)
        .await
        .unwrap()
        .unwrap();
    assert!(
        wenilla_realm::session::still_valid(&pool, session.id, 1, &session.csrf_token)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE sessions SET rotated_at=0")
        .execute(&pool)
        .await
        .unwrap();
    let rotated = wenilla_realm::session::lookup(&pool, &token)
        .await
        .unwrap()
        .unwrap();
    assert!(rotated.fresh_token.is_some());
    assert!(
        wenilla_realm::session::still_valid(&pool, session.id, 1, &session.csrf_token)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE users SET disabled=1 WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !wenilla_realm::session::still_valid(&pool, session.id, 1, &session.csrf_token)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE users SET disabled=0 WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET expires_at=0")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !wenilla_realm::session::still_valid(&pool, session.id, 1, &session.csrf_token)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE sessions SET expires_at=?")
        .bind(wenilla_realm::db::now() + 600)
        .execute(&pool)
        .await
        .unwrap();
    wenilla_realm::session::delete_by_token(&pool, &rotated.fresh_token.unwrap())
        .await
        .unwrap();
    assert!(
        !wenilla_realm::session::still_valid(&pool, session.id, 1, &session.csrf_token)
            .await
            .unwrap()
    );
    let other = wenilla_realm::session::create(&pool, 1, None, None)
        .await
        .unwrap();
    let other = wenilla_realm::session::lookup(&pool, &other)
        .await
        .unwrap()
        .unwrap();
    assert!(
        wenilla_realm::session::still_valid(&pool, other.id, 1, &other.csrf_token)
            .await
            .unwrap()
    );
    assert!(
        !wenilla_realm::session::still_valid(&pool, other.id, 1, &session.csrf_token)
            .await
            .unwrap(),
        "a deleted id reused by SQLite must not revive a stale socket"
    );
}
