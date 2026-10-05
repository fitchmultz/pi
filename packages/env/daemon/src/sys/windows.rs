//! Windows, following libuv (`src/win/error.c`, `src/win/process.c`, `src/win/fs.c`) and Node's `child_process`.

use super::{OpenMode, ShellConfig};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::collections::hash_map::RandomState;
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::FileExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_DATA, MOVEFILE_REPLACE_EXISTING, MoveFileExW,
    OPEN_ALWAYS, OPEN_EXISTING,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// libuv's `uv_translate_sys_error` for the errors file and process operations produce.
pub fn error_name(error: &io::Error) -> &'static str {
    let Some(code) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match code {
        1 => "EISDIR",                             // ERROR_INVALID_FUNCTION
        2 | 3 | 15 | 123 | 161 | 4392 => "ENOENT", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, INVALID_NAME, BAD_PATHNAME, INVALID_REPARSE_DATA
        4 => "EMFILE",                             // ERROR_TOO_MANY_OPEN_FILES
        5 | 1314 => "EPERM",                       // ACCESS_DENIED, PRIVILEGE_NOT_HELD
        6 => "EBADF",                              // ERROR_INVALID_HANDLE
        8 | 14 => "ENOMEM",                        // NOT_ENOUGH_MEMORY, OUTOFMEMORY
        17 => "EXDEV",                             // ERROR_NOT_SAME_DEVICE
        19 => "EROFS",                             // ERROR_WRITE_PROTECT
        32 | 33 => "EBUSY",                        // SHARING_VIOLATION, LOCK_VIOLATION
        39 | 82 | 112 => "ENOSPC",                 // HANDLE_DISK_FULL, CANNOT_MAKE, DISK_FULL
        50 => "ENOTSUP",                           // ERROR_NOT_SUPPORTED
        80 | 183 => "EEXIST",                      // FILE_EXISTS, ALREADY_EXISTS
        87 | 131 | 1464 => "EINVAL", // INVALID_PARAMETER, NEGATIVE_SEEK, SYMLINK_NOT_SUPPORTED
        145 => "ENOTEMPTY",          // ERROR_DIR_NOT_EMPTY
        206 => "ENAMETOOLONG",       // ERROR_FILENAME_EXCED_RANGE
        267 => "ENOTDIR",            // ERROR_DIRECTORY
        740 | 998 | 1920 => "EACCES", // ELEVATION_REQUIRED, NOACCESS, CANT_ACCESS_FILE
        1921 => "ELOOP",             // ERROR_CANT_RESOLVE_FILENAME
        _ => "UNKNOWN",
    }
}

pub const PATH_SEPARATOR: &str = "\\";

pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.seek_read(buffer, offset)
}

pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    match metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    {
        Some(elapsed) => (elapsed.as_secs() as i64, i64::from(elapsed.subsec_nanos())),
        None => (0, 0),
    }
}

/// Windows file identities need a handle per file; watching compares kind, size and time instead.
pub fn identity(_metadata: &Metadata) -> (u64, u64) {
    (0, 0)
}

/// Node's `os.tmpdir()` on Windows.
pub fn tmpdir() -> String {
    let variable = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    let mut path = variable("TEMP")
        .or_else(|| variable("TMP"))
        .unwrap_or_else(|| {
            format!(
                "{}\\temp",
                variable("SystemRoot")
                    .or_else(|| variable("windir"))
                    .unwrap_or_default()
            )
        });
    if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
        path.pop();
    }
    path
}

/// libuv's `uv_os_homedir`: `USERPROFILE` first.
pub fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// libuv's `fs__mkdtemp`: `prefix` plus six characters from `[a-zA-Z0-9]`, retried while the name exists.
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    const CHARACTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let state = RandomState::new();
    for _ in 0..1000 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        let mut random = hasher.finish();
        let mut path = prefix.to_string();
        for _ in 0..6 {
            path.push(CHARACTERS[(random % CHARACTERS.len() as u64) as usize] as char);
            random /= CHARACTERS.len() as u64;
        }
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from_raw_os_error(80))
}

/// Windows cannot open a directory as a file and has no `O_NOFOLLOW`: check the path first, as `NodeExecutionEnv` does
/// there (not race-free).
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    if no_follow
        && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path));
    }
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    File::open(path).map_err(|error| Failure::io(&error, "open", path))
}

/// libuv's `fs__open` for Node's write modes: `CreateFileW` with its access, sharing and disposition, always with
/// `FILE_FLAG_BACKUP_SEMANTICS`, so a directory opens and later calls on it fail as in Node; creating a file where a
/// directory exists reports `EISDIR`. (Rust's `File::create` opens with `OPEN_ALWAYS` and truncates afterwards.)
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let (access, disposition) = match mode {
        OpenMode::Write => (FILE_GENERIC_WRITE, CREATE_ALWAYS),
        OpenMode::Append => (
            (FILE_GENERIC_WRITE & !FILE_WRITE_DATA) | FILE_APPEND_DATA,
            OPEN_ALWAYS,
        ),
        OpenMode::ReadWrite => (FILE_GENERIC_READ | FILE_GENERIC_WRITE, OPEN_EXISTING),
    };
    let name = wide(path);
    // SAFETY: a NUL-terminated wide path; the returned handle is owned by the File on success.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        // ERROR_FILE_EXISTS while creating means the path is a directory; ERROR_INVALID_FUNCTION names EISDIR.
        if error.raw_os_error() == Some(80) && !matches!(mode, OpenMode::ReadWrite) {
            return Err(io::Error::from_raw_os_error(1));
        }
        return Err(error);
    }
    // SAFETY: `handle` is a valid, owned file handle.
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

/// libuv's `uv_fs_realpath`: the final path without the `\\?\` prefix.
pub fn realpath(path: &str) -> io::Result<String> {
    let resolved = std::fs::canonicalize(path)?.to_string_lossy().into_owned();
    Ok(if let Some(unc) = resolved.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        resolved
            .strip_prefix("\\\\?\\")
            .map(str::to_string)
            .unwrap_or(resolved)
    })
}

/// libuv's `fs__rename`: `MoveFileExW` replacing an existing destination.
pub fn rename(from: &str, to: &str) -> io::Result<()> {
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both arguments are NUL-terminated wide strings that outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Node's `rm` on Windows retries a read-only file after making it writable.
pub fn remove_file(path: &str) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = std::fs::metadata(path)?.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
            std::fs::remove_file(path)
        }
        other => other,
    }
}

/// The error a recursive `mkdir` reports when a file is in the way of a parent.
pub fn not_a_directory() -> io::Error {
    io::Error::from_raw_os_error(267)
}

fn path_exists(path: &str) -> bool {
    Path::new(path).symlink_metadata().is_ok()
}

/// Node's `isLegacyWslBashPath`: `^[a-z]:\\windows\\(system32|sysnative)\\bash\.exe$`, case-insensitive.
fn is_legacy_wsl_bash(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_lowercase();
    let mut characters = normalized.chars();
    characters
        .next()
        .is_some_and(|drive| drive.is_ascii_lowercase())
        && matches!(
            characters.as_str(),
            ":\\windows\\system32\\bash.exe" | ":\\windows\\sysnative\\bash.exe"
        )
}

fn bash_config(program: &str) -> ShellConfig {
    if is_legacy_wsl_bash(program) {
        ShellConfig {
            program: program.into(),
            args: vec!["-s".into()],
            command_on_stdin: true,
        }
    } else {
        ShellConfig {
            program: program.into(),
            args: vec!["-c".into()],
            command_on_stdin: false,
        }
    }
}

fn where_bash() -> Option<String> {
    let output = Command::new("where")
        .arg("bash.exe")
        .creation_flags(CREATE_NO_WINDOW)
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
        .trim()
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node's shell resolution on Windows: a configured shell, Git Bash, `where bash.exe`, or `shell_unavailable`.
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(bash_config(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(directory) = std::env::var(variable) {
            candidates.push(format!("{directory}\\Git\\bin\\bash.exe"));
        }
    }
    if let Some(found) = candidates.iter().find(|candidate| path_exists(candidate)) {
        return Ok(bash_config(found));
    }
    if let Some(found) = where_bash() {
        return Ok(bash_config(&found));
    }
    let searched: String = candidates
        .iter()
        .map(|candidate| format!("  {candidate}\n"))
        .collect();
    Err(Failure::new(
        "shell_unavailable",
        format!(
            "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Configure an explicit shellPath\n\nSearched Git Bash in:\n{}",
            searched.trim_end()
        ),
    ))
}

/// libuv's `quote_cmd_arg`: how one argument is written into the command line the child splits again.
pub fn quote_argument(argument: &str) -> String {
    if argument.is_empty() {
        return "\"\"".into();
    }
    if !argument.contains([' ', '\t', '"']) {
        return argument.into();
    }
    if !argument.contains(['"', '\\']) {
        return format!("\"{argument}\"");
    }
    // Walk backwards: backslashes before a quote (or the closing quote) are doubled, and quotes are escaped.
    let mut reversed = Vec::new();
    let mut quote_hit = true;
    for character in argument.chars().rev() {
        reversed.push(character);
        if quote_hit && character == '\\' {
            reversed.push('\\');
        } else if character == '"' {
            quote_hit = true;
            reversed.push('\\');
        } else {
            quote_hit = false;
        }
    }
    let mut quoted = String::from("\"");
    quoted.extend(reversed.into_iter().rev());
    quoted.push('"');
    quoted
}

/// Variables libuv copies from the parent into every child environment that lacks them.
const REQUIRED_VARIABLES: [&str; 11] = [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

/// The child environment as Node builds it on Windows: the variables in object order, sorted by UTF-16 code units,
/// keeping the first of names that differ only in case; then libuv adds required variables the result lacks.
fn child_environment(env: &Map<String, Value>, inherit_env: bool) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut set =
        |key: String, value: String| match entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key, value)),
        };
    if inherit_env {
        for (key, value) in std::env::vars_os() {
            set(
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            set(key.clone(), value.to_string());
        }
    }
    entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let mut seen = std::collections::HashSet::new();
    entries.retain(|(name, _)| seen.insert(name.to_uppercase()));
    for required in REQUIRED_VARIABLES {
        if !entries
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(required))
            && let Ok(value) = std::env::var(required)
        {
            entries.push((required.to_string(), value));
        }
    }
    entries
}

/// Arguments quoted as libuv quotes them, Node's environment, and a hidden console.
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    for argument in args {
        command.raw_arg(quote_argument(argument));
    }
    command.env_clear();
    for (key, value) in child_environment(env, inherit_env) {
        command.env(key, value);
    }
    command.creation_flags(CREATE_NO_WINDOW);
}

/// libuv puts every child it starts into one job that ends its processes when the daemon exits.
fn job() -> Option<isize> {
    static JOB: OnceLock<Option<isize>> = OnceLock::new();
    *JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls with a zeroed, correctly sized information struct.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
                | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(job as isize)
        }
    })
}

pub fn after_spawn(child: &Child) {
    if let Some(job) = job() {
        // SAFETY: both handles are valid for the duration of the call.
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

/// Node's `killProcessTree` on Windows: `taskkill /F /T`, not waited for.
pub fn kill_tree(pid: u32) {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let _ = Command::new(format!("{system_root}\\System32\\taskkill.exe"))
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Exit codes are unsigned 32-bit values on Windows (an access violation is 3221225477).
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(status.code().unwrap_or(1) as u32)
}

#[cfg(test)]
mod tests {
    use super::quote_argument;

    #[test]
    fn quotes_arguments_like_libuv() {
        assert_eq!(quote_argument(""), "\"\"");
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("a b"), "\"a b\"");
        assert_eq!(quote_argument("*.txt"), "*.txt");
        assert_eq!(quote_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(
            quote_argument("C:\\dir with space\\"),
            "\"C:\\dir with space\\\\\""
        );
        assert_eq!(quote_argument("a\\\\b c"), "\"a\\\\b c\"");
    }
}
