# Releasing

A release is a pushed version tag. The `release` workflow checks the code, builds the Windows
installer, smoke-tests the packaged app, and publishes `AgentOps-Setup.exe`, its block map and
`latest.yml` to the GitHub Release for the tag. Installed apps find the new version in
`latest.yml` within four hours and update themselves.

1. Set the version everywhere it is written down:

   ```sh
   node scripts/set-version.mjs 0.2.0-beta.2
   ```

2. Fold the changelog fragments into `CHANGELOG.md`:

   ```sh
   node scripts/fold-changelog.mjs 0.2.0-beta.2
   ```

3. Add a `## v0.2.0-beta.2 (YYYY-MM-DD)` entry to `UPDATES.md`, written for people who use the
   app. The workflow refuses a tag without one: the updater shows it as "what's new".

4. Check locally:

   ```sh
   node scripts/check-release.mjs 0.2.0-beta.2   # version, CHANGELOG heading, no fragments left, UPDATES entry
   npm run typecheck && npm run lint && npm test && npm run leaks
   npm run dist                                # builds the installer
   node scripts/desktop-smoke.mjs --packaged   # the packaged app renders every view
   ```

5. Commit, tag and push:

   ```sh
   git commit -am "Release 0.2.0-beta.2"
   git tag v0.2.0-beta.2
   git push origin main v0.2.0-beta.2
   ```

The workflow runs `scripts/check-release.mjs` on the tag first and stops when the tag does not
match `package.json`, `CHANGELOG.md` has no heading for the version, `changelog.d/` still holds
fragments, or `UPDATES.md` has no entry. A fragment that lands after the fold goes in with
`node scripts/fold-changelog.mjs <version>` again: it joins the version's existing sections.

## Versions

Versions follow [semver](https://semver.org). A pre-release (`-beta.N`) updates to the next
pre-release or to the release it leads to. Installed apps never move to an older version.

## Signing

The installer is unsigned until a code signing certificate is set up. With one, add the
`CSC_LINK` (the certificate, base64 or a URL) and `CSC_KEY_PASSWORD` secrets to the repository,
and set `verifyUpdateCodeSignature: true` in `packages/desktop/electron-builder.yml`.
