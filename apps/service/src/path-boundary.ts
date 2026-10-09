/** Lexical POSIX containment for trusted normalized absolute paths. */
export function beneath(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}
