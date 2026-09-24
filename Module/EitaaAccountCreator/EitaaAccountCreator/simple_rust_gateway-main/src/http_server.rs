#![cfg(feature = "http")]
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json,
    Router,
};
use tower_http::{
    cors::{Any, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use std::time::Duration;
use tracing::info;

use crate::service::{GatewayRequest, GatewayService};

// AppState holds the service so Axum can inject it into every handler.
// Clone is required by Axum — it is O(1) because GatewayService is Arc inside.

#[derive(Clone)]
struct AppState {
    service: GatewayService,
}

pub async fn run(addr: &str, service: GatewayService) -> anyhow::Result<()> {
    let state = AppState { service };

    let router = Router::new()
        .route("/api/call", post(handle_call))
        .route("/health",   axum::routing::get(handle_health))
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::new(Duration::from_secs(60)))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("HTTP server listening on {addr}");
    axum::serve(listener, router).await?;
    Ok(())
}

async fn handle_call(
    State(state): State<AppState>,
    Json(req):    Json<GatewayRequest>,
) -> impl IntoResponse {
    let method = req.method.clone();
    tracing::info!("HTTP call: {}", method);

    let response = state.service.execute(req).await;

    let status = if response.status == "ok" {
        StatusCode::OK
    } else {
        StatusCode::BAD_GATEWAY
    };

    (status, Json(response))
}

async fn handle_health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" })))
}