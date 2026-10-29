//! The service's own sqlite (WAL, migrated at boot) and the `meta` key/value table that holds
//! setup state and the encrypted SOAP credentials.

use std::path::Path;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Connection, SqliteConnection, SqlitePool};

pub async fn open_sqlite(path: &Path) -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    // Schema rebuilds must not cascade-delete ownership rows. This connection is never used
    // to serve requests; runtime connections enforce foreign keys after the integrity gate.
    let mut migration = SqliteConnection::connect_with(&opts.clone().foreign_keys(false))
        .await
        .with_context(|| format!("opening {}", path.display()))?;
    sqlx::migrate!("./migrations")
        .run(&mut migration)
        .await
        .context("migrating")?;
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut migration)
        .await?;
    anyhow::ensure!(
        violations.is_empty(),
        "database ownership references failed migration integrity check"
    );
    migration.close().await?;
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Seconds since the epoch — every timestamp in the schema.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub async fn meta_get(db: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM meta WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| r.0))
}

pub async fn meta_set(db: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn meta_del(db: &SqlitePool, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM meta WHERE key = ?")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn setup_complete(db: &SqlitePool) -> Result<bool> {
    Ok(meta_get(db, "setup_complete").await?.as_deref() == Some("1"))
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[tokio::test]
    async fn identity_upgrade_preserves_owners_and_never_reuses_deleted_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite");
        let pool = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        let all = sqlx::migrate!("./migrations");
        let legacy = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                all.iter().filter(|m| m.version <= 4).cloned().collect(),
            ),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        legacy.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO users (id,username,display_name,role,created_at) VALUES (41,'owner','Owner','player',0),(43,'highest','Highest','player',0)").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO local_credentials (user_id,password_hash,updated_at) VALUES (41,'kept',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let token = crate::session::create(&pool, 41, None, None).await.unwrap();
        pool.close().await;
        let pool = open_sqlite(&path).await.unwrap();
        let schema: (String,) = sqlx::query_as("SELECT sql FROM sqlite_master WHERE name='users'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            schema.0.contains("AUTOINCREMENT"),
            "account identity must have a durable non-reuse sequence"
        );
        assert!(
            crate::session::lookup(&pool, &token)
                .await
                .unwrap()
                .is_some(),
            "upgrade must preserve foreign-key children"
        );
        let credential: (String,) =
            sqlx::query_as("SELECT password_hash FROM local_credentials WHERE user_id=41")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(credential.0, "kept");
        sqlx::query("DELETE FROM users WHERE id=43")
            .execute(&pool)
            .await
            .unwrap();
        let created = sqlx::query("INSERT INTO users (username,display_name,role,created_at) VALUES ('new','New','player',0)").execute(&pool).await.unwrap().last_insert_rowid();
        assert!(
            created > 43,
            "a replacement account must never inherit an economy identity"
        );
        sqlx::query("DELETE FROM users")
            .execute(&pool)
            .await
            .unwrap();
        let next = sqlx::query("INSERT INTO users (username,display_name,role,created_at) VALUES ('last','Last','player',0)").execute(&pool).await.unwrap().last_insert_rowid();
        assert!(next > created);
    }
}
