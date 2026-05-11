//! Atom-фиды каналов YouTube (`feeds/videos.xml?channel_id=…`): разбор по правилам MRSS / `yt:*`.
//!
//! Для каждой `<entry>`:
//! - заголовок статьи — `media:title` внутри `media:group`, иначе `<title>` записи;
//! - тело — превью `media:thumbnail`, затем `media:description`, иначе summary/content Atom;
//! - стабильный guid — `yt:video:<id>` (из `yt:videoId`, `yt:video:…` в id или из ссылки).

use atom_syndication::Feed as AtomFeed;
use chrono::Utc;
use rss::{Channel, Guid, Item};

use super::atom_mrss::{
    append_mrss_native_video_tags, atom_entry_alternate_link, atom_extension_first_value,
    mrss_group_first_text_in_groups, mrss_thumbnail_url,
};
use super::normalize::{canonical_youtube_item_guid, youtube_video_id_ok};

/// Распознаёт фид вида `https://www.youtube.com/feeds/videos.xml?…` / `yt:channel:…`.
pub fn is_youtube_channel_feed(atom: &AtomFeed) -> bool {
    if atom.id.contains("yt:channel:") {
        return true;
    }
    atom.links
        .iter()
        .any(|l| l.href.contains("youtube.com/feeds/videos"))
}

fn youtube_video_id_for_entry(entry: &atom_syndication::Entry) -> Option<String> {
    if let Some(v) = atom_extension_first_value(entry, "videoId") {
        let v = v.trim();
        if youtube_video_id_ok(v) {
            return Some(v.to_ascii_lowercase());
        }
    }
    if let Some(c) = canonical_youtube_item_guid(&entry.id) {
        return c
            .strip_prefix("yt:video:")
            .map(|s| s.to_string());
    }
    atom_entry_alternate_link(entry).as_ref().and_then(|l| {
        canonical_youtube_item_guid(l).and_then(|g| {
            g.strip_prefix("yt:video:")
                .map(|s| s.to_string())
        })
    })
}

fn mrss_description_to_html(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if raw.contains('<') && raw.contains('>') {
        return raw.to_string();
    }
    let parts: Vec<&str> = raw.split("\n\n").map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return format!("<p>{}</p>", html_escape::encode_text(raw));
    }
    parts
        .iter()
        .map(|p| format!("<p>{}</p>", html_escape::encode_text(p)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Тело HTML для YouTube-записи: картинка → описание MRSS → запасной Atom → ссылка → MRSS video.
fn youtube_entry_html(entry: &atom_syndication::Entry) -> String {
    let mut html = String::new();

    if let Some(u) = mrss_thumbnail_url(entry) {
        let src = html_escape::encode_double_quoted_attribute(&u);
        let img = format!(
            r#"<p><img src="{src}" alt="" loading="lazy" style="max-width:100%;height:auto"/></p>"#
        );
        html.push_str(&img);
    }

    if let Some(mrss_desc) = mrss_group_first_text_in_groups(entry, "description") {
        let block = mrss_description_to_html(&mrss_desc);
        if !block.is_empty() {
            html.push_str(&block);
        }
    } else if let Some(c) = &entry.content {
        if let Some(v) = &c.value {
            if !v.trim().is_empty() {
                html.push_str(v);
            }
        }
    }
    if let Some(s) = &entry.summary {
        if html.trim().is_empty() {
            let t = s.as_str().trim();
            if !t.is_empty() {
                let block = match s.r#type {
                    atom_syndication::TextType::Html => s.value.clone(),
                    _ => format!("<p>{}</p>", html_escape::encode_text(s.as_str())),
                };
                html.push_str(&block);
            }
        }
    }

    if let Some(url) = atom_entry_alternate_link(entry) {
        if !html.contains(url.as_str()) {
            let href = html_escape::encode_double_quoted_attribute(&url);
            let link_line = format!(
                r#"<p><a href="{href}" rel="noopener noreferrer">Открыть источник</a></p>"#
            );
            html.push_str(&link_line);
        }
    }

    append_mrss_native_video_tags(html, entry)
}

/// Строит `rss::Channel` из уже распарсенного Atom-фида канала YouTube.
pub fn channel_from_youtube_atom(atom: AtomFeed) -> Result<Channel, String> {
    let feed_link = atom
        .links
        .iter()
        .find(|l| l.rel == "alternate" || l.rel == "self" || l.rel.is_empty())
        .or_else(|| atom.links.first())
        .map(|l| l.href.clone())
        .unwrap_or_default();

    let mut channel = Channel::default();
    channel.set_title(atom.title.to_string());
    channel.set_link(feed_link);
    channel.set_description(format!("YouTube · {}", atom.title.as_str()));

    let mut items: Vec<Item> = Vec::with_capacity(atom.entries.len());
    for e in atom.entries.into_iter() {
        let html = youtube_entry_html(&e);
        let when = e
            .published
            .unwrap_or(e.updated)
            .with_timezone(&Utc)
            .to_rfc2822();
        let link = atom_entry_alternate_link(&e);

        let stable_id = youtube_video_id_for_entry(&e).map(|id| format!("yt:video:{id}")).or_else(|| {
            link.as_ref().and_then(|l| canonical_youtube_item_guid(l))
        }).or_else(|| canonical_youtube_item_guid(&e.id)).or_else(|| link.clone()).unwrap_or_else(|| e.id.clone());

        let title = mrss_group_first_text_in_groups(&e, "title")
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| e.title.to_string());

        let mut it = Item::default();
        it.set_title(Some(title));
        if let Some(l) = link {
            it.set_link(Some(l));
        }
        let mut g = Guid::default();
        g.set_value(stable_id);
        g.set_permalink(true);
        it.set_guid(Some(g));
        if !html.is_empty() {
            it.set_content(Some(html));
        }
        it.set_pub_date(Some(when));
        items.push(it);
    }
    channel.set_items(items);
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use atom_syndication::Feed as AtomFeed;

    use super::{channel_from_youtube_atom, is_youtube_channel_feed};

    fn sample_youtube_atom() -> &'static [u8] {
        br#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <id>yt:channel:UCxxxxxxxxxxxxxxxxxxxxxxxxxxxx</id>
  <title>Test Channel</title>
  <link rel="self" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxxxxxxxx"/>
  <updated>2020-01-01T00:00:00Z</updated>
  <entry>
    <id>yt:video:AbCdEfGhIj1</id>
    <yt:videoId>AbCdEfGhIj1</yt:videoId>
    <title>Short entry title</title>
    <published>2020-01-02T00:00:00Z</published>
    <updated>2020-01-02T00:00:00Z</updated>
    <link rel="alternate" href="https://www.youtube.com/watch?v=AbCdEfGhIj1"/>
    <media:group>
      <media:title>Long media title from MRSS</media:title>
      <media:thumbnail url="https://i.ytimg.com/vi/AbCdEfGhIj1/hqdefault.jpg" width="480" height="360"/>
      <media:description>First paragraph.

Second paragraph with &lt;no html&gt;.</media:description>
    </media:group>
  </entry>
</feed>"#
    }

    #[test]
    fn detects_youtube_channel_feed() {
        let atom = AtomFeed::read_from(Cursor::new(sample_youtube_atom())).expect("atom");
        assert!(is_youtube_channel_feed(&atom));
    }

    #[test]
    fn youtube_prefers_media_title_description_and_guid() {
        let atom = AtomFeed::read_from(Cursor::new(sample_youtube_atom())).expect("atom");
        let ch = channel_from_youtube_atom(atom).expect("channel");
        assert_eq!(ch.description(), "YouTube · Test Channel");
        let it = &ch.items()[0];
        assert_eq!(it.title(), Some("Long media title from MRSS"));
        assert_eq!(it.guid().expect("guid").value(), "yt:video:abcdefghij1");
        let html = it.content().expect("html");
        assert!(html.contains("hqdefault.jpg"), "{html}");
        assert!(html.contains("First paragraph."), "{html}");
        assert!(html.contains("Second paragraph"), "{html}");
        assert!(html.contains("watch?v=AbCdEfGhIj1") || html.contains("Открыть источник"), "{html}");
    }
}
