//! Browser self-movement uses elapsed wall time without changing Bevy's render clock.
use std::time::Duration;

const STEP: Duration = Duration::from_millis(50);
const MAX_GAP: Duration = Duration::from_secs(5);
const MAX_LANDING_DELAY: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    History,
    Input,
    Launch,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Tick {
    pub dt: Duration,
    pub age: Duration,
    pub phase: Phase,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Frame<T> {
    Moved { value: T, fall_time: Option<u32> },
    Recover { request: bool },
}

#[derive(Default, PartialEq)]
pub(crate) struct Clock {
    age: Duration,
    recovering: bool,
}

impl Clock {
    pub fn advance<T>(
        &mut self,
        real: Duration,
        rendered: Duration,
        airborne: bool,
        launch: bool,
        mut step: impl FnMut(Tick) -> (T, bool),
    ) -> Frame<T> {
        if self.recovering {
            return Frame::Recover { request: false };
        }
        // The launch has no server issue timestamp. A stalled JS event loop may only now
        // dispatch an old packet, so a local receipt timestamp would not prove freshness.
        if launch {
            if real > MAX_LANDING_DELAY {
                return self.recover();
            }
            self.age = Duration::ZERO;
            let (value, _) = step(Tick {
                dt: Duration::ZERO,
                age: self.age,
                phase: Phase::Launch,
            });
            return Frame::Moved {
                value,
                fall_time: Some(0),
            };
        }
        if !airborne {
            self.age = Duration::ZERO;
            let (value, _) = step(Tick {
                dt: rendered,
                age: self.age,
                phase: Phase::Input,
            });
            return Frame::Moved {
                value,
                fall_time: None,
            };
        }
        if real > MAX_GAP {
            return self.recover();
        }
        let mut remaining = real;
        let replaying = real > STEP;
        loop {
            let dt = remaining.min(STEP);
            remaining -= dt;
            self.age += dt;
            let phase = if remaining.is_zero() && !replaying {
                Phase::Input
            } else {
                Phase::History
            };
            let (value, still_airborne) = step(Tick {
                dt,
                age: self.age,
                phase,
            });
            if !still_airborne {
                // A landing older than the server's coherent trajectory window cannot be
                // reported as if it just happened. Ask for an authoritative world re-entry.
                if remaining > MAX_LANDING_DELAY {
                    return self.recover();
                }
                return Frame::Moved {
                    value,
                    fall_time: Some(self.age.as_millis().min(u128::from(u32::MAX)) as u32),
                };
            }
            if remaining.is_zero() {
                // Input happened at the resumed present, after historical physics. A zero-time
                // application preserves air nudges without replaying a new key through the gap.
                let value = if replaying {
                    step(Tick {
                        dt: Duration::ZERO,
                        age: self.age,
                        phase: Phase::Input,
                    })
                    .0
                } else {
                    value
                };
                return Frame::Moved {
                    value,
                    fall_time: Some(self.age.as_millis().min(u128::from(u32::MAX)) as u32),
                };
            }
        }
    }

    pub fn recover<T>(&mut self) -> Frame<T> {
        let request = !self.recovering;
        self.recovering = true;
        Frame::Recover { request }
    }

    pub fn recovering(&self) -> bool {
        self.recovering
    }

    pub fn reset_arc(&mut self) {
        self.age = Duration::ZERO;
    }

    pub fn set_arc(&mut self, age: Duration) {
        self.age = age;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn suspended_flight_spends_real_time_in_bounded_steps_and_input_once() {
        let mut clock = Clock::default();
        let mut elapsed = Duration::ZERO;
        let mut inputs = 0;
        let mut count = 0;
        let result = clock.advance(ms(3000), ms(250), true, false, |tick| {
            assert!(tick.dt <= STEP);
            elapsed += tick.dt;
            count += 1;
            inputs += usize::from(tick.phase == Phase::Input);
            (elapsed, true)
        });
        assert_eq!(elapsed, ms(3000));
        assert_eq!(count, 61);
        assert_eq!(inputs, 1);
        assert_eq!(
            result,
            Frame::Moved {
                value: ms(3000),
                fall_time: Some(3000)
            }
        );
    }

    #[test]
    fn recent_launch_has_no_preceding_frame_motion_or_duplicate_ack() {
        let mut clock = Clock::default();
        let mut launches = 0;
        let frame = clock.advance(ms(250), ms(250), false, true, |tick| {
            assert_eq!(tick.phase, Phase::Launch);
            assert_eq!(tick.dt, Duration::ZERO);
            launches += 1;
            (tick.age, true)
        });
        assert_eq!(launches, 1);
        assert_eq!(
            frame,
            Frame::Moved {
                value: Duration::ZERO,
                fall_time: Some(0)
            }
        );
    }

    #[test]
    fn queued_launch_after_an_ambiguous_pause_is_not_acked_as_fresh() {
        let mut clock = Clock::default();
        assert!(!clock.recovering());
        assert_eq!(
            clock.advance(ms(90000), ms(250), false, true, |_| panic!(
                "old launch acked"
            )),
            Frame::<()>::Recover { request: true },
        );
        assert!(clock.recovering());
    }

    #[test]
    fn landing_stops_history_before_current_input_or_ground_travel() {
        let mut clock = Clock::default();
        let mut count = 0;
        let frame = clock.advance(ms(1000), ms(250), true, false, |tick| {
            count += 1;
            assert_eq!(tick.phase, Phase::History);
            (count, count < 3)
        });
        assert_eq!(count, 3);
        assert_eq!(
            frame,
            Frame::Moved {
                value: 3,
                fall_time: Some(150)
            }
        );
    }

    #[test]
    fn oversized_gap_requests_reentry_once_and_never_simulates_afterwards() {
        let mut clock = Clock::default();
        assert_eq!(
            clock.advance(ms(5001), ms(250), true, false, |_| panic!(
                "oversized gap simulated"
            )),
            Frame::<()>::Recover { request: true }
        );
        assert_eq!(
            clock.advance(ms(16), ms(16), true, true, |_| panic!(
                "recovery streamed movement"
            )),
            Frame::<()>::Recover { request: false }
        );
    }

    #[test]
    fn touchdown_too_old_for_the_server_window_requires_reentry() {
        let mut clock = Clock::default();
        let frame = clock.advance(ms(4000), ms(250), true, false, |_| ((), false));
        assert_eq!(frame, Frame::Recover { request: true });
    }

    #[test]
    fn authoritative_arc_seed_and_new_arc_reset_keep_the_recovery_latch() {
        let mut clock = Clock::default();
        clock.set_arc(ms(2000));
        assert_eq!(
            clock.advance(ms(16), ms(16), true, false, |tick| (tick.age, true)),
            Frame::Moved {
                value: ms(2016),
                fall_time: Some(2016)
            }
        );
        clock.reset_arc();
        assert_eq!(
            clock.advance(ms(16), ms(16), true, false, |tick| (tick.age, true)),
            Frame::Moved {
                value: ms(16),
                fall_time: Some(16)
            }
        );
        let _ = clock.recover::<()>();
        clock.reset_arc();
        assert!(matches!(
            clock.advance(ms(16), ms(16), false, true, |_| panic!(
                "recovery reset by arc"
            )),
            Frame::<()>::Recover { request: false }
        ));
    }
}
