//! CommonMark to a restricted presentation tree. Never emits an HTML string.
use crate::{err, Result};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub children: Vec<Node>,
}
impl Node {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            text: None,
            target: None,
            children: vec![],
        }
    }
}
pub fn link_target(input: &str) -> Option<String> {
    if input
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return None;
    }
    if input.starts_with("http://") || input.starts_with("https://") {
        return Some(input.into());
    }
    if input.starts_with("magnet:")
        && (feedtorrent_bep::normalize_magnet_input(input).is_ok()
            || feedtorrent_bep::bep46::parse_magnet(input).is_ok())
    {
        return Some(input.into());
    }
    if !input.is_empty()
        && !input.starts_with('/')
        && !input.contains(':')
        && !input.split('/').any(|p| p == ".." || p == ".")
    {
        return Some(input.into());
    }
    None
}
pub fn parse(input: &str) -> Result<Node> {
    if input.len() > super::publishing::MAX_BODY {
        return Err(err("Markdown exceeds 1 MiB"));
    }
    let mut stack = vec![Node::new("document")];
    let mut count = 0;
    for event in Parser::new(input) {
        count += 1;
        if count > 100_000 || stack.len() > 64 {
            return Err(err("Markdown structure exceeds presentation limits"));
        }
        match event {
            Event::Start(tag) => {
                let kind = match &tag {
                    Tag::Paragraph | Tag::HtmlBlock => "p",
                    Tag::Heading { level, .. } => match level {
                        HeadingLevel::H1 => "h1",
                        HeadingLevel::H2 => "h2",
                        HeadingLevel::H3 => "h3",
                        HeadingLevel::H4 => "h4",
                        HeadingLevel::H5 => "h5",
                        HeadingLevel::H6 => "h6",
                    },
                    Tag::BlockQuote(_) => "blockquote",
                    Tag::CodeBlock(_) => "pre",
                    Tag::List(Some(_)) => "ol",
                    Tag::List(None) => "ul",
                    Tag::Item => "li",
                    Tag::Emphasis => "em",
                    Tag::Strong => "strong",
                    Tag::Link { .. } => "link",
                    Tag::Image { .. } => "span",
                    _ => "span",
                };
                let mut node = Node::new(kind);
                if let Tag::Link { dest_url, .. } = tag {
                    node.target = link_target(&dest_url)
                }
                stack.push(node);
            }
            Event::End(_) => {
                let n = stack.pop().ok_or_else(|| err("Invalid Markdown nesting"))?;
                stack
                    .last_mut()
                    .ok_or_else(|| err("Invalid Markdown nesting"))?
                    .children
                    .push(n)
            }
            Event::Text(t) | Event::Html(t) | Event::InlineHtml(t) => {
                let mut n = Node::new("text");
                n.text = Some(t.into_string());
                stack.last_mut().unwrap().children.push(n)
            }
            Event::Code(t) => {
                let mut n = Node::new("code");
                n.text = Some(t.into_string());
                stack.last_mut().unwrap().children.push(n)
            }
            Event::SoftBreak | Event::HardBreak => {
                stack.last_mut().unwrap().children.push(Node::new("br"))
            }
            Event::Rule => stack.last_mut().unwrap().children.push(Node::new("hr")),
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err(err("Invalid Markdown nesting"));
    }
    Ok(stack.remove(0))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hostile_content_is_data() {
        let n=parse("# Hi\n\n<script>alert(1)</script>\n\n![alt](https://evil.invalid/image.svg) [x](javascript:alert%281%29)").unwrap();
        let s = serde_json::to_string(&n).unwrap();
        assert!(s.contains("<script>"));
        assert!(!s.contains("evil.invalid"));
        assert!(!s.contains("javascript:"));
        assert!(link_target("//evil.invalid").is_none());
        assert!(link_target("../escape").is_none());
    }
}
