import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CompatibilityController, compatibilityChecks, createCompatibilityStore, createDesktopVersionReader, desktopBuildKey, COMPATIBILITY_CHECK_IDS } from "../scripts/compatibility.mjs";
import { buildDesktopCompatibilityProbeExpression, desktopBuildMetadataExpression, buildMonitorInterfaceProbeExpression, collectDesktopCompatibilityProbes } from "../scripts/desktop-request.mjs";

let now = 1793275200000;
const buildA = { asset: "index-a1.js" };
const input = () => ({
  probe: { interface: true, client: true, quota: true, model: true, queue: true, thread: true },
  usage: { sources: { official: { status: "ready", fetchedAt: now }, session: { status: "ready", fetchedAt: now } }, usageHistory: { schemaVersion: 1, tokenBuckets: [], quotaSamples: [] } },
  settings: { dailyKeepAlive: true, dailyKeepAliveStart: "07:35", autoResumeThreads: { fixture: { enabled: true } } },
  settingsReadable: true, configuration: { account: { configured: false }, provider: { configured: false } },
});
const checks = compatibilityChecks({ ...input(), now });
assert.deepEqual(checks.map(item => item.id), COMPATIBILITY_CHECK_IDS);
assert.equal(checks.find(item => item.id === "resume-channel").status, "passed");
assert.equal(checks.find(item => item.id === "resume-execution").status, "unverified");
assert.equal(checks.find(item => item.id === "keepalive-execution").status, "unverified");
assert.equal(checks.find(item => item.id === "api-account").status, "disabled");
assert.equal(compatibilityChecks({ ...input(), now, probe: {} }).find(item => item.id === "resume-channel").status, "failed");
const stale = input(); stale.usage.sources.official.fetchedAt = now - 3600000;
assert.equal(compatibilityChecks({ ...stale, now }).find(item => item.id === "official").status, "failed");
const staleSession=input();staleSession.usage.sources.session.fetchedAt=now-3600000;
assert.equal(compatibilityChecks({...staleSession,now}).find(item=>item.id==='session').detail,'session-stale');
const noSession=input();noSession.usage.sources.session={status:'unavailable',reason:'no-current-thread',fetchedAt:now};
assert.equal(compatibilityChecks({...noSession,now}).find(item=>item.id==='session').status,'unverified');
noSession.usage.sources.session.fetchedAt=now-3600000;
assert.equal(compatibilityChecks({...noSession,now}).find(item=>item.id==='session').status,'failed','an old scanner cannot hide behind an unselected chat');
const loadingSession=input();loadingSession.usage.sources.session={status:'loading',fetchedAt:null};
assert.equal(compatibilityChecks({...loadingSession,now}).find(item=>item.id==='session').detail,'session-loading');
const invalidHistory = input(); invalidHistory.usage.usageHistory = {};
assert.equal(compatibilityChecks({ ...invalidHistory, now }).find(item => item.id === "history").status, "failed");
assert.equal(desktopBuildKey({ asset: "https://bad.example/index.js" }, "1.2"), null);
assert.equal(desktopBuildKey(buildA, "26.1021.3705.0").key, "26.1021.3705.0|index-a1.js");

const threadId = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f2";
const calls = [];
const context = vm.createContext({ calls });
vm.runInContext(`
  window = { __CODEX_USAGE_MONITOR_STATE__: { diagnose: () => ({ok:true}) }, __codexUsageMonitorSaveSettings() {},
    __codexRoot: { _internalRoot: { current: { client: {
      hostId:'local', requestPromises:new Map(),
      async sendRequest(method, params) {
        calls.push({method,params});
        if (method==='account/rateLimits/read') return {rateLimits:{primary:{usedPercent:100,windowDurationMins:300}}};
        if (method==='model/list') return {data:[{model:'fixture-low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
        if (method==='thread/read') return {thread:{id:params.threadId}};
        throw Error('Self-check must not mutate tasks');
      },
      queryClient:{getQueryCache(){return{getAll:()=>[{queryKey:['queued-follow-ups'],state:{data:{state:{}}}}]}}}
    }}}}};
  document = {scripts:[{src:'app://-/assets/index-abc123.js'},{src:'https://external.example/index-def.js'}]};
`, context);
const probe = await vm.runInContext(buildDesktopCompatibilityProbeExpression({ threadId, model: "fixture-low" }), context);
assert.deepEqual(JSON.parse(JSON.stringify(probe)), { interface: true, client: true, quota: true, model: true, queue: true, thread: true, failures: {} });
assert.deepEqual(calls.map(call => call.method), ["account/rateLimits/read", "model/list", "thread/read"]);
assert.equal(calls.at(-1).params.includeTurns, false);
assert.equal((await vm.runInContext(desktopBuildMetadataExpression(), context)).asset, "index-abc123.js");
vm.runInContext("window.__codexRoot._internalRoot.current = {};", context);
const missing = await vm.runInContext(buildDesktopCompatibilityProbeExpression({ threadId }), context);
assert.equal(missing.client, false);
assert.equal(calls.length, 3, "missing clients never send a turn or a fallback RPC");

const quotaTimeout = {...input(), probe:{...input().probe,quota:false,failures:{quota:'timeout'}}};
const timeoutRows=compatibilityChecks({...quotaTimeout,now});
assert.equal(timeoutRows.find(item=>item.id==='resume-channel').status,'passed','quota endpoint timeout must not mislabel a working thread-read channel');
assert.equal(timeoutRows.find(item=>item.id==='desktop-quota').status,'unverified');
assert.equal(timeoutRows.find(item=>item.id==='desktop-quota').detail,'quota-timeout');
assert.equal(compatibilityChecks({...input(),probe:{...input().probe,queue:false,failures:{queue:'timeout'}},now}).find(item=>item.id==='queue').status,'unverified');
assert.equal(compatibilityChecks({...input(),probe:{...input().probe,queue:null},now}).find(item=>item.id==='queue').detail,'queue-unverified');
assert.equal(compatibilityChecks({...input(),probe:{...input().probe,thread:false,failures:{thread:'timeout'}},now}).find(item=>item.id==='resume-channel').status,'unverified');
assert.equal(compatibilityChecks({...input(),probe:{...input().probe,thread:false,failures:{thread:'invalid-response'}},now}).find(item=>item.id==='resume-channel').status,'failed');

const delayedCalls=[];
const delayedContext=vm.createContext({calls:delayedCalls});
vm.runInContext(`
 let finishQuota;
 window={__codexRoot:{_internalRoot:{current:{client:{hostId:'local',requestPromises:new Map(),async sendRequest(method,params){
  calls.push(method);
  if(method==='account/rateLimits/read')return new Promise(resolve=>{finishQuota=resolve});
  if(method==='model/list')return{data:[{model:'fixture-low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
  if(method==='thread/read'){finishQuota({rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}});return{thread:{id:params.threadId}};}
  throw Error('Unexpected mutation');
 }}}}}};
`,delayedContext);
const concurrentProbe=await vm.runInContext(buildDesktopCompatibilityProbeExpression({threadId,model:'fixture-low'}),delayedContext);
assert.equal(concurrentProbe.thread,true,'thread read must not wait behind the quota read');
assert.equal(concurrentProbe.quota,true);
assert.deepEqual(delayedCalls,['account/rateLimits/read','model/list','thread/read']);
vm.runInContext(`window.__codexRoot._internalRoot.current.client.sendRequest=async(method,params)=>{
 if(method==='account/rateLimits/read')throw Error('Timeout');
 if(method==='model/list')return{data:[{model:'fixture-low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
 if(method==='thread/read')throw Error('Unknown thread');
 throw Error('Unexpected mutation');
};`,delayedContext);
const failureProbe=await vm.runInContext(buildDesktopCompatibilityProbeExpression({threadId,model:'fixture-low'}),delayedContext);
assert.equal(failureProbe.failures.quota,'timeout');
assert.equal(failureProbe.failures.thread,'unavailable');
assert.equal(failureProbe.model,true,'an isolated quota failure must not prevent other read checks');

// Display and request channels can live in distinct real desktop pages. The
// control page intentionally has no UI and must not overwrite display health.
let displayHealth = true;
let displayClient = false;
const requestPage = { async evaluate(expression) {
  assert.ok(expression.includes('findDesktopRequestClient'));
  return {interface:false,client:true,quota:true,queue:true,model:true,thread:true};
} };
const displayPage = { async evaluate(expression) {
  return expression.includes('findDesktopRequestClient')
    ? {interface:displayHealth,client:displayClient,quota:displayClient,queue:displayClient,model:displayClient,thread:null}
    : displayHealth;
} };
const collect = () => collectDesktopCompatibilityProbes({monitorSessions:[displayPage],requestSessions:[requestPage],expectedPid:52,threadId,model:'fixture-low'});
const separated = await collect();
assert.equal(separated.interface,true,'healthy display must remain healthy when RPC lives in the UI-less control page');
assert.equal(separated.client,true);
assert.equal(compatibilityChecks({...input(),probe:separated,now}).find(check=>check.id==='interface').status,'passed');
const slowFirst={async evaluate(expression){return expression.includes('findDesktopRequestClient')?{client:true,quota:false,thread:false,model:true,queue:true,failures:{quota:'timeout',thread:'timeout'}}:true;}};
const recoveredProbe=await collectDesktopCompatibilityProbes({monitorSessions:[slowFirst],requestSessions:[requestPage],expectedPid:52,threadId});
assert.equal(recoveredProbe.thread,true,'another known local request page must be tried after a partial first result');
assert.equal(recoveredProbe.quota,true);
displayHealth = false;
assert.equal((await collect()).interface,false,'healthy control RPC cannot hide a genuinely broken display');
displayHealth = true; displayClient = true;
assert.equal((await collect()).interface,true,'same-page desktop layout remains supported');
const frozenDisplay={ async evaluate(expression) { if(!expression.includes('findDesktopRequestClient'))throw Error('timeout');return{client:false}; } };
assert.equal((await collectDesktopCompatibilityProbes({monitorSessions:[frozenDisplay],requestSessions:[requestPage],expectedPid:52})).interface,false,'unresponsive display must still fail');
assert.equal((await collectDesktopCompatibilityProbes({monitorSessions:[],requestSessions:[requestPage],expectedPid:52})).interface,null,'a control page alone is not display evidence');

const panel={isConnected:true,shadowRoot:{}};
const interfaceContext=vm.createContext({window:{__CODEX_USAGE_MONITOR_STATE__:{host:panel,diagnose:()=>({ok:true})},__codexUsageMonitorSaveSettings(){},__CODEX_USAGE_MONITOR_BACKEND__:{pid:52,at:Date.now(),phase:'connected'}},document:{getElementById:()=>panel}});
assert.equal(vm.runInContext(buildMonitorInterfaceProbeExpression(52),interfaceContext),true);
panel.isConnected=false;
assert.equal(vm.runInContext(buildMonitorInterfaceProbeExpression(52),interfaceContext),false,'a detached host is not a working panel');
panel.isConnected=true;
vm.runInContext('window.__CODEX_USAGE_MONITOR_BACKEND__.at=Date.now()-20000',interfaceContext);
assert.equal(vm.runInContext(buildMonitorInterfaceProbeExpression(52),interfaceContext),false,'stale heartbeat must remain a real failure');

let metadata = buildA;
let versionReads = 0;
const enrich = createDesktopVersionReader({ initialVersion: "26.1021.3705.0", readVersion: async () => { versionReads++; return {version:"26.1023.6621.0"}; } });
assert.equal((await enrich({...buildA,sessionId:"first"})).desktopVersion,"26.1021.3705.0");
await enrich({...buildA,sessionId:"first"});
assert.equal(versionReads,0,"same app session does not repeatedly launch a version reader");
assert.equal((await enrich({...buildA,sessionId:"restarted"})).desktopVersion,"26.1023.6621.0");
assert.equal(versionReads,1,"a restarted Codex refreshes version even when renderer assets stay the same");
let runCount = 0;
let saved = {};
const store = { get current() { return saved; }, async save(value) { saved = structuredClone(value); }, async flush() {} };
const controller = new CompatibilityController({ store, readMetadata: async () => metadata, runChecks: async () => { runCount++; return input(); }, now: () => now, desktopVersion: "26.1021.3705.0" });
await controller.tick();
assert.equal(runCount, 1);
assert.equal(controller.status.status, "ready");
assert.equal(controller.status.checks.find(item => item.id === "resume-execution").status, "unverified");
controller.recordExecution("resume-execution", true);
assert.equal(controller.status.checks.find(item => item.id === "resume-execution").status, "passed");
assert.equal(controller.status.checks.find(item => item.id === "keepalive-execution").status, "unverified");
await controller.tick(); assert.equal(runCount, 1, "no repeated heavy checks within ten minutes");
now += 60000;
await controller.tick(); assert.equal(runCount, 1);
const restarted = new CompatibilityController({ store, readMetadata: async () => buildA, runChecks: async () => input(), now: () => now, desktopVersion: "26.1021.3705.0" });
await restarted.tick();
assert.equal(restarted.status.checks.find(item => item.id === "resume-execution").status, "passed", "same build restores only actual execution evidence");
metadata = { asset: "index-b2.js" };
now += 60000;
await controller.tick();
assert.equal(runCount, 2, "new renderer asset triggers an immediate complete check");
assert.equal(controller.status.checks.find(item => item.id === "resume-execution").status, "unverified", "new builds cannot inherit previous build success");
controller.recordExecution("resume-execution", false);
assert.equal(controller.status.status, "attention");
await controller.tick({ force: true });
assert.equal(controller.status.checks.find(item => item.id === "resume-execution").status, "failed", "read-only success never hides actual send failure");
controller.recordExecution("resume-execution", true);
assert.equal(controller.status.status, "ready", "actual recovery clears the prior failure warning");
const manualCount = runCount;
await controller.tick({ force: true }); assert.equal(runCount, manualCount, "manual clicks are throttled");

let release;
const pendingController = new CompatibilityController({ store, readMetadata: async () => buildA, runChecks: () => new Promise(resolve => { release = resolve; }), now: () => now });
const inFlight = pendingController.tick();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(pendingController.tick({ force: true }), inFlight, "only one check can be in flight");
release(input()); await inFlight;
await pendingController.stop();
await controller.stop(); await restarted.stop();

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-compatibility-"));
try {
  const statePath = path.join(tempRoot, "state.json");
  const persistent = await createCompatibilityStore(statePath);
  await persistent.save({ buildKey: "build-a", executions: { "resume-execution": { ok: true, at: now, secret: "never-persist" } }, token: "never-persist",
    lastProbe:{at:now,client:true,quota:false,thread:true,failures:{quota:'timeout',token:'never-persist'},message:'never-persist',threadId:'never-persist'} });
  const text = await fs.readFile(statePath, "utf8");
  assert.equal(text.includes("never-persist"), false);
  assert.equal((await createCompatibilityStore(statePath)).current.executions["resume-execution"].ok, true);
  assert.equal((await createCompatibilityStore(statePath)).current.lastProbe.failures.quota,'timeout');
  assert.deepEqual(await fs.readdir(tempRoot), ["state.json"]);
} finally {
  assert.ok(path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(tempRoot).startsWith("codex-compatibility-"));
  await fs.rm(tempRoot, { recursive: true, force: true });
}
console.log("PASS: build-change checks, failure detection, read-only RPCs, execution evidence, throttling, persistence and privacy.");
