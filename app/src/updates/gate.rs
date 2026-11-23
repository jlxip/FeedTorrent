//! An accepted request owns its lease until its response body has finished.
use axum::body::{Body, Bytes};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

#[derive(Default)]
struct State {
    waiting: bool,
    applying: bool,
    requests: usize,
    cancelled: bool,
}
#[derive(Default)]
pub struct Gate(Mutex<State>);
pub struct Lease(Arc<Gate>);
impl Gate {
    pub fn sensitive(&self) -> bool {
        !self.0.lock().unwrap().waiting
    }
    pub fn waiting(&self, value: bool) {
        self.0.lock().unwrap().waiting = value;
    }
    pub fn acquire(self: &Arc<Self>) -> Option<Lease> {
        let mut state = self.0.lock().unwrap();
        if state.applying {
            return None;
        }
        state.requests += 1;
        Some(Lease(self.clone()))
    }
    // Called after waiting=true and the background services are idle. The
    // request count closes the race with handlers that have not enqueued yet.
    pub fn begin_apply(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.requests != 0 || state.cancelled {
            return false;
        }
        state.applying = true;
        true
    }
    pub fn cancel(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.applying {
            return false;
        }
        state.cancelled = true;
        true
    }
    pub fn reset(&self) {
        let mut s = self.0.lock().unwrap();
        s.waiting = false;
        s.applying = false;
        s.cancelled = false;
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().requests -= 1;
    }
}
struct LeasedBody {
    body: Body,
    lease: Option<Lease>,
}
impl HttpBody for LeasedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(result, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            self.lease.take();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}
pub fn body(body: Body, lease: Lease) -> Body {
    Body::new(LeasedBody {
        body,
        lease: Some(lease),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepted_cancel_and_begin_apply_are_exclusive() {
        let gate = Gate::default();
        gate.waiting(true);
        assert!(gate.cancel());
        assert!(!gate.begin_apply());
        gate.reset();
        gate.waiting(true);
        assert!(gate.begin_apply());
        assert!(!gate.cancel());
    }
    #[tokio::test]
    async fn body_and_request_drop_fence_restart() {
        let gate = Arc::new(Gate::default());
        let lease = gate.acquire().unwrap();
        gate.waiting(true);
        assert!(!gate.sensitive());
        assert!(!gate.begin_apply());
        let body = body(Body::from("backup contents"), lease);
        assert!(!gate.begin_apply());
        assert_eq!(
            axum::body::to_bytes(body, 100).await.unwrap(),
            "backup contents"
        );
        assert!(gate.begin_apply());
        assert!(gate.acquire().is_none());
        gate.reset();
        let lease = gate.acquire().unwrap();
        drop(lease);
        assert!(gate.begin_apply());
    }
}
