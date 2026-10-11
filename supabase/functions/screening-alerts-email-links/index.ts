import {createEmailHandler} from '../_shared/screeningAlertsEmail.ts';
declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
Deno.serve(createEmailHandler('links',{env:name=>Deno.env.get(name)}));
