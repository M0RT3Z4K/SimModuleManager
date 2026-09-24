use std::env;

#[derive(Debug, Clone)]
pub enum ServerMode {
    Ipc,   
    Http,  
}

#[derive(Debug, Clone)]
pub struct Config {
    pub mode: ServerMode,

    pub ipc_socket: String,

    pub http_addr: String,

    pub specs_path:      String,
    pub gateway_workers: usize,
}

impl Config {
    pub fn from_env() -> Self {
        let gateway_workers = env::var("GATEWAY_WORKERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);

        let gateway_workers = if gateway_workers == 0 {
            num_cpus()
        } else {
            gateway_workers
        };

        let mode = match env::var("SERVER_MODE")
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "http" => ServerMode::Http,
            _      => ServerMode::Ipc,  
        };

        Self {
            mode,
            ipc_socket: env::var("IPC_SOCKET")
                .unwrap_or_else(|_| "/tmp/eitaa_service.sock".to_string()),
            http_addr: env::var("HTTP_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:3000".to_string()),
            specs_path: env::var("SPECS_PATH")
                .unwrap_or_else(|_| "specs.json".to_string()),
            gateway_workers,
        }
    }
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}