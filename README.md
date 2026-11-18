# Python Support for Lithe (`io.github.lithe-idea.python-support`)

Python language support plugin for Lithe (`v0.1.2`, `schemaVersion: 0`, `pluginAPIVersion: 0`), bundling [Pyrefly](https://github.com/facebook/pyrefly) `1.4.1` for fast static type checking and LSP navigation, [debugpy](https://github.com/microsoft/debugpy) `1.8.22` for source-level debugging, and a zero-compilation pure-Python (`python -I -B`) plugin backend and build provider.

遵循 Lithe 插件契约 v1（`schemaVersion: 0`），为 Lithe 桌面端（macOS / Windows / Linux）提供开箱即用的 Python 语言支持、宿主工具链驱动的 `Pyrefly` 解释器注入、`.venv` / `.conda` / `conda` / `uv` / `pyenv` 多来源环境发现、动态 `pytest` 测试树收集与执行、`uv` / `conda` / `Ruff` 构建任务、源码级断点调试及新建项目向导。跨平台实现与验证记录详见 [docs/feature-matrix.md](docs/feature-matrix.md)。

---

## 核心能力（Capabilities）

1. **语言与编辑器基础（`languages: python`）**
   - 识别 `.py`、`.pyi`、`.pyw`，配置 `#` 行注释与括号/引号自动配对，声明 `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt` / `Pipfile` / `pyrefly.toml` 项目标记及 `.venv` / `venv` / `.conda` 项目依赖目录。
2. **后端解析的语言服务器启动与解释器自动注入（`backend` + `languageServers: python` / Pyrefly `1.4.1`）**
   - 构建期按平台固定版本与 SHA-256 打包 `pyrefly 1.4.1`（Unix：`bin/pyrefly`，Windows：`bin/pyrefly.exe`），6 个平台发布包共享同一套纯 Python（`python -I -B`）插件后端 `scripts/backend.py`。
   - `languageServers[0]` 采用 `"launch": {"kind": "backend", "function": "pyrefly.resolveLaunch", "timeoutMilliseconds": 30000}`：根据 `platform.os` 动态返回包内 `bin/pyrefly` 或 `bin/pyrefly.exe` 与 `arguments: ["lsp"]`，合并全部即时设置（`typeCheckingMode`、`displayTypeErrors`、`diagnosticMode`、`autoImportCompletions`、`completeFunctionParens`、`importFormat`）。
   - 当宿主在调用参数中传入已选定的非项目内解释器 `tools.python.executable`（如外部 `conda`、`uv`、`pyenv` 或系统环境）时，自动注入 `workspaceConfiguration.python.pythonPath`；当 `tools.python` 缺失（未选定或项目内虚拟环境尚未获信任）时优雅省略 `pythonPath`，保留 `pyrefly` 原生 `.venv` / `pyproject.toml` 自动发现且不阻断启动。
3. **工具链与多环境发现增强（`toolDefinitions: python` + `toolchain_provider.py`）**
   - 严格按 Core 4 层优先级解析：项目级显式绑定 → 项目内环境（`.venv` / `venv` / `.conda`，`projectKind: "environment"`，受宿主工作区信任门控并保留字面软链路径）→ 全局设置 → `VIRTUAL_ENV` 与 `PATH`（`python3` / `python`）→ 16 条跨平台自动发现规则（覆盖 `UV_PYTHON_INSTALL_DIR`、`XDG_DATA_HOME`、`PYENV_ROOT`、`CONDA_ENVS_PATH`、`CONDA_PREFIX`、`WORKON_HOME`、`LOCALAPPDATA`、`APPDATA`、Homebrew、macOS Framework、`~/.pyenv`、`~/.local/share/uv`、`*conda*/envs/*`、`miniforge*/envs/*`）。
   - `scripts/toolchain_provider.py` 完整实现 `litheToolchains`（`toolchains/query`）协议（支持 `~/.conda/environments.txt`、`CONDA_ENVS_PATH`、`UV_PYTHON_INSTALL_DIR`、`PYENV_ROOT`、Poetry 与 Pipenv 外部虚拟环境、`.python-version` 与 `pyproject.toml` `requires-python`）。因当前桌面宿主 `pluginhost.Declared()` 尚未开放 `toolchainProviders`，`plugin.json` 暂不声明 `requires.toolchainProviders: 0` 以确保当前宿主 100% 可安装通过；当宿主握手提供 `experimental.litheToolchains` 时，`backend.py` 自动启用响应。
4. **4 个独立构建系统与动态 `pytest` 测试树（`buildSystems` & `buildProviders`）**
   - `python`：通过纯 Python 构建提供者 `scripts/build_provider.py --cache ${workspaceStateDir}`（`python -I -B`，`executesProjectCode: true`，`mayUseNetwork: false`）承载：
     - `lithe/build/model`：复用 `scripts/build_model.py` 纯 `ast` + `tomllib`（Python 3.9–3.10 自动回退内置 `vendor/tomli`）静态提取 `[project.scripts]`、包 `__main__.py`、顶层 `__main__` 脚本、Django `manage.py`、FastAPI ASGI、Flask WSGI 运行目标（绝不执行用户代码），派生 7 类声明式 `run` 配置；
     - `lithe/build/discoverTests`：运行有界、可随 `$/cancelRequest` 整组终止的 `pytest --collect-only` 收集函数、类方法与 `@pytest.mark.parametrize` 参数化用例（缓存写入 `${workspaceStateDir}`，不向工作区写 `.pytest_cache`），返回标准 `litheTestDiscovery` v0；
     - `lithe/build/test`：支持从动态测试树精确 nodeid 或 JUnit XML 类名运行单个用例/套件，实时推送 `lithe/build/progress` 并产出 `.pytest_cache/lithe-junit.xml` 供 Core `junitXml` 解码；
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

本插件 `0.1.2` 包含纯 Python 插件后端（`scripts/backend.py`）、构建提供者（`scripts/build_provider.py`）与声明式贡献，全部诊断严格遵循 Lithe 结构化日志 v2 规范（Core `rust/logging/README.md`、`shared/plugins/contract/v1/README.md#structured-plugin-diagnostics` 与 `shared/plugins/guides/plugin-logging.md`），**零自建插件日志文件**，已安装插件目录在运行期保持 **100% 只读**。

### 1. 后端与构建 Provider 协议接线（通道：`plugins/io.github.lithe-idea.python-support/backend`）

`scripts/lithe_rpc.py` 实现 stdio JSON-RPC 2.0 协议帧传输：
- **强制协商 `litheLogging` 0**：`initialize` 缺少 `experimental.litheLogging` `versions: [0]` 时立即以 `-32600` 拒绝握手；握手成功后将 Python 层 `sys.stdout` 重定向到 `sys.stderr`，确保 `stdout` 仅输出合法 `Content-Length` JSON-RPC 帧。
- **请求级 `operationId` 关联与时序**：所有 `lithe/log` 通知严格在对应 JSON-RPC 响应帧发出**之前**写入 `stdout`，携带宿主请求传入的 `operationID`（回退为受控请求 ID），确保 Core 将诊断精确关联到活跃操作。
- **取消不记失败**：收到 `$/cancelRequest` 时立即终止关联子进程组（POSIX `os.killpg` / Windows `taskkill /T /F`），返回 `-32800` 且**不发送** `operationFinished` 或 `operationFailed`。

| `operation` | 所属进程 | 成功事件与级别 | 降级 / 恢复事件（`WARN`） | 失败事件与级别（`ERROR`） | 受控 `code` 类别标识 |
| --- | --- | --- | --- | --- | --- |
| `initialize` | `backend.py` / `build_provider.py` | 握手由 Core 记录 `lsp.protocol.initialized`（`INFO`） | `plugins.operation.fallback_selected`（`code: "functions_unavailable"`，当宿主未协商 `litheFunctions` 时） | 握手失败由 Core / 宿主记录 | `functions_unavailable` |
| `pyrefly.resolveLaunch` | `backend.py` | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`） | 降级：`plugins.operation.fallback_selected`（`code: "invalid_tool_hint"`，`count: 1`）<br>恢复：`plugins.operation.recovery_finished`（`code: "tool_hint_restored"`，`count: 1`） | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `invalid_tool_hint`、`tool_hint_restored`、`python.unknownServer`、`internal_error` |
| `python.inspectEnvironment` | `backend.py` | **已启用 `suppressSuccessDiagnostics`**（高频只读查询成功不发 `INFO`） | — | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `python.invalidExecutable`、`internal_error` |
| `lithe/build/model` | `build_provider.py` | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`） | 降级：`plugins.operation.fallback_selected`（`code: "pyproject_parse_failed"`，`count: 1`）<br>恢复：`plugins.operation.recovery_finished`（`code: "pyproject_restored"`，`count: 1`） | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `pyproject_parse_failed`、`pyproject_restored`、`python.invalidRoot`、`python.projectUnavailable`、`internal_error` |
| `lithe/build/discoverTests` | `build_provider.py` | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`） | 降级：`plugins.operation.fallback_selected`（`code: "test_discovery_truncated"`，`count` 为超出 10,000 上限被截断的条目数） | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `test_discovery_truncated`、`python.pytestUnavailable`、`python.pytestTimedOut`、`python.pytestCollectionFailed`、`python.interpreterUnavailable`、`python.cacheUnavailable` |
| `lithe/build/test` | `build_provider.py` | `plugins.operation.finished`（`INFO`，含 `duration_ms` 与 `op`；测试断言失败仍属正常协议返回 `exitCode != 0`，进程级超时或解释器缺失才记 `ERROR`） | — | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `python.pytestTimedOut`、`python.interpreterUnavailable`、`python.projectUnavailable`、`internal_error` |
| `lithe/build/runEntrypoints` | `build_provider.py` | **已启用 `suppressSuccessDiagnostics`**（打开文件高频静态入口探测成功不发 `INFO`） | — | `plugins.operation.failed`（含 `duration_ms` 与 `code`） | `python.invalidRoot`、`python.projectUnavailable`、`internal_error` |
| `notification` / `result-encoding` / `shutdown` | `lithe_rpc.py` | — | — | `plugins.operation.failed`（`ERROR`） | `framing_error`、`result_encoding_failed`、`internal_error` |

> 注：`toolchains/query` 的错误码与超时由工具链契约（`plugin.toolchain.*`）结构化返回并由宿主工具链层统一观测；因 Core `plugin_logging` 操作白名单未纳入 `toolchains/query`，后端不为其额外发送 `lithe/log` 以避免产生 `plugins.diagnostics.rejected`。

### 2. 宿主代记的声明式插件操作（通道：`plugins/io.github.lithe-idea.python-support/host`）

声明式启动的语言服务器子进程与调试适配器由宿主与 Core 经 `diagnostics.recordPluginOperation` 将唯一终态代记到 `plugins/io.github.lithe-idea.python-support/host`（用户主动取消或停止不记录）：

| `operation` | 声明来源 | 记录方 | 成功事件与级别 | 失败事件与级别 | 可能的 `host.*` 失败类别标识（`code`） |
| --- | --- | --- | --- | --- | --- |
| `languageServer/start` | `languageServers[]`（`pyrefly.resolveLaunch` 解析后的 `pyrefly lsp` 进程） | 启动前失败由桌面宿主记录；进入启动后经 `lsp.startServer.startupOperation` 交由 Core 记录唯一终态 | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.planFailed`、`host.executableUnavailable`、`host.launchFailed`、`host.exitedEarly`、`host.initializeFailed`、`host.timedOut` |
| `debugAdapter/start` | `debugAdapters[]`（`debugpy`） | 桌面宿主（`op` 为调试会话 ID；用户停止与 Core 拒绝建会话不记录） | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.executableUnavailable`、`host.launchFailed`、`host.exitedEarly`、`host.initializeFailed`、`host.timedOut` |

### 3. 上游子进程通道、隐私红线与原生日志文件

| 组件 / 命令 | v2 结构化通道或原生文件位置 | 级别、限流、脱敏与清理策略 |
| --- | --- | --- |
| `backend.py` / `build_provider.py`（纯 Python 后端与构建 Provider） | 结构化通道：`plugins/io.github.lithe-idea.python-support/backend`<br>未分类 `stderr`：`lsp.stderr.received`（`DEBUG`） | **零自建日志文件**；未预期异常在 `stderr` 仅输出 `<server-name>: <category> (<ExceptionType>)` 受控短词，**绝不拼接文件路径、命令参数、源码片段、输出内容或环境变量值**。Core 对 `stderr` 按每行 4 KiB、200 行/秒限流并经 1 KiB 脱敏截断，仅在详细诊断开启时落盘。 |
| `pyrefly lsp`（语言服务器） | 结构化通道：`lsp/python` | Core 记录 `lsp.process.started`、`lsp.protocol.initialized`、`lsp.session.updated`；`window/logMessage` 与 `window/showMessage` 保留显式 `ERROR`/`WARN`/`INFO`/`DEBUG` 级别；未分类 `stderr` 记为 `DEBUG`（仅详细诊断开启时落盘）；详细诊断开启（15 分钟单次到期）时仅接纳 `$/logTrace.message` 摘要，拒绝 `verbose` 载荷。`pyrefly` 不写任何插件内文件。 |
| `debugpy`（调试适配器与启动器） | 结构化通道：`debug/debugpy`<br>原生日志文件：`sessions/<session>/plugins/io.github.lithe-idea.python-support/files/debugpy.*.log` | 结构化会话事件写入 `debug/debugpy`；上游 `debugpy` 原生日志通过 `--log-dir ${logDir}` 定向写入宿主 `Store.PluginFilesDirectory` 创建的当前会话专属目录（权限 `0700`，逐段校验拒绝软链越界，绝不写插件安装目录或 app bundle），按 `<pid>` 建文件并随宿主日志会话生命周期统一保留与清理。 |
| `pytest`、构建任务与项目生成 | 构建/测试面板流式输出（`lithe/build/progress`）与 JUnit XML（`.pytest_cache/lithe-junit.xml`） | `lithe/build/discoverTests` 将 `pytest` 缓存重定向至 `${workspaceStateDir}`；进程 `stdout`、用户测试代码与环境变量值仅进入协议进度流或报告文件，绝不进入 v2 结构化诊断日志。 |

---

## 本地构建、缓存与测试（Build, Cache & Verification）

### 构建与缓存目录说明（跨工作树复用规则）

| 路径 | 归属与用途 | 生命周期 | 跨 Git Worktree 复用策略 |
| --- | --- | --- | --- |
| `.cache/` | `scripts/package.mjs` 下载并经 SHA-256 校验的上游原始归档（`pyrefly` 6 平台压缩包、`debugpy` wheel、`tomli` wheel） | 本地持久化缓存（已被 `.gitignore` 忽略） | **可安全复制复用**（文件名含上游版本与平台，读取前强制校验 `vendor-lock.json` SHA-256；复制到新工作树 `.cache/`，勿跨并发打包共享写） |
| `.artifacts/stage/` | 打包过程中的单平台解包暂存目录 | 每次 `scripts/package.mjs` 按平台重建（`.gitignore` 忽略） | **不可复用**（构建中间产物，毫秒级重建） |
| `.artifacts/lithe-host/` | `scripts/e2e-host.mjs` 检出的宿主稀疏工作树及其编译产物 | 本地按需保留（`.gitignore` 忽略） | 其内部 `.artifacts/desktop` 在同一操作系统、CPU 架构与相同 `PINNED_CORE_REVISION` 前提下可按宿主规则复制加速，不得跨工作树软链共用；任何运行时会话日志目录（`sessions/<session>/plugins/.../files/`）与状态目录严禁跨工作树复制 |
| `dist/` | 最终产出的 `python-support-<version>-<platform>.zip` 发布包 | 打包输出（`.gitignore` 忽略） | 按需重新运行 `node scripts/package.mjs` 生成 |

### 常用命令

```bash
# 打包当前开发平台（例如 macOS Apple Silicon）
node scripts/package.mjs --platform darwin-arm64

# 打包全部 6 个目标平台（darwin-arm64, darwin-x64, windows-x64, windows-arm64, linux-x64, linux-arm64）
node scripts/package.mjs

# 校验 dist/ 下构建产物的目录安全性、Windows 文件名/大小写兼容性与清单一致性
node --test --test-timeout=60000 scripts/package/*.test.mjs

# 运行契约不变量检查、backend/build_provider/toolchain_provider 协议单测、pyrefly LSP 解释器注入与回退、pytest 动态发现与执行、debugpy 调试及只读包哈希不变断言
node scripts/test.mjs

# 针对真实 Lithe 桌面宿主与 Rust Core 运行端到端集成测试
node scripts/e2e-host.mjs
```

---

## 许可证（License）

- 插件清单、脚本、模板、图标与文档采用 [Apache-2.0](LICENSE) 许可协议。
- 随包分发的第三方开源组件（Pyrefly `1.4.1`、debugpy `1.8.22`、Tomli `2.5.0`，均为 MIT 许可）完整版权声明与许可证全文见 [io.github.lithe-idea.python-support/THIRD-PARTY-NOTICES.txt](io.github.lithe-idea.python-support/THIRD-PARTY-NOTICES.txt) 及包内 `vendor/debugpy/ThirdPartyNotices.txt`。
