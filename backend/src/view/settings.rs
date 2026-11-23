//! The values the previews show, read from a view event.
//!
//! A preview follows the settings window as the user edits it, so a value the
//! user changed but has not applied (the draft) wins over the saved one, and a
//! setting with neither shows the default `plugin.json` declares.

pub use crate::type_errors::Display;
use lithe_plugin_sdk::view::ViewEvent;
use serde_json::Value;

/// Pyrefly's preset for files no Pyrefly config covers: the
/// `typeCheckingMode` setting, sent as `python.pyrefly.typeCheckingMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Migrates a nearby mypy or Pyright config, else checks as `Basic`.
    Auto,
    Off,
    Basic,
    Legacy,
    Default,
    Strict,
    All,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "auto" => Mode::Auto,
            "off" => Mode::Off,
            "basic" => Mode::Basic,
            "legacy" => Mode::Legacy,
            "default" => Mode::Default,
            "strict" => Mode::Strict,
            "all" => Mode::All,
            _ => return None,
        })
    }

    /// The preset Pyrefly checks the preview's sample with. The sample has no
    /// mypy or Pyright config beside it, so `Auto` falls back to `Basic`.
    pub fn applied(self) -> Self {
        match self {
            Mode::Auto => Mode::Basic,
            mode => mode,
        }
    }
}

/// How far Pyrefly's diagnostics reach: the `diagnosticMode` setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    OpenFiles,
    Workspace,
}

impl Scope {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "openFilesOnly" => Scope::OpenFiles,
            "workspace" => Scope::Workspace,
            _ => return None,
        })
    }
}

/// The module path an auto-import writes: the `importFormat` setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportFormat {
    Absolute,
    Relative,
}

impl ImportFormat {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "absolute" => ImportFormat::Absolute,
            "relative" => ImportFormat::Relative,
            _ => return None,
        })
    }
}

/// The plugin's settings as the settings window holds them now.
#[derive(Debug)]
pub struct Settings {
    /// The Python executable override: the interpreter build, run and
    /// pytest commands use instead of the Toolchains page's, when set.
    pub interpreter_override: Option<String>,
    pub mode: Mode,
    /// Where type errors appear, which decides whether the preset does.
    pub display: Display,
    pub scope: Scope,
    pub auto_import: bool,
    pub import_format: ImportFormat,
    pub function_parens: bool,
    /// The settings whose draft differs from the value in force.
    changed: Vec<&'static str>,
    /// Values of the wrong type or outside the declared options, shown as the
    /// default instead.
    pub unrecognized: u64,
}

impl Settings {
    pub fn read(event: &ViewEvent) -> Self {
        let mut reader = Reader {
            event,
            changed: Vec::new(),
            unrecognized: 0,
        };
        let interpreter_override = reader.read("pythonExecutable", Value::from(""), |value| {
            value
                .as_str()
                .map(|path| (!path.is_empty()).then(|| path.to_owned()))
        });
        let mode = reader.read("typeCheckingMode", Value::from("default"), |value| {
            value.as_str().and_then(Mode::parse)
        });
        let display = reader.read("displayTypeErrors", Value::from("force-on"), |value| {
            value.as_str().and_then(Display::parse)
        });
        let scope = reader.read("diagnosticMode", Value::from("openFilesOnly"), |value| {
            value.as_str().and_then(Scope::parse)
        });
        let auto_import = reader.boolean("autoImportCompletions", true);
        let import_format = reader.read("importFormat", Value::from("absolute"), |value| {
            value.as_str().and_then(ImportFormat::parse)
        });
        let function_parens = reader.boolean("completeFunctionParens", false);
        Self {
            interpreter_override,
            mode,
            display,
            scope,
            auto_import,
            import_format,
            function_parens,
            changed: reader.changed,
            unrecognized: reader.unrecognized,
        }
    }

    /// The preset that decides what the sample, which has no Pyrefly config,
    /// reports: the one `displayTypeErrors` sends Pyrefly for such a file,
    /// or none when that is `off` or type errors are switched off.
    pub fn reporting(&self) -> Option<Mode> {
        match self.display {
            Display::AlwaysOn => Some(self.mode.applied()),
            Display::ConfiguredOnly => Some(Mode::Off),
            Display::MissingImports => Some(Mode::Basic),
            Display::Off => None,
        }
    }

    /// Whether the user changed `id` without applying it yet.
    pub fn is_changed(&self, id: &str) -> bool {
        self.changed.contains(&id)
    }

    pub fn any_changed(&self, ids: &[&str]) -> bool {
        ids.iter().any(|id| self.is_changed(id))
    }
}

struct Reader<'a> {
    event: &'a ViewEvent,
    changed: Vec<&'static str>,
    unrecognized: u64,
}

impl Reader<'_> {
    fn read<T>(
        &mut self,
        id: &'static str,
        default: Value,
        parse: impl Fn(&Value) -> Option<T>,
    ) -> T {
        let saved = self.event.effective.get(id).unwrap_or(&default);
        if let Some(draft) = self.event.draft.get(id) {
            if draft != saved {
                self.changed.push(id);
            }
        }
        let shown = self.event.draft.get(id).unwrap_or(saved);
        match parse(shown) {
            Some(value) => value,
            None => {
                self.unrecognized += 1;
                parse(&default).expect("the declared default parses")
            }
        }
    }

    fn boolean(&mut self, id: &'static str, default: bool) -> bool {
        self.read(id, Value::Bool(default), Value::as_bool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(effective: Value, draft: Value) -> ViewEvent {
        ViewEvent::parse(&json!({
            "event": "settings",
            "instance": "i1",
            "surface": { "settingRegionID": "language" },
            "language": "en",
            "settings": { "effective": effective, "draft": draft },
        }))
        .unwrap()
    }

    #[test]
    fn a_setting_without_a_value_shows_its_declared_default() {
        let settings = Settings::read(&event(json!({}), json!({})));
        assert_eq!(settings.interpreter_override, None);
        assert_eq!(settings.mode, Mode::Default);
        assert_eq!(settings.display, Display::AlwaysOn);
        assert_eq!(settings.scope, Scope::OpenFiles);
        assert!(settings.auto_import && !settings.function_parens);
        assert_eq!(settings.import_format, ImportFormat::Absolute);
        assert_eq!(settings.unrecognized, 0);
        assert!(!settings.any_changed(&["typeCheckingMode", "displayTypeErrors", "importFormat"]));
    }

    #[test]
    fn the_draft_wins_over_the_saved_value_and_counts_as_a_change() {
        let settings = Settings::read(&event(
            json!({ "typeCheckingMode": "basic", "importFormat": "absolute", "displayTypeErrors": "default" }),
            json!({ "typeCheckingMode": "strict", "displayTypeErrors": "default", "importFormat": "relative", "pythonExecutable": "/opt/py/bin/python3" }),
        ));
        assert_eq!(settings.mode, Mode::Strict);
        assert_eq!(settings.import_format, ImportFormat::Relative);
        assert_eq!(
            settings.interpreter_override.as_deref(),
            Some("/opt/py/bin/python3")
        );
        assert!(settings.is_changed("typeCheckingMode"));
        assert!(settings.is_changed("importFormat"));
        assert!(settings.is_changed("pythonExecutable"));
        // A draft equal to the value in force changes nothing.
        assert!(!settings.is_changed("displayTypeErrors"));
        assert!(!settings.is_changed("diagnosticMode"));
    }

    #[test]
    fn a_value_outside_the_declaration_shows_the_default_and_is_counted() {
        let settings = Settings::read(&event(
            json!({ "typeCheckingMode": "pedantic", "autoImportCompletions": "yes", "pythonExecutable": 3 }),
            json!({ "displayTypeErrors": "hidden" }),
        ));
        assert_eq!(settings.mode, Mode::Default);
        assert_eq!(settings.display, Display::AlwaysOn);
        assert_eq!(settings.interpreter_override, None);
        assert!(settings.auto_import);
        assert_eq!(settings.unrecognized, 4);
    }

    #[test]
    fn the_unconfigured_sample_reports_by_the_preset_pyrefly_gets_for_it() {
        let read = |mode: &str, display: &str| {
            Settings::read(&event(
                json!({ "typeCheckingMode": mode, "displayTypeErrors": display }),
                json!({}),
            ))
            .reporting()
        };
        assert_eq!(read("auto", "force-on"), Some(Mode::Basic));
        assert_eq!(read("legacy", "force-on"), Some(Mode::Legacy));
        // Configured projects only silences a file without a Pyrefly config.
        assert_eq!(read("strict", "default"), Some(Mode::Off));
        // Pyrefly has no missing-imports-only mode any more: Basic stands in.
        assert_eq!(read("all", "error-missing-imports"), Some(Mode::Basic));
        assert_eq!(read("strict", "force-off"), None);
    }
}
