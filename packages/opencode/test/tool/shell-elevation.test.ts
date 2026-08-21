import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Language, Parser } from "web-tree-sitter"
import { Elevation } from "../../src/tool/shell/elevation"
import { ShellTool } from "../../src/tool/shell"
import { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const paths = { pkexec: "/usr/bin/pkexec", sudo: "/usr/bin/sudo" }
const wrap = Elevation.wrap(paths)

let bashParser: Parser | undefined

function resolveWasm(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

async function parser() {
  if (!bashParser) {
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    await Parser.init({
      locateFile() {
        return resolveWasm(treeWasm)
      },
    })
    const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
      with: { type: "wasm" },
    })
    const language = await Language.load(resolveWasm(bashWasm))
    bashParser = new Parser()
    bashParser.setLanguage(language)
  }
  return bashParser
}

const rewrite = async (command: string) => {
  const tree = await parser().then((p) => p.parse(command))
  if (!tree) throw new Error(`failed to parse: ${command}`)
  try {
    return Elevation.rewrite(command, tree.rootNode, paths)
  } finally {
    tree.delete()
  }
}

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const eit = testEffect(shellLayer)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const run = Effect.fn("elevation.run")(function* (args: Tool.InferParameters<typeof ShellTool>) {
  const info = yield* ShellTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.shell elevation rewrite", () => {
  it("returns undefined for commands without sudo", async () => {
    expect(await rewrite("echo hello")).toBeUndefined()
    expect(await rewrite("echo sudo hello")).toBeUndefined()
    expect(await rewrite('echo "sudo install me"')).toBeUndefined()
    expect(await rewrite("lsudo -la")).toBeUndefined()
  })

  it("wraps a simple sudo command", async () => {
    expect(await rewrite("sudo apt install foo")).toBe(`${wrap} apt install foo`)
  })

  it("preserves sudo flags by wrapping sudo itself", async () => {
    expect(await rewrite("sudo -u alice whoami")).toBe(`${wrap} -u alice whoami`)
    expect(await rewrite("sudo --preserve-env=PATH env")).toBe(`${wrap} --preserve-env=PATH env`)
  })

  it("wraps every sudo occurrence in compound commands", async () => {
    expect(await rewrite("sudo systemctl stop nginx && sudo systemctl start nginx")).toBe(
      `${wrap} systemctl stop nginx && ${wrap} systemctl start nginx`,
    )
    expect(await rewrite("whoami | sudo tee /etc/version && echo done")).toBe(
      `whoami | ${wrap} tee /etc/version && echo done`,
    )
  })

  it("handles leading environment assignments", async () => {
    expect(await rewrite("DEBIAN_FRONTEND=noninteractive sudo apt upgrade")).toBe(
      `DEBIAN_FRONTEND=noninteractive ${wrap} apt upgrade`,
    )
  })

  it("wraps escaped sudo without the escape", async () => {
    expect(await rewrite("\\sudo dnf update")).toBe(`${wrap} dnf update`)
  })

  it("keeps surrounding text byte-exact", async () => {
    const command = "echo pre && sudo env | grep PATH; post 'quoted arg' > out.txt"
    const result = await rewrite(command)
    expect(result!.startsWith("echo pre && ")).toBe(true)
    expect(result!.endsWith("; post 'quoted arg' > out.txt")).toBe(true)
  })

  it("wraps quoted command names since shells still resolve them", async () => {
    expect(await rewrite('"sudo" x')).toBe(`${wrap} x`)
  })
})

describe("tool.shell elevation config", () => {
  const decode = (input: unknown) => {
    try {
      return Schema.decodeUnknownSync(ConfigV1.Info)(input)
    } catch {
      return undefined
    }
  }

  it("accepts sudo.mode pkexec", () => {
    const result = decode({ sudo: { mode: "pkexec" } })
    expect(result?.sudo?.mode).toBe("pkexec")
  })

  it("defaults to unset", () => {
    expect(decode({})?.sudo).toBeUndefined()
  })

  it("rejects unknown modes", () => {
    expect(decode({ sudo: { mode: "window" } })).toBeUndefined()
  })
})

if (process.platform === "linux") {
  describe("tool.shell elevation runtime", () => {
    const withPath = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => process.env.PATH),
        (prev) =>
          Effect.gen(function* () {
            process.env.PATH = `${directory}${path.delimiter}${prev ?? ""}`
            return yield* self
          }),
        (prev) =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env.PATH
            else process.env.PATH = prev
          }),
      )

    const fakePkexec = (logfile: string) =>
      Effect.gen(function* () {
        const bin = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          fs.writeFile(path.join(bin, "pkexec"), `#!/bin/sh\necho "$@" >> "${logfile}"\nexit 0\n`),
        )
        yield* Effect.promise(() => fs.chmod(path.join(bin, "pkexec"), 0o755))
        return bin
      })

    eit.live("leaves commands untouched when mode is off", () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const result = yield* run({ command: "echo hello" })
            expect(result.metadata.exit).toBe(0)
            expect((result.metadata as { elevated?: boolean }).elevated).toBeUndefined()
          }),
        )
      }),
    )

    eit.live("routes sudo through pkexec when mode is enabled", () =>
      Effect.gen(function* () {
        const log = path.join(os.tmpdir(), `pkexec-log-${Math.random().toString(36).slice(2)}`)
        const bin = yield* fakePkexec(log)
        const tmp = yield* tmpdirScoped({ config: { sudo: { mode: "pkexec" } } })
        yield* withPath(
          bin,
          runIn(
            tmp,
            Effect.gen(function* () {
              const result = yield* run({ command: "sudo true" })
              const meta = result.metadata as { elevated?: boolean; exit?: number }
              expect(meta.elevated).toBe(true)
              expect(meta.exit).toBe(0)
              expect(result.title).toBe("sudo true")
              const logged = yield* Effect.promise(() => fs.readFile(log, "utf8"))
              expect(logged.trim()).toBe(`--disable-internal-agent /usr/bin/sudo -n true`)
            }),
          ),
        )
      }),
    )

    eit.live("fails closed when pkexec is not resolvable", () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const prev = process.env.PATH
          process.env.PATH = "/nonexistent-opencode-elevation-test"
          return prev
        }),
        () =>
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ config: { sudo: { mode: "pkexec" } } })
            const error = yield* squash(runIn(tmp, run({ command: "sudo touch marker" })))
            expect(String(error)).toContain("fail closed")
          }),
        (prev) =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env.PATH
            else process.env.PATH = prev
          }),
      ),
    )
  })
}

const squash = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) throw new Error("expected effect to fail")
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  })
