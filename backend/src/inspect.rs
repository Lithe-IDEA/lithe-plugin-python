//! Reports environment metadata associated with an explicit interpreter path.

use lithe_plugin_sdk::{Context, FunctionError, PluginError};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) const FUNCTION: &str = "python.inspectEnvironment";

pub(crate) fn environment(params: Value, context: &Context) -> Result<Value, FunctionError> {
    context.check_cancelled()?;
    let path = params["executable"]
        .as_str()
        .filter(|value| value.len() <= 4096 && !value.chars().any(char::is_control))
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            PluginError::new(
                "python.invalidExecutable",
                "Executable must be an absolute path.",
            )
        })?;
    let directory = path.parent().unwrap_or(path);
    let home = directory
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.eq_ignore_ascii_case("bin") || name.eq_ignore_ascii_case("scripts"))
        .and_then(|_| directory.parent())
        .unwrap_or(directory);
    let venv = metadata_matches(&home.join("pyvenv.cfg"), |metadata| metadata.is_file())?;
    let conda = metadata_matches(&home.join("conda-meta"), |metadata| metadata.is_dir())?;
    context.check_cancelled()?;
    Ok(json!({ "executable": path, "isVirtualEnv": venv || conda }))
}

fn metadata_matches(
    path: &Path,
    predicate: impl FnOnce(std::fs::Metadata) -> bool,
) -> Result<bool, PluginError> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(predicate(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(PluginError::new(
            "python.environmentUnavailable",
            "Interpreter environment is unavailable.",
        )),
    }
}
