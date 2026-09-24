use std::sync::Mutex;
use std::time::{Duration, Instant};

use tracing::warn;

// State for a single host
struct HostState {
    failures:   u32,            // number of consecutive failures
    open_until: Option<Instant>, // None = healthy, Some(t) = circuit open until time t
}

// All mutable state lives behind a Mutex (thread-safe lock)
struct PoolState {
    cursor: usize,          // current round-robin position
    hosts:  Vec<HostState>, // per-host state
}

/// Round-robin host pool with per-host exponential-backoff circuit breaking.
pub struct HostPool {
    urls:  Vec<String>,     // the actual URLs (immutable after construction)
    state: Mutex<PoolState>, // mutable state, protected by a mutex
}

impl HostPool {
    pub fn new(urls: Vec<String>) -> Self {
        let n = urls.len();
        Self {
            urls,
            state: Mutex::new(PoolState {
                cursor: 0,
                hosts:  (0..n)
                    .map(|_| HostState { failures: 0, open_until: None })
                    .collect(),
            }),
        }
    }

    /// Pick the next healthy URL (round-robin, skipping broken hosts)
    pub fn pick(&self) -> String {
        let now = Instant::now();
        let n   = self.urls.len();

        // .lock().unwrap() = acquire the mutex (panics if poisoned)
        // In production you'd handle the Err case, but poisoning only happens
        // if a thread panicked while holding the lock (very rare)
        let mut g = self.state.lock().unwrap();

        for _ in 0..n {
            let idx = g.cursor % n;
            g.cursor = g.cursor.wrapping_add(1);  // wrapping_add = won't overflow, wraps to 0

            // Host is healthy if: open_until is None OR the backoff period expired
            if g.hosts[idx].open_until.map_or(true, |t| now >= t) {
                return self.urls[idx].clone();
            }
        }

        // All hosts are circuit-broken! Emergency: reset everything
        warn!("All hosts in pool are circuit-broken; resetting to allow retries");
        for h in g.hosts.iter_mut() {
            h.failures   = 0;
            h.open_until = None;
        }
        self.urls[0].clone()
    }

    /// Report a successful request — clear failure counter for this host
    pub fn report_success(&self, url: &str) {
        let mut g = self.state.lock().unwrap();
        if let Some(idx) = self.urls.iter().position(|u| u == url) {
            g.hosts[idx].failures   = 0;
            g.hosts[idx].open_until = None;
        }
    }

    /// Report a failed request — increment failures and set exponential backoff
    pub fn report_failure(&self, url: &str) {
        let mut g = self.state.lock().unwrap();
        if let Some(idx) = self.urls.iter().position(|u| u == url) {
            let n = g.hosts[idx].failures.saturating_add(1);  // saturating = won't overflow
            g.hosts[idx].failures = n;

            // Backoff: 2^n seconds, capped at 60 seconds
            // 1 failure = 2s, 2 = 4s, 3 = 8s, ... 6+ = 60s
            let secs = 1u64
                .checked_shl(u32::from(n))  // 1 << n
                .unwrap_or(u64::MAX)
                .min(60);
            g.hosts[idx].open_until = Some(Instant::now() + Duration::from_secs(secs));

            warn!(
                "Host {} circuit-broken for {}s (consecutive_failures={})",
                url, secs, n
            );
        }
    }
}