use serde::Deserialize;
// use std::collections::HashMap;
use std::collections::HashMap;
use ahash::RandomState;

// Param = one field in a TL constructor or method
// Example: {"name": "phone_number", "type": "string"}
#[derive(Debug, Clone, Deserialize)]
pub struct Param {
    pub name: String,
    #[serde(rename = "type")] // specs.json uses "type" but that's a Rust keyword!
    pub ty: String,
}

// Constructor = a TL data type (like a struct)
// Example: {"id": -1502141361, "predicate": "auth.sentCode", "params": [...], "type": "auth.SentCode"}
#[derive(Debug, Clone, Deserialize)]
pub struct Constructor {
    pub id: i64, // numeric type ID (used to identify the type in binary)

    #[serde(default)] // if "predicate" is missing in JSON, use ""
    pub predicate: String,

    #[serde(default)]
    pub method: String,

    #[serde(default)]
    pub params: Vec<Param>,

    #[serde(rename = "type")]
    pub ty: String,
}

impl Constructor {
    // A helper method: return the name (predicate is preferred over method)
    // "&self" means: takes a reference to self (doesn't consume it)
    // "-> &str" means: returns a string slice reference
    pub fn name(&self) -> &str {
        if !self.predicate.is_empty() {
            &self.predicate
        } else {
            &self.method
        }
    }
}

// Method = a TL RPC call (like a function)
// Example: {"id": -1502141361, "method": "auth.sendCode", "params": [...], "type": "auth.SentCode"}
#[derive(Debug, Clone, Deserialize)]
pub struct Method {
    pub id: i64,
    pub method: String,
    pub params: Vec<Param>,
    #[serde(rename = "type")]
    pub ty: String,
}

// SchemaSection = either the MTProto section or the API section of specs.json
#[derive(Debug, Clone, Deserialize)]
pub struct SchemaSection {
    pub constructors: Vec<Constructor>,
    pub methods: Vec<Method>,
}

// RawSchema = the top-level structure of specs.json
#[derive(Debug, Clone, Deserialize)]
pub struct RawSchema {
    #[serde(rename = "MTProto")] // JSON key is "MTProto"
    pub mtproto: SchemaSection,

    #[serde(rename = "API")] // JSON key is "API"
    pub api: SchemaSection,
}

pub struct Schema {
    pub mtproto:              SchemaSection,
    pub api:                  SchemaSection,

    // HashMap<K, V, S> where S is the hasher builder
    // RandomState makes it use ahash instead of SipHash
    pub api_by_predicate:     HashMap<String, Constructor, RandomState>,
    pub api_by_method:        HashMap<String, Method,      RandomState>,
    pub api_by_id:            HashMap<i64,   Constructor,  RandomState>,
    pub mtproto_by_id:        HashMap<i64,   Constructor,  RandomState>,
    pub mtproto_method_by_id: HashMap<i64,   Method,       RandomState>,
}

impl Schema {
    pub fn build(raw: RawSchema) -> Self {
        let api_by_predicate = raw.api.constructors
            .iter()
            .map(|c| (c.name().to_string(), c.clone()))
            .collect::<HashMap<_, _, RandomState>>();
            //                    ^^^^^^^^^^^^^^^^^^
            //         type annotation tells collect() which hasher to use

        let api_by_method = raw.api.methods
            .iter()
            .map(|m| (m.method.clone(), m.clone()))
            .collect::<HashMap<_, _, RandomState>>();

        let api_by_id = raw.api.constructors
            .iter()
            .map(|c| (c.id, c.clone()))
            .collect::<HashMap<_, _, RandomState>>();

        let mtproto_by_id = raw.mtproto.constructors
            .iter()
            .map(|c| (c.id, c.clone()))
            .collect::<HashMap<_, _, RandomState>>();

        let mtproto_method_by_id = raw.mtproto.methods
            .iter()
            .map(|m| (m.id, m.clone()))
            .collect::<HashMap<_, _, RandomState>>();

        Schema {
            mtproto: raw.mtproto,
            api:     raw.api,
            api_by_predicate,
            api_by_method,
            api_by_id,
            mtproto_by_id,
            mtproto_method_by_id,
        }
    }

    pub fn find_method(&self, name: &str) -> Option<&Method> {
        self.api_by_method.get(name)
    }

    pub fn find_constructor_by_predicate(&self, pred: &str) -> Option<&Constructor> {
        self.api_by_predicate.get(pred)
    }

    pub fn find_constructor_by_id(&self, id: i64) -> Option<(&Constructor, bool)> {
        if let Some(c) = self.mtproto_by_id.get(&id) {
            return Some((c, false)); // in MTProto (not fallback)
        }
        if let Some(c) = self.api_by_id.get(&id) {
            return Some((c, true)); // in API (fallback)
        }
        None
    }

    pub fn find_method_by_id(&self, id: i64) -> Option<&Method> {
        if let Some(m) = self.mtproto_method_by_id.get(&id) {
            return Some(m);
        }
        self.api.methods.iter().find(|m| m.id == id)
    }
}
