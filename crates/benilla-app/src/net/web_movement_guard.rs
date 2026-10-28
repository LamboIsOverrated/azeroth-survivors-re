//! A browser pause is resolved before queued movement receives a new wire timestamp.
use std::time::Duration;

// SMSG_MOVE_KNOCK_BACK has no issue time; beyond the trajectory window its next dispatch
// cannot distinguish a new launch from one the browser queued while suspended.
const COHERENT_GAP: Duration = Duration::from_millis(1500);
const TRANSPORT_GAP: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dispatch {
    Open,
    Recover,
    Blocked,
}

#[derive(Clone, Copy)]
pub(crate) struct WorldFrame {
    pub active: bool,
    pub in_world: bool,
    pub settling: bool,
    pub stale: bool,
    pub covered: bool,
}

#[derive(Default)]
#[cfg_attr(target_arch = "wasm32", derive(bevy::prelude::Resource))]
pub(crate) struct FrameGate {
    last: Option<(Duration, bool)>,
    blocked: bool,
    revealed: bool,
}

impl FrameGate {
    pub fn sample_world(
        &mut self,
        now: Duration,
        world: WorldFrame,
        airborne_transport: bool,
    ) -> Dispatch {
        let stable = world.active && world.in_world && !world.settling && !world.stale;
        // Physical residency can finish before the initial cover's models/UI. Start only at
        // its stable reveal; a later cover cannot waive an already-played session's fence.
        if !world.active || !world.in_world {
            self.revealed = false;
        } else if stable && !world.covered {
            self.revealed = true;
        }
        self.sample(now, stable && self.revealed, airborne_transport)
    }

    pub fn sample(
        &mut self,
        now: Duration,
        stable_world: bool,
        airborne_transport: bool,
    ) -> Dispatch {
        if self.blocked {
            return Dispatch::Blocked;
        }
        let previous = self.last.replace((now, stable_world));
        // An attached airborne mover needs the deck's old transforms to replay a longer gap.
        let limit = if airborne_transport {
            TRANSPORT_GAP
        } else {
            COHERENT_GAP
        };
        if previous.is_some_and(|(last, was_stable)| {
            was_stable && stable_world && now.saturating_sub(last) > limit
        }) {
            self.blocked = true;
            return Dispatch::Recover;
        }
        Dispatch::Open
    }

    pub fn blocked(&self) -> bool {
        self.blocked
    }

    pub fn discard_if_blocked<T>(&self, commands: impl Iterator<Item = T>) -> bool {
        if self.blocked() {
            commands.for_each(drop);
            true
        } else {
            false
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) fn guard_before_dispatch(
    mut gate: bevy::prelude::ResMut<FrameGate>,
    time: bevy::prelude::Res<bevy::prelude::Time<bevy::prelude::Real>>,
    mut player: bevy::prelude::ResMut<crate::player::Player>,
    state: bevy::prelude::Res<bevy::prelude::State<crate::char_select::ClientState>>,
    screen: bevy::prelude::Res<crate::loading_screen::LoadingScreen>,
) {
    let world = WorldFrame {
        active: player.active,
        in_world: matches!(state.get(), crate::char_select::ClientState::InWorld),
        settling: player.settling,
        stale: player.world_stale,
        covered: screen.covering(),
    };
    let airborne_transport = player.riding().is_some()
        && player.move_flags() & crate::creature_anim::move_flags::FALLING != 0;
    let previous = gate.last;
    let now = time.elapsed();
    if gate.sample_world(now, world, airborne_transport) == Dispatch::Recover {
        let (last, previous_eligible) = previous.expect("recovery requires an earlier frame");
        let current_eligible = gate.last.is_some_and(|(_, eligible)| eligible);
        let limit = if airborne_transport {
            TRANSPORT_GAP
        } else {
            COHERENT_GAP
        };
        bevy::log::info!(
            "browser movement recovery: reason=frame_gap gap_ms={} limit_ms={} \
             previous_eligible={} current_eligible={} covered={} settling={} stale={} \
             active={} attached_airborne={}",
            now.saturating_sub(last).as_millis(),
            limit.as_millis(),
            previous_eligible,
            current_eligible,
            world.covered,
            world.settling,
            world.stale,
            world.active,
            airborne_transport,
        );
        crate::player::browser_reentry(&mut player);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    fn settled(covered: bool) -> WorldFrame {
        WorldFrame {
            active: true,
            in_world: true,
            settling: false,
            stale: false,
            covered,
        }
    }

    #[test]
    fn covered_entry_after_hold_release_does_not_arm_a_pause_deadline() {
        let mut gate = FrameGate::default();
        let holding = WorldFrame {
            settling: true,
            stale: true,
            ..settled(true)
        };
        assert_eq!(gate.sample_world(ms(0), holding, false), Dispatch::Open);
        // The public failure: the hold ended but5073/5079 units still kept the cover up.
        for now in [25000, 25016, 28400, 31800, 186000] {
            assert_eq!(
                gate.sample_world(ms(now), settled(true), false),
                Dispatch::Open
            );
        }
        assert!(!gate.blocked());
    }

    #[test]
    fn first_revealed_frame_starts_a_fresh_baseline_after_the_covered_load() {
        let mut gate = FrameGate::default();
        assert_eq!(
            gate.sample_world(ms(0), settled(true), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(16), settled(true), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(186000), settled(false), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(187500), settled(false), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(189001), settled(false), false),
            Dispatch::Recover
        );
    }

    #[test]
    fn later_cover_cannot_waive_a_pause_after_the_world_has_been_revealed() {
        let mut gate = FrameGate::default();
        assert_eq!(
            gate.sample_world(ms(0), settled(false), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(16), settled(true), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(1517), settled(true), false),
            Dispatch::Recover
        );
        assert_eq!(
            gate.sample_world(ms(1533), settled(false), false),
            Dispatch::Blocked
        );
    }

    #[test]
    fn later_covered_airborne_transport_keeps_the_250ms_limit() {
        let mut gate = FrameGate::default();
        assert_eq!(
            gate.sample_world(ms(0), settled(false), true),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(250), settled(true), true),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(501), settled(true), true),
            Dispatch::Recover
        );
    }

    #[test]
    fn a_new_login_requires_its_own_reveal() {
        let mut gate = FrameGate::default();
        assert_eq!(
            gate.sample_world(ms(0), settled(false), false),
            Dispatch::Open
        );
        let roster = WorldFrame {
            active: false,
            in_world: false,
            ..settled(false)
        };
        assert_eq!(gate.sample_world(ms(16), roster, false), Dispatch::Open);
        for now in [25000, 25016, 28400, 186000] {
            assert_eq!(
                gate.sample_world(ms(now), settled(true), false),
                Dispatch::Open
            );
        }
        assert_eq!(
            gate.sample_world(ms(190000), settled(false), false),
            Dispatch::Open
        );
        assert_eq!(
            gate.sample_world(ms(191501), settled(false), false),
            Dispatch::Recover
        );
    }

    #[test]
    fn an_uncovered_but_unstable_frame_cannot_qualify_initial_entry() {
        for unstable in [
            WorldFrame {
                settling: true,
                ..settled(false)
            },
            WorldFrame {
                stale: true,
                ..settled(false)
            },
        ] {
            let mut gate = FrameGate::default();
            assert_eq!(gate.sample_world(ms(0), unstable, false), Dispatch::Open);
            assert_eq!(
                gate.sample_world(ms(16), settled(true), false),
                Dispatch::Open
            );
            assert_eq!(
                gate.sample_world(ms(2017), settled(true), false),
                Dispatch::Open
            );
            assert_eq!(
                gate.sample_world(ms(186000), settled(false), false),
                Dispatch::Open
            );
            assert_eq!(
                gate.sample_world(ms(187501), settled(false), false),
                Dispatch::Recover
            );
        }
    }

    #[test]
    fn stable_world_pause_blocks_dispatch_before_recovery() {
        let mut gate = FrameGate::default();
        assert_eq!(gate.sample(ms(0), true, false), Dispatch::Open);
        assert_eq!(gate.sample(ms(6000), true, false), Dispatch::Recover);
        assert!(gate.blocked());
    }

    #[test]
    fn ambiguous_launch_on_the_next_frame_stays_blocked() {
        let mut gate = FrameGate::default();
        assert_eq!(gate.sample(ms(0), true, false), Dispatch::Open);
        assert_eq!(gate.sample(ms(1600), true, false), Dispatch::Recover);
        assert_eq!(gate.sample(ms(1616), true, false), Dispatch::Blocked);
        assert_eq!(gate.sample(ms(1632), false, false), Dispatch::Blocked);
        assert!(gate.blocked());
    }

    #[test]
    fn coherent_intervals_leave_normal_movement_dispatch_open() {
        let mut gate = FrameGate::default();
        for now in [0, 16, 266, 1766] {
            assert_eq!(gate.sample(ms(now), true, false), Dispatch::Open);
            assert!(!gate.blocked());
        }
        assert_eq!(gate.sample(ms(3267), true, false), Dispatch::Recover);
    }

    #[test]
    fn first_sample_has_no_process_start_deadline() {
        let mut gate = FrameGate::default();
        assert_eq!(gate.sample(ms(140000), true, false), Dispatch::Open);
        assert_eq!(gate.sample(ms(140016), true, false), Dispatch::Open);
        assert!(!gate.blocked());
    }

    #[test]
    fn cold_stream_finishing_after_140_seconds_starts_a_new_stable_baseline() {
        let mut gate = FrameGate::default();
        assert_eq!(gate.sample(ms(0), false, false), Dispatch::Open);
        // The Stream stage finishes its cold load and releases the hold after this sample.
        assert_eq!(gate.sample(ms(140000), true, false), Dispatch::Open);
        assert_eq!(gate.sample(ms(140016), true, false), Dispatch::Open);
        assert!(!gate.blocked());
        assert_eq!(gate.sample(ms(141517), true, false), Dispatch::Recover);
    }

    #[test]
    fn teleport_hold_and_roster_idle_do_not_trigger_reentry() {
        let mut gate = FrameGate::default();
        for (now, stable) in [
            (0, true),
            (16, false),
            (140016, false),
            (280016, true),
            (280032, true),
            (280048, false),
            (560048, false),
            (700048, true),
            (700064, true),
        ] {
            assert_eq!(gate.sample(ms(now), stable, false), Dispatch::Open);
            assert!(!gate.blocked());
        }
    }

    #[test]
    fn an_airborne_transport_pause_is_resolved_before_its_queued_pose() {
        let mut gate = FrameGate::default();
        assert_eq!(gate.sample(ms(0), true, true), Dispatch::Open);
        assert_eq!(gate.sample(ms(250), true, true), Dispatch::Open);
        assert_eq!(gate.sample(ms(501), true, true), Dispatch::Recover);
        assert!(gate.blocked());
    }

    #[derive(Debug, PartialEq)]
    enum Pending {
        Pose { position: [f32; 3], fall_time: u32 },
        KnockbackAck { counter: u32 },
    }

    #[test]
    fn a_pose_and_ack_queued_before_the_pause_are_dropped_without_dispatch() {
        let (sender, receiver) = std::sync::mpsc::channel();
        sender
            .send(Pending::Pose {
                position: [10.0, 20.0, 30.0],
                fall_time: 600,
            })
            .unwrap();
        sender.send(Pending::KnockbackAck { counter: 7 }).unwrap();
        let mut gate = FrameGate::default();
        gate.sample_world(ms(0), settled(false), false);
        assert_eq!(
            gate.sample_world(ms(6000), settled(false), false),
            Dispatch::Recover
        );
        let mut dispatched = Vec::new();
        if !gate.discard_if_blocked(receiver.try_iter()) {
            dispatched.extend(receiver.try_iter());
        }
        assert!(
            dispatched.is_empty(),
            "no old payload obtains a new timestamp"
        );
        assert_eq!(
            receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        );
    }

    #[test]
    fn an_open_fence_keeps_the_normal_pending_command_for_the_writer() {
        let (sender, receiver) = std::sync::mpsc::channel();
        sender.send(Pending::KnockbackAck { counter: 7 }).unwrap();
        let gate = FrameGate::default();
        assert!(!gate.discard_if_blocked(receiver.try_iter()));
        assert_eq!(
            receiver.try_recv(),
            Ok(Pending::KnockbackAck { counter: 7 })
        );
    }
}
