//! Browser mover claims wait for the server's world entry and our matching streamed body.
//! CMaNGOS accepts the claim only in-world; Map::Add enters the world before SendInitSelf.

#[derive(Clone, Copy, Debug)]
pub(crate) struct Context {
    pub self_guid: Option<u64>,
    pub own_body_guid: Option<u64>,
    pub mover_guid: Option<u64>,
    pub mover_body_guid: Option<u64>,
    pub control_lost: bool,
    pub control_transition_pending: bool,
}

#[derive(Default, PartialEq)]
pub(crate) struct EntryClaim {
    world_seen: bool,
    claimed_guid: Option<u64>,
}

/// Keep movement obligations beyond Bevy's message-retention window until entry is qualified.
#[derive(PartialEq)]
pub(crate) struct Held<T> {
    pending: Vec<T>,
}

impl<T> Default for Held<T> {
    fn default() -> Self {
        Self {
            pending: Vec::new(),
        }
    }
}

impl<T> Held<T> {
    /// A known aged held launch cannot become fresh merely because its body appeared.
    /// Refuse the whole batch rather than partially acknowledging an ambiguous arc.
    pub fn take_when_fresh(
        &mut self,
        ready: bool,
        incoming: impl IntoIterator<Item = T>,
        fresh: impl FnMut(&T) -> bool,
    ) -> Result<Vec<T>, ()> {
        let values = self.take_when_ready(ready, incoming);
        if values.iter().all(fresh) {
            Ok(values)
        } else {
            Err(())
        }
    }

    pub fn take_when_ready(
        &mut self,
        ready: bool,
        incoming: impl IntoIterator<Item = T>,
    ) -> Vec<T> {
        self.pending.extend(incoming);
        if ready {
            std::mem::take(&mut self.pending)
        } else {
            Vec::new()
        }
    }
}

pub(crate) fn matches_body(mover_guid: Option<u64>, body_guid: Option<u64>) -> bool {
    mover_guid.is_some() && mover_guid == body_guid
}

/// A typed rider needs the actual matching streamed frame before a movement-bearing response.
pub(crate) fn transport_frame<T>(
    riding: Option<u64>,
    actual: Option<(u64, T)>,
) -> Result<Option<T>, ()> {
    match riding {
        None => Ok(None),
        Some(guid) => actual
            .filter(|(actual_guid, _)| *actual_guid == guid)
            .map(|(_, frame)| Some(frame))
            .ok_or(()),
    }
}

/// LOGIN_VERIFY_WORLD can be deck-local; a qualified self create supplies the world pose.
pub(crate) fn initial_body_pose<T>(
    needs_worldport_ack: bool,
    body_matches: bool,
    actual_body_pose: Option<T>,
) -> Option<T> {
    (!needs_worldport_ack && body_matches)
        .then_some(actual_body_pose)
        .flatten()
}

impl EntryClaim {
    pub fn begin_world(&mut self) {
        self.world_seen = true;
        self.claimed_guid = None;
    }

    /// The caller queues the returned claim before any reports on the same ordered channel.
    pub fn claim_if_ready(&mut self, context: Context) -> Option<u64> {
        if !self.world_seen || context.control_lost || context.control_transition_pending {
            return None;
        }
        if !matches_body(context.self_guid, context.own_body_guid) {
            return None;
        }
        let mover = context.mover_guid?;
        if !matches_body(Some(mover), context.mover_body_guid) || self.claimed_guid == Some(mover) {
            return None;
        }
        self.claimed_guid = Some(mover);
        Some(mover)
    }

    /// Preserve a typed server control grant without treating a pre-entry claim as accepted.
    pub fn note_control_claim(
        &mut self,
        guid: u64,
        self_guid: Option<u64>,
        own_body_guid: Option<u64>,
    ) -> bool {
        self.claimed_guid =
            (self.world_seen && matches_body(self_guid, own_body_guid)).then_some(guid);
        self.claimed_guid == Some(guid)
    }

    pub fn can_report(&self, mover_guid: Option<u64>, embodied_guid: Option<u64>) -> bool {
        self.world_seen
            && mover_guid == self.claimed_guid
            && matches_body(mover_guid, embodied_guid)
    }
}

#[cfg(test)]
mod tests {
    use super::{initial_body_pose, matches_body, transport_frame, Context, EntryClaim, Held};

    const ME: u64 = 0x1234;
    const CREATURE: u64 = 0xf130_0000_0000_5678;

    fn own_body() -> Context {
        Context {
            self_guid: Some(ME),
            own_body_guid: Some(ME),
            mover_guid: Some(ME),
            mover_body_guid: Some(ME),
            control_lost: false,
            control_transition_pending: false,
        }
    }

    #[test]
    fn a_typed_rider_holds_acks_until_the_actual_matching_frame_arrives() {
        const BOAT: u64 = 0xf120_0000_0000_0009;
        let mut entry = EntryClaim::default();
        let mut acks = Held::default();
        entry.begin_world();
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        assert_eq!(
            transport_frame::<([f32; 3], f32)>(Some(BOAT), None),
            Err(())
        );
        assert!(acks.take_when_ready(false, [71]).is_empty());
        // A different transport is not evidence for the body-relative frame.
        assert_eq!(
            transport_frame(Some(BOAT), Some((BOAT + 1, ([1.0, 2.0, 3.0], 0.75)))),
            Err(())
        );
        let local = ([1.0, -2.0, 3.5], 0.75);
        let frame = transport_frame(Some(BOAT), Some((BOAT, local)))
            .unwrap()
            .unwrap();
        assert_eq!(
            acks.take_when_ready(entry.can_report(Some(ME), Some(ME)), []),
            vec![71]
        );
        assert_eq!(frame, local); // the ACK retains the actual deck-local offset and facing
        assert_eq!(transport_frame::<()>(None, None), Ok(None));
    }

    #[test]
    fn initial_boat_local_verify_cannot_replace_the_verified_world_pose() {
        let deck_local_verify = ([1.0, -2.0, 3.5], 0.75);
        let actual_world = ([-3890.0, -595.0, 6.25], 2.25);
        let applied =
            initial_body_pose(false, true, Some(actual_world)).unwrap_or(deck_local_verify);
        assert_eq!(applied, actual_world);
        assert_eq!(initial_body_pose(true, true, Some(actual_world)), None);
        assert_eq!(initial_body_pose(false, false, Some(actual_world)), None);
    }

    #[test]
    fn an_aged_held_launch_cannot_be_released_as_fresh() {
        let mut launches = Held::default();
        assert_eq!(
            launches.take_when_fresh(false, [100_u64], |_| true),
            Ok(vec![])
        );
        // The body arrives 1501 ms later: all launch output is refused, including a newer row.
        assert_eq!(
            launches.take_when_fresh(true, [1601], |received| 1601 - received <= 1500),
            Err(())
        );
        assert_eq!(launches.take_when_ready(true, []), Vec::<u64>::new());
    }

    #[test]
    fn a_recent_held_launch_keeps_its_original_age_and_order() {
        let mut launches = Held::default();
        assert_eq!(
            launches.take_when_fresh(false, [100_u64], |_| true),
            Ok(vec![])
        );
        assert_eq!(
            launches.take_when_fresh(true, [1600], |received| 1600 - received <= 1500),
            Ok(vec![100, 1600])
        );
    }

    #[test]
    fn matching_body_without_world_entry_cannot_claim_or_report() {
        let mut entry = EntryClaim::default();
        assert_eq!(entry.claim_if_ready(own_body()), None);
        assert!(!entry.can_report(Some(ME), Some(ME)));
    }

    #[test]
    fn world_entry_without_both_matching_bodies_waits() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert!(!entry.can_report(None, None));
        for (own_body_guid, mover_body_guid) in [
            (None, None),
            (None, Some(ME)),
            (Some(CREATURE), Some(ME)),
            (Some(ME), None),
            (Some(ME), Some(CREATURE)),
        ] {
            assert_eq!(
                entry.claim_if_ready(Context {
                    own_body_guid,
                    mover_body_guid,
                    ..own_body()
                }),
                None
            );
            assert!(!entry.can_report(Some(ME), Some(ME)));
        }
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
    }

    #[test]
    fn initial_self_claim_does_not_wait_for_reseat_or_render_completion() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        assert!(entry.can_report(Some(ME), Some(ME)));
        assert_eq!(entry.claim_if_ready(own_body()), None);
    }

    #[test]
    fn unknown_character_or_desired_mover_cannot_claim() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(
            entry.claim_if_ready(Context {
                self_guid: None,
                ..own_body()
            }),
            None
        );
        assert_eq!(
            entry.claim_if_ready(Context {
                mover_guid: None,
                ..own_body()
            }),
            None
        );
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
    }

    #[test]
    fn pending_foreign_grant_prevents_a_late_self_claim() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(
            entry.claim_if_ready(Context {
                control_transition_pending: true,
                ..own_body()
            }),
            None
        );
        entry.note_control_claim(CREATURE, Some(ME), Some(ME));
        assert!(entry.can_report(Some(CREATURE), Some(CREATURE)));
        assert!(!entry.can_report(Some(ME), Some(ME)));
        assert_eq!(
            entry.claim_if_ready(Context {
                mover_guid: Some(CREATURE),
                mover_body_guid: Some(CREATURE),
                ..own_body()
            }),
            None
        );
    }

    #[test]
    fn lost_control_prevents_an_automatic_claim() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(
            entry.claim_if_ready(Context {
                control_lost: true,
                ..own_body()
            }),
            None
        );
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
    }

    #[test]
    fn foreign_claim_requires_its_actual_body_and_our_character() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        let foreign = Context {
            mover_guid: Some(CREATURE),
            mover_body_guid: Some(CREATURE),
            ..own_body()
        };
        assert_eq!(
            entry.claim_if_ready(Context {
                mover_body_guid: Some(ME),
                ..foreign
            }),
            None
        );
        assert_eq!(
            entry.claim_if_ready(Context {
                own_body_guid: None,
                ..foreign
            }),
            None
        );
        assert_eq!(entry.claim_if_ready(foreign), Some(CREATURE));
        assert!(!entry.can_report(Some(CREATURE), Some(ME)));
        assert!(!entry.can_report(Some(CREATURE), None));
        assert!(!entry.can_report(None, Some(CREATURE)));
        assert!(entry.can_report(Some(CREATURE), Some(CREATURE)));
    }

    #[test]
    fn explicit_foreign_and_restoration_claims_keep_the_typed_order() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        entry.note_control_claim(CREATURE, Some(ME), Some(ME));
        assert!(entry.can_report(Some(CREATURE), Some(CREATURE)));
        assert!(!entry.can_report(Some(ME), Some(ME)));
        entry.note_control_claim(ME, Some(ME), Some(ME));
        assert!(entry.can_report(Some(ME), Some(ME)));
        assert!(!entry.can_report(Some(CREATURE), Some(CREATURE)));
        assert_eq!(entry.claim_if_ready(own_body()), None);
    }

    #[test]
    fn an_early_or_unqualified_control_claim_does_not_satisfy_entry() {
        let mut entry = EntryClaim::default();
        entry.note_control_claim(ME, Some(ME), Some(ME));
        assert!(!entry.can_report(Some(ME), Some(ME)));
        entry.begin_world();
        entry.note_control_claim(ME, Some(ME), None);
        entry.note_control_claim(ME, Some(ME), Some(CREATURE));
        entry.note_control_claim(ME, None, Some(ME));
        assert!(!entry.can_report(Some(ME), Some(ME)));
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        entry.note_control_claim(CREATURE, Some(ME), None);
        assert!(!entry.can_report(Some(ME), Some(ME)));
        assert!(!entry.can_report(Some(CREATURE), Some(CREATURE)));
    }

    #[test]
    fn reports_require_the_current_claim_and_current_embodied_guid() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        assert!(!entry.can_report(Some(ME), Some(CREATURE)));
        assert!(!entry.can_report(Some(CREATURE), Some(CREATURE)));
        assert!(!entry.can_report(Some(ME), None));
        assert!(!entry.can_report(None, None));
        assert!(entry.can_report(Some(ME), Some(ME)));
    }

    #[test]
    fn far_worldport_rearms_entry_before_the_fresh_body_arrives() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        entry.begin_world();
        assert!(!entry.can_report(Some(ME), Some(ME)));
        assert_eq!(
            entry.claim_if_ready(Context {
                own_body_guid: None,
                mover_body_guid: None,
                ..own_body()
            }),
            None
        );
        // The runtime can send WorldportAck while no mover report is authorized.
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        assert_eq!(entry.claim_if_ready(own_body()), None);
    }

    #[test]
    fn a_new_session_cannot_reuse_the_previous_claim() {
        let mut entry = EntryClaim::default();
        entry.begin_world();
        assert_eq!(entry.claim_if_ready(own_body()), Some(ME));
        entry = EntryClaim::default();
        assert!(!entry.can_report(Some(ME), Some(ME)));
        assert_eq!(entry.claim_if_ready(own_body()), None);
    }

    #[test]
    fn held_commands_survive_more_than_two_frames_and_keep_wire_order() {
        let mut held = Held::default();
        assert!(held.take_when_ready(false, [11]).is_empty());
        for command in [12, 13, 14] {
            assert!(held.take_when_ready(false, [command]).is_empty());
        }
        assert_eq!(held.take_when_ready(true, [15]), vec![11, 12, 13, 14, 15]);
        assert!(held.take_when_ready(true, []).is_empty());
        assert_eq!(held.take_when_ready(true, [16]), vec![16]);
    }

    #[test]
    fn a_held_ack_waits_for_the_matching_body_then_follows_its_claim() {
        #[derive(Debug, PartialEq)]
        enum Command {
            Claim(u64),
            Ack(u32),
        }

        let mut entry = EntryClaim::default();
        let mut held = Held::default();
        entry.begin_world();
        assert!(held.take_when_ready(false, [71]).is_empty());
        let unstreamed = Context {
            own_body_guid: None,
            mover_body_guid: None,
            ..own_body()
        };
        for _ in 0..4 {
            assert_eq!(entry.claim_if_ready(unstreamed), None);
            assert!(held
                .take_when_ready(entry.can_report(Some(ME), None), [])
                .is_empty());
        }
        let claim = entry.claim_if_ready(own_body()).expect("matching own body");
        let mut commands = vec![Command::Claim(claim)];
        commands.extend(
            held.take_when_ready(entry.can_report(Some(ME), Some(ME)), [])
                .into_iter()
                .map(Command::Ack),
        );
        assert_eq!(commands, vec![Command::Claim(ME), Command::Ack(71)]);
    }

    #[test]
    fn pose_seizing_requires_the_actual_desired_mover_body() {
        for (mover, body, expected) in [
            (None, None, false),
            (Some(ME), None, false),
            (None, Some(ME), false),
            (Some(ME), Some(CREATURE), false),
            (Some(CREATURE), Some(ME), false),
            (Some(ME), Some(ME), true),
            (Some(CREATURE), Some(CREATURE), true),
        ] {
            assert_eq!(matches_body(mover, body), expected);
        }
    }
}
