import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {db} from './firebase.js';
import type {DocumentReference} from 'firebase-admin/firestore';
import {deliveryChannel} from './notification-channels.js';

export type Channel='EMAIL';
export function channelConfigured(channel:Channel){
  if(channel==='EMAIL')return !!(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM);
  return false;
}
function encryptionKey(){const raw=process.env.NOTIFICATION_ENCRYPTION_KEY;const key=raw?Buffer.from(raw,'base64'):null;return key?.length===32?key:null;}
export const encryptedNotificationsConfigured=()=>!!encryptionKey();
export function encrypt(value:string){const key=encryptionKey();if(!key)return null;const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');}
export function decrypt(value:string){const key=encryptionKey();if(!key)throw new Error('Notification encryption key is not configured.');const raw=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString('utf8');}
export type Message={channel:Channel;recipient:string;subject:string;text:string;audience?:'EMPLOYEE'|'EMPLOYER'};
export interface Provider {send(message:Message,key:string):Promise<string>}
export const providers:Partial<Record<Channel,Provider>>={
  EMAIL:{async send(message,key){
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[message.recipient],subject:message.subject,text:message.text}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Email provider returned '+response.status);
    return (await response.json() as {id:string}).id;
  }},
};
export async function notificationRecord(companyId:string,message:Message,systemDelivery=false){
  const config=systemDelivery?{enabled:true,configured:channelConfigured(message.channel)}:await deliveryChannel(companyId,message.channel);
  const encryptedBody=encrypt(JSON.stringify(message));
  return {companyId,channel:message.channel,encryptedBody,status:config.enabled&&config.configured&&encryptedBody?'PENDING':'NOT_CONFIGURED',systemDelivery,attempts:0,nextAttemptAt:Date.now(),createdAt:Date.now()};
}
/** A transactional lease prevents concurrent workers. Resend retries share a stable key. */
export async function deliver(ref:DocumentReference){
  const lease=randomBytes(16).toString('hex');
  const before=(await ref.get()).data();if(!before)return;
  const config=before.systemDelivery?{enabled:true,configured:channelConfigured(before.channel as Channel),destination:"",credentials:null}:await deliveryChannel(String(before.companyId),before.channel as Channel);
  const job=await db.runTransaction(async tx=>{const data=(await tx.get(ref)).data();if(!data||['DELIVERED','FAILED','REVIEW_REQUIRED','NOT_CONFIGURED'].includes(data.status)||data.nextAttemptAt>Date.now()||data.leaseUntil>Date.now())return null;if(!data.encryptedBody||!config.enabled||!config.configured||!encryptionKey()){tx.update(ref,{status:'NOT_CONFIGURED'});return null;}tx.update(ref,{status:'SENDING',lease,leaseUntil:Date.now()+60000});return data;});
  if(!job)return;
  let result:Record<string,unknown>;
  try{const message=JSON.parse(decrypt(job.encryptedBody)) as Message;const provider=providers.EMAIL!;const recipient=message.audience==='EMPLOYEE'?message.recipient:(config.destination||message.recipient);const providerId=await provider.send({...message,recipient},ref.id);result={status:'DELIVERED',providerId,deliveredAt:Date.now()};}
  catch{const attempts=Number(job.attempts??0)+1;result={status:attempts>=5?'FAILED':'RETRY',attempts,nextAttemptAt:Date.now()+Math.min(3600000,30000*2**attempts),lastError:'Resend delivery failed. Provider configuration, destination or network require attention.'};}
  await db.runTransaction(async tx=>{if((await tx.get(ref)).data()?.lease===lease)tx.update(ref,{...result,leaseUntil:0});});
}
export async function processNotifications(companyId:string){
  for(const collection of ['notification_jobs','invitations']){
    const docs=await db.collection(collection).where('companyId','==',companyId).get();
    for(const doc of docs.docs)if(doc.data().channel==='EMAIL')await deliver(doc.ref);
  }
}
