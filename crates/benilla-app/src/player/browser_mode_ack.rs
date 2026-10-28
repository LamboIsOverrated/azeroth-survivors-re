//! Browser mode ACKs report the same current mover state as its ordinary movement stream.
use benilla_assets::coords::bevy_to_wow;
use benilla_protocol::{messages::BrowserModeMovement, JumpInfo};

use super::{move_flags, movement_net, Player};

pub(super) fn snapshot(player: &Player, now: f32) -> BrowserModeMovement {
    let locomotion = move_flags::ANY_MOVE
        | move_flags::TURN_LEFT
        | move_flags::TURN_RIGHT
        | move_flags::WALK_MODE
        | move_flags::FALLING
        | move_flags::FALLING_FAR
        | move_flags::SWIMMING;
    // Only carry flags for which this snapshot has a Classic wire tail, as the move stream does.
    let mut flags = (player.move_flags & locomotion) | player.modes.wire_flags();
    if player.swimming {
        flags = (flags | move_flags::SWIMMING) & !(move_flags::FALLING | move_flags::FALLING_FAR);
    } else {
        flags &= !move_flags::SWIMMING;
        if player.airborne_since.is_some() && !player.modes.rooted {
            flags |= move_flags::FALLING;
            flags &= !move_flags::FALLING_FAR;
            if player.fall_far {
                flags |= move_flags::FALLING_FAR;
            }
        } else {
            flags &= !(move_flags::FALLING | move_flags::FALLING_FAR);
        }
    }
    if player.modes.rooted {
        flags &= !(move_flags::ANY_MOVE | move_flags::FALLING | move_flags::FALLING_FAR);
    }
    let facing = player.face_yaw.rem_euclid(std::f32::consts::TAU);
    let jump = (flags & move_flags::FALLING != 0).then(|| {
        let velocity = bevy_to_wow(player.horiz_vel);
        let xy_speed = velocity[0].hypot(velocity[1]);
        let (cos_angle, sin_angle) = if xy_speed > 1.0e-4 {
            (velocity[0] / xy_speed, velocity[1] / xy_speed)
        } else {
            (facing.cos(), facing.sin())
        };
        JumpInfo {
            zspeed: -player.jump_zspeed,
            cos_angle,
            sin_angle,
            xy_speed,
        }
    });
    BrowserModeMovement {
        flags,
        pos: bevy_to_wow(player.pos),
        orientation: facing,
        pitch: player.browser_mode_pitch,
        fall_time: player
            .airborne_since
            .map_or(0, |start| ((now - start).max(0.0) * 1000.0) as u32),
        jump,
        // This is the actual deck-local frame, never derived from a GUID or world position.
        transport: movement_net::wire_transport(player),
    }
}
