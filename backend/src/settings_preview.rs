//! Draws examples of Python diagnostics and completion from the settings window's draft.

use lithe_plugin_sdk::view::{ViewEvent, ViewEventKind, ViewResult, ViewSurface};
use lithe_plugin_sdk::{Context, FunctionError, PluginError};
use serde_json::{json, Value};

pub(crate) const FUNCTION: &str = "settings.preview";

pub(crate) fn draw(event: ViewEvent, context: &Context) -> Result<ViewResult, FunctionError> {
    context.check_cancelled()?;
    if !matches!(&event.surface, ViewSurface::SettingRegion(id) if id == "language") {
        return Err(PluginError::new(
            "python.preview.unknownRegion",
            "The Python settings preview requires the Python language region.",
        )
        .into());
    }
    if !matches!(
        event.kind,
        ViewEventKind::Open | ViewEventKind::Settings | ViewEventKind::Resize
    ) {
        return Ok(ViewResult::Unchanged);
    }
    Ok(ViewResult::View(vec![canvas(&event)]))
}

fn canvas(event: &ViewEvent) -> Value {
    let language = event.language.split('-').next() == Some("zh");
    let words = |en, zh| if language { zh } else { en };
    let value = |key| event.draft.get(key).or_else(|| event.effective.get(key));
    let changed = [
        "displayTypeErrors",
        "autoImportCompletions",
        "completeFunctionParens",
        "importFormat",
    ]
    .into_iter()
    .any(|key| {
        event
            .draft
            .get(key)
            .is_some_and(|draft| Some(draft) != event.effective.get(key))
    });
    let (diagnostic, tone) = match value("displayTypeErrors").and_then(Value::as_str) {
        Some("force-off") => (
            words("Type errors hidden", "隐藏类型错误"),
            "$textSecondary",
        ),
        Some("error-missing-imports") => (
            words("Missing imports only", "仅报告缺失导入"),
            "$textSecondary",
        ),
        Some("default") => (
            words(
                "Depends on Pyrefly project configuration",
                "由项目的 Pyrefly 配置决定",
            ),
            "$textSecondary",
        ),
        _ => (
            words(
                "Type error: expected int, got str",
                "类型错误：应为 int，实际为 str",
            ),
            "$error",
        ),
    };
    let auto_import = value("autoImportCompletions")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let completion = if value("completeFunctionParens").and_then(Value::as_bool) == Some(true) {
        "greet()"
    } else {
        "greet"
    };
    let import = if value("importFormat").and_then(Value::as_str) == Some("relative") {
        "from .utils import greet"
    } else {
        "from app.utils import greet"
    };

    let width = event.width.unwrap_or(640.0).clamp(260.0, 4000.0);
    let gap = 12.0;
    let card_top = if changed { 53.0 } else { 30.0 };
    let (card_width, second_x, second_y) = if width >= 570.0 {
        let card_width = (width - gap) / 2.0;
        (card_width, card_width + gap, card_top)
    } else {
        (width, 0.0, card_top + 90.0 + gap)
    };
    let height = (second_y + 91.0) as u16;
    let title = words("Preview", "效果预览");
    let mut nodes = vec![text(0.0, 17.0, width, title, "strong", "$text")];
    if changed {
        nodes.push(text(
            0.0,
            39.0,
            width,
            words("Includes changes not applied yet", "含未应用的修改"),
            "caption",
            "$textSecondary",
        ));
    }
    nodes.push(card(
        0.0,
        card_top,
        card_width,
        words("Type diagnostics", "类型诊断"),
        [
            ("count: int = \"3\"", "monoSmall", "$text"),
            (diagnostic, "caption", tone),
        ],
    ));
    let first_line = if auto_import {
        (import, "monoSmall", "$text")
    } else {
        (
            words("Auto-import off", "自动导入已关闭"),
            "caption",
            "$textSecondary",
        )
    };
    nodes.push(card(
        second_x,
        second_y,
        card_width,
        words("Code completion", "代码补全"),
        [first_line, (completion, "monoSmall", "$accent")],
    ));
    let mut result = json!({
        "type": "canvas", "id": "pythonPreview", "label": words("Preview of Python settings", "Python 设置效果预览"),
        "height": height, "viewBox": [0, 0, width, height], "nodes": nodes,
    });
    if event.width.is_some() {
        result["on"] = json!(["resize"]);
    }
    result
}

fn card(x: f64, y: f64, width: f64, title: &str, lines: [(&str, &str, &str); 2]) -> Value {
    let inner = width - 26.0;
    let [(first, first_style, first_color), (second, second_style, second_color)] = lines;
    json!({
        "type": "group", "x": x, "y": y, "children": [
            {"type": "rect", "x": 0.5, "y": 0.5, "w": width - 1.0, "h": 89, "radius": 8, "fill": "$surface", "stroke": "$line"},
            text(13.0, 23.0, inner, title, "strong", "$text"),
            text(13.0, 49.0, inner, first, first_style, first_color),
            text(13.0, 72.0, inner, second, second_style, second_color),
        ],
    })
}

fn text(x: f64, y: f64, width: f64, value: &str, style: &str, color: &str) -> Value {
    json!({"type": "text", "x": x, "y": y, "text": value, "style": style, "color": color, "maxWidth": width})
}
