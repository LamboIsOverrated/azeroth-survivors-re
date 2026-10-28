//! The host-selected transport profile also selects the pinned core's movement-wire dialect.
//! Client/reference state keeps ROOT=0x1000; pinned CMaNGOS Object.h uses ROOT=0x08000000.
use std::cell::Cell;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Profile {
    Reference,
    Cmangos4d230bb1,
}

thread_local! { static PROFILE: Cell<Profile> = const { Cell::new(Profile::Reference) }; }

/// Set the explicit host profile before starting browser networking. Unknown identities are refused.
pub fn configure_browser_movement_profile(value: Option<&str>) -> std::io::Result<()> {
    let profile = match value {
        None | Some("reference") => Profile::Reference,
        Some("cmangos-classic-4d230bb1") => Profile::Cmangos4d230bb1,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "unsupported browser movement profile",
            ))
        }
    };
    PROFILE.set(profile);
    Ok(())
}

pub(super) fn outgoing(flags: u32) -> u32 {
    if PROFILE.get() == Profile::Cmangos4d230bb1 && flags & 0x1000 != 0 {
        (flags & !0x1000) | 0x0800_0000
    } else {
        flags
    }
}
pub(super) fn incoming(flags: u32) -> u32 {
    if PROFILE.get() == Profile::Cmangos4d230bb1 && flags & 0x0800_0000 != 0 {
        (flags & !0x0800_0000) | 0x1000
    } else {
        flags
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{self, BrowserModeMovement, MoveMode, MovementInfo};
    use crate::wire::Vector3d;

    struct Restore(Profile);
    impl Drop for Restore {
        fn drop(&mut self) {
            PROFILE.set(self.0);
        }
    }
    fn profile(value: &str) -> Restore {
        let old = PROFILE.get();
        configure_browser_movement_profile(Some(value)).unwrap();
        Restore(old)
    }
    fn info(flags: u32) -> MovementInfo {
        MovementInfo {
            flags,
            timestamp: 123,
            position: Vector3d {
                x: 10.0,
                y: 20.0,
                z: 30.0,
            },
            orientation: 0.5,
            transport: None,
            pitch: 0.0,
            fall_time: 0,
            jump: None,
        }
    }
    fn flags_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn pinned_root_ack_next_heartbeat_and_unroot_use_one_wire_dialect() {
        let _profile = profile("cmangos-classic-4d230bb1");
        let state = BrowserModeMovement {
            flags: 0x1000,
            pos: [10.0, 20.0, 30.0],
            orientation: 0.5,
            pitch: 0.0,
            fall_time: 0,
            jump: None,
            transport: Some(messages::TransportPose {
                guid: 0x1fc0_0000_0000_ff01,
                pos: Vector3d {
                    x: -2.5,
                    y: 1.25,
                    z: 0.5,
                },
                orientation: 0.25,
            }),
        };
        let ack = messages::browser_move_mode_ack(1, 2, MoveMode::Root, true, 123, state).unwrap();
        assert_eq!(flags_at(&ack, 12), 0x0800_0000 | 0x0200_0000);
        let mut rooted = info(0x1000 | 0x0200_0000);
        rooted.transport = state.transport;
        let heartbeat = messages::movement(&rooted);
        assert_eq!(flags_at(&heartbeat, 0), 0x0800_0000 | 0x0200_0000);
        let back = messages::movement::read_movement_info(&mut heartbeat.as_slice()).unwrap();
        assert_eq!(back.transport.unwrap().guid, state.transport.unwrap().guid);
        let unroot =
            messages::browser_move_mode_ack(1, 3, MoveMode::Root, false, 124, state).unwrap();
        assert_eq!(flags_at(&unroot, 12) & (0x0800_0000 | 0x1000), 0);
        assert_eq!(flags_at(&unroot, 12) & 0x0200_0000, 0x0200_0000);
    }

    #[test]
    fn shared_movement_writer_projects_stop_speed_and_knockback_acks() {
        let _profile = profile("cmangos-classic-4d230bb1");
        let root = info(0x1000);
        assert_eq!(flags_at(&messages::movement(&root), 0), 0x0800_0000);
        assert_eq!(
            flags_at(&messages::force_speed_ack(1, 2, &root, 7.0), 12),
            0x0800_0000
        );
        assert_eq!(
            flags_at(&messages::knock_back_ack(1, 2, &root), 12),
            0x0800_0000
        );
    }

    #[test]
    fn incoming_pinned_root_returns_to_the_internal_reference_bit() {
        let _profile = profile("cmangos-classic-4d230bb1");
        let bytes = messages::movement(&info(0x0800_0000 | 0x100));
        let back = messages::movement::read_movement_info(&mut bytes.as_slice()).unwrap();
        assert_eq!(back.flags, 0x1000 | 0x100);
    }

    #[test]
    fn incoming_living_update_uses_the_same_internal_root_mapping() {
        let _profile = profile("cmangos-classic-4d230bb1");
        let mut bytes = 1u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&[0, 1, 1, 1, 0x20]); // header, movement update, packed guid1, LIVING
        bytes.extend_from_slice(&messages::movement(&info(0x0800_0000)));
        for speed in [2.5f32, 7.0, 4.5, 4.722, 2.5, std::f32::consts::PI] {
            bytes.extend_from_slice(&speed.to_le_bytes());
        }
        let mut rest = bytes.as_slice();
        let mut updates = messages::update_object::read_update_object(&mut rest).unwrap();
        let messages::update_object::Object::Movement { movement, .. } = updates.remove(0) else {
            panic!("movement update expected");
        };
        assert_eq!(movement.mover.unwrap().flags, 0x1000);
        assert!(rest.is_empty());
    }

    #[test]
    fn reference_bytes_are_unchanged_and_unknown_profile_cannot_fall_through() {
        let _profile = profile("reference");
        let bytes = messages::movement(&info(0x1000 | 0x100));
        assert_eq!(flags_at(&bytes, 0), 0x1000 | 0x100);
        assert!(configure_browser_movement_profile(Some("unknown-core")).is_err());
        assert_eq!(outgoing(0x1000), 0x1000);
        assert_eq!(incoming(0x0800_0000), 0x0800_0000);
    }
}
