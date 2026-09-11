// Read the active hostname only after the agent confirms both monitoring gates.
let pending=false;
async function sample(){
 if(pending)return;pending=true;
 try{
  const {pairingSecret}=await chrome.storage.local.get('pairingSecret');if(!pairingSecret)return;
  const headers={'X-Workstream-Pairing':pairingSecret,'Content-Type':'application/json'};
  const status=await fetch('http://127.0.0.1:43173/v1/status',{headers});
  if(!status.ok||!(await status.json()).enabled)return;
  const window=await chrome.windows.getLastFocused();
  const [tab]=window.focused?await chrome.tabs.query({active:true,windowId:window.id}):[];
  const domain=tab?.url&&/^https?:/.test(tab.url)?new URL(tab.url).hostname.replace(/^www\./,'').toLowerCase():'';
  await fetch('http://127.0.0.1:43173/v1/browser-activity',{method:'POST',headers,body:JSON.stringify({domain})});
 }catch{/* Agent may be closed. Never queue browsing data. */}finally{pending=false;}
}
chrome.tabs.onActivated.addListener(sample);
chrome.tabs.onUpdated.addListener((_id,change,tab)=>{if(tab.active&&(change.url||change.status==='complete'))void sample();});
chrome.windows.onFocusChanged.addListener(sample);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='workstream-sample')void sample();});
chrome.alarms.create('workstream-sample',{periodInMinutes:0.5});
chrome.storage.onChanged.addListener(sample);
