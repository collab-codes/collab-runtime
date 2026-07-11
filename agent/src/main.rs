use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug)]
struct Config {
    sites_url: String,
    server_id: String,
    project_id: String,
    token: String,
    bind: String,
    allowed_origin: String,
    interval: u64,
    data_root: String,
    runtime_dir: String,
    region: String,
    instance_id: String,
    agent_version: String,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let env_path = arg_value(&args, "--env").unwrap_or_else(|| "/etc/collab/sites-agent.env".to_string());
    let once = args.iter().any(|arg| arg == "--once");
    let config = match Config::from_env_file(&env_path) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("collab-sites-agent config error: {}", err);
            std::process::exit(2);
        }
    };

    if once {
        send_heartbeat(&config);
        return;
    }

    let server_config = config.clone();
    thread::spawn(move || run_status_server(server_config));

    loop {
        send_heartbeat(&config);
        thread::sleep(Duration::from_secs(config.interval));
    }
}

impl Config {
    fn from_env_file(path: &str) -> Result<Self, String> {
        let values = read_env_file(path)?;
        let sites_url = required(&values, "COLLAB_SITES_URL")?.trim_end_matches('/').to_string();
        let mut instance_id = values.get("COLLAB_SITES_INSTANCE_ID").cloned().unwrap_or_default();
        let instance_id_from_imds = values.get("COLLAB_SITES_INSTANCE_ID_FROM_IMDS").map(|v| v == "true").unwrap_or(true);
        if instance_id.is_empty() && instance_id_from_imds {
            instance_id = command_output("curl", &["-fsS", "--max-time", "2", "http://169.254.169.254/latest/meta-data/instance-id"])
                .unwrap_or_default();
        }

        Ok(Self {
            sites_url,
            server_id: required(&values, "COLLAB_SITES_SERVER_ID")?,
            project_id: required(&values, "COLLAB_SITES_PROJECT_ID")?,
            token: required(&values, "COLLAB_SITES_AGENT_TOKEN")?,
            bind: values.get("COLLAB_SITES_AGENT_BIND").cloned().unwrap_or_else(|| "127.0.0.1:5151".to_string()),
            allowed_origin: values.get("COLLAB_SITES_ALLOWED_ORIGIN").cloned().unwrap_or_else(|| "sites.collab.codes".to_string()),
            interval: values.get("COLLAB_SITES_HEARTBEAT_INTERVAL_SECONDS").and_then(|v| v.parse::<u64>().ok()).unwrap_or(30),
            data_root: values.get("COLLAB_SITES_DATA_ROOT").cloned().unwrap_or_else(|| "/data".to_string()),
            runtime_dir: values.get("COLLAB_SITES_RUNTIME_DIR").cloned().unwrap_or_else(|| "/data/collab-runtime".to_string()),
            region: values.get("COLLAB_SITES_REGION").cloned().unwrap_or_default(),
            instance_id,
            agent_version: values.get("COLLAB_SITES_AGENT_VERSION").cloned().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        })
    }
}

fn send_heartbeat(config: &Config) {
    let url = format!("{}/api/v1/servers/{}/heartbeat", config.sites_url, config.server_id);
    let payload = heartbeat_payload(config);
    let result = Command::new("curl")
        .args([
            "-fsS",
            "--max-time", "10",
            "-H", "Content-Type: application/json",
            "-H", "X-Collab-Origin: collab-runtime-agent",
            "-X", "POST",
            "--data-binary", &payload,
            &url,
        ])
        .output();

    match result {
        Ok(output) if output.status.success() => {
            println!("heartbeat sent to {}", url);
        }
        Ok(output) => {
            eprintln!(
                "heartbeat failed: status={} stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Err(err) => eprintln!("heartbeat failed to execute curl: {}", err),
    }
}

fn heartbeat_payload(config: &Config) -> String {
    format!(
        "{{\"projectId\":\"{}\",\"instanceId\":\"{}\",\"token\":\"{}\",\"status\":\"{}\",\"runtimeVersion\":\"{}\",\"agentVersion\":\"{}\",\"payload\":{}}}",
        json_escape(&config.project_id),
        json_escape(&config.instance_id),
        json_escape(&config.token),
        json_escape(&runtime_status()),
        json_escape(&runtime_version(config)),
        json_escape(&config.agent_version),
        status_payload(config),
    )
}

fn status_payload(config: &Config) -> String {
    format!(
        "{{\"hostname\":\"{}\",\"region\":\"{}\",\"dataRoot\":\"{}\",\"runtimeDir\":\"{}\",\"loadavg\":\"{}\",\"disk\":\"{}\",\"services\":{{\"nginx\":\"{}\",\"postgresql\":\"{}\",\"redis\":\"{}\"}}}}",
        json_escape(&command_output("hostname", &[]).unwrap_or_default()),
        json_escape(&config.region),
        json_escape(&config.data_root),
        json_escape(&config.runtime_dir),
        json_escape(&fs::read_to_string("/proc/loadavg").unwrap_or_default().trim().to_string()),
        json_escape(&command_output("df", &["-h", config.data_root.as_str()]).unwrap_or_default()),
        json_escape(&systemd_status("nginx")),
        json_escape(&systemd_status("postgresql")),
        json_escape(&systemd_status("redis-server")),
    )
}

fn runtime_status() -> String {
    for service in ["nginx", "postgresql", "redis-server"] {
        if systemd_status(service) != "active" {
            return "degraded".to_string();
        }
    }
    "ready".to_string()
}

fn runtime_version(config: &Config) -> String {
    command_output("git", &["-C", config.runtime_dir.as_str(), "rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string())
}

fn run_status_server(config: Config) {
    let listener = match TcpListener::bind(&config.bind) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("status server bind failed on {}: {}", config.bind, err);
            return;
        }
    };
    println!("status server listening on {}", config.bind);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_status_request(stream, &config),
            Err(err) => eprintln!("status server connection error: {}", err),
        }
    }
}

fn handle_status_request(mut stream: TcpStream, config: &Config) {
    let mut buffer = [0_u8; 4096];
    let read = match stream.read(&mut buffer) {
        Ok(read) => read,
        Err(_) => return,
    };
    let request = String::from_utf8_lossy(&buffer[..read]);
    let (path, headers) = parse_request(&request);
    let allowed = request_allowed(&headers, &config.allowed_origin);
    if !allowed {
        write_response(&mut stream, 403, "{\"error\":\"origin not allowed\"}");
        return;
    }

    match path.as_str() {
        "/health" => write_response(&mut stream, 200, "{\"status\":\"ok\"}"),
        "/status" => {
            let body = format!(
                "{{\"serverId\":\"{}\",\"projectId\":\"{}\",\"instanceId\":\"{}\",\"status\":\"{}\",\"payload\":{}}}",
                json_escape(&config.server_id),
                json_escape(&config.project_id),
                json_escape(&config.instance_id),
                json_escape(&runtime_status()),
                status_payload(config),
            );
            write_response(&mut stream, 200, &body);
        }
        _ => write_response(&mut stream, 404, "{\"error\":\"not found\"}"),
    }
}

fn parse_request(request: &str) -> (String, HashMap<String, String>) {
    let mut lines = request.lines();
    let first = lines.next().unwrap_or_default();
    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    (path, headers)
}

fn request_allowed(headers: &HashMap<String, String>, allowed_origin: &str) -> bool {
    let normalized = allowed_origin.trim().trim_start_matches("https://").trim_start_matches("http://");
    let origin = headers.get("origin").map(|v| v.trim().trim_start_matches("https://").trim_start_matches("http://"));
    let collab_origin = headers.get("x-collab-origin").map(|v| v.trim().trim_start_matches("https://").trim_start_matches("http://"));
    origin == Some(normalized) || collab_origin == Some(normalized)
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn read_env_file(path: &str) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path).map_err(|err| format!("{}: {}", path, err))?;
    let mut values = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            values.insert(key.trim().to_string(), value.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    Ok(values)
}

fn required(values: &HashMap<String, String>, key: &str) -> Result<String, String> {
    values.get(key).filter(|value| !value.is_empty()).cloned().ok_or_else(|| format!("{} is required", key))
}

fn systemd_status(service: &str) -> String {
    command_output("systemctl", &["is-active", service]).unwrap_or_else(|| "unknown".to_string())
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|pair| pair[0] == name).map(|pair| pair[1].clone())
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if c.is_control() => escaped.push(' '),
            c => escaped.push(c),
        }
    }
    escaped
}
