mod observe;
mod phases;
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
struct TeleportGate {
    destination: [f32; 3],
    timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpeedGate {
    speed: f32,
    timeout_ms: u64,
    #[serde(default)]
    above_floor: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KnockbackGate {
    launch: [f32; 4],
    timeout_ms: u64,
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
    #[serde(default)]
    clear_flags: u32,
    #[serde(default)]
    await_teleport: Option<TeleportGate>,
    #[serde(default)]
    await_run_speed: Option<SpeedGate>,
    #[serde(default)]
    await_knockback: Option<KnockbackGate>,
    #[serde(default)]
    relative_to_knockback: bool,
    #[serde(default)]
    ballistic_from_knockback: bool,
    #[serde(default)]
    wait_knockback_age_ms: Option<u64>,
    #[serde(default)]
    ground_from_knockback: bool,
    #[serde(default)]
    terrain_follow: bool,
    #[serde(default)]
    relative_to_teleport: bool,
    #[serde(default)]
    fall_from_teleport: bool,
    #[serde(default = "default_observe_ms")]
    observe_ms: u64,
    #[serde(default)]
    fall_ms: u32,
    #[serde(default)]
    jump: Option<[f32; 4]>,
    #[serde(default)]
    transport: Option<u64>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalClone {
    service_id: String,
    database_host: String,
    database_port: u16,
    source_database_port: u16,
    source_prefix: String,
    schemas: [String; 4],
    copy_verification_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    guid: u64,
    seconds: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    version: u32,
    isolated: bool,
    auth: String,
    world: String,
    database_prefix: String,
    #[serde(default)]
    canonical_clone: Option<CanonicalClone>,
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
    #[serde(default = "default_hold_seconds")]
    hold_seconds: u64,
    #[serde(default)]
    terrain: Option<phases::TerrainGrid>,
    #[serde(default)]
    observation: Option<Observation>,
}

fn relay_safe(forbidden: &[([f32; 3], u32)], position: [f32; 3], flags: u32) -> bool {
    forbidden.iter().all(|(pose, mask)| {
        if *mask == 0 {
            distance(*pose, position) > 0.1
        } else {
            flags & mask == 0
        }
    })
}

fn peer_closed(message: &str) -> bool {
    // recv_packet currently formats (rather than chains) the native read error.
    // Only EOF/reset while awaiting a world header is this observation. Never
    // treat timeout, refused dial, auth rejection or malformed body as a fence.
    message.contains("reading world header:")
        && (message.contains("failed to fill whole buffer")
            || message.contains("os error 104")
            || message.contains("os error 10054"))
}

fn default_hold_seconds() -> u64 {
    20
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Movement,
    CreateOnly,
    HoldOnline,
    LoginRefusal,
    ObservePlayer,
}
fn parse_mode(arg: Option<&str>) -> Result<Mode> {
    match arg {
        None => Ok(Mode::Movement),
        Some("--create-only") => Ok(Mode::CreateOnly),
        Some("--hold-online") => Ok(Mode::HoldOnline),
        Some("--expect-login-refusal") => Ok(Mode::LoginRefusal),
        Some("--observe-player") => Ok(Mode::ObservePlayer),
        _ => bail!("unknown probe mode"),
    }
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
fn operator_wait_grace_ms(f: &Fixture) -> u64 {
    // One validated knockback gate may reserve additional attended arrival time.
    // This adds no time to the post-receipt flight, expiry or packet guards.
    f.steps
        .iter()
        .filter_map(|s| s.await_knockback.as_ref())
        .map(|gate| gate.timeout_ms.saturating_sub(30000))
        .sum()
}
fn validate(f: &Fixture) -> Result<()> {
    ensure!(f.version == 1 && f.isolated, "require isolated fixture v1");
    ensure!(
        (10..=60).contains(&f.hold_seconds),
        "hold must be 10..60 seconds"
    );
    for address in [&f.auth, &f.world] {
        let a: SocketAddr = address
            .parse()
            .context("literal loopback address required")?;
        ensure!(
            a.ip().is_loopback() && a.port() >= 1024 && ![3724, 8085, 7878].contains(&a.port()),
            "refusing public or stock endpoint"
        );
    }
    let namespace_ok = match &f.canonical_clone {
        None => f.database_prefix.starts_with("movementqa_") && f.database_prefix.len() <= 40,
        Some(c) => {
            f.database_prefix == "classic"
                && c.service_id == "09bb722b-e45b-4b32-923c-9198c8374fa6"
                && c.database_host == "127.0.0.1"
                && c.database_port == 13308
                && c.source_database_port == 13307
                && c.source_prefix == "movementqa_"
                && c.schemas
                    == [
                        "classicrealmd",
                        "classiccharacters",
                        "classicmangos",
                        "classiclogs",
                    ]
                && c.copy_verification_sha256
                    == "f86d362c8f1187958b43696ed09b80f70c804b2018750821c5ae4cfac64c94ed"
        }
    };
    ensure!(
        namespace_ok,
        "unknown or mixed disposable database attestation"
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
    if let Some(observation) = &f.observation {
        ensure!(
            observation.guid > 0
                && observation.guid <= u32::MAX.into()
                && (10..=90).contains(&observation.seconds)
                && f.steps.is_empty()
                && !f.create_missing_characters
                && f.terrain.is_none(),
            "observation requires one player GUID, 10..90 seconds and no actions or provisioning"
        );
        return Ok(());
    }
    ensure!(
        (3..=48).contains(&f.steps.len()),
        "require 3..48 bounded steps"
    );
    if let Some(grid) = &f.terrain {
        grid.validate()?;
    }
    let mut has_knockback = false;
    let mut has_expiry_wait = false;
    let mut has_teleport = false;
    for (i, s) in f.steps.iter().enumerate() {
        if let Some(gate) = &s.await_knockback {
            ensure!(
                !has_knockback
                    && !has_teleport
                    && (1000..=120000).contains(&gate.timeout_ms)
                    && phases::launch_matches(gate.launch, gate.launch),
                "invalid bounded knockback gate"
            );
            ensure!(f.terrain.is_some(), "knockback needs measured terrain");
            has_knockback = true;
        }
        ensure!(
            !s.relative_to_knockback || has_knockback,
            "knockback reference needs real server gate"
        );
        ensure!(
            !s.ballistic_from_knockback
                || (has_knockback
                    && s.relative_to_knockback
                    && s.offset == [0.; 3]
                    && s.jump.is_none()
                    && s.flags == 8192),
            "ballistic sample must use only actual server launch"
        );
        if let Some(age) = s.wait_knockback_age_ms {
            ensure!(
                has_knockback && !has_expiry_wait && (61000..=65000).contains(&age),
                "only one bounded server expiry wait allowed"
            );
            has_expiry_wait = true;
        }
        ensure!(
            !s.ground_from_knockback
                || (has_expiry_wait
                    && s.relative_to_knockback
                    && !s.ballistic_from_knockback
                    && s.flags == 0
                    && s.offset == [0.; 3]),
            "ground recovery requires actual post-expiry phase"
        );
        ensure!(
            !s.terrain_follow || (has_knockback && s.flags & 8192 == 0 && s.offset[2] == 0.),
            "terrain walking requires measured nonairborne phase"
        );
        if let Some(gate) = &s.await_run_speed {
            ensure!(
                gate.speed.is_finite()
                    && (1.0..=28.0).contains(&gate.speed)
                    && (1000..=30000).contains(&gate.timeout_ms),
                "invalid bounded run-speed gate"
            );
            ensure!(
                !gate.above_floor || has_teleport || s.await_teleport.is_some(),
                "airborne speed gate needs prior server teleport"
            );
        }
        if let Some(gate) = &s.await_teleport {
            ensure!(
                !has_teleport && (1000..=10000).contains(&gate.timeout_ms),
                "only one bounded teleport phase allowed"
            );
            ensure!(
                gate.destination.iter().all(|v| v.is_finite())
                    && (gate.destination[0] - f.origin[0]).abs() < 0.01
                    && (gate.destination[1] - f.origin[1]).abs() < 0.01
                    && gate.destination[2] > f.origin[2]
                    && gate.destination[2] <= f.origin[2] + 10.,
                "teleport drop must be above exact measured floor XY"
            );
            ensure!(
                !has_knockback,
                "teleport and knockback need separate bounded runs"
            );
            has_teleport = true;
        }
        ensure!(
            !s.relative_to_teleport || has_teleport,
            "teleport reference requires a prior expected server event"
        );
        ensure!(
            !s.fall_from_teleport || (s.relative_to_teleport && s.offset[2] == 0.),
            "fall requires teleport frame and no arbitrary Z offset"
        );
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
            (s.flags & 0x2000 != 0) == (s.jump.is_some() || s.ballistic_from_knockback)
                && (s.flags & 0x0200_0000 != 0) == s.transport.is_some(),
            "movement tails disagree with flags"
        );
        if let Some(jump) = s.jump {
            ensure!(
                jump.iter().all(|p| p.is_finite() && p.abs() <= 100.),
                "invalid jump"
            );
        }
        ensure!(
            s.clear_flags == 0
                || (!s.accept
                    && s.clear_flags & !s.flags == 0
                    && distance(s.offset, [0.; 3]) <= 2.),
            "flag-clear correction requires a bounded ordinary pose and subset of requested flags"
        );
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
            .map(|s| s.delay_ms
                + s.observe_ms
                + s.await_teleport.as_ref().map_or(0, |g| g.timeout_ms)
                + s.await_run_speed.as_ref().map_or(0, |g| g.timeout_ms)
                + s.await_knockback.as_ref().map_or(0, |g| g.timeout_ms)
                + s.wait_knockback_age_ms.unwrap_or(0))
            .sum::<u64>()
            <= 110000 + operator_wait_grace_ms(f),
        "step schedule exceeds deadline reserve"
    );
    let last = f.steps.last().unwrap();
    ensure!(
        !has_knockback || (has_expiry_wait && last.terrain_follow),
        "knockback run must include expiry and measured walk back"
    );
    ensure!(
        !has_teleport || (last.relative_to_teleport && last.fall_from_teleport),
        "teleport phase must finish on measured floor"
    );
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
struct TeleportReceipt {
    position: [f32; 3],
    at: Instant,
}
struct KnockbackReceipt {
    origin: [f32; 3],
    launch: [f32; 4],
    at: Instant,
}
struct Run {
    peers: Vec<Peer>,
    rx: mpsc::Receiver<Input>,
    evidence: Evidence,
    forbidden: Vec<([f32; 3], u32)>,
    relays: Vec<[f32; 3]>,
    sent: usize,
    map: u32,
    expected_teleport: Option<[f32; 3]>,
    expected_run_speed: Option<f32>,
    speed_ack_seen: bool,
    speed_above_floor: bool,
    floor_z: f32,
    expected_knockback: Option<[f32; 4]>,
    knockback: Option<KnockbackReceipt>,
    terrain: Option<phases::TerrainGrid>,
    health: phases::HealthGuard,
    initial_run_speed: Option<f32>,
    teleport: Option<TeleportReceipt>,
    capture: Option<observe::Capture>,
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
            if side == 0 {
                if let Some(record) = self.capture.as_mut().and_then(|c| c.event(&event)) {
                    self.evidence.write(record)?;
                }
            }
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
                        relay_safe(&self.forbidden, *position, *flags),
                        "server relayed forbidden pose or movement capability"
                    );
                    if self
                        .forbidden
                        .iter()
                        .any(|(p, mask)| *mask != 0 && distance(*p, *position) < 0.1)
                    {
                        self.peers[0].pose = *position;
                        self.evidence.write(
                            json!({"event":"corrected-relay","pose":position,"flags":flags}),
                        )?;
                    }
                    self.relays.push(*position);
                }
            }
            let primary_guid = self.peers[0].guid;
            if let SessionEvent::ObjectCreate {
                guid,
                speeds: Some(speeds),
                ..
            } = &event
            {
                if side == 0 && *guid == primary_guid && self.initial_run_speed.is_none() {
                    self.initial_run_speed = Some(speeds.run);
                    self.evidence.write(json!({"event":"initial-self-run-speed","guid":guid,"run_speed":speeds.run}))?;
                }
            }
            let fields = match &event {
                SessionEvent::ObjectCreate { guid, fields, .. }
                | SessionEvent::ObjectValues { guid, fields }
                    if *guid == primary_guid =>
                {
                    Some(fields)
                }
                _ => None,
            };
            if let Some(fields) = fields {
                let health = fields.unit_health();
                let flags = fields.unit_flags();
                let baseline = self.health.baseline[side];
                self.evidence
                    .write(json!({"event":"health-observation","side":side,
                    "guid":primary_guid,"health":health,"max_health":fields.unit_max_health(),
                    "baseline":baseline,"unit_flags":flags}))?;
                ensure!(
                    self.health.observe(side, flags, health),
                    "ordinary probe entered combat or health changed: side={side} guid={primary_guid} flags={flags:#x} health={health:?} baseline={baseline:?}"
                );
                if baseline.is_none() && health.is_some() {
                    self.evidence.write(
                        json!({"event":"baseline-health","side":side,"guid":primary_guid,"health":health}),
                    )?;
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
                    ensure!(
                        side == 0
                            && self.expected_teleport.is_some_and(|wanted| {
                                phases::matches_destination(wanted, position)
                            }),
                        "unexpected or mismatched server teleport"
                    );
                    self.evidence.write(json!({"event":"server-teleport","side":side,"pose":position,"counter":counter}))?;
                    p.pose = position;
                    p.orientation = orientation;
                    p.writer.teleport_ack(guid, counter)?;
                    self.teleport = Some(TeleportReceipt {
                        position,
                        at: Instant::now(),
                    });
                    self.expected_teleport = None;
                    self.evidence.write(
                        json!({"event":"server-teleport-ack-sent","guid":guid,"counter":counter}),
                    )?;
                }
                SessionEvent::ForceSpeedChange {
                    guid,
                    kind,
                    counter,
                    speed,
                } if guid == p.guid => {
                    let mut pose = p.pose;
                    let mut flags = 0;
                    let mut fall_ms = 0;
                    let mut jump = None;
                    if side == 0 {
                        if let Some(tp) = &self.teleport {
                            let elapsed = tp.at.elapsed();
                            if elapsed.as_secs_f64() <= 10.0 {
                                pose = phases::fall_position(
                                    tp.position,
                                    elapsed.as_secs_f64(),
                                    self.floor_z,
                                )?;
                                fall_ms = u32::try_from(elapsed.as_millis())?;
                                if pose[2] > self.floor_z + 0.1 {
                                    flags = 8192;
                                    jump = Some(JumpInfo {
                                        zspeed: 0.,
                                        cos_angle: 1.,
                                        sin_angle: 0.,
                                        xy_speed: 0.,
                                    });
                                }
                            } else {
                                ensure!(
                                    p.pose[2] <= self.floor_z + 0.15,
                                    "stale airborne speed ACK clock"
                                );
                            }
                        }
                    }
                    if side == 0 && kind == benilla_protocol::SpeedKind::Run {
                        if let Some(expected) = self.expected_run_speed {
                            ensure!(
                                phases::speed_matches(expected, speed),
                                "unexpected authoritative run speed"
                            );
                            ensure!(
                                !self.speed_above_floor || pose[2] > self.floor_z + 2.,
                                "speed change arrived after airborne window"
                            );
                            self.speed_ack_seen = true;
                        }
                    }
                    self.evidence.write(json!({"event":"server-speed-ack","side":side,"speed":speed,"kind":format!("{kind:?}"),"counter":counter,"pose":pose,"flags":flags}))?;
                    p.writer.force_speed_change_ack(
                        kind,
                        guid,
                        counter,
                        speed,
                        flags,
                        pose,
                        p.orientation,
                        0.,
                        fall_ms,
                        jump,
                        None,
                    )?;
                }
                SessionEvent::SpeedChanged { guid, kind, speed }
                    if side == 1
                        && guid == primary_guid
                        && kind == benilla_protocol::SpeedKind::Run =>
                {
                    if self
                        .expected_run_speed
                        .is_some_and(|wanted| phases::speed_matches(wanted, speed))
                        && self.speed_ack_seen
                    {
                        ensure!(
                            !self.speed_above_floor
                                || self
                                    .relays
                                    .last()
                                    .is_some_and(|pose| pose[2] > self.floor_z + 2.),
                            "observer speed ACK relay did not preserve airborne pose"
                        );
                        self.expected_run_speed = None;
                        self.evidence.write(json!({"event":"run-speed-observer-confirmed","speed":speed,"guid":guid,"pose":self.relays.last()}))?;
                    }
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
                SessionEvent::LoggedOut => {
                    p.logged_out = true;
                    self.evidence
                        .write(json!({"event":"logout-complete","side":side,"guid":p.guid}))?;
                }
                SessionEvent::LogoutResponse { reason, .. } => {
                    ensure!(reason == 0, "logout refused {reason}")
                }
                SessionEvent::KnockBack {
                    guid,
                    counter,
                    launch,
                } => {
                    let quad = [
                        launch.zspeed,
                        launch.cos_angle,
                        launch.sin_angle,
                        launch.xy_speed,
                    ];
                    ensure!(
                        side == 0
                            && guid == p.guid
                            && self
                                .expected_knockback
                                .is_some_and(|expected| phases::launch_matches(expected, quad)),
                        "unexpected or mismatched server knockback"
                    );
                    let origin = p.pose;
                    p.writer.knock_back_ack(
                        guid,
                        counter,
                        launch,
                        8192,
                        (origin, p.orientation),
                        None,
                    )?;
                    self.knockback = Some(KnockbackReceipt {
                        origin,
                        launch: quad,
                        at: Instant::now(),
                    });
                    self.expected_knockback = None;
                    self.evidence.write(json!({"event":"server-knockback-ack-sent","guid":guid,"counter":counter,"launch":quad,"origin":origin}))?;
                }
                _ => {}
            }
            self.count()?;
        }
        Ok(())
    }
    fn step(&mut self, f: &Fixture, s: &Step) -> Result<()> {
        if let Some(gate) = &s.await_teleport {
            self.teleport = None;
            self.expected_teleport = Some(gate.destination);
            self.evidence.write(json!({"event":"operator-teleport-ready","case":s.name,"destination":gate.destination,"timeout_ms":gate.timeout_ms}))?;
            let deadline = Instant::now() + Duration::from_millis(gate.timeout_ms);
            while self.expected_teleport.is_some() && Instant::now() < deadline {
                self.pump(Duration::from_millis(50))?;
            }
            ensure!(
                self.expected_teleport.is_none() && self.teleport.is_some(),
                "expected server teleport did not arrive"
            );
        }
        if let Some(gate) = &s.await_run_speed {
            self.expected_run_speed = Some(gate.speed);
            self.speed_ack_seen = false;
            self.speed_above_floor = gate.above_floor;
            self.evidence.write(json!({"event":"operator-speed-ready","case":s.name,"run_speed":gate.speed,"timeout_ms":gate.timeout_ms,"above_floor":gate.above_floor}))?;
            let deadline = Instant::now() + Duration::from_millis(gate.timeout_ms);
            while self.expected_run_speed.is_some() && Instant::now() < deadline {
                self.pump(Duration::from_millis(50))?;
            }
            ensure!(
                self.expected_run_speed.is_none(),
                "run-speed ACK/observer confirmation did not arrive"
            );
        }
        if let Some(gate) = &s.await_knockback {
            ensure!(
                self.health.baseline[0].is_some_and(|health| health > 0),
                "live ordinary-avatar health baseline missing"
            );
            self.expected_knockback = Some(gate.launch);
            self.knockback = None;
            self.evidence.write(json!({"event":"operator-knockback-ready","case":s.name,"expected_launch":gate.launch,"timeout_ms":gate.timeout_ms}))?;
            let deadline = Instant::now() + Duration::from_millis(gate.timeout_ms);
            while self.expected_knockback.is_some() && Instant::now() < deadline {
                self.pump(Duration::from_millis(50))?;
            }
            ensure!(
                self.expected_knockback.is_none() && self.knockback.is_some(),
                "expected server knockback did not arrive"
            );
        }
        if let Some(age) = s.wait_knockback_age_ms {
            self.evidence.write(json!({"event":"withholding-landing-until-expiry","age_ms":age,"no_land_or_swim":true}))?;
            while self
                .knockback
                .as_ref()
                .context("knockback clock missing")?
                .at
                .elapsed()
                < Duration::from_millis(age)
            {
                self.pump(Duration::from_millis(200))?;
            }
            self.evidence.write(json!({"event":"knockback-expiry-wait-complete","actual_age_ms":self.knockback.as_ref().unwrap().at.elapsed().as_millis()}))?;
        }
        self.pump(Duration::from_millis(s.delay_ms))?;
        let base = if s.relative_to_knockback {
            self.peers[0].pose
        } else if s.relative_to_teleport {
            self.teleport
                .as_ref()
                .context("server teleport receipt missing")?
                .position
        } else {
            f.origin
        };
        let mut pos = std::array::from_fn(|i| base[i] + s.offset[i]);
        let fall_ms = if s.ballistic_from_knockback {
            let kb = self
                .knockback
                .as_ref()
                .context("actual knockback receipt missing")?;
            let elapsed = kb.at.elapsed();
            pos = phases::ballistic_position(kb.origin, kb.launch, elapsed.as_secs_f64())?;
            pos[2] = pos[2].max(
                self.terrain
                    .as_ref()
                    .context("terrain missing")?
                    .height(pos[0], pos[1])?,
            );
            u32::try_from(elapsed.as_millis())?
        } else if s.fall_from_teleport {
            let elapsed = self.teleport.as_ref().unwrap().at.elapsed();
            pos = phases::fall_position(pos, elapsed.as_secs_f64(), f.origin[2])?;
            u32::try_from(elapsed.as_millis())?
        } else {
            s.fall_ms
        };
        if s.ground_from_knockback || s.terrain_follow {
            pos[2] = self
                .terrain
                .as_ref()
                .context("measured terrain missing")?
                .height(pos[0], pos[1])?;
        }
        self.relays.clear();
        if !s.accept {
            self.forbidden.push((pos, s.clear_flags));
        }
        let quad = if s.ballistic_from_knockback {
            Some(self.knockback.as_ref().unwrap().launch)
        } else {
            s.jump
        };
        let jump = quad.map(|j| JumpInfo {
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
        self.evidence.write(json!({"event":"send","case":s.name,"opcode":s.opcode,"flags":s.flags,"pose":pos,"expected_accept":s.accept,"clear_flags":s.clear_flags}))?;
        let p = &mut self.peers[0];
        p.writer.send_movement(
            s.opcode,
            s.flags,
            pos,
            f.orientation,
            0.,
            fall_ms,
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
            "note":if s.accept {"accepted by world"} else if s.clear_flags!=0 {"no prohibited capability relay; corrected ground pose permitted; recovery and saved pose still required"} else {"no forbidden relay; next recovery and saved pose still required"}}))?;
        Ok(())
    }
}
fn observe_refusal(f: &Fixture, pass: &str, evidence: &mut Evidence) -> Result<()> {
    ensure!(
        !f.create_missing_characters,
        "refusal mode cannot provision characters"
    );
    let auth = benilla_protocol::logon(&f.auth, &f.primary.user, pass)?;
    evidence.write(json!({"event":"srp-authenticated","world_entry_attempted":false}))?;
    let observed_close = |stage: &str, e: anyhow::Error, evidence: &mut Evidence| -> Result<()> {
        let detail = format!("{e:#}");
        ensure!(
            peer_closed(&detail),
            "unexpected refusal failure at {stage}: {detail}"
        );
        evidence.write(json!({"event":"world-peer-close-observed","stage":stage,"detail":detail,
            "attribution":"requires operator inflight/log evidence and prior/post normal controls; EOF alone is not a fence proof"}))
    };
    let mut s =
        match WorldSession::connect_queued(&f.world, &f.primary.user, auth.session_key, &mut |_| {
            false
        }) {
            Ok(s) => s,
            Err(e) => return observed_close("world-auth", e, evidence),
        };
    let chars = match s.char_enum() {
        Ok(chars) => chars,
        Err(e) => return observed_close("character-roster", e, evidence),
    };
    let c = chars
        .iter()
        .find(|c| c.name == f.primary.character)
        .context("declared QA character missing")?;
    s.player_login(c.guid)?;
    for _ in 0..256 {
        match s.recv() {
            Ok(benilla_protocol::ServerPacket::CharacterLoginFailed { result }) => {
                ensure!(result == 1, "unexpected typed character refusal {result}");
                let again = s.char_enum()?;
                ensure!(
                    again.iter().any(|a| a.guid == c.guid),
                    "post-refusal authenticated roster missing"
                );
                evidence.write(json!({"event":"character-login-refused","result":result,"authenticated_roster_survived":true}))?;
                return Ok(());
            }
            Ok(benilla_protocol::ServerPacket::LoginVerifyWorld { .. }) => {
                bail!("unexpected world entry while refusal was required")
            }
            Ok(_) => {}
            Err(e) => return observed_close("character-login", e, evidence),
        }
    }
    bail!("no explicit refusal within packet ceiling")
}

fn execute(f: &Fixture, raw: &[u8], output: &Path, mode: Mode) -> Result<()> {
    ensure!(
        (mode == Mode::ObservePlayer) == f.observation.is_some(),
        "observation fixture and explicit observer-only mode must match"
    );
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
    // Observer-only mode never reads or uses the attended actor's credentials.
    let pass = if mode == Mode::ObservePlayer {
        String::new()
    } else {
        password("WOW_", &f.primary)?
    };
    let observer_pass = password("WOW_OBSERVER_", &f.observer)?;
    let mut evidence = Evidence {
        file: fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(output)?,
        begin: Instant::now(),
    };
    let deadline_ms = 180000 + operator_wait_grace_ms(f);
    evidence.write(json!({"event":"preflight","fixture_sha256":format!("{:x}",Sha256::digest(raw)),"source_commit":f.source_commit,
        "image_digest":f.image_digest,"auth":f.auth,"world":f.world,"database_prefix":f.database_prefix,"canonical_clone":f.canonical_clone,
        "primary":f.primary.user,"observer":f.observer.user,"security_attestation":[f.primary.security,f.observer.security],
        "max_duration_seconds":deadline_ms/1000,"operator_wait_grace_ms":operator_wait_grace_ms(f),
        "max_outbound_packets":128,"combat":false,"mode":format!("{mode:?}")}))?;
    // Independent hard bound also covers a stalled OS connect/read during authentication.
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(deadline_ms));
        eprintln!("movement probe exceeded hard deadline");
        std::process::exit(124);
    });
    if mode == Mode::LoginRefusal {
        return observe_refusal(f, &pass, &mut evidence);
    }
    if mode == Mode::CreateOnly {
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
    if mode == Mode::HoldOnline {
        ensure!(
            !f.create_missing_characters,
            "hold mode cannot provision characters"
        );
    }
    let mut peers = Vec::new();
    if mode == Mode::Movement {
        peers.push(connect(f, &f.observer, &observer_pass, 1, tx.clone())?);
    }
    let (active_id, active_pass) = if mode == Mode::ObservePlayer {
        (&f.observer, &observer_pass)
    } else {
        (&f.primary, &pass)
    };
    peers.insert(0, connect(f, active_id, active_pass, 0, tx)?);
    if let Some(observation) = &f.observation {
        ensure!(
            observation.guid != peers[0].guid,
            "watched player must differ from observer"
        );
    }
    let mut run = Run {
        peers,
        rx,
        evidence,
        forbidden: vec![],
        relays: vec![],
        sent: 0,
        map: f.map,
        expected_teleport: None,
        expected_run_speed: None,
        speed_ack_seen: false,
        speed_above_floor: false,
        floor_z: f.origin[2],
        expected_knockback: None,
        knockback: None,
        terrain: f.terrain.clone(),
        health: Default::default(),
        initial_run_speed: None,
        teleport: None,
        capture: f.observation.as_ref().map(|o| observe::Capture {
            guid: o.guid,
            ..Default::default()
        }),
    };
    run.pump(Duration::from_secs(3))?;
    ensure!(
        run.peers.iter().all(|p| p.entered),
        "all required world entries must be proven"
    );
    ensure!(
        run.health.baseline[0] == Some(60),
        "initial self health60 must be received before actions"
    );
    if f.steps.iter().any(|s| s.await_run_speed.is_some()) {
        phases::require_initial_run_speed(run.initial_run_speed)?;
    }
    ensure!(
        distance(run.peers[0].pose, f.origin) < 0.1
            && (run.peers.len() == 1 || distance(run.peers[1].pose, f.origin) < 20.),
        "initial world pose differs from measured fixture"
    );
    if let Some(observation) = &f.observation {
        run.peers[0].writer.name_query(observation.guid)?;
        run.evidence.write(
            json!({"event":"observer-ready","observer_guid":run.peers[0].guid,
            "watched_guid":observation.guid,"seconds":observation.seconds,
            "voluntary_movement":false,"actor_login":false}),
        )?;
        run.pump(Duration::from_secs(observation.seconds))?;
    } else if mode == Mode::HoldOnline {
        run.evidence.write(json!({"event":"online-hold-ready","guid":run.peers[0].guid,"hold_seconds":f.hold_seconds,"voluntary_movement":false,"economy_requests":false}))?;
        run.pump(Duration::from_secs(f.hold_seconds))?;
    } else {
        for s in &f.steps {
            run.step(f, s)?;
        }
    }
    run.peers[0].writer.logout_request()?;
    run.pump(Duration::from_secs(25))?;
    ensure!(
        run.peers[0].logged_out,
        "world did not confirm primary logout"
    );
    let mut again = session(f, active_id, active_pass)?;
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
    if run.peers.len() == 2 {
        run.peers[1].writer.logout_request()?;
        run.pump(Duration::from_secs(25))?;
        ensure!(run.peers[1].logged_out, "observer logout not confirmed");
    }
    if let Some(capture) = &run.capture {
        run.evidence.write(json!({"event":"observer-complete","watched_guid":capture.guid,
            "moves":capture.moves,"visibility_gaps":capture.gaps,"actor_persistence_verified":false,
            "remaining":"attended actor logout/save and native reason correlation; gaps require separate actor or destination evidence"}))?;
        ensure!(capture.moves > 0, "no watched-player movement observed");
        println!("Bounded observer capture and observer saved pose verified; actor persistence remains separate.");
    } else if mode == Mode::HoldOnline {
        run.evidence
            .write(json!({"event":"online-hold-complete","steps":0}))?;
        println!("Bounded online hold, normal logout and saved pose verified.");
    } else {
        run.evidence.write(json!({"event":"wire-checks-passed","steps":f.steps.len(),"remaining":"correlate isolated server rejection reasons; map/operator fixtures require separate runs"}))?;
        println!("Bounded wire checks passed; isolated server reason evidence is still required.");
    }
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().collect();
    ensure!(
        args.len()==3 || args.len()==4,
        "usage: realm-movement-probe PRIVATE-FIXTURE.json NEW-EVIDENCE.jsonl [--create-only|--hold-online|--expect-login-refusal|--observe-player]"
    );
    let raw = fs::read(&args[1])?;
    ensure!(raw.len() <= 65536, "fixture too large");
    let f: Fixture = serde_json::from_slice(&raw)?;
    validate(&f)?;
    let mode = parse_mode(
        args.get(3)
            .map(|a| a.to_str().context("mode must be UTF-8"))
            .transpose()?,
    )?;
    execute(&f, &raw, Path::new(&args[2]), mode)
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
    fn rejection_proof_distinguishes_removed_flags_from_forbidden_motion() {
        let policy = [([1., 2., 3.], 0x800000)];
        assert!(relay_safe(&policy, [1., 2., 3.], 0));
        assert!(!relay_safe(&policy, [1., 2., 3.], 0x800000));
        assert!(!relay_safe(&policy, [9., 2., 3.], 0x800000));
        assert!(!relay_safe(&[([1., 2., 3.], 0)], [1., 2., 3.], 0));
        assert!(relay_safe(&[([1., 2., 3.], 0)], [2., 2., 3.], 0));
    }
    #[test]
    fn fixture_flight_flag_matches_pinned_cmangos_object_h() {
        let v: Value = serde_json::from_str(include_str!("../fixture.template.json")).unwrap();
        let step = v["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "unauthorized-flight")
            .unwrap();
        assert_eq!(step["flags"], json!(0x800)); // Object.h MOVEFLAG_FLYING, not FLYING_OLD.
    }
    #[test]
    fn explicit_modes_never_fall_back_on_unknown_action() {
        assert_eq!(parse_mode(None).unwrap(), Mode::Movement);
        assert_eq!(parse_mode(Some("--create-only")).unwrap(), Mode::CreateOnly);
        assert_eq!(parse_mode(Some("--hold-online")).unwrap(), Mode::HoldOnline);
        assert_eq!(
            parse_mode(Some("--expect-login-refusal")).unwrap(),
            Mode::LoginRefusal
        );
        assert!(parse_mode(Some("--do-something-else")).is_err());
    }
    #[test]
    fn observer_mode_is_explicit_bounded_and_cannot_include_scripted_actions() {
        assert!(parse_mode(Some("--observe-player")).is_ok());
        let base: Value = serde_json::from_str(include_str!("../fixture.template.json")).unwrap();
        let mut v = base;
        v["isolated"] = json!(true);
        v["source_commit"] = json!("a".repeat(40));
        v["image_digest"] = json!("b".repeat(64));
        v["steps"] = json!([]);
        v["observation"] = json!({"guid":42,"seconds":60});
        let valid = |v: &Value| {
            serde_json::from_value::<Fixture>(v.clone()).is_ok_and(|f| validate(&f).is_ok())
        };
        assert!(valid(&v));
        for guid in [0, u64::MAX] {
            let mut bad = v.clone();
            bad["observation"]["guid"] = json!(guid);
            assert!(!valid(&bad));
        }
        for seconds in [0, 9, 91, 180] {
            let mut bad = v.clone();
            bad["observation"]["seconds"] = json!(seconds);
            assert!(!valid(&bad));
        }
        let mut bad = v.clone();
        bad["create_missing_characters"] = json!(true);
        assert!(!valid(&bad));
        let mut bad = v.clone();
        bad["steps"] = serde_json::from_str::<Value>(include_str!("../fixture.template.json"))
            .unwrap()["steps"]
            .clone();
        assert!(!valid(&bad));
        let f: Fixture = serde_json::from_value(v).unwrap();
        assert!(execute(
            &f,
            &[],
            Path::new("unused-observer-test-output"),
            Mode::Movement
        )
        .unwrap_err()
        .to_string()
        .contains("explicit observer-only mode"));
        assert!(execute(
            &fixture(),
            &[],
            Path::new("unused-observer-test-output"),
            Mode::ObservePlayer
        )
        .unwrap_err()
        .to_string()
        .contains("explicit observer-only mode"));
    }
    #[test]
    fn refusal_classifies_actual_library_peer_eof_but_not_other_failures() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
        });
        let err = WorldSession::connect(&addr.to_string(), "MOVEQAONE", [0; 40])
            .err()
            .expect("closed test peer");
        server.join().unwrap();
        assert!(peer_closed(&format!("{err:#}")));
        for message in [
            "reading world header: timed out",
            "connecting to world server: connection refused",
            "world server refused the session: result 0x15",
            "parsing opcode 0x123: malformed",
        ] {
            assert!(!peer_closed(message));
        }
    }
    #[test]
    fn teleport_phase_requires_exact_bounded_server_gate_then_floor_finish() {
        let mut f = fixture();
        f.steps[1].await_teleport = Some(TeleportGate {
            destination: [1., 2., 8.],
            timeout_ms: 5000,
        });
        f.steps[1].relative_to_teleport = true;
        f.steps[2].relative_to_teleport = true;
        f.steps[2].fall_from_teleport = true;
        validate(&f).unwrap();
        f.steps[1].await_teleport = None;
        assert!(validate(&f).is_err());
        f.steps[1].await_teleport = Some(TeleportGate {
            destination: [1., 2., 14.],
            timeout_ms: 5000,
        });
        assert!(validate(&f).is_err());
        f.steps[1].await_teleport = Some(TeleportGate {
            destination: [1., 2., 8.],
            timeout_ms: 11000,
        });
        assert!(validate(&f).is_err());
        f.steps[1].await_teleport = Some(TeleportGate {
            destination: [2., 2., 8.],
            timeout_ms: 5000,
        });
        assert!(validate(&f).is_err());
        f.steps[1].await_teleport = Some(TeleportGate {
            destination: [1., 2., 8.],
            timeout_ms: 5000,
        });
        f.steps[2].fall_from_teleport = false;
        assert!(validate(&f).is_err());
    }
    #[test]
    fn speed_phases_require_bounded_real_speed_and_airborne_context() {
        let mut f = fixture();
        f.steps[0].await_run_speed = Some(SpeedGate {
            speed: 14.,
            timeout_ms: 10000,
            above_floor: false,
        });
        validate(&f).unwrap();
        f.steps[0].await_run_speed.as_mut().unwrap().speed = f32::NAN;
        assert!(validate(&f).is_err());
        f.steps[0].await_run_speed.as_mut().unwrap().speed = 14.;
        f.steps[0].await_run_speed.as_mut().unwrap().above_floor = true;
        assert!(validate(&f).is_err());
        f.steps[0].await_run_speed.as_mut().unwrap().above_floor = false;
        f.steps[0].await_run_speed.as_mut().unwrap().timeout_ms = 31000;
        assert!(validate(&f).is_err());
    }
    #[test]
    fn knockback_requires_measured_ground_and_real_expiry_boundary() {
        let mut f = fixture();
        f.terrain = Some(phases::TerrainGrid {
            source_file: "0004832.map".into(),
            source_sha256: "a".repeat(64),
            x0: -15.,
            y0: 0.,
            step: 0.5,
            nx: 35,
            ny: 9,
            heights: vec![3.; 315],
        });
        f.steps=serde_json::from_value(json!([
            {"name":"baseline","delay_ms":100,"opcode":183,"flags":0,"offset":[0,0,0],"accept":true},
            {"name":"ballistic","delay_ms":100,"opcode":238,"flags":8192,"offset":[0,0,0],"accept":true,
                "await_knockback":{"launch":[-10,-1,0,10],"timeout_ms":10000},"relative_to_knockback":true,"ballistic_from_knockback":true},
            {"name":"after-expiry","delay_ms":100,"opcode":238,"flags":1,"offset":[39,0,0],"accept":false,
                "relative_to_knockback":true,"wait_knockback_age_ms":61000},
            {"name":"ground-recovery","delay_ms":100,"opcode":183,"flags":0,"offset":[0,0,0],"accept":true,
                "relative_to_knockback":true,"ground_from_knockback":true},
            {"name":"walk-back","delay_ms":100,"opcode":183,"flags":0,"offset":[0,0,0],"accept":true,"terrain_follow":true}
        ])).unwrap();
        validate(&f).unwrap();
        f.steps[1].await_knockback.as_mut().unwrap().timeout_ms = 120000;
        validate(&f).unwrap();
        assert_eq!(operator_wait_grace_ms(&f), 90000);
        f.steps[1].await_knockback.as_mut().unwrap().timeout_ms = 120001;
        assert!(validate(&f).is_err());
        f.steps[1].await_knockback.as_mut().unwrap().timeout_ms = 10000;
        assert_eq!(operator_wait_grace_ms(&f), 0);
        f.steps[2].wait_knockback_age_ms = Some(100);
        assert!(validate(&f).is_err());
        f.steps[2].wait_knockback_age_ms = Some(61000);
        f.terrain = None;
        assert!(validate(&f).is_err());
    }
    #[test]
    fn exact_private_canonical_copy_is_explicit_and_never_mixed() {
        let mut f = fixture();
        f.database_prefix = "classic".into();
        f.canonical_clone = Some(CanonicalClone {
            service_id: "09bb722b-e45b-4b32-923c-9198c8374fa6".into(),
            database_host: "127.0.0.1".into(),
            database_port: 13308,
            source_database_port: 13307,
            source_prefix: "movementqa_".into(),
            schemas: [
                "classicrealmd".into(),
                "classiccharacters".into(),
                "classicmangos".into(),
                "classiclogs".into(),
            ],
            copy_verification_sha256:
                "f86d362c8f1187958b43696ed09b80f70c804b2018750821c5ae4cfac64c94ed".into(),
        });
        validate(&f).unwrap();
        f.canonical_clone.as_mut().unwrap().database_port = 3306;
        assert!(validate(&f).is_err());
        f.canonical_clone.as_mut().unwrap().database_port = 13308;
        f.canonical_clone.as_mut().unwrap().database_host = "realm-db.railway.internal".into();
        assert!(validate(&f).is_err());
        f.canonical_clone.as_mut().unwrap().database_host = "127.0.0.1".into();
        f.canonical_clone.as_mut().unwrap().service_id =
            "59580eed-3a58-4205-a536-078c4d6b561d".into();
        assert!(validate(&f).is_err());
        f.canonical_clone.as_mut().unwrap().service_id =
            "09bb722b-e45b-4b32-923c-9198c8374fa6".into();
        f.canonical_clone.as_mut().unwrap().source_database_port = 3306;
        assert!(validate(&f).is_err());
        f.canonical_clone.as_mut().unwrap().source_database_port = 13307;
        f.canonical_clone.as_mut().unwrap().source_prefix = "classic".into();
        assert!(validate(&f).is_err());
        f.canonical_clone.as_mut().unwrap().source_prefix = "movementqa_".into();
        f.canonical_clone.as_mut().unwrap().schemas[1] = "movementqa_characters".into();
        assert!(validate(&f).is_err());
        f.canonical_clone.as_mut().unwrap().schemas[1] = "classiccharacters".into();
        f.database_prefix = "movementqa_".into();
        assert!(validate(&f).is_err());
        f.database_prefix = "classic".into();
        f.canonical_clone.as_mut().unwrap().copy_verification_sha256 = "a".repeat(64);
        assert!(validate(&f).is_err());
        f.canonical_clone = None;
        assert!(validate(&f).is_err());
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
        f.steps[1].clear_flags = 2;
        assert!(validate(&f).is_err());
        let mut f = fixture();
        f.steps[1].flags = 1;
        f.steps[1].clear_flags = 1;
        assert!(validate(&f).is_err());
        for seconds in [0, 9, 61, 180] {
            let mut f = fixture();
            f.hold_seconds = seconds;
            assert!(validate(&f).is_err());
        }
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
