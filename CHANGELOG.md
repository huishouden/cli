# Changelog

## [1.1.0](https://github.com/huishouden/cli/compare/v1.0.0...v1.1.0) (2026-10-05)

### Features

* **dev:** review bar from the review's findings; free emulator ports; .hh excluded ([7548111](https://github.com/huishouden/cli/commit/7548111ccdbfc438d1432b0d33a5900535e58b32))

## 1.0.0 (2026-10-05)

### Features

* `hh dev verify`, `evidence`, `release`, `ready`, `review`, `bump-kit`: the pull request lifecycle owned by its author (pwa-kit STANDARD.md "Pull requests").
* `hh ops profile-check`: the org profile and repo descriptions against apps.json and the Worker repos; `--fix` opens a PR.
* `hh login`, `whoami`, `logout`: one sign-in through the portal's /connect hand-off, kept in the OS keychain, for the `hh data` commands to come.
* A command registry with `dev`, `ops`, `data` and account groups; `--json` on every command.
