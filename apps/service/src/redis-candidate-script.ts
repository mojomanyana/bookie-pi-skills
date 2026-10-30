/** Standalone Redis 8 only. All key names are derived from one validated namespace. */
export const candidateScript = String.raw`
local function fail(code) return {ok=false, code=code} end
local function integer(n, lo, hi) return type(n)=='number' and n==math.floor(n) and n>=lo and n<=hi end
local function hex(s, prefix, size)
  return type(s)=='string' and #s==#prefix+size and string.sub(s,1,#prefix)==prefix and string.match(string.sub(s,#prefix+1),'^[0-9a-f]+$')~=nil
end
local function jobid(s) return type(s)=='string' and #s==30 and string.match(s,'^job_[0-9A-HJKMNP-TV-Z]+$')~=nil end
local function buildid(s) return hex(s,'bld_',64) end
local function commit(s) return hex(s,'',40) or hex(s,'',64) end
local function kind(key, expected)
  local actual=redis.call('TYPE',key).ok
  return actual=='none' or actual==expected
end
local function fields(key)
  local a=redis.call('HGETALL',key); local result={}
  for i=1,#a,2 do result[a[i]]=a[i+1] end
  return result
end
local function decimal(n) return n==0 and '0' or string.format('%.0f',n) end
local function number(s, maximum)
  local n=tonumber(s)
  if not integer(n,0,maximum) or type(s)~='string' or s~=decimal(n) then error('invalid state') end
  return n
end
-- Configuration epochs are canonical decimal strings, never Lua/cjson numbers.
-- cjson's numeric re-encoding loses precision before S5's maximum safe integer.
local function configuration(s)
  return type(s)=='string' and string.match(s,'^[1-9][0-9]*$')~=nil and (#s<16 or (#s==16 and s<='9007199254740991'))
end
local function closed(t, names)
  local allowed={}; for _,name in ipairs(names) do allowed[name]=true end
  local count=0; for name,_ in pairs(t) do if not allowed[name] then error('invalid fields') end; count=count+1 end
  if count~=#names then error('invalid fields') end
end
local empty='sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
local function descriptor(raw)
  if type(raw)~='string' or #raw>1024 then error('invalid output') end
  local d=cjson.decode(raw)
  if type(d)~='table' then error('invalid output') end
  closed(d,{1,2,3,4,5,6,7,8,9,10})
  if d[1]~='bookie-build-output' or d[2]~=1 or not hex(d[3],'sha256:',64) or not hex(d[4],'sha256:',64) or not hex(d[8],'sha256:',64) or not hex(d[10],'sha256:',64) or not integer(d[5],0,536870912) or not integer(d[6],0,50000) or not integer(d[7],0,50000) or not integer(d[9],0,250000) or d[6]~=d[7] then error('invalid output') end
  if (d[6]==0 and (d[5]~=0 or d[4]~=empty or d[9]~=0)) or (d[6]>0 and (d[5]==0 or d[4]==empty)) or (d[7]==0 and d[8]~=empty) or (d[7]>0 and d[8]==empty) or (d[9]==0 and d[10]~=empty) or (d[9]>0 and d[10]==empty) then error('invalid output') end
  local canonical='["bookie-build-output",1,"'..d[3]..'","'..d[4]..'",'..decimal(d[5])..','..decimal(d[6])..','..decimal(d[7])..',"'..d[8]..'",'..decimal(d[9])..',"'..d[10]..'"]'
  if raw~=canonical then error('invalid output') end
  return d
end
local terminal={complete=true,failed=true,cancelled=true}
local states={queued=true,building=true,verifying=true,evaluating=true,complete=true,failed=true,cancelling=true,cancelled=true}
local failures={INVALID_COMMIT=true,VALIDATION_FAILED=true,SECRET_DETECTED=true,POLICY_REJECTED=true,LIMIT_EXCEEDED=true,DEPENDENCY_FAILED=true,EVALUATION_FAILED=true,INTERRUPTED=true,INTERNAL=true}
local function run()
  if #KEYS~=1 or #ARGV~=1 or #KEYS[1]~=73 or not string.match(KEYS[1],'^bk:v1:v:[0-9a-f]+:$') then return fail('INDEX_UNAVAILABLE') end
  local p=KEYS[1]
  local r=cjson.decode(ARGV[1])
  if type(r)~='table' or type(r.op)~='string' then return fail('INDEX_UNAVAILABLE') end
  local control=p..'control'; local lock=p..'lock:rebuild'
  if not kind(control,'hash') or not kind(lock,'string') or not kind(p..'active','string') or not kind(p..'previous','string') then return fail('INDEX_UNAVAILABLE') end
  local active=redis.call('GET',p..'active'); local previous=redis.call('GET',p..'previous')
  if (active and not buildid(active)) or (previous and not buildid(previous)) then return fail('INDEX_UNAVAILABLE') end
  local c=fields(control)
  for name,_ in pairs(c) do if name~='epoch' and name~='fence' and name~='currentJob' and name~='configurationEpoch' then return fail('INDEX_UNAVAILABLE') end end
  if c.configurationEpoch~=nil and not configuration(c.configurationEpoch) then return fail('INDEX_UNAVAILABLE') end
  local epoch=number(c.epoch or '0',2147483647)
  local fence=number(c.fence or '0',2147483647)
  if c.currentJob and not jobid(c.currentJob) then return fail('INDEX_UNAVAILABLE') end
  local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
  local function load(id)
    if not jobid(id) then error('invalid job') end
    local key=p..'job:'..id
    if not kind(key,'hash') then error('invalid job') end
    if redis.call('EXISTS',key)==0 then return nil end
    local j=fields(key)
    if j.manifestVersion~=nil then
      closed(j,{'manifestVersion','configurationEpoch','buildId','sourceCommit','state','ownerEpoch','fence','failureCode'})
      if j.manifestVersion~='2' or not configuration(j.configurationEpoch) then error('invalid job version') end
    else closed(j,{'buildId','sourceCommit','state','ownerEpoch','fence','failureCode'}) end
    if not buildid(j.buildId) or not commit(j.sourceCommit) or not states[j.state] then error('invalid job') end
    j.ownerEpoch=number(j.ownerEpoch,2147483647); j.fence=number(j.fence,2147483647)
    if j.ownerEpoch<1 or j.fence<1 or j.failureCode==nil then error('invalid job') end
    if j.state=='failed' and not failures[j.failureCode] then error('invalid failure') end
    if j.state=='cancelled' and j.failureCode~='CANCELLED' then error('invalid failure') end
    if (not terminal[j.state] or j.state=='complete') and j.failureCode~='' then error('invalid failure') end
    j.jobId=id
    return j
  end
  local function manifest(j)
    local key=p..'build:'..j.buildId..':manifest'
    if not kind(key,'hash') then error('invalid manifest') end
    if redis.call('EXISTS',key)==0 then return nil end
    local m=fields(key)
    if m.jobId~=j.jobId or m.state~=j.state or m.sourceCommit~=j.sourceCommit or not hex(m.manifestHash,'sha256:',64) or not hex(m.policyHash,'sha256:',64) then error('invalid manifest') end
    if j.manifestVersion=='2' then
      local names={'manifestVersion','jobId','sourceCommit','manifestHash','policyHash','recipeHash','configurationEpoch','ownerEpoch','fence','state','nextConcept','nextChunk','cleanupConcept','cleanupChunk'}
      if m.outputDescriptor~=nil then names[#names+1]='outputDescriptor' end
      closed(m,names)
      if m.manifestVersion~='2' or m.configurationEpoch~=j.configurationEpoch or number(m.ownerEpoch,2147483647)~=j.ownerEpoch or number(m.fence,2147483647)~=j.fence or not hex(m.recipeHash,'sha256:',64) or j.buildId~='bld_'..string.sub(m.recipeHash,8) then error('invalid manifest ownership') end
      m.v2=true
      if m.outputDescriptor~=nil then
        local d=descriptor(m.outputDescriptor)
        if d[3]~=m.recipeHash or j.state=='queued' then error('invalid output phase') end
        m.concepts=d[7]; m.chunks=d[9]
      else
        if j.state=='verifying' or j.state=='evaluating' or j.state=='complete' then error('invalid input phase') end
        m.concepts=0; m.chunks=0
      end
    else
      closed(m,{'jobId','sourceCommit','manifestHash','policyHash','state','concepts','chunks','nextConcept','nextChunk','cleanupConcept','cleanupChunk'})
      m.concepts=number(m.concepts,50000); m.chunks=number(m.chunks,250000)
    end
    m.nextConcept=number(m.nextConcept,m.concepts); m.nextChunk=number(m.nextChunk,m.chunks)
    m.cleanupConcept=number(m.cleanupConcept,m.concepts); m.cleanupChunk=number(m.cleanupChunk,m.chunks)
    if m.v2 then
      if j.state~='failed' and j.state~='cancelled' and (m.cleanupConcept~=0 or m.cleanupChunk~=0) then error('invalid cleanup phase') end
      if m.cleanupChunk>0 and m.cleanupConcept~=m.concepts then error('invalid cleanup order') end
      if (j.state=='verifying' or j.state=='evaluating' or j.state=='complete') and (m.nextConcept~=m.concepts or m.nextChunk~=m.chunks) then error('incomplete output') end
    end
    return m
  end
  local function protected(j)
    local lease=p..'lease:'..j.buildId
    if not kind(lease,'zset') then error('invalid reader lease') end
    return active==j.buildId or previous==j.buildId or j.state=='complete' or redis.call('ZCOUNT',lease,'('..string.format('%.0f',now),'+inf')>0
  end
  local function snapshot(j)
    return {jobId=j.jobId,buildId=j.buildId,sourceCommit=j.sourceCommit,state=j.state,failureCode=j.failureCode=='' and cjson.null or j.failureCode}
  end
  local function transition(j, state, failure)
    redis.call('HSET',p..'job:'..j.jobId,'state',state,'failureCode',failure)
    redis.call('HSET',p..'build:'..j.buildId..':manifest','state',state)
    if terminal[state] then redis.call('DEL',lock) end
    j.state=state; j.failureCode=failure
  end
  local function leasevalue(j) return j.ownerEpoch..':'..j.jobId..':'..j.fence end
  local function owned(j, m)
    return j and m and type(r.lease)=='table' and c.currentJob==j.jobId and r.lease.jobId==j.jobId and r.lease.buildId==j.buildId and r.lease.ownerEpoch==epoch and j.ownerEpoch==epoch and r.lease.fence==j.fence and redis.call('GET',lock)==leasevalue(j) and (not m.v2 or (r.lease.configurationEpoch==m.configurationEpoch and m.configurationEpoch==c.configurationEpoch))
  end
  local function owner(j)
    local result={ownerEpoch=j.ownerEpoch,fence=j.fence,jobId=j.jobId,buildId=j.buildId}
    if j.manifestVersion=='2' then result.configurationEpoch=j.configurationEpoch end
    return result
  end
  if r.op=='start' then
    if epoch==2147483647 then return fail('INDEX_UNAVAILABLE') end
    local current=c.currentJob and load(c.currentJob) or nil
    if c.currentJob and not current then return fail('INDEX_UNAVAILABLE') end
    if current and not terminal[current.state] then
      if not manifest(current) or protected(current) then return fail('INDEX_UNAVAILABLE') end
    end
    redis.call('HSET',control,'epoch',epoch+1,'fence',fence)
    if current and not terminal[current.state] then transition(current,'failed','INTERRUPTED') end
    return {ok=true,epoch=epoch+1}
  end
  if epoch==0 or r.epoch~=epoch then return fail('FENCED') end
  if r.op=='configure' then
    if not configuration(r.configurationEpoch) then return fail('INDEX_UNAVAILABLE') end
    if c.configurationEpoch and (#r.configurationEpoch<#c.configurationEpoch or (#r.configurationEpoch==#c.configurationEpoch and r.configurationEpoch<c.configurationEpoch)) then return fail('FENCED') end
    redis.call('HSET',control,'configurationEpoch',r.configurationEpoch)
    return {ok=true}
  end
  if r.op=='claim' or r.op=='claimInput' then
    local v2=r.op=='claimInput'
    local s=r.spec
    if type(s)~='table' or not buildid(s.buildId) or not commit(s.sourceCommit) or not hex(s.manifestHash,'sha256:',64) or not hex(s.policyHash,'sha256:',64) or not jobid(r.jobId) then return fail('INDEX_UNAVAILABLE') end
    if v2 then
      closed(s,{'buildId','sourceCommit','manifestHash','policyHash','recipeHash','configurationEpoch'})
      if not hex(s.recipeHash,'sha256:',64) or s.buildId~='bld_'..string.sub(s.recipeHash,8) or not configuration(s.configurationEpoch) then return fail('INDEX_UNAVAILABLE') end
      if s.configurationEpoch~=c.configurationEpoch then return fail('FENCED') end
    elseif not integer(s.concepts,0,50000) or not integer(s.chunks,0,250000) then return fail('INDEX_UNAVAILABLE') end
    local current=c.currentJob and load(c.currentJob) or nil
    if c.currentJob and not current then return fail('INDEX_UNAVAILABLE') end
    if current and current.state=='complete' and not manifest(current) then return fail('INDEX_UNAVAILABLE') end
    if current and not terminal[current.state] then
      local m=manifest(current)
      if not m then return fail('INDEX_UNAVAILABLE') end
      if current.buildId~=s.buildId or current.state=='cancelling' then return fail('BUILD_CONFLICT') end
      if current.ownerEpoch~=epoch or redis.call('GET',lock)~=leasevalue(current) then return fail('FENCED') end
      if (m.v2==true)~=v2 or m.sourceCommit~=s.sourceCommit or m.manifestHash~=s.manifestHash or m.policyHash~=s.policyHash then return fail('BUILD_CONFLICT') end
      if v2 then
        if m.recipeHash~=s.recipeHash or m.configurationEpoch~=s.configurationEpoch then return fail('BUILD_CONFLICT') end
      elseif m.concepts~=s.concepts or m.chunks~=s.chunks then return fail('BUILD_CONFLICT') end
      return {ok=true,created=false,lease=owner(current)}
    end
    if fence==2147483647 then return fail('INDEX_UNAVAILABLE') end
    local target=p..'build:'..s.buildId..':manifest'
    -- Missing metadata cannot hand retained payloads to a replacement's cleanup.
    if redis.call('EXISTS',target)==0 and (redis.call('EXISTS',p..'build:'..s.buildId..':concept:0')==1 or redis.call('EXISTS',p..'build:'..s.buildId..':chunk:0')==1) then return fail('INDEX_UNAVAILABLE') end
    local j={jobId=r.jobId,buildId=s.buildId,sourceCommit=s.sourceCommit,state='queued',ownerEpoch=epoch,fence=fence+1,failureCode=''}
    if protected(j) or redis.call('EXISTS',target)==1 or redis.call('EXISTS',p..'job:'..r.jobId)==1 or redis.call('EXISTS',lock)==1 then return fail('BUILD_CONFLICT') end
    redis.call('HSET',control,'currentJob',r.jobId,'fence',fence+1)
    redis.call('HSET',p..'job:'..r.jobId,'buildId',s.buildId,'sourceCommit',s.sourceCommit,'state','queued','ownerEpoch',epoch,'fence',fence+1,'failureCode','')
    if v2 then
      j.manifestVersion='2'; j.configurationEpoch=s.configurationEpoch
      redis.call('HSET',p..'job:'..r.jobId,'manifestVersion','2','configurationEpoch',s.configurationEpoch)
      redis.call('HSET',target,'manifestVersion','2','jobId',r.jobId,'sourceCommit',s.sourceCommit,'manifestHash',s.manifestHash,'policyHash',s.policyHash,'recipeHash',s.recipeHash,'configurationEpoch',s.configurationEpoch,'ownerEpoch',epoch,'fence',j.fence,'state','queued','nextConcept',0,'nextChunk',0,'cleanupConcept',0,'cleanupChunk',0)
    else
      redis.call('HSET',target,'jobId',r.jobId,'sourceCommit',s.sourceCommit,'manifestHash',s.manifestHash,'policyHash',s.policyHash,'state','queued','concepts',s.concepts,'chunks',s.chunks,'nextConcept',0,'nextChunk',0,'cleanupConcept',0,'cleanupChunk',0)
    end
    redis.call('SET',lock,leasevalue(j),'PX',30000)
    return {ok=true,created=true,lease=owner(j)}
  end
  if r.op=='current' then
    local current=c.currentJob and load(c.currentJob) or nil
    if c.currentJob and not current then return fail('INDEX_UNAVAILABLE') end
    return {ok=true,job=current and snapshot(current) or cjson.null}
  end
  local id=r.jobId or (type(r.lease)=='table' and r.lease.jobId)
  if not jobid(id) then return fail('INDEX_UNAVAILABLE') end
  local j=load(id)
  if not j then return fail(r.lease and 'FENCED' or 'NOT_FOUND') end
  if r.lease and (c.currentJob~=j.jobId or r.lease.buildId~=j.buildId or r.lease.ownerEpoch~=epoch or j.ownerEpoch~=epoch or r.lease.fence~=j.fence) then return fail('FENCED') end
  if r.op=='read' then return {ok=true,job=snapshot(j)} end
  local m=manifest(j)
  if r.op=='inspect' then
    if j.manifestVersion~='2' then return fail('BUILD_CONFLICT') end
    if not m then
      if j.state~='failed' and j.state~='cancelled' then return fail('INDEX_UNAVAILABLE') end
      return {ok=true,job=snapshot(j),manifest=cjson.null,live=false}
    end
    local result={manifestVersion=2,lease=owner(j),sourceCommit=m.sourceCommit,manifestHash=m.manifestHash,policyHash=m.policyHash,recipeHash=m.recipeHash,state=m.state,nextConcept=m.nextConcept,nextChunk=m.nextChunk,cleanupConcept=m.cleanupConcept,cleanupChunk=m.cleanupChunk}
    if m.outputDescriptor~=nil then result.outputDescriptor=m.outputDescriptor end
    local live=c.currentJob==j.jobId and j.ownerEpoch==epoch and m.configurationEpoch==c.configurationEpoch and redis.call('GET',lock)==leasevalue(j)
    return {ok=true,job=snapshot(j),manifest=result,live=live}
  end
  if r.op=='readCandidate' then
    if j.manifestVersion~='2' then return fail('BUILD_CONFLICT') end
    if not m then
      if j.state~='failed' and j.state~='cancelled' then return fail('INDEX_UNAVAILABLE') end
      return {ok=true,manifest=cjson.null}
    end
    local result={manifestVersion=2,lease=owner(j),sourceCommit=m.sourceCommit,manifestHash=m.manifestHash,policyHash=m.policyHash,recipeHash=m.recipeHash,state=m.state,nextConcept=m.nextConcept,nextChunk=m.nextChunk,cleanupConcept=m.cleanupConcept,cleanupChunk=m.cleanupChunk}
    if m.outputDescriptor~=nil then result.outputDescriptor=m.outputDescriptor end
    return {ok=true,manifest=result}
  end
  if r.op=='cleanup' then
    if not terminal[j.state] or j.state=='complete' or protected(j) then return fail('BUILD_CONFLICT') end
    if not m then
      if c.currentJob==j.jobId then redis.call('HDEL',control,'currentJob') end
      return {ok=true,done=true,removed=0}
    end
    local targets={}; local concepts=m.cleanupConcept; local chunks=m.cleanupChunk
    while #targets<128 and concepts<m.concepts do targets[#targets+1]=p..'build:'..j.buildId..':concept:'..concepts; concepts=concepts+1 end
    while #targets<128 and chunks<m.chunks do targets[#targets+1]=p..'build:'..j.buildId..':chunk:'..chunks; chunks=chunks+1 end
    local removed=0
    if #targets>0 then removed=redis.call('UNLINK',unpack(targets)) end
    local done=concepts==m.concepts and chunks==m.chunks
    if done then
      redis.call('DEL',p..'build:'..j.buildId..':manifest')
      if c.currentJob==j.jobId then redis.call('HDEL',control,'currentJob') end
    else redis.call('HSET',p..'build:'..j.buildId..':manifest','cleanupConcept',concepts,'cleanupChunk',chunks) end
    return {ok=true,done=done,removed=removed}
  end
  if not m then return fail('INDEX_UNAVAILABLE') end
  if protected(j) then return fail('BUILD_CONFLICT') end
  if r.op=='cancel' then
    if j.state=='cancelled' or j.state=='cancelling' then return {ok=true,job=snapshot(j)} end
    if terminal[j.state] then return fail('BUILD_CONFLICT') end
    transition(j,'cancelling','')
    return {ok=true,job=snapshot(j)}
  end
  if not owned(j,m) then return fail('FENCED') end
  if r.op=='ackCancel' then
    if j.state~='cancelling' then return fail('BUILD_CONFLICT') end
    transition(j,'cancelled','CANCELLED')
    return {ok=true,job=snapshot(j)}
  end
  if j.state~='queued' and j.state~='building' then return fail('FENCED') end
  if r.op=='begin' then
    if not m.v2 then return fail('BUILD_CONFLICT') end
    if j.state=='queued' then transition(j,'building','') end
    return {ok=true}
  end
  if r.op=='attach' then
    if not m.v2 or j.state~='building' then return fail('FENCED') end
    local d=descriptor(r.outputDescriptor)
    if d[3]~=m.recipeHash then return fail('BUILD_CONFLICT') end
    if m.outputDescriptor~=nil then
      if m.outputDescriptor~=r.outputDescriptor then return fail('BUILD_CONFLICT') end
    else
      -- One entire, canonical descriptor is the sole phase publication.
      redis.call('HSET',p..'build:'..j.buildId..':manifest','outputDescriptor',r.outputDescriptor)
    end
    return {ok=true}
  end
  if r.op=='renew' then redis.call('PEXPIRE',lock,30000); return {ok=true} end
  if r.op=='fail' then
    if not failures[r.failureCode] then return fail('INDEX_UNAVAILABLE') end
    transition(j,'failed',r.failureCode)
    return {ok=true,job=snapshot(j)}
  end
  if r.op=='append' then
    if m.v2 and (j.state~='building' or m.outputDescriptor==nil) then return fail('FENCED') end
    if (r.kind~='concept' and r.kind~='chunk') or not integer(r.offset,0,250000) or type(r.records)~='table' or #r.records<1 or #r.records>128 then return fail('INDEX_UNAVAILABLE') end
    local counter=r.kind=='concept' and 'nextConcept' or 'nextChunk'
    local maximum=r.kind=='concept' and m.concepts or m.chunks
    if r.offset~=m[counter] or r.offset+#r.records>maximum then return fail('BUILD_CONFLICT') end
    local args={}; local bytes=0
    for i,raw in ipairs(r.records) do
      if type(raw)~='string' then return fail('INDEX_UNAVAILABLE') end
      bytes=bytes+#raw
      if bytes>1048576 then return fail('INDEX_UNAVAILABLE') end
      local data=cjson.decode(raw)
      if type(data)~='table' or data.sourceCommit~=j.sourceCommit or not hex(data.sourceHash,'sha256:',64) or data.contentTrust~='untrusted' or data.projectionSchemaVersion~='1' or (r.kind=='chunk' and data.ordinal~=r.offset+i-1) then return fail('INDEX_UNAVAILABLE') end
      local target=p..'build:'..j.buildId..':'..r.kind..':'..(r.offset+i-1)
      if redis.call('EXISTS',target)==1 then return fail('INDEX_UNAVAILABLE') end
      args[#args+1]=target; args[#args+1]='$'; args[#args+1]=raw
    end
    -- RedisJSON's multi-set avoids a loop of individually visible partial payload writes.
    -- Unexpected module/dependency errors still leave this candidate non-serving.
    local result=redis.pcall('JSON.MSET',unpack(args))
    if type(result)=='table' and result.err then
      transition(j,'failed','DEPENDENCY_FAILED')
      return fail('INDEX_UNAVAILABLE')
    end
    redis.call('HSET',p..'build:'..j.buildId..':manifest',counter,r.offset+#r.records)
    transition(j,'building','')
    return {ok=true,next=r.offset+#r.records}
  end
  return fail('INDEX_UNAVAILABLE')
end
local ok,result=pcall(run)
if not ok then return cjson.encode(fail('INDEX_UNAVAILABLE')) end
return cjson.encode(result)
`;
