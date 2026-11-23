//! The Python language page's region: the interpreter row the host draws,
//! then a preview of what each Pyrefly option does to a piece of code, in
//! four cards that follow the rows below them.
//!
//! The scene is as wide as the view the host reports, so a unit is a point:
//! the cards stand two to a row when two of the narrowest fit, else one above
//! the other, and widen with the window. A host that reports no width gets
//! the scene for the region in the smallest settings window, 613 points as
//! measured in the host. The code in the editor-like boxes is laid out on the
//! scene's own monospace grid, so the marks on it line up in every host font.
//!
//! What the type checking card reports is what Pyrefly 1.4.1, the version
//! `vendor-lock.json` packages, reports for the sample with each preset and
//! no Pyrefly config, its error codes and messages verbatim.

use super::scene::{
    code, column, group, pair, path, pill, rect, runs, squiggle, text, text_width, token, Node,
    CAPTION, STRONG,
};
use super::settings::{Display, ImportFormat, Mode, Scope, Settings};
use super::words::Words;
use serde_json::{json, Value};

pub const CANVAS_ID: &str = "pyrefly-preview";
pub const INTERPRETER_ID: &str = "interpreter";

/// The tools the interpreter section lists, as `requiresTools` names them:
/// the host draws each as the Toolchains page does, with its version and
/// path, and opens that page on a click.
pub const TOOLS: [&str; 1] = ["python"];

/// The settings the cards show; a draft of any of them marks the preview.
pub const SETTINGS: [&str; 6] = [
    "typeCheckingMode",
    "displayTypeErrors",
    "diagnosticMode",
    "autoImportCompletions",
    "importFormat",
    "completeFunctionParens",
];

/// The scene's width for a host that reports none.
pub const DEFAULT_WIDTH: f64 = 610.0;
/// The narrowest card: the longest message line ends 228 units into the
/// bar, and every pill keeps room beside its title. A view narrower than one
/// such card is scaled down by the host.
pub const MIN_CARD_W: f64 = 292.0;
const HEADER: f64 = 28.0;
const GAP: f64 = 10.0;
/// A card's title row, the line under it that says what the value does, and
/// the editor-like box below them.
const TITLE_Y: f64 = 22.0;
const NOTE_Y: f64 = 41.0;
const BOX_X: f64 = 10.0;
const BOX_Y: f64 = 50.0;
/// The box heights of the type checking and scope cards and of the two
/// completion ones: a type error's message needs the most.
const BOX_H: [f64; 2] = [138.0, 84.0];
const CARD_H: [f64; 2] = [BOX_Y + BOX_H[0] + BOX_X, BOX_Y + BOX_H[1] + BOX_X];

/// Where the four cards go in a scene of a given width.
pub struct Layout {
    pub width: f64,
    /// Two when two of the narrowest cards fit side by side, else one.
    pub columns: usize,
    card_w: f64,
}

impl Layout {
    pub fn new(width: Option<f64>) -> Self {
        let width = width.unwrap_or(DEFAULT_WIDTH).max(MIN_CARD_W);
        let columns = if width >= 2.0 * MIN_CARD_W + GAP {
            2
        } else {
            1
        };
        let card_w = (width - (columns - 1) as f64 * GAP) / columns as f64;
        Self {
            width,
            columns,
            card_w,
        }
    }

    fn box_w(&self) -> f64 {
        self.card_w - 2.0 * BOX_X
    }

    /// The top-left corner of each card, row after row, and the scene's
    /// height under the last row. The cards of a row are one height: the
    /// type checking and scope ones, or the two completion ones.
    fn places(&self) -> ([(f64, f64); 4], f64) {
        let mut places = [(0.0, 0.0); 4];
        let mut y = HEADER;
        for (index, place) in places.iter_mut().enumerate() {
            let column = index % self.columns;
            if index > 0 && column == 0 {
                y += CARD_H[(index - 1) / 2] + GAP;
            }
            *place = (column as f64 * (self.card_w + GAP), y);
        }
        (places, y + CARD_H[1])
    }
}

/// Code colors after the IDE themes Lithe's editor follows.
fn keyword() -> Value {
    pair("#0033B3", "#CF8E6D")
}
fn function() -> Value {
    pair("#00627A", "#56A8F5")
}
fn builtin() -> Value {
    pair("#000080", "#8888C6")
}
fn string() -> Value {
    pair("#067D17", "#6AAB73")
}
fn number() -> Value {
    pair("#1750EB", "#2AACB8")
}
fn plain() -> Value {
    token("$text")
}
fn editor() -> Value {
    pair("#FFFFFF", "#1E1F22")
}

/// One card: the row it follows and what that row's value does.
struct Card<'a> {
    title: &'a str,
    /// The value shown in the pill.
    value: &'a str,
    /// False for a switched-off option, whose pill is neutral.
    lit: bool,
    note: &'a str,
    /// Whether what the card shows follows a draft not applied yet.
    changed: bool,
    preview: Vec<Node>,
}

/// The region's nodes: the interpreter row, then the preview. While the
/// override path is set, a banner under the row says which commands use it
/// instead.
pub fn view(settings: &Settings, words: &Words, width: Option<f64>) -> Vec<Value> {
    let mut tools: Vec<Value> = TOOLS
        .iter()
        .map(|tool| json!({ "type": "tool", "tool": tool, "choose": true }))
        .collect();
    if let Some(path) = &settings.interpreter_override {
        tools.push(json!({
            "type": "banner",
            "text": (words.override_banner)(path),
            "tone": "accent",
        }));
    }
    vec![
        json!({
            "type": "section",
            "id": INTERPRETER_ID,
            "title": words.interpreter_title,
            "info": words.interpreter_info,
            "children": tools,
        }),
        canvas(settings, words, width),
    ]
}

/// The preset's place in `Words::modes` and `Words::mode_notes`.
fn mode_index(mode: Mode) -> usize {
    match mode {
        Mode::Auto => 0,
        Mode::Off => 1,
        Mode::Basic => 2,
        Mode::Legacy => 3,
        Mode::Default => 4,
        Mode::Strict => 5,
        Mode::All => 6,
    }
}

/// The pill value, whether it is lit, and the note of each card, in the
/// order the cards stand.
fn values<'a>(settings: &Settings, words: &'a Words) -> [(&'a str, bool, &'a str); 4] {
    let switch = |on: bool| if on { words.on } else { words.off };
    let display =
        |index: usize, lit: bool| (words.displays[index], lit, words.display_notes[index]);
    let mode = match settings.display {
        Display::AlwaysOn => {
            let index = mode_index(settings.mode);
            (
                words.modes[index],
                settings.mode != Mode::Off,
                words.mode_notes[index],
            )
        }
        Display::ConfiguredOnly => display(0, false),
        Display::MissingImports => display(1, true),
        Display::Off => display(2, false),
    };
    let scope = match settings.scope {
        Scope::OpenFiles => (words.scope_open, false, words.scope_open_note),
        Scope::Workspace => (words.scope_workspace, true, words.scope_workspace_note),
    };
    let import = match (settings.auto_import, settings.import_format) {
        (false, _) => (words.off, false, words.import_off_note),
        (true, ImportFormat::Absolute) => (words.import_absolute, true, words.import_absolute_note),
        (true, ImportFormat::Relative) => (words.import_relative, true, words.import_relative_note),
    };
    let parens = (
        switch(settings.function_parens),
        settings.function_parens,
        if settings.function_parens {
            words.parens_on_note
        } else {
            words.parens_off_note
        },
    );
    [mode, scope, import, parens]
}

/// The preview for a view `width` points wide, or for the smallest settings
/// window when the host reports no width. A host that reports it sends
/// `resize` with the new width, and the scene is drawn again for it.
pub fn canvas(settings: &Settings, words: &Words, width: Option<f64>) -> Value {
    let layout = Layout::new(width);
    let box_w = layout.box_w();
    let changed = settings.any_changed(&SETTINGS);
    let mut nodes = vec![
        text(0.0, 17.0, words.preview_title, "strong"),
        text(
            layout.width,
            17.0,
            if changed {
                words.includes_draft
            } else {
                words.follows_options
            },
            "caption",
        )
        .align("end")
        .color(token(if changed { "$accent" } else { "$textMuted" }))
        .max_width(layout.width - text_width(words.preview_title, STRONG) - 16.0),
    ];
    let [mode, scope, import, parens] = values(settings, words);
    let cards = [
        Card {
            title: words.mode_title,
            value: mode.0,
            lit: mode.1,
            note: mode.2,
            // The preset decides this card only while type errors are always on.
            changed: settings.is_changed("displayTypeErrors")
                || (settings.display == Display::AlwaysOn
                    && settings.is_changed("typeCheckingMode")),
            preview: type_check_preview(settings.reporting(), words, box_w),
        },
        Card {
            title: words.scope_title,
            value: scope.0,
            lit: scope.1,
            note: scope.2,
            changed: settings.is_changed("diagnosticMode"),
            preview: scope_preview(settings.scope, words, box_w),
        },
        Card {
            title: words.import_title,
            value: import.0,
            lit: import.1,
            note: import.2,
            // The path style decides this card only while auto-import is on.
            changed: settings.is_changed("autoImportCompletions")
                || (settings.auto_import && settings.is_changed("importFormat")),
            preview: import_preview(
                settings.auto_import.then_some(settings.import_format),
                words,
            ),
        },
        Card {
            title: words.parens_title,
            value: parens.0,
            lit: parens.1,
            note: parens.2,
            changed: settings.is_changed("completeFunctionParens"),
            preview: parens_preview(settings.function_parens, words),
        },
    ];
    let (places, height) = layout.places();
    for (index, (card, (x, y))) in cards.into_iter().zip(places).enumerate() {
        nodes.push(group(x, y, draw(card, index / 2, layout.card_w)));
    }
    let mut canvas = json!({
        "type": "canvas",
        "id": CANVAS_ID,
        "label": words.preview_label,
        "height": height.ceil() as u64,
        "viewBox": [0, 0, layout.width, height],
        "nodes": nodes.into_iter().map(Value::from).collect::<Vec<_>>(),
    });
    if width.is_some() {
        canvas["on"] = json!(["resize"]);
    }
    canvas
}

/// A card `card_w` wide whose box is `BOX_H[kind]` tall: its title, a pill
/// with the value shown and, when that value is a draft, an accent outline
/// and a dot in front of the pill; the line saying what the value does; then
/// the preview in an editor-like box. A lit pill writes in `$text`: accent ink
/// on the selection fill falls to about 2:1 in Lithe's dark theme.
fn draw(card: Card, kind: usize, card_w: f64) -> Vec<Node> {
    let (fill, ink) = if card.lit {
        (token("$selection"), token("$text"))
    } else {
        (token("$badge"), token("$textSecondary"))
    };
    let (_, width) = pill(0.0, 0.0, card.value, fill.clone(), ink.clone());
    let pill_x = card_w - 12.0 - width;
    let (pill, _) = pill(pill_x, 8.0, card.value, fill, ink);
    let frame = rect(0.0, 0.0, card_w, CARD_H[kind])
        .radius(8.0)
        .fill(token("$surface"));
    let mut nodes = vec![
        if card.changed {
            frame.stroke(token("$accent"), 1.2)
        } else {
            frame.stroke(token("$line"), 1.0)
        },
        text(12.0, TITLE_Y, card.title, "strong").max_width(pill_x - 12.0 - 18.0),
        pill,
        text(12.0, NOTE_Y, card.note, "caption")
            .color(token("$textSecondary"))
            .max_width(card_w - 24.0),
        rect(BOX_X, BOX_Y, card_w - 2.0 * BOX_X, BOX_H[kind])
            .radius(6.0)
            .fill(editor())
            .stroke(token("$line"), 1.0),
        group(BOX_X, BOX_Y, card.preview),
    ];
    if card.changed {
        nodes.push(
            rect(pill_x - 11.0, 15.0, 6.0, 6.0)
                .radius(3.0)
                .fill(token("$accent")),
        );
    }
    nodes
}

/// The first code line's baseline in the boxes, and the left edge of the
/// code after the line numbers.
const CODE_TOP: f64 = 22.0;
const CODE_X: f64 = 32.0;
const LINE: f64 = 16.0;

/// Code lines with line numbers in a gutter, `LINE` units apart.
fn numbered(lines: Vec<Vec<(&str, Value)>>) -> Vec<Node> {
    let mut nodes = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let y = CODE_TOP + index as f64 * LINE;
        nodes.push(
            text(CODE_X - 10.0, y, &(index + 1).to_string(), "monoSmall")
                .align("end")
                .color(token("$textMuted")),
        );
        nodes.extend(code(CODE_X, y, line));
    }
    nodes
}

/// A wavy underline under columns `start` to `end` of line `line`.
fn underline(line: usize, start: usize, end: usize, color: &str) -> Node {
    path(squiggle(
        column(CODE_X, start),
        column(CODE_X, end),
        CODE_TOP + line as f64 * LINE + 3.0,
    ))
    .stroke(token(color), 1.0)
}

/// An error Pyrefly reports for the sample: where, under which code, and its
/// message in the lines the bar shows.
struct TypeError {
    line: usize,
    start: usize,
    end: usize,
    code: &'static str,
    message: &'static [&'static str],
}

/// What Pyrefly 1.4.1 reports for the sample, in the order the presets add
/// them: `basic` reports the first; `legacy` and `default` add the second;
/// `strict` the third; `all` the last two. The message after `…` is cut.
const ERRORS: [TypeError; 5] = [
    TypeError {
        line: 3,
        start: 6,
        end: 10,
        code: "unknown-name",
        message: &["Could not find name `totl`"],
    },
    TypeError {
        line: 2,
        start: 9,
        end: 12,
        code: "bad-argument-type",
        message: &[
            "Argument `Literal['3']` is not assignable",
            "to parameter `k` with type `float` …",
        ],
    },
    TypeError {
        line: 0,
        start: 10,
        end: 11,
        code: "implicit-any-parameter",
        message: &["`scale` is missing an annotation for", "parameter `x`"],
    },
    TypeError {
        line: 1,
        start: 11,
        end: 16,
        code: "no-any-return-implicit",
        message: &[
            "Returning implicit Any from function",
            "declared to return \"float\"",
        ],
    },
    TypeError {
        line: 2,
        start: 0,
        end: 13,
        code: "unused-call-result",
        message: &[
            "Result of call expression is of type",
            "`float` and is not used …",
        ],
    },
];

/// How many of `ERRORS` a preset reports, and which of them the bar shows:
/// the first one the preset adds to the one below it.
fn reported(mode: Mode) -> (usize, Option<usize>) {
    match mode.applied() {
        Mode::Off | Mode::Auto => (0, None),
        Mode::Basic => (1, Some(0)),
        Mode::Legacy | Mode::Default => (2, Some(1)),
        Mode::Strict => (3, Some(2)),
        Mode::All => (5, Some(3)),
    }
}

/// A function missing an annotation, a call with a string for a float, and a
/// misspelled name, in a box `box_w` wide; under it what the preset in force
/// reports. Nothing is reported while the preset is off or type errors are.
fn type_check_preview(reporting: Option<Mode>, words: &Words, box_w: f64) -> Vec<Node> {
    let mut nodes = numbered(vec![
        vec![
            ("def ", keyword()),
            ("scale", function()),
            ("(x, k: ", plain()),
            ("float", builtin()),
            (") -> ", plain()),
            ("float", builtin()),
            (":", plain()),
        ],
        vec![("    return ", keyword()), ("x * k", plain())],
        vec![
            ("scale(", plain()),
            ("2", number()),
            (", ", plain()),
            ("\"3\"", string()),
            (")", plain()),
        ],
        vec![("print", builtin()), ("(totl)", plain())],
    ]);
    let (count, shown) = reporting.map_or((0, None), reported);
    for error in &ERRORS[..count] {
        nodes.push(underline(error.line, error.start, error.end, "$error"));
    }
    let Some(shown) = shown else {
        return nodes;
    };
    let error = &ERRORS[shown];
    let tally = format!(" · {}", (words.errors)(count));
    let mut lines = vec![vec![
        (error.code, token("$text")),
        (tally.as_str(), token("$textSecondary")),
    ]];
    for line in error.message {
        lines.push(vec![(*line, token("$textSecondary"))]);
    }
    nodes.push(message_bar(
        CODE_TOP + 3.0 * LINE + 12.0,
        box_w,
        Severity::Error,
        &lines,
    ));
    nodes
}

/// A small project in a box `box_w` wide, one file open in the editor, and
/// what Pyrefly checks in each file: in the workspace scope it publishes the
/// errors of the files not open too, but only error-level diagnostics.
fn scope_preview(scope: Scope, words: &Words, box_w: f64) -> Vec<Node> {
    // Each row: its depth, its name, whether it is a folder, and whether the
    // file is open.
    const ROWS: [(usize, &str, bool, bool); 6] = [
        (0, "app", true, false),
        (1, "main.py", false, true),
        (1, "utils.py", false, false),
        (1, "models.py", false, false),
        (0, "tests", true, false),
        (1, "test_models.py", false, false),
    ];
    let mut nodes = Vec::new();
    for (index, (depth, name, folder, open)) in ROWS.into_iter().enumerate() {
        let y = CODE_TOP + index as f64 * 18.0;
        let x = 12.0 + depth as f64 * 16.0;
        if folder {
            nodes.push(text(x, y, "▾", "caption").color(token("$textMuted")));
            nodes.push(text(x + 12.0, y, name, "caption").color(token("$text")));
            continue;
        }
        nodes.push(
            rect(x, y - 9.0, 8.0, 10.0)
                .radius(2.0)
                .stroke(token("$textMuted"), 1.0),
        );
        nodes.push(text(x + 14.0, y, name, "caption").color(token("$text")));
        let (status, color) = match (open, scope) {
            (true, _) => (words.checked, "$success"),
            (false, Scope::Workspace) => (words.errors_only, "$textSecondary"),
            (false, Scope::OpenFiles) => (words.not_checked, "$textMuted"),
        };
        if open {
            let tag_x = x + 14.0 + text_width(name, CAPTION) + 6.0;
            let tag_w = text_width(words.open_tag, CAPTION) + 10.0;
            nodes.push(
                rect(tag_x, y - 10.0, tag_w, 14.0)
                    .radius(7.0)
                    .fill(token("$selection")),
            );
            nodes.push(
                text(tag_x + tag_w / 2.0, y, words.open_tag, "caption")
                    .align("center")
                    .color(token("$text")),
            );
        }
        nodes.push(
            text(box_w - 10.0, y, status, "caption")
                .align("end")
                .color(token(color)),
        );
    }
    nodes
}

/// The caret at column `at` of line `line`.
fn caret(line: usize, at: usize) -> Node {
    rect(
        column(CODE_X, at) - 0.5,
        CODE_TOP + line as f64 * LINE - 11.0,
        1.4,
        14.0,
    )
    .fill(token("$text"))
}

/// The import line a completion of `greet` writes, in `format`.
fn import_line(format: ImportFormat) -> Vec<(&'static str, Value)> {
    vec![
        ("from ", keyword()),
        (
            match format {
                ImportFormat::Absolute => "app.utils",
                ImportFormat::Relative => ".utils",
            },
            plain(),
        ),
        (" import ", keyword()),
        ("greet", plain()),
    ]
}

/// A completion list under the code at column `at`, below line `line`: its
/// one row, or the words saying it has none.
fn completion_list(line: usize, at: usize, row: Option<(&str, &str)>, empty: &str) -> Vec<Node> {
    const W: f64 = 150.0;
    let x = column(CODE_X, at) - 4.0;
    let y = CODE_TOP + line as f64 * LINE + 6.0;
    let mut nodes = vec![rect(x, y, W, 22.0)
        .radius(4.0)
        .fill(token("$surface"))
        .stroke(token("$line"), 1.0)];
    match row {
        Some((name, module)) => {
            nodes.push(
                rect(x + 2.0, y + 2.0, W - 4.0, 18.0)
                    .radius(3.0)
                    .fill(token("$selection")),
            );
            nodes.push(text(x + 8.0, y + 15.0, "ƒ", "caption").color(function()));
            nodes.extend(code(x + 20.0, y + 15.0, &[(name, plain())]));
            nodes.push(
                text(x + W - 8.0, y + 15.0, module, "caption")
                    .align("end")
                    .color(token("$textMuted")),
            );
        }
        None => nodes.push(text(x + 8.0, y + 15.0, empty, "caption").color(token("$textMuted"))),
    }
    nodes
}

/// A name from a module not imported yet, typed halfway. With auto-import
/// on, the completion list offers it and accepting writes the import above,
/// in the chosen path style; off, nothing in scope matches.
fn import_preview(format: Option<ImportFormat>, words: &Words) -> Vec<Node> {
    let typed = vec![("message = gre", plain())];
    let Some(format) = format else {
        let mut nodes = numbered(vec![typed]);
        nodes.push(caret(0, 13));
        nodes.extend(completion_list(0, 10, None, words.no_suggestions));
        return nodes;
    };
    let import = import_line(format);
    let length: usize = import.iter().map(|(piece, _)| piece.chars().count()).sum();
    // The import line the completion writes, tinted, and its legend under
    // the list, clear of the code.
    let mut nodes = vec![rect(
        CODE_X - 3.0,
        CODE_TOP - 11.0,
        column(0.0, length) + 6.0,
        15.0,
    )
    .radius(3.0)
    .fill(token("$accent"))
    .opacity(0.14)];
    nodes.extend(numbered(vec![import, typed]));
    nodes.push(caret(1, 13));
    nodes.extend(completion_list(1, 10, Some(("greet", "app.utils")), ""));
    nodes.push(
        rect(12.0, 70.0, 8.0, 8.0)
            .radius(2.0)
            .fill(token("$accent"))
            .opacity(0.3),
    );
    nodes.push(text(25.0, 78.0, words.inserted_on_accept, "caption").color(token("$textMuted")));
    nodes
}

/// What accepting the completion of a function writes: its name and, with
/// parentheses on, `()` with the caret between them.
fn parens_preview(parens: bool, words: &Words) -> Vec<Node> {
    let mut call = vec![("message = ", plain()), ("greet", plain())];
    if parens {
        call.push(("()", plain()));
    }
    let mut nodes = Vec::new();
    if parens {
        nodes.push(
            rect(
                column(CODE_X, 15) - 1.0,
                CODE_TOP + LINE - 11.0,
                column(0.0, 2) + 2.0,
                15.0,
            )
            .radius(3.0)
            .fill(token("$accent"))
            .opacity(0.14),
        );
    }
    nodes.extend(numbered(vec![import_line(ImportFormat::Absolute), call]));
    nodes.push(caret(1, if parens { 16 } else { 15 }));
    nodes.push(
        text(
            CODE_X,
            CODE_TOP + 2.0 * LINE + 10.0,
            words.after_accepting,
            "caption",
        )
        .color(token("$textMuted")),
    );
    nodes
}

#[derive(Clone, Copy)]
enum Severity {
    Error,
}

/// A diagnostic under the code at `y`, in a box `box_w` wide: its icon and
/// its message, a line of runs to each entry of `lines`.
fn message_bar(y: f64, box_w: f64, severity: Severity, lines: &[Vec<(&str, Value)>]) -> Node {
    let bar_w = box_w - 12.0;
    let bar_h = 8.0 + 14.0 * lines.len() as f64;
    let mut children = match severity {
        Severity::Error => vec![
            rect(0.0, 0.0, bar_w, bar_h)
                .radius(5.0)
                .fill(pair("#FDEEEE", "#402929")),
            rect(7.0, 4.5, 12.0, 12.0).radius(6.0).fill(token("$error")),
            path("M13 7.4 V11 M13 13.2 V13.3".into())
                .stroke("#FFFFFF", 1.4)
                .set("cap", "round"),
        ],
    };
    for (index, line) in lines.iter().enumerate() {
        children
            .push(runs(25.0, 15.0 + 14.0 * index as f64, line, "caption").max_width(bar_w - 31.0));
    }
    group(6.0, y, children)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::words;

    #[test]
    fn every_title_keeps_its_room_beside_its_pill_in_the_narrowest_card() {
        for language in ["en", "zh-Hans"] {
            let w = words::for_language(language);
            let mut pairs: Vec<(&str, &str)> = w
                .modes
                .iter()
                .chain(&w.displays)
                .map(|value| (w.mode_title, *value))
                .collect();
            pairs.extend([w.scope_open, w.scope_workspace].map(|value| (w.scope_title, value)));
            pairs.extend(
                [w.off, w.import_absolute, w.import_relative].map(|value| (w.import_title, value)),
            );
            pairs.extend([w.on, w.off].map(|value| (w.parens_title, value)));
            for (title, value) in pairs {
                // As `draw` places them: the pill 12 units from the card's
                // right edge, the title from 12 units and 18 short of the pill.
                let pill_x = MIN_CARD_W - 12.0 - (text_width(value, CAPTION) + 16.0);
                let room = pill_x - 12.0 - 18.0;
                let title_w = text_width(title, STRONG);
                assert!(
                    title_w <= room,
                    "{language}: {title} ({title_w}) beside {value} ({room})"
                );
            }
        }
    }

    #[test]
    fn every_note_fits_the_narrowest_card() {
        for language in ["en", "zh-Hans"] {
            let w = words::for_language(language);
            let notes = w.mode_notes.iter().chain(&w.display_notes).copied().chain([
                w.scope_open_note,
                w.scope_workspace_note,
                w.import_absolute_note,
                w.import_relative_note,
                w.import_off_note,
                w.parens_on_note,
                w.parens_off_note,
            ]);
            for note in notes {
                let width = text_width(note, CAPTION);
                assert!(width <= MIN_CARD_W - 24.0, "{language}: {note} ({width})");
            }
        }
    }

    #[test]
    fn every_message_line_fits_the_bar_of_the_narrowest_box() {
        let room = MIN_CARD_W - 2.0 * BOX_X - 12.0 - 31.0;
        for language in ["en", "zh-Hans"] {
            let w = words::for_language(language);
            for error in &ERRORS {
                let head = format!("{} · {}", error.code, (w.errors)(5));
                for line in error.message.iter().copied().chain([head.as_str()]) {
                    let width = text_width(line, CAPTION);
                    assert!(width <= room, "{language}: {line} ({width} of {room})");
                }
            }
        }
    }

    #[test]
    fn the_message_bar_stays_inside_the_type_checking_box() {
        let longest = ERRORS
            .iter()
            .map(|error| error.message.len() + 1)
            .max()
            .unwrap();
        let bottom = CODE_TOP + 3.0 * LINE + 12.0 + 8.0 + 14.0 * longest as f64;
        assert!(bottom <= BOX_H[0], "{bottom}");
    }

    #[test]
    fn the_longest_code_line_fits_the_narrowest_box() {
        let box_w = MIN_CARD_W - 2.0 * BOX_X;
        let longest = "def scale(x, k: float) -> float:".chars().count();
        assert!(
            column(CODE_X, longest) <= box_w,
            "{}",
            column(CODE_X, longest)
        );
        // The completion list, from column 10 of the code.
        assert!(column(CODE_X, 10) - 4.0 + 150.0 <= box_w);
    }

    #[test]
    fn each_error_marks_the_text_pyrefly_reports_it_on() {
        let lines = [
            "def scale(x, k: float) -> float:",
            "    return x * k",
            "scale(2, \"3\")",
            "print(totl)",
        ];
        let marked: Vec<&str> = ERRORS
            .iter()
            .map(|error| &lines[error.line][error.start..error.end])
            .collect();
        assert_eq!(marked, ["totl", "\"3\"", "x", "x * k", "scale(2, \"3\")"]);
    }
}
