import { createSignal, onCleanup } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

const POLICIES = [
  { value: "ask", title: "Ask", description: "Prompt in GUI window every time" },
  { value: "on", title: "On", description: "Run with cached credentials" },
  { value: "off", title: "Off", description: "Deny all sudo commands" },
] as const

function readPolicy(): string {
  try {
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const statePath = path.join(process.env.HOME ?? "~", ".config", "opencode", "sudo-policy")
    return fs.readFileSync(statePath, "utf8").trim()
  } catch {
    return "ask"
  }
}

export function DialogSudo() {
  const dialog = useDialog()
  const [current, setCurrent] = createSignal(readPolicy())

  const options = POLICIES.map((p) => ({
    value: p.value,
    title: p.title,
    description: p.description,
    onSelect: () => {
      dialog.clear()
      setCurrent(p.value)
      try {
        const fs = require("fs") as typeof import("fs")
        const path = require("path") as typeof import("path")
        const statePath = path.join(process.env.HOME ?? "~", ".config", "opencode", "sudo-policy")
        fs.mkdirSync(path.dirname(statePath), { recursive: true })
        fs.writeFileSync(statePath, p.value + "\n")
      } catch {}
    },
  }))

  return (
    <DialogSelect<string>
      options={options}
      title="Sudo policy"
      current={current()}
      flat={true}
    />
  )
}
