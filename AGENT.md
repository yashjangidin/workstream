# Windows agent

The agent is a .NET 8 Windows desktop application. It starts at user logon, but remains normally terminable. It holds an encrypted device credential, a local durable outbox, and a small timer window. The agent sends heartbeats, session operations, idle boundaries, and monitoring payloads to the API using idempotency keys.

Build with `dotnet publish apps/employee-agent/Workstream.Agent.csproj -c Release -r win-x64 --self-contained true`. A real Windows machine must be used to validate screenshot capture, idle detection, startup registration, installation, and recovery.
