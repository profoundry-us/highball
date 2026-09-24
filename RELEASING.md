# Releasing

A release is one commit that ships alone in its own PR: the version bump,
the lockfile, and the changelog's Unreleased section moved under a dated
heading. Nothing else rides with it. Feature PRs land first, each adding its
notes under `## [Unreleased]` in `CHANGELOG.md`; the release comes last, on
top of main, when the maintainer says so.

## The procedure

1. **Decide the version.** Patch for fixes with no new surface, minor for
   anything under `### Added` or a change to what `init` scaffolds. The
   project is pre-1.0, so no release is called major yet.

2. **Cut it** from a clean, up-to-date main:

   ```bash
   npm run release -- 0.9.0
   ```

   The script refuses unless every check passes, and says which one didn't:
   on main, no tracked changes, main equal to `origin/main`, no `v0.9.0` tag
   on origin, `gh` authenticated, and an Unreleased section with something in
   it. Add `--dry-run` to see the changelog section and the PR body it would
   write without touching anything.

   When it runs, it bumps `package.json` and the lockfile, moves Unreleased
   under `## [0.9.0] - <today>` with a fresh empty Unreleased above it,
   repoints the compare links, commits `v0.9.0` on `release/0.9.0`, pushes,
   and opens the PR with the changelog section as its body. It leaves you on
   main with the local branch deleted; the PR is the only copy that matters.

3. **Review and merge the PR.** Squash-merge, as with every PR.

4. **Merging is the release.** `tag-release.yml` runs on the push to main,
   reads the version `package.json` now carries, and if no `v0.9.0` tag
   exists yet, creates one on the merged commit and dispatches
   `publish.yml` with it. That workflow checks out the tag, verifies it
   matches `package.json`, runs the tests, checks the tarball carries its
   runtime assets, publishes to npm with provenance, and creates the GitHub
   release with notes generated from the merged PRs.

   npm's registry can lag the publish by a few minutes before the new
   version shows as `latest`; that is npm, not the workflow. The site's
   version link reads the registry and needs no deploy.

## Why nobody pushes a tag

The tag used to be pushed by hand after the merge, and more than once that
went wrong the same way: the release branch was named after the tag, the
local branch was still there, and `git push origin v0.8.0` was refused as
ambiguous. Now the
tag is created by CI on the exact commit main has, and the release branch is
named `release/…`, so the collision can't happen. `publish.yml` still
accepts a pushed `v*` tag, so an emergency hand-tag still works, but push it
as `refs/tags/v0.9.0` if you ever must.

## If something fails

- **The script refused.** Fix what it named and run it again. It writes
  nothing until every check passes.
- **CI failed on the release PR.** Fix on a separate PR, merge that, then
  rebase or re-cut the release. Don't add fixes to the release commit.
- **`publish.yml` failed after the tag exists.** Re-run it by hand:
  `gh workflow run publish.yml -f tag=v0.9.0`. Publishing an already
  published version is skipped, and so is creating a release that exists,
  so a re-run is always safe.
- **The tag exists but is wrong.** Delete it on GitHub only if the version
  was never published; a published version is permanent on npm, so bump
  again instead.
