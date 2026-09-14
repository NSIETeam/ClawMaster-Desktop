use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use xa11y::{
    App, AppExt, ClickOptions, ClickTarget, Element, Key, MouseButton, Point, Role, ScrollDelta,
};
use zip::write::SimpleFileOptions;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapability {
    id: &'static str,
    provider: &'static str,
    status: &'static str,
    description: &'static str,
    tool: &'static str,
    usage: &'static str,
    replaces: &'static [&'static str],
}

pub fn capability_manifest() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "runtime": "clawmaster-rust",
        "capabilities": [
            NativeCapability {
                id: "desktop.input",
                provider: "rust:xa11y-input",
                status: "ready",
                description: "通过 macOS CGEvent 或 Windows SendInput 执行真实键盘、鼠标、拖拽和滚动",
                tool: "rpa_click",
                usage: "先获取加密 @wN/@eN 引用，再经审批执行原生输入",
                replaces: &["cliclick", "enigo"],
            },
            NativeCapability {
                id: "desktop.snapshot",
                provider: "rust:xa11y",
                status: "ready",
                description: "通过 Windows UIA 或 macOS AX 读取有界语义控件树、边界和动作，优先文本定位而不是截图猜测",
                tool: "desktop_snapshot",
                usage: "读取 elements 的 role/name/description，由 RPA 控制器解析绑定坐标",
                replaces: &["全屏截图识别（可访问控件定位场景）"],
            },
            NativeCapability {
                id: "pdf.merge",
                provider: "rust:lopdf",
                status: "ready",
                description: "原生无损 PDF 合并，无需 pdfunite",
                tool: "merge_pdfs",
                usage: "outputPath=\"merged.pdf\", inputPaths=[\"a.pdf\",\"b.pdf\"]；使用工作区相对路径",
                replaces: &["pdfunite"],
            },
            NativeCapability {
                id: "pdf.optimize",
                provider: "rust:lopdf",
                status: "ready",
                description: "原生 PDF 对象清理和流压缩；需要图片降采样时再使用 Ghostscript",
                tool: "optimize_pdf",
                usage: "outputPath=\"optimized.pdf\", inputPath=\"source.pdf\"；使用工作区相对路径",
                replaces: &["ghostscript（无损优化场景）"],
            },
            NativeCapability {
                id: "chart.svg",
                provider: "rust:svg",
                status: "ready",
                description: "原生可编辑 SVG 柱状图和折线图，无需 Node.js、Python 或 gnuplot",
                tool: "generate_chart",
                usage: "chartType=\"bar|line\", labels=[...], values=[...]",
                replaces: &["gnuplot（内置图表场景）"],
            },
            NativeCapability {
                id: "slides.pptx",
                provider: "rust:zip+xml",
                status: "ready",
                description: "原生可编辑 PPTX 生成，无需 Node.js、PptxGenJS、Python 或 Marp",
                tool: "generate_pptx",
                usage: "outputPath=\"briefing.pptx\", title=\"标题\", content=\"# 第一页\\n...\\n---\\n# 第二页\"",
                replaces: &["node", "pptxgenjs", "python-pptx", "marp"],
            },
            NativeCapability {
                id: "document.docx",
                provider: "rust:zip+xml",
                status: "ready",
                description: "原生 DOCX 公文生成和 Markdown 基础结构解析，无需 Python、pandoc 或 typst",
                tool: "generate_docx",
                usage: "outputPath=\"report.docx\", title=\"标题\", content=\"正文\"；使用工作区相对路径",
                replaces: &["python3", "python-docx", "jinja2", "markdown"],
            },
        ]
    })
}

fn bounded_label(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect()
}

const MAX_DESKTOP_ELEMENTS: usize = 200;
// Chromium places document controls below several browser-chrome containers.
const MAX_DESKTOP_DEPTH: usize = 16;

#[derive(Default)]
struct DesktopTreeState {
    elements: Vec<serde_json::Value>,
    truncated: bool,
    unreadable_subtrees: usize,
}

fn exposes_text_value(role: Role, editable: bool) -> bool {
    !editable && !matches!(role, Role::TextField | Role::TextArea)
}

fn meaningful_element(element: &Element) -> bool {
    let has_semantics = element.name.as_ref().is_some_and(|value| !value.is_empty())
        || !element.actions.is_empty()
        || element.states.focusable
        || element.states.editable;
    match element.role {
        Role::Unknown => false,
        Role::Application | Role::Group => has_semantics,
        _ => true,
    }
}

fn collect_desktop_elements(
    element: &Element,
    depth: usize,
    parent_ref: Option<&str>,
    state: &mut DesktopTreeState,
) {
    if state.elements.len() >= MAX_DESKTOP_ELEMENTS {
        state.truncated = true;
        return;
    }

    let mut next_parent = parent_ref.map(str::to_owned);
    if meaningful_element(element) {
        let element_ref = format!("@e{}", state.elements.len() + 1);
        let editable = element.states.editable;
        let value = exposes_text_value(element.role, editable)
            .then(|| {
                element
                    .value
                    .as_deref()
                    .map(|value| bounded_label(value, 500))
            })
            .flatten();
        let bounds = element.bounds.map(|bounds| {
            serde_json::json!({
                "x": bounds.x,
                "y": bounds.y,
                "width": bounds.width,
                "height": bounds.height,
                "centerX": i64::from(bounds.x) + i64::from(bounds.width) / 2,
                "centerY": i64::from(bounds.y) + i64::from(bounds.height) / 2
            })
        });
        state.elements.push(serde_json::json!({
            "ref": element_ref,
            "parentRef": parent_ref,
            "depth": depth,
            "role": element.role.to_snake_case(),
            "name": element.name.as_deref().map(|value| bounded_label(value, 300)),
            "value": value,
            "valueRedacted": !exposes_text_value(element.role, editable) && element.value.is_some(),
            "description": element.description.as_deref().map(|value| bounded_label(value, 300)),
            "stableId": element.stable_id.as_deref().map(|value| bounded_label(value, 200)),
            "bounds": bounds,
            "actions": element.actions.iter().take(16).map(|value| bounded_label(value, 80)).collect::<Vec<_>>(),
            "states": {
                "enabled": element.states.enabled,
                "visible": element.states.visible,
                "focused": element.states.focused,
                "active": element.states.active,
                "selected": element.states.selected,
                "editable": editable,
                "focusable": element.states.focusable
            }
        }));
        next_parent = Some(element_ref);
    }

    if depth >= MAX_DESKTOP_DEPTH {
        state.truncated = true;
        return;
    }
    match element.children() {
        Ok(children) => {
            for child in children {
                collect_desktop_elements(&child, depth + 1, next_parent.as_deref(), state);
                if state.elements.len() >= MAX_DESKTOP_ELEMENTS {
                    state.truncated = true;
                    break;
                }
            }
        }
        Err(_) => state.unreadable_subtrees += 1,
    }
}

pub(crate) fn desktop_snapshot_for_element(
    app: &App,
    root: &Element,
    window_title: Option<&str>,
) -> serde_json::Value {
    let mut tree = DesktopTreeState::default();
    collect_desktop_elements(root, 0, None, &mut tree);

    serde_json::json!({
        "provider": "rust:xa11y",
        "coordinateSpace": "logical-desktop-top-left",
        "activeWindow": {
            "app": bounded_label(&app.name, 200),
            "title": window_title
                .or(app.data.name.as_deref())
                .map(|value| bounded_label(value, 500)),
            "processId": app.pid,
            "bounds": root.bounds
        },
        "elements": tree.elements,
        "truncated": tree.truncated,
        "unreadableSubtrees": tree.unreadable_subtrees,
        "limits": {"maxElements": MAX_DESKTOP_ELEMENTS, "maxDepth": MAX_DESKTOP_DEPTH},
        "referenceScope": "this-snapshot-only",
        "visionRequired": false,
        "hint": "Use element bounds centers as the native coordinate reference for confirmed physical mouse actions. Re-snapshot after the UI changes. Request vision only when the accessibility tree cannot identify the target."
    })
}

pub(crate) fn desktop_snapshot() -> Result<serde_json::Value, String> {
    let app = App::foreground(Duration::ZERO).map_err(desktop_snapshot_error)?;
    let root = app.as_element();
    Ok(desktop_snapshot_for_element(&app, &root, None))
}

fn desktop_snapshot_error(error: xa11y::Error) -> String {
    let detail = error.to_string();
    if detail.to_ascii_lowercase().contains("permission denied") {
        return format!(
            "桌面语义快照不可用：系统尚未授权辅助功能。macOS 请在“系统设置 → 隐私与安全性 → 辅助功能”中启用 ClawMaster 后重新启动应用；Windows 请避免让目标窗口以高于 ClawMaster 的管理员权限运行。原始错误：{detail}"
        );
    }
    format!("读取前台辅助功能树失败：{detail}")
}

fn validate_native_input_permission(trusted: bool) -> Result<(), String> {
    if trusted {
        Ok(())
    } else {
        Err("ClawMaster 尚未获得 macOS 辅助功能权限，系统会丢弃键盘和鼠标操作。请在“系统设置 → 隐私与安全性 → 辅助功能”中添加并启用 ClawMaster，然后重新启动应用".into())
    }
}

#[cfg(target_os = "macos")]
fn ensure_native_input_permission() -> Result<(), String> {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }

    validate_native_input_permission(unsafe { AXIsProcessTrusted() != 0 })
}

#[cfg(not(target_os = "macos"))]
fn ensure_native_input_permission() -> Result<(), String> {
    Ok(())
}

pub(crate) fn input_tool(args: &[String]) -> Result<(), String> {
    let action = args
        .first()
        .map(String::as_str)
        .ok_or("native input action is required")?;
    ensure_native_input_permission()?;
    let input = xa11y::input_sim().map_err(|error| format!("initialize native input: {error}"))?;
    match action {
        "type" => input
            .keyboard()
            .type_text(args.get(1).ok_or("native input text is required")?)
            .map_err(|error| error.to_string()),
        "click" => {
            let x = parse_i32(args.get(1), "x")?;
            let y = parse_i32(args.get(2), "y")?;
            let button = match args.get(3).map(String::as_str).unwrap_or("left") {
                "right" => MouseButton::Right,
                "middle" => MouseButton::Middle,
                _ => MouseButton::Left,
            };
            let count = if args.get(4).map(String::as_str) == Some("double") {
                2
            } else {
                1
            };
            input
                .mouse()
                .click_with(
                    ClickTarget::Point(Point::new(x, y)),
                    ClickOptions {
                        button,
                        count,
                        ..ClickOptions::default()
                    },
                )
                .map_err(|error| error.to_string())
        }
        "drag" => {
            let x = parse_i32(args.get(1), "x")?;
            let y = parse_i32(args.get(2), "y")?;
            let to_x = parse_i32(args.get(3), "to_x")?;
            let to_y = parse_i32(args.get(4), "to_y")?;
            native_drag(&input, Point::new(x, y), Point::new(to_x, to_y))
        }
        "scroll" => {
            let amount = parse_i32(args.get(1), "amount")?;
            let point = scroll_point(args.get(2), args.get(3))?;
            input
                .mouse()
                .move_to(point)
                .map_err(|error| error.to_string())?;
            std::thread::sleep(Duration::from_millis(50));
            for step in scroll_steps(amount)? {
                input
                    .mouse()
                    .scroll(point, ScrollDelta::vertical(step))
                    .map_err(|error| error.to_string())?;
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        }
        "hotkey" => {
            let (key, modifiers) = parse_hotkey(args.get(1).ok_or("hotkey is required")?)?;
            input
                .keyboard()
                .chord(key, &modifiers)
                .map_err(|error| error.to_string())
        }
        _ => Err(format!("unsupported native input action: {action}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn native_drag(input: &xa11y::InputSim, from: Point, to: Point) -> Result<(), String> {
    input
        .mouse()
        .drag(from, to)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn native_drag(_input: &xa11y::InputSim, from: Point, to: Point) -> Result<(), String> {
    use std::ffi::c_void;

    const CG_HID_EVENT_TAP: u32 = 0;
    const CG_LEFT_MOUSE_DOWN: u32 = 1;
    const CG_LEFT_MOUSE_UP: u32 = 2;
    const CG_MOUSE_MOVED: u32 = 5;
    const CG_LEFT_MOUSE_DRAGGED: u32 = 6;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CgPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            mouse_type: u32,
            mouse_cursor_position: CgPoint,
            mouse_button: u32,
        ) -> *mut c_void;
        fn CGEventPost(tap: u32, event: *mut c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }

    fn post(mouse_type: u32, point: Point) -> Result<(), String> {
        // Quartz owns the event after creation only until it is posted and released here.
        let event = unsafe {
            CGEventCreateMouseEvent(
                std::ptr::null(),
                mouse_type,
                CgPoint {
                    x: f64::from(point.x),
                    y: f64::from(point.y),
                },
                0,
            )
        };
        if event.is_null() {
            return Err("create macOS native drag event failed".into());
        }
        unsafe {
            CGEventPost(CG_HID_EVENT_TAP, event);
            CFRelease(event);
        }
        Ok(())
    }

    post(CG_MOUSE_MOVED, from)?;
    std::thread::sleep(Duration::from_millis(30));
    post(CG_LEFT_MOUSE_DOWN, from)?;
    for step in 1..=12 {
        let x = from.x + (to.x - from.x) * step / 12;
        let y = from.y + (to.y - from.y) * step / 12;
        post(CG_LEFT_MOUSE_DRAGGED, Point::new(x, y))?;
        std::thread::sleep(Duration::from_millis(16));
    }
    post(CG_LEFT_MOUSE_UP, to)
}

fn scroll_steps(amount: i32) -> Result<Vec<i32>, String> {
    if amount == 0 || !(-100..=100).contains(&amount) {
        return Err("scroll amount must be a non-zero value between -100 and 100".into());
    }
    Ok(std::iter::repeat_n(amount.signum(), amount.unsigned_abs() as usize).collect())
}

fn parse_i32(value: Option<&String>, label: &str) -> Result<i32, String> {
    value
        .ok_or_else(|| format!("{label} is required"))?
        .parse::<i32>()
        .map_err(|_| format!("{label} must be an integer"))
}

fn parse_hotkey(value: &str) -> Result<(Key, Vec<Key>), String> {
    let mut parts = value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let key = parts.pop().ok_or("hotkey key is required")?;
    let modifiers = parts
        .iter()
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "win" => Ok(Key::Meta),
            "ctrl" | "control" => Ok(Key::Ctrl),
            "alt" | "option" => Ok(Key::Alt),
            "shift" => Ok(Key::Shift),
            other => Err(format!("unsupported hotkey modifier: {other}")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let key = match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => Key::Enter,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        value if value.chars().count() == 1 => Key::Char(value.chars().next().unwrap()),
        other => return Err(format!("unsupported hotkey key: {other}")),
    };
    Ok((key, modifiers))
}

fn scroll_point(x: Option<&String>, y: Option<&String>) -> Result<Point, String> {
    match (
        x.filter(|value| !value.is_empty()),
        y.filter(|value| !value.is_empty()),
    ) {
        (Some(x), Some(y)) => Ok(Point::new(
            parse_i32(Some(x), "x")?,
            parse_i32(Some(y), "y")?,
        )),
        (None, None) => {
            let app = App::foreground(Duration::ZERO)
                .map_err(|error| format!("read foreground window for scroll: {error}"))?;
            let bounds = app
                .data
                .bounds
                .ok_or("foreground window has no scroll coordinates")?;
            Ok(Point::new(
                bounds.x + bounds.width as i32 / 2,
                bounds.y + bounds.height as i32 / 2,
            ))
        }
        _ => Err("scroll x and y must be provided together".into()),
    }
}

pub(crate) fn merge_pdfs(output: &Path, inputs: &[String]) -> Result<(), String> {
    if inputs.len() < 2 {
        return Err("pdf merge requires at least two inputs".to_string());
    }
    let mut max_id = 1;
    let mut page_number = 1;
    let mut pages: BTreeMap<u32, ObjectId> = BTreeMap::new();
    let mut objects = BTreeMap::new();
    for input in inputs {
        let mut document =
            Document::load(input).map_err(|error| format!("load {input}: {error}"))?;
        document.renumber_objects_with(max_id);
        max_id = document.max_id + 1;
        for (_, object_id) in document.get_pages() {
            pages.insert(page_number, object_id);
            page_number += 1;
        }
        objects.extend(document.objects);
    }

    let mut document = Document::with_version("1.5");
    let mut catalog = None;
    let mut pages_root = None;
    for (object_id, object) in objects {
        match object.type_name().unwrap_or_default() {
            "Catalog" => {
                catalog = Some((object_id, object));
            }
            "Pages" => {
                if pages_root.is_none() {
                    pages_root = Some((object_id, object));
                }
            }
            "Page" | "Outlines" | "Outline" => {
                document.objects.insert(object_id, object);
            }
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }
    let (pages_id, mut pages_object) = pages_root.ok_or("PDF pages root is missing")?;
    let (catalog_id, mut catalog_object) = catalog.ok_or("PDF catalog is missing")?;
    for page_id in pages.values() {
        let page = document
            .get_object_mut(*page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|error| format!("read PDF page: {error}"))?;
        page.set("Parent", pages_id);
    }
    let pages_dictionary: &mut Dictionary = pages_object
        .as_dict_mut()
        .map_err(|error| format!("read PDF pages root: {error}"))?;
    pages_dictionary.set("Count", pages.len() as i64);
    pages_dictionary.set(
        "Kids",
        pages
            .values()
            .copied()
            .map(Object::Reference)
            .collect::<Vec<_>>(),
    );
    catalog_object
        .as_dict_mut()
        .map_err(|error| format!("read PDF catalog: {error}"))?
        .set("Pages", pages_id);
    document.objects.insert(pages_id, pages_object);
    document.objects.insert(catalog_id, catalog_object);
    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.keys().map(|id| id.0).max().unwrap_or(0);
    document.renumber_objects();
    document.compress();
    document
        .save(output)
        .map_err(|error| format!("save merged PDF: {error}"))?;
    Ok(())
}

pub(crate) fn optimize_pdf(output: &Path, input: &Path) -> Result<(), String> {
    let mut document =
        Document::load(input).map_err(|error| format!("load {}: {error}", input.display()))?;
    document.prune_objects();
    document.compress();
    document
        .save(output)
        .map_err(|error| format!("save optimized PDF: {error}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocxRequest {
    title: String,
    author: String,
    department: String,
    format: String,
    content: String,
}

pub(crate) fn write_docx_content(
    output: &Path,
    title: &str,
    author: &str,
    department: &str,
    format: &str,
    content: &str,
) -> Result<(), String> {
    write_docx_request(
        output,
        &DocxRequest {
            title: title.to_string(),
            author: author.to_string(),
            department: department.to_string(),
            format: format.to_string(),
            content: content.to_string(),
        },
    )
}

pub(crate) fn write_pptx_content(
    output: &Path,
    title: &str,
    author: &str,
    content: &str,
) -> Result<(), String> {
    crate::native_pptx::write_pptx(output, title, author, content)
}

fn xml_escape(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            matches!(*character, '\u{9}' | '\u{A}' | '\u{D}') || *character >= '\u{20}'
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn docx_paragraph(text: &str, style: Option<&str>) -> String {
    let properties = style
        .map(|name| format!("<w:pPr><w:pStyle w:val=\"{}\"/></w:pPr>", xml_escape(name)))
        .unwrap_or_default();
    format!(
        "<w:p>{properties}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml_escape(text)
    )
}

fn markdown_docx_body(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if let Some(text) = trimmed.strip_prefix("### ") {
                docx_paragraph(text, Some("Heading3"))
            } else if let Some(text) = trimmed.strip_prefix("## ") {
                docx_paragraph(text, Some("Heading2"))
            } else if let Some(text) = trimmed.strip_prefix("# ") {
                docx_paragraph(text, Some("Heading1"))
            } else if let Some(text) = trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
            {
                docx_paragraph(&format!("• {text}"), Some("ListParagraph"))
            } else {
                docx_paragraph(line, None)
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

fn write_docx(output: &Path, request_path: &Path) -> Result<(), String> {
    let request: DocxRequest = serde_json::from_slice(
        &std::fs::read(request_path).map_err(|error| format!("read DOCX request: {error}"))?,
    )
    .map_err(|error| format!("parse DOCX request: {error}"))?;
    write_docx_request(output, &request)
}

fn write_docx_request(output: &Path, request: &DocxRequest) -> Result<(), String> {
    let file = std::fs::File::create(output)
        .map_err(|error| format!("create {}: {error}", output.display()))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let entries = [
        ("[Content_Types].xml", include_str!("docx/[Content_Types].xml").to_string()),
        ("_rels/.rels", include_str!("docx/root.rels").to_string()),
        ("word/_rels/document.xml.rels", include_str!("docx/document.rels").to_string()),
        ("word/styles.xml", include_str!("docx/styles.xml").to_string()),
        ("docProps/core.xml", format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:subject>{}</dc:subject></cp:coreProperties>",
            xml_escape(&request.title), xml_escape(&request.author), xml_escape(&request.format)
        )),
        ("word/document.xml", format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{}{}{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr></w:body></w:document>",
            docx_paragraph(&request.title, Some("Title")),
            if request.author.is_empty() && request.department.is_empty() { String::new() } else { docx_paragraph(&format!("{}{}{}", request.department, if request.department.is_empty() || request.author.is_empty() { "" } else { " · " }, request.author), Some("Subtitle")) },
            markdown_docx_body(&request.content)
        )),
    ];
    for (name, body) in entries {
        archive
            .start_file(name, options)
            .map_err(|error| error.to_string())?;
        archive
            .write_all(body.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn dispatch_from_args(args: &[String]) -> Option<Result<(), String>> {
    if args.first().map(String::as_str) != Some("--native-tool") {
        return None;
    }
    let result = match args.get(1).map(String::as_str) {
        Some("capabilities") => serde_json::to_string(&capability_manifest())
            .map_err(|error| error.to_string())
            .map(|json| println!("{json}")),
        Some("desktop-snapshot") => desktop_snapshot()
            .and_then(|snapshot| {
                serde_json::to_string(&snapshot).map_err(|error| error.to_string())
            })
            .map(|json| println!("{json}")),
        Some("input") => input_tool(&args[2..]),
        Some("pdf-merge") => {
            let output = args
                .get(2)
                .map(PathBuf::from)
                .ok_or_else(|| "pdf merge output is required".to_string());
            output.and_then(|output| merge_pdfs(&output, &args[3..]))
        }
        Some("pdf-optimize") => match (args.get(2), args.get(3)) {
            (Some(output), Some(input)) => optimize_pdf(Path::new(output), Path::new(input)),
            _ => Err("pdf optimize output and input are required".to_string()),
        },
        Some("docx-write") => match (args.get(2), args.get(3)) {
            (Some(output), Some(request)) => write_docx(Path::new(output), Path::new(request)),
            _ => Err("docx write output and request are required".to_string()),
        },
        Some("pptx-write") => match (args.get(2), args.get(3), args.get(4), args.get(5)) {
            (Some(output), Some(title), Some(author), Some(content)) => {
                write_pptx_content(Path::new(output), title, author, content)
            }
            _ => Err("pptx write output, title, author and content are required".to_string()),
        },
        Some(other) => Err(format!("unsupported native tool: {other}")),
        None => Err("native tool name is required".to_string()),
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{
        content::{Content, Operation},
        dictionary, Stream,
    };
    use std::io::Read;

    #[test]
    fn bounds_desktop_labels_without_control_characters() {
        assert_eq!(bounded_label("Claw\nMaster\0title", 10), "ClawMaster");
    }

    #[test]
    fn redacts_editable_values_and_parses_cross_platform_hotkeys() {
        assert!(!exposes_text_value(Role::TextField, true));
        assert!(!exposes_text_value(Role::TextArea, false));
        assert!(exposes_text_value(Role::StaticText, false));
        let (key, modifiers) = parse_hotkey("Ctrl+Shift+K").unwrap();
        assert_eq!(key, Key::Char('k'));
        assert_eq!(modifiers, vec![Key::Ctrl, Key::Shift]);
        assert!(scroll_point(Some(&"10".into()), None).is_err());
        assert_eq!(scroll_steps(-3).unwrap(), vec![-1, -1, -1]);
        assert!(scroll_steps(0).is_err());
        assert!(scroll_steps(101).is_err());
    }

    #[test]
    fn explains_how_to_recover_missing_desktop_accessibility_permission() {
        let message = desktop_snapshot_error(xa11y::Error::PermissionDenied {
            instructions: "Enable Accessibility".into(),
        });
        assert!(message.contains("辅助功能"));
        assert!(message.contains("ClawMaster"));
        assert!(message.contains("重新启动"));
        assert!(!message.contains("cliclick"));
    }

    #[test]
    fn native_input_fails_closed_when_accessibility_is_not_trusted() {
        assert!(validate_native_input_permission(true).is_ok());
        let message = validate_native_input_permission(false).unwrap_err();
        assert!(message.contains("辅助功能"));
        assert!(message.contains("键盘和鼠标"));
        assert!(message.contains("重新启动"));
    }

    #[test]
    fn manifest_tools_exist_in_the_native_agent_catalog() {
        let definitions = crate::native_agent_tools::definitions()
            .into_iter()
            .chain(crate::native_rpa::definitions())
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        for capability in capability_manifest()["capabilities"].as_array().unwrap() {
            assert!(
                definitions
                    .iter()
                    .any(|name| Some(name.as_str()) == capability["tool"].as_str()),
                "unknown native tool: {}",
                capability["tool"]
            );
        }
    }

    #[test]
    fn manifest_declares_real_native_replacements() {
        let value = capability_manifest();
        let ids = value["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|capability| capability["id"].as_str())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"desktop.input"));
        assert!(ids.contains(&"pdf.merge"));
        assert!(ids.contains(&"pdf.optimize"));
        assert!(ids.contains(&"chart.svg"));
        assert!(ids.contains(&"slides.pptx"));
        assert!(ids.contains(&"document.docx"));
        let slides = value["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|capability| capability["id"] == "slides.pptx")
            .unwrap();
        assert_eq!(slides["provider"], "rust:zip+xml");
        let chart = value["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|capability| capability["id"] == "chart.svg")
            .unwrap();
        assert_eq!(chart["provider"], "rust:svg");
    }

    fn write_test_pdf(path: &Path, text: &str) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 18.into()]),
                Operation::new("Td", vec![20.into(), 100.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id =
            document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Contents" => content_id,
            "Resources" => resources_id,
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id =
            document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog_id);
        document.compress();
        document.save(path).unwrap();
    }

    #[test]
    fn rust_pdf_provider_merges_real_pages() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-lopdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let first = directory.join("first.pdf");
        let second = directory.join("second.pdf");
        let output = directory.join("merged.pdf");
        write_test_pdf(&first, "first");
        write_test_pdf(&second, "second");
        merge_pdfs(
            &output,
            &[
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!(Document::load(&output).unwrap().get_pages().len(), 2);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn rust_pdf_provider_optimizes_to_a_readable_pdf() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-pdf-optimize-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let input = directory.join("input.pdf");
        let output = directory.join("optimized.pdf");
        write_test_pdf(&input, "optimized");
        optimize_pdf(&output, &input).unwrap();
        assert_eq!(Document::load(&output).unwrap().get_pages().len(), 1);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn rust_docx_provider_writes_openxml_package() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-docx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let request = directory.join("request.json");
        let output = directory.join("report.docx");
        std::fs::write(
            &request,
            serde_json::to_vec(&serde_json::json!({
                "title": "周报",
                "author": "林一",
                "department": "研发部",
                "format": "report",
                "content": "# 进展\n\n- <原生&能力>\u{1}",
            }))
            .unwrap(),
        )
        .unwrap();
        write_docx(&output, &request).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut document_xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document_xml)
            .unwrap();
        assert!(document_xml.contains("&lt;原生&amp;能力&gt;"));
        assert!(!document_xml.contains('\u{1}'));
        assert!(archive.by_name("word/styles.xml").is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn rust_pptx_provider_writes_editable_openxml_slides() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-pptx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let output = directory.join("briefing.pptx");
        write_pptx_content(
            &output,
            "季度进展",
            "研发部",
            "# 第一阶段\n\n- Rust 原生能力\n- 可编辑文本\n\n---\n\n# 下一步\n\n完成发布验收",
        )
        .unwrap();

        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut first_slide = String::new();
        archive
            .by_name("ppt/slides/slide1.xml")
            .unwrap()
            .read_to_string(&mut first_slide)
            .unwrap();
        assert!(first_slide.contains("第一阶段"));
        assert!(first_slide.contains("Rust 原生能力"));
        assert!(archive.by_name("ppt/slides/slide2.xml").is_ok());
        assert!(archive.by_name("ppt/presentation.xml").is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
