Release ComfyUI-Drawer to GitHub and Comfy Registry.

This command must be run from within the ComfyUI-Drawer repository root.

## Usage
`/release` — auto-increments patch version (2.1.5 → 2.1.6)
`/release 2.2.0` — uses the specified version

## Steps

**1. Determine repo root**

Run `git rev-parse --show-toplevel` to get the absolute path of the repo root.
Use that path for all subsequent file edits and git commands.

**2. Determine version**

If `$ARGUMENTS` is provided, use it as the new version.
Otherwise, read the current version from `pyproject.toml` and increment the patch number by 1.

**3. Check preconditions**

Run `git status --short` and abort with a clear message if there are any uncommitted changes.

**4. Ask for changelog entries**

Ask the user: "v{version} のリリースノートを入力してください（箇条書き）:"
Wait for their input. Each line becomes a `- ` bullet in the changelog.

**5. Update files**

Edit these three files under the repo root:

- `CHANGELOG.md` — insert a new section at the top (after `# Changelog`):
  ```
  ## v{version} - {today's date YYYY-MM-DD}

  - {bullet 1}
  - {bullet 2}
  ...

  ```
- `pyproject.toml` — update `version = "{old}"` → `version = "{version}"`
- `web/js/version.js` — update `DRAWER_VERSION = '{old}'` → `DRAWER_VERSION = '{version}'`

**6. Commit**

```
git add CHANGELOG.md pyproject.toml web/js/version.js
git commit -m "Prepare v{version} release"
```

**7. Push**

```
git push origin master
```

**8. Create GitHub release**

Read the GitHub remote URL from `git remote get-url origin` to determine the repo (e.g. `Kuroi961/ComfyUI-Drawer`).

```
gh release create v{version} --repo {owner}/{repo} --title "v{version}" --notes "{changelog bullets}"
```

**9. Trigger Comfy Registry publish**

```
gh workflow run "Publish to Comfy Registry" --repo {owner}/{repo} --ref master
```

Then wait for it to complete:
```
gh run watch --repo {owner}/{repo} --exit-status $(gh run list --repo {owner}/{repo} --workflow "Publish to Comfy Registry" --limit 1 --json databaseId --jq '.[0].databaseId')
```

**10. Report**

Print a summary table showing each step and its result, and the GitHub release URL.
