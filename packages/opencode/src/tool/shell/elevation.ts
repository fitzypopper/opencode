import type { Node } from "web-tree-sitter"

export const Mode = ["off", "pkexec"] as const
export type Mode = (typeof Mode)[number]

export interface Paths {
  pkexec: string
  sudo: string
}

interface Site {
  start: number
  end: number
}

const ELEVATORS = new Set(["sudo"])

function normalize(text: string) {
  return text.replaceAll("\\", "").replace(/^["']|["']$/g, "")
}

function commandName(node: Node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_name") return child
  }
  return undefined
}

export function sites(root: Node) {
  const out: Site[] = []
  for (const node of root.descendantsOfType("command")) {
    if (!node) continue
    const name = commandName(node)
    if (!name || !ELEVATORS.has(normalize(name.text))) continue
    out.push({ start: name.startIndex, end: name.endIndex })
  }
  return out.sort((a, b) => a.start - b.start)
}

export function wrap(paths: Paths) {
  return `${paths.pkexec} --disable-internal-agent ${paths.sudo} -n`
}

/**
 * Rewrite every `sudo` invocation in the command to run through `pkexec`, so
 * authentication happens in a polkit window instead of relying on headless
 * passwordless sudo. Returns undefined when nothing needs rewriting.
 */
export function rewrite(command: string, root: Node, paths: Paths): string | undefined {
  const found = sites(root)
  if (found.length === 0) return undefined
  let out = command
  for (let i = found.length - 1; i >= 0; i--) {
    const site = found[i]
    out = out.slice(0, site.start) + wrap(paths) + out.slice(site.end)
  }
  return out
}

/** Exit code pkexec uses when the user is not authorized. */
export const NOT_AUTHORIZED_EXIT = 126

export * as Elevation from "./elevation"
