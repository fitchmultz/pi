//! pi-env: a small daemon that gives a Pi Durable host an execution environment on this machine over stdin/stdout
//! (docs/protocol.md). Started as `pi-env serve --token <hex>`, usually through `ssh`.

mod decode;
mod errors;
mod exec;
mod frame;
mod fs;
mod scan;
mod sys;

use errors::Failure;
use frame::{CANCEL, ERROR, Frame, PING, REQUEST, RESULT};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::env;
use std::fs::{File, ReadDir};
use std::io::{self, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROTOCOL: u64 = 1;
const PING_INTERVAL: Duration = Duration::from_secs(5);
const SILENCE_LIMIT_MS: u64 = 30_000;
const SCAN_CHUNK: usize = 64 * 1024;

enum Handle {
    File(Arc<File>, String),
    Dir(Box<ReadDir>, String),
}

enum Cancel {
    Flag(Arc<AtomicBool>),
    Exec(Sender<exec::Message>),
}

struct Server {
    out: Sender<Frame>,
    tmpdir: String,
    handles: Mutex<HashMap<u64, Handle>>,
    next_handle: AtomicU64,
    cancels: Mutex<HashMap<u32, Cancel>>,
    groups: exec::Groups,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn field<'a>(json: &'a Value, key: &str) -> Result<&'a str, Failure> {
    json[key]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing field {key}")))
}

fn number(json: &Value, key: &str) -> Result<u64, Failure> {
    json[key]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing or invalid field {key}")))
}

impl Server {
    fn handle(&self, json: &Value) -> Result<Handle, Failure> {
        let id = number(json, "handle")?;
        let handles = self.handles.lock().unwrap();
        match handles.get(&id) {
            Some(Handle::File(file, path)) => Ok(Handle::File(file.clone(), path.clone())),
            Some(Handle::Dir(..)) => Err(Failure::new("EBADF", "not a file handle")),
            None => Err(Failure::new("EBADF", "unknown handle")),
        }
    }

    fn file(&self, json: &Value) -> Result<(Arc<File>, String), Failure> {
        match self.handle(json)? {
            Handle::File(file, path) => Ok((file, path)),
            Handle::Dir(..) => Err(Failure::new("EBADF", "not a file handle")),
        }
    }

    fn insert(&self, handle: Handle) -> u64 {
        let id = self.next_handle.fetch_add(1, Ordering::Relaxed);
        self.handles.lock().unwrap().insert(id, handle);
        id
    }

    fn dispatch(
        &self,
        id: u32,
        json: &Value,
        payload: Vec<u8>,
    ) -> Result<(Value, Vec<u8>), Failure> {
        let op = json["op"].as_str().unwrap_or_default();
        let plain = |value: Result<Value, Failure>| value.map(|value| (value, Vec::new()));
        match op {
            "hello" => plain(Ok(json!({
                "protocol": PROTOCOL,
                "version": env!("CARGO_PKG_VERSION"),
                "os": env::consts::OS,
                "arch": env::consts::ARCH,
                "home": sys::home(),
                "separator": sys::PATH_SEPARATOR,
                "tmpdir": self.tmpdir,
                "pid": std::process::id(),
            }))),
            "lstat" => plain(fs::lstat(field(json, "path")?)),
            "realpath" => plain(fs::realpath(field(json, "path")?)),
            "write" => plain(fs::write(
                field(json, "path")?,
                json["append"].as_bool().unwrap_or(false),
                &payload,
            )),
            "truncate" => plain(fs::truncate(field(json, "path")?, number(json, "size")?)),
            "fsync" => plain(fs::fsync(field(json, "path")?)),
            "rename" => plain(fs::rename(field(json, "path")?, field(json, "to")?)),
            "mkdir" => plain(fs::mkdir(
                field(json, "path")?,
                json["recursive"].as_bool().unwrap_or(false),
            )),
            "rm" => plain(fs::rm(
                field(json, "path")?,
                json["recursive"].as_bool().unwrap_or(false),
                json["force"].as_bool().unwrap_or(false),
            )),
            "mkdtemp" => plain(fs::mkdtemp(field(json, "path")?)),
            "open" => {
                let path = field(json, "path")?;
                let (file, info) =
                    fs::open_reader(path, json["noFollow"].as_bool().unwrap_or(false))?;
                let handle = self.insert(Handle::File(Arc::new(file), path.to_string()));
                plain(Ok(json!({ "handle": handle, "info": info })))
            }
            "pread" => {
                let (file, path) = self.file(json)?;
                let length = (number(json, "length")? as usize).min(frame::MAX_PAYLOAD);
                Ok((
                    json!({}),
                    fs::pread(&file, &path, number(json, "offset")?, length)?,
                ))
            }
            "fstat" => {
                let (file, path) = self.file(json)?;
                let metadata = file
                    .metadata()
                    .map_err(|error| Failure::io(&error, "fstat", &path))?;
                plain(Ok(fs::info(&path, &metadata)))
            }
            "scanLines" => {
                let (file, path) = self.file(json)?;
                plain(self.scan_lines(id, &file, &path, json))
            }
            "opendir" => {
                let path = field(json, "path")?;
                let dir = std::fs::read_dir(path)
                    .map_err(|error| Failure::io(&error, "opendir", path))?;
                let handle = self.insert(Handle::Dir(Box::new(dir), path.to_string()));
                plain(Ok(json!({ "handle": handle })))
            }
            "readdir" => plain(self.read_dir(json)),
            "close" => {
                self.handles
                    .lock()
                    .unwrap()
                    .remove(&number(json, "handle")?);
                plain(Ok(json!({})))
            }
            "exec" => {
                let request = exec::ExecRequest::from_json(json)?;
                let (sender, receiver) = mpsc::channel();
                self.cancels
                    .lock()
                    .unwrap()
                    .insert(id, Cancel::Exec(sender.clone()));
                plain(exec::run(
                    id,
                    request,
                    &self.tmpdir,
                    &self.out,
                    (sender, receiver),
                    &self.groups,
                ))
            }
            _ => Err(Failure::new("EINVAL", format!("unknown operation {op}"))),
        }
    }

    fn scan_lines(&self, id: u32, file: &File, path: &str, json: &Value) -> Result<Value, Failure> {
        let start_line = number(json, "startLine")?;
        let end_line = json["endLine"].as_u64();
        if end_line.is_some_and(|end| end <= start_line) {
            return Err(Failure::new("EINVAL", "Invalid line range"));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .unwrap()
            .insert(id, Cancel::Flag(cancelled.clone()));
        let mut scanner = scan::LineScanner::new(start_line, end_line);
        let mut buffer = vec![0u8; SCAN_CHUNK];
        let mut position = 0u64;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err(Failure::new("aborted", "aborted"));
            }
            let read = sys::read_at(file, &mut buffer, position)
                .map_err(|error| Failure::io(&error, "read", path))?;
            if read == 0 {
                return Ok(scanner.finish());
            }
            scanner.push(&buffer[..read]);
            position += read as u64;
        }
    }

    fn read_dir(&self, json: &Value) -> Result<Value, Failure> {
        let id = number(json, "handle")?;
        let max = number(json, "max")?.max(1) as usize;
        let mut handles = self.handles.lock().unwrap();
        let Some(Handle::Dir(dir, path)) = handles.get_mut(&id) else {
            return Err(Failure::new("EBADF", "not a directory handle"));
        };
        let mut entries = Vec::new();
        let mut done = false;
        while entries.len() < max {
            match dir.next() {
                None => {
                    done = true;
                    break;
                }
                Some(Err(error)) => return Err(Failure::io(&error, "readdir", path)),
                Some(Ok(entry)) => {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let entry_path = entry.path().to_string_lossy().into_owned();
                    entries.push(match std::fs::symlink_metadata(entry.path()) {
                        Ok(metadata) => json!({ "name": name, "info": fs::info(&entry_path, &metadata) }),
                        Err(error) => json!({ "name": name, "error": Failure::io(&error, "lstat", &entry_path).to_json() }),
                    });
                }
            }
        }
        Ok(json!({ "entries": entries, "done": done }))
    }
}

fn kill_all(groups: &exec::Groups) {
    for pid in groups.lock().unwrap().iter() {
        exec::kill_group(*pid);
    }
}

fn serve(token: &str) -> io::Result<()> {
    let stdout = io::stdout();
    {
        let mut lock = stdout.lock();
        writeln!(lock, "PI-ENV {token}")?;
        lock.flush()?;
    }
    let (out, frames) = mpsc::channel::<Frame>();
    thread::spawn(move || {
        let mut writer = BufWriter::with_capacity(1 << 20, io::stdout().lock());
        for frame in frames {
            if frame::write_frame(&mut writer, &frame).is_err() {
                break;
            }
        }
    });
    let server = Arc::new(Server {
        out: out.clone(),
        tmpdir: sys::tmpdir(),
        handles: Mutex::new(HashMap::new()),
        next_handle: AtomicU64::new(1),
        cancels: Mutex::new(HashMap::new()),
        groups: Arc::new(Mutex::new(Default::default())),
    });
    let last_seen = Arc::new(AtomicU64::new(now_ms()));
    {
        let out = out.clone();
        let last_seen = last_seen.clone();
        let groups = server.groups.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(PING_INTERVAL);
                let _ = out.send(Frame::new(PING, 0, json!({})));
                // A client that went silent (a phone that lost its network) leaves nothing running.
                if now_ms().saturating_sub(last_seen.load(Ordering::Relaxed)) > SILENCE_LIMIT_MS {
                    kill_all(&groups);
                    std::process::exit(0);
                }
            }
        });
    }
    let mut input = BufReader::with_capacity(1 << 20, io::stdin().lock());
    while let Some(request) = frame::read_frame(&mut input)? {
        last_seen.store(now_ms(), Ordering::Relaxed);
        match request.kind {
            REQUEST => {
                let server = server.clone();
                thread::spawn(move || {
                    let id = request.id;
                    let reply = match server.dispatch(id, &request.json, request.payload) {
                        Ok((json, payload)) => Frame::with_payload(RESULT, id, json, payload),
                        Err(failure) => Frame::new(ERROR, id, failure.to_json()),
                    };
                    server.cancels.lock().unwrap().remove(&id);
                    let _ = server.out.send(reply);
                });
            }
            CANCEL => match server.cancels.lock().unwrap().get(&request.id) {
                Some(Cancel::Exec(sender)) => {
                    let kill = request.json["mode"].as_str() == Some("kill");
                    let _ = sender.send(if kill {
                        exec::Message::Kill
                    } else {
                        exec::Message::Cancel
                    });
                }
                Some(Cancel::Flag(flag)) => flag.store(true, Ordering::Relaxed),
                None => {}
            },
            _ => {}
        }
    }
    // The client is gone: stop everything it started.
    kill_all(&server.groups);
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            let token = args
                .iter()
                .position(|arg| arg == "--token")
                .and_then(|index| args.get(index + 1));
            let Some(token) = token else {
                eprintln!("usage: pi-env serve --token <hex>");
                std::process::exit(2);
            };
            if let Err(error) = serve(token) {
                eprintln!("pi-env: {error}");
                std::process::exit(1);
            }
        }
        Some("--version") => println!("pi-env {}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("usage: pi-env serve --token <hex>");
            std::process::exit(2);
        }
    }
}
