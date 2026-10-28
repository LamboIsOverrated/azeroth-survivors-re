use benilla_protocol::{EntityKind, SessionEvent, TransportPose};
use serde_json::{json, Value};

#[derive(Default)]
pub struct Capture {
    pub guid: u64,
    pub moves: usize,
    pub gaps: usize,
}
impl Capture {
    pub fn event(&mut self, event: &SessionEvent) -> Option<Value> {
        match event {
            SessionEvent::UnitMove {
                guid,
                position,
                orientation,
                flags,
                time,
                transport,
                ..
            } if *guid == self.guid => {
                self.moves += 1;
                Some(
                    json!({"event":"watched-movement","guid":guid,"pose":position,
                    "orientation":orientation,"flags":flags,"wire_time":time,
                    "transport":transport_json(*transport)}),
                )
            }
            SessionEvent::ObjectCreate {
                guid,
                position,
                orientation,
                transport,
                fields,
                ..
            } if *guid == self.guid => Some(json!({"event":"watched-create","guid":guid,
                    "pose":position,"orientation":orientation,"transport":transport_json(*transport),
                    "health":fields.unit_health(),"unit_flags":fields.unit_flags()})),
            SessionEvent::ObjectCreate {
                guid,
                kind: EntityKind::GameObject,
                position,
                orientation,
                transport_progress: Some(progress),
                fields,
                ..
            } => Some(json!({
                    "event":"transport-create-anchor","guid":guid,"pose":position,
                    "orientation":orientation,"progress_ms":progress,"entry":fields.object_entry(),
                    "type_id":fields.gameobject_type_id(),"rotation":fields.gameobject_rotation()})),
            SessionEvent::ObjectMove {
                guid,
                position,
                orientation,
            } if *guid == self.guid => Some(
                json!({"event":"watched-object-move","guid":guid,"pose":position,"orientation":orientation}),
            ),
            SessionEvent::PlayerName {
                guid,
                name,
                race,
                gender,
                class,
            } if *guid == self.guid => Some(
                json!({"event":"watched-name","guid":guid,"name":name,"race":race,"gender":gender,"class":class}),
            ),
            SessionEvent::ObjectsRemoved(guids) if guids.contains(&self.guid) => {
                self.gaps += 1;
                Some(json!({"event":"watched-out-of-range","guid":self.guid,"coverage_gap":true}))
            }
            SessionEvent::ObjectDestroyed(guid) if *guid == self.guid => {
                self.gaps += 1;
                Some(json!({"event":"watched-destroyed","guid":guid,"coverage_gap":true}))
            }
            _ => None,
        }
    }
}
fn transport_json(transport: Option<TransportPose>) -> Value {
    transport.map_or(Value::Null, |t| {
        json!({"guid":t.guid,
        "local_pose":[t.pos.x,t.pos.y,t.pos.z],"local_orientation":t.orientation})
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn movement(guid: u64, transport: Option<TransportPose>) -> SessionEvent {
        SessionEvent::UnitMove {
            guid,
            position: [100., 200., 300.],
            orientation: 1.,
            flags: 0x02000000,
            pitch: 0.,
            time: 1234,
            verb: Default::default(),
            fall_time: 0,
            jump: None,
            transport,
        }
    }
    #[test]
    fn captures_actual_local_and_world_frames_without_transforming() {
        let mut capture = Capture {
            guid: 2,
            ..Default::default()
        };
        let transport = TransportPose {
            guid: 0xf120000000000012,
            pos: benilla_protocol::wire::Vector3d {
                x: 1.,
                y: 2.,
                z: 3.,
            },
            orientation: 0.5,
        };
        let record = capture.event(&movement(2, Some(transport))).unwrap();
        assert_eq!(record["pose"], json!([100., 200., 300.]));
        assert_eq!(record["transport"]["guid"], json!(transport.guid));
        assert_eq!(record["transport"]["local_pose"], json!([1., 2., 3.]));
        assert_eq!(record["wire_time"], json!(1234));
        assert_eq!(capture.moves, 1);
        let detached = capture.event(&movement(2, None)).unwrap();
        assert!(detached["transport"].is_null());
        assert_eq!(capture.moves, 2);
        assert!(capture.event(&movement(3, None)).is_none());
        assert_eq!(capture.moves, 2);
    }
    #[test]
    fn out_of_range_and_destroy_are_coverage_gaps_not_movement_success() {
        let mut capture = Capture {
            guid: 2,
            ..Default::default()
        };
        assert!(capture
            .event(&SessionEvent::ObjectsRemoved(vec![9]))
            .is_none());
        assert_eq!(
            capture
                .event(&SessionEvent::ObjectsRemoved(vec![2]))
                .unwrap()["event"],
            "watched-out-of-range"
        );
        assert_eq!(
            capture.event(&SessionEvent::ObjectDestroyed(2)).unwrap()["event"],
            "watched-destroyed"
        );
        assert_eq!(capture.gaps, 2);
        assert_eq!(capture.moves, 0);
    }
    #[test]
    fn server_transport_create_keeps_progress_anchor_without_inventing_a_path() {
        let mut capture = Capture {
            guid: 2,
            ..Default::default()
        };
        let event = SessionEvent::ObjectCreate {
            guid: 0xf120000000000012,
            kind: EntityKind::GameObject,
            display_id: None,
            position: [100., 200., 300.],
            orientation: 0.5,
            scale: 1.,
            speeds: None,
            mover: None,
            transport_progress: Some(12345),
            transport: None,
            spline: None,
            fields: Default::default(),
        };
        let record = capture.event(&event).unwrap();
        assert_eq!(record["event"], "transport-create-anchor");
        assert_eq!(record["progress_ms"], 12345);
        assert_eq!(record["pose"], json!([100., 200., 300.]));
        assert_eq!(capture.moves, 0);
        assert!(record.get("trajectory").is_none());
    }
}
