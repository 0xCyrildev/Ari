//! ari-kdf — the credential gate's Argon2id worker, on real threads.
//!
//! Two problems, deliberately kept separate, because conflating them is how a performance story
//! becomes an unexamined security decision.
//!
//!   1. **The parameters were nobody's decision.** The Node side calls `@node-rs/argon2`'s `hash()`
//!      with no options, so every bearer credential to a payment system is derived at that library's
//!      default — measured on 2026-10-27 as `$argon2id$v=19$m=19456,t=2,p=1`. That happens to be the
//!      OWASP minimum, but it is minimum *by inheritance*: a dependency bump could change it with no
//!      diff in this repository. Here the cost parameters are explicit arguments, echoed at startup on
//!      stderr, so what guards a wallet is a recorded value rather than a library's default.
//!   2. **The concurrency ceiling was a thread pool of four.** `@node-rs/argon2` is already Rust; the
//!      binding is what makes it asynchronous, and it runs on libuv's pool, which defaults to
//!      `UV_THREADPOOL_SIZE = 4`. Measured on this box: 5 sequential hashes 244 ms (p50 ≈ 49 ms), 20
//!      concurrent 277 ms — about four in flight, which is the pool, not the algorithm. This worker
//!      takes `--workers` and uses OS threads, so credential throughput is bounded by cores and memory.
//!
//! It is a **worker, not a second source of truth.** It derives and verifies a password hash; it
//! computes no digest over a transaction, and nothing in Ari's decision path (`canon/v1`, the sealed
//! ticket, the audit chain) is re-implemented here. `rust/agreement.mts` asserts that this crate and
//! `@node-rs/argon2` produce byte-identical PHC strings for the same
//! (algorithm, version, m, t, p, salt, secret) and that each verifies the other's output — the same
//! doctrine the chain packages follow: a second implementation is worth having only when it can be
//! shown to disagree on nothing.
//!
//! # Protocol
//!
//! Line-delimited, tab-separated, stdin; responses on stdout, possibly out of order, keyed by the
//! caller's own id, so many requests can be in flight per connection.
//!
//! ```text
//! H\t<id>\t<secret>[\t<m_kib>\t<t_cost>\t<p_lanes>[\t<salt_b64>]]  ->  H\t<id>\t<phc>
//! V\t<id>\t<phc>\t<secret>                                        ->  V\t<id>\tok\tmigrate=<bool> | bad | err\t<msg>
//! P\t<id>                                                         ->  P\t<id>\t<workers>\t<params>
//! BYE                                                             ->  shutdown, exit 0
//! ```
//!
//! A panic on one request costs that request: the worker catches the unwind and answers `err`, so the
//! process serving every tenant's login does not die with it. Exit codes: 0 clean, 2 bad arguments.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};
use std::io::{BufRead, BufReader, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

const OUTPUT_LEN: usize = 32;

/// The process's declared cost parameters, from argv, with a floor it will not go below.
#[derive(Clone, Copy, Debug)]
struct Cost {
    m_kib: u32,
    t: u32,
    p: u32,
}

impl Cost {
    /// `m=19456, t=2, p=1` is what the Node binding produces today, so it is the floor rather than an
    /// invention: a deployment can raise the cost, but nothing can mint a credential weaker than the
    /// status quo by forgetting a flag.
    const MIN: Cost = Cost { m_kib: 19_456, t: 2, p: 1 };

    fn params(self) -> Result<Params, String> {
        // The explicit constructor, not a builder chain: the output length is the only parameter that
        // must not drift from what the Node binding writes (32 bytes), so it is named here rather than
        // inherited from a default.
        // `None` takes the crate's default output length; the agreement test in `agreement.mts` is what
        // proves it matches what the Node binding writes, rather than this comment asserting it.
        Params::new(self.m_kib, self.t, self.p, None)
            .map_err(|e| format!("argon2 rejected m={},t={},p={}: {e}", self.m_kib, self.t, self.p))
    }

    fn describe(self) -> String {
        format!("argon2id,v=0x13,m={},t={},p={},out={OUTPUT_LEN}", self.m_kib, self.t, self.p)
    }
}

fn parse_args() -> Result<(usize, Cost), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let auto = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut workers = auto;
    // The default is the OWASP upper band, not today's floor: opting in to this worker should be a
    // strengthening, and a caller who wants the old cost says so with --min-cost.
    let mut cost = Cost { m_kib: 65_536, t: 3, p: 4 };
    let usage = "usage: ari-kdf [--workers N] [--memory-kib M] [--time-cost T] [--lanes P] [--match-node]";
    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].as_str();
        if flag == "--match-node" {
            cost = Cost::MIN;
            i += 1;
            continue;
        }
        if matches!(flag, "--help" | "-h") {
            println!("{usage}");
            println!("  default cost   m=65536,t=3,p=4 (OWASP upper band)");
            println!("  --match-node   m=19456,t=2,p=1 — byte-identical to @node-rs/argon2's default");
            println!("  default workers = available parallelism ({auto})");
            std::process::exit(0);
        }
        let value = argv.get(i + 1).cloned().ok_or_else(|| format!("{flag} needs a value"))?;
        i += 2;
        match flag {
            "--workers" => workers = value.parse().map_err(|_| "--workers is not a number")?,
            "--memory-kib" => cost.m_kib = value.parse().map_err(|_| "--memory-kib is not a number")?,
            "--time-cost" => cost.t = value.parse().map_err(|_| "--time-cost is not a number")?,
            "--lanes" => cost.p = value.parse().map_err(|_| "--lanes is not a number")?,
            other => return Err(format!("unrecognised argument {other}\n{usage}")),
        }
    }
    if workers == 0 || workers > 256 {
        return Err("--workers must be between 1 and 256".to_string());
    }
    if cost.m_kib < Cost::MIN.m_kib || cost.t < Cost::MIN.t || cost.p < Cost::MIN.p {
        return Err(format!(
            "refusing to serve a credential weaker than the floor m={},{},{} (asked m={},{},{}) — \
             pass --match-node to run at the status quo",
            Cost::MIN.m_kib, Cost::MIN.t, Cost::MIN.p, cost.m_kib, cost.t, cost.p
        ));
    }
    Ok((workers, cost))
}

/// One request line in, one response line out. Never panics, never blocks past its own work.
fn handle(line: &str, default: Cost, workers: usize) -> String {
    let fields: Vec<&str> = line.split('\t').collect();
    let verb = *fields.first().unwrap_or(&"");
    let id = fields.get(1).copied().unwrap_or("?");
    match verb {
        "H" => {
            let Some(secret) = fields.get(2).copied() else {
                return format!("H\t{id}\terr\thash wants a secret");
            };
            let (m, t, p) = match (fields.get(3), fields.get(4), fields.get(5)) {
                (Some(m), Some(t), Some(p)) => (
                    m.parse().unwrap_or(default.m_kib),
                    t.parse().unwrap_or(default.t),
                    p.parse().unwrap_or(default.p),
                ),
                _ => (default.m_kib, default.t, default.p),
            };
            let cost = Cost { m_kib: m, t, p };
            if cost.m_kib < Cost::MIN.m_kib || cost.t < Cost::MIN.t || cost.p < Cost::MIN.p {
                return format!(
                    "H\t{id}\terr\trefusing m={m},t={t},p={p} below the floor {}",
                    Cost::MIN.describe()
                );
            }
            let Ok(params) = cost.params() else {
                return format!("H\t{id}\terr\tcould not build params for m={m},t={t},p={p}");
            };
            // The salt is generated here and is never accepted from the caller. A credential re-minted
            // under stronger parameters must get a *fresh* salt, so an explicit-salt path would only
            // ever be a way to reuse one — which is the mistake, not the feature.
            match Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password(secret.as_bytes()) {
                Ok(phs) => format!("H\t{id}\t{phs}"),
                Err(e) => format!("H\t{id}\terr\thash failed: {e}"),
            }
        }
        "V" => {
            let (Some(phc), Some(secret)) = (fields.get(2).copied(), fields.get(3).copied()) else {
                return format!("V\t{id}\terr\tverify wants a phc string and a secret");
            };
            let Ok(parsed) = PasswordHash::new(phc) else {
                // A stored hash that does not parse is a data defect, not an authentication failure, and
                // the two must not answer the same way: a caller that treats `err` as `bad` would
                // silently log a person out forever on a corrupt row.
                return format!("V\t{id}\terr\tmalformed PHC string in the database");
            };
            if !parsed.algorithm.as_str().eq_ignore_ascii_case("argon2id") {
                return format!("V\t{id}\terr\tstored hash is {}, not argon2id", parsed.algorithm);
            }
            match Argon2::default().verify_password(secret.as_bytes(), &parsed) {
                Ok(()) => {
                    // Parameters come out of the stored hash, so a credential minted under the old
                    // defaults still authenticates after the deployment raises them — and `migrate=` is
                    // how the caller learns it should re-mint on next use.
                    let stored_m = phc
                        .split('$')
                        .find(|segment| segment.starts_with("m="))
                        .and_then(|params| {
                            params[2..].split(',').next()
                        })
                        .and_then(|m| m.parse::<u32>().ok());
                    // A hash whose parameters cannot be read is reported as needing no migration: the
                    // answer to "is this weaker" when the question is unanswerable is not a re-mint
                    // triggered on every login.
                    let weaker = stored_m.map(|m| m < default.m_kib).unwrap_or(false);
                    format!("V\t{id}\tok\tmigrate={weaker}")
                }
                Err(_) => format!("V\t{id}\tbad"),
            }
        }
        "P" => format!("P\t{id}\t{workers}\t{}", default.describe()),
        other => format!("E\t{id}\terr\tunknown verb {other}"),
    }
}

fn main() {
    let (workers, cost) = match parse_args() {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("ari-kdf: {message}");
            std::process::exit(2);
        }
    };
    // Announce what this process enforces. A credential gate whose strength is invisible is the
    // situation this crate exists to end.
    eprintln!("ari-kdf: workers={workers} cost={} floor={}", cost.describe(), Cost::MIN.describe());

    let (jobs_tx, jobs_rx) = mpsc::channel::<String>();
    let (res_tx, res_rx) = mpsc::channel::<String>();
    let jobs = Arc::new(Mutex::new(jobs_rx));
    let results = Arc::new(res_tx);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let jobs = Arc::clone(&jobs);
            let results = Arc::clone(&results);
            scope.spawn(move || loop {
                // Taking a job under the lock and doing the work outside it is the whole design: the
                // critical section is a queue pop, so N threads means N concurrent derivations.
                let job = match jobs.lock() {
                    Ok(guard) => match guard.recv() {
                        Ok(job) => Some(job),
                        Err(_) => None,
                    },
                    // A poisoned mutex means another worker panicked while holding the queue. Nothing
                    // after this point can trust it, so this worker stops rather than hand out a
                    // half-taken job.
                    Err(_) => None,
                };
                let Some(job) = job else { break };
                let response = match catch_unwind(AssertUnwindSafe(|| handle(&job, cost, workers))) {
                    Ok(text) => text,
                    Err(_) => format!("E\t?\terr\tworker panicked; the request failed, the process did not"),
                };
                if results.send(response).is_err() {
                    break;
                }
            });
        }

        // Keep the queue's Receiver alive for the life of the process: workers must block on `recv`
        // rather than watch the channel close while stdin is still open. The leak is one mutex and a
        // channel, bounded and intentional — the alternative is a worker pool that quits early, which
        // reads as an idle process to whoever is watching it.
        // Release this frame's handle to the result sender *now*. The writer loop below runs on this
        // same thread, and while it held an Arc to the sender the channel could never close, so
        // `recv()` blocked forever after every worker had exited — a process that answers every request
        // and then refuses to die. That is what happened on the first run of this binary.
        drop(results);

        std::mem::forget(Arc::clone(&jobs));

        scope.spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let line = line.trim_end_matches(['\n', '\r']).to_string();
                if line.is_empty() {
                    continue;
                }
                if line == "BYE" {
                    break;
                }
                if jobs_tx.send(line).is_err() {
                    break;
                }
            }
            // Dropping `jobs_tx` closes the queue, so the workers' `recv()` returns Err and they exit,
            // which closes `res_tx` and lets the writer loop below finish. Without this the process
            // would sit waiting for input that stopped at EOF.
        });

        let stdout = Arc::new(Mutex::new(std::io::stdout()));
        while let Ok(response) = res_rx.recv() {
            if let Ok(mut guard) = stdout.lock() {
                let _ = writeln!(guard, "{response}");
                // A caller reading line-by-line must not wait for a buffer to fill.
                let _ = guard.flush();
            }
        }
    });
}
