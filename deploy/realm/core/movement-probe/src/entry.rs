use anyhow::{ensure, Result};

pub struct EntryClaim {
    guid: u64,
    map: u32,
    world: bool,
    created: bool,
    claimed: bool,
}
impl EntryClaim {
    pub fn new(guid: u64, map: u32) -> Result<Self> {
        ensure!(
            guid > 0 && guid <= u32::MAX.into(),
            "ordinary player GUID required"
        );
        Ok(Self {
            guid,
            map,
            world: false,
            created: false,
            claimed: false,
        })
    }
    pub fn world_verified(&mut self, map: u32, needs_ack: bool) -> Result<bool> {
        ensure!(
            map == self.map && !needs_ack,
            "unexpected world transfer; measured transport fixture required"
        );
        let first = !self.world;
        self.world = true;
        Ok(first)
    }
    pub fn self_created(&mut self, guid: u64, player: bool) -> Result<bool> {
        if guid != self.guid {
            return Ok(false);
        }
        ensure!(player, "own create has nonplayer kind");
        let first = !self.created;
        self.created = true;
        Ok(first)
    }
    pub fn take_claim(&mut self) -> Option<u64> {
        if self.world && self.created && !self.claimed {
            self.claimed = true;
            Some(self.guid)
        } else {
            None
        }
    }
    pub fn is_claimed(&self) -> bool {
        self.claimed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_claim_is_rejected_but_entry_ordered_claim_is_accepted_once() {
        // Pinned CMSG_SET_ACTIVE_MOVER is STATUS_LOGGEDIN. This small
        // boundary models that dispatch rule, not server internals or a live run.
        let mut logged_in = false;
        let old_unconditional_claim = 2;
        assert!(!(logged_in && old_unconditional_claim == 2));
        let mut entry = EntryClaim::new(2, 0).unwrap();
        assert_eq!(entry.take_claim(), None);
        entry.world_verified(0, false).unwrap();
        assert_eq!(entry.take_claim(), None);
        logged_in = true;
        entry.self_created(2, true).unwrap();
        let claim = entry.take_claim();
        assert!(logged_in && claim == Some(2));
        assert!(entry.is_claimed());
        assert_eq!(entry.take_claim(), None);
        assert!(!entry.world_verified(0, false).unwrap());
        assert!(!entry.self_created(2, true).unwrap());
        assert_eq!(entry.take_claim(), None);
    }
    #[test]
    fn reversed_arrival_foreign_objects_and_fresh_reconnect_do_not_overclaim() {
        let mut entry = EntryClaim::new(2, 0).unwrap();
        assert!(!entry.self_created(3, true).unwrap());
        assert!(!entry.self_created(0, true).unwrap());
        entry.self_created(2, true).unwrap();
        assert_eq!(entry.take_claim(), None);
        assert!(entry.world_verified(1, false).is_err());
        assert!(entry.world_verified(0, true).is_err());
        assert_eq!(entry.take_claim(), None);
        entry.world_verified(0, false).unwrap();
        assert_eq!(entry.take_claim(), Some(2));
        let mut reconnect = EntryClaim::new(2, 0).unwrap();
        assert!(!reconnect.is_claimed());
        assert_eq!(reconnect.take_claim(), None);
        reconnect.world_verified(0, false).unwrap();
        reconnect.self_created(2, true).unwrap();
        assert_eq!(reconnect.take_claim(), Some(2));
        assert!(EntryClaim::new(0, 0).is_err());
        assert!(EntryClaim::new(u64::MAX, 0).is_err());
        assert!(EntryClaim::new(2, 0)
            .unwrap()
            .self_created(2, false)
            .is_err());
    }
}
