
import { it, expect } from "vitest";
import { ZcodeAcpServer } from "../src/server.js";
it("clears active identity on backend generation reset", () => {
 const s = new ZcodeAcpServer(); s.currentModelIdentity.set("s", {providerId:"old",modelId:"old"});
 s.resetBackendGeneration(); expect(s.currentModelIdentity.has("s")).toBe(false);
});

it("ignores malformed reasoning levels instead of throwing", async () => {
 const {cacheModelAvailability} = await import("../src/handlers/session.js");
 const s = new ZcodeAcpServer();
 expect(() => cacheModelAvailability(s,"s",{settings:{model:{available:[{ref:{providerId:"a",modelId:"x"},reasoning:{levels:{bad:true}}}]}}})).not.toThrow();
 expect(s.modelAvailability.get("s")?.[0]?.levels).toEqual([]);
});

it("allows backend to validate a selection absent from a stale or empty snapshot", async () => {
 const {applyModelSwitch} = await import("../src/config/runtime-model.js");
 const s = new ZcodeAcpServer(); s.modelAvailability.set("s", []);
 let calls=0; s.backend={isDead:false,request:async()=>{calls++;return {result:{}}}} as never;
 expect(await applyModelSwitch(s,"s","custom:a\\new")).toBe(true); expect(calls).toBe(1);
});

it("keeps distinct account provider identities even when legacy aliases collide", async () => {
 const {buildConfigOptions} = await import("../src/config/options.js");
 const {applyModelSwitch} = await import("../src/config/runtime-model.js");
 const s = new ZcodeAcpServer();
 const team="account:unknown-team-coding-plan", individual="account:unknown-individual-coding-plan";
 s.modelAvailability.set("s",[{providerId:team,modelId:"same"},{providerId:individual,modelId:"same"}]);
 let selected="";
 s.backend={isDead:false,request:async (_:unknown,method:string,p:any)=>method === "session/read" ? {result:{settings:{model:{current:{providerId:team,modelId:"same"}}}}} : (selected=p.model.providerId,{result:{}})} as never;
 const model=(await buildConfigOptions(s,"s")).find(o=>o.id === "model")!;
 expect(model.options.map(o=>o.value)).toEqual([team+"\\same",individual+"\\same"]);
 expect(model.currentValue).toBe(team+"\\same");
 expect(await applyModelSwitch(s,"s",individual+"\\same")).toBe(true);
 expect(selected).toBe(individual);
});

it("does not resurrect old identity when a read completes after generation reset", async () => {
 const {buildConfigOptions} = await import("../src/config/options.js");
 const s = new ZcodeAcpServer(); let release!: (v:unknown)=>void;
 s.backend={isDead:false,request:()=>new Promise(r=>{release=r})} as never;
 const pending=buildConfigOptions(s,"s"); await Promise.resolve(); await Promise.resolve();
 s.resetBackendGeneration(); release({result:{settings:{model:{current:{providerId:"old",modelId:"old"}}}}});
 await pending; expect(s.currentModelIdentity.has("s")).toBe(false);
});

it("does not cache a switch response from an old generation", async () => {
 const {applyModelSwitch} = await import("../src/config/runtime-model.js");
 const s=new ZcodeAcpServer(); let release!: (v:unknown)=>void;
 s.backend={isDead:false,request:()=>new Promise(r=>{release=r})} as never;
 const pending=applyModelSwitch(s,"s","custom:a\\x"); await Promise.resolve(); await Promise.resolve();
 s.resetBackendGeneration(); release({result:{}});
 expect(await pending).toBe(false); expect(s.currentModelIdentity.has("s")).toBe(false);
});

it("does not retain an empty catalog as authoritative", async () => {
 const {cacheModelAvailability} = await import("../src/handlers/session.js");
 const s=new ZcodeAcpServer(); s.modelAvailability.set("s",[{providerId:"old",modelId:"old"}]);
 cacheModelAvailability(s,"s",{settings:{model:{available:[]}}});
 expect(s.modelAvailability.has("s")).toBe(false);
});

it("does not let an earlier read overwrite a later successful switch", async () => {
 const {buildConfigOptions}=await import("../src/config/options.js");
 const {applyModelSwitch}=await import("../src/config/runtime-model.js");
 const s=new ZcodeAcpServer(); let release!: (v:unknown)=>void;
 s.backend={isDead:false,request:(_id:unknown,method:string)=>method === "session/read" ? new Promise(r=>{release=r}) : Promise.resolve({result:{}})} as never;
 const read=buildConfigOptions(s,"s"); await Promise.resolve(); await Promise.resolve();
 expect(await applyModelSwitch(s,"s","custom:a\\new")).toBe(true);
 release({result:{settings:{model:{current:{providerId:"custom:a",modelId:"old"}}}}});
 await read; expect(s.currentModelIdentity.get("s")?.modelId).toBe("new");
});
