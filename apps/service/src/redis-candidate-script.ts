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
local function number(s, maximum)
  local n=tonumber(s)
  if not integer(n,0,maximum) then error('invalid state') end
  return n
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
    if not buildid(j.buildId) or not commit(j.sourceCommit) or not states[j.state] then error('invalid job') end
    j.ownerEpoch=number(j.ownerEpoch,2147483647); j.fence=number(j.fence,2147483647)
    if j.ownerEpoch<1 or j.fence<1 or j.failureCode==nil then error('invalid job') end
    if j.state=='failed' and not failures[j.failureCode] then error('invalid failure') end
    if j.state=='cancelled' and j.failureCode~='CANCELLED' then error('invalid failure') end
    if not terminal[j.state] and j.failureCode~='' then error('invalid failure') end
    j.jobId=id
    return j
  end
  local function manifest(j)
    local key=p..'build:'..j.buildId..':manifest'
    if not kind(key,'hash') then error('invalid manifest') end
    if redis.call('EXISTS',key)==0 then return nil end
    local m=fields(key)
    if m.jobId~=j.jobId or m.state~=j.state or m.sourceCommit~=j.sourceCommit or not hex(m.manifestHash,'sha256:',64) or not hex(m.policyHash,'sha256:',64) then error('invalid manifest') end
    m.concepts=number(m.concepts,50000); m.chunks=number(m.chunks,250000)
    m.nextConcept=number(m.nextConcept,m.concepts); m.nextChunk=number(m.nextChunk,m.chunks)
    m.cleanupConcept=number(m.cleanupConcept,m.concepts); m.cleanupChunk=number(m.cleanupChunk,m.chunks)
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
    return j and m and r.lease and c.currentJob==j.jobId and r.lease.jobId==j.jobId and r.lease.buildId==j.buildId and r.lease.ownerEpoch==epoch and j.ownerEpoch==epoch and r.lease.fence==j.fence and redis.call('GET',lock)==leasevalue(j)
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
  if r.op=='claim' then
    local s=r.spec
    if type(s)~='table' or not buildid(s.buildId) or not commit(s.sourceCommit) or not hex(s.manifestHash,'sha256:',64) or not hex(s.policyHash,'sha256:',64) or not integer(s.concepts,0,50000) or not integer(s.chunks,0,250000) or not jobid(r.jobId) then return fail('INDEX_UNAVAILABLE') end
    local current=c.currentJob and load(c.currentJob) or nil
    if c.currentJob and not current then return fail('INDEX_UNAVAILABLE') end
    if current and not terminal[current.state] then
      local m=manifest(current)
      if not m then return fail('INDEX_UNAVAILABLE') end
      if current.buildId~=s.buildId or current.state=='cancelling' then return fail('BUILD_CONFLICT') end
      if current.ownerEpoch~=epoch or redis.call('GET',lock)~=leasevalue(current) then return fail('FENCED') end
      if m.sourceCommit~=s.sourceCommit or m.manifestHash~=s.manifestHash or m.policyHash~=s.policyHash or m.concepts~=s.concepts or m.chunks~=s.chunks then return fail('BUILD_CONFLICT') end
      return {ok=true,created=false,lease={ownerEpoch=epoch,fence=current.fence,jobId=current.jobId,buildId=current.buildId}}
    end
    if fence==2147483647 then return fail('INDEX_UNAVAILABLE') end
    local target=p..'build:'..s.buildId..':manifest'
    local j={jobId=r.jobId,buildId=s.buildId,sourceCommit=s.sourceCommit,state='queued',ownerEpoch=epoch,fence=fence+1,failureCode=''}
    if protected(j) or redis.call('EXISTS',target)==1 or redis.call('EXISTS',p..'job:'..r.jobId)==1 or redis.call('EXISTS',lock)==1 then return fail('BUILD_CONFLICT') end
    redis.call('HSET',control,'currentJob',r.jobId,'fence',fence+1)
    redis.call('HSET',p..'job:'..r.jobId,'buildId',s.buildId,'sourceCommit',s.sourceCommit,'state','queued','ownerEpoch',epoch,'fence',fence+1,'failureCode','')
    redis.call('HSET',target,'jobId',r.jobId,'sourceCommit',s.sourceCommit,'manifestHash',s.manifestHash,'policyHash',s.policyHash,'state','queued','concepts',s.concepts,'chunks',s.chunks,'nextConcept',0,'nextChunk',0,'cleanupConcept',0,'cleanupChunk',0)
    redis.call('SET',lock,leasevalue(j),'PX',30000)
    return {ok=true,created=true,lease={ownerEpoch=epoch,fence=j.fence,jobId=j.jobId,buildId=j.buildId}}
  end
  local id=r.jobId or (type(r.lease)=='table' and r.lease.jobId)
  if not jobid(id) then return fail('INDEX_UNAVAILABLE') end
  local j=load(id)
  if not j then return fail(r.lease and 'FENCED' or 'NOT_FOUND') end
  if r.lease and (c.currentJob~=j.jobId or r.lease.buildId~=j.buildId or r.lease.ownerEpoch~=epoch or j.ownerEpoch~=epoch or r.lease.fence~=j.fence) then return fail('FENCED') end
  if r.op=='read' then return {ok=true,job=snapshot(j)} end
  local m=manifest(j)
  if r.op=='cleanup' then
    if not terminal[j.state] or j.state=='complete' or protected(j) then return fail('BUILD_CONFLICT') end
    if not m then return {ok=true,done=true,removed=0} end
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
  if r.op=='renew' then redis.call('PEXPIRE',lock,30000); return {ok=true} end
  if r.op=='fail' then
    if not failures[r.failureCode] then return fail('INDEX_UNAVAILABLE') end
    transition(j,'failed',r.failureCode)
    return {ok=true,job=snapshot(j)}
  end
  if r.op=='append' then
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
