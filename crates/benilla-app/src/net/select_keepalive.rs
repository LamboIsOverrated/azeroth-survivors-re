//! Browser frame-pump policy while the unsplit connection belongs to character select/create.

pub(super) fn due(parked_at_select: bool, now: f64, last_ping: &mut f64, interval: f64) -> bool {
    if parked_at_select && now - *last_ping >= interval {
        *last_ping = now;
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::due;

    #[test]
    fn select_and_world_share_one_full_interval_without_login_queue_growth() {
        let mut last = 0.0;
        assert!(
            !due(false, 300.0, &mut last, 30.0),
            "login has no parked socket and queues nothing"
        );
        last = 300.0;
        assert!(!due(true, 329.9, &mut last, 30.0));
        assert!(due(true, 330.0, &mut last, 30.0));
        assert!(
            !due(true, 330.0, &mut last, 30.0),
            "one request per interval"
        );
        // The existing writer handover stamps last_ping. A still-visible select screen on
        // that frame must not send an extra pre-world ping; InWorld owns the timer thereafter.
        last = 331.0;
        assert!(!due(true, 331.0, &mut last, 30.0));
        assert!(!due(false, 361.0, &mut last, 30.0));
        assert_eq!(last, 331.0, "the world writer's normal ping remains due");
    }
}
