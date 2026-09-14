import type { Node } from "web-tree-sitter"

export const Mode = ["off", "pkexec"] as const
export type Mode = (typeof Mode)[number]

export const Policies = ["ask", "on", "off"] as const
export type Policy = (typeof Policies)[number]

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

/** Run sudo non-interactively so it only succeeds when credentials are cached. */
export function wrapAccept(paths: Pick<Paths, "sudo">) {
  return `${paths.sudo} -n`
}

export const DENIED_MESSAGE =
  'sudo commands are denied: sudo.policy is "off". Run `opencode-sudo on` or `opencode-sudo ask` to re-enable.'

/**
 * Resolve the effective sudo policy. Precedence: OPENCODE_SUDO_POLICY env var,
 * then the sudo-policy file in the config directory (live toggle, no restart),
 * then the configured default. Anything unrecognized falls back to "ask".
 */
export function resolvePolicy(
  fallback: string | undefined,
  env: string | undefined,
  file: string | undefined,
): Policy {
  for (const candidate of [env, file?.trim(), fallback]) {
    if (candidate && (Policies as readonly string[]).includes(candidate)) return candidate as Policy
  }
  return "ask"
}

/**
 * Rewrite every `sudo` invocation in the command, replacing the sudo token
 * with `wrapper`. Returns undefined when nothing needs rewriting. The wrapper
 * is either `wrap()` (pkexec prompt) or `wrapAccept()` (cached credentials).
 */
export function rewrite(command: string, root: Node, wrapper: string): string | undefined {
  const found = sites(root)
  if (found.length === 0) return undefined
  let out = command
  for (let i = found.length - 1; i >= 0; i--) {
    const site = found[i]
    out = out.slice(0, site.start) + wrapper + out.slice(site.end)
  }
  return out
}

/** Exit code pkexec uses when the user is not authorized. */
export const NOT_AUTHORIZED_EXIT = 126

export * as Elevation from "./elevation"
