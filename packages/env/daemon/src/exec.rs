//! `exec`: Durable's `NodeExecutionEnv.exec` semantics (docs/semantics.md), output streamed as `output` events.

use crate::decode::StreamDecoder;
use crate::errors::Failure;
use crate::frame::{EVENT, Frame};
use crate::sys;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);
const READ_CHUNK: usize = 64 * 1024;

/// Commands this daemon started and has not reaped; killed when the connection ends.
pub type Groups = Arc<Mutex<HashSet<u32>>>;

pub enum Message {
    Data(usize, Vec<u8>),
    Eof(usize),
    Exit(ExitStatus),
    WaitFailed(String),
    /// Abort: the command settles as `aborted`.
    Cancel,
    /// Kill without aborting, as `cleanup()` does: the command settles with the killed process's status.
    Kill,
}

pub struct ExecRequest {
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub cwd: String,
    pub env: Map<String, Value>,
    pub inherit_env: bool,
    pub shell_path: Option<String>,
    pub timeout: Option<Duration>,
    pub spill: Option<(u64, u64)>,
}

impl ExecRequest {
    pub fn from_json(json: &Value) -> Result<ExecRequest, Failure> {
        let strings = |value: &Value| -> Option<Vec<String>> {
            value
                .as_array()?
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect()
        };
        Ok(ExecRequest {
            command: json["command"].as_str().map(str::to_string),
            argv: strings(&json["argv"]),
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "exec needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            shell_path: json["shellPath"].as_str().map(str::to_string),
            timeout: json["timeoutMs"]
                .as_f64()
                .map(|ms| Duration::from_secs_f64(ms / 1000.0)),
            spill: json["spill"].as_object().and_then(|spill| {
                Some((
                    spill.get("afterBytes")?.as_u64()?,
                    spill.get("afterLines")?.as_u64()?,
                ))
            }),
        })
    }
}

pub fn kill_group(pid: u32) {
    sys::kill_tree(pid);
}

fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut random) = File::open("/dev/urandom") {
        let _ = random.read_exact(&mut bytes);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Spill of the complete raw output, started once it crosses either threshold, like Node's.
struct Spill {
    after_bytes: u64,
    after_lines: u64,
    seen_bytes: u64,
    seen_newlines: u64,
    prefix: Vec<Vec<u8>>,
    file: Option<File>,
    path: Option<String>,
    failed: Option<String>,
}

impl Spill {
    fn push(&mut self, chunk: &[u8], tmpdir: &str) {
        if self.failed.is_some() || chunk.is_empty() {
            return;
        }
        if self.file.is_none() {
            self.seen_bytes += chunk.len() as u64;
            self.seen_newlines += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
            let lines = self.seen_newlines + u64::from(chunk.last() != Some(&b'\n'));
            if self.seen_bytes <= self.after_bytes && lines <= self.after_lines {
                self.prefix.push(chunk.to_vec());
                return;
            }
            if let Err(error) = self.start(tmpdir) {
                self.failed = Some(error);
                return;
            }
        }
        if let Some(file) = &mut self.file
            && let Err(error) = file.write_all(chunk)
        {
            self.failed = Some(error.to_string());
        }
    }

    /// `createTempFile({ prefix: "pi-output-", suffix: ".log" })`: a fresh `tmp-` directory holding the file.
    fn start(&mut self, tmpdir: &str) -> Result<(), String> {
        let directory =
            crate::fs::mkdtemp(&format!("{tmpdir}/tmp-")).map_err(|failure| failure.message)?;
        let directory = directory["path"].as_str().unwrap_or_default().to_string();
        let path = format!("{directory}/pi-output-{}.log", random_uuid());
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        for chunk in self.prefix.drain(..) {
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        self.file = Some(file);
        self.path = Some(path);
        Ok(())
    }
}

fn spawn_reader(stream: usize, mut pipe: impl Read + Send + 'static, sender: Sender<Message>) {
    thread::spawn(move || {
        let mut buffer = vec![0u8; READ_CHUNK];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender
                        .send(Message::Data(stream, buffer[..read].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = sender.send(Message::Eof(stream));
    });
}

fn spawn(
    request: &ExecRequest,
    program: &str,
    args: &[String],
    piped_stdin: bool,
) -> std::io::Result<Child> {
    let mut command = Command::new(program);
    command
        .current_dir(&request.cwd)
        .stdin(if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::configure(&mut command, args, &request.env, request.inherit_env);
    let child = command.spawn()?;
    sys::after_spawn(&child);
    Ok(child)
}

/// Run one command, sending output events for request `id`, until it settles.
pub fn run(
    id: u32,
    request: ExecRequest,
    tmpdir: &str,
    out: &Sender<Frame>,
    messages: (Sender<Message>, Receiver<Message>),
    groups: &Groups,
) -> Result<Value, Failure> {
    // A string runs through the shell (as its last argument, or on stdin for legacy WSL bash); argv runs directly.
    let (program, args, stdin_command) = match (&request.command, &request.argv) {
        (Some(command), _) => {
            let shell = sys::shell_config(request.shell_path.as_deref())?;
            let mut args = shell.args;
            if shell.command_on_stdin {
                (shell.program, args, Some(command.clone()))
            } else {
                args.push(command.clone());
                (shell.program, args, None)
            }
        }
        (None, Some(argv)) => match argv.split_first() {
            Some((first, rest)) => (first.clone(), rest.to_vec(), None),
            None => return Err(Failure::new("spawn_error", "Empty argv: no program to run")),
        },
        (None, None) => return Err(Failure::new("EINVAL", "exec needs command or argv")),
    };
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!(
                "Working directory does not exist: {}\nCannot execute bash commands.",
                request.cwd
            ),
        ));
    }
    let (sender, receiver) = messages;
    let mut child = spawn(&request, &program, &args, stdin_command.is_some())
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    if let (Some(command), Some(mut stdin)) = (stdin_command, child.stdin.take()) {
        let _ = stdin.write_all(command.as_bytes());
    }
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let deadline = request.timeout.map(|timeout| Instant::now() + timeout);
    spawn_reader(0, child.stdout.take().unwrap(), sender.clone());
    spawn_reader(1, child.stderr.take().unwrap(), sender.clone());
    let waiter = sender.clone();
    thread::spawn(move || {
        let _ = waiter.send(match child.wait() {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    drop(sender);

    let mut decoders = [StreamDecoder::new(), StreamDecoder::new()];
    let mut spill = request.spill.map(|(after_bytes, after_lines)| Spill {
        after_bytes,
        after_lines,
        seen_bytes: 0,
        seen_newlines: 0,
        prefix: Vec::new(),
        file: None,
        path: None,
        failed: None,
    });
    let emit = |stream: usize, text: String| {
        if !text.is_empty() {
            let name = if stream == 0 { "stdout" } else { "stderr" };
            let _ = out.send(Frame::with_payload(
                EVENT,
                id,
                json!({ "kind": "output", "stream": name }),
                text.into_bytes(),
            ));
        }
    };
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
    let mut timed_out = false;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    loop {
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        let now = Instant::now();
        let mut wait = Duration::from_secs(3600);
        if let Some(deadline) = deadline.filter(|_| !timed_out) {
            wait = wait.min(deadline.saturating_duration_since(now));
        }
        if let Some(idle) = idle_until {
            wait = wait.min(idle.saturating_duration_since(now));
        }
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                emit(stream, decoders[stream].decode(&bytes, false));
                if let Some(spill) = &mut spill {
                    spill.push(&bytes, tmpdir);
                    if spill.failed.is_some() {
                        kill(&mut killed);
                    }
                }
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {
                if deadline.is_some_and(|deadline| Instant::now() >= deadline)
                    && !timed_out
                    && status.is_none()
                {
                    timed_out = true;
                    kill(&mut killed);
                } else if idle_until.is_some_and(|idle| Instant::now() >= idle) {
                    // A descendant may hold the pipes open after the process exited; stop waiting for it.
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    groups.lock().unwrap().remove(&pid);
    emit(0, decoders[0].decode(&[], true));
    emit(1, decoders[1].decode(&[], true));
    let spill_path = spill.as_ref().and_then(|spill| spill.path.clone());
    let with_spill = |failure: Failure| match &spill_path {
        Some(path) => failure.extra(json!({ "spillPath": path })),
        None => failure,
    };
    if timed_out {
        return Err(with_spill(Failure::new("timeout", "timeout")));
    }
    if aborted {
        return Err(with_spill(Failure::new("aborted", "aborted")));
    }
    if let Some(error) = spill.as_ref().and_then(|spill| spill.failed.clone()) {
        return Err(Failure::new(
            "unknown",
            format!("Failed to preserve complete shell output: {error}"),
        ));
    }
    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => return Err(Failure::new("spawn_error", error)),
        None => {
            return Err(Failure::new(
                "spawn_error",
                "process did not report its exit",
            ));
        }
    };
    let mut result = json!({ "exitCode": sys::exit_code(status) });
    if let Some(path) = spill_path {
        result["spillPath"] = json!(path);
    }
    Ok(result)
}
