# Python Support for Lithe (`io.github.lithe-idea.python-support`)

Python language support plugin for Lithe (`schemaVersion: 0`, `pluginAPIVersion: 0`), bundling [Pyrefly](https://github.com/facebook/pyrefly) `1.4.1` for fast static type checking and LSP navigation, and [debugpy](https://github.com/microsoft/debugpy) `1.8.22` for source-level debugging.

遵循 Lithe 声明式插件契约 v0，为 Lithe 桌面端（macOS / Windows / Linux）提供开箱即用的 Python 语言支持、`.venv` 虚拟环境与多来源解释器发现、项目模型静态分析、`pytest` 测试集成、`uv` / `conda` / `Ruff` 构建任务、源码级断点调试及新建项目向导。跨平台能力覆盖详见 [docs/feature-matrix.md](docs/feature-matrix.md)。

---

## 核心能力（Capabilities）

1. **语言与编辑器基础（`languages: python`）**
   - 识别 `.py`、`.pyi`、`.pyw`，配置 `#` 行注释与括号/引号自动配对，声明 `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt` / `Pipfile` / `pyrefly.toml` 项目标记及 `.venv` / `venv` 项目依赖目录。
2. **语言服务器（`languageServers: pyrefly`）**
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

## 日志接线说明（Logging Wiring）

本插件为纯声明式插件（无常驻插件后端进程），所有进程启动、诊断采集与落盘均接入宿主统一日志与可写存储边界，已安装插件目录在运行期保持 **100% 只读**：

| 子系统 / 能力 | 运行形态 | 日志分类 / 事件或文件 | 落盘位置、脱敏与清理策略 | 失败诊断信号 |
| --- | --- | --- | --- | --- |
| 清单、设置与国际化校验 | Core 纯函数校验 | `plugin.host` / `settings.io`（宿主统一日志 `app.jsonl`） | 宿主日志目录（macOS `~/Library/Logs/Lithe/`，Windows `%LOCALAPPDATA%\Lithe\Logs\`），遵循宿主路径脱敏与轮转清理 | `plugin.manifest.*`、`plugin.settings.invalidLocalization` |
| 语言服务器（`pyrefly lsp`） | 宿主托管子进程（`stdio`） | `lsp.wire` / `lsp.lifecycle`（宿主记录生命周期与 stderr 摘要） | 宿主日志目录；`pyrefly` 不往插件包写任何缓存或锁文件 | 进程非零退出、初始化超时或 `validationArguments`（`--version`）失败 |
| 工具链探测与 `.venv` 信任解析 | 宿主探针命令（`python --version`） | `toolchain` / `plugin.host` | 宿主日志目录；仅执行声明的只读 `--version` 探针，工作区未信任时拦截项目内 `.venv` 探针并记录 `projectCodeRequiresAction` | 版本正则不匹配、低于 `minimumVersion` 或 `unsafePath` 拒绝 |
| 项目模型脚本（`scripts/build_model.py`） | 宿主构建模型命令（`python -I -B`） | `build`（宿主声明式命令日志） | 模型 JSON 写入宿主分配的临时 `${outputFile}`；错误信息仅输出至 `stderr` 由宿主采集，`-B` + `sys.dont_write_bytecode = True` 严禁生成 `.pyc` | 脚本返回非零退出码并输出 `stderr` 原因，宿主记录构建命令失败事件并展示给用户 |
| 构建任务与 `pytest`（`python` / `uv` / `conda` / `ruff`） | 宿主构建/测试执行器 | `build` / `run` + 控制台流式输出 | 构建与测试输出实时流向构建/运行面板，JUnit 报告写入用户项目 `.pytest_cache/lithe-junit.xml`（已在 `layout` 中标记隐藏） | 非零退出码、`lineMatcher` 解析的诊断条目或 JUnit 失败用例 |
| 调试适配器（`debugpy`） | 宿主托管 DAP 子进程（`stdio`） | `debug`（宿主 DAP 生命周期日志）+ `debugpy.*.log`（适配器原生日志） | 通过 `--log-dir ${logDir}` 定向写入宿主分配的可写插件日志槽位目录；`launch` 注入 `PYTHONDONTWRITEBYTECODE=1` 杜绝插件目录写入 | DAP 启动/握手失败事件及 `${logDir}/debugpy.adapter-*.log` 详细栈 |
| 新建项目向导（`python-project`） | 宿主 `projectgen` 执行器 | `projectgen` / `plugin.host` | 仅在目标新项目目录写入模板文件与 `.venv`，不写入插件包 | 模板展开错误或 `venv` / `uv venv` 子进程非零退出及 `stderr` |

---

## 本地构建、缓存与测试（Build, Cache & Verification）

### 构建与缓存目录说明（跨工作树复用规则）

| 路径 | 归属与用途 | 生命周期 | 跨 Git Worktree 复用策略 |
| --- | --- | --- | --- |
| `.cache/` | `scripts/package.mjs` 下载并经 SHA-256 校验的上游原始归档（`pyrefly` 6 平台压缩包、`debugpy` wheel、`tomli` wheel） | 本地持久化缓存（已被 `.gitignore` 忽略） | **可安全复制复用**（文件名含上游版本与平台，读取前强制校验 `vendor-lock.json` SHA-256；建议复制到新工作树 `.cache/`，勿跨并发打包共享写） |
| `.artifacts/stage/` | 打包过程中的单平台解包暂存目录 | 每次 `scripts/package.mjs` 按平台重建（`.gitignore` 忽略） | **不可复用**（构建中间产物，毫秒级重建） |
| `.artifacts/lithe-host/` | `scripts/e2e-host.mjs` 检出的宿主稀疏工作树及其编译产物 | 本地按需保留（`.gitignore` 忽略） | 其内部 `.artifacts/desktop` 在同一操作系统、CPU 架构与相同 `PINNED_CORE_REVISION` 前提下可按宿主规则复制加速，不得跨工作树软链共用 |
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
