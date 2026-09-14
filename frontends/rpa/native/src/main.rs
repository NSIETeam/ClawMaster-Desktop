//! ClawMaster RPA native helper.
//!
//! The pre-DSH desktop binary served two roles from one executable: it answered
//! `--native-tool <name>` on the command line and otherwise started the GUI.
//! The GUI role belongs to ClawMaster's Tauri shell now, so this binary keeps
//! only the command-line role that the RPA host half drives.
//!
//! The contract is unchanged from the recovered implementation: JSON on stdout,
//! a human-readable error on stderr, exit code 2 for a failed native operation.

/// Print the RPA tool catalog the recovered control plane already declares.
///
/// It is answered here rather than inside `native_tools::dispatch_from_args` so
/// that recovered module stays byte-identical to the pre-DSH implementation.
fn print_definitions() -> i32 {
    match serde_json::to_string(&clawmaster_rpa_native::native_rpa::definitions()) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}

/// Run one recovered `rpa_*` tool call and print its canonical JSON result.
///
/// The request arrives as a single JSON argument, so a tool's arguments never
/// pass through a shell and never need quoting.
fn run_rpa_call(request_json: Option<&String>) -> i32 {
    let Some(request_json) = request_json else {
        eprintln!("rpa-call requires a JSON request argument");
        return 64;
    };
    match clawmaster_rpa_native::rpa_cli::run_blocking(request_json) {
        Ok(value) => match serde_json::to_string(&value) {
            Ok(json) => {
                println!("{json}");
                0
            }
            Err(error) => {
                eprintln!("{error}");
                2
            }
        },
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let subcommand = if args.first().map(String::as_str) == Some("--native-tool") {
        args.get(1).map(String::as_str)
    } else {
        None
    };

    if subcommand == Some("definitions") {
        std::process::exit(print_definitions());
    }

    if subcommand == Some("rpa-call") {
        std::process::exit(run_rpa_call(args.get(2)));
    }

    match clawmaster_rpa_native::native_tools::dispatch_from_args(&args) {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
        None => {
            eprintln!(
                "usage: clawmaster-rpa-native --native-tool <capabilities|definitions|desktop-snapshot|input|pdf-merge|pdf-optimize|...>"
            );
            std::process::exit(64);
        }
    }
}
