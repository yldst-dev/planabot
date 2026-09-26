use std::path::PathBuf;

use axum::body::Body;
use axum::extract::Path;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use super::apply_security_headers;

const CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MISSING_BUILD: &str =
    "대시보드 빌드 없음. dashboard 폴더에서 npm ci와 npm run build를 실행하십시오.";

pub(crate) fn dist_dir() -> PathBuf {
    let raw = std::env::var("PLANABOT_DASHBOARD_DIR")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| "dashboard/dist".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub(crate) async fn index() -> Response {
    serve("index.html", false).await
}

pub(crate) async fn favicon() -> Response {
    serve("favicon.svg", false).await
}

pub(crate) async fn asset(Path(name): Path<String>) -> Response {
    if !is_safe_name(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve(&format!("assets/{name}"), true).await
}

async fn serve(relative: &str, immutable: bool) -> Response {
    let bytes = match tokio::fs::read(dist_dir().join(relative)).await {
        Ok(bytes) => bytes,
        Err(_) if relative == "index.html" => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(CONTENT_TYPE, "text/plain; charset=utf-8")],
                MISSING_BUILD,
            )
                .into_response();
        }
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(content_type(relative)),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(CSP),
    );
    apply_security_headers(headers);
    response
}

fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("png") => "image/png",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{content_type, is_safe_name};

    #[test]
    fn accepts_hashed_asset_names() {
        assert!(is_safe_name("index-C3jn6nTj.js"));
        assert!(is_safe_name("PretendardVariable.subset.58-DlucQts_.woff2"));
    }

    #[test]
    fn rejects_traversal_and_hidden_names() {
        assert!(!is_safe_name(""));
        assert!(!is_safe_name(".."));
        assert!(!is_safe_name("../index.html"));
        assert!(!is_safe_name("..%2Findex.html"));
        assert!(!is_safe_name(".env"));
        assert!(!is_safe_name("a/b.js"));
        assert!(!is_safe_name("a\\b.js"));
    }

    #[test]
    fn maps_known_extensions() {
        assert_eq!(content_type("a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("font.woff2"), "font/woff2");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }
}
