//! What differs between operating systems: error names, positional reads, temporary directories, opening readers,
//! and starting and killing commands. Each implementation follows what Node (libuv) does on that system.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// How a string command runs: the shell, its arguments before the command, and whether the command goes to its
/// stdin instead of its arguments (legacy WSL `bash.exe`).
pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
    pub command_on_stdin: bool,
}

/// How Node opens files for writing: `writeFile` (`w`), `appendFile` (`a`), and `r+` for truncate and fsync.
#[derive(Clone, Copy)]
pub enum OpenMode {
    Write,
    Append,
    ReadWrite,
}
