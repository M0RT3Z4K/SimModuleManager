use serde_json::Value;
use crate::error::{AppError, Result};
use super::schema::Schema;

pub struct TlSerializer {
    buf: Vec<u8>,  // Vec<u8> = a growable array of bytes (like Python's bytearray)
}

impl TlSerializer {
    pub fn new() -> Self {
        // Vec::with_capacity pre-allocates 2048 bytes to avoid reallocations
        Self { buf: Vec::with_capacity(2048) }
    }

    // Consume self and return the bytes (moves ownership out)
    pub fn finish(self) -> Vec<u8> {
        self.buf
    }

    // ── Low-level write helpers ──────────────────────────────────────────────

    fn write_int(&mut self, v: i32) {
        // to_le_bytes() = to little-endian bytes (array of 4 bytes)
        // extend_from_slice() = append all bytes to buf
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    fn write_uint(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn store_int(&mut self, v: i32) {
        self.write_int(v);
    }

    pub fn store_bool(&mut self, v: bool) {
        // Telegram/Eitaa uses magic numbers for bool
        // 0x997275b5 = boolTrue, 0xbc799737 = boolFalse
        if v {
            self.write_uint(0x997275b5);
        } else {
            self.write_uint(0xbc799737);
        }
    }

    // Long (i64) is stored as: low 32 bits first, then high 32 bits
    // This is a quirk of the TL protocol
    pub fn store_long(&mut self, s: &str) -> Result<()> {
        // parse() converts a string → number
        // map_err converts the parse error → our AppError
        let v: i64 = s.parse().map_err(|_| {
            AppError::Serialization(format!("cannot parse long: {s}"))
        })?;

        let lo = (v & 0xffff_ffff) as u32;         // bottom 32 bits
        let hi = ((v >> 32) & 0xffff_ffff) as u32;  // top 32 bits

        self.buf.extend_from_slice(&lo.to_le_bytes());
        self.buf.extend_from_slice(&hi.to_le_bytes());
        Ok(())
    }

    pub fn store_double(&mut self, f: f64) {
        self.buf.extend_from_slice(&f.to_le_bytes());
    }

    // TL string encoding:
    //   If length ≤ 253: 1 byte for length, then bytes, then 0-padding to 4-byte boundary
    //   If length > 253: 1 byte (254), then 3 bytes for length, then bytes, then padding
    pub fn store_string(&mut self, s: &str) {
        self.store_bytes_raw(s.as_bytes());
    }

    fn store_bytes_raw(&mut self, bytes: &[u8]) {
        let len = bytes.len();
        if len <= 253 {
            self.buf.push(len as u8);  // single byte length prefix
        } else {
            self.buf.push(254);         // signal: next 3 bytes are the length
            self.buf.push((len & 0xff) as u8);
            self.buf.push(((len >> 8) & 0xff) as u8);
            self.buf.push(((len >> 16) & 0xff) as u8);
        }
        self.buf.extend_from_slice(bytes);
        // Pad to 4-byte boundary with zeros
        while self.buf.len() % 4 != 0 {
            self.buf.push(0);
        }
    }

    // Bytes from JSON: the Python side sends bytes as an array of numbers [72, 101, 108, 108, 111]
    fn store_bytes_from_value(&mut self, val: &Value) -> Result<()> {
        match val {
            // Array of numbers → collect as bytes
            Value::Array(arr) => {
                let bytes: Result<Vec<u8>> = arr.iter()
                    .map(|v| {
                        v.as_u64()
                            .map(|n| n as u8)
                            .ok_or_else(|| AppError::Serialization(
                                "bytes array element is not a number".into()
                            ))
                    })
                    .collect();
                self.store_bytes_raw(&bytes?);
                Ok(())
            }
            // String → treat as UTF-8 bytes
            Value::String(s) => {
                self.store_bytes_raw(s.as_bytes());
                Ok(())
            }
            // Null → empty bytes
            Value::Null => {
                self.store_bytes_raw(&[]);
                Ok(())
            }
            _ => Err(AppError::Serialization(
                format!("expected bytes array, got {val}")
            )),
        }
    }

    // int128/256/512: fixed number of bytes, stored verbatim (no length prefix, no padding)
    fn store_int_bytes(&mut self, bits: usize, val: &Value) -> Result<()> {
        let len = bits / 8;
        match val {
            Value::Array(arr) => {
                if arr.len() != len {
                    return Err(AppError::Serialization(
                        format!("int{bits} expects {len} bytes, got {}", arr.len())
                    ));
                }
                for v in arr {
                    let b = v.as_u64()
                        .ok_or_else(|| AppError::Serialization(
                            "int bytes element not a number".into()
                        ))? as u8;
                    self.buf.push(b);
                }
                Ok(())
            }
            _ => Err(AppError::Serialization(format!("expected array for int{bits}"))),
        }
    }

    // ── Main dispatch: JSON Value + type name → binary bytes ─────────────────

    pub fn store_object(&mut self, val: &Value, ty: &str, schema: &Schema) -> Result<()> {
        // Match on the type name string
        match ty {
            "#" | "int" => {
                let n = value_to_i32(val)?;
                self.store_int(n);
                return Ok(());
            }
            "long" => {
                let s = value_to_long_str(val)?;
                return self.store_long(&s);
            }
            "int128" => return self.store_int_bytes(128, val),
            "int256" => return self.store_int_bytes(256, val),
            "int512" => return self.store_int_bytes(512, val),
            "string" => {
                let s = val.as_str().unwrap_or("");
                self.store_string(s);
                return Ok(());
            }
            "bytes" => return self.store_bytes_from_value(val),
            "double" => {
                let f = val.as_f64()
                    .ok_or_else(|| AppError::Serialization("expected double".into()))?;
                self.store_double(f);
                return Ok(());
            }
            "Bool" => {
                let b = val.as_bool()
                    .ok_or_else(|| AppError::Serialization("expected bool".into()))?;
                self.store_bool(b);
                return Ok(());
            }
            "true" => return Ok(()),  // conditional flag — no bytes, just presence
            _ => {}
        }

        // Vector type (e.g. "Vector<User>", "vector<string>")
        if ty.starts_with("Vector<") || ty.starts_with("vector<") {
            let is_boxed = ty.starts_with("Vector<");  // capital V = write constructor ID
            // Strip "Vector<" prefix and ">" suffix to get item type
            let item_type = &ty[7..ty.len() - 1];

            let arr = val.as_array().ok_or_else(|| {
                AppError::Serialization(format!("expected array for {ty}"))
            })?;

            if is_boxed {
                self.write_uint(0x1cb5c415);  // Vector constructor magic ID
            }
            self.write_int(arr.len() as i32);

            for item in arr {
                self.store_object(item, item_type, schema)?;
            }
            return Ok(());
        }

        // Bare type prefix '%' = don't write the constructor ID
        let (bare, effective_ty) = if ty.starts_with('%') {
            (true, &ty[1..])
        } else {
            (false, ty)
        };

        // Object: look up the constructor by the "_" predicate field
        // In our protocol, every object has "_" = "predicateName"
        let obj = val.as_object().ok_or_else(|| {
            AppError::Serialization(format!("expected object for type {effective_ty}"))
        })?;

        let predicate = obj.get("_")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Serialization("object missing '_' predicate".into()))?;

        let constructor = schema.find_constructor_by_predicate(predicate)
            .ok_or_else(|| AppError::Serialization(
                format!("no constructor for predicate '{predicate}'")
            ))?;

        // Do we write the constructor ID?
        let skip_id = bare || predicate == effective_ty;
        if !skip_id {
            // Reinterpret the i64 ID as u32 (sign-extend trick matching JS behavior)
            let uid = constructor.id as i32 as u32;
            self.write_uint(uid);
        }

        // Write each parameter
        let params = constructor.params.clone();
        for param in &params {
            let ptype = &param.ty;

            // Conditional field: format is "flags.N?Type"
            // Example: "flags.0?string" = present only if bit 0 of flags is set
            if let Some(cond_pos) = ptype.find('?') {
                let cond      = &ptype[..cond_pos];
                let real_type = &ptype[cond_pos + 1..];

                // Parse "flags.0" into ("flags", 0)
                let mut parts     = cond.splitn(2, '.');
                let flag_field    = parts.next().unwrap_or("flags");
                let bit: u32      = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);

                // Read the flags integer from the object
                let flags = obj.get(flag_field).and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                // Skip this field if the bit is not set
                if (flags & (1 << bit)) == 0 {
                    continue;
                }

                let field_val = obj.get(&param.name).unwrap_or(&Value::Null);
                self.store_object(field_val, real_type, schema)?;
            } else {
                // Unconditional field
                let field_val = obj.get(&param.name).unwrap_or(&Value::Null);
                self.store_object(field_val, ptype, schema)?;
            }
        }

        Ok(())
    }

    // Entry point: serialize a method call (method ID + all params)
    pub fn store_method(method_name: &str, params: &Value, schema: &Schema) -> Result<Vec<u8>> {
        let mut s = TlSerializer::new();

        let method = schema.find_method(method_name)
            .ok_or_else(|| AppError::Serialization(
                format!("no method '{method_name}'")
            ))?;

        let uid = method.id as i32 as u32;
        s.write_uint(uid);

        let obj = params.as_object().ok_or_else(|| {
            AppError::Serialization("params must be an object".into())
        })?;

        let method_params = method.params.clone();
        for param in &method_params {
            let ptype = &param.ty;

            if let Some(cond_pos) = ptype.find('?') {
                let cond      = &ptype[..cond_pos];
                let real_type = &ptype[cond_pos + 1..];
                let mut parts = cond.splitn(2, '.');
                let flag_field = parts.next().unwrap_or("flags");
                let bit: u32   = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let flags      = obj.get(flag_field).and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                if (flags & (1 << bit)) == 0 {
                    continue;
                }
                let field_val = obj.get(&param.name).unwrap_or(&Value::Null);
                s.store_object(field_val, real_type, schema)?;
            } else {
                let field_val = obj.get(&param.name).unwrap_or(&Value::Null);
                s.store_object(field_val, ptype, schema)?;
            }
        }

        Ok(s.finish())
    }
}

// Prepare params: compute the "flags" bitmask before serialization.
// The TL protocol uses a single integer "flags" to indicate which optional
// fields are present. We compute this from what's actually in the JSON.
pub fn prepare_params(method_name: &str, params: &Value, schema: &Schema) -> Result<Value> {
    let method = match schema.find_method(method_name) {
        Some(m) => m,
        None    => return Ok(params.clone()),  // unknown method, pass through
    };

    let obj = match params.as_object() {
        Some(o) => o,
        None    => return Ok(params.clone()),
    };

    let mut result = obj.clone();
    let mut flags: u32 = 0;

    for param in &method.params {
        let ptype = &param.ty;
        if let Some(cond_pos) = ptype.find('?') {
            let cond = &ptype[..cond_pos];
            if let Some(dot) = cond.rfind('.') {
                let bit: u32 = cond[dot + 1..].parse().unwrap_or(0);
                // If this optional field is present and non-null, set its bit
                let present = obj.get(&param.name)
                    .map(|v| !v.is_null())
                    .unwrap_or(false);
                if present {
                    flags |= 1 << bit;
                }
            }
        }
    }

    result.insert("flags".to_string(), Value::Number(flags.into()));
    Ok(Value::Object(result))
}

// Helper: JSON Value → i32
fn value_to_i32(v: &Value) -> Result<i32> {
    match v {
        Value::Number(n) => n.as_i64()
            .map(|i| i as i32)
            .ok_or_else(|| AppError::Serialization("int out of range".into())),
        Value::String(s) => s.parse::<i32>()
            .map_err(|_| AppError::Serialization(format!("cannot parse int: {s}"))),
        Value::Null => Ok(0),
        _ => Err(AppError::Serialization(format!("expected int, got {v}"))),
    }
}

// Helper: JSON Value → String representation of a long
fn value_to_long_str(v: &Value) -> Result<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Null      => Ok("0".to_string()),
        _ => Err(AppError::Serialization(format!("expected long string, got {v}"))),
    }
}