# Python Support for Lithe (`io.github.lithe-idea.python-support`)

Python language support plugin for Lithe (`schemaVersion: 0`, `pluginAPIVersion: 0`), bundling [Pyrefly](https://github.com/facebook/pyrefly) `1.4.1` for fast static type checking and LSP navigation, and [debugpy](https://github.com/microsoft/debugpy) `1.8.22` for source-level debugging.

遵循 Lithe 声明式插件契约 v0，为 Lithe 桌面端（macOS / Windows / Linux）提供开箱即用的 Python 语言支持、`.venv` 虚拟环境与多来源解释器发现、项目模型静态分析、`pytest` 测试集成、`uv` / `conda` / `Ruff` 构建任务、源码级断点调试及新建项目向导。跨平台实现与验证记录详见 [docs/feature-matrix.md](docs/feature-matrix.md)。

---

## 核心能力（Capabilities）

1. **语言与编辑器基础（`languages: python`）**
   - 识别 `.py`、`.pyi`、`.pyw`，配置 `#` 行注释与括号/引号自动配对，声明 `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt` / `Pipfile` / `pyrefly.toml` 项目标记及 `.venv` / `venv` 项目依赖目录。
2. **语言服务器（`languageServers: python` / Pyrefly `1.4.1`）**
   - 构建期固定版本与 SHA-256 打包 `pyrefly 1.4.1`（Unix：`bin/pyrefly`，Windows：`bin/pyrefly.exe`），启动参数 `["lsp"]`，验证参数 `["--version"]`。
   - `workspaceConfiguration` 即时同步类型检查模式（`typeCheckingMode`）、诊断显示策略（`displayTypeErrors`）、诊断范围（`diagnosticMode`）、自动导入与括号补全，并通过 `indexingExclusions` 将工作区排除目录注入 `python.pyrefly.extraProjectExcludes`。
   - 不向 `pyrefly` 发送空字符串 `python.pythonPath: ""`，保留 `pyrefly` 对项目 `.venv`、`VIRTUAL_ENV`、`CONDA_PREFIX` 与 `pyproject.toml` 的原生环境自动解析。
3. **工具链与虚拟环境解析（`toolDefinitions: python`）**
   - 严格按 Core 4 层优先级解析：项目级显式绑定 → 项目内虚拟环境（`.venv` / `venv`，`projectKind: "environment"`，要求 `pyvenv.cfg` 且受宿主工作区信任门控）→ 全局设置 → `VIRTUAL_ENV` 环境变量与 `PATH`（`python3` / `python`）→ 自动发现安装。
   - 自动发现覆盖 macOS（Homebrew `/opt/homebrew/opt/python@*/libexec`、`/usr/local/opt/python@*/libexec`、`Python.framework`）、Linux（`/usr`、`/usr/local`）、Windows（`%LOCALAPPDATA%\Programs\Python\*`）、`pyenv` / `pyenv-win`、`uv`（`~/.local/share/uv/python/*` 与 `%APPDATA%\uv\data\python\*`）、`conda` / `miniforge` / `miniconda` / `anaconda` base 与 `envs/*`。
4. **4 个独立构建系统（`buildSystems`）**
   - `python`：`python -I -B ${pluginDir}/scripts/build_model.py ${root} ${outputFile}` 通过纯 `ast` + `tomllib`（Python 3.9–3.10 自动回退内置 `vendor/tomli`）静态提取 `[project.scripts]`、包 `__main__.py`、顶层 `__main__` 脚本、Django `manage.py`、FastAPI ASGI、Flask WSGI 运行目标（绝不执行用户项目代码）；内置 `pip install -r requirements.txt`、`mypy`（带诊断 `lineMatcher`）与 `pytest`（支持工作区/项目/目标及 `suite` / `case` 过滤，解析 `.pytest_cache/lithe-junit.xml` JUnit XML 报告）。
   - `uv`（`uv.lock`）：`uv sync`、`uv lock`。
   - `conda`（`environment.yml` / `environment.yaml`）：`conda env update --file environment.yml --prune`。
   - `ruff`（`ruff.toml` / `.ruff.toml` / `pyproject.toml`）：`ruff check`（带诊断 `lineMatcher`）与 `ruff format`。
5. **调试器（`debugAdapters: debugpy`）**
   - 复用当前选定的 `python` 工具链（`>= 3.9`），以 `["-E", "-s", "-B"]` 隔离参数启动内置 `vendor/debugpy/adapter/__main__.py --log-dir ${logDir}`（注：Python 3.11+ 的 `-I` 隐含 `-P` 不注入脚本目录到 `sys.path[0]`，会导致上游 `debugpy/adapter/__main__.py` 相对导入失败；`debugpy` 在完成自身导入后即主动移除 `sys.path[0]`，配合 `-E -s -B` 兼顾完全环境隔离与 Python 3.9–3.14 兼容）。
   - `launch` 默认开启 `"console": "internalConsole"`、`"justMyCode": true` 并注入 `"env": {"PYTHONDONTWRITEBYTECODE": "1"}`，防止 `debugpy/launcher` 子进程往只读已安装插件目录写入 `__pycache__`；同时支持远程 TCP `attach`（`host` / `port` / `pathMappings`）。
6. **终端 Traceback 链接与新建项目向导（`outputLinkMatchers` & `projectGenerators`）**
   - 自动识别终端输出中的 `File "...", line N` 并支持一键跳转源码。
   - 新建项目向导支持选择并固定项目级 `python` 解释器（`pinAs: "project"`），可选 `None` / `venv (.venv)` / `uv (.venv)` 环境创建与示例代码生成。

---

## 日志接线说明（Structured Logging v2 Wiring）

本插件 `0.1.0` 为**纯声明式插件**（不声明 `backend` 常驻进程），全部诊断均遵循 Lithe 结构化日志 v2 规范（Core `rust/logging/README.md` 与 `shared/plugins/contract/v1/README.md#structured-plugin-diagnostics`），已安装插件目录在运行期保持 **100% 只读**：

### 1. SDK 后端日志接线适用性说明

- **`litheLogging` 0 / `lithe/log` 协议上报**：**不适用（N/A）**——本版本无插件后端进程，不引入 Node/Java/Rust 插件后端 SDK。
- **降级与恢复事件（`plugins.operation.fallback_selected` / `plugins.operation.recovery_finished`，`WARN`）**：**不适用（N/A）**——仅带 SDK 后端的插件函数存在插件内缓存回退或连接恢复分支。
- **高频成功诊断抑制（`suppressSuccessDiagnostics`）**：**不适用（N/A）**——本版本不导出高频查询或轮询插件函数。

### 2. 宿主代记的声明式插件操作（通道：`plugins/io.github.lithe-idea.python-support/host`）

声明式贡献无插件后端进程，由实际执行该贡献的宿主或 Core 经 `diagnostics.recordPluginOperation` 将每次尝试的唯一终态代记到 v2 会话通道 `plugins/io.github.lithe-idea.python-support/host`（活动文件 `plugins/io.github.lithe-idea.python-support/host.log`，轮转文件 `~1.log`）。用户主动取消、停止或被新请求取代的尝试**不记录**：

| `operation` | 声明来源 | 记录方 | 成功事件与级别 | 失败事件与级别 | 可能的 `host.*` 失败类别标识（`code`） |
| --- | --- | --- | --- | --- | --- |
| `languageServer/start` | `languageServers[]`（`python` / Pyrefly） | 启动前失败由桌面宿主记录；进入启动后经 `lsp.startServer.startupOperation` 交由 Core 记录唯一终态 | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.executableUnavailable`、`host.launchFailed`、`host.exitedEarly`、`host.initializeFailed`、`host.timedOut` |
| `debugAdapter/start` | `debugAdapters[]`（`debugpy`） | 桌面宿主（`op` 为调试会话 ID；用户停止与 Core 拒绝建会话不记录） | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.executableUnavailable`、`host.launchFailed`、`host.exitedEarly`、`host.initializeFailed`、`host.timedOut` |
| `lithe/build/model` | `buildSystems[0].model`（`scripts/build_model.py` 命令式模型） | 桌面宿主（`op` 为加载构建模型的操作） | `plugins.operation.finished`（`INFO`，含 `duration_ms`） | `plugins.operation.failed`（`ERROR`，含 `duration_ms` 与 `code`） | `host.planFailed`、`host.executableUnavailable`、`host.launchFailed`、`host.timedOut`、`host.commandFailed`、`host.outputInvalid` |

> 注：本插件未声明 `buildSystems[].dependencies` 与 `commandInstallers[]`，因此 `lithe/build/dependencies` 与 `commandInstaller/install` 在本版本不会触发。

#### `host.*` 失败类别标识语义对照

| `code` | 触发阶段与含义 |
| --- | --- |
| `host.planFailed` | 声明式命令无法完成启动或参数规划（如缺少必需目录或模板变量非法） |
| `host.executableUnavailable` | 声明的包内可执行文件、入口脚本或 `python` 运行时工具链无法解析或版本不满足 `minimumVersion` |
| `host.launchFailed` | 已解析的进程启动失败（操作系统 `exec` / 创建进程失败） |
| `host.exitedEarly` | `pyrefly lsp` 或 `debugpy` 适配器在完成 `initialize` 握手前提前退出 |
| `host.initializeFailed` | 已启动的语言服务器或调试适配器 `initialize` 握手返回错误 |
| `host.timedOut` | 启动握手或 `build_model.py` 命令超出宿主设定的有界超时 |
| `host.commandFailed` | `build_model.py` 非零退出（脚本保证真实失败必返回非零退出码） |
| `host.outputInvalid` | `build_model.py` 正常退出但 `${outputFile}` 不是合法的 `litheBuildModel` v0 JSON 文档 |

### 3. 上游子进程通道、隐私边界与原生日志文件

| 组件 / 命令 | v2 结构化通道或原生文件位置 | 级别、限流、脱敏与清理策略 |
| --- | --- | --- |
| `pyrefly lsp`（语言服务器） | 结构化通道：`lsp/python` | Core 记录 `lsp.process.started`、`lsp.protocol.initialized`、`lsp.session.updated`；上游 `window/logMessage` 与 `window/showMessage` 经 `lsp.message.logged` / `lsp.message.shown` 保留显式 `ERROR`/`WARN`/`INFO`/`DEBUG` 级别；未分类 `stderr` 经 `lsp.stderr.received` 固定记为 `DEBUG`（Core 限制每行 4 KiB、200 行/秒，再经 1 KiB 脱敏截断，仅在详细诊断开启时落盘）；详细诊断开启（15 分钟单次到期）时仅接纳 `$/logTrace.message` 摘要（`lsp.trace.received`），拒绝可能含源码的 `verbose` 载荷。`pyrefly` 不写任何插件内文件。 |
| `debugpy`（调试适配器与启动器） | 结构化通道：`debug/debugpy`<br>原生日志文件：`sessions/<session>/plugins/io.github.lithe-idea.python-support/files/debugpy.*.log` | 结构化会话事件（`debug.process.started`、`debug.session.initialized`、`debug.session.state_changed`、`debug.session.finished`、`debug.session.failed`、`debug.operation.failed`、`debug.operation.cancelled`）写入 `debug/debugpy`；上游 `debugpy` 原生日志通过 `--log-dir ${logDir}` 定向写入桌面宿主 `Store.PluginFilesDirectory` 创建的当前会话专属目录（权限 `0700`，逐段校验拒绝软链越界，绝不写插件安装目录或 app bundle）。上游 `debugpy` 默认输出适配器/pydevd 诊断日志，按 `<pid>` 独立建文件（`debugpy.adapter-<pid>.log`、`debugpy.launcher-<pid>.log`、`debugpy.pydevd.<pid>.log`），无内置单文件轮转，随宿主日志会话生命周期统一保留与清理。 |
| `scripts/build_model.py`（模型脚本） | 模型输出：宿主临时 `${outputFile}`<br>诊断输出：宿主构建命令 `stderr` 摘要 | 脚本以 `python -I -B` 与 `sys.dont_write_bytecode = True` 运行；`stdout` 不输出自由文本，`stderr` 严格只输出受控简短分类词（`invalid_arguments`、`project_root_unavailable`、`model_generation_failed (<ExceptionType>)`），**绝不拼接工作区路径、用户源码或原始异常消息**。 |
| 工具链探针、构建任务、`pytest` 与项目生成 | 宿主 `app` / `app/core` 请求轨迹及构建/运行/向导面板 | `python --version` 探针受工作区信任门控保护（未信任工作区零探测项目内 `.venv`）；`pip`、`mypy`、`pytest`、`uv`、`conda`、`ruff` 与 `projectgen` 子进程输出流向对应 UI 控制台与 JUnit XML（`.pytest_cache/lithe-junit.xml`），进程 `stdout`、源码与环境变量值绝不进入 v2 结构化日志。 |

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

# 运行契约不变量检查、build_model.py 全量单测、pyrefly LSP 诊断、debugpy DAP 调试冒烟与只读包哈希不变断言
node scripts/test.mjs

# 针对真实 Lithe 桌面宿主与 Rust Core 运行端到端集成测试
node scripts/e2e-host.mjs
```

---

## 许可证（License）

- 插件清单、脚本、模板、图标与文档采用 [Apache-2.0](LICENSE) 许可协议。
- 随包分发的第三方开源组件（Pyrefly `1.4.1`、debugpy `1.8.22`、Tomli `2.5.0`，均为 MIT 许可）完整版权声明与许可证全文见 [io.github.lithe-idea.python-support/THIRD-PARTY-NOTICES.txt](io.github.lithe-idea.python-support/THIRD-PARTY-NOTICES.txt) 及包内 `vendor/debugpy/ThirdPartyNotices.txt`。
