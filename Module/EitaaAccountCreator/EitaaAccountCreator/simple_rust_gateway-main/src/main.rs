mod config;
mod error;
mod tl;
mod eitaa;
mod service;
mod ipc_server;
#[cfg(feature = "http")]
mod http_server;

use std::sync::OnceLock;
use tracing::info;

use crate::config::{Config, ServerMode};
use crate::eitaa::EitaaClient;
use crate::service::GatewayService;
use crate::tl::schema::{RawSchema, Schema};

pub static SCHEMA: OnceLock<Schema> = OnceLock::new();

fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let cfg = Config::from_env();

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(cfg.gateway_workers)
        .enable_all()
        .build()?
        .block_on(run(cfg))
}

async fn run(cfg: Config) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let specs_raw = std::fs::read_to_string(&cfg.specs_path)
        .unwrap_or_else(|_| panic!("Cannot read specs from '{}'", cfg.specs_path));
    let raw: RawSchema = serde_json::from_str(&specs_raw)
        .expect("specs.json is not valid JSON");
    SCHEMA.set(Schema::build(raw)).ok();
    info!(
        "Schema loaded ({} constructors, {} methods)",
        SCHEMA.get().unwrap().api.constructors.len(),
        SCHEMA.get().unwrap().api.methods.len(),
    );

    let client  = EitaaClient::new()?;
    let service = GatewayService::new(client);

    match cfg.mode {
        ServerMode::Ipc => {
            info!("Mode: IPC socket ({})", cfg.ipc_socket);
            ipc_server::run(&cfg.ipc_socket, service).await?;
        }
        ServerMode::Http => {
            #[cfg(not(feature = "http"))]
            {
                // This branch is compiled when http feature is OFF.
                // Fail clearly at runtime rather than silently falling back.
                anyhow::bail!(
                "Binary was compiled without the 'http' feature. \
                 Rebuild with: cargo build --features http"
            );
            }
            #[cfg(feature = "http")]
            {
                info!("Mode: HTTP ({})", cfg.http_addr);
                http_server::run(&cfg.http_addr, service).await?;
            }
        }
    }
    Ok(())
}