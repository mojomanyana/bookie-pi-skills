import { memoryCandidateStore } from "./memory-candidate-store.mjs";
import {
  trustedBuilderGroups,
  trustedBuilderStages,
} from "../../scripts/qualification-labels.mjs";

export { trustedBuilderGroups };

const cases = {
  "token-rotation": `
let liveTokens=startup.tokens;
const rotating=await createTrustedLexicalBuilder({...startup,tokens:()=>liveTokens});
assert.equal((await rotating.preflight(request)).ok,true);
liveTokens=[];
assert.deepEqual(await rotating.preflight(request),{ok:false,reason:'auth-invalid'});
`,
  "forged-recipes": `
for(const forged of [{...recipe},structuredClone(recipe),{ok:true,sourceCommit:sourceRef,manifest:{}}])
 assert.deepEqual(await builder.build(forged),{ok:false,reason:'recipe-mismatch'});
`,
  "cross-builder-recipe": `
const other=await createTrustedLexicalBuilder(startup);
assert.deepEqual(await other.build(recipe),{ok:false,reason:'recipe-mismatch'});
`,
  "invalid-preflight-request": `
await assert.rejects(builder.preflight({...request,receipt:{ok:true}}),{name:'TypeError',message:'Trusted builder request is invalid.'});
`,
  "changed-configuration": `
for(const replacement of [
 {epoch:2,sources:[deployment]},
 {epoch:1,sources:[{...deployment,projection:{...deployment.projection,approvedSensitivityClasses:['public','internal']}}]},
 {epoch:1,sources:[{...deployment,approvedRef:'refs/heads/missing'}]},
]) {
 current=replacement;assert.deepEqual(await builder.build(recipe),{ok:false,reason:'configuration-changed'});
}
current={epoch:1,sources:[deployment]};
`,
  "path-drift": `
const path=process.env.PATH;
process.env.PATH='/tmp:/usr/bin';
assert.deepEqual(await builder.preflight(request),{ok:false,reason:'runtime-rejected'});
assert.deepEqual(await builder.build(recipe),{ok:false,reason:'runtime-rejected'});
process.env.PATH=path;
`,
  "input-recipe": `
assert.deepEqual(await transport(i=>{i.claimedRecipe={...i.claimedRecipe,serialized:i.claimedRecipe.serialized+' '};},()=>builder.build(recipe)),{ok:false,reason:'recipe-mismatch'});
`,
  "input-policy": `
assert.deepEqual(await transport(i=>{i.deployment.projection.approvedSensitivityClasses=['public','internal'];},()=>builder.build(recipe)),{ok:false,reason:'recipe-mismatch'});
`,
  "input-approval": `
assert.deepEqual(await transport(i=>{i.deployment.approvedRef='refs/heads/missing';},()=>builder.build(recipe)),{ok:false,reason:'source-not-approved'});
`,
  "input-runtime": `
assert.deepEqual(await transport(i=>{i.expectedRuntimeHash='sha256:'+'0'.repeat(64);},()=>builder.build(recipe)),{ok:false,reason:'runtime-rejected'});
`,
  "output-status": `
await rejectOutput(r=>{r.ok='PRIVATE_FORGED_RESULT'});
`,
  "output-canonical": `
await rejectOutput(r=>{r.projection.canonicalOutput.bytes++});
`,
  "output-concept": `
await rejectOutput(r=>{r.projection.concepts[0].title='PRIVATE_OUTPUT_TAMPER'});
`,
  "output-order": `
await rejectOutput(r=>{r.projection.chunks.reverse()});
`,
  "output-descriptor": `
await rejectOutput(r=>{r.outputDescriptor.hash='sha256:'+'0'.repeat(64)});
`,
  "preflight-configuration-race": `
assert.deepEqual(await transport((_i,child)=>child.prependOnceListener('message',()=>{current={epoch:2,sources:[deployment]}}),()=>builder.preflight(request)),{ok:false,reason:'configuration-changed'});
current={epoch:1,sources:[deployment]};
`,
  "build-configuration-race": `
assert.deepEqual(await transport((_i,child)=>child.prependOnceListener('message',()=>{current={epoch:2,sources:[deployment]}}),()=>builder.build(recipe)),{ok:false,reason:'configuration-changed'});
current={epoch:1,sources:[deployment]};
`,
  "epoch-reauthorization": `
current={epoch:2,sources:[deployment]};
const reauthorized=await builder.preflight(request);assert.equal(reauthorized.ok,true);
assert.equal(reauthorized.recipe.recipeHash,recipe.recipeHash);
assert.equal(reauthorized.recipe.configurationEpoch,2);
assert.deepEqual(await builder.build(recipe),{ok:false,reason:'configuration-changed'});
`,
  "preflight-deadline": `
assert.deepEqual(await builder.preflight({...request,timeoutMs:1}),{ok:false,reason:'deadline-exceeded'});
`,
  "pre-dispatch-abort": `
const cancelled=new AbortController();cancelled.abort('PRIVATE');
await assert.rejects(builder.build(recipe,{signal:cancelled.signal}),{name:'AbortError',message:'Ingestion cancelled.'});
`,
  "dispatched-abort": `
// Cancel only after dispatch to a real owned subprocess, never a fake receipt.
const active=new AbortController();let ownedPid;
cp.fork=(...args)=>{
 const child=fork(...args),send=child.send;ownedPid=child.pid;
 child.send=function(input,callback){return send.call(this,input,error=>{callback(error);if(!error)active.abort('PRIVATE')})};return child;
};syncBuiltinESMExports();
try {await assert.rejects(builder.build(reauthorized.recipe,{signal:active.signal}),{name:'AbortError',message:'Ingestion cancelled.'});}
finally {cp.fork=fork;syncBuiltinESMExports();}
try {const stat=await readFile('/proc/'+ownedPid+'/stat','utf8');assert.ok(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]));}
catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}
`,
  "operational-timeout": `
current={epoch:3,sources:[{...deployment,timeoutMs:1}]};
const bounded=await builder.preflight(request);assert.equal(bounded.ok,true);
assert.equal(bounded.recipe.recipeHash,recipe.recipeHash,'operational timeout is not recipe identity');
assert.deepEqual(await builder.build(bounded.recipe),{ok:false,reason:'deadline-exceeded'});
`,
};

/** Runs only in the actual immutable image: no synthetic source/runtime approval.
 * Every invocation starts its own builder and authenticated S5 preflight. Negative
 * groups omit the independent positive/reproducibility/legacy/controller work;
 * no recipe or provenance crosses an invocation. Keep groups below runRuntime's
 * normal 45-second cap rather than enlarging it for an aggregate workload.
 */
export function trustedBuilderDriver(fixture, options = {}) {
  const invalid = () => {
    throw new TypeError("Trusted builder fixture mode is invalid.");
  };
  if (options === null || typeof options !== "object" || Array.isArray(options))
    invalid();
  if (Reflect.ownKeys(options).some((key) => key !== "mode")) invalid();
  const selection = Object.getOwnPropertyDescriptor(options, "mode");
  if (selection && !Object.hasOwn(selection, "value")) invalid();
  const mode = selection === undefined ? "positive" : selection.value;
  if (
    typeof mode !== "string" ||
    (!Object.hasOwn(trustedBuilderGroups, mode) &&
      !["positive", "drift", "secret-policy", "invalid-vault"].includes(mode))
  )
    invalid();
  const group = Object.hasOwn(trustedBuilderGroups, mode)
    ? trustedBuilderGroups[mode]
    : undefined;
  if (group?.some((name) => !Object.hasOwn(cases, name))) invalid();
  return `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {exportCanonicalJsonl} from '/opt/bookie/node_modules/pi-bookie-core/dist/index.js';
import {createTrustedLexicalBuilder} from '/opt/bookie/apps/service/dist/trusted-builder.js';
import {prepareDeploymentLexicalProjection} from '/opt/bookie/apps/service/dist/ingestion.js';
import {createOwnedRebuildController} from '/opt/bookie/apps/service/dist/rebuild-controller.js';
import {CandidateStoreError} from '/opt/bookie/apps/service/dist/redis-candidate-store.js';
import {parseOutputDescriptor} from '/opt/bookie/apps/service/dist/output-descriptor.js';
const allowedStages=${JSON.stringify(trustedBuilderStages)};
function stage(name) {assert.ok(allowedStages.includes(name));console.error('QUALIFICATION trusted-builder stage='+name)}
const deployment=${JSON.stringify(fixture.config)};
const sourceRef=${JSON.stringify(fixture.commit)};
const h=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const secret='x'.repeat(43),authorization='Bearer bka_admin_'+secret;
let current={epoch:1,sources:[deployment]};
const startup={
 runtimeIdentityFile:'/run/bookie-expected-runtime',
 tokens:[{id:'admin',digest:createHash('sha256').update(secret).digest('hex'),principal:'fixture',
 not_before:'2020-01-01T00:00:00Z',expires_at:'2100-01-01T00:00:00Z',grants:[{vault:'demo',scopes:['rebuild:create']}]}],
 configuration:()=>current,
};
stage('startup');
const builder=await createTrustedLexicalBuilder(startup);
const request={authorization,vault:'demo',sourceRef,timeoutMs:7000};
const cp=createRequire(import.meta.url)('node:child_process');
const fork=cp.fork;
let dispatched=0;
cp.fork=(...args)=>{dispatched++;return fork(...args)};syncBuiltinESMExports();
for(const patch of [{authorization:undefined},{authorization:'PRIVATE'},{vault:'foreign'}]) {
 const result=await builder.preflight({...request,...patch});
 assert.equal(result.ok,false);assert.ok(['auth-invalid','auth-forbidden'].includes(result.reason));
}
assert.equal(dispatched,0,'authorization precedes Git/process lookup');
cp.fork=fork;syncBuiltinESMExports();
stage('authorized-preflight');
const preflight=await builder.preflight(request);assert.equal(preflight.ok,true,JSON.stringify(preflight));
const recipe=preflight.recipe;
assert.ok(Object.isFrozen(recipe));assert.equal(recipe.configurationEpoch,1);
const tuple=JSON.parse(recipe.serialized);
assert.equal(tuple[3],sourceRef.length===40?'sha1':'sha256');assert.equal(tuple[4],sourceRef);
const expected=(await readFile('/run/bookie-expected-runtime','utf8')).trim();
assert.equal(tuple[15],expected);
${
  group
    ? `
async function transport(mutate,action) {
 let dispatched=false;
 cp.fork=(...args)=>{
  const child=fork(...args),send=child.send;
  child.send=function(input,...rest){input=structuredClone(input);mutate(input,child);dispatched=true;return send.call(this,input,...rest)};
  return child;
 };syncBuiltinESMExports();
 try {const result=await action();assert.equal(dispatched,true,'A real worker must receive the transport mutation.');return result} finally {cp.fork=fork;syncBuiltinESMExports()}
}
async function rejectOutput(tamper) {
 let received=false;
 const result=await transport((_i,child)=>child.prependOnceListener('message',r=>{if(r.ok){received=true;tamper(r)}}),()=>builder.build(recipe));
 assert.equal(received,true,'Genuine complete worker output must arrive before tampering.');
 assert.deepEqual(result,{ok:false,reason:'ingestion-error'});
}
${group.map((name) => `stage('${name}');\n${cases[name]}`).join("\n")}
console.log(JSON.stringify({ok:true}));
`
    : mode === "secret-policy" || mode === "invalid-vault"
      ? `
stage('${mode}');
assert.deepEqual(await builder.build(recipe),{ok:false,reason:${JSON.stringify(mode)}});
console.log(JSON.stringify({ok:true,rejected:${JSON.stringify(mode)}}));
`
      : mode === "drift"
        ? `
stage('drift');
await writeFile('/signals/preflight-done','ready');
while(true) {try {await readFile('/signals/continue');break;} catch(e) {if(e.code!=='ENOENT')throw e;await new Promise(r=>setTimeout(r,10));}}
const rejected=await builder.build(recipe);
assert.deepEqual(rejected,{ok:false,reason:'source-not-approved'});
console.log(JSON.stringify({ok:true,rejected:'source-not-approved'}));
`
        : `
stage('positive-build-first');
const first=await builder.build(recipe);assert.equal(first.ok,true,JSON.stringify(first));
stage('positive-build-second');
const second=await builder.build(recipe);assert.equal(second.ok,true,JSON.stringify(second));
assert.deepEqual(first,second);
const out=first.output;
assert.ok(Object.isFrozen(out));assert.ok(Object.isFrozen(out.concepts));
if(out.concepts.length)assert.ok(Object.isFrozen(out.concepts[0].tags));
assert.equal(Object.hasOwn(out,'projection'),false);
stage('legacy-projection');
const legacy=await prepareDeploymentLexicalProjection(deployment,{sourceRef});assert.equal(legacy.ok,true);
assert.notEqual(recipe.buildId,legacy.projection.buildId,'legacy output ID is never relabelled');
assert.deepEqual(out.concepts,legacy.projection.concepts);assert.deepEqual(out.chunks,legacy.projection.chunks);
stage('canonical-export');
const canonical=[];
const exported=await exportCanonicalJsonl(deployment.root,{sourceRef,write:line=>canonical.push(Buffer.from(line))});assert.equal(exported.ok,true);
const bytes=Buffer.concat(canonical);
const descriptor=JSON.parse(out.outputDescriptor.serialized);
assert.deepEqual(descriptor,[
 'bookie-build-output',1,recipe.recipeHash,h(bytes),bytes.length,canonical.length,out.concepts.length,
 h(out.concepts.map(r=>JSON.stringify(r)+'\\n').join('')),out.chunks.length,h(out.chunks.map(r=>JSON.stringify(r)+'\\n').join('')),
]);
assert.equal(out.outputDescriptor.hash,h(out.outputDescriptor.serialized));
for(const canary of ['EXCLUDED_QUALIFICATION_MARKER','DOC-00000000000000000000000009','/excluded-qualification.md','-----BEGIN PRIVATE KEY-----'])assert.equal(JSON.stringify(out).includes(canary),false);
stage('controller-composition');
// Genuine qualified S5 source/recipe/output through the S7 component. Only the
// S6 component is fake here; real Lua lifecycle is separately tested with Redis.
const MemoryCandidateStore=(${memoryCandidateStore.toString()})(CandidateStoreError,parseOutputDescriptor);
const candidate=new MemoryCandidateStore(deployment.projection.vaultUid);
let attached;
const attachment=new Promise(resolve=>{attached=resolve});
candidate.reply=async(op,value)=>{if(op==='attach')attached();return value};
const controller=await createOwnedRebuildController({configuration:{...current,tokens:startup.tokens},runtimeIdentityFile:startup.runtimeIdentityFile,stores:new Map([['demo',candidate]]),confirmPreviousWorkersStopped:async()=>{assert.equal(candidate.jobs.size,0)}});
try {
 const job=await controller.submit({authorization,vault:'demo',sourceRef});
 let bound;
 try {await Promise.race([attachment,new Promise((_,reject)=>{bound=setTimeout(()=>reject(new Error('Controller attachment did not settle.')),15000)})])} finally {clearTimeout(bound)}
 assert.equal(candidate.manifests.get(job.jobId).outputDescriptor.serialized,out.outputDescriptor.serialized);
 const duplicate=await controller.submit({authorization,vault:'demo',sourceRef});
 assert.equal(duplicate.jobId,job.jobId);
 assert.equal(candidate.calls.filter(op=>op==='claim').length,1);
 assert.equal(candidate.jobs.get(job.jobId).state,'building');
} finally {await controller.shutdown()}
console.log(JSON.stringify({ok:true,recipe:recipe.recipeHash,output:out.outputDescriptor.hash,canonical:h(bytes),concepts:out.concepts.length,chunks:out.chunks.length}));
`
}
`;
}
