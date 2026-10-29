use anyhow::{ensure, Context, Result};
use benilla_protocol::messages::RelayVerb;
use std::time::{Duration, Instant};

pub fn drive_until<S>(
    state: &mut S,
    deadline: Instant,
    complete: impl Fn(&S) -> bool,
    mut step: impl FnMut(&mut S, Duration) -> Result<bool>,
) -> Result<()> {
    while !complete(state) && Instant::now() < deadline {
        if !step(state, deadline.saturating_duration_since(Instant::now()))? {
            break;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub struct SeenRelay {
    pub pose: [f32; 3],
    pub flags: u32,
    pub verb: RelayVerb,
    pub opcode: u16,
    pub received_at: Instant,
}
#[derive(Clone, Copy)]
pub struct RelayTarget {
    pub pose: [f32; 3],
    pub flags: u32,
    pub opcode: u16,
}
impl RelayTarget {
    pub fn matches(&self, relay: &SeenRelay) -> bool {
        relay.flags == self.flags
            && relay.opcode == self.opcode
            && relay.verb == RelayVerb::of(self.opcode)
            && distance(relay.pose, self.pose) < 0.1
    }
}
pub struct RelayWindow {
    pub target: RelayTarget,
    pub sent_at: Instant,
    pub deadline: Instant,
}
impl RelayWindow {
    pub fn new(target: RelayTarget, sent_at: Instant, duration: Duration) -> Self {
        Self {
            target,
            sent_at,
            deadline: sent_at + duration,
        }
    }
    pub fn accepts(&self, relay: &SeenRelay) -> bool {
        self.target.matches(relay)
            && relay.received_at >= self.sent_at
            && relay.received_at <= self.deadline
    }
}
pub fn positive_limit_ms(requested: u64, airborne: bool) -> u64 {
    if airborne {
        requested.min(1000)
    } else {
        1000
    }
}
#[derive(Clone, Copy, Debug)]
pub struct ForbiddenRelay {
    pub pose: [f32; 3],
    pub opcode: Option<u16>,
}
impl ForbiddenRelay {
    pub fn rejects(&self, relay: &SeenRelay) -> bool {
        self.opcode.is_none_or(|opcode| opcode == relay.opcode)
            && distance(self.pose, relay.pose) < 0.1
    }
}
fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f32>()
        .sqrt()
}
#[derive(Default, Debug)]
pub struct ObserverCoverage {
    visible: Option<bool>,
    loss_epoch: u64,
    negative_windows: Vec<(Instant, Instant)>,
}
impl ObserverCoverage {
    pub fn visible(&self) -> Option<bool> {
        self.visible
    }
    pub fn observe(&mut self, visible: bool, received_at: Instant) -> Result<()> {
        self.visible = Some(visible);
        if !visible {
            self.loss_epoch = self
                .loss_epoch
                .checked_add(1)
                .context("visibility-loss epoch overflow")?;
            ensure!(!self.negative_windows.iter().any(|(start,end)|received_at>=*start && received_at<=*end), "observer visibility lost inside negative observation; later create cannot restore that evidence");
        }
        Ok(())
    }
    pub fn begin(&mut self, at: Instant, duration: Duration) -> Result<u64> {
        ensure!(
            self.visible == Some(true),
            "negative observation requires current observer visibility"
        );
        ensure!(
            self.negative_windows.len() < 64
                && duration > Duration::ZERO
                && duration <= Duration::from_millis(1500),
            "negative coverage interval ceiling exceeded"
        );
        self.negative_windows.push((at, at + duration));
        Ok(self.loss_epoch)
    }
    pub fn finish(&self, epoch: u64) -> Result<()> {
        ensure!(
            self.visible == Some(true) && self.loss_epoch == epoch,
            "observer visibility loss invalidated negative evidence"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_loss_then_recreate_cannot_restore_negative_evidence() {
        let at = Instant::now();
        let mut coverage = ObserverCoverage::default();
        assert!(coverage.begin(at, Duration::from_millis(500)).is_err());
        coverage.observe(true, at).unwrap();
        let epoch = coverage.begin(at, Duration::from_millis(500)).unwrap();
        assert!(coverage
            .observe(false, at + Duration::from_millis(200))
            .is_err());
        coverage
            .observe(true, at + Duration::from_millis(250))
            .unwrap();
        assert_eq!(coverage.visible(), Some(true));
        assert!(coverage.finish(epoch).is_err());
    }
    #[test]
    fn delayed_delivery_of_loss_inside_completed_negative_window_still_fails() {
        let at = Instant::now();
        let mut coverage = ObserverCoverage::default();
        coverage.observe(true, at).unwrap();
        let epoch = coverage.begin(at, Duration::from_millis(500)).unwrap();
        coverage.finish(epoch).unwrap();
        assert!(coverage
            .observe(false, at + Duration::from_millis(400))
            .is_err());
        coverage
            .observe(true, at + Duration::from_millis(600))
            .unwrap();
        assert!(coverage.finish(epoch).is_err());
        // A loss between observations still changes the epoch; a fresh window
        // can begin only after view has explicitly returned.
        coverage
            .observe(false, at + Duration::from_millis(700))
            .unwrap();
        assert!(coverage
            .begin(at + Duration::from_millis(750), Duration::from_millis(500))
            .is_err());
        coverage
            .observe(true, at + Duration::from_millis(800))
            .unwrap();
        let next = coverage
            .begin(at + Duration::from_millis(900), Duration::from_millis(500))
            .unwrap();
        assert!(next > epoch);
        coverage.finish(next).unwrap();
    }
    use benilla_protocol::messages::opcode as op;
    fn sample(at: Instant, ms: u64, pose: [f32; 3], opcode: u16, flags: u32) -> SeenRelay {
        SeenRelay {
            pose,
            opcode,
            flags,
            verb: RelayVerb::of(opcode),
            received_at: at + Duration::from_millis(ms),
        }
    }
    #[test]
    fn accepted_220_to_255ms_relays_outlive_old_200ms_but_complete_bounded_new_window() {
        let at = Instant::now();
        let target = RelayTarget {
            pose: [1., 2., 3.],
            flags: 1,
            opcode: op::MSG_MOVE_START_FORWARD,
        };
        let old = RelayWindow::new(target, at, Duration::from_millis(200));
        let new = RelayWindow::new(
            target,
            at,
            Duration::from_millis(positive_limit_ms(200, false)),
        );
        for ms in [220, 230, 241, 255] {
            let event = sample(at, ms, target.pose, target.opcode, 1);
            assert!(!old.accepts(&event));
            assert!(new.accepts(&event));
        }
        assert_eq!(positive_limit_ms(1500, false), 1000);
        assert_eq!(positive_limit_ms(300, true), 300);
        assert!(!new.accepts(&sample(at, 1001, target.pose, target.opcode, 1)));
    }
    #[test]
    fn exact_flags_opcode_and_post_send_reader_time_are_required() {
        let at = Instant::now();
        let target = RelayTarget {
            pose: [1., 2., 3.],
            flags: 1,
            opcode: op::MSG_MOVE_START_FORWARD,
        };
        let window = RelayWindow::new(target, at, Duration::from_secs(1));
        assert!(!window.accepts(&sample(at, 220, target.pose, op::MSG_MOVE_KNOCK_BACK, 8192)));
        assert!(!window.accepts(&sample(at, 220, target.pose, target.opcode, 0)));
        let stale = SeenRelay {
            received_at: at - Duration::from_millis(1),
            ..sample(at, 220, target.pose, target.opcode, 1)
        };
        assert!(!window.accepts(&stale));
        assert!(window.accepts(&sample(at, 220, target.pose, target.opcode, 1)));
    }
    #[test]
    fn late_negative_origins_and_replay_stay_forbidden_without_blocking_legal_heartbeats() {
        let at = Instant::now();
        let baseline = [0., 0., 3.];
        let valid = [0., 3.493, 3.];
        let guards = [
            ForbiddenRelay {
                pose: baseline,
                opcode: Some(op::MSG_MOVE_KNOCK_BACK),
            },
            ForbiddenRelay {
                pose: [39., 0., 3.],
                opcode: None,
            },
            ForbiddenRelay {
                pose: [0., 0., 13.],
                opcode: None,
            },
            ForbiddenRelay {
                pose: valid,
                opcode: Some(op::MSG_MOVE_KNOCK_BACK),
            },
        ];
        for (pose, opcode, flags) in [
            (baseline, op::MSG_MOVE_KNOCK_BACK, 8192),
            ([39., 0., 3.], op::MSG_MOVE_HEARTBEAT, 1),
            ([0., 0., 13.], op::MSG_MOVE_KNOCK_BACK, 8192),
            (valid, op::MSG_MOVE_KNOCK_BACK, 8192),
        ] {
            assert!(guards
                .iter()
                .any(|g| g.rejects(&sample(at, 750, pose, opcode, flags))));
        }
        assert!(!guards.iter().any(|g| g.rejects(&sample(
            at,
            750,
            valid,
            op::MSG_MOVE_HEARTBEAT,
            8192
        ))));
        assert!(!guards.iter().any(|g| g.rejects(&sample(
            at,
            750,
            baseline,
            op::MSG_MOVE_START_FORWARD,
            1
        ))));
    }
    #[test]
    fn matching_230ms_event_stops_driver_immediately_instead_of_waiting_full_second() {
        use std::{sync::mpsc, thread};
        let (tx, rx) = mpsc::channel();
        let delayed = tx.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(230));
            delayed.send(true).unwrap();
        });
        let started = Instant::now();
        let mut matched = false;
        drive_until(
            &mut matched,
            started + Duration::from_secs(1),
            |matched| *matched,
            |matched, remaining| match rx.recv_timeout(remaining) {
                Ok(value) => {
                    *matched = value;
                    Ok(true)
                }
                Err(mpsc::RecvTimeoutError::Timeout) => Ok(false),
                Err(error) => Err(error.into()),
            },
        )
        .unwrap();
        worker.join().unwrap();
        assert!(matched);
        assert!(started.elapsed() < Duration::from_millis(750));
        drop(tx);
    }
}
