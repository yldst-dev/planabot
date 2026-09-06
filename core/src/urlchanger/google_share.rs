use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use once_cell::sync::Lazy;
use reqwest::StatusCode;
use reqwest::header::LOCATION;
use url::Url;

use super::link_utils::clean_tracking_params;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_HOPS: usize = 5;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; planabot/0.1)";

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
});

enum Hop {
    Continue(Url),
    Final(Url),
}

pub async fn resolve_google_share_link(original: &str) -> Result<String> {
    let mut current = Url::parse(original).context("구글 공유 링크 파싱 실패")?;
    if !is_google_share_url(&current) {
        bail!("구글 공유 링크가 아닙니다: {original}");
    }
    for _ in 0..MAX_HOPS {
        let response = CLIENT.get(current.clone()).send().await?;
        let status = response.status();
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        match next_hop(&current, status, location.as_deref())? {
            Hop::Continue(url) => current = url,
            Hop::Final(url) => return Ok(clean_tracking_params(url.as_str())),
        }
    }
    bail!("리다이렉트 횟수 초과: {original}")
}

fn next_hop(current: &Url, status: StatusCode, location: Option<&str>) -> Result<Hop> {
    if !status.is_redirection() {
        bail!("리다이렉트가 아닌 응답: {status}");
    }
    let location = location.ok_or_else(|| anyhow!("Location 헤더가 없습니다"))?;
    let target = current.join(location).context("Location 파싱 실패")?;
    if !matches!(target.scheme(), "http" | "https") {
        bail!("지원하지 않는 스킴: {}", target.scheme());
    }
    if is_google_share_url(&target) {
        Ok(Hop::Continue(target))
    } else {
        Ok(Hop::Final(target))
    }
}

pub fn is_google_share_url(url: &Url) -> bool {
    match url.host_str() {
        Some("share.google") => true,
        Some("www.google.com") | Some("google.com") => url.path() == "/share.google",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    #[test]
    fn google_share_hosts_are_recognized() {
        assert!(is_google_share_url(&parse(
            "https://share.google/MzxpBP1tsi6KkgPpw"
        )));
        assert!(is_google_share_url(&parse(
            "https://www.google.com/share.google?q=MzxpBP1tsi6KkgPpw"
        )));
        assert!(!is_google_share_url(&parse(
            "https://www.google.com/search?q=a"
        )));
        assert!(!is_google_share_url(&parse(
            "https://www.yna.co.kr/view/AKR1"
        )));
    }

    #[test]
    fn next_hop_continues_through_google_and_stops_at_destination() {
        let start = parse("https://share.google/MzxpBP1tsi6KkgPpw");
        let hop = next_hop(
            &start,
            StatusCode::FOUND,
            Some("https://www.google.com/share.google?q=MzxpBP1tsi6KkgPpw"),
        )
        .unwrap();
        let Hop::Continue(next) = hop else {
            panic!("expected continue");
        };
        let hop = next_hop(
            &next,
            StatusCode::MOVED_PERMANENTLY,
            Some("https://www.yna.co.kr/view/AKR20260905036300085"),
        )
        .unwrap();
        let Hop::Final(url) = hop else {
            panic!("expected final");
        };
        assert_eq!(
            url.as_str(),
            "https://www.yna.co.kr/view/AKR20260905036300085"
        );
    }

    #[test]
    fn next_hop_resolves_relative_location() {
        let start = parse("https://share.google/abc");
        let Hop::Continue(url) =
            next_hop(&start, StatusCode::FOUND, Some("/share.google?q=abc")).unwrap()
        else {
            panic!("expected continue");
        };
        assert_eq!(url.as_str(), "https://share.google/share.google?q=abc");
    }

    #[test]
    fn next_hop_rejects_non_redirects_and_bad_locations() {
        let start = parse("https://share.google/abc");
        assert!(next_hop(&start, StatusCode::OK, None).is_err());
        assert!(next_hop(&start, StatusCode::FOUND, None).is_err());
        assert!(next_hop(&start, StatusCode::FOUND, Some("javascript:alert(1)")).is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn resolves_live_google_share_link() {
        let resolved = resolve_google_share_link("https://share.google/MzxpBP1tsi6KkgPpw")
            .await
            .expect("resolve");
        eprintln!("resolved: {resolved}");
        assert!(resolved.starts_with("https://"));
        assert!(!resolved.contains("share.google"));
    }
}
