//! Diagrams for mods: `mermaidSvg(source, { dark })` and `svgFile(svg)` in the
//! "lumbridge" module.
//!
//! Both write an SVG file to `cache/diagrams/<sha256>.svg` in the app home and
//! answer `{ path, width, height }`, where `path` is relative to the app home,
//! the way `image(path)` resolves it. The name is a hash of what was asked, so
//! asking again (every render) is a stat, not a render. GPUI draws the file
//! with usvg/resvg and its system font database, so `<text>` shows.
//!
//! Mermaid is rendered in-process by mermaid-rs-renderer (pure Rust, no
//! browser, no network). Errors are answered as `{ error }`, panics included.

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

/// Where the files go, relative to the app home (forward slashes: it's an asset path).
pub const DIR: &str = "cache/diagrams";
/// Files kept; the oldest beyond this are removed when one is written.
const KEEP: usize = 500;
/// The largest SVG written, from a mod or from Mermaid.
pub const MAX_SVG: usize = 2 * 1024 * 1024;
/// The largest Mermaid source rendered.
const MAX_SOURCE: usize = 256 * 1024;
/// Part of every Mermaid file's hash: bump with the renderer so upgrades redraw.
const RENDERER: &str = "mermaid-rs-renderer 0.3.1";

/// Files this process has answered for, with their size: a later ask only
/// checks the file is still there. Keyed by full path (tests use several homes).
static KNOWN: Mutex<Option<HashMap<PathBuf, (f64, f64)>>> = Mutex::new(None);

/// Mermaid source to an SVG file. `dark` picks the dark theme.
pub fn mermaid(home: &Path, source: &str, dark: bool) -> Value {
    if source.trim().is_empty() {
        return error("empty Mermaid source");
    }
    if source.len() > MAX_SOURCE {
        return error(format!("Mermaid source is over {} KB", MAX_SOURCE / 1024));
    }
    let key = hash(&["mermaid", RENDERER, if dark { "dark" } else { "light" }, source]);
    if let Some(hit) = cached(home, &key) {
        return hit;
    }
    let source = source.to_owned();
    // The renderer has panicked on odd input before (Zed saw it): a bad
    // diagram must never take the window down.
    let rendered = std::panic::catch_unwind(move || {
        let options = mermaid_rs_renderer::RenderOptions {
            theme: if dark { mermaid_rs_renderer::Theme::dark() } else { mermaid_rs_renderer::Theme::modern() },
            layout: mermaid_rs_renderer::LayoutConfig::default(),
        };
        mermaid_rs_renderer::render_with_options(&source, options)
    });
    match rendered {
        Ok(Ok(svg)) => store(home, &key, &svg),
        Ok(Err(e)) => error(format!("Mermaid: {}", first_line(&format!("{e:#}")))),
        Err(panic) => {
            let why = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
            error(format!("Mermaid could not draw this diagram{}", if why.is_empty() { String::new() } else { format!(" ({})", first_line(&why)) }))
        }
    }
}

/// SVG text (a chart a mod drew) to a file in the same cache.
pub fn svg_file(home: &Path, svg: &str) -> Value {
    let key = hash(&["svg", svg]);
    if let Some(hit) = cached(home, &key) {
        return hit;
    }
    store(home, &key, svg)
}

fn error(message: impl Into<String>) -> Value {
    json!({ "error": message.into() })
}

fn first_line(s: &str) -> &str {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or(s).trim()
}

fn hash(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn relative(key: &str) -> String {
    format!("{DIR}/{key}.svg")
}

fn answer(key: &str, (width, height): (f64, f64)) -> Value {
    json!({ "path": relative(key), "width": width, "height": height })
}

fn remember(path: PathBuf, size: (f64, f64)) {
    let mut known = KNOWN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let known = known.get_or_insert_with(HashMap::new);
    if known.len() >= 4 * KEEP {
        known.clear();
    }
    known.insert(path, size);
}

/// The answer for a file already written, by this process or an earlier one.
fn cached(home: &Path, key: &str) -> Option<Value> {
    let path = home.join(relative(key));
    let known = KNOWN.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().and_then(|k| k.get(&path).copied());
    if let Some(size) = known {
        return path.is_file().then(|| answer(key, size));
    }
    // From an earlier run: read its size, and mark it used so pruning keeps it.
    let text = std::fs::read_to_string(&path).ok()?;
    let size = measure(&text).ok()?;
    if let Ok(file) = std::fs::File::options().write(true).open(&path) {
        let _ = file.set_modified(SystemTime::now());
    }
    remember(path, size);
    Some(answer(key, size))
}

fn store(home: &Path, key: &str, svg: &str) -> Value {
    if svg.len() > MAX_SVG {
        return error(format!("SVG is over {} MB", MAX_SVG / 1024 / 1024));
    }
    let size = match measure(svg) {
        Ok(size) => size,
        Err(e) => return error(e),
    };
    let dir = home.join(DIR);
    let path = home.join(relative(key));
    let written = std::fs::create_dir_all(&dir).and_then(|_| {
        // Whole or not at all: a reader never sees half a file.
        let tmp = dir.join(format!(".{key}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, svg)?;
        std::fs::rename(&tmp, &path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    });
    if let Err(e) = written {
        return error(format!("cannot write {}: {e}", path.display()));
    }
    prune(&dir, KEEP);
    remember(path, size);
    answer(key, size)
}

/// Keeps the `keep` newest SVGs in `dir`.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "svg"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    for (_, path) in &files[..files.len() - keep] {
        let _ = std::fs::remove_file(path);
    }
}

/// Checks `svg` is an SVG document and answers its size in CSS pixels: the
/// root's `width`/`height` (unitless or px), else its `viewBox`.
fn measure(svg: &str) -> Result<(f64, f64), String> {
    let options = roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() };
    let doc = roxmltree::Document::parse_with_options(svg, options).map_err(|e| format!("not an SVG document: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace().is_some_and(|ns| ns != "http://www.w3.org/2000/svg") {
        return Err(format!("not an SVG document: the root element is <{}>", root.tag_name().name()));
    }
    let px = |name: &str| {
        let v = root.attribute(name)?.trim();
        let v = v.strip_suffix("px").unwrap_or(v).trim();
        v.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0)
    };
    let view_box = root.attribute("viewBox").and_then(|v| {
        let n: Vec<f64> = v.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
        (n.len() == 4 && n[2].is_finite() && n[3].is_finite() && n[2] > 0.0 && n[3] > 0.0).then(|| (n[2], n[3]))
    });
    let size = match (px("width"), px("height"), view_box) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some((vw, vh))) => (w, w * vh / vw),
        (None, Some(h), Some((vw, vh))) => (h * vw / vh, h),
        (_, _, Some(vb)) => vb,
        _ => return Err("the SVG needs width and height (px) or a viewBox".into()),
    };
    Ok(((size.0 * 100.0).round() / 100.0, (size.1 * 100.0).round() / 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Home(PathBuf);
    impl Home {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("lumbridge-diagrams-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ok(v: &Value) -> (String, f64, f64) {
        assert!(v.get("error").is_none(), "{v}");
        (v["path"].as_str().unwrap().to_owned(), v["width"].as_f64().unwrap(), v["height"].as_f64().unwrap())
    }

    #[test]
    fn mermaid_flowchart_and_sequence_render_with_text() {
        let home = Home::new("render");
        for (source, words) in [
            ("flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship it]\n", ["Start", "Ship it"]),
            ("sequenceDiagram\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice\n", ["Alice", "Hello Bob"]),
        ] {
            for dark in [false, true] {
                let (path, w, h) = ok(&mermaid(&home.0, source, dark));
                assert!(path.starts_with("cache/diagrams/") && path.ends_with(".svg"), "{path}");
                assert!(w > 10.0 && h > 10.0, "{w}x{h}");
                let svg = std::fs::read_to_string(home.0.join(&path)).unwrap();
                // Real <text>, which usvg draws (a <foreignObject> label would be blank).
                assert!(svg.contains("<text"), "{svg}");
                assert!(!svg.contains("foreignObject"));
                for word in words {
                    assert!(svg.contains(word), "{word} missing: {svg}");
                }
            }
        }
        let light = ok(&mermaid(&home.0, "flowchart LR\n A-->B", false)).0;
        let dark = ok(&mermaid(&home.0, "flowchart LR\n A-->B", true)).0;
        assert_ne!(light, dark, "the theme is part of the name");
    }

    #[test]
    fn the_same_source_answers_the_same_file_without_rendering_again() {
        let home = Home::new("cache");
        let source = "flowchart TD\n  X --> Y\n";
        let first = mermaid(&home.0, source, false);
        let (path, ..) = ok(&first);
        let file = home.0.join(&path);
        std::fs::write(&file, std::fs::read_to_string(&file).unwrap().replace("</svg>", "<!-- marker --></svg>")).unwrap();
        assert_eq!(mermaid(&home.0, source, false), first);
        assert!(std::fs::read_to_string(&file).unwrap().contains("marker"), "a hit must not rewrite the file");
        // A removed file is written again.
        std::fs::remove_file(&file).unwrap();
        assert_eq!(mermaid(&home.0, source, false), first);
        assert!(file.is_file());
        // A file from an earlier run is measured, not redrawn.
        KNOWN.lock().unwrap().as_mut().unwrap().remove(&file);
        assert_eq!(mermaid(&home.0, source, false), first);
    }

    #[test]
    fn bad_mermaid_is_an_error_not_a_panic() {
        let home = Home::new("bad");
        for source in ["", "   ", "this is not mermaid at all", "flowchart LR\n A -->", "sequenceDiagram\n ->>: \n"] {
            let v = mermaid(&home.0, source, false);
            if source.trim().is_empty() || source.starts_with("this") {
                assert!(v["error"].as_str().is_some_and(|e| !e.is_empty()), "{source:?}: {v}");
            } else {
                // Either drawn or refused, but always one of the two shapes.
                assert!(v.get("error").is_some() || v.get("path").is_some(), "{source:?}: {v}");
            }
        }
        assert!(mermaid(&home.0, &"a".repeat(MAX_SOURCE + 1), false).get("error").is_some());
    }

    #[test]
    fn svg_file_takes_svg_and_refuses_the_rest() {
        let home = Home::new("svg");
        let chart = r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="60" height="40" fill="#4a8"/><text x="64" y="24">42%</text></svg>"##;
        let (path, w, h) = ok(&svg_file(&home.0, chart));
        assert_eq!((w, h), (120.0, 40.0));
        assert_eq!(std::fs::read_to_string(home.0.join(&path)).unwrap(), chart);
        assert_eq!(ok(&svg_file(&home.0, chart)).0, path);
        // viewBox only, and px units.
        assert_eq!(ok(&svg_file(&home.0, r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"/>"#)).1, 300.0);
        assert_eq!(ok(&svg_file(&home.0, r#"<svg xmlns="http://www.w3.org/2000/svg" width="200px" viewBox="0 0 100 50"/>"#)).2, 100.0);
        for bad in [
            "",
            "hello",
            "<html><body/></html>",
            r#"<svg xmlns="http://www.w3.org/2000/svg">"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
            r#"<x:svg xmlns:x="urn:other" width="1" height="1"/>"#,
            r#"<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">&a;</svg>"#,
        ] {
            assert!(svg_file(&home.0, bad)["error"].is_string(), "{bad:?}");
        }
        let huge = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--{}--></svg>"#, "x".repeat(MAX_SVG));
        assert!(svg_file(&home.0, &huge)["error"].as_str().unwrap().contains("MB"));
        assert!(!home.0.join(DIR).read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn pruning_keeps_the_newest() {
        let home = Home::new("prune");
        let dir = home.0.join(DIR);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            let path = dir.join(format!("{i}.svg"));
            std::fs::write(&path, "x").unwrap();
            let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(at).unwrap();
        }
        std::fs::write(dir.join("notes.txt"), "kept").unwrap();
        prune(&dir, 3);
        let mut left: Vec<String> = dir.read_dir().unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["2.svg", "3.svg", "4.svg", "notes.txt"]);
    }

    /// GPUI draws these files with its own usvg options (system fonts): the
    /// labels must come out as ink, which they don't without a font database.
    #[test]
    fn gpui_draws_the_labels() {
        let home = Home::new("ink");
        let (path, ..) = ok(&mermaid(&home.0, "flowchart LR\n  A[Lots of label text here] --> B[More words]\n", false));
        let svg = std::fs::read_to_string(home.0.join(path)).unwrap();
        let without_text = strip_text(&svg);
        assert_ne!(svg, without_text);
        let renderer = gpui::SvgRenderer::new(std::sync::Arc::new(()));
        let ink = |svg: &str| {
            let image = renderer.render_single_frame(svg.as_bytes(), 1.0).unwrap();
            let bytes = image.as_bytes(0).unwrap();
            // Count dark-ish opaque pixels (labels are dark on the light theme).
            bytes.chunks_exact(4).filter(|p| p[3] > 128 && (p[0] as u32 + p[1] as u32 + p[2] as u32) < 300).count()
        };
        let (with, without) = (ink(&svg), ink(&without_text));
        assert!(with > without + 50, "labels drew no ink: {with} vs {without} dark pixels");
    }

    /// The SVG with every `<text …>…</text>` element removed.
    fn strip_text(svg: &str) -> String {
        let mut out = String::new();
        let mut rest = svg;
        while let Some(start) = rest.find("<text") {
            out.push_str(&rest[..start]);
            let after = &rest[start..];
            let end = after.find("</text>").map(|e| e + "</text>".len()).unwrap_or(after.len());
            rest = &after[end..];
        }
        out.push_str(rest);
        out
    }
}
