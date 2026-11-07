//! a16z adapter, ported from `packages/adapters/src/a16z.ts`.

use chrono::DateTime;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{first_group, replace_all, strip_tags};

const SITEMAP_INDEX_URL: &str = "https://a16z.com/sitemap_index.xml";
const MAX_ARTICLE_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default)]
pub struct A16zAdapterOptions {
    pub max_items: Option<usize>,
    pub now: Option<DateTime<chrono::Utc>>,
}

pub struct A16zAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    now: DateTime<chrono::Utc>,
}

impl<F: Fetch> A16zAdapter<F> {
    pub fn new(fetch: F, options: A16zAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(5),
            now: options.now.unwrap_or_else(chrono::Utc::now),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for A16zAdapter<F> {
    fn name(&self) -> &str {
        "a16z"
    }

    fn source_type(&self) -> &str {
        "a16z"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;
        let now = self.now;

        Box::pin(async move {
            let Ok(index_response) = fetch.fetch(SITEMAP_INDEX_URL, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !index_response.ok() {
                return Ok(Vec::new());
            }

            let sitemap_urls: Vec<String> = parse_sitemap_index(&index_response.body)
                .into_iter()
                .filter_map(|url| url::Url::parse(&url).ok())
                .filter(|url| {
                    url.domain() == Some("a16z.com") && url.path().starts_with("/post-sitemap")
                })
                .map(|url| url.to_string())
                .collect();

            let entries_by_sitemap = futures::future::join_all(
                sitemap_urls
                    .iter()
                    .map(|url| fetch_sitemap_entries(fetch, url)),
            )
            .await;
            let mut entries: Vec<SitemapEntry> = entries_by_sitemap
                .into_iter()
                .filter_map(|result| result.ok())
                .flatten()
                .collect();
            entries.sort_by(|a, b| {
                let a_time = crate::dates::parse_datetime_millis(&a.lastmod).unwrap_or(0);
                let b_time = crate::dates::parse_datetime_millis(&b.lastmod).unwrap_or(0);
                b_time.cmp(&a_time)
            });

            let now_millis = now.timestamp_millis();
            let recent: Vec<SitemapEntry> = entries
                .into_iter()
                .filter(|entry| {
                    let Some(lastmod) = crate::dates::parse_datetime_millis(&entry.lastmod) else {
                        return false;
                    };
                    now_millis - lastmod <= MAX_ARTICLE_AGE_MS
                })
                .take(max_items * 2)
                .collect();

            let articles = futures::future::join_all(
                recent
                    .iter()
                    .map(|entry| fetch_article(fetch, entry.clone(), now)),
            )
            .await;

            Ok(articles
                .into_iter()
                .filter_map(|result| result.ok())
                .flatten()
                .take(max_items)
                .collect())
        })
    }
}

#[derive(Debug, Clone)]
struct SitemapEntry {
    url: String,
    lastmod: String,
}

fn parse_sitemap_index(html: &str) -> Vec<String> {
    // `html.split(/<sitemap[^>]*>/).slice(1)`, then each `<loc>([^<]+)</loc>`.
    crate::xml_util::split_pattern(r"<sitemap[^>]*>", html)
        .into_iter()
        .skip(1)
        .filter_map(|part| first_group(r"<loc>([^<]+)</loc>", &part))
        .filter(|url| !url.is_empty())
        .collect()
}

async fn fetch_sitemap_entries<F: Fetch + Send + Sync>(
    fetch: &F,
    url: &str,
) -> Result<Vec<SitemapEntry>, crate::types::AdapterError> {
    let Ok(response) = fetch.fetch(url, FetchInit::get()).await else {
        return Ok(Vec::new());
    };
    if !response.ok() {
        return Ok(Vec::new());
    }
    let parts = crate::xml_util::split_pattern(r"<url[^>]*>", &response.body);
    let mut entries = Vec::new();
    for part in parts.iter().skip(1) {
        let Some(loc) = first_group(r"<loc>([^<]+)</loc>", part) else {
            continue;
        };
        let Some(lastmod) = first_group(r"<lastmod>([^<]+)</lastmod>", part) else {
            continue;
        };
        if lastmod.is_empty() || !loc.starts_with("https://a16z.com/") {
            continue;
        }
        entries.push(SitemapEntry { url: loc, lastmod });
    }
    Ok(entries)
}

async fn fetch_article<F: Fetch + Send + Sync>(
    fetch: &F,
    entry: SitemapEntry,
    now: DateTime<chrono::Utc>,
) -> Result<Option<SourceItem>, crate::types::AdapterError> {
    let Ok(response) = fetch.fetch(&entry.url, FetchInit::get()).await else {
        return Ok(None);
    };
    if !response.ok() {
        return Ok(None);
    }
    let html = response.body;
    let published = extract_published(&html).unwrap_or_else(|| entry.lastmod.clone());
    let title = extract_title(&html);
    if title.is_empty() {
        return Ok(None);
    }
    let lines = clean_lines(&html);
    // `[...new Set(lines)].join(" ")`
    let mut seen: Vec<String> = Vec::new();
    let mut content_parts: Vec<String> = Vec::new();
    for line in lines {
        if seen.contains(&line) {
            continue;
        }
        seen.push(line.clone());
        content_parts.push(line.clone());
    }
    let content = content_parts
        .join(" ")
        .chars()
        .take(2000)
        .collect::<String>();
    if content.is_empty() {
        if let Some(published_millis) = crate::dates::parse_datetime_millis(&published) {
            if now.timestamp_millis() - published_millis > 48 * 60 * 60 * 1000 {
                return Ok(None);
            }
        }
    }

    let mut item = SourceItem {
        title: title.clone(),
        url: entry.url.clone(),
        content: if content.is_empty() { title } else { content },
        image_url: None,
        metadata: Map::new(),
    };
    if !published.is_empty() {
        let mut metadata = Map::new();
        metadata.insert("published".to_string(), Value::String(published));
        metadata.insert("source".to_string(), Value::String("a16z".to_string()));
        item.metadata = metadata;
    }
    Ok(Some(item))
}

fn extract_published(html: &str) -> Option<String> {
    first_group(r#""datePublished"\s*:\s*"([^"]+)""#, html)
        .or_else(|| {
            first_group(
                r#"<meta[^>]*property="article:published_time"[^>]*content="([^"]+)"[^>]*/?>"#,
                html,
            )
        })
        .filter(|value| !value.is_empty())
}

fn extract_title(html: &str) -> String {
    if let Some(og) = first_group(
        r#"<meta[^>]*property="og:title"[^>]*content="([^"]+)"[^>]*/?>"#,
        html,
    ) {
        return decode_html(&og).trim().to_string();
    }
    if let Some(title) = first_group(r"<title[^>]*>([\s\S]*?)</title>", html) {
        let title = decode_html(&title);
        return replace_all(r"\s*\|\s*(Andreessen Horowitz|a16z)\s*$", &title, "")
            .trim()
            .to_string();
    }
    String::new()
}

fn clean_lines(html: &str) -> Vec<String> {
    strip_tags(html, "\n")
        .split('\n')
        .map(|line| {
            decode_html(&replace_all(r"\s+", line, " "))
                .trim()
                .to_string()
        })
        .filter(|line| line.len() >= 40)
        .collect()
}

/// `decodeHtml` from `a16z.ts`.
fn decode_html(value: &str) -> String {
    let decoded = value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&rsquo;", "'")
        .replace("&lsquo;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "-")
        .replace("&ndash;", "-");
    // `&#(\d+);` → fromCodePoint(parseInt(decimal, 10))
    let mut output = String::with_capacity(decoded.len());
    let mut rest = decoded.as_str();
    while let Some(start) = rest.find("&#") {
        output.push_str(&rest[..start + 2]);
        let after = &rest[start + 2..];
        let Some(semicolon) = after.find(';') else {
            output.push_str(after);
            break;
        };
        let digits = &after[..semicolon];
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(code) = digits.parse::<u32>() {
                if let Some(chr) = char::from_u32(code) {
                    output.push(chr);
                }
            }
            rest = &after[semicolon + 1..];
        } else {
            output.push_str(&after[..semicolon + 1]);
            rest = &after[semicolon + 1..];
        }
    }
    output.push_str(rest);
    output
}
