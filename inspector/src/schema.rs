//! Minimal JSON Schema validator for the Enchanter event-bus wire format.
//!
//! Mirrors `src/observability/schema.ts` on the TS side. Loads
//! `docs/event-schema.json` at compile time via `include_str!`, parses it
//! once into a `serde_json::Value`, and offers `validate(value)` — the same
//! shape as the TS `validate(event)` function so the two sides log
//! consistent error paths.
//!
//! Hand-rolled — supports exactly the JSON Schema keywords this project's
//! schema uses: `type`, `properties`, `required`, `oneOf`, `enum`, `const`,
//! `minimum`, `$ref`, `additionalProperties`. Not a full draft 2020-12
//! validator. Intentional: "no new top-level dep" on either side of the wire.

use std::sync::OnceLock;

use serde_json::Value;

/// Embedded canonical schema. Path is relative to *this source file*
/// (`inspector/src/schema.rs` → `../../docs/event-schema.json`).
const SCHEMA_TEXT: &str = include_str!("../../docs/event-schema.json");

/// Validation error: human-readable reason + JSON Pointer path
/// (slash-joined) so logs like `at /payload/cost_usd` localize the failure.
#[derive(Debug, Clone)]
pub struct SchemaError {
    pub reason: String,
    pub path: Vec<String>,
}

impl SchemaError {
    pub fn pointer(&self) -> String {
        if self.path.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", self.path.join("/"))
        }
    }
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}", self.reason, self.pointer())
    }
}

impl std::error::Error for SchemaError {}

fn schema_root() -> &'static Value {
    static ROOT: OnceLock<Value> = OnceLock::new();
    ROOT.get_or_init(|| {
        serde_json::from_str::<Value>(SCHEMA_TEXT)
            .expect("event-schema.json failed to parse — this is a build-time invariant")
    })
}

fn definitions() -> &'static serde_json::Map<String, Value> {
    static DEFS: OnceLock<serde_json::Map<String, Value>> = OnceLock::new();
    DEFS.get_or_init(|| {
        schema_root()
            .get("definitions")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default()
    })
}

/// Resolve a `$ref` once. Returns the referenced node if the ref matches
/// `#/definitions/<name>` and the name exists; otherwise returns `node` as-is.
fn deref<'a>(node: &'a Value) -> &'a Value {
    if let Some(Value::String(r)) = node.get("$ref") {
        if let Some(name) = r.strip_prefix("#/definitions/") {
            if let Some(target) = definitions().get(name) {
                // definitions() is &'static, which outlives any 'a — the
                // narrower-lifetime coercion is sound.
                return target;
            }
        }
    }
    node
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_matches(declared: &str, actual: &str) -> bool {
    if declared == "integer" {
        return actual == "number";
    }
    declared == actual
}

fn fail(reason: impl Into<String>, path: &[String]) -> SchemaError {
    SchemaError {
        reason: reason.into(),
        path: path.to_vec(),
    }
}

fn check(node: &Value, value: &Value, path: &mut Vec<String>) -> Result<(), SchemaError> {
    let schema = deref(node);

    // const
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(fail(
                format!(
                    "expected const {}, got {}",
                    expected,
                    truncate_for_msg(value),
                ),
                path,
            ));
        }
    }

    // enum
    if let Some(Value::Array(variants)) = schema.get("enum") {
        if !variants.iter().any(|v| v == value) {
            return Err(fail(
                format!("value {} not in enum", truncate_for_msg(value)),
                path,
            ));
        }
    }

    // type
    if let Some(Value::String(declared)) = schema.get("type") {
        let actual = json_type(value);
        if !type_matches(declared, actual) {
            return Err(fail(
                format!("expected type {}, got {}", declared, actual),
                path,
            ));
        }
    }

    // minimum
    if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
        if let Some(n) = value.as_f64() {
            if n < min {
                return Err(fail(format!("value {} below minimum {}", n, min), path));
            }
        }
    }

    // object: required, properties, additionalProperties
    if let Value::Object(obj) = value {
        if let Some(Value::Array(required)) = schema.get("required") {
            for req in required {
                if let Some(key) = req.as_str() {
                    if !obj.contains_key(key) {
                        return Err(fail(format!("missing required field \"{}\"", key), path));
                    }
                }
            }
        }

        let properties = schema
            .get("properties")
            .and_then(Value::as_object);

        if let Some(props) = properties {
            for (key, sub_schema) in props {
                if let Some(child) = obj.get(key) {
                    path.push(key.clone());
                    let result = check(sub_schema, child, path);
                    path.pop();
                    result?;
                }
            }
        }

        if let Some(Value::Bool(false)) = schema.get("additionalProperties") {
            if let Some(props) = properties {
                for key in obj.keys() {
                    if !props.contains_key(key) {
                        return Err(fail(format!("unexpected field \"{}\"", key), path));
                    }
                }
            }
        }
    }

    // oneOf — first match wins. If none match, prefer the failure from the
    // branch whose `type` discriminator matched the input — that's the
    // "intended" branch. Fall back to deepest-path otherwise.
    if let Some(Value::Array(branches)) = schema.get("oneOf") {
        let mut best: Option<(SchemaError, bool)> = None;
        for branch in branches {
            match check(branch, value, path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let intended = branch_type_matches(deref(branch), value);
                    let replace = match &best {
                        None => true,
                        Some((b, b_intended)) => {
                            if intended && !*b_intended {
                                true
                            } else if intended == *b_intended {
                                e.path.len() > b.path.len()
                            } else {
                                false
                            }
                        }
                    };
                    if replace {
                        best = Some((e, intended));
                    }
                }
            }
        }
        return Err(best
            .map(|(e, _)| e)
            .unwrap_or_else(|| fail("no oneOf branch matched", path)));
    }

    Ok(())
}

/// Heuristic: does this branch's `type` discriminator (a const or an enum on
/// the `type` property) match the `type` field of the candidate object?
fn branch_type_matches(branch: &Value, value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let Some(t) = obj.get("type").and_then(Value::as_str) else {
        return false;
    };
    let Some(properties) = branch.get("properties").and_then(Value::as_object) else {
        return false;
    };
    let Some(type_schema) = properties.get("type") else {
        return false;
    };
    if let Some(Value::String(c)) = type_schema.get("const") {
        return c == t;
    }
    if let Some(Value::Array(variants)) = type_schema.get("enum") {
        return variants.iter().any(|v| v.as_str() == Some(t));
    }
    false
}

fn truncate_for_msg(value: &Value) -> String {
    let s = value.to_string();
    if s.len() <= 80 {
        s
    } else {
        format!("{}…", &s[..80])
    }
}

/// Validate an inbound event (the JSON object the Rust transport just
/// parsed). Mirrors the TS-side `validate(event)`.
pub fn validate(value: &Value) -> Result<(), SchemaError> {
    if !value.is_object() {
        return Err(fail(
            format!("expected object, got {}", json_type(value)),
            &[],
        ));
    }
    let mut path: Vec<String> = Vec::new();
    check(schema_root(), value, &mut path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn happy_path_runtime_metrics() {
        let v = json!({
            "type": "runtime.metrics",
            "time": 1.0,
            "open_sessions": 3,
            "ongoing_tasks": 5,
            "queued_tasks": 2,
            "blocked_tasks": 1,
            "code_written_lifetime_loc": 0,
            "code_modified_lifetime_loc": 0,
            "files_created_lifetime": 0,
            "files_modified_lifetime": 0,
            "tool_calls_lifetime": 0,
            "prs_created_lifetime": 0,
            "tests_run_lifetime": 0,
            "tests_passed_rate": 0.94,
            "total_spend_lifetime": 0.0
        });
        validate(&v).expect("should validate");
    }

    #[test]
    fn rejects_missing_required() {
        let v = json!({"type": "tool.call", "time": 1.0, "payload": {}});
        assert!(validate(&v).is_err());
    }

    #[test]
    fn rejects_bad_enum() {
        let v = json!({
            "type": "hydra.veto", "time": 1.0, "policy": "p", "reason": "r",
            "action": "a", "severity": "fatal", "payload": null
        });
        assert!(validate(&v).is_err());
    }

    #[test]
    fn rejects_unknown_discriminator() {
        let v = json!({"type": "totally.unknown", "time": 1.0});
        assert!(validate(&v).is_err());
    }
}
