//! Browser carry: catch up airborne physics with bounded collision steps; render time stays clamped.
//! The dispatch fence re-enters stable worlds after 1.5 s; the helper's 5 s cap is a second bound.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
use std::time::Duration;

use avian3d::prelude::Collider;
use bevy::platform::time::Instant;
use bevy::prelude::*;

#[path = "browser_movement_clock.rs"]
mod clock;
use clock::{Clock, Frame, Phase};

use super::{mover, swim, Player};

#[derive(Default, PartialEq)]
pub(super) struct BrowserMovement {
    last: Option<Instant>,
    clock: Clock,
    jump: bool,
    authoritative_pose: bool,
}

impl BrowserMovement {
    pub fn poll(&mut self, rendered: Duration) -> Duration {
        let now = Instant::now();
        self.last
            .replace(now)
            .map_or(rendered, |last| now.saturating_duration_since(last))
    }

    pub fn recovering(&self) -> bool {
        self.clock.recovering()
    }

    pub fn reset_arc(&mut self) {
        self.clock.reset_arc();
    }

    pub fn authoritative_arc(&mut self, age: u32) {
        self.clock.set_arc(Duration::from_millis(u64::from(age)));
        self.authoritative_pose = true;
    }
}

pub(super) fn finish_frame(player: &mut Player, jumped: bool, swimming: bool) {
    if jumped || swimming {
        player.browser_movement.reset_arc();
    }
    if swimming {
        player.knock_arc = false;
        player.arc_dirs_set = false;
    }
}

pub(crate) fn browser_reentry(player: &mut Player) {
    if let Frame::Recover { request: true } = player.browser_movement.clock.recover::<()>() {
        request_reentry();
    }
}

pub(super) struct Input {
    pub moving: bool,
    pub dir: Vec3,
    pub speed: f32,
    pub jump: bool,
    pub wire_jump: bool,
    pub launch: Option<Vec3>,
    pub water_floor: Option<f32>,
    pub nudge_speed: f32,
}

/// Returns no pose when recovery owns the session; callers must send no movement or ACK.
pub(super) fn step(
    player: &mut Player,
    time: &Time,
    real: Duration,
    world: &benilla_world::collision::WorldCollision<'_, '_>,
    points: &benilla_world::world_point::WorldPoint<'_, '_>,
    capsule: &Collider,
    input: Input,
) -> Option<(mover::Outcome, Option<u32>)> {
    let mut movement = std::mem::take(&mut player.browser_movement);
    let real = if std::mem::take(&mut movement.authoritative_pose) {
        Duration::ZERO
    } else {
        real
    };
    let airborne = player.airborne_since.is_some() && !player.settling && !player.modes.rooted;
    let launch = input.launch.is_some();
    // Replaying through a moving coordinate frame needs its historical transform. Re-enter
    // instead of integrating several seconds against only the current deck pose.
    let frame = if airborne && player.ride.is_some() && real > Duration::from_millis(250) && !launch
    {
        movement.clock.recover()
    } else {
        let jump = std::mem::take(&mut movement.jump) || input.jump;
        let wire_jump = input.wire_jump;
        let arc_start = player.airborne_since.unwrap_or(time.elapsed_secs());
        let replaying = airborne && real > Duration::from_millis(50);
        let frame = movement
            .clock
            .advance(real, time.delta(), airborne, launch, |tick| {
                let current = tick.phase != Phase::History;
                let mut step_time = Time::default();
                let now = arc_start + tick.age.as_secs_f32();
                step_time.advance_by(Duration::from_secs_f32(
                    (now - tick.dt.as_secs_f32()).max(0.0),
                ));
                step_time.advance_by(tick.dt);
                let mut outcome = mover::step(
                    player,
                    &step_time,
                    world,
                    capsule,
                    current && input.moving,
                    input.dir,
                    input.speed,
                    current && jump && !replaying,
                    current && wire_jump && !replaying,
                    (tick.phase == Phase::Launch)
                        .then_some(input.launch)
                        .flatten(),
                    input.water_floor,
                    input.nudge_speed,
                );
                let in_air =
                    !outcome.held && !player.modes.rooted && (!outcome.grounded || outcome.jumped);
                if in_air && !outcome.jumped {
                    let surface = swim::surface_over_feet(points, player.pos);
                    if swim::update_swimming(player, surface, now) {
                        player.knock_arc = false;
                        player.arc_dirs_set = false;
                        player.vel_y = 0.0;
                        player.horiz_vel = Vec3::ZERO;
                        outcome.grounded = false;
                        return (outcome, false);
                    }
                }
                (outcome, in_air)
            });
        // A press made on the resume frame belongs to now, never to historical airborne ticks.
        // If history lands first, preserve a keyboard edge for the following grounded frame.
        // Hover's wire launch is never buffered: the reference refuses it while falling.
        let landed =
            matches!(&frame, Frame::Moved { value, .. } if value.grounded || player.swimming);
        if landed && replaying {
            movement.jump |= jump;
        }
        frame
    };
    player.browser_movement = movement;
    match frame {
        Frame::Moved {
            value,
            mut fall_time,
        } => {
            if value.jumped {
                player.browser_movement.reset_arc();
                if !value.knocked {
                    player.knock_arc = false;
                }
                fall_time = Some(0);
            }
            // Keep the existing arc/swim/FALLING_FAR consumers in their virtual-clock domain,
            // but make their elapsed flight time agree with the real-time physics we integrated.
            if let Some(ms) = fall_time {
                if player.airborne_since.is_some() && !value.jumped {
                    player.airborne_since = Some(time.elapsed_secs() - ms as f32 / 1000.0);
                }
            }
            Some((value, fall_time))
        }
        Frame::Recover { request } => {
            if request {
                request_reentry();
            }
            None
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn request_reentry() {
    // Close the old sockets before loading another client. This follows disconnect semantics;
    // it sends neither a combat logout shortcut nor a client-authored correction/teleport.
    benilla_protocol::transport::web::close_for_world_reentry();
    show_reentry();
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(inline_js = "
export function show_reentry() {
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#10121bee;color:white;font:18px system-ui;padding:24px;text-align:center';
  status.textContent = 'Your game paused during movement. Reconnecting to the realm…';
  document.body.appendChild(status);
  window.setTimeout(() => window.location.reload(), 100);
}
")]
extern "C" {
    fn show_reentry();
}

#[cfg(not(target_arch = "wasm32"))]
fn request_reentry() {}

#[cfg(test)]
mod tests {
    use super::*;
    use avian3d::prelude::{PhysicsPlugins, RigidBody};
    use bevy::ecs::system::RunSystemOnce;

    fn flat_world() -> App {
        let mut app = App::new();
        app.init_resource::<benilla_world::collision::MoverTraceExclusions>();
        app.add_plugins((
            MinimalPlugins,
            bevy::transform::TransformPlugin,
            bevy::asset::AssetPlugin::default(),
            bevy::scene::ScenePlugin,
            PhysicsPlugins::new(bevy::app::PostUpdate),
        ));
        app.init_asset::<Mesh>();
        benilla_world::world_point::init_world_point_resources(app.world_mut());
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(200.0, 1.0, 200.0),
            Transform::from_xyz(0.0, -0.5, 0.0),
        ));
        app.update();
        app
    }

    fn time(elapsed_ms: u64, delta_ms: u64) -> Time {
        let mut time = Time::default();
        time.advance_by(Duration::from_millis(100000 + elapsed_ms - delta_ms));
        time.advance_by(Duration::from_millis(delta_ms));
        time
    }

    fn input() -> Input {
        Input {
            moving: false,
            dir: Vec3::X,
            speed: 7.0,
            jump: false,
            wire_jump: false,
            launch: None,
            water_floor: None,
            nudge_speed: super::super::AIR_NUDGE_SPEED,
        }
    }

    #[test]
    fn actual_collision_catchup_lands_once_without_replaying_grounded_input() {
        flat_world()
            .world_mut()
            .run_system_once(
                |world: benilla_world::collision::WorldCollision,
                 points: benilla_world::world_point::WorldPoint| {
                    let capsule = Collider::capsule(
                        super::super::CAPSULE_RADIUS,
                        super::super::CAPSULE_HEIGHT - 2.0 * super::super::CAPSULE_RADIUS,
                    );
                    let mut player = Player::default();
                    let mut launch = input();
                    launch.launch = Some(Vec3::new(10.0, 10.0, 0.0));
                    let (out, fall_time) = step(
                        &mut player,
                        &time(250, 250),
                        Duration::from_millis(250),
                        &world,
                        &points,
                        &capsule,
                        launch,
                    )
                    .unwrap();
                    assert!(out.knocked && out.jumped);
                    assert_eq!(fall_time, Some(0));
                    assert_eq!(
                        player.pos,
                        Vec3::ZERO,
                        "the launch ACK contains its launch pose"
                    );
                    player.advance_airborne_arc(true, true, 100.25, 0.0);
                    let mut resumed = input();
                    resumed.moving = true;
                    resumed.speed = 100.0;
                    resumed.jump = true;
                    let (out, fall_time) = step(
                        &mut player,
                        &time(500, 250),
                        Duration::from_millis(1400),
                        &world,
                        &points,
                        &capsule,
                        resumed,
                    )
                    .unwrap();
                    assert!(out.grounded && !out.jumped && !out.knocked);
                    assert!(
                        player.pos.y.abs() < 0.05,
                        "real collider touchdown: {:?}",
                        player.pos
                    );
                    assert!(
                        (player.pos.x - 10.5).abs() < 0.6,
                        "no 100 yd/s grounded travel after touchdown: {:?}",
                        player.pos
                    );
                    assert!(
                        (1000..=1200).contains(&fall_time.unwrap()),
                        "real flight duration, not the clamped 250 ms"
                    );
                    assert!(player.advance_airborne_arc(false, false, 100.5, 0.0).landed);
                    assert!(
                        !player.advance_airborne_arc(false, false, 100.5, 0.0).landed,
                        "landing is one edge"
                    );
                    let (out, _) = step(
                        &mut player,
                        &time(516, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        input(),
                    )
                    .unwrap();
                    assert!(
                        out.jumped && !out.knocked,
                        "the resume jump edge is consumed once after touchdown"
                    );
                },
            )
            .unwrap();
    }

    #[test]
    fn actual_airborne_catchup_matches_ballistics_without_unclamping_render_time() {
        flat_world()
            .world_mut()
            .run_system_once(
                |world: benilla_world::collision::WorldCollision,
                 points: benilla_world::world_point::WorldPoint| {
                    let capsule = Collider::capsule(
                        super::super::CAPSULE_RADIUS,
                        super::super::CAPSULE_HEIGHT - 2.0 * super::super::CAPSULE_RADIUS,
                    );
                    let mut player = Player::default();
                    let mut launch = input();
                    launch.launch = Some(Vec3::new(10.0, 35.0, 0.0));
                    step(
                        &mut player,
                        &time(16, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        launch,
                    )
                    .unwrap();
                    player.advance_airborne_arc(true, true, 100.016, 0.0);
                    let render_time = time(266, 250);
                    let (out, fall_time) = step(
                        &mut player,
                        &render_time,
                        Duration::from_secs(3),
                        &world,
                        &points,
                        &capsule,
                        input(),
                    )
                    .unwrap();
                    assert!(!out.grounded && !out.jumped && !out.knocked);
                    assert!((player.pos.x - 30.0).abs() < 0.01);
                    let expected_y = 35.0 * 3.0 - 0.5 * super::super::GRAVITY * 9.0;
                    assert!(
                        (player.pos.y - expected_y).abs() < 0.02,
                        "{:?} versus ballistic Y {expected_y}",
                        player.pos
                    );
                    assert_eq!(fall_time, Some(3000));
                    assert!(
                        (render_time.elapsed_secs() - player.airborne_since.unwrap() - 3.0).abs()
                            < 0.001
                    );
                    assert_eq!(render_time.delta(), Duration::from_millis(250));
                },
            )
            .unwrap();
    }

    #[test]
    fn ambiguous_launch_recovery_is_latched_before_any_mover_or_ack_state() {
        flat_world()
            .world_mut()
            .run_system_once(
                |world: benilla_world::collision::WorldCollision,
                 points: benilla_world::world_point::WorldPoint| {
                    let capsule = Collider::capsule(
                        super::super::CAPSULE_RADIUS,
                        super::super::CAPSULE_HEIGHT - 2.0 * super::super::CAPSULE_RADIUS,
                    );
                    let mut player = Player::default();
                    for gap in [Duration::from_secs(90), Duration::from_millis(16)] {
                        let mut launch = input();
                        launch.launch = Some(Vec3::new(10.0, 10.0, 0.0));
                        assert!(step(
                            &mut player,
                            &time(250, 250),
                            gap,
                            &world,
                            &points,
                            &capsule,
                            launch
                        )
                        .is_none());
                        assert_eq!(player.pos, Vec3::ZERO);
                        assert!(!player.knock_arc && player.airborne_since.is_none());
                        assert!(player.browser_movement.recovering());
                    }
                },
            )
            .unwrap();
    }

    #[test]
    fn actual_relaunch_authoritative_pose_and_present_air_input_keep_arc_boundaries() {
        flat_world()
            .world_mut()
            .run_system_once(
                |world: benilla_world::collision::WorldCollision,
                 points: benilla_world::world_point::WorldPoint| {
                    let capsule = Collider::capsule(
                        super::super::CAPSULE_RADIUS,
                        super::super::CAPSULE_HEIGHT - 2.0 * super::super::CAPSULE_RADIUS,
                    );
                    let mut player = Player {
                        airborne_since: Some(99.2),
                        vel_y: -1.0,
                        ..Default::default()
                    };
                    player
                        .browser_movement
                        .clock
                        .set_arc(Duration::from_millis(800));
                    let mut jump = input();
                    jump.jump = true;
                    let (out, fall_time) = step(
                        &mut player,
                        &time(16, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        jump,
                    )
                    .unwrap();
                    assert!(out.jumped);
                    assert_eq!(
                        fall_time,
                        Some(0),
                        "a touchdown re-jump never inherits the previous 800 ms arc"
                    );

                    let mut player = Player {
                        pos: Vec3::new(20.0, 80.0, 0.0),
                        airborne_since: Some(98.016),
                        vel_y: -28.58221,
                        horiz_vel: Vec3::X * 10.0,
                        ..Default::default()
                    };
                    player.browser_movement.authoritative_arc(2000);
                    let before = player.pos;
                    let (_, fall_time) = step(
                        &mut player,
                        &time(16, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        input(),
                    )
                    .unwrap();
                    assert_eq!(fall_time, Some(2000));
                    assert_eq!(
                        player.pos, before,
                        "authoritative self pose already includes the preceding frame"
                    );
                    let (_, fall_time) = step(
                        &mut player,
                        &time(32, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        input(),
                    )
                    .unwrap();
                    assert_eq!(fall_time, Some(2016));
                    assert!(player.pos.x > before.x && player.pos.y < before.y);

                    let mut player = Player::default();
                    let mut jump = input();
                    jump.jump = true;
                    step(
                        &mut player,
                        &time(16, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        jump,
                    )
                    .unwrap();
                    player.advance_airborne_arc(true, true, 100.016, 0.0);
                    let mut present = input();
                    present.moving = true;
                    present.jump = true;
                    let (out, _) = step(
                        &mut player,
                        &time(116, 100),
                        Duration::from_millis(100),
                        &world,
                        &points,
                        &capsule,
                        present,
                    )
                    .unwrap();
                    assert!(out.air_nudged && !out.jumped);
                    assert_eq!(
                        player.pos.x, 0.0,
                        "current input never moves through historical ticks"
                    );
                    assert!((player.horiz_vel.x - super::super::AIR_NUDGE_SPEED).abs() < 0.001);
                    assert!(
                        !player.browser_movement.jump,
                        "an airborne Space edge must not become a future automatic jump"
                    );
                },
            )
            .unwrap();
    }

    #[test]
    fn refused_airborne_hover_launch_never_becomes_a_later_keyboard_jump() {
        flat_world()
            .world_mut()
            .run_system_once(
                |world: benilla_world::collision::WorldCollision,
                 points: benilla_world::world_point::WorldPoint| {
                    let capsule = Collider::capsule(
                        super::super::CAPSULE_RADIUS,
                        super::super::CAPSULE_HEIGHT - 2.0 * super::super::CAPSULE_RADIUS,
                    );
                    let mut player = Player::default();
                    let mut launch = input();
                    launch.launch = Some(Vec3::new(10.0, 10.0, 0.0));
                    step(
                        &mut player,
                        &time(16, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        launch,
                    )
                    .unwrap();
                    player.advance_airborne_arc(true, true, 100.016, 0.0);
                    let mut hover = input();
                    hover.wire_jump = true;
                    let (out, _) = step(
                        &mut player,
                        &time(266, 250),
                        Duration::from_millis(1400),
                        &world,
                        &points,
                        &capsule,
                        hover,
                    )
                    .unwrap();
                    assert!(out.grounded && !out.jumped);
                    player.advance_airborne_arc(false, false, 100.266, 0.0);
                    let (out, _) = step(
                        &mut player,
                        &time(282, 16),
                        Duration::from_millis(16),
                        &world,
                        &points,
                        &capsule,
                        input(),
                    )
                    .unwrap();
                    assert!(!out.jumped && !out.knocked);
                },
            )
            .unwrap();
    }
}
