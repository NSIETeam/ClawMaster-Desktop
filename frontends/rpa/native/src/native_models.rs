use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::watch;
use url::Url;

const KEYRING_SERVICE: &str = "com.nsieteam.clawmaster.models";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModel {
    pub id: String,
    pub display_name: String,
    pub provider: String,
    pub base_url: String,
    pub model_id: String,
    pub max_tokens: Option<u32>,
    pub enabled: bool,
    pub credential_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelMessage {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCompletion {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub finish_reason: Option<String>,
    pub tool_calls: Vec<ModelToolCall>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelStreamEvent {
    Text(String),
    Reasoning(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamCompletion {
    Completed(ModelCompletion),
    Cancelled(ModelCompletion),
}

#[derive(Default)]
struct StreamState {
    text: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_tokens: u64,
    finish_reason: Option<String>,
    tool_calls: BTreeMap<String, PartialToolCall>,
}

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

impl StreamState {
    fn completion(self, fallback_reason: Option<&str>) -> Result<ModelCompletion, String> {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .map(|(key, call)| {
                let arguments = if call.arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&call.arguments).map_err(|error| {
                        format!("工具 {} 的参数不是有效 JSON: {error}", call.name)
                    })?
                };
                Ok(ModelToolCall {
                    id: if call.id.is_empty() {
                        format!("call-native-{key}-{}", call.name)
                    } else {
                        call.id
                    },
                    name: call.name,
                    arguments,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(ModelCompletion {
            text: self.text,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_tokens: self.cache_tokens,
            finish_reason: self
                .finish_reason
                .or_else(|| fallback_reason.map(str::to_owned)),
            tool_calls,
        })
    }
}

fn push_text(events: &mut Vec<ModelStreamEvent>, state: &mut StreamState, value: Option<&str>) {
    if let Some(delta) = value.filter(|delta| !delta.is_empty()) {
        state.text.push_str(delta);
        events.push(ModelStreamEvent::Text(delta.to_string()));
    }
}

fn push_reasoning(events: &mut Vec<ModelStreamEvent>, value: Option<&str>) {
    if let Some(delta) = value.filter(|delta| !delta.is_empty()) {
        events.push(ModelStreamEvent::Reasoning(delta.to_string()));
    }
}

impl NativeModel {
    pub fn public_value(&self) -> Value {
        json!({
            "id": self.id,
            "displayName": self.display_name,
            "provider": self.provider,
            "baseUrl": self.base_url,
            "modelId": self.model_id,
            "maxTokens": self.max_tokens,
            "enabled": self.enabled,
            "source": "byok",
            "managed": false,
        })
    }
}

pub trait CredentialStore: Send + Sync {
    fn set(&self, credential_id: &str, api_key: &str) -> Result<(), String>;
    fn get(&self, credential_id: &str) -> Result<String, String>;
    fn delete(&self, credential_id: &str) -> Result<(), String>;
}

pub struct KeyringCredentialStore {
    service: &'static str,
}

impl CredentialStore for KeyringCredentialStore {
    fn set(&self, credential_id: &str, api_key: &str) -> Result<(), String> {
        if api_key.trim().is_empty() {
            return Err("安全凭据不能为空".into());
        }
        keyring::Entry::new(self.service, credential_id)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))?
            .set_password(api_key)
            .map_err(|error| format!("无法保存安全凭据: {error}"))
    }

    fn get(&self, credential_id: &str) -> Result<String, String> {
        keyring::Entry::new(self.service, credential_id)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))?
            .get_password()
            .map_err(|_| "安全凭据不存在，请重新配置".to_string())
    }

    fn delete(&self, credential_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(self.service, credential_id)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法删除模型凭据: {error}")),
        }
    }
}

pub fn system_credential_store() -> Arc<dyn CredentialStore> {
    credential_store_for_service(KEYRING_SERVICE)
}

pub fn credential_store_for_service(service: &'static str) -> Arc<dyn CredentialStore> {
    Arc::new(KeyringCredentialStore { service })
}

pub(crate) fn validate_model_base_url(base_url: &str) -> Result<Url, String> {
    let base = Url::parse(base_url).map_err(|_| "模型 API 地址无效".to_string())?;
    let loopback_http = base.scheme() == "http"
        && base.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
    if (base.scheme() != "https" && !loopback_http)
        || !base.username().is_empty()
        || base.password().is_some()
    {
        return Err(
            "模型 API 公网地址必须使用 HTTPS，HTTP 仅限本机回环地址，且不得内嵌凭据".into(),
        );
    }
    Ok(base)
}

fn endpoint(base_url: &str, suffix: &str) -> Result<Url, String> {
    let mut base = validate_model_base_url(base_url)?;
    if base.path().ends_with(suffix) {
        return Ok(base);
    }
    let path = format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    );
    base.set_path(&path);
    Ok(base)
}

async fn checked_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取模型响应: {error}"))?;
    let value = serde_json::from_slice::<Value>(&bytes);
    if status.is_success() {
        return value.map_err(|error| format!("无法解析模型响应: {error}"));
    }
    let message = value
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "模型服务请求失败".to_string());
    Err(format!("模型服务返回 {}: {message}", status.as_u16()))
}

fn bounded_output_tokens(model: &NativeModel) -> u32 {
    model.max_tokens.unwrap_or(4096).clamp(1, 32_768)
}

fn message_values(messages: &[ModelMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|item| json!({"role":item.role,"content":item.text}))
        .collect()
}

fn openai_tools(tools: &[ModelToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({"type":"function","function":{
                "name":tool.name,"description":tool.description,"parameters":tool.parameters
            }})
        })
        .collect()
}

fn openai_chat_body(
    model: &NativeModel,
    messages: &[ModelMessage],
    tools: &[ModelToolDefinition],
) -> Value {
    let mut body = json!({
        "model":model.model_id,
        "messages":message_values(messages),
        "stream":true,
        "stream_options":{"include_usage":true},
        "max_tokens":bounded_output_tokens(model)
    });
    if !tools.is_empty() {
        body["tools"] = json!(openai_tools(tools));
    }
    body
}

fn openai_responses_body(
    model: &NativeModel,
    messages: &[ModelMessage],
    tools: &[ModelToolDefinition],
) -> Value {
    let mut body = json!({
        "model":model.model_id,
        "input":message_values(messages),
        "stream":true,
        "max_output_tokens":bounded_output_tokens(model)
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type":"function","name":tool.name,"description":tool.description,
                "parameters":tool.parameters,"strict":false
            }))
            .collect::<Vec<_>>());
    }
    body
}

fn anthropic_body(
    model: &NativeModel,
    messages: &[ModelMessage],
    tools: &[ModelToolDefinition],
) -> Value {
    let system = messages
        .iter()
        .filter(|item| item.role == "system")
        .map(|item| item.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut body = json!({
        "model":model.model_id,
        "max_tokens":bounded_output_tokens(model),
        "messages":messages.iter().filter(|item| item.role != "system")
            .map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),
        "stream":true
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "name":tool.name,"description":tool.description,"input_schema":tool.parameters
            }))
            .collect::<Vec<_>>());
    }
    body
}

fn gemini_body(
    model: &NativeModel,
    messages: &[ModelMessage],
    tools: &[ModelToolDefinition],
) -> Value {
    let system = messages
        .iter()
        .filter(|item| item.role == "system")
        .map(|item| item.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut body = json!({
        "contents":messages.iter().filter(|item| item.role != "system").map(|item| json!({
            "role":if item.role == "assistant" { "model" } else { "user" },
            "parts":[{"text":item.text}]
        })).collect::<Vec<_>>(),
        "generationConfig":{"maxOutputTokens":bounded_output_tokens(model)}
    });
    if !system.is_empty() {
        body["systemInstruction"] = json!({"parts":[{"text":system}]});
    }
    if !tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":tools.iter().map(|tool| json!({
            "name":tool.name,"description":tool.description,"parameters":tool.parameters
        })).collect::<Vec<_>>()}]);
    }
    body
}

fn parse_stream_data(
    provider: &str,
    data: &str,
    state: &mut StreamState,
) -> Result<Vec<ModelStreamEvent>, String> {
    if data == "[DONE]" {
        return Ok(Vec::new());
    }
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("无法解析模型流式响应: {error}"))?;
    let mut events = Vec::new();
    match provider {
        "openai" => {
            push_text(
                &mut events,
                state,
                value
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str),
            );
            push_reasoning(
                &mut events,
                value
                    .pointer("/choices/0/delta/reasoning_content")
                    .and_then(Value::as_str),
            );
            state.finish_reason = value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| state.finish_reason.take());
            state.input_tokens = value
                .pointer("/usage/prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(state.input_tokens);
            state.output_tokens = value
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(state.output_tokens);
            state.cache_tokens = value
                .pointer("/usage/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(state.cache_tokens);
            if let Some(calls) = value
                .pointer("/choices/0/delta/tool_calls")
                .and_then(Value::as_array)
            {
                for call in calls {
                    let key = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|index| format!("{index:08}"))
                        .unwrap_or_else(|| "00000000".into());
                    let partial = state.tool_calls.entry(key).or_default();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        partial.id.push_str(id);
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        partial.name.push_str(name);
                    }
                    if let Some(arguments) =
                        call.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        partial.arguments.push_str(arguments);
                    }
                }
            }
        }
        "openai-responses" => match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => push_text(
                &mut events,
                state,
                value.get("delta").and_then(Value::as_str),
            ),
            Some("response.reasoning_text.delta") => {
                push_reasoning(&mut events, value.get("delta").and_then(Value::as_str))
            }
            Some("response.completed") => {
                state.input_tokens = value
                    .pointer("/response/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.input_tokens);
                state.output_tokens = value
                    .pointer("/response/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.output_tokens);
                state.cache_tokens = value
                    .pointer("/response/usage/input_tokens_details/cached_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.cache_tokens);
                state.finish_reason = Some("stop".into());
            }
            Some("response.output_item.added")
                if value.pointer("/item/type").and_then(Value::as_str) == Some("function_call") =>
            {
                let key = value
                    .pointer("/item/id")
                    .and_then(Value::as_str)
                    .unwrap_or("0")
                    .to_string();
                let partial = state.tool_calls.entry(key).or_default();
                partial.id = value
                    .pointer("/item/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                partial.name = value
                    .pointer("/item/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                partial.arguments = value
                    .pointer("/item/arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            Some("response.function_call_arguments.delta") => {
                let key = value
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("0")
                    .to_string();
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    state
                        .tool_calls
                        .entry(key)
                        .or_default()
                        .arguments
                        .push_str(delta);
                }
            }
            Some("response.function_call_arguments.done") => {
                let key = value
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("0")
                    .to_string();
                if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
                    state.tool_calls.entry(key).or_default().arguments = arguments.to_string();
                }
            }
            _ => {}
        },
        "anthropic" => match value.get("type").and_then(Value::as_str) {
            Some("content_block_start")
                if value.pointer("/content_block/type").and_then(Value::as_str)
                    == Some("tool_use") =>
            {
                let key = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|index| format!("{index:08}"))
                    .unwrap_or_else(|| "00000000".into());
                let partial = state.tool_calls.entry(key).or_default();
                partial.id = value
                    .pointer("/content_block/id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                partial.name = value
                    .pointer("/content_block/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(input) = value.pointer("/content_block/input") {
                    if input.as_object().is_some_and(|object| !object.is_empty()) {
                        partial.arguments = input.to_string();
                    }
                }
            }
            Some("content_block_delta") => {
                match value.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => push_text(
                        &mut events,
                        state,
                        value.pointer("/delta/text").and_then(Value::as_str),
                    ),
                    Some("thinking_delta") => push_reasoning(
                        &mut events,
                        value.pointer("/delta/thinking").and_then(Value::as_str),
                    ),
                    Some("input_json_delta") => {
                        let key = value
                            .get("index")
                            .and_then(Value::as_u64)
                            .map(|index| format!("{index:08}"))
                            .unwrap_or_else(|| "00000000".into());
                        if let Some(delta) =
                            value.pointer("/delta/partial_json").and_then(Value::as_str)
                        {
                            state
                                .tool_calls
                                .entry(key)
                                .or_default()
                                .arguments
                                .push_str(delta);
                        }
                    }
                    _ => {}
                }
            }
            Some("message_start") => {
                state.input_tokens = value
                    .pointer("/message/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.input_tokens);
                state.cache_tokens = value
                    .pointer("/message/usage/cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.cache_tokens);
            }
            Some("message_delta") => {
                state.output_tokens = value
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.output_tokens);
                state.finish_reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| state.finish_reason.take());
            }
            _ => {}
        },
        "gemini" => {
            if let Some(parts) = value
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    push_text(&mut events, state, part.get("text").and_then(Value::as_str));
                    if let Some(call) = part.get("functionCall") {
                        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                        let key = format!("{}-{}", state.tool_calls.len(), name);
                        state.tool_calls.insert(
                            key,
                            PartialToolCall {
                                id: String::new(),
                                name: name.to_string(),
                                arguments: call
                                    .get("args")
                                    .map(Value::to_string)
                                    .unwrap_or_else(|| "{}".into()),
                            },
                        );
                    }
                }
            }
            state.input_tokens = value
                .pointer("/usageMetadata/promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(state.input_tokens);
            state.output_tokens = value
                .pointer("/usageMetadata/candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(state.output_tokens);
            state.cache_tokens = value
                .pointer("/usageMetadata/cachedContentTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(state.cache_tokens);
            state.finish_reason = value
                .pointer("/candidates/0/finishReason")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| state.finish_reason.take());
        }
        _ => return Err(format!("不支持的原生模型协议: {provider}")),
    }
    Ok(events)
}

fn consume_sse_buffer<F>(
    provider: &str,
    buffer: &mut String,
    state: &mut StreamState,
    on_event: &mut F,
) -> Result<(), String>
where
    F: FnMut(ModelStreamEvent) -> Result<(), String>,
{
    while let Some(boundary) = buffer.find("\n\n") {
        let block = buffer[..boundary].to_string();
        buffer.drain(..boundary + 2);
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        for event in parse_stream_data(provider, &data, state)? {
            on_event(event)?;
        }
    }
    Ok(())
}

fn consume_sse_bytes<F>(
    provider: &str,
    buffer: &mut Vec<u8>,
    state: &mut StreamState,
    on_event: &mut F,
) -> Result<(), String>
where
    F: FnMut(ModelStreamEvent) -> Result<(), String>,
{
    loop {
        let boundary = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| (index, 4))
            .or_else(|| {
                buffer
                    .windows(2)
                    .position(|window| window == b"\n\n")
                    .map(|index| (index, 2))
            });
        let Some((index, separator_len)) = boundary else {
            return Ok(());
        };
        let block = String::from_utf8(buffer[..index].to_vec())
            .map_err(|_| "模型流式响应不是有效 UTF-8".to_string())?;
        buffer.drain(..index + separator_len);
        let mut normalized = block.replace("\r\n", "\n");
        normalized.push_str("\n\n");
        consume_sse_buffer(provider, &mut normalized, state, on_event)?;
    }
}

pub async fn stream_complete<F>(
    client: &Client,
    model: &NativeModel,
    api_key: &str,
    messages: &[ModelMessage],
    tools: &[ModelToolDefinition],
    mut cancel: watch::Receiver<bool>,
    mut on_event: F,
) -> Result<StreamCompletion, String>
where
    F: FnMut(ModelStreamEvent) -> Result<(), String>,
{
    if *cancel.borrow() {
        return Ok(StreamCompletion::Cancelled(
            StreamState::default().completion(Some("cancelled"))?,
        ));
    }
    let response = match model.provider.as_str() {
        "openai" => client
            .post(endpoint(&model.base_url, "chat/completions")?)
            .bearer_auth(api_key)
            .json(&openai_chat_body(model, messages, tools))
            .send(),
        "openai-responses" => client
            .post(endpoint(&model.base_url, "responses")?)
            .bearer_auth(api_key)
            .json(&openai_responses_body(model, messages, tools))
            .send(),
        "anthropic" => client
            .post(endpoint(&model.base_url, "v1/messages")?)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&anthropic_body(model, messages, tools))
            .send(),
        "gemini" => {
            let suffix = format!("v1beta/models/{}:streamGenerateContent", model.model_id);
            let mut url = endpoint(&model.base_url, &suffix)?;
            url.query_pairs_mut().append_pair("alt", "sse");
            client
                .post(url)
                .header("x-goog-api-key", api_key)
                .json(&gemini_body(model, messages, tools))
                .send()
        }
        _ => return Err(format!("不支持的原生模型协议: {}", model.provider)),
    }
    .await
    .map_err(|error| format!("无法连接模型服务: {error}"))?;

    if !response.status().is_success() {
        return Err(checked_json(response)
            .await
            .err()
            .unwrap_or_else(|| "模型服务请求失败".into()));
    }
    let mut response = response;
    let mut buffer = Vec::new();
    let mut state = StreamState::default();
    loop {
        tokio::select! {
            changed = cancel.changed(), if cancel.has_changed().is_ok() => {
                if changed.is_ok() && *cancel.borrow() {
                    return Ok(StreamCompletion::Cancelled(state.completion(Some("cancelled"))?));
                }
            }
            chunk = response.chunk() => {
                match chunk.map_err(|error| format!("读取模型流式响应失败: {error}"))? {
                    Some(bytes) => {
                        buffer.extend_from_slice(&bytes);
                        consume_sse_bytes(&model.provider, &mut buffer, &mut state, &mut on_event)?;
                    }
                    None => break,
                }
            }
        }
    }
    if !buffer.is_empty() {
        buffer.extend_from_slice(b"\n\n");
        consume_sse_bytes(&model.provider, &mut buffer, &mut state, &mut on_event)?;
    }
    if state.text.is_empty() && state.tool_calls.is_empty() {
        return Err("模型流式响应缺少文本内容".into());
    }
    Ok(StreamCompletion::Completed(state.completion(None)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_model(provider: &str) -> NativeModel {
        NativeModel {
            id: "test".into(),
            display_name: "Test".into(),
            provider: provider.into(),
            base_url: "https://example.com".into(),
            model_id: "model-1".into(),
            max_tokens: Some(99_999),
            enabled: true,
            credential_id: "credential".into(),
        }
    }

    #[test]
    fn accepts_only_secure_credential_free_model_urls() {
        assert_eq!(
            endpoint("https://api.deepseek.com", "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.deepseek.com/chat/completions"
        );
        assert!(endpoint("http://api.example.com", "chat/completions").is_err());
        assert!(endpoint("https://user:key@example.com", "chat/completions").is_err());
        assert_eq!(
            endpoint("http://127.0.0.1:8787/v1", "chat/completions")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8787/v1/chat/completions"
        );
        assert!(endpoint("http://192.168.1.10:8787/v1", "chat/completions").is_err());
    }

    #[test]
    fn provider_bodies_preserve_system_instructions_and_token_budgets() {
        let messages = vec![
            ModelMessage {
                role: "system".into(),
                text: "Follow policy".into(),
            },
            ModelMessage {
                role: "user".into(),
                text: "Hello".into(),
            },
        ];
        let openai = openai_chat_body(&configured_model("openai"), &messages, &[]);
        assert_eq!(openai["max_tokens"], 32_768);
        assert_eq!(openai["messages"][0]["role"], "system");
        assert!(openai.get("tools").is_none());

        let responses =
            openai_responses_body(&configured_model("openai-responses"), &messages, &[]);
        assert_eq!(responses["max_output_tokens"], 32_768);
        assert!(responses.get("tools").is_none());

        let anthropic = anthropic_body(&configured_model("anthropic"), &messages, &[]);
        assert_eq!(anthropic["system"], "Follow policy");
        assert_eq!(anthropic["messages"].as_array().unwrap().len(), 1);
        assert!(anthropic.get("tools").is_none());

        let gemini = gemini_body(&configured_model("gemini"), &messages, &[]);
        assert_eq!(
            gemini["systemInstruction"]["parts"][0]["text"],
            "Follow policy"
        );
        assert_eq!(gemini["generationConfig"]["maxOutputTokens"], 32_768);
        assert_eq!(gemini["contents"].as_array().unwrap().len(), 1);
        assert!(gemini.get("tools").is_none());
    }

    #[test]
    fn parses_all_supported_stream_shapes() {
        let cases = [
            (
                "openai",
                r#"{"choices":[{"delta":{"content":"完成","reasoning_content":"分析"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}"#,
                "完成",
            ),
            (
                "openai-responses",
                r#"{"type":"response.output_text.delta","delta":"完成"}"#,
                "完成",
            ),
            (
                "anthropic",
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"完成"}}"#,
                "完成",
            ),
            (
                "gemini",
                r#"{"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}"#,
                "完成",
            ),
        ];
        for (provider, data, expected) in cases {
            let mut state = StreamState::default();
            let events = parse_stream_data(provider, data, &mut state).unwrap();
            assert_eq!(state.text, expected);
            assert!(events.contains(&ModelStreamEvent::Text(expected.into())));
        }
    }

    #[test]
    fn recorded_provider_fixtures_normalize_to_the_same_event_sequence() {
        let fixtures = [
            (
                "openai",
                include_str!("../fixtures/model-streams/openai-compatible.sse"),
            ),
            (
                "anthropic",
                include_str!("../fixtures/model-streams/anthropic.sse"),
            ),
            (
                "gemini",
                include_str!("../fixtures/model-streams/gemini.sse"),
            ),
        ];
        for (provider, fixture) in fixtures {
            let mut state = StreamState::default();
            let mut buffer = fixture.to_string();
            buffer.push_str("\n\n");
            let mut events = Vec::new();
            consume_sse_buffer(provider, &mut buffer, &mut state, &mut |event| {
                events.push(event);
                Ok(())
            })
            .unwrap();
            assert_eq!(
                events,
                vec![
                    ModelStreamEvent::Text("Claw".into()),
                    ModelStreamEvent::Text("Master".into()),
                ],
                "{provider}"
            );
            let completion = state.completion(None).unwrap();
            assert_eq!(completion.text, "ClawMaster", "{provider}");
            assert_eq!(completion.input_tokens, 7, "{provider}");
            assert_eq!(completion.output_tokens, 2, "{provider}");
            assert_eq!(completion.cache_tokens, 3, "{provider}");
        }
    }

    #[test]
    fn preserves_utf8_split_across_network_chunks_and_crlf_frames() {
        let payload =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"\xe5\xae\x8c\xe6\x88\x90\"}}]}\r\n\r\n";
        let split = payload.iter().position(|byte| *byte == 0xe6).unwrap() + 1;
        let mut buffer = payload[..split].to_vec();
        let mut state = StreamState::default();
        let mut events = Vec::new();
        consume_sse_bytes("openai", &mut buffer, &mut state, &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert!(events.is_empty());
        buffer.extend_from_slice(&payload[split..]);
        consume_sse_bytes("openai", &mut buffer, &mut state, &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert_eq!(state.text, "完成");
        assert_eq!(events, vec![ModelStreamEvent::Text("完成".into())]);
    }

    #[test]
    fn assembles_fragmented_tool_calls_for_every_provider() {
        let cases: [(&str, &[&str]); 4] = [
            (
                "openai",
                &[
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}"#,
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}"#,
                ],
            ),
            (
                "openai-responses",
                &[
                    r#"{"type":"response.output_item.added","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"read_file"}}"#,
                    r#"{"type":"response.function_call_arguments.done","item_id":"item_1","arguments":"{\"path\":\"a.txt\"}"}"#,
                ],
            ),
            (
                "anthropic",
                &[
                    r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"read_file"}}"#,
                    r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a.txt\"}"}}"#,
                ],
            ),
            (
                "gemini",
                &[
                    r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]}}]}"#,
                ],
            ),
        ];
        for (provider, chunks) in cases {
            let mut state = StreamState::default();
            for chunk in chunks {
                parse_stream_data(provider, chunk, &mut state).unwrap();
            }
            let completion = state.completion(None).unwrap();
            assert_eq!(completion.tool_calls.len(), 1, "{provider}");
            assert_eq!(completion.tool_calls[0].name, "read_file", "{provider}");
            assert_eq!(
                completion.tool_calls[0].arguments["path"], "a.txt",
                "{provider}"
            );
        }
    }

    #[tokio::test]
    async fn cancellation_before_dispatch_never_contacts_the_provider() {
        let (sender, receiver) = watch::channel(false);
        sender.send_replace(true);
        let model = NativeModel {
            id: "test".into(),
            display_name: "Test".into(),
            provider: "openai".into(),
            base_url: "https://unreachable.invalid".into(),
            model_id: "test".into(),
            max_tokens: None,
            enabled: true,
            credential_id: "none".into(),
        };
        let result = stream_complete(&Client::new(), &model, "unused", &[], &[], receiver, |_| {
            Ok(())
        })
        .await
        .unwrap();
        assert!(matches!(result, StreamCompletion::Cancelled(_)));
    }
}
