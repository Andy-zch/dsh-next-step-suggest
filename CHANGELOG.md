# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `README.md` (English), `LICENSE` (MIT), this changelog.

## [0.4.0] — 2026-11-11

### Changed
- **Package renamed** `@local/dsh-next-step-suggest` → `dsh-next-step-suggest`, so the repo can be published to npm and installed by anyone.
- Removed `private: true`; added `license`, `repository`, `homepage`, `bugs`, `keywords`.

Reinstalling is required: the Loader row name changed.

## [0.3.1] — 2026-10-29

### Fixed
- **Trigger never fired.** The trigger was an edge (`running: true → false`); if the component remounted mid-turn the edge never happened again. Replaced with an idempotent condition check, so any re-render can self-heal.
- Draft emptiness now uses `draft.trim()`; a whitespace-only draft no longer blocks the suggestion forever.
- "Input machine busy" now means `phase === 'adjudicating' | 'submitting'`, not "anything other than `plain`".
- The previous turn's suggestion is cleared when a new turn starts, otherwise the "nothing on screen" gate could never pass again.

### Added
- `RETRY_GAP_MS` (60 s) between attempts, so an empty response cannot spin.
- `[next-step] skip: <reason>` console line, one per reason change, for diagnosing why nothing appears.

## [0.3.0] — 2026-10-29

### Changed
- The prompt asks **what the task should advance to**, not what the user would type. The old wording statistically produces "continue".
- Rules run before the model: in-progress todo, pending todo, active plan. No model call when a rule hits.
- Suggestion language follows the user's last message (`zh` / `en` rule wording).

### Added
- `POST /api/next-step/stats` with per-session `shown / accepted / dismissed` counters, printed to the console on accept and dismiss.

## [0.2.2] — 2026-10-29

### Changed
- Trigger reduced to a single path; page load and tab focus no longer trigger.
- Frequency gates: 3 min between appearances, 6 per session, 2 consecutive `Esc` mutes.
- Display delayed by 1.2 s so the reply is read first.

### Fixed
- Ghost text colour no longer freezes at the theme it was measured in — it uses theme tokens now.
- Pure filler suggestions ("continue", "ok") are dropped server-side.

### Added
- `enabled` config flag: silence the plugin without uninstalling.

## [0.2.1] — 2026-10-29

### Changed
- One suggestion instead of three; the `1/3`, `↻`, `Alt+]`, `Alt+[`, `Alt+R` affordances were removed.
- `Esc` now hides the suggestion for the rest of the turn instead of a 30 s cooldown.

### Fixed
- **Cross-session leak.** A response in flight during a session switch could write one session's suggestion into another composer. Every async result is now checked against the originating session id, and in-flight requests are aborted on switch.

## [0.2.0] — 2026-10-29

### Added
- Real model prediction over `POST /api/next-step`: last 8 turns, todos, working directory.
- Per-`(sessionId, seq)` cache, dedup against the last 3 suggestions, one retry when everything collides.
- `Tab` cycling between candidates and a regenerate shortcut.

### Fixed
- Accepting a suggestion used to disable the plugin for the whole session.
- Suggestions no longer appear while the agent is running or before there is any history.

## [0.1.0] — 2026-10-29

### Added
- Ghost-text projection in `conversation.input.overlay`, measured against the native placeholder.
- `Tab` accepts through `inputActions.setDraft`; capture-phase key arbitration; session-scoped.
- Locale resources and icon so the plugin appears in Settings → Plugins.
