use anyhow::{Result, bail};

pub(super) const COMPAT_USER_AGENT: &str = "Mozilla/5.0 (compatible; planabot/0.1)";

pub(super) async fn read_body_limited(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>> {
    let declared = response.content_length().unwrap_or(0);
    if declared as usize > limit {
        bail!("응답 크기 초과: {} bytes", declared);
    }
    let mut buf = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if buf.len() + chunk.len() > limit {
            bail!("응답 크기 초과: {} bytes 이상", limit);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

pub(super) fn unescape_html(raw: &str) -> String {
    raw.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::unescape_html;

    #[test]
    fn ampersand_is_decoded_last_so_entities_are_not_decoded_twice() {
        assert_eq!(unescape_html("a&amp;quot;b"), "a&quot;b");
        assert_eq!(unescape_html("a&amp;b&lt;c&#x27;"), "a&b<c'");
    }
}
