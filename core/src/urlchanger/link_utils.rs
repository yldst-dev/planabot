use log::warn;
use regex::Regex;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkConversion {
    pub original: String,
    pub converted: String,
    pub disable_preview: bool,
}

pub fn contains_music_link(text: &str) -> bool {
    let patterns = [
        r"https?://(?:www\.)?youtu(?:\.be|be\.com)/\S+",
        r"https?://(?:www\.)?music\.youtube\.com/\S+",
        r"https?://(?:www\.)?open\.spotify\.com/\S+",
    ];

    patterns.iter().any(|pattern| {
        Regex::new(pattern)
            .map(|re| re.is_match(text))
            .unwrap_or(false)
    })
}

pub fn contains_x_link(text: &str) -> bool {
    let pattern = r"\.?https?://(?:www\.)?(?:x|twitter)\.com/\S+";
    Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

pub fn contains_instagram_link(text: &str) -> bool {
    let pattern = r"https?://(?:www\.)?instagram\.com/\S+";
    Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

pub fn remove_si_parameter(url_str: &str) -> String {
    if let Ok(mut url) = Url::parse(url_str) {
        if url.query().is_some() {
            let query_pairs: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(k, _)| k != "si")
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();

            url.set_query(None);

            if !query_pairs.is_empty() {
                let query = query_pairs
                    .iter()
                    .map(|(k, v)| format!("{}={}", k, v))
                    .collect::<Vec<String>>()
                    .join("&");

                if !query.is_empty() {
                    url.set_query(Some(&query));
                }
            }
        }

        if url.host_str() == Some("youtu.be") {
            let path = url.path().to_string();
            if path.contains("si=") {
                let new_path = path.split("si=").next().unwrap_or("").trim_end_matches('?');
                url.set_path(new_path);
            }
        }

        return url.to_string();
    }

    url_str.to_string()
}

pub fn extract_music_links(text: &str) -> Vec<(String, String)> {
    let patterns = [
        r"(https?://(?:www\.)?youtu(?:\.be|be\.com)/\S+)",
        r"(https?://(?:www\.)?music\.youtube\.com/\S+)",
        r"(https?://(?:www\.)?open\.spotify\.com/\S+)",
    ];

    let mut links = Vec::new();

    for pattern in patterns {
        if let Ok(re) = Regex::new(pattern) {
            for cap in re.captures_iter(text) {
                if let Some(m) = cap.get(1) {
                    let original_url = m.as_str();
                    let cleaned_url = remove_si_parameter(original_url);

                    if original_url != cleaned_url {
                        links.push((original_url.to_string(), cleaned_url));
                    }
                }
            }
        }
    }

    links
}

pub fn convert_x_links(text: &str) -> Vec<LinkConversion> {
    // capture optional dot prefix to allow opt-out of previews (e.g., ".https://x.com/...")
    let pattern = r"(\.?)(https?://(?:www\.)?(?:x|twitter)\.com/\S+)";
    let mut links = Vec::new();

    if let Ok(re) = Regex::new(pattern) {
        for cap in re.captures_iter(text) {
            let dot_prefix = cap.get(1).map(|m| m.as_str() == ".").unwrap_or(false);
            if let Some(url_match) = cap.get(2) {
                let original_url = url_match.as_str();
                match Url::parse(original_url) {
                    Ok(mut parsed) => {
                        parsed.set_host(Some("fxtwitter.com")).ok();
                        parsed.set_query(None);
                        parsed.set_fragment(None);
                        let original_in_text = if dot_prefix {
                            format!(".{}", original_url)
                        } else {
                            original_url.to_string()
                        };
                        links.push(LinkConversion {
                            original: original_in_text,
                            converted: parsed.to_string(),
                            disable_preview: dot_prefix,
                        });
                    }
                    Err(e) => warn!("X 링크 파싱 실패: {}", e),
                }
            }
        }
    }

    links
}

pub fn convert_instagram_links(text: &str) -> Vec<(String, String)> {
    let pattern = r"(https?://(?:www\.)?instagram\.com/\S+)";
    let mut links = Vec::new();

    if let Ok(re) = Regex::new(pattern) {
        for cap in re.captures_iter(text) {
            if let Some(m) = cap.get(1) {
                let original_url = m.as_str();
                match Url::parse(original_url) {
                    Ok(mut parsed) => {
                        parsed.set_host(Some("www.kkinstagram.com")).ok();
                        parsed.set_query(None);
                        parsed.set_fragment(None);
                        links.push((original_url.to_string(), parsed.to_string()));
                    }
                    Err(e) => warn!("Instagram 링크 파싱 실패: {}", e),
                }
            }
        }
    }

    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_si_parameter_youtube() {
        let original = "https://youtu.be/Vc-ByDGOuQE?si=qIy-ihfrRKmDAPZP";
        let expected = "https://youtu.be/Vc-ByDGOuQE";
        assert_eq!(remove_si_parameter(original), expected);
    }

    #[test]
    fn test_remove_si_parameter_youtube_music() {
        let original = "https://music.youtube.com/watch?v=nmYDYalgb5w&si=GGi18ac_fxnx4F1b";
        let expected = "https://music.youtube.com/watch?v=nmYDYalgb5w";
        assert_eq!(remove_si_parameter(original), expected);
    }

    #[test]
    fn test_remove_si_parameter_spotify() {
        let original = "https://open.spotify.com/track/1FYWnRofuIgJf62AnX8i5S?si=bf00147df50f4141";
        let expected = "https://open.spotify.com/track/1FYWnRofuIgJf62AnX8i5S";
        assert_eq!(remove_si_parameter(original), expected);
    }

    #[test]
    fn test_remove_si_parameter_with_multiple_params() {
        let original = "https://music.youtube.com/watch?v=nmYDYalgb5w&si=GGi18ac_fxnx4F1b&list=RDAMVMnmYDYalgb5w";
        let expected = "https://music.youtube.com/watch?v=nmYDYalgb5w&list=RDAMVMnmYDYalgb5w";
        assert_eq!(remove_si_parameter(original), expected);
    }

    #[test]
    fn test_convert_x_links_rewrites_host_and_strips_query() {
        let text = "https://x.com/lettuce9094/status/1997610286262718819?s=20";
        let pairs = convert_x_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(
            pairs[0].converted,
            "https://fxtwitter.com/lettuce9094/status/1997610286262718819"
        );
        assert!(!pairs[0].disable_preview);
        assert_eq!(
            pairs[0].original,
            "https://x.com/lettuce9094/status/1997610286262718819?s=20"
        );
    }

    #[test]
    fn test_convert_x_links_with_dot_prefix_disables_preview_and_strips_dot() {
        let text = ".https://x.com/user/status/12345?s=99";
        let pairs = convert_x_links(text);
        assert_eq!(pairs.len(), 1);
        assert!(pairs[0].disable_preview);
        assert_eq!(
            pairs[0].converted,
            "https://fxtwitter.com/user/status/12345"
        );
        assert_eq!(pairs[0].original, ".https://x.com/user/status/12345?s=99");
    }

    #[test]
    fn test_convert_instagram_links_rewrites_host_and_strips_query() {
        let text = "https://www.instagram.com/p/DR_uVJVklbf/?utm_source=ig_web_copy_link&igsh=Nm9hazRuaXNrdGo1";
        let pairs = convert_instagram_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].1, "https://www.kkinstagram.com/p/DR_uVJVklbf/");
    }
}
