use anyhow::{ensure, Result};

pub fn speed_matches(expected: f32, actual: f32) -> bool {
    expected.is_finite() && actual.is_finite() && (expected - actual).abs() <= 0.01
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speed_gate_requires_exact_finite_authoritative_speed() {
        assert!(speed_matches(14., 14.));
        assert!(!speed_matches(14., 7.));
        assert!(!speed_matches(14., f32::NAN));
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
