import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildDesktopAutoResumeExpression,
  buildDesktopCompatibilityProbeExpression,
  probeDesktopRequestClient,
  sendContinueThroughDesktop,
} from "../scripts/desktop-request.mjs";

const THREAD_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f2";
const EVENT_ID = "0123456789abcdef0123456789abcdef";
const TURN_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f3";

const calls = [];
const context = vm.createContext({ calls });
vm.runInContext(`
  const queuedFollowUps = {
    ${JSON.stringify(THREAD_ID)}: [
      { id: "queued-one", text: "排队消息 1" },
      { id: "queued-two", text: "排队消息 2" },
    ],
  };
  globalThis.window = {
    __codexRoot: {
      _internalRoot: {
        current: {
          nested: {
            queryClient: {
              getQueryCache() {
                return { getAll: () => [{ queryKey: ["get-global-state", "queued-follow-ups"], state: { data: { value: queuedFollowUps } } }] };
              },
            },
            hostId: "local",
            requestPromises: new Map(),
            async sendRequest(method, params, options) {
              calls.push({ method, params, options });
              return method === "turn/start" ? { turn: { id: ${JSON.stringify(TURN_ID)} } } : { thread: { id: params.threadId } };
            },
          },
        },
      },
    },
  };
`, context);

const session = {
  expressions: [],
  async evaluate(expression) {
    this.expressions.push(expression);
    const value = await vm.runInContext(expression, context);
    return JSON.parse(JSON.stringify(value));
  },
};

assert.deepEqual(
  await probeDesktopRequestClient(session),
  { ok: true, method: "codex-desktop-internal-request", hostId: "local" },
);

const result = await sendContinueThroughDesktop(session, {
  threadId: THREAD_ID.toUpperCase(),
  eventId: EVENT_ID.toUpperCase(),
  message: "请继续完成当前任务",
});
assert.deepEqual(result, {
  ok: true,
  method: "codex-desktop-internal-request",
  threadId: THREAD_ID,
  turnId: TURN_ID,
  queuedCount: 2,
  queuePreserved: true,
});
const normalizedCalls = JSON.parse(JSON.stringify(calls));
assert.deepEqual(normalizedCalls.map((item) => item.method), ["thread/resume", "turn/start"]);
assert.deepEqual(normalizedCalls[0], {
  method: "thread/resume",
  params: { threadId: THREAD_ID },
  options: { priority: "critical", source: "usage_monitor_auto_resume" },
});
assert.equal(normalizedCalls[1].params.threadId, THREAD_ID);
assert.deepEqual(normalizedCalls[1].params.input, [{ type: "text", text: "请继续完成当前任务" }]);
assert.equal(normalizedCalls[1].params.approvalPolicy, "never");
assert.equal(normalizedCalls[1].params.clientUserMessageId, `codex-usage-monitor-${EVENT_ID}`);
assert.equal(vm.runInContext(`queuedFollowUps[${JSON.stringify(THREAD_ID)}].length`, context), 2);
assert.equal(session.expressions.some((expression) => expression.includes("Input.insertText")), false);
assert.equal(session.expressions.some((expression) => expression.includes("prepareAutoResume")), false);

const encoded = buildDesktopAutoResumeExpression({ threadId: THREAD_ID, eventId: EVENT_ID, message: '继续处理 "A"' });
assert.match(encoded, /thread\/resume/);
assert.match(encoded, /turn\/start/);
assert.match(encoded, /继续处理 \\"A\\"/);

const beforeInvalid = session.expressions.length;
assert.deepEqual(
  await sendContinueThroughDesktop(session, { threadId: "bad", eventId: EVENT_ID, message: "继续" }),
  { ok: false, reason: "invalid-auto-resume-thread-id" },
);
assert.deepEqual(
  await sendContinueThroughDesktop(session, { threadId: THREAD_ID, eventId: "bad", message: "继续" }),
  { ok: false, reason: "invalid-auto-resume-event-id" },
);
assert.deepEqual(
  await sendContinueThroughDesktop(session, { threadId: THREAD_ID, eventId: EVENT_ID, message: "bad\nmessage" }),
  { ok: false, reason: "invalid-auto-resume-message" },
);
assert.equal(session.expressions.length, beforeInvalid);

const unavailable = {
  async evaluate() { throw new Error("codex-desktop-request-client-not-found"); },
};
assert.deepEqual(await probeDesktopRequestClient(unavailable), { ok: false, reason: "codex-desktop-request-client-not-found" });
assert.deepEqual(
  await sendContinueThroughDesktop(unavailable, { threadId: THREAD_ID, eventId: EVENT_ID, message: "继续" }),
  { ok: false, reason: "desktop-request-client-unavailable" },
);

// Retrying a completed event in the same renderer must not create another turn.
const callCount = calls.length;
await sendContinueThroughDesktop(session, { threadId: THREAD_ID, eventId: EVENT_ID, message: "继续" });
assert.equal(calls.length, callCount);
// Two overlapping evaluations share the in-flight operation. Queue movement after
// an accepted turn does not turn success into a retryable failure.
vm.runInContext(`window.__codexRoot._internalRoot.current.nested.sendRequest = async (method, params, options) => {
  calls.push({method, params, options});
  if (method === 'turn/start') { queuedFollowUps[${JSON.stringify(THREAD_ID)}] = []; return {turn:{id:${JSON.stringify(TURN_ID)}}}; }
  return {};
}`, context);
const next = { threadId: THREAD_ID, eventId: 'f'.repeat(32), message: '继续' };
const parallel = await Promise.all([sendContinueThroughDesktop(session, next), sendContinueThroughDesktop(session, next)]);
assert.equal(calls.length, callCount + 2);
assert.equal(parallel[0].ok, true);
assert.equal(parallel[0].queuePreserved, false);
assert.equal(parallel[1].turnId, TURN_ID);
const timeoutSession = { async evaluate(expression, timeout) { assert.equal(timeout, 60000); throw new Error('Runtime.evaluate timed out'); } };
assert.deepEqual(await sendContinueThroughDesktop(timeoutSession, next), {ok:false, reason:'desktop-send-timeout'});

// Real desktop React roots also retain DOM/framework object graphs. A generic
// breadth-first scan reaches its 200k-object cap before visiting the manager in
// a child fiber's hook state. Both request and queued-message lookup must find
// the React state without spending their entire budget on that unrelated graph.
const fiberCalls = [];
const fiberContext = vm.createContext({ calls: fiberCalls });
vm.runInContext(`
  const queued = { [${JSON.stringify(THREAD_ID)}]: [{id:'fiber-queued-one'}, {id:'fiber-queued-two'}] };
  const manager = {
    hostId: 'local', requestPromises: new Map(),
    async sendRequest(method, params, options) {
      calls.push({ method, params, options });
      return method === 'turn/start' ? { turn: { id: ${JSON.stringify(TURN_ID)} } }
        : { thread: { id: params.threadId } };
    },
  };
  const queryClient = { getQueryCache() { return { getAll: () => [{
    queryKey: ['get-global-state', 'queued-follow-ups'], state: { data: { value: queued } },
  }] }; } };
  const root = {
    stateNode: { nodes: Array.from({ length: 200001 }, () => ({})) },
    child: { memoizedState: { memoizedState: { manager, queryClient }, next: null }, child: null, sibling: null },
  };
  root.child.return = root;
  window = { __codexRoot: { _internalRoot: { current: root } } };
`, fiberContext);
const fiberSession = { async evaluate(expression) {
  return JSON.parse(JSON.stringify(await vm.runInContext(expression, fiberContext)));
} };
assert.equal((await probeDesktopRequestClient(fiberSession)).ok, true,
  'React hook state remains discoverable in a large mounted desktop');
assert.equal(fiberCalls.length, 0, 'probing request discovery does not send an RPC');
const fiberResult = await sendContinueThroughDesktop(fiberSession, {
  threadId: THREAD_ID, eventId: EVENT_ID, message: 'continue the paused task',
});
assert.equal(fiberResult.ok, true);
assert.equal(fiberResult.queuedCount, 2, 'queued follow-ups use the same bounded React discovery');
assert.equal(fiberResult.queuePreserved, true);
assert.deepEqual(fiberCalls.map(({ method }) => method), ['thread/resume', 'turn/start']);
assert.ok(fiberCalls.every(({ params }) => params.threadId === THREAD_ID));

// Current desktop stores queued follow-ups in its dedicated query's state map,
// while previous versions used the get-global-state query's value map.
vm.runInContext(`
  queryClient.getQueryCache = () => ({ getAll: () => [{
    queryKey: ['queued-follow-ups'], state: { data: { state: queued } },
  }] });
`, fiberContext);
const currentQueueResult = await sendContinueThroughDesktop(fiberSession, {
  threadId: THREAD_ID, eventId: 'a'.repeat(32), message: 'continue the paused task',
});
assert.equal(currentQueueResult.ok, true);
assert.equal(currentQueueResult.queuedCount, 2);
assert.equal(currentQueueResult.queuePreserved, true);

// Current desktop keeps local managers in a scoped atom store/WeakMap rather
// than as enumerable React state. Only the already-existing registry's read
// method may expose that manager; discovery must not create a new connection.
function scopedRegistryHarness(options = {}) {
  const state = { calls: [], hostLookups: [], ...options };
  const scopedContext = vm.createContext({ state });
  vm.runInContext(`
    (() => {
      const managers = new WeakMap();
      const scope = { get() {} };
      const requestClient = {
        hostId: state.clientHost || 'local',
        requestPromises: state.invalidPendingMap ? {} : new Map(),
        async sendRequest(method, params, options) {
          state.calls.push({ method, params, options });
          return method === 'turn/start' ? { turn: { id: ${JSON.stringify(TURN_ID)} } }
            : { thread: { id: params.threadId } };
        },
      };
      managers.set(scope, {
        hostId: state.managerHost || 'local', disposed: state.disposed === true, requestClient,
      });
      class ScopedManagers {
        constructor(scope) { this.scope = scope; }
        getForHostId(hostId) {
          state.hostLookups.push(hostId);
          return managers.get(this.scope);
        }
        getImplForHostId() { throw new Error('registry discovery must not create a manager'); }
      }
      const registry = state.missingRegistry ? {} : new ScopedManagers(scope);
      window = { __codexRoot: { _internalRoot: { current: {
        child: { memoizedState: { memoizedState: registry, next: null }, child: null, sibling: null },
      } } } };
    })();
  `, scopedContext);
  return { state, session: { async evaluate(expression) {
    return JSON.parse(JSON.stringify(await vm.runInContext(expression, scopedContext)));
  } } };
}
const scopedRegistry = scopedRegistryHarness();
assert.deepEqual(await probeDesktopRequestClient(scopedRegistry.session), {
  ok: true, method: 'codex-desktop-internal-request', hostId: 'local',
});
assert.equal(scopedRegistry.state.calls.length, 0, 'reading the registry submits no model request');
const scopedResult = await sendContinueThroughDesktop(scopedRegistry.session, {
  threadId: THREAD_ID, eventId: EVENT_ID, message: 'continue through the existing local manager',
});
assert.equal(scopedResult.ok, true);
assert.deepEqual(scopedRegistry.state.calls.map(({ method }) => method), ['thread/resume', 'turn/start']);
assert.ok(scopedRegistry.state.calls.every(({ params }) => params.threadId === THREAD_ID));
assert.ok(scopedRegistry.state.hostLookups.length > 0);
assert.ok(scopedRegistry.state.hostLookups.every(hostId => hostId === 'local'));
for (const invalid of [
  { managerHost: 'ssh:fixture' },
  { disposed: true },
  { clientHost: 'ssh:fixture' },
  { invalidPendingMap: true },
  { missingRegistry: true },
]) {
  const rejected = scopedRegistryHarness(invalid);
  assert.equal((await probeDesktopRequestClient(rejected.session)).ok, false);
  assert.equal((await sendContinueThroughDesktop(rejected.session, {
    threadId: THREAD_ID, eventId: EVENT_ID, message: 'continue',
  })).ok, false);
  assert.equal(rejected.state.calls.length, 0, 'invalid scoped managers must fail closed');
  assert.ok(rejected.state.hostLookups.every(hostId => hostId === 'local'));
}

// A similarly shaped remote manager or incomplete object must never become the
// fallback destination for a local auto-resume request.
for (const decoy of [
  `({ hostId: 'ssh:fixture', requestPromises: new Map(), sendRequest() { calls.push('remote'); } })`,
  `({ hostId: 'local', requestPromises: {}, sendRequest() { calls.push('incomplete'); } })`,
]) {
  const decoyCalls = [];
  const decoyContext = vm.createContext({ calls: decoyCalls });
  vm.runInContext(`window = { __codexRoot: { _internalRoot: { current: { client: ${decoy} } } } };`, decoyContext);
  const decoySession = { async evaluate(expression) {
    return JSON.parse(JSON.stringify(await vm.runInContext(expression, decoyContext)));
  } };
  assert.equal((await probeDesktopRequestClient(decoySession)).ok, false);
  assert.equal((await sendContinueThroughDesktop(decoySession, {
    threadId: THREAD_ID, eventId: EVENT_ID, message: 'continue',
  })).ok, false);
  assert.equal(decoyCalls.length, 0, 'a failed local lookup cannot send through a decoy manager');
}

// New desktops retain an RPC stub in an already-bound local scope signal.
// Fake proxy methods must never be used for registry/query discovery.
function rpcScopeHarness(options = {}) {
  const state = { calls: [], subscriptions: [], disposed: [], queue: [{id:'rpc-queued-one'}], ...options };
  const rpcContext = vm.createContext({state, setTimeout:(fn,delay)=>setTimeout(fn,state.queueTimeout&&delay===5000?0:delay), clearTimeout, queueMicrotask});
  vm.runInContext(`
    const rpcPrototype=Object.create(Function.prototype,{
      dup:{value(){throw Error('do not duplicate connections')}},onRpcBroken:{value(){}},map:{value(){}},
      toString:{value(){return state.promiseStub?'[object RpcPromise]':'[object RpcStub]'}},
    });
    const rpc=new Proxy(Object.setPrototypeOf(function(){},rpcPrototype),{get(target,key,receiver){
      if(key==='sendRequest')return async(method,params,options)=>{
        state.calls.push({method,params,options});
        if(method==='turn/start')return{turn:{id:${JSON.stringify(TURN_ID)}}};
        if(method==='thread/resume'||method==='thread/read')return{thread:{id:params.threadId}};
        if(method==='account/rateLimits/read')return{rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}};
        if(method==='model/list')return{data:[{model:'fixture-low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
        throw Error('Unexpected request');
      };
      if(key==='subscribe')return config=>{
        state.subscriptions.push({type:config.type,key:config.key,field:config.field});
        const index=state.subscriptions.length;
        const subscription={[Symbol.dispose](){state.disposed.push('subscription-'+index)}};
        const promise=state.delayRegistration?new Promise(resolve=>setTimeout(()=>resolve(subscription),5)):Promise.resolve(subscription);
        promise.onRpcBroken=()=>{};
        promise[Symbol.dispose]=()=>state.disposed.push('registration-'+index);
        if(!state.queueTimeout)queueMicrotask(()=>config.listener(state.badQueueAt===index?null:state.queue));
        return promise;
      };
      if(Reflect.has(target,key))return Reflect.get(target,key,receiver);
      return ()=>{state.calls.push({method:'unexpected-proxy-'+String(key)});throw Error('Fake RPC method invoked')};
    }});
    const store={get(){throw Error('do not resolve new atoms')}};
    const signal={atom:{init:undefined},store:state.wrongStore?{}:store,get(){
      if(state.readThrows)throw Error('unavailable signal');
      return{status:state.status||'ready',client:{hostId:state.hostId||'local',rpc:state.invalidRpc?{}:rpc}};
    },subscribe(){throw Error('do not subscribe to a scope signal')}};
    const bindings=new Map([[state.remoteBinding?'ssh:fixture':'local',{value:signal}]]);
    const scope={chain:new Map(),node:{store,familyBindings:new Map([[{resolve(){throw Error('do not resolve a family')}},bindings]])},get(){},watch(){}};
    window={__codexRoot:{_internalRoot:{current:{child:{memoizedState:{memoizedState:{decoy:rpc,scope},next:null}}}}}};
  `, rpcContext);
  return {state,session:{async evaluate(expression){return JSON.parse(JSON.stringify(await vm.runInContext(expression,rpcContext)))}}};
}
const rpcScope=rpcScopeHarness();
assert.equal((await probeDesktopRequestClient(rpcScope.session)).ok,true);
assert.equal(rpcScope.state.calls.length,0,'discovery neither sends RPCs nor creates a manager');
const rpcProbe=await rpcScope.session.evaluate(buildDesktopCompatibilityProbeExpression({threadId:THREAD_ID,model:'fixture-low'}));
for(const key of ['client','quota','model','thread','queue'])assert.equal(rpcProbe[key],true,key);
assert.deepEqual(rpcScope.state.calls.map(c=>c.method),['account/rateLimits/read','model/list','thread/read']);
assert.ok(rpcScope.state.disposed.includes('registration-1'));
assert.ok(rpcScope.state.disposed.includes('subscription-1'));
assert.equal(rpcScope.state.subscriptions[0].key.hostId,'local');
assert.equal(rpcScope.state.subscriptions[0].key.threadId,THREAD_ID);
assert.equal(rpcScope.state.subscriptions[0].field,'queuedMessages');
const rpcResume=await sendContinueThroughDesktop(rpcScope.session,{threadId:THREAD_ID,eventId:EVENT_ID,message:'continue'});
assert.equal(rpcResume.ok,true);
assert.equal(rpcResume.queuedCount,1);
assert.equal(rpcResume.queuePreserved,true);
assert.deepEqual(rpcScope.state.calls.slice(3).map(c=>c.method),['thread/resume','turn/start']);
assert.equal((await sendContinueThroughDesktop(rpcScope.session,{threadId:THREAD_ID,eventId:EVENT_ID,message:'continue'})).turnId,TURN_ID);
assert.equal(rpcScope.state.calls.length,5,'RPC adapter retains event deduplication');
for(const invalid of [{hostId:'ssh:fixture'},{status:'disconnected'},{status:'loading'},{promiseStub:true},{invalidRpc:true},{wrongStore:true},{remoteBinding:true},{readThrows:true}]){
  const rejected=rpcScopeHarness(invalid);
  assert.equal((await probeDesktopRequestClient(rejected.session)).ok,false);
  assert.equal(rejected.state.calls.length,0);
  assert.equal(rejected.state.subscriptions.length,0);
}
const invalidBeforeSend=rpcScopeHarness({badQueueAt:1});
assert.equal((await sendContinueThroughDesktop(invalidBeforeSend.session,{threadId:THREAD_ID,eventId:EVENT_ID,message:'continue'})).ok,false);
assert.equal(invalidBeforeSend.state.calls.length,0,'unknown queue prevents sending');
const failedAfterSend=rpcScopeHarness({badQueueAt:2});
assert.equal((await sendContinueThroughDesktop(failedAfterSend.session,{threadId:THREAD_ID,eventId:EVENT_ID,message:'continue'})).ok,true,
  'queue observation failure after acceptance must not retry the model turn');
const lateSubscription=rpcScopeHarness({delayRegistration:true});
assert.equal((await lateSubscription.session.evaluate(buildDesktopCompatibilityProbeExpression({threadId:THREAD_ID,model:'fixture-low'}))).queue,true);
await new Promise(resolve=>setTimeout(resolve,15));
assert.ok(lateSubscription.state.disposed.includes('subscription-1'),'late subscription is released');
const queueTimeout=rpcScopeHarness({queueTimeout:true});
const timeoutProbe=await queueTimeout.session.evaluate(buildDesktopCompatibilityProbeExpression({threadId:THREAD_ID,model:'fixture-low'}));
assert.equal(timeoutProbe.failures.queue,'timeout');
assert.equal(timeoutProbe.thread,true);
assert.ok(queueTimeout.state.disposed.includes('subscription-1'),'timed-out read releases its subscription');
const noCurrentChat=rpcScopeHarness();
assert.equal((await noCurrentChat.session.evaluate(buildDesktopCompatibilityProbeExpression({model:'fixture-low'}))).queue,null);
assert.equal(noCurrentChat.state.subscriptions.length,0,'no thread means no speculative queue subscription');

console.log("PASS: legacy and scoped RPC clients preserve exact-task, idempotent submission and read-only queue cleanup.");
