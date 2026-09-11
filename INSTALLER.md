# Installer

The Inno Setup source is `installer/WorkstreamSetup.iss`. Build the current installer with:

```powershell
npm run build:installer
```

The command publishes the Windows agent and compiles the real installer with Inno Setup. The single source-of-truth artifact is `artifacts/installer/WorkstreamSetup.exe`. The API serves it at `/downloads/WorkstreamSetup.exe` with download headers and no-store caching. Set `WORKSTREAM_INSTALLER_PATH` when the artifact is stored elsewhere, and set `AGENT_DOWNLOAD_URL` to the deployed public URL in production. The installer uses a predictable per-user installation directory, creates a startup entry, supports upgrades through a stable AppId, and removes only Workstream-owned files on uninstall.

Inno Setup 6 must be installed on the machine that builds the installer. The API deliberately returns `WorkstreamSetup.exe is currently unavailable.` until this real artifact exists; it never fabricates an executable.
