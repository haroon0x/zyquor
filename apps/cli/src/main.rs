//! `zyquor` CLI — dev runner and scripts ported to Rust.
//!
//! See `tasks/m8-scripts.md` for the frozen classification: the TypeScript
//! scripts become these subcommands so the web UI and smoke checks run only
//! against the Rust stack.

mod backfill;
mod cli;
mod eval;
mod generation;
mod lessons;
mod mentions;
mod outreach;
mod overseer;
mod post_loop;
mod profile;
mod reply_loop;
mod seed;
mod start;

#[tokio::main]
async fn main() {
    zyquor_core::dotenv::load();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("start");
    let rest: Vec<String> = if args.is_empty() {
        Vec::new()
    } else {
        args[1..].to_vec()
    };

    if command == "help" || command == "--help" || command == "-h" || cli::has_help(&rest) {
        cli::print_usage();
        return;
    }

    let exit_code: i32 = match command {
        "start" => {
            if let Err(error) = check("start", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(start::run_start()).await
            }
        }
        "api" => {
            if let Err(error) = check("api", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(start::run_api()).await
            }
        }
        "worker" => {
            if let Err(error) = check("worker", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(start::run_worker()).await
            }
        }
        "web" => {
            if let Err(error) = check("web", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(start::run_web()).await
            }
        }
        "post-loop" => {
            if let Err(error) = check("post-loop", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(post_loop::run(&rest)).await
            }
        }
        "reply-loop" => {
            if let Err(error) = check("reply-loop", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(reply_loop::run(&rest)).await
            }
        }
        "overseer" => {
            if let Err(error) = check("overseer", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(overseer::run(&rest)).await
            }
        }
        "open-profile" => {
            if let Err(error) = check("open-profile", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                let manual = rest.iter().any(|arg| arg == "--manual");
                run_async(profile::run_open(manual)).await
            }
        }
        "check-login" => {
            if let Err(error) = check("check-login", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(profile::run_check_login()).await
            }
        }
        "backfill-timeline" => {
            if let Err(error) = check("backfill-timeline", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(backfill::run(&rest)).await
            }
        }
        "poll-mentions" => {
            if let Err(error) = check("poll-mentions", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(mentions::run(&rest)).await
            }
        }
        "seed-account" => match cli::check_flags("seed-account", &rest) {
            Ok(positionals) => {
                let result = seed::run(&positionals);
                match result {
                    Ok(code) => code,
                    Err(error) => {
                        eprintln!("{error}");
                        1
                    }
                }
            }
            Err(error) => {
                eprintln!("{error}");
                cli::print_usage();
                1
            }
        },
        "lessons" => {
            if let Err(error) = check("lessons", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_sync(|_| lessons::run(&rest))
            }
        }
        "outreach" => run_async(outreach::run(&rest)).await,
        "tweet-eval" => {
            if let Err(error) = check("tweet-eval", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(eval::run()).await
            }
        }
        "smoke-generation" => {
            if let Err(error) = check("smoke-generation", &rest) {
                eprintln!("{error}");
                cli::print_usage();
                1
            } else {
                run_async(generation::run()).await
            }
        }
        other => {
            eprintln!("Unknown command: {other}");
            cli::print_usage();
            1
        }
    };

    std::process::exit(exit_code);
}

fn check(command: &str, rest: &[String]) -> Result<(), String> {
    cli::check_flags(command, rest).map(|_| ())
}

async fn run_async(future: impl std::future::Future<Output = Result<i32, String>>) -> i32 {
    match future.await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn run_sync(f: impl FnOnce(()) -> Result<i32, String>) -> i32 {
    match f(()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}
