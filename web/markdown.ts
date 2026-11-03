export interface MarkdownNode {
  kind: string;
  text?: string;
  target?: string;
  children: MarkdownNode[];
}
// No HTML parser, templates or downloaded attributes. Every remote byte is text.
export function markdown(
  tree: MarkdownNode,
  relative?: (target: string) => (() => void) | null,
): HTMLElement {
  const allowed = new Set([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "ol",
    "ul",
    "li",
    "em",
    "strong",
    "span",
    "code",
    "br",
    "hr",
  ]);
  const draw = (node: MarkdownNode): Node => {
    if (node.kind === "text") return document.createTextNode(node.text || "");
    let element: HTMLElement = document.createElement(
      allowed.has(node.kind) ? node.kind : "span",
    );
    if (node.kind === "document") element = document.createElement("article");
    if (node.kind === "link" && node.target) {
      const target = node.target;
      if (/^https?:\/\//.test(target)) {
        try {
          const url = new URL(target);
          if (["https:", "http:"].includes(url.protocol)) {
            const a = document.createElement("a");
            a.href = url.href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            element = a;
          }
        } catch {}
      } else if (relative) {
        const action = relative(target);
        if (action) {
          const a = document.createElement("a");
          a.href = "#";
          a.onclick = (event) => {
            event.preventDefault();
            action();
          };
          element = a;
        }
      }
    }
    if (node.text) element.textContent = node.text;
    for (const child of node.children || []) element.append(draw(child));
    return element;
  };
  const root = document.createElement("div");
  root.className = "markdown-body";
  root.append(draw(tree));
  return root;
}
