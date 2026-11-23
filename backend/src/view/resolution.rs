//! The Python build system page's diagram: the order in which Lithe looks for
//! the Python interpreter, and what Pyrefly does with the one it finds.
//!
//! The steps follow `toolDefinitions[python].invocation.executables` in
//! `plugin.json`: what the Toolchains page sets for the project and the
//! environments in it, then what it sets for every project, then the
//! automatic lookup. Above them stands the `pythonExecutable` override,
//! which `buildSystems[python].invocation.executables` tries before the
//! lookup, so it decides build, run and pytest but not Pyrefly or debugging.
//! The view sees the plugin's settings only, not the Toolchains page, so it
//! shows the order and the override path; the toolchain row above it shows
//! the interpreter found.
//!
//! The region sits in the build system page's detail pane, 344 points wide
//! in the smallest settings window as measured in the host, so the steps
//! stand one above the other, numbered on a rail. The scene is as wide as
//! the view the host reports, so a unit is a point and the steps widen with
//! the window; a host that reports no width gets the smallest window's.

use super::scene::{group, path, pill, rect, text, text_width, token, Node, CAPTION};
use super::words::Words;
use serde_json::{json, Value};

pub const CANVAS_ID: &str = "python-resolution";

/// The scene's width for a host that reports none.
pub const DEFAULT_WIDTH: f64 = 340.0;
/// The narrowest scene: the row of uses and every step's lines fit it in
/// both languages. A view narrower than it is scaled down by the host.
pub const MIN_WIDTH: f64 = 330.0;
const HEADER: f64 = 28.0;
/// The middle of the rail of numbered dots left of the steps.
const RAIL: f64 = 11.0;
const DOT: f64 = 20.0;
const STEP_X: f64 = 30.0;
const STEP_H: f64 = 64.0;
const STEP_GAP: f64 = 10.0;
/// The middle of a step's title row, where its dot sits.
const TITLE_MIDDLE: f64 = 17.0;
/// The left edge of a step's lines, and their room on its right.
const LINE_X: f64 = 12.0;
/// The top of the first step, under the override card.
const STEPS_Y: f64 = HEADER + STEP_H + STEP_GAP;
/// The top of the Pyrefly card, after the three steps.
const PYREFLY_Y: f64 = STEPS_Y + 3.0 * (STEP_H + STEP_GAP);
/// The top of the row of what the interpreter is used for.
const USES_Y: f64 = PYREFLY_Y + STEP_H + 14.0;
pub const HEIGHT: f64 = USES_Y + 22.0;

struct Step<'a> {
    title: &'a str,
    lines: [&'a str; 2],
    chip: &'a str,
    /// The first step tried, whose chip is lit.
    first: bool,
}

/// The diagram for a view `width` points wide, or for the smallest settings
/// window when the host reports no width, with the override path when it is
/// set. A host that reports the width sends `resize` with the new width, and
/// the scene is drawn again for it.
pub fn canvas(words: &Words, override_path: Option<&str>, width: Option<f64>) -> Value {
    let scene_w = width.unwrap_or(DEFAULT_WIDTH).max(MIN_WIDTH);
    let step_w = scene_w - STEP_X;
    let steps = [
        Step {
            title: words.step_project,
            lines: words.step_project_detail,
            chip: words.first,
            first: true,
        },
        Step {
            title: words.step_global,
            lines: words.step_global_detail,
            chip: words.then,
            first: false,
        },
        Step {
            title: words.step_automatic,
            lines: words.step_automatic_detail,
            chip: words.last,
            first: false,
        },
    ];

    let mut nodes = vec![
        text(0.0, 17.0, words.resolution_title, "strong"),
        override_card(words, override_path, step_w),
    ];
    for (index, step) in steps.iter().enumerate() {
        let y = STEPS_Y + index as f64 * (STEP_H + STEP_GAP);
        if index > 0 {
            // The rail joins the dots.
            let above = y - STEP_GAP - STEP_H + TITLE_MIDDLE + DOT / 2.0 + 4.0;
            let below = y + TITLE_MIDDLE - DOT / 2.0 - 4.0;
            nodes.push(
                path(format!("M{RAIL} {above} V{below}"))
                    .stroke(token("$line"), 2.0)
                    .set("cap", "round"),
            );
        }
        nodes.push(draw(y, index + 1, step, step_w));
    }
    nodes.push(pyrefly(words, step_w));
    nodes.extend(uses(words, override_path.is_some()).0);
    let mut canvas = json!({
        "type": "canvas",
        "id": CANVAS_ID,
        "label": words.resolution_label,
        "height": HEIGHT.ceil() as u64,
        "viewBox": [0, 0, scene_w, HEIGHT],
        "nodes": nodes.into_iter().map(Value::from).collect::<Vec<_>>(),
    });
    if width.is_some() {
        canvas["on"] = json!(["resize"]);
    }
    canvas
}

/// A step at `y`: its numbered dot on the rail and its card, `step_w` wide.
fn draw(y: f64, number: usize, step: &Step, step_w: f64) -> Node {
    let frame = rect(0.0, 0.0, step_w, STEP_H)
        .radius(8.0)
        .fill(token("$surface"))
        .stroke(token("$line"), 1.0);
    // Accent ink on the selection fill falls to about 2:1 in the dark theme.
    let (fill, ink) = if step.first {
        (token("$selection"), token("$text"))
    } else {
        (token("$badge"), token("$textSecondary"))
    };
    let (_, chip_w) = pill(0.0, 0.0, step.chip, fill.clone(), ink.clone());
    let chip_x = step_w - 10.0 - chip_w;
    let (chip, _) = pill(chip_x, TITLE_MIDDLE - 10.0, step.chip, fill, ink);
    let mut card = vec![
        frame,
        text(LINE_X, TITLE_MIDDLE + 4.5, step.title, "strong").max_width(chip_x - LINE_X - 10.0),
        chip,
    ];
    card.extend(lines(&step.lines, step_w));
    group(
        0.0,
        y,
        vec![
            rect(RAIL - DOT / 2.0, TITLE_MIDDLE - DOT / 2.0, DOT, DOT)
                .radius(DOT / 2.0)
                .fill(token("$badge")),
            text(RAIL, TITLE_MIDDLE + 4.0, &number.to_string(), "caption")
                .align("center")
                .color(token("$textSecondary")),
            group(STEP_X, 0.0, card),
        ],
    )
}

/// The override path, off the rail above the lookup: dashed while empty, and
/// framed like the first step with the path while set, since build, run and
/// pytest then take it before any step.
fn override_card(words: &Words, path: Option<&str>, step_w: f64) -> Node {
    let (chip, fill, ink) = match path {
        Some(_) => (words.override_set, token("$selection"), token("$text")),
        None => (
            words.override_unset,
            token("$badge"),
            token("$textSecondary"),
        ),
    };
    let (_, chip_w) = pill(0.0, 0.0, chip, fill.clone(), ink.clone());
    let chip_x = step_w - 10.0 - chip_w;
    let frame = rect(0.0, 0.0, step_w, STEP_H).radius(8.0);
    let frame = match path {
        Some(_) => frame.fill(token("$surface")).stroke(token("$line"), 1.0),
        None => frame.stroke(token("$line"), 1.0).dash(&[4.0, 3.0]),
    };
    let mut card = vec![
        frame,
        text(LINE_X, TITLE_MIDDLE + 4.5, words.override_title, "strong")
            .max_width(chip_x - LINE_X - 10.0),
        pill(chip_x, TITLE_MIDDLE - 10.0, chip, fill, ink).0,
    ];
    match path {
        Some(path) => {
            card.push(
                text(LINE_X, 40.0, &tail(path, step_w - 2.0 * LINE_X), "caption")
                    .color(token("$text"))
                    .max_width(step_w - 2.0 * LINE_X),
            );
            card.extend(lines(&["", words.override_set_detail], step_w).pop());
        }
        None => card.extend(lines(&words.override_unset_detail, step_w)),
    }
    group(STEP_X, HEADER, card)
}

/// The end of `path` that fits `room`, after an ellipsis when it is cut:
/// the interpreter's name and its environment are at the end.
fn tail(path: &str, room: f64) -> String {
    if text_width(path, CAPTION) <= room {
        return path.to_string();
    }
    let chars: Vec<char> = path.chars().collect();
    (1..chars.len())
        .map(|start| format!("…{}", chars[start..].iter().collect::<String>()))
        .find(|cut| text_width(cut, CAPTION) <= room)
        .unwrap_or_else(|| "…".into())
}

/// A card's lines of detail, at most two, in a card `card_w` wide.
fn lines(lines: &[&str], card_w: f64) -> Vec<Node> {
    lines
        .iter()
        .zip([40.0, 55.0])
        .map(|(line, y)| {
            text(LINE_X, y, line, "caption")
                .color(token("$textSecondary"))
                .max_width(card_w - 2.0 * LINE_X)
        })
        .collect()
}

/// What happens once the interpreter is found: Pyrefly is started with it
/// and resolves third-party imports from its site-packages. Off the rail, in
/// a dashed frame, since it is not a step of the lookup.
fn pyrefly(words: &Words, step_w: f64) -> Node {
    let mut card = vec![
        rect(0.0, 0.0, step_w, STEP_H)
            .radius(8.0)
            .stroke(token("$line"), 1.0)
            .dash(&[4.0, 3.0]),
        text(LINE_X, TITLE_MIDDLE + 4.5, words.pyrefly_title, "strong")
            .max_width(step_w - 2.0 * LINE_X),
    ];
    card.extend(lines(&words.pyrefly_detail, step_w));
    group(
        0.0,
        PYREFLY_Y,
        vec![
            // An arrow from the rail into the card: what the steps found
            // leads here. It starts under the last step's dot, as the rail
            // between the steps does.
            path(format!(
                "M{RAIL} {} V{TITLE_MIDDLE} H{}",
                TITLE_MIDDLE + DOT / 2.0 + 4.0 - STEP_H - STEP_GAP,
                STEP_X - 6.0
            ))
            .stroke(token("$line"), 2.0)
            .set("cap", "round"),
            path(format!(
                "M{} {} L{} {TITLE_MIDDLE} L{} {}",
                STEP_X - 9.0,
                TITLE_MIDDLE - 4.0,
                STEP_X - 4.0,
                STEP_X - 9.0,
                TITLE_MIDDLE + 4.0
            ))
            .stroke(token("$line"), 2.0)
            .set("cap", "round"),
            group(STEP_X, 0.0, card),
        ],
    )
}

/// What Lithe uses the interpreter the lookup finds for, after the cards, and
/// where the row ends. While the override path is set, it takes run, test
/// and install.
fn uses(words: &Words, overridden: bool) -> (Vec<Node>, f64) {
    let mut nodes =
        vec![text(0.0, USES_Y + 14.0, words.used_for, "caption").color(token("$textMuted"))];
    let mut x = text_width(words.used_for, CAPTION) + 8.0;
    let mut end = x;
    for (index, word) in words.uses.iter().enumerate() {
        if overridden && [1, 2, 4].contains(&index) {
            continue;
        }
        let (chip, width) = pill(x, USES_Y, word, token("$badge"), token("$textSecondary"));
        nodes.push(chip);
        end = x + width;
        x = end + 6.0;
    }
    (nodes, end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::scene::STRONG;
    use crate::view::words;

    #[test]
    fn a_long_override_path_keeps_its_end() {
        let path =
            "/Users/someone/projects/a-very-long-project-name/.venv-with-a-long-name/bin/python3";
        let cut = tail(path, 200.0);
        assert!(
            cut.starts_with('…') && cut.ends_with("/bin/python3"),
            "{cut}"
        );
        assert!(text_width(&cut, CAPTION) <= 200.0);
        assert_eq!(tail("/usr/bin/python3", 200.0), "/usr/bin/python3");
    }

    #[test]
    fn the_row_of_uses_fits_the_narrowest_scene_in_both_languages() {
        for language in ["en", "zh-Hans"] {
            for overridden in [false, true] {
                let (_, end) = uses(words::for_language(language), overridden);
                assert!(end <= MIN_WIDTH, "{language}: {end}");
            }
        }
    }

    #[test]
    fn every_line_of_every_card_fits_the_narrowest_scene() {
        let room = MIN_WIDTH - STEP_X - 2.0 * LINE_X;
        for language in ["en", "zh-Hans"] {
            let w = words::for_language(language);
            for line in [
                w.step_project_detail,
                w.step_global_detail,
                w.step_automatic_detail,
                w.pyrefly_detail,
                w.override_unset_detail,
                [w.override_set_detail; 2],
            ]
            .concat()
            {
                let width = text_width(line, CAPTION);
                assert!(width <= room, "{language}: {line} ({width} of {room})");
            }
            let width = text_width(w.pyrefly_title, STRONG);
            assert!(width <= room, "{language}: {} ({width})", w.pyrefly_title);
            // The override title keeps its room beside the wider chip.
            let chip = [w.override_set, w.override_unset]
                .map(|chip| text_width(chip, CAPTION) + 16.0)
                .into_iter()
                .fold(0.0, f64::max);
            let width = text_width(w.override_title, STRONG);
            let room = MIN_WIDTH - STEP_X - 10.0 - chip - LINE_X - 10.0;
            assert!(
                width <= room,
                "{language}: {} ({width} of {room})",
                w.override_title
            );
            let width = text_width(w.resolution_title, STRONG);
            assert!(
                width <= MIN_WIDTH,
                "{language}: {} ({width})",
                w.resolution_title
            );
        }
    }
}
