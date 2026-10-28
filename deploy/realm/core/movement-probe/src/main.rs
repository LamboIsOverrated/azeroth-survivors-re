use anyhow::{bail, ensure, Context, Result};
use benilla_protocol::{
    messages::opcode as op, JumpInfo, Poll, SessionEvent, TransportPose, WorldSession, WorldWriter,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Write,
    net::SocketAddr,
    path::Path,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    user: String,
    character: String,
    security: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    name: String,
    delay_ms: u64,
    opcode: u16,
    flags: u32,
    offset: [f32; 3],
    accept: bool,
    #[serde(default = "default_observe_ms")]
    observe_ms: u64,
    #[serde(default)]
    fall_ms: u32,
    #[serde(default)]
    jump: Option<[f32; 4]>,
    #[serde(default)]
    transport: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    version: u32,
    isolated: bool,
    auth: String,
    world: String,
    database_prefix: String,
    source_commit: String,
    image_digest: String,
    primary: Identity,
    observer: Identity,
    map: u32,
    origin: [f32; 3],
    orientation: f32,
    steps: Vec<Step>,
    #[serde(default)]
    create_missing_characters: bool,
}

fn default_observe_ms() -> u64 {
    200
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f32>()
        .sqrt()
}
fn validate(f: &Fixture) -> Result<()> {
    ensure!(f.version == 1 && f.isolated, "require isolated fixture v1");
    for address in [&f.auth, &f.world] {
        let a: SocketAddr = address
            .parse()
            .context("literal loopback address required")?;
        ensure!(
            a.ip().is_loopback() && a.port() >= 1024 && ![3724, 8085, 7878].contains(&a.port()),
            "refusing public or stock endpoint"
        );
    }
    ensure!(
        f.database_prefix.starts_with("movementqa_") && f.database_prefix.len() <= 40,
        "disposable schema prefix required"
    );
    ensure!(
        f.source_commit.len() == 40 && f.source_commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "source commit required"
    );
    ensure!(
        f.image_digest.len() == 64 && f.image_digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "image digest required"
    );
    for identity in [&f.primary, &f.observer] {
        ensure!(
            identity.security == 0
                && identity.user.starts_with("MOVEQA")
                && identity.user.len() <= 16
                && identity.character.starts_with("Moveqa")
                && identity.character.len() <= 12,
            "dedicated ordinary QA identity required"
        );
    }
    ensure!(
        f.primary.user != f.observer.user && f.primary.character != f.observer.character,
        "two distinct QA identities required"
    );
    ensure!(
        f.origin.iter().all(|p| p.is_finite()) && f.orientation.is_finite(),
        "invalid fixture pose"
    );
    ensure!(
        (3..=48).contains(&f.steps.len()),
        "require 3..48 bounded steps"
    );
    for (i, s) in f.steps.iter().enumerate() {
        ensure!(
            (100..=1500).contains(&s.observe_ms),
            "invalid observation interval"
        );
        ensure!(
            !s.name.is_empty() && s.name.len() <= 64 && (100..=1000).contains(&s.delay_ms),
            "invalid step name/delay"
        );
        ensure!(
            [
                op::MSG_MOVE_START_FORWARD,
                op::MSG_MOVE_STOP,
                op::MSG_MOVE_HEARTBEAT,
                op::MSG_MOVE_JUMP,
                op::MSG_MOVE_FALL_LAND,
                op::MSG_MOVE_START_SWIM,
                op::MSG_MOVE_STOP_SWIM
            ]
            .contains(&s.opcode),
            "non-movement opcode forbidden"
        );
        ensure!(
            s.offset.iter().all(|p| p.is_finite()) && distance(s.offset, [0.; 3]) <= 80.,
            "invalid or excessive fixture offset"
        );
        ensure!(
            (s.flags & 0x2000 != 0) == s.jump.is_some()
                && (s.flags & 0x0200_0000 != 0) == s.transport.is_some(),
            "movement tails disagree with flags"
        );
        if let Some(jump) = s.jump {
            ensure!(
                jump.iter().all(|p| p.is_finite() && p.abs() <= 100.),
                "invalid jump"
            );
        }
        if !s.accept {
            ensure!(
                i + 1 < f.steps.len() && f.steps[i + 1].accept,
                "refusal needs immediate positive recovery"
            );
            ensure!(
                f.steps
                    .iter()
                    .filter(|p| p.accept)
                    .all(|p| distance(p.offset, s.offset) > 0.1),
                "forged pose overlaps positive evidence"
            );
        }
    }
    ensure!(
        f.steps
            .iter()
            .map(|s| s.delay_ms + s.observe_ms)
            .sum::<u64>()
            <= 110000,
        "step schedule exceeds deadline reserve"
    );
    let last = f.steps.last().unwrap();
    ensure!(
        last.accept && distance(last.offset, [0.; 3]) < 0.01,
        "final positive step must return to origin"
    );
    Ok(())
}

struct Evidence {
    file: fs::File,
    begin: Instant,
}
impl Evidence {
    fn write(&mut self, mut value: Value) -> Result<()> {
        value["elapsed_us"] = json!(self.begin.elapsed().as_micros());
        serde_json::to_writer(&mut self.file, &value)?;
        writeln!(self.file)?;
        self.file.flush()?;
        Ok(())
    }
}
enum Input {
    Event(usize, Box<SessionEvent>),
    Error(usize, String),
}
struct Peer {
    writer: WorldWriter,
    guid: u64,
    pose: [f32; 3],
    orientation: f32,
    entered: bool,
    logged_out: bool,
}
fn should_create(id: &Identity, names: &[String], permit: bool) -> Result<bool> {
    ensure!(
        names.iter().all(|n| n == &id.character),
        "unexpected character on dedicated QA account"
    );
    if names.iter().any(|n| n == &id.character) {
        return Ok(false);
    }
    ensure!(
        permit,
        "missing declared QA character; explicit creation permission required"
    );
    Ok(true)
}
fn roster(f: &Fixture, id: &Identity, s: &mut WorldSession) -> Result<benilla_protocol::Character> {
    let mut chars = s.char_enum()?;
    if should_create(
        id,
        &chars.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        f.create_missing_characters,
    )? {
        let result = s.create_character(&benilla_protocol::CharCreateReq {
            name: id.character.clone(),
            race: 1,
            class: 1,
            gender: 0,
            skin: 0,
            face: 0,
            hair_style: 0,
            hair_color: 0,
            facial_hair: 0,
        })?;
        ensure!(
            result == benilla_protocol::messages::CHAR_CREATE_SUCCESS,
            "character creation refused {result:#x}"
        );
        chars = s.char_enum()?;
    }
    chars
        .into_iter()
        .find(|c| c.name == id.character)
        .context("declared QA character missing")
}

fn password(prefix: &str, id: &Identity) -> Result<String> {
    ensure!(
        env::var(format!("{prefix}USER")).ok().as_deref() == Some(&id.user)
            && env::var(format!("{prefix}CHAR")).ok().as_deref() == Some(&id.character),
        "identity environment does not match declaration"
    );
    env::var(format!("{prefix}PASS")).context("QA password environment missing")
}
fn session(f: &Fixture, id: &Identity, pass: &str) -> Result<WorldSession> {
    let auth = benilla_protocol::logon(&f.auth, &id.user, pass)?;
    // Never follow the realm list into a different service or a public endpoint.
    WorldSession::connect_queued(&f.world, &id.user, auth.session_key, &mut |_| false)
}
fn connect(
    f: &Fixture,
    id: &Identity,
    pass: &str,
    side: usize,
    tx: mpsc::SyncSender<Input>,
) -> Result<Peer> {
    let mut s = session(f, id, pass)?;
    let c = roster(f, id, &mut s)?;
    ensure!(
        c.map == f.map && distance([c.position.x, c.position.y, c.position.z], f.origin) < 20.,
        "QA roster is outside measured fixture"
    );
    s.player_login(c.guid)?;
    s.set_active_mover(c.guid)?;
    let (mut reader, mut writer) = s.into_split()?;
    writer.watch_sends();
    thread::spawn(move || {
        for _ in 0..8192 {
            match reader.poll() {
                Ok(Poll::Events { events, .. }) => {
                    for event in events {
                        if tx.send(Input::Event(side, Box::new(event))).is_err() {
                            return;
                        }
                    }
                }
                Ok(Poll::Skipped { opcode, .. }) => {
                    let _ = tx.send(Input::Error(
                        side,
                        format!("unparseable packet {opcode:#x}"),
                    ));
                    return;
                }
                Err(e) => {
                    let _ = tx.send(Input::Error(side, format!("stream ended: {e}")));
                    return;
                }
            }
        }
        let _ = tx.send(Input::Error(side, "inbound packet ceiling".into()));
    });
    Ok(Peer {
        writer,
        guid: c.guid,
        pose: [c.position.x, c.position.y, c.position.z],
        orientation: f.orientation,
        entered: false,
        logged_out: false,
    })
}
struct Run {
    peers: [Peer; 2],
    rx: mpsc::Receiver<Input>,
    evidence: Evidence,
    forbidden: Vec<[f32; 3]>,
    relays: Vec<[f32; 3]>,
    sent: usize,
    map: u32,
}
impl Run {
    fn count(&mut self) -> Result<()> {
        for p in &mut self.peers {
            p.writer.drain_sent(|_, _| self.sent += 1);
        }
        ensure!(self.sent <= 128, "outbound packet ceiling exceeded");
        Ok(())
    }
    fn pump(&mut self, duration: Duration) -> Result<()> {
        let until = Instant::now() + duration;
        while Instant::now() < until {
            let input = match self
                .rx
                .recv_timeout(until.saturating_duration_since(Instant::now()))
            {
                Ok(v) => v,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(e) => return Err(e.into()),
            };
            let (side, event) = match input {
                Input::Event(side, event) => (side, *event),
                Input::Error(side, message) => {
                    ensure!(self.peers[side].logged_out, "peer {side}: {message}");
                    continue;
                }
            };
            if let SessionEvent::UnitMove {
                guid,
                position,
                flags,
                time,
                ..
            } = &event
            {
                if side == 1 && *guid == self.peers[0].guid {
                    self.evidence.write(json!({"event":"accepted-relay","pose":position,"flags":flags,"wire_time":time}))?;
                    ensure!(
                        self.forbidden.iter().all(|p| distance(*p, *position) > 0.1),
                        "server relayed a forbidden pose"
                    );
                    self.relays.push(*position);
                }
            }
            let p = &mut self.peers[side];
            match event {
                SessionEvent::Worldport {
                    map_id,
                    position,
                    orientation,
                    needs_ack,
                } => {
                    ensure!(
                        !needs_ack && map_id == self.map,
                        "unexpected world transfer; measured transport fixture required"
                    );
                    p.pose = position;
                    p.orientation = orientation;
                    p.entered = true;
                    self.evidence.write(
                        json!({"event":"entered","side":side,"map":map_id,"pose":position}),
                    )?;
                }
                SessionEvent::Teleport {
                    guid,
                    counter,
                    position,
                    orientation,
                } if guid == p.guid => {
                    self.evidence
                        .write(json!({"event":"server-teleport","side":side,"pose":position}))?;
                    p.pose = position;
                    p.orientation = orientation;
                    p.writer.teleport_ack(guid, counter)?;
                }
                SessionEvent::ForceSpeedChange {
                    guid,
                    kind,
                    counter,
                    speed,
                } if guid == p.guid => {
                    self.evidence
                        .write(json!({"event":"server-speed-ack","side":side,"speed":speed}))?;
                    p.writer.force_speed_change_ack(
                        kind,
                        guid,
                        counter,
                        speed,
                        0,
                        p.pose,
                        p.orientation,
                        0.,
                        0,
                        None,
                        None,
                    )?;
                }
                SessionEvent::MoveMode {
                    guid,
                    counter,
                    mode,
                    apply,
                } if guid == p.guid => p.writer.move_mode_ack(
                    guid,
                    counter,
                    mode,
                    apply,
                    if apply { mode.flag() } else { 0 },
                    (p.pose, p.orientation),
                )?,
                SessionEvent::ClientControl {
                    mover,
                    allow_move: true,
                } if mover == p.guid => p.writer.set_active_mover(mover)?,
                SessionEvent::CinematicTriggered { .. } => p.writer.complete_cinematic()?,
                SessionEvent::LoggedOut => p.logged_out = true,
                SessionEvent::LogoutResponse { reason, .. } => {
                    ensure!(reason == 0, "logout refused {reason}")
                }
                SessionEvent::KnockBack { .. } => {
                    bail!("unexpected knockback: a measured trajectory fixture is required")
                }
                _ => {}
            }
            self.count()?;
        }
        Ok(())
    }
    fn step(&mut self, f: &Fixture, s: &Step) -> Result<()> {
        self.pump(Duration::from_millis(s.delay_ms))?;
        let pos = std::array::from_fn(|i| f.origin[i] + s.offset[i]);
        self.relays.clear();
        if !s.accept {
            self.forbidden.push(pos);
        }
        let jump = s.jump.map(|j| JumpInfo {
            zspeed: j[0],
            cos_angle: j[1],
            sin_angle: j[2],
            xy_speed: j[3],
        });
        let transport = s.transport.map(|guid| TransportPose {
            guid,
            pos: benilla_protocol::wire::Vector3d {
                x: 0.,
                y: 0.,
                z: 0.,
            },
            orientation: 0.,
        });
        self.evidence.write(json!({"event":"send","case":s.name,"opcode":s.opcode,"flags":s.flags,"pose":pos,"expected_accept":s.accept}))?;
        let p = &mut self.peers[0];
        p.writer.send_movement(
            s.opcode,
            s.flags,
            pos,
            f.orientation,
            0.,
            s.fall_ms,
            jump,
            transport,
        )?;
        self.count()?;
        self.pump(Duration::from_millis(s.observe_ms))?;
        if s.accept {
            ensure!(
                self.relays.iter().any(|p| distance(*p, pos) < 0.1),
                "no positive relay for {}",
                s.name
            );
            self.peers[0].pose = pos;
        }
        self.evidence.write(json!({"event":"step-complete","case":s.name,"positive_relay":s.accept,
            "note":if s.accept {"accepted by world"} else {"no forbidden relay; next recovery and saved pose still required"}}))?;
        Ok(())
    }
}
fn execute(f: &Fixture, raw: &[u8], output: &Path, create_only: bool) -> Result<()> {
    for (key, value) in [
        ("WOW_UNATTENDED", "1"),
        ("WOW_NOSOUND", "1"),
        ("WOW_GM", "off"),
    ] {
        ensure!(
            env::var(key).ok().as_deref() == Some(value),
            "require {key}={value}"
        );
    }
    let pass = password("WOW_", &f.primary)?;
    let observer_pass = password("WOW_OBSERVER_", &f.observer)?;
    let mut evidence = Evidence {
        file: fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(output)?,
        begin: Instant::now(),
    };
    evidence.write(json!({"event":"preflight","fixture_sha256":format!("{:x}",Sha256::digest(raw)),"source_commit":f.source_commit,
        "image_digest":f.image_digest,"auth":f.auth,"world":f.world,"database_prefix":f.database_prefix,
        "primary":f.primary.user,"observer":f.observer.user,"security_attestation":[f.primary.security,f.observer.security],
        "max_duration_seconds":180,"max_outbound_packets":128,"combat":false}))?;
    // Independent hard bound also covers a stalled OS connect/read during authentication.
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(180));
        eprintln!("movement probe exceeded hard deadline");
        std::process::exit(124);
    });
    if create_only {
        ensure!(
            f.create_missing_characters,
            "create-only needs fixture permission"
        );
        for (id, pw) in [(&f.primary, &pass), (&f.observer, &observer_pass)] {
            let mut s = session(f, id, pw)?;
            let c = roster(f, id, &mut s)?;
            evidence.write(
                json!({"event":"provisioned-roster","user":id.user,"character":c.name,"guid":c.guid,
                "map":c.map,"pose":[c.position.x,c.position.y,c.position.z]}),
            )?;
        }
        evidence.write(json!({"event":"provision-only-complete","movement_sent":false}))?;
        return Ok(());
    }
    let (tx, rx) = mpsc::sync_channel(1024);
    let observer = connect(f, &f.observer, &observer_pass, 1, tx.clone())?;
    let primary = connect(f, &f.primary, &pass, 0, tx)?;
    let mut run = Run {
        peers: [primary, observer],
        rx,
        evidence,
        forbidden: vec![],
        relays: vec![],
        sent: 0,
        map: f.map,
    };
    run.pump(Duration::from_secs(3))?;
    ensure!(
        run.peers.iter().all(|p| p.entered),
        "both world entries must be proven"
    );
    ensure!(
        distance(run.peers[0].pose, f.origin) < 0.1 && distance(run.peers[1].pose, f.origin) < 20.,
        "initial world pose differs from measured fixture"
    );
    for s in &f.steps {
        run.step(f, s)?;
    }
    run.peers[0].writer.logout_request()?;
    run.pump(Duration::from_secs(25))?;
    ensure!(
        run.peers[0].logged_out,
        "world did not confirm primary logout"
    );
    let mut again = session(f, &f.primary, &pass)?;
    let saved = again
        .char_enum()?
        .into_iter()
        .find(|c| c.guid == run.peers[0].guid)
        .context("saved character missing")?;
    let pos = [saved.position.x, saved.position.y, saved.position.z];
    ensure!(
        saved.map == f.map && distance(pos, f.origin) < 0.15,
        "authoritative saved pose differs from final accepted pose"
    );
    run.evidence.write(json!({"event":"saved-pose-verified","pose":pos,"map":saved.map,"outbound_packets":run.sent}))?;
    run.peers[1].writer.logout_request()?;
    run.pump(Duration::from_secs(25))?;
    ensure!(run.peers[1].logged_out, "observer logout not confirmed");
    run.evidence.write(json!({"event":"wire-checks-passed","steps":f.steps.len(),"remaining":"correlate isolated server rejection reasons; map/operator fixtures require separate runs"}))?;
    println!("Bounded wire checks passed; isolated server reason evidence is still required.");
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().collect();
    ensure!(
        args.len() == 3 || (args.len() == 4 && args[3] == "--create-only"),
        "usage: realm-movement-probe PRIVATE-FIXTURE.json NEW-EVIDENCE.jsonl [--create-only]"
    );
    let raw = fs::read(&args[1])?;
    ensure!(raw.len() <= 65536, "fixture too large");
    let f: Fixture = serde_json::from_slice(&raw)?;
    validate(&f)?;
    execute(&f, &raw, Path::new(&args[2]), args.len() == 4)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Fixture {
        serde_json::from_value(json!({
            "version":1,"isolated":true,"auth":"127.0.0.1:13724","world":"127.0.0.1:18085",
            "database_prefix":"movementqa_20261028_","source_commit":"a".repeat(40),"image_digest":"b".repeat(64),
            "primary":{"user":"MOVEQAONE","character":"Moveqaone","security":0},
            "observer":{"user":"MOVEQATWO","character":"Moveqatwo","security":0},
            "map":0,"origin":[1,2,3],"orientation":0,
            "steps":[
                {"name":"normal","delay_ms":200,"opcode":238,"flags":0,"offset":[0.5,0,0],"accept":true},
                {"name":"forged","delay_ms":200,"opcode":238,"flags":0,"offset":[39,0,0],"accept":false},
                {"name":"recovery","delay_ms":300,"opcode":238,"flags":0,"offset":[0,0,0],"accept":true}
            ]
        })).unwrap()
    }
    #[test]
    fn character_creation_is_explicit_empty_roster_only_and_never_recreates() {
        let f = fixture();
        let id = &f.primary;
        assert!(should_create(id, &[], true).unwrap());
        assert!(should_create(id, &[], false).is_err());
        assert!(!should_create(id, std::slice::from_ref(&id.character), true).unwrap());
        assert!(should_create(id, &["SomeonesAvatar".into()], true).is_err());
    }
    #[test]
    fn valid_isolated_noncombat_fixture() {
        validate(&fixture()).unwrap();
    }
    #[test]
    fn reject_public_stock_privileged_or_shared_identity() {
        for change in 0..5 {
            let mut f = fixture();
            match change {
                0 => f.auth = "realm-core.railway.internal:3724".into(),
                1 => f.world = "127.0.0.1:8085".into(),
                2 => f.primary.security = 3,
                3 => f.observer.user = f.primary.user.clone(),
                _ => f.isolated = false,
            }
            assert!(validate(&f).is_err());
        }
    }
    #[test]
    fn refusal_requires_distinct_positive_recovery_and_no_unbounded_stream() {
        let mut f = fixture();
        f.steps.pop();
        assert!(validate(&f).is_err());
        let mut f = fixture();
        f.steps[0].opcode = op::CMSG_ATTACKSWING;
        assert!(validate(&f).is_err());
        let mut f = fixture();
        f.steps[1].offset = [f32::NAN, 0., 0.];
        assert!(validate(&f).is_err());
        let mut f = fixture();
        f.steps[1].offset = [500., 0., 0.];
        assert!(validate(&f).is_err());
        let mut f = fixture();
        f.steps[1].offset = f.steps[2].offset;
        assert!(validate(&f).is_err());
        let mut f = fixture();
        f.steps = (0..100).map(|_| fixture().steps.remove(0)).collect();
        assert!(validate(&f).is_err());
    }
}
