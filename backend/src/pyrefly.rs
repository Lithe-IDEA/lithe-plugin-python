//! Produces the packaged Pyrefly launch and its settings using the host's interpreter hint.

use lithe_plugin_sdk::{Context, FunctionError, PluginError};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;

const OPERATION: &str = "pyrefly.resolveLaunch";
const MAX_TRACKED_WORKSPACES: usize = 128;

#[derive(Default)]
pub(crate) struct LaunchResolver {
    degraded: Mutex<VecDeque<String>>,
}

impl LaunchResolver {
    pub(crate) fn resolve(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        context.check_cancelled()?;
        if params["serverID"] != "python" {
            return Err(PluginError::new(
                "python.unknownServer",
                "Unsupported language server identifier.",
            )
            .into());
        }
        let path = match params["platform"]["os"].as_str() {
            Some("windows" | "win32") => "bin/pyrefly.exe",
            None if cfg!(windows) => "bin/pyrefly.exe",
            _ => "bin/pyrefly",
        };
        let settings = &params["settings"];
        let diagnostic_mode =
            enum_setting(settings, "diagnosticMode", &["openFilesOnly", "workspace"]);
        let mut python = json!({
            "pyrefly": {
                "typeCheckingMode": enum_setting(settings, "typeCheckingMode", &["default", "auto", "basic", "strict", "all", "off"]),
                "displayTypeErrors": enum_setting(settings, "displayTypeErrors", &["force-on", "default", "error-missing-imports", "force-off"]),
                "diagnosticMode": diagnostic_mode,
            },
            "analysis": {
                "diagnosticMode": diagnostic_mode,
                "autoImportCompletions": settings["autoImportCompletions"].as_bool().unwrap_or(true),
                "completeFunctionParens": settings["completeFunctionParens"].as_bool().unwrap_or(false),
                "importFormat": enum_setting(settings, "importFormat", &["absolute", "relative"]),
            },
        });
        let hint = interpreter_hint(&params["tools"]);
        if let Ok(Some(executable)) = hint {
            python["pythonPath"] = json!(executable);
        }
        let key = context
            .workspace_context()
            .map(|workspace| workspace.context_id())
            .or_else(|| {
                params["workspaceStateDirectory"]
                    .as_str()
                    .filter(|path| path.len() <= 4096)
            })
            .unwrap_or_default();
        if hint.is_err() {
            self.remember_degradation(key);
            context
                .diagnostics()
                .degraded(OPERATION, "invalid_tool_hint", Some(1))?;
        } else if self.take_degradation(key) {
            context
                .diagnostics()
                .recovered(OPERATION, "tool_hint_restored", Some(1))?;
        }

        Ok(json!({
            "executable": {"kind": "packaged", "path": path},
            "arguments": ["lsp"],
            "workspaceConfiguration": {"python": python},
        }))
    }

    fn remember_degradation(&self, key: &str) {
        let mut degraded = self
            .degraded
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        degraded.retain(|old| old != key);
        if degraded.len() == MAX_TRACKED_WORKSPACES {
            degraded.pop_front();
        }
        degraded.push_back(key.to_owned());
    }

    fn take_degradation(&self, key: &str) -> bool {
        let mut degraded = self
            .degraded
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous = degraded.len();
        degraded.retain(|old| old != key);
        degraded.len() != previous
    }
}

fn enum_setting<'a>(settings: &'a Value, key: &str, allowed: &[&'a str]) -> &'a str {
    settings[key]
        .as_str()
        .filter(|value| allowed.contains(value))
        .unwrap_or(allowed[0])
}

fn interpreter_hint(tools: &Value) -> Result<Option<&str>, ()> {
    let executable = match tools {
        Value::Null => return Ok(None),
        Value::Object(tools) => match tools.get("python") {
            Some(Value::Object(tool)) => tool.get("executable"),
            None | Some(Value::Null) => return Ok(None),
            _ => return Err(()),
        },
        _ => return Err(()),
    };
    match executable {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(path)) if path.is_empty() => Ok(None),
        Some(Value::String(path))
            if path.len() <= 4096 && path.trim() == path && !path.chars().any(char::is_control) =>
        {
            Ok(Some(path))
        }
        _ => Err(()),
    }
}
