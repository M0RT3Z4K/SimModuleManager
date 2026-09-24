# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM 10.10.10.7:8085/rust:1.88-slim AS builder

WORKDIR /app

# Cache dependency build separately from source
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY specs.json ./
# RUN cargo build --release 2>/dev/null || true
RUN touch src/main.rs && cargo build --release

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM 10.10.10.7:8085/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/eitaa-gateway ./eitaa-gateway
COPY --from=builder /app/specs.json ./specs.json

# The tests are pure Python (standard library only) and need a Python runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
    && rm -rf /var/lib/apt/lists/*

ENV IPC_SOCKET=/tmp/eitaa_service.sock \
    SPECS_PATH=/app/specs.json \
    RUST_LOG=info

CMD ["./eitaa-gateway"]
