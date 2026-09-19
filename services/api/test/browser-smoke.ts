import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {auth,db} from '../src/firebase.js';
if(process.env.WORKSTREAM_LIVE_TEST!=='1')throw new Error('Explicit live-test opt-in is required.');
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/TUSHAR/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1366,height:900}});
page.setDefaultTimeout(30000);
const email='ws-browser-'+randomUUID()+'@example.com',password=randomBytes(24).toString('base64url');
const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
let companyId='';
try{
  await page.goto('http://localhost:5173');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Company name',{exact:true}).fill('Browser QA Company');
  await page.getByLabel('Owner name',{exact:true}).fill('Browser QA Owner');
  await page.getByLabel('Email address',{exact:true}).fill(email);
  await page.locator('#password').fill(password);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=window.innerHeight),true,'Signup fits viewport');
  await page.getByRole('button',{name:'Create account →',exact:true}).click();
  await page.getByText('Your account is ready.',{exact:false}).waitFor();
  companyId=(await auth.getUserByEmail(email)).uid;
  await page.locator('#password').fill(password);
  await page.getByRole('button',{name:'Sign in →',exact:true}).click();
  await page.getByRole('heading',{name:'Your team today',exact:true}).waitFor();
  await page.getByRole('button',{name:'Add employee',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'Add employee',exact:true});
  await dialog.getByLabel('Full name',{exact:true}).fill('Browser QA Employee');
  await dialog.getByLabel('Email',{exact:true}).fill('employee-'+email);
  await dialog.getByLabel('department',{exact:false}).fill('QA');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await dialog.getByRole('heading',{name:'Browser QA Employee is ready to enroll.',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'View',exact:true}).first().click();
  await page.getByRole('heading',{name:'Browser QA Employee',exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'Edit employee',exact:true});
  await edit.getByLabel('Full name',{exact:true}).fill('Persisted QA Employee');
  await edit.getByRole('button',{name:'Save',exact:true}).click();
  await edit.getByText('Saved successfully.',{exact:true}).waitFor();
  await edit.getByRole('button',{name:'Close',exact:true}).click();
  await page.reload();await page.getByRole('heading',{name:'Persisted QA Employee',exact:true}).waitFor();
  for(const tab of ['Sessions','Idle','Productivity','Screenshots','Activity Timeline','Device','Settings']){
    await page.locator('.tabs').getByRole('button',{name:tab,exact:true}).click();
    await page.waitForTimeout(350);
  }
  await page.locator('.sidebar-nav').getByRole('button',{name:'Reports',exact:true}).click();
  await page.waitForURL(/\/app\/reports/);
  await page.getByText('Weekly reports sum the seven canonical daily totals per employee.',{exact:false}).waitFor();
  await page.getByLabel('Period',{exact:true}).selectOption('weekly');
  await page.getByRole('cell',{name:'Persisted QA Employee',exact:true}).waitFor();
  await page.locator('.sidebar-nav').getByRole('button',{name:'Settings',exact:true}).click();
  await page.waitForURL(/\/app\/settings/);
  await page.getByLabel('Company name',{exact:true}).fill('Persisted Browser Company');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.reload();await page.getByLabel('Company name',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Company name',{exact:true}).inputValue(),'Persisted Browser Company');
  await page.screenshot({path:'../../docs/browser-settings-qa.png',fullPage:true});
  await page.locator('.company-switch').click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Sign in →',exact:true}).waitFor();
  assert.deepEqual(errors,[],'No browser runtime exceptions');
  console.log('PASS: browser signup, sign-in, employee create/edit/refresh, nine detail tabs, weekly report, company save/refresh, logout; no runtime exceptions.');
}finally{
  await browser.close();
  if(!companyId){try{companyId=(await auth.getUserByEmail(email)).uid;}catch{}}
  if(companyId){for(const collection of ['employees','email_claims','setup_codes','devices','work_sessions','idle_intervals','activity_events','screenshots','invitations','notification_jobs','monitoring_rules','alerts','alert_cooldowns','report_runs','audit_logs','time_corrections','time_adjustments']){const docs=await db.collection(collection).where('companyId','==',companyId).get();for(const doc of docs.docs)await doc.ref.delete();}const company=db.collection('companies').doc(companyId);for(const doc of (await company.collection('settings').get()).docs)await doc.ref.delete();await company.delete();await db.collection('memberships').doc(companyId).delete();await auth.deleteUser(companyId);}
  console.log('Removed isolated browser-test account and records.');
}
