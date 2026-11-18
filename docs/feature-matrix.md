# Python Support 功能矩阵（Feature Matrix）

本文档维护 `io.github.lithe-idea.python-support` 插件在各桌面平台上的能力支持状态（插件的功能矩阵仅在插件仓库维护，不进入宿主仓库）。

状态说明：
- `✅ 已实现`：已在清单、脚本与打包归档中实现并通过自动化验证。
- `🚧 规划中`：归属后续里程碑（M3 插件后端进程能力）。

| 能力域 | 功能项 | macOS (`darwin-arm64` / `darwin-x64`) | Windows (`windows-x64` / `windows-arm64`) | Linux (`linux-x64` / `linux-arm64`) | 说明 |
| --- | --- | --- | --- | --- | --- |
| 语言基础 (`languages`) | `.py` / `.pyi` / `.pyw` 识别、括号配对、`#` 行注释、项目标记与依赖目录（`.venv` / `venv`） | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 纯声明式契约 v0 |
| 语言服务器 (`languageServers`) | 内置打包 `pyrefly` 1.4.1（`pyrefly lsp`）：实时类型检查、悬停、跳转定义、查找引用、补全与自动导入、工作区符号、重构重命名 | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 构建期按 6 平台固定 SHA-256 打包至 `bin/pyrefly(.exe)`；支持排除目录同步（`extraProjectExcludes`）与即时分析配置 |
| 工具链与虚拟环境 (`toolDefinitions`) | `python` 解释器解析：项目覆盖 → `.venv` / `venv`（经工作区信任门控）→ `VIRTUAL_ENV` → `PATH` → 自动发现（Homebrew / Framework / 系统 `/usr` / Windows `Programs/Python` / `pyenv` / `pyenv-win` / `uv` / `conda` / `miniforge` / `miniconda` / `anaconda`） | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 遵循 Core 4 层优先级与项目环境软链安全边界；不注入在无 `bin/` 布局下触发 `unsafePath` 的 `pathPrepend` |
| 构建与运行 (`buildSystems: python`) | `scripts/build_model.py` 纯 AST + `tomllib`/`tomli` 静态识别 `[project.scripts]`、包 `__main__.py`、顶层 `__main__` 脚本、Django `manage.py`、FastAPI ASGI、Flask WSGI（零用户代码执行） | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | `-I -B` 隔离运行，Python 3.9–3.10 自动回退内置 `vendor/tomli` |
| 任务与测试 (`buildSystems: python`) | `pip install -r requirements.txt`、`mypy`（含诊断 `lineMatcher`）、`pytest`（支持工作区/项目/目标及 `suite` / `case` 过滤，JUnit XML 报告解析） | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 报告路径 `.pytest_cache/lithe-junit.xml`，排除 `.venv`/`venv` 并隐藏缓存目录 |
| 包与环境工具 (`buildSystems: uv / conda / ruff`) | 独立构建系统：`uv`（`uv sync` / `uv lock`）、`conda`（`conda env update --file environment.yml --prune`）、`ruff`（`ruff check` 含 `lineMatcher` / `ruff format`） | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 按各自标记文件独立激活，使用用户环境中的 `uv` / `conda` / `ruff` |
| 调试器 (`debugAdapters`) | 内置打包 `debugpy` 1.8.22（`stdio` DAP）：单文件与目标 `launch`（自动注入 `PYTHONDONTWRITEBYTECODE=1` 保持只读插件包零字节写入）、远程 `attach`（`host:port` + `pathMappings`） | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 复用选定 `python` 工具链（`>= 3.9`），适配器日志写入宿主分配的 `${logDir}` |
| 终端输出跳转 (`outputLinkMatchers`) | Python Traceback `File "...", line N` 点击跳转源码与行号 | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | Core 正则命名捕获组匹配 |
| 新建项目向导 (`projectGenerators`) | 新建 Python 项目：选择并固定项目级 `python` 工具链，支持 `none` / `venv (.venv)` / `uv (.venv)` 环境初始化与示例代码生成 | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | Unix 调用 `python3` / `uv`，Windows 归档自动切换为 `python` / `uv` |
| 国际化 (`l10n`) | 英文默认文案 + `l10n/zh-Hans.json` 简体中文完整设置与分组翻译 | ✅ 已实现 | ✅ 已实现 | ✅ 已实现 | 通过 `plugin-l10n.schema.json` 与 Core `settingsState` 校验 |
| 高级插件后端能力（M3） | `pytest --collect-only` 原生测试树发现、依赖树视图、`pyproject.toml` 原生配置页编辑器、工具链后端深度枚举 | 🚧 规划中 | 🚧 规划中 | 🚧 规划中 | 规划于后续 M3 后端进程版本 |
