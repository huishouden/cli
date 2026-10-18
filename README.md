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
| 3 | `hh dev evidence` | The same, or on the app's staging site when the change touches rules, Workers, sign-in, Google or notifications (`--staging`/`--local` override): build against `huishouden-staging`, deploy the suite with this build to the app's staging site with your own `firebase` login, smoke and signed-in tests there (`pwa-staging run`), screenshots. In a Worker repo (a `wrangler.toml`), staging is the Worker's own: its checks and tests here, the branch deployed to its `[env.staging]` (`bun run deploy:staging`, else `wrangler deploy --env staging`, with your wrangler login; the env must name `huishouden-staging`), an HTTP check of `STAGING_WORKER_URL` (a repo variable that must name a staging Worker) and the repo's `e2e:staging` against it when it has one. It refuses before running anything when `[env.staging]` is missing or its vars name no project or another project than `huishouden-staging`. Posts or updates one PR comment with the results and the images (GitHub's user-attachments). Never production. `verify` and `evidence` first refuse to run when an env file (`.env`, `.env.local`, `.env.*.local`) or the process environment sets a production Firebase value, and build and test with every `VITE_` value passed explicitly so a `.env.local` decides nothing |
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

Commits hh makes itself carry the trailers you give it, so they match your own (a
`Claude-Session:` line, a `Co-authored-by:`): every `hh.commitTrailer` git config value, then each
line of `HH_COMMIT_TRAILERS`, repeats dropped. Each must be `Key: value`; a malformed one stops the
bump rather than commit without it.

```sh
git config --global --add hh.commitTrailer 'Co-authored-by: Sam <sam@example.com>'
HH_COMMIT_TRAILERS='Claude-Session: https://claude.ai/code/session_…' hh dev evidence
```

`hh dev ready` accepts a review or evidence of an earlier commit (an ancestor) when the diff since
it touches only the kit: `package.json` changed only in its `@huishouden/pwa-kit` pin (to
huishouden/pwa-kit's release at an equal or later exact tag), `.github/workflows/*.y(a)ml` changed
only in their `huishouden/pwa-kit/{.github/workflows,actions}/…` refs (exact tags, or `@<sha> # vX.Y.Z` commit pins whose commit is that tag's; none going back),
and `bun.lock` changed only on the kit's own two lines, resolving to that same release (its tarball URL, or the commit its tag points to). Any other file or change refuses, and review
and evidence are redone. An earlier review is used only when nothing reviewed the head itself (a
failing review of the head is never replaced), and evidence comments count only from the PR author
or the reviewer.

`hh dev bump-kit` moves `@huishouden/pwa-kit` (to the latest release's tarball URL when the release
has one, else its git tag) to the latest exact tag and pins the `huishouden/pwa-kit/…` workflow and
action references to that tag's commit, `uses: huishouden/pwa-kit/<path>@<40-hex sha> # vX.Y.Z`
(tags are movable; the commit is not). The sha is the tag's peeled commit from `git ls-remote`. A
commit pin whose comment already names the target is current, a pin ahead of the latest release is
kept, and a pin is never turned back into a tag. Then it runs lint and tests.

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
| `groceries list [list]`, `groceries add <name> [--need-by YYYY-MM-DD]`, `groceries check <item>`, `groceries update <item> [--need-by YYYY-MM-DD|none]` | Shopping lists; `--need-by` is the day an item is needed by |
| `tasks add <name>` | A task, with `--due` |
| `bills due` | Open bills (admins and members) |
| `pet today [pet]`, `pet feeding <pet>`, `pet dose <pet> <medicine>`, `pet outing <pet> --pooped`, `pet routines [pet]`, `pet routine-done <routine>` | The feeding board, reminders, courses, outings (bathroom breaks, walks) and care routines (`pet routines` lists them, `pet routine-done` marks one done); logging |
| `home upkeep`, `home event <title>` | Upkeep due; a regular event or a visit |
| `baby settings`, `baby contraction-note <note>`, `baby kicks [--target 10] [--remind-at 19:00\|off]` | Baby's settings: the instructions from the provider on the contraction timer (`""` clears them) and the kick counter's target and daily reminder. Admins, members and helpers read them; only admins and members change them; kids get neither |
| `appointment add <app> <title> <start>` | An appointment for a pet, the baby, a car or a person |
| `contacts search <query>`, `contacts add <name>` | The household's contacts |
| `health people`, `health medicines <person>`, `health history <person>`, `health due [person]` | Health, for the people you care for |
| `health appointments [person]`, `health dose <person> <medicine>`, `health add <person> <name>`, `health update <person> <medicine>`, `health doctor-list <person>` | Visits; logging doses (with Health's guards: `--confirm` after a warning), medicines, the doctor's list |
| `health conditions [person] [--specialty neurology]`, `health condition add <person> <name> [--icd10 M54.12]` | Conditions by medical area (admins and member carers only); adding one, filed under its code's area unless `--specialty` says otherwise |

Every other argument is a flag named after the tool's (`--dose-time 08:00`, `--no-reminders`,
`--times 08:00,20:00`); `hh data <command> --help` lists them. `--household <id or name>` picks a
household when you have several. `--staging` uses your staging sign-in.

## Operations

| Command | Does |
|---|---|
| `hh ops auth-domains [--production\|--staging]` | Firebase Auth's authorized domains against the expected set (pwa-kit docs/one-site.md "Sign-in origins"), with your gcloud login. Fix with the kit bootstrap |
| `hh ops oauth-check [--production\|--staging]` | The OAuth web client's JavaScript origins and the auth handler redirect URI, probed with the kit's checks. Missing entries are added in the console (Google has no API) |
| `hh ops secret set <repo> <name> [--env <environment>]` | A GitHub Actions secret on huishouden/`<repo>`, the value from stdin only (a pipe, or typed with echo off); never from argv, never printed. Wraps `gh secret set` |
| `hh ops secret store <name>` | The copied secret (clipboard) validated per name (cloudflare: `cfut_`, 40+ characters, accepted by Cloudflare's token verify API; newrelic-user: `NRAK-`, accepted by a read-only NerdGraph query; alert-email: one email address, service `huishouden-alert-email`, pushed to the portal repo as ALERT_EMAIL; others non-empty), saved to the OS keychain (service `huishouden-<name>`; cloudflare is `huishouden-cloudflare-api-token`, newrelic-user `huishouden-newrelic-user-api-key`; account `huishouden`), clipboard cleared and read back empty, then the name's local consumers configured (see `sync-local`). Never printed |
| `hh ops secret push <name> [--repos a,b] [--env production] [--soft] [--expected]` | Keychain to GitHub secrets (`gh secret set`, value on stdin), plus companions (cloudflare: `CLOUDFLARE_ACCOUNT_ID` from `HH_CLOUDFLARE_ACCOUNT_ID`, `~/.config/hh/config.json` `cloudflareAccountId`, or the token's only account). No `--repos`: the name's defaults (cloudflare: environment `production`, main only, of portal, connector, notify, calendar). Missing environments are created |
| `hh ops secret where [--strict]` | Every repo-level and environment secret in the org (names and updatedAt only): `ok`, `UNEXPECTED` (a registered name somewhere it does not belong) or `UNREGISTERED` (a name the registry in `src/lib/secrets.ts` does not know), and whether the keychain holds its copy: `keychain`, `derived` (a companion such as `CLOUDFLARE_ACCOUNT_ID`, worked out at push time), `NO KEYCHAIN COPY` (always for an unregistered name) or `KEYCHAIN UNKNOWN`. The keychain check is existence only (`security find-generic-password` without `-w`, or `secret-tool lookup`, output discarded). Registered places with no secret are `MISSING`. Exits non-zero for unexpected or missing placements; `--strict` also for any keychain gap |
| `hh ops secret sync-local <name>` | Hands the keychain value to the programs on this machine that use it (the registry's local consumers), then reads back their status. newrelic-user: nrq. nrq 1.0.36+ gets it on stdin (`nrq set-credential --key api_key --stdin --overwrite`, with `--ref newrelic-cli/default` when nrq has no config yet); older nrq on macOS gets its own Keychain item (service `newrelic-cli`, account `api_key`) written through `security -i`, because that nrq would pass the key to `security` in argv; older nrq on Linux reads it from stdin (`nrq config set-api-key`). An unset nrq account id becomes 8578044. No nrq installed: skipped |
| `hh ops secret rotate <name> [--yes]` | Guided. Says where to create the new value (newrelic-user: one.newrelic.com, API keys, account 8578044, Key type User), waits for Enter (`--yes` or no terminal: goes straight on), then store (the clipboard is emptied as soon as the value is stored, and on any failure once it has been read), push to every default target, configure the local consumers, and verify: each target updated, each local program reports a key, and the provider accepts the stored value (newrelic-user: `{ actor { user { email } } }` on NerdGraph; the answer is not printed) |
| `hh ops monitoring [--dry-run]` | Runs the portal's monitoring workflow (New Relic) and summarizes each step and what provisioning said |
| `hh ops roles`, `hh ops roles set <email> <role>` | The household's people and roles; setting one as the signed-in admin, through the rules |
| `hh ops profile-check [--fix]` | The org profile (huishouden/.github `profile/README.md`) and every app's and Worker's repo description against `apps.json` and the repos with a `wrangler.toml`. `--fix` fills empty descriptions from `apps.json` and opens a PR adding missing rows |
| `hh ops deploy-site [--no-watch]` | Dispatches the portal's `ci` with `reconcile: true` and watches it: the portal's deploy is the only one that uploads to the asset CDN, so run this after an app's PR is merged and its deploy has finished. A no-op when the site is current |
| `hh ops read-alerts [--print] [--project=…] [--hourly=5000] [--daily=30000]` | The Cloud Monitoring alert policies on Firestore's billed reads (pwa-kit STANDARD.md "Read budgets"): over 5,000 in an hour and over 30,000 in 24 hours, emailed on the "Huishouden budget alerts" channel. Runs the kit's `infra/read-alert.sh` from its latest release with your gcloud login; writes only a policy that differs from the live one, and reports each policy as `created`, `updated` or `unchanged` (all unchanged and nothing unrecognised: "unchanged", nothing written; a script line hh doesn't recognise is shown instead, since it may be a write; `--json` has the list). `--print` shows the policies without reading or changing anything |
| `hh ops staging-cleanup` | Removes staging test households and people over a day old (the kit's `pwa-staging sweep`), with a token from your gcloud login impersonating the staging deploy account (needs Service Account Token Creator on it). `hh dev evidence --staging` runs it after its tests; nothing sweeps staging on a schedule |
| `hh ops repo-recreate <repo> --archive-name <name> [--apply] [--watch] [--from-step <n> [--backup <dir>]]` | Recreates a public repo with only main and its tags, so its old pull request refs stop serving commits; the old repo becomes a private archive. Dry run unless `--apply`; see below |

### Recreating a public repository: `hh ops repo-recreate`

GitHub keeps every pull request's head as `refs/pull/<n>/head` on the repository forever, and
nobody can delete those refs. A public repository whose license changed therefore keeps serving the
old-license commits through its closed pull requests. `hh ops repo-recreate` removes them from the
public name. It renames the repository to `--archive-name`, makes the archive private, and creates
a new public repository at the original name with only `main` and its tags.

```sh
hh ops repo-recreate kit --archive-name kit-archive-2026           # dry run: preflight, backup, plan; nothing on GitHub changes
hh ops repo-recreate kit --archive-name kit-archive-2026 --apply --watch
```

**Preflight.** It only reads, and it finishes before any change. Any failure stops the run with
nothing changed. It checks the following:

- The repository exists under that name (not through a redirect), is public, is yours to
  administer, has `main` as its default branch and has no open pull requests.
- `--archive-name` answers 404. A redirect left by an earlier rename answers 200, and that also
  stops the run.
- No commit of `main` has MIT text in `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENCE`,
  `COPYING` or `package.json`. The search is case-sensitive: `MIT License`,
  `Permission is hereby granted, free of charge`, or `"license": "MIT"`.
- Every tag is an ancestor of `main`.
- Every secret on the repository and its environments is one `hh ops secret push` can push from
  the keychain: a registered name or a companion. The keychain must also hold an entry for it,
  checked by exit status only; the value is never read.

It saves a backup to `~/.hh/repo-recreate/<repo>-<time>/` (mode 0700):

- `mirror.git`, a `git clone --mirror` of the repository.
- `inventory.json`, which records:
  - settings, topics and merge options;
  - Actions permissions and workflow permissions;
  - `security_and_analysis`;
  - environments, with their branch policies, reviewers and wait timer;
  - secret names (never values) and variables with their values;
  - releases and which one is latest;
  - branch protection, rulesets, webhooks, collaborators and teams.
- `assets/`, the files attached to each release.

**Apply.** Each step reads its result back. The run stops at the first failure and prints the
changes made and the commands that undo them, newest first.

1. Rename the repository to the archive name. The archive must answer with the old id, the old
   name must no longer resolve to its own repository, and the archive's `main` must match the
   backup.
2. Make the archive private.
3. Create the new public repository with the recorded settings and topics, and check that it has
   a new id. From here on, each step first checks that the name answers with that new id. Until
   the new repository exists, GitHub redirects the old name to the archive.
4. Recreate environments with their branch policies, wait timer and reviewers. Then recreate the
   variables. Then push the secrets with `hh ops secret push`: the value comes from the keychain
   and goes to `gh secret set` on stdin, and the existing environment is used as it is. Each place
   is checked by secret name.
5. Set Actions permissions, workflow permissions, secret scanning and push protection.
6. Push the tags, then `main`. The tags go first so that CI's tag step finds `HEAD` already
   tagged. The new repository's refs must then match the backup: `main` and the tags, nothing
   else.
7. Recreate the releases, oldest first, with their names, bodies and assets, and mark the same one
   as latest. If CI has already released a tag, that release is updated to match the recorded one.
   Assets upload one at a time, each checked by name and size before the next, so the names on
   GitHub are the recorded ones byte for byte.
8. Report the CI runs started by the `main` push. With `--watch`, wait for them to finish. A
   failed run is fixed forward; nothing is undone.

**Lagging lists.** GitHub's lists are eventually consistent: a release list read right after the
releases were created can miss one. Every read-back that lists what a step just wrote (releases,
release assets, refs, environments, variables, secret names, topics) is repeated after 2, 4, 8
and 16 seconds, about 30 seconds in all, before a difference is reported. The failure names what
is missing or differs.

**Resuming.** Each step saves `state.json` in the run's backup directory: the archive id, the new
repository's id and the steps done. `--from-step <n>` (2 to 8) continues from step `n` without
undoing, for example `--from-step 7` after a step 7 failure. It runs no preflight (the name now
belongs to the new repository), uses the newest `<repo>-*` run directory unless `--backup <dir>`
names one, and refuses when `state.json` is missing, names another repository or archive, or
does not record steps 1 to `n-1` as done. It verifies that the archive name answers with the
recorded old id and, whenever a new repository is recorded (from step 3 if its create already happened, always from step 4), the repository name with the recorded new id. A resumed step 3 finishes that repository instead of creating it again; a resumed step 4 updates what exists. Without `--apply`
it only verifies and prints what would run.

The undo commands use `gh api`. A repository is never deleted by name alone: the undo first checks
that the name answers with the new repository's id.

Every `gh api` call counts as failed if the exit code is not zero, if gh prints anything on stderr,
if its output contains an `HTTP 4xx` or `5xx` status, or if the body is an error
(`message` with `documentation_url`). This applies even when the exit code is 0. Request bodies go
on stdin, never in the arguments.

**What is kept and what is lost.**

| | |
|---|---|
| On the new public repository | `main`'s history; tags; releases and their assets; the latest release; description, homepage and topics; merge settings; environments with branch policies, reviewers and wait timer; variables; secrets (pushed again from the keychain); Actions and workflow permissions; secret scanning and push protection |
| Only in the private archive | Pull requests with their refs and review threads; issues; branches other than `main`; anything else the old repository held |
| Lost | Stars, watchers and links from forks, which belong to the archive and are hidden while it is private; the old repository's id |
| Recorded but not recreated (reapply by hand from `inventory.json`, `notRecreated`) | Branch protection; rulesets; webhooks (GitHub never returns their secrets); direct collaborators and teams |

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
