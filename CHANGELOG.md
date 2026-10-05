# Changelog

## [1.1.1](https://github.com/huishouden/cli/compare/v1.1.0...v1.1.1) (2026-10-05)

### Bug Fixes

* **dev:** review reruns when cr keeps an older review; release --commit makes no empty commit ([85488d3](https://github.com/huishouden/cli/commit/85488d32b373eef1b759ef2f49e6d9d94b447912))

## [1.1.0](https://github.com/huishouden/cli/compare/v1.0.0...v1.1.0) (2026-10-05)

### Features

* **dev:** review bar from the review's findings; free emulator ports; .hh excluded ([7548111](https://github.com/huishouden/cli/commit/7548111ccdbfc438d1432b0d33a5900535e58b32))

### Bug Fixes

* drop unused imports kept alive with void ([f6445b7](https://github.com/huishouden/cli/commit/f6445b7159ace8a8cd81895638bff3eeb1ab6046))
* **dev:** review findings: worktree-safe .hh, line-exact review bar, review logic in lib, kit capability by version ([b603395](https://github.com/huishouden/cli/commit/b6033953b240bdac6c29ba1974f8fbe82844a779))

## 1.0.0 (2026-10-05)

### Features

* `hh dev verify`, `evidence`, `release`, `ready`, `review`, `bump-kit`: the pull request lifecycle owned by its author (pwa-kit STANDARD.md "Pull requests").
* `hh ops profile-check`: the org profile and repo descriptions against apps.json and the Worker repos; `--fix` opens a PR.
* `hh login`, `whoami`, `logout`: one sign-in through the portal's /connect hand-off, kept in the OS keychain, for the `hh data` commands to come.
* A command registry with `dev`, `ops`, `data` and account groups; `--json` on every command.
