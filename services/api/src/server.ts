import {buildApp} from './app.js';
import {config} from './config.js';
const app=await buildApp(true);
await app.listen({port:config.PORT,host:config.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1'});
