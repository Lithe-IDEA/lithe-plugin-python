# Python Support for Lithe (`io.github.lithe-idea.python-support`)

Python language support plugin for Lithe (`schemaVersion: 0`, `pluginAPIVersion: 0`), bundling [Pyrefly](https://github.com/facebook/pyrefly) `1.4.1` for static type checking and LSP navigation and [debugpy](https://github.com/microsoft/debugpy) `1.8.22` for source-level debugging. A Rust backend discovers interpreters and starts the language server. The build integration uses a pytest discovery command and a Python provider for build models, run entries, and test execution.

遵循 Lithe 插件契约 v1（`schemaVersion: 0`），为 Lithe 桌面端（macOS / Windows / Linux）提供开箱即用的 Python 语言支持、宿主工具链驱动的 `Pyrefly` 解释器注入、`.venv` / `.conda` / `conda` / `uv` / `pyenv` 多来源环境发现、动态 `pytest` 测试树收集与执行、`uv` / `conda` / `Ruff` 构建任务、源码级断点调试及新建项目向导。跨平台实现与验证记录详见 [docs/feature-matrix.md](docs/feature-matrix.md)。

---

## 核心能力（Capabilities）

1. **语言与编辑器基础（`languages: python`）**
   - 识别 `.py`、`.pyi`、`.pyw`，配置 `#` 行注释与括号/引号自动配对，声明 `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt` / `Pipfile` / `pyrefly.toml` 项目标记及 `.venv` / `venv` / `.conda` 项目依赖目录。
2. **后端解析的语言服务器启动与解释器自动注入（`backend` + `languageServers: python` / Pyrefly `1.4.1`）**
   - 插件包内的 Rust 后端直接启动 Pyrefly，无需先找到 Python。宿主会传入可用于自动启动的解释器路径，缺失时由 Pyrefly 按自身规则发现项目环境。构建、测试与调试仍用宿主选择的 Python。
   - 构建期按平台固定版本与 SHA-256 打包 `pyrefly 1.4.1`（Unix：`bin/pyrefly`，Windows：`bin/pyrefly.exe`），每个包也包含同一目标架构的 `bin/lithe-python-backend`（Windows 为 `.exe`）。
   - `languageServers[0]` 采用 `"launch": {"kind": "backend", "function": "pyrefly.resolveLaunch", "timeoutMilliseconds": 30000}`：根据 `platform.os` 动态返回包内 `bin/pyrefly` 或 `bin/pyrefly.exe` 与 `arguments: ["lsp"]`，合并全部即时设置（`typeCheckingMode`、`displayTypeErrors`、`diagnosticMode`、`autoImportCompletions`、`completeFunctionParens`、`importFormat`）。
   - 当宿主在调用参数中传入已选定的非项目内解释器 `tools.python.executable`（如外部 `conda`、`uv`、`pyenv` 或系统环境）时，自动注入 `workspaceConfiguration.python.pythonPath`；当 `tools.python` 缺失（未选定或项目内虚拟环境尚未获信任）时优雅省略 `pythonPath`，保留 `pyrefly` 原生 `.venv` / `pyproject.toml` 自动发现且不阻断启动。
3. **工具链与多环境发现增强（`toolDefinitions: python` + `toolchainProviders: 0`）**
   - 严格按 Core 4 层优先级解析：项目级显式绑定 → 项目内环境（`.venv` / `venv` / `.conda`，`projectKind: "environment"`，受宿主工作区信任门控并保留字面软链路径）→ 全局设置 → `VIRTUAL_ENV` 与 `PATH`（`python3` / `python`）→ 16 条跨平台自动发现规则（覆盖 `UV_PYTHON_INSTALL_DIR`、`XDG_DATA_HOME`、`PYENV_ROOT`、`CONDA_ENVS_PATH`、`CONDA_PREFIX`、`WORKON_HOME`、`LOCALAPPDATA`、`APPDATA`、Homebrew、macOS Framework、`~/.pyenv`、`~/.local/share/uv`、`*conda*/envs/*`、`miniforge*/envs/*`）。
   - Rust 提供者读取 conda 环境登记表和安装元数据，以及 uv、pyenv、Poetry、Pipenv 管理的外部环境。项目中的 `.python-version` 选择版本，同一目录的 `pyproject.toml` 限制可选版本。宿主观察这些输入并在变化后重新查询。
   - 需要支持 `toolchainProviders: 0` 的 Lithe 桌面端。外部环境的解释器链接若指向环境目录之外，Core 会拒绝将该环境作为提供者候选。常见于以链接方式创建的 Unix Poetry/Pipenv 环境。使用常规可执行文件副本的环境可被发现，项目内 `.venv` 继续使用宿主的信任流程。
4. **4 个独立构建系统与动态 `pytest` 测试树（`buildSystems: 1` 与 `buildProviders`）**
   - `python` 通过 `test.discoveryCommand` 启动 `python -I -B scripts/discover_tests.py`。宿主使用选定解释器和构建实例目录运行命令，并提供 `${outputFile}`。命令运行 `pytest --collect-only`，汇报函数、类方法和参数化用例的精确选择器。发现为空时写入有效的 `litheTestDiscovery` v0 空列表。选择器或报告超出契约限制时整次发现失败。pytest 缓存与报告位于宿主 `${workspaceStateDir}` 下的本次发现目录，由宿主在操作结束时清理。宿主负责取消并回收整个进程树，收集脚本保留 45 秒的 pytest 超时。
   - Python 构建提供者 `scripts/build_provider.py` 使用 `python -I -B` 启动，处理以下请求。
     - `lithe/build/model`：复用 `scripts/build_model.py` 纯 `ast` + `tomllib`（Python 3.9–3.10 自动回退内置 `vendor/tomli`）静态提取 `[project.scripts]`、包 `__main__.py`、顶层 `__main__` 脚本、Django `manage.py`、FastAPI ASGI、Flask WSGI 运行目标（绝不执行用户代码），派生 7 类声明式 `run` 配置；
     - `lithe/build/test`：通过 pytest node ID 精确运行套件或单个用例，也接受 JUnit XML 类名。指定用例时须同时给出套件。运行时推送 `lithe/build/progress`，并产出 `.pytest_cache/lithe-junit.xml` 供 Core 解码。构建请求在排队时即可取消，执行进程的所有权随请求结束。macOS 和 Linux 使用 POSIX 进程组，Windows 使用 Job Object。
     - `lithe/build/runEntrypoints`：协商 `litheBuild` 1 时按文件静态识别入口并抑制高频成功日志；
     - 同时保留声明式任务 `pip install -r requirements.txt` 与 `mypy`（带诊断 `lineMatcher`）。
   - `uv`（`uv.lock`）：`uv sync`、`uv lock`。
   - `conda`（`environment.yml` / `environment.yaml`）：`conda env update --file environment.yml --prune`。
   - `ruff`（`ruff.toml` / `.ruff.toml` / `pyproject.toml`）：`ruff check`（带诊断 `lineMatcher`）与 `ruff format`。
5. **调试器（`debugAdapters: debugpy`）**
   - 以 `["-I", "-B"]` 隔离参数启动 `scripts/debugpy_adapter.py --log-dir ${logDir}`，双重设置 `PYTHONDONTWRITEBYTECODE=1` 保持已安装插件目录零字节码写入，支持本地 `launch` 与远程 TCP `attach`（`host` / `port` / `pathMappings`）。
6. **终端 Traceback 链接与新建项目向导（`outputLinkMatchers` & `projectGenerators`）**
   - 自动识别终端输出中的 `File "...", line N` 并支持跳转源码；新建项目向导支持固定项目级 `python` 解释器（`pinAs: "project"`）及创建 `.venv`（`venv` / `uv`）。

---

## 日志接线说明（Structured Logging v2 Wiring）

插件包含包内 Rust SDK 后端、构建提供者（`scripts/build_provider.py`）与声明式贡献，诊断通过 Lithe 结构化日志 v2 规范（Core `rust/logging/README.md`、`shared/plugins/contract/v1/README.md#structured-plugin-diagnostics` 与 `shared/plugins/guides/plugin-logging.md`），**零自建插件日志文件**，已安装插件目录在运行期保持 **100% 只读**。

### 1. 后端与构建 Provider 协议接线（统一通道：`plugins/io.github.lithe-idea.python-support/host`）

Rust SDK 和构建提供者的 `scripts/lithe_rpc.py` 通过 stdio JSON-RPC 2.0 发送结构化诊断，与宿主代记的声明式贡献共用通道 `plugins/io.github.lithe-idea.python-support/host`（见 Core `rust/logging/events/plugins.json`）：
- **强制协商 `litheLogging` 0**：`initialize` 缺少 `experimental.litheLogging` `versions: [0]` 时立即以 `-32600` 拒绝握手；两种后端的 `stdout` 均只输出 `Content-Length` JSON-RPC 帧。
- **请求级 `operationId` 关联与时序**：所有 `lithe/log` 通知严格在对应 JSON-RPC 响应帧发出**之前**写入 `stdout`，携带宿主请求传入的 `operationID`（回退为受控请求 ID），确保 Core 将诊断精确关联到活跃操作。
- **取消不记失败**：收到 `$/cancelRequest` 时停止扫描或终止构建子进程组（POSIX 进程组 / Windows Job Object），返回 `-32800` 且不发送 `operationFinished` 或 `operationFailed`。

| `operation` | 所属进程 | 成功事件与级别 | 降级 / 恢复事件（`WARN`） | 失败事件与级别（`ERROR`） | 受控 `code` 类别标识 |
| --- | --- | --- | --- | --- | --- |
| `initialize` | Rust 后端 / `build_provider.py` | 握手由 Core 记录 `plugins.host.protocol.initialized`（`INFO`） | — | 握手失败由 Core / 宿主记录 | 宿主协议错误 |
| `pyrefly.resolveLaunch` | Rust 后端 | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`） | 降级：`plugins.operation.fallback_selected`（`code: "invalid_tool_hint"`，`count: 1`）<br>恢复：`plugins.operation.recovery_finished`（`code: "tool_hint_restored"`，`count: 1`） | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `invalid_tool_hint`、`tool_hint_restored`、`python.unknownServer`、`internal_error` |
| `python.inspectEnvironment` | Rust 后端 | **已启用 `suppressSuccessDiagnostics`**（高频只读查询成功不发 `INFO`） | — | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `python.invalidExecutable`、`python.environmentUnavailable`、`internal_error` |
| `lithe/build/model` | `build_provider.py` | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`） | 降级：`plugins.operation.fallback_selected`（`code: "pyproject_parse_failed"`，`count: 1`）<br>恢复：`plugins.operation.recovery_finished`（`code: "pyproject_restored"`，`count: 1`） | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `pyproject_parse_failed`、`pyproject_restored`、`python.invalidRoot`、`python.projectUnavailable`、`internal_error` |
| `lithe/build/test` | `build_provider.py` | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`；测试断言失败仍属正常协议返回 `exitCode != 0`，失效/越界选择器、进程级超时或解释器缺失才记 `ERROR`） | — | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `python.invalidTestSelector`、`python.staleTestSelector`、`python.pytestTimedOut`、`python.interpreterUnavailable`、`python.projectUnavailable`、`internal_error` |
| `lithe/build/runEntrypoints` | `build_provider.py` | **已启用 `suppressSuccessDiagnostics`**（打开文件高频静态入口探测成功不发 `INFO`） | — | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `python.invalidRoot`、`python.projectUnavailable`、`internal_error` |
| `notification` / `result-encoding` / `shutdown` | `lithe_rpc.py` | — | — | `plugins.operation.failed`（`ERROR`） | `framing_error`、`result_encoding_failed`、`internal_error` |

`toolchains/query` 是高频只读操作，成功由 SDK 返回事实。取消、读取失败、扫描超限与不安全输入通过 `plugin.toolchain.*` 结构化返回。宿主工具链层观察并处理查询及解码失败。协议 v0 的 SDK 无该操作的诊断回调。

### 2. 宿主代记的声明式插件操作（通道：`plugins/io.github.lithe-idea.python-support/host`）

声明式启动的语言服务器子进程、调试适配器和测试发现命令由宿主与 Core 经 `diagnostics.recordPluginOperation` 将唯一终态代记到 `plugins/io.github.lithe-idea.python-support/host`。用户主动取消或停止不记录。

| `operation` | 声明来源 | 记录方 | 成功事件与级别 | 失败事件与级别 | 可能的 `host.*` 失败类别标识（`code`） |
| --- | --- | --- | --- | --- | --- |
| `languageServer/start` | `languageServers[]`（`pyrefly.resolveLaunch` 解析后的 `pyrefly lsp` 进程） | 启动前失败由桌面宿主记录；进入启动后经 `lsp.startServer.startupOperation` 交由 Core 记录唯一终态 | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.planFailed`、`host.executableUnavailable`、`host.launchFailed`、`host.exitedEarly`、`host.initializeFailed`、`host.timedOut` |
| `debugAdapter/start` | `debugAdapters[]`（`debugpy`） | 桌面宿主（`op` 为调试会话 ID；用户停止与 Core 拒绝建会话不记录） | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.executableUnavailable`、`host.launchFailed`、`host.exitedEarly`、`host.initializeFailed`、`host.timedOut` |
| `lithe/build/discoverTests` | `buildSystems[].test.discoveryCommand`（`pytest --collect-only`） | 桌面宿主 | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.planFailed`、`host.executableUnavailable`、`host.launchFailed`、`host.commandFailed`、`host.timedOut`、`host.outputInvalid` |

### 3. 上游子进程通道、隐私红线与原生日志文件

| 组件 / 命令 | v2 结构化通道或原生文件位置 | 级别、限流、脱敏与清理策略 |
| --- | --- | --- |
| Rust 后端 / `build_provider.py` | 结构化通道：`plugins/io.github.lithe-idea.python-support/host`<br>未分类 `stderr`：`plugins.host.stderr.received`（`DEBUG`） | **零自建日志文件**；会话启动与握手由 Core 记录 `plugins.host.process.started` / `plugins.host.protocol.initialized` / `plugins.host.session.updated`；未预期异常在 `stderr` 仅输出 `<server-name>: <category> (<ExceptionType>)` 受控短词，**绝不拼接文件路径、命令参数、源码片段、输出内容或环境变量值**。Core 对 `stderr` 按每行 4 KiB 限流并脱敏截断，仅在详细诊断开启时落盘。 |
| `pyrefly lsp`（语言服务器） | 结构化通道：`plugins/io.github.lithe-idea.python-support/host`（或宿主内置 `lsp/python`） | Core 记录 `plugins.host.process.started`、`plugins.host.protocol.initialized`、`plugins.host.session.updated`；`window/logMessage` 与 `window/showMessage` 保留显式 `ERROR`/`WARN`/`INFO`/`DEBUG` 级别；未分类 `stderr` 经 `plugins.host.stderr.received` 记为 `DEBUG`（仅详细诊断开启时落盘）；详细诊断开启（15 分钟单次到期）时仅接纳 `$/logTrace.message` 摘要，拒绝 `verbose` 载荷。`pyrefly` 不写任何插件内文件。 |
| `debugpy`（调试适配器与启动器） | 结构化通道：`debug/debugpy`<br>原生日志文件：`sessions/<session>/plugins/io.github.lithe-idea.python-support/files/debugpy.*.log` | 结构化会话事件写入 `debug/debugpy`；上游 `debugpy` 原生日志通过 `--log-dir ${logDir}` 定向写入宿主 `Store.PluginFilesDirectory` 创建的当前会话专属目录（权限 `0700`，逐段校验拒绝软链越界，绝不写插件安装目录或 app bundle），按 `<pid>` 建文件并随宿主日志会话生命周期统一保留与清理。 |
| `pytest`、构建任务与项目生成 | 测试发现报告（`${outputFile}`）、构建/测试面板流式输出（`lithe/build/progress`）与 JUnit XML（`.pytest_cache/lithe-junit.xml`） | `pytest --collect-only` 的缓存与报告同目录，随宿主发现操作结束清理。宿主可向用户展示失败命令的部分输出。v2 结构化诊断只保存阶段类别和耗时。 |

---

## 本地构建、缓存与测试（Build, Cache & Verification）

### 构建与缓存目录说明（跨工作树复用规则）

| 路径 | 归属与用途 | 生命周期 | 跨 Git Worktree 复用策略 |
| --- | --- | --- | --- |
| `.cache/` | `scripts/package.mjs` 下载并经 SHA-256 校验的上游原始归档（`pyrefly` 6 平台压缩包、`debugpy` wheel、`tomli` wheel） | 本地持久化缓存（已被 `.gitignore` 忽略） | **可安全复制复用**（文件名含上游版本与平台，读取前强制校验 `vendor-lock.json` SHA-256；复制到新工作树 `.cache/`，勿跨并发打包共享写） |
| `backend/target/` | Rust 后端编译输出，包含按平台目标区分的产物 | 随工作树保留，可重新由 Cargo 生成 | 不共享，构建时由固定的 Cargo.lock 和 Rust 目标重建。Cargo 使用全局 registry 与 Git 依赖下载缓存。 |
| `.artifacts/stage/` | 打包过程中的单平台解包暂存目录 | 每次 `scripts/package.mjs` 按平台重建（`.gitignore` 忽略） | **不可复用**（构建中间产物，毫秒级重建） |
| `.artifacts/lithe-host/` | `scripts/e2e-host.mjs` 检出的宿主稀疏工作树及其编译产物 | 本地按需保留（`.gitignore` 忽略） | 其内部 `.artifacts/desktop` 在同一操作系统、CPU 架构与相同 `PINNED_CORE_REVISION` 前提下可按宿主规则复制加速，不得跨工作树软链共用；任何运行时会话日志目录（`sessions/<session>/plugins/.../files/`）与状态目录严禁跨工作树复制 |
| `dist/` | 最终产出的 `python-support-<version>-<platform>.zip` 发布包 | 打包输出（`.gitignore` 忽略） | 按需重新运行 `node scripts/package.mjs` 生成 |

### 常用命令

打包需要 Node.js 与 Rust 1.87，并由 `backend/Cargo.lock` 固定依赖。SDK 固定到 Core 的 Git 提交。Linux 目标使用 musl，Windows 使用 MSVC 并静态链接 C 运行库，macOS 使用系统链接器。发布使用 CI 的六平台构建矩阵。

插件测试使用真实 pytest。将 pytest 安装到 `PYTHON` 对应的环境，或通过 `PYTEST_PYTHON` 指定已安装 pytest 的解释器。

```bash
# 打包当前开发平台（例如 macOS Apple Silicon）
node scripts/package.mjs --platform darwin-arm64

# 本机具备全部六种 Rust 目标和链接器时打包全部平台
node scripts/package.mjs

# 校验 dist/ 下构建产物的目录安全性、Windows 文件名/大小写兼容性与清单一致性
node --test --test-timeout=60000 scripts/package/*.test.mjs

# 运行 Rust 规则测试、打包后端协议验证及真实 Pyrefly / pytest / debugpy 工作流
cargo test --locked --manifest-path backend/Cargo.toml
node scripts/test.mjs

# 使用 e2e/host/lithe-host.json 固定的兼容桌面候选
node scripts/e2e-host.mjs

# 也可使用另一个兼容的本地检出和提交
node scripts/e2e-host.mjs --source /path/to/Lithe-IDEA --ref COMPATIBLE_HOST_COMMIT
```

---

## 许可证（License）

- 插件清单、Rust 后端、脚本、模板、图标与文档采用 [Apache-2.0](LICENSE) 许可协议。
- 随包分发的第三方开源组件（Pyrefly `1.4.1`、debugpy `1.8.22`、Tomli `2.5.0`，均为 MIT 许可）完整版权声明与许可证全文见 [io.github.lithe-idea.python-support/THIRD-PARTY-NOTICES.txt](io.github.lithe-idea.python-support/THIRD-PARTY-NOTICES.txt) 及包内 `vendor/debugpy/ThirdPartyNotices.txt`。
- Rust 后端的依赖及对应许可证由 `Cargo.lock` 固定，全文随包附在 `RUST-THIRD-PARTY-NOTICES.txt`。
