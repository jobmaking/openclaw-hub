'use strict';

const { randomUUID } = require('node:crypto');
const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+~-]{0,207}$/u;
const AGENT = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const rawUnavailable = () => Object.assign(new Error('No se pudo completar la revisión con el modelo seleccionado. No se ha modificado el documento.'),{safeMessage:'No se pudo completar la revisión con el modelo seleccionado. No se ha modificado el documento.'});

function modelFor({row,link}) {
  const model=row?.model,provider=row?.modelProvider;
  if (typeof model!=='string'||!REF.test(model)||typeof provider!=='string'||!REF.test(provider)||provider.includes('/')) return null;
  const id=model.startsWith(provider+'/')?model.slice(provider.length+1):model;
  if (!REF.test(id)||id.includes('..')||provider.includes('..')) return null;
  if (link.cfg?.lockedModel && Array.isArray(link.models) && link.models.length && !link.models.some(m=>[id,model].includes(m.id)&&m.provider===provider)) return null;
  return { provider, model:id };
}
function specification(owner, message) {
  const target=modelFor(owner), agentId=owner.link.cfg.gatewayAgentId||'main';
  if(!target || !AGENT.test(agentId) || typeof message!=='string' || !message.length || message.length>78000) throw rawUnavailable();
  const sessionId='model-run-'+randomUUID();
  // Exactly the private one-shot inference transport of OpenClaw infer model run.
  // Never attach it to owner.key, deliver it, run tools, or expose arbitrary RPC parameters.
  return {...target,agentId,sessionId,sessionKey:'agent:'+agentId+':explicit:'+sessionId,message,
    modelRun:true,promptMode:'none',cleanupBundleMcpOnRunEnd:true,idempotencyKey:randomUUID()};
}
const hasTransport=({link})=>link?.connected===true && link.gatewayMethods?.has('agent') && typeof link.documentModelRun==='function';
function parseObject(raw) {
  if (typeof raw!=='string' || raw.length>55000) throw rawUnavailable();
  // Accept one JSON object (optionally fenced by the model); no surrounding prose or directives.
  const text=raw.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/iu,'$1');
  let v;
  try {v=JSON.parse(text);}catch{throw rawUnavailable();}
  if (!v || typeof v!=='object'||Array.isArray(v)) throw rawUnavailable();
  return v;
}
async function complete(owner,prompt,input) {
  if (!hasTransport(owner)) throw rawUnavailable();
  const spec=specification(owner,prompt+'\n\nDATOS JSON:\n'+JSON.stringify(input));
  let response;
  try { response=await owner.link.documentModelRun(spec); } catch { throw rawUnavailable(); }
  const result=response?.payload?.result, meta=result?.meta?.agentMeta;
  if(!response?.ok || response.payload.runId!==spec.idempotencyKey || meta?.provider!==spec.provider ||
       ![spec.model,spec.provider+'/'+spec.model].includes(meta?.model) ||
       (meta?.fallbackAttempts||[]).some(a=>a?.provider!==spec.provider||![spec.model,spec.provider+'/'+spec.model].includes(a?.model))) throw rawUnavailable();
  const outputs=result.payloads;
  if (!Array.isArray(outputs) || outputs.length!==1 || outputs[0]?.isError || outputs[0]?.mediaUrl || outputs[0]?.mediaUrls?.length) throw rawUnavailable();
  return parseObject(outputs[0].text);
}
module.exports={modelFor,hasTransport,complete,specification};
