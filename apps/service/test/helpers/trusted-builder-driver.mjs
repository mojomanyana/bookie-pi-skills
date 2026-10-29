/** Runs only in the actual immutable image: no synthetic source/runtime approval. */
export function trustedBuilderDriver(
  fixture,
  { adversarial = false, drift = false, failure } = {},
) {
  return `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {exportCanonicalJsonl} from '/opt/bookie/node_modules/@bookie/core/dist/index.js';
import {createTrustedLexicalBuilder} from '/opt/bookie/apps/service/dist/trusted-builder.js';
import {prepareDeploymentLexicalProjection} from '/opt/bookie/apps/service/dist/ingestion.js';
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
const preflight=await builder.preflight(request);assert.equal(preflight.ok,true,JSON.stringify(preflight));
const recipe=preflight.recipe;
assert.ok(Object.isFrozen(recipe));assert.equal(recipe.configurationEpoch,1);
const tuple=JSON.parse(recipe.serialized);
assert.equal(tuple[3],sourceRef.length===40?'sha1':'sha256');assert.equal(tuple[4],sourceRef);
const expected=(await readFile('/run/bookie-expected-runtime','utf8')).trim();
assert.equal(tuple[15],expected);
${
  failure
    ? `
assert.deepEqual(await builder.build(recipe),{ok:false,reason:${JSON.stringify(failure)}});
console.log(JSON.stringify({ok:true,rejected:${JSON.stringify(failure)}}));
`
    : drift
      ? `
await writeFile('/signals/preflight-done','ready');
while(true) {try {await readFile('/signals/continue');break;} catch(e) {if(e.code!=='ENOENT')throw e;await new Promise(r=>setTimeout(r,10));}}
const rejected=await builder.build(recipe);
assert.deepEqual(rejected,{ok:false,reason:'source-not-approved'});
console.log(JSON.stringify({ok:true,rejected:'source-not-approved'}));
`
      : `
const first=await builder.build(recipe);assert.equal(first.ok,true,JSON.stringify(first));
const second=await builder.build(recipe);assert.equal(second.ok,true,JSON.stringify(second));
assert.deepEqual(first,second);
const out=first.output;
assert.ok(Object.isFrozen(out));assert.ok(Object.isFrozen(out.concepts));
if(out.concepts.length)assert.ok(Object.isFrozen(out.concepts[0].tags));
assert.equal(Object.hasOwn(out,'projection'),false);
const legacy=await prepareDeploymentLexicalProjection(deployment,{sourceRef});assert.equal(legacy.ok,true);
assert.notEqual(recipe.buildId,legacy.projection.buildId,'legacy output ID is never relabelled');
assert.deepEqual(out.concepts,legacy.projection.concepts);assert.deepEqual(out.chunks,legacy.projection.chunks);
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
${
  adversarial
    ? `
for(const forged of [{...recipe},structuredClone(recipe),{ok:true,sourceCommit:sourceRef,manifest:{}}])
 assert.deepEqual(await builder.build(forged),{ok:false,reason:'recipe-mismatch'});
const other=await createTrustedLexicalBuilder(startup);
assert.deepEqual(await other.build(recipe),{ok:false,reason:'recipe-mismatch'});
await assert.rejects(builder.preflight({...request,receipt:{ok:true}}),{name:'TypeError',message:'Trusted builder request is invalid.'});
for(const replacement of [
 {epoch:2,sources:[deployment]},
 {epoch:1,sources:[{...deployment,projection:{...deployment.projection,approvedSensitivityClasses:['public','internal']}}]},
 {epoch:1,sources:[{...deployment,approvedRef:'refs/heads/missing'}]},
]) {
 current=replacement;assert.deepEqual(await builder.build(recipe),{ok:false,reason:'configuration-changed'});
}
current={epoch:1,sources:[deployment]};
const path=process.env.PATH;
process.env.PATH='/tmp:/usr/bin';
assert.deepEqual(await builder.preflight(request),{ok:false,reason:'runtime-rejected'});
assert.deepEqual(await builder.build(recipe),{ok:false,reason:'runtime-rejected'});
process.env.PATH=path;
async function transport(mutate,action) {
 cp.fork=(...args)=>{
  const child=fork(...args),send=child.send;
  child.send=function(input,...rest){input=structuredClone(input);mutate(input,child);return send.call(this,input,...rest)};
  return child;
 };syncBuiltinESMExports();
 try {return await action()} finally {cp.fork=fork;syncBuiltinESMExports()}
}
for(const [mutate,reason] of [
 [i=>{i.claimedRecipe={...i.claimedRecipe,serialized:i.claimedRecipe.serialized+' '};},'recipe-mismatch'],
 [i=>{i.deployment.projection.approvedSensitivityClasses=['public','internal'];},'recipe-mismatch'],
 [i=>{i.deployment.approvedRef='refs/heads/missing';},'source-not-approved'],
 [i=>{i.expectedRuntimeHash='sha256:'+'0'.repeat(64);},'runtime-rejected'],
])assert.deepEqual(await transport(mutate,()=>builder.build(recipe)),{ok:false,reason});
for(const tamper of [
 r=>{r.ok='PRIVATE_FORGED_RESULT';},
 r=>{r.projection.canonicalOutput.bytes++;},
 r=>{r.projection.concepts[0].title='PRIVATE_OUTPUT_TAMPER';},
 r=>{r.projection.chunks.reverse();},
 r=>{r.outputDescriptor.hash='sha256:'+'0'.repeat(64);},
])assert.deepEqual(await transport((_i,child)=>child.prependOnceListener('message',r=>{if(r.ok)tamper(r)}),()=>builder.build(recipe)),{ok:false,reason:'ingestion-error'});
for(const action of [()=>builder.preflight(request),()=>builder.build(recipe)]) {
 current={epoch:1,sources:[deployment]};
 const result=await transport((_i,child)=>child.prependOnceListener('message',()=>{current={epoch:2,sources:[deployment]}}),action);
 assert.deepEqual(result,{ok:false,reason:'configuration-changed'});
}
current={epoch:2,sources:[deployment]};
const reauthorized=await builder.preflight(request);assert.equal(reauthorized.ok,true);
assert.equal(reauthorized.recipe.recipeHash,recipe.recipeHash);
assert.equal(reauthorized.recipe.configurationEpoch,2);
assert.deepEqual(await builder.build(recipe),{ok:false,reason:'configuration-changed'});
assert.deepEqual(await builder.preflight({...request,timeoutMs:1}),{ok:false,reason:'deadline-exceeded'});
const cancelled=new AbortController();cancelled.abort('PRIVATE');
await assert.rejects(builder.build(recipe,{signal:cancelled.signal}),{name:'AbortError',message:'Ingestion cancelled.'});
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
current={epoch:3,sources:[{...deployment,timeoutMs:1}]};
const bounded=await builder.preflight(request);assert.equal(bounded.ok,true);
assert.equal(bounded.recipe.recipeHash,recipe.recipeHash,'operational timeout is not recipe identity');
assert.deepEqual(await builder.build(bounded.recipe),{ok:false,reason:'deadline-exceeded'});
`
    : ""
}
console.log(JSON.stringify({ok:true,recipe:recipe.recipeHash,output:out.outputDescriptor.hash,canonical:h(bytes),concepts:out.concepts.length,chunks:out.chunks.length}));
`
}
`;
}
