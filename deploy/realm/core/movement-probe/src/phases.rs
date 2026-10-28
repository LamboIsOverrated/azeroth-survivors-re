use anyhow::{ensure, Result};
use serde::Deserialize;

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
