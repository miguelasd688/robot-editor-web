export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

function splitPath(p: string) {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
}

export function buildTree(keys: string[]): TreeNode {
  const root: Extract<TreeNode, { kind: "dir" }> = {
    kind: "dir",
    name: "",
    path: "",
    children: [],
  };

  const dirMap = new Map<string, Extract<TreeNode, { kind: "dir" }>>();
  dirMap.set("", root);

  const ensureDir = (dirPath: string, name: string) => {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;

    const parts = dirPath.split("/").filter(Boolean);
    const parentPath = parts.length <= 1 ? "" : parts.slice(0, -1).join("/") + "/";
    const parent = ensureDir(parentPath, parts[parts.length - 2] ?? "");

    const node: Extract<TreeNode, { kind: "dir" }> = {
      kind: "dir",
      name,
      path: dirPath,
      children: [],
    };
    parent.children.push(node);
    dirMap.set(dirPath, node);
    return node;
  };

  for (const k of keys) {
    const parts = splitPath(k);
    if (parts.length === 0) continue;

    let curPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      curPath = curPath ? `${curPath}${seg}/` : `${seg}/`;
      ensureDir(curPath, seg);
    }

    const fileName = parts[parts.length - 1];
    const parentDirPath = parts.length === 1 ? "" : parts.slice(0, -1).join("/") + "/";

    const parent = ensureDir(parentDirPath, parts[parts.length - 2] ?? "");
    parent.children.push({ kind: "file", name: fileName, path: k });
  }

  const sortNode = (n: TreeNode) => {
    if (n.kind === "dir") {
      n.children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      n.children.forEach(sortNode);
    }
  };
  sortNode(root);

  return root;
}

export function dirAncestors(filePath: string): string[] {
  const parts = splitPath(filePath);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}${parts[i]}/` : `${parts[i]}/`;
    out.push(cur);
  }
  return out;
}
