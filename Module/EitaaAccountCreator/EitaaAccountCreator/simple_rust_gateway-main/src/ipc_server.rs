use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tracing::{debug, error, info, warn};

use crate::error::Result;
use crate::service::{GatewayRequest, GatewayService};

pub async fn run(socket_path: &str, service: GatewayService) -> Result<()> {
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path)?;
    info!("IPC server listening on {socket_path}");

    let service = Arc::new(service);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let service = service.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, service).await {
                        debug!("Connection closed: {e}");
                    }
                });
            }
            Err(e) => warn!("Accept error: {e}"),
        }
    }
}

async fn handle_connection(mut stream: UnixStream, service: Arc<GatewayService>) -> Result<()> {
    let mut buf = Vec::<u8>::new();
    let mut tmp = [0u8; 8192];

    loop {
        loop {
            if buf.len() >= 4 {
                break;
            }
            let n = stream.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            } // clean disconnect
            buf.extend_from_slice(&tmp[..n]);
        }

        let expected = u32::from_le_bytes(buf[..4].try_into().unwrap()) as usize;
        buf.drain(..4);

        while buf.len() < expected {
            let n = stream.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
        }

        let payload = buf[..expected].to_vec();
        buf.drain(..expected);

        let response_bytes = process(&payload, &service).await;
        write_framed(&mut stream, &response_bytes).await?;
    }
}

async fn process(payload: &[u8], service: &GatewayService) -> Vec<u8> {
    let result = async {
        let req: serde_json::Value =
            serde_json::from_slice(payload).map_err(crate::error::AppError::Json)?;

        let method = req
            .get("method")
            .and_then(|v| v.as_str())
            .ok_or_else(|| crate::error::AppError::Request("missing 'method' field".into()))?;

        let param = req
            .get("param")
            .cloned()
            .unwrap_or(serde_json::Value::Object(Default::default()));

        let token = req
            .get("token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let imei = req
            .get("imei")
            .and_then(|v| v.as_str())
            .unwrap_or("zorrat_xmamad__ios")
            .to_string();

        let resp = service.call(method, param, &token, &imei).await;

        serde_json::to_vec(&resp).map_err(|e| crate::error::AppError::Json(e))
    }
    .await;

    result.unwrap_or_else(|e| {
        error!("IPC request error: {e}");
        serde_json::to_vec(&serde_json::json!({
                "status":  "error",
                "message": e.to_string()
            }))
            .unwrap_or_else(|_| b"{\"status\":\"error\",\"message\":\"internal error\"}".to_vec())
    })
}

async fn write_framed(stream: &mut UnixStream, data: &[u8]) -> Result<()> {
    let len = data.len() as u32;
    let mut frame = Vec::with_capacity(4 + data.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(data);
    stream.write_all(&frame).await?;
    Ok(())
}
