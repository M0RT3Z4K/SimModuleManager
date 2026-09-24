// src/lib.rs
//
// This file is the library entry point. It re-exports everything that
// tests/integration.rs (and future consumers) need to import.
//
// The binary (src/main.rs) also uses this — it imports from the lib,
// keeping the code in one place.
//
// "pub mod" = this module is part of the public API of the crate
pub mod config;
pub mod error;
pub mod tl;
pub mod eitaa;
pub mod service;
pub mod http_server;
mod ipc_server;

// Re-export the global schema so tests can access SCHEMA directly
pub use std::sync::OnceLock;
use crate::tl::schema::Schema;

pub static SCHEMA: OnceLock<Schema> = OnceLock::new();