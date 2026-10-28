//! An explicit compatibility profile, selected by the realm operator.

pub(crate) fn validated(value: &str) -> Option<&'static str> {
    match value {
        "reference" => Some("reference"),
        "cmangos-classic-4d230bb1" => Some("cmangos-classic-4d230bb1"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_keeps_reference_behavior() {
        assert_eq!(validated("reference"), Some("reference"));
    }

    #[test]
    fn pinned_profile_is_explicit_and_preserves_its_identity() {
        assert_eq!(
            validated("cmangos-classic-4d230bb1"),
            Some("cmangos-classic-4d230bb1")
        );
    }

    #[test]
    fn unknown_and_ambiguous_profiles_are_refused() {
        for profile in [
            "",
            "cmangos",
            "reference ",
            "cmangos-classic-4d230bb2",
            "REFERENCE",
        ] {
            assert_eq!(validated(profile), None, "{profile:?}");
        }
    }
}
