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
    /// A virtual environment belongs to one project. A version request picks
    /// it only by its name, never by its version alone.
    virtual_environment: bool,
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
    // virtualenvwrapper keeps environments in ~/.virtualenvs unless WORKON_HOME
    // moves them, and so does Hatch when configured to use it. On Windows this
    // is already the Pipenv default above.
    if !cfg!(windows) && env::var_os("WORKON_HOME").is_none() {
        if let Some(home) = &user_home {
            snapshot.scan(&home.join(".virtualenvs"), Source::Virtualenvwrapper)?;
        }
    }
    if let Some(hatch) = hatch_root(user_home.as_deref()) {
        snapshot.scan_hatch(&hatch)?;
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
        for entry in self.entries(root)? {
            self.observe(&entry, source)?;
        }
        Ok(())
    }

    /// Hatch keeps each environment under `<project name>/<project ID>/`. The
    /// root and each project ID directory are watched, as an environment is
    /// added to the latter; a new project name also changes the root.
    fn scan_hatch(&mut self, root: &Path) -> Result<()> {
        self.watch(root)?;
        for project in self.entries(root)? {
            for id in self.entries(&project)? {
                if canonical_directory(&id)?.is_some() {
                    self.scan(&id, Source::Hatch)?;
                }
            }
        }
        Ok(())
    }

    /// Lists the entries of a directory outside the workspace, skipping hidden
    /// ones such as Hatch's `.pythons`. A missing directory has no entries.
    fn entries(&mut self, directory: &Path) -> Result<Vec<PathBuf>> {
        let Some(directory) = canonical_directory(directory)? else {
            return Ok(Vec::new());
        };
        if self
            .workspace
            .as_ref()
            .is_some_and(|workspace| directory.starts_with(workspace))
        {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(directory).map_err(metadata::io_failure)? {
            self.step()?;
            let entry = entry.map_err(metadata::io_failure)?;
            if !entry.file_name().as_encoded_bytes().starts_with(b".") {
                entries.push(entry.path());
            }
        }
        Ok(entries)
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
        if !metadata::has_safe_executable(&home, self.workspace.as_deref())? {
            return Ok(());
        }
        let Some(Metadata {
            version,
            input,
            virtual_environment,
        }) = metadata::version(&home, candidate, source, || self.step())?
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
                virtual_environment,
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

fn hatch_root(home: Option<&Path>) -> Option<PathBuf> {
    let data = absolute_env("HATCH_DATA_DIR").or_else(|| {
        if cfg!(target_os = "macos") {
            home.map(|path| path.join("Library/Application Support/hatch"))
        } else if cfg!(windows) {
            absolute_env("LOCALAPPDATA").map(|path| path.join("hatch"))
        } else {
            absolute_env("XDG_DATA_HOME")
                .or_else(|| home.map(|path| path.join(".local/share")))
                .map(|path| path.join("hatch"))
        }
    });
    data.map(|path| path.join("env/virtual"))
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
