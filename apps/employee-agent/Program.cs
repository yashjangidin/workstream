using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Drawing.Imaging;
using Microsoft.Data.Sqlite;

namespace Workstream.Agent;

internal static class Deployment {
    // Release builds always connect to the hosted API. A local API address is
    // only appropriate when explicitly supplied by a development build.
    public const string ApiUrl="https://workstream-api-tlk3.onrender.com";
}

internal static class Program {
    [STAThread] static void Main(string[] args) { if(args.Contains("--unregister")){Unregister();return;} ApplicationConfiguration.Initialize(); using var mutex=new Mutex(true,"Local\\WorkstreamEmployeeAgent",out var first); if(!first)return; Application.Run(new AgentForm()); }
    static void Unregister(){try{using var store=new Store();var state=store.Load();if(string.IsNullOrWhiteSpace(state.DeviceId)||string.IsNullOrWhiteSpace(state.Credential))return;using var http=new HttpClient{Timeout=TimeSpan.FromSeconds(20)};using var request=new HttpRequestMessage(HttpMethod.Delete,state.ApiUrl+"/v1/device/self");request.Headers.Authorization=new AuthenticationHeaderValue("Device",state.DeviceId+"."+state.Credential);http.Send(request);}catch{ /* Local cleanup still proceeds when offline. */ }}
}
internal sealed class State {
    public string ApiUrl {get;set;}=Deployment.ApiUrl;
    public string InstallationId {get;set;}=Guid.NewGuid().ToString("N");
    public string Credential {get;set;}="";
    public string DeviceId {get;set;}="";
    public string BrowserSecret {get;set;}=Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    public string EmployeeName {get;set;}="";
    public string Timezone {get;set;}="UTC";
    public int RequiredDailySeconds {get;set;}=28800;
    public int IdleThresholdSeconds {get;set;}=30;
    public int HeartbeatSeconds {get;set;}=60;
    public string MonitoringMode {get;set;}="SIMPLE_TIMER";
    public string? SessionId {get;set;}
    public long StartedAt {get;set;}
    public string? IdleId {get;set;}
    public long IdleStartedAt {get;set;}
    public long IdleMilliseconds {get;set;}
    public long LastAuthorizedAt {get;set;}
    public long TimerStateChangedAt {get;set;}
}
internal sealed class Store : IDisposable {
    public readonly string DirectoryPath;
    private readonly SqliteConnection connection;
    private SqliteTransaction? transaction;
    public void Atomic(Action action){using var tx=connection.BeginTransaction();transaction=tx;try{action();tx.Commit();}finally{transaction=null;}}
    public void Quarantine(long id,string reason){using var cmd=connection.CreateCommand();cmd.CommandText="INSERT INTO rejected SELECT id,path,body,image,$reason FROM queue WHERE id=$id; DELETE FROM queue WHERE id=$id";cmd.Parameters.AddWithValue("$reason",reason);cmd.Parameters.AddWithValue("$id",id);cmd.ExecuteNonQuery();}
    public Store(string? directory=null){DirectoryPath=directory??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Workstream");Directory.CreateDirectory(DirectoryPath); connection=new SqliteConnection("Data Source="+Path.Combine(DirectoryPath,"agent.db")); connection.Open(); using var cmd=connection.CreateCommand();cmd.CommandText="PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, data BLOB NOT NULL); CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL,body TEXT NOT NULL,image TEXT); CREATE TABLE IF NOT EXISTS rejected(id INTEGER PRIMARY KEY,path TEXT,body TEXT,image TEXT,reason TEXT); CREATE TABLE IF NOT EXISTS uploaded(path TEXT PRIMARY KEY, day TEXT NOT NULL);";cmd.ExecuteNonQuery();}
    public State Load(){using var cmd=connection.CreateCommand();cmd.CommandText="SELECT data FROM state WHERE id=1";var bytes=cmd.ExecuteScalar() as byte[];return bytes==null?new():JsonSerializer.Deserialize<State>(ProtectedData.Unprotect(bytes,null,DataProtectionScope.CurrentUser))??new();}
    public void Save(State state){var bytes=ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(state),null,DataProtectionScope.CurrentUser);using var cmd=connection.CreateCommand();cmd.Transaction=transaction;cmd.CommandText="INSERT OR REPLACE INTO state(id,data) VALUES(1,$data)";cmd.Parameters.AddWithValue("$data",bytes);cmd.ExecuteNonQuery();}
    public void Add(string path,object body,string? image=null){using var cmd=connection.CreateCommand();cmd.Transaction=transaction;cmd.CommandText="INSERT INTO queue(path,body,image) VALUES($path,$body,$image)";cmd.Parameters.AddWithValue("$path",path);cmd.Parameters.AddWithValue("$body",JsonSerializer.Serialize(body));cmd.Parameters.AddWithValue("$image",(object?)image??DBNull.Value);cmd.ExecuteNonQuery();}
    public (long Id,string Path,string Body,string? Image)? First(){using var cmd=connection.CreateCommand();cmd.CommandText="SELECT id,path,body,image FROM queue ORDER BY CASE WHEN path IN ('/v1/device/sessions/start','/v1/device/idle','/v1/device/sessions/stop') THEN 0 ELSE 1 END,id LIMIT 1";using var r=cmd.ExecuteReader();return r.Read()?(r.GetInt64(0),r.GetString(1),r.GetString(2),r.IsDBNull(3)?null:r.GetString(3)):null;}
    public void Complete(long id,string? image){using var tx=connection.BeginTransaction();using var cmd=connection.CreateCommand();cmd.Transaction=tx;cmd.CommandText="DELETE FROM queue WHERE id=$id";cmd.Parameters.AddWithValue("$id",id);cmd.ExecuteNonQuery();if(image!=null){cmd.Parameters.Clear();cmd.CommandText="INSERT OR REPLACE INTO uploaded(path,day) VALUES($path,$day)";cmd.Parameters.AddWithValue("$path",image);cmd.Parameters.AddWithValue("$day",DateTime.Today.ToString("yyyy-MM-dd"));cmd.ExecuteNonQuery();}tx.Commit();}
    public void Cleanup(){var paths=new List<string>();using(var cmd=connection.CreateCommand()){cmd.CommandText="SELECT path FROM uploaded WHERE day < $today";cmd.Parameters.AddWithValue("$today",DateTime.Today.ToString("yyyy-MM-dd"));using var r=cmd.ExecuteReader();while(r.Read())paths.Add(r.GetString(0));}foreach(var path in paths){var full=Path.GetFullPath(path);if(!full.StartsWith(Path.GetFullPath(DirectoryPath)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))continue;if(File.Exists(full))File.Delete(full);using var cmd=connection.CreateCommand();cmd.CommandText="DELETE FROM uploaded WHERE path=$path";cmd.Parameters.AddWithValue("$path",path);cmd.ExecuteNonQuery();}}
    public void ResetAuthorization(State next){
        Atomic(()=>{using var cmd=connection.CreateCommand();cmd.Transaction=transaction;cmd.CommandText="DELETE FROM queue; DELETE FROM rejected; DELETE FROM uploaded;";cmd.ExecuteNonQuery();Save(next);});
        foreach(var path in Directory.EnumerateFiles(DirectoryPath,"*.capture")){try{File.Delete(path);}catch(IOException){}}
    }
    public void DiscardScreenshotUploads(){
        Atomic(()=>{using var cmd=connection.CreateCommand();cmd.Transaction=transaction;cmd.CommandText="DELETE FROM queue WHERE path='/v1/device/screenshots'; DELETE FROM rejected WHERE path='/v1/device/screenshots'; DELETE FROM uploaded;";cmd.ExecuteNonQuery();});
        foreach(var path in Directory.EnumerateFiles(DirectoryPath,"*.capture")){try{File.Delete(path);}catch(IOException){}}
    }
    public void Dispose()=>connection.Dispose();
}
internal sealed class AgentForm:Form {
    const string AgentVersion="0.2.8";
    const bool ScreenshotUploadsEnabled=false;
    readonly BrowserBridge bridge=new();
    readonly Button browserPair=new(){Text="Copy browser pairing key",Width=320},correction=new(){Text="Request time correction",Width=320};
    readonly Store store=new(); readonly State state; readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(90)};
    readonly Label name=new(){AutoSize=true}, status=new(){AutoSize=true}, timerLabel=new(){AutoSize=true,Font=new Font("Segoe UI",17,FontStyle.Bold)}, monitoring=new(){AutoSize=true,MaximumSize=new Size(340,0)}, warning=new(){AutoSize=true,MaximumSize=new Size(340,0)};
    readonly TextBox url=new(){Width=320},code=new(){Width=320,PlaceholderText="Employee setup code",UseSystemPasswordChar=true};
    readonly Button pair=new(){Text="Connect",Width=320},toggle=new(){Text="START TIMER",Width=320,Height=40};
    readonly Panel sessionCard=Card();
    readonly Panel noticeCard=NoticeCard();
    readonly System.Windows.Forms.Timer tick=new(){Interval=1000};
    readonly NotifyIcon trayIcon=new();
    Icon? appIcon;
    long SyncIntervalMilliseconds=>Math.Max(30,state.HeartbeatSeconds)*1000L;
    bool syncing=false,closing=false,closed=false; AuthorizationStatus authorization; int rejected=0;long lastSync=0,lastCapture=0,activityAt=0;string application="",activeDomain="";
    static long Now=>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public AgentForm(){
        state=store.Load();
        // Migrate unpaired installations created by the local-development
        // build. They should never require a person to replace localhost.
        if(state.DeviceId==""&&state.ApiUrl=="http://127.0.0.1:8080"){state.ApiUrl=Deployment.ApiUrl;store.Save(state);}
        if(!ScreenshotUploadsEnabled)store.DiscardScreenshotUploads();
        authorization=state.DeviceId==""?AuthorizationStatus.SetupRequired:AuthorizationStatus.Connecting;
        BuildWindow();
        url.Text=state.ApiUrl;
        browserPair.Click+=(_,_)=>{Clipboard.SetText(state.BrowserSecret);warning.Text="Browser pairing key copied. Paste it into the Workstream extension options.";};
        correction.Click+=(_,_)=>RequestCorrection();
        Shown+=async(_,_)=>{try{await bridge.Start(state.BrowserSecret);}catch{warning.Text="Browser bridge could not start. Timer tracking remains available.";} if(state.DeviceId!="")await RevalidateAuthorization();};
        pair.Click+=async(_,_)=>await Enroll();toggle.Click+=async(_,_)=>await Toggle();tick.Tick+=async(_,_)=>await Tick();tick.Start();
        Resize+=(_,_)=>{if(WindowState==FormWindowState.Minimized){Hide();trayIcon.ShowBalloonTip(1500,"Workstream","Workstream is still running in the notification area.",ToolTipIcon.Info);}};
        FormClosing+=async(_,e)=>{if(closed)return;e.Cancel=true;if(closing)return;closing=true;tick.Stop();http.CancelPendingRequests();while(syncing)await Task.Delay(20);await bridge.Stop();store.Save(state);store.Dispose();http.Dispose();trayIcon.Visible=false;trayIcon.Dispose();appIcon?.Dispose();closed=true;Close();};
        Render();
    }
    void BuildWindow(){
        Text="Workstream"; ClientSize=new Size(454,610); MinimumSize=new Size(454,610); StartPosition=FormStartPosition.CenterScreen; BackColor=Color.FromArgb(246,249,247); Font=new Font("Segoe UI",9.5f); Icon=appIcon=CreateAppIcon();
        var menu=new ContextMenuStrip(); menu.Items.Add("Open Workstream",null,(_,_)=>ShowFromTray()); menu.Items.Add("Exit",null,(_,_)=>Close());
        trayIcon.Icon=appIcon;trayIcon.Text="Workstream";trayIcon.ContextMenuStrip=menu;trayIcon.Visible=true;trayIcon.DoubleClick+=(_,_)=>ShowFromTray();
        var root=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,BackColor=BackColor,Padding=new Padding(22)};root.RowStyles.Add(new RowStyle(SizeType.AutoSize));root.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        var header=new Panel{Height=82,Dock=DockStyle.Top,BackColor=Color.FromArgb(29,91,70),Margin=new Padding(0,0,0,18)};
        var brand=new Label{Text="W",ForeColor=Color.FromArgb(215,244,126),BackColor=Color.FromArgb(42,112,86),TextAlign=ContentAlignment.MiddleCenter,Font=new Font("Segoe UI",16,FontStyle.Bold),Location=new Point(18,20),Size=new Size(42,42)};
        var heading=new Label{Text="WORKSTREAM",ForeColor=Color.White,Font=new Font("Segoe UI",11,FontStyle.Bold),AutoSize=true,Location=new Point(74,20)};
        var subheading=new Label{Text="Desktop time tracking",ForeColor=Color.FromArgb(204,226,216),AutoSize=true,Location=new Point(75,45)};
        header.Controls.AddRange([brand,heading,subheading]);root.Controls.Add(header,0,0);
        var content=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(0,0,4,0)};
        name.Font=new Font("Segoe UI",15,FontStyle.Bold);name.Margin=new Padding(8,0,0,2);status.ForeColor=Color.FromArgb(54,105,86);status.Font=new Font("Segoe UI",9,FontStyle.Bold);status.Margin=new Padding(8,0,0,16);
        timerLabel.Font=new Font("Segoe UI",20,FontStyle.Bold);timerLabel.ForeColor=Color.FromArgb(22,59,47);timerLabel.Margin=new Padding(18,15,0,8);
        monitoring.ForeColor=Color.FromArgb(72,91,83);monitoring.Margin=new Padding(18,0,18,12);warning.ForeColor=Color.FromArgb(132,79,26);warning.Location=new Point(13,11);warning.MaximumSize=new Size(366,0);noticeCard.Controls.Add(warning);
        StyleButton(toggle,true);StyleButton(browserPair,false);StyleButton(correction,false);StyleButton(pair,true);url.Margin=new Padding(8,8,8,4);code.Margin=new Padding(8,4,8,8);
        sessionCard.Controls.AddRange([timerLabel,monitoring]);
        content.Controls.AddRange([name,status,url,code,pair,sessionCard,toggle,browserPair,correction,noticeCard]);root.Controls.Add(content,0,1);Controls.Add(root);
    }
    static Panel Card(){return new Panel{Width=402,Height=158,BackColor=Color.White,BorderStyle=BorderStyle.FixedSingle,Margin=new Padding(0,0,0,14)};}
    static Panel NoticeCard(){return new Panel{Width=402,Height=58,BackColor=Color.FromArgb(255,247,232),BorderStyle=BorderStyle.FixedSingle,Margin=new Padding(0,4,0,0)};}
    static void StyleButton(Button button,bool primary){button.Width=402;button.Height=42;button.FlatStyle=FlatStyle.Flat;button.FlatAppearance.BorderSize=1;button.FlatAppearance.BorderColor=primary?Color.FromArgb(29,91,70):Color.FromArgb(202,216,208);button.BackColor=primary?Color.FromArgb(29,91,70):Color.White;button.ForeColor=primary?Color.White:Color.FromArgb(27,65,51);button.Font=new Font("Segoe UI",9.5f,FontStyle.Bold);button.Margin=new Padding(0,0,0,8);}
    void ShowFromTray(){Show();WindowState=FormWindowState.Normal;Activate();}
    static Icon CreateAppIcon(){using var bitmap=new Bitmap(64,64);using(var g=Graphics.FromImage(bitmap)){g.Clear(Color.FromArgb(29,91,70));using var font=new Font("Segoe UI",34,FontStyle.Bold,GraphicsUnit.Pixel);using var brush=new SolidBrush(Color.FromArgb(215,244,126));g.DrawString("W",font,brush,new PointF(9,9));}var handle=bitmap.GetHicon();using var temporary=Icon.FromHandle(handle);return (Icon)temporary.Clone();}
    async Task Enroll(){
        pair.Enabled=false;authorization=AuthorizationStatus.Connecting;Render();
        try{
            var uri=new Uri(url.Text.Trim());if(uri.Scheme!="https"&&!uri.IsLoopback)throw new Exception("Use HTTPS except for a local development server.");
            ClearAuthorizationState();state.ApiUrl=uri.ToString().TrimEnd('/');state.Credential=Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_');store.ResetAuthorization(state);
            using var request=new HttpRequestMessage(HttpMethod.Post,state.ApiUrl+"/v1/device/enroll"){Content=new StringContent(JsonSerializer.Serialize(new{setupCode=code.Text.Trim(),installationId=state.InstallationId,credential=state.Credential,name=Environment.MachineName,agentVersion=AgentVersion}),Encoding.UTF8,"application/json")};
            using var response=await http.SendAsync(request);var text=await response.Content.ReadAsStringAsync();var data=JsonDocument.Parse(text).RootElement;
            if(!response.IsSuccessStatusCode)throw new Exception(data.TryGetProperty("message",out var message)?message.GetString():"Unable to connect this device.");
            state.DeviceId=data.GetProperty("deviceId").GetString()!;state.EmployeeName=data.GetProperty("employeeName").GetString()!;state.LastAuthorizedAt=Now;code.Clear();authorization=AuthorizationStatus.Authorized;store.Save(state);warning.Text="Connected. You control when the timer starts.";await Sync();
        }catch(Exception e){authorization=AuthorizationStatus.SetupRequired;warning.Text=e.Message;}finally{pair.Enabled=true;Render();}
    }
    async Task<JsonElement> Send(string path,HttpMethod method,string? body=null){
        using var request=new HttpRequestMessage(method,state.ApiUrl+path);request.Headers.Authorization=new AuthenticationHeaderValue("Device",state.DeviceId+"."+state.Credential);if(body!=null)request.Content=new StringContent(body,Encoding.UTF8,"application/json");
        using var response=await http.SendAsync(request);var text=await response.Content.ReadAsStringAsync();
        if(response.StatusCode==System.Net.HttpStatusCode.Unauthorized||response.StatusCode==System.Net.HttpStatusCode.Forbidden){
            using var payload=JsonDocument.Parse(string.IsNullOrWhiteSpace(text)?"{}":text);var code=payload.RootElement.TryGetProperty("code",out var value)?value.GetString():null;var message=payload.RootElement.TryGetProperty("message",out var detail)?detail.GetString():null;
            if(!string.IsNullOrWhiteSpace(code))throw new DeviceAuthorizationException(code!,message??"This device is no longer authorized.");
        }
        if(!response.IsSuccessStatusCode)throw new HttpRequestException("Sync failed ("+(int)response.StatusCode+"). Data is retained for retry.",null,response.StatusCode);
        return JsonDocument.Parse(text).RootElement.Clone();
    }
    bool CanOperate()=>AuthorizationGate.CanOperate(authorization,state.DeviceId,state.LastAuthorizedAt,Now)&&!closing;
    void ClearAuthorizationState(){state.ApiUrl=Deployment.ApiUrl;state.Credential="";state.DeviceId="";state.EmployeeName="";state.BrowserSecret=Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));state.Timezone="UTC";state.RequiredDailySeconds=28800;state.IdleThresholdSeconds=30;state.HeartbeatSeconds=60;state.MonitoringMode="SIMPLE_TIMER";state.SessionId=null;state.StartedAt=0;state.IdleId=null;state.IdleStartedAt=0;state.IdleMilliseconds=0;state.LastAuthorizedAt=0;state.TimerStateChangedAt=0;application="";activeDomain="";activityAt=0;lastCapture=0;bridge.Enabled=false;}
    void Revoke(string reason){authorization=AuthorizationStatus.Revoked;ClearAuthorizationState();store.ResetAuthorization(state);authorization=AuthorizationStatus.SetupRequired;warning.Text=reason+" Connect this computer using a new employee setup code.";Render();}
    async Task RevalidateAuthorization(){if(state.DeviceId==""||state.Credential=="")return;authorization=AuthorizationStatus.Connecting;Render();await Sync();}
    async Task Toggle(){
        if(!CanOperate()){warning.Text=authorization==AuthorizationStatus.Offline?"Workstream is offline. Reconnecting before a new timer can start.":"Connect this computer to an employee before starting a timer.";Render();return;}
        if(state.SessionId==null){await Sync();if(!CanOperate())return;}
        store.Atomic(()=>{
            if(state.SessionId==null){
                state.SessionId=Guid.NewGuid().ToString("N");state.StartedAt=Now;state.TimerStateChangedAt=state.StartedAt;state.IdleMilliseconds=0;
                store.Add("/v1/device/sessions/start",new{operationId=Guid.NewGuid().ToString("N"),sessionId=state.SessionId,at=state.StartedAt});
                lastCapture=Now;activityAt=Now;application=Foreground();activeDomain=BrowserDomain(application);
            }else{
                CloseIdle();FlushActivity();var stoppedAt=Now;store.Add("/v1/device/sessions/stop",new{operationId=Guid.NewGuid().ToString("N"),sessionId=state.SessionId,at=stoppedAt});state.SessionId=null;state.TimerStateChangedAt=stoppedAt;
            }
            store.Save(state);
        });Render();lastSync=0;
    }
    void CloseIdle(){if(!CanOperate()||state.IdleId==null)return;store.Add("/v1/device/idle",new{operationId=Guid.NewGuid().ToString("N"),sessionId=state.SessionId,idleId=state.IdleId,at=state.IdleStartedAt,endedAt=Now});state.IdleMilliseconds+=Now-state.IdleStartedAt;state.IdleId=null;}
    void FlushActivity(){if(CanOperate()&&state.SessionId!=null&&state.MonitoringMode=="ACTIVE_MONITORING"&&activityAt>0&&Now>activityAt)store.Add("/v1/device/activity",new{operationId=Guid.NewGuid().ToString("N"),sessionId=state.SessionId,at=activityAt,endedAt=Now,application,domain=activeDomain});activityAt=Now;}
    async Task Tick(){
        if(closing){Render();return;}
        if(!CanOperate()){Render();if(!syncing&&state.DeviceId!=""&&authorization!=AuthorizationStatus.SetupRequired&&Now-lastSync>=SyncIntervalMilliseconds){lastSync=Now;await Sync();}return;}
        if(state.SessionId!=null){var idleFor=IdleMilliseconds();if(idleFor>=state.IdleThresholdSeconds*1000L&&state.IdleId==null){store.Atomic(()=>{state.IdleId=Guid.NewGuid().ToString("N");state.IdleStartedAt=Math.Max(state.StartedAt,Now-idleFor);store.Add("/v1/device/idle",new{operationId=Guid.NewGuid().ToString("N"),sessionId=state.SessionId,idleId=state.IdleId,at=state.IdleStartedAt,endedAt=(long?)null});store.Save(state);});}else if(idleFor<1000&&state.IdleId!=null){store.Atomic(()=>{CloseIdle();store.Save(state);});}if(state.MonitoringMode=="ACTIVE_MONITORING"){var foreground=Foreground();var domain=BrowserDomain(foreground);if(foreground!=application||domain!=activeDomain||Now-activityAt>=15000){FlushActivity();application=foreground;activeDomain=domain;}if(ScreenshotUploadsEnabled&&Now-lastCapture>=30000){lastCapture=Now;CaptureScreenshot();}}}
        Render();if(!syncing&&state.DeviceId!=""&&Now-lastSync>=SyncIntervalMilliseconds){lastSync=Now;await Sync();}
    }
    void CaptureScreenshot(){try{if(!CanOperate()||state.SessionId==null||state.MonitoringMode!="ACTIVE_MONITORING")return;var size=Directory.EnumerateFiles(store.DirectoryPath,"*.capture").Sum(p=>new FileInfo(p).Length);if(size>250L*1024*1024){warning.Text="Screenshot queue is full. Unsent images are retained; capture resumes after sync and cleanup.";return;}var bounds=Screen.PrimaryScreen!.Bounds;using var bitmap=new Bitmap(bounds.Width,bounds.Height);using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(bounds.Location,Point.Empty,bounds.Size);var path=Path.Combine(store.DirectoryPath,Guid.NewGuid().ToString("N")+".capture");var codec=ImageCodecInfo.GetImageEncoders().First(c=>c.MimeType=="image/jpeg");using var parameters=new EncoderParameters(1);parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,55L);using var stream=new MemoryStream();bitmap.Save(stream,codec,parameters);File.WriteAllBytes(path,ProtectedData.Protect(stream.ToArray(),null,DataProtectionScope.CurrentUser));store.Add("/v1/device/screenshots",new{operationId=Guid.NewGuid().ToString("N"),sessionId=state.SessionId,at=Now,application,domain=BrowserDomain(application)},path);}catch{warning.Text="Screenshot capture failed. Timer continues.";}}
    async Task Sync(){
        if(syncing)return; syncing=true;
        try{
            await Send("/v1/device/heartbeat",HttpMethod.Post,JsonSerializer.Serialize(new{agentVersion=AgentVersion,timerState=state.SessionId==null?"STOPPED":"RUNNING",timerStateAt=state.TimerStateChangedAt>0?state.TimerStateChangedAt:Now}));
            var conf=await Send("/v1/device/config",HttpMethod.Get);const string mode="SIMPLE_TIMER";
            if(mode!=state.MonitoringMode){activityAt=Now;lastCapture=Now;}state.MonitoringMode=mode;state.EmployeeName=conf.GetProperty("employeeName").GetString()!;state.IdleThresholdSeconds=conf.GetProperty("idleThresholdSeconds").GetInt32();state.RequiredDailySeconds=conf.GetProperty("requiredDailySeconds").GetInt32();state.HeartbeatSeconds=conf.GetProperty("heartbeatSeconds").GetInt32();state.Timezone=conf.GetProperty("timezone").GetString()!;state.LastAuthorizedAt=Now;authorization=AuthorizationStatus.Authorized;store.Save(state);
            var monitoringRetry=false;
            for(var count=0;count<50;count++){
                var item=store.First();if(item==null)break;var body=item.Value.Body;
                if(item.Value.Image!=null){var values=JsonSerializer.Deserialize<Dictionary<string,object>>(body)!;values["jpeg"]=Convert.ToBase64String(ProtectedData.Unprotect(File.ReadAllBytes(item.Value.Image),null,DataProtectionScope.CurrentUser));body=JsonSerializer.Serialize(values);}
                try{await Send(item.Value.Path,HttpMethod.Post,body);store.Complete(item.Value.Id,item.Value.Image);}
                catch(HttpRequestException e) when((item.Value.Path.EndsWith("/screenshots")||item.Value.Path.EndsWith("/activity")) && e.StatusCode is System.Net.HttpStatusCode.BadRequest or System.Net.HttpStatusCode.Conflict or System.Net.HttpStatusCode.NotFound){store.Quarantine(item.Value.Id,e.Message);rejected++;}
                catch(HttpRequestException) when(item.Value.Path.EndsWith("/screenshots")||item.Value.Path.EndsWith("/activity")){monitoringRetry=true;break;}
            }
            store.Cleanup();warning.Text=monitoringRetry?"Screenshot delivery is retrying. Your timer and work-time data are synced.":rejected>0?$"{rejected} monitoring record(s) were rejected by server policy. Timer sync continues.":"";
        }catch(DeviceAuthorizationException e){Revoke(e.Message);}
        catch(TaskCanceledException){if(authorization!=AuthorizationStatus.SetupRequired){authorization=AuthorizationStatus.Offline;warning.Text="Connecting to Workstream is taking longer than usual. Retrying automatically.";}}
        catch(Exception e){if(authorization!=AuthorizationStatus.SetupRequired){authorization=AuthorizationStatus.Offline;warning.Text="Offline · retrying. "+e.Message;}}
        finally{syncing=false;Render();}
    }
    void Render(){
        var canOperate=CanOperate();var setup=authorization==AuthorizationStatus.SetupRequired||authorization==AuthorizationStatus.Revoked;
        bridge.Enabled=canOperate&&state.SessionId!=null&&state.MonitoringMode=="ACTIVE_MONITORING";
        browserPair.Enabled=canOperate;correction.Enabled=canOperate;status.ForeColor=authorization==AuthorizationStatus.Offline?Color.FromArgb(158,97,29):Color.FromArgb(54,105,86);
        name.Text=setup?"Connect this computer":authorization==AuthorizationStatus.Connecting?"Checking device authorization…":state.EmployeeName;
        status.Text=setup?"Device not connected":authorization==AuthorizationStatus.Authorized?"Connected":authorization==AuthorizationStatus.Offline?"Offline · retrying":"Connecting";
        url.Visible=code.Visible=pair.Visible=setup;sessionCard.Visible=canOperate;toggle.Visible=browserPair.Visible=correction.Visible=!setup;toggle.Enabled=canOperate;toggle.Text=state.SessionId==null?"START TIMER":"STOP TIMER";noticeCard.Visible=!string.IsNullOrWhiteSpace(warning.Text);
        var elapsed=state.SessionId==null?0:Math.Max(0,Now-state.StartedAt);var idle=state.IdleMilliseconds+(state.IdleId==null?0:Now-state.IdleStartedAt);timerLabel.Text="CURRENT SESSION\n"+TimeSpan.FromMilliseconds(elapsed).ToString(@"hh\:mm\:ss")+"\nEffective  "+TimeSpan.FromMilliseconds(Math.Max(0,elapsed-idle)).ToString(@"hh\:mm\:ss");monitoring.Text=state.SessionId!=null&&state.MonitoringMode=="ACTIVE_MONITORING"&&canOperate?"Activity monitoring is on. Screenshot capture is temporarily unavailable.":"Monitoring is off";if(state.IdleId!=null&&canOperate)monitoring.Text+="\nYou are idle. Idle time is excluded from effective work.";
    }
    string BrowserDomain(string app)=>new[]{"chrome.exe","msedge.exe","brave.exe","opera.exe"}.Contains(app.ToLowerInvariant())?bridge.CurrentDomain:"";
    void RequestCorrection(){
        using var dialog=new Form(){Text="Request time correction",ClientSize=new Size(400,350),StartPosition=FormStartPosition.CenterParent};
        var panel=new FlowLayoutPanel(){Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,Padding=new Padding(16),WrapContents=false};
        var start=new DateTimePicker(){Width=350,Format=DateTimePickerFormat.Custom,CustomFormat="yyyy-MM-dd HH:mm:ss",Value=DateTime.Now.AddHours(-1)};
        var end=new DateTimePicker(){Width=350,Format=DateTimePickerFormat.Custom,CustomFormat="yyyy-MM-dd HH:mm:ss",Value=DateTime.Now};
        var session=new TextBox(){Width=350,PlaceholderText="Existing session ID (blank for missed time)"};
        var reason=new TextBox(){Width=350,Height=70,Multiline=true,PlaceholderText="Explain what happened (at least 10 characters)"};
        var submit=new Button(){Text="Send for employer approval",Width=350};
        panel.Controls.AddRange([new Label(){Text="Requested start (this PC local time)",AutoSize=true},start,new Label(){Text="Requested stop",AutoSize=true},end,session,reason,submit]);dialog.Controls.Add(panel);
        submit.Click+=(_,_)=>{if(reason.Text.Trim().Length<10||end.Value<=start.Value||end.Value>DateTime.Now||end.Value-start.Value>TimeSpan.FromHours(24)){MessageBox.Show(dialog,"Enter a reason and a past interval of at most 24 hours.");return;}store.Add("/v1/device/corrections",new{operationId=Guid.NewGuid().ToString("N"),sessionId=string.IsNullOrWhiteSpace(session.Text)?null:session.Text.Trim(),startedAt=new DateTimeOffset(start.Value).ToUnixTimeMilliseconds(),stoppedAt=new DateTimeOffset(end.Value).ToUnixTimeMilliseconds(),reason=reason.Text.Trim()});warning.Text="Correction queued for employer review. Recorded time is unchanged until approved.";lastSync=0;dialog.Close();};dialog.ShowDialog(this);
    }
    [StructLayout(LayoutKind.Sequential)]struct LastInput{public uint cbSize;public uint dwTime;}
    [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    static long IdleMilliseconds(){var input=new LastInput{cbSize=(uint)Marshal.SizeOf<LastInput>()};return GetLastInputInfo(ref input)?unchecked((uint)Environment.TickCount-input.dwTime):0;}
    static string Foreground(){try{GetWindowThreadProcessId(GetForegroundWindow(),out var pid);using var process=Process.GetProcessById((int)pid);return process.ProcessName+".exe";}catch{return "unknown";}}
}
