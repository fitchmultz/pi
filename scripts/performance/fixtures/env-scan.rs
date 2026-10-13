#[path = "/pi-performance-source/packages/env/daemon/src/decode.rs"]
mod decode;
#[path = "/pi-performance-source/packages/env/daemon/src/scan.rs"]
mod scan;
#[path = "/pi-performance-source/packages/env/daemon/src/frame.rs"]
mod frame;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static ALLOC_BYTES: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { unsafe { System.dealloc(ptr, layout) } }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(size, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, size) }
    }
}
#[global_allocator] static ALLOCATOR: Counting = Counting;
fn main() {
    if std::env::args().nth(1).as_deref() == Some("frames") {
        let size: usize = std::env::args().nth(2).unwrap_or("524288".into()).parse().unwrap();
        let count: usize = std::env::args().nth(3).unwrap_or("1000".into()).parse().unwrap();
        let request = frame::Frame::with_payload(frame::REQUEST, 1, serde_json::json!({ "op": "write" }), vec![97; size]);
        let mut wire = Vec::new();
        frame::write_frame(&mut wire, &request).unwrap();
        ALLOCS.store(0, Ordering::Relaxed);
        ALLOC_BYTES.store(0, Ordering::Relaxed);
        let started = Instant::now();
        for _ in 0..count {
            let read = frame::read_frame(&mut wire.as_slice()).unwrap().unwrap();
            assert_eq!(read.payload.len(), size);
            std::hint::black_box(read);
        }
        println!("{{\"frames\":{count},\"payloadBytes\":{size},\"ms\":{},\"allocations\":{},\"allocatedBytes\":{}}}", started.elapsed().as_secs_f64() * 1000.0, ALLOCS.load(Ordering::Relaxed), ALLOC_BYTES.load(Ordering::Relaxed));
        return;
    }
    let count: usize = std::env::args().nth(1).unwrap_or("1000000".into()).parse().unwrap();
    let runs: usize = std::env::args().nth(2).unwrap_or("5".into()).parse().unwrap();
    let input = "é😀\n".repeat(count).into_bytes();
    for _ in 0..runs {
        ALLOCS.store(0, Ordering::Relaxed);
        ALLOC_BYTES.store(0, Ordering::Relaxed);
        let started = Instant::now();
        let mut scanner = scan::LineScanner::new(0, None);
        for chunk in input.chunks(64 * 1024) { scanner.push(chunk); }
        let value = scanner.finish();
        let elapsed = started.elapsed();
        let allocations = ALLOCS.load(Ordering::Relaxed);
        let allocated_bytes = ALLOC_BYTES.load(Ordering::Relaxed);
        assert_eq!(value["newlines"].as_u64(), Some(count as u64));
        assert_eq!(value["selectedBytes"].as_u64(), Some(input.len() as u64));
        assert_eq!(value["firstLineBytes"].as_u64(), Some(6));
        println!("{{\"lines\":{count},\"bytes\":{},\"ms\":{},\"allocations\":{allocations},\"allocatedBytes\":{allocated_bytes}}}", input.len(), elapsed.as_secs_f64() * 1000.0);
        std::hint::black_box(value);
    }
}
