//! Full Classic movement-mode ACKs for the browser carry; native callers keep their existing API.
use super::{MoveMode, MovementInfo};
use crate::wire::Vector3d;

/// A current mover snapshot. A transport is present only when the player owns an actual ride frame.
#[derive(Debug, Clone, Copy)]
pub struct BrowserModeMovement {
    pub flags: u32,
    pub pos: [f32; 3],
    pub orientation: f32,
    pub pitch: f32,
    pub fall_time: u32,
    pub jump: Option<super::JumpInfo>,
    pub transport: Option<super::TransportPose>,
}

/// Build the body's full GUID/counter/movement layout consumed by the pinned Classic handlers.
pub fn browser_move_mode_ack(
    guid: u64,
    counter: u32,
    mode: MoveMode,
    apply: bool,
    timestamp: u32,
    mut movement: BrowserModeMovement,
) -> std::io::Result<Vec<u8>> {
    const TRANSPORT: u32 = 0x0200_0000;
    const FALLING: u32 = 0x2000;
    // Snapshot state uses the reference bits. Only MovementInfo::write's explicit host
    // adapter projects ROOT for the pinned server; this builder never infers a dialect.
    movement.flags = (movement.flags & !mode.flag()) | if apply { mode.flag() } else { 0 };
    movement.flags = (movement.flags & !TRANSPORT)
        | if movement.transport.is_some() {
            TRANSPORT
        } else {
            0
        };
    if mode == MoveMode::Root && apply {
        movement.flags &= !(0xf | 0xc0 | FALLING | 0x4000 | 0x0400_0000);
        movement.jump = None;
        movement.fall_time = 0;
    }
    if movement.flags & FALLING != 0 && movement.jump.is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "falling mode ACK has no launch tail",
        ));
    }
    if movement.flags & (FALLING | 0x20_0000) == (FALLING | 0x20_0000) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "mode ACK cannot swim and fall simultaneously",
        ));
    }
    let info = MovementInfo {
        flags: movement.flags,
        timestamp,
        position: Vector3d {
            x: movement.pos[0],
            y: movement.pos[1],
            z: movement.pos[2],
        },
        orientation: movement.orientation,
        pitch: movement.pitch,
        fall_time: movement.fall_time,
        jump: movement.jump,
        transport: movement.transport,
    };
    Ok(super::client::move_flag_ack(
        guid,
        counter,
        &info,
        mode.ack_carries_apply().then_some(apply),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{read_u32_le, read_u64_le};

    const ON_TRANSPORT: u32 = 0x0200_0000;
    const FALLING: u32 = 0x2000;
    const SWIMMING: u32 = 0x20_0000;
    const ROOT: u32 = 0x1000;
    const GUID: u64 = 0x1100_ff00_2200_cc01;
    const COUNTER: u32 = 0xaabb_0001;

    fn snapshot(flags: u32) -> BrowserModeMovement {
        BrowserModeMovement {
            flags,
            pos: [100.0, 200.0, 30.0],
            orientation: 1.5,
            pitch: 0.0,
            fall_time: 0,
            jump: None,
            transport: Some(super::super::TransportPose {
                guid: 0x1fc0_0000_0000_ff01,
                pos: Vector3d {
                    x: -2.5,
                    y: 1.25,
                    z: 0.5,
                },
                orientation: 0.25,
            }),
        }
    }

    fn decode(bytes: &[u8]) -> (MovementInfo, &[u8]) {
        let mut rest = bytes;
        assert_eq!(
            read_u64_le(&mut rest).unwrap(),
            GUID,
            "the mover GUID is full, not packed"
        );
        assert_eq!(read_u32_le(&mut rest).unwrap(), COUNTER);
        let info = super::super::movement::read_movement_info(&mut rest).unwrap();
        (info, rest)
    }

    #[test]
    fn moving_transport_mode_ack_keeps_both_coordinate_frames_and_apply_tail() {
        let movement = snapshot(1 | MoveMode::WaterWalk.flag());
        let bytes =
            browser_move_mode_ack(GUID, COUNTER, MoveMode::WaterWalk, true, 123, movement).unwrap();
        let (info, mut tail) = decode(&bytes);
        assert_eq!(info.flags, movement.flags | ON_TRANSPORT);
        assert_eq!(
            [info.position.x, info.position.y, info.position.z],
            movement.pos
        );
        let deck = info.transport.unwrap();
        assert_eq!(deck.guid, movement.transport.unwrap().guid);
        assert_eq!([deck.pos.x, deck.pos.y, deck.pos.z], [-2.5, 1.25, 0.5]);
        assert_eq!(deck.orientation, 0.25);
        assert_eq!(read_u32_le(&mut tail).unwrap(), 1);
        assert!(tail.is_empty());
    }

    #[test]
    fn root_ack_keeps_real_transport_but_ends_motion_without_a_trailing_apply_word() {
        let mut movement = snapshot(ROOT | ON_TRANSPORT | 1 | FALLING | 0x4000);
        movement.fall_time = 1200;
        movement.jump = Some(super::super::JumpInfo {
            zspeed: -10.0,
            cos_angle: 0.0,
            sin_angle: 1.0,
            xy_speed: 10.0,
        });
        let bytes =
            browser_move_mode_ack(GUID, COUNTER, MoveMode::Root, true, 123, movement).unwrap();
        let (info, tail) = decode(&bytes);
        assert_eq!(info.flags, ROOT | ON_TRANSPORT);
        assert_eq!(
            info.transport.unwrap().guid,
            movement.transport.unwrap().guid
        );
        assert!(info.jump.is_none());
        assert_eq!(info.fall_time, 0);
        assert!(
            tail.is_empty(),
            "the pinned root handler reads no apply u32"
        );
    }

    #[test]
    fn falling_transport_mode_ack_preserves_the_exact_launch_and_fall_clock() {
        let mut movement = snapshot(1 | FALLING | MoveMode::FeatherFall.flag());
        movement.fall_time = 1200;
        movement.jump = Some(super::super::JumpInfo {
            zspeed: -10.0,
            cos_angle: 0.0,
            sin_angle: 1.0,
            xy_speed: 10.0,
        });
        let bytes =
            browser_move_mode_ack(GUID, COUNTER, MoveMode::FeatherFall, true, 123, movement)
                .unwrap();
        let (info, mut tail) = decode(&bytes);
        assert_eq!(info.flags, movement.flags | ON_TRANSPORT);
        assert_eq!(info.fall_time, 1200);
        let jump = info.jump.unwrap();
        assert_eq!(
            [jump.zspeed, jump.cos_angle, jump.sin_angle, jump.xy_speed],
            [-10.0, 0.0, 1.0, 10.0]
        );
        assert_eq!(read_u32_le(&mut tail).unwrap(), 1);
        assert!(tail.is_empty());
    }

    #[test]
    fn swimming_mode_ack_carries_pitch_after_the_transport_tail() {
        let mut movement = snapshot(SWIMMING | MoveMode::Hover.flag());
        movement.pitch = -0.4;
        let bytes =
            browser_move_mode_ack(GUID, COUNTER, MoveMode::Hover, true, 123, movement).unwrap();
        let (info, mut tail) = decode(&bytes);
        assert_eq!(info.flags, movement.flags | ON_TRANSPORT);
        assert_eq!(info.pitch, -0.4);
        assert!(info.jump.is_none());
        assert_eq!(read_u32_le(&mut tail).unwrap(), 1);
        assert!(tail.is_empty());
    }

    #[test]
    fn no_actual_ride_never_serializes_an_invented_transport() {
        let mut movement = snapshot(ON_TRANSPORT | MoveMode::WaterWalk.flag());
        movement.transport = None;
        let bytes = browser_move_mode_ack(GUID, COUNTER, MoveMode::WaterWalk, false, 123, movement)
            .unwrap();
        let (info, mut tail) = decode(&bytes);
        assert_eq!(info.flags & ON_TRANSPORT, 0);
        assert!(info.transport.is_none());
        assert_eq!(read_u32_le(&mut tail).unwrap(), 0);
        assert!(tail.is_empty());
    }

    #[test]
    fn at_rest_without_a_ride_matches_the_existing_ack_bytes() {
        let mut movement = snapshot(MoveMode::FeatherFall.flag());
        movement.transport = None;
        let expected = MovementInfo {
            flags: movement.flags,
            timestamp: 123,
            position: Vector3d {
                x: 100.0,
                y: 200.0,
                z: 30.0,
            },
            orientation: 1.5,
            pitch: 0.0,
            fall_time: 0,
            jump: None,
            transport: None,
        };
        assert_eq!(
            browser_move_mode_ack(GUID, COUNTER, MoveMode::FeatherFall, true, 123, movement)
                .unwrap(),
            super::super::client::move_flag_ack(GUID, COUNTER, &expected, Some(true))
        );
    }
}
