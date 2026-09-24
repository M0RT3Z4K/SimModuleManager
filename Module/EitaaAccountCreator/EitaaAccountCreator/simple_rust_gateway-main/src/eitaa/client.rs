use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tracing::{debug, warn};

use crate::error::{AppError, Result};
use crate::tl::{de, ser};
use crate::SCHEMA;

use super::pool::HostPool;

// ── The three server pools (from Eitaa's JS client source) ───────────────────

fn regular_hosts() -> Vec<String> {
    [
        "https://hasan.eitaa.ir/eitaa/",
        "https://hosna.eitaa.com/eitaa/",
        "https://armita.eitaa.com/eitaa/",
        "https://majid.eitaa.com/eitaa/",
        "https://alireza.eitaa.com/eitaa/",
        "https://mostafa.eitaa.com/eitaa/",
        "https://sajad.eitaa.ir/eitaa/",
        "https://bagher.eitaa.ir/eitaa/",
        "https://sadegh.eitaa.ir/eitaa/",
        "https://kazem.eitaa.ir/eitaa/",
    ]
        .iter()
        .map(|s| s.to_string())  // &str → String (owned copy)
        .collect()
}

fn upload_hosts() -> Vec<String> {
    [
        "https://alzheimer.eitaa.com/eitaa/",
        "https://fateme.eitaa.com/eitaa/",
        "https://ali.eitaa.com/eitaa/",
        "https://meysam.eitaa.com/eitaa/",
    ]
        .iter().map(|s| s.to_string()).collect()
}

fn download_hosts() -> Vec<String> {
    [
        "https://mohsen.eitaa.com/eitaa/",
        "https://ghasem.eitaa.com/eitaa/",
        "https://hadi.eitaa.com/eitaa/",
        "https://hossein.eitaa.com/eitaa/",
        "https://vahid.eitaa.com/eitaa/",
    ]
        .iter().map(|s| s.to_string()).collect()
}

// ── Pool routing ──────────────────────────────────────────────────────────────

#[derive(PartialEq, Eq)]  // PartialEq lets us compare with ==
enum PoolKind {
    Regular,
    Upload,
    Download,
}

fn pool_kind_for(method: &str) -> PoolKind {
    match method {
        "upload.saveFilePart"
        | "upload.saveBigFilePart"
        | "messages.sendMedia"
        | "messages.sendMultiMedia" => PoolKind::Upload,

        "upload.getFile"
        | "upload.getCdnFile"
        | "upload.reuploadCdnFile"
        | "upload.getFileHashes" => PoolKind::Download,

        _ => PoolKind::Regular,
    }
}

// Try to extract a file_id from the request parameters.
// Used to "pin" upload parts to the same host.
fn extract_file_id(method: &str, params: &Value) -> Option<i64> {
    if let Some(fid) = params.get("file_id").and_then(|v| v.as_i64()) {
        return Some(fid);
    }
    if method == "messages.sendMedia" {
        return params
            .get("media")
            .and_then(|m| m.get("file"))
            .and_then(|f| f.get("id"))
            .and_then(|v| v.as_i64());
    }
    if method == "messages.sendMultiMedia" {
        if let Some(arr) = params.get("multi_media").and_then(|v| v.as_array()) {
            for item in arr {
                if let Some(fid) = item
                    .get("media")
                    .and_then(|m| m.get("file"))
                    .and_then(|f| f.get("id"))
                    .and_then(|v| v.as_i64())
                {
                    return Some(fid);
                }
            }
        }
    }
    None
}

// Format an error with its full cause chain (for logging)
fn error_detail(e: &AppError) -> String {
    let mut msg = e.to_string();
    let skip_one = e.source().and_then(|s| s.source());
    let mut cause = skip_one;
    while let Some(c) = cause {
        msg.push_str(&format!(" → {c}"));
        cause = c.source();
    }
    msg
}

// ── The main client struct ────────────────────────────────────────────────────

// Arc = Atomically Reference Counted — lets multiple threads share ownership
// Arc<T> is like Python's reference counting but thread-safe
// Clone on EitaaClient just increments the reference count (cheap)
#[derive(Clone)]
pub struct EitaaClient {
    http:            Client,              // HTTP client (reqwest)
    regular_pool:    Arc<HostPool>,       // Shared across clones
    upload_pool:     Arc<HostPool>,
    download_pool:   Arc<HostPool>,
    // Mutex<HashMap> = thread-safe dictionary
    upload_sessions: Arc<Mutex<HashMap<i64, String>>>,  // file_id → pinned host URL
}

impl EitaaClient {
    pub fn new() -> Result<Self> {
        let http = Client::builder()
            .use_rustls_tls()                        // pure-Rust TLS
            .timeout(Duration::from_secs(60))        // 60s request timeout
            .build()
            .map_err(AppError::Http)?;               // convert reqwest::Error → AppError::Http

        Ok(Self {
            http,
            regular_pool:    Arc::new(HostPool::new(regular_hosts())),
            upload_pool:     Arc::new(HostPool::new(upload_hosts())),
            download_pool:   Arc::new(HostPool::new(download_hosts())),
            upload_sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Main entry point: serialize, send, retry, deserialize
    pub async fn wrap_and_send(
        &self,
        method: &str,
        params: &Value,
        token:  &str,
        imei:   &str,
    ) -> Result<Value> {
        const MAX_RETRIES:     u32 = 5;
        const BASE_BACKOFF_MS: u64 = 100;

        let kind = pool_kind_for(method);

        // Select the right pool based on method type
        // "&self.regular_pool" = borrow a reference (not move ownership)
        let pool: &Arc<HostPool> = match kind {
            PoolKind::Regular  => &self.regular_pool,
            PoolKind::Upload   => &self.upload_pool,
            PoolKind::Download => &self.download_pool,
        };

        // For uploads, pin the file_id to one host
        // This ensures all chunks of the same file go to the same server
        let pinned_url: Option<String> = if kind == PoolKind::Upload {
            extract_file_id(method, params).map(|fid| {
                let mut sessions = self.upload_sessions.lock().unwrap();
                // entry().or_insert_with() = get existing OR insert new
                sessions.entry(fid).or_insert_with(|| pool.pick()).clone()
            })
        } else {
            None
        };

        let mut attempt = 0u32;
        loop {
            let url = pinned_url.clone().unwrap_or_else(|| pool.pick());

            match self.do_request(method, params, token, imei, &url).await {
                Ok(val) => {
                    pool.report_success(&url);
                    return Ok(val);
                }
                Err(e) => {
                    warn!(
                        "Request {} failed on {} (attempt {}): {}",
                        method, url, attempt, error_detail(&e)
                    );

                    if attempt >= MAX_RETRIES {
                        if pinned_url.is_some() {
                            return Err(AppError::Request(format!(
                                "Upload part failed after {} retries on {}: {}",
                                MAX_RETRIES, url, error_detail(&e)
                            )));
                        }
                        pool.report_failure(&url);
                        return Err(e);
                    }

                    if pinned_url.is_none() {
                        pool.report_failure(&url);
                    }

                    attempt += 1;

                    // Exponential backoff: 100ms, 200ms, 400ms, ..., max 5000ms
                    let wait_ms = BASE_BACKOFF_MS
                        .checked_shl(attempt.min(5) as u32)
                        .unwrap_or(u64::MAX)
                        .min(5_000);

                    // tokio::time::sleep is the async sleep (yields the thread, doesn't block)
                    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                }
            }
        }
    }

    // Make one HTTP request: TL serialize → HTTP POST → TL deserialize
    async fn do_request(
        &self,
        method: &str,
        params: &Value,
        token:  &str,
        imei:   &str,
        url:    &str,
    ) -> Result<Value> {
        let schema = SCHEMA.get().expect("schema not initialised");

        // Step 1: Prepare params (compute flags bitmask)
        let prepared = ser::prepare_params(method, params, schema)?;

        // Step 2: Serialize the inner method call to binary
        let inner = ser::TlSerializer::store_method(method, &prepared, schema)?;

        // Step 3: Wrap in the eitaaObject outer envelope
        let outer = self.wrap_request(inner, token, imei)?;

        debug!("POST {} → {}", method, url);

        // Step 4: Send HTTP POST with the binary body
        let resp  = self.http.post(url).body(outer).send().await?;
        let bytes = resp.bytes().await?;

        // Step 5: Deserialize the response
        let obj = de::fetch_object(&bytes, "")?;

        // The server may return a gzip-packed response with a "packed_data" field
        if let Some(packed) = obj.get("packed_data") {
            let raw: Vec<u8> = packed
                .as_array()
                .map(|arr| arr.iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect())
                .unwrap_or_default();
            de::fetch_object(&raw, "")
        } else {
            Ok(obj)
        }
    }

    // Wrap the inner binary in the eitaaObject envelope (token + IMEI + layer)
    fn wrap_request(&self, inner: Vec<u8>, token: &str, imei: &str) -> Result<Vec<u8>> {
        let schema = SCHEMA.get().expect("schema not initialised");

        // Convert raw bytes to JSON array-of-numbers for transport
        let inner_as_json: Vec<Value> =
            inner.into_iter().map(|b| Value::Number(b.into())).collect();

        let params = serde_json::json!({
            "token":       token,
            "imei":        imei,
            "packed_data": inner_as_json,
            "layer":       133    // Eitaa API layer version
        });

        ser::TlSerializer::store_method("eitaaObject", &params, schema)
    }
}