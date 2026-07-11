import type { FileNode } from '../types';
import { ChevronIcon, FileIcon, FolderIcon } from './FileIcon';

interface FileTreeProps {
  root: FileNode;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

/**
 * Collapsible file tree. Children of collapsed folders are hidden.
 * Each row is a keyboard-accessible button.
 */
export function FileTree({ root, selectedPath, expanded, onToggle, onSelect }: FileTreeProps) {
  // Recompute on every render so expand/collapse is reflected immediately.
  // The tree is small enough that memoization isn't worth the complexity.
  const rows = flatten(root, expanded);

  return (
    <ul role="tree" className="text-sm font-mono select-none">
      {rows.map((node) => (
        <FileRow
          key={node.node.path}
          node={node.node}
          depth={node.depth}
          expanded={expanded.has(node.node.path) || node.node.path === ''}
          selected={selectedPath === node.node.path}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

interface VisibleNode {
  node: FileNode;
  depth: number;
}

/**
 * Produces the ordered list of rows that should be visible given the
 * current `expanded` set. Children of collapsed folders are skipped, but
 * the synthetic root itself is always visible.
 */
function flatten(root: FileNode, expanded: Set<string>): VisibleNode[] {
  const out: VisibleNode[] = [];

  // Always show the synthetic root node first.
  out.push({ node: root, depth: 0 });

  const walk = (node: FileNode, depth: number, parentVisible: boolean) => {
    if (!parentVisible) return;
    out.push({ node, depth });
    if (!node.isDirectory) return;
    const visible = node.path === '' || expanded.has(node.path);
    for (const child of node.children) {
      walk(child, depth + 1, visible);
    }
  };

  for (const child of root.children) {
    walk(child, 1, true);
  }
  return out;
}

interface FileRowProps {
  node: FileNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function FileRow({ node, depth, expanded, selected, onToggle, onSelect }: FileRowProps) {
  const isFolder = node.isDirectory;
  const label = isFolder ? `Toggle ${node.name || 'root'}` : `Open ${node.name}`;

  return (
    <li role="treeitem" aria-expanded={isFolder ? expanded : undefined} className="leading-7">
      <button
        type="button"
        onClick={() => {
          if (isFolder && node.path !== '') onToggle(node.path);
          if (!isFolder) onSelect(node.path);
        }}
        aria-label={label}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors ${
          selected ? 'bg-violet-500/20 text-violet-100' : 'text-zinc-300 hover:bg-zinc-800/70'
        }`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {isFolder ? (
          <ChevronIcon open={expanded} className="h-3 w-3 shrink-0 text-zinc-500" />
        ) : (
          <span className="inline-block h-3 w-3 shrink-0" />
        )}
        {isFolder ? (
          <FolderIcon className="h-4 w-4 shrink-0 text-amber-300/90" />
        ) : (
          <FileIcon category={node.entry?.category ?? 'other'} className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate">{node.name || '(root)'}</span>
      </button>
    </li>
  );
}
