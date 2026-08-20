# Releasing `fleetview-bridge`

Publishing this package puts code on developers' machines that runs as them, and `npx`
re-resolves `latest` on every invocation — so a publish reaches every unpinned user on their next
run, with no install step and no prompt. There is no rollback for code that has already
executed. The gates below are cheap; the blast radius is not.

## One-time setup (a human with npm account access must do these)

1. **Enable 2FA on the npm account**, set to *"Require two-factor authentication for write
   actions"*. `npmjs.com` → account → Two-Factor Authentication.
2. **Create a granular access token** scoped to *only* the `fleetview-bridge` package, with
   read-and-write permission and an expiry. Not a classic automation token, and not a token that
   can publish everything the account owns.
3. **Store it as the repository secret `NPM_TOKEN`** (GitHub → Settings → Secrets and variables →
   Actions). The token belongs in CI, not in a shell profile on a laptop.
4. Consider adding a second npm maintainer, so the account is not a single point of both failure
   and compromise.

## Every release

```bash
git checkout main && git pull
# bump "version" in package.json, commit it
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --follow-tags
```

Pushing the tag is the entire release. `.github/workflows/release.yml` then refuses to publish
unless the tag matches `package.json`, the tagged commit is an ancestor of `origin/main`, and
`npm test` passes — and publishes with `--provenance`, which cryptographically binds the tarball
to this repository, this commit and this workflow.

**Do not `npm publish` from a working tree.** That is how `0.1.1` came to exist with a registry
`gitHead` naming a commit that was never pushed: nobody could verify from outside that the
published code matched the repository. It happened to match — that was checked afterwards by
downloading the tarball and diffing it — but "we can audit it by hand later" is not a control.

## After a release that fixes a vulnerability

```bash
npm deprecate 'fleetview-bridge@<0.2.0' \
  'Contains a remote-code-execution chain. Upgrade: npm i -g fleetview-bridge@latest'
```

`npx` users are already covered by re-resolution. Deprecation is the only channel that reaches
someone with a global install or a pin, so it is part of the release, not a follow-up.

## If a bad version ships

```bash
npm dist-tag add fleetview-bridge@<last-good> latest   # seconds; redirects new npx resolutions
```

Do that first. `npm unpublish` is only available within 72 hours and burns the version number
either way. Neither undoes code that has already run on someone's machine — if a bad publish was
executed anywhere, treat the credentials in that environment as exposed.
