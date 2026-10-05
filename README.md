# hh

The Huishouden command line: the developer process (`hh dev`), operating the suite (`hh ops`) and,
to come, the household's data as the signed-in person (`hh data`). Every command takes `--json`:
one JSON document on stdout, progress on stderr.

```sh
bunx github:huishouden/cli#v1 dev ready      # no install
bun add -g github:huishouden/cli#v1          # or install `hh`
```

Needs [Bun](https://bun.sh), [gh](https://cli.github.com) signed in, and for some commands
`firebase-tools` signed in to the staging project, `gcloud` (staging signed-in tests), Java 21
(emulator tests) and [cr](https://github.com/piekstra/codereview-cli) (reviews).

## The pull request lifecycle

The author owns everything before `main`; pull requests run no hosted CI (pwa-kit STANDARD.md
"Pull requests").

| Step | Command | Does |
|---|---|---|
| 1 | `gh pr create --draft` | Open the PR as a draft |
| 2 | `hh dev review` | `cr review` as the reviewer account with the org's reviewers (huishouden/cr-reviewers, cloned to `~/Dev/huishouden-cr-reviewers` and registered on the `reviewer` profile if missing; `--max-agents 8`; `--fresh-session` on a PR's first review after the reviewers change), one review at a time on the machine; lists findings and unresolved threads. Bar: no Blocking or Major |
| 3 | `hh dev verify` | Install, lint, the kit's checks (design, writes, headers, i18n, bandwidth), unit tests, build, screenshots on a local preview (phone and tablet, light and dark), emulator tests with the household's rules |
| 3 | `hh dev evidence` | The same, or on the app's staging site when the change touches rules, Workers, sign-in, Google or notifications (`--staging`/`--local` override): build against `huishouden-staging`, deploy the suite with this build to the app's staging site with your own `firebase` login, smoke and signed-in tests there (`pwa-staging run`), screenshots. Posts or updates one PR comment with the results and the images (GitHub's user-attachments). Never production |
| 4 | `hh dev release` | package.json version (semver from the Conventional Commits since the last tag) and its CHANGELOG.md section; `--commit` commits them |
| 5 | `hh dev ready` | Refuses unless the reviewer account reviewed the head commit and no Blocking or Major finding is still open (a finding closes when its threads on its line are resolved; one posted only in the review body stays open until a later review drops it), the evidence comment is for the head commit and passed, and the version is bumped with its section (docs-only changes need none); then `gh pr ready` |
| 6 | merge | `main` builds, tests, deploys, smoke-checks over HTTP and tags the version |

`hh dev bump-kit` moves `@huishouden/pwa-kit` to its latest tag and runs lint and tests: do it in
any repo you touch.

## Operations

`hh ops profile-check [--fix]`: the org profile (huishouden/.github `profile/README.md`) and every
app's and Worker's repo description against `apps.json` and the repos with a `wrangler.toml`.
`--fix` fills empty descriptions from `apps.json` and opens a PR adding missing rows.

## Account

`hh login [--staging]` opens the portal's `/connect` page; on Allow the portal hands this computer
(a listener on 127.0.0.1) your sign-in, which goes to the OS keychain (macOS Keychain, or
libsecret). `hh whoami`, `hh logout`. The `hh data` commands will act as you, so the household's
rules apply, with the kit's server-safe cores the AI connector uses.

## Adding a command

One file under `src/commands/<group>/` calling `register({ group, name, summary, usage, run })`,
imported from the group's `index.ts`. `run` returns `{ ok, data, text }`: `data` is the `--json`
output, `text` what people read. Bump the version and CHANGELOG.md in the PR (`hh dev release`);
`main` tags it and moves `v1`.

## License

[PolyForm Shield 1.0.0](LICENSE).
