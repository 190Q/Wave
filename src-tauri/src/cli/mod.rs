//! The command line the executable takes, so Wave can be used from a terminal
//! as well as through its window. Running it with no arguments opens the window
//! exactly as it always did; with a command it does the work and exits, and no
//! window is ever created.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::import::ImportOutcome;
use crate::source::read_env;
use crate::tools;

mod fetch;
mod import;
mod playlists;
pub(crate) mod songs;

/// One command, as the words on the command line asked for it.
enum Command {
    Import(Import),
    List(Find),
    Search(Find),
    Scan,
    Info { json: bool },
    Playlists { json: bool },
    Playlist(Show),
    Download { playlist: String },
    Export { playlist: String, file: PathBuf },
    Fetch(fetch::Options),
    Like(Pick),
    Unlike(Pick),
    Delete(Pick),
    Tools { json: bool },
    Help(Option<String>),
    Version,
}

/// What an import was asked for. The link, folder or file it works on is the
/// one word that is not an option.
struct Import {
    target: String,
    /// Read the link and say what it holds, downloading nothing.
    plan: bool,
    /// Download songs the library already has as well.
    duplicates: bool,
    /// The name of the playlist a folder import creates.
    playlist: Option<String>,
    no_playlist: bool,
    /// The service a link belongs to, when the line says so outright.
    from: Option<String>,
}

/// A search that only reads.
pub(crate) struct Find {
    text: String,
    limit: Option<usize>,
    json: bool,
}

/// A search that acts on what it finds.
pub(crate) struct Pick {
    text: String,
    /// Take every match rather than refusing an ambiguous one.
    all: bool,
}

/// The playlist a command works on.
struct Show {
    name: String,
    limit: Option<usize>,
    json: bool,
}

/// Runs a command line, returning the code the process should exit with.
pub fn run(context: tauri::Context, args: &[String]) -> i32 {
    // Before anything is printed: on Windows a release build is a windowed
    // program, and has to be given the terminal it was run from.
    attach_console();

    let command = match parse(args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("error: {error}");
            eprintln!();
            print!("{}", usage());
            return 2;
        }
    };

    // The two that only say what this is need nothing else.
    match &command {
        Command::Help(name) => {
            print!("{}", help(name.as_deref()));
            return 0;
        }
        Command::Version => {
            println!("{} {}", exe(), env!("CARGO_PKG_VERSION"));
            return 0;
        }
        _ => {}
    }

    if !desktop_available() {
        return 1;
    }

    // Building the app and never running its event loop is what makes a command
    // cost nothing: the windows in the config are created from the `Ready` event
    // inside `run`, so none is ever opened, and the same `AppHandle` the window
    // works from is what the commands below use.
    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .build(context)
    {
        Ok(app) => app,
        Err(error) => {
            eprintln!("error: Wave could not start: {error}");
            return 1;
        }
    };

    crate::prepare(app.handle());

    let code = match dispatch(app.handle(), &command) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("error: {error}");
            1
        }
    };

    app.cleanup_before_exit();
    code
}

fn dispatch(app: &AppHandle, command: &Command) -> Result<(), String> {
    match command {
        Command::Import(options) => import::run(app, options),
        Command::List(options) => songs::list(app, options),
        Command::Search(options) => songs::search(app, options),
        Command::Scan => songs::scan(app),
        Command::Info { json } => songs::info(app, *json),
        Command::Playlists { json } => playlists::list(app, *json),
        Command::Playlist(options) => playlists::show(app, options),
        Command::Download { playlist } => playlists::download(app, playlist),
        Command::Export { playlist, file } => playlists::export(app, playlist, file),
        Command::Fetch(options) => fetch::run(app, options),
        Command::Like(pick) => songs::set_liked(app, pick, true),
        Command::Unlike(pick) => songs::set_liked(app, pick, false),
        Command::Delete(pick) => songs::delete(app, pick),
        Command::Tools { json } => report_tools(app, *json),
        Command::Help(_) | Command::Version => Ok(()),
    }
}

// ------------------------------------------------------------------ parsing --

fn parse(args: &[String]) -> Result<Command, String> {
    let Some(name) = args.first() else {
        return Ok(Command::Help(None));
    };
    let rest = &args[1..];

    match name.as_str() {
        "import" => parse_import(rest),
        "list" => parse_list(rest),
        "search" => parse_search(rest),
        "scan" => simple(rest, "scan", Command::Scan),
        "info" => json_only(rest, "info", |json| Command::Info { json }),
        "playlists" => json_only(rest, "playlists", |json| Command::Playlists { json }),
        "playlist" => parse_playlist(rest),
        "download" => parse_download(rest),
        "export" => parse_export(rest),
        "lyrics" => parse_fetch(rest, "lyrics", fetch::What::Lyrics),
        "covers" => parse_fetch(rest, "covers", fetch::What::Covers),
        "genres" => parse_fetch(rest, "genres", fetch::What::Genres),
        "level" => parse_fetch(rest, "level", fetch::What::Level),
        "like" => parse_pick(rest, "like", Command::Like),
        "unlike" => parse_pick(rest, "unlike", Command::Unlike),
        "delete" => parse_pick(rest, "delete", Command::Delete),
        "tools" => json_only(rest, "tools", |json| Command::Tools { json }),
        "help" => Ok(Command::Help(rest.first().cloned())),
        "-h" | "--help" => Ok(Command::Help(None)),
        "-V" | "--version" | "version" => Ok(Command::Version),
        other => Err(format!("there is no {other} command")),
    }
}

fn parse_import(rest: &[String]) -> Result<Command, String> {
    let args = Args::split(rest, &["playlist", "from"])?;
    args.only(&["help", "plan", "duplicates", "playlist", "no-playlist", "from"])?;
    if let Some(help) = wants_help(&args, "import") {
        return Ok(help);
    }
    args.no_more(1, "wave import <link|folder> [options]")?;

    Ok(Command::Import(Import {
        target: args.required(0, "a link or a folder")?,
        plan: args.flag("plan"),
        duplicates: args.flag("duplicates"),
        playlist: args.value("playlist").map(str::to_string),
        no_playlist: args.flag("no-playlist"),
        from: args.value("from").map(str::to_string),
    }))
}

fn parse_list(rest: &[String]) -> Result<Command, String> {
    let args = Args::split(rest, &["limit"])?;
    args.only(&["help", "limit", "json"])?;
    if let Some(help) = wants_help(&args, "list") {
        return Ok(help);
    }
    args.no_more(0, "wave list [--limit N] [--json]")?;

    Ok(Command::List(Find {
        text: String::new(),
        limit: limit(&args)?,
        json: args.flag("json"),
    }))
}

fn parse_search(rest: &[String]) -> Result<Command, String> {
    let args = Args::split(rest, &["limit"])?;
    args.only(&["help", "limit", "json"])?;
    if let Some(help) = wants_help(&args, "search") {
        return Ok(help);
    }
    args.no_more(1, "wave search <text> [--limit N] [--json]")?;

    Ok(Command::Search(Find {
        text: args.required(0, "something to search for")?,
        limit: limit(&args)?,
        json: args.flag("json"),
    }))
}

fn parse_playlist(rest: &[String]) -> Result<Command, String> {
    let args = Args::split(rest, &["limit"])?;
    args.only(&["help", "limit", "json"])?;
    if let Some(help) = wants_help(&args, "playlist") {
        return Ok(help);
    }
    args.no_more(1, "wave playlist <name> [--limit N] [--json]")?;

    Ok(Command::Playlist(Show {
        name: args.required(0, "a playlist name")?,
        limit: limit(&args)?,
        json: args.flag("json"),
    }))
}

fn parse_download(rest: &[String]) -> Result<Command, String> {
    let args = Args::split(rest, &[])?;
    args.only(&["help"])?;
    if let Some(help) = wants_help(&args, "download") {
        return Ok(help);
    }
    args.no_more(1, "wave download <playlist>")?;

    Ok(Command::Download {
        playlist: args.required(0, "a playlist name")?,
    })
}

fn parse_export(rest: &[String]) -> Result<Command, String> {
    let args = Args::split(rest, &[])?;
    args.only(&["help"])?;
    if let Some(help) = wants_help(&args, "export") {
        return Ok(help);
    }
    args.no_more(2, "wave export <playlist> <file>")?;

    Ok(Command::Export {
        playlist: args.required(0, "a playlist name")?,
        file: PathBuf::from(args.required(1, "a file to write")?),
    })
}

fn parse_fetch(rest: &[String], name: &str, what: fetch::What) -> Result<Command, String> {
    let args = Args::split(rest, &[])?;
    args.only(&["help"])?;
    if let Some(help) = wants_help(&args, name) {
        return Ok(help);
    }
    args.no_more(1, &format!("wave {name} [<text>]"))?;

    Ok(Command::Fetch(fetch::Options {
        what,
        text: args.word(0).map(str::to_string),
    }))
}

fn parse_pick(rest: &[String], name: &str, build: fn(Pick) -> Command) -> Result<Command, String> {
    let args = Args::split(rest, &[])?;
    args.only(&["help", "all"])?;
    if let Some(help) = wants_help(&args, name) {
        return Ok(help);
    }
    args.no_more(1, &format!("wave {name} <text> [--all]"))?;

    Ok(build(Pick {
        text: args.required(0, "something to match the songs by")?,
        all: args.flag("all"),
    }))
}

/// A command that takes nothing but `--help`.
fn simple(rest: &[String], name: &str, command: Command) -> Result<Command, String> {
    let args = Args::split(rest, &[])?;
    args.only(&["help"])?;
    if let Some(help) = wants_help(&args, name) {
        return Ok(help);
    }
    args.no_more(0, &format!("wave {name}"))?;

    Ok(command)
}

/// A command that takes nothing but `--json` and `--help`.
fn json_only(
    rest: &[String],
    name: &str,
    build: fn(bool) -> Command,
) -> Result<Command, String> {
    let args = Args::split(rest, &[])?;
    args.only(&["help", "json"])?;
    if let Some(help) = wants_help(&args, name) {
        return Ok(help);
    }
    args.no_more(0, &format!("wave {name} [--json]"))?;

    Ok(build(args.flag("json")))
}

/// The command's own help, when the line asked for it.
fn wants_help(args: &Args, name: &str) -> Option<Command> {
    args.flag("help")
        .then(|| Command::Help(Some(name.to_string())))
}

fn limit(args: &Args) -> Result<Option<usize>, String> {
    match args.value("limit") {
        None => Ok(None),
        Some(value) => value
            .trim()
            .parse::<usize>()
            .map(Some)
            .map_err(|_| format!("--limit wants a number, not {value}")),
    }
}

/// One command's words, with its options taken out of them.
struct Args {
    words: Vec<String>,
    options: Vec<(String, Option<String>)>,
}

impl Args {
    /// Splits a command's words, given the options that take a value.
    fn split(words: &[String], valued: &[&str]) -> Result<Self, String> {
        let mut rest = words.iter();
        let mut kept = Vec::new();
        let mut options = Vec::new();

        while let Some(word) = rest.next() {
            let Some(name) = word.strip_prefix("--") else {
                if word == "-h" {
                    options.push(("help".to_string(), None));
                } else if word.starts_with('-') && word.len() > 1 {
                    return Err(format!("{word} is not an option Wave knows"));
                } else {
                    kept.push(word.clone());
                }
                continue;
            };

            match name.split_once('=') {
                Some((name, value)) => options.push((name.to_string(), Some(value.to_string()))),
                None if valued.contains(&name) => {
                    let value = rest.next().ok_or_else(|| format!("--{name} needs a value"))?;
                    options.push((name.to_string(), Some(value.clone())));
                }
                None => options.push((name.to_string(), None)),
            }
        }

        Ok(Self {
            words: kept,
            options,
        })
    }

    fn flag(&self, name: &str) -> bool {
        self.options.iter().any(|(option, _)| option == name)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|(option, _)| option == name)
            .and_then(|(_, value)| value.as_deref())
    }

    fn word(&self, index: usize) -> Option<&str> {
        self.words.get(index).map(String::as_str)
    }

    /// Refuses an option the command does not take, rather than ignoring it.
    fn only(&self, allowed: &[&str]) -> Result<(), String> {
        for (option, _) in &self.options {
            if !allowed.contains(&option.as_str()) {
                return Err(format!("--{option} is not an option this command takes"));
            }
        }
        Ok(())
    }

    /// Refuses more words than the command has room for.
    fn no_more(&self, count: usize, shape: &str) -> Result<(), String> {
        if self.words.len() > count {
            return Err(format!("that is more than this command takes: {shape}"));
        }
        Ok(())
    }

    fn required(&self, index: usize, what: &str) -> Result<String, String> {
        self.word(index)
            .map(str::to_string)
            .ok_or_else(|| format!("{what} is needed"))
    }
}

// -------------------------------------------------------------------- tools --

/// What the downloads need: the three programs, the config, and where they are.
fn report_tools(app: &AppHandle, json: bool) -> Result<(), String> {
    let env = read_env(app);
    let bundled = tools::bundled_dir(app);
    let found = tools::status(&env, bundled.as_deref());

    if json {
        let report = serde_json::json!({
            "ytDlp": found.yt_dlp,
            "ytDlpSource": found.yt_dlp_source,
            "ffmpeg": found.ffmpeg,
            "deno": found.deno,
            "denoSource": found.deno_source,
            "spotify": env.complete(),
            "config": path_of(crate::source::env_path(app)),
            "problem": found.problem(),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        return Ok(());
    }

    println!("yt-dlp   {}", found_in(&found.yt_dlp, &found.yt_dlp_source));
    println!("ffmpeg   {}", found_in(&found.ffmpeg, "found"));
    println!("deno     {}", found_in(&found.deno, &found.deno_source));
    println!(
        "spotify  {}",
        if env.complete() {
            "set up".to_string()
        } else {
            "add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to the config".to_string()
        }
    );
    println!("config   {}", path_of(crate::source::env_path(app)));

    if let Some(problem) = found.problem() {
        println!();
        println!("{problem}");
    }

    Ok(())
}

/// A tool as the report reads: where it was found, or that it was not.
fn found_in(present: &bool, source: &str) -> String {
    if *present && !source.is_empty() {
        source.to_string()
    } else if *present {
        "found".to_string()
    } else {
        "not found".to_string()
    }
}

/// A path as the report reads it, empty when it cannot be placed.
fn path_of(path: Result<PathBuf, String>) -> String {
    path.map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ helpers --

/// What the window and the commands both say about a finished import.
pub(super) fn report_import(outcome: &ImportOutcome) -> Result<(), String> {
    let mut parts = vec![count(outcome.songs, "song")];
    if outcome.duplicates > 0 {
        parts.push(format!("{} already in the library", outcome.duplicates));
    }
    if outcome.images > 0 {
        parts.push(count(outcome.images, "cover"));
    }
    if outcome.lyrics > 0 {
        parts.push(count(outcome.lyrics, "lyrics"));
    }
    println!("{}.", parts.join(", "));

    if outcome.errors.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{} would not download",
        count(outcome.errors.len(), "song")
    ))
}

/// `1 song`, `3 songs`.
pub(super) fn count(total: usize, noun: &str) -> String {
    let plural = if total == 1 { "" } else { "s" };
    format!("{total} {noun}{plural}")
}

// ------------------------------------------------------------------ writing --

/// The name this was called by, so the usage text reads the way it was typed.
fn exe() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "wave".to_string())
}

/// The commands, and what each one does.
const COMMANDS: [(&str, &str); 20] = [
    ("", "open the app"),
    ("import <link|folder|file>", "download a link, import a folder, or import a .wavelist"),
    ("list [--limit N]", "list the library"),
    ("search <text>", "find songs by title, artist or album"),
    ("scan", "re-read the library folder"),
    ("info", "where the library is and what it holds"),
    ("playlists", "list the playlists"),
    ("playlist <name>", "show one playlist and its songs"),
    ("download <playlist>", "download a playlist's waiting songs"),
    ("export <playlist> <file>", "write a playlist out as a .wavelist"),
    ("lyrics [<text>]", "fetch missing lyrics"),
    ("covers [<text>]", "fetch missing cover art"),
    ("genres [<text>]", "fetch missing genres"),
    ("level [<text>]", "measure loudness, for level volume"),
    ("like <text>", "like the songs a search finds"),
    ("unlike <text>", "remove them from Liked Songs"),
    ("delete <text>", "delete songs, with their files"),
    ("tools", "report the download tools and the config"),
    ("help [command]", "this list, or one command in detail"),
    ("version", "the version"),
];

/// The commands, for a line that asked for nothing in particular.
fn usage() -> String {
    let exe = exe();
    let width = COMMANDS
        .iter()
        .map(|(command, _)| command.len())
        .max()
        .unwrap_or(0);

    let mut text = format!(
        "{exe} - a local-first music player, from the window or the terminal.\n\n"
    );
    for (command, about) in COMMANDS {
        text.push_str(&format!("    {exe} {command:<width$}  {about}\n"));
    }
    text.push_str(&format!(
        "\nRun `{exe} help <command>` for what a command takes. The commands work on the same \
         library the app does, so a song downloaded here is there when it opens.\n"
    ));

    text
}

/// One command's own help, or the list when no command was named.
fn help(name: Option<&str>) -> String {
    let Some(name) = name else {
        return usage();
    };
    let exe = exe();

    match name {
        "import" => format!(
            "\
{exe} import <link|folder> [options]

Downloads a Spotify, Deezer or YouTube link into the library, imports a folder
of music from this machine, or imports a .wavelist file. A link's songs are
searched for and tagged exactly as they are from the import dialog, using the
yt-dlp, ffmpeg and Deno that ship with Wave.

A playlist, album or channel becomes a Wave playlist named after it. A folder
becomes one too unless --no-playlist is given. Songs the library already has are
skipped unless --duplicates is given.

    --plan             read the link and say what it holds, downloading nothing
    --duplicates       download songs the library already has as well
    --playlist <name>  the name of the playlist a folder import creates
    --no-playlist      import a folder without creating a playlist
    --from <service>   read the link as spotify, deezer or youtube

A link is read as Deezer if it names Deezer, as YouTube if it names YouTube, and
as Spotify otherwise.
"
        ),
        "list" => format!(
            "\
{exe} list [--limit N] [--json]

Lists every song in the library, oldest reading of the catalog first, so it is
fast and does not touch the disk. Run `{exe} scan` after adding files by hand.

    --limit N   show at most N songs
    --json      write the songs as JSON, for a script
"
        ),
        "search" => format!(
            "\
{exe} search <text> [--limit N] [--json]

Finds the songs whose title, artist or album answers to the text. Case, accents
and stray spacing do not matter. A song id is taken as itself.

    --limit N   show at most N songs
    --json      write the songs as JSON, for a script
"
        ),
        "scan" => format!(
            "\
{exe} scan

Reads the library folder and brings the catalog in line with it: songs added or
removed by hand are noticed, and their tags are read again where they changed.
The app does this when it opens, so it is only needed when the files are moved
around while the app is closed.
"
        ),
        "info" => format!(
            "\
{exe} info [--json]

Says where the library is, how many songs it holds, how many are missing, and
where the config, the state and the download log are kept.

    --json      write the same as JSON, for a script
"
        ),
        "playlists" => format!(
            "\
{exe} playlists [--json]

Lists the playlists, with how many songs each holds and how many are still
waiting to be downloaded.

    --json      write the playlists as JSON, for a script
"
        ),
        "playlist" => format!(
            "\
{exe} playlist <name> [--limit N] [--json]

Shows one playlist and its songs, in the order they play. A song the playlist is
still waiting on is marked as one to download. The name is matched without
regard to case, or a playlist id can be given instead.

    --limit N   show at most N songs
    --json      write the playlist as JSON, for a script
"
        ),
        "download" => format!(
            "\
{exe} download <playlist>

Downloads the songs a playlist is waiting on, and puts each one in the place it
was waiting in. A playlist the generator filled is the one this is for; it
downloads nothing that is already in the library.
"
        ),
        "export" => format!(
            "\
{exe} export <playlist> <file>

Writes a playlist out as a .wavelist file, which holds the songs' tags rather
than their audio. Another copy of Wave can import it and download the same songs
without Spotify. Songs the playlist is waiting on are left out.
"
        ),
        "lyrics" | "covers" | "genres" | "level" => {
            let what = match name {
                "lyrics" => "lyrics",
                "covers" => "cover art",
                "genres" => "a genre",
                _ => "loudness, so playback can level the songs",
            };
            format!(
                "\
{exe} {name} [<text>]

Looks for {what} for every song that is missing it. With no text the whole
library is worked through; with text, only the songs that answer to it, matched
the way `{exe} search` matches.

Nothing is overwritten: a song that already has what the pass looks for is left
exactly as it is, so a pass can be stopped and run again.
"
            )
        }
        "like" | "unlike" => format!(
            "\
{exe} {name} <text> [--all]

Puts the songs that answer to the text into Liked Songs, or takes them out
again. Text that matches more than one song is refused unless --all is given, so
a word that turns out to be common cannot change more than was meant.

    --all       act on every song the text matches
"
        ),
        "delete" => format!(
            "\
{exe} delete <text> [--all]

Deletes the songs that answer to the text, with their files, their playlist
entries and their place in Liked Songs. Text that matches more than one song is
refused unless --all is given.

    --all       delete every song the text matches
"
        ),
        "tools" => format!(
            "\
{exe} tools [--json]

Reports the three programs a download needs, where each was found, whether the
Spotify credentials are set up, and where the config .env is.

    --json      write the same as JSON, for a script
"
        ),
        "help" => format!("{exe} help [command]\n\nThis list, or what one command takes.\n"),
        "version" => format!("{exe} version\n\nThe version.\n"),
        other => format!("there is no {other} command.\n\n{}", usage()),
    }
}

/// A release build is a windowed program, so Windows gives it no console of its
/// own and everything it prints goes nowhere. A command still has to be
/// readable, so this takes the console that ran it and points the standard
/// streams at it.
///
/// A stream that already goes somewhere useful is left alone, so a command
/// redirected into a file or a pipe still writes there.
#[cfg(windows)]
fn attach_console() {
    use std::fs::OpenOptions;
    use std::os::windows::io::AsRawHandle;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
        STD_HANDLE, STD_OUTPUT_HANDLE,
    };

    /// Points one stream at the console, or at nothing when there is no console
    /// to point it at, so that printing can never bring the process down.
    fn rebind(stream: STD_HANDLE) {
        let usable = unsafe { GetStdHandle(stream) }
            .map(|handle| !handle.is_invalid())
            .unwrap_or(false);
        if usable {
            return;
        }

        let console = OpenOptions::new()
            .write(true)
            .open("CONOUT$")
            .or_else(|_| OpenOptions::new().write(true).open("NUL"));
        let Ok(file) = console else {
            return;
        };

        unsafe { SetStdHandle(stream, HANDLE(file.as_raw_handle() as _)) }.ok();
        // The stream outlives this call: the handle is what printing writes to
        // for the rest of the process, so it is never closed.
        std::mem::forget(file);
    }

    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) }.ok();
    rebind(STD_OUTPUT_HANDLE);
    rebind(STD_ERROR_HANDLE);
}

#[cfg(not(windows))]
fn attach_console() {}

/// Whether there is a session to open the runtime in.
///
/// The commands start the same runtime the window uses, which on Linux means
/// GTK, so a command needs a desktop to run in. Saying so is better than the
/// panic GTK would raise on a machine that has neither.
#[cfg(target_os = "linux")]
fn desktop_available() -> bool {
    let set = |name: &str| std::env::var_os(name).is_some_and(|value| !value.is_empty());
    if set("DISPLAY") || set("WAYLAND_DISPLAY") {
        return true;
    }

    eprintln!(
        "error: Wave's commands need a desktop session to run in, and neither DISPLAY nor \
         WAYLAND_DISPLAY is set. Run them from a desktop terminal, or over ssh -X."
    );
    false
}

#[cfg(not(target_os = "linux"))]
fn desktop_available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words of a command line, for the parser.
    fn words(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_string).collect()
    }

    fn error(line: &str) -> String {
        match parse(&words(line)) {
            Err(error) => error,
            Ok(_) => panic!("{line} was taken"),
        }
    }

    #[test]
    fn a_line_with_nothing_on_it_asks_for_the_help() {
        assert!(matches!(parse(&[]), Ok(Command::Help(None))));
        assert!(matches!(parse(&words("--help")), Ok(Command::Help(None))));
        assert!(matches!(parse(&words("help")), Ok(Command::Help(None))));
        assert!(matches!(parse(&words("--version")), Ok(Command::Version)));
        assert!(matches!(parse(&words("version")), Ok(Command::Version)));
    }

    #[test]
    fn one_command_takes_its_own_help() {
        assert!(matches!(
            parse(&words("list --help")),
            Ok(Command::Help(Some(name))) if name == "list"
        ));
        assert!(matches!(
            parse(&words("import -h")),
            Ok(Command::Help(Some(name))) if name == "import"
        ));
        // And the same command still takes its own words.
        assert!(matches!(parse(&words("list")), Ok(Command::List(_))));
    }

    #[test]
    fn a_command_that_is_not_there_is_refused() {
        assert!(error("dance").contains("there is no dance command"));
        assert!(error("-x").contains("there is no -x command"));
        // An option the command does not take, and a word it has no room for.
        assert!(error("list --slow").contains("--slow is not an option"));
        assert!(error("list -x").contains("-x is not an option"));
        assert!(error("scan 12").contains("more than this command takes"));
    }

    #[test]
    fn an_import_reads_its_link_and_its_options() {
        let Ok(Command::Import(options)) = parse(&words(
            "import https://open.spotify.com/playlist/1 --duplicates --from spotify",
        )) else {
            panic!("the import was not read");
        };

        assert_eq!(options.target, "https://open.spotify.com/playlist/1");
        assert!(options.duplicates);
        assert_eq!(options.from.as_deref(), Some("spotify"));
        assert!(!options.plan);
        assert!(!options.no_playlist);
        assert!(options.playlist.is_none());

        // An option with a value is taken either way it is written.
        let Ok(Command::Import(options)) = parse(&words("import music --playlist Vol3")) else {
            panic!("the import was not read");
        };
        assert_eq!(options.target, "music");
        assert_eq!(options.playlist.as_deref(), Some("Vol3"));

        let Ok(Command::Import(options)) = parse(&words("import music --playlist=Vol3")) else {
            panic!("the import was not read");
        };
        assert_eq!(options.playlist.as_deref(), Some("Vol3"));

        // An import needs something to import.
        assert!(error("import").contains("a link or a folder is needed"));
        assert!(error("import --plan").contains("is needed"));
        // And an option that takes a value has to be given one.
        assert!(error("import music --playlist").contains("--playlist needs a value"));
    }

    #[test]
    fn a_limit_is_a_number() {
        let Ok(Command::List(options)) = parse(&words("list --limit 20")) else {
            panic!("the list was not read");
        };
        assert_eq!(options.limit, Some(20));
        assert!(!options.json);

        let Ok(Command::List(options)) = parse(&words("list --json")) else {
            panic!("the list was not read");
        };
        assert_eq!(options.limit, None);
        assert!(options.json);

        assert!(error("list --limit lots").contains("--limit wants a number"));
    }

    #[test]
    fn a_search_needs_something_to_look_for() {
        let Ok(Command::Search(options)) = parse(&words("search duality")) else {
            panic!("the search was not read");
        };
        assert_eq!(options.text, "duality");

        assert!(error("search").contains("something to search for is needed"));
    }

    #[test]
    fn the_commands_that_act_on_a_song_take_all_or_one() {
        let Ok(Command::Like(pick)) = parse(&words("like duality")) else {
            panic!("the like was not read");
        };
        assert_eq!(pick.text, "duality");
        assert!(!pick.all);

        let Ok(Command::Delete(pick)) = parse(&words("delete duality --all")) else {
            panic!("the delete was not read");
        };
        assert!(pick.all);

        // The commands that only read have no such option.
        assert!(error("search duality --all").contains("--all is not an option"));
    }

    #[test]
    fn the_fetch_commands_take_a_word_or_nothing() {
        let Ok(Command::Fetch(options)) = parse(&words("lyrics")) else {
            panic!("the lyrics pass was not read");
        };
        assert_eq!(options.what, fetch::What::Lyrics);
        assert!(options.text.is_none());

        let Ok(Command::Fetch(options)) = parse(&words("covers duality")) else {
            panic!("the covers pass was not read");
        };
        assert_eq!(options.what, fetch::What::Covers);
        assert_eq!(options.text.as_deref(), Some("duality"));

        let Ok(Command::Fetch(options)) = parse(&words("level")) else {
            panic!("the level pass was not read");
        };
        assert_eq!(options.what, fetch::What::Level);
    }

    #[test]
    fn a_playlist_is_named_or_written_out() {
        let Ok(Command::Playlist(show)) = parse(&words("playlist Vol3")) else {
            panic!("the playlist was not read");
        };
        assert_eq!(show.name, "Vol3");
        // A name with a space in it is one word once the shell has read it.
        assert!(error("playlist Vol 3").contains("more than this command takes"));

        let Ok(Command::Export { playlist, file }) = parse(&words("export Vol3 out.wavelist")) else {
            panic!("the export was not read");
        };
        assert_eq!(playlist, "Vol3");
        assert_eq!(file, PathBuf::from("out.wavelist"));

        assert!(error("export Vol3").contains("a file to write is needed"));
        assert!(error("download").contains("a playlist name is needed"));
    }

    #[test]
    fn says_how_many_of_something_it_is() {
        assert_eq!(count(0, "song"), "0 songs");
        assert_eq!(count(1, "song"), "1 song");
        assert_eq!(count(2, "cover"), "2 covers");
    }

    #[test]
    fn the_usage_lists_every_command_it_takes() {
        let usage = usage();
        for (command, about) in COMMANDS {
            // Each one gets a line of its own, named with the executable and
            // followed by what it does.
            let line = usage
                .lines()
                .find(|line| line.contains(command) && line.contains(about))
                .unwrap_or_else(|| panic!("{command} is missing from the usage"));
            assert!(line.contains(&exe()), "{command} is not shown with the executable");
        }

        // Every command has help of its own, which is more than the list.
        for name in [
            "import", "list", "search", "scan", "info", "playlists", "playlist", "download",
            "export", "lyrics", "covers", "genres", "level", "like", "unlike", "delete", "tools",
            "help", "version",
        ] {
            let help = help(Some(name));
            assert!(help.contains(name), "the help for {name} does not name it");
            assert_ne!(help, usage);
        }

        // A command that is not there says so, and then says what is.
        let unknown = help(Some("dance"));
        assert!(unknown.contains("there is no dance command"));
        assert!(unknown.contains("import"));
    }
}
