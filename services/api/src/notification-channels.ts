import {z} from "zod";
import {db} from "./firebase.js";
import {encrypt,decrypt,encryptedNotificationsConfigured} from "./notifications.js";

export const channelType=z.enum(["WINDOWS_AGENT","DASHBOARD","EMAIL","TELEGRAM","WHATSAPP"]);
export type ChannelType=z.infer<typeof channelType>;
const ref=(companyId:string,type:ChannelType)=>db.collection("notification_channels").doc(companyId+"_"+type);
const mask=(value:string)=>value.length<5?"••••":"••••••••"+value.slice(-4);

/** Browser-safe channel metadata. Credentials and ciphertext never leave this module. */
export async function channelMetadata(companyId:string){
  const docs=await db.collection("notification_channels").where("companyId","==",companyId).get();
  const stored=new Map(docs.docs.map(doc=>[String(doc.data().type),doc.data()]));
  return channelType.options.map(type=>{
    const value=stored.get(type);
    if(type==="WINDOWS_AGENT")return {type,enabled:true,status:"AVAILABLE",configured:true,maskedIdentifier:null,lastTestedAt:null,lastTestStatus:null};
    if(type==="DASHBOARD")return {type,enabled:Boolean(value?.enabled),status:"AVAILABLE",configured:true,maskedIdentifier:null,lastTestedAt:value?.lastTestedAt??null,lastTestStatus:value?.lastTestStatus??null};
    return {type,enabled:Boolean(value?.enabled),status:value?.status??"NOT_CONFIGURED",configured:Boolean(value?.encryptedCredentials||value?.providerConfigured),maskedIdentifier:value?.maskedIdentifier??null,lastTestedAt:value?.lastTestedAt??null,lastTestStatus:value?.lastTestStatus??null};
  });
}

export async function saveChannel(companyId:string,type:ChannelType,input:{enabled:boolean;destination?:string;token?:string;provider?:string}){
  if(type==="WINDOWS_AGENT")throw Object.assign(new Error("The Windows agent channel is available automatically on enrolled devices."),{statusCode:400});
  if(type!=="DASHBOARD"&&!encryptedNotificationsConfigured())throw Object.assign(new Error("Notification encryption is not configured on the server."),{statusCode:503});
  const current=(await ref(companyId,type).get()).data();
  let encryptedCredentials=current?.encryptedCredentials??null,maskedIdentifier=current?.maskedIdentifier??null,providerConfigured=Boolean(current?.providerConfigured);
  if(type==="TELEGRAM"&&input.token){encryptedCredentials=encrypt(JSON.stringify({token:input.token}));maskedIdentifier=mask(input.token);providerConfigured=true;}
  if(type==="WHATSAPP"&&input.token){encryptedCredentials=encrypt(JSON.stringify({token:input.token,provider:input.provider??"META"}));maskedIdentifier=mask(input.token);providerConfigured=true;}
  if(type==="EMAIL")providerConfigured=true;
  await ref(companyId,type).set({companyId,type,enabled:input.enabled,destination:input.destination?.trim()||current?.destination||null,provider:input.provider??current?.provider??type,providerConfigured,encryptedCredentials,maskedIdentifier,status:type==="DASHBOARD"?"AVAILABLE":providerConfigured?"CONFIGURED":"NOT_CONFIGURED",updatedAt:Date.now()},{merge:true});
}

export async function removeChannel(companyId:string,type:ChannelType){if(type==="DASHBOARD"){await ref(companyId,type).set({companyId,type,enabled:false,status:"AVAILABLE",updatedAt:Date.now()},{merge:true});return;}await ref(companyId,type).delete();}

/** Server-only delivery lookup. Never return this value from a route. */
export async function deliveryChannel(companyId:string,type:ChannelType){
  if(type==="WINDOWS_AGENT")return {enabled:true,configured:true,destination:"",credentials:null as Record<string,string>|null};
  const value=(await ref(companyId,type).get()).data();
  if(type==="DASHBOARD")return {enabled:Boolean(value?.enabled),configured:true,destination:"",credentials:null as Record<string,string>|null};
  if(!value?.enabled)return {enabled:false,configured:false,destination:"",credentials:null as Record<string,string>|null};
  if(type==="EMAIL")return {enabled:true,configured:Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM),destination:String(value.destination??""),credentials:null as Record<string,string>|null};
  if(type==="TELEGRAM"){
    if(!value.encryptedCredentials||!value.destination)return {enabled:true,configured:false,destination:"",credentials:null as Record<string,string>|null};
    try{return {enabled:true,configured:true,destination:String(value.destination),credentials:JSON.parse(decrypt(value.encryptedCredentials)) as Record<string,string>};}
    catch{return {enabled:true,configured:false,destination:"",credentials:null as Record<string,string>|null};}
  }
  // A WhatsApp adapter is intentionally unavailable until a provider is connected server-side.
  return {enabled:true,configured:false,destination:"",credentials:null as Record<string,string>|null};
}

/** Telegram validation is real, but it never returns a token or provider body to the browser. */
export async function testTelegram(companyId:string,input:{token?:string;chatId?:string}){
  const current=(await ref(companyId,"TELEGRAM").get()).data();
  const token=input.token??(current?.encryptedCredentials?JSON.parse(decrypt(current.encryptedCredentials)).token:"");
  const chatId=input.chatId??current?.destination;
  if(!token||!chatId)throw Object.assign(new Error("Enter a bot token and chat ID before testing."),{statusCode:400});
  let ok=false;
  try{const response=await fetch("https://api.telegram.org/bot"+token+"/getChat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId}),signal:AbortSignal.timeout(15000)});const body=await response.json().catch(()=>null) as {ok?:boolean}|null;ok=Boolean(response.ok&&body?.ok);}catch{ok=false;}
  await ref(companyId,"TELEGRAM").set({companyId,type:"TELEGRAM",lastTestedAt:Date.now(),lastTestStatus:ok?"CONNECTED":"FAILED",status:ok?"CONNECTED":"CONNECTION_FAILED",updatedAt:Date.now()},{merge:true});
  if(!ok)throw Object.assign(new Error("Telegram could not validate that bot and chat. Check the token, chat ID, and that the bot can access the chat."),{statusCode:400});
  return {connected:true};
}
