//! The words the previews show, in the languages the plugin translates its
//! settings to. Setting names and values match the titles of the declared
//! rows under the region (`plugin.json` and `l10n/zh-Hans.json`), and the
//! toolchain layers match the host's Toolchains page, so a card names what
//! changes it.
//!
//! Python code and Pyrefly's own output, such as its error codes and
//! messages, stay as the tools write them.

pub struct Words {
    pub preview_title: &'static str,
    pub preview_label: &'static str,
    pub follows_options: &'static str,
    pub includes_draft: &'static str,
    pub on: &'static str,
    pub off: &'static str,

    pub interpreter_title: &'static str,
    pub interpreter_info: &'static str,
    /// The banner under the interpreter row while the override path is set.
    pub override_banner: fn(&str) -> String,

    pub mode_title: &'static str,
    /// The pill of each preset, in the order of `Mode`: automatic, off,
    /// basic, legacy, default, strict, all.
    pub modes: [&'static str; 7],
    pub mode_notes: [&'static str; 7],
    /// The pill and the note of the type checking card for each
    /// `displayTypeErrors` choice that overrides the preset, in the order of
    /// `Display`: configured projects only, missing imports only, off. Always
    /// on shows the preset's own.
    pub displays: [&'static str; 3],
    pub display_notes: [&'static str; 3],
    /// How many errors the sample reports, after the error code shown.
    pub errors: fn(usize) -> String,

    pub scope_title: &'static str,
    pub scope_open: &'static str,
    pub scope_workspace: &'static str,
    pub scope_open_note: &'static str,
    pub scope_workspace_note: &'static str,
    /// The tag of the file open in the editor, and what each file gets.
    pub open_tag: &'static str,
    pub checked: &'static str,
    pub errors_only: &'static str,
    pub not_checked: &'static str,

    pub import_title: &'static str,
    pub import_absolute: &'static str,
    pub import_relative: &'static str,
    pub import_absolute_note: &'static str,
    pub import_relative_note: &'static str,
    pub import_off_note: &'static str,
    /// The legend on the import line the completion writes.
    pub inserted_on_accept: &'static str,
    pub no_suggestions: &'static str,

    pub parens_title: &'static str,
    pub parens_on_note: &'static str,
    pub parens_off_note: &'static str,
    pub after_accepting: &'static str,

    pub resolution_title: &'static str,
    pub resolution_label: &'static str,
    /// The card for the override path above the lookup: its title, the chip
    /// while it is set and while it is empty, and its lines while empty and
    /// the second line while set, under the path.
    pub override_title: &'static str,
    pub override_set: &'static str,
    pub override_unset: &'static str,
    pub override_unset_detail: [&'static str; 2],
    pub override_set_detail: &'static str,
    pub step_project: &'static str,
    pub step_project_detail: [&'static str; 2],
    pub step_global: &'static str,
    pub step_global_detail: [&'static str; 2],
    pub step_automatic: &'static str,
    pub step_automatic_detail: [&'static str; 2],
    pub pyrefly_title: &'static str,
    pub pyrefly_detail: [&'static str; 2],
    pub first: &'static str,
    pub then: &'static str,
    pub last: &'static str,
    pub used_for: &'static str,
    /// What the interpreter the lookup finds is used for: analyze, run,
    /// test, debug, install. The override path takes run, test and install.
    pub uses: [&'static str; 5],
}

fn override_banner_zh(path: &str) -> String {
    format!("已设置「Python 解释器覆盖路径」：构建、运行和 pytest 使用 {path}；Pyrefly 分析和调试仍用上面的解释器。")
}

fn override_banner_en(path: &str) -> String {
    format!("Python executable override is set: build, run and pytest use {path}; Pyrefly analysis and debugging still use the interpreter above.")
}

fn errors_zh(count: usize) -> String {
    format!("共 {count} 个错误")
}

fn errors_en(count: usize) -> String {
    match count {
        1 => "1 error".into(),
        count => format!("{count} errors"),
    }
}

const ZH: Words = Words {
    preview_title: "效果预览",
    preview_label: "Pyrefly 选项的效果预览",
    follows_options: "示例代码，随下方选项即时变化",
    includes_draft: "含未应用的修改",
    on: "开",
    off: "关",

    interpreter_title: "Python 解释器",
    interpreter_info: "Pyrefly 分析代码和调试用这个解释器，Pyrefly 从它的 site-packages 解析第三方库；没有设置「Python 解释器覆盖路径」时，构建、运行、pytest 和安装依赖也用它。点击这一行，在下拉菜单里为项目或全局选择 .venv、uv、conda、pyenv、Poetry、Pipenv、Hatch 等环境，或添加其他目录；菜单底部也能打开「工具链」页。",
    override_banner: override_banner_zh,

    mode_title: "类型检查模式",
    modes: ["自动", "关闭", "基础", "宽松", "默认", "严格", "全部"],
    mode_notes: [
        "沿用附近的 mypy、Pyright 配置，否则同基础",
        "不报告类型错误，补全和跳转照常可用",
        "只报告 Pyrefly 确信的错误",
        "比默认宽松，适合从 mypy 迁移",
        "Pyrefly 的标准规则",
        "另外要求参数注解等",
        "所有检查都按错误报告",
    ],
    displays: ["仅已配置项目", "仅报告缺失导入", "关闭"],
    display_notes: [
        "示例没有 Pyrefly 配置，不显示类型错误",
        "Pyrefly 已无此模式，未配置的文件按基础检查",
        "「显示类型错误」已关闭，所有文件都不显示",
    ],
    errors: errors_zh,

    scope_title: "诊断范围",
    scope_open: "仅打开的文件",
    scope_workspace: "整个工作区",
    scope_open_note: "只检查编辑器里打开的文件",
    scope_workspace_note: "未打开的文件也报告错误级别的问题",
    open_tag: "已打开",
    checked: "已检查",
    errors_only: "只报错误",
    not_checked: "不检查",

    import_title: "自动导入补全",
    import_absolute: "绝对导入",
    import_relative: "相对导入",
    import_absolute_note: "补全未导入的名字，确认时按完整路径导入",
    import_relative_note: "补全未导入的名字，确认时按相对路径导入",
    import_off_note: "只补全已导入或本文件里的名字",
    inserted_on_accept: "确认后插入",
    no_suggestions: "无建议",

    parens_title: "补全函数括号",
    parens_on_note: "补全函数时加上括号，光标停在括号里",
    parens_off_note: "只插入函数名",
    after_accepting: "确认补全 greet 后",

    resolution_title: "Lithe 按这个顺序找 Python 解释器",
    resolution_label: "Lithe 查找 Python 解释器的顺序",
    override_title: "Python 解释器覆盖路径",
    override_set: "已设置",
    override_unset: "未设置",
    override_unset_detail: [
        "留空时，构建、运行和 pytest 也按下面查找",
        "在「语言与框架 › Python」设置",
    ],
    override_set_detail: "构建、运行和 pytest 用它，不按下面查找",
    step_project: "项目环境",
    step_project_detail: [
        "为项目固定的解释器 → .venv、venv、.conda",
        "→ .python-version、requires-python 的版本",
    ],
    step_global: "全局默认",
    step_global_detail: [
        "全局固定的解释器，其次默认版本",
        "在「工具链」页的全局范围选择",
    ],
    step_automatic: "自动发现",
    step_automatic_detail: [
        "VIRTUAL_ENV → PATH 中的 python3、python",
        "→ uv、pyenv、conda、python.org 的安装",
    ],
    pyrefly_title: "Pyrefly 用查找到的解释器",
    pyrefly_detail: [
        "从它的 site-packages 解析第三方库",
        "换解释器后，缺失导入的报错随之更新",
    ],
    first: "先找这里",
    then: "其次",
    last: "最后",
    used_for: "用于",
    uses: ["语言服务", "运行", "测试", "调试", "安装依赖"],
};

const EN: Words = Words {
    preview_title: "Preview",
    preview_label: "Preview of the Pyrefly options",
    follows_options: "Sample code; follows the options below",
    includes_draft: "Includes changes not applied yet",
    on: "On",
    off: "Off",

    interpreter_title: "Python interpreter",
    interpreter_info: "Pyrefly analyzes the code and Lithe debugs with this interpreter; Pyrefly resolves third-party imports from its site-packages. Unless Python executable override is set, Lithe also builds, runs, tests and installs packages with it. Choose the row to pick a .venv, uv, conda, pyenv, Poetry, Pipenv or Hatch environment, or another directory, for the project or for all projects; the menu also opens the Toolchains page.",
    override_banner: override_banner_en,

    mode_title: "Type checking mode",
    modes: ["Automatic", "Off", "Basic", "Legacy", "Default", "Strict", "All"],
    mode_notes: [
        "Uses a mypy or Pyright config, else Basic",
        "No type errors; completion still works",
        "Only errors Pyrefly is sure of",
        "Looser than Default, for mypy migration",
        "Pyrefly's standard rules",
        "Also asks for parameter annotations",
        "Every check, reported as an error",
    ],
    displays: ["Configured only", "Missing imports", "Off"],
    display_notes: [
        "The sample has no Pyrefly config: none shown",
        "No such mode in Pyrefly now: checks as Basic",
        "Display type errors is Off: no file shows them",
    ],
    errors: errors_en,

    scope_title: "Diagnostic scope",
    scope_open: "Open files only",
    scope_workspace: "Entire workspace",
    scope_open_note: "Checks only the files open in the editor",
    scope_workspace_note: "Files not open report their errors too",
    open_tag: "open",
    checked: "Checked",
    errors_only: "Errors only",
    not_checked: "Not checked",

    import_title: "Auto-import completions",
    import_absolute: "Absolute",
    import_relative: "Relative",
    import_absolute_note: "Suggests unimported names, by full path",
    import_relative_note: "Suggests unimported names, relatively",
    import_off_note: "Suggests only names already in scope",
    inserted_on_accept: "inserted on accept",
    no_suggestions: "No suggestions",

    parens_title: "Complete function parentheses",
    parens_on_note: "Adds () after a function, caret inside",
    parens_off_note: "Inserts the function name only",
    after_accepting: "After accepting greet",

    resolution_title: "How Lithe finds the Python interpreter",
    resolution_label: "The order in which Lithe looks for the Python interpreter",
    override_title: "Python executable override",
    override_set: "Set",
    override_unset: "Not set",
    override_unset_detail: [
        "When empty, build, run and pytest use the lookup",
        "Set in Languages & Frameworks › Python",
    ],
    override_set_detail: "Build, run and pytest use it, not the lookup",
    step_project: "Project",
    step_project_detail: [
        "Pinned for the project → .venv, venv, .conda",
        "→ .python-version, requires-python",
    ],
    step_global: "Global default",
    step_global_detail: [
        "Pinned globally, then the default version",
        "Set on the Toolchains page, for all",
    ],
    step_automatic: "Automatic",
    step_automatic_detail: [
        "VIRTUAL_ENV → python3, python on PATH",
        "→ uv, pyenv, conda and python.org installs",
    ],
    pyrefly_title: "Pyrefly uses the interpreter found",
    pyrefly_detail: [
        "It resolves third-party imports from its",
        "site-packages, so switching updates them",
    ],
    first: "Tried first",
    then: "Then",
    last: "Tried last",
    used_for: "Used to",
    uses: ["analyze", "run", "test", "debug", "install"],
};

/// The words for the host's interface language: Chinese for a `zh` tag,
/// English otherwise.
pub fn for_language(tag: &str) -> &'static Words {
    if tag == "zh" || tag.starts_with("zh-") {
        &ZH
    } else {
        &EN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chinese_tag_of_any_script_or_region_gets_chinese() {
        for tag in ["zh", "zh-Hans", "zh-CN", "zh-Hant-TW"] {
            assert_eq!(for_language(tag).on, ZH.on, "{tag}");
        }
        for tag in ["en", "en-GB", "fr", "zhx", ""] {
            assert_eq!(for_language(tag).on, EN.on, "{tag}");
        }
    }

    #[test]
    fn the_override_banner_names_the_path_in_each_language() {
        assert!((EN.override_banner)("/opt/py/bin/python3").contains("use /opt/py/bin/python3;"));
        assert!((ZH.override_banner)("/opt/py/bin/python3").contains("使用 /opt/py/bin/python3；"));
    }

    #[test]
    fn the_error_count_reads_in_each_language() {
        assert_eq!((EN.errors)(1), "1 error");
        assert_eq!((EN.errors)(3), "3 errors");
        assert_eq!((ZH.errors)(2), "共 2 个错误");
    }
}
