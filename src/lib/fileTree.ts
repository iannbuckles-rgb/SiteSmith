import type { FileNode, ZipEntryMeta } from '../types';

/**
 * Builds a nested file tree from the flat list of zip entries.
 * Empty directories are preserved when present in the archive;
 * intermediate directories that only contain files are created implicitly.
 */
export function buildFileTree(entries: ZipEntryMeta[]): FileNode {
  const root: FileNode = {
    name: '',
    path: '',
    isDirectory: true,
    children: [],
  };

  for (const entry of entries) {
    if (entry.isDirectory) {
      // Ensure the directory node exists; if its parent already has a file
      // that implicitly created this folder, the folder is already in the tree.
      insertPath(root, entry.path.split('/'), entry);
      continue;
    }

    insertPath(root, entry.path.split('/'), entry);
  }

  sortRecursive(root);
  return root;
}

function insertPath(root: FileNode, segments: string[], entry: ZipEntryMeta): void {
  let current = root;
  let currentPath = '';

  segments.forEach((segment, idx) => {
    if (!segment) return;
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const isLast = idx === segments.length - 1;

    let child = current.children.find((c) => c.name === segment);
    if (!child) {
      child = {
        name: segment,
        path: currentPath,
        isDirectory: !isLast,
        children: [],
      };
      current.children.push(child);
    }

    if (isLast) {
      // A directory entry being inserted as the last segment means we're
      // marking a previously implicit folder as explicit. Keep its child
      // list intact.
      if (entry.isDirectory) {
        child.isDirectory = true;
      } else {
        child.entry = entry;
      }
    }

    current = child;
  });
}

function sortRecursive(node: FileNode): void {
  node.children.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortRecursive(child);
}
