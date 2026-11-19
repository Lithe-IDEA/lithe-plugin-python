//! Reads the nearest manager declarations without importing workspace code.

use super::{
    metadata::canonical_file, read_text, wire_path, Failure, Result, Snapshot, PROVIDER_TOOL,
};
use crate::requirements::{matches_version_file, Constraint};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use lithe_plugin_sdk::toolchains::{ToolchainScope, ToolchainStatement, ToolchainStatementKind};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MAX_ANCESTORS: usize = 64;
const MAX_REQUEST_BYTES: usize = 512;

pub(super) fn read(snapshot: &mut Snapshot<'_>, root: &Path, directory: &Path) -> Result<()> {
    for (index, ancestor) in directory.ancestors().enumerate() {
        snapshot.cancelled.check()?;
        if index == MAX_ANCESTORS {
            return Err(Failure::LimitExceeded);
        }
        let version = version_file(snapshot, root, ancestor)?;
        project_file(snapshot, root, ancestor, version)?;
        if ancestor == root {
            break;
        }
    }
    Ok(())
}

fn version_file(
    snapshot: &mut Snapshot<'_>,
    root: &Path,
    directory: &Path,
) -> Result<Option<(PathBuf, String)>> {
    let path = directory.join(".python-version");
    snapshot.watch(&path)?;
    let Some(source) = source(&path, root)? else {
        return Ok(None);
    };
    let Some(text) = read_text(&source, Some(root))? else {
        return Ok(None);
    };
    let request = text
        .lines()
        .filter_map(|line| line.split('#').next())
        .flat_map(str::split_ascii_whitespace)
        .next();
    Ok(request.map(|request| (source, request.to_owned())))
}

fn project_file(
    snapshot: &mut Snapshot<'_>,
    root: &Path,
    directory: &Path,
    selected_version: Option<(PathBuf, String)>,
) -> Result<()> {
    let project_path = directory.join("pyproject.toml");
    let poetry_lock = directory.join("poetry.lock");
    let pipfile = directory.join("Pipfile");
    for path in [&project_path, &poetry_lock, &pipfile] {
        snapshot.watch(path)?;
    }

    let mut project_name = None;
    let mut project_requirement = None;
    if let Some(source) = source(&project_path, root)? {
        if let Some(text) = read_text(&source, Some(root))? {
            let project: toml::Table = text.parse().map_err(|_| Failure::ProviderUnavailable)?;
            let metadata = project.get("project");
            let poetry = project.get("tool").and_then(|tool| tool.get("poetry"));
            project_name = metadata
                .and_then(|table| text_value(table, "name"))
                .or_else(|| poetry.and_then(|table| text_value(table, "name")))
                .map(str::to_owned);
            let poetry_range = poetry
                .and_then(|table| table.get("dependencies"))
                .and_then(|table| text_value(table, "python"));
            let range = metadata.and_then(|table| text_value(table, "requires-python"));
            if let Some((request, constraint)) = range
                .map(|range| (range, Constraint::project(range)))
                .or_else(|| poetry_range.map(|range| (range, Constraint::poetry(range))))
            {
                project_requirement = Some((source, request.to_owned(), constraint));
            }
        }
    }

    let allows_version = |version: &pep440_rs::Version| {
        project_requirement
            .as_ref()
            .is_none_or(|(_, _, constraint)| {
                constraint
                    .as_ref()
                    .is_some_and(|value| value.contains(version))
            })
    };
    // Core treats separate version declarations from one directory as
    // alternatives. A manager pin and the project's compatibility range apply
    // together, so publish one request anchored at the file selecting the version.
    if let Some((source, request)) = selected_version {
        let installation = choose(snapshot, |candidate| {
            allows_version(&candidate.version)
                && candidate
                    .names
                    .iter()
                    .filter_map(|name| name.to_str())
                    .any(|name| matches_version_file(&request, name, &candidate.version))
        });
        statement(
            snapshot,
            &source,
            &request,
            installation,
            ToolchainStatementKind::Declaration,
            "compatible",
        )?;
    } else if let Some((source, request, _)) = &project_requirement {
        let installation = choose(snapshot, |candidate| allows_version(&candidate.version));
        statement(
            snapshot,
            source,
            request,
            installation,
            ToolchainStatementKind::Declaration,
            "native",
        )?;
    }

    if let Some(source) = source(&poetry_lock, root)? {
        let prefix = poetry_prefix(directory, project_name.as_deref());
        if let Some(home) = choose(snapshot, |candidate| {
            candidate
                .names
                .iter()
                .filter_map(|name| name.to_str())
                .any(|name| name.starts_with(&prefix))
                && allows_version(&candidate.version)
        }) {
            statement(
                snapshot,
                &source,
                &prefix,
                Some(home),
                ToolchainStatementKind::Environment,
                "native",
            )?;
        }
    }
    if let Some(source) = source(&pipfile, root)? {
        let name = pipenv_name(directory, &source);
        if let Some(home) = choose(snapshot, |candidate| {
            candidate.names.contains(std::ffi::OsStr::new(&name))
                && allows_version(&candidate.version)
        }) {
            statement(
                snapshot,
                &source,
                &name,
                Some(home),
                ToolchainStatementKind::Environment,
                "native",
            )?;
        }
    }
    Ok(())
}

fn source(path: &Path, root: &Path) -> Result<Option<std::path::PathBuf>> {
    // A linked declaration can point to arbitrary files and no longer
    // identifies this project's declared watch pattern. Only read the exact
    // expected filename in the canonical workspace directory.
    Ok(canonical_file(path, Some(root))?.filter(|canonical| canonical == path))
}

fn text_value<'a>(table: &'a toml::Value, key: &str) -> Option<&'a str> {
    table
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn choose(
    snapshot: &Snapshot<'_>,
    mut matches: impl FnMut(&super::Installation) -> bool,
) -> Option<String> {
    let mut best: Option<&super::Installation> = None;
    let mut tied = false;
    for candidate in snapshot
        .installations
        .values()
        .filter(|candidate| matches(candidate))
    {
        match best.map(|value| value.version.cmp(&candidate.version)) {
            Some(std::cmp::Ordering::Greater) => {}
            Some(std::cmp::Ordering::Equal) => tied = true,
            _ => {
                best = Some(candidate);
                tied = false;
            }
        }
    }
    best.filter(|_| !tied)
        .map(|candidate| candidate.home.clone())
}

fn statement(
    snapshot: &mut Snapshot<'_>,
    source: &Path,
    request: &str,
    installation: Option<String>,
    kind: ToolchainStatementKind,
    reader: &str,
) -> Result<()> {
    if request.len() > MAX_REQUEST_BYTES || request.chars().any(char::is_control) {
        return Err(Failure::LimitExceeded);
    }
    snapshot.statements.push(ToolchainStatement {
        tool: PROVIDER_TOOL.to_owned(),
        scope: ToolchainScope::Project,
        source: wire_path(source)?,
        request: request.to_owned(),
        installation,
        kind,
        reader: reader.to_owned(),
    });
    Ok(())
}

fn pipenv_name(directory: &Path, pipfile: &Path) -> String {
    let name = directory.file_name().unwrap_or_default().to_string_lossy();
    let name: String = name
        .replace(
            [
                ' ', '&', '$', '`', '!', '*', '@', '"', '(', ')', '[', ']', '\\', '\r', '\n', '\t',
            ],
            "_",
        )
        .chars()
        .take(42)
        .collect();
    // Pipenv hashes the full Pipfile path. Poetry hashes the project directory.
    let hash = Sha256::digest(pipfile.to_string_lossy().as_bytes());
    format!("{name}-{}", URL_SAFE_NO_PAD.encode(&hash[..6]))
}

fn poetry_prefix(directory: &Path, name: Option<&str>) -> String {
    let name = name.unwrap_or_else(|| {
        directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
    });
    let name: String = sanitize(&name.to_lowercase()).chars().take(42).collect();
    let path = directory.to_string_lossy();
    let normalized = if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.into_owned()
    };
    let hash = Sha256::digest(normalized.as_bytes());
    format!("{name}-{}-py", URL_SAFE_NO_PAD.encode(&hash[..6]))
}

fn sanitize(name: &str) -> String {
    name.replace(
        [' ', '$', '`', '!', '*', '@', '"', '\\', '\r', '\n', '\t'],
        "_",
    )
}
