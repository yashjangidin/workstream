namespace Workstream.Agent;

internal enum AuthorizationStatus { SetupRequired, Connecting, Authorized, Offline, Revoked }

internal static class AuthorizationGate {
    internal const long OfflineLeaseMilliseconds = 15 * 60 * 1000;

    internal static bool CanOperate(AuthorizationStatus status, string deviceId, long lastAuthorizedAt, long now) =>
        !string.IsNullOrWhiteSpace(deviceId) &&
        (status == AuthorizationStatus.Authorized ||
         (status == AuthorizationStatus.Offline && now - lastAuthorizedAt <= OfflineLeaseMilliseconds));
}

internal sealed class DeviceAuthorizationException : Exception {
    internal string Code { get; }
    internal DeviceAuthorizationException(string code, string message) : base(message) => Code = code;
}
