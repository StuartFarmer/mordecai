import navigation from '../../../docs/navigation.json';
export { navigation };
export const chapters = navigation.flatMap((group) => group.pages);
const modules = import.meta.glob('../../../docs/src/**/*.{md,mdx}', { eager: true });
export function chapter(slug) {
  const entry = modules[`../../../docs/src/${slug}.md`] ?? modules[`../../../docs/src/${slug}.mdx`];
  if (!entry) throw new Error(`Missing documentation chapter: ${slug}`);
  return entry;
}
