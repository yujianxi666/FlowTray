//! Log redaction. FlowTray never logs clipboard contents or full paths, so every
//! string that reaches the logger passes through these helpers first.

use serde_json::{Map, Value};

const SENSITIVE_KEYS: &[&str] = &[
    "content",
    "text",
    "textcontent",
    "html",
    "htmlcontent",
    "clipboard",
    "clipboardtext",
    "body",
    "preview",
    "url",
    "path",
    "refpath",
    "originalpath",
];

fn is_drive_start(bytes: &[char], index: usize) -> bool {
    index + 2 < bytes.len()
        && bytes[index].is_ascii_alphabetic()
        && bytes[index + 1] == ':'
        && (bytes[index + 2] == '\\' || bytes[index + 2] == '/')
}

pub fn redact_string(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if is_drive_start(&chars, index) {
            let mut end = index;
            while end < chars.len() {
                let ch = chars[end];
                if ch.is_whitespace()
                    || ch == '|'
                    || ch == '"'
                    || ch == '<'
                    || ch == '>'
                    || ch == ';'
                    || ch == ','
                {
                    break;
                }
                end += 1;
            }
            out.push_str("<path>");
            index = end;
            continue;
        }
        let ch = chars[index];
        if ch == '@' {
            // Expand over the e-mail shaped run around the at-sign.
            let mut start = index;
            while start > 0 {
                let prev = chars[start - 1];
                if prev.is_alphanumeric() || matches!(prev, '.' | '_' | '%' | '+' | '-') {
                    start -= 1;
                } else {
                    break;
                }
            }
            let mut end = index + 1;
            while end < chars.len() {
                let next = chars[end];
                if next.is_alphanumeric() || matches!(next, '.' | '-' | '_') {
                    end += 1;
                } else {
                    break;
                }
            }
            if end > index + 1 && start < index {
                out.push_str("<email>");
                index = end;
                continue;
            }
        }
        out.push(ch);
        index += 1;
    }
    out
}

pub fn redact_value(value: &Value, depth: usize) -> Value {
    if depth > 4 {
        return Value::String("<deep>".into());
    }
    match value {
        Value::String(text) => Value::String(redact_string(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(40)
                .map(|entry| redact_value(entry, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let mut result = Map::new();
            for (key, entry) in map.iter().take(40) {
                if SENSITIVE_KEYS.contains(&key.to_lowercase().as_str()) {
                    result.insert(key.clone(), Value::String("<redacted>".into()));
                } else {
                    result.insert(key.clone(), redact_value(entry, depth + 1));
                }
            }
            Value::Object(result)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_windows_paths_and_emails() {
        let text = redact_string(r"C:\Users\me\secret.docx from me@example.com");
        assert!(text.contains("<path>"));
        assert!(text.contains("<email>"));
        assert!(!text.contains("secret.docx"));
    }

    #[test]
    fn redacts_sensitive_keys() {
        let value = serde_json::json!({ "text": "hello", "count": 2 });
        let redacted = redact_value(&value, 0);
        assert_eq!(redacted["text"], Value::String("<redacted>".into()));
        assert_eq!(redacted["count"], Value::from(2));
    }
}
