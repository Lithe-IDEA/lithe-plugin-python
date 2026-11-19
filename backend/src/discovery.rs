//! Collects bounded, read-only Python environment facts for the host resolver.

mod metadata;
mod project;

use self::metadata::{canonical_directory, read_text, Metadata, Source};
use lithe_plugin_sdk::toolchains::{
    ToolchainInstallation, ToolchainQuery, ToolchainQueryError, ToolchainQueryResult,
    ToolchainStatement,
};
use lithe_plugin_sdk::Cancellation;
use pep440_rs::Version;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

type Failure = ToolchainQueryError;
type Result<T> = std::result::Result<T, Failure>;

const MAX_SCAN_ENTRIES: usize = 16384;
const MAX_INSTALLATIONS: usize = 512;
const MAX_WATCH_PATHS: usize = 256;
const MAX_PATH_BYTES: usize = 4096;
const PROVIDER_TOOL: &str = "python";

struct Installation {
    home: String,
    names: BTreeSet<OsString>,
    version: Version,
}

struct Snapshot<'a> {
    cancelled: &'a Cancellation,
    workspace: Option<PathBuf>,
    scan_entries: usize,
    installations: BTreeMap<PathBuf, Installation>,
    watch: BTreeSet<String>,
    statements: Vec<ToolchainStatement>,
}

pub(crate) fn query(
    request: &ToolchainQuery,
    cancelled: &Cancellation,
) -> Result<ToolchainQueryResult> {
    cancelled.check()?;
    if request.tools.as_slice() != [PROVIDER_TOOL] {
        return Err(Failure::InvalidParams);
    }
    let workspace = request
        .workspace
        .as_ref()
        .map(|workspace| {
            let root =
                canonical_directory(Path::new(&workspace.root))?.ok_or(Failure::UnsafePath)?;
            let directory = canonical_directory(&root.join(&workspace.directory))?
                .filter(|directory| directory.starts_with(&root))
                .ok_or(Failure::UnsafePath)?;
            Ok::<_, Failure>((root, directory))
        })
        .transpose()?;
    let mut snapshot = Snapshot {
        cancelled,
        workspace: workspace.as_ref().map(|(root, _)| root.clone()),
        scan_entries: 0,
        installations: BTreeMap::new(),
        watch: BTreeSet::new(),
        statements: Vec::new(),
    };

    let user_home = env::home_dir().filter(|path| path.is_absolute());
    if let Some(home) = &user_home {
        snapshot.conda_registry(&home.join(".conda/environments.txt"))?;
    }
    if let Some(paths) = env::var_os("CONDA_ENVS_PATH") {
        for path in env::split_paths(&paths).filter(|path| path.is_absolute()) {
            snapshot.scan(&path, Source::Conda)?;
        }
    }
    if let Some(prefix) = absolute_env("CONDA_PREFIX") {
        snapshot.observe(&prefix, Source::Conda)?;
        snapshot.scan(&prefix.join("envs"), Source::Conda)?;
    }
    if let Some(uv) = uv_root(user_home.as_deref()) {
        snapshot.scan(&uv, Source::Uv)?;
    }
    if let Some(pyenv) = pyenv_root(user_home.as_deref()) {
        snapshot.scan(&pyenv.join("versions"), Source::Pyenv)?;
    }
    if let Some(poetry) = poetry_root(user_home.as_deref()) {
        snapshot.scan(&poetry, Source::Poetry)?;
    }
    if let Some(pipenv) = pipenv_root(user_home.as_deref()) {
        snapshot.scan(&pipenv, Source::Pipenv)?;
    }
    if let Some((root, directory)) = workspace {
        project::read(&mut snapshot, &root, &directory)?;
    }
    cancelled.check()?;
    Ok(ToolchainQueryResult {
        installations: snapshot
            .installations
            .into_values()
            .map(|installation| ToolchainInstallation {
                tool: PROVIDER_TOOL.to_owned(),
                version: installation.version.to_string(),
                home: installation.home,
            })
            .collect(),
        statements: snapshot.statements,
        watch: snapshot.watch.into_iter().collect(),
    })
}

impl Snapshot<'_> {
    fn watch(&mut self, path: &Path) -> Result<()> {
        self.watch.insert(wire_path(path)?);
        if self.watch.len() > MAX_WATCH_PATHS {
            return Err(Failure::LimitExceeded);
        }
        Ok(())
    }

    fn step(&mut self) -> Result<()> {
        self.cancelled.check()?;
        self.scan_entries += 1;
        if self.scan_entries > MAX_SCAN_ENTRIES {
            return Err(Failure::LimitExceeded);
        }
        Ok(())
    }

    fn conda_registry(&mut self, path: &Path) -> Result<()> {
        self.watch(path)?;
        if let Some(registry) = read_text(path, None)? {
            for line in registry
                .lines()
                .map(str::trim)
                .filter(|line| !line.starts_with('#'))
            {
                self.step()?;
                let path = Path::new(line);
                if path.is_absolute() {
                    self.observe(path, Source::Conda)?;
                }
            }
        }
        Ok(())
    }

    fn scan(&mut self, root: &Path, source: Source) -> Result<()> {
        self.watch(root)?;
        let Some(root) = canonical_directory(root)? else {
            return Ok(());
        };
        if self
            .workspace
            .as_ref()
            .is_some_and(|workspace| root.starts_with(workspace))
        {
            return Ok(());
        }
        for entry in std::fs::read_dir(root).map_err(metadata::io_failure)? {
            self.step()?;
            let entry = entry.map_err(metadata::io_failure)?;
            if !entry.file_name().as_encoded_bytes().starts_with(b".") {
                self.observe(&entry.path(), source)?;
            }
        }
        Ok(())
    }

    fn observe(&mut self, candidate: &Path, source: Source) -> Result<()> {
        let Some(home) = canonical_directory(candidate)? else {
            return Ok(());
        };
        if self
            .workspace
            .as_ref()
            .is_some_and(|root| home.starts_with(root))
        {
            return Ok(());
        }
        let names: BTreeSet<_> = [candidate, &home]
            .into_iter()
            .filter_map(Path::file_name)
            .map(OsString::from)
            .collect();
        if let Some(existing) = self.installations.get_mut(&home) {
            existing.names.extend(names);
            return Ok(());
        }
        if !metadata::has_safe_executable(&home)? {
            return Ok(());
        }
        let Some(Metadata { version, input }) =
            metadata::version(&home, candidate, source, || self.step())?
        else {
            return Ok(());
        };
        // A directory watch covers manager additions/removals. The version
        // source is observed separately when it can change in place.
        if let Some(input) = input {
            self.watch(&input)?;
        }
        let wire_home = wire_path(&home)?;
        self.installations.insert(
            home,
            Installation {
                home: wire_home,
                names,
                version,
            },
        );
        if self.installations.len() > MAX_INSTALLATIONS {
            return Err(Failure::LimitExceeded);
        }
        Ok(())
    }
}

fn wire_path(path: &Path) -> Result<String> {
    path.to_str()
        .filter(|value| {
            path.is_absolute()
                && value.len() <= MAX_PATH_BYTES
                && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or(Failure::UnsafePath)
}

fn absolute_env(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn uv_root(home: Option<&Path>) -> Option<PathBuf> {
    absolute_env("UV_PYTHON_INSTALL_DIR").or_else(|| {
        if cfg!(windows) {
            absolute_env("APPDATA").map(|path| path.join("uv/data/python"))
        } else {
            absolute_env("XDG_DATA_HOME")
                .or_else(|| home.map(|path| path.join(".local/share")))
                .map(|path| path.join("uv/python"))
        }
    })
}

fn pyenv_root(home: Option<&Path>) -> Option<PathBuf> {
    absolute_env("PYENV_ROOT").or_else(|| {
        home.map(|path| {
            path.join(if cfg!(windows) {
                ".pyenv/pyenv-win"
            } else {
                ".pyenv"
            })
        })
    })
}

fn poetry_root(home: Option<&Path>) -> Option<PathBuf> {
    absolute_env("POETRY_VIRTUALENVS_PATH").or_else(|| {
        let cache = absolute_env("POETRY_CACHE_DIR").or_else(|| {
            if cfg!(target_os = "macos") {
                home.map(|path| path.join("Library/Caches/pypoetry"))
            } else if cfg!(windows) {
                absolute_env("LOCALAPPDATA").map(|path| path.join("pypoetry/Cache"))
            } else {
                absolute_env("XDG_CACHE_HOME")
                    .or_else(|| home.map(|path| path.join(".cache")))
                    .map(|path| path.join("pypoetry"))
            }
        });
        cache.map(|path| path.join("virtualenvs"))
    })
}

fn pipenv_root(home: Option<&Path>) -> Option<PathBuf> {
    absolute_env("WORKON_HOME").or_else(|| {
        home.map(|path| {
            path.join(if cfg!(windows) {
                ".virtualenvs"
            } else {
                ".local/share/virtualenvs"
            })
        })
    })
}
