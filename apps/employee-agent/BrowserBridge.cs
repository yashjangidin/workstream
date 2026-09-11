using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace Workstream.Agent;
internal sealed class BrowserBridge {
    private readonly int port;
    private WebApplication? server; private volatile string domain=""; private long observedAt;
    public volatile bool Enabled;
    public string CurrentDomain=>Enabled&&DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-Interlocked.Read(ref observedAt)<45000?domain:"";
    public BrowserBridge(int port=43173){
        if(port is < 1024 or > 65535)throw new ArgumentOutOfRangeException(nameof(port));
        this.port=port;
    }
    public async Task Start(string secret){
        var builder=WebApplication.CreateSlimBuilder();builder.Logging.ClearProviders();builder.WebHost.UseUrls("http://127.0.0.1:"+port);builder.WebHost.ConfigureKestrel(options=>options.Limits.MaxRequestBodySize=2048);
        server=builder.Build();
        server.Use(async(context,next)=>{
            var origin=context.Request.Headers.Origin.ToString();
            if(!Regex.IsMatch(origin,"^chrome-extension://[a-p]{32}$")){context.Response.StatusCode=403;return;}
            context.Response.Headers.AccessControlAllowOrigin=origin;context.Response.Headers.Vary="Origin";
            if(context.Request.Method=="OPTIONS"){context.Response.Headers.AccessControlAllowHeaders="Content-Type,X-Workstream-Pairing";context.Response.Headers.AccessControlAllowMethods="GET,POST";context.Response.StatusCode=204;return;}
            var candidate=context.Request.Headers["X-Workstream-Pairing"].ToString();
            if(!CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(candidate)),SHA256.HashData(Encoding.UTF8.GetBytes(secret)))){context.Response.StatusCode=401;return;}
            await next(context);
        });
        server.MapGet("/v1/status",()=>Results.Json(new{enabled=Enabled}));
        server.MapPost("/v1/browser-activity",async(HttpContext context)=>{
            if(!Enabled)return Results.NoContent();
            var value=await JsonSerializer.DeserializeAsync<Dictionary<string,JsonElement>>(context.Request.Body);
            if(value==null||!value.TryGetValue("domain",out var host)||host.ValueKind!=JsonValueKind.String)return Results.BadRequest();
            var candidate=host.GetString()!.ToLowerInvariant();
            if(candidate.Length>253||(candidate!=""&&Uri.CheckHostName(candidate)!=UriHostNameType.Dns))return Results.BadRequest();
            domain=candidate;Interlocked.Exchange(ref observedAt,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());return Results.NoContent();
        });
        await server.StartAsync();
    }
    public async Task Stop(){Enabled=false;if(server!=null){await server.StopAsync();await server.DisposeAsync();}}
}
