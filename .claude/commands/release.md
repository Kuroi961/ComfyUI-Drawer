Release ComfyUI-Drawer to GitHub and Comfy Registry.

## Usage
`/release` — auto-increments patch version (2.1.5 → 2.1.6)
`/release 2.2.0` — uses the specified version

## Steps

**1. Determine version**

If `$ARGUMENTS` is provided, use it as the new version.
Otherwise, read the current version from `pyproject.toml` and increment the patch number by 1.

**2. Check preconditions**

Run `git -C "c:\AI\dev\ComfyUI\custom_nodes\ComfyUI-Drawer" status --short` and abort with a clear message if there are any uncommitted changes.

**3. Ask for changelog entries**

Ask the user: "v{version} のリリースノートを入力してください（箇条書き）:"
Wait for their input. Each line becomes a `- ` bullet in the changelog.

**4. Update files**

Edit these three files:

- `CHANGELOG.md` — insert a new section at the top (after `# Changelog`):
  ```
  ## v{version} - {today's date YYYY-MM-DD}

  - {bullet 1}
  - {bullet 2}
  ...

  ```
- `pyproject.toml` — update `version = "{old}"` → `version = "{version}"`
- `web/js/version.js` — update `DRAWER_VERSION = '{old}'` → `DRAWER_VERSION = '{version}'`

**5. Commit**

```
git -C "c:\AI\dev\ComfyUI\custom_nodes\ComfyUI-Drawer" add CHANGELOG.md pyproject.toml web/js/version.js
git -C "c:\AI\dev\ComfyUI\custom_nodes\ComfyUI-Drawer" commit -m "Prepare v{version} release"
```

**6. Push**

```
git -C "c:\AI\dev\ComfyUI\custom_nodes\ComfyUI-Drawer" push origin master
```

**7. Create GitHub release**

```
gh release create v{version} --repo Kuroi961/ComfyUI-Drawer --title "v{version}" --notes "{changelog bullets}"
```

**8. Trigger Comfy Registry publish**

```
gh workflow run "Publish to Comfy Registry" --repo Kuroi961/ComfyUI-Drawer --ref master
```

Then wait for the workflow to complete:
```
gh run watch --repo Kuroi961/ComfyUI-Drawer --exit-status $(gh run list --repo Kuroi961/ComfyUI-Drawer --workflow "Publish to Comfy Registry" --limit 1 --json databaseId --jq '.[0].databaseId')
```

**9. Report**

Print a summary table showing each step and its result, and the GitHub release URL.
