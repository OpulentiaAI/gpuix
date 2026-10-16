use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseDecision {
    Allow,
    Pending,
    Request(String),
}

pub(crate) struct CloseGuard {
    pub(crate) generation: u64,
    enabled: bool,
    sequence: u64,
    pending: Option<String>,
    approved: Option<String>,
    closed: bool,
}

impl Default for CloseGuard {
    fn default() -> Self {
        Self {
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            enabled: false,
            sequence: 0,
            pending: None,
            approved: None,
            closed: false,
        }
    }
}

impl CloseGuard {
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.pending = None;
            self.approved = None;
        }
    }

    pub(crate) fn request(&mut self) -> CloseDecision {
        if self.closed || self.approved.is_some() || self.pending.is_some() {
            return CloseDecision::Pending;
        }
        if !self.enabled {
            self.closed = true;
            return CloseDecision::Allow;
        }
        let Some(sequence) = self.sequence.checked_add(1) else {
            return CloseDecision::Pending;
        };
        self.sequence = sequence;
        let id = format!("{}:{}", self.generation, sequence);
        self.pending = Some(id.clone());
        CloseDecision::Request(id)
    }

    pub(crate) fn resolve(&mut self, id: &str, allow: bool) -> bool {
        if self.closed || self.pending.as_deref() != Some(id) {
            return false;
        }
        self.pending = None;
        if allow {
            self.approved = Some(id.to_string());
        }
        true
    }

    pub(crate) fn consume_approval(&mut self, id: &str) -> bool {
        if self.closed || self.approved.as_deref() != Some(id) {
            return false;
        }
        self.approved = None;
        self.closed = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(guard: &mut CloseGuard) -> String {
        match guard.request() {
            CloseDecision::Request(id) => id,
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn disabled_allows_once() {
        let mut guard = CloseGuard::default();
        assert_eq!(guard.request(), CloseDecision::Allow);
        assert_eq!(guard.request(), CloseDecision::Pending);
    }

    #[test]
    fn duplicate_deny_and_stale_requests() {
        let mut guard = CloseGuard::default();
        guard.set_enabled(true);
        let first = request(&mut guard);
        assert_eq!(guard.request(), CloseDecision::Pending);
        assert!(!guard.resolve("stale", true));
        assert!(guard.resolve(&first, false));
        let second = request(&mut guard);
        assert_ne!(first, second);
        assert!(!guard.resolve(&first, true));
        assert!(guard.resolve(&second, true));
        assert!(!guard.resolve(&second, true));
        assert!(guard.consume_approval(&second));
        assert!(!guard.consume_approval(&second));
    }

    #[test]
    fn generation_and_disable_fence_queued_approval() {
        let mut first = CloseGuard::default();
        let mut second = CloseGuard::default();
        first.set_enabled(true);
        second.set_enabled(true);
        let old = request(&mut first);
        let current = request(&mut second);
        assert_ne!(first.generation, second.generation);
        assert!(!second.resolve(&old, true));
        assert!(second.resolve(&current, true));
        second.set_enabled(false);
        assert!(!second.consume_approval(&current));
        assert_eq!(second.request(), CloseDecision::Allow);
    }
}
