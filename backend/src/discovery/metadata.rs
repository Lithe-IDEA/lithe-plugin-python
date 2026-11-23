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
    Hatch,
    Virtualenvwrapper,
}

pub(super) struct Metadata {
    pub(super) version: Version,
    pub(super) input: Option<PathBuf>,
    /// The version came from `pyvenv.cfg`: the home is a virtual environment
    /// made from some base interpreter, not an installation of its own.
    pub(super) virtual_environment: bool,
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

/// Mirrors the host check of an installation's program so the provider only
/// reports homes the host accepts. Core decides on the first layout that exists.
/// A program inside the home is accepted as is. A virtual environment's program
/// usually links to its base interpreter outside the environment; the tool
/// definition allows that (`executableLinksOutsideHome`) as long as every
/// directory on the layout path, such as `bin`, stays inside the home. Nothing
/// on the way may enter the workspace.
pub(super) fn has_safe_executable(home: &Path, workspace: Option<&Path>) -> Result<bool> {
    let layouts: [&[&str]; 2] = if cfg!(windows) {
        [&["Scripts", "python.exe"], &["python.exe"]]
    } else {
        [&["bin", "python3"], &["bin", "python"]]
    };
    let in_workspace = |path: &Path| workspace.is_some_and(|root| path.starts_with(root));
    for segments in layouts {
        let path = segments
            .iter()
            .fold(home.to_path_buf(), |path, segment| path.join(segment));
        if optional(fs::symlink_metadata(&path))?.is_none() {
            continue;
        }
        // Skipping a present but unusable layout and looking for the next one
        // would report a home the host rejects.
        let Some(target) = optional(dunce::canonicalize(&path))? else {
            return Ok(false);
        };
        if in_workspace(&target) {
            return Ok(false);
        }
        if !target.starts_with(home) {
            let mut parent = home.to_path_buf();
            for segment in &segments[..segments.len() - 1] {
                parent.push(segment);
                let Some(directory) = canonical_directory(&parent)? else {
                    return Ok(false);
                };
                if !directory.starts_with(home) || in_workspace(&directory) {
                    return Ok(false);
                }
            }
        }
        let Some(metadata) = optional(fs::metadata(&target))? else {
            return Ok(false);
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
                virtual_environment: true,
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
        virtual_environment: false,
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
        virtual_environment: false,
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

#[cfg(all(test, unix))]
mod tests {
    use super::has_safe_executable;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};

    /// A scratch directory removed when the test ends, canonical like the homes
    /// discovery passes in.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "python-support-metadata-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(dunce::canonicalize(path).unwrap())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn interpreter(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A venv made by `python -m venv` outside the project: `bin/python3`
    /// links to the base interpreter in another directory.
    fn environment(scratch: &Path, target: &Path) -> PathBuf {
        let home = scratch.join("env");
        fs::create_dir_all(home.join("bin")).unwrap();
        symlink(target, home.join("bin/python3")).unwrap();
        home
    }

    #[test]
    fn an_environment_linking_to_its_base_interpreter_is_reported() {
        let scratch = Scratch::new("linked");
        let base = scratch.0.join("base/bin/python3.12");
        interpreter(&base);
        let home = environment(&scratch.0, &base);
        assert!(has_safe_executable(&home, Some(&scratch.0.join("project"))).unwrap());
    }

    #[test]
    fn a_program_inside_the_home_is_reported() {
        let scratch = Scratch::new("inside");
        let home = scratch.0.join("install");
        interpreter(&home.join("bin/python3"));
        assert!(has_safe_executable(&home, None).unwrap());
    }

    #[test]
    fn a_program_in_the_workspace_is_not_reported() {
        let scratch = Scratch::new("workspace");
        let workspace = scratch.0.join("project");
        let target = workspace.join("tools/python3");
        interpreter(&target);
        let home = environment(&scratch.0, &target);
        assert!(!has_safe_executable(&home, Some(&workspace)).unwrap());
    }

    #[test]
    fn a_bin_directory_leaving_the_home_is_not_reported() {
        let scratch = Scratch::new("bin");
        let base = scratch.0.join("base");
        interpreter(&base.join("bin/python3"));
        let home = scratch.0.join("env");
        fs::create_dir_all(&home).unwrap();
        symlink(base.join("bin"), home.join("bin")).unwrap();
        assert!(!has_safe_executable(&home, None).unwrap());
    }

    #[test]
    fn a_broken_first_layout_decides_like_the_host() {
        let scratch = Scratch::new("dangling");
        let home = environment(&scratch.0, &scratch.0.join("missing/python3"));
        interpreter(&home.join("bin/python"));
        assert!(!has_safe_executable(&home, None).unwrap());
    }
}
