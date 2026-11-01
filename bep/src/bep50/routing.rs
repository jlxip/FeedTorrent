use super::*;
#[derive(Clone, Debug)]
pub(super) struct Contact {
    pub id: Target,
    pub addr: SocketAddr,
    pub seen: u64,
    pub failures: u8,
}
/// Buckets partition the XOR space along the local ID. Index depth is home;
/// depth-1 is its sibling. All older siblings are K=1 uncles.
pub(super) struct Routing {
    own: Target,
    depth: usize,
    buckets: Vec<Vec<Contact>>,
}
impl Routing {
    pub fn new(own: Target) -> Self {
        Self {
            own,
            depth: 0,
            buckets: vec![vec![]],
        }
    }
    fn index(&self, id: Target) -> usize {
        common(self.own, id).min(self.depth)
    }
    pub fn contacts(&self) -> impl Iterator<Item = &Contact> {
        self.buckets.iter().flatten()
    }
    pub fn contains(&self, addr: SocketAddr) -> bool {
        self.contacts().any(|c| c.addr == addr)
    }
    pub fn confirm(&mut self, id: Target, addr: SocketAddr, now: u64) -> bool {
        if id == self.own {
            return false;
        }
        // An endpoint has one current node ID; a changed ID is only installed
        // following a correlated reply, never an unsolicited query.
        for bucket in &mut self.buckets {
            bucket.retain(|c| c.addr != addr || c.id == id);
        }
        loop {
            let i = self.index(id);
            let cap = if i >= self.depth.saturating_sub(1) {
                8
            } else {
                1
            };
            let b = &mut self.buckets[i];
            if let Some(c) = b.iter_mut().find(|c| c.id == id) {
                *c = Contact {
                    id,
                    addr,
                    seen: now,
                    failures: 0,
                };
                return true;
            }
            if b.len() < cap {
                b.push(Contact {
                    id,
                    addr,
                    seen: now,
                    failures: 0,
                });
                return true;
            }
            if i != self.depth || self.depth == 159 {
                return false;
            }
            self.depth += 1;
            let old = self.buckets.pop().unwrap();
            self.buckets.push(vec![]);
            self.buckets.push(vec![]);
            for c in old {
                let index = self.index(c.id);
                self.buckets[index].push(c);
            }
            for j in 0..self.depth.saturating_sub(1) {
                self.buckets[j].truncate(1);
            }
        }
    }
    pub fn failed(&mut self, addr: SocketAddr) {
        for b in &mut self.buckets {
            for c in b.iter_mut().filter(|c| c.addr == addr) {
                c.failures += 1
            }
            b.retain(|c| c.failures < 2);
        }
    }
    pub fn refresh_target(&self, addr: SocketAddr, mut random: Target) -> Target {
        if let Some(contact) = self.contacts().find(|c| c.addr == addr) {
            let prefix = common(self.own, contact.id).min(159);
            for bit in 0..=prefix {
                let mask = 1u8 << (7 - bit % 8);
                random[bit / 8] = (random[bit / 8] & !mask) | (contact.id[bit / 8] & mask);
            }
        }
        random
    }
    pub fn closest(&self, target: Target) -> Vec<(Target, SocketAddr)> {
        let mut v: Vec<_> = self.contacts().map(|c| (c.id, c.addr)).collect();
        v.sort_by_key(|(id, _)| xor(*id, target));
        v.truncate(1);
        v
    }
}
fn common(a: Target, b: Target) -> usize {
    a.iter()
        .zip(b)
        .map(|(a, b)| a ^ b)
        .take_while(|b| *b == 0)
        .count()
        * 8
        + a.iter()
            .zip(b)
            .map(|(a, b)| a ^ b)
            .find(|b| *b != 0)
            .map(|b| b.leading_zeros() as usize)
            .unwrap_or(0)
}
fn xor(a: Target, b: Target) -> Target {
    let mut out = [0; 20];
    for i in 0..20 {
        out[i] = a[i] ^ b[i]
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_shrinks_uncles_and_keeps_sibling() {
        let mut r = Routing::new([0; 20]);
        for i in 1..200u16 {
            let mut id = [0; 20];
            id[0] = (i % 255) as u8;
            id[19] = (i / 255) as u8;
            r.confirm(id, SocketAddr::from(([127, 0, 0, 1], i)), 0);
        }
        assert!(r.depth > 1);
        for (i, b) in r.buckets.iter().enumerate() {
            assert!(b.len() <= if i >= r.depth.saturating_sub(1) { 8 } else { 1 });
        }
    }
}
