use anyhow::{ensure, Result};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirstAckProbe {
    pub delay_ms: u64,
}
impl FirstAckProbe {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [499, 3000].contains(&self.delay_ms),
            "first ACK delay must be499 or3000ms"
        );
        Ok(())
    }
    pub fn origin(&self, origin: [f32; 3], grid: &TerrainGrid) -> Result<[f32; 3]> {
        self.validate()?;
        ensure!(origin.iter().all(|v| v.is_finite()), "invalid ACK baseline");
        let mut pos = [origin[0], origin[1] + 3.493, origin[2]];
        pos[2] = grid.height(pos[0], pos[1])?;
        Ok(pos)
    }
}
pub struct ReceiptClock {
    pub issued_ms: u64,
    pub applied_ms: u64,
}
pub struct AckTrial {
    pub case: &'static str,
    pub counter: u32,
    pub launch: [f32; 4],
    pub pose: [f32; 3],
}
pub fn negative_ack_trials(
    counter: u32,
    launch: [f32; 4],
    pose: [f32; 3],
) -> Result<Vec<AckTrial>> {
    ensure!(
        launch_matches(launch, launch) && pose.iter().all(|v| v.is_finite()),
        "invalid actual receipt"
    );
    let mut wrong_quad = launch;
    wrong_quad[3] += 1.;
    Ok(vec![
        AckTrial {
            case: "wrong-counter",
            counter: counter.wrapping_add(1),
            launch,
            pose,
        },
        AckTrial {
            case: "wrong-quad",
            counter,
            launch: wrong_quad,
            pose,
        },
        AckTrial {
            case: "outside-ordinary-budget",
            counter,
            launch,
            pose: [pose[0] + 39., pose[1], pose[2]],
        },
        AckTrial {
            case: "outside-ordinary-air-envelope",
            counter,
            launch,
            pose: [pose[0], pose[1], pose[2] + 10.],
        },
    ])
}
impl ReceiptClock {
    pub fn flight_ms(&self, now: u64) -> Result<u64> {
        ensure!(
            self.applied_ms >= self.issued_ms && now >= self.applied_ms,
            "invalid ACK application clock"
        );
        ensure!(
            self.issue_age_ms(now)? <= 60000,
            "native launch receipt expired"
        );
        Ok(now - self.applied_ms)
    }
    pub fn issue_age_ms(&self, now: u64) -> Result<u64> {
        ensure!(now >= self.issued_ms, "invalid launch receipt clock");
        Ok(now - self.issued_ms)
    }
}

pub fn peaceful_state(flags: u32, health: Option<u32>, baseline: Option<u32>) -> bool {
    flags & 0x00080000 == 0
        && match (health, baseline) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
}
#[derive(Default)]
pub struct HealthGuard {
    pub baseline: [Option<u32>; 2],
}
impl HealthGuard {
    pub fn observe(&mut self, side: usize, flags: u32, health: Option<u32>) -> bool {
        let Some(baseline) = self.baseline.get_mut(side) else {
            return false;
        };
        // All declared probe avatars are the attested level-one, 60 HP fixtures.
        // An observer may receive Fog of War percentages; self health is absolute.
        if side == 0 && baseline.is_none() && health.is_some_and(|value| value != 60) {
            return false;
        }
        if !peaceful_state(flags, health, *baseline) {
            return false;
        }
        if baseline.is_none() {
            *baseline = health;
        }
        true
    }
}

pub fn speed_matches(expected: f32, actual: f32) -> bool {
    expected.is_finite() && actual.is_finite() && (expected - actual).abs() <= 0.01
}
pub fn require_initial_run_speed(speed: Option<f32>) -> Result<()> {
    ensure!(
        speed.is_some_and(|v| speed_matches(7., v)),
        "initial native run speed must be7 before speed actions"
    );
    Ok(())
}
pub fn require_zero_money(money: Option<u32>) -> Result<()> {
    ensure!(
        money == Some(0),
        "moving ACK requires received native money0"
    );
    Ok(())
}

pub fn matches_destination(expected: [f32; 3], actual: [f32; 3]) -> bool {
    expected.iter().chain(actual.iter()).all(|p| p.is_finite())
        && expected
            .iter()
            .zip(actual)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>()
            <= 0.05 * 0.05
}
pub fn fall_position(origin: [f32; 3], elapsed_seconds: f64, floor: f32) -> Result<[f32; 3]> {
    ensure!(
        origin.iter().all(|p| p.is_finite()) && floor.is_finite() && floor <= origin[2],
        "invalid measured fall bounds"
    );
    ensure!(
        elapsed_seconds.is_finite() && (0.0..=10.0).contains(&elapsed_seconds),
        "stale or invalid teleport clock"
    );
    // Pinned Movement/util.cpp gravity/terminal; a normal teleport drop begins
    // at zero vertical velocity, unlike a voluntary jump's upward launch.
    let gravity = 19.29110527038574;
    let terminal = 60.148003;
    let terminal_time = terminal / gravity;
    let accelerated = elapsed_seconds.min(terminal_time);
    let drop =
        0.5 * gravity * accelerated * accelerated + terminal * (elapsed_seconds - accelerated);
    Ok([
        origin[0],
        origin[1],
        (f64::from(origin[2]) - drop).max(f64::from(floor)) as f32,
    ])
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerrainGrid {
    pub source_file: String,
    pub source_sha256: String,
    pub x0: f32,
    pub y0: f32,
    pub step: f32,
    pub nx: usize,
    pub ny: usize,
    pub heights: Vec<f32>,
}
pub fn ordinary_return(pose: [f32; 3], target: [f32; 3], grid: &TerrainGrid) -> Result<[f32; 3]> {
    ensure!(
        pose.iter().chain(target.iter()).all(|v| v.is_finite()),
        "invalid return pose"
    );
    grid.height(pose[0], pose[1])?;
    grid.height(target[0], target[1])?;
    let dx = target[0] - pose[0];
    let dy = target[1] - pose[1];
    let length = (dx * dx + dy * dy).sqrt();
    let scale = if length > 1. { 1. / length } else { 1. };
    let x = pose[0] + dx * scale;
    let y = pose[1] + dy * scale;
    Ok([x, y, grid.height(x, y)?])
}
impl TerrainGrid {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.source_file.is_ascii()
                && self.source_file.len() == 11
                && self.source_file.ends_with(".map")
                && self.source_file[..7].bytes().all(|b| b.is_ascii_digit()),
            "invalid terrain provenance name"
        );
        ensure!(
            self.source_sha256.len() == 64
                && self.source_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "terrain provenance hash missing"
        );
        ensure!(
            (2..=65).contains(&self.nx)
                && (2..=65).contains(&self.ny)
                && self.heights.len() == self.nx * self.ny,
            "invalid terrain grid dimensions"
        );
        ensure!(
            self.x0.is_finite()
                && self.y0.is_finite()
                && self.step.is_finite()
                && (0.25..=2.0).contains(&self.step)
                && self
                    .heights
                    .iter()
                    .all(|h| h.is_finite() && h.abs() < 50000.),
            "invalid terrain grid values"
        );
        Ok(())
    }
    pub fn height(&self, x: f32, y: f32) -> Result<f32> {
        self.validate()?;
        ensure!(x.is_finite() && y.is_finite(), "invalid terrain query");
        let fx = (x - self.x0) / self.step;
        let fy = (y - self.y0) / self.step;
        ensure!(
            fx >= 0. && fy >= 0. && fx <= (self.nx - 1) as f32 && fy <= (self.ny - 1) as f32,
            "outside surveyed terrain"
        );
        let ix = (fx.floor() as usize).min(self.nx - 2);
        let iy = (fy.floor() as usize).min(self.ny - 2);
        let tx = fx - ix as f32;
        let ty = fy - iy as f32;
        let h = |x, y| self.heights[x * self.ny + y];
        Ok((h(ix, iy) * (1. - tx) + h(ix + 1, iy) * tx) * (1. - ty)
            + (h(ix, iy + 1) * (1. - tx) + h(ix + 1, iy + 1) * tx) * ty)
    }
}
pub fn launch_matches(expected: [f32; 4], actual: [f32; 4]) -> bool {
    actual.iter().chain(expected.iter()).all(|v| v.is_finite())
        && (actual[1] * actual[1] + actual[2] * actual[2] - 1.).abs() < 0.01
        && actual[3] >= 0.
        && actual[3] <= 15.
        && actual[0].abs() <= 15.
        && actual
            .iter()
            .zip(expected)
            .all(|(a, b)| (*a - b).abs() <= 0.05)
}
pub fn ballistic_position(origin: [f32; 3], launch: [f32; 4], seconds: f64) -> Result<[f32; 3]> {
    ensure!(
        launch_matches(launch, launch)
            && origin.iter().all(|v| v.is_finite())
            && seconds.is_finite()
            && (0.0..=2.0).contains(&seconds),
        "invalid bounded ballistic sample"
    );
    let gravity = 19.29110527038574;
    let initial = f64::from(launch[0]);
    let terminal = 60.148003;
    let t = seconds.min((terminal - initial) / gravity);
    let fall = t * (initial + 0.5 * gravity * t) + terminal * (seconds - t);
    Ok([
        origin[0] + launch[3] * launch[1] * seconds as f32,
        origin[1] + launch[3] * launch[2] * seconds as f32,
        origin[2] - fall as f32,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moving_ack_requires_received_native_zero_money_not_missing_or_nonzero() {
        require_zero_money(Some(0)).unwrap();
        assert!(require_zero_money(None).is_err());
        assert!(require_zero_money(Some(1)).is_err());
    }
    #[test]
    fn first_ack_probe_requires_measured_perpendicular_origin_and_bounded_delay() {
        let mut grid = TerrainGrid {
            source_file: "0004832.map".into(),
            source_sha256: "a".repeat(64),
            x0: -16.,
            y0: -1.,
            step: 0.5,
            nx: 35,
            ny: 13,
            heights: vec![3.; 455],
        };
        for delay_ms in [499, 3000] {
            let probe = FirstAckProbe { delay_ms };
            probe.validate().unwrap();
            assert_eq!(probe.origin([0., 0., 3.], &grid).unwrap(), [0., 3.493, 3.]);
        }
        for delay_ms in [0, 498, 500, 2999, 3001, 60000] {
            assert!(FirstAckProbe { delay_ms }.validate().is_err());
        }
        grid.ny = 5;
        grid.heights.truncate(grid.nx * grid.ny);
        assert!(FirstAckProbe { delay_ms: 499 }
            .origin([0., 0., 3.], &grid)
            .is_err());
    }
    #[test]
    fn ack_application_clock_does_not_renew_issue_expiry() {
        let receipt = ReceiptClock {
            issued_ms: 1000,
            applied_ms: 4000,
        };
        assert_eq!(receipt.flight_ms(4150).unwrap(), 150);
        assert_eq!(receipt.issue_age_ms(4150).unwrap(), 3150);
        assert_eq!(receipt.issue_age_ms(62000).unwrap(), 61000);
        assert!(receipt.flight_ms(62000).is_err());
        assert!(receipt.flight_ms(3999).is_err());
        assert!(ReceiptClock {
            issued_ms: 4001,
            applied_ms: 4000
        }
        .flight_ms(4150)
        .is_err());
    }
    #[test]
    fn negative_ack_plan_uses_only_actual_receipt_and_explicit_invalid_variants() {
        let quad = [-10., -1., 0., 10.];
        let trials = negative_ack_trials(u32::MAX, quad, [1., 2., 3.]).unwrap();
        assert_eq!(trials.len(), 4);
        assert_eq!(trials[0].counter, 0);
        assert_eq!(trials[0].launch, quad);
        assert_eq!(trials[1].counter, u32::MAX);
        assert!(!launch_matches(quad, trials[1].launch));
        assert_eq!(trials[2].pose, [40., 2., 3.]);
        assert_eq!(trials[3].pose, [1., 2., 13.]);
        for trial in trials {
            assert!(trial
                .pose
                .into_iter()
                .chain(trial.launch)
                .all(f32::is_finite));
        }
        assert!(negative_ack_trials(0, [f32::NAN, -1., 0., 10.], [1., 2., 3.]).is_err());
        assert!(negative_ack_trials(0, quad, [f32::INFINITY, 2., 3.]).is_err());
    }
    #[test]
    fn measured_terrain_grid_interpolates_without_extrapolation() {
        let grid = TerrainGrid {
            source_file: "0004832.map".into(),
            source_sha256: "a".repeat(64),
            x0: 0.,
            y0: 0.,
            step: 1.,
            nx: 2,
            ny: 2,
            heights: vec![0., 1., 2., 3.],
        };
        grid.validate().unwrap();
        assert!((grid.height(0.5, 0.5).unwrap() - 1.5).abs() < 0.0001);
        assert!(grid.height(-1., 0.).is_err());
        assert!(grid.height(0., f32::NAN).is_err());
    }
    #[test]
    fn ordinary_return_clamps_to_one_yard_and_finishes_exactly_on_surveyed_origin() {
        let grid = TerrainGrid {
            source_file: "0004832.map".into(),
            source_sha256: "a".repeat(64),
            x0: -16.,
            y0: -1.,
            step: 0.5,
            nx: 35,
            ny: 13,
            heights: vec![3.; 455],
        };
        let mut pose = [-15., 3.493, 3.];
        for _ in 0..20 {
            let next = ordinary_return(pose, [0., 0., 3.], &grid).unwrap();
            assert!(((next[0] - pose[0]).powi(2) + (next[1] - pose[1]).powi(2)).sqrt() <= 1.00001);
            pose = next;
        }
        assert_eq!(pose, [0., 0., 3.]);
        assert!(ordinary_return([0., 0., 3.], [20., 0., 3.], &grid).is_err());
        assert!(ordinary_return([f32::NAN, 0., 3.], [0., 0., 3.], &grid).is_err());
    }
    #[test]
    fn ballistic_points_use_actual_launch_and_receipt_time() {
        let q = [-10., -1., 0., 10.];
        assert!(launch_matches(q, q));
        assert!(!launch_matches(q, [-10., 1., 0., 10.]));
        let point = ballistic_position([0., 0., 5.], q, 0.2).unwrap();
        assert!((point[0] + 2.).abs() < 0.0001 && point[2] > 6.5 && point[2] < 6.7);
        assert!(ballistic_position([0., 0., 5.], q, -1.).is_err());
    }
    #[test]
    fn noncombat_probe_stops_on_server_combat_or_health_change() {
        assert!(peaceful_state(0, Some(60), Some(60)));
        assert!(peaceful_state(0, None, Some(60)));
        assert!(!peaceful_state(0x80000, None, Some(60)));
        assert!(!peaceful_state(0, Some(59), Some(60)));
    }
    #[test]
    fn health_guard_keeps_self_hitpoints_separate_from_observer_percentage() {
        let mut guard = HealthGuard::default();
        assert!(guard.observe(0, 0, Some(60)));
        assert!(guard.observe(1, 0, Some(100)));
        assert!(guard.observe(0, 0, None));
        assert!(guard.observe(1, 0, None));
        assert_eq!(guard.baseline, [Some(60), Some(100)]);
        assert!(!guard.observe(0, 0, Some(59)));
        assert!(!guard.observe(1, 0, Some(99)));
        assert!(!guard.observe(0, 0x80000, None));
        assert!(!guard.observe(1, 0x80000, None));
        assert!(!guard.observe(2, 0, Some(60)));
    }
    #[test]
    fn initial_self_health_must_match_attested_ordinary_level_one_fixture() {
        for health in [0, 59, 61, 100] {
            let mut guard = HealthGuard::default();
            assert!(!guard.observe(0, 0, Some(health)));
            assert_eq!(guard.baseline[0], None);
        }
        let mut guard = HealthGuard::default();
        assert!(guard.observe(0, 0, None));
        assert!(guard.observe(0, 0, Some(60)));
    }
    #[test]
    fn speed_gate_requires_exact_finite_authoritative_speed() {
        assert!(speed_matches(14., 14.));
        assert!(!speed_matches(14., 7.));
        assert!(!speed_matches(14., f32::NAN));
    }
    #[test]
    fn speed_phase_relogin_requires_actual_native_normal_run_speed() {
        require_initial_run_speed(Some(7.)).unwrap();
        for speed in [None, Some(14.), Some(0.), Some(f32::NAN)] {
            assert!(require_initial_run_speed(speed).is_err());
        }
    }
    #[test]
    fn only_the_expected_finite_server_destination_matches() {
        assert!(matches_destination([1., 2., 8.], [1., 2., 8.]));
        assert!(!matches_destination([1., 2., 8.], [1., 2., 3.]));
        assert!(!matches_destination([1., 2., 8.], [f32::NAN, 2., 8.]));
    }
    #[test]
    fn normal_drop_starts_above_old_floor_and_lands_without_resetting_clock() {
        let origin = [1., 2., 8.];
        let early = fall_position(origin, 0.2, 3.).unwrap();
        assert!(early[2] > 7.5 && early[2] < 8.);
        let later = fall_position(origin, 0.4, 3.).unwrap();
        assert!(later[2] < early[2]);
        assert_eq!(fall_position(origin, 1.0, 3.).unwrap(), [1., 2., 3.]);
        for t in [-1., f64::NAN, 11.] {
            assert!(fall_position(origin, t, 3.).is_err());
        }
        assert!(fall_position(origin, 0., 9.).is_err());
    }
}
