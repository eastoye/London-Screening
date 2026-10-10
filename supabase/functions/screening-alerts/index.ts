import {createStage1Handler} from '../_shared/screeningAlertsStage1.ts';
declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
Deno.serve(createStage1Handler('api',{env:name=>Deno.env.get(name)}));
