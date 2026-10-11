// The Woolworths category tree, and browsing it.
//
// PiesCategoriesWithSpecials returns the whole tree in one ~870 KB response
// (~2,600 nodes, ~15 fields each) - far too much to hand an LLM, and it
// changes rarely. So it is fetched once, cached, and indexed; tools return one
// level of it at a time.
//
// Specials are part of the same tree: a top-level "specials" group whose
// children are the special types (half-price, lower-shelf-price, ...), each
// with per-department children of its own.

import { request } from "./woolworths.js";

const TREE_TTL_MS = 6 * 60 * 60 * 1000;
const SPECIALS_ROOT = "specials";

interface RawNode {
  NodeId: string;
  Description: string;
  UrlFriendlyName: string;
  ProductCount?: number;
  Children?: RawNode[];
}

export interface CategoryNode {
  id: string;
  name: string;
  path: string; // slug path, e.g. "fruit-veg/fruit" or "specials/half-price"
  children: CategoryNode[];
}

interface Tree {
  roots: CategoryNode[];
  byKey: Map<string, CategoryNode>; // by id and by path
  fetchedAt: number;
}

let tree: Tree | null = null;
let pending: Promise<Tree> | null = null;

function build(raw: RawNode[]): Tree {
  const byKey = new Map<string, CategoryNode>();
  const convert = (r: RawNode, parent: string): CategoryNode => {
    const path = parent ? `${parent}/${r.UrlFriendlyName}` : r.UrlFriendlyName;
    const node: CategoryNode = {
      id: r.NodeId,
      name: r.Description,
      path,
      children: [],
    };
    byKey.set(node.id, node);
    if (!byKey.has(path)) byKey.set(path, node);
    node.children = (r.Children ?? []).map((c) => convert(c, path));
    return node;
  };
  return { roots: raw.map((r) => convert(r, "")), byKey, fetchedAt: Date.now() };
}

async function getTree(): Promise<Tree> {
  if (tree && Date.now() - tree.fetchedAt < TREE_TTL_MS) return tree;
  if (!pending) {
    pending = request<{ Categories: RawNode[] }>("/apis/ui/PiesCategoriesWithSpecials")
      .then((data) => (tree = build(data.Categories ?? [])))
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

const summarise = (n: CategoryNode) => ({
  id: n.id,
  name: n.name,
  path: n.path,
  ...(n.children.length ? { children: n.children.length } : {}),
});

/** One level of the tree: the departments, or the children of `parent`. */
export async function listCategories(parent?: string) {
  const t = await getTree();
  if (!parent) {
    return {
      categories: t.roots.filter((n) => n.path !== SPECIALS_ROOT).map(summarise),
      specialTypes: specialTypes(t).map((n) => n.path.slice(SPECIALS_ROOT.length + 1)),
    };
  }
  const node = await resolve(parent);
  return { parent: summarise(node), categories: node.children.map(summarise) };
}

// "my-specials-and-offers" is personalised: without a logged-in account it
// answers 401, and this server only ever has an anonymous session.
const ACCOUNT_ONLY = new Set([`${SPECIALS_ROOT}/my-specials-and-offers`]);

function specialTypes(t: Tree): CategoryNode[] {
  return (t.byKey.get(SPECIALS_ROOT)?.children ?? []).filter((n) => !ACCOUNT_ONLY.has(n.path));
}

/** Find a category by id or slug path. */
export async function resolve(key: string): Promise<CategoryNode> {
  const t = await getTree();
  const node = t.byKey.get(key.replace(/^\/+|\/+$/g, ""));
  if (!node) throw new Error(`Unknown category "${key}". Use woolworths_get_categories for ids and paths.`);
  return node;
}

/**
 * The specials to browse: a special type ("half-price"), a department's
 * specials ("fruit-veg"), or both - a special type within one department.
 * Neither means half-price, the broadest general one.
 */
export async function resolveSpecials(type?: string, category?: string): Promise<{ node: CategoryNode; specialsOnly: boolean }> {
  const t = await getTree();
  if (!type && category) return { node: await resolve(category), specialsOnly: true };

  const types = specialTypes(t);
  const typeNode = types.find((n) => n.path === `${SPECIALS_ROOT}/${type ?? "half-price"}`);
  if (!typeNode) {
    throw new Error(`Unknown special type "${type}". Available: ${types.map((n) => n.path.slice(SPECIALS_ROOT.length + 1)).join(", ")}`);
  }
  if (!category) return { node: typeNode, specialsOnly: false };

  // The type's children are departments; match on the department's own slug
  // or id, so "fruit-veg" and "1-E5BEE36E" both work.
  const dept = await resolve(category);
  const slug = dept.path.split("/").pop();
  const child = typeNode.children.find((c) => c.path.endsWith(`/${slug}`) || c.id.endsWith(`.${dept.id}`));
  if (!child) {
    throw new Error(
      `No ${type} specials in "${category}". Departments with ${type} specials: ${typeNode.children.map((c) => c.path.split("/").pop()).join(", ")}`
    );
  }
  return { node: child, specialsOnly: false };
}

/** One page of a category's products, as the website's browse page loads them. */
export async function browse(node: CategoryNode, opts: { specialsOnly: boolean; pageNumber: number; pageSize: number }) {
  return request("/apis/ui/browse/category", {
    cacheMs: 5 * 60 * 1000,
    body: {
      categoryId: node.id,
      pageNumber: opts.pageNumber,
      pageSize: opts.pageSize,
      sortType: "TraderRelevance",
      url: `/shop/browse/${node.path}`,
      location: `/shop/browse/${node.path}`,
      formatObject: JSON.stringify({ name: node.name }),
      isSpecial: opts.specialsOnly,
      isBundle: false,
      isMobile: false,
      filters: [],
    },
  });
}
