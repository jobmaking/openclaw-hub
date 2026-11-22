'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:pause}=require('node:timers/promises');
const net=require('node:net');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root=path.resolve(__dirname,'..');
const keep=Boolean(process.env.HUB_VIEWER_EVIDENCE);
const linux=process.argv.includes('--electron'), pc=process.argv.includes('--pc'), pdfOnly=process.argv.includes('--pdf-only'), wordOnly=process.argv.includes('--word'), work=process.argv.includes('--work'), appMode=process.argv.includes('--standalone');
const media=process.argv.includes('--media')||process.env.HUB_FIXTURE_MEDIA==='1';
const proxyNames=['NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'];
function cleanEnv(extra={}){
  const env={...process.env,...extra};
  for(const name of proxyNames)delete env[name];
  env.NO_PROXY='127.0.0.1,localhost';env.no_proxy='127.0.0.1,localhost';
  return env;
}
// Node's own fetch honours the egress proxy unless we detach this isolated
// loopback harness from it. Browser children are already launched with cleanEnv.
for(const name of proxyNames)delete process.env[name];
process.env.NO_PROXY='127.0.0.1,localhost';process.env.no_proxy='127.0.0.1,localhost';
let directory, service, desktop, browser, context, page, origin, checks=0;
const log=[], errors=[], outside=[], altered=[];
const filenames={pdf:'Informe de ejemplo.pdf',xlsx:'Balance de ejemplo.xlsx',bad:'PDF no disponible.pdf'};
const check=(title,ok)=>{assert.ok(ok,title);checks++;console.log('PASS '+title);};
async function until(fn,label,ms=7000){let e;for(const end=Date.now()+ms;Date.now()<end;){try{const x=await fn();if(x)return x;}catch(err){e=err;}await pause(45);}throw Error(label+(e?' · '+e.message:''));}
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(p){if(!p||p.exitCode!==null||p.signalCode!==null)return;const done=once(p,'exit');p.kill();await Promise.race([done,pause(1400)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await done;}}

// Opt-in multimedia suite. It never runs under the historical PDF/Word flags,
// so the older checks keep their exact fixtures and expectations.
async function mediaSuite(){
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'fixtures.json'),'utf8'));
  const items=manifest.media||[];
  const byId=id=>items.find(item=>item.id===id);
  const agent='primary-demo', otherAgent='assistant-demo';
  const mainKey='agent:main:dashboard:documents-demo', workKey='agent:main:dashboard:word-source';
  const mainSession='documents-demo-v1', workSession='fixture-source-v2';
  const mainImage=byId('fixture-media-image'), mainJpeg=byId('fixture-media-jpeg');
  const mainVideo=byId('fixture-media-video'), mainWebm=byId('fixture-media-webm');
  const workImage=byId('fixture-work-image'), workVideo=byId('fixture-work-video');
  if(!mainImage||!mainJpeg||!mainVideo||!mainWebm||!workImage||!workVideo)throw Error('Multimedia fixtures were not generated');
  let pass=0, fail=0, skipped=0;
  const ok=(title,condition,detail='')=>{
    if(condition){pass++;console.log('PASS '+title);}
    else{fail++;console.log('FAIL '+title+(detail?' · '+detail:''));}
    return Boolean(condition);
  };
  const skip=(title,why)=>{skipped++;console.log('SKIP '+title+' · '+why);};
  const source=item=>fs.readFile(path.join(directory,item.title));
  const query=values=>'?'+new URLSearchParams(values);
  const mediaPath=(item,{id=agent,key=mainKey,session=mainSession}={})=>'/api/artifact-media'+query({agent:id,key,sessionId:session,id:item.id});
  let cookie='';
  try{
    const first=await fetch(origin+'/',{redirect:'error'});
    const header=first.headers.getSetCookie?.()[0]||first.headers.get('set-cookie')||'';
    cookie=header.split(';')[0];
    if(!cookie)try{cookie=(await context.cookies(origin)).map(c=>c.name+'='+c.value).join('; ');}catch{}
  }catch(error){console.log('SKIP fixture cookie · '+error.message);}
  const call=async(pathname,options={})=>{
    const {auth=true,...rest}=options, headers={...(rest.headers||{})};
    if(auth&&cookie)headers.cookie=cookie;
    return fetch(origin+pathname,{redirect:'error',cache:'no-store',...rest,headers});
  };
  const json=async response=>{try{return await response.json();}catch{return null;}};
  const listingFor=async(id,key)=>{
    const response=await call('/api/artifacts'+query({agent:id,key}));
    return {response,body:await json(response)};
  };
  const wait=async(fn,ms=7000)=>{const end=Date.now()+ms;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch{}await pause(45);}return false;};
  let finger=null;
  const tap=async target=>{
    const node=typeof target==='string'?page.locator(target):target;
    await node.scrollIntoViewIfNeeded();
    if(appMode){
      finger||=await context.newCDPSession(page);
      const point=await wait(()=>node.evaluate(element=>{
        const box=element.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
        return !element.disabled&&box.width>=1&&box.height>=1&&element.contains(document.elementFromPoint(x,y))?{x,y}:null;
      }),1800);
      if(!point)throw Error('touch target is not reachable');
      await finger.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:2,radiusY:2,force:1}]});
      await finger.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else if(!linux&&!pc)await node.tap();
    else await node.click();
  };
  const fit=async root=>root.evaluate(element=>{
    const height=visualViewport?.height??innerHeight, top=visualViewport?.offsetTop??0;
    const controls=[...element.querySelectorAll('button,a')].filter(node=>node.getClientRects().length);
    return {total:controls.length,
      small:controls.filter(node=>{const box=node.getBoundingClientRect();return box.width<44||box.height<44;}).length,
      outside:controls.filter(node=>{const box=node.getBoundingClientRect();return box.left<0||box.right>innerWidth+1||box.bottom>top+height+1;}).length};
  });
  const download=async(node,item)=>{
    try{
      if(linux){
        await tap(node);
        const native=path.join(directory,'native',item.title);
        const bytes=await until(()=>fs.readFile(native),'native media download',9000).catch(()=>null);
        return {name:item.title,bytes,error:bytes?null:'native file not written'};
      }
      const event=page.waitForEvent('download');
      await tap(node);
      const file=await event;
      return {name:file.suggestedFilename(),bytes:await fs.readFile(await file.path()),error:null};
    }catch(error){return {name:null,bytes:null,error:error.message};}
  };
  const videoPlay=async(root,selector,label)=>{
    const video=root.locator('.av-media-video').first();
    const shown=await wait(async()=>await video.isVisible(),7000);
    if(!ok(label+' renders a native video element',shown))return;
    const state=await video.evaluate(video=>({controls:video.controls,playsInline:video.playsInline,autoplay:video.autoplay,loop:video.loop,
      paused:video.paused,preload:video.preload,currentTime:video.currentTime,src:video.currentSrc||video.src}));
    ok(label+' has controls, playsinline, no autoplay and no loop',state.controls&&state.playsInline&&!state.autoplay&&!state.loop,JSON.stringify(state));
    ok(label+' starts paused at the beginning',state.paused&&state.currentTime===0,JSON.stringify({paused:state.paused,currentTime:state.currentTime}));
    const cdp=await context.newCDPSession(page);
    const expression=`(async()=>{const v=document.querySelector(${JSON.stringify(selector)});if(!v)return 'missing';try{v.muted=true;await v.play();return 'played'}catch(e){return e.name+': '+e.message}})()`;
    let result=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,userGesture:true,returnByValue:true}).then(value=>value.result?.value).catch(error=>'CDP: '+error.message);
    let playing=await wait(async()=>await video.evaluate(v=>!v.paused&&v.currentTime>0.12),9000);
    if(!playing){
      await video.click({position:{x:12,y:12}}).catch(()=>{});
      await pause(450);
      playing=await wait(async()=>await video.evaluate(v=>!v.paused&&v.currentTime>0.12),7000);
    }
    ok(label+' plays real frames instead of a simulated state',playing,JSON.stringify({result,state:await video.evaluate(v=>({paused:v.paused,currentTime:v.currentTime,readyState:v.readyState,error:v.error?.code||null}))}));
    const beforePause=await video.evaluate(v=>v.currentTime);
    await video.evaluate(v=>v.pause());
    await pause(260);
    const paused=await video.evaluate(v=>({paused:v.paused,currentTime:v.currentTime}));
    ok(label+' pauses where the user asked',paused.paused&&Math.abs(paused.currentTime-beforePause)<0.35,JSON.stringify({beforePause,...paused}));
    const target=await video.evaluate(v=>Math.min(0.45,Math.max(0.2,(v.duration||1)/2)));
    await video.evaluate((v,time)=>{v.currentTime=time;},target);
    await pause(500);
    const seek=await video.evaluate(v=>({seeking:v.seeking,currentTime:v.currentTime,readyState:v.readyState}));
    ok(label+' seeks inside the clip',!seek.seeking&&Math.abs(seek.currentTime-target)<0.55,JSON.stringify({target,...seek}));
    return video;
  };
  const imageShown=async(root,label,item)=>{
    const image=root.locator('.av-media-image').first();
    const shown=await wait(async()=>await image.isVisible(),7000);
    if(!ok(label+' renders a real image element',shown))return false;
    const state=await image.evaluate(image=>({complete:image.complete,width:image.naturalWidth,height:image.naturalHeight,src:image.currentSrc||image.src}));
    return ok(label+' decodes the expected pixels',state.complete&&state.width===item.width&&state.height===item.height,JSON.stringify(state));
  };

  try{
    const branding=await call('/api/branding');
    const body=await json(branding);
    ok('fixture advertises capabilities.artifactMedia=true',body?.capabilities?.artifactMedia===true,JSON.stringify(body?.capabilities));

    const main=await listingFor(agent,mainKey);
    const mainList=main.body?.artifacts||[];
    ok('Entregables describes the real fixture sessionId',main.response.status===200&&main.body?.sessionId===mainSession,`status ${main.response.status} · ${main.body?.sessionId}`);
    const expectedMain=[mainImage,mainJpeg,mainVideo,mainWebm];
    ok('Entregables lists the four synthetic media files',expectedMain.every(item=>mainList.some(file=>file.id===item.id))&&mainList.length===4,
      mainList.map(file=>file.id+':'+file.mimeType).join(','));
    ok('Entregables keeps each explicit media MIME type',expectedMain.every(item=>mainList.some(file=>file.id===item.id&&file.mimeType===item.mimeType)),
      mainList.map(file=>file.id+':'+file.mimeType).join(','));
    ok('Entregables marks every media file as downloadable',expectedMain.every(item=>mainList.some(file=>file.id===item.id&&file.downloadSupported===true)),'');

    const work=await listingFor(otherAgent,workKey);
    const workList=work.body?.artifacts||[];
    ok('Work describes its own real fixture sessionId',work.response.status===200&&work.body?.sessionId===workSession,`status ${work.response.status} · ${work.body?.sessionId}`);
    ok('Work only lists the media authorized for its session',workList.length===2&&workList.every(file=>[workImage.id,workVideo.id].includes(file.id))&&
      !workList.some(file=>expectedMain.some(item=>item.id===file.id)),workList.map(file=>file.id).join(','));

    const videoBytes=await source(mainVideo);
    const base=mediaPath(mainVideo);
    const response=await call(base);
    const bytes=Buffer.from(await response.arrayBuffer());
    const type=(response.headers.get('content-type')||'').split(';')[0];
    const length=Number(response.headers.get('content-length'));
    const apiReady=ok('GET /api/artifact-media returns the original video bytes',response.status===200&&type===mainVideo.mimeType&&length===videoBytes.length&&bytes.equals(videoBytes),
      `status ${response.status} · ${type} · ${length}/${videoBytes.length} bytes`);
    ok('GET /api/artifact-media uses an inline explicit MIME type and no-store',response.headers.get('content-disposition')?.startsWith('inline')===true&&
      response.headers.get('x-content-type-options')==='nosniff'&&(response.headers.get('cache-control')||'').includes('no-store'),
      JSON.stringify(Object.fromEntries(['content-disposition','x-content-type-options','cache-control'].map(name=>[name,response.headers.get(name)]))));
    ok('GET /api/artifact-media advertises byte ranges',response.headers.get('accept-ranges')==='bytes',String(response.headers.get('accept-ranges')));

    const head=await call(base,{method:'HEAD'});
    const headBytes=Buffer.from(await head.arrayBuffer());
    ok('HEAD /api/artifact-media returns the same length and no body',head.status===200&&Number(head.headers.get('content-length'))===videoBytes.length&&headBytes.length===0,
      `status ${head.status} · ${head.headers.get('content-length')} · body ${headBytes.length}`);

    const firstRange=await call(base,{headers:{Range:'bytes=0-99'}});
    const firstBytes=Buffer.from(await firstRange.arrayBuffer());
    ok('single range returns 206 with the exact first bytes',firstRange.status===206&&firstRange.headers.get('content-range')===`bytes 0-99/${videoBytes.length}`&&firstBytes.equals(videoBytes.subarray(0,100)),
      `status ${firstRange.status} · ${firstRange.headers.get('content-range')} · ${firstBytes.length} bytes`);
    const suffix=await call(base,{headers:{Range:'bytes=-64'}});
    const suffixBytes=Buffer.from(await suffix.arrayBuffer());
    ok('suffix range returns 206 with the exact final bytes',suffix.status===206&&suffix.headers.get('content-range')===`bytes ${videoBytes.length-64}-${videoBytes.length-1}/${videoBytes.length}`&&
      suffixBytes.equals(videoBytes.subarray(videoBytes.length-64)),`status ${suffix.status} · ${suffix.headers.get('content-range')} · ${suffixBytes.length} bytes`);
    const multiple=await call(base,{headers:{Range:'bytes=0-1,4-5'}});
    ok('multiple ranges are rejected instead of stitched',multiple.status===416,`status ${multiple.status}`);
    const beyond=await call(base,{headers:{Range:`bytes=${videoBytes.length}-`}});
    ok('an out-of-bounds range is 416',beyond.status===416,`status ${beyond.status}`);

    const anonymous=await call(base,{auth:false});
    ok('missing cookie is 401',anonymous.status===401,`status ${anonymous.status}`);
    const foreign=await call(mediaPath(mainVideo,{id:otherAgent,key:mainKey}),{});
    ok('a different agent cannot reuse the chat session',[403,404].includes(foreign.status),`status ${foreign.status}`);
    const missingSession=await call('/api/artifact-media'+query({agent,key:mainKey,id:mainVideo.id}));
    ok('a missing sessionId is rejected',[400,403,409,422].includes(missingSession.status),`status ${missingSession.status}`);
    const nonMedia=await call(mediaPath(byId('fixture-pdf')||{id:'fixture-pdf'}));
    ok('a non-media artifact is not served as media',nonMedia.status>=400&&nonMedia.status!==404||nonMedia.status===415,`status ${nonMedia.status}`);

    const workVideoPath=mediaPath(workVideo,{id:otherAgent,key:workKey,session:workSession});
    const workVideoResponse=await call(workVideoPath);
    ok('Work media is served with the Work sessionId',workVideoResponse.status===200&&(await source(workVideo)).equals(Buffer.from(await workVideoResponse.arrayBuffer())),`status ${workVideoResponse.status}`);
    const reset=await call('/api/fixture-work',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'reset'})});
    const stale=await call(workVideoPath);
    ok('a late media request after the Work session changed is refused',reset.ok&&[403,409].includes(stale.status),`status ${stale.status}`);
    const refreshed=await listingFor(otherAgent,workKey);
    const freshSession=refreshed.body?.sessionId;
    ok('Work describes the new real sessionId after the change',freshSession==='fixture-source-reset',String(freshSession));
    const fresh=await call(mediaPath(workVideo,{id:otherAgent,key:workKey,session:freshSession}));
    ok('the fresh Work session can read its authorized media',fresh.status===200,`status ${fresh.status}`);
    await call('/api/fixture-work',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'restore'})});

    const normal=await call('/api/artifact-download'+query({agent,key:mainKey,sessionId:mainSession,id:mainVideo.id}));
    const normalBytes=Buffer.from(await normal.arrayBuffer());
    ok('normal /api/artifact-download preserves the original bytes',normal.status===200&&normalBytes.equals(videoBytes),`status ${normal.status} · ${normalBytes.length}/${videoBytes.length} bytes`);

    if(!apiReady)skip('native browser playback','the media endpoint is not mounted');
  }catch(error){
    fail++;console.log('FAIL media HTTP contract · '+error.stack);
  }

  // UI: Entregables and Work each own their own opener. The same primitives
  // render inside the chat dialog and inside the Work reader.
  let dialog=null, chatVideoButton=null, chatImageButton=null;
  try{
    await page.locator('#input').fill('Borrador intacto de la prueba multimedia.');
    await page.locator('#input').blur();
    if(!await page.locator('#hub-artifacts').evaluate(element=>element.open))await tap('#hub-artifacts > summary');
    await wait(async()=>await page.locator('#hub-artifacts .ha-artifact').count()>=4,9000);
    chatImageButton=page.getByRole('button',{name:'Ver imagen: '+mainImage.title,exact:true});
    chatVideoButton=page.getByRole('button',{name:'Ver vídeo: '+mainVideo.title,exact:true});
    const imageCount=await chatImageButton.count();
    const videoCount=await chatVideoButton.count();
    ok('Entregables offers «Ver imagen: título» for the PNG',imageCount===1,`found ${imageCount}`);
    ok('Entregables offers «Ver vídeo: título» for the MP4',videoCount===1,`found ${videoCount}`);
    if(imageCount===1){
      const openerLabel=await chatImageButton.getAttribute('aria-label');
      await tap(chatImageButton);
      dialog=page.locator('#hub-artifact-viewer');
      if(await wait(async()=>await dialog.evaluate(element=>element.open),6000)){
        ok('image opens #hub-artifact-viewer[open]',true);
        ok('image viewer uses .av-media-image',await dialog.locator('.av-media-image').count()===1,String(await dialog.locator('.av-media-image').count()));
        const state=await dialog.locator('.av-media-image').first().evaluate(image=>({src:image.currentSrc||image.src,complete:image.complete,width:image.naturalWidth,height:image.naturalHeight}));
        ok('image decodes the real PNG dimensions',state.complete&&state.width===mainImage.width&&state.height===mainImage.height,JSON.stringify(state));
        const target=new URL(state.src,origin);
        ok('image source is /api/artifact-media with the real sessionId',target.pathname==='/api/artifact-media'&&target.searchParams.get('sessionId')===mainSession,
          target.pathname+' · '+target.searchParams.get('sessionId'));
        const controls=await fit(dialog);
        ok('image viewer controls keep 44 px hit targets',controls.total>0&&controls.small===0&&controls.outside===0,JSON.stringify(controls));
        if(keep)await page.screenshot({path:path.join(directory,'media-chat-image.png')});
        const original=await download(dialog.getByRole('link',{name:'Descargar el original'}),mainImage);
        ok('image original downloads intact',original.name===mainImage.title&&Boolean(original.bytes)&&original.bytes.equals(await source(mainImage)),
          (original.name||original.error)+' · '+original.bytes?.length);
        await tap(dialog.getByRole('button',{name:'Cerrar vista previa'}));
        await wait(async()=>await dialog.count()===0,4000);
        ok('closing the image restores focus and keeps the draft',await page.evaluate(label=>document.activeElement?.getAttribute('aria-label')===label,openerLabel)&&
          await page.locator('#input').inputValue()==='Borrador intacto de la prueba multimedia.');
        ok('image viewer is removed from the dialog',await page.locator('#hub-artifact-viewer').count()===0);
      }else ok('image opens #hub-artifact-viewer[open]',false,'dialog did not open');
    }else skip('image viewer checks','no Entregables image action');
    if(videoCount===1){
      const openerLabel=await chatVideoButton.getAttribute('aria-label');
      await tap(chatVideoButton);
      dialog=page.locator('#hub-artifact-viewer');
      if(await wait(async()=>await dialog.evaluate(element=>element.open),6000)){
        ok('video opens #hub-artifact-viewer[open]',true);
        ok('video viewer uses .av-media-video',await dialog.locator('.av-media-video').count()===1,String(await dialog.locator('.av-media-video').count()));
        const sourceInfo=await dialog.locator('.av-media-video').evaluate(video=>({src:video.currentSrc||video.src}));
        const target=new URL(sourceInfo.src,origin);
        ok('video source is /api/artifact-media with the real sessionId',target.pathname==='/api/artifact-media'&&target.searchParams.get('sessionId')===mainSession,
          target.pathname+' · '+target.searchParams.get('sessionId'));
        const player=await videoPlay(dialog,'#hub-artifact-viewer .av-media-video','chat video');
        const controls=await fit(dialog);
        ok('video viewer controls keep 44 px hit targets',controls.total>0&&controls.small===0&&controls.outside===0,JSON.stringify(controls));
        if(keep)await page.screenshot({path:path.join(directory,'media-chat-video.png')});
        const original=await download(dialog.getByRole('link',{name:'Descargar el original'}),mainVideo);
        ok('video original downloads intact',original.name===mainVideo.title&&Boolean(original.bytes)&&original.bytes.equals(await source(mainVideo)),
          (original.name||original.error)+' · '+original.bytes?.length);
        if(player)await player.evaluate(video=>{window.__closedMediaVideo=video;});
        await tap(dialog.getByRole('button',{name:'Cerrar vista previa'}));
        await wait(async()=>await dialog.count()===0,4000);
        const cleanup=await page.evaluate(()=>{
          const video=window.__closedMediaVideo;
          return video?{connected:video.isConnected,src:video.getAttribute('src'),current:video.currentSrc||'',network:video.networkState,paused:video.paused}:null;
        });
        ok('closing the video clears its source and leaves no player behind',!cleanup||!cleanup.connected||(!cleanup.src&&!cleanup.current),JSON.stringify(cleanup));
        ok('closing the video restores focus and keeps the draft',await page.evaluate(label=>document.activeElement?.getAttribute('aria-label')===label,openerLabel)&&
          await page.locator('#input').inputValue()==='Borrador intacto de la prueba multimedia.');
      }else ok('video opens #hub-artifact-viewer[open]',false,'dialog did not open');
    }else skip('video viewer checks','no Entregables video action');
  }catch(error){
    fail++;console.log('FAIL Entregables multimedia UI · '+(error.stack||error.message));
  }

  try{
    if(dialog&&await dialog.count())await page.keyboard.press('Escape').catch(()=>{});
    await page.locator('#input').fill('Borrador intacto de la prueba multimedia.');
    await page.evaluate(()=>closeNav()).catch(()=>{});
    await tap('#hub-chat-more');
    await tap('#btn-pending-questions');
    await page.locator('#work-inbox').waitFor({state:'visible',timeout:7000});
    await page.waitForFunction(()=>window.HubWorkInbox?.enabled(),undefined,{timeout:5000});
    await tap('#work-tab-review');
    const list=page.locator('#work-list');
    await wait(async()=>await list.locator('.work-file').count()>=2,9000);
    const labels=await list.locator('.work-file .work-card-main').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')||''));
    ok('Work exposes only the two media files authorized for its session',
      labels.length===2&&labels.every(label=>label.includes(workImage.title)||label.includes(workVideo.title))&&
      !labels.some(label=>label.includes(mainImage.title)||label.includes(mainVideo.title)),labels.join(' | '));
    const imageRow=page.locator('#work-list .work-file').filter({hasText:workImage.title}).first().locator('.work-card-main');
    const videoRow=page.locator('#work-list .work-file').filter({hasText:workVideo.title}).first().locator('.work-card-main');
    const imageLabel=await imageRow.getAttribute('aria-label').catch(()=>null);
    const videoLabel=await videoRow.getAttribute('aria-label').catch(()=>null);
    ok('Work uses «Ver imagen · título …» for its image',Boolean(imageLabel?.startsWith('Ver imagen · '+workImage.title+' · ')),String(imageLabel));
    ok('Work uses «Ver vídeo · título …» for its video',Boolean(videoLabel?.startsWith('Ver vídeo · '+workVideo.title+' · ')),String(videoLabel));
    if(imageLabel?.startsWith('Ver imagen · ')){
      await tap(imageRow);
      await wait(async()=>await page.locator('#work-reader').isVisible(),7000);
      await wait(async()=>await page.locator('#work-reader .av-media-image').count()===1,5000);
      ok('Work image reuses #work-reader instead of a second dialog',await page.locator('#work-reader .av-media-image').count()===1,String(await page.locator('#work-reader .av-media-image').count()));
      await imageShown(page.locator('#work-reader'),'Work image',workImage);
      const workControls=await fit(page.locator('#work-reader'));
      ok('Work image controls keep 44 px hit targets',workControls.total>0&&workControls.small===0&&workControls.outside===0,JSON.stringify(workControls));
      if(await page.locator('#work-reader-options').isHidden())await tap('#work-reader-options-button');
      const original=await download(page.locator('#work-reader-download'),workImage);
      ok('Work image downloads the original intact',original.name===workImage.title&&Boolean(original.bytes)&&original.bytes.equals(await source(workImage)),
        (original.name||original.error)+' · '+original.bytes?.length);
      await tap('#work-reader-back');
      await wait(async()=>await page.locator('#work-reader').isHidden(),5000);
      ok('Work image closes back to the file list with focus restored',await page.evaluate(label=>document.activeElement?.getAttribute('aria-label')===label,imageLabel));
    }else skip('Work image viewer checks','Work image action is missing');
    if(videoLabel?.startsWith('Ver vídeo · ')){
      await tap(videoRow);
      await wait(async()=>await page.locator('#work-reader').isVisible(),7000);
      const sourceInfo=await page.locator('#work-reader .av-media-video').evaluate(video=>({src:video.currentSrc||video.src}));
      const target=new URL(sourceInfo.src,origin);
      ok('Work video source is /api/artifact-media with the Work sessionId',target.pathname==='/api/artifact-media'&&target.searchParams.get('sessionId')===workSession,
        target.pathname+' · '+target.searchParams.get('sessionId'));
      const player=await videoPlay(page.locator('#work-reader'),'#work-reader .av-media-video','Work video');
      const workControls=await fit(page.locator('#work-reader'));
      ok('Work video controls keep 44 px hit targets',workControls.total>0&&workControls.small===0&&workControls.outside===0,JSON.stringify(workControls));
      if(await page.locator('#work-reader-options').isHidden())await tap('#work-reader-options-button');
      const original=await download(page.locator('#work-reader-download'),workVideo);
      ok('Work video downloads the original intact',original.name===workVideo.title&&Boolean(original.bytes)&&original.bytes.equals(await source(workVideo)),
        (original.name||original.error)+' · '+original.bytes?.length);
      if(player)await player.evaluate(video=>{window.__closedWorkVideo=video;});
      await tap('#work-reader-back');
      await wait(async()=>await page.locator('#work-reader').isHidden(),5000);
      const cleanup=await page.evaluate(()=>{
        const video=window.__closedWorkVideo;
        return video?{connected:video.isConnected,src:video.getAttribute('src'),current:video.currentSrc||'',paused:video.paused}:null;
      });
      ok('Work video clears its source when leaving the reader',!cleanup||!cleanup.connected||(!cleanup.src&&!cleanup.current),JSON.stringify(cleanup));
      ok('Work video returns focus to the exact file row',await page.evaluate(label=>document.activeElement?.getAttribute('aria-label')===label,videoLabel));
    }else skip('Work video viewer checks','Work video action is missing');
    await page.locator('#work-inbox').getByRole('button',{name:'Volver al chat',exact:true}).click().catch(async()=>{await page.keyboard.press('Escape');});
    await wait(async()=>await page.locator('#work-inbox').isHidden(),5000);
    ok('Work keeps the chat draft and does not navigate away',await page.locator('#input').inputValue()==='Borrador intacto de la prueba multimedia.'&&page.url()===origin+'/');
  }catch(error){
    fail++;console.log('FAIL Work multimedia UI · '+(error.stack||error.message));
  }

  ok('no external navigation during multimedia review',outside.length===0,outside.join(','));
  ok('no renderer exception during multimedia review',errors.length===0,errors.slice(-4).join(' | '));
  console.log(`RESULT ${pass} PASS · ${fail} FAIL · ${skipped} SKIP · multimedia · ${linux?'Electron instalado':pc?'Chrome PC':appMode?'Chrome modo app táctil':'Chromium táctil'} · loopback`);
  if(fail)process.exitCode=1;
}

(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'hub-readonly-viewer-'));
  execFileSync('python3',[path.join(root,'tools/hub-artifact-viewer-fixtures.py'),directory,...(media?['--media']:[])]);
  const httpPort=await port(); origin='http://127.0.0.1:'+httpPort;
  service=spawn(process.execPath,[path.join(root,'tools/hub-documents-preview.cjs'),String(httpPort),path.join(directory,'data')],
    {env:cleanEnv({HUB_FIXTURE_PREVIEWS:directory,...(work||media?{HUB_FIXTURE_WORK:'1'}:{}),...(media?{HUB_FIXTURE_MEDIA:'1'}:{})}),stdio:['ignore','pipe','pipe']});
  service.stderr.on('data',data=>log.push(String(data).trim().slice(0,350)));
  await until(async()=> (await fetch(origin+'/healthz')).ok,'fixture server did not start');
  if(linux){
    const profile=path.join(directory,'profile');await fs.mkdir(profile);const nativeDownloads=path.join(directory,'native');await fs.mkdir(nativeDownloads);
    await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({directory:nativeDownloads}));
    const debug=await port();
    desktop=spawn(process.env.HUB_LINUX_LAUNCHER||path.join(os.homedir(),'.local/bin/openclaw-hub-desktop'),['--ozone-platform=x11','--remote-debugging-port='+debug,'--remote-debugging-address=127.0.0.1'],{
      env:cleanEnv({HUB_URL:origin+'/',HUB_USER_DATA_DIR:profile,XDG_CONFIG_HOME:path.join(directory,'config'),XDG_STATE_HOME:path.join(directory,'state'),DBUS_SESSION_BUS_ADDRESS:'unix:path='+path.join(directory,'absent'),GDK_BACKEND:'x11'}),stdio:'ignore'});
    const cdp='http://127.0.0.1:'+debug;
    await until(async()=> (await fetch(cdp+'/json/list').then(r=>r.json())).some(t=>t.url===origin+'/'),'installed Electron WebContentsView');
    browser=await chromium.connectOverCDP(cdp,{timeout:6000});context=browser.contexts()[0];
    page=await until(()=>context.pages().find(p=>p.url()===origin+'/'),'native test page');
    const session=await context.newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride',{width:1360,height:870,deviceScaleFactor:1,mobile:false});
    const shell=await until(()=>context.pages().find(p=>p.url().endsWith('/shell.html')),'native shell');
    const expected=(await fs.readFile(path.join(root,'desktop/VERSION'),'utf8')).trim();
    await shell.waitForFunction(v=>document.getElementById('app-version')?.textContent===v,expected);
    check('installed Hub Linux '+expected+' runs the isolated fixture',true);
  }else if(appMode){
    const profile=path.join(directory,'chrome');await fs.mkdir(profile);
    const env=cleanEnv({XDG_DATA_HOME:path.join(directory,'share'),XDG_CONFIG_HOME:path.join(directory,'config'),XDG_STATE_HOME:path.join(directory,'state'),DBUS_SESSION_BUS_ADDRESS:'unix:path='+path.join(directory,'absent'),GDK_BACKEND:'x11'});
    desktop=spawn(process.env.CHROMIUM_PATH||chromium.executablePath(),['--user-data-dir='+profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--ozone-platform=x11','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--no-proxy-server','--window-size=1024,850','--app='+origin+'/'],{env,stdio:'ignore'});
    const cdp=await until(async()=>{const n=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return /^\d+$/.test(n)?'http://127.0.0.1:'+n:null;},'isolated Chrome in app mode');
    browser=await chromium.connectOverCDP(cdp);context=browser.contexts()[0];
    page=await until(()=>context.pages().find(p=>p.url()===origin+'/'),'standalone window');
    const session=await context.newCDPSession(page);
    await session.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await session.send('Emulation.setDeviceMetricsOverride',{width:390,height:740,deviceScaleFactor:2,mobile:true});
    await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
    check('standalone Chrome container with software touch and Hub worker',await page.evaluate(()=>matchMedia('(display-mode: standalone)').matches&&matchMedia('(pointer: coarse)').matches&&!!navigator.serviceWorker.controller));
  }else{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||chromium.executablePath(),headless:true,env:cleanEnv(),args:['--no-proxy-server','--disable-background-networking']});
    context=await browser.newContext({viewport:pc?{width:1440,height:900}:{width:390,height:740},isMobile:!pc,hasTouch:!pc,deviceScaleFactor:pc?1:2,acceptDownloads:true,serviceWorkers:'block'});
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():(outside.push(new URL(route.request().url()).origin),route.abort()));
    page=await context.newPage();
  }
  page.setDefaultTimeout(6500);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['warning','error'].includes(m.type()))log.push(m.text().slice(0,260));});
  page.on('request',r=>{const u=new URL(r.url());if((appMode||linux)&&!['file:','data:'].includes(u.protocol)&&u.origin!==origin)outside.push(u.origin);if(r.method()!=='GET'&&u.pathname.startsWith('/api/'))altered.push(r.method()+':'+u.pathname);});
  if(!linux&&!appMode)await page.goto(origin+'/');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state.historyLoading&&!!state.current&&state.ws?.readyState===1);
  await page.locator(work?'#hub-chat-more':'#hub-artifacts > summary').waitFor();
  await page.evaluate(()=>closeNav());
  if(!linux&&!pc)await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=.5);
  const finger=appMode?await context.newCDPSession(page):null;
  async function press(s){
    const node=typeof s==='string'?page.locator(s):s;
    await node.scrollIntoViewIfNeeded();
    if(!finger)return linux||pc?node.click():node.tap();
    const point=await until(()=>node.evaluate(e=>{
      const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      return !e.disabled && r.height>=1 && e.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    },undefined,{timeout:1200}),'touch target is in the visible frame');
    await finger.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
    await finger.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  if(media){await mediaSuite();return;}
  if(work){
    await page.waitForFunction(()=>window.HubWorkInbox?.enabled());
    const overlay=page.locator('#work-inbox'), overview=page.locator('#work-overview'), reader=page.locator('#work-reader');
    const list=page.locator('#work-list'), panel=page.locator('#work-panel'), search=overlay.getByRole('searchbox');
    const attentionTab=page.locator('#work-tab-attention'), reviewTab=page.locator('#work-tab-review');
    const workButton=page.locator('#btn-pending-questions'), workMenu=page.locator('#hub-chat-more');
    const manifest=JSON.parse(await fs.readFile(path.join(directory,'fixtures.json'),'utf8')).reader;
    const titles=manifest.map(item=>item.title).sort((a,b)=>b.length-a.length);
    const idFor=title=>manifest.find(item=>item.title===title)?.id;
    const titleFromLabel=label=>titles.find(value=>label.startsWith('Leer · '+value+' ·')||label.startsWith('Ver opciones · '+value+' ·'))||null;
    const labels=()=>list.locator('.work-file .work-card-main').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')||node.textContent.trim()));
    const rowTitles=async()=>(await labels()).map(titleFromLabel).filter(Boolean);
    const position=async()=>(await page.locator('#work-reader-position').innerText()).replace(/\s+/gu,' ').trim();
    const readerTitle=async()=>(await page.locator('#work-reader-title').innerText()).trim();
    const scroll=()=>panel.evaluate(node=>node.scrollTop);
    const rowFor=title=>list.locator('.work-file').filter({hasText:title}).first();
    const mainFor=title=>rowFor(title).locator('.work-card-main');
    const original=title=>fs.readFile(path.join(directory,title));
    async function exactWorkDownload(title){
      const source=await original(title), link=page.locator('#work-reader-download');
      if(linux){
        await press(link);
        return Boolean(await until(async()=>{
          const result=await fs.readFile(path.join(directory,'native',title));
          return result.equals(source);
        },'Linux manager saves the selected original',9000));
      }
      const event=page.waitForEvent('download');await press(link);const file=await event;
      return file.suggestedFilename()===title&&(await fs.readFile(await file.path())).equals(source);
    }
    const artifactReads=[];
    page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/artifact-download')artifactReads.push(url.searchParams.get('id'));});
    const touch=!linux&&!pc?await context.newCDPSession(page):null;
    if(touch){
      await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
      await page.setViewportSize({width:390,height:760});
      await page.waitForFunction(()=>innerWidth===390&&innerHeight===760);
    }
    async function tap(target){
      const node=typeof target==='string'?page.locator(target):target;
      await node.scrollIntoViewIfNeeded();
      if(!touch)return press(node);
      const point=await until(()=>node.evaluate(element=>{
        const box=element.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
        return !element.disabled&&box.width>=1&&box.height>=1&&element.contains(document.elementFromPoint(x,y))?{x,y}:null;
      },undefined,{timeout:1600}),'touch target is in the visible frame');
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:2,radiusY:2,force:1}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }
    async function openWork(){await tap(workMenu);await tap(workButton);}
    const openReader=async title=>{
      await tap(mainFor(title));
      await reader.waitFor();
      await until(async()=>await readerTitle()===title,'reader title '+title,9000);
    };
    const settleHistory=async()=>{if(!touch)return;await page.waitForFunction(()=>!history.state?.hubWorkPreview,undefined,{timeout:2500}).catch(()=>{});await pause(80);};
    const backToFiles=async()=>{await tap('#work-reader-back');await overview.waitFor();await reader.waitFor({state:'hidden'});await settleHistory();};
    const draft='El borrador de Primary no debe desaparecer al abrir la bandeja.';
    await page.locator('#input').fill(draft);await page.locator('#input').blur();
    await tap(workMenu);
    check('the disclosure holds Work and the granted Doc action without a second toolbar row',
      await workButton.getAttribute('aria-label')==='Work · Mi trabajo'&&await page.locator('#hub-chat-doc-slot #hub-documents-entry').isVisible()&&
      await workMenu.evaluate(e=>[...e.parentElement.querySelectorAll(':scope > button')].filter(b=>b.getClientRects().length).length===1));
    const documents=page.locator('#hub-documents');
    for(const docAction of ['#hub-documents-entry','#hub-documents-trigger']){
      await tap(docAction);await documents.waitFor();await tap('#hub-documents .hd-back');await documents.waitFor({state:'hidden'});
      check('Doc returns to the disclosure and preserves the composer draft ('+docAction+')',
        await workMenu.evaluate(e=>e===document.activeElement&&e.getAttribute('aria-expanded')==='false')&&await page.locator('#input').inputValue()===draft);
      if(docAction==='#hub-documents-entry')await tap(workMenu);
    }
    await openWork();await overlay.waitFor();
    await tap(attentionTab);
    await overlay.getByText('¿Qué versión quieres revisar?',{exact:true}).waitFor();
    check('questions from another agent appear before any file work',await attentionTab.getAttribute('aria-selected')==='true'&&await page.locator('#input').inputValue()===draft);
    const agentPicker=overlay.getByRole('combobox',{name:'Agente',exact:true});
    check('the personal inbox explains that opening is not sharing and starts with every allowed agent',
      await agentPicker.inputValue()===''&&await overlay.getByText('Tu bandeja personal. Abrir un archivo no lo comparte.',{exact:true}).isVisible()&&
      (await agentPicker.locator('option').evaluateAll(els=>els.map(e=>e.value).sort())).join()===',assistant-demo,primary-demo');
    await agentPicker.selectOption('primary-demo');
    check('the agent filter applies also to incoming questions',await overlay.getByText('¿Qué versión quieres revisar?',{exact:true}).count()===0&&await attentionTab.locator('b').isHidden());
    await tap(overlay.getByRole('button',{name:'Ver 1 pendiente de otro agente'}));
    check('hidden requests are explained and reachable with one action without answering',await agentPicker.inputValue()===''&&await overlay.getByRole('button',{name:/Ver pregunta · ¿Qué versión/}).evaluate(e=>e===document.activeElement));
    const question=overlay.getByRole('button',{name:/Ver pregunta · ¿Qué versión/});
    check('a pending question identifies its actual agent, not the agent of the open chat',
      await question.locator('.work-agent-name').textContent()==='Assistant · Ensayo'&&await question.locator('.work-agent-avatar').textContent()==='🧰');
    await tap(overlay.locator('.work-card-main').filter({hasText:'¿Qué versión quieres revisar?'}));
    await page.locator('#prompts [data-prompt-key]').first().waitFor();
    await until(()=>page.evaluate(()=>document.activeElement?.closest('#prompts')!==null),'prompt receives focus',2500).catch(()=>{});
    check('opening attention only focuses the original prompt and never answers it',await page.evaluate(()=>document.activeElement?.closest('#prompts')!==null)&&!altered.some(value=>/POST:\/api\/(question|approval|async-question)\b/u.test(value)));
    await pause(150);await openWork();await overlay.waitFor();
    await tap(reviewTab);
    check('the review tab is labelled Archivos',/^Archivos(?:\s+\d+)?$/u.test((await reviewTab.innerText()).replace(/\s+/gu,' ').trim()));
    await until(async()=>await list.locator('.work-file').count()>=8,'file rows',9000);
    if(!touch){
      const geometry=await page.evaluate(()=>{
        const box=s=>document.querySelector(s).getBoundingClientRect();
        const a=box('#work-agent'),t=box('.work-tabs'),f=box('#work-search'),d=box('#work-inbox');
        return {width:d.width,fit:a.height>=44&&f.height>=44&&a.right<t.left&&t.right<f.left&&Math.abs(a.y-f.y)<2};
      });
      check('desktop uses a wide list and one aligned toolbar for agent, tabs and search',geometry.width>=800&&geometry.fit);
      if(pc){
        await page.setViewportSize({width:768,height:700});
        const fit=await page.evaluate(()=>{
          const w=document.querySelector('#work-inbox').getBoundingClientRect(),a=document.querySelector('#work-agent').getBoundingClientRect(),f=document.querySelector('#work-search').getBoundingClientRect();
          return w.x>=0&&w.right<=innerWidth&&f.top>a.bottom&&f.right<=w.right&&document.documentElement.scrollWidth===innerWidth;
        });check('split-window desktop fits without hiding search or overflowing the page',fit);
        await page.setViewportSize({width:1440,height:900});
      }
    }
    const shape=await list.evaluate(root=>{const rows=[...root.querySelectorAll('.work-file')];return{rows:rows.length,bad:rows.filter(row=>row.getAttribute('role')!=='listitem'||row.querySelectorAll('.work-card-main').length!==1||row.querySelectorAll('button,a').length!==1).length,short:rows.filter(row=>{const main=row.querySelector('.work-card-main');return !main||main.getBoundingClientRect().height<44;}).length};});
    const allLabels=await labels();
    check('each file is one listitem with a single Leer or Ver opciones button and no chat/download action',
      shape.rows>=8&&shape.bad===0&&shape.short===0&&allLabels.length===shape.rows&&
      allLabels.every(label=>/^(Leer|Ver opciones) · .+ · .+$/u.test(label))&&
      allLabels.every(label=>!/Ir al chat|Descargar/u.test(label))&&
      allLabels.filter(label=>label.includes('Acuerdo estructurado.docx')&&label.includes('Assistant')).length===1);
    const allOwners=await list.locator('.work-file-owner').allTextContents();
    check('agent names are distinct from chat titles and file formats',new Set(allOwners).size===2&&allOwners.some(s=>s.includes('Assistant'))&&allOwners.some(s=>s.includes('Primary'))&&
      await list.locator('.work-file-source').count()===allOwners.length&&await list.locator('.work-file-format').count()===allOwners.length);
    const chatAgent=await page.evaluate(()=>state.agent);
    await agentPicker.selectOption('primary-demo');
    const buOwners=await list.locator('.work-file-owner').allTextContents();
    check('the agent filter changes files and tab count without navigating the chat',buOwners.length>0&&buOwners.length<allOwners.length&&
      buOwners.every(s=>s.includes('Primary'))&&Number(await reviewTab.locator('b').textContent())===buOwners.length&&await page.evaluate(()=>state.agent)===chatAgent);
    await agentPicker.selectOption('assistant-demo');
    await search.fill('acta comision seguimiento');await search.blur();
    await until(async()=>await list.locator('.work-file').count()===3,'three similar versions',7000);
    const similar=await rowTitles();
    check('the filter finds exactly the three near-identical long versions',similar.length===3&&new Set(similar).size===3&&similar.every(title=>title.includes('Acta de la comisión de seguimiento')&&title.length>100));
    const first=similar[0],second=similar[1],third=similar[2];
    const firstMain=mainFor(first);await firstMain.scrollIntoViewIfNeeded();
    const firstLabel=await firstMain.getAttribute('aria-label');
    const scrollBefore=await scroll(),historyBefore=await page.evaluate(()=>history.length);
    const stateBefore=await page.evaluate(()=>({agent:state.agent,current:state.current,url:location.href,input:document.getElementById('input').value}));
    await tap(firstMain);await reader.waitFor();
    check('the reader replaces only the list inside the same dialog',await overlay.isVisible()&&await overview.isHidden()&&await reader.isVisible());
    await until(async()=>await readerTitle()===first,'first exact title');
    await until(async()=>await reader.locator('canvas').count()>0,'first PDF canvas',16000);
    if(!touch)check('desktop gives the existing reader more usable width than the list',await overlay.evaluate((e,w)=>e.clientWidth>w+30,960));
    await until(async()=>!/Abriendo|Mostrando/u.test(await page.locator('#work-reader-status').innerText()),'first PDF settles',16000);
    const firstPixel=await reader.locator('canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width/2),Math.round(canvas.height*.25),1,1).data));
    check('the full long name, origin and drawn PDF identify the exact version',await readerTitle()===first&&(await page.locator('#work-reader-origin').innerText()).includes('Assistant')&&firstPixel[0]>190&&firstPixel[1]<90&&firstPixel[2]<110);
    check('the position counter reflects the frozen filtered result set',/^1\s+de\s+3\b/u.test(await position()));
    check('options and actions stay collapsed until asked',await page.locator('#work-reader-options').isHidden()&&await page.locator('#work-reader-options-button').getAttribute('aria-expanded')==='false');
    await tap('#work-reader-options-button');await page.locator('#work-reader-options').waitFor();
    const href=await page.locator('#work-reader-download').getAttribute('href'),originalUrl=new URL(href,origin);
    check('Opciones exposes exact download and chat only for the revalidated file',
      await page.locator('#work-reader-options').isVisible()&&await page.locator('#work-reader-download').isVisible()&&await page.locator('#work-reader-chat').isVisible()&&
      originalUrl.pathname==='/api/artifact-download'&&originalUrl.searchParams.get('id')===idFor(first)&&originalUrl.searchParams.get('sessionId')==='fixture-source-v2'&&originalUrl.searchParams.get('agent')==='assistant-demo');
    check('the reader download is byte-for-byte the exact original PDF',await exactWorkDownload(first));
    await tap('#work-reader-options-button');
    const historyAfter=await page.evaluate(()=>history.length);
    let mark=artifactReads.length;
    await tap('#work-reader-next');
    await until(async()=>await readerTitle()===second,'second exact title');
    await until(async()=>artifactReads.length>mark,'second exact read');
    await until(async()=>{const canvas=reader.locator('canvas');if(!await canvas.count())return false;const pixel=await canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(Math.round(c.width/2),Math.round(c.height*.25),1,1).data));return pixel[2]>150&&pixel[0]<80;},'second PDF rendered',16000);
    check('Siguiente revalidates and fetches only the exact next id',artifactReads.slice(mark).every(id=>id===idFor(second))&&/^2\s+de\s+3\b/u.test(await position()));
    mark=artifactReads.length;
    await tap('#work-reader-next');
    await until(async()=>await readerTitle()===third,'third exact title');
    await until(async()=>artifactReads.length>mark,'third exact read');
    await until(async()=>{const canvas=reader.locator('canvas');if(!await canvas.count())return false;const pixel=await canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(Math.round(c.width/2),Math.round(c.height*.25),1,1).data));return pixel[1]>130&&pixel[0]<80;},'third PDF rendered',16000);
    check('the last result disables Siguiente and keeps the frozen total',artifactReads.slice(mark).every(id=>id===idFor(third))&&/^3\s+de\s+3\b/u.test(await position())&&await page.locator('#work-reader-next').evaluate(button=>button.disabled||button.getAttribute('aria-disabled')==='true'));
    mark=artifactReads.length;
    await tap('#work-reader-prev');
    await until(async()=>await readerTitle()===second,'previous exact title');
    await until(async()=>artifactReads.length>mark,'previous exact read');
    check('Anterior walks the frozen results without reopening the dialog',artifactReads.slice(mark).every(id=>id===idFor(second))&&/^2\s+de\s+3\b/u.test(await position())&&await overlay.isVisible());
    check('three reader traversals never touch the chat, URL, draft or history',await page.evaluate(({length,agent,current,url,input})=>state.agent===agent&&state.current===current&&location.href===url&&history.length===length&&document.getElementById('input').value===input,{length:historyAfter,agent:stateBefore.agent,current:stateBefore.current,url:stateBefore.url,input:stateBefore.input})&&await overlay.isVisible());
    if(keep)await page.screenshot({path:path.join(directory,'work-390-reader-pdf.png')});
    await tap('#work-reader-back');await overview.waitFor();
    check('the exact agent filter survives returning from the reader',await agentPicker.inputValue()==='assistant-demo');
    check('← Archivos restores the filter, scroll and opening focus',await reader.isHidden()&&await search.inputValue()==='acta comision seguimiento'&&Math.abs((await scroll())-scrollBefore)<=1&&await page.evaluate(label=>document.activeElement?.matches('.work-card-main')&&document.activeElement.getAttribute('aria-label')===label,firstLabel));
    if(keep)await page.screenshot({path:path.join(directory,'work-390-files.png')});
    await agentPicker.selectOption('');
    await search.fill('Presupuesto consolidado');await search.blur();
    await until(async()=>await list.locator('.work-file').count()===1,'Excel row',6000);
    const budgetTitle=titleFromLabel((await labels())[0]);
    await openReader(budgetTitle);
    await reader.locator('.av-grid').waitFor({timeout:16000});
    check('Excel content keeps the .av-grid inside the reader body',await page.locator('#work-reader-body .av-grid').isVisible());
    if(keep)await page.screenshot({path:path.join(directory,'work-390-reader-excel.png')});
    await backToFiles();
    await search.fill('Contrato de suministro');await search.blur();
    await until(async()=>await list.locator('.work-file').count()===1,'Word row',6000);
    const contractTitle=titleFromLabel((await labels())[0]);
    await openReader(contractTitle);
    await reader.locator('.av-word').waitFor({timeout:16000});
    check('Word content keeps the .av-word inside the reader body',await reader.locator('.av-word').getByText('Pago de ejemplo',{exact:true}).isVisible());
    await backToFiles();
    await search.fill('acta comision seguimiento');await search.blur();
    await until(async()=>await list.locator('.work-file').count()===3,'three versions again',6000);
    const slowTitle=second;
    let held=false,release,settled=false;
    const gate=new Promise(resolve=>release=resolve);
    const holdMetadata=async route=>{held=true;await gate;try{await route.continue();}catch{}finally{settled=true;}};
    const revalidating=url=>(url.pathname==='/api/artifacts'||url.pathname==='/api/work-inbox/session')&&url.searchParams.get('agent')==='assistant-demo';
    await page.route(revalidating,holdMetadata);
    const readsBefore=artifactReads.length;
    try{
      await tap(mainFor(slowTitle));
      await until(()=>held,'metadata revalidation in flight',7000);
      check('an in-flight read clears every previous file from the reader',await readerTitle()===slowTitle&&await reader.locator('#work-reader-body canvas,.av-word,.av-grid').count()===0);
      await page.keyboard.press('Escape');await overview.waitFor();await reader.waitFor({state:'hidden'});await settleHistory();
      check('Escape during an in-flight read returns first to Archivos',await overlay.isVisible()&&await reader.isHidden());
      release();await until(()=>settled,'late revalidation settles',6000);await pause(150);
      check('a late read cannot reopen the reader or fetch its bytes',await reader.isHidden()&&artifactReads.length===readsBefore);
    }finally{release();await page.unroute(revalidating,holdMetadata);}
    if(touch){
      let browserHeld=false,browserRelease,browserSettled=false;
      const browserGate=new Promise(resolve=>browserRelease=resolve);
      const holdBrowserMetadata=async route=>{browserHeld=true;await browserGate;try{await route.continue();}catch{}finally{browserSettled=true;}};
      await page.route(revalidating,holdBrowserMetadata);
      const browserReads=artifactReads.length;
      try{
        await tap(mainFor(slowTitle));
        await until(()=>browserHeld,'browser-back metadata in flight',7000);
        await until(()=>page.evaluate(()=>Boolean(history.state?.hubWorkPreview)),'reader history entry exists',3000);
        await page.evaluate(()=>history.back());await overview.waitFor();await reader.waitFor({state:'hidden'});await settleHistory();
        check('browser Back during an in-flight read returns first to Archivos without closing the dialog',await overlay.isVisible()&&await reader.isHidden()&&await overview.isVisible());
        browserRelease();await until(()=>browserSettled,'late browser-back revalidation settles',6000);await pause(150);
        check('a late browser-back read cannot reopen the reader or fetch its bytes',await reader.isHidden()&&artifactReads.length===browserReads);
      }finally{browserRelease();await page.unroute(revalidating,holdBrowserMetadata);}
    }
    const failTitle=third;
    let heldBytes=false,releaseBytes;
    const byteGate=new Promise(resolve=>releaseBytes=resolve);
    const failBytes=async route=>{heldBytes=true;await byteGate;await route.fulfill({status:503,json:{error:'fallo ficticio de red'}});};
    const bytesFor=url=>url.pathname==='/api/artifact-download'&&url.searchParams.get('id')===idFor(failTitle);
    await page.route(bytesFor,failBytes);
    try{
      await tap(mainFor(failTitle));
      await until(()=>heldBytes,'file bytes in flight',8000);
      check('slow bytes never leave the previous file on screen',await readerTitle()===failTitle&&await reader.locator('#work-reader-body canvas,.av-word,.av-grid').count()===0);
      if(keep)await page.screenshot({path:path.join(directory,'work-390-reader-loading.png')});
      releaseBytes();
      await page.locator('#work-reader-status').filter({hasText:'No se pudo cargar el archivo'}).waitFor({timeout:10000});
      check('a failed read is explicit, keeps the exact download and shows no stale content',await reader.locator('#work-reader-body canvas,.av-word,.av-grid').count()===0&&await page.locator('#work-reader-download').getAttribute('href')!==null);
    }finally{releaseBytes();await page.unroute(bytesFor,failBytes);}
    await backToFiles();
    await search.fill('Notas internas');await search.blur();
    await until(async()=>await list.locator('.work-file').count()===1,'unsupported row',6000);
    const notesLabel=(await labels())[0],notesTitle=titleFromLabel(notesLabel);
    check('an unsupported type keeps Ver opciones as the only list action',Boolean(notesTitle)&&notesLabel.startsWith('Ver opciones · '+notesTitle));
    await openReader(notesTitle);
    await until(async()=>{const text=(await page.locator('#work-reader-status').innerText()).trim();return text.length>0&&!/^Abriendo/u.test(text);},'unsupported notice',9000);
    const unsupportedText=(await page.locator('#work-reader-status').innerText())+' '+(await page.locator('#work-reader-body').innerText());
    check('an unsupported type remains an explicit notice instead of a blank viewer',/no se puede|no disponible|no admite|no hay vista|descarg/iu.test(unsupportedText)&&await reader.locator('#work-reader-body canvas,.av-word,.av-grid').count()===0);
    if(await page.locator('#work-reader-options').isHidden())await tap('#work-reader-options-button');
    check('the unsupported notice keeps exact original download and chat after revalidation',await page.locator('#work-reader-download').isVisible()&&(await page.locator('#work-reader-download').innerText()).trim()==='Descargar original'&&await page.locator('#work-reader-chat').isVisible());
    check('the unsupported original downloads byte for byte',await exactWorkDownload(notesTitle));
    if(await page.locator('#work-reader-options').isVisible())await tap('#work-reader-options-button');
    await backToFiles();
    await search.fill('');await search.blur();
    await until(async()=>await list.locator('.work-file').count()>=8,'full list restored',7000);
    const maxScroll=await panel.evaluate(node=>node.scrollHeight-node.clientHeight);
    check('the file list scrolls in this viewport',maxScroll>40);
    await panel.evaluate(node=>node.scrollTop=node.scrollHeight);await pause(80);
    const visibleRows=await list.evaluate(root=>{const box=document.querySelector('#work-panel').getBoundingClientRect();return [...root.querySelectorAll('.work-file')].map((row,index)=>{const r=row.getBoundingClientRect(),main=row.querySelector('.work-card-main');return{index,label:main?.getAttribute('aria-label')||'',visible:r.top>=box.top+2&&r.bottom<=box.bottom-2,readable:main?.getAttribute('aria-label')?.startsWith('Leer · ')};}).filter(row=>row.visible);});
    const scrollTarget=visibleRows.map(row=>({...row,title:titleFromLabel(row.label)})).find(row=>row.title&&row.readable)||visibleRows.map(row=>({...row,title:titleFromLabel(row.label)})).find(row=>row.title);
    assert.ok(scrollTarget,'a visible scrolled file belongs to the synthetic fixtures');
    const scrollRow=list.locator('.work-file').nth(scrollTarget.index);
    const scrollMain=scrollRow.locator('.work-card-main');await scrollMain.scrollIntoViewIfNeeded();
    const scrollRowLabel=await scrollMain.getAttribute('aria-label'),scrollPosition=await scroll();
    assert.ok(scrollPosition>0,'the scrolled file is opened from a non-zero scroll position');
    await tap(scrollMain);await reader.waitFor();
    await until(async()=>((await page.locator('#work-reader-title').innerText()).trim())===scrollTarget.title,'scrolled file title',9000);
    await backToFiles();
    check('returning from a scrolled file restores the exact scroll and row focus',Math.abs((await scroll())-scrollPosition)<=1&&await page.evaluate(label=>document.activeElement?.matches('.work-card-main')&&document.activeElement.getAttribute('aria-label')===label,scrollRowLabel));
    const backChat=overlay.getByRole('button',{name:'Volver al chat',exact:true});
    const lastChat=await page.evaluate(()=>[state.agent,state.current]);
    await tap(backChat);await overlay.waitFor({state:'hidden'});
    await page.waitForFunction(()=>!history.state?.hubWork);
    check('the labelled Chat button returns to the same chat and returns focus to the more-actions trigger',await workMenu.evaluate(e=>e===document.activeElement)&&JSON.stringify(await page.evaluate(()=>[state.agent,state.current]))===JSON.stringify(lastChat));
    await openWork();await until(async()=>await list.locator('.work-file').count()>=8,'fresh list on reopen');
    check('reopening the inbox restores scroll after its fresh snapshot',Math.abs((await scroll())-scrollPosition)<=1);
    const activeTab=overlay.getByRole('tab',{name:/En curso/}), snapshot=url=>url.pathname==='/api/work-inbox';
    const secondAgent='Primary · Nombre largo de un agente de ensayo';
    const restoreCatalog=async()=>page.evaluate(()=>{
      Object.assign(state.agents.find(a=>a.id==='primary-demo'),globalThis.restoreWorkFixtureAgent);
      delete globalThis.restoreWorkFixtureAgent;window.HubWorkInbox.catalogChanged();
    });
    await page.evaluate(name=>{
      const profile=state.agents.find(a=>a.id==='primary-demo');globalThis.restoreWorkFixtureAgent={name:profile.name,emoji:profile.emoji};
      profile.name=name;profile.emoji='';window.HubWorkInbox.catalogChanged();
    },secondAgent);
    await page.route(snapshot,async route=>{
      const response=await route.fetch(),data=await response.json();
      const sample=data.active.find(r=>r.agent==='assistant-demo'&&r.title==='Contrato de ensayo');
      if(sample)data.active.push({...sample,agent:'primary-demo',key:'test-agent-label-key',sessionId:'test-agent-label-transcript',runId:'test-agent-label-run',trackable:false});
      await route.fulfill({response,json:data});
    });
    try{
      await tap(activeTab);
      await tap('#work-refresh');
      const assistant=overlay.getByRole('button',{name:'Abrir chat · Contrato de ensayo · Assistant · Ensayo',exact:true});
      const primary=overlay.getByRole('button',{name:'Abrir chat · Contrato de ensayo · '+secondAgent,exact:true});
      await assistant.waitFor();await primary.waitFor();
      check('two conversations with the same title show distinct catalogue names and emoji or initials',
        await assistant.locator('.work-agent-avatar').textContent()==='🧰'&&await primary.locator('.work-agent-avatar').textContent()==='PR'&&
        await assistant.locator('.work-agent-name').textContent()==='Assistant · Ensayo'&&await primary.locator('.work-agent-name').textContent()===secondAgent&&
        !(await assistant.locator('.work-session-details').textContent()).includes('Assistant'));
      const identityFits=(button,wide)=>button.evaluate((element,wide)=>{
        const rect=s=>element.querySelector(s).getBoundingClientRect();
        const owner=rect('.work-agent-identity'),title=rect('.work-label'),verb=rect('.work-row-verb'),card=element.getBoundingClientRect();
        const name=element.querySelector('.work-agent-name');
        return card.height>=44&&owner.left>=card.left&&verb.right<=card.right&&owner.right<=verb.left&&
          name.scrollWidth<=name.clientWidth+1&&(wide?owner.right<=title.left&&title.right<=verb.left:owner.bottom<=title.top);
      },wide);
      check('agent identifiers are visible, separate from title and action, in the natural window layout',await identityFits(primary,!touch));
      if(keep)await page.screenshot({path:path.join(directory,touch?'work-active-390.png':linux?'work-active-linux.png':'work-active-pc.png')});
      if(touch){
        await page.setViewportSize({width:320,height:620});await page.waitForFunction(()=>innerWidth===320);
        await primary.scrollIntoViewIfNeeded();
        check('320 px keeps the complete long agent name above the title and action tappable',await identityFits(primary,false));
        if(keep)await page.screenshot({path:path.join(directory,'work-active-320.png')});
        await page.setViewportSize({width:390,height:760});await page.waitForFunction(()=>innerWidth===390);
      }
    }finally{await page.unroute(snapshot);await restoreCatalog();}
    await agentPicker.selectOption('assistant-demo');await tap('#work-refresh');
    await tap(reviewTab);await search.fill('acta comision seguimiento');await search.blur();
    await tap(activeTab);
    await overlay.getByText('Chats activos',{exact:true}).waitFor();
    const openChat=overlay.getByRole('button',{name:'Abrir chat · Contrato de ensayo · Assistant · Ensayo',exact:true});
    const follow=overlay.getByRole('button',{name:'Seguir entrega · Contrato de ensayo · Assistant · Ensayo',exact:true});
    check('active chat rows make opening and following separate actions',await openChat.isVisible()&&await follow.isVisible());
    await tap(follow);
    await overlay.getByText('Entregas que sigo',{exact:true}).waitFor();
    check('a followed session keeps its agent separately from its date and delivery status',await openChat.locator('.work-agent-name').textContent()==='Assistant · Ensayo'&&
      await openChat.getAttribute('aria-description').then(label=>label?.includes('Esperando archivo')&&!label.includes('Assistant'))&&
      await overlay.getByRole('button',{name:'Dejar de seguir · Contrato de ensayo · Assistant · Ensayo',exact:true}).isVisible());
    await tap(backChat);await overlay.waitFor({state:'hidden'});await page.waitForFunction(()=>!history.state?.hubWork);
    await openWork();await overlay.getByText('Entregas que sigo',{exact:true}).waitFor();
    check('reopening remembers the last tab and agent, independent of the chat',await agentPicker.inputValue()==='assistant-demo'&&await reviewTab.getAttribute('aria-selected')==='false');
    await tap(openChat);await overlay.waitFor({state:'hidden'});await page.waitForFunction(()=>!history.state?.hubWork);
    check('opening the active chat focuses its title and does not answer or send',await page.locator('#chat-title').evaluate(e=>e===document.activeElement)&&await page.evaluate(()=>state.agent==='assistant-demo'));
    await openWork();await overlay.waitFor();
    await tap(reviewTab);await until(async()=>await list.locator('.work-file').count()===3,'retained file query');
    check('the file query survives switching tabs and closing to the chat',await search.inputValue()==='acta comision seguimiento');
    await agentPicker.selectOption('');await search.fill('');await search.blur();
    const focusMain=list.locator('.work-file').first().locator('.work-card-main');
    const focusLabel=await focusMain.getAttribute('aria-label');await focusMain.focus();
    const rowsBefore=await list.locator('.work-file').count();
    await page.route(snapshot,route=>route.fulfill({status:503,json:{error:'fixture only'}}));
    const failedRefresh=page.waitForResponse(response=>snapshot(new URL(response.url()))&&response.status()===503);
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));await failedRefresh;
    await overlay.getByText('Se muestran los últimos datos disponibles.').waitFor();
    check('503 keeps the last rows and keyboard focus on the exact file',await list.locator('.work-file').count()===rowsBefore&&await page.evaluate(label=>document.activeElement?.matches('.work-card-main')&&document.activeElement.getAttribute('aria-label')===label,focusLabel));
    await page.unroute(snapshot);
    await page.route(snapshot,async route=>{
      const response=await route.fetch(),data=await response.json();
      data.deliveries.unshift({...data.deliveries[0],file:{...data.deliveries[0].file,id:'fixture-new-row',title:'Nueva fila de la prueba.txt'}});
      await route.fulfill({response,json:data});
    });
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await overlay.getByText('Nueva fila de la prueba.txt',{exact:true}).waitFor();
    check('a changed snapshot retains exact focus and clears the stale warning',await page.evaluate(label=>document.activeElement?.matches('.work-card-main')&&document.activeElement.getAttribute('aria-label')===label,focusLabel)&&!(await overlay.locator('#work-status').innerText()).includes('últimos datos disponibles'));
    await page.unroute(snapshot);
    await page.route(snapshot,route=>route.fulfill({status:403,json:{error:'fixture only'}}));
    const denied=page.waitForResponse(response=>snapshot(new URL(response.url()))&&response.status()===403);
    await press('#work-refresh');await denied;
    await overlay.getByText('Ya no tienes acceso a Mi trabajo.').waitFor();
    check('403 removes stale rows and every file action',await list.locator('.work-file').count()===0&&await list.locator('button,a').count()===0);
    await page.unroute(snapshot);
    await press('#work-refresh');await until(async()=>await list.locator('.work-file').count()>0,'files restored',8000);
    if(touch){
      await page.setViewportSize({width:320,height:620});
      await page.waitForFunction(()=>innerWidth===320&&innerHeight===620);
      await search.fill('acta comision seguimiento');await search.blur();
      await until(async()=>await list.locator('.work-file').count()===3,'320 filter',7000);
      check('320 px keeps the whole file list inside the viewport',await page.evaluate(()=>document.documentElement.scrollWidth===320&&innerWidth===320));
      check('the global agent selector is visible and touch-sized on a small screen',await agentPicker.evaluate(e=>{
        const r=e.getBoundingClientRect();return r.height>=44&&r.left>=0&&r.right<=innerWidth&&e===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      }));
      if(keep)await page.screenshot({path:path.join(directory,'work-320-files.png')});
      await openReader(similar[0]);
      await until(async()=>await reader.locator('canvas').count()>0,'320 PDF canvas',16000);
      const fit=await reader.evaluate(root=>{
        const box=root.getBoundingClientRect(),controls=[...root.querySelectorAll('button,a')].filter(node=>node.offsetParent!==null).map(node=>{const r=node.getBoundingClientRect();return{w:r.width,h:r.height,right:r.right,bottom:r.bottom};});
        return{left:box.left,right:box.right,width:box.width,doc:document.documentElement.scrollWidth,inner:innerWidth,small:controls.filter(item=>item.w<44||item.h<44).length,offscreen:controls.filter(item=>item.right>innerWidth+1||item.bottom>innerHeight+1).length};
      });
      check('320 x 620 reader has no horizontal overflow, offscreen controls or targets under 44 px',fit.left>=0&&fit.right<=320&&fit.doc===320&&fit.inner===320&&fit.small===0&&fit.offscreen===0);
      if(keep)await page.screenshot({path:path.join(directory,'work-320-reader.png')});
      const smallMark=artifactReads.length;
      await tap('#work-reader-next');await until(async()=>await readerTitle()===similar[1],'320 second title');
      await until(async()=>artifactReads.length>smallMark,'320 second read');
      check('the same frozen traversal works at 320 px',/^2\s+de\s+3\b/u.test(await position())&&artifactReads.slice(smallMark).every(id=>id===idFor(similar[1])));
      await tap('#work-reader-back');await overview.waitFor();
    }
    await search.fill('');await search.blur();
    if(linux||pc)await page.keyboard.press('Escape');else await page.evaluate(()=>history.back());
    await overlay.waitFor({state:'hidden'});
    check('from Archivos, Back or Escape returns to the chat and restores opener focus',await workMenu.evaluate(element=>document.activeElement===element));
    await page.evaluate(()=>selectAgent('primary-demo','agent:main:dashboard:documents-demo'));
    check('returning to Primary restores the untouched draft and composer',await page.locator('#input').inputValue()===draft&&await page.locator('#input').getAttribute('placeholder')==='Escribe…');
    check('all reader work stayed on loopback with no chat/document mutation or renderer exception',errors.length===0&&outside.length===0&&altered.every(value=>/POST:\/api\/(?:fixture-work|work-inbox\/track|session-read)$/u.test(value))&&await overlay.isHidden());
    console.log('RESULT '+checks+' PASS · Mi trabajo Archivos · '+(linux?'Electron instalado':pc?'Chrome PC':appMode?'Chrome modo independiente táctil':'Chromium táctil')+' · 390x760 y 320x620');
    return;
  }
  const dialog=page.locator('#hub-artifact-viewer');
  const byFile=(type,name)=>page.getByRole('button',{name:'Ver '+type+': '+name,exact:true});
  check('chat pays no cost for unused PDF or Excel modules',await page.evaluate(()=>!performance.getEntriesByType('resource').some(e=>/artifact-viewer|artifact-workbook|pdfjs-/.test(e.name))));
  const draft='Este borrador del chat debe quedar intacto.';
  await page.locator('#input').fill(draft);await page.locator('#input').blur();
  if(!await page.locator('#hub-artifacts').evaluate(e=>e.open))await press('#hub-artifacts > summary');
  const controlsFit=()=>dialog.evaluate(d=>[...d.querySelectorAll('.av-header .av-control')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.right<=innerWidth&&r.bottom<=visualViewport.height+visualViewport.offsetTop+1&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
  async function download(name){
    const link=dialog.getByRole('link',{name:'Descargar el original'});
    if(linux){await press(link);const output=path.join(directory,'native',name);const bytes=await until(()=>fs.readFile(output),'native file was not downloaded',6500);return bytes;}
    const evt=page.waitForEvent('download');await press(link);const dl=await evt;assert.equal(dl.suggestedFilename(),name);return fs.readFile(await dl.path());
  }
  if(wordOnly){
    const initial='Acuerdo estructurado.docx', complex='Acuerdo complejo.docx';
    const action=name=>page.getByRole('button',{name:'Abrir en Documentos: '+name,exact:true});
    const scope='?'+new URLSearchParams({agent:'primary-demo',key:'agent:main:dashboard:documents-demo',sessionId:'documents-demo-v1'});
    const getDocuments=()=>page.evaluate(q=>fetch('/api/documents'+q).then(r=>r.json()).then(j=>j.documents),scope);
    const phone=!linux&&!pc;
    if(phone){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});}
    const closed=()=>page.locator('#hub-documents').waitFor({state:'hidden',timeout:1500});
    const trigger=page.locator('#hub-documents-trigger');
    const lossGuard=()=>page.evaluate(()=>!dispatchEvent(new Event('beforeunload',{cancelable:true})));
    const cancel=page.getByRole('button',{name:'Cancelar',exact:true}), back=page.getByRole('button',{name:'Volver al chat',exact:true});
    const confirm=page.getByRole('dialog',{name:'¿Descartar este borrador?'});
    await press(action(initial));
    const table=page.getByRole('table',{name:'Tabla 1',exact:true});await table.waitFor();
    const field=(row,col)=>table.getByRole('textbox',{name:'Tabla 1, fila '+row+', columna '+col,exact:true});
    const save=page.getByRole('button',{name:'Guardar copia',exact:true});
    check('the first save says Guardar copia and a distinct Cancelar and Volver al chat remain within reach',await save.isVisible()&&await page.evaluate(()=>{
      return ['.hd-back','.hd-cancel-draft','#hd-save'].every(s=>{
        const e=document.querySelector(s), r=e.getBoundingClientRect();
        return r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&e===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      });
    }));
    const originalCount=(await getDocuments()).length;
    await press(cancel);await closed();
    check('cancelling an untouched import returns to the original attachment with no write',await action(initial).evaluate(e=>e===document.activeElement)&&!await lossGuard()&&(await getDocuments()).length===originalCount&&altered.length===0);
    await press(trigger);await page.locator('.hd-doc-card').first().waitFor();await press('#hd-new-document');
    check('a blank document has a separate first-save label',await page.getByRole('button',{name:'Guardar documento',exact:true}).isVisible());
    await press(cancel);await page.locator('#hd-new-document').waitFor();
    check('cancelling a new blank document returns to its list and keeps existing records',await page.locator('#hd-new-document').evaluate(e=>e===document.activeElement)&&!await lossGuard()&&(await getDocuments()).length===originalCount&&altered.length===0);
    await press(back);await closed();await press(action(initial));await table.waitFor();
    await field(2,1).fill('Cambio que quiero descartar');await press(cancel);await confirm.waitFor();
    check('cancelling an edited copy asks first and focuses the non-destructive choice',await confirm.getByRole('button',{name:'Seguir editando'}).evaluate(e=>e===document.activeElement)&&await lossGuard());
    if(keep)await page.screenshot({path:path.join(directory,'word-confirm-discard.png')});
    await page.keyboard.press('Escape');await confirm.waitFor({state:'hidden'});
    check('Escape cancels only the confirmation and preserves all text',await field(2,1).inputValue()==='Cambio que quiero descartar'&&await cancel.evaluate(e=>e===document.activeElement));
    await press(cancel);await press(confirm.getByRole('button',{name:'Descartar borrador'}));await closed();
    check('discard affects the local copy only and restores the attachment focus',await action(initial).evaluate(e=>e===document.activeElement)&&!await lossGuard()&&(await getDocuments()).length===originalCount&&altered.length===0);
    await press(action(initial));await table.waitFor();
    check('Word imports table cells, header, footer and native page number before any write',await field(2,1).inputValue()==='Pago de ejemplo'&&
      await page.getByRole('textbox',{name:'Encabezado',exact:true}).inputValue()==='Cabecera de prueba'&&
      await page.getByRole('textbox',{name:'Pie de página',exact:true}).inputValue()==='Pie de prueba\t'&&
      await page.getByRole('checkbox',{name:'Número de página automático'}).isChecked()&&altered.length===0);
    if(phone){
      const bounds=await page.evaluate(()=>({width:innerWidth,app:document.documentElement.scrollWidth,table:document.querySelector('.hd-table-scroll').clientWidth,scroller:document.querySelector('.hd-table-scroll').scrollWidth}));
      check('only the wide table scrolls; the 320 px app stays within the viewport',bounds.width===320&&bounds.app===320&&bounds.scroller>bounds.table);
    }
    if(keep)await page.screenshot({path:path.join(directory,linux?'word-linux.png':pc?'word-pc.png':'word-mobile.png')});
    await field(2,1).fill('Pago modificado solamente en la copia');
    await page.getByRole('textbox',{name:'Pie de página',exact:true}).fill('Pie editado');
    await press('.hd-table-add-row');await press('.hd-table-add-column');
    await field(4,4).fill('Celda nueva');
    // The header is fixed; returning from deep inside the document must not rewind it.
    const position=()=>page.locator('.hd-scroll').evaluate(e=>e.scrollTop);
    const scrollBefore=await position();
    await press('.hd-back');await closed();
    check('one Back click leaves an unsaved Word copy and never creates it',await page.locator('#input').inputValue()===draft&&altered.length===0&&!(await getDocuments()).some(d=>d.title==='Acuerdo estructurado')&&await lossGuard());
    await page.locator('#toast').filter({hasText:'Borrador conservado en esta pestaña.'}).waitFor();
    await press(trigger);await table.waitFor();
    check('reopening resumes the exact cell edits, footer, and vertical scroll position',await field(4,4).inputValue()==='Celda nueva'&&await field(2,1).inputValue()==='Pago modificado solamente en la copia'&&await page.getByRole('textbox',{name:'Pie de página',exact:true}).inputValue()==='Pie editado'&&Math.abs((await position())-scrollBefore)<=1);
    // A scope change in this tab parks the copy in the same account and it still needs a leave-page guard.
    await press('.hd-back');await closed();
    await page.evaluate(()=>syncDocuments(true));
    assert.equal(await trigger.isVisible(),false);assert.equal(await lossGuard(),true);
    await page.evaluate(()=>syncDocuments());await press(trigger);await table.waitFor();
    check('a parked draft remains protected in another view and resumes in its original scope',await field(4,4).inputValue()==='Celda nueva'&&altered.length===0);
    const creating=url=>url.pathname==='/api/documents';let sendCreate, requested=false;
    const pendingCreate=new Promise(resolve=>sendCreate=resolve);
    const holdCreate=async route=>{
      if(route.request().method()!=='POST')return route.continue();
      requested=true;await pendingCreate;await route.continue();
    };
    await page.route(creating,holdCreate);
    try{
      await press(save);await until(()=>requested,'explicit creation is in flight');
      check('a pending save is not offered as cancellable, but Chat remains available',await cancel.isDisabled()&&await save.isDisabled()&&await back.isEnabled());
      await press(back);await closed();await press(trigger);await table.waitFor();
      sendCreate();await page.locator('.hd-status').filter({hasText:'v1 · Guardado'}).waitFor();
      check('after the server confirms the save, only return remains, not discard',await cancel.isHidden()&&await back.isVisible());
    }finally{sendCreate();await page.unroute(creating,holdCreate);}
    check('table rows and columns, cell edit and footer survive the first save',altered.filter(m=>m.startsWith('POST:')).length===1&&await field(4,4).inputValue()==='Celda nueva'&&await page.getByRole('textbox',{name:'Pie de página',exact:true}).inputValue()==='Pie editado');
    const docs=await getDocuments(), doc=docs.find(d=>d.title==='Acuerdo estructurado');assert.ok(doc);
    const pathToDoc='/api/documents/'+doc.id+scope;
    const response=await page.evaluate(async url=>{
      const old=await fetch(url),current=await fetch(url,{headers:{'X-Hub-Document-Schema':'2'}});
      const data=await current.json();return {old:old.status,current:current.status,cell:data.document?.blocks.find(b=>b.kind==='table')?.rows[3]?.cells[3]?.text};
    },pathToDoc);
    assert.deepEqual(response,{old:409,current:200,cell:'Celda nueva'});
    check('older client reload required; newer client reads the full stored structure',true);
    let resume, held=false;
    const pending=new Promise(resolve=>resume=resolve), match=url=>url.pathname==='/api/documents/'+doc.id;
    const pauseSave=async route=>{
      if(route.request().method()!=='PUT')return route.continue();
      held=true;await pending;
      await route.fulfill({status:503,json:{error:'No se pudo guardar (prueba).'}});
    };
    await page.route(match,pauseSave);
    try {
      await field(2,1).fill('Cambio local con red no disponible');
      await press('.hd-back');await closed();
      await until(()=>held,'background save is waiting');
      check('Back is immediate while a saved document update awaits its response',await page.locator('#hub-documents').isHidden()&&await lossGuard());
      const received=page.waitForResponse(res=>match(new URL(res.url()))&&res.request().method()==='PUT');
      resume();await received;
      await press(trigger);await page.locator('.hd-notice').filter({hasText:'No se pudo guardar (prueba).'}).waitFor();
      check('a failed save leaves the local text editable without marking it saved',await field(2,1).inputValue()==='Cambio local con red no disponible'&&await page.locator('.hd-status').filter({hasText:'Cambios sin confirmar'}).isVisible());
    } finally {resume();await page.unroute(match,pauseSave);}
    await press('#hd-save');await page.locator('.hd-status').filter({hasText:'v2 · Guardado'}).waitFor();
    check('explicit save finishes the change and clean Back needs no leave-page guard',!await lossGuard());
    if(linux){
      let allow, bound=false, finished;
      const deferred=new Promise(resolve=>allow=resolve), settled=new Promise(resolve=>finished=resolve);
      const late=url=>url.pathname==='/api/artifact-download'&&url.searchParams.get('id')==='fixture-word-complex';
      const waitImport=async route=>{bound=true;await deferred;try{const res=await route.fetch();await route.fulfill({response:res});}finally{finished();}};
      await page.route(late,waitImport);
      try{
        await press(action(complex));await until(()=>bound,'background read is waiting');
        await press('.hd-back');await closed();allow();await settled;
        await until(()=>action(complex).isEnabled(),'late click completed');
        check('a delayed Word read never reopens a view after Back',await page.locator('#hub-documents').isHidden()&&await dialog.count()===0);
      }finally{allow();await page.unroute(late,waitImport);}
    }else {await press('.hd-back');await closed();}
    if(!await page.locator('#hub-artifacts').evaluate(e=>e.open))await press('#hub-artifacts > summary');
    await press(action(complex));await dialog.getByRole('heading',{name:complex}).waitFor();
    check('Word with an unsupported nested layout is readable but never opened as a lossy draft',await dialog.getByText('Detalle de tabla anidada').isVisible()&&
      (await dialog.locator('footer p').textContent()).startsWith('Pie de prueba')&&await dialog.locator('textarea,[contenteditable]').count()===0&&await page.locator('#hub-documents').isHidden());
    check('original DOCX downloads byte for byte in the fallback', (await download(complex)).equals(await fs.readFile(path.join(directory,complex))));
    await press(dialog.getByRole('button',{name:'Cerrar vista previa'}));
    check('the chat and its draft are untouched',await page.locator('#input').inputValue()===draft&&page.url()===origin+'/'&&errors.length===0&&outside.length===0);
    console.log('RESULT '+checks+' PASS · Word structure and draft exit · '+(linux?'Electron Linux':pc?'Chrome PC':appMode?'Chrome táctil independiente':'Chromium tactile emulation'));return;
  }
  if(!pdfOnly){
  await press(byFile('Excel',filenames.xlsx));
  await dialog.getByRole('table',{name:'Resumen'}).waitFor();
  const grid=dialog.locator('.av-grid');
  const values=await grid.locator('tbody tr:nth-child(2) td').allTextContents();
  check('Excel displays shared/inline text, the cached formula and percentage/date format',
    values[0]==='Cuota <prevista> & revisión'&&/^234[.,]5$/.test(values[1])&&/25[.,]30?\s*%$/.test(values[2])&&/\d[\s/.-]+\d/.test(values[3])&&await grid.getByText('Total',{exact:true}).count()===1);
  check('visible Excel sheets only; no editor or active document links',await dialog.locator('select option').allTextContents().then(a=>a.join('|')==='Resumen|Detalles|Vacía')&&await dialog.locator('input,textarea,[contenteditable],.av-grid a').count()===0);
  check('preview controls have 44 px hit targets and are reachable',await controlsFit());
  if(keep)await page.screenshot({path:path.join(directory,linux?'excel-linux.png':'excel-mobile.png')});
  const pick=dialog.getByRole('combobox',{name:'Hoja de Excel'});
  await pick.selectOption({label:'Detalles'});await grid.getByText('Hoja 2: financiación',{exact:true}).waitFor();
  check('sheet limits are disclosed rather than pretending the partial view is the original',await dialog.getByText(/Vista parcial/).isVisible()&&await grid.getByText('Fuera de la vista',{exact:true}).count()===0);
  await press(dialog.getByRole('button',{name:'Bloque de columnas siguiente'}));await grid.getByText('Columna 34',{exact:true}).waitFor();
  await press(dialog.getByRole('button',{name:'Bloque de columnas anterior'}));
  await press(dialog.getByRole('button',{name:'Bloque de filas siguiente'}));await grid.getByText('Fila 61',{exact:true}).waitFor();
  check('row and column blocks navigate without changing the source',true);
  await pick.selectOption({label:'Vacía'});await dialog.getByText('Esta hoja no tiene celdas con contenido.').waitFor();
  check('empty sheet is explicit; PDF engine is not loaded for Excel',!(await grid.count())&&await page.evaluate(()=>!performance.getEntriesByType('resource').some(e=>/pdfjs-/.test(e.name))));
  check('Excel download returns identical original bytes', (await download(filenames.xlsx)).equals(await fs.readFile(path.join(directory,filenames.xlsx))));
  await dialog.getByRole('button',{name:'Cerrar vista previa'}).press('Escape');await dialog.waitFor({state:'detached'});
  check('Escape returns focus to the original Excel action',await byFile('Excel',filenames.xlsx).evaluate(e=>document.activeElement===e));
  }
  await press(byFile('PDF',filenames.pdf));
  const canvas=dialog.locator('canvas');
  await dialog.getByRole('img',{name:'Página 1 de 2'}).waitFor({timeout:14000});
  const pixel=()=>canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(Math.round(c.width/2),Math.round(c.height*.2),1,1).data));
  let rgb=await pixel();check('PDF page 1 is actually rendered, not just a placeholder',rgb[0]>190&&rgb[1]<90&&rgb[2]<110&&rgb[3]===255);
  await press(dialog.getByRole('button',{name:'Página siguiente'}));await dialog.getByRole('img',{name:'Página 2 de 2'}).waitFor();
  rgb=await pixel();check('page navigation draws the correct second page',rgb[1]>140&&rgb[0]<70&&rgb[3]===255);
  const width=await canvas.evaluate(c=>c.clientWidth);await press(dialog.getByRole('button',{name:'Ampliar zoom'}));
  await page.waitForFunction(w=>document.querySelector('#hub-artifact-viewer canvas')?.clientWidth>w,width);
  check('PDF zoom changes the canvas and leaves a reachable Download and Close',await controlsFit());
  if(!linux){
    const cdp=await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:820,height:360,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});
    await page.waitForFunction(()=>innerWidth===820&&document.querySelector('#hub-artifact-viewer').clientHeight===360);
    check('landscape mobile keeps a readable scroll area',await controlsFit()&&await dialog.locator('.av-scroll').evaluate(e=>e.clientHeight>=210));
  }
  if(keep)await page.screenshot({path:path.join(directory,linux?'pdf-linux.png':'pdf-landscape.png')});
  check('PDF download returns identical original bytes',(await download(filenames.pdf)).equals(await fs.readFile(path.join(directory,filenames.pdf))));
  await page.evaluate(()=>syncDocuments(true));await dialog.waitFor({state:'detached'});
  check('changing the authorized context closes the viewer and removes its actions',await page.locator('.ha-artifact-preview').count()===0);
  await page.evaluate(()=>syncDocuments());
  await press(byFile('PDF',filenames.bad));await dialog.getByText(/No se pudo mostrar este PDF/).waitFor();
  check('unreadable PDF preserves Download without replacing the chat',await dialog.getByRole('link',{name:'Descargar el original'}).isVisible()&&await canvas.count()===0);
  await press(dialog.getByRole('button',{name:'Cerrar vista previa'}));
  check('no posted mutation, navigation or lost draft',await page.locator('#input').inputValue()===draft&&altered.length===0&&page.url()===origin+'/');
  check('no renderer exceptions and no external requests',errors.length===0&&outside.length===0);
  console.log('RESULT '+checks+' PASS · '+(linux?'Electron Linux installed':'Chromium mobile viewport')+' · loopback fixtures');
})().catch(async(error)=>{
  console.error(error.stack);if(page)try{console.error(await page.locator('#hub-artifact-viewer').innerText({timeout:350}));}catch{}
  console.error('Renderer',errors,'logs',log.slice(-12));process.exitCode=1;
}).finally(async()=>{
  await browser?.close().catch(()=>{});await stop(desktop);await stop(service);
  if(directory){if(keep)console.log('Evidence: '+directory);else await fs.rm(directory,{recursive:true,force:true});}
});
