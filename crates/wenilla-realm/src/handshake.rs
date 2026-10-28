//! Vanilla 5875 account binding before bytes reach the private auth/world services.
//! Parsing is independent of WebSocket frame boundaries; the core still verifies SRP/digests.

#[derive(Debug)]
pub struct Guard {
    port: u16,
    account: Vec<u8>,
    stage: u8,
    pending: Vec<u8>,
}

impl Guard {
    pub fn new(port: u16, account: &str) -> Self {
        Self {
            port,
            account: account.as_bytes().to_vec(),
            stage: 0,
            pending: Vec::new(),
        }
    }

    /// Returns only complete validated packets, retaining incomplete input. An error closes
    /// the connection; the caller must never forward the unvalidated original bytes.
    pub fn push(&mut self, input: &[u8]) -> Result<Vec<u8>, &'static str> {
        if self.port != 3724 && self.port != 8085 {
            return Err("port forbidden");
        }
        if self.port == 8085 && self.stage == 1 {
            // Subsequent headers use the account's SRP session key; the core validates them.
            return Ok(input.to_vec());
        }
        if self.pending.len() + input.len() > 65536 {
            return Err("handshake too large");
        }
        self.pending.extend_from_slice(input);
        let mut verified = Vec::new();
        while !self.pending.is_empty() {
            let p = &self.pending;
            let size = if self.port == 8085 {
                if p.len() < 2 {
                    break;
                }
                let n = usize::from(u16::from_be_bytes([p[0], p[1]])) + 2;
                if !(44..=4096).contains(&n) {
                    return Err("invalid world auth size");
                }
                if p.len() < n {
                    break;
                }
                if p[2..6] != [0xed, 1, 0, 0] || p[6..10] != 5875u32.to_le_bytes() {
                    return Err("expected build 5875 world auth session");
                }
                let end = p[14..n]
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or("missing account terminator")?
                    + 14;
                if p[14..end] != self.account || n - end < 29 {
                    return Err("world account mismatch");
                }
                self.stage = 1;
                n
            } else {
                match self.stage {
                    0 => {
                        if p[0] != 0 {
                            return Err("expected SRP logon challenge");
                        }
                        if p.len() < 4 {
                            break;
                        }
                        let n = usize::from(u16::from_le_bytes([p[2], p[3]])) + 4;
                        if !(35..=50).contains(&n) {
                            return Err("invalid SRP challenge size");
                        }
                        if p.len() < n {
                            break;
                        }
                        if p[1] != 3
                            || p[11..13] != 5875u16.to_le_bytes()
                            || usize::from(p[33]) + 34 != n
                            || p[34..n] != self.account
                        {
                            return Err("SRP account or build mismatch");
                        }
                        self.stage = 1;
                        n
                    }
                    1 => {
                        if p[0] != 1 {
                            return Err("expected SRP proof");
                        }
                        if p.len() < 75 {
                            break;
                        }
                        if p[73] != 0 || p[74] != 0 {
                            return Err("unsupported proof extensions");
                        }
                        self.stage = 2;
                        75
                    }
                    _ => {
                        if p[0] != 16 {
                            return Err("expected realm list");
                        }
                        if p.len() < 5 {
                            break;
                        }
                        if p[1..5] != [0; 4] {
                            return Err("invalid realm list");
                        }
                        5
                    }
                }
            };
            verified.extend(self.pending.drain(..size));
            if self.port == 8085 {
                verified.append(&mut self.pending);
            }
        }
        Ok(verified)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn challenge(account: &str) -> Vec<u8> {
        let mut p = vec![0, 3, 0, 0];
        p.extend_from_slice(&[0; 29]);
        p[11..13].copy_from_slice(&5875u16.to_le_bytes());
        p.push(account.len() as u8);
        p.extend_from_slice(account.as_bytes());
        let n = (p.len() - 4) as u16;
        p[2..4].copy_from_slice(&n.to_le_bytes());
        p
    }

    fn world(account: &str) -> Vec<u8> {
        let mut p = vec![0, 0, 0xed, 1, 0, 0];
        p.extend_from_slice(&5875u32.to_le_bytes());
        p.extend_from_slice(&[0; 4]);
        p.extend_from_slice(account.as_bytes());
        p.push(0);
        p.extend_from_slice(&[0; 28]);
        let n = (p.len() - 2) as u16;
        p[..2].copy_from_slice(&n.to_be_bytes());
        p
    }

    #[test]
    fn refuses_another_account_on_each_port() {
        assert!(Guard::new(3724, "WR000001")
            .push(&challenge("WR000002"))
            .is_err());
        assert!(Guard::new(8085, "WR000001")
            .push(&world("WR000002"))
            .is_err());
    }

    #[test]
    fn validates_fragmented_packets_before_forwarding() {
        for packet in [challenge("WR000001"), world("WR000001")] {
            let port = if packet[0] == 0 && packet[1] == 3 {
                3724
            } else {
                8085
            };
            for split in 1..packet.len() {
                let mut guard = Guard::new(port, "WR000001");
                assert!(guard.push(&packet[..split]).unwrap().is_empty());
                assert_eq!(guard.push(&packet[split..]).unwrap(), packet);
            }
        }
    }

    #[test]
    fn auth_account_cannot_switch_after_initial_challenge() {
        let mut guard = Guard::new(3724, "WR000001");
        guard.push(&challenge("WR000001")).unwrap();
        assert!(guard.push(&challenge("WR000002")).is_err());
        let mut combined = challenge("WR000001");
        combined.extend(challenge("WR000002"));
        assert!(Guard::new(3724, "WR000001").push(&combined).is_err());
    }

    #[test]
    fn rejects_reconnect_oversize_malformed_and_non_game_ports() {
        assert!(Guard::new(1234, "WR000001")
            .push(&challenge("WR000001"))
            .is_err());
        let mut p = challenge("WR000001");
        p[0] = 2;
        assert!(Guard::new(3724, "WR000001").push(&p).is_err());
        let mut p = world("WR000001");
        p[2] = 0;
        assert!(Guard::new(8085, "WR000001").push(&p).is_err());
        assert!(Guard::new(3724, "WR000001").push(&vec![0; 65536]).is_err());
    }

    #[test]
    fn auth_proof_and_realm_list_have_fixed_sequence_and_lengths() {
        let mut guard = Guard::new(3724, "WR000001");
        guard.push(&challenge("WR000001")).unwrap();
        let mut proof = vec![0; 75];
        proof[0] = 1;
        assert_eq!(guard.push(&proof[..30]).unwrap(), Vec::<u8>::new());
        assert_eq!(guard.push(&proof[30..]).unwrap(), proof);
        assert_eq!(guard.push(&[16, 0, 0, 0, 0]).unwrap(), vec![16, 0, 0, 0, 0]);
        assert!(guard.push(&challenge("WR000001")).is_err());
    }
}
