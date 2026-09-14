use crate::native_tools;
use serde::{Deserialize, Serialize};
use xa11y::{App, AppExt, Element, Role};

const MAX_WINDOWS: usize = 80;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    #[serde(rename = "ref")]
    pub window_ref: String,
    app: String,
    title: Option<String>,
    process_id: Option<u32>,
    bounds: Option<WindowBounds>,
    foreground: bool,
    root: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowInventory {
    provider: String,
    reference_scope: String,
    windows: Vec<WindowEntry>,
    truncated: bool,
}

pub fn inventory() -> Result<WindowInventory, String> {
    let apps = App::list().map_err(map_accessibility_error)?;
    let mut windows = Vec::new();
    let mut truncated = false;
    for app in apps {
        if windows.len() >= MAX_WINDOWS {
            truncated = true;
            break;
        }
        append_windows(&app, &mut windows);
    }
    for (index, window) in windows.iter_mut().enumerate() {
        window.window_ref = format!("@w{}", index + 1);
    }
    Ok(WindowInventory {
        provider: "rust:xa11y".into(),
        reference_scope: "this-inventory-only".into(),
        windows,
        truncated,
    })
}

#[cfg(target_os = "windows")]
fn append_windows(app: &App, output: &mut Vec<WindowEntry>) {
    output.push(entry_for(app, &app.as_element(), true));
}

#[cfg(not(target_os = "windows"))]
fn append_windows(app: &App, output: &mut Vec<WindowEntry>) {
    let children = app.children().unwrap_or_default();
    let top_level = children
        .iter()
        .filter(|element| matches!(element.role, Role::Window | Role::Dialog))
        .collect::<Vec<_>>();
    if top_level.is_empty() {
        output.push(entry_for(app, &app.as_element(), true));
    } else {
        for element in top_level {
            if output.len() >= MAX_WINDOWS {
                break;
            }
            output.push(entry_for(app, element, false));
        }
    }
}

fn entry_for(app: &App, element: &Element, root: bool) -> WindowEntry {
    WindowEntry {
        window_ref: String::new(),
        app: app.name.chars().take(200).collect(),
        title: element
            .name
            .as_deref()
            .map(|value| value.chars().take(500).collect()),
        process_id: app.pid,
        bounds: element.bounds.map(|bounds| WindowBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        }),
        foreground: app.is_foreground() || element.states.active,
        root,
    }
}

pub fn snapshot(
    inventory: &WindowInventory,
    window_ref: &str,
) -> Result<serde_json::Value, String> {
    let (app, root, selected) = resolve(inventory, window_ref)?;
    Ok(native_tools::desktop_snapshot_for_element(
        &app,
        &root,
        selected.title.as_deref(),
    ))
}

pub fn screenshot_png(inventory: &WindowInventory, window_ref: &str) -> Result<Vec<u8>, String> {
    let (_app, root, _selected) = resolve(inventory, window_ref)?;
    xa11y::screenshot_element(&root)
        .and_then(|capture| capture.to_png())
        .map_err(|error| format!("截取目标窗口失败：{error}"))
}

pub fn window_center(inventory: &WindowInventory, window_ref: &str) -> Result<(i64, i64), String> {
    let (_app, root, _selected) = resolve(inventory, window_ref)?;
    let bounds = root
        .bounds
        .ok_or_else(|| "RPA 目标窗口没有可用的滚动坐标".to_string())?;
    Ok((
        i64::from(bounds.x) + i64::from(bounds.width) / 2,
        i64::from(bounds.y) + i64::from(bounds.height) / 2,
    ))
}

pub fn focus_window(inventory: &WindowInventory, window_ref: &str) -> Result<(), String> {
    let (_app, root, _selected) = resolve(inventory, window_ref)?;
    root.focus()
        .map_err(|error| format!("聚焦 RPA 目标窗口失败：{error}"))
}

pub fn contains_text(snapshot: &serde_json::Value, expected: &str) -> bool {
    let expected = expected.trim().to_lowercase();
    if expected.is_empty() {
        return false;
    }
    snapshot
        .get("elements")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .any(|element| {
            ["name", "value", "description"]
                .into_iter()
                .filter_map(|field| element.get(field).and_then(serde_json::Value::as_str))
                .any(|value| value.to_lowercase().contains(&expected))
        })
}

fn resolve<'a>(
    inventory: &'a WindowInventory,
    window_ref: &str,
) -> Result<(App, Element, &'a WindowEntry), String> {
    let selected = inventory
        .windows
        .iter()
        .find(|entry| entry.window_ref == window_ref)
        .ok_or_else(|| "RPA 窗口引用不属于绑定窗口清单".to_string())?;
    let apps = App::list().map_err(map_accessibility_error)?;
    let app = apps
        .into_iter()
        .find(|app| {
            app.pid == selected.process_id
                && app.name == selected.app
                && (!selected.root || element_matches(&app.as_element(), selected))
        })
        .ok_or_else(|| "RPA 目标窗口所属应用已关闭".to_string())?;
    let root = resolve_root(&app, selected)?;
    Ok((app, root, selected))
}

fn resolve_root(app: &App, selected: &WindowEntry) -> Result<Element, String> {
    if selected.root {
        return Ok(app.as_element());
    }
    app.children()
        .map_err(map_accessibility_error)?
        .into_iter()
        .find(|element| element_matches(element, selected))
        .ok_or_else(|| "RPA 目标窗口已变化，请重新获取窗口清单".to_string())
}

fn element_matches(element: &Element, selected: &WindowEntry) -> bool {
    matches!(
        element.role,
        Role::Window | Role::Dialog | Role::Application
    ) && element.name == selected.title
        && element.bounds.map(|bounds| WindowBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        }) == selected.bounds
}

fn map_accessibility_error(error: xa11y::Error) -> String {
    let detail = error.to_string();
    if detail.to_ascii_lowercase().contains("permission denied") {
        return format!("系统未授予 ClawMaster 辅助功能权限：{detail}");
    }
    format!("读取系统窗口失败：{detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_refs_are_scoped_and_not_raw_coordinates() {
        let inventory = WindowInventory {
            provider: "test".into(),
            reference_scope: "this-inventory-only".into(),
            windows: vec![WindowEntry {
                window_ref: "@w1".into(),
                app: "Browser".into(),
                title: Some("Checkout".into()),
                process_id: Some(42),
                bounds: Some(WindowBounds {
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                }),
                foreground: true,
                root: true,
            }],
            truncated: false,
        };
        let encoded = serde_json::to_value(inventory).unwrap();
        assert_eq!(encoded["windows"][0]["ref"], "@w1");
        assert_eq!(encoded["referenceScope"], "this-inventory-only");
    }

    #[test]
    fn wait_matching_searches_only_bounded_semantic_text() {
        let snapshot = serde_json::json!({"elements":[
            {"ref":"@e1","name":"提交订单","value":null,"description":null},
            {"ref":"@e2","name":"状态","value":"Ready","description":null}
        ]});
        assert!(contains_text(&snapshot, "提交"));
        assert!(contains_text(&snapshot, "ready"));
        assert!(!contains_text(&snapshot, "secret"));
        assert!(!contains_text(&snapshot, ""));
    }
}
