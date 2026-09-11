using Workstream.Agent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var path=Path.Combine(Path.GetTempPath(),"workstream-verification-"+Guid.NewGuid().ToString("N"));
void Check(bool value,string message){if(!value)throw new Exception(message);Console.WriteLine("PASS: "+message);}
try{
    var credential=Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    using(var store=new Store(path)){
        var state=new State(){Credential=credential,SessionId="recovery-session",StartedAt=1000};
        store.Atomic(()=>{store.Save(state);store.Add("/v1/device/sessions/start",new{sessionId=state.SessionId,at=1000});});
        store.Add("/v1/device/screenshots",new{sessionId="recovery-session"});
        store.Add("/v1/device/sessions/stop",new{sessionId="recovery-session",at=2000});
    }
    using(var reopened=new Store(path)){
        Check(reopened.Load().SessionId=="recovery-session","session survives SQLite connection restart");
        Check(reopened.Load().Credential==credential,"DPAPI decrypts the persisted device credential");
        var item=reopened.First()!.Value;Check(item.Path.EndsWith("/start"),"start syncs before later events");reopened.Complete(item.Id,null);
        item=reopened.First()!.Value;Check(item.Path.EndsWith("/stop"),"timer stop bypasses pending screenshots");reopened.Complete(item.Id,null);
        item=reopened.First()!.Value;reopened.Quarantine(item.Id,"test rejection");Check(reopened.First()==null,"rejected monitoring event cannot block the outbox");
        try{reopened.Atomic(()=>{reopened.Save(new State(){SessionId="must-rollback"});reopened.Add("/test",new{});throw new InvalidOperationException();});}catch(InvalidOperationException){}
        Check(reopened.Load().SessionId=="recovery-session"&&reopened.First()==null,"state and outbox roll back atomically on a failure");
        reopened.Add("/v1/device/screenshots",new{sessionId="old-screenshot-session"});
        reopened.DiscardScreenshotUploads();
        Check(reopened.First()==null,"disabled screenshot uploads discard old queued screenshot work");
        reopened.Add("/v1/device/screenshots",new{sessionId="old-employee-session"});
        var oldCapture=Path.Combine(path,"old-employee.capture");File.WriteAllText(oldCapture,"old employee monitoring data");
        reopened.ResetAuthorization(new State(){ApiUrl="http://127.0.0.1:8080",InstallationId="same-computer"});
        var cleared=reopened.Load();
        Check(cleared.DeviceId==""&&cleared.Credential==""&&cleared.EmployeeName==""&&cleared.SessionId==null,"revocation clears cached identity, credential, and timer state");
        Check(reopened.First()==null,"revocation removes old employee outbox data before re-enrollment");
        Check(!File.Exists(oldCapture),"revocation removes pending old employee screenshot files");
    }
    Check(!AuthorizationGate.CanOperate(AuthorizationStatus.SetupRequired,"device",1000,1000),"setup-required state cannot operate");
    Check(AuthorizationGate.CanOperate(AuthorizationStatus.Authorized,"device",1000,1000),"authorized state can operate");
    Check(AuthorizationGate.CanOperate(AuthorizationStatus.Offline,"device",1000,1000+AuthorizationGate.OfflineLeaseMilliseconds),"recent offline authorization lease can operate");
    Check(!AuthorizationGate.CanOperate(AuthorizationStatus.Offline,"device",1000,1001+AuthorizationGate.OfflineLeaseMilliseconds),"expired offline authorization lease cannot operate");
    Check(!AuthorizationGate.CanOperate(AuthorizationStatus.Revoked,"device",1000,1000),"revoked state cannot operate");
    const int bridgePort=43174;
    var bridge=new BrowserBridge(bridgePort);
    try{
        await bridge.Start(credential);using var http=new HttpClient(){BaseAddress=new Uri("http://127.0.0.1:"+bridgePort)};
        var response=await http.GetAsync("/v1/status");Check(response.StatusCode==HttpStatusCode.Forbidden,"ordinary web origins cannot access the browser bridge");
        http.DefaultRequestHeaders.Add("Origin","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        response=await http.GetAsync("/v1/status");Check(response.StatusCode==HttpStatusCode.Unauthorized,"extension requires its explicit pairing key");
        http.DefaultRequestHeaders.Add("X-Workstream-Pairing",credential);
        var state=JsonDocument.Parse(await http.GetStringAsync("/v1/status"));Check(!state.RootElement.GetProperty("enabled").GetBoolean(),"domain collection starts disabled");
        await http.PostAsync("/v1/browser-activity",new StringContent("{\"domain\":\"example.com\"}",Encoding.UTF8,"application/json"));Check(bridge.CurrentDomain=="","disabled monitoring does not retain domain observations");
        bridge.Enabled=true;
        await http.PostAsync("/v1/browser-activity",new StringContent("{\"domain\":\"example.com\"}",Encoding.UTF8,"application/json"));Check(bridge.CurrentDomain=="example.com","authenticated active monitoring accepts a domain");
        response=await http.PostAsync("/v1/browser-activity",new StringContent("{\"domain\":\"https://example.com/private\"}",Encoding.UTF8,"application/json"));Check(response.StatusCode==HttpStatusCode.BadRequest,"bridge rejects full URLs and paths");
        bridge.Enabled=false;Check(bridge.CurrentDomain=="","stopping monitoring immediately hides the domain");
    }finally{await bridge.Stop();}
}finally{
    var full=Path.GetFullPath(path);if(full.StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase)&&Path.GetFileName(full).StartsWith("workstream-verification-")){for(var attempt=0;attempt<5;attempt++){try{Directory.Delete(full,true);break;}catch(IOException){GC.Collect();GC.WaitForPendingFinalizers();Thread.Sleep(100);}}}
}
