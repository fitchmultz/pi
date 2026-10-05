//! Linux, macOS and Android.

use super::{OpenMode, ShellConfig};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};

/// libuv's name for an OS error.
pub fn error_name(error: &io::Error) -> &'static str {
    let Some(errno) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match errno {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => "UNKNOWN",
    }
}

pub const PATH_SEPARATOR: &str = "/";

pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(buffer, offset)
}

/// Modification time as seconds and nanoseconds since the epoch.
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    (metadata.mtime(), metadata.mtime_nsec())
}

/// Device and inode, which identify a file across renames.
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Node's `os.tmpdir()`; Termux's Node falls back to `$PREFIX/tmp`.
pub fn tmpdir() -> String {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()));
    let mut path = configured.unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            format!(
                "{}/tmp",
                std::env::var("PREFIX")
                    .unwrap_or_else(|_| "/data/data/com.termux/files/usr".into())
            )
        } else {
            "/tmp".into()
        }
    });
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `mkdtemp(3)` of `prefix`, as libuv calls it: six random characters from `[A-Za-z0-9]`.
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    let mut template = prefix.as_bytes().to_vec();
    template.extend_from_slice(b"XXXXXX");
    let template =
        CString::new(template).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut buffer = template.into_bytes_with_nul();
    // SAFETY: `buffer` is a NUL-terminated, writable template that mkdtemp fills in place.
    let created = unsafe { libc::mkdtemp(buffer.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    buffer.pop();
    Ok(OsStr::from_bytes(&buffer).to_string_lossy().into_owned())
}

/// Open a regular file for positional reads, without blocking on FIFOs and, with `no_follow`, without following a
/// final symbolic link.
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    let mut flags = libc::O_NONBLOCK;
    if no_follow {
        flags |= libc::O_NOFOLLOW;
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|error| {
            if no_follow && matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
                Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path)
            } else {
                Failure::io(&error, "open", path)
            }
        })
}

/// Open a file in one of Node's write modes.
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let mut options = OpenOptions::new();
    match mode {
        OpenMode::Write => options.write(true).create(true).truncate(true),
        OpenMode::Append => options.append(true).create(true),
        OpenMode::ReadWrite => options.read(true).write(true),
    };
    options.open(path)
}

pub fn realpath(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|resolved| resolved.to_string_lossy().into_owned())
}

pub fn rename(from: &str, to: &str) -> io::Result<()> {
    std::fs::rename(from, to)
}

pub fn remove_file(path: &str) -> io::Result<()> {
    std::fs::remove_file(path)
}

/// The error a recursive `mkdir` reports when a file is in the way of a parent.
pub fn not_a_directory() -> io::Error {
    io::Error::from_raw_os_error(libc::ENOTDIR)
}

fn path_exists(path: &str) -> bool {
    Path::new(path).symlink_metadata().is_ok()
}

fn which_bash() -> Option<String> {
    let output = Command::new("which")
        .arg("bash")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()?
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node's shell resolution: a configured shell must exist; otherwise `/bin/bash`, `which bash`, then `sh`.
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    let shell = |program: &str| ShellConfig {
        program: program.into(),
        args: vec!["-c".into()],
        command_on_stdin: false,
    };
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(shell(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    if path_exists("/bin/bash") {
        return Ok(shell("/bin/bash"));
    }
    Ok(shell(&which_bash().unwrap_or_else(|| "sh".into())))
}

/// Arguments, environment and process setup as libuv applies them.
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    command.args(args);
    if !inherit_env {
        command.env_clear();
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            command.env(key, value);
        }
    }
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // A new session, so a kill reaches every descendant; default signal handling and an empty mask, as libuv sets.
            libc::setsid();
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}

pub fn after_spawn(_child: &Child) {}

/// Kill the command's process group, or the process if the group is gone.
pub fn kill_tree(pid: u32) {
    let pid = pid as i32;
    // SAFETY: plain signal delivery.
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// A process killed by a signal has no exit code; report 128 + the signal, as the shell does.
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
    )
}
