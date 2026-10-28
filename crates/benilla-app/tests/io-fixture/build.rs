use std::{env, fs, path::PathBuf};

fn between(source: &str, start: &str, end: &str) -> String {
    let at = source.find(start).expect(start);
    let tail = &source[at..];
    tail[..tail.find(end).expect(end)].to_owned()
}

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let io_path = root.join("src/net/io.rs");
    let net_path = root.join("src/net.rs");
    let tests = root
        .join("src/net/io/cycle_tests.rs")
        .canonicalize()
        .unwrap();
    for path in [&io_path, &net_path, &tests] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let io = fs::read_to_string(io_path).unwrap().replace("\r\n", "\n");
    let net = fs::read_to_string(net_path).unwrap().replace("\r\n", "\n");
    // Compile the actual sequencer and protocol fixture, not an imitation of its control flow.
    // Only renderer logging/census facilities are replaced by no-op adapters in lib.rs.
    let mut out = String::new();
    out.push_str(&between(
        &net,
        "pub(crate) enum CharRequest {",
        "/// The realm channel:",
    ));
    out.push_str(&between(
        &net,
        "pub(crate) enum RealmRequest {",
        "/// The credentials channel",
    ));
    out.push_str("pub(crate) mod io { use super::{CharRequest,RealmRequest}; use std::sync::{Arc,Mutex}; use std::sync::atomic::{AtomicU64,Ordering}; use std::time::{Duration,Instant}; use anyhow::{anyhow,Result}; use benilla_assets::LockRecover; use benilla_protocol::{host_port,messages,AuthReject,CharAction,LoginStage,Poll,SessionEnd,SessionEvent,WardenRequired,WorldSession,WorldWriter,WORLD_PORT}; use crossbeam_channel::{Receiver,Sender}; fn note_inbound() {}\n");
    out.push_str(&between(
        &io,
        "#[derive(Clone)]\npub(crate) struct LoginRequest",
        "/// Which of the character park's",
    ));
    out.push_str(&between(&io, "enum Fired {", "/// The keepalive cadence"));
    out.push_str(&between(
        &io,
        "pub(super) const PING_INTERVAL",
        "/// Cap on consecutive",
    ));
    out.push_str(&between(
        &io,
        "enum Parked {",
        "/// Everything [`spawn_net`]",
    ));
    out.push_str(&between(
        &io,
        "async fn sequencer(",
        "/// One connection cycle:",
    ));
    out.push_str(&between(&io, "async fn run(", "/// `WOW_REFUSE_LOGIN=1`"));
    out.push_str(&between(
        &io,
        "fn refuse_once(",
        "/// Drain the writer's sent-packet log",
    ));
    out.push_str(&format!("#[path = {:?}] mod cycle_tests; }}", tests));
    out.push_str(&format!(
        "#[path = {:?}] mod select_keepalive;",
        root.join("src/net/select_keepalive.rs")
            .canonicalize()
            .unwrap()
    ));
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("actual_io.rs"),
        out,
    )
    .unwrap();
}
