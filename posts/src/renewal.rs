//! Transient, host-driven renewal policy. No private keys or checkpoint migration.
use super::*;
const MAX_RENEWALS: usize = 4;
const INTERVAL: u64 = 30 * 60 * 1000;
#[derive(Clone)]
pub(super) struct Renewal {
    next: u64,
    failures: u32,
    pub active: bool,
    pub ready: bool,
}
impl Renewal {
    pub(super) fn due(now: u64) -> Self {
        Self {
            next: now,
            failures: 0,
            active: false,
            ready: false,
        }
    }
}
fn jitter(id: &str) -> u64 {
    // Identity is a stable SHA1 hex target, independent of process/hash-map seeds.
    u64::from_str_radix(&id[..8], 16).unwrap_or(0) % 300_001
}
impl PostManager {
    pub(super) fn schedule_renewals(&mut self) {
        let ready: Vec<_> = self
            .renewals
            .iter()
            .filter(|(_, r)| r.active && r.ready)
            .map(|(p, _)| p.clone())
            .collect();
        for post in ready {
            let Some(record) = self.known(&post).ok().flatten() else {
                continue;
            };
            if bep46::decode_payload(record.value()).is_err() {
                // Keep the signed high-water record; never renew an older pointer.
                let r = self.renewals.get_mut(&post).unwrap();
                r.active = false;
                r.ready = false;
                r.next = self.now.saturating_add(INTERVAL + jitter(&post));
                continue;
            }
            if let Some(work) = self.new_work(Work::RenewalPut(post.clone(), record.clone())) {
                self.renewals.get_mut(&post).unwrap().ready = false;
                self.out
                    .push_back(Action::RenewalPut { work, post, record });
            }
        }
        let mut active = self.renewals.values().filter(|r| r.active).count();
        let mut due: Vec<_> = self
            .renewals
            .iter()
            .filter(|(p, r)| {
                self.followed(p)
                    && !r.active
                    && r.next <= self.now
                    && !self.runtime.get(*p).is_some_and(|r| r.checking)
            })
            .map(|(p, r)| (r.next, p.clone()))
            .collect();
        due.sort();
        for (_, post) in due {
            if active >= MAX_RENEWALS {
                break;
            }
            if let Some(work) = self.new_work(Work::RenewalLookup(post.clone())) {
                let key = self.key(&post).unwrap();
                self.renewals.get_mut(&post).unwrap().active = true;
                let r = self.runtime.entry(post.clone()).or_default();
                r.checking = true;
                r.next_check = self.now.saturating_add(POLL_MS);
                self.out
                    .push_back(Action::RenewalLookup { work, post, key });
                active += 1;
            }
        }
    }
    pub fn renewal_lookup_result(
        &mut self,
        work: WorkId,
        result: std::result::Result<Option<MutableRecord>, RenewalError>,
        now: u64,
    ) {
        let Some(Work::RenewalLookup(post)) = self.pending.remove(&work) else {
            return;
        };
        self.now = self.now.max(now);
        let r = self.runtime.get_mut(&post).unwrap();
        r.checking = false;
        r.last_checked = Some(now);
        match result {
            Ok(Some(record)) => {
                if let Err(e) = self.receive_record(&post, record, now) {
                    self.renewal_failed(&post, e.to_string(), now);
                    return;
                }
            }
            Ok(None) => {}
            Err(RenewalError::Failed(message)) => {
                self.notice(&post, format!("Post renewal lookup: {message}"))
            }
            Err(RenewalError::Conflict) => {
                self.renewal_failed(&post, "Conflicting post renewal lookup".into(), now);
                return;
            }
        }
        self.renewals.get_mut(&post).unwrap().ready = true;
        self.tick(now);
    }
    /// Recheck immediately before submitting a queued put. A higher push may
    /// have arrived after the action was queued, or the post may be unfollowed.
    pub fn renewal_record(&self, work: WorkId) -> Option<MutableRecord> {
        if self.dirty {
            return None;
        }
        let Work::RenewalPut(post, record) = self.pending.get(&work)? else {
            return None;
        };
        let latest = self.known(post).ok()??;
        (self.followed(post) && latest == *record && bep46::decode_payload(record.value()).is_ok())
            .then(|| record.clone())
    }
    pub fn renewal_result(
        &mut self,
        work: WorkId,
        result: std::result::Result<RenewalConfirmation, RenewalError>,
        now: u64,
    ) {
        let Some(Work::RenewalPut(post, record)) = self.pending.remove(&work) else {
            return;
        };
        self.now = self.now.max(now);
        match result {
            Ok(c) if c.target == record.key().target() && c.acknowledged_nodes > 0 => {
                let current = self
                    .known(&post)
                    .ok()
                    .flatten()
                    .is_some_and(|r| r == record);
                let r = self.renewals.get_mut(&post).unwrap();
                r.active = false;
                r.ready = false;
                r.failures = 0;
                r.next = if current {
                    now.saturating_add(INTERVAL + jitter(&post))
                } else {
                    now
                };
                // Successful recovery clears renewal diagnostics, not unrelated errors.
                if self.runtime[&post].error.starts_with("Post renewal") {
                    self.runtime.get_mut(&post).unwrap().error.clear();
                }
            }
            Ok(_) => self.renewal_failed(&post, "Invalid DHT confirmation".into(), now),
            Err(e) => self.renewal_failed(&post, e.to_string(), now),
        }
        self.tick(now);
    }
    pub(super) fn renewal_failed(&mut self, post: &str, message: String, now: u64) {
        let Some(r) = self.renewals.get_mut(post) else {
            return;
        };
        r.active = false;
        r.ready = false;
        r.failures = r.failures.saturating_add(1);
        r.next =
            now.saturating_add((30_000u64 << r.failures.saturating_sub(1).min(5)).min(POLL_MS));
        self.runtime.entry(post.into()).or_default().checking = false;
        self.notice(post, format!("Post renewal: {message}"));
    }
}

#[cfg(test)]
#[path = "renewal_tests.rs"]
mod tests;
