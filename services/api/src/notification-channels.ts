import {z} from "zod";
import {db} from "./firebase.js";

export const channelType=z.enum(["EMAIL"]);
export type ChannelType=z.infer<typeof channelType>;
const ref=(companyId:string)=>db.collection("notification_channels").doc(companyId+"_EMAIL");
const providerConfigured=()=>Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM);
const encryptionConfigured=()=>{try{return Boolean(process.env.NOTIFICATION_ENCRYPTION_KEY&&Buffer.from(process.env.NOTIFICATION_ENCRYPTION_KEY,'base64').length===32);}catch{return false;}};

/** Browser-safe metadata for the only supported delivery channel. */
export async function channelMetadata(companyId:string){
  const value=(await ref(companyId).get()).data();
  const configured=providerConfigured();
  return [{type:"EMAIL" as const,enabled:Boolean(value?.enabled),status:configured?"CONFIGURED":"NOT_CONFIGURED",configured,maskedIdentifier:null,lastTestedAt:null,lastTestStatus:null}];
}

export async function saveChannel(companyId:string,type:ChannelType,input:{enabled:boolean;destination?:string}){
  if(!encryptionConfigured())throw Object.assign(new Error("Notification encryption is not configured on the server."),{statusCode:503});
  const current=(await ref(companyId).get()).data();
  const destination=input.destination?.trim()||current?.destination||"";
  if(input.enabled&&!destination)throw Object.assign(new Error("Enter the employer delivery email."),{statusCode:400});
  await ref(companyId).set({companyId,type,enabled:input.enabled,destination:destination||null,provider:"RESEND",providerConfigured:providerConfigured(),status:providerConfigured()?"CONFIGURED":"NOT_CONFIGURED",updatedAt:Date.now()},{merge:true});
}

export async function removeChannel(companyId:string,_type:ChannelType){await ref(companyId).delete();}

/** Server-only Resend delivery lookup. */
export async function deliveryChannel(companyId:string,_type:ChannelType){
  const value=(await ref(companyId).get()).data();
  return {enabled:Boolean(value?.enabled),configured:providerConfigured(),destination:String(value?.destination??""),credentials:null as Record<string,string>|null};
}
