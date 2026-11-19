//! Captures version metadata without executing any candidate interpreter.

use super::{Failure, Result};
use crate::requirements::{managed_release, numeric_release};
use pep440_rs::Version;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const MAX_SOURCE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Copy)]
pub(super) enum Source {
    Conda,
    Uv,
    Pyenv,
    Poetry,
    Pipenv,
}

pub(super) struct Metadata {
    pub(super) version: Version,
    pub(super) input: Option<PathBuf>,
}

pub(super) fn io_failure(_: io::Error) -> Failure {
    // This is a failure reading the manager's data, distinct from a trust
    // denial for the query itself. Core can fall back to lower sources.
    Failure::ProviderUnavailable
}

fn optional<T>(result: io::Result<T>) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_failure(error)),
    }
}

pub(super) fn canonical_directory(path: &Path) -> Result<Option<PathBuf>> {
    let Some(path) = optional(dunce::canonicalize(path))? else {
        return Ok(None);
    };
    Ok(optional(fs::metadata(&path))?
        .filter(|metadata| metadata.is_dir())
        .map(|_| path))
}

pub(super) fn canonical_file(path: &Path, within: Option<&Path>) -> Result<Option<PathBuf>> {
    let Some(path) = optional(dunce::canonicalize(path))? else {
        return Ok(None);
    };
    if within.is_some_and(|root| !path.starts_with(root)) {
        return Ok(None);
    }
    Ok(optional(fs::metadata(&path))?
        .filter(|metadata| metadata.is_file())
        .map(|_| path))
}

pub(super) fn read_text(path: &Path, within: Option<&Path>) -> Result<Option<String>> {
    let Some(path) = canonical_file(path, within)? else {
        return Ok(None);
    };
    let Some(file) = optional(File::open(path))? else {
        return Ok(None);
    };
    let mut data = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(io_failure)?;
    if data.len() as u64 > MAX_SOURCE_BYTES {
        return Err(Failure::LimitExceeded);
    }
    String::from_utf8(data)
        .map(Some)
        .map_err(|_| Failure::ProviderUnavailable)
}

pub(super) fn has_safe_executable(home: &Path) -> Result<bool> {
    let layouts = if cfg!(windows) {
        ["Scripts/python.exe", "python.exe"]
    } else {
        ["bin/python3", "bin/python"]
    };
    for layout in layouts {
        let path = home.join(layout);
        let Some(canonical) = optional(dunce::canonicalize(&path))? else {
            continue;
        };
        // Core checks the first present layout and rejects an escaping target.
        // Skipping that target and looking for a second layout would emit a
        // candidate the host cannot validate.
        if !canonical.starts_with(home) {
            return Ok(false);
        }
        let Some(metadata) = optional(fs::metadata(canonical))? else {
            continue;
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = true;
        return Ok(metadata.is_file() && executable);
    }
    Ok(false)
}

pub(super) fn version(
    home: &Path,
    candidate: &Path,
    source: Source,
    step: impl FnMut() -> Result<()>,
) -> Result<Option<Metadata>> {
    let venv_cfg = home.join("pyvenv.cfg");
    if let Some(config) = read_text(&venv_cfg, Some(home))? {
        let version = config
            .lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(key, _)| matches!(key.trim(), "version" | "version_info"))
            .find_map(|(_, version)| parse_release(version.trim()));
        if let Some(version) = version {
            return Ok(Some(Metadata {
                version,
                input: Some(venv_cfg),
            }));
        }
    }

    if matches!(source, Source::Conda) {
        return conda_version(home, step);
    }
    if !matches!(source, Source::Uv | Source::Pyenv) {
        return Ok(None);
    }
    let version = [home, candidate].into_iter().find_map(|path| {
        path.file_name()?
            .to_str()
            .and_then(managed_release)?
            .parse()
            .ok()
    });
    Ok(version.map(|version| Metadata {
        version,
        input: None,
    }))
}

fn conda_version(home: &Path, mut step: impl FnMut() -> Result<()>) -> Result<Option<Metadata>> {
    let Some(directory) = canonical_directory(&home.join("conda-meta"))?
        .filter(|directory| directory.starts_with(home))
    else {
        return Ok(None);
    };
    let mut python = None;
    for entry in fs::read_dir(directory).map_err(io_failure)? {
        step()?;
        let entry = entry.map_err(io_failure)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name
            .strip_prefix("python-")
            .is_some_and(|rest| rest.starts_with(|character: char| character.is_ascii_digit()))
            || !name.ends_with(".json")
        {
            continue;
        }
        let path = entry.path();
        let Some(contents) = read_text(&path, Some(home))? else {
            continue;
        };
        let record: Value =
            serde_json::from_str(&contents).map_err(|_| Failure::ProviderUnavailable)?;
        if record["name"] != "python" {
            continue;
        }
        let Some(version) = record["version"].as_str().and_then(parse_release) else {
            continue;
        };
        if python
            .as_ref()
            .is_some_and(|(previous, _)| *previous != version)
        {
            return Err(Failure::ProviderUnavailable);
        }
        if python.as_ref().is_none_or(|(_, previous)| path < *previous) {
            python = Some((version, path));
        }
    }
    Ok(python.map(|(version, input)| Metadata {
        version,
        input: Some(input),
    }))
}

fn parse_release(value: &str) -> Option<Version> {
    // Keep a valid prerelease as a prerelease rather than treating its numeric
    // prefix as an installed final release.
    value
        .parse()
        .ok()
        .filter(|_: &Version| numeric_release(value).is_some())
}
