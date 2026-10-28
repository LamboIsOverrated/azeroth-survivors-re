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

#[tokio::test]
async fn replacing_or_resetting_a_password_revokes_all_sessions_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let pool = db::open_sqlite(&dir.path().join("realm.sqlite"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id,username,display_name,role,created_at) VALUES (1,'test','Test','player',0)").execute(&pool).await.unwrap();
    for bootstrap in [false, true] {
        wenilla_realm::auth::local::set_password(&pool, 1, "original valid password")
            .await
            .unwrap();
        let token = session::create(&pool, 1, None, None).await.unwrap();
        if bootstrap {
            wenilla_realm::auth::local::set_bootstrap_password(
                &pool,
                1,
                "replacement password",
                48,
            )
            .await
            .unwrap();
        } else {
            wenilla_realm::auth::local::set_password(&pool, 1, "replacement password")
                .await
                .unwrap();
        }
        assert!(
            session::lookup(&pool, &token).await.unwrap().is_none(),
            "all sessions must be revoked on password replacement/bootstrap reset"
        );
    }
    let old_hash: (String,) =
        sqlx::query_as("SELECT password_hash FROM local_credentials WHERE user_id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    let token = session::create(&pool, 1, None, None).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END").execute(&pool).await.unwrap();
    assert!(
        wenilla_realm::auth::local::set_password(&pool, 1, "must roll back password")
            .await
            .is_err()
    );
    let current_hash: (String,) =
        sqlx::query_as("SELECT password_hash FROM local_credentials WHERE user_id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        current_hash, old_hash,
        "credential and revocation must commit together"
    );
    assert!(session::lookup(&pool, &token).await.unwrap().is_some());
}

#[tokio::test]
async fn an_inflight_old_password_login_cannot_create_a_session_after_reset() {
    let dir = tempfile::tempdir().unwrap();
    let pool = db::open_sqlite(&dir.path().join("realm.sqlite"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id,username,display_name,role,created_at) VALUES (1,'test','Test','player',0)").execute(&pool).await.unwrap();
    wenilla_realm::auth::local::set_password(&pool, 1, "original valid password")
        .await
        .unwrap();
    let verified_hash: (String,) =
        sqlx::query_as("SELECT password_hash FROM local_credentials WHERE user_id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        session::create_for_password(&pool, 1, &verified_hash.0, None, None)
            .await
            .unwrap()
            .is_some()
    );
    wenilla_realm::auth::local::set_password(&pool, 1, "replacement password")
        .await
        .unwrap();
    assert!(
        session::create_for_password(&pool, 1, &verified_hash.0, None, None)
            .await
            .unwrap()
            .is_none(),
        "a password verified before reset cannot establish a post-reset session"
    );
}

#[tokio::test]
async fn admin_reset_revokes_admin_sessions_atomically_and_preserves_players() {
    let dir = tempfile::tempdir().unwrap();
    let pool = db::open_sqlite(&dir.path().join("realm.sqlite"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id,username,display_name,role,created_at) VALUES (1,'admin','Admin','admin',0),(2,'player','Player','player',0)").execute(&pool).await.unwrap();
    for id in [1, 2] {
        wenilla_realm::auth::local::set_password(&pool, id, "original valid password")
            .await
            .unwrap();
    }
    let admin = session::create(&pool, 1, None, None).await.unwrap();
    let player = session::create(&pool, 2, None, None).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END").execute(&pool).await.unwrap();
    assert!(wenilla_realm::auth::local::reset_admin_credentials(&pool)
        .await
        .is_err());
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM local_credentials")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count.0, 2,
        "admin credentials must roll back if revocation fails"
    );
    assert!(session::lookup(&pool, &admin).await.unwrap().is_some());
    sqlx::query("DROP TRIGGER deny_session_delete")
        .execute(&pool)
        .await
        .unwrap();
    wenilla_realm::auth::local::reset_admin_credentials(&pool)
        .await
        .unwrap();
    assert!(session::lookup(&pool, &admin).await.unwrap().is_none());
    assert!(session::lookup(&pool, &player).await.unwrap().is_some());
    let ids: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM local_credentials")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(ids, vec![(2,)]);
}
