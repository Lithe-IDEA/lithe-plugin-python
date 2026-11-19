//! Python version declarations and constraints interpreted by their originating manager.

use pep440_rs::{Version, VersionSpecifiers};
use std::str::FromStr;

pub(crate) fn numeric_release(value: &str) -> Option<&str> {
    let limit = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let release = &value[..limit];
    let parts: Vec<_> = release.split('.').collect();
    (parts.len() >= 2 && parts.len() <= 4 && parts.iter().all(|part| part.parse::<u32>().is_ok()))
        .then_some(release)
}

pub(crate) fn managed_release(name: &str) -> Option<&str> {
    let release = name
        .strip_prefix("cpython-")
        .or_else(|| name.strip_prefix("pypy-"))
        .unwrap_or(name);
    let numeric = numeric_release(release)?;
    // Release names must not turn a prerelease or a non-version environment
    // name into a different, installed final release.
    (release == numeric
        || (release.len() != name.len() && release[numeric.len()..].starts_with('-')))
    .then_some(numeric)
}

pub(crate) struct Constraint(Vec<VersionSpecifiers>);

impl Constraint {
    pub(crate) fn project(requirement: &str) -> Option<Self> {
        Some(Self(vec![requirement.parse().ok()?]))
    }

    pub(crate) fn poetry(requirement: &str) -> Option<Self> {
        let mut ranges = Vec::new();
        for alternative in requirement.split("||") {
            let terms = alternative
                .split(',')
                .map(str::trim)
                .filter(|term| !term.is_empty() && *term != "*")
                .map(poetry_term)
                .collect::<Option<Vec<_>>>()?;
            ranges.push(terms.join(",").parse().ok()?);
        }
        Some(Self(ranges))
    }

    pub(crate) fn contains(&self, version: &Version) -> bool {
        self.0.iter().any(|range| range.contains(version))
    }
}

fn poetry_term(term: &str) -> Option<String> {
    let Some(version) = term.strip_prefix('^').or_else(|| {
        term.strip_prefix('~')
            .filter(|version| !version.starts_with('='))
    }) else {
        return Some(
            if term.starts_with(|character: char| character.is_ascii_digit()) {
                format!("=={term}")
            } else {
                term.to_owned()
            },
        );
    };
    let version = Version::from_str(version.trim()).ok()?;
    let release = version.release();
    let pivot = if term.starts_with('^') {
        release
            .iter()
            .position(|part| *part != 0)
            .unwrap_or(release.len() - 1)
    } else {
        usize::from(release.len() >= 2)
    };
    let mut upper = release[..=pivot].to_vec();
    upper[pivot] = upper[pivot].checked_add(1)?;
    let upper = upper
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(".");
    Some(format!(">={version},<{upper}"))
}

pub(crate) fn matches_version_file(wanted: &str, name: &str, version: &Version) -> bool {
    if wanted == name {
        return true;
    }
    let wanted = wanted.strip_prefix("cpython-").unwrap_or(wanted);
    let Some(wanted) = Version::from_str(wanted).ok().filter(|value| {
        !value.any_prerelease()
            && wanted
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
    }) else {
        return false;
    };
    version.release().starts_with(wanted.release())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_pep440_compatible_and_excluded_versions() {
        let range = Constraint::project("~=3.12.1, !=3.12.4").unwrap();
        for (version, matches) in [("3.12.2", true), ("3.12.4", false), ("3.13", false)] {
            assert_eq!(range.contains(&version.parse().unwrap()), matches);
        }
        assert!(Constraint::project("^3.12").is_none());
    }

    #[test]
    fn poetry_disjunction_and_tilde_follow_release_precision() {
        let range = Constraint::poetry("~3.11 || ^4.0, !=4.1").unwrap();
        for (version, matches) in [
            ("3.11.8", true),
            ("3.12", false),
            ("4.0", true),
            ("4.1", false),
            ("5.0", false),
        ] {
            assert_eq!(range.contains(&version.parse().unwrap()), matches);
        }
    }
}
