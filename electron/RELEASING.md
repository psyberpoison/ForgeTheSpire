# Cutting a real Forge release

This is what actually makes the in-app "an update is available" banner
(`#app-update-banner` in `frontend/index.html`, wired up via
`electron-updater` in `electron/main.js`) mean anything: `electron-updater`
checks the GitHub repo's own Releases for a build with a newer
`electron/package.json` version than the one currently running, and if one
exists, downloads it and lets the app install it on request. No release
published yet = no updates ever offered, same as before this round — this
is purely additive, nothing about how Forge runs today changes until the
first real release exists.

## One-time setup (do this once, before the very first release)

1. **Create the GitHub repo.** Public, so `electron-updater` can check it
   with no token baked into the shipped app at all (a private repo needs a
   token distributed with every install just to *check* for updates, which
   is a meaningfully bigger amount of moving parts for very little benefit
   here). Anthropic/Claude sessions can't create GitHub accounts or repos
   on your behalf — this step is yours.
2. **Fill in `electron/package.json`'s `build.publish` block** — replace
   `REPLACE_WITH_GITHUB_USERNAME` and `REPLACE_WITH_REPO_NAME` with your
   real GitHub username and the repo name you just created.
3. **Push this project to that repo** (from `sts2-builder/`, the folder
   this file's parent directory sits in — a `git init` + `.gitignore` was
   already set up this round):
   ```
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
4. **Get a GitHub Personal Access Token** (Settings → Developer settings →
   Personal access tokens → generate one with `repo` scope — that's the
   only permission `electron-builder`'s publish step needs). **Never paste
   this token into a chat with Claude, and never commit it to the repo** —
   it's a credential, and Claude sessions are instructed to refuse to
   handle credentials on your behalf. It only ever needs to live in your
   own local shell environment (or your OS's credential manager), for the
   one command below.

## Every time you want to cut a release

1. **Bump the version** in `electron/package.json` (the top-level
   `"version"` field — currently `1.0.0`, the first release this
   update-checking machinery ships with). Follow normal semver: a patch
   for a small fix, a minor for a new feature, a major for something that
   changes how Forge is used. This is the exact number `electron-updater`
   compares against what's already installed on a user's machine, so it
   must go up every release or updates silently stop being offered.
2. **Commit and tag** (electron-builder's GitHub publish target expects a
   tag matching the version, prefixed with `v`):
   ```
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```
3. **Build and publish**, from `electron/`, with your token set for just
   this one command (never saved to a file, never in shell history if your
   shell is configured to ignore space-prefixed commands — check
   `HISTCONTROL`/`HISTIGNORE` if that matters to you):
   ```
   cd electron
   npm install          # only needed the first time, or after a dependency change
    GH_TOKEN=<your token, pasted directly into this one command> npm run release
   ```
   (the leading space before `GH_TOKEN=` above is deliberate on most
   shells with history-ignoring configured — harmless either way.)

   This runs `electron-builder --publish always`, which builds the actual
   installer (`.exe`/NSIS on Windows, per the existing `build.win` config)
   for your current OS and uploads it as a GitHub Release matching the
   tag, along with the small metadata files (`latest.yml` and similar)
   `electron-updater` actually reads to know a new version exists.
4. **Verify**: open the repo's Releases page on GitHub, confirm the new
   release and its installer are there. The NEXT time anyone's already-
   installed copy of Forge launches, it checks that Releases page in the
   background (silently — see `main.js`'s own comment on why failures
   there are never surfaced as errors) and shows the in-app banner once it
   finds a newer version.

## What this does NOT do

- **It doesn't build for every OS from one machine.** electron-builder
  only builds for the OS it's running on by default (cross-compiling a
  Windows installer from a Mac, or vice versa, needs extra setup this
  project doesn't have yet) — not a concern today since Forge is only
  built/tested on Windows, but worth knowing if that changes.
- **It doesn't run any tests or CI.** There's no GitHub Actions workflow
  here — this whole process is a manual, local `npm run release`. Fine for
  a solo project; worth automating later if that ever becomes annoying.
- **It doesn't touch the game-update banner** (`#game-version-banner`) —
  that's a completely separate mechanism (comparing the installed STS2
  build against `backend/verifiedGameVersion.json`) that has nothing to do
  with releasing a new Forge version. See that file's own header comment.
