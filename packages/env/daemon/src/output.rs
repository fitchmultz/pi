//! The single writer of stdout. Control frames (results, errors, pings, watch events) always go before bulk command
//! output, so a slow link delays output but never a cancel's result or a ping. Bulk output is bounded: readers of
//! commands without an output window wait while too much of it is unsent, which slows the command down like a full
//! pipe would.

use crate::frame::{self, Frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Unsent bulk bytes above which unwindowed command output waits.
const BULK_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Queues {
    control: VecDeque<Frame>,
    bulk: VecDeque<(Frame, Option<Arc<AtomicUsize>>)>,
    bulk_bytes: usize,
    closed: bool,
}

#[derive(Default)]
pub struct Output {
    queues: Mutex<Queues>,
    /// Signalled when a frame is queued or the writer stops.
    queued: Condvar,
    /// Signalled when bulk bytes were written.
    drained: Condvar,
}

impl Output {
    pub fn control(&self, frame: Frame) {
        let mut queues = self.queues.lock().unwrap();
        queues.control.push_back(frame);
        self.queued.notify_one();
    }

    /// Queue bulk output; `unsent` counts this sender's frames until they are written.
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        let mut queues = self.queues.lock().unwrap();
        queues.bulk_bytes += frame.payload.len();
        if let Some(counter) = &unsent {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        queues.bulk.push_back((frame, unsent));
        self.queued.notify_one();
    }

    /// Wait while more than the bulk limit is unsent, unless `stop` is set.
    fn wait_for_room(&self, stop: &AtomicBool) {
        let mut queues = self.queues.lock().unwrap();
        while queues.bulk_bytes > BULK_LIMIT && !queues.closed && !stop.load(Ordering::SeqCst) {
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    pub fn close(&self) {
        let mut queues = self.queues.lock().unwrap();
        queues.closed = true;
        self.queued.notify_all();
        self.drained.notify_all();
    }

    /// Write frames to `writer` until closed or a write fails.
    pub fn run(&self, writer: &mut impl Write) {
        loop {
            let (frame, unsent) = {
                let mut queues = self.queues.lock().unwrap();
                loop {
                    if let Some(frame) = queues.control.pop_front() {
                        break (frame, None);
                    }
                    if let Some((frame, unsent)) = queues.bulk.pop_front() {
                        queues.bulk_bytes -= frame.payload.len();
                        break (frame, unsent);
                    }
                    if queues.closed {
                        return;
                    }
                    queues = self.queued.wait(queues).unwrap();
                }
            };
            let failed = frame::write_frame(writer, &frame).is_err();
            if let Some(counter) = unsent {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            self.drained.notify_all();
            if failed {
                self.close();
                return;
            }
        }
    }
}

/// Backpressure for the readers of one command: like a full pipe, a reader that read a chunk waits for room before it
/// reads the next. A reader counts as held while it hands a chunk over and waits, so the command can tell a reader the
/// link holds up from a pipe that went silent. Recording the last release time ensures a reader that waited through
/// most of the post-exit grace period still gets a full unblocked grace window after backpressure clears.
#[derive(Clone)]
pub struct Gate {
    output: Arc<Output>,
    held: Arc<AtomicUsize>,
    released_at: Arc<Mutex<Option<Instant>>>,
}

impl Gate {
    pub fn new(output: &Arc<Output>) -> Gate {
        Gate {
            output: output.clone(),
            held: Arc::new(AtomicUsize::new(0)),
            released_at: Arc::new(Mutex::new(None)),
        }
    }

    /// Run `deliver` for a chunk just read, then wait for room unless `stop` is set; returns what `deliver` returned.
    pub fn pass(&self, stop: &AtomicBool, deliver: impl FnOnce() -> bool) -> bool {
        self.held.fetch_add(1, Ordering::SeqCst);
        let delivered = deliver();
        self.output.wait_for_room(stop);
        *self.released_at.lock().unwrap() = Some(Instant::now());
        self.held.fetch_sub(1, Ordering::SeqCst);
        delivered
    }

    /// If a reader is currently held or left backpressure less than `grace` ago, returns the extended post-exit
    /// deadline so silence while the link stalled never cuts short the reader's grace window to drain the pipe.
    pub fn extend_grace(&self, now: Instant, grace: Duration) -> Option<Instant> {
        if self.held.load(Ordering::SeqCst) > 0 {
            return Some(now + grace);
        }
        let released = *self.released_at.lock().unwrap();
        released
            .map(|at| at + grace)
            .filter(|deadline| *deadline > now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::EVENT;
    use serde_json::json;
    use std::thread;

    #[test]
    fn extend_grace_covers_full_window_after_backpressure_release() {
        let output = Arc::new(Output::default());
        // Exceed BULK_LIMIT so Gate::pass blocks in wait_for_room.
        output.bulk(
            Frame::with_payload(EVENT, 1, json!({}), vec![0u8; BULK_LIMIT + 1]),
            None,
        );
        let gate = Gate::new(&output);
        let stop = Arc::new(AtomicBool::new(false));
        let delivered = Arc::new(AtomicBool::new(false));

        let reader = {
            let gate = gate.clone();
            let stop = stop.clone();
            let delivered = delivered.clone();
            thread::spawn(move || {
                gate.pass(&stop, || {
                    delivered.store(true, Ordering::SeqCst);
                    true
                });
            })
        };

        while !delivered.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        let grace = Duration::from_millis(100);
        let start = Instant::now();
        assert!(gate.extend_grace(start, grace).is_some());

        // Simulate the reader spending most of the grace window blocked, then releasing just before the deadline.
        thread::sleep(Duration::from_millis(60));
        output.close();
        reader.join().unwrap();

        // At the original deadline (start + grace), held is already 0, yet less than a full grace has elapsed
        // since release, so extend_grace must still extend past start + grace.
        let check = start + grace;
        let extended = gate.extend_grace(check, grace);
        assert!(
            extended.is_some_and(|deadline| deadline > check),
            "expected grace extension after recent backpressure release, got {extended:?}"
        );

        // Once a full grace window has elapsed after release, extend_grace returns None.
        let after_full_grace = extended.unwrap() + Duration::from_millis(1);
        assert_eq!(gate.extend_grace(after_full_grace, grace), None);
    }
}
