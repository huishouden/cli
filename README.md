# hh

The Huishouden command line: the household's data as the signed-in person (`hh data`), operating
the suite (`hh ops`) and the developer process (`hh dev`). Every command takes `--json`: one JSON
document on stdout, progress on stderr.

```sh
bun add -g @huishouden/cli@github:huishouden/cli#v1.4.0   # installs `hh` at an exact release tag
hh self-update                                           # later: installs the latest release
bunx github:huishouden/cli#v1.4.0 dev ready              # no install, with an exact tag
```

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
| 4 | `hh dev release` | package.json version (semver from the Conventional Commits since the last tag) and its CHANGELOG.md section; `--commit` commits them |
| 5 | `hh dev ready` | Refuses unless the reviewer account reviewed the head commit and no Blocking or Major finding is still open (a finding closes when its threads on its line are resolved; one posted only in the review body stays open until a later review drops it), the evidence comment is for the head commit and passed, and the version is bumped with its section (docs-only changes need none); then `gh pr ready` |
| 6 | merge | `main` builds, tests, deploys, smoke-checks over HTTP and tags the version |

`hh dev bump-kit` moves `@huishouden/pwa-kit` and the `huishouden/pwa-kit/.github/workflows/*.yml@vX.Y.Z`
workflow references to the kit's latest exact tag together and runs lint and tests: do it in any
repo you touch. hh itself warns once a day when a newer release exists; `hh self-update` installs it.

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
| `pet today [pet]`, `pet feeding <pet>`, `pet dose <pet> <medicine>` | The feeding board, reminders and courses; logging |
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
output, `text` what people read. Bump the version and CHANGELOG.md in the PR (`hh dev release`);
`main` tags it `v<version>` and creates its GitHub release; no tag ever moves.

## License

[PolyForm Shield 1.0.0](LICENSE).
