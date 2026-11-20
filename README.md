# Next-Step Suggest

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that shows your next message as **ghost text inside the composer**. Press `Tab` to accept — it fills the draft and never sends.

One suggestion, two keys, three minutes apart. Deliberately quiet.

## Why it exists

Most "next prompt" plugins guess what you would type. That produces `continue`, `ok`, `next` — noise.

This one asks a different question: **what should the task advance to next?** When the answer is already in your session state, it does not call a model at all.

## How it decides

```
rule hit?  ── yes ──►  "Continue: <your in-progress todo>"
    │                  "Next: <your pending todo>"
    │                  "Continue with the plan"
    no
    ▼
model call (last 8 turns + todos + cwd)  ──►  one short instruction
```

- **Rules first**: in-progress todo → pending todo → active plan.
- **Model fallback**: asks for the next concrete action, in your language, never a bare "continue".
- **Vacuous guard**: a suggestion with no object (`continue`, `fine`, `ok`) is dropped server-side.

## Install

Until it is on npm, install from a local checkout:

```bash
dsh plugin --profile <your-profile> add /path/to/next-step-suggest
```

Or copy the directory into your profile's `node_modules` and add the row by hand — see [`cordis.patch.yml`](cordis.patch.yml).

Requirements: DSH `0.2.1-rc.x`, web UI.

## Use

| Key | Effect |
|---|---|
| `Tab` | Fill the draft with the suggestion (editable, one `Ctrl+Z` to undo) |
| `Esc` | Silence it for this turn |

If you keep typing, the ghost disappears on its own. After accepting, the next suggestion can appear 60 s later.

## When it appears

All of these at once:

1. the session has at least one user + assistant exchange
2. the agent is idle
3. the composer is empty (whitespace counts as empty)
4. no suggestion is already on screen
5. frequency gates pass — 60 s retry gap, 3 min between appearances, 6 appearances per session, 2 consecutive `Esc` mutes the session

It shows 1.2 s after the reply arrives, so you can read first.

**Nothing showing?** The console prints `[next-step] skip: <reason>` once per reason change — `running`, `draft`, `hidden`, `showing`, `retry-gap`, `cooldown`, `session-cap`, or `muted` names the gate that blocked it.

## Configuration

Per-row `config` in your profile's `cordis.patch.yml`:

```yaml
- id: next-step-suggest
  name: 'dsh-next-step-suggest'
  config:
    enabled: true        # false = silent, no uninstall needed
    rules: true          # false = always ask the model
    candidates: 1        # 1–3
    maxTokens: 120
    temperature: 0.9
    provider: ''         # empty = follow the session's own model
    model: ''
    reasoningEffort: ''  # empty = unspecified
    dedup: true
    timeoutMs: 6000
```

Reload the plugin after changing config (`remove_bundle` then `install_bundle`).

## Design notes

- **Ghost text is a projection, not content.** It renders in the composer overlay slot with `pointer-events: none`; it is never part of the draft, so it cannot be sent by accident.
- **Alignment is measured, not guessed.** The ghost copies the native placeholder's rect and font metrics, so it lines up on any theme or density.
- **Keys are arbitrated in the capture phase**, and only when the ghost is visible in the *same composer card* — two panes cannot double-write.
- **Sessions are isolated.** Every async result is checked against the originating session id before it touches state; late responses are dropped.
- **Failures are silent.** Timeouts, provider errors, empty output: nothing appears, nothing pops up.

## Known limitations

- Two composers open at once: the native placeholder is not hidden (the ghost may overlap it).
- Server module has ESM caching: after editing code, reinstall the plugin — a page refresh only reloads the client half.
- Frequency constants live in `client.js`; tune them by editing the file and reinstalling.

## License

MIT — see [LICENSE](LICENSE).
