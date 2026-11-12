import type {ImagePanel} from './images.js';
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
  images?: ImagePanel,
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
  const containsImage=(n:MarkdownNode):boolean=>n.kind==='image'||n.children.some(containsImage);
  const draw = (node: MarkdownNode, imageLink?:()=>HTMLAnchorElement|null): Node => {
    if(node.kind==='image'&&images)return images.draw(node,imageLink);
    if(node.kind==='link'&&node.children.some(containsImage)){
      const wrapper=document.createElement('span');
      const link=()=>{const copy=markdown({...node,children:[]},relative);return copy.querySelector('a');};
      for(const child of node.children){if(containsImage(child))wrapper.append(draw(child,link));else{const a=link();if(a){a.append(draw(child));wrapper.append(a);}else wrapper.append(draw(child));}}
      return wrapper;
    }
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
    for (const child of node.children || []) element.append(draw(child,imageLink));
    return element;
  };
  const root = document.createElement("div");
  root.className = "markdown-body";
  root.append(draw(tree));
  return root;
}
