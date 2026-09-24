use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::tl::virtual_method::copy_message;


use crate::eitaa::EitaaClient;
use crate::error::{AppError, Result};

// ── Request / Response types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GatewayRequest {
    pub method: String,

    #[serde(default)]
    pub param: Value,

    #[serde(default)]
    pub token: String,

    #[serde(default = "default_imei")]
    pub imei: String,
}

fn default_imei() -> String {
    "zorrat_xmamad__ios".to_string()
}

#[derive(Debug, Serialize)]
pub struct GatewayResponse {
    pub status: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl GatewayResponse {
    pub fn ok(data: Value) -> Self {
        Self {
            status:  "ok".to_string(),
            data:    Some(data),
            message: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            status:  "error".to_string(),
            data:    None,
            message: Some(msg.into()),
        }
    }
}

// ── GatewayService ───────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct GatewayService {
    client: Arc<EitaaClient>,
}

impl GatewayService {
    pub fn new(client: EitaaClient) -> Self {
        Self {
            client: Arc::new(client),
        }
    }

    pub async fn execute(&self, req: GatewayRequest) -> GatewayResponse {
        // ── Virtual methods (handled locally, no network call) ────────────────
        if req.method == "messages.copyMessage" {
            let result = copy_message(&self, &req.param, &req.token, &req.imei).await;
            return GatewayResponse::ok(result);
        }

        // ── Real methods (serialized and sent to Eitaa) ───────────────────────
        match self.client.wrap_and_send(
            &req.method,
            &req.param,
            &req.token,
            &req.imei,
        ).await {
            Ok(data) => GatewayResponse::ok(data),
            Err(e)   => GatewayResponse::error(e.to_string()),
        }
    }



    pub async fn call(
        &self,
        method: &str,
        param:  Value,
        token:  &str,
        imei:   &str,
    ) -> GatewayResponse {

        self.execute(GatewayRequest {
            method: method.to_string(),
            param,
            token:  token.to_string(),
            imei:   imei.to_string(),
        }).await
    }
}