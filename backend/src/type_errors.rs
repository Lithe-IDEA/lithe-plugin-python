//! The `displayTypeErrors` setting, and the Pyrefly settings it stands for.
//!
//! Pyrefly 1.4.1, the version `vendor-lock.json` packages, deprecates
//! `python.pyrefly.displayTypeErrors` for `typeCheckingMode` and
//! `disableTypeErrors`, and the new settings win whenever both are sent. The
//! plugin always sends `typeCheckingMode`, so passing the old value on would
//! leave only `force-off` in effect. The plugin keeps its four choices and
//! sends Pyrefly the pair that does what each choice's title says instead.

/// Where type errors appear: the `displayTypeErrors` setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Display {
    /// `force-on`: every file, files without a Pyrefly config by the preset.
    AlwaysOn,
    /// `default`: only files a `pyrefly.toml` or `[tool.pyrefly]` covers.
    ConfiguredOnly,
    /// `error-missing-imports`. Pyrefly 0.64 removed this mode, so files
    /// without a Pyrefly config are checked with the `basic` preset, which
    /// reports unresolved imports and a few errors Pyrefly is sure of.
    MissingImports,
    /// `force-off`: no file, whatever its own Pyrefly config says.
    Off,
}

impl Display {
    /// The declared option values, the default first.
    pub const VALUES: [&'static str; 4] =
        ["force-on", "default", "error-missing-imports", "force-off"];

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "force-on" => Display::AlwaysOn,
            "default" => Display::ConfiguredOnly,
            "error-missing-imports" => Display::MissingImports,
            "force-off" => Display::Off,
            _ => return None,
        })
    }

    /// The `typeCheckingMode` and `disableTypeErrors` Pyrefly gets, where
    /// `preset` is the `typeCheckingMode` setting. A preset reaches only the
    /// files no Pyrefly config covers; a configured project keeps its own.
    pub fn pyrefly(self, preset: &str) -> (&str, bool) {
        match self {
            Display::AlwaysOn => (preset, false),
            Display::ConfiguredOnly => ("off", false),
            Display::MissingImports => ("basic", false),
            Display::Off => (preset, true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_value_parses_and_nothing_else_does() {
        for value in Display::VALUES {
            assert!(Display::parse(value).is_some(), "{value}");
        }
        for value in ["", "on", "Force-On", "disable"] {
            assert_eq!(Display::parse(value), None, "{value}");
        }
    }

    #[test]
    fn each_choice_sends_the_settings_that_do_what_its_title_says() {
        assert_eq!(Display::AlwaysOn.pyrefly("strict"), ("strict", false));
        assert_eq!(Display::ConfiguredOnly.pyrefly("strict"), ("off", false));
        assert_eq!(Display::MissingImports.pyrefly("strict"), ("basic", false));
        assert_eq!(Display::Off.pyrefly("strict"), ("strict", true));
    }
}
