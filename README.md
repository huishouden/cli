# hh

The Huishouden command line: the household's data as the signed-in person (`hh data`), operating
the suite (`hh ops`) and the developer process (`hh dev`). Every command takes `--json`: one JSON
document on stdout, progress on stderr.

```sh
bun add -g https://github.com/huishouden/cli/releases/download/vX.Y.Z/cli-X.Y.Z.tgz   # installs `hh` from a release's tarball (public, no token)
hh self-update                                                                         # installs the latest release by hand
```

hh updates itself: before a command runs, if a newer release exists (asked of GitHub at most once
every 6 hours, cached in `~/.cache/hh`), it installs it and runs the same command on the new
version. It does nothing in CI (`CI` set), with `HH_NO_AUTO_UPDATE=1`, offline, or from a source
checkout, and a failed update is a warning, never a stop. Trust model: write access to this repo's
releases is code-signing authority, since machines install what a release carries (no separate
signature or checksum); keep it to the people who merge to main.

Needs [Bun](https://bun.sh). `hh login` and `hh data` need nothing else. The developer and
operations commands also need [gh](https://cli.github.com) signed in, and for some of them
`firebase-tools` signed in to the staging project, `gcloud` (auth domains, staging signed-in tests),
Java 21+ (emulator tests; hh finds one through JAVA_HOME, PATH, `/usr/libexec/java_home` or Homebrew even when the default `java` is older) and [cr](https://github.com/piekstra/codereview-cli) (reviews).

## The pull request lifecycle

The author owns everything before `main`; pull requests run no hosted CI (pwa-kit STANDARD.md
"Pull requests").

| Step | Command | Does |
|---|---|---|
| 1 | `gh pr create --draft` | Open the PR as a draft |
| 2 | `hh dev review` | `cr review` as the reviewer account with the org's reviewers (huishouden/cr-reviewers, cloned to `~/Dev/huishouden-cr-reviewers` and registered on the `reviewer` profile if missing; `--max-agents 8`; `--fresh-session` on a PR's first review after the reviewers change), one review at a time on the machine; lists findings and unresolved threads. Bar: no Blocking or Major |
| 3 | `hh dev verify` | Install, lint, the kit's checks (design, writes, headers, i18n, bandwidth), unit tests, build, screenshots on a local preview (phone and tablet, light and dark; a scene written for one size that doesn't render at the other is reported, not failed), emulator tests with the household's rules |
| 3 | `hh dev evidence` | The same, or on the app's staging site when the change touches rules, Workers, sign-in, Google or notifications (`--staging`/`--local` override): build against `huishouden-staging`, deploy the suite with this build to the app's staging site with your own `firebase` login, smoke and signed-in tests there (`pwa-staging run`), screenshots. Posts or updates one PR comment with the results and the images (GitHub's user-attachments). Never production |
| 4 | `hh dev ready` | Refuses unless the reviewer account reviewed the head commit and no Blocking or Major finding is still open (a finding closes when its threads on its line are resolved; one posted only in the review body stays open until a later review drops it) and the evidence comment is for the head commit and passed; then `gh pr ready`. If the kit was behind it is bumped first (below) and review and evidence are reused when only the kit moved since (see below), else redone |
| 5 | merge (squash) | `main` builds and tests, then CI versions and releases (below) |

The model: start a draft, run `hh dev ready`, merge. A PR carries no version, CHANGELOG or built
output; title it as a Conventional Commit (the squash-merge title is the commit). `hh dev release`
is a no-op that says so.

On every merge to main, CI computes the next semver from the Conventional Commit titles since the
last `v*` tag (`feat` is minor, `fix`/`perf`/`refactor` patch, `!` or `BREAKING CHANGE:` major;
`chore`/`docs`/`test`/`ci` alone release nothing), creates the annotated tag, and creates the
GitHub release with generated notes and `cli-X.Y.Z.tgz` attached (`bun pm pack`, packed with that
version; `package.json` stays `0.0.0` and nothing is committed back). `hh self-update` and
self-update-on-run install that asset by its URL. Releases are serialized by the workflow's
concurrency group; a tag whose release failed half-way is finished by the next run.

When a repo pins an older kit than the latest release, `hh dev verify|evidence|review|ready` first
applies `bump-kit` as a commit "chore: kit vX.Y.Z" on the current branch (package pin, `bun.lock`
and the exact workflow refs), pushes it when the branch has an upstream, and prints what changed,
so the PR carries it. `--no-bump-kit` skips it; it never runs on `main` or over uncommitted edits
to `package.json`, `bun.lock` or the workflows.

`hh dev ready` accepts a review or evidence of an earlier commit (an ancestor) when the diff since
it touches only the kit: `package.json` changed only in its `@huishouden/pwa-kit` pin (to
huishouden/pwa-kit's release at an equal or later exact tag), `.github/workflows/*.y(a)ml` changed
only in their `huishouden/pwa-kit/.github/workflows/*@vX.Y.Z` refs (exact tags, none going back),
and `bun.lock` changed only on the kit's own two lines, resolving to that same release (its tarball URL, or the commit its tag points to). Any other file or change refuses, and review
and evidence are redone. An earlier review is used only when nothing reviewed the head itself (a
failing review of the head is never replaced), and evidence comments count only from the PR author
or the reviewer.

`hh dev bump-kit` moves `@huishouden/pwa-kit` (to the latest release's tarball URL when the release
has one, else its git tag) and the `huishouden/pwa-kit/.github/workflows/*.yml@vX.Y.Z` workflow
references to the latest exact tag together and runs lint and tests.

## Signing in

`hh login [--staging]` signs you in through the portal, in your browser, as in every app:

1. hh listens on `127.0.0.1` on a port the OS picks and opens the portal's
   `/connect?service=hh&redirect=http://127.0.0.1:<port>/callback&state=…&code_challenge=…`.
2. The portal accepts only that exact loopback shape (never `localhost` or another host), signs you
   in if needed and asks: "Sign in to the hh command-line tool on this computer". Allow only right
   after running `hh login`.
3. On Allow the portal hands your sign-in to the connector Worker, which keeps it two minutes under
   a one-time code bound to hh's state and PKCE challenge, and sends your browser back to hh with
   only that code. Your refresh token is never in a URL.
4. hh checks the state and trades the code, with the PKCE verifier only it knows, for your sign-in.
   A replayed, expired or mismatched code gets nothing.

The sign-in is kept in the macOS Keychain or libsecret (`secret-tool`, Linux). Without either it
goes to an encrypted file under `~/.config/hh` with a warning: its key sits next to it unless you
set `HH_PASSPHRASE`. `hh whoami` checks it with Firebase Auth. `hh logout` removes it from this
computer; Firebase can't revoke a single sign-in from a client, so it ends everywhere only when the
account is disabled or deleted.

## Household data

`hh data <command>` acts as you, so the household's rules decide what you may read and change. The
commands are the AI connector's own tools (`@huishouden/pwa-kit/household-tools`), the same code,
so the two can't disagree. Output is tables for lists and the tool's sentence for changes, in your
Huishouden language and time zone. `--json` gives the tool's text and data for agents. Writes are
not marked as the assistant's: they look as if you made them in the app.

| Command | Does |
|---|---|
| `households`, `household home` | Who you are, your households and role; the household's address and time zone |
| `today`, `calendar [from] [to]`, `todos` | Today's agenda and to-dos; the calendar by day; every open to-do |
| `todo done <id>`, `todo cancel <id>` | A to-do's Done or Cancel, exactly as the portal does it |
| `groceries list [list]`, `groceries add <name>`, `groceries check <item>` | Shopping lists |
| `tasks add <name>` | A task, with `--due` |
| `bills due` | Open bills (admins and members) |
| `pet today [pet]`, `pet feeding <pet>`, `pet dose <pet> <medicine>`, `pet outing <pet> --pooped` | The feeding board, reminders, courses and outings (bathroom breaks, walks); logging |
| `home upkeep`, `home event <title>` | Upkeep due; a regular event or a visit |
| `appointment add <app> <title> <start>` | An appointment for a pet, the baby, a car or a person |
| `contacts search <query>`, `contacts add <name>` | The household's contacts |
| `health people`, `health medicines <person>`, `health history <person>`, `health due [person]` | Health, for the people you care for |
| `health appointments [person]`, `health dose <person> <medicine>`, `health add <person> <name>`, `health update <person> <medicine>`, `health doctor-list <person>` | Visits; logging doses (with Health's guards: `--confirm` after a warning), medicines, the doctor's list |

Every other argument is a flag named after the tool's (`--dose-time 08:00`, `--no-reminders`,
`--times 08:00,20:00`); `hh data <command> --help` lists them. `--household <id or name>` picks a
household when you have several. `--staging` uses your staging sign-in.

## Operations

| Command | Does |
|---|---|
| `hh ops auth-domains [--production\|--staging]` | Firebase Auth's authorized domains against the expected set (pwa-kit docs/one-site.md "Sign-in origins"), with your gcloud login. Fix with the kit bootstrap |
| `hh ops oauth-check [--production\|--staging]` | The OAuth web client's JavaScript origins and the auth handler redirect URI, probed with the kit's checks. Missing entries are added in the console (Google has no API) |
| `hh ops secret set <repo> <name> [--env <environment>]` | A GitHub Actions secret on huishouden/`<repo>`, the value from stdin only (a pipe, or typed with echo off); never from argv, never printed. Wraps `gh secret set` |
| `hh ops monitoring [--dry-run]` | Runs the portal's monitoring workflow (New Relic) and summarizes each step and what provisioning said |
| `hh ops roles`, `hh ops roles set <email> <role>` | The household's people and roles; setting one as the signed-in admin, through the rules |
| `hh ops profile-check [--fix]` | The org profile (huishouden/.github `profile/README.md`) and every app's and Worker's repo description against `apps.json` and the repos with a `wrangler.toml`. `--fix` fills empty descriptions from `apps.json` and opens a PR adding missing rows |
| `hh ops staging-cleanup` | Removes staging test households and people over a day old (the kit's `pwa-staging sweep`), with a token from your gcloud login impersonating the staging deploy account (needs Service Account Token Creator on it). `hh dev evidence --staging` runs it after its tests; nothing sweeps staging on a schedule |

## Tests

`bun run test`: unit tests, including `hh login` against a stand-in connector running the kit's
hand-off (state mismatch, a refused code, declining, a foreign Host header, the timeout) and the
credential stores. `bun run test:emulator` (Java 21): `hh data`, `hh whoami`, `hh ops roles` and
`hh logout` as two signed-in people against the Auth and Firestore emulators with the household's
rules from huishouden/rules.

## Adding a command

One file under `src/commands/<group>/` calling `register({ group, name, summary, usage, run })`,
imported from the group's `index.ts`. `run` returns `{ ok, data, text }`: `data` is the `--json`
output, `text` what people read. Title the PR as a Conventional Commit; CI versions it on merge and
no tag ever moves.

## License

[PolyForm Shield 1.0.0](LICENSE).
