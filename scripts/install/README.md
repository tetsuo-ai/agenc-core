# Standalone installer source

`runtime-installer.cjs` contains the JavaScript program shared by
`install.sh` and `install.ps1`. Edit that file when shared installer
behavior changes. The JavaScript between the generated program markers in the
two platform wrappers must not be edited by hand.

Regenerate both wrappers after changing the canonical program or one of its
embedded launcher modules:

```sh
node scripts/sync-installer-sqlite-lock.mjs --write
```

The default mode and `--check` are read-only. Both exit with a nonzero status
when the canonical program or either wrapper is stale:

```sh
node scripts/sync-installer-sqlite-lock.mjs
node scripts/sync-installer-sqlite-lock.mjs --check
```

Generated files use UTF-8 without a byte-order mark and LF line endings. The
generator leaves the shell and PowerShell bootstrap code outside the marked
program unchanged.

Check both platform parsers before committing installer changes:

```sh
sh -n scripts/install/install.sh
pwsh -NoLogo -NoProfile -Command \
  "\$null = [scriptblock]::Create((Get-Content -Raw scripts/install/install.ps1))"
```

## Windows PATH

`install.ps1` adds the shim folder (`%LOCALAPPDATA%\agenc\bin`, or
`<AGENC_INSTALL_PREFIX>\bin`) to the user `Path` in `HKCU\Environment` when it
is not already an entry. It appends the folder once, keeps the existing value
and its registry type, and never reads or writes the machine `Path`. The
session that ran the installer gets the folder too. Open a new terminal to use
`agenc` elsewhere.

Set `AGENC_NO_MODIFY_PATH=1` to leave `Path` unchanged:

```powershell
$env:AGENC_NO_MODIFY_PATH = "1"; iwr -useb https://get.agenc.ag/install.ps1 | iex
```

Do not use `setx PATH`. It copies the machine `Path` into the user `Path` and
cuts the value at 1024 characters.
