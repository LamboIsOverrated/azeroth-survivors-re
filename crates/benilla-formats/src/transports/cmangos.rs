//! Explicit compatibility with the realm's pinned CMaNGOS/ClassicDB pair.
//! Native/default transports keep the reference-client profile.

use super::{TaxiPathNode, TimeMode, TransportTimetable};

impl TransportTimetable {
    pub fn build_cmangos_4d230bb1(
        nodes: &[TaxiPathNode],
        move_speed: f32,
        accel_rate: f32,
    ) -> Option<Self> {
        // CMaNGOS de8f7299 uses three chords per segment (Spline.h), then
        // Transports.cpp overrides the cycle from ClassicDB.transports. These
        // rows were read independently on the restored 4d230bb1 world; the
        // reference-client computation differs for Feathermoon and Naxxramas.
        let path = nodes.first()?.path_id;
        let (period, speed) = match path {
            241 => (350_818, 30.),
            302 => (356_284, 30.),
            285 => (303_463, 30.),
            292 => (329_313, 30.),
            293 => (316_251, 30.),
            295 => (295_579, 30.),
            301 => (333_044, 30.),
            303 => (317_038, 30.),
            436 => (1_204_730, 1.),
            _ => return None,
        };
        if move_speed != speed
            || accel_rate != 1.
            || nodes
                .iter()
                .any(|n| n.path_id != path || n.pos.iter().any(|v| !v.is_finite()))
        {
            return None;
        }
        let mut timetable =
            Self::build_with_variant(nodes, move_speed, accel_rate, TimeMode::Vmangos, 3)?;
        timetable.override_period(period);
        Some(timetable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve(path_id: u32) -> Vec<TaxiPathNode> {
        [
            [-80., -40., 0.],
            [0., 0., 0.],
            [80., 0., 0.],
            [80., 80., 0.],
            [0., 80., 0.],
            [-40., 80., 0.],
        ]
        .into_iter()
        .enumerate()
        .map(|(i, pos)| TaxiPathNode {
            id: i as u32 + 1,
            path_id,
            node_index: i as u32,
            map_id: 0,
            pos,
            flags: if i == 1 || i == 4 { 2 } else { 0 },
            delay: if i == 1 || i == 4 { 3 } else { 0 },
        })
        .collect()
    }

    #[test]
    fn pinned_database_periods_are_exact_including_two_reference_differences() {
        // Independently read from classicmangos.transports on the pinned restored world.
        for (path, period, speed) in [
            (241, 350818, 30.),
            (302, 356284, 30.),
            (285, 303463, 30.),
            (292, 329313, 30.),
            (293, 316251, 30.),
            (295, 295579, 30.),
            (301, 333044, 30.),
            (303, 317038, 30.),
            (436, 1204730, 1.),
        ] {
            let t = TransportTimetable::build_cmangos_4d230bb1(&curve(path), speed, 1.).unwrap();
            assert_eq!(t.period_ms, period, "path {path}");
            assert_eq!(t.frames.last().unwrap().next_arrive_time, period);
        }
    }

    #[test]
    fn curved_segment_uses_the_pinned_servers_three_chords() {
        let t = TransportTimetable::build_cmangos_4d230bb1(&curve(292), 30., 1.).unwrap();
        // Independent three-chord evaluation of P0=(0,0),P1=(80,0),P2=(80,80),P3=(0,80):
        // (80,0), (88.888889,23.703704), (88.888889,56.296296), (80,80).
        assert!((t.frames[1].next_dist_from_prev - 83.223_724).abs() < 0.0001);
        let original = TransportTimetable::build(&curve(292), 30., 1.).unwrap();
        assert!((original.frames[1].next_dist_from_prev - 84.052_605).abs() < 0.0001);
    }

    #[test]
    fn unverified_path_template_and_mixed_rows_are_refused() {
        assert!(TransportTimetable::build_cmangos_4d230bb1(&curve(999), 30., 1.).is_none());
        assert!(TransportTimetable::build_cmangos_4d230bb1(&curve(292), 14., 1.).is_none());
        assert!(TransportTimetable::build_cmangos_4d230bb1(&curve(292), 30., 2.).is_none());
        let mut nodes = curve(292);
        nodes[2].path_id = 295;
        assert!(TransportTimetable::build_cmangos_4d230bb1(&nodes, 30., 1.).is_none());
        assert!(TransportTimetable::build_cmangos_4d230bb1(&[], 30., 1.).is_none());
        let mut nodes = curve(292);
        nodes[2].pos[0] = f32::NAN;
        assert!(TransportTimetable::build_cmangos_4d230bb1(&nodes, 30., 1.).is_none());
    }
}
