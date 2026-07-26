import {runImporter} from "./import-common.ts";
Deno.serve(req=>runImporter(req,"southbank",20));
