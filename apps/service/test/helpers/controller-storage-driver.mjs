import { socketExecutor } from "./redis-socket.mjs";

/** Genuine protected S5 -> owned controller -> real Redis -> real verifier.
 * Producer control and measured storage are independent; no fixture provenance
 * or success/verification stub enters the controller. Modes are separate 45s runs.
 */
export function controllerStorageDriver(fixture, mode = "positive") {
  if (!["positive", "tamper"].includes(mode))
    throw TypeError("Controller storage fixture mode is invalid.");
  return `
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {createHash} from 'node:crypto';
import {createTrustedLexicalBuilder} from '/opt/bookie/apps/service/dist/trusted-builder.js';
import {createOwnedRebuildController} from '/opt/bookie/apps/service/dist/rebuild-controller.js';
import {RedisCandidateStore} from '/opt/bookie/apps/service/dist/redis-candidate-store.js';
const transport=(${socketExecutor.toString()})(connect,'/redis-fixture/redis.sock');
const deployment=${JSON.stringify(fixture.config)}, sourceRef=${JSON.stringify(fixture.commit)};
const secret='x'.repeat(43), authorization='Bearer bka_admin_'+secret;
const configuration={epoch:1,sources:[deployment],tokens:[{id:'admin',digest:createHash('sha256').update(secret).digest('hex'),principal:'fixture',not_before:'2020-01-01T00:00:00Z',expires_at:'2100-01-01T00:00:00Z',grants:[{vault:'demo',scopes:['rebuild:create','rebuild:read','rebuild:cancel']}]}]};
console.error('QUALIFICATION trusted-builder stage=controller-storage-startup');
// Actual pinned native framing controls, not redis-cli/stdout or a mock socket.
assert.deepEqual(await transport.execute(['EVAL','return {1,2}','0']),[1,2]);
for(const script of ["return string.char(255)","return string.rep('x',6291457)"]) await assert.rejects(transport.execute(['EVAL',script,'0']),{message:'Redis fixture transport failed.'});
const abort=new AbortController();let sent=false;
const aborting=(${socketExecutor.toString()})(options=>{const socket=connect(options),write=socket.write;socket.write=function(...args){sent=true;const value=write.apply(this,args);queueMicrotask(()=>abort.abort());return value};return socket},'/redis-fixture/redis.sock');
try{await assert.rejects(aborting.execute(['PING'],abort.signal),{message:'Redis fixture transport failed.'});assert.equal(sent,true)}finally{await aborting.close()}
assert.equal(await transport.execute(['PING']),'PONG');
const builder=await createTrustedLexicalBuilder({runtimeIdentityFile:'/run/bookie-expected-runtime',tokens:configuration.tokens,configuration:()=>({epoch:1,sources:[deployment]})});
const prepared=await builder.preflight({authorization,vault:'demo',sourceRef,timeoutMs:7000}); assert.equal(prepared.ok,true);
console.error('QUALIFICATION trusted-builder stage=controller-storage-producer');
const produced=await builder.build(prepared.recipe); assert.equal(produced.ok,true,produced.reason);
const original=produced.output;
const commands=[];
let tampered=false, pages=0, inventory=0, final=0;
const store=new RedisCandidateStore({vaultUid:deployment.projection.vaultUid,namespaceKey:new Uint8Array(32).fill(8),execute:async(args,signal)=>{
 const request=JSON.parse(args.at(-1)); commands.push(request.op);
 if(request.op==='storedPage') {
  pages++;
  ${mode === "tamper" ? `if(!tampered){tampered=true;await transport.execute(['JSON.SET',store.namespace+'build:'+prepared.recipe.buildId+':concept:0','.title',JSON.stringify('STORAGE_ONLY_TAMPER')],signal)}` : ""}
 }
 if(request.op==='storedInventory') inventory++;
 if(request.op==='storedFinish') final++;
 return await transport.execute(args,signal);
}});
let claimRecipe,claimLease,attached,verifySignal,verification,verificationError;
const claim=store.claimInput.bind(store),attach=store.attachOutput.bind(store),append=store.append.bind(store),verify=store.verifyStoredOutput.bind(store),cleanup=store.cleanup.bind(store);
store.claimInput=async(recipe,...rest)=>{claimRecipe=recipe;const result=await claim(recipe,...rest);claimLease=result.lease;return result};
store.attachOutput=async(lease,descriptor,signal)=>{assert.equal(lease,claimLease);attached=descriptor;return await attach(lease,descriptor,signal)};
store.append=async(lease,kind,offset,records,signal)=>{assert.equal(lease,claimLease);assert.ok(records.length>0&&records.length<=128);assert.ok(records.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0)<=1048576);return await append(lease,kind,offset,records,signal)};
let verified,retired;
const observed=new Promise(resolve=>{verified=resolve}),cleaned=new Promise(resolve=>{retired=resolve});
store.verifyStoredOutput=async(lease,recipe,descriptor,options)=>{
 assert.equal(lease,claimLease);assert.equal(recipe,claimRecipe);assert.equal(descriptor,attached);verifySignal=options.signal;
 assert.ok(Number.isInteger(options.timeoutMs)&&options.timeoutMs>0&&options.timeoutMs<=21600000);
 try{verification=await verify(lease,recipe,descriptor,options);return verification}
 catch(error){verificationError=error;throw error}
 finally{verified()}
};
store.cleanup=async(...args)=>{const result=await cleanup(...args);if(result.done)retired();return result};
const controller=await createOwnedRebuildController({runtimeIdentityFile:'/run/bookie-expected-runtime',configuration,stores:new Map([['demo',store]]),confirmPreviousWorkersStopped:async()=>{}});
const bounded=async(pending)=>{let timer;try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Controller storage fixture stalled.')),15000)})])}finally{clearTimeout(timer)}};
try {
 console.error('QUALIFICATION trusted-builder stage=controller-storage-submit');
 const job=await controller.submit({authorization,vault:'demo',sourceRef});
 await bounded(observed);
 console.error('QUALIFICATION trusted-builder stage=controller-storage-measured');
 assert.equal(claimRecipe.serialized,prepared.recipe.serialized);assert.deepEqual(attached,original.outputDescriptor);
 assert.ok(verifySignal instanceof AbortSignal);
 assert.ok(commands.indexOf('attach')<commands.indexOf(original.concepts.length?'append':'storedInventory'));
 ${
   mode === "tamper"
     ? `
 assert.equal(tampered,true);assert.equal(verification,undefined);assert.equal(verificationError?.code,'INDEX_UNAVAILABLE');
 await bounded(cleaned);
 assert.equal((await store.readJob(job.jobId)).failureCode,'DEPENDENCY_FAILED');
 assert.equal(await transport.execute(['EXISTS',store.namespace+'build:'+job.buildId+':concept:0']),0);
 `
     : `
 assert.equal(verificationError,undefined);assert.equal(verification.descriptorHash,original.outputDescriptor.hash);
 const d=JSON.parse(original.outputDescriptor.serialized);
 assert.deepEqual(verification.concepts,{count:original.concepts.length,hash:d[7]});
 assert.deepEqual(verification.chunks,{count:original.chunks.length,hash:d[9]});
 for(const [kind,rows] of [['concept',original.concepts],['chunk',original.chunks]]) for(const [i,row] of rows.entries()) {
  const raw=await transport.execute(['JSON.GET',store.namespace+'build:'+job.buildId+':'+kind+':'+i]);
  assert.equal(JSON.stringify(JSON.parse(raw)),JSON.stringify(row));
 }
 assert.ok(inventory>0);assert.equal(final,1);
 assert.equal((await store.readJob(job.jobId)).state,'building');
 const duplicate=await controller.submit({authorization,vault:'demo',sourceRef});assert.equal(duplicate.jobId,job.jobId);
 assert.equal(commands.filter(op=>op==='claimInput').length,1);
 assert.equal(commands.filter(op=>op==='storedFinish').length,1);
 `
 }
 console.error('QUALIFICATION trusted-builder stage=controller-storage-assertions');
 const control=JSON.stringify(await transport.execute(['HGETALL',store.namespace+'job:'+job.jobId]));
 for(const canary of ['EXCLUDED_QUALIFICATION_MARKER','DOC-00000000000000000000000009','/excluded-qualification.md','-----BEGIN PRIVATE KEY-----']) {assert.equal(JSON.stringify(original).includes(canary),false);assert.equal(control.includes(canary),false)}
 console.log(JSON.stringify({ok:true,mode:${JSON.stringify(mode)},concepts:original.concepts.length,chunks:original.chunks.length,pages,inventory,final,recipe:claimRecipe.recipeHash,descriptor:attached.hash}));
} finally {await controller.shutdown();await transport.close()}
`;
}
