use serde_json::{Map, Value};
use flate2::read::GzDecoder;
use std::io::Read;

use crate::error::{AppError, Result};
use super::schema::Constructor;

// Magic constructor IDs from the TL protocol
const GZIP_PACKED: i32 = 0x3072cfa1_u32 as i32;  // signals: next is gzip-compressed data
const VECTOR_ID:   i32 = 0x1cb5c415_u32 as i32;   // signals: next is a vector/array

pub struct TlDeserializer<'a> {
    data:    &'a [u8],  // the binary data we're reading (borrowed reference)
    offset:  usize,      // current read position
    mtproto: bool,       // which schema section to use for lookups
}
// This prevents use-after-free bugs at compile time

impl<'a> TlDeserializer<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0, mtproto: true }
    }

    // Read 4 bytes as little-endian i32 and advance offset
    fn read_i32(&mut self) -> Result<i32> {
        if self.offset + 4 > self.data.len() {
            return Err(AppError::Deserialization("buffer underflow reading i32".into()));
        }
        // try_into() converts &[u8] → [u8; 4] (fixed-size array)
        let v = i32::from_le_bytes(
            self.data[self.offset..self.offset + 4].try_into().unwrap()
        );
        self.offset += 4;
        Ok(v)
    }

    pub fn fetch_int(&mut self) -> Result<i32> {
        self.read_i32()
    }

    // Long: read lo-32 then hi-32, combine into i64
    pub fn fetch_long(&mut self) -> Result<String> {
        let lo = self.read_i32()? as u32 as i64;
        let hi = self.read_i32()? as u32 as i64;
        let v: i64 = (hi << 32) | lo;
        Ok(v.to_string())  // return as string (big integers need string representation in JSON)
    }

    pub fn fetch_double(&mut self) -> Result<f64> {
        if self.offset + 8 > self.data.len() {
            return Err(AppError::Deserialization("buffer underflow reading double".into()));
        }
        let v = f64::from_le_bytes(
            self.data[self.offset..self.offset + 8].try_into().unwrap()
        );
        self.offset += 8;
        Ok(v)
    }

    // Read the TL length prefix (1 or 4 bytes depending on size)
    fn read_tl_length(&mut self) -> Result<usize> {
        if self.offset >= self.data.len() {
            return Err(AppError::Deserialization("buffer underflow reading TL length".into()));
        }
        let b0 = self.data[self.offset] as usize;
        self.offset += 1;

        if b0 == 254 {
            // Large string: next 3 bytes are the real length
            if self.offset + 3 > self.data.len() {
                return Err(AppError::Deserialization("buffer underflow reading long TL length".into()));
            }
            let len = (self.data[self.offset]     as usize)
                | ((self.data[self.offset + 1] as usize) << 8)
                | ((self.data[self.offset + 2] as usize) << 16);
            self.offset += 3;
            Ok(len)
        } else {
            Ok(b0)  // Small string: b0 IS the length
        }
    }

    pub fn fetch_string(&mut self) -> Result<String> {
        let len = self.read_tl_length()?;
        if self.offset + len > self.data.len() {
            return Err(AppError::Deserialization("buffer underflow reading string".into()));
        }
        let bytes = &self.data[self.offset..self.offset + len];
        self.offset += len;
        // Skip padding bytes to reach 4-byte boundary
        while self.offset % 4 != 0 {
            self.offset += 1;
        }
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }

    pub fn fetch_bytes(&mut self) -> Result<Vec<u8>> {
        let len = self.read_tl_length()?;
        if self.offset + len > self.data.len() {
            return Err(AppError::Deserialization("buffer underflow reading bytes".into()));
        }
        let bytes = self.data[self.offset..self.offset + len].to_vec();
        self.offset += len;
        while self.offset % 4 != 0 {
            self.offset += 1;
        }
        Ok(bytes)
    }

    fn fetch_int_bytes(&mut self, bits: usize) -> Result<Value> {
        let len = bits / 8;
        if self.offset + len > self.data.len() {
            return Err(AppError::Deserialization(
                format!("buffer underflow reading int{bits}")
            ));
        }
        let arr: Vec<Value> = self.data[self.offset..self.offset + len]
            .iter()
            .map(|&b| Value::Number(b.into()))
            .collect();
        self.offset += len;
        Ok(Value::Array(arr))
    }

    // Main dispatch: given a type name, read the appropriate bytes
    pub fn fetch_object(&mut self, ty: &str) -> Result<Value> {
        match ty {
            "#" | "int" => return Ok(Value::Number(self.fetch_int()?.into())),
            "long"      => return Ok(Value::String(self.fetch_long()?)),
            "int128"    => return self.fetch_int_bytes(128),
            "int256"    => return self.fetch_int_bytes(256),
            "int512"    => return self.fetch_int_bytes(512),
            "string"    => return Ok(Value::String(self.fetch_string()?)),
            "bytes"     => {
                let b = self.fetch_bytes()?;
                let arr: Vec<Value> = b.into_iter().map(|x| Value::Number(x.into())).collect();
                return Ok(Value::Array(arr));
            }
            "double"    => {
                let f = self.fetch_double()?;
                return Ok(Value::Number(
                    serde_json::Number::from_f64(f).unwrap()
                ));
            }
            "Bool" => {
                let i = self.read_i32()? as u32;
                return match i {
                    0x997275b5 => Ok(Value::Bool(true)),
                    0xbc799737 => Ok(Value::Bool(false)),
                    _ => {
                        self.offset -= 4;  // "unread" the 4 bytes
                        self.fetch_object("Object")
                    }
                };
            }
            "true" => return Ok(Value::Bool(true)),
            _ => {}
        }

        // Vector type
        if ty.starts_with("Vector<") || ty.starts_with("vector<") {
            return self.fetch_vector(ty);
        }

        // Bare type ("%TypeName")
        if let Some(bare_type) = ty.strip_prefix('%') {
            return self.fetch_bare_type(bare_type);
        }

        // Lowercase first char = bare struct (look up by predicate directly)
        if ty.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false) {
            let is_namespaced_abstract = ty.contains('.')
                && ty.rsplit('.').next()
                .and_then(|local| local.chars().next())
                .map(|c| c.is_ascii_uppercase())
                .unwrap_or(false);
            if !is_namespaced_abstract {
                return self.fetch_by_predicate(ty);
            }
        }

        // Otherwise: read constructor ID from stream, look it up in schema
        self.fetch_by_id(ty)
    }

    fn fetch_vector(&mut self, ty: &str) -> Result<Value> {
        let is_boxed = ty.starts_with("Vector<");
        if is_boxed {
            let cid = self.read_i32()?;
            if cid == GZIP_PACKED {
                let decompressed = self.decompress()?;
                let mut inner = TlDeserializer::new(&decompressed);
                inner.mtproto = self.mtproto;
                return inner.fetch_object(ty);
            }
            if cid != VECTOR_ID {
                return Err(AppError::Deserialization(
                    format!("invalid vector constructor {cid:#010x}")
                ));
            }
        }
        let count     = self.read_i32()? as usize;
        let item_type = &ty[7..ty.len() - 1];
        let mut result = Vec::with_capacity(count);
        for _ in 0..count {
            result.push(self.fetch_object(item_type)?);
        }
        Ok(Value::Array(result))
    }

    fn fetch_bare_type(&mut self, base_type: &str) -> Result<Value> {
        let constructor = self.find_constructor_by_type(base_type)
            .ok_or_else(|| AppError::Deserialization(
                format!("no constructor for type '{base_type}'")
            ))?;
        self.decode_constructor(&constructor, false)
    }

    fn fetch_by_predicate(&mut self, predicate: &str) -> Result<Value> {
        let constructor = self.find_constructor_by_predicate(predicate)
            .ok_or_else(|| AppError::Deserialization(
                format!("no constructor for predicate '{predicate}'")
            ))?;
        self.decode_constructor(&constructor, false)
    }

    fn fetch_by_id(&mut self, _ty: &str) -> Result<Value> {
        let raw_id = self.read_i32()?;

        if raw_id == GZIP_PACKED {
            let decompressed = self.decompress()?;
            let mut inner    = TlDeserializer::new(&decompressed);
            inner.mtproto    = self.mtproto;
            return inner.fetch_object(_ty);
        }

        let (constructor, was_fallback) = self.find_by_id(raw_id)
            .ok_or_else(|| AppError::Deserialization(
                format!("unknown constructor id {raw_id:#010x}")
            ))?;

        let saved_mtproto = self.mtproto;
        if was_fallback { self.mtproto = false; }
        let result = self.decode_constructor(&constructor, false);
        if was_fallback { self.mtproto = saved_mtproto; }
        result
    }

    // Decode a constructor's fields into a JSON object
    fn decode_constructor(&mut self, constructor: &Constructor, _bare: bool) -> Result<Value> {
        let predicate = constructor.name().to_string();
        let params    = constructor.params.clone();

        // serde_json::Map = ordered map (JSON object)
        let mut map = Map::new();
        map.insert("_".to_string(), Value::String(predicate));

        for param in &params {
            let ptype = &param.ty;

            // "#" type = flags integer, also populate pFlags
            if ptype == "#" {
                let flags = self.fetch_int()? as u32;
                map.insert(param.name.clone(), Value::Number(flags.into()));
                // pFlags = a sub-object where each set bit becomes a boolean
                map.entry("pFlags").or_insert_with(|| Value::Object(Map::new()));
                continue;
            }

            // Conditional field ("flags.N?Type")
            if let Some(cond_pos) = ptype.find('?') {
                let cond      = &ptype[..cond_pos];
                let real_type = &ptype[cond_pos + 1..];

                let mut parts  = cond.splitn(2, '.');
                let flag_field = parts.next().unwrap_or("flags");
                let bit: u32   = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);

                let flags = map.get(flag_field).and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                if (flags & (1 << bit)) == 0 {
                    continue;  // field not present
                }

                if real_type == "true" {
                    // Set a boolean in pFlags
                    if let Some(Value::Object(pf)) = map.get_mut("pFlags") {
                        pf.insert(param.name.clone(), Value::Bool(true));
                    }
                    continue;
                }

                let value = self.fetch_object(real_type)?;
                map.insert(param.name.clone(), value);
            } else {
                // Unconditional field
                let value = self.fetch_object(ptype)?;
                map.insert(param.name.clone(), value);
            }
        }

        Ok(Value::Object(map))
    }

    // Decompress gzip data and return raw bytes
    fn decompress(&mut self) -> Result<Vec<u8>> {
        let compressed = self.fetch_bytes_raw()?;
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out)
            .map_err(|e| AppError::Deserialization(format!("gzip decompress failed: {e}")))?;
        Ok(out)
    }

    fn fetch_bytes_raw(&mut self) -> Result<Vec<u8>> {
        let len = self.read_tl_length()?;
        if self.offset + len > self.data.len() {
            return Err(AppError::Deserialization("buffer underflow reading raw bytes".into()));
        }
        let b = self.data[self.offset..self.offset + len].to_vec();
        self.offset += len;
        while self.offset % 4 != 0 { self.offset += 1; }
        Ok(b)
    }

    // Schema lookup helpers
    fn current_schema_section<'s>(
        &self,
        schema: &'s super::schema::Schema,
    ) -> &'s super::schema::SchemaSection {
        if self.mtproto { &schema.mtproto } else { &schema.api }
    }

    fn find_constructor_by_type(&self, ty: &str) -> Option<Constructor> {
        crate::SCHEMA.get().and_then(|s| {
            let section = self.current_schema_section(s);
            section.constructors.iter().find(|c| c.ty == ty).cloned()
        })
    }

    fn find_constructor_by_predicate(&self, pred: &str) -> Option<Constructor> {
        crate::SCHEMA.get().and_then(|s| {
            let section = self.current_schema_section(s);
            section.constructors.iter().find(|c| c.name() == pred).cloned()
        })
    }

    fn find_by_id(&self, id: i32) -> Option<(Constructor, bool)> {
        crate::SCHEMA.get().and_then(|s| {
            if let Some(c) = s.mtproto_by_id.get(&(id as i64)) {
                return Some((c.clone(), false));
            }
            if let Some(m) = s.mtproto_method_by_id.get(&(id as i64)) {
                return Some((Constructor {
                    id: m.id,
                    predicate: String::new(),
                    method:    m.method.clone(),
                    params:    m.params.clone(),
                    ty:        m.ty.clone(),
                }, false));
            }
            if let Some(c) = s.api_by_id.get(&(id as i64)) {
                return Some((c.clone(), true));
            }
            if let Some(m) = s.api.methods.iter().find(|m| m.id == id as i64) {
                return Some((Constructor {
                    id: m.id,
                    predicate: String::new(),
                    method:    m.method.clone(),
                    params:    m.params.clone(),
                    ty:        m.ty.clone(),
                }, true));
            }
            None
        })
    }
}

// Public entry point
pub fn fetch_object(data: &[u8], ty: &str) -> Result<Value> {
    let mut de = TlDeserializer::new(data);
    de.fetch_object(ty)
}