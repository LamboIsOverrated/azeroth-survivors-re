//! The browser confirms its mover only after an in-world self create, before position reports.
//! `SMSG_LOGIN_VERIFY_WORLD` precedes Map::Add; its matching self create follows AddToWorld.

use bevy::prelude::*;

use crate::net::{
    ClientCommand, ClientControlMessage, Embodied, Guid, KnockBackMessage, MoveModeMessage,
    NetCommands, SelfGuid, SelfPlayer, SpeedChangeMessage, WorldportMessage,
};

use super::browser_entry_state::{matches_body, transport_frame, Context, EntryClaim, Held};
use super::{camera::FlyCam, Player, PlayerRide, SETTLE_TIMEOUT};

#[derive(Default, PartialEq)]
pub(super) struct BrowserEntry {
    claim: EntryClaim,
    self_guid: Option<u64>,
    own_body: Option<u64>,
    embodied: Option<u64>,
    transition_pending: bool,
    classification_pending: bool,
    transport_pending: bool,
    pub(super) modes: Held<MoveModeMessage>,
    pub(super) speeds: Held<SpeedChangeMessage>,
    pub(super) knocks: Held<(KnockBackMessage, bevy::platform::time::Instant)>,
}

impl BrowserEntry {
    pub(super) fn can_report(&self, mover: Option<u64>) -> bool {
        !self.transition_pending
            && !self.classification_pending
            && !self.transport_pending
            && self.claim.can_report(mover, self.embodied)
    }

    pub(super) fn matches_body(&self, mover: Option<u64>) -> bool {
        matches_body(mover, self.embodied)
    }

    pub(super) fn self_guid(&self) -> Option<u64> {
        self.self_guid
    }

    pub(super) fn control_claim(&mut self, guid: u64) -> bool {
        self.claim
            .note_control_claim(guid, self.self_guid, self.own_body)
    }

    pub(super) fn controls_applied(&mut self) {
        self.transition_pending = false;
    }

    pub(super) fn defer_for_classification(&mut self) {
        self.classification_pending = true;
    }
}

/// Independent message readers observe the frame without consuming the controller's handlers.
/// The queries are fresh after the net-stage purge and deferred embodiment marker writes.
pub(super) fn observe(
    mut player: ResMut<Player>,
    self_guid: Res<SelfGuid>,
    own_body: Query<&Guid, With<SelfPlayer>>,
    embodied: Query<(&Guid, &Transform, Option<&crate::transport::TransportRider>), With<Embodied>>,
    boats: Query<(Entity, &Guid, &Transform), With<crate::transport::Transport>>,
    mut cameras: Query<&mut FlyCam, With<Camera>>,
    time: Res<Time>,
    mut worlds: MessageReader<WorldportMessage>,
    mut controls: MessageReader<ClientControlMessage>,
    net: Res<NetCommands>,
) {
    let mover_guid = player.foreign_mover.or(self_guid.0);
    let control_lost = player.control_lost;
    let seating = !player.active || player.reseat;
    let world_changed = worlds.read().count() != 0;
    if world_changed {
        player.knockback = None;
        player.hover_launch = false;
        player.server_riding = false;
    }
    let entry = &mut player.browser_entry;
    let was_unclassified = entry.classification_pending;
    entry.classification_pending = false;
    if world_changed {
        entry.claim.begin_world();
        entry.modes = Held::default();
        entry.speeds = Held::default();
        entry.knocks = Held::default();
    }
    entry.self_guid = self_guid.0;
    entry.own_body = own_body.single().ok().map(|guid| guid.0);
    let body = embodied.single().ok();
    entry.embodied = body.map(|(guid, ..)| guid.0);
    entry.transition_pending = controls.read().count() != 0;
    let context = Context {
        self_guid: entry.self_guid,
        own_body_guid: entry.own_body,
        mover_guid,
        mover_body_guid: entry.embodied,
        control_lost,
        control_transition_pending: entry.transition_pending,
    };
    let claim = entry.claim.claim_if_ready(context);
    if let Some(guid) = claim {
        super::move_trace::mover_claim("SET_ACTIVE_MOVER (in-world body)", guid);
        let _ = net.0.send(ClientCommand::SetActiveMover { guid });
    }
    let adopt_frame = seating || claim.is_some() || entry.transport_pending || was_unclassified;
    let rider = body.and_then(|(_, _, rider)| rider);
    let frame = transport_frame(
        rider.map(|r| r.transport_guid),
        rider.and_then(|r| {
            boats.iter().find_map(|(entity, guid, transform)| {
                (guid.0 == r.transport_guid).then(|| {
                    let local_pos = benilla_assets::coords::wow_to_bevy(r.local_pos);
                    let boat_yaw = super::server_ride::yaw_of(transform.rotation);
                    (
                        guid.0,
                        (
                            PlayerRide {
                                entity,
                                guid: guid.0,
                                local_pos,
                                boat_yaw,
                            },
                            transform.translation + transform.rotation * local_pos,
                            r.local_orientation + boat_yaw,
                        ),
                    )
                })
            })
        }),
    );
    if adopt_frame {
        entry.transport_pending = frame.is_err();
    }
    // Classify any new body's spline in server_ride after its pose is seated. A handoff handled
    // later inside wire_in instead waits one frame, keeping all movement obligations held.
    if let Ok(mut cam) = cameras.single_mut() {
        seize_verified(
            &mut player,
            &mut cam,
            &time,
            self_guid.0,
            body.map(|(_, transform, _)| {
                (
                    transform.translation,
                    super::server_ride::yaw_of(transform.rotation),
                )
            }),
        );
        if adopt_frame && player.browser_entry.can_report(mover_guid) {
            // Only the matching self create's typed rider and an actually streamed matching
            // deck authorize this frame; no inferred transport GUID or local coordinates.
            match frame {
                Ok(Some((ride, world_pos, facing))) => {
                    let dyaw = super::wrap_pi(facing - player.face_yaw);
                    player.pos = world_pos;
                    player.face_yaw = facing;
                    player.model_yaw = super::wrap_pi(player.model_yaw + dyaw);
                    cam.yaw += dyaw;
                    player.ride = Some(ride);
                }
                Ok(None) => player.ride = None,
                Err(()) => unreachable!("transport_pending holds reports without an actual frame"),
            }
        }
    }
}

/// Seat only the actual claimed body, before applying this frame's authoritative snaps/modes.
pub(super) fn seize_verified(
    player: &mut Player,
    cam: &mut FlyCam,
    time: &Time,
    self_guid: Option<u64>,
    self_pose: Option<(Vec3, f32)>,
) -> bool {
    let mover = player.foreign_mover.or(self_guid);
    if !player.browser_entry.matches_body(mover)
        || !player.browser_entry.can_report(mover)
        || (player.active && !player.reseat)
    {
        return false;
    }
    let Some((pos, yaw)) = self_pose else {
        return false;
    };
    let first = !player.active;
    player.reseat = false;
    if !first {
        player.server_riding = false;
        player.vel_y = 0.0;
        player.horiz_vel = Vec3::ZERO;
        player.move_flags = 0;
        player.autorun = false;
        player.airborne_since = None;
        player.fall_far = false;
        player.fall_start_y = pos.y;
        player.ride = None;
        player.modes = Default::default();
    }
    player.pos = pos;
    player.active = true;
    if first {
        player.settling = true;
        player.settle_since = time.elapsed_secs();
        player.settle_deadline = time.elapsed_secs() + SETTLE_TIMEOUT;
        player.world_stale = true;
        cam.yaw = yaw;
        cam.pitch = player.login_pitch.unwrap_or(-0.45);
    }
    player.face_yaw = yaw;
    player.model_yaw = yaw;
    player.last_facing = yaw.rem_euclid(std::f32::consts::TAU);
    !first
}

/// Called in packet order, before the worldport handler: rows preceding the boundary cannot
/// become new-world obligations merely because the character GUID is unchanged. Initial login
/// verifies the world before SendInitialPacketsBeforeAddToMap, so its new grants remain queued.
pub(crate) fn discard_before_world_entry(
    world: &mut World,
    event: &benilla_protocol::SessionEvent,
) {
    if matches!(event, benilla_protocol::SessionEvent::Worldport { .. }) {
        world.resource_mut::<Messages<MoveModeMessage>>().clear();
        world.resource_mut::<Messages<SpeedChangeMessage>>().clear();
        world.resource_mut::<Messages<KnockBackMessage>>().clear();
    }
}
