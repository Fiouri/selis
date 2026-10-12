//! Stable stand-in for the cargo-fuzz targets (`fuzz/`, run on CI): the same
//! entry points over a few thousand deterministic mutations of valid inputs.
//! Nothing may panic; whatever parses must round-trip.

use iroh::{EndpointAddr, SecretKey};
use iroh_blobs::Hash;
use selis_transfer::{
    ResumeInfo, TransferTicket,
    manifest::{Manifest, ManifestItem},
    wire::{ToReceiver, ToSender, decode},
};

/// xorshift: deterministic, no dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % (n.max(1) as u64)).unwrap_or(0)
    }
}

fn mutate(rng: &mut Rng, seed: &[u8]) -> Vec<u8> {
    let mut v = seed.to_vec();
    for _ in 0..=rng.below(8) {
        match rng.below(4) {
            0 if !v.is_empty() => {
                let i = rng.below(v.len());
                v[i] = (rng.next() & 0xff) as u8;
            }
            1 if !v.is_empty() => {
                let i = rng.below(v.len());
                v.truncate(i);
            }
            2 => {
                let i = rng.below(v.len() + 1);
                v.insert(i, (rng.next() & 0xff) as u8);
            }
            _ => {
                let i = rng.below(v.len() + 1);
                let extra: Vec<u8> = v.clone();
                v.splice(i..i, extra.into_iter().take(64));
            }
        }
    }
    v
}

#[test]
fn ticket_parser_never_panics_and_round_trips() {
    let ticket = TransferTicket {
        addr: EndpointAddr::new(SecretKey::from_bytes(&[5; 32]).public()),
        collection: Hash::new(b"c"),
        token: [1; 16],
        expires_at: 1,
    };
    let seed = ticket.to_link().into_bytes();
    let mut rng = Rng(0x5e11_5e11);
    for _ in 0..20_000 {
        let input = mutate(&mut rng, &seed);
        if let Ok(s) = std::str::from_utf8(&input)
            && let Ok(t) = TransferTicket::parse(s)
        {
            assert_eq!(TransferTicket::parse(&t.to_link()).ok(), Some(t));
        }
    }
}

#[test]
fn manifest_parser_never_panics_and_round_trips() {
    let seed = Manifest::new(vec![ManifestItem {
        title: "Τίτλος".into(),
        name: "a.pdf".into(),
        size: 10,
        blake3: Hash::new(b"a"),
        history: vec![],
    }])
    .to_bytes();
    let mut rng = Rng(0xfeed_beef);
    for _ in 0..20_000 {
        let input = mutate(&mut rng, &seed);
        if let Ok(m) = Manifest::parse(&input) {
            assert_eq!(Manifest::parse(&m.to_bytes()).ok(), Some(m));
        }
    }
}

#[test]
fn control_messages_never_panic() {
    let seeds = [
        postcard::to_stdvec(&ToSender::Hello { token: [3; 16] }).unwrap_or_default(),
        postcard::to_stdvec(&ToReceiver::Accepted { session: [4; 16], manifest: vec![1, 2, 3] }).unwrap_or_default(),
    ];
    let mut rng = Rng(0xc0de);
    for i in 0..20_000 {
        let input = mutate(&mut rng, &seeds[i % 2]);
        let _ = decode::<ToSender>(&input);
        let _ = decode::<ToReceiver>(&input);
    }
}

#[test]
fn stored_resume_info_never_panics_and_round_trips() {
    let info = ResumeInfo {
        addr: EndpointAddr::new(SecretKey::from_bytes(&[6; 32]).public()),
        collection: Hash::new(b"r"),
        session: [2; 16],
    };
    assert_eq!(ResumeInfo::decode(&info.encode()), Some(info.clone()));
    let seed = info.encode().into_bytes();
    let mut rng = Rng(0xabcd);
    for _ in 0..20_000 {
        let input = mutate(&mut rng, &seed);
        if let Ok(s) = std::str::from_utf8(&input)
            && let Some(r) = ResumeInfo::decode(s)
        {
            assert_eq!(ResumeInfo::decode(&r.encode()), Some(r));
        }
    }
}
