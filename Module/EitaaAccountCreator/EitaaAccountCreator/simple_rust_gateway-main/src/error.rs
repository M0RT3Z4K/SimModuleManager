use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    // #[from] means: automatically convert std::io::Error INTO AppError::Io
    // So you can write: some_io_operation()?  without manual conversion
    #[error("IO error : {0}")]
    Io(#[from] std::io::Error),

    // serde_json::Error is the error type from JSON parsing
    #[error("Json error: {0}")]
    Json(#[from] serde_json::Error),

    // reqwest::Error comes from HTTP requests
    #[error("http server error : {0}")]
    Http(#[from] reqwest::Error),

    // Schema errors happen when we can't find a TL method/constructor
    #[error("Schema error : {0}")]
    Schema(String),

    // Serialization = converting Rust data -> binary bytes
    #[error("TL Serialization error : {0}")]
    Serialization(String),

    // Deserialization = converting binary bytes → Rust data
    #[error("TL deserialization error: {0}")]
    Deserialization(String),

    // Generic request errors
    #[error("Request error: {0}")]
    Request(String),
}

// This is a type alias — instead of writing Result<T, AppError> everywhere,
// we write Result<T> (our own Result that always uses AppError as the error type)
pub type Result<T> = std::result::Result<T, AppError>;
