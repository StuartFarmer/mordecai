// Keep repository Markdown links readable while preserving published chapter URLs.
export function documentationLinks() {
  return function walk(node) {
    if (node.type === 'link' && typeof node.url === 'string' && !/^[a-z]+:/i.test(node.url))
      node.url = node.url.replace(/\.mdx?(?=$|[?#])/, '.html');
    for (const child of node.children ?? []) walk(child);
  };
}
